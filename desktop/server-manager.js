const { app } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { ensureCert } = require('./cert.js');

/**
 * 内嵌服务端的启停。
 *
 * 关键技巧是 ELECTRON_RUN_AS_NODE=1：设了这个环境变量后，
 * Electron 的可执行文件会当成纯 Node 来跑。也就是说
 * **用户机器上不需要装 Node.js**，App 自带的那份就够了。
 * ffmpeg 同理，用 ffmpeg-static 打包进来。
 *
 * 服务端代码本身一行没改 —— 它只是被 fork 起来的一个普通 Node 进程，
 * 所有差异都通过环境变量传进去。这样「从源码部署」和「装 App」
 * 两种方式跑的是完全相同的服务端，不会出现只在某一种下才有的 bug。
 */

let child = null;
let starting = false;
const listeners = new Set();

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch { /* 单个监听器出错不影响其它 */ }
  }
}

/** 服务端入口。打包后在 resources/app/bundled 里，开发时在上级目录。 */
function serverEntry() {
  const packed = path.join(process.resourcesPath || '', 'app', 'bundled', 'server', 'src', 'index.js');
  if (packed && fs.existsSync(packed)) return packed;
  const local = path.join(__dirname, 'bundled', 'server', 'src', 'index.js');
  if (fs.existsSync(local)) return local;
  const dev = path.resolve(__dirname, '..', 'server', 'src', 'index.js');
  return fs.existsSync(dev) ? dev : null;
}

/** 内置的 ffmpeg / ffprobe 路径 */
function binaryPath(mod) {
  try {
    let p = require(mod);
    if (p && typeof p === 'object' && p.path) p = p.path;
    if (!p) return null;
    // 打包后路径可能指向 asar 内部，换成解包后的真实路径
    const unpacked = String(p).replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function dataDir() {
  const d = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function logFile() {
  return path.join(dataDir(), 'server.log');
}

/** 优先返回 Tailscale 的 100.x 地址，其次任意内网地址 */
function lanAddress() {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) all.push(i.address);
    }
  }
  return all.find((a) => a.startsWith('100.')) || all[0] || '127.0.0.1';
}

function shareUrl(port = 8443) {
  return `https://${lanAddress()}:${port}`;
}

function serverState() {
  return {
    running: Boolean(child),
    starting,
    dataDir: dataDir(),
    logFile: logFile(),
    entry: serverEntry(),
    ffmpeg: binaryPath('ffmpeg-static'),
    lan: lanAddress(),
  };
}

function onServerEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function ping(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startServer({ port = 8443 } = {}) {
  if (child || starting) return { ok: true, already: true };

  const entry = serverEntry();
  if (!entry) {
    return { ok: false, error: '找不到服务端代码。打包版本请重新安装；开发环境请确认项目结构完整。' };
  }

  starting = true;
  emit({ type: 'starting' });

  try {
    const dir = dataDir();
    const certs = await ensureCert(path.join(app.getPath('userData'), 'certs'));
    const ffmpeg = binaryPath('ffmpeg-static');
    const ffprobe = binaryPath('ffprobe-static');

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '0.0.0.0',
      DATA_DIR: dir,
      TLS_ENABLED: 'true',
      TLS_CERT: certs.certPath,
      TLS_KEY: certs.keyPath,
      NETWORK_MODE: process.env.NETWORK_MODE || 'tailscale',
    };
    if (ffmpeg) env.FFMPEG_PATH = ffmpeg;
    if (ffprobe) env.FFPROBE_PATH = ffprobe;

    const out = fs.openSync(logFile(), 'a');
    fs.writeSync(out, `\n===== ${new Date().toLocaleString('zh-CN')} 启动服务 =====\n`);

    child = fork(entry, [], {
      env,
      // cwd 设成「项目根」的层级，和源码部署时保持一致
      cwd: path.resolve(path.dirname(entry), '..', '..'),
      stdio: ['ignore', out, out, 'ipc'],
      execPath: process.execPath,
    });

    child.on('exit', (code, signal) => {
      child = null;
      starting = false;
      emit({ type: 'stopped', code, signal });
    });
    child.on('error', (e) => {
      child = null;
      starting = false;
      emit({ type: 'error', error: e.message });
    });

    // 轮询健康检查，确认真起来了再报成功
    const url = `https://127.0.0.1:${port}/api/health`;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!child) return { ok: false, error: '服务启动后立刻退出，请查看日志。' };
      if (await ping(url)) {
        starting = false;
        emit({ type: 'started', port });
        return { ok: true, port, url: shareUrl(port), local: `https://localhost:${port}` };
      }
    }
    starting = false;
    return { ok: false, error: '服务启动超时（20 秒）。日志里应该有原因。' };
  } catch (e) {
    starting = false;
    child = null;
    return { ok: false, error: e.message };
  }
}

function stopServer() {
  if (!child) return { ok: true, already: true };
  const p = child;
  child = null;
  try {
    p.kill('SIGTERM');
    setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch { /* 已经退了 */ }
    }, 4000);
  } catch { /* noop */ }
  emit({ type: 'stopped' });
  return { ok: true };
}

function readLog(bytes = 200 * 1024) {
  const f = logFile();
  if (!fs.existsSync(f)) return '还没有日志。启动一次服务就会生成。';
  const size = fs.statSync(f).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

module.exports = {
  startServer,
  stopServer,
  serverState,
  onServerEvent,
  shareUrl,
  readLog,
  dataDir,
  logFile,
  lanAddress,
};
