import { config } from './config.js';

export async function chat(messages, { temperature = 0.2, maxTokens = 4000 } = {}) {
  if (!config.llm.apiKey) throw new Error('未配置 LLM_API_KEY，无法生成纪要');

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 失败 ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

const SYSTEM = `你是一名资深会议纪要撰写者。你会收到一份带时间戳和发言人标注的会议逐字稿。

严格要求：
1. 涉及到具体的人时，必须使用 @发言人姓名 的形式，姓名必须与逐字稿中出现的完全一致，不得杜撰。
2. 只写逐字稿里真实出现的内容，不要推测、不要补充背景知识。逐字稿由语音识别生成，可能有错别字，请结合上下文理解，但不要编造事实。
3. 结论、决定、待办必须能追溯到具体发言人。
4. 输出中文 Markdown。`;

const OUTLINE = `请按以下结构输出：

# 会议纪要

## 一句话总结
（不超过 60 字）

## 关键结论与决定
- 每条一句话，标注是谁拍板的，如：@张三 确认 xxx 方案本周落地。

## 分议题纪要
### 议题一：xxx
- @张三：观点/信息
- @李四：观点/信息
- **共识**：xxx（若无共识则写"未达成一致"）

## 待办事项
| 事项 | 负责人 | 截止时间 | 来源 |
|---|---|---|---|
| xxx | @张三 | 逐字稿中提到的时间，没提到写"未明确" | [00:12:30] |

## 悬而未决 / 需要跟进
- @李四 提出的 xxx 尚未确认由谁负责。

## 发言人画像
- @张三：本场主要讨论了 xxx（1 句话）`;

function splitChunks(text, maxChars) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxChars && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export async function summarizeTranscript(transcriptText, meta = {}) {
  const header = [
    meta.title ? `会议主题：${meta.title}` : null,
    meta.dateText ? `会议时间：${meta.dateText}` : null,
    meta.durationText ? `会议时长：${meta.durationText}` : null,
    meta.speakers?.length ? `参会人：${meta.speakers.join('、')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const chunks = splitChunks(transcriptText, config.llm.maxCharsPerChunk);

  // 短会：一次成稿
  if (chunks.length <= 1) {
    return chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${header}\n\n${OUTLINE}\n\n---- 逐字稿开始 ----\n${transcriptText}\n---- 逐字稿结束 ----` },
    ]);
  }

  // 长会：先分段提炼，再汇总成稿（map-reduce）
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await chat([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `${header}\n\n这是会议逐字稿的第 ${i + 1}/${chunks.length} 部分。` +
          `请提炼这一部分的：讨论要点（用 @发言人 标注）、达成的结论、产生的待办、遗留问题。` +
          `保留原始时间戳。不要写总结性套话。\n\n---- 片段开始 ----\n${chunks[i]}\n---- 片段结束 ----`,
      },
    ], { maxTokens: 2500 });
    partials.push(`### 第 ${i + 1} 部分\n${part}`);
  }

  return chat([
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `${header}\n\n以下是同一场会议按时间顺序分段提炼的要点，请合并去重，写成一份完整的会议纪要。\n\n${OUTLINE}\n\n${partials.join('\n\n')}`,
    },
  ], { maxTokens: 4000 });
}

/** 让 LLM 从逐字稿里抽结构化待办，便于导入其它系统 */
export async function extractActionItems(transcriptText) {
  const raw = await chat([
    {
      role: 'system',
      content: '你从会议逐字稿中抽取待办事项，只输出 JSON 数组，不要任何解释文字或代码块标记。',
    },
    {
      role: 'user',
      content:
        `逐字稿如下。抽取所有明确的待办/承诺/下一步动作。\n` +
        `输出 JSON 数组，每项字段：{"task":"事项","owner":"负责人姓名，未明确填 null","due":"截止时间原文，未明确填 null","timestamp":"[hh:mm:ss]","quote":"原话片段"}。\n` +
        `没有待办就输出 []。\n\n${transcriptText.slice(0, config.llm.maxCharsPerChunk)}`,
    },
  ], { temperature: 0 });

  const cleaned = raw.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
