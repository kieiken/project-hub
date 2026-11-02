'use strict';

module.exports = function chatsendRoutes(ctx) {
  const { DELEGATE_COMPLETED_ERROR, assertWorkspaceIdle, chat, chatEnded, chats, getDiscussion, extensions, freetalk, freetalkAttachments, fs, holdStoppedQueue, getIdeaDispatch, ideas, integrationReviewPrompt, isolatedReviewDir, launch, license, licenseGuard, lt, modelError, modelPolicy, modelView, permCmd, pickSpec, queueActions, queueEdit, queueEditable, record, startCreditCheck, refreshLimitEvidence, removalReview, reqCtx, requestAccount, roles, rolesData, send, sessions, specialMode, start, startDir, stopControl, store, taskHistory, taskPrompt, verifyIntegrationReviewSend, getWebchat, webchatActive } = ctx;

  async function handleSend(req, res, url, b) {
      const snapshot=reqCtx.getStore().stopSnapshot;
      let stopTicket={epoch:snapshot.epoch,task:snapshot.tasks[JSON.stringify([b.project,b.task])]?.epoch||0},manualResume=false;
      try{stopControl.assert(b,stopTicket);}catch(e){
        try{
          if(b.fromQueue||b.mode||b.automation||!b.manualStopTicket||b.manualStopTicket.epoch!==stopTicket.epoch||b.manualStopTicket.task!==stopTicket.task)throw e;
          stopControl.checkManual(b,stopTicket);manualResume=true;reqCtx.getStore().manualResume={project:b.project,task:b.task,ticket:stopTicket};
        }catch(refused){return send(res,409,{error:refused.message});}
      }
      const resumeManual=async()=>{
        if(!manualResume)return;
        if(chats.busy(b.project,b.task)||sessions.list().some(s=>s.running&&s.project===b.project&&s.task===b.task)||webchatActive(b.project,b.task))throw Error('前のAIの終了・保存を確認してから送ってください');
        await chats.assertHandoffReadyAsync(b.project,b.task);
        stopControl.checkManual(b,stopTicket);if(chats.busy(b.project,b.task)||sessions.list().some(s=>s.running&&s.project===b.project&&s.task===b.task)||webchatActive(b.project,b.task))throw Error('前のAIの終了・保存を確認してから送ってください');holdStoppedQueue(b.project,b.task);
        stopTicket=stopControl.resumeTask(b,stopTicket);manualResume=false;
        reqCtx.getStore().manualResume=null;
      };
      if (b.ai === 'chatgpt' && b.model === 'auto' && !extensions.state().included.includes('webchat')) return send(res,404,{code:'feature_not_included',error:lt('この版には含まれていません'),delivery:'not-sent'});
      if((getDiscussion()).active(b.project,b.task))return send(res,409,{error:'話し合いが進行中です。停止または完了後に送ってください'});
      const fromQueue = b.fromQueue ? chats.queue(b.project, b.task).find(x => x.id === String(b.fromQueue)) : null;
      try { void license.prepare(); licenseGuard({ ...b, origin:fromQueue?.origin, ...(b.fromQueue ? { mode: 'queued' } : {}) }, 'accept'); }
      catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code, delivery: 'not-sent' }); }
      // 待っている指示を今すぐ始める（再起動の後など、作業中でない時）
      try{if(fromQueue)chats.assertQueueStart({project:b.project,task:b.task,request:fromQueue.id});}catch(e){return send(res,409,{error:e.message});}
      if (b.fromQueue && !fromQueue) return send(res, 404, { error: lt('その指示はもう待っていません') });
      const queueKey = chats.key(b.project, b.task);
      if (fromQueue && queueActions.has(queueKey)) return send(res, 409, { error: lt('待ち指示を送信中です。終わってから操作してください') });
      if (fromQueue && typeof b.expectedText === 'string' && b.expectedText !== fromQueue.text) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
      if (fromQueue && b.expectedItem !== undefined && b.expectedItem !== JSON.stringify(fromQueue)) return send(res, 409, { error: lt('待ち指示が変更されています。内容を確認してから操作してください') });
      const amendQueue = Boolean(fromQueue && b.mode === 'amend');
      if (amendQueue && (!queueEditable(fromQueue) || !chats.busy(b.project, b.task) || chats.busy(b.project, b.task).pending)) return send(res, 409, { error: lt('今すぐ追加指示にできません。AIの作業中にもう一度操作してください') });
      if (fromQueue) queueActions.add(queueKey);
      try {
      if (fromQueue) Object.assign(b, { account: fromQueue.account || 'default', ai: fromQueue.ai, model: fromQueue.model, effort: fromQueue.effort, text: fromQueue.text, mode: amendQueue ? 'amend' : '' });
      if(fromQueue?.automation){
        try{if(b.mode)throw Error('台帳の依頼は台帳から変更してください');const r0=ideas.read(b.project).runs[fromQueue.automation.runId];const loc=(getIdeaDispatch()).location(b.project,r0);
          const o={...fromQueue,project:b.project,task:b.task,pdir:loc.pdir,dir:loc.dir,request:fromQueue.id,basePrompt:(getIdeaDispatch()).policy(r0),policy:(getIdeaDispatch()).policy(r0)};(getIdeaDispatch()).verify(o);
          const r=await chats.sendQueued(o);if(!(await r.started))throw Error('AIを起動できませんでした');chats.unqueue(b.project,b.task,fromQueue.id);return send(res,200,{ok:true,ai:r.ai,model:r.model,answeredQuestion:null});
        }catch(e){return send(res,409,{error:e.message});}
      }
      if(b.automation)return send(res,403,{error:'台帳の実行情報は一般の送信では受け付けません'});
      if (b.ai === 'dot') return send(res,410,{error:'Dot連携は廃止しました',delivery:'not-sent'});
      if (b.ai === 'chatgpt' && ['chat','app'].includes(b.model)) return send(res, 410, { error: lt('手動・アプリの経路は廃止しました。ChatGPT（Chat／Pro）を選び直してください') });
      if (b.ai === 'chatgpt' && !['auto'].includes(b.model)) return send(res, 409, { error: chat.CHATGPT_RETIRED });
      const p = store.readProject(b.project);
      const file = store.taskFile(b.project, b.task);
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      const sharing=p&&removalReview.read(p.id);
      if(sharing?.task===b.task){
        if(!fromQueue?.readOnly||sharing.status!=='running'||![sharing.id,'limit-'+sharing.id].includes(fromQueue.id))return send(res,409,{error:lt('共有確認は削除画面から操作してください')});
        try{
          const r=await chats.sendQueued({...fromQueue,project:p.id,task:b.task,pdir:p.dir,dir:p.dir,request:fromQueue.id,readOnly:true,
            basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')});
          if(!(await r.started))throw Error(lt('AIを起動できませんでした'));chats.unqueue(p.id,b.task,fromQueue.id);return send(res,200,{ok:true,ai:r.ai,model:r.model});
        }catch(e){return send(res,409,{error:e.message});}
      }

      if (!p || !file || ![...launch.AIS, 'chatgpt'].includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
      if (!text) return send(res, 400, { error: lt('依頼を書いてください') });
      let answerSource=null;
      if(b.answerSource&&p.kind!=='freetalk'&&!fromQueue){
        let current;
        try{current=taskHistory.pendingQuestion(p.id,b.task);}
        catch(e){record('question-display-read-error',{project:p.id,task:b.task},{phase:'answer',error:e.message});}
        if(current?.source!==b.answerSource)return send(res,409,{error:lt('質問が変わりました。会話を読み直してから答えてください'),delivery:'not-sent'});
        answerSource=b.answerSource;
      }
      const recordAnswer=()=>{
        if(!answerSource)return;
        // The request is already accepted. A display-record failure must not invite resending it.
        try{const row=chat.append(p.dir,b.task,{role:'event',answeredQuestionSource:answerSource,text:''});answerSource=null;chats.emit(p.id,b.task,{type:'row',row});}
        catch(e){record('question-display-record-error',{project:p.id,task:b.task},{error:e.message});}
      };
      if (b.ai === 'chatgpt' && b.model === 'auto') {
        if (b.fromQueue || b.mode || b.images?.length) return send(res, 400, { error: lt('自動Chatへの依頼は本文だけを送ってください。画像は添付できません') });
        try {
          const t = store.readTask(file), answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
          await chats.withStrictHandoff(()=>(getWebchat()).availability(p,t));await resumeManual();
          const r = await (getWebchat()).submit(p, t, text,stopTicket);
          recordAnswer();
          let answeredQuestion = null;
          // Acceptance has already been durably recorded. A metadata failure
          // must not report a rejected send and invite a duplicate request.
          if (p.kind !== 'freetalk') try {
            const current = store.readTask(file);
            if (current.question === answerQuestion) {
              if (current.question || current.state === '返事待ち') store.updateTask(p.id,t.id,{question:'',state:'実行中'});
              answeredQuestion = answerQuestion;
            }
          } catch(e) { record('webchat-metadata-error',{project:p.id,task:t.id},{error:e.message}); }
          return send(res, 200, { ...r, answeredQuestion });
        } catch(e) { return send(res, e.status || 409, { error: (getWebchat()).message(e.message), code: e.message, delivery: 'not-sent' }); }
      }
      let t = store.readTask(file);
      const automatic = !fromQueue && !b.model && specialMode.pick(modelView.special(), rolesData(), t.role);
      if (automatic) { b.ai = automatic.ai; b.model = automatic.model; b.effort = b.effort || automatic.effort; b.account = undefined; }
      const delegated = Boolean(fromQueue?.requireModel);
      if (delegated && t.state === '完了') return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
      const spec = pickSpec(t, b.ai);
      const account = requestAccount(p, t.id, b.ai, b.account);
      const model = launch.modelLabel(b.ai, b.model || spec.model);
      const invalidModel = modelError(b.ai, model);
      if (invalidModel) return send(res, 409, { error: invalidModel });
      // Only a direct, idle send overlaps the first unchanged handoff scan.
      // Queue/replacement/manual-resume paths retain their existing preflight.
      const earlyCreditCheck = !fromQueue && !b.mode && !manualResume && !chats.busy(p.id, b.task)
        ? startCreditCheck({ project: p.id, task: t.id, role: t.role, ai: b.ai, account, model }) : undefined;
      try{await chats.assertHandoffReadyAsync(p.id,b.task);if(!manualResume)stopControl.assert(b,stopTicket);}catch(e){return send(res,409,{error:e.message,delivery:'not-sent'});}
      const busy = chats.busy(p.id, b.task);
      // redo: 取り消してやり直す ／ amend: 追加説明（一緒にやる）／ queue: 終わったら次に（interrupt は前の呼び名）
      const want = b.mode === 'interrupt' ? 'redo' : b.mode;
      if(busy?.automation&&['redo','amend'].includes(want))return send(res,409,{error:'台帳の実行中は台帳の項目から変更してください'});
      const mode = busy ? (['redo', 'amend', 'queue'].includes(want) ? want : '') : '';
      if (busy && !mode) return send(res, 409, { error: lt('まだ作業中です。［取り消してやり直す］［追加説明（一緒にやる）］［終わったら次に］から選んでください') });
      if(fromQueue){try{verifyIntegrationReviewSend({...fromQueue,project:p.id,task:t.id,request:fromQueue.id,mode:'queued'});}catch(e){return send(res,409,{error:e.message});}}
      const { dir, note } = fromQueue?.isolatedReview ? (assertWorkspaceIdle(p,t,Boolean(mode)),{dir:isolatedReviewDir(p,t)}) : startDir(p, t, Boolean(mode));
      if (b.ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
      const effort = fromQueue?.integrationAssignment ? fromQueue.effort : b.ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : spec.effort;
      let topicImages=[];
      if(p.kind==='freetalk' && !fromQueue && b.images?.length) {
        try { freetalk.checkGeneration(t.id,b.generation);topicImages=freetalkAttachments.images(t.id,b.images); }
        catch(e){return send(res,409,{error:e.message});}
      }
      let attachmentDraft;
      try { attachmentDraft = fromQueue?.attachmentDraft || queueEdit.accept(p, t.id, b.attachmentDraft, text, freetalkAttachments); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const basePrompt = fromQueue?.isolatedReview?integrationReviewPrompt(p,t):taskPrompt(p, t, file, dir, 'chat', undefined, fromQueue || {}) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。');
      await resumeManual();
      // 受付時の質問だけを消す。起動待ち中に来た新しい質問には触れない。
      const answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
      const acceptAnswer = () => {
        recordAnswer();
        const current = store.readTask(file);
        if (current.question !== answerQuestion) return null;
        if (current.question || current.state === '返事待ち') store.updateTask(p.id, t.id, { question: '', state: '実行中' });
        return answerQuestion;
      };
      let projectImages;
      if(p.kind!=='freetalk'&&b.projectImages!==undefined){
        if(!Array.isArray(b.projectImages)||b.projectImages.length>10)return send(res,400,{error:'添付画像の情報を確認してください'});
        try{projectImages=b.projectImages.map(id=>{const f=start.imageFile(p,id);if(!fs.existsSync(f))throw Error('添付画像が見つかりません');return id;});}catch(e){return send(res,400,{error:e.message});}
      }
      // 追加：今の作業が終わったら続けて行う
      if (mode === 'queue') {
        const it = chats.enqueue(p.id, t.id, { ai: b.ai, account, model, effort, role: t.role, text, attachmentDraft, ...(projectImages?{projectImages}:{}), images: p.kind==='freetalk' ? topicImages : [], perm: permCmd(b.ai) });
        if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
        record('chatqueue', { project: p.id, task: t.id, ai: b.ai }, { model });
        return send(res, 200, { ok: true, queued: true, id: it.id, queue: chats.queue(p.id, t.id).length, answeredQuestion: acceptAnswer() });
      }
      // 取り消し・追加説明：今の作業を区切って（終わるのを待って）から、元の指示と合わせて伝え直す
      let stopWaiting,switchAdvance;
      if (!busy?.pending && (mode === 'redo' || mode === 'amend')) {
        const switching=Object.values(require('../chat-continuation').read(p.dir,t.id).advances).find(a=>a.source.turn===busy.userRow?.turn&&a.mode!=='fifo');
        if(switching&&switching.id!==fromQueue?.id)return send(res,409,{error:'前の切替を確認中です。新しい文章はまだ受け付けていません'});
        const waiting=stopWaiting=fromQueue || chats.enqueue(p.id,t.id,{ai:b.ai,account,model,effort,role:t.role,text,attachmentDraft,...(projectImages?{projectImages}:{}),images:topicImages,perm:permCmd(b.ai)});
        try{switchAdvance=chats.prepareSwitch(p.id,t.id,waiting.id,mode,stopTicket);}catch(e){return send(res,409,{error:e.message,queued:true,id:waiting.id});}
        try{await chats.stop(p.id,t.id,{interrupting:true});}catch(e){try{require('../chat-continuation').update(p.dir,t.id,d=>{d.advances[switchAdvance.source.turn].reason=e.message;});}catch{/* The original intent remains; no new start is attempted here. */}return send(res,409,{error:e.message,queued:true,id:waiting.id});}
        try{stopControl.assert({project:p.id,task:t.id},stopTicket);}catch(e){return send(res,409,{error:e.message,queued:true,id:waiting.id});}

        record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: b.ai });

      }
      try {
        // 答えを送ったら、AI からの質問は済んだことにする
        // 質問は spawn の成功後にだけ解除する。
        // AI が質問して終わったら「あなたの番」にする（左の丸が黄色になる）
        const onEnd = row => { if (!fromQueue?.isolatedReview && row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') }); chatEnded(p.id, t.id); };
        let replacement;
        if (busy?.pending && (mode === 'redo' || mode === 'amend')) {
          replacement = chats.replacePending(p.id, t.id, text, mode, p.kind === 'freetalk' ? topicImages : undefined);
          await replacement.finished;
          stopControl.assert({project:p.id,task:t.id},stopTicket);
        }
        let refreshCreditBeforeStart;
        if (!replacement && !fromQueue) {
          const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
          refreshCreditBeforeStart = await refreshLimitEvidence({ project: p.id, task: t.id, role: t.role, ai: b.ai, account, model }, earlyCreditCheck);
          if(p.kind==='freetalk' && b.images?.length)freetalk.checkGeneration(t.id,b.generation);
          if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用枠の確認中に停止されました。AIは開始していません'));
        }
        const options={ refreshCreditBeforeStart, stopTicket, project: p.id, task: t.id, pdir: p.dir, dir, ai: b.ai, account, model, effort, origin: fromQueue?.origin, readIndex: fromQueue?.readIndex, integrationAssignment:fromQueue?.integrationAssignment, limitPolicy:fromQueue?.limitPolicy, isolatedReview:fromQueue?.isolatedReview, integrationReviewRequest:fromQueue?.integrationReviewRequest, readOnly:fromQueue?.readOnly, readDirs:fromQueue?.readDirs, images: p.kind==='freetalk' && b.ai==='codex' ? fromQueue?.images || topicImages : [], role: fromQueue ? fromQueue.role || '' : t.role, limitSlot: fromQueue?.limitSlot, limitSwitch: fromQueue?.limitSwitch, request: fromQueue?.id||stopWaiting?.id, requireModel: Boolean(fromQueue?.requireModel), requiredModel: fromQueue?.requiredModel, text, shown: amendQueue ? text : fromQueue?.shown || text, mode: mode || (fromQueue ? 'queued' : undefined), basePrompt, policy: modelPolicy(p, t), perm: permCmd(b.ai), onEnd };
        const r = switchAdvance ? await chats.launchAdvance({...switchAdvance,liveRun:busy},options) : replacement
          ? await chats.sendQueued(replacement.options)
          : await (fromQueue ? chats.sendQueued.bind(chats) : chats.send.bind(chats))(options);
        if(!r)throw Error('待ち指示は取り消されました。中断した依頼の記録を確認してください');
        if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
        if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
        const answeredQuestion = delegated || fromQueue?.isolatedReview ? null : acceptAnswer();
        if (delegated && !fromQueue?.isolatedReview) {
          store.updateTask(p.id, t.id, { state: '実行中', question: '' });
        }
        if (stopWaiting&&!fromQueue)chats.unqueue(p.id,t.id,stopWaiting.id);
        if (fromQueue) chats.unqueue(p.id, t.id, fromQueue.id);
        if (replacement) {
          chats.unqueue(p.id, t.id, replacement.options.request);
          record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: r.ai });
        }
        record('chat', { project: p.id, task: t.id, ai: r.ai }, { model: r.model, effort: r.effort, resume: r.resume });
        return send(res, 200, { ok: true, model: r.model, effort: r.effort, note: r.limitSwitch?.preflight ? lt`${r.limitSwitch.from} 上限保持中のため ${r.model} で開始しました。` : note, resume: r.resume, answeredQuestion });
      } catch (e) { return send(res, 409, { error: String(e.message || e),...(stopWaiting?{queued:true,id:stopWaiting.id}:{}) }); }
      } finally { if (fromQueue) queueActions.delete(queueKey); }
    }

  return {
    send: { matches: (req, url) => url.pathname === '/api/chat/send', handle: handleSend },
  };
};
