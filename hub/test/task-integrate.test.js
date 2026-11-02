'use strict';
// Keep the existing server-wrapper fixtures bound to the extracted execution checks.
function parallelFixture(ctx){return require('../lib/engines/parallel')({...ctx,getAiTools:()=>ctx.aiTools,getAppUpdate:()=>ctx.appUpdate,getChats:()=>ctx.chats,getConversationHistory:()=>ctx.conversationHistory,getFreetalkHistory:()=>ctx.freetalkHistory,getGithub:()=>ctx.github,getGithubProject:()=>ctx.githubProject,getGpt:()=>ctx.gpt,getIdeaRunner:()=>ctx.ideaRunner,getMaintenance:()=>ctx.maintenance,getProcwatch:()=>ctx.procwatch,getRemoval:()=>ctx.removal,getRemovalReview:()=>ctx.removalReview,getReqCtx:()=>ctx.reqCtx,getRestartControl:()=>ctx.restartControl,getSessions:()=>ctx.sessions,getTaskIntegrate:()=>ctx.taskIntegrate,getWebchat:()=>ctx.webchat});}

// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),graph=require('../public/project-order'),git=require('../lib/git'),chat=require('../lib/chat');
const cleanupReview=i=>({disposition:'cleanup',review:{...i.review,confirmed:true,residual:'なし',undecided:'なし'}});
const sh=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const {IntegrateAuto}=require('../lib/integrate-auto');
function fixture(t,opts={}){
 const project=opts.project||'Fixture';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-integrate-'));const oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product',project),body=path.join(root,'Body');
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: '+project+'\n---\n');write(path.join(body,'base.txt'),'base\n');
 sh(body,'init','-q');sh(body,'config','user.email','fixture@localhost');sh(body,'config','user.name',project);sh(body,'add','.');sh(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask(project,{title:'祖先'});
 const removal=new Removal({store,trash:path.join(root,'Trash'),...opts});
 const transfer=new TaskTransfer({store,removal,baseOf:()=>body,...opts});
 const make=()=>new TaskIntegrate({store,transfer,removal,baseOf:()=>body});let integrate=make();
 const child=(title,parentId=parent.id,code=true)=>{
   const c=store.createTask(project,{title,parent:parentId,steps:['完成']});store.setStep(project,c.id,0,true);
   if(code){const w=git.prepare({base:body,workRoot:removal.workRoot({id:project}),taskId:c.id});store.updateTask(project,c.id,{workdir:w.dir});write(path.join(w.dir,title+'.txt'),title+'\n');git.save(w.dir,'child');}
   write(path.join(dir,'作業',c.id,'report.txt'),title+' report');return store.readTask(store.taskFile(project,c.id));
 };
 const preview=only=>integrate.preview(project,parent.id,only);
 const apply=(d,items=d.items)=>integrate.apply({project:project,task:parent.id,token:d.token,confirm:true,legacyConfirmed:true,selected:items.map(i=>({project:i.project,task:i.task,disposition:'cleanup',review:{...i.review,confirmed:true,residual:'なし',undecided:'なし'},files:i.selected,optional:[]}))});
 return {root,dir,body,write,store,parent,removal,transfer,child,preview,apply,get integrate(){return integrate;},restart(){integrate=make();},sh};
}
function emptyMerge(dir){
 const branch=sh(dir,'branch','--show-current');
 sh(dir,'checkout','-qb','unrelated-empty');sh(dir,'commit','--allow-empty','-qm','unrelated');
 sh(dir,'checkout','-q',branch);sh(dir,'merge','--no-ff','--no-commit','unrelated-empty');
 assert.equal(git.merging(dir),true);
}
test('要約開始の旧統合判定：完了した子と現在本体の包含だけ許可し、履歴と再送保護を保持',t=>{
 const f=fixture(t),project='Fixture',task=f.parent.id,head=f.sh(f.body,'rev-parse','HEAD');
 const record={id:require('node:crypto').randomUUID(),project,task,complete:true,items:[{state:'受領済み'},{state:'片付け済み'}],auto:{thenMain:false,main:{state:'done',skipped:true},pendingMain:{id:require('node:crypto').randomUUID(),main:{state:'intent',sourceHead:head},stopped:{reason:'old failure'}}}};
 f.integrate.save(record);const before=fs.readFileSync(f.integrate.file(project,task));
 const index=f.sh(f.body,'rev-parse','--path-format=absolute','--git-path','index'),indexBefore=fs.readFileSync(index);
 assert.equal(f.integrate.historyBlocker(project,task),'');
 assert.equal(f.integrate.pending()[0].mainPending.main.state,'intent','eligibility never settles/replays the intent');
 assert.deepEqual(fs.readFileSync(f.integrate.file(project,task)),before);assert.deepEqual(fs.readFileSync(index),indexBefore);
 let inspections=0;const native=f.integrate.gitw;f.integrate.gitw={...native,inspect:(...a)=>{inspections++;return native.inspect(...a);}};
 f.integrate.pending();assert.equal(inspections,0,'the polling path does not inspect Git');
 for(const mutate of [r=>r.complete=false,r=>r.items[0].state='確認待ち',r=>r.auto.main.state='intent',r=>r.auto.thenMain=true,r=>r.auto.pendingMain.id=r.id,r=>r.auto.pendingMain.main.state='unknown',r=>r.abandoned={reason:'stopped-organize'},r=>r.id=null,r=>r.project='other',r=>r.task='other']){
  const r=structuredClone(record);mutate(r);fs.writeFileSync(f.integrate.file(project,task),JSON.stringify(r));
  assert.ok(f.integrate.historyBlocker(project,task));
 }assert.equal(inspections,0,'true pending/mismatched scope never uses historical Git evidence');
 f.integrate.save(record);
 for(const failing of [{inspect:()=>{throw Error('status unavailable');}},{merging:()=>true},{inspect:(...a)=>({...native.inspect(...a),status:'UU base.txt\n'})},{isAncestor:()=>false},{isAncestor:()=>{throw Error('missing commit');}}]){
  f.integrate.gitw={...native,...failing};assert.match(f.integrate.historyBlocker(project,task),/確認できません/);
 }f.integrate.gitw=native;
 const r=structuredClone(record);r.auto.pendingMain.main.sourceHead='missing';f.integrate.save(r);assert.ok(f.integrate.historyBlocker(project,task));f.integrate.save(record);
 f.sh(f.body,'checkout','--orphan','unrelated-main');f.sh(f.body,'commit','-qm','same tree, different history');
 assert.ok(f.integrate.historyBlocker(project,task),'same content and clean status do not prove inclusion');
 f.sh(f.body,'checkout','-q','--detach',head);assert.equal(f.integrate.historyBlocker(project,task),'','a new check reads the current main without cached permission');
 assert.equal(f.integrate.historyBlocker(project,'other-task'),'');assert.deepEqual(fs.readFileSync(f.integrate.file(project,task)),before);
});
test('要約開始の記録破損拒否：不存在とnull・配列・欠損・不正JSONを区別する',t=>{
 const f=fixture(t),project='Fixture',task=f.parent.id,file=f.integrate.file(project,task);
 assert.equal(f.integrate.historyBlocker(project,task),'');fs.mkdirSync(path.dirname(file),{recursive:true});
 const native=f.integrate.gitw;f.integrate.gitw={...native,inspect:()=>assert.fail('malformed records cannot use Git evidence')};
 for(const raw of ['null','[]','{}','{',JSON.stringify({project,task,complete:false,items:[]})]){
  fs.writeFileSync(file,raw);assert.ok(f.integrate.historyBlocker(project,task));assert.equal(fs.readFileSync(file,'utf8'),raw);
 }
});
test('古い本体intentの表示証拠はclean本体の祖先だけ、ゼロ差分・dirty・不明は未確認、原物と再送禁止を保持',t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});
 f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 f.sh(w.dir,'commit','--allow-empty','-qm','saved source with zero diff');const source=git.inspect(w.dir).head;
 const old={id:'old',project:'Fixture',task:f.parent.id,complete:true,items:[],auto:{thenMain:true,main:{state:'intent',sourceHead:source},stopped:{reason:'old failure'}}};f.integrate.save(old);
 const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8');
 assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).reflected,false,'equal trees cannot prove old source was applied');
 f.sh(f.body,'merge','--no-ff','--no-edit',source);
 const tracked=path.join(f.body,'base.txt'),stat=fs.statSync(tracked);fs.utimesSync(tracked,stat.atime, new Date(stat.mtimeMs+2000));
 const index=f.sh(f.body,'rev-parse','--path-format=absolute','--git-path','index'),indexBefore=fs.readFileSync(index);
 const proof=f.integrate.mainDisplay('Fixture',f.parent.id);assert.equal(proof.reflected,true);assert.equal(proof.mainHead,f.sh(f.body,'rev-parse','HEAD'));assert.deepEqual(fs.readFileSync(index),indexBefore,'display does not refresh the main index');
 assert.equal(f.integrate.preview('Fixture',f.parent.id,undefined,{simple:true}).mainDisplay.reflected,true);
 f.write(path.join(f.body,'base.txt'),'later body');git.save(f.body,'later saved version');assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).reflected,true,'later main versions retain the historical source');
 f.write(path.join(f.body,'unsaved'),'dirty');{const d=f.integrate.mainDisplay('Fixture',f.parent.id);assert.equal(d.reflected,true,'an unrelated uncommitted file does not undo the saved history');assert.equal(d.mainUncommitted,1);}fs.unlinkSync(path.join(f.body,'unsaved'));
 {const native=f.integrate.gitw;f.integrate.gitw={...native,inspect:(dir,o)=>({...native.inspect(dir,o),status:'UU base.txt\n'})};assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).reflected,false,'an unresolved conflict stays unconfirmed');f.integrate.gitw=native;}
 assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).mainUncommitted,undefined,'a clean main has no separate unsaved notice');
 for(const sourceHead of [undefined,'invalid','f'.repeat(40)])assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id,{...old,auto:{...old.auto,main:{state:'intent',sourceHead}}}).reflected,false);
 emptyMerge(f.body);assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).reflected,false);f.sh(f.body,'merge','--abort');
 const native=f.integrate.gitw;f.integrate.gitw={...native,isAncestor:()=>{throw Error('fixture unavailable');}};assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id).reflected,false);f.integrate.gitw=native;
 assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);assert.equal(f.integrate.pending()[0].mainPending.main.state,'intent');
 const read=f.integrate.read;f.integrate.read=()=>{throw Error('fixture malformed history');};assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id),null);f.integrate.read=read;
 let requests=0;const auto=new IntegrateAuto({integrate:f.integrate,busy:()=>false,dispatch:()=>requests++,mergeMain:()=>requests++});assert.equal(auto.resumeStatus(old).allowed,false);assert.equal(requests,0);
});
test('本体status取得失敗はpreviewのclean相当値で迂回できず、表示検査は読取限定',t=>{
 const f=fixture(t),source=f.sh(f.body,'rev-parse','HEAD');
 const old={auto:{pendingMain:{id:'old',main:{state:'intent',sourceHead:source}}}},before=JSON.stringify(old),native=f.integrate.gitw;
 const calls=[];let fail=true;
 f.integrate.gitw={...native,inspect:(dir,options)=>{calls.push({dir,options});if(fail){const e=Error('status unavailable');e.status=128;throw e;}return native.inspect(dir,options);}};
 const snapshot={head:source,status:''};
 assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id,old,snapshot).reflected,false,'a boolean preview is not a successful status acquisition');
 assert.deepEqual(calls,[{dir:f.body,options:{readOnly:true}}]);
 fail=false;assert.equal(f.integrate.mainDisplay('Fixture',f.parent.id,old,snapshot).reflected,true);
 f.write(path.join(f.body,'uncommitted'),'dirty');{const d=f.integrate.mainDisplay('Fixture',f.parent.id,old,snapshot);assert.equal(d.reflected,true);assert.equal(d.mainUncommitted,1);}
 assert.equal(JSON.stringify(old),before);
});
test('正式再開：停止履歴を保持しthenMain:false、受領済み・検証済みattemptを繰り返さない',async t=>{
 const f=fixture(t);f.child('完了子');const d=f.preview();
 f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,selected:d.items.map(i=>({project:i.project,task:i.task,disposition:'continue'}))});
 const auto=new IntegrateAuto({integrate:f.integrate,busy:()=>false,dispatch:async()=>assert.fail('再委任禁止'),mergeMain:async()=>assert.fail('本体反映禁止')});
 const r=f.integrate.read('Fixture',f.parent.id),k='a'.repeat(64);r.auto.attempts[k]={phase:'verified',reviewHead:r.auto.targetHead};f.integrate.save(r);
 auto.stop('Fixture',f.parent.id,'人停止');const old=f.integrate.read('Fixture',f.parent.id),receipt=f.transfer.read('Fixture',r.items[0].task),rows=chat.read(f.dir,f.parent.id);
 const preview=f.preview(),out=auto.resume({project:'Fixture',task:f.parent.id,token:preview.token});assert.equal(out.thenMain,false);
 let resumed=f.integrate.read('Fixture',f.parent.id);assert.deepEqual(resumed.auto.stopHistory,[old.auto.stopped]);assert.equal(resumed.auto.resumed[0].head,r.auto.targetHead);assert.equal(resumed.auto.resumed[0].previousThenMain,true);assert.deepEqual(resumed.auto.attempts[k],r.auto.attempts[k]);
 await auto.tick();assert.equal(f.integrate.read('Fixture',f.parent.id).auto.main.skipped,true);assert.deepEqual(f.transfer.read('Fixture',r.items[0].task),receipt);assert.deepEqual(chat.read(f.dir,f.parent.id),rows);
 assert.throws(()=>auto.resume({project:'Fixture',task:f.parent.id,token:preview.token}));
});
for(const mode of ['token','dirty','source','scope','main-intent','busy','archive-history'])test('正式再開の前提変更は記録を変えず拒否：'+mode,t=>{
 const f=fixture(t);const c=f.child('子'),d=f.preview();f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,selected:d.items.map(i=>({project:i.project,task:i.task,disposition:'continue'}))});
 const auto=new IntegrateAuto({integrate:f.integrate,busy:()=>mode==='busy',dispatch:async()=>{},mergeMain:async()=>{}});auto.stop('Fixture',f.parent.id);const p=f.preview();
 if(mode==='dirty')f.write(path.join(f.body,'unsaved'),'dirty');
 if(mode==='source'){const r=f.integrate.read('Fixture',f.parent.id);r.items[0].source.head='b'.repeat(40);f.integrate.save(r);}
 if(mode==='scope'){const r=f.integrate.read('Fixture',f.parent.id);r.auto.scope[0].files.push({id:'hidden'});f.integrate.save(r);}
 if(mode==='main-intent'){const r=f.integrate.read('Fixture',f.parent.id);r.auto.main={state:'intent'};f.integrate.save(r);}
 if(mode==='archive-history'){const r=f.integrate.read('Fixture',f.parent.id);r.auto.targetHead='b'.repeat(40);f.integrate.save(r);}
 const before=f.integrate.read('Fixture',f.parent.id);assert.throws(()=>auto.resume({project:'Fixture',task:f.parent.id,token:mode==='token'?'bad':p.token}));assert.deepEqual(f.integrate.read('Fixture',f.parent.id),before);
});
function mergeState(dir){
 return {snapshot:git.inspect(dir),mergeHead:sh(dir,'rev-parse','MERGE_HEAD'),index:fs.readFileSync(sh(dir,'rev-parse','--path-format=absolute','--git-path','index')).toString('base64')};
}
for(const target of ['body','copy'])for(const mode of ['code','files','no-op'])test('R3 確認前後の別mergeを保存・予約・受領前に拒否して保持：'+target+'/'+mode,t=>{
 const f=fixture(t);
 if(target==='copy'){const w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});}
 const c=f.child('子',f.parent.id,mode!=='files'),dir=target==='body'?f.body:f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).workdir;
 if(mode==='no-op')sh(dir,'merge','--no-ff','--no-edit',git.inspect(c.workdir).branch);
 if(mode==='files'){const offer=f.transfer.offerPreview('Fixture',c.id);f.transfer.offer({project:'Fixture',task:c.id,token:offer.token,selected:offer.selected,confirm:true});}
 const d=f.preview(),taskFile=f.store.taskFile('Fixture',c.id),task=fs.readFileSync(taskFile,'utf8'),receipt=f.transfer.read('Fixture',c.id),messages=chat.read(f.dir,f.parent.id),source=c.workdir&&git.inspect(c.workdir);
 const report=path.join(f.dir,'作業',c.id,'report.txt'),reportText=fs.readFileSync(report,'utf8');
 emptyMerge(dir);assert.deepEqual(git.inspect(dir),d.targetSnapshot);const before=mergeState(dir);
 assert.throws(()=>f.preview(),/統合先で取り込みが途中/);
 assert.throws(()=>f.apply(d),/統合先で取り込みが途中/);
 assert.deepEqual(mergeState(dir),before);assert.equal(fs.readFileSync(taskFile,'utf8'),task);
 assert.deepEqual(f.transfer.read('Fixture',c.id),receipt);assert.equal(f.integrate.read('Fixture',f.parent.id),null);
 assert.deepEqual(chat.read(f.dir,f.parent.id),messages);assert.equal(fs.readFileSync(report,'utf8'),reportText);
 if(c.workdir)assert.deepEqual(git.inspect(c.workdir),source);
 assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);
 // 元mergeの解消は人の操作に相当。拒否後の正常な統合/no-opも一度だけ完了する。
 sh(dir,'merge','--abort');assert.equal(f.apply(f.preview()).complete,true);
 assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
 if(mode==='no-op')assert.equal(f.integrate.read('Fixture',f.parent.id).items[0].integrated.already,true);
});
for(const mode of ['code','no-op'])test('R3 共通merge直接呼出しでも既存mergeと子を保持：'+mode,t=>{
 const f=fixture(t),c=f.child('子');
 if(mode==='no-op')sh(f.body,'merge','--no-ff','--no-edit',git.inspect(c.workdir).branch);
 emptyMerge(f.body);if(mode==='code')f.write(path.join(c.workdir,'unsaved.txt'),'unsaved');
 const before=mergeState(f.body),source=git.inspect(c.workdir);
 const out=git.merge({dir:c.workdir,workRoot:f.removal.workRoot({id:'Fixture'}),target:f.body,title:'子'});
 assert.equal(out.ok,false);assert.match(out.error,/統合先で取り込みが途中/);assert.equal(out.conflict,undefined);
 assert.deepEqual(mergeState(f.body),before);assert.deepEqual(git.inspect(c.workdir),source);assert.ok(f.store.taskFile('Fixture',c.id));
 assert.equal(f.transfer.read('Fixture',c.id),null);assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);
});
test('祖先判定は親・祖父・派生、未完中間親保護、全員完了と循環を共通に判定',()=>{
 const a={id:'a',state:'実行中'},b={id:'b',parent:'a',state:'完了'},c={id:'c',parent:'b',state:'完了'},p={id:'p',tasks:[a,b,c]};
 assert.deepEqual(graph.integrators(p,c).map(x=>x.task.id),['b','a']);
 b.state='実行中';assert.deepEqual(graph.integrators(p,c).map(x=>x.task.id),['b']);
 b.state='完了';a.state='完了';assert.deepEqual(graph.integrators(p,c),[]);
 a.state='実行中';const q={id:'q',tasks:[{id:'d',kind:'derived',derivedFrom:'p/b'}]};assert.deepEqual(graph.integrators(q,q.tasks[0],[p,q]).map(x=>x.task.id),['b','a']);
 a.parent='c';assert.deepEqual(graph.ancestorsOf(p,c),[]);
});
for(const mode of ['手順全済','完了確認待ち','まだ続ける'])test('未承認の親でも統合候補と引渡し先に残る：'+mode,t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false);
 f.store.updateTask('Fixture',f.parent.id,{state:'実行中'});f.store.addStep('Fixture',f.parent.id,'親の準備');f.store.setStep('Fixture',f.parent.id,0,true);
 if(mode==='完了確認待ち')f.store.updateTask('Fixture',f.parent.id,{state:'完了'});
 let p=f.store.readTask(f.store.taskFile('Fixture',f.parent.id));
 if(mode==='まだ続ける')p=f.store.decideTask('Fixture',p.id,'continue',p.completionHash);
 assert.equal(p.completionPending,mode!=='まだ続ける');assert.equal(graph.approved(p),false);
 const all=f.store.listProjects(),project=all[0];assert.equal(graph.canIntegrate({project,task:p},project,c,all),true);
 const d=f.preview([{project:'Fixture',task:c.id,expectTitle:c.title}]);assert.equal(d.items[0].task,c.id);assert.deepEqual(d.items[0].blockers,[]);
 assert.equal(f.transfer.offerPreview('Fixture',c.id).targetTask,p.id);
 assert.equal(f.apply(d).complete,true);
});
test('拒否理由は祖先関係・未承認中間親・承認済み親・子の手順と質問を共通に返す',t=>{
 const f=fixture(t),mid=f.child('中間',f.parent.id,false),leaf=f.child('下',mid.id,false),stranger=f.store.createTask('Fixture',{title:'別作業'});
 const only=task=>[{project:'Fixture',task,expectTitle:f.store.readTask(f.store.taskFile('Fixture',task)).title}];
 // Supply the in-flight reservation only for context checks; a saved unfinished
 // record would switch preview into resume mode and test a different contract.
 const context=task=>{f.integrate.active={id:'test',project:'Fixture',task:f.parent.id,items:[]};try{return f.transfer.context('Fixture',task,{targetProject:'Fixture',targetTask:f.parent.id,integrating:'test'});}finally{delete f.integrate.active;}};
 assert.throws(()=>f.preview(only(leaf.id)),/未完の中間親「中間」/);
 assert.throws(()=>context(leaf.id),/未完の中間親「中間」/);
 assert.equal(f.integrate.preview('Fixture',mid.id,only(leaf.id)).items[0].task,leaf.id);
 assert.throws(()=>f.preview(only(stranger.id)),/祖先ではありません/);
 f.store.setStep('Fixture',mid.id,0,false);assert.match(f.preview(only(mid.id)).items[0].cleanupBlockers.join(' '),/手順・質問が残って/);
 f.store.setStep('Fixture',mid.id,0,true);f.store.updateTask('Fixture',mid.id,{question:'回答待ち'});
 const d=f.preview(only(mid.id));assert.ok(d.items[0].cleanupBlockers.some(x=>x.includes('手順・質問')));
 assert.throws(()=>context(mid.id),/手順・質問が残って/);
 f.store.decideTask('Fixture',f.parent.id,'approve',f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).completionHash);
 const p=f.store.listProjects()[0];assert.deepEqual(graph.integrators(p,p.tasks.find(x=>x.id===mid.id)),[]);
 assert.throws(()=>f.preview(only(mid.id)),/親は完了済み.*本体に取り込む/);
});
test('確認後の親の承認状態変更を受領前に拒否し、hashの再確認も保持する',t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false),d=f.preview(),before=sh(f.body,'rev-parse','HEAD');
 const list=f.store.listProjects.bind(f.store);
 f.store.listProjects=()=>{const all=list();Object.assign(all[0].tasks.find(x=>x.id===f.parent.id),{state:'完了',completionPending:false});return all;};
 assert.throws(()=>f.apply(d),/確認中に子作業・祖先の関係が変わりました/);
 assert.equal(f.transfer.read('Fixture',c.id),null);assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.ok(f.store.taskFile('Fixture',c.id));
 f.store.listProjects=list;f.store.decideTask('Fixture',f.parent.id,'approve',f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).completionHash);
 assert.throws(()=>f.apply(d),/確認中に親作業・統合先が変わりました/);
});
test('成果を渡すだけではコピー・会話・記録を残し、通知は一度、未引渡しも祖先が拾う',t=>{
 const f=fixture(t),c=f.child('子');chat.append(f.dir,c.id,{role:'assistant',text:'child history'});
 const d=f.transfer.offerPreview('Fixture',c.id);assert.deepEqual(d.blockers,[]);
 const b={project:'Fixture',task:c.id,token:d.token,confirm:true,selected:d.selected};const first=f.transfer.offer(b);
 const once=fs.readFileSync(f.transfer.file('Fixture',c.id),'utf8');assert.deepEqual(f.transfer.offer(b),first,'a repeated submit returns the first result');assert.equal(fs.readFileSync(f.transfer.file('Fixture',c.id),'utf8'),once,'the repeat writes nothing');
 assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(chat.read(f.dir,c.id).length,1);assert.equal(chat.read(f.dir,f.parent.id).length,1);assert.deepEqual(f.transfer.pending(),[]);
 const c2=f.child('未引渡し'),p=f.preview();assert.equal(p.items.find(i=>i.task===c.id).handedUp,true);assert.equal(p.items.find(i=>i.task===c2.id).handedUp,false);
 f.apply(p);assert.equal(fs.readFileSync(path.join(f.body,'子.txt'),'utf8'),'子\n');assert.equal(fs.readFileSync(path.join(f.body,'未引渡し.txt'),'utf8'),'未引渡し\n');assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(f.store.taskFile('Fixture',c2.id),null);
});
test('親のコピーへ統合し本体は不変、専用一時物とrulesもTrash、成果・ログは残る',t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 const before=sh(f.body,'rev-parse','HEAD'),c=f.child('成果');
 f.write(path.join(f.dir,'.ai/chat',c.id+'.rules.md'),'rules');f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'temporary');
 const p=f.preview();assert.equal(p.target,w.dir);const result=f.apply(p);assert.equal(result.complete,true);
 assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.equal(fs.existsSync(path.join(f.body,'成果.txt')),false);assert.equal(fs.readFileSync(path.join(w.dir,'成果.txt'),'utf8'),'成果\n');
 assert.equal(fs.existsSync(c.workdir),false);assert.equal(fs.existsSync(path.join(f.dir,'.ai/work',c.id)),false);assert.equal(fs.existsSync(path.join(f.dir,'.ai/chat',c.id+'.rules.md')),false);
 assert.equal(fs.readFileSync(path.join(f.dir,'作業',c.id,'report.txt'),'utf8'),'成果 report');
 const journal=f.integrate.read('Fixture',f.parent.id),r=f.transfer.read('Fixture',c.id);assert.equal(journal.complete,true);assert.equal(r.complete,true);assert.ok(fs.existsSync(r.destination));assert.ok(fs.existsSync(journal.items[0].copyTrashed));assert.equal(f.removal.restore(r.cleanup,true).ok,true);
 assert.equal(fs.readFileSync(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'utf8'),'temporary');
});
test('2子の2件目衝突は祖先に質問、先行子確定・後続保持、AI解消後は重複せず再開',t=>{
 const f=fixture(t),a=f.child('A'),b=f.child('B');
 f.write(path.join(a.workdir,'base.txt'),'A\n');git.save(a.workdir,'A change');f.write(path.join(b.workdir,'base.txt'),'B\n');git.save(b.workdir,'B change');
 const p=f.preview(),ordered=[p.items.find(i=>i.task===a.id),p.items.find(i=>i.task===b.id)],out=f.apply(p,ordered);
 assert.equal(out.conflict,true);assert.equal(f.store.taskFile('Fixture',a.id),null);assert.ok(f.store.taskFile('Fixture',b.id));assert.equal(fs.readFileSync(path.join(f.body,'base.txt'),'utf8'),'A\n');
 assert.match(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).question,/B.*ぶつかりました/);assert.equal(f.store.readTask(f.store.taskFile('Fixture',b.id)).question,'');
 assert.throws(()=>sh(f.body,'merge','--no-ff','--no-edit',git.inspect(b.workdir).branch));f.write(path.join(f.body,'base.txt'),'A and B\n');sh(f.body,'add','.');sh(f.body,'commit','-qm','resolved');
 f.store.updateTask('Fixture',f.parent.id,{state:'実行中',question:''});const head=sh(f.body,'rev-parse','HEAD');f.restart();const d=f.preview();assert.equal(d.resume,true);f.apply(d);
 assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.equal(f.store.taskFile('Fixture',b.id),null);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,2);
 assert.equal(f.integrate.pending().length,0);
});
test('受領片付けの途中失敗を再起動後に継続し、別祖先・再通知・二重mergeを拒否',t=>{
 let fail=true;const f=fixture(t,{rename:(a,b)=>{if(fail){fail=false;throw Error('fixture cleanup failure');}fs.renameSync(a,b);}}),c=f.child('子');
 const d=f.preview();assert.throws(()=>f.apply(d),/cleanup failure/);const head=sh(f.body,'rev-parse','HEAD');
 const upper=f.store.createTask('Fixture',{title:'上の祖先'});f.store.updateTask('Fixture',f.parent.id,{parent:upper.id});f.store.decideTask('Fixture',f.parent.id,'approve',f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).completionHash);
 const other=f.integrate.preview('Fixture',upper.id);assert.ok(other.items.find(i=>i.task===c.id).blockers.some(x=>x.includes('別の祖先')));
 f.restart();const resume=f.preview();f.apply(resume);assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('孫→子を強制し未完中間親と未完子孫を保護、成功後に両方片付ける',t=>{
 const f=fixture(t),c=f.child('子'),g=f.child('孫',c.id);f.store.decideTask('Fixture',c.id,'approve',c.completionHash);const d=f.preview();assert.equal(d.items[0].task,g.id);assert.equal(d.items[1].task,c.id);
 assert.throws(()=>f.apply(d,d.items.slice().reverse()),/孫から/);assert.throws(()=>f.apply(d,[d.items[1]]),/孫から/);f.apply(d);assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(f.store.taskFile('Fixture',g.id),null);
 const h=fixture(t),mid=h.child('中間'),leaf=h.child('下',mid.id);h.store.setStep('Fixture',mid.id,0,false);assert.equal(h.preview().items.length,1);assert.equal(h.preview().items[0].task,mid.id);assert.equal(h.integrate.preview('Fixture',mid.id).items[0].task,leaf.id);
 const k=fixture(t),parent=k.child('完了親'),unfinished=k.store.createTask('Fixture',{title:'未完の孫',parent:parent.id});assert.match(k.preview().items.find(i=>i.task===parent.id).cleanupBlockers.join(' '),/未完了/);assert.ok(k.store.taskFile('Fixture',unfinished.id));
});
test('コピー退避直後に停止しても退避先を照合しGit登録整理から再開する',t=>{
 const f=fixture(t),c=f.child('子'),branch=git.inspect(c.workdir).branch;
 f.integrate.gitw={...git,cleanupCopy:args=>git.cleanupCopy({...args,beforeMove:data=>{args.beforeMove(data);fs.renameSync(args.dir,data.trashed);throw Error('fixture stopped after move');}})};
 assert.throws(()=>f.apply(f.preview()),/stopped after move/);
 const journal=f.integrate.read('Fixture',f.parent.id);assert.ok(fs.existsSync(journal.items[0].copyTrashPlanned));assert.ok(sh(f.body,'branch','--list',branch));
 f.restart();f.apply(f.preview());assert.equal(sh(f.body,'branch','--list',branch),'');assert.equal(f.integrate.read('Fixture',f.parent.id).items[0].copyTrashed,journal.items[0].copyTrashPlanned);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('成果改変・確認後のコード変更・順番待ちは保存/merge/削除前に拒否',t=>{
 const f=fixture(t),c=f.child('子'),d=f.preview(),head=sh(f.body,'rev-parse','HEAD');f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');assert.throws(()=>f.apply(d),/成果ファイル/);assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.ok(f.store.taskFile('Fixture',c.id));
 const g=fixture(t),x=g.child('子'),p=g.preview();g.write(path.join(x.workdir,'late.txt'),'late');assert.throws(()=>g.apply(p),/子の変更/);
 const h=fixture(t),q=h.child('子');h.write(path.join(h.dir,'.ai/chat',q.id+'.queue.json'),'[{}]');assert.ok(h.preview().items[0].blockers.some(x=>x.includes('順番待ち')));
});
test('共有から参照された専用一時物は残し、任意選択の専用フォルダだけTrash',t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false),other=f.store.createTask('Fixture',{title:'参照元'}),temp=f.write(path.join(f.dir,'.ai/work',c.id,'memo.txt'),'shared');
 fs.appendFileSync(f.store.taskFile('Fixture',other.id),'\n参照 .ai/work/'+c.id+'/memo.txt\n');const d=f.preview();assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));
 f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id,files:d.items[0].selected,optional:['作業/'+c.id]}]});
 assert.equal(fs.existsSync(temp),true);assert.equal(fs.existsSync(path.join(f.dir,'作業',c.id)),false);assert.ok(f.transfer.read('Fixture',c.id).complete);
});

for(const stop of ['notification','copy-move','cleanup-save'])test('R1 専用一時物と任意フォルダ付きで'+stop+'停止後に一度だけ受領・片付け',t=>{
 const f=fixture(t),c=f.child('再開');f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'temporary');
 const apply=()=>{const d=f.preview();return f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({...cleanupReview(i),project:i.project,task:i.task,files:i.selected,optional:['作業/'+i.task]}))});};
 if(stop==='notification')f.transfer.beforeCleanup=()=>{throw Error('fixture interruption');};
 if(stop==='copy-move')f.integrate.gitw={...git,cleanupCopy:args=>git.cleanupCopy({...args,beforeMove:data=>{args.beforeMove(data);fs.renameSync(c.workdir,data.trashed);throw Error('fixture interruption');}})};
 if(stop==='cleanup-save'){const save=f.removal.save.bind(f.removal);f.removal.save=r=>{save(r);throw Error('fixture interruption');};}
 assert.throws(apply,/fixture interruption/);assert.ok(f.store.taskFile('Fixture',c.id));
 f.removal.save=Removal.prototype.save.bind(f.removal);f.restart();assert.equal(apply().complete,true);
 assert.equal(fs.existsSync(path.join(f.dir,'.ai/work',c.id)),false);assert.equal(fs.existsSync(path.join(f.dir,'作業',c.id)),false);
 const receipt=f.transfer.read('Fixture',c.id);assert.ok(fs.existsSync(receipt.files[0].to));assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('R1 受領先の参照は元フォルダと誤認せず、真の共有参照を追加すると再開を保留',t=>{
 const f=fixture(t),c=f.child('共有'),temp=f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'shared');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};assert.throws(()=>f.apply(f.preview()),/fixture stop/);
 const other=f.store.createTask('Fixture',{title:'参照元'});chat.append(f.dir,other.id,{role:'user',text:'使う '+temp});
 f.restart();assert.throws(()=>f.apply(f.preview()),/管理ファイルが変わりました/);assert.ok(fs.existsSync(c.workdir));assert.ok(fs.existsSync(temp));assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const change of ['new-untracked','existing-local','tracked'])test('R2 受領停止後の'+change+'変更は未統合のまま片付けない',t=>{
 const f=fixture(t),c=f.child('保持');f.write(path.join(c.workdir,'.env'),'INITIAL=1\n');
 f.write(path.join(c.workdir,'.gitignore'),'scratch/\n.env\n');git.save(c.workdir,'ignore');f.write(path.join(c.workdir,'scratch','temp.txt'),'original ignored temporary');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};assert.throws(()=>f.apply(f.preview()),/fixture stop/);
 const filename=change==='new-untracked'?'new-unintegrated.txt':change==='existing-local'?'.env':'base.txt';f.write(path.join(c.workdir,filename),'new unintegrated work\n');
 f.restart();assert.throws(()=>f.apply(f.preview()),/未統合/);assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 assert.notEqual(fs.existsSync(path.join(f.body,filename))&&fs.readFileSync(path.join(f.body,filename),'utf8'),'new unintegrated work\n');
});
test('R2 最初からあるignore一時物とignoreローカル設定は再開時コピーとともにTrash',t=>{
 const f=fixture(t),c=f.child('設定');f.write(path.join(c.workdir,'.env'),'LOCAL=1\n');f.write(path.join(c.workdir,'.gitignore'),'scratch/\n.env\n');git.save(c.workdir,'ignore');f.write(path.join(c.workdir,'scratch','temp.txt'),'ignored');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};assert.throws(()=>f.apply(f.preview()),/fixture stop/);f.restart();assert.equal(f.apply(f.preview()).complete,true);
 const copy=f.integrate.read('Fixture',f.parent.id).items[0].copyTrashed;assert.equal(fs.readFileSync(path.join(copy,'.env'),'utf8'),'LOCAL=1\n');assert.equal(fs.readFileSync(path.join(copy,'scratch','temp.txt'),'utf8'),'ignored');assert.equal(fs.existsSync(path.join(f.body,'.env')),false);
});
for(const target of ['child-tracked','child-untracked','parent-tracked','parent-untracked'])test('R3 確認済みの同じdirtyファイルの内容変更を拒否 '+target,t=>{
 const f=fixture(t),c=f.child('内容');let dir=c.workdir;
 if(target.startsWith('parent')){const w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});dir=w.dir;}
 const filename=target.endsWith('-untracked')?'new.txt':'base.txt';f.write(path.join(dir,filename),'previewed version\n');const d=f.preview(),before=git.inspect(dir),head=sh(f.body,'rev-parse','HEAD');
 f.write(path.join(dir,filename),'unreviewed version\n');const after=git.inspect(dir);assert.equal(before.status,after.status);assert.notEqual(before.content,after.content);
 assert.throws(()=>f.apply(d),target.startsWith('parent')?/統合先が変わりました|未保存の変更を保存/:/変更を保存/);assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));assert.equal(f.integrate.read('Fixture',f.parent.id),null);
});
test('R4 旧版の対象外の子を戻した後、祖先の統合候補として受領する',t=>{
 const f=fixture(t),c=f.child('旧対象外');f.store.updateTask('Fixture',c.id,{mergeExcluded:true});assert.match(f.preview().items[0].blockers.join(' '),/対象から外され/);
 f.store.updateTask('Fixture',c.id,{mergeExcluded:false});assert.deepEqual(f.preview().items[0].blockers,[]);assert.equal(f.apply(f.preview()).complete,true);
});
test('R1 片付け記録作成後でも新しい真の共有参照を保護する',t=>{
 let stop=true;const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture stop');}fs.renameSync(a,b);}}),c=f.child('後の共有');
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'shared');assert.throws(()=>f.apply(f.preview()),/fixture stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);
 const other=f.store.createTask('Fixture',{title:'参照元'});chat.append(f.dir,other.id,{role:'user',text:'読む：./.ai/work/'+c.id+'/temp.txt'});
 f.restart();assert.throws(()=>f.apply(f.preview()),/他の記録から参照/);assert.ok(fs.existsSync(temp));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
});
for(const mode of ['cross-project-relative','json-tab'])for(const stage of ['initial','cleanup-resume'])test('R1 共有参照 '+mode+' を '+stage+' で保護する',t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture shared stop');}fs.renameSync(a,b);}}),c=f.child('共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stage==='cleanup-resume'){assert.throws(()=>f.apply(f.preview()),/fixture shared stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 if(mode==='cross-project-relative'){
  const readerDir=path.join(f.root,'Product','Consumer');f.write(path.join(readerDir,'PROJECT.md'),'---\nname: Consumer\n---\n');const reader=f.store.createTask('Consumer',{title:'別プロジェクトの参照元'}),ref='../Fixture/.ai/work/'+c.id+'/shared.txt';
  assert.equal(path.resolve(readerDir,ref),temp);fs.appendFileSync(f.store.taskFile('Consumer',reader.id),'\n読む：'+ref+'\n');
 }else{const reader=f.store.createTask('Fixture',{title:'タブ直後の参照元'});chat.append(f.dir,reader.id,{role:'user',text:'読む\t.ai/work/'+c.id+'/shared.txt'});}
 const p=f.store.readProject('Fixture');assert.equal(f.removal.referenced(path.dirname(temp),p,p.tasks.find(x=>x.id===c.id),f.store.listProjects()),true);
 if(stage==='initial'){
  const d=f.preview();assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal(f.apply(d).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();assert.throws(()=>f.apply(f.preview()),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
for(const [name,before,after] of [['corner','読む「','」'],['double-corner','読む『','』'],['parentheses','参照（','）'],['comma','参照、','']])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 日本語区切り '+name+' '+medium+' '+stage+' の共有物を保持する',t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture punctuation stop');}fs.renameSync(a,b);}}),c=f.child('日本語の共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stop){assert.throws(()=>f.apply(f.preview()),/fixture punctuation stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 const reader=f.store.createTask('Fixture',{title:'日本語参照元'}),text=before+'.ai/work/'+c.id+'/shared.txt'+after;
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Fixture',reader.id),'\n'+text+'\n');else chat.append(f.dir,reader.id,{role:'user',text});
 if(stage==='initial'){
  const d=f.preview();assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal(f.apply(d).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();assert.throws(()=>f.apply(f.preview()),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

for(const project of ['対象（共有）','対象「共有」','対象『共有』','対象、共有'])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 パス内の日本語文字 '+project+' '+medium+' '+stage+' の共有物を保持する',t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{project,rename:(a,b)=>{if(stop){stop=false;throw Error('fixture pathname stop');}fs.renameSync(a,b);}}),c=f.child('パスの共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stop){assert.throws(()=>f.apply(f.preview()),/fixture pathname stop/);assert.ok(f.transfer.read(project,c.id).cleanup);}
 const readerDir=path.join(f.root,'Product','Consumer');f.write(path.join(readerDir,'PROJECT.md'),'---\nname: Consumer\n---\n');const reader=f.store.createTask('Consumer',{title:'引用なし参照元'}),ref='../'+project+'/.ai/work/'+c.id+'/shared.txt';
 assert.equal(path.resolve(readerDir,ref),temp);
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Consumer',reader.id),'\n読む '+ref+'\n');else chat.append(readerDir,reader.id,{role:'user',text:'読む '+ref});
 if(stage==='initial'){
  const d=f.preview();assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal(f.apply(d).complete,true);assert.equal(f.store.taskFile(project,c.id),null);
 }else{
  f.restart();assert.throws(()=>f.apply(f.preview()),/他の記録から参照/);assert.ok(f.store.taskFile(project,c.id));assert.equal(f.transfer.read(project,c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');assert.ok(f.store.taskFile('Consumer',reader.id));
 const receipt=f.transfer.read(project,c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});


for(const [style,format] of [['comma',ref=>'読む：資料/a.md、'+ref],['brackets',ref=>'読む【資料/a.md】、読む【'+ref+'】'],['sentence',ref=>'読む 資料/a.md。参照、'+ref]])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 複数共有参照 '+style+' '+medium+' '+stage+' を保護する',t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture list stop');}fs.renameSync(a,b);}}),c=f.child('複数参照',f.parent.id,false),temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 f.write(path.join(f.dir,'資料/a.md'),'first reference');
 if(stop){assert.throws(()=>f.apply(f.preview()),/fixture list stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 const reader=f.store.createTask('Fixture',{title:'複数を読む別作業'}),text=format('.ai/work/'+c.id+'/shared.txt');
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Fixture',reader.id),'\n'+text+'\n');else chat.append(f.dir,reader.id,{role:'user',text});
 if(stage==='initial'){
  const d=f.preview();assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal(f.apply(d).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();assert.throws(()=>f.apply(f.preview()),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');assert.ok(f.store.taskFile('Fixture',reader.id));
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

test('未引渡しの統合も専用成果を優先し、共有の過去資料は列挙しない',t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false),big=f.write(path.join(f.dir,'成果物','big.zip'),'');fs.truncateSync(big,65*1024*1024);
 for(let n=0;n<501;n++)f.write(path.join(f.dir,'作業',`${n}.txt`),'shared');
 const d=f.preview(),i=d.items[0];assert.equal(i.candidateError,null);assert.deepEqual(i.blockers,[]);assert.equal(i.files.length,1);assert.equal(i.files[0].relative,'作業/'+c.id+'/report.txt');assert.equal(i.skipped.count,0);assert.deepEqual(i.selected,[i.files[0].id]);
 assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id,files:['project:成果物/big.zip']}]}),/選択が不正/);
 assert.equal(f.transfer.read('Fixture',c.id),null);
});
test('専用成果の超過時は統合に指定案内を一つだけ出し、引渡し後は記録済みfilesを使う',t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false),big=f.write(path.join(f.dir,'成果物',c.id,'big.zip'),'');fs.truncateSync(big,65*1024*1024);
 let i=f.preview().items[0];assert.match(i.candidateError,/64MB/);assert.equal(i.blockers.length,1);assert.match(i.blockers[0],/子の成果候補を確認できません.*AIに成果の整理/);assert.doesNotMatch(i.blockers[0],/成果ファイルがありません/);
 const d=f.transfer.offerPreview('Fixture',c.id,['作業/'+c.id+'/report.txt']);assert.deepEqual(d.blockers,[]);
 f.transfer.offer({project:'Fixture',task:c.id,token:d.token,selected:d.selected,confirm:true});
 // 手元の専用成果が超過のままでも、渡し済みの選択だけを親へ出す。
 i=f.preview().items[0];assert.equal(i.handedUp,true);assert.equal(i.candidateError,null);assert.deepEqual(i.blockers,[]);assert.deepEqual(i.files,d.files);assert.deepEqual(i.selected,d.selected);assert.deepEqual(i.skipped,{count:0,bytes:0});
 fs.appendFileSync(d.files[0].path,'changed');i=f.preview().items[0];assert.equal(i.blockers.length,1);assert.match(i.blockers[0],/渡し済みの成果が変わ/);
});

// 復旧試験は実データを使わず、隔離したGitと段階記録だけで行う。
function pauseReceipt(f,after=0){
 const receive=f.transfer.receiveIntegrated.bind(f.transfer);let n=0;
 f.transfer.receiveIntegrated=args=>{if(n++===after)throw Error('fixture pause before receipt');return receive(args);};
 assert.throws(()=>f.apply(f.preview()),/pause before receipt/);f.transfer.receiveIntegrated=receive;
 return f.integrate.read('Fixture',f.parent.id);
}
function parentCopy(f){const w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});return w.dir;}
const recoverApply=(f,d)=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,recover:true});
for(const place of ['body','copy'])test('復旧R1 保存先の未解消衝突からAIだけを再開し、mergeと記録を変更しない：'+place,t=>{
 const f=fixture(t),target=place==='copy'?parentCopy(f):f.body,c=f.child('子');
 f.write(path.join(c.workdir,'base.txt'),'child conflict\n');git.save(c.workdir,'child conflict');
 f.write(path.join(target,'base.txt'),'target conflict\n');git.save(target,'target conflict');
 assert.equal(f.apply(f.preview()).conflict,true);assert.equal(git.merging(target),false);
 // コピー保存先でもworkdir無しで再開する経路を通す。
 f.store.updateTask('Fixture',f.parent.id,{workdir:''});
 assert.throws(()=>sh(target,'merge','--no-ff','--no-edit',git.inspect(c.workdir).branch));assert.equal(git.merging(target),true);
 const mergeHead=sh(target,'rev-parse','MERGE_HEAD'),before=git.inspect(target),journal=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8');
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),fn=source.slice(source.indexOf('function assertWorkspaceIdle('),source.indexOf('const inWork ='));
 let prepares=0,active=[];const p=f.store.readProject('Fixture'),parent=f.store.readTask(f.store.taskFile('Fixture',f.parent.id));
 const ctx={executionGate:{assert:()=>{}},discussion:null,restartControl:null,webchatActive:()=>false,lt:require('../lib/locale').lt,appUpdate:{applying:()=>false},fs,path,expandHome:x=>x,baseOf:()=>f.body,DRY:false,taskIntegrate:f.integrate,gitw:{prepare:()=>{prepares++;throw Error('new copy forbidden');}},workRoot:()=>f.removal.workRoot(p),store:f.store,maintenance:{locked:()=>false},github:{assertStart:()=>{}},githubProject:p=>p,sessions:{list:()=>active},chats:{running:new Map()}};
 ctx.parallelEngine=parallelFixture(ctx);vm.createContext(ctx);vm.runInContext(fn,ctx);assert.equal(ctx.startDir(p,parent).dir,target);assert.equal(prepares,0);
 assert.equal(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).workdir,'');assert.deepEqual(git.inspect(target),before);assert.equal(sh(target,'rev-parse','MERGE_HEAD'),mergeHead);
 assert.throws(()=>git.recoveryTarget(target,f.body,{clean:false}),/取り込みが途中/);
 if(place==='copy')f.store.updateTask('Fixture',f.parent.id,{workdir:target});
 const d=f.preview();assert.match(d.blockers.join(' '),/取り込みが途中/);assert.throws(()=>f.apply(d),/取り込みが途中/);
 assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),journal);assert.equal(sh(target,'rev-parse','MERGE_HEAD'),mergeHead);assert.deepEqual(git.inspect(target),before);
 active=[{project:p.id,task:c.id,running:true}];
 if(place==='body')assert.throws(()=>ctx.startDir(p,parent),/本体での同時作業/);else assert.equal(ctx.startDir(p,parent).dir,target);
 assert.equal(prepares,0);assert.deepEqual(git.inspect(target),before);
 f.write(path.join(target,'base.txt'),'resolved conflict\n');sh(target,'add','.');sh(target,'commit','-qm','manually resolved');
 f.store.updateTask('Fixture',f.parent.id,{question:''});const resolved=git.inspect(target).head;
 f.restart();const ready=f.preview();assert.deepEqual(ready.blockers,[]);assert.equal(f.apply(ready).complete,true);assert.equal(git.inspect(target).head,resolved);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
for(const invalid of ['outside','foreign','link'])test('復旧R1 AI開始の場所・同repo・リンク保護を維持する：'+invalid,t=>{
 const f=fixture(t);f.child('子');const journal=pauseReceipt(f);let target;
 if(invalid==='outside'){target=path.join(f.root,'Outside');fs.mkdirSync(target);}
 if(invalid==='foreign'){
  target=path.join(f.removal.workRoot({id:'Fixture'}),'Foreign');f.write(path.join(target,'file.txt'),'foreign');sh(target,'init','-q');sh(target,'config','user.name','fixture');sh(target,'config','user.email','fixture@localhost');sh(target,'add','.');sh(target,'commit','-qm','foreign');
 }
 if(invalid==='link'){target=path.join(f.removal.workRoot({id:'Fixture'}),'Link');fs.symlinkSync(f.body,target);}
 f.integrate.save({...journal,target});const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),head=git.inspect(f.body).head;
 assert.throws(()=>f.integrate.startTarget(f.store.readProject('Fixture'),f.parent),invalid==='outside'?/場所が不正/:invalid==='foreign'?/同じ本体のリポジトリ/:/リンク/);
 assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);assert.equal(git.inspect(f.body).head,head);
});
for(const place of ['body','copy'])for(const after of [false,true])test('復旧R2 同じ統合先で済commitが欠けたら受領・片付け・記録保存前に拒否：'+place+' '+after,t=>{
 const f=fixture(t),target=place==='copy'?parentCopy(f):f.body,base=git.inspect(target).head,a=f.child('A'),b=f.child('B'),journal=pauseReceipt(f,1);
 assert.equal(journal.items[0].task,a.id);assert.equal(journal.items[0].state,'片付け済み');assert.equal(journal.items[1].task,b.id);assert.equal(journal.items[1].state,'取り込み済み');
 const stale=after?f.preview():null;
 // fixtureだけでAを失う履歴へ変える。パス・子hash/source・予約は不変。
 sh(target,'reset','--hard',base);sh(target,'merge','--no-ff','--no-edit',git.inspect(b.workdir).branch);
 assert.equal(git.isAncestor(target,journal.items[0].integrated.commit),false);assert.equal(fs.existsSync(path.join(target,'A.txt')),false);assert.equal(fs.existsSync(path.join(target,'B.txt')),true);
 const record=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),receipt=JSON.stringify(f.transfer.read('Fixture',b.id)),head=git.inspect(target).head;
 let writes=0;f.integrate.save=()=>{writes++;throw Error('unexpected journal write');};f.transfer.save=()=>{writes++;throw Error('unexpected receipt write');};
 const d=f.preview();assert.equal(d.recover,null);assert.match(d.blockers.join(' '),/済んだ子の取り込み.*A/);assert.equal(d.items[1].recordChanged,false);assert.equal(d.items[1].sourceChanged,false);
 assert.throws(()=>f.apply(stale||d),after?/変わりました/:/済んだ子の取り込み/);assert.equal(writes,0);
 assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),record);assert.equal(JSON.stringify(f.transfer.read('Fixture',b.id)),receipt);assert.equal(git.inspect(target).head,head);assert.ok(fs.existsSync(b.workdir));assert.ok(f.store.taskFile('Fixture',b.id));assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
for(const place of ['body','copy'])test('復旧R2 受領開始後も済commit欠落なら保存した段階を進めない：'+place,t=>{
 const f=fixture(t),target=place==='copy'?parentCopy(f):f.body,base=git.inspect(target).head,c=f.child('子');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop during receipt');};assert.throws(()=>f.apply(f.preview()),/stop during receipt/);
 const receipt=JSON.stringify(f.transfer.read('Fixture',c.id)),record=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8');assert.equal(f.transfer.read('Fixture',c.id).receiving,true);
 sh(target,'reset','--hard',base);f.restart();const d=f.preview();assert.equal(d.recover,null);assert.equal(d.items[0].receiving,true);assert.match(d.blockers.join(' '),/済んだ子の取り込み/);assert.throws(()=>f.apply(d),/済んだ子の取り込み/);
 assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),record);assert.equal(JSON.stringify(f.transfer.read('Fixture',c.id)),receipt);assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(git.inspect(target).head,base);
});
for(const direction of ['body-copy','copy-body'])test('復旧は統合先の両方向変更と済んだ子を保持し、no-op→受領→片付けを一回だけ行う：'+direction,t=>{
 const f=fixture(t);if(direction==='copy-body')parentCopy(f);
 const a=f.child('先'),b=f.child('後');const journal=pauseReceipt(f,1),done=journal.items[0];
 const target=direction==='body-copy'?parentCopy(f):f.body;
 if(direction==='copy-body'){sh(f.body,'merge','--ff-only',journal.target===f.body?'HEAD':git.inspect(journal.target).branch);f.store.updateTask('Fixture',f.parent.id,{workdir:''});}
 const head=git.inspect(target).head;f.restart();const d=f.preview();assert.ok(d.recover);assert.equal(d.items[0].retained,true);assert.equal(d.items[1].codeAlready,true);assert.deepEqual(d.blockers,[]);
 assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true}),/復旧内容/);
 assert.equal(recoverApply(f,d).complete,true);assert.equal(recoverApply(f,d).duplicate,true);assert.equal(git.inspect(target).head,head);
 const r=f.integrate.read('Fixture',f.parent.id);assert.deepEqual(r.items[0],done);assert.equal(r.targetHistory.length,1);assert.equal(r.targetHistory[0].from,journal.target);assert.equal(r.targetHistory[0].to,target);assert.equal(r.items[1].integrated.already,true);
 assert.equal(f.store.taskFile('Fixture',a.id),null);assert.equal(f.store.taskFile('Fixture',b.id),null);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,2);
});
test('復旧先に済んだcommitが無ければ記録と受領を変更しない',t=>{
 const f=fixture(t);parentCopy(f);f.store.updateTask('Fixture',f.parent.id,{workdir:''});f.child('先');f.child('後');pauseReceipt(f,1);
 f.store.updateTask('Fixture',f.parent.id,{workdir:path.join(f.removal.workRoot({id:'Fixture'}),f.parent.id)});
 const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),d=f.preview();assert.match(d.blockers.join(' '),/済んだ子の取り込み/);assert.throws(()=>recoverApply(f,d),/済んだ子/);assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);
});
test('中断後のtaskHash変更は再確認で継続し、質問・未完・除外は通さない',t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);fs.appendFileSync(f.store.taskFile('Fixture',c.id),'\n確認記録追加\n');
 const d=f.preview();assert.ok(d.recover);assert.equal(d.items[0].recordChanged,true);assert.equal(recoverApply(f,d).complete,true);
 for(const change of ['question','unfinished','excluded']){
  const g=fixture(t),x=g.child('子');pauseReceipt(g);
  if(change==='question')g.store.updateTask('Fixture',x.id,{question:'確認待ち'});
  if(change==='unfinished')g.store.setStep('Fixture',x.id,0,false);
  if(change==='excluded')g.store.updateTask('Fixture',x.id,{mergeExcluded:true});
  const p=g.preview();assert.ok(p.blockers.length);assert.throws(()=>recoverApply(g,p),/手順・質問|対象から外/);assert.ok(g.store.taskFile('Fixture',x.id));
 }
});
for(const conflict of [false,true])test('更新された子HEADは再mergeし、衝突なら現在の統合先を案内する：'+conflict,t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);const target=parentCopy(f);
 f.write(path.join(c.workdir,'base.txt'),'child update\n');git.save(c.workdir,'updated source');
 if(conflict){f.write(path.join(target,'base.txt'),'parent update\n');git.save(target,'parent update');}
 const d=f.preview();assert.equal(d.items[0].sourceChanged,true);assert.equal(d.items[0].codeAlready,false);
 const result=recoverApply(f,d);assert.equal(Boolean(result.conflict),conflict);
 if(conflict){const q=f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).question;assert.ok(q.includes(target));assert.match(q,/新しい作業用コピーは作りません/);assert.equal(f.transfer.read('Fixture',c.id).complete,undefined);}
 else{assert.equal(result.complete,true);assert.equal(fs.readFileSync(path.join(target,'base.txt'),'utf8'),'child update\n');}
});
for(const change of ['target','task','source','journal','reservation','files'])test('復旧確認後の変更をトークンで拒否し、記録を上書きしない：'+change,t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);const target=parentCopy(f),d=f.preview();
 if(change==='target'){f.write(path.join(target,'late.txt'),'late');git.save(target,'late target');}
 if(change==='task')fs.appendFileSync(f.store.taskFile('Fixture',c.id),'\nlate metadata\n');
 if(change==='source'){f.write(path.join(c.workdir,'late.txt'),'late');git.save(c.workdir,'late source');}
 if(change==='journal'){const r=f.integrate.read('Fixture',f.parent.id);r.error='external change';f.integrate.save(r);}
 if(change==='reservation'){const h=f.transfer.read('Fixture',c.id);h.title='external change';f.transfer.save(h);}
 if(change==='files')f.write(path.join(f.dir,'作業',c.id,'report.txt'),'late report');
 const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8');assert.throws(()=>recoverApply(f,d),/変わりました/);assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const reservation of ['other','complete','missing'])test('復旧時の別予約・完了・予約欠落を拒否する：'+reservation,t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);parentCopy(f);const h=f.transfer.read('Fixture',c.id);
 if(reservation==='other')h.integrating='another';if(reservation==='complete')h.complete=true;if(reservation==='missing')delete h.integrating;f.transfer.save(h);
 const d=f.preview();assert.ok(d.blockers.length);assert.throws(()=>recoverApply(f,d),/予約|受領記録/);assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const state of ['dirty','merge','foreign'])test('復旧先がdirty・MERGE_HEAD・別repoなら拒否する：'+state,t=>{
 const f=fixture(t);f.child('子');pauseReceipt(f);const target=parentCopy(f);
 if(state==='dirty')f.write(path.join(target,'late.txt'),'late');
 if(state==='merge'){const own=sh(target,'rev-parse','--git-path','MERGE_HEAD');f.write(path.resolve(target,own),git.inspect(target).head+'\n');}
 if(state==='foreign'){const foreign=path.join(f.removal.workRoot({id:'Fixture'}),'foreign');f.write(path.join(foreign,'base.txt'),'foreign');sh(foreign,'init','-q');sh(foreign,'config','user.name','fixture');sh(foreign,'config','user.email','fixture@localhost');sh(foreign,'add','.');sh(foreign,'commit','-qm','foreign');f.store.updateTask('Fixture',f.parent.id,{workdir:foreign});}
 const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),d=f.preview();assert.ok(d.blockers.length);assert.throws(()=>recoverApply(f,d),/未保存|途中|リポジトリ|取り込み/);assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);
});
test('復旧後の片付け停止も保存した受領段階から再開し二重通知・mergeしない',t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);const target=parentCopy(f),cleanup=f.integrate.gitw.cleanupCopy;let stop=true;
 f.integrate.gitw={...git,cleanupCopy:args=>{if(stop){stop=false;throw Error('fixture recovery cleanup stop');}return cleanup(args);}};
 assert.throws(()=>recoverApply(f,f.preview()),/recovery cleanup stop/);const head=git.inspect(target).head;f.restart();assert.equal(f.apply(f.preview()).complete,true);assert.equal(git.inspect(target).head,head);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);assert.equal(f.store.taskFile('Fixture',c.id),null);
});
test('workDirは未完統合と空workdirなら保存先を使い、既存コピーと通常準備は維持',t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),fn=source.slice(source.indexOf('function workDir(p, t)'),source.indexOf('function startDir('));
 let prepares=0;const p=f.store.readProject('Fixture'),ctx={fs,expandHome:x=>x,baseOf:()=>f.body,DRY:false,taskIntegrate:f.integrate,gitw:{prepare:()=>{prepares++;return {dir:'prepared'};}},workRoot:()=>f.removal.workRoot(p),store:f.store};vm.createContext(ctx);vm.runInContext(fn,ctx);
 const parent=f.store.readTask(f.store.taskFile('Fixture',f.parent.id));assert.equal(ctx.workDir(p,parent).dir,f.body);assert.equal(prepares,0);assert.equal(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).workdir,'');
 assert.equal(ctx.workDir(p,c).dir,c.workdir);assert.equal(prepares,0);
 f.store.updateTask('Fixture',f.parent.id,{workdir:parentCopy(f)});assert.equal(ctx.workDir(p,f.store.readTask(f.store.taskFile('Fixture',f.parent.id))).dir,path.join(f.removal.workRoot(p),f.parent.id));
 const other=f.store.createTask('Fixture',{title:'通常'});assert.equal(ctx.workDir(p,other).dir,'prepared');assert.equal(prepares,1);
});
test('初回の予約保存の中断は通常再開で補い、復旧時の予約一致条件は弱めない',t=>{
 const f=fixture(t),c=f.child('子'),save=f.transfer.save.bind(f.transfer);let stop=true;
 f.transfer.save=r=>{if(stop){stop=false;throw Error('fixture reservation save stop');}return save(r);};
 assert.throws(()=>f.apply(f.preview()),/reservation save stop/);f.transfer.save=save;
 const d=f.preview();assert.equal(d.recover,null);assert.deepEqual(d.blockers,[]);assert.equal(f.apply(d).complete,true);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);assert.equal(f.store.taskFile('Fixture',c.id),null);
});
test('Git未導入のファイル成果の途中記録も、本体の保存先で開始する',t=>{
 const f=fixture(t),body=path.join(f.root,'Artifacts');f.write(path.join(body,'result.txt'),'files');
 const manager=new TaskIntegrate({store:f.store,transfer:f.transfer,removal:f.removal,baseOf:()=>body});manager.save({id:'artifact-start',project:'Fixture',task:f.parent.id,target:body,items:[],complete:false});
 assert.equal(manager.startTarget(f.store.readProject('Fixture'),f.parent).dir,body);
});
for(const who of ['target','source'])for(const after of [false,true])test('統合先が同じ再開でも途中mergeを拒否し、確認後に発生した時も記録を保持する：'+who+' '+after,t=>{
 const f=fixture(t),c=f.child('子');pauseReceipt(f);let d=after?f.preview():null;const dir=who==='target'?f.body:c.workdir;
 const mergeHead=path.resolve(dir,sh(dir,'rev-parse','--git-path','MERGE_HEAD'));f.write(mergeHead,git.inspect(dir).head+'\n');
 if(!after){d=f.preview();assert.ok(d.blockers.some(x=>x.includes('取り込みが途中')));}
 const before=fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8');assert.throws(()=>f.apply(d),after?/変わりました/:/取り込みが途中/);assert.equal(fs.readFileSync(f.integrate.file('Fixture',f.parent.id),'utf8'),before);assert.ok(f.store.taskFile('Fixture',c.id));
});
test('保存先が本体のAI再開も同時作業保護を維持し、保存先がコピーなら従来の隔離を維持する',t=>{
 const f=fixture(t),other=f.child('別作業'),vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),fn=source.slice(source.indexOf('function assertWorkspaceIdle('),source.indexOf('function workDir('));
 let active=[],seen;const chats={running:new Map()},ctx={executionGate:{assert:()=>{}},restartControl:null,webchatActive:()=>false,lt:require('../lib/locale').lt,appUpdate:{applying:()=>false,busyMessage:()=>"fixture update applying"},fs,path,expandHome:x=>x,baseOf:()=>f.body,maintenance:{locked:()=>false},github:{assertStart:(p,t)=>{seen=t.workdir;}},githubProject:p=>p,taskIntegrate:f.integrate,sessions:{list:()=>active},chats,store:f.store};ctx.parallelEngine=parallelFixture(ctx);vm.createContext(ctx);vm.runInContext(fn,ctx);
 const p=f.store.readProject('Fixture'),parent=f.store.readTask(f.store.taskFile('Fixture',f.parent.id));
 active=[{project:p.id,task:other.id,running:true}];assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,{...parent,workspaceMode:'shared',workdir:f.body}));
 f.integrate.save({id:'pending-base',project:p.id,task:parent.id,target:f.body,items:[],complete:false});
 active=[{project:p.id,task:other.id,running:true}];assert.throws(()=>ctx.assertWorkspaceIdle(p,parent),/本体での同時作業/);assert.equal(seen,f.body);
 active=[{project:p.id,task:parent.id,running:true}];assert.throws(()=>ctx.assertWorkspaceIdle(p,other),/本体での同時作業/);
 active=[];chats.running.set(p.id+'\0'+parent.id,{});assert.throws(()=>ctx.assertWorkspaceIdle(p,parent,false),/本体での同時作業/);assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,parent,true));chats.running.clear();
 const copy=parentCopy(f);f.store.updateTask(p.id,parent.id,{workdir:''});f.integrate.save({id:'pending-copy',project:p.id,task:parent.id,target:copy,items:[],complete:false});
 active=[{project:p.id,task:other.id,running:true}];assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,parent));assert.equal(seen,copy);
 active=[{project:p.id,task:parent.id,running:true}];assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,other));
 ctx.appUpdate.applying=()=>true;assert.throws(()=>ctx.assertWorkspaceIdle(p,parent),error=>error.status===409&&error.message==="fixture update applying");
});

for (const surface of ['chat', 'terminal']) test('freetalkの別話題だけ並行開始し、同話題・通常本体・検証中の保護を維持：'+surface,()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),fn=source.slice(source.indexOf('function assertWorkspaceIdle('),source.indexOf('function workDir('));
 const a={id:'a',workspaceMode:'direct'},b={id:'b',workspaceMode:'direct'},p={id:'freetalk',kind:'freetalk',tasks:[a,b]},ordinary={id:'ordinary',tasks:[a]};
 const chats={running:new Map()},active=surface==='terminal'?[{project:p.id,task:a.id,running:true}]:[];
 if(surface==='chat')chats.running.set(p.id+'\0'+a.id,{});
 const ctx={executionGate:{assert:()=>{}},restartControl:null,webchatActive:()=>false,lt:require('../lib/locale').lt,fs,path,expandHome:x=>x,baseOf:()=>os.tmpdir(),appUpdate:{applying:()=>false,busyMessage:()=> 'update applying'},maintenance:{locked:()=>false},github:{assertStart:()=>{}},githubProject:p=>p,taskIntegrate:{read:()=>null},sessions:{list:()=>active},chats,store:{listProjects:()=>[p,ordinary]}};
 ctx.parallelEngine=parallelFixture(ctx);vm.createContext(ctx);vm.runInContext(fn,ctx);
 const blocked=error=>error.status===409&&/本体での同時作業/.test(error.message);
 assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,b));
 assert.throws(()=>ctx.assertWorkspaceIdle(p,a),blocked);
 if(surface==='chat')assert.doesNotThrow(()=>ctx.assertWorkspaceIdle(p,a,true));
 else assert.throws(()=>ctx.assertWorkspaceIdle(p,a,true),blocked);
 assert.throws(()=>ctx.assertWorkspaceIdle(p,{workspaceMode:'direct'}),blocked);
 assert.throws(()=>ctx.assertWorkspaceIdle(ordinary,a),blocked);
 assert.throws(()=>ctx.assertWorkspaceIdle({...p,kind:undefined},b),blocked);
 ctx.maintenance.locked=()=>true;
 assert.throws(()=>ctx.assertWorkspaceIdle(p,b),error=>error.status===409&&/検証中/.test(error.message));
 ctx.maintenance.locked=()=>false;ctx.appUpdate.applying=()=>true;
 assert.throws(()=>ctx.assertWorkspaceIdle(p,b),error=>error.status===409&&error.message==='update applying');
});

function bookkeepingFixture(f){
 const pkg={name:'fixture',version:'1.0.0',dependencies:{example:'1.0.0'}};
 const lock={name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0',dependencies:{example:'1.0.0'}}}};
 f.write(path.join(f.body,'app/package.json'),JSON.stringify(pkg,null,2)+'\n');
 f.write(path.join(f.body,'app/package-lock.json'),JSON.stringify(lock,null,2)+'\n');
 f.write(path.join(f.body,'app/CHANGELOG.md'),'# 記録\n\n## 1.0.0（2026-10-01）\n- base history\n');git.save(f.body,'bookkeeping base');
 const bump=(dir,v,note)=>{
  for(const file of ['package.json','package-lock.json']){
   const name=path.join(dir,'app',file),p=JSON.parse(fs.readFileSync(name));p.version=v;if(p.packages)p.packages[''].version=v;
   fs.writeFileSync(name,JSON.stringify(p,null,2)+'\n');
  }
  const name=path.join(dir,'app/CHANGELOG.md'),old=fs.readFileSync(name,'utf8');
  fs.writeFileSync(name,old.replace(/^## /m,`## ${v}（2026-10-07）\n- ${note}\n\n## `));git.save(dir,note);
 };
 return bump;
}
test('ae 一括bookkeeping解消はpatch/minorの規則で両子を一度だけ受領し履歴を保持',t=>{
 const f=fixture(t),bump=bookkeepingFixture(f),a=f.child('patch'),b=f.child('minor');
 bump(a.workdir,'1.0.2','patch bullets');bump(b.workdir,'1.1.1','minor bullets');bump(f.body,'1.2.3','target bullets');
 const d=f.preview();for(const i of d.items){assert.equal(i.preview.conflictKind,'bookkeeping');assert.deepEqual(i.preview.conflictPaths.sort(),['app/CHANGELOG.md','app/package-lock.json','app/package.json']);}
 const out=f.apply(d,[d.items.find(i=>i.task===a.id),d.items.find(i=>i.task===b.id)]);assert.equal(out.complete,true);
 const r=f.integrate.read('Fixture',f.parent.id);assert.deepEqual(r.items.map(i=>i.autoResolved.to),['1.2.4','1.3.0']);
 const pkg=JSON.parse(fs.readFileSync(path.join(f.body,'app/package.json'))),lock=JSON.parse(fs.readFileSync(path.join(f.body,'app/package-lock.json'))),log=fs.readFileSync(path.join(f.body,'app/CHANGELOG.md'),'utf8');
 assert.equal(pkg.version,'1.3.0');assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);assert.equal(log.match(/^## ([\d.]+)/m)[1],pkg.version);
 for(const text of ['patch bullets','minor bullets','target bullets','base history'])assert.ok(log.includes(text));assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,2);
 assert.equal(git.dirty(f.body),false);assert.equal(f.store.taskFile('Fixture',a.id),null);assert.equal(f.store.taskFile('Fixture',b.id),null);
});
for(const bad of ['history','dependency','dependency-version','invalid-json','marker'])test('af/ak bookkeeping候補でも安全な規則外ならabortしてcontent：'+bad,t=>{
 const f=fixture(t),bump=bookkeepingFixture(f),c=f.child('子');bump(c.workdir,'1.0.1','child bullets');bump(f.body,'1.0.2','parent bullets');
 if(bad==='history'){const name=path.join(c.workdir,'app/CHANGELOG.md');f.write(name,fs.readFileSync(name,'utf8').replace('base history','rewritten old history'));git.save(c.workdir,'old history');}
 if(bad==='dependency'){for(const dir of [c.workdir,f.body]){const name=path.join(dir,'app/package.json'),p=JSON.parse(fs.readFileSync(name));p.dependencies.example=dir===f.body?'2.0.0':'3.0.0';f.write(name,JSON.stringify(p,null,2)+'\n');git.save(dir,'deps');}}
 if(bad==='dependency-version'){for(const dir of [c.workdir,f.body]){const name=path.join(dir,'app/package-lock.json'),p=JSON.parse(fs.readFileSync(name));p.packages['node_modules/example']={version:dir===f.body?'2.0.0':'3.0.0'};f.write(name,JSON.stringify(p,null,2)+'\n');git.save(dir,'dep version');}}
 if(bad==='invalid-json'){f.write(path.join(c.workdir,'app/package.json'),'{broken json\n');git.save(c.workdir,'broken');}
 if(bad==='marker'){f.write(path.join(c.workdir,'app/CHANGELOG.md'),fs.readFileSync(path.join(c.workdir,'app/CHANGELOG.md'),'utf8').replace('- child bullets','<<<<<<< leftover'));git.save(c.workdir,'marker');}
 const before=sh(f.body,'rev-parse','HEAD'),d=f.preview();assert.equal(d.items[0].preview.conflictKind,'content');
 const out=f.apply(d);assert.equal(out.partial,true);assert.equal(out.conflicts.length,1);assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.equal(git.dirty(f.body),false);assert.equal(git.merging(f.body),false);assert.ok(fs.existsSync(c.workdir));assert.equal(f.transfer.read('Fixture',c.id).complete,undefined);
});
test('ag/ah 一括content衝突は後続の独立子を続け子孫の親は待ち、質問一回、手動解消後no-opで再開',t=>{
 const f=fixture(t),a=f.child('A'),mid=f.child('親'),b=f.child('B',mid.id),c=f.child('C'),e=f.child('D');
 f.store.decideTask('Fixture',mid.id,'approve',mid.completionHash);
 for(const x of [a,b,e]){f.write(path.join(x.workdir,'base.txt'),x.title+'\n');git.save(x.workdir,x.title);}
 let questions=0;const update=f.store.updateTask.bind(f.store);f.store.updateTask=(p,t,b)=>{if(b.question)questions++;return update(p,t,b);};
 const d=f.preview(),order=[a,b,mid,c,e].map(x=>d.items.find(i=>i.task===x.id)),out=f.apply(d,order);
 assert.equal(out.partial,true);assert.equal(out.conflicts.length,2);assert.equal(questions,1);
 const r=f.integrate.read('Fixture',f.parent.id);assert.deepEqual(r.items.map(i=>i.state),['片付け済み','衝突','待ち','片付け済み','衝突']);assert.deepEqual(r.items[2].waitingFor,['B']);
 const question=f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).question;for(const x of ['B','D',f.body])assert.ok(question.includes(x));
 for(const x of [b,e]){assert.throws(()=>sh(f.body,'merge','--no-ff','--no-edit',git.inspect(x.workdir).branch));f.write(path.join(f.body,'base.txt'),'A B D combined\n');sh(f.body,'add','.');sh(f.body,'commit','-qm','resolve '+x.title);}
 update('Fixture',f.parent.id,{question:'',state:'実行中'});f.restart();const head=sh(f.body,'rev-parse','HEAD');assert.equal(f.apply(f.preview()).complete,true);
 const done=f.integrate.read('Fixture',f.parent.id);assert.equal(done.items[1].integrated.already,true);assert.equal(done.items[4].integrated.already,true);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,5);assert.ok(git.isAncestor(f.body,head));
});
test('ai 衝突依頼は確認token・予約・親の排他・子の衝突状態を照合し保存先とbranchを渡す',t=>{
 const f=fixture(t),a=f.child('A'),b=f.child('B');for(const x of [a,b]){f.write(path.join(x.workdir,'base.txt'),x.title+'\n');git.save(x.workdir,'conflict');}
 const d=f.preview();f.apply(d,[d.items.find(i=>i.task===a.id),d.items.find(i=>i.task===b.id)]);const resume=f.preview();
 const input={project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:b.id,token:resume.token};
 const request=f.integrate.conflictRequest(input);assert.ok(request.text.includes(f.body));assert.ok(request.text.includes(git.inspect(b.workdir).branch));assert.match(request.text,/ours\/theirs.*禁止/);assert.match(request.text,/\[\[質問\]\]/);
 assert.throws(()=>f.integrate.conflictRequest({...input,token:d.token}),/確認/);assert.throws(()=>f.integrate.conflictRequest({...input,childTask:a.id}),/衝突した子/);
 f.removal.busy=()=>true;assert.throws(()=>f.integrate.conflictRequest(input),/AI/);f.removal.busy=()=>false;
 f.write(path.join(f.dir,'.ai/chat',f.parent.id+'.queue.json'),'[{}]');assert.throws(()=>f.integrate.conflictRequest(input),/順番待ち/);f.write(path.join(f.dir,'.ai/chat',f.parent.id+'.queue.json'),'[]');
 f.write(path.join(b.workdir,'late.txt'),'late');assert.throws(()=>f.integrate.conflictRequest(input),/変わりました/);
});
test('aj パス重複だけは衝突にしない：別の行の変更',t=>{
 const f=fixture(t);f.write(path.join(f.body,'base.txt'),'one\n\ntwo\n\nthree\n');git.save(f.body,'lines');const c=f.child('子');
 f.write(path.join(c.workdir,'base.txt'),'ONE\n\ntwo\n\nthree\n');git.save(c.workdir,'child line');f.write(path.join(f.body,'base.txt'),'one\n\ntwo\n\nTHREE\n');git.save(f.body,'target line');
 const d=f.preview();assert.equal(d.items[0].preview.conflictKind,'none');assert.deepEqual(d.items[0].preview.conflictPaths,[]);assert.equal(f.apply(d).complete,true);
});

test('ak 自動解消commitの失敗もabortし、HEAD・ステージ・受領前の状態を保持する',t=>{
 const f=fixture(t),bump=bookkeepingFixture(f),c=f.child('子');bump(c.workdir,'1.0.1','child bullets');bump(f.body,'1.0.2','parent bullets');
 const before=sh(f.body,'rev-parse','HEAD'),hook=path.join(f.body,'.git/hooks/pre-commit');f.write(hook,'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);
 const d=f.preview();assert.equal(d.items[0].preview.conflictKind,'bookkeeping');const out=f.apply(d);
 assert.equal(out.partial,true);assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.equal(git.dirty(f.body),false);assert.equal(git.merging(f.body),false);assert.equal(f.transfer.read('Fixture',c.id).complete,undefined);assert.equal(f.integrate.read('Fixture',f.parent.id).items[0].state,'衝突');
});
for(const [childVersion,targetVersion,expected] of [['1.4.7','1.0.2','1.4.7'],['2.5.8','3.0.4','4.0.0']])test('ae 版のmajor規則と子の版が大きい時のmaxを保持：'+childVersion,t=>{
 const f=fixture(t),bump=bookkeepingFixture(f),c=f.child('子');bump(c.workdir,childVersion,'child bullets');bump(f.body,targetVersion,'parent bullets');
 // 非競合の依存更新はそのまま保つ。
 const name=path.join(c.workdir,'app/package.json'),pkg=JSON.parse(fs.readFileSync(name));pkg.dependencies.extra='2.0.0';f.write(name,JSON.stringify(pkg,null,2)+'\n');git.save(c.workdir,'extra dependency');
 const d=f.preview();assert.equal(d.items[0].preview.conflictKind,'bookkeeping');assert.equal(f.apply(d).complete,true);
 const merged=JSON.parse(fs.readFileSync(path.join(f.body,'app/package.json')));assert.equal(merged.version,expected);assert.equal(merged.dependencies.extra,'2.0.0');
});

// 成果の宣言→内容説明→1操作の統合。利用者の台帳には触れない。
test('未統合コピーの成果宣言は完了検査と統合previewで一致し親だけへ保持受領する', async t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});
 f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 const c=f.child('保存済み子'),head=git.inspect(c.workdir).head;fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 f.store.appendSection('Fixture',c.id,'成果',`- 本体保存済み：.@${head.slice(0,8)}（未統合の保存済み機能）`);
 f.store.setStep('Fixture',c.id,0,false);
 const original=git.inspect(f.body),p=f.store.listProjects()[0],task=p.tasks.find(x=>x.id===c.id),issue=f.transfer.resultIssue(p,task);
 const waiting=new IntegrateAuto({integrate:f.integrate,waitStatus:()=>[{kind:'chat',message:'AI稼働中'}]});
 const only=[{project:'Fixture',task:c.id}];
 const blocked=waiting.preview({project:'Fixture',task:f.parent.id,only});
 assert.equal(blocked.token,undefined);assert.equal(blocked.items[0].needsResults,false);assert.equal(f.transfer.read('Fixture',c.id),null);
 const d=f.preview(only);
 assert.equal(issue.ok,true);assert.equal(d.items[0].needsResults,false);assert.deepEqual(d.items[0].results,issue.results);assert.deepEqual(d.items[0].blockers,[]);
 const request={project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,thenMain:false,selected:[{project:'Fixture',task:c.id,disposition:'continue'}]};
 f.integrate.apply(request);
 const auto=new IntegrateAuto({integrate:f.integrate,busy:()=>false,dispatch:async()=>assert.fail('再委任不要'),mergeMain:async()=>assert.fail('本体反映禁止')});await auto.tick();
 const r=f.integrate.read('Fixture',f.parent.id),receipt=f.transfer.read('Fixture',c.id);
 assert.equal(r.complete,true);assert.equal(r.auto.thenMain,false);assert.equal(r.auto.main.skipped,true);
 assert.equal(git.isAncestor(w.dir,head),true);assert.deepEqual(git.inspect(f.body),original);
 assert.equal(fs.existsSync(c.workdir),true);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.store.readTask(f.store.taskFile('Fixture',c.id)).steps[0].done,false);
 assert.deepEqual(receipt.results,issue.results);const received=f.preview(only);
 assert.deepEqual(received.items,[]);assert.equal(received.retainedItems[0].alreadyReceived,true);
});
test('未統合コピー成果を本体へ受領した後も成果照合は同じで正規の片付けが完了する',t=>{
 const f=fixture(t),c=f.child('保存済み子'),head=git.inspect(c.workdir).head;
 f.store.appendSection('Fixture',c.id,'成果',`- 本体保存済み：.@${head}（保存済み機能）`);
 const d=f.preview(),results=d.items[0].results;assert.deepEqual(d.items[0].blockers,[]);
 assert.equal(f.apply(d).complete,true);assert.equal(fs.existsSync(c.workdir),false);
 assert.equal(git.isAncestor(f.body,head),true);assert.deepEqual(f.transfer.read('Fixture',c.id).results,results);
});
for(const kind of ['本体保存済み','なし'])test('成果ファイルなしの子も1回で受領・片付け：'+kind,t=>{
 const f=fixture(t),c=f.child('確認',f.parent.id,false);fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 const commit=sh(f.body,'rev-parse','HEAD');
 f.store.appendSection('Fixture',c.id,'成果',kind==='なし'?'- なし：確認だけ。結果はこの作業ファイルに記録':`- 本体保存済み：.@${commit.slice(0,8)}（確認した変更）`);
 const head=git.inspect(f.body),d=f.preview(),i=d.items[0];assert.deepEqual(i.blockers,[]);assert.equal(i.resultReady,true);assert.deepEqual(i.files,[]);
 const out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id}]});
 assert.equal(out.complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);assert.deepEqual(git.inspect(f.body),head);
 const receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.complete,true);assert.deepEqual(receipt.files,[]);assert.equal(receipt.results[0].kind,kind);
 assert.match(chat.read(f.dir,f.parent.id).find(x=>x.handoff).text,new RegExp(kind));assert.equal(f.apply({...d,resume:false}).duplicate,true);
});
test('コミットが現在の本体に無い時、成果記録改変・別repo・リンク・途中mergeはコピー前に拒否',t=>{
 const f=fixture(t),c=f.child('確認',f.parent.id,false),file=f.store.taskFile('Fixture',c.id);fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 const initial=fs.readFileSync(file,'utf8'),declare=value=>fs.writeFileSync(file,initial+`\n## 成果\n- 本体保存済み：${value}\n`);
 sh(f.body,'checkout','-qb','other');sh(f.body,'commit','--allow-empty','-qm','unreachable');const commit=sh(f.body,'rev-parse','HEAD');sh(f.body,'checkout','-q','-');
 declare('.@'+commit);assert.ok(f.preview().items[0].blockers.some(x=>x.includes('含まれていません')));assert.equal(f.transfer.read('Fixture',c.id),null);
 for(const value of ['../outside@'+commit,'missing@'+commit,'.@no-commit']){declare(value);assert.ok(f.preview().items[0].blockers.length);}
 declare('.@'+sh(f.body,'rev-parse','HEAD'));const d=f.preview();fs.appendFileSync(file,'\nchanged');assert.throws(()=>f.apply(d),/子作業/);
});
test('旧来の空子は回復案内で停止し、人へ選別させず既存の子に整理依頼を作る',t=>{
 const f=fixture(t),c=f.child('確認',f.parent.id,false);fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 f.write(path.join(f.dir,'成果物','古い.zip'),'past');const d=f.preview(),i=d.items[0];assert.deepEqual(i.files,[]);assert.equal(i.needsResults,true);assert.match(i.blockers[0],/成果の記録がありません/);
 assert.throws(()=>f.apply(d),/成果の記録/);assert.equal(f.integrate.read('Fixture',f.parent.id),null);
 const b={project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,token:d.token},request=f.integrate.resultsRequest(b);
 assert.equal(request.task,c.id);assert.match(request.text,/所属・内容・重複・反映済み/);assert.match(request.text,/人へファイル選別を求めない/);
 assert.throws(()=>f.integrate.resultsRequest({...b,token:'wrong'}),/確認/);assert.throws(()=>f.integrate.resultsRequest({...b,childTask:f.parent.id}),/必要な子/);
 f.store.appendSection('Fixture',c.id,'成果','- なし：確認のみ');assert.throws(()=>f.integrate.resultsRequest(b),/変わり/);assert.deepEqual(f.preview().items[0].blockers,[]);
});
test('宣言した共有ファイルだけを説明付きで受領し、同内容は正本を再利用、別内容は保持',t=>{
 const f=fixture(t),c=f.child('調査',f.parent.id,false),source=f.write(path.join(f.dir,'資料','結果.txt'),'new result');
 fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 const canonical=f.write(path.join(f.dir,'成果物','正本.txt'),'new result'),other=f.write(path.join(f.dir,'成果物','結果.txt'),'old result');
 f.store.appendSection('Fixture',c.id,'成果','- ファイル：資料/結果.txt（施設の調査結果）');
 const d=f.preview();assert.deepEqual(d.items[0].files.map(x=>x.path),[source]);assert.equal(d.items[0].files[0].description,'施設の調査結果');
 assert.equal(f.apply(d).complete,true);const receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.files[0].to,canonical);assert.equal(receipt.files[0].existing,true);
 assert.equal(fs.existsSync(receipt.destination),false);assert.equal(fs.readFileSync(other,'utf8'),'old result');assert.equal(fs.readFileSync(source,'utf8'),'new result');
 assert.match(chat.read(f.dir,f.parent.id).find(x=>x.handoff).text,/重複コピーなし/);
});
test('新規統合は成果全件と専用フォルダを自動処理し、追加成果や間引きを拒否',t=>{
 const f=fixture(t),c=f.child('調査',f.parent.id,false),second=f.write(path.join(f.dir,'作業',c.id,'second.txt'),'second');
 let d=f.preview();assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id,files:[d.items[0].files[0].id]}]}),/全件/);
 f.write(path.join(f.dir,'作業',c.id,'third.txt'),'third');assert.throws(()=>f.apply(d),/成果ファイルが変わ/);assert.ok(fs.existsSync(second));
 d=f.preview();assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id}]}).complete,true);
 assert.equal(fs.existsSync(path.dirname(second)),false);assert.equal(f.transfer.read('Fixture',c.id).files.length,3);
});
test('成果物専用フォルダの正本と共有原本は自動で片付けない',t=>{
 const f=fixture(t),c=f.child('調査',f.parent.id,false);fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 const canonical=f.write(path.join(f.dir,'成果物',c.id,'result.txt'),'canonical');const d=f.preview();
 assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{...cleanupReview(d.items[0]),project:'Fixture',task:c.id}]}).complete,true);
 assert.equal(fs.readFileSync(canonical,'utf8'),'canonical');assert.equal(f.transfer.read('Fixture',c.id).files[0].to,canonical);
});
test('同内容を受領中に正本が変わると上書き・片付けせず再開も止める',t=>{
 const f=fixture(t),c=f.child('調査',f.parent.id,false);const canonical=f.write(path.join(f.dir,'成果物','result.txt'),'調査 report');
 const continuation=f.transfer.continue.bind(f.transfer);f.transfer.continue=r=>{fs.writeFileSync(canonical,'changed');continuation(r);};
 assert.throws(()=>f.apply(f.preview()),/上書きしません/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(fs.readFileSync(canonical,'utf8'),'changed');
 f.transfer.continue=continuation;f.restart();assert.throws(()=>f.apply(f.preview()),/上書きしません/);assert.ok(f.store.taskFile('Fixture',c.id));
});
test('同内容2成果も内部配置ごと保持し、内容は全件受領記録で保持する',t=>{
 const f=fixture(t),c=f.child('調査',f.parent.id,false);f.write(path.join(f.dir,'作業',c.id,'same.txt'),'調査 report');
 assert.equal(f.apply(f.preview()).complete,true);const r=f.transfer.read('Fixture',c.id);assert.equal(r.files.length,2);assert.notEqual(r.files[0].to,r.files[1].to);assert.equal(fs.readFileSync(r.files[0].to,'utf8'),'調査 report');
});

// v4.72.0 独立指摘の実行可能な一式と旧部分引渡しを回帰検証。
const integrateAll=f=>{const d=f.preview();return f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({...cleanupReview(i),project:i.project,task:i.task}))});};
for(const existing of ['scattered','bundle','wrong-mode'])test('成果一式の同内容config・配置・実行権限を保持：'+existing,t=>{
 const f=fixture(t),c=f.child('一式',f.parent.id,false),base=path.join(f.dir,'作業',c.id);
 fs.unlinkSync(path.join(base,'report.txt'));
 const main=f.write(path.join(base,'bundle/main.cjs'),"#!/usr/bin/env node\nconsole.log(require('./a/config.json').ok,require('./b/config.json').ok);\n");fs.chmodSync(main,0o755);
 f.write(path.join(base,'bundle/a/config.json'),'{"ok":true}');f.write(path.join(base,'bundle/b/config.json'),'{"ok":true}');
 const candidates=f.preview().items[0].files;
 const canonical=path.join(f.dir,'成果物','canonical');
 if(existing==='scattered')f.write(path.join(canonical,'random.json'),'{"ok":true}');
 else for(const item of candidates){const copy=f.write(path.join(canonical,item.location,item.relative),fs.readFileSync(item.path));fs.chmodSync(copy,existing==='wrong-mode'?0o600:item.mode);}
 assert.equal(integrateAll(f).complete,true);
 const r=f.transfer.read('Fixture',c.id),program=r.files.find(x=>x.relative.endsWith('main.cjs'));
 assert.equal(execFileSync(program.to,[],{encoding:'utf8'}).trim(),'true true');assert.equal(fs.statSync(program.to).mode & 0o777,0o755);
 assert.equal(new Set(r.files.map(x=>x.to)).size,3);assert.equal(fs.existsSync(base),false);
 assert.equal(r.files.every(x=>x.existing),existing==='bundle');
 if(existing==='bundle')assert.equal(fs.existsSync(r.destination),false);
});
for(const extra of ['original-and-late','hidden','empty-directory'])test('旧部分引渡しは未受領内容を専用フォルダに残す：'+extra,t=>{
 const f=fixture(t),c=f.child('旧引渡し',f.parent.id,false),base=path.join(f.dir,'作業',c.id),report=path.join(base,'report.txt');
 if(extra==='original-and-late')f.write(path.join(base,'reference-original.txt'),'original');
 const offer=f.transfer.offerPreview('Fixture',c.id,['作業/'+c.id+'/report.txt']);f.transfer.offer({project:'Fixture',task:c.id,token:offer.token,selected:offer.selected,confirm:true});
 if(extra==='original-and-late')f.write(path.join(base,'late-result.txt'),'late');
 if(extra==='hidden')f.write(path.join(base,'.original'),'hidden');
 if(extra==='empty-directory')fs.mkdirSync(path.join(base,'empty'));
 const before=require('../lib/remove').snapshot(base),d=f.preview(),i=d.items[0];
 assert.deepEqual(i.blockers,[]);assert.deepEqual(i.optional,[]);assert.ok(i.keep.some(x=>x.path===base&&/未受領/.test(x.why)));
 assert.equal(integrateAll(f).complete,true);assert.equal(require('../lib/remove').snapshot(base),before);
 const receipt=f.transfer.read('Fixture',c.id);assert.deepEqual(receipt.files.map(x=>x.path),[report]);
 const cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json')));assert.ok(!cleanup.entries.some(x=>x.from===base));
});
for(const point of ['before-copy','after-notify','cleanup-saved'])test('途中再開でも後追加の未受領内容を退避しない：'+point,t=>{
 const f=fixture(t),c=f.child('途中',f.parent.id,false),base=path.join(f.dir,'作業',c.id),late=path.join(base,'late.txt');
 const run=f.transfer.continue.bind(f.transfer),save=f.transfer.save.bind(f.transfer);let interrupted=false;
 if(point==='before-copy')f.transfer.continue=r=>{f.write(late,'late');throw Error('fixture stop');};
 if(point==='after-notify')f.transfer.beforeCleanup=()=>{f.write(late,'late');throw Error('fixture stop');};
 if(point==='cleanup-saved')f.transfer.save=r=>{save(r);if(r.cleanup&&!interrupted){interrupted=true;f.write(late,'late');throw Error('fixture stop');}};
 assert.throws(()=>integrateAll(f),/fixture stop/);f.transfer.continue=run;f.transfer.save=save;f.restart();
 assert.throws(()=>f.apply(f.preview()),/管理ファイルが変わ|未受領/);
 assert.equal(fs.readFileSync(late,'utf8'),'late');assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
});
test('旧版の危険な退避予定を持つ受領も再開前に停止して保持',t=>{
 const f=fixture(t),c=f.child('旧途中',f.parent.id,false),base=path.join(f.dir,'作業',c.id);
 const run=f.transfer.continue.bind(f.transfer);f.transfer.continue=()=>{throw Error('fixture stop');};
 assert.throws(()=>integrateAll(f),/fixture stop/);
 const r=f.transfer.read('Fixture',c.id);delete r.files[0].mode;f.transfer.save(r);f.write(path.join(base,'unreceived.txt'),'original');
 f.transfer.continue=run;f.restart();assert.throws(()=>f.apply(f.preview()),/管理ファイルが変わ/);
 assert.equal(fs.readFileSync(path.join(base,'unreceived.txt'),'utf8'),'original');assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const point of ['source-mode','saved-mode','saved-content'])test('権限変更・保存先変更も退避前に停止：'+point,t=>{
 const f=fixture(t),c=f.child('権限',f.parent.id,false),source=path.join(f.dir,'作業',c.id,'report.txt');
 if(point==='source-mode'){
  const offer=f.transfer.offerPreview('Fixture',c.id);fs.chmodSync(source,0o700);
  assert.throws(()=>f.transfer.offer({project:'Fixture',task:c.id,token:offer.token,selected:offer.selected,confirm:true}),/成果ファイルが変わ/);
 }else{
  f.transfer.beforeCleanup=r=>{if(point==='saved-mode')fs.chmodSync(r.files[0].to,0o700);else fs.writeFileSync(r.files[0].to,'changed');};
  assert.throws(()=>integrateAll(f),/成果が変更/);
 }
 assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(fs.readFileSync(source,'utf8'),'権限 report');
});
test('旧版で同内容の別パスを潰した受領は再開せず原物を保持',t=>{
 const f=fixture(t),c=f.child('旧配置',f.parent.id,false),base=path.join(f.dir,'作業',c.id);f.write(path.join(base,'same.txt'),'旧配置 report');
 const run=f.transfer.continue.bind(f.transfer);f.transfer.continue=()=>{throw Error('fixture stop');};assert.throws(()=>integrateAll(f),/fixture stop/);
 const r=f.transfer.read('Fixture',c.id);r.files[1].to=r.files[0].to;r.files[1].existing=true;f.transfer.save(r);
 f.transfer.continue=run;f.restart();assert.throws(()=>f.apply(f.preview()),/旧受領の一式配置/);
 assert.ok(fs.existsSync(path.join(base,'same.txt')));assert.ok(f.store.taskFile('Fixture',c.id));
});

// v4.72.1 独立残件：pluginsの余分な内容が実際の実行結果を変える。
function pluginBundle(t){
 const f=fixture(t),c=f.child('plugins一式',f.parent.id,false),base=path.join(f.dir,'作業',c.id);
 fs.unlinkSync(path.join(base,'report.txt'));
 const main=f.write(path.join(base,'bundle/main.cjs'),"#!/usr/bin/env node\nconsole.log(require('node:fs').readdirSync(require('node:path').join(__dirname,'plugins')).sort().join(','));\n");fs.chmodSync(main,0o755);
 f.write(path.join(base,'bundle/plugins/current.json'),'{}');
 const canonical=path.join(f.dir,'成果物','older-copy');
 for(const item of f.preview().items[0].files){const copy=f.write(path.join(canonical,item.location,item.relative),fs.readFileSync(item.path));fs.chmodSync(copy,item.mode);}
 const savedBase=path.join(canonical,'project','作業',c.id,'bundle');
 return {...f,c,base,savedBase};
}
for(const extra of ['obsolete','hidden','empty','link','missing','mode','content'])test('一式の全件集合が違う旧正本は再利用せず保持：'+extra,t=>{
 const f=pluginBundle(t),oldMain=path.join(f.savedBase,'main.cjs');
 if(extra==='obsolete')f.write(path.join(f.savedBase,'plugins/obsolete.json'),'old');
 if(extra==='hidden')f.write(path.join(f.savedBase,'plugins/.old'),'old');
 if(extra==='empty')fs.mkdirSync(path.join(f.savedBase,'empty'));
 if(extra==='link')fs.symlinkSync(oldMain,path.join(f.savedBase,'plugins/linked'));
 if(extra==='missing')fs.unlinkSync(path.join(f.savedBase,'plugins/current.json'));
 if(extra==='mode')fs.chmodSync(oldMain,0o700);
 if(extra==='content')fs.writeFileSync(oldMain,'old');
 assert.equal(integrateAll(f).complete,true);
 const r=f.transfer.read('Fixture',f.c.id),program=r.files.find(x=>x.relative.endsWith('main.cjs'));
 assert.ok(r.files.every(x=>!x.existing));assert.equal(execFileSync(program.to,[],{encoding:'utf8'}).trim(),'current.json');
 assert.equal(fs.statSync(program.to).mode & 0o777,0o755);assert.ok(fs.existsSync(oldMain));
 if(extra==='obsolete')assert.equal(execFileSync(oldMain,[],{encoding:'utf8'}).trim(),'current.json,obsolete.json');
 if(extra==='link')assert.ok(fs.lstatSync(path.join(f.savedBase,'plugins/linked')).isSymbolicLink());
 if(extra==='empty')assert.ok(fs.statSync(path.join(f.savedBase,'empty')).isDirectory());
});
test('一式が全件一致なら正本を再利用して動作と権限を保持',t=>{
 const f=pluginBundle(t);assert.equal(integrateAll(f).complete,true);
 const r=f.transfer.read('Fixture',f.c.id),program=r.files.find(x=>x.relative.endsWith('main.cjs'));
 assert.ok(r.files.every(x=>x.existing));assert.equal(fs.existsSync(r.destination),false);
 assert.equal(execFileSync(program.to,[],{encoding:'utf8'}).trim(),'current.json');assert.equal(fs.statSync(program.to).mode & 0o777,0o755);
 assert.ok(fs.existsSync(f.savedBase));assert.equal(fs.existsSync(f.base),false);
});
for(const point of ['before-cleanup','resume','legacy-resume','cleanup-saved'])for(const change of ['add','delete'])test('一式の保存先増減は退避前・再開で停止：'+point+'/'+change,t=>{
 const f=pluginBundle(t),modify=()=>change==='add'?f.write(path.join(f.savedBase,'plugins/obsolete.json'),'old'):fs.unlinkSync(path.join(f.savedBase,'plugins/current.json'));
 if(point==='before-cleanup')f.transfer.beforeCleanup=modify;
 else if(point==='cleanup-saved'){
  const save=f.transfer.save.bind(f.transfer);let stopped=false;
  f.transfer.save=r=>{save(r);if(r.cleanup&&!stopped){stopped=true;modify();throw Error('fixture stop');}};
 }else f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};
 assert.throws(()=>integrateAll(f),point==='before-cleanup'?/一式|成果が変更/:/fixture stop/);
 if(point!=='before-cleanup'){
  if(point!=='cleanup-saved')modify();
  if(point==='legacy-resume'){const r=f.transfer.read('Fixture',f.c.id);delete r.bundles;f.transfer.save(r);}
  f.transfer.beforeCleanup=()=>{};f.restart();assert.throws(()=>f.apply(f.preview()),/一式|成果が変更/);
 }
 assert.equal(f.transfer.read('Fixture',f.c.id).complete,false);assert.ok(fs.existsSync(f.base));assert.ok(f.store.taskFile('Fixture',f.c.id));
 assert.equal(fs.readFileSync(path.join(f.base,'bundle/plugins/current.json'),'utf8'),'{}');
});
for(const target of ['source','new-copy'])test('新規コピーでも一式内の後追加を片付け前に検知：'+target,t=>{
 const f=pluginBundle(t);f.write(path.join(f.savedBase,'plugins/obsolete.json'),'older');
 f.transfer.beforeCleanup=r=>{const root=target==='source'?path.join(f.base,'bundle'):path.dirname(r.files.find(x=>x.relative.endsWith('main.cjs')).to);f.write(path.join(root,'plugins/late.json'),'late');};
 assert.throws(()=>integrateAll(f),/一式/);assert.ok(fs.existsSync(f.base));assert.ok(f.store.taskFile('Fixture',f.c.id));assert.equal(f.transfer.read('Fixture',f.c.id).complete,false);
});

test('新規コピーは一式のディレクトリ権限も保持',t=>{
 const f=pluginBundle(t);fs.chmodSync(path.join(f.base,'bundle/plugins'),0o750);
 assert.equal(integrateAll(f).complete,true);const r=f.transfer.read('Fixture',f.c.id),program=r.files.find(x=>x.relative.endsWith('main.cjs'));
 assert.ok(r.files.every(x=>!x.existing));assert.equal(fs.statSync(path.join(path.dirname(program.to),'plugins')).mode & 0o777,0o750);
 assert.equal(execFileSync(program.to,[],{encoding:'utf8'}).trim(),'current.json');
});

test('正本そのものの一式は未宣言の原物を間引かず保持',t=>{
 const f=pluginBundle(t),files=f.preview().items[0].files;
 const source=path.join(f.dir,'成果物','original');
 const declarations=[];
 for(const item of files){const rel='成果物/original/'+path.relative(f.base,item.path);const to=f.write(path.join(f.dir,rel),fs.readFileSync(item.path));fs.chmodSync(to,item.mode);declarations.push('- ファイル：'+rel);}
 fs.rmSync(f.base,{recursive:true});f.write(path.join(source,'bundle/.original'),'original');
 f.store.appendSection('Fixture',f.c.id,'成果',declarations.join('\n'));
 assert.equal(integrateAll(f).complete,true);const r=f.transfer.read('Fixture',f.c.id);
 assert.ok(r.files.every(x=>x.existing&&x.to===x.path));assert.equal(fs.readFileSync(path.join(source,'bundle/.original'),'utf8'),'original');
 assert.equal(execFileSync(path.join(source,'bundle/main.cjs'),[],{encoding:'utf8'}).trim(),'current.json');
});

function retainedApply(f,d,overrides={}){return f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({project:i.project,task:i.task,review:{...i.review,confirmed:true,evidence:'独立確認済み',undecided:'未採用PR',residual:'後で検討'},...overrides}))});}
for(const kind of ['なし','ファイル','本体保存済み'])test('継続受領後も末尾の成果宣言と完了検査を保持：'+kind,t=>{
 const f=fixture(t),c=f.child('成果欄を保持'),file=f.store.taskFile('Fixture',c.id);
 const value=kind==='なし'?'確認のみ':kind==='ファイル'?`作業/${c.id}/report.txt（確認結果）`:`.@${sh(f.body,'rev-parse','HEAD')}（保存済み）`;
 fs.appendFileSync(file,`\n## 成果\n- ${kind}：${value}\n`);
 const {readResults}=require('../lib/task-results'),before=readResults(file);
 assert.equal(retainedApply(f,f.preview()).complete,true);
 assert.deepEqual(readResults(file),before);
 const kept=f.store.readTask(file),p=f.store.readProject('Fixture');
 assert.equal(f.transfer.resultIssue(p,kept).ok,true);
 assert.equal(kept.continuation,true);assert.equal(kept.workdir,c.workdir);assert.equal(kept.question,c.question);
 assert.equal(f.transfer.read('Fixture',c.id).retained,true);
 assert.ok(fs.readFileSync(file,'utf8').split('## やったこと\n')[1].split(/\n## /)[0].includes('成果を受領し作業を継続'));
});
test('継続受領は未済手順・質問・子孫・原文・コピーを保持する',t=>{
 const f=fixture(t),c=f.child('継続');f.store.setStep('Fixture',c.id,0,false);f.store.updateTask('Fixture',c.id,{question:'次の採用判断'});const grand=f.child('孫',c.id,false),log=chat.append(f.dir,c.id,{role:'user',text:'元の会話'});
 const d=f.preview([{project:'Fixture',task:c.id}]);assert.equal(d.items.length,1);assert.equal(d.items[0].blockers.length,0);
 const out=retainedApply(f,d);assert.equal(out.complete,true);assert.equal(out.items[0].state,'保持受領済み');assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',grand.id));assert.deepEqual(chat.read(f.dir,c.id),[log]);
 const kept=f.store.readTask(f.store.taskFile('Fixture',c.id));assert.equal(kept.steps[0].done,false);assert.equal(kept.question,'次の採用判断');assert.equal(kept.workdir,c.workdir);assert.equal(kept.completionPending,false);assert.equal(f.transfer.read('Fixture',c.id).retained,true);assert.equal(fs.existsSync(path.join(f.root,'Trash')),false);
});
test('末尾の成果宣言を継続受領メモで壊さず、完了ゲートと次の統合が通る',t=>{
 const f=fixture(t),c=f.child('成果末尾'),file=f.store.taskFile('Fixture',c.id);
 f.store.appendSection('Fixture',c.id,'成果','- なし：配布ファイルなし（コードはcopy）');
 const {readResults}=require('../lib/task-results'),{ResultsGate}=require('../lib/results-gate');
 const before=readResults(file);assert.equal(before.length,1);
 assert.equal(retainedApply(f,f.preview()).complete,true);
 assert.deepEqual(readResults(file),before);
 const kept=f.store.readTask(file),all=f.store.listProjects(),p=all.find(p=>p.id==='Fixture');
 assert.match(kept.done,/成果を受領し作業を継続/);assert.equal(kept.workdir,c.workdir);
 assert.equal(f.transfer.resultIssue(p,kept).ok,true);
 assert.equal(new ResultsGate({store:f.store,transfer:f.transfer}).approvalIssue(p,kept,all).ok,true);
 assert.deepEqual(f.preview().items,[]); // 受領済みの同じ成果は未受領一覧に出さない。
 f.write(path.join(c.workdir,'additional.txt'),'次の保存済み成果');git.save(c.workdir,'increment');
 const next=f.preview();assert.equal(next.items.length,1);assert.deepEqual(next.items[0].blockers,[]);
 assert.equal(retainedApply(f,next).complete,true);assert.deepEqual(readResults(file),before);
});
test('保持受領の重複は通知せず、増分は履歴を保全して一度だけ受領',t=>{
 const f=fixture(t),c=f.child('継続'),first=retainedApply(f,f.preview()),receipt=f.transfer.read('Fixture',c.id),head=sh(f.body,'rev-parse','HEAD');
 retainedApply(f,f.preview());assert.equal(chat.read(f.dir,f.parent.id).filter(r=>r.handoff).length,1);assert.equal(f.transfer.read('Fixture',c.id).id,receipt.id);assert.equal(sh(f.body,'rev-parse','HEAD'),head);
 f.write(path.join(c.workdir,'additional.txt'),'次の差分');git.save(c.workdir,'increment');retainedApply(f,f.preview());
 const next=f.transfer.read('Fixture',c.id);assert.notEqual(next.id,receipt.id);assert.equal(next.previous,receipt.id);assert.equal(chat.read(f.dir,f.parent.id).filter(r=>r.handoff).length,2);assert.equal(JSON.parse(fs.readFileSync(path.join(f.transfer.dir,'history',receipt.id+'.json'),'utf8')).id,receipt.id);assert.ok(fs.existsSync(c.workdir));
});
test('保存していないコードと残件の片付けを拒否する',t=>{
 const f=fixture(t),c=f.child('継続');f.write(path.join(c.workdir,'dirty.txt'),'未保存');assert.match(f.preview().items[0].blockers.join(' '),/保存/);git.save(c.workdir,'save');const d=f.preview();assert.throws(()=>retainedApply(f,d,{disposition:'cleanup'}),/残件/);assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const failure of ['task-rename','receipt-save'])test('継続記録の途中保存を復旧し、稼働中の再開と二重通知を防ぐ：'+failure,t=>{
 const f=fixture(t),c=f.child('復旧',f.parent.id,false),file=f.store.taskFile('Fixture',c.id),before=fs.readFileSync(file,'utf8');
 const save=f.transfer.save.bind(f.transfer),rename=fs.renameSync;let injected=false;
 f.transfer.save=r=>{if(failure==='receipt-save'&&r.retained&&r.complete&&!injected){injected=true;throw Error('fixture retention stop');}save(r);};
 fs.renameSync=(from,to)=>{if(failure==='task-rename'&&to===file&&!injected){injected=true;throw Error('fixture retention stop');}return rename(from,to);};
 try{assert.throws(()=>retainedApply(f,f.preview()),/fixture retention stop/);}finally{fs.renameSync=rename;f.transfer.save=save;}
 let receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.complete,false);assert.ok(receipt.retention);
 const stopped=fs.readFileSync(file,'utf8');if(failure==='task-rename')assert.equal(stopped,before);
 const busy=f.removal.busy;f.removal.busy=(p,id)=>id===c.id;
 assert.throws(()=>f.transfer.continue(receipt),/稼働中/);assert.equal(fs.readFileSync(file,'utf8'),stopped);f.removal.busy=busy;
 f.restart();assert.equal(f.apply(f.preview()).complete,true);receipt=f.transfer.read('Fixture',c.id);assert.equal(receipt.complete,true);assert.equal(receipt.retained,true);
 assert.equal(chat.read(f.dir,f.parent.id).filter(r=>r.handoff).length,1);assert.equal((fs.readFileSync(file,'utf8').match(/成果を受領し作業を継続/g)||[]).length,1);assert.ok(fs.existsSync(file));
});

// Rejected confirmation is editable with the same preview; rejection never starts a receipt.
test('確認不足・空欄・長過ぎ入力は予約前に拒否し、同じtokenで修正後だけ一度受領する',t=>{
 const f=fixture(t),c=f.child('確認ループ'),d=f.preview(),i=d.items[0];
 const send=review=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{project:i.project,task:i.task,disposition:'continue',review}]});
 const valid={...i.review,confirmed:true,evidence:'人が確認',residual:'残件を保持',undecided:'未採用PR'};
 const before={head:git.inspect(f.body).head,task:fs.readFileSync(f.store.taskFile('Fixture',c.id),'utf8'),messages:chat.read(f.dir,f.parent.id)};
 for(const review of [{...valid,confirmed:false},{...valid,sourceHead:'different'},...['scope','planned','undecided','residual','evidence'].flatMap(k=>[{...valid,[k]:'  '},{...valid,[k]:'字'.repeat(10001)}])]){
  assert.throws(()=>send(review),/確認してください|記入してください/);
  assert.equal(f.integrate.read('Fixture',f.parent.id),null);assert.equal(f.transfer.read('Fixture',c.id),null);
  assert.equal(git.inspect(f.body).head,before.head);assert.equal(fs.readFileSync(f.store.taskFile('Fixture',c.id),'utf8'),before.task);assert.deepEqual(chat.read(f.dir,f.parent.id),before.messages);
 }
 assert.equal(send(valid).complete,true);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);assert.ok(f.store.taskFile('Fixture',c.id));
 // Reusing the accepted token cannot create another receipt.
 const receipt=f.transfer.read("Fixture",c.id).id,head=git.inspect(f.body).head;
 assert.equal(send(valid).complete,true);assert.equal(f.transfer.read("Fixture",c.id).id,receipt);assert.equal(git.inspect(f.body).head,head);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

test('期限切れのtokenは確認済みでも受領せず、新しい確認でのみ進む',t=>{
 const f=fixture(t),c=f.child('期限'),d=f.preview();f.integrate.tokens.get(d.token).at=Date.now()-600001;
 assert.throws(()=>retainedApply(f,d),/もう一度統合内容/);assert.equal(f.integrate.read('Fixture',f.parent.id),null);assert.equal(f.transfer.read('Fixture',c.id),null);
 assert.equal(retainedApply(f,f.preview()).complete,true);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

test('自動開始は残件未知の子を保持し、受領済み衝突の再依頼を拒否',t=>{
 const f=fixture(t),c=f.child('申告無し');const d=f.preview();
 assert.equal(d.items[0].remaining.status,'不明');const out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,thenMain:false,selected:[{project:'Fixture',task:c.id}]});
 assert.equal(out.complete,true);assert.equal(out.items[0].state,'保持受領済み');assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));
 const record=f.integrate.read('Fixture',f.parent.id);assert.equal(record.auto.scope[0].disposition,'continue');assert.equal(record.items[0].review.residual,'未確認');
});
test('自動開始の残件なし申告は片付け、確認中の申告変更は拒否',t=>{
 const f=fixture(t),c=f.child('申告済み');const file=f.store.taskFile('Fixture',c.id);
 fs.appendFileSync(file,'\n## 残件申告\n```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'独立合格'})+'\n```\n');
 const d=f.preview();assert.equal(d.items[0].remaining.status,'なし');fs.appendFileSync(file,'\n追加変更\n');assert.throws(()=>f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,selected:[{project:'Fixture',task:c.id}]}),/子作業|変わりました/);
 const next=f.preview();const out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:next.token,confirm:true,auto:true,thenMain:false,selected:[{project:'Fixture',task:c.id}]});assert.equal(out.items[0].state,'片付け済み');assert.equal(f.store.taskFile('Fixture',c.id),null);
});

test('古い衝突は保存済み祖先から受領待ちへ表示を更新し再解消委任を拒否',t=>{
 const f=fixture(t),c=f.child('表示が古い子'),d=f.preview(),i=d.items[0];
 const run=f.integrate.run;f.integrate.run=r=>({partial:true,conflict:true});
 try{f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{project:'Fixture',task:c.id,disposition:'continue',review:{...i.review,confirmed:true,evidence:'確認済み'}}]});}finally{f.integrate.run=run;}
 const r=f.integrate.read('Fixture',f.parent.id);r.items[0].state='衝突';r.items[0].conflictPaths=['obsolete.txt'];r.items[0].conflictKind='content';f.integrate.save(r);
 git.merge({dir:c.workdir,workRoot:f.removal.workRoot({id:'Fixture'}),title:'saved',target:f.body,cleanup:false});
 const next=f.preview();assert.equal(next.items[0].codeAlready,true);assert.equal(next.items[0].state,'取り込み済み（受領待ち）');assert.equal(next.items[0].conflictPaths,undefined);
 assert.throws(()=>f.integrate.conflictRequest({project:'Fixture',task:f.parent.id,childProject:'Fixture',childTask:c.id,token:next.token}),/コードは取り込み済み/);
 assert.equal(f.apply(next).complete,true);assert.ok(f.store.taskFile('Fixture',c.id));
});

test('実Gitの自動統合：衝突保存→独立合格→正式受領→保持本体取り込みを一度で完走',async t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 const c=f.child('自動解消');f.write(path.join(w.dir,'base.txt'),'parent\n');git.save(w.dir,'parent change');f.write(path.join(c.workdir,'base.txt'),'child\n');git.save(c.workdir,'child change');
 const d=f.preview(),out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,auto:true,selected:[{project:'Fixture',task:c.id}]});assert.equal(out.conflict,true);assert.equal(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).question,'');
 const issues=[];let mains=0;const {IntegrateAuto}=require('../lib/integrate-auto'),auto=new IntegrateAuto({integrate:f.integrate,busy:()=>false,dispatch:async r=>issues.push(r),mergeMain:async()=>{mains++;const merged=git.merge({dir:w.dir,workRoot:f.removal.workRoot({id:'Fixture'}),target:f.body,cleanup:false});return {...merged,retained:true};}});auto.pendingRequest=()=>true;
 await auto.tick();assert.equal(issues.length,1);const k=Object.keys(f.integrate.read('Fixture',f.parent.id).auto.attempts)[0];
 try{sh(w.dir,'merge','--no-ff','--no-edit',git.inspect(c.workdir).head);}catch{}f.write(path.join(w.dir,'base.txt'),'parent\nchild\n');sh(w.dir,'add','.');sh(w.dir,'commit','-qm','preserve both');
 auto.settled({project:'Fixture',task:f.parent.id,text:`[integration-auto:${k}:code]`},{text:'双方の意味を保存'});await auto.tick();assert.equal(issues.length,2);assert.equal(f.transfer.read('Fixture',c.id).complete,undefined);
 auto.settled({project:'Fixture',task:f.parent.id,text:`[integration-auto:${k}:review]`},{text:`[integration-review:${k}:pass]`,integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,request:f.integrate.read('Fixture',f.parent.id).auto.attempts[k].delivery.request,resumed:false}}});await auto.tick();await auto.tick();
 const r=f.integrate.read('Fixture',f.parent.id);assert.equal(r.complete,true);assert.equal(r.items[0].state,'保持受領済み');assert.equal(r.auto.main.state,'done');assert.equal(mains,1);assert.equal(issues.length,2);assert.equal(f.integrate.pending().length,0);
 assert.equal(fs.readFileSync(path.join(f.body,'base.txt'),'utf8'),'parent\nchild\n');assert.equal(sh(f.body,'rev-parse','HEAD^{tree}'),sh(w.dir,'rev-parse','HEAD^{tree}'));assert.ok(fs.existsSync(c.workdir));assert.ok(fs.existsSync(w.dir));assert.ok(f.store.taskFile('Fixture',f.parent.id));assert.ok(f.store.taskFile('Fixture',c.id));
});

test('受領済み通知を成果で判定し、空の開始・再起動・確認文変更で再受領しない',t=>{
 const f=fixture(t),c=f.child('通知');retainedApply(f,f.preview());f.restart();
 const receipt=f.transfer.read('Fixture',c.id),record=f.integrate.read('Fixture',f.parent.id),messages=chat.read(f.dir,f.parent.id),head=git.inspect(f.body).head;
 const d=f.preview();assert.equal(d.items.length,0);assert.equal(d.retainedItems.length,1);
 assert.equal(f.transfer.offers().find(x=>x.task===c.id).pending,false);
 const out=f.integrate.apply({project:'Fixture',task:f.parent.id,token:d.token,selected:[{project:'Fixture',task:c.id,disposition:'continue',review:{...d.retainedItems[0].review,confirmed:true,evidence:'別の確認文',residual:'後日',undecided:'別文'}}],confirm:true,auto:false});
 assert.equal(out.noChanges,true);assert.deepEqual(f.transfer.read('Fixture',c.id),receipt);assert.deepEqual(f.integrate.read('Fixture',f.parent.id),record);assert.deepEqual(chat.read(f.dir,f.parent.id),messages);assert.equal(git.inspect(f.body).head,head);
 assert.equal(f.integrate.apply({project:'Fixture',task:f.parent.id,token:f.preview().token,selected:[],confirm:true,auto:true}).noChanges,true);
});
test('受領履歴の無い子は一覧のたびに統合前確認を走らせず、未受領と示す',t=>{
 const f=fixture(t),c=f.child('未受領');
 const spy=()=>{const calls=[],real=f.transfer.offerState;f.transfer.offerState=(p,x,...rest)=>{calls.push(x.id);return real(p,x,...rest);};return calls;};
 let calls=spy();assert.equal(f.transfer.offers().find(x=>x.task===c.id).pending,true);assert.deepEqual(calls,[]);
 retainedApply(f,f.preview());f.restart();
 calls=spy();assert.equal(f.transfer.offers().find(x=>x.task===c.id).pending,false);assert.deepEqual(calls,[c.id]);
});
test('壊れた受領記録は未確認で残し、他の子の通知を妨げない',t=>{
 const f=fixture(t),bad=f.child('壊れた記録',f.parent.id,false),good=f.child('正常な子',f.parent.id,false);
 const file=f.transfer.file('Fixture',bad.id);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'broken');
 const offers=f.transfer.offers();assert.equal(offers.find(x=>x.task===bad.id).pending,true);assert.ok(offers.find(x=>x.task===bad.id).reason);
 assert.equal(offers.find(x=>x.task===good.id).pending,true);assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
for(const [name,patch] of Object.entries({object:{received:{}},string:{received:'bad'},null:{received:null},number:{received:1},boolean:{received:false},element:{received:[null]},targetNull:{received:[{target:null}]},targetString:{received:[{target:'bad'}]},targetMissing:{received:[{}]},targetProject:{received:[{target:{project:1,task:'parent'}}]},targetTask:{received:[{target:{project:'Fixture',task:''}}]},targetDir:{received:[{target:{project:'Fixture',task:'parent',dir:{}}}]}}))test('不正受領履歴は子単位で未確認・原物保持し整理を拒否：'+name,t=>{
 const f=fixture(t),bad=f.child('不正履歴',f.parent.id,false),good=f.child('受領済み正常子',f.parent.id,false);
 retainedApply(f,f.preview());
 const record=f.transfer.read('Fixture',bad.id),file=f.transfer.file('Fixture',bad.id),raw=JSON.stringify({...record,...patch});fs.writeFileSync(file,raw);
 const goodReceipt=f.transfer.read('Fixture',good.id),messages=chat.read(f.dir,f.parent.id),head=git.inspect(f.body).head;
 for(let n=0;n<2;n++){
  const offers=f.transfer.offers(),broken=offers.find(x=>x.task===bad.id),normal=offers.find(x=>x.task===good.id);
  assert.equal(broken.pending,true);assert.equal(broken.received,null);assert.match(broken.reason,/受領履歴/);assert.equal(normal.pending,false);assert.ok(normal.received);
  assert.throws(()=>f.transfer.receiptHistory(f.transfer.read('Fixture',bad.id)),/受領履歴/);
  assert.throws(()=>f.preview(),/受領履歴/); // An unavailable history never yields a cleanup token.
  assert.equal(fs.readFileSync(file,'utf8'),raw);assert.deepEqual(f.transfer.read('Fixture',good.id),goodReceipt);assert.deepEqual(chat.read(f.dir,f.parent.id),messages);assert.equal(git.inspect(f.body).head,head);
  f.restart();
 }
});
for(const change of ['code','file','delete','results','dirty','target','destination','task'])test('追加成果または不明な変更は受領済み通知から除外しない：'+change,t=>{
 const f=fixture(t),c=f.child('追加');retainedApply(f,f.preview());
 if(change==='code'){f.write(path.join(c.workdir,'new.txt'),'new');git.save(c.workdir,'new');}
 if(change==='file')f.write(path.join(f.dir,'作業',c.id,'second.txt'),'new');
 if(change==='delete')fs.unlinkSync(path.join(f.dir,'作業',c.id,'report.txt'));
 if(change==='results')f.store.appendSection('Fixture',c.id,'成果','- なし：追加の分析記録');
 if(change==='dirty')f.write(path.join(c.workdir,'unsaved.txt'),'dirty');
 if(change==='target'){const w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});}
 if(change==='destination'){const r=f.transfer.read('Fixture',c.id);fs.writeFileSync(r.received.flatMap(x=>x.files)[0].to,'changed');}
 if(change==='task')f.store.appendSection('Fixture',c.id,'メモ','未確認の追加作業');
 const d=f.preview();assert.equal(d.items.length,1);assert.equal(f.transfer.offers().find(x=>x.task===c.id).pending,true);if(change==='destination')assert.match(d.items[0].blockers.join(' '),/以前受け取った成果/);
});
test('旧申告なしの受領済み子を根拠付きで片付け、保持本体取込を再発行しない',t=>{
 const f=fixture(t),c=f.child('旧完了');retainedApply(f,f.preview());const d=f.preview(),i=d.retainedItems[0];
 assert.equal(i.needsRemaining,true);assert.equal(i.remaining.status,'不明');
 const selected=[{project:'Fixture',task:c.id,disposition:'cleanup',cleanupAudit:{items:'なし',undecided:'なし',evidence:'独立レビューと保存済み成果・作業本文を照合、未採用判断なし'}}];
 const b={project:'Fixture',task:f.parent.id,token:d.token,selected,auto:true,confirm:true,thenMain:true};
 assert.equal(f.integrate.apply(b).complete,true);assert.equal(f.integrate.read('Fixture',f.parent.id).auto.thenMain,false);assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(fs.existsSync(c.workdir),false);assert.equal(f.integrate.apply(b).duplicate,true);
});
for(const mode of ['steps','question','descendant','declared','evidence','stale','hidden'])test('完了子監査は実残件・更新・隠し原物を保護：'+mode,t=>{
 const f=fixture(t),c=f.child('監査');retainedApply(f,f.preview());
 if(mode==='steps')f.store.setStep('Fixture',c.id,0,false);
 if(mode==='question')f.store.updateTask('Fixture',c.id,{question:'採用待ち'});
 if(mode==='descendant')f.child('未了子孫',c.id,false);
 if(mode==='declared')f.store.appendSection('Fixture',c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実Pro往復',undecided:'なし',evidence:'実残件確認'})+'\n```');
 if(mode==='hidden')f.write(path.join(f.dir,'作業',c.id,'.unreceived'),'hidden original');
 const d=f.preview(),i=[...d.items,...d.retainedItems][0];
 const b={project:'Fixture',task:f.parent.id,token:d.token,selected:[{project:'Fixture',task:c.id,disposition:'cleanup',cleanupAudit:{items:'なし',undecided:'なし',evidence:mode==='evidence'?'未確認':'独立確認済み、成果保存と本文・判断待ちを確認した'}}],auto:true,confirm:true};
 if(mode==='stale')f.store.appendSection('Fixture',c.id,'メモ','新残件');
 if(mode==='hidden'){assert.equal(f.integrate.apply(b).complete,true);assert.equal(fs.readFileSync(path.join(f.dir,'作業',c.id,'.unreceived'),'utf8'),'hidden original');}
 else {assert.throws(()=>f.integrate.apply(b));assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));}
});
