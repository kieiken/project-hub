'use strict';

module.exports = function createQueueEngine(ctx) {
  const { getDelegateCompletedError, getLogFile, ROOT, accountFor, accounts, getAiTools, getAppUpdate, assertWorkspaceIdle, autoTick, chat, getChatEnded, getChats, codexFastFor, crypto, delegateTerminalError, getDiscussion, discussionRuntime, executionGate, getFreetalkHistory, fs, gitw, getIdeaDispatch, getIdeaRunner, ideas, getIntegrateAuto, integrationPolicyRequest, integrationReviewPrompt, isolatedReviewDir, launch, license, licenseGuard, limitBackup, capacityBackup, assertCapacityHandoff, limitEvidence, limitIdentity, limitRoutingEnabled, lt, modelError, modelPolicy, getModelView, path, permCmd, queueActions, getQueueRetreat, readLog, record, refreshLimitEvidence, requestAccount, getRestartControl, getResultsGate, getRoleReview, roleReviewLimit, roleReviewRuntime, roles, rolesData, selectionPrompt, send, specialMode, startDir, stopControl, store, getTaskIntegrate, taskPrompt, usage, verifyIntegrationAssignmentSend, verifyIntegrationReviewSend, webchatActive, workDir } = ctx;

  function createChatRunner() {
  return new chat.ChatRunner({stopControl,queueGuard:o=>(getQueueRetreat())?.guard(o),prepareContext:o=>{
    if(o.project==='freetalk'||o.readOnly||o.automation)return o;
    const token=o.ideaRecord?.token||crypto.randomUUID();
    const instruction=`\n別の改善を思いついた時は原文だけ台帳へ残せます。作る許可は付与しません。POST /api/ideas/add (Hubと同じ接続先), headers X-Hub:1（ローカル認証は curl -H @"$HUB_HEADERS" を使用。秘密を本文に書かない） / X-Idea-Record:${token} / Content-Type:application/json, body {project:${JSON.stringify(o.project)},opId:UUID,text:原文,intent:record}。送信識別は再送時も同じにし、結果不明ならreceiptを照合する。`;
    return {...o,ideaRecord:{token},basePrompt:(o.basePrompt||'')+instruction};
  }, spoolRoot:path.join(ROOT,'_hub','cli-runs'),onAdoptEnd:(o,row)=>{if(!o.automation&&!o.discussionTurn&&!o.isolatedReview&&!o.selectionOnly&&row.asks?.length)store.updateTask(o.project,o.task,{state:'返事待ち',question:row.asks.map(a=>a.question).join(' / ').slice(0,300)});(getChatEnded())(o.project,o.task);}, dirOf: id => { const p = store.readProject(id); return p ? p.dir : ''; },
    delegates: (p, t) => [...readLog(5000), ...readLog(5000, (getLogFile()).replace(/\.jsonl$/, '.old.jsonl'))].filter(r => r.project === p && r.task === t),
    permFor: permCmd,
    limitBackup: limitBackup,
    capacityBackup,
    limitIdentity: o => limitIdentity(rolesData(), o),
    accountFor, fastFor: codexFastFor,
    onSettled: async (o,row) => { if(o.automation){await (getIdeaRunner()).settled(o,row);return;} if(discussionRuntime.isRequest(o.request)) { await (getDiscussion())?.settled(o,row); return; } if(roleReviewRuntime.isRequest(o.request)) { await (getRoleReview())?.settled(o,row); return; } (getIntegrateAuto()).settled(o,row);setImmediate(async()=>{
      try{if(stopControl.held({project:o.project,task:o.task}))return;stopControl.assert(o,o.stopTicket);await (getChats()).assertHandoffReadyAsync(o.project,o.task);stopControl.assert(o,o.stopTicket);if(stopControl.held({project:o.project,task:o.task}))return;}catch{return;}
      if(o.selectionOnly){void autoTick(o.project,o.task);return;}
      void (getIntegrateAuto()).tick();if(!o.isolatedReview)void (getResultsGate()).trigger(o.project,o.task,{row,organized:Boolean(o.resultsOrganize)}).catch(e=>record('results-organize-error',{project:o.project,task:o.task},{error:e.message}));
    }); },
    limitHold: o => Boolean(discussionRuntime.isRequest(o.request) || integrationPolicyRequest(o)),
    limitPreflight: o => discussionRuntime.isRequest(o.request) ? limitEvidence.active(o.account || 'default',launch.flagFor(o.ai,o.model),true) : integrationPolicyRequest(o) ? limitEvidence.active(o.account || 'default',launch.flagFor(o.ai,o.model)) : limitRoutingEnabled() || roleReviewRuntime.isRequest(o.request) ? roleReviewLimit(o) : null,
    limitTarget: o => roleReviewLimit(o),
    beforeQueued: async o => { void license.prepare(); await refreshLimitEvidence(o); assertCapacityHandoff(o); },
    startBarrier:o=>{stopControl.assert(o,o.stopTicket);executionGate.assert({dir:o.dir||store.readProject(o.project)?.dir,owner:'chat:'+o.project+':'+o.task});if(o.automation&&o.automation.kind!=='idea')throw Error('不明な自動実行は開始しません');},
    beforeSend:o=>o.automation?(getIdeaDispatch()).verify(o):verifyIntegrationReviewSend(o),
    beforeAdopt:o=>{if(o.automation)(getIdeaDispatch()).verify(o,{adoption:true});},
    startGate:(o,{adoption})=>{if(o.automation)(getIdeaDispatch()).verify(o,{adoption});executionGate.acquire({dir:o.dir,owner:'chat:'+o.project+':'+o.task,kind:o.readOnly?'frozen-review':'write',adoption});},
    endGate:o=>executionGate.release('chat:'+o.project+':'+o.task),
    onHandoffError:(o,e,run)=>executionGate.block('chat-handoff:'+run,o.dir,'会話の終了保存の復旧が必要です：'+e.message),
    onHandoffRecovered:(o,run)=>executionGate.unblock('chat-handoff:'+run),
    afterCompleted:o=>{if((getIdeaRunner()))for(const p of store.listProjects())if(p.id!=='freetalk'&&ideas.readRegistry().projects[p.id])(getIdeaRunner()).wake(p.id);},
    onStop:(project,task)=>{if(project==='freetalk'||store.readProject(project)?.kind==='freetalk')return;const d=ideas.read(project);if(d.projectUid!=='uninitialized'&&(d.settings.lane?.task===task||Object.values(d.runs).some(r=>!r.closed&&r.task===task)))ideas.auto(project,{opId:require('../idea-utils').uuid(),settingsRev:d.settings.rev,enabled:false});},
    onLimit: o => {
      try { limitEvidence.record(o,o.discussionTurn?(getDiscussion()).limitModels():undefined,discussionRuntime.isRequest(o.request)); }
      catch (e) { record('limit-save-error', o); throw e; }
      void usage.status(true, { [o.ai]: o.account || 'default' }).catch(() => {});
    },
    onFableSuccess: started => limitEvidence.success(started),
    refreshQueued: o => {
      const p = store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
      if (!p || !t) throw Error(lt('作業が見つかりません'));
      if(o.automation)return (getIdeaDispatch()).refresh(o);
      if(discussionRuntime.isRequest(o.request)){(getDiscussion()).verify(o);return {dir:isolatedReviewDir(p,t),basePrompt:discussionRuntime.basePrompt,policy:discussionRuntime.basePrompt};}
      if(roleReviewRuntime.isRequest(o.request)){(getRoleReview()).verify(o);return {dir:isolatedReviewDir(p,t),basePrompt:roleReviewRuntime.basePrompt,policy:roleReviewRuntime.basePrompt};}
      verifyIntegrationReviewSend(o); // Reject lost review classification before workspace preparation too.
      if(o.selectionOnly)return {dir:p.dir,basePrompt:selectionPrompt(p),policy:selectionPrompt(p)};
      if(o.isolatedReview)return {dir:isolatedReviewDir(p,t),basePrompt:integrationReviewPrompt(p,t)};
      if(o.readOnly)return {dir:p.dir,basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。')};
      const dir = o.dir && fs.existsSync(o.dir) ? o.dir : workDir(p, t).dir;
      if (!dir || !fs.existsSync(dir)) throw Error(lt('作業場所を用意できませんでした'));
      return { dir, policy: modelPolicy(p, t), basePrompt: taskPrompt(p, t, store.taskFile(p.id, t.id), dir, 'chat', undefined, o) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。') };
    },
    canStart: (ai, model, o) => {
      try{executionGate.assert({dir:o?.dir||store.readProject(o?.project)?.dir,owner:'chat:'+o?.project+':'+o?.task});if(o?.automation)(getIdeaDispatch()).verify(o);}catch(e){return e.message;}
      if (o && !discussionRuntime.isRequest(o.request) && (getDiscussion())?.active(o.project,o.task)) return '話し合いが進行中です。停止または完了後に送ってください';
      if ((getAppUpdate()).applying()) return (getAppUpdate()).busyMessage();
      if ((getRestartControl())?.committed) return lt('再起動を開始しています');
      if ((getAiTools()).isOperating(ai)) return Object.assign(Error(lt('AI の更新・モデル再取得が進行中です')),{code:'HUB_AI_MAINTENANCE'});
      const invalid=modelError(ai,model); if(invalid)return invalid;
      if (o && (getModelView()).special().enabled && limitEvidence.forRequest({ ...o, ai, model })) return Object.assign(Error(lt('特殊モードのAIが上限中です。解除後に再開してください')),{code:'HUB_LIMIT_WAIT'});
      if(o) { const p=store.readProject(o.project), t=p?.tasks.find(t=>t.id===o.task);
        if(!p || !t)return lt('作業が見つかりません');
        if(p.kind==='freetalk' && (getFreetalkHistory()).state(t.id).migrated)return lt('移行済みの話題は読み取り専用です');
        if(o.resultsRecoveryHash && t.completionHash!==o.resultsRecoveryHash)return lt('成果整理の開始前に子作業が変わりました');
        if(o.requireModel && t.state === '完了' && !o.resultsRecoveryHash)return (getDelegateCompletedError());
        if(o.requireModel) {const blocked=delegateTerminalError(p.id,t.id);if(blocked)return blocked;}
        try { accounts.available(ai, o.account || 'default', { forWork: true }); } catch (e) { return e.message; }
        try {assertWorkspaceIdle(p,t,false);} catch(e) {return e.message;}
      }
      return '';
    } });
  }

  function createQueueRetreat() {
  return new (require('../queue-retreat').QueueRetreat)({ideas,chats: (getChats()),actions:queueActions,related:(p,t,q)=>{
    const a=(getTaskIntegrate()).read(p,t)?.auto;
    return Object.values(a?.attempts||{}).some(x=>[x.delivery?.request,x.delivery?.queueId].some(id=>id&&[q.id,q.request].includes(id)));
  }});
  }

  async function dispatchAfterWebchat(j) {
    if(stopControl.held({project:j.project,task:j.task}))return;
    const next = (getChats()).queue(j.project, j.task)[0];
    if (!next || next.stopHeld || next.error || next.limitWaiting || (getRestartControl())?.committed || webchatActive(j.project,j.task)) return;
    const p = store.readProject(j.project); if (!p) return;
    try {
      const r = await (getChats()).sendQueued({ ...next, project:p.id, task:j.task, pdir:p.dir, dir:undefined,
        request:next.id, mode:'queued', onEnd:row=>{
          if(!next.isolatedReview && row.asks?.length) store.updateTask(p.id,j.task,{state:'返事待ち',question:row.asks.map(a=>a.question).join(' / ').slice(0,300)});
          (getChatEnded())(p.id,j.task);
        } });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした'));
      (getChats()).unqueue(p.id,j.task,next.id);
    } catch(e) {
      if ((getChats()).queue(p.id,j.task).some(q=>q.id===next.id)) (getChats()).setQueue(p.id,j.task,(getChats()).queue(p.id,j.task).map(q=>q.id===next.id?{...q,error:e.message}:q));
    }
  }

  function delegateRequest(b,res,options={}) {
    return require('../request-delivery').createDelivery({license,licenseGuard,send,store,launch,lt,discussion: (getDiscussion()),aiTools: (getAiTools()),specialMode,modelView: (getModelView()),rolesData,modelError,delegateTerminalError,chats: (getChats()),webchatActive,ideaDispatch: (getIdeaDispatch()),ideas,assertWorkspaceIdle,isolatedReviewDir,startDir,roles,taskIntegrate: (getTaskIntegrate()),gitw,integrateAuto: (getIntegrateAuto()),requestAccount,stopControl,permCmd,record,selectionPrompt,integrationReviewPrompt,taskPrompt,chatEnded: (getChatEnded()),refreshLimitEvidence,verifyIntegrationAssignmentSend,limitEvidence,modelPolicy,DELEGATE_COMPLETED_ERROR: (getDelegateCompletedError())})(b,res,{...options,origin:options.automation?'delegate':'hub-internal'});
  }

  function userDelivery(b,res,options) {
    return require('../request-delivery').createDelivery({license,licenseGuard,send,store,launch,lt,discussion: (getDiscussion()),aiTools: (getAiTools()),specialMode,modelView: (getModelView()),rolesData,modelError,delegateTerminalError,chats: (getChats()),webchatActive,ideaDispatch: (getIdeaDispatch()),ideas,assertWorkspaceIdle,isolatedReviewDir,startDir,roles,taskIntegrate: (getTaskIntegrate()),gitw,integrateAuto: (getIntegrateAuto()),requestAccount,stopControl,permCmd,record,selectionPrompt,integrationReviewPrompt,taskPrompt,chatEnded: (getChatEnded()),refreshLimitEvidence,verifyIntegrationAssignmentSend,limitEvidence,modelPolicy,DELEGATE_COMPLETED_ERROR: (getDelegateCompletedError())})(b,res,{...options,origin:'delegate'});
  }

  return { createChatRunner, createQueueRetreat, dispatchAfterWebchat, delegateRequest, userDelivery };
};
