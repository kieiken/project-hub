'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Usage } = require('../lib/usage'), { ModelLimits } = require('../lib/model-limits');
const { ChatRunner, append, read } = require('../lib/chat');
const createEngine = require('../lib/engines/limit-switch'), launch = require('../lib/launch');
const NOW = Date.parse('2026-11-02T00:00:00Z');
const data = balance => ({ private: 'SECRET', rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 },
  credits: { hasCredits: true, balance, unlimited: false } } });
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-credit-freshness-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = NOW, mode = 'ok', afterStatus, onRead, stopped = false, epoch = 0;
  const policy = { preferCredits: true, checkCredits: { codex: true }, roles: [] }, queries = [], logs = [], launches = [];
  const o = { project: 'fixture', task: 'credits', ai: 'codex', account: 'work', model: 'GPT-6.1-Sol', pdir: dir, dir,
    request: 'one', text: 'request', stopTicket: { epoch: 0 } };
  const usage = new Usage({ now: () => now, find: ai => ai, read: async (ai, _file, { account }) => {
    if (ai === 'claude') return { subscription_type: 'max', rate_limits: { five_hour: { utilization: 20 } } };
    queries.push({ ai, account });
    if (onRead) await onRead();
    if (mode === 'fail') throw Error('SECRET');
    if (mode === 'slow') now += 30000;
    return data(mode === 'empty' ? '0' : mode === 'unknown' ? 'SECRET' : '7');
  } });
  const limits = new ModelLimits(path.join(dir, 'limits.json'), { now: () => now, creditPolicy: () => policy,
    creditState: (ai, account) => usage.creditState(ai, account), onCreditDecision: (_o, decision) => logs.push(decision) });
  usage.observe = snapshot => limits.observe(snapshot);
  const status = usage.status.bind(usage);
  usage.status = async (...args) => { const result = await status(...args); if (args[0] === false && afterStatus) afterStatus(); return result; };
  const control = { data: { errors: [] }, ticket: () => ({ epoch }), held: () => stopped, changed: (_o, ticket) => ticket.epoch !== epoch,
    assert: (_o, ticket) => { if (stopped || ticket.epoch !== epoch) throw Error('stopped'); } };
  const backup = () => ({ ai: 'claude', account: 'default', model: 'Opus 5.5', requiredModel: 'claude-opus-5-5' });
  const engine = createEngine({ extensions: { create: () => ({ enabled: () => true, backup }) }, launch,
    rolesData: () => policy, verifyIntegrationAssignmentSend() {}, discussionRuntime: { isRequest: () => false },
    roleReviewRuntime: { heldLimit: r => limits.forRequest(r), isRequest: () => false }, integrationPolicyRequest: () => false,
    getLimitEvidence: () => limits, getUsage: () => usage, getStopControl: () => control,
    record: (action, _o, fields) => logs.push({ action, ...fields }) });
  const runner = new ChatRunner({ limitPreflight: r => limits.forRequest(r), limitTarget: r => limits.forRequest(r), limitBackup: backup, stopControl: control });
  runner.run = r => { launches.push(r); append(dir, o.task, { role: 'assistant', ai: r.ai, model: r.model, request: r.request, text: 'done' }); return { startedP: Promise.resolve(true) }; };
  return { usage, limits, engine, runner, o, policy, queries, logs, launches, dir,
    set time(v) { now = v; }, get time() { return now; }, set mode(v) { mode = v; },
    set afterStatus(v) { afterStatus = v; }, set onRead(v) { onRead = v; },
    stop() { stopped = true; epoch++; } };
}
for (const age of [29999, 30000, 30001]) test(`30-second proof boundary is strict at ${age}ms and records a real query separately`, async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work'); f.time += age;
  assert.equal(f.limits.creditDecision(f.o).allowed, age < 30000);
  f.afterStatus = () => { f.time += 2; };
  const before = f.queries.length;
  await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1);
  assert.equal(f.limits.creditDecision(f.o).allowed, true);
  f.runner.send(f.o); f.runner.send(f.o);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].ai, 'codex');
  assert.equal(read(f.dir, f.o.task).filter(r => r.role === 'user').length, 1);
  assert.ok(f.logs.some(r => r.action === 'credit-priority-check' && r.acquisition === 'queried' && r.reason === 'available'));
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|balance|credits.*7/);
});
test('recent ordinary usage is not a credit proof; dispatch makes one actual check without loosening freshness', async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  assert.equal(f.usage.creditState('codex', 'work').reason, 'not-checked');
  assert.equal((await f.usage.checkCredits('codex', 'work')).acquisition, 'cached');
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.equal(f.limits.forRequest(f.o), null);
});
for (const phase of ['adoption', 'admission']) test(`29-second cached proof is refreshed once before the 2-second ${phase} wait and keeps Codex`, async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work'); f.time += 29000;
  assert.equal(f.limits.creditDecision(f.o).reason, 'available');
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1);
  // Exercise the real sendAdmitted/withStrictHandoff/limitPreflight order;
  // only the disk-scan transport, clock and CLI launch are fixtures.
  f.runner.spoolRoot = f.dir;
  f.runner.handoffAdmission = { async scan() { if (phase === 'admission') f.time += 2000; return { errors: [], dirs: [] }; } };
  if (phase === 'adoption') f.runner.adopting = Promise.resolve().then(() => { f.time += 2000; });
  await f.runner.send(f.o); await f.runner.send(f.o);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].ai, 'codex');
  assert.equal(f.queries.length - before, 1); assert.equal(f.limits.forRequest(f.o), null);
});
for (const mode of ['fail', 'empty', 'unknown', 'slow']) test(`an actual ${mode} query is not retried and existing fallback remains`, async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  const before = f.queries.length; f.mode = mode;
  await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.ok(f.limits.forRequest(f.o));
  const reason = { fail: 'unavailable', empty: 'empty', unknown: 'unknown', slow: 'slow-read' }[mode];
  assert.equal(f.limits.creditDecision(f.o).reason, reason);
  f.runner.send(f.o); assert.equal(f.launches.length, 1); assert.equal(f.launches[0].ai, 'claude');
  assert.ok(f.logs.some(r => r.reason === reason && r.allowed === false && r.attemptedAt));
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|balance/);
});
test('failed/shared actual checks never get a second read; same-account concurrent dispatches share one check', async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  let release; const wait = new Promise(resolve => { release = resolve; }); f.onRead = () => wait;
  const before = f.queries.length, a = f.engine.refreshLimitEvidence(f.o), b = f.engine.refreshLimitEvidence({ ...f.o, task: 'other' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.queries.length - before, 1);
  f.mode = 'fail'; release(); await Promise.all([a, b]);
  assert.equal(f.queries.length - before, 1); assert.equal(f.limits.creditDecision(f.o).reason, 'unavailable');
});
test('concurrent cached lookups both await the one successful fresh query before deciding', async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  let release; const wait = new Promise(resolve => { release = resolve; }); f.onRead = () => wait;
  const before = f.queries.length; let completed = 0;
  const dispatch = async () => { await f.engine.refreshLimitEvidence(f.o); completed++; assert.equal(f.limits.forRequest(f.o), null); };
  const a = dispatch(), b = dispatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queries.length - before, 1); assert.equal(completed, 0);
  release(); await Promise.all([a, b]); assert.equal(completed, 2); assert.equal(f.queries.length - before, 1);
});
for (const setting of ['priority', 'check']) test(`turning ${setting} off after refresh prevents priority without a second query`, async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work'); f.time += 29999;
  f.afterStatus = () => { f.time += 2; if (setting === 'priority') f.policy.preferCredits = false; else f.policy.checkCredits.codex = false; };
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.ok(f.limits.forRequest(f.o));
  assert.equal(f.limits.creditDecision(f.o).reason, setting === 'priority' ? 'priority-off' : 'check-off');
});
for (const setting of ['priority', 'check']) test(`turning ${setting} off during the actual query is revalidated without another query`, async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  f.onRead = () => { if (setting === 'priority') f.policy.preferCredits = false; else f.policy.checkCredits.codex = false; };
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.ok(f.limits.forRequest(f.o));
  assert.equal(f.limits.creditDecision(f.o).reason, setting === 'priority' ? 'priority-off' : 'check-off');
});
test('account invalidation rejects the late proof, other accounts cannot use it, and no retry occurs', async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work'); f.time += 30000;
  f.onRead = () => f.usage.invalidate('codex', 'work'); const before = f.queries.length;
  await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.ok(f.limits.forRequest(f.o));
  assert.equal(f.usage.creditState('codex', 'work').availability, 'unknown');
  assert.notEqual(f.usage.creditState('codex', 'other').availability, 'available');
});
test('formal CLI denial cannot be bypassed by prepaid credits and both-side limits stay waiting', async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work');
  f.limits.record({ ...f.o, limitError: "You've hit your usage limit." });
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length, before); assert.equal(f.limits.creditDecision(f.o).reason, 'cli-limit');
  f.limits.record({ ai: 'claude', model: 'Opus 5.5', limitError: "You've reached your session limit" });
  assert.throws(() => f.runner.send(f.o), e => e.code === 'HUB_LIMIT_WAIT'); assert.equal(f.launches.length, 0);
});
test('human stop after the cache refresh prevents a second check and any launch', async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work'); f.time += 29999;
  f.afterStatus = () => { f.time += 2; f.stop(); };
  const before = f.queries.length; await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.throws(() => f.runner.send(f.o), /stopped/); assert.equal(f.launches.length, 0);
});
test('stop during the one fresh query rejects launch after it finishes without resending', async t => {
  const f = fixture(t); await f.usage.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  const before = f.queries.length; f.onRead = () => f.stop();
  await f.engine.refreshLimitEvidence(f.o);
  assert.equal(f.queries.length - before, 1); assert.throws(() => f.runner.send(f.o), /stopped/); assert.equal(f.launches.length, 0);
});
