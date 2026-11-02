'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-simple-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(56100+Math.floor(Math.random()*800))});
// Isolate the formal HTTP routes, never launch an AI or apply a main copy.
const {IntegrateAuto}=require('../lib/integrate-auto');let auto;const tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async function(){auto=this;};
const {ChatRunner}=require('../lib/chat');let runner;const queue=ChatRunner.prototype.queue;ChatRunner.prototype.queue=function(...a){runner=this;return queue.apply(this,a);};
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),git=require('../lib/git');
const store=new Store(root),p=store.createProject({name:'Fixture'}).project,parent=store.createTask(p.id,{title:'親'}),child=store.createTask(p.id,{title:'子',parent:parent.id,steps:['実機未確認']});
const body=path.join(root,'Body'),g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();fs.mkdirSync(body);g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');g(body,'add','.');g(body,'commit','-qm','base');
const removal=new Removal({store}),pw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:parent.id}),cw=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:child.id});store.updateTask(p.id,parent.id,{workdir:pw.dir});store.updateTask(p.id,child.id,{workdir:cw.dir});fs.writeFileSync(path.join(cw.dir,'child'),'child');git.save(cw.dir,'child');
store.appendSection(p.id,child.id,'成果','- なし：保存コードのみ');store.appendSection(p.id,child.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:'fixture'})+'\n```');
const parentHead=git.inspect(pw.dir).head,bodyHead=git.inspect(body).head,runtime=require('../server'),server=runtime.server;let base;
const post=(route,b={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify({project:p.id,task:parent.id,...b})});
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;await new Promise(setImmediate);});
test.after(async()=>{runner?.running.clear();server.closeAllConnections();await new Promise(r=>server.close(r));IntegrateAuto.prototype.tick=tick;ChatRunner.prototype.queue=queue;fs.rmSync(tmp,{recursive:true,force:true});});
test('要約開始の旧統合判定HTTP：現本体包含を照合して許可し、未確認・未完了・引渡しを拒否',async t=>{
 const projectFile=path.join(p.dir,'PROJECT.md'),projectBefore=fs.readFileSync(projectFile,'utf8');fs.writeFileSync(projectFile,projectBefore.replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));t.after(()=>fs.writeFileSync(projectFile,projectBefore));
 const par=store.createTask(p.id,{title:'旧本体反映後の要約'}),other=store.createTask(p.id,{title:'独立した別作業'}),h=runtime.taskIntegrate;
 const {TaskHistory}=require('../lib/task-history'),originalStart=TaskHistory.prototype.autoStart,originalSend=runtime.chats.send;
 let starts=0,sends=0;
 // Exercise the real server busy/idle admission. Stop at the selection boundary;
 // no summary, rotation or AI process is run by this HTTP fixture.
 TaskHistory.prototype.autoStart=function(project,task){this.idle(project,task);starts++;return {id:require('node:crypto').randomUUID()};};
 runtime.chats.send=()=>{sends++;throw Error('No AI allowed in admission fixture');};
 t.after(()=>{TaskHistory.prototype.autoStart=originalStart;runtime.chats.send=originalSend;});
 const record={id:require('node:crypto').randomUUID(),project:p.id,task:par.id,complete:true,items:[{state:'受領済み'},{state:'片付け済み'}],auto:{thenMain:false,main:{state:'done',skipped:true},pendingMain:{id:require('node:crypto').randomUUID(),main:{state:'intent',sourceHead:bodyHead},stopped:{reason:'old failure'}}}};
 const status=async task=>{const res=await fetch(base+'/api/task/history/status?'+new URLSearchParams({project:p.id,task,selection:'0'}),{headers:{'X-Hub':'1'}});assert.equal(res.status,200);return res.json();};
 const request=async task=>{const s=await status(task),res=await post('/api/task/continue',{task,generation:s.generation,revision:s.revision,requestId:require('node:crypto').randomUUID(),confirm:true,automatic:true});return {s,status:res.status,out:await res.json()};};
 h.save(record);const bytes=fs.readFileSync(h.file(p.id,par.id)),index=g(body,'rev-parse','--path-format=absolute','--git-path','index'),indexBytes=fs.readFileSync(index);
 await t.test('反映済みの過去intentは履歴を残して開始判定を通過',async()=>{const d=await request(par.id);assert.equal(d.s.reason,'');assert.equal(d.status,200,JSON.stringify(d.out));assert.equal(d.out.pending,true);assert.equal(starts,1);assert.equal(sends,0);assert.deepEqual(fs.readFileSync(h.file(p.id,par.id)),bytes);assert.deepEqual(fs.readFileSync(index),indexBytes);assert.equal(h.pending().find(r=>r.task===par.id).mainPending.main.state,'intent');});
 // Each rejected case has a fresh request ID; remove only this isolated fixture's
 // admitted reservation so duplicate-request protection cannot mask busy checks.
 const history=new TaskHistory({store});fs.unlinkSync(history.continueFile(p.id,par.id));
 const unapplied=g(body,'commit-tree',g(body,'rev-parse','HEAD^{tree}'),'-p',bodyHead,'-m','same tree but not applied');
 for(const [name,mutate] of [['未反映の同内容commit',r=>r.auto.pendingMain.main.sourceHead=unapplied],['不明なcommit',r=>r.auto.pendingMain.main.sourceHead='f'.repeat(40)],['作業不一致',r=>r.task=other.id],['未完了の子受領',r=>{r.complete=false;r.items[0].state='確認待ち';}],['現在の本体反映待ち',r=>{r.auto.thenMain=true;r.auto.main.state='intent';}],['旧記録の送信結果不明',r=>r.auto.pendingMain.main.state='unknown']])await t.test(name,async()=>{
  const r=structuredClone(record);mutate(r);fs.writeFileSync(h.file(p.id,par.id),JSON.stringify(r));const before=fs.readFileSync(h.file(p.id,par.id));
  const d=await request(par.id);assert.ok(d.s.reason);assert.equal(d.status,409);assert.equal(d.out.stage,'not-started');assert.equal(starts,1);assert.deepEqual(fs.readFileSync(h.file(p.id,par.id)),before);assert.equal((await status(other.id)).reason,'','another task is not blocked');
 });
 h.save(record);
 await t.test('本体の衝突中は開始しない',async()=>{
  const branch=g(body,'branch','--show-current');g(body,'checkout','-qb','summary-conflict');g(body,'commit','--allow-empty','-qm','pending merge');g(body,'checkout','-q',branch);g(body,'merge','--no-ff','--no-commit','summary-conflict');
  try{const d=await request(par.id);assert.equal(d.status,409);assert.match(d.s.reason,/確認できません/);assert.equal(starts,1);}finally{g(body,'merge','--abort');}
 });
 await t.test('成果の引渡しは反映済み本体とは別に拒否',async()=>{
  const f=path.join(root,'_hub/task-handoffs',require('node:crypto').createHash('sha256').update(p.id+'\0'+other.id).digest('hex')+'.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify({project:p.id,task:other.id,targetProject:p.id,targetTask:par.id,complete:false}));
  try{const d=await request(par.id);assert.equal(d.status,409);assert.match(d.s.reason,/引渡し.*完了してから/);assert.ok((await status(other.id)).reason);}finally{fs.unlinkSync(f);}
 });
 await t.test('定期読取はGit照合を追加せず、AI作業中の保護も維持',async()=>{
  const inspect=git.inspect;let calls=0;git.inspect=(...a)=>{calls++;return inspect(...a);};
  try{for(const route of ['/api/task/history/auto','/api/task/continue/status']){const res=await fetch(base+route+'?'+new URLSearchParams({project:p.id,task:par.id}),{headers:{'X-Hub':'1'}});assert.equal(res.status,200);}h.pending();assert.equal(calls,0);
   runtime.chats.running.set(p.id+'\0'+par.id,{ai:'codex'});const d=await request(par.id);assert.equal(d.status,409);assert.equal(d.out.code,'target-ai');assert.equal(starts,1);
  }finally{git.inspect=inspect;runtime.chats.running.clear();}
 });
 assert.equal(sends,0);assert.deepEqual(fs.readFileSync(h.file(p.id,par.id)),bytes);assert.equal(g(body,'rev-parse','HEAD'),bodyHead);
});
test('正式preview二経路は旧本体反映の表示証拠だけ返し、dirtyと記録不明では反映済みにしない',async t=>{
 const projectFile=path.join(p.dir,'PROJECT.md'),projectBefore=fs.readFileSync(projectFile,'utf8');fs.writeFileSync(projectFile,projectBefore.replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));t.after(()=>fs.writeFileSync(projectFile,projectBefore));
 const par=store.createTask(p.id,{title:'通知確認の親'}),w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:par.id});store.updateTask(p.id,par.id,{workdir:w.dir});
 const pending={id:'old',main:{state:'intent',sourceHead:bodyHead},stopped:{reason:'old failure'}};
 const record={id:require('node:crypto').randomUUID(),project:p.id,task:par.id,complete:true,items:[],auto:{mode:'single',thenMain:false,main:{state:'done',skipped:true},pendingMain:pending}};
 const {TaskIntegrate}=require('../lib/task-integrate'),{TaskTransfer}=require('../lib/task-transfer');const h=new TaskIntegrate({store,removal,transfer:new TaskTransfer({store,removal}),baseOf:()=>body});h.save(record);
 const read=()=>fs.readFileSync(h.file(p.id,par.id),'utf8');const before=read();
 const main=async()=>{const res=await fetch(base+'/api/task/preview?project='+encodeURIComponent(p.id)+'&task='+par.id,{headers:{'X-Hub':'1'}});assert.equal(res.status,200);return res.json();};
 const simple=async()=>{const res=await post('/api/task/integrate/preview',{task:par.id,simple:true});assert.equal(res.status,200);return res.json();};
 for(const preview of [main,simple]){const d=await preview();assert.equal(d.mainDisplay.reflected,true);assert.equal(d.mainDisplay.key,JSON.stringify(pending));assert.equal(read(),before);}
 const dirty=path.join(body,'notice-unsaved');fs.writeFileSync(dirty,'preserved');try{for(const preview of [main,simple]){const d=(await preview()).mainDisplay;assert.equal(d.reflected,true,'unrelated unsaved work keeps the saved history reflected');assert.equal(d.mainUncommitted,1);}}finally{fs.unlinkSync(dirty);}
 assert.equal(read(),before);assert.equal(git.inspect(body).head,bodyHead);
 pending.main.sourceHead='missing';h.save(record);const unknown=read();for(const preview of [main,simple])assert.equal((await preview()).mainDisplay.reflected,false);assert.equal(read(),unknown);
});
test('本体status exit128の正式通常previewは未確認を維持し、復旧clean/dirty/mergeと旧intentを区別',async t=>{
 const projectFile=path.join(p.dir,'PROJECT.md'),projectBefore=fs.readFileSync(projectFile,'utf8');fs.writeFileSync(projectFile,projectBefore.replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));t.after(()=>fs.writeFileSync(projectFile,projectBefore));
 const par=store.createTask(p.id,{title:'status失敗確認の親'}),w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:par.id});store.updateTask(p.id,par.id,{workdir:w.dir});
 const {TaskIntegrate}=require('../lib/task-integrate'),{TaskTransfer}=require('../lib/task-transfer'),h=new TaskIntegrate({store,removal,transfer:new TaskTransfer({store,removal}),baseOf:()=>body});
 const old={id:require('node:crypto').randomUUID(),project:p.id,task:par.id,complete:true,items:[],auto:{thenMain:false,main:{state:'done',skipped:true},pendingMain:{id:'old',main:{state:'intent',sourceHead:bodyHead},stopped:{reason:'preserved'}}}};h.save(old);
 const record=fs.readFileSync(h.file(p.id,par.id)),realGit=execFileSync('/usr/bin/which',['git'],{encoding:'utf8'}).trim(),bin=path.join(tmp,'notice-status-bin'),flag=path.join(bin,'fail-status'),trace=path.join(bin,'trace.jsonl'),oldPath=process.env.PATH;
 fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'git'),'#!'+process.execPath+'\n'+
  'const fs=require("node:fs"),{spawnSync}=require("node:child_process"),a=process.argv.slice(2);\n'+
  'let i=2;while(a[i]==="-c")i+=2;if(a[0]==="-C"&&a[1]==='+JSON.stringify(body)+'&&a[i]==="status"){fs.appendFileSync('+JSON.stringify(trace)+',JSON.stringify({args:a,locks:process.env.GIT_OPTIONAL_LOCKS,fail:fs.existsSync('+JSON.stringify(flag)+')})+"\\n");if(fs.existsSync('+JSON.stringify(flag)+'))process.exit(128);}\n'+
  'const r=spawnSync('+JSON.stringify(realGit)+',a,{stdio:"inherit"});if(r.error)throw r.error;process.exit(r.status===null?1:r.status);\n',{mode:0o755});
 const preview=async()=>{const res=await fetch(base+'/api/task/preview?project='+encodeURIComponent(p.id)+'&task='+par.id,{headers:{'X-Hub':'1'}});assert.equal(res.status,200);return res.json();};
 process.env.PATH=bin+path.delimiter+oldPath;
 try{
  fs.writeFileSync(flag,'fail');let d=await preview();assert.equal(d,null,'failed status keeps the ordinary preview unconfirmed');assert.deepEqual(fs.readFileSync(h.file(p.id,par.id)),record);
  fs.unlinkSync(flag);d=await preview();assert.equal(d.mainDisplay.reflected,true,'successful clean state remains reflected');
  const dirty=path.join(body,'notice-status-dirty');fs.writeFileSync(dirty,'uncommitted');try{const d=(await preview()).mainDisplay;assert.equal(d.reflected,true);assert.equal(d.mainUncommitted,1);}finally{fs.unlinkSync(dirty);}
  const branch=g(body,'branch','--show-current');g(body,'checkout','-qb','notice-status-merge');g(body,'commit','--allow-empty','-qm','unrelated empty');g(body,'checkout','-q',branch);g(body,'merge','--no-ff','--no-commit','notice-status-merge');
  try{assert.equal(git.merging(body),true);assert.equal((await preview()).mainDisplay.reflected,false);}finally{g(body,'merge','--abort');}
  const commands=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.ok(commands.some(x=>x.fail&&x.locks==='0'),'failed display status is also read-only');assert.ok(commands.some(x=>!x.fail&&x.locks==='0'),'successful display status is read-only');
 }finally{process.env.PATH=oldPath;}
 assert.deepEqual(fs.readFileSync(h.file(p.id,par.id)),record);assert.equal(git.inspect(body).head,bodyHead);assert.equal(h.read(p.id,par.id).auto.pendingMain.main.state,'intent');
});
test('正式HTTP：2択保存/親busy拒否/子busy待機/終了後再確認/同token再開始拒否、実AIと本体副作用0',async()=>{
 const preview=async()=>{const res=await post('/api/task/integrate/preview',{simple:true});assert.equal(res.status,200);return res.json();};
 let d=await preview();assert.equal(d.simple,true);assert.equal(d.items.length,1);assert.equal(d.items[0].keep,false);assert.ok(d.token);
 assert.equal((await post('/api/task/integrate/keep',{childProject:p.id,childTask:child.id,keep:'false'})).status,409);
 const keep=await post('/api/task/integrate/keep',{childProject:p.id,childTask:child.id,keep:true});assert.equal(keep.status,200);assert.deepEqual(await keep.json(),{ok:true,keep:true});assert.equal((await preview()).items[0].keep,true);
 runner.running.set(p.id+'\0'+parent.id,{ai:'codex'});d=await preview();assert.equal(d.token,undefined);assert.ok(d.waiting.length);runner.running.clear();
 runner.running.set(p.id+'\0'+child.id,{ai:'codex'});d=await preview();assert.equal(d.token,undefined);assert.ok(d.waiting.length,'linked worktrees share Git write resources');
 assert.ok(d.items[0].waiting.length);assert.equal((await post('/api/task/integrate',{token:d.token,auto:true,thenMain:false,confirm:true,mode:'single',selected:[{project:p.id,task:child.id,keep:true}]})).status,409);runner.running.clear();d=await preview();assert.deepEqual(d.items[0].waiting,[]);
 const b={token:d.token,auto:true,thenMain:false,confirm:true,mode:'single',selected:[{project:p.id,task:child.id,keep:true}]},res=await post('/api/task/integrate',b),out=await res.json();assert.equal(res.status,200,JSON.stringify(out));assert.equal(out.partial,true);await new Promise(setImmediate);
 assert.ok(auto);assert.equal(auto.integrate.read(p.id,parent.id).auto.mode,'single');assert.equal(auto.integrate.read(p.id,parent.id).items[0].state,'待ち');
 assert.equal((await post('/api/task/integrate',b)).status,409);assert.equal((await post('/api/task/integrate/keep',{childProject:p.id,childTask:child.id,keep:false})).status,409);
 d=await preview();assert.equal(d.id,out.id);assert.ok(d.auto);assert.equal(d.items[0].keep,true);assert.equal(git.inspect(pw.dir).head,parentHead);assert.equal(git.inspect(body).head,bodyHead);assert.ok(fs.existsSync(cw.dir));assert.equal(runner.running.size,0);runner.running.clear();
});

test('成果整理の実経路：旧role混在400→明示coding担当、owner不一致と送信状態を区別',async()=>{
 runner.running.clear();const text='[integration-auto:'+ 'a'.repeat(64)+':organize]\nfixture organizer';
 const old=await post('/api/delegate',{task:child.id,ai:'codex',model:'gpt-6.1-sol',role:'調査',text});assert.equal(old.status,400);assert.match((await old.json()).error,/role/);
 const original=runner.send,startGuard=auto.integrate.simple.organizeStart,calls=[];
 // This routing probe fabricates no durable organizer intent; the dedicated
 // organizer HTTP tests exercise the real start guard and its refusal boundary.
 auto.integrate.simple.organizeStart=()=>{};
 runner.send=o=>{calls.push(o);return {started:Promise.resolve(true),ai:o.ai,model:o.model,effort:o.effort,userRow:{turn:'fixture'}};};
 try{
  store.updateTask(p.id,child.id,{owner:'agy',model:'Gemini 3.1 Pro (High)',role:'司令塔'});
  const request={project:p.id,task:child.id,organize:true,role:'コーディング',title:'統合する成果の整理',text,requestKey:'delivery-fixture'};
  const out=await auto.dispatch(request);assert.equal(out.delivery.state,'accepted');assert.equal(calls.length,1);assert.equal(calls[0].ai,'codex');assert.equal(calls[0].model,'GPT-6.1-Sol');assert.equal(calls[0].request,'delivery-fixture');assert.equal(calls[0].role,'コーディング');
  runner.running.set(p.id+'\0'+child.id,{ai:'codex'});await assert.rejects(auto.dispatch({...request,requestKey:'refusal'}),e=>e.delivery.state==='not-sent');runner.running.clear();assert.equal(calls.length,1);
  runner.send=o=>{o.beforeSend?.();return {started:Promise.reject(Error('fixture disconnect')),ai:o.ai};};await assert.rejects(auto.dispatch({...request,requestKey:'unknown'}),e=>e.delivery.state==='unknown');
 }finally{runner.send=original;auto.integrate.simple.organizeStart=startGuard;runner.running.clear();}
 assert.equal(git.inspect(body).head,bodyHead);assert.ok(fs.existsSync(cw.dir));
});
test('正式隔離確認：履歴なし/read-onlyの内部委任と保存キュー復帰、public入力では有効化不可',async()=>{
 runner.running.clear();const send=runner.send,sendQueued=runner.sendQueued,calls=[],key='e'.repeat(64),head=git.inspect(pw.dir).head;
 const recordFile=auto.integrate.file(p.id,parent.id),recordBefore=fs.readFileSync(recordFile),record=auto.integrate.read(p.id,parent.id);
 store.appendSection(p.id,parent.id,'成果','OLD-IMPLEMENTATION-VERDICT');const originalTask=fs.readFileSync(store.taskFile(p.id,parent.id),'utf8');
 const capture=o=>{calls.push(o);return {started:Promise.resolve(true),ai:o.ai,model:o.model,userRow:{turn:'fixture'}};};runner.send=capture;runner.sendQueued=capture;
 const request={project:p.id,task:parent.id,role:'チェック',isolatedReview:true,review:{key,targetHead:head,reviewHead:head,sourceHead:head},title:'fresh review',text:'[integration-auto:'+key+':review]\n読むだけ',requestKey:'isolated-formal'};
 try{
  const out=await auto.dispatch(request);assert.equal(out.delivery.state,'accepted');const actual=calls[0];assert.equal(actual.isolatedReview,true);assert.equal(actual.readOnly,true);assert.equal(actual.integrationReviewRequest,'isolated-formal');assert.doesNotMatch(actual.basePrompt,/OLD-IMPLEMENTATION-VERDICT/);assert.match(actual.text,/保存差分原物/);assert.equal(actual.dir,pw.dir);assert.equal(fs.readFileSync(store.taskFile(p.id,parent.id),'utf8'),originalTask);
  // dispatch is captured here rather than called by dispatchAttempt. Mirror
  // its durable intent/ack so the real queue API can check that same request.
  delete record.auto.stopped;record.auto.attempts[key]={phase:'review',request:{...request},delivery:{state:'intent',request:'isolated-queued'}};auto.integrate.save(record);
  runner.running.set(p.id+'\0'+parent.id,{ai:'codex',userRow:{turn:'implementation'}});const queued=await auto.dispatch({...request,requestKey:'isolated-queued'});assert.equal(queued.queued,true);runner.running.clear();
  record.auto.attempts[key].delivery=queued.delivery;auto.integrate.save(record);
  const q=runner.queue(p.id,parent.id).find(q=>q.integrationReviewRequest==='isolated-queued');assert.ok(q);const started=await post('/api/chat/send',{fromQueue:q.id});assert.equal(started.status,200,JSON.stringify(await started.json()));const resumed=calls[1];assert.equal(resumed.isolatedReview,true);assert.equal(resumed.readOnly,true);assert.equal(resumed.integrationReviewRequest,'isolated-queued');assert.doesNotMatch(resumed.basePrompt,/OLD-IMPLEMENTATION-VERDICT/);assert.equal(resumed.dir,pw.dir);assert.equal(fs.readFileSync(store.taskFile(p.id,parent.id),'utf8'),originalTask);
  const publicCall=await post('/api/delegate',{ai:'codex',model:'gpt-6.1-sol',text:'public isolated spoof',isolatedReview:true});assert.equal(publicCall.status,200);assert.equal(calls[2].isolatedReview,undefined);assert.equal(calls[2].readOnly,undefined);
 }finally{runner.send=send;runner.sendQueued=sendQueued;runner.running.clear();runner.setQueue(p.id,parent.id,[]);fs.writeFileSync(recordFile,recordBefore);}
});

test('正式本体経路：dirty/API内の除外拒否/差分なしは境界0、Git開始後の不明は境界1で副作用なし',async()=>{
 runner.running.clear();const r=auto.integrate.read(p.id,parent.id);r.auto.mainHead=git.inspect(body).head;let began=0;const dirty=path.join(body,'unsaved');fs.writeFileSync(dirty,'preserved');
 await assert.rejects(auto.mergeMain(r,{begin:()=>began++}),/本体取り込みの前提を確認できません/);assert.equal(began,0);assert.equal(fs.readFileSync(dirty,'utf8'),'preserved');fs.unlinkSync(dirty);
 const taskFile=store.taskFile(p.id,parent.id),taskBefore=fs.readFileSync(taskFile,'utf8'),moved=pw.dir+'-missing-fixture',missing=auto.mergeMain(r,{begin:()=>began++});fs.renameSync(pw.dir,moved);try{await assert.rejects(missing,/本体取り込みの対象が変わりました/);}finally{fs.renameSync(moved,pw.dir);}assert.equal(began,0);assert.equal(fs.readFileSync(taskFile,'utf8'),taskBefore);
 store.updateTask(p.id,parent.id,{mergeExcluded:true});try{await assert.rejects(auto.mergeMain(r,{begin:()=>began++}),/取り込み対象から外されています/);}finally{store.updateTask(p.id,parent.id,{mergeExcluded:false});}assert.equal(began,0);
 fs.writeFileSync(path.join(pw.dir,'parent-change'),'saved');git.save(pw.dir,'fixture parent change');const source=git.inspect(pw.dir),main=git.inspect(body),original=git.merge;let merges=0;
 const preview=git.preview;git.preview=()=>({noChanges:true});try{const out=await auto.mergeMain(r,{begin:()=>began++});assert.equal(out.noChanges,true);assert.equal(began,0);}finally{git.preview=preview;}
 git.merge=()=>{merges++;return {ok:false,error:'fixture after-send refusal'};};
 try{await assert.rejects(auto.mergeMain(r,{begin:()=>began++}),/fixture after-send refusal/);}finally{git.merge=original;}
 assert.equal(began,1);assert.equal(merges,1);assert.deepEqual(git.inspect(body),main);assert.deepEqual(git.inspect(pw.dir),source);assert.ok(fs.existsSync(cw.dir));
});

for(const count of [1,2])test('正式HTTPの選別'+count+'件：空・重複・保持改変を拒否、開始範囲と未選択の原物を保持',async()=>{
 const par=store.createTask(p.id,{title:'選別親'+count}),work=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:par.id});store.updateTask(p.id,par.id,{workdir:work.dir});
 const kids=[];for(const title of ['選別A','選別B','未選択']){const c=store.createTask(p.id,{title,parent:par.id,steps:['未済']}),w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:c.id});store.updateTask(p.id,c.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,title),title);git.save(w.dir,title);store.appendSection(p.id,c.id,'成果','- なし：保存コード');store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'未済',undecided:'なし',evidence:'fixture'})+'\n```');kids.push(store.readTask(store.taskFile(p.id,c.id)));}
 const before=fs.readFileSync(store.taskFile(p.id,kids[2].id),'utf8'),head=git.inspect(kids[2].workdir).head;
 const res=await post('/api/task/integrate/preview',{task:par.id,simple:true}),d=await res.json();assert.equal(res.status,200);const selected=kids.slice(0,count).map(c=>({project:p.id,task:c.id,keep:false})),b={task:par.id,token:d.token,auto:true,thenMain:false,confirm:true,mode:'selected',selected};
 for(const invalid of [[],[selected[0],selected[0]],[{...selected[0],keep:true}]])assert.equal((await post('/api/task/integrate',{...b,selected:invalid})).status,409);
 assert.equal(auto.integrate.tokens.has(d.token),true);assert.equal(auto.integrate.read(p.id,par.id),null);
 const accepted=await post('/api/task/integrate',b),out=await accepted.json();assert.equal(accepted.status,200,JSON.stringify(out));const record=auto.integrate.read(p.id,par.id);assert.equal(record.auto.mode,'selected');assert.deepEqual(record.items.map(i=>i.task),selected.map(i=>i.task));assert.equal(record.auto.scope.length,count);assert.ok(record.items.every(i=>i.choiceAtStart===undefined));assert.equal((await post('/api/task/integrate',b)).status,409);
 assert.equal(fs.readFileSync(store.taskFile(p.id,kids[2].id),'utf8'),before);assert.equal(git.inspect(kids[2].workdir).head,head);assert.equal(git.inspect(body).head,bodyHead);assert.equal(git.inspect(work.dir).head,bodyHead);
});
test('正式HTTP：許可済み補正の3子保持予約を質問停止から新規確認へ、旧質問と本体intent・候補を保全',async()=>{
 const chat=require('../lib/chat'),par=store.createTask(p.id,{title:'許可後の親'}),work=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:par.id});store.updateTask(p.id,par.id,{workdir:work.dir});
 const kids=[];for(const title of ['変更なし','スキルリスト','分離']){const c=store.createTask(p.id,{title,parent:par.id,steps:['実機未確認']}),w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:c.id});store.updateTask(p.id,c.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,title),title);git.save(w.dir,title);store.appendSection(p.id,c.id,'成果','- なし：保存コードのみ');store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:'fixture'})+'\n```');kids.push(store.readTask(store.taskFile(p.id,c.id)));}
 for(const c of kids)assert.equal((await post('/api/task/integrate/keep',{task:par.id,childProject:p.id,childTask:c.id,keep:true})).status,200);
 const data={task:par.id,simple:true},d=await(await post('/api/task/integrate/preview',data)).json();assert.ok(d.token);
 const start=await post('/api/task/integrate',{...data,mode:'selected',auto:true,thenMain:false,confirm:true,token:d.token,selected:kids.map(c=>({project:p.id,task:c.id,keep:true}))});assert.equal(start.status,200);await new Promise(setImmediate);
 const record=auto.integrate.read(p.id,par.id),key='b'.repeat(64),targetHead=git.inspect(work.dir).head,child=record.items.find(i=>i.task===kids[2].id);
 record.auto.prepared=true;record.auto.pendingMain={id:'old',main:{state:'intent',at:'old'}};
 record.auto.attempts[key]={phase:'code',project:p.id,task:child.task,targetHead,sourceHead:child.source.head,delivery:{state:'accepted',request:'old-code'}};
 child.state='解消中';auto.integrate.save(record);auto.stop(p.id,par.id,'統合の判断待ちがあります');
 for(const modern of [false,true])for(const answer of ['補正を許可せず停止する','補正を拒否する']){
  chat.append(p.dir,par.id,{role:'assistant',request:'old-code',error:'',integrationAuto:{key,phase:'code',closed:true},asks:[{question:'継続しますか',options:[answer+'（おすすめ）','補正して保存']}]});
  const turn='negative-'+modern+answer;chat.append(p.dir,par.id,{role:'user',turn,text:answer,head:targetHead});
  // An unrelated saved commit after the refusal cannot authorize the correction.
  fs.writeFileSync(path.join(work.dir,'other-save'),turn);git.save(work.dir,'unrelated fixture save');const other=git.inspect(work.dir).head;
  chat.append(p.dir,par.id,{role:'assistant',error:'',text:'停止しました',...(modern?{answerCompletion:{turn,closed:true,head:other,status:''}}:{})});
  if(!modern)chat.append(p.dir,par.id,{role:'user',turn:'later-'+turn,text:'状態確認',head:other,status:''});
  const stoppedRaw=JSON.stringify(auto.integrate.read(p.id,par.id)),negativeLog=fs.readFileSync(chat.files(p.dir,par.id).log);
  const no=await(await post('/api/task/integrate/preview',data)).json();assert.equal(no.resumeAllowed,false);assert.equal((await post('/api/task/integrate/resume',{task:par.id,token:no.token})).status,409);
  assert.equal(JSON.stringify(auto.integrate.read(p.id,par.id)),stoppedRaw);assert.equal(fs.readFileSync(chat.files(p.dir,par.id).log).equals(negativeLog),true);assert.equal(runner.running.size,0);
 }
 const ask=chat.append(p.dir,par.id,{role:'assistant',request:'old-code',error:'',integrationAuto:{key,phase:'code',closed:true},asks:[{question:'試験補正を許可しますか',options:['補正して保存（おすすめ）','停止する']}]});
 chat.append(p.dir,par.id,{role:'user',turn:'human-answer',text:'補正して保存',head:targetHead});
 for(const c of kids)g(work.dir,'merge','--no-edit',git.inspect(c.workdir).head);const saved=git.inspect(work.dir).head;
 chat.append(p.dir,par.id,{role:'assistant',error:'',text:'保存済み'});chat.append(p.dir,par.id,{role:'user',turn:'next',text:'次へ',head:saved,status:''});
 const log=fs.readFileSync(chat.files(p.dir,par.id).log),bodyBefore=git.inspect(body),stopped=auto.integrate.read(p.id,par.id),oldMain=JSON.stringify(stopped.auto.pendingMain);
 let preview=await(await post('/api/task/integrate/preview',data)).json();assert.equal(preview.resumeAllowed,true,JSON.stringify({message:preview.resumeMessage,status:auto.resumeStatus(stopped),proof:auto.questionResolution(stopped,key,stopped.auto.attempts[key],ask)}));assert.ok(preview.token);assert.equal(fs.readFileSync(chat.files(p.dir,par.id).log).equals(log),true);
 runner.running.set(p.id+'\0'+par.id,{ai:'codex'});const busy=await post('/api/task/integrate/resume',{task:par.id,token:preview.token});assert.equal(busy.status,409);assert.deepEqual(auto.integrate.read(p.id,par.id),stopped);runner.running.clear();
 preview=await(await post('/api/task/integrate/preview',data)).json();const response=await post('/api/task/integrate/resume',{task:par.id,token:preview.token}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));await new Promise(setImmediate);
 const after=auto.integrate.read(p.id,par.id);assert.equal(after.auto.attempts[key].phase,'needs-review');assert.equal(after.auto.attempts[key].codeQuestionResolution.savedHead,saved);assert.equal(after.auto.attempts[key].codeQuestionResolution.request,ask.request);assert.equal(after.auto.stopped,undefined);assert.equal(after.auto.thenMain,false);assert.equal(JSON.stringify(after.auto.pendingMain),oldMain);assert.ok(after.items.every(i=>i.keep));assert.equal(after.complete,false);
 assert.equal((await post('/api/task/integrate/resume',{task:par.id,token:preview.token})).status,409);assert.equal(fs.readFileSync(chat.files(p.dir,par.id).log,'utf8').startsWith(log.toString()),true);assert.deepEqual(git.inspect(body),bodyBefore);assert.equal(git.inspect(work.dir).head,saved);assert.equal(runner.running.size,0);
});
test('正式simple確認は親のメモ・表示時刻で失効せず、成果変更は拒否し再確認で最新対象へ',async()=>{
 const par=store.createTask(p.id,{title:'再確認の親'}),w=git.prepare({base:body,workRoot:removal.workRoot(p),taskId:par.id});store.updateTask(p.id,par.id,{workdir:w.dir});
 const c=store.createTask(p.id,{title:'再確認の子',parent:par.id,steps:['完成']});store.setStep(p.id,c.id,0,true);store.appendSection(p.id,c.id,'成果','- なし：文書確認');store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'fixture'})+'\n```');
 const request={task:par.id,simple:true},d=await (await post('/api/task/integrate/preview',request)).json();store.appendSection(p.id,par.id,'メモ','ログだけ');
 const unchanged=await (await post('/api/task/integrate/preview',request)).json();assert.equal(unchanged.confirmationHash,d.confirmationHash);assert.notEqual(unchanged.token,d.token);
 store.appendSection(p.id,c.id,'成果','- なし：追加の未受領報告');const rejected=await post('/api/task/integrate',{task:par.id,token:d.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:p.id,task:c.id,keep:true}]});assert.equal(rejected.status,409);assert.match((await rejected.json()).error,/成果/);
 const fresh=await (await post('/api/task/integrate/preview',request)).json();assert.notEqual(fresh.confirmationHash,d.confirmationHash);const accepted=await post('/api/task/integrate',{task:par.id,token:fresh.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:p.id,task:c.id,keep:true}]});assert.equal(accepted.status,200);
 const duplicate=await post('/api/task/integrate',{task:par.id,token:fresh.token,auto:true,confirm:true,thenMain:false,mode:'single',selected:[{project:p.id,task:c.id,keep:true}]});assert.equal(duplicate.status,409);
});
