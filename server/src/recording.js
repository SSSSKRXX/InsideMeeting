import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { meetingDir, readMeeting, updateMeeting, ensureMeeting } from './store.js';

const KINDS = new Set(['mic', 'cam', 'screen', 'screenaudio']);

function safeId(v) {
  return String(v || '').replace(/[^\w-]/g, '').slice(0, 64);
}

export function segmentFileName(peerId, kind, seg, ext = 'webm') {
  return `${safeId(peerId)}__${kind}__s${String(seg).padStart(3, '0')}.${ext}`;
}

/**
 * 开启一个新的录制分段。
 * 客户端每 SEGMENT_MINUTES 分钟重启一次 MediaRecorder，
 * 因此每个分段都是一个「自带头部、可独立播放」的完整 webm 文件。
 */
export async function openSegment({ meetingId, roomId, peerId, name, kind, seg, startedAt, ext }) {
  meetingId = safeId(meetingId);
  peerId = safeId(peerId);
  if (!meetingId || !peerId || !KINDS.has(kind)) throw new Error('参数无效');

  ensureMeeting(meetingId, { roomId });
  const dir = meetingDir(meetingId);
  fs.mkdirSync(dir, { recursive: true });

  // iOS Safari 的 MediaRecorder 只能产出 mp4，这里按客户端上报的容器格式存
  const container = /^(webm|mp4|ogg)$/.test(ext || '') ? ext : 'webm';
  const file = segmentFileName(peerId, kind, seg, container);
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, Buffer.alloc(0));

  await updateMeeting(meetingId, (m) => {
    const existing = m.segments.find((s) => s.peerId === peerId && s.kind === kind && s.seg === seg);
    if (!existing) {
      m.segments.push({
        peerId,
        name: name || m.participants?.[peerId]?.name || peerId,
        kind,
        seg,
        file,
        startedAt: startedAt || Date.now(),
        endedAt: null,
        bytes: 0,
      });
    }
    if (m.startedAt > (startedAt || Date.now())) m.startedAt = startedAt;
    return m;
  });

  return { file };
}

export async function appendChunk({ meetingId, peerId, kind, seg }, buffer) {
  meetingId = safeId(meetingId);
  peerId = safeId(peerId);
  if (!meetingId || !peerId || !KINDS.has(kind)) throw new Error('参数无效');
  if (!buffer?.length) return { bytes: 0 };

  const dir = meetingDir(meetingId);
  if (!fs.existsSync(dir)) throw new Error('会议不存在');

  // 文件名从 manifest 查，而不是重新拼 —— 容器格式（webm/mp4）以开段时上报的为准
  const meta = readMeeting(meetingId);
  const rec = meta?.segments?.find((x) => x.peerId === peerId && x.kind === kind && x.seg === seg);
  const full = path.join(dir, rec?.file || segmentFileName(peerId, kind, seg));
  fs.appendFileSync(full, buffer);

  const size = fs.statSync(full).size;
  await updateMeeting(meetingId, (m) => {
    const s = m.segments.find((x) => x.peerId === peerId && x.kind === kind && x.seg === seg);
    if (s) s.bytes = size;
    return m;
  });
  return { bytes: size };
}

export async function closeSegment({ meetingId, peerId, kind, seg, endedAt }) {
  meetingId = safeId(meetingId);
  peerId = safeId(peerId);
  await updateMeeting(meetingId, (m) => {
    const s = m.segments.find((x) => x.peerId === peerId && x.kind === kind && x.seg === seg);
    if (s) s.endedAt = endedAt || Date.now();
    return m;
  });
  return { ok: true };
}

export function meetingFiles(meetingId) {
  const m = readMeeting(safeId(meetingId));
  if (!m) return [];
  const dir = meetingDir(m.meetingId);
  return (m.segments || []).map((s) => {
    const full = path.join(dir, s.file);
    const exists = fs.existsSync(full);
    return {
      ...s,
      ext: path.extname(s.file).slice(1),
      exists,
      bytes: exists ? fs.statSync(full).size : 0,
      url: `/api/meetings/${m.meetingId}/files/${encodeURIComponent(s.file)}`,
      durationHint: s.endedAt ? s.endedAt - s.startedAt : null,
    };
  });
}

export const uploadLimitBytes = config.recording.maxUploadMB * 1024 * 1024;
