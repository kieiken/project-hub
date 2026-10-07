'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ft-lifecycle-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin');
fs.mkdirSync(bin);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
if(process.argv.includes('--version')){console.log('fake codex');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'fake-'+process.pid}));setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'AIがまとめた要約'}}));console.log(JSON.stringify({type:'turn.completed'}));},250);});`,{mode:0o755});
const port=46000+Math.floor(Math.random()*1000);Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:home,HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(port),PATH:bin+path.delimiter+process.env.PATH});
const {server}=require('../server'),{Store}=require('../lib/store'),chat=require('../lib/chat');const store=new Store(root);let base,a,b,body,r;
const post=(route,body={},headers={'X-Hub':'1'})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const status=async id=>await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+id)).json();
const idle=async id=>{for(let i=0;i<300;i++){const h=await status(id);if(!h.reason)return h;await new Promise(r=>setTimeout(r,20));}throw Error('fake CLI did not end');};
test.before(async()=>{await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;await post('/api/freetalk/ensure');a=await(await post('/api/freetalk/topic')).json();b=await(await post('/api/freetalk/topic')).json();});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('3段目HTTP：認証・別表記と稼働/待機保護、現在AIへの要約',async()=>{
 assert.equal((await post('/api/freetalk/clean',{project:'freetalk',confirm:true},{})).status,403);
 for(const project of ['FreeTalk','FREETALK','normal'])assert.equal((await post('/api/freetalk/clean',{project,confirm:true})).status,409);
 const p=store.readProject('freetalk');chat.append(p.dir,a.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'相談'});
 const s=await post('/api/freetalk/summary',{project:p.id,task:a.id});assert.equal(s.status,200);
 assert.equal((await post('/api/freetalk/clean',{project:p.id,confirm:true})).status,409);
 assert.equal((await post('/api/freetalk/project-preview',{project:p.id,task:a.id})).status,409);
 const q=await post('/api/chat/send',{project:p.id,task:a.id,ai:'codex',model:'GPT-6.1-Sol',text:'もう一つ確認',mode:'queue'});assert.equal(q.status,200);assert.equal((await q.json()).queued,true);
 assert.equal((await post('/api/freetalk/clean',{project:p.id,confirm:true})).status,409);await idle(a.id);
 // 待機した普通の回答は承認要約にしない。改めて現在AIへ要約。
 assert.equal((await post('/api/freetalk/project-preview',{project:p.id,task:a.id})).status,409);
 await post('/api/freetalk/summary',{project:p.id,task:a.id});await idle(a.id);
});
test('3段目HTTP：確認した名前・要約・ファイルで独立し同操作ID再送は一度だけ',async()=>{
 const p=store.readProject('freetalk');fs.mkdirSync(path.join(home,'Documents/freetalk/notes'));fs.writeFileSync(path.join(home,'Documents/freetalk/notes/計画.txt'),'相談資料');
 const preview=await post('/api/freetalk/project-preview',{project:p.id,task:a.id});assert.equal(preview.status,200);const d=await preview.json();
 body={...d,project:p.id,task:a.id,name:'旅行プロジェクト',summary:'人が編集した旅行の要約',files:d.files.map(f=>f.path),confirm:true};
 assert.equal((await post('/api/freetalk/promote',{...body,confirm:false})).status,409);
 const result=await post('/api/freetalk/promote',body);assert.equal(result.status,200,JSON.stringify(await result.clone().json()));r=await result.json();
 const repeat=await post('/api/freetalk/promote',body);assert.equal(repeat.status,200);assert.equal((await repeat.json()).repeated,true);
 const dest=store.readProject(r.project);assert.match(chat.read(dest.dir,r.task)[0].text,/人が編集した旅行の要約/);assert.deepEqual(chat.readMeta(dest.dir,r.task).sessions,{});
 assert.equal(fs.readFileSync(path.join(dest.dir,'資料/相談ファイル/notes/計画.txt'),'utf8'),'相談資料');assert.ok(fs.existsSync(path.join(dest.dir,'資料/自由対話原文.jsonl')));
});
test('3段目HTTP：移行元は会話/要約/クリア/設定/MCP/添付を書き込めない',async()=>{
 assert.equal((await status(a.id)).migrated.project,r.project);
 for(const [route,extra]of [['/api/chat/send',{ai:'codex',model:'GPT-6.1-Sol',text:'再開'}],['/api/chat/note',{text:'追加'}],['/api/chatgpt/result',{text:'追加'}],['/api/freetalk/rotate',{confirm:true}],['/api/freetalk/summary',{}],['/api/task',{memo:'変更'}],['/api/task/attach',{paths:[path.join(home,'Documents/freetalk/AGENTS.md')]}],['/api/accounts/select',{ai:'codex',account:'default'}]])assert.equal((await post(route,{project:'freetalk',task:a.id,...extra})).status,409,route);
 assert.equal((await post('/api/mcp/call',{name:'hub_report',arguments:{project:'freetalk',task:a.id,text:'変更'}})).status,409);
 const upload=await fetch(base+'/api/task/upload?'+new URLSearchParams({project:'freetalk',task:a.id,name:'a.txt'}),{method:'POST',headers:{'X-Hub':'1'},body:'資料'});assert.equal(upload.status,409);
 assert.equal((await post('/api/task/read',{project:'freetalk',task:a.id})).status,200);
 const read=await fetch(base+'/api/chat/stream?project=freetalk&task='+a.id);assert.equal(read.status,200);await read.body.cancel();
});
test('話題削除HTTP：認証と確認が必要、移行済みもfreetalk側だけ消え、移行先と他の話題は残る',async()=>{
 const p=store.readProject(r.project),transcript=fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl'));
 assert.equal((await post('/api/freetalk/delete',{project:'freetalk',task:a.id,confirm:true},{})).status,403);
 assert.equal((await post('/api/freetalk/delete',{project:'freetalk',task:a.id})).status,409);
 assert.equal((await post('/api/freetalk/delete',{project:'FreeTalk',task:a.id,confirm:true})).status,409);
 const del=await post('/api/freetalk/delete',{project:'freetalk',task:a.id,confirm:true});assert.equal(del.status,200,JSON.stringify(await del.clone().json()));
 const ids=store.readProject('freetalk').tasks.map(t=>t.id);assert.ok(!ids.includes(a.id));assert.ok(ids.includes(b.id));
 assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),transcript);
 assert.equal((await post('/api/freetalk/delete',{project:'freetalk',task:a.id,confirm:true})).status,409);
});
test('3段目HTTP：掃除後に独立先と通常プロジェクトは保持し、新しい話題へ続行',async()=>{
 const ordinary=store.createProject({name:'別のプロジェクト'}).project,original=fs.readFileSync(path.join(ordinary.dir,'PROJECT.md'));
 const p=store.readProject(r.project),transcript=fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl'));
 assert.equal((await post('/api/freetalk/clean',{project:'freetalk'})).status,409);
 assert.equal((await post('/api/freetalk/clean',{project:'freetalk',automatic:true})).status,409);
 const clean=await post('/api/freetalk/clean',{project:'freetalk',confirm:true});assert.equal(clean.status,200);
 assert.equal(store.readProject('freetalk').tasks.length,0);assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),transcript);assert.deepEqual(fs.readFileSync(path.join(ordinary.dir,'PROJECT.md')),original);
 const next=await(await post('/api/freetalk/topic')).json();assert.notEqual(next.id,a.id);assert.notEqual(next.id,b.id);
 const send=await post('/api/chat/send',{project:r.project,task:r.task,ai:'codex',model:'GPT-6.1-Sol',text:'計画の続き'});assert.equal(send.status,200);assert.equal((await send.json()).resume,false);
 for(let i=0;i<150;i++){if(chat.read(p.dir,r.task).some(x=>x.role==='assistant'))break;await new Promise(r=>setTimeout(r,20));}assert.ok(chat.read(p.dir,r.task).some(x=>x.role==='assistant'));
 const state=await(await fetch(base+'/api/state')).json();assert.ok(state.freetalk.cleanup.due);assert.equal(state.freetalk.cleanup.overdue,false);
});
