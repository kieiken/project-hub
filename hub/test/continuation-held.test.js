'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const journal=require('../lib/chat-continuation'),chat=require('../lib/chat'),spool=require('../lib/cli-spool'),P=require('../lib/owned-processes');
const key={project:'Fixture',task:'held'},identity={pid:987601,ppid:987600,pgid:987601,uid:process.getuid?.(),since:'Fri Oct 16 12:00:00 2026',command:'fixture CLI'};
function fixture(t){
 const pdir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-held-'))),b={...key,pdir,dir:pdir},runner=new chat.ChatRunner({dirOf:()=>pdir});
 const scan=P.snapshot;P.snapshot=()=>[];t.after(()=>{P.snapshot=scan;fs.rmSync(pdir,{recursive:true,force:true});});
 let starts=0,input;runner.run=o=>{starts++;input=o;return {startedP:Promise.resolve(true)};};
 const queue=[{id:'next',text:'EDITED extra',ai:'codex',model:'gpt-6.1-sol',effort:'high',images:['/fixture/edited.png']},{id:'later',text:'later FIFO',ai:'codex',model:'gpt-6.1-sol'}];runner.setQueue(key.project,key.task,queue);
 function advance(turn,{verified=false,mode='amend',text=turn,observed=[identity],state='ownership-unknown'}={}){
  const dir=path.join(pdir,turn);fs.mkdirSync(dir);const s={...b,turn,entryId:turn,spool:dir,text,images:['/fixture/'+turn+'.png'],stopVersion:0,stopTicket:{epoch:0,task:0}};
  const owner={pid:process.pid,serverId:runner.serverId,generation:1,released:false};
  spool.atomic(dir,'owner.json',owner);spool.atomic(dir,'request.json',{options:{...b,userRow:{turn}}});
  spool.atomic(dir,'started.json',{identity,cliPid:identity.pid,supervisorPid:identity.ppid});spool.atomic(dir,'exit.json',{code:null,signal:'SIGTERM'});
  const row=chat.append(pdir,key.task,{role:'assistant',text:'saved partial '+turn,spoolId:path.basename(dir)+':final'});
  spool.atomic(dir,'finalizing.json',{stage:'finished',generation:1,finalRowHash:spool.digest(JSON.stringify(row))});new spool.SpoolChild(dir,owner).finish();
  const a={source:s,id:'next',mode,phase:'blocked',stopVerified:verified,reason:'old stop warning',stopEvidence:{state,save:'saved',errors:['identity changed'],...(observed?{identity,observed,observationComplete:true}:{})}};
  journal.update(pdir,key.task,d=>{d.entries[turn]={id:turn,status:mode==='redo'?'cancelled':'open',updated:'revision',original:text,partial:'saved partial '+turn};d.advances[turn]=a;});assert.equal(journal.proven(s),true);return a;
 }
 return {b,runner,advance,queue,starts:()=>starts,input:()=>input,start:()=>runner.sendQueued({...b,...queue[0],request:'next',shown:queue[0].text})};
}
test('held recovery: manual start rechecks recorded descendants and preserves edits and FIFO once',async t=>{
 const f=fixture(t),a=f.advance('original',{text:'ORIGINAL full\nsecond line'}),before=journal.read(f.b.pdir,key.task);
 const r=await f.start();assert.equal(await r.started,true);assert.equal(f.starts(),1);assert.match(f.input().text,/ORIGINAL full\nsecond line/);assert.match(f.input().text,/EDITED extra/);assert.equal(f.input().effort,'high');
 assert.deepEqual(f.input().images,['/fixture/original.png','/fixture/edited.png']);assert.equal(f.input().unfinishedId,a.source.turn);assert.deepEqual(f.runner.queue(key.project,key.task),f.queue);
 const after=journal.read(f.b.pdir,key.task);assert.deepEqual(after,before);assert.equal(chat.read(f.b.pdir,key.task).filter(r=>r.role==='user'&&r.request==='next').length,1);
 await assert.rejects(f.start(),/開始記録|既に/);assert.equal(f.starts(),1);
});
test('held recovery: three cutovers for one id keep all source instructions and latest queue selection',async t=>{
 const f=fixture(t);f.advance('first',{text:'ORIGINAL exact'});f.advance('second',{verified:true,text:'second intervening instruction'});f.advance('third',{verified:true,text:'third intervening instruction'});
 const r=await f.start();assert.equal(await r.started,true);assert.equal(f.starts(),1);
 const o=f.input();for(const text of ['ORIGINAL exact','second intervening instruction','third intervening instruction','EDITED extra'])assert.equal(o.text.split(text).length,2,text);
 assert.equal(o.model,'gpt-6.1-sol');assert.equal(o.unfinishedId,'first');assert.deepEqual(o.images,['/fixture/first.png','/fixture/second.png','/fixture/third.png','/fixture/edited.png']);
 assert.deepEqual(Object.values(journal.read(f.b.pdir,key.task).advances).map(a=>a.phase),['blocked','blocked','blocked']);
});
test('held recovery: live late close records observation and uses the latest switch once',async t=>{
 const f=fixture(t);f.advance('first',{text:'original'});const a=f.advance('latest',{text:'intervening'});
 journal.update(f.b.pdir,key.task,d=>{d.advances.latest.phase='waiting';});
 const result={...a.stopEvidence,save:'unconfirmed'};
 const x=f.runner.launchAdvance({...a,liveRun:{stopResultP:Promise.resolve(result)}},f.b),y=f.runner.launchAdvance({...a,liveRun:{stopResultP:Promise.resolve(result)}},f.b);assert.equal(x,y);
 assert.equal(await (await x).started,true);assert.equal(f.starts(),1);assert.deepEqual(f.runner.queue(key.project,key.task).map(x=>x.id),['later']);
 const d=journal.read(f.b.pdir,key.task);assert.equal(d.advances.latest.stopVerified,true);assert.deepEqual(d.advances.latest.stopEvidence.observed,result.observed);assert.equal(d.advances.first.phase,'blocked');assert.match(f.input().text,/original/);assert.match(f.input().text,/intervening/);
});
test('held recovery: remaining or reused descendant and its process group block every same-id cutover',async t=>{
 const f=fixture(t),child={...identity,pid:987602,ppid:identity.pid,pgid:987602,command:'fixture child'};
 f.advance('first',{observed:[identity,child]});f.advance('latest',{verified:true});
 const before=fs.readFileSync(journal.file(f.b.pdir,key.task),'utf8');
 for(const rows of [[{...child,ppid:1}],[{...child,ppid:1,since:'new PID generation',command:'reused'}],[{...child,pid:987603,ppid:1}]]){
  P.snapshot=()=>rows;await assert.rejects(f.start(),/子プロセスが残/);assert.equal(f.starts(),0);assert.equal(f.runner.busy(key.project,key.task),null);assert.equal(fs.readFileSync(journal.file(f.b.pdir,key.task),'utf8'),before);
 }
});
test('held recovery R1: late descendants stay observed after reparenting and restart until all disappear',async t=>{
 const f=fixture(t),child={...identity,pid:987602,ppid:identity.pid,pgid:987602,command:'held child'},grandchild={...identity,pid:987603,ppid:child.pid,pgid:987603,command:'late grandchild'},great={...identity,pid:987604,ppid:grandchild.pid,pgid:987604,command:'late great grandchild'};
 f.advance('source',{observed:[identity,child]});f.advance('latest',{verified:true,text:'intervening instruction'});
 journal.update(f.b.pdir,key.task,d=>{d.advances.source.stopEvidence.tracked=[identity];});
 const before=journal.read(f.b.pdir,key.task);
 // Reverse process-table order also requires the full positive descendant chain.
 P.snapshot=()=>[great,grandchild,{...child,ppid:1}];
 await assert.rejects(f.start(),/子プロセスが残/);assert.equal(f.starts(),0);
 const saved=journal.read(f.b.pdir,key.task);assert.deepEqual(saved.advances.source.stopEvidence.observed,[identity,child,grandchild,great]);
 const expected=structuredClone(before);expected.advances.source.stopEvidence.observed.push(grandchild,great);assert.deepEqual(saved,expected);
 // A fresh runner has no memory of the failed attempt; only the saved observation can hold it.
 const restarted=new chat.ChatRunner({dirOf:()=>f.b.pdir});restarted.setQueue(key.project,key.task,f.queue);let starts=0,input;
 restarted.run=o=>{starts++;input=o;return {startedP:Promise.resolve(true)};};
 const start=()=>restarted.sendQueued({...f.b,...f.queue[0],request:'next',shown:f.queue[0].text});
 P.snapshot=()=>[{...great,ppid:1,since:'changed generation',command:'changed command'}];
 await assert.rejects(start(),/子プロセスが残/);assert.equal(starts,0);assert.deepEqual(journal.read(f.b.pdir,key.task),saved);
 P.snapshot=()=>[{...great,pid:987605,ppid:1}];await assert.rejects(start(),/子プロセスが残/);assert.equal(starts,0);assert.deepEqual(journal.read(f.b.pdir,key.task),saved);
 P.snapshot=()=>[];assert.equal(await (await start()).started,true);assert.equal(starts,1);
 assert.match(input.text,/source/);assert.match(input.text,/intervening instruction/);assert.match(input.text,/EDITED extra/);assert.equal(input.model,'gpt-6.1-sol');assert.equal(input.effort,'high');
 assert.deepEqual(input.images,['/fixture/source.png','/fixture/latest.png','/fixture/edited.png']);assert.deepEqual(restarted.queue(key.project,key.task),f.queue);
 await assert.rejects(start(),/開始記録|既に/);assert.equal(starts,1);
});
test('held recovery R1: each later observation extends the saved chain without signals or unrelated ownership',async t=>{
 const f=fixture(t),child={...identity,pid:987602,ppid:identity.pid,pgid:987602,command:'child'},grandchild={...identity,pid:987603,ppid:child.pid,pgid:987603,uid:identity.uid+1,command:'grandchild'},great={...identity,pid:987604,ppid:grandchild.pid,pgid:987604,command:'great grandchild'};
 f.advance('source',{observed:[identity,child]});const before=journal.read(f.b.pdir,key.task);
 const kill=process.kill,collect=P.OwnedProcesses.prototype.collect;let signals=0,claims=0;
 process.kill=()=>{signals++;throw Error('unexpected signal');};P.OwnedProcesses.prototype.collect=()=>{claims++;throw Error('unexpected ownership');};
 t.after(()=>{process.kill=kill;P.OwnedProcesses.prototype.collect=collect;});
 P.snapshot=()=>[{...child,ppid:1},grandchild];await assert.rejects(f.start(),/子プロセスが残/);
 P.snapshot=()=>[{...grandchild,ppid:1},great];await assert.rejects(f.start(),/子プロセスが残/);
 const saved=journal.read(f.b.pdir,key.task);assert.deepEqual(saved.advances.source.stopEvidence.observed,[identity,child,grandchild,great]);
 const expected=structuredClone(before);expected.advances.source.stopEvidence.observed.push(grandchild,great);assert.deepEqual(saved,expected);
 // A shared command/uid alone is not a parent link. Observation adds no signal or claim.
 P.snapshot=()=>[{...great,pid:987605,ppid:1,pgid:987605}];assert.equal(await (await f.start()).started,true);assert.equal(f.starts(),1);assert.equal(signals,0);assert.equal(claims,0);
 assert.deepEqual(journal.read(f.b.pdir,key.task),saved);
});
test('held recovery R1: failure to persist a new descendant prevents start and retains prior evidence',async t=>{
 const f=fixture(t),child={...identity,pid:987602,ppid:identity.pid,pgid:987602,command:'child'};f.advance('source');
 const before=journal.read(f.b.pdir,key.task),safe=require('../lib/safe-file'),write=safe.recoverAtomic;
 safe.recoverAtomic=()=>{throw Error('fixture observation save failed');};t.after(()=>{safe.recoverAtomic=write;});
 P.snapshot=()=>[child];await assert.rejects(f.start(),/fixture observation save failed/);assert.equal(f.starts(),0);assert.deepEqual(journal.read(f.b.pdir,key.task),before);
 safe.recoverAtomic=write;await assert.rejects(f.start(),/子プロセスが残/);assert.deepEqual(journal.read(f.b.pdir,key.task).advances.source.stopEvidence.observed,[identity,child]);
 P.snapshot=()=>[{...child,ppid:1}];await assert.rejects(f.start(),/子プロセスが残/);assert.equal(f.starts(),0);
 P.snapshot=()=>[];assert.equal(await (await f.start()).started,true);assert.equal(f.starts(),1);
});
test('held recovery R1: the second preflight check persists newly visible descendants before releasing busy state',async t=>{
 const f=fixture(t),child={...identity,pid:987602,ppid:identity.pid,pgid:987602,command:'child'},grandchild={...identity,pid:987603,ppid:child.pid,pgid:987603,command:'late grandchild'};f.advance('source',{observed:[identity,child]});
 let release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);f.runner.beforeQueued=async()=>{entered();await gate;};
 const events=[];f.runner.watch(key.project,key.task,e=>events.push(e));const start=f.start();await inside;
 P.snapshot=()=>[grandchild,{...child,ppid:1}];release();await assert.rejects(start,/子プロセスが残/);assert.equal(f.starts(),0);assert.equal(f.runner.busy(key.project,key.task),null);assert.equal(events.at(-1).type,'idle');
 assert.deepEqual(journal.read(f.b.pdir,key.task).advances.source.stopEvidence.observed,[identity,child,grandchild]);
 f.runner.beforeQueued=undefined;P.snapshot=()=>[{...grandchild,ppid:1}];await assert.rejects(f.start(),/子プロセスが残/);assert.equal(f.starts(),0);
 P.snapshot=()=>[];assert.equal(await (await f.start()).started,true);assert.equal(f.starts(),1);
});
test('held recovery: save-only legacy evidence and failed initial observation do not prove exit',async t=>{
 const f=fixture(t);f.advance('legacy',{observed:null});
 await assert.rejects(f.start(),/子プロセスの終了確認記録が不足/);
 journal.update(f.b.pdir,key.task,d=>{Object.assign(d.advances.legacy.stopEvidence,{identity,observed:[identity],observationComplete:false});});
 await assert.rejects(f.start(),/終了確認記録が不足/);assert.equal(f.starts(),0);
 // The durable stop result itself is sufficient if its confirmation flag write was interrupted.
 journal.update(f.b.pdir,key.task,d=>{d.advances.legacy.stopEvidence.state='exited';});
 assert.equal(await (await f.start()).started,true);assert.equal(f.starts(),1);
});
test('held recovery: missing save proof, unknown identity and unreadable process table stay held',async t=>{
 const f=fixture(t),a=f.advance('source');const finished=fs.readFileSync(path.join(a.source.spool,'finished.json'));
 fs.unlinkSync(path.join(a.source.spool,'finished.json'));await assert.rejects(f.start(),/終了保存が未確認/);fs.writeFileSync(path.join(a.source.spool,'finished.json'),finished);
 P.snapshot=()=>{throw Error('fixture process read failure');};await assert.rejects(f.start(),/一覧を取得できません/);
 P.snapshot=()=>[];journal.update(f.b.pdir,key.task,d=>{d.advances.source.stopEvidence.identity={...identity,command:'different owner'};});await assert.rejects(f.start(),/記録が不足|所有記録/);
 assert.equal(f.starts(),0);assert.deepEqual(f.runner.queue(key.project,key.task),f.queue);
});
test('held recovery: async preflight rechecks exit and save without duplicating composition',async t=>{
 const f=fixture(t),a=f.advance('source',{text:'ORIGINAL exact'});let release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);
 f.runner.beforeQueued=async()=>{entered();await gate;};
 const events=[];f.runner.watch(key.project,key.task,e=>events.push(e));const start=f.start();await inside;
 P.snapshot=()=>[identity];release();await assert.rejects(start,/子プロセスが残/);assert.equal(f.starts(),0);assert.equal(f.runner.busy(key.project,key.task),null);assert.equal(events.at(-1).type,'idle');
 P.snapshot=()=>[];f.runner.beforeQueued=undefined;assert.equal(await (await f.start()).started,true);assert.equal(f.input().text.split('ORIGINAL exact').length,2);assert.equal(f.starts(),1);
});
test('held recovery: save proof lost during preflight prevents start and ends busy display',async t=>{
 const f=fixture(t),a=f.advance('source');let release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);
 f.runner.beforeQueued=async()=>{entered();await gate;};const events=[];f.runner.watch(key.project,key.task,e=>events.push(e));
 const start=f.start();await inside;fs.unlinkSync(path.join(a.source.spool,'finished-confirmed.json'));release();
 await assert.rejects(start,/終了保存が未確認/);assert.equal(f.starts(),0);assert.equal(f.runner.busy(key.project,key.task),null);assert.equal(events.at(-1).type,'idle');assert.deepEqual(f.runner.queue(key.project,key.task),f.queue);
});
test('held recovery: simultaneous manual begins admit one durable attempt',async t=>{
 const f=fixture(t);f.advance('source');let release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);
 f.runner.beforeQueued=async()=>{entered();await gate;};const start=f.start();await inside;await assert.rejects(f.start(),/まだ前の返事/);release();
 assert.equal(await (await start).started,true);assert.equal(f.starts(),1);assert.equal(chat.read(f.b.pdir,key.task).filter(r=>r.role==='user'&&r.request==='next').length,1);
});
test('held recovery: unrelated new instructions do not inherit an old queued cutover',t=>{
 const f=fixture(t);f.advance('legacy',{observed:null});const input={...f.b,text:'fresh instruction',images:[]};assert.deepEqual(f.runner.continuationOptions(input),input);
 const other={...input,request:'different-id'};assert.deepEqual(f.runner.continuationOptions(other),other);assert.equal(f.starts(),0);
});
test('held recovery: explicit stop barriers and durable starts prevent manual or automatic replay',async t=>{
 const f=fixture(t);f.advance('source');let held=true;
 f.runner.stopControl={ticket:()=>({epoch:0,task:0}),assert(){if(held)throw Error('fixture explicit stop');}};
 await assert.rejects(f.start(),/explicit stop/);assert.equal(f.starts(),0);held=false;
 for(const outcome of ['unknown','failed','successful']){
  const row=chat.append(f.b.pdir,key.task,{role:'user',request:'next',turn:'already-started-'+outcome,text:'OLD before edit'});
  if(outcome!=='unknown')chat.append(f.b.pdir,key.task,{role:'assistant',request:'next',text:'result',error:outcome==='failed'?'fixture failure':''});
  await assert.rejects(f.start(),/開始記録/);assert.ok(row);assert.equal(f.starts(),0);
 }
});
test('held recovery: redo cancels older originals while later amendments and attachments survive',async t=>{
 const f=fixture(t);f.advance('old',{verified:true,text:'cancelled original'});f.advance('cancel',{verified:true,mode:'redo',text:'also cancelled'});f.advance('later',{verified:true,text:'retained later instruction'});
 assert.equal(await (await f.start()).started,true);assert.doesNotMatch(f.input().text,/cancelled original|also cancelled/);assert.match(f.input().text,/前の指示を取り消し/);assert.match(f.input().text,/retained later instruction/);assert.match(f.input().text,/EDITED extra/);
 assert.deepEqual(f.input().images,['/fixture/later.png','/fixture/edited.png']);assert.equal(f.input().unfinishedId,'later');assert.equal(journal.read(f.b.pdir,key.task).entries.cancel.status,'cancelled');
});
test('held recovery: stop observation records first scan success and never grants ownership',async()=>{
 const {terminate}=require('../lib/stop-control');let n=0,kills=0;const child={...identity,pid:987602,ppid:identity.pid,command:'child'};
 const good=await terminate({identity,scan:()=>++n===1?[{...identity,command:'changed'},child]:[],kill:()=>kills++,saved:()=>true,grace:0,settle:0});
 assert.equal(good.observationComplete,true);assert.equal(good.state,'exited');assert.deepEqual(good.observed.map(x=>x.pid),[identity.pid,child.pid]);assert.equal(good.tracked.some(p=>p.pid===child.pid),false);assert.equal(kills,0);
 n=0;const failed=await terminate({identity,scan:()=>{if(++n===1)throw Error('first scan failed');return [{...identity,command:'changed'}];},kill:()=>kills++,saved:()=>true,grace:0,settle:0});
 assert.equal(failed.observationComplete,false);assert.equal(failed.state,'ownership-unknown');assert.equal(kills,0);
});


test('reminder: dismissed original stays closed through manual and automatic cutover, without losing stop evidence',async t=>{
 const f=fixture(t),a=f.advance('original',{verified:true,text:'DO NOT RESURRECT'});
 assert.equal(typeof journal.dismiss,'function');const e=journal.read(f.b.pdir,key.task).entries.original;
 const dismissed=journal.dismiss(f.b.pdir,key.task,{id:e.id,expectedUpdated:e.updated});
 const before=journal.read(f.b.pdir,key.task).advances.original;
 assert.equal(await (await f.start()).started,true);assert.equal(f.input().text,'EDITED extra');assert.equal(f.input().unfinishedId,undefined);assert.deepEqual(journal.read(f.b.pdir,key.task).entries.original,dismissed);
 assert.deepEqual(journal.read(f.b.pdir,key.task).advances.original,before);
 // The automatic handoff uses the same stop proof, but cannot revive the dismissed original either.
 const g=fixture(t),a2=g.advance('original',{verified:true,text:'DO NOT RESURRECT'}),e2=journal.read(g.b.pdir,key.task).entries.original;
 const dismissed2=journal.dismiss(g.b.pdir,key.task,{id:e2.id,expectedUpdated:e2.updated});
 assert.equal(await (await g.runner.launchAdvance(a2,g.b)).started,true);assert.equal(g.starts(),1);assert.equal(g.input().text,'EDITED extra');assert.equal(g.input().unfinishedId,undefined);
 const after=journal.read(g.b.pdir,key.task);assert.deepEqual(after.entries.original,dismissed2);assert.equal(after.advances.original.mode,'fifo');assert.deepEqual(after.advances.original.stopEvidence,a2.stopEvidence);
});
