#!/usr/bin/env bash
# 一键打包桌面客户端和菜单栏程序。
# 双击运行；没反应就先 chmod +x "打包桌面程序.command"
set -e
cd "$(dirname "$0")"

echo "=================================================="
echo "  InsideMeeting 打包"
echo "=================================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "未安装 Node.js。先执行：brew install node"
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "注意：当前不是 macOS，只能打出本平台的包。"
  echo ""
fi

echo "要打包哪个？"
echo "  1) 桌面会议客户端    —— 参会用，主要为了共享屏幕能带系统声音"
echo "  2) 服务菜单栏程序    —— 装在服务器那台机器上，管服务启停"
echo "  3) 两个都打"
echo ""
read -p "选择 [1/2/3]: " choice
echo ""

build_one() {
  local dir="$1" name="$2"
  echo "=================================================="
  echo "  打包：$name"
  echo "=================================================="
  cd "$dir"

  if [ ! -d node_modules ]; then
    echo "首次打包要下载 Electron，大约 100MB，请耐心等…"
    npm install
  fi

  # Electron 官方源在国内很慢，自动换镜像
  if [ -z "${ELECTRON_MIRROR:-}" ]; then
    export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  fi

  npm run dist
  echo ""
  echo "$name 打包完成，产物在 $dir/release/"
  ls -lh release/*.dmg release/*.exe 2>/dev/null | awk '{print "  " $9 "  " $5}' || true
  cd ..
  echo ""
}

case "$choice" in
  1) build_one desktop "桌面会议客户端" ;;
  2) build_one tray "服务菜单栏程序" ;;
  3) build_one desktop "桌面会议客户端"; build_one tray "服务菜单栏程序" ;;
  *) echo "没选，退出。"; exit 0 ;;
esac

cat <<'TIP'
==================================================
  装之前先知道这几件事
==================================================

1. 没有代码签名，首次打开会被系统拦住
   右键点图标 → 打开 → 再点一次「打开」。
   或者执行：xattr -cr "/Applications/你的应用名.app"

   要彻底去掉这个提示得买苹果开发者证书，一年 99 美元。
   内部工具不值当，右键打开一次就行。

2. Windows 的 exe 打不出来
   electron-builder 只能在对应平台打对应平台的包。
   需要 exe 的话，找台 Windows 机器 clone 仓库跑：
     cd desktop && npm install && npm run dist:win
   或者用 GitHub Actions 在云上打（想要的话我可以加配置）。

3. 菜单栏程序需要机器上装了 Node.js
   它只是控制服务启停，服务本身还是那个 node 进程。
   打包时不会把 Node 打进去 —— 这样服务能独立跑，
   用终端、用 launchd、用这个 App 三种方式随时可换。

4. 桌面客户端第一次打开要填服务器地址
   形如 https://macmini.xxx.ts.net:8443，填一次就记住了。

TIP

read -p "打开产物目录？[Y/n] " open_it
case "$open_it" in
  [nN]) ;;
  *) [ -d desktop/release ] && open desktop/release 2>/dev/null || true
     [ -d tray/release ] && open tray/release 2>/dev/null || true ;;
esac
