'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {StopControl}=require('../lib/stop-control'),{EmergencyRestart}=require('../lib/emergency-restart'),{RestartControl}=require('../lib/restart-control');
const scope={project:'Fixture',task:'chat'},other={project:'Fixture',task:'other'},pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-resume-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(t,options={}){
 const c=new StopControl({dir:fixture(t)});let calls=0,target={head:'fixture',version:'1'},waiting=[],conflicts=[];
 const restart=new RestartControl({blockers:()=>waiting,verify:()=>{},execute:()=>calls++});
 const service=new EmergencyRestart({control:c,restart,boot:'first',target:()=>target,conflicts:()=>conflicts,stop:async()=>{c.setResults(options.results||[],options.errors||[]);}});
 return {c,restart,service,calls:()=>calls,target:v=>target=v,waiting:v=>waiting=v,conflicts:v=>conflicts=v};
}
test('a new manual turn resumes only its conversation; automation and old tickets stay fenced after reboot',t=>{
 const c=new StopControl({dir:fixture(t)}),old=c.ticket(scope);c.pause(scope);c.pause(other);const stopped=c.ticket(scope),manual=c.resumeTask(scope,stopped);
 assert.doesNotThrow(()=>c.assert(scope,manual));assert.throws(()=>c.assert(scope,old));assert.throws(()=>c.assert(scope,c.ticket(scope)));assert.ok(c.held(other));
 assert.throws(()=>c.resumeTask(scope,stopped));c.cleanExit();const cold=new StopControl({dir:c.dir});assert.equal(cold.data.all,false);assert.ok(cold.held(scope));assert.ok(cold.held(other));assert.doesNotThrow(()=>cold.assert(scope,cold.resumeTask(scope,cold.ticket(scope))));
});
for(const kind of ['global','active','unknown','unsaved','error'])test('manual send cannot bypass '+kind,t=>{
 const c=new StopControl({dir:fixture(t)});c.pause(scope);
 if(kind==='global')c.pause();if(kind==='active')c.active=true;if(kind==='unknown'||kind==='unsaved')c.setResults([{...scope,state:kind==='unknown'?'ownership-unknown':'exited',save:kind==='unsaved'?'unconfirmed':'saved'}]);if(kind==='error')c.error='fixture';
 assert.throws(()=>c.resumeTask(scope,c.ticket(scope)));assert.ok(c.held(scope));
});
test('failed manual resume persistence leaves a durable fail-closed boot',t=>{
 const c=new StopControl({dir:fixture(t)});c.pause(scope);c.write=()=>{throw Error('disk');};assert.throws(()=>c.resumeTask(scope,c.ticket(scope)));assert.ok(c.held(scope));assert.ok(new StopControl({dir:c.dir}).data.all);
});
test('global stop is idempotent, uses formal restart once and returns paused without replay',async t=>{
 const f=setup(t),id='fixture-id';await Promise.all([f.service.request(id),f.service.request(id)]);assert.equal(f.c.data.restart.phase,'waiting');assert.throws(()=>f.c.resume());f.service.tick();f.service.tick();assert.equal(f.calls(),1);assert.throws(()=>f.c.resume());await f.service.request(id);assert.equal(f.calls(),1);f.service.verifyCommitted();
 f.c.cleanExit();const cold=new StopControl({dir:f.c.dir}),r=new RestartControl({blockers:()=>[],verify:()=>{},execute:()=>assert.fail('must not replay')});const next=new EmergencyRestart({control:cold,restart:r,boot:'second',target:()=>f.c.data.restart.target,stop:()=>assert.fail('must not restop')});
 assert.equal(cold.data.restart.phase,'returned');assert.ok(cold.data.all);next.tick();await next.request(id);assert.equal(r.executions,0);
});
for(const result of [{state:'alive',save:'saved'},{state:'ownership-unknown',save:'unconfirmed'},{state:'exited',save:'unconfirmed'},{state:'external-unconfirmed',save:'saved'}])test('unsafe result blocks restart: '+JSON.stringify(result),async t=>{
 const f=setup(t,{results:[result]});await f.service.request();f.service.tick();assert.equal(f.c.data.restart.phase,'blocked');assert.equal(f.calls(),0);assert.ok(f.c.data.all);
});
test('stop/save errors cannot initiate restart',async t=>{
 const f=setup(t,{errors:['queue save failed']});await f.service.request();f.service.tick();assert.equal(f.calls(),0);assert.match(f.c.data.restart.reason,/保存/);
 const g=setup(t);g.c.write=()=>{throw Error('disk');};await g.service.request();g.service.tick();assert.equal(g.calls(),0);assert.ok(g.c.error);
});
test('active writes delay a restart; changed target or delivery flow stops it without retry',async t=>{
 const f=setup(t);f.waiting([{message:'saving'}]);await f.service.request();f.service.tick();assert.equal(f.calls(),0);assert.equal(f.c.data.restart.reason,'saving');f.waiting([]);f.service.tick();assert.equal(f.calls(),1);
 for(const kind of ['target','flow']){const g=setup(t);await g.service.request();if(kind==='target')g.target({head:'changed'});else g.conflicts([{message:'delivery pending'}]);g.service.tick();g.service.tick();assert.equal(g.calls(),0);assert.equal(g.c.data.restart.phase,'blocked');}
});
test('existing reservation is not replaced or duplicated',async t=>{
 const f=setup(t);f.waiting([{message:'write'}]);f.restart.request(true);const reserved=f.restart.reserved;await f.service.request();f.service.tick();assert.equal(f.restart.reserved,reserved);assert.equal(f.calls(),0);assert.equal(f.c.data.restart.phase,'blocked');
});
test('interrupted restart intent never automatically repeats on cold boot',async t=>{
 for(const phase of ['stopping','waiting']){const f=setup(t);await f.service.request();f.c.data.restart.phase=phase;f.c.persist();const cold=new StopControl({dir:f.c.dir});new EmergencyRestart({control:cold,restart:f.restart,boot:'next',target:()=>f.c.data.restart.target,stop:()=>assert.fail()});assert.equal(cold.data.restart.phase,'interrupted');assert.ok(cold.data.all);assert.equal(f.calls(),0);}
});
test('late stop/save failure before formal handoff invalidates the committed restart',async t=>{
 const f=setup(t);await f.service.request();f.service.tick();f.c.setResults([{state:'exited',save:'unconfirmed'}]);assert.throws(()=>f.service.verifyCommitted());f.service.fail('late save failure');assert.equal(f.c.data.restart.phase,'blocked');assert.ok(f.c.data.all);
});
test('positive terminal ancestry distinguishes independent external AI from unknown/reparented/owned processes',()=>{
 const P=require('../lib/owned-processes'),since=new Date().toString(),uid=process.getuid(),rows=[{pid:991234,ppid:991233,since,uid,command:'dummy'},{pid:991233,ppid:1,since,uid,command:'/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'}],item={pid:991234,since};
 assert.equal(P.independentExternal(item,rows),true);assert.equal(P.independentExternal(item,rows,p=>p===991233),false);assert.equal(P.independentExternal(item,[rows[0]]),false);assert.equal(P.independentExternal({...item,since:'unknown'},rows),false);assert.equal(P.independentExternal(item,[{...rows[0],ppid:1},rows[1]]),false);
});
test('worker admits only the new manual ticket; an automatic ticket remains fenced',async t=>{
 const dir=fixture(t),c=new StopControl({dir:path.join(dir,'stop')}),spool=require('../lib/cli-spool');c.pause(scope);const manual=c.resumeTask(scope,c.ticket(scope));
 for(const [name,ticket,instance,allowed] of [['automatic',c.ticket(scope),c.instance,false],['manual',manual,c.instance,true],['old-boot',manual,'older-instance',false],['missing-boot',manual,undefined,false]]){const marker=path.join(dir,name);const child=spool.start(path.join(dir,'runs'),path.basename(marker),{...scope,dir,stopSafety:{dir:c.dir,ticket,instance}},{command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'ok')`],stdin:''},{},[],process.env);for(let n=0;n<200&&!spool.read(child.dir,'exit.json');n++)await pause(15);assert.ok(spool.read(child.dir,'exit.json'));assert.equal(fs.existsSync(marker),allowed,name);}
});
test('failed final intent save reports blocked without executing or replaying a restart',async t=>{
 const f=setup(t);await f.service.request('save-failure');const write=f.c.write;f.c.write=(file,data)=>{if(file===f.c.file&&data.restart?.phase==='committed')throw Error('fixture intent failure');return write(file,data);};f.service.tick();assert.equal(f.calls(),0);assert.equal(f.c.data.restart.phase,'blocked');assert.match(f.c.data.restart.reason,/保存/);assert.ok(f.c.error);
});
test('delayed receipt from an older stop cannot stop again after explicit resumes and another stop cycle',async t=>{
 const f=setup(t);await f.service.request('first');f.service.fail('fixture no restart');f.c.resume();await f.service.request('second');f.service.fail('fixture no restart');f.c.resume();const epoch=f.c.data.epoch;await f.service.request('first');assert.equal(f.c.data.epoch,epoch);assert.equal(f.c.data.all,false);assert.deepEqual(f.c.data.restartIds,['first','second']);f.c.cleanExit();const cold=new StopControl({dir:f.c.dir});assert.deepEqual(cold.data.restartIds,['first','second']);assert.equal(cold.data.all,false);
});
