'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createGithub, parseAccounts, suggestedName, mask } = require('../lib/github');
const gitw = require('../lib/git');
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hub-github-test-'));
const realExec = promisify(execFile);
const token = 'ghp_TESTONLY0123456789';
const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@local', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@local' };
let seq = 0;
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const accounts = 'github.com\n  ✓ Logged in to github.com account kieiken (keyring)\n  - Active account: true\n  - Token: ' + token + '\n  ✓ Logged in to github.com account second (keyring)\n  - Active account: false\n';
function fixture({ none = false, execHook, init, idle, status = accounts } = {}) {
  const base = path.join(tmp, 'repo-' + ++seq); fs.mkdirSync(base);
  if (!none) { git(base, 'init', '-q'); fs.writeFileSync(path.join(base, 'a.txt'), 'a'); git(base, 'add', '.'); git(base, 'commit', '-qm', 'first'); }
  const calls = [], settingsFile = path.join(base, 'settings.json');
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (execHook) { const r = await execHook(file, args, options); if (r !== undefined) return r; }
    if (file === 'gh') {
      if (args[0] === '--version') return { stdout: 'gh version test', stderr: '' };
      if (args[0] === 'auth' && args[1] === 'status') return { stdout: status, stderr: '' };
      if (args[0] === 'auth' && args[1] === 'token') return { stdout: token, stderr: '' };
      if (args[0] === 'api') return { stdout: 'our-org\n', stderr: '' };
      if (args[0] === 'repo') return { stdout: '', stderr: '' };
      throw Error('Unexpected gh operation');
    }
    assert.equal(file, 'git'); return realExec(file, args, { ...options, env: { ...options.env, GIT_CEILING_DIRECTORIES: tmp } });
  };
  return { base, calls, settingsFile, project: { base, dir: base, id: 'p', name: '日本語' }, gh: createGithub({ exec, settingsFile, ...(init ? { init } : {}), ...(idle ? { idle } : {}) }) };
}
function input(d, extra = {}) { return { account: 'kieiken', owner: 'kieiken', name: 'private-test', push: false, expectedHead: d.head, expectedBranch: d.branch, ...extra }; }

test('status parses two accounts, drops token lines, caches; missing gh/login and dry do not expose output', async () => {
  assert.deepEqual(parseAccounts(accounts), [{ login: 'kieiken', active: true }, { login: 'second', active: false }]);
  const f = fixture(); const r = await f.gh.status(); assert.equal(r.ready, true); assert.ok(!JSON.stringify(r).includes(token));
  await f.gh.status(); assert.equal(f.calls.length, 2); await f.gh.status({ fresh: true }); assert.equal(f.calls.length, 4);
  assert.equal((await fixture({ status: '' }).gh.status()).ready, false);
  const missing = fixture({ execHook: f => { if (f === 'gh') throw Error('ENOENT'); } }); assert.equal((await missing.gh.status()).gh, false);
  const dry = createGithub({ dry: true, exec: () => { throw Error('must not run'); } }); assert.equal((await dry.status()).ready, false);
});
test('settings defaults to kieiken; saves only account/owner, rejects missing account or foreign owner', async () => {
  const f = fixture(); assert.deepEqual(f.gh.settings(), { account: 'kieiken', owner: '' });
  await f.gh.save({ account: 'second', owner: 'our-org' }); assert.deepEqual(f.gh.settings(), { account: 'second', owner: 'our-org' });
  assert.ok(!fs.readFileSync(f.settingsFile, 'utf8').includes(token));
  await assert.rejects(f.gh.save({ account: 'unknown' }), /ログイン済み/);
  await assert.rejects(f.gh.save({ account: 'kieiken', owner: 'foreign' }), /所属/);
});
test('names and secret masking', () => {
  assert.match(suggestedName('日本語'), /^project-\d{8}$/); assert.equal(suggestedName('hello / world'), 'hello-world');
  assert.ok(!mask(`error ${token} https://user:password@github.com/a/b GH_TOKEN=unusual-secret`, token).includes(token));
  assert.ok(!mask('https://user:password@github.com/a/b').includes('password'));
});
test('preview is read-only, displays saved branch, dirty changes, secrets deleted from HEAD still in history', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.base, '.env'), 'test'); git(f.base, 'add', '.env'); git(f.base, 'commit', '-qm', 'secret'); git(f.base, 'rm', '-q', '.env'); git(f.base, 'commit', '-qm', 'remove');
  fs.writeFileSync(path.join(f.base, 'dirty.txt'), 'unsaved'); const before = git(f.base, 'status', '--porcelain');
  const d = await f.gh.preview(f.project); assert.equal(d.git, 'repo'); assert.equal(d.dirty, true); assert.equal(d.commits, 3); assert.equal(d.canPush, true); assert.equal(d.ledger, true);
  assert.ok(d.risky.some(x => x.file === '.env')); assert.equal(git(f.base, 'status', '--porcelain'), before);
  assert.equal(f.calls.filter(c => c.file === 'gh' && !['auth', '--version'].includes(c.args[0])).length, 0);
  assert.equal(git(f.base, 'remote'), '');
});
test('preview refuses nested Git/origin and describes uninitialized/detached Git', async () => {
  const f = fixture(); const nested = path.join(f.base, 'nested'); fs.mkdirSync(nested);
  assert.equal((await f.gh.preview({ ...f.project, base: nested })).git, 'nested');
  git(f.base, 'remote', 'add', 'origin', 'https://user:password@github.com/u/r.git');
  const d = await f.gh.preview(f.project); assert.equal(d.hasOrigin, true); assert.ok(!JSON.stringify(d).includes('password'));
  const empty = fixture({ none: true }); assert.equal((await empty.gh.preview(empty.project)).git, 'none');
  const detached = fixture(); git(detached.base, 'checkout', '--detach', '-q'); assert.equal((await detached.gh.preview(detached.project)).canPush, false);
});
test('create private, no push by default, selected-account token only in env and no auth switch', async () => {
  const f = fixture(), d = await f.gh.preview(f.project), before = git(f.base, 'rev-parse', 'HEAD');
  const r = await f.gh.create(f.project, input(d, { account: 'second', owner: 'second' })); assert.equal(r.ok, true); assert.equal(r.pushed, false);
  assert.equal(git(f.base, 'rev-parse', 'HEAD'), before); assert.equal(git(f.base, 'remote', 'get-url', 'origin'), 'https://github.com/second/private-test.git');
  const create = f.calls.find(c => c.file === 'gh' && c.args[0] === 'repo'); assert.ok(create.args.includes('--private')); assert.equal(create.options.env.GH_TOKEN, token);
  assert.ok(f.calls.every(c => !c.args.includes(token))); assert.ok(!f.calls.some(c => c.args.includes('switch') || c.args.includes('push')));
  assert.ok(f.calls.some(c => c.args.includes('--user') && c.args.includes('second'))); assert.ok(!JSON.stringify(r).includes(token));
  assert.equal(gitw.hasOrigin(f.base), true);
});
test('optional push goes only to local bare repo and sends committed HEAD, excluding dirty files', async () => {
  const bare = path.join(tmp, 'bare-' + ++seq); fs.mkdirSync(bare); git(bare, 'init', '--bare', '-q');
  const f = fixture({ execHook: async (file, args, opts) => {
    if (file === 'git' && args.includes('remote') && args.includes('add')) { const a = [...args]; a[a.length - 1] = 'file://' + bare; return realExec(file, a, opts); }
    if (file === 'git' && args.includes('get-url') && args.includes('--push')) return { stdout: 'https://github.com/kieiken/private-test.git', stderr: '' };
  } });
  fs.writeFileSync(path.join(f.base, 'a.txt'), 'unsaved'); fs.writeFileSync(path.join(f.base, 'unsaved.txt'), 'unsaved');
  const d = await f.gh.preview(f.project); const r = await f.gh.create(f.project, input(d, { push: true })); assert.equal(r.pushed, true);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/' + d.branch), d.head); assert.equal(git(bare, 'show', d.head + ':a.txt'), 'a');
  assert.throws(() => git(bare, 'show', d.head + ':unsaved.txt'));
  const push = f.calls.find(c => c.file === 'git' && c.args.includes('push')); assert.equal(push.options.env.GH_TOKEN, token); assert.ok(push.args.includes('credential.helper=')); assert.ok(!push.args.join(' ').includes(token));
});
test('invalid names/owner/push and changed saved HEAD rejected before repository creation', async () => {
  for (const extra of [{ name: 'bad/name' }, { name: '..' }, { owner: 'foreign' }, { push: 'true' }, { push: true, expectedHead: 'old' }]) {
    const f = fixture(), d = await f.gh.preview(f.project); await assert.rejects(f.gh.create(f.project, input(d, extra)));
    assert.ok(!f.calls.some(c => c.file === 'gh' && c.args[0] === 'repo')); assert.equal(git(f.base, 'remote'), '');
  }
});
test('creation/remote/push failure report stage, mask token, and never delete repo or retry', async () => {
  for (const stage of ['repo', 'remote', 'push']) {
    const f = fixture({ execHook: async (file, args) => {
      if ((stage === 'repo' && file === 'gh' && args[0] === 'repo') || (stage === 'remote' && file === 'git' && args.includes('remote') && args.includes('add')) || (stage === 'push' && file === 'git' && args.includes('push'))) { const e = Error('test ' + token); e.stderr = 'failure ' + token; throw e; }
    } });
    const d = await f.gh.preview(f.project);
    if (stage === 'repo') await assert.rejects(f.gh.create(f.project, input(d)), e => !e.message.includes(token));
    else { const r = await f.gh.create(f.project, input(d, { push: stage === 'push' })); assert.equal(r.partial, true); assert.equal(r.connected, stage === 'push'); assert.equal(r.pushed, false); assert.ok(!JSON.stringify(r).includes(token)); }
    assert.equal(f.calls.filter(c => c.file === 'gh' && c.args[0] === 'repo').length, 1); assert.ok(!f.calls.some(c => c.args.includes('delete')));
  }
});
test('Git initialization is explicit, occurs only after validation, and is disclosed on remote failure', async () => {
  let initialized = false;
  const f = fixture({ none: true, init: folder => { initialized = true; git(folder, 'init', '-q'); return { ok: true }; }, execHook: (file, args) => { if (file === 'gh' && args[0] === 'repo') throw Error('repo fail'); } });
  const d = await f.gh.preview(f.project); assert.equal(initialized, false);
  const r = await f.gh.create(f.project, input(d)); assert.equal(initialized, true); assert.equal(r.initialized, true); assert.equal(r.partial, true); assert.match(r.message, /Git の保存は始めました/);
});
test('same base cannot create twice concurrently; existing origin rejected on apply; idle blocks mutation', async () => {
  let release; const hold = new Promise(r => { release = r; }); let started; const entering = new Promise(r => { started = r; });
  const f = fixture({ execHook: async (file, args) => { if (file === 'gh' && args[0] === 'repo') { started(); await hold; return { stdout: '', stderr: '' }; } } });
  const d = await f.gh.preview(f.project), first = f.gh.create(f.project, input(d)); await entering;
  await assert.rejects(f.gh.create({ ...f.project, id: 'other' }, input(d)), e => e.status === 409); release(); await first;
  await assert.rejects(f.gh.create(f.project, input(d)), /送り先/);
  const idle = fixture(); const g = createGithub({ exec: async (file, args, opts) => {
    if (file === 'gh') return { stdout: args[0] === 'auth' ? accounts : 'version', stderr: '' };
    return realExec(file, args, opts);
  }, settingsFile: idle.settingsFile, idle: () => { throw Error('AI running'); } });
  const p = await g.preview(idle.project); await assert.rejects(g.create(idle.project, input(p)), /AI running/); assert.equal(git(idle.base, 'remote'), '');
});

test('preview classifies large historical blobs without reading working files', async () => {
  const f = fixture({ execHook: async (file, args, opts) => {
    if (file === 'git' && args.includes('--batch-all-objects')) { const r = await realExec(file, args, opts); return { ...r, stdout: r.stdout.replace(/ [0-9]+\n/g, ' 105906177\n') }; }
  } });
  const d = await f.gh.preview(f.project); assert.ok(d.risky.some(x => x.file === 'a.txt' && /100MB超/.test(x.reason)));
});
test('saved content changing during GitHub create never gets silently pushed', async () => {
  const f = fixture({ execHook: (file, args, opts) => {
    if (file === 'gh' && args[0] === 'repo') { fs.writeFileSync(path.join(opts.cwd, 'a.txt'), 'different'); git(opts.cwd, 'commit', '-qam', 'concurrent save'); return { stdout: '', stderr: '' }; }
  } });
  const d = await f.gh.preview(f.project); const r = await f.gh.create(f.project, input(d, { push: true })); assert.equal(r.partial, true); assert.equal(r.pushed, false); assert.match(r.message, /保存またはブランチが変わりました/); assert.ok(!f.calls.some(c => c.args.includes('push')));
});
test('network uncertainty is disclosed and authentication failure does not expose nonstandard tokens', async () => {
  const f = fixture({ execHook: (file, args) => { if (file === 'gh' && args[0] === 'repo') throw Error('connect timeout'); } });
  const d = await f.gh.preview(f.project); await assert.rejects(f.gh.create(f.project, input(d)), /作成されたかは未確認/);
  const auth = fixture({ execHook: (file, args) => { if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') { const e = Error('private-opaque-value'); e.stdout = 'private-opaque-value'; throw e; } } });
  const p = await auth.gh.preview(auth.project); await assert.rejects(auth.gh.create(auth.project, input(p)), e => /ログインが切れています/.test(e.message) && !e.message.includes('private-opaque-value'));
});
test('summary returns immediately while auth status is pending and carries only readiness', async () => {
  let release; const held = new Promise(r => { release = r; });
  const g = createGithub({ exec: async (file, args) => args[0] === '--version' ? { stdout: 'gh', stderr: '' } : await held, settingsFile: path.join(tmp, 'summary.json') });
  assert.equal(g.summary().ready, false); release({ stdout: accounts, stderr: '' }); await g.status(); assert.equal(g.summary().ready, true); assert.ok(!('accounts' in g.summary()));
});

test('historical secret names survive rename and identical blobs under safe names', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.base, '.env'), 'a'); // a.txtと同一blob
  fs.writeFileSync(path.join(f.base, '.env.example'), 'a');
  fs.writeFileSync(path.join(f.base, '.env.sample'), 'a');
  git(f.base, 'add', '.'); git(f.base, 'commit', '-qm', 'same blob under secret and safe names');
  git(f.base, 'mv', '.env', 'safe.txt'); git(f.base, 'commit', '-qm', 'rename secret');
  const d = await f.gh.preview(f.project);
  assert.deepEqual(d.risky.map(x => x.file), ['.env']);
  assert.equal(d.risky[0].bytes, 1);
  assert.ok(!f.calls.some(c => c.args.includes('show') || c.args.includes('--batch')));
});
test('history checks all merge parents and preserves newline/tab/Unicode paths', async () => {
  const f = fixture(), initial = git(f.base, 'symbolic-ref', '--short', 'HEAD');
  git(f.base, 'checkout', '-qb', 'secret-side');
  const folder = '日本語\nwith\ttab'; fs.mkdirSync(path.join(f.base, folder));
  fs.writeFileSync(path.join(f.base, folder, '.env'), 'side');
  git(f.base, 'add', '.'); git(f.base, 'commit', '-qm', 'secret side');
  git(f.base, 'mv', folder + '/.env', folder + '/safe.txt'); git(f.base, 'commit', '-qm', 'renamed on side');
  git(f.base, 'checkout', '-q', initial);
  fs.writeFileSync(path.join(f.base, 'other.txt'), 'other'); git(f.base, 'add', '.'); git(f.base, 'commit', '-qm', 'main side');
  git(f.base, 'merge', '--no-ff', '-qm', 'merge', 'secret-side');
  const d = await f.gh.preview(f.project);
  assert.ok(d.risky.some(x => x.file === folder + '/.env'));
  assert.ok(!d.risky.some(x => x.file.includes('safe.txt')));
});
for (const stage of ['token', 'organization']) test(`idle is rechecked after pending ${stage} before Git initialization`, async () => {
  let active = false, checks = 0, initialized = false;
  const f = fixture({ none: true, idle: () => { checks++; if (active) { const e = Error('AI running'); e.status = 409; throw e; } },
    init: () => { initialized = true; return { ok: true }; },
    execHook: (file, args) => {
      if (file === 'gh' && ((stage === 'token' && args[0] === 'auth' && args[1] === 'token') || (stage === 'organization' && args[0] === 'api'))) active = true;
    } });
  const d = await f.gh.preview(f.project);
  await assert.rejects(f.gh.create(f.project, input(d, stage === 'organization' ? { owner: 'our-org' } : {})), e => e.status === 409 && /AI running/.test(e.message));
  assert.equal(checks, 2); assert.equal(initialized, false); assert.equal(fs.existsSync(path.join(f.base, '.git')), false);
  assert.ok(!f.calls.some(c => c.file === 'gh' && c.args[0] === 'repo'));
  assert.equal(f.gh.locked(f.base), false);
});
for (const failed of [false, true]) test(`creation lock blocks base AI, allows existing copies and releases on ${failed ? 'failure' : 'success'}`, async () => {
  let release, entering;
  const held = new Promise(r => { release = r; }), entered = new Promise(r => { entering = r; });
  const f = fixture({ execHook: async (file, args) => {
    if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') { entering(); await held; if (failed) throw Error('auth failure'); }
  } });
  const d = await f.gh.preview(f.project);
  const creation = f.gh.create(f.project, input(d));
  // Attach a rejection handler before releasing the asynchronous operation.
  const completion = failed ? assert.rejects(creation, /ログインが切れています/) : creation;
  await entered;
  const alias = { ...f.project, id: 'alias' };
  assert.equal(f.gh.locked(alias.base), true);
  for (const task of [{workspaceMode:'direct'}, {workspaceMode:'isolated'}, {workspaceMode:'isolated',workdir:f.base}]) {
    assert.throws(() => f.gh.assertStart(alias, task), e => e.status === 409 && /GitHubの作成中/.test(e.message));
  }
  const copy = path.join(tmp, 'existing-copy-' + ++seq); fs.mkdirSync(copy);
  assert.doesNotThrow(() => f.gh.assertStart(alias, {workspaceMode:'isolated',workdir:copy}));
  release(); await completion;
  assert.equal(f.gh.locked(f.base), false);
  assert.doesNotThrow(() => f.gh.assertStart(alias, {workspaceMode:'direct'}));
});
