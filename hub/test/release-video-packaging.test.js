'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), crypto = require('node:crypto');
const shared = require('../purchase-test-app/build.cjs'), zip = require('../lib/update-zip');
const repo = path.resolve(__dirname, '../..'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const video = ['VIDEO.md', 'transcribe-video.py', 'video-environment-macos-arm64.txt',
  'video-requirements-cpu.txt', 'video-requirements-mlx.txt', 'video-requirements.txt'].map(n => 'hub/tools/' + n);
const unwanted = ['hub/.venv-video/bin/python', 'hub/.venv-video/Scripts/python.exe',
  'hub/tools/.venv-video/bin/python', 'hub/tools/__pycache__/transcribe-video.pyc',
  'hub/tools/models/weights.npz', 'hub/tools/.cache/huggingface/model.bin',
  'hub/tools/video-requirements-private.txt', 'hub/tools/transcribe-video.py.bak', 'hub/tools/other.py'];

for (const name of video) test('both distribution selectors include ' + name, () => {
  for (const platform of ['darwin', 'win32']) assert.equal(shared.include(name, platform), true, platform);
});
test('video allowlist excludes environments, models, caches and unrelated tools while retaining existing selections', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const name of [...unwanted, 'hub/lib/license/owner-edition.js', 'hub/lib/license/mac-native',
      'hub/license-issuer/worker.mjs', 'hub/test/video.test.js']) assert.equal(shared.include(name, platform), false, name);
    for (const name of ['hub/server.js', 'hub/package.json', 'hub/CHANGELOG.md', 'hub/lib/video-transcript.js',
      'hub/public/icon.png', 'hub/paid/delegate.js', 'docs/project-hub/templates/rules.md', 'LICENSE']) {
      assert.equal(shared.include(name, platform), true, name);
    }
    assert.equal(shared.include('hub/app/windows/Program.cs', platform), platform === 'win32');
  }
});

// Run the real compiler with an in-memory destination and synthetic Git inventory.
// Native compilation/signing and dependency collection are replaced; no App or
// distribution candidate is produced. Source transformations and put paths run normally.
function compiledFixture(platform) {
  const destination = '/private/tmp/hub-video-packaging-memory-' + platform;
  const base = platform === 'darwin' ? path.join(destination, 'Project Hub.app/Contents/Resources/runtime')
    : path.join(destination, 'ProjectHub-Windows');
  const output = new Map(), modes = new Map();
  const binary = Buffer.from([0, 255, 128, 10]);
  const names = [...video, ...unwanted, 'hub/lib/video-transcript.js', 'hub/package.json', 'hub/public/icon.png'];
  const blob = name => name === 'hub/public/icon.png' ? binary : fs.readFileSync(path.join(repo, name));
  const memoryFs = {
    existsSync: name => output.has(name), mkdirSync() {},
    writeFileSync(name, bytes, options) {
      if (options?.flag === 'wx') assert.equal(output.has(name), false, name);
      output.set(name, Buffer.from(bytes)); modes.set(name, options?.mode);
    },
    readFileSync(name, encoding) {
      const bytes = output.get(name) || fs.readFileSync(name);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    chmodSync(name, mode) { assert.ok(output.has(name)); modes.set(name, mode); },
    statSync(name) { assert.ok(output.has(name)); return { size: output.get(name).length }; }
  };
  const child = { execFileSync(command, args) {
    if (command === 'git') {
      if (args[0] === 'ls-tree') return Buffer.from(names.map(name => '100644 blob fixture\t' + name + '\0').join(''));
      assert.equal(args[0], 'show'); return blob(args[1].slice(41));
    }
    if (command === '/usr/bin/swiftc') {
      const file = args[args.indexOf('-o') + 1]; memoryFs.writeFileSync(file, 'synthetic-native'); return Buffer.alloc(0);
    }
    assert.equal(command, '/usr/bin/codesign'); return Buffer.alloc(0);
  } };
  let verified = 0;
  const file = path.join(repo, 'hub/release-app/build.cjs'), m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  const original = m.require.bind(m);
  m.require = id => id === 'node:fs' ? memoryFs : id === 'node:child_process' ? child
    : id === '../purchase-test-app/build.cjs' ? { ...shared, macIcon() {}, dependencyFiles: () => [] }
    : id === path.join(base, 'hub/lib/license/policy.js') ? { forPlatform: () => ({}) }
    : id === path.join(base, 'hub/release-app/runtime.cjs') ? { verifyPackage(root, target) {
      assert.equal(root, base); assert.equal(target, platform); verified++;
      const manifest = JSON.parse(output.get(path.join(base, 'release-manifest.json')));
      for (const row of manifest.files) {
        assert.equal(sha(output.get(path.join(base, row.path))), row.sha256);
        assert.equal(modes.get(path.join(base, row.path)), row.mode);
      }
    } } : original(id);
  m._compile(fs.readFileSync(file, 'utf8'), file);
  m.exports.build('a'.repeat(40), destination, platform, '4.126.96');
  assert.equal(verified, 1);
  const manifest = JSON.parse(output.get(path.join(base, 'release-manifest.json')));
  return { base, output, manifest, binary };
}

for (const platform of ['darwin', 'win32']) test(platform + ': real release copy paths and unsigned runtime retain all video support bytes', t => {
  const f = compiledFixture(platform);
  for (const name of video) {
    const row = f.manifest.files.find(r => r.path === name);
    assert.ok(row, name); assert.equal(row.mode, 0o644);
    assert.deepEqual(f.output.get(path.join(f.base, name)), fs.readFileSync(path.join(repo, name)));
  }
  for (const name of unwanted) assert.equal(f.manifest.files.some(r => r.path === name), false, name);
  assert.deepEqual(f.output.get(path.join(f.base, 'hub/public/icon.png')), f.binary);
  const caller = f.output.get(path.join(f.base, 'hub/lib/video-transcript.js')).toString();
  assert.match(caller, /path\.join\(__dirname, '\.\.', 'tools', 'transcribe-video\.py'\)/);

  // Only a small fixture of the compiled runtime is materialized for the actual
  // unsigned payload writer and ZIP reader; no release build or native code runs.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-video-runtime-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'input'); fs.mkdirSync(base);
  const put = (name, bytes) => { const p = path.join(base, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); };
  for (const name of [...video, 'hub/lib/video-transcript.js']) {
    const bytes = f.output.get(path.join(f.base, name)); assert.ok(bytes, name); put(name, bytes);
  }
  const manifest = { ...f.manifest, windowsNativePrepared: true };
  put('release-manifest.json', JSON.stringify(manifest));
  put('hub/release-app/runtime.cjs', 'exports.verifyPackage=base=>JSON.parse(require("node:fs").readFileSync(require("node:path").join(base,"release-manifest.json")));');
  const prepared = require('../release-app/package-update.cjs').prepare(base, path.join(root, 'unsigned'), { seq: 1, now: 1800000000000 });
  assert.equal(prepared.signed, false); assert.equal(prepared.publishReady, false);
  const archive = fs.readFileSync(path.join(root, 'unsigned', prepared.asset));
  assert.equal(sha(archive), prepared.sha256);
  const readback = path.join(root, 'readback'), tree = zip.unpack(archive, readback);
  assert.deepEqual(tree, prepared.tree);
  for (const name of video) assert.deepEqual(fs.readFileSync(path.join(readback, name)), fs.readFileSync(path.join(repo, name)));
  for (const name of unwanted) assert.equal(fs.existsSync(path.join(readback, name)), false, name);
});
