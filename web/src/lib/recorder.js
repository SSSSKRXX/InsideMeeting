/**
 * 分轨录制器。
 *
 * 每个客户端只录「自己」的麦克风（以及自己发起的屏幕共享），实时分片上传到服务器。
 * 这样做的好处：
 *   1. 说话人归属 100% 准确 —— 谁的音轨就是谁说的，不需要声纹聚类。
 *   2. 服务器（Mac mini）不需要解码任何媒体流，只做落盘，压力极低。
 *   3. mesh P2P 架构下服务器本来就拿不到媒体流，这是唯一可行的录制方式。
 *
 * 每 SEGMENT_MINUTES 分钟重启一次 MediaRecorder，
 * 因此每个分段文件都自带 webm 头部，可以独立播放，不依赖前后文件。
 */

const MIME_CANDIDATES = {
  audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'],
  video: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'],
};

function pickMime(type) {
  for (const m of MIME_CANDIDATES[type]) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

/** 从 mimeType 推容器扩展名。iOS Safari 只能产 mp4，服务端要按真实容器存盘。 */
export function containerExt(mimeType) {
  if (!mimeType) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

export function recordingSupported() {
  return typeof window.MediaRecorder !== 'undefined' && Boolean(pickMime('audio'));
}

export function screenShareSupported() {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export class TrackRecorder {
  /**
   * @param {object} o
   * @param {string} o.kind  mic | screen | cam
   * @param {MediaStream} o.stream
   */
  constructor({ meetingId, roomId, peerId, name, kind, stream, segmentMinutes = 60, chunkSeconds = 5, videoBitrate = 1_500_000, onEvent }) {
    Object.assign(this, { meetingId, roomId, peerId, name, kind, stream, segmentMinutes, chunkSeconds, videoBitrate });
    this.onEvent = onEvent || (() => {});
    this.seg = 0;
    this.recorder = null;
    this.rotateTimer = null;
    this.queue = [];
    this.uploading = false;
    this.bytes = 0;
    this.failed = 0;
    this.running = false;
    this.startedAt = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    await this.#startSegment();
  }

  async #startSegment() {
    const startedAt = Date.now();
    const isVideo0 = this.stream.getVideoTracks().length > 0;
    await fetch('/api/rec/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: this.meetingId,
        roomId: this.roomId,
        peerId: this.peerId,
        name: this.name,
        kind: this.kind,
        seg: this.seg,
        startedAt,
        ext: containerExt(pickMime(isVideo0 ? 'video' : 'audio')),
      }),
    }).catch(() => {});

    const isVideo = this.stream.getVideoTracks().length > 0;
    const mimeType = pickMime(isVideo ? 'video' : 'audio');
    const opts = { mimeType };
    if (isVideo) opts.videoBitsPerSecond = this.videoBitrate;
    opts.audioBitsPerSecond = 64_000;

    this.ext = containerExt(mimeType);
    const rec = new MediaRecorder(this.stream, opts);
    this.recorder = rec;
    const seg = this.seg;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.queue.push({ seg, blob: e.data });
        this.#drain();
      }
    };
    rec.onerror = (e) => this.onEvent({ type: 'error', error: e.error?.message || '录制出错' });

    rec.start(this.chunkSeconds * 1000);
    this.onEvent({ type: 'segment-start', seg, startedAt });

    // 到点切分：停掉当前 recorder，开一个新文件
    this.rotateTimer = setTimeout(() => this.#rotate(), this.segmentMinutes * 60 * 1000);
  }

  async #rotate() {
    const finished = this.seg;
    await this.#stopRecorder();
    this.#closeSegment(finished);
    this.seg += 1;
    if (this.running) await this.#startSegment();
    this.onEvent({ type: 'rotate', seg: this.seg });
  }

  #stopRecorder() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === 'inactive') return resolve();
      rec.onstop = () => resolve();
      try { rec.requestData(); } catch { /* noop */ }
      try { rec.stop(); } catch { resolve(); }
      clearTimeout(this.rotateTimer);
    });
  }

  #closeSegment(seg) {
    fetch('/api/rec/segment-end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: this.meetingId,
        peerId: this.peerId,
        kind: this.kind,
        seg,
        endedAt: Date.now(),
      }),
      keepalive: true,
    }).catch(() => {});
  }

  async #drain() {
    if (this.uploading) return;
    this.uploading = true;
    while (this.queue.length) {
      const item = this.queue[0];
      const ok = await this.#upload(item);
      if (ok) {
        this.queue.shift();
        this.bytes += item.blob.size;
        this.onEvent({ type: 'progress', bytes: this.bytes, pending: this.queue.length });
      } else {
        this.failed += 1;
        this.onEvent({ type: 'retry', pending: this.queue.length, failed: this.failed });
        // 指数退避，最多等 15 秒；分片留在队列里不会丢
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** Math.min(4, this.failed))));
      }
    }
    this.uploading = false;
  }

  async #upload({ seg, blob }) {
    try {
      const res = await fetch('/api/rec/chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-meeting': this.meetingId,
          'x-peer': this.peerId,
          'x-kind': this.kind,
          'x-seg': String(seg),
        },
        body: blob,
      });
      if (res.ok) this.failed = 0;
      return res.ok;
    } catch {
      return false;
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.rotateTimer);
    await this.#stopRecorder();
    await this.#drain();
    this.#closeSegment(this.seg);
    this.onEvent({ type: 'stopped', bytes: this.bytes });
  }

  get pendingChunks() {
    return this.queue.length;
  }
}

/**
 * 实时纪要用的小片录制器。
 *
 * 和 TrackRecorder 是两条独立的链路，各录各的：
 *   TrackRecorder —— 连续录制，分片追加写同一个文件，追求完整和音质，会后转写。
 *   LiveChunker   —— 每 15 秒起停一次，每片都是独立完整的小文件，可以立刻送去转写。
 *
 * 为什么不共用一条：连续录制产生的中间分片没有容器头部，单独拿出来解不了码。
 * 多起一个 MediaRecorder 的开销只是一次额外的 opus 编码，远小于它带来的复杂度节省。
 */
export class LiveChunker {
  constructor({ meetingId, roomId, peerId, name, stream, chunkSeconds = 15, onEvent }) {
    Object.assign(this, { meetingId, roomId, peerId, name, stream, chunkSeconds });
    this.onEvent = onEvent || (() => {});
    this.seq = 0;
    this.running = false;
    this.recorder = null;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#cycle();
  }

  #cycle() {
    if (!this.running) return;
    const mimeType = pickMime('audio');
    const ext = containerExt(mimeType);
    const startedAt = Date.now();
    const seq = this.seq++;

    let rec;
    try {
      rec = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 48_000 });
    } catch {
      this.running = false;
      return;
    }
    this.recorder = rec;

    const parts = [];
    rec.ondataavailable = (e) => e.data?.size && parts.push(e.data);
    rec.onstop = () => {
      if (parts.length) this.#send(new Blob(parts, { type: mimeType }), seq, startedAt, ext);
      this.#cycle(); // 立刻开下一片
    };

    rec.start();
    this.timer = setTimeout(() => {
      try { rec.stop(); } catch { this.running = false; }
    }, this.chunkSeconds * 1000);
  }

  async #send(blob, seq, startedAt, ext) {
    // 太小的片基本是纯静音，本地就丢掉，省一次请求
    if (blob.size < 3000) return;
    try {
      await fetch('/api/live/chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-meeting': this.meetingId,
          'x-room': this.roomId,
          'x-peer': this.peerId,
          'x-name': encodeURIComponent(this.name),
          'x-seq': String(seq),
          'x-started': String(startedAt),
          'x-ext': ext,
        },
        body: blob,
      });
      this.onEvent({ type: 'sent', seq, bytes: blob.size });
    } catch {
      this.onEvent({ type: 'send-failed', seq });
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    try { this.recorder?.stop(); } catch { /* noop */ }
  }
}

/** 浏览器本地实时字幕（Chrome / Edge 的 Web Speech API，不联网到我们的服务器） */
export function createLiveCaption({ lang = 'zh-CN', onResult }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  let stopped = false;

  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    onResult({ text: r[0].transcript, final: r.isFinal });
  };
  rec.onend = () => { if (!stopped) { try { rec.start(); } catch { /* noop */ } } };
  rec.onerror = () => {};

  try { rec.start(); } catch { /* noop */ }
  return () => { stopped = true; try { rec.stop(); } catch { /* noop */ } };
}
