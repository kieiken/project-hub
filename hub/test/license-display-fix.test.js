'use strict';
// Ported display boundaries on the current 4.125 client, on both OS branches. No real store, secret service, issuer or server startup.
const { test: nodeTest } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const os = require('node:os'), Module = require('node:module');
assert.ok(process[Symbol.for('hub.test.offline')], 'isolated_launcher_required');
const { License, activationError } = require('../lib/license');
const fakeCode = 'SYNTHETIC-DISPLAY-ONLY';
const httpMessage = '発行先からエラー応答があり、登録を完了できませんでした。保存済みの利用証明は保持しています。';
const connectionMessage = '発行先の応答を確認できませんでした。登録結果は未確認です。再送・再購入せず、状況を確認してください。';
const responseMessage = '発行先の応答を読み取れませんでした。登録結果は未確認です。再送・再購入せず、状況を確認してください。';
const entitlementMessage = 'この利用コードの有効性を確認できませんでした。発行先・対象の版・有効期間の確認が必要です。再送・再購入せず、発行元に確認してください。';
const unexpected = () => { throw Error('unexpected_state_or_secret_operation'); };
function client(fetcher, platform = 'darwin') {
  const pair = crypto.generateKeyPairSync('ed25519'); // Disposable RAM fixture; never persisted.
  const instance = Object.create(License.prototype), calls = [];
  Object.assign(instance, { owner: false, online: false, platform, proofs: [], trialUsed: false,
    wall: () => 2000000000, machineHint: () => 'synthetic-machine',
    config: { endpoint: 'https://synthetic.invalid', build: { buildId: 'synthetic-build' }, trustedKeys: {} },
    ensureIdentity: () => ({ dev: 'synthetic-device', privateKey: pair.privateKey, publicKeySpkiB64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }),
    fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://synthetic.invalid'); assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json'); assert.ok(init.signal instanceof AbortSignal);
      calls.push(new URL(url).pathname); return fetcher(url, init);
    }, acceptProof: unexpected, store: { read: unexpected, write: unexpected }, secret: new Proxy({}, { get: unexpected }) });
  return { instance, calls };
}
async function failure(work) { try { await work(); } catch (e) { return e; } assert.fail('expected failure'); }
function route() {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("  if (url.pathname === '/api/license/activate') {");
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('\n  // 自動Chat', start));
  return (license, code) => vm.runInNewContext('(async()=>{' + block + '})()', {
    url: { pathname: '/api/license/activate' }, license, b: { code }, res: {},
    send: (_res, status, body) => ({ status, body }),
    require: name => { assert.equal(name, './lib/license'); return { activationError }; },
  });
}
for (const platform of ['darwin', 'win32']) {
const test = (name, run) => nodeTest(platform + ': ' + name, run);
const platformClient = fetcher => client(fetcher, platform);
test('HTTP refusals use fixed response guidance; four existing specific messages and trial_used survive', async () => {
  const cases = [
    [403, 'entitlement', entitlementMessage],
    [403, 'device_limit_mac', 'この利用権のMacは登録台数の上限です。前の端末を外す時は運営に連絡してください'],
    [403, 'device_limit_windows', 'この利用権のWindowsは登録台数の上限です。前の端末を外す時は運営に連絡してください'],
    [403, 'unregistered', 'この端末は登録されていません。移行について運営に連絡してください'],
    [400, 'unsupported_os', 'このOSは利用コードの対象外です'],
    [403, 'trial_used', httpMessage], [403, 'challenge', httpMessage], [403, 'signature', httpMessage], [400, 'build_os', httpMessage],
  ];
  for (const [status, code, message] of cases) {
    const { instance, calls } = platformClient(async () => Response.json({ code }, { status }));
    const error = await failure(() => instance.activate(fakeCode));
    assert.equal(error.code, code); assert.equal(error.message, message);
    assert.deepEqual(activationError(error), { error: message, code });
    assert.deepEqual(calls, ['/challenge']); assert.equal(instance.online, false);
  }
});
test('untrusted HTTP codes, missing/non-JSON bodies and HTTP error-body read failure remain HTTP errors', async () => {
  const bodies = [{ code: 'SYNTHETIC_PRIVATE_PAYLOAD' }, { code: 'issuer_connection' }, { code: '__proto__' }, { code: 'constructor' }, { code: 'license_unsupported' }, { code: 'legacy_license_unavailable' }, { code: 'issuer_unconfigured' }, { code: { payload: 'SYNTHETIC_PRIVATE_PAYLOAD' } }, null, 'synthetic', {}];
  const responses = bodies.map(body => () => Response.json(body, { status: 429 }));
  responses.push(() => new Response('SYNTHETIC_PRIVATE_PAYLOAD', { status: 502 }));
  responses.push(() => ({ ok: false, json: async () => { throw Error('SYNTHETIC_PRIVATE_PAYLOAD'); } }));
  for (const response of responses) {
    const { instance } = platformClient(async () => response());
    const result = await route()(instance, fakeCode);
    assert.equal(result.status, 400); // Existing local status, not the issuer HTTP status.
    assert.equal(result.body.code, 'issuer_unavailable'); assert.equal(result.body.error, httpMessage);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PAYLOAD'));
  }
});
test('transport failures at challenge or activation say outcome unknown, never retry or accept proof', async () => {
  for (const stage of ['/challenge', '/activate']) for (const kind of ['TypeError', 'AbortError', 'TimeoutError']) {
    const { instance, calls } = platformClient(async url => {
      if (new URL(url).pathname !== stage) return Response.json({ nonce: 'synthetic-nonce' });
      throw Object.assign(Error('SYNTHETIC_PRIVATE_PAYLOAD'), { name: kind, code: 'SYNTHETIC_PRIVATE_PAYLOAD' });
    });
    const result = await route()(instance, fakeCode);
    assert.equal(result.status, 400); assert.equal(result.body.code, 'issuer_connection'); assert.equal(result.body.error, connectionMessage);
    assert.deepEqual(calls, stage === '/challenge' ? ['/challenge'] : ['/challenge', '/activate']); assert.equal(instance.online, false);
  }
});
test('unreadable successful response has separate unknown-outcome guidance at both activation phases', async () => {
  for (const stage of ['/challenge', '/activate']) {
    const { instance, calls } = platformClient(async url => new URL(url).pathname === stage
      ? new Response('SYNTHETIC_PRIVATE_PAYLOAD', { status: 200 }) : Response.json({ nonce: 'synthetic-nonce' }));
    const result = await route()(instance, fakeCode);
    assert.equal(result.body.code, 'issuer_response'); assert.equal(result.body.error, responseMessage);
    assert.deepEqual(calls, stage === '/challenge' ? ['/challenge'] : ['/challenge', '/activate']); assert.equal(instance.online, false);
  }
});
test('registration API hides raw proof/storage exceptions and restores actionable invalid-input/busy guidance', async () => {
  for (const code of ['proof_target', 'device_key_missing', 'SYNTHETIC_PRIVATE_PAYLOAD', '__proto__', undefined]) {
    const result = await route()({ activate: async () => { throw Object.assign(Error('SYNTHETIC_PRIVATE_PAYLOAD'), { code, status: 409 }); } }, fakeCode);
    assert.equal(result.status, 409); assert.equal(result.body.code, 'license_activation');
    assert.match(result.body.error, /登録結果を確認できません/); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PAYLOAD'));
  }
  const { instance, calls } = client(unexpected);
  assert.equal((await route()(instance, '')).body.code, 'invalid_code');
  assert.match((await route()(instance, '')).body.error, /入力してください/);
  instance.online = true;
  assert.equal((await route()(instance, fakeCode)).body.code, 'license_busy');
  assert.match((await route()(instance, fakeCode)).body.error, /再送しない/); assert.deepEqual(calls, []);
});
test('actual submit callback renders new API guidance, clears input and blocks duplicates until the button is restored', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.ok(app.includes("appSettingsCallback3299());"));
  const source = fs.readFileSync(path.join(__dirname, '../public/app-settings.js'), 'utf8');
  const start = source.indexOf('function appSettingsCallback3299() {'); assert.ok(start >= 0);
  const end = source.indexOf('\n// Create the original callback', start); assert.ok(end > start);
  const callback = source.slice(start, end) + "\ndocument.addEventListener('submit', appSettingsCallback3299());";
  for (const connection of [false, true]) {
    let release, submit, apiCalls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const { instance, calls } = platformClient(async () => { await gate; if (connection) throw Error('SYNTHETIC_PRIVATE_PAYLOAD'); return Response.json({ code: 'entitlement' }, { status: 403 }); });
    const input = { value: fakeCode }, button = { disabled: false }, notice = {};
    const form = { id: 'license-form', querySelector: selector => ({ '#license-code': input, '#license-notice': notice, button })[selector] };
    vm.runInNewContext(callback, { document: { addEventListener: (_type, f) => { submit = f; } },
      api: async (_url, body) => { apiCalls++; assert.equal(body.code, fakeCode); const result = await route()(instance, body.code); throw Error(result.body.error); },
      state: {}, renderSettings: unexpected, toast: unexpected, UI: { text: x => x } });
    const event = { target: form, preventDefault() {} };
    const pending = submit(event); assert.equal(input.value, ''); assert.equal(button.disabled, true);
    await submit(event); assert.equal(apiCalls, 1); release(); await pending;
    assert.equal(notice.textContent, connection ? connectionMessage : entitlementMessage);
    assert.equal(button.disabled, false); assert.deepEqual(calls, ['/challenge']); assert.equal(instance.online, false);
  }
});
test('shared post classification keeps trial_used state handling and stops without extra requests', async () => {
  const { instance, calls } = platformClient(async () => Response.json({ code: 'trial_used' }, { status: 403 }));
  await instance.prepareOnline();
  assert.equal(instance.trialUsed, true); assert.equal(instance.online, false);
  assert.equal(instance.retryAfter, 2000000060); assert.deepEqual(calls, ['/challenge']);
});
test('shared time request failure still cancels the pending clock request without accepting or saving time', async () => {
  const { instance, calls } = platformClient(async () => { throw Error('SYNTHETIC_PRIVATE_PAYLOAD'); });
  let cancels = 0;
  instance.identity = instance.ensureIdentity();
  instance.makeClock = () => ({ request: () => ({ nonce: 'synthetic-time', lastSeq: 0 }), cancel: () => { cancels++; }, accept: unexpected });
  const error = await failure(() => instance.refreshTime('synthetic-entitlement'));
  assert.equal(error.code, 'issuer_connection'); assert.equal(cancels, 1); assert.deepEqual(calls, ['/challenge']);
});
}

function generatedLicense(config, held = false) {
  const file = path.join(__dirname, '../release-app', held ? 'license-hold.cjs' : 'license.cjs');
  const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === './protocol.cjs') return { configFor: () => config };
    if (name === './core.cjs') return { fingerprints: unexpected };
    if (name === './license.cjs') return { lifecycle: require('../purchase-test-app/license.cjs').lifecycle };
    return original(name);
  };
  // Pure JavaScript derivation, as in release-app.test.js; no app builder or native compiler.
  const source = held ? fs.readFileSync(file, 'utf8') : require('../release-app/compile.cjs').license(
    fs.readFileSync(path.join(__dirname, '../purchase-test-app/license.cjs'), 'utf8'));
  mod._compile(source, file);
  return mod.exports;
}

for (const platform of ['darwin', 'win32']) {
  nodeTest(platform + ': 4.125 local preconditions keep fixed guidance/status and perform no request', async () => {
    const { instance, calls } = client(unexpected, platform);
    instance.config = { ...instance.config, endpoint: '' };
    const unavailable = await route()(instance, fakeCode);
    assert.equal(unavailable.body.code, 'issuer_unconfigured');
    assert.equal(unavailable.body.error, 'この版の利用コード受付は準備中です。実際のコードは入力せずお待ちください');
    assert.equal(unavailable.status, 400); assert.deepEqual(calls, []);

    const held = generatedLicense(instance.config, true).createHeldLicense(instance.config, platform);
    const before = held.client.status();
    const refusal = await route()(held.client, fakeCode);
    assert.equal(refusal.status, 409); assert.equal(refusal.body.code, 'legacy_license_unavailable');
    assert.equal(refusal.body.error, before.reason);
    assert.equal(held.busy(), false); assert.equal(held.client.status().trial.state, 'held');
    assert.equal(held.client.status().activationAvailable, false);
    assert.equal(JSON.stringify(held.client.status()), JSON.stringify(before));
    const mismatch=generatedLicense(instance.config,true).createHeldLicense(instance.config,platform,'legacy_registration_mismatch');
    const mismatchStatus=mismatch.client.status();assert.equal(mismatchStatus.trial.state,'held');assert.equal(mismatchStatus.purchased,false);
    assert.equal(mismatchStatus.diagnostic.code,'LEGACY_REGISTRATION_MISMATCH');assert.match(mismatchStatus.reason,/端末情報を照合できない/);
    assert.equal(mismatchStatus.features.chat_basic.allowed,true);assert.equal(mismatchStatus.features.delegate.allowed,false);
    assert.equal((await route()(mismatch.client,fakeCode)).status,409);
  });

  nodeTest(platform + ': formal release adapter preserves refusal/transport/JSON classifications and consumed claim', async t => {
    const cases = [
      ['http', () => Response.json({ code: 'entitlement' }, { status: 403 }), 'entitlement', entitlementMessage],
      ['http-invalid-json', () => new Response('SYNTHETIC_PRIVATE_PAYLOAD', { status: 502 }), 'issuer_unavailable', httpMessage],
      ['http-private-code', () => Response.json({ code: 'SYNTHETIC_PRIVATE_PAYLOAD' }, { status: 429 }), 'issuer_unavailable', httpMessage],
      ['success-invalid-json', () => new Response('SYNTHETIC_PRIVATE_PAYLOAD', { status: 200 }), 'issuer_response', responseMessage],
      ['transport', () => { throw Error('SYNTHETIC_PRIVATE_PAYLOAD'); }, 'issuer_connection', connectionMessage],
      ['success-oversize', () => new Response('x'.repeat(262145)), 'issuer_response', responseMessage],
      ['http-oversize', () => new Response('x'.repeat(262145), { status: 503 }), 'issuer_unavailable', httpMessage],
    ];
    for (const [kind, response, code, message] of cases) for (const stage of ['/challenge', '/activate']) {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-display-port-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const pair = crypto.generateKeyPairSync('ed25519'), calls = [];
      const meta = { id: 'synthetic-account', dev: require('../lib/license/codec').fingerprint(pair.publicKey) };
      const raw = JSON.stringify({ privateKeyPkcs8B64: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
      const config = { endpoint: 'https://synthetic.invalid', trustedKeys: {}, trialDays: 30, licenseEnforcement: true,
        build: { buildId: 'synthetic-build', channel: 'release', product: 'synthetic-product', bugfixOf: [] } };
      const adapter = generatedLicense(config).createLicense(root, {
        platform, store: { read: name => name === 'device' ? meta : null, write: unexpected },
        secret: { get: id => { assert.equal(id, meta.id); return raw; }, put: unexpected },
        machineHint: () => 'synthetic-machine', elapsed: () => 0, wall: () => 2000000000, onDiagnostic: unexpected,
        fetcher: async (url, init) => {
          const target = new URL(url); assert.equal(target.origin, config.endpoint);
          assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
          const body = JSON.parse(init.body); assert.equal(body.os, platform === 'darwin' ? 'mac' : 'windows');
          assert.equal(body.buildId, config.build.buildId); calls.push(target.pathname);
          return target.pathname === stage ? response() : Response.json({ nonce: 'synthetic-nonce' });
        },
      });
      const result = await route()(adapter.client, fakeCode);
      assert.equal(result.status, 400, kind); assert.equal(result.body.code, code, kind); assert.equal(result.body.error, message, kind);
      assert.deepEqual(calls, stage === '/challenge' ? ['/challenge'] : ['/challenge', '/activate']);
      assert.equal(adapter.busy(), false); assert.equal(adapter.client.online, false); assert.deepEqual(adapter.client.proofs, []);
      assert.deepEqual(fs.readdirSync(root), ['registration-claimed.json']);
      const claim = fs.readFileSync(path.join(root, 'registration-claimed.json'), 'utf8');
      assert.equal(JSON.parse(claim).status, 'claimed-do-not-retry');
      assert.ok(!claim.includes(fakeCode)); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PAYLOAD'));
      const count = calls.length, repeated = await route()(adapter.client, fakeCode);
      assert.equal(repeated.body.code, 'license_registration_pending'); assert.match(repeated.body.error, /受付済み/);
      assert.equal(calls.length, count); assert.equal(fs.readFileSync(path.join(root, 'registration-claimed.json'), 'utf8'), claim);
    }
  });
}

nodeTest('unsupported local OS and unexpected internal errors cannot leak through the activation API', async () => {
  const { instance, calls } = client(unexpected, 'linux');
  const result = await route()(instance, fakeCode);
  assert.equal(result.status, 403); assert.equal(result.body.code, 'license_unsupported');
  assert.equal(result.body.error, 'このOSは利用コードの対象外です'); assert.deepEqual(calls, []);
  for (const code of ['device_key_unavailable', 'proof_target', 'SYNTHETIC_PRIVATE_PAYLOAD', '__proto__', { secret: true }]) {
    const result = await route()({ activate: async () => { throw Object.assign(Error('SYNTHETIC_PRIVATE_PAYLOAD'), { code }); } }, fakeCode);
    assert.equal(result.body.code, 'license_activation'); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_PAYLOAD'));
  }
});
