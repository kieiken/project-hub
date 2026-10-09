'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { prepare } = require('../lib/workspace-location');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-location-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, '舊資料'), target = path.join(dir, '新資料'), appDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(root, '_hub', 'roles.yaml'), 'roles: []');
  fs.mkdirSync(path.join(root, 'Product')); fs.writeFileSync(path.join(root, 'Product', '測試.md'), '繁體中文\r\n');
  const configFile = path.join(appDir, 'windows-local.json');
  fs.writeFileSync(configFile, '\ufeff' + JSON.stringify({ root, port: 4545, node: process.execPath }));
  return { root, target, appDir, configFile, mode: 'copy' };
}
test('copy preserves original bytes, config changes only on commit and can roll back', t => {
  const f = fixture(t), original = fs.readFileSync(f.configFile, 'utf8');
  const r = prepare(f);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.target, 'Product', '測試.md'), 'utf8'), '繁體中文\r\n');
  assert.ok(fs.existsSync(path.join(f.root, 'Product', '測試.md')));
  r.commit(); assert.equal(JSON.parse(fs.readFileSync(f.configFile)).root, f.target);
  r.rollback(); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
});
test('empty workspace keeps roles without old projects', t => {
  const f = fixture(t); prepare({ ...f, mode: 'empty' });
  assert.deepEqual(fs.readdirSync(path.join(f.target, 'Product')), []);
  assert.equal(fs.readFileSync(path.join(f.target, '_hub', 'roles.yaml'), 'utf8'), 'roles: []');
});
test('rejects overlapping, relative, occupied and installation paths without modifying config', t => {
  const f = fixture(t), before = fs.readFileSync(f.configFile, 'utf8');
  for (const target of [f.root, path.join(f.root, 'child'), path.dirname(f.root), f.appDir, 'relative']) assert.throws(() => prepare({ ...f, target }));
  fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'keep'), 'keep');
  assert.throws(() => prepare(f)); assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});
test('Git worktree copy is refused before any destination writes', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'Product', '.git'), 'gitdir: elsewhere');
  assert.throws(() => prepare(f), /Git/); assert.equal(fs.existsSync(f.target), false);
});
