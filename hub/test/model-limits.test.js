'use strict';
const AGY_FIXTURE = { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' };
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ModelLimits } = require('../lib/model-limits');
const { limitIdentity } = require('../lib/limit-route');
const { parse, ChatRunner } = require('../lib/chat');
const launch = require('../lib/launch');
process.env.HUB_LANG = 'ja';
launch.setDiscoveredModels({ agy: { models: [AGY_FIXTURE] }, codex: { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-future', label: 'Future' }] } });
const NOW = Date.now();
const full = (ai, windows, account = 'default', at = NOW) => ({ accountProviders: [{ ai, account, status: 'ok', attemptedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString(), windows }] });
const win = (id, usedPercent = 100, resetsAt = new Date(NOW + 3600000).toISOString()) => ({ id, usedPercent, resetsAt });
test('Credit priority preserves evidence, applies only to checked accounts and expires without deleting holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-credit-priority-'));
  let now = NOW, policy = { preferCredits: true, checkCredits: { codex: true, claude: false } };
  let proof = { ai: 'codex', account: 'work', availability: 'available', prepaid: true, attemptedAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString() };
  const state = new ModelLimits(path.join(dir, 'limits.json'), { now: () => now, creditPolicy: () => policy, creditState: (ai, account) => account === 'work' && ai === 'codex' ? proof : null });
  const request = { ai: 'codex', account: 'work', model: 'GPT-6.1-Sol' };
  state.observe(full('codex', [win('codex:primary')], 'work'));
  state.observe(full('codex', [win('codex:primary')]));
  const saved = fs.readFileSync(state.file, 'utf8');
  assert.equal(state.forRequest(request), null); assert.ok(state.active('work', 'gpt-6.1-sol'));
  assert.equal(state.list({ codex: 'work' })[0].creditPriority, true);
  assert.ok(state.forRequest({ ...request, account: 'default' }));
  for (const change of [{ preferCredits: false }, { checkCredits: { codex: false } }]) {
    const previous = policy; policy = { ...policy, ...change }; assert.ok(state.forRequest(request)); policy = previous;
  }
  for (const invalid of [{ ai: 'claude' }, { account: 'other' }, { availability: 'empty' }, { availability: 'unknown' }, { prepaid: false }, { checkedAt: new Date(NOW - 1).toISOString() },
    { attemptedAt: new Date(NOW + 1).toISOString() }, { checkedAt: new Date(NOW + 1).toISOString() }]) {
    const previous = proof; proof = { ...proof, ...invalid }; assert.ok(state.forRequest(request)); proof = previous;
  }
  now += 30000; assert.ok(state.forRequest(request));
  assert.equal(fs.readFileSync(state.file, 'utf8'), saved);
  const restored = new ModelLimits(state.file, { now: () => NOW, creditPolicy: () => policy });
  assert.ok(restored.forRequest(request)); // 残高の証拠は再起動で持ち越さない。
  now = NOW; state.record({ ...request, limitError: "You've hit your usage limit." });
  assert.equal(state.forRequest(request).source, 'cli-limit');
  assert.equal(state.creditException(), null);
});

test('Claude monthly allowance never authorizes priority, and configuration alone cannot bypass limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-credit-'));
  const state = new ModelLimits(path.join(dir, 'limits.json'), { now: () => NOW,
    creditPolicy: () => ({ preferCredits: true, checkCredits: { claude: true } }),
    creditState: () => ({ availability: 'unknown', extraUsageEnabled: true, monthlyLimitReached: false, checkedAt: new Date(NOW).toISOString() }) });
  state.observe(full('claude', [win('five_hour')]));
  assert.ok(state.forRequest({ ai: 'claude', model: 'Fable 5.1' }));
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-limits-')); let now = NOW;
  return { dir, state: new ModelLimits(path.join(dir, 'limits.json'), { now: () => now }), advance: ms => now += ms };
}
const slot = (ai, model, effort = '高') => ({ ai, model, effort });
const row = (name, main, backup) => ({ name, main, backup });
const config = () => ({ switch: { auto: true }, roles: [
  row('司令塔', slot('claude-code', 'Fable 5.1'), slot('codex', 'GPT-6-Astra')),
  row('調査', slot('claude-code', 'Opus 5.5'), slot('codex', 'GPT-6.1-Sol')),
  row('画像生成', slot('codex', 'GPT-6.1-Sol', '中'), slot('agy', AGY_FIXTURE.label)),
  row('コーディング', slot('codex', 'GPT-6.1-Sol'), slot('claude-code', 'Opus 5.5')),
] });
test('共有5hrは両Claude、Codex契約枠は両Codexを別アカウントで保持する', () => {
  const { state, advance } = fixture();
  state.observe(full('claude', [win('five_hour')], 'work'));
  assert.ok(state.active('work', 'claude-fable-5-1')); assert.ok(state.active('work', 'claude-opus-5-5')); assert.equal(state.active(), null);
  state.observe(full('codex', [win('codex:primary')]));
  assert.equal(state.active('default', 'gpt-6.1-sol').source, 'usage-100'); assert.ok(state.active('default', 'gpt-6-astra'));
  advance(3600000); assert.equal(state.active('work', 'claude-opus-5-5'), null);
});
test('モデル限定・最大解除期限・不明期限と再起動を保持する', () => {
  const { state } = fixture();
  state.observe(full('claude', [{ ...win('model:0'), label: 'Opus・週間枠' }, win('seven_day_opus', 100, new Date(NOW + 7200000).toISOString())]));
  assert.equal(state.active(), null); assert.equal(Date.parse(state.active('default', 'claude-opus-5-5').validUntil), NOW + 7200000);
  state.observe(full('codex', [win('gpt-6.1-sol:primary', 100, null)])); assert.equal(state.active('default', 'gpt-6-astra'), null);
  const restarted = new ModelLimits(state.file, { now: () => NOW + 200000 }); assert.equal(restarted.active('default', 'gpt-6.1-sol').validUntil, null);
});
test('99.9表示丸め・古い応答・取得失敗・期限済み・型違いを証拠にしない', () => {
  const { state } = fixture();
  for (const data of [full('claude', [win('five_hour', 99.9)]), full('claude', [win('five_hour')], 'default', NOW - 360000),
    full('claude', [win('five_hour', '100')]), full('claude', [win('five_hour', 100, new Date(NOW).toISOString())]),
    { accountProviders: [{ ...full('claude', [win('five_hour')]).accountProviders[0], status: 'unavailable' }] }]) state.observe(data);
  assert.equal(state.list().length, 0);
});
test('解除は個別・遅い取得を無効化し、保存失敗時は直前の保持を保つ', () => {
  const { state, advance } = fixture(); state.observe(full('claude', [win('five_hour')])); advance(100);
  state.clear('default', 'claude-opus-5-5'); state.observe(full('claude', [win('five_hour')]));
  assert.equal(state.active('default', 'claude-opus-5-5'), null); assert.ok(state.active());
  fs.mkdirSync(state.file + `.${process.pid}.tmp`);
  assert.throws(() => state.clear()); assert.ok(state.active());
});
test('構造付きCodex/Opus正式文だけ検知し、引用・認証・混雑は対象外', () => {
  const error = 'You’ve hit your usage limit. Try again at 12:00.';
  for (const value of [{ type: 'turn.failed', error: { message: error } }, { type: 'error', message: error }, { type: 'event_msg', payload: { type: 'error', message: error } }]) assert.ok(parse('codex', value).some(e => e.kind === 'limit'));
  for (const value of [{ type: 'item.completed', item: { type: 'agent_message', text: error } }, { type: 'error', message: 'authentication failed' }, { type: 'error', message: 'Too many requests' }, { type: 'error', message: 'quote: ' + error }]) assert.ok(!parse('codex', value).some(e => e.kind === 'limit'));
  assert.ok(parse('claude', { type: 'result', is_error: true, result: "You've reached your 5-hour limit." }).some(e => e.kind === 'limit'));
});
test('将来設定されたCodexモデルにも共有枠を適用する', () => {
  const { dir } = fixture(); const state = new ModelLimits(path.join(dir, 'future.json'), { now: () => NOW, models: () => ({ claude: ['claude-opus-5-5'], codex: ['gpt-future'] }) });
  state.observe(full('codex', [win('codex:primary')])); assert.ok(state.forRequest({ ai: 'codex', model: 'gpt-future' }));
});
test('共有正式CLI上限と別インスタンスの個別解除をアカウントごとに保存して読める', () => {
  const { state } = fixture();
  state.record({ ai: 'claude', model: 'Opus 5.5', account: 'work', limitError: "You've reached your 5-hour limit." });
  assert.ok(state.active('work', 'claude-fable-5-1')); assert.equal(state.active(), null);
  const second = new ModelLimits(state.file, { now: () => NOW }); second.clear('work', 'claude-opus-5-5');
  assert.equal(state.active('work', 'claude-opus-5-5'), null); assert.ok(state.active('work', 'claude-fable-5-1'));
  state.record({ ai: 'codex', model: 'GPT-6.1-Sol', limitError: "You've hit your usage limit." });
  assert.ok(second.active('default', 'gpt-6-astra')); assert.ok(second.active('default', 'gpt-6.1-sol'));
});

test('実機session limitは同じアカウントの両Claudeを保持し、再起動・個別解除を維持する', () => {
  for (const model of ['Fable 5.1', 'Opus 5.5']) {
    const { state } = fixture();
    state.record({ ai: 'claude', model, account: 'work', limitError: "You've hit your session limit · resets 3pm (Asia/Tokyo)" });
    const restored = new ModelLimits(state.file, { now: () => NOW });
    for (const flag of ['claude-fable-5-1', 'claude-opus-5-5']) {
      assert.equal(restored.active('work', flag)?.source, 'cli-limit');
      assert.equal(restored.active('work', flag)?.validUntil, null); assert.equal(restored.active('default', flag), null);
    }
    restored.clear('work', 'claude-opus-5-5');
    assert.equal(state.active('work', 'claude-opus-5-5'), null); assert.ok(state.active('work', 'claude-fable-5-1'));
  }
});
test('Codex実機task_completeのerror.messageだけを正式上限として検知する', () => {
  const message = "You've hit your usage limit. Try again at 12:00.";
  assert.equal(parse('codex', { type: 'event_msg', payload: { type: 'task_complete', error: { message } } }).filter(e => e.kind === 'limit').length, 1);
  for (const payload of [{ type: 'task_complete', last_agent_message: message }, { type: 'agent_message', error: { message } },
    { type: 'task_complete', message }, { type: 'task_complete', error: { message: 'Quoted: ' + message } },
    ...['Too many requests', 'authentication failed', 'Usage credits are required', 'Credit balance is too low'].map(message => ({ type: 'task_complete', error: { message } }))]) {
    assert.ok(!parse('codex', { type: 'event_msg', payload }).some(e => e.kind === 'limit'));
  }
  assert.ok(!parse('codex', { type: 'task_complete', error: { message } }).some(e => e.kind === 'limit'));
});
