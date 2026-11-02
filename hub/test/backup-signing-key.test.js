'use strict';
// Software fixtures only. Never access a USB, actual signing key or helper.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), c = require('node:crypto');
const { PassThrough } = require('node:stream'), { spawnSync } = require('node:child_process');
const { createBackup, checkBackup, withBackupKey, readHidden } = require('../../scripts/backup-signing-key');
const { sha256, loadPlan, signFromBackup } = require('../../scripts/sign-update');
const { verifyManifest } = require('../lib/app-update-packaged');
const runtime = require('../release-app/update-trust.cjs');
const password = () => Buffer.from('software fixture passphrase only');
const wiped = b => assert.ok(b.every(byte => byte === 0));
function space(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-backup-fixture-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function fixture(t) {
  const dir = space(t), file = path.join(dir, 'backup.encrypted.json'), pass = password(), id = createBackup(file, pass);
  wiped(pass);
  const now = 1800000000000, name = 'Project-Hub-4.125.2-Runtime-Apple-Silicon.zip';
  const asset = path.join(dir, name); fs.writeFileSync(asset, 'zip');
  const m = { v: 1, typ: 'hub-app-update', product: 'project-hub', edition: 'public', lang: 'ja', version: '4.125.2', seq: 8,
    issuedAt: now / 1000, expiresAt: now / 1000 + 86400, kind: 'bugfix', product_line: 'project-hub-4.123', bugfixOf: ['project-hub-4.123'],
    requires: { os: 'darwin', arch: 'arm64', node: '>=22', minMacOS: '13.0' },
    asset: { name, size: 3, sha256: sha256(asset), url: runtime.assetPrefix + 'v4.125.2/' + name },
    app: { format: 'release-runtime-v1', runtime: 'hub', shellProtocol: 1, bundleId: 'local.projecthub', shortVersion: '4.125.2', entries: 2, treeSha256: 'a'.repeat(64) }, notes: { ja: 'software fixture only' } };
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(m));
  const plan = { format: 'project-hub-existing-key-sign-plan-v1', runtimeProtocol: 1, ...id,
    payload: 'payload.json', asset: name, output: 'signed.json', assetSha256: sha256(asset), payloadSha256: sha256(path.join(dir, 'payload.json')) };
  const planFile = path.join(dir, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan));
  const p = loadPlan(planFile, sha256(planFile)), keys = { ...runtime, keys: { [id.kid]: { ...id, purposes: ['app-update'] } } };
  return { dir, file, id, now, m, p, keys, planFile };
}
test('encrypted backup creation, no-file self-check and checked-plan signing round trip', t => {
  const f = fixture(t), before = fs.readdirSync(f.dir).sort(), pass = password();
  assert.deepEqual(checkBackup(f.file, pass), { ...f.id, verified: true }); wiped(pass);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
  const signingPass = password();
  const result = signFromBackup(f.p, { file: f.file, passphrase: signingPass, keys: f.keys, now: f.now }); wiped(signingPass);
  const envelope = JSON.parse(fs.readFileSync(result.output));
  assert.equal(envelope.kid, f.id.kid); assert.equal(verifyManifest(envelope, f.keys, { now: f.now }).version, f.m.version);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600); assert.equal(fs.statSync(result.output).mode & 0o777, 0o600);
  assert.equal(Object.keys(f.id).sort().join(','), 'alg,kid,spkiB64');
  assert.match(f.id.kid, /^hub-backup-ed25519-[A-Za-z0-9_-]{43}$/);
});
test('wrong or short passphrase refuses without output and consumes its buffer', t => {
  const f = fixture(t), wrong = Buffer.from('incorrect software fixture passphrase');
  assert.throws(() => checkBackup(f.file, wrong), /backup_key_invalid/); wiped(wrong);
  const tooShort = Buffer.from('short');
  assert.throws(() => createBackup(path.join(f.dir, 'short.json'), tooShort)); wiped(tooShort);
  const pass = Buffer.from('another incorrect fixture passphrase');
  assert.throws(() => signFromBackup(f.p, { file: f.file, passphrase: pass, keys: f.keys, now: f.now })); wiped(pass);
  assert.equal(fs.existsSync(f.p.outputFile), false); assert.equal(fs.existsSync(path.join(f.dir, 'short.json')), false);
});
test('every header field, KDF limits and authenticated ciphertext/IV/tag detect tampering', t => {
  const f = fixture(t), original = JSON.parse(fs.readFileSync(f.file));
  const mutations = [
    r => r.header.format += '-changed', r => r.header.kid += 'x', r => r.header.alg = 'p256-sha256',
    r => r.header.spkiB64 = c.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    r => r.header.cipher = 'aes-256-cbc', r => r.header.kdf.name = 'pbkdf2', r => r.header.kdf.N = 2 ** 30,
    r => r.header.kdf.r = 16, r => r.header.kdf.p = 2, r => r.header.kdf.salt = c.randomBytes(32).toString('base64'),
    r => r.header.extra = 'not allowed', r => r.header.kdf.extra = 1,
    ...['iv', 'ciphertext', 'tag'].map(field => r => { const b = Buffer.from(r[field], 'base64'); b[0] ^= 1; r[field] = b.toString('base64'); }),
    r => r.extra = 1,
  ];
  for (const mutate of mutations) {
    const record = structuredClone(original); mutate(record); fs.writeFileSync(f.file, JSON.stringify(record));
    const pass = password(); assert.throws(() => checkBackup(f.file, pass), /backup_key_invalid/); wiped(pass);
  }
  const text = JSON.stringify(original).replace('"alg":', '"alg":"ed25519","alg":');
  fs.writeFileSync(f.file, text); assert.throws(() => checkBackup(f.file, password()));
  assert.equal(fs.existsSync(f.p.outputFile), false);
});
test('existing files, symlinks, linked or overly readable encrypted files are never accepted/overwritten', t => {
  const f = fixture(t), saved = fs.readFileSync(f.file), pass = password();
  assert.throws(() => createBackup(f.file, pass)); wiped(pass); assert.deepEqual(fs.readFileSync(f.file), saved);
  const link = path.join(f.dir, 'link'); fs.symlinkSync(f.file, link);
  assert.throws(() => createBackup(link, password())); assert.throws(() => checkBackup(link, password()));
  const hard = path.join(f.dir, 'hard'); fs.linkSync(f.file, hard);
  assert.throws(() => checkBackup(f.file, password())); fs.unlinkSync(hard);
  fs.chmodSync(f.file, 0o644); assert.throws(() => checkBackup(f.file, password()));
  assert.deepEqual(fs.readFileSync(f.file), saved);
});
test('failed encrypted-file flush removes only its new file and erases the passphrase', t => {
  const dir = space(t), file = path.join(dir, 'incomplete.encrypted.json'), pass = password();
  const mocked = t.mock.method(fs, 'fsyncSync', () => { throw Error('fixture write error'); });
  try { assert.throws(() => createBackup(file, pass), /backup_key_invalid/); }
  finally { mocked.mock.restore(); }
  wiped(pass); assert.deepEqual(fs.readdirSync(dir), []);
});
test('revoked, unregistered, wrong algorithm/identity and changed plans/assets refuse without output', t => {
  const f = fixture(t);
  for (const keys of [ { ...f.keys, revokedKids: [f.id.kid] }, { ...f.keys, keys: {} },
    { ...f.keys, keys: { [f.id.kid]: { ...f.keys.keys[f.id.kid], alg: 'p256-sha256' } } },
    { ...f.keys, keys: { [f.id.kid]: { ...f.keys.keys[f.id.kid], spkiB64: 'other public key' } } } ]) {
    const pass = password(); assert.throws(() => signFromBackup(f.p, { file: f.file, passphrase: pass, keys, now: f.now })); wiped(pass);
  }
  assert.throws(() => loadPlan(f.planFile, '0'.repeat(64)));
  fs.appendFileSync(f.p.assetFile, 'changed');
  assert.throws(() => signFromBackup(f.p, { file: f.file, passphrase: password(), keys: f.keys, now: f.now }));
  assert.equal(fs.existsSync(f.p.outputFile), false);
});
test('signer rejects a different independent backup and never overwrites a completed envelope', t => {
  const f = fixture(t), other = path.join(f.dir, 'other.encrypted.json'); createBackup(other, password());
  assert.throws(() => signFromBackup(f.p, { file: other, passphrase: password(), keys: f.keys, now: f.now }));
  assert.equal(fs.existsSync(f.p.outputFile), false);
  signFromBackup(f.p, { file: f.file, passphrase: password(), keys: f.keys, now: f.now });
  const before = fs.readFileSync(f.p.outputFile);
  assert.throws(() => signFromBackup(f.p, { file: f.file, passphrase: password(), keys: f.keys, now: f.now }));
  assert.deepEqual(fs.readFileSync(f.p.outputFile), before);
});
test('candidate mutation during backup signing refuses before creating an envelope', t => {
  const f = fixture(t), original = c.sign;
  const mocked = t.mock.method(c, 'sign', function(...args) {
    const signature = original.apply(this, args); fs.appendFileSync(f.p.assetFile, 'changed during signing'); return signature;
  });
  const pass = password();
  try { assert.throws(() => signFromBackup(f.p, { file: f.file, passphrase: pass, keys: f.keys, now: f.now })); }
  finally { mocked.mock.restore(); }
  wiped(pass); assert.equal(fs.existsSync(f.p.outputFile), false);
});
test('only encrypted key bytes and public envelope reach disk; no plaintext/private memo/password temp files', t => {
  const f = fixture(t); let der;
  withBackupKey(f.file, password(), key => { der = key.export({ type: 'pkcs8', format: 'der' }); });
  try {
    signFromBackup(f.p, { file: f.file, passphrase: password(), keys: f.keys, now: f.now });
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['backup.encrypted.json', 'payload.json', 'plan.json', 'signed.json', path.basename(f.p.assetFile)].sort());
    for (const name of fs.readdirSync(f.dir)) {
      const bytes = fs.readFileSync(path.join(f.dir, name));
      assert.equal(bytes.includes(der), false); assert.equal(bytes.includes(der.toString('base64')), false);
      assert.equal(bytes.includes('PRIVATE KEY'), false); assert.equal(bytes.includes(password()), false);
    }
  } finally { der?.fill(0); }
});
test('terminal input is hidden, clears chunks, restores raw mode, supports UTF-8 erase and cancellation', async () => {
  function terminal() {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    input.isTTY = output.isTTY = true; input.isRaw = false; input.pause();
    input.setRawMode = value => { input.isRaw = value; }; output.on('data', b => { text += b.toString(); });
    return { input, output, text: () => text };
  }
  const f = terminal(), answer = readHidden({ ...f, prompt: 'hidden: ' }), chunk = Buffer.from('fixture長\x7fphrase\r');
  f.input.write(chunk); const pass = await answer;
  assert.equal(pass.toString(), 'fixturephrase'); pass.fill(0); wiped(chunk);
  assert.equal(f.text(), 'hidden: \n'); assert.equal(f.input.isRaw, false); assert.equal(f.input.isPaused(), true);
  const cancelled = terminal(), pending = readHidden(cancelled), cancelChunk = Buffer.from('not displayed\x03');
  cancelled.input.write(cancelChunk); await assert.rejects(pending, /backup_key_cancelled/); wiped(cancelChunk);
  assert.equal(cancelled.input.isRaw, false); assert.equal(cancelled.input.listenerCount('data'), 0);
  assert.equal(cancelled.text().includes('not displayed'), false);
});
test('non-terminal and CLI secret-option attempts stop without creating files or reading a helper', async t => {
  await assert.rejects(readHidden({ input: new PassThrough(), output: new PassThrough() }), /requires_terminal/);
  const dir = space(t), file = path.join(dir, 'must-not-exist'), script = path.resolve(__dirname, '../../scripts/sign-update.js');
  for (const args of [['--create-backup-key', file], ['--check-backup-key', file], ['--create-backup-key', file, '--passphrase', 'invalid-fixture-option']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('invalid-fixture-option'), false); assert.equal(fs.existsSync(file), false);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
