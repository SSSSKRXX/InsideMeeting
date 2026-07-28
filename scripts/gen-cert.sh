#!/usr/bin/env bash
# 生成自签 HTTPS 证书。
# 浏览器只在 https 或 localhost 下才允许访问摄像头/麦克风/屏幕共享，
# 所以局域网访问必须有证书。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$DIR/certs"
mkdir -p "$CERT_DIR"

# 如果装了 Tailscale，优先用它签发的真证书 —— 浏览器完全不会报警告。
if command -v tailscale >/dev/null 2>&1; then
  TS_NAME=$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
  if [ -n "${TS_NAME:-}" ]; then
    echo "检测到 Tailscale 域名：$TS_NAME"
    echo "正在申请 Let's Encrypt 证书（需要在 Tailscale 后台开启 HTTPS Certificates）…"
    if tailscale cert --cert-file "$CERT_DIR/cert.pem" --key-file "$CERT_DIR/key.pem" "$TS_NAME" 2>/dev/null; then
      chmod 600 "$CERT_DIR/key.pem"
      echo ""
      echo "✅ 已获取受信任的正式证书，浏览器不会有任何安全警告。"
      echo "   访问地址：https://$TS_NAME:8443"
      echo ""
      echo "   注意：证书 90 天过期，建议加一条 crontab 自动续期："
      echo "   0 4 1 * * cd $DIR && bash scripts/gen-cert.sh && launchctl kickstart -k gui/\$(id -u)/com.inside.meeting"
      exit 0
    fi
    echo "⚠️  tailscale cert 失败，回退到自签证书。"
    echo "   （需要在 Tailscale 管理后台 DNS 页面启用 MagicDNS 和 HTTPS Certificates）"
    echo ""
  fi
fi

# 收集本机所有局域网 IP，一并写进证书的 SAN
IPS=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' || true)
if [ -z "$IPS" ]; then
  IPS=$(hostname -I 2>/dev/null || true)
fi

SAN="DNS:localhost,IP:127.0.0.1"
i=0
for ip in $IPS; do
  SAN="$SAN,IP:$ip"
  i=$((i+1))
done

# 允许额外传入域名：bash scripts/gen-cert.sh meet.company.com
for extra in "$@"; do
  SAN="$SAN,DNS:$extra"
done

echo "证书 SAN: $SAN"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 3650 \
  -subj "/C=CN/O=InsideMeeting/CN=InsideMeeting" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=CA:TRUE" 2>/dev/null

chmod 600 "$CERT_DIR/key.pem"

cat <<EOF

✅ 证书已生成：
   $CERT_DIR/cert.pem
   $CERT_DIR/key.pem

首次访问浏览器会提示"不安全"，这是自签证书的正常现象：
  · Chrome：点「高级」→「继续前往」。
  · 想彻底去掉警告：把 cert.pem 导入系统信任列表。
    macOS：双击 cert.pem → 钥匙串「系统」→ 找到 InsideMeeting → 信任 → 始终信任
    Windows：双击 cert.pem → 安装证书 → 本地计算机 → 受信任的根证书颁发机构

EOF
