# InsideMeeting 桌面客户端

网页版在 Windows 和 macOS 上本来就能用。套一层 Electron 主要买三样东西：

1. **共享屏幕时能带上系统声音**。浏览器里只能抓「标签页音频」，抓不到系统音——放本地视频、演示带声音的软件时对方是听不到的。桌面版在 Windows 上可以直接 loopback 抓系统音。
2. **自签证书不再弹安全警告**。桌面版只对你配置的那台服务器放行证书，不是无差别忽略。
3. **一个能钉在 Dock / 任务栏的入口**，不用每次翻收藏夹。

如果你已经用 Tailscale 拿到了正式证书，第 2 条就没意义了；只有第 1 条是网页版给不了的。**不需要共享系统声音的话，直接用网页版就行，不用装这个。**

## 开发运行

```bash
cd desktop
npm install
npm start
```

第一次启动会让你填服务器地址，填一次就记住了。也可以用环境变量跳过：

```bash
INSIDE_MEETING_URL=https://macmini.xxx.ts.net:8443 npm start
```

## 打包

```bash
npm run dist:mac    # 产出 dmg（arm64 + x64）
npm run dist:win    # 产出 exe 安装包
```

产物在 `desktop/release/`。

**只能在对应平台上打包对应平台的产物**——Mac 上打不出 Windows 的 exe（严格说 electron-builder 配合 wine 可以，但很折腾，不如直接找台 Windows 机器跑一次）。

打出来的包没有代码签名，用户首次打开会被系统拦：

- macOS：右键点图标 → 打开 → 再点「打开」。或者 `xattr -cr /Applications/InsideMeeting.app`
- Windows：SmartScreen 提示时点「更多信息」→「仍要运行」

内部工具这样够用了。要去掉这些提示得买开发者证书，macOS 一年 99 美元，Windows 的 EV 证书更贵。

## 系统声音共享的平台差异

| 平台 | 能不能抓系统声音 |
|---|---|
| Windows | ✅ 直接支持，勾选「同时共享系统声音」即可 |
| macOS | ❌ 系统不允许。需要装 [BlackHole](https://github.com/ExistentialAudio/BlackHole) 之类的虚拟声卡，把系统输出路由过去，再在会议里把它选成麦克风 |
| 网页版 | 只能抓单个浏览器标签页的音频 |

这是 macOS 的系统限制，不是 Electron 的问题——所有会议软件在 Mac 上抓系统音都得靠虚拟声卡。

## 目录结构

```
desktop/
├── main.js       主进程：窗口、证书放行、屏幕共享接管、菜单
├── preload.js    桥接层 + 自绘的屏幕共享选源界面
├── setup.html    首次启动填服务器地址的页面
└── package.json  含 electron-builder 打包配置
```

## 未验证

这部分代码没有在真实桌面环境跑过（开发环境没有图形界面）。语法和 Electron API 用法都对，但首次运行可能需要小修。真跑起来有问题的话，`npm start` 的终端输出和 `开发者工具` 里的报错是排查起点。
