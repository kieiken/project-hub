'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../lib/store'), chat = require('../lib/chat');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-freetalk-http-')));
const root = path.join(tmp,'root'), home = path.join(tmp,'home'), bin = path.join(tmp,'bin');
fs.mkdirSync(bin); fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
// 契約CLIには触らず、入力とcwdだけ返す偽物。
fs.writeFileSync(path.join(bin,'codex'), `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex fake');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const out=o=>console.log(JSON.stringify(o));
const imageSession='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const imageTurn=input.includes('generated-image-sentinel');
out({type:'thread.started',thread_id:imageTurn?imageSession:'topic-'+process.pid});
if(imageTurn){const fs=require('node:fs'),path=require('node:path');const dir=path.join(require('node:os').homedir(),'.codex/generated_images',imageSession);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(${JSON.stringify(path.join(__dirname,'../public/icon.png'))},path.join(dir,'generated.png'));}

const finish=()=>{out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)')})}});out({type:'turn.completed'});};
const fs=require('node:fs'),gate=['parallel-sentinel-a','parallel-sentinel-b'].find(s=>input.includes(s))||input.match(/image-queue-gate-[a-z-]+/)?.[0];
if(!gate)return finish();
const marker=${JSON.stringify(bin)}+'/'+gate;fs.writeFileSync(marker+'.started',String(process.pid));
const poll=setInterval(()=>{if(fs.existsSync(marker+'.release')){clearInterval(poll);finish();}},20);
});`,{mode:0o755});
process.env.HUB_ROOT=root; process.env.HUB_FREETALK_HOME=home; process.env.HOME=home;
const port=39000+Math.floor(Math.random()*2000);
process.env.HUB_DRY_RUN='1'; process.env.HUB_PORT=String(port); process.env.PATH=bin+path.delimiter+process.env.PATH;
const { server, taskPrompt }=require('../server'); let base, a, b;
const store=new Store(root), pdir=path.join(root,'Product/freetalk');
const post=(route,body={},headers={'X-Hub':'1'})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const state=async()=>await(await fetch(base+'/api/state')).json();
const wait=async pred=>{for(let i=0;i<150;i++){if(pred())return;await new Promise(r=>setTimeout(r,20));}assert.ok(pred(),'偽CLIが終了する');};
test.before(async()=>{await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('正規HTTP：登録と2話題、初期モデル維持、認証なし拒否',async()=>{
  assert.equal((await post('/api/freetalk/ensure',{},{})).status,403);
  const before=await state();assert.equal(before.projects.length,0);
  assert.equal((await(await post('/api/freetalk/ensure')).json()).ready,true);
  a=await(await post('/api/freetalk/topic')).json();b=await(await post('/api/freetalk/topic')).json();
  assert.notEqual(a.id,b.id);assert.equal(a.model,before.initialPick.model);assert.equal(a.effort,before.initialPick.effort);
  assert.equal((await state()).projects.find(p=>p.id==='freetalk').tasks.length,2);
  assert.equal(fs.existsSync(path.join(root,'Work/freetalk')),false);
  assert.equal((await post('/api/chat/note',{project:'freetalk',task:b.id,text:'x'.repeat(8001)})).status,400);
  assert.equal(store.readTask(store.taskFile('freetalk',b.id)).title,'新しい話題');
});
test('正規HTTP：解除・並べ替え・完了・削除・取り込み・統合・重い作業機能を拒否し記録を保持',async()=>{
  const project=fs.readFileSync(path.join(pdir,'PROJECT.md')), topic=fs.readFileSync(store.taskFile('freetalk',a.id));
  for(const route of ['/api/hierarchy/pin','/api/hierarchy/order','/api/hierarchy/rename','/api/project/status','/api/project/handoff',
    '/api/hierarchy/remove/preview','/api/hierarchy/remove/apply','/api/hierarchy/remove/review/start','/api/hierarchy/remove/review/status','/api/maintenance/preview','/api/task/completion','/api/task/step',
    '/api/task/new','/api/task/merge','/api/task/copyclear','/api/task/handup','/api/task/absorb','/api/task/integrate/preview','/api/task/integrate','/api/phase/next','/api/start','/api/term/start']) {
    const r=await post(route,{project:'freetalk',task:a.id,confirm:true,pinned:false,before:true,state:'完了',index:0,done:true});
    assert.equal(r.status,409,route);assert.match((await r.json()).error,/常設/);
  }
  assert.equal((await post('/api/task',{project:'freetalk',task:a.id,parent:b.id})).status,409);
  assert.equal((await post('/api/project/new',{name:'child',parent:'freetalk'})).status,409);
  assert.equal((await post('/api/empty/trash',{items:[{project:'freetalk',task:a.id}]})).status,409);
  for (const [name,args] of [['hub_mark_step',{index:0,done:true}],['hub_propose_task',{title:'新作業'}],['hub_report',{text:'完了',done:true}]]) {
    const r=await post('/api/mcp/call',{name,arguments:{project:'freetalk',task:a.id,...args}});assert.equal(r.status,409,name);
  }
  assert.deepEqual(fs.readFileSync(path.join(pdir,'PROJECT.md')),project);assert.deepEqual(fs.readFileSync(store.taskFile('freetalk',a.id)),topic);
});
test('正規HTTP：別表記の禁止操作・親・派生・統合・予約名を拒否し常設台帳を保持',async()=>{
  const before=fs.readFileSync(path.join(pdir,'PROJECT.md'));
  const names=fs.readdirSync(path.join(pdir,'.ai/tasks')).sort();
  for(const project of ['FreeTalk','FREETALK']) {
    for(const route of ['/api/task/new','/api/hierarchy/rename','/api/hierarchy/remove/preview',
      '/api/task/merge','/api/task/copyclear','/api/task/completion','/api/task/integrate','/api/empty/trash']) {
      const r=await post(route,{project,task:a.id,title:'禁止',confirm:true});
      assert.equal(r.status,409,project+route);
    }
    for(const body of [{name:project},{name:'normal',parent:project},{name:'normal',derivedFrom:project}])
      assert.equal((await post('/api/project/new',body)).status,409);
    assert.equal((await post('/api/task/new',{project:'normal',derivedFrom:project+'/'+a.id})).status,409);
    assert.equal((await post('/api/task/integrate',{project:'normal',only:[{project,task:a.id}]})).status,409);
    assert.equal((await post('/api/empty/trash',{items:[{project,task:a.id}]})).status,409);
    // previewの拒否でtokenは発行されず、tokenだけの実行も移動できない。
    assert.equal((await post('/api/hierarchy/remove/apply',{token:project,confirm:true})).status,409);
  }
  assert.deepEqual(fs.readFileSync(path.join(pdir,'PROJECT.md')),before);
  assert.deepEqual(fs.readdirSync(path.join(pdir,'.ai/tasks')).sort(),names);
  assert.ok(fs.existsSync(path.join(home,'Documents/freetalk/AGENTS.md')));
});
test('正規HTTP：別表記の会話・添付・MCPを拒否し、会話や再開情報を分裂させない',async()=>{
  for(const project of ['FreeTalk','FREETALK']) {
    for(const route of ['/api/chat/send','/api/chat/note','/api/chat/stop','/api/chat/unqueue',
      '/api/task/read','/api/task/attach','/api/chatgpt/prompt','/api/chatgpt/result','/api/delegate'])
      assert.equal((await post(route,{project,task:a.id,text:'別表記',ai:'codex',model:'GPT-6.1-Sol'})).status,route.startsWith('/api/chatgpt/')?410:409,route);
    assert.equal((await fetch(base+'/api/chat/stream?project='+project+'&task='+a.id)).status,409);
    assert.equal((await fetch(base+'/api/task/upload?project='+project+'&task='+a.id+'&name=alias.txt',
      {method:'POST',headers:{'X-Hub':'1'},body:'別表記'})).status,409);
    const r=await post('/api/mcp/call',{name:'hub_get_task',arguments:{project,task:a.id}});
    assert.ok(r.status>=400,'MCPでも別表記を解決しない');
  }
  assert.equal((await state()).stopControl.paused,false,'別表記の停止は保留も作らない');
  assert.deepEqual(chat.read(pdir,a.id),[]);
  assert.equal(fs.existsSync(path.join(home,'Documents/freetalk/topics')),false);
});
test('正規HTTP：2話題の発言・再開ID・引継ぎが混ざらずcwdは専用Documents、題名は最初だけ',async()=>{
  for(const [topic,text] of [[a,'海の相談 sentinel-one'],[b,'山の相談 sentinel-two'],[a,'海の続き sentinel-next']]) {
    const r=await post('/api/chat/send',{project:'freetalk',task:topic.id,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text});
    assert.equal(r.status,200,await r.text());
    const n=topic.id===a.id&&text.includes('next')?2:1;
    await wait(()=>chat.read(pdir,topic.id).filter(x=>x.role==='assistant').length>=n);
  }
  const ar=chat.read(pdir,a.id),br=chat.read(pdir,b.id);
  assert.equal(ar.filter(x=>x.role==='user').length,2);assert.equal(br.filter(x=>x.role==='user').length,1);
  const ai=JSON.parse(ar.find(x=>x.role==='assistant').text), bi=JSON.parse(br.find(x=>x.role==='assistant').text);
  assert.equal(ai.cwd,path.join(home,'Documents/freetalk'));assert.equal(bi.cwd,ai.cwd);
  assert.ok(!bi.input.includes('sentinel-one'));assert.ok(!ai.input.includes('sentinel-two'));
  assert.match(bi.input,/別の話題に分けますか/);assert.doesNotMatch(bi.input,/無ければ3〜5個|実施した手順だけ/);
  assert.notEqual(chat.readMeta(pdir,a.id).sessions.codex,chat.readMeta(pdir,b.id).sessions.codex);
  assert.equal(store.readTask(store.taskFile('freetalk',a.id)).title,'海の相談 sentinel-one');
  assert.ok(!taskPrompt(store.readProject('freetalk'),a,null,ai.cwd).includes('完了に移す'));
  const prior=chat.read(pdir,a.id);assert.equal((await post('/api/chatgpt/prompt',{project:'freetalk',task:a.id,text:'相談を続ける'})).status,410);assert.deepEqual(chat.read(pdir,a.id),prior);
});
test('正規HTTP：添付は一時Documentsの該当話題だけ、再登録で変えない',async()=>{
  const r=await fetch(base+'/api/task/upload?project=freetalk&task='+a.id+'&name=note.txt&generation=1',{method:'POST',headers:{'X-Hub':'1'},body:'相談資料'});
  assert.equal(r.status,200);const saved=(await r.json()).path;
  assert.ok(saved.startsWith(path.join(home,'Documents/freetalk/topics',a.id)+path.sep));assert.equal(fs.readFileSync(saved,'utf8'),'相談資料');
  assert.equal((await(await post('/api/freetalk/ensure')).json()).ready,true);assert.equal(fs.readFileSync(saved,'utf8'),'相談資料');
});
test('添付HTTP：世代必須・遅延受信中busy・移行済み拒否、ネイティブもコピーだけを返す',async()=>{
 const topic=await(await post('/api/freetalk/topic')).json(),task=topic.id;
 const upload=(generation)=>fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task,name:'file.txt',...(generation===undefined?{}:{generation})}),{method:'POST',headers:{'X-Hub':'1'},body:'local'});
 assert.equal((await upload()).status,409);assert.equal((await upload(99)).status,409);
 const source=path.join(tmp,'原本.txt');fs.writeFileSync(source,'original');
 const native=await post('/api/task/attach',{project:'freetalk',task,generation:1,paths:[source]});assert.equal(native.status,200);const result=await native.json();assert.ok(!JSON.stringify(result).includes(source));assert.equal(fs.readFileSync(result.attachments[0].path,'utf8'),'original');
 const http=require('node:http');let finish;
 const pending=new Promise(resolve=>{const req=http.request(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task,name:'slow.txt',generation:1}),{method:'POST',headers:{'X-Hub':'1','Content-Length':'4'}},res=>{let out='';res.on('data',d=>out+=d);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(out)}));});req.on('error',e=>{throw e;});req.write('s');finish=()=>req.end('low');});
 let h;for(let i=0;i<100;i++){h=await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+task)).json();if(h.reason)break;await new Promise(r=>setTimeout(r,10));}assert.match(h.reason,/追加中/);
 for(const route of ['/api/freetalk/rotate','/api/freetalk/delete','/api/freetalk/clean'])assert.equal((await post(route,{project:'freetalk',task,confirm:true,revision:h.revision})).status,409,route);
 finish();assert.equal((await pending).status,200);
 const aborting=http.request(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task,name:'aborted.txt',generation:1}),{method:'POST',headers:{'X-Hub':'1','Content-Length':'4'}});aborting.on('error',()=>{});aborting.write('a');
 for(let i=0;i<100;i++){h=await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+task)).json();if(h.reason)break;await new Promise(r=>setTimeout(r,10));}assert.match(h.reason,/追加中/);aborting.destroy();
 for(let i=0;i<100;i++){h=await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+task)).json();if(!h.reason)break;await new Promise(r=>setTimeout(r,10));}assert.equal(h.reason,'','受信中断でもbusyを解除');
 h=await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+task)).json();assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task,confirm:true,revision:h.revision})).status,200);
 assert.equal((await upload(1)).status,409);assert.equal((await upload(2)).status,200);assert.equal(fs.readFileSync(source,'utf8'),'original');
 const {Freetalk}=require('../lib/freetalk'),{FreetalkHistory}=require('../lib/freetalk-history');const ft=new Freetalk(store,home);ft.ensure();const history=new FreetalkHistory(ft);history.save(task,{generation:2,migrated:{project:'retained'}});
 assert.equal((await upload(2)).status,409);assert.equal((await post('/api/task/attach',{project:'freetalk',task,generation:2,paths:[source]})).status,409);
});
test('添付HTTP：画像は話題サムネとCodex -i、別話題・リンク・共通画像経路を拒否',async()=>{
 const topic=await(await post('/api/freetalk/topic')).json(),task=topic.id,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const r=await fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task,name:'image.png',generation:1}),{method:'POST',headers:{'X-Hub':'1'},body:png});assert.equal(r.status,200);const image=await r.json();
 const preview=await fetch(base+image.url);assert.equal(preview.status,200);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
 assert.equal((await fetch(base+image.url.replace(task,a.id))).status,404);assert.equal((await fetch(base+'/api/freetalk/attachment?project=freetalk&task='+task+'&id=../outside')).status,404);
 assert.equal((await fetch(base+'/api/start/image?project=freetalk&name=x.png',{method:'POST',headers:{'X-Hub':'1'},body:png})).status,409);
 assert.equal((await post('/api/start/image-path',{project:'freetalk',path:image.path})).status,409);
 assert.equal((await post('/api/chat/send',{project:'freetalk',task,generation:1,ai:'codex',model:'GPT-6.1-Sol',text:'参照 '+image.path,images:[image.id]})).status,200);
 await wait(()=>chat.read(pdir,task).some(x=>x.role==='assistant'));const response=JSON.parse(chat.read(pdir,task).find(x=>x.role==='assistant').text);assert.equal(response.args[response.args.indexOf('-i')+1],image.path);assert.ok(response.input.includes(image.path));
 assert.equal((await post('/api/chat/send',{project:'freetalk',task:a.id,generation:1,ai:'codex',model:'GPT-6.1-Sol',text:'invalid',images:[image.id]})).status,409);
 const external=path.join(tmp,'outside.png');fs.writeFileSync(external,png);fs.unlinkSync(image.path);fs.symlinkSync(external,image.path);assert.equal((await fetch(base+image.url)).status,404);assert.deepEqual(fs.readFileSync(external),png);
});
test('正規HTTP：A実行中にBも開始し、二重開始・掃除・移行・整理を拒否して話題別に終了する',async()=>{
 const topics=[await(await post('/api/freetalk/topic')).json(),await(await post('/api/freetalk/topic')).json()];
 const sentinels=['parallel-sentinel-a','parallel-sentinel-b'];
 const send=(topic,text)=>post('/api/chat/send',{project:'freetalk',task:topic.id,ai:'codex',model:'GPT-6.1-Sol',text});
 try {
  const first=await send(topics[0],sentinels[0]);assert.equal(first.status,200,await first.text());
  await wait(()=>fs.existsSync(path.join(bin,sentinels[0]+'.started')));
  const second=await send(topics[1],sentinels[1]);assert.equal(second.status,200,await second.text());
  await wait(()=>fs.existsSync(path.join(bin,sentinels[1]+'.started')));
  for(const topic of topics){
   const h=await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+topic.id)).json();assert.match(h.reason,/作業中/);
   assert.equal(chat.read(pdir,topic.id).filter(x=>x.role==='assistant').length,0,'両話題のCLIを同時に保持');
   assert.equal((await send(topic,'二重開始')).status,409);
   for(const route of ['/api/freetalk/summary','/api/freetalk/rotate','/api/freetalk/promote','/api/freetalk/delete'])
    assert.equal((await post(route,{project:'freetalk',task:topic.id,confirm:true,revision:h.revision})).status,409,route);
  }
  assert.equal((await post('/api/freetalk/clean',{project:'freetalk',confirm:true})).status,409);
 } finally {
  for(const sentinel of sentinels)fs.writeFileSync(path.join(bin,sentinel+'.release'),'');
  for(const [i,topic] of topics.entries())await wait(()=>!fs.existsSync(path.join(bin,sentinels[i]+'.started'))||chat.read(pdir,topic.id).some(x=>x.role==='assistant'));
 }
 for(const [i,topic] of topics.entries()){
  const rows=chat.read(pdir,topic.id);assert.equal(rows.filter(x=>x.role==='user').length,1);assert.equal(rows.filter(x=>x.role==='assistant').length,1);
  const response=JSON.parse(rows.find(x=>x.role==='assistant').text);assert.match(response.input,new RegExp(sentinels[i]));assert.ok(!response.input.includes(sentinels[1-i]));
 }
 assert.notEqual(chat.readMeta(pdir,topics[0].id).sessions.codex,chat.readMeta(pdir,topics[1].id).sessions.codex);
});

for (const scenario of ['redo-image', 'redo-empty', 'amend', 'automatic', 'manual']) {
 test(`添付キューHTTP：${scenario}の保存画像と偽Codex実argvが一致し、旧確認は復活しない`,async()=>{
  const topic=await(await post('/api/freetalk/topic')).json(),task=topic.id;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const upload=async name=>{const r=await fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task,name,generation:1}),{method:'POST',headers:{'X-Hub':'1'},body:png});assert.equal(r.status,200);return r.json();};
  const old=await upload('old.png'),fresh=await upload('new.png');
  const send=body=>post('/api/chat/send',{project:'freetalk',task,generation:1,ai:'codex',model:'GPT-6.1-Sol',...body});
  const saved=()=>JSON.parse(fs.readFileSync(path.join(pdir,'.ai/chat',task+'.queue.json'),'utf8'));
  const marker=path.join(bin,'image-queue-gate-'+scenario),replacing=scenario.startsWith('redo')||scenario==='amend';
  const original=chat.ChatRunner.prototype.sendQueued;
  let runner,previousBefore,calls=0,releaseOld,releaseNew,sending;
  chat.ChatRunner.prototype.sendQueued=function(o){
   if(o.project==='freetalk'&&o.task===task){
    if(!runner){runner=this;previousBefore=this.beforeQueued;}
    const n=++calls;
    this.beforeQueued=scenario==='manual'&&n===1 ? ()=>{throw Error('fixture: pause for manual resume');}
     : ()=>new Promise(resolve=>{if(n===1)releaseOld=resolve;else releaseNew=resolve;});
   }
   return original.call(this,o);
  };
  try {
   assert.equal((await send({text:path.basename(marker)})).status,200);
   await wait(()=>fs.existsSync(marker+'.started'));
   const queued=await send({mode:'queue',text:'queued image '+old.path,images:[old.id]});assert.equal(queued.status,200);const id=(await queued.json()).id;
   assert.deepEqual(saved()[0].images,[old.path]);
   fs.writeFileSync(marker+'.release','yes');
   if(scenario==='manual'){
    await wait(()=>runner&&!runner.busy('freetalk',task)&&runner.queue('freetalk',task)[0]?.error);
    assert.equal(saved()[0].id,id);assert.deepEqual(saved()[0].images,[old.path]);
    sending=send({fromQueue:id});await wait(()=>Boolean(releaseNew));
   }else{
    await wait(()=>Boolean(releaseOld));
    assert.equal(runner.busy('freetalk',task).pending,true);assert.deepEqual(runner.busy('freetalk',task).options.images,[old.path]);
   }
   const expected=scenario==='redo-image'?[fresh.path]:scenario==='redo-empty'?[]:scenario==='amend'?[old.path,fresh.path]:[old.path];
   if(replacing){
    const mode=scenario==='amend'?'amend':'redo',text='replacement '+(scenario==='redo-empty'?'without image':fresh.path);
    const before=fs.readFileSync(path.join(pdir,'.ai/chat',task+'.queue.json'),'utf8');
    assert.equal((await send({mode,text,generation:99,images:[fresh.id]})).status,409);
    assert.equal((await send({mode,text,images:['missing-image']})).status,409);
    assert.equal(fs.readFileSync(path.join(pdir,'.ai/chat',task+'.queue.json'),'utf8'),before);
    sending=send({mode,text,...(scenario==='redo-empty'?{}:{images:scenario==='amend'?[old.id,fresh.id]:[fresh.id]})});
    await wait(()=>Boolean(releaseNew));
    assert.notEqual(saved()[0].id,id);assert.deepEqual(saved()[0].images,expected);
    assert.deepEqual(runner.busy('freetalk',task).options.images,expected);
    // 取り消した確認を後から終えても、新しい依頼・画像一覧を戻さない。
    releaseOld();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runner.queue('freetalk',task).some(x=>x.id===id),false);
    releaseNew();assert.equal((await sending).status,200);
   }else if(scenario==='manual'){releaseNew();assert.equal((await sending).status,200);}
   else releaseOld();
   await wait(()=>chat.read(pdir,task).filter(x=>x.role==='assistant').length===2&&!runner.busy('freetalk',task));
   const response=JSON.parse(chat.read(pdir,task).filter(x=>x.role==='assistant').at(-1).text),images=[];
   for(let i=0;i<response.args.length;i++)if(response.args[i]==='-i')images.push(response.args[i+1]);
   assert.deepEqual(images,expected);assert.deepEqual(saved(),[]);
   if(scenario==='redo-image'||scenario==='amend')assert.ok(response.input.includes(fresh.path));
   if(scenario.startsWith('redo'))assert.ok(!response.input.includes(old.path));
   else assert.ok(response.input.includes(old.path));
   console.log(JSON.stringify({scenario,cliImages:images,expectedImages:expected,queueEmpty:true}));
  } finally {
   releaseOld?.();releaseNew?.();fs.writeFileSync(marker+'.release','yes');
   if(sending)await sending;
   if(runner){await runner.stop('freetalk',task);runner.beforeQueued=previousBefore;}
   chat.ChatRunner.prototype.sendQueued=original;
  }
 });
}

test('生成画像は終了行に保存し、freetalkでもMacと認証済みスマホで元画像を閲覧できる',async()=>{
  const before=chat.read(pdir,a.id).filter(x=>x.role==='assistant').length;
  assert.equal((await post('/api/chat/send',{project:'freetalk',task:a.id,ai:'codex',model:'GPT-6.1-Sol',text:'generated-image-sentinel'})).status,200);
  await wait(()=>chat.read(pdir,a.id).filter(x=>x.role==='assistant').length>before);
  const saved=fs.readFileSync(chat.files(pdir,a.id).log,'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(saved.generatedImages.length,1);
  const file=saved.generatedImages[0].path;
  const reveal=await post('/api/reveal',{project:'freetalk',task:a.id,path:file,how:'info'});
  assert.equal(reveal.status,200);const info=await reveal.json();assert.equal(info.viewKind,'image');
  const url=base+'/api/file/view?'+new URLSearchParams({project:'freetalk',task:a.id,path:file});
  assert.equal((await fetch(url)).status,200);
  for(const how of ['open','finder']) assert.equal((await post('/api/reveal',{project:'freetalk',task:a.id,path:file,how,app:true})).status,200);
  assert.equal((await post('/api/reveal',{project:'FreeTalk',task:a.id,path:file,how:'info'})).status,409);
  const headers={'X-Forwarded-Host':'fixture.tailnet.ts.net','X-Forwarded-For':'100.64.0.7'};
  assert.equal((await post('/api/remote',{enabled:true,passcode:'fixture-image-pass'})).status,200);
  assert.equal((await fetch(url,{headers})).status,401);
  const login=await post('/api/login',{passcode:'fixture-image-pass'},{'X-Hub':'1',...headers});assert.equal(login.status,200);
  const auth={'X-Hub':'1',...headers,Cookie:login.headers.get('set-cookie').split(';')[0]};
  const remote=await post('/api/reveal',{project:'freetalk',task:a.id,path:file,how:'info'},auth);
  assert.equal(remote.status,200);assert.equal((await remote.json()).remote,true);
  const response=await fetch(url,{headers:auth});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(file));
});

test('Muse in freetalk: browser send/read isolate topics and fence stale, busy and migrated conversations',async t=>{
  const {MuseSettings}=require('../lib/muse-settings'),crypto=require('node:crypto');
  let sends=0,reads=0,finish;
  // Only the external helper is substituted; HTTP guards, workspace validation,
  // durable send/read journals, conversation persistence and busy gates are real.
  t.mock.method(MuseSettings.prototype,'folder',()=>'/synthetic/unused-bundle');
  t.mock.method(MuseSettings.prototype,'directChat',async(project,task,file)=>{
    sends++;const e=JSON.parse(fs.readFileSync(file));
    assert.equal(e.project,'freetalk');assert.equal(e.task,task);
    assert.equal(e.request.question,'Only this visible question');
    assert.deepEqual(Object.keys(e.request).sort(),['expires_at','materials','question','request_key']);
    assert.deepEqual(e.request.materials,[]);
    return new Promise(r=>finish=()=>r({status:'sent',discussion_id:'discussion-'+task,exchange_id:'exchange-'+task}));
  });
  t.mock.method(MuseSettings.prototype,'directRead',async(project,task,file)=>{
    reads++;const e=JSON.parse(fs.readFileSync(file));assert.equal(e.request.discussion_id,'discussion-'+task);
    return {status:'received',text:'External reply for '+task,discussion_id:'discussion-'+task,exchange_id:'exchange-'+task};
  });
  const c=await(await post('/api/freetalk/topic')).json(),d=await(await post('/api/freetalk/topic')).json();
  chat.append(pdir,d.id,{role:'user',text:'Other topic must stay private'});
  const other=fs.readFileSync(chat.files(pdir,d.id).log);
  const headers={'X-Hub':'1',Origin:base};
  const body={project:'freetalk',task:c.id,id:'direct_'+crypto.randomUUID(),generation:1,question:'Only this visible question',materials:[]};
  assert.equal((await post('/api/muse/chat',body)).status,403,'browser origin is required');
  for(const generation of [undefined,0,2])assert.equal((await post('/api/muse/chat',{...body,generation},headers)).status,409);
  assert.equal(sends,0);
  const inFlight=post('/api/muse/chat',body,headers);await wait(()=>sends===1);
  assert.match((await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+c.id)).json()).reason,/作業中/);
  const duplicate=await post('/api/muse/chat',{...body,id:'direct_'+crypto.randomUUID()},headers);
  assert.equal(duplicate.status,409);assert.equal(sends,1);
  const stopRead=await post('/api/muse/read',{project:'freetalk',task:c.id,id:'read_'+crypto.randomUUID(),sourceId:body.id,generation:1},headers);
  assert.equal(stopRead.status,409);assert.equal(reads,0);
  finish();assert.equal((await(await inFlight).json()).state,'sent');
  const pending=await(await fetch(base+'/api/muse/chat?project=freetalk&task='+c.id,{headers:{'X-Hub':'1'}})).json();
  assert.equal(pending.pending.id,body.id);assert.equal(pending.pending.state,'sent');
  const read={project:'freetalk',task:c.id,id:'read_'+crypto.randomUUID(),sourceId:body.id,generation:1};
  assert.equal((await post('/api/muse/read',{...read,generation:2},headers)).status,409);assert.equal(reads,0);
  assert.equal((await(await post('/api/muse/read',read,headers)).json()).state,'received');
  assert.equal(reads,1);assert.equal(sends,1);
  assert.equal((await(await post('/api/muse/read',read,headers)).json()).state,'received');assert.equal(reads,1);
  assert.deepEqual(chat.read(pdir,c.id).map(r=>[r.role,r.ai]),[['user','muse'],['event','muse'],['assistant','muse']]);
  assert.match(chat.contextPacket(chat.read(pdir,c.id)),/external_muse_reference/);
  assert.deepEqual(fs.readFileSync(chat.files(pdir,d.id).log),other);
  assert.equal((await(await fetch(base+'/api/muse/chat?project=freetalk&task='+d.id,{headers:{'X-Hub':'1'}})).json()).pending,null);
  // A migrated topic remains read-only, including Muse direct operations.
  const history=path.join(pdir,'.ai/freetalk',c.id+'.json');fs.mkdirSync(path.dirname(history),{recursive:true});
  fs.writeFileSync(history,JSON.stringify({generation:1,migrated:{project:'Synthetic'}}));
  assert.equal((await post('/api/muse/chat',{...body,id:'direct_'+crypto.randomUUID()},headers)).status,409);
  assert.equal(sends,1);
});

test('Muse in freetalk: exchange limit stays unblocked and follow-up recovery never resends',async t=>{
  const {MuseSettings}=require('../lib/muse-settings'),crypto=require('node:crypto');
  let sends=0,checks=0;
  t.mock.method(MuseSettings.prototype,'folder',()=>'/synthetic/unused-bundle');
  t.mock.method(MuseSettings.prototype,'directChat',async()=>{
    sends++;
    if(sends===1)return {status:'not-sent',diagnostic:{code:'exchange_limit',phase:'send_prepare',open_confirmed:true}};
    return {status:'unknown',diagnostic:{code:'send_uncertain',phase:'send',open_confirmed:true}};
  });
  t.mock.method(MuseSettings.prototype,'directInspect',async(project,task,file)=>{
    checks++;const e=JSON.parse(fs.readFileSync(file)),raw=fs.readFileSync(path.join(pdir,'.ai/muse-approvals/.decisions',task,e.id+'.json')),d=JSON.parse(raw);
    return {status:'not-sent',scope:'follow-up-none',open_confirmed:true,project,task,id:e.id,discussion_id:'existing-discussion',
      requestSHA:d.requestSHA,decisionSHA:crypto.createHash('sha256').update(raw).digest('hex'),markerSHA:'a'.repeat(64),digest:d.digest};
  });
  const topic=await(await post('/api/freetalk/topic')).json(),headers={'X-Hub':'1',Origin:base};
  const body={project:'freetalk',task:topic.id,id:'direct_'+crypto.randomUUID(),generation:1,question:'Synthetic question',materials:[]};
  const limited=await(await post('/api/muse/chat',body,headers)).json();
  assert.equal(limited.state,'not-sent');assert.match(limited.notice,/今回の質問は送っていません/);
  const pending=async()=> (await(await fetch(base+'/api/muse/chat?project=freetalk&task='+topic.id,{headers:{'X-Hub':'1'}})).json()).pending;
  assert.equal(await pending(),null);
  const next={...body,id:'direct_'+crypto.randomUUID()};
  assert.equal((await(await post('/api/muse/chat',next,headers)).json()).state,'unknown');assert.equal(sends,2);
  const reconcile={project:'freetalk',task:topic.id,id:next.id,generation:1};
  assert.equal((await post('/api/muse/reconcile',reconcile)).status,403);assert.equal(checks,1);
  const result=await(await post('/api/muse/reconcile',reconcile,headers)).json();
  assert.equal(result.state,'not-sent');assert.match(result.notice,/題名としても届いていません/);
  assert.equal(await pending(),null);assert.equal(sends,2);assert.equal(checks,2);
  assert.equal((await(await post('/api/muse/reconcile',reconcile,headers)).json()).notice,result.notice);
  assert.equal(checks,2);assert.equal(sends,2);
});
