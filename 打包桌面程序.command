#!/usr/bin/env bash
# 打包 InsideMeeting 桌面 App（macOS）。
# 双击运行；没反应就先 chmod +x "打包桌面程序.command"
set -e
cd "$(dirname "$0")"

echo "=================================================="
echo "  打包 InsideMeeting 桌面 App"
echo "=================================================="
echo ""
echo "打出来的 App 里内嵌了完整服务端，装的人不需要再装"
echo "Node.js 或 ffmpeg，双击就能当服务器用。"
echo ""

command -v node >/dev/null || { echo "❌ 未安装 Node.js。先执行：brew install node"; exit 1; }

# App 内嵌前端产物，所以要先构建
echo "--- 构建前端 ---"
[ -d node_modules ] || npm install
npm run build
echo ""

echo "--- 打包 App ---"
cd desktop
if [ ! -d node_modules ]; then
  echo "首次打包要下载 Electron 和 ffmpeg，约 200MB，请耐心等…"
  # Electron 官方源在国内很慢，换镜像
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  npm install
fi

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
npm run dist:mac
cd ..

echo ""
echo "=================================================="
echo "  完成，产物在 desktop/release/"
echo "=================================================="
ls -lh desktop/release/*.dmg 2>/dev/null | awk '{print "  " $9 "  " $5}' || true

cat <<'TIP'

装之前先知道这几件事：

1. 没有代码签名，首次打开会被系统拦
   右键点图标 → 打开 → 再点一次「打开」。
   或者执行：xattr -cr "/Applications/InsideMeeting.app"

2. 这里打不出 Windows 的 exe
   electron-builder 只能在对应平台打对应平台的包。要 exe：

   a) 推一个 tag，让 GitHub Actions 在云上两个平台一起打：
        git tag v0.2.0 && git push origin v0.2.0
      打完去仓库的 Releases 页面下载。

   b) 在 Windows 机器上双击「打包桌面程序.bat」。

3. 当服务器的那台机器仍然需要装 Tailscale
   那是网络层的事，App 代劳不了。全员在同一个局域网可以跳过。

TIP

read -p "打开产物目录？[Y/n] " ans
case "$ans" in
  [nN]) ;;
  *) open desktop/release 2>/dev/null || true ;;
esac
