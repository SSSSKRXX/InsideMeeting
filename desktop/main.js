const {
  app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, session,
  ipcMain, shell, dialog, clipboard, Notification,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const srv = require('./server-manager.js');

/**
 * InsideMeeting 桌面端。
 *
 * 同一个 App 有两种身份，首次启动时选：
 *   服务器 —— App 内部起一个完整的服务端（自带 Node 和 ffmpeg，
 *             机器上什么都不用装），别人连它
 *   参会者 —— 填一个服务器地址，当浏览器用
 *
 * 服务器模式下顺带解决了源码部署时最烦的几件事：
 * 不用装 Node、不用装 ffmpeg、不用 clone 代码、证书自动生成。
 * 剩下唯一要自己装的是 Tailscale，那是网络层的事，App 管不了。
 */

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_PORT = 8443;

let win = null;
let tray = null;
let logWindow = null;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2));
  return next;
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// ---------------- 窗口 ----------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'InsideMeeting',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 会议应用不能因为窗口在后台就被降频，否则录制和推流都会卡
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });

  route();
}

/** 根据当前身份决定加载哪个页面 */
function route() {
  const cfg = readConfig();
  if (cfg.role === 'server') {
    win.loadFile(path.join(__dirname, 'server.html'));
  } else if (cfg.role === 'client' && cfg.serverUrl) {
    win.loadURL(cfg.serverUrl);
  } else {
    win.loadFile(path.join(__dirname, 'setup.html'));
  }
}

function openMeeting(url) {
  if (!win) createWindow();
  win.loadURL(url);
}

// ---------------- 托盘（服务器模式才显示）----------------

function refreshTray() {
  const cfg = readConfig();
  if (cfg.role !== 'server') {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    const iconFile = process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png';
    const p = path.join(__dirname, 'assets', iconFile);
    let img = nativeImage.createFromPath(p);
    if (process.platform === 'darwin') img.setTemplateImage(true);
    else img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
  }

  const st = srv.serverState();
  const port = cfg.port || DEFAULT_PORT;
  const url = srv.shareUrl(port);

  const items = [
    { label: st.running ? '● 服务运行中' : st.starting ? '○ 正在启动…' : '○ 服务未运行', enabled: false },
    { type: 'separator' },
    st.running
      ? { label: '停止服务', click: () => srv.stopServer() }
      : { label: '启动服务', click: () => startAndReport(port) },
    { type: 'separator' },
    {
      label: '复制入会地址',
      enabled: st.running,
      click: () => {
        clipboard.writeText(url);
        notify('已复制', url);
      },
    },
    { label: '打开会议页面', enabled: st.running, click: () => openMeeting(`https://localhost:${port}`) },
    { label: '管理后台', enabled: st.running, click: () => openMeeting(`https://localhost:${port}/#/admin`) },
    { type: 'separator' },
    { label: '查看日志', click: openLogWindow },
    { label: '打开数据目录', click: () => shell.openPath(srv.dataDir()) },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: true }),
    },
    { type: 'separator' },
    { label: '切换身份…', click: switchRole },
    { label: '退出（会停止服务）', click: () => { srv.stopServer(); app.quit(); } },
  ];

  tray.setToolTip(st.running ? `InsideMeeting · ${url}` : 'InsideMeeting · 未运行');
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function startAndReport(port) {
  const r = await srv.startServer({ port });
  if (!r.ok) {
    // 把日志尾部直接摆出来，并给一个「打开日志目录」的按钮，
    // 而不是让用户自己去猜 %APPDATA% 在哪
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: '服务启动失败',
      message: r.error || '未知错误',
      detail: r.detail ? `日志最后几行：\n\n${r.detail}` : '日志里没有更多信息。',
      buttons: ['知道了', '打开日志目录', '复制错误信息'],
      defaultId: 0,
    });
    if (response === 1) shell.showItemInFolder(r.logFile || srv.logFile());
    if (response === 2) clipboard.writeText(`${r.error}\n\n${r.detail || ''}`);
  }
  refreshTray();
  win?.webContents.send('server-state', { ...srv.serverState(), url: srv.shareUrl(port) });
  return r;
}

async function switchRole() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['取消', '重新选择'],
    defaultId: 1,
    cancelId: 0,
    message: '切换身份会退出当前会议并停止本机服务，确定吗？',
  });
  if (response !== 1) return;
  srv.stopServer();
  writeConfig({ role: '', serverUrl: '' });
  refreshTray();
  if (!win) createWindow();
  else win.loadFile(path.join(__dirname, 'setup.html'));
}

function openLogWindow() {
  if (logWindow) return logWindow.focus();
  logWindow = new BrowserWindow({ width: 900, height: 600, title: '服务日志', backgroundColor: '#0b0e13' });
  const load = () => {
    if (!logWindow || logWindow.isDestroyed()) return;
    const text = srv.readLog().replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    logWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="margin:0;background:#0b0e13;color:#e6edf3;font:12px ui-monospace,Menlo,monospace">
             <pre style="padding:14px;white-space:pre-wrap;word-break:break-all">${text}</pre>
             <script>window.scrollTo(0,document.body.scrollHeight)</script>
           </body>`
        )
    );
  };
  load();
  const t = setInterval(load, 5000);
  logWindow.on('closed', () => {
    clearInterval(t);
    logWindow = null;
  });
}

// ---------------- 屏幕共享 ----------------

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
        });
        if (!sources.length) return callback({});

        const picked = await win.webContents.executeJavaScript(
          `window.__pickShareSource(${JSON.stringify(
            sources.map((s) => ({
              id: s.id,
              name: s.name,
              thumbnail: s.thumbnail.toDataURL(),
              isScreen: s.id.startsWith('screen'),
            }))
          )})`,
          true
        );
        if (!picked) return callback({});

        const source = sources.find((s) => s.id === picked.id);
        if (!source) return callback({});

        // loopback 只有 Windows 支持；macOS 需要 BlackHole 之类的虚拟声卡
        const withAudio = picked.withAudio && process.platform === 'win32';
        callback({ video: source, audio: withAudio ? 'loopback' : undefined });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

// ---------------- IPC ----------------

ipcMain.handle('get-config', () => {
  const cfg = readConfig();
  return {
    role: cfg.role || '',
    serverUrl: cfg.serverUrl || '',
    port: cfg.port || DEFAULT_PORT,
    platform: process.platform,
    systemAudioSupported: process.platform === 'win32',
    version: app.getVersion(),
    server: srv.serverState(),
    shareUrl: srv.shareUrl(cfg.port || DEFAULT_PORT),
  };
});

ipcMain.handle('choose-role', async (e, { role, serverUrl, port }) => {
  if (role === 'server') {
    const p = Number(port) || DEFAULT_PORT;
    writeConfig({ role: 'server', port: p });
    const r = await startAndReport(p);
    if (!r.ok) {
      writeConfig({ role: '' });
      return r;
    }
    refreshTray();
    win.loadFile(path.join(__dirname, 'server.html'));
    return { ok: true, url: srv.shareUrl(p) };
  }

  const clean = String(serverUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(clean)) return { ok: false, error: '地址要以 http:// 或 https:// 开头' };
  writeConfig({ role: 'client', serverUrl: clean });
  win.loadURL(clean);
  return { ok: true };
});

ipcMain.handle('server-action', async (e, { action, port }) => {
  const p = Number(port) || readConfig().port || DEFAULT_PORT;
  if (action === 'start') return startAndReport(p);
  if (action === 'stop') {
    const r = srv.stopServer();
    refreshTray();
    return r;
  }
  if (action === 'state') return { ok: true, ...srv.serverState(), url: srv.shareUrl(p) };
  if (action === 'open') {
    openMeeting(`https://localhost:${p}`);
    return { ok: true };
  }
  if (action === 'admin') {
    openMeeting(`https://localhost:${p}/#/admin`);
    return { ok: true };
  }
  if (action === 'copy') {
    clipboard.writeText(srv.shareUrl(p));
    return { ok: true, url: srv.shareUrl(p) };
  }
  if (action === 'logs') return { ok: true, text: srv.readLog(40 * 1024) };
  if (action === 'data-dir') {
    shell.openPath(srv.dataDir());
    return { ok: true };
  }
  return { ok: false, error: '未知操作' };
});

ipcMain.handle('switch-role', switchRole);

// ---------------- 启动 ----------------

app.whenReady().then(() => {
  // 自签证书直接放行，但只对本机服务和用户配置的那台，不是无差别忽略
  app.on('certificate-error', (event, webContents, url, error, cert, callback) => {
    const cfg = readConfig();
    const trusted = [cfg.serverUrl, `https://localhost:${cfg.port || DEFAULT_PORT}`, `https://127.0.0.1:${cfg.port || DEFAULT_PORT}`]
      .filter(Boolean)
      .map((u) => {
        try {
          return new URL(u).origin;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch { /* 忽略 */ }

    // 服务器模式下自己起的服务用的就是自签证书，一律放行
    if (readConfig().role === 'server' || (origin && trusted.includes(origin))) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission));
  });

  setupDisplayMedia();
  createWindow();
  refreshTray();
  buildMenu();

  srv.onServerEvent(() => {
    refreshTray();
    win?.webContents.send('server-state', srv.serverState());
  });

  // 服务器身份的话，开 App 就自动把服务拉起来
  const cfg = readConfig();
  if (cfg.role === 'server') startAndReport(cfg.port || DEFAULT_PORT);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 服务器模式关窗口不退出，服务继续在托盘里跑
  if (readConfig().role === 'server') return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => srv.stopServer());

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: '会议',
        submenu: [
          { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
          { label: '返回主页', click: () => route() },
          { type: 'separator' },
          { label: '切换身份…', click: switchRole },
          { label: '查看服务日志', click: openLogWindow },
          { type: 'separator' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
        ],
      },
      { role: 'editMenu', label: '编辑' },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
    ])
  );
}
