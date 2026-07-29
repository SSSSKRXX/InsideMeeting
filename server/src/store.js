import fs from 'node:fs';
import path from 'node:path';
import { recordingsRoot, minutesRoot } from './storage.js';

/**
 * 极简 JSON 文件存储。会议数量级很小（每天几十场），
 * 不引入需要本地编译的原生数据库依赖，Mac mini 上零门槛。
 */

function metaPath(meetingId) {
  return path.join(recordingsRoot(), meetingId, 'manifest.json');
}

/** 录制文件（音视频 + manifest）所在目录 */
export function meetingDir(meetingId) {
  return path.join(recordingsRoot(), meetingId);
}

/** 纪要产物（逐字稿/纪要/待办）所在目录。没单独配就跟录制在一起。 */
export function minutesDir(meetingId) {
  return path.join(minutesRoot(), meetingId);
}

/**
 * 找一个产物文件的真实位置。
 * 先看纪要目录，再回退到录制目录 —— 后者是为了兼容
 * 「分离配置之前」生成的那些会议，它们的纪要就放在录制目录里。
 */
export function resolveArtifact(meetingId, file) {
  if (!file) return null;
  for (const dir of [minutesDir(meetingId), meetingDir(meetingId)]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function ensureMeeting(meetingId, init = {}) {
  const dir = meetingDir(meetingId);
  fs.mkdirSync(dir, { recursive: true });
  const p = metaPath(meetingId);
  if (!fs.existsSync(p)) {
    const data = {
      meetingId,
      roomId: init.roomId || meetingId,
      title: init.title || '',
      startedAt: init.startedAt || Date.now(),
      endedAt: null,
      participants: {}, // peerId -> { name, joinedAt, leftAt }
      segments: [],     // { peerId, name, kind, seg, file, startedAt, endedAt, bytes }
      chat: [],
      status: 'recording',
      artifacts: {},    // transcript / summary 文件路径
    };
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return data;
  }
  return readMeeting(meetingId);
}

export function readMeeting(meetingId) {
  const p = metaPath(meetingId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const locks = new Map();

/** 串行化写入，避免多个分片上传同时改 manifest 造成丢写 */
export function updateMeeting(meetingId, mutator) {
  const prev = locks.get(meetingId) || Promise.resolve();
  const next = prev.then(async () => {
    const data = readMeeting(meetingId) || ensureMeeting(meetingId);
    const out = (await mutator(data)) || data;
    const p = metaPath(meetingId);
    fs.writeFileSync(p + '.tmp', JSON.stringify(out, null, 2));
    fs.renameSync(p + '.tmp', p);
    return out;
  });
  locks.set(meetingId, next.catch(() => {}));
  return next;
}

export function listMeetings() {
  const root = recordingsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => readMeeting(id))
    .filter(Boolean)
    .map((m) => ({
      meetingId: m.meetingId,
      roomId: m.roomId,
      title: m.title,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      status: m.status,
      participants: Object.values(m.participants || {}).map((p) => p.name),
      segmentCount: (m.segments || []).length,
      durationMs: (m.endedAt || Date.now()) - m.startedAt,
      hasSummary: Boolean(m.artifacts?.summary),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}
