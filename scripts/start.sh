#!/usr/bin/env bash
# 一键启动：检查依赖 → 生成证书 → 构建前端 → 启动服务
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null || { echo "❌ 未安装 Node.js。macOS: brew install node"; exit 1; }
command -v ffmpeg >/dev/null || echo "⚠️  未安装 ffmpeg，会议纪要功能不可用。macOS: brew install ffmpeg"

[ -f .env ] || { cp .env.example .env; echo "📝 已生成 .env，请填入 ASR_API_KEY / LLM_API_KEY 后重新运行"; }
[ -f certs/cert.pem ] || bash scripts/gen-cert.sh
[ -d node_modules ] || npm install
[ -d web/dist ] || npm run build

exec npm start
