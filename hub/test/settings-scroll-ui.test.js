'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const tools={claude:{installed:true,version:'1',models:[]},codex:{installed:true,version:'1',models:[]},agy:{installed:false,models:[]}};
function fixture(){
 const elements=new Map();let scroller=null,settings=null,mainHtml='';
 const element=key=>{
  if(key==='#main .settings')return settings;
  if(!elements.has(key)){
   let html='';const node={hidden:false,disabled:false,textContent:'',value:'',dataset:{},setAttribute(){},addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null};
   Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{html=value;if(key==='#main'){mainHtml=value;scroller={scrollTop:0,scrollLeft:0};settings=value.includes('class="settings"')?{parentElement:scroller}:null;}else if(scroller&&['#ai-tools','#model-order-list','#initial-pick','#phone-labels','#climodels','#app-update-box'].includes(key)){scroller.scrollTop=0;scroller.scrollLeft=0;}}});
   elements.set(key,node);
  }
  return elements.get(key);
 };
 const context=vm.createContext({document:{hidden:false,activeElement:null,querySelector:element,querySelectorAll:()=>[],addEventListener(){}},window:{},navigator:{userAgent:''},
  localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),EventSource:class{close(){}},URLSearchParams,
  setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},requestAnimationFrame:fn=>fn(),console,
  ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
 vm.runInContext(source,context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app-update.js'),'utf8'),context);
 const snapshot={projects:[{id:'p',name:'Project',status:'進行中',parent:'',description:'',phases:[],tasks:[],folders:[],related:[],issues:[],chats:[]}],root:'/fixture',
  roles:{models:{'claude-code':['Opus 5.5'],codex:['GPT-6.1-Sol','GPT-6-Astra'],agy:[]},roles:[],permissions:{}},sessions:[],chatting:[],unread:[],terminal:true,efforts:['中','高'],hiddenModels:{},modelOrder:[],cliFlags:{},version:'1',latest:'1'};
 context.snapshot=snapshot;context.fixtureTools=tools;
 const run=code=>vm.runInContext(code,context);
 run('state=snapshot;view={kind:"settings",project:"p",task:null};aiTools=fixtureTools;loadAiTools=()=>{};loadRemote=()=>{};loadChatgpt=()=>{};loadLog=()=>{};loadChangelog=()=>{};toast=()=>{}');
 context.api=async(route,body)=>{
  if(route==='/api/app-update')return{supported:false,enabled:false,phase:'idle'};
  if(route==='/api/models/hidden')return{hiddenModels:{codex:body.hidden?[body.model]:[]},modelOrder:[]};
  if(route==='/api/models/order')return{hiddenModels:{},modelOrder:body.order};
  if(route==='/api/ai-tools/models/refresh')return{ok:true,added:0,models:[],source:'fixture'};
  if(route==='/api/state')return snapshot;
  if(route==='/api/cli-models')return{claude:[],codex:[{name:'GPT-6.1-Sol',flag:'gpt-6.1-sol'}],hints:{claude:[],codex:[]}};
  throw Error('unexpected API '+route);
 };
 run('renderSettings()');
 return{context,run,element,scroll:()=>scroller,main:()=>mainHtml};
}
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
