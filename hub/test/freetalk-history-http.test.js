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
setTimeout(()=>{out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({cwd:process.cwd(),input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)')})}});out({type:'turn.completed'});},200);
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

const status=async id=>await(await fetch(base+'/api/freetalk/status?project=freetalk&task='+id)).json();
const idle=async id=>{for(let i=0;i<250;i++){const h=await status(id);if(!h.reason)return h;await new Promise(r=>setTimeout(r,20));}throw Error('fake did not end');};
test('2段目HTTP：認証/別表記/他プロジェクト拒否、2話題分離と境界',async()=>{
 await post('/api/freetalk/ensure');a=await(await post('/api/freetalk/topic')).json();b=await(await post('/api/freetalk/topic')).json();
 assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true},{})).status,403);
 for(const project of ['FreeTalk','FREETALK','normal'])assert.equal((await post('/api/freetalk/rotate',{project,task:a.id,confirm:true})).status,409);
 chat.append(pdir,a.id,{role:'user',text:'あ'.repeat(239000)});assert.equal((await status(a.id)).warning,false);
 chat.append(pdir,a.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'a'.repeat(3999)});assert.equal((await status(a.id)).warning,true);assert.equal((await status(b.id)).tokens,0);
 for(const related of [['freetalk'],['FreeTalk'],'ordinary, FREETALK'])assert.equal((await post('/api/project/new',{name:'normal',related})).status,409);
});
test('2段目HTTP：現在のAIに要約依頼、稼働中拒否、確認編集した要約だけ新世代',async()=>{
 const r=await post('/api/freetalk/summary',{project:'freetalk',task:a.id});assert.equal(r.status,200,JSON.stringify(await r.json()));
 const running=await status(a.id);assert.match(running.reason,/作業中/);
 assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true,revision:running.revision})).status,409);
 const h=await idle(a.id);assert.ok(h.draft);assert.ok(h.summaryId);
 assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true,revision:h.revision,summaryId:'fake',summary:'編集'})).status,409);
 const result=await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true,revision:h.revision,summaryId:h.summaryId,summary:'人が確認・編集した旅行計画'});assert.equal(result.status,200,JSON.stringify(await result.json()));
 assert.equal(chat.read(pdir,a.id).length,1);assert.match(chat.read(pdir,a.id)[0].text,/人が確認・編集/);assert.deepEqual(chat.readMeta(pdir,a.id).sessions,{});assert.equal((await status(a.id)).generation,2);
 const next=await post('/api/chat/send',{project:'freetalk',task:a.id,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'次の相談'});assert.equal(next.status,200);assert.equal((await next.json()).resume,false);await idle(a.id);
 const response=JSON.parse(chat.read(pdir,a.id).at(-1).text);assert.match(response.input,/人が確認・編集した旅行計画/);assert.doesNotMatch(response.input,/あ{100}/);
});
test('2段目HTTP：待機中拒否・確認済クリア後旧セッション不使用・他話題保持',async()=>{
 chat.append(pdir,b.id,{role:'user',text:'他の話題の記録'});const other=fs.readFileSync(path.join(pdir,'.ai/chat',b.id+'.jsonl'));
 const send=await post('/api/chat/send',{project:'freetalk',task:a.id,ai:'codex',model:'GPT-6.1-Sol',text:'まだ作業中'});assert.equal(send.status,200);
 const q=await post('/api/chat/send',{project:'freetalk',task:a.id,ai:'codex',model:'GPT-6.1-Sol',text:'待機中',mode:'queue'});assert.equal(q.status,200);assert.ok((await q.json()).queued);
 const h=await status(a.id);assert.ok(h.reason);assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true,revision:h.revision})).status,409);
 await idle(a.id);const ready=await status(a.id);assert.equal((await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,revision:ready.revision})).status,409);
 const clear=await post('/api/freetalk/rotate',{project:'freetalk',task:a.id,confirm:true,revision:ready.revision});assert.equal(clear.status,200);
 assert.deepEqual(chat.read(pdir,a.id),[]);assert.deepEqual(fs.readFileSync(path.join(pdir,'.ai/chat',b.id+'.jsonl')),other);
 const next=await post('/api/chat/send',{project:'freetalk',task:a.id,ai:'codex',model:'GPT-6.1-Sol',text:'空から相談'});assert.equal(next.status,200);assert.equal((await next.json()).resume,false);await idle(a.id);
 const response=JSON.parse(chat.read(pdir,a.id).at(-1).text);assert.doesNotMatch(response.input,/人が確認・編集した旅行計画|まだ作業中/);
});

test('2段目HTTP：ChatGPTは貼る経路で要約、人の確認前は元会話を保持',async()=>{
 await post('/api/chatgpt/result',{project:'freetalk',task:b.id,text:'ChatGPTの元の相談'});
 const r=await post('/api/freetalk/summary',{project:'freetalk',task:b.id});assert.equal(r.status,200);const body=await r.json();assert.equal(body.manual,true);assert.match(body.text,/要約/);
 assert.match(chat.read(pdir,b.id)[0].text,/他の話題/);
 await post('/api/chatgpt/result',{project:'freetalk',task:b.id,text:'貼って受け取った要約'});const h=await status(b.id);assert.equal(h.draft,'貼って受け取った要約');
 const done=await post('/api/freetalk/rotate',{project:'freetalk',task:b.id,confirm:true,revision:h.revision,summaryId:h.summaryId,summary:'人が編集したChatGPTの要約'});assert.equal(done.status,200);assert.equal(chat.read(pdir,b.id).length,1);assert.match(chat.read(pdir,b.id)[0].text,/人が編集したChatGPT/);
});
