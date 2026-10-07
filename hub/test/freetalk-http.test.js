'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../lib/store'), chat = require('../lib/chat');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'hub-freetalk-http-'));
const root = path.join(tmp,'root'), home = path.join(tmp,'home'), bin = path.join(tmp,'bin');
fs.mkdirSync(bin); fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
// 契約CLIには触らず、入力とcwdだけ返す偽物。
fs.writeFileSync(path.join(bin,'codex'), `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex fake');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const out=o=>console.log(JSON.stringify(o));out({type:'thread.started',thread_id:'topic-'+process.pid});
out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({cwd:process.cwd(),input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)')})}});out({type:'turn.completed'});
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
      assert.equal((await post(route,{project,task:a.id,text:'別表記',ai:'codex',model:'GPT-6.1-Sol'})).status,409,route);
    assert.equal((await fetch(base+'/api/chat/stream?project='+project+'&task='+a.id)).status,409);
    assert.equal((await fetch(base+'/api/task/upload?project='+project+'&task='+a.id+'&name=alias.txt',
      {method:'POST',headers:{'X-Hub':'1'},body:'別表記'})).status,409);
    const r=await post('/api/mcp/call',{name:'hub_get_task',arguments:{project,task:a.id}});
    assert.ok(r.status>=400,'MCPでも別表記を解決しない');
  }
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
  const gpt=await(await post('/api/chatgpt/prompt',{project:'freetalk',task:a.id,text:'相談を続ける'})).json();
  assert.match(gpt.text,/別の話題に分けますか/);assert.ok(!gpt.text.includes('sentinel-two'));
});
test('正規HTTP：添付は一時Documentsの該当話題だけ、再登録で変えない',async()=>{
  const r=await fetch(base+'/api/task/upload?project=freetalk&task='+a.id+'&name=note.txt',{method:'POST',headers:{'X-Hub':'1'},body:'相談資料'});
  assert.equal(r.status,200);const saved=(await r.json()).path;
  assert.ok(saved.startsWith(path.join(home,'Documents/freetalk/topics',a.id)+path.sep));assert.equal(fs.readFileSync(saved,'utf8'),'相談資料');
  assert.equal((await(await post('/api/freetalk/ensure')).json()).ready,true);assert.equal(fs.readFileSync(saved,'utf8'),'相談資料');
});
