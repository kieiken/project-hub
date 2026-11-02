'use strict';
// Reuse the isolated HTTP harness, never the user's Hub, CLI, or site records.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const file=require.resolve('./integration-abandon-http.test'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
let source=fs.readFileSync(file,'utf8').split("test('正式HTTP 人の停止")[0];
// The fake CLI exits successfully while producing the same invalid label.
source=source.replace("fs.appendFileSync(c.taskFile,", "if(c.invalid){fs.appendFileSync(c.taskFile,'\\\\n## 成果\\\\n- 作業用コピー保存済み：body:.@'+c.saved+'\\\\n## 残件申告\\\\n'+String.fromCharCode(96).repeat(3)+'json\\\\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:c.evidence})+'\\\\n'+String.fromCharCode(96).repeat(3)+'\\\\n');}else if(c.repair){fs.writeFileSync(c.taskFile,fs.readFileSync(c.taskFile,'utf8').replace('作業用コピー保存済み：','本体保存済み：'));}else fs.appendFileSync(c.taskFile,");
source+='\nmodule.exports={getRuntime:()=>runtime,tick,post,wait,delay,launches,g,hash,cold,control,originalFiles};';m._compile(source,file);const h=m.exports;
const runtime=()=>h.getRuntime();
async function fixture(){
 for(const e of runtime().taskIntegrate.pending()){const r=runtime().taskIntegrate.read(e.project,e.task,e.id);if(r?.auto&&!r.auto.stopped)runtime().integrateAuto.stop(e.project,e.task,"fixture finished",e.id);}
 await h.wait(()=>runtime().chats.running.size===0);
 const {store}=runtime().taskIntegrate,p=store.createProject({name:'Format-'+Math.random().toString(36).slice(2)}).project,parent=store.createTask(p.id,{title:'本作業',steps:['未済']}),child=store.createTask(p.id,{title:'打合せ事前準備',parent:parent.id,steps:['実機未確認'],workspaceMode:'direct'}),other=store.createTask(p.id,{title:'新地域',parent:parent.id,steps:['未着手'],workspaceMode:'direct'});
 fs.writeFileSync(path.join(p.dir,'saved.txt'),'saved behavior');fs.writeFileSync(path.join(p.dir,'.ai/rules.md'),'日本語。実機未確認は未済で保持。');
 const evidence='.ai/work/'+child.id+'-core.log';fs.writeFileSync(path.join(p.dir,evidence),'saved behavior test\n# pass 1\n# fail 0\n');
 h.g(p.dir,'init','-q');h.g(p.dir,'config','user.name','Fixture');h.g(p.dir,'config','user.email','fixture@localhost');h.g(p.dir,'add','.');h.g(p.dir,'commit','-qm','saved behavior');
 const saved=h.g(p.dir,'rev-parse','HEAD'),taskFile=store.taskFile(p.id,child.id),common={project:p.id,task:parent.id},r=()=>runtime().taskIntegrate.read(p.id,parent.id);
 fs.writeFileSync(h.control,JSON.stringify({invalid:true,taskFile,saved,dir:p.dir,evidence}));
 const d=await h.post('/api/task/integrate/preview',{...common,simple:true});assert.equal(d.status,200,JSON.stringify(d.out));
 assert.equal((await h.post('/api/task/integrate',{...common,token:d.out.token,auto:true,confirm:true,thenMain:false,mode:'batch',selected:[child,other].map(c=>({project:p.id,task:c.id,keep:false}))})).status,200);
 await h.tick.call(runtime().integrateAuto);await h.wait(()=>r().auto.stopped&&!runtime().chats.busy(p.id,child.id));
 const k=Object.keys(r().auto.attempts)[0];assert.equal(r().auto.attempts[k].task,child.id);assert.equal(r().auto.stopped.code,'ORGANIZE_DECLARATION_INVALID',JSON.stringify(r().auto.stopped));
 const end=require('../lib/chat').read(p.dir,child.id).findLast(x=>x.integrationAuto?.key===k&&x.role==='assistant');assert.equal(end.integrationAuto.closed,true);assert.equal(end.error,'');
 return {store,p,parent,child,other,children:[child,other],common,r,k,end,taskFile,saved,evidence};
}
const preview=f=>h.post('/api/task/integrate/preview',{...f.common,simple:true});
test('正常終了後の形式停止→中止→cold→打合せだけkeep=true開始、新地域・原文・承認・停止履歴保全',async()=>{
 const f=await fixture(),legacy=f.r();legacy.auto.stopped={reason:'子の整理後の保存・成果・残件申告を確認できません',at:legacy.auto.stopped.at};runtime().taskIntegrate.save(legacy);const prior=f.r(),d=await preview(f);assert.equal(d.out.abandon.allowed,true,JSON.stringify(d.out));assert.equal(d.out.abandon.stopKind,'validation');assert.equal(d.out.resumeAllowed,true);assert.match(d.out.resumeMessage,/一度だけ/);assert.match(d.out.resumeMessage,/成果・残件の検査/);
 const originals=h.originalFiles(f),other=fs.readFileSync(f.store.taskFile(f.p.id,f.other.id),'utf8'),count=h.launches().length;
 const ap=await h.post('/api/task/integrate/abandon',{...f.common,preview:true});assert.equal(ap.status,200,JSON.stringify(ap.out));
 const body={...f.common,id:ap.out.id,token:ap.out.token,confirm:true};assert.equal((await h.post('/api/task/integrate/abandon',body)).status,200);assert.equal((await h.post('/api/task/integrate/abandon',body)).status,409);
 assert.deepEqual(f.r().abandoned.original,prior);assert.deepEqual(h.originalFiles(f),originals);assert.equal(h.launches().length,count);assert.equal(require('../lib/task-continuation').childrenComplete(f.r()),false);await h.cold();
 const next=await preview(f);assert.equal(next.out.resume,undefined);assert.ok(next.out.items.some(i=>i.task===f.child.id&&i.startable));
 assert.equal((await h.post('/api/task/integrate',{...f.common,token:next.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]})).status,200);
 assert.notEqual(f.r().id,prior.id);assert.deepEqual(f.r().items.map(i=>[i.task,i.keep]),[[f.child.id,true]]);assert.equal(fs.readFileSync(f.store.taskFile(f.p.id,f.other.id),'utf8'),other);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.other.id),null);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id),null);assert.equal(h.launches().length,count);
 fs.writeFileSync(h.control,JSON.stringify({repair:true,taskFile:f.taskFile,saved:f.saved,dir:f.p.dir,evidence:f.evidence}));
 for(let n=0;n<500&&!f.r().complete&&!f.r().auto.stopped;n++){await h.tick.call(runtime().integrateAuto);await h.delay(20);}
 assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));assert.equal(f.r().complete,true);assert.equal(f.r().items[0].state,'保持受領済み');
 assert.ok(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id).received.some(x=>x.integration===f.r().id));assert.ok(f.store.taskFile(f.p.id,f.child.id));assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.other.id),null);assert.equal(fs.readFileSync(f.store.taskFile(f.p.id,f.other.id),'utf8'),other);
});
test('明示再開→新キーの整理一回→旧終了と停止履歴保持、旧依頼の遅延終了は無視',async()=>{
 const f=await fixture(),prior=f.r(),d=await preview(f),a=prior.auto.attempts[f.k],before=h.launches().length;
 fs.writeFileSync(h.control,JSON.stringify({repair:true,taskFile:f.taskFile,saved:f.saved,dir:f.p.dir,evidence:f.evidence}));
 const b={...f.common,token:d.out.token};const resumed=await h.post('/api/task/integrate/resume',b);assert.equal(resumed.status,200,JSON.stringify(resumed.out));assert.equal((await h.post('/api/task/integrate/resume',b)).status,409);
 const authorized=f.r(),repair=Object.entries(authorized.auto.attempts).find(([,a])=>a.organizeRepair),[k]=repair;assert.notEqual(k,f.k);assert.equal(authorized.auto.attempts[f.k].phase,'superseded');assert.deepEqual(authorized.auto.attempts[f.k].request,a.request);assert.deepEqual(authorized.auto.attempts[f.k].delivery,a.delivery);assert.deepEqual(authorized.auto.stopHistory,[prior.auto.stopped]);assert.equal(h.launches().length,before);
 await h.cold();await h.tick.call(runtime().integrateAuto);await h.wait(()=>f.r().auto.stopped||f.r().auto.attempts[k].phase==='verified');assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));assert.equal(h.launches().filter(x=>x.key===k).length,1);assert.equal(h.launches().filter(x=>x.key===f.k).length,1);
 const record=f.r();runtime().integrateAuto.settled(a.request,f.end);assert.deepEqual(f.r(),record);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id),null);
});
test('修復整理も不正なら二回目の再整理を許可せず、中止は可能',async()=>{
 const f=await fixture(),d=await preview(f),before=h.launches().length;
 assert.equal((await h.post('/api/task/integrate/resume',{...f.common,token:d.out.token})).status,200);await h.tick.call(runtime().integrateAuto);await h.wait(()=>f.r().auto.stopped&&!runtime().chats.busy(f.p.id,f.child.id));
 // The deliberately broken second organizer creates duplicate result sections.
 const latest=await preview(f);assert.equal(latest.out.resumeAllowed,false);assert.equal(latest.out.abandon.allowed,true,JSON.stringify({abandon:latest.out.abandon,stop:f.r().auto.stopped,attempts:f.r().auto.attempts}));assert.equal(h.launches().length,before+1);
});
for(const change of ['request','saved-head','closed','pending','receipt','migration','main','keep','declaration-after-preview'])test('証拠/対象変更は中止・再整理を受理しない：'+change,async()=>{
 const f=await fixture(),d=await preview(f),ap=await h.post('/api/task/integrate/abandon',{...f.common,preview:true}),count=h.launches().length,record=f.r(),chat=require('../lib/chat'),log=chat.files(f.p.dir,f.child.id).log;
 if(['request','saved-head','closed'].includes(change)){
  const rows=chat.read(f.p.dir,f.child.id),row=rows.findLast(x=>x.role==='assistant'&&x.integrationAuto?.key===f.k);if(change==='request')row.request='other';if(change==='saved-head')row.integrationAuto.saved.head='0'.repeat(40);if(change==='closed')row.integrationAuto.closed=false;fs.writeFileSync(log,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 }else if(change==='pending'){const a=record.auto.attempts[f.k];runtime().chats.queue(f.p.id,f.child.id).push({request:a.delivery.request,text:a.request.text});}
 else if(change==='receipt'){record.items[0].receipt='unexpected';runtime().taskIntegrate.save(record);}
 else if(change==='migration'){record.auto.migrations.extra={};runtime().taskIntegrate.save(record);}
 else if(change==='main'){record.auto.main={state:'intent'};runtime().taskIntegrate.save(record);}
 else if(change==='keep')f.store.updateTask(f.p.id,f.child.id,{integrateKeep:true});
 else f.store.appendSection(f.p.id,f.child.id,'メモ','確認後の追加');
 const out=await h.post('/api/task/integrate/resume',{...f.common,token:d.out.token});assert.equal(out.status,409,JSON.stringify(out.out));assert.equal(h.launches().length,count);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id),null);
 const abandoned=await h.post('/api/task/integrate/abandon',{...f.common,id:ap.out.id,token:ap.out.token,confirm:true});assert.equal(abandoned.status,409,JSON.stringify(abandoned.out));assert.equal(f.r().abandoned,undefined);
 if(change==='pending')runtime().chats.queue(f.p.id,f.child.id).length=0;
});

test('再開受付後・配送直前に成果が変わった時は整理を送らない',async()=>{
 const f=await fixture(),d=await preview(f),count=h.launches().length;assert.equal((await h.post('/api/task/integrate/resume',{...f.common,token:d.out.token})).status,200);
 f.store.appendSection(f.p.id,f.child.id,'メモ','再開受付後の追加');await h.tick.call(runtime().integrateAuto);assert.ok(f.r().auto.stopped);assert.equal(h.launches().length,count);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id),null);
});

test('一度の修復整理を人が止めた場合も、履歴を残して中止できる',async()=>{
 const f=await fixture(),d=await preview(f);assert.equal((await h.post('/api/task/integrate/resume',{...f.common,token:d.out.token})).status,200);
 const k=Object.keys(f.r().auto.attempts).find(k=>k!==f.k);fs.rmSync(h.control);await h.tick.call(runtime().integrateAuto);await h.wait(()=>h.launches().some(x=>x.key===k));
 assert.equal((await h.post('/api/chat/stop',{project:f.p.id,task:f.child.id})).out.ok,true);await h.wait(()=>!runtime().chats.busy(f.p.id,f.child.id)&&f.r().auto.stopped);
 const prior=f.r(),ap=await h.post('/api/task/integrate/abandon',{...f.common,preview:true});assert.equal(ap.status,200,JSON.stringify(ap.out));
 const count=h.launches().length,originals=h.originalFiles(f);assert.equal((await h.post('/api/task/integrate/abandon',{...f.common,id:ap.out.id,token:ap.out.token,confirm:true})).status,200);
 assert.deepEqual(f.r().abandoned.original,prior);assert.deepEqual(h.originalFiles(f),originals);assert.equal(h.launches().length,count);assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,f.child.id),null);
 assert.equal((await h.post('/api/ai/resume',{confirm:true})).status,200);
});

async function advancedStopped(){
 const f=await fixture(),d=await preview(f);
 assert.equal((await h.post('/api/task/integrate/resume',{...f.common,token:d.out.token})).status,200);
 await h.tick.call(runtime().integrateAuto);await h.wait(()=>f.r().auto.stopped&&!runtime().chats.busy(f.p.id,f.child.id));
 // The stopped organizer never reached run(), so neither child was reserved.
 for(const c of f.children)assert.equal(runtime().taskIntegrate.transfer.read(f.p.id,c.id),null);
 // A separate, authorized child-side cleanup fixes the duplicate declarations.
 // It must not make the old, unreceived integration impossible to abandon.
 const text=fs.readFileSync(f.taskFile,'utf8').split(/^## 成果\s*$/m)[0].trimEnd();
 fs.writeFileSync(f.taskFile,text+'\n\n## 成果\n- 本体保存済み：body:.@'+f.saved+'\n\n## 残件申告\n```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:f.evidence})+'\n```\n');
 fs.appendFileSync(path.join(f.p.dir,'saved.txt'),'later authorized child work\n');h.g(f.p.dir,'add','.');h.g(f.p.dir,'commit','-qm','later child save');
 return f;
}
test('予約前の検査停止・修復済み・後続保存後も、中止だけ可能で原文と未受領を保持',async()=>{
 const f=await advancedStopped(),prior=f.r(),count=h.launches().length,originals=h.originalFiles(f),other=fs.readFileSync(f.store.taskFile(f.p.id,f.other.id),'utf8'),d=await preview(f);
 assert.equal(d.out.resumeAllowed,false);assert.equal(d.out.abandon.allowed,true,JSON.stringify(d.out.abandon));
 const ap=await h.post('/api/task/integrate/abandon',{...f.common,preview:true});assert.equal(ap.status,200,JSON.stringify(ap.out));
 const b={...f.common,id:ap.out.id,token:ap.out.token,confirm:true},out=await h.post('/api/task/integrate/abandon',b);
 assert.equal(out.status,200,JSON.stringify(out.out));assert.equal(out.out.received,0);assert.equal(out.out.cleaned,0);
 assert.deepEqual(f.r().abandoned.original,prior);assert.deepEqual(h.originalFiles(f),originals);assert.equal(h.launches().length,count);
 const proof=Object.values(f.r().abandoned.evidence.attempts).find(a=>a.kind==='validation-failed').failure;
 assert.equal(proof.kind,'stopped-before-reservation');assert.equal(proof.source.head,h.g(f.p.dir,'rev-parse','HEAD'));
 await h.cold();assert.equal((await h.post('/api/task/integrate/abandon',b)).status,409);
 const next=await preview(f);assert.equal(next.status,200,JSON.stringify(next.out));assert.equal(next.out.resume,undefined);
 const started=await h.post('/api/task/integrate',{...f.common,token:next.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]});assert.equal(started.status,200,JSON.stringify(started.out));
 assert.deepEqual(f.r().items.map(i=>[i.task,i.keep]),[[f.child.id,true]]);assert.equal(f.r().auto.thenMain,false);
 assert.equal(h.launches().length,count);assert.equal(fs.readFileSync(f.store.taskFile(f.p.id,f.other.id),'utf8'),other);assert.match(fs.readFileSync(f.taskFile,'utf8'),/\[ \] 実機未確認/);
});

for(const change of ['source-after-preview','task-after-preview','dirty-source','unrelated-save','handoff','stop-kind','unknown-delivery','pending'])test('予約前中止の境界は緩めない：'+change,async()=>{
 const f=await advancedStopped(),count=h.launches().length;
 const ap=await h.post('/api/task/integrate/abandon',{...f.common,preview:true});assert.equal(ap.status,200,JSON.stringify(ap.out));
 const record=f.r(),a=Object.values(record.auto.attempts).find(a=>a.phase==='organize');
 if(change==='source-after-preview'){
  fs.appendFileSync(path.join(f.p.dir,'saved.txt'),'changed after preview\n');h.g(f.p.dir,'add','.');h.g(f.p.dir,'commit','-qm','after preview');
 }else if(change==='task-after-preview')f.store.appendSection(f.p.id,f.child.id,'メモ','確認後に変更');
 else if(change==='dirty-source')fs.appendFileSync(path.join(f.p.dir,'saved.txt'),'unsaved\n');
 else if(change==='unrelated-save'){
  const unrelated=h.g(f.p.dir,'commit-tree',h.g(f.p.dir,'rev-parse','HEAD^{tree}'),'-m','unrelated root'),chat=require('../lib/chat'),rows=chat.read(f.p.dir,f.child.id);
  rows.findLast(x=>x.role==='assistant').integrationAuto.saved.head=unrelated;
  fs.writeFileSync(chat.files(f.p.dir,f.child.id).log,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 }else if(change==='handoff')runtime().taskIntegrate.transfer.save({project:f.p.id,task:f.child.id,complete:true,received:[]});
 else if(change==='stop-kind'){record.auto.stopped.stage='unknown';runtime().taskIntegrate.save(record);}
 else if(change==='unknown-delivery'){a.delivery.state='unknown';runtime().taskIntegrate.save(record);}
 else runtime().chats.queue(f.p.id,f.child.id).push({request:a.delivery.request,text:a.request.text});
 const out=await h.post('/api/task/integrate/abandon',{...f.common,id:ap.out.id,token:ap.out.token,confirm:true});assert.equal(out.status,409,JSON.stringify(out.out));
 assert.equal(f.r().abandoned,undefined);assert.equal(h.launches().length,count);
 if(!change.endsWith('after-preview'))assert.equal((await h.post('/api/task/integrate/abandon',{...f.common,preview:true})).status,409);
 if(change==='pending')runtime().chats.queue(f.p.id,f.child.id).length=0;
});
