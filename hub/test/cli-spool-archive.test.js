'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const S=require('../lib/cli-spool'),A=require('../lib/cli-spool-archive');
function fixture(t){
 const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'spool-archive-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const root=path.join(tmp,'cli-runs'),id=randomUUID(),dir=path.join(root,id),pdir=path.join(tmp,'project');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(pdir,'.ai/chat'),{recursive:true});
 const user={role:'user',turn:randomUUID(),request:'request-'+id},row={role:'assistant',request:user.request,text:'final saved',spoolId:id+':final'};
 const o={project:'project',task:'task',pdir,userRow:user,request:user.request,text:'ordinary'};
 fs.writeFileSync(path.join(pdir,'.ai/chat/task.jsonl'),[user,row].map(JSON.stringify).join('\n')+'\n');
 S.atomic(dir,'request.json',{options:o});S.atomic(dir,'owner.json',{pid:2147483647,serverId:'fixture',generation:1});S.atomic(dir,'exit.json',{code:0});fs.writeFileSync(path.join(dir,'out.jsonl'),'');
 const child=new S.SpoolChild(dir,{serverId:'fixture',generation:1});child.phase('finished',{finalRowHash:S.digest(JSON.stringify(row)),completionHash:S.completion(dir)});child.finish();
 const now=Date.now()+4*86400000,result=path.join(tmp,'result.json');return {tmp,root,dir,id,o,row,user,now,result,pdir};
}
test('archive moves exact bytes/modes once and keeps the pinned final chat row',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now});assert.equal(p.items.length,1);const before=A.snapshot(f.dir),chat=fs.readFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'));
 const r=A.apply(p,f.result);assert.equal(r.complete,true);assert.equal(r.moved.length,1);assert.equal(fs.existsSync(f.dir),false);assert.deepEqual(A.snapshot(r.moved[0].path),before);assert.deepEqual(fs.readFileSync(path.join(f.pdir,'.ai/chat/task.jsonl')),chat);
 assert.throws(()=>A.apply(p,f.result),/結果が既に/);assert.deepEqual(S.pending(f.root),[]);
});
for(const mode of ['young','protected','live-owner','changed-output','torn-final','queued','automation','wrong-final','hardlink','symlink'])test('archive holds unsafe evidence: '+mode,t=>{
 const f=fixture(t);let now=f.now,protectedProjects=[];
 if(mode==='young')now=Date.now();
 if(mode==='protected')protectedProjects=['project'];
 if(mode==='live-owner')S.atomic(f.dir,'owner.json',{pid:process.pid,serverId:'live',generation:1});
 if(mode==='changed-output')fs.appendFileSync(path.join(f.dir,'out.jsonl'),'changed');
 if(mode==='torn-final')fs.writeFileSync(path.join(f.dir,'finished.json'),'{');
 if(mode==='queued')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{id:f.user.request}]));
 if(mode==='automation'){const q=S.read(f.dir,'request.json');q.options.automation={id:'unknown'};S.atomic(f.dir,'request.json',q);}
 if(mode==='wrong-final')fs.appendFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'),JSON.stringify(f.row)+'\n');
 if(mode==='hardlink')fs.linkSync(path.join(f.dir,'out.jsonl'),path.join(f.dir,'linked'));
 if(mode==='symlink')fs.symlinkSync(path.join(f.dir,'out.jsonl'),path.join(f.dir,'linked'));
 const p=A.plan(f.root,{now,protectedProjects});assert.equal(p.items.length,0);assert.equal(p.skipped.length,1);assert.equal(fs.existsSync(f.dir),true);
});
test('archive plan does not override new evidence, an existing batch, or existing destination',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now});fs.writeFileSync(path.join(f.dir,'new-proof'),'new');assert.throws(()=>A.apply(p,f.result),/変わっています/);assert.equal(fs.existsSync(f.dir),true);
 const fresh=A.plan(f.root,{now:f.now});fs.mkdirSync(path.join(fresh.archiveRoot,fresh.id),{recursive:true});assert.throws(()=>A.apply(fresh,f.result),/EEXIST/);assert.equal(fs.existsSync(f.dir),true);
});
test('archive move failure leaves a receipt and forbids blind replay',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now}),rename=fs.renameSync;fs.renameSync=(a,b)=>{if(a===f.dir)throw Error('injected move failure');return rename(a,b);};
 try{assert.throws(()=>A.apply(p,f.result),/injected/);}finally{fs.renameSync=rename;}
 assert.equal(JSON.parse(fs.readFileSync(f.result)).complete,false);assert.equal(fs.existsSync(f.dir),true);assert.throws(()=>A.apply(p,f.result),/結果が既に/);
});
test('uncertain move preserves both the archived data and its active-operation marker',t=>{
 const f=fixture(t),p=A.plan(f.root,{now:f.now}),rename=fs.renameSync;let destination;
 fs.renameSync=(a,b)=>{const out=rename(a,b);if(a===f.dir){destination=b;fs.writeFileSync(path.join(b,'unexpected'),'preserved new evidence');}return out;};
 try{assert.throws(()=>A.apply(p,f.result),/退避後/);}finally{fs.renameSync=rename;}
 const out=JSON.parse(fs.readFileSync(f.result));assert.equal(out.complete,false);assert.equal(out.active,f.id);assert.equal(out.moved.length,0);assert.equal(fs.readFileSync(path.join(destination,'unexpected'),'utf8'),'preserved new evidence');assert.throws(()=>A.apply(p,f.result),/結果が既に/);
});
function history(f,{stage='committed',project='project',tamper=false}={}){
 const log=path.join(f.pdir,'.ai/chat/task.jsonl'),id=randomUUID(),base=path.join(f.pdir,'.ai/chat/history/task',id),raw=fs.readFileSync(log),mode=fs.statSync(log).mode&0o777;
 fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'0.original'),raw,{mode});
 const m={id,project,task:'task',generation:1,stage,entries:[{file:log,kind:'log',existed:true,saved:'0.original',bytes:raw.length,mode,digest:S.digest(raw)}]};
 fs.writeFileSync(path.join(base,'manifest.json'),JSON.stringify(m));fs.writeFileSync(log,'');if(tamper)fs.appendFileSync(path.join(base,'0.original'),' ');
 return {base,m,log};
}
function removed(f){
 const log=path.join(f.pdir,'.ai/chat/task.jsonl'),trash=path.join(f.tmp,'trash'),dest=path.join(trash,'removed-log'),id=randomUUID();fs.mkdirSync(trash);
 const fingerprint=require('../lib/remove').snapshot(log);fs.renameSync(log,dest);
 const record={id,project:'project',task:'task',kind:'task',error:'',entries:[{from:log,to:dest,fingerprint,moved:true,restored:false}]};
 fs.mkdirSync(path.join(f.tmp,'removed'));const file=path.join(f.tmp,'removed',id+'.json');fs.writeFileSync(file,JSON.stringify(record));return {log,trash,dest,file,record};
}
const options=(f,extra={})=>({now:f.now,...extra});
test('committed task history proves a finished turn and pins its exact original',t=>{
 const f=fixture(t),h=history(f),p=A.plan(f.root,options(f));assert.equal(p.items.length,1);assert.equal(p.items[0].evidence.kind,'history');assert.equal(p.items[0].evidence.source.file,path.join(h.base,'0.original'));
 A.apply(p,f.result);assert.equal(fs.existsSync(h.log),true);assert.equal(fs.existsSync(path.join(h.base,'0.original')),true);
});
for(const mode of ['uncommitted','wrong-project','tampered','wrong-user','no-original','symlink-original','queue'])test('history retains unsafe or incomplete proof: '+mode,t=>{
 const f=fixture(t),h=history(f,{stage:mode==='uncommitted'?'switching':'committed',project:mode==='wrong-project'?'elsewhere':'project',tamper:mode==='tampered'});
 if(mode==='wrong-user'){const file=path.join(h.base,'0.original'),raw=Buffer.from([ {...f.user,text:'not the requested turn'},f.row].map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(file,raw);h.m.entries[0].bytes=raw.length;h.m.entries[0].digest=S.digest(raw);fs.writeFileSync(path.join(h.base,'manifest.json'),JSON.stringify(h.m));}
 if(mode==='no-original')fs.unlinkSync(path.join(h.base,'0.original'));
 if(mode==='symlink-original'){fs.renameSync(path.join(h.base,'0.original'),path.join(h.base,'elsewhere'));fs.symlinkSync(path.join(h.base,'elsewhere'),path.join(h.base,'0.original'));}
 if(mode==='queue')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{request:f.o.request}]));
 assert.equal(A.plan(f.root,options(f)).items.length,0);
});
test('formal removal proof is checked and rechecked without changing the deleted chat',t=>{
 const f=fixture(t),r=removed(f),p=A.plan(f.root,options(f,{trashRoot:r.trash}));assert.equal(p.items.length,1);assert.equal(p.items[0].evidence.kind,'removed');const raw=fs.readFileSync(r.dest);
 A.apply(p,f.result);assert.deepEqual(fs.readFileSync(r.dest),raw);assert.equal(fs.existsSync(r.log),false);
});
for(const mode of ['changed','restored','moving','wrong-project','outside-trash','missing','no-record'])test('removed proof retains unsafe evidence: '+mode,t=>{
 const f=fixture(t),r=removed(f);
 if(mode==='changed')fs.appendFileSync(r.dest,' ');
 if(mode==='restored'){r.record.entries[0].restored=true;fs.writeFileSync(r.file,JSON.stringify(r.record));}
 if(mode==='moving'){r.record.entries[0].moving=true;fs.writeFileSync(r.file,JSON.stringify(r.record));}
 if(mode==='wrong-project'){r.record.project='elsewhere';fs.writeFileSync(r.file,JSON.stringify(r.record));}
 if(mode==='outside-trash'){const dest=path.join(f.tmp,'not-trash');fs.renameSync(r.dest,dest);r.record.entries[0].to=dest;fs.writeFileSync(r.file,JSON.stringify(r.record));}
 if(mode==='missing')fs.unlinkSync(r.dest);
 if(mode==='no-record')fs.unlinkSync(r.file);
 assert.equal(A.plan(f.root,options(f,{trashRoot:r.trash})).items.length,0);
});
test('pinned history changes invalidate apply even when the spool did not change',t=>{
 const f=fixture(t),h=history(f),p=A.plan(f.root,options(f));fs.appendFileSync(path.join(h.base,'0.original'),' ');assert.throws(()=>A.apply(p,f.result),/変わって/);assert.equal(fs.existsSync(f.dir),true);
});
test('recursive supervisor files preserve all bytes and permissions, and restore is single-use',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.dir,'platform'),{mode:0o700});fs.writeFileSync(path.join(f.dir,'platform','fixture.js'),'read only worker',{mode:0o640});
 const p=A.plan(f.root,options(f)),before=A.snapshot(f.dir);assert.equal(p.items.length,1);A.apply(p,f.result);const restore=path.join(f.tmp,'restore.json');assert.equal(A.restore(p,restore).complete,true);assert.deepEqual(A.snapshot(f.dir),before);assert.throws(()=>A.restore(p,restore),/既に/);
});
test('restoration refuses new originals and altered archived evidence',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));A.apply(p,f.result);fs.mkdirSync(f.dir);fs.writeFileSync(path.join(f.dir,'new'),'keep me');assert.throws(()=>A.restore(p,path.join(f.tmp,'restore.json')),/上書き/);assert.equal(fs.readFileSync(path.join(f.dir,'new'),'utf8'),'keep me');
 const g=fixture(t),q=A.plan(g.root,options(g));A.apply(q,g.result);fs.appendFileSync(path.join(q.archiveRoot,q.id,g.id,'out.jsonl'),'changed');assert.throws(()=>A.restore(q,path.join(g.tmp,'restore.json')),/変わって/);
});
test('a post-rename interruption is recoverable from the fixed plan without replaying apply',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),rename=fs.renameSync;fs.renameSync=(a,b)=>{const result=rename(a,b);if(a===f.dir)throw Error('after rename');return result;};
 try{assert.throws(()=>A.apply(p,f.result),/after rename/);}finally{fs.renameSync=rename;}
 assert.equal(JSON.parse(fs.readFileSync(f.result)).active,f.id);assert.equal(A.restore(p,path.join(f.tmp,'restore.json')).complete,true);assert.equal(fs.existsSync(f.dir),true);
});
test('archived identities remain delivery evidence; unknown delivery never becomes absent or erasable',async t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),Index=require('../lib/idea-spool-index').IdeaSpoolIndex,index=new Index(f.root);t.after(()=>index.close());
 const before=await index.ready(10000);assert.ok(before.some(e=>e.request?.options.request===f.o.request));A.apply(p,f.result);const after=await index.ready(10000);assert.ok(after.some(e=>e.name===f.id&&e.request?.options.request===f.o.request));
 const Evidence=require('../lib/idea-run-evidence').IdeaRunEvidence,E=new Evidence({spoolRoot:f.root,spoolIndex:index,ideas:{project:()=>({dir:f.pdir})},chats:{queue:()=>[],busy:()=>null}});
 fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'),'');const r={id:randomUUID(),task:'task',requestId:f.o.request,spoolIds:[]};assert.equal(E.evidence('project',r).state,'unknown');assert.equal(E.evidence('project',r).spools[0].id,f.id);
 assert.equal(A.locate(p,f.id),path.join(p.archiveRoot,p.id,f.id));
});
test('archive catalog corruption fences absence and an interrupted move still preserves identity evidence',async t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));A.apply(p,f.result);const file=path.join(f.root,'archive-'+p.id+'.json');fs.writeFileSync(file,'{');const index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());assert.equal(await index.ready(10000),null);assert.ok(index.error);
});
test('legacy freetalk trash without a committed, content-bound manifest remains retained',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.pdir,'.ai/chat/task.jsonl'));const q=S.read(f.dir,'request.json');q.options.project='freetalk';S.atomic(f.dir,'request.json',q);
 const child=new S.SpoolChild(f.dir,{serverId:'fixture',generation:1});child.phase('finished',{finalRowHash:S.digest(JSON.stringify(f.row)),completionHash:S.completion(f.dir)});child.finish();const p=A.plan(f.root,options(f));assert.equal(p.items.length,0);assert.match(p.skipped[0].reason,/自由対話/);
});
test('loss of an archive catalog is unknown, never absence even after index restart',async t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));A.apply(p,f.result);fs.unlinkSync(path.join(f.root,'archive-'+p.id+'.json'));
 const index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());assert.equal(await index.ready(10000),null);assert.ok(index.error);
});
test('restoration interruption preserves an active marker and rejects blind replay',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));A.apply(p,f.result);const rename=fs.renameSync,result=path.join(f.tmp,'restore.json');
 fs.renameSync=(a,b)=>{const value=rename(a,b);if(b===f.dir)throw Error('restoration interrupted');return value;};
 try{assert.throws(()=>A.restore(p,result),/interrupted/);}finally{fs.renameSync=rename;}
 assert.equal(JSON.parse(fs.readFileSync(result)).active,f.id);assert.equal(fs.existsSync(f.dir),true);assert.throws(()=>A.restore(p,path.join(f.tmp,'another-restore.json')),/復元する原物/);
});
test('project-level formal removal resolves the log only inside its fingerprinted project tree',t=>{
 const f=fixture(t),trash=path.join(f.tmp,'trash'),dest=path.join(trash,'project'),id=randomUUID();fs.mkdirSync(trash);
 const fingerprint=require('../lib/remove').snapshot(f.pdir);fs.renameSync(f.pdir,dest);fs.mkdirSync(path.join(f.tmp,'removed'));
 fs.writeFileSync(path.join(f.tmp,'removed',id+'.json'),JSON.stringify({id,project:'project',kind:'project',error:'',entries:[{from:f.pdir,to:dest,fingerprint,moved:true,restored:false}]}));
 const p=A.plan(f.root,options(f,{trashRoot:trash}));assert.equal(p.items.length,1);assert.equal(p.items[0].evidence.kind,'removed');
});
for(const mode of ['failure','generation','private-link','queue-after-plan'])test('new archive boundaries preserve unresolved and unsafe evidence: '+mode,t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));
 if(mode==='failure')S.atomic(f.dir,'failure.json',{stage:'finished',error:'keep unresolved'});
 if(mode==='generation')S.atomic(f.dir,'owner.json',{pid:2147483647,serverId:'fixture',generation:2});
 if(mode==='private-link'){fs.mkdirSync(path.join(f.dir,'platform'));fs.symlinkSync(path.join(f.dir,'out.jsonl'),path.join(f.dir,'platform','link'));}
 if(mode==='queue-after-plan')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{request:f.o.request}]));
 assert.throws(()=>A.apply(p,f.result));assert.equal(fs.existsSync(f.dir),true);
});
test('cross-device move refusal is recorded before any rename of original data',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),stat=fs.statSync;fs.statSync=(file,...args)=>{const s=stat(file,...args);return file===path.join(p.archiveRoot,p.id)?new Proxy(s,{get:(obj,key)=>key==='dev'?s.dev+1:obj[key]}):s;};
 try{assert.throws(()=>A.apply(p,f.result),/同じディスク/);}finally{fs.statSync=stat;}
 assert.equal(JSON.parse(fs.readFileSync(f.result)).active,f.id);assert.equal(fs.existsSync(f.dir),true);
});
test('a well-formed catalog with a removed identity cannot hide delivery evidence',async t=>{
 const f=fixture(t),p=A.plan(f.root,options(f));A.apply(p,f.result);const file=path.join(f.root,'archive-'+p.id+'.json'),catalog=JSON.parse(fs.readFileSync(file));catalog.items=[];fs.writeFileSync(file,JSON.stringify(catalog));
 const index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());assert.equal(await index.ready(10000),null);assert.ok(index.error);
});
// A v1 batch was created by the old maintenance tool, without a delivery catalog.
function legacyBatch(f){
 const p=A.plan(f.root,options(f));p.version=1;delete p.trashRoot;
 for(const item of p.items){delete item.evidence;delete item.delivery;}
 const batch=path.join(p.archiveRoot,p.id);fs.mkdirSync(batch,{recursive:true});fs.writeFileSync(path.join(batch,'plan.json'),JSON.stringify(p));for(const item of p.items)fs.renameSync(path.join(p.root,item.name),path.join(batch,item.name));return p;
}
test('legacy v1 without a catalog retains archived delivery identities and restores exact originals',async t=>{
 const f=fixture(t),before=A.snapshot(f.dir),p=legacyBatch(f),index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());
 assert.equal(fs.existsSync(path.join(f.root,'archive-'+p.id+'.json')),false);
 const entries=await index.ready(10000);assert.equal(entries.length,1);assert.equal(entries[0].name,f.id);assert.equal(entries[0].request.options.request,f.o.request);
 assert.equal(A.locate(p,f.id),path.join(p.archiveRoot,p.id,f.id));assert.equal(A.restore(p,path.join(f.tmp,'restore-v1.json')).complete,true);assert.deepEqual(A.snapshot(f.dir),before);
 assert.equal(index.snapshot(),null,'restoration invalidates the archived snapshot');const restored=await index.ready(10000);assert.equal(index.error,null);assert.equal(restored.length,1);assert.equal(restored[0].name,f.id);assert.equal(restored[0].request.options.request,f.o.request);
 assert.throws(()=>A.apply(p,f.result),/退避計画が不正/,'legacy plans are read/restore-only');
});
test('legacy v1 partial formal restoration retains both restored and archived delivery identities',async t=>{
 const f=fixture(t),g=fixture(t);fs.renameSync(g.dir,path.join(f.root,g.id));const p=legacyBatch(f),index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());
 const before=await index.ready(10000);assert.equal(before.length,2);const first=p.items[0].name,rename=fs.renameSync,result=path.join(f.tmp,'restore-v1.json');
 fs.renameSync=(src,dst)=>{const value=rename(src,dst);if(dst===path.join(f.root,first))throw Error('restoration interrupted after first move');return value;};
 try{assert.throws(()=>A.restore(p,result),/interrupted/);}finally{fs.renameSync=rename;}
 assert.equal(JSON.parse(fs.readFileSync(result)).active,first);assert.equal(JSON.parse(fs.readFileSync(result)).complete,false);assert.equal(fs.existsSync(path.join(f.root,first)),true);assert.equal(fs.existsSync(path.join(p.archiveRoot,p.id,p.items[1].name)),true);
 assert.equal(index.snapshot(),null);const entries=await index.ready(10000);assert.equal(index.error,null);assert.equal(entries.length,2);assert.deepEqual(entries.map(e=>[e.name,e.request.options.request]).sort(),before.map(e=>[e.name,e.request.options.request]).sort());
});
for(const mode of ['intent-missing','original-missing','original-file','original-link','unexpected-archive-item'])test('legacy v1 restoration still fences missing or ambiguous evidence: '+mode,async t=>{
 const f=fixture(t),p=legacyBatch(f),index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());assert.ok(await index.ready(10000));
 A.restore(p,path.join(f.tmp,'restore-v1.json'));assert.ok(await index.ready(10000));const batch=path.join(p.archiveRoot,p.id);
 if(mode==='intent-missing')fs.unlinkSync(path.join(batch,'restore-intent.json'));
 if(mode==='original-missing')fs.renameSync(f.dir,path.join(f.tmp,'missing-original'));
 if(mode==='original-file'){fs.renameSync(f.dir,path.join(f.tmp,'missing-original'));fs.writeFileSync(f.dir,'not a directory');}
 if(mode==='original-link'){fs.renameSync(f.dir,path.join(f.tmp,'missing-original'));fs.symlinkSync(path.join(f.tmp,'missing-original'),f.dir);}
 if(mode==='unexpected-archive-item')fs.mkdirSync(path.join(batch,randomUUID()));
 assert.equal(index.snapshot(),null);assert.equal(await index.ready(10000),null);assert.ok(index.error);
});
test('legacy v1 missing entries require a restore intent even when originals exist, and intent creation invalidates failure cache',async t=>{
 const f=fixture(t),p=legacyBatch(f),batch=path.join(p.archiveRoot,p.id),index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());assert.ok(await index.ready(10000));
 fs.renameSync(path.join(batch,f.id),f.dir);assert.equal(await index.ready(10000),null);assert.ok(index.error);
 fs.writeFileSync(path.join(batch,'restore-intent.json'),JSON.stringify({resultFile:path.join(f.tmp,'restore-v1.json')}));const entries=await index.ready(10000);assert.equal(index.error,null);assert.equal(entries.length,1);assert.equal(entries[0].request.options.request,f.o.request);
});
for(const mode of ['plan-missing','version','id','root','archiveRoot','item-missing','extra-item','request-missing','request-changed','plan-hash'])test('legacy v1 incomplete or changed proof fences delivery absence: '+mode,async t=>{
 const f=fixture(t),p=legacyBatch(f),index=new (require('../lib/idea-spool-index').IdeaSpoolIndex)(f.root);t.after(()=>index.close());
 assert.ok(await index.ready(10000));const file=path.join(p.archiveRoot,p.id,'plan.json');
 if(mode==='plan-missing')fs.unlinkSync(file);
 else if(mode==='item-missing')fs.rmSync(path.join(p.archiveRoot,p.id,f.id),{recursive:true});
 else if(mode==='request-missing')fs.unlinkSync(path.join(p.archiveRoot,p.id,f.id,'request.json'));
 else if(mode==='request-changed')fs.writeFileSync(path.join(p.archiveRoot,p.id,f.id,'request.json'),JSON.stringify({options:{request:'other'}}));
 else {if(mode==='version')p.version=2;if(mode==='id')p.id=randomUUID();if(mode==='root')p.root+='/elsewhere';if(mode==='archiveRoot')p.archiveRoot+='/elsewhere';if(mode==='extra-item')p.items=[];if(mode==='plan-hash')p.items[0].files[0].sha256='changed';fs.writeFileSync(file,JSON.stringify(p));}
 assert.equal(await index.ready(10000),null);assert.ok(index.error);
});
test('legacy v1 restoration refuses a new original, a changed plan, and changed archived content',t=>{
 for(const mode of ['original','plan','content']){
  const f=fixture(t),p=legacyBatch(f);
  if(mode==='original'){fs.mkdirSync(f.dir);fs.writeFileSync(path.join(f.dir,'new'),'keep');}
  if(mode==='plan')fs.appendFileSync(path.join(p.archiveRoot,p.id,'plan.json'),'bad');
  if(mode==='content')fs.appendFileSync(path.join(p.archiveRoot,p.id,f.id,'out.jsonl'),'new');
  assert.throws(()=>A.restore(p,path.join(f.tmp,'restore-v1.json')));assert.ok(fs.existsSync(path.join(p.archiveRoot,p.id,f.id)));
  if(mode==='original')assert.equal(fs.readFileSync(path.join(f.dir,'new'),'utf8'),'keep');
 }
});
for(const phase of ['waiting','blocked'])test('continuation '+phase+' holds its source spool at planning and immediate pre-move recheck',t=>{
 const f=fixture(t),file=path.join(f.pdir,'.ai/chat/task.unfinished.json'),p=A.plan(f.root,options(f)),d={version:1,entries:{},advances:{[f.user.turn]:{phase,source:{spool:f.dir}}}};
 fs.writeFileSync(file,JSON.stringify(d));const held=A.plan(f.root,options(f));assert.equal(held.items.length,0);assert.equal(held.skipped[0].reason,'未解決・処理中の記録は保持');
 assert.throws(()=>A.apply(p,f.result),/未解決・処理中/);assert.equal(fs.existsSync(path.join(p.archiveRoot,p.id)),false);
 // Also race after the batch/catalog is created, past the all-input preflight.
 fs.unlinkSync(file);const next=A.plan(f.root,options(f)),open=fs.openSync;
 fs.openSync=(name,...args)=>{const fd=open(name,...args);if(name===path.join(f.root,'archive-'+next.id+'.json'))fs.writeFileSync(file,JSON.stringify(d));return fd;};
 try{assert.throws(()=>A.apply(next,f.result),/未解決・処理中/);}finally{fs.openSync=open;}
 assert.equal(fs.existsSync(f.dir),true);const out=JSON.parse(fs.readFileSync(f.result));assert.equal(out.complete,false);assert.equal(out.moved.length,0);
});
test('completed continuation references do not retain finished runs',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.unfinished.json'),JSON.stringify({version:1,entries:{},advances:{a:{phase:'started',source:{spool:f.dir}}}}));assert.equal(A.plan(f.root,options(f)).items.length,1);
});

// Existing receipts/plans remain byte-for-byte valid; no new birth field is
// added to historical records. Only the native process probe changes.
const platform=require('../lib/platform');
function pidFixture(t,role='owner'){
 const f=fixture(t),pid=2147483647,endedAt=Math.floor((Date.now()-4*86400000)/1000)*1000;
 if(role!=='owner')S.atomic(f.dir,'owner.json',{pid:2147483646,serverId:'fixture',generation:1});
 if(role==='launch')S.atomic(f.dir,'launch.json',{supervisorPid:pid});
 if(role==='supervisor')S.atomic(f.dir,'started.json',{supervisorPid:pid});
 if(role==='cli')S.atomic(f.dir,'started.json',{cliPid:pid});
 const child=new S.SpoolChild(f.dir,{serverId:'fixture',generation:1});
 child.phase('finished',{finalRowHash:S.digest(JSON.stringify(f.row)),completionHash:S.completion(f.dir)});
 const clock=Date.now;Date.now=()=>endedAt;try{child.finish();}finally{Date.now=clock;}
 return {...f,pid,endedAt};
}
function nativeBirth(ms){const d=new Date(ms),pad=n=>String(n).padStart(2,'0');return ['Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d.getDay()],'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getMonth()],d.getDate(),[d.getHours(),d.getMinutes(),d.getSeconds()].map(pad).join(':'),d.getFullYear()].join(' ');}
function pidProbe(t,f,{state=()=> 'present',scan,osName='darwin'}={}){
 const oldName=platform.name;platform.name=osName;t.after(()=>{platform.name=oldName;});
 let probes=0,scans=0;
 t.mock.method(process,'kill',(pid,signal)=>{
  assert.equal(signal,0,'read-only existence probe only');
  const value=pid===f.pid?state(++probes):'absent';
  if(value!=='present')throw Object.assign(Error(value),{code:value==='absent'?'ESRCH':value});
 });
 const row={pid:f.pid,ppid:1,pgid:f.pid,uid:501,since:nativeBirth(f.endedAt+2*86400000),command:'/system/unrelated'};
 t.mock.method(platform,'processSnapshot',()=>{scans++;return scan?scan(scans,{...row}):[{...row}];});
 return {counts:()=>({probes,scans})};
}
for(const role of ['owner','launch','supervisor','cli'])test('reused '+role+' PID passes an unchanged approved plan and preserves exact receipt bytes',t=>{
 const f=pidFixture(t,role);let live=false;const probe=pidProbe(t,f,{state:()=>live?'present':'absent'});
 const p=A.plan(f.root,options(f)),raw=JSON.stringify(p),before=A.snapshot(f.dir);assert.equal(p.items.length,1);
 live=true;const r=A.apply(p,f.result);assert.equal(r.complete,true);assert.equal(r.moved.length,1);
 assert.equal(JSON.stringify(p),raw);assert.deepEqual(A.snapshot(r.moved[0].path),before);
 assert.deepEqual(probe.counts(),{probes:6,scans:4},'fresh native checks at whole-plan and per-item guards');
});
for(const mode of ['same-process','before-finish','same-second','one-second-boundary','unknown-time','invalid-date','bad-weekday','future','missing','duplicate','snapshot-error','permission-error','changed-birth','changed-owner','changed-command','changed-group','exits-between-scans','exits-after-scans','reappears','EIO','EACCES'])test('PID reuse holds unsafe or racing evidence: '+mode,t=>{
 const f=pidFixture(t);let scan;
 const at=mode==='same-process'?f.endedAt-86400000:mode==='before-finish'?f.endedAt-1000:mode==='same-second'?f.endedAt:mode==='one-second-boundary'?f.endedAt+1000:Date.now()+86400000;
 scan=(n,row)=>{
  if(['same-process','before-finish','same-second','one-second-boundary','future'].includes(mode))row.since=nativeBirth(at);
  if(mode==='unknown-time')row.since='';
  if(mode==='invalid-date')row.since='Mon Feb 30 12:00:00 2026';
  if(mode==='bad-weekday')row.since=row.since.replace(/^\w+/,row.since.startsWith('Mon')?'Tue':'Mon');
  if(mode==='snapshot-error')throw Error('timeout');
  if(mode==='permission-error')throw Object.assign(Error('denied'),{code:'EACCES'});
  if(mode==='missing'||mode==='exits-between-scans'&&n===2)return [];
  if(mode==='duplicate')return [row,{...row}];
  if(n===2){if(mode==='changed-birth')row.since=nativeBirth(f.endedAt+3*86400000);if(mode==='changed-owner')row.uid=0;if(mode==='changed-command')row.command='/system/other';if(mode==='changed-group')row.pgid++;}
  return [row];
 };
 const probe=pidProbe(t,f,{scan,state:n=>['EIO','EACCES'].includes(mode)?mode:mode==='reappears'?(n===1?'absent':'present'):mode==='exits-after-scans'?(n===1?'present':'absent'):'present'});
 const before=A.snapshot(f.dir),p=A.plan(f.root,options(f));assert.equal(p.items.length,0);assert.match(p.skipped[0].reason,/稼働中または起動時刻/);assert.deepEqual(A.snapshot(f.dir),before);
 assert.equal(fs.existsSync(f.result),false);if(['EIO','EACCES','reappears'].includes(mode))assert.equal(probe.counts().scans,0);
});
test('EPERM existence reaches birth checks at both apply guards for an unrelated root process',t=>{
 const f=pidFixture(t);let live=false;
 const probe=pidProbe(t,f,{state:()=>live?'EPERM':'absent',scan:(n,row)=>[{...row,uid:0}]});
 const p=A.plan(f.root,options(f)),raw=JSON.stringify(p),before=A.snapshot(f.dir);assert.equal(p.items.length,1);
 live=true;const r=A.apply(p,f.result);assert.equal(r.complete,true);assert.equal(r.moved.length,1);
 assert.equal(JSON.stringify(p),raw);assert.deepEqual(A.snapshot(r.moved[0].path),before);
 assert.deepEqual(probe.counts(),{probes:6,scans:4});
});
for(const mode of ['before-finish','same-second','one-second-boundary','missing','duplicate','changed','exits-after-scans'])test('EPERM preserves unsafe or racing birth evidence: '+mode,t=>{
 const f=pidFixture(t),probe=pidProbe(t,f,{state:n=>mode==='exits-after-scans'&&n>1?'absent':'EPERM',scan:(n,row)=>{
  row.uid=0;
  if(['before-finish','same-second','one-second-boundary'].includes(mode))row.since=nativeBirth(f.endedAt+({'before-finish':-1000,'same-second':0,'one-second-boundary':1000}[mode]));
  if(mode==='missing')return [];
  if(mode==='duplicate')return [row,{...row}];
  if(mode==='changed'&&n===2)row.since=nativeBirth(f.endedAt+3*86400000);
  return [row];
 }});
 const before=A.snapshot(f.dir),p=A.plan(f.root,options(f));assert.equal(p.items.length,0);
 assert.match(p.skipped[0].reason,/稼働中または起動時刻/);assert.deepEqual(A.snapshot(f.dir),before);
 assert.equal(fs.existsSync(f.result),false);assert.equal(probe.counts().scans,2);
});
for(const stage of ['preflight','per-item'])test('PID liveness is freshly checked at apply '+stage+' guard without moving any data',t=>{
 const f=pidFixture(t);let live=false,checks=0;pidProbe(t,f,{state:()=>live?'present':'absent',scan:(n,row)=>{
  // Each eligible call uses two native snapshots. Only the per-item guard
  // changes when requested, after the whole-plan guard already succeeded.
  checks++;if(stage==='preflight'||n>2)row.since=nativeBirth(f.endedAt-1000);return [row];
 }});
 const p=A.plan(f.root,options(f)),before=A.snapshot(f.dir);assert.equal(p.items.length,1);live=true;
 assert.throws(()=>A.apply(p,f.result),/稼働中または起動時刻/);assert.deepEqual(A.snapshot(f.dir),before);
 if(stage==='preflight'){assert.equal(fs.existsSync(path.join(p.archiveRoot,p.id)),false);assert.equal(fs.existsSync(f.result),false);assert.equal(checks,2);}
 else{const r=JSON.parse(fs.readFileSync(f.result));assert.equal(r.complete,false);assert.equal(r.active,f.id);assert.equal(r.moved.length,0);assert.equal(checks,4);assert.throws(()=>A.apply(p,f.result),/結果が既に/);}
});
for(const mode of ['valid','invalid','boundary'])test('Windows UTC birth reuse stays within the same archive guard: '+mode,t=>{
 const f=pidFixture(t),owner='S-1-5-21-100-200-300-1001';
 t.mock.method(platform,'processOwner',r=>r?.sid);
 pidProbe(t,f,{osName:'win32',scan:(n,row)=>[{...row,sid:owner,command:'C:\\Windows\\other.exe',since:mode==='invalid'?'2026-02-30T12:00:00.0000000Z':new Date(f.endedAt+(mode==='boundary'?1000:86400000)).toISOString().replace(/(\.\d{3})Z$/,'$10000Z')}]});
 const p=A.plan(f.root,options(f));assert.equal(p.items.length,mode==='valid'?1:0);
});
test('existing Linux adapter provides second-precision birth evidence without new commands',t=>{
 const f=pidFixture(t);pidProbe(t,f,{osName:'linux'});assert.equal(A.plan(f.root,options(f)).items.length,1);
});
test('PID reuse never bypasses authenticated completion or the pinned conversation evidence',t=>{
 for(const mode of ['completion','receipt','final-row','generation']){
  const f=pidFixture(t);const probe=pidProbe(t,f);
  if(mode==='completion')fs.appendFileSync(path.join(f.dir,'out.jsonl'),'changed');
  if(mode==='receipt')S.atomic(f.dir,'finished.json',{at:f.endedAt,generation:1,proofRequired:1});
  if(mode==='final-row')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.jsonl'),'');
  if(mode==='generation')S.atomic(f.dir,'owner.json',{pid:f.pid,serverId:'fixture',generation:2});
  assert.equal(A.plan(f.root,options(f)).items.length,0);assert.equal(probe.counts().scans,0);t.mock.restoreAll();
 }
});
test('ambiguous daylight-saving local births remain held',t=>{
 const tz=process.env.TZ;process.env.TZ='America/New_York';t.after(()=>{if(tz===undefined)delete process.env.TZ;else process.env.TZ=tz;});
 t.mock.method(Date,'now',()=>Date.parse('2026-11-04T12:00:00Z'));
 const f=pidFixture(t);pidProbe(t,f,{scan:(n,row)=>[{...row,since:'Sun Nov 1 01:30:00 2026'}]});
 const p=A.plan(f.root,options(f));assert.equal(p.items.length,0);assert.match(p.skipped[0].reason,/起動時刻/);
});
for(const reused of [true,false])test('real native snapshots '+(reused?'accept a later unrelated child':'retain the still-running original process'),async t=>{
 const f=fixture(t),child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>child.kill('SIGKILL'));await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 S.atomic(f.dir,'owner.json',{pid:child.pid,serverId:'fixture',generation:1});
 const receipt=new S.SpoolChild(f.dir,{serverId:'fixture',generation:1}),clock=Date.now;
 if(reused)Date.now=()=>clock()-4*86400000;try{receipt.finish();}finally{Date.now=clock;}
 const before=A.snapshot(f.dir),p=A.plan(f.root,options(f));assert.equal(p.items.length,reused?1:0);
 if(reused){assert.equal(A.apply(p,f.result).complete,true);assert.deepEqual(A.snapshot(path.join(p.archiveRoot,p.id,f.id)),before);assert.equal(child.exitCode,null);}
 else{assert.match(p.skipped[0].reason,/起動時刻/);assert.deepEqual(A.snapshot(f.dir),before);}
});

// Append-only compatibility for already approved v2 plans. All checks use the
// same product predicate as both apply guards; no plan/hash is regenerated.
const chatFile=f=>path.join(f.pdir,'.ai/chat/task.jsonl');
const laterRows=()=>[{role:'user',turn:randomUUID(),request:randomUUID(),text:'続き🙂'}, {role:'assistant',text:'新しい返事'}].map(JSON.stringify).join('\n')+'\n';
test('approved active proof accepts complete UTF-8 append without changing plan, originals or chat',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),saved=JSON.stringify(p),before=A.snapshot(f.dir);
 fs.appendFileSync(chatFile(f),laterRows());const chat=fs.readFileSync(chatFile(f));
 assert.equal(A.matchesProof(f.dir,p,p.items[0]),true);
 const out=A.apply(p,f.result);assert.equal(out.complete,true);assert.deepEqual(A.snapshot(out.moved[0].path),before);
 assert.equal(JSON.stringify(p),saved);assert.deepEqual(fs.readFileSync(chatFile(f)),chat);
 assert.equal(fs.readFileSync(path.join(p.archiveRoot,p.id,'plan.json'),'utf8'),JSON.stringify(p,null,2));
});
for(const mode of ['prefix-edit','shorter','same-length','invalid-json','partial-line','no-newline','invalid-utf8','duplicate-user','duplicate-final','conflicting-final','conflicting-request-user','conflicting-request-final','queue','unfinished','deleted','moved','symlink','hardlink','mode','kind','path','pins'])test('append-only proof retains unsafe input: '+mode,t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),log=chatFile(f),raw=fs.readFileSync(log),before=A.snapshot(f.dir);let suffix=laterRows();
 if(mode==='prefix-edit'){const b=Buffer.from(raw);b[b.indexOf(Buffer.from('final saved'))]=0x46;fs.writeFileSync(log,b);}
 if(mode==='shorter')fs.writeFileSync(log,raw.subarray(0,raw.length-1));
 if(mode==='same-length'){const b=Buffer.from(raw);b[b.indexOf(Buffer.from('final saved'))]=0x46;fs.writeFileSync(log,b);suffix='';}
 if(mode==='invalid-json')suffix='not json\n';
 if(mode==='partial-line')suffix='{"role":"user"';
 if(mode==='no-newline')suffix=JSON.stringify({role:'user',turn:randomUUID()});
 if(mode==='invalid-utf8')suffix=Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xc0,0xaf]),Buffer.from('"}\n')]);
 if(mode==='duplicate-user')suffix=JSON.stringify(f.user)+'\n';
 if(mode==='duplicate-final')suffix=JSON.stringify(f.row)+'\n';
 if(mode==='conflicting-final')suffix=JSON.stringify({...f.row,text:'conflicting completion'})+'\n';
 if(mode==='conflicting-request-user')suffix=JSON.stringify({...f.user,turn:randomUUID()})+'\n';
 if(mode==='conflicting-request-final')suffix=JSON.stringify({...f.row,spoolId:randomUUID()+':final'})+'\n';
 if(mode==='queue')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{request:f.o.request}]));
 if(mode==='unfinished')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.unfinished.json'),JSON.stringify({advances:{a:{phase:'waiting',source:{spool:f.dir}}}}));
 if(mode==='mode')fs.chmodSync(log,(fs.statSync(log).mode&0o777)^0o040);
 if(mode==='kind')p.items[0].evidence.kind='history';
 if(mode==='path')p.items[0].evidence.source.file+='.other';
 if(mode==='pins')p.items[0].evidence.pins.push({file:log,sha256:S.digest(raw),bytes:raw.length,mode:0o644});
 fs.appendFileSync(log,suffix);
 if(mode==='deleted')fs.unlinkSync(log);
 if(['moved','symlink'].includes(mode)){fs.renameSync(log,log+'.old');if(mode==='symlink')fs.symlinkSync(log+'.old',log);}
 if(mode==='hardlink')fs.linkSync(log,log+'.linked');
 assert.throws(()=>A.apply(p,f.result));assert.deepEqual(A.snapshot(f.dir),before);
 assert.equal(fs.existsSync(path.join(p.archiveRoot,p.id)),false);assert.equal(fs.existsSync(f.result),false);
});
for(const boundary of ['json-line','utf8-sequence'])test('append baseline must end at a complete line boundary: '+boundary,t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),log=chatFile(f);fs.appendFileSync(log,laterRows());const raw=fs.readFileSync(log);
 const n=boundary==='json-line'?p.items[0].evidence.source.bytes-1:raw.indexOf(Buffer.from('🙂'))+1;
 p.items[0].evidence.source.bytes=n;p.items[0].evidence.source.sha256=S.digest(raw.subarray(0,n));
 assert.throws(()=>A.apply(p,f.result),/原文部分/);assert.equal(fs.existsSync(f.dir),true);
});
for(const mode of ['history','removed'])test('append allowance never relaxes immutable '+mode+' proof',t=>{
 const f=fixture(t);let source,extra={};
 if(mode==='history')source=path.join(history(f).base,'0.original');
 else {const r=removed(f);source=r.dest;extra.trashRoot=r.trash;}
 const p=A.plan(f.root,options(f,extra));assert.equal(p.items.length,1);fs.appendFileSync(source,laterRows());
 assert.throws(()=>A.apply(p,f.result));assert.equal(fs.existsSync(f.dir),true);
});
for(const mode of ['duplicate-final','prefix-edit','mode','queue','unfinished'])test('reused proof context does not hide new '+mode,t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),c=require('../lib/spool-archive-proof').context(p.root,p.trashRoot),log=chatFile(f);
 fs.appendFileSync(log,laterRows());assert.equal(A.matchesProof(f.dir,p,p.items[0],c),true);
 if(mode==='duplicate-final')fs.appendFileSync(log,JSON.stringify({...f.row,text:'new conflicting final'})+'\n');
 if(mode==='prefix-edit')fs.writeFileSync(log,fs.readFileSync(log).toString().replace('final saved','FINAL SAVED'));
 if(mode==='mode')fs.chmodSync(log,(fs.statSync(log).mode&0o777)^0o040);
 if(mode==='queue')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{turn:f.user.turn}]));
 if(mode==='unfinished')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.unfinished.json'),JSON.stringify({advances:{a:{phase:'blocked',source:{spool:f.dir}}}}));
 assert.throws(()=>{if(!A.matchesProof(f.dir,p,p.items[0],c))throw Error('changed');});
});
for(const mode of ['append','prefix-edit','duplicate-final','queue','unfinished','mode'])test('per-item apply guard freshly checks '+mode+' after whole-plan check',t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),log=chatFile(f),rename=fs.renameSync,before=A.snapshot(f.dir);let changed=false;
 fs.appendFileSync(log,laterRows());
 t.mock.method(fs,'renameSync',(a,b)=>{
  const out=rename(a,b);
  if(b===f.result&&!changed){changed=true;
   if(mode==='append')fs.appendFileSync(log,laterRows());
   if(mode==='prefix-edit')fs.writeFileSync(log,fs.readFileSync(log).toString().replace('final saved','FINAL SAVED'));
   if(mode==='duplicate-final')fs.appendFileSync(log,JSON.stringify(f.row)+'\n');
   if(mode==='queue')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.queue.json'),JSON.stringify([{request:f.o.request}]));
   if(mode==='unfinished')fs.writeFileSync(path.join(f.pdir,'.ai/chat/task.unfinished.json'),JSON.stringify({advances:{a:{phase:'waiting',source:{spool:f.dir}}}}));
   if(mode==='mode')fs.chmodSync(log,(fs.statSync(log).mode&0o777)^0o040);
  }return out;
 });
 if(mode==='append')assert.equal(A.apply(p,f.result).complete,true);
 else{assert.throws(()=>A.apply(p,f.result));assert.deepEqual(A.snapshot(f.dir),before);const r=JSON.parse(fs.readFileSync(f.result));assert.equal(r.moved.length,0);assert.equal(r.active,f.id);assert.equal(r.complete,false);}
 assert.equal(changed,true);
});
for(const mode of ['append','replace','chmod','link','denied'])test('proof read rejects concurrent '+mode,t=>{
 const f=fixture(t),p=A.plan(f.root,options(f)),log=chatFile(f),read=fs.readFileSync,ino=fs.statSync(log).ino;let changed=false;
 t.mock.method(fs,'readFileSync',(file,...args)=>{
  if(typeof file==='number'&&fs.fstatSync(file).ino===ino&&!changed){changed=true;
   if(mode==='denied')throw Object.assign(Error('denied'),{code:'EACCES'});
   const raw=read(file,...args);
   if(mode==='append')fs.appendFileSync(log,laterRows());
   if(mode==='replace'){fs.renameSync(log,log+'.old');fs.writeFileSync(log,raw);}
   if(mode==='chmod')fs.chmodSync(log,(fs.statSync(log).mode&0o777)^0o040);
   if(mode==='link')fs.linkSync(log,log+'.linked');
   return raw;
  }return read(file,...args);
 });
 assert.throws(()=>A.apply(p,f.result));assert.equal(changed,true);assert.equal(fs.existsSync(f.dir),true);assert.equal(fs.existsSync(f.result),false);
});
