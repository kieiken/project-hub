'use strict';
// Offline coordination and native decisions. No real quit, app launch or keys.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),cp=require('node:child_process');
const {attach}=require('../release-app/auto-reopen.cjs');
function fixture(){
  const f={now:1000,launches:0,stops:0,go:0,approvals:0,allowed:true};
  f.u={data:{phase:'installed',pendingConfirm:{token:'fixture'}},restartNeeded:true,status(){return {manualReopen:true,restartNeeded:this.restartNeeded};},async apply(){this.restartNeeded=true;this.data.phase='installed';}};
  attach(f.u,{now:()=>f.now,launch:(_u,fail)=>{f.launches++;f.fail=fail;return {ready:f.arm||Promise.resolve(),stop(){f.stops++;},go(){f.go++;},approve(){f.approvals++;}};}});
  f.r=f.u.reopener;f.r.request();f.now+=2000;
  f.pulse=(client='first-client-0001',ready=true)=>f.r.pulse({client,ready,ticket:f.r.ticket});
  f.advance=()=>f.r.advance(()=>f.allowed);return f;
}
test('no work: one helper, ordinary quit approval, unchanged confirmation journal',async()=>{
  const f=fixture(),before=structuredClone(f.u.data);f.pulse();
  await Promise.all([f.advance(),f.advance()]);assert.equal(f.launches,1);assert.equal(f.r.phase,'starting');
  const ticket=f.r.ticket;f.r.beforeQuit(ticket);f.r.approved();f.r.cancel();await f.advance();
  assert.equal(f.approvals,1);assert.equal(f.r.phase,'committed');assert.equal(f.stops,0);assert.deepEqual(f.u.data,before);
});
test('work and queues wait, then automatically advance without another apply click',async()=>{
  const f=fixture();f.pulse();f.allowed=false;await f.advance();assert.equal(f.launches,0);assert.match(f.r.status().reason,/作業が終わったら/);
  f.allowed=true;await f.advance();assert.equal(f.launches,1);
});
test('deferred install progresses even when auto-update setting is off; input waits before reopen',async()=>{
  const f=fixture();f.u.enabled=false;f.u.restartNeeded=false;f.u.data={phase:'deferred',prepared:{},pendingConfirm:{}};
  f.pulse(undefined,false);await f.advance();assert.equal(f.u.restartNeeded,true);assert.equal(f.launches,0);
  await f.advance();assert.equal(f.launches,0);f.pulse();await f.advance();assert.equal(f.launches,1);
});
test('every page must freeze and acknowledge; stale or disconnected page falls back to manual',async()=>{
  const f=fixture();f.pulse();f.pulse('second-client-0002',false);await f.advance();assert.equal(f.launches,0);
  f.pulse('second-client-0002');await f.advance();assert.equal(f.launches,1);
  const g=fixture();g.pulse();g.now+=10001;await g.advance();assert.equal(g.launches,0);assert.equal(g.u.status().manualReopen,true);assert.match(g.r.status().reason,/自動で開き直せません/);
});
test('cancel before admission, during asynchronous guard and during helper preparation never quits',async()=>{
  const f=fixture();f.pulse();f.r.cancel();await f.advance();assert.equal(f.launches,0);
  const g=fixture();g.pulse();let done;const wait=g.r.advance(()=>new Promise(r=>done=r));g.r.cancel();done(true);await wait;assert.equal(g.launches,0);
  const h=fixture();h.pulse();h.arm=new Promise(r=>done=r);const preparing=h.advance();await new Promise(setImmediate);h.r.cancel();done();await preparing;
  assert.equal(h.r.phase,'cancelled');assert.equal(h.approvals,0);assert.throws(()=>h.r.beforeQuit('old-ticket'),/input_changed/);
});
test('last input/save change prevents quit; helper failure returns manual guidance without rejecting update',async()=>{
  const f=fixture();f.pulse();await f.advance();const ticket=f.r.ticket;f.pulse(undefined,false);assert.throws(()=>f.r.beforeQuit(ticket),/input_changed/);assert.equal(f.approvals,0);
  const g=fixture();g.pulse();await g.advance();const before=structuredClone(g.u.data);g.fail();assert.equal(g.r.phase,'manual');assert.equal(g.u.status().manualReopen,true);assert.deepEqual(g.u.data,before);await g.advance();assert.equal(g.launches,1);
});
test('failed helper preparation does not retry or change update confirmation',async()=>{
  const f=fixture();f.pulse();f.arm=Promise.reject(Error('synthetic OS refusal'));const before=structuredClone(f.u.data);await f.advance();assert.equal(f.r.phase,'manual');await f.advance();assert.equal(f.launches,1);assert.deepEqual(f.u.data,before);
});
function page(){
  let data={autoReopen:{phase:'idle',ticket:''},restartNeeded:false};const calls=[],timers=[],elements=[];
  function el(){return {inert:false,style:{},children:[],setAttribute(){},append(c){this.children.push(c);},remove(){this.removed=true;}};}
  const content=el(),body=el();body.children=[content];body.append=c=>{body.children.push(c);elements.push(c);};
  const f={draft:false,save:false,data:d=>{data=d;},content,elements,calls,timers};
  const context=vm.createContext({crypto:{randomUUID:()=> 'fixture-page-0001'},document:{body,activeElement:{blur(){}},createElement:el},window:{addEventListener(){}},setInterval:fn=>timers.push(fn),
    appUpdateMayRestart:()=>!f.draft,localRecoveryBlocker:()=>f.save?'pending-write':'',
    api:async(route,b)=>{calls.push(b||{get:true});return data;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/auto-reopen.js'),'utf8'),context);
  f.flush=async()=>{await new Promise(setImmediate);};f.poll=async()=>{timers[0]();await f.flush();};return f;
}
for(const blocker of ['draft','save'])test('page '+blocker+' waits; final freeze and cancel preserve input',async()=>{
  const f=page();await f.flush();f[blocker]=true;f.data({restartNeeded:true,autoReopen:{phase:'waiting',ticket:'fixture'}});await f.poll();assert.equal(f.content.inert,false);assert.equal(f.calls.filter(c=>c.action==='reopen-pulse').at(-1).ready,false);
  f[blocker]=false;await f.poll();assert.equal(f.content.inert,true);assert.equal(f.calls.filter(c=>c.action==='reopen-pulse').at(-1).ready,true);
  f.data({autoReopen:{phase:'cancelled'}});const cancel=f.elements.at(-1).children[1];await cancel.onclick();assert.equal(f.content.inert,false);
});
test('a late cancellation after quit was accepted never unlocks input',async()=>{
  const f=page();await f.flush();f.data({restartNeeded:true,autoReopen:{phase:'waiting',ticket:'fixture'}});await f.poll();f.data({autoReopen:{phase:'committed'}});
  await f.elements.at(-1).children[1].onclick();assert.equal(f.content.inert,true);
});
test('native decisions require quit approval and both old processes stopped; exactly one open',{skip:process.platform!=='darwin'},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-reopen-swift-'));
  try{
    fs.writeFileSync(path.join(dir,'main.swift'),`import Foundation
var s = ReopenState()
assert(s.observe(appStopped: true, serverStopped: true, cancelled: false, expired: false) == .wait)
s.approved = true
assert(s.observe(appStopped: false, serverStopped: true, cancelled: false, expired: false) == .wait)
assert(s.observe(appStopped: true, serverStopped: false, cancelled: false, expired: false) == .wait)
assert(s.observe(appStopped: true, serverStopped: true, cancelled: false, expired: false) == .open)
assert(s.observe(appStopped: true, serverStopped: true, cancelled: false, expired: false) == .wait)
var denied = ReopenState()
assert(denied.observe(appStopped: true, serverStopped: true, cancelled: true, expired: false) == .fail)
assert(denied.observe(appStopped: true, serverStopped: true, cancelled: false, expired: true) == .fail)
`);
    cp.execFileSync('/usr/bin/swiftc',[path.join(__dirname,'../release-app/ReopenState.swift'),path.join(dir,'main.swift'),'-o',path.join(dir,'decisions')],{timeout:60000});
    cp.execFileSync(path.join(dir,'decisions'),[],{timeout:5000});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed preparation is never automatically retried by the reopen coordinator',async()=>{
 const f=fixture();let applied=0;f.u.restartNeeded=false;f.u.data={phase:'failed',prepared:{}};f.u.apply=async()=>{applied++;};
 await f.advance();assert.equal(applied,0);assert.equal(f.r.phase,'manual');
});

test('cancel after native quit was queued still rejects its late HTTP request; old helper cannot issue a new quit',async()=>{
 const f=fixture();f.pulse();await f.advance();const old=f.r.helper;f.r.beginNativeQuit(old);assert.equal(f.go,1);f.r.cancel();
 assert.throws(()=>f.r.beforeQuit(f.r.quitTicket()),/input_changed/);assert.equal(f.r.quitTicket(),'');
 f.r.request();await f.advance();assert.equal(f.launches,1);f.now+=2000;f.pulse();await f.advance();assert.equal(f.launches,2);
 f.r.beginNativeQuit(old);assert.equal(f.go,1);f.r.beginNativeQuit(f.r.helper);assert.equal(f.go,2);
});
test('native adapter verifies its runtime, uses the same app and parent PIDs, and authorizes only after ordinary quit',async()=>{
 const {EventEmitter}=require('node:events'),children=[],spawns=[],verified=[];
 const context={module:{exports:{}},process:{ppid:77,pid:88},setTimeout,clearTimeout,Buffer,
  require(name){
   if(name==='node:child_process')return {spawn(file,args,options){const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.sent=[];child.stdin.write=x=>child.sent.push(x);child.stdin.end=x=>child.sent.push(x);child.unref=()=>{};children.push(child);spawns.push({file,args,options});return child;}};
   if(name==='../lib/license/storage')return {noLinks:file=>verified.push(file)};
   return require(name);
  }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../release-app/auto-reopen.cjs'),'utf8'),context);
 const u={env:{HUB_UPDATE_APP:path.resolve('/fixture/Project Hub.app')},hubPath:path.resolve('/fixture/runtime/hub'),verifyPackage:(base,platform)=>verified.push({base,platform})};
 let failures=0;const h=context.module.exports.native(u,()=>failures++);children[0].stdout.emit('data',Buffer.from('ready\n'));await h.ready;h.go();
 assert.equal(spawns[0].file,path.join(u.hubPath,'release-app/auto-reopen-native'));assert.deepEqual(Array.from(spawns[0].args),['77','88',u.env.HUB_UPDATE_APP]);assert.equal(spawns[0].options.shell,undefined);
 assert.deepEqual(children[0].sent,['go\n']);h.approve();children[0].emit('exit',0);assert.deepEqual(children[0].sent,['go\n','approved\n']);assert.equal(failures,0);assert.equal(verified[2].platform,'darwin');
 const refused=context.module.exports.native(u,()=>failures++);children[1].emit('exit',1);await assert.rejects(refused.ready,/reopen_helper_exit/);assert.equal(failures,1);
});
