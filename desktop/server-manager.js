const { app } = require('electron');
const { fork, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
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

// ---------------------------------------------------------------------------
// 进程与端口
//
// 这一整段是为了修「服务启动后立刻退出 / EADDRINUSE: 0.0.0.0:8443」。
//
// 成因不是端口配置错了，而是**上一次的服务端进程没被杀干净**：
//   1. 服务端是 fork 出去的独立进程，execPath 是 InsideMeeting.exe。
//      Windows 上父进程被强杀（任务管理器、崩溃、托盘异常导致的异常退出）时，
//      子进程不会跟着死，它继续占着 8443。
//   2. 原来的 stopServer() 先把 `child = null` 再 kill。一旦 kill 失败，
//      这个 pid 就永远丢了，谁也没法再找到它 —— 端口被占死到重启为止。
//   3. child.kill() 在 Windows 上不会连带杀掉孙进程（ffmpeg）。
//
// 所以这里做三件事：把 pid 落盘、杀进程树、启动前预检端口。
// ---------------------------------------------------------------------------

function pidFile() {
  return path.join(dataDir(), 'server.pid');
}

function readPid() {
  try {
    const n = Number(String(fs.readFileSync(pidFile(), 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writePid(pid) {
  try {
    fs.writeFileSync(pidFile(), String(pid));
  } catch { /* 记不上也不影响主流程 */ }
}

function clearPid() {
  try {
    fs.rmSync(pidFile(), { force: true });
  } catch { /* noop */ }
}

/** 进程还在不在。EPERM 说明进程存在但没权限，也算活着。 */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 连同子孙进程一起杀。Windows 用 taskkill /T，其它平台先 TERM 再 KILL。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid || !alive(pid)) return resolve(true);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve(!alive(pid)));
      return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已经退了 */ }
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ }
      resolve(!alive(pid));
    }, 1500);
  });
}

/** 端口上有没有人在听。自己先试着 listen 一下最准，不依赖外部命令。 */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    try {
      s.listen(port, '0.0.0.0');
    } catch {
      resolve(true);
    }
  });
}

/** 谁占着这个端口。拿不到就返回空数组，只用于把错误说清楚。 */
function whoHoldsPort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', `netstat -ano -p TCP | findstr LISTENING | findstr :${port}`], (e, out) => {
        const pids = String(out || '')
          .split(/\r?\n/)
          .map((l) => l.trim().split(/\s+/).pop())
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 4);
        resolve([...new Set(pids)]);
      });
      return;
    }
    execFile('lsof', ['-ti', `tcp:${port}`], (e, out) => {
      const pids = String(out || '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      resolve([...new Set(pids)]);
    });
  });
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

/**
 * 启动前把端口清出来。
 * @returns {null | object} null 表示端口是干净的，可以正常 fork
 */
async function clearPort(port) {
  if (!(await portBusy(port))) return null;

  const health = `https://127.0.0.1:${port}/api/health`;

  // 1) 先看是不是我们自己上次没退干净的那个进程
  const mine = readPid();
  if (mine && alive(mine)) {
    await killTree(mine);
    clearPid();
    await new Promise((r) => setTimeout(r, 800));
    if (!(await portBusy(port))) return null;
  }

  // 2) 还占着。如果它能应答健康检查，说明端口上跑的就是一份 InsideMeeting
  //    （比如你同时用源码方式 npm start 起过一个），那就直接复用，别再 fork 一个上去
  if (await ping(health)) {
    return {
      ok: true,
      external: true,
      port,
      url: shareUrl(port),
      local: `https://localhost:${port}`,
      note: `端口 ${port} 上已经有一个 InsideMeeting 服务在运行，已直接复用它。\n注意：这个进程不是本 App 启动的，"停止服务"管不到它。`,
    };
  }

  // 3) 被别的程序占着，如实报出来
  const pids = await whoHoldsPort(port);
  const cmd =
    process.platform === 'win32'
      ? `netstat -ano | findstr :${port}\ntaskkill /PID <上面那个PID> /T /F`
      : `lsof -i :${port}\nkill -9 <上面那个PID>`;
  return {
    ok: false,
    error: `端口 ${port} 已被占用，服务无法启动。`,
    detail:
      (pids.length ? `占用它的进程号：${pids.join(', ')}\n\n` : '') +
      '常见原因：\n' +
      '· 上一次的服务端进程没退干净（强制关闭 App、崩溃、任务管理器结束进程都会这样）\n' +
      '· 你同时用源码方式（npm start）也起了一份服务\n' +
      '· 别的软件占用了这个端口\n\n' +
      '手动清理：\n' +
      cmd +
      '\n\n也可以在设置里把端口换成 8444 之类的空闲端口。',
    logFile: logFile(),
    port,
    pids,
  };
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
    // 端口预检。原来是直接 fork 上去，服务端 listen 撞上 EADDRINUSE 之后
    // 以未捕获的 'error' 事件崩掉，App 这边只能看到「服务启动后立刻退出」，
    // 真正的原因埋在日志里。
    const pre = await clearPort(port);
    if (pre) {
      starting = false;
      if (pre.ok) emit({ type: 'started', port });
      return pre;
    }

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
      // 这里原来有一行 `NETWORK_MODE: process.env.NETWORK_MODE || 'tailscale'`。
      // 它把变量显式塞进了子进程环境，而 dotenv 默认**不覆盖已存在的环境变量** ——
      // 结果是 .env 里写的 NETWORK_MODE 永远不生效，只能改代码或者改系统环境变量。
      // 去掉之后交给 config.js 自己处理：它的默认值同样是 'tailscale'，
      // 行为不变，但 .env 终于能管用了。
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

    // pid 落盘。App 被强杀时子进程会活下来，靠这个文件下次启动才认得出它是自己人。
    writePid(child.pid);

    child.on('exit', (code, signal) => {
      child = null;
      starting = false;
      clearPid();
      emit({ type: 'stopped', code, signal });
    });
    child.on('error', (e) => {
      child = null;
      starting = false;
      clearPid();
      emit({ type: 'error', error: e.message });
    });

    // 轮询健康检查，确认真起来了再报成功
    const url = `https://127.0.0.1:${port}/api/health`;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!child) {
        // 直接把日志尾部带回去。只说「请查看日志」等于把排查甩给用户，
        // 而这里明明拿得到原因。
        const detail = lastError();
        if (/EADDRINUSE/i.test(detail)) {
          return {
            ok: false,
            error: `端口 ${port} 已被占用，服务无法启动。`,
            detail:
              '预检时端口还是空的，说明是在启动过程中被别的程序抢走了。\n' +
              '稍等几秒重试一次，或换一个端口。\n\n' + detail,
            logFile: logFile(),
          };
        }
        return { ok: false, error: '服务启动后立刻退出。', detail, logFile: logFile() };
      }
      if (await ping(url)) {
        starting = false;
        emit({ type: 'started', port });
        return { ok: true, port, url: shareUrl(port), local: `https://localhost:${port}` };
      }
    }
    starting = false;
    return {
      ok: false,
      error: '服务启动超时（20 秒没有响应）。',
      detail: lastError(),
      logFile: logFile(),
    };
  } catch (e) {
    starting = false;
    child = null;
    return { ok: false, error: e.message };
  }
}

function stopServer() {
  const p = child;

  if (!p) {
    // 没有在管的子进程，但可能有上次留下的孤儿还占着端口，一并清掉
    const orphan = readPid();
    if (orphan && alive(orphan)) {
      killTree(orphan).then(() => clearPid());
      emit({ type: 'stopped' });
      return { ok: true, orphan: true };
    }
    clearPid();
    return { ok: true, already: true };
  }

  const pid = p.pid;
  child = null;
  try {
    p.kill();
  } catch { /* 已经退了 */ }

  // 关键：不能像原来那样「先把 child 置空、再 kill 一下就不管了」。
  // kill 失败时 pid 就丢了，那个进程会一直占着 8443；
  // Windows 上 child.kill() 也不会连带杀掉 ffmpeg 这类孙进程。
  killTree(pid).then(() => clearPid());

  emit({ type: 'stopped' });
  return { ok: true };
}

/**
 * 从日志尾部挑出最像「真正原因」的几行。
 * 优先找 Error / 异常栈，找不到就退回最后几行非空内容。
 */
function lastError() {
  try {
    const lines = readLog(32 * 1024).split('\n').filter((l) => l.trim());
    const idx = lines.findIndex(
      (l, i) => i > lines.length - 40 && /Error|error:|Exception|Cannot|not defined|EADDRINUSE|SyntaxError/i.test(l)
    );
    const picked = idx >= 0 ? lines.slice(idx, idx + 8) : lines.slice(-8);
    return picked.join('\n').slice(0, 1200);
  } catch {
    return '';
  }
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
  lastError,
  dataDir,
  logFile,
  lanAddress,
  // 给上层排查用
  portBusy,
  whoHoldsPort,
  killTree,
};
