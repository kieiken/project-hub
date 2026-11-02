'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

async function act(el) {
  const a = el.dataset.act, p = el.dataset.p || view.project, t = el.dataset.t;
  try {
    if(a==='futurehold'){await saveFutureHold(p,t||view.task,el);return;}
    if (a.startsWith('freetalk') && (a === 'freetalkclean' ? [...chatImageUploads.entries()].some(([key,n])=>n && JSON.parse(key)[0]==='freetalk') : chatImageUploads.get(chatAttachmentKey('freetalk',t || view.task)))) { toast(UI.text('添付ファイルを追加中です。終了後に操作してください')); return; }
    if (a === 'freetalkclean') {
      if(el.disabled)return;
      if(!confirm(UI.text('freetalkの全話題・会話・添付・相談ファイル・メモリをゴミ箱へ移します。AI設定とプロジェクト化した内容は残ります。掃除しますか？')))return;
      el.disabled=true;const active=beginFreetalkCleanupOperation();
      try{await api('/api/freetalk/clean',{project:'freetalk',confirm:true});if(!active())return;freetalkPromotionDrafts.clear();freetalkPromotionErrors.clear();view={kind:'project',project:'freetalk',task:null};save();await load();toast(UI.text('掃除しました。次の期限は1か月後です'));}
      catch(e){if(active())throw e;}finally{el.disabled=false;}
    }
    else if(a==='freetalkautopromote') {
      if(el.disabled)return;el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      try {
        const r=await api('/api/freetalk/project-start',{project:p,task:t});
        if(!active())return;
        freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);
        if(r.project){view={kind:'work',project:r.project,task:r.task};save();await load();}
      }catch(e){if(active())freetalkPromotionErrors.set(t,{message:e.message,automatic:true});}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(['freetalkpromote','freetalkresummary','freetalkretry'].includes(a) && !(a==='freetalkretry' && freetalkPromotionErrors.get(t)?.cancel)) {
      if(el.disabled)return;el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      const create=document.querySelector('.freetalk-promotion [data-act="freetalkcreate"]');if(create)create.disabled=true;
      // A failed status-only retry must not become a promotion request.
      let retryPromotion=a!=='freetalkretry' || freetalkPromotionErrors.has(t);
      try {
        let h=await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(t));
        if(!active())return;
        retryPromotion ||= h.promotionRequested || freetalkPromotionDrafts.has(t);
        if(h.reason)throw Error(h.reason);
        if(!retryPromotion)return;
        freetalkPromotionErrors.delete(t);
        if(a!=='freetalkresummary' && h.draft && !h.stale) {
          if(!h.promotionRequested)h=await api('/api/freetalk/promotion-intent',{project:p,task:t,requested:true});
          if(!active())return;
          taskOf(proj(p),t).freetalkHistory=h;
          await prepareFreetalkPromotion(t,active);
        } else {
          await api('/api/freetalk/summary',{project:p,task:t,intent:'promote'});
        }
      }catch(e){if(active() && retryPromotion)freetalkPromotionErrors.set(t,e.message);}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(a==='freetalkcancel' || (a==='freetalkretry' && freetalkPromotionErrors.get(t)?.cancel)) {
      if(el.disabled || freetalkPromotionDrafts.get(t)?.creating)return;
      el.disabled=true;
      const active=beginFreetalkPromotionOperation(t,true);
      const create=document.querySelector('.freetalk-promotion [data-act="freetalkcreate"]');if(create)create.disabled=true;
      try{await api('/api/freetalk/promotion-intent',{project:p,task:t,requested:false});if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);}
      catch(e){if(active())freetalkPromotionErrors.set(t,{message:e.message,cancel:true});}
      finally{el.disabled=false;if(active()){freetalkPromotionOperations.get(t).pending=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}}
    }
    else if(a==='freetalkcreate') {
      const d=freetalkPromotionDrafts.get(t);if(el.disabled || freetalkPromotionBlocked(taskOf(proj(p),t)))return;el.disabled=true;d.creating=true;
      try {
        const r=await api('/api/freetalk/promote',{...d,available:undefined,project:p,task:t,confirm:true});
        freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);view={kind:'work',project:r.project,task:r.task};closeDrawer();save();await load();toast(UI.text('独立したプロジェクトを作りました'));
      }catch(e){d.error=e.message;d.creating=false;await syncFreetalkHistory(proj(p),taskOf(proj(p),t));}
      finally{el.disabled=false;d.creating=false;}
    }
    else if (a === 'freetalkdelete') {
      if(el.disabled)return;
      const topic=taskOf(proj('freetalk'),el.dataset.t);if(!topic)return;
      if(!confirm(UI.template`話題「${topic.title}」と、その会話記録・添付ファイル・メモリをすべてゴミ箱へ移します。プロジェクトへ引き継いだ内容は残ります。削除しますか？`))return;
      el.disabled=true;const active=beginFreetalkPromotionOperation(topic.id);
      try{await api('/api/freetalk/delete',{project:'freetalk',task:topic.id,confirm:true});if(!active())return;freetalkPromotionDrafts.delete(topic.id);freetalkPromotionErrors.delete(topic.id);chatAttachments.delete(chatAttachmentKey('freetalk',topic.id));
        if(view.project==='freetalk' && view.task===topic.id){closePanes();view={kind:'project',project:'freetalk',task:null};save();}
        renderedMainKey='';await load();toast(UI.text('話題を削除しました'));}
      catch(e){if(active())throw e;}finally{el.disabled=false;}
    }
    else if (a === 'freetalknew') {
      el.disabled = true;
      try { const topic = await api('/api/freetalk/topic', {}); view = { kind: 'work', project: 'freetalk', task: topic.id }; closeDrawer(); save(); await load(); await api('/api/task/read', { project: 'freetalk', task: topic.id }); }
      finally { el.disabled = false; }
    }
    else if (['freetalksummary','freetalkclear','freetalkcontinue'].includes(a)) {
      if(el.disabled)return;
      const topic=taskOf(proj(p),t), h=topic?.freetalkHistory;
      if (!h || h.reason) { toast(h?.reason || UI.text('話題の状態を確認してください')); return; }
      if (a === 'freetalksummary') {
        el.disabled=true;const active=beginFreetalkPromotionOperation(t);
        try { await api('/api/freetalk/summary',{project:p,task:t});if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t); toast(UI.text('この話題のAIに要約を頼みました。返事の後に確認・編集できます')); }
        catch(e){if(active())toast(e.message);}finally{try{if(active())await load({preserveMain:true});}catch(e){if(active())toast(e.message);}finally{el.disabled=false;}}
      }
      else {
        if (a === 'freetalkclear' && !confirm(UI.text('この話題の会話・全AIの再開情報・引き継ぎ控え・メモリ・添付ファイル（コピー）をゴミ箱へ移して、空の会話にしますか？元のファイルは残ります。'))) return;
        const body={project:p,task:t,confirm:true,revision:h.revision};
        if (a === 'freetalkcontinue' && !confirm(UI.text('確認した要約で新しい会話を始めます。添付ファイルは残ります。続けますか？'))) return;
        if (a === 'freetalkcontinue') { body.summaryId=h.summaryId; body.summary=document.querySelector('.freetalk-summary-input')?.value || ''; }
        el.disabled=true;const active=beginFreetalkPromotionOperation(t);
        try {
          await api('/api/freetalk/rotate',body);if(!active())return;freetalkPromotionDrafts.delete(t);freetalkPromotionErrors.delete(t);
          const key=chatAttachmentKey(p,t); delete chatDraft[key]; instructionHistory.reset(key);
          clearSentChatImages(p,t,[...chatImages(p,t)]); freetalkSummaryDrafts.delete(p+'/'+t+'/'+h.summaryId);
          closePanes(); renderedMainKey=''; await load(); toast(a==='freetalkclear' ? UI.text('空の会話にしました') : UI.text('確認した要約で続けられます'));
        } catch(e){if(active())throw e;}finally { el.disabled=false; }
      }
    }
    else if (a === 'start') await startAI(p, t, el.dataset.ai);
    else if (a === 'stop') { const r=await api('/api/term/stop', { project: p, task: t, ai: el.dataset.ai }); toast(r.ok?'停止処理を終えました。終了と保存の結果は設定の［復旧］で確認できます':'停止を確認できないAIがあります。設定の［復旧］を確認してください'); await load(); }
    else if (a === 'handoff') {
      if (taskFastSaving || accelerationSaving) { toast(UI.text('加速の選択を保存中です')); return; }
      el.disabled = true;
      try {
        const r = await api('/api/term/handoff', { project: p, task: t, from: el.dataset.from, to: el.dataset.to, cols: 100, rows: 30 });
        toast(UI.template`${r.started ? UI.template`${AI_LABEL[r.ai || el.dataset.to]} を始め、` : UI.template`${AI_LABEL[r.ai || el.dataset.to]} に`}引き継ぎ資料を渡しました${r.kind === 'screen' ? UI.text('（会話の記録が読めず、画面の文字で代わりにしました）') : ''}`);
      } finally { await load(); }
    }
    else if (a === 'files') await openFiles(el);
    else if (a === 'mode') setMode(el.dataset.m);
    else if (a === 'split') splitProject(proj(p));
    else if (a === 'handoff-parent') {
      const r = await api('/api/project/handoff', { project: p });
      toast(UI.template`親「${r.parent || ''}」の作業に結果を書き込みました`); await load();
    }
    else if (a === 'pstatus') {
      const done = el.dataset.s === '完了';
      if (done && !confirm(UI.text('このプロジェクトを完了にしますか？（あとで［完了を取り消す］で戻せます）'))) return;
      await api('/api/project/status', { project: p, status: el.dataset.s, confirm: true, expectedHash: proj(p).completionHash }); toast(done ? UI.text('プロジェクトを完了にしました') : UI.text('完了を取り消しました')); await load();
    }
    else if (a === 'nextphase') {
      const info = phaseInfo(proj(p));
      if (!confirm(info.cur === info.list.length - 1 ? UI.text('最後のフェーズとプロジェクトを完了に移しますか？') : UI.text('今のフェーズを完了に移して、次へ進みますか？'))) return;
      await api('/api/phase/next', { project: p, confirm: true, expectedHash: proj(p).completionHash }); toast(UI.text('フェーズを完了にしました')); await load();
    }
    else if (a === 'phasecontinue') { await api('/api/phase/continue', { project: p, expectedHash: proj(p).completionHash }); toast(UI.text('このフェーズを続けます')); await load(); }
    else if (a === 'resultsorganize') {
      el.disabled = true;
      try { await api('/api/task/results/organize', {project:p, task:t, expectedHash:taskOf(proj(p),t).completionHash}); toast(UI.text('成果の整理を頼みました')); await load(); }
      finally {el.disabled = false;}
    }
    else if (a === 'tasktidy') return await showTidy(p, t);
    else if (a === 'taskcomplete' || a === 'taskcontinue') {
      if (a === 'taskcomplete') return showCompletion(p, t, taskOf(proj(p), t).completionHash);
      await api('/api/task/completion', { project: p, task: t, action: a === 'taskcomplete' ? 'approve' : 'continue', confirm: true, expectedHash: taskOf(proj(p), t).completionHash }); toast(a === 'taskcomplete' ? UI.text('完了に移しました') : UI.text('この作業を続けます')); await load();
    }
    else if (a === 'mergeexclude' || a === 'mergeinclude') {
      const excluded = a === 'mergeexclude';
      if (excluded && !confirm(UI.text('本体に取り込まず、取り込み対象から外しますか？作業用コピーとファイルは残り、同じ場所で作業を続けられます。あとで［取り込み対象に戻す］で戻せます。'))) return;
      el.disabled = true;
      try {
        await api('/api/task/merge-exclusion', { project: p, task: t, excluded });
        toast(excluded ? UI.text('取り込み対象から外しました。作業用コピーは残しています') : UI.text('取り込み対象に戻しました'));
      } finally { await load(); }
    }
    else if (a === 'emptyscan') { emptyFound = (await api('/api/empty/scan', {})).items; $('#empty-box').innerHTML = emptyHtml(); }
    else if (a === 'emptyall') document.querySelectorAll('#empty-box input[type=checkbox]').forEach(i => { i.checked = el.dataset.on === '1'; });
    else if (a === 'emptytrash') {
      const keys = [...document.querySelectorAll('#empty-box input:checked')].map(i => i.dataset.key);
      if (!keys.length) { toast(UI.text('選ばれていません')); return; }
      if (!confirm(UI.template`${keys.length} 件をゴミ箱へ移しますか？（ゴミ箱から戻せます）`)) return;
      const items = keys.map(k => { const i = k.indexOf('/'); return { project: k.slice(0, i), task: k.slice(i + 1) || undefined }; });
      const r = await api('/api/empty/trash', { items });
      emptyFound = null; toast(UI.template`${r.moved} 件をゴミ箱へ移しました`); await load();
    }
    else if (a === 'handup') await showTaskTransfer(p,t,[],el.dataset.expectTitle);
    else if (a === 'integrate') await showTaskIntegration(p,t);
    else if (a === 'absorb') {
      const legacy=(state.taskHandoffs || []).some(r=>r.project===p&&r.task===t);
      if(legacy)await showTaskTransfer(p,t,[],el.dataset.expectTitle);
      else await showTaskIntegration(view.project,view.task,[{project:p,task:t,expectTitle:el.dataset.expectTitle}]);
    }
    else if (a === 'copyclear') { const r = await api('/api/task/copyclear', { project: p, task: t }); toast(r.merged ? UI.text('本体に取り込み済みでした。記録を片付けたので、続きは本体で始められます') : UI.text('記録を片付けました。続きは本体で始められます')); await load(); }
    else if (a === 'merge') {
      el.disabled = true;
      await runOneclickMain(p,t);
    }
    else if (a === 'answered') { if (chatSending.has(chatAttachmentKey(p,t))) return; if (!confirm(UI.text('この質問を AI に送らずに消しますか？ AI は続きを始めません。答えを伝えたい時は［この作業で AI に送る］か［選んで送る］を使ってください。'))) return; await api('/api/task', { project: p, task: t, question: '', state: '実行中', dismissQuestion: true, memo: UI.text('人が質問を AI に送らずに消した') }); toast(UI.text('質問を消しました（AI には送っていません）')); await load(); }
  } catch (e) { toast(e.message); } finally {if(a.startsWith('freetalk'))persistFreetalkPromotionDrafts();}
}

function setBodyFolder(p) {
  const i = $('#np-body'); if (!i) return;
  i.value = p;
  const d = i.closest('details'); if (d) d.open = true;
  const n = $('#np-name');
  if (n && !n.value.trim()) n.value = p.split('/').filter(Boolean).pop() || ''; // 名前が空ならフォルダ名を使う
  toast(UI.text('本体のフォルダを入れました'));
}

// Create the original callback at its original registration point in app.js.
function appActionsCallback4224() {
  return (async e => {
  if (e.target.dataset && e.target.dataset.rmref !== undefined) { newRefs.splice(+e.target.dataset.rmref, 1); drawRefs(); return; }
  if (e.target.id === 'np-refpick') {
    try { const r = await api('/api/pick-folder', { prompt: UI.text('参考にするフォルダを選んでください') }); if (r.path) addNewRefs([r.path]); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id !== 'np-pick') return;
  try { const r = await api('/api/pick-folder', { prompt: UI.text('本体のフォルダを選んでください') }); if (r.path) setBodyFolder(r.path); }
  catch (err) { toast(err.message); }
});
}
