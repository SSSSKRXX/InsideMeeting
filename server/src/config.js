import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

// 依次尝试加载 .env（根目录优先）
for (const p of [path.join(ROOT, '.env'), path.join(ROOT, 'server', '.env')]) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  port: num(process.env.PORT, 8443),
  host: process.env.HOST || '0.0.0.0',

  // HTTPS：浏览器要求非 localhost 必须 https 才能拿到摄像头/麦克风/屏幕共享
  tls: {
    enabled: bool(process.env.TLS_ENABLED, true),
    certPath: process.env.TLS_CERT || path.join(ROOT, 'certs', 'cert.pem'),
    keyPath: process.env.TLS_KEY || path.join(ROOT, 'certs', 'key.pem'),
  },

  // 数据目录（相对路径一律相对项目根目录解析，避免受启动时 cwd 影响）
  dataDir: process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data'),

  // 进入会议的口令（留空则不校验）
  joinPassword: process.env.JOIN_PASSWORD || '',
  // 管理接口口令（查看/删除录制、触发纪要生成）
  adminToken: process.env.ADMIN_TOKEN || '',
  // 查看历史录音与纪要的口令（留空则不校验）
  archivePassword: process.env.ARCHIVE_PASSWORD || '',

  // 录制
  recording: {
    segmentMinutes: num(process.env.SEGMENT_MINUTES, 60), // 60 分钟切分一次
    chunkSeconds: num(process.env.CHUNK_SECONDS, 5),      // 客户端每 N 秒上传一个分片
    recordVideoDefault: bool(process.env.RECORD_VIDEO_DEFAULT, false), // 默认只录音频分轨 + 屏幕共享
    maxUploadMB: num(process.env.MAX_UPLOAD_MB, 64),
  },

  // 组网模式：
  //   tailscale —— 所有人在同一个 Tailscale 虚拟内网里，peer 之间可直连，不需要 STUN/TURN
  //   lan       —— 同一个物理局域网，同样不需要 STUN/TURN
  //   public    —— 走公网，需要 STUN，跨 NAT 还需要 TURN
  networkMode: (process.env.NETWORK_MODE || 'tailscale').toLowerCase(),

  // 画质。默认给得比较激进 —— 现在家宽普遍百兆千兆，
  // 保守的默认值只会让屏幕共享白白糊掉。带宽不够时 WebRTC
  // 自己会往下调，所以上限设高是安全的。
  media: {
    // auto / high / balanced / smooth / custom
    preset: (process.env.MEDIA_PRESET || 'auto').toLowerCase(),
    screenBitrate: num(process.env.SCREEN_BITRATE, 8_000_000),
    screenFps: num(process.env.SCREEN_FPS, 15),
    screenMaxHeight: num(process.env.SCREEN_MAX_HEIGHT, 0), // 0 = 不限制，用屏幕原生分辨率
    camBitrate: num(process.env.CAM_BITRATE, 2_500_000),
    camFps: num(process.env.CAM_FPS, 30),
    camHeight: num(process.env.CAM_HEIGHT, 720),
    // 录制到文件的码率，和实时传输分开设 —— 录制不受网络限制，可以给高
    recordScreenBitrate: num(process.env.RECORD_SCREEN_BITRATE, 6_000_000),
  },

  // 会中实时纪要
  live: {
    enabled: bool(process.env.LIVE_ENABLED, true),
    chunkSeconds: num(process.env.LIVE_CHUNK_SECONDS, 15),   // 每 15 秒出一个可独立解码的小片
    summarySeconds: num(process.env.LIVE_SUMMARY_SECONDS, 60), // 每 60 秒重写一次滚动摘要
    minCharsForSummary: num(process.env.LIVE_MIN_CHARS, 60),
    keepAudio: bool(process.env.LIVE_KEEP_AUDIO, false),      // 实时片段用完即删
  },

  // ICE / TURN
  ice: {
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean),
    turnUrls: (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    turnUsername: process.env.TURN_USERNAME || '',
    turnPassword: process.env.TURN_PASSWORD || '',
  },

  // 纪要自动推送：配了哪个渠道就发哪个
  notify: {
    enabled: bool(process.env.NOTIFY_ENABLED, true),
    // 推送消息里「查看完整纪要」按钮指向的地址，例如 https://macmini.xxx.ts.net:8443
    baseUrl: process.env.PUBLIC_BASE_URL || '',
    wecomWebhook: process.env.WECOM_WEBHOOK || '',
    feishuWebhook: process.env.FEISHU_WEBHOOK || '',
    feishuSecret: process.env.FEISHU_SECRET || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: num(process.env.SMTP_PORT, 465),
      secure: bool(process.env.SMTP_SECURE, true),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.SMTP_FROM || '',
    },
    mailTo: (process.env.MAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    mailAttach: bool(process.env.MAIL_ATTACH, true),
  },

  // ASR（语音转写）
  asr: {
    // auto = 按地址和模型名自动判断；也可显式指定 openai / mimo
    provider: (process.env.ASR_PROVIDER || 'auto').toLowerCase(),
    baseUrl: (process.env.ASR_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.ASR_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.ASR_MODEL || 'whisper-1',
    language: process.env.ASR_LANGUAGE || 'zh',
    concurrency: num(process.env.ASR_CONCURRENCY, 3),
  },

  // LLM（会议纪要）— OpenAI 兼容接口
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    maxCharsPerChunk: num(process.env.LLM_CHUNK_CHARS, 24000),
  },

  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
};

export const paths = {
  recordings: path.join(config.dataDir, 'recordings'),
  meetings: path.join(config.dataDir, 'meetings'),
  tmp: path.join(config.dataDir, 'tmp'),
  // 虚拟背景的模型放数据目录，而不是打包进 App —— 这样运行时能下载、
  // 升级 App 不用重下，打包后的只读目录也不受影响
  models: path.join(config.dataDir, 'models'),
};

/** 画质档位。custom 时用上面那些具体数值。 */
export const MEDIA_PRESETS = {
  smooth: { screenBitrate: 2_000_000, screenFps: 10, screenMaxHeight: 1080, camBitrate: 800_000, camFps: 24, camHeight: 480 },
  balanced: { screenBitrate: 4_000_000, screenFps: 12, screenMaxHeight: 1440, camBitrate: 1_500_000, camFps: 30, camHeight: 720 },
  high: { screenBitrate: 12_000_000, screenFps: 24, screenMaxHeight: 0, camBitrate: 4_000_000, camFps: 30, camHeight: 1080 },
  // auto：上限给足，剩下交给 WebRTC 的拥塞控制自己压
  auto: { screenBitrate: 8_000_000, screenFps: 15, screenMaxHeight: 0, camBitrate: 2_500_000, camFps: 30, camHeight: 720 },
};

/** 把档位展开成具体参数 */
export function mediaSettings() {
  const m = config.media;
  if (m.preset === 'custom') {
    return {
      preset: 'custom',
      screenBitrate: m.screenBitrate,
      screenFps: m.screenFps,
      screenMaxHeight: m.screenMaxHeight,
      camBitrate: m.camBitrate,
      camFps: m.camFps,
      camHeight: m.camHeight,
      recordScreenBitrate: m.recordScreenBitrate,
    };
  }
  const p = MEDIA_PRESETS[m.preset] || MEDIA_PRESETS.auto;
  return { preset: m.preset, ...p, recordScreenBitrate: m.recordScreenBitrate };
}

for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });

export function iceServers() {
  // Tailscale / 局域网模式下，peer 的网卡地址本身就是互相可路由的，
  // ICE 用 host candidate 就能直连。此时问外部 STUN 既没用也没必要。
  if (config.networkMode === 'tailscale' || config.networkMode === 'lan') return [];

  const list = [{ urls: config.ice.stunUrls }];
  if (config.ice.turnUrls.length) {
    list.push({
      urls: config.ice.turnUrls,
      username: config.ice.turnUsername,
      credential: config.ice.turnPassword,
    });
  }
  return list;
}
