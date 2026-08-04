#!/usr/bin/env node
/**
 * 打包前的准备：把服务端源码和前端产物复制进 desktop/bundled/。
 *
 * 为什么要复制而不是引用上级目录：electron-builder 只打包 App 目录内的东西。
 * 目录结构刻意保持成 bundled/server/src 和 bundled/web/dist，
 * 因为服务端的 config.js 是按 `server/src/../..` 推算项目根目录的，
 * 保持同样的相对层级就不用改服务端一行代码。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const OUT = path.join(APP, 'bundled');

function copy(from, to) {
  if (!fs.existsSync(from)) {
    console.error(`✗ 找不到 ${from}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return from;
}

console.log('准备打包内容…');
fs.rmSync(OUT, { recursive: true, force: true });

// ---- 图标 ----
// package.json 的 build.files 里写了 "assets/**"，mac/win 的 icon 也指向
// assets/icon.png，但 desktop/ 下**从来就没有 assets 目录** —— 图标只存在于
// 仓库根的 tray/assets。结果打出来的包里 assets 是空的，
// main.js 里 new Tray(空图) 在 Windows 上直接抛异常，
// 把 app.whenReady() 回调打断在 refreshTray() 那一行，
// 后面的 buildMenu()、服务自动启动全都不执行。
// 这里在打包前把图标补齐。
const iconSrc = path.join(ROOT, 'tray', 'assets');
const iconDst = path.join(APP, 'assets');
if (fs.existsSync(iconSrc)) {
  fs.mkdirSync(iconDst, { recursive: true });
  fs.cpSync(iconSrc, iconDst, { recursive: true });
  console.log('  ✓ 托盘与应用图标');
} else {
  console.warn('  ! 没找到 tray/assets，托盘图标会退回内置兜底图');
}

copy(path.join(ROOT, 'server', 'src'), path.join(OUT, 'server', 'src'));

// 关键：服务端用的是 ES 模块，Node 靠最近的 package.json 里的 "type": "module" 判断。
// 只复制 src 的话，Node 会一路向上找到 App 自己的 package.json（没有 type 字段），
// 于是按 CommonJS 解析，遇到 import 立刻语法错误退出。开发环境不会暴露这个问题，
// 因为那里 server/package.json 就在旁边。
fs.writeFileSync(
  path.join(OUT, 'server', 'package.json'),
  JSON.stringify({ name: 'inside-meeting-server-bundled', private: true, type: 'module' }, null, 2)
);
console.log('  ✓ 服务端源码（含 type: module 声明）');

const dist = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(dist)) {
  console.error('');
  console.error('✗ 前端还没构建。先在项目根目录执行：');
  console.error('    npm install && npm run build');
  console.error('');
  process.exit(1);
}
copy(dist, path.join(OUT, 'web', 'dist'));
console.log('  ✓ 前端产物');

// 模型是可选的，有就一起带上，虚拟背景就能离线用
const models = path.join(ROOT, 'web', 'public', 'models');
if (fs.existsSync(models)) {
  copy(models, path.join(OUT, 'web', 'dist', 'models'));
  console.log('  ✓ 虚拟背景模型');
} else {
  console.log('  - 虚拟背景模型（未下载，App 内会回退到在线加载）');
}

const size = (d) => {
  let total = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.statSync(f).size;
    }
  };
  walk(d);
  return (total / 1048576).toFixed(1);
};
console.log(`完成，bundled/ 共 ${size(OUT)} MB`);
