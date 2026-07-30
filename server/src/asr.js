import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * 语音转写。支持两种完全不同形态的接口：
 *
 *   openai —— POST {baseUrl}/audio/transcriptions，multipart 上传文件，
 *             Bearer 认证。OpenAI / 硅基流动 / 通义 / faster-whisper-server 都是这种。
 *   mimo   —— POST {baseUrl}/chat/completions，音频 base64 塞进 messages，
 *             api-key 头认证。小米 MiMo 的 ASR 是「多模态对话模型」而不是
 *             独立的转写接口，所以路径和请求体都不一样。
 *
 * 两者最实质的区别是 mimo 不返回时间戳。好在我们本来就把音频按静音检测
 * 切成了小片、每片的绝对起点已知，所以只是时间精度从「句级」降到「片级」。
 */
export function detectProvider() {
  const p = (config.asr.provider || 'auto').toLowerCase();
  if (p !== 'auto') return p;
  const url = config.asr.baseUrl.toLowerCase();
  const model = (config.asr.model || '').toLowerCase();
  if (url.includes('xiaomimimo') || url.includes('mimo.mi.com') || model.startsWith('mimo')) return 'mimo';
  return 'openai';
}

/** 这个服务商返不返回时间戳。不返回的话，切片要切得更细，否则时间轴会很粗。 */
export function providerHasTimestamps() {
  return detectProvider() !== 'mimo';
}

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webm': 'audio/webm' };

export async function transcribeFile(filePath, opts = {}) {
  if (!config.asr.apiKey) throw new Error('未配置转写服务密钥，无法转写');
  return detectProvider() === 'mimo' ? transcribeMimo(filePath, opts) : transcribeOpenAI(filePath, opts);
}

async function transcribeOpenAI(filePath, { prompt = '', language } = {}) {
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

/** 小米 MiMo：音频 base64 走 chat/completions */
async function transcribeMimo(filePath, { language } = {}) {
  const buf = fs.readFileSync(filePath);
  // base64 之后体积涨 1/3，官方限制 10MB，这里按原始 7MB 卡一道
  if (buf.length > 7 * 1024 * 1024) {
    throw new Error(`音频片段过大（${(buf.length / 1048576).toFixed(1)}MB），MiMo 单次上限约 7MB`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime || !['.mp3', '.wav'].includes(ext)) {
    throw new Error(`MiMo 只接受 wav 和 mp3，当前是 ${ext || '未知格式'}`);
  }

  const lang = language || config.asr.language || 'auto';

  const res = await fetch(`${config.asr.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // MiMo 用 api-key 头，不是 Bearer。两个都带上，兼容网关转发的情况。
      'api-key': config.asr.apiKey,
      Authorization: `Bearer ${config.asr.apiKey}`,
    },
    body: JSON.stringify({
      model: config.asr.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: `data:${mime};base64,${buf.toString('base64')}` },
            },
          ],
        },
      ],
      asr_options: { language: ['zh', 'en', 'auto'].includes(lang) ? lang : 'auto' },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ASR 失败 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  // 没有时间戳，整片当成一段。片段本身的绝对起点由调用方补上。
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
