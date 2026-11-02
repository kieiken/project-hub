'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {IdeaRunEvidence}=require('../lib/idea-run-evidence'),{IdeaDispatch}=require('../paid/idea-automation/idea-dispatch');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-spool-index-')),spoolRoot=path.join(root,'spools');fs.mkdirSync(spoolRoot);
 const evidence=new IdeaRunEvidence({spoolRoot,ideas:{project:()=>({dir:root})},chats:{queue:()=>[],busy:()=>null}}),run={id:'run',requestId:'request',queueId:'queue',segments:[{request:'segment'}],spoolIds:['known'],task:'task'};
 t.after(()=>{evidence.spoolIndex?.close();fs.rmSync(root,{recursive:true,force:true});});
 const write=(name,options,extra={})=>{const dir=path.join(spoolRoot,name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({options,...extra}));};
 return {root,spoolRoot,evidence,run,write};
}
async function settled(f){const end=performance.now()+10000;let result;do{result=f.evidence.evidence('P',f.run);if(!f.evidence.spoolIndex.pending)return result;await new Promise(r=>setTimeout(r,5));}while(performance.now()<end);assert.fail('identity worker did not finish');}
function legacy(f){const ids=new Set([f.run.requestId,f.run.queueId,...f.run.segments.map(s=>s.request)]),matches=x=>Boolean(x&&(x.automation?.runId===f.run.id||x.automation?.metadata?.runId===f.run.id||ids.has(x.request)||ids.has(x.id)||ids.has(x.limitSwitch?.sourceRequest)||ids.has(x.limitSwitch?.request)));return fs.readdirSync(f.spoolRoot).filter(name=>{const file=path.join(f.spoolRoot,name,'request.json'),req=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;return matches(req?.options)||f.run.spoolIds.includes(name);}).sort();}
test('cold/retained identities preserve every legacy matching path and discard full prompts',async t=>{
 const f=fixture(t),options=[{automation:{runId:'run'}},{automation:{metadata:{runId:'run'}}},{request:'request'},{id:'queue'},{request:'segment'},{limitSwitch:{sourceRequest:'request'}},{limitSwitch:{request:'queue'}},{project:'foreign',task:'foreign',id:'request'},{request:'other'}];
 options.forEach((o,i)=>f.write('spool'+i,{...o,text:'private full prompt'},{rows:['private conversation']}));fs.mkdirSync(path.join(f.spoolRoot,'known'));
 const first=f.evidence.evidence('P',f.run);assert.equal(first.state,'unknown');assert.ok(first.error);assert.equal(first.spools,undefined);
 const ready=await settled(f);assert.deepEqual(ready.spools.map(s=>s.id),legacy(f));assert.equal(ready.state,'unknown');
 const count=f.evidence.spoolIndex.reads;for(let n=0;n<5;n++)assert.deepEqual(f.evidence.evidence('P',f.run),ready);assert.equal(f.evidence.spoolIndex.reads,count);
 assert.ok(!JSON.stringify(f.evidence.spoolIndex.entries).includes('private'));console.log(JSON.stringify({cacheReads:count,warmReads:f.evidence.spoolIndex.reads}));
});
test('new/replaced/removed requests invalidate absence; corrupt unchanged files are not re-parsed',async t=>{
 const f=fixture(t);f.write('one',{request:'other'});assert.equal((await settled(f)).state,'absent');const count=f.evidence.spoolIndex.reads;
 const file=path.join(f.spoolRoot,'one','request.json'),replacement=file+'.new';fs.writeFileSync(replacement,JSON.stringify({options:{request:'request'}}));fs.renameSync(replacement,file);
 assert.ok(f.evidence.evidence('P',f.run).error);assert.equal((await settled(f)).state,'unknown');assert.equal(f.evidence.spoolIndex.reads,count+1);
 f.write('two',{request:'queue'});assert.ok(f.evidence.evidence('P',f.run).error);assert.deepEqual((await settled(f)).spools.map(x=>x.id),['one','two']);
 fs.rmSync(path.dirname(file),{recursive:true});assert.ok(f.evidence.evidence('P',f.run).error);assert.deepEqual((await settled(f)).spools.map(x=>x.id),['two']);
 fs.writeFileSync(path.join(f.spoolRoot,'two','request.json'),'{broken');assert.ok((await settled(f)).error);const badReads=f.evidence.spoolIndex.reads;
 for(let n=0;n<3;n++)assert.ok(f.evidence.evidence('P',f.run).error);assert.equal(f.evidence.spoolIndex.pending,null);assert.equal(f.evidence.spoolIndex.reads,badReads);
 f.write('two',{request:'other'});assert.equal((await settled(f)).state,'absent');
});
function dispatcher(f,t,delegate){
 const state={runs:{run:{...f.run,delivery:'prepared',targets:[]}}};
 const dispatch=new IdeaDispatch({spoolRoot:f.spoolRoot,chats:f.evidence.chats,ideas:{...f.evidence.ideas,clock:Date.now,read:()=>state,internal:(p,id,op,apply)=>apply(state)},delegate:delegate||(async()=>{throw Error('fixture uncertain delivery');})});
 dispatch.location=()=>({});dispatch.metadata=()=>({});t.after(()=>dispatch.spoolIndex?.close());
 return {dispatch,state};
}
test('unfinished scan still fences erasure; failed dispatch waits for completed absence before not-sent',async t=>{
 const f=fixture(t),{dispatch,state}=dispatcher(f,t);
 const pending=f.evidence.evidence('P',f.run);assert.equal(pending.state,'unknown');assert.ok(pending.error,'erase requires no error before accepting empty unknown');
 assert.equal(dispatch.evidence('P',f.run).state,'unknown');assert.ok(dispatch.spoolIndex.pending);
 const result=await dispatch.dispatch('P','run');assert.equal(result.delivery,'not-sent');assert.equal(state.runs.run.closed,true);assert.equal(dispatch.spoolIndex.pending,null);
 assert.equal((await settled(f)).state,'absent');
});
test('failed dispatch waits for a changed inventory and keeps retained delivery evidence unknown',async t=>{
 const f=fixture(t),{dispatch,state}=dispatcher(f,t);await dispatch.readyEvidence('P',f.run);
 f.write('new',{request:'request'});assert.ok(dispatch.evidence('P',f.run).error);assert.ok(dispatch.spoolIndex.pending);
 assert.equal((await dispatch.dispatch('P','run')).delivery,'unknown');assert.ok(!state.runs.run.closed);assert.equal(dispatch.spoolIndex.pending,null);assert.equal(dispatch.spoolIndex.reads,1);
});
test('failed dispatch deadline leaves unknown and erasure fenced without cancelling the shared scan',async t=>{
 const f=fixture(t),{dispatch,state}=dispatcher(f,t),{EventEmitter}=require('node:events'),{IdeaSpoolIndex}=require('../lib/idea-spool-index');
 const index=dispatch.spoolIndex=new IdeaSpoolIndex(f.spoolRoot),worker=new EventEmitter();worker.terminate=()=>Promise.resolve();index.pending=worker;
 dispatch.readyEvidence=(p,r,timeout)=>{assert.equal(timeout,30000);return IdeaRunEvidence.prototype.readyEvidence.call(dispatch,p,r,5);};
 assert.equal((await dispatch.dispatch('P','run')).delivery,'unknown');assert.ok(!state.runs.run.closed);assert.equal(index.pending,worker);assert.ok(dispatch.evidence('P',f.run).error);
 for(const event of ['message','error','exit'])assert.equal(worker.listenerCount(event),0);
});
test('ready refreshes a changed inventory, shares its worker and does not retry corrupt unchanged input',async t=>{
 const f=fixture(t);await f.evidence.readyEvidence('P',f.run);const index=f.evidence.spoolIndex;
 f.write('new',{request:'other'});const one=index.ready(5000),worker=index.pending,two=index.ready(5000);assert.equal(index.pending,worker);assert.deepEqual(await one,await two);assert.equal(index.reads,1);
 fs.writeFileSync(path.join(f.spoolRoot,'new','request.json'),'{broken');assert.equal(await index.ready(5000),null);const count=index.reads;assert.equal(index.pending,null);
 assert.equal(await index.ready(5000),null);assert.equal(index.reads,count);assert.equal(index.pending,null);
});
test('successful handoff never waits for the index',async t=>{
 const f=fixture(t),{dispatch}=dispatcher(f,t,async(o,res)=>{res.writeHead(200);res.end({ok:true,queued:true,id:'queue'});});
 dispatch.readyEvidence=()=>assert.fail('successful delivery must not wait');assert.equal((await dispatch.dispatch('P','run')).delivery,'accepted');
});
test('running and queued evidence still takes precedence over an unfinished spool index',t=>{
 const f=fixture(t);f.evidence.chats.busy=()=>({options:{request:'request'}});assert.equal(f.evidence.evidence('P',f.run).state,'running');assert.equal(f.evidence.spoolIndex,undefined);
 f.evidence.chats.busy=()=>null;f.evidence.chats.queue=()=>[{id:'queue'}];assert.equal(f.evidence.evidence('P',f.run).state,'accepted');
});
