'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, wait } = require('./fixtures/limit-refresh.cjs');

for (const credits of [false, true]) test(`start preflight reads only the actual provider/account (credits=${credits})`, async () => {
  const f = fixture({ credits: { codex: credits }, otherDelay: 300, authDelay: 300 });
  await f.engine.refreshLimitEvidence(f.request);
  assert.deepEqual(f.reads, [{ ai: 'codex', account: 'work' }]);
  assert.deepEqual(f.auth, f.reads);
  assert.equal(f.checks.length, credits ? 1 : 0);
  assert.equal(f.usage.creditState('codex', 'work').availability, credits ? 'available' : 'unknown');
});
test('a blocked unrelated account cannot hold a start; the requested account still must finish', async () => {
  const f = fixture(); let release, finished = false;
  f.usage.read = async (ai, _file, { account }) => {
    assert.equal(ai, 'codex'); assert.equal(account, 'work');
    await new Promise(resolve => { release = resolve; });
    return { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } };
  };
  const running = f.engine.refreshLimitEvidence(f.request).then(() => { finished = true; });
  await wait(5); assert.equal(finished, false); assert.equal(typeof release, 'function');
  release(); await running; assert.equal(finished, true);
});
test('a held source checks the backup account and its enabled credits before quota', async () => {
  const backup = { ai: 'claude', account: 'work', model: 'Opus 5.5' };
  const f = fixture({ held: r => r.ai === 'codex', backup, credits: { claude: true } });
  await f.engine.refreshLimitEvidence(f.request);
  assert.deepEqual(f.checks, [{ ai: 'claude', account: 'work' }]);
  assert.deepEqual(f.reads, f.checks); assert.deepEqual(f.auth, f.reads);
});
test('integration preflight also limits reads without bypassing its held gate', async () => {
  const f = fixture({ integration: true }); await f.engine.refreshLimitEvidence(f.request);
  assert.deepEqual(f.reads, [{ ai: 'codex', account: 'work' }]);
  const held = fixture({ integration: true, held: () => true });
  await held.engine.refreshLimitEvidence(held.request); assert.deepEqual(held.reads, []);
});
test('requested quota failure stays unavailable and cannot prove subscription availability', async () => {
  const f = fixture({ failRequested: true, credits: { codex: true } });
  await f.engine.refreshLimitEvidence(f.request);
  assert.deepEqual(f.reads, [{ ai: 'codex', account: 'work' }]);
  assert.equal(f.usage.creditState('codex', 'work').availability, 'unknown');
  assert.equal(f.usage.subscriptionAvailable(['gpt-6.1-sol'], 'work'), false);
});
test('routing disabled keeps enabled credit confirmation; both held adds no quota read', async () => {
  const f = fixture({ routing: false, credits: { codex: true } });
  await f.engine.refreshLimitEvidence(f.request); assert.equal(f.checks.length, 1); assert.equal(f.reads.length, 1);
  const held = fixture({ held: () => true, backup: { ai: 'claude', account: 'work' } });
  await held.engine.refreshLimitEvidence(held.request); assert.equal(held.reads.length, 0);
});
test('scope works without account inventory and does not change the display refresh of all accounts', async () => {
  const f = fixture({ accounts: false }); await f.engine.refreshLimitEvidence(f.request);
  assert.deepEqual(f.reads, [{ ai: 'codex', account: 'work' }]);
  const display = fixture(); await display.usage.status(false, { codex: 'work' });
  assert.equal(display.reads.length, 4); assert.equal(display.auth.length, 4);
});
