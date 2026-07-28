/**
 * WebRTC mesh 连接管理（2-8 人规模）。
 *
 * 关键设计：每条连接固定预建 3 条 transceiver，顺序为
 *   mid 0 = 麦克风音频
 *   mid 1 = 摄像头视频
 *   mid 2 = 屏幕共享视频
 * 于是开关摄像头 / 开始屏幕共享时只需 sender.replaceTrack()，
 * 完全不需要重新协商 SDP —— 这消除了 mesh 里最容易出错的 glare（双方同时 offer）问题。
 */

const SLOT = { mic: 0, cam: 1, screen: 2 };

export class Mesh {
  constructor({ socket, iceServers, onUpdate }) {
    this.socket = socket;
    this.iceServers = iceServers;
    this.onUpdate = onUpdate || (() => {});
    this.peers = new Map(); // peerId -> { pc, polite, senders, streams:{cam,screen}, state }
    this.local = { mic: null, cam: null, screen: null };
    this.pendingCandidates = new Map();

    socket.on('signal', ({ from, data }) => this.#onSignal(from, data));
  }

  setLocalTrack(kind, track) {
    this.local[kind] = track || null;
    for (const p of this.peers.values()) {
      const sender = p.senders[kind];
      if (sender) sender.replaceTrack(track || null).catch(() => {});
    }
  }

  /** 我方主动向对端发起连接（新入会者向房间内已有成员发起） */
  async connect(peerId) {
    const p = this.#ensurePeer(peerId, true);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    this.socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: p.pc.localDescription } });
  }

  close(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.stopMeter?.();
    try { p.pc.close(); } catch { /* noop */ }
    this.peers.delete(peerId);
    this.onUpdate();
  }

  destroy() {
    for (const id of [...this.peers.keys()]) this.close(id);
  }

  getRemote(peerId) {
    const p = this.peers.get(peerId);
    return p
      ? { ...p.streams, state: p.state, audioLevel: p.audioLevel || 0 }
      : { cam: null, screen: null, mic: null, state: 'new', audioLevel: 0 };
  }

  /** 一次性读出所有远端的音量，供「当前说话人」判定使用 */
  levels() {
    const out = {};
    for (const [id, p] of this.peers) out[id] = p.audioLevel || 0;
    return out;
  }

  #ensurePeer(peerId, isOfferer) {
    let p = this.peers.get(peerId);
    if (p) return p;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    p = {
      pc,
      isOfferer,
      senders: {},
      streams: { mic: new MediaStream(), cam: new MediaStream(), screen: new MediaStream() },
      state: 'connecting',
      audioLevel: 0,
    };
    this.peers.set(peerId, p);

    if (isOfferer) {
      // 固定顺序建立 3 条通道
      p.senders.mic = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      p.senders.cam = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      p.senders.screen = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      this.#applyLocalTracks(p);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('signal', { to: peerId, data: { type: 'candidate', candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      const mid = e.transceiver?.mid;
      const kind =
        mid === '0' ? 'mic' : mid === '1' ? 'cam' : mid === '2' ? 'screen' : e.track.kind === 'audio' ? 'mic' : 'cam';
      const stream = p.streams[kind];
      // 同一 slot 只保留最新的一条 track
      for (const t of stream.getTracks()) stream.removeTrack(t);
      stream.addTrack(e.track);

      // 远端音轨到了就挂一个音量表，用于「当前说话人」自动聚焦。
      // 刻意不在这里触发重渲染 —— 音量每帧都在变，由上层定时轮询读取。
      if (kind === 'mic') {
        p.stopMeter?.();
        p.stopMeter = createLevelMeter(stream, (v) => {
          p.audioLevel = v;
        });
      }
      e.track.onunmute = () => this.onUpdate();
      e.track.onended = () => {
        stream.removeTrack(e.track);
        this.onUpdate();
      };
      this.onUpdate();
    };

    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      this.onUpdate();
      if (pc.connectionState === 'failed' && p.isOfferer) this.#restartIce(peerId);
    };

    return p;
  }

  #applyLocalTracks(p) {
    for (const kind of ['mic', 'cam', 'screen']) {
      const s = p.senders[kind];
      if (s) s.replaceTrack(this.local[kind] || null).catch(() => {});
    }
  }

  async #restartIce(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try {
      const offer = await p.pc.createOffer({ iceRestart: true });
      await p.pc.setLocalDescription(offer);
      this.socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: p.pc.localDescription } });
    } catch { /* 放弃，等待用户手动重连 */ }
  }

  async #onSignal(from, data) {
    if (!data) return;

    if (data.type === 'offer') {
      const p = this.#ensurePeer(from, false);
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // 应答方：按 mid 把本地轨挂到对应的 transceiver 上
      for (const t of p.pc.getTransceivers()) {
        const kind = Object.keys(SLOT).find((k) => String(SLOT[k]) === t.mid);
        if (kind) {
          p.senders[kind] = t.sender;
          t.direction = 'sendrecv';
        }
      }
      this.#applyLocalTracks(p);

      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      this.socket.emit('signal', { to: from, data: { type: 'answer', sdp: p.pc.localDescription } });
      this.#flushCandidates(from);
      return;
    }

    if (data.type === 'answer') {
      const p = this.peers.get(from);
      if (!p) return;
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      this.#flushCandidates(from);
      return;
    }

    if (data.type === 'candidate') {
      const p = this.peers.get(from);
      if (!p || !p.pc.remoteDescription) {
        const list = this.pendingCandidates.get(from) || [];
        list.push(data.candidate);
        this.pendingCandidates.set(from, list);
        return;
      }
      try { await p.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* noop */ }
    }
  }

  #flushCandidates(peerId) {
    const list = this.pendingCandidates.get(peerId);
    const p = this.peers.get(peerId);
    if (!list || !p) return;
    for (const c of list) p.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    this.pendingCandidates.delete(peerId);
  }

  async stats(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return null;
    const report = await p.pc.getStats();
    let rttMs = null;
    let kbps = 0;
    let packetsLost = 0;
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        rttMs = Math.round(r.currentRoundTripTime * 1000);
      }
      if (r.type === 'inbound-rtp' && !r.isRemote) {
        kbps += Math.round(((r.bytesReceived || 0) * 8) / 1000);
        packetsLost += r.packetsLost || 0;
      }
    });
    return { rttMs, kbps, packetsLost };
  }
}

/** 音量检测：用于「谁在说话」高亮和 UI 音量条 */
export function createLevelMeter(stream, cb) {
  if (!stream || !stream.getAudioTracks().length) return () => {};
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf;
  const loop = () => {
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    cb(Math.min(1, Math.sqrt(sum / buf.length) / 60));
    raf = requestAnimationFrame(loop);
  };
  loop();
  return () => {
    cancelAnimationFrame(raf);
    try { src.disconnect(); ctx.close(); } catch { /* noop */ }
  };
}
