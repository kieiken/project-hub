'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-future-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(58100+Math.floor(Math.random()*800))});
// Keep periodic integration inert; only the real loopback HTTP dispatcher runs.
const {IntegrateAuto}=require('../lib/integrate-auto'),tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{};
const {Store}=require('../lib/store'),hold=require('../lib/task-future-hold'),store=new Store(root);
const p=store.createProject({name:'Fixture'}).project,parent=store.createTask(p.id,{title:'親'}),child=store.createTask(p.id,{title:'将来案',parent:parent.id});
const runtime=require('../server'),server=runtime.server;let base;
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));await require('../server').restoreReady;base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{runtime.chats.running.clear();server.closeAllConnections();await new Promise(r=>server.close(r));IntegrateAuto.prototype.tick=tick;fs.rmSync(tmp,{recursive:true,force:true});});
const args=(held,task=child.id)=>{const t=store.readTask(store.taskFile(p.id,task));return {project:p.id,task,held,before:Boolean(t.futureHold),revision:t.futureHoldRevision||null,expectedHash:t.completionHash,confirm:true};};
async function post(body,authorized=true){const r=await fetch(base+'/api/task/future-hold',{method:'POST',headers:{...(authorized?{'X-Hub':'1'}:{}),'Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)});return {status:r.status,out:await r.json()};}
test('将来保留の正式HTTPは保留・解除を永続化し、認可・CAS・稼働拒否と原文保持を守る',async t=>{
 const files=[parent.id,child.id].map(id=>store.taskFile(p.id,id)),before=files.map(f=>fs.readFileSync(f)),metadata=hold.file(root,p.id,child.id),request=args(true);
 const saved=await post(request);assert.equal(saved.status,200,JSON.stringify(saved.out));assert.equal(saved.out.held,true);assert.equal(new Store(root).readTask(files[1]).futureHold,true);
 const heldBytes=fs.readFileSync(metadata);
 await t.test('古い状態の再送は409で履歴を増やさない',async()=>{assert.equal((await post(request)).status,409);assert.deepEqual(fs.readFileSync(metadata),heldBytes);});
 await t.test('X-Hubなしは拒否して変更しない',async()=>{assert.equal((await post(args(false),false)).status,403);assert.deepEqual(fs.readFileSync(metadata),heldBytes);});
 await t.test('親のAI稼働中は変更前に拒否する',async()=>{
  const key=p.id+'\0'+parent.id;runtime.chats.running.set(key,{ai:'codex'});
  try{assert.equal((await post(args(false))).status,409);assert.deepEqual(fs.readFileSync(metadata),heldBytes);}finally{runtime.chats.running.delete(key);}
 });
 await t.test('親のない作業は拒否する',async()=>{assert.equal((await post(args(true,parent.id))).status,409);assert.equal(fs.existsSync(hold.file(root,p.id,parent.id)),false);});
 const released=await post(args(false));assert.equal(released.status,200,JSON.stringify(released.out));assert.equal(released.out.held,false);
 assert.equal(new Store(root).readTask(files[1]).futureHold,false);assert.deepEqual(JSON.parse(fs.readFileSync(metadata)).history.map(x=>x.held),[true,false]);
 files.forEach((f,i)=>assert.deepEqual(fs.readFileSync(f),before[i]));assert.equal(runtime.chats.running.size,0);assert.equal(runtime.taskIntegrate.read(p.id,parent.id),null);
});
