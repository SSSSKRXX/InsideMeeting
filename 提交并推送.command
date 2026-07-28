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
git push origin main
echo ""
echo "=================================================="
echo "  完成：https://github.com/SSSSKRXX/InsideMeeting"
echo "=================================================="
