import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { meetingDir, readMeeting } from './store.js';

/**
 * 纪要自动推送。
 * 三个渠道各自独立：.env 里配了哪个就发哪个，没配的静默跳过。
 * 任何一个渠道失败都不影响其它渠道，也不影响纪要本身已经生成好的事实。
 */

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分钟` : `${min} 分钟`;
}

/** 收集一场会议的推送素材 */
export function buildPayload(meetingId) {
  const m = readMeeting(meetingId);
  if (!m) throw new Error('会议不存在');
  const dir = meetingDir(meetingId);

  const read = (f) => {
    const p = path.join(dir, f || '');
    return f && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };

  const summary = read(m.artifacts?.summary);
  const transcript = read(m.artifacts?.transcript);
  let actions = [];
  try {
    actions = JSON.parse(read(m.artifacts?.actions) || '[]');
  } catch { /* 忽略 */ }

  const speakers = Object.values(m.participants || {}).map((p) => p.name);
  const durationMs = (m.endedAt || Date.now()) - m.startedAt;

  return {
    meetingId,
    title: m.title || m.roomId,
    dateText: new Date(m.startedAt).toLocaleString('zh-CN', { hour12: false }),
    durationText: fmtDuration(durationMs),
    speakers,
    summary,
    transcript,
    actions,
    stats: m.stats || [],
    link: config.notify.baseUrl ? `${config.notify.baseUrl.replace(/\/$/, '')}/#/archive/${meetingId}` : '',
    dir,
    artifacts: m.artifacts || {},
  };
}

function truncate(text, max, tail = '\n\n…（内容较长，已截断，完整纪要见系统）') {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - tail.length) + tail;
}

// ---------------- 企业微信 ----------------

async function sendWeCom(p) {
  const url = config.notify.wecomWebhook;
  if (!url) return { channel: 'wecom', skipped: true };

  // 企业微信 markdown 上限 4096 字节，中文一个字 3 字节，保守按 1200 字截
  const head = [
    `## 会议纪要：${p.title}`,
    `> 时间：${p.dateText}　时长：${p.durationText}`,
    `> 参会：${p.speakers.join('、') || '—'}`,
    '',
  ].join('\n');
  const link = p.link ? `\n\n[查看完整纪要与录音](${p.link})` : '';
  const body = truncate(p.summary || '（本场会议未生成纪要）', 1200);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: head + body + link } }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errcode && data.errcode !== 0) throw new Error(`企业微信返回 ${data.errcode}: ${data.errmsg}`);
  return { channel: 'wecom', ok: true };
}

// ---------------- 飞书 ----------------

function feishuSign(secret, timestamp) {
  const str = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', str).update(Buffer.alloc(0)).digest('base64');
}

async function sendFeishu(p) {
  const url = config.notify.feishuWebhook;
  if (!url) return { channel: 'feishu', skipped: true };

  const elements = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${p.dateText}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**时长**\n${p.durationText}` } },
        { is_short: false, text: { tag: 'lark_md', content: `**参会人**\n${p.speakers.join('、') || '—'}` } },
      ],
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: truncate(p.summary || '（本场会议未生成纪要）', 2500) } },
  ];

  if (p.actions?.length) {
    const lines = p.actions
      .slice(0, 10)
      .map((a) => `• ${a.task}　—　${a.owner ? '@' + a.owner : '未指派'}${a.due ? '（' + a.due + '）' : ''}`)
      .join('\n');
    elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: `**待办事项**\n${lines}` } });
  }

  if (p.link) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看完整纪要与录音' }, url: p.link, type: 'primary' }],
    });
  }

  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `会议纪要：${p.title}` }, template: 'blue' },
      elements,
    },
  };

  // 飞书机器人如果开了签名校验，要带上 timestamp + sign
  if (config.notify.feishuSecret) {
    payload.timestamp = String(Math.floor(Date.now() / 1000));
    payload.sign = feishuSign(config.notify.feishuSecret, payload.timestamp);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code && data.code !== 0) throw new Error(`飞书返回 ${data.code}: ${data.msg}`);
  return { channel: 'feishu', ok: true };
}

// ---------------- 邮件 ----------------

function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(@[一-龥A-Za-z0-9_·-]{1,24})/g, '<span style="color:#2563eb;font-weight:600">$1</span>');

  const out = [];
  let inList = false;
  let inTable = false;
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const tr = line.match(/^\s*\|(.+)\|\s*$/);

    if (!li && inList) { out.push('</ul>'); inList = false; }
    if (!tr && inTable) { out.push('</table>'); inTable = false; }

    if (h) {
      const size = [0, 20, 16, 14, 13][h[1].length];
      out.push(`<h${h[1].length} style="font-size:${size}px;margin:18px 0 6px">${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px">'); inList = true; }
      out.push(`<li style="margin:4px 0">${inline(li[1])}</li>`);
    } else if (tr) {
      if (/^[\s:|-]+$/.test(tr[1])) continue;
      if (!inTable) { out.push('<table style="border-collapse:collapse;width:100%;font-size:13px;margin:10px 0">'); inTable = true; }
      const cells = tr[1].split('|').map((c) => c.trim());
      out.push('<tr>' + cells.map((c) => `<td style="border:1px solid #ddd;padding:6px 9px">${inline(c)}</td>`).join('') + '</tr>');
    } else if (line.trim()) {
      out.push(`<p style="margin:7px 0">${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  if (inTable) out.push('</table>');
  return out.join('\n');
}

async function sendEmail(p) {
  const c = config.notify.smtp;
  if (!c.host || !config.notify.mailTo.length) return { channel: 'email', skipped: true };

  // nodemailer 是可选依赖，没装就明确报错而不是静默失败
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('未安装 nodemailer，无法发邮件。执行：npm --workspace server install nodemailer');
  }

  const transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });

  const attachments = [];
  if (config.notify.mailAttach) {
    for (const [label, f] of [['纪要', p.artifacts.summary], ['逐字稿', p.artifacts.transcript]]) {
      const full = f && path.join(p.dir, f);
      if (full && fs.existsSync(full)) {
        attachments.push({ filename: `${p.title}-${label}.md`, path: full });
      }
    }
  }

  const html = `
    <div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:720px;color:#1a1a1a;line-height:1.7">
      <h2 style="margin:0 0 4px">会议纪要：${p.title}</h2>
      <p style="color:#666;font-size:13px;margin:0 0 16px">
        ${p.dateText} · ${p.durationText} · 参会：${p.speakers.join('、') || '—'}
      </p>
      <hr style="border:0;border-top:1px solid #e5e5e5" />
      ${mdToHtml(p.summary || '（本场会议未生成纪要）')}
      ${p.link ? `<p style="margin-top:24px"><a href="${p.link}" style="background:#2563eb;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;display:inline-block">查看完整纪要与录音</a></p>` : ''}
      <p style="color:#999;font-size:12px;margin-top:28px">本邮件由 InsideMeeting 自动发送。</p>
    </div>`;

  await transporter.sendMail({
    from: c.from || c.user,
    to: config.notify.mailTo.join(','),
    subject: `[会议纪要] ${p.title} · ${p.dateText}`,
    html,
    attachments,
  });
  return { channel: 'email', ok: true, to: config.notify.mailTo.length };
}

// ---------------- 统一入口 ----------------

const CHANNELS = { wecom: sendWeCom, feishu: sendFeishu, email: sendEmail };

export function enabledChannels() {
  return {
    wecom: Boolean(config.notify.wecomWebhook),
    feishu: Boolean(config.notify.feishuWebhook),
    email: Boolean(config.notify.smtp.host && config.notify.mailTo.length),
  };
}

/**
 * 推送一场会议的纪要。
 * @param {string[]} only 只发指定渠道，不传则发所有已配置的渠道
 */
export async function pushSummary(meetingId, { only } = {}) {
  if (!config.notify.enabled) return { skipped: '推送功能未开启（NOTIFY_ENABLED=false）' };

  const payload = buildPayload(meetingId);
  const names = only?.length ? only : Object.keys(CHANNELS);
  const results = [];

  for (const name of names) {
    const fn = CHANNELS[name];
    if (!fn) continue;
    try {
      results.push(await fn(payload));
    } catch (e) {
      // 一个渠道挂了不影响其它渠道
      results.push({ channel: name, ok: false, error: e.message });
    }
  }

  const sent = results.filter((r) => r.ok).map((r) => r.channel);
  const failed = results.filter((r) => r.ok === false);
  return { sent, failed, results };
}
