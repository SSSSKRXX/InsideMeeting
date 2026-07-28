#!/usr/bin/env bash
# 把虚拟背景需要的模型和 wasm 下载到本地，让浏览器从自己的服务器加载。
#
# 为什么要这一步：默认会从 Google 的模型仓库和 jsdelivr 拉，
# 国内网络这两个地址都不一定通。预先下载到本地就彻底不依赖外网了。
#
# 用法：bash scripts/fetch-models.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEST="web/public/models"
mkdir -p "$DEST/wasm"

MODEL_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite"
WASM_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"

dl() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then
    echo "  已存在，跳过：$(basename "$out")"
    return 0
  fi
  echo "  下载：$(basename "$out")"
  if command -v curl >/dev/null; then
    curl -fsSL --retry 2 "$url" -o "$out" || { echo "    ✗ 失败：$url"; return 1; }
  else
    wget -q "$url" -O "$out" || { echo "    ✗ 失败：$url"; return 1; }
  fi
}

echo "下载人像分割模型…"
dl "$MODEL_URL" "$DEST/selfie_segmenter.tflite" || cat <<'TIP'

    模型下载失败。可以手动下载后放到 web/public/models/selfie_segmenter.tflite：
    https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

    实在下不到就别管，前端会自动回退到在线加载，只是第一次开虚拟背景会慢一点。

TIP

echo ""
echo "下载 MediaPipe wasm 运行时…"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  dl "$WASM_BASE/$f" "$DEST/wasm/$f" || true
done

echo ""
echo "完成。文件在 $DEST/"
ls -lh "$DEST" "$DEST/wasm" 2>/dev/null | grep -v '^total' || true
echo ""
echo "记得重新构建前端：npm run build"
