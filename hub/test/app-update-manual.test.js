'use strict';
// No live feed, App, clock changes or publisher keys: isolated journals and RAM signatures.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const { PackagedUpdate } = require('../lib/app-update-packaged');
const { TrialUpdate, updateStore } = require('../purchase-test-app/update.cjs');
const { WindowsPackagedUpdate } = require('../lib/app-update-windows');
const compiler = require('../release-app/compile.cjs');
const file = path.resolve(__dirname, '../release-app/update.cjs'), generated = new Module(file, module);
generated.filename = file; generated.paths = Module._nodeModulePaths(path.dirname(file));
generated._compile(compiler.update(fs.readFileSync(path.resolve(__dirname, '../purchase-test-app/update.cjs'), 'utf8')), file);
const { ReleaseUpdate } = generated.exports;
const runtimeFile = path.resolve(__dirname, '../release-app/runtime.cjs'), runtimeModule = new Module(runtimeFile, module);
runtimeModule.filename = runtimeFile; runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimeFile));
const runtimeRequire = runtimeModule.require.bind(runtimeModule);
runtimeModule.require = id => ['./core.cjs', './protocol.cjs'].includes(id) ? {} : runtimeRequire(id);
runtimeModule._compile(compiler.runtime(fs.readFileSync(path.resolve(__dirname, '../purchase-test-app/runtime.cjs'), 'utf8')), runtimeFile);
const MINUTE = 60000, HOUR = 3600000, DAY = 24 * HOUR, NOW = 1800000000000;
function fixture(t, route) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-manual-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = route.endsWith('windows') ? 'win32' : 'darwin', arch = platform === 'win32' ? 'x64' : 'arm64';
  const runtime = route.startsWith('release'), trial = route.startsWith('trial');
  const appPath = path.join(root, 'Applications/Project Hub.app'), hubPath = path.join(appPath, 'Contents/Resources/runtime/hub');
  fs.mkdirSync(hubPath, { recursive: true });
  const key = crypto.generateKeyPairSync('ed25519');
  const trust = { ...(trial ? { channel: 'purchase-test' } : runtime ? { runtimeProtocol: 1 } : {}),
    feedUrl: 'https://github.com/fixture/hub/releases/latest/download/feed.json', windowsFeedUrl: 'https://github.com/fixture/hub/releases/latest/download/feed.json',
    assetPrefix: 'https://github.com/fixture/hub/releases/download/', redirectHosts: [], revokedKids: [],
    keys: { fixture: { spkiB64: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), purposes: ['app-update'] } } };
  const f = { now: NOW, calls: 0, fail: false }, version = '4.126.98';
  f.manifest = (v = version, seq = 7) => {
    const name = runtime ? `Project-Hub-${v}-Runtime-${platform === 'win32' ? 'Windows-x64' : 'Apple-Silicon'}.zip` : trial || platform === 'win32' ? 'runtime.zip' : 'app.dmg';
    return { v: 1, typ: 'hub-app-update', product: trial ? 'project-hub-purchase-test' : 'project-hub', ...(trial ? { channel: 'purchase-test' } : {}), edition: 'public', lang: 'ja', version: v, seq,
      kind: 'bugfix', product_line: 'project-hub-4.123', bugfixOf: ['project-hub-4.123'], issuedAt: NOW / 1000, expiresAt: NOW / 1000 + 30 * 86400,
      requires: { os: platform, arch, node: '>=22', ...(platform === 'darwin' ? { minMacOS: '13.0' } : { minWindows: '10.0.22000' }) },
      asset: { name, size: 1, sha256: 'a'.repeat(64), url: trust.assetPrefix + 'v' + v + (trial ? '-purchase-test.update/' : '/') + name },
      app: { format: runtime ? 'release-runtime-v1' : trial ? 'purchase-runtime-v1' : platform === 'win32' ? 'windows-zip-v1' : 'mac-dmg', shellProtocol: 1, runtime: 'hub', bundleId: trial ? 'local.projecthub.purchase-test' : 'local.projecthub', shortVersion: v, treeSha256: 'b'.repeat(64), entries: 1 }, notes: { ja: 'isolated fixture' } };
  };
  f.sign = m => { const b = Buffer.from(JSON.stringify(m)); return { kid: 'fixture', payload: b.toString('base64url'), sig: crypto.sign(null, b, key.privateKey).toString('base64url') }; };
  f.envelope = f.sign(f.manifest());
  const store = updateStore(root, 'darwin');
  store.access(() => ({ origin: hubPath }));
  const options = { root, appPath, hubPath, bootstrap: hubPath, windowLaunch: 'fixture', version, platform, arch, node: '22.23.1', trust, updateStore: store,
    env: { HUB_WINDOW_LAUNCH: 'fixture', HUB_UPDATE_CONFIRM: '' }, now: () => f.now, macOS: async () => '15.0', windowsVersion: async () => '10.0.22631', osVersion: async () => platform === 'win32' ? '10.0.22631' : '15.0',
    platformApi: { appUpdater: { packagedSupported: () => true, hasQuarantine: () => false } },
    // Outside purchase scope: newer feeds exercise eligibility without downloading a fixture App.
    license: { status: () => ({ enforcement: true, features: { x: { allowed: true, state: 'purchased' } }, updateScope: { purchaseProducts: ['other'] } }) },
    fetch: async url => { assert.equal(url, trust.feedUrl); f.calls++; if (f.fail) throw Error('fixture transport'); return Response.json(f.envelope); } };
  const Updater = runtime ? ReleaseUpdate : trial ? TrialUpdate : platform === 'win32' ? WindowsPackagedUpdate : PackagedUpdate;
  f.create = () => new Updater(options); f.u = f.create(); assert.equal(f.u.supported(), true); return f;
}
for (const route of ['stable-mac', 'stable-windows', 'trial-mac', 'trial-windows', 'release-mac', 'release-windows']) {
  test(route + ': manual checks run immediately after auto; only manual repeats wait 60s across restart', async t => {
    const f = fixture(t, route); await f.u.check(false); assert.equal(f.calls, 1);
    assert.equal(f.u.status().latestVersion, '4.126.98');
    assert.equal(f.u.status().nextCheck, new Date(NOW + DAY).toISOString());
    assert.equal(f.u.due(true), true); assert.equal(f.u.data.lastManualCheck, undefined);
    assert.equal((await f.u.check()).checkPerformed, true); assert.equal(f.calls, 2);
    const immediate = await f.u.check(); assert.equal(immediate.checkPerformed, false); assert.match(immediate.checkSkippedReason, /60秒/); assert.equal(f.calls, 2);
    f.now += MINUTE - 1;
    const before = await f.u.check(); assert.equal(before.checkPerformed, false); assert.match(before.checkSkippedReason, /60秒/); assert.equal(f.calls, 2);
    assert.equal(before.nextManualCheck, new Date(NOW + MINUTE).toISOString()); assert.equal(before.lastCheck, new Date(NOW).toISOString());
    assert.equal(f.create().due(true), false);
    f.now++; const restarted = f.create(); assert.equal(restarted.due(), false); assert.equal(restarted.due(true), true);
    assert.equal((await restarted.check()).checkPerformed, true); assert.equal(f.calls, 3);
    assert.equal(restarted.status().nextCheck, new Date(NOW + MINUTE + DAY).toISOString());
    f.now = NOW + MINUTE + DAY - 1; assert.equal(restarted.due(), false);
    f.now++; assert.equal(restarted.due(), true); await restarted.check(false); assert.equal(f.calls, 4);
    assert.equal(restarted.due(true), true); assert.equal((await restarted.check()).checkPerformed, true); assert.equal(f.calls, 5);
  });
  test(route + ': old successful state migrates; old and new failures retain 24h', async t => {
    const f = fixture(t, route);
    f.u.data = { ...f.u.data, phase: 'idle', lastCheck: new Date(NOW).toISOString(), retryAfter: NOW + DAY, eligibility: 'up-to-date', reason: '最新版を使用しています' }; f.u.persist();
    let u = f.create(); assert.equal(u.due(), false); assert.equal(u.due(true), true);
    assert.equal(u.status().latestVersion, ''); assert.match(u.status().reason, /未確認/);
    await u.check(); assert.equal(f.calls, 1); assert.equal(u.data.maxSeq, 7); assert.deepEqual(u.data.envelope, f.envelope);
    f.now += HOUR; f.fail = true; await u.check(); assert.equal(u.status().phase, 'failed'); const deadline = f.now + DAY;
    f.now += HOUR; u = f.create(); const skipped = await u.check(); assert.equal(skipped.checkPerformed, false); assert.match(skipped.checkSkippedReason, /24時間/);
    assert.equal(skipped.nextManualCheck, new Date(deadline).toISOString()); assert.equal(f.calls, 2);
    delete u.data.retryAfterKind; u.persist(); u = f.create(); assert.equal(u.due(true), false);
    const interrupted = { ...u.data, phase: 'checking', error: '' }; u.data = interrupted; u.persist(); u = f.create(); assert.equal(u.due(true), false);
    f.now = deadline - 1; assert.equal(u.due(true), false); f.now++; f.fail = false; await u.check(); assert.equal(f.calls, 3);
  });
  test(route + ': legacy successful idle, ready and deferred journals allow immediate manual checking', async t => {
    const f = fixture(t, route), initial = { ...f.u.data };
    for (const phase of ['idle', 'ready', 'deferred']) {
      const saved = f.create();
      saved.data = { ...initial, phase, error: '', lastCheck: new Date(NOW).toISOString(), retryAfter: NOW + DAY };
      saved.persist(); const u = f.create();
      assert.equal(u.due(), false); assert.equal(u.due(true), true);
      assert.equal((await u.check()).checkPerformed, true);
    }
    assert.equal(f.calls, 3);
  });
  test(route + ': same, older and newer verified feeds retain observations and sequence protections', async t => {
    const f = fixture(t, route);
    for (const [version, seq, eligibility] of [['4.126.98', 7, 'up-to-date'], ['4.126.97', 8, 'up-to-date'], ['4.126.99', 9, 'purchase-scope']]) {
      f.envelope = f.sign(f.manifest(version, seq)); await f.u.check();
      assert.equal(f.u.status().latestVersion, version); assert.equal(f.u.status().eligibility, eligibility); assert.equal(f.u.data.maxSeq, seq);
      assert.deepEqual(f.create().data.envelope, f.envelope); f.now += HOUR;
    }
    f.envelope = f.sign(f.manifest('4.126.97', 8)); await f.u.check(); assert.match(f.u.status().error, /sequence/); assert.equal(f.u.data.maxSeq, 9);
  });
  test(route + ': in-flight checks, pending reopen and rejected artifacts never bypass protections', async t => {
    const f = fixture(t, route); let release;
    f.u.fetch = () => { f.calls++; return new Promise(resolve => { release = resolve; }); };
    const first = f.u.check(); await new Promise(setImmediate);
    assert.match(f.u.status().manualCheckBlockedReason, /処理中/); assert.equal(f.u.status().nextManualCheck, null);
    const duplicate = await f.u.check(); assert.equal(duplicate.checkPerformed, false); assert.match(duplicate.checkSkippedReason, /処理中/); assert.equal(f.calls, 1);
    assert.match(duplicate.manualCheckBlockedReason, /処理中/); assert.equal(duplicate.nextManualCheck, null);
    release(Response.json(f.envelope)); const completed = await first;
    assert.match(completed.manualCheckBlockedReason, /60秒/); assert.equal(completed.nextManualCheck, new Date(NOW + MINUTE).toISOString());
    f.u.data.pendingConfirm = { from: '4.126.98', version: '4.126.99' };
    assert.match((await f.u.check()).checkSkippedReason, /開き直し/); assert.equal(f.calls, 1);
    delete f.u.data.pendingConfirm;
    f.now += MINUTE; f.u.data.prepared = { version: '4.126.99' }; f.u.enabled = false;
    const prepared = await f.u.check(); assert.equal(prepared.checkPerformed, false); assert.match(prepared.checkSkippedReason, /準備済み/); assert.equal(f.calls, 1);
    assert.equal(f.u.data.lastManualCheck, new Date(NOW).toISOString());
    delete f.u.data.prepared; f.u.data.rejected = { seq: 7, sha256: 'a'.repeat(64) };
    f.now += HOUR; f.u.fetch = async () => Response.json(f.envelope); await f.u.check(); assert.match(f.u.status().error, /rejected/);
  });
  test(route + ': processing, failure and normal manual waits have distinct display text without changing deadlines', async t => {
    const f = fixture(t, route), u = f.u;
    Object.assign(u.data, { lastCheck: new Date(NOW).toISOString(), retryAfter: NOW + DAY, retryAfterKind: 'failure', error: '' });
    for (const phase of ['checking', 'downloading', 'preparing', 'verifying', 'installing', 'confirming']) {
      u.data.phase = phase;
      const status = u.status(); assert.match(status.manualCheckBlockedReason, /処理中.*終わるまで/);
      assert.doesNotMatch(status.manualCheckBlockedReason, /確認できなかった/); assert.equal(status.nextManualCheck, null);
      assert.equal(u.nextCheckTime(true), NOW + DAY); assert.equal(u.due(true), false);
    }
    for (const phase of ['failed', 'error', 'rolled-back']) {
      u.data.phase = phase;
      assert.match(u.status().manualCheckBlockedReason, /確認できなかった.*24時間/);
      assert.equal(u.status().nextManualCheck, new Date(NOW + DAY).toISOString());
    }
    u.data.phase = 'idle'; u.data.error = 'fixture failure';
    assert.match(u.status().manualCheckBlockedReason, /確認できなかった/);
    u.data.error = '';
    assert.doesNotMatch(u.status().manualCheckBlockedReason, /確認できなかった/);
    assert.equal(u.status().nextManualCheck, new Date(NOW + DAY).toISOString());
    u.data.retryAfterKind = 'interval';
    u.data.lastManualCheck = new Date(NOW).toISOString();
    assert.match(u.status().manualCheckBlockedReason, /60秒/);
    assert.equal(u.status().nextManualCheck, new Date(NOW + MINUTE).toISOString());
    let release;
    const locked = u.lock(() => new Promise(resolve => { release = resolve; })); await new Promise(setImmediate);
    assert.match(u.status().manualCheckBlockedReason, /処理中/); assert.equal(u.status().nextManualCheck, null);
    release(); await locked;
    f.now += HOUR; f.fail = true;
    const failed = await u.check(); assert.equal(failed.phase, 'failed');
    assert.match(failed.manualCheckBlockedReason, /確認できなかった.*24時間/);
    assert.equal(failed.nextManualCheck, new Date(f.now + DAY).toISOString());
  });
  if (route.startsWith('release') || route.startsWith('trial')) test(route + ': distribution API returns the actual manual check result', async t => {
    const f = fixture(t, route), api = route.startsWith('release') ? runtimeModule.exports : require('../purchase-test-app/runtime.cjs');
    const lifecycle = require('../purchase-test-app/license.cjs').lifecycle();
    async function post() {
      let response;
      const handled = await api.gate({ method: 'POST', headers: {}, resume() {} }, {}, new URL('http://127.0.0.1/api/app-update/check'), {
        allowed: () => true, readBody: async () => ({}), lifecycle, updater: f.u,
        send: (_, code, body) => { assert.equal(code, 200); response = JSON.parse(JSON.stringify(body)); } });
      assert.equal(handled, true); assert.equal(lifecycle.state(), 'idle'); return response;
    }
    await f.u.check(false); assert.equal((await post()).checkPerformed, true); assert.equal(f.calls, 2);
    const skipped = await post();
    assert.equal(skipped.checkPerformed, false); assert.match(skipped.checkSkippedReason, /60秒/); assert.equal(f.calls, 2);
    assert.equal(skipped.nextManualCheck, new Date(NOW + MINUTE).toISOString());
    f.now += MINUTE; assert.equal((await post()).checkPerformed, true); assert.equal(f.calls, 3);
  });
}
