'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');

test('unrelated background AI remains visible without blocking quit/restart; a mapped Hub process still blocks both', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-busy-http-'));
  const projectDir = path.join(root, 'Product', 'Fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'PROJECT.md'), '---\nname: Fixture\nfolders: {}\nphases: []\n---\n');
  fs.mkdirSync(path.join(root, '_hub'));
  fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const before = { ...process.env };
  Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1',
    HUB_AI_HOME: path.join(root, 'ai-home'), HUB_AUTO_UPDATE: '0', HUB_AUTO_TRANSLATE: '0' });
  const procwatch = require('../lib/procwatch'), create = procwatch.create;
  let background = [{ pid: 123456789, ai: 'codex', cwd: path.join(root, 'unrelated-app'), project: null, task: null }];
  const unrelated = background[0];
  procwatch.create = () => ({ list: () => background.slice(), scan: async () => background.slice(),
    onChange() {}, start() {}, stop() {} });
  let server;
  t.after(async () => {
    procwatch.create = create;
    if (server) await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    fs.rmSync(root, { recursive: true, force: true });
  });
  try { ({ server } = require('../server')); } finally { procwatch.create = create; }
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + port;
  const post = route => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: '{}' });
  let state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.projects.length, 1);
  assert.deepEqual(state.background, []);
  assert.deepEqual((await (await fetch(base + '/api/background')).json()).items, [unrelated]);
  for (const route of ['/api/quit', '/api/restart']) {
    const result = await post(route);
    assert.equal(result.status, 200, route + ' must ignore unrelated App processes');
    assert.equal((await result.json()).ok, true);
  }
  background = [unrelated, { ...unrelated, pid: unrelated.pid + 1, cwd: projectDir, project: 'Fixture' }];
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.background.length, 1);
  assert.equal(state.background[0].project, 'Fixture');
  for (const route of ['/api/quit', '/api/restart']) {
    const result = await post(route);
    assert.equal(result.status, 409, route + ' must preserve the Hub project busy guard');
    assert.equal(typeof (await result.json()).error, 'string');
  }
  assert.deepEqual((await (await fetch(base + '/api/background')).json()).items, background);
  background = [unrelated];
  for (const route of ['/api/quit', '/api/restart']) assert.equal((await post(route)).status, 200);
});
