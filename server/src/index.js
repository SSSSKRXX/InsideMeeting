import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config, ROOT, iceServers } from './config.js';
import { attachSignaling, activeRooms } from './signaling.js';
import { openSegment, appendChunk, closeSegment, meetingFiles, uploadLimitBytes } from './recording.js';
import { listMeetings, readMeeting, updateMeeting, meetingDir, minutesDir, resolveArtifact } from './store.js';
import { processMeeting, resummarize, jobStatus } from './pipeline.js';
import { checkFfmpeg } from './media.js';
import { initLive, ingestLiveChunk, liveState, forceSummary } from './live.js';
import { pushSummary, enabledChannels } from './notify.js';
import { publicSettings, listRooms } from './roomstore.js';
import { adminStatus, storageBreakdown, cleanup, tailLog, adminRoomOps } from './admin.js';
import { currentPaths, setPaths, validateDir, suggestLocations } from './storage.js';
import { readableSettings, saveSettings, resetSetting, applySettings, testAsr, testLlm, testNotify } from './settings.js';

// 界面上保存的设置覆盖 .env，启动时先应用一次
applySettings();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const safeId = (v) => String(v || '').replace(/[^\w-]/g, '');

function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const t = req.get('x-admin-token') || req.query.token;
  if (t === config.adminToken) return next();
  res.status(401).json({ error: '需要管理口令' });
}

/**
 * 会议记录（历史录音、逐字稿、纪要）的访问控制。
 *
 * 这些内容比「能不能进会」敏感得多：进会只能听到当下，
 * 而历史记录是所有会议内容的全文。默认没有口令是为了开箱即用，
 * 但管理后台会明确提示这个风险。管理口令同样放行。
 */
function requireArchive(req, res, next) {
  if (!config.archivePassword) return next();
  const t = req.get('x-archive-token') || req.query.token;
  if (t === config.archivePassword) return next();
  if (config.adminToken && t === config.adminToken) return next();
  res.status(401).json({ error: '需要查看会议记录的口令', reason: 'archive-password' });
}

// ---------------- 基础 ----------------

app.get('/api/config', (req, res) => {
  res.json({
    iceServers: iceServers(),
    needPassword: Boolean(config.joinPassword),
    settings: {
      segmentMinutes: config.recording.segmentMinutes,
      chunkSeconds: config.recording.chunkSeconds,
      recordVideoDefault: config.recording.recordVideoDefault,
    },
    networkMode: config.networkMode,
    live: {
      enabled: config.live.enabled && Boolean(config.asr.apiKey),
      chunkSeconds: config.live.chunkSeconds,
      summarySeconds: config.live.summarySeconds,
    },
    features: {
      asr: Boolean(config.asr.apiKey),
      llm: Boolean(config.llm.apiKey),
      screenShare: true,
      notify: enabledChannels(),
    },
    archive: { needPassword: Boolean(config.archivePassword) },
    // 一项关键配置都没有时，前端会显示「还没配置完」的引导
    setupDone: Boolean(config.asr.apiKey && config.llm.apiKey),
  });
});

// 入会前查询房间是否需要密码、是否有等候室
app.get('/api/rooms/:roomId/settings', (req, res) => {
  const id = String(req.params.roomId || '').replace(/[^\w一-龥-]/g, '').slice(0, 40);
  if (!id) return res.status(400).json({ error: '房间号无效' });
  res.json(publicSettings(id));
});

app.get('/api/rooms-config', requireAdmin, (req, res) => res.json(listRooms()));

// ---------------- 管理后台 ----------------

// 探测：前端用它判断口令对不对，以及服务端有没有开启口令校验
app.get('/api/admin/ping', requireAdmin, (req, res) =>
  res.json({ ok: true, tokenRequired: Boolean(config.adminToken) })
);

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  try {
    res.json(await adminStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/storage', requireAdmin, (req, res) => res.json(storageBreakdown()));

app.get('/api/admin/logs', requireAdmin, (req, res) =>
  res.json(tailLog(Math.min(2000, Number(req.query.lines) || 200)))
);

app.post('/api/admin/cleanup', requireAdmin, (req, res) => {
  const days = Math.max(1, Number(req.body?.days) || 30);
  res.json(
    cleanup({
      days,
      dryRun: req.body?.dryRun !== false, // 默认只预演，必须显式传 false 才真删
      keepArtifacts: req.body?.keepArtifacts !== false,
    })
  );
});

app.post('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
  const id = String(req.params.roomId || '').replace(/[^\w一-龥-]/g, '').slice(0, 40);
  if (!id) return res.status(400).json({ error: '房间号无效' });
  if ('password' in (req.body || {})) adminRoomOps.setPassword(id, req.body.password);
  if (req.body?.revokeHost) adminRoomOps.revokeHostTokens(id);
  const s = adminRoomOps.updateRoom(id, req.body || {});
  res.json(s);
});

// 存储位置：查看 / 候选位置 / 校验 / 修改
app.get('/api/admin/paths', requireAdmin, (req, res) =>
  res.json({ ...currentPaths(), suggestions: suggestLocations() })
);

app.post('/api/admin/paths/validate', requireAdmin, async (req, res) =>
  res.json(await validateDir(String(req.body?.dir || '')))
);

app.post('/api/admin/paths', requireAdmin, async (req, res) => {
  try {
    const r = await setPaths({
      recordings: typeof req.body?.recordings === 'string' ? req.body.recordings.trim() : undefined,
      minutes: typeof req.body?.minutes === 'string' ? req.body.minutes.trim() : undefined,
      migrate: Boolean(req.body?.migrate),
    });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 设置：读取 / 保存 / 恢复默认 / 连通性测试
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(readableSettings()));

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const r = saveSettings(req.body || {});
    res.json({ ...r, settings: readableSettings() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/settings/reset', requireAdmin, (req, res) =>
  res.json(resetSetting(String(req.body?.key || '')))
);

app.post('/api/admin/settings/test', requireAdmin, async (req, res) => {
  const what = String(req.body?.what || '');
  try {
    if (what === 'asr') return res.json(await testAsr());
    if (what === 'llm') return res.json(await testLlm());
    if (['wecom', 'feishu', 'email'].includes(what)) return res.json(await testNotify(what));
    res.status(400).json({ ok: false, error: '不认识的测试项' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, ffmpeg: await checkFfmpeg(), rooms: activeRooms().length, uptime: process.uptime() });
});

app.get('/api/rooms', (req, res) => res.json(activeRooms()));

// ---------------- 录制上传 ----------------

app.post('/api/rec/segment', async (req, res) => {
  try {
    res.json(await openSegment(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post(
  '/api/rec/chunk',
  express.raw({ type: '*/*', limit: uploadLimitBytes }),
  async (req, res) => {
    try {
      const out = await appendChunk(
        {
          meetingId: req.get('x-meeting'),
          peerId: req.get('x-peer'),
          kind: req.get('x-kind'),
          seg: Number(req.get('x-seg') || 0),
        },
        req.body
      );
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
);

// ---------------- 会中实时纪要 ----------------

app.post(
  '/api/live/chunk',
  express.raw({ type: '*/*', limit: uploadLimitBytes }),
  async (req, res) => {
    try {
      const out = await ingestLiveChunk(
        {
          meetingId: req.get('x-meeting'),
          roomId: req.get('x-room'),
          peerId: req.get('x-peer'),
          name: decodeURIComponent(req.get('x-name') || ''),
          seq: Number(req.get('x-seq') || 0),
          startedAt: Number(req.get('x-started') || Date.now()),
          ext: req.get('x-ext') || 'webm',
        },
        req.body
      );
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
);

app.get('/api/live/:meetingId', (req, res) => res.json(liveState(safeId(req.params.meetingId))));

app.post('/api/live/:meetingId/summarize', async (req, res) => {
  res.json(await forceSummary(safeId(req.params.meetingId)));
});

app.post('/api/rec/segment-end', async (req, res) => {
  try {
    res.json(await closeSegment(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- 会议与产物 ----------------

app.get('/api/meetings', requireArchive, (req, res) => res.json(listMeetings()));

app.get('/api/meetings/:id', requireArchive, (req, res) => {
  const id = safeId(req.params.id);
  const m = readMeeting(id);
  if (!m) return res.status(404).json({ error: '会议不存在' });
  const dir = meetingDir(id);
  const readIf = (f) => {
    const p = resolveArtifact(id, f);
    return p ? fs.readFileSync(p, 'utf8') : null;
  };
  res.json({
    ...m,
    files: meetingFiles(id),
    job: jobStatus(id),
    summary: m.artifacts?.summary ? readIf(m.artifacts.summary) : null,
    transcript: m.artifacts?.transcript ? readIf(m.artifacts.transcript) : null,
    actions: m.artifacts?.actions ? JSON.parse(readIf(m.artifacts.actions) || '[]') : null,
  });
});

app.patch('/api/meetings/:id', requireArchive, async (req, res) => {
  const id = safeId(req.params.id);
  if (!readMeeting(id)) return res.status(404).json({ error: '会议不存在' });
  const m = await updateMeeting(id, (data) => {
    if (typeof req.body?.title === 'string') data.title = req.body.title.slice(0, 120);
    if (req.body?.participantNames && typeof req.body.participantNames === 'object') {
      // 支持事后修正说话人姓名
      for (const [peerId, name] of Object.entries(req.body.participantNames)) {
        if (data.participants[peerId]) data.participants[peerId].name = String(name).slice(0, 24);
        for (const s of data.segments) if (s.peerId === peerId) s.name = String(name).slice(0, 24);
      }
    }
    return data;
  });
  res.json({ ok: true, meeting: { meetingId: m.meetingId, title: m.title } });
});

// 录制文件下载 / 拖动播放（支持 Range）
app.get('/api/meetings/:id/files/:file', requireArchive, (req, res) => {
  const id = safeId(req.params.id);
  const file = path.basename(req.params.file);
  // 录制文件在录制目录，纪要产物可能在纪要目录，两边都找
  const full = [path.join(meetingDir(id), file), path.join(minutesDir(id), file)].find((p) => fs.existsSync(p));
  if (!full) return res.status(404).end();
  const ext = path.extname(file).toLowerCase();
  const type =
    { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' }[ext] ||
    'application/octet-stream';
  res.type(type);
  if (req.query.download) res.attachment(file);
  fs.createReadStream(full).pipe(res);
});

app.post('/api/meetings/:id/process', requireArchive, async (req, res) => {
  const id = safeId(req.params.id);
  if (!readMeeting(id)) return res.status(404).json({ error: '会议不存在' });
  processMeeting(id, { force: Boolean(req.body?.force), skipSummary: Boolean(req.body?.skipSummary) }).catch(() => {});
  res.json({ ok: true, job: jobStatus(id) });
});

app.post('/api/meetings/:id/resummarize', requireArchive, async (req, res) => {
  const id = safeId(req.params.id);
  resummarize(id).catch(() => {});
  res.json({ ok: true, job: jobStatus(id) });
});

app.get('/api/meetings/:id/job', requireArchive, (req, res) => res.json(jobStatus(safeId(req.params.id)) || { state: 'idle' }));

// 手动推送纪要（会后自动推送失败、或想补发给某个渠道时用）
app.post('/api/meetings/:id/notify', requireArchive, async (req, res) => {
  const id = safeId(req.params.id);
  if (!readMeeting(id)) return res.status(404).json({ error: '会议不存在' });
  try {
    const r = await pushSummary(id, { only: req.body?.channels });
    await updateMeeting(id, (m) => {
      m.notified = { at: Date.now(), sent: r.sent || [], failed: r.failed?.map((f) => f.channel) || [] };
      return m;
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/meetings/:id', requireAdmin, (req, res) => {
  const id = safeId(req.params.id);
  const dir = meetingDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '会议不存在' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ---------------- 静态前端 ----------------

const webDist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res
      .status(503)
      .send('<h3>前端尚未构建</h3><p>请在项目根目录执行 <code>npm install &amp;&amp; npm run build</code>，然后重启服务。</p>')
  );
}

// ---------------- 启动 ----------------

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

let server;
let scheme = 'http';
if (config.tls.enabled && fs.existsSync(config.tls.certPath) && fs.existsSync(config.tls.keyPath)) {
  server = https.createServer(
    { cert: fs.readFileSync(config.tls.certPath), key: fs.readFileSync(config.tls.keyPath) },
    app
  );
  scheme = 'https';
} else {
  server = http.createServer(app);
  if (config.tls.enabled) {
    console.warn('⚠️  未找到证书，已降级为 HTTP。除 localhost 外浏览器将无法访问摄像头/麦克风。');
    console.warn('   生成自签证书：bash scripts/gen-cert.sh');
  }
}

initLive(attachSignaling(server));

server.listen(config.port, config.host, async () => {
  console.log('');
  console.log('  InsideMeeting 服务已启动');
  console.log(`  本机：      ${scheme}://localhost:${config.port}`);
  for (const ip of lanAddresses()) console.log(`  局域网：    ${scheme}://${ip}:${config.port}`);
  console.log('');
  console.log(`  录制切分：  每 ${config.recording.segmentMinutes} 分钟一个文件`);
  console.log(`  ffmpeg：    ${(await checkFfmpeg()) ? '可用' : '未安装（无法生成纪要）'}`);
  console.log(`  转写：      ${config.asr.apiKey ? config.asr.model : '未配置'}`);
  console.log(`  纪要模型：  ${config.llm.apiKey ? config.llm.model : '未配置'}`);
  console.log(
    `  实时纪要：  ${
      config.live.enabled && config.asr.apiKey
        ? `开启（每 ${config.live.chunkSeconds} 秒转写，每 ${config.live.summarySeconds} 秒刷新摘要）`
        : '关闭'
    }`
  );
  const ch = enabledChannels();
  const chOn = Object.entries(ch).filter(([, v]) => v).map(([k]) => ({ wecom: '企业微信', feishu: '飞书', email: '邮件' })[k]);
  console.log(`  纪要推送：  ${chOn.length ? chOn.join('、') : '未配置'}`);
  console.log(
    `  会议记录：  ${config.archivePassword ? '需要口令' : '⚠️  无口令，任何能访问服务的人都能查看全部历史记录'}`
  );
  console.log(
    `  组网模式：  ${config.networkMode}${
      config.networkMode === 'tailscale'
        ? '（peer 直连，不使用 STUN/TURN）'
        : config.ice.turnUrls.length
          ? `，TURN: ${config.ice.turnUrls.join(',')}`
          : '，未配置 TURN'
    }`
  );
  console.log('');
});
