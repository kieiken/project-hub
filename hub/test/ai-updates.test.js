'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AiTools } = require('../lib/ai-tools');
const { AiUpdates, compare } = require('../lib/ai-updates');
const { Accounts } = require('../lib/accounts');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-cli-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { busy: 0, date: new Date(2026, 9, 9, 6), versions: { codex: '0.1.0', agy: '1.0.0', claude: '2.0.0' }, latest: '0.2.0', fail: '', gate: null,
    installed: ['codex'], rows: [{ ai: 'codex', id: 'default' }], auth: { 'codex:default': 'logged-in' }, models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' }] };
  const calls = [], reads = [];
  const tools = new AiTools({ ready: (_ai, file) => file, root, home: path.join(root, 'home'), busy: () => state.busy,
    find: ai => state.installed.includes(ai) ? '/fixture/' + ai : '', methods: { codex: 'standalone', agy: 'native', claude: 'native' },
    latest: async ai => { calls.push([ai, 'latest']); if (state.gate) await state.gate; if (state.fail === 'latest') throw Error('SECRET'); return { version: ai === 'codex' ? state.latest : state.versions[ai], source: 'fixture' }; },
    run: async (file, args, opts) => {
      const ai = path.basename(file); calls.push([ai, ...args, opts?.env?.FIXTURE_ACCOUNT]);
      if (args[0] === '--version') return state.versions[ai];
      if (args[0] === 'update') { if (state.fail === 'update') throw Error('SECRET'); state.versions[ai] = state.latest; return ''; }
      if (args[0] === 'debug') { if (state.fail === 'models') throw Error('SECRET'); return JSON.stringify({ models: state.models }); }
      if (args[0] === 'models') return 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)';
      throw Error('unexpected call');
    } });
  const accounts = {
    list: () => state.rows,
    available: () => {},
    status: async (ai, id) => { reads.push([ai, id]); return { status: state.auth[ai + ':' + id] || 'unknown' }; },
    env: (ai, id) => ({ FIXTURE_ACCOUNT: ai + ':' + id }),
    location: (ai, id) => path.join(root, ai, id),
    readOnly: async (ai, id, fn) => fn(),
  };
  const make = () => new AiUpdates({ tools, accounts, root, now: () => state.date });
  return { root, state, calls, reads, tools, accounts, make, updates: make() };
}
test('日次は契約ログイン済みだけ読取り、再起動・同日・重複要求では再実行しない', async t => {
  const f = fixture(t); f.state.installed.push('agy', 'claude');
  f.state.rows.push({ ai: 'agy', id: 'default' }, { ai: 'claude', id: 'default' }, { ai: 'codex', id: 'other' });
  f.state.auth['agy:default'] = 'api'; f.state.auth['claude:default'] = 'logged-out'; f.state.auth['codex:other'] = 'logged-in';
  await Promise.all([f.updates.tick(), f.updates.tick()]);
  assert.ok(f.calls.every(call => call[0] === 'codex')); assert.ok(!f.calls.some(c => c[1] === 'update'));
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'first');
  const n = f.calls.length, reads = f.reads.length;
  await f.updates.tick(); await f.make().tick(); assert.equal(f.calls.length, n); assert.equal(f.reads.length, reads);
  f.state.date = new Date(2026, 9, 10, 6); await f.updates.tick(); assert.ok(f.calls.length > n);
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'same');
});
test('追加アカウントだけログイン済みならその環境を使い、CLIごとに1回取得する', async t => {
  const f = fixture(t); f.state.auth['codex:default'] = 'logged-out';
  f.state.rows.push({ ai: 'codex', id: 'other' }, { ai: 'codex', id: 'third' });
  f.state.auth['codex:other'] = f.state.auth['codex:third'] = 'logged-in';
  await f.updates.tick(); assert.equal(f.updates.status().tools.codex.account, 'other');
  const models = f.calls.filter(c => c[1] === 'debug'); assert.equal(models.length, 1);
  assert.ok(models[0].includes('cli_auth_credentials_store="file"')); assert.equal(models[0].at(-1), 'codex:other');
  f.state.auth['codex:default'] = 'logged-in'; await f.updates.updateAll();
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'first'); // アカウントをまたいで比較しない
});
test('確認失敗は古い更新候補を無効にし、当日と再起動後の自動再試行をしない', async t => {
  const f = fixture(t); await f.updates.tick(); f.state.fail = 'latest'; f.state.date = new Date(2026, 9, 10, 6);
  await f.updates.tick(); const row = f.updates.status().tools.codex;
  assert.equal(row.updateCheck.ok, false); assert.equal(row.updateCheck.available, null); assert.doesNotMatch(JSON.stringify(row), /SECRET/);
  const n = f.calls.length; await f.updates.tick(); await f.make().tick(); assert.equal(f.calls.length, n);
  await f.updates.updateAll(); assert.ok(!f.calls.some(c => c[1] === 'update'));
});
test('稼働中の日次は版だけ確認し、終了後にモデル部分を1回だけ補完する', async t => {
  const f = fixture(t); f.state.busy = 1; await f.updates.tick();
  assert.equal(f.updates.status().tools.codex.deferred, true); assert.ok(!f.calls.some(c => c[1] === 'debug'));
  assert.equal((await f.updates.updateAll()).results.find(r=>r.ai==='codex').state,'busy');
  f.state.busy = 0; await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, 1);
  assert.equal(f.calls.filter(c => c[1] === 'latest').length, 1);
  await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, 1);
});
test('補完で失敗しても再試行せず、未確認として前回候補を保持する', async t => {
  const f = fixture(t); await f.updates.tick(); f.state.date = new Date(2026, 9, 10); f.state.busy = 1;
  await f.updates.tick(); f.state.busy = 0; f.state.fail = 'models'; await f.updates.tick();
  const row = f.updates.status().tools.codex; assert.equal(row.modelsStatus, 'unknown'); assert.equal(row.models.length, 1);
  const n = f.calls.length; await f.updates.tick(); await f.make().tick(); assert.equal(f.calls.length, n);
});
test('旧モデル取得APIの失敗も以前の変更なしを未確認へ戻す', async t => {
  const f = fixture(t); await f.updates.tick(); await f.updates.single('codex', 'models');
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'same');
  f.state.fail = 'models'; await assert.rejects(f.updates.single('codex', 'models'));
  assert.equal(f.make().status().tools.codex.modelsStatus, 'unknown');
});
test('Claude追加アカウントは同じenvと専用cacheを使い、既定cacheを混ぜない', async t => {
  const f = fixture(t); f.state.installed = ['claude'];
  f.state.rows = [{ ai: 'claude', id: 'other' }]; f.state.auth['claude:other'] = 'logged-in';
  const dir = path.join(f.accounts.location('claude', 'other'), 'cache', 'model-catalog'); fs.mkdirSync(dir, { recursive: true });
  f.tools.refreshClaude = async (file, timeout, env) => {
    assert.equal(env.FIXTURE_ACCOUNT, 'claude:other');
    fs.writeFileSync(path.join(dir, 'fresh.json'), JSON.stringify({ catalog: { config: { models: [{ id: 'claude-fable-5-2', name: 'Fable 5.2', section: 'main' }] } } }));
    return ['fable'];
  };
  await f.updates.tick();
  assert.equal(f.updates.status().tools.claude.modelsStatus, 'first');
  assert.deepEqual(f.updates.status().tools.claude.modelDiff.added, ['claude-fable-5-2']);
});
test('Claudeのcache再書込なしの一致観測で未確認から変更なしへ戻り注意も消える', async t => {
  const f = fixture(t); f.state.installed = ['claude'];
  f.state.rows = [{ ai: 'claude', id: 'other' }]; f.state.auth['claude:other'] = 'logged-in';
  const dir = path.join(f.accounts.location('claude', 'other'), 'cache', 'model-catalog');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify({ catalog: { config: { models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' },
    { id: 'claude-fable-5-2', name: 'Fable 5.2', section: 'main' },
    { id: 'claude-hidden', name: 'Hidden', section: 'overflow' },
  ] } } }));
  const mtime = fs.statSync(file).mtimeMs;
  let response = ['claude-opus-5-5', 'fable', 'claude-hidden'];
  f.tools.refreshClaude = async (_file, _timeout, env) => {
    assert.equal(env.FIXTURE_ACCOUNT, 'claude:other');
    return response;
  };
  await f.updates.tick();
  assert.equal(f.updates.status().tools.claude.modelsStatus, 'first');
  const baseline = JSON.stringify(f.updates.data.baselines);
  response = ['opus']; f.state.date = new Date(2026, 9, 10);
  await f.updates.tick();
  assert.equal(f.updates.status().tools.claude.modelsStatus, 'unknown');
  assert.match(f.updates.status().tools.claude.notice, /前回の候補を保持/);
  assert.equal(JSON.stringify(f.updates.data.baselines), baseline);
  response = ['opus', 'fable']; f.state.date = new Date(2026, 9, 11);
  await f.updates.tick();
  const row = f.updates.status().tools.claude;
  assert.equal(row.modelsStatus, 'same'); assert.equal(row.notice, '');
  assert.equal(row.source, 'claude-cache');
  assert.deepEqual(row.models.map(m => m.id), ['claude-opus-5-5', 'claude-fable-5-2']);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  const saved = f.make().status().tools.claude;
  assert.equal(saved.modelsStatus, 'same'); assert.equal(saved.notice, '');
});
test('モデル比較は追加・削除・改名を区別し、順序と初回と未新鮮を正しく扱う', async t => {
  const a = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  assert.equal(compare(a, [...a].reverse()).state, 'same'); assert.equal(compare(undefined, a).state, 'first');
  assert.deepEqual(compare(a, [{ id: 'b', label: 'Bee' }, { id: 'c', label: 'C' }]), { state: 'changed', added: ['c'], removed: ['a'], renamed: ['b'] });
  const f = fixture(t); await f.updates.tick();
  const before = JSON.stringify(f.updates.data.baselines);
  f.updates.modelResult('codex', f.updates.data.rows.codex, { ok: true, unchanged: true, models: [] });
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'unknown'); assert.equal(JSON.stringify(f.updates.data.baselines), before);
});
test('一括は新鮮確認後に適用・版検証し、モデルを二重取得せず結果を保存する', async t => {
  const f = fixture(t); await f.updates.tick(); f.calls.length = 0;
  const result = await f.updates.updateAll(); assert.equal(result.results.find(r => r.ai === 'codex').state, 'updated');
  assert.ok(f.calls.findIndex(c => c[1] === 'latest') < f.calls.findIndex(c => c[1] === 'update'));
  assert.equal(f.calls.filter(c => c[1] === 'update').length, 1); assert.equal(f.calls.filter(c => c[1] === 'debug').length, 1);
  assert.equal(f.updates.status().tools.codex.version, '0.2.0'); assert.equal(f.updates.status().tools.codex.updateCheck.available, false);
});
test('一括と日次・旧API・個別CLI操作を排他し、間のAI起動も保護する', async t => {
  const f = fixture(t); let release; f.state.gate = new Promise(r => release = r);
  const first = f.updates.updateAll(); assert.equal(f.tools.isOperating(), true);
  await assert.rejects(f.updates.updateAll(), e=>e.status===409);
  await assert.rejects(f.updates.single('codex', 'models'), e => e.status === 409);
  await assert.rejects(f.tools.update('codex'), e => e.status === 409);
  await assert.rejects(f.tools.checkUpdate('codex'), e => e.status === 409);
  await f.updates.tick(); release(); await first; assert.equal(f.tools.isOperating(), false);
});
test('部分失敗でも次のCLIを続け、未対応には適用せず、適用直前のログアウトを除外する', async t => {
  const f = fixture(t); f.state.installed.push('agy'); f.state.rows.push({ ai: 'agy', id: 'default' }); f.state.auth['agy:default'] = 'logged-in';
  f.state.fail = 'update'; const result = await f.updates.updateAll();
  assert.equal(result.results.find(r => r.ai === 'codex').state, 'failed'); assert.equal(result.results.find(r => r.ai === 'agy').state, 'checked');
  f.state.fail = ''; f.tools.methods.codex = 'unknown'; f.calls.length = 0;
  const unsupported = await f.updates.updateAll(); assert.equal(unsupported.results.find(r => r.ai === 'codex').state, 'unsupported'); assert.ok(!f.calls.some(c => c[1] === 'update'));
  f.tools.methods.codex = 'standalone'; const original = f.tools.latest; f.tools.latest = async ai => { const r = await original(ai); if (ai === 'codex') f.state.auth['codex:default'] = 'logged-out'; return r; };
  await f.updates.updateAll(); assert.equal(f.updates.status().tools.codex.eligible, false); assert.ok(!f.calls.some(c => c[1] === 'update'));
});
test('保存失敗と破損記録は適用を止め、GET相当の状態読取はCLIや認証を実行しない', async t => {
  const f = fixture(t); f.updates.status(); f.updates.status(); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
  fs.mkdirSync(path.dirname(f.updates.file), { recursive: true }); fs.mkdirSync(f.updates.file);
  await assert.rejects(f.updates.updateAll(), e => e.stage === 'save'); assert.ok(!f.calls.some(c => c[1] === 'update'));
  await f.updates.tick(); assert.equal(f.calls.length, 0);
  fs.rmdirSync(f.updates.file); fs.writeFileSync(f.updates.file, '{bad'); const broken = f.make();
  await assert.rejects(broken.updateAll(), e => e.stage === 'save'); await broken.tick(); assert.equal(f.calls.length, 0);
});
test('旧APIも未ログイン・API・認証不明を除外して確認/適用/モデル取得をしない', async t => {
  const f = fixture(t);
  for (const status of ['logged-out', 'api', 'unknown']) {
    f.state.auth['codex:default'] = status;
    for (const action of ['check', 'update', 'models']) await assert.rejects(f.updates.single('codex', action), e => e.status === 409 && e.stage === 'auth');
  }
  assert.equal(f.calls.length, 0);
});
test('実Accountsの読取保護は認証変更/削除を拒否し、失敗した認証応答をログインとしない', async t => {
  const f = fixture(t); const a = new Accounts({ file: path.join(f.root, 'accounts.json'), home: f.root, execute: async () => ({ error: { code: 1 }, stdout: '{"loggedIn":true,"authMethod":"oauth"}', stderr: '' }) });
  assert.equal((await a.status('claude', 'default')).status, 'unknown');
  let release; const hold = a.readOnly('claude', 'default', () => new Promise(r => release = r));
  await assert.rejects(a.logout('claude', 'default', true), e => e.status === 409); release(); await hold; assert.equal(a.readers.size, 0);
});

// 認証を定数に置換せず、実Accountsのmodels読取と読取ロックを通す。
function modelAuthFixture(t, ai) {
  const f = fixture(t); f.state.installed = [ai];
  const probe = { count: 0, output: ai === 'grok' ? 'You are logged in with fixture.\n  - fixture-model\n' : 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', error: null, runs: 0 };
  const accounts = new Accounts({ file: path.join(f.root, 'accounts.json'), home: f.root, execute: async (file, args, env) => {
    assert.deepEqual(args, ['models']); assert.ok(accounts.readers.get(ai + ':default') >= 2);
    assert.deepEqual(env, accounts.env(ai, 'default')); probe.count++;
    return { stdout: probe.output, stderr: '', error: probe.error };
  } });
  f.updates.accounts = accounts;
  f.tools.latest = async () => ({ version: '1.0.0', source: 'fixture' });
  f.tools.run = async (_file, args) => {
    if (args[0] === '--version') return '1.0.0';
    assert.deepEqual(args, ['models']); probe.runs++; return probe.output;
  };
  return { ...f, probe, accounts };
}
for (const ai of ['agy', 'grok']) {
  test(`${ai}: 実Accountsの一覧を同じ読取ロック内で再利用し日次/手動非適用/旧API各1回`, async t => {
    const f = modelAuthFixture(t, ai);
    await f.updates.tick(); assert.equal(f.probe.count, 1); assert.equal(f.probe.runs, 0);
    assert.equal(f.updates.status().tools[ai].modelsStatus, 'first');
    await f.updates.tick(); f.updates.status(); assert.equal(f.probe.count, 1);
    await f.updates.updateAll(); assert.equal(f.probe.count, 2); assert.equal(f.probe.runs, 0);
    await f.updates.single(ai, 'models'); assert.equal(f.probe.count, 3); assert.equal(f.probe.runs, 0);
    assert.equal(f.accounts.readers.size, 0);
  });
  test(`${ai}: busy中は認証modelsも0回、再起動後の終了補完は1回・失敗後非再試行`, async t => {
    const f = modelAuthFixture(t, ai); f.state.busy = 1;
    await f.updates.tick(); assert.equal(f.probe.count, 0); assert.equal(f.probe.runs, 0);
    assert.equal(f.updates.status().tools[ai].deferred, true);
    await assert.rejects(f.updates.single(ai, 'models'), e => e.stage === 'busy');
    const restored = new AiUpdates({ tools: f.tools, accounts: f.accounts, root: f.root, now: () => f.state.date });
    await restored.tick(); assert.equal(f.probe.count, 0);
    f.state.busy = 0; await restored.tick(); assert.equal(f.probe.count, 1); assert.equal(f.probe.runs, 0);
    assert.equal(restored.status().tools[ai].eligible, true); await restored.tick(); assert.equal(f.probe.count, 1);
    f.state.date = new Date(2026, 9, 10); f.state.busy = 1; await restored.tick();
    f.probe.error = { code: 1 }; f.state.busy = 0; await restored.tick();
    assert.equal(f.probe.count, 2); assert.equal(restored.status().tools[ai].eligible, false);
    await restored.tick(); await new AiUpdates({ tools: f.tools, accounts: f.accounts, root: f.root, now: () => f.state.date }).tick();
    assert.equal(f.probe.count, 2); assert.equal(f.probe.runs, 0);
  });
}
for (const action of ['daily', 'batch', 'models', 'check', 'update']) test(`Agy model removal keeps other observed choices (${action})`, async t => {
  const f = modelAuthFixture(t, 'agy'); await f.updates.tick();
  f.probe.output = 'gemini-other\tOther';
  if (action === 'daily') { f.state.date = new Date(2026, 9, 10); await f.updates.tick(); }
  else if (action === 'batch') await f.updates.updateAll();
  else await f.updates.single('agy',action);
  const row=f.updates.status().tools.agy;
  assert.equal(row.eligible,true);assert.equal(row.status,'logged-in');
  assert.deepEqual(f.tools.catalog().agy.models,[{id:'gemini-other',label:'Other'}]);
  assert.equal(f.probe.runs,0);assert.deepEqual(row.modelDiff.removed,['gemini-3.1-pro-high']);
});
test('Agy failed acquisition preserves auth and cache, while explicit auth failure clears choices', async t => {
  const f=modelAuthFixture(t,'agy');await f.updates.tick();const before=f.tools.catalog().agy.models;
  for(const output of ['unrecognized response','gemini-3.1-pro-high']) {
    f.probe.output=output;await assert.rejects(f.updates.single('agy','models'),e=>e.stage==='models');
    assert.equal(f.updates.status().tools.agy.status,'logged-in');assert.equal(f.tools.catalog().agy.state,'failed');
    assert.deepEqual(f.tools.catalog().agy.models,before);assert.equal(f.probe.runs,0);
  }
  f.probe.output='please login';await assert.rejects(f.updates.single('agy','models'),e=>e.stage==='auth');
  assert.equal(f.updates.status().tools.agy.status,'logged-out');assert.equal(f.tools.catalog().agy.state,'auth-required');assert.deepEqual(f.tools.catalog().agy.models,[]);
});
test('Agy catalogue refresh immediately before update retains all returned choices', async t => {
  const f=modelAuthFixture(t,'agy');f.tools.latest=async()=>{f.probe.output='gemini-other\tOther';return {version:'2.0.0',source:'fixture'};};
  await f.updates.updateAll();assert.equal(f.probe.count,2);
  assert.deepEqual(f.tools.catalog().agy.models,[{id:'gemini-other',label:'Other'}]);
});

test('実Grokの追加契約アカウントは専用envと1観測を使い、版確認中も認証変更を拒否する', async t => {
  const f = modelAuthFixture(t, 'grok');
  const id = 'other'; const dir = f.accounts.dir('grok', id); fs.mkdirSync(dir, { recursive: true });
  f.accounts.save([{ ai: 'grok', id, name: 'fixture', dir }]); let selectedModels = 0;
  f.accounts.execute = async (_file, args, env) => {
    assert.deepEqual(args, ['models']);
    if (!env.GROK_HOME || env.GROK_HOME !== dir) return { stdout: 'You are not authenticated.', stderr: '' };
    selectedModels++; return { stdout: 'You are logged in with fixture.\n  - other-model', stderr: '' };
  };
  f.tools.latest = async () => {
    assert.equal(f.accounts.readers.get('grok:other'), 1);
    await assert.rejects(f.accounts.logout('grok', 'other'), e => e.status === 409);
    assert.throws(() => f.accounts.remove('grok', 'other'), e => e.status === 409);
    return { version: '1.0.0', source: 'fixture' };
  };
  await f.updates.tick();
  assert.equal(f.updates.status().tools.grok.account, 'other'); assert.equal(selectedModels, 1); assert.equal(f.probe.runs, 0);
  assert.deepEqual(f.tools.catalog().grok.models, [{ id: 'other-model', label: 'other-model' }]); assert.equal(f.accounts.readers.size, 0);
});

test('Agy empty list, malformed output and auth failure are distinct', async t => {
  const f=modelAuthFixture(t,'agy');f.probe.output='\n  \r\nother-model\tOther\r\n\r\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n';
  await f.updates.tick();assert.equal(f.tools.catalog().agy.models.length,2);assert.equal(f.probe.count,1);
  f.probe.output='\n \n';const empty=await f.updates.single('agy','models');assert.equal(empty.empty,true);
  assert.equal(f.tools.catalog().agy.state,'empty');assert.equal(f.updates.status().tools.agy.status,'logged-in');
  f.probe.output='gemini-3.1-pro-high  Gemini 3.1 Pro (High)';await assert.rejects(f.updates.single('agy','models'),e=>e.stage==='models');
  f.probe.output='please login';await assert.rejects(f.updates.single('agy','models'),e=>e.stage==='auth');
});

test('延期した日次モデル確認は対象CLIが終了すれば別CLI稼働中も一度だけ補完する', async t => {
  const f=fixture(t);let codexActive=true;
  f.tools.busy=ai=>!ai||ai==='claude'||ai==='codex'&&codexActive?1:0;
  await f.updates.tick();assert.equal(f.updates.status().tools.codex.deferred,true);
  codexActive=false;await f.updates.tick();assert.equal(f.calls.filter(c=>c[1]==='debug').length,1);
  await f.updates.tick();assert.equal(f.calls.filter(c=>c[1]==='debug').length,1);
});

test('更新確認は一覧も取得し新候補数を返すが、変化のない一覧は再保存しない', async t => {
  const f = fixture(t); await f.updates.tick();
  f.state.models.push({ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' });
  const result = await f.updates.single('codex', 'check');
  assert.equal(result.models.ok, true); assert.equal(result.models.added, 1);
  const before = fs.readFileSync(f.tools.file, 'utf8'), stamp = fs.statSync(f.tools.file).mtimeMs;
  const persist = f.tools.persist; f.tools.persist = () => { throw Error('unchanged catalog must not be saved'); };
  const same = await f.updates.single('codex', 'check'); f.tools.persist = persist;
  assert.equal(same.models.ok, true); assert.equal(same.models.added, 0);
  assert.equal(fs.readFileSync(f.tools.file, 'utf8'), before); assert.equal(fs.statSync(f.tools.file).mtimeMs, stamp);
  assert.equal(f.calls.filter(c => c[1] === 'debug').length, 3);
});
test('外部CLI更新は同日でも実体と版で検知し、再起動と次の巡回では取得を増やさない', async t => {
  const f = fixture(t), file = path.join(f.root, 'codex'); fs.writeFileSync(file, 'old');
  f.tools.find = ai => ai === 'codex' ? file : '';
  await f.updates.tick(); const n = f.calls.filter(c => c[1] === 'debug').length;
  fs.writeFileSync(file, 'new CLI contents'); f.state.versions.codex = '0.3.0';
  f.state.models.push({ slug: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra', visibility: 'list' });
  await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 1);
  assert.equal(f.updates.data.modelClients['codex:default'].version, '0.3.0');
  const count = f.calls.length; await f.updates.tick(); await f.make().tick(); assert.equal(f.calls.length, count);
  // 同じwrapperでも別の正規版確認が版変更を観測した場合。
  f.state.versions.codex = '0.4.0'; await f.tools.version('codex', file);
  await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 2);
});
test('CLIのリンク先だけの入替えも同日検知する', async t => {
  const f = fixture(t), a = path.join(f.root, 'a'), b = path.join(f.root, 'b'), link = path.join(f.root, 'codex');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(a, 'codex'), 'same'); fs.writeFileSync(path.join(b, 'codex'), 'same');
  fs.symlinkSync(path.join(a, 'codex'), link); f.tools.find = ai => ai === 'codex' ? link : '';
  await f.updates.tick(); fs.unlinkSync(link); fs.symlinkSync(path.join(b, 'codex'), link);
  await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, 2);
});
test('更新確認中の作業・順番待ちは理由付き延期、一覧取得失敗は旧一覧保持で自動再試行しない', async t => {
  const f = fixture(t); await f.updates.tick(); const old = fs.readFileSync(f.tools.file, 'utf8');
  f.state.busy = 1; const busy = await f.updates.single('codex', 'check');
  assert.equal(busy.models.deferred, true); assert.match(busy.models.warning, /作業・順番待ち/);
  assert.equal(f.calls.filter(c => c[1] === 'debug').length, 1);
  f.state.busy = 0; f.state.fail = 'models'; await f.updates.tick();
  assert.equal(f.updates.status().tools.codex.modelsStatus, 'unknown'); assert.equal(fs.readFileSync(f.tools.file, 'utf8'), old);
  const n = f.calls.length; await f.updates.tick(); await f.make().tick(); assert.equal(f.calls.length, n);
  const failed = await f.updates.single('codex', 'check'); assert.equal(failed.models.ok, false); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
test('ログイン操作中はコマンドを起動せず延期し、解除後は指定アカウントだけ補完する', async t => {
  const f = fixture(t); f.state.rows.push({ ai: 'codex', id: 'other' }); f.state.auth['codex:other'] = 'logged-in';
  f.accounts.get = (ai, id) => assert.ok(f.state.rows.some(r => r.ai === ai && r.id === id));
  await f.updates.tick(); f.accounts.locks = new Set(['codex:other']);
  const n = f.calls.length, result = await f.updates.single('codex', 'check', 'other');
  assert.equal(result.models.deferred, true); assert.match(result.models.warning, /アカウント操作/); assert.equal(f.calls.length, n);
  f.accounts.locks.clear(); await f.updates.tick();
  assert.equal(f.updates.status().tools.codex.account, 'other');
  assert.equal(f.calls.filter(c => c[1] === 'debug').at(-1).at(-1), 'codex:other');
  const count = f.calls.length; await f.updates.tick(); assert.equal(f.calls.length, count);
});
test('既知のCodex各アカウントを更新確認で取り直し、明示指定は他アカウントを呼ばない', async t => {
  const f = fixture(t); f.state.rows.push({ ai: 'codex', id: 'other' }); f.state.auth['codex:other'] = 'logged-in';
  f.accounts.get = (ai, id) => assert.ok(f.state.rows.some(r => r.ai === ai && r.id === id));
  await f.updates.tick(); await f.updates.single('codex', 'models', 'other');
  let n = f.calls.filter(c => c[1] === 'debug').length;
  await f.updates.single('codex', 'check');
  assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 2);
  assert.equal(f.updates.status().tools.codex.account, 'default'); assert.equal(f.updates.status().tools.codex.updateCheck.ok, true);
  n = f.calls.filter(c => c[1] === 'debug').length; f.reads.length = 0;
  await f.updates.single('codex', 'check', 'other');
  assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 1); assert.deepEqual(f.reads, [['codex', 'other']]);
  // CLIの外部入替え時には既に一覧を持つ両方を更新し、役割の保存先には触れない。
  const rolesFile = path.join(f.root, '_hub', 'roles.json'); fs.writeFileSync(rolesFile, '{"main":"gpt-6.1-sol"}');
  f.tools.clientIdentity = () => 'changed-cli'; n = f.calls.filter(c => c[1] === 'debug').length;
  await f.updates.tick(); assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 2);
  assert.equal(fs.readFileSync(rolesFile, 'utf8'), '{"main":"gpt-6.1-sol"}');
  f.state.versions.codex = '0.5.0'; await f.tools.version('codex', f.tools.find('codex'));
  n = f.calls.filter(c => c[1] === 'debug').length; await f.updates.tick();
  assert.equal(f.calls.filter(c => c[1] === 'debug').length, n + 2);
  const count = f.calls.length; await f.make().tick(); assert.equal(f.calls.length, count);
});
test('モデル取得を含む更新確認は全体を排他し、そのAIの開始も許さない', async t => {
  const f = fixture(t); let release; f.state.gate = new Promise(r => { release = r; });
  const pending = f.updates.single('codex', 'check'); await new Promise(r => setImmediate(r));
  assert.equal(f.tools.isOperating('codex'), true);
  await assert.rejects(f.updates.single('codex', 'models'), e => e.status === 409);
  release(); await pending; assert.equal(f.tools.isOperating('codex'), false);
});
