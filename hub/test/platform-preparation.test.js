'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const platforms = require('../lib/platform'), P = require('../lib/owned-processes');
// Contract fixtures only. No Windows commands, SID lookup, or Windows backend.
const owner = 'S-1-5-21-100-200-300-1001';
const adapter = { processOwner: row => row?.owner, currentProcessOwner: () => owner, isExternalTerminal: command => command === 'terminal' };
const identity = { pid: 991234, ppid: 1, owner, since: '20261018010000.123456+000', command: 'C:\\Tools\\node.exe' };

test('native owner boundary accepts a nonempty OS identity without a POSIX UID', () => {
  assert.equal(P.capture(identity.pid, [identity], adapter), identity);
  assert.equal(P.same(identity, { ...identity }, adapter), true);
  for (const key of ['pid', 'owner', 'since', 'command', 'pgid']) {
    const value = key === 'pid' || key === 'pgid' ? 991235 : 'changed';
    assert.equal(P.same(identity, { ...identity, [key]: value }, adapter), false, key);
  }
  for (const value of [undefined, null, '', ' ', 'S-1-5-21-foreign']) {
    assert.throws(() => P.capture(identity.pid, [{ ...identity, owner: value }], adapter), /所有を確認できません/);
  }
  for (const key of ['since', 'command']) for (const value of [undefined, '', ' ']) {
    assert.throws(() => P.capture(identity.pid, [{ ...identity, [key]: value }], adapter), /所有を確認できません/);
  }
  assert.equal(P.same({ ...identity, owner: '' }, { ...identity, owner: '' }, adapter), false);
  assert.throws(() => P.capture(process.pid, [{ ...identity, pid: process.pid }], adapter), /所有を確認できません/);
});

test('owned descendants retain owner, start, executable and a fresh check before each signal', () => {
  const child = { ...identity, pid: 991235, ppid: identity.pid }, foreign = { ...child, pid: 991236, owner: 'foreign' };
  const blank = { ...child, pid: 991237, owner: '' }, unknown = { ...child, pid: 991238, since: '' };
  let rows = [child, identity, foreign, blank, unknown], signals = [];
  const owned = new P.OwnedProcesses(identity, { platform: adapter, scan: () => rows, kill: (...args) => signals.push(args) });
  assert.deepEqual(owned.collect().map(p => p.pid).sort(), [identity.pid, child.pid]);
  rows = [{ ...child, ppid: 1 }, identity];
  assert.equal(owned.collect().length, 2);
  assert.equal(owned.signal('SIGTERM').length, 2);
  assert.deepEqual(signals, [[child.pid, 'SIGTERM'], [identity.pid, 'SIGTERM']]);
  signals = []; rows = [{ ...child, since: 'reused' }, identity];
  assert.throws(() => owned.signal('SIGKILL'), /識別が変わった/); assert.deepEqual(signals, []);
  let scans = 0;
  const raced = new P.OwnedProcesses(identity, { platform: adapter, scan: () => [++scans === 1 ? identity : { ...identity, owner: 'foreign' }], kill: () => assert.fail('changed owner') });
  assert.deepEqual(raced.signal('SIGTERM'), [{ pid: identity.pid, state: 'identity-changed' }]);
  assert.throws(() => new P.OwnedProcesses({ ...identity, owner: '' }, { platform: adapter, scan: () => [] }).collect(), /所有を確認できません/);
});

test('external ancestry uses the OS owner boundary and rejects unknown owners', () => {
  const terminal = { ...identity, pid: 991233, ppid: 1, command: 'terminal' }, row = { ...identity, ppid: terminal.pid, since: '2026-10-18T01:00:00Z' };
  assert.equal(P.independentExternal(row, [row, terminal], () => false, adapter), true);
  assert.equal(P.independentExternal(row, [row, { ...terminal, owner: '' }], () => false, adapter), false);
  assert.equal(P.independentExternal(row, [row, terminal], pid => pid === terminal.pid, adapter), false);
});

test('Darwin and existing Linux ownership retain numeric UID and process-group identity', () => {
  const row = { ...identity, uid: process.getuid(), pgid: identity.pid };
  for (const name of ['darwin', 'linux']) {
    const p = platforms.forPlatform(name);
    assert.equal(p.currentProcessOwner(), process.getuid()); assert.equal(p.processOwner(row), process.getuid());
    assert.equal(P.capture(row.pid, [row], p), row); assert.equal(P.same(row, { ...row }, p), true);
    assert.equal(P.same(row, { ...row, pgid: row.pgid + 1 }, p), false);
    assert.equal(P.same({ ...row, uid: undefined }, { ...row, uid: undefined }, p), false);
  }
  const root = { ...row, uid: 0 }, p = { processOwner: r => r?.uid, currentProcessOwner: () => 0 };
  assert.equal(P.capture(root.pid, [root], p), root);
  assert.throws(() => platforms.createDarwin({ name: 'win32' }).currentProcessOwner(), { code: 'platform_unsupported' });
  assert.deepEqual(platforms.supervisorFiles, ['index.js', 'darwin.js', 'persistence.js', 'file-io.js']); assert.equal(Object.isFrozen(platforms.supervisorFiles), true);
});

test('unsupported OS licensing blocks paid operations without reading keys, writing or sending', async () => {
  const { License } = require('../lib/license'), { PAID } = require('../lib/license/codec');
  const unexpected = () => assert.fail('unavailable licensing must have no side effects');
  const license = new License({ owner: false, platform: 'unsupported-test', config: { licenseEnforcement: false, endpoint: 'https://invalid.test', trialDays: 30 },
    store: { read: unexpected, write: unexpected }, secret: { get: unexpected, put: unexpected, elapsed: unexpected, watchResume: unexpected }, fetcher: unexpected });
  const status = license.status(); assert.match(status.reason, /このOSは利用コードの対象外/); assert.doesNotMatch(status.reason, /自動で始まります/);
  assert.equal(status.supported, false); assert.equal(status.enforcement, true); assert.equal(status.features.chat_basic.allowed, true);
  for (const feature of PAID) { assert.equal(status.features[feature].allowed, false); assert.throws(() => license.require([feature]), { code: 'license_held', status: 403 }); }
  assert.doesNotThrow(() => license.require(['chat_basic']));
  assert.throws(() => license.ensureIdentity(), { code: 'license_unsupported' });
  await assert.rejects(license.activate('fixture'), { code: 'license_unsupported', status: 403 });
  await assert.rejects(license.post('/challenge', {}), { code: 'license_unsupported' });
  await assert.rejects(license.refreshTime('fixture'), { code: 'license_unsupported' });
  await license.prepare(); license.start(); assert.equal(license.timer, undefined); assert.equal(license.clock, null); license.stop();
});

test('license settings show the unavailable reason and hide registration while retaining the Mac form', () => {
  const source = require('./fixtures/app-source.cjs').readApp();
  const start = source.indexOf('<section class="pref-section" data-tab="basic"><h2 class="pref-caption">利用コード</h2>'), end = source.indexOf('<section class="pref-section"', start + 1);
  assert.ok(start > 0 && end > start);
  const render = license => vm.runInNewContext('`' + source.slice(start, end) + '`', { state: { license }, esc: String, purchase: '',
    UI: { html: x => x, template: (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? v[i] : ''), '') } });
  const html = render({ edition: 'public', supported: false, reason: 'Windowsでは未対応：ライセンスの安全な保管' });
  assert.match(html, /Windowsでは未対応/); assert.doesNotMatch(html, /<form|id="license-code"/);
  assert.match(render({ edition: 'public', reason: 'Macの状態' }), /id="license-form"/);
  assert.match(render({ edition: 'public', activationAvailable: true, reason: 'Windowsの状態' }), /id="license-form"/);
  assert.doesNotMatch(render({ edition: 'public', activationAvailable: false, reason: '受付は準備中' }), /<form|id="license-code"/);
  assert.match(render({ edition: 'owner' }), /製作者版：鍵不要・全機能・期限なし/);
});

test('Windows sandbox refusal reaches the caller as a Japanese reason before workspace access or execution', () => {
  const { WorkspaceSandbox } = require('../lib/workspace-sandbox');
  const unexpected = () => assert.fail('must stop before workspace or spawn');
  // Windows without Codex CLI and Git for Windows: nothing on the fixture PATH, no native call.
  const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
  const windows = require('../lib/platform/win32').create({ native: { call: unexpected }, fs: { statSync: missing }, env: {} });
  for (const platform of [windows, platforms.forPlatform('linux')]) {
    const sandbox = new WorkspaceSandbox({ readFiles: [] }, { platform, workspace: unexpected, spawn: unexpected });
    assert.throws(() => sandbox.run('fixture'), e => e.code === 'command_sandbox_unavailable' && e.status === 403 &&
      (platform.name === 'win32' ? /Codex CLIの隔離実行/.test(e.message) : e.message === 'command_sandbox_unavailable'));
  }
});

test('Windows source and packaged updaters refuse settings, checking, recovery and install without side effects', async t => {
  const { AppUpdate } = require('../lib/app-update'), { PackagedUpdate } = require('../lib/app-update-packaged');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'platform-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '_hub/updates'); fs.mkdirSync(home, { recursive: true });
  const stale = { phase: 'installing', pending: true, publishPending: true, reason: 'Mac state', install: { target: '/not-used' } };
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(stale)); fs.writeFileSync(path.join(home, 'settings.json'), '{"enabled":true}');
  const before = fs.readFileSync(path.join(home, 'state.json'));
  const unexpected = () => assert.fail('unavailable updates must not execute, download, guard, rename or publish');
  const options = { root, platform: 'win32', version: '4.123.15', run: unexpected, guard: unexpected, latest: unexpected, fetch: unexpected, rename: unexpected, publish: unexpected, translate: unexpected };
  for (const update of [new AppUpdate(options), new PackagedUpdate(options)]) {
    for (const method of ['settings', 'check', 'recover', 'install']) await update[method](true);
    if (update.resume) { await update.resume(); await update.advance(); await update.prepare(); await update.publishPrepared(); }
    if (update.apply) await update.apply(); update.start(); update.tick();
    const status = update.status(); assert.equal(status.supported, false); assert.equal(status.enabled, false); assert.equal(status.unsupportedReason, 'windows');
    assert.match(status.reason, /Windowsでは未対応/); assert.equal(update.applying(), false); assert.equal(update.timer, null);
  }
  assert.deepEqual(fs.readFileSync(path.join(home, 'state.json')), before); assert.equal(fs.existsSync(path.join(home, 'packaged')), false);
});

test('Windows ownership must be available before launching; POSIX launch behavior is unchanged', () => {
  const self = { ...identity, pid: process.pid };
  const p = { ...adapter, name: 'win32', processSnapshot: () => [self] };
  assert.doesNotThrow(() => P.assertLaunchOwnership(p));
  for (const rows of [[], [{ ...self, owner: '' }], [{ ...self, owner: 'foreign' }], [{ ...self, since: '' }]]) {
    assert.throws(() => P.assertLaunchOwnership({ ...p, processSnapshot: () => rows }), /AIを開始しません/);
  }
  assert.throws(() => P.assertLaunchOwnership(platforms.createDarwin({ name: 'win32' })), /所有確認に対応していません/);
  P.assertLaunchOwnership({ name: 'darwin', processSnapshot: () => assert.fail('no extra Mac probe') });
  P.assertLaunchOwnership({ name: 'linux', processSnapshot: () => assert.fail('no extra Linux probe') });
});

test('failed ownership preflight prevents conversation, supervisor and PTY launch', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'platform-prelaunch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = P.assertLaunchOwnership;
  P.assertLaunchOwnership = () => { throw Error('fixture ownership unavailable'); };
  t.after(() => { P.assertLaunchOwnership = original; });
  const options = { project: 'fixture', task: 'task', ai: 'codex', dir: root, pdir: root }, turn = { command: 'must-not-launch', args: [], stdin: '' };
  const { ChatRunner } = require('../lib/chat'), spool = require('../lib/cli-spool'), { Sessions } = require('../lib/sessions');
  const runner = new ChatRunner(); assert.throws(() => runner.run(options, turn, {}, []), /fixture ownership unavailable/); assert.equal(runner.running.size, 0);
  const runs = path.join(root, 'runs'); assert.throws(() => spool.start(runs, 'fixture', options, turn, {}, [], process.env), /fixture ownership unavailable/); assert.equal(fs.existsSync(runs), false);
  const sessions = new Sessions({ platform: { findExecutable: () => 'fixture' }, pty: { spawn: () => assert.fail('PTY launch') } });
  assert.throws(() => sessions.start({ ...options, command: 'fixture', args: [] }), /fixture ownership unavailable/); assert.equal(sessions.map.size, 0);
});
