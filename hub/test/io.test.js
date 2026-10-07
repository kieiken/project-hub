'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-io-'));
const root = path.join(tmp, 'AI-Workspace');
const product = path.join(root, 'Product');
const rolesFile = path.join(root, '_hub', 'roles.yaml');
const primaryDir = path.join(product, 'primary');
const projectFile = path.join(primaryDir, 'PROJECT.md');
const port = 47000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function project(id, name, related = '') {
  const dir = path.join(product, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: ${name}\nrelated: [${related}]\n---\n# メモ\n最初のメモ\n`);
  return dir;
}

async function countCalls(method, target, run) {
  const original = fs[method];
  let count = 0;
  fs[method] = function (file, ...args) {
    if (file === target) count++;
    return original.call(this, file, ...args);
  };
  try { return { value: await run(), count }; }
  finally { fs[method] = original; }
}

let server;
test('台帳と役割は要求内で一度だけ読み、外部編集は次の取得へ反映する', async () => {
  fs.mkdirSync(path.dirname(rolesFile), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'docs', 'project-hub', 'templates', '_hub', 'roles.yaml'), rolesFile);
  fs.writeFileSync(path.join(root, '_hub', 'ai-tools-models.json'), JSON.stringify({
    v: 1,
    codex: {
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
      known: [{ id: 'gpt-5.5', label: 'Gone Model' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
      refreshedAt: new Date().toISOString(), source: 'codex-cli'
    }
  }));
  project('primary', 'Primary', 'Reference One, Reference Two');
  const firstRef = project('reference-one', 'Reference One');
  const secondRef = project('reference-two', 'Reference Two');
  const taskDir = path.join(primaryDir, '.ai', 'tasks');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'T.md'), '---\nid: T\ntitle: Task\nrole: コーディング\nstate: 実行中\n---\n# Task\n');

  const store = new Store(root);
  const direct = await countCalls('readFileSync', projectFile, () => store.readProject('primary'));
  assert.equal(direct.count, 1);
  assert.equal(direct.value.notes, '最初のメモ');

  process.env.HUB_ROOT = root;
  process.env.HUB_PORT = String(port);
  process.env.HUB_DRY_RUN = '1';
  ({ server } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const state = await countCalls('readFileSync', rolesFile, async () => (await fetch(base + '/api/state')).json());
    assert.equal(state.count, 1);
    assert.equal(state.value.projects.find(p => p.id === 'primary').notes, '最初のメモ');
    assert.equal(state.value.cliFlags.codex['GPT-6.1-Sol'], 'gpt-6.1-sol');

    const modelFile = path.join(root, '_hub', 'model-view.json');
    const copy = path.join(root, 'Work', 'primary', 'T'), taskFileForCopy = path.join(taskDir, 'T.md');
    const originalTask = fs.readFileSync(taskFileForCopy, 'utf8');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(taskFileForCopy, originalTask.replace('state: 実行中', 'state: 実行中\nworkdir: ' + copy));
    const settings = { initial: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '極高' }, hidden: { codex: ['GPT-6-Astra'] }, order: ['codex|GPT-6.1-Sol'] };
    fs.writeFileSync(modelFile, JSON.stringify(settings));
    const measured = await countCalls('readFileSync', modelFile, () => countCalls('existsSync', copy, async () => {
      const response = await fetch(base + '/api/state');
      return { state: await response.json(), tag: response.headers.get('etag') };
    }));
    console.log('state I/O: model settings reads=' + measured.count + ', copy existence checks=' + measured.value.count);
    assert.equal(measured.count, 1);
    assert.equal(measured.value.count, 2); // 一覧の確認とGit情報の確認で各1回。
    const snapshot = measured.value.value;
    assert.deepEqual(snapshot.state.initialPick, settings.initial);
    assert.deepEqual(snapshot.state.modelOrder, settings.order);
    assert.deepEqual(snapshot.state.hiddenModels.codex, settings.hidden.codex);
    assert.equal(snapshot.state.projects.find(p => p.id === 'primary').tasks[0].copy, true);
    const unchanged = await fetch(base + '/api/state', { headers: { 'If-None-Match': snapshot.tag } });
    assert.equal(unchanged.status, 304);
    fs.rmdirSync(copy);
    settings.initial.effort = '高'; fs.writeFileSync(modelFile, JSON.stringify(settings));
    const fresh = await fetch(base + '/api/state', { headers: { 'If-None-Match': snapshot.tag } });
    assert.equal(fresh.status, 200);
    const freshState = await fresh.json();
    assert.deepEqual(freshState.initialPick, settings.initial);
    assert.equal(freshState.projects.find(p => p.id === 'primary').tasks[0].copyMissing, true);
    fs.writeFileSync(taskFileForCopy, originalTask); fs.unlinkSync(modelFile);

    fs.writeFileSync(projectFile, fs.readFileSync(projectFile, 'utf8').replace('最初のメモ', '書き換えたメモ'));
    const originalRoles = fs.readFileSync(rolesFile, 'utf8');
    const changedRoles = originalRoles.replace(/(コーディング:\s*\{\s*main:\s*\[codex,\s*)GPT-6\.1-Sol,\s*高\]/,
      (_, head) => `${head}6terra, MAX]`);
    assert.notEqual(changedRoles, originalRoles);
    fs.writeFileSync(rolesFile, changedRoles);
    const changed = await (await fetch(base + '/api/state')).json();
    assert.equal(changed.projects.find(p => p.id === 'primary').notes, '書き換えたメモ');
    assert.equal(changed.roles.roles.find(r => r.name === 'コーディング').main.model, '6terra');

    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) });
    const started = await (await post('/api/term/start', { project: 'primary', task: 'T', ai: 'codex' })).json();
    assert.equal(started.model, '6terra');
    assert.equal(started.effort, 'MAX');

    const related = await countCalls('readdirSync', product, async () => (await post('/api/continue', { project: 'primary', task: 'T', ai: 'codex' })).json());
    assert.equal(related.count, 1);
    assert.ok(related.value.command.includes(firstRef));
    assert.ok(related.value.command.includes(secondRef));

    // 作業だけに残ったモデル指定が候補から消えても、役割モデルへ黙って置き換えない。
    const taskFile = path.join(taskDir, 'T.md');
    fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('state: 実行中', 'state: 実行中\nmodel: Gone Model'));
    const missing = await post('/api/term/start', { project: 'primary', task: 'T', ai: 'codex' });
    assert.equal(missing.status, 409);
    assert.match((await missing.json()).error, /Gone Model/);
    await post('/api/cli-models', { claude: {}, codex: { 'Gone Model': '' } });
    const staleWithBlankOverride = await post('/api/term/start', { project: 'primary', task: 'T', ai: 'codex' });
    assert.equal(staleWithBlankOverride.status, 409);
    assert.match((await staleWithBlankOverride.json()).error, /Gone Model/);
    fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('Gone Model', 'Custom Default'));
    await post('/api/cli-models', { claude: {}, codex: { 'Custom Default': '' } });
    const explicitDefault = await (await post('/api/term/start', { project: 'primary', task: 'T', ai: 'codex' })).json();
    assert.equal(explicitDefault.model, 'Custom Default');
    assert.equal(explicitDefault.args.includes('--model'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
