'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { externalBusy } = require('../lib/account-processes');
const { Accounts } = require('../lib/accounts');
const { createDarwin } = require('../lib/platform');
const { pickAi } = require('../lib/procwatch');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-home-proof-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const homes = ['default', 'spare'].map(id => ({ id, dir: path.join(base, id) }));
  for (const h of homes) { fs.mkdirSync(h.dir); fs.writeFileSync(path.join(h.dir, 'state_5.sqlite'), 'not-read'); }
  const p = { pid: 200, ppid: 1, pgid: 200, uid: 501, since: '2026-11-06T00:00:00Z', command: '/app/codex' };
  const f = { p, rows: [p], roots: [], homes, paths: [path.join(homes[0].dir, 'state_5.sqlite')], calls: 0 };
  f.platform = { name: 'darwin', processOwner: p => p?.uid, currentProcessOwner: () => 501,
    processOpenFiles: ids => { f.calls++; assert.deepEqual(ids, [200]); return new Map([[200, { uid: 501, paths: f.paths }]]); }, processSnapshot: () => f.rows };
  f.check = (id = 'spare', ai = 'codex') => externalBusy(ai, id, [{ pid: p.pid, since: p.since }], f.roots, [p], f.platform, () => f.homes);
  return f;
}
test('desktop default home protects default and releases spare; no auth file content read', t => {
  const f = fixture(t); assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check(), false);
  const a = new Accounts({ file: path.join(f.homes[0].dir, 'unused'), dry: true, busy: (_ai, id) => f.check(id) });
  a.get = (ai, id = 'default') => ({ ai, id, name: id }); a.read = () => [{ ai: 'codex', id: 'spare' }]; a.terminalBusy = () => false;
  assert.doesNotThrow(() => a.assertIdle('codex', 'spare'));
  assert.throws(() => a.assertIdle('codex', 'default'), /Hub外のCodex/);
  assert.equal(a.list().find(r => r.ai === 'codex' && r.id === 'default').busyReason, 'external-codex');
});
test('spare home protects only spare', t => { const f = fixture(t); f.paths = [path.join(f.homes[1].dir, 'state_5.sqlite')]; assert.equal(f.check(), 'external-codex'); assert.equal(f.check('default'), false); });
for (const fault of ['both-homes', 'no-home', 'lsof-failure', 'lsof-owner', 'foreign-owner', 'reused-pid', 'exited', 'wrong-command', 'wrong-group', 'missing-path', 'bad-home', 'duplicate-home', 'prefix-sibling', 'ambiguous-newline']) {
  test('uncertain paths/identity stay protected: ' + fault, t => {
    const f = fixture(t);
    if (fault === 'both-homes') f.paths.push(path.join(f.homes[1].dir, 'state_5.sqlite'));
    if (fault === 'no-home') f.paths = [];
    if (fault === 'lsof-failure') f.platform.processOpenFiles = () => { throw Error('denied'); };
    if (fault === 'lsof-owner') f.platform.processOpenFiles = () => new Map([[200, { uid: 502, paths: f.paths }]]);
    if (fault === 'foreign-owner') f.p.uid = 502;
    if (fault === 'reused-pid') f.rows = [{ ...f.p, since: '2026-11-06T01:00:00Z' }];
    if (fault === 'exited') f.rows = [];
    if (fault === 'wrong-command') f.rows = [{ ...f.p, command: '/other/codex' }];
    if (fault === 'wrong-group') f.rows = [{ ...f.p, pgid: 201 }];
    if (fault === 'missing-path') f.paths.push(path.join(f.homes[1].dir, 'missing'));
    if (fault === 'ambiguous-newline') f.paths.push(f.homes[1].dir + '/other\nfile');
    if (fault === 'bad-home') f.homes[1].dir = null;
    if (fault === 'duplicate-home') f.homes[1].dir = f.homes[0].dir;
    if (fault === 'prefix-sibling') { const sibling = f.homes[0].dir + '-other'; fs.mkdirSync(sibling); f.paths = [sibling]; }
    assert.equal(f.check(), 'unknown-process');
    if (fault === 'foreign-owner') assert.equal(f.calls, 0);
  });
}
test('realpath aliases match while overlapping homes stay ambiguous', t => {
  const f = fixture(t), alias = path.join(path.dirname(f.homes[0].dir), 'alias'); fs.symlinkSync(f.homes[0].dir, alias);
  f.paths = [path.join(alias, 'state_5.sqlite')]; assert.equal(f.check(), false);
  f.homes[1].dir = path.dirname(f.homes[0].dir); assert.equal(f.check(), 'unknown-process');
});
test('valid different start time excludes the old procwatch identity without file inspection', t => {
  const f = fixture(t);
  assert.equal(externalBusy('codex', 'spare', [{ pid: 200, since: '2026-11-06T01:00:00Z' }], [], f.rows, f.platform, () => f.homes), false); assert.equal(f.calls, 0);
});
test('managed proof wins; corrupt/conflicting proof is never replaced by file paths', t => {
  const f = fixture(t); f.roots = [{ ai: 'codex', account: 'default', identity: { ...f.p } }];
  assert.equal(f.check(), false); assert.equal(f.check('default'), true); assert.equal(f.calls, 0);
  f.roots[0].identity.since = 'bad'; assert.equal(f.check(), 'unknown-process'); assert.equal(f.calls, 0);
});
test('Windows/Linux and other AIs never inspect open files', t => {
  const f = fixture(t); for (const name of ['win32', 'linux']) { f.platform.name = name; assert.equal(f.check(), 'unknown-process'); }
  f.platform.name = 'darwin'; assert.equal(f.check('spare', 'claude'), 'unknown-process'); assert.equal(f.calls, 0);
});
test('another unknown process protects even beside a positively attributed target', t => {
  const f = fixture(t); assert.equal(externalBusy('codex', 'default', [{ pid: 200, since: f.p.since }, { pid: 201, since: f.p.since }], [], f.rows, f.platform, () => f.homes, () => true), 'unknown-process');
});
test('native lsof is NUL-framed, bounded, strict on status/stderr/uid/pid and path-only', () => {
  let result = { status: 0, stderr: '', stdout: 'p200\0u501\0\nfcwd\0n/a b\0\nf3\0n/c\0\n' }, invocation;
  const p = createDarwin({ spawnSync: (...args) => { invocation = args; return result; } });
  assert.deepEqual(p.processOpenFiles([200]), new Map([[200, { uid: 501, paths: ['/a b', '/c'], mapped: [] }]]));
  assert.equal(invocation[0], '/usr/sbin/lsof'); assert.deepEqual(invocation[1], ['-nP', '-a', '-p', '200', '-F0pun']); assert.equal(invocation[2].timeout, 1000); assert.equal(invocation[2].maxBuffer, 4 * 1024 * 1024);
  for (const r of [{ ...result, status: 1 }, { ...result, stderr: 'permission denied' }, { ...result, error: Error('timeout') }, { ...result, signal: 'SIGTERM' }, { ...result, stdout: 'p201\0u501\0' }, { ...result, stdout: 'p200\0n/a\0' }, { ...result, stdout: 'p200\0u501\0p200\0' }, { ...result, stdout: 'p200\0u501\0garbage\0' }]) { result = r; assert.throws(() => p.processOpenFiles([200]), /process_files_unavailable/); }
  assert.throws(() => p.processOpenFiles([0]), /process_files_unavailable/);
});
test('UI distinguishes desktop usage and keeps spare login enabled', () => {
  const { app } = require('./fixtures/app-ui-harness.cjs'), f = app();
  vm.runInContext(`state.accounts = [{ai:'codex',id:'default',busy:true,busyReason:'external-codex',status:'logged-in'}, {ai:'codex',id:'spare',name:'予備用',busy:false,status:'logged-out'}]`, f.context);
  const html = vm.runInContext('accountSettingsHtml()', f.context), spare = html.slice(html.indexOf('data-id="spare"'), html.indexOf('<b>Jev'));
  assert.match(html, /Hub外のCodex（デスクトップアプリ等）が使用中/); assert.match(spare, /data-account-action="login"\s*>/); assert.doesNotMatch(spare, /保留中/);
});

test('actual login route opens only isolated spare terminal; desktop default logout stays blocked', async t => {
  const f = fixture(t), a = new Accounts({ file: path.join(f.homes[0].dir, 'unused'), dry: true, busy: (_ai, id) => f.check(id) });
  a.get = (ai, id = 'default') => ({ ai, id, dir: f.homes.find(h => h.id === id).dir }); a.terminalBusy = () => false;
  let opened = 0;
  const route = require('../lib/routes/accounts')({ accounts: a, launch: { accountShell: () => 'env CODEX_HOME=/isolated/spare ', sq: JSON.stringify, openTerminal: async () => { opened++; return {}; } }, usage: { invalidate() {} }, aiTools: { isOperating: () => false }, DRY: true, lt: s => s, record() {}, send: (_r, status, body) => ({ status, body }) }).write;
  const submit = (action, id) => route.handle({}, {}, new URL('http://fixture/api/accounts/' + action), { ai: 'codex', id, confirm: true, confirmDefault: true });
  const accepted = await submit('login', 'spare'); assert.equal(accepted.status, 200); assert.match(accepted.body.command, /CODEX_HOME=\/isolated\/spare/); assert.equal(opened, 1);
  const blocked = await submit('logout', 'default'); assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Hub外のCodex/); assert.equal(opened, 1);
});

test('unavailable system executable images do not hide home files; home images remain protected', t => {
  const f = fixture(t), systemImage = path.join(path.dirname(f.homes[0].dir), 'unavailable-system-image');
  let image = systemImage;
  f.platform.processOpenFiles = () => new Map([[200, { uid: 501, paths: [...f.paths, image], mapped: [image] }]]);
  assert.equal(f.check(), false);
  image = path.join(f.homes[1].dir, 'unavailable-image'); assert.equal(f.check(), 'unknown-process');
  image = path.join(f.homes[1].dir, 'state_5.sqlite'); assert.equal(f.check(), 'unknown-process');
});

function foreignFile(f, relative = 'logs_2.sqlite', name = 'openclaw') {
  const full = path.join(path.dirname(f.homes[0].dir), name, 'agent', 'codex-home', relative);
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'not-read'); return full;
}
for (const signature of ['logs_2.sqlite', 'queue_1.sqlite', 'state_5.sqlite', '.sqlite-maintenance.lock', 'sessions/2026/11/record.jsonl']) {
  test('independent Codex home is unrelated for either account: ' + signature, t => {
    const f = fixture(t); f.paths = [foreignFile(f, signature)];
    assert.equal(f.check('default'), false); assert.equal(f.check('spare'), false);
  });
}
test('multiple unrelated homes stay unrelated but a mixed known home stays unknown', t => {
  const f = fixture(t); f.paths = [foreignFile(f), foreignFile(f, 'queue_1.sqlite', 'second-tool')];
  assert.equal(f.check(), false);
  f.paths.push(path.join(f.homes[0].dir, 'state_5.sqlite')); assert.equal(f.check(), 'unknown-process'); assert.equal(f.check('default'), 'unknown-process');
});
test('a known-home ordinary file plus a foreign signature cannot release any account', t => {
  const f = fixture(t), other = path.join(f.homes[1].dir, 'config.toml'); fs.writeFileSync(other, 'not-read');
  f.paths = [foreignFile(f), other]; assert.equal(f.check(), 'unknown-process');
});
test('exec-server tmp lock without a signature attributes only its known home', t => {
  const f = fixture(t), file = path.join(f.homes[0].dir, 'tmp', 'arg0-macos', 'codex-1', '.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'not-read');
  f.paths = [file]; assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check(), false);
});
test('no signature and no known home stays unknown', t => {
  const f = fixture(t); f.paths = [foreignFile(f, 'state_5.sqlite-wal')]; assert.equal(f.check(), 'unknown-process');
});
test('no signature with two known homes stays unknown', t => {
  const f = fixture(t); f.paths = f.homes.map(h => {
    const file = path.join(h.dir, '.lock'); fs.writeFileSync(file, 'not-read'); return file;
  });
  assert.equal(f.check('default'), 'unknown-process'); assert.equal(f.check(), 'unknown-process');
});
test('uncreated additional home does not prevent known or unrelated attribution', t => {
  const f = fixture(t); f.homes.push({ id: 'uncreated', dir: path.join(path.dirname(f.homes[0].dir), 'not-created') });
  assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check(), false);
  const lock = path.join(f.homes[0].dir, '.lock'); fs.writeFileSync(lock, 'not-read'); f.paths = [lock];
  assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check(), false);
  f.paths = [foreignFile(f)]; assert.equal(f.check('default'), false); assert.equal(f.check(), false);
});
test('home realpath failures other than ENOENT and no remaining homes stay unknown', t => {
  const f = fixture(t); f.homes.push({ id: 'not-directory', dir: path.join(f.homes[0].dir, 'state_5.sqlite', 'child') });
  assert.equal(f.check(), 'unknown-process'); assert.equal(f.calls, 0);
  f.homes = [{ id: 'uncreated', dir: path.join(path.dirname(f.homes[0].dir), 'not-created') }];
  assert.equal(f.check(), 'unknown-process'); assert.equal(f.calls, 0);
});
test('foreign home cannot be an ancestor or descendant of any known home', t => {
  const f = fixture(t), nested = path.join(f.homes[0].dir, 'nested', 'state_5.sqlite');
  fs.mkdirSync(path.dirname(nested)); fs.writeFileSync(nested, 'not-read'); f.paths = [nested]; assert.equal(f.check(), 'unknown-process');
  const parent = path.join(path.dirname(f.homes[0].dir), 'logs_2.sqlite'); fs.writeFileSync(parent, 'not-read'); f.paths = [parent]; assert.equal(f.check(), 'unknown-process');
});
test('signature aliases use canonical homes and unavailable independent files remain unknown', t => {
  const f = fixture(t), foreign = foreignFile(f), alias = path.join(path.dirname(f.homes[0].dir), 'foreign-alias');
  fs.symlinkSync(path.dirname(foreign), alias); f.paths = [path.join(alias, 'logs_2.sqlite')]; assert.equal(f.check(), false);
  f.paths.push(path.join(path.dirname(foreign), 'missing')); assert.equal(f.check(), 'unknown-process');
});
test('batch desktop and independent processes once, with fresh identities and no stale cache', t => {
  const f = fixture(t), second = { ...f.p, pid: 201, pgid: 201 }, foreign = foreignFile(f);
  const external = [f.p, second].map(p => ({ pid: p.pid, since: p.since })); f.rows.push(second);
  let scans = 0, snapshots = 0;
  f.platform.processOpenFiles = ids => { scans++; assert.deepEqual(ids, [200, 201]); return new Map([[200, { uid: 501, paths: f.paths }], [201, { uid: 501, paths: [foreign] }]]); };
  f.platform.processSnapshot = () => { snapshots++; return f.rows; };
  const check = account => externalBusy('codex', account, external, [], f.rows, f.platform, () => f.homes);
  assert.equal(check('default'), 'external-codex'); assert.equal(scans, 1); assert.equal(snapshots, 1);
  assert.equal(check('spare'), false); assert.equal(scans, 2); assert.equal(snapshots, 2);
  f.rows[1] = { ...second, since: '2026-11-06T01:00:00Z' };
  // The pre-inspection snapshot is kept separately to model PID reuse mid-call.
  assert.equal(externalBusy('codex', 'spare', external, [], [f.p, second], f.platform, () => f.homes), 'unknown-process');
  f.platform.processOpenFiles = () => { throw Error('failed batch'); }; assert.equal(check('spare'), 'unknown-process');
});
test('batch failure or omitted UID/PID cannot release independent processes', t => {
  const f = fixture(t); f.paths = [foreignFile(f)];
  for (const files of [new Map(), new Map([[200, { uid: 502, paths: f.paths }]])]) {
    f.platform.processOpenFiles = () => files; assert.equal(f.check(), 'unknown-process');
  }
  f.p.uid = 502; f.calls = 0; assert.equal(f.check(), 'unknown-process'); assert.equal(f.calls, 0);
});
test('known default location includes .codex when CODEX_HOME is unset', t => {
  const f = fixture(t), previous = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const home = path.dirname(f.homes[0].dir), a = new Accounts({ file: path.join(home, 'unused.json'), home, dry: true });
  const dir = a.location('codex', 'default'); assert.equal(dir, path.join(home, '.codex'));
  fs.mkdirSync(dir); const file = path.join(dir, 'logs_2.sqlite'); fs.writeFileSync(file, 'not-read');
  f.homes[0].dir = dir; f.paths = [file]; assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check('spare'), false);
});
test('known sessions signature attributes the default and nested signatures stay uncertain', t => {
  const f = fixture(t), record = path.join(f.homes[0].dir, 'sessions', '2026', 'record.jsonl');
  fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, 'not-read'); f.paths = [record];
  assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check('spare'), false);
  const nested = path.join(f.homes[0].dir, 'sessions', 'nested', 'sessions', 'record.jsonl');
  fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.writeFileSync(nested, 'not-read'); f.paths = [nested]; assert.equal(f.check(), 'unknown-process');
});
test('one native lsof invocation reads multiple PID records within the same limits', () => {
  let calls = 0;
  const p = createDarwin({ spawnSync: (file, args, options) => {
    calls++; assert.equal(args[3], '200,201'); assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    return { status: 0, stderr: '', stdout: 'p200\0u501\0\nf3\0n/a/state_5.sqlite\0\np201\0u501\0\nf4\0n/b/logs_2.sqlite\0\n' };
  } });
  const files = p.processOpenFiles([200, 201]); assert.equal(calls, 1); assert.deepEqual(files.get(201).paths, ['/b/logs_2.sqlite']);
});

function wrapperFixture(t) {
  const f = fixture(t);
  f.p.command = '/usr/bin/node';
  f.child = { ...f.p, pid: 201, ppid: 200, command: '/pkg/vendor/bin/codex' };
  f.rows.push(f.child);
  f.before = f.rows.map(p => ({ ...p }));
  f.files = new Map([[200, { uid: 501, paths: [] }], [201, { uid: 501, paths: [foreignFile(f)] }]]);
  f.platform.processOpenFiles = ids => { f.calls++; f.ids = ids; return f.files; };
  f.check = (id = 'spare', external = [{ pid: 200, since: f.p.since }]) => externalBusy('codex', id, external, f.roots, f.before, f.platform, () => f.homes);
  return f;
}
test('wrapper with no home uses native child foreign home and one batch per call', t => {
  const f = wrapperFixture(t);
  assert.equal(f.check('default'), false); assert.equal(f.calls, 1); assert.deepEqual(f.ids, [200, 201]);
  assert.equal(f.check('spare'), false); assert.equal(f.calls, 2);
});
test('wrapper native child known home protects default and releases spare', t => {
  const f = wrapperFixture(t); f.files.get(201).paths = f.paths;
  assert.equal(f.check('default'), 'external-codex'); assert.equal(f.check('spare'), false);
});
for (const fault of ['identity', 'uid', 'lsof-missing', 'lsof-uid', 'exited', 'command', 'pgid']) {
  test('wrapper child uncertainty protects both accounts: ' + fault, t => {
    const f = wrapperFixture(t);
    if (fault === 'identity') f.rows[1] = { ...f.child, since: '2026-11-06T01:00:00Z' };
    if (fault === 'uid') f.before[1].uid = f.rows[1].uid = 502;
    if (fault === 'lsof-missing') f.files.delete(201);
    if (fault === 'lsof-uid') f.files.get(201).uid = 502;
    if (fault === 'exited') f.rows = [f.p];
    if (fault === 'command') f.rows[1] = { ...f.child, command: '/other/codex' };
    if (fault === 'pgid') f.rows[1] = { ...f.child, pgid: 999 };
    assert.equal(f.check('default'), 'unknown-process'); assert.equal(f.check('spare'), 'unknown-process');
    if (fault === 'uid') assert.equal(f.calls, 0);
  });
}
test('known and unrelated child paths are combined before attribution', t => {
  const f = wrapperFixture(t); f.files.get(201).paths.push(...f.paths);
  assert.equal(f.check('default'), 'unknown-process'); assert.equal(f.check('spare'), 'unknown-process');
});
test('wrapper and separate children cannot hide mixed home evidence', t => {
  const f = wrapperFixture(t), second = { ...f.child, pid: 202 };
  f.rows.push(second); f.before.push({ ...second }); f.files.set(202, { uid: 501, paths: f.paths });
  assert.equal(f.check(), 'unknown-process'); assert.deepEqual(f.ids, [200, 201, 202]); assert.equal(f.calls, 1);
});
test('production argument-bearing pickAi folds native child before strong snapshot attribution', t => {
  const f = wrapperFixture(t);
  const argumentsRows = f.before.map(p => ({ ...p, command: p.pid === 200 ? '/usr/bin/node /pkg/@openai/codex/bin/codex.js app-server' : p.command + ' app-server' }));
  const external = pickAi(argumentsRows, 999);
  assert.deepEqual(external.map(p => p.pid), [200]);
  assert.equal(f.check('default', external), false); assert.equal(f.check('spare', external), false);
  f.files.get(201).paths = f.paths;
  assert.equal(f.check('default', external), 'external-codex'); assert.equal(f.check('spare', external), false);
});
test('same-AI descendants follow parent chains through helpers and exclude unrelated peers', t => {
  const f = wrapperFixture(t), helper = { ...f.child, pid: 202, ppid: 200, command: '/usr/bin/helper' }, peer = { ...f.child, pid: 203, ppid: 1 };
  f.child.ppid = 202; f.before[1].ppid = 202;
  f.rows.push(helper, peer); f.before.push({ ...helper }, { ...peer });
  assert.equal(f.check(), false); assert.deepEqual(f.ids, [200, 201]); assert.equal(f.calls, 1);
});
test('managed wrapper proof takes priority over descendant inspection', t => {
  const f = wrapperFixture(t); f.roots = [{ ai: 'codex', account: 'default', identity: { ...f.p } }];
  f.files.clear(); assert.equal(f.check('default'), true); assert.equal(f.check(), false); assert.equal(f.calls, 0);
});
test('a mapped child path cannot suppress another family member data signature', t => {
  const f = wrapperFixture(t), foreign = f.files.get(201).paths[0];
  f.files.get(200).paths = [foreign]; f.files.get(200).mapped = [foreign];
  f.files.get(201).paths.push(...f.paths);
  assert.equal(f.check(), 'unknown-process');
});

for (const outcome of ['ESRCH', 'alive', 'EPERM', 'unavailable']) test('stale procwatch PID absent from snapshot: ' + outcome, t => {
  const f = fixture(t), missing = { pid: 201, since: f.p.since }; let probes = 0;
  const probe = pid => { probes++; assert.equal(pid, 201); if (outcome !== 'alive') throw Object.assign(Error(outcome), { code: outcome }); };
  for (const id of ['default', 'spare']) assert.equal(externalBusy('codex', id, [missing], [], f.rows, f.platform, () => f.homes, probe), outcome === 'ESRCH' ? false : 'unknown-process');
  assert.equal(probes, 2); assert.equal(f.calls, 0);
});
test('exited stale entry beside live default process does not release default or hold spare', t => {
  const f = fixture(t), external = [{ pid: 201, since: f.p.since }, f.p];
  const probe = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
  assert.equal(externalBusy('codex', 'default', external, [], f.rows, f.platform, () => f.homes, probe), 'external-codex');
  assert.equal(externalBusy('codex', 'spare', external, [], f.rows, f.platform, () => f.homes, probe), false);
  assert.equal(f.calls, 2);
});
for (const fault of ['invalid-entry-since', 'invalid-new-since', 'invalid-new-identity', 'invalid-pid']) test('exit proof remains conservative: ' + fault, t => {
  const f = fixture(t), item = { pid: 200, since: f.p.since }, newer = { ...f.p, since: '2026-11-06T01:00:00Z' };
  if (fault === 'invalid-entry-since') item.since = 'invalid';
  if (fault === 'invalid-new-since') newer.since = 'invalid';
  if (fault === 'invalid-new-identity') newer.uid = null;
  if (fault === 'invalid-pid') item.pid = -200;
  assert.equal(externalBusy('codex', 'spare', [item], [], [newer], f.platform, () => f.homes, () => { throw Error('must not probe'); }), 'unknown-process');
  assert.equal(f.calls, 0);
});
test('stale entries for Windows/Linux and other AIs keep original protection and never probe', t => {
  const f = fixture(t), probe = () => { throw Error('must not probe'); };
  for (const [name, ai] of [['win32','codex'], ['linux','codex'], ['darwin','claude']]) {
    f.platform.name = name;
    for (const rows of [[], [{ ...f.p, since: '2026-11-06T01:00:00Z' }]]) assert.equal(externalBusy(ai, 'spare', [f.p], [], rows, f.platform, () => f.homes, probe), 'unknown-process');
  }
});

function accountUI() {
  const { app, snapshot } = require('./fixtures/app-ui-harness.cjs'), f = app(), s = snapshot();
  s.accounts = [{ ai: 'codex', id: 'spare', name: '予備用', status: 'logged-out', busy: true, busyReason: 'unknown-process', authTerminal: false, email: ['fixture', 'example.test'].join('@') }];
  f.context.initial = s;
  vm.runInContext(`state=initial;view={kind:'settings'};accountStatusRows=state.accounts.map(r=>({...r}));
    drawAccountSettings=()=>{document.querySelector('#ai-accounts').innerHTML=accountSettingsHtml()};
    syncRoleAccountChoices=()=>{};usageContextChanged=()=>{};toast=s=>document.querySelector('#toast').textContent=s;`, f.context);
  f.calls = [];
  f.latest = { ...s.accounts[0] };
  f.context.api = async (route, body) => { f.calls.push({ route, body: body && JSON.parse(JSON.stringify(body)) }); return route === '/api/accounts' ? { accounts: [{ ...f.latest }] } : { ok: true }; };
  f.button = (action = 'login', id = 'spare', terminal = false) => ({ disabled: false, dataset: { accountAction: action }, closest: () => ({ dataset: { ai: 'codex', id, authTerminal: terminal ? '1' : '0' } }) });
  f.html = () => vm.runInContext('accountSettingsHtml()', f.context);
  return f;
}
test('one adopted list redraws held rows automatically while checked login and email survive', () => {
  const f = accountUI(); f.context.drawAccountSettings();
  assert.match(f.element('#ai-accounts').innerHTML, /data-account-action="login" data-account-held="true"/);
  vm.runInContext(`adoptState({...state,accounts:state.accounts.map(r=>({...r,busy:false,busyReason:null,authTerminal:false,status:'unknown',email:undefined}))})`, f.context);
  const html = f.element('#ai-accounts').innerHTML;
  assert.doesNotMatch(html, /保留中|data-account-held="true"/); assert.match(html, /未ログイン/); assert.ok(html.includes(['fixture', 'example.test'].join('@')));
  vm.runInContext(`adoptState({...state,accounts:state.accounts.map(r=>({...r,busy:true,authTerminal:true}))})`, f.context);
  assert.match(f.element('#ai-accounts').innerHTML, /認証用Terminalを開いています/); assert.doesNotMatch(f.element('#ai-accounts').innerHTML, /data-account-held="true"/);
});
test('held authentication buttons explain fresh reason near row and toast without a POST', async () => {
  for (const action of ['login','logout']) {
    const f = accountUI(); f.context.confirm = () => { throw Error('held action must not ask for logout confirmation'); };
    await f.context.operateAccount(f.button(action));
    assert.deepEqual(f.calls.map(c => c.route), ['/api/accounts']);
    assert.match(f.html(), /data-account-hold-message[^>]*>同じAI/);
    assert.match(f.element('#toast').textContent, /保留中/); assert.equal(vm.runInContext('accountOperation', f.context), false);
    assert.match(f.html(), /data-account-action="delete" disabled/);
  }
});
test('held snapshot can log in after latest list releases it; preflight failure never posts', async () => {
  const f = accountUI(); f.latest.busy = false;
  await f.context.operateAccount(f.button());
  assert.deepEqual(f.calls.map(c => c.route), ['/api/accounts','/api/accounts/login','/api/accounts']);
  assert.deepEqual(f.calls[1].body, { ai: 'codex', id: 'spare' });
  const g = accountUI(); g.context.api = async () => { throw Error('list unavailable'); };
  await g.context.operateAccount(g.button()); assert.match(g.element('#toast').textContent, /list unavailable/);
  assert.equal(vm.runInContext('accountOperation', g.context), false);
});
test('released logout retains both default confirmations and cancellation sends no POST', async () => {
  for (const accepts of [0, 1, 2]) {
    const f = accountUI(); f.latest.id = 'default'; f.latest.busy = false; let confirmations = 0;
    f.context.confirm = () => ++confirmations <= accepts;
    await f.context.operateAccount(f.button('logout', 'default'));
    assert.equal(confirmations, accepts < 2 ? accepts + 1 : 2);
    assert.equal(f.calls.some(c => c.route === '/api/accounts/logout'), accepts === 2);
    if (accepts === 2) assert.deepEqual(f.calls.find(c => c.body).body, { ai: 'codex', id: 'default', confirm: true, confirmDefault: true });
  }
});
test('preflight preserves existing auth Terminal and serializes repeated clicks', async () => {
  const f = accountUI(); f.latest.authTerminal = true;
  f.context.confirm = () => { throw Error('resume does not log out'); };
  await f.context.operateAccount(f.button('logout'));
  assert.deepEqual(f.calls.map(c => c.route), ['/api/accounts','/api/accounts/terminal']);
  assert.equal(f.calls[1].body.action, 'logout');
  const g = accountUI(); let release, calls = 0;
  g.context.api = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = g.context.operateAccount(g.button());
  await g.context.operateAccount(g.button()); assert.equal(calls, 1);
  release({ accounts: [g.latest] }); await first;
  assert.equal(calls, 1); assert.match(g.element('#toast').textContent, /保留中/);
});

test('real list shares one ps/lsof observation; next display and idle action observe anew', t => {
  const f=fixture(t),activity=require('../lib/account-processes');let snapshots=0;
  f.rows.push({...f.p,pid:201,command:'/app/claude'});
  f.platform.processSnapshot=()=>{snapshots++;return f.rows;};
  const a=new Accounts({file:path.join(f.homes[0].dir,'unused'),dry:true});
  a.get=(ai,id='default')=>({ai,id,name:id});a.read=()=>[{ai:'codex',id:'spare'}];a.terminalBusy=()=>false;a.available=()=>true;
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const body=source.slice(source.indexOf('function accountBusy('),source.indexOf('\nfunction usageSelection'));
  const ctx={usage:null,aiTools:{isOperating:()=>false},sessions:{list:()=>[],map:new Map()},chats:{running:new Map(),queue:()=>[],spoolRuns:[]},store:{listProjects:()=>[]},launch:{AI_KEY:{}},accounts:a,
    procwatch:{list:()=>[{ai:'claude',pid:201,since:f.p.since},{ai:'codex',pid:f.p.pid,since:f.p.since}]},require:name=>name==='./lib/platform'?f.platform:{...activity,observeExternal:(ai,external,roots,rows,_platform,locations)=>activity.observeExternal(ai,external,roots,rows,f.platform,locations)}};
  a.location=(_ai,id)=>f.homes.find(h=>h.id===id).dir;
  a.busy=vm.runInNewContext('('+body+')',ctx);
  const rows=a.list().filter(r=>r.ai==='codex');
  assert.equal(rows[0].busyReason,'external-codex');assert.equal(rows[1].busy,false);
  assert.equal(f.calls,1);assert.equal(snapshots,2);
  a.list();assert.equal(f.calls,2);assert.equal(snapshots,4);
  f.paths=[path.join(f.homes[1].dir,'state_5.sqlite')];
  assert.throws(()=>a.assertIdle('codex','spare'),/Hub外のCodex/);assert.equal(f.calls,3);assert.equal(snapshots,6);
  f.platform.processOpenFiles=()=>{f.calls++;throw Error('unavailable');};
  assert.ok(a.list().filter(r=>r.ai==='codex').every(r=>r.busyReason==='unknown-process'));assert.equal(f.calls,4);
  assert.throws(()=>a.assertIdle('codex','spare'),/アカウントを確認できません/);assert.equal(f.calls,5);
});
