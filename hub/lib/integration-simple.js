'use strict';
// The minimal UI is a new authorization path. Legacy, manually reviewed requests
// retain their original guards; only this durable record can authorize migration.
const fs=require('./platform/file-io'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const graph=require('../public/project-order'),continuation=require('./task-continuation');
const safety=require('./integration-safety'),selection=require('../public/integration-selection');
const {noLinks,exists,snapshot}=require('./remove'),{lt,sectionPattern}=require('./locale');
const key=x=>x.project+'\0'+x.task,hash=x=>createHash('sha256').update(x).digest('hex'),at=()=>new Date().toISOString();
const terminal=i=>['片付け済み','受領済み','保持受領済み'].includes(i.state);
const scope=i=>({project:i.project,task:i.task,source:i.source,taskHash:i.taskHash,results:i.results,files:i.files,disposition:i.disposition,review:i.review,keep:i.keep,...(i.reportProjection?{reportProjection:i.reportProjection}:{}),...(i.questionBinding?{questionBinding:i.questionBinding}:{})});
class SimpleIntegration {
  constructor(integrate){this.h=integrate;}
  related(a,p,t){return Boolean(t&&!graph.approved(a.t)&&graph.ancestorsOf(p,t,a.all).some(x=>x.project.id===a.p.id&&x.task.id===a.t.id));}
  choice(t,h){return typeof t.integrateKeep==='boolean'?t.integrateKeep:Boolean(h?.partial||h?.retained);}
  decorate(a,i){
    const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task),receipt=this.h.transfer.read(i.project,i.task);
    const keep=this.choice(t,receipt),keepLocked=!this.related(a,p,t);
    // Saving a choice changes the task hash, but not the received code/file set.
    // receivedState remains authoritative: this projection never invents a receipt.
    const blockers=this.blockers(i,keep);
    return {...i,safetyHash:safety.item(this.h,i),keepFolders:i.keep,keep,keepLocked,keepLockedReason:keepLocked?lt('統合先は残します'):'',startable:!keepLocked&&!blockers.length,reason:blockers.join(' / '),noop:i.alreadyReceived&&keep};
  }
  question(i,keep,integration){
    const p=this.h.store.readProject(i.project),file=this.h.store.taskFile(i.project,i.task),t=file&&this.h.store.readTask(file);
    if(!t)throw Error('子作業が見つかりません');
    if(i.questionBinding||t.question)this.h.transfer.assertQuestionOffer(p,t,this.h.transfer.read(i.project,i.task),i,{keep,integration});
  }
  blockers(i,keep){
    if(i.question||i.questionBinding){
      try{this.question(i,keep);}catch(e){return [e.message];}
      // A question-waiting conversation must never be sent an organizer.
      return i.blockers||[];
    }
    // Only facts which the one-shot organizer can repair are deferred.
    return (i.blockers||[]).filter(x=>!x.includes(lt('子のAIに成果の整理を頼んでください'))&&!x.includes(lt('子の変更を保存してから確認してください'))&&![lt('AIが作業中です。終わってから操作してください'),lt('順番待ちを取り消してから操作してください')].includes(x));
  }
  preview(a,old){
    if(old&&!continuation.closed(old)){
      if(!old.auto?.mode){const d=this.h.resumePreview(a,old);return {...d,mainDisplay:this.h.mainDisplay(a.p.id,a.t.id,old),simple:true,items:d.items.map(i=>({...i,keep:i.disposition!=='cleanup',keepLocked:true,startable:false}))};}
      const archiveBlockers=[];try{continuation.assertNoArchive(this.h.dir,old);}catch(e){archiveBlockers.push(e.message);}
      try{require('./task-future-hold').assertRecord(this.h,old);}catch(e){archiveBlockers.push(e.message);}
      const items=old.items.map(i=>{const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);return {...i,futureHold:Boolean(t&&require('./task-future-hold').held(p,t,a.all)),startable:false,noop:terminal(i),reason:old.auto.stopped?.reason||'',keepLocked:true};});
      return {project:old.project,task:old.task,target:a.target,resume:true,id:old.id,items,auto:old.auto,mainDisplay:this.h.mainDisplay(a.p.id,a.t.id,old),blockers:archiveBlockers,ancestorHash:safety.confirmationParent(a),targetSnapshot:safety.target(this.h,a),recordHash:hash(JSON.stringify(old)),simple:true};
    }
    if(this.h.gitw.merging(a.target))throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
    const targetSnapshot=safety.target(this.h,a),recordSave=require('./integration-record-save').preview(this.h,a);
    const targetReason=recordSave.unresolved?recordSave.reason:targetSnapshot.status?lt('統合先に未保存の変更があります。対象と保存方法を確認してください')+'：'+[...recordSave.records.map(r=>r.path),...recordSave.products].slice(0,20).join('、'):'';
    let items=a.all.flatMap(p=>p.tasks.filter(t=>this.related(a,p,t)&&!t.freetalk&&!require('./task-future-hold').held(p,t,a.all)).map(t=>this.decorate(a,this.h.details(a,p,t,undefined,this.h.transfer.read(p.id,t.id)?.partial&&this.h.transfer.read(p.id,t.id)?.handedUp?'partial':'continue'))));
    // A retained record is history, not a new integration offer. Only suppress
    // formally completed children whose full receipt still verifies; new code,
    // task text, artifacts or damaged provenance must remain visible. A cleanup
    // of a visible ancestor still needs every descendant's explicit keep choice.
    const completed=i=>i.alreadyReceived&&graph.approved(a.all.find(p=>p.id===i.project)?.tasks.find(t=>t.id===i.task));
    const candidates=items.filter(i=>!completed(i));
    items=items.flatMap(i=>!completed(i)?[i]:candidates.some(p=>!p.keep&&p.descendants.some(c=>key(c)===key(i)))?[{...i,cleanupOnly:true,cleanupReceiptHash:hash(JSON.stringify(this.h.transfer.read(i.project,i.task)))}]:[]);
    if(targetReason)items=items.map(i=>({...i,startable:false,reason:targetReason,blockers:[...i.blockers,targetReason]}));
    if(!targetSnapshot.head&&items.some(i=>i.copy))throw Error(lt('コード統合にはGitの保存先が必要です'));
    items.sort((a,b)=>b.depth-a.depth||a.title.localeCompare(b.title));
    return {project:a.p.id,task:a.t.id,target:a.target,items,mainPending:continuation.pendingMain(old),mainDisplay:this.h.mainDisplay(a.p.id,a.t.id,old),previousRecordHash:hash(JSON.stringify(old)),ancestorHash:safety.confirmationParent(a),targetSnapshot,recordSave,blockers:targetReason?[targetReason]:[],simple:true};
  }
  resume(b){
    const h=this.h,x=h.tokens.get(b.token),d=x?.value,r=h.read(b.project,b.task,d?.id);
    require('./integration-sibling').assert(h,r);
    continuation.assertNoArchive(h.dir,r);
    if(!d?.simple||!d.resume||!r?.auto?.stopped||r.id!==d.id||Date.now()-x.at>600000||d.recordHash!==hash(JSON.stringify(r)))throw Error(lt('停止した統合の最新の記録を確認してください'));
    if(r.auto.main?.state==='intent')throw Error(lt('本体取り込みの結果が不明です。再送はしません'));
    const a=this.validate(r),{current,rebase}=this.resumeBaseline(r,a);
    if(safety.confirmationParent(a)!==d.ancestorHash||JSON.stringify(current)!==JSON.stringify(d.targetSnapshot))throw Error(lt('開始後に子または統合先が変わりました'));
    for(const i of r.items){const m=r.auto.migrations[key(i)];if(m&&!terminal(i)&&!this.receiving(r,i))this.verifyMigration(r,i,m,fs.readFileSync(h.store.taskFile(r.project,r.task),'utf8'),fs.readFileSync(h.store.taskFile(i.project,i.task),'utf8'));}
    r.auto.stopHistory=[...(r.auto.stopHistory||[]),r.auto.stopped];r.auto.resumed=[...(r.auto.resumed||[]),{at:at(),by:'human',head:current.head,previousTargetHead:r.auto.targetHead,previousThenMain:r.auto.thenMain}];
    if(rebase)r.auto.targetHead=current.head;
    delete r.auto.stopped;r.auto.thenMain=false;r.error='';return r;
  }
  resumeBaseline(r,a=this.h.ancestor(r.project,r.task,{allowBusy:true})){
    const h=this.h,current=safety.assertTarget(h,a);
    if(a.target!==r.target||!current||current.status||h.gitw.merging(a.target)||current.head&&!h.gitw.isAncestor(r.target,r.auto.targetHead))throw Error(lt('開始後に子または統合先が変わりました'));
    // A human can confirm a saved fix on the same copy before any Git/file
    // integration. Later phases retain their reviewed heads and receipt guards.
    const attempts=Object.values(r.auto.attempts),rebase=current.head!==r.auto.targetHead&&!r.complete&&!r.auto.prepared&&!r.auto.main&&!Object.keys(r.auto.migrations||{}).length&&r.items.every(i=>!i.integrated&&!i.receipt&&['待ち','整理中'].includes(i.state))&&attempts.every(a=>['organize','order','verified'].includes(a.phase)||a.phase==='superseded'&&a.organizeFailure&&r.auto.attempts[a.supersededBy]?.organizeRepair);
    if(current.head!==r.auto.targetHead&&!rebase&&!attempts.some(a=>['code','review','needs-review'].includes(a.phase)))throw Error(lt('開始後に統合先HEADが変わりました'));
    return {current,rebase};
  }
  saveKeep({project,task,childProject,childTask,keep}){
    if(typeof keep!=='boolean')throw Error(lt('残す・残さないを選んでください'));
    const a=this.h.ancestor(project,task),p=a.all.find(x=>x.id===childProject),t=p?.tasks.find(x=>x.id===childTask),r=this.h.read(project,task);
    if(!this.related(a,p,t)||r&&!continuation.closed(r))throw Error(lt('統合中の選択は変更できません'));
    require('./task-future-hold').assertAllowed(p,t,a.all);
    if(this.h.removal.busy(p.id,t.id)||this.h.removal.locked(p.id))throw Error(lt('子のAI終了後に選択を変更してください'));
    this.updateChoice(p,t,keep);
    return {ok:true,keep};
  }
  updateChoice(p,t,keep){
    const receipt=this.h.transfer.read(p.id,t.id),before=t.completionHash;
    const file=this.h.store.taskFile(p.id,t.id);noLinks(file);
    const beforeText=graph.approved(t)?fs.readFileSync(file,'utf8'):undefined;
    const next=this.h.store.updateTask(p.id,t.id,{integrateKeep:keep});
    if(receipt&&next.completionHash!==before){
      const last=this.h.transfer.lastReceipt(receipt);
      if(last){receipt.keepChanges=[...(receipt.keepChanges||[]),{receipt:last.id,before,after:next.completionHash,text:fs.readFileSync(file,'utf8'),...(beforeText!==undefined?{beforeText}:{}),at:at()}];this.h.transfer.save(receipt);}
    }
    return next;
  }
  start(b){
    const h=this.h,x=h.tokens.get(b.token),d=x?.value;
    if(!d?.simple||d.resume||Date.now()-x.at>600000||b.confirm!==true||b.auto!==true||d.project!==b.project||d.task!==b.task||!['single','batch','selected'].includes(b.mode))throw Error(lt('もう一度統合内容を確認してください'));
    const assignment=require('./integration-assignment'),policy=assignment.normalize(b.assignments,h.validateAssignment);
    if((policy?assignment.hash(policy):null)!==(d.assignmentPolicyHash||null)||JSON.stringify(policy)!==JSON.stringify(d.assignmentPolicy||null))throw Error('確認時の統合担当と指定が一致しません');
    const a=h.ancestor(b.project,b.task),old=h.readLane(b.project,b.task,d.sibling);
    const sibling=require('./integration-sibling');
    if(d.sibling){if(b.mode!=='single'||b.selected?.length!==1||b.selected[0]?.keep!==true||b.thenMain!==false||JSON.stringify(sibling.binding(h,b.project,b.task))!==JSON.stringify(d.stoppedSibling))throw Error('別の子の保存済み報告を一つ、子を残して受け取ってください');}
    else sibling.blocked(h,old);
    if(require('./integration-record-save').unresolved(h,a))throw Error(lt('Hub記録の保存結果が不明です。再送せず保存記録を確認してください'));
    const current=safety.assertTarget(h,a);
    if(old&&!continuation.closed(old)||d.previousRecordHash!==hash(JSON.stringify(old)))throw Error(lt('別の統合が始まりました。続きを確認してください'));
    if(safety.confirmationParent(a)!==d.ancestorHash||a.target!==d.target||JSON.stringify(current)!==JSON.stringify(d.targetSnapshot)||h.gitw.merging(a.target)||current.status)throw Error(lt('確認中に親作業・統合先が変わりました'));
    if(!Array.isArray(b.selected)||!b.selected.length||b.selected.some(s=>!s||typeof s.project!=='string'||typeof s.task!=='string')||new Set(b.selected.map(key)).size!==b.selected.length)throw Error(lt('統合する子作業を選んでください'));
    const items=b.selected.map(s=>{
      const i=d.items.find(i=>key(i)===key(s));
      if(!i?.startable||i.noop&&s.keep===true||typeof s.keep!=='boolean'||s.review||s.cleanupAudit)throw Error(i?.reason||lt('統合対象が不正です'));
      if(b.mode==='selected'&&(i.noop||s.keep!==i.keep||Object.hasOwn(s,'review')||Object.hasOwn(s,'cleanupAudit')))throw Error(lt('選別統合の対象・保持選択が変わりました'));
      const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
      if(i.cleanupOnly&&i.cleanupReceiptHash!==hash(JSON.stringify(h.transfer.read(i.project,i.task))))throw Error(lt('子の受領記録が変わりました'));
      if(h.removal.busy(i.project,i.task)||h.removal.locked(i.project))throw Error(lt`子作業の処理の終了待ち：${i.title}`);
      if(!t||!this.related(a,p,t))throw Error(lt('確認中に子作業・祖先の関係が変わりました'));
      const now=h.details(a,p,t,undefined,i.partial?'partial':'continue');
      if(this.blockers(now,s.keep).length||safety.item(h,now)!==i.safetyHash)throw Error(lt('確認中に子の成果が変わりました'));
      return {...now,keep:s.keep,choiceAtStart:t.integrateKeep,disposition:s.keep?(i.partial?'partial':'continue'):'cleanup',partial:s.keep&&i.partial,optional:s.keep?[]:now.optional.map(x=>x.id),allResults:true,branch:now.source?.branch,state:'待ち'};
    });
    const offered=d.items.map(i=>{const keep=b.mode==='selected'?i.keep:b.selected.find(s=>key(s)===key(i))?.keep??i.keep;return {...i,keep,noop:i.alreadyReceived?keep:i.noop};});
    const roots=b.mode==='single'?items.filter(i=>!items.some(p=>p.descendants.some(c=>key(c)===key(i)))):b.selected;
    const plan=selection.select(offered,b.mode,roots,lt,lt);
    if(plan.reason||plan.items.length!==items.length||plan.items.some(i=>!items.some(j=>key(i)===key(j))))throw Error(lt(plan.reason||'統合対象が不正です'));
    if(b.mode==='batch'){
      const expected=d.items.filter(i=>i.startable&&!i.noop).map(key);
      if(expected.length!==items.length||expected.some(k=>!items.some(i=>key(i)===k)))throw Error(lt('一括統合の対象が変わりました'));
    }else if(b.mode==='single'){
      const roots=items.filter(i=>!items.some(p=>p.descendants.some(c=>key(c)===key(i))));
      if(roots.length!==1||items.some(i=>i!==roots[0]&&(roots[0].keep||i.keep)))throw Error(lt('個別統合の対象が不正です'));
    }
    for(const i of items.filter(i=>!i.keep))for(const c of i.descendants){
      const child=items.find(j=>key(j)===key(c));
      if(!child&&b.mode==='selected')throw Error(lt`「${i.title}」を残さないには、下の「${c.title}」も選ぶか、「${i.title}」を［残す］にしてください`);
      if(!child||child.keep)throw Error(lt`「${i.title}」の下に残す子があります：${c.title}`);
    }
    if(d.sibling)for(const i of items)sibling.checkItem(h,a,h.read(b.project,b.task),i);
    // A sibling receipt keeps the child without changing its stored preference.
    for(const i of items)if(!d.sibling&&!i.questionBinding&&b.mode!=='selected'&&i.choiceAtStart!==i.keep){const p=a.all.find(p=>p.id===i.project),t=p.tasks.find(t=>t.id===i.task),next=this.updateChoice(p,t,i.keep);i.taskHash=next.completionHash;i.choiceAtStart=i.keep;}
    if(['single','selected'].includes(b.mode))items.sort((x,y)=>y.depth-x.depth);
    if(!d.sibling)continuation.archive(h.dir,old);
    const r={schemaVersion:2,kind:items.some(i=>i.partial)?'partial':'final',id:randomUUID(),project:b.project,task:b.task,target:a.target,items,at:at(),complete:false};
    const pendingMain=continuation.pendingMain(old);
    r.auto={by:'human',at:at(),mode:b.mode,keep:Object.fromEntries(items.map(i=>[key(i),i.keep])),order:{state:'none'},migrations:{},attempts:{},scope:items.map(scope),thenMain:a.target!==h.baseOf(a.p)&&!pendingMain&&b.thenMain!==false&&!items.every(i=>i.alreadyReceived),...(pendingMain?{pendingMain}:{}),targetHead:d.targetSnapshot?.head??null,mainHead:h.gitw.inspect(h.gitw.mainOf?.(a.target)||a.target)?.head};
    if(policy){r.assignmentPolicyHash=d.assignmentPolicyHash;r.auto.assignmentPolicy=policy;r.auto.assignmentPolicyHash=d.assignmentPolicyHash;}
    if(d.sibling){r.stoppedSibling=d.stoppedSibling;r.auto.thenMain=false;sibling.version(r,old?.siblingVersion??null);}
    h.save(r);h.tokens.delete(b.token);
    return {ok:true,partial:true,complete:false,id:r.id};
  }
  validate(r,{notSent=[],allowBusy=false}={}){
    require('./integration-sibling').assert(this.h,r);
    require('./task-future-hold').assertRecord(this.h,r);
    require('./integration-assignment').validate(r);
    const h=this.h,a=h.ancestor(r.project,r.task,{allowBusy});
    if(a.target!==r.target)throw Error(lt('統合先が変わりました'));
    for(const i of r.items){
      const s=r.auto.scope.find(s=>key(s)===key(i));
      if(!s||JSON.stringify(scope(i))!==JSON.stringify(s)||r.auto.keep[key(i)]!==i.keep)throw Error(lt('開始時の統合範囲が変わりました'));
      if(terminal(i))continue;
      // Formal receipt owns its continuation after it has begun. Its original
      // retention/cleanup checks handle moved records; do not compare a moved
      // child against the pre-receipt task hash or restart migration.
      const receipt=this.receiving(r,i);
      if(receipt){if(receipt.complete)this.verifyReceived(r,i,receipt);continue;}
      const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
      this.question(i,i.keep,r.id);
      if(!this.related(a,p,t)||t.integrateKeep!==i.choiceAtStart)throw Error(lt('子の関係・質問・保持選択が変わりました'));
      const organizing=Object.entries(r.auto.attempts).some(([k,x])=>!notSent.includes(k)&&x.phase==='organize'&&x.project===i.project&&x.task===i.task);
      if(organizing)continue; // Only this explicitly authorized organizer may refresh its scope.
      const now=h.details(a,p,t,r.id,i.partial?'partial':'continue',i.partial?i:undefined);
      if(now.taskHash!==i.taskHash||['source','files','results','remaining'].some(k=>JSON.stringify(now[k])!==JSON.stringify(i[k])))throw Error(lt('開始後に子の成果が変わりました'));
      for(const f of i.files)if(snapshot(f.path)!==f.fingerprint||f.mode!==undefined&&(fs.statSync(f.path).mode&0o777)!==f.mode)throw Error(lt('成果ファイルが変わりました'));
    }
    return a;
  }
  receiving(r,i){
    const x=this.h.transfer.read(i.project,i.task);
    return !i.partial&&x?.schemaVersion===2&&x.receiving&&x.integrating===r.id&&x.targetProject===r.project&&x.targetTask===r.task&&x.disposition===i.disposition&&x.integrated?.dir===r.target&&x.integrated?.commit===i.integrated?.commit?x:null;
  }
  verifyReceived(r,i,x){
    const h=this.h,fail=()=>{throw Error(lt('子の受領記録が変わりました'));};
    h.transfer.checkBundles(x);
    if(x.integrated?.commit&&!h.gitw.isAncestor(r.target,x.integrated.commit))fail();
    for(const f of x.files){noLinks(f.to);if(!exists(f.to)||hash(fs.readFileSync(f.to))!==f.digest||(fs.statSync(f.to).mode&0o777)!==f.mode)fail();}
    const file=h.store.taskFile(i.project,i.task);
    if(x.retained){const source=i.copy&&h.gitw.inspect(i.copy);if(!file||h.store.readTask(file).completionHash!==x.taskHash||i.copy&&(!source||source.status||source.head!==i.source?.head))fail();}
    else{
      if(file||i.copy&&(!i.copyTrashed||!exists(i.copyTrashed)||exists(i.copy)))fail();
      const record=path.join(h.removal.records,x.cleanup+'.json');noLinks(record);if(!exists(record))fail();
      const cleanup=JSON.parse(fs.readFileSync(record,'utf8'));if(cleanup.id!==x.cleanup||cleanup.project!==i.project||cleanup.task!==i.task)fail();
      for(const e of cleanup.entries){noLinks(e.from);noLinks(e.to);if(!e.moved||e.restored||exists(e.from)||!exists(e.to)||snapshot(e.to)!==e.fingerprint)fail();}
    }
  }
  async prepare(auto,r){
    this.validate(r);
    if(r.auto.prepared)return true;
    const pending=Object.entries(r.auto.attempts).find(([,a])=>['organize','order'].includes(a.phase));
    if(pending){
      const [k,a]=pending;
      if(a.organizeRepairReady){
        const recovery=require('./integration-organize-recovery'),old=r.auto.attempts[a.organizeRepair.previous];
        const proof=recovery.failure;
        if(!recovery.key(r,k,a)||JSON.stringify(proof(this.h,r,a.organizeRepair.previous,old,auto.savedCompletion(r,a.organizeRepair.previous,'organize')))!==JSON.stringify(a.organizeRepair.proof))throw Error('整理のやり直し前に証拠が変わりました。再送しません');
        delete a.organizeRepairReady;await auto.dispatchAttempt(r,a,k,this.organizeRequest(r,r.items.find(i=>key(i)===key(a)),k));return false;
      }
      if(a.retryReady){await auto.dispatchAttempt(r,a,k,a.request||this.organizeRequest(r,r.items.find(i=>i.project===a.project&&i.task===a.task),k));return false;}
      const row=auto.savedCompletion?.(r,k,a.phase);
      if(row){this.settled(auto,r,k,a.phase,row);return false;}
      if(!auto.pendingRequest?.(r,k,a.phase))throw Error(lt('委任の終了記録を確認できません。再送はしません'));
      return false;
    }
    for(const item of r.items.filter(i=>i.questionBinding)){
      const k=hash(r.id+'\0'+key(item)+'\0organize');
      if(r.auto.attempts[k]&&r.auto.attempts[k].organizeSkipped!=='partial-question')throw Error('質問待ちの子へ整理は送りません');
      r.auto.attempts[k]||={phase:'verified',project:item.project,task:item.task,at:at(),organizeSkipped:'partial-question'};
    }
    const i=r.items.find(i=>i.needsResults||i.remaining.status==='不明'||i.source?.status);
    if(i){
      const k=hash(r.id+'\0'+key(i)+'\0organize');
      if(r.auto.attempts[k])throw Error(lt('子の整理は依頼済みです。再送はしません'));
      r.auto.attempts[k]={phase:'organize',project:i.project,task:i.task,at:at()};i.state='整理中';this.h.save(r);
      await auto.dispatchAttempt(r,r.auto.attempts[k],k,this.organizeRequest(r,i,k));
      auto.notify(r);return false;
    }
    if(['batch','selected'].includes(r.auto.mode)&&r.items.length>1&&r.auto.order.state!=='done'){
      const k=hash(r.id+'\0order');if(r.auto.attempts[k])throw Error(lt('統合順は依頼済みです。再送はしません'));
      const inputs=r.items.map(i=>({key:i.project+'/'+i.task,route:i.route,depth:i.depth,paths:i.preview?.paths||[],overlaps:r.items.filter(j=>j!==i&&(j.preview?.paths||[]).some(p=>i.preview?.paths?.includes(p))).map(j=>j.project+'/'+j.task),codeAlready:!i.source?.status&&Boolean(i.source?.head&&this.h.gitw.isAncestor(r.target,i.source.head)),keep:i.keep,conflict:i.preview?.conflict||false}));
      r.auto.order={state:'intent',k,at:at()};r.auto.attempts[k]={phase:'order',project:r.project,task:r.task,at:at()};this.h.save(r);
      await auto.dispatchAttempt(r,r.auto.attempts[k],k,{project:r.project,task:r.task,title:lt('子作業の統合順を判断'),role:'司令塔',text:`[integration-auto:${k}:order]\n目的：開始済みの子統合の順番を判断する。\n読む：${JSON.stringify(inputs)}\nやる：差分の重複・依存関係を比較し、子孫が祖先より前となる順列を決める。\n条件：読むだけ。対象の追加/欠落/重複・変更・統合・委任なし。\n出力：[integration-order:${k}:<"project/task" のJSON配列>] と理由。\n次：番を終える。Hubが保存順で続ける。再依頼しない。`});auto.notify(r);return false;
    }
    for(const i of r.items){
      const rem=i.keep?i.remaining:{status:'なし',items:'なし',undecided:'なし',evidence:lt('残件は正式受領前に原文対応付きで親へ移管します')};
      i.review=i.partial?undefined:continuation.declaredReview(rem,i.source?.head);if(i.reportProjection)i.review.scope='報告だけの保存・受領：'+i.reportProjection.entries.map(e=>e.path).join('、')+'。元HEADは出典であり引継ぎメモは受領対象外';i.reviewAuthorization='start';i.signature=continuation.signature(i);i.state='待ち';
    }
    r.auto.scope=r.items.map(scope);r.auto.prepared=true;this.h.save(r);return true;
  }
  organizeRequest(r,i,k){
    if(i.questionBinding)throw Error('質問待ちの子へ整理は送りません');
    return {project:i.project,task:i.task,title:lt('統合する成果の整理'),organize:true,role:'コーディング',text:`[integration-auto:${k}:organize]\n目的：開始済み統合「${i.title}」の成果と残件を整理する。\n読む：この子の最新の作業ファイル・成果・保存状態。\nやる：未保存の変更をcommitし、## 成果を次の形式だけで1行1件に整理する。種類は「ファイル」「本体保存済み」「なし」の3つだけ。「作業用コピー保存済み」等の別名は禁止。例：- ファイル：project:作業/<作業ID>/確認結果.md（確認資料）、または - 本体保存済み：body:.@<実際の保存commit>（保存したコード）。所属する専用コピーの保存履歴も「本体保存済み」を使う。本体への反映済みと偽らず説明に専用コピーへの保存と記す。成果がない場合だけ - なし：<理由> とし、他の種類と併記しない。既存の成果と保存履歴を調べ、場所・commitを推測しない。## 残件申告にJSON {"status":"なし|あり","items":"原文の残件、なければなし","undecided":"判断待ち、なければなし","evidence":"確認資料"} を保存する。\n条件：未実施を済にしない。実AI・外部送信・課金・本体反映・子の削除なし。既存記録と原文は保全する。\n出力：保存HEAD・成果・残件をこの子の会話へ返す。\n次：番を終える。Hubが開始済みの統合を続ける。再委任しない。`};
  }
  organizeStart(request){
    const k=String(request.text||'').match(/^\[integration-auto:([a-f0-9]{64}):organize\]/)?.[1];
    const r=k&&this.h.pending().map(x=>this.h.read(x.project,x.task,x.id)).find(r=>r?.auto?.attempts?.[k]?.phase==='organize'),a=r?.auto?.attempts[k];
    if(!r||r.auto.stopped||a.project!==request.project||a.task!==request.task||a.delivery?.state!=='intent'||a.delivery.request!==request.requestKey||!require('./integration-organize-recovery').key(r,k,a))throw Error(lt('停止した統合の最新の記録を確認してください'));
    const context=this.validate(r),p=context.all.find(p=>p.id===a.project),t=p?.tasks.find(t=>t.id===a.task),i=r.items.find(i=>key(i)===key(a));
    if(!this.related(context,p,t)||t.question||t.integrateKeep!==i?.choiceAtStart)throw Error(lt('子の関係・質問・保持選択が変わりました'));
    this.resumeBaseline(r,context);
  }
  organizedItem(r,a,row){
    const i=r.items.find(i=>key(i)===key(a)),context=this.h.ancestor(r.project,r.task,{allowBusy:true}),p=context.all.find(p=>p.id===a.project),t=p?.tasks.find(t=>t.id===a.task);
    if(!i||a.phase!=='organize'||!this.related(context,p,t)||t.question||t.integrateKeep!==i.choiceAtStart)throw Error(lt('子の関係・質問・保持選択が変わりました'));
    let remaining;
    try{remaining=continuation.declaration(this.h.store.taskFile(p.id,t.id));}
    catch(e){throw Object.assign(Error('子の整理後の残件申告を確認できません：「## 残件申告」のJSON（status・items・undecided・evidence）を一つだけ保存してください：'+e.message),{code:'ORGANIZE_DECLARATION_INVALID',stage:'organize-validation'});}
    const now=this.h.details(context,p,t,r.id,i.partial?'partial':'continue');
    // Only this authorized organizer refreshes the current declaration. Ordinary
    // handoff previews retain their frozen declaration and file guards.
    now.remaining=remaining;now.needsRemaining=now.remaining.status==='不明';
    const blockers=this.blockers(now,i.keep);
    if(now.needsResults||now.needsRemaining){
      const reason=now.needsResults?(now.blockers||[]).filter(x=>x.includes('成果')||x.includes('保存済み')).join(' / '):'「## 残件申告」のJSON（status・items・undecided・evidence）を確認してください';
      throw Object.assign(Error('子の整理後の'+(now.needsResults?'成果の形式・保存証拠':'残件申告')+'を確認できません：'+reason),{code:'ORGANIZE_DECLARATION_INVALID',stage:'organize-validation'});
    }
    if(blockers.length||now.source?.status)throw Error(lt('子の整理後の保存・成果・残件申告を確認できません')+(blockers.length?'：'+blockers.join(' / '):''));
    const {current,rebase}=this.resumeBaseline(r,context);
    if(rebase){
      const saved=row?.integrationAuto?.saved,marker=row?.integrationAuto,canonical=require('./resource-scope').canonical;
      if(!marker?.closed||!require('./integration-organize-recovery').key(r,marker.key,a)||marker.phase!=='organize'||marker.limit||!saved?.head||saved.head!==current.head||!saved.dir||canonical(saved.dir)!==canonical(r.target))throw Error(lt('開始後に統合先HEADが変わりました'));
      const allowed=new Set([...i.files,...now.files].map(f=>path.resolve(f.path)));
      for(const owner of [{dir:p.dir,id:t.id},{dir:context.p.dir,id:context.t.id}]){
        allowed.add(path.join(owner.dir,'.ai','tasks',owner.id+'.md'));
        for(const ext of ['json','jsonl','rules.md','queue.json'])allowed.add(path.join(owner.dir,'.ai','chat',owner.id+'.'+ext));
      }
      if(this.h.gitw.changedBetween(r.target,r.auto.targetHead,current.head).some(rel=>!allowed.has(path.resolve(r.target,rel))))throw Error(lt('開始後に子の成果が変わりました'));
      Object.defineProperty(now,'organizeTargetHead',{value:current.head});
    }
    return now;
  }
  orderHead(r,k,row){
    const {current,rebase}=this.resumeBaseline(r);if(!rebase)return null;
    const marker=row?.integrationAuto,saved=marker?.saved,canonical=require('./resource-scope').canonical;
    if(k!==hash(r.id+'\0order')||!marker?.closed||marker.key!==k||marker.phase!=='order'||marker.limit||!saved?.head||saved.head!==current.head||!saved.dir||canonical(saved.dir)!==canonical(r.target))throw Error(lt('開始後に統合先HEADが変わりました'));
    const allowed=new Set();
    for(const owner of [{project:r.project,task:r.task},...r.items]){
      const p=this.h.store.readProject(owner.project);allowed.add(path.join(p.dir,'.ai','tasks',owner.task+'.md'));
      for(const ext of ['json','jsonl','rules.md','queue.json'])allowed.add(path.join(p.dir,'.ai','chat',owner.task+'.'+ext));
    }
    if(this.h.gitw.changedBetween(r.target,r.auto.targetHead,current.head).some(rel=>!allowed.has(path.resolve(r.target,rel))))throw Error(lt('開始後に子の成果が変わりました'));
    return current.head;
  }
  settled(auto,r,k,phase,row){
    const a=r.auto.attempts[k];if(!a||a.phase!==phase)return;
    if(row.error&&row.integrationAuto?.limit===true&&row.request&&auto.pendingRequest?.(r,k,phase,row.request))return;
    if(row.error||row.asks?.length)throw Error(row.error||lt('統合の判断待ちがあります'));
    if(phase==='order'){
      const prefix=`[integration-order:${k}:`,text=String(row.text||''),start=text.indexOf(prefix),end=text.indexOf(']]',start);
      if(start<0||end<0)throw Error(lt('統合順の判定を確認できません'));
      const keys=JSON.parse(text.slice(start+prefix.length,end+1));
      if(!Array.isArray(keys)||keys.length!==r.items.length||new Set(keys).size!==keys.length||keys.some(x=>!r.items.some(i=>i.project+'/'+i.task===x)))throw Error(lt('統合順の対象が一致しません'));
      const items=keys.map(k=>r.items.find(i=>i.project+'/'+i.task===k));
      for(let n=0;n<items.length;n++)for(const c of items[n].descendants)if(items.some(i=>key(i)===key(c))&&!items.slice(0,n).some(i=>key(i)===key(c)))throw Error(lt('子孫を先に統合してください'));
      const orderHead=this.orderHead(r,k,row);if(orderHead)r.auto.targetHead=orderHead;
      r.items=items;r.auto.order={...r.auto.order,state:'done',keys,by:{ai:row.ai,model:row.model},at:at(),reason:text};
    }else{
      const i=r.items.find(i=>i.project===a.project&&i.task===a.task),now=this.organizedItem(r,a,row);
      const keep=i.keep,choiceAtStart=i.choiceAtStart,disposition=i.disposition,partial=i.partial;
      Object.assign(i,now,{keep,choiceAtStart,disposition,partial,optional:keep?[]:now.optional.map(x=>x.id),allResults:true,branch:now.source?.branch,state:'待ち'});
      r.auto.scope=r.items.map(scope);
      if(now.organizeTargetHead)r.auto.targetHead=now.organizeTargetHead;
    }
    a.phase='verified';this.h.save(r);
  }
  migration(r,i){
    if(i.keep||this.receiving(r,i))return;
    const h=this.h,k=key(i),childFile=h.store.taskFile(i.project,i.task),parentFile=h.store.taskFile(r.project,r.task);
    const text=fs.readFileSync(childFile,'utf8'),parent=fs.readFileSync(parentFile,'utf8');
    const values=[...(i.remainingSteps||[]),...['items','undecided'].flatMap(k=>['なし',lt('なし')].includes(i.remaining[k])?[]:[i.remaining[k]])];
    const original=[...new Set(values.filter(Boolean))];
    if(!original.length)return;
    let m=r.auto.migrations[k];
    if(m){this.verifyMigration(r,i,m,parent,text);if(m.state==='intent'){m.state='done';h.save(r);}this.migratedReview(r,i,m);return;}
    const p=h.store.readProject(r.project),rel=path.join('.ai/work/integration-migrations',r.id+'-'+i.task+'.json'),file=path.join(p.dir,rel);
    const seen=new Set(),steps=original.flatMap((s,n)=>s.split(/\r?\n/).filter(line=>line&&!seen.has(line)&&(seen.add(line),true)).map(line=>`- [ ] 「${i.title}」から移管：${line}（${rel}#${n+1}）`));
    m={state:'intent',file,relative:rel,steps,mode:fs.statSync(childFile).mode&0o777,at:at(),childHash:hash(text),parentHash:hash(parent)};r.auto.migrations[k]=m;h.save(r);
    noLinks(file);fs.mkdirSync(path.dirname(file),{recursive:true});
    const bytes=JSON.stringify({project:i.project,task:i.task,title:i.title,completionHash:i.taskHash,sha256:hash(text),mode:fs.statSync(childFile).mode&0o777,text,remaining:i.remaining,original,steps},null,2);
    require('./integration-writes').write(file,()=>fs.writeFileSync(file,bytes,{flag:'wx',mode:fs.statSync(childFile).mode&0o777}));m.sha256=hash(bytes);h.save(r);
    const section=new RegExp('^## (?:' + sectionPattern('手順') + ')\\s*\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))', 'm');
    if(!section.test(parent))throw Error(lt('親の手順欄を確認できません'));
    if(hash(fs.readFileSync(parentFile))!==m.parentHash)throw Error(lt('移管中に親の記録が変わりました'));
    const next=parent.replace(section,s=>s.replace(/\s*$/,'')+'\n'+steps.join('\n')+'\n\n');
    const tmp=parentFile+'.'+randomUUID();noLinks(tmp);fs.writeFileSync(tmp,next,{flag:'wx',mode:fs.statSync(parentFile).mode&0o777});require('./integration-writes').write(parentFile,()=>fs.renameSync(tmp,parentFile));
    this.verifyMigration(r,i,m,fs.readFileSync(parentFile,'utf8'),text);m.state='done';h.save(r);
    this.migratedReview(r,i,m);
  }
  migratedReview(r,i,m){
    i.review=continuation.declaredReview({status:'なし',items:'なし',undecided:'なし',evidence:m.relative},i.source?.head);i.signature=continuation.signature(i);r.auto.scope=r.items.map(scope);this.h.save(r);
  }
  verifyMigration(r,i,m,parent,child){
    noLinks(m.file);
    if(!m.sha256||!exists(m.file)||hash(fs.readFileSync(m.file))!==m.sha256||(fs.statSync(m.file).mode&0o777)!==m.mode||hash(child)!==m.childHash)throw Error(lt('移管の結果が不明です。再送はしません'));
    if(m.steps.some(s=>parent.split('\n').filter(x=>x===s).length!==1))throw Error(lt('移管手順が不足または重複しています。再送はしません'));
    const b=JSON.parse(fs.readFileSync(m.file,'utf8'));
    if(b.project!==i.project||b.task!==i.task||b.text!==child||b.completionHash!==i.taskHash||JSON.stringify(b.steps)!==JSON.stringify(m.steps))throw Error(lt('移管原文が変わりました'));
  }
  policy(project,task,o){
    if(!o.integrating){for(const r of this.h.records(o.targetProject,o.targetTask))if(r.stoppedSibling||r.items?.some(i=>i.project===project&&i.task===task)&&require('./integration-sibling').read(this.h,r.project,r.task))throw Error('開始済みの受領記録から続けてください');return null;}
    const r=this.h.active?.id===o.integrating?this.h.active:this.h.read(o.targetProject,o.targetTask,o.integrating),i=r?.items.find(i=>i.project===project&&i.task===task);
    if(!r)throw Error('統合予約が変わりました');
    require('./integration-sibling').assert(this.h,r);
    if(!r?.auto?.mode||r.id!==o.integrating||!r.auto.prepared||!i||terminal(i)||i.disposition!==(o.partial?'partial':o.disposition))return null;
    const a=this.h.ancestor(r.project,r.task),p=a.all.find(p=>p.id===project),t=p?.tasks.find(t=>t.id===task);
    this.question(i,i.keep,r.id);
    if(!this.related(a,p,t)||t.completionHash!==i.taskHash||t.integrateKeep!==i.choiceAtStart)throw Error(lt('統合の移管承認が変わりました'));
    safety.assertTarget(this.h,a);
    let migrated=false;const m=r.auto.migrations[key(i)];
    if(!i.keep&&m){this.verifyMigration(r,i,m,fs.readFileSync(this.h.store.taskFile(r.project,r.task),'utf8'),fs.readFileSync(this.h.store.taskFile(project,task),'utf8'));migrated=m.state==='done';}
    return {related:true,migrated};
  }
}
module.exports={SimpleIntegration,scope};
