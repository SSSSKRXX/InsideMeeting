#!/usr/bin/env bash
# 双击本文件即可推送到 GitHub。
# 如果双击没反应，先在终端执行一次：chmod +x "推送到GitHub.command"
set -e
cd "$(dirname "$0")"

REPO="https://github.com/SSSSKRXX/InsideMeeting.git"
REPO_SSH="git@github.com:SSSSKRXX/InsideMeeting.git"

echo "=================================================="
echo "  推送 InsideMeeting 到 GitHub"
echo "  目标：$REPO"
echo "=================================================="
echo ""

# ---------- 先确认认证方式 ----------
# GitHub 从 2021 年起不再支持账号密码推送，必须用 token / SSH / gh CLI
USE_SSH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "认证方式：GitHub CLI（已登录）"
elif ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  echo "认证方式：SSH 密钥（已配置）"
  USE_SSH=1
elif git config --get credential.helper >/dev/null 2>&1 && \
     security find-internet-password -s github.com >/dev/null 2>&1; then
  echo "认证方式：钥匙串里已有 GitHub 凭证"
else
  echo "!! 还没有配置 GitHub 认证 !!"
  echo ""
  echo "GitHub 不支持用账号密码推送。三选一："
  echo ""
  echo "  【推荐】GitHub CLI —— 浏览器点两下就好"
  echo "      brew install gh"
  echo "      gh auth login"
  echo "      选：GitHub.com → HTTPS → Yes → Login with a web browser"
  echo ""
  echo "  【备选】Personal Access Token"
  echo "      1. 打开 https://github.com/settings/tokens/new"
  echo "      2. Note 随便填，Expiration 选 No expiration"
  echo "      3. 只勾选 repo 这一项，拉到底点 Generate token"
  echo "      4. 复制那串 ghp_ 开头的字符"
  echo "      5. 重跑本脚本，用户名填 SSSSKRXX，密码粘贴那串 token"
  echo ""
  echo "  【备选】SSH 密钥"
  echo "      ssh-keygen -t ed25519 -C \"burger.old8@gmail.com\""
  echo "      pbcopy < ~/.ssh/id_ed25519.pub"
  echo "      然后到 https://github.com/settings/keys 点 New SSH key 粘贴"
  echo ""
  read -p "已经配好了想继续试试？直接回车继续，Ctrl+C 退出 " _
  echo ""
fi

# 清掉之前可能残留的半成品仓库
if [ -d .git ]; then
  echo "检测到已有 .git 目录。"
  read -p "是否重新初始化？已有的提交历史会丢失。[y/N] " ans
  case "$ans" in
    [yY]) rm -rf .git; echo "已清除。";;
    *) echo "保留现有仓库，继续。";;
  esac
  echo ""
fi

TARGET="$REPO"
[ "$USE_SSH" = "1" ] && TARGET="$REPO_SSH"

if [ ! -d .git ]; then
  git init -b main
  git remote add origin "$TARGET"
else
  git remote set-url origin "$TARGET" 2>/dev/null || git remote add origin "$TARGET"
fi

# 上传前再确认一遍敏感文件没被带上
echo "--- 安全检查 ---"
for f in .env server/.env certs data; do
  if git check-ignore -q "$f" 2>/dev/null; then
    echo "  已忽略：$f"
  elif [ -e "$f" ]; then
    echo "  警告：$f 存在但未被忽略，请检查 .gitignore！"
    exit 1
  fi
done
echo ""

git add -A
echo "--- 本次提交的文件 ---"
git status --short
echo ""

git commit -m "feat: 内部会议系统 - P2P 视频会议、分轨录制、实时与会后 LLM 会议纪要

- WebRTC mesh 视频会议（2-8 人），媒体不经过服务器
- 屏幕共享，画面自动切到共享者；画廊/演讲者/自动三种布局
- 分轨录制：每人麦克风独立成轨，不限时长，每 60 分钟切分
- 会中实时纪要：15 秒小片转写，每分钟刷新结构化摘要
- 会后完整纪要：静音检测 + 分轨转写 + 时间轴合并 + LLM 生成
- 发言人归属基于音轨分离，准确率 100%
- Tailscale 组网，支持 macOS / Windows / Linux 部署
- 手机端适配，含团队使用说明 PDF" || echo "（没有新变更需要提交）"

echo ""
echo "--- 正在推送 ---"
git branch -M main
git push -u origin main

echo ""
echo "=================================================="
echo "  完成！打开看看："
echo "  https://github.com/SSSSKRXX/InsideMeeting"
echo "=================================================="
