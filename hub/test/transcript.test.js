'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
// lib/transcript.js：交代の引き継ぎ資料（前の会話の文字だけを集める）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tr = require('../lib/transcript');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tr-'));
process.env.HUB_AI_HOME = home;
const work = path.join(home, 'work');
fs.mkdirSync(work);
const jl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

test('Claude Code の記録から、人と AI の文字だけを集める', () => {
  const d = path.join(home, '.claude', 'projects', '-x-work');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.jsonl'), jl([
    { type: 'user', cwd: work, message: { role: 'user', content: 'ボタンを直して' } },
    { type: 'assistant', cwd: work, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '秘密の推論' }, { type: 'text', text: '直しました' }, { type: 'tool_use', name: 'Edit' }] } },
    { type: 'user', cwd: work, message: { role: 'user', content: [{ type: 'tool_result', content: 'ツールの結果' }] } },
    { type: 'user', cwd: work, isMeta: true, message: { role: 'user', content: '<system-reminder>x' } },
  ]));
  const c = tr.collect({ ai: 'claude', dir: work, since: Date.now() - 1000 });
  assert.strictEqual(c.kind, 'log');
  assert.deepStrictEqual(c.msgs, [{ role: 'user', text: 'ボタンを直して' }, { role: 'assistant', text: '直しました' }]);
  const md = tr.packet({ fromLabel: 'Claude Code', toLabel: 'Codex', taskFile: 't.md', board: 'b.md', convo: c });
  assert.match(md, /### 人\nボタンを直して/);
  assert.doesNotMatch(md, /秘密の推論|ツールの結果/);
});

test('Codex の記録から集める（別のフォルダの会話は混ぜない）', () => {
  const d = path.join(home, '.codex', 'sessions', '2026', '09', '26');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-other.jsonl'), jl([{ type: 'session_meta', payload: { cwd: '/elsewhere' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '別の作業' }] } }]));
  fs.writeFileSync(path.join(d, 'rollout-a.jsonl'), jl([
    { type: 'session_meta', payload: { cwd: work } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'テストを足して' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '足しました' }] } },
  ]));
  const c = tr.collect({ ai: 'codex', dir: work, since: Date.now() - 1000 });
  assert.deepStrictEqual(c.msgs.map(m => m.text), ['テストを足して', '足しました']);
});

test('記録が無ければ画面の文字（制御文字を除き、同じ行は1回）で代わりにする。長すぎる時は古い方を省いたと書く', () => {
  const c = tr.collect({ ai: 'claude', dir: path.join(home, 'none'), since: Date.now(), buf: '\x1b[31m赤い字\x1b[0m\r\n赤い字\r\n次の行\x07' });
  assert.deepStrictEqual([c.kind, c.text], ['screen', '赤い字\n次の行']);
  const big = { kind: 'log', source: 'x', msgs: [{ role: 'user', text: 'あ'.repeat(tr.LIMIT + 10) }] };
  assert.match(tr.packet({ fromLabel: 'A', toLabel: 'B', taskFile: 't', board: 'b', convo: big }), /古い方の \d+ 文字を省いた/);
});
