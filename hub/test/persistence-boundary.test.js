'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { create } = require('../lib/platform/persistence');
const native = require('../lib/platform');
const scope = { project: 'fixture', task: 'task' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
// Replace only the explicit durability boundary of these local module instances.
// Node's fs and the running Hub are never patched. Tests use real temp files.
function modules(persistence, overrides = {}) {
  const cache = new Map(), names = new Set(['stop-control', 'cli-spool', 'safe-file',
    'integration-writes', 'integration-abandon-recovery', 'ideas']);
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const file = require.resolve('../lib/' + name), original = createRequire(file), module = { exports: {} };
    cache.set(name, module);
    function localRequire(id) {
      if (id === './platform') return { ...native, persistence };
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith('./') && names.has(id.slice(2))) return load(id.slice(2));
      return original(id);
    }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: localRequire, __filename: file, __dirname: path.dirname(file), process, Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval, structuredClone }, { filename: file });
    return module.exports;
  }
  return load;
}
for (const osName of ['darwin', 'linux']) test(osName + ': same handles, order and error propagation', () => {
  const calls = [], io = { openSync: (...a) => { calls.push(['open', ...a]); return 17; },
    fsyncSync: fd => calls.push(['sync', fd]), closeSync: fd => calls.push(['close', fd]) };
  const p = create(osName, io);
  assert.equal(p.withDirectorySync('/parent', () => { calls.push(['unlink']); return 'result'; }), 'result');
  assert.deepEqual(calls, [['open', '/parent', 'r'], ['sync', 17], ['unlink'], ['sync', 17], ['close', 17]]);
  for (const failAt of [1, 2]) {
    let count = 0, mutated = false, closed = false;
    const error = Error('flush ' + failAt);
    const failing = { ...io, fsyncSync() { if (++count === failAt) throw error; }, closeSync() { closed = true; } };
    assert.throws(() => p.withDirectorySync('/parent', () => { mutated = true; }, failing), e => e === error);
    assert.equal(mutated, failAt === 2); assert.equal(closed, true);
  }
  let closed = false;
  assert.throws(() => p.withDirectorySync('/parent', () => { throw Error('unlink failed'); },
    { ...io, closeSync() { closed = true; } }), /unlink failed/);
  assert.equal(closed, true);
});
test('unimplemented Windows durability rejects all methods before I/O or mutation', () => {
  let calls = 0; const p = create('win32', { openSync() { calls++; } });
  for (const method of [() => p.syncDirectory('dir'), () => p.syncFile('file'),
    () => p.withDirectorySync('dir', () => calls++)]) assert.throws(method, e => e.code === 'persistence_unsupported');
  assert.equal(calls, 0);
});
test('ordinary file and parent flush close handles and propagate the original I/O failure', () => {
  for (const kind of ['syncFile', 'syncDirectory']) {
    let closed = false; const error = Object.assign(Error('flush failed'), { code: 'EIO' });
    const p = create('darwin', { openSync: () => 7, fsyncSync: () => { throw error; }, closeSync: () => { closed = true; } });
    assert.throws(() => p[kind]('existing'), e => e === error); assert.equal(closed, true);
  }
});
test('failed stop publication keeps starts/resume closed through cold restart; explicit healthy resume is required', t => {
  const dir = fixture(t); let broken = false;
  const p = { ...native.persistence, syncDirectory(d) { if (broken) throw Error('namespace flush failed'); native.persistence.syncDirectory(d); } };
  const load = modules(p), { StopControl } = load('stop-control');
  const c = new StopControl({ dir }), old = c.ticket(scope); broken = true;
  assert.equal(c.pause(), false); assert.equal(c.view().persistence, 'unconfirmed');
  assert.throws(() => c.resume(), e => e.code === 'ai-paused');
  const cold = new StopControl({ dir }); assert.equal(cold.view().persistence, 'unconfirmed');
  assert.throws(() => cold.assert(scope), e => e.code === 'ai-paused');
  broken = false;
  const recovered = new StopControl({ dir }); assert.equal(recovered.view().all, true);
  recovered.resume(); assert.equal(recovered.view().persistence, 'saved');
  assert.throws(() => recovered.assert(scope, old), e => e.code === 'ai-paused');
  assert.doesNotThrow(() => recovered.assert(scope, recovered.ticket(scope)));
});
test('spool request failure never launches a supervisor; failed finish remains quarantined after module reload', t => {
  const root = fixture(t); let broken = false, spawns = 0;
  const p = { ...native.persistence, syncDirectory(d) { if (broken) throw Error('namespace flush failed'); native.persistence.syncDirectory(d); } };
  const load = modules(p, { 'node:child_process': { spawn() { spawns++; throw Error('unexpected spawn'); } },
    './owned-processes': { assertLaunchOwnership() {} } });
  const spool = load('cli-spool'); broken = true;
  assert.throws(() => spool.start(root, 'fixture', { dir: root }, { command: 'never', args: [] }, {}, [], {}), /namespace flush failed/);
  assert.equal(spawns, 0); broken = false;
  const dir = path.join(root, 'finished-fixture'); fs.mkdirSync(dir);
  const owner = spool.claim(dir, 'fixture'), child = new spool.SpoolChild(dir, owner);
  child.phase('finished'); broken = true;
  assert.throws(() => child.finish(), /namespace flush failed/);
  assert.equal(fs.existsSync(path.join(dir, 'finished.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'finished-confirmed.json')), false);
  const cold = modules(p)('cli-spool'); assert.ok(cold.failure(dir));
  assert.throws(() => cold.adopt(dir, 'new-owner'), /自動では再処理しません/);
});
test('safe-file recovery cannot acknowledge rename bytes until the parent flush succeeds', t => {
  const dir = fixture(t), file = path.join(dir, 'record.json'); let broken = true;
  const p = { ...native.persistence, syncDirectory(d) { if (broken) throw Error('namespace flush failed'); native.persistence.syncDirectory(d); } };
  const safe = modules(p)('safe-file');
  assert.throws(() => safe.atomic(file, 'new bytes'), /namespace flush failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new bytes');
  const cold = modules(p)('safe-file'); assert.throws(() => cold.recoverAtomic(file, 'new bytes'), /namespace flush failed/);
  broken = false; cold.recoverAtomic(file, 'new bytes');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new bytes'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('provenance retains unfinished intent after file flush failure, including a cold writer', t => {
  const root = fixture(t), dir = path.join(root, 'Product', 'P'), file = path.join(dir, 'PROJECT.md');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  fs.writeFileSync(file, 'old'); git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  let broken = true;
  const p = { ...native.persistence, syncFile(f) { if (broken) throw Error('file flush failed'); native.persistence.syncFile(f); } };
  const writes = modules(p)('integration-writes'); writes.register(root);
  assert.throws(() => writes.write(file, () => fs.writeFileSync(file, 'new')), /file flush failed/);
  assert.equal(writes.pending(file), true); assert.equal(writes.ignored(dir).length, 0);
  broken = false; const cold = modules(p)('integration-writes'); cold.register(root);
  assert.equal(cold.pending(file), true); cold.write(file, () => fs.writeFileSync(file, 'new'));
  assert.equal(cold.pending(file), true); assert.equal(cold.ignored(dir).length, 0);
});
test('torn-history recovery preserves both names if its first namespace flush fails', t => {
  const dir = fixture(t), file = path.join(dir, 'history.json'), bytes = '{torn'; fs.writeFileSync(file, bytes);
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const p = { ...native.persistence, withDirectorySync() { throw Error('namespace flush failed'); } };
  const h = {dir, file:()=>path.join(dir,'current.json')};
  const R = modules(p)('integration-abandon-recovery'), x = { file, sha256, action: 'quarantine' };
  assert.throws(() => R.commit(h, x, {}), /namespace flush failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fs.readFileSync(file + '.torn-' + sha256, 'utf8'), bytes);
  const healthy = modules(native.persistence)('integration-abandon-recovery'); healthy.commit(h, x, {});
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(file + '.torn-' + sha256, 'utf8'), bytes);
});
test('idea recovery retains intent and candidate until both file and namespace durability are confirmed', t => {
  const root = fixture(t), file = path.join(root, 'ideas.json'); let broken = true;
  const p = { ...native.persistence, syncFile(f, io) { if (broken && f === file) throw Error('file flush failed'); native.persistence.syncFile(f, io); } };
  const load = modules(p), { Ideas } = load('ideas');
  function writer() { const x = Object.create(Ideas.prototype); Object.assign(x, {
    control: path.join(root, 'control'), io: fs, atomic: load('safe-file'), outside() {}, fault() {}
  }); return x; }
  const ideas = writer();
  assert.throws(() => ideas.writeFile(file, { rev: 1, fixture: true }, 'fixture-operation'), /保存結果を確認してください/);
  assert.equal(fs.existsSync(ideas.pending(file)), true);
  const cold = writer(); assert.throws(() => cold.recoverFile(file), /file flush failed/);
  const pending = JSON.parse(fs.readFileSync(cold.pending(file)));
  assert.equal(fs.existsSync(pending.candidate), true);
  broken = false; cold.recoverFile(file);
  assert.equal(JSON.parse(fs.readFileSync(file)).rev, 1);
  assert.equal(fs.existsSync(cold.pending(file)), true); // Recovery itself never discards the evidence.
});
