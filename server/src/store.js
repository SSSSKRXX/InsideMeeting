import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

/**
 * 极简 JSON 文件存储。会议数量级很小（每天几十场），
 * 不引入需要本地编译的原生数据库依赖，Mac mini 上零门槛。
 */

function metaPath(meetingId) {
  return path.join(paths.recordings, meetingId, 'manifest.json');
}

export function meetingDir(meetingId) {
  return path.join(paths.recordings, meetingId);
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
  if (!fs.existsSync(paths.recordings)) return [];
  return fs
    .readdirSync(paths.recordings)
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
