'use strict';
// Full server wiring against a synthetic ledger only. No AI, live ledger or external connection.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-search-http-')), root = path.join(tmp, 'root');
fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
Object.assign(process.env, { HUB_LANG: 'ja', HUB_ROOT: root, HUB_AI_HOME: path.join(tmp, 'home'), HUB_FREETALK_HOME: path.join(tmp, 'freetalk'), HUB_DRY_RUN: '1', HUB_PORT: '0', HUB_AUTO_UPDATE: '0', HUB_AUTO_TRANSLATE: '0' });
const chat = require('../lib/chat'), originalSend = chat.ChatRunner.prototype.send;
chat.ChatRunner.prototype.send = () => assert.fail('Search fixture must never start an AI');
let rt, base;
test.before(async () => {
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); process.env.HUB_PORT = String(probe.address().port); await new Promise(r => probe.close(r));
  rt = require('../server'); await new Promise(r => rt.server.listen(Number(process.env.HUB_PORT), '127.0.0.1', r)); base = 'http://127.0.0.1:' + rt.server.address().port;
});
test.after(async () => { chat.ChatRunner.prototype.send = originalSend; if (rt) { rt.server.closeAllConnections(); await new Promise(r => rt.server.close(r)); } fs.rmSync(tmp, { recursive: true, force: true }); });
test('real HTTP dispatch: search, context, cancellation, malformed JSON, origin and unchanged source', async () => {
  const dir = path.join(root, 'Product', 'Synthetic');
  fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/chat'));
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Synthetic\n---\n'); fs.writeFileSync(path.join(dir, '.ai/tasks/done.md'), '---\ntitle: Completed\nstate: 完了\n---\n');
  const file = path.join(dir, '.ai/chat/done.jsonl'), bytes = JSON.stringify({ role: 'user', at: '2026-10-24T10:00:00Z', text: '検索語 fixture' }) + '\n'; fs.writeFileSync(file, bytes);
  const headers = { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, post = body => fetch(base + '/api/conversation-search', { method: 'POST', headers, body });
  const bad = await post('{malformed'); assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes('{malformed'));
  const denied = await fetch(base + '/api/conversation-search', { method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' }, body: '{"query":"fixture"}' }); assert.equal(denied.status, 403);
  for (const mode of ['all', null, 1]) assert.equal((await post(JSON.stringify({ query: '検索語', mode }))).status, 400);
  const started = await post('{"query":"検索語"}'); assert.equal(started.status, 200); const { id, mode } = await started.json(); assert.equal(mode, 'simple'); let result;
  for (let i = 0; i < 500; i++) { const r = await fetch(base + '/api/conversation-search?' + new URLSearchParams({ id }), { headers }); assert.equal(r.status, 200); result = await r.json(); if (result.status !== 'running') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(result.status, 'done'); assert.equal(result.mode, 'simple'); assert.equal(result.total, 1); assert.equal(result.hits[0].taskName, 'Completed');
  const missing = await fetch(base + '/api/conversation-search/context?' + new URLSearchParams({ id }), { headers }); assert.equal(missing.status, 400);
  const context = await fetch(base + '/api/conversation-search/context?' + new URLSearchParams({ id, hit: 0 }), { headers }); assert.equal(context.status, 200); const detail = await context.json(); assert.equal(detail.rows[0].target, true); assert.equal(detail.mode, 'simple'); assert.deepEqual(detail.target, { project: 'Synthetic', task: 'done', freetalk: false });
  const detailed = await (await post('{"query":"検索語","mode":"detailed"}')).json(); assert.equal(detailed.mode, 'detailed'); assert.equal((await (await fetch(base + '/api/conversation-search?' + new URLSearchParams({ id: detailed.id }), { headers })).json()).mode, 'detailed'); await fetch(base + '/api/conversation-search/cancel', { method: 'POST', headers, body: JSON.stringify({ id: detailed.id }) });
  const ping = await fetch(base + '/api/ping', { headers }); assert.equal(ping.status, 200);
  const cancel = await fetch(base + '/api/conversation-search/cancel', { method: 'POST', headers, body: JSON.stringify({ id }) }); assert.equal(cancel.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(rt.chats.running.size, 0);
});
