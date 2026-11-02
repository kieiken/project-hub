'use strict';
// Durable authorization, single dispatch, and one formal main merge. No CLI here.
const {lt}=require('./locale');
const {createHash,randomUUID}=require('node:crypto');
const {legacyRefusal,completedRefusal}=require('./integration-delivery');
const {childrenComplete,closed}=require('./task-continuation');
const sibling=require('./integration-sibling');
const done=i=>['片付け済み','受領済み','保持受領済み'].includes(i.state);
const stamp=()=>new Date().toISOString();
class IntegrateAuto {
  constructor({integrate,busy=()=>false,waitStatus,dispatch,mergeMain,notify=()=>{}}){Object.assign(this,{integrate,busy,waitStatus,dispatch,mergeMain,notify});this.active=false;integrate.siblingQuiescent=r=>Object.keys(r.auto?.attempts||{}).length>0&&Object.entries(r.auto?.attempts||{}).every(([k,a])=>{if(a.organizeSkipped==='partial-question'&&!a.request&&!a.delivery)return true;const phase=String(a.request?.text||'').match(/\[integration-auto:[a-f0-9]{64}:(code|review|organize|order)\]/)?.[1];if(!phase||a.delivery?.state!=='accepted'||this.pendingRequest?.(r,k,phase))return false;const row=this.savedCompletion?.(r,k,phase);return row?.integrationAuto?.closed===true&&row.integrationAuto.key===k&&row.integrationAuto.phase===phase&&[a.delivery.request,a.delivery.queueId].filter(Boolean).includes(row.request);});}
  stop(project,task,reason=lt('人が停止しました'),id){
    const evidence=reason instanceof Error?{code:reason.code,stage:reason.stage,paths:reason.paths}:{};if(reason instanceof Error)reason=reason.message;
    const r=id?this.integrate.read(project,task,id):this.integrate.records(project,task).findLast(r=>!r.complete&&!r.auto?.stopped)||this.integrate.read(project,task);if(!r?.auto||r.auto.stopped||r.auto.main?.state==='done')return false;
    r.auto.stopped={reason,at:stamp(),...evidence};this.integrate.save(r);this.notify(r);return true;
  }
  settled(o,row){
    let r;
    const marker=String(o.limitSwitch?.original||o.text||'').match(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/);
    if(!marker)return;
    r=this.integrate.pending().map(x=>this.integrate.read(x.project,x.task,x.id)).find(r=>r?.auto?.attempts?.[marker[1]]);
    if(r){try{sibling.assert(this.integrate,r);}catch{return;}}
    if(!r?.auto||r.abandoned||r.auto.stopped)return;
    try{require('./integration-assignment').completion(r,r.auto.attempts[marker[1]],row);}catch(e){this.stop(r.project,r.task,e,r.id);return;}
    if(['organize','order'].includes(marker[2])){try{this.integrate.simple.settled(this,r,marker[1],marker[2],row);}catch(e){this.stop(r.project,r.task,e,r.id);}return;}
    const a=r.auto.attempts[marker[1]];if(!a||a.phase!==marker[2])return;
    // Only a formal limit with its own queued/running successor may defer failure.
    if(row.error&&row.integrationAuto?.limit===true&&row.request&&this.pendingRequest?.(r,marker[1],marker[2],row.request))return;
    if(row.error||row.asks?.length){this.stop(r.project,r.task,row.error||lt('統合の判断待ちがあります'),r.id);return;}
    const head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
    if((!head&&!a.fileReview)||head?.status||this.integrate.gitw.merging(r.target)){this.stop(r.project,r.task,lt('解消後の保存を確認できません'),r.id);return;}
    if(marker[2]==='code'){
      const i=r.items.find(i=>i.project===a.project&&i.task===a.task);
      if(!i?.source?.head||!this.integrate.gitw.isAncestor(r.target,i.source.head)||!this.integrate.gitw.isAncestor(r.target,a.targetHead)){this.stop(r.project,r.task,lt('同じ衝突が解消されていません。再依頼はしません'),r.id);return;}
      a.phase='needs-review';a.reviewHead=head.head;i.state='検証中';
    }else{
      try{sibling.review(this.integrate,r,a);}catch(e){this.stop(r.project,r.task,e,r.id);return;}
      if(a.savedResults){try{this.verifySavedReview(r,a);}catch(e){this.stop(r.project,r.task,e,r.id);return;}}
      if(a.fileReview){try{require('./integration-review').verifyFiles(a.fileReview,r.target);this.integrate.simple.validate(r);}catch(e){this.stop(r.project,r.task,e,r.id);return;}}
      if((head?.head??null)!==a.reviewHead){
        try{this.refreshReview(r,a,marker[1],head.head);}catch(e){this.stop(r.project,r.task,e,r.id);return;}
        this.integrate.save(r);return;
      }
      if(!String(row.text||'').includes(`[integration-review:${marker[1]}:pass]`)||a.isolatedReview&&!this.isolatedCompletion(a,row)){this.stop(r.project,r.task,lt('独立確認の合格を確認できません'),r.id);return;}
      a.phase='verified';r.auto.targetHead=a.reviewHead;
    }
    this.integrate.save(r);
  }
  refreshReview(r,a,k,head,manual=false){
    if(r.stoppedSibling)throw Error('報告の確認範囲が変わりました。別の変更は承認しません');
    if(!manual&&(a.refreshCount||0)>=1)throw Error(lt('確認中に統合先HEADが再び変わりました。保存後に統合を再開してください'));
    if(![a.targetHead,a.reviewHead,a.sourceHead].every(h=>h&&this.integrate.gitw.isAncestor(r.target,h)))throw Error(lt('確認した履歴が現在の統合先にありません'));
    const next=createHash('sha256').update(a.project+'\0'+a.task+'\0'+a.sourceHead+'\0'+a.targetHead+'\0review\0'+head).digest('hex');
    if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
    a.phase='superseded';a.supersededBy=next;
    r.auto.attempts[next]={project:a.project,task:a.task,sourceHead:a.sourceHead,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,refreshCount:manual?0:(a.refreshCount||0)+1};
  }
  isolatedCompletion(a,row){
    const proof=row.integrationAuto?.isolation;
    return row.integrationAuto?.closed===true&&proof?.version===1&&proof.resumed===false&&Boolean(a.delivery?.request)&&proof.request===a.delivery.request&&(!a.savedResults||Boolean(proof.session))&&(!a.scopeRecovery||proof.session!==a.scopeRecovery.previousSession)&&(!a.artifactRecovery||proof.session!==a.artifactRecovery.previousSession);
  }
  verifySavedReview(r,a,seen=new Set()){
    if(seen.has(a))throw Error('Original insufficient scope request changed');seen.add(a);
    const i=r.items.find(i=>i.project===a.project&&i.task===a.task);
    require('./integration-review-results').verify(a.savedResults,this.integrate,r,i);
    if(a.savedResults.version===3){
      const previous=r.auto.attempts[a.previousAttempt],e=a.artifactRecovery,p=a.savedResults.priorReview;
      if(!e||r.auto.attempts[previous?.supersededBy]!==a||p?.attempt!==a.previousAttempt||p.text!==e.refusal||JSON.stringify(p.oldEvidence)!==JSON.stringify(e.oldEvidence)||JSON.stringify(p.request)!==JSON.stringify(previous?.request))throw Error('Original empty artifact review changed');
      require('./integration-review-supplement').verifyRecovery({...e,attempt:a.previousAttempt},previous,this.savedCompletion(r,a.previousAttempt,'review'),this.integrate,r);
    }
    if(a.evidenceRecovery)require('./integration-review-results').verifyRecovery(a.evidenceRecovery,this.savedCompletion(r,a.previousAttempt,'review'));
    if(a.scopeRecovery){
      const previous=r.auto.attempts[a.previousAttempt];
      if(!previous||previous.phase!=='superseded')throw Error('Original insufficient scope request changed');
      require('./integration-review-results').verifyScopeRecovery(a.scopeRecovery,previous,this.savedCompletion(r,a.previousAttempt,'review'));
      this.verifySavedReview(r,previous,seen);
    }
  }
  recoverReview(r,a,k,head){
    if(r.stoppedSibling)throw Error('別の子の確認範囲は変更しません');
    // A legacy review reused the implementation conversation. Keep its terminal
    // result and authorize a different, isolated check once; never resend it.
    if(a.isolatedReview||![a.targetHead,a.reviewHead,a.sourceHead].every(h=>h&&this.integrate.gitw.isAncestor(r.target,h)))throw Error(lt('確認した履歴が現在の統合先にありません'));
    const next=createHash('sha256').update(r.id+'\0'+k+'\0isolated-review-v1\0'+head).digest('hex');
    if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
    a.phase='superseded';a.supersededBy=next;
    r.auto.attempts[next]={project:a.project,task:a.task,sourceHead:a.sourceHead,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,contextRecovery:true,isolatedReview:true};
  }
  waiting(b){
    const out=this.waitStatus?this.waitStatus(b):this.busy(b)?[{kind:'busy',message:lt('AI・整理・確認が動いています')}]:[];
    return [...out,...(this.active||this.integrate.active?[{kind:'integration',message:lt('統合の処理が進行中です')}]:[])];
  }
  startWaiting(b){ return this.waiting(b); }
  waitingAsync(b){return Promise.resolve(this.waiting(b));}
  previewAsync(b){return require('./integration-read-worker').integration(this.integrate,this,b);}
  preview(b){
    const prior=this.integrate.readLane(b.project,b.task,b.sibling),fresh=b.simple&&(!prior||closed(prior));
    const waiting=this.startWaiting(fresh?{...b,selected:[]}:{...b,id:prior?.id});
    if(waiting.length)for(const [token,x]of this.integrate.tokens)if(x.value.project===b.project&&x.value.task===b.task)this.integrate.tokens.delete(token);
    // Read-only progress remains visible while busy, but supplies no execution token.
    const d={...this.integrate.preview(b.project,b.task,b.only,{allowBusy:waiting.length>0,issueToken:waiting.length===0,...(b.simple?{simple:true}:{}),assignments:b.assignments,sibling:b.sibling===true}),waiting};
    if(fresh)for(const i of d.items){const plan=require('../public/integration-selection').select(d.items,'single',[i]);i.waiting=this.waiting({...b,selected:plan.items.length?plan.items:[i]});}
    if(d.auto?.stopped){
      if(this.abandon&&!d.sibling)d.abandon=this.abandon.status(b.project,b.task);
      const r=this.integrate.read(b.project,b.task,d.id),status=this.resumeStatus(r,b.reviewSupplement);
      d.resumeAllowed=status.allowed;d.resumeMessage=status.message;
      if(status.organizeRecovery?.length){const x=this.integrate.tokens.get(d.token);if(x)x.value.organizeRecoveryHash=createHash('sha256').update(JSON.stringify(status.organizeRecovery)).digest('hex');}
      if(!status.allowed){d.blockers=[...(d.blockers||[]),status.message];this.integrate.tokens.delete(d.token);delete d.token;}
      else if(b.reviewSupplement){
        const spec=require('./integration-review-supplement').descriptor(b.reviewSupplement,r),x=this.integrate.tokens.get(d.token);
        if(x){x.value.reviewSupplement=spec;x.value.reviewSupplementProofHash=createHash('sha256').update(JSON.stringify(status.evidenceRecovery)).digest('hex');}
        d.reviewSupplement=spec;
      }
    }
    if(!b.sibling&&d.auto?.stopped){try{const pin=sibling.binding(this.integrate,b.project,b.task),side=sibling.read(this.integrate,b.project,b.task);d.siblingOption={allowed:!side?.complete,binding:pin,message:side?.complete?'別の子の報告は受領済みです。以前の停止記録は残っています':'以前の停止記録を残し、別の子の保存済み報告を受け取れます'};}catch(e){d.siblingOption={allowed:false,message:e.message};}}
    return d;
  }
  assertIdle(b,message){
    const waiting=b.mode?this.startWaiting(b):this.waiting(b);
    if(waiting.length){
      this.integrate.tokens.delete(b.token);
      const e=Error(message+'：'+waiting.map(x=>x.message).join(' / '));
      Object.assign(e,{code:'INTEGRATION_BUSY',stage:'waiting',waiting});throw e;
    }
  }
  apply(b){
    this.assertIdle(b,lt('統合の開始は待機中です'));
    return this.integrate.apply(b);
  }
  requestFor(r,k,a){
    if(a.request)return a.request;
    if(a.phase==='organize'&&this.integrate.simple?.organizeRequest){
      const i=r.items.find(i=>i.project===a.project&&i.task===a.task);if(i)return this.integrate.simple.organizeRequest(r,i,k);
    }
    return null;
  }
  resumeStatus(r,supplement){
    try{sibling.assert(this.integrate,r);}catch(e){return {allowed:false,message:e.message,retry:[]};}
    try{require('./task-future-hold').assertRecord(this.integrate,r);}catch(e){return {allowed:false,message:e.message,retry:[]};}
    try{require('./task-continuation').assertNoArchive(this.integrate.dir,r);}catch(e){return {allowed:false,message:e.message,retry:[]};}
    try{require('./integration-assignment').validate(r);}catch(e){return {allowed:false,message:e.message};}
    const retry=[],reviewRecovery=[],questionRecovery=[],evidenceRecovery=[],organizeRecovery=[];
    const blocked=message=>({allowed:false,message,retry:[]});
    if(supplement){try{const spec=require('./integration-review-supplement').descriptor(supplement,r);if(r.auto.attempts[spec.attempt]?.phase!=='review')throw Error('Supplemented review is not awaiting repair');}catch(e){return blocked(e.message);}}
    if(r?.auto?.main?.state==='intent')return blocked(lt('本体取り込みの結果が不明です。再送はしません'));
    if(r?.auto?.mode&&this.integrate.simple?.resumeBaseline){try{this.integrate.simple.resumeBaseline(r);}catch(e){return blocked(e.message);}}
    for(const [k,a]of Object.entries(r?.auto?.attempts||{})){
      if(['verified','superseded','needs-review'].includes(a.phase))continue;
      const row=this.savedCompletion?.(r,k,a.phase);
      if(this.pendingRequest?.(r,k,a.phase))continue;
      if(row){
        if(row.error)return blocked(row.error);
        if(a.savedResults){try{this.verifySavedReview(r,a);}catch(e){return blocked(e.message);}}
        if(a.phase==='organize'&&!row.asks?.length&&this.integrate.simple?.organizedItem){try{this.integrate.simple.organizedItem(r,a,row);}catch(e){
          try{
            const proof=require('./integration-organize-recovery').repair(this.integrate,r,k,a,row);
            if(!this.abandon)throw e;this.abandon.inspect(r.project,r.task);
            organizeRecovery.push({k,proof});continue;
          }catch(failure){return blocked(e.message+' / '+failure.message);}
        }}
        if(a.phase==='order'&&!row.asks?.length&&this.integrate.simple?.orderHead){try{this.integrate.simple.orderHead(r,k,row);}catch(e){return blocked(e.message);}}
        if(row.asks?.length){
          const proof=a.phase==='code'&&this.questionResolution?.(r,k,a,row),current=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
          if(!proof||!current||current.status||this.integrate.gitw.merging(r.target)||![a.targetHead,a.sourceHead,proof.answerHead].every(h=>this.integrate.gitw.isAncestor(r.target,h,proof.savedHead))||!this.integrate.gitw.isAncestor(r.target,proof.savedHead))return blocked(lt('統合の判断待ちがあります'));
          questionRecovery.push({k,proof});continue;
        }
        if(a.phase==='review'&&!String(row.text||'').includes(`[integration-review:${k}:pass]`)){
          try{
            const i=r.items.find(i=>i.project===a.project&&i.task===a.task),head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head;
            const proof=head===a.reviewHead&&(supplement?.attempt===k?require('./integration-review-supplement').recovery(this.integrate,r,i,a,k,row,supplement):require('./integration-review-results').recovery(this.integrate,r,i,a,k,row));
            if(proof){this.integrate.simple.validate(r);evidenceRecovery.push({k,proof});continue;}
          }catch(e){return blocked(e.message);}
          // Only a closed, accepted legacy check can migrate at the same HEAD.
          // An isolated failure requires an actual saved fix, never another try.
          const head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head;
          if(row.integrationAuto?.closed!==true||row.integrationAuto.key!==k||row.integrationAuto.phase!=='review'||a.delivery?.state!=='accepted'||a.isolatedReview&&head===a.reviewHead)return blocked(lt('独立確認の合格を確認できません'));
          if(!a.isolatedReview&&head===a.reviewHead)reviewRecovery.push(k);
        }else if(a.phase==='review'&&a.isolatedReview&&!this.isolatedCompletion(a,row))return blocked(lt('独立確認の合格を確認できません'));
        continue;
      }
      const proof=this.deliveryEvidence?.(r,k,a),legacy=legacyRefusal(r,k,a,proof),completed=completedRefusal(r,k,a,proof);
      if(!legacy&&!completed&&(a.delivery?.state!=='not-sent'||!proof?.complete||proof.sent))return blocked(lt('委任の送信結果が不明です。再開せず、受付・終了記録を確認してください'));
      const request=this.requestFor(r,k,a);if(!request||!this.probeRequest)return blocked(lt('委任の停止原因を解消してから最新の記録を確認してください'));
      try{this.probeRequest(request);}catch(e){return blocked(e.message);}
      retry.push({k,proof,legacy,completed});
    }
    if(supplement&&!evidenceRecovery.some(x=>x.k===supplement.attempt&&x.proof.artifactRecovery))return blocked('Supplement requires a closed, failed empty review');
    if(retry.length&&this.integrate.simple?.validate){try{this.integrate.simple.validate(r,{notSent:retry.map(x=>x.k)});}catch(e){return blocked(e.message);}}
    return {allowed:true,retry,reviewRecovery,questionRecovery,evidenceRecovery,organizeRecovery,message:organizeRecovery.length?'整理AIは正常終了しましたが成果・残件の検査で停止しました。［再開］で正しい形式を指定した整理を一度だけ新しく依頼します。対象や残す選択を変える場合は［中止して選び直す］を使ってください':retry.length?lt('委任は開始前に拒否されていました。修正済みの担当で再開できます'):lt('保存された受付・終了記録から続けます')};
  }
  async dispatchAttempt(r,a,k,request){
    sibling.assert(this.integrate,r);
    if(r.stoppedSibling&&(a.phase!=='review'||JSON.stringify(request.review?.stoppedSibling)!==JSON.stringify(r.stoppedSibling)))throw Error('別の子の確認範囲が一致しません');
    require('./task-future-hold').assertRecord(this.integrate,r);
    if(a.retryReady){
      // Authorization may survive a restart. Recheck immediately before the
      // send; a newly arrived receipt belongs to the original request.
      if(this.savedCompletion?.(r,k,a.phase)||this.pendingRequest?.(r,k,a.phase)){delete a.retryReady;this.integrate.save(r);return {deferred:true};}
      if(r.auto.mode&&(require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null)!==r.auto.targetHead)throw Error(lt('開始後に統合先HEADが変わりました'));
      const status=this.resumeStatus(r);
      if(!status.allowed||!status.retry.some(x=>x.k===k))throw Error(status.message||lt('委任の送信結果が不明です。再開せず、受付・終了記録を確認してください'));
    }
    request=require('./integration-assignment').bind(r,a,k,request);
    const id=randomUUID();
    delete a.retryReady;a.request={...request};a.delivery={state:'intent',request:id,at:stamp()};this.integrate.save(r);
    let result,error;
    try{result=await this.dispatch({...request,requestKey:id});}catch(e){error=e;}
    // A fast completion may have saved refreshed scope or a stop while dispatch
    // awaited startup. Never overwrite that newer record with the old snapshot.
    const fresh=this.integrate.read(r.project,r.task,r.id),current=fresh?.auto?.attempts[k];
    if(current?.delivery?.request===id){
      current.delivery={...(error?.delivery||result?.delivery||{state:'unknown'}),request:id,at:stamp(),...(error?{reason:error.message}:{})};
      this.integrate.save(fresh);
    }
    if(error)throw error;
    return result;
  }
  resume(b){
    this.assertIdle(b,lt('統合の再開は待機中です'));
    // Validate and prepare in memory first. A rejected resume never edits the record.
    const token=this.integrate.tokens.get(b.token)?.value,supplement=token?.reviewSupplement;
    if(b.reviewSupplement&&JSON.stringify(b.reviewSupplement)!==JSON.stringify(supplement))throw Error('Review supplement differs from preview');
    const status=this.resumeStatus(this.integrate.read(b.project,b.task,token?.id),supplement);
    if(!status.allowed)throw Object.assign(Error(status.message),{code:'INTEGRATION_DELIVERY_BLOCKED'});
    if((token?.organizeRecoveryHash||null)!==(status.organizeRecovery.length?createHash('sha256').update(JSON.stringify(status.organizeRecovery)).digest('hex'):null))throw Error('確認中に整理の検査停止の証拠が変わりました');
    if(supplement&&token.reviewSupplementProofHash!==createHash('sha256').update(JSON.stringify(status.evidenceRecovery)).digest('hex'))throw Error('Review supplement differs from preview');
    const r=this.integrate.resumeRecord(b),head=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)}).head;
    for(const {k,proof} of status.organizeRecovery){
      const recovery=require('./integration-organize-recovery'),a=r.auto.attempts[k];
      const fresh=recovery.repair(this.integrate,r,k,a,this.savedCompletion(r,k,'organize'));
      if(JSON.stringify(fresh)!==JSON.stringify(proof))throw Error('整理の検査停止の証拠が変わりました');
      const next=recovery.next(r,k);a.phase='superseded';a.supersededBy=next;a.organizeFailure=proof;
      r.auto.attempts[next]={phase:'organize',project:a.project,task:a.task,at:stamp(),organizeRepair:{previous:k,proof,by:'human',at:stamp()},organizeRepairReady:true};
    }
    for(const {k,proof} of status.evidenceRecovery){
      const a=r.auto.attempts[k],i=r.items.find(i=>i.project===a.project&&i.task===a.task),row=this.savedCompletion(r,k,'review'),fresh=proof.artifactRecovery?require('./integration-review-supplement').recovery(this.integrate,r,i,a,k,row,supplement):require('./integration-review-results').recovery(this.integrate,r,i,a,k,row);
      if(JSON.stringify(fresh)!==JSON.stringify(proof))throw Error('Saved result review evidence changed');
      const next=createHash('sha256').update(r.id+'\0'+k+'\0'+(proof.artifactRecovery?'artifact-supplement-v1':proof.scopeRecovery?'saved-results-scope-v1':'saved-results-v1')+'\0'+proof.savedResults.sha256).digest('hex');
      if(r.auto.attempts[next])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
      a.phase='superseded';a.supersededBy=next;
      r.auto.attempts[next]={project:a.project,task:a.task,targetHead:a.targetHead,reviewHead:head,phase:'needs-review',previousAttempt:k,...(proof.artifactRecovery?{artifactRecovery:{oldEvidence:proof.oldEvidence,completionHash:proof.completionHash,deliveryHash:proof.deliveryHash,requestHash:proof.requestHash,previousSession:proof.previousSession,refusal:proof.refusal}}:proof.scopeRecovery?{scopeRecovery:{oldEvidence:proof.oldEvidence,completionHash:proof.completionHash,savedResultsHash:proof.savedResultsHash,deliveryHash:proof.deliveryHash,requestHash:proof.requestHash,previousSession:proof.previousSession}}:{evidenceRecovery:{oldEvidence:proof.oldEvidence,completionHash:proof.completionHash}}),savedResults:proof.savedResults,isolatedReview:true};
    }
    for(const {k,proof} of status.questionRecovery){
      const a=r.auto.attempts[k],i=r.items.find(i=>i.project===a.project&&i.task===a.task);
      a.codeQuestionResolution={...proof,delivery:{...a.delivery},authorizedAt:stamp(),reviewHead:head};
      a.phase='needs-review';a.reviewHead=head;i.state='検証中';
    }
    for(const [k,a]of Object.entries(r.auto.attempts))if(a.phase==='review'){
      if(a.reviewHead!==head)this.refreshReview(r,a,k,head,true);
      else if(status.reviewRecovery.includes(k))this.recoverReview(r,a,k,head);
    }
    for(const x of status.retry){const a=r.auto.attempts[x.k];a.deliveryHistory=[...(a.deliveryHistory||[]),{delivery:a.delivery||null,proof:x.proof,legacy:x.legacy,...(x.completed?{completedRefusal:true}:{}),authorizedAt:stamp(),by:'human'}];a.request=this.requestFor(r,x.k,a);a.retryReady=true;}
    this.integrate.save(r);this.integrate.tokens.delete(b.token);this.notify(r);
    return {ok:true,resumed:true,partial:!r.complete,complete:r.complete,thenMain:false,id:r.id};
  }
  async issue(r,i,a,k,phase){
    sibling.assert(this.integrate,r);
    if(r.stoppedSibling&&phase!=='review')throw Error('別の子の報告では衝突解消や製品修正を開始しません');
    if(phase==='review'&&!i.source&&(a.savedResults||i.results?.some(x=>x.kind==='本体保存済み'))){
      if(a.savedResults)this.verifySavedReview(r,a);
      else a.savedResults=require('./integration-review-results').collect(this.integrate,r,i,{scoped:true});
    }
    // Save intent BEFORE delegation. A crash/unknown response never reissues it.
    a.phase=phase;a.at=stamp();if(phase==='review')a.isolatedReview=true;this.integrate.save(r);
    const receiptOnly=a.savedResults?.version===3?`\n補完確認：旧不合格の指摘をすべて照合し、成果の保管・受領と未済の移管だけを判定する。元の残す選択は ${i.keep}（${i.disposition}）のまま。旧案内の「残す」との差異を確認し、選択を変更しない。保存実装の独立合格・本体反映・公開は未済。通常依頼のpass_artifact_receipt_onlyを正式合格へ代用しない。`:'';
    const request={project:r.project,task:r.task,title:phase==='code'?lt`ぶつかりを解消：${i.title}`:lt`統合後の独立確認：${i.title}`,
      ...(phase==='review'?{isolatedReview:true}:{}),
      ...(phase==='review'?{review:{key:k,integrationId:r.id,...(r.stoppedSibling?{stoppedSibling:r.stoppedSibling,...(i.reportProjection?{reportProjection:i.reportProjection}:{})}:{}),targetHead:a.targetHead,reviewHead:a.reviewHead,sourceHead:i.source?.head,...(a.fileReview?{fileReview:a.fileReview}:{}),...(a.savedResults?{savedResults:a.savedResults}:{})}}:{}),
      role:phase==='code'?'コーディング':'チェック',text:phase==='code'?`[integration-auto:${k}:code]\n目的：開始済み統合「${i.title}」を保存済み範囲で解消する。\n読む：統合先 ${r.target}、子HEAD ${i.source.head}、衝突パス ${JSON.stringify(i.conflictPaths||[])}。\nやる：同じ統合先で子HEADをmergeし、両側の意図を保って解消、関連試験と日繁の版・履歴を照合しcommitする。\n条件：新コピー・範囲追加・管理記録変更・本体適用・起動・pushなし。判断が必要なら質問して停止。\n出力：保存commitと試験結果をこの会話へ返す。\n次：番を終える。Hubが独立確認と正式受領を続ける。再委任しない。`:
        `[integration-auto:${k}:review]\n目的：統合差分を独立確認する。${r.stoppedSibling?'今回の報告差分 '+a.targetHead+'..'+a.reviewHead+' の保管・受領だけを判定する。旧停止統合 '+r.stoppedSibling.id+' は未完了のまま対象外。旧取り込みコードの合格・破棄・本体反映・Windows安全を認定しない。静的検査用のスクリプトも実行しない。':''}${receiptOnly}\n読む：${a.savedResults?'保存済み成果の申告原文・保存commit・成果manifest・関連試験原物（saved-resultsとoriginal）。製品差分0でも確認対象はこの成果一式。review-scopeのプロジェクト・作業・規則原文（SHAと行番号）と実保存履歴も読む':a.fileReview?'Gitのない本体でのファイル成果一式（保存差分原物のmanifestと本文）':r.target+' の '+a.targetHead+'..'+a.reviewHead+'、子 '+(i.source?.head||'ファイル成果のみ')}、直前の試験結果。\nやる：双方の機能と保存済み範囲、関連試験の意味と成功を照合する。確認する言語・版・履歴は当該プロジェクト/作業/規則の原文と実成果から根拠の行番号付きで判断する。日繁要件や成果がある場合は双方を照合し、要求・資料不足や不明を対象外にせず要修正とする。Hub共通の依頼文だけで別プロジェクトへ日繁履歴を追加要求しない。\n条件：読むだけ。修正・委任・本体取込・新版起動なし。要修正なら理由だけ返す。\n出力：確認範囲の原文根拠と判定。合格した時だけ [integration-review:${k}:pass] を返す。\n次：番を終える。Hubが正式受領${r.auto.thenMain?'と保持本体取込':'を続け、本体反映は別に確認'}する。`};
    await this.dispatchAttempt(r,a,k,request);this.notify(this.integrate.read(r.project,r.task,r.id));
  }
  async tick(){
    if(this.active||this.integrate.active||this.busy())return;
    this.active=true;
    try{
      for(const entry of this.integrate.pending()){
        let r=this.integrate.read(entry.project,entry.task,entry.id);if(!r?.auto||r.abandoned||r.auto.stopped||childrenComplete(r)&&r.auto.main?.state==='done')continue;
        try{
          sibling.assert(this.integrate,r);
          require('./integration-assignment').validate(r);
          require('./task-future-hold').assertRecord(this.integrate,r);
          if(this.busy(r))continue;
          const context=this.integrate.ancestor(r.project,r.task);
          if(context.t.question||context.t.state==='上限で停止')continue;
          if(context.t.mergeExcluded)throw Error(lt('取り込み対象から外されています'));
          const current=r.auto.mode?require('./integration-safety').target(this.integrate,context):require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)});
          require('./integration-safety').assertTarget(this.integrate,context);
          if(r.auto.mode){if(!await this.integrate.simple.prepare(this,r))continue;}
          for(const scope of r.auto.scope){
            const i=r.items.find(i=>i.project===scope.project&&i.task===scope.task);
            if(!i||JSON.stringify(i.source)!==JSON.stringify(scope.source)||i.taskHash!==scope.taskHash||JSON.stringify(i.files)!==JSON.stringify(scope.files)||JSON.stringify(i.results)!==JSON.stringify(scope.results)||JSON.stringify(i.review)!==JSON.stringify(scope.review)||i.disposition!==scope.disposition)throw Error(lt('開始時の統合範囲が変わりました'));
          }
          if(!r.complete){
            const d=r.auto.mode?{blockers:[],recover:null}:this.integrate.resumePreview(context,r);
            if(d.blockers.length)throw Error(d.blockers.join(' / '));
            if(d.recover)throw Error(lt('開始後に子または統合先が変わりました'));
            const pending=Object.entries(r.auto.attempts).find(([,a])=>!['verified','superseded'].includes(a.phase));
            if(pending){
              const [k,a]=pending,i=r.items.find(i=>i.project===a.project&&i.task===a.task);
              if(a.retryReady){await this.dispatchAttempt(r,a,k,a.request);break;}
              if(a.phase==='needs-review'){await this.issue(r,i,a,k,'review');break;}
              // Saved outstanding request must settle before any receipt.
              // After restart the same conversation/queue owns it. If neither exists,
              // the server's pendingRequest hook identifies ambiguity, never repeats.
              const completion=this.savedCompletion?.(r,k,a.phase);
              if(completion){this.settled({project:r.project,task:r.task,text:`[integration-auto:${k}:${a.phase}]`},completion);continue;}
              if(!this.pendingRequest?.(r,k,a.phase))throw Error(lt('委任の終了記録を確認できません。再送はしません'));
              continue;
            }
            if(current.head!==r.auto.targetHead)throw Error(lt('開始時の統合先HEADがありません'));
            // A saved conflict is delegated once; do not repeat the failed merge.
            if(!r.items.some(i=>i.state==='衝突')){
              for(const a of Object.values(r.auto.attempts))if(a.savedResults&&a.phase==='verified'&&!done(r.items.find(i=>i.project===a.project&&i.task===a.task)))this.verifySavedReview(r,a);
              this.integrate.active=r;
              try{this.integrate.run(r);}finally{this.integrate.active=null;}
            }
            r=this.integrate.read(r.project,r.task,r.id);r.auto.targetHead=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null;this.integrate.save(r);
            const checking=r.auto.mode&&r.items.find(i=>i.state==='検証待ち');
            if(checking){const k=createHash('sha256').update(r.id+'\0'+checking.project+'\0'+checking.task+'\0review\0'+r.auto.targetHead).digest('hex');
              if(r.auto.attempts[k])throw Error(lt('同じHEADの確認は依頼済みです。再送はしません'));
              const a={project:checking.project,task:checking.task,sourceHead:checking.source?.head,targetHead:checking.integrated?.previousTargetHead||r.auto.targetHead,reviewHead:r.auto.targetHead,...(r.stoppedSibling?{phase:'needs-review'}:{})};if(!r.auto.targetHead)a.fileReview=require('./integration-review').filesEvidence({dir:r.target,files:[this.integrate.store.taskFile(r.project,r.task),this.integrate.store.taskFile(checking.project,checking.task),...checking.files.map(f=>f.path),...checking.move.map(f=>f.path)].filter(f=>typeof f==='string')});r.auto.attempts[k]=a;checking.state='検証中';await this.issue(r,checking,a,k,'review');break;}

            const i=r.items.find(i=>i.state==='衝突');
            if(i){
              const targetHead=require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)}).head;
              const prior=Object.entries(r.auto.attempts).find(([,a])=>a.project===i.project&&a.task===i.task&&a.sourceHead===i.source.head&&a.targetHead===targetHead);
              if(prior)throw Error(lt('同じ衝突が解消されていません。再依頼はしません'));
              const k=createHash('sha256').update(i.project+'\0'+i.task+'\0'+i.source.head+'\0'+targetHead).digest('hex');
              const a={project:i.project,task:i.task,sourceHead:i.source.head,targetHead};r.auto.attempts[k]=a;i.state='解消中';
              await this.issue(r,i,a,k,'code');break;
            }
          }
          if(r.complete&&(require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head??null)!==r.auto.targetHead)throw Error(lt('開始後に統合先HEADが変わりました'));
          if(r.complete&&r.auto.thenMain&&r.auto.main?.state!=='done'){
            if(r.auto.main?.state==='intent')throw Error(lt('本体取り込みの結果が不明です。再送はしません'));
            if(['not-sent','aborted'].includes(r.auto.main?.state))throw Error(r.auto.main.reason||lt('本体取り込みの前提を確認できません'));
            if(this.busy(r))continue;
            if(!r.items.every(done))throw Error(lt('子の正式受領が残っています'));
            // Only the formal operation boundary can mark this as sent. A
            // preflight refusal is durable not-sent; a sent/unknown result is
            // still an intent across restarts and cannot be retried.
            let started=false,out;
            const begin=()=>{if(started)throw Error(lt('本体取り込みの結果が不明です。再送はしません'));r.auto.main={state:'intent',sourceHead:require('./integration-safety').target(this.integrate,{target:r.target,p:this.integrate.store.readProject(r.project)})?.head,at:stamp()};this.integrate.save(r);started=true;};
            try{out=await this.mergeMain(r,{begin});if(!out?.ok||!out.retained)throw Object.assign(Error(out?.error||lt('本体取り込みの結果が不明です。再送はしません')),{delivery:out?.delivery});}
            catch(e){if(!started||['not-sent','aborted'].includes(e.delivery?.state)){r.auto.main={...r.auto.main,state:!started?'not-sent':e.delivery.state,reason:e.message,...(e.delivery?{delivery:e.delivery}:{}),at:stamp()};this.integrate.save(r);}throw e;}
            r.auto.main={...r.auto.main,state:'done',main:out.main};this.integrate.save(r);this.notify(r);
          }else if(r.complete&&!r.auto.thenMain){r.auto.main={state:'done',skipped:true};this.integrate.save(r);this.notify(r);}
        }catch(e){this.stop(r.project,r.task,e,r.id);}
      }
    }finally{this.active=false;}
  }
}
module.exports={IntegrateAuto};
