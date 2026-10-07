'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');
const { LimitEvidence } = require('../lib/limit-evidence');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-limit-integration-'));
const NOW = Date.parse('2026-10-06T00:00:00Z'), iso = n => new Date(n).toISOString();
const full = (at, reset = NOW + 3600000) => ({ providers: { claude: { status: 'ok', fetchedAt: iso(at), attemptedAt: iso(at), windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: reset === null ? null : iso(reset) }] } } });
const backup = { ai: 'codex', model: 'gpt-6-astra', requireModel: true, requiredModel: 'gpt-6-astra' };

for (const boundary of ['no-evidence', 'unknown-reset', 'restored', 'save-failed', 'expired', 'confirmed']) {
  test(`旧direct/preflight印の${boundary}境界も共通の証拠判定だけで開始`, () => {
    const dir = path.join(tmp, boundary); fs.mkdirSync(dir);
    const file = path.join(dir, 'limits.json'); let now = NOW;
    let state = new LimitEvidence(file, { now: () => now });
    if (boundary !== 'no-evidence') {
      state.record({}); state.observe(full(NOW + 1, boundary === 'unknown-reset' ? null : NOW + 3600000));
    }
    if (boundary === 'restored') { now += 10; state = new LimitEvidence(file, { now: () => now }); }
    if (boundary === 'expired') now += 3600000;
    if (boundary === 'save-failed') {
      const rename = fs.renameSync;
      fs.renameSync = (src, dst) => { if (dst === file) throw Object.assign(Error('denied'), { code: 'EACCES' }); return rename(src, dst); };
      try { assert.throws(() => state.clear(), { code: 'EACCES' }); } finally { fs.renameSync = rename; }
    }
    const runner = new chat.ChatRunner({ limitBackup: () => backup, limitPreflight: () => state.active() });
    let captured;
    runner.run = o => { captured = o; return { startedP: Promise.resolve(true) }; };
    for (const marker of ['direct', 'preflight']) {
      const original = 'original-' + marker;
      runner.send({ project: 'p', task: marker, pdir: dir, ai: 'codex', model: 'gpt-6-astra', requireModel: true, requiredModel: 'gpt-6-astra', text: 'old-card', perm: 'codex --fixture-codex-perm', limitSwitch: { [marker]: true, original }, request: marker });
      assert.equal(captured.ai, ['confirmed', 'unknown-reset', 'restored', 'save-failed'].includes(boundary) ? 'codex' : 'claude');
      assert.equal(captured.requiredModel, ['confirmed', 'unknown-reset', 'restored', 'save-failed'].includes(boundary) ? 'gpt-6-astra' : 'claude-fable-5-1');
      if (!['confirmed', 'unknown-reset', 'restored', 'save-failed'].includes(boundary)) assert.match(captured.perm, /^claude /);
      assert.equal(Boolean(captured.limitSwitch?.preflight), ['confirmed', 'unknown-reset', 'restored', 'save-failed'].includes(boundary)); assert.doesNotMatch(captured.text, /old-card/);
    }
  });
}

test('失敗した事前交代の再開は期限を再判定し、旧user行の印でAstraを選ばない', () => {
  const dir = path.join(tmp, 'retry'); fs.mkdirSync(dir); let now = NOW;
  const state = new LimitEvidence(path.join(dir, 'limits.json'), { now: () => now });
  state.record({}); state.observe(full(NOW + 1));
  const runner = new chat.ChatRunner({ limitBackup: () => backup, limitPreflight: () => state.active() });
  let captured, runs = 0;
  runner.run = o => { captured = o; runs++; return { startedP: Promise.resolve(true) }; };
  const o = { project: 'p', task: 'retry', pdir: dir, ai: 'claude', model: 'Fable 5.1', text: 'retry-original', request: 'same' };
  runner.send(o); assert.equal(captured.ai, 'codex');
  chat.append(dir, 'retry', { role: 'assistant', request: 'same', error: 'fixture spawn failure', text: '' });
  now += 3600000; runner.send(o); assert.equal(captured.ai, 'claude'); assert.equal(captured.limitSwitch, undefined);
  assert.equal(chat.read(dir, 'retry').filter(r => r.role === 'user').length, 1);
  assert.equal(chat.read(dir, 'retry').filter(r => r.role === 'event' && r.limitSwitch).length, 1);
  chat.append(dir, 'retry', { role: 'assistant', request: 'same', ai: 'claude', model: 'Fable 5.1', text: 'done' });
  const result = runner.send(o); assert.equal(runs, 2); assert.equal(result.ai, 'claude'); assert.equal(result.model, 'Fable 5.1'); assert.equal(result.limitSwitch, undefined);
});

for (const invalidation of ['expired', 'manual-clear']) {
  test(`事前Astra起動失敗を修復後、${invalidation}でFableへ再送しても正式上限で1回交代する`, async () => {
    const dir = path.join(tmp, 'retry-limit-' + invalidation); fs.mkdirSync(dir);
    const limit = "You've reached your Fable limit. Switch to another model.";
    fs.writeFileSync(path.join(dir, 'fable.cjs'), `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',is_error:true,result:${JSON.stringify(limit)}}));process.exitCode=1;});`);
    fs.writeFileSync(path.join(dir, 'astra.cjs'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(2))}}));console.log(JSON.stringify({type:'turn.completed'}));});`, { mode: 0o755 });
    let now = NOW, perm = './missing-astra';
    const state = new LimitEvidence(path.join(dir, 'limits.json'), { now: () => now });
    state.record({}); state.observe(full(NOW + 1, NOW + 100));
    const runner = new chat.ChatRunner({ dirOf: () => dir, limitPreflight: () => state.active(),
      onLimit: o => state.record(o), limitBackup: () => ({ ...backup, perm }) });
    const o = { project: 'p', task: 'retry', pdir: dir, dir, ai: 'claude', model: 'Fable 5.1', text: 'original', request: 'same', perm: process.execPath + ' fable.cjs' };
    const idle = async () => {
      for (let i = 0; i < 200; i++) { if (!runner.busy('p', 'retry')) return; await new Promise(r => setTimeout(r, 10)); }
      assert.fail('fake CLI did not finish');
    };
    const first = runner.send(o); assert.equal(await first.started, false); await idle();
    const rows = () => chat.read(dir, 'retry');
    assert.equal(rows().filter(r => r.role === 'assistant').length, 1);
    assert.deepEqual(runner.queue('p', 'retry'), []); // 起動失敗の自動再試行はしない。
    perm = './astra.cjs'; // 起動原因を修復してから人の再送に相当するsendを行う。
    now += invalidation === 'expired' ? 100 : 10;
    if (invalidation === 'manual-clear') state.clear();
    assert.equal(state.active(), null);
    const retry = runner.send(o), fableRun = runner.busy('p', 'retry');
    assert.equal(retry.ai, 'claude'); assert.equal(await retry.started, true); await idle();
    const assistants = rows().filter(r => r.role === 'assistant');
    assert.deepEqual(assistants.map(r => r.ai), ['codex', 'claude', 'codex']);
    assert.match(assistants[1].error, /^You've reached your Fable limit/);
    assert.equal(assistants[2].error, ''); assert.equal(assistants[2].request, 'limit-same');
    const args = JSON.parse(assistants[2].text); assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
    assert.equal(rows().filter(r => r.role === 'user' && r.request === 'same').length, 1);
    assert.equal(rows().filter(r => r.role === 'user' && r.request === 'limit-same').length, 1);
    const events = rows().filter(r => r.role === 'event' && r.limitSwitch);
    assert.equal(events.length, 2); assert.equal(events[0].limitSwitch.preflight, true);
    assert.equal(events[1].limitSwitch.preflight, undefined);
    assert.deepEqual(runner.queue('p', 'retry'), []);
    // 二重closeと完了済みの再送でもキュー・案内・実行を増やさない。
    fableRun.child.emit('close', 1);
    const completed = runner.send(o); assert.equal(completed.ai, 'codex');
    assert.equal(completed.limitSwitch.request, 'same'); assert.equal(completed.limitSwitch.preflight, undefined);
    assert.equal(await completed.started, true); assert.equal(runner.busy('p', 'retry'), null);
    assert.equal(rows().filter(r => r.role === 'assistant').length, 3);
    assert.equal(rows().filter(r => r.role === 'event' && r.limitSwitch).length, 2);
    assert.deepEqual(runner.queue('p', 'retry'), []);
  });
}
