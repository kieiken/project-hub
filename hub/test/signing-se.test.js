'use strict';
// Software keys and injected child transport only. Never invoke the real helper.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), c = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyManifest } = require('../lib/app-update-packaged');
const { signFromSecureEnclave, signFromKeychain, sha256, loadPlan } = require('../../scripts/sign-update');
const { secureEnclave, prepareEnclaveHelper, installedHelper, prepareHelper, keychain } = require('../../scripts/release-keychain');
const stable = require('../lib/update-trust'), runtime = require('../release-app/update-trust.cjs');
const sign = (bytes, key) => c.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
function space(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-signing-se-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function identity(pair) {
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { kid: 'hub-p256se-' + c.createHash('sha256').update(der).digest('base64url'), spkiB64: der.toString('base64'), alg: 'p256-sha256' };
}
function fixture(t, platform = 'darwin') {
  const dir = space(t), pair = c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), id = identity(pair), now = 1800000000000;
  const name = `Project-Hub-4.125.2-Runtime-${platform === 'darwin' ? 'Apple-Silicon' : 'Windows-x64'}.zip`;
  const p = { runtimeProtocol: 1, kid: id.kid, spkiB64: id.spkiB64, payloadFile: path.join(dir, 'payload.json'), assetFile: path.join(dir, name), outputFile: path.join(dir, 'out.json') };
  fs.writeFileSync(p.assetFile, 'zip'); p.assetSha256 = sha256(p.assetFile);
  const m = { v: 1, typ: 'hub-app-update', product: 'project-hub', edition: 'public', lang: 'ja', version: '4.125.2', seq: 8, issuedAt: now / 1000, expiresAt: now / 1000 + 86400, kind: 'bugfix', product_line: 'project-hub-4.123', bugfixOf: ['project-hub-4.123'], requires: { os: platform, arch: platform === 'darwin' ? 'arm64' : 'x64', node: '>=22', ...(platform === 'darwin' ? { minMacOS: '13.0' } : { minWindows: '10.0.22000' }) }, asset: { name, size: 3, sha256: p.assetSha256, url: runtime.assetPrefix + 'v4.125.2/' + name }, app: { format: 'release-runtime-v1', runtime: 'hub', shellProtocol: 1, bundleId: 'local.projecthub', shortVersion: '4.125.2', entries: 2, treeSha256: 'a'.repeat(64) }, notes: { ja: 'fixture' } };
  const trust = { ...runtime, keys: { [id.kid]: { ...id, purposes: ['app-update'] } } };
  fs.writeFileSync(p.payloadFile, JSON.stringify(m)); p.payloadSha256 = sha256(p.payloadFile);
  const bytes = fs.readFileSync(p.payloadFile), envelope = { kid: id.kid, payload: bytes.toString('base64url'), sig: sign(bytes, pair.privateKey).toString('base64url') };
  return { dir, pair, id, now, p, m, trust, bytes, envelope };
}
for (const platform of ['darwin', 'win32']) test(platform + ': shared update verifier and signing plan accept software P-256 raw r||s', t => {
  const f = fixture(t, platform);
  assert.equal(verifyManifest(f.envelope, f.trust, { now: f.now }).version, f.m.version);
  let calls = 0;
  const result = signFromSecureEnclave(f.p, { keys: f.trust, now: f.now, vault: { sign(kid, spki, bytes) { calls++; assert.equal(kid, f.id.kid); assert.equal(spki, f.id.spkiB64); assert.deepEqual(bytes, f.bytes); return sign(bytes, f.pair.privateKey); } } });
  assert.equal(calls, 1); assert.equal(verifyManifest(JSON.parse(fs.readFileSync(result.output)), f.trust, { now: f.now }).version, f.m.version);
});
test('P-256 verifier rejects algorithm confusion, wrong curve/encoding, tampering, unknown and revoked kids', t => {
  const f = fixture(t), entry = f.trust.keys[f.id.kid];
  for (const alg of ['ed25519', 'ES256', 'unknown', null, undefined]) assert.throws(() => verifyManifest(f.envelope, { ...f.trust, keys: { [f.id.kid]: { ...entry, alg } } }, { now: f.now }));
  for (const e of [ { ...f.envelope, alg: 'p256-sha256' }, { ...f.envelope, kid: 'unknown' }, { ...f.envelope, sig: Buffer.alloc(64).toString('base64url') }, { ...f.envelope, payload: Buffer.from(JSON.stringify({ ...f.m, version: '9.9.9' })).toString('base64url') }, { ...f.envelope, sig: c.sign('sha256', f.bytes, f.pair.privateKey).toString('base64url') } ]) assert.throws(() => verifyManifest(e, f.trust, { now: f.now }));
  assert.throws(() => verifyManifest(f.envelope, { ...f.trust, revokedKids: [f.id.kid] }, { now: f.now }));
  const other = c.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  assert.throws(() => verifyManifest({ ...f.envelope, sig: sign(f.bytes, other.privateKey).toString('base64url') }, { ...f.trust, keys: { [f.id.kid]: { ...entry, spkiB64: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } } }, { now: f.now }));
});
test('registered Ed25519 remains compatible and cannot be relabelled as P-256', t => {
  const f = fixture(t), pair = c.generateKeyPairSync('ed25519'), entry = { spkiB64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), purposes: ['app-update'] };
  const e = { ...f.envelope, sig: c.sign(null, f.bytes, pair.privateKey).toString('base64url') };
  for (const alg of [undefined, 'ed25519']) assert.equal(verifyManifest(e, { ...f.trust, keys: { [f.id.kid]: { ...entry, alg } } }, { now: f.now }).version, f.m.version);
  assert.throws(() => verifyManifest(e, { ...f.trust, keys: { [f.id.kid]: { ...entry, alg: 'p256-sha256' } } }, { now: f.now }));
  assert.ok(Object.values(stable.keys).every(k => k.alg === 'ed25519')); // No new live kid registered.
});
test('duplicate JSON names, including nested and escaped aliases, refuse before signer and at verification', t => {
  const f = fixture(t);
  const duplicates = [
    f.bytes.toString().replace('"version":', '"version":"9.9.9","version":'),
    f.bytes.toString().replace('"sha256":', '"sha256":"' + 'b'.repeat(64) + '","sha256":'),
    f.bytes.toString().replace('"version":', '"ver\\u0073ion":"9.9.9","version":'),
    f.bytes.toString().replace('"notes":', '"extra":[{"x":1,"x":2}],"notes":'),
  ];
  for (const text of duplicates) {
    const bytes = Buffer.from(text);
    const envelope = { kid: f.id.kid, payload: bytes.toString('base64url'), sig: sign(bytes, f.pair.privateKey).toString('base64url') };
    assert.throws(() => verifyManifest(envelope, f.trust, { now: f.now }), /format/);
    fs.writeFileSync(f.p.payloadFile, bytes); f.p.payloadSha256 = sha256(f.p.payloadFile);
    let calls = 0;
    assert.throws(() => signFromSecureEnclave(f.p, { keys: f.trust, now: f.now, vault: { sign() { calls++; } } }), /format/);
    assert.equal(calls, 0); assert.equal(fs.existsSync(f.p.outputFile), false);
  }
});
test('legacy Ed25519 pretty payloads and escaped text remain valid, null algorithm refuses before signer', t => {
  const f = fixture(t), pair = c.generateKeyPairSync('ed25519');
  const spkiB64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const keys = { ...f.trust, keys: { [f.id.kid]: { spkiB64, purposes: ['app-update'] } } };
  f.m.notes.ja = 'quote "version": and \\ backslash; 日本語';
  f.m.extra = [{ repeated: 1 }, { repeated: 2 }];
  const bytes = Buffer.from(JSON.stringify(f.m, null, 2) + '\n');
  const envelope = { kid: f.id.kid, payload: bytes.toString('base64url'), sig: c.sign(null, bytes, pair.privateKey).toString('base64url') };
  assert.equal(verifyManifest(envelope, keys, { now: f.now }).notes.ja, f.m.notes.ja);
  fs.writeFileSync(f.p.payloadFile, bytes); f.p.payloadSha256 = sha256(f.p.payloadFile); f.p.spkiB64 = spkiB64;
  let calls = 0;
  assert.throws(() => signFromKeychain(f.p, { keys: { ...keys, keys: { [f.id.kid]: { ...keys.keys[f.id.kid], alg: null } } }, now: f.now, vault: { sign() { calls++; } } }));
  assert.equal(calls, 0);
  const result = signFromKeychain(f.p, { keys, now: f.now, vault: { sign(_kid, _spki, data) { calls++; return c.sign(null, data, pair.privateKey); } } });
  assert.equal(calls, 1); assert.equal(verifyManifest(JSON.parse(fs.readFileSync(result.output)), keys, { now: f.now }).version, f.m.version);
});
test('pre-SE helper receipt stays usable unchanged while SE mode still requires current source and runtime receipt', t => {
  const directory = space(t), binary = path.join(directory, 'release-keychain'), receipt = path.join(directory, 'helper.json');
  fs.writeFileSync(binary, 'old helper fixture', { mode: 0o700 });
  const state = { sourceSha256: '7288b4ed29d69c62cc17eccdc2fef0f18e1dabfb89620b48e85ff114235b02f2', binarySha256: c.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') };
  fs.writeFileSync(receipt, JSON.stringify(state), { mode: 0o600 }); const before = fs.readFileSync(receipt);
  assert.equal(installedHelper({ directory }), binary);
  assert.equal(prepareHelper({ directory, platform: 'darwin', run() { assert.fail('must not rebuild old helper'); } }), binary);
  const kid = 'hub-ed25519-' + 'a'.repeat(43); let calls = 0;
  const vault = keychain({ directory, platform: 'darwin', run(file, argv, options) {
    calls++; assert.equal(file, binary); assert.deepEqual(argv, []);
    assert.equal(JSON.parse(options.input).action, 'sign');
    return Buffer.from(JSON.stringify({ kid, spkiB64: 'public', sig: Buffer.alloc(64, 1).toString('base64') }));
  } });
  assert.equal(vault.sign(kid, 'public', Buffer.from('fixture')).length, 64); assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(receipt), before); assert.equal(fs.readFileSync(binary, 'utf8'), 'old helper fixture');
  assert.throws(() => installedHelper({ directory, hardenedRuntime: true }));
  assert.throws(() => prepareEnclaveHelper({ directory, platform: 'darwin', run() { assert.fail('must not rebuild'); } }));
  fs.writeFileSync(receipt, JSON.stringify({ ...state, sourceSha256: 'a'.repeat(64) })); assert.throws(() => installedHelper({ directory }));
  fs.writeFileSync(receipt, before); fs.appendFileSync(binary, 'changed'); assert.throws(() => installedHelper({ directory }));
});
test('revocation, mode mismatch and changed candidate refuse before signer; cancel/bad signature writes nothing', t => {
  for (const fault of ['revoked', 'wrong-mode', 'changed', 'license-payload', 'cancel', 'bad-signature', 'changed-during-sign']) {
    const f = fixture(t); let calls = 0;
    const keys = fault === 'revoked' ? { ...f.trust, revokedKids: [f.id.kid] } : f.trust;
    if (fault === 'changed') fs.appendFileSync(f.p.assetFile, 'changed');
    if (fault === 'license-payload') { fs.writeFileSync(f.p.payloadFile, JSON.stringify({ ...f.m, typ: 'hub-license' })); f.p.payloadSha256 = sha256(f.p.payloadFile); }
    const vault = { sign() { calls++; if (fault === 'cancel') throw Error('SECRET_MARKER'); if (fault === 'changed-during-sign') { fs.appendFileSync(f.p.assetFile, 'changed'); return sign(f.bytes, f.pair.privateKey); } return Buffer.alloc(64); } };
    assert.throws(() => (fault === 'wrong-mode' ? signFromKeychain : signFromSecureEnclave)(f.p, { keys, now: f.now, vault }), e => !e.message.includes('SECRET_MARKER'));
    assert.equal(calls, ['cancel', 'bad-signature', 'changed-during-sign'].includes(fault) ? 1 : 0); assert.equal(fs.existsSync(f.p.outputFile), false);
  }
});
function helper(t) {
  const root = space(t), directory = path.join(root, 'helper'), references = path.join(root, 'references'), source = path.join(root, 'source.swift'), calls = [];
  fs.writeFileSync(source, '// software test only');
  prepareEnclaveHelper({ directory, source, platform: 'darwin', run(file, args) { calls.push([file, args]); if (file === '/usr/bin/xcrun') fs.writeFileSync(args.at(-1), 'fixture-helper'); } });
  assert.deepEqual(calls.map(x => x[0]), ['/usr/bin/xcrun', '/usr/bin/codesign', '/usr/bin/codesign']);
  assert.ok(calls[1][1].includes('runtime')); return { directory, references, source, platform: 'darwin' };
}
test('explicit mock creation, public export and sign keep sealed reference out of return/log and use private files/pipes', t => {
  const f = fixture(t), options = helper(t), requests = [], buffers = [];
  const vault = secureEnclave({ ...options, run(_binary, argv, o) {
    assert.deepEqual(argv, []); assert.deepEqual(o.stdio, ['pipe', 'pipe', 'inherit']);
    const r = JSON.parse(o.input); requests.push(r); buffers.push(o.input);
    const result = { ...f.id, ...(r.action === 'se-create' ? { referenceB64: Buffer.from('sealed fixture, no secret').toString('base64') } : r.action === 'se-sign' ? { sig: sign(Buffer.from(r.payload, 'base64'), f.pair.privateKey).toString('base64') } : {}) };
    const out = Buffer.from(JSON.stringify(result)); buffers.push(out); return out;
  } });
  assert.deepEqual(vault.create(), f.id); assert.deepEqual(vault.publicKey(f.id.kid), f.id);
  assert.equal(c.verify('sha256', f.bytes, { key: f.pair.publicKey, dsaEncoding: 'ieee-p1363' }, vault.sign(f.id.kid, f.id.spkiB64, f.bytes)), true);
  assert.deepEqual(requests.map(x => x.action), ['se-create', 'se-check', 'se-sign']);
  assert.equal(requests[0].value, undefined); assert.equal(fs.statSync(options.references).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(options.references, f.id.kid + '.json')).mode & 0o777, 0o600);
  assert.ok(buffers.every(b => b.every(x => x === 0)));
  assert.throws(() => vault.create()); // Exclusive write, no replacement.
});
test('unprepared helper cannot create a key; cancellation has no fallback', t => {
  const f = fixture(t), options = helper(t); let calls = 0;
  const vault = secureEnclave({ ...options, run() { calls++; throw Object.assign(Error('SECRET_MARKER'), { stdout: 'SECRET_MARKER' }); } });
  assert.throws(() => vault.create(), e => !e.message.includes('SECRET_MARKER')); assert.equal(calls, 1);
  fs.unlinkSync(path.join(options.directory, 'release-keychain'));
  assert.throws(() => vault.create()); assert.equal(calls, 1);
  assert.throws(() => vault.sign(f.id.kid, f.id.spkiB64, f.bytes)); assert.equal(calls, 1);
});
test('a changed public identity or broad reference permissions refuse before helper invocation', t => {
  const f = fixture(t), options = helper(t); let calls = 0;
  const vault = secureEnclave({ ...options, run() { calls++; return Buffer.from(JSON.stringify({ ...f.id, referenceB64: Buffer.from('fixture').toString('base64') })); } });
  vault.create(); const file = path.join(options.references, f.id.kid + '.json'), before = fs.readFileSync(file);
  const record = JSON.parse(before); record.spkiB64 = identity(c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })).spkiB64;
  fs.writeFileSync(file, JSON.stringify(record)); assert.throws(() => vault.sign(f.id.kid, f.id.spkiB64, f.bytes)); assert.equal(calls, 1);
  fs.writeFileSync(file, before); fs.chmodSync(file, 0o644); assert.throws(() => vault.publicKey(f.id.kid)); assert.equal(calls, 1);
});
test('reference extra fields cannot override action, account or payload; SE receipt cannot lose runtime requirement', t => {
  const f = fixture(t), options = helper(t); let calls = 0;
  const vault = secureEnclave({ ...options, run() { calls++; return Buffer.from(JSON.stringify({ ...f.id, referenceB64: Buffer.from('fixture').toString('base64') })); } });
  vault.create(); const file = path.join(options.references, f.id.kid + '.json'), original = JSON.parse(fs.readFileSync(file));
  for (const field of ['action', 'account', 'payload', 'unknown']) {
    fs.writeFileSync(file, JSON.stringify({ ...original, [field]: 'overridden' }));
    assert.throws(() => vault.publicKey(f.id.kid)); assert.throws(() => vault.sign(f.id.kid, f.id.spkiB64, f.bytes));
    assert.equal(calls, 1);
  }
  fs.writeFileSync(file, JSON.stringify(original));
  const receipt = path.join(options.directory, 'helper.json'), state = JSON.parse(fs.readFileSync(receipt));
  delete state.hardenedRuntime; fs.writeFileSync(receipt, JSON.stringify(state));
  assert.throws(() => vault.publicKey(f.id.kid)); assert.equal(calls, 1);
});
// Load the actual preparation source with fixture-only public trust and a tiny
// verified-package stand-in. Do not alter the installed trust or build an App.
function backupPreparation(t, trust, platform = 'darwin') {
  const root = space(t), base = path.join(root, 'package'); fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'release-manifest.json'), JSON.stringify({ platform }));
  fs.writeFileSync(path.join(base, 'fixture.txt'), 'software fixture');
  const file = path.join(__dirname, '../release-app/package-update.cjs');
  const localRequire = require('node:module').createRequire(file), mod = { exports: {} };
  const nativeRuntime = path.join(base, 'hub/release-app/runtime.cjs'); let inspections = 0;
  const injected = id => id === './update-trust.cjs' ? trust : id === nativeRuntime ? { verifyPackage(_base, actualPlatform) {
    inspections++; assert.equal(_base, base); assert.equal(actualPlatform, platform);
    return { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', releaseVersion: '4.125.2', shellProtocol: 1, windowsNativePrepared: true, source: 'fixture', distribution: 'publisher-free' };
  } } : localRequire(id);
  require('node:vm').runInNewContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { Buffer })(injected, mod, mod.exports);
  return { root, base, inspections: () => inspections, prepare: mod.exports.prepare };
}
function softwareIdentity(alg) {
  const pair = alg === 'p256-sha256' ? c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : c.generateKeyPairSync('ed25519');
  const id = alg === 'p256-sha256' ? identity(pair) : {
    kid: 'hub-ed25519-' + require('../lib/license/codec').fingerprint(pair.publicKey),
    spkiB64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), alg,
  };
  return { pair, id, entry: { ...id, purposes: ['app-update'] } };
}
for (const backupAlg of ['p256-sha256', 'ed25519']) test('backup preparation selects each key and recovers lost normal key: ' + backupAlg, t => {
  const normal = softwareIdentity('p256-sha256'), backup = softwareIdentity(backupAlg), old = softwareIdentity('ed25519');
  const keys = { ...runtime, keys: Object.fromEntries([normal, backup, old].map(k => [k.id.kid, k.entry])), revokedKids: [] };
  const now = 1800000000000;
  for (const platform of ['darwin', 'win32']) {
    const f = backupPreparation(t, keys, platform);
    const refused = path.join(f.root, 'ambiguous');
    assert.throws(() => f.prepare(f.base, refused, { seq: 9, now }), /signing_key_required/);
    assert.equal(fs.existsSync(refused), false); assert.equal(f.inspections(), 0);
    const signed = new Map();
    function prepareSigned(key, seq, label) {
      const out = path.join(f.root, label), result = f.prepare(f.base, out, { seq, now, kid: key.id.kid });
      const plan = loadPlan(path.join(out, 'sign-plan.json'), result.signPlanSha256);
      assert.equal(plan.kid, key.id.kid); assert.equal(plan.spkiB64, key.id.spkiB64); assert.equal(result.kid, key.id.kid);
      const signer = key.id.alg === 'ed25519' ? signFromKeychain : signFromSecureEnclave;
      const complete = signer(plan, { keys, now, vault: { sign(kid, spki, bytes) {
        assert.equal(kid, key.id.kid); assert.equal(spki, key.id.spkiB64);
        return key.id.alg === 'ed25519' ? c.sign(null, bytes, key.pair.privateKey) : sign(bytes, key.pair.privateKey);
      } } });
      const envelope = JSON.parse(fs.readFileSync(complete.output));
      assert.equal(verifyManifest(envelope, keys, { now }).seq, seq);
      return { envelope, result, out };
    }
    for (const key of [normal, backup, old]) {
      const prepared = prepareSigned(key, 9, key.id.kid);
      signed.set(key.id.kid, prepared.envelope);
      assert.throws(() => verifyManifest(prepared.envelope, { ...keys, revokedKids: [key.id.kid] }, { now }), /key/);
    }
    // Revocation belongs to the new App's trusted constants, not to an envelope
    // field. Authenticate the recovery archive before using its fixture trust.
    const nextNormal = softwareIdentity('p256-sha256'), nextBackup = softwareIdentity(backupAlg);
    const recoveredTrust = { ...keys, keys: { ...keys.keys, [nextNormal.id.kid]: nextNormal.entry, [nextBackup.id.kid]: nextBackup.entry }, revokedKids: [normal.id.kid, old.id.kid] };
    fs.writeFileSync(path.join(f.base, 'update-trust-fixture.json'), JSON.stringify(recoveredTrust));
    const recovery = prepareSigned(backup, 10, 'recovery');
    const manifest = verifyManifest(recovery.envelope, keys, { now, maxSeq: 9 });
    const archive = fs.readFileSync(path.join(recovery.out, recovery.result.asset));
    assert.equal(c.createHash('sha256').update(archive).digest('hex'), manifest.asset.sha256);
    const unpacked = path.join(f.root, 'recovered'); require('../lib/update-zip').unpack(archive, unpacked);
    const installedTrust = JSON.parse(fs.readFileSync(path.join(unpacked, 'update-trust-fixture.json')));
    assert.throws(() => verifyManifest(signed.get(normal.id.kid), installedTrust, { now }), /key/);
    assert.throws(() => verifyManifest(signed.get(old.id.kid), installedTrust, { now }), /key/);
    assert.equal(verifyManifest(recovery.envelope, installedTrust, { now }).seq, 10);
    for (const key of [nextNormal, nextBackup]) {
      const bytes = Buffer.from(JSON.stringify({ ...manifest, seq: 11 }));
      const sig = key.id.alg === 'ed25519' ? c.sign(null, bytes, key.pair.privateKey) : sign(bytes, key.pair.privateKey);
      assert.equal(verifyManifest({ kid: key.id.kid, payload: bytes.toString('base64url'), sig: sig.toString('base64url') }, installedTrust, { now, maxSeq: 10 }).seq, 11);
    }
  }
});
test('backup preparation preserves one-key default and refuses revoked, unknown or non-update choices before output', t => {
  const one = softwareIdentity('ed25519'), proof = softwareIdentity('ed25519');
  const keys = { ...runtime, keys: { [one.id.kid]: one.entry, [proof.id.kid]: { ...proof.entry, purposes: ['proof'] } }, revokedKids: [] };
  const f = backupPreparation(t, keys), now = 1800000000000;
  const result = f.prepare(f.base, path.join(f.root, 'default'), { seq: 1, now }); assert.equal(result.kid, one.id.kid);
  for (const kid of ['unknown', proof.id.kid, null, '', '__proto__']) {
    const out = path.join(f.root, 'bad-' + String(kid));
    assert.throws(() => f.prepare(f.base, out, { seq: 2, now, kid }), /signing_key_invalid/); assert.equal(fs.existsSync(out), false);
  }
  const revoked = backupPreparation(t, { ...keys, revokedKids: [one.id.kid] }), out = path.join(revoked.root, 'bad-revoked');
  assert.throws(() => revoked.prepare(revoked.base, out, { seq: 1, now, kid: one.id.kid }), /signing_key_invalid/);
  assert.throws(() => revoked.prepare(revoked.base, out, { seq: 1, now }), /signing_key_invalid/);
  assert.equal(fs.existsSync(out), false); assert.equal(revoked.inspections(), 0);
  // The current production registration still has exactly one update key.
  const actual = backupPreparation(t, runtime);
  assert.equal(actual.prepare(actual.base, path.join(actual.root, 'current'), { seq: 1, now }).kid, Object.keys(runtime.keys)[0]);
});
test('production Swift typechecks without executing helper, Keychain or authentication', { skip: process.platform !== 'darwin' }, t => {
  const dir = space(t);
  execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-typecheck', '-module-cache-path', path.join(dir, 'modules'), path.join(__dirname, '../../scripts/release-keychain.swift')], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
});
