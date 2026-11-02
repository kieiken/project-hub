'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('actual isolated Hub: 4000 strict action receipts never block ping or first conversation rows, cold and warm',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-admission-http-')),{Store}=require('../lib/store'),store=new Store(root),p=store.createProject({name:'AdmissionFixture'}).project,task=store.createTask(p.id,{title:'temporary',workspaceMode:'direct'}),runs=path.join(root,'_hub/cli-runs');fs.mkdirSync(runs,{recursive:true});
 for(let i=0;i<4000;i++){const d=path.join(runs,String(i));fs.mkdirSync(d);fs.writeFileSync(path.join(d,'request.json'),JSON.stringify({options:{project:p.id,task:task.id}}));fs.writeFileSync(path.join(d,'finished.json'),'{}');}
 Object.assign(process.env,{HUB_ROOT:root,HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'home'),HUB_FREETALK_HOME:path.join(root,'ft'),HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_UPDATE_SOURCE:''});
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
 let hub;const spool=require('../lib/cli-spool'),pending=spool.pending;
 const request=(route,body)=>new Promise((resolve,reject)=>{
  const at=performance.now(),req=http.request({host:'127.0.0.1',port,path:route,method:body?'POST':'GET',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'}},res=>{let data='';res.on('data',chunk=>{data+=chunk;if(route.includes('/stream')&&data.includes('"rows"')){resolve({status:res.statusCode,ms:performance.now()-at,body:data});req.destroy();}});res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-at,body:data}));res.on('error',e=>{if(e.code!=='ECONNRESET')reject(e);});});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy();reject(Error('fixture HTTP timeout'));});req.end(body&&JSON.stringify(body));
 });
 try{
  hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));
  spool.pending=()=>{throw Error('parent strict full scan is forbidden');};
  const timings=[];
  for(let i=0;i<2;i++){
   const work=request('/api/quit',{});while(!hub.chats.handoffAdmission.worker)await pause(1);
   const ping=await request('/api/ping'),rows=await request('/api/chat/stream?project='+p.id+'&task='+task.id);
   assert.equal(ping.status,200);assert.equal(rows.status,200);assert.ok(ping.ms<100,`ping ${ping.ms}`);assert.ok(rows.ms<100,`rows ${rows.ms}`);
   const quit=await work;assert.equal(quit.status,200,quit.body);timings.push({strictMs:quit.ms,pingMs:ping.ms,firstRowsMs:rows.ms});
  }
  fs.writeFileSync(path.join(runs,'0/failure.json'),'{"error":"late failure"}');
  assert.equal((await request('/api/quit',{})).status,409);
  await assert.rejects(hub.chats.send({project:p.id,task:task.id,ai:'codex',model:'gpt-6.1-sol',pdir:p.dir,dir:p.dir,text:'never starts'}),/終了保存/);
  assert.equal(hub.chats.running.size,0);assert.equal(fs.readdirSync(runs).length,4000);
  t.diagnostic(JSON.stringify({actualHub:true,runs:4000,noParentFullWalk:true,timings}));
 }finally{spool.pending=pending;hub?.chats.handoffAdmission?.close();hub?.webchat.shutdown();hub?.sessions.stopAll();if(hub?.server.listening)await new Promise(r=>hub.server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
