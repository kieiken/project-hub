'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AiTools } = require('../lib/ai-tools');
const { AiUpdates } = require('../lib/ai-updates');
const { Accounts } = require('../lib/accounts');
const { ModelView } = require('../lib/model-view');
const launch = require('../lib/launch'), roles = require('../lib/roles');
const sol = { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['高', '極高'] };
const luna = { id: 'gpt-6-luna', label: 'GPT-6-Luna' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-model-accounts-')), home = path.join(root, 'home');
  const accounts = new Accounts({ file: path.join(root, '_hub/accounts.json'), home });
  const spare = accounts.add('codex', '予備用').id;
  const calls = [], state = { fail: false };
  const options = { root, home, accounts, find: ai => ai === 'codex' ? '/fixture/codex' : '', run: async (file, args, opts) => {
    calls.push({ args, env: opts.env });
    if (state.fail) throw Error('private credential');
    const models = opts.env.CODEX_HOME === accounts.location('codex', spare) ? [luna] : [sol];
    return JSON.stringify({ models: models.map(m => ({ slug: m.id, display_name: m.label, visibility: 'list' })) });
  } };
  const tools = new AiTools(options);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); launch.setDiscoveredModels({}); roles.setModelCatalog({}); });
  return { root, home, accounts, spare, options, tools, calls, state };
}
test('Codexのモデル・思考・履歴をアカウント別に永続化し、片側の更新は他方を変えない', t => {
  const f = fixture(t);
  f.tools.saveCatalog('codex', { models: [sol], source: 'fixture' });
  f.tools.saveCatalog('codex', { models: [luna], source: 'fixture' }, f.spare);
  const tools = new AiTools(f.options);
  assert.deepEqual(tools.accountCatalog('codex').models, [sol]);
  assert.deepEqual(tools.accountCatalog('codex', f.spare).models, [luna]);
  assert.deepEqual(tools.catalog().codex.models, [sol, luna]);
  tools.saveCatalog('codex', { models: [sol], source: 'fixture2' }, f.spare);
  assert.deepEqual(tools.accountCatalog('codex').models, [sol]);
  assert.ok(tools.accountCatalog('codex', f.spare).known.some(row => row.id === luna.id));
  assert.equal(tools.catalog().codex.models.some(row => row.id === luna.id), false);
  const saved = JSON.parse(fs.readFileSync(tools.file));
  assert.equal(saved.v, 2); assert.deepEqual(saved.codex.models, [sol]);
  assert.deepEqual(saved.codexAccounts[f.spare].models, [sol]);
});
test('一覧未確認の追加アカウントへ既定をコピーせず、各保存場所のローカル候補だけ読む', t => {
  const f = fixture(t);
  fs.mkdirSync(f.accounts.location('codex'), { recursive: true });
  const json = m => JSON.stringify({ models: [{ slug: m.id, display_name: m.label, visibility: 'list' }] });
  fs.writeFileSync(path.join(f.accounts.location('codex'), 'models_cache.json'), json(sol));
  let tools = new AiTools(f.options);
  assert.deepEqual(tools.accountCatalog('codex', f.spare).models, []);
  fs.writeFileSync(path.join(f.accounts.location('codex', f.spare), 'models_cache.json'), json(luna));
  tools = new AiTools(f.options);
  assert.deepEqual(tools.accountCatalog('codex').models.map(m => m.id), [sol.id]);
  assert.deepEqual(tools.accountCatalog('codex', f.spare).models, [luna]);
});
test('アカウント台帳が壊れても生成と一覧参照を続け、保存済みプロフィールを混ぜない', t => {
  const f = fixture(t), registry = fs.readFileSync(f.accounts.file, 'utf8');
  f.tools.saveCatalog('codex', { models: [sol], source: 'fixture' });
  f.tools.saveCatalog('codex', { models: [luna], source: 'fixture' }, f.spare);
  const moved = JSON.parse(registry); moved.accounts[0].dir = path.join(f.root, 'previous-home');
  for (const broken of ['{broken', JSON.stringify(moved)]) {
    fs.writeFileSync(f.accounts.file, broken);
    assert.throws(() => f.accounts.list(), /アカウント台帳/);
    const tools = new AiTools(f.options);
    for (const current of [tools, f.tools]) {
      current.syncCaches();
      assert.deepEqual(current.catalog().codex.models, [sol, luna]);
      assert.deepEqual(current.accountCatalog('codex').models, [sol]);
      assert.deepEqual(current.accountCatalog('codex', f.spare).models, [luna]);
      assert.deepEqual(current.accountCatalog('codex', 'unconfirmed').models, []);
    }
  }
  fs.writeFileSync(f.accounts.file, registry);
  f.accounts.save([]);
  assert.deepEqual(f.tools.catalog().codex.models, [sol]);
});
test('指定アカウントだけで再取得し、空・失敗・保存失敗時は両側の前回一覧を保つ', async t => {
  const f = fixture(t);
  f.tools.saveCatalog('codex', { models: [sol], source: 'fixture' });
  await f.tools.refresh('codex', { account: f.spare, env: f.accounts.env('codex', f.spare), fileAuth: true });
  assert.deepEqual(f.calls[0].args, ['debug', 'models', '-c', 'cli_auth_credentials_store="file"']);
  assert.equal(f.calls[0].env.CODEX_HOME, f.accounts.location('codex', f.spare));
  const before = JSON.stringify(f.tools.codexCatalogs());
  f.state.fail = true;
  await assert.rejects(f.tools.refresh('codex', { account: f.spare }), e => !e.message.includes('private credential'));
  assert.throws(() => f.tools.saveCatalog('codex', { models: [], source: 'empty' }, f.spare));
  const original = f.tools.persist; f.tools.persist = () => { throw Error('save failed'); };
  assert.throws(() => f.tools.saveCatalog('codex', { models: [sol], source: 'fixture' }, f.spare));
  f.tools.persist = original;
  assert.equal(JSON.stringify(f.tools.codexCatalogs()), before);
});
test('旧形式は既定だけへ移行し、削除したアカウントのモデルは候補に残さない', t => {
  const f = fixture(t);
  fs.writeFileSync(f.tools.file, JSON.stringify({ v: 1, codex: { models: [sol], known: [sol], source: 'saved' } }));
  const tools = new AiTools(f.options);
  assert.deepEqual(tools.accountCatalog('codex').models, [sol]);
  assert.deepEqual(tools.accountCatalog('codex', f.spare).models, []);
  tools.saveCatalog('codex', { models: [luna], source: 'fixture' }, f.spare);
  f.accounts.save([]);
  assert.equal(tools.catalog().codex.models.some(m => m.id === luna.id), false);
});
test('表示設定はアカウント別に保存し、既存の役割・初期選択・並び順を維持する', t => {
  const f = fixture(t), view = new ModelView(path.join(f.root, '_hub/model-view.json'));
  view.write({ hidden: { codex: [sol.label] }, initial: { ai: 'codex', model: sol.label, effort: '高' }, order: ['codex|' + sol.label] });
  view.setHidden('codex', luna.label, true, f.spare);
  assert.deepEqual(view.read().hidden, { codex: [sol.label] });
  const response = view.setHidden('codex', sol.label, false, 'default');
  assert.deepEqual(response.hiddenModels.codex, []);
  const saved = new ModelView(view.file).read();
  assert.deepEqual(saved.codexHidden, { [f.spare]: [luna.label], default: [] });
  assert.deepEqual(saved.initial, { ai: 'codex', model: sol.label, effort: '高' });
  assert.deepEqual(saved.order, ['codex|' + sol.label]);
  assert.deepEqual(saved.hidden, { codex: [] });
  const raw = { models: {}, roles: { coding: { main: ['codex', sol.label, '高'], backup: ['codex', luna.label, '中'] } } };
  f.tools.saveCatalog('codex', { models: [sol], source: 'fixture' });
  f.tools.saveCatalog('codex', { models: [luna], source: 'fixture' }, f.spare);
  launch.setDiscoveredModels(f.tools.catalog()); roles.setModelCatalog(f.tools.catalog());
  assert.deepEqual(roles.normalize(raw).roles[0].main, { ai: 'codex', model: sol.label, effort: '高' });
  assert.equal(launch.flagFor('codex', luna.label), luna.id);
});
test('移行済みの既定表示設定も共通欄へ同期し、追加アカウントでは共通欄を変えない', t => {
  const f = fixture(t), view = new ModelView(path.join(f.root, '_hub/model-view.json'));
  view.write({ hidden: { codex: [sol.label], claude: ['fixture-claude'] }, codexHidden: { default: [] } });
  const hidden = view.setHidden('codex', luna.label, true, 'default');
  assert.deepEqual(hidden.hiddenModels.codex, [luna.label]);
  assert.deepEqual(view.read().hidden, { codex: [luna.label], claude: ['fixture-claude'] });
  assert.deepEqual(view.read().codexHidden.default, [luna.label]);
  view.setHidden('codex', luna.label, false, f.spare);
  assert.deepEqual(view.read().hidden.codex, [luna.label]);
  const visible = view.setHidden('codex', luna.label, false, 'default');
  assert.deepEqual(visible.hiddenModels.codex, []);
  assert.deepEqual(view.read().codexHidden.default, []);
});
test('明示した再取得は指定アカウントだけ認証確認し、別アカウントへフォールバックしない', async t => {
  const f = fixture(t), checked = [];
  f.accounts.status = async (ai, id) => { checked.push(id); return { status: 'logged-in' }; };
  const updates = new AiUpdates({ tools: f.tools, accounts: f.accounts, root: f.root });
  await updates.single('codex', 'models', f.spare);
  assert.deepEqual(checked, [f.spare]);
  assert.deepEqual(f.tools.accountCatalog('codex', f.spare).models, [luna]);
  assert.deepEqual(f.tools.accountCatalog('codex').models, []);
  f.accounts.status = async (ai, id) => { checked.push(id); return { status: 'logged-out' }; };
  await assert.rejects(updates.single('codex', 'models', f.spare), e => e.status === 409);
  assert.deepEqual(checked, [f.spare, f.spare]);
  await assert.rejects(updates.single('codex', 'models', 'not-an-account'));
  await assert.rejects(updates.single('claude', 'models', f.spare));
});
