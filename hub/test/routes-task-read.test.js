'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../lib/routes/task-read');
function fixture(){
 const calls=[],task={id:'t',steps:[{text:'original',done:false}],workdir:'~/work'},p={id:'p',tasks:[task]},value={project:p,file:'task.md',task,inWork:true,preview:{files:2}};
 const mark=(name,fn)=>(...args)=>{calls.push([name,...args]);return fn(...args);};
 const routes=create({send:(res,status,body)=>({status,body}),lt:s=>s,store:{root:'/workspace',readProject:mark('project',()=>value.project),taskFile:mark('file',()=>value.file),readTask:mark('task',()=>{if(value.task instanceof Error)throw value.task;return value.task;})},stepSummary:mark('summary',steps=>({version:JSON.stringify(steps)})),inWork:mark('inWork',()=>value.inWork),expandHome:mark('expand',()=>'/expanded'),workRoot:mark('root',()=>'/root'),gitw:{previewAsync:mark('preview',async o=>{if(value.preview instanceof Error)throw value.preview;return value.preview;})},taskIntegrate:{mainDisplay:mark('main',()=>'/main')}});
 assert.deepEqual(calls,[],'registration must not read or mark a task');
 return {calls,value,task,routes,run:(slot,query='?project=p&task=t')=>routes[slot].handle({method:'GET'}, {}, new URL('/api/task/'+slot+query,'http://localhost'))};
}
test('task read matches exact GET routes and leaves all writes elsewhere',()=>{
 const {routes}=fixture();for(const slot of ['steps','preview']){const url=new URL('/api/task/'+slot,'http://localhost');assert.equal(routes[slot].matches({method:'GET'},url),true);assert.equal(routes[slot].matches({method:'POST'},url),false);assert.equal(routes[slot].matches({method:'GET'},new URL(url+'/')),false);}
});
test('steps reads current project steps without marking a task read or reading task files',()=>{
 const f=fixture();assert.deepEqual(f.run('steps'),{status:200,body:{steps:f.task.steps,version:JSON.stringify(f.task.steps)}});
 assert.deepEqual(f.calls.map(x=>x[0]),['project','summary']);f.task.steps=[];assert.deepEqual(f.run('steps').body.steps,[]);
});
test('missing projects and tasks preserve the steps 404 response',()=>{
 const f=fixture();for(const project of [null,{id:'p',tasks:[]}]){f.value.project=project;f.calls.length=0;assert.deepEqual(f.run('steps'),{status:404,body:{error:'作業が見つかりません'}});assert.deepEqual(f.calls.map(x=>x[0]),['project']);}
});
test('preview rejects a missing task and returns null for a task outside the work copy without using Git',async()=>{
 const f=fixture();f.value.project=null;assert.equal((await f.run('preview')).status,400);assert.deepEqual(f.calls.map(x=>x[0]),['project']);
 f.calls.length=0;f.value.project={id:'p'};f.value.inWork=false;assert.deepEqual((await f.run('preview')),{status:200,body:null});assert.deepEqual(f.calls.map(x=>x[0]),['project','file','task','inWork']);
});
test('preview passes the work and ledger roots to the worker and adds main display after the Git preview',async()=>{
 const f=fixture();assert.deepEqual((await f.run('preview')),{status:200,body:{files:2,mainDisplay:'/main'}});const options=f.calls.find(x=>x[0]==='preview')[1];assert.equal(options.dir,'/expanded');assert.equal(options.workRoot,'/root');assert.equal(options.root,'/workspace');assert.equal(options.targetGuard,undefined);assert.deepEqual(f.calls.at(-1),['main','p','t']);
});
test('Git preview failures return null while earlier store failures still propagate',async()=>{
 const f=fixture();f.value.preview=Error('unavailable');assert.deepEqual((await f.run('preview')),{status:200,body:null});assert.equal(f.calls.some(x=>x[0]==='main'),false);
 f.value.project={id:'p'};f.value.task=Error('store unavailable');f.value.inWork=true;await assert.rejects(()=>f.run('preview'),/store unavailable/);
});
test('preview yields during worker calculation and adds display evidence only after its result',async()=>{
 const f=fixture();let finish;f.value.preview=new Promise(resolve=>{finish=resolve;});
 const pending=f.run('preview');assert.equal(f.calls.some(x=>x[0]==='main'),false);
 finish({files:3});assert.deepEqual(await pending,{status:200,body:{files:3,mainDisplay:'/main'}});
 assert.deepEqual(f.calls.at(-1),['main','p','t']);
});
