'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const { ProblemResolution, MARKER } = require('../lib/problem-resolution');
function fixture(tasks = []) {
  const p = { id: 'P', name: '名前 <P>', dir: '/台帳/P', tasks }, calls = [];
  let checks = [{ name: '正常', ok: true }, { name: '作業場所：旧作業', ok: false, detail: '/missing <path>' }], active = false, blocked = false;
  const store = { createTask(project, spec) { calls.push({ create: spec }); const t = { id: 'new', state: '未着手', ...spec }; tasks.push(t); return t; } };
  const maintenance = { project: () => p, idle() { if (blocked) throw Error('整理中'); }, async verify() { this.idle(); calls.push({ verify: true }); return { checks }; } };
  const resolver = new ProblemResolution({ store, maintenance, pick: () => ({ ai: 'claude', model: 'Opus 5.5', effort: '高' }), validate() {},
    active: () => active, start: async b => { calls.push({ start: b }); return { status: 200, body: { ok: true, task: b.task } }; } });
  return { p, calls, resolver, checks: v => checks = v, active: v => active = v, blocked: v => blocked = v };
}
test('サーバー再確認で×がゼロなら作業も開始依頼も作らない', async () => {
  const f = fixture(); f.checks([{ name: '正常', ok: true }]);
  assert.equal((await f.resolver.solve('P')).clear, true); assert.deepEqual(f.calls, [{ verify: true }]);
});
test('親なしの目印付き作業と初期AIの開始依頼に×と修復ルールだけを含める', async () => {
  const f = fixture(), r = await f.resolver.solve('P'), b = f.calls.find(c => c.start).start;
  assert.equal(r.task, 'new'); assert.equal(r.reused, false);
  const spec = f.calls.find(c => c.create).create;
  assert.equal(spec.parent, ''); assert.equal(spec.title, '問題解決'); assert.equal(spec.via, MARKER);
  assert.equal(b.ai, 'claude'); assert.equal(b.model, 'Opus 5.5'); assert.equal(b.effort, '高');
  assert.match(b.request, /^maintenance-/); assert.deepEqual(b.images, []);
  for (const text of ['名前 <P>', '/台帳/P/PROJECT.md', '× 作業場所：旧作業：/missing <path>', '直せるものは全部AIが直す', 'workdir', 'Gitへ保存', 'ゴミ箱', '資料の原本', '他プロジェクト', '全件ok', '## 成果']) assert.ok(b.text.includes(text), text);
  assert.ok(!b.text.includes('正常'));
});
test('未完了のボタン由来だけ再利用し、停止中には最新の依頼を新しい受付IDで送る', async () => {
  const f = fixture([{ id: 'manual', title: '問題解決', state: '実行中' }, { id: 'done', via: MARKER, state: '完了' }, { id: 'existing', via: MARKER, state: '返事待ち' }]);
  assert.equal((await f.resolver.solve('P')).task, 'existing');
  f.checks([{ ok: false, name: '新しい問題', detail: '最新' }]);
  assert.equal((await f.resolver.solve('P')).reused, true);
  const sends = f.calls.filter(c => c.start).map(c => c.start);
  assert.equal(sends.length, 2); assert.notEqual(sends[0].request, sends[1].request); assert.match(sends[1].text, /新しい問題：最新/);
  assert.equal(f.calls.filter(c => c.create).length, 0);
});
test('進行中の既存作業は移動だけ、別のAIや整理が稼働中なら作成・開始しない', async () => {
  const f = fixture([{ id: 'active', via: MARKER, state: '実行中' }]); f.active(true); f.blocked(true);
  assert.deepEqual(await f.resolver.solve('P'), { ok: true, task: 'active', reused: true, active: true }); assert.equal(f.calls.length, 0);
  f.active(false); await assert.rejects(f.resolver.solve('P'), /整理中/); assert.equal(f.calls.length, 0);
});
test('開始待ちで二重受付と整理を保護し、失敗後も同じ作業を再利用する', async () => {
  const f = fixture(); let finish;
  f.resolver.start = async () => new Promise(r => finish = r);
  const waiting = f.resolver.solve('P'); await new Promise(r => setImmediate(r));
  assert.ok(f.resolver.starting.has('P'));
  await assert.rejects(f.resolver.solve('P'), /受付中/); assert.equal(f.calls.filter(c => c.create).length, 1);
  finish({ status: 409, body: { error: '模擬開始失敗' } }); await assert.rejects(waiting, e => e.task === 'new' && /模擬開始失敗/.test(e.message));
  assert.equal(f.resolver.starting.size, 0); assert.equal(f.resolver.pending.size, 0);
  f.resolver.start = async b => ({ status: 200, body: { task: b.task } });
  assert.equal((await f.resolver.solve('P')).reused, true); assert.equal(f.calls.filter(c => c.create).length, 1);
});
test('初期モデルの利用不可は作業作成前に報告し、別モデルへ変更しない', async () => {
  const f = fixture(); f.resolver.validate = () => { throw Error('指定モデル利用不可'); };
  await assert.rejects(f.resolver.solve('P'), /指定モデル/); assert.equal(f.calls.filter(c => c.create || c.start).length, 0);
});
