'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { ConversationSearch } = require('../lib/conversation-search');
const createRoutes = require('../lib/routes/conversation-search');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const digest = b => createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-search-')), search = new ConversationSearch(root);
  fs.mkdirSync(path.join(root, 'Product')); t.after(() => { search.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  function topic(project, task = 't', more = '') { const dir = path.join(root, 'Product', project); write(path.join(dir, 'PROJECT.md'), `---\nname: ${project}\n${project === 'freetalk' ? 'kind: freetalk\n' : ''}${more}\n---\n`); write(path.join(dir, '.ai/tasks', task + '.md'), `---\ntitle: ${task}\nstate: 完了\n---\n`); return dir; }
  function log(dir, rows, task = 't') { return write(path.join(dir, '.ai/chat', task + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  function archive(dir, rows, { task = 't', stage = 'committed', modify = false } = {}) {
    const id = randomUUID(), bytes = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n'), folder = path.join(dir, '.ai/chat/history', task, id), file = write(path.join(folder, '1.original'), bytes); fs.chmodSync(file, 0o600);
    write(path.join(folder, 'manifest.json'), JSON.stringify({ id, project: path.basename(dir), task, stage, entries: [{ saved: '1.original', kind: 'log', existed: true, bytes: bytes.length, mode: 0o600, digest: modify ? 'f'.repeat(64) : digest(bytes) }] })); return { id, file, folder };
  }
  return { root, search, write, topic, log, archive };
}
const row = (text, role = 'user') => ({ role, text, at: '2026-10-24T10:00:00Z' });
async function done(search, query, mode = 'detailed') { const { id } = search.start(query, mode); for (let i = 0; i < 1000; i++) { const data = search.get(id); if (data.status !== 'running') { assert.equal(data.status, 'done'); return { id, ...data }; } await new Promise(r => setTimeout(r, 10)); } throw Error('search timeout'); }

test('all registered projects, child/completed tasks and freetalk; NFKC/case/multiword ranking and visible questions only', async t => {
  const f = fixture(t), p = f.topic('Parent'), c = f.topic('Child', 'done', 'parent: Parent'), ft = f.topic('freetalk');
  f.log(p, [row('Ｍｕｓｅ 設定を確認'), row('設定とmuseの間'), row('設定だけ'), row('secretCLI', 'tool'), { ...row('other', 'assistant'), asks: [{ question: 'Museの設定？', options: ['確認'] }], token: 'secretCLI' }]);
  f.log(c, [row('Muse 設定 child', 'assistant')], 'done'); f.log(ft, [row('Muse 設定 freetalk')]);
  const r = await done(f.search, 'muse 設定'); assert.equal(r.total, 6); assert.equal(r.hits[0].score, 3); assert.ok(r.hits.some(h => h.project === 'freetalk')); assert.ok(r.hits.some(h => h.task === 'done'));
  assert.deepEqual(new Set(r.hits.map(h => h.score)), new Set([1, 2, 3])); assert.equal((await done(f.search, 'secretCLI')).total, 0);
});
test('verified archives only; deduplicate overlapping generations, preserve same timestamps, exact read-only context', async t => {
  const f = fixture(t), p = f.topic('P'), duplicate = row('target duplicate'); f.log(p, [duplicate, row('next')]);
  const a = f.archive(p, [row('before'), row('target old'), row('after'), duplicate]); f.archive(p, [row('target tampered')], { modify: true }); f.archive(p, [row('target uncommitted')], { stage: 'prepared' });
  const ft = f.topic('freetalk'); f.log(ft, [row('hi')]); f.archive(ft, [row('target FT trash')]);
  const r = await done(f.search, 'target'); assert.equal(r.total, 2); assert.ok(r.stats.skipped >= 2); const h = r.hits.find(h => h.archiveId === a.id); assert.ok(h);
  const data = await f.search.context(r.id, h.id); assert.equal(data.rows.find(r => r.target).text, 'target old'); assert.equal(data.rows[0].text, 'before'); assert.equal(data.rows[2].text, 'after');
  fs.writeFileSync(a.file, 'changed'); await assert.rejects(f.search.context(r.id, h.id), /変更|安全/);
});
test('missing/unregistered tasks, trash, CLI/auth files and symlinks are never searched; unsafe manifest is excluded', async t => {
  const f = fixture(t), p = f.topic('P'); f.log(p, [row('allowed')]);
  for (const rel of ['.ai/chat/orphan.jsonl', '.ai/chat/t.json', '.ai/chat/t.queue.json', '.ai/cli/t.jsonl', '.ai/auth.json', '.Trash/t.jsonl']) f.write(path.join(p, rel), JSON.stringify(row('needle secret')));
  f.write(path.join(f.root, 'Product/_trash/PROJECT.md'), '---\nname: Trash\n---\n'); f.log(path.join(f.root, 'Product/_trash'), [row('needle trash')]);
  const outside = f.write(path.join(f.root, 'outside.jsonl'), JSON.stringify(row('needle symlink')) + '\n'); const q = f.topic('Linked'); fs.symlinkSync(outside, path.join(q, '.ai/chat-link')); fs.mkdirSync(path.join(q, '.ai/chat')); fs.symlinkSync(outside, path.join(q, '.ai/chat/t.jsonl'));
  const a = f.archive(p, [row('needle escaped')]); const m = JSON.parse(fs.readFileSync(path.join(a.folder, 'manifest.json'))); m.entries[0].saved = '../../../../outside.jsonl'; fs.writeFileSync(path.join(a.folder, 'manifest.json'), JSON.stringify(m));
  const r = await done(f.search, 'needle'); assert.equal(r.total, 0); assert.ok(r.stats.skipped >= 2);
});
test('pagination, hit cap, empty/invalid input, expiry, cancellation and no invented all-clear on oversized/malformed logs', async t => {
  const f = fixture(t), p = f.topic('P'); f.log(p, Array.from({ length: 1050 }, (_, i) => row('needle ' + i)));
  const r = await done(f.search, 'needle'); assert.equal(r.total, 1000); assert.equal(r.hits.length, 50); assert.equal(r.next, 50); assert.equal(r.stats.limited, true);
  const second = f.search.get(r.id, 50); assert.equal(second.hits[0].id, 50); assert.notDeepEqual(second.hits, r.hits); assert.throws(() => f.search.get(r.id, -1)); assert.throws(() => f.search.get(r.id, 1));
  for (const q of ['', ' ', 'a'.repeat(201), 'a b c d e f g h i']) assert.throws(() => f.search.start(q));
  const j = f.search.start('cancel'); f.search.cancel(j.id); assert.throws(() => f.search.get(j.id)); f.search.jobs.get(r.id).at = 0; assert.throws(() => f.search.get(r.id));
  f.log(p, [row('safe')]); fs.appendFileSync(path.join(p, '.ai/chat/t.jsonl'), 'malformed\n' + 'x'.repeat(2 * 1024 * 1024 + 1) + '\n'); const missing = await done(f.search, 'none'); assert.equal(missing.total, 0); assert.equal(missing.stats.skippedRows, 2);
  fs.truncateSync(path.join(p, '.ai/chat/t.jsonl'), 64 * 1024 * 1024 + 1); const huge = await done(f.search, 'none'); assert.equal(huge.stats.skipped, 1);
});
test('fresh search reflects append, rotation and deletion; stale hits cannot jump to an unrelated row', async t => {
  const f = fixture(t), p = f.topic('P'), file = f.log(p, [row('needle original')]); const old = await done(f.search, 'needle');
  fs.appendFileSync(file, JSON.stringify(row('needle appended')) + '\n'); await assert.rejects(f.search.context(old.id, 0), /変更/); assert.equal((await done(f.search, 'needle')).total, 2);
  f.archive(p, [row('needle original'), row('needle appended')]); f.log(p, [row('fresh')]); assert.equal((await done(f.search, 'needle')).total, 2);
  fs.unlinkSync(path.join(p, '.ai/tasks/t.md')); assert.equal((await done(f.search, 'needle')).total, 0);
});
test('HTTP route enforces local/Origin/header/schema and never marks read or writes transcript state', async t => {
  const f = fixture(t), p = f.topic('P'); const file = f.log(p, [row('<script>needle</script>')]), bytes = fs.readFileSync(file); let remote = false;
  const routes = createRoutes({ search: f.search, PORT: 4545, fromRemote: () => remote, send: (_r, status, body) => ({ status, body }) });
  const url = new URL('http://localhost/api/conversation-search'), req = { method: 'POST', headers: { 'x-hub': '1', origin: 'http://localhost:4545' } };
  assert.equal((await routes.access.handle({ ...req, headers: {} }, {}, url, { query: 'needle' })).status, 403); remote = true; assert.equal((await routes.access.handle(req, {}, url, { query: 'needle' })).status, 403); remote = false;
  assert.equal((await routes.access.handle({ ...req, headers: { ...req.headers, origin: 'https://evil.test' } }, {}, url, { query: 'needle' })).status, 403);
  assert.equal((await routes.access.handle(req, {}, url, { query: 'needle', file: '/etc/passwd' })).status, 400);
  const start = await routes.access.handle(req, {}, url, { query: 'needle' }); assert.equal(start.status, 200); let r;
  do { await new Promise(r => setTimeout(r, 10)); r = f.search.get(start.body.id); } while (r.status === 'running');
  const contextURL = new URL('http://localhost/api/conversation-search/context?' + new URLSearchParams({ id: start.body.id, hit: 0 })); const c = await routes.access.handle({ ...req, method: 'GET' }, {}, contextURL); assert.equal(c.body.rows[0].text, '<script>needle</script>'); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('large synthetic logs run off the HTTP event loop, remain bounded and allow concurrent heartbeat requests', async t => {
  const f = fixture(t), p = f.topic('Large'), line = JSON.stringify(row('background ' + 'a'.repeat(700))) + '\n', file = path.join(p, '.ai/chat/t.jsonl');
  f.write(file, line.repeat(40000) + JSON.stringify(row('rare needle')) + '\n');
  const http = require('node:http'), server = http.createServer((_req, res) => res.end('alive')); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable(); const begin = performance.now(), job = f.search.start('rare needle'), heartbeats = [];
  while (f.search.get(job.id).status === 'running') { const at = performance.now(); const r = await fetch('http://127.0.0.1:' + server.address().port); assert.equal(await r.text(), 'alive'); heartbeats.push(performance.now() - at); await new Promise(r => setTimeout(r, 5)); }
  delay.disable(); assert.equal(f.search.get(job.id).total, 1); assert.ok(heartbeats.length > 2); assert.ok(delay.max / 1e6 < 300, 'main event loop must remain responsive');
  console.log('SEARCH_BENCH ' + JSON.stringify({ bytes: fs.statSync(file).size, searchMs: +(performance.now() - begin).toFixed(1), heartbeatCount: heartbeats.length, heartbeatMaxMs: +Math.max(...heartbeats).toFixed(1), mainLoopMaxMs: +(delay.max / 1e6).toFixed(1) }));
});


test('simple mode never touches history; detailed mode preserves verification and mode through pagination/context', async t => {
  const f = fixture(t), p = f.topic('P'), ft = f.topic('freetalk');
  f.log(p, [row('needle current')]); f.log(ft, [row('needle topic')]);
  const archived = f.archive(p, [row('needle old')]); f.archive(p, [row('needle invalid')], { modify: true });
  const { search: direct } = require('../lib/conversation-search-worker');
  const originals = new Map(), touched = [];
  // Observe every sync filesystem entry used by the worker, not just returned result counters.
  for (const name of ['readdirSync', 'readFileSync', 'lstatSync', 'statSync', 'openSync']) {
    const fn = fs[name]; originals.set(name, fn);
    fs[name] = function (file, ...args) { if (String(file).includes('/history')) touched.push([name, String(file)]); return fn.call(this, file, ...args); };
  }
  let simple;
  try { simple = direct({ root: f.root, query: 'needle', mode: 'simple' }); } finally { for (const [name, fn] of originals) fs[name] = fn; }
  assert.deepEqual(touched, []); assert.equal(simple.hits.length, 2); assert.equal(simple.stats.historyDirectories, 0); assert.equal(simple.stats.manifests, 0); assert.equal(simple.stats.archiveBytes, 0);
  const d = await done(f.search, 'needle', 'detailed'); assert.equal(d.mode, 'detailed'); assert.equal(d.total, 3); assert.equal(d.stats.skipped, 1);
  const old = d.hits.find(h => h.archiveId === archived.id), c = await f.search.context(d.id, old.id);
  assert.equal(c.mode, 'detailed'); assert.deepEqual(c.target, { project: 'P', task: 't', freetalk: false });
  const q = await done(f.search, 'needle', 'simple'); assert.equal(q.mode, 'simple'); assert.equal(q.total, 2); assert.equal(f.search.get(q.id, 0).mode, 'simple');
  assert.equal((await f.search.context(q.id, 0)).mode, 'simple');
  assert.throws(() => f.search.start('needle', 'all')); assert.throws(() => direct({ root: f.root, query: 'needle', mode: 'all' }));
  const defaultJob = f.search.start('needle'); assert.equal(defaultJob.mode, 'simple');
  const route = createRoutes({ search: f.search, PORT: 4545, fromRemote: () => false, send: (_r, status, body) => ({ status, body }) }).access;
  const req = { method: 'POST', headers: { 'x-hub': '1' } }, url = new URL('http://localhost/api/conversation-search');
  for (const mode of ['all', null, [], {}]) assert.equal((await route.handle(req, {}, url, { query: 'needle', mode })).status, 400);
  const r = await route.handle(req, {}, url, { query: 'needle', mode: 'detailed' }); assert.equal(r.status, 200); assert.equal(r.body.mode, 'detailed');
});

test('mode comparison on many synthetic archives records read volume and timings without real transcripts', async t => {
  const f = fixture(t), p = f.topic('P'); f.log(p, [row('needle current')]);
  for (let i = 0; i < 80; i++) f.archive(p, [row('needle archived ' + i), ...Array.from({ length: 200 }, () => row('background ' + 'a'.repeat(900)))]);
  const samples = [];
  for (const mode of ['simple', 'detailed']) for (let i = 0; i < 4; i++) {
    const begin = performance.now(), r = await done(f.search, 'needle', mode);
    if (mode === 'simple') { assert.equal(r.total, 1); assert.equal(r.stats.historyDirectories, 0); assert.equal(r.stats.archiveBytes, 0); }
    else { assert.equal(r.total, 81); assert.equal(r.stats.manifests, 80); assert.ok(r.stats.archiveBytes > 15000000); }
    samples.push({ mode, warmup: i === 0, ms: +(performance.now() - begin).toFixed(2), total: r.total, ...r.stats });
  }
  console.log('SEARCH_MODES_BENCH ' + JSON.stringify({ syntheticOnly: true, samples }));
});

test('persistent archive cache reuses normalized rows but detects content/manifest/current changes and disappearance',async t=>{
 const f=fixture(t),p=f.topic('P');f.log(p,[row('needle current')]);const a=f.archive(p,[row('needle archived'),row('other')]);
 const first=await done(f.search,'needle'),second=await done(f.search,'needle');assert.equal(second.stats.archiveCacheHits,1);assert.equal(second.stats.archiveBytes,0);assert.deepEqual(second.hits,first.hits);
 f.log(p,[row('needle current'),row('needle appended')]);const appended=await done(f.search,'needle');assert.equal(appended.total,3);assert.equal(appended.stats.archiveCacheHits,1);
 const original=fs.readFileSync(a.file),st=fs.statSync(a.file);fs.writeFileSync(a.file,original.toString().replace('archived','modified'));fs.utimesSync(a.file,st.atime,st.mtime);const tampered=await done(f.search,'needle');assert.equal(tampered.total,2);assert.equal(tampered.stats.skipped,1);
 fs.writeFileSync(a.file,original);const restored=await done(f.search,'needle');assert.equal(restored.total,3);assert.ok(restored.stats.archiveBytes>0);
 const mf=path.join(a.folder,'manifest.json'),m=JSON.parse(fs.readFileSync(mf));fs.writeFileSync(mf,JSON.stringify({...m,stage:'prepared'}));assert.equal((await done(f.search,'needle')).total,2);
 fs.writeFileSync(mf,JSON.stringify(m));fs.unlinkSync(a.file);assert.equal((await done(f.search,'needle')).total,2);
});
test('archive cache memory is bounded and simple search never consults it',t=>{
 const f=fixture(t),p=f.topic('P'),direct=require('../lib/conversation-search-worker');f.log(p,[row('needle current')]);
 for(let i=0;i<7;i++)f.archive(p,[row('needle '+i+'x'.repeat(1200000))]);
 const r=direct.search({root:f.root,query:'needle',mode:'detailed'});assert.equal(r.hits.length,8);const info=direct.cacheInfo();assert.ok(info.bytes<=info.limit);assert.ok(info.entries<7);
 const simple=direct.search({root:f.root,query:'needle',mode:'simple'});assert.equal(simple.hits.length,1);assert.equal(simple.stats.archiveBytes,0);assert.equal(simple.stats.archiveCacheHits,undefined);
});
test('cancelled or closed searches cannot put late workers back into the idle pool',async t=>{
 const f=fixture(t),p=f.topic('P');f.log(p,[row('needle')]);
 const pending=f.search.start('needle');f.search.cancel(pending.id);await new Promise(r=>setTimeout(r,100));assert.equal(f.search.idleWorkers.size,0);
 await done(f.search,'needle');assert.equal(f.search.idleWorkers.size,1);
 f.search.start('needle');f.search.close();await new Promise(r=>setTimeout(r,100));assert.equal(f.search.idleWorkers.size,0);assert.equal(f.search.jobs.size,0);assert.throws(()=>f.search.start('needle'));
});
