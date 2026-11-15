'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../lib/routes/task-read');
function fixture(){
 const calls=[],task={id:'t',steps:[{text:'original',done:false}],workdir:'~/work'},p={id:'p',tasks:[task]},value={project:p,file:'task.md',task,inWork:true,preview:{files:2}};
 const mark=(name,fn)=>(...args)=>{calls.push([name,...args]);return fn(...args);};
 const routes=create({send:(res,status,body)=>({status,body}),sendEncoded:(req,res,body)=>({status:200,body:JSON.parse(body)}),lt:s=>s,store:{root:'/workspace',readProject:mark('project',()=>value.project),taskFile:mark('file',()=>value.file),readTask:mark('task',()=>{if(value.task instanceof Error)throw value.task;return value.task;})},stepSummary:mark('summary',steps=>({version:JSON.stringify(steps)})),inWork:mark('inWork',()=>value.inWork),expandHome:mark('expand',()=>'/expanded'),workRoot:mark('root',()=>'/root'),gitw:{previewAsync:mark('preview',async o=>{if(value.preview instanceof Error)throw value.preview;return value.preview;})},taskIntegrate:{mainDisplay:mark('main',()=>'/main')}});
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

async function httpFixture(t) {
 const http=require('node:http'),{sendEncoded}=require('../lib/static-files');
 const task={id:'t',steps:Array.from({length:2305},(_,i)=>({text:'確認する手順 '+i+'。'.repeat(20),done:i%2===0}))};let present=true;
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 const steps=create({send,sendEncoded,lt:s=>s,store:{readProject:()=>present?{tasks:[task]}:null},stepSummary:s=>({version:require('node:crypto').createHash('sha256').update(JSON.stringify(s)).digest('hex')})}).steps;
 const server=http.createServer((req,res)=>steps.handle(req,res,new URL(req.url,'http://localhost')));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const get=encoding=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port,path:'/api/task/steps?project=p&task=t',headers:encoding?{'Accept-Encoding':encoding}:{}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject);});
 return {task,get,missing:()=>{present=false;}};
}
test('large step responses negotiate gzip without retaining stale steps or changing JSON and no-store headers',async t=>{
 const {gunzipSync}=require('node:zlib'),f=await httpFixture(t),plain=await f.get(),gz=await f.get('gzip');
 assert.equal(gz.status,200);assert.equal(gz.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(gz.body),plain.body);assert.ok(gz.body.length<plain.body.length/2);
 for(const r of [plain,gz]){assert.equal(r.headers['content-type'],'application/json; charset=utf-8');assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.headers.vary,'Accept-Encoding');assert.equal(Number(r.headers['content-length']),r.body.length);}
 f.task.steps[0]={text:'更新後の手順',done:true};const updated=JSON.parse(gunzipSync((await f.get('gzip')).body));assert.deepEqual(updated.steps,f.task.steps);assert.notEqual(updated.version,JSON.parse(plain.body).version);
});
test('gzip refusal, small steps and missing tasks keep identity bodies and original status',async t=>{
 const f=await httpFixture(t),plain=await f.get();
 for(const enc of ['br','gzip;q=0','gzip;q=0, *;q=1']){const r=await f.get(enc);assert.equal(r.headers['content-encoding'],undefined);assert.deepEqual(r.body,plain.body);}
 f.task.steps=[];const small=await f.get('gzip');assert.equal(small.headers['content-encoding'],undefined);assert.deepEqual(JSON.parse(small.body).steps,[]);
 f.missing();const missing=await f.get('gzip');assert.equal(missing.status,404);assert.equal(missing.headers['content-encoding'],undefined);assert.equal(missing.headers['cache-control'],'no-store');assert.deepEqual(JSON.parse(missing.body),{error:'作業が見つかりません'});
});
