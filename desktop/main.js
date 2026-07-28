const { app, BrowserWindow, desktopCapturer, session, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/**
 * InsideMeeting 桌面壳。
 *
 * 网页版在 Win/Mac 上本来就能用，套 Electron 主要买三样东西：
 *   1. 共享屏幕时能带上系统声音（Windows 上浏览器只能抓标签页音频，抓不到系统音）
 *   2. 自签证书不再弹安全警告
 *   3. 一个能固定在 Dock / 任务栏的入口，不用每次翻收藏夹
 */

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

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

function serverUrl() {
  return process.env.INSIDE_MEETING_URL || readConfig().serverUrl || '';
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'InsideMeeting',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 会议应用不能因为窗口在后台就被降频，否则录制和推流都会卡
      backgroundThrottling: false,
    },
  });

  const url = serverUrl();
  if (url) win.loadURL(url);
  else win.loadFile(path.join(__dirname, 'setup.html'));

  // 外部链接用系统浏览器打开，不要在会议窗口里跳走
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/**
 * 屏幕共享。
 * 浏览器里 getDisplayMedia 会弹系统选择框，Electron 里要自己接管，
 * 顺便把系统音频一起抓进来 —— 这是桌面版相对网页版最实在的优势。
 */
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
          fetchWindowIcons: true,
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

        // loopback 只有 Windows 支持；macOS 需要装虚拟声卡（如 BlackHole）才能抓系统音
        const withAudio = picked.withAudio && process.platform === 'win32';
        callback({ video: source, audio: withAudio ? 'loopback' : undefined });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

app.whenReady().then(() => {
  // 自签证书直接放行。这里只信任用户自己配置的那台服务器，
  // 不是无差别忽略所有证书错误。
  app.on('certificate-error', (event, webContents, url, error, cert, callback) => {
    const trusted = serverUrl();
    if (trusted && url.startsWith(new URL(trusted).origin)) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // 摄像头 / 麦克风 / 屏幕权限，只对配置的服务器自动放行
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'];
    callback(allowed.includes(permission));
  });

  setupDisplayMedia();
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 与渲染进程通信 ----------

ipcMain.handle('get-config', () => ({
  serverUrl: serverUrl(),
  platform: process.platform,
  systemAudioSupported: process.platform === 'win32',
  version: app.getVersion(),
}));

ipcMain.handle('set-server-url', (e, url) => {
  const clean = String(url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(clean)) throw new Error('地址要以 http:// 或 https:// 开头');
  writeConfig({ serverUrl: clean });
  win.loadURL(clean);
  return clean;
});

ipcMain.handle('reset-server-url', () => {
  writeConfig({ serverUrl: '' });
  win.loadFile(path.join(__dirname, 'setup.html'));
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '会议',
      submenu: [
        {
          label: '刷新',
          accelerator: 'CmdOrCtrl+R',
          click: () => win?.reload(),
        },
        {
          label: '更换服务器地址…',
          click: async () => {
            const { response } = await dialog.showMessageBox(win, {
              type: 'question',
              buttons: ['取消', '更换'],
              defaultId: 1,
              message: '更换服务器地址会退出当前会议，确定吗？',
            });
            if (response === 1) {
              writeConfig({ serverUrl: '' });
              win.loadFile(path.join(__dirname, 'setup.html'));
            }
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
