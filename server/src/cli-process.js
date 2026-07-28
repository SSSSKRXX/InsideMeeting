#!/usr/bin/env node
/**
 * 命令行触发会议后处理（转写 + 纪要），便于放进 crontab 夜间批处理。
 *   node server/src/cli-process.js <meetingId>
 *   node server/src/cli-process.js --all         处理所有还没出纪要的会议
 */
import { listMeetings } from './store.js';
import { processMeeting, jobStatus } from './pipeline.js';

const args = process.argv.slice(2);

async function runOne(id) {
  process.stdout.write(`\n▶ 处理 ${id}\n`);
  const timer = setInterval(() => {
    const j = jobStatus(id);
    if (j) process.stdout.write(`\r  ${String(j.progress).padStart(3)}%  ${j.message}          `);
  }, 1000);
  const res = await processMeeting(id, { force: true });
  clearInterval(timer);
  process.stdout.write('\n');
  if (res.state === 'error') console.error(`  ✗ 失败：${res.error}`);
  else console.log('  ✓ 完成');
  return res.state !== 'error';
}

if (!args.length) {
  console.log('用法：node server/src/cli-process.js <meetingId> | --all | --list');
  process.exit(1);
}

if (args[0] === '--list') {
  for (const m of listMeetings()) {
    console.log(
      `${m.meetingId}\t${new Date(m.startedAt).toLocaleString('zh-CN')}\t${Math.round(m.durationMs / 60000)}分钟\t${m.hasSummary ? '已出纪要' : '未处理'}\t${m.participants.join(',')}`
    );
  }
  process.exit(0);
}

const targets = args[0] === '--all' ? listMeetings().filter((m) => !m.hasSummary).map((m) => m.meetingId) : args;
let ok = 0;
for (const id of targets) if (await runOne(id)) ok++;
console.log(`\n共 ${targets.length} 场，成功 ${ok} 场。`);
