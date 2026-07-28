import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { detectSpeechRegions, extractAudioClip } from './media.js';
import { transcribeFile, isLikelyHallucination } from './asr.js';
import { chat } from './llm.js';
import { updateMeeting } from './store.js';

/**
 * 会中实时纪要。
 *
 * 数据来源和「会后高质量纪要」是两条独立的链路：
 *   - 会后链路：完整音轨 → 静音检测 → 整段转写，质量优先。
 *   - 会中链路（本文件）：客户端每 15 秒单独录一个可独立解码的小片直传，
 *     服务端立刻做静音过滤 + 转写 + 推送，延迟优先。
 *
 * 两条链路互不干扰。会中说错的、识别歪的，会后那份仍然是准的。
 */

/** meetingId -> session */
const sessions = new Map();
let ioRef = null;

export function initLive(io) {
  ioRef = io;
}

function getSession(meetingId, roomId) {
  let s = sessions.get(meetingId);
  if (!s) {
    s = {
      meetingId,
      roomId,
      startedAt: Date.now(),
      utterances: [],       // { speaker, peerId, absStart, text }
      summary: '',
      summaryAt: 0,
      charsAtLastSummary: 0,
      summarizing: false,
      timer: null,
      queue: Promise.resolve(),
    };
    sessions.set(meetingId, s);
    s.timer = setInterval(() => maybeSummarize(meetingId), config.live.summarySeconds * 1000);
  }
  if (roomId) s.roomId = roomId;
  return s;
}

export function liveState(meetingId) {
  const s = sessions.get(meetingId);
  if (!s) return { utterances: [], summary: '', summaryAt: 0 };
  return {
    utterances: s.utterances.slice(-120),
    summary: s.summary,
    summaryAt: s.summaryAt,
  };
}

export function endLive(meetingId) {
  const s = sessions.get(meetingId);
  if (!s) return;
  clearInterval(s.timer);
  sessions.delete(meetingId);
}

function liveDir(meetingId) {
  const d = path.join(paths.tmp, 'live', meetingId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 接收一个实时音频小片。
 * @param {object} meta { meetingId, roomId, peerId, name, seq, startedAt, ext }
 */
export async function ingestLiveChunk(meta, buffer) {
  if (!config.live.enabled) return { skipped: 'disabled' };
  if (!config.asr.apiKey) return { skipped: 'no-asr-key' };
  if (!buffer?.length) return { skipped: 'empty' };

  const meetingId = String(meta.meetingId || '').replace(/[^\w-]/g, '');
  const peerId = String(meta.peerId || '').replace(/[^\w-]/g, '');
  if (!meetingId || !peerId) return { skipped: 'bad-meta' };

  const s = getSession(meetingId, meta.roomId);
  // 串行处理同一场会议的小片，避免瞬间打爆 ASR 配额
  s.queue = s.queue.then(() => handleChunk(s, { ...meta, meetingId, peerId }, buffer)).catch(() => {});
  return { queued: true };
}

async function handleChunk(session, meta, buffer) {
  const dir = liveDir(meta.meetingId);
  const ext = /^(webm|mp4|ogg)$/.test(meta.ext || '') ? meta.ext : 'webm';
  const raw = path.join(dir, `${meta.peerId}-${meta.seq}.${ext}`);
  const clip = path.join(dir, `${meta.peerId}-${meta.seq}.mp3`);
  fs.writeFileSync(raw, buffer);

  try {
    // 静音片直接丢掉 —— 分轨录音里绝大多数小片是没人说话的，
    // 这一步是实时链路成本可控的关键。
    const regions = await detectSpeechRegions(raw, { minSilence: 0.5, pad: 0.2, mergeGap: 2, minLen: 0.4 });
    const speechLen = regions.reduce((a, r) => a + (r.end - r.start), 0);
    if (speechLen < 0.5) return;

    const from = regions[0].start;
    const to = regions[regions.length - 1].end;
    await extractAudioClip(raw, from, to, clip);

    const segs = await transcribeFile(clip, { prompt: `会议中，发言人：${meta.name || ''}。` });
    const startedAt = Number(meta.startedAt) || Date.now();

    const fresh = segs
      .filter((x) => !isLikelyHallucination(x.text) && x.noSpeechProb < 0.7)
      .map((x) => ({
        speaker: meta.name || meta.peerId,
        peerId: meta.peerId,
        absStart: startedAt + (from + x.start) * 1000,
        text: x.text,
      }));

    if (!fresh.length) return;

    session.utterances.push(...fresh);
    session.utterances.sort((a, b) => a.absStart - b.absStart);
    if (session.utterances.length > 2000) session.utterances.splice(0, session.utterances.length - 2000);

    ioRef?.to(session.roomId).emit('live-transcript', {
      meetingId: session.meetingId,
      added: fresh.map((u) => ({
        speaker: u.speaker,
        peerId: u.peerId,
        t: u.absStart,
        text: u.text,
      })),
    });
  } finally {
    if (!config.live.keepAudio) {
      fs.rmSync(raw, { force: true });
      fs.rmSync(clip, { force: true });
    }
  }
}

const LIVE_SYSTEM = `你在为一场正在进行的会议做实时纪要。你会收到目前为止的发言记录（可能不完整，会议还没结束）。

要求：
1. 提到具体的人一律用 @姓名，姓名必须与记录中完全一致。
2. 只写记录里真实出现的内容，不要推测、不要补全没说过的话。
3. 这是进行中的会议，不要写"会议圆满结束"这类收尾话术。
4. 简洁。整体控制在 400 字以内。
5. 输出中文 Markdown，只用二级标题和无序列表。`;

const LIVE_OUTLINE = `按这个结构输出：

## 目前在聊什么
- 一到两条，说明当前议题。

## 已经明确的
- @某某 提出/确认了什么。没有就写"暂无明确结论"。

## 出现的待办
- @某某：要做什么。没有就写"暂无"。

## 分歧与待确认
- 有分歧才写，没有就整节省略。`;

async function maybeSummarize(meetingId) {
  const s = sessions.get(meetingId);
  if (!s || s.summarizing || !config.llm.apiKey) return;

  const totalChars = s.utterances.reduce((a, u) => a + u.text.length, 0);
  // 自上次摘要以来没有实质性新内容就跳过，不浪费额度
  if (totalChars - s.charsAtLastSummary < config.live.minCharsForSummary) return;

  s.summarizing = true;
  try {
    const t0 = s.utterances[0]?.absStart || s.startedAt;
    // 只把最近的内容送进去，控制 token 成本
    const recent = s.utterances.slice(-260);
    const text = recent
      .map((u) => `[${fmtOffset(u.absStart - t0)}] @${u.speaker}：${u.text}`)
      .join('\n')
      .slice(-config.llm.maxCharsPerChunk);

    const speakers = [...new Set(s.utterances.map((u) => u.speaker))];
    const summary = await chat(
      [
        { role: 'system', content: LIVE_SYSTEM },
        {
          role: 'user',
          content: `参会人：${speakers.join('、')}\n已进行：${Math.round((Date.now() - s.startedAt) / 60000)} 分钟\n\n${LIVE_OUTLINE}\n\n---- 目前的发言记录 ----\n${text}`,
        },
      ],
      { temperature: 0.2, maxTokens: 900 }
    );

    s.summary = summary;
    s.summaryAt = Date.now();
    s.charsAtLastSummary = totalChars;

    ioRef?.to(s.roomId).emit('live-summary', {
      meetingId,
      summary,
      at: s.summaryAt,
      speakers,
    });

    // 顺手落盘，万一浏览器全关了也不丢
    updateMeeting(meetingId, (m) => {
      m.liveSummary = { text: summary, at: s.summaryAt };
      return m;
    }).catch(() => {});
  } catch (e) {
    ioRef?.to(s.roomId).emit('live-error', { meetingId, error: e.message.slice(0, 200) });
  } finally {
    s.summarizing = false;
  }
}

/** 用户主动点「立即刷新摘要」 */
export async function forceSummary(meetingId) {
  const s = sessions.get(meetingId);
  if (!s) return { ok: false, error: '这场会议还没有实时记录' };
  s.charsAtLastSummary = -1e9; // 绕过增量阈值
  await maybeSummarize(meetingId);
  return { ok: true, summary: s.summary, at: s.summaryAt };
}

function fmtOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const sec = String(total % 60).padStart(2, '0');
  return `${m}:${sec}`;
}
