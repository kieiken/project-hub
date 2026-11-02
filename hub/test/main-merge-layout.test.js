'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=require('./fixtures/app-source.cjs').readApp(),history=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(setImmediate);
function mergeButton(){
 const classes=new Set(['btn','plain']);return {hidden:true,disabled:true,classList:{toggle(c,on){on?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)}};
}
function browser(){
 const region={html:'',writes:0,details:{open:false},pre:{scrollTop:0},get innerHTML(){return this.html;},set innerHTML(v){this.html=v;this.writes++;this.details={open:false};this.pre={scrollTop:0};},querySelector(s){return s==='details'?this.details:this.pre;},remove(){assert.fail('stable region removed');}};
 const button={...mergeButton(),insertAdjacentHTML(){assert.fail('compact badge or replacement inserted');}},exclude={},calls=[],storage=new Map(),timers=[];
 let currentButton=button;
 const main={token:'first-token',target:'/fixture/main',sourceHead:'1'.repeat(40),targetHead:'2'.repeat(40),files:4,switchHub:true,switchVersion:'4.117.2',waiting:[],residual:'keep remaining'};
 const ctx=vm.createContext({UI:require('./ui-locale-fixture')('ja'),esc:x=>String(x??''),view:{kind:'work',project:'p',task:'t'},state:{taskIntegrations:[],hubInstance:'test'},integrationMainEvidence:new Map(),refreshKidsDoneBar(){},$:()=>null,document:{querySelector:s=>s==='[data-act="merge"]'?currentButton:s==='[data-act="mergeexclude"]'?exclude:s==='[data-main-preview]'?region:null,addEventListener(){},querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setInterval(){},setTimeout:f=>timers.push(f),clearTimeout(){}});
 let request=async(route)=>route.startsWith('/api/task/preview?')?{files:4}:route==='/api/task/merge/preview'?{...main}:{stage:'ready'};
 ctx.api=(route,body)=>{calls.push({route,body});return request(route,body);};
 vm.runInContext(history,ctx);vm.runInContext(app.slice(app.indexOf('let mainPreviewRequest ='),app.indexOf('// live=true：')),ctx);
 return {ctx,region,button,exclude,main,calls,timers,storage,request:f=>{request=f;},run:s=>vm.runInContext(s,ctx),load:()=>ctx.loadPreview('p','t'),prepare:()=>ctx.prepareOneclickMain('p','t',currentButton),replace:()=>{currentButton=mergeButton();return currentButton;}};
}
test('both renderers: three delayed cycles retain region, details and content until the formal read finishes',async()=>{
 const b=browser();await b.load();const writes=b.region.writes;b.region.details.open=true;b.region.pre.scrollTop=80;
 for(let i=0;i<3;i++){
  const wait=deferred();b.request(async r=>r.startsWith('/api/task/preview?')?{files:4}:r==='/api/task/merge/status'?wait.promise:{...b.main,token:'refresh-'+i});
  const p=b.load();await turn();assert.equal(b.region.writes,writes);assert.match(b.region.html,/対象：/);assert.equal(b.button.hidden,false);assert.equal(b.button.disabled,true);await b.ctx.runOneclickMain('p','t');assert.equal(b.calls.filter(x=>x.route==='/api/task/merge').length,0);
  wait.resolve({stage:'ready'});await p;assert.equal(b.region.writes,writes);assert.equal(b.region.details.open,true);assert.equal(b.region.pre.scrollTop,80);assert.equal(b.button.disabled,false);
 }
});
for(const failure of [false,true])test('new formal read wins against an older '+(failure?'failure':'success'),async()=>{
 const b=browser();await b.load();const old=deferred();let reads=0;
 b.request(async r=>r==='/api/task/merge/status'&&++reads===1?old.promise:r==='/api/task/merge/status'?{stage:'ready'}:{...b.main,token:'new-token',sourceHead:'3'.repeat(40),files:8});
 const first=b.prepare();await turn();await b.prepare();const html=b.region.html;failure?old.reject(Error('old failure')):old.resolve({stage:'ready'});await first;
 assert.equal(b.region.html,html);assert.equal(b.run('oneclickPlans.get(oneclickKey("p","t")).main.token'),'new-token');assert.equal(b.button.disabled,false);
});
for(const stage of ['status','preview','unknown-status'])for(const move of ['navigate','replace'])test('late '+stage+' after '+move+' cannot update current DOM or approve',async()=>{
 const b=browser(),wait=deferred();let count=0;
 if(stage==='unknown-status')b.run('mainDelivery("p","t",{state:"uncertain",requestId:"old"})');
 b.request(async(r,body)=>{
  if(stage==='unknown-status'&&r==='/api/task/merge/status'){if(!body.flow)return {state:'unknown'};return wait.promise;}
  if(r==='/api/task/merge/status')return stage==='status'?wait.promise:{stage:'ready'};
  if(r==='/api/task/merge/preview'){count++;return stage==='preview'?wait.promise:{...b.main};}
 });
 const p=b.prepare();await turn();const html=b.region.html;const current=move==='replace'?b.replace():(b.ctx.view.task='other',b.button);
 wait.resolve(stage==='preview'?{...b.main}:{stage:'ready'});await p;assert.equal(b.region.html,html);assert.equal(current.disabled,true);
 if(stage==='unknown-status')assert.equal(count,0);
});
test('formal read failure keeps scope, disables approval, preserves open details and recovers on next read',async()=>{
 const b=browser();await b.load();b.region.details.open=true;b.request(async()=>{throw Error('offline');});await b.prepare();assert.match(b.region.html,/対象：/);assert.match(b.region.html,/offline/);assert.equal(b.region.details.open,true);assert.equal(b.button.disabled,true);
 b.request(async r=>r==='/api/task/merge/status'?{stage:'ready'}:{...b.main,token:'recovered'});await b.prepare();assert.equal(b.button.disabled,false);assert.equal(b.region.details.open,true);
});
test('periodic read during a pending approved POST preserves plan identity and never sends twice',async()=>{
 const b=browser();await b.load();const post=deferred();b.request(async r=>r==='/api/task/merge'?post.promise:r.startsWith('/api/task/preview?')?{files:4}:assert.fail('must not replace sending flow'));
 const p=b.ctx.runOneclickMain('p','t');assert.equal(b.button.textContent,'取り込み中');assert.equal(b.button.classList.contains('main-merge-busy'),true);assert.equal(b.button.disabled,true);await turn();const plan=b.run('oneclickPlans.get(oneclickKey("p","t"))');await b.load();assert.equal(b.run('oneclickPlans.get(oneclickKey("p","t"))'),plan);await b.ctx.runOneclickMain('p','t');assert.equal(b.calls.filter(x=>x.route==='/api/task/merge').length,1);post.resolve({flow:{stage:'approved',requestId:'first-token'}});await p;assert.match(b.region.html,/取り込みは送り直しません/);
});
test('late lightweight failure after DOM replacement does not clear integration evidence',async()=>{
 const b=browser(),wait=deferred();b.ctx.integrationMainEvidence.set('p\0t','keep');b.request(()=>wait.promise);const p=b.load();b.replace();wait.reject(Error('offline'));await p;assert.equal(b.ctx.integrationMainEvidence.get('p\0t'),'keep');
});

for(const switchHub of [false,true])test('included and boot-confirmed scope is completed without another merge: Hub='+switchHub,async()=>{
 const b=browser();Object.assign(b.main,{alreadyIncluded:true,switchHub,switchNeeded:false});await b.prepare();assert.equal(b.button.textContent,'本体へ反映済み');assert.equal(b.button.disabled,true);assert.match(b.region.html,/必要な起動確認は完了/);await b.ctx.runOneclickMain('p','t');assert.equal(b.calls.filter(x=>x.route==='/api/task/merge').length,0);
 // Fresh saved changes restore the action; completion is never inferred from the copy's existence.
 Object.assign(b.main,{sourceHead:'3'.repeat(40),alreadyIncluded:false,switchNeeded:true});await b.prepare();assert.equal(b.button.textContent,'本体に取り込む');assert.equal(b.button.disabled,false);
});
for(const change of [{switchNeeded:true},{alreadyIncluded:false},{sourceHead:'3'.repeat(40),alreadyIncluded:false}])test('historical completion does not hide a new or unbooted scope: '+JSON.stringify(change),async()=>{
 const b=browser();Object.assign(b.main,{alreadyIncluded:true,switchNeeded:false},change);b.request(async r=>r==='/api/task/merge/status'?{stage:'complete',sourceHead:'1'.repeat(40)}:{...b.main});await b.prepare();assert.equal(b.button.textContent,'本体に取り込む');assert.equal(b.button.disabled,false);
});
for(const stage of ['approved','unknown','waiting','switching','blocked','stopped'])test('unconfirmed or switching flow never becomes completed: '+stage,async()=>{
 const b=browser();Object.assign(b.main,{alreadyIncluded:true,switchNeeded:false});b.request(async()=>({stage,sourceHead:b.main.sourceHead,requestId:'pending'}));await b.prepare();assert.equal(b.button.textContent,stage==='unknown'?'結果確認中':stage==='blocked'?'取り込み要確認':stage==='stopped'?'取り込み停止':'取り込み中');assert.equal(b.button.classList.contains('main-merge-busy'),['approved','unknown','waiting','switching'].includes(stage));assert.equal(b.button.disabled,true);await b.ctx.runOneclickMain('p','t');assert.equal(b.calls.filter(x=>x.route==='/api/task/merge').length,0);
});

test('busy appearance follows polling, replacement and terminal transitions without marking preview or preflight waiting busy',async()=>{
 const b=browser(),draw=plan=>b.ctx.drawOneclickMain('p','t',plan);
 for(const plan of [{loading:true},{main:{...b.main,waiting:[{message:'AIの終了待ち'}]}},{main:{...b.main}}]){draw(plan);assert.equal(b.button.textContent,'本体に取り込む');assert.equal(b.button.classList.contains('main-merge-busy'),false);}
 let flow={stage:'approved',requestId:'pending'};b.request(async()=>flow);await b.prepare();
 for(const stage of ['waiting','switching','unknown','blocked','stopped','complete','ready']){
  flow={stage,requestId:'pending',sourceHead:b.main.sourceHead};
  if(b.timers.length)await b.timers.shift()();
  const current=b.ctx.document.querySelector('[data-act="merge"]');draw({main:{...b.main},flow});assert.equal(current.classList.contains('main-merge-busy'),['waiting','switching','unknown'].includes(stage));
  const button=b.replace();draw({main:{...b.main},flow});
  assert.equal(button.textContent,{waiting:'取り込み中',switching:'取り込み中',unknown:'結果確認中',blocked:'取り込み要確認',stopped:'取り込み停止',complete:'本体へ反映済み',ready:'本体に取り込む'}[stage]);
  assert.equal(button.classList.contains('main-merge-busy'),['waiting','switching','unknown'].includes(stage));assert.equal(button.disabled,stage!=='ready');
 }
 draw({main:{...b.main},error:'offline'});assert.equal(b.ctx.document.querySelector('[data-act="merge"]').textContent,'取り込み停止');
 const css=fs.readFileSync(path.join(__dirname,'../public/app.css'),'utf8');assert.match(css,/\.btn\.plain\.main-merge-busy:disabled\{[^}]*background:#b42318;[^}]*color:#fff;[^}]*opacity:1/);
});
