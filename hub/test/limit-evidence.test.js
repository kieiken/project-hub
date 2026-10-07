'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LimitEvidence } = require('../lib/limit-evidence');
const { ChatRunner } = require('../lib/chat');
const NOW = Date.parse('2026-10-06T10:00:00Z'), iso = n => new Date(n).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-limit-evidence-'));
let serial = 0;
function fixture() {
  let now = NOW;
  const file = path.join(tmp, String(++serial), 'limits.json');
  const e = new LimitEvidence(file, { now: () => now });
  return { e, file, advance: ms => { now += ms; }, record: () => e.record({ project: 'test', task: 'case', request: 'original' }) };
}
const w = (id, pct = 100, reset = NOW + 3600000, label = 'Fable・週間枠') => ({ id, usedPercent: pct, resetsAt: reset === null ? null : iso(reset), label });
const snapshot = (windows, at = NOW + 1) => ({ providers: { claude: { status: 'ok', windows, fetchedAt: iso(at), attemptedAt: iso(at) } } });

test('利用率だけで作らず、正式上限だけで期限不明のv2保持を即保存', () => {
  const { e, file, record } = fixture();
  e.observe(snapshot([w('five_hour')])); assert.equal(e.active(), null);
  record(); assert.equal(e.needsRefresh(), false); assert.equal(e.active().validUntil, null);
  const saved = JSON.parse(fs.readFileSync(file))['claude-fable-5-1'];
  assert.equal(saved.version, 2); assert.equal(saved.hold, true); assert.equal(saved.untilSource, 'unknown');
  assert.equal(saved.lastLimitAt, saved.at);
});
test('取得失敗・100%未満・該当なし・未知値・Fable成功で保持を消さない', () => {
  const { e, record, file } = fixture(); record(); e.observe(snapshot([w('five_hour')]));
  const saved = fs.readFileSync(file, 'utf8');
  for (const windows of [[], [w('five_hour', 0), w('model:0', 99)], [w('five_hour', null)], [w('five_hour', '100')]]) e.observe(snapshot(windows));
  e.observe({ providers: { claude: { status: 'unavailable', attemptedAt: iso(NOW + 2) } } });
  for (const started of [NOW - 1, NOW, NOW + 10]) e.success(started);
  assert.ok(e.active()); assert.equal(fs.readFileSync(file, 'utf8'), saved);
});
test('共有枠とFableモデル枠の100%以上だけを使い、最後の解除日時まで保持', () => {
  for (const id of ['five_hour', 'seven_day', 'model:0']) {
    const { e, record } = fixture(); record(); e.observe(snapshot([w(id)])); assert.equal(e.active().untilSource, 'usage');
  }
  for (const label of ['Fable・週間枠', 'Fable 5.1・週間枠', 'fable 5.1・週間枠', 'Fable 5.1 (High)・週間枠']) {
    const { e, record } = fixture(); record(); e.observe(snapshot([w('model:0', 100, NOW + 3600000, label)])); assert.equal(e.active().untilSource, 'usage', label);
  }
  for (const [id, label] of [['model:0', 'Opus 5.5・週間枠'], ['model:0', 'Not Fable・週間枠'], ['model:0', 'Fableish・週間枠'], ['model:0', 'Opus / Fable・週間枠'], ['seven_day_opus', 'Fable 5.1・週間枠']]) {
    const { e, record } = fixture(); record(); e.observe(snapshot([w(id, 100, NOW + 3600000, label)])); assert.equal(e.active().validUntil, null, label);
  }
  const { e, record } = fixture(); record(); e.observe(snapshot([w('five_hour'), w('seven_day', 101, NOW + 7200000)]));
  assert.equal(e.active().validUntil, iso(NOW + 7200000));
});
test('解除日時は補完・延長だけで短縮せず、再度の正式上限でも保持', () => {
  const { e, record, advance } = fixture(); record();
  e.observe(snapshot([w('five_hour', 100, null)])); assert.equal(e.active().validUntil, null);
  e.observe(snapshot([w('five_hour')]));
  e.observe(snapshot([w('five_hour', 100, NOW + 100)], NOW + 2)); assert.equal(e.active().validUntil, iso(NOW + 3600000));
  advance(3); record(); assert.equal(e.active().at, iso(NOW)); assert.equal(e.active().lastLimitAt, iso(NOW + 3));
  assert.equal(e.active().validUntil, iso(NOW + 3600000));
  e.observe(snapshot([w('five_hour', 100, NOW + 7200000)], NOW + 4)); assert.equal(e.active().validUntil, iso(NOW + 7200000));
});
test('取得開始がフラグより古い応答を無視、手動解除後も再生成しない', () => {
  const { e, record, advance } = fixture(); record();
  e.observe({ providers: { claude: { ...snapshot([w('five_hour')]).providers.claude, attemptedAt: iso(NOW - 1) } } });
  assert.equal(e.active().validUntil, null);
  e.observe(snapshot([w('five_hour')], NOW)); assert.ok(e.active().validUntil); // 同時刻は使える
  e.clear(); e.observe(snapshot([w('five_hour')], NOW + 1)); assert.equal(e.active(), null);
  advance(10); record(); e.observe(snapshot([w('five_hour')], NOW + 1)); assert.equal(e.active().validUntil, null);
});
test('期限切れは無効化・削除し、遅い応答で復活しない', () => {
  const { e, record, advance, file } = fixture(); record(); e.observe(snapshot([w('five_hour', 100, NOW + 100)]));
  advance(100); assert.equal(e.active(), null); assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
  e.observe(snapshot([w('five_hour')], NOW + 101)); assert.equal(e.active(), null);
  record(); assert.equal(e.active().validUntil, null); assert.equal(e.active().at, iso(NOW + 100));
});
test('再起動後は利用枠を取得せず既知・未知の保持を即利用', () => {
  for (const known of [false, true]) {
    const { e, file, record } = fixture(); record(); if (known) e.observe(snapshot([w('five_hour')]));
    const restored = new LimitEvidence(file, { now: () => NOW + 10 });
    assert.deepEqual(restored.active(), e.active()); assert.equal(restored.needsRefresh(), false);
  }
});
test('v1は未来の期限と正式証拠後のcheckedAtが揃う場合だけv2へ移行', () => {
  const { file } = fixture(); fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { source: 'cli-limit', at: iso(NOW), validUntil: iso(NOW + 100), checkedAt: iso(NOW + 1) };
  fs.writeFileSync(file, JSON.stringify({ 'claude-fable-5-1': old }));
  const e = new LimitEvidence(file, { now: () => NOW }); assert.equal(e.active().version, 2);
  e.observe(snapshot([w('five_hour')], NOW + 2)); assert.equal(JSON.parse(fs.readFileSync(file))['claude-fable-5-1'].version, 2);
  const v2 = { ...old, version: 2, hold: true, lastLimitAt: old.at, untilSource: 'usage', project: '', task: '', request: '' };
  for (const data of [{ ...v2, checkedAt: null }, { ...v2, project: undefined }, { ...v2, lastLimitAt: iso(NOW - 1) }, '{broken', { ...old, validUntil: null }, { ...old, validUntil: iso(NOW) }, { ...old, checkedAt: iso(NOW) }, { ...old, version: 2 }, { ...old, version: 3 }, { at: iso(NOW) }]) {
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify({ 'claude-fable-5-1': data }));
    const restored = new LimitEvidence(file, { now: () => NOW }); assert.equal(restored.active(), null); assert.equal(restored.needsRefresh(), false);
  }
});
for (const fault of ['rename', 'tmp-write', 'directory']) {
  test(`${fault}保存失敗は初回保持なし・延長/手動解除/再上限は直前の保持・期限後は無効`, () => {
    const { e, file, record, advance } = fixture();
    const method = { rename: 'renameSync', 'tmp-write': 'writeFileSync', directory: 'mkdirSync' }[fault], original = fs[method];
    const deny = () => { fs[method] = (target, ...args) => {
      const matches = fault === 'rename' ? args[0] === file : fault === 'tmp-write' ? target.startsWith(file + '.') : target === path.dirname(file);
      if (matches) throw Object.assign(Error('fixture write denied'), { code: 'EACCES' });
      return original(target, ...args);
    }; };
    try {
      deny(); assert.throws(record, { code: 'EACCES' }); assert.equal(e.active(), null);
      fs[method] = original; record(); e.observe(snapshot([w('five_hour', 100, NOW + 100)]));
      const saved = fs.readFileSync(file, 'utf8'), before = e.active(); advance(10); deny();
      for (const action of [() => e.observe(snapshot([w('five_hour')], NOW + 10)), () => e.clear(), record]) {
        assert.throws(action, { code: 'EACCES' }); assert.deepEqual(e.active(), before); assert.equal(fs.readFileSync(file, 'utf8'), saved);
      }
      assert.deepEqual(new LimitEvidence(file, { now: () => NOW + 10 }).active(), before);
      advance(100); assert.equal(e.active(), null); assert.equal(new LimitEvidence(file, { now: () => NOW + 110 }).active(), null);
    } finally { fs[method] = original; }
  });
}

for (const action of ['unqueue', 'interrupt', 'shutdown']) {
  test(`キュー事前確認中の${action}で起動せず、取り消した先頭を復活させない`, async () => {
    const { file } = fixture(), pdir = path.dirname(file); let release, starts = 0;
    const blocked = new Promise(r => { release = r; });
    const runner = new ChatRunner({ beforeQueued: () => blocked });
    runner.run = () => { starts++; return { startedP: Promise.resolve(true) }; };
    runner.enqueue('test', 'case', { id: 'first' }); runner.enqueue('test', 'case', { id: 'follower' });
    const pending = runner.sendQueued({ project: 'test', task: 'case', pdir, ai: 'claude', model: 'Fable 5.1', text: 'fixture', request: 'first' });
    const rejected = assert.rejects(pending, action === 'unqueue' ? /もう待っていません/ : /確認中に停止/);
    assert.equal(runner.busy('test', 'case').pending, true);
    if (action === 'unqueue') runner.unqueue('test', 'case', 'first');
    if (action === 'interrupt') await runner.stop('test', 'case', { interrupting: true });
    if (action === 'shutdown') runner.stopAll();
    release(); await rejected;
    assert.equal(starts, 0); assert.equal(runner.busy('test', 'case'), null);
    assert.deepEqual(runner.queue('test', 'case').map(x => x.id), action === 'shutdown' ? ['first', 'follower'] : ['follower']);
  });
}
