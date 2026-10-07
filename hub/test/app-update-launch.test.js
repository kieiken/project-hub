'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-update-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), home = path.join(root, 'home'), apps = path.join(root, 'apps');
  for (const dir of [bin, home, apps]) fs.mkdirSync(dir);
  const script = (name, body) => { const file = path.join(bin, name); fs.writeFileSync(file, '#!/bin/bash\n' + body, { mode: 0o755 }); return file; };
  const env = { ...process.env, HOME: home, PATH: bin + ':/usr/bin:/bin', HUB_ROOT: path.join(root, 'workspace'), HUB_APP_DIR: apps, HUB_SKIP_NPM: '1', HUB_SKIP_APP: '1', HUB_NO_DESKTOP_LINK: '1', HUB_STORAGE_GUARD: '' };
  return { root, bin, home, apps, env, script, run: (name, extra = {}) => spawnSync('/bin/bash', [path.join(hub, name)], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 }) };
}
test('configured startup/setup/build guards stop before any logs or workspace writes; unset startup still works', t => {
  const f = fixture(t), guard = f.script('guard', 'exit 27\n');
  for (const name of ['app/run.sh', 'start.command', 'setup.sh', 'app/build-app.sh']) assert.equal(f.run(name, { HUB_STORAGE_GUARD: guard }).status, 27, name);
  assert.equal(fs.existsSync(path.join(f.home, 'Library')), false);
  assert.equal(fs.existsSync(f.env.HUB_ROOT), false);
  assert.deepEqual(fs.readdirSync(f.apps), []);
  f.script('curl', 'echo 200\n'); f.script('open', 'exit 0\n');
  assert.equal(f.run('app/run.sh').status, 0); assert.equal(f.run('start.command').status, 0);
});
test('App build keeps old App on compile/signature failures and preserves configured paths on success', t => {
  const f = fixture(t), app = path.join(f.apps, 'Project Hub.app'); fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'marker'), 'old');
  const swift = f.script('swiftc', 'exit 9\n');
  assert.equal(f.run('app/build-app.sh').status, 1); assert.equal(fs.readFileSync(path.join(app, 'marker'), 'utf8'), 'old');
  fs.writeFileSync(swift, '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; echo executable > "$1"; exit 0; fi; shift; done\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
  f.script('sips', 'exit 0\n'); f.script('iconutil', 'exit 0\n');
  const codesign = f.script('codesign', 'exit 19\n');
  assert.equal(f.run('app/build-app.sh').status, 19); assert.equal(fs.readFileSync(path.join(app, 'marker'), 'utf8'), 'old');
  fs.writeFileSync(codesign, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = f.run('app/build-app.sh', { HUB_ROOT: path.join(f.root, "data & 'quoted'") }); assert.equal(result.status, 0, result.stderr);
  const backups = fs.readdirSync(f.apps).filter(x => x.startsWith('Project Hub.app.backup-')); assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.apps, backups[0], 'marker'), 'utf8'), 'old');
  assert.match(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'), /data &amp; &apos;quoted&apos;/);
  assert.equal(fs.readdirSync(f.apps).some(x => x.startsWith('.ProjectHub-build-')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'Desktop')), false);
});
