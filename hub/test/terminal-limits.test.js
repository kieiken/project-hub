'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { TerminalLimits, capture, readError } = require('../lib/terminal-limits');
const { ModelLimits } = require('../lib/model-limits');
const NOW = Date.now(), FORMAL = "You've reached your 5-hour limit. Try again later.";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-limits-'));
  const home = path.join(dir, 'account'), logs = path.join(home, 'projects', 'project'); fs.mkdirSync(logs, { recursive: true });
  const state = new ModelLimits(path.join(dir, 'limits.json'), { now: () => NOW + 10 });
  const s = { ai: 'claude', model: 'Opus 5.5', role: '調査', account: 'work', dir, started: NOW, lastOut: NOW, exited: false, stopped: false, code: null, limitWatch: capture('claude', home, 'unique-terminal') };
  s.finishedP = new Promise(resolve => s.finish = resolve);
  const log = path.join(logs, 'session.jsonl');
  const line = value => JSON.stringify({ timestamp: new Date(NOW + 1).toISOString(), ...value }) + '\n';
  fs.writeFileSync(log, line({ type: 'user', cwd: dir, message: { content: [{ type: 'text', text: 'unique-terminal' }] } }));
  const append = value => fs.appendFileSync(log, line(value));
  const trace = [], notices = [];
  s.proc = { kill() { trace.push('kill'); s.exited = true; s.code = 143; s.finish(); } };
  const sessions = { list: () => [{ project: 'p', task: 't', ai: 'claude', running: !s.exited }], get: () => s };
  const supervisor = new TerminalLimits({ sessions, limits: state, enabled: () => true, backup: () => ({ ai: 'codex', model: 'GPT-6.1-Sol' }), now: () => NOW + 25000, handoff: async (_, src) => { assert.equal(src.exited, true); trace.push('handoff'); }, notify: (_, text) => notices.push(text) });
  return { dir, s, log, line, append, trace, notices, state, supervisor };
}
test('ターミナル正式上限は同一アカウント/場所/開始印の増分だけ読み、終了後1回引き渡す', async () => {
  const f = setup(); f.append({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: FORMAL }] } });
  await f.supervisor.tick(); await f.supervisor.tick();
  assert.deepEqual(f.trace, ['kill', 'handoff']); assert.equal(f.state.active('work', 'claude-opus-5-5').source, 'cli-limit'); assert.equal(f.state.active('default', 'claude-opus-5-5'), null);
});
test('引用・画面文字・別セッションの同じ場所のエラーを証拠にしない', async () => {
  const f = setup(); f.s.buf = FORMAL;
  f.append({ type: 'assistant', message: { content: [{ type: 'text', text: FORMAL }] } });
  const other = path.join(path.dirname(f.log), 'other.jsonl');
  fs.writeFileSync(other, f.line({ type: 'user', cwd: f.dir, message: { content: [{ type: 'text', text: 'other-terminal' }] } }) + f.line({ type: 'result', is_error: true, result: FORMAL }));
  await f.supervisor.tick(); assert.deepEqual(f.trace, []); assert.equal(f.state.list({ claude: 'work' }).length, 0);
});
test('古いエラーは無視し、途中JSON行は完成してから読む', () => {
  const f = setup(); f.append({ timestamp: new Date(NOW - 10).toISOString(), type: 'result', is_error: true, result: FORMAL });
  assert.equal(readError(f.s), null);
  const data = f.line({ type: 'result', is_error: true, result: FORMAL }); const mid = Math.floor(data.length / 2);
  fs.appendFileSync(f.log, data.slice(0, mid)); assert.equal(readError(f.s), null);
  fs.appendFileSync(f.log, data.slice(mid)); assert.equal(readError(f.s), FORMAL);
});
test('大きい履歴でも先頭の開始印と末尾の新しい正式エラーを読む', () => {
  const f = setup(); fs.appendFileSync(f.log, f.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(2500000) }] } }));
  f.append({ type: 'result', is_error: true, result: FORMAL }); assert.equal(readError(f.s), FORMAL);
});
test('100%はエラー終了で交代し、道具の長い静止/通常入力待ち/成功終了は止めない', async () => {
  const normal = setup(); await normal.supervisor.tick(); assert.deepEqual(normal.trace, []);
  const held = setup(); held.state.record({ ai: 'claude', model: 'Opus 5.5', account: 'work' }); await held.supervisor.tick(); assert.deepEqual(held.trace, []);
  held.s.exited = true; held.s.code = 1; await held.supervisor.check('p', 't', 'claude', held.s, true); assert.deepEqual(held.trace, ['handoff']);
  const success = setup(); success.state.record({ ai: 'claude', model: 'Opus 5.5', account: 'work' }); success.s.exited = true; success.s.code = 0;
  await success.supervisor.check('p', 't', 'claude', success.s, true); assert.deepEqual(success.trace, []);
});
test('人の停止・自動交代OFF・未設定の交代先では起動しない', async () => {
  for (const kind of ['stop', 'off', 'none']) {
    const f = setup(); f.append({ type: 'result', is_error: true, result: FORMAL });
    if (kind === 'stop') f.s.stopped = true;
    if (kind === 'off') f.supervisor.enabled = () => false;
    if (kind === 'none') f.supervisor.backup = () => null;
    await f.supervisor.tick(); assert.deepEqual(f.trace, []);
  }
});
test('終了中に人が停止した時と両側上限による引渡し拒否は復活させない', async () => {
  const f = setup(); f.append({ type: 'result', is_error: true, result: FORMAL }); f.s.proc.kill = () => { f.s.stopped = true; f.s.exited = true; f.s.finish(); };
  await f.supervisor.tick(); assert.deepEqual(f.trace, []);
  const both = setup(); both.append({ type: 'result', is_error: true, result: FORMAL }); both.supervisor.handoff = async () => { throw Error('両側上限・資料保存済み'); };
  await both.supervisor.tick(); await both.supervisor.tick(); assert.deepEqual(both.trace, ['kill']); assert.equal(both.notices.length, 1); assert.ok(both.state.active('work', 'claude-opus-5-5'));
});

test('実機Claude session/weekly/usageは入力待ちの元AI終了後に一度交代する', async () => {
  for (const text of ["You've hit your session limit · resets 3pm (Asia/Tokyo)", "You've hit your weekly limit · resets Oct 10 at 9am", "You've hit your usage limit."]) {
    const f = setup(); f.append({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    await f.supervisor.tick(); await f.supervisor.tick(); assert.deepEqual(f.trace, ['kill', 'handoff']);
    assert.ok(f.state.active('work', 'claude-opus-5-5'));
    if (text.includes('session limit')) assert.ok(f.state.active('work', 'claude-fable-5-2'));
  }
});
test('実機Codex task_complete上限は同一開始印・cwdのrolloutから検知し入力待ちでも一度交代する', async () => {
  for (const target of [{ ai: 'claude', model: 'Opus 5.5' }, { ai: 'agy', model: 'Gemini 3.1 Pro (High)' }]) {
    const f = setup(), home = path.join(f.dir, 'codex-account'), logs = path.join(home, 'sessions', '2026', '10', '08');
    fs.mkdirSync(logs, { recursive: true }); f.s.ai = 'codex'; f.s.model = 'GPT-6.1-Sol'; f.s.limitWatch = capture('codex', home, 'unique-terminal');
    const log = path.join(logs, 'rollout.jsonl'), formal = { type: 'event_msg', payload: { type: 'task_complete', error: { message: "You've hit your usage limit. Try again at 12:00." } } };
    fs.writeFileSync(log, f.line({ type: 'session_meta', payload: { cwd: f.dir } }) + f.line({ type: 'event_msg', payload: { type: 'user_message', message: 'unique-terminal' } }));
    fs.writeFileSync(path.join(logs, 'foreign.jsonl'), f.line({ type: 'session_meta', payload: { cwd: f.dir } }) + f.line({ type: 'event_msg', payload: { type: 'user_message', message: 'other-terminal' } }) + f.line(formal));
    fs.appendFileSync(log, f.line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: formal.payload.error.message } }));
    assert.equal(readError(f.s), null); assert.equal(f.s.exited, false);
    fs.appendFileSync(log, f.line(formal)); f.supervisor.backup = () => target;
    f.supervisor.handoff = async (o, src) => { assert.equal(o.ai, 'codex'); assert.equal(src.exited, true); f.trace.push(target.ai); };
    await f.supervisor.check('p', 't', 'codex', f.s); await f.supervisor.check('p', 't', 'codex', f.s);
    assert.deepEqual(f.trace, ['kill', target.ai]);
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) assert.ok(f.state.active('work', model));
    assert.equal(f.state.active('default', 'gpt-6.1-sol'), null);
  }
});
test('交代先なしでも正式上限を記録し、元AIを終了/交代させず一度だけ処理する', async () => {
  const f = setup(); f.supervisor.backup = () => null;
  f.append({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3pm (Asia/Tokyo)" }] } });
  let records = 0; const record = f.state.record.bind(f.state); f.state.record = o => { records++; record(o); };
  await f.supervisor.tick(); await f.supervisor.tick(); assert.equal(records, 1); assert.deepEqual(f.trace, []); assert.equal(f.s.exited, false);
  assert.ok(f.state.active('work', 'claude-opus-5-5')); assert.ok(f.state.active('work', 'claude-fable-5-2'));
});
