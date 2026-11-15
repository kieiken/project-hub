'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../lib/platform/win32');
const { create: createNative } = require('../lib/platform/win32-native');
const P = require('../lib/owned-processes');
const row = (pid, ppid = process.pid, extra = {}) => ({ pid, ppid, sid: 'S-1-5-21-10-20-30-1001', since: '2026-10-18T01:02:03.1234567Z', command: 'C:\\Program Files\\nodejs\\node.exe', ...extra });
const self = () => row(process.pid, 1, { since: '2026-10-18T01:00:00.0000000Z' });
const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
function adapter(rows, overrides = {}) {
  return create({ native: { call: action => { assert.equal(action, 'snapshot'); return rows; } }, ...overrides });
}

test('Windows selection is lazy; Mac and Linux dependency sets and primitives are unchanged', () => {
  const filename = path.join(__dirname, '../lib/platform/index.js'), source = fs.readFileSync(filename, 'utf8');
  for (const name of ['darwin', 'linux', 'win32']) {
    const result = { exports: {} }, local = file => require(path.resolve(path.dirname(filename), file));
    vm.runInNewContext(source, { require: local, process: { platform: name }, module: result });
    assert.equal(result.exports.name, name);
    assert.deepEqual(Array.from(result.exports.supervisorFiles), name === 'win32'
      ? ['index.js', 'darwin.js', 'persistence.js', 'win32.js', 'win32-native.js', 'cache-guard.js', 'cache-guard-worker.js', 'file-io.js'] : ['index.js', 'darwin.js', 'persistence.js', 'file-io.js']);
    for (const file of result.exports.supervisorFiles) assert.match(file, /^[a-z][a-z0-9-]*\.js$/);
  }
});

test('Windows identities retain SID, exact 100ns timestamp and image; never substitute empty identity', () => {
  const child = row(42), p = adapter([self(), child]);
  assert.equal(p.processOwner(child), child.sid); assert.equal(p.currentProcessOwner(), child.sid);
  assert.deepEqual(P.capture(42, p.processSnapshot(), p), child);
  assert.doesNotThrow(() => P.assertLaunchOwnership(p));
  for (const change of [{ sid: '' }, { sid: 'display name' }, { since: '2026-10-18T01:02:03.123Z' }, { command: '' }]) {
    const bad = adapter([self(), { ...child, ...change }]);
    assert.throws(() => bad.processSnapshot(), /所有確認/);
    assert.throws(() => P.assertLaunchOwnership(bad), /所有確認/);
  }
  assert.throws(() => P.assertLaunchOwnership(adapter([child])), /所有確認/);
  assert.throws(() => adapter([child, child]).processSnapshot(), /所有確認/);
});

test('Windows owner checks reject replacement within the same millisecond and foreign descendants', () => {
  const original = row(42), foreign = row(44, 42, { sid: 'S-1-5-18' }); let rows = [self(), original, foreign]; const killed = [];
  const p = adapter(rows, { native: { call: () => rows } });
  const owned = new P.OwnedProcesses(original, { platform: p, scan: () => rows, kill: pid => killed.push(pid) });
  assert.deepEqual(owned.collect().map(r => r.pid), [42]);
  rows = [self(), { ...original, since: '2026-10-18T01:02:03.1234568Z' }, foreign];
  assert.throws(() => owned.signal('SIGTERM'), /識別/); assert.deepEqual(killed, []);
});

test('Windows limited tree stop never sends an unchecked /T and does not fall back on mismatch', () => {
  const root = row(42), descendant = row(43, 42), foreign = row(44, 42, { sid: 'S-1-5-18' }), calls = [];
  const p = create({ native: { call(action, value) {
    if (action === 'snapshot') return [self(), root, descendant, foreign];
    calls.push(value); if (value.row.pid === 42 && calls.length > 2) throw Error('identity_changed'); return true;
  } }, fs: { statSync: () => ({ isFile: () => true }) } });
  const child = { pid: 42, exitCode: null, signalCode: null, spawnfile: root.command, kill: () => assert.fail('unsafe fallback') };
  assert.equal(p.killTree(child), true); assert.deepEqual(calls.map(c => c.row.pid), [43, 42]);
  assert.throws(() => p.killTree(child), /identity_changed/);
  assert.throws(() => p.killTree({ ...child, spawnfile: 'C:\\other.exe' }), /実行ファイル/);
  assert.throws(() => p.killTree({ ...child, exitCode: 0 }), /起動した子/);
});

test('PATHEXT lookup uses absolute PATH entries and regular files, including quoted directories', () => {
  const checked = [], p = create({ env: { PATHEXT: '.EXE;.CMD;.BAD&X', PATH: '.;"C:\\Program Files\\bin";D:\\bin' },
    fs: { statSync(file) { checked.push(file); if (file === 'D:\\bin\\codex.cmd') return { isFile: () => true }; return missing(); } } });
  assert.equal(p.findExecutable('codex'), 'D:\\bin\\codex.cmd');
  assert.deepEqual(checked, ['C:\\Program Files\\bin\\codex.exe', 'C:\\Program Files\\bin\\codex.cmd', 'D:\\bin\\codex.exe', 'D:\\bin\\codex.cmd']);
  assert.equal(p.findExecutable('bad\ncommand'), null);
  assert.equal(create({ fs: { statSync: () => ({ isFile: () => false }) } }).findExecutable('C:\\directory.exe'), null);
});

test('desktop arguments remain data, folder cancellation is empty and legacy callback returns immediately', async () => {
  const calls = []; let finish;
  const p = create({ native: { asyncCall(action, data, callback) { calls.push({ action, data }); if (action === 'pick') { finish = callback; return 'child'; } callback(null, true); } } });
  await p.openPath('C:\\a & b\\file.txt'); await p.revealPath('C:\\a, b\\file.txt'); await p.openUrl('http://127.0.0.1:4545');
  assert.deepEqual(calls.map(c => c.action), ['open', 'reveal', 'open']);
  await assert.rejects(p.openUrl('file:///C:/test'), /URL/);
  await assert.rejects(p.openPath('C:\\bad"x'), /場所/);
  let selected; assert.equal(p.pickFolder('choose', value => { selected = value; }), 'child'); assert.equal(selected, undefined);
  finish(null, ''); assert.equal(selected, '');
  const selecting = p.pickFolder('choose'); finish(null, 'C:\\chosen'); assert.equal(await selecting, 'C:\\chosen');
});

test('Windows persistence preserves before/callback/after ordering and binds both checks to the same volume and parent identity', () => {
  const calls = [], binding = 'volume-guid|serial|file-id'; let failure;
  const p = create({ native: { call(action, data) { calls.push([action, data]); if (failure) throw Error(failure); return action === 'file' ? true : binding; } } });
  assert.equal(p.persistence.withDirectorySync('C:\\trial', () => { calls.push('operation'); return 'result'; }), 'result');
  assert.deepEqual(calls, [['directory', { path: 'C:\\trial' }], 'operation', ['directory', { path: 'C:\\trial', expected: binding }]]);
  failure = 'access denied'; let ran = false;
  assert.throws(() => p.persistence.withDirectorySync('C:\\trial', () => { ran = true; }), /access denied/); assert.equal(ran, false);
  assert.throws(() => p.persistence.syncFile('C:\\file'), /access denied/);
});

test('failed post-check, changed binding and callback failures remain unconfirmed', () => {
  let calls = 0, completed = false;
  const p = create({ native: { call() { if (++calls === 2) throw Error('flush failed'); return 'binding'; } } });
  assert.throws(() => { p.persistence.withDirectorySync('C:\\trial', () => {}); completed = true; }, /flush failed/); assert.equal(completed, false);
  calls = 0;
  assert.throws(() => p.persistence.withDirectorySync('C:\\trial', () => { throw Error('callback failed'); }), /callback failed/); assert.equal(calls, 1);
  const changed = create({ native: { call: () => ++calls === 2 ? 'old' : 'new' } });
  assert.throws(() => changed.persistence.withDirectorySync('C:\\trial', () => {}), /保存先/);
});

test('unsupported Windows features stop explicitly without launching Mac primitives or reducing license enforcement', async () => {
  // Nothing on the fixture PATH: command isolation needs Codex CLI and Git for Windows.
  const p = create({ native: { call() { assert.fail('native side effect'); } }, fs: { statSync: missing }, env: {} });
  await assert.rejects(p.openTerminal('command'), /Windowsでは未対応/); await assert.rejects(p.focusTerminal(42), /Windowsでは未対応/);
  assert.equal(p.commandSandbox.available(), false);
  assert.throws(() => p.commandSandbox.spawn('fixture', 'C:\\work', p.commandSandbox.profile('C:\\work', []), () => assert.fail('spawned')), e => e.code === 'command_sandbox_unavailable' && /Codex CLI/.test(e.message));
  assert.throws(() => p.secretStore().get('account'), /secret_store_unavailable/);
  assert.equal(p.appUpdater.sourceSupported(), false); assert.equal(p.appUpdater.packagedSupported('x64'), false);
  assert.equal(p.trashDir('C:\\Users\\test'), 'C:\\Users\\test\\.ProjectHubTrash');
});

// Compile/runtime are substituted at the process boundary; real private temp
// directories exercise reuse, tampering, cleanup and failure transitions on Mac.
function bridgeFixture(t, behavior = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'hub-native-fixture-'));
  const calls = [], runtime = [];
  let compilation, executable;
  function execute(file, argv, options) {
    calls.push({ file, argv, options });
    if (file.endsWith('powershell.exe')) {
      compilation = JSON.parse(options.input); executable = compilation.file;
      if (behavior.compile) return behavior.compile(compilation);
      fs.writeFileSync(executable, 'mock fixed executable');
      return JSON.stringify({ ok: true, file: executable });
    }
    const request = JSON.parse(options.input); runtime.push(request);
    assert.equal(file, executable); assert.deepEqual(argv, []);
    if (behavior.run) return behavior.run(request);
    return JSON.stringify({ ok: true, id: request.id, value: 'binding' });
  }
  const native = createNative({ localAppData: root, paths: path, systemRoot: String.raw`C:\Windows`, execFileSync: execute, spawn: behavior.spawn,
    guardFactory(opts) {
      const directory=fs.mkdtempSync(path.join(root,'run-')), file=path.join(directory,'helper.exe');
      let value;
      try { value=JSON.parse(execute(opts.powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',require('../lib/platform/cache-guard').script],
        {input:JSON.stringify({source:opts.source,file,directory}),shell:false,windowsHide:true})); }
      catch(e) {if(e.stdout){const r=JSON.parse(e.stdout);throw Object.assign(Error('guard'),{stage:r.stage,reasonCode:r.code});}throw e;}
      if(!value.ok)throw Error('guard');
      return {file,digest:require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),verify(){},close(){fs.rmSync(directory,{recursive:true,force:true});}};
    },
    execFile: behavior.asyncRun && ((file, argv, options, callback) => {
      calls.push({ file, argv, options }); assert.equal(file, executable); assert.deepEqual(argv, []);
      const { EventEmitter } = require('node:events'), stdin = new EventEmitter(), child = new EventEmitter();
      stdin.end = input => { const request = JSON.parse(input); runtime.push(request); behavior.asyncRun(request, callback, stdin); child.emit('close'); };
      child.stdin=stdin; child.kill=()=>child.emit('close'); return child;
    }) });
  t.after(() => { try { native.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  return { native, calls, runtime, get compilation() { return compilation; }, get executable() { return executable; } };
}

test('native compiler runs once; repeated sync/async requests execute the cached program with JSON data only', async t => {
  const fixture = bridgeFixture(t, { asyncRun(r, callback) { callback(null, JSON.stringify({ ok: true, id: r.id, value: true })); } });
  const target = String.raw`C:\quoted' & $()\日本語`;
  assert.equal(fixture.native.call('directory', { path: target }), 'binding');
  assert.equal(fixture.native.call('snapshot'), 'binding');
  await new Promise((resolve, reject) => fixture.native.asyncCall('open', { path: target }, (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(fixture.calls.length, 4); // one compile + three native operations
  const [compiler, ...executions] = fixture.calls;
  assert.equal(compiler.file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.equal(compiler.argv.includes('-ExecutionPolicy'), false);
  assert.match(compiler.argv.at(-1), /CompileAssemblyFromSource/);
  assert.match(compiler.argv.at(-1), /GetKernelObjectSecurity/);
  assert.doesNotMatch(compiler.argv.at(-1), /Set-Acl|SetOwner|AddAccessRule|SetAccessRuleProtection|RunAs|ExecutionPolicy/);
  assert.match(compiler.argv.at(-1), /\/platform:x64/);
  for (const call of executions) {
    assert.deepEqual(call.argv, []); assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert.equal(Object.hasOwn(JSON.parse(call.options.input), 'source'), false);
  }
  assert.equal(fixture.runtime[0].path, target); assert.equal(fixture.runtime[2].path, target);
  assert.equal(new Set(fixture.runtime.map(r => r.id)).size, 3);
  const cache = path.dirname(fixture.executable); fixture.native.close();
  assert.equal(fs.existsSync(cache), false); assert.throws(() => fixture.native.call('snapshot'), /終了済み/);
});

test('failure before a compiler stage is reported remains initialization failure and is not retried', t => {
  const fixture = bridgeFixture(t, { compile() { throw Error('private startup failure'); } });
  assert.throws(() => fixture.native.call('snapshot'), { code: 'windows_bridge_failed', stage: 'native-initialize', reasonCode: 'CACHE_INIT_FAILED' });
  assert.throws(() => fixture.native.call('snapshot'), { code: 'windows_bridge_failed', stage: 'native-initialize', reasonCode: 'CACHE_INIT_FAILED' });
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.runtime.length, 0);
});

test('reported initialization and compilation failures stay distinct without leaking private exception fields', async t => {
  for (const [stage, reasonCode] of [['native-initialize', 'CACHE_PERMISSIONS_UNSAFE'], ['native-compile', 'COMPILATION_FAILED']]) {
    await t.test(stage, t => {
      const fixture = bridgeFixture(t, { compile() {
        throw Object.assign(Error('PRIVATE PATH'), { status: 1, stdout: JSON.stringify({ ok: false, stage, code: reasonCode, message: 'SECRET' }) });
      } });
      assert.throws(() => fixture.native.call('license-directory'), error => {
        assert.equal(error.stage, stage); assert.equal(error.reasonCode, reasonCode);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|SECRET/); return true;
      });
      assert.equal(fixture.runtime.length, 0); assert.equal(fixture.calls.length, 1);
    });
  }
});

test('licensing uses read-only NTFS validation and general storage uses ordinary-rights identity validation', t => {
  const fixture = bridgeFixture(t);
  fixture.native.call('license-directory');
  assert.match(fixture.compilation.source, /case "license-directory": value=HubWindows\.ValidateDirectory\([^\n]+false\)/);
  assert.match(fixture.compilation.source, /case "directory": value=HubWindows\.ValidateDirectory\([^\n]+false\)/);
  assert.match(fixture.compilation.source, /if\(flush\) using\(var disk=Open\([^\n]+FlushFileBuffers\(disk\)/);
  const calls = [], platform = create({ native: { call(action, data) { calls.push([action, data]); return 'bound'; } } });
  assert.equal(platform.licenseDirectory('C:\\isolated', 'bound'), 'bound');
  assert.deepEqual(calls, [['license-directory', { path: 'C:\\isolated', expected: 'bound' }]]);
});

test('altered or missing cached executable is rejected before another native request', async t => {
  for (const change of [file => fs.writeFileSync(file, 'changed'), file => fs.unlinkSync(file)]) await t.test(String(change), t => {
    const fixture = bridgeFixture(t); fixture.native.call('snapshot');
    change(fixture.executable);
    assert.throws(() => fixture.native.call('file', { path: String.raw`C:\data` }), { code: 'windows_bridge_failed' });
    assert.equal(fixture.calls.length, 2); // no recompile or execution after change
  });
});

test('unknown native result, crash, timeout, wrong response ID and nonzero apparent success cannot confirm saving', async t => {
  const cases = {
    empty: () => '',
    malformed: () => 'not json',
    wrongID: () => JSON.stringify({ ok: true, id: 'other', value: true }),
    crash: () => { throw Object.assign(Error('crash'), { status: 1 }); },
    timeout: r => { throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT', stdout: JSON.stringify({ ok: true, id: r.id, value: true }) }); },
    signal: r => { throw Object.assign(Error('signal'), { signal: 'SIGTERM', stdout: JSON.stringify({ ok: true, id: r.id, value: true }) }); },
    nonzeroSuccess: r => { throw Object.assign(Error('failed exit'), { status: 1, stdout: JSON.stringify({ ok: true, id: r.id, value: true }) }); },
  };
  for (const [name, run] of Object.entries(cases)) await t.test(name, t => {
    const fixture = bridgeFixture(t, { run }); let saved = false;
    assert.throws(() => { fixture.native.call('directory'); saved = true; }, { code: 'windows_bridge_failed' });
    assert.equal(saved, false);
    assert.throws(() => fixture.native.call('snapshot'), { code: 'windows_bridge_failed' });
    assert.equal(fixture.calls.length, 2);
  });
});

test('confirmed native denial propagates only a bounded code; the cache survives without recompilation', t => {
  const fixture = bridgeFixture(t, { run(r) {
    if (r.action === 'directory') throw Object.assign(Error('exit 1'), { status: 1, stdout: JSON.stringify({ ok: false, id: r.id, error: 'PRIVATE PATH AND SECRET', win32: 5 }) });
    return JSON.stringify({ ok: true, id: r.id, value: true });
  } });
  assert.throws(() => fixture.native.call('directory'), { code: 'windows_native_failed', stage: 'native-call', reasonCode: 'WIN32_5', message: 'Windows native確認失敗' });
  assert.equal(fixture.native.call('snapshot'), true); assert.equal(fixture.calls.length, 3);
});

test('async pipe failure and timed-out apparent success reject once and block further operations', async t => {
  for (const mode of ['pipe', 'timeout']) await t.test(mode, async t => {
    const fixture = bridgeFixture(t, { asyncRun(r, callback, stdin) {
      if (mode === 'pipe') { stdin.emit('error', Error('broken pipe')); callback(null, JSON.stringify({ ok: true, id: r.id, value: true })); }
      else callback(Object.assign(Error('timeout'), { killed: true }), JSON.stringify({ ok: true, id: r.id, value: true }));
    } });
    let count = 0;
    await assert.rejects(new Promise((resolve, reject) => fixture.native.asyncCall('open', {}, (error, value) => { count++; error ? reject(error) : resolve(value); })), { code: 'windows_bridge_failed' });
    assert.equal(count, 1); assert.throws(() => fixture.native.call('snapshot'), { code: 'windows_bridge_failed' });
    assert.equal(fixture.calls.length, 2);
  });
});

test('startup refuses failed storage/ownership/guard before creating data; no privilege or authentication changes', () => {
  const { preflight } = require('../start-windows'); const events = [];
  const p = adapter([self()], { native: { call: () => [self()] } });
  p.shellCandidates = () => ['git-bash']; p.persistence = { syncDirectory(dir) { events.push(dir); throw Error('access denied'); } };
  const options = { platform: p, root: '/trial/new', host: 'win32', arch: 'x64', nodeVersion: '22.23.1', guard: '', io: { existsSync: file => file !== '/trial/new', mkdirSync: () => assert.fail('must not create') } };
  assert.throws(() => preflight(options), /access denied/); assert.deepEqual(events, ['/trial']);
  assert.throws(() => preflight({ ...options, guard: 'guard.exe', run: () => { throw Error('guard rejected'); } }), /guard rejected/);
  assert.throws(() => preflight({ ...options, arch: 'arm64' }), /Windows x64/);
  assert.throws(() => preflight({ ...options, platform: adapter([]) }), /所有確認/);
});

test('declared Windows supervisor set loads in isolation with no live Hub dependencies', () => {
  const os = require('node:os'), cp = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-windows-pinned-'));
  try {
    const directory = path.join(temp, 'platform'); fs.mkdirSync(directory, { mode: 0o700 });
    const names = ['index.js', ...create().supervisorFiles];
    for (const name of names) fs.copyFileSync(path.join(__dirname, '../lib/platform', name), path.join(directory, name));
    const script = `Object.defineProperty(process,'platform',{value:'win32'}); const p=require(process.argv[1]); if(p.name!=='win32'||p.supervisorFiles.length!==8)throw Error('missing Windows dependency'); console.log(JSON.stringify(p.supervisorFiles));`;
    const loaded = JSON.parse(cp.execFileSync(process.execPath, ['-e', script, directory], { encoding: 'utf8' }));
    assert.deepEqual(loaded, ['index.js', 'darwin.js', 'persistence.js', 'win32.js', 'win32-native.js', 'cache-guard.js', 'cache-guard-worker.js', 'file-io.js']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('startup browser readiness binds the HTTP server to its own child PID and runtime directory', async () => {
  const { serverReady } = require('../start-windows'); let calls = [];
  const owner = { pid: 42, token: 'a'.repeat(64) }, verify = async port => { assert.equal(port, 1234); return owner; };
  const probe = body => async (url, options) => { calls.push(url); assert.equal(options.headers['X-Hub-Token'], require('../lib/local-auth').capability(owner.token)); return { ok: true, json: async () => body }; };
  assert.equal(await serverReady('http://localhost:1234', 42, __dirname, probe({ pid: 43, runtimePath: __dirname }), verify), false);
  assert.equal(calls.length, 1); calls = [];
  assert.equal(await serverReady('http://localhost:1234', 42, __dirname, probe({ pid: 42, runtimePath: '/unrelated' }), verify), false);
  assert.equal(calls.length, 1); calls = [];
  assert.equal(await serverReady('http://localhost:1234', 42, __dirname, probe({ pid: 42, runtimePath: __dirname }), verify), true);
  assert.deepEqual(calls, ['http://localhost:1234/api/ping', 'http://localhost:1234/api/state']);
  calls=[];assert.equal(await serverReady('http://localhost:1234',42,__dirname,probe({}),async()=>({...owner,pid:43})),false);assert.equal(calls.length,0);
  await assert.rejects(serverReady('http://localhost:1234',42,__dirname,probe({}),async()=>{throw Error('unverified_hub');}),/unverified_hub/);assert.equal(calls.length,0);
});

test('console Ctrl+C waits for the attached server instead of forcibly terminating it on Windows', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(), host = new EventEmitter(), messages = [];
  child.pid = 42; child.kill = () => assert.fail('Ctrl+C must not call Windows child.kill');
  Object.assign(host, { platform: 'win32', arch: 'x64', versions: { node: '22.23.1' }, execPath: 'node.exe', env: { HUB_ROOT: '/trial' } });
  const directory = path.resolve(__dirname, '..'); let browserOpened = false;
  const platform = { shellCandidates: () => ['git-bash'], persistence: { syncDirectory() {} }, openUrl: async () => { browserOpened = true; } };
  const modules = {
    'node:fs': { existsSync: () => true }, 'node:os': require('node:os'), 'node:path': path, 'node:url': require('node:url'),
    './lib/local-auth': { capability: () => 'fixture-owner-capability' },
    './app/open-browser.cjs': { verify: async () => ({ pid:42,token:'fixture-owner' }), launch: async (port,open) => { assert.equal(port,4545); await open('/fixture-owner-launch.html'); return {cleanup(){}}; } },
    'node:child_process': { spawn(file, args, options) {
      assert.equal(file, 'node.exe'); assert.deepEqual(Array.from(args), [path.join(directory, 'server.js')]);
      assert.equal(options.stdio, 'inherit'); assert.equal(options.detached, undefined); assert.equal(options.shell, false);
      return child;
    } },
    'node:net': { createServer() { return { once() {}, listen(port, address, callback) { callback(); }, close(callback) { callback(); } }; } },
    './lib/platform': platform, './lib/owned-processes': { assertLaunchOwnership() {} }, 'node-pty': {},
  };
  const localRequire = name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; };
  const result = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'start-windows.js'), 'utf8') + '\nmodule.exports.main = main;', {
    require: localRequire, process: host, module: result, __dirname: directory, AbortSignal,
    console: { log: value => messages.push(value), error: value => assert.fail(value) },
    fetch: async () => ({ ok: true, json: async () => ({ pid: 42, runtimePath: directory }) }), setTimeout,
  });
  await result.exports.main(); assert.equal(browserOpened, true);
  host.emit('SIGINT'); assert.equal(host.exitCode, undefined);
  assert.equal(messages.at(-1), 'Project Hub の終了処理を待っています。');
  child.emit('exit', 0); assert.equal(host.exitCode, 0);
  assert.equal(messages.at(-1), 'Project Hub が止まりました。');
});

test('Windows secret adapter validates native responses and redacts secret operation failures',()=>{
  const seen=[],p=create({native:{call(action,data){seen.push({action,data});
    if(action==='secret-get')return 'fixture-private-bundle';if(action==='secret-put')return true;
    if(action==='clock')return 123.5;if(action==='machine-hint')return 'a'.repeat(43);
  }}}),secret=p.secretStore();
  assert.equal(secret.get('device-fixture'),'fixture-private-bundle');secret.put('device-fixture','fixture-private-bundle');
  assert.equal(secret.elapsed(),123.5);assert.equal(p.machineHint(),'a'.repeat(43));
  const bad=create({native:{call(){throw Error('SECRET MUST NOT ESCAPE');}}});
  assert.throws(()=>bad.secretStore().get('device-fixture'),e=>e.message==='secret_store_unavailable');
  assert.throws(()=>bad.machineHint(),e=>e.message==='machine_hint_unavailable');
  for(const value of [NaN,-1,'123',null])assert.throws(()=>create({native:{call:()=>value}}).secretStore().elapsed(),/elapsed_clock/);
});

test('Windows resume watcher requires its handshake and matching request, then stops without an error callback',t=>{
  const {EventEmitter}=require('node:events');let child,request,events=0,errors=0;
  const fixture=bridgeFixture(t,{spawn(file,args,options){
    assert.equal(file,fixture.executable);assert.deepEqual(args,[]);assert.equal(options.shell,false);
    child=new EventEmitter();child.stdin=new EventEmitter();child.stdout=new EventEmitter();
    child.stdin.end=input=>{request=JSON.parse(input);};child.kill=()=>{child.emit('close',0);};return child;
  }});
  const stop=fixture.native.watch(()=>events++,()=>errors++);
  const ready=JSON.stringify({ok:true,id:request.id,value:'ready'})+'\n';
  child.stdout.emit('data',Buffer.from(ready.slice(0,10)));child.stdout.emit('data',Buffer.from(ready.slice(10)));
  child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,id:request.id,value:'resume'})+'\n'));
  assert.equal(events,1);assert.equal(errors,0);stop();assert.equal(errors,0);
  fixture.native.watch(()=>events++,()=>errors++);
  child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,id:'wrong',value:'resume'})+'\n'));
  assert.equal(events,1);assert.equal(errors,1);
  assert.match(fixture.compilation.source,/ProtectedData\.Protect/);assert.match(fixture.compilation.source,/GetTickCount64/);
});

test('integrated Windows rename keeps native rejection and never substitutes a Node rename', () => {
  const calls=[];let value=true;
  const p=create({native:{call(action,data){calls.push([action,data]);return value;}}});
  assert.equal(p.persistence.durability,'file-flush-write-through-rename');
  p.persistence.renameSync('C:\\from','C:\\to');
  assert.deepEqual(calls,[['rename',{from:'C:\\from',to:'C:\\to'}]]);
  value=false;assert.throws(()=>p.persistence.renameSync('C:\\from','C:\\to'),/名前変更/);
  const denied=create({native:{call(){throw Error('native denied');}}});
  assert.throws(()=>denied.persistence.renameSync('C:\\from','C:\\to'),/native denied/);
});

test('integrated native payload combines write-through same-volume rename with protected license dispatch', t => {
  const f=bridgeFixture(t);f.native.call('snapshot');const code=f.compilation.source;
  assert.match(code,/MoveFileExW\(source,destination,0x1\|0x8\)/);
  assert.doesNotMatch(code,/MoveFileExW\(source,destination,[^\n]*(?:0x2|COPY_ALLOWED)/);
  assert.match(code,/before\.Split\('\|'\)\[0\]!=origin\.Split\('\|'\)\[0\]/);
  assert.ok(code.indexOf('if(!directory) FlushFile(source);')<code.indexOf('Check(MoveFileExW(source,destination,0x1|0x8))'));
  for(const part of ['ValidateDirectory(parent,before,false)','ValidateDirectory(sourceParent,origin,false)',
    'case "license-directory"','case "secret-get"','case "secret-put"','case "clock"','case "watch"',
    'ProtectedData.Unprotect','ProtectedData.Protect','HubWindowsLicense.MachineHint']) assert.ok(code.includes(part),part);
});

test('picker Promise distinguishes native failure from cancellation and legacy callbacks remain compatible', async () => {
  for (const synchronous of [false, true]) {
    const p = create({ native: { asyncCall(action, request, done) {
      const error = Error('private native diagnostic');
      if (synchronous) throw error;
      done(error);
    } } });
    await assert.rejects(p.pickFolder('choose'), e => e.code === 'folder_picker_unavailable' && e.message === 'folder_picker_unavailable');
    let result; p.pickFolder('choose', value => { result = value; }); assert.equal(result, '');
  }
  for (const value of ['', 'C:\\chosen']) {
    const p = create({ native: { asyncCall(action, request, done) { done(null, value); } } });
    assert.equal(await p.pickFolder('choose'), value);
  }
});
test('Windows private-directory adapter passes path and create mode to the shared native helper', () => {
  const calls = [], p = create({ native: { call(action, data) { calls.push({action,data}); return true; } } });
  assert.equal(p.privateDirectory('C:\\private', false), true);
  assert.equal(p.privateDirectory('C:\\private', true), true);
  assert.deepEqual(calls, [false,true].map(create => ({action:'private-directory',data:{path:'C:\\private',create}})));
});
