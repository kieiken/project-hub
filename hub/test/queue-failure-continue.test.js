'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const journal=require('../lib/chat-continuation'),chat=require('../lib/chat'),spool=require('../lib/cli-spool');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-continue-'))),root=path.join(tmp,'root'),dir=path.join(root,'Product/Fixture');
const key={project:'Fixture',task:'chat'},pause=ms=>new Promise(r=>setTimeout(r,ms));let hub,base,ackTimer;
const post=async(route,body={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify({...key,...body})});return {status:r.status,body:await r.json()};};
const send=body=>post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'ORIGINAL full\nsecond line',...body});
const q=()=>hub.chats.queue(key.project,key.task),rows=()=>chat.read(dir,key.task),data=()=>journal.read(dir,key.task);
const wait=async fn=>{for(let n=0;n<400;n++){if(await fn())return;await pause(20);}const active=hub?.chats.busy(key.project,key.task);const info={queue:q(),journal:data(),rows:rows().slice(-8),handoff:hub.chats.handoffErrors(),active:active&&{finished:active.finished,spoolError:active.spoolError,request:active.options?.request,started:spool.read(active.child?.dir||tmp,'started.json'),failure:spool.failure(active.child?.dir||tmp)},spools:[...hub.chats.spoolRuns].map(c=>({dir:c.dir,failure:c.failure,started:spool.read(c.dir,'started.json'),end:spool.read(c.dir,'exit.json'),phase:spool.read(c.dir,'finalizing.json')}))};assert.fail('fixture timed out: '+JSON.stringify(info));};
async function queued(text){const r=await send({text,mode:'queue'});assert.equal(r.status,200,JSON.stringify(r));return r.body.id;}
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 fs.writeFileSync(path.join(dir,'.ai/tasks/chat.md'),'---\nid: chat\ntitle: chat\nowner: codex\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] fixture\n');
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const current=input.slice(input.lastIndexOf('# 今回の依頼\\n')+'# 今回の依頼\\n'.length);fs.appendFileSync(${JSON.stringify(path.join(tmp,'inputs'))},JSON.stringify(current)+'\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial result'}}));if(current.startsWith('ORIGINAL')||current.includes('first extra')&&!current.includes('second extra'))setInterval(()=>{},1000);else if(current.startsWith('FAIL')){const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(tmp,'fail-now'))})&&fs.existsSync(${JSON.stringify(path.join(tmp,'owned-'))}+process.pid)){clearInterval(t);console.error('fixture unexpected failure');process.exit(2);}},20);}else {const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(tmp,'owned-'))}+process.pid)){clearInterval(t);setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),120);}},20);}});process.on('SIGTERM',()=>process.exit(143));\n`,{mode:0o755});
 Object.assign(process.env,{PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_TRASH:path.join(tmp,'trash')});
 hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(0,'127.0.0.1',r));const port=hub.server.address().port;hub.stopControl.cleanExit();await new Promise(r=>hub.server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
 // A fast fixture waits for the supervisor's ownership acknowledgement before exiting.
 ackTimer=setInterval(()=>{const r=hub.chats.busy(key.project,key.task),started=r?.child?.dir&&spool.read(r.child.dir,'started.json');if(started?.identity)fs.writeFileSync(path.join(tmp,'owned-')+started.cliPid,'verified');},20);
});
test.beforeEach(async()=>{assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);});
test.afterEach(async()=>{await post('/api/chat/stop');await wait(()=>!hub.chats.busy(key.project,key.task));for(const x of q())hub.chats.unqueue(key.project,key.task,x.id);});
test.after(async()=>{clearInterval(ackTimer);await new Promise(r=>hub.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});

test('unfinished lookup rejects malformed containers and inherited ids without changing stored evidence',()=>{
 const pdir=path.join(tmp,'schema-fixture');journal.update(pdir,'existing',d=>{d.entries.record={id:'record',status:'open',updated:'revision'};});
 const f=journal.file(pdir,'existing'),bytes=fs.readFileSync(f,'utf8');
 for(const id of ['missing','__proto__','constructor'])assert.throws(()=>journal.resolve(pdir,'existing',{id,evidence:'fixture proof'}),/見つかりません/);
 assert.equal(fs.readFileSync(f,'utf8'),bytes);assert.equal(Object.prototype.status,undefined);
 assert.equal(journal.resolve(pdir,'existing',{id:'record',expectedUpdated:'revision',evidence:'fixture proof'}).status,'resolved');
 for(const d of [{version:1,entries:42,advances:{}},{version:1,entries:{},advances:true},null]){fs.writeFileSync(f,JSON.stringify(d));assert.throws(()=>journal.read(pdir,'existing'),/照合/);assert.match(journal.prompt(pdir,'existing'),/読めません/);}
});

test('late durable completion after a rejected amend continues once, merges full original, and links its continued record',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),first=await queued('FOLLOW-UP merged'),second=await queued('later FIFO');
 await wait(()=>source.texts.length>0);
 let release;const gate=new Promise(r=>release=r),oldSettled=hub.chats.onSettled,oldStop=hub.chats.stop;
 hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
 hub.chats.stop=async function(p,t,opts){if(opts?.interrupting){oldStop.call(this,p,t,opts).catch(()=>{});throw Error('fixture confirmation pending');}return oldStop.call(this,p,t,opts);};
 try{
  const response=await post('/api/chat/send',{fromQueue:first,mode:'amend'});assert.equal(response.status,409);assert.equal(response.body.queued,true);assert.equal(response.body.id,first);
  await wait(()=>data().entries[source.userRow.turn]);assert.equal(q()[0].id,first);assert.equal(rows().filter(x=>x.role==='user'&&x.request===first).length,0);
  release();await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===second));await wait(()=>!hub.chats.busy(key.project,key.task));
  assert.equal(rows().filter(x=>x.role==='user'&&x.request===first).length,1);assert.equal(rows().filter(x=>x.role==='user'&&x.request===second).length,1);assert.equal(q().length,0);
  const text=fs.readFileSync(path.join(tmp,'inputs'),'utf8');assert.match(text,/ORIGINAL full\\nsecond line/);assert.match(text,/FOLLOW-UP merged/);
  const e=data().entries[source.userRow.turn];assert.equal(e.original,'ORIGINAL full\nsecond line');assert.equal(e.partial,'partial result');assert.equal(e.status,'continued');assert.equal(e.result.request,first);assert.equal(e.source.spool,source.child.dir);
  assert.equal(Object.keys(data().entries).filter(x=>x===source.userRow.turn).length,1);assert.ok(proof(source));
 }finally{release?.();hub.chats.stop=oldStop;hub.chats.onSettled=oldSettled;}
});
function proof(run){return spool.read(run.child.dir,'finished.json')&&!spool.failure(run.child.dir);}

test('additional instruction and quick-add continue once after an exec/exit observation race and durable save',async()=>{
 for(const quick of [false,true]){
  assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task);await wait(()=>source.texts.length&&proofStarted(source));
  const id=quick?await queued('FOLLOW-UP quick-add race'):null,later=await queued('later FIFO after exec race');
  const control=require('../lib/stop-control'),original=control.terminate,oldSettled=hub.chats.onSettled;let release,observations=0;
  const gate=new Promise(r=>release=r);
  hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
  control.terminate=o=>{let cancelled=false;const child={...o.identity,pid:1234567,ppid:o.identity.pid,command:'fixture shell'};
   return original({...o,scan:()=>!cancelled?[o.identity,child]:++observations<3||!spool.read(source.child.dir,'exit.json')?[o.identity,{...child,command:'fixture exec'}]:[],cancel:s=>{cancelled=true;return o.cancel(s);},kill:()=>assert.fail('changed identity must not receive signals')});
  };
  try{
   let response;const request=(quick?post('/api/chat/send',{fromQueue:id,mode:'amend'}):send({text:'FOLLOW-UP direct race',mode:'amend'})).then(r=>response=r);
   await wait(()=>observations>=3&&data().entries[source.userRow.turn]);
   assert.equal(response,undefined);assert.equal(rows().some(x=>x.role==='user'&&(id?x.request===id:x.text==='FOLLOW-UP direct race')),false);
   release();await request;assert.equal(response.status,200,JSON.stringify(response));
   await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===later));await wait(()=>!hub.chats.busy(key.project,key.task));
   const next=data().advances[source.userRow.turn].id,users=rows().filter(x=>x.role==='user'&&[next,later].includes(x.request));
   assert.deepEqual(users.map(x=>x.request),[next,later]);assert.equal(users[0].model,'GPT-6.1-Sol');assert.equal(q().length,0);
   const e=data().entries[source.userRow.turn];assert.equal(e.original,'ORIGINAL full\nsecond line');assert.equal(e.partial,'partial result');assert.equal(e.status,'continued');assert.equal(e.result.request,next);
   const a=data().advances[source.userRow.turn];assert.equal(a.stopEvidence.state,'exited');assert.equal(a.stopVerified,true);assert.ok(proof(source));
  }finally{release?.();control.terminate=original;hub.chats.onSettled=oldSettled;}
 }
});

test('unexpected failure is kept once, follows FIFO without retrying the failed request, and is discoverable in the next prompt',async()=>{
 assert.equal((await send({text:'FAIL original exact\nline'})).status,200);const source=hub.chats.busy(key.project,key.task),a=await queued('first after failure'),b=await queued('second after failure');fs.writeFileSync(path.join(tmp,'fail-now'),'go');
 await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===b));await wait(()=>!hub.chats.busy(key.project,key.task));
 const e=data().entries[source.userRow.turn];assert.equal(e.status,'open');assert.equal(e.original,'FAIL original exact\nline');assert.match(e.reason,/fixture unexpected failure/);assert.equal(e.partial,'partial result');
 assert.deepEqual(rows().filter(x=>x.role==='user'&&[a,b].includes(x.request)).map(x=>x.request),[a,b]);assert.equal(rows().filter(x=>x.role==='user'&&x.turn===source.userRow.turn).length,1);assert.match(journal.prompt(dir,key.task),/返事の最後に未完の件数/);assert.match(journal.prompt(dir,key.task),/unfinished.json/);assert.equal(q().length,0);
});

test('redo records cancellation instead of another unfinished original',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task);await wait(()=>source.texts.length);const r=await send({text:'new replacement',mode:'redo'});assert.equal(r.status,200,JSON.stringify(r));await wait(()=>!hub.chats.busy(key.project,key.task));
 assert.equal(data().entries[source.userRow.turn].status,'cancelled');const input=fs.readFileSync(path.join(tmp,'inputs'),'utf8').trim().split('\n').map(JSON.parse).at(-1);assert.match(input,/前の指示を取り消し/);assert.doesNotMatch(input,/ORIGINAL full/);
});

test('human stop during a delayed cutover keeps the record and queue, without starting the successor',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),next=await queued('held successor');
 const old=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return old?.(o,r);};
 try{
  const request=post('/api/chat/send',{fromQueue:next,mode:'amend'});await wait(()=>source.interrupting);const stop=post('/api/chat/stop');await wait(()=>hub.stopControl.held(key));release();assert.equal((await stop).status,200);assert.equal((await request).status,409);await pause(100);
  assert.equal(rows().some(x=>x.role==='user'&&x.request===next),false);assert.ok(q().find(x=>x.id===next).stopHeld);assert.equal(data().entries[source.userRow.turn].status,'open');
 }finally{release?.();hub.chats.onSettled=old;}
});

test('repeated amendments keep one original record and never resolve it from an unrelated successor',async()=>{
 const before=Object.keys(data().entries);assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task);await wait(()=>source.texts.length);
 // Hold the first carried CLI's durable close while a second amendment is accepted.
 const originalSettled=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);
 hub.chats.onSettled=async(o,r)=>{if(o.unfinishedId===source.userRow.turn)await gate;return originalSettled?.(o,r);};
 try{
  const first=await send({text:'first extra',mode:'amend'});assert.equal(first.status,200,JSON.stringify(first));
  const carried=hub.chats.busy(key.project,key.task);assert.equal(carried.options.unfinishedId,source.userRow.turn);await wait(()=>carried.texts.length&&spool.read(carried.child.dir,'started.json')?.identity);
  let answer;const second=send({text:'second extra',mode:'amend'}).then(r=>answer=r);await wait(()=>carried.interrupting||answer);assert.ok(carried.interrupting,JSON.stringify(answer));release();assert.equal((await second).status,200,JSON.stringify(answer));
  await wait(()=>!hub.chats.busy(key.project,key.task));assert.deepEqual(Object.keys(data().entries).filter(x=>!before.includes(x)),[source.userRow.turn]);assert.equal(data().entries[source.userRow.turn].status,'continued');
  assert.ok(data().entries[source.userRow.turn].interruptions.some(x=>x.source.turn===carried.userRow.turn));
 }finally{release?.();hub.chats.onSettled=originalSettled;}
});

test('cold boot recovers a proven pending switch once; a second boot does not replay it',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),next=await queued('after clean restart');await wait(()=>source.texts.length);
 hub.chats.prepareSwitch(key.project,key.task,next,'amend',hub.stopControl.ticket(key));const dispatch=hub.chats.dispatchAdvance;
 hub.chats.dispatchAdvance=()=>true;
 try{const stopped=await hub.chats.stop(key.project,key.task,{interrupting:true});await wait(()=>proof(source));assert.equal(stopped.state,'exited');}
 finally{hub.chats.dispatchAdvance=dispatch;}
 journal.update(dir,key.task,d=>{d.advances[source.userRow.turn].stopVerified=true;});
 async function reboot(){hub.stopControl.cleanExit();await new Promise(r=>hub.server.close(r));delete require.cache[require.resolve('../server')];hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));}
 await reboot();await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===next));await wait(()=>!hub.chats.busy(key.project,key.task));assert.equal(q().length,0);assert.equal(rows().filter(x=>x.role==='user'&&x.request===next).length,1);
 await reboot();await pause(120);assert.equal(rows().filter(x=>x.role==='user'&&x.request===next).length,1);assert.equal(data().entries[source.userRow.turn].status,'continued');
});

test('completion lookup requires evidence and a fresh revision; corrupt records fail closed',async()=>{
 const e=Object.values(data().entries).find(x=>x.status==='open');assert.ok(e);
 const original=fs.readFileSync(journal.file(dir,key.task),'utf8');
 assert.equal((await post('/api/chat/unfinished/resolve',{id:e.id,expectedUpdated:e.updated,evidence:''})).status,409);
 assert.equal((await post('/api/chat/unfinished/resolve',{id:e.id,expectedUpdated:'old',evidence:'fixture saved result'})).status,409);
 const r=await post('/api/chat/unfinished/resolve',{id:e.id,expectedUpdated:e.updated,evidence:'fixture saved result; original turn checked'});assert.equal(r.status,200);assert.equal(r.body.entry.status,'resolved');assert.match(r.body.entry.resolution.evidence,/original turn checked/);
 fs.writeFileSync(journal.file(dir,key.task),'{');try{assert.match(journal.prompt(dir,key.task),/読めません/);assert.throws(()=>hub.chats.continuationOptions({...key,pdir:dir,request:'old'}));}finally{fs.writeFileSync(journal.file(dir,key.task),original);}
});

test('edits after a rejected cutover are authoritative, and a racing manual begin cannot start twice',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),next=await queued('before edit');await wait(()=>source.texts.length);
 const oldStop=hub.chats.stop,oldSettled=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);
 hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
 hub.chats.stop=function(p,t,opts){if(opts?.interrupting){oldStop.call(this,p,t,opts).catch(()=>{});return Promise.reject(Error('fixture pending save'));}return oldStop.call(this,p,t,opts);};
 try{
  const r=await post('/api/chat/send',{fromQueue:next,mode:'amend'});assert.equal(r.body.queued,true);
  assert.equal((await post('/api/chat/queue/edit',{id:next,text:'edited after refusal',expectedText:'before edit'})).status,200);
  release();const manual=post('/api/chat/send',{fromQueue:next});await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===next));await manual;
  await wait(()=>!hub.chats.busy(key.project,key.task));assert.equal(rows().filter(x=>x.role==='user'&&x.request===next).length,1);assert.equal(rows().find(x=>x.role==='user'&&x.request===next).text,'edited after refusal');
 }finally{release?.();hub.chats.stop=oldStop;hub.chats.onSettled=oldSettled;}
});

test('cancelled cutover text stays cancelled while the remaining FIFO continues and the original stays open',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),cancel=await queued('cancel this explanation'),next=await queued('remaining after cancellation');await wait(()=>source.texts.length);
 const oldStop=hub.chats.stop,oldSettled=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);
 hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
 hub.chats.stop=function(p,t,opts){if(opts?.interrupting){oldStop.call(this,p,t,opts).catch(()=>{});return Promise.reject(Error('fixture pending save'));}return oldStop.call(this,p,t,opts);};
 try{
  assert.equal((await post('/api/chat/send',{fromQueue:cancel,mode:'amend'})).status,409);
  assert.equal((await post('/api/chat/unqueue',{id:cancel})).status,200);release();
  await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===next));await wait(()=>!hub.chats.busy(key.project,key.task));
  assert.equal(rows().some(x=>x.role==='user'&&x.request===cancel),false);assert.equal(data().entries[source.userRow.turn].status,'open');
  const last=fs.readFileSync(path.join(tmp,'inputs'),'utf8').trim().split('\n').map(JSON.parse).at(-1);assert.equal(last,'remaining after cancellation');assert.equal(q().length,0);
 }finally{release?.();hub.chats.stop=oldStop;hub.chats.onSettled=oldSettled;}
});

test('cancelled redo input leaves the original cancelled while continuing the other queued work',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),cancel=await queued('cancel replacement'),next=await queued('other queued work');await wait(()=>source.texts.length);
 hub.chats.prepareSwitch(key.project,key.task,cancel,'redo',hub.stopControl.ticket(key));
 const old=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return old?.(o,r);};
 try{const stop=hub.chats.stop(key.project,key.task,{interrupting:true});await wait(()=>data().entries[source.userRow.turn]);hub.chats.unqueue(key.project,key.task,cancel);release();await stop;
  await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===next));await wait(()=>!hub.chats.busy(key.project,key.task));assert.equal(data().entries[source.userRow.turn].status,'cancelled');assert.equal(rows().some(x=>x.role==='user'&&x.request===cancel),false);
 }finally{release?.();hub.chats.onSettled=old;}
});

test('unknown stop ownership holds the queue; amended attachment references merge without changing cancellation semantics',async()=>{
 const pdir=path.join(tmp,'owner-fixture'),a={source:{turn:'source',entryId:'source'},id:'next',mode:'amend',phase:'waiting'};journal.update(pdir,'chat',d=>{d.advances.source=a;});
 const runner=new chat.ChatRunner();let starts=0;runner.sendQueued=()=>{starts++;};
 await assert.rejects(runner.launchAdvance({...a,liveRun:{stopResultP:Promise.resolve({state:'ownership-unknown',save:'saved'})}},{...key,pdir}),/所有/);assert.equal(starts,0);assert.equal(journal.read(pdir,'chat').advances.source.phase,'blocked');
 // Use an independently finished source and a request never started before:
 // a completed request now correctly fails the shared replay guard.
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task);await wait(()=>source.texts.length&&proofStarted(source));
 assert.equal((await hub.chats.stop(key.project,key.task,{interrupting:true})).state,'exited');await wait(()=>proof(source)&&!hub.chats.busy(key.project,key.task));
 const proven={source:journal.source(source.options,source),id:'unsent-attachment-check',mode:'amend',phase:'waiting',stopVerified:true};assert.ok(journal.proven(proven.source));
 journal.update(dir,key.task,()=>{}); // This case can also run by itself without prior journal-producing tests.
 const snapshot=fs.readFileSync(journal.file(dir,key.task),'utf8');
 journal.update(dir,key.task,d=>{d.advances[proven.source.turn]={...proven,source:{...proven.source,images:['/fixture/original.png']}};});
 try{const o=hub.chats.continuationOptions({...key,pdir:dir,request:proven.id,text:'extra',images:['/fixture/next.png']});assert.deepEqual(o.images,['/fixture/original.png','/fixture/next.png']);}
 finally{fs.writeFileSync(journal.file(dir,key.task),snapshot);}
});

test('model edit after a rejected cutover reaches the delayed amend once with the latest pinned model',async()=>{
 const command=path.join(tmp,'bin/claude');fs.writeFileSync(command,`#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(path.join(tmp,'edited-claude-input'))},input);fs.writeFileSync(${JSON.stringify(path.join(tmp,'edited-claude-args'))},JSON.stringify(process.argv.slice(2)));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(tmp,'owned-'))}+process.pid)){clearInterval(timer);console.log(JSON.stringify({type:'result',result:'edited model finished',is_error:false}));}},20);});process.on('SIGTERM',()=>process.exit(143));\n`,{mode:0o755});
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),id=await queued('before model edit');await wait(()=>source.texts.length&&proofStarted(source));
 hub.chats.setQueue(key.project,key.task,q().map(x=>x.id===id?{...x,role:'チェック',limitSlot:'backup',requireModel:true,requiredModel:'gpt-6.1-sol'}:x),true);
 const oldStop=hub.chats.stop,oldSettled=hub.chats.onSettled;let release;const gate=new Promise(r=>release=r);
 hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
 hub.chats.stop=function(p,t,opts){if(opts?.interrupting){oldStop.call(this,p,t,opts).catch(()=>{});return Promise.reject(Error('fixture pending save'));}return oldStop.call(this,p,t,opts);};
 try{
  assert.equal((await post('/api/chat/send',{fromQueue:id,mode:'amend'})).body.queued,true);
  const before=q().find(x=>x.id===id),edit=await post('/api/chat/queue/edit',{id,text:'FOLLOW-UP edited model',expectedText:before.text,expectedItem:JSON.stringify(before),ai:'claude',model:'claude-fable-5-2'});assert.equal(edit.status,200,JSON.stringify(edit));
  const saved=q().find(x=>x.id===id);assert.equal(saved.requiredModel,'claude-fable-5-2');assert.equal(saved.limitSlot,'main');release();const manual=post('/api/chat/send',{fromQueue:id,expectedItem:JSON.stringify(saved)});
  await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===id));await manual;await wait(()=>!hub.chats.busy(key.project,key.task));
  const users=rows().filter(x=>x.role==='user'&&x.request===id);assert.equal(users.length,1);assert.equal(users[0].to,'claude');assert.equal(users[0].model,'Fable 5.2');assert.match(users[0].text,/FOLLOW-UP edited model/);
  const input=fs.readFileSync(path.join(tmp,'edited-claude-input'),'utf8');assert.match(input,/ORIGINAL full\nsecond line/);assert.match(input,/FOLLOW-UP edited model/);const args=JSON.parse(fs.readFileSync(path.join(tmp,'edited-claude-args'),'utf8'));assert.equal(args[args.indexOf('--model')+1],'claude-fable-5-2');
 }finally{release?.();hub.chats.stop=oldStop;hub.chats.onSettled=oldSettled;}
});
function proofStarted(run){return spool.read(run.child.dir,'started.json')?.identity;}

test('review R1: final FIFO and cancelled cutover choices never replay a durable failed or unknown start',async()=>{
 for(const mode of ['fifo','amend','redo'])for(const outcome of ['failed','unknown']){
  const pdir=path.join(tmp,`review-start-${mode}-${outcome}`),b={...key,pdir,dir:pdir},runner=new chat.ChatRunner({dirOf:()=>pdir});
  const a={source:{turn:'original',entryId:'original',request:'source-request',pdir,task:key.task,stopVersion:0},mode,phase:'waiting',...(mode==='fifo'?{}:{id:'cancelled',stopVerified:true})};
  journal.update(pdir,key.task,d=>{d.entries.original={id:'original',status:mode==='redo'?'cancelled':'waiting',updated:'revision-1',original:'exact original',partial:'saved partial'};d.advances.original=a;});
  chat.append(pdir,key.task,{role:'user',turn:'attempted-turn',request:'attempted',text:'already attempted'});
  if(outcome==='failed')chat.append(pdir,key.task,{role:'assistant',request:'attempted',error:'previous start failed',text:''});
  const pending=[{id:'attempted',text:'already attempted',ai:'codex',model:'gpt-6.1-sol'},{id:'later',text:'must remain queued',ai:'codex',model:'gpt-6.1-sol'}];
  const sourcePending=mode==='fifo'?[{id:'source-request',text:'failed source',ai:'codex',model:'gpt-6.1-sol'}]:[];
  if(sourcePending.length)chat.append(pdir,key.task,{role:'user',turn:'original',request:'source-request',text:'failed source'});
  runner.setQueue(key.project,key.task,[...sourcePending,...pending]);
  let starts=0;runner.run=()=>{starts++;return {startedP:Promise.resolve(true)};};
  // sendQueued/send remain real; no process is created at the final run boundary.
  await assert.rejects(runner.launchAdvance({...a,liveFinished:true},b),/開始記録/);
  assert.equal(starts,0,`${mode}/${outcome}`);assert.deepEqual(runner.queue(key.project,key.task),pending);
  const saved=journal.read(pdir,key.task);assert.equal(saved.advances.original.phase,'started');assert.equal(saved.advances.original.id,'attempted');
  assert.equal(saved.entries.original.status,mode==='redo'?'cancelled':'open');
  const reboot=new chat.ChatRunner({dirOf:()=>pdir});reboot.setQueue(key.project,key.task,pending);reboot.run=runner.run;
  await assert.rejects(reboot.launchAdvance({...saved.advances.original,liveFinished:true},b),/既に/);assert.equal(starts,0);
 }
});

test('review R1: a fresh final FIFO choice still starts once through the existing send guards',async()=>{
 for(const mode of ['fifo','amend','redo']){
  const pdir=path.join(tmp,'review-fresh-'+mode),b={...key,pdir,dir:pdir},runner=new chat.ChatRunner({dirOf:()=>pdir});
  const a={source:{turn:'original',entryId:'original',request:'source-request',pdir,task:key.task,stopVersion:0},mode,phase:'waiting',...(mode==='fifo'?{}:{id:'cancelled',stopVerified:true})};
  journal.update(pdir,key.task,d=>{d.entries.original={id:'original',status:mode==='redo'?'cancelled':'waiting',updated:'revision-1'};d.advances.original=a;});
  runner.setQueue(key.project,key.task,[{id:'fresh',text:'fresh request',ai:'codex',model:'gpt-6.1-sol'},{id:'later',text:'later request',ai:'codex',model:'gpt-6.1-sol'}]);
  let starts=0;runner.run=()=>{starts++;return {startedP:Promise.resolve(true)};};
  const first=runner.launchAdvance({...a,liveFinished:true},b),second=runner.launchAdvance({...a,liveFinished:true},b);assert.equal(first,second);
  await Promise.all([first,second]);assert.equal(starts,1);assert.deepEqual(runner.queue(key.project,key.task).map(x=>x.id),['later']);
  assert.equal(chat.read(pdir,key.task).filter(x=>x.role==='user'&&x.request==='fresh').length,1);assert.equal(journal.read(pdir,key.task).advances.original.phase,'started');
 }
});

test('review R2: successful carried close preserves an explicit resolution and cancellation revisions',()=>{
 for(const status of ['resolved','cancelled','resuming']){
  const pdir=path.join(tmp,'review-close-'+status),o={...key,pdir,dir:pdir,request:'carried',unfinishedId:'original',text:'original and extra'};
  const run={userRow:{turn:'carried-turn',at:'fixture'},child:{},spawned:true,stopped:false};
  journal.update(pdir,key.task,d=>{d.entries.original={id:'original',status:'resuming',original:'exact original',partial:'saved partial',updated:'revision-1'};});
  if(status==='resolved')journal.resolve(pdir,key.task,{id:'original',expectedUpdated:'revision-1',evidence:'checked saved artifact; fixture reference'});
  if(status==='cancelled')journal.update(pdir,key.task,d=>{d.entries.original.status='cancelled';});
  const before=journal.read(pdir,key.task).entries.original;
  journal.methods.saveUnfinished.call({},o,run,{text:'close receipt',error:''},true,false);
  const e=journal.read(pdir,key.task).entries.original;
  if(status==='resuming'){assert.equal(e.status,'continued');assert.equal(e.resolution,undefined);assert.equal(e.original,before.original);assert.equal(e.partial,before.partial);assert.equal(e.result.request,'carried');}
  else assert.deepEqual(e,before,'a close receipt cannot revoke explicit terminal state');
 }
});

test('review R2: failed or interrupted carried work reopens resolved work but keeps a cancellation',()=>{
 for(const status of ['resolved','cancelled'])for(const interrupted of [false,true]){
  const pdir=path.join(tmp,`review-reopen-${status}-${interrupted}`),o={...key,pdir,dir:pdir,request:'carried',unfinishedId:'original',text:'original and extra'};
  const run={userRow:{turn:'carried-turn',at:'fixture'},child:{},spawned:true,stopped:interrupted};
  journal.update(pdir,key.task,d=>{d.entries.original={id:'original',status:'resuming',original:'exact original',partial:'saved partial',updated:'revision-1'};});
  journal.resolve(pdir,key.task,{id:'original',expectedUpdated:'revision-1',evidence:'checked artifact'});
  journal.update(pdir,key.task,d=>{if(status==='cancelled')d.entries.original.status='cancelled';if(interrupted)d.advances['carried-turn']={source:{turn:'carried-turn'},mode:'amend',id:'extra',phase:'waiting'};});
  const before=journal.read(pdir,key.task).entries.original;
  journal.methods.saveUnfinished.call({},o,run,{text:'partial again',error:'interrupted or failed'},false,false);
  const e=journal.read(pdir,key.task).entries.original;assert.equal(e.status,status==='cancelled'?'cancelled':interrupted?'waiting':'open');
  if(status==='cancelled')assert.equal(e.updated,before.updated);assert.deepEqual(e.resolution,before.resolution);assert.equal(e.original,'exact original');
 }
});

test('review R3: invalid identity, state or revision and absent expected revisions leave the journal unchanged',async()=>{
 const pdir=path.join(tmp,'review-record-validity'),task='existing',valid={version:1,entries:{record:{id:'record',status:'open',updated:'revision-1',original:'exact original'}},advances:{}};
 journal.update(pdir,task,d=>Object.assign(d,valid));const f=journal.file(pdir,task);
 const invalid=[{id:undefined},{id:'another'},{id:7},{status:undefined},{status:'unknown'},{status:[]},{updated:undefined},{updated:null},{updated:''},{updated:' '},{updated:[]},{status:'resolved'},{status:'resolved',resolution:{evidence:'proof',at:'other revision'}}];
 for(const patch of invalid){
  const broken=JSON.parse(JSON.stringify(valid));Object.assign(broken.entries.record,patch);fs.writeFileSync(f,JSON.stringify(broken));const original=fs.readFileSync(f,'utf8');
  assert.throws(()=>journal.read(pdir,task),/照合/);assert.match(journal.prompt(pdir,task),/読めません/);
  assert.throws(()=>journal.resolve(pdir,task,{id:'record',expectedUpdated:patch.updated,evidence:'fixture proof'}));
  const runner=new chat.ChatRunner();let starts=0;runner.run=()=>{starts++;return {startedP:Promise.resolve(true)};};
  await assert.rejects(runner.sendQueued({...key,task,pdir,dir:pdir,request:'next',ai:'codex',model:'gpt-6.1-sol',text:'must stay held'}),/照合/);
  assert.equal(starts,0);assert.equal(fs.readFileSync(f,'utf8'),original);
 }
 fs.writeFileSync(f,JSON.stringify(valid));const original=fs.readFileSync(f,'utf8');
 for(const expectedUpdated of [undefined,null,'',' ',42,'old']){
  assert.throws(()=>journal.resolve(pdir,task,{id:'record',expectedUpdated,evidence:'fixture proof'}),/変わりました/);assert.equal(fs.readFileSync(f,'utf8'),original);
 }
 for(const id of [undefined,'','missing','__proto__','constructor'])assert.throws(()=>journal.resolve(pdir,task,{id,expectedUpdated:'revision-1',evidence:'fixture proof'}),/見つかりません/);
 const e=journal.resolve(pdir,task,{id:'record',expectedUpdated:'revision-1',evidence:' fixture checked artifact '});assert.equal(e.status,'resolved');assert.equal(e.resolution.evidence,'fixture checked artifact');assert.equal(e.updated,e.resolution.at);
});

test('held recovery HTTP: manual begin of an observed blocked cutover starts once and leaves FIFO intact',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),id=await queued('FOLLOW-UP blocked manual recovery'),later=await queued('later FIFO after blocked manual');
 await wait(()=>source.texts.length&&proofStarted(source));hub.chats.prepareSwitch(key.project,key.task,id,'amend',hub.stopControl.ticket(key));
 const dispatch=hub.chats.dispatchAdvance;hub.chats.dispatchAdvance=()=>true;let stopped;
 try{stopped=await hub.chats.stop(key.project,key.task,{interrupting:true});await wait(()=>proof(source)&&!hub.chats.busy(key.project,key.task));}finally{hub.chats.dispatchAdvance=dispatch;}
 assert.equal(stopped.observationComplete,true);
 journal.update(dir,key.task,d=>{Object.assign(d.advances[source.userRow.turn],{phase:'blocked',stopEvidence:{...stopped,state:'ownership-unknown',errors:['fixture late exit observation']}});});
 const before=data().advances[source.userRow.turn];assert.equal(before.stopVerified,undefined);
 const results=await Promise.all([post('/api/chat/send',{fromQueue:id}),post('/api/chat/send',{fromQueue:id})]);assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
 await wait(()=>rows().some(x=>x.role==='assistant'&&x.request===later));await wait(()=>!hub.chats.busy(key.project,key.task));
 const users=rows().filter(x=>x.role==='user'&&[id,later].includes(x.request));assert.deepEqual(users.map(x=>x.request),[id,later]);
 const input=fs.readFileSync(path.join(tmp,'inputs'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(input.some(x=>x.includes('ORIGINAL full\nsecond line')&&x.includes('FOLLOW-UP blocked manual recovery')));
 assert.equal(data().entries[source.userRow.turn].original,'ORIGINAL full\nsecond line');assert.deepEqual(data().advances[source.userRow.turn].stopEvidence,before.stopEvidence);assert.equal(q().length,0);
 assert.equal((await post('/api/chat/send',{fromQueue:id})).status,404);
});

test('merge retreat: saved successor is fenced during delayed amend completion and original stays unfinished',async()=>{
 const {version}=require('../lib/queue-retreat');assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),id=await queued('park this additional explanation'),other=await queued('independent waiting request');await wait(()=>source.texts.length>0);
 let release;const gate=new Promise(r=>release=r),oldSettled=hub.chats.onSettled,oldStop=hub.chats.stop,oldFault=hub.queueRetreat.fault;
 hub.chats.onSettled=async(o,r)=>{if(o.userRow?.turn===source.userRow.turn)await gate;return oldSettled?.(o,r);};
 hub.chats.stop=async function(p,t,opts){if(opts?.interrupting){oldStop.call(this,p,t,opts).catch(()=>{});throw Error('fixture delayed confirmation');}return oldStop.call(this,p,t,opts);};
 const retreat=async b=>{const r=await fetch(base+'/api/chat/queue/retreat',{method:'POST',headers:{'X-Hub':'1','X-Hub-UI':'queue','Content-Type':'application/json',Origin:base},body:JSON.stringify(b)});return {status:r.status,body:await r.json()};};
 try{
  const switched=await post('/api/chat/send',{fromQueue:id,mode:'amend'});assert.equal(switched.status,409);assert.equal(switched.body.queued,true);await wait(()=>data().entries[source.userRow.turn]);
  const before=q(),item=before.find(x=>x.id===id),attempt={...key,id,opId:require('node:crypto').randomUUID(),expected:version(item)};hub.queueRetreat.fault=stage=>{if(stage==='saved')throw Error('fixture receipt saved');};assert.equal((await retreat(attempt)).status,503);
  release();await wait(()=>source.finished);await wait(()=>data().advances[source.userRow.turn].phase==='blocked');assert.equal(rows().filter(x=>x.role==='user'&&x.request===id).length,0);assert.equal(data().entries[source.userRow.turn].status,'open');assert.deepEqual(q().map(x=>x.id),[id,other]);
  assert.throws(()=>hub.chats.unqueue(key.project,key.task,id),e=>e.code==='queue-retreat');await assert.rejects(hub.chats.sendQueued({...key,pdir:dir,request:id}),e=>e.code==='queue-retreat');hub.queueRetreat.fault=oldFault;
  const result=await retreat(attempt);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.complete,true);assert.equal((await retreat(attempt)).body.id,result.body.id);assert.deepEqual(q().map(x=>x.id),[other]);assert.equal(hub.ideas.read(key.project).items[result.body.id].intent,'record');assert.equal(rows().filter(x=>x.role==='user'&&x.request===id).length,0);assert.equal(data().entries[source.userRow.turn].status,'open');
 }finally{release?.();hub.chats.stop=oldStop;hub.chats.onSettled=oldSettled;hub.queueRetreat.fault=oldFault;}
});

// A quarantined close deliberately fences this server; keep this fault-injection case last.
test('a failed unfinished-record write prevents automatic continuation and quarantines the close',async()=>{
 assert.equal((await send({})).status,200);const source=hub.chats.busy(key.project,key.task),next=await queued('must not launch'),f=journal.file(dir,key.task),open=fs.openSync;await wait(()=>source.texts.length);
 hub.chats.prepareSwitch(key.project,key.task,next,'amend',hub.stopControl.ticket(key));
 fs.openSync=function(name,...args){if(String(name)===f+'.tmp'&&args[0]==='wx')throw Error('fixture unfinished disk failure');return open.call(this,name,...args);};
 try{await assert.rejects(hub.chats.stop(key.project,key.task,{interrupting:true}),/終了・保存/);assert.match(source.spoolError,/unfinished disk failure/);assert.equal(rows().some(x=>x.role==='user'&&x.request===next),false);assert.ok(q().some(x=>x.id===next));}
 finally{fs.openSync=open;}
 // Restore only the isolated close using its existing recovery proof, never replay its AI.
 const issue=hub.chats.handoffErrors().find(x=>x.run===path.basename(source.child.dir));assert.ok(issue);
 assert.equal(issue.recovery,'not-sent');
 // This fixture ends here; abandon its in-memory failed run so cleanup cannot signal anything else.
 source.child.pause();hub.chats.running.delete(hub.chats.key(key.project,key.task));hub.chats.spoolRuns.delete(source.child);hub.chats.endGate?.(source.options);
});
