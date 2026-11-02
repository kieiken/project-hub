'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const chat=require('../lib/chat'),spool=require('../lib/cli-spool');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await pause(25);}throw Error('timeout');}
function fixture(){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-spool-')),root=path.join(dir,'runs'),pdir=path.join(dir,'ledger');fs.mkdirSync(pdir);const script=path.join(dir,'fake.cjs');fs.writeFileSync(script,`const fs=require('fs');fs.appendFileSync('launches','1');let n=0;process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));const t=setInterval(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:n%2?'agent_message':'command_execution',text:'text'+n,command:'command'+n}}));if(++n===12){clearInterval(t);console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));}},70);});`);return {dir,root,pdir,script};}
function launch(f,r,selectionOnly=false){const o={project:'fixture',task:'task',pdir:f.pdir,dir:f.dir,ai:'codex',model:'fixture',userRow:{at:new Date().toISOString(),turn:'turn'},text:'fixture',selectionOnly},turn={command:process.execPath,args:[f.script],stdin:'fixture',selectionOnly};return r.run(o,turn,{sessions:{},models:{}},[]);}
test('handoff reconstructs consumed text, exactly once tool/final rows; double adopt refused',async()=>{
 const f=fixture(),a=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir}),run=launch(f,a);await run.startedP;await until(()=>chat.read(f.pdir,'task').filter(r=>r.tool).length>=2);
 const runDir=run.child.dir;assert.ok(a.handoffSafe('fixture','task'));assert.throws(()=>spool.adopt(runDir,'other'),/別のHub/);
 await a.detachForRestart();const before=chat.read(f.pdir,'task').length;await pause(150);assert.equal(chat.read(f.pdir,'task').length,before);
 let settled=0;const b=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir,onSettled:()=>settled++});await b.adopt();assert.equal(b.adoptErrors.length,0);await b.adopt();assert.equal(b.adoptErrors.length,1);await until(()=>spool.read(runDir,'finished.json'));
 const rows=chat.read(f.pdir,'task');assert.equal(rows.filter(r=>r.tool).length,6);assert.equal(rows.filter(r=>r.role==='assistant').length,1);assert.equal(rows.at(-1).text,['text1','text3','text5','text7','text9','text11'].join('\n\n'));assert.equal(settled,1);assert.equal(chat.readMeta(f.pdir,'task').sessions.codex,'fixture-session');assert.equal(fs.readFileSync(path.join(f.dir,'launches'),'utf8'),'1');assert.equal(new Set(rows.map(r=>r.spoolId)).size,rows.length);
 assert.equal(fs.statSync(path.join(runDir,'request.json')).mode&0o777,0o600);assert.equal(fs.statSync(runDir).mode&0o777,0o700);assert.equal(spool.read(runDir,'request.json').options.env,undefined);assert.equal(spool.pending(f.root).length,0);fs.rmSync(f.dir,{recursive:true,force:true});
});
test('cancel reaches the CLI process group and persists a single stopped result',async()=>{
 const f=fixture(),r=new chat.ChatRunner({spoolRoot:f.root});const run=launch(f,r);await run.startedP;await pause(100);r.stop('fixture','task');assert.equal(r.handoffSafe('fixture','task'),false);await until(()=>spool.read(run.child.dir,'finished.json'));assert.equal(chat.read(f.pdir,'task').filter(x=>x.role==='assistant').length,1);assert.equal(chat.read(f.pdir,'task').at(-1).error,'止めました');fs.rmSync(f.dir,{recursive:true,force:true});
});
test('summary session classification survives Hub restart without replacing the original session',async()=>{
 const f=fixture(),original={sessions:{codex:'original-long-session'},models:{codex:'fixture'},rulesSent:{codex:{hash:'original'}}};chat.writeMeta(f.pdir,'task',original);
 const a=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir}),run=launch(f,a,true);await run.startedP;await until(()=>chat.read(f.pdir,'task').some(r=>r.tool));await a.detachForRestart();
 let settled=false;const b=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir,onSettled:o=>{assert.equal(o.selectionOnly,true);settled=true;}});await b.adopt();assert.equal(b.adoptErrors.length,0);await until(()=>spool.read(run.child.dir,'finished.json'));
 assert.equal(settled,true);assert.deepEqual(chat.readMeta(f.pdir,'task'),original);assert.equal(fs.readFileSync(path.join(f.dir,'launches'),'utf8'),'1');fs.rmSync(f.dir,{recursive:true,force:true});
});
test('saved cursor retry does not duplicate already appended tool/final rows',async()=>{
 const f=fixture(),r=new chat.ChatRunner({spoolRoot:f.root});const run=launch(f,r);await until(()=>spool.read(run.child.dir,'finished.json'));const before=chat.read(f.pdir,'task');fs.unlinkSync(path.join(run.child.dir,'finished.json'));run.child.release();
 let hooks=0;const next=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir,onAdoptEnd:()=>hooks++,onSettled:()=>hooks++});await next.adopt();assert.equal(next.adoptErrors.length,1);assert.equal(spool.read(run.child.dir,'finished.json'),null);await assert.rejects(next.sendQueued({project:'fixture',task:'task'}));
 const issue=next.handoffErrors()[0];next.recoverHandoff({project:'fixture',task:'task',run:path.basename(run.child.dir),token:issue.token});assert.ok(spool.read(run.child.dir,'finished.json'));assert.equal(next.handoffErrors().length,0);assert.equal(hooks,0);assert.deepEqual(chat.read(f.pdir,'task'),before);assert.equal(fs.readFileSync(path.join(f.dir,'launches'),'utf8'),'1');fs.rmSync(f.dir,{recursive:true,force:true});
});
test('a later CLI keeps boot worker bytes after replacement, and drains large UTF-8 output before exit',async()=>{
 const f=fixture(),moduleFile=path.join(f.dir,'supervisor.cjs');fs.copyFileSync(require.resolve('../lib/cli-spool'),moduleFile);fs.copyFileSync(require.resolve('../lib/owned-processes'),path.join(f.dir,'owned-processes.js'));fs.cpSync(path.dirname(require.resolve('../lib/platform')),path.join(f.dir,'platform'),{recursive:true});
 // Simulate a selected adapter's transitive dependency, without a Windows backend.
 const index=path.join(f.dir,'platform/index.js'),dependency=path.join(f.dir,'platform/fixture.js');
 fs.appendFileSync(index,"\nmodule.exports.supervisorFiles=Object.freeze([...module.exports.supervisorFiles,'fixture.js']);\n");
 fs.writeFileSync(dependency,"module.exports='boot generation';\n");
 fs.writeFileSync(path.join(f.dir,'platform/unselected.js'),'throw Error("must not bundle unrelated adapters");');
 const adapter=path.join(f.dir,'platform/darwin.js');fs.appendFileSync(adapter,"\nrequire('./fixture');\n");
 const persistenceFile=path.join(f.dir,'platform/persistence.js'),persistenceSource=fs.readFileSync(persistenceFile);
 const adapterSource=fs.readFileSync(adapter),dependencySource=fs.readFileSync(dependency);require(path.join(f.dir,'owned-processes.js')).snapshot();const pinned=require(moduleFile);fs.writeFileSync(moduleFile,'throw Error("mixed generation");');fs.writeFileSync(adapter,'throw Error("mixed platform generation");');fs.writeFileSync(dependency,'throw Error("mixed dependency generation");');fs.writeFileSync(persistenceFile,'throw Error("mixed persistence generation");');
 fs.writeFileSync(f.script,`const text='\u6f22\ud83d\ude42'.repeat(250000);process.stdin.resume();process.stdin.on('end',()=>console.log(text));`);
 const c=pinned.start(f.root,'fixture',{dir:f.dir},{command:process.execPath,args:[f.script],stdin:'one'},{},[],process.env);let output=[],closed=false;c.on('line',(l,n,replay)=>{assert.equal(replay,false);output.push(l);});c.on('close',code=>{assert.equal(code,0);closed=true;});c.on('spool-error',e=>{throw e;});c.start();await until(()=>closed);assert.deepEqual(output,['漢🙂'.repeat(250000)]);assert.doesNotMatch(fs.readFileSync(path.join(c.dir,'worker.cjs'),'utf8'),/mixed generation/);assert.deepEqual(fs.readFileSync(path.join(c.dir,'platform/darwin.js')),adapterSource);assert.deepEqual(fs.readFileSync(path.join(c.dir,'platform/fixture.js')),dependencySource);assert.deepEqual(fs.readFileSync(path.join(c.dir,'platform/persistence.js')),persistenceSource);assert.equal(fs.existsSync(path.join(c.dir,'platform/unselected.js')),false);assert.equal(fs.statSync(path.join(c.dir,'platform')).mode&0o777,0o700);for(const name of ['index.js','darwin.js','persistence.js','fixture.js','file-io.js'])assert.equal(fs.statSync(path.join(c.dir,'platform',name)).mode&0o777,0o600);const started=spool.read(c.dir,'started.json');assert.equal(started.ownershipError,undefined);assert.equal(started.identity.pid,started.cliPid);assert.equal(fs.statSync(path.join(c.dir,'platform')).mode&0o777,0o700);assert.equal(fs.statSync(path.join(c.dir,'platform/darwin.js')).mode&0o777,0o600);c.finish();fs.rmSync(f.dir,{recursive:true,force:true});
});

test('already completed supervisor reports spawn before queue acknowledgement and final consumption',async()=>{
 const f=fixture(),dir=path.join(f.root,'completed');fs.mkdirSync(dir,{recursive:true});
 const owner=spool.claim(dir,'fixture');spool.atomic(dir,'started.json',{supervisorPid:process.pid,cliPid:process.pid});
 fs.writeFileSync(path.join(dir,'out.jsonl'),JSON.stringify({n:1,line:'finished'})+'\n');spool.atomic(dir,'exit.json',{code:0,signal:null});
 const c=new spool.SpoolChild(dir,owner),events=[];let closed=false;
 const started=new Promise(resolve=>c.once('spawn',resolve));started.then(()=>events.push('queue acknowledged'));
 c.on('line',()=>events.push('output'));c.on('close',()=>{events.push('close');closed=true;});
 c.start();await until(()=>closed);assert.deepEqual(events,['queue acknowledged','output','close']);c.finish();fs.rmSync(f.dir,{recursive:true,force:true});
});

test('partial restart release failure restores polling and ownership for every original conversation',()=>{
 const f=fixture(),r=new chat.ChatRunner(),children=[];
 try{
  for(const id of ['first','second']){const dir=path.join(f.root,id);fs.mkdirSync(dir,{recursive:true});const c=new spool.SpoolChild(dir,spool.claim(dir,'fixture'));c.start();children.push(c);r.running.set('fixture\0'+id,{child:c});}
  r.handoffErrors=()=>[];r.handoffSafe=()=>true;
  children[1].checkpoint=()=>{throw Error('injected checkpoint failure');};
  assert.throws(()=>r.detachForRestart(),/checkpoint failure/);
  for(const c of children){assert.equal(c.owns(),true);assert.equal(c.timer._destroyed,false);assert.equal(spool.read(c.dir,'failure.json'),null);}
 }finally{for(const c of children)c.pause();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('effort retry start refusal preserves the finished receipt and reports one final error without quarantine or queue dispatch',async()=>{
 const f=fixture(),r=new chat.ChatRunner({spoolRoot:f.root,dirOf:()=>f.pdir});let calls=0;
 fs.writeFileSync(f.script,`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('error: unknown variant reasoning_effort');process.exit(1);});`);
 r.licenseGuard=()=>{if(++calls>1)throw Error('fixture start held');};
 try{
  const run=r.run({project:'fixture',task:'task',pdir:f.pdir,dir:f.dir,ai:'codex',model:'fixture',effort:'high',text:'fixture'},{command:process.execPath,args:[f.script],stdin:'fixture',effortFlag:'high',modelFlag:'fixture'},{sessions:{},models:{}},[]);
  await until(()=>chat.read(f.pdir,'task').some(x=>x.role==='assistant'));
  assert.equal(calls,2);assert.equal(spool.read(run.child.dir,'failure.json'),null);assert.ok(spool.read(run.child.dir,'finished-confirmed.json'));assert.deepEqual(r.handoffErrors(),[]);assert.equal(r.busy('fixture','task'),null);
  const rows=chat.read(f.pdir,'task').filter(x=>x.role==='assistant');assert.equal(rows.length,1);assert.match(rows[0].error,/fixture start held/);
 }finally{for(const c of r.spoolRuns)c.pause();fs.rmSync(f.dir,{recursive:true,force:true});}
});
