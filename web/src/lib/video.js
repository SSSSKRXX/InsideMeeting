/**
 * 虚拟背景（模糊 / 换图）。
 *
 * 用 MediaPipe 的人像分割模型逐帧算出人像蒙版，再把背景替换掉，
 * 最后从 canvas 取流作为新的摄像头轨。
 *
 * 两个务实的处理：
 *   1. 模型和 wasm 优先从本机服务器加载（scripts/fetch-models.sh 可以预先下载好），
 *      失败才回退到 CDN。国内网络访问 Google 的模型仓库经常不通。
 *   2. 一旦创建，输出轨就固定不变。切换模式只改内部参数，
 *      不会重新协商 WebRTC，也不会打断录制。
 */

const LOCAL_BASE = '/models';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

export const MODES = { off: '关闭', blur: '背景模糊', image: '背景图片' };

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

let visionModulePromise = null;
function loadVisionModule() {
  if (!visionModulePromise) {
    visionModulePromise = import(
      /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    );
  }
  return visionModulePromise;
}

export class BackgroundProcessor {
  /**
   * @param {MediaStreamTrack} track 原始摄像头轨
   * @param {object} o
   */
  constructor(track, { width = 1280, height = 720, fps = 24 } = {}) {
    this.rawTrack = track;
    this.mode = 'off';
    this.blurPx = 12;
    this.bgImage = null;
    this.ready = false;
    this.error = '';
    this.running = false;

    const s = track.getSettings?.() || {};
    this.w = s.width || width;
    this.h = s.height || height;

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = new MediaStream([track]);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });

    // 蒙版和背景各用一个离屏 canvas，避免每帧新建
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = this.w;
    this.bgCanvas.height = this.h;
    this.bgCtx = this.bgCanvas.getContext('2d');

    this.outStream = this.canvas.captureStream(fps);
    this.video.play().catch(() => {});
    this._start();
  }

  get track() {
    return this.outStream.getVideoTracks()[0] || null;
  }

  async ensureModel() {
    if (this.segmenter || this.loading) return;
    this.loading = true;
    try {
      const vision = await loadVisionModule();
      const { FilesetResolver, ImageSegmenter } = vision;

      const localWasm = await exists(`${LOCAL_BASE}/wasm/vision_wasm_internal.js`);
      const wasmBase = localWasm ? `${LOCAL_BASE}/wasm` : CDN_WASM;
      const localModel = await exists(`${LOCAL_BASE}/selfie_segmenter.tflite`);
      const modelPath = localModel ? `${LOCAL_BASE}/selfie_segmenter.tflite` : CDN_MODEL;

      const fileset = await FilesetResolver.forVisionTasks(wasmBase);
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      this.ready = true;
      this.error = '';
    } catch (e) {
      this.error =
        '虚拟背景模型加载失败。去「管理后台 → 设置 → 虚拟背景模型」点一下「下载模型」' +
        '——服务器下一次，之后所有人都从局域网取，不用各自访问外网。' +
        `（${String(e.message || e).slice(0, 120)}）`;
      this.ready = false;
    } finally {
      this.loading = false;
    }
  }

  async setMode(mode, { image } = {}) {
    if (mode !== 'off') await this.ensureModel();
    if (mode !== 'off' && !this.ready) {
      this.mode = 'off';
      return { ok: false, error: this.error };
    }
    if (image) await this.setImage(image);
    this.mode = mode;
    return { ok: true };
  }

  async setImage(src) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = src;
    });
    // 预先按 cover 方式铺到背景 canvas，每帧直接画，不重复计算
    const scale = Math.max(this.w / img.width, this.h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    this.bgCtx.clearRect(0, 0, this.w, this.h);
    this.bgCtx.drawImage(img, (this.w - dw) / 2, (this.h - dh) / 2, dw, dh);
    this.bgImage = src;
  }

  _start() {
    if (this.running) return;
    this.running = true;
    const draw = () => {
      if (!this.running) return;
      try {
        this._frame();
      } catch { /* 单帧失败就跳过，不要中断整个循环 */ }
      this._raf = requestAnimationFrame(draw);
    };
    draw();
  }

  _frame() {
    const v = this.video;
    if (!v.videoWidth) return;

    if (v.videoWidth !== this.w || v.videoHeight !== this.h) {
      this.w = this.canvas.width = this.bgCanvas.width = v.videoWidth;
      this.h = this.canvas.height = this.bgCanvas.height = v.videoHeight;
      if (this.bgImage) this.setImage(this.bgImage);
    }

    // 关闭状态：原样拷贝，保持输出轨不中断
    if (this.mode === 'off' || !this.segmenter) {
      this.ctx.drawImage(v, 0, 0, this.w, this.h);
      return;
    }

    const res = this.segmenter.segmentForVideo(v, performance.now());
    const mask = res?.categoryMask;
    if (!mask) {
      this.ctx.drawImage(v, 0, 0, this.w, this.h);
      return;
    }

    const mw = mask.width;
    const mh = mask.height;
    const data = mask.getAsUint8Array();

    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas.width = mw;
      this.maskCanvas.height = mh;
    }
    const img = this.maskCtx.createImageData(mw, mh);
    for (let i = 0; i < data.length; i++) {
      // 类别 0 = 背景，非 0 = 人像。蒙版画成「人像处不透明」
      const person = data[i] !== 0 ? 255 : 0;
      img.data[i * 4 + 3] = person;
    }
    this.maskCtx.putImageData(img, 0, 0);
    mask.close?.();

    const c = this.ctx;

    // 1) 先铺背景
    c.save();
    c.filter = 'none';
    if (this.mode === 'image' && this.bgImage) {
      c.drawImage(this.bgCanvas, 0, 0, this.w, this.h);
    } else {
      c.filter = `blur(${this.blurPx}px)`;
      c.drawImage(v, 0, 0, this.w, this.h);
      c.filter = 'none';
    }
    c.restore();

    // 2) 把人像按蒙版贴上去
    c.save();
    c.drawImage(this.maskCanvas, 0, 0, this.w, this.h);
    c.globalCompositeOperation = 'source-in';
    c.drawImage(v, 0, 0, this.w, this.h);
    c.restore();

    // 3) 上一步 source-in 会清掉背景，所以背景要垫在人像下面重画一次
    c.save();
    c.globalCompositeOperation = 'destination-over';
    if (this.mode === 'image' && this.bgImage) {
      c.drawImage(this.bgCanvas, 0, 0, this.w, this.h);
    } else {
      c.filter = `blur(${this.blurPx}px)`;
      c.drawImage(v, 0, 0, this.w, this.h);
      c.filter = 'none';
    }
    c.restore();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    try {
      this.segmenter?.close();
      this.outStream.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
    } catch { /* noop */ }
  }
}

export function backgroundSupported() {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}
