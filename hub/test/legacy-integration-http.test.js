'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const path=require('node:path'), os=require('node:os'), net=require('node:net'), {execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'), chat=require('../lib/chat');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-legacy-http-'));
let server, base;
test.before(async()=>{
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port;
  await new Promise(r=>probe.close(r));
  process.env.HUB_ROOT=root; process.env.HUB_DRY_RUN='1'; process.env.HUB_AI_HOME=path.join(root,'home'); process.env.HUB_PORT=String(port); process.env.HUB_TRASH=path.join(root,'Trash');
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  ({server}=require('../server')); await new Promise(r=>server.listen(port,'127.0.0.1',r)); base='http://127.0.0.1:'+port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
const post=(route,b)=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(b)});
for(const code of [true,false])test('R3 HTTPの古い確認tokenは別mergeを壊さず保存・受領前に拒否：'+code,async()=>{
 const project='Foreign merge '+code,body=path.join(root,'System',project),dir=path.join(root,'Product',project),git=require('../lib/git');
 fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nfolders:\n  本体: ${body}\n---\n`);
 const sh=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
 fs.writeFileSync(path.join(body,'base.txt'),'base');sh(body,'init','-q','-b','main');sh(body,'add','.');sh(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),child=store.createTask(project,{title:'子',parent:parent.id,steps:['完成']});store.setStep(project,child.id,0,true);
 let copy;
 if(code){copy=git.prepare({base:body,workRoot:path.join(root,'Work',project),taskId:child.id});store.updateTask(project,child.id,{workdir:copy.dir});fs.writeFileSync(path.join(copy.dir,'result.txt'),'child');git.save(copy.dir,'child');}
 const report=path.join(dir,'作業',child.id,'report.txt');fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'report');
 const taskFile=store.taskFile(project,child.id),taskText=fs.readFileSync(taskFile,'utf8'),source=copy&&git.inspect(copy.dir);
 const journals=()=>Object.fromEntries(['task-integrations','task-handoffs'].flatMap(folder=>{
  const p=path.join(root,'_hub',folder);return fs.existsSync(p)?fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>[folder+'/'+n,fs.readFileSync(path.join(p,n),'utf8')]):[];
 }));
 const oldJournals=journals();let r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);const d=await r.json();
 sh(body,'checkout','-qb','unrelated-empty');sh(body,'commit','--allow-empty','-qm','unrelated');sh(body,'checkout','-q','main');sh(body,'merge','--no-ff','--no-commit','unrelated-empty');
 assert.deepEqual(git.inspect(body),d.targetSnapshot);
 const mergeHead=sh(body,'rev-parse','MERGE_HEAD'),indexPath=sh(body,'rev-parse','--path-format=absolute','--git-path','index'),index=fs.readFileSync(indexPath);
 r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,409);assert.match((await r.json()).error,/統合先で取り込みが途中/);
 r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({project,task:i.task,files:i.selected,optional:[]}))});
 assert.equal(r.status,409);assert.match((await r.json()).error,/統合先で取り込みが途中/);
 assert.equal(sh(body,'rev-parse','MERGE_HEAD'),mergeHead);assert.deepEqual(git.inspect(body),d.targetSnapshot);assert.deepEqual(fs.readFileSync(indexPath),index);
 assert.deepEqual(journals(),oldJournals);assert.equal(fs.readFileSync(taskFile,'utf8'),taskText);assert.equal(fs.readFileSync(report,'utf8'),'report');assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,0);
 if(copy)assert.deepEqual(git.inspect(copy.dir),source);
});
test('親の手順全済・確認待ち・継続は親の統合へ、承認済みなら子の本体取り込みへ進む',async()=>{
  const project='Parent approval boundary',body=path.join(root,'System',project),dir=path.join(root,'Product',project),git=require('../lib/git');
  fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nphases: []\nfolders:\n  本体: ${body}\n---\n`);
  const sh=(...args)=>execFileSync('git',['-C',body,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
  fs.writeFileSync(path.join(body,'base.txt'),'base');sh('init','-q','-b','main');sh('add','.');sh('commit','-qm','base');
  const store=new Store(root),parent=store.createTask(project,{title:'本作業',steps:['準備']}),child=store.createTask(project,{title:'子',parent:parent.id,steps:['完成']});
  store.setStep(project,parent.id,0,true);store.setStep(project,child.id,0,true);
  const workRoot=path.join(root,'Work',project),copy=git.prepare({base:body,workRoot,taskId:child.id});store.updateTask(project,child.id,{workdir:copy.dir});
  fs.writeFileSync(path.join(copy.dir,'result.txt'),'child');git.save(copy.dir,'child');const head=sh('rev-parse','HEAD');
  const input={project,task:parent.id,only:[{project,task:child.id,expectTitle:'子'}]};
  for(const mode of ['steps','pending','continue']){
    if(mode==='pending')store.updateTask(project,parent.id,{state:'完了'});
    if(mode==='continue'){const r=await post('/api/task/completion',{project,task:parent.id,action:'continue',confirm:true,expectedHash:store.readTask(store.taskFile(project,parent.id)).completionHash});assert.equal(r.status,200);}
    let r=await post('/api/task/integrate/preview',input);assert.equal(r.status,200);const d=await r.json();assert.equal(d.items[0].task,child.id);assert.deepEqual(d.items[0].blockers,[]);
    r=await post('/api/task/merge',{project,task:child.id});assert.equal(r.status,409);assert.match((await r.json()).error,/親作業の［統合…］/);
    assert.equal(sh('rev-parse','HEAD'),head);assert.ok(fs.existsSync(copy.dir));
  }
  const approved=await post('/api/task/completion',{project,task:parent.id,action:'approve',confirm:true,expectedHash:store.readTask(store.taskFile(project,parent.id)).completionHash});assert.equal(approved.status,200);
  let r=await post('/api/task/integrate/preview',input);assert.equal(r.status,409);assert.match((await r.json()).error,/親は完了済み/);
  r=await post('/api/task/merge',{project,task:child.id});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
  assert.equal(fs.readFileSync(path.join(body,'result.txt'),'utf8'),'child');assert.equal(fs.existsSync(copy.dir),false);
});
test('大量の保存待ちがある親の統合確認と受領で、本体・ステージ・変更検出を保持する',async()=>{
  const project='Large pending files',body=path.join(root,'System',project),dir=path.join(root,'Product',project);
  fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nphases: []\nfolders:\n  本体: ${body}\n---\n`);
  const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),child=store.createTask(project,{title:'確認',parent:parent.id,steps:['完成']});store.setStep(project,child.id,0,true);
  const sh=(...args)=>execFileSync('git',['-C',body,...args],{encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}});
  fs.writeFileSync(path.join(body,'base.txt'),'base');sh('init','-q','-b','main');sh('add','.');sh('commit','-qm','base');
  const head=sh('rev-parse','HEAD'),folder='records-'+'x'.repeat(220),pending=path.join(body,folder),count=4600;
  fs.mkdirSync(pending);for(let i=0;i<count;i++)fs.writeFileSync(path.join(pending,`file-${String(i).padStart(5,'0')}.txt`),`pending ${i}\n`);
  sh('add','--',folder);
  const staged=sh('diff','--cached','--binary'),status=sh('status','--porcelain');assert.ok(Buffer.byteLength(status)>1024*1024);
  const report=path.join(dir,'作業',child.id,'report.txt');fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'checked result');
  let r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);let d=await r.json();
  assert.equal(d.items.length,1);assert.deepEqual(d.items[0].blockers,[]);assert.equal(d.targetSnapshot.status,status.trim());
  assert.equal(sh('rev-parse','HEAD'),head);assert.equal(sh('diff','--cached','--binary'),staged);
  const first=path.join(pending,'file-00000.txt');fs.writeFileSync(first,'unreviewed change\n');sh('add','--',first);
  assert.equal(sh('status','--porcelain'),status);
  const select=x=>x.items.map(i=>({project,task:i.task,files:i.selected,optional:[]}));
  r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,selected:select(d),confirm:true});assert.equal(r.status,409);assert.match((await r.json()).error,/統合先が変わりました/);
  assert.ok(store.taskFile(project,child.id));assert.equal(sh('rev-parse','HEAD'),head);
  fs.writeFileSync(first,'pending 0\n');sh('add','--',first);assert.equal(sh('diff','--cached','--binary'),staged);
  r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);d=await r.json();
  r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,selected:select(d),confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).complete,true);
  assert.equal(store.taskFile(project,child.id),null);assert.equal(sh('rev-parse','HEAD'),head);assert.equal(sh('diff','--cached','--binary'),staged);assert.equal(sh('status','--porcelain'),status);
  for(let i=0;i<count;i++)assert.equal(fs.readFileSync(path.join(pending,`file-${String(i).padStart(5,'0')}.txt`),'utf8'),`pending ${i}\n`);
  assert.equal(fs.readFileSync(report,'utf8'),'checked result');assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,1);
  const receipts=fs.readdirSync(path.join(root,'_hub/task-handoffs')).map(n=>JSON.parse(fs.readFileSync(path.join(root,'_hub/task-handoffs',n),'utf8'))),receipt=receipts.find(x=>x.project===project);
  assert.ok(receipt.complete);assert.equal(fs.readFileSync(receipt.files[0].to,'utf8'),'checked result');
});
test('過去の大きい成果を含めず、明示した成果だけをHTTPで渡し親が受領する',async()=>{
  const project='Explicit files',body=path.join(root,'System',project),dir=path.join(root,'Product',project);
  fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nphases: []\nfolders:\n  本体: ${body}\n---\n`);
  const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),child=store.createTask(project,{title:'確認',parent:parent.id,steps:['完成']});store.setStep(project,child.id,0,true);
  const sh=(...args)=>execFileSync('git',['-C',body,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
  const code=path.join(body,'result.js'),report=path.join(dir,'資料','result.txt'),old=path.join(dir,'成果物','old.zip');
  fs.mkdirSync(path.dirname(report));fs.mkdirSync(path.dirname(old));fs.writeFileSync(code,'current code');fs.writeFileSync(report,'checked result');fs.writeFileSync(old,'');fs.truncateSync(old,65*1024*1024);
  sh('init','-q','-b','main');sh('add','result.js');sh('commit','-qm','result');const head=sh('rev-parse','HEAD');
  const input={project,task:child.id,expectTitle:child.title};
  const own=path.join(dir,'作業',child.id,'own.txt');fs.mkdirSync(path.dirname(own),{recursive:true});fs.writeFileSync(own,'own result');
  let r=await post('/api/task/handup/preview',input);assert.equal(r.status,200);const bounded=await r.json();assert.deepEqual(bounded.skipped,{count:0,bytes:0});assert.equal(bounded.candidateError,null);assert.deepEqual(bounded.files.map(x=>x.path),[own]);assert.deepEqual(bounded.blockers,[]);
  r=await post('/api/task/handup',{...input,token:bounded.token,selected:['project:成果物/old.zip'],confirm:true});assert.equal(r.status,409);assert.match((await r.json()).error,/選び直して/);assert.equal(chat.read(dir,parent.id).length,0);
  r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);const auto=await r.json();assert.deepEqual(auto.items[0].blockers,[]);assert.deepEqual(auto.items[0].files.map(x=>x.path),[own]);assert.equal(auto.items[0].skipped.count,0);
  r=await post('/api/task/handup/preview',{...input,paths:['body:result.js','資料/result.txt']});assert.equal(r.status,200);const offer=await r.json();
  assert.deepEqual(offer.blockers,[]);assert.deepEqual(offer.selected,['body:result.js','project:資料/result.txt']);
  r=await post('/api/task/handup',{...input,token:offer.token,selected:offer.selected,confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).handedUp,true);
  assert.ok(store.taskFile(project,child.id));assert.equal(chat.read(dir,parent.id).filter(x=>x.offer).length,1);
  r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);const d=await r.json();
  assert.equal(d.items.length,1);const item=d.items[0];assert.deepEqual(item.blockers,[]);assert.deepEqual(item.files.map(x=>x.id),offer.selected);
  r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,selected:[{project,task:child.id,files:item.selected,optional:[]}],confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).complete,true);
  const receipt=JSON.parse(fs.readFileSync(fs.readdirSync(path.join(root,'_hub/task-handoffs')).map(x=>path.join(root,'_hub/task-handoffs',x)).find(f=>JSON.parse(fs.readFileSync(f)).project===project),'utf8'));
  assert.deepEqual(receipt.files.map(x=>fs.readFileSync(x.to,'utf8')),['current code','checked result']);
  assert.equal(store.taskFile(project,child.id),null);assert.equal(sh('rev-parse','HEAD'),head);assert.equal(fs.readFileSync(code,'utf8'),'current code');assert.equal(fs.readFileSync(report,'utf8'),'checked result');assert.equal(fs.statSync(old).size,65*1024*1024);
  assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,1);
});
for (const location of ['recent','older-than-500','rotated']) for (const handedUp of [false,true]) test('旧成功ログの証跡を祖先統合で受領し、旧ログと本体を保持（'+location+'／成果を渡す：'+handedUp+'）',async()=>{
  const project='Project Hub '+location+' '+(handedUp?'offered':'auto');
  const body=path.join(root,'System',project),dir=path.join(root,'Product',project);fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nphases: []\nfolders:\n  本体: ${body}\n---\n`);
  const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),child=store.createTask(project,{title:'固定機能',parent:parent.id,steps:['完成']});store.setStep(project,child.id,0,true);
  const date='2026-10-06T10:09:35Z',sh=(...args)=>execFileSync('git',['-C',body,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost',GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}}).trim();
  sh('init','-q','-b','main');fs.writeFileSync(path.join(body,'base.txt'),'base');sh('add','.');sh('commit','-qm','base');
  sh('checkout','-qb','child');fs.writeFileSync(path.join(body,'result.txt'),'fixture result');sh('add','.');sh('commit','-qm','result');sh('checkout','-q','main');sh('merge','--no-ff','-qm',`取り込み: ${child.id} ${child.title}`,'child');
  const commit=sh('rev-parse','HEAD'),log=path.join(root,'_hub/log.jsonl');
  const oldLine=JSON.stringify({at:'2026-10-06T10:09:35.295Z',action:'merge',project:project,task:child.id,ok:true,conflict:false})+'\n';
  const noise=Array.from({length:600},()=>JSON.stringify({action:'read',project,task:parent.id})).join('\n')+'\n';
  const receiptLog=location==='rotated'?log.replace(/\.jsonl$/,'.old.jsonl'):log;
  fs.rmSync(log.replace(/\.jsonl$/,'.old.jsonl'),{force:true});
  fs.writeFileSync(log,location==='rotated'?noise:oldLine+(location==='recent'?'':noise));
  if(location==='rotated')fs.writeFileSync(receiptLog,oldLine+noise);
  const input={project:project,task:child.id,expectTitle:child.title};
  let r;
  if(handedUp){
    r=await post('/api/task/handup/preview',input);assert.equal(r.status,200);const offer=await r.json();
    assert.deepEqual(offer.blockers,[]);assert.deepEqual(offer.files,[]);assert.equal(offer.hasCode,true);
    r=await post('/api/task/handup',{...input,token:offer.token,selected:[],confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).handedUp,true);
    assert.ok(store.taskFile(project,child.id));assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,0);assert.equal(sh('rev-parse','HEAD'),commit);
  }
  r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);const d=await r.json();
  assert.equal(d.items.length,1);const item=d.items[0];assert.deepEqual(item.blockers,[]);assert.deepEqual(item.files,[]);assert.equal(item.handedUp,handedUp);
  assert.equal(item.integrated.commit,commit);assert.equal(item.integrated.recovered,true);assert.deepEqual(item.integrated.files,['result.txt']);
  r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,selected:[{project,task:child.id,files:[],optional:[]}],confirm:true});assert.equal(r.status,200);assert.equal((await r.json()).complete,true);
  const rows=chat.read(dir,parent.id).filter(x=>x.handoff);assert.equal(rows.length,1);const row=rows[0];assert.ok(row.integrating);assert.match(row.text,/古い取り込み記録を本体の履歴と照合/);assert.match(row.text,/result.txt/);assert.match(row.text,/統合先/);
  assert.match(fs.readFileSync(store.taskFile(project,parent.id),'utf8'),/古い取り込み記録を本体の履歴と照合/);
  assert.equal(store.taskFile(project,child.id),null);assert.equal(fs.readFileSync(path.join(body,'result.txt'),'utf8'),'fixture result');assert.equal(sh('rev-parse','HEAD'),commit);
  assert.ok(fs.readFileSync(receiptLog,'utf8').startsWith(oldLine));assert.equal(fs.readFileSync(receiptLog,'utf8').split(oldLine).length,2);
  r=await post('/api/task/handup/preview',input);assert.equal(r.status,409);assert.match((await r.json()).error,/もう受け取って/);
});
for(const applyParent of [false,true])test('HTTPで旧衝突→親コピー→本体適用の後も復旧確認し、コード再mergeせず正式受領する：'+applyParent,async()=>{
 const project='Recovery route '+applyParent,body=path.join(root,'System',project),dir=path.join(root,'Product',project),git=require('../lib/git');
 fs.mkdirSync(body,{recursive:true});fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nfolders:\n  本体: ${body}\n---\n`);
 const sh=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}}).trim();
 fs.writeFileSync(path.join(body,'base.txt'),'base\n');sh(body,'init','-q','-b','main');sh(body,'add','.');sh(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask(project,{title:'本作業'}),children=[];
 for(const title of ['A','B']){const c=store.createTask(project,{title,parent:parent.id,steps:['完成']});store.setStep(project,c.id,0,true);const w=git.prepare({base:body,workRoot:path.join(root,'Work',project),taskId:c.id});store.updateTask(project,c.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'base.txt'),title+'\n');git.save(w.dir,title);children.push({...c,workdir:w.dir});}
 let r=await post('/api/task/integrate/preview',{project,task:parent.id}),d=await r.json();assert.equal(r.status,200);
 r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({project,task:i.task,files:i.selected,optional:[]}))});assert.equal(r.status,200);const partial=await r.json();assert.equal(partial.conflict,true);assert.equal(partial.partial,true);assert.equal(store.taskFile(project,children[0].id),null);
 const copy=git.prepare({base:body,workRoot:path.join(root,'Work',project),taskId:parent.id});store.updateTask(project,parent.id,{workdir:copy.dir});
 assert.throws(()=>sh(copy.dir,'merge','--no-ff','--no-edit',git.inspect(children[1].workdir).branch));fs.writeFileSync(path.join(copy.dir,'base.txt'),'A and B\n');sh(copy.dir,'add','.');sh(copy.dir,'commit','-qm','resolved');
 store.updateTask(project,parent.id,{state:'実行中',question:''});fs.appendFileSync(store.taskFile(project,children[1].id),'\n中断後の確認記録\n');
 if(applyParent){r=await post('/api/task/merge',{project,task:parent.id});assert.equal(r.status,200);assert.equal(store.readTask(store.taskFile(project,parent.id)).workdir,'');}
 const target=applyParent?body:copy.dir,head=git.inspect(target).head;
 r=await post('/api/task/integrate/preview',{project,task:parent.id});assert.equal(r.status,200);d=await r.json();assert.ok(d.recover);assert.deepEqual(d.blockers,[]);assert.equal(d.items[0].retained,true);assert.equal(d.items[1].recordChanged,true);assert.equal(d.items[1].codeAlready,true);
 r=await post('/api/task/integrate',{project,task:parent.id,token:d.token,confirm:true});assert.equal(r.status,409);assert.match((await r.json()).error,/復旧内容/);
 const request={project,task:parent.id,token:d.token,confirm:true,recover:true};r=await post('/api/task/integrate',request);assert.equal(r.status,200);assert.equal((await r.json()).complete,true);
 r=await post('/api/task/integrate',request);assert.equal(r.status,200);assert.equal((await r.json()).duplicate,true);assert.equal(git.inspect(target).head,head);assert.equal(store.taskFile(project,children[1].id),null);assert.equal(chat.read(dir,parent.id).filter(x=>x.handoff).length,2);
});
