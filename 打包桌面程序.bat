@echo off
chcp 65001 >nul
REM 在 Windows 上打包桌面客户端和服务控制器。
REM 双击运行即可。对应 macOS 上的「打包桌面程序.command」。
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==================================================
echo   InsideMeeting 打包（Windows）
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未安装 Node.js。先执行：winget install OpenJS.NodeJS.LTS
  echo 装完需要重开这个窗口，让 PATH 生效。
  pause
  exit /b 1
)

echo 要打包哪个？
echo   1) 桌面会议客户端    参会用，主要为了共享屏幕能带系统声音
echo   2) 服务控制器        装在跑服务的那台机器上，管服务启停
echo   3) 两个都打
echo.
set /p choice=选择 [1/2/3]:
echo.

REM Electron 官方源在国内很慢，换成镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

if "%choice%"=="1" call :build desktop "桌面会议客户端"
if "%choice%"=="2" call :build tray "服务控制器"
if "%choice%"=="3" (
  call :build desktop "桌面会议客户端"
  call :build tray "服务控制器"
)
if "%choice%"=="" (
  echo 没选，退出。
  pause
  exit /b 0
)

echo.
echo ==================================================
echo   装之前先知道这几件事
echo ==================================================
echo.
echo 1. 没有代码签名，首次运行 SmartScreen 会拦
echo    点「更多信息」-^> 「仍要运行」即可。
echo    要去掉这个提示得买 EV 代码签名证书，内部工具不值当。
echo.
echo 2. 打不出 macOS 的 dmg
echo    electron-builder 只能在对应平台打对应平台的包。
echo    需要 dmg 就在 Mac 上跑「打包桌面程序.command」，
echo    或者推一个 v 开头的 tag，让 GitHub Actions 两个平台一起打。
echo.
echo 3. 服务控制器需要机器上装了 Node.js
echo    它只是控制服务启停，服务本身还是那个 node 进程。
echo.
pause
exit /b 0

:build
set dir=%~1
set name=%~2
echo ==================================================
echo   打包：%name%
echo ==================================================
pushd %dir%

if not exist node_modules (
  echo 首次打包要下载 Electron，大约 100MB，请耐心等…
  call npm install
  if errorlevel 1 (
    echo npm install 失败。
    popd
    exit /b 1
  )
)

call npm run dist
if errorlevel 1 (
  echo 打包失败。
  popd
  exit /b 1
)

echo.
echo %name% 打包完成，产物在 %dir%\release\
dir /b release\*.exe 2>nul
popd
echo.
exit /b 0
