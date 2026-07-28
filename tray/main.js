const { app, Tray, Menu, nativeImage, shell, dialog, clipboard, BrowserWindow, Notification } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

/**
 * InsideMeeting 服务端的菜单栏控制器。
 *
 * 服务本身还是那个 node 进程，这里只是把「开终端敲命令」换成点菜单：
 * 启停、看状态、复制入会地址、开机自启、看日志。
 *
 * 刻意没有把服务重写进 Electron —— 服务能独立跑是好事，
 * 用 launchd 跑、用终端跑、用这个 App 跑，三种方式随时可以换。
 */

const CONFIG_FILE = path.join(app.getPath('userData'), 'tray-config.json');

let tray = null;
let child = null;
let status = { running: false, health: null, rooms: [], lastError: '' };
let pollTimer = null;
let logWindow = null;

// ---------------- 配置 ----------------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** 猜项目根目录：打包后在 app 外面，开发时在上一级 */
function guessProjectDir() {
  const saved = readConfig().projectDir;
  if (saved && fs.existsSync(path.join(saved, 'server', 'src', 'index.js'))) return saved;

  const guesses = [
    path.resolve(__dirname, '..'),
    path.join(os.homedir(), 'InsideMeeting'),
    path.join(os.homedir(), 'Desktop', 'InsideMeeting'),
    path.join(os.homedir(), 'Desktop', 'AgentProgram', 'InsideMeeting'),
  ];
  for (const g of guesses) {
    if (fs.existsSync(path.join(g, 'server', 'src', 'index.js'))) return g;
  }
  return null;
}

function readEnvPort(dir) {
  try {
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const port = env.match(/^PORT=(\d+)/m)?.[1];
    const tls = env.match(/^TLS_ENABLED=(\w+)/m)?.[1];
    return { port: Number(port) || 8443, tls: !/^(0|false|no|off)$/i.test(tls || 'true') };
  } catch {
    return { port: 8443, tls: true };
  }
}

function serviceUrl() {
  const dir = guessProjectDir();
  if (!dir) return null;
  const { port, tls } = readEnvPort(dir);
  const custom = readConfig().publicUrl;
  if (custom) return custom;
  return `${tls ? 'https' : 'http'}://localhost:${port}`;
}

/** 局域网/Tailscale 地址，用来发给同事 */
function shareUrl() {
  const custom = readConfig().publicUrl;
  if (custom) return custom;
  const dir = guessProjectDir();
  if (!dir) return null;
  const { port, tls } = readEnvPort(dir);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      // Tailscale 的地址在 100.64.0.0/10 段，优先用它
      if (i.family === 'IPv4' && !i.internal && i.address.startsWith('100.')) {
        return `${tls ? 'https' : 'http'}://${i.address}:${port}`;
      }
    }
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return `${tls ? 'https' : 'http'}://${i.address}:${port}`;
    }
  }
  return serviceUrl();
}

// ---------------- 服务进程 ----------------

function logFile() {
  const dir = guessProjectDir();
  return dir ? path.join(dir, 'data', 'server.log') : null;
}

function startService() {
  if (child) return;
  const dir = guessProjectDir();
  if (!dir) {
    return chooseProjectDir(true);
  }

  const lf = logFile();
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  const out = fs.openSync(lf, 'a');

  // 打包后的 App 里没有 node，用系统的。Homebrew 的路径要手动补上。
  const nodeBin = readConfig().nodePath || findNode();
  if (!nodeBin) {
    dialog.showErrorBox(
      '找不到 Node.js',
      '请先安装 Node.js（brew install node），或在菜单里手动指定 node 可执行文件的路径。'
    );
    return;
  }

  child = spawn(nodeBin, [path.join(dir, 'server', 'src', 'index.js')], {
    cwd: dir,
    stdio: ['ignore', out, out],
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
  });

  child.on('exit', (code) => {
    child = null;
    status.running = false;
    if (code && code !== 0) {
      status.lastError = `服务退出，退出码 ${code}。查看日志了解原因。`;
      notify('服务已停止', status.lastError);
    }
    refresh();
  });

  child.on('error', (e) => {
    child = null;
    status.lastError = e.message;
    refresh();
  });

  status.running = true;
  status.lastError = '';
  refresh();
  setTimeout(poll, 2500);
}

function findNode() {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function stopService() {
  if (!child) return;
  child.kill('SIGTERM');
  // 给它几秒优雅退出，赖着不走就强杀
  const p = child;
  setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch { /* 已经退了 */ }
  }, 4000);
  child = null;
  status.running = false;
  status.health = null;
  refresh();
}

// ---------------- 状态轮询 ----------------

function fetchJson(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function poll() {
  const base = serviceUrl();
  if (!base) return refresh();
  const health = await fetchJson(`${base}/api/health`);
  status.health = health;
  // 服务可能是别的方式启动的（launchd / 终端），健康检查通了就算在跑
  if (health?.ok) status.running = true;
  else if (!child) status.running = false;
  status.rooms = (await fetchJson(`${base}/api/rooms`)) || [];
  refresh();
}

// ---------------- 菜单 ----------------

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function chooseProjectDir(auto = false) {
  const r = dialog.showOpenDialogSync({
    title: '选择 InsideMeeting 项目目录',
    message: auto ? '没有自动找到项目目录，请手动指定' : '选择包含 server/src/index.js 的那个目录',
    properties: ['openDirectory'],
  });
  if (!r?.[0]) return;
  if (!fs.existsSync(path.join(r[0], 'server', 'src', 'index.js'))) {
    dialog.showErrorBox('目录不对', '这个目录里没有 server/src/index.js，请选择项目根目录。');
    return;
  }
  writeConfig({ projectDir: r[0] });
  refresh();
}

function openLogWindow() {
  const lf = logFile();
  if (!lf || !fs.existsSync(lf)) {
    return dialog.showMessageBox({ message: '还没有日志文件', detail: '启动一次服务后就会生成。' });
  }
  if (logWindow) return logWindow.focus();
  logWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: '服务日志',
    backgroundColor: '#0b0e13',
  });
  const load = () => {
    const size = fs.statSync(lf).size;
    const start = Math.max(0, size - 200 * 1024);
    const fd = fs.openSync(lf, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    logWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="margin:0;background:#0b0e13;color:#e6edf3;font:12px ui-monospace,Menlo,monospace">
             <pre id="l" style="padding:14px;white-space:pre-wrap;word-break:break-all">${text}</pre>
             <script>window.scrollTo(0,document.body.scrollHeight)</script>
           </body>`
        )
    );
  };
  load();
  const timer = setInterval(() => logWindow && !logWindow.isDestroyed() && load(), 5000);
  logWindow.on('closed', () => {
    clearInterval(timer);
    logWindow = null;
  });
}

function refresh() {
  if (!tray) return;

  const dir = guessProjectDir();
  const url = serviceUrl();
  const share = shareUrl();
  const running = status.running && status.health?.ok;
  const peers = status.rooms.reduce((a, r) => a + (r.peers?.length || 0), 0);

  const items = [];

  items.push({
    label: running ? `● 服务运行中${peers ? ` · ${peers} 人在会` : ''}` : '○ 服务未运行',
    enabled: false,
  });

  if (status.lastError) items.push({ label: `  ${status.lastError.slice(0, 60)}`, enabled: false });
  if (!dir) items.push({ label: '  未找到项目目录', enabled: false });

  items.push({ type: 'separator' });

  items.push(
    running
      ? { label: '停止服务', click: stopService }
      : { label: '启动服务', click: startService, enabled: Boolean(dir) }
  );
  items.push({
    label: '重启服务',
    enabled: running,
    click: () => {
      stopService();
      setTimeout(startService, 1500);
    },
  });

  items.push({ type: 'separator' });

  if (status.rooms.length) {
    items.push({ label: '进行中的会议', enabled: false });
    for (const r of status.rooms.slice(0, 8)) {
      const names = (r.peers || []).map((p) => p.name).join('、');
      items.push({
        label: `  ${r.roomId}　${r.peers?.length || 0} 人${names ? `（${names.slice(0, 20)}）` : ''}`,
        enabled: false,
      });
    }
    items.push({ type: 'separator' });
  }

  items.push({
    label: '复制入会地址',
    enabled: Boolean(share),
    click: () => {
      clipboard.writeText(share);
      notify('已复制', share);
    },
  });
  items.push({ label: '打开会议页面', enabled: Boolean(url), click: () => shell.openExternal(url) });
  items.push({ label: '会议记录', enabled: Boolean(url), click: () => shell.openExternal(`${url}/#/archive`) });
  items.push({ label: '管理后台', enabled: Boolean(url), click: () => shell.openExternal(`${url}/#/admin`) });

  items.push({ type: 'separator' });

  items.push({ label: '查看日志', click: openLogWindow });
  items.push({
    label: '打开数据目录',
    enabled: Boolean(dir),
    click: () => shell.openPath(path.join(dir, 'data')),
  });
  items.push({ label: '选择项目目录…', click: () => chooseProjectDir() });
  items.push({
    label: '设置对外地址…',
    click: () => {
      const win = new BrowserWindow({ width: 460, height: 200, resizable: false, title: '对外地址' });
      win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(`<body style="margin:0;padding:20px;background:#161b22;color:#e6edf3;font:13px -apple-system,'PingFang SC',sans-serif">
            <p style="margin:0 0 10px;color:#8b97a6">复制入会地址时用哪个地址？留空则自动探测（优先 Tailscale）。</p>
            <input id="u" value="${readConfig().publicUrl || ''}" placeholder="https://macmini.xxx.ts.net:8443"
              style="width:100%;box-sizing:border-box;background:#1c232d;border:1px solid #2a3341;color:#e6edf3;padding:9px;border-radius:6px" />
            <button onclick="location.href='im-save:'+encodeURIComponent(document.getElementById('u').value)"
              style="margin-top:12px;background:#3b82f6;border:0;color:#fff;padding:8px 18px;border-radius:6px;cursor:pointer">保存</button>
          </body>`)
      );
      win.webContents.on('will-navigate', (e, u) => {
        if (u.startsWith('im-save:')) {
          e.preventDefault();
          writeConfig({ publicUrl: decodeURIComponent(u.slice(8)).trim() });
          win.close();
          refresh();
        }
      });
    },
  });

  items.push({ type: 'separator' });

  items.push({
    label: '开机自动启动',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: true }),
  });
  items.push({
    label: '启动 App 时自动开服务',
    type: 'checkbox',
    checked: Boolean(readConfig().autoStart),
    click: (mi) => writeConfig({ autoStart: mi.checked }),
  });

  items.push({ type: 'separator' });
  items.push({
    label: '退出（会同时停止服务）',
    click: () => {
      stopService();
      app.quit();
    },
  });

  tray.setToolTip(running ? `InsideMeeting · ${peers} 人在会` : 'InsideMeeting · 未运行');
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------- 启动 ----------------

app.whenReady().then(() => {
  // 菜单栏应用不需要 Dock 图标
  if (process.platform === 'darwin') app.dock?.hide();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true); // 让 macOS 自动适配亮色/暗色菜单栏
  tray = new Tray(icon);

  refresh();
  poll();
  pollTimer = setInterval(poll, 5000);

  if (readConfig().autoStart) startService();
});

app.on('window-all-closed', () => {
  // 菜单栏应用：关掉日志窗口不等于退出
});

app.on('before-quit', () => {
  clearInterval(pollTimer);
  stopService();
});
