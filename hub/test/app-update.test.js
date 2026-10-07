'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AppUpdate, DAY, UPSTREAM } = require('../lib/app-update');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-app-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream'), source = path.join(dir, 'source'), root = path.join(dir, 'workspace'), apps = path.join(dir, 'Applications'), appPath = path.join(apps, 'Project Hub.app');
  fs.mkdirSync(upstream); fs.mkdirSync(appPath, { recursive: true }); fs.mkdirSync(root);
  fs.writeFileSync(path.join(appPath, 'marker'), 'old'); fs.writeFileSync(path.join(root, 'private-data.txt'), 'private user workspace');
  git(upstream, 'init', '-q', '-b', 'main'); git(upstream, 'config', 'user.name', 'Fixture'); git(upstream, 'config', 'user.email', 'fixture@localhost');
  fs.mkdirSync(path.join(upstream, 'hub'));
  fs.writeFileSync(path.join(upstream, 'hub/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }) + '\n');
  fs.writeFileSync(path.join(upstream, 'text.txt'), 'original\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'initial');
  git(dir, 'clone', '-q', upstream, source); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@localhost');
  fs.writeFileSync(path.join(source, 'localization.txt'), '繁體中文\n');
  if (options.conflict) fs.writeFileSync(path.join(source, 'text.txt'), '中文修改\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'local translation');
  const originalHead = git(source, 'rev-parse', 'HEAD');
  if (options.newVersion !== false) {
    fs.writeFileSync(path.join(upstream, 'hub/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.1' }) + '\n');
    fs.writeFileSync(path.join(upstream, 'new-feature.txt'), 'upstream feature\n');
    if (options.conflict) fs.writeFileSync(path.join(upstream, 'text.txt'), 'upstream changed\n');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'new version');
  }
  const latestCommit = git(upstream, 'rev-parse', 'HEAD'), events = [];
  let remoteReads = 0, time = 1700000000000, busy = false;
  const defaults = {
    root, source, appPath, upstream, platform: 'darwin', env: { HUB_AUTO_UPDATE: '1', HUB_STORAGE_GUARD: '/fixture/guard' }, now: () => time, guard: async () => true, busy: () => busy,
    latest: async () => { remoteReads++; return { commit: latestCommit, version: options.newVersion === false ? '1.0.0' : '1.0.1' }; },
    run: async (file, args, opts) => {
      if (file === 'git') return git(opts.cwd || dir, ...args);
      events.push(file + ':' + args[0]);
      assert.equal(file, 'npm');
      assert.equal(opts.env.HUB_SKIP_APP, '1');
      assert.notEqual(opts.env.HUB_ROOT, root);
      if (options.failStep === args[0]) throw Error('fixture command failure');
      return '';
    },
    build: async (stage, destination, env) => { events.push('build'); fs.mkdirSync(path.join(destination, 'Project Hub.app'), { recursive: true }); fs.writeFileSync(path.join(destination, 'Project Hub.app/marker'), 'new'); assert.equal(env.HUB_ROOT, root); assert.equal(env.HUB_UPDATE_SOURCE, stage); },
    verify: async app => { events.push('verify'); assert.equal(fs.readFileSync(path.join(app, 'marker'), 'utf8'), 'new'); },
  };
  const make = extra => new AppUpdate({ ...defaults, ...extra });
  return { dir, root, source, appPath, upstream, originalHead, latestCommit, events, make, reads: () => remoteReads, clock: value => { time = value; }, advance: () => { time += DAY; }, busy: value => { busy = value; }, marker: () => fs.readFileSync(path.join(appPath, 'marker'), 'utf8') };
}

test('public default is off; saved switch overrides the local opt-in environment', async t => {
  const f = fixture(t), app = f.make({ env: { HUB_AUTO_UPDATE: '0', HUB_STORAGE_GUARD: '/fixture/guard' } });
  assert.equal(app.status().enabled, false);
  await app.settings(false);
  assert.equal(f.make().status().enabled, false);
  assert.equal(app.status().upstream, UPSTREAM);
});

test('daily gate includes manual requests and restarts; a disabled check only reads metadata', async t => {
  const f = fixture(t), app = f.make({ env: { HUB_AUTO_UPDATE: '0', HUB_STORAGE_GUARD: '/fixture/guard' } });
  const first = await app.check(); assert.equal(first.pending, true); assert.equal(first.latestVersion, '1.0.1');
  await app.check(); await f.make({ env: { HUB_AUTO_UPDATE: '0', HUB_STORAGE_GUARD: '/fixture/guard' } }).check();
  assert.equal(f.reads(), 1); assert.equal(f.marker(), 'old');
  f.advance(); await app.check(); assert.equal(f.reads(), 2);
});

test('a failed check is persisted and cannot requery upstream on restart within24hours', async t => {
  const f = fixture(t); let calls = 0;
  const latest = async () => { calls++; throw Error('fixture unreachable'); };
  const app = f.make({ latest });
  assert.equal((await app.check()).phase, 'failed');
  await f.make({ latest }).check(); assert.equal(calls, 1);
  assert.ok(app.status().lastAttempt); assert.ok(app.status().nextCheck);
});

test('already integrated upstream and invalid upstream versions never replace the app', async t => {
  const f = fixture(t, { newVersion: false }), app = f.make();
  assert.equal((await app.check()).pending, false); assert.deepEqual(f.events, []);
  const g = fixture(t); const bad = g.make({ latest: async () => ({ commit: g.latestCommit, version: 'not-a-version' }) });
  assert.equal((await bad.check()).phase, 'failed'); assert.equal(g.marker(), 'old');
});

test('dirty committed source and active AI/queue defer the cached update without touching source or app', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'uncommitted.txt'), 'active work');
  const dirty = f.make(); assert.equal((await dirty.check()).phase, 'deferred');
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.originalHead); assert.equal(f.marker(), 'old'); assert.deepEqual(f.events, []);
  const g = fixture(t); g.busy(true); const busy = g.make(); assert.equal((await busy.check()).phase, 'deferred');
  await busy.check(); assert.equal(g.reads(), 1); assert.equal(g.marker(), 'old');
  g.busy(false); assert.equal((await busy.resume()).phase, 'installed'); assert.equal(g.reads(), 1);
});

test('guard failure does not fetch upstream, create updater state, or replace an app', async t => {
  const f = fixture(t), app = f.make({ guard: async () => false });
  assert.equal((await app.check()).phase, 'failed'); assert.equal(f.reads(), 0);
  assert.equal(fs.existsSync(path.join(f.root, '_hub')), false); assert.equal(f.marker(), 'old');
});

test('update errors and idle explanations remain Japanese before C', async t => {
  const f = fixture(t), app = f.make({ guard: async () => false });
  assert.equal((await app.check()).error, 'Storage Guard が更新を止めました。今のアプリは変更していません');
  assert.equal(app.idleMessage(), 'AI・順番待ち・整理が終わるまで更新を待ちます');
  await assert.rejects(app.settings('yes'), /enabled は true または false/);
});

test('merge conflict without a translator keeps source and app; bounded translator can resolve in the isolated stage', async t => {
  const f = fixture(t, { conflict: true });
  assert.equal((await f.make().check()).phase, 'conflict'); assert.equal(f.marker(), 'old');
  const g = fixture(t, { conflict: true });
  const app = g.make({ translate: async (stage, context) => { assert.equal(context.conflicted, true); assert.notEqual(stage, g.source); fs.writeFileSync(path.join(stage, 'text.txt'), '上游與繁中已整合\n'); git(stage, 'add', 'text.txt'); } });
  assert.equal((await app.check()).phase, 'installed'); assert.equal(g.marker(), 'new');
  assert.equal(fs.readFileSync(path.join(g.source, 'text.txt'), 'utf8'), '中文修改\n');
});

test('translation, locked install, all tests, build and signatures precede committing/installing/publishing', async t => {
  const f = fixture(t);
  const app = f.make({
    translate: async stage => { f.events.push('translate'); fs.writeFileSync(path.join(stage, 'zh-new.txt'), '繁中新增功能'); git(stage, 'add', 'zh-new.txt'); },
    validate: async stage => { f.events.push('validate'); assert.equal(git(stage, 'status', '--porcelain'), ''); assert.equal(f.marker(), 'old'); },
    publish: async (stage, context) => { f.events.push('publish'); assert.equal(git(stage, 'status', '--porcelain'), ''); assert.equal(f.marker(), 'new'); assert.equal(context.upstreamSha, f.latestCommit); return { prUrl: 'https://github.com/kieiken/project-hub/pull/123' }; },
  });
  const status = await app.check();
  assert.equal(status.phase, 'installed'); assert.equal(status.pending, false); assert.equal(status.latestVersion, '1.0.1');
  assert.deepEqual(f.events, ['translate', 'npm:ci', 'npm:test', 'build', 'verify', 'validate', 'verify', 'publish']);
  assert.equal(status.prUrl, 'https://github.com/kieiken/project-hub/pull/123');
  assert.equal(fs.readFileSync(path.join(status.backup, 'marker'), 'utf8'), 'old');
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.originalHead);
  assert.equal(fs.readFileSync(path.join(f.root, 'private-data.txt'), 'utf8'), 'private user workspace');
  assert.equal(app.applying(), true); assert.equal(app.status().restartNeeded, true);
  const restarted = f.make(); assert.equal(restarted.applying(), false); assert.equal(restarted.status().restartNeeded, false);
});

test('test/build/signature failures preserve the previous app and never publish', async t => {
  for (const failure of ['test', 'build', 'verify']) {
    const f = fixture(t, { failStep: failure }); let published = false;
    const options = { publish: async () => { published = true; } };
    if (failure === 'build') options.build = async () => { throw Error('fixture build failure'); };
    if (failure === 'verify') options.verify = async () => { throw Error('fixture signature failure'); };
    const status = await f.make(options).check(); assert.equal(status.phase, 'failed'); assert.equal(f.marker(), 'old'); assert.equal(published, false);
  }
});

test('an install rename failure restores the old app after moving it aside', async t => {
  const f = fixture(t), app = f.make({ rename: (from, to) => { if (path.basename(from) === 'new.app') throw Error('fixture rename failure'); fs.renameSync(from, to); } });
  assert.equal((await app.check()).phase, 'failed'); assert.equal(f.marker(), 'old'); assert.equal(app.source, f.source); assert.equal(app.status().pending, true);
});

test('AI becoming active during final verification retains the candidate and resumes without another daily check', async t => {
  const f = fixture(t); const app = f.make({ beforeInstall: async () => { f.busy(true); } });
  assert.equal((await app.check()).phase, 'deferred'); assert.equal(f.marker(), 'old'); assert.equal(f.reads(), 1);
  f.busy(false); app.beforeInstall = null;
  assert.equal((await app.resume()).phase, 'installed'); assert.equal(f.reads(), 1); assert.equal(f.events.filter(e => e === 'npm:test').length, 1);
});

test('PR failure persists across restart and retries the verified source once on the next day', async t => {
  const f = fixture(t); let calls = 0;
  const publish = async stage => {
    calls++; assert.equal(git(stage, 'status', '--porcelain'), '');
    if (calls === 1) throw Error('fixture publication failure');
    return { prUrl: 'https://github.com/kieiken/project-hub/pull/123' };
  };
  const app = f.make({ publish });
  const result = await app.check(); assert.equal(result.phase, 'installed'); assert.equal(f.marker(), 'new'); assert.ok(result.publishError);
  assert.equal(result.publishPending, true);
  const restarted = f.make({ publish });
  await restarted.check(); await restarted.resume();
  assert.equal(calls, 1); assert.ok(restarted.status().publishError);
  f.advance(); const retried = await restarted.check();
  assert.equal(calls, 2); assert.equal(f.reads(), 2); assert.equal(retried.pending, false);
  assert.equal(retried.publishPending, false); assert.equal(retried.publishError, '');
  assert.equal(retried.prUrl, 'https://github.com/kieiken/project-hub/pull/123');
  assert.equal(f.events.filter(event => event === 'npm:test').length, 1);
  await restarted.check(); await restarted.resume(); assert.equal(calls, 2);
});

test('public-source validation failure prevents installation and publication', async t => {
  const f = fixture(t); let published = false;
  const app = f.make({ validate: async () => { throw Error('fixture privacy failure'); }, publish: async () => { published = true; } });
  assert.equal((await app.check()).phase, 'failed'); assert.equal(f.marker(), 'old'); assert.equal(published, false);
});

test('the next day clones the installed committed source and can apply a second upstream version', async t => {
  const f = fixture(t); let reads = 0;
  const app = f.make({ latest: async () => { reads++; return { commit: git(f.upstream, 'rev-parse', 'HEAD'), version: JSON.parse(fs.readFileSync(path.join(f.upstream, 'hub/package.json'))).version }; } });
  assert.equal((await app.check()).sourceVersion, '1.0.1'); const first = app.source;
  fs.writeFileSync(path.join(f.upstream, 'hub/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.2' }) + '\n');
  git(f.upstream, 'add', 'hub/package.json'); git(f.upstream, 'commit', '-qm', 'second version');
  f.advance(); const second = await app.check();
  assert.equal(second.phase, 'installed'); assert.equal(second.sourceVersion, '1.0.2'); assert.notEqual(app.source, first); assert.equal(reads, 2);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.originalHead);
});

test('interrupted install journal restores the old app before any metadata lookup', async t => {
  const f = fixture(t), sibling = path.join(path.dirname(f.appPath), '.ProjectHub-update-interrupted');
  fs.mkdirSync(sibling); fs.renameSync(f.appPath, path.join(sibling, 'old.app'));
  fs.mkdirSync(path.join(f.root, '_hub/updates'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '_hub/updates/state.json'), JSON.stringify({ phase: 'installing', pending: true, install: { target: f.appPath, old: path.join(sibling, 'old.app'), fresh: path.join(sibling, 'new.app') } }));
  const app = f.make(); await app.recover();
  assert.equal(f.marker(), 'old'); assert.equal(f.reads(), 0); assert.equal(app.applying(), false); assert.equal(app.status().phase, 'failed');
});

test('concurrent manual checks during an active install journal return cached status without recovery', async t => {
  const f = fixture(t), app = f.make();
  let recoveries = 0, entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const recover = app.recover.bind(app), persist = app.persist.bind(app);
  app.recover = async () => { recoveries++; return recover(); };
  let blocked = false;
  app.persist = async () => {
    await persist();
    if (app.data.install && !blocked) { blocked = true; entered(); await wait; }
  };
  const first = app.check();
  await reached;
  try {
    const journal = structuredClone(app.data.install);
    const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('manual check waited for active installation')), 500); timer.unref(); });
    const cached = await Promise.race([Promise.all([app.check(), app.check(), app.check()]), timeout]);
    assert.ok(cached.every(state => state.phase === 'installing'));
    assert.equal(recoveries, 1);
    assert.deepEqual(app.data.install, journal);
    assert.equal(f.reads(), 1);
    assert.equal(f.marker(), 'old');
  } finally { release(); await first; }
  assert.equal(app.status().phase, 'installed');
  assert.equal(f.marker(), 'new');
});

test('simultaneous manual checks and cached resume acquire one lock before any await', async t => {
  const f = fixture(t), app = f.make();
  f.busy(true);
  const checks = await Promise.all([app.check(), app.check(), app.check()]);
  assert.equal(checks[0].phase, 'deferred');
  assert.equal(f.reads(), 1);
  f.busy(false);
  const resumed = app.resume();
  const cached = await app.check();
  assert.equal(cached.phase, 'deferred');
  assert.equal((await resumed).phase, 'installed');
  assert.equal(f.reads(), 1);
  assert.equal(f.events.filter(event => event === 'npm:test').length, 1);
});

test('a newer daily upstream invalidates the old prepared candidate without deleting its source', async t => {
  const f = fixture(t); let reads = 0;
  const app = f.make({
    latest: async () => { reads++; return { commit: git(f.upstream, 'rev-parse', 'HEAD'), version: JSON.parse(fs.readFileSync(path.join(f.upstream, 'hub/package.json'))).version }; },
    build: async (stage, destination) => {
      const version = JSON.parse(fs.readFileSync(path.join(stage, 'hub/package.json'))).version;
      fs.mkdirSync(path.join(destination, 'Project Hub.app'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'Project Hub.app/marker'), version);
    },
    verify: async candidate => assert.match(fs.readFileSync(path.join(candidate, 'marker'), 'utf8'), /^1\.0\.[12]$/),
    beforeInstall: async () => { f.busy(true); },
  });
  assert.equal((await app.check()).phase, 'deferred');
  const previous = structuredClone(app.data.job);
  assert.equal(previous.context.upstreamSha, f.latestCommit);
  assert.equal(f.marker(), 'old');
  fs.writeFileSync(path.join(f.upstream, 'hub/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.2' }) + '\n');
  git(f.upstream, 'add', 'hub/package.json'); git(f.upstream, 'commit', '-qm', 'new version while the candidate waits');
  const latest = git(f.upstream, 'rev-parse', 'HEAD');
  app.beforeInstall = null; f.busy(false); f.advance();
  const result = await app.check();
  assert.equal(result.phase, 'installed'); assert.equal(result.installedCommit, latest);
  assert.equal(result.installedVersion, '1.0.2'); assert.equal(f.marker(), '1.0.2');
  assert.equal(reads, 2); assert.equal(f.events.filter(event => event === 'npm:test').length, 2);
  assert.equal(fs.existsSync(previous.folder), true);
  assert.notEqual(result.installedSource, previous.stage);
});

test('disabling automatic updates retains a failed PR without publishing; reenabling resumes cached source', async t => {
  const f = fixture(t); let calls = 0;
  const app = f.make({ publish: async () => { if (++calls === 1) throw Error('fixture publication failure'); return { prUrl: 'https://github.com/kieiken/project-hub/pull/123' }; } });
  await app.check(); await app.settings(false); f.advance();
  const disabled = await app.check(); await app.resume();
  assert.equal(calls, 1); assert.equal(disabled.publishPending, true); assert.ok(disabled.publishError);
  await app.settings(true); if (app.running) await app.running;
  assert.equal(calls, 2); assert.equal(f.reads(), 2);
  assert.equal(app.status().publishPending, false);
});

test('guard refusal after a durable app replacement keeps installed phase and a safe restart signal', async t => {
  for (const withPublisher of [true, false]) {
    const f = fixture(t); let app, published = false;
    app = f.make({ guard: async () => !app?.restartNeeded, publish: withPublisher ? async () => { published = true; } : undefined });
    const result = await app.check();
    assert.equal(result.phase, 'installed'); assert.equal(result.restartNeeded, true);
    assert.equal(f.marker(), 'new'); assert.equal(app.applying(), true); assert.equal(published, false);
    assert.ok(result.stateError); assert.equal(result.publishPending, withPublisher);
    if (withPublisher) assert.ok(result.publishError);
    assert.equal(fs.readFileSync(path.join(result.backup, 'marker'), 'utf8'), 'old');
    assert.equal(f.make().status().phase, 'installed');
  }
});

test('missing source, app or guard remains unsupported even when a test build callback exists', t => {
  const f = fixture(t);
  assert.equal(f.make({ source: '' }).supported(), false);
  assert.equal(f.make({ appPath: '' }).supported(), false);
  assert.equal(f.make({ env: { HUB_STORAGE_GUARD: '' } }).supported(), false);
});

test('failed and interrupted translation cannot retry on manual resume or restart before24hours', async t => {
  const f = fixture(t); let calls = 0;
  const translate = async () => { calls++; throw Error('fixture translator failure'); };
  assert.equal((await f.make({ translate }).check()).phase, 'failed');
  const restarted = f.make({ translate });
  await restarted.check(); await restarted.resume(); await restarted.resume();
  assert.equal(calls, 1); assert.equal(f.reads(), 1); assert.equal(f.marker(), 'old');
  restarted.data.phase = 'translating'; await restarted.persist();
  await f.make({ translate }).resume(); assert.equal(calls, 1);
  f.advance(); await f.make({ translate }).check(); assert.equal(calls, 2);
});

test('a prepared source changed while waiting cannot replace the signed app', async t => {
  const f = fixture(t), app = f.make({ beforeInstall: async () => f.busy(true) });
  assert.equal((await app.check()).phase, 'deferred');
  fs.writeFileSync(path.join(app.data.job.stage, 'text.txt'), 'changed after testing');
  f.busy(false); app.beforeInstall = null;
  assert.equal((await app.resume()).phase, 'failed'); assert.equal(f.marker(), 'old');
});

test('guard refusal immediately before replacement preserves both source and old app', async t => {
  const f = fixture(t); let allowed = true;
  const app = f.make({ guard: async () => allowed, beforeInstall: async () => { allowed = false; } });
  assert.equal((await app.check()).phase, 'failed'); assert.equal(f.marker(), 'old');
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.originalHead);
});
