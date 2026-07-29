#!/usr/bin/env bash
# 把本轮改动按功能拆成多个提交，然后推送到 GitHub。
# 双击运行；如果双击没反应，先执行一次：chmod +x "提交并推送.command"
set -e
cd "$(dirname "$0")"

echo "=================================================="
echo "  提交本轮改动"
echo "=================================================="
echo ""

if [ ! -d .git ]; then
  echo "还没有 git 仓库。请先运行「推送到GitHub.command」。"
  exit 1
fi

# ---------- 安全检查 ----------
echo "--- 安全检查 ---"
FAIL=0
for f in .env server/.env certs data web/public/models desktop/release desktop/node_modules; do
  if [ -e "$f" ] && ! git check-ignore -q "$f" 2>/dev/null; then
    echo "  ✗ $f 存在但没被 .gitignore 忽略！"
    FAIL=1
  fi
done
[ "$FAIL" = "1" ] && { echo "请先修好 .gitignore 再提交。"; exit 1; }
echo "  敏感文件均已忽略"
echo ""

# ---------- 按功能分批提交 ----------
# 每批：提交信息 + 文件列表（用 : 分隔）
commit_batch() {
  local msg="$1"; shift
  local found=0
  for p in "$@"; do
    if [ -e "$p" ]; then
      git add "$p"
      found=1
    fi
  done
  # 只有真的有变更才提交，避免产生空提交
  if [ "$found" = "1" ] && ! git diff --cached --quiet; then
    git commit -q -m "$msg"
    echo "  ✓ $(echo "$msg" | head -1)"
  fi
}

echo "--- 生成提交 ---"

commit_batch "feat(security): 会议密码、等候室、主持人权限

- 房间级密码，scrypt 哈希持久化，与全局口令是两道独立的门
- 等候室：新人需主持人放行，5 分钟无响应自动放弃
- 锁定会议、移出成员
- 主持人令牌多个并存：掉线临时移交主持权后，
  原主持人重连仍是主持人，不会被覆盖
- 修复：被放行的成员需要在自己的连接上下文里回写会话状态，
  否则他之后发的信令和聊天都会被丢弃" \
  server/src/roomstore.js server/src/signaling.js

commit_batch "feat(notify): 纪要自动推送到企业微信/飞书/邮件

- 三渠道独立，配了哪个发哪个，单个失败不影响其它
- 飞书支持签名校验，邮件支持附带纪要和逐字稿附件
- 会后流水线跑完自动触发，也可在会议记录页手动补发
- 推送失败不让整个流程算失败——纪要本身已经生成好了" \
  server/src/notify.js

commit_batch "feat(media): 虚拟背景与增强降噪

- MediaPipe 人像分割做背景模糊/换图，模型优先从本机加载
- 噪声门 + 85Hz 高通，压掉底噪以减少语音识别的幻听文本
- 关键：处理链输出轨固定不变，开关只改内部参数，
  不需要重新协商 WebRTC，也不打断正在进行的录制
- scripts/fetch-models.sh 预下载模型，避免依赖外网" \
  web/src/lib/audio.js web/src/lib/video.js scripts/fetch-models.sh

commit_batch "feat(desktop): Electron 桌面客户端

主要为了共享屏幕时能带上系统声音——浏览器只能抓标签页音频。
另外顺带解决自签证书警告，并提供一个可固定的入口。
含 electron-builder 打包配置（dmg / nsis）。

注：未在真实桌面环境验证，只保证语法和 API 用法正确。" \
  desktop

commit_batch "feat(web): 前端接入新功能

- 等候/被拒/被踢的独立界面
- 主持人面板：等候队列审批、房间设置、踢人
- 设置标签页：降噪、虚拟背景
- 入会前预查房间是否需要密码、有无等候室
- 会议记录页增加手动推送纪要" \
  web/src/views web/src/styles.css web/src/lib

commit_batch "feat(admin): 网页管理后台

服务状态、房间密码管理、磁盘占用与清理、配置总览、日志查看。
全部走 ADMIN_TOKEN 鉴权。

两个刻意的保守设计：
- 清理默认只删音视频，保留纪要和逐字稿（纯文本不占空间但删了拿不回来）
- 清理按钮默认先跑预演，确认后才真删" \
  server/src/admin.js web/src/views/Admin.jsx

commit_batch "feat(tray): Mac 菜单栏程序管理服务启停

不用再开终端。启停重启、看在会人数、一键复制入会地址
（优先 Tailscale 的 100.x 段）、开机自启、看日志。

服务本身仍是独立的 node 进程——菜单栏程序只是控制它，
所以终端/launchd/菜单栏三种启动方式随时可换，不会互相锁死。" \
  tray 打包桌面程序.command

commit_batch "feat(storage): 录制与纪要保存位置可在界面上改

录制是几百 MB 的音视频，纪要是几十 KB 的文本，分开配置才实用：
大文件放外置盘，纪要留在系统盘跟着备份。

- 网页后台列出常用位置和外接磁盘作为候选，也支持手敲绝对路径
- 菜单栏程序直接弹系统文件夹选择框（它跑在服务器那台机器上）
- 可选择同时搬移已有文件，同磁盘内用 rename 瞬间完成
- 改动立即生效，不重启

两个踩到的坑：
- 校验目录必须异步且带超时。同步 fs 调用碰上掉线的网络盘会阻塞
  整个事件循环，那时连打开后台改回本地路径都做不到。
- 搬移纪要不能整目录搬。没分离配置时纪要目录就等于录制目录，
  整目录搬会把音视频和 manifest 一起带走，历史会议全部消失。" \
  server/src/storage.js

commit_batch "build: Windows 打包与 GitHub Actions 云端构建

electron-builder 只能在对应平台打对应平台的包，之前只有 macOS 的入口。

- 新增 GitHub Actions：推 v 开头的 tag 就在云上同时打 mac 和 win，
  产物自动传到 Releases。不需要有 Windows 电脑。
- 新增 打包桌面程序.bat，在 Windows 本机打包
- 服务控制器也支持 Windows：托盘图标改用彩色图（Windows 不认模板图标）、
  左键点击手动弹菜单、补上 Windows 下常见的 node 和 ffmpeg 路径" \
  .github 打包桌面程序.bat tray/package.json tray/main.js desktop/README.md 打包桌面程序.command

commit_batch "feat(settings): 25 项常用配置搬到管理界面

原来配 API Key 得 ssh 上服务器改 .env 再重启，这道门槛
足以让整套系统在非技术团队里用不起来。

- 运行时设置层覆盖 .env，存 data/settings.json，保存立即生效
- 实现上是原地修改 config 对象：各模块都在函数里读 config.xxx
  而不是 import 时取值，所以不用改任何调用方
- 密钥只回传掩码，明文不出服务端；留空表示不改而非清空
- 每个 AI 服务和推送渠道都有测试按钮，真发一次请求
- 没配完时管理后台有醒目引导" \
  server/src/settings.js web/src/views/SettingsPanel.jsx

commit_batch "feat(security): 会议记录加访问口令

历史录音和纪要是所有会议内容的全文，比「能不能进会」敏感得多，
但之前对所有能访问服务的人完全开放。

- 新增 ARCHIVE_PASSWORD，覆盖会议列表、详情、文件下载、
  重新处理、推送等全部相关接口
- 管理口令同样放行
- 前端加解锁页，下载链接自动带 token
- 未设置时启动日志和管理后台都会明确警告" \
  server/src/config.js

commit_batch "chore: 配置与文档

- .env.example 补充推送渠道和房间安全相关配置
- README 补充主持人、推送、虚拟背景三节及验证记录
- .gitignore 增加 Electron 产物和模型目录" \
  .env.example README.md .gitignore server/src/config.js server/src/index.js \
  server/src/pipeline.js server/src/recording.js server/package.json

# 兜底：还有没提交的零散改动
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "chore: 其它零散改动"
  echo "  ✓ chore: 其它零散改动"
fi

echo ""
echo "--- 本地提交历史 ---"
git log --oneline | head -10
echo ""

read -p "推送到 GitHub？[Y/n] " ans
case "$ans" in
  [nN]) echo "已跳过推送。想推时执行：git push origin main"; exit 0;;
esac

echo ""
if git push origin main 2>&1 | tee /tmp/im-push.log; then
  :
fi

# 远端有本地没有的提交时 git 会拒绝推送。
# 最常见的原因是建仓库时勾了「Add a README」，GitHub 自动生成了一个初始提交。
if grep -q "rejected\|fetch first\|non-fast-forward" /tmp/im-push.log; then
  echo ""
  echo "--- 推送被拒绝：远端有本地没有的提交 ---"
  git fetch origin --quiet 2>/dev/null || true
  echo ""
  echo "远端现有的提交："
  git log --oneline origin/main 2>/dev/null | head -10 || echo "  （读不到，可能是新仓库）"
  echo ""
  echo "如果上面只有 GitHub 自动生成的 Initial commit，覆盖掉就行。"
  echo "如果里面有你自己的东西，先选 n，手动处理。"
  echo ""
  read -p "用本地内容覆盖远端？[y/N] " force
  case "$force" in
    [yY])
      git push -f origin main
      echo ""
      echo "已覆盖推送完成。"
      ;;
    *)
      echo ""
      echo "已取消。想手动合并远端内容："
      echo "  git pull --rebase origin main --allow-unrelated-histories"
      echo "  # 有冲突就改完 git add，然后 git rebase --continue"
      echo "  git push origin main"
      exit 1
      ;;
  esac
fi

echo ""
echo "=================================================="
echo "  完成：https://github.com/SSSSKRXX/InsideMeeting"
echo "=================================================="
