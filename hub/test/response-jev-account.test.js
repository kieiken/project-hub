'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { externalBusy, managedRoots } = require('../lib/account-processes');
const { Accounts } = require('../lib/accounts'), { Usage } = require('../lib/usage');
const { sendTiming } = require('../lib/send-timing');
const { fixture: sendFixture } = require('./fixtures/send-overlap.cjs');
const platform = { processOwner: p => p.uid, currentProcessOwner: () => 501 };
const proc = (pid, ppid = 1) => ({ pid, ppid, pgid: 20, uid: 501, since: '2026-11-04T01:00:00Z', command: 'fixture' });
const root = (identity, account = 'default') => ({ ai: 'codex', account, identity });
function processFixture() {
  const parent = proc(20), child = proc(22, 20);
  return { external: [{ pid: 22, since: child.since }], roots: [root(parent)], rows: [parent, child] };
}
function check(f, account = 'named') { return externalBusy('codex', account, f.external, f.roots, f.rows, platform); }
test('server retains usage, tools, sessions, running and queued target guards before external attribution', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const body = source.slice(source.indexOf('function accountBusy('), source.indexOf('\nfunction usageSelection'));
  const ctx = { usage: { inflight: new Set(), resetBusy: new Set(), key: (ai, id) => ai + ':' + id }, aiTools: { isOperating: () => false }, sessions: { list: () => [], map: new Map() }, chats: { running: new Map(), queue: () => [], spoolRuns: new Set() }, store: { listProjects: () => [] }, launch: { AI_KEY: { codex: 'codex' } }, procwatch: { list: () => [] }, require: require('node:module').createRequire(path.join(__dirname, '../server.js')) };
  const busy = vm.runInNewContext('(' + body + ')', ctx);
  assert.equal(busy('codex', 'named'), false);
  ctx.usage.inflight.add('codex:named'); assert.equal(busy('codex', 'named'), true); ctx.usage.inflight.clear();
  ctx.usage.resetBusy.add('codex:named'); assert.equal(busy('codex', 'named'), true); ctx.usage.resetBusy.clear();
  ctx.aiTools.isOperating = () => true; assert.equal(busy('codex', 'default'), true); ctx.aiTools.isOperating = () => false;
  ctx.sessions.list = () => [{ ai: 'codex', account: 'named', running: true }]; assert.equal(busy('codex', 'named'), true); ctx.sessions.list = () => [];
  ctx.chats.running.set('x', { ai: 'codex', account: 'named' }); assert.equal(busy('codex', 'named'), true); ctx.chats.running.clear();
  ctx.store.listProjects = () => [{ id: 'p', tasks: [{ id: 't' }] }]; ctx.chats.queue = () => [{ ai: 'codex', account: 'named' }]; assert.equal(busy('codex', 'named'), true);
  ctx.chats.queue = () => [{ ai: 'codex', account: 'other' }]; assert.equal(busy('codex', 'named'), false);
  ctx.procwatch.list = () => [{ ai: 'codex', pid: 99999999, since: 'invalid' }]; assert.equal(busy('codex', 'named'), 'unknown-process');
});
test('verified live other-account descendant is excluded; same account stays busy', () => {
  const f = processFixture(); assert.equal(check(f), false); assert.equal(check(f, 'default'), true);
  f.external = [{ pid: 20, since: f.rows[0].since }]; assert.equal(check(f), false);
});
for (const fault of ['unknown', 'missing-root', 'reused-root', 'reused-child', 'foreign-owner', 'cycle', 'conflict', 'unknown-account', 'wrong-ai', 'malformed-identity']) {
  test('account attribution remains protected: ' + fault, () => {
    const f = processFixture();
    if (fault === 'unknown') f.roots = [];
    if (fault === 'missing-root') f.rows.shift();
    if (fault === 'reused-root') f.rows[0] = { ...f.rows[0], since: '2026-11-04T02:00:00Z' };
    if (fault === 'reused-child') f.rows[1] = { ...f.rows[1], since: '2026-11-04T02:00:00Z' };
    if (fault === 'foreign-owner') f.rows = f.rows.map(p => ({ ...p, uid: 502 }));
    if (fault === 'cycle') f.rows[0] = { ...f.rows[0], ppid: 22 };
    if (fault === 'conflict') f.roots.push(root(f.rows[1], 'other'));
    if (fault === 'unknown-account') f.roots[0].account = '';
    if (fault === 'wrong-ai') f.roots[0].ai = 'claude';
    if (fault === 'malformed-identity') f.roots[0].identity = { pid: 20 };
    assert.equal(check(f), 'unknown-process');
  });
}
test('an unknown external process still blocks alongside a verified different account', () => {
  const f = processFixture(); f.external.push({ pid: 99, since: f.rows[0].since }); assert.equal(check(f), 'unknown-process');
  assert.equal(externalBusy('codex', 'named', [], [], [], platform), false);
});
test('managed ownership excludes finished/unsafe spool and missing/failed live session identities', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-proof-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identity = proc(20), c = { dir, supervisorPid: 20, safe: () => true, run: { options: { ai: 'codex', account: 'default' } } };
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ identity }));
  const chats = { spoolRuns: new Set([c]), running: new Map() }, sessions = { map: new Map() };
  assert.deepEqual(managedRoots(chats, sessions), [root(identity)]);
  c.supervisorPid = 99; assert.deepEqual(managedRoots(chats, sessions), []); c.supervisorPid = 20;
  c.safe = () => false; assert.deepEqual(managedRoots(chats, sessions), []); c.safe = () => true;
  fs.writeFileSync(path.join(dir, 'exit.json'), '{}'); assert.deepEqual(managedRoots(chats, sessions), []);
  sessions.map.set('a', { ai: 'codex', account: 'named', identity });
  assert.deepEqual(managedRoots(chats, sessions), [root(identity, 'named')]);
  sessions.map.get('a').exited = true; assert.deepEqual(managedRoots(chats, sessions), []);
  sessions.map.get('a').exited = false; sessions.map.get('a').ownershipError = 'missing'; assert.deepEqual(managedRoots(chats, sessions), []);
  fs.writeFileSync(path.join(dir, 'launch.json'), '{broken'); assert.throws(() => managedRoots(chats, sessions), SyntaxError);
});

function inventory() {
  const a = Object.create(Accounts.prototype), counts = { registryReads: 0, globalBusy: 0, terminalChecks: 0, auth: 0, quota: 0 };
  const rows = Array.from({ length: 5 }, (_, n) => ({ ai: 'codex', id: 'named-' + n, name: 'fixture' }));
  a.get = (ai, id = 'default') => ({ ai, id, name: 'fixture' }); a.read = () => { counts.registryReads++; return rows; };
  a.busy = () => { counts.globalBusy++; return 'unknown-process'; }; a.terminalBusy = () => { counts.terminalChecks++; return false; }; a.locks = new Set();
  a.status = async () => { counts.auth++; return { status: 'logged-in' }; };
  const u = new Usage({ accounts: a, find: ai => ai, read: async () => { counts.quota++; return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }; } });
  return { a, u, counts, rows };
}
test('target quota uses one inventory read and no global activity, retaining auth/quota; full list keeps busy', async () => {
  const { a, u, counts } = inventory();
  await u.status(false, {}, { only: { ai: 'codex', account: 'named-0' } });
  assert.deepEqual(counts, { registryReads: 1, globalBusy: 0, terminalChecks: 1, auth: 1, quota: 1 });
  assert.equal(u.cache['codex:named-0'].status, 'ok');
  const full = a.list(), metadata = a.list({ includeActivity: false });
  assert.equal(full.length, 9); assert.ok(full.every(r => r.busy && r.busyReason === 'unknown-process'));
  assert.deepEqual(full.map(({ busy, authTerminal, busyReason, ...r }) => r), metadata);
});
test('metadata inventory still invalidates removed account caches and refreshes renamed labels', async () => {
  const { a, u, rows } = inventory();
  await u.status(false, {}, { only: { ai: 'codex', account: 'named-0' } });
  rows[0].name = 'renamed'; const [target] = await u.targets({}, { ai: 'codex', account: 'named-0' }); assert.equal(target.accountName, 'renamed');
  rows.shift(); await u.targets({}, { ai: 'codex', account: 'default' }); assert.equal(u.cache['codex:named-0'], undefined);
  a.read = () => { throw Error('invalid registry'); }; await assert.rejects(u.targets({}), /invalid registry/);
});
test('auth revision change during target inventory cannot retain a stale quota target', async () => {
  const { a, u } = inventory(); let resolve;
  a.status = () => new Promise(r => { resolve = r; });
  const targets = u.targets({}, { ai: 'codex', account: 'named-0' });
  u.invalidate('codex', 'named-0'); resolve({ status: 'logged-in' }); assert.deepEqual(await targets, []);
});
test('real login route keeps scoped idle gate, isolated Codex command, invalidation and mock status readback', async () => {
  const f = processFixture(), a = new Accounts({ file: '/fixture/unused', home: '/fixture', dry: true, execute: async () => ({ stdout: 'Logged in using ChatGPT', stderr: '' }) });
  a.get = (ai, id = 'default') => ({ ai, id, dir: '/fixture/' + id }); a.terminalBusy = () => false; a.busy = (_ai, account) => check(f, account);
  let opened = 0, invalidated = 0;
  const launch = { accountShell: () => 'env CODEX_HOME=/fixture/named ', sq: s => JSON.stringify(s), openTerminal: async () => { opened++; return {}; } };
  const route = require('../lib/routes/accounts')({ accounts: a, launch, usage: { invalidate: () => invalidated++ }, aiTools: { isOperating: () => false }, DRY: true, lt: s => s, record() {}, send: (_r, status, body) => ({ status, body }) }).write;
  const send = id => route.handle({}, {}, new URL('http://fixture/api/accounts/login'), { ai: 'codex', id });
  assert.equal((await send('default')).status, 409);
  const accepted = await send('named'); assert.equal(accepted.status, 200); assert.match(accepted.body.command, /CODEX_HOME=.*named/); assert.match(accepted.body.command, /--device-auth/); assert.match(accepted.body.command, /cli_auth_credentials_store/);
  assert.equal(opened, 1); assert.equal(invalidated, 1);
  a.dry = false; assert.equal((await a.status('codex', 'named')).status, 'logged-in');
  f.roots = []; const blocked = await send('named'); assert.equal(blocked.status, 409); assert.match(blocked.body.error, /アカウントを確認できません/); assert.equal(opened, 1);
  a.busy = () => false; a.terminalBusy = () => true; assert.equal((await send('named')).status, 409);
});
test('Jev same-screen entry offers local setup and official links without HTTP during HTML generation', () => {
  const { app } = require('./fixtures/app-ui-harness.cjs'), a = app(); let requests = 0;
  a.context.api = () => { requests++; throw Error('unexpected request'); };
  const html = vm.runInContext('accountSettingsHtml()', a.context);
  assert.match(html, /Jev（TypeSafe AI）/); assert.match(html, /キー登録とHubでの実利用は別/); assert.match(html, /確認に料金がかかる場合は支払い済み残高を使います/); assert.match(html, /追加購入・自動チャージはしません/);
  assert.match(html, /href="https:\/\/docs.typesafe.ai\/introduction\/quickstart" target="_blank" rel="noopener noreferrer"/);
  const row = html.slice(html.indexOf('<b>Jev'), html.indexOf('ai-chatgpt-row'));
  // Search opt-in is a checkbox; credentials are still registered through the local setup button.
  const inputs = [...row.matchAll(/<input\b[^>]*>/g)]; assert.equal(inputs.length, 1);
  assert.match(inputs[0][0], /id="jev-search-enabled"/); assert.match(inputs[0][0], /type="checkbox"/); assert.match(inputs[0][0], /\bdisabled\b/);
  assert.doesNotMatch(row, /data-account-action|<script/); assert.match(row, /id="jev-register"/);
  assert.equal(requests, 0); assert.match(html, /アカウントを追加・管理/);
});
test('bounded timing emits once without request text, account, credentials or arbitrary phase names', () => {
  let clock = 100; const rows = [];
  const trace = sendTiming((...r) => rows.push(r), { project: 'p', task: 't', ai: 'codex', account: 'PRIVATE', text: 'SECRET', token: 'SECRET' }, () => clock);
  clock += 10; trace.mark('validated'); trace.mark('SECRET'); clock += 20; trace.mark('spawned'); trace.response(200); trace.finish(); trace.finish();
  assert.equal(rows.length, 1); assert.equal(rows[0][2].totalMs, 30); assert.deepEqual(rows[0][2].checkpointsMs, { validated: 10, spawned: 30 });
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|PRIVATE/);
});
for (const rejected of [false, true]) test('actual send route records one aggregate: ' + (rejected ? 'rejected' : 'accepted'), async t => {
  const f = sendFixture(t); if (rejected) f.state.scanError = true;
  const result = await f.send({ text: 'SECRET' }); assert.equal(result.status, rejected ? 409 : 200, JSON.stringify(result));
  const rows = f.logs.filter(r => r.action === 'chat-send-timing'); assert.equal(rows.length, 1); assert.equal(rows[0].status, result.status);
  assert.ok(Number.isFinite(rows[0].totalMs)); assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
  if (!rejected) assert.deepEqual(Object.keys(rows[0].checkpointsMs), ['validated', 'handoffReady', 'prepared', 'quotaReady', 'admitted', 'spawned']);
  else assert.equal(rows[0].checkpointsMs.spawned, undefined);
});
