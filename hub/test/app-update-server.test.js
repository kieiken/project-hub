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
let server, sessions, base, updater, updateOptions;
const moduleUpdate = require('../lib/app-update'), Real = moduleUpdate.AppUpdate;
test.before(async () => {
  const probe = require('node:http').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); process.env.HUB_PORT = String(port);
  moduleUpdate.AppUpdate = class extends Real { constructor(options) { super(options); updater = this; updateOptions = options; } };
  try { ({ server, sessions } = require('../server')); } finally { moduleUpdate.AppUpdate = Real; }
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + port;
});
test.after(async () => { updater.stop(); sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
const post = (route, body = {}, headers = { 'X-Hub': '1' }) => fetch(base + route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body) });
test('updater routes obey local mutation authentication and expose unsupported status without external commands', async () => {
  const data = await (await fetch(base + '/api/app-update')).json(); assert.equal(data.supported, false);
  assert.equal((await post('/api/app-update/check', {}, {})).status, 403);
  assert.equal((await post('/api/app-update', { enabled: 'yes' })).status, 400);
  assert.equal((await post('/api/app-update/check')).status, 200);
  assert.equal(fs.existsSync(path.join(root, '_hub/updates')), false);
});
test('saved unopened queues prevent applying or restarting; applying rejects new mutations', async () => {
  assert.equal(updateOptions.busy(), true);
  for (const route of ['/api/quit', '/api/restart']) assert.equal((await post(route)).status, 409);
  // Loading the saved queue must retain its request, not consume it.
  assert.equal(JSON.parse(fs.readFileSync(queueFile))[0].id, 'saved');
  updater.data.phase = 'installing';
  assert.equal((await post('/api/task', { project: 'P', task: 't', title: 'changed' })).status, 409);
  updater.data.phase = 'installed'; updater.restartNeeded = true;
  assert.equal((await post('/api/quit')).status, 409);
  updater.restartNeeded = false;
});
