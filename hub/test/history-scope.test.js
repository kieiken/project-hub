'use strict';
// Execute the saved server functions in VM; every startup/write is a fixture.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),scope=require('../lib/resource-scope');
const between=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i);return source.slice(i,j);};
function protection(){
 const state={blockers:[],ids:new Set(['p','shared']),update:false,restart:false,autos:[{project:'p',task:'t'},{project:'q',task:'u'}],ticks:[],pending:[],transfers:[]};
 const ctx=vm.createContext({require:name=>name==='./lib/resource-scope'?{relatedProjects:project=>state.ids===null?null:project==='p'?state.ids:new Set([project])}:{TextBudget:class{constructor(o){this.busy=o.busy;}}},
 store:{listProjects:()=>['p','q','shared'].map(id=>({id}))},baseOf:()=>'',expandHome:x=>x,__dirname:'/fixture/hub',updateBlockers:()=>state.blockers,
 appUpdate:{applying:()=>state.update},restartControl:{get committed(){return state.restart;}},appShell:{rebuilding:false},lt:x=>x,
 taskIntegrate:{active:null,pending:()=>state.pending},integrateAuto:{active:false},taskTransfer:{pending:()=>state.transfers},
 taskHistory:{activeWrites:new Set(),organizing:()=>false,busy:()=>'',activeAutos:()=>state.autos},freetalkHistory:{activeWrites:new Set()},gpt:{},
 autoTick:(p,t)=>state.ticks.push(p+':'+t),setInterval:f=>(state.timer=f,{unref(){}})});
 vm.runInContext(between('const historyProjects =','gpt.textBudget=textBudget;')+'\nglobalThis.blockers=historyBlockers;globalThis.budget=textBudget;',ctx);
 vm.runInContext(between('const autoTimer=setInterval','// Context rotation'),ctx);
 return {state,ctx};
}
test('history scope keeps project maintenance; body scope keeps every related activity; unrelated excluded',()=>{
 const {ctx,state}=protection();const kinds=['chat','terminal','background','queue','webchat','history','maintenance','github','resolution'];
 state.blockers=kinds.flatMap(kind=>['p','shared','q'].map(project=>({kind,project})));
 assert.equal(ctx.blockers('p').length,6);assert.ok(ctx.blockers('p').every(x=>['maintenance','github','resolution'].includes(x.kind)&&x.project!=='q'));
 assert.equal(ctx.blockers('p',{body:true}).length,18);assert.ok(ctx.blockers('p',{body:true}).every(x=>x.project!=='q'));
});
test('unknown project/activity and global control stay protected; CLI operation alone is excluded',()=>{
 const {ctx,state}=protection();state.blockers=[{kind:'cli',project:''},{kind:'webchat-control',project:''},{kind:'chat',project:'unmapped'}];
 assert.equal(ctx.blockers('p').length,2);state.ids=null;state.blockers=[{kind:'chat',project:'q'}];assert.equal(ctx.blockers('missing').length,1);
 state.ids=new Set(['p']);state.blockers=[{kind:'cli',project:''}];assert.equal(ctx.blockers('p').length,0);assert.equal(ctx.budget.busy('p','t'),'');
});
for(const global of ['restart','update','rebuild'])test('timer and immediate protection stop at '+global+' commitment',()=>{
 const {ctx,state}=protection();if(global==='rebuild'){ctx.appShell.rebuilding=true;state.blockers=[{kind:'rebuild',project:''}];}else state[global]=true;
 state.timer();assert.deepEqual(state.ticks,[]);assert.equal(ctx.blockers('p').length,1);assert.ok(ctx.budget.busy('p','t'));
});
test('timer skips only jobs with project maintenance, ignores unrelated chats and CLI updates',()=>{
 const {state}=protection();state.blockers=[{kind:'maintenance',project:'p'},{kind:'chat',project:'q'},{kind:'cli',project:''}];
 state.timer();assert.deepEqual(state.ticks,['q:u']);
 state.ticks=[];state.blockers=[{kind:'chat',project:'q'},{kind:'cli',project:''}];state.timer();assert.deepEqual(state.ticks,['p:t','q:u']);
});
test('direct startup/recovery tick obeys project blockers and runs each job once',async()=>{
 let calls=0,blocked=true,release;const held=new Promise(r=>release=r);
 const ctx=vm.createContext({stopControl:{held:()=>false},historyBlockers:()=>blocked?[{kind:'maintenance'}]:[],autoRunning:new Set(),autoStep:async()=>{calls++;await held;},autoView:()=>({}),chats:{emit(){}}});
 vm.runInContext(between('async function autoTick(','async function autoStep(')+'\nglobalThis.tick=autoTick;',ctx);
 await ctx.tick('p','t');assert.equal(calls,0);blocked=false;const first=ctx.tick('p','t');await ctx.tick('p','t');assert.equal(calls,1);release();await first;assert.equal(ctx.autoRunning.size,0);
});
test('body protects related active/pending integration and both transfer endpoints; unrelated permits',()=>{
 const {ctx,state}=protection();ctx.taskIntegrate.active={project:'q',items:[]};assert.equal(ctx.budget.busy('p','t'),'');
 ctx.taskIntegrate.active={project:'q',items:[{project:'shared'}]};assert.ok(ctx.budget.busy('p','t'));ctx.taskIntegrate.active=null;
 state.pending=[{project:'q',items:[]}];ctx.integrateAuto.active=true;assert.equal(ctx.budget.busy('p','t'),'');
 state.pending=[{project:'shared',items:[]}];assert.ok(ctx.budget.busy('p','t'));ctx.integrateAuto.active=false;state.pending=[];
 for(const r of [{project:'shared',targetProject:'q'},{project:'q',targetProject:'shared'}]){state.transfers=[r];assert.ok(ctx.budget.busy('p','t'));}
 state.transfers=[{project:'q',targetProject:'q'}];assert.equal(ctx.budget.busy('p','t'),'');
});
test('body retains short accepted writes, organizing and own task protection',()=>{
 const {ctx}=protection();ctx.taskHistory.activeWrites.add('accepted');assert.ok(ctx.budget.busy('p','t'));ctx.taskHistory.activeWrites.clear();
 ctx.freetalkHistory.activeWrites.add('accepted');assert.ok(ctx.budget.busy('p','t'));ctx.freetalkHistory.activeWrites.clear();
 ctx.taskHistory.organizing=()=>true;assert.ok(ctx.budget.busy('p','t'));ctx.taskHistory.organizing=()=>false;
 ctx.taskHistory.busy=(p,t,o)=>{assert.equal(o.history,false);return 'own target held';};assert.equal(ctx.budget.busy('p','t'),'own target held');
});
test('Hub global option is opt-in override and unknown scope stays global',()=>{
 const all=[{id:'hub',dir:'/history-fixture/hub',tasks:[]},{id:'other',dir:'/history-fixture/other',tasks:[]}],base=p=>p.dir;
 assert.equal(scope.relatedProjects('hub',all,base,x=>x,all[0].dir),null);
 assert.deepEqual([...scope.relatedProjects('hub',all,base,x=>x,all[0].dir,{hubGlobal:false})],['hub']);
 assert.equal(scope.relatedProjects('missing',all,base,x=>x,all[0].dir,{hubGlobal:false}),null);
});
function startup(lang,stage='reserved'){
 const messages=lang==='zh-TW'?require('../../langpacks/zh-TW/backend.json').messages:{};
 const state={job:{id:'selection-id',stage},held:false,both:false,operating:new Set(),events:[],queue:[],started:false};
 const lt=x=>messages[x]||x,role={name:'文章',main:{ai:'claude-code',model:'claude-opus-5-5',effort:'高'}};
 const ctx=vm.createContext({stopControl:{held:()=>false},lt,store:{readProject:()=>({dir:'/fixture'}),taskFile:()=>'/fixture/task',readTask:()=>({state:'実行中'})},rolesData:()=>({roles:[role]}),accountFor:()=> 'default',
 taskHistory:{autoJob:()=>state.job,setAuto:(p,t,v)=>{state.events.push(['save',v]);Object.assign(state.job,v);},idle:()=>{},autoCollect:()=>{state.events.push(['collect']);return {prompt:'fixture'};},autoFinish:()=>state.events.push(['finish']),selectionQueueState:()=>({started:state.started}),selectionReply:()=>({})},
 chats:{busy:()=>false,queue:()=>state.queue,setQueue:(p,t,q)=>{state.events.push(['queue',q]);state.queue=q;},sendQueued:async o=>{state.events.push(['send',o.request]);return {started:Promise.resolve(true)};},unqueue:(p,t,id)=>{state.events.push(['unqueue',id]);state.queue=state.queue.filter(x=>x.id!==id);}},
 delegateTerminalError:()=>'',limitRoutingEnabled:()=>true,limitEvidence:{forRequest:o=>state.held&&(o.ai==='claude'||state.both)},limitBackup:()=>({ai:'codex',model:'gpt-6.1-sol'}),aiTools:{isOperating:ai=>state.operating.has(ai)},
 delegateRequest:async(o,c,opts)=>{opts.beforeStart();state.events.push(['delegate',o.ai]);c.writeHead(200);},startDir:()=>({dir:'/fixture'}),permCmd:()=>'',taskPrompt:()=>'',modelPolicy:()=>'',chatEnded:()=>{}});
 vm.runInContext(between('async function autoStep(','const autoTimer=')+'\nglobalThis.step=autoStep;',ctx);return {state,ctx,lt};
}
for(const lang of ['ja','zh-TW']){
 test(lang+' reserved CLI operation waits without collect/fallback, resumes delegation once',async()=>{
  const {ctx,state,lt}=startup(lang);state.operating.add('claude');await ctx.step('p','t');assert.equal(state.job.stage,'reserved');assert.equal(state.job.reason,lt('AI の更新・モデル再取得が進行中です'));assert.deepEqual(state.events.map(e=>e[0]),['save']);
  state.operating.clear();await ctx.step('p','t');assert.equal(state.job.stage,'selecting');assert.equal(state.events.filter(e=>e[0]==='delegate').length,1);assert.equal(state.events.filter(e=>e[0]==='finish').length,0);
 });
 test(lang+' held backup CLI waits, both limits preserve reservation before collecting',async()=>{
  const {ctx,state}=startup(lang);state.held=true;state.operating.add('codex');await ctx.step('p','t');assert.equal(state.job.stage,'reserved');assert.equal(state.events.some(e=>e[0]==='collect'),false);
  state.operating.clear();state.both=true;await ctx.step('p','t');assert.equal(state.job.stage,'reserved');assert.equal(state.events.some(e=>e[0]==='collect'),false);
 });
 test(lang+' selecting queue retains bytes/ID/order during CLI operation then sends once',async()=>{
  const {ctx,state}=startup(lang,'selecting');state.queue=[{id:'original-request',ai:'codex',limitWaiting:true,limitSwitch:{sourceAI:'claude',sourceModel:'claude-opus-5-5'}}];
  const before=JSON.stringify(state.queue);state.operating.add('codex');await ctx.step('p','t');await ctx.step('p','t');assert.equal(JSON.stringify(state.queue),before);assert.deepEqual(state.events,[]);assert.equal(state.job.stage,'selecting');
  state.operating.clear();await ctx.step('p','t');assert.deepEqual(state.events.filter(e=>e[0]==='send'),[['send','original-request']]);assert.equal(state.queue.length,0);assert.equal(state.job.stage,'selecting');
 });
 test(lang+' multiple queued requests never consume/reorder or relaunch selection',async()=>{
  const {ctx,state}=startup(lang,'selecting');state.queue=[{id:'first',ai:'codex'},{id:'second',ai:'claude'}];const before=JSON.stringify(state.queue);await ctx.step('p','t');assert.equal(JSON.stringify(state.queue),before);assert.deepEqual(state.events,[]);
 });
 test(lang+' CLI operation appearing at final startup gate reserves instead of fallback/failure',async()=>{
  const first=startup(lang);first.ctx.delegateRequest=async(o,c)=>{c.writeHead(409);c.end(JSON.stringify({code:'HUB_AI_MAINTENANCE',error:first.lt('AI の更新・モデル再取得が進行中です')}));};
  await first.ctx.step('p','t');assert.equal(first.state.job.stage,'reserved');assert.equal(first.state.events.some(e=>e[0]==='finish'),false);
  const next=startup(lang,'selecting');next.state.queue=[{id:'original-request',ai:'codex',limitWaiting:true,limitSwitch:{sourceAI:'claude'}}];const before=JSON.stringify(next.state.queue);
  next.ctx.chats.sendQueued=async()=>{throw Error(next.lt('AI の更新・モデル再取得が進行中です'));};await next.ctx.step('p','t');assert.equal(next.state.job.stage,'selecting');assert.equal(next.state.job.selectionResume.state,'waiting');assert.equal(JSON.stringify(next.state.queue),before);
  next.ctx.chats.sendQueued=async o=>{next.state.events.push(['send',o.request]);return {started:Promise.resolve(true)};};await next.ctx.step('p','t');assert.deepEqual(next.state.events.filter(e=>e[0]==='send'),[['send','original-request']]);
 });
}
