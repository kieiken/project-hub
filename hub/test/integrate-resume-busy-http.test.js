'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-resume-busy-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{const out=o=>console.log(JSON.stringify(o));out({type:'thread.started',thread_id:'resume-fixture'});out({type:'item.completed',item:{type:'agent_message',text:'fixture completion'}});out({type:'turn.completed'});});
`,{mode:0o755});process.env.PATH=bin+':/usr/bin:/bin';
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(55000+Math.floor(Math.random()*900))});
const {ChatRunner}=require('../lib/chat');let runner;const originalQueue=ChatRunner.prototype.queue;ChatRunner.prototype.queue=function(...a){runner=this;return originalQueue.apply(this,a);};
const {Store}=require('../lib/store'),git=require('../lib/git'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto');
const store=new Store(root),p=store.createProject({name:'親プロジェクト'}).project,parent=store.createTask(p.id,{title:'本作業'});
const other=store.createProject({name:'別プロジェクト'}).project,task=store.createTask(other.id,{title:'別作業'}),queue=path.join(other.dir,'.ai/chat',task.id+'.queue.json');fs.mkdirSync(path.dirname(queue),{recursive:true});
const body=path.join(root,'Body'),g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();fs.mkdirSync(body);g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');g(body,'add','.');g(body,'commit','-qm','base');
const removal=new Removal({store}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),integrate=new TaskIntegrate({store,removal,transfer,baseOf:()=>body});
const w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:parent.id});store.updateTask(p.id,parent.id,{workdir:w.dir,continuation:true});
function stopped(){
 const child=store.createTask(p.id,{title:'子',parent:parent.id,steps:['完成']});store.setStep(p.id,child.id,0,true);store.appendSection(p.id,child.id,'成果','- なし：保存コードのみ');
 const cw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:child.id});store.updateTask(p.id,child.id,{workdir:cw.dir});fs.writeFileSync(path.join(cw.dir,'base'),'child');git.save(cw.dir,'child');fs.writeFileSync(path.join(w.dir,'base'),'parent');git.save(w.dir,'parent');
 const d=integrate.preview(p.id,parent.id,[{project:p.id,task:child.id}]);integrate.apply({project:p.id,task:parent.id,token:d.token,auto:true,thenMain:true,confirm:true,selected:[{project:p.id,task:child.id,disposition:'continue'}]});new IntegrateAuto({integrate}).stop(p.id,parent.id,'Fixture停止');
 return integrate.read(p.id,parent.id);
}
const old=stopped(),raw=()=>fs.readFileSync(integrate.file(p.id,parent.id),'utf8'),original=raw(),main=g(body,'rev-parse','HEAD');
const first=store.createTask(p.id,{title:'初回統合'}),firstCopy=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:first.id});store.updateTask(p.id,first.id,{workdir:firstCopy.dir});
const firstChild=store.createTask(p.id,{title:'初回の子',parent:first.id,steps:['完成']});store.setStep(p.id,firstChild.id,0,true);store.appendSection(p.id,firstChild.id,'成果','- なし：コード変更なし');
// Resume schedules an asynchronous worker. Finish it before deleting its fixture.
const ticks=new Set(),originalTick=IntegrateAuto.prototype.tick;
IntegrateAuto.prototype.tick=function(...args){const pending=originalTick.apply(this,args);ticks.add(pending);pending.then(()=>ticks.delete(pending),()=>ticks.delete(pending));return pending;};
const appShellModule=require('../lib/app-shell'),OriginalShell=appShellModule.AppShell;let shell;appShellModule.AppShell=class extends OriginalShell{constructor(...a){super(...a);shell=this;}};
const {AppUpdate}=require('../lib/app-update');let holdUpdate=false;const actualApplying=AppUpdate.prototype.applying;AppUpdate.prototype.applying=function(){return holdUpdate||actualApplying.call(this);};
let runtime=require('../server'),server=runtime.server,base;
async function start(){await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));await require('../server').restoreReady;base='http://127.0.0.1:'+server.address().port;}
async function close(){server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>setImmediate(r));await Promise.all([...ticks]);await Promise.all([...runner.running.values()].map(r=>r.finishedP));await new Promise(r=>setImmediate(r));await Promise.all([...ticks]);}
// A restart closes all server sockets. Do not let a pooled client reuse them.
const get=route=>fetch(base+route,{headers:{'X-Hub':'1',Connection:'close'}}),post=(route,b={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1',Connection:'close','Content-Type':'application/json'},body:JSON.stringify({project:p.id,task:parent.id,...b})});
function queued(on){runner.setQueue(p.id,firstChild.id,on?[{id:'held',ai:'codex',model:'gpt-6.1-sol',text:'fixture',error:'隔離待ち指示'}]:[],true);}
test.before(start);test.after(async()=>{
 // resume schedules a dry-run dispatch after the HTTP response. Socket closure
 // alone does not await its finish/onSettled writes into the fixture directory.
 await new Promise(setImmediate);
 new IntegrateAuto({integrate}).stop(p.id,parent.id,'Fixture終了');
 const pending=[...runner.running.values()];runner.stopAll();
 await Promise.all(pending.map(run=>run.finishedP));
 await new Promise(setImmediate);
 assert.equal(runner.running.size,0);
 await close();IntegrateAuto.prototype.tick=originalTick;fs.rmSync(tmp,{recursive:true,force:true});
});
test('正式HTTP：初回開始と別名入口も直前の稼働を待機で拒否し、未受領・未保存のまま新確認へ戻る',async()=>{
 const data={task:first.id,only:[{project:p.id,task:firstChild.id}]},head=g(firstCopy.dir,'rev-parse','HEAD');
 for(const kind of ['chat','terminal','queue','rebuild','update']){
  const ready=await (await post('/api/task/integrate/preview',data)).json();assert.ok(ready.token);const list=runtime.sessions.list;
  if(kind==='chat')runner.running.set(p.id+'\0'+firstChild.id,{ai:'codex'});
  else if(kind==='terminal')runtime.sessions.list=()=>[{project:p.id,task:firstChild.id,ai:'codex',running:true}];
  else if(kind==='queue')queued(true);else if(kind==='rebuild')shell.rebuilding=true;else holdUpdate=true;
  try{
   const waiting=(await (await get('/api/task/integrate/wait?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(first.id))).json()).waiting;assert.ok(waiting.some(x=>x.kind===kind));
   for(const route of ['/api/task/integrate','/api/task/absorb']){
    const response=await post(route,{...data,token:ready.token,confirm:true,auto:true,thenMain:false,selected:[{project:p.id,task:firstChild.id,disposition:'continue'}]}),out=await response.json();assert.equal(response.status,409);assert.equal(out.code,'INTEGRATION_BUSY');assert.equal(out.stage,'waiting');assert.deepEqual(out.waiting,waiting);assert.match(out.error,/統合の開始は待機中です/);
   }
   assert.equal(integrate.read(p.id,first.id),null);assert.equal(transfer.read(p.id,firstChild.id),null);assert.equal(g(firstCopy.dir,'rev-parse','HEAD'),head);assert.equal(g(body,'rev-parse','HEAD'),main);assert.equal(raw(),original);
  }finally{runner.running.delete(p.id+'\0'+firstChild.id);runtime.sessions.list=list;queued(false);shell.rebuilding=false;holdUpdate=false;}
  const stale=await post('/api/task/integrate',{...data,token:ready.token,confirm:true,selected:[]});assert.equal(stale.status,409);assert.equal((await stale.json()).stage,'refresh');
  const fresh=await (await post('/api/task/integrate/preview',data)).json();assert.ok(fresh.token);assert.notEqual(fresh.token,ready.token);assert.deepEqual(fresh.waiting,[]);
 }
});
test('正式HTTP：同一プロジェクトの順番待ちをpreview/resumeで同じ理由にし、解除後の新previewだけ再開可能',async()=>{
 const idle=await (await post('/api/task/integrate/preview')).json();assert.ok(idle.token);
 // Activity in a related project is protected; no CLI is started.
 for(const kind of ['chat','terminal','rebuild','update']){
  const list=runtime.sessions.list;
  if(kind==='chat')runner.running.set(p.id+'\0'+firstChild.id,{ai:'codex'});
  else if(kind==='terminal')runtime.sessions.list=()=>[{project:p.id,task:firstChild.id,ai:'codex',running:true}];
  else if(kind==='rebuild')shell.rebuilding=true;else holdUpdate=true;
  try{const preview=await post('/api/task/integrate/preview'),d=await preview.json();assert.equal(preview.status,200,JSON.stringify({kind,preview:d}));assert.ok(d.waiting.some(x=>x.kind===kind&&(['rebuild','update'].includes(kind)||x.project===p.id&&x.task===firstChild.id)));assert.equal(d.token,undefined);const res=await post('/api/task/integrate/resume',{token:idle.token});assert.equal(res.status,409);const denied=await res.json();assert.equal(denied.stage,'waiting');assert.equal(denied.code,'INTEGRATION_BUSY');assert.deepEqual(denied.waiting,d.waiting);assert.equal(raw(),original);assert.deepEqual((await (await get('/api/task/integrate/wait?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(parent.id))).json()).waiting,d.waiting);if(['rebuild','update'].includes(kind))assert.equal((await post('/api/task/step',{index:0,done:true})).status,409);}
  finally{runner.running.delete(p.id+'\0'+firstChild.id);runtime.sessions.list=list;shell.rebuilding=false;holdUpdate=false;}
 }
 queued(true);
 const denied=await post('/api/task/integrate/resume',{token:idle.token}),e=await denied.json();assert.equal(denied.status,409);assert.equal(e.stage,'waiting');assert.equal(e.code,'INTEGRATION_BUSY');assert.ok(e.waiting.some(x=>x.project===p.id&&x.task===firstChild.id&&x.kind==='queue'));assert.match(e.error,/親プロジェクト.*初回の子/);
 for(let n=0;n<2;n++){const res=await post('/api/task/integrate/preview'),d=await res.json();assert.equal(res.status,200);assert.deepEqual(d.waiting,e.waiting);assert.equal(d.token,undefined);assert.ok(d.auto.stopped);assert.equal(raw(),original);}
 assert.deepEqual((await (await get('/api/task/integrate/wait?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(parent.id))).json()).waiting,e.waiting);
 queued(false);assert.deepEqual((await (await get('/api/task/integrate/wait?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(parent.id))).json()).waiting,[]);
 // A busy rejection revokes the old token; it cannot be sent after activity ends.
 const stale=await post('/api/task/integrate/resume',{token:idle.token});assert.equal(stale.status,409);assert.equal((await stale.json()).stage,'refresh');assert.equal(raw(),original);
 const fresh=await (await post('/api/task/integrate/preview')).json();assert.ok(fresh.token);assert.deepEqual(fresh.waiting,[]);
 // A server restart cannot revive old in-memory tokens or change the saved stop.
 await close();require.cache[require.resolve('../server')]?.exports.stopControl.cleanExit();delete require.cache[require.resolve('../server')];runtime=require('../server');server=runtime.server;await start();
 const restarted=await post('/api/task/integrate/resume',{token:fresh.token});assert.equal(restarted.status,409);assert.equal((await restarted.json()).stage,'refresh');assert.equal(raw(),original);
 const beforeMove=await (await post('/api/task/integrate/preview')).json();fs.writeFileSync(path.join(w.dir,'move'),'move');git.save(w.dir,'HEAD moved');assert.equal((await post('/api/task/integrate/resume',{token:beforeMove.token})).status,409);assert.equal(raw(),original);
 const ready=await (await post('/api/task/integrate/preview')).json(),out=await post('/api/task/integrate/resume',{token:ready.token}),result=await out.json();assert.equal(out.status,200,JSON.stringify(result));assert.equal(result.thenMain,false);assert.equal(result.resumed,true);
 const r=integrate.read(p.id,parent.id);assert.equal(r.auto.thenMain,false);assert.equal(r.auto.resumed.length,1);assert.deepEqual(r.auto.stopHistory,[old.auto.stopped]);assert.equal(g(body,'rev-parse','HEAD'),main);
 const repeat=await post('/api/task/integrate/resume',{token:ready.token});assert.equal(repeat.status,409);assert.equal(integrate.read(p.id,parent.id).auto.resumed.length,1);
});
