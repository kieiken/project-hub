'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-reminder-http-')),root=path.join(tmp,'root');
Object.assign(process.env,{HUB_ROOT:root,HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'freetalk')});
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
const store=new(require('../lib/store').Store)(root),p=store.createProject({name:'Fixture'}).project,t=store.createTask(p.id,{title:'Unfinished fixture'}),empty=store.createTask(p.id,{title:'Empty fixture'});
const journal=require('../lib/chat-continuation'),chat=require('../lib/chat');
function seed(dir,task){journal.update(dir,task,d=>{for(const status of ['open','waiting','resuming','resolved'])d.entries[status]={id:status,status,original:'private original '+status,partial:'private partial '+status,reason:'stop reason '+status,source:{at:'2026-11-14T01:02:03Z'},updated:'r1',...(status==='resolved'?{resolution:{evidence:'result',at:'r1'}}:{})};});}
seed(p.dir,t.id);
let hub,base;
const post=(route,body,auth=true)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Hub':'1'}:{})},body:JSON.stringify(body)});
test.before(async()=>{const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;});
test.after(async()=>{hub.stopControl.cleanExit();hub.server.closeAllConnections();await new Promise(r=>hub.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('reminder HTTP: state exposes counts only; list returns original/reason/date for active records',async()=>{
 const r=await fetch(base+'/api/state'),text=await r.text(),s=JSON.parse(text);assert.equal(r.status,200,text);assert.equal(s.projects.find(x=>x.id===p.id).tasks.find(x=>x.id===t.id).unfinishedCount,3);assert.equal(s.projects.find(x=>x.id===p.id).tasks.find(x=>x.id===empty.id).unfinishedCount,0);assert.doesNotMatch(text,/private original|private partial|stop reason/);
 const r2=await fetch(base+'/api/chat/unfinished?'+new URLSearchParams({project:p.id,task:t.id}));assert.equal(r2.status,200);const list=await r2.json();assert.deepEqual(list.entries.map(x=>x.id),['open','waiting','resuming']);assert.equal(list.entries[0].original,'private original open');assert.equal(list.entries[0].reason,'stop reason open');assert.equal(list.entries[0].at,'2026-11-14T01:02:03Z');assert.ok(!JSON.stringify(list).includes('private partial'));
});
test('reminder HTTP: owner dismissal requires authenticated POST and current revision, changes count/ETag but preserves record',async()=>{
 const url='/api/chat/unfinished/dismiss',body={project:p.id,task:t.id,id:'open',expectedUpdated:'r1'},before=fs.readFileSync(journal.file(p.dir,t.id)),r=await fetch(base+'/api/state'),tag=r.headers.get('etag');
 assert.equal((await post(url,body,false)).status,403);assert.deepEqual(fs.readFileSync(journal.file(p.dir,t.id)),before);
 const stale=await post(url,{...body,expectedUpdated:'old'});assert.equal(stale.status,409);assert.deepEqual(fs.readFileSync(journal.file(p.dir,t.id)),before);
 const result=await post(url,body);assert.equal(result.status,200);assert.equal((await result.json()).entry.status,'dismissed');const after=journal.read(p.dir,t.id);assert.equal(after.entries.open.original,'private original open');assert.equal(after.entries.open.partial,'private partial open');assert.equal(after.entries.open.dismissal.by,'owner');assert.equal(after.entries.resolved.status,'resolved');
 const changed=await fetch(base+'/api/state',{headers:{'If-None-Match':tag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);assert.equal((await changed.json()).projects.find(x=>x.id===p.id).tasks.find(x=>x.id===t.id).unfinishedCount,2);
 const list=await(await fetch(base+'/api/chat/unfinished?'+new URLSearchParams({project:p.id,task:t.id}))).json();assert.equal(list.entries.length,2);assert.deepEqual(chat.read(p.dir,t.id),[]);
});
for(const action of ['dismiss','resolve']) test('reminder HTTP: freetalk '+action+' closes only its topic record with current revision and retains history',async()=>{
 await post('/api/freetalk/ensure',{});
 const topic=await(await post('/api/freetalk/topic',{})).json(),sibling=await(await post('/api/freetalk/topic',{})).json(),f=store.readProject('freetalk');
 seed(f.dir,topic.id);seed(f.dir,sibling.id);
 journal.update(f.dir,sibling.id,d=>{d.entries['sibling-only']={...d.entries.open,id:'sibling-only'};});
 const url='/api/chat/unfinished/'+action,body={project:'freetalk',task:topic.id,id:'open',expectedUpdated:'r1',...(action==='resolve'?{evidence:'Verified fixture result in the same topic'}:{})};
 const before=fs.readFileSync(journal.file(f.dir,topic.id)),other=fs.readFileSync(journal.file(f.dir,sibling.id)),normal=fs.readFileSync(journal.file(p.dir,t.id));
 const listing=await fetch(base+'/api/chat/unfinished?'+new URLSearchParams({project:'freetalk',task:topic.id}));
 assert.equal(listing.status,200);const entries=(await listing.json()).entries;assert.deepEqual(entries.map(x=>x.id),['open','waiting','resuming']);assert.equal(entries[0].original,'private original open');
 const count=state=>state.projects.find(x=>x.id==='freetalk').tasks.find(x=>x.id===topic.id).unfinishedCount;
 const stateBefore=await fetch(base+'/api/state'),tag=stateBefore.headers.get('etag');assert.equal(count(await stateBefore.json()),3);
 assert.equal((await post(url,body,false)).status,403);
 for(const change of [{expectedUpdated:'old'},{id:'sibling-only'},...(action==='resolve'?[{evidence:''}]:[])]) {
  const rejected=await post(url,{...body,...change});assert.equal(rejected.status,409,JSON.stringify(change));
  assert.deepEqual(fs.readFileSync(journal.file(f.dir,topic.id)),before);
 }
 const result=await post(url,body);assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).entry.status,action==='dismiss'?'dismissed':'resolved');
 const saved=journal.read(f.dir,topic.id).entries.open,original=JSON.parse(before).entries.open;
 for(const key of ['original','partial','reason','source'])assert.deepEqual(saved[key],original[key],key);
 if(action==='dismiss')assert.equal(saved.dismissal.by,'owner');else assert.equal(saved.resolution.evidence,body.evidence);
 assert.deepEqual(fs.readFileSync(journal.file(f.dir,sibling.id)),other);assert.deepEqual(fs.readFileSync(journal.file(p.dir,t.id)),normal);
 assert.equal((await post(url,body)).status,409,'old revision stays invalid after closing');
 const changed=await fetch(base+'/api/state',{headers:{'If-None-Match':tag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);assert.equal(count(await changed.json()),2);
 const remaining=await(await fetch(base+'/api/chat/unfinished?'+new URLSearchParams({project:'freetalk',task:topic.id}))).json();assert.deepEqual(remaining.entries.map(x=>x.id),['waiting','resuming']);assert.deepEqual(chat.read(f.dir,topic.id),[]);
 for(const change of [{task:undefined},{task:'freetalk'},{task:'FreeTalk'},{project:'FreeTalk'},{project:'FREETALK'},{project:'freetalk/'+topic.id},{task:'missing-topic'}])
  assert.equal((await post(url,{...body,...change})).status,change.task==='missing-topic'?400:409,JSON.stringify(change));
});
function orphan(task,project=p){
 seed(project.dir,task);
 journal.update(project.dir,task,d=>{for(const e of Object.values(d.entries))e.source={...e.source,project:project.id,task,pdir:project.dir};});
 assert.equal(store.taskFile(project.id,task),null);
 return journal.file(project.dir,task);
}
for(const action of ['dismiss','resolve'])test('reminder HTTP: orphan '+action+' verifies scope and revision, preserves history and records the missing task',async()=>{
 const task='orphan-'+action,file=orphan(task),before=journal.read(p.dir,task),other=fs.readFileSync(journal.file(p.dir,t.id));
 const url='/api/chat/unfinished/'+action,body={project:p.id,task,id:'open',expectedUpdated:'r1',evidence:'Verified fixture artifact and reason'};
 const bytes=fs.readFileSync(file);
 assert.equal((await post(url,body,false)).status,403);
 for(const patch of [{expectedUpdated:'stale'},{expectedUpdated:undefined},{id:'absent'},...(action==='resolve'?[{evidence:''}]:[])]){
  assert.equal((await post(url,{...body,...patch})).status,409);assert.deepEqual(fs.readFileSync(file),bytes);
 }
 const result=await post(url,body);assert.equal(result.status,200,await result.clone().text());
 const saved=(await result.json()).entry,after=journal.read(p.dir,task);
 assert.equal(saved.status,action==='dismiss'?'dismissed':'resolved');const closure=saved[action==='dismiss'?'dismissal':'resolution'];
 assert.equal(closure.taskMissing,true);assert.equal(saved.updated,closure.at);
 for(const key of ['original','partial','reason','source'])assert.deepEqual(saved[key],before.entries.open[key],key);
 for(const id of ['waiting','resuming','resolved'])assert.deepEqual(after.entries[id],before.entries[id]);
 assert.deepEqual(after.advances,before.advances);assert.deepEqual(fs.readFileSync(journal.file(p.dir,t.id)),other);
 assert.equal((await post(url,body)).status,409);assert.equal(store.taskFile(p.id,task),null);
 assert.equal((await fetch(base+'/api/chat/unfinished?'+new URLSearchParams({project:p.id,task}))).status,400,'orphan list behavior remains unchanged');
});
for(const action of ['dismiss','resolve'])test('reminder HTTP: orphan '+action+' rejects foreign identity, unsafe names and absent records without writes',async()=>{
 const task='orphan-reject-'+action,file=orphan(task),url='/api/chat/unfinished/'+action;
 const body={project:p.id,task,id:'open',expectedUpdated:'r1',evidence:'fixture'};
 const foreign=store.createProject({name:'Other '+action}).project,foreignFile=orphan(task,foreign),foreignBytes=fs.readFileSync(foreignFile);
 const original=journal.read(p.dir,task).entries.open.source;
 for(const source of [{...original,project:foreign.id},{...original,task:'another-task'},{...original,pdir:foreign.dir},{}]){
  journal.update(p.dir,task,d=>{d.entries.open.source=source;});const bytes=fs.readFileSync(file);
  const r=await post(url,{...body,taskMissing:false,projectId:p.id});assert.equal(r.status,409);assert.deepEqual(fs.readFileSync(file),bytes);
 }
 journal.update(p.dir,task,d=>{d.entries.open.source=original;});const bytes=fs.readFileSync(file);
 for(const taskName of ['../escape','nested/name','nested\\name','_hidden','.hidden','',null,[],{},'bad\0name']){
  assert.equal((await post(url,{...body,task:taskName})).status,400,JSON.stringify(taskName));assert.deepEqual(fs.readFileSync(file),bytes);
 }
 for(const project of ['missing-project','../escape',null,{}])assert.equal((await post(url,{...body,project})).status,400);
 assert.equal((await post(url,{...body,task:'no-record-'+action})).status,409);
 assert.equal(fs.existsSync(journal.file(p.dir,'no-record-'+action)),false);
 assert.deepEqual(fs.readFileSync(foreignFile),foreignBytes);
 // An ID found only in another project's journal never selects that file.
 journal.update(foreign.dir,task,d=>{d.entries.foreignOnly={...d.entries.open,id:'foreignOnly'};});const foreignAfter=fs.readFileSync(foreignFile);
 assert.equal((await post(url,{...body,id:'foreignOnly'})).status,409);assert.deepEqual(fs.readFileSync(foreignFile),foreignAfter);
 assert.deepEqual(fs.readFileSync(file),bytes);
});
test('reminder HTTP: orphan linked record paths are rejected and freetalk still requires an existing topic',async()=>{
 const task='link-source',file=orphan(task),before=fs.readFileSync(file);
 for(const [name,link] of [['symlink-orphan',(dest)=>fs.symlinkSync(file,dest)],['hardlink-orphan',(dest)=>fs.linkSync(file,dest)]]){
  const dest=journal.file(p.dir,name);link(dest);
  for(const action of ['dismiss','resolve'])assert.equal((await post('/api/chat/unfinished/'+action,{project:p.id,task:name,id:'open',expectedUpdated:'r1',evidence:'fixture'})).status,409);
  assert.deepEqual(fs.readFileSync(file),before);fs.unlinkSync(dest);
 }
 const f=store.readProject('freetalk'),topic='orphan-topic';orphan(topic,f);const bytes=fs.readFileSync(journal.file(f.dir,topic));
 for(const action of ['dismiss','resolve'])assert.equal((await post('/api/chat/unfinished/'+action,{project:f.id,task:topic,id:'open',expectedUpdated:'r1',evidence:'fixture'})).status,400);
 assert.deepEqual(fs.readFileSync(journal.file(f.dir,topic)),bytes);
 // Existing tasks ignore forged orphan metadata, retaining their established receipt shape.
 const r=await post('/api/chat/unfinished/resolve',{project:p.id,task:t.id,id:'waiting',expectedUpdated:'r1',evidence:'fixture',taskMissing:true});
 assert.equal(r.status,200);assert.equal((await r.json()).entry.resolution.taskMissing,undefined);
});
const rule='止まったままの依頼の記録や、決めたのに始めていない作業がある時は、返事の最後に件数と中身を一行ずつ書く。無い時は書かない。';
const occurrences=(text,part)=>text.split(part).length-1;
test('reminder instructions: reporting rule occurs once in conversation and full generated rules; cleanup prompt is conditional',()=>{
 assert.ok(chat.REPORT_RULE.includes(rule));const file=store.taskFile(p.id,t.id),options={ai:'codex',model:'gpt-6.1-sol',rows:[],text:'fixture',meta:{}};
 const basePrompt=hub.taskPrompt(p,t,file,p.dir),turn=chat.buildTurn({...options,basePrompt});assert.equal(occurrences(turn.stdin,rule),1);assert.equal(occurrences(fs.readFileSync(path.join(p.dir,'.ai/chat',t.id+'.rules.md'),'utf8'),rule),1);assert.equal(occurrences(basePrompt,'大掃除や整理'),1);
 const other=hub.taskPrompt(p,empty,store.taskFile(p.id,empty.id),p.dir);assert.equal(occurrences(other,'大掃除や整理'),0);
});
test('reminder instructions: freetalk receives the rule once and unfinished cleanup guidance only while needed',async()=>{
 await post('/api/freetalk/ensure',{});const topic=await(await post('/api/freetalk/topic',{})).json(),f=store.readProject('freetalk');seed(f.dir,topic.id);const task=store.readTask(store.taskFile('freetalk',topic.id));
 const prompt=hub.taskPrompt(f,task,store.taskFile('freetalk',topic.id),f.dir),turn=chat.buildTurn({ai:'codex',model:'gpt-6.1-sol',rows:[],text:'fixture',meta:{},basePrompt:prompt});assert.equal(occurrences(turn.stdin,rule),1);assert.equal(occurrences(prompt,'大掃除や整理'),1);assert.match(prompt,/返事の最後に未完の件数/);
 for(const e of journal.pending(f.dir,topic.id))journal.dismiss(f.dir,topic.id,{id:e.id,expectedUpdated:e.updated});assert.doesNotMatch(hub.taskPrompt(f,task,store.taskFile('freetalk',topic.id),f.dir),/大掃除や整理/);
});
