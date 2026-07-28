import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';

/** 按操作系统给出对应的 ffmpeg 安装提示 */
export function installHint() {
  if (process.platform === 'win32') {
    return '请安装 ffmpeg（Windows: winget install Gyan.FFmpeg，装完重开终端；或在 .env 里把 FFMPEG_PATH 指向 ffmpeg.exe 的完整路径）';
  }
  if (process.platform === 'darwin') return '请安装 ffmpeg（macOS: brew install ffmpeg）';
  return '请安装 ffmpeg（Debian/Ubuntu: sudo apt install ffmpeg）';
}

export function run(cmd, args, { capture = 'stderr' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => reject(new Error(`无法执行 ${cmd}：${e.message}。${installHint()}`)));
    p.on('close', (code) => {
      if (code === 0) resolve(capture === 'stdout' ? out : err || out);
      else reject(new Error(`${cmd} 退出码 ${code}\n${err.slice(-4000)}`));
    });
  });
}

export async function checkFfmpeg() {
  try {
    await run(config.ffmpeg, ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** 读取时长（秒）。MediaRecorder 产出的 webm 常常没有 duration 元数据，这里用解码计数兜底。 */
export async function probeDuration(file) {
  try {
    const out = await run(
      config.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { capture: 'stdout' }
    );
    const d = parseFloat(out.trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch { /* 继续兜底 */ }

  try {
    const err = await run(config.ffmpeg, ['-i', file, '-f', 'null', '-']);
    const matches = [...err.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
    if (matches.length) {
      const [, h, m, s] = matches[matches.length - 1];
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * 用 silencedetect 找出「有人说话」的区间。
 * 分轨录音里一个人大部分时间是静音的，直接整轨送 ASR 既贵又容易产生幻听文本。
 */
export async function detectSpeechRegions(file, {
  noiseDb = -35,
  minSilence = 0.8,
  pad = 0.35,
  mergeGap = 1.2,
  minLen = 0.6,
  maxLen = 240,
} = {}) {
  const duration = await probeDuration(file);
  if (!duration) return [];

  const log = await run(config.ffmpeg, [
    '-hide_banner', '-nostats', '-i', file,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    '-f', 'null', '-',
  ]);

  const silences = [];
  let cur = null;
  for (const line of log.split('\n')) {
    const st = line.match(/silence_start:\s*(-?[\d.]+)/);
    const en = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (st) cur = { start: Math.max(0, parseFloat(st[1])) };
    if (en && cur) {
      cur.end = parseFloat(en[1]);
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) silences.push({ ...cur, end: duration });

  // 静音区间取补集 = 有声区间
  let regions = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) regions.push({ start: cursor, end: Math.min(s.start, duration) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) regions.push({ start: cursor, end: duration });

  // 整轨没有检测到任何静音 → 整轨都是有声
  if (!silences.length) regions = [{ start: 0, end: duration }];

  // 加 padding
  regions = regions.map((r) => ({
    start: Math.max(0, r.start - pad),
    end: Math.min(duration, r.end + pad),
  }));

  // 合并靠得很近的片段
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= mergeGap) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // 丢掉过短的，切开过长的
  const out = [];
  for (const r of merged) {
    if (r.end - r.start < minLen) continue;
    let s = r.start;
    while (r.end - s > maxLen) {
      out.push({ start: s, end: s + maxLen });
      s += maxLen;
    }
    out.push({ start: s, end: r.end });
  }
  return out;
}

/** 抽取一段音频为 16k 单声道 mp3（体积小、ASR 接口友好） */
export async function extractAudioClip(file, start, end, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start.toFixed(3)),
    '-t', String(Math.max(0.2, end - start).toFixed(3)),
    '-i', file,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    outFile,
  ]);
  return outFile;
}

/** webm → mp4，便于在任何播放器/剪辑软件里打开（Mac 上走硬件编码） */
export async function toMp4(input, output, { hw = process.platform === 'darwin' } = {}) {
  const videoArgs = hw
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '2500k']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24'];
  await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ]);
  return output;
}

/** 把同一场会议的所有麦克风轨混成一条完整音频（便于人工回听） */
export async function mixTracks(files, output) {
  if (!files.length) return null;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of files) args.push('-i', f);
  args.push(
    '-filter_complex',
    `${files.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${files.length}:duration=longest:normalize=0[a]`,
    '-map', '[a]', '-ac', '1', '-ar', '32000', '-b:a', '64k',
    output
  );
  await run(config.ffmpeg, args);
  return output;
}

export function tmpDir(name) {
  const d = path.join(paths.tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
