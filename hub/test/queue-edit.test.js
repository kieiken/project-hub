'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const chat = require('../lib/chat');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-queue-edit-'));
const root = path.join(tmp, 'workspace'), dir = path.join(root, 'Product', 'Queue'), bin = path.join(tmp, 'bin');
const key = { project: 'Queue', task: 'queue' };
let server, base;
const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: {'X-Hub':'1', 'Content-Type':'application/json', Connection:'close'}, body: JSON.stringify({...key, ...body}) });
const send = body => post('/api/chat/send', {ai:'codex',model:'gpt-6.1-sol',text:'ORIGINAL',...body});
const queueFile = () => path.join(dir, '.ai/chat/queue.queue.json');
const queue = () => JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
const wait = async fn => {const end = Date.now()+5000;while(!await fn()){assert.ok(Date.now()<end,'fixture timed out');await new Promise(r=>setTimeout(r,10));}};
const add = async text => {const r = await send({text,mode:'queue'});assert.equal(r.status,200);return (await r.json()).id;};
const edit = (id,text,expectedText) => post('/api/chat/queue/edit',{id,text,expectedText});
const amend = id => post('/api/chat/send',{fromQueue:id,mode:'amend'});
const ownedReady=()=>wait(()=>{const r=require('../server').chats.busy(key.project,key.task);return r?.child?.dir&&require('../lib/cli-spool').read(r.child.dir,'started.json')?.identity;});
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Queue\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 fs.writeFileSync(path.join(dir,'.ai/tasks/queue.md'),'---\nid: queue\ntitle: Queue\nowner: codex\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] fixture\n');
 // 過去会話のFOLLOW-UPで現在のORIGINALまで100ms終了しないよう、今回の依頼だけで終了時刻を決める。
 fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(path.join(tmp,'inputs.jsonl'))},JSON.stringify(input)+'\\n');setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),input.slice(input.lastIndexOf('# 今回の依頼\\n')).includes('FOLLOW-UP')?100:30000);});process.on('SIGTERM',()=>process.exit(143));\n`,{mode:0o755});
 process.env.PATH=bin+':/usr/bin:/bin';process.env.HUB_ROOT=root;process.env.HUB_PORT='0';process.env.HUB_DRY_RUN='1';process.env.HUB_AI_HOME=path.join(tmp,'home');process.env.HUB_TRASH=path.join(tmp,'trash');
 ({server}=require('../server'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;require('../server').stopControl.cleanExit();await new Promise(r=>server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];({server}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base=`http://127.0.0.1:${port}`;
});
test.beforeEach(async()=>{const r=await post('/api/ai/resume',{confirm:true});assert.equal(r.status,200,await r.text());});
test.afterEach(async()=>{const r=require('../server').chats.busy(key.project,key.task);if(r?.child?.dir&&!r.finalizing)await ownedReady();await post('/api/chat/stop');await wait(async()=>!(await (await fetch(base+'/api/state',{headers:{Connection:'close'}})).json()).chatting.length);if(fs.existsSync(queueFile()))for(const q of queue())await post('/api/chat/unqueue',{id:q.id});});
test.after(async()=>{await new Promise(r=>server.close(r));});

test('edit saves multiline text, order and launch metadata across restart; stale and empty edits retain queue',async()=>{
 assert.equal((await send({})).status,200);const first=await add('first'),second=await add('second');const original=queue()[0];
 const r=await edit(first,'edited\nsecond line','first');assert.equal(r.status,200);
 const expected={...original,text:'edited\nsecond line'};assert.deepEqual(queue()[0],expected);assert.equal(queue()[1].id,second);
 const runner=new chat.ChatRunner({dirOf:()=>dir});assert.deepEqual(runner.queue(key.project,key.task),queue());
 const before=fs.readFileSync(queueFile(),'utf8');assert.equal((await edit(first,'stale','first')).status,409);assert.equal((await edit(first,'  ','edited\nsecond line')).status,400);assert.equal(fs.readFileSync(queueFile(),'utf8'),before);
});

test('amend consumes only selected queue item, includes current directive and edited text, and records amend mode',async()=>{
 assert.equal((await send({})).status,200);const other=await add('remaining'),selected=await add('FOLLOW-UP original');
 assert.equal((await edit(selected,'FOLLOW-UP edited\nline','FOLLOW-UP original')).status,200);
 await ownedReady(); // Exercise a verified running CLI, rather than the separate startup/unknown-owner boundary.
 const res=await amend(selected);assert.equal(res.status,200,JSON.stringify(await res.json()));
 await wait(()=>fs.existsSync(path.join(tmp,'inputs.jsonl'))&&fs.readFileSync(path.join(tmp,'inputs.jsonl'),'utf8').includes('FOLLOW-UP edited'));
 const inputs=fs.readFileSync(path.join(tmp,'inputs.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.match(inputs.at(-1),/人が追加の説明/);assert.match(inputs.at(-1),/ORIGINAL/);assert.match(inputs.at(-1),/FOLLOW-UP edited/);
 const row=chat.read(dir,key.task).filter(x=>x.role==='user').at(-1);assert.equal(row.mode,'amend');assert.equal(row.text,'FOLLOW-UP edited\nline');
 assert.deepEqual(queue().map(x=>x.id),[other]);await wait(()=>chat.read(dir,key.task).some(x=>x.role==='assistant'&&x.request===selected));
 assert.equal((await amend(selected)).status,404);
});

test('failed launch retains selected and following queue entries without retrying',async()=>{
 assert.equal((await send({})).status,200);const id=await add('FOLLOW-UP'),next=await add('remaining');
 await ownedReady();
 const command=path.join(bin,'codex');fs.renameSync(command,command+'.saved');
 try {assert.equal((await amend(id)).status,409);assert.deepEqual(queue().map(x=>x.id),[id,next]);await new Promise(r=>setTimeout(r,100));assert.deepEqual(queue().map(x=>x.id),[id,next]);}
 finally {fs.renameSync(command+'.saved',command);}
});

test('amend and redo return a reasoned 409 and keep queued text when stop confirmation fails',async()=>{
 assert.equal((await send({})).status,200);const selected=await add('FOLLOW-UP retained'),next=await add('remaining');
 const original=chat.ChatRunner.prototype.stop,before=fs.readFileSync(queueFile(),'utf8');
 chat.ChatRunner.prototype.stop=function(p,t,opts){if(opts?.interrupting)throw Error('fixture save unconfirmed');return original.call(this,p,t,opts);};
 try{
  const selectedResponse=await amend(selected);assert.equal(selectedResponse.status,409);
  assert.deepEqual(await selectedResponse.json(),{error:'fixture save unconfirmed',queued:true,id:selected});
  assert.equal(fs.readFileSync(queueFile(),'utf8'),before);assert.deepEqual(queue().map(q=>q.id),[selected,next]);
  for(const mode of ['amend','redo']){
   // Queue conversion supports amend; redo is a new manual instruction.
   const text='FOLLOW-UP retained '+mode,prior=queue(),res=await send({text,mode});assert.equal(res.status,409);
   const body=await res.json();assert.match(body.error,/前の切替を確認中/);assert.equal(body.queued,undefined);
   assert.deepEqual(queue(),prior); // A second cutover is not accepted or silently cleared from the composer.
  }
 }finally{chat.ChatRunner.prototype.stop=original;}
});

test('idle conversion, stale conversion and protected system instructions are rejected without changing queue',async()=>{
 fs.mkdirSync(path.dirname(queueFile()),{recursive:true});
 const rows=[{id:'saved',ai:'codex',model:'GPT-6.1-Sol',text:'saved'},{id:'system',ai:'codex',model:'GPT-6.1-Sol',text:'protected',limitSwitch:{original:'original'}}];
 // The runner caches queues: seed through its normal HTTP enqueue, then mark system flags for this test via prototype.
 assert.equal((await send({})).status,200);const id=await add('saved');
 assert.equal((await post('/api/chat/send',{fromQueue:id,mode:'amend',expectedText:'stale'})).status,409);
 const originalQueue=chat.ChatRunner.prototype.queue;
 chat.ChatRunner.prototype.queue=function(p,t){const q=originalQueue.call(this,p,t);if(p===key.project&&t===key.task&&q.length)q[0].readOnly=true;return q;};
 try{assert.equal((await edit(id,'changed','saved')).status,409);assert.equal((await amend(id)).status,409);assert.equal(queue()[0].text,'saved');}
 finally{chat.ChatRunner.prototype.queue=originalQueue;}
 await post('/api/chat/stop');await wait(async()=>!(await (await fetch(base+'/api/state',{headers:{Connection:'close'}})).json()).chatting.length);
 // A normal stopped queue may still be restarted with Begin, but amend requires a running turn.
 // Keep the current task queue intact; the idle task below has its own fixture.
 // Fresh task avoids the server runner's previously loaded cache.
 fs.writeFileSync(path.join(dir,'.ai/tasks/idle.md'),'---\nid: idle\ntitle: idle\nworkspaceMode: direct\n---\n');fs.writeFileSync(path.join(dir,'.ai/chat/idle.queue.json'),JSON.stringify(rows));
 assert.equal((await post('/api/chat/send',{task:'idle',fromQueue:'saved',mode:'amend'})).status,409);
});

test('pending conversion locks edits, cancels and a second conversion until launch is settled',async()=>{
 assert.equal((await send({})).status,200);const id=await add('FOLLOW-UP');
 await ownedReady();
 const originalSend=chat.ChatRunner.prototype.sendQueued;let release,entered=false;
 chat.ChatRunner.prototype.sendQueued=async function(o){entered=true;await new Promise(r=>release=r);return originalSend.call(this,o);};
 try {
  const sending=amend(id);await wait(()=>entered);
  assert.equal((await edit(id,'changed','FOLLOW-UP')).status,409);assert.equal((await post('/api/chat/unqueue',{id})).status,409);assert.equal((await amend(id)).status,409);
  release();assert.equal((await sending).status,200);assert.equal(queue().length,0,JSON.stringify(queue()));
 } finally {chat.ChatRunner.prototype.sendQueued=originalSend;release?.();}
});


test('disk save failure keeps the original queue in memory and on disk',async()=>{
 assert.equal((await send({})).status,200);const id=await add('saved');const before=fs.readFileSync(queueFile(),'utf8'),original=fs.openSync;
 // Fail before the durable intent is created; the queue now uses fsync + atomic rename.
 fs.openSync=function(file,...args){if(String(file)===queueFile()+'.intent.json.tmp'&&args[0]==='wx')throw Error('fixture disk failure');return original.call(this,file,...args);};
 try{const res=await edit(id,'changed','saved');assert.equal(res.status,409);assert.match((await res.json()).error,/disk failure/);assert.equal(fs.readFileSync(queueFile(),'utf8'),before);}
 finally{fs.openSync=original;}
 // Successful retry uses the original expected text, proving the in-memory queue was also retained.
 assert.equal((await edit(id,'changed','saved')).status,200);
});

test('human stop while amend or redo awaits exit preserves the instruction without starting it',async()=>{
 const hub=require('../server'),original=chat.ChatRunner.prototype.terminateRun;
 for(const mode of ['amend','redo']){
  assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
  const inputsFile=path.join(tmp,'inputs.jsonl'),before=fs.existsSync(inputsFile)?fs.readFileSync(inputsFile,'utf8').trim().split('\n').length:0;
  assert.equal((await send({})).status,200);await wait(()=>fs.existsSync(inputsFile)&&fs.readFileSync(inputsFile,'utf8').trim().split('\n').length>before);let entered=false,release;
  const gate=new Promise(r=>release=r);
  chat.ChatRunner.prototype.terminateRun=async function(run){entered=true;await gate;return original.call(this,run);};
  try{
   const pending=send({text:'FOLLOW-UP held '+mode,mode});await wait(()=>entered);
   const stopped=post('/api/chat/stop');await wait(()=>hub.stopControl.held(key));release();
   assert.equal((await stopped).status,200);assert.equal((await pending).status,409);
   assert.ok(queue().some(q=>q.text==='FOLLOW-UP held '+mode));
   const inputs=fs.readFileSync(path.join(tmp,'inputs.jsonl'),'utf8');assert.equal(inputs.includes('FOLLOW-UP held '+mode),false);
  }finally{release?.();chat.ChatRunner.prototype.terminateRun=original;}
 }
});

const revise = (item, extra = {}) => post('/api/chat/queue/edit', { id:item.id, text:item.text, expectedText:item.text, expectedItem:JSON.stringify(item), ai:item.ai, model:item.model, ...extra });
test('model-only and combined edits are atomic, preserve other instructions, and reject stale metadata and old clients',async()=>{
 assert.equal((await send({})).status,200);const id=await add('model only'),other=await add('other');
 const hub=require('../server'),old=queue()[0];hub.chats.setQueue(key.project,key.task,queue().map(x=>x.id===id?{...x,requireModel:true,requiredModel:'gpt-6.1-sol',shown:x.text}:x),true);
 const before=queue()[0],taskBefore=fs.readFileSync(path.join(dir,'.ai/tasks/queue.md'),'utf8');
 let r=await revise(before,{ai:'claude',model:'claude-fable-5-1'});assert.equal(r.status,200,await r.clone().text());
 const saved=queue()[0];assert.equal(saved.text,'model only');assert.equal(saved.ai,'claude');assert.equal(saved.model,'Fable 5.1');assert.equal(saved.account,'default');assert.match(saved.perm,/^claude /);assert.equal(saved.requiredModel,'claude-fable-5-1');assert.equal(saved.requireModel,true);assert.equal(saved.role,before.role);assert.equal(saved.limitSlot,undefined);assert.equal(queue()[1].id,other);assert.equal(fs.readFileSync(path.join(dir,'.ai/tasks/queue.md'),'utf8'),taskBefore);
 assert.deepEqual(new chat.ChatRunner({dirOf:()=>dir}).queue(key.project,key.task),queue());
 const bytes=fs.readFileSync(queueFile(),'utf8');
 assert.equal((await revise(before,{text:'stale'})).status,409);assert.equal((await edit(id,'legacy overwrite','model only')).status,409);
 assert.equal((await post('/api/chat/send',{fromQueue:id,expectedItem:JSON.stringify(before),mode:'amend'})).status,409);
 for(const value of [{ai:'codex',model:'claude-fable-5-1'},{ai:'dot',model:'auto'},{ai:'claude',model:'removed-model'}])assert.equal((await revise(saved,value)).status,409);
 assert.equal(fs.readFileSync(queueFile(),'utf8'),bytes);
 r=await revise(saved,{ai:'codex',model:'gpt-6.1-sol',text:'combined edit'});assert.equal(r.status,200);assert.equal(queue()[0].shown,'combined edit');assert.equal(queue()[0].requiredModel,'gpt-6.1-sol');
 const o=hub.chats.queuedOptions({project:key.project},queue()[0]);assert.equal(o.ai,'codex');assert.equal(o.model,'GPT-6.1-Sol');assert.equal(o.text,'combined edit');assert.equal(old.ai,'codex');
});

test('queue attachment removal is staged by ID, survives reload, and never deletes source files or arbitrary text paths',async()=>{
 assert.equal((await send({})).status,200);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64'),images=[];
 for(let i=0;i<2;i++){
  const r=await fetch(base+'/api/start/image?'+new URLSearchParams({project:key.project,name:'same.png'}),{method:'POST',headers:{'X-Hub':'1',Connection:'close'},body:png});assert.equal(r.status,200);images.push(await r.json());
 }
 assert.notEqual(images[0].id,images[1].id);
 const qe=require('../lib/queue-edit'),body='Do not remove this manually written path: '+images[0].path,text=qe.format(body,images);
 const res=await send({mode:'queue',text,attachmentDraft:{text:body,attachments:images}});assert.equal(res.status,200,await res.clone().text());const id=(await res.json()).id;
 let item=queue().find(x=>x.id===id);const draft=await (await fetch(base+'/api/chat/queue/draft?'+new URLSearchParams({...key,id}))).json();assert.equal(draft.draft.text,body);assert.equal(draft.draft.attachments.length,2);
 const before=fs.readFileSync(queueFile(),'utf8');assert.equal((await revise(item,{text:body,attachmentIds:['arbitrary']})).status,409);assert.equal(fs.readFileSync(queueFile(),'utf8'),before);
 assert.equal((await revise(item,{text:body,attachmentIds:[images[1].id]})).status,200);const saved=queue().find(x=>x.id===id);
 assert.equal(saved.text,qe.format(body,[images[1]]));assert.ok(saved.text.includes(images[0].path));assert.equal(saved.attachmentDraft.attachments.length,1);assert.ok(images.every(x=>fs.existsSync(x.path)));
 assert.equal((await revise(item,{text:body,attachmentIds:[]})).status,409);
 assert.deepEqual(new chat.ChatRunner({dirOf:()=>dir}).queue(key.project,key.task).find(x=>x.id===id),saved);
 // Older saved queues: recognize only an exact validated terminal reference block.
 const legacy=await add(qe.format('legacy body',images));const d=await (await fetch(base+'/api/chat/queue/draft?'+new URLSearchParams({...key,id:legacy}))).json();assert.equal(d.draft.attachments.length,2);
 const manual=await add('manual\n\n参照画像（絶対パス）：\n/private/tmp/arbitrary.png');const m=await (await fetch(base+'/api/chat/queue/draft?'+new URLSearchParams({...key,id:manual}))).json();assert.equal(m.draft.attachments.length,0);assert.match(m.draft.text,/arbitrary/);
 // Even forged attachment descriptors cannot inject an unverified image or URL.
 const bad=await send({mode:'queue',text:qe.format('bad',[{...images[0],path:'/private/tmp/arbitrary.png'}]),attachmentDraft:{text:'bad',attachments:[{...images[0],path:'/private/tmp/arbitrary.png'}]}});assert.equal(bad.status,400);
});

test('edited AI and pinned model reach the real isolated amend launch, with edit/start locks intact',async()=>{
 fs.copyFileSync(path.join(bin,'codex'),path.join(bin,'claude'));fs.chmodSync(path.join(bin,'claude'),0o755);
 assert.equal((await send({})).status,200);const id=await add('FOLLOW-UP model changed');
 assert.equal((await revise(queue().find(x=>x.id===id),{ai:'claude',model:'claude-fable-5-1'})).status,200);await ownedReady();
 const r=await amend(id);assert.equal(r.status,200,await r.clone().text());const rows=chat.read(dir,key.task),row=rows.filter(x=>x.role==='user').at(-1);
 assert.equal(row.to,'claude');assert.equal(row.model,'Fable 5.1');assert.match(row.text,/FOLLOW-UP model changed/);assert.equal((await revise({...row,id,text:'stale'})).status,404);
 await wait(()=>!require('../server').chats.busy(key.project,key.task));
});

test('automation, integration and read-only queue instructions reject both draft and save',async()=>{
 assert.equal((await send({})).status,200);const id=await add('protected'),hub=require('../server'),item=queue().find(x=>x.id===id);
 for(const flag of ['automation','readOnly','selectionOnly','limitSwitch','resultsOrganize','integrationAssignment','isolatedReview','integrationReviewRequest']){
  const current={...item,[flag]:true};hub.chats.setQueue(key.project,key.task,[current],true);const before=fs.readFileSync(queueFile(),'utf8');
  assert.equal((await revise(current,{text:'should stay'})).status,409,flag);
  assert.equal((await fetch(base+'/api/chat/queue/draft?'+new URLSearchParams({...key,id}))).status,409,flag);assert.equal(fs.readFileSync(queueFile(),'utf8'),before);
 }
 hub.chats.setQueue(key.project,key.task,[item],true);
});

test('same-AI model changes retain the selected account, and a new AI uses its own account, command and supported effort',async()=>{
 assert.equal((await send({})).status,200);const id=await add('metadata edge'),hub=require('../server'),launch=require('../lib/launch');
 const created=await post('/api/accounts',{ai:'claude',name:'fixture profile'});assert.equal(created.status,200);const account=(await created.json()).account.id;
 const baseItem={...queue().find(x=>x.id===id),ai:'claude',model:'Fable 5.1',account,effort:'Ultra',requireModel:true,requiredModel:'claude-fable-5-1',role:'チェック',limitSlot:'main'};
 hub.chats.setQueue(key.project,key.task,[baseItem],true);
 assert.equal((await revise(baseItem,{ai:'claude',model:'claude-opus-5-5'})).status,200);let saved=queue()[0];assert.equal(saved.account,account);assert.equal(saved.requiredModel,'claude-opus-5-5');assert.equal(saved.role,'チェック');assert.equal(saved.limitSlot,'main');
 // Catalog injection is fixture-only; no Grok command, auth or network is used.
 launch.setDiscoveredModels({grok:{models:[{label:'fixture-grok',id:'fixture-grok-id'}]}});
 try{assert.equal((await revise(saved,{ai:'grok',model:'fixture-grok-id'})).status,200);saved=queue()[0];assert.equal(saved.account,'default');assert.equal(saved.effort,'高');assert.match(saved.perm,/^grok /);assert.equal(saved.requiredModel,'fixture-grok-id');assert.equal(saved.role,'チェック');assert.equal(saved.limitSlot,'main');}
 finally{launch.setDiscoveredModels({});}
});
