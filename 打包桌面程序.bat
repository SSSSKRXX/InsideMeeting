@echo off
chcp 65001 >nul
REM 打包 InsideMeeting 桌面 App（Windows）。双击运行即可。
setlocal
cd /d "%~dp0"

echo ==================================================
echo   打包 InsideMeeting 桌面 App
echo ==================================================
echo.
echo 打出来的 App 里内嵌了完整服务端，装的人不需要再装
echo Node.js 或 ffmpeg，双击就能当服务器用。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未安装 Node.js。先执行：winget install OpenJS.NodeJS.LTS
  echo 装完需要重开这个窗口，让 PATH 生效。
  pause
  exit /b 1
)

REM Electron 官方源在国内很慢，换镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

echo --- 构建前端 ---
if not exist node_modules call npm install
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail
echo.

echo --- 打包 App ---
pushd desktop
if not exist node_modules (
  echo 首次打包要下载 Electron 和 ffmpeg，约 200MB，请耐心等…
  call npm install
  if errorlevel 1 goto failpop
)
call npm run dist:win
if errorlevel 1 goto failpop
popd

echo.
echo ==================================================
echo   完成，产物在 desktop\release\
echo ==================================================
dir /b desktop\release\*.exe 2>nul

echo.
echo 装之前先知道这几件事：
echo.
echo 1. 没有代码签名，首次运行 SmartScreen 会拦
echo    点「更多信息」-^> 「仍要运行」即可。
echo.
echo 2. 这里打不出 macOS 的 dmg
echo    需要 dmg 就在 Mac 上跑「打包桌面程序.command」，
echo    或者推一个 v 开头的 tag 让 GitHub Actions 两个平台一起打。
echo.
echo 3. 当服务器的那台机器仍然需要装 Tailscale
echo    那是网络层的事，App 代劳不了。
echo.
pause
exit /b 0

:failpop
popd
:fail
echo.
echo 打包失败，看上面的报错。
pause
exit /b 1
