'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-onboarding-api-'));
let server, sessions, base;
test.before(async () => {
  const probe = require('node:http').createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port;
  await new Promise(r => probe.close(r));
  Object.assign(process.env, { HUB_ROOT: root, HUB_AI_HOME: path.join(root, 'home'), HUB_PORT: String(port), HUB_DRY_RUN: '1' });
  ({ server, sessions } = require('../server'));
  await new Promise(r => server.listen(port, '127.0.0.1', r)); base = `http://127.0.0.1:${port}`;
});
test.after(async () => { sessions.stopAll(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
const post = (route, body, headers = { 'X-Hub': '1' }) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
test('state, secure save and readonly check preserve roles/defaults and reject secrets or invalid bodies', async () => {
  const before = await (await fetch(base + '/api/state')).json();
  assert.equal(before.onboarding.auto, true);
  const good = { status: 'in-progress', step: 'cli', ais: ['codex'] };
  assert.equal((await post('/api/onboarding', good, {})).status, 403);
  assert.equal((await post('/api/onboarding', good, { 'X-Hub': '1', Origin: 'https://evil.invalid' })).status, 403);
  for (const body of [null, { ...good, step: 'wrong' }, { ...good, ais: ['other'] }, { ...good, email: 'private' }]) assert.equal((await post('/api/onboarding', body)).status, 400);
  const r = await post('/api/onboarding', good); assert.equal(r.status, 200);
  assert.equal((await r.json()).onboarding.step, 'cli');
  for (const body of [null, [], { ais: [] }, { ais: ['other'] }, { ais: ['codex'], token: 'private' }]) assert.equal((await post('/api/onboarding/check', body)).status, 400);
  assert.equal((await post('/api/onboarding/check', { ais: ['codex'] }, {})).status, 403);
  const checked = await post('/api/onboarding/check', { ais: ['codex'] }); assert.equal(checked.status, 200);
  const result = await checked.json(); assert.equal(result.tools.codex.login, 'unknown');
  assert.deepEqual(Object.keys(result.tools.codex).sort(), ['installed', 'login', 'version']);
  await post('/api/onboarding', { ...good, status: 'done', step: 'first' });
  const after = await (await fetch(base + '/api/state')).json();
  assert.equal(after.onboarding.auto, false); assert.equal(after.onboarding.status, 'done');
  assert.deepEqual(after.roles, before.roles); assert.deepEqual(after.initialPick, before.initialPick);
  assert.equal(fs.existsSync(path.join(root, '_hub/roles.yaml')), false);
  assert.equal(fs.existsSync(path.join(root, '_hub/log.jsonl')), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, '_hub/onboarding.json')))).sort(), ['ais', 'status', 'step', 'updatedAt', 'version']);
});
