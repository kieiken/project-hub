'use strict';
// Shared delivery transport for free Hub workflows and optional user delegation.
module.exports.createDelivery = host => {
 const {license,licenseGuard,send,store,launch,lt,discussion,aiTools,specialMode,modelView,rolesData,modelError,delegateTerminalError,chats,webchatActive,ideaDispatch,ideas,assertWorkspaceIdle,isolatedReviewDir,startDir,roles,taskIntegrate,gitw,integrateAuto,requestAccount,stopControl,permCmd,record,selectionPrompt,integrationReviewPrompt,taskPrompt,chatEnded,refreshLimitEvidence,verifyIntegrationAssignmentSend,limitEvidence,usage,modelPolicy,DELEGATE_COMPLETED_ERROR}=host;
 return async function deliver(b,res,{origin='hub-internal',admitted=false,stopTicket,card,beforeStart,allowCompleted=false,resultsRecovery,resultsOrganize=false,preserveTaskState=false,isolatedReview=false,selectionOnly=false,review,requestKey,integrationAssignment,automation}={}) {
    try { if(!admitted){void license.prepare(); licenseGuard({ ...b, origin }, 'accept');} }
    catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code, delivery: 'not-sent' }); }
    if(b.automation&&!automation)return send(res,403,{error:'台帳の実行は保存されたHubの依頼だけを受け付けます'});
    if(b.integrationAssignment&&!integrationAssignment)return send(res,409,{error:'統合の担当指定は正式な統合開始からだけ受け付けます'});
    const p = store.readProject(b.project);
    const file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    let ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    const tierEligible = origin === 'delegate' && !automation && !integrationAssignment && !isolatedReview && !selectionOnly && !resultsOrganize && !beforeStart && !modelView.special().enabled && host.roleTiers;
    let tierRequested = false;
    if (tierEligible) {
      try { tierRequested = Boolean(b.tier !== undefined || b.redo || host.roleTiers.read().data.roles[b.role]); }
      catch(e) { return send(res,e.status || 400,{error:e.message}); }
    }
    if (!p || !file || !tierRequested && !launch.AIS.includes(ai)) return send(res, 400, { error: lt('project・task・ai（codex / claude / agy / grok）を確かめてください') });
    if(discussion.active(p.id,b.task))return send(res,409,{error:'話し合いが進行中です。停止または完了後に渡してください'});
    if (!text || text.length > 8000) return send(res, 400, { error: lt('text は1〜8000文字') });
    if (!tierRequested && aiTools.isOperating(ai)) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です'), code:'HUB_AI_MAINTENANCE' });
    const t = store.readTask(file);
    let tier;
    if (tierEligible) {
      try { tier = host.roleTiers.resolve(b, { project:p.id, task:t.id, rows:[...host.chat.read(p.dir,t.id), ...chats.queue(p.id,t.id).map(q=>({role:'user',roleTier:q.roleTier}))] }); }
      catch(e) { return send(res,e.status || 400,{error:e.message}); }
      if(tier) ai = tier.ai;
    }
    if (!launch.AIS.includes(ai)) return send(res,400,{error:lt('project・task・ai（codex / claude / agy / grok）を確かめてください')});
    if (tierRequested && aiTools.isOperating(ai)) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です'), code:'HUB_AI_MAINTENANCE' });
    const sizeNote = text.length > 1500 ? lt(' Hub が付ける内容を除き、差分だけにすると短くなります') : '';
    const title = String(b.title || text.split('\n')[0]).trim().slice(0, 60) || lt('渡した作業');
    if (t.state === '完了' && !allowCompleted) return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    // 委任先の役割は元の担当と異なることがある。親の role/model や CLI の既定へは戻さない。
    const automatic = !tier && !b.model && specialMode.pick(modelView.special(), rolesData(), b.role || t.role);
    if (automatic) ai = automatic.ai;
    const role = b.role && rolesData().roles.find(r => r.name === b.role);
    if (!integrationAssignment && b.role && (!role || (!tier && !modelView.special().enabled && !automatic && role.main.ai !== launch.AI_KEY[ai]))) return send(res, 400, { error: lt('role は指定した AI が主担当の役割を選んでください') });
    const model = launch.modelLabel(ai, tier?.model || (typeof b.model === 'string' && b.model.trim() ? b.model.trim() : automatic?.model || role?.main.model || ''));
    if (!model) return send(res, 400, { error: lt('model 又は role を明示してください。例：チェックは ai: claude・model: claude-fable-5-2、書込は ai: codex・model: gpt-6.1-sol。作業は増やしていません') });
    const account = requestAccount(p, t.id, ai, tier?.account || b.account);
    const invalid = modelError(ai, model, account);
    if (invalid) return send(res, 409, { error: invalid });
    if (!launch.flagFor(ai, model)) return send(res, 409, { error: lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません') });
    const terminalError = delegateTerminalError(p.id, t.id);
    if (terminalError) return send(res, 409, { error: terminalError });
    const sourceTurn = chats.busy(p.id, t.id)?.userRow?.turn || null;
    const busy = Boolean(chats.busy(p.id, t.id) || webchatActive(p.id, t.id));
    let dir;
    try { if(automation){dir=ideaDispatch.location(p.id,ideas.read(p.id).runs[automation.runId]).dir;assertWorkspaceIdle(p,t,busy);}else if(isolatedReview){assertWorkspaceIdle(p,t,busy);dir=isolatedReviewDir(p,t);}else if(!beforeStart && !webchatActive(p.id,t.id))({ dir } = startDir(p, t, busy)); } catch (e) { return send(res, 409, { error: String(e.message || e), ...(e.code?{code:e.code}:{}) }); }
    if (origin !== 'delegate' && ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = launch.normalizeEffort(ai, tier?.effort || (integrationAssignment ? b.effort : ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : automatic?.effort || role?.main.effort || ''));
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
    const tierText = tier ? `\n段：${tier.roleTier.tier}（${launch.AI_LABEL[ai]}・${model}・${effort}）／理由：${tier.roleTier.reason}${tier.roleTier.note ? '\n'+tier.roleTier.note : ''}${tier.roleTier.stopReason ? '\n振り分けを停止：'+tier.roleTier.stopReason : ''}${b.role === '調査' ? '\n情報の出どころ（URL・資料名・見た日）と、確認できなかった点を必ず書く。' : ''}` : '';
    const shown = (automation?text:card?card({title,text,evidence,review}):lt`【渡した依頼：${title}】\n${text}`+(evidence?`\n保存差分原物：${evidence.file}（SHA256 ${evidence.sha256}）。Readでintegration・child・resolution・history${review?.savedResults?'・saved-results・saved-commit・original（原文行範囲と全体SHA。省略範囲は元ファイルを読む）':''}を照合し、試験原物も読む。`:'')) + tierText;
    let request = { ...(origin==='delegate'&&typeof b.readIndex==='boolean'?{readIndex:b.readIndex}:{}), stopTicket:stopTicket||stopControl.ticket({project:p.id,task:t.id}), ...(automation?{automation,contextMode:'idea',freshContext:true,preserveTaskState:true,reviewKind:automation.purpose==='review'?'idea':undefined,readOnly:automation.readOnly,readDirs:[p.dir,dir],request:requestKey}:{}), ...(integrationAssignment?{integrationAssignment,limitPolicy:'hold'}:{}), ...(requestKey?{request:requestKey}:{}), ...(isolatedReview?{isolatedReview:true,integrationReviewRequest:requestKey,readOnly:true,readDirs:[p.dir]}:{}), ...(selectionOnly?{selectionOnly:true}:{}), origin, resultsOrganize, ai, account, model, effort, sourceTurn, role: b.role || '', requireModel: true, requiredModel: launch.flagFor(ai, model), shown, text: automation?text:shown + lt('\n\n新しい作業・子作業を作らず、この既存作業で依頼を行い、結果をこの会話へ返してください。'), perm: permCmd(ai) };
    const applyEffort = () => {
      if (origin !== 'delegate' || automation || tier) return;
      request = require('./delegate-effort').resolve(request, { data: rolesData(), catalog: aiTools.catalog(), limits: limitEvidence, usage: require('./delegate-effort').readUsage(usage,request.account),
        accountFor: target => requestAccount(p,t.id,target) });
    };
    if (tier) { request.roleTier=tier.roleTier; if(tier.freshContext){request.freshContext=true;request.contextMode='role-tier';} if(tier.limitSlot)request.limitSlot=tier.limitSlot; }
    if (origin === 'delegate' && !automation && !tier) request.delegationEffort = { requested: roles.EFFORTS.includes(b.effort) ? b.effort : '', source: 'role' };
    let tierCommitted=false;
    const commitTier=()=>{if(tier&&!tierCommitted){tier.commit();tierCommitted=true;}};
    const tierFields=tier?{roleTier:tier.roleTier}:{};
    await require('./delegate-effort').refreshUsage(request, usage);
    applyEffort();
    const enqueue = () => {
      if(resultsOrganize)return send(res,409,{error:lt('別の依頼が作業中・順番待ちのため成果整理を開始していません')});
      try{stopControl.assert({project:p.id,task:t.id},request.stopTicket);}catch(e){return send(res,409,{error:e.message,code:e.code,delivery:'not-sent'});}
      res.integrationDelivery?.begin();
      try{commitTier();}catch(e){return send(res,409,{error:e.message});}
      const item = chats.enqueue(p.id, t.id, request);
      record('delegate', { project: p.id, task: t.id, ai }, { title, ...tierFields, model, effort: request.effort, delegationEffort: request.delegationEffort, queued: true, id: item.id, sourceTurn, ...(requestKey?{request:requestKey}:{}) });
      return send(res, 200, { ok: true, ...tierFields, project: p.id, task: t.id, title, model, effort: request.effort, delegationEffort: request.delegationEffort, queued: true, id: item.id, queue: chats.queue(p.id, t.id).length, note: (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) ? lt('今の AI が終わったら、同じ作業で指定の AI が始まります。開始時に上限を確かめた時は保存した交代先で始めます。この番を終えてください') : lt('同じ作業の順番待ちに追加しました。画面の［始める］で再開できます')) + sizeNote + (request.delegationEffort?.note ? ' ' + request.delegationEffort.note : '') });
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
      await require('./delegate-effort').refreshUsage(request, usage);
      applyEffort();
      verifyIntegrationAssignmentSend({...request,project:p.id,task:t.id});
      if(integrationAssignment&&limitEvidence.active(account,launch.flagFor(ai,model)))throw Object.assign(Error('指定した統合担当が上限中です。担当を替えず解除まで待機します'),{code:'HUB_LIMIT_WAIT'});
      if(beforeStart){beforeStart();if(selectionOnly){assertWorkspaceIdle(p,t,false);dir=p.dir;}else ({dir}=startDir(p,t));if(resultsRecovery)request.resultsRecoveryHash=store.readTask(file).completionHash;}
      if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用上限の確認中に停止されたため、委任を開始していません'));
      const terminalError = delegateTerminalError(p.id, t.id);
      if (terminalError) throw Error(terminalError);
      // 状態要求を待つ間に他の依頼が始まった場合も同じ待ち順へ入れる。
      if (chats.busy(p.id, t.id) || webchatActive(p.id,t.id) || chats.queue(p.id, t.id).length) return enqueue();
      const prompt=basePrompt??taskPrompt(p,t,file,dir,'chat',undefined,request)+lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
      const r = await chats.send({ ...request, project: p.id, task: t.id, pdir: p.dir, dir, basePrompt:prompt, policy: automation?basePrompt:selectionOnly?selectionPrompt(p):modelPolicy(p, t), beforeSend:()=>{verifyReviewResults();commitTier();res.integrationDelivery?.begin();}, onEnd });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      if(!preserveTaskState)store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      record('delegate', { project: p.id, task: t.id, ai: r.ai }, { title, ...tierFields, ...(requestKey?{request:requestKey}:{}), model: r.model, effort: r.effort, queued: false, preflight: Boolean(r.limitSwitch?.preflight), sourceTurn, receivedTurn: r.userRow.turn });
      return send(res, 200, { ok: true, ...tierFields, project: p.id, task: t.id, title, ai: r.ai, model: r.model, effort: r.effort, queued: false, resume: r.resume, delegationEffort: r.userRow.delegationEffort, note: lt`${r.limitSwitch?.preflight ? lt`${r.limitSwitch.from} 上限保持中のため ${r.model} で開始しました。` : ''}同じ作業で ${launch.AI_LABEL[r.ai]}・${r.model} が作業中です。結果もこの会話へ届きます` + sizeNote + (r.userRow.delegationEffort?.note ? ' ' + r.userRow.delegationEffort.note : '') });
    } catch (e) { return send(res, 409, { error: String(e.message || e), ...(e.code?{code:e.code}:{}) }); }
 };
};
