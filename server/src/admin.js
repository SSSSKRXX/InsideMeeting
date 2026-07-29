import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths, ROOT } from './config.js';
import { meetingDir, listMeetings, readMeeting } from './store.js';
import { listRooms, setPassword, updateRoom, revokeHostTokens } from './roomstore.js';
import { enabledChannels } from './notify.js';
import { checkFfmpeg } from './media.js';
import { activeRooms } from './signaling.js';
import { currentPaths, recordingsRoot } from './storage.js';

/** 递归统计目录大小 */
function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
          files++;
        } catch { /* 文件可能刚被删 */ }
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

/** 配置总览。密钥一律脱敏，只显示有没有配、前后几位。 */
function mask(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export async function adminStatus() {
  const live = activeRooms();
  const store = dirSize(paths.recordings);

  return {
    service: {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      pid: process.pid,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      hostname: os.hostname(),
      loadavg: os.loadavg().map((x) => Number(x.toFixed(2))),
      ffmpeg: await checkFfmpeg(),
      startedAt: Date.now() - process.uptime() * 1000,
    },
    live: {
      rooms: live.length,
      peers: live.reduce((a, r) => a + r.peers.length, 0),
      waiting: live.reduce((a, r) => a + (r.waitingCount || 0), 0),
      detail: live.map((r) => ({
        roomId: r.roomId,
        meetingId: r.meetingId,
        startedAt: r.startedAt,
        peers: r.peers.map((p) => p.name),
        waitingCount: r.waitingCount || 0,
      })),
    },
    storage: {
      dataDir: config.dataDir,
      ...currentPaths(),
      recordingsBytes: store.bytes,
      recordingsFiles: store.files,
      meetings: listMeetings().length,
      freeBytes: (() => {
        try {
          const s = fs.statfsSync(recordingsRoot());
          return s.bavail * s.bsize;
        } catch {
          return null;
        }
      })(),
    },
    config: {
      port: config.port,
      tls: config.tls.enabled,
      networkMode: config.networkMode,
      segmentMinutes: config.recording.segmentMinutes,
      joinPassword: Boolean(config.joinPassword),
      adminToken: Boolean(config.adminToken),
      live: { ...config.live },
      asr: { baseUrl: config.asr.baseUrl, model: config.asr.model, key: mask(config.asr.apiKey), language: config.asr.language },
      llm: { baseUrl: config.llm.baseUrl, model: config.llm.model, key: mask(config.llm.apiKey) },
      notify: { ...enabledChannels(), baseUrl: config.notify.baseUrl },
      publicBaseUrl: config.notify.baseUrl,
    },
    rooms: listRooms(),
  };
}

/** 每场会议占了多少磁盘 */
export function storageBreakdown() {
  const list = listMeetings().map((m) => {
    const { bytes, files } = dirSize(meetingDir(m.meetingId));
    return { ...m, bytes, files };
  });
  list.sort((a, b) => b.bytes - a.bytes);
  return {
    total: list.reduce((a, m) => a + m.bytes, 0),
    meetings: list,
  };
}

/**
 * 清理旧录制。
 * 默认只删音视频文件，保留纪要和逐字稿 —— 这两个是文本，几乎不占空间，
 * 但删掉就再也拿不回来了。要连纪要一起删得显式指定。
 */
export function cleanup({ days = 30, dryRun = true, keepArtifacts = true } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  const result = { cutoff, freedBytes: 0, meetings: [], dryRun };

  for (const m of listMeetings()) {
    if (m.startedAt >= cutoff) continue;
    const dir = meetingDir(m.meetingId);
    const full = readMeeting(m.meetingId);
    if (!full) continue;

    const targets = [];
    for (const seg of full.segments || []) {
      const p = path.join(dir, seg.file);
      if (fs.existsSync(p)) targets.push(p);
    }
    if (!keepArtifacts) {
      for (const f of Object.values(full.artifacts || {})) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) targets.push(p);
      }
    }

    let freed = 0;
    for (const p of targets) {
      try {
        freed += fs.statSync(p).size;
        if (!dryRun) fs.rmSync(p, { force: true });
      } catch { /* 忽略 */ }
    }

    if (targets.length) {
      result.freedBytes += freed;
      result.meetings.push({
        meetingId: m.meetingId,
        startedAt: m.startedAt,
        files: targets.length,
        bytes: freed,
      });
    }
  }
  return result;
}

/** 读服务日志尾部。菜单栏程序和网页后台都用它。 */
export function tailLog(lines = 200) {
  const candidates = [
    path.join(config.dataDir, 'server.log'),
    path.join(ROOT, 'data', 'server.log'),
    process.env.LOG_FILE,
  ].filter(Boolean);

  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const stat = fs.statSync(f);
      // 只读尾部 256KB，日志再大也不会把内存打爆
      const size = Math.min(stat.size, 256 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, stat.size - size);
      fs.closeSync(fd);
      const all = buf.toString('utf8').split('\n');
      return { file: f, lines: all.slice(-lines).join('\n'), size: stat.size };
    } catch (e) {
      return { file: f, error: e.message, lines: '' };
    }
  }
  return {
    file: null,
    lines:
      '没有找到日志文件。\n\n' +
      '直接用 npm start 跑的时候日志只在终端里，不落盘。\n' +
      '想留存日志，用 launchd（deploy/com.inside.meeting.plist）或菜单栏程序启动，\n' +
      '它们会把输出写到 data/server.log。',
  };
}

export const adminRoomOps = { setPassword, updateRoom, revokeHostTokens };
