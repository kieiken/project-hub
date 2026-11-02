'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-separation-usage-'));
Object.assign(process.env, { HUB_ROOT: root, HUB_AI_HOME: path.join(root, 'home'), HUB_FREETALK_HOME: path.join(root, 'ft'), HUB_DRY_RUN: '1', HUB_PORT: '0', HUB_AUTO_UPDATE: '0', HUB_AUTO_TRANSLATE: '0', HUB_UPDATE_SOURCE: '', HUB_STORAGE_GUARD: '' });
const usageModule = require('../lib/usage'), OriginalUsage = usageModule.Usage;
let runtime, base, usage, releaseRead, checkingSave = false, reads = 0, saves = 0;
const resetsAt = new Date(Date.now() + 3600000).toISOString();
// The real Usage parsing and limit-saving path use an injected local read; no CLI is run.
usageModule.Usage = class extends OriginalUsage {
  constructor(options) {
    super({ ...options, dry: false, find: ai => ai === 'claude' ? '/fixture/claude' : '', read: async () => {
      reads++; await new Promise(resolve => { releaseRead = resolve; });
      return { subscription_type: 'max', rate_limits_available: true, rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: resetsAt }] } };
    } });
    usage = this;
    const observe = this.observe;
    this.observe = snapshot => {
      if (checkingSave) { runtime.restartControl.tick(); assert.equal(runtime.restartControl.committed, false, 'snapshot/save is still inside the accepted request'); }
      observe(snapshot); saves++;
    };
  }
};
const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) });
const get = route => fetch(base + route, { headers: { 'X-Hub': '1', Connection: 'close' } });
const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate()); };
test.before(async () => {
  const probe = require('node:http').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r)); process.env.HUB_PORT = String(port);
  runtime = require('../server'); runtime.aiUpdates.accounts.status = async () => ({ status: 'logged-in' });
  await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));await require('../server').restoreReady; base = 'http://127.0.0.1:' + port;
});
test.after(async () => {
  runtime.server.closeAllConnections(); await new Promise(r => runtime.server.close(r));
  usageModule.Usage = OriginalUsage; fs.rmSync(root, { recursive: true, force: true });
});
test('利用枠の前段のアカウント状態GETも待ち、予約取消を受け付ける', async () => {
  const accounts = runtime.aiUpdates.accounts, original = accounts.status; let release;
  accounts.status = async (ai, id) => { if (ai === 'claude') await new Promise(r => { release = r; }); return { status: 'logged-in' }; };
  const pending = get('/api/accounts?status=1');
  try {
    await waitFor(() => release);
    assert.equal((await post('/api/restart')).status, 409);
    const reserved = await (await post('/api/restart', { reserve: true })).json();
    assert.ok(reserved.restart.reserved); assert.ok(reserved.restart.waiting.some(x => x.kind === 'write'));
    assert.equal((await post('/api/restart/cancel')).status, 200); await runtime.restartControl.tick();
    assert.equal(runtime.restartControl.executions, 0);
  } finally { release?.(); accounts.status = original; assert.equal((await pending).status, 200); }
});
test('重なる利用枠GETを上限保存まで待ち、確定後は新規取得を拒否する', async () => {
  checkingSave = true;
  const pending = get('/api/usage'); let pendingAgain;
  try {
    await waitFor(() => releaseRead); assert.equal(usage.inflight.size, 1);
    pendingAgain = get('/api/usage');
    assert.equal((await post('/api/restart')).status, 409);
    const reserved = await (await post('/api/restart', { reserve: true })).json(); assert.ok(reserved.restart.reserved);
    await runtime.restartControl.tick(); assert.equal(runtime.restartControl.executions, 0);
    assert.equal((await post('/api/restart/cancel')).status, 200);
    assert.ok((await (await post('/api/restart', { reserve: true })).json()).restart.reserved);
  } finally {
    releaseRead?.(); assert.equal((await pending).status, 200); if (pendingAgain) assert.equal((await pendingAgain).status, 200); checkingSave = false;
  }
  assert.equal(reads, 1); assert.equal(saves, 2);
  const file = path.join(root, '_hub/limits.json'), saved = fs.readFileSync(file);
  const limits = JSON.parse(saved); assert.ok(Object.keys(limits).some(k => k.includes('fable')));
  assert.match(saved.toString(), /100/); assert.match(saved.toString(), new RegExp(resetsAt.replace(/\./g, '\\.')));
  await runtime.restartControl.tick(); assert.equal(runtime.restartControl.committed, true); assert.equal(runtime.restartControl.executions, 1);
  assert.equal((await post('/api/restart', { reserve: true })).status, 200); assert.equal(runtime.restartControl.executions, 1);
  for (const route of ['/api/usage', '/api/accounts?status=1']) assert.equal((await get(route)).status, 409);
  assert.equal(reads, 1); assert.equal(saves, 2); assert.deepEqual(fs.readFileSync(file), saved);
  const a = await (await get('/api/state')).json(), b = await (await get('/api/state')).json();
  assert.ok(a.hubInstance); assert.equal(a.hubInstance, b.hubInstance); assert.equal(a.restart.committed, true);
});
