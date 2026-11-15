'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const platforms = require('../lib/platform');
const { createDarwin } = platforms;
const nativeError = () => Object.assign(Error('not running'), { code: 'ESRCH' });

test('Mac UI commands preserve quoting, arguments, dry mode and errors', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-terminal-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const p = createDarwin({ terminalDir: dir, execFile: (file, args, callback) => { calls.push({ file, args }); callback(file === 'bad' ? Error('bad') : null); } });
  const command = 'echo "x" \\ tail';
  const dry = await p.openTerminal(command, true);
  assert.equal(dry.file, 'osascript'); assert.equal(calls.length, 0);
  assert.equal(dry.args[1], 'tell application "Terminal" to do script "echo \\"x\\" \\\\ tail"');
  await p.openTerminal(command); assert.equal(calls[0].file, dry.file); assert.match(calls[0].args[1], /do script "\/bin\/bash '/);
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), '#!/bin/bash\n/bin/rm -f -- "$0" || exit $?\n' + command + '\n');
  await p.openPath('/a b'); await p.revealPath('/a b'); await p.openUrl('https://example.invalid');
  await p.revealPath('/a b', false, { absolute: true });
  assert.deepEqual(calls.slice(1), [
    { file: 'open', args: ['/a b'] }, { file: 'open', args: ['-R', '/a b'] },
    { file: 'open', args: ['https://example.invalid'] }, { file: '/usr/bin/open', args: ['-R', '/a b'] },
  ]);
  const failing = createDarwin({ execFile: (file, args, callback) => callback(Error('denied')) });
  await assert.rejects(failing.openPath('/a'), /denied/);
});

test('folder selection preserves cancellation, prompt scrubbing and trailing slash', async () => {
  let error = false; const calls = [];
  const p = createDarwin({ execFile: (file, args, callback) => { calls.push({ file, args }); callback(error ? Error('cancelled') : null, '/chosen dir/\n'); } });
  assert.equal(await p.pickFolder('a"b\\c'), '/chosen dir');
  assert.deepEqual(calls[0], { file: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "abc")'] });
  error = true; assert.equal(await p.pickFolder(), '');
  assert.match(calls[1].args[1], /フォルダを選んでください/);
  let selected, finish;
  const callbackPicker = createDarwin({ execFile: (file, args, callback) => { finish = callback; return 'child'; } });
  assert.equal(callbackPicker.pickFolder('fixture', value => { selected = value; }), 'child');
  assert.equal(selected, undefined); finish(null, '/chosen/'); assert.equal(selected, '/chosen');
});

test('process scanning retains C locale, timeout and partial lsof results', async () => {
  const calls = [];
  const p = createDarwin({ execFile: (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(file === 'lsof' ? Object.assign(Error('some PIDs exited'), { code: 1 }) : null,
      file === 'ps' ? '  42 1 Sat Oct 17 09:12:34 2026 codex fixture\n' : 'p42\nfcwd\nn/a b\n');
  } });
  const rows = await p.listProcesses();
  assert.deepEqual(rows, [{ pid: 42, ppid: 1, since: new Date(2026, 9, 17, 9, 12, 34).toISOString(), command: 'codex fixture' }]);
  assert.deepEqual(await p.processCwd([42, 43]), new Map([[42, '/a b']]));
  assert.deepEqual(calls[0].args, ['-axo', 'pid=,ppid=,lstart=,command=']);
  assert.deepEqual(calls[1].args, ['-a', '-d', 'cwd', '-p', '42,43', '-Fpn']);
  assert.equal(calls[0].options.timeout, 5000); assert.equal(calls[0].options.env.LC_ALL, 'C');
  const failed = createDarwin({ execFile: (file, args, options, callback) => callback(Object.assign(Error('denied'), { code: 'EACCES' }), '') });
  await assert.rejects(failed.listProcesses(), /denied/);
});

test('ownership snapshot excludes zombies and retains strong identity fields', () => {
  let invocation;
  const p = createDarwin({ execFileSync: (...args) => { invocation = args; return '42 1 42 501 Sat Oct 17 09:12:34 2026 S /usr/bin/node\n43 1 43 501 Sat Oct 17 09:12:34 2026 Z /usr/bin/node\n'; } });
  assert.deepEqual(p.processSnapshot(), [{ pid: 42, ppid: 1, pgid: 42, uid: 501, since: 'Sat Oct 17 09:12:34 2026', command: '/usr/bin/node' }]);
  assert.equal(invocation[0], 'ps'); assert.equal(invocation[2].timeout, 2000);
  assert.throws(() => p.processSnapshot(() => ''), /所有確認に失敗/);
  assert.equal(p.processBirth(42, () => ' stamp \n'), 'stamp');
  assert.equal(p.processBirth(42, () => { throw nativeError(); }), '');
});

test('process group signalling retains fallback choices for each caller', () => {
  const calls = []; const child = { pid: 42, kill: signal => calls.push(['child', signal]) };
  const p = createDarwin({ kill: (pid, signal) => { calls.push([pid, signal]); if (signal !== 0) throw nativeError(); return true; } });
  assert.equal(p.killTree(child, 0, { fallback: false }), true);
  p.killTree(child, 'SIGKILL');
  assert.throws(() => p.killTree(child, 'SIGTERM', { fallback: false }), /not running/);
  assert.deepEqual(calls, [[-42, 0], [-42, 'SIGKILL'], ['child', 'SIGKILL'], [-42, 'SIGTERM']]);
});

test('legacy Linux scans and cwd reads retain their existing contract', async () => {
  const p = platforms.forPlatform('linux'); let invocation;
  assert.deepEqual(await p.listProcesses(async (...args) => { invocation = args; return '42 1 Sat Oct 17 09:12:34 2026 claude fixture'; }),
    [{ pid: 42, ppid: 1, since: new Date(2026, 9, 17, 9, 12, 34).toISOString(), command: 'claude fixture' }]);
  assert.deepEqual(invocation, ['ps', ['-eo', 'pid=,ppid=,lstart=,args=']]);
  assert.deepEqual(await p.processCwd([42, 43], { readlink: file => { if (file === '/proc/42/cwd') return '/work'; throw nativeError(); } }), new Map([[42, '/work']]));
});

test('procwatch consumes an injected adapter and retains cache and ancestry', async () => {
  let cwdCalls = 0, fail = false;
  const row = { pid: 42, ppid: 41, since: '2026-10-17T00:00:00Z', command: 'codex fixture' };
  const p = { listProcesses: async () => { if (fail) throw Error('unavailable'); return [row]; }, processCwd: async pids => { cwdCalls++; assert.deepEqual(pids, [42]); return new Map([[42, '/work/task']]); } };
  const w = require('../lib/procwatch').create({ platform: p, selfPid: 900, log: () => {}, projects: () => [{ id: 'p', dir: '/work', tasks: [{ id: 't', workdir: '/work/task' }] }] });
  assert.equal((await w.scan())[0].task, 't'); await w.scan(); assert.equal(cwdCalls, 1);
  assert.equal(w.hasAncestor(42, pid => pid === 41), true);
  fail = true; assert.equal((await w.scan())[0].pid, 42);
});

test('sessions resolve the executable through their injected platform', () => {
  let lookup, spawn;
  const proc = { pid: -1, onData() {}, onExit() {} };
  const { Sessions } = require('../lib/sessions');
  const s = new Sessions({ platform: { findExecutable: (...args) => { lookup = args; return '/fixture/cli'; } }, pty: { spawn: (...args) => { spawn = args; return proc; } } });
  const result = s.start({ project: 'p', task: 't', ai: 'claude', dir: fs.realpathSync(os.tmpdir()), command: 'fixture-cli', args: ['arg'] });
  assert.equal(lookup[0], 'fixture-cli'); assert.equal(spawn[0], '/fixture/cli'); assert.deepEqual(spawn[1], ['arg']);
  assert.equal(result.proc, proc);
});

test('POSIX lookup and node-pty helper retain PATH search and executable modes', () => {
  const access = [], chmod = [];
  const p = createDarwin({ fs: {
    constants: fs.constants, existsSync: file => !file.includes('missing'),
    accessSync: (file, mode) => { access.push([file, mode]); if (file !== '/second/cli') throw Error('not executable'); },
    readdirSync: dir => { if (dir.endsWith('prebuilds')) return ['darwin-arm64', 'missing']; if (dir.endsWith('Release')) return ['spawn-helper']; throw Error('not found'); },
    chmodSync: (file, mode) => chmod.push([file, mode]),
  } });
  assert.equal(p.findExecutable('cli', ':/first:/second'), '/second/cli');
  assert.deepEqual(access, [['/first/cli', fs.constants.X_OK], ['/second/cli', fs.constants.X_OK]]);
  assert.equal(p.findExecutable('/explicit/cli', ''), '/explicit/cli'); assert.equal(p.findExecutable('/missing/cli', ''), null);
  p.fixPtyHelper('/pty');
  assert.deepEqual(chmod, [['/pty/prebuilds/darwin-arm64/spawn-helper', 0o755], ['/pty/build/Release/spawn-helper', 0o755]]);
});

test('sandbox keeps permission checks ahead of an injected native spawn', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'platform-sandbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { WorkspaceSandbox } = require('../lib/workspace-sandbox');
  let spawned = 0; const kills = [];
  const p = { commandSandbox: {
    available: () => true, profile: (dir, reads) => { assert.equal(dir, root); assert.deepEqual(reads, []); return 'profile'; },
    spawn: (command, dir, profile) => { spawned++; assert.equal(profile, 'profile'); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); setImmediate(() => { child.stdout.write('ok'); child.emit('close', 0, null); }); return child; },
  }, killTree: (child, signal) => kills.push(signal) };
  const box = new WorkspaceSandbox({ readFiles: [] }, { platform: p, workspace: () => root });
  fs.symlinkSync(path.dirname(root), path.join(root, 'outside'));
  assert.throws(() => box.run('fixture'), { code: 'command_link_not_allowed', status: 403 }); assert.equal(spawned, 0);
  fs.unlinkSync(path.join(root, 'outside'));
  assert.deepEqual(await box.run('fixture'), { code: 0, signal: null, stdout: 'ok', stderr: '', truncated: false });
  assert.equal(spawned, 1); assert.deepEqual(kills, ['SIGKILL']); assert.equal(box.children.size, 0);
  const profile = createDarwin().commandSandbox.profile(root, ['/fixture/read']);
  assert.match(profile, /deny default/); assert.match(profile, /deny file-read\* file-write\*/); assert.match(profile, /\.git/); assert.match(profile, /literal "\/fixture\/read"/);
});

test('secret storage keeps private payloads in stdin and preserves unavailable errors', () => {
  let invocation;
  const p = createDarwin({ fs: { existsSync: () => false }, execFileSync: (...args) => { invocation = args; return '{"value":"stored","seconds":42}'; } });
  const secret = p.secretStore(); secret.put('account', 'private-value');
  assert.equal(invocation[0], '/usr/bin/swift'); assert.match(invocation[1][0], /license\/mac-native.swift$/);
  assert.equal(invocation[1].includes('private-value'), false); assert.equal(invocation[2].input, '{"action":"put","account":"account","value":"private-value"}');
  assert.deepEqual(invocation[2].stdio, ['pipe', 'pipe', 'pipe']); assert.equal(secret.get('account'), 'stored'); assert.equal(secret.elapsed(), 42);
  assert.throws(() => createDarwin({ execFileSync: () => '{}' }).secretStore().elapsed(), /elapsed_clock_unavailable/);
  assert.throws(() => createDarwin({ execFileSync: () => { throw Error('private'); } }).secretStore().get('account'), /^Error: secret_store_unavailable$/);
});

test('native attachment extraction retains PDF script and resource limits', async () => {
  const calls = []; const run = async (...args) => { calls.push(args); return { stdout: 'text' }; };
  const p = createDarwin({ execFileSync: (...args) => calls.push(args) });
  assert.equal(await p.readPdfText('/input.pdf', run), 'text');
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', p.PDF_SCRIPT, '/input.pdf']]);
  assert.deepEqual(calls[0][2], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(p.PDF_SCRIPT, /doc.isEncrypted/); assert.match(p.PDF_SCRIPT, /500001/);
  p.convertImage('/input.heic', '/output.png');
  assert.deepEqual(calls[1], ['/usr/bin/sips', ['-s', 'format', 'png', '/input.heic', '--out', '/output.png'], { timeout: 15000, stdio: 'pipe' }]);
  const opts = { timeout: 5, encoding: 'buffer' }; await p.readArchive(['-p', '/a', 'entry'], opts, run);
  assert.deepEqual(calls[2], ['/usr/bin/unzip', ['-p', '/a', 'entry'], opts]);
});

test('updater native primitives preserve argv and running-app quarantine approval', async () => {
  const calls = []; const run = async (...args) => { calls.push(args); return args[0] === '/usr/bin/plutil' ? '{"CFBundleIdentifier":"local.projecthub"}' : 'arm64'; };
  let flags = '0040;';
  const p = createDarwin({ execFileSync: (file, args) => args[0] === '-p' ? flags : 'com.apple.quarantine\n' });
  const u = p.appUpdater, env = { env: { FIXTURE: '1' } };
  assert.equal(u.hasQuarantine('/app'), true);
  assert.equal(u.quarantineApproved('/app'), true); flags = '0001;'; assert.equal(u.quarantineApproved('/app'), false); flags = 'bad!'; assert.equal(u.quarantineApproved('/app'), false);
  await u.buildShell('/hub', env, run); await u.verify('/app', env, run); await u.verify('/app', undefined, run, true);
  assert.equal((await u.bundlePlist('/app', run)).CFBundleIdentifier, 'local.projecthub');
  await u.attachDmg('/dmg', '/mount', run); await u.copyApp('/from', '/to', run); await u.detachDmg('/mount', ['-force'], run);
  assert.deepEqual(calls, [
    ['/bin/bash', ['/hub/app/build-app.sh'], env], ['codesign', ['--verify', '--deep', '--strict', '/app'], env],
    ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '/app']],
    ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', '/app/Contents/Info.plist']],
    ['/usr/bin/hdiutil', ['attach', '/dmg', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', '/mount']],
    ['/usr/bin/ditto', ['/from', '/to']], ['/usr/bin/hdiutil', ['detach', '/mount', '-force']],
  ]);
});

test('document conversion uses only verified bytes on stdin and rejects invalid output', async () => {
  const input = Buffer.from('verified bytes'), calls = []; let error = null, output = '<html>fixture</html>';
  const p = createDarwin({ execFile: (file, args, options, callback) => {
    const stdin = new PassThrough(), chunks = [];
    stdin.on('data', data => chunks.push(data));
    stdin.on('end', () => { calls.push({ file, args, options, input: Buffer.concat(chunks) }); callback(error, output); });
    return { stdin };
  } });
  assert.equal(await p.convertDocument(input, 'docx'), output);
  assert.deepEqual(calls[0], { file: '/usr/bin/textutil', args: ['-convert', 'html', '-noload', '-nostore', '-stdout', '-encoding', 'UTF-8', '-format', 'docx', '-stdin'], options: { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, input });
  output = ''; await assert.rejects(p.convertDocument(input, 'doc'), /invalid document output/);
  error = Object.assign(Error('timeout'), { killed: true });
  await assert.rejects(p.convertDocument(input, 'rtf'), { killed: true });
});

test('image metadata and idea previews retain decoder limits', () => {
  const calls = [], p = createDarwin({ execFileSync: (...args) => { calls.push(args); return 'pixelWidth: 2\npixelHeight: 3'; } });
  assert.match(p.imageInfo('/input.png'), /pixelWidth/);
  const options = { timeout: 15000, maxBuffer: 65536, stdio: 'pipe' };
  p.convertImage('/input.png', '/preview.png', options);
  assert.deepEqual(calls, [
    ['/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '/input.png'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }],
    ['/usr/bin/sips', ['-s', 'format', 'png', '/input.png', '--out', '/preview.png'], options],
  ]);
});

test('unsupported platforms fail closed without spawning native commands', async () => {
  let calls = 0;
  const p = createDarwin({ name: 'unsupported-test', execFile: () => calls++, execFileSync: () => calls++, spawn: () => calls++ });
  assert.equal(p.commandSandbox.available(), false); assert.equal(p.appUpdater.sourceSupported(), false); assert.equal(p.appUpdater.packagedSupported('arm64'), false);
  await assert.rejects(p.openPath('/a'), { code: 'platform_unsupported' }); await assert.rejects(p.pickFolder(), { code: 'platform_unsupported' });
  await assert.rejects(p.focusTerminal(42), { code: 'platform_unsupported' });
  await assert.rejects(p.listProcesses(), { code: 'platform_unsupported' });
  await assert.rejects(p.readPdfText('/a.pdf'), { code: 'platform_unsupported' });
  assert.throws(() => p.secretStore().get('account'), /secret_store_unavailable/); assert.equal(p.secretStore().watchResume(() => {}), null);
  assert.throws(() => p.machineHint(), /machine_hint_unavailable/);
  assert.throws(() => p.convertDocument(Buffer.from('fixture'), 'doc'), { code: 'platform_unsupported' });
  assert.equal(calls, 0);
});
