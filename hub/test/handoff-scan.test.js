'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {HandoffScan}=require('../lib/handoff-scan'),spool=require('../lib/cli-spool');
function fixture(t,count=1,payload=''){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-handoff-scan-'));
 const dirs=[];
 for(let i=0;i<count;i++){
  const dir=path.join(root,String(i));fs.mkdirSync(dir);dirs.push(dir);
  fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({options:{project:'P',task:'t'+i},payload}));
  fs.writeFileSync(path.join(dir,'finished.json'),'{}');
 }
 const scan=new HandoffScan(root);
 t.after(()=>{scan.close();fs.rmSync(root,{recursive:true,force:true});});return {root,dirs,scan};
}
function sync(root){return spool.pending(root).flatMap(dir=>{const issue=spool.failure(dir);if(!issue)return [];const o=spool.read(dir,'request.json')?.options;return [{run:path.basename(dir),project:o?.project,task:o?.task,...issue}];});}
test('worker matches synchronous receipts, notices tampering/recovery/removal and shares concurrent scans',async t=>{
 const f=fixture(t,3);assert.deepEqual(await f.scan.scan(),sync(f.root));
 let calls=0;const post=f.scan.worker.postMessage.bind(f.scan.worker);f.scan.worker.postMessage=(...a)=>{calls++;return post(...a);};
 const [a,b]=await Promise.all([f.scan.scan(),f.scan.scan()]);assert.deepEqual(a,b);assert.equal(calls,1);
 const dir=f.dirs[0];fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:'failed fixture'}));
 assert.deepEqual(await f.scan.scan(),sync(f.root));
 const issue=spool.failure(dir);fs.writeFileSync(path.join(dir,'recovered.json'),JSON.stringify({version:1,evidence:issue.token}));
 assert.deepEqual(await f.scan.scan(),sync(f.root));assert.equal((await f.scan.scan()).length,0);
 fs.writeFileSync(path.join(dir,'request.json'),'broken JSON');
 assert.deepEqual(await f.scan.scan(new Set([dir])),sync(f.root));
 fs.rmSync(dir,{recursive:true});assert.deepEqual(await f.scan.scan(),sync(f.root));
});
test('scanner errors/close remain unscoped blockers and unsupported operations cannot authorize actions',async t=>{
 const f=fixture(t);fs.rmSync(f.root,{recursive:true});fs.writeFileSync(f.root,'not a directory');
 const errors=await f.scan.scan();assert.equal(errors.length,1);assert.equal(errors[0].project,undefined);assert.match(errors[0].error,/点検/);
 // Fixed RPC exposes no recovery, completion, adoption or process launch.
 f.scan.worker.ref();const response=new Promise(resolve=>f.scan.worker.once('message',resolve));f.scan.worker.postMessage('recover');
 assert.equal((await response).errors.length,1);assert.equal(fs.readFileSync(f.root,'utf8'),'not a directory');
 f.scan.close();assert.equal((await f.scan.scan()).length,1);
});
test('timed out/terminated scan never substitutes a clean result or restarts the failed worker',async t=>{
 const f=fixture(t,20);
 t.mock.timers.enable({apis:['setTimeout']});
 const result=f.scan.scan();t.mock.timers.tick(30000);
 assert.equal((await result).length,1);t.mock.timers.reset();
 const worker=f.scan.worker;
 await worker.terminate();
 assert.equal((await f.scan.scan()).length,1);assert.equal(f.scan.worker,worker);
});
test('4000 completed runs/32MiB: cold and repeated scans leave isolated HTTP ping below 100ms',async t=>{
 const f=fixture(t,4000,'x'.repeat(8192));
 const server=http.createServer(async(req,res)=>{if(req.url==='/scan')res.end(JSON.stringify(await f.scan.scan()));else res.end('pong');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const get=route=>new Promise((resolve,reject)=>{const at=performance.now();http.get({host:'127.0.0.1',port:server.address().port,path:route},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({body,ms:performance.now()-at}));}).on('error',reject);});
 const timings=[];
 for(let i=0;i<2;i++){
  const waiting=get('/scan');while(!f.scan.pending)await new Promise(r=>setTimeout(r,1));
  const ping=await get('/ping');timings.push(ping.ms);assert.equal(ping.body,'pong');assert.ok(ping.ms<100,`ping ${ping.ms}ms`);
  assert.deepEqual(JSON.parse((await waiting).body),[]);
 }
 t.diagnostic(JSON.stringify({runs:4000,bytes:4000*8192,pingMs:timings}));
});

function provenFixture(t,count=1){
 const f=fixture(t,count);
 for(const dir of f.dirs){
  for(const [name,value]of Object.entries({'exit.json':{code:0},'cursor.json':{n:1},'stderr.json':{text:''},'started.json':{},'launch.json':{},'control.json':{},'owner.json':{serverId:'fixture',generation:1,pid:process.pid}}))fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
  fs.writeFileSync(path.join(dir,'out.jsonl'),JSON.stringify({n:1,line:'fixture'})+'\n');
  const child=new spool.SpoolChild(dir,{serverId:'fixture',generation:1});
  child.phase('finished',{finalRowHash:spool.digest('fixture row'),completionHash:spool.completion(dir)});child.finish();
 }
 return f;
}
test('display worker reuses proven runs within 60 seconds; freshDirs bypasses that shortcut',async t=>{
 const f=provenFixture(t,600),timings=[];
 for(let i=0;i<2;i++){const at=performance.now();assert.deepEqual(await f.scan.scan(),[]);timings.push(performance.now()-at);}
 // Changing an existing output does not change its parent directory stamp.
 // A clear display until forced fresh proves the worker took the short path;
 // actions still reject the altered proof immediately without that cache.
 const dir=f.dirs[0];fs.writeFileSync(path.join(dir,'out.jsonl'),'in-place altered output');
 assert.deepEqual(await f.scan.scan(),[],'finished display proof may be reused within its existing TTL');
 assert.ok(spool.failure(dir),'action verification never uses the display shortcut');
 const errors=await f.scan.scan(new Set([dir]));assert.equal(errors.length,1);assert.equal(errors[0].run,path.basename(dir));
 t.diagnostic(JSON.stringify({provenRuns:600,coldMs:timings[0],warmMs:timings[1]}));
});
test('display worker still detects a new atomic failure receipt after a shortcut hit',async t=>{
 const f=provenFixture(t);assert.deepEqual(await f.scan.scan(),[]);assert.deepEqual(await f.scan.scan(),[]);
 const file=path.join(f.dirs[0],'failure.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({stage:'finished',error:'new atomic save failure'}));fs.renameSync(temp,file);
 const errors=await f.scan.scan();assert.equal(errors.length,1);assert.equal(errors[0].error,'new atomic save failure');
});
test('parent sends active, running-child and adoption dirs on each scan and merges current errors after await',async()=>{
 const {ChatRunner}=require('../lib/chat'),root=path.join(os.tmpdir(),'handoff-parent-fixture');
 const owned=path.join(root,'owned'),running=path.join(root,'running'),adopted=path.join(root,'adopted');let seen,release;
 const parent={spoolRoot:root,spoolRuns:new Set([{dir:owned}]),running:new Map([['active',{child:{dir:running}}]]),adoptErrors:[{run:'adopted',error:'retained failure'}],handoffScanner:{scan:dirs=>{seen=new Set(dirs);return new Promise(r=>release=r);}}};
 const result=ChatRunner.prototype.handoffErrorsAsync.call(parent);
 assert.deepEqual(seen,new Set([owned,running,adopted]));parent.adoptErrors.push({run:'new',error:'arrived during scan'});release([]);
 assert.equal((await result).find(e=>e.run==='new').error,'arrived during scan');
 parent.running.clear();parent.spoolRuns.clear();parent.adoptErrors=[];
 const again=ChatRunner.prototype.handoffErrorsAsync.call(parent);assert.equal(seen.size,0);release([]);assert.deepEqual(await again,[]);
});
