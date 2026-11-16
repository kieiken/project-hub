'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),cp=require('node:child_process');
const wait=require('../lib/task-wait'),chat=require('../lib/chat'),{Store}=require('../lib/store');
const base='94d9f0bc763ef727fa5da390bbb50476d39e9a19';
function old(file){const filename=path.resolve(__dirname,'../lib',file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(cp.execFileSync('git',['show',base+':hub/lib/'+file],{encoding:'utf8'}),filename);return m.exports;}
const oldChat=old('chat.js'),OldStore=old('store.js').Store;
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-task-wait-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root),p=store.createProject({name:'Fixture'}).project,t1=store.createTask(p.id,{title:'Wait'});return {root,store,p,t:t1,o:{project:p.id,task:t1.id},file:store.taskFile(p.id,t1.id)};}
const marked='Done.\n[[待ち]]\n時刻待ち（22:00 に自動で動く）\n[[/待ち]]';
test('only a closed final unquoted block is accepted; malformed and quoted examples remain intact',()=>{
 assert.deepEqual(wait.parse(marked),{text:'Done.',waitReason:'時刻待ち（22:00 に自動で動く）'});
 for(const text of ['ordinary','[[待ち]]\nreason',marked+'\nmore',marked.replace('時刻待ち（22:00 に自動で動く）',''),marked.replace('時刻待ち（22:00 に自動で動く）','x'.repeat(501)),'```text\n'+marked+'\n```','~~~\n'+marked,'```\n```text\n'+marked,'> [[待ち]]\n> reason\n> [[/待ち]]'])assert.deepEqual(wait.parse(text),{text});
 assert.equal(wait.parse('```\nexample\n```\n'+marked).waitReason,'時刻待ち（22:00 に自動で動く）');
});
test('persist/reload waiting with old-compatible disk state; first new turn clears only waiting',t=>{
 const f=fixture(t),row=wait.parse(marked);fs.appendFileSync(f.file,'\n## 手順\n- [x] done\n');wait.ended(f.store,f.o,row);
 assert.equal(f.store.readTask(f.file).state,'処理待ち');assert.equal(f.store.readTask(f.file).completionPending,false);assert.equal(new Store(f.root).readTask(f.file).waitReason,row.waitReason);
 const oldTask=new OldStore(f.root).readTask(f.file);assert.equal(oldTask.state,'実行中');assert.equal(oldTask.waitReason,undefined);
 wait.started(f.store,f.o);const next=f.store.readTask(f.file);assert.equal(next.state,'実行中');assert.equal(next.waitReason,undefined);
 assert.equal(next.question,'');assert.deepEqual(next.steps,oldTask.steps);
});
test('question, queue, stop, failure and isolated jobs never become waiting; old states stay unchanged',t=>{
 const f=fixture(t),row=wait.parse(marked);
 for(const state of ['未着手','実行中','返事待ち','停止','上限で停止']){
  f.store.updateTask(f.o.project,f.o.task,{state});const before=fs.readFileSync(f.file,'utf8');wait.ended(f.store,f.o,{text:'no marker'});assert.equal(fs.readFileSync(f.file,'utf8'),before);
 }
 for(const [o,r,flags] of [[{}, {...row,error:'failure'}], [{}, {...row,asks:[{question:'why?'}]}],[{},row,{stopped:true}],[{automation:{}},row],[{isolatedReview:true},row],[{selectionOnly:true},row],[{preserveTaskState:true},row],[{readOnly:true},row],[{discussionTurn:true},row],[{origin:'tier-review'},row]]){
  f.store.updateTask(f.o.project,f.o.task,{state:'実行中'});const before=fs.readFileSync(f.file,'utf8');wait.ended(f.store,{...f.o,...o},r,flags);assert.equal(fs.readFileSync(f.file,'utf8'),before);
 }
 f.store.updateTask(f.o.project,f.o.task,{state:'実行中',question:'existing question'});wait.ended(f.store,f.o,row);assert.equal(f.store.readTask(f.file).question,'existing question');assert.notEqual(f.store.readTask(f.file).state,'処理待ち');
 f.store.updateTask(f.o.project,f.o.task,{state:'実行中',question:''});wait.ended(f.store,f.o,row,{queued:true});assert.equal(f.store.readTask(f.file).state,'実行中');
});
test('no marker: old/new readers and state writes, CLI arguments and saved completion match',async t=>{
 const f=fixture(t),legacy=new OldStore(f.root);
 for(const state of ['未着手','実行中','返事待ち','停止','上限で停止']){
  const original=fs.readFileSync(f.file,'utf8');legacy.updateTask(f.o.project,f.o.task,{state,question:state==='返事待ち'?'q':''});const bytes=fs.readFileSync(f.file,'utf8');fs.writeFileSync(f.file,original);f.store.updateTask(f.o.project,f.o.task,{state,question:state==='返事待ち'?'q':''});
  const clean=x=>x.replace(/^updated:.*$/m,'updated: fixture');assert.equal(clean(fs.readFileSync(f.file,'utf8')),clean(bytes));assert.deepEqual(f.store.readTask(f.file),legacy.readTask(f.file));
 }
 const fake=path.join(f.root,'fake.cjs');fs.writeFileSync(fake,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',session_id:'sid'}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:process.env.FIXTURE_REPLY||'RESULT'}]}}));console.log(JSON.stringify({type:'result',is_error:false,result:''}));});`,{mode:0o755});
 const results=[];
 for(const mod of [oldChat,chat]){
  mod.writeMeta(f.p.dir,f.t.id,{});const runner=new mod.ChatRunner({dirOf:()=>f.p.dir});const o={...f.o,ai:'claude',model:'Opus 5.5',effort:'高',pdir:f.p.dir,dir:f.p.dir,text:'fixture',basePrompt:'rules',perm:fake};
  assert.deepEqual(chat.buildTurn({...o,meta:{},rows:[]}),oldChat.buildTurn({...o,meta:{},rows:[]}));
  const r=runner.send(o);assert.ok(await r.started);await runner.busy(f.o.project,f.o.task).finishedP;const row=mod.read(f.p.dir,f.t.id).findLast(x=>x.role==='assistant');const {at,ms,turn,...stable}=row;results.push({row:stable,meta:mod.readMeta(f.p.dir,f.t.id)});
 }
 assert.deepEqual(results[1],results[0]);
});
test('real runner finalization uses the marker only after successful completion and honors queues',async t=>{
 const f=fixture(t),fake=path.join(f.root,'fake.cjs');fs.writeFileSync(fake,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:process.env.FIXTURE_REPLY}]}}));console.log(JSON.stringify({type:'result',is_error:false,result:''}));});`,{mode:0o755});
 for(const supervised of [false,true]){
 const runner=new chat.ChatRunner({...(supervised?{spoolRoot:path.join(f.root,'spool')}:{}),dirOf:()=>f.p.dir,onStarted:o=>wait.started(f.store,o),onTurnEnd:(o,row,flags)=>wait.ended(f.store,o,row,flags)});
 for(const queued of [false,true]){
  f.store.updateTask(f.o.project,f.o.task,{state:'実行中',question:''});runner.setQueue(f.o.project,f.o.task,queued?[{id:'blocked',error:'fixture',ai:'claude'}]:[]);
  const o={...f.o,ai:'claude',model:'Opus 5.5',effort:'高',pdir:f.p.dir,dir:f.p.dir,text:'fixture',basePrompt:'rules',perm:fake,env:{FIXTURE_REPLY:marked},started:Date.now(),userRow:{turn:'fixture'}};
  const r=supervised?runner.run(o,{command:process.execPath,args:[fake],stdin:'fixture',env:o.env},{sessions:{},models:{}},[]):runner.send(o);
  assert.ok(await (supervised?r.startedP:r.started));await runner.busy(f.o.project,f.o.task).finishedP;
  assert.equal(f.store.readTask(f.file).state,queued?'実行中':'処理待ち');const row=chat.read(f.p.dir,f.t.id).findLast(x=>x.role==='assistant');assert.equal(row.waitReason,wait.parse(marked).waitReason);assert.doesNotMatch(row.text,/\[\[待ち/);
 }
 }
});
