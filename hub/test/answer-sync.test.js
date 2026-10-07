'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const chat = require('../lib/chat');
const { Store } = require('../lib/store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-answer-sync-'));
const root = path.join(tmp,'workspace'), dir = path.join(root,'Product','回答の見本'), bin = path.join(tmp,'bin');
let server, base;
const store = new Store(root);
const key = {project:'回答の見本',task:'answer'};
const file = path.join(dir,'.ai/tasks/answer.md');
const question = 'どちらで進めますか？';
const read = () => store.readTask(file);
const post = (route,body={}) => fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify({...key,...body})});
const send = body => post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'回答A',answerQuestion:question,...body});
function reset() {
  fs.writeFileSync(file,`---\nid: answer\ntitle: 回答の見本\nowner: codex\nmodel: GPT-6.1-Sol\nworkspaceMode: direct\nstate: 返事待ち\nquestion: ${question}\n---\n## 手順\n- [ ] 見本の確認\n`);
}
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: 回答の見本\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');reset();fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed'}));},2000));process.on('SIGTERM',()=>process.exit(143));\n`,{mode:0o755});
 process.env.PATH=bin+':/usr/bin:/bin';process.env.HUB_ROOT=root;process.env.HUB_PORT='0';process.env.HUB_DRY_RUN='1';process.env.HUB_AI_HOME=path.join(tmp,'home');process.env.HUB_TRASH=path.join(tmp,'trash');
 ({server}=require('../server'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];({server}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base=`http://127.0.0.1:${port}`;
});
test.afterEach(async()=>{
 await post('/api/chat/stop');
 // stop の受付と child の close は別。次の fixture を起動する前に終了を確かめる。
 const deadline=Date.now()+5000;
 while(true){
  const state=await (await fetch(base+'/api/state',{headers:{Connection:'close'}})).json();
  if(!state.chatting.length)break;
  assert.ok(Date.now()<deadline,'前の fake CLI が終了しない');
  await new Promise(r=>setTimeout(r,10));
 }
});
test.after(async()=>{if(server){await post('/api/chat/stop');await new Promise(r=>server.close(r));}});

test('起動の成功を受け付けてから質問を解除し、受付した原文を返す',async()=>{
 reset();const res=await send({});assert.equal(res.status,200);const body=await res.json();assert.equal(body.answeredQuestion,question);assert.equal(read().question,'');assert.equal(read().state,'実行中');await post('/api/chat/stop');
});
test('起動失敗とモデル拒否は返事待ちと質問を保持する',async()=>{
 reset();const original=fs.readFileSync(file,'utf8');assert.equal((await send({model:'unknown-model'})).status,409);assert.equal(fs.readFileSync(file,'utf8'),original);
 const command=path.join(bin,'codex');fs.renameSync(command,command+'.saved');try{const res=await send({});assert.equal(res.status,409);assert.match((await res.json()).error,/起動できません/);assert.equal(read().question,question);assert.equal(read().state,'返事待ち');}finally{fs.renameSync(command+'.saved',command);}await post('/api/chat/stop');
});
test('送信時と異なる新しい質問は成功時にも消さない',async()=>{
 reset();const newer='新しい質問です';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(question,newer));const body=await (await send({})).json();assert.equal(body.answeredQuestion,null);assert.equal(read().question,newer);assert.equal(read().state,'返事待ち');await post('/api/chat/stop');
});
test('起動待ちの間に更新された新質問を上書きしない',async()=>{
 reset();const original=chat.ChatRunner.prototype.send;
 chat.ChatRunner.prototype.send=function(o){const r=original.call(this,o);return {...r,started:r.started.then(ok=>{fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(question,'起動待ち中の新質問'));return ok;})};};
 try{const res=await send({});assert.equal(res.status,200);assert.equal((await res.json()).answeredQuestion,null);assert.equal(read().question,'起動待ち中の新質問');assert.equal(read().state,'返事待ち');}finally{chat.ChatRunner.prototype.send=original;}
});
test('順番待ちでも受付時に解除し、既存の指示順を保持する',async()=>{
 reset();assert.equal((await send({text:'作業中の見本'})).status,200);
 await send({mode:'queue',text:'先行の指示',answerQuestion:''});reset();
 const body=await (await send({mode:'queue',text:'質問への回答'})).json();assert.equal(body.queued,true);assert.equal(body.answeredQuestion,question);assert.equal(read().question,'');assert.equal(read().state,'実行中');
 const queue=JSON.parse(fs.readFileSync(path.join(dir,'.ai/chat/answer.queue.json'),'utf8'));assert.deepEqual(queue.map(x=>x.text),['先行の指示','質問への回答']);await post('/api/chat/stop');
});
test('送らずに消す操作は会話とAI起動を増やさない',async()=>{
 reset();const before=chat.read(dir,key.task).length;const res=await post('/api/task',{question:'',state:'実行中',memo:'人が質問を AI に送らずに消した'});assert.equal(res.status,200);assert.equal(read().question,'');assert.equal(chat.read(dir,key.task).length,before);
 const state=await (await fetch(base+'/api/state',{headers:{Connection:'close'}})).json();assert.equal(state.chatting.length,0);
});

// 下書きなどのDOMを保持したまま上部だけ同期する。新質問・別作業・古い取得を区別する。
const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const helper=app.slice(app.indexOf('let sendWorkAnswer = null;'),app.indexOf('\nfunction renderWork()'));
function ui() {
 const t={id:'answer',question,state:'返事待ち'},p={id:'p',tasks:[t]},slot={dataset:{question},innerHTML:'question'},badge={className:'pill',textContent:'返事待ち'},select={value:'返事待ち'},msgs={scrollTop:173};
 const retained={draft:'書きかけ',image:'見本画像',model:'GPT-6.1-Sol',effort:'極高'};
 const input={disabled:false},upper={querySelectorAll:()=>[input]},ask={dataset:{askKey:'old'},classList:{add:()=>{ask.done=true}},querySelector:()=>status},status={textContent:''};
 const c={UI:require('./ui-locale-fixture')(),view:{kind:'work',project:'p',task:'answer'},proj:()=>p,taskOf:()=>t,esc:x=>x,richText:x=>x,chatSending:new Set(),chatAttachmentKey:()=> 'p/answer',document:{querySelectorAll:()=>[ask]},updateAskControls:()=>{},refreshAsks:()=>{},askDrafts:new Map([['old','選択A']]),window:{HubMobile:{badges:()=>{c.badges++}}},stateLoadEpoch:0,badges:0,loads:0,tree:0,counts:0,toast:()=>{},updateTurnCounts:()=>{c.counts++},renderTree:()=>{c.tree++},load:async()=>{c.loads++},$:s=>({'#work-question':slot,'#msgs':msgs,'.whead .pill':badge,'.wfoot [data-act="state"]':select,'#ask-form':upper}[s])};vm.createContext(c);vm.runInContext(helper,c);return {c,t,p,slot,badge,select,msgs,retained,ask,status,input};
}
test('受付成功で上部と件数を即時更新し、下書きと読書位置は保持する',async()=>{
 const f=ui();await f.c.acceptedWorkAnswer(f.p,f.t,question,{answeredQuestion:question},'old');assert.equal(f.slot.innerHTML,'');assert.equal(f.badge.textContent,'実行中');assert.equal(f.select.value,'実行中');assert.equal(f.c.counts,1);assert.equal(f.c.badges,1);assert.equal(f.c.loads,1);assert.equal(f.c.stateLoadEpoch,1);assert.equal(f.msgs.scrollTop,173);assert.equal(f.ask.done,true);assert.deepEqual(f.retained,{draft:'書きかけ',image:'見本画像',model:'GPT-6.1-Sol',effort:'極高'});
});
test('上部と下部が同時に送信できず、失敗後は再操作できる',()=>{
 const f=ui();f.c.chatSending.add('p/answer');f.c.updateWorkAnswerControls();assert.equal(f.input.disabled,true);f.c.chatSending.delete('p/answer');f.c.updateWorkAnswerControls();assert.equal(f.input.disabled,false);assert.equal(f.t.question,question);
});
test('遅い旧成功は新しい質問と別作業の表示を消さない',async()=>{
 const f=ui();f.t.question='新しい質問';f.slot.dataset.question='新しい質問';f.slot.innerHTML='new';await f.c.acceptedWorkAnswer(f.p,f.t,question,{answeredQuestion:question,queued:true},'old');assert.equal(f.t.question,'新しい質問');assert.equal(f.slot.innerHTML,'new');assert.equal(f.ask.done,undefined);assert.equal(f.c.loads,1);
 const g=ui();g.c.view.task='別作業';await g.c.acceptedWorkAnswer(g.p,g.t,question,{answeredQuestion:question},'old');assert.equal(g.slot.innerHTML,'question');assert.equal(g.c.counts,0);assert.equal(g.c.loads,0);
});
test('順番待ちの受付はAI開始待ちと明記し、上部から送っても下部を無効にする',async()=>{
 const f=ui();await f.c.acceptedWorkAnswer(f.p,f.t,question,{answeredQuestion:question,queued:true},'old');assert.match(f.slot.innerHTML,/回答を受け付けました/);assert.match(f.slot.innerHTML,/この回答で AI が続けます/);assert.equal(f.ask.done,true);assert.match(f.status.textContent,/開始待ち/);
});

test('送信前の古い一覧取得は受付後の状態を復活させない',async()=>{
 const f=ui();let finish;f.c.fetchState=()=>new Promise(resolve=>{finish=resolve});f.c.state={projects:[f.p]};f.c.treeKey=()=>'';f.c.renderedTreeKey='';
 const start=app.indexOf('async function refreshTree()'),end=app.indexOf('const editing =',start);vm.runInContext(app.slice(start,end),f.c);
 const pending=f.c.refreshTree();await f.c.acceptedWorkAnswer(f.p,f.t,question,{answeredQuestion:question},'old');finish({projects:[{id:'p',tasks:[{id:'answer',question,state:'返事待ち'}]}]});await pending;assert.equal(f.c.state.projects[0].tasks[0].question,'');assert.equal(f.slot.innerHTML,'');
});
