'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-update-server-'));
const project = path.join(root, 'Product/P');
fs.mkdirSync(path.join(project, '.ai/tasks'), { recursive: true });
fs.mkdirSync(path.join(project, '.ai/chat'));
fs.writeFileSync(path.join(project, 'PROJECT.md'), '---\nname: P\nfolders: {}\n---\n');
fs.writeFileSync(path.join(project, '.ai/tasks/t.md'), '---\nid: t\ntitle: t\nstate: 未着手\nworkspaceMode: direct\n---\n');
// Written before server initialization: a queue that has never been opened in UI.
const queueFile = path.join(project, '.ai/chat/t.queue.json');
fs.writeFileSync(queueFile, JSON.stringify([{ id: 'saved', text: 'fixture queued instruction' }]));
Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(root, 'home'), HUB_STORAGE_GUARD: '', HUB_UPDATE_SOURCE: '', HUB_UPDATE_APP: '', HUB_AUTO_TRANSLATE: '0' });
let server, sessions, base, updater, updateOptions, shell, restart;
const moduleShell = require('../lib/app-shell'), RealShell = moduleShell.AppShell;
let background = [];
const moduleProcwatch = require('../lib/procwatch'), realCreate = moduleProcwatch.create;
const moduleUpdate = require('../lib/app-update'), Real = moduleUpdate.AppUpdate;
test.before(async () => {
  const probe = require('node:http').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); process.env.HUB_PORT = String(port);
  moduleShell.AppShell = class extends RealShell { constructor(options) { super(options); shell = this; } };
  moduleUpdate.AppUpdate = class extends Real { constructor(options) { super(options); updater = this; updateOptions = options; } };
  moduleProcwatch.create = () => ({ list: () => background, onChange() {}, start() {}, stop() {} });
  try { ({ server, sessions, restartControl:restart } = require('../server')); } finally { moduleUpdate.AppUpdate = Real; moduleProcwatch.create = realCreate; moduleShell.AppShell = RealShell; }
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + port;
});
test.after(async () => { updater.stop(); sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
const post = (route, body = {}, headers = { 'X-Hub': '1' }) => fetch(base + route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) });
test('language APIs import data, save for restart, reject invalid choices and preserve busy AI/queues', async () => {
  const source = path.join(root, 'external-language'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'pack.json'), JSON.stringify({ id: 'zh-TW', name: '繁體中文', verifiedWith: '4.108.0' }));
  fs.writeFileSync(path.join(source, 'ui.json'), JSON.stringify({ 'あなたの番': 'Pack text' }));
  fs.writeFileSync(path.join(source, 'backend.json'), JSON.stringify({ messages: {}, labels: {} }));
  assert.equal((await post('/api/langpacks/import', { dir: source }, {})).status, 403);
  assert.equal((await post('/api/langpacks/import', { dir: source }, { 'X-Hub': '1', Origin: 'https://another.example' })).status, 403);
  assert.equal((await post('/api/langpacks/import', { dir: source })).status, 200);
  assert.equal((await post('/api/language', { language: 'unknown' })).status, 400);
  assert.equal((await post('/api/language', { language: 'zh-TW' })).status, 200);
  let settings = await (await fetch(base + '/api/langpacks')).json();
  assert.equal(settings.active, 'ja'); assert.equal(settings.saved, 'zh-TW'); assert.equal(settings.restartNeeded, true);
  assert.equal(settings.packs.find(pack => pack.source === 'installed').name, '繁體中文');
  assert.equal((await (await fetch(base + '/api/locale')).json()).language, 'ja');
  const before = fs.readFileSync(queueFile); const running = sessions.list();
  assert.equal((await post('/api/restart')).status, 200);restart.committed=false;
  assert.deepEqual(fs.readFileSync(queueFile), before); assert.deepEqual(sessions.list(), running);
  assert.equal((await post('/api/langpacks/remove', { id: 'zh-TW' })).status, 200);
  settings = await (await fetch(base + '/api/langpacks')).json(); assert.equal(settings.saved, 'ja');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '_hub/language.json'))).language, 'ja');
  assert.equal((await post('/api/langpacks/remove', { id: 'zh-TW' })).status, 400);
});
test('authenticated remote requests cannot read or change language settings', async () => {
  assert.equal((await post('/api/remote', { enabled: true, passcode: 'local-test-passphrase' })).status, 200);
  const headers = { 'X-Hub': '1', 'X-Forwarded-For': '100.64.0.7', 'X-Forwarded-Host': 'mac.example', Origin: 'https://mac.example' };
  const login = await post('/api/login', { passcode: 'local-test-passphrase' }, headers); assert.equal(login.status, 200);
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const before = fs.readFileSync(path.join(root, '_hub/language.json'));
  for (const route of ['/api/langpacks/import', '/api/langpacks/remove', '/api/language']) assert.equal((await post(route, {}, headers)).status, 403);
  assert.equal((await fetch(base + '/api/langpacks', { headers })).status, 403);
  assert.deepEqual(fs.readFileSync(path.join(root, '_hub/language.json')), before);
  await post('/api/remote', { enabled: false });
});
test('updater routes obey local mutation authentication and expose unsupported status without external commands', async () => {
  const data = await (await fetch(base + '/api/app-update')).json(); assert.equal(data.supported, false);
  assert.equal((await post('/api/app-update/check', {}, {})).status, 403);
  assert.equal((await post('/api/app-update', { enabled: 'yes' })).status, 400);
  assert.equal((await post('/api/app-update/check')).status, 200);
  assert.equal(fs.existsSync(path.join(root, '_hub/updates')), false);
});

test('packaged updater receives runtime, license and restored backend proof only after the state response', async () => {
  assert.equal(updateOptions.hubPath, path.resolve(__dirname, '..'));
  assert.equal(updateOptions.version, require('../package.json').version); assert.equal(typeof updateOptions.license.status, 'function');
  const ping = await (await fetch(base + '/api/ping')).json();
  assert.equal(ping.version, updateOptions.version); assert.equal(ping.runtimePath, updateOptions.hubPath);
  assert.equal(ping.restored, true); assert.ok(ping.instance); assert.equal(ping.updateConfirm, '');
  let proof;
  updater.healthy = async value => { proof = value; return true; };
  try {
    assert.equal((await fetch(base + '/api/state')).status, 200);
    for (let i = 0; i < 50 && !proof; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(proof, { version: updateOptions.version, hubPath: updateOptions.hubPath, token: process.env.HUB_UPDATE_CONFIRM, restored: true, instance: ping.instance });
    assert.equal((await post('/api/app-update', { action: 'apply' })).status, 409);
  } finally { delete updater.healthy; }
});
test('packaged confirmation remains pending after 304, failed or interrupted state responses and confirms after recovery', async () => {
  const oldStatus = updater.status, oldData = updater.data;
  const pending = { version: updateOptions.version, token: 'fixture' };
  let confirm = false, proofs = [];
  updater.data = { ...oldData, pendingConfirm: pending };
  updater.healthy = async proof => {
    proofs.push(proof);
    if (confirm) delete updater.data.pendingConfirm;
    return confirm;
  };
  const headers = { Connection: 'close', 'Accept-Encoding': 'identity' };
  // Close before end/finish, rather than racing a real client's cancellation.
  const interrupt = (req, res) => {
    if (req.headers['x-fixture-interrupt'] === '1') res.end = function () { this.destroy(); return this; };
  };
  try {
    const first = await fetch(base + '/api/state', { headers });
    assert.equal(first.status, 200); await first.arrayBuffer();
    assert.equal(proofs.length, 1); proofs = []; confirm = true;
    const cached = await fetch(base + '/api/state', { headers: { ...headers, 'If-None-Match': first.headers.get('etag') } });
    assert.equal(cached.status, 304); await cached.arrayBuffer();
    assert.equal(proofs.length, 0); assert.equal(updater.data.pendingConfirm, pending);

    updater.status = () => { throw Error('fixture-state-failure'); };
    const failed = await fetch(base + '/api/state', { headers });
    assert.equal(failed.status, 500); assert.equal((await failed.json()).error, 'fixture-state-failure');
    assert.equal(proofs.length, 0); assert.equal(updater.data.pendingConfirm, pending);
    updater.status = oldStatus;

    server.prependListener('request', interrupt);
    await assert.rejects(fetch(base + '/api/state', { headers: { ...headers, 'X-Fixture-Interrupt': '1' } }));
    server.removeListener('request', interrupt);
    assert.equal(proofs.length, 0); assert.equal(updater.data.pendingConfirm, pending);

    const recovered = await fetch(base + '/api/state', { headers });
    assert.equal(recovered.status, 200); await recovered.arrayBuffer();
    assert.equal(proofs.length, 1); assert.equal(proofs[0].restored, true);
    assert.equal(updater.data.pendingConfirm, undefined);
  } finally {
    server.removeListener('request', interrupt);
    updater.status = oldStatus; updater.data = oldData; delete updater.healthy;
  }
});
test('saved unopened queues prevent applying but permit verified restarting; applying rejects new mutations', async () => {
  assert.equal(await updater.strictBusy(), true);
  assert.equal((await post('/api/restart')).status,200);restart.committed=false;
  for (const route of ['/api/quit', '/api/app/rebuild']) assert.equal((await post(route)).status, 409);
  // Loading the saved queue must retain its request, not consume it.
  assert.equal(JSON.parse(fs.readFileSync(queueFile))[0].id, 'saved');
  updater.data.phase = 'installing';
  assert.equal((await post('/api/task', { project: 'P', task: 't', title: 'changed' })).status, 409);
  updater.data.phase = 'installed'; updater.restartNeeded = true;
  assert.equal((await post('/api/quit')).status, 409);
  updater.restartNeeded = false;
});

test('unrelated background helpers do not block updates, but project AI and saved queues still do', async () => {
  updater.data.phase = 'idle';
  assert.equal((await post('/api/chat/unqueue', { project: 'P', task: 't', id: 'saved' })).status, 200);
  background = [{ pid: 90001, ai: 'codex', project: null, task: null, command: 'codex app-server', cwd: '/outside' },
    { pid: 90002, ai: 'codex', project: null, task: null, command: 'codex exec-server', cwd: '/outside' }];
  try {
    assert.equal(await updater.strictBusy(), false);
    assert.equal((await (await fetch(base + '/api/state')).json()).background.length, 0);
    for (const route of ['/api/quit', '/api/restart']) assert.equal((await post(route)).status, 200);restart.committed=false;
    background.push({ pid: 90003, ai: 'codex', project: 'P', task: 't', command: 'codex', cwd: project });
    assert.equal(await updater.strictBusy(), true);
    for (const route of ['/api/quit', '/api/restart']) assert.equal((await post(route)).status, 409);
    background.pop();
    // A different unopened task proves the on-disk queue is checked, not just an in-memory queue.
    fs.writeFileSync(path.join(project, '.ai/tasks/u.md'), '---\nid: u\ntitle: u\nstate: 未着手\nworkspaceMode: direct\n---\n');
    fs.writeFileSync(path.join(project, '.ai/chat/u.queue.json'), JSON.stringify([{ id: 'later', text: 'still waiting' }]));
    assert.equal(await updater.strictBusy(), true);
    assert.equal((await post('/api/restart')).status, 200);restart.committed=false;
  } finally { background = []; }
});

test('shell rebuild route authenticates, refuses update and dry mode, and exposes shell state',async()=>{
 assert.equal((await post('/api/app/rebuild',{},{})).status,403);
 assert.equal((await post('/api/chat/unqueue',{project:'P',task:'u',id:'later'})).status,200);
 assert.equal(await updater.strictBusy(),false);
 updater.running=Promise.resolve();assert.equal((await post('/api/app/rebuild')).status,409);updater.running=null;
 updater.data.phase='installing';assert.equal((await post('/api/app/rebuild')).status,409);updater.data.phase='idle';
 const dry=await post('/api/app/rebuild');assert.equal(dry.status,409);assert.match((await dry.json()).error,/試験中/);
 const state=await(await fetch(base+'/api/state')).json();assert.match(state.appShell.hash,/^[a-f0-9]{64}$/);assert.equal(typeof state.appShell.stale,'boolean');
});

test('shell rebuild route returns success after a mocked build and prevents concurrent writes', async () => {
 const original = shell.rebuild; let finish;
 shell.rebuild = () => { shell.rebuilding = true; return new Promise(resolve => { finish = () => { shell.rebuilding = false; resolve({ok:true,message:'アプリを終了して開き直してください'}); }; }); };
 try {
  const pending = post('/api/app/rebuild');
  for (let i=0; i<100 && !finish; i++) await new Promise(r=>setTimeout(r,10)); assert.ok(finish);
  assert.equal((await post('/api/app/rebuild')).status,409); assert.equal((await post('/api/app-update/check')).status,409);
  assert.equal((await post('/api/task',{project:'P',task:'t',title:'blocked'})).status,409);
  finish(); const response=await pending;assert.equal(response.status,200);assert.match((await response.json()).message,/開き直して/);
 } finally { if (shell.rebuilding) finish(); shell.rebuild=original; }
});
