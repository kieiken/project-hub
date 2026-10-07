'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Onboarding } = require('../lib/onboarding');
const { Store } = require('../lib/store');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-onboarding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const tools = { find: () => '', version: async () => '', status() { throw Error('catalog must not refresh'); }, refreshClaude() { throw Error('must not infer'); } };
  return new Onboarding({ root, home: path.join(root, 'home'), projects: () => store.listProjects(), terminal: () => false, tools, ...options });
}
test('fresh and unchanged seed auto-open; actual tasks, modified seed and log suppress it', t => {
  const a = fixture(t); assert.equal(a.state().auto, true);
  fs.cpSync(path.join(__dirname, '../seed'), path.join(a.root, 'Product'), { recursive: true });
  assert.equal(a.state().auto, true);
  const p = a.projects().find(p => p.id === 'サンプルアプリ'); assert.ok(p.tasks.length);
  const file = path.join(p.dir, '.ai/tasks', p.tasks[0].id + '.md');
  const before = fs.readFileSync(file); fs.appendFileSync(file, '\nChanged');
  assert.equal(a.state().auto, false); fs.writeFileSync(file, before);
  fs.writeFileSync(path.join(p.dir, '.ai/tasks/new.md'), '---\nid: new\ntitle: real\nstate: 未着手\n---\n');
  assert.equal(a.state().auto, false);
  const b = fixture(t); fs.mkdirSync(path.join(b.root, '_hub'), { recursive: true }); fs.writeFileSync(path.join(b.root, '_hub/log.jsonl'), '');
  assert.equal(b.state().auto, false);
});
test('resume, later, done, corrupt record and strict persistence keep only public progress fields', t => {
  const a = fixture(t);
  const body = { status: 'in-progress', step: 'check', ais: ['claude', 'codex'] };
  assert.equal(a.save(body).auto, true); assert.equal(a.state().step, 'check');
  for (const status of ['skipped', 'done']) assert.equal(a.save({ ...body, status }).auto, false);
  const saved = JSON.parse(fs.readFileSync(a.file));
  assert.deepEqual(Object.keys(saved).sort(), ['ais', 'status', 'step', 'updatedAt', 'version']);
  for (const bad of [null, [], { ...body, step: 'anything' }, { ...body, ais: [] }, { ...body, ais: ['unknown'] }, { ...body, ais: ['codex', 'codex'] }, { ...body, token: 'secret' }]) {
    assert.throws(() => a.save(bad), e => e.status === 400);
  }
  assert.equal(JSON.parse(fs.readFileSync(a.file)).status, 'done');
  fs.writeFileSync(a.file, 'broken'); assert.equal(a.state().auto, false); assert.match(a.state().warning, /読めません/);
  assert.equal(a.save(body).status, 'in-progress');
});
function cli(a, ai, mode) {
  const file = path.join(a.root, ai);
  if (mode === 'timeout') {
    // Node起動の負荷を400msのタイムアウトに混ぜず、statusの待機を検証する。
    // execで置き換えるので、タイムアウト時に待機プロセスも直接終了する。
    const base = ai === 'claude' ? ['auth', 'status'] : ['login', 'status'];
    const calls = "'" + path.join(a.root, 'calls').replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(file, `#!/bin/sh
# 記録は固定の期待値ではなく実argv。値は試験が使う英数字/空白/ハイフンのみ。
printf '[' >> ${calls}
sep=''
for arg do
  case "$arg" in *[!a-zA-Z0-9\\ -]*) exit 1;; esac
  printf '%s"%s"' "$sep" "$arg" >> ${calls}
  sep=','
done
printf ']\\n' >> ${calls}
if [ "$#" -eq 3 ] && [ "$1" = '${base[0]}' ] && [ "$2" = 'status' ] && [ "$3" = '--help' ]; then
  printf '%s\\n' 'Show ${ai === 'claude' ? 'authentication' : 'login'} status'
elif [ "$#" -eq ${ai === 'claude' ? 3 : 2} ] && [ "$1" = '${base[0]}' ] && [ "$2" = 'status' ]${ai === 'claude' ? ' && [ "$3" = "--json" ]' : ''}; then
  exec /bin/sleep 60
else
  exit 1
fi
`, { mode: 0o700 });
    return file;
  }
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(a.root, 'calls'))},JSON.stringify(args)+'\\n');
if(args.includes('--help')) { ${mode === 'missing' ? "console.log('Usage: CLI --help');" : `console.log('Show ${ai === 'claude' ? 'authentication' : 'login'} status');`} }
else { ${mode === 'timeout' ? 'setInterval(()=>{},1000);' : ai === 'claude' ? `console.log(JSON.stringify({loggedIn:${mode === 'ready'},email:'PRIVATE_EMAIL',token:'PRIVATE_TOKEN'}));` : `console.error(${JSON.stringify(mode === 'ready' ? 'Logged in using ChatGPT' : 'Not logged in')});process.exitCode=${mode === 'ready' ? 0 : 1};`} }
`, { mode: 0o700 });
  return file;
}
for (const ai of ['claude', 'codex']) {
  for (const mode of ['ready', 'required', 'missing', 'timeout']) {
    test(`${ai}: fake CLI ${mode}, only help and noninference status run, raw output never returned`, async t => {
      const a = fixture(t, { timeout: mode === 'timeout' ? 400 : 5000 });
      const file = cli(a, ai, mode);
      a.tools.find = () => file; a.tools.version = async () => '1.2.3';
      const r = await a.check([ai]);
      assert.equal(r.tools[ai].login, ['missing', 'timeout'].includes(mode) ? 'unknown' : mode);
      assert.equal(r.tools[ai].version, '1.2.3'); assert.equal(r.terminal, false);
      assert.doesNotMatch(JSON.stringify(r), /PRIVATE|email|token/);
      const calls = fs.readFileSync(path.join(a.root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
      const base = ai === 'codex' ? ['login', 'status'] : ['auth', 'status'];
      assert.deepEqual(calls[0], [...base, '--help']);
      assert.ok(calls.length <= 2);
      if (calls.length > 1) assert.deepEqual(calls[1], ai === 'claude' ? [...base, '--json'] : base);
      if (mode === 'missing') assert.equal(calls.length, 1);
      if (mode === 'timeout') assert.equal(calls.length, 2, 'status must actually run and time out');
    });
  }
}
test('missing tools and dry mode never run CLI; Agy settings do not prove login', async t => {
  const a = fixture(t, { run: () => { throw Error('must not execute'); } });
  assert.equal((await a.check(['codex'])).tools.codex.installed, false);
  a.tools.find = () => '/fake'; a.dry = true;
  assert.equal((await a.check(['claude'])).tools.claude.login, 'unknown');
  a.dry = false; assert.equal((await a.check(['agy'])).tools.agy.login, 'required');
  const file = path.join(a.home, '.gemini/antigravity-cli/settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"modelProvider":"antigravity"}');
  assert.equal((await a.check(['agy'])).tools.agy.login, 'unknown');
});
test('Agy absent, normal, malformed and API settings are distinct without CLI calls or raw settings', async t => {
  const a = fixture(t, { run: () => { throw Error('must not execute'); } });
  a.tools.find = () => '/fake';
  const file = path.join(a.home, '.gemini/antigravity-cli/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal((await a.check(['agy'])).tools.agy.login, 'required');
  for (const [settings, login, notice] of [
    ['{"modelProvider":"antigravity","token":"PRIVATE"}', 'unknown', undefined],
    ['{}', 'unknown', undefined],
    ['{broken PRIVATE', 'unknown', 'settings-unreadable'],
    ['null', 'unknown', 'settings-unreadable'],
    ['[]', 'unknown', 'settings-unreadable'],
    ['"PRIVATE"', 'unknown', 'settings-unreadable'],
    ['{"modelProvider":42}', 'unknown', 'settings-unreadable'],
    ['{"modelProvider":""}', 'unknown', 'settings-unreadable'],
    ['{"modelProvider":"PRIVATE_API","apiKey":"PRIVATE"}', 'unknown', 'api-provider'],
  ]) {
    fs.writeFileSync(file, settings);
    const r = await a.check(['agy']);
    assert.equal(r.tools.agy.login, login); assert.equal(r.tools.agy.notice, notice);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE|apiKey|modelProvider/);
    assert.equal(fs.readFileSync(file, 'utf8'), settings);
  }
});
test('Agy unreadable settings are unknown even when existence cannot be checked', async t => {
  const a = fixture(t, { run: () => { throw Error('must not execute'); } });
  a.tools.find = () => '/fake';
  const file = path.join(a.home, '.gemini/antigravity-cli/settings.json');
  const read = fs.readFileSync;
  let code = 'EACCES';
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    if (name === file) throw Object.assign(Error('PRIVATE detail'), { code });
    return read(name, ...args);
  });
  for (code of ['EACCES', 'EIO']) {
    const r = await a.check(['agy']);
    assert.deepEqual(r.tools.agy, { installed: true, version: '', login: 'unknown', notice: 'settings-unreadable' });
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE|EACCES|EIO/);
  }
});
test('concurrent checks are blocked and later failures do not leave a stuck busy flag', async t => {
  let release; const a = fixture(t);
  a.tools.version = () => new Promise(r => { release = r; });
  const pending = a.check(['codex']);
  assert.throws(() => a.check(['codex']), e => e.status === 409);
  release(''); await pending;
  a.tools.version = async () => { throw Error('version failure'); };
  await assert.rejects(a.check(['codex']), /version failure/);
  a.tools.version = async () => ''; await a.check(['codex']);
});
