'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-spool-http-'));
Object.assign(process.env,{HUB_ROOT:path.join(tmp,'root'),HUB_FREETALK_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:'0'});
const runtime=require('../server'),{IdeaRunEvidence}=require('../lib/idea-run-evidence');let base,evidence;
test.before(async()=>{await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;await(await fetch(base+'/api/ping')).text();});
test.after(async()=>{evidence?.spoolIndex?.close();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('large spool cold scan and 4000-entry retained index leave actual Hub ping below 100ms',async()=>{
 const spoolRoot=path.join(tmp,'spools');fs.mkdirSync(spoolRoot);const payload='x'.repeat(2*1024*1024);
 for(let n=0;n<4000;n++){const dir=path.join(spoolRoot,String(n).padStart(4,'0'));fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({options:{request:'other',text:n<64?payload:''}}));}
 evidence=new IdeaRunEvidence({spoolRoot,ideas:{project:()=>({dir:tmp})},chats:{queue:()=>[],busy:()=>null}});const run={id:'r',task:'t',requestId:'r'};
 const first=evidence.evidence('P',run);assert.equal(first.state,'unknown');assert.ok(first.error);assert.ok(evidence.spoolIndex.pending);
 const ready=evidence.spoolIndex.ready(20000);let overlapping=0;const cold=[];
 const end=performance.now()+20000;while(evidence.spoolIndex.pending&&performance.now()<end){const at=performance.now(),response=await fetch(base+'/api/ping');await response.text();const ms=performance.now()-at;cold.push(ms);assert.ok(ms<100,'cold ping '+ms+'ms');overlapping++;await new Promise(r=>setTimeout(r,5));}
 assert.ok(overlapping>0);assert.equal(evidence.spoolIndex.pending,null);assert.ok(await ready);
 const at=performance.now();assert.equal(evidence.evidence('P',run).state,'absent');const warmMs=performance.now()-at;assert.ok(warmMs<100,'warm metadata validation '+warmMs+'ms');
 const count=evidence.spoolIndex.reads;const ping=performance.now();const pending=fetch(base+'/api/ping');assert.equal(evidence.evidence('P',run).state,'absent');await(await pending).text();const warmPingMs=performance.now()-ping;assert.ok(warmPingMs<100,'warm ping '+warmPingMs+'ms');assert.equal(evidence.spoolIndex.reads,count);
 console.log(JSON.stringify({folders:4000,largeRequests:64,largeBytes:64*payload.length,overlappingPings:overlapping,coldMaxMs:Math.max(...cold),warmMs,warmPingMs,reads:count}));
});
