'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const http = require('node:http'), { gunzipSync } = require('node:zlib');
const { Store } = require('../lib/store'), { noLinks, noLink } = require('../lib/remove');
const { TaskTransfer } = require('../lib/task-transfer'), { TaskIntegrate } = require('../lib/task-integrate');
const { TaskHistory } = require('../lib/task-history'), { Maintenance } = require('../lib/maintenance');
const { StaticFiles, sendEncoded } = require('../lib/static-files');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-wopt-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Product/P');
  fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: P\nphases: []\nrelated: []\n---\n');
  const store = new Store(root), parent = store.createTask('P', { title: 'Parent' }), child = store.createTask('P', { title: 'Child', parent: parent.id });
  const transfer = new TaskTransfer({ store, removal: {} });
  const integrate = new TaskIntegrate({ store, transfer, removal: {} });
  const history = new TaskHistory({ store });
  return { root, store, transfer, integrate, history, parent, child };
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); }

test('batch record readers keep valid projections and skip corrupt, completed and unrelated records', t => {
  const f = fixture(t), { transfer, integrate, history } = f;
  write(transfer.file('P', f.child.id), { project: 'P', task: f.child.id, title: 'Child', targetProject: 'P', targetTask: f.parent.id });
  write(transfer.file('P', 'bad'), '{');
  write(transfer.file('P', 'done'), { complete: true });
  assert.deepEqual(transfer.pending(), [{ project: 'P', task: f.child.id, title: 'Child', targetProject: 'P', targetTask: f.parent.id }]);
  assert.equal(transfer.offers({ verify: false }).find(x => x.task === f.child.id).pending, true);
  write(integrate.file('P', 'pending'), { project: 'P', task: 'pending', id: 'i', items: [] });
  write(integrate.file('P', 'bad'), '{');
  write(integrate.file('P', 'done'), { complete: true, auto: { main: { state: 'done' } } });
  assert.deepEqual(integrate.pending(), [{ project: 'P', task: 'pending', id: 'i', items: [], auto: undefined, stage: 'children', mainPending: null }]);
  const auto = { project: 'P', task: f.child.id, stage: 'reserved', id: 'auto' };
  write(history.file('P', f.child.id), { generation: 1, auto });
  write(history.file('P', 'bad'), '{');
  write(history.file('P', 'done'), { auto: { ...auto, task: 'done', stage: 'done' } });
  write(history.file('P', 'wrong'), { auto });
  assert.deepEqual(history.activeAutos(), [auto]);
  assert.equal(fs.readFileSync(history.file('P', 'bad'), 'utf8'), '{');
});

for (const name of ['transfer', 'integrate', 'history']) test(`${name}: direct and dangling record symlinks are skipped; external reads reject them`, t => {
  const f = fixture(t), reader = f[name], file = reader.file('P', f.child.id);
  const record = { project: 'P', task: f.child.id, items: [], generation: 1, auto: { project: 'P', task: f.child.id, stage: 'reserved' } };
  const outside = path.join(f.root, 'outside.json'); write(outside, record); fs.mkdirSync(reader.dir, { recursive: true });
  const list = () => name === 'history' ? reader.activeAutos() : reader.pending();
  for (const target of [outside, path.join(f.root, 'missing.json')]) {
    fs.symlinkSync(target, file); assert.deepEqual(list(), []);
    assert.throws(() => name === 'history' ? reader.state('P', f.child.id) : reader.read('P', f.child.id), /リンクを含む場所は移せません/);
    if (name === 'transfer') assert.match(reader.offers({ verify: false }).find(x => x.task === f.child.id).reason, /リンクを含む場所は移せません/);
    fs.unlinkSync(file);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(outside)), record);
});

for (const name of ['transfer', 'integrate', 'history']) test(`${name}: a linked record directory or ancestor still rejects the batch`, t => {
  const f = fixture(t), reader = f[name], real = path.join(f.root, 'real'); fs.mkdirSync(real);
  write(reader.file('P', f.child.id), { project: 'P', task: f.child.id, items: [], generation: 1 });
  const original = reader.dir; fs.renameSync(original, path.join(real, 'records')); fs.symlinkSync(path.join(real, 'records'), original);
  const list = () => name === 'history' ? reader.activeAutos() : reader.pending();
  assert.throws(list, /リンクを含む場所は移せません/);
  if (name === 'transfer') assert.match(reader.offers({ verify: false }).find(x => x.task === f.child.id).reason, /リンクを含む場所は移せません/);
  fs.unlinkSync(original);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(real, alias); reader.dir = path.join(alias, 'records');
  assert.throws(list, /リンクを含む場所は移せません/);
});

test('batch checks each ancestor once instead of walking it for every record', t => {
  const f = fixture(t), n = 20;
  for (let i = 0; i < n; i++) write(f.transfer.file('P', String(i)), { project: 'P', task: String(i) });
  const saved = fs.lstatSync, counts = new Map();
  fs.lstatSync = function(file, ...args) { counts.set(String(file), (counts.get(String(file)) || 0) + 1); return saved.call(this, file, ...args); };
  try { assert.equal(f.transfer.pending().length, n); } finally { fs.lstatSync = saved; }
  assert.equal(counts.get(path.dirname(f.transfer.dir)), 1);
  for (let i = 0; i < n; i++) assert.equal(counts.get(f.transfer.file('P', String(i))), 1);
});

test('leaf and ancestor checks tolerate missing paths and propagate errors other than ENOENT', t => {
  const f = fixture(t), missing = path.join(f.root, 'missing'); noLinks(missing); noLink(missing);
  const saved = fs.lstatSync;
  fs.lstatSync = function(file, ...args) { if (file === missing) throw Object.assign(Error('access denied'), { code: 'EACCES' }); return saved.call(this, file, ...args); };
  try { assert.throws(() => noLinks(missing), /access denied/); assert.throws(() => noLink(missing), /access denied/); }
  finally { fs.lstatSync = saved; }
});

test('maintenance empty running set avoids project IO, active shared bodies still lock', () => {
  let reads = 0; const store = { root: '/ledger', readProject(id) { reads++; return { id, dir: '/ledger/' + id }; } };
  const m = new Maintenance({ store, baseOf: p => p.id === 'other' ? '/other' : '/shared' });
  assert.equal(m.locked('p'), false); assert.equal(reads, 0);
  m.running.set('q', {}); assert.equal(m.locked('p'), true); assert.equal(m.locked('other'), false);
  m.running.clear(); reads = 0; assert.equal(m.locked('p'), false); assert.equal(reads, 0);
});

test('auto timer checks saved active jobs first, preserves scoped/global gates and next tick recovery', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const timer = source.slice(source.indexOf('const autoTimer='), source.indexOf('// Context rotation'));
  let tick, autos = [], reads = 0, applyingReads = 0, busy = false, applying = false, fail = false, calls = [];
  const restartControl = { committed: false }, appShell = { rebuilding: false };
  vm.runInNewContext(timer, { setInterval(fn, ms) { assert.equal(ms, 1500); tick = fn; return { unref() {} }; }, taskHistory: { activeAutos() { if (fail) throw Error('bad directory'); return autos; } }, historyBlockers(p) { reads++; return busy && p === 'p' ? [{}] : []; }, restartControl, appShell, appUpdate: { applying() { applyingReads++; return applying; } }, autoTick(p, t) { calls.push([p, t]); } });
  tick(); assert.equal(reads, 0); assert.equal(applyingReads, 0);
  autos = [{ project: 'p', task: 't' }]; busy = true; tick(); assert.deepEqual(calls, []);
  busy = false; applying = true; tick(); assert.deepEqual(calls, []);
  applying = false; restartControl.committed = true; tick(); assert.deepEqual(calls, []);
  restartControl.committed = false; appShell.rebuilding = true; tick(); assert.deepEqual(calls, []); appShell.rebuilding = false;
  applying = false; tick(); assert.deepEqual(calls, [['p', 't']]);
  fail = true; tick(); fail = false; tick(); assert.deepEqual(calls, [['p', 't'], ['p', 't']]);
  autos = [{ project: 'p', task: 't' }, { project: 'q', task: 'other' }]; busy = true; tick(); assert.deepEqual(calls.at(-1), ['q', 'other']);
});

function get(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, res => { const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject);
  });
}
test('static HTTP revalidation, encoding negotiation, concurrent cache, updates and errors', async t => {
  const f = fixture(t), file = path.join(f.root, 'asset.js'), text = '/* asset */\n' + 'const value=1;\n'.repeat(200);
  write(file, text); const assets = new StaticFiles();
  const fallback = (res, code, body) => { res.writeHead(code, { 'Cache-Control': 'no-store' }); res.end(body); };
  const server = http.createServer((req, res) => assets.send(req, res, req.url === '/missing' ? file + '.missing' : file, 'text/javascript', fallback));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r))); const port = server.address().port;
  const plain = await get(port, '/asset'); assert.equal(plain.body.toString(), text); assert.equal(plain.headers['cache-control'], 'no-store');
  assert.equal(plain.headers['x-content-type-options'], 'nosniff'); assert.equal(plain.headers.vary, 'Accept-Encoding'); assert.match(plain.headers.etag, /^W\//);
  for (const tag of [plain.headers.etag, plain.headers.etag.replace('W/', ''), '"other", ' + plain.headers.etag, '*']) {
    const same = await get(port, '/asset', { 'If-None-Match': tag, 'Accept-Encoding': 'gzip' }); assert.equal(same.status, 304); assert.equal(same.body.length, 0); assert.equal(same.headers['content-encoding'], undefined);
  }
  const compressed = await Promise.all(Array.from({ length: 4 }, () => get(port, '/asset', { 'Accept-Encoding': 'gzip' })));
  for (const gz of compressed) { assert.equal(gz.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(gz.body), plain.body); assert.equal(gz.headers.etag, plain.headers.etag); assert.ok(gz.body.length < plain.body.length); }
  assert.equal(assets.cache.size, 1);
  for (const encoding of ['br', 'gzip;q=0', 'gzip;q=0, *;q=1', '*;q=0', 'gzip;q=garbage']) assert.equal((await get(port, '/asset', { 'Accept-Encoding': encoding })).headers['content-encoding'], undefined);
  for (const encoding of ['GZIP', 'br, gzip;q=0.5', '*;q=1']) assert.equal((await get(port, '/asset', { 'Accept-Encoding': encoding })).headers['content-encoding'], 'gzip');
  write(file, text.replace(/value=1/g, 'value=2')); const when = new Date(Date.now() + 2000); fs.utimesSync(file, when, when);
  const updated = await get(port, '/asset', { 'If-None-Match': plain.headers.etag, 'Accept-Encoding': 'gzip' }); assert.equal(updated.status, 200); assert.notEqual(updated.headers.etag, plain.headers.etag); assert.equal(gunzipSync(updated.body).toString(), text.replace(/value=1/g, 'value=2'));
  const grown = text + '// grew'; write(file, grown); fs.utimesSync(file, when, when);
  const resized = await get(port, '/asset', { 'Accept-Encoding': 'gzip' }); assert.notEqual(resized.headers.etag, updated.headers.etag); assert.equal(gunzipSync(resized.body).toString(), grown);
  write(file, 'small'); assert.equal((await get(port, '/asset', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined);
  const absent = await get(port, '/missing'); assert.equal(absent.status, 404); assert.equal(absent.headers['cache-control'], 'no-store');
});

test('encoded state keeps no-store and exact JSON while identity and gzip share a validator', async t => {
  const body = JSON.stringify({ projects: Array.from({ length: 100 }, (_, i) => ({ id: i, steps: ['todo'] })) });
  const server = http.createServer((req, res) => sendEncoded(req, res, body, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: '"state"' }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r))); const port = server.address().port;
  const plain = await get(port, '/'), gz = await get(port, '/', { 'Accept-Encoding': 'gzip' });
  assert.equal(plain.body.toString(), body); assert.deepEqual(gunzipSync(gz.body), plain.body); assert.equal(gz.headers['cache-control'], 'no-store'); assert.equal(gz.headers.vary, 'Accept-Encoding'); assert.equal(gz.headers.etag, plain.headers.etag);
});

test('real server keeps locale/API no-store, serves extension/steps gzip, static gzip/304 and state gzip/304', async t => {
  const f = fixture(t), { spawn } = require('node:child_process');
  write(path.join(f.root, 'Product/P/PROJECT.md'), '---\nname: P\nstatus: 進行中\n---\n');
  write(path.join(f.root, 'Product/P/.ai/tasks/t.md'), '---\nid: t\ntitle: Fixture\nstate: 実行中\n---\n## 手順\n' + '- [ ] 合成の手順です。\n'.repeat(200));
  fs.mkdirSync(path.join(f.root, '_hub'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(f.root, '_hub/roles.yaml'));
  const env = { ...process.env, HOME: f.root, HUB_ROOT: f.root, HUB_AI_HOME: f.root, HUB_TRASH: path.join(f.root, 'trash'), HUB_DRY_RUN: '1', HUB_AUTO_TRANSLATE: '0', HUB_PORT: '0', HUB_LANG: 'ja' };
  const child = spawn(process.execPath, ['-e', 'const {server}=require(process.argv[1]);server.listen(0,"127.0.0.1",()=>process.send(server.address().port));', path.join(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  t.after(() => new Promise(r => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill(); }));
  const port = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('server start timeout: ' + output)), 10000); child.once('message', x => { clearTimeout(timeout); resolve(x); }); child.once('exit', code => { clearTimeout(timeout); reject(Error('server exited ' + code + ': ' + output)); }); });
  const request = (route, headers = {}) => get(port, route, { Host: '127.0.0.1:0', ...headers });
  const js = await request('/app.js', { 'Accept-Encoding': 'gzip' }); assert.equal(js.status, 200); assert.equal(js.headers['content-encoding'], 'gzip'); assert.equal(js.headers['cache-control'], 'no-store'); assert.deepEqual(gunzipSync(js.body), fs.readFileSync(path.join(__dirname, '../public/app.js')));
  const same = await request('/app.js', { 'If-None-Match': js.headers.etag }); assert.equal(same.status, 304); assert.equal(same.body.length, 0);
  const extensions = require('../lib/extensions').loadExtensions({ hub: path.join(__dirname, '..') });
  for (const [route, type, source] of [['/extensions-ui.js', 'text/javascript', extensions.uiSource()], ['/extensions-ui.css', 'text/css', extensions.uiSource('style')]]) {
    for (const encoding of ['identity', 'gzip', 'gzip;q=0']) {
      const asset = await request(route, { 'Accept-Encoding': encoding, 'If-None-Match': '*' });
      assert.equal(asset.status, 200); assert.match(asset.headers['content-type'], new RegExp('^' + type));
      assert.equal(asset.headers['cache-control'], 'no-store'); assert.equal(asset.headers['x-content-type-options'], 'nosniff');
      assert.equal(asset.headers.vary, 'Accept-Encoding'); assert.equal(asset.headers.etag, undefined);
      assert.equal(Number(asset.headers['content-length']), asset.body.length);
      if (encoding === 'gzip') {
        assert.equal(asset.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(asset.body).toString(), source);
        assert.ok(asset.body.length < Buffer.byteLength(source));
      } else {
        assert.equal(asset.headers['content-encoding'], undefined); assert.equal(asset.body.toString(), source);
      }
    }
  }
  const locale = await request('/locale-config.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': '*' }); assert.equal(locale.status, 200); assert.equal(locale.headers['cache-control'], 'no-store'); assert.equal(locale.headers.etag, undefined);
  const ping = await request('/api/ping', { 'Accept-Encoding': 'gzip' }); assert.equal(ping.headers['cache-control'], 'no-store');
  const steps = await request('/api/task/steps?project=P&task=t', { 'Accept-Encoding': 'gzip' });
  assert.equal(steps.status, 200); assert.equal(steps.headers['content-encoding'], 'gzip'); assert.equal(steps.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(gunzipSync(steps.body)).steps.length, 200);
  await request('/api/state'); await new Promise(r => setTimeout(r, 100));
  const plain = await request('/api/state'), gz = await request('/api/state', { 'Accept-Encoding': 'gzip' });
  assert.equal(plain.status, 200); assert.equal(gz.status, 200); assert.deepEqual(gunzipSync(gz.body), plain.body); assert.equal(gz.headers['cache-control'], 'no-store'); assert.equal(gz.headers.etag, plain.headers.etag);
  const unchanged = await request('/api/state', { 'If-None-Match': gz.headers.etag, 'Accept-Encoding': 'gzip' }); assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0); assert.equal(unchanged.headers['cache-control'], 'no-store');
  assert.equal((await request('/missing.js')).status, 404); assert.equal((await request('/%2e%2e/server.js')).status, 404);
});
