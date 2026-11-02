'use strict';
const { lt } = require('./locale');
// 祖先側の確認→子孫ごとの取り込み→受領→片付け。段階を保存し再開する。
const fs = require('./platform/file-io'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const graph = require('../public/project-order'), git = require('./git');
const { noLinks, noLink, exists, snapshot } = require('./remove');
const continuation = require('./task-continuation');
const hash = s => createHash('sha256').update(s).digest('hex');
const key = x => x.project + '\0' + x.task;
const expand = s => s?.startsWith('~/') ? path.join(os.homedir(),s.slice(2)) : s;
class TaskIntegrate {
  constructor({store,transfer,removal,baseOf=p=>p.dir,gitw=git}) {
    Object.assign(this,{store,transfer,removal,baseOf,gitw});this.tokens=new Map();
    this.dir=path.join(store.root,'_hub/task-integrations');
    this.pendingCache=new (require('./record-read-cache').RecordReadCache)(bytes=>{
      const r=JSON.parse(bytes),complete=continuation.childrenComplete(r),mainPending=continuation.pendingMain(r);
      return complete&&!mainPending&&(!r.auto||r.auto.main?.state==='done')?[]:[{auto:r.auto,project:r.project,task:r.task,id:r.id,stage:r.abandoned?'abandoned':complete?'main':'children',...(r.abandoned?{abandoned:{at:r.abandoned.at,reason:r.abandoned.reason}}:{}),mainPending,items:complete?[]:r.items.map(x=>({project:x.project,task:x.task,title:x.title,state:x.state}))}];
    });
    this.simple=new (require('./integration-simple').SimpleIntegration)(this);
    transfer.integrationPolicy=(p,t,o)=>this.simple.policy(p,t,o);
    transfer.beforeCleanup=r=>this.cleanupCopy(r);
    transfer.integrationTargetGuard=r=>{if(r.integrating){const record=this.read(r.targetProject,r.targetTask,r.integrating);if(!record)throw Error(lt('統合予約が変わりました'));require('./integration-sibling').assert(this,record);require('./integration-safety').assertTarget(this,{target:record.target,p:this.store.readProject(r.targetProject)});}};
    transfer.offerState=(p,t,target,all)=>{
      const a={all,p:target.project,t:target.task,target:expand(target.task.workdir)||this.baseOf(target.project)};
      return this.details(a,p,t).receiptState;
    };
  }
  file(project,task){return path.join(this.dir,hash(project+'\0'+task)+'.json');}
  read(project,task,id){
    const close=require('./integration-consultation-close'),closure=close.read(this,project,task);
    const old=closure?close.retired(this).filter(r=>r.project===project&&r.task===task):[];
    if(id&&old.some(r=>r.id===id))return old.find(r=>r.id===id);
    // Until the explicit transaction finishes, keep the parent blocked even
    // when a crash has already retired one of the canonical lane files.
    if(closure&&closure.stage!=='complete')return old[0];
    const f=this.file(project,task);noLinks(f);const r=exists(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;
    if(!id||r?.id===id)return r;const side=require('./integration-sibling').read(this,project,task);return side?.id===id?side:null;
  }
  readLane(project,task,sibling){return sibling?require('./integration-sibling').read(this,project,task):this.read(project,task);}
  records(project,task){return [this.read(project,task),require('./integration-sibling').read(this,project,task)].filter(Boolean);}
  save(r){require('./integration-consultation-close').assertWritable(this,r);const sibling=require('./integration-sibling');if(r.stoppedSibling)return sibling.save(this,r);sibling.blocked(this,r);return sibling.primarySave(this,r,()=>{const f=this.file(r.project,r.task);noLinks(f);fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(f+'.tmp',JSON.stringify(r,null,2));fs.renameSync(f+'.tmp',f);this.pendingCache.invalidate(f);});}
  // Display evidence only. Never settle the old intent or change replay guards.
  // Called by explicit previews, not the polling state path (no Git in pending()).
  mainDisplay(project,task,r){
    let pending;try{pending=continuation.pendingMain(r===undefined?this.read(project,task):r);}catch{return null;}if(!pending)return null;
    const out={key:JSON.stringify(pending),reflected:false};
    try{
      const p=this.store.readProject(project);if(!p)return out;
      const base=this.baseOf(p);noLinks(base);
      // A preview's false dirty flag can also mean status failed. Require a successful read-only inspection.
      const main=require('./integration-writes').inspect(this.gitw,base),source=pending.main?.sourceHead;
      // Unrelated uncommitted edits do not undo a commit already in HEAD's history.
      // A merge or unresolved conflict still leaves the result unconfirmed.
      const changed=String(main?.status||'').split('\n').filter(Boolean),unmerged=changed.some(l=>/^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
      if(!/^[a-f0-9]{40,64}$/.test(source||'')||!main?.head||unmerged||this.gitw.merging(base))return out;
      out.reflected=this.gitw.isAncestor(base,source,main.head)===true;
      if(out.reflected){out.mainHead=main.head;if(changed.length)out.mainUncommitted=changed.length;}
    }catch{/* Missing Git or evidence remains unconfirmed. */}
    return out;
  }
  pending(){
    if(!exists(this.dir)){this.pendingCache.clear();return [];}noLinks(this.dir);
    const directories=[this.dir,path.join(this.dir,'siblings')];
    return directories.flatMap(dir=>{
      if(!exists(dir)){this.pendingCache.prune(dir,[]);return [];}noLinks(dir);
      const names=fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));this.pendingCache.prune(dir,names);
      return names.flatMap(n=>{try{return structuredClone(this.pendingCache.read(path.join(dir,n))||[]);}catch{return [];}});
    }).concat(require('./integration-consultation-close').pending(this));
  }
  // Conversation eligibility only: leave pending(), replay guards and old intents intact.
  // Git is read only for a completed receipt with a separate historical main intent;
  // ordinary state/auto/continue polling continues to use the Git-free pending().
  historyBlocker(project,task){
    const unresolved=()=>lt('統合の続きが残っています。子作業の受け取りと本体への取り込みを確認してから、もう一度［要約して続ける］を押してください');
    let r;try{r=this.read(project,task);}catch{return lt('統合の記録を読めません。AIに記録の確認を頼んでください');}
    if(r===null&&!exists(this.file(project,task)))return '';
    if(!r||typeof r!=='object'||Array.isArray(r))return lt('統合の記録を読めません。AIに記録の確認を頼んでください');
    if(r.project!==project||r.task!==task)return lt('統合の記録と作業が一致しません。AIに記録の確認を頼んでください');
    const complete=continuation.childrenComplete(r),pending=continuation.pendingMain(r);
    if(complete&&!pending&&(!r.auto||r.auto.main?.state==='done'))return '';
    const old=r.auto?.pendingMain;
    if(!r.abandoned&&r.complete===true&&complete&&typeof r.id==='string'&&r.id&&r.auto?.thenMain===false&&r.auto.main?.state==='done'&&
      old&&old===pending&&typeof old.id==='string'&&old.id&&old.id!==r.id&&old.main?.state==='intent'){
      if(this.mainDisplay(project,task,r)?.reflected===true)return '';
      return lt('過去の本体取り込みが反映済みか確認できません。上部の［その他］で取り込み記録を確認し、AIに調査を頼んでください');
    }
    return unresolved();
  }
  ancestor(project,task,{allowBusy=false}={}){
    const all=this.store.listProjects(),p=all.find(x=>x.id===project),t=p?.tasks.find(x=>x.id===task);
    if(!t)throw Error(lt('統合する親作業が見つかりません'));
    if(!allowBusy&&(this.removal.busy(project,task)||this.removal.locked(project)))throw Error(lt('親作業でAI・整理・確認が動いています。この返事が終わってから統合してください'));
    const q=path.join(p.dir,'.ai/chat',task+'.queue.json');noLinks(q);
    if(!allowBusy&&exists(q)){const rows=JSON.parse(fs.readFileSync(q,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error(lt('親作業に順番待ちがあります'));}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))throw Error(lt('親の作業場所の記録が不正です'));
    if(copy&&!exists(wd))throw Error(lt('親の作業用コピーが見つかりません。記録を片付けてから統合してください'));
    const target=copy?wd:this.baseOf(p);noLinks(target);
    return {all,p,t,target};
  }
  details(a,p,t,ownId,disposition='continue',frozen){
    const partial=disposition==='partial';
    const r=this.transfer.read(p.id,t.id),d=this.removal.describe(p.id,t.id);
    const blockers=d.blockers.filter(x=>!x.startsWith(lt('作業用コピー'))&&!x.startsWith(lt('下の作業や')));
    const futureReason=require('./task-future-hold').reason(p,t,a.all);if(futureReason)blockers.push(futureReason);
    if(disposition==='cleanup'&&a.all.some(q=>q.tasks.some(x=>(x.futureHold||x.futureHoldError)&&graph.ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id))))blockers.push(lt('将来検討として残す子孫があるため、この子作業を片付けられません'));
    const simpleRecord=ownId&&this.read(a.p.id,a.t.id,ownId),simpleItem=simpleRecord?.auto?.mode&&simpleRecord.id===ownId&&simpleRecord.items.find(i=>i.project===p.id&&i.task===t.id);
    if(disposition==='cleanup'&&(!graph.finished(t)||t.question)&&(!simpleItem||t.question))blockers.push(lt('子作業の手順・質問が残っています'));
    if(t.mergeExcluded)blockers.push(lt('取り込み対象から外されています'));
    if(t.kind==='derived'&&!require('./work-context').sourceOf(p,t.derivedFrom,a.all))blockers.push(lt('派生元が同じ大きなプロジェクト内にありません'));
    if(r?.complete&&!r.retained)blockers.push(lt('受領済みの作業が復元されています。再統合はできません'));
    if(!r?.complete&&r?.integrating&&r.integrating!==ownId)blockers.push(lt('別の祖先の統合が進行中です'));
    if(r&&!r.partial&&!r.handedUp&&!r.integrating&&!r.complete)blockers.push(lt('旧版の引渡しが進行中です。先にその続きを行ってください'));
    const ancestors=graph.ancestorsOf(p,t,a.all),depth=ancestors.findIndex(x=>x.project.id===a.p.id&&x.task.id===a.t.id)+1;
    const route=ancestors.slice(0,depth-1).reverse().map(x=>x.task.title).concat(t.title).join(' › ');
    const descendants=a.all.flatMap(q=>q.tasks.filter(x=>graph.ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id)).map(x=>({project:q.id,task:x.id,title:x.title,finished:graph.finished(x)&&!x.question&&!x.continuation})));
    if(disposition==='cleanup'&&descendants.some(x=>!x.finished))blockers.push(lt('未完了の子孫があります。先に下の作業を済ませてください'));
    const issue=frozen?{ok:true,results:frozen.results,resultReady:frozen.resultReady,integrated:frozen.integrated,candidates:{files:frozen.files,selected:frozen.selected,skipped:frozen.skipped}}:this.transfer.resultIssue(p,t),candidates=issue.candidates;
    let {files,candidateError,skipped}=candidates;
    if(partial&&!frozen)try{files=this.transfer.newReceiptFiles(files,r,a.p.id);}catch(e){blockers.push(e.message);}const previousReceipt=this.transfer.lastReceipt(r,a.p.id,a.t.id),previousHead=previousReceipt?.head||null;
    if(candidateError)blockers.push(lt`子の成果候補を確認できません：${candidateError}。子のAIに成果の整理を頼んでください`);
    else if(!issue.ok)blockers.push(issue.reason+lt('。子のAIに成果の整理を頼んでください'));
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))blockers.push(lt('子の作業場所の記録が不正です'));
    if(copy&&!exists(wd))blockers.push(lt('子の作業用コピーが見つかりません。記録を確認してください'));
    const preview=frozen?frozen.preview:copy&&exists(wd)?this.gitw.preview({targetGuard:dir=>require('./integration-safety').target(this,{target:dir,p:a.p}),dir:wd,workRoot:this.removal.workRoot(p),target:a.target,from:previousHead||undefined}):null;
    const liveSource=copy&&exists(wd)?this.gitw.inspect(wd):null,source=frozen?frozen.source:liveSource;
    if(copy&&!source)blockers.push(lt('子の作業用コピーのGitを確認できません'));
    if(copy&&source?.status)blockers.push(lt('子の変更を保存してから確認してください'));
    if(previousHead&&!previousReceipt?.integrated?.reportProjection&&(!copy||!this.gitw.isAncestor(wd,previousHead)||!this.gitw.isAncestor(a.target,previousHead)))blockers.push(lt('前回の受領HEADが子または統合先にありません。履歴を確認してください'));
    if(copy&&source&&this.gitw.merging(wd))blockers.push(lt('子の作業用コピーで取り込みが途中です。解消して保存してください'));
    if(partial)try{if(frozen)this.transfer.partialSnapshot(p,t,r,frozen,ownId,{project:a.p.id,task:a.t.id});else {this.transfer.partialSource(p,t,r);this.transfer.assertPartialOffer(p,t,r,files,source);}if(require('./integration-safety').target(this,a)?.status)blockers.push(lt('途中受領の前に、親の変更を保存してください'));}catch(e){blockers.push(e.message);}
    const {integrated,results,resultReady}=issue;
    const safeOptional=this.transfer.safeOptional(d.optional,files);
    const retained=d.optional.filter(m=>!safeOptional.includes(m));
    const needsResults=!issue.ok;
    const organized=simpleItem&&simpleItem.taskHash===t.completionHash&&Object.values(simpleRecord.auto.attempts||{}).some(x=>x.phase==='verified'&&x.project===p.id&&x.task===t.id&&x.request?.organize===true);
    const remaining=organized?continuation.remaining(simpleItem.remaining):r?.handedUp?continuation.remaining(r.remaining):continuation.declaration(this.store.taskFile(p.id,t.id));
    const item={remaining,needsRemaining:remaining.status==='不明',project:p.id,task:t.id,partial,disposition,sourceHead:source?.head||null,offerId:partial?r?.id:null,title:t.title,remainingSteps:(t.steps||[]).filter(s=>!s.done).map(s=>s.text),question:t.question||'',...(r?.questionBinding?{questionBinding:r.questionBinding}:{}),previousHead,increment:previousHead&&copy&&!blockers.length?{from:previousHead,to:source.head,paths:this.gitw.changedBetween(wd,previousHead,source.head)}:null,review:continuation.suggestions(t,source?.head),previous:previousReceipt?.id||null,cleanupBlockers:[...(!graph.finished(t)||t.question?[lt('手順・質問が残っています')]:[]),...(descendants.some(d=>!d.finished)?[lt('未完了の子孫が残っています')]:[])],taskHash:t.completionHash,route,depth,handedUp:Boolean(r?.handedUp),files,results,resultReady,needsResults,candidateError,skipped,selected:files.map(f=>f.id),copy:copy?wd:null,source,preview,integrated,descendants,blockers:[...new Set(blockers)],move:partial?[]:d.move,optional:partial?[]:safeOptional,retainedFolders:retained.map(m=>m.path),keep:[...d.keep,...retained.map(m=>({path:m.path,why:lt('未受領の内容があるためフォルダ全体を残します')}))]};
    item.receiptState=this.transfer.receivedState(item,r,a.p.id,a.t.id,a.target,this.gitw);
    item.alreadyReceived=item.receiptState.received;
    if(item.receiptState.reason)item.blockers.push(item.receiptState.reason);
    return item;
  }
  // AI開始時も保存された統合先を使い、途中で新しいコピーを作らない。
  startTarget(p,t){
    const r=this.read(p.id,t.id);if(!r||r.complete)return null;
    const target=r.target,base=this.baseOf(p),rel=target&&path.relative(this.removal.workRoot(p),target);
    if(!target || (path.resolve(target)!==path.resolve(base) && (!rel||rel.startsWith('..')||path.isAbsolute(rel))))throw Error(lt('途中の統合先の場所が不正です。統合の続きを確認してください'));
    noLinks(target);if(!exists(target))throw Error(lt('途中の統合先が見つかりません。統合の続きを確認してください'));
    // ファイル成果だけのGit未導入の本体も、保存先のまま開始する。
    // 衝突を解消するAIの開始だけは途中mergeを保持して許す。受領確認では拒否する。
    if(path.resolve(target)!==path.resolve(base)||this.gitw.repoTop(base))this.gitw.recoveryTarget(target,base,{clean:false,allowMerge:true});
    return {dir:target,note:lt`途中の統合先 ${target} で作業します。新しい作業用コピーは作りません`};
  }
  resumePreview(a,r){
    const changed=path.resolve(r.target)!==path.resolve(a.target),reasons=[],blockers=[];
    try{require('./task-future-hold').assertRecord(this,r);}catch(e){blockers.push(e.message);}
    try{continuation.assertNoArchive(this.dir,r);}catch(e){blockers.push(e.message);}
    if(changed)reasons.push(lt('統合先が変わっています'));
    if(this.gitw.merging(a.target))blockers.push(lt('統合先で取り込みが途中です。解消して保存してください'));
    const items=r.items.map(i=>{
      if(['片付け済み','受領済み','保持受領済み'].includes(i.state)){const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);return {...i,retained:true,futureHold:Boolean(t&&require('./task-future-hold').held(p,t,a.all))};}
      const p0=a.all.find(p=>p.id===i.project),t0=p0?.tasks.find(t=>t.id===i.task);
      const h=this.transfer.read(i.project,i.task),out={...i,futureHold:Boolean(t0&&require('./task-future-hold').held(p0,t0,a.all)),blockers:[]};
      // 受領の開始以降は保存した受領段階から再開し、再選択しない。
      if(!h?.integrating&&!h?.complete&&!h?.destination)out.reservationMissing=true;
      if(i.partial&&h?.received?.some(x=>x.integration===r.id))return {...out,state:'受領済み',retained:true};
      if(!h || h.integrating!==r.id)out.blockers.push(lt('子の統合予約が変わりました'));
      if(changed && h?.complete)out.blockers.push(lt('子の受領記録が完了しています。保存された統合先で続きを確認してください'));
      if(h?.receiving||h?.complete){out.receiving=true;return out;}
      const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
      if(!t){out.blockers.push(lt('子作業が見つかりません'));return out;}
      const why=graph.integrateBlock({project:a.p,task:a.t},p,t,a.all,i.partial?'partial':i.disposition||'cleanup');if(why)out.blockers.push(why);
      const now=this.details(a,p,t,r.id,i.partial?'partial':i.disposition||'cleanup',i.partial?i:undefined);out.blockers.push(...now.blockers);
      out.results=now.results;out.resultReady=now.resultReady;out.taskHash=now.taskHash;out.source=now.source;out.copy=now.copy;out.branch=now.source?.branch;
      out.recordChanged=i.taskHash!==now.taskHash;out.liveSource=i.partial&&now.copy?this.gitw.inspect(now.copy):now.source;out.sourceChanged=JSON.stringify(i.approvedSource||i.source)!==JSON.stringify(out.liveSource)||i.copy!==now.copy;
      if(out.recordChanged)reasons.push(lt`子作業「${i.title}」の記録が更新されています`);
      if(out.sourceChanged)reasons.push(lt`子作業「${i.title}」の変更が更新されています`);
      if(i.partial&&out.sourceChanged)reasons.push(lt('確認済みの旧成果だけを受領します。子の新しい保存は次回渡せます'));
      out.codeAlready=Boolean(now.source?.head&&!now.source.status&&this.gitw.isAncestor(a.target,now.source.head));
      if(out.codeAlready){out.state='取り込み済み（受領待ち）';delete out.conflictPaths;delete out.conflictKind;}
      if(!i.partial)for(const f of i.files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))out.blockers.push(lt('成果ファイルが変わりました。元の記録は残しています'));
      if((i.optional||[]).some(id=>!now.optional.some(f=>f.id===id)))out.blockers.push(lt('片付ける専用フォルダが変わりました'));
      return out;
    });
    const recover=changed||items.some(i=>i.recordChanged||i.sourceChanged);
    // 初回の予約保存だけが中断した場合は、従来どおりrunで予約を補う。復旧時は一致必須。
    if(!recover)for(const i of items)if(i.reservationMissing)i.blockers=i.blockers.filter(x=>x!=='子の統合予約が変わりました');
    const targetSnapshot=require('./integration-safety').target(this,a);
    if(recover){
      try{this.gitw.recoveryTarget(a.target,this.baseOf(a.p),{clean:false});require('./integration-safety').assertTarget(this,a);}catch(e){blockers.push(e.message);}
    }
    // 同じパスの履歴も変わり得る。全再開で保存済みの取り込みを照合してから受領する。
    for(const i of r.items)if(i.integrated?.commit&&!this.gitw.isAncestor(a.target,i.integrated.commit))blockers.push(lt('済んだ子の取り込みが現在の統合先にありません：')+i.title);
    for(const i of items)blockers.push(...(i.blockers||[]));
    return {project:r.project,task:r.task,target:a.target,resume:true,id:r.id,items,auto:r.auto,ancestorHash:a.t.completionHash,targetSnapshot,recordHash:hash(JSON.stringify(r)),handoffHash:hash(JSON.stringify(r.items.map(i=>this.transfer.read(i.project,i.task)))),legacy:r.schemaVersion!==2,blockers:[...new Set(blockers)],recover:recover?{savedTarget:r.target,currentTarget:a.target,reasons}:null};
  }
  previewAsync(project,task,only,options={}){return require('./integration-read-worker').integration(this,null,{project,task,only,options});}
  preview(project,task,only,{allowBusy=false,issueToken=true,simple=false,sibling=false,assignments}={}){
    const assignment=require('./integration-assignment'),policy=assignment.normalize(assignments,this.validateAssignment);
    if(policy&&!simple)throw Error('担当指定は新しい簡単統合で確認してください');
    const finish=value=>{if(policy){if(value.resume)throw Error('開始済み統合の担当は変更できません');value.assignmentPolicy=policy;value.assignmentPolicyHash=assignment.hash(policy);}if(simple)value.confirmationHash=require('./integration-safety').hash([value.ancestorHash,value.targetSnapshot,value.previousRecordHash||value.recordHash,value.items.map(i=>[i.project,i.task,i.safetyHash||i.taskHash,i.keep,i.startable,i.noop]),value.assignmentPolicyHash||null,value.sibling===true,value.stoppedSibling||null]);return issueToken?this.token(value):value;};
    const a=this.ancestor(project,task,{allowBusy}),old=this.readLane(project,task,sibling);
    if(sibling&&!simple)throw Error('別の子の報告は簡単統合で確認してください');
    if(simple){if(sibling){const original=this.read(project,task);require('./integration-sibling').binding(this,project,task);if(old&&require('./task-continuation').closed(old))throw Error('別の子の報告は受領済みです。停止記録は残っています');const d=this.simple.preview(a,old);return finish(old?{...d,sibling:true,stoppedWarning:{id:original.id,reason:original.auto.stopped.reason,items:original.items.map(i=>({title:i.title,state:i.state}))}}:require('./integration-sibling').decorate(this,a,d,original));}return finish(this.simple.preview(a,old));}
    if(old&&(!old.complete||old.auto&&old.auto.main?.state!=='done')){
      return finish(this.resumePreview(a,old));
    }
    if(this.gitw.merging(a.target))throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
    let items=a.all.flatMap(p=>p.tasks.filter(t=>graph.canIntegrate({project:a.p,task:a.t},p,t,a.all)&&!require('./task-future-hold').held(p,t,a.all)).map(t=>this.details(a,p,t,undefined,this.transfer.read(p.id,t.id)?.partial&&this.transfer.read(p.id,t.id)?.handedUp?'partial':'continue')));
    if(only){
      if(!Array.isArray(only))throw Error(lt('統合対象を確認してください'));
      const keys=new Set(only.map(key));
      for(const x of only){
        this.transfer.expectTitle(x.project,x.task,x.expectTitle);
        if(!items.some(i=>key(i)===key(x))){
          const p=a.all.find(p=>p.id===x.project),t=p?.tasks.find(t=>t.id===x.task);
          throw Error(graph.integrateBlock({project:a.p,task:a.t},p,t,a.all)||lt('統合対象が変わりました。もう一度確認してください'));
        }
      }
      // 子を選んだ時は完了した孫も拾い、下から片付ける。
      // 保持受領では子孫を自動選択しない。
      items=items.filter(i=>keys.has(key(i)));
    }
    items.sort((x,y)=>y.depth-x.depth||(x.preview?.files||0)-(y.preview?.files||0)||x.title.localeCompare(y.title));
    for(const i of items){


      i.overlaps=items.filter(j=>key(j)!==key(i)&&(j.preview?.paths||[]).some(f=>i.preview?.paths?.includes(f))).map(j=>j.title);
    }
    const targetSnapshot=require('./integration-safety').target(this,a);
    if(targetSnapshot.status)for(const i of items)i.blockers.push(lt('統合先の変更を保存してください：')+targetSnapshot.status);
    const retainedItems=items.filter(i=>i.alreadyReceived);
    return finish({project,task,target:a.target,ancestorHash:a.t.completionHash,targetSnapshot,items:items.filter(i=>!i.alreadyReceived),retainedItems});
  }
  token(value){for(const [id,x]of this.tokens)if(Date.now()-x.at>600000)this.tokens.delete(id);const token=randomUUID();this.tokens.set(token,{at:Date.now(),value});return {...value,token};}
  resumeRecord({project,task,token}){
    const x=this.tokens.get(token),d=x?.value,r=this.read(project,task,d?.id);
    require('./integration-sibling').assert(this,r);
    continuation.assertNoArchive(this.dir,r);
    if(r?.auto?.mode)return this.simple.resume({project,task,token});
    if(!x||Date.now()-x.at>600000||!d.resume||d.project!==project||d.task!==task||!r?.auto?.stopped||r.id!==d.id||r.schemaVersion!==2)throw Error(lt('停止した統合の最新の記録を確認してください'));
    if(r.auto.main?.state==='intent')throw Error(lt('本体取り込みの結果が不明です。再送はしません'));
    const a=this.ancestor(project,task),now=this.resumePreview(a,r);
    if(JSON.stringify(now)!==JSON.stringify(d)||now.recordHash!==hash(JSON.stringify(r)))throw Error(lt('確認中に親・子・統合先・予約が変わりました。もう一度続きを確認してください'));
    if(now.blockers.length)throw Error(now.blockers.join(' / '));
    if(now.recover)throw Error(lt('開始後に子または統合先が変わりました'));
    const current=require('./integration-safety').assertTarget(this,a);
    if(!current||current.status||this.gitw.merging(a.target))throw Error(lt('統合先の変更を保存してください'));
    if(!this.gitw.isAncestor(a.target,r.auto.targetHead))throw Error(lt('開始時の統合先HEADがありません'));
    for(const scope of r.auto.scope){
      const i=r.items.find(i=>i.project===scope.project&&i.task===scope.task);
      if(!i||JSON.stringify(i.source)!==JSON.stringify(scope.source)||i.taskHash!==scope.taskHash||JSON.stringify(i.files)!==JSON.stringify(scope.files)||JSON.stringify(i.results)!==JSON.stringify(scope.results)||JSON.stringify(i.review)!==JSON.stringify(scope.review)||i.disposition!==scope.disposition)throw Error(lt('開始時の統合範囲が変わりました'));
      if(['片付け済み','受領済み','保持受領済み'].includes(i.state))continue;
      const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task),v=this.details(a,p,t,r.id,i.partial?'partial':i.disposition||'cleanup',i.partial?i:undefined);
      if(i.allResults&&JSON.stringify(v.files)!==JSON.stringify(i.files))throw Error(lt('成果ファイルが変わりました'));
    }
    const at=new Date().toISOString();
    r.auto.stopHistory=[...(r.auto.stopHistory||[]),r.auto.stopped];
    r.auto.resumed=[...(r.auto.resumed||[]),{at,by:'human',reason:r.auto.stopped.reason,head:current.head,previousThenMain:r.auto.thenMain}];
    delete r.auto.stopped;r.auto.thenMain=false;r.auto.targetHead=current.head;r.error='';
    return r;
  }
  apply(b){
    if(b.mode)return this.simple.start(b);
    if(b.assignments!==undefined)throw Error('担当指定は新しい簡易統合の開始時だけ指定できます');
    const {project,task,token,selected,confirm,recover,legacyConfirmed,auto=false}=b;let {thenMain=true}=b;
    const x=this.tokens.get(token);
    if(x?.value?.simple)throw Error(lt('もう一度統合内容を確認してください'));
    if(!x||Date.now()-x.at>600000||confirm!==true||x.value.project!==project||x.value.task!==task)throw Error(lt('もう一度統合内容を確認してください'));
    const d=x.value,a=this.ancestor(project,task);let r=this.read(project,task);
    require('./integration-sibling').blocked(this,r);
    if(r?.complete&&r.id===d.id)return {ok:true,complete:true,duplicate:true};
    if(!d.resume){
      if(r&&!r.complete)throw Error(lt('別の統合が始まりました。続きを確認してください'));
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(require('./integration-safety').assertTarget(this,a))!==JSON.stringify(d.targetSnapshot))throw Error(lt('確認中に親作業・統合先が変わりました'));
      if(Array.isArray(selected)&&!selected.length&&!d.items.length)return {ok:true,complete:true,noChanges:true};
      if(!Array.isArray(selected)||!selected.length||new Set(selected.map(key)).size!==selected.length)throw Error(lt('統合する子作業を選んでください'));
      const items=selected.map(s=>{
        const i=[...d.items,...(d.retainedItems||[])].find(i=>key(i)===key(s));if(!i||i.blockers.length)throw Error(i?.blockers.join(' / ')||lt('統合対象が不正です'));
        const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error(lt('確認中に子作業・祖先の関係が変わりました'));
        const disposition=s.disposition===undefined?(i.partial?'partial':auto&&i.remaining.status==='なし'&&!i.cleanupBlockers.length?'cleanup':'continue'):s.disposition;if(!['partial','continue','cleanup'].includes(disposition))throw Error(lt('受領後の扱いを確認してください'));
        if(i.partial&&disposition!=='partial')throw Error(lt('渡し済みの途中成果は固定範囲で受領してください。受領後に続きや片付けを確認できます'));
        if(disposition==='partial'&&!i.partial)throw Error(lt('途中の成果を先に渡してください'));
        let remaining=i.remaining;
        if(s.cleanupAudit){
          if(disposition!=='cleanup'||i.partial||remaining.status==='あり'||i.cleanupBlockers.length)throw Error(lt('残件・判断待ち・子孫があるため作業を続けてください'));
          remaining=continuation.remaining({status:'なし',...s.cleanupAudit});
          if(remaining.status!=='なし'||[lt('未確認'),'未確認'].includes(remaining.evidence)||remaining.evidence.length<10)throw Error(lt('完了を確認した根拠を記入してください'));
        }
        const review=disposition==='partial'&&!s.review?undefined:continuation.review(s.review||(auto?continuation.declaredReview(remaining,i.source?.head):undefined),i.source?.head);
        if(auto&&disposition==='cleanup'&&remaining.status!=='なし')throw Error(lt('残件が不明の子作業は保持します'));
        if(disposition==='cleanup'&&(!['なし',lt('なし')].includes(review.undecided)||!['なし',lt('なし')].includes(review.residual)))throw Error(lt('残件・判断待ち・子孫があるため作業を続けてください'));
        const now=this.details(a,p,t,undefined,disposition);if(now.blockers.length)throw Error(now.blockers.join(' / '));
        if(disposition==='partial'&&now.offerId!==i.offerId)throw Error(lt('確認中に引渡し記録が変わりました'));
        if(JSON.stringify(now.source)!==JSON.stringify(i.source))throw Error(lt('確認中に子の変更が変わりました'));
        if(JSON.stringify(now.files)!==JSON.stringify(i.files))throw Error(lt('確認中に成果ファイルが変わりました'));
        const ids=s.files===undefined?i.selected:s.files;
        if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!i.files.some(f=>f.id===id)))throw Error(lt('成果ファイルの選択が不正です'));
        const optional=s.optional===undefined?i.optional.map(f=>f.id):s.optional;if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!i.optional.some(f=>f.id===id)))throw Error(lt('片付ける専用フォルダが不正です'));
        // 新規統合では成果全件を受け取る。APIでも人による間引きを許さない。
        if(ids.length!==i.files.length)throw Error(lt('成果はAIが整理した全件を統合してください'));
        if(JSON.stringify(now.remaining)!==JSON.stringify(i.remaining))throw Error(lt('確認中に残件申告が変わりました'));
        if(JSON.stringify(now.results)!==JSON.stringify(i.results))throw Error(lt('確認中に成果の保存記録が変わりました'));
        const files=i.files.filter(f=>ids.includes(f.id));if(!files.length&&!i.copy&&!i.integrated?.files?.length&&!i.resultReady)throw Error(lt('成果の記録を先に整えてください'));
        for(const f of files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('確認中に成果ファイルが変わりました'));
        return {...now,disposition,review,cleanupAudit:s.cleanupAudit?{...remaining,taskHash:i.taskHash,source:i.source,receipt:i.receiptState.receipt}:undefined,...(auto?{reviewAuthorization:'start',remaining}:{}),signature:continuation.signature({...i,disposition,review,files}),files,optional:disposition!=='cleanup'?[]:optional,allResults:true,branch:i.source?.branch,state:'待ち'};
      });
      // Repeated starts on an unchanged receipt create no reservation, receipt or main action.
      const actionable=items.filter(i=>!i.alreadyReceived||i.disposition==='cleanup');
      if(!actionable.length)return {ok:true,complete:true,noChanges:true};
      items.splice(0,items.length,...actionable);
      if(items.every(i=>i.alreadyReceived))thenMain=false;
      // 表示順を変更できても孫→子の制約は崩さない。
      for(let n=0;n<items.length;n++)for(const kid of items[n].disposition==='cleanup'?items[n].descendants:[])if(!items.slice(0,n).some(i=>key(i)===key(kid)&&i.disposition==='cleanup'))throw Error(lt('子孫を一緒に選び、孫から先に統合してください'));
      // HEAD・status・内容が同じでも別のmergeが始まり得る。記録・予約の保存直前に拒否する。
      if(this.gitw.merging(a.target))throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
      continuation.archive(this.dir,r);
      r={schemaVersion:2,kind:items.some(i=>i.partial)?'partial':'final',id:randomUUID(),project,task,target:a.target,items,at:new Date().toISOString(),complete:false};this.save(r);d.id=r.id;
      for(const i of items){let h=this.transfer.read(i.project,i.task);if(h?.complete&&h.retained){continuation.archive(this.transfer.dir,h);if(i.disposition!=='cleanup'&&h.signature===i.signature){i.state='保持受領済み';i.receipt=h.id;this.save(r);continue;}i.previous=h.id;h={received:this.transfer.receiptHistory(h)};}if(!h?.complete&&h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,previous:i.previous,integrating:r.id});}
    }else {
      if(d.legacy&&legacyConfirmed!==true)throw Error(lt('旧確認は片付けを含みます。元の範囲を確認してください'));
      if(!r||r.id!==d.id||r.complete||hash(JSON.stringify(r))!==d.recordHash)throw Error(lt('統合記録が変わりました'));
      const now=this.resumePreview(a,r);
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(now)!==JSON.stringify(d))throw Error(lt('確認中に親・子・統合先・予約が変わりました。もう一度続きを確認してください'));
      if(now.blockers.length)throw Error(now.blockers.join(' / '));
      if(d.recover && recover!==true)throw Error(lt('復旧内容を確認し、統合先と子の更新を承認してください'));
      if(d.recover){
        if(path.resolve(r.target)!==path.resolve(d.target)){
          r.targetHistory=[...(r.targetHistory||[]),{from:r.target,to:d.target,at:new Date().toISOString(),reason:d.recover.reasons.join(' / ')}];r.target=d.target;
        }
        for(let n=0;n<r.items.length;n++){
          const i=r.items[n],v=d.items[n];if(['片付け済み','受領済み','保持受領済み'].includes(i.state)||v.receiving)continue;
          if((!i.partial&&v.sourceChanged)||path.resolve(d.recover.savedTarget)!==path.resolve(d.target))i.state='待ち';
          Object.assign(i,{taskHash:v.taskHash,source:v.source,copy:v.copy,branch:v.branch,results:v.results,resultReady:v.resultReady});
          if(i.partial)i.approvedSource=v.liveSource;
        }
        this.save(r);
      }
    }
    if(auto){
      if(r.auto?.stopped)throw Error(lt('自動統合は停止しています。原因を確認してください'));
      if(!r.auto){r.auto={by:'human',at:new Date().toISOString(),thenMain:thenMain!==false,attempts:{},scope:r.items.map(i=>({project:i.project,task:i.task,source:i.source,taskHash:i.taskHash,results:i.results,files:i.files,disposition:i.disposition,review:i.review})),targetHead:this.gitw.inspect(r.target)?.head,mainHead:this.gitw.inspect(this.gitw.mainOf?.(r.target)||r.target)?.head};this.save(r);}
    }
    if(path.resolve(a.target)!==path.resolve(r.target))throw Error(lt('統合先が変わりました'));
    this.active=r;
    try { const out=this.run(r);if(r.auto){r.auto.targetHead=this.gitw.inspect(r.target)?.head;this.save(r);}return out; }catch(e){r.error=e.message;if(r.auto)r.auto.stopped={reason:e.message,at:new Date().toISOString()};this.save(r);throw e;}finally{this.active=null;}
  }
  run(r){
    require('./integration-sibling').assert(this,r);
    require('./task-future-hold').assertRecord(this,r);
    const a=this.ancestor(r.project,r.task);
    // 初回の予約保存が途中で止まった場合も、残りを予約してから処理する。
    for(const i of r.items){
      if(['片付け済み','受領済み','保持受領済み'].includes(i.state))continue;
      const completed=this.transfer.read(i.project,i.task);if(i.partial&&completed?.received?.some(x=>x.integration===r.id)){i.state='受領済み';i.receipt=completed.received.find(x=>x.integration===r.id).id;this.save(r);continue;}
      let h=this.transfer.read(i.project,i.task);
      if(h?.complete&&h.retained&&h.integrating!==r.id){continuation.archive(this.transfer.dir,h);if(i.disposition!=='cleanup'&&h.signature===i.signature){i.state='保持受領済み';i.receipt=h.id;this.save(r);continue;}i.previous=h.id;h={received:this.transfer.receiptHistory(h)};}
      if(!h?.complete&&h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));
      if(!h?.integrating){if(h?.complete||h?.destination)throw Error(lt('子の受領記録が変わりました'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }
    for(const i of r.items){
      if(['片付け済み','受領済み','保持受領済み'].includes(i.state))continue;
      const completed=this.transfer.read(i.project,i.task);if(i.partial&&completed?.received?.some(x=>x.integration===r.id)){i.state='受領済み';i.receipt=completed.received.find(x=>x.integration===r.id).id;this.save(r);continue;}
      const waiting=(i.descendants||[]).filter(d=>r.items.some(x=>key(x)===key(d)&&!['片付け済み','受領済み','保持受領済み'].includes(x.state)));
      if(waiting.length){i.waitingFor=waiting.map(x=>x.title);this.save(r);continue;}
      delete i.waitingFor;
      const receipt=this.transfer.read(i.project,i.task);
      if(receipt?.integrating!==r.id)throw Error(lt('子の統合予約が変わりました'));
      require('./integration-safety').assertTarget(this,{target:r.target,p:this.store.readProject(r.project)});
      if(!receipt.receiving&&!receipt.complete){
        const current=this.ancestor(r.project,r.task),p=current.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!(r.auto?.mode?this.simple.related(current,p,t):graph.canIntegrate({project:current.p,task:current.t},p,t,current.all)))throw Error(lt('途中で子作業・祖先の関係が変わりました'));
        const details=this.details(current,p,t,r.id,i.partial?'partial':i.disposition||'cleanup',i.partial?i:undefined);if(details.blockers.length)throw Error(details.blockers.join(' / '));
        if(i.partial&&i.copy&&JSON.stringify(this.gitw.inspect(i.copy))!==JSON.stringify(i.approvedSource||i.source))throw Error(lt('途中で子の変更が変わりました。続きを確認してください'));
        if(JSON.stringify(details.source)!==JSON.stringify(i.source))throw Error(lt('途中で子の変更が変わりました。続きを確認してください'));
        if(i.results && JSON.stringify(details.results)!==JSON.stringify(i.results))throw Error(lt('途中で成果の保存記録が変わりました。続きを確認してください'));
        if(i.allResults && JSON.stringify(details.files)!==JSON.stringify(i.files))throw Error(lt('途中で成果ファイルが変わりました。続きを確認してください'));
        if(!i.partial)for(const f of i.files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('成果ファイルが変わりました'));
        if(['待ち','衝突','解消中','検証中','取り込み済み（受領待ち）'].includes(i.state)){
          if(r.stoppedSibling&&i.reportProjection&&i.integrated){
            require('./integration-report-projection').verify(r.target,i.reportProjection,i.integrated.commit);
            if(!this.gitw.isAncestor(r.target,i.integrated.commit))throw Error('保存済みの報告履歴が統合先にありません');
          }else if(i.copy){
            const previousTargetHead=this.gitw.inspect(r.target)?.head;
            const merged=r.stoppedSibling&&i.reportProjection?require('./integration-report-projection').apply(this,r,i):this.gitw.isAncestor(r.target,i.source.head)?{ok:true,already:true,commit:this.gitw.inspect(r.target).head,files:i.preview?.paths||[]}:this.gitw.merge({targetGuard:dir=>require('./integration-safety').assertTarget(this,{target:dir,p:this.store.readProject(r.project)}),dir:i.copy,workRoot:this.removal.workRoot(p),title:`${i.task} ${i.title}`,target:r.target,cleanup:false,...(i.partial?{sourceHead:i.source?.head}:{})});
            if(merged.conflict){
              i.state='衝突';i.conflictPaths=merged.conflictPaths||[];i.conflictKind='content';this.save(r);
              continue;
            }
            if(!merged.ok)throw Error(merged.error);
            delete i.conflictPaths;delete i.conflictKind;i.autoResolved=merged.autoResolved||i.autoResolved;
            i.integrated={dir:r.target,previousTargetHead,commit:merged.commit,files:merged.files,already:merged.already,...(merged.reportProjection?{reportProjection:merged.reportProjection}:{})};i.sourceSnapshot=this.gitw.inspect(i.copy);i.sourceHead=i.partial?i.source?.head:i.sourceSnapshot.head;if(!i.partial)i.source=i.sourceSnapshot;
          }
          i.state='取り込み済み';this.save(r);
        }
      }
      if(r.auto?.mode&&!i.alreadyReceived&&!Object.values(r.auto.attempts).some(a=>a.phase==='verified'&&a.project===i.project&&a.task===i.task&&(a.reviewHead||a.fileReview))){
        i.state='検証待ち';this.save(r);return {ok:true,partial:true,complete:false,id:r.id};
      }
      if(r.auto?.mode)this.simple.migration(r,i);
      const out=i.partial?this.transfer.receivePartial({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,sourceHead:i.source?.head||null,frozen:i,preserveQuestionConversation:!!r.auto?.mode}):this.transfer.receiveIntegrated({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,results:i.results,optional:i.optional,disposition:i.partial?'partial':i.disposition||'cleanup',review:i.review,sourceHead:i.source?.head,previous:i.previous});
      const h=this.transfer.read(i.project,i.task);h.signature=i.signature;this.transfer.save(h);
      i.receipt=out.record;i.state=i.partial?'受領済み':out.retained?'保持受領済み':'片付け済み';this.save(r);
    }
    const conflicts=r.items.filter(i=>i.state==='衝突').map(i=>({project:i.project,task:i.task,title:i.title,paths:i.conflictPaths||[]}));
    if(conflicts.length){
      r.error=lt('コードがぶつかった子を後回しにしました');this.save(r);
      if(!r.auto)this.store.updateTask(r.project,r.task,{state:'返事待ち',question:conflicts.map(i=>lt`子作業「${i.title}」でぶつかりました（${i.paths.join('、')}）`).join(' ／ ')+lt`。統合先 ${r.target} で［AIでぶつかりを解消］を頼み、AI終了後に［統合の続きを行う］を押してください。新しい作業用コピーは作りません`});
      return {ok:false,partial:true,conflict:true,complete:false,conflicts,error:r.error,items:r.items};
    }
    r.complete=true;r.error='';this.save(r);
    return {ok:true,complete:true,kind:r.kind,items:r.items.map(x=>({title:x.title,state:x.state})),parentProject:a.p.id,parent:a.t.id};
  }
  resultsRequest({project,task,childProject,childTask,token}) {
    const x=this.tokens.get(token),d=x?.value;
    if(d?.sibling)throw Error('別の子の報告は保存済みの成果だけを受け取ります');
    require('./integration-sibling').blocked(this,this.read(project,task));
    if(!d||Date.now()-x.at>600000||d.project!==project||d.task!==task||d.resume)throw Error(lt('もう一度統合内容を確認してください'));
    const a=this.ancestor(project,task),i=[...d.items,...(d.retainedItems||[])].find(i=>i.project===childProject&&i.task===childTask);
    if(!i?.needsResults&&!i?.needsRemaining)throw Error(lt('成果の整理が必要な子を確認してください'));
    const p=a.all.find(p=>p.id===childProject),t=p?.tasks.find(t=>t.id===childTask);
    if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error(lt('確認中に子作業が変わりました'));
    const now=this.details(a,p,t,undefined,i.partial?'partial':i.disposition||'continue');
    if((!now.needsResults&&!now.needsRemaining)||now.blockers.some(b=>!b.includes('成果')&&!b.includes('保存済み')&&!b.includes('本体保存済み')))throw Error(lt('子の作業状態を先に確認してください'));
    return {...this.transfer.organizeRequest(p,t,now.candidateError || lt('成果の記録を確認してください')),title:lt('統合する成果の整理')};
  }
  conflictRequest({project,task,childProject,childTask,token}){
    const x=this.tokens.get(token),a=this.ancestor(project,task),r=this.read(project,task);
    require('./integration-sibling').blocked(this,r);
    if(!x||Date.now()-x.at>600000||!x.value.resume||x.value.project!==project||x.value.task!==task||!r||r.complete||r.id!==x.value.id)throw Error(lt('もう一度統合の続きを確認してください'));
    const now=this.resumePreview(a,r);
    if(JSON.stringify(now)!==JSON.stringify(x.value))throw Error(lt('確認中に親・子・統合先・予約が変わりました'));
    if(now.blockers.length)throw Error(now.blockers.join(' / '));
    if(now.recover)throw Error(lt('先に統合先と子の更新を確認して続けてください'));
    const i=r.items.find(i=>i.project===childProject&&i.task===childTask);
    if(now.items.find(v=>v.project===childProject&&v.task===childTask)?.codeAlready)throw Error(lt('コードは取り込み済みです。正式受領を続けます'));
    if(!i||i.state!=='衝突'||!i.branch||!i.copy)throw Error(lt('衝突した子作業を選んでください'));
    return {project,task,title:lt`ぶつかりを解消：${i.title}`,text:lt`目的：子作業「${i.title}」のコードのぶつかりを解消する。
読む：保存された統合先 ${r.target}、ブランチ ${i.partial?i.source.head:i.branch}、衝突パス ${JSON.stringify(i.conflictPaths||[])}。
やる：この統合先でブランチをmergeし、両側の意図を保って解消。関連試験と版・履歴の一致を確認してcommitする。
条件：新しいコピーを作らない。ours/theirsの一括採用は禁止。意味を決められない時は推測せず[[質問]]形式で人に聞いて止まる。統合・受領・片付けの記録は変更しない。
出力：保存したcommitと試験結果をこの親の会話へ返す。
次：保存してこの番を終える。Hubが検証と正式受領の続きを行う。統合を再委任しない。`};
  }
  cleanupCopy(receipt){
    const r=this.active?.id===receipt.integrating?this.active:this.read(receipt.targetProject,receipt.targetTask,receipt.integrating),i=r?.items.find(x=>x.project===receipt.project&&x.task===receipt.task);
    require('./integration-sibling').assert(this,r);
    if(r?.stoppedSibling)throw Error('別の子の報告を受け取る経路では片付けません');
    if(!r||r.id!==receipt.integrating||!i)throw Error(lt('統合の片付け記録が見つかりません'));
    require('./task-future-hold').assertRecord(this,r);
    require('./integration-safety').assertTarget(this,{target:r.target,p:this.store.readProject(r.project)});
    if(!i.copy||i.copyTrashed)return;
    if(!exists(i.copy)){
      // 移動後に停止しても、退避先とコミットを照合して登録整理を続ける。
      if(!i.copyTrashPlanned||!exists(i.copyTrashPlanned)||!i.sourceHead||!this.gitw.isAncestor(r.target,i.sourceHead))throw Error(lt('作業用コピーの退避先を確認できません'));
      noLinks(i.copyTrashPlanned);
      this.gitw.finishCleanupCopy({target:r.target,branch:i.branch,sourceHead:i.sourceHead});
      i.copyTrashed=i.copyTrashPlanned;this.save(r);return;
    }
    const out=this.gitw.cleanupCopy({dir:i.copy,workRoot:path.join(this.store.root,'Work',i.project),target:r.target,expectedSnapshot:i.sourceSnapshot,beforeMove:({trashed,branch,sourceHead})=>{i.copyTrashPlanned=trashed;i.branch=branch;i.sourceHead=sourceHead;this.save(r);}});
    i.copyTrashed=out.trashed;this.save(r);
  }
}
module.exports={TaskIntegrate};
