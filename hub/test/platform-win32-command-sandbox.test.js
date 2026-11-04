'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { create } = require('../lib/platform/win32');
const { limitScript, PROFILE, PASSTHROUGH, SECRET_GLOBS } = require('../lib/platform/win32-command-sandbox');
const { WorkspaceSandbox } = require('../lib/workspace-sandbox');
const NPM = 'C:\\Users\\fixture\\AppData\\Roaming\\npm', SHIM = NPM + '\\codex.cmd', PACKAGE = path.win32.join(NPM, 'node_modules', '@openai', 'codex');
const MANIFEST = path.win32.join(PACKAGE, 'package.json'), BASH = 'C:\\Program Files\\Git\\bin\\bash.exe', TIMEOUT = 'C:\\Program Files\\Git\\usr\\bin\\timeout.exe', ROOT = 'C:\\Users\\fixture\\Work\\P\\child';
const CODEX = path.win32.join(PACKAGE, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const HOISTED = path.win32.join(NPM, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
const ENV = { PATH: 'C:\\Tools;' + NPM, PATHEXT: '.COM;.EXE;.BAT;.CMD', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\fixture',
  CODEX_HOME: 'C:\\Users\\fixture\\.codex', HUB_TOKEN: 'private', HUB_ROOT: 'private', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private', NODE_OPTIONS: 'private', HOME: 'private', TEMP: 'private' };
const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
// Fixture filesystem: the named files exist, the manifest has the given text. No disk access, no native call.
// The adapter is built the way win32.js builds it, with the diagnostic lookups exposed for assertions.
function adapter(files, text = {}) {
  const io = { statSync: file => files.has(file) ? { isFile: () => true, isDirectory: () => false } : missing(), readFileSync: file => file in text ? text[file] : missing(), realpathSync: Object.assign(file => file, { native: file => file }) };
  const platform = create({ native: { call() { assert.fail('native side effect'); } }, fs: io, env: ENV });
  const box = require('../lib/platform/win32-command-sandbox').create({ fs: io, env: ENV, findExecutable: platform.findExecutable, shellCandidates: platform.shellCandidates });
  assert.equal(platform.commandSandbox.available(), box.available());
  return box;
}
const installed = (manifest = '{"name":"@openai/codex","version":"0.164.0"}') => adapter(new Set([SHIM, CODEX, BASH, TIMEOUT]), { [MANIFEST]: manifest });
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.pid = 4242; child.kills = [];
  child.kill = signal => { child.kills.push(signal); if (child.exitCode === null) { child.exitCode = null; child.signalCode = signal; setImmediate(() => child.emit('close', null, signal)); } return child.signalCode === signal && child.kills.length === 1; };
  child.finish = (code, text) => setImmediate(() => { child.stdout.write(text); child.exitCode = code; child.emit('close', code, null); });
  return child;
}

test('Windows command isolation needs the vendored Codex CLI and Git for Windows, and refuses to spawn without them', () => {
  const none = adapter(new Set());
  assert.equal(none.available(), false);
  const profile = none.profile(ROOT, []);
  assert.throws(() => none.spawn('fixture', ROOT, profile, () => assert.fail('spawned')), e => e.code === 'command_sandbox_unavailable' && /Codex CLI/.test(e.message) && /Git for Windows/.test(e.message));
  assert.equal(adapter(new Set([BASH])).available(), false);
  assert.equal(adapter(new Set([SHIM, CODEX, TIMEOUT]), { [MANIFEST]: '{"name":"@openai/codex"}' }).available(), false, 'bash missing');
  assert.equal(adapter(new Set([SHIM, CODEX, BASH]), { [MANIFEST]: '{"name":"@openai/codex"}' }).available(), false, 'coreutils timeout missing');
  assert.equal(adapter(new Set([SHIM, BASH, TIMEOUT]), { [MANIFEST]: '{"name":"@openai/codex"}' }).available(), false, 'shim without the native binary');
  assert.equal(adapter(new Set([SHIM, CODEX, BASH, TIMEOUT]), { [MANIFEST]: '{"name":"other"}' }).available(), false, 'foreign codex.cmd');
  assert.equal(adapter(new Set([SHIM, CODEX, BASH, TIMEOUT])).available(), false, 'unreadable manifest');
  assert.equal(adapter(new Set([NPM + '\\codex.bat', CODEX, BASH, TIMEOUT])).available(), false, 'batch shim is never expanded');
  assert.equal(installed().available(), true);
  assert.equal(installed().codexExecutable(), CODEX); assert.equal(installed().shell(), BASH); assert.equal(installed().timeoutExecutable(), TIMEOUT);
  const sibling = require('../lib/platform/win32-command-sandbox').create({ fs: { statSync: file => ['C:\\Tools\\codex.exe', 'C:\\Tools\\bash.exe', 'C:\\Tools\\timeout.exe'].includes(file) ? { isFile: () => true } : missing() }, env: ENV, findExecutable: () => 'C:\\Tools\\codex.exe', shellCandidates: () => ['C:\\Tools\\bash.exe'] });
  assert.equal(sibling.timeoutExecutable(), 'C:\\Tools\\timeout.exe', 'timeout.exe beside the shell');
  assert.equal(adapter(new Set([SHIM, HOISTED, BASH]), { [MANIFEST]: '{"name":"@openai/codex"}' }).codexExecutable(), HOISTED, 'hoisted platform package');
  assert.equal(adapter(new Set(['C:\\Tools\\codex.exe', BASH])).codexExecutable(), 'C:\\Tools\\codex.exe', 'native codex.exe on PATH is used as found');
});

test('profile grants one writable workspace, denies .git and credential files, grants outside read files and no network', () => {
  const p = installed();
  const profile = p.profile(ROOT + '\\', ['C:\\Users\\fixture\\read.txt', ROOT + '\\inside.txt', ROOT, 'C:\\Users\\fixture\\read.txt']);
  assert.equal(profile.root, ROOT); assert.deepEqual([...profile.readFiles], ['C:\\Users\\fixture\\read.txt']);
  assert.deepEqual([...profile.args], ['sandbox', '-C', ROOT, '-P', PROFILE, '--include-managed-config',
    '-c', `permissions.${PROFILE}.filesystem={":root"="read","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child"="write","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\.git"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\.git"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\.env*"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\.netrc"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\.npmrc"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\.pypirc"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\id_rsa*"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\id_ed25519*"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\id_ecdsa*"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\id_dsa*"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\*.pem"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\*.key"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\*.p12"="deny","C:\\\\Users\\\\fixture\\\\Work\\\\P\\\\child\\\\**\\\\*.pfx"="deny","C:\\\\Users\\\\fixture\\\\read.txt"="read"}`,
    '-c', `permissions.${PROFILE}.network.enabled=false`, '-c', 'windows.sandbox="elevated"']);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.args) && Object.isFrozen(profile.readFiles) && Object.isFrozen(SECRET_GLOBS));
  assert.deepEqual([...SECRET_GLOBS], ['.git', '.env*', '.netrc', '.npmrc', '.pypirc', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.pem', '*.key', '*.p12', '*.pfx']);
  assert.deepEqual([...p.profile(ROOT).args], [...p.profile(ROOT, []).args]);
  for (const root of ['', 'relative', '\\\\server\\share\\work', 'C:\\work:stream', 'C:\\work\\..\\other', 'C:\\work"', 'C:\\work\nx', 'C:\\work\0', '/Users/work', 42, null]) {
    assert.throws(() => p.profile(root, []), { code: 'command_sandbox_path' }, JSON.stringify(root));
  }
  assert.throws(() => p.profile(ROOT, ['relative.txt']), { code: 'command_sandbox_path' }); assert.throws(() => p.profile(ROOT, 'C:\\read.txt'), { code: 'command_sandbox_path' });
});

test('spawn starts the vendored codex.exe with a fixed argv, the time limit inside the sandbox, the workspace as home and a minimal environment', () => {
  const p = installed(), calls = [], command = "cd 'C:\\Users\\fixture\\Work\\P\\child' && printf hello > local.txt; cat local.txt";
  const profile = p.profile(ROOT, []);
  const child = p.spawn(command, ROOT, profile, (file, args, options) => { calls.push({ file, args, options }); return 'child'; });
  assert.equal(child, 'child'); assert.equal(calls.length, 1); assert.equal(calls[0].file, CODEX);
  assert.deepEqual(calls[0].args, [...profile.args, '--', BASH, '-c', command]);
  const { options } = calls[0];
  assert.equal(options.cwd, ROOT); assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']); assert.equal(options.detached, undefined); assert.equal(options.shell, undefined);
  assert.deepEqual(Object.keys(options.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'PATHEXT', 'ProgramFiles', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']);
  assert.equal(options.env.HOME, ROOT); assert.equal(options.env.TEMP, ROOT); assert.equal(options.env.TMP, ROOT); assert.equal(options.env.CODEX_HOME, ENV.CODEX_HOME);
  assert.deepEqual(options.env.PATH.split(';'), ['C:\\Windows\\System32', 'C:\\Program Files\\Git\\bin', path.dirname(process.execPath)]);
  assert.equal(JSON.stringify(calls).includes('private'), false); assert.ok(PASSTHROUGH.every(key => !/^HUB_|KEY$|TOKEN$/i.test(key)));
  // Hub's time limit, rounded up to whole seconds, is applied inside the shell by coreutils timeout, the command passed verbatim as $0; no limit, no wrapper.
  assert.equal(limitScript(120000), 'exec /usr/bin/timeout --kill-after=2 120s /usr/bin/bash -c "$0"'); assert.equal(limitScript(50), 'exec /usr/bin/timeout --kill-after=2 1s /usr/bin/bash -c "$0"');
  const limited = [];
  for (const options of [{ timeoutMs: 120000 }, { timeoutMs: 50 }, { timeoutMs: 0 }, { timeoutMs: 'soon' }, undefined]) p.spawn(command, ROOT, profile, (file, args) => { limited.push(args.slice(profile.args.length)); return 'child'; }, options);
  assert.deepEqual(limited, [['--', BASH, '-c', limitScript(120000), command], ['--', BASH, '-c', limitScript(50), command], ['--', BASH, '-c', command], ['--', BASH, '-c', command], ['--', BASH, '-c', command]]);
  const direct = adapter(new Set(['C:\\Tools\\codex.exe', BASH, TIMEOUT])), used = [];
  direct.spawn('fixture', ROOT, direct.profile(ROOT, []), file => { used.push(file); return 'child'; }); assert.deepEqual(used, ['C:\\Tools\\codex.exe']);
  // Empty commands and profiles for another workspace never reach Codex.
  const never = () => assert.fail('spawned');
  assert.throws(() => p.spawn('', ROOT, profile, never), { code: 'command_sandbox_command' }); assert.throws(() => p.spawn('a\0b', ROOT, profile, never), { code: 'command_sandbox_command' });
  assert.throws(() => p.spawn('fixture', 'C:\\other', profile, never), { code: 'command_sandbox_profile' }); assert.throws(() => p.spawn('fixture', ROOT, 'profile', never), { code: 'command_sandbox_profile' });
  assert.throws(() => p.spawn('fixture', ROOT, { ...profile, args: profile.args.join(' ') }, never), { code: 'command_sandbox_profile' });
  assert.throws(() => p.spawn('fixture', 'relative', profile, never), { code: 'command_sandbox_path' });
});

test('WorkspaceSandbox signals the direct child when killTree refuses an exited or unverifiable Windows child', async () => {
  const refusals = [];
  const platform = { name: 'win32', commandSandbox: { available: () => true, profile: () => 'profile', spawn: (command, root, profile, spawnProcess) => spawnProcess(command) },
    killTree: child => { refusals.push(child.exitCode); throw Error('Windowsの起動した子プロセスを確認できません'); } };
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-win32-box-'));
  try {
    let child = fakeChild();
    const box = new WorkspaceSandbox({ readFiles: [] }, { platform, workspace: () => root, spawn: () => child, timeoutMs: 50 });
    const done = box.run('fixture'); child.finish(0, 'ok');
    assert.deepEqual(await done, { code: 0, signal: null, stdout: 'ok', stderr: '', truncated: false });
    assert.deepEqual(child.kills, ['SIGKILL']); assert.deepEqual(refusals, [0]); assert.equal(box.children.size, 0);
    child = fakeChild();
    const timeout = await box.run('fixture');
    assert.equal(timeout.signal, 'SIGKILL'); assert.equal(timeout.code, null); assert.deepEqual(child.kills, ['SIGKILL', 'SIGKILL']); assert.equal(box.children.size, 0);
    child = fakeChild(); box.run('fixture'); box.stop(); assert.deepEqual(child.kills, ['SIGKILL']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WorkspaceSandbox on Windows runs through the Codex adapter with the real workspace path', { skip: process.platform !== 'win32' && 'Windows paths only' }, async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-win32-box-')), calls = [];
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'fixture');
    const platform = { ...create({ native: { call() { assert.fail('native side effect'); } }, fs: { statSync: file => [SHIM, CODEX, BASH, TIMEOUT].includes(file) ? { isFile: () => true } : missing(), readFileSync: file => file === MANIFEST ? '{"name":"@openai/codex"}' : missing() }, env: ENV }), killTree: () => { throw Error('exited'); } };
    const child = fakeChild();
    const box = new WorkspaceSandbox({ readFiles: [] }, { platform, workspace: () => root, spawn: (file, args, options) => { calls.push({ file, args, options }); return child; }, timeoutMs: 45000 });
    const done = box.run('printf hello'); child.finish(0, 'hello');
    assert.deepEqual(await done, { code: 0, signal: null, stdout: 'hello', stderr: '', truncated: false });
    assert.equal(calls[0].file, CODEX); assert.deepEqual(calls[0].args.slice(-5), ['--', BASH, '-c', limitScript(45000), 'printf hello']);
    assert.deepEqual(calls[0].args.slice(0, 3), ['sandbox', '-C', root]); assert.equal(calls[0].options.cwd, root); assert.equal(calls[0].options.env.HOME, root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Real Git for Windows, no Codex: the shell tail of the sandbox argv and its
// environment run the ChatGPT command wrapper against a Windows workspace path.
test('Git for Windows runs the ChatGPT command wrapper with the sandbox shell environment', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
  const p = require('../lib/platform').forPlatform('win32').commandSandbox;
  if (!p.available()) return t.skip('Codex CLI と Git for Windows が揃っていないため、この実機確認は未実施');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-win32-shell-')), calls = [];
  try {
    const cwd = path.join(root, "it's here"); fs.mkdirSync(cwd);
    const command = 'cd ' + "'" + cwd.replaceAll("'", "'\\''") + "'" + ' && printf hello > local.txt; cat local.txt; (cd "$HOME" && pwd -W) > "$HOME/home.txt"';
    p.spawn(command, root, p.profile(root, []), (file, args, options) => { calls.push({ file, args, options }); return fakeChild(); }, { timeoutMs: 20000 });
    const [, bash, flag, script, tail] = calls[0].args.slice(-5);
    assert.equal(flag, '-c'); assert.equal(script, limitScript(20000)); assert.equal(tail, command); assert.match(bash, /\\bash\.exe$/);
    const result = spawnSync(bash, [flag, script, tail], { cwd: calls[0].options.cwd, env: calls[0].options.env, encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'hello');
    assert.equal(fs.readFileSync(path.join(cwd, 'local.txt'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(root, 'home.txt'), 'utf8').trim().replace(/\//g, '\\').toLowerCase(), root.toLowerCase());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Real Git for Windows, no Codex: at the limit the whole process group of the
// command ends, including a Git Bash child, a native Node child and a shell
// ignoring TERM, which would otherwise outlive Hub's termination of codex.exe.
test('the time limit inside the sandbox ends the command with its process group', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
  const p = require('../lib/platform').forPlatform('win32').commandSandbox;
  if (!p.available()) return t.skip('Codex CLI と Git for Windows が揃っていないため、この実機確認は未実施');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-win32-limit-'));
  try {
    for (const command of ['echo started; sleep 30 & node -e "setTimeout(() => {}, 30000)" & wait; echo finished', 'echo started; trap "" TERM; sleep 30; echo finished']) {
      const calls = [];
      p.spawn(command, root, p.profile(root, []), (file, args, options) => { calls.push({ file, args, options }); return fakeChild(); }, { timeoutMs: 1000 });
      const [bash, ...tail] = calls[0].args.slice(-4);
      assert.deepEqual(tail, ['-c', limitScript(1000), command]);
      const started = Date.now();
      // spawnSync returns only once every holder of the output pipes has exited.
      const result = spawnSync(bash, tail, { cwd: calls[0].options.cwd, env: calls[0].options.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(result.error, undefined, 'a sandboxed child outlived the limit: ' + command); assert.ok(Date.now() - started < 10000, 'ended at the limit, not at the sleep');
      assert.notEqual(result.status, 0); assert.equal(result.stdout.trim(), 'started');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
