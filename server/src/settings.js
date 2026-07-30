import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * 运行时设置。
 *
 * .env 仍然是默认值的来源，但这里的值会覆盖它，并且能在界面上改、立即生效。
 * 理由很简单：让一个不熟悉命令行的人去 ssh 上服务器改 .env 再重启，
 * 这道门槛足以让整套系统用不起来。
 *
 * 实现上是「原地修改 config 对象」。各模块都是在函数里读 config.xxx 而不是
 * 在 import 时取值，所以改完立刻就生效，不需要重启，也不用改任何调用方。
 */

const FILE = path.join(config.dataDir, 'settings.json');

/**
 * 可在界面上修改的设置项。
 * path 是它在 config 对象里的位置，env 是对应的环境变量名（只用于文档展示）。
 */
export const SCHEMA = [
  // ---------- 语音转写 ----------
  {
    key: 'asrProvider', path: 'asr.provider', env: 'ASR_PROVIDER', group: 'ai', type: 'select',
    label: '转写接口类型',
    options: [['auto', '自动判断'], ['openai', 'OpenAI 兼容'], ['mimo', '小米 MiMo']],
    help: '小米 MiMo 的 ASR 走 chat/completions 而不是 audio/transcriptions，两种接口不通用。填错会报 404。自动判断在多数情况下够用。',
  },
  {
    key: 'asrBaseUrl', path: 'asr.baseUrl', env: 'ASR_BASE_URL', group: 'ai', type: 'text',
    label: '转写服务地址',
    help: 'OpenAI 用 https://api.openai.com/v1；小米 MiMo 用 https://api.xiaomimimo.com/v1。',
    placeholder: 'https://api.openai.com/v1',
  },
  {
    key: 'asrApiKey', path: 'asr.apiKey', env: 'ASR_API_KEY', group: 'ai', type: 'password',
    label: '转写服务密钥',
    help: '没有这个就无法生成会议纪要。',
  },
  {
    key: 'asrModel', path: 'asr.model', env: 'ASR_MODEL', group: 'ai', type: 'text',
    label: '转写模型', placeholder: 'whisper-1',
  },
  {
    key: 'asrLanguage', path: 'asr.language', env: 'ASR_LANGUAGE', group: 'ai', type: 'select',
    label: '会议语言', options: [['zh', '中文'], ['en', '英文'], ['auto', '自动识别']],
    help: '指定语言比自动识别准得多，中文会议就选中文。',
  },

  // ---------- 纪要模型 ----------
  {
    key: 'llmBaseUrl', path: 'llm.baseUrl', env: 'LLM_BASE_URL', group: 'ai', type: 'text',
    label: '纪要模型地址', placeholder: 'https://api.openai.com/v1',
  },
  {
    key: 'llmApiKey', path: 'llm.apiKey', env: 'LLM_API_KEY', group: 'ai', type: 'password',
    label: '纪要模型密钥',
    help: '可以和转写用同一个，也可以分开。',
  },
  {
    key: 'llmModel', path: 'llm.model', env: 'LLM_MODEL', group: 'ai', type: 'text',
    label: '纪要模型', placeholder: 'gpt-4o-mini',
  },

  // ---------- 安全 ----------
  {
    key: 'joinPassword', path: 'joinPassword', env: 'JOIN_PASSWORD', group: 'security', type: 'password',
    label: '全局入会口令',
    help: '所有房间通用的第一道门。留空表示不校验，任何人只要知道地址就能进。',
  },
  {
    key: 'adminToken', path: 'adminToken', env: 'ADMIN_TOKEN', group: 'security', type: 'password',
    label: '管理口令',
    help: '进入本页面需要的口令。留空则任何人都能打开管理后台。',
  },
  {
    key: 'archivePassword', path: 'archivePassword', env: 'ARCHIVE_PASSWORD', group: 'security', type: 'password',
    label: '查看会议记录的口令',
    help: '历史录音和纪要涉及会议内容。留空表示任何能打开会议地址的人都能查看全部历史记录。',
  },

  // ---------- 实时纪要 ----------
  {
    key: 'liveEnabled', path: 'live.enabled', env: 'LIVE_ENABLED', group: 'live', type: 'bool',
    label: '开启会中实时纪要',
    help: '会议进行中持续转写，每分钟刷新一版摘要。会持续消耗转写额度。',
  },
  {
    key: 'liveSummarySeconds', path: 'live.summarySeconds', env: 'LIVE_SUMMARY_SECONDS', group: 'live', type: 'number',
    label: '摘要刷新间隔（秒）', min: 20, max: 600,
  },
  {
    key: 'liveMinChars', path: 'live.minCharsForSummary', env: 'LIVE_MIN_CHARS', group: 'live', type: 'number',
    label: '刷新所需新增字数', min: 0, max: 2000,
    help: '距上次摘要新增字数不到这个值就跳过，避免没人说话时白烧额度。',
  },

  // ---------- 录制 ----------
  {
    key: 'segmentMinutes', path: 'recording.segmentMinutes', env: 'SEGMENT_MINUTES', group: 'recording', type: 'number',
    label: '录制切分间隔（分钟）', min: 5, max: 240,
    help: '每隔这么久自动切一个新文件，每个文件都能独立播放。',
  },
  {
    key: 'chunkSeconds', path: 'recording.chunkSeconds', env: 'CHUNK_SECONDS', group: 'recording', type: 'number',
    label: '上传分片间隔（秒）', min: 2, max: 30,
    help: '调小更抗崩溃（最多丢这么多秒），调大更省请求数。',
  },

  // ---------- 推送 ----------
  {
    key: 'notifyEnabled', path: 'notify.enabled', env: 'NOTIFY_ENABLED', group: 'notify', type: 'bool',
    label: '纪要生成后自动推送',
  },
  {
    key: 'publicBaseUrl', path: 'notify.baseUrl', env: 'PUBLIC_BASE_URL', group: 'notify', type: 'text',
    label: '对外访问地址',
    help: '推送消息里「查看完整纪要」按钮指向的地址。不填的话消息里就没有跳转按钮。',
    placeholder: 'https://macmini.你的tailnet.ts.net:8443',
  },
  {
    key: 'wecomWebhook', path: 'notify.wecomWebhook', env: 'WECOM_WEBHOOK', group: 'notify', type: 'password',
    label: '企业微信机器人',
    help: '群设置 → 群机器人 → 添加 → 复制 Webhook 地址。',
  },
  {
    key: 'feishuWebhook', path: 'notify.feishuWebhook', env: 'FEISHU_WEBHOOK', group: 'notify', type: 'password',
    label: '飞书机器人',
    help: '群设置 → 群机器人 → 添加自定义机器人。',
  },
  {
    key: 'feishuSecret', path: 'notify.feishuSecret', env: 'FEISHU_SECRET', group: 'notify', type: 'password',
    label: '飞书签名密钥',
    help: '只有在飞书机器人开了「签名校验」时才需要填。',
  },
  {
    key: 'smtpHost', path: 'notify.smtp.host', env: 'SMTP_HOST', group: 'notify', type: 'text',
    label: '邮件服务器', placeholder: 'smtp.qq.com',
  },
  {
    key: 'smtpPort', path: 'notify.smtp.port', env: 'SMTP_PORT', group: 'notify', type: 'number',
    label: '邮件端口', min: 1, max: 65535,
  },
  {
    key: 'smtpUser', path: 'notify.smtp.user', env: 'SMTP_USER', group: 'notify', type: 'text',
    label: '发件邮箱',
  },
  {
    key: 'smtpPass', path: 'notify.smtp.pass', env: 'SMTP_PASS', group: 'notify', type: 'password',
    label: '邮箱密码',
    help: 'QQ / 163 这类邮箱要填「授权码」，不是登录密码。',
  },
  {
    key: 'mailTo', path: 'notify.mailTo', env: 'MAIL_TO', group: 'notify', type: 'list',
    label: '收件人',
    help: '多个邮箱用逗号隔开。',
  },
];

export const GROUPS = [
  { id: 'ai', label: 'AI 服务', desc: '会议纪要靠这两个服务生成。不配的话会议照常开，只是没有纪要。' },
  { id: 'security', label: '安全', desc: '控制谁能进会、谁能看历史记录、谁能打开这个页面。' },
  { id: 'live', label: '会中实时纪要', desc: '边开会边出摘要。开着会持续消耗转写额度。' },
  { id: 'recording', label: '录制', desc: '一般不用改。' },
  { id: 'notify', label: '纪要推送', desc: '会后自动把纪要发到群里或邮箱。配了哪个发哪个。' },
];

const BY_KEY = Object.fromEntries(SCHEMA.map((f) => [f.key, f]));

// ---------------- 读写 ----------------

function getIn(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setIn(obj, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o[k] ||= {}), obj);
  target[last] = value;
}

let overrides = null;

function load() {
  if (overrides) return overrides;
  try {
    overrides = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    overrides = {};
  }
  return overrides;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(overrides, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

function coerce(field, raw) {
  switch (field.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (field.min != null && n < field.min) return field.min;
      if (field.max != null && n > field.max) return field.max;
      return n;
    }
    case 'bool':
      return Boolean(raw);
    case 'list':
      return Array.isArray(raw)
        ? raw
        : String(raw || '').split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean);
    default:
      return String(raw ?? '').trim();
  }
}

/** 把已保存的覆盖值写进 config。启动时调一次，每次改设置后再调一次。 */
export function applySettings() {
  const o = load();
  for (const [key, value] of Object.entries(o)) {
    const f = BY_KEY[key];
    if (!f) continue;
    setIn(config, f.path, value);
  }
  return config;
}

const SECRET_TYPES = new Set(['password']);

function maskValue(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** 给界面用的当前值。密钥只回传掩码，绝不把明文发回浏览器。 */
export function readableSettings() {
  const o = load();
  return {
    groups: GROUPS,
    fields: SCHEMA.map((f) => {
      const current = getIn(config, f.path);
      const isSecret = SECRET_TYPES.has(f.type);
      return {
        key: f.key,
        label: f.label,
        help: f.help || '',
        group: f.group,
        type: f.type,
        env: f.env,
        options: f.options,
        min: f.min,
        max: f.max,
        placeholder: f.placeholder,
        // 密钥只给掩码和「有没有值」，明文不出服务端
        value: isSecret ? undefined : Array.isArray(current) ? current.join(', ') : current,
        masked: isSecret ? maskValue(current) : undefined,
        hasValue: isSecret ? Boolean(current) : undefined,
        overridden: f.key in o,
        source: f.key in o ? '界面设置' : '.env 或默认值',
      };
    }),
  };
}

/**
 * 保存设置。
 * 密钥字段留空表示「不改」，而不是「清空」——否则界面只显示掩码，
 * 用户随便改个别的字段一保存，所有密钥就都被清掉了。
 * 要真的清空，传特殊值 __CLEAR__。
 */
export function saveSettings(patch = {}) {
  const o = load();
  const changed = [];

  for (const [key, raw] of Object.entries(patch)) {
    const f = BY_KEY[key];
    if (!f) continue;

    if (SECRET_TYPES.has(f.type)) {
      if (raw === '' || raw == null) continue; // 没动
      if (raw === '__CLEAR__') {
        o[key] = '';
        setIn(config, f.path, '');
        changed.push(key);
        continue;
      }
    }

    const value = coerce(f, raw);
    if (value === null) continue;
    o[key] = value;
    setIn(config, f.path, value);
    changed.push(key);
  }

  overrides = o;
  persist();
  return { ok: true, changed };
}

export function resetSetting(key) {
  const o = load();
  if (!(key in o)) return { ok: true, changed: [] };
  delete o[key];
  overrides = o;
  persist();
  // 删掉覆盖后要恢复成 .env 的值 —— 最省事也最不易错的做法是重启，
  // 但为了不打断会议，这里只提示，实际值下次启动生效。
  return { ok: true, changed: [key], needsRestart: true };
}

// ---------------- 连通性测试 ----------------

/** 一个最小的合法 wav：44 字节头 + 0.1 秒静音 */
function probeWav() {
  const sampleRate = 8000;
  const samples = 800;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** 测转写服务：发一段极短的静音音频过去，能返回就算通。两种接口形态都要覆盖。 */
export async function testAsr() {
  if (!config.asr.apiKey) return { ok: false, error: '还没有填转写服务密钥' };

  const { detectProvider } = await import('./asr.js');
  const provider = detectProvider();
  const buf = probeWav();

  try {
    let res;
    if (provider === 'mimo') {
      res = await fetch(`${config.asr.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.asr.apiKey,
          Authorization: `Bearer ${config.asr.apiKey}`,
        },
        body: JSON.stringify({
          model: config.asr.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${buf.toString('base64')}` } },
              ],
            },
          ],
          asr_options: { language: 'auto' },
        }),
        signal: AbortSignal.timeout(30000),
      });
    } else {
      const form = new FormData();
      form.append('file', new Blob([buf]), 'probe.wav');
      form.append('model', config.asr.model);
      res = await fetch(`${config.asr.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.asr.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
    }

    if (res.ok) {
      return {
        ok: true,
        message: `连通正常 · ${provider === 'mimo' ? '小米 MiMo' : 'OpenAI 兼容'} 接口 · 模型 ${config.asr.model}`,
      };
    }

    const text = await res.text().catch(() => '');
    // 404 基本就是接口类型选错了，直接把话说明白
    const hint =
      res.status === 404
        ? provider === 'mimo'
          ? '　（404：确认地址是 https://api.xiaomimimo.com/v1）'
          : '　（404：如果你用的是小米 MiMo，把「转写接口类型」改成「小米 MiMo」——它的接口路径和 OpenAI 不一样）'
        : '';
    return { ok: false, error: `服务返回 ${res.status}${hint}：${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `连不上：${e.message}` };
  }
}

/** 测纪要模型：问一句最短的话。 */
export async function testLlm() {
  if (!config.llm.apiKey) return { ok: false, error: '还没有填纪要模型密钥' };
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: 'user', content: '回复"ok"两个字符，不要别的内容。' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `服务返回 ${res.status}：${text.slice(0, 200)}` };
    }
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    return { ok: true, message: `连通正常，模型 ${config.llm.model} 回复：${String(reply).slice(0, 40)}` };
  } catch (e) {
    return { ok: false, error: `连不上：${e.message}` };
  }
}

/** 测推送渠道：真发一条测试消息过去。 */
export async function testNotify(channel) {
  const { pushSummary } = await import('./notify.js');
  const { listMeetings } = await import('./store.js');

  const withSummary = listMeetings().find((m) => m.hasSummary);
  if (withSummary) {
    const r = await pushSummary(withSummary.meetingId, { only: [channel] });
    const failed = r.failed?.find((f) => f.channel === channel);
    if (failed) return { ok: false, error: failed.error };
    if (r.sent?.includes(channel)) return { ok: true, message: '测试消息已发出，去群里/邮箱确认一下' };
    return { ok: false, error: '这个渠道还没配置' };
  }
  return { ok: false, error: '还没有任何已生成纪要的会议，无法发测试消息。先开一场会并生成纪要。' };
}
