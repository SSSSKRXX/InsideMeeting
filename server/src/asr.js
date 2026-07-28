import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * OpenAI 兼容的语音转写接口。
 * 兼容：OpenAI / 硅基流动 / 通义 / 自建 faster-whisper-server 等，
 * 只要实现 POST {baseUrl}/audio/transcriptions 即可。
 */
export async function transcribeFile(filePath, { prompt = '', language } = {}) {
  if (!config.asr.apiKey) throw new Error('未配置 ASR_API_KEY，无法转写');

  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('model', config.asr.model);
  form.append('response_format', 'verbose_json');
  const lang = language || config.asr.language;
  if (lang && lang !== 'auto') form.append('language', lang);
  if (prompt) form.append('prompt', prompt.slice(0, 800));

  const res = await fetch(`${config.asr.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.asr.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ASR 失败 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // verbose_json 返回 segments；部分服务只返回 text，这里都兼容
  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments
      .map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || '').trim(),
        noSpeechProb: Number(s.no_speech_prob ?? 0),
      }))
      .filter((s) => s.text);
  }
  const text = String(data.text || '').trim();
  return text ? [{ start: 0, end: 0, text, noSpeechProb: 0 }] : [];
}

/** 简易并发池 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Whisper 在静音/噪音上常见的幻听输出，直接过滤
const HALLUCINATIONS = [
  '字幕由', '請不吝點贊', '请不吝点赞', '订阅转发打赏', '訂閱轉發打賞',
  '谢谢观看', '謝謝觀看', 'Thanks for watching', '感谢观看', '明镜与点点栏目',
  'Amara.org', '字幕志愿者', 'MING PAO', '中文字幕',
];

export function isLikelyHallucination(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.length <= 1) return true;
  if (HALLUCINATIONS.some((h) => t.includes(h))) return true;
  // 单一字符重复刷屏
  if (/^(.)\1{5,}$/.test(t.replace(/\s/g, ''))) return true;
  return false;
}
