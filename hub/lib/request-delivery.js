'use strict';
// Shared delivery transport for free Hub workflows and optional user delegation.
module.exports.createDelivery = host => {
 const {license,licenseGuard,send,store,launch,lt,discussion,aiTools,specialMode,modelView,rolesData,modelError,delegateTerminalError,chats,webchatActive,ideaDispatch,ideas,assertWorkspaceIdle,isolatedReviewDir,startDir,roles,taskIntegrate,gitw,integrateAuto,requestAccount,stopControl,permCmd,record,selectionPrompt,integrationReviewPrompt,taskPrompt,chatEnded,refreshLimitEvidence,verifyIntegrationAssignmentSend,limitEvidence,modelPolicy,DELEGATE_COMPLETED_ERROR}=host;
 return async function deliver(b,res,{origin='hub-internal',admitted=false,card,beforeStart,allowCompleted=false,resultsRecovery,resultsOrganize=false,preserveTaskState=false,isolatedReview=false,selectionOnly=false,review,requestKey,integrationAssignment,automation}={}) {
    try { if(!admitted){void license.prepare(); licenseGuard({ ...b, origin }, 'accept');} }
    catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code, delivery: 'not-sent' }); }
    if(b.automation&&!automation)return send(res,403,{error:'台帳の実行は保存されたHubの依頼だけを受け付けます'});
    if(b.integrationAssignment&&!integrationAssignment)return send(res,409,{error:'統合の担当指定は正式な統合開始からだけ受け付けます'});
    const p = store.readProject(b.project);
    const file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    let ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    if (!p || !file || !launch.AIS.includes(ai)) return send(res, 400, { error: lt('project・task・ai（codex / claude / agy / grok）を確かめてください') });
    if(discussion.active(p.id,b.task))return send(res,409,{error:'話し合いが進行中です。停止または完了後に渡してください'});
    if (!text || text.length > 8000) return send(res, 400, { error: lt('text は1〜8000文字') });
    if (aiTools.isOperating(ai)) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です'), code:'HUB_AI_MAINTENANCE' });
    const t = store.readTask(file);
    const sizeNote = text.length > 1500 ? lt(' Hub が付ける内容を除き、差分だけにすると短くなります') : '';
    const title = String(b.title || text.split('\n')[0]).trim().slice(0, 60) || lt('渡した作業');
    if (t.state === '完了' && !allowCompleted) return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    // 委任先の役割は元の担当と異なることがある。親の role/model や CLI の既定へは戻さない。
    const automatic = !b.model && specialMode.pick(modelView.special(), rolesData(), b.role || t.role);
    if (automatic) ai = automatic.ai;
    const role = b.role && rolesData().roles.find(r => r.name === b.role);
    if (!integrationAssignment && b.role && (!role || (!modelView.special().enabled && !automatic && role.main.ai !== launch.AI_KEY[ai]))) return send(res, 400, { error: lt('role は指定した AI が主担当の役割を選んでください') });
    const model = launch.modelLabel(ai, typeof b.model === 'string' && b.model.trim() ? b.model.trim() : automatic?.model || role?.main.model || '');
    if (!model) return send(res, 400, { error: lt('model 又は role を明示してください。例：チェックは ai: claude・model: claude-fable-5-1、書込は ai: codex・model: gpt-6.1-sol。作業は増やしていません') });
    const invalid = modelError(ai, model);
    if (invalid) return send(res, 409, { error: invalid });
    if (!launch.flagFor(ai, model)) return send(res, 409, { error: lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません') });
    const terminalError = delegateTerminalError(p.id, t.id);
    if (terminalError) return send(res, 409, { error: terminalError });
    const sourceTurn = chats.busy(p.id, t.id)?.userRow?.turn || null;
    const busy = Boolean(chats.busy(p.id, t.id) || webchatActive(p.id, t.id));
    let dir;
    try { if(automation){dir=ideaDispatch.location(p.id,ideas.read(p.id).runs[automation.runId]).dir;assertWorkspaceIdle(p,t,busy);}else if(isolatedReview){assertWorkspaceIdle(p,t,busy);dir=isolatedReviewDir(p,t);}else if(!beforeStart && !webchatActive(p.id,t.id))({ dir } = startDir(p, t, busy)); } catch (e) { return send(res, 409, { error: String(e.message || e), ...(e.code?{code:e.code}:{}) }); }
    if (ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = integrationAssignment ? b.effort : ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : automatic?.effort || role?.main.effort || '';
    const verifyReviewResults=()=>{
      if(!review)return;
      const r=taskIntegrate.read(p.id,t.id,review.integrationId),a=r?.auto?.attempts[review.key];
      if(r?.stoppedSibling){if(!a||a.delivery?.request!==requestKey)throw Error('Integration request changed');require('./integration-sibling').review(taskIntegrate,r,a);}
      if(!review.savedResults)return;
      if(!a||a.phase!=='review'||a.delivery?.request!==requestKey||JSON.stringify(a.savedResults)!==JSON.stringify(review.savedResults))throw Error('Saved result review request changed');
      taskIntegrate.simple.validate(r);integrateAuto.verifySavedReview(r,a);
    };
    let evidence;
    if(isolatedReview){try{verifyReviewResults();evidence=require('./integration-review').prepare({dir,pdir:p.dir,task:t.id,...review});}catch(e){return send(res,409,{error:e.message});}}
    const shown = automation?text:card?card({title,text,evidence,review}):lt`【渡した依頼：${title}】\n${text}`+(evidence?`\n保存差分原物：${evidence.file}（SHA256 ${evidence.sha256}）。Readでintegration・child・resolution・history${review?.savedResults?'・saved-results・saved-commit・original（原文行範囲と全体SHA。省略範囲は元ファイルを読む）':''}を照合し、試験原物も読む。`:'');
    const account = requestAccount(p, t.id, ai, b.account);
    const request = { ...(origin==='delegate'&&typeof b.readIndex==='boolean'?{readIndex:b.readIndex}:{}), stopTicket:stopControl.ticket({project:p.id,task:t.id}), ...(automation?{automation,contextMode:'idea',freshContext:true,preserveTaskState:true,reviewKind:automation.purpose==='review'?'idea':undefined,readOnly:automation.readOnly,readDirs:[p.dir,dir],request:requestKey}:{}), ...(integrationAssignment?{integrationAssignment,limitPolicy:'hold'}:{}), ...(requestKey?{request:requestKey}:{}), ...(isolatedReview?{isolatedReview:true,integrationReviewRequest:requestKey,readOnly:true,readDirs:[p.dir]}:{}), ...(selectionOnly?{selectionOnly:true}:{}), origin, resultsOrganize, ai, account, model, effort, sourceTurn, role: b.role || '', requireModel: true, requiredModel: launch.flagFor(ai, model), shown, text: automation?text:shown + lt('\n\n新しい作業・子作業を作らず、この既存作業で依頼を行い、結果をこの会話へ返してください。'), perm: permCmd(ai) };
    const enqueue = () => {
      if(resultsOrganize)return send(res,409,{error:lt('別の依頼が作業中・順番待ちのため成果整理を開始していません')});
      res.integrationDelivery?.begin();
      const item = chats.enqueue(p.id, t.id, request);
      record('delegate', { project: p.id, task: t.id, ai }, { title, model, effort, queued: true, id: item.id, sourceTurn, ...(requestKey?{request:requestKey}:{}) });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, model, effort, queued: true, id: item.id, queue: chats.queue(p.id, t.id).length, note: (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) ? lt('今の AI が終わったら、同じ作業で指定の AI が始まります。開始時に上限を確かめた時は保存した交代先で始めます。この番を終えてください') : lt('同じ作業の順番待ちに追加しました。画面の［始める］で再開できます')) + sizeNote });
    };
    if (busy || webchatActive(p.id,t.id) || chats.queue(p.id, t.id).length) return enqueue();
    const basePrompt = automation?ideaDispatch.policy(ideas.read(p.id).runs[automation.runId]):selectionOnly?selectionPrompt(p):isolatedReview?integrationReviewPrompt(p,t):beforeStart?null:taskPrompt(p, t, file, dir, 'chat', undefined, request) + lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
    const onEnd = row => {
      if (!preserveTaskState && row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') });
      chatEnded(p.id, t.id);
      record('delegateend', { project: p.id, task: t.id, ai: row.ai }, { title, model: row.model, error: Boolean(row.error) });
    };
    try {
      const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
      await refreshLimitEvidence({ ...request, project: p.id, task: t.id });
      verifyIntegrationAssignmentSend({...request,project:p.id,task:t.id});
      if(integrationAssignment&&limitEvidence.active(account,launch.flagFor(ai,model)))throw Object.assign(Error('指定した統合担当が上限中です。担当を替えず解除まで待機します'),{code:'HUB_LIMIT_WAIT'});
      if(beforeStart){beforeStart();if(selectionOnly){assertWorkspaceIdle(p,t,false);dir=p.dir;}else ({dir}=startDir(p,t));if(resultsRecovery)request.resultsRecoveryHash=store.readTask(file).completionHash;}
      if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用上限の確認中に停止されたため、委任を開始していません'));
      const terminalError = delegateTerminalError(p.id, t.id);
      if (terminalError) throw Error(terminalError);
      // 状態要求を待つ間に他の依頼が始まった場合も同じ待ち順へ入れる。
      if (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) || chats.queue(p.id, t.id).length) return enqueue();
      const prompt=basePrompt??taskPrompt(p,t,file,dir,'chat',undefined,request)+lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
      const r = await chats.send({ ...request, project: p.id, task: t.id, pdir: p.dir, dir, basePrompt:prompt, policy: automation?basePrompt:selectionOnly?selectionPrompt(p):modelPolicy(p, t), beforeSend:()=>{verifyReviewResults();res.integrationDelivery?.begin();}, onEnd });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      if(!preserveTaskState)store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      record('delegate', { project: p.id, task: t.id, ai: r.ai }, { title, ...(requestKey?{request:requestKey}:{}), model: r.model, effort: r.effort, queued: false, preflight: Boolean(r.limitSwitch?.preflight), sourceTurn, receivedTurn: r.userRow.turn });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, ai: r.ai, model: r.model, effort: r.effort, queued: false, resume: r.resume, note: lt`${r.limitSwitch?.preflight ? lt`${r.limitSwitch.from} 上限保持中のため ${r.model} で開始しました。` : ''}同じ作業で ${launch.AI_LABEL[r.ai]}・${r.model} が作業中です。結果もこの会話へ届きます` + sizeNote });
    } catch (e) { return send(res, 409, { error: String(e.message || e), ...(e.code?{code:e.code}:{}) }); }
 };
};
