'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {HandoffAdmission}=require('../lib/handoff-admission'),{ChatRunner}=require('../lib/chat'),spool=require('../lib/cli-spool');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t,count=1){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-admission-')),dirs=[];
 for(let i=0;i<count;i++){const dir=path.join(root,String(i));fs.mkdirSync(dir);dirs.push(dir);fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({options:{project:'P',task:'t'},padding:'x'.repeat(1024)}));fs.writeFileSync(path.join(dir,'finished.json'),'{}');}
 const scan=new HandoffAdmission(root),chat=new ChatRunner({spoolRoot:root});chat.handoffAdmission=scan;
 t.after(()=>{scan.close();fs.rmSync(root,{recursive:true,force:true});});return {root,dirs,scan,chat};
}
test('strict scans match current sync guards and detect new, replaced, recovered and permission receipts without display TTL',async t=>{
 const f=fixture(t,3),dir=f.dirs[0];
 const expected=()=>spool.pending(f.root).flatMap(d=>{const issue=spool.failure(d);return issue?[{run:path.basename(d),project:'P',task:'t',...issue}]:[];});
 assert.deepEqual((await f.scan.scan()).errors,expected());
 fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:'new failure'}));
 assert.deepEqual((await f.scan.scan()).errors,expected());
 fs.renameSync(path.join(dir,'failure.json'),path.join(dir,'old-failure'));
 fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:'replacement'}));
 assert.equal((await f.scan.scan()).errors[0].error,'replacement');
 fs.writeFileSync(path.join(dir,'recovered.json'),JSON.stringify({version:1,evidence:spool.evidence(dir)}));
 assert.deepEqual((await f.scan.scan()).errors,expected());assert.deepEqual(expected(),[]);
 fs.chmodSync(path.join(dir,'request.json'),0);await assert.rejects(f.scan.scan(),/点検を完了できません/);
 fs.chmodSync(path.join(dir,'request.json'),0o600);assert.deepEqual((await f.scan.scan()).errors,[]);
 fs.writeFileSync(path.join(dir,'out.jsonl'),'changed proof');assert.deepEqual((await f.scan.scan()).errors,expected());assert.equal(expected().length,1);
});
test('4000 strict cold/warm checks leave ping and conversation first rows responsive; action runs only after verdict',async t=>{
 const f=fixture(t,4000);let executions=0,checking=false;
 const server=http.createServer((req,res)=>{res.end(req.url==='/stream'?'data: {"rows":[]}\n\n':'{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,timings=[];
 for(let n=0;n<2;n++){
  checking=true;const at=performance.now(),work=f.chat.withStrictHandoff(()=>{assert.equal(checking,true);f.chat.assertHandoffReady('P','t');executions++;});
  assert.equal(executions,n);const probes=[];
  for(let i=0;i<8;i++){await pause(10);for(const route of ['/ping','/stream']){const start=performance.now();const r=await fetch(base+route);await r.text();probes.push(performance.now()-start);}}
  await work;checking=false;assert.equal(executions,n+1);assert.ok(Math.max(...probes)<100,JSON.stringify(probes));timings.push({strictMs:performance.now()-at,maxPingAndRowsMs:Math.max(...probes)});
 }
 t.diagnostic(JSON.stringify({runs:4000,timings}));
});
test('admission reservation rejects duplicates and a stop cancels a waiting send before execution',async t=>{
 const f=fixture(t);let release,executions=0;
 f.chat.handoffAdmission={scan:()=>new Promise(r=>release=()=>r({errors:[],dirs:[]})),close(){}};
 f.chat.sendNow=()=>{executions++;return {started:Promise.resolve(true)};};
 const o={project:'P',task:'t',request:'one'},work=f.chat.send(o);
 await assert.rejects(f.chat.send(o),/前の返事/);assert.equal(executions,0);
 const stopped=f.chat.stop('P','t');await assert.rejects(work,/停止/);await stopped;
 release();await pause(10);assert.equal(executions,0);assert.equal(f.chat.busy('P','t'),null);
});
test('queue replacement, recovery and generation churn cannot authorize an old operation',async t=>{
 const f=fixture(t);let scans=0,executions=0;
 f.chat.handoffAdmission={async scan(){scans++;f.chat.stops.set('P\0t',scans);return {errors:[],dirs:[]};},close(){}};
 await assert.rejects(f.chat.withStrictHandoff(()=>executions++),/実行状態が変わりました/);assert.equal(scans,2);assert.equal(executions,0);
 let release;f.chat.handoffAdmission={scan:()=>new Promise(r=>release=r),close(){}};
 f.chat.queue('P','t');f.chat.queues.set('P\0t',[{id:'one',text:'original'}]);
 f.chat.sendNow=()=>executions++;
 const work=f.chat.send({project:'P',task:'t',request:'one'});
 f.chat.queues.set('P\0t',[{id:'one',text:'changed'}]);release({errors:[],dirs:[]});await pause(5);release({errors:[],dirs:[]});
 await assert.rejects(work,/指示が変更/);assert.equal(executions,0);
});
test('a scoped verdict expires on await and a subsequent disk failure blocks the next action',async t=>{
 const f=fixture(t);
 await f.chat.withStrictHandoff(async()=>{assert.doesNotThrow(()=>f.chat.assertHandoffReady('P','t'));await pause(1);assert.throws(()=>f.chat.assertHandoffReady('P','t'),/終了保存/);});
 fs.writeFileSync(path.join(f.dirs[0],'failure.json'),'{"error":"arrived"}');
 await assert.rejects(f.chat.assertHandoffReadyAsync('P','t'),/終了保存/);
});
// Inject only the worker transport; production operations/receipt checks stay fixed.
function delayedWorker(delay,started=[]){
 const worker=new (require('node:events').EventEmitter)();let timer;
 worker.ref=worker.unref=()=>worker;
 worker.postMessage=request=>{started.push({id:request.id,at:performance.now()});timer=setTimeout(()=>worker.emit('message',{id:request.id,ok:true,errors:[],dirs:[]}),delay);};
 worker.terminate=()=>{clearTimeout(timer);return Promise.resolve(0);};return worker;
}
async function inFlight(scanner){for(let i=0;i<1000;i++){if(scanner.active&&scanner.worker)return;await pause(1);}throw Error('scan did not start');}
test('concurrent humans share a fresh batch, deadlines start at execution, and maintenance adds no queued scan',async t=>{
 const f=fixture(t),started=[];f.scan.timeoutMs=160;f.scan.createWorker=()=>delayedWorker(110,started);
 const first=f.scan.scan();await inFlight(f.scan);await pause(25);
 assert.equal(await f.scan.scan({background:true}),null,'maintenance skips a lone in-flight scan');
 const human=f.scan.scan(),other=f.scan.scan(),third=f.scan.scan(),timer=f.scan.scan({background:true});
 assert.equal(human,other);assert.equal(human,third);assert.equal(human,timer);assert.notEqual(human,first);
 assert.equal(f.scan.sequence,2,'one active plus one next, regardless of waiter count');
 const a=await first,b=await human;assert.notEqual(a.id,b.id);assert.equal(started.length,2);
 assert.ok(started[1].at-started[0].at>=100,'next request never consumes already-running verdict');
 assert.equal((await f.scan.scan()).errors.length,0,'no fixed refusal after queue residence exceeds timeout');
});
test('idle maintenance and same-turn humans use one fresh scan; busy maintenance cannot authorize a write',async t=>{
 const f=fixture(t),started=[];f.scan.createWorker=()=>delayedWorker(35,started);let writes=0;
 const maintenance=f.chat.withStrictHandoff(()=>writes++,undefined,false,{background:true});
 const human=f.chat.withStrictHandoff(()=>writes++);
 await Promise.all([maintenance,human]);assert.equal(writes,2);assert.equal(started.length,1);
 const active=f.scan.scan();await inFlight(f.scan);
 await f.chat.withStrictHandoff(()=>writes++,undefined,false,{background:true});assert.equal(writes,2);
 await active;assert.equal(started.length,2);
});
test('timeout and abnormal exit reject current waiters but the next request recreates the worker and recovers',async t=>{
 const f=fixture(t),create=f.scan.createWorker.bind(f.scan);f.scan.timeoutMs=80;
 f.scan.createWorker=()=>delayedWorker(500);
 const timeout=f.scan.scan();const rejected=assert.rejects(timeout,/点検を完了できません/);
 await inFlight(f.scan);const queued=f.scan.scan();const alsoRejected=assert.rejects(queued,/点検を完了できません/);
 await Promise.all([rejected,alsoRejected]);assert.equal(f.scan.worker,null);
 f.scan.timeoutMs=30000;f.scan.createWorker=create;
 assert.deepEqual((await f.scan.scan()).errors,[]);const persistent=f.scan.worker;
 assert.deepEqual((await f.scan.scan()).errors,[]);assert.equal(f.scan.worker,persistent,'verified cache owner persists across strict scans');
 // Terminate an injected held worker so exit cannot race a tiny completed scan.
 f.scan.close();const crashing=new HandoffAdmission(f.root);t.after(()=>crashing.close());
 let injected;crashing.createWorker=()=>{injected=delayedWorker(500);return injected;};
 const work=crashing.scan(),exit=assert.rejects(work,/点検を完了できません/);await inFlight(crashing);injected.emit('exit',1);await exit;
 crashing.createWorker=create;assert.deepEqual((await crashing.scan()).errors,[]);
 assert.notEqual(crashing.worker,persistent);
 f.scan.close();await assert.rejects(f.scan.scan(),/点検を完了できません/);
});
test('restart cancellation and concurrent commits remain single-owner across strict preflight',async()=>{
 const {RestartControl}=require('../lib/restart-control');let release,executions=0;
 const r=new RestartControl({blockers:()=>[],verify(){},execute(){executions++;},admit:fn=>new Promise((resolve,reject)=>release=()=>{try{resolve(fn());}catch(e){reject(e);}})});
 r.request(true);const cancelled=r.flight;r.cancel();release();await assert.rejects(cancelled,/取り消されました/);assert.equal(executions,0);
 const a=r.request(),b=r.request();assert.equal(a,b);release();await a;assert.equal(executions,1);
});
test('real send admission writes no user row before approval and invokes the actual start exactly once',async t=>{
 const f=fixture(t),pdir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-admission-conversation-'));
 t.after(()=>fs.rmSync(pdir,{recursive:true,force:true}));let release,executions=0;
 const scan=f.scan.scan.bind(f.scan);f.chat.handoffAdmission={scan:()=>new Promise(r=>release=()=>scan().then(r)),close(){}};
 f.chat.run=()=>{executions++;return {startedP:Promise.resolve(true)};};
 const o={project:'P',task:'t',pdir,dir:pdir,ai:'codex',model:'gpt-6.1-sol',text:'temporary local fixture',request:'real-start'};
 const work=f.chat.send(o);assert.equal(executions,0);assert.deepEqual(require('../lib/chat').read(pdir,'t'),[]);
 release();assert.equal(await (await work).started,true);assert.equal(executions,1);assert.equal(require('../lib/chat').read(pdir,'t').filter(r=>r.role==='user').length,1);
 fs.writeFileSync(path.join(f.dirs[0],'failure.json'),'{"error":"failure during wait"}');
 const denied=f.chat.send({...o,request:'must-not-start'});release();await assert.rejects(denied,/終了保存/);
 assert.equal(executions,1);assert.equal(require('../lib/chat').read(pdir,'t').filter(r=>r.role==='user').length,1);
});
test('continuous external receipt replacement refuses admission instead of using an unstable verdict',async t=>{
 const f=fixture(t,4000);let n=0;
 const timer=setInterval(()=>{fs.writeFileSync(path.join(f.dirs[3999],'failure.json'),JSON.stringify({error:'changing '+ ++n}));},5);
 t.after(()=>clearInterval(timer));await assert.rejects(f.scan.scan(),/点検を完了できません/);assert.ok(n>5);clearInterval(timer);
 assert.equal((await f.scan.scan()).errors[0].error,'changing '+n);
});
test('unrelated concurrent task admissions each start once while every action still receives a strict verdict',async t=>{
 const f=fixture(t);let scans=0,executions=[];
 f.chat.handoffAdmission={async scan(){scans++;await pause(5);return {errors:[],dirs:[]};},close(){}};
 f.chat.sendNow=o=>{executions.push(o.task);return {started:Promise.resolve(true)};};
 await Promise.all(['a','b','c'].map(task=>f.chat.send({project:'P',task,request:task})));
 assert.deepEqual(executions.sort(),['a','b','c']);assert.equal(scans,3);
});
test('restoration owns a single flight before new reservations; a stop during restoration cannot start later',async t=>{
 const f=fixture(t);let release,executions=0,scans=0;
 f.chat.handoffAdmission={scan:()=>++scans===1?new Promise(r=>release=()=>r({errors:[],dirs:[]})):Promise.resolve({errors:[],dirs:[]}),close(){}};
 f.chat.sendNow=()=>executions++;
 const restoring=f.chat.adopt();assert.equal(f.chat.adopt(),restoring);
 const work=f.chat.send({project:'P',task:'t'});assert.equal(f.chat.running.size,0);
 await f.chat.stop('P','t');release();await restoring;await assert.rejects(work,/停止/);assert.equal(executions,0);
 const fresh=f.chat.send({project:'P',task:'t'});release();await fresh;assert.equal(executions,1);
});
test('failed restoration is retained and refuses later actions without retrying the scanner',async t=>{
 const f=fixture(t);let scans=0;
 f.chat.handoffAdmission={async scan(){scans++;throw Error('restoration fault');},close(){}};
 await assert.rejects(f.chat.adopt(),/restoration fault/);
 await assert.rejects(f.chat.send({project:'P',task:'t'}),/restoration fault/);
 await assert.rejects(f.chat.adopt(),/restoration fault/);assert.equal(scans,1);assert.equal(f.chat.running.size,0);
});
test('adopting an older saved control cannot roll back a stop received during restoration',t=>{
 const f=fixture(t),child=new (require('node:events').EventEmitter)();
 fs.writeFileSync(path.join(f.dirs[0],'control.json'),JSON.stringify({stopVersion:0}));
 child.dir=f.dirs[0];child.stdin={on(){},end(){throw Error('fixture ends after restoring control');}};
 f.chat.stops.set('P\0t',1);
 assert.throws(()=>f.chat.run({project:'P',task:'t',pdir:f.root,dir:f.root,ai:'codex',model:'gpt-6.1-sol'},
  {command:process.execPath,args:[],stdin:''},{},[],child),/fixture ends after restoring control/);
 assert.equal(f.chat.stops.get('P\0t'),1);
});
test('loading an empty queue during a permit preserves it, while newly discovered pending work invalidates it',async t=>{
 const f=fixture(t);
 await f.chat.withStrictHandoff(()=>{
  f.chat.queue('P','new-empty');assert.doesNotThrow(()=>f.chat.assertHandoffReady('P','t'));
  f.chat.queues.set('P\0new-work',[{id:'queued'}]);assert.throws(()=>f.chat.assertHandoffReady('P','t'),/終了保存/);
 });
});
