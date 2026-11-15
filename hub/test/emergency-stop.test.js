'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {StopControl,terminate}=require('../lib/stop-control'),P=require('../lib/owned-processes'),{EmergencyStop}=require('../lib/emergency-stop'),{ChatRunner}=require('../lib/chat');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),scope={project:'fixture',task:'task'};
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-emergency-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('interrupting waits for a late durable close after process exit without terminating again',async()=>{
 const chats=new ChatRunner({stopControl:{}});let finish,calls=0;
 const run={options:scope,finishedP:new Promise(r=>finish=r),settledP:new Promise(()=>{})};
 chats.running.set(chats.key(scope.project,scope.task),run);
 chats.terminateRun=async()=>{calls++;return {state:'exited',save:'unconfirmed'};};
 const timer=setTimeout(()=>{run.finished=true;finish();},650);
 try{const r=await chats.stop(scope.project,scope.task,{interrupting:true});assert.equal(r.state,'exited');assert.equal(r.save,'saved');assert.equal(calls,1);assert.equal(run.interrupting,true);}
 finally{clearTimeout(timer);}
});
test('interrupting rejects a failed durable close without treating process exit as saved',async()=>{
 const chats=new ChatRunner({stopControl:{}}),run={options:scope,spoolError:'fixture save failure',finishedP:new Promise(()=>{}),settledP:Promise.resolve({state:'failed'})};
 chats.running.set(chats.key(scope.project,scope.task),run);
 const result={state:'exited',save:'unconfirmed'};chats.terminateRun=async()=>result;
 await assert.rejects(chats.stop(scope.project,scope.task,{interrupting:true}),/終了・保存/);assert.equal(result.save,'unconfirmed');
});
test('interrupting bounds an unsettled durable close and does not upgrade unknown ownership',{timeout:15000},async()=>{
 const chats=new ChatRunner({stopControl:{}}),run={options:scope,finishedP:new Promise(()=>{}),settledP:new Promise(()=>{})};
 chats.running.set(chats.key(scope.project,scope.task),run);
 const result={state:'exited',save:'unconfirmed'};chats.terminateRun=async()=>result;
 const at=Date.now();await assert.rejects(chats.stop(scope.project,scope.task,{interrupting:true}),/終了・保存/);assert.ok(Date.now()-at>=4900);assert.equal(result.save,'unconfirmed');
 delete run.stopResultP;run.finished=true;chats.terminateRun=async()=>({state:'ownership-unknown',save:'unconfirmed'});
 await assert.rejects(chats.stop(scope.project,scope.task,{interrupting:true}),/終了・保存/);
});
test('scope/global barriers survive clean restart and invalidate old work even after explicit resume',t=>{
 const dir=fixture(t),c=new StopControl({dir}),ticket=c.ticket(scope);c.pause(scope);assert.throws(()=>c.assert(scope,ticket),/保留/);assert.doesNotThrow(()=>c.assert({project:'other',task:'x'}));c.cleanExit();
 const next=new StopControl({dir});assert.ok(next.held(scope));next.resume();assert.throws(()=>next.assert(scope,ticket),/保留/);assert.doesNotThrow(()=>next.assert(scope,next.ticket(scope)));next.pause();assert.ok(next.held({project:'other',task:'x'}));
});
test('unclean reboot or malformed stop state fails closed without consulting project files',t=>{
 const dir=fixture(t);new StopControl({dir});const c=new StopControl({dir});assert.ok(c.held(scope));assert.equal(c.view().persistence,'saved');c.cleanExit();
 for(const raw of ['{',JSON.stringify({version:1,epoch:0,all:false,tasks:[]}),JSON.stringify({version:1,epoch:0,all:false,tasks:{bad:{held:false}}})]){fs.writeFileSync(path.join(dir,'state.json'),raw);const next=new StopControl({dir,boot:false});assert.ok(next.held(scope));assert.equal(next.view().persistence,'unconfirmed');}
});
test('failed stop persistence still closes memory barrier and boot marker blocks restart starts',t=>{
 const dir=fixture(t),c=new StopControl({dir});c.write=()=>{throw Error('fixture disk failure');};assert.equal(c.pause(scope),false);assert.equal(c.view().persistence,'unconfirmed');assert.throws(()=>c.assert(scope),/保留/);assert.ok(new StopControl({dir}).held(scope));
});
test('reused PID and changed owner never receive any process signal',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'old',command:'fixture',pgid:123456,ppid:1},signals=[];
 const r=await terminate({identity,scan:()=>[{...identity,since:'new'}],kill:(...a)=>signals.push(a),grace:1,settle:1});assert.equal(r.state,'ownership-unknown');assert.deepEqual(signals,[]);
 const r2=await terminate({identity,owns:()=>false,scan:()=>[identity],kill:(...a)=>signals.push(a)});assert.equal(r2.state,'ownership-unknown');assert.deepEqual(signals,[]);
});
test('a changed process is observed until gone without signalling its changed identity',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'old',command:'fixture',pgid:123456,ppid:1};
 let scans=0,cancels=0;const signals=[];
 const r=await terminate({identity,scan:()=>++scans<3?[{...identity,command:'exec replacement'}]:[],cancel:()=>cancels++,kill:(...a)=>signals.push(a),saved:()=>true,grace:160,settle:1});
 assert.equal(r.state,'exited',JSON.stringify(r));assert.equal(r.save,'saved');assert.ok(scans>=3);assert.equal(cancels,0);assert.deepEqual(signals,[]);assert.match(r.errors[0],/識別が変わった/);
});
test('a descendant exec race during stop can confirm exit without signalling the changed descendant',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'old',command:'fixture',pgid:123456,ppid:1},child={...identity,pid:123457,ppid:123456,command:'shell'};
 let cancelled=false,scans=0;const signals=[];
 const r=await terminate({identity,scan:()=>!cancelled?[identity,child]:++scans<4?[identity,{...child,command:'exec replacement'}]:[],cancel:()=>{cancelled=true;},kill:(...a)=>signals.push(a),saved:()=>true,grace:200,settle:1});
 assert.equal(r.state,'exited',JSON.stringify(r));assert.equal(r.save,'saved');assert.equal(r.tracked.length,2);assert.deepEqual(signals,[]);
});
test('a persistent changed identity, failed observation, or lost owner stays unknown without new signals',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'old',command:'fixture',pgid:123456,ppid:1};
 for(const mode of ['changed','scan-failure','owner-lost']){
  let scans=0;const signals=[];
  const r=await terminate({identity,owns:()=>mode!=='owner-lost'||scans===0,scan:()=>{scans++;if(mode==='scan-failure')throw Error('fixture ps unavailable');return [{...identity,command:'exec replacement'}];},kill:(...a)=>signals.push(a),saved:()=>true,grace:45,settle:1});
  assert.equal(r.state,'ownership-unknown',mode);assert.deepEqual(signals,[]);
 }
});
test('R1: descendants visible before an identity error remain exit-only after reparenting',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'root',command:'root',pgid:123456,ppid:1},child={...identity,pid:123457,ppid:identity.pid,command:'child'},grandchild={...child,pid:123458,ppid:child.pid,command:'grandchild'};
 let scans=0;const signals=[];
 const r=await terminate({identity,scan:()=>++scans===1?[grandchild,child,{...identity,command:'exec'}]:[{...child,ppid:1},grandchild],cancel:()=>assert.fail('uncertain initial owner cannot be cancelled'),kill:(...a)=>signals.push(a),saved:()=>true,grace:45,settle:1});
 assert.equal(r.state,'ownership-unknown');assert.equal(r.save,'saved');assert.deepEqual(r.remaining,[child.pid,grandchild.pid]);assert.deepEqual(r.tracked,[identity]);assert.equal(r.observed.length,3);assert.deepEqual(signals,[]);
});
test('R1: exit-only descendants and children first seen during observation must all disappear before exit',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'root',command:'root',pgid:123456,ppid:1},child={...identity,pid:123457,ppid:identity.pid,command:'child'},later={...child,pid:123458,ppid:child.pid,command:'later'};
 let scans=0;const signals=[];
 const r=await terminate({identity,scan:()=>{scans++;return scans===1?[{...identity,command:'exec'},child]:scans===2?[{...child,ppid:1},later]:scans===3?[{...later,ppid:1}]:[];},cancel:()=>assert.fail('observation cannot cancel'),kill:(...a)=>signals.push(a),saved:()=>true,grace:200,settle:1});
 assert.equal(r.state,'exited');assert.equal(r.save,'saved');assert.equal(scans,4);assert.deepEqual(r.tracked,[identity]);assert.equal(r.observed.length,3);assert.deepEqual(signals,[]);
});
test('R1: exit-only descendants with reused identity, lost owner, or unreadable later snapshot stay unknown',async()=>{
 const identity={pid:123456,uid:process.getuid(),since:'root',command:'root',pgid:123456,ppid:1},child={...identity,pid:123457,ppid:identity.pid,command:'child'};
 for(const mode of ['reused-child','owner-lost','read-failure']){
  let scans=0;const signals=[];
  const r=await terminate({identity,owns:()=>mode!=='owner-lost'||scans===0,scan:()=>{if(++scans===1)return [{...identity,command:'exec'},child];if(mode==='read-failure')throw Error('fixture unreadable after conflict');return [{...child,ppid:1,since:'different child',command:'different process'}];},kill:(...a)=>signals.push(a),saved:()=>true,grace:45,settle:1});
  assert.equal(r.state,'ownership-unknown',mode);assert.deepEqual(r.tracked,[identity]);assert.ok(r.observed.some(p=>p.pid===child.pid));assert.deepEqual(signals,[]);
 }
});
test('R1: a saved exit-only descendant survives reboot and explicit stop without acquiring signal ownership',async t=>{
 const dir=fixture(t),identity={pid:123456,uid:process.getuid(),since:'root',command:'root',pgid:123456,ppid:1},child={...identity,pid:123457,ppid:1,command:'child'};
 const first=new StopControl({dir});first.pause(scope);first.setResults([{...scope,identity,tracked:[identity],observed:[identity,child],state:'ownership-unknown',save:'saved',errors:[]}]);first.cleanExit();
 const control=new StopControl({dir}),chats=new ChatRunner({stopControl:control}),service=new EmergencyStop({control,chats,sessions:{map:new Map()},webchat:{busy:()=>[]}});
 const snapshot=P.snapshot,kill=process.kill,signals=[];let alive=true;
 P.snapshot=()=>alive?[{...child,since:'reused',command:'replacement'}]:[];process.kill=(...a)=>signals.push(a);
 try{
  const held=await service.stop(scope);assert.equal(held.ok,false);assert.equal(held.results[0].state,'ownership-unknown');assert.deepEqual(held.results[0].tracked,[identity]);assert.deepEqual(held.results[0].remaining,[child.pid]);assert.throws(()=>control.resume(),/確認できない/);assert.deepEqual(signals,[]);
  alive=false;const gone=await service.stop(scope);assert.equal(gone.ok,true);assert.equal(gone.results[0].state,'exited');assert.deepEqual(signals,[]);
 }finally{P.snapshot=snapshot;process.kill=kill;}
});
test('SIGTERM-resistant dummy and its child are killed, unrelated dummy survives, save stays unconfirmed',async t=>{
 fixture(t);const outsider=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>outsider.kill('SIGKILL'));
 const child=spawn(process.execPath,['-e',`const {spawn}=require('child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',()=>console.log('ready'));setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']});t.after(()=>{try{child.kill('SIGKILL');}catch{}});
 await new Promise(r=>child.stdout.once('data',r));const identity=P.capture(child.pid),r=await terminate({identity,cancel:()=>{throw Error('fixture checkpoint failed');},grace:120,settle:160});
 assert.equal(r.state,'exited',JSON.stringify(r));assert.equal(r.save,'unconfirmed');assert.ok(r.signals.some(s=>s.signal==='SIGKILL'));assert.ok(r.tracked.length>=2);assert.ok(P.snapshot().some(p=>p.pid===outsider.pid));
});
test('ledger exception does not block stopping and pending instructions stay saved',async t=>{
 const dir=fixture(t),control=new StopControl({dir}),chats=new ChatRunner({stopControl:control,dirOf:()=>null,onStop:()=>{throw Error('このプロジェクトでは台帳を使えません');}});
 const q=[{id:'pending',text:'keep this instruction'}];chats.queues.set(chats.key('fixture','task'),q);
 let cancelled=false;const run={options:scope,ai:'codex',pending:true,cancel:()=>{cancelled=true;},finishedP:Promise.resolve()};chats.running.set(chats.key('fixture','task'),run);
 const service=new EmergencyStop({control,chats,sessions:{map:new Map()},webchat:{busy:()=>[]},ancillary:()=>chats.onStop()});const r=await service.stop(scope);
 assert.equal(cancelled,true);assert.equal(r.ok,true);assert.match(r.errors[0],/台帳/);assert.deepEqual(chats.queue('fixture','task'),q);assert.ok(control.held(scope));assert.equal(r.results[0].state,'not-started');
});
test('pending preflight/amend cannot restart after stop and human resume',async t=>{
 const dir=fixture(t),control=new StopControl({dir});let release;const wait=new Promise(r=>release=r),chats=new ChatRunner({stopControl:control,dirOf:()=>dir,beforeQueued:()=>wait});
 chats.queues.set(chats.key('fixture','task'),[{id:'first',text:'original'}]);
 const p=chats.sendQueued({...scope,ai:'codex',model:'fixture',request:'first',text:'original'});await pause(5);
 const replacement=chats.replacePending('fixture','task','additional','amend');await assert.rejects(p,/停止/);await replacement.finished;const ticket=replacement.options.stopTicket;
 await chats.stop('fixture','task');control.resume();release();assert.throws(()=>control.assert(scope,ticket),/保留/);assert.ok(chats.queue('fixture','task').some(q=>q.text.includes('additional')));
 await assert.rejects(chats.sendQueued(replacement.options),/保留/);
});
test('pending durable results retain ownership failures across reboot and block resume',t=>{
 const dir=fixture(t),c=new StopControl({dir});c.pause();c.setResults([{label:'fixture',state:'ownership-unknown',save:'unconfirmed'}]);c.cleanExit();const next=new StopControl({dir});assert.throws(()=>next.resume(),/確認できない/);
});
test('stopped supervisor and failed cancel/checkpoint cannot prevent direct owned CLI termination',async t=>{
 const dir=fixture(t),control=new StopControl({dir:path.join(dir,'stop')}),ledger=path.join(dir,'ledger');fs.mkdirSync(ledger);
 const chats=new ChatRunner({stopControl:control,spoolRoot:path.join(dir,'runs'),dirOf:()=>ledger}),script=path.join(dir,'dummy.cjs');
 fs.writeFileSync(script,`process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'thread.started',thread_id:'dummy'}));setInterval(()=>{},1000);`);
 const run=chats.run({...scope,stopTicket:control.ticket(scope),pdir:ledger,dir,ai:'codex',model:'fixture',userRow:{at:new Date().toISOString(),turn:'fixture'},text:'dummy'},{command:process.execPath,args:[script],stdin:'dummy'},{sessions:{},models:{}},[]);
 await run.startedP;await pause(60);const supervisor=P.capture(run.child.supervisorPid);process.kill(supervisor.pid,'SIGSTOP');
 t.after(()=>{try{if(P.same(supervisor,P.snapshot().find(p=>p.pid===supervisor.pid)))process.kill(supervisor.pid,'SIGCONT');}catch{}});
 run.child.kill=()=>{throw Error('fixture cancel write failed');};control.pause(scope);run.stopped=true;
 const r=await chats.terminateRun(run);assert.equal(r.state,'exited',JSON.stringify(r));assert.equal(r.save,'unconfirmed');assert.ok(r.errors.some(e=>e.includes('cancel write')));assert.ok(r.signals.some(e=>e.signal==='SIGKILL'));
 process.kill(supervisor.pid,'SIGCONT');for(let n=0;n<100&&!run.finished;n++)await pause(25);assert.equal(run.finished,true);assert.ok(require('../lib/chat').read(ledger,'task').some(r=>r.role==='assistant'&&r.error));
});
test('worker rejects an old start ticket even after stop and manual resume',async t=>{
 const dir=fixture(t),control=new StopControl({dir:path.join(dir,'stop')}),spool=require('../lib/cli-spool'),ticket=control.ticket(scope),marker=path.join(dir,'must-not-start');
 control.pause();control.resume();
 const child=spool.start(path.join(dir,'runs'),'fixture',{...scope,dir,stopSafety:{dir:control.dir,ticket}},{command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`],stdin:''},{},[],process.env);
 for(let n=0;n<100&&!spool.read(child.dir,'exit.json');n++)await pause(25);
 assert.match(spool.read(child.dir,'exit.json')?.error||'',/停止後/);assert.equal(fs.existsSync(marker),false);assert.equal(spool.read(child.dir,'started.json'),null);
});
test('worker refuses a malformed durable barrier rather than treating it as permission',async t=>{
 const dir=fixture(t),control=new StopControl({dir:path.join(dir,'stop')}),spool=require('../lib/cli-spool'),ticket=control.ticket(scope),marker=path.join(dir,'must-not-start');
 fs.writeFileSync(control.file,JSON.stringify({version:1,epoch:ticket.epoch,all:false,tasks:[]}));
 const child=spool.start(path.join(dir,'runs'),'fixture',{...scope,dir,stopSafety:{dir:control.dir,ticket}},{command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`],stdin:''},{},[],process.env);
 for(let n=0;n<100&&!spool.read(child.dir,'exit.json');n++)await pause(25);
 assert.match(spool.read(child.dir,'exit.json')?.error||'',/停止記録/);assert.equal(fs.existsSync(marker),false);
});
test('concurrent scope stops fence immediately, preserve waits and never claim unowned work exited',async t=>{
 const dir=fixture(t),control=new StopControl({dir}),other={project:'other',task:'task'};let release;
 const wait=new Promise(r=>release=r),runs=new Map(),chats={running:runs,stops:new Map(),key:(p,t)=>p+'\0'+t,terminateRun:async r=>{await wait;return {label:r.ai,state:'exited',save:'saved'};}};
 runs.set('fixture\0task',{options:scope,ai:'codex'});runs.set('other\0task',{options:other,ai:'claude'});
 const service=new EmergencyStop({control,chats,sessions:{map:new Map()},webchat:{busy:()=>[]},unmanaged:()=>[{...other,ai:'agy',pid:765432}]});
 const a=service.stop(scope),b=service.stop(other);assert.ok(control.held(scope));assert.ok(control.held(other));release();await a;const result=await b;
 assert.equal(result.ok,false);assert.equal(result.stopping,false);assert.ok(result.results.some(r=>r.state==='ownership-unknown'&&r.pid===765432));assert.throws(()=>control.resume(),/確認できない/);
 runs.clear();service.unmanaged=()=>[];const cleared=await service.stop(other);assert.equal(cleared.results.some(r=>r.state==='ownership-unknown'),false);assert.doesNotThrow(()=>control.resume());
});
test('a failed stop-state write still terminates a positively owned dummy',async t=>{
 const dir=fixture(t),control=new StopControl({dir}),child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});t.after(()=>{try{child.kill('SIGKILL');}catch{}});await new Promise(r=>child.stdout.once('data',r));
 const s={identity:P.capture(child.pid),proc:child,exited:false},sessions={map:new Map([['fixture\0task\0codex',s]])};child.once('exit',()=>s.exited=true);control.write=()=>{throw Error('fixture disk unavailable');};
 const result=await new EmergencyStop({control,sessions,chats:{running:new Map(),stops:new Map()},webchat:{busy:()=>[]}}).stop();
 assert.equal(result.results[0].state,'exited');assert.equal(result.results[0].save,'unconfirmed');assert.equal(result.persistence,'unconfirmed');assert.equal(control.held(scope),true);assert.ok(new StopControl({dir}).held(scope));
});
