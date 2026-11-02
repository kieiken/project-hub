'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {randomUUID,createHash}=require('node:crypto'),{Store}=require('../lib/store'),chat=require('../lib/chat'),git=require('../lib/git');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-auto-history-http-'));
const root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin');
fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
const selectionGate=path.join(tmp,'release-selection');
const fake=`#!${process.execPath}
if(process.argv.includes('--version')){console.log('fake only');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>setTimeout(function finish(){
if(input.includes('[task-auto:')&&!require('node:fs').existsSync(${JSON.stringify(selectionGate)})){setTimeout(finish,10);return;}
if(input.includes('[task-auto:')){console.log(JSON.stringify({type:'result',result:JSON.stringify({items:[{type:'approval',topic:'方針',text:'方針の承認',rows:[1],quote:'この方針で進めてください'},{type:'next',topic:'方針',text:'ARGS '+process.argv.slice(2).join(' '),rows:[1]}],topics:[{title:'方針',rows:[1,1]}]}),session_id:'auto-claude'}));return;}
if(process.argv.includes('--verbose'))console.log(JSON.stringify({type:'result',result:JSON.stringify({input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)'),args:process.argv.slice(2)}),session_id:'fresh-claude'}));
else {console.log(JSON.stringify({type:'thread.started',thread_id:'fresh-codex'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)'),args:process.argv.slice(2)})}}));console.log(JSON.stringify({type:'turn.completed'}));}
},180));`;
for(const ai of ['codex','claude'])fs.writeFileSync(path.join(bin,ai),fake,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:home,HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(42000+Math.floor(Math.random()*1000)),PATH:bin+path.delimiter+process.env.PATH});
const store=new Store(root),project=store.createProject({name:'Fixture'}).project;
const task=store.createTask(project.id,{title:'本作業',steps:['残件']});
chat.append(project.dir,task.id,{role:'user',text:'この方針で進めてください UNIQUE_OLD_BODY'});
chat.writeMeta(project.dir,task.id,{sessions:{claude:'old'},models:{},accounts:{}});
const {server,taskPrompt,chats,restoreReady}=require('../server');let base;
const selectionLaunches=[],send=chat.ChatRunner.prototype.send;
chat.ChatRunner.prototype.send=function(o){if(o.selectionOnly)selectionLaunches.push({...o,at:Date.now()});return send.call(this,o);};
let settledAt=0;const settled=chats.onSettled;chats.onSettled=async(o,row)=>{if(o.selectionOnly)settledAt=Date.now();return settled(o,row);};
const body={project:project.id,task:task.id};
const post=(route,data={},headers={'X-Hub':'1'})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...body,...data})});
const view=async()=>await(await fetch(base+'/api/task/history/auto?'+new URLSearchParams(body),{headers:{'X-Hub':'1'}})).json();
const until=async ok=>{for(let n=0;n<1200;n++){const v=await view();if(ok(v))return v;await new Promise(r=>setTimeout(r,20));}throw Error('auto job did not reach the stage: '+JSON.stringify(await view()));};
test.before(async()=>{await restoreReady;await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{fs.writeFileSync(selectionGate,'release');server.closeAllConnections();await new Promise(r=>server.close(r));chat.ChatRunner.prototype.send=send;fs.rmSync(tmp,{recursive:true,force:true});});
test('自動整理HTTP：一回の要求で選別・保存・切替し、再送・他タブ・整理中の送信・旧世代で二重にしない',async()=>{
 assert.equal((await fetch(base+'/api/task/history/auto?'+new URLSearchParams(body))).status,403);
 const requestId=randomUUID(),first=await post('/api/task/history/auto',{generation:1,requestId});assert.equal(first.status,200,JSON.stringify(await first.clone().json()));
 const job=(await first.json()).auto;
 assert.equal((await(await post('/api/task/history/auto',{generation:1,requestId})).json()).auto.id,job.id);
 assert.equal((await(await post('/api/task/history/auto',{generation:1,requestId:randomUUID()})).json()).auto.id,job.id);
 await until(v=>['selecting','writing','done'].includes(v.auto?.stage));
 const during=await post('/api/chat/send',{generation:1,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'整理中の新しい指示'});
 assert.equal(during.status,409);assert.match((await during.json()).error,/整理中|切り替わりました/);
 fs.writeFileSync(selectionGate,'release');
 const done=await until(v=>v.auto?.stage==='done');assert.equal(done.generation,2);
 assert.equal(selectionLaunches.length,1);const launch=selectionLaunches[0],turn=chat.buildTurn({...launch,meta:{sessions:{claude:'old'}},rows:[{role:'user',text:'UNIQUE_OLD_BODY'}]});
 assert.equal(launch.dir,project.dir);assert.equal(turn.resume,false);
 assert.ok(!turn.args.includes('--resume'));assert.ok(turn.args.includes('claude-opus-5-5'));
 assert.doesNotMatch(turn.stdin,/<previous_conversation>|\[\[質問\]\]|区切りで更新/);
 assert.equal(turn.stdin.split('UNIQUE_OLD_BODY').length-1,1,'会話本文は一度だけ');
 for(const k of ['collectingAt','selectingAt','replyReceivedAt','writingAt','doneAt'])assert.ok(Number.isFinite(Date.parse(done.auto.timings[k])),k);
 assert.ok(settledAt>0);const completionDelay=Date.now()-settledAt;
 assert.ok(completionDelay<1200,'終了通知から切り替える（1.5秒の定期確認を待たない）：'+completionDelay);
 console.log(JSON.stringify({selectionPromptCharacters:turn.stdin.length,completionDelayMs:completionDelay}));
 const rows=chat.read(project.dir,task.id);assert.equal(rows.length,1);assert.equal(rows[0].summaryAuto,true);
 assert.match(rows[0].text,/「この方針で進めてください」（人・行1）/);assert.match(rows[0].text,/claude-opus-5-5/);assert.doesNotMatch(rows[0].text,/整理中の新しい指示/);
 const again=await post('/api/task/history/auto',{generation:1,requestId});assert.equal(again.status,200);assert.equal((await again.json()).auto.stage,'done');
 assert.equal((await post('/api/task/history/auto',{generation:1,requestId:randomUUID()})).status,409);
 assert.equal((await post('/api/chat/note',{generation:1,text:'旧画面からの送信'})).status,409);
 const p=store.readProject(project.id),file=store.taskFile(project.id,task.id),prompt=taskPrompt(p,store.readTask(file),file,p.dir,'chat');
 assert.match(prompt,/過去の会話の目次：台帳\/\.ai\/chat\/history\//);assert.match(prompt,/この方針で進めてください/);
 const archived=fs.readdirSync(path.join(p.dir,'.ai/chat/history',task.id)).filter(n=>/^[a-f0-9-]{36}$/.test(n));assert.equal(archived.length,1);
 assert.ok(fs.existsSync(path.join(p.dir,'.ai/chat/history',task.id,archived[0],'handoff.md')));
});
test('credit exception HTTP checks scope and consent, is idempotent, and cannot restart after ending',async()=>{
 const {Usage}=require('../lib/usage'),status=Usage.prototype.status,snapshot=Usage.prototype.snapshot;
 const data={accountProviders:[{ai:'codex',account:'default',status:'ok',attemptedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),windows:[{id:'codex:secondary',label:'週間枠',usedPercent:100,resetsAt:null}],credits:{balance:'62500.0000000000',unlimited:false}}]};
 Usage.prototype.status=async()=>data;Usage.prototype.snapshot=()=>data;
 try{
  const input={ai:'codex',account:'default',confirm:true,expectedBalance:'62500.0000000000'};
  assert.equal((await post('/api/limits/credit-exception',{...input,ai:'claude'})).status,409);
  assert.equal((await post('/api/limits/credit-exception',{...input,account:'work'})).status,409);
  assert.equal((await post('/api/limits/credit-exception',{...input,confirm:false})).status,409);
  const first=await post('/api/limits/credit-exception',input);assert.equal(first.status,200);const grant=(await first.json()).creditException;assert.equal(grant.state,'active');
  const duplicate=await post('/api/limits/credit-exception',input);assert.equal((await duplicate.json()).creditException.grantedAt,grant.grantedAt);
  const end=await post('/api/limits/credit-exception/end',input);assert.equal(end.status,200);assert.equal((await end.json()).creditException.endReason,'manual');
  assert.equal((await post('/api/limits/credit-exception',input)).status,409);
 }finally{Usage.prototype.status=status;Usage.prototype.snapshot=snapshot;}
});

test('long conversation reserves the same job automatically and waits for unfinished work',async()=>{
 chat.append(project.dir,task.id,{role:'user',text:'長い会話'+ 'あ'.repeat(120001)});
 chat.append(project.dir,task.id,{role:'user',to:'dot',request:'unfinished-context-work',text:'終了待ちの依頼'});
 const reserved=await until(v=>v.auto?.trigger==='context'&&v.auto.stage==='reserved');assert.equal(reserved.generation,2);
 assert.equal(chat.read(project.dir,task.id).some(r=>String(r.text||'').includes('[task-auto:'+reserved.auto.id+']')),false);
 const same=await post('/api/task/history/auto',{generation:2,requestId:randomUUID()});assert.equal((await same.json()).auto.id,reserved.auto.id);
 chat.append(project.dir,task.id,{role:'assistant',ai:'dot',request:'unfinished-context-work',text:'依頼の終了'});
 const done=await until(v=>v.auto?.trigger==='context'&&v.auto.stage==='done');assert.equal(done.generation,3);assert.equal(chat.read(project.dir,task.id).length,1);
});

test('input spool write failure stops without an unchanged retry, AI launch, or loss of source rows',async()=>{
 const target=store.createTask(project.id,{title:'Spool write failure'}),request={project:project.id,task:target.id};
 chat.append(project.dir,target.id,{role:'user',text:'保全する本文'+ 'a'.repeat(16000)});
 const raw=fs.readFileSync(chat.files(project.dir,target.id).log),file=store.taskFile(project.id,target.id),before=fs.readFileSync(file),starts=selectionLaunches.length,rename=fs.renameSync;let attempts=0;
 fs.renameSync=(from,to)=>{if(to.startsWith(path.join(root,'_hub/task-history/inputs'))){attempts++;throw Error('fixture spool write failed');}return rename(from,to);};
 try{
  const response=await fetch(base+'/api/task/history/auto',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...request,requestId:randomUUID(),generation:1})});assert.equal(response.status,200);
  let v;for(let i=0;i<100;i++){v=await(await fetch(base+'/api/task/history/auto?'+new URLSearchParams(request),{headers:{'X-Hub':'1'}})).json();if(v.auto.stage==='failed')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(v.auto.stage,'failed');assert.match(v.auto.error,/fixture spool write failed/);await new Promise(r=>setTimeout(r,1700));assert.equal(attempts,1);assert.equal(selectionLaunches.length,starts);
  assert.deepEqual(fs.readFileSync(chat.files(project.dir,target.id).log),raw);assert.deepEqual(fs.readFileSync(file),before);
 }finally{fs.renameSync=rename;}
});
