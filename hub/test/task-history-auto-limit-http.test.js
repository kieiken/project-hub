'use strict';
// All CLI names below resolve to local fixture executables; no real AI is called.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),{TaskHistory}=require('../lib/task-history'),{ModelLimits}=require('../lib/model-limits'),chat=require('../lib/chat'),auto=require('../lib/task-history-auto');
const hub=path.resolve(__dirname,'..');
async function wait(check){for(let n=0;n<500;n++){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,20));}assert.fail('isolated HTTP fixture timed out');}
// The fixture server may be between truncate and write; only polling tolerates
// that transient parse failure. Final queue assertions below stay strict.
function queueWaiting(file,queue){if(!fs.existsSync(file))return false;try{return queue()[0]?.limitWaiting;}catch(e){if(e instanceof SyntaxError)return false;throw e;}}
async function fixture(t,lang='ja',faultPoint=''){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-auto-limit-http-')),home=path.join(root,'home'),bin=path.join(root,'bin');
 for(const d of [home,bin,path.join(root,'_hub')])fs.mkdirSync(d,{recursive:true});
 const mode=path.join(root,'mode'),launches=path.join(root,'launches.jsonl'),pause=path.join(root,'pause'),fault=path.join(root,'fault'),reached=path.join(root,'reached');fs.writeFileSync(mode,'ok');
 fs.writeFileSync(path.join(root,'_hub/roles.yaml'),fs.readFileSync(path.join(hub,'../docs/project-hub/templates/_hub/roles.yaml'),'utf8').replace('auto: false','auto: true'));
 for(const ai of ['claude','codex'])fs.writeFileSync(path.join(bin,ai),`#!${process.execPath}
const fs=require('node:fs'),ai=${JSON.stringify(ai)};if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8'),out=o=>console.log(JSON.stringify(o));
 fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({ai,input,args:process.argv.slice(2)})+'\\n');
 setTimeout(()=>{
  if(mode==='ordinary-error'){out({type:'result',is_error:true,result:'fixture ordinary result error'});process.exitCode=1;return;}
  if(mode==='both'||mode==='post'&&ai==='claude'){
   out(ai==='claude'?{type:'result',is_error:true,result:"You've reached your Opus limit. Switch to another model."}:{type:'turn.failed',error:{message:"You've hit your usage limit. Try again later."}});process.exitCode=1;return;
  }
  const result=JSON.stringify({items:[{type:'decision',text:'SELECTION_ACCEPTED_'+ai,rows:[1]}]});
  if(ai==='claude')out({type:'result',result,session_id:'fixture'});
  else{out({type:'item.completed',item:{type:'agent_message',text:result}});out({type:'turn.completed'});}
 },mode==='hold'?300:20);
});`,{mode:0o755});
 const store=new Store(root),p=store.createProject({name:'Fixture'}).project,task=store.createTask(p.id,{title:'本作業',steps:['残件']});
 chat.append(p.dir,task.id,{role:'user',text:'この方針で進めてください'});
 const limits=new ModelLimits(path.join(root,'_hub/limits.json')),history=new TaskHistory({store});let child,base,output='';
 const start=async()=>{
  // The HTTP host check uses HUB_PORT, so the fixture must use the chosen port.
  const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const code=`const fs=require('node:fs'),{TaskHistory}=require('./lib/task-history'),chat=require('./lib/chat'),Runner=chat.ChatRunner;
const finish=TaskHistory.prototype.autoFinish;TaskHistory.prototype.autoFinish=function(...args){if(!fs.existsSync(${JSON.stringify(pause)}))return finish.apply(this,args);};
const fault=${JSON.stringify(fault)},point=${JSON.stringify(faultPoint)},reached=${JSON.stringify(reached)},active=()=>fs.existsSync(fault),crash=()=>{fs.writeFileSync(reached,point);process.exit(0);};
const setQueue=Runner.prototype.setQueue;Runner.prototype.setQueue=function(p,t,q,...args){const hit=active()&&q.length===1&&q[0].limitWaiting===false;if(hit&&point==='before-queue-save')crash();const r=setQueue.call(this,p,t,q,...args);if(hit&&point==='after-queue-save')crash();return r;};
const sendQueued=Runner.prototype.sendQueued;Runner.prototype.sendQueued=function(...args){if(active()&&point==='before-send')crash();if(active()&&point==='launch-error'){fs.appendFileSync(reached,'failure\\n');throw Error('fixture ordinary launch failure');}return sendQueued.apply(this,args);};
const send=Runner.prototype.send;Runner.prototype.send=async function(o,...args){
 if(!active()||!o.selectionOnly||!['delivery-limit','delivery-maintenance'].includes(point))return send.call(this,o,...args);
 const saved={limitPreflight:this.limitPreflight,limitBackup:this.limitBackup,limitTarget:this.limitTarget,canStart:this.canStart};
 if(point==='delivery-limit'){this.limitPreflight=()=>({validUntil:'2099-01-01T00:00:00Z'});this.limitBackup=()=>({ai:'codex',model:'gpt-6.1-sol'});this.limitTarget=()=>true;}
 else this.canStart=()=>Object.assign(Error('fixture maintenance'),{code:'HUB_AI_MAINTENANCE'});
 try{return await send.call(this,o,...args);}finally{Object.assign(this,saved);}
};
const run=Runner.prototype.run;Runner.prototype.run=function(...args){if(active()&&point==='after-user')crash();if(active()&&point==='missing-cli')args[1]={...args[1],command:${JSON.stringify(path.join(root,'missing-fixture-cli'))}};return run.apply(this,args);};
const unqueue=Runner.prototype.unqueue;Runner.prototype.unqueue=function(p,t,id,...args){if(active()&&point==='retain-error')return;if(active()&&['before-remove','after-remove'].includes(point)){if(!chat.read(this.dirOf(p),t).some(r=>r.role==='assistant'&&r.request===id&&!r.error))return;if(point==='before-remove')crash();const r=unqueue.call(this,p,t,id,...args);crash();return r;}return unqueue.call(this,p,t,id,...args);};
const runtime=require('./server'),{server,PORT}=runtime;process.on('SIGUSR2',()=>{runtime.stopControl.cleanExit();server.close();process.exit(0);});server.listen(PORT,'127.0.0.1',()=>runtime.restoreReady.then(()=>console.log('READY:'+server.address().port)));`;
  child=spawn(process.execPath,['-e',code],{cwd:hub,env:{...process.env,HUB_ROOT:root,HUB_PORT:String(port),HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_LANG:lang,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
  output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  await wait(()=>{assert.equal(child.exitCode,null,output);const m=output.match(/READY:(\d+)/);if(m){base='http://127.0.0.1:'+m[1];return true;}});
 };
 const stop=async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGUSR2');await done;}};
 t.after(async()=>{await stop();fs.rmSync(root,{recursive:true,force:true});});
 const body={project:p.id,task:task.id},requestId=randomUUID();
 const post=async(route,data={})=>{const res=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...body,...data})});const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value;};
 const view=async()=>await(await fetch(base+'/api/task/history/auto?'+new URLSearchParams(body),{headers:{'X-Hub':'1'}})).json();
 const rows=()=>chat.read(p.dir,task.id),calls=()=>fs.existsSync(launches)?fs.readFileSync(launches,'utf8').trim().split('\n').map(JSON.parse):[];
 await start();return {endpoint:()=>base,root,p,task,store,history,limits,mode,pause,fault,reached,start,stop,post,view,rows,calls,requestId,
  begin:()=>post('/api/task/history/auto',{generation:1,requestId}),
  done:()=>wait(async()=>{const v=await view();return v.auto?.stage==='done'&&v;}),
  archived:()=>{const a=history.archives(p.id,task.id);assert.equal(a.length,1);return history.archive(p.id,task.id,a[0].id).rows;}};
}
for(const lang of ['ja','zh-TW'])for(const queued of [false,true])test('Hub delegation records provenance for '+lang+', queued='+queued,async t=>{
 const f=await fixture(t,lang);fs.writeFileSync(f.mode,'hold');
 if(queued)await f.post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'人の指示'});
 const result=await f.post('/api/delegate',{ai:'claude',model:'claude-opus-5-5',title:'review',text:'可以發布'});assert.equal(Boolean(result.queued),queued);
 if(!queued)await f.post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'人の指示',mode:'queue'});
 await wait(()=>f.rows().filter(r=>r.role==='assistant').length===2);
 const user=f.rows().findLast(r=>r.role==='user'&&r.origin==='delegate');assert.ok(user);assert.equal(auto.human({...user,text:'別の表示文でも可以發布'}),false);
 assert.equal(auto.human(f.rows().find(r=>r.role==='user'&&r.text==='人の指示')),true,'human queue never inherits delegation provenance');
 assert.match(user.text,lang==='ja'?/【渡した依頼：review】/:/【已交接的要求：review】/);
});
test('selection preflight switch uses one request and accepts backup JSON',async t=>{
 const f=await fixture(t);f.limits.record({ai:'claude',model:'claude-opus-5-5',limitError:"You've reached your Opus limit"});
 const roles=fs.readFileSync(path.join(f.root,'_hub/roles.yaml'));
 await f.begin();const done=await f.done();assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);
 assert.deepEqual(f.calls().map(r=>r.ai),['codex']);assert.match(f.rows()[0].text,/SELECTION_ACCEPTED_codex/);
 assert.doesNotMatch(f.calls()[0].input,/<previous_conversation>|\[\[質問\]\]/);assert.ok(!f.calls()[0].args.includes('resume'));
 assert.equal(f.archived().filter(r=>r.role==='user'&&r.limitSwitch?.preflight).length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'_hub/roles.yaml')),roles);
});
test('selection postflight switch accepts limit-request JSON without a second delegation',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.mode,'post');await f.begin();const done=await f.done();
 assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex']);
 for(const call of f.calls()){assert.doesNotMatch(call.input,/<previous_conversation>|\[\[質問\]\]/);assert.ok(!call.args.includes('--resume')&&!call.args.includes('resume'));}
 assert.match(f.rows()[0].text,/SELECTION_ACCEPTED_codex/);
 const rows=f.archived(),users=rows.filter(r=>r.role==='user'&&r.origin==='hub-internal');assert.equal(users.length,2);assert.equal(users[1].request,'limit-'+done.auto.selectionRequest);
 assert.equal(rows.filter(r=>r.role==='event'&&r.limitSwitch).length,1);
});
test('both preflight limits keep reservation across server restart and resume once',async t=>{
 const f=await fixture(t);for(const [ai,model]of [['claude','claude-opus-5-5'],['codex','gpt-6.1-sol']])f.limits.record({ai,model,limitError:'fixture formal hold'});
 await f.begin();await wait(async()=>{const v=await f.view();return v.auto?.stage==='reserved'&&/上限中/.test(v.auto.reason);});assert.equal(f.calls().length,0);
 await f.stop();await f.start();assert.equal((await f.view()).auto.stage,'reserved');assert.equal(f.calls().length,0);
 f.limits.clear('default','gpt-6.1-sol');await f.begin();const done=await f.done();assert.equal(done.auto.attempt,0);assert.equal(done.generation,2);assert.deepEqual(f.calls().map(r=>r.ai),['codex']);
});
test('both postflight limits retain nested handoff across restart, with no reselection',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.mode,'both');await f.begin();
 const queue=()=>JSON.parse(fs.readFileSync(chat.files(f.p.dir,f.task.id).queue,'utf8'));
 await wait(()=>queueWaiting(chat.files(f.p.dir,f.task.id).queue,queue));
 const before=queue();assert.equal(before.length,1);assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex']);assert.equal((await f.view()).auto.stage,'selecting');
 await f.stop();await f.start();assert.deepEqual(queue(),before);assert.equal((await f.view()).auto.stage,'selecting');
 fs.writeFileSync(f.mode,'ok');f.limits.clear('default','claude-opus-5-5');
 const done=await f.done();assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);
 assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex','claude']);assert.match(f.rows()[0].text,/SELECTION_ACCEPTED_claude/);assert.equal(f.archived().filter(r=>r.role==='user'&&r.request===done.auto.selectionRequest).length,1);
});
test('server restart consumes an already saved backup reply without launching either CLI again',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.mode,'post');fs.writeFileSync(f.pause,'pause before commit');await f.begin();
 await wait(()=>f.rows().some(r=>r.role==='assistant'&&r.ai==='codex'&&!r.error));assert.equal((await f.view()).auto.stage,'selecting');
 await f.stop();fs.unlinkSync(f.pause);await f.start();await f.begin();const done=await f.done();
 assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex']);assert.match(f.rows()[0].text,/SELECTION_ACCEPTED_codex/);f.archived();
});
async function bothWaiting(f){
 fs.writeFileSync(f.mode,'both');await f.begin();
 const file=chat.files(f.p.dir,f.task.id).queue,queue=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 await wait(()=>queueWaiting(file,queue));
 assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex']);
 return {file,queue};
}
function release(f){fs.writeFileSync(f.mode,'ok');f.limits.clear('default','claude-opus-5-5');}
for(const point of ['before-queue-save','after-queue-save','before-send','after-user','before-remove','after-remove'])test('selection handoff survives crash at '+point+' without replaying a saved user turn',async t=>{
 const f=await fixture(t,'ja',point),q=await bothWaiting(f);
 const job=(await f.view()).auto;fs.writeFileSync(f.fault,point);release(f);
 await wait(()=>fs.existsSync(f.reached));await f.stop();
 const saved=f.rows(),started=saved.some(r=>r.role==='user'&&r.request===q.queue()[0]?.id);
 const beforeCalls=f.calls().length;fs.unlinkSync(f.fault);fs.writeFileSync(f.pause,'hold commit while tabs join');await f.start();
 // A genuine crash pauses new starts. Only this isolated fixture's explicit human-resume action releases it.
 const stopped=await(await fetch(f.endpoint()+'/api/ai/stop/status',{headers:{'X-Hub':'1'}})).json();assert.equal(stopped.all,true);await f.post('/api/ai/resume',{confirm:true});
 // Duplicate requests and another tab still join this job during recovery.
 const joined=await Promise.all([f.begin(),f.post('/api/task/history/auto',{generation:1,requestId:randomUUID()})]);
 for(const view of joined)assert.equal(view.auto.id,job.id);
 fs.unlinkSync(f.pause);
 const done=await f.done();assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);assert.equal(done.auto.id,job.id);
 const rows=f.archived(),users=rows.filter(r=>r.role==='user'&&r.request);
 assert.equal(new Set(users.map(r=>r.request)).size,users.length,'no user request is sent twice');
 if(point==='after-user'){
  assert.equal(started,true);assert.equal(f.calls().length,2);assert.match(f.rows()[0].text,/AI選別なし/);
 }else{
  assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex','claude']);assert.match(f.rows()[0].text,/SELECTION_ACCEPTED_claude/);
 }
 if(['before-remove','after-remove'].includes(point))assert.equal(f.calls().length,beforeCalls,'saved success is consumed without launch');
 assert.equal(q.queue().length,0);assert.equal(f.history.archives(f.p.id,f.task.id).length,1);
});
test('legacy unstarted selection queue without a failure resumes once after restart',async t=>{
 const f=await fixture(t),q=await bothWaiting(f);await f.stop();
 const item={...q.queue()[0],limitWaiting:false};delete item.error;fs.writeFileSync(q.file,JSON.stringify([item]));
 release(f);await f.start();const done=await f.done();assert.equal(done.auto.attempt,0);assert.equal(done.generation,2);
 assert.deepEqual(f.calls().map(r=>r.ai),['claude','codex','claude']);f.archived();
});
for(const failure of ['preflight','missing-cli'])test('ordinary '+failure+' failure retains selection queue and never retries after restart',async t=>{
 const f=await fixture(t,'ja',failure==='preflight'?'launch-error':'missing-cli'),q=await bothWaiting(f);
 fs.writeFileSync(f.fault,'ordinary error');
 release(f);await wait(async()=>{const v=await f.view();return v.auto.stage==='failed';});
 const before=q.queue();assert.equal(before.length,1);assert.equal(before[0].limitWaiting,false);assert.ok(before[0].error);
 if(failure==='preflight')assert.equal(fs.readFileSync(f.reached,'utf8').trim().split('\n').length,1);
 await f.stop();if(fs.existsSync(f.fault))fs.unlinkSync(f.fault);await f.start();
 await new Promise(r=>setTimeout(r,3200));assert.equal((await f.view()).auto.stage,'failed');assert.deepEqual(q.queue(),before);assert.equal(f.calls().length,2);
 assert.equal(f.history.archives(f.p.id,f.task.id).length,0);
});
for(const other of ['human-queue','forged-source','legacy-failure'])test('recovery retains '+other+' without launching or deleting it',async t=>{
 const f=await fixture(t),q=await bothWaiting(f);await f.stop();let items=q.queue();
 if(other==='human-queue')items.push({id:'human-instruction',ai:'codex',model:'GPT-6.1-Sol',text:'新しい人の指示'});
 if(other==='forged-source')items=[{...items[0],limitSwitch:{...items[0].limitSwitch,original:'別の依頼'}}];
 if(other==='legacy-failure')items=[{...items[0],limitWaiting:false,error:'ordinary previous launch error'}];
 fs.writeFileSync(q.file,JSON.stringify(items));release(f);await f.start();await new Promise(r=>setTimeout(r,3200));
 assert.deepEqual(q.queue(),items);assert.equal(f.calls().length,2);assert.equal(f.history.archives(f.p.id,f.task.id).length,0);
 assert.equal((await f.view()).auto.stage,other==='legacy-failure'?'failed':'selecting');
});
test('an ordinary error on a started leftover queue is never automatically resent or deleted',async t=>{
 const f=await fixture(t,'ja','retain-error'),q=await bothWaiting(f);
 fs.writeFileSync(f.fault,'retain started queue');fs.writeFileSync(f.mode,'ordinary-error');f.limits.clear('default','claude-opus-5-5');
 await wait(async()=>{const v=await f.view();return v.auto.stage==='failed'&&/ordinary result error/.test(v.auto.error);});
 const before=q.queue();assert.equal(before.length,1);assert.equal(f.calls().length,3);
 await f.stop();fs.unlinkSync(f.fault);fs.writeFileSync(f.mode,'ok');await f.start();await new Promise(r=>setTimeout(r,3200));
 assert.equal((await f.view()).auto.stage,'failed');assert.deepEqual(q.queue(),before);assert.equal(f.calls().length,3);
 assert.equal(f.history.archives(f.p.id,f.task.id).length,0);
});

test('large display input survives nested limit handoff and server restart with the same private file',async t=>{
 const f=await fixture(t);chat.append(f.p.dir,f.task.id,{role:'event',tool:true,text:'EXCLUDED_LARGE_TOOL'+ 'x'.repeat(50000)});
 chat.append(f.p.dir,f.task.id,{role:'user',text:'LONG_BODY_HEAD'+ '😀'.repeat(17000)+'LONG_BODY_TAIL'});
 const q=await bothWaiting(f),job=(await f.view()).auto;assert.equal(job.waiting,'limit');assert.equal(job.model,q.queue()[0].model);
 assert.ok(job.inputFile.startsWith(path.join(f.root,'_hub/task-history/inputs')));const bytes=fs.readFileSync(job.inputFile);
 assert.match(bytes.toString(),/LONG_BODY_TAIL/);assert.doesNotMatch(bytes.toString(),/EXCLUDED_LARGE_TOOL/);assert.equal(fs.statSync(job.inputFile).mode&0o777,0o600);
 assert.ok(q.queue()[0].text.includes(job.inputFile));await f.stop();await f.start();assert.deepEqual(fs.readFileSync(job.inputFile),bytes);release(f);const done=await f.done();
 assert.equal(done.auto.inputFile,job.inputFile);assert.equal(done.auto.attempt,0);assert.equal(f.calls().length,3);
 for(const call of f.calls()){assert.ok(call.input.includes(job.inputFile));assert.doesNotMatch(call.input,/LONG_BODY_HEAD|EXCLUDED_LARGE_TOOL/);}
 const rows=f.archived();assert.ok(rows.some(r=>r.text?.includes('EXCLUDED_LARGE_TOOL')));assert.ok(rows.some(r=>r.text?.includes('LONG_BODY_TAIL')));
});

for(const lang of ['en','zh-TW'])for(const kind of ['delivery-limit','delivery-maintenance'])test('selection keeps reservation after a delivery race independent of translated error: '+lang+'/'+kind,async t=>{
 const f=await fixture(t,lang,kind);fs.writeFileSync(f.fault,'hold at delivery');await f.begin();
 await wait(async()=>{const v=await f.view();return v.auto?.stage==='reserved'&&v.auto.reason;});
 const before=(await f.view()).auto;assert.equal(before.delegated,false);assert.equal(f.calls().length,0);
 if(kind==='delivery-limit')assert.doesNotMatch(before.reason,/上限中|待機/,'exercise the former Japanese-only failure path');
 await f.stop();await f.start();assert.equal((await f.view()).auto.stage,'reserved');
 fs.unlinkSync(f.fault);await f.begin();const done=await f.done();assert.equal(done.generation,2);assert.equal(done.auto.attempt,0);
 assert.deepEqual(f.calls().map(r=>r.ai),['claude']);
});
