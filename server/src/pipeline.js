import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { meetingDir, readMeeting, updateMeeting } from './store.js';
import { detectSpeechRegions, extractAudioClip, probeDuration, tmpDir, checkFfmpeg, installHint } from './media.js';
import { transcribeFile, mapLimit, isLikelyHallucination } from './asr.js';
import { summarizeTranscript, extractActionItems } from './llm.js';
import { pushSummary, enabledChannels } from './notify.js';

/** meetingId -> { state, progress, message, startedAt, error } */
const jobs = new Map();

export function jobStatus(meetingId) {
  return jobs.get(meetingId) || null;
}

function setJob(meetingId, patch) {
  const cur = jobs.get(meetingId) || { meetingId, state: 'idle', progress: 0, message: '' };
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  jobs.set(meetingId, next);
  return next;
}

export function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分钟` : `${min} 分钟`;
}

/**
 * 会议后处理主流程：
 *   分轨音频 → 静音检测切片 → 逐片 ASR → 按绝对时间合并成统一时间轴
 *   → 生成逐字稿 → LLM 生成带 @发言人 的会议纪要 + 待办
 */
export async function processMeeting(meetingId, { force = false, skipSummary = false } = {}) {
  const meeting = readMeeting(meetingId);
  if (!meeting) throw new Error('会议不存在');

  const running = jobs.get(meetingId);
  if (running && running.state === 'running' && !force) return running;

  setJob(meetingId, { state: 'running', progress: 0, message: '准备中', error: null, startedAt: Date.now() });

  try {
    if (!(await checkFfmpeg())) {
      throw new Error(`未找到 ffmpeg。${installHint()}`);
    }

    const dir = meetingDir(meetingId);
    const micSegs = (meeting.segments || [])
      .filter((s) => s.kind === 'mic' && fs.existsSync(path.join(dir, s.file)) && fs.statSync(path.join(dir, s.file)).size > 4096)
      .sort((a, b) => a.startedAt - b.startedAt);

    if (!micSegs.length) throw new Error('没有找到可用的音频轨，无法转写');

    const meetingStart = Math.min(meeting.startedAt, ...micSegs.map((s) => s.startedAt));
    const work = tmpDir(meetingId);

    // ---- 1. 每条音轨做静音检测，切出「有人说话」的片段 ----
    setJob(meetingId, { progress: 5, message: `检测语音区间（${micSegs.length} 条音轨）` });
    const clips = [];
    for (let i = 0; i < micSegs.length; i++) {
      const seg = micSegs[i];
      const full = path.join(dir, seg.file);
      const regions = await detectSpeechRegions(full);
      for (let r = 0; r < regions.length; r++) {
        clips.push({
          speaker: seg.name || meeting.participants?.[seg.peerId]?.name || seg.peerId,
          peerId: seg.peerId,
          source: full,
          start: regions[r].start,
          end: regions[r].end,
          // 该片段在整场会议时间轴上的绝对起点
          absStart: seg.startedAt + regions[r].start * 1000,
          out: path.join(work, `${seg.peerId}_s${seg.seg}_${String(r).padStart(4, '0')}.mp3`),
        });
      }
      setJob(meetingId, {
        progress: 5 + Math.round((15 * (i + 1)) / micSegs.length),
        message: `检测语音区间 ${i + 1}/${micSegs.length}`,
      });
    }

    if (!clips.length) throw new Error('所有音轨都没有检测到人声');

    // ---- 2. 并发转写 ----
    let done = 0;
    const results = await mapLimit(clips, config.asr.concurrency, async (clip) => {
      await extractAudioClip(clip.source, clip.start, clip.end, clip.out);
      let segs = [];
      try {
        segs = await transcribeFile(clip.out, { prompt: `会议录音，发言人：${clip.speaker}。` });
      } catch (e) {
        segs = [];
        setJob(meetingId, { message: `转写片段失败（已跳过）：${e.message.slice(0, 120)}` });
      }
      fs.rmSync(clip.out, { force: true });
      done++;
      setJob(meetingId, {
        progress: 20 + Math.round((55 * done) / clips.length),
        message: `语音转写 ${done}/${clips.length}`,
      });
      return segs
        .filter((s) => !isLikelyHallucination(s.text) && s.noSpeechProb < 0.75)
        .map((s) => ({
          speaker: clip.speaker,
          peerId: clip.peerId,
          absStart: clip.absStart + s.start * 1000,
          absEnd: clip.absStart + (s.end || s.start + 2) * 1000,
          text: s.text,
        }));
    });

    // ---- 3. 按绝对时间合并成一条时间轴 ----
    let utterances = results.flat().sort((a, b) => a.absStart - b.absStart);

    // 同一人相邻发言合并成一段，避免逐字稿过于碎
    const merged = [];
    for (const u of utterances) {
      const last = merged[merged.length - 1];
      if (last && last.peerId === u.peerId && u.absStart - last.absEnd < 8000) {
        last.text += (/[。！？.!?]$/.test(last.text) ? '' : '') + u.text;
        last.absEnd = Math.max(last.absEnd, u.absEnd);
      } else {
        merged.push({ ...u });
      }
    }
    utterances = merged;

    if (!utterances.length) {
      throw new Error('转写没有返回任何内容。请检查 ASR_API_KEY / ASR_BASE_URL 是否正确，以及录音里是否真的有人说话。');
    }

    setJob(meetingId, { progress: 78, message: '生成逐字稿' });

    const speakers = [...new Set(utterances.map((u) => u.speaker))];
    const endAt = meeting.endedAt || Math.max(...micSegs.map((s) => s.endedAt || s.startedAt));
    const durationMs = endAt - meetingStart;
    const dateText = new Date(meetingStart).toLocaleString('zh-CN', { hour12: false });

    const transcriptText = utterances
      .map((u) => `[${fmtTime(u.absStart - meetingStart)}] @${u.speaker}：${u.text}`)
      .join('\n');

    const transcriptMd = [
      `# 会议逐字稿`,
      ``,
      `- 会议：${meeting.title || meeting.roomId}`,
      `- 时间：${dateText}`,
      `- 时长：${fmtDuration(durationMs)}`,
      `- 参会人：${speakers.map((s) => `@${s}`).join('、')}`,
      `- 说明：按音轨分离，发言人归属由录音来源直接确定（非声纹聚类）。`,
      ``,
      `---`,
      ``,
      transcriptText,
      ``,
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'transcript.md'), transcriptMd);
    fs.writeFileSync(
      path.join(dir, 'transcript.json'),
      JSON.stringify(
        {
          meetingId,
          startedAt: meetingStart,
          durationMs,
          speakers,
          utterances: utterances.map((u) => ({
            speaker: u.speaker,
            peerId: u.peerId,
            offsetMs: u.absStart - meetingStart,
            time: fmtTime(u.absStart - meetingStart),
            text: u.text,
          })),
        },
        null,
        2
      )
    );

    const artifacts = { transcript: 'transcript.md', transcriptJson: 'transcript.json' };

    // ---- 4. LLM 生成纪要 ----
    if (!skipSummary && config.llm.apiKey) {
      setJob(meetingId, { progress: 82, message: '生成会议纪要' });
      const summary = await summarizeTranscript(transcriptText, {
        title: meeting.title || meeting.roomId,
        dateText,
        durationText: fmtDuration(durationMs),
        speakers,
      });
      fs.writeFileSync(path.join(dir, 'summary.md'), summary + '\n');
      artifacts.summary = 'summary.md';

      setJob(meetingId, { progress: 93, message: '抽取待办事项' });
      try {
        const actions = await extractActionItems(transcriptText);
        fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(actions, null, 2));
        artifacts.actions = 'actions.json';
      } catch { /* 待办抽取失败不影响主流程 */ }
    }

    // ---- 5. 统计发言占比 ----
    const stats = {};
    for (const u of utterances) {
      const s = (stats[u.speaker] ||= { speaker: u.speaker, talkMs: 0, chars: 0, turns: 0 });
      s.talkMs += Math.max(0, u.absEnd - u.absStart);
      s.chars += u.text.length;
      s.turns += 1;
    }

    await updateMeeting(meetingId, (m) => {
      m.artifacts = { ...(m.artifacts || {}), ...artifacts };
      m.stats = Object.values(stats).sort((a, b) => b.talkMs - a.talkMs);
      m.processedAt = Date.now();
      m.status = 'processed';
      if (!m.endedAt) m.endedAt = endAt;
      return m;
    });

    fs.rmSync(work, { recursive: true, force: true });

    // ---- 6. 自动推送 ----
    if (artifacts.summary && Object.values(enabledChannels()).some(Boolean)) {
      setJob(meetingId, { progress: 97, message: '推送纪要' });
      try {
        const r = await pushSummary(meetingId);
        await updateMeeting(meetingId, (m) => {
          m.notified = { at: Date.now(), sent: r.sent, failed: r.failed?.map((f) => f.channel) || [] };
          return m;
        });
        if (r.failed?.length) {
          setJob(meetingId, { message: `已完成，但推送失败：${r.failed.map((f) => f.channel).join('、')}` });
        }
      } catch (e) {
        // 推送失败不能让整个流程算失败 —— 纪要本身已经生成好了
        setJob(meetingId, { message: `已完成，推送失败：${e.message.slice(0, 100)}` });
      }
    }

    return setJob(meetingId, { state: 'done', progress: 100, message: '完成' });
  } catch (e) {
    return setJob(meetingId, { state: 'error', message: e.message, error: e.message });
  }
}

/** 只重跑纪要（逐字稿已存在时省钱省时） */
export async function resummarize(meetingId) {
  const dir = meetingDir(meetingId);
  const tp = path.join(dir, 'transcript.json');
  if (!fs.existsSync(tp)) throw new Error('尚无逐字稿，请先运行完整处理');
  const t = JSON.parse(fs.readFileSync(tp, 'utf8'));
  const text = t.utterances.map((u) => `[${u.time}] @${u.speaker}：${u.text}`).join('\n');
  setJob(meetingId, { state: 'running', progress: 50, message: '重新生成纪要' });
  const summary = await summarizeTranscript(text, {
    speakers: t.speakers,
    durationText: fmtDuration(t.durationMs),
    dateText: new Date(t.startedAt).toLocaleString('zh-CN', { hour12: false }),
  });
  fs.writeFileSync(path.join(dir, 'summary.md'), summary + '\n');
  await updateMeeting(meetingId, (m) => {
    m.artifacts = { ...(m.artifacts || {}), summary: 'summary.md' };
    return m;
  });
  return setJob(meetingId, { state: 'done', progress: 100, message: '完成' });
}

export { probeDuration };
