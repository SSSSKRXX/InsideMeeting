const {
  app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, session,
  ipcMain, shell, dialog, clipboard, Notification, systemPreferences,
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

/**
 * 找一个能用的托盘图标。
 *
 * 这里原来直接 nativeImage.createFromPath(assets/icon.png)，
 * 但仓库里 desktop/ 下**根本没有 assets 目录**（图标只存在于 tray/assets），
 * prepare.js 也没有复制。于是打包产物里 assets 是空的，
 * createFromPath 返回空图，new Tray(空图) 在 Windows 上直接抛异常。
 *
 * 而 refreshTray() 是在 app.whenReady() 的回调里同步调用的，
 * 它一抛，后面的 buildMenu()、srv.onServerEvent() 和
 * **服务器身份的自动启动 startAndReport() 就全都不会执行了**。
 */
function trayIconFromFiles() {
  const names = process.platform === 'darwin'
    ? ['trayTemplate.png', 'tray.png', 'icon.png']
    : ['tray.png', 'icon.png', 'trayTemplate.png'];
  const dirs = [
    path.join(__dirname, 'assets'),
    path.resolve(__dirname, '..', 'tray', 'assets'), // 从源码直接跑时的位置
  ];
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) continue;
      let img = nativeImage.createFromPath(p);
      if (img.isEmpty()) continue;
      // macOS 的模板图必须保持单色语义，不能缩放也不能当彩图用
      if (process.platform === 'darwin' && n === 'trayTemplate.png') img.setTemplateImage(true);
      else img = img.resize({ width: 16, height: 16, quality: 'best' });
      return img;
    }
  }
  return null;
}

/**
 * 兜底：直接问系统要 exe 自己的图标。
 *
 * 这样托盘、任务栏、桌面快捷方式三处永远是同一个图标，
 * 不需要再单独维护一份 png，也不会出现「托盘是个蓝方块」这种事。
 * getFileIcon 是异步的，所以托盘先用占位图建起来，拿到之后再 setImage 换掉。
 */
async function trayIconFromExe() {
  try {
    const img = await app.getFileIcon(process.execPath, { size: 'large' });
    if (!img || img.isEmpty()) return null;
    return img.resize({ width: 16, height: 16, quality: 'best' });
  } catch {
    return null;
  }
}

/** 只为了不让 Tray 构造失败的占位图，正常情况下几百毫秒后就被换掉 */
function placeholderIcon() {
  const buf = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0xf6; buf[i + 1] = 0x82; buf[i + 2] = 0x3b; buf[i + 3] = 0xff; // BGRA
  }
  return nativeImage.createFromBuffer(buf, { width: 16, height: 16 });
}

function refreshTray() {
  const cfg = readConfig();
  if (cfg.role !== 'server') {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    try {
      const fromFile = trayIconFromFiles();
      tray = new Tray(fromFile || placeholderIcon());
      if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());

      // assets 里没有图标文件时，异步换成 exe 自己的那个
      if (!fromFile) {
        trayIconFromExe().then((img) => {
          if (img && tray && !tray.isDestroyed()) tray.setImage(img);
        });
      }
    } catch (e) {
      // 托盘是锦上添花，绝不能因为它把整个启动流程带走
      console.error('创建托盘失败，跳过：', e.message);
      tray = null;
      return;
    }
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

  // 端口上本来就有一份 InsideMeeting 在跑，被复用了。
  // 这不算失败，但得让用户知道「停止服务」管不到它。
  if (r.ok && r.note) notify('服务已就绪', r.note);

  if (!r.ok) {
    // 把日志尾部直接摆出来，并给一个「打开日志目录」的按钮，
    // 而不是让用户自己去猜 %APPDATA% 在哪
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: '服务启动失败',
      message: r.error || '未知错误',
      detail: r.detail ? `${r.detail}` : '日志里没有更多信息。',
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

/**
 * 让渲染进程弹出选源界面并等结果。
 *
 * 不能用 executeJavaScript 去调 preload 里挂在 window 上的函数 ——
 * 开了 contextIsolation 之后 preload 的 window 是隔离世界，
 * 而 executeJavaScript 跑在主世界，看不到那个函数，只会抛异常。
 * 走 IPC 就绕开了整个隔离世界的问题。
 */
function askRendererToPick(sources) {
  return new Promise((resolve, reject) => {
    // 窗口不在了就别往下走。原来这里直接 win.webContents.send，
    // win 为 null 时抛出的异常被外层 catch 吃掉，变成一次静默的 callback({})，
    // 前端只看到 getDisplayMedia 被拒绝，没有任何线索。
    if (!win || win.isDestroyed()) return reject(new Error('会议窗口不存在'));

    const id = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(id);
      resolve(null);
    }, 120000); // 用户可能盯着选源界面发呆，给足两分钟

    ipcMain.once(id, (e, picked) => {
      clearTimeout(timer);
      resolve(picked);
    });

    win.webContents.send('pick-share-source', { replyChannel: id, sources });
  });
}

/** 权限没给的时候，与其静默失败不如直接告诉用户去哪里点 */
function warnNoScreenPermission() {
  if (process.platform === 'darwin') {
    dialog.showMessageBox(win, {
      type: 'warning',
      message: '需要屏幕录制权限',
      detail:
        '系统设置 → 隐私与安全性 → 屏幕录制，勾选 InsideMeeting，然后完全退出 App 再重新打开。\n\n' +
        '（macOS 要求重启 App 后权限才生效。）',
      buttons: ['知道了', '打开系统设置'],
    }).then(({ response }) => {
      if (response === 1) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    });
    return;
  }
  dialog.showMessageBox(win, {
    type: 'warning',
    message: '没有找到可共享的屏幕或窗口',
    detail:
      '常见原因：\n' +
      '· Windows：设置 → 隐私和安全性 → 应用权限，确认没有禁止桌面应用截取屏幕\n' +
      '· 安全软件（部分企业管控软件）拦截了屏幕捕获\n' +
      '· 远程桌面 / 虚拟机会话下没有可枚举的显示器\n\n' +
      '如果都排除了，「会议 → 开发者工具」里的 Console 会有更具体的报错。',
    buttons: ['知道了'],
  });
}

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
          fetchWindowIcons: false,
        });

        if (!sources.length) {
          // macOS 没给「屏幕录制」权限时 getSources 会返回空数组；
          // Windows 上被安全软件拦截也是同样的表现。两边都要给提示，
          // 原来只处理了 macOS，Windows 用户点了共享就是毫无反应。
          warnNoScreenPermission();
          return callback({});
        }

        const picked = await askRendererToPick(
          sources.map((s) => ({
            id: s.id,
            name: s.name,
            thumbnail: s.thumbnail.toDataURL(),
            isScreen: s.id.startsWith('screen'),
          }))
        );
        if (!picked) return callback({}); // 用户取消

        const source = sources.find((s) => s.id === picked.id);
        if (!source) return callback({});

        // loopback 只有 Windows 支持；macOS 需要 BlackHole 之类的虚拟声卡。
        //
        // 注意这里**不能**写成 `{ video: source, audio: withAudio ? 'loopback' : undefined }`。
        // Electron 33 校验这个对象时只看 key 在不在，不看值是不是 undefined，
        // 于是不勾「共享系统声音」时会抛：
        //   TypeError: audio must be a WebFrameMain, "loopback" or "loopbackWithMute"
        // 必须整个 key 都不出现。
        const out = { video: source };
        if (picked.withAudio && process.platform === 'win32') out.audio = 'loopback';

        try {
          callback(out);
        } catch (err) {
          // 某些声卡驱动下 loopback 会被拒。退回只共享画面，总比整个共享开不起来强。
          console.warn('[display-media] 带系统声音失败，退回只共享画面：', err.message);
          callback({ video: source });
        }
      } catch (e) {
        // 原来这里是空 catch。任何异常都会变成一次没有解释的失败。
        console.error('[display-media] 处理共享请求出错：', e);
        try {
          dialog.showMessageBox(win, {
            type: 'error',
            message: '开启屏幕共享失败',
            detail: `${e.name || 'Error'}: ${e.message || e}`,
            buttons: ['知道了'],
          });
        } catch { /* 窗口可能已经没了 */ }
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

app.whenReady().then(async () => {
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

  const ALLOWED = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'];

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOWED.includes(permission));
  });

  // 少了这个，enumerateDevices() 拿到的设备 label 全是空字符串 ——
  // 前端的麦克风下拉框看起来就是「识别不出设备」。
  // setPermissionRequestHandler 只管「弹窗询问」那一次，
  // 页面随后做的同步权限查询走的是 CheckHandler，两个都要给。
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOWED.includes(permission));

  // macOS 上要主动申请一次，否则第一次 getUserMedia 会直接被系统拒绝
  if (process.platform === 'darwin') {
    for (const type of ['microphone', 'camera']) {
      try {
        if (systemPreferences.getMediaAccessStatus(type) !== 'granted') {
          await systemPreferences.askForMediaAccess(type);
        }
      } catch { /* 老版本没有这个 API */ }
    }
  }

  setupDisplayMedia();
  createWindow();

  // 托盘失败不能影响后面的初始化和服务自启（这曾经是个真实的启动中断点）
  try {
    refreshTray();
  } catch (e) {
    console.error('刷新托盘失败：', e.message);
  }

  buildMenu();

  srv.onServerEvent(() => {
    try {
      refreshTray();
    } catch { /* 同上 */ }
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
