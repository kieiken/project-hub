'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=require('./fixtures/app-source.cjs').readApp();
const tools={claude:{installed:true,version:'1',models:[]},codex:{installed:true,version:'1',models:[]},agy:{installed:false,models:[]}};
function fixture(){
 const elements=new Map(),listeners={};let scroller=null,settings=null,mainHtml='';
 const element=key=>{
  if(key==='#main .settings')return settings;
  if(!elements.has(key)){
   let html='';const node={hidden:false,disabled:false,textContent:'',value:'',dataset:{},contains:()=>false,setAttribute(){},addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null};
   Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{html=value;if(key==='#main'){mainHtml=value;scroller={scrollTop:0,scrollLeft:0};settings=value.includes('class="settings"')?{parentElement:scroller}:null;}else if(scroller&&['#ai-tools','#skills-box','#model-order-list','#initial-pick','#phone-labels','#climodels','#app-update-box'].includes(key)){scroller.scrollTop=0;scroller.scrollLeft=0;}}});
   elements.set(key,node);
  }
  return elements.get(key);
 };
 const context=vm.createContext({document:{body:{classList:{contains:()=>false,remove(){}}},hidden:false,activeElement:null,querySelector:element,querySelectorAll:()=>[],addEventListener(name,fn){(listeners[name] ||= []).push(fn);}},window:{},navigator:{userAgent:''},
  localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),EventSource:class{close(){}},URLSearchParams,
  setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},requestAnimationFrame:fn=>fn(),console,
  ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
 context.window.HubChatHistory = require('../public/chat-history');
 require('./fixtures/app-source.cjs').loadApp(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/role-settings.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app-update.js'),'utf8'),context);
 const snapshot={projects:[{id:'p',name:'Project',status:'進行中',parent:'',description:'',phases:[],tasks:[],folders:[],related:[],issues:[],chats:[]}],root:'/fixture',
  roles:{models:{'claude-code':['Opus 5.5'],codex:['GPT-6.1-Sol','GPT-6-Astra'],agy:[]},roles:[],permissions:{}},sessions:[],chatting:[],unread:[],terminal:true,efforts:['中','高'],hiddenModels:{},modelOrder:[],cliFlags:{},version:'1',latest:'1'};
 context.snapshot=snapshot;context.fixtureTools=tools;
 const run=code=>vm.runInContext(code,context);
 run('state=snapshot;view={kind:"settings",project:"p",task:null};aiTools=fixtureTools;loadAiTools=()=>{};loadRemote=()=>{};loadChatgpt=()=>{};loadLog=()=>{};loadChangelog=()=>{};toast=()=>{}');
 context.api=async(route,body)=>{
  if(route==='/api/skills')return{ais:Object.fromEntries(['claude','codex','agy','grok'].map(ai=>[ai,{found:false,items:[]}]))};
  if(route==='/api/langpacks')return{active:'ja',saved:'ja',packs:[],version:'1',restartNeeded:false};
  if(route==='/api/app-update')return{supported:false,enabled:false,phase:'idle'};
  if(route==='/api/models/hidden')return{hiddenModels:{codex:body.hidden?[body.model]:[]},modelOrder:[]};
  if(route==='/api/models/order')return{hiddenModels:{},modelOrder:body.order};
  if(route==='/api/ai-tools/models/refresh')return{ok:true,added:0,models:[],source:'fixture'};
  if(route==='/api/state')return snapshot;
  if(route==='/api/cli-models')return{claude:[],codex:[{name:'GPT-6.1-Sol',flag:'gpt-6.1-sol'}],hints:{claude:[],codex:[]}};
  throw Error('unexpected API '+route);
 };
 run('renderSettings()');
 return{context,run,element,listeners,scroll:()=>scroller,main:()=>mainHtml};
}
test('Skill refresh retains scrolling done while the readonly request is in flight',async()=>{
 const f=fixture();await new Promise(resolve=>setImmediate(resolve));let release;
 f.context.api=()=>new Promise(resolve=>{release=resolve;});
 f.scroll().scrollTop=1180;const pending=f.context.loadSkills(true);
 f.scroll().scrollTop=1260;f.scroll().scrollLeft=7;
 release({ais:Object.fromEntries(['claude','codex','agy','grok'].map(ai=>[ai,{found:false,items:[]}]))});await pending;
 assert.equal(f.scroll().scrollTop,1260);assert.equal(f.scroll().scrollLeft,7);
});
test('Model visibility and ordering retain the current settings scroll despite replacing their controls',async()=>{
 const f=fixture();f.scroll().scrollTop=1210;f.scroll().scrollLeft=18;
 await f.context.toggleModelVisibility({dataset:{mvAi:'codex',mv:'GPT-6-Astra'},checked:false});
 assert.equal(f.scroll().scrollTop,1210);assert.equal(f.scroll().scrollLeft,18);
 const order=JSON.parse(f.run('JSON.stringify(orderedModels())')).reverse();await f.context.saveModelOrder(order);
 assert.equal(f.scroll().scrollTop,1210);assert.equal(f.scroll().scrollLeft,18);
 assert.equal(f.run('view.kind'),'settings');
 f.context.api=async()=>{throw Error('fixture save failed');};await f.context.toggleModelVisibility({dataset:{mvAi:'codex',mv:'GPT-6-Astra'},checked:true});
 assert.equal(f.scroll().scrollTop,1210);assert.match(f.element('#model-order-list').innerHTML,/fixture save failed/);
});
test('Credit checkboxes default OFF, edit independently, preserve role drafts and save/reset with visible dirty feedback',async()=>{
 const f=fixture(),normal=f.context.api;
 const checkbox=ai=>new RegExp(`data-check-credits="${ai}"[^>]*`);
 for(const ai of ['claude','codex'])assert.doesNotMatch(f.main().match(checkbox(ai))[0],/checked/);
 assert.match(f.main(),/確認だけでは有料の継続利用を許可しません/);
 const role={name:'draft',main:{ai:'人'},backup:{ai:'人'}};
 f.context.draftRole=role;f.run('rolesDraft=[draftRole]');
 f.scroll().scrollTop=990;
 for(const fn of f.listeners.change)await fn({target:{dataset:{checkCredits:'claude'},checked:true}});
 assert.match(f.main().match(checkbox('claude'))[0],/checked/);
 assert.doesNotMatch(f.main().match(checkbox('codex'))[0],/checked/);
 assert.equal(f.run('rolesDraft[0].name'),'draft');assert.equal(f.run('rolesDirty()'),true);
 assert.equal(f.scroll().scrollTop,990);
 let saved;
 f.context.api=async(route,body)=>{if(route!=='/api/roles')return normal(route,body);saved=JSON.parse(JSON.stringify(body));throw Error('fixture save failed');};
 await f.context.saveRoles();assert.equal(f.run('checkCreditsDraft.claude'),true);
 assert.deepEqual(saved.checkCredits,{claude:true,codex:false});assert.equal(saved.roles[0].name,'draft');
 f.context.api=async(route,body)=>route==='/api/roles'?({...f.context.snapshot.roles,roles:saved.roles,checkCredits:saved.checkCredits}):normal(route,body);
 await f.context.saveRoles();assert.equal(f.run('rolesDirty()'),false);
 assert.match(f.main().match(checkbox('claude'))[0],/checked/);
 for(const fn of f.listeners.change)await fn({target:{dataset:{checkCredits:'codex'},checked:true}});
 f.run('clearRolesDraft();renderSettings()');
 assert.doesNotMatch(f.main().match(checkbox('codex'))[0],/checked/);
 assert.match(f.main().match(checkbox('claude'))[0],/checked/);
});
test('Priority checkbox defaults OFF, keeps a failed draft, saves and resets independently',async()=>{
 const f=fixture(),normal=f.context.api;assert.doesNotMatch(f.main().match(/data-prefer-credits[^>]*/)[0],/checked/);
 assert.match(f.main(),/自動チャージがない/);
 f.scroll().scrollTop=1120;
 for(const fn of f.listeners.change)await fn({target:{dataset:{preferCredits:''},checked:true}});
 assert.equal(f.run('rolesDirty()'),true);assert.equal(f.scroll().scrollTop,1120);
 let saved;f.context.api=async(route,body)=>{if(route!=='/api/roles')return normal(route,body);saved=JSON.parse(JSON.stringify(body));throw Error('fixture failure');};
 await f.context.saveRoles();assert.equal(saved.preferCredits,true);assert.equal(f.run('preferCreditsDraft'),true);
 assert.deepEqual(saved.checkCredits,{claude:false,codex:false});
 f.context.api=async(route,body)=>route==='/api/roles'?({...f.context.snapshot.roles,roles:saved.roles,checkCredits:saved.checkCredits,preferCredits:saved.preferCredits}):normal(route,body);
 await f.context.saveRoles();assert.equal(f.run('rolesDirty()'),false);
 for(const fn of f.listeners.change)await fn({target:{dataset:{preferCredits:''},checked:false}});
 f.run('clearRolesDraft();renderSettings()');assert.match(f.main().match(/data-prefer-credits[^>]*/)[0],/checked/);
});
test('Model refresh preserves scrolling done while its request is in flight and through the CLI table update',async()=>{
 const f=fixture(),normal=f.context.api;let release;
 f.context.api=(route,body)=>route==='/api/ai-tools/models/refresh'?new Promise(resolve=>{release=resolve;}):normal(route,body);
 f.scroll().scrollTop=870;const pending=f.context.runAiTool('codex','models');assert.equal(f.scroll().scrollTop,870);
 f.scroll().scrollTop=1390;release({ok:true,added:0,models:[],source:'fixture'});await pending;
 assert.equal(f.scroll().scrollTop,1390);assert.match(f.element('#climodels').innerHTML,/gpt-6\.1-sol/);
});
test('A whole settings rerender retains its own position, while intentional route changes keep normal new-page behavior',()=>{
 const f=fixture();f.scroll().scrollTop=1520;f.scroll().scrollLeft=12;const old=f.scroll();
 f.run('renderSettings()');assert.notEqual(f.scroll(),old);assert.equal(f.scroll().scrollTop,1520);assert.equal(f.scroll().scrollLeft,12);
 f.run('view.kind="project";render()');assert.equal(f.scroll().scrollTop,0);assert.doesNotMatch(f.main(),/class="settings"/);
 f.run('view.kind="settings";render()');assert.equal(f.scroll().scrollTop,0);assert.match(f.main(),/class="view settings-view"/);
});
test('App update polling and toggle redraw preserve scroll changes made during their requests',async()=>{
 const f=fixture();await f.context.loadAppUpdate();let release;
 f.context.api=()=>new Promise(resolve=>{release=resolve;});
 f.scroll().scrollTop=710;const polling=f.context.loadAppUpdate();
 f.scroll().scrollTop=1270;release({supported:true,enabled:false,phase:'idle'});await polling;
 assert.equal(f.scroll().scrollTop,1270);
 const changing=f.context.changeAppUpdate(true);assert.equal(f.scroll().scrollTop,1270);
 f.scroll().scrollTop=1480;release({supported:true,enabled:true,phase:'idle'});await changing;
 assert.equal(f.scroll().scrollTop,1480);assert.match(f.element('#app-update-box').innerHTML,/id="app-auto-update"[^>]*checked/);
});

test('Two theme buttons switch directly, keeping drafts, scroll and live terminals through tab sync and storage failure',async()=>{
 const f=fixture(),storage=new Map(),meta={},buttons={},messages=[];let blocked=false;
 for(const value of ['dark','light'])buttons[value]={dataset:{themeChoice:value},setAttribute(name,value){this[name]=value;}};
 f.context.document.documentElement={dataset:{}};
 const query=f.context.document.querySelector;
 f.context.document.querySelector=selector=>selector==='meta[name="theme-color"]'?meta:query(selector);
 f.context.document.querySelectorAll=selector=>selector==='[data-theme-choice]'?Object.values(buttons):[];
 f.context.document.dispatchEvent=event=>{for(const fn of f.listeners[event.type]||[])fn(event);};
 f.context.Event=class{constructor(type){this.type=type;}};
 f.context.window.addEventListener=(name,fn)=>{(f.listeners[name]||=[]).push(fn);};
 f.context.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>{if(blocked)throw Error('blocked');storage.set(key,value);}};
 f.context.toast=message=>messages.push(message);
 f.run(fs.readFileSync(path.join(__dirname,'../public/theme.js'),'utf8'));
 f.run('renderSettings()');
 assert.match(f.main(),/role="group" aria-label="配色"/);
 assert.match(f.main(),/data-theme-choice="dark" aria-pressed="true">ダーク<\/button>/);
 assert.match(f.main(),/data-theme-choice="light" aria-pressed="false">ライト<\/button>/);
 assert.doesNotMatch(f.main(),/id="set-theme"/);
 const live={options:{}},second={options:{}};f.context.liveTerminal=live;f.context.secondTerminal=second;
 f.run('panes.codex={xterm:liveTerminal};panes.claude={xterm:secondTerminal};rolesDraft=[{name:"draft",main:{ai:"人"},backup:{ai:"人"}}];');
 f.scroll().scrollTop=120;const scroller=f.scroll();
 const click=async value=>{const target={dataset:{},closest:selector=>selector==='[data-theme-choice]'?buttons[value]:null};for(const fn of f.listeners.click)await fn({target});};
 for(const value of ['light','dark']){
  await click(value);
  assert.equal(storage.get('hub-theme'),value);assert.equal(f.context.window.HubTheme.current(),value);
  assert.equal(buttons[value]['aria-pressed'],'true');assert.equal(buttons[value==='light'?'dark':'light']['aria-pressed'],'false');
  assert.equal(live.options.theme.background,value==='light'?'#f9fbfd':'#10131a');assert.deepEqual(second.options.theme,live.options.theme);
  assert.equal(f.run('rolesDraft[0].name'),'draft');assert.equal(f.scroll(),scroller);assert.equal(f.scroll().scrollTop,120);
 }
 blocked=true;await click('light');assert.equal(storage.get('hub-theme'),'dark');assert.equal(buttons.light['aria-pressed'],'true');assert.match(messages.at(-1),/保存できませんでした/);
 for(const fn of f.listeners.storage)fn({key:'hub-theme',newValue:'dark'});
 assert.equal(buttons.dark['aria-pressed'],'true');assert.equal(live.options.theme.background,'#10131a');
 for(const fn of f.listeners.storage)fn({key:'hub-theme',newValue:'light'});
 assert.equal(buttons.light['aria-pressed'],'true');assert.equal(storage.get('hub-theme'),'dark');
 for(const fn of f.listeners.storage)fn({key:null,newValue:null});
 assert.equal(buttons.dark['aria-pressed'],'true');assert.equal(live.options.theme.background,'#10131a');
 assert.equal(f.scroll(),scroller);assert.equal(f.scroll().scrollTop,120);assert.equal(f.run('rolesDraft[0].name'),'draft');
 blocked=false;f.run('renderSettings()');assert.match(f.main(),/data-theme-choice="dark" aria-pressed="true"/);
});

// Language-pack assertions stay separate so normal Japanese runs can exclude them.
test('zh-TW language-pack credit labels',()=>{
 const UI=require('./ui-locale-fixture')('zh-TW');
 assert.equal(UI.text('Claudeのクレジットを確認'),'確認 Claude 的點數');
 assert.equal(UI.text('Codexのクレジットを確認'),'確認 Codex 的點數');
 assert.equal(UI.text('既存クレジットを優先利用'),'優先使用現有點數');
});

test('automatic Ultra defaults OFF, preserves failed drafts and saves without changing roles',async()=>{
 const f=fixture(),normal=f.context.api;const before=JSON.stringify(f.context.snapshot.roles.roles);
 assert.doesNotMatch(f.main().match(/data-allow-delegate-ultra[^>]*/)[0],/checked/);
 for(const fn of f.listeners.change)await fn({target:{dataset:{allowDelegateUltra:''},checked:true}});
 assert.equal(f.run('rolesDirty()'),true);let saved;
 f.context.api=async(route,body)=>{if(route!=='/api/roles')return normal(route,body);saved=JSON.parse(JSON.stringify(body));throw Error('save failed');};
 await f.context.saveRoles();assert.equal(saved.allowDelegateUltra,true);assert.equal(f.run('allowDelegateUltraDraft'),true);assert.equal(JSON.stringify(saved.roles),before);
 f.context.api=async(route,body)=>route==='/api/roles'?({...f.context.snapshot.roles,...saved}):normal(route,body);
 await f.context.saveRoles();assert.equal(f.run('rolesDirty()'),false);assert.match(f.main().match(/data-allow-delegate-ultra[^>]*/)[0],/checked/);
 for(const fn of f.listeners.change)await fn({target:{dataset:{allowDelegateUltra:''},checked:false}});
 f.run('clearRolesDraft();renderSettings()');assert.match(f.main().match(/data-allow-delegate-ultra[^>]*/)[0],/checked/);
});
test('delegated request shows its applied effort and distinguishes role, one-off and fallback',()=>{
 const f=fixture();f.context.row={role:'user',to:'codex',model:'GPT-6.1-Sol',text:'【渡した依頼：fixture】\nfixture',origin:'delegate',effort:'Ultra',delegationEffort:{source:'override',requested:'Ultra'}};
 let html=f.run('baseMsgHtml(row)');assert.match(html,/Ultra（この依頼だけの思考）/);
 f.context.row.effort='MAX';f.context.row.delegationEffort.source='fallback';html=f.run('baseMsgHtml(row)');assert.match(html,/MAX（Ultraを保存値へ戻しました）/);
 f.context.row.delegationEffort.source='role';html=f.run('baseMsgHtml(row)');assert.match(html,/MAX（役割の思考）/);
 f.context.row.to='claude';f.context.row.effort='極高';f.context.row.delegationEffort.workflow=true;html=f.run('baseMsgHtml(row)');assert.match(html,/補助AIの分担あり/);
});
