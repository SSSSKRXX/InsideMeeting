/**
 * 麦克风增强降噪。
 *
 * 浏览器 getUserMedia 自带的 echoCancellation / noiseSuppression / autoGainControl
 * 已经处理了大部分情况，这里补的是它们不管的两件事：
 *   1. 低频隆隆声（空调、风扇、桌面震动）—— 高通滤波直接砍掉 85Hz 以下
 *   2. 说话间隙的底噪 —— 噪声门，没人说话时把增益压下去
 *
 * 第 2 点对会议纪要的价值比对听感更大：分轨录音里安静时段的底噪
 * 会让语音识别产生幻听文本（凭空冒出"谢谢观看"之类）。压掉底噪，
 * 服务端的静音检测能更干净地把这些片段整段跳过。
 *
 * 关键设计：输出轨是稳定的。开关降噪只是改内部参数，不会换 track，
 * 所以不需要重新协商 WebRTC，也不会打断正在进行的录制。
 */

const HIGHPASS_HZ = 85;
const GATE_OPEN_DB = -46;   // 高于这个电平认为有人在说话
const GATE_CLOSE_DB = -54;  // 低于这个电平认为是底噪（留 8dB 迟滞，避免频繁开合）
const ATTACK_S = 0.01;      // 开门要快，否则会吃掉字头
const RELEASE_S = 0.25;     // 关门要慢，否则句子中间的停顿会被切碎
const HOLD_MS = 260;

export class MicProcessor {
  /**
   * @param {MediaStream} rawStream 原始麦克风流
   */
  constructor(rawStream) {
    this.raw = rawStream;
    this.enabled = false;
    this.ok = false;
    this.level = 0;
    this.gateOpen = true;
    this._lastVoiceAt = 0;
    this._timer = null;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.source = this.ctx.createMediaStreamSource(rawStream);

      this.highpass = this.ctx.createBiquadFilter();
      this.highpass.type = 'highpass';
      this.highpass.frequency.value = HIGHPASS_HZ;
      this.highpass.Q.value = 0.7;

      this.gate = this.ctx.createGain();
      this.gate.gain.value = 1;

      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -24;
      this.comp.knee.value = 24;
      this.comp.ratio.value = 3;
      this.comp.attack.value = 0.005;
      this.comp.release.value = 0.15;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.3;

      this.dest = this.ctx.createMediaStreamDestination();

      // 电平检测挂在滤波之后、噪声门之前，
      // 否则门一关电平就变成 0，永远不会再打开。
      this.source.connect(this.highpass);
      this.highpass.connect(this.analyser);
      this.highpass.connect(this.gate);
      this.gate.connect(this.comp);
      this.comp.connect(this.dest);

      this._buf = new Float32Array(this.analyser.fftSize);
      this._loop();
      this.ok = true;
    } catch (e) {
      // WebAudio 出问题时退回原始轨，绝不能让人没声音
      this.error = e.message;
      this.ok = false;
    }
  }

  /** 给上层用的输出轨。处理链挂了就返回原始轨。 */
  get track() {
    if (!this.ok) return this.raw.getAudioTracks()[0] || null;
    return this.dest.stream.getAudioTracks()[0] || null;
  }

  get stream() {
    return this.ok ? this.dest.stream : this.raw;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled && this.ok) {
      this.gate.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gate.gain.setTargetAtTime(1, this.ctx.currentTime, ATTACK_S);
      this.gateOpen = true;
    }
  }

  _loop() {
    this._timer = setInterval(() => {
      if (!this.ok) return;
      this.analyser.getFloatTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
      const rms = Math.sqrt(sum / this._buf.length);
      const db = 20 * Math.log10(rms || 1e-8);
      this.level = Math.min(1, Math.max(0, (db + 60) / 45));

      if (!this.enabled) return;

      const now = performance.now();
      if (db > GATE_OPEN_DB) this._lastVoiceAt = now;
      const shouldOpen = db > GATE_OPEN_DB || (db > GATE_CLOSE_DB && now - this._lastVoiceAt < HOLD_MS);

      if (shouldOpen && !this.gateOpen) {
        this.gate.gain.setTargetAtTime(1, this.ctx.currentTime, ATTACK_S);
        this.gateOpen = true;
      } else if (!shouldOpen && this.gateOpen && now - this._lastVoiceAt > HOLD_MS) {
        // 不压到 0，压到 -30dB。全静音听感上像掉线，留一点底噪反而自然
        this.gate.gain.setTargetAtTime(0.03, this.ctx.currentTime, RELEASE_S);
        this.gateOpen = false;
      }
    }, 40);
  }

  /** 浏览器的自动播放策略可能让 AudioContext 处于 suspended，用户手势后要恢复 */
  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  destroy() {
    clearInterval(this._timer);
    try {
      this.source?.disconnect();
      this.ctx?.close();
    } catch { /* noop */ }
  }
}
