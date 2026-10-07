'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiTools, codexModels, claudeModels, claudeInitialize } = require('../lib/ai-tools');
const launch = require('../lib/launch');
const roles = require('../lib/roles');
const { latestVersion, newer } = require('../lib/update-check');

test('更新確認は稼働中にも読取だけを行い、同時確認をまとめ、失敗では適用候補を消す', async () => {
  const f = fixture();
  try {
    let release, fail = false, reads = 0;
    const gate = new Promise(r => { release = r; });
    const calls = [];
    const tools = new AiTools({ root: f.root, home: f.home, busy: () => 2, find: () => '/fixture/codex', methods: { codex: 'standalone' },
      run: async (file, args) => { calls.push(args); assert.deepEqual(args, ['--version']); return 'codex-cli 0.159.0'; },
      latest: async () => { reads++; await gate; if (fail) throw Error('secret'); return { version: '0.160.0', source: 'fixture' }; } });
    const first = tools.checkUpdate('codex'), second = tools.checkUpdate('codex');
    assert.equal(tools.isOperating(), false);
    await assert.rejects(tools.update('codex'), e => e.status === 409);
    release(); const [a,b] = await Promise.all([first,second]);
    assert.deepEqual(a,b); assert.equal(a.available, true); assert.equal(reads,1);
    assert.deepEqual(calls, [['--version']]);
    fail = true; await assert.rejects(tools.checkUpdate('codex'), e => e.status === 502 && !e.message.includes('secret'));
    assert.equal(tools.updateChecks.codex.available, null); assert.equal(tools.updateChecks.codex.ok, false);
  } finally { f.close(); }
});
test('公開版情報は配布元形式を検証し、stable設定と数値順比較を保つ', async () => {
  const f = fixture();
  try {
    assert.equal(newer('0.160.0','0.99.0'),true); assert.equal(newer('0.160.0','0.161.0'),false); assert.equal(newer('x','0.1.0'),null);
    assert.equal((await latestVersion('codex','standalone',f.home,async () => '{"tag_name":"rust-v0.160.0"}')).version,'0.160.0');
    fs.writeFileSync(path.join(f.home,'.claude/settings.json'),'{"autoUpdatesChannel":"stable"}');
    await latestVersion('claude','native',f.home,async url => { assert.match(url,/\/stable$/); return '2.1.280'; });
    await assert.rejects(latestVersion('agy','native',f.home,async () => '{"version":"evil;command"}'));
  } finally { f.close(); }
});
test('確認中の適用結果を古い確認で上書きせず、各CLIの現在版を数値抽出する', async () => {
  const f=fixture();
  try {
    let release; const gate=new Promise(r=>{release=r;});
    const tools=new AiTools({root:f.root,home:f.home,find:()=>'/fixture/cli',methods:{codex:'standalone'},
      run:async (file,args)=>args[0]==='debug'?codexJson([['gpt-6.1-sol','GPT-6.1-Sol']]):'0.159.0 (CLI)',latest:async()=>{await gate;return {version:'0.160.0',source:'fixture'};}});
    assert.equal(await tools.version('claude','/fixture/cli'), '0.159.0');
    assert.equal(await tools.version('agy','/fixture/cli'), '0.159.0');
    const pending=tools.checkUpdate('codex'); await new Promise(r=>setImmediate(r));
    await tools.update('codex'); release();
    await assert.rejects(pending,e=>e.status===409); assert.equal(tools.updateChecks.codex,undefined);
  } finally {f.close();}
});

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ai-tools-'));
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'cache', 'model-catalog'), { recursive: true });
  return { tmp, home, root, close: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const codexJson = models => JSON.stringify({ models: models.map(([slug, name, visibility = 'list']) => ({ slug, display_name: name, visibility })) });
const claudeJson = models => JSON.stringify({ catalog: { config: { models: models.map(([id, name, section = 'main']) => ({ id, name, section })) } } });

test('ローカルカタログの表示対象だけを候補へ足し、既存の別名を重ねない', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.codex', 'models_cache.json'), codexJson([
      ['gpt-6-sol', 'GPT-6-Sol'], ['gpt-6.1-sol', 'GPT-6.1-Sol'], ['hidden', 'Hidden', 'hide'],
    ]));
    fs.writeFileSync(path.join(f.home, '.claude', 'cache', 'model-catalog', 'catalog.json'), claudeJson([
      ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-4-6', 'Opus 4.6', 'overflow'],
    ]));
    const tools = new AiTools({ root: f.root, home: f.home, dry: true });
    const catalog = tools.catalog();
    assert.deepEqual(catalog.codex.models.map(x => x.id), ['gpt-6-sol', 'gpt-6.1-sol']);
    assert.deepEqual(catalog.claude.models.map(x => x.id), ['claude-opus-5-5', 'claude-sonnet-5-5']);
    launch.setDiscoveredModels(catalog);
    roles.setModelCatalog(catalog);
    const raw = { models: { 'claude-code': ['Opus 5.5'], codex: ['6sol'] }, roles: {} };
    const data = roles.normalize(raw);
    assert.deepEqual(data.models.codex, ['GPT-6-Sol', 'GPT-6.1-Sol']); // 古い呼び名（6sol）は出さず、CLI の名前だけ（4.18.0）
    assert.deepEqual(data.models['claude-code'], ['Opus 5.5', 'Sonnet 5.5']);
    assert.equal(launch.flagFor('codex', 'GPT-6.1-Sol'), 'gpt-6.1-sol');
    assert.deepEqual(launch.buildArgv({ ai: 'codex', model: 'GPT-6.1-Sol', prompt: 'x' }).args.slice(-3), ['--model', 'gpt-6.1-sol', 'x']);
    assert.match(launch.buildCommand({ ai: 'codex', dir: '/tmp/a b', model: 'GPT-6.1-Sol', effort: '高', prompt: 'x' }), /--model' 'gpt-6\.1-sol' '-c' 'model_reasoning_effort=high'/);
  } finally { f.close(); launch.setDiscoveredModels({}); roles.setModelCatalog({}); }
});

test('Codex更新は固定argv、更新後版の確認、モデル再取得と旧ID保持を行う', async () => {
  const f = fixture();
  try {
    let version = '0.157.1';
    let rows = [['gpt-6.1-sol', 'GPT-6.1-Sol']];
    const calls = [];
    const tools = new AiTools({ root: f.root, home: f.home,
      find: name => name === 'codex' ? '/fixture/codex' : '', methods: { codex: 'standalone' },
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === '--version') return `codex-cli ${version}`;
        if (args[0] === 'update') { version = '0.159.0'; return 'updated'; }
        if (args[0] === 'debug') return codexJson(rows);
        throw Error('unexpected');
      },
    });
    const result = await tools.update('codex');
    assert.deepEqual([result.beforeVersion, result.afterVersion, result.verified, result.models.added], ['0.157.1', '0.159.0', true, 1]);
    assert.deepEqual(calls.map(x => x.slice(1)), [['--version'], ['update'], ['--version'], ['debug', 'models']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '_hub', 'ai-tools-models.json'), 'utf8')).codex.models,
      [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }]);

    // 古いCLIが後から書いたcacheはmtimeが新しくても、明示再取得の結果を上書きしない。
    fs.writeFileSync(path.join(f.home, '.codex', 'models_cache.json'), codexJson([['gpt-6-sol', 'GPT-6-Sol']]));
    await tools.status();
    assert.deepEqual(tools.catalog().codex.models.map(x => x.id), ['gpt-6.1-sol']);
    const savedRestart = new AiTools({ root: f.root, home: f.home, dry: true });
    assert.deepEqual(savedRestart.catalog().codex.models.map(x => x.id), ['gpt-6.1-sol']);

    rows = [['gpt-6.2-sol', 'GPT-6.1-Sol']]; // 同じ表示名でも実IDは別
    await tools.refresh('codex');
    assert.equal(tools.staleModel('codex', 'GPT-6.1-Sol'), true);
    assert.equal(tools.catalog().codex.models[0].label, 'gpt-6.2-sol');
    const restarted = new AiTools({ root: f.root, home: f.home, dry: true });
    launch.setDiscoveredModels(restarted.catalog());
    assert.equal(launch.flagFor('codex', 'GPT-6.1-Sol'), 'gpt-6.1-sol');
    assert.equal(restarted.staleModel('codex', 'GPT-6.1-Sol'), true);
  } finally { f.close(); launch.setDiscoveredModels({}); }
});

test('稼働中・並行操作を拒否し、空や失敗カタログでは保存済み候補を残す', async () => {
  const f = fixture();
  try {
    let busy = 1, release;
    const gate = new Promise(resolve => { release = resolve; });
    let mode = 'hold';
    const tools = new AiTools({ root: f.root, home: f.home,
      find: name => name === 'codex' ? '/fixture/codex' : '', methods: { codex: 'standalone' }, busy: () => busy,
      run: async (file, args) => {
        if (args[0] === '--version') return 'codex-cli 0.159.0';
        if (args[0] === 'debug' && mode === 'hold') { await gate; return codexJson([['gpt-6.1-sol', 'GPT-6.1-Sol']]); }
        if (args[0] === 'debug' && mode === 'empty') return codexJson([['hidden', 'Hidden', 'hide']]);
        if (args[0] === 'debug') { const e = Error('secret-token-in-stderr'); e.code = 7; throw e; }
        return '';
      },
    });
    await assert.rejects(tools.refresh('codex'), e => e.status === 409 && e.stage === 'busy');
    busy = 0;
    const pending = tools.refresh('codex');
    assert.equal(tools.isOperating(), true);
    await assert.rejects(tools.update('codex'), e => e.status === 409);
    release();
    await pending;
    mode = 'empty';
    await assert.rejects(tools.refresh('codex'), e => e.status === 502 && e.stage === 'models');
    assert.equal(tools.catalog().codex.models[0].id, 'gpt-6.1-sol');
    mode = 'fail';
    await assert.rejects(tools.refresh('codex'), e => e.status === 502 && !e.reason.includes('secret-token-in-stderr'));
  } finally { f.close(); }
});

test('更新後の版が読めない時は最新と断定せず、モデル候補は再取得する', async () => {
  const f = fixture();
  try {
    let updated = false;
    const tools = new AiTools({ root: f.root, home: f.home,
      find: name => name === 'codex' ? '/fixture/codex' : '', methods: { codex: 'standalone' },
      run: async (file, args) => {
        if (args[0] === '--version') return updated ? 'not-a-version' : 'codex-cli 0.157.1';
        if (args[0] === 'update') { updated = true; return ''; }
        if (args[0] === 'debug') return codexJson([['gpt-6.1-sol', 'GPT-6.1-Sol']]);
        throw Error('unexpected');
      },
    });
    const result = await tools.update('codex');
    assert.equal(result.verified, false);
    assert.equal(result.changed, false);
    assert.equal(result.afterVersion, '');
    assert.match(result.verifyError, /確認できません/);
    assert.equal(result.models.models[0].id, 'gpt-6.1-sol');
  } finally { f.close(); }
});

test('Claudeの制御応答はmainだけ使い、cache不変なら前回候補を保つ', async () => {
  const f = fixture();
  try {
    const dir = path.join(f.home, '.claude', 'cache', 'model-catalog');
    const first = path.join(dir, 'first.json');
    fs.writeFileSync(first, claudeJson([['claude-opus-5-5', 'Opus 5.5']]));
    let refreshed = false;
    const tools = new AiTools({ root: f.root, home: f.home,
      find: name => name === 'claude' ? '/fixture/claude' : '', methods: { claude: 'native' },
      refreshClaude: async () => {
        if (refreshed) fs.writeFileSync(path.join(dir, 'second.json'), claudeJson([
          ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-4-6', 'Opus 4.6', 'overflow'],
        ]));
        return ['opus', 'sonnet', 'claude-opus-4-6'];
      },
    });
    const same = await tools.refresh('claude');
    assert.equal(same.unchanged, true);
    assert.equal(same.models[0].id, 'claude-opus-5-5');
    refreshed = true;
    const next = await tools.refresh('claude');
    assert.equal(next.unchanged, undefined);
    assert.deepEqual(next.models.map(x => x.id), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  } finally { f.close(); }
});

test('Claude制御プロセスはSIGTERMを無視してもSIGKILLで回収する', async () => {
  const f = fixture();
  try {
    const pidFile = path.join(f.tmp, 'pid');
    const cli = path.join(f.tmp, 'claude-fixture');
    fs.writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdin.on('data',()=>console.log(JSON.stringify({type:'control_response',response:{subtype:'success',response:{models:[{value:'claude-opus-5-5'}]}}})));\n`, { mode: 0o755 });
    assert.deepEqual(await claudeInitialize(cli, 3000), ['claude-opus-5-5']);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

    const silent = path.join(f.tmp, 'claude-silent');
    fs.writeFileSync(silent, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o755 });
    await assert.rejects(claudeInitialize(silent, 150), e => e.stage === 'models' && /時間切れ/.test(e.reason));
    const silentPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(silentPid, 0), { code: 'ESRCH' });
  } finally { f.close(); }
});
