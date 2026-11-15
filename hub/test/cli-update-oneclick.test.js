'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { AiTools } = require('../lib/ai-tools');
const { AiUpdates } = require('../lib/ai-updates');
const launch = require('../lib/launch');
const gatePath = path.join(__dirname, '../lib/cli-trust.js');
const trust = fs.existsSync(gatePath) ? require(gatePath) : {};
const blocked = () => Object.assign(Error('Mac の確認が必要：試験の不合格'), { status:409, stage:'mac-confirmation', reason:'Mac の確認が必要：試験の不合格' });
function fixture(t, method = 'native') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-oneclick-test-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const state = { updated:false, updatedAis:new Set(), deny:false, calls:[], auth:[] };
  const tools = new AiTools({ root, home:root, methods:{claude:method,codex:'standalone'},
    find: ai => ['claude','codex','brew'].includes(ai) ? '/fake/' + ai : '',
    ready: (ai,file) => { state.calls.push(['ready',ai,state.updated]); if (ai === 'claude' && state.deny) throw blocked(); return file; },
    run: async (file,args) => {
      state.calls.push(['run',path.basename(file),args[0],state.updated]);
      if (args[0] === '--version') return state.updatedAis.has(path.basename(file)) ? '2.1.324' : '2.1.323';
      if (['update','upgrade'].includes(args[0])) { state.updated = true; state.updatedAis.add(path.basename(file)==='brew'?'claude':path.basename(file)); state.afterUpdate?.(); return ''; }
      if (args[0] === 'debug') return '{"models":[{"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list"}]}';
      throw Error('Unexpected fake command');
    }, refreshClaude: async () => { state.calls.push(['models',state.updated]); return ['claude-opus-5-5']; },
    latest: async () => ({ version:'2.1.324',source:'fixture' }) });
  const accounts = { list:()=>['claude','codex'].map(ai => ({ai,id:'default'})), readOnly:async(_ai,_id,fn)=>fn(),
    status: async ai => { state.auth.push(ai); return {status:'logged-in'}; }, env:()=>({}),location:()=>root };
  return {root,state,tools,updates:new AiUpdates({root,tools,accounts})};
}
for (const method of ['native','homebrew-cask']) test(`更新後の確認より先には新CLIを実行しない：${method}`, async t => {
  const f = fixture(t, method); const result = await f.tools.update('claude');
  assert.equal(result.afterVersion, '2.1.324');
  const updatedRuns = f.state.calls.filter(c => c[0] === 'run' && c[3]); assert.equal(updatedRuns.length,1);
  const index = f.state.calls.findIndex(c=>c===updatedRuns[0]);
  assert.ok(f.state.calls.slice(0,index).some(c=>c[0]==='ready' && c[1]==='claude' && c[2]));
  assert.deepEqual(f.state.calls.at(-1), ['models',true]);
});
for (const method of ['native','homebrew-cask']) test(`更新後の署名不合格では版も機種も起動しない：${method}`, async t => {
  const f = fixture(t, method); f.state.afterUpdate=()=>{ f.state.deny=true; };
  await assert.rejects(f.tools.update('claude'), e=>e.stage==='mac-confirmation');
  assert.equal(f.state.calls.filter(c=>c[0]==='run'&&c[3]).length,0);
  assert.equal(f.state.calls.filter(c=>c[0]==='models').length,0);
  assert.equal(f.tools.isOperating(),false);
});
test('起動時の状態取得は確認理由を返し、版も機種も起動しない', async t => {
  const f=fixture(t); f.state.deny=true;
  const status = await f.tools.status(); assert.equal(status.tools.claude.confirmationRequired,true);
  assert.match(status.tools.claude.notice,/Mac の確認が必要/);
  await assert.rejects(f.tools.refresh('claude'),e=>e.stage==='mac-confirmation');
  assert.ok(!f.state.calls.some(c=>c[0]==='models'||c[0]==='run'&&c[1]==='claude'));
});
test('一括更新は署名不合格の道具を一覧へ残し、他の道具を完了する', async t => {
  const f=fixture(t); f.state.deny=true;
  const result=await f.updates.updateAll();
  assert.equal(result.ok,true); assert.equal(result.results.find(r=>r.ai==='claude').state,'mac-confirmation');
  assert.match(result.results.find(r=>r.ai==='claude').notice,/Mac の確認が必要/);
  assert.equal(result.results.find(r=>r.ai==='codex').state,'updated');
  assert.ok(!f.state.auth.includes('claude')); assert.equal(f.updates.batch,false);
});
test('一括更新は合格した道具を更新して機種一覧まで取得する', async t => {
  const f=fixture(t); const result=await f.updates.updateAll();
  for (const ai of ['claude','codex']) assert.equal(result.results.find(r=>r.ai===ai).state,'updated');
  assert.ok(f.state.calls.some(c=>c[0]==='ready'&&c[1]==='claude'));
  assert.ok(f.state.calls.some(c=>c[0]==='models'));
});
function replaceTrust(t, replacement) {
  const original = trust.ensureCliReady; trust.ensureCliReady=replacement;
  t.after(()=>{ trust.ensureCliReady=original; });
}
test('会話開始は確認に落ちたらプロセスを作らず開始枠を戻す', t => {
  const {ChatRunner}=require('../lib/chat'); let starts=0, ends=0, checked=0;
  replaceTrust(t,()=>{ checked++; throw blocked(); });
  t.mock.method(require('../lib/cli-spool'),'start',()=>assert.fail('must not spawn'));
  const runner=new ChatRunner({spoolRoot:os.tmpdir(),startGate:()=>starts++,endGate:()=>ends++});
  assert.throws(()=>runner.run({project:'p',task:'t',dir:os.tmpdir(),pdir:os.tmpdir(),ai:'claude'}, {command:'/fake/custom-claude',args:[]}, {}, []),/Mac の確認が必要/);
  assert.equal(checked,1);assert.equal(starts,1);assert.equal(ends,1);assert.equal(runner.running.size,0);
});
test('使用量の問い合わせも確認不合格なら起動しない', async t => {
  replaceTrust(t,()=>{ throw blocked(); }); let spawned=0;
  await assert.rejects(require('../lib/usage').readCli('claude','/fake/custom-claude',{spawn:()=>{spawned++;throw Error('must not spawn');}}),e=>e.stage==='mac-confirmation');
  assert.equal(spawned,0);
});
test('明示した担当名で独自コマンドも確認し、確認後の実体を起動先にする', t => {
  const calls=[];replaceTrust(t,(ai,file)=>{calls.push([ai,file]);return '/verified/claude';});
  const resolved=launch.resolveCli('/fake/custom-claude',['--version'],{},'claude');
  assert.deepEqual(calls,[['claude','/fake/custom-claude']]);assert.equal(resolved.file,'/verified/claude');
});

test('認証状態の取得直前に確認が必要になった場合も理由を一覧へ返す', async t => {
  const f=fixture(t); f.updates.accounts.status=async ai=>{if(ai==='claude')throw blocked();return {status:'logged-in'};};
  const result=await f.updates.updateAll(); assert.equal(result.results.find(r=>r.ai==='claude').state,'mac-confirmation');
});
test('Mac確認の表示と各理由を英語・繁体字へ翻訳できる', () => {
  const keys=['Mac の確認が必要：${0}','実行ファイルの実体を確認できません','Mac の確認情報を読めません','想定した導入先ではありません','確認中に実行ファイルが変わりました','署名の厳密な検証に合格しませんでした','署名の発行元を確認できません','署名のチームまたは識別子が一致しません','Apple の公証を確認できません','Mac の確認情報を更新できません','Mac で Claude Code を開いて内容を確認し、許可したあとにもう一度操作してください。'];
  for(const lang of ['en','zh-TW']){
    const base=path.join(__dirname,'../../langpacks',lang),backend=JSON.parse(fs.readFileSync(path.join(base,'backend.json'))).messages,ui=JSON.parse(fs.readFileSync(path.join(base,'ui.json')));
    for(const key of keys)assert.ok(backend[key]&&backend[key]!==key,key);
    for(const key of ['Mac の確認が必要','Mac の確認が必要 ${0} 件。'])assert.ok(ui[key]&&ui[key]!==key,key);
    assert.ok(backend[keys[0]].includes('${0}')); assert.ok(ui['Mac の確認が必要 ${0} 件。'].includes('${0}'));
  }
});

test('作業画面の開始も不合格なら起動せず開始枠を戻す', t => {
  const {Sessions}=require('../lib/sessions'); let spawned=0,ends=0;
  replaceTrust(t,()=>{throw blocked();});
  t.mock.method(require('../lib/owned-processes'),'assertLaunchOwnership',()=>{});
  const sessions=new Sessions({pty:{spawn:()=>{spawned++;assert.fail('must not spawn');}},platformApi:{findExecutable:()=>'/fake/claude'}});sessions.endGate=()=>ends++;
  assert.throws(()=>sessions.start({project:'p',task:'t',ai:'claude',dir:os.tmpdir(),command:'claude',args:[]}),/Mac の確認が必要/);
  assert.equal(spawned,0);assert.equal(ends,1);assert.equal(sessions.map.size,0);
});

function externalRoute(t, deny, dry = false) {
  let checked = 0, opened = 0;
  replaceTrust(t, () => { checked++; if (deny) throw blocked(); return '/fake/claude'; });
  const routes = require('../lib/routes/terminal-start')({ DRY: dry, launch: { ...launch, openTerminal: async () => { opened++; return {}; } },
    licenseGuard: () => {}, store: { readProject: () => ({ id:'p' }), taskFile: () => '/fake/task', readTask: () => ({ id:'t' }) },
    pickSpec: () => ({}), requestAccount: () => 'default', modelError: () => '', startDir: () => ({ dir:os.tmpdir() }),
    permCmd: () => 'claude --dangerously-skip-permissions', taskPrompt: () => 'fixture', codexFastFor: () => false,
    accounts: { terminalCommand: (_ai,_account,command) => ({ command, cancel: () => {} }) }, send: (_res,status,body) => ({status,body}) });
  return { start: () => routes.continue.handle({}, {}, {}, { project:'p',task:'t',ai:'claude' }), counts: () => ({checked,opened}) };
}
test('外部ターミナルで続ける時も不合格なら窓もCLIも開かない', async t => {
  const route = externalRoute(t,true); await assert.rejects(route.start(), e => e.stage === 'mac-confirmation');
  assert.deepEqual(route.counts(), {checked:1,opened:0});
});
test('外部ターミナルは確認合格後に開く', async t => {
  const route = externalRoute(t,false); assert.equal((await route.start()).status,200);
  assert.deepEqual(route.counts(), {checked:1,opened:1});
});
test('外部ターミナルのdry操作は実物の確認を行わない', async t => {
  const route = externalRoute(t,true,true); assert.equal((await route.start()).status,200);
  assert.deepEqual(route.counts(), {checked:0,opened:1});
});
test('一括更新のdry操作は実物の確認を行わない', async t => {
  const f=fixture(t); f.tools.dry=true; f.state.deny=true;
  const result=await f.updates.updateAll();
  assert.equal(result.ok,true); assert.ok(!f.state.calls.some(c=>c[0]==='ready'||c[0]==='run'));
});
