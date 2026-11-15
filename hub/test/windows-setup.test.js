'use strict';
// Real inventory/copy checks in temporary folders. Windows APIs are injected;
// this suite is deliberately NOT a Windows Start menu launch acceptance test.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { install, bridge, powershell } = require('../release-app/install-windows.cjs');
const { verify } = require('../release-app/finalize-windows.cjs');
const names = require('../release-app/windows-window.cjs').names;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '配布 & source'), local = path.join(root, '利用者 local'), programs = path.join(root, 'start menu');
  for (const p of [base, local, programs]) fs.mkdirSync(p);
  const manifest = { version: 1, kind: 'public-release', platform: 'win32', arch: 'x64', port: 4545, shellProtocol: 1, source: 'a'.repeat(40), releaseVersion: '4.126.99', windowsNativePrepared: true, files: [] };
  function put(relative, data) {
    const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); fs.chmodSync(file, 0o644);
    manifest.files.push({ path: relative, bytes: Buffer.byteLength(data), sha256: sha(data), mode: 0o644 });
  }
  for (const n of ['START-WINDOWS.cmd', 'SETUP-WINDOWS.cmd', 'hub/app/windows/ProjectHub.ico', 'hub/server.js', 'hub/release-app/core.cjs', 'hub/release-app/protocol.cjs', 'hub/release-app/runtime.cjs', 'hub/release-app/license.cjs', 'hub/release-app/launch.cjs', 'hub/paid-bundle.json', ...names.map(n => 'window/' + n)]) put(n, 'fixture ' + n);
  for (let i = 0; i < 101; i++) put('hub/fixture-' + i + '.txt', 'fixture ' + i);
  const save = () => fs.writeFileSync(path.join(base, 'release-manifest.json'), JSON.stringify(manifest)); save();
  const data = path.join(root, 'existing-data'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'conversation'), 'keep');
  const destination = path.join(local, 'Programs/Project Hub', manifest.releaseVersion), shortcut = path.join(programs, 'Project Hub.lnk');
  const calls = [], state = { before: null, accept: true };
  const call = r => {
    calls.push(r);
    if (r.action === 'environment') return { local, programs, elevated: false };
    if (r.action === 'prerequisites') return { webview2: '157.0' };
    if (r.action === 'read') return { link: state.before };
    if (r.action === 'confirm') return { accepted: state.accept };
    if (r.action === 'message') return { shown: true };
    if (r.action === 'write') {
      assert.ok(fs.existsSync(path.join(destination, 'release-manifest.json')));
      state.before = { target: r.target, workingDirectory: r.workingDirectory, icon: r.icon, arguments: '', sha256: 'b'.repeat(64) };
      return { link: state.before };
    }
    assert.fail('unknown Windows action');
  };
  const options = { base, platform: 'win32', arch: 'x64', release: '10.0.26300', nodeVersion: '24.22.0', call, git: () => 'git version 2.56.0.windows.1' };
  return { root, base, local, programs, data, destination, shortcut, manifest, put, save, calls, state, options, call };
}
function snap(root) {
  const result = {};
  function walk(dir, prefix = '') {
    for (const n of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, n), rel = prefix + n;
      if (fs.lstatSync(file).isDirectory()) walk(file, rel + '/');
      else result[rel] = sha(fs.readFileSync(file));
    }
  }
  walk(root); return result;
}
test('finished tree is copied intact, shortcut uses canonical CMD/working directory/icon, and rerun reuses without rewriting', t => {
  const f = fixture(t), source = snap(f.base), data = snap(f.data), result = install(f.options);
  assert.deepEqual(snap(f.destination), source); assert.deepEqual(snap(f.base), source); assert.deepEqual(snap(f.data), data);
  assert.equal(result.files, Object.keys(source).length); assert.equal(result.startMenuLaunchVerified, false); assert.equal(result.applicationLaunched, false);
  assert.equal(result.target, path.join(f.destination, 'START-WINDOWS.cmd')); assert.equal(result.workingDirectory, f.destination);
  assert.equal(result.icon, path.join(f.destination, 'hub/app/windows/ProjectHub.ico') + ',0');
  assert.match(f.calls.at(-1).text, /次回からスタートメニューのProject Hubで起動できます/);
  assert.equal(verify(f.destination).manifest.windowsNativePrepared, true);
  const times = verify(f.destination).actual.map(r => fs.statSync(path.join(f.destination, r.path)).mtimeMs);
  install(f.options);
  assert.deepEqual(verify(f.destination).actual.map(r => fs.statSync(path.join(f.destination, r.path)).mtimeMs), times);
  assert.equal(f.calls.filter(r => r.action === 'write').length, 1);
});
for (const fault of ['win10', 'arm64', 'mac', 'old-node', 'unknown-os', 'elevated', 'powershell', 'git', 'webview', 'unfinished', 'changed', 'extra', 'link', 'hardlink', 'case-alias', 'backslash', 'ads', 'device']) test('refuses ' + fault + ' before installing or registering', t => {
  const f = fixture(t);
  if (fault === 'win10') f.options.release = '10.0.19045';
  if (fault === 'unknown-os') f.options.release = 'unknown';
  if (fault === 'arm64') f.options.arch = 'arm64';
  if (fault === 'mac') f.options.platform = 'darwin';
  if (fault === 'old-node') f.options.nodeVersion = '22.12.0';
  if (fault === 'elevated') f.options.call = r => r.action === 'environment' ? { local: f.local, programs: f.programs, elevated: true } : f.call(r);
  if (fault === 'powershell') f.options.call = () => { throw Error('unavailable'); };
  if (fault === 'git') f.options.git = () => { throw Error('missing git'); };
  if (fault === 'webview') f.options.call = r => { if (r.action === 'prerequisites') throw Error('missing runtime'); return f.call(r); };
  if (fault === 'unfinished') { f.manifest.windowsNativePrepared = false; f.save(); }
  if (fault === 'changed') fs.appendFileSync(path.join(f.base, 'hub/server.js'), 'changed');
  if (fault === 'extra') fs.writeFileSync(path.join(f.base, 'extra.txt'), 'extra');
  if (fault === 'link') { fs.unlinkSync(path.join(f.base, 'START-WINDOWS.cmd')); fs.symlinkSync(path.join(f.base, 'SETUP-WINDOWS.cmd'), path.join(f.base, 'START-WINDOWS.cmd')); }
  if (fault === 'hardlink') fs.linkSync(path.join(f.base, 'START-WINDOWS.cmd'), path.join(f.root, 'alias'));
  if (fault === 'case-alias') { f.put('hub/SERVER.js', 'alias'); f.save(); }
  if (fault === 'backslash') { f.put('hub/back\\slash', 'alias'); f.save(); }
  if (fault === 'ads') { f.put('hub/name:stream', 'alias'); f.save(); }
  if (fault === 'device') { f.put('hub/NUL.txt', 'alias'); f.save(); }
  assert.throws(() => install(f.options));
  assert.equal(fs.existsSync(f.destination), false); assert.equal(f.calls.some(r => r.action === 'write'), false); assert.equal(f.calls.some(r => r.action === 'message'), false);
  assert.equal(fs.readFileSync(path.join(f.data, 'conversation'), 'utf8'), 'keep');
});
test('different existing destination is retained byte-for-byte and no shortcut is changed', t => {
  const f = fixture(t); fs.mkdirSync(f.destination, { recursive: true }); fs.writeFileSync(path.join(f.destination, 'keep'), 'existing');
  const before = snap(f.destination); assert.throws(() => install(f.options), { code: 'destination' });
  assert.deepEqual(snap(f.destination), before); assert.equal(f.calls.some(r => r.action === 'write'), false);
});
test('same manifest but changed destination is not reused', t => {
  const f = fixture(t); fs.cpSync(f.base, f.destination, { recursive: true }); fs.appendFileSync(path.join(f.destination, 'START-WINDOWS.cmd'), 'changed');
  const before = snap(f.destination); assert.throws(() => install(f.options), { code: 'destination' }); assert.deepEqual(snap(f.destination), before);
});
test('copy failure keeps the new stage, never registers a partial install or removes existing data', t => {
  const f = fixture(t); let count = 0;
  f.options.copy = (...args) => { if (++count === 3) throw Error('disk full'); return fs.copyFileSync(...args); };
  assert.throws(() => install(f.options)); assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.readdirSync(path.dirname(f.destination)).filter(n => n.startsWith('.setup-')).length, 1);
  assert.equal(f.calls.some(r => r.action === 'write'), false);
});
for (const answer of [false, true]) test('switch of verified prior fixed install requires owner confirmation: ' + answer, t => {
  const f = fixture(t), prior = path.join(path.dirname(f.destination), '4.126.98'); fs.cpSync(f.base, prior, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(prior, 'release-manifest.json'))); m.releaseVersion = '4.126.98'; fs.writeFileSync(path.join(prior, 'release-manifest.json'), JSON.stringify(m));
  const image = snap(prior); f.state.before = { target: path.join(prior, 'START-WINDOWS.cmd'), workingDirectory: prior, icon: 'old icon', arguments: '', sha256: 'a'.repeat(64) }; f.state.accept = answer;
  if (answer) { install(f.options); assert.equal(f.calls.filter(r => r.action === 'write').length, 1); }
  else { assert.throws(() => install(f.options), { code: 'cancelled' }); assert.equal(fs.existsSync(f.destination), false); }
  assert.equal(f.calls.filter(r => r.action === 'confirm').length, 1); assert.deepEqual(snap(prior), image);
});
test('foreign shortcut and downgrade are refused without an overwrite prompt', t => {
  const f = fixture(t); f.state.before = { target: path.join(f.root, 'other.exe'), workingDirectory: f.root, arguments: '', icon: '' };
  assert.throws(() => install(f.options), { code: 'shortcut' }); assert.equal(f.calls.some(r => r.action === 'confirm'), false); assert.equal(fs.existsSync(f.destination), false);
  const newer = path.join(path.dirname(f.destination), '4.127.0'); fs.cpSync(f.base, newer, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(newer, 'release-manifest.json'))); m.releaseVersion = '4.127.0'; fs.writeFileSync(path.join(newer, 'release-manifest.json'), JSON.stringify(m));
  f.state.before = { target: path.join(newer, 'START-WINDOWS.cmd'), workingDirectory: newer, arguments: '' };
  assert.throws(() => install(f.options), { code: 'shortcut' }); assert.equal(f.calls.some(r => r.action === 'confirm'), false);
});
test('shortcut failure retains complete install and never displays success', t => {
  const f = fixture(t); f.options.call = r => { if (r.action === 'write') throw Error('COM failure'); return f.call(r); };
  assert.throws(() => install(f.options), { code: 'shortcut' }); assert.deepEqual(snap(f.destination), snap(f.base)); assert.equal(f.calls.some(r => r.action === 'message'), false);
});
test('PowerShell bridge uses fixed Unicode source and JSON input, never string interpolation or execution-policy changes', () => {
  let count = 0;
  const call = bridge({ SystemRoot: 'C:\\Windows' }, (file, args, options) => {
    count++; assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.shell, false); assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), powershell);
    assert.equal(JSON.parse(options.input).text, '日本語 & $();'); assert.equal(args.some(a => /Bypass|RunAs|ExecutionPolicy/.test(a)), false);
    return '{"shown":true}';
  });
  assert.deepEqual(call({ action: 'message', text: '日本語 & $();' }), { shown: true }); assert.equal(count, 1);
  assert.match(powershell, /\.TargetPath=\$r.target/); assert.match(powershell, /\.WorkingDirectory=\$r.workingDirectory/); assert.match(powershell, /\.IconLocation=\$r.icon/);
  assert.match(powershell, /\[IO.File\]::Move/); assert.match(powershell, /shortcut_changed/);
});
