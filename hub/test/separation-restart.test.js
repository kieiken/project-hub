'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const {RestartControl}=require('../lib/restart-control'),{ChatRunner}=require('../lib/chat'),scope=require('../lib/resource-scope');
function tmp(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-sep-restart-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('予約中は開始を妨げず、実行確定前の割込みを待ち、一度だけ確定する',()=>{
 let active=true,saved=true,runs=0;const r=new RestartControl({blockers:()=>active?[{kind:'integration'}]:[],verify:()=>{if(!saved)throw Error('unsaved');},execute:()=>{runs++;assert.equal(r.committed,true);}});
 const first=r.request(true).reserved;assert.equal(r.committed,false);assert.deepEqual(r.request(true).reserved,first);
 r.cancel();active=false;r.tick();assert.equal(runs,0);
 active=true;r.request(true);saved=false;active=false;r.tick();assert.equal(r.committed,false);assert.equal(r.error,'unsaved');
 // A newly started operation between two polls holds the reservation.
 active=true;saved=true;r.tick();assert.equal(runs,0);active=false;r.tick();assert.equal(runs,1);
 r.tick();r.request(true);r.request();assert.equal(runs,1);assert.throws(()=>r.cancel());
});
test('保存失敗はメモリに残っていても再起動を拒否し、キューを捨てて修復しない',t=>{
 const dir=tmp(t),runner=new ChatRunner({dirOf:()=>dir});
 const file=path.join(dir,'.ai/chat/t.queue.json');runner.queue('p','t');fs.mkdirSync(file,{recursive:true});
 const q=[{id:'unsaved',text:'preserve'}];assert.throws(()=>runner.setQueue('p','t',q));assert.throws(()=>runner.queue('p','t'));assert.throws(()=>runner.verifyQueues(),/保存を確認/);
 assert.equal(fs.statSync(file).isDirectory(),true);assert.ok(fs.existsSync(file+'.intent.json'),'uncertain write evidence is preserved');
 fs.rmdirSync(file);assert.deepEqual(runner.queue('p','t'),q,'reconcile the recorded intent instead of dropping the instruction');assert.equal(runner.verifyQueues(),true);
});
test('シンボリックリンク・重なる本体・別worktreeのcommon Gitを同じ書込範囲にする',t=>{
 const root=tmp(t),body=path.join(root,'body'),copy=path.join(root,'copy'),alias=path.join(root,'alias');fs.mkdirSync(body);
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:'pipe'}).trim();git('-C',body,'init','-q');git('-C',body,'config','user.name','Fixture');git('-C',body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');git('-C',body,'add','.');git('-C',body,'commit','-qm','base');git('-C',body,'worktree','add','-q','-b','fixture',copy);fs.symlinkSync(body,alias);
 assert.equal(scope.canonical(alias),scope.canonical(body));assert.equal(scope.commonGit(copy),scope.commonGit(body));
 assert.equal(scope.overlaps(scope.canonical(body),scope.canonical(path.join(body,'sub'))),true);
 const a={id:'a',dir:path.join(root,'ledger-a'),tasks:[{workdir:copy}]},b={id:'b',dir:path.join(root,'ledger-b'),tasks:[]};
 assert.equal(scope.shared(scope.resources(a,()=>copy),scope.resources(b,()=>alias)),true);
});
test('隔離したHubを実際に停止・再起動しても、順序・依頼ID・上限保持・手動停止を変えず重複開始しない',async t=>{
 const root=tmp(t),ledger=path.join(root,'Product/P');fs.mkdirSync(path.join(ledger,'.ai/tasks'),{recursive:true});fs.mkdirSync(path.join(ledger,'.ai/chat'));
 fs.writeFileSync(path.join(ledger,'PROJECT.md'),'---\nname: P\nfolders: {}\n---\n');fs.writeFileSync(path.join(ledger,'.ai/tasks/t.md'),'---\nid: t\ntitle: t\nstate: 上限で停止\nworkspaceMode: direct\n---\n');
 const file=path.join(ledger,'.ai/chat/t.queue.json'),q=[{id:'one',ai:'claude',model:'claude-fable-5-1',text:'held',limitWaiting:true,error:'上限',limitSwitch:{request:'handoff',sourceRequest:'origin',until:'2099-01-01'}},{id:'two',ai:'codex',model:'gpt-6.1-sol',text:'manual stop',error:'手動停止',paused:true}];fs.writeFileSync(file,JSON.stringify(q,null,2));
 const before=fs.readFileSync(file),taskBefore=fs.readFileSync(path.join(ledger,'.ai/tasks/t.md'));
 const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const base='http://127.0.0.1:'+port;
 let child;const env={...process.env,HUB_ROOT:root,HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'home'),HUB_FREETALK_HOME:path.join(root,'ft'),HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0',HUB_STORAGE_GUARD:'',HUB_UPDATE_SOURCE:''};
 const preload=path.join(root,'isolated-home.cjs');fs.writeFileSync(preload,`require('node:os').homedir=()=>${JSON.stringify(path.join(root,'home'))};`);
 async function boot(){child=spawn(process.execPath,['--require',preload,path.join(__dirname,'../server.js')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);for(let n=0;n<100;n++){try{if((await fetch(base+'/api/ping',{headers:{Connection:'close'}})).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error(log);}
 async function stop(){const c=child;if(!c||c.exitCode!==null)return;const done=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await done;child=null;}
 t.after(stop);
 await boot();const firstPid=child.pid;
 const reply=await fetch(base+'/api/restart',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:'{}'});assert.equal(reply.status,200);assert.equal((await reply.json()).restart.committed,true);
 // DRY mode seals the same gate but intentionally does not spawn/exit itself.
 await stop();assert.deepEqual(fs.readFileSync(file),before);await boot();assert.notEqual(child.pid,firstPid);
 const state=await (await fetch(base+'/api/state',{headers:{Connection:'close'}})).json();assert.deepEqual(state.chatting,[]);assert.equal(state.sessions.filter(s=>s.running).length,0);assert.equal(state.restart.executions,0);assert.equal(state.restart.reserved,null);
 assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(path.join(ledger,'.ai/tasks/t.md')),taskBefore);
 const reload=new ChatRunner({dirOf:()=>ledger});assert.deepEqual(reload.queue('P','t'),q);assert.equal(reload.verifyQueues(),true);assert.equal(fs.existsSync(path.join(ledger,'.ai/chat/t.jsonl')),false);
 await stop();
});

test('R67 admitted ordinary wait keeps reservation; unrelated 409 remains an error',async()=>{
 let busy=true,runs=0;const r=new RestartControl({blockers:()=>busy?[{kind:'chat'}]:[],admit:async fn=>fn(),verify(){},execute:()=>runs++});
 r.request(true);await r.tick();assert.equal(r.error,'');assert.ok(r.reserved);busy=false;await r.tick();assert.equal(runs,1);
 const bad=new RestartControl({blockers:()=>[],admit:async()=>{throw Object.assign(Error('admission failed'),{status:409});},verify(){},execute:()=>assert.fail()});bad.request(true);await bad.tick();assert.equal(bad.error,'admission failed');assert.ok(bad.reserved);
});
test('R67 late rejection from a cancelled admitted attempt cannot poison a new reservation',async()=>{
 let reject;const r=new RestartControl({blockers:()=>[],admit:()=>new Promise((_,no)=>reject=no),verify(){},execute:()=>assert.fail()});r.request(true);const old=r.tick();r.cancel();reject(Error('old failed'));await old;assert.equal(r.error,'');assert.equal(r.reserved,null);
});
test('R67 execution failure after sealing is retained without executing again',async()=>{
 let runs=0;const r=new RestartControl({blockers:()=>[],admit:async fn=>fn(),verify(){},execute:()=>{runs++;throw Error('execute failed');}});r.request(true);await new Promise(setImmediate);assert.equal(r.error,'execute failed');assert.equal(r.committed,true);await r.tick();r.request(true);assert.equal(runs,1);
});
