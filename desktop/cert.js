const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 自签 HTTPS 证书。
 *
 * 浏览器只在 https 或 localhost 下才允许网页访问摄像头和麦克风，
 * 所以哪怕是内网也必须有证书。源码部署时用 openssl 生成，
 * 但不能假设用户机器上有 openssl —— 所以 App 里用纯 JS 的 selfsigned 生成。
 *
 * 证书把本机所有内网 IP 都写进 SAN，这样同事用 https://100.x.x.x:8443
 * 访问时至少域名是对得上的（自签证书本身仍会有一次安全提示）。
 */

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/** 证书里记录了签发时的 IP，网络环境变了就重签，否则地址对不上 */
function needsRenew(metaPath, ips) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.expiresAt || Date.now() > meta.expiresAt - 7 * 86400_000) return true;
    const before = (meta.ips || []).slice().sort().join(',');
    return before !== ips.slice().sort().join(',');
  } catch {
    return true;
  }
}

async function ensureCert(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const metaPath = path.join(dir, 'meta.json');
  const ips = localAddresses();

  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && !needsRenew(metaPath, ips)) {
    return { certPath, keyPath, reused: true };
  }

  const selfsigned = require('selfsigned');

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const days = 3650;
  // selfsigned v2 是同步返回，v5 改成了返回 Promise。
  // 用 await Promise.resolve 包一层，两个版本都能用。
  const pems = await Promise.resolve(
    selfsigned.generate([{ name: 'commonName', value: 'InsideMeeting' }], {
      days,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'subjectAltName', altNames },
      ],
    })
  );

  if (!pems?.cert || !pems?.private) {
    throw new Error('证书生成失败：selfsigned 没有返回预期内容');
  }

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ ips, createdAt: Date.now(), expiresAt: Date.now() + days * 86400_000 }, null, 2)
  );

  return { certPath, keyPath, reused: false, ips };
}

module.exports = { ensureCert, localAddresses };
