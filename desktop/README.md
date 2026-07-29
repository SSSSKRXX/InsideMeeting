# InsideMeeting 桌面 App

一个 App 两种身份，首次启动时选。

## 这台电脑当服务器

App 内部会起一个完整的服务端。**机器上什么都不用装**：

| | 从源码部署 | 装这个 App |
|---|---|---|
| Node.js | 要自己装 | App 自带 |
| ffmpeg | 要自己装 | App 自带 |
| 下载代码、跑脚本 | 要 | 不用 |
| HTTPS 证书 | 跑脚本生成 | 自动生成 |
| 改配置 | 编辑 .env | 界面上填 |

启动后界面会显示入会地址，复制发给同事即可。托盘图标里能随时启停服务、看日志、开机自启。

**唯一还需要自己装的是 Tailscale**——那是网络层的事，App 管不了。全员在同一个局域网的话可以跳过。

## 我只是参会

填一个别人给的服务器地址，填一次就记住。

其实**参会用浏览器就够了**，装 App 只多解决一件事：共享屏幕时能带上系统声音（浏览器只能抓单个标签页的音频）。不需要这个功能就别装。

---

## 它是怎么把服务端塞进去的

关键是 `ELECTRON_RUN_AS_NODE=1`。设了这个环境变量，Electron 的可执行文件就会当成纯 Node 来跑——所以用户机器上不需要装 Node.js，App 自带的那份就够了。ffmpeg 同理，用 `ffmpeg-static` 打包进来。

**服务端代码一行没改。** 它只是被 fork 起来的一个普通 Node 进程，所有差异都通过环境变量传进去（数据目录、证书路径、ffmpeg 路径、端口）。这样「从源码部署」和「装 App」跑的是完全相同的服务端，不会出现只在某一种方式下才有的 bug。

```
desktop/
├── main.js             主进程：身份路由、托盘、屏幕共享接管、证书放行
├── server-manager.js   fork 服务进程、健康检查、日志
├── cert.js             自签证书（纯 JS，不依赖 openssl）
├── preload.js          桥接层 + 自绘的屏幕共享选源界面
├── setup.html          首次启动：选身份
├── server.html         服务器模式的控制面板
├── scripts/prepare.js  打包前把 server/src 和 web/dist 复制进 bundled/
└── bundled/            打包产物（gitignore，由 prepare 生成）
```

几个刻意的选择：

**`asar: false`** —— 服务端是被 fork 成独立进程跑的，普通文件路径最省事，也不用担心 asar 里执行二进制的各种坑。

**数据存在 `userData`**，不在 App 内部。这样升级 App 不会丢会议记录，卸载时也知道去哪清数据。

**证书按内网 IP 签发并记录**，网络环境变了（换 WiFi、Tailscale 重新分配）会自动重签，否则地址对不上。

## 开发运行

```bash
# 先在项目根目录构建前端
npm install && npm run build

cd desktop
npm install
npm start
```

开发模式下 `bundled/` 不存在，会自动回退到上级目录的 `server/src`，改服务端代码重启 App 即可生效。

## 打包

```bash
cd desktop
npm run dist:mac    # dmg（arm64 + x64）
npm run dist:win    # exe
```

产物在 `desktop/release/`。`npm run dist` 会自动先跑 `prepare-bundle`。

**只能在对应平台打对应平台的包。** 三个办法：

| 办法 | 怎么做 |
|---|---|
| **GitHub Actions（推荐）** | 推一个 `v` 开头的 tag，云上两个平台一起打，产物自动传到 Releases |
| Windows 本机 | 双击项目根目录的 `打包桌面程序.bat` |
| Mac 本机 | 双击 `打包桌面程序.command` |

打出来的包没有代码签名，首次打开会被系统拦（macOS 右键打开，Windows 点「仍要运行」）。要去掉提示得买开发者证书，macOS 一年 99 美元，内部工具不值当。

## 系统声音共享的平台差异

| 平台 | 能不能抓系统声音 |
|---|---|
| Windows | ✅ 勾选「同时共享系统声音」即可 |
| macOS | ❌ 系统不允许。需要装 [BlackHole](https://github.com/ExistentialAudio/BlackHole) 之类的虚拟声卡 |
| 网页版 | 只能抓单个浏览器标签页的音频 |

这是 macOS 的系统限制，所有会议软件在 Mac 上都得靠虚拟声卡。

## 未在真实桌面环境验证

开发环境没有图形界面，所以窗口、托盘、屏幕共享选源这些只保证语法和 API 用法正确，首次运行可能需要小修。

**已经实测过的**：证书生成（含复用逻辑）、服务端在 bundled 布局下正常启动、HTTPS 可访问、前端和静态资源正常加载、数据写到指定目录而不是 App 内部。

出问题的话，`npm start` 的终端输出和托盘菜单里的「查看日志」是排查起点。
