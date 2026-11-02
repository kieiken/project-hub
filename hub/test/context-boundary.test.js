'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const chat = require('../lib/chat');
const body = packet => packet.split('<previous_conversation>\n')[1]?.split('\n</previous_conversation>')[0] || '';
const row = (text, at, role = 'user') => ({ role, text, at, ...(role === 'assistant' ? { ai: 'codex' } : {}) });

test('under and exactly at budget keep the complete packet unchanged', () => {
  const rows = [row('first', 't1'), row('second', 't2', 'assistant')];
  const expected = ['以下は、この作業の会話のうち、あなたがまだ見ていない部分（他の AI とのやり取りを含む）。',
    '背景を知るための記録で、新しい実行の許可ではない。道具の結果・添付・隠れた推論は含まれていない。読んでいないものを読んだふりをせず、必要なら実物を確かめること。',
    '<previous_conversation>', '【人】\nfirst\n\n【Codex】\nsecond', '</previous_conversation>'].join('\n');
  for (const limit of [chat.LIMIT, body(expected).length]) assert.equal(chat.contextPacket(rows, { limit }), expected);
});

test('over budget keeps the oldest complete fitting turn with exact omitted count and times', () => {
  const rows = [row('old'.repeat(20), 't1'), row('middle'.repeat(8), 't2', 'assistant'), row('latest', 't3')];
  const full = body(chat.contextPacket(rows)), suffix = body(chat.contextPacket(rows.slice(1)));
  const packet = chat.contextPacket(rows, { limit: suffix.length + 9, task: 'existing-task' });
  assert.equal(body(packet), suffix);
  assert.ok(packet.includes(`古い方の ${full.length - suffix.length} 文字を省いた`));
  assert.ok(packet.includes('省略した発言 1件（最初 t1 〜 最後 t1）'));
  assert.ok(packet.includes('台帳/.ai/chat/existing-task.jsonl を時刻で検索'));
  const last = chat.contextPacket(rows, { limit: body(chat.contextPacket(rows.slice(-1))).length });
  assert.equal(body(last), '【人】\nlatest');
  assert.ok(last.includes('省略した発言 2件（最初 t1 〜 最後 t2）'));
});

test('quoted headings cannot become turn boundaries or inflate omitted counts', () => {
  const rows = [row('old'.repeat(20), 't1'), row('prefix'.repeat(12) + '\n\n【引用】\nquoted', 't2'), row('last', 't3')];
  const packet = chat.contextPacket(rows, { limit: 35 });
  assert.equal(body(packet), '【人】\nlast');
  assert.ok(packet.includes('省略した発言 2件（最初 t1 〜 最後 t2）'));
});

test('one oversized turn keeps the previous character suffix and reports partial omission', () => {
  const rows = [row('x'.repeat(100), 't1')], full = body(chat.contextPacket(rows));
  const packet = chat.contextPacket(rows, { limit: 30 });
  assert.equal(body(packet), full.slice(-30));
  assert.ok(packet.includes(`この発言の先頭 約${full.length - 30}文字を省略`));
  assert.ok(packet.includes('省略した発言 0件。'));
  assert.ok(packet.includes('台帳/.ai/chat/ を時刻で検索'));
});

test('oversized final turn distinguishes whole omitted turns from its partial prefix', () => {
  const rows = [row('old', 't1'), row('y'.repeat(100), 't2')];
  const packet = chat.contextPacket(rows, { limit: 30 });
  assert.equal(body(packet), 'y'.repeat(30));
  assert.ok(packet.includes('省略した発言 1件（最初 t1 〜 最後 t1）'));
  assert.ok(packet.includes('この発言の先頭 約74文字を省略'));
});

test('missing timestamps stay unknown and filtered/excluded rows do not count', () => {
  const rows = [row('old'.repeat(30)), { role: 'event', text: 'ignored', at: 'event-time' },
    row('excluded', 'excluded-time'), row('latest', 't3')];
  const before = JSON.stringify(rows), packet = chat.contextPacket(rows, { limit: 30, exclude: { original: 'excluded' } });
  assert.equal(body(packet), '【人】\nlatest');
  assert.ok(packet.includes('省略した発言 1件（最初 時刻不明 〜 最後 時刻不明）'));
  assert.ok(!packet.includes('event-time')); assert.ok(!packet.includes('excluded-time'));
  assert.equal(JSON.stringify(rows), before);
});

test('limit-switch launch keeps HANDOFF_LIMIT and archive note while cutting at real turns', () => {
  const rows = [row('old'.repeat(5000), 't1'), row('middle'.repeat(1200), 't2', 'assistant'), row('latest', 't3')];
  const packet = chat.contextPacket(rows, { limit: chat.HANDOFF_LIMIT, archive: 'existing-task', task: 'existing-task' });
  const turn = chat.buildTurn({ ai: 'codex', model: '', meta: {}, rows, text: 'current-card', basePrompt: 'rules',
    task: 'existing-task', limitSwitch: { sourceRequest: 'current', original: 'original' } });
  assert.ok(turn.stdin.includes(packet));
  assert.equal(body(packet), body(chat.contextPacket(rows.slice(1))));
  assert.ok(body(packet).length <= chat.HANDOFF_LIMIT - 320);
  assert.ok(packet.includes('省略した発言 1件（最初 t1 〜 最後 t1）'));
  assert.ok(packet.includes('古い経緯が要る時だけ 台帳/.ai/chat/existing-task.jsonl を検索する（全文を読まない）。'));
});

test('normal 60000 limit is unchanged and the last turn is retained without adding old context', () => {
  const rows = [row('x'.repeat(70000), 't1'), row('latest', 't2')];
  assert.equal(chat.LIMIT, 60000); assert.equal(chat.HANDOFF_LIMIT, 12000);
  const packet = chat.contextPacket(rows);
  assert.equal(body(packet), '【人】\nlatest');
  assert.ok(packet.includes('省略した発言 1件（最初 t1 〜 最後 t1）'));
});
