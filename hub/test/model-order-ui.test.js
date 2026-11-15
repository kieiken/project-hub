'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const ModelOrder=require('../public/model-order');
const models={'claude-code':['Opus 5.5','Fable 5.2'],codex:['GPT-6.1-Sol','GPT-6-Astra'],agy:['Gemini 3.1 Pro (High)']};
const defaults=ModelOrder.ordered(models),mixed=[defaults[3],defaults[0],defaults[2],defaults[1],defaults[4]];
function accountModels(f) {
 f.run(`state.accounts=[{ai:'codex',id:'default',name:'既定'},{ai:'codex',id:'spare',name:'予備用'}];
 state.roles.models.codex=['GPT-6.1-Sol','GPT-6-Luna'];state.cliFlags.codex={'GPT-6.1-Sol':'gpt-6.1-sol','GPT-6-Luna':'gpt-6-luna'};
 state.codexModelCatalogs={default:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}],source:'fixture'},spare:{models:[{id:'gpt-6-luna',label:'GPT-6-Luna'}],source:'fixture'}};
 state.codexHiddenModels={};state.hiddenModels={};`);
}
function fixture() {
 const elements=new Map(),events={},calls=[],messages=[];let focus;
 const focusButtons=mixed.flatMap(id=>['up','down'].map(direction=>({disabled:false,dataset:{[direction==='up'?'moUp':'moDown']:id},focus:()=>focus={id,direction}})));
 const el=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',value:'',hidden:false,dataset:{},querySelector:()=>null,querySelectorAll:()=>focusButtons,setAttribute(){},addEventListener(){}});return elements.get(s);};
 const document={querySelector:el,querySelectorAll:()=>[],addEventListener:(n,f)=>(events[n]||=[]).push(f)};
 const ctx=vm.createContext({document,window:{matchMedia:()=>({matches:false})},navigator:{userAgent:''},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},requestAnimationFrame(){},console,URLSearchParams,ModelOrder,ProjectOrder:require('../public/project-order'),confirm:()=>true});
 ctx.window.HubChatHistory = require('../public/chat-history');
 const run=s=>vm.runInContext(s,ctx);const paid=path.join(__dirname,'../public/paid/webchat.js');if(fs.existsSync(paid))run(fs.readFileSync(paid,'utf8'));require('./fixtures/app-source.cjs').loadApp(ctx);
 run(fs.readFileSync(path.join(__dirname,'../public/role-settings.js'),'utf8'));
 ctx.stubApi=async(route,b)=>{calls.push({route,b:JSON.parse(JSON.stringify(b))});if(ctx.hold)await ctx.hold;if(ctx.fail){const e=Error(ctx.fail);e.status=ctx.status;throw e;}if(route==='/api/models/hidden')return{modelOrder:mixed,hiddenModels:{codex:b.hidden?[b.model]:[]}};return {modelOrder:b.order,hiddenModels:{codex:['GPT-6-Astra']}};};
 ctx.notice=x=>messages.push(x);
 run(`api=stubApi;toast=notice;loadAiTools=()=>{};loadCliModels=()=>{};loadChatgpt=()=>{};loadRemote=()=>{};loadLog=()=>{};loadChangelog=()=>{};state={museSupported:false,roles:{models:${JSON.stringify(models)},roles:[{name:'調査',main:{ai:'claude-code',model:'Opus 5.5',effort:'中'},backup:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}}],permissions:{},switch:{auto:false}},cliFlags:{claude:{'Opus 5.5':'claude-opus-5-5'},codex:{'GPT-6.1-Sol':'gpt-6.1-sol'}},modelOrder:[],hiddenModels:{codex:['GPT-6-Astra']},projects:[{id:'p',name:'見本',phases:[],tasks:[{id:'t',title:'作業',owner:'codex',model:'GPT-6.1-Sol',effort:'高',state:'実行中',steps:[]}]}],sessions:[],chatting:[],unread:[],efforts:['中','高'],root:'/isolated',agyAvailable:false};view={kind:'settings',project:'p'};`);
 return{ctx,run,el,calls,messages,events,focus:()=>focus};
}
test('アカウント切替で候補と表示設定を切り替え、旧モデルは利用不可として保持し役割を変えない',()=>{
 const f=fixture();accountModels(f);const before=f.run('JSON.stringify(state.roles.roles)');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(taskModels("codex",taskOf(proj("p"),"t")))')),['GPT-6.1-Sol']);
 f.run('taskOf(proj("p"),"t").accounts={codex:"spare"}');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(taskModels("codex",taskOf(proj("p"),"t"),"GPT-6.1-Sol"))')),['GPT-6-Luna']);
 const chat=f.run('chatModelChoices(proj("p"),taskOf(proj("p"),"t"))');
 assert.match(chat,/value="codex\|GPT-6\.1-Sol"[^>]*selected disabled/);assert.match(chat,/value="codex\|GPT-6-Luna"/);
 const terminal=f.run('specSelect(proj("p"),taskOf(proj("p"),"t"),"codex",false)');
 assert.match(terminal,/selected disabled value="GPT-6\.1-Sol"/);assert.match(terminal,/>GPT-6-Luna<\/option>/);
 f.run('state.sessions=[{project:"p",task:"t",ai:"codex",running:true,account:"default"}]');
 const live=f.run('specSelect(proj("p"),taskOf(proj("p"),"t"),"codex",true)');
 assert.match(live,/>GPT-6\.1-Sol<\/option>/);assert.doesNotMatch(live,/GPT-6-Luna<\/option>|現在の指定・利用不可/);
 f.run('state.codexHiddenModels.spare=["GPT-6-Luna"]');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(taskModels("codex",taskOf(proj("p"),"t")))')),[]);
 f.run('taskOf(proj("p"),"t").accounts.codex="default"');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(taskModels("codex",taskOf(proj("p"),"t")))')),['GPT-6.1-Sol']);
 assert.equal(f.run('JSON.stringify(state.roles.roles)'),before);
 f.run('state.codexModelCatalogs.spare={models:[],source:""};taskOf(proj("p"),"t").accounts.codex="spare"');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(taskModels("codex",taskOf(proj("p"),"t")))')),[]);
});
test('表示の保存と再取得は設定で選んだアカウントを送り、エラー後も保存値を保持する',async()=>{
 const f=fixture();accountModels(f);f.run('codexModelAccount="spare"');
 const html=f.run('modelOrderHtml()');assert.match(html,/id="codex-model-account"/);assert.match(html,/GPT-6\.1-Sol（このアカウントの候補外）/);
 f.ctx.stubApi=async(route,b)=>{f.calls.push({route,b});if(route==='/api/models/hidden')return {hiddenModels:{},codexHiddenModels:{spare:['GPT-6-Luna']},modelOrder:[]};throw Error('fixture unavailable');};
 f.run('api=stubApi');
 await f.run('toggleModelVisibility({dataset:{mvAi:"codex",mv:"GPT-6-Luna"},checked:false})');
 assert.equal(f.calls[0].b.account,'spare');assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.codexHiddenModels)')),{spare:['GPT-6-Luna']});
 await f.run('refreshCodexAccountModels()');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].b)),{ai:'codex',account:'spare'});
 assert.match(f.run('modelOrderNotice'),/fixture unavailable/);assert.equal(f.run('codexModelsPending'),false);
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.codexHiddenModels)')),{spare:['GPT-6-Luna']});
});
test('既定の表示保存は役割・新規開始・すぐ始める欄にも反映し、追加アカウントは共通欄を変えない',async t=>{
 const os=require('node:os'),{ModelView}=require('../lib/model-view');
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-default-model-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const view=new ModelView(path.join(root,'model-view.json')),f=fixture();accountModels(f);
 f.run('state.codexModelCatalogs.default.models.push({id:"gpt-6-luna",label:"GPT-6-Luna"});codexModelAccount="default";state.initialPick={ai:"codex",model:"GPT-6.1-Sol",effort:"高"}');
 f.ctx.stubApi=async(route,b)=>{assert.equal(route,'/api/models/hidden');return view.setHidden(b.ai,b.model,b.hidden,b.account);};f.run('api=stubApi');
 const render=()=>[f.run('roleModelOptions("codex","GPT-6.1-Sol")'),f.run('initialPickHtml()'),f.run('quickControls({id:"fresh"})')];
 for(const html of render())assert.match(html,/GPT-6-Luna/);
 await f.run('toggleModelVisibility({dataset:{mvAi:"codex",mv:"GPT-6-Luna"},checked:false})');
 for(const html of render())assert.doesNotMatch(html,/GPT-6-Luna/);
 await f.run('toggleModelVisibility({dataset:{mvAi:"codex",mv:"GPT-6-Luna"},checked:true})');
 for(const html of render())assert.match(html,/GPT-6-Luna/);
 f.run('codexModelAccount="spare"');
 await f.run('toggleModelVisibility({dataset:{mvAi:"codex",mv:"GPT-6-Luna"},checked:false})');
 for(const html of render())assert.match(html,/GPT-6-Luna/);
 assert.deepEqual(view.read().hidden.codex,[]);assert.deepEqual(view.read().codexHidden.spare,['GPT-6-Luna']);
});
test('作業のアカウント保存完了直後に会話候補を更新し、失敗時は選択と候補を戻す',async()=>{
 const f=fixture();accountModels(f);f.run('view={kind:"work",project:"p",task:"t"}');
 f.ctx.stubApi=async(route,b)=>{f.calls.push({route,b});if(f.ctx.fail)throw Error('save failed');return {accounts:{codex:'spare'}};};
 f.run('api=stubApi');
 const el={dataset:{p:'p',t:'t',ai:'codex'},value:'spare',disabled:false};f.ctx.picker=el;
 await f.run('saveTaskAccount(picker)');
 assert.match(f.el('#chat-ai').innerHTML,/value="codex\|GPT-6-Luna"/);assert.equal(f.run('taskOf(proj("p"),"t").accounts.codex'),'spare');
 f.ctx.fail=true;el.value='default';await f.run('saveTaskAccount(picker)');assert.equal(el.value,'spare');
 assert.equal(f.run('taskOf(proj("p"),"t").accounts.codex'),'spare');assert.match(f.el('#chat-ai').innerHTML,/value="codex\|GPT-6-Luna"/);
});
test('並べ替え後も新規開始はSol・高、保存済みの開始選択と役割担当を保持する',async()=>{
 const f=fixture(),roles=f.run('JSON.stringify(state.roles)');
 f.run('state.hiddenModels={codex:["GPT-6.1-Sol"]}');
 const fresh={id:'fresh'},saved={id:'saved',startSpec:{ai:'claude',model:'Fable 5.2',effort:'中'}};
 f.ctx.fresh=fresh;f.ctx.saved=saved;
 const before=f.run('JSON.stringify([quickDraft(fresh),quickDraft(saved)])');
 await f.run(`saveModelOrder(${JSON.stringify(mixed)})`);
 f.run('state.hiddenModels={codex:["GPT-6.1-Sol"]}');
 assert.equal(f.run('JSON.stringify([quickDraft(fresh),quickDraft(saved)])'),before);
 assert.equal(f.run('JSON.stringify(state.roles)'),roles);
 const html=f.run('quickControls(fresh)');
 assert.match(html,/value="codex" selected/);assert.match(html,/<option value="GPT-6.1-Sol" selected>GPT-6.1-Sol<\/option>/);assert.match(html,/<option selected>高<\/option>/);
 assert.ok(html.indexOf('>GPT-6-Astra</option>')<html.indexOf('>GPT-6.1-Sol</option>'),'一覧の先頭を初期選択にしない');
 f.ctx.FormData=class{get(k){return k==='firstTask'?'隔離の最初の依頼':null;}getAll(){return [];}entries(){return [['name','見本']][Symbol.iterator]();}};
 f.ctx.stubApi=async(route,b)=>{f.calls.push({route,b:JSON.parse(JSON.stringify(b))});return route==='/api/project/new'?{id:'fresh',name:'見本'}:{task:'new'};};
 f.run('api=stubApi;load=async()=>{}');
 await f.events.submit.find(fn=>fn.toString().includes("'projform'"))({target:{id:'projform',classList:{contains:()=>false}},preventDefault(){}});
 const started=f.calls.find(x=>x.route==='/api/start');
 assert.deepEqual(started.b,{project:'fresh',text:'隔離の最初の依頼',ai:'codex',model:'GPT-6.1-Sol',effort:'高',images:[]});
});
test('上下保存はAI横断で会話と単一AI欄に反映、非表示の現在選択を保持、ChatGPT最後・Agy無効',async()=>{
 const f=fixture(),before=f.run('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(proj("p"),taskOf(proj("p"),"t"))])');
 await f.run(`saveModelOrder(${JSON.stringify(mixed)},{id:'codex|GPT-6-Astra',direction:'down'})`);
 assert.deepEqual(f.calls[0].b.before,defaults);assert.deepEqual(f.calls[0].b.order,mixed);assert.deepEqual(JSON.parse(f.run(`JSON.stringify(shownModels('codex','GPT-6-Astra'))`)),['GPT-6-Astra','GPT-6.1-Sol']);
 f.run(`state.hiddenModels={};`);const html=f.run('chatHtml(proj("p"),taskOf(proj("p"),"t"))');const ids=[...html.matchAll(/<option value="([^\"]+)"/g)].map(x=>x[1]);assert.deepEqual(ids,[...mixed.map(x=>x.replace('claude-code|','claude|')),...(f.ctx.window.HubPaidWebchat?['chatgpt|auto']:[])]);if(f.ctx.window.HubPaidWebchat)assert.match(html,/<option value="chatgpt\|auto"[^>]+disabled/);else assert.doesNotMatch(html,/value="chatgpt\|auto"/);assert.match(html,/<option value="agy[^>]+disabled/);assert.match(html,/codex\|GPT-6.1-Sol"[^>]+selected/);
 assert.equal(f.run('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(proj("p"),taskOf(proj("p"),"t"))])'),before);assert.deepEqual(f.focus(),{id:'codex|GPT-6-Astra',direction:'down'});
});
test('保存中は二重送信なし、失敗は復元して理由、遅いpollは保存を上書きしない',async()=>{
 const f=fixture();let release;f.ctx.hold=new Promise(r=>release=r);f.ctx.fail='見本の保存失敗';
 const pending=f.run(`saveModelOrder(${JSON.stringify(mixed)})`);assert.match(f.el('#model-order-list').innerHTML,/保存中/);assert.match(f.el('#model-order-list').innerHTML,/data-mo-down=[^>]+disabled/);
 await f.run(`saveModelOrder(${JSON.stringify(defaults)})`);assert.equal(f.calls.length,1);const epoch=f.run('stateLoadEpoch');release();await pending;assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.modelOrder)')),[]);assert.match(f.el('#model-order-list').innerHTML,/見本の保存失敗/);assert.ok(f.run('stateLoadEpoch')>epoch);
});
test('設定内の役割欄も非表示・新候補を反映し、現在の選択と未保存の担当を保持',()=>{
 const f=fixture(),select={dataset:{r:'0',k:'backup'},value:'GPT-6.1-Sol',options:[{value:'GPT-6.1-Sol'},{value:'GPT-6-Astra'}],innerHTML:''};
 f.ctx.document.querySelectorAll=s=>s==='select[data-f="model"]'?[select]:[];
 f.run('rolesDraft=JSON.parse(JSON.stringify(state.roles.roles)); rolesDraft[0].backup.effort="極高";state.modelOrder='+JSON.stringify(mixed));
 const draft=f.run('JSON.stringify(rolesDraft)');f.run('syncRoleModelOrder()');assert.doesNotMatch(select.innerHTML,/GPT-6-Astra/);assert.match(select.innerHTML,/selected>GPT-6.1-Sol/);assert.equal(select.value,'GPT-6.1-Sol');
 f.run('state.hiddenModels={codex:["GPT-6.1-Sol"]};state.roles.models.codex.push("新候補")');f.run('syncRoleModelOrder()');assert.match(select.innerHTML,/GPT-6-Astra/);assert.match(select.innerHTML,/新候補/);assert.match(select.innerHTML,/selected>GPT-6.1-Sol/);assert.equal(f.run('JSON.stringify(rolesDraft)'),draft);
});
test('同時変更409は上書きせず最新を再読、候補不在の保存位置を維持',async()=>{
 const f=fixture();f.ctx.fail='並びが変わりました';f.ctx.status=409;f.ctx.fresh={modelOrder:mixed,hiddenModels:{}};f.run('fetchState=async()=>fresh');await f.run(`saveModelOrder(${JSON.stringify(mixed)})`);assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.modelOrder)')),mixed);assert.match(f.el('#model-order-list').innerHTML,/並びが変わりました/);
 f.ctx.fail=null;f.run(`state.modelOrder=['codex|休止中',...${JSON.stringify(mixed)}]`);await f.run(`saveModelOrder(${JSON.stringify(defaults)})`);assert.equal(f.calls.at(-1).b.order[0],'codex|休止中');
});
test('削除モデルは初回役割表示・一覧更新・並べ替え・通常会話で利用不可の保存値だけを残す',()=>{
 const f=fixture(),roles=require('../lib/roles');
 roles.setModelCatalog({claude:{models:[{id:'claude-opus-5-5',label:'Opus 5.5'}]},codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]}});
 try {
  f.ctx.normalized=roles.normalize({models:{codex:['Removed Codex']},roles:{調査:{main:['claude-code','Removed Claude','高'],backup:['codex','Removed Codex','高']}}});
  f.run('state.roles={...state.roles,...normalized};rolesDraft=JSON.parse(JSON.stringify(state.roles.roles));state.projects[0].tasks[0].model="Removed Codex"');
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(shownModels("codex","Removed Codex"))')),['GPT-6.1-Sol']);
  assert.match(f.run('roleModelOptions("claude-code","Removed Claude")'),/<option selected disabled value="Removed Claude">Removed Claude（利用不可）/);
  assert.match(f.run('roleModelOptions("codex","Removed Codex")'),/<option selected disabled value="Removed Codex">Removed Codex（利用不可）/);
  const select={dataset:{r:'0',k:'backup'},value:'Removed Codex',options:[{value:'Removed Codex'}],innerHTML:''};
  f.ctx.document.querySelectorAll=s=>s.includes('select[data-')?[select]:[];
  const draft=f.run('JSON.stringify(rolesDraft)');f.run('refreshRoleModelChoices()');assert.match(select.innerHTML,/selected disabled value="Removed Codex"[^>]*>Removed Codex（利用不可）/);
  f.run('syncRoleModelOrder()');assert.match(select.innerHTML,/selected disabled value="Removed Codex"[^>]*>Removed Codex（利用不可）/);assert.equal(f.run('JSON.stringify(rolesDraft)'),draft);
  const html=f.run('chatHtml(proj("p"),taskOf(proj("p"),"t"))');assert.match(html,/value="codex\|Removed Codex"[^>]*selected disabled[^>]*>Codex・Removed Codex（利用不可/);
  f.run('view.kind="work";view.task="t";syncChatModelChoices()');assert.match(f.el('#chat-ai').innerHTML,/value="codex\|Removed Codex"[^>]*selected disabled/);assert.equal(f.el('#chat-ai').value,'codex|Removed Codex');
  f.run('state.roles.models.codex.push("Removed Codex");syncChatModelChoices()');assert.doesNotMatch(f.el('#chat-ai').innerHTML,/Removed Codex（利用不可/);
  f.run('state.roles.models.codex=["GPT-6.1-Sol"];syncChatModelChoices()');assert.match(f.el('#chat-ai').innerHTML,/Removed Codex（利用不可/);
 } finally {roles.setModelCatalog({});}
});
test('設定の端・aria-label、リセットの確認とhidden保持、ドラッグによる移動',async()=>{
 const f=fixture();const html=f.run('modelOrderHtml()');assert.match(html,/data-mo-up="claude-code\|Opus 5.5"[^>]+disabled/);assert.match(html,/data-mo-down="agy\|Gemini 3.1 Pro \(High\)"[^>]+disabled/);assert.match(html,/aria-label="Claude Code・Opus 5.5 を上へ"/);
 // イベントリスナーが使う実際のボタン経路。Enterもclickを発生させる。
 const click=f.events.click.find(fn=>fn.toString().includes('data-mo-up'));
 const target={id:'',dataset:{moDown:defaults[0]},disabled:false};click({target:{closest:()=>target}});await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,1);assert.equal(f.calls[0].b.order[1],defaults[0]);
 const reset={id:'model-order-reset',dataset:{},disabled:false};f.ctx.confirm=()=>false;click({target:{closest:()=>reset}});assert.equal(f.calls.length,1);f.ctx.confirm=()=>true;click({target:{closest:()=>reset}});await new Promise(r=>setImmediate(r));assert.deepEqual(f.calls.at(-1).b.order,[]);assert.deepEqual(JSON.parse(f.run('JSON.stringify(state.hiddenModels.codex)')),['GPT-6-Astra']);
 const start=f.events.dragstart.find(fn=>fn.toString().includes('data-mo-grip')),drop=f.events.drop.find(fn=>fn.toString().includes('data-mo-row'));
 start({target:{closest:()=>({dataset:{moGrip:defaults[2]}})},dataTransfer:{setData(){}},preventDefault(){}});
 const over=f.events.dragover.find(fn=>fn.toString().includes('data-mo-row'));let stopped=false;const row={dataset:{moRow:defaults[0]},classList:{add(){}},getBoundingClientRect:()=>({top:0,height:40})},dataTransfer={};
 over({target:{closest:()=>row},clientY:0,dataTransfer,preventDefault(){},stopImmediatePropagation(){stopped=true;}});assert.equal(dataTransfer.dropEffect,'move');assert.equal(stopped,true);
 drop({target:{closest:()=>row},clientY:0,preventDefault(){},stopImmediatePropagation(){}});await new Promise(r=>setImmediate(r));assert.equal(f.calls.at(-1).b.order[0],defaults[2]);
});
