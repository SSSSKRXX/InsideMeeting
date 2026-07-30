import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

/**
 * 虚拟背景模型的服务端下载。
 *
 * 之前只在浏览器端拉模型，失败了就只能提示用户去跑命令行脚本 —— 对
 * 「装个 App 就想用」的人来说等于没有。改成服务端下载并托管：
 * 服务器下一次，所有参会者都从局域网拿，又快又不依赖每个人的网络。
 *
 * 模型主仓在 Google，国内基本不通，所以每个文件都准备多个镜像依次尝试。
 */

const FILES = [
  {
    name: 'selfie_segmenter.tflite',
    required: true,
    label: '人像分割模型',
    urls: [
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
      // jsdelivr 的几个入口，国内通常可达
      'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.tflite',
      'https://fastly.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.tflite',
      'https://gcore.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.tflite',
      'https://unpkg.com/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.tflite',
    ],
  },
  ...['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'].map(
    (f) => ({
      name: `wasm/${f}`,
      required: f.startsWith('vision_wasm_internal'),
      label: `运行时 ${f}`,
      urls: [
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/${f}`,
        `https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/${f}`,
        `https://gcore.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/${f}`,
        `https://registry.npmmirror.com/@mediapipe/tasks-vision/0.10.14/files/wasm/${f}`,
        `https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm/${f}`,
      ],
    })
  ),
];

let job = null;

export function modelStatus() {
  const root = paths.models;
  const files = FILES.map((f) => {
    const p = path.join(root, f.name);
    const exists = fs.existsSync(p);
    return {
      name: f.name,
      label: f.label,
      required: f.required,
      exists,
      bytes: exists ? fs.statSync(p).size : 0,
    };
  });
  return {
    dir: root,
    ready: files.filter((f) => f.required).every((f) => f.exists && f.bytes > 1000),
    files,
    job,
  };
}

async function downloadOne(target, urls, onLog) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const errors = [];

  for (const url of urls) {
    const host = new URL(url).host;
    try {
      onLog(`  尝试 ${host} …`);
      const res = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: 'follow' });
      if (!res.ok) {
        errors.push(`${host}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // 有些镜像挂了会返回一个 HTML 错误页，按体积和开头粗筛一下
      if (buf.length < 1000 || buf.slice(0, 20).toString().toLowerCase().includes('<!doctype')) {
        errors.push(`${host}: 返回的不是有效文件`);
        continue;
      }
      fs.writeFileSync(target, buf);
      onLog(`  ✓ 来自 ${host}，${(buf.length / 1048576).toFixed(1)} MB`);
      return { ok: true, from: host, bytes: buf.length };
    } catch (e) {
      errors.push(`${host}: ${String(e.message).slice(0, 60)}`);
    }
  }
  return { ok: false, errors };
}

/** 下载全部模型。同一时间只允许跑一个。 */
export async function downloadModels() {
  if (job?.state === 'running') return job;

  const log = [];
  const onLog = (line) => {
    log.push(line);
    if (log.length > 200) log.shift();
  };

  job = { state: 'running', log, startedAt: Date.now(), done: 0, total: FILES.length };

  try {
    for (const f of FILES) {
      const target = path.join(paths.models, f.name);
      if (fs.existsSync(target) && fs.statSync(target).size > 1000) {
        onLog(`${f.label}：已存在，跳过`);
        job.done++;
        continue;
      }
      onLog(`${f.label}：下载中`);
      const r = await downloadOne(target, f.urls, onLog);
      if (!r.ok) {
        onLog(`  ✗ 全部镜像都失败：${r.errors.join('；')}`);
        if (f.required) {
          job = {
            ...job,
            state: 'error',
            error: `${f.label} 下载失败。所有镜像都不可达，可能是服务器无法访问外网。`,
            log,
          };
          return job;
        }
      }
      job.done++;
    }

    const st = modelStatus();
    job = { ...job, state: st.ready ? 'done' : 'error', log, error: st.ready ? null : '下载完成但文件校验未通过' };
    return job;
  } catch (e) {
    job = { ...job, state: 'error', error: e.message, log };
    return job;
  }
}

export function modelJob() {
  return job;
}
