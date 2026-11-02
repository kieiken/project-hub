'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function workQuestionHtml(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  return t.question ? UI.template`<div class="wq ask-box"><div class="ask-head"><b>あなたへの質問：</b><span>${richText(t.question)}</span></div>
      <form class="ask-form" id="ask-form" ${k}><input type="text" name="answer" maxlength="2000" placeholder="答えや指示を書く（例：A で進めて）" aria-label="答え"><button class="btn sm" type="submit" title="この答えを、この作業の AI に指示として送ります。作業の続きがこの会話に残ります">この作業で AI に送る</button><button class="btn plain sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button></form>
      <span class="small">答えを送ると、この作業の AI が続きをします。［送らずに消す］は AI には送りません。AI は続きを始めません。</span></div>` : '';
}

function syncWorkQuestion() {
  syncWorkProgress();
  const slot = $('#work-question'), p = proj(view.project), t = taskOf(p, view.task);
  if (view.kind !== 'work' || !slot || !t) return;
  const box = $('#msgs'), top = box?.scrollTop;
  if (slot.dataset.question !== (t.question || '')) {
    slot.dataset.question = t.question || ''; slot.innerHTML = workQuestionHtml(p,t);
  }
  const badge = $('.whead .pill');
  if (badge) { badge.className = `pill s-${t.state}`; badge.textContent = t.continuation?UI.text('継続中'):UI.label(t.state); }
  const select = $('.wfoot [data-act="state"]'); if (select) select.value = t.state;
  if (box) box.scrollTop = top;
  syncWorkAttention();
  updateWorkAnswerControls();
}

// Use the existing phase assignment rule and compact step summary. No task-list
// scan, step-detail request, or completion inference is needed for this strip.
function showWorkProgress() {
  try { return localStorage.getItem('hub-work-progress') === '1'; } catch { return false; }
}

function workProgressHtml(p,t) {
  if (!workFoldAttr(p,t,'progress',true)) return UI.html('<button class="btn plain sm" type="button" data-progress-toggle="open">フェーズと進捗を表示</button>');
  const phases=p.phases||[], current=phases.findIndex(ph=>ph.state!=='完了');
  const assigned=t.phase?phases.findIndex(ph=>ph.name===t.phase):current;
  const phaseDone=phases.filter(ph=>ph.state==='完了').length;
  const finished=t.state==='完了', total=stepCount(t), done=total?progressOf(t).done:0;
  const phaseLabel=assigned>=0?UI.template`この作業：フェーズ ${assigned+1} / ${phases.length}「${esc(phases[assigned].name)}」`:t.phase?UI.template`この作業のフェーズ「${esc(t.phase)}」は一覧にありません`:UI.text(phases.length?'この作業のフェーズ：未指定（全フェーズ完了）':'フェーズ未設定');
  return UI.template`<button class="btn plain sm work-progress-close" type="button" data-progress-toggle="close" aria-label="フェーズと進捗を閉じる" title="この作業の表示を閉じる">×</button><div class="work-progress-summary"><strong>${phaseLabel}</strong><span class="work-progress-state ${finished?'finished':''}">${finished?UI.text('作業全体：完了'):UI.template`作業全体：未完了（${esc(UI.label(t.state))}）`}</span></div>
    <div class="work-progress-counts">${phases.length?UI.template`<span>フェーズ 完了 ${phaseDone} / ${phases.length}・残り ${phases.length-phaseDone}</span>`:''}<span>${total?UI.template`手順 済 ${done} / ${total}・残り ${total-done}`:UI.text('手順未設定')}${!finished&&total&&done===total?UI.text('（作業の完了は未確定）'):''}</span></div>
    ${phases.length?UI.template`<ol class="work-phase-list" aria-label="フェーズ一覧">${phases.map((ph,i)=>UI.template`<li class="${ph.state==='完了'?'done':''} ${i===assigned?'current':''}" ${i===assigned?'aria-current="step"':''}><span>${i+1}. ${esc(ph.name)}</span><small>${esc(ph.state==='完了'?UI.text('完了'):ph.completionPending?UI.text('完了確認待ち'):UI.label(ph.state||'未着手'))}${i===assigned?UI.text('・この作業'):''}</small></li>`).join('')}</ol>`:''}`;
}

function syncWorkProgress() {
  if(view.kind!=='work')return;
  const p=proj(view.project),t=taskOf(p,view.task),host=$('[data-work-progress]');
  if(!t||p.kind==='freetalk'||!host||host.dataset.p!==p.id||host.dataset.t!==t.id)return;
  host.hidden=!showWorkProgress();
  const html=workProgressHtml(p,t);
  if(host.progressHtml!==html){host.innerHTML=html;host.progressHtml=html;}
}

function updateWorkAnswerControls() {
  if (view.kind !== 'work') return;
  const pending = chatSending.has(chatAttachmentKey(view.project, view.task));
  const status = $('#chat-send-status');
  if (status) {
    status.hidden = !pending;
    status.textContent = pending ? UI.text('送信を確認しています…') : '';
  }
  const send = $('#chat-send');
  if (send) {
    const muse=$('#chat-ai')?.value==='muse|direct';
    send.disabled=pending;send.textContent=UI.text(pending?'送っています…':muse?'Museへ送る（外部）':'送る');send.classList?.toggle('muse-send',muse);
    const scope=$('#muse-send-scope');if(scope)scope.hidden=!muse;
  }
  $('#ask-form')?.querySelectorAll('button, input').forEach(el => { el.disabled = pending; });
  if ($('#msgs')) refreshAsks($('#msgs'));
  document.querySelectorAll('.ask').forEach(updateAskControls);
}

async function acceptedWorkAnswer(p, t, question, result, askKey) {
  // API の受付結果と、今の質問の両方を照合する。別の質問は消さない。
  if (!question) return;
  ++stateLoadEpoch; // 送信前の定期取得と、早い busy 通知の取り直しを無効にする。
  const current = taskOf(proj(p.id), t.id);
  const matched = result.answeredQuestion === question && current && (current.question === question || !current.question);
  if (matched) { current.question = ''; current.state = '実行中'; }
  if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id) return;
  if (matched && askKey) document.querySelectorAll('.ask').forEach(a => {
    if (a.dataset.askKey !== askKey) return;
    a.classList.add('answered', 'done'); askDrafts.delete(askKey);
    a.querySelector('.ask-status').textContent = result.queued ? UI.text('回答を受け付けました。AI の開始待ちです。') : UI.text('回答を送信しました。');
  });
  syncWorkQuestion(); updateTurnCounts(); renderTree(); window.HubMobile?.badges();
  if (matched && result.queued && !current?.question) {
    const slot = $('#work-question');
    if (slot) slot.innerHTML = UI.html('<div class="wq" role="status">回答を受け付けました。今の作業が終わったら、この回答で AI が続けます。</div>');
  }
  try { await load({ preserveMain: true }); } catch (err) { toast(UI.text('回答は受け付けました。表示の再取得に失敗しました：') + err.message); }
}

function workFoldAttr(p,t,name,fallback=false) {
  const folds=workFolds.get(JSON.stringify([p.id,t.id]));
  return (folds?.has(name)?folds.get(name):fallback)?'open':'';
}

function rememberWorkFold(el) {
  const work=el.closest?.('.work');
  if(!work||!el.dataset.workFold||el.isConnected===false)return;
  const key=JSON.stringify([work.dataset.p,work.dataset.t]);
  if(!workFolds.has(key))workFolds.set(key,new Map());
  workFolds.get(key).set(el.dataset.workFold,el.open);
}

function rememberDisclosure(el) {
  if(el.isConnected===false)return;
  rememberWorkFold(el);
  webchatUI()?.rememberDisclosure(el);
  if(el.id==='verd')verOpen=el.open;
  if(el.classList?.contains('steps'))stepsOpen=el.open;
  if(el.classList?.contains('project-notes')) {
    if(el.open)projectNotesOpen.add(el.dataset.p);else projectNotesOpen.delete(el.dataset.p);
  }
  if(el.dataset?.aiFold) {
    if(el.open)aiSettingsOpen.add(el.dataset.aiFold);else aiSettingsOpen.delete(el.dataset.aiFold);
  }
}

function dismissDisclosures(target) {
  if(!target)return;
  // Capture visibility before closing any ancestor or the clicked summary opens it.
  const visible=[...document.querySelectorAll('details[open]')].filter(el=>{
    if(!el.getClientRects().length||getComputedStyle(el).visibility!=='visible')return false;
    for(let parent=el.parentElement;parent;parent=parent.parentElement) {
      if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(el))return false;
    }
    return true;
  });
  for(const el of visible) {
    if(el.contains(target))continue;
    // Save UI state before the outside action can synchronously redraw the page.
    el.open=false;rememberDisclosure(el);
  }
}

function captureWorkUi() {
  const work=document.querySelector('.work-compact');if(!work?.dataset.p)return null;
  work.querySelectorAll('details[data-work-fold]').forEach(rememberWorkFold);
  const active=document.activeElement,field=active?.id==='chat-in'?'#chat-in':active?.matches?.('#ask-form input[name="answer"]')?'#ask-form input[name="answer"]':active?.matches?.('.addstep input[name="step"]')?'.addstep input[name="step"]':null;
  return {key:JSON.stringify([work.dataset.p,work.dataset.t]),field,start:active?.selectionStart,end:active?.selectionEnd,
    question:$('#work-question')?.dataset.question,answer:$('#ask-form input[name="answer"]')?.value,step:$('.addstep input[name="step"]')?.value};
}

function restoreWorkUi(saved,p,t) {
  if(!saved||saved.key!==JSON.stringify([p.id,t.id]))return;
  const answer=$('#ask-form input[name="answer"]'),step=$('.addstep input[name="step"]');
  if(answer&&saved.question===(t.question||'')&&saved.answer!==undefined)answer.value=saved.answer;
  if(step&&saved.step!==undefined)step.value=saved.step;
  const field=saved.field&&$(saved.field);
  if(field){field.focus({preventScroll:true});if(saved.start!==null&&saved.start!==undefined)field.setSelectionRange?.(saved.start,saved.end);}
}

function syncWorkAttention() {
  const row=document.querySelector('.work-compact .work-attention');if(!row)return;
  const panel=row.querySelector('.work-alerts-panel'),more=row.querySelector('.work-alerts');if(!panel||!more)return;
  const all=[...row.querySelectorAll('[data-attention-item]')].sort((a,b)=>Number(a.dataset.attentionItem)-Number(b.dataset.attentionItem));
  const visible=all.filter(item=>{
    const body=item.querySelector('[data-attention-body]'),history=body?.querySelector('[data-integration-history]');
    if(history){const slot=document.querySelector('[data-work-history]');if(slot){history.dataset.workFold='integration-history';const p=proj(view.project),t=taskOf(p,view.task);if(t)history.open=Boolean(workFoldAttr(p,t,'integration-history',history.open));slot.replaceChildren(history);}}
    const has=Boolean(body?.textContent.trim()||body?.querySelector('button,input'));
    item.hidden=!has;const label=item.querySelector('summary');if(label){label.dataset.label ||= label.textContent;label.textContent=label.dataset.label+(has?'：'+body.textContent.trim().replace(/\s+/g,' ').slice(0,70):'');}return has;
  });
  for(const item of all){const parent=item===visible[0]?row:panel;if(item.parentElement!==parent)parent.insertBefore(item,parent===row?more:null);if(parent===panel&&visible.includes(item)){const work=row.closest('.work-compact');item.open=Boolean(workFoldAttr({id:work.dataset.p},{id:work.dataset.t},item.dataset.workFold,true));}}
  more.hidden=visible.length<2;more.querySelector('summary').textContent=UI.template`ほか${Math.max(0,visible.length-1)}件`;
  row.hidden=!visible.length;
}

function syncChatHandoff(){
  for(const host of document.querySelectorAll('[data-handoff-status]'))host.innerHTML=chatHandoffHtml(host.dataset.p,host.dataset.t);
}

function chatHandoffHtml(project,task) {
  const rows=(state.chatHandoffErrors||[]).filter(e=>!project||!e.project||e.project===project&&(!e.task||e.task===task));
  if(!rows.length)return '';
  return UI.template`<section class="wq chat-handoff" role="alert"><strong>会話の終了保存が未解決です</strong><p>自動では再処理しません。終了済みの返答と待ち指示は保持されています。</p>${rows.map(e=>UI.template`<div><p>${esc(e.error||'保存記録を確認できません')}（${esc(e.stage||'段階未確認')}）</p>${e.recovery==='confirm-finished'&&e.token&&e.project&&e.task?UI.template`<button type="button" class="btn plain" data-handoff-recover="${esc(e.run)}" data-p="${esc(e.project)}" data-t="${esc(e.task)}" data-token="${esc(e.token)}">終了保存を確認して復旧</button><span class="small">返答の再送や待ち指示の開始は行いません。</span>`:UI.html('<p>処理途中の記録の確認が必要です。復旧できることが確認されるまで保留します。</p>')}</div>`).join('')}</section>`;
}

function fullSteps(p,t) {
  if(Array.isArray(t.steps))return t.steps;
  if(!stepCount(t))return [];
  return openTaskSteps?.project===p.id&&openTaskSteps.task===t.id&&openTaskSteps.version===t.stepSummary?.version ? openTaskSteps.steps : null;
}

function stepLabels(p,t,steps) {
  return steps.map((x,i)=>UI.template`<label><input type="checkbox" data-act="step" data-i="${i}" data-p="${esc(p.id)}" data-t="${esc(t.id)}" ${x.done?'checked':''}> ${esc(x.text)}</label>`).join('');
}

function syncTaskSteps() {
  if(view.kind!=='work')return;
  const p=proj(view.project),t=taskOf(p,view.task);if(!t||p.kind==='freetalk')return;
  const box=$('[data-step-list]');if(!box||box.dataset.p!==p.id||box.dataset.t!==t.id)return;
  const fold=box.closest?.('details.steps');
  if(fold&&(!fold.open||fold.parentElement?.closest('details:not([open])')))return;
  const steps=fullSteps(p,t);
  if(steps){if(box.stepRows!==steps||box.dataset.version!==t.stepSummary?.version){box.innerHTML=stepLabels(p,t,steps);box.stepRows=steps;box.dataset.version=t.stepSummary?.version;}return;}
  box.textContent=UI.text('読み込み中…');
  const key=JSON.stringify([p.id,t.id,t.stepSummary?.version]);if(stepLoads.has(key))return;
  const active=()=>view.kind==='work'&&view.project===p.id&&view.task===t.id&&taskOf(proj(p.id),t.id)?.stepSummary?.version===t.stepSummary?.version;
  const request=api('/api/task/steps?project='+encodeURIComponent(p.id)+'&task='+encodeURIComponent(t.id));
  stepLoads.set(key,request);
  request.then(result=>{
    if(!active())return;
    if(result.version!==t.stepSummary?.version)return load({preserveMain:true});
    openTaskSteps={project:p.id,task:t.id,version:result.version,steps:result.steps};syncTaskSteps();
  }).catch(()=>{if(active()){const slot=$('[data-step-list]');if(slot)slot.innerHTML=UI.html('<button class="btn plain sm" type="button" data-steps-retry>手順を再読込</button>');}}).finally(()=>stepLoads.delete(key));
}

function renderWork() {
  const savedUi = captureWorkUi();
  const scrollKey = JSON.stringify([view.project,view.task]);
  const savedScroll = window.HubChatScroll?.capture($('#msgs'),scrollKey);
  const p = proj(view.project), t = taskOf(p, view.task);
  if (!p || !t) { view.kind = 'project'; return render(); }
  if (p.kind === 'freetalk') {
    $('#main').innerHTML = UI.template`<div class="work freetalk-work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-readonly="${t.freetalkHistory?.migrated ? 'true' : 'false'}"><div class="whead"><button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← freetalk</button><h2>${esc(t.title)}</h2><button class="btn plain sm" type="button" data-act="freetalknew">新しい話題</button></div>${freetalkHistoryHtml(p,t)}<div data-handoff-status data-p="${esc(p.id)}" data-t="${esc(t.id)}">${chatHandoffHtml(p.id,t.id)}</div><div id="work-question" data-question="${esc(t.question || '')}">${workQuestionHtml(p,t)}</div>${chatHtml(p,t)}</div>`;
    closePanes(); window.HubMobile?.mount(scrollKey); openChat(p,t,savedScroll); syncFreetalkMigrationControls(t.freetalkHistory); if(t.freetalkHistory?.migrated){$('#composer').querySelectorAll('button,input,textarea,select').forEach(e=>e.disabled=true);} return;
  }
  const running = AIS.filter(a => live(p.id, t.id, a));
  const main = aiOf(t.owner);
  const shown = running.length ? running : [];
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const mode = workMode();
  const modeSeg = UI.template`<div class="seg" role="group" aria-label="画面の切り替え">
      <button class="${mode === 'chat' ? 'on' : ''}" data-act="mode" data-m="chat" type="button" title="1本の会話で、答える AI を選んで話す">会話</button>
      <button class="${mode === 'term' ? 'on' : ''}" data-act="mode" data-m="term" type="button" title="AI の画面をそのまま動かす">ターミナル${running.length ? `（${running.length}）` : ''}</button></div>`;
  const startBtns = mode === 'chat' ? '' : AIS.filter(a => !running.includes(a)).map(a =>
    UI.template`<button class="btn ${a}${a === main || running.length ? '' : ' sub'}" data-act="start" data-ai="${a}" ${k} type="button" ${aiUnavailable(a) ? `disabled title="${esc(UI.text('設定画面で AI の導入状態とモデル一覧を確認してください'))}"` : ''}>${running.length ? '＋ ' : ''}${AI_LABEL[a]}${running.length ? UI.text('も並べる') : UI.text('で始める')}</button>`).join('');
  $('#main').innerHTML = UI.template`<div class="work work-compact" data-p="${esc(p.id)}" data-t="${esc(t.id)}">
    ${taskFutureHeld(p,t)?UI.template`<p class="note">将来検討として保留中です。作業・会話・比較結果・作業用コピーは残っています。${t.futureHold?UI.template`<button class="btn plain sm" data-act="futurehold" ${futureHoldAttrs(t)} ${k} type="button">保留を解除</button>`:UI.text('親の作業で保留を解除できます')}。解除してもAIや統合は再開しません。</p>`:''}
    <div data-handoff-status data-p="${esc(p.id)}" data-t="${esc(t.id)}">${chatHandoffHtml(p.id,t.id)}</div>
    <div class="whead">
      <div class="work-topline">
        <button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← ${esc(p.name)}</button>
        <h2 title="${esc(t.title)}">${esc(t.title)}</h2><span class="pill s-${esc(t.state)}">${esc(t.continuation?UI.text('継続中'):UI.label(t.state))}</span>
        ${futureHoldBadge(p,t)}
        ${t.role ? UI.template`<span class="small wrole">${esc(UI.label(t.role))}</span>` : ''}
        ${modeSeg}<span class="sp"></span>${startBtns}
        ${t.copy && !t.mergeExcluded && !ProjectOrder.integrators(p,t,state.projects).length ? UI.template`<button class="btn plain" data-act="merge" ${k} type="button" hidden disabled title="表示した範囲を本体に取り込みます">本体に取り込む</button>` : ''}
        <details class="work-more" data-work-fold="more" ${workFoldAttr(p,t,'more')}><summary>その他 ▾</summary><div class="work-more-panel">
          <button class="btn plain" data-go="project" data-p="${esc(p.id)}" type="button">← プロジェクトへ</button>
          <button class="btn plain" type="button" data-idea-open="${esc(p.id)}" data-idea-task="${esc(t.id)}">アイデア台帳</button>
          ${ProjectOrder.ancestorsOf(p,t,state.projects).length?UI.template`<button class="btn plain" data-act="futurehold" ${futureHoldAttrs(t)} ${k} type="button">${t.futureHold?UI.text('将来検討の保留を解除'):UI.text('将来検討として保留')}</button>`:''}
          ${githubUrl(p,t)?UI.template`<button class="btn plain" data-url="${esc(githubUrl(p,t))}" type="button">GitHub</button>`:''}
          <button class="btn plain wfiles" data-act="files" type="button">ファイルを見る</button>
          ${!taskFutureHeld(p,t)&&taskTarget(p,t)&&!live(p.id,t.id)?transferButton(p.id,t.id,t.title,ProjectOrder.finished(t)&&!t.question?UI.text('成果を渡す'):UI.text('成果を渡す（途中）'),'handup','btn plain wfiles'):''}
          ${t.copyMissing?UI.template`<span class="small">作業用コピーが見つかりません</span><button class="btn plain" data-act="copyclear" ${k} type="button">記録を片付ける</button>`:''}
          ${t.copy?(t.mergeExcluded?UI.template`<span class="small">取り込み対象外（コピー保管中）</span><button class="btn plain" data-act="mergeinclude" ${k} type="button">取り込み対象に戻す</button>`:!ProjectOrder.integrators(p,t,state.projects).length?UI.template`<button class="btn plain" data-act="mergeexclude" ${k} type="button" hidden>取り込み対象から外す</button>`:''):''}
          ${!t.completionPending&&!t.resultsPending?completionButtons(p,t):''}
          <details data-work-fold="info" ${workFoldAttr(p,t,'info')}><summary>作業の情報</summary><p>${esc(p.name)} ／ ${esc(t.state)}${t.role?UI.template` ／ ${esc(UI.label(t.role))}`:''}</p>${taskContext(p,t,isPhone())}</details>
          <div data-work-history></div>
          ${mode==='term'?UI.template`<div class="crow account-term">${['claude','codex','grok'].map(ai=>taskAccountSelect(p,t,ai)).join('')}<span data-term-fast-box data-p="${esc(p.id)}" data-t="${esc(t.id)}">${taskFastSelect(p,t,'codex')}</span><span>Agy CLI</span>${specSelect(p,t,'agy',Boolean(sessOf(p.id,t.id,'agy')))}</div>`:''}
        </div></details>
      </div>
      ${t.chatQueueHeld ? UI.template`<div class="wq" role="status">${WORKING(p,t) ? UI.text('AIや成果整理は作業中です。') : ''}停止前の指示は保留中です。自動では始まりません。未処理の指示は会話画面の待ち指示で確認できます。</div>` : ''}
      ${t.copy&&!t.mergeExcluded&&!ProjectOrder.integrators(p,t,state.projects).length?UI.html('<section data-main-preview class="main-merge-inline" role="status" hidden></section>'):''}
      <div class="work-attention" hidden>
        <details class="work-alert" data-attention-item="0" data-work-fold="question" ${workFoldAttr(p,t,'question')}><summary>あなたへの質問・回答</summary><div data-attention-body id="work-question" data-question="${esc(t.question||'')}">${workQuestionHtml(p,t)}</div></details>
        <details class="work-alert" data-attention-item="1" data-work-fold="completion" ${workFoldAttr(p,t,'completion')}><summary>完了・成果の確認</summary><div data-attention-body class="wdone">${t.completionPending||t.resultsPending?completionButtons(p,t):''}</div></details>
        <details class="work-alert" data-attention-item="2" data-work-fold="children" ${workFoldAttr(p,t,'children')}><summary>子作業の成果・取り込みの確認</summary><div data-attention-body data-kids-done>${kidsDoneBar(p,t)}</div></details>
        <details class="work-alert" data-attention-item="3" data-work-fold="background" ${workFoldAttr(p,t,'background')}><summary>裏で作業中</summary><div data-attention-body>${bgOf(p.id,t.id).length||(!t.parent&&bgOf(p.id).filter(x=>!x.task).length)?UI.template`<div class="wq bg-note">${esc(bgText(bgOf(p.id,t.id).length?bgOf(p.id,t.id):bgOf(p.id).filter(x=>!x.task)))}</div>`:''}</div></details>
        <details class="work-alert" data-attention-item="4" data-work-fold="transfer" ${workFoldAttr(p,t,'transfer')}><summary>引渡し・受領のお知らせ</summary><div data-attention-body>${taskTarget(p,t)&&transferNeedsUpdate()?UI.template`<div class="wq">${esc(transferUpdateMessage())}</div>`:''}${partialReceiptBar(p,t)}</div></details>
        <details class="work-alerts" data-work-fold="alerts" ${workFoldAttr(p,t,'alerts')} hidden><summary>ほか0件</summary><div class="work-alerts-panel"></div></details>
      </div>
    </div>
    <div id="muse-approvals" aria-live="polite"></div>
    <section class="work-progress" data-work-progress data-p="${esc(p.id)}" data-t="${esc(t.id)}" ${showWorkProgress()?'':'hidden'} aria-label="作業のフェーズと進捗">${workProgressHtml(p,t)}</section>
    ${mode === 'chat' ? chatHtml(p, t) : UI.template`<div class="panes ${shown.length >= 2 ? 'two' : ''}" id="panes">
      ${shown.length ? shown.map(a => UI.template`<section class="pane" data-ai="${a}">
          <div class="phead"><span class="who w-${AI_KEY[a]}">${AI_LABEL[a]}</span><span class="pstat" data-ai="${a}">${statusText(sessOf(p.id, t.id, a))}</span>${specSelect(p, t, a, true)}<span class="sp"></span>
            ${AIS.filter(other => other !== a).map(other => UI.template`<button class="btn plain sm" data-act="handoff" data-from="${a}" data-to="${other}" ${k} type="button" ${aiUnavailable(other) ? 'disabled' : ''} title="${['agy','grok'].includes(a) ? UI.text('画面に残っている分だけを') : UI.text('今までの会話を')}引き継ぎ資料にまとめて渡します">${AI_LABEL[other]}に交代 →</button>`).join('')}
            <button class="btn plain sm" data-act="stop" data-ai="${a}" ${k} type="button">停止</button></div>
          <div class="pbody" id="pane-${a}"></div></section>`).join('')
        : UI.template`<div class="pane"><div class="pempty">${ownerOf(t.owner).kind === 'chatgpt'
            ? UI.template`この作業は ChatGPT の担当です。［会話］で ChatGPT（Chat／Pro）を選んで送ってください。返答と成果は専用のGPT子へ保存します。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'agent'
            ? UI.template`この作業は ${esc(ownerOf(t.owner).name)}（Discord）に頼んでいます${t.via ? `（${esc(t.via)}）` : ''}。<br>報告を受けたら、下の「手順」に印を付けてください。全部付いたら、完了に移すか確認してください。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'you' ? UI.template`この作業は、あなたの担当です。<br>終わったら、下の「手順」に印を付けるか、状態を「完了」にしてください。`
            : state.terminal
            ? UI.template`まだ AI は動いていません。<br>上の「${AI_LABEL[main]}で始める」を押すと、ここで作業が始まります。<br>ファイルやスクショは、この画面に落とす（または ⌘V で貼る）と AI に渡せます。<br>${esc(t.next ? UI.text('次にやること：') + t.next.split('\n')[0] : '')}`
            : UI.html('作業画面の部品が未設定です。［設定］をご覧ください。<br>それまでは、始めると別の窓で開きます。')}</div></div>`}
    </div>`}
    <div class="wfoot"><details class="work-management" data-work-fold="management" ${workFoldAttr(p,t,'management')}><summary>作業の管理（状態：${esc(UI.label(t.state))}・手順 ${progressOf(t).done}/${stepCount(t)}）</summary><div class="work-management-body">
      <select data-act="state" ${k} aria-label="状態">${!STATES.includes(t.state) ? UI.template`<option selected disabled>${esc(UI.label(t.state))}</option>` : ''}${STATES.map(s => UI.template`<option ${s === t.state ? 'selected' : ''}${UI.valueAttribute(s)}>${UI.label(s)}</option>`).join('')}</select>
      ${mode === 'term' && CLI(t.owner) && !shown.length ? specSelect(p, t, main) : ''}
      ${p.phases.length ? UI.template`<select data-act="phase" ${k} aria-label="フェーズ" title="この作業のフェーズ"><option value="">フェーズ：今のフェーズ</option>${p.phases.map(ph => UI.template`<option ${t.phase === ph.name ? 'selected' : ''}>${esc(ph.name)}</option>`).join('')}</select>` : ''}
      <details class="more steps" data-work-fold="steps" ${workFoldAttr(p,t,'steps')}><summary>手順 ${stepCount(t) ? `${progressOf(t).done} / ${stepCount(t)}` : UI.text('（なし）')}</summary><div class="step-tools"><button class="btn plain sm" data-steps-close type="button">手順を閉じる</button></div><div class="stepbox"><div data-step-list data-p="${esc(p.id)}" data-t="${esc(t.id)}">${workFoldAttr(p,t,'management')&&workFoldAttr(p,t,'steps')&&fullSteps(p,t) ? stepLabels(p,t,fullSteps(p,t)) : UI.text('開くと手順を読み込みます')}</div>
        <form class="addstep" data-p="${esc(p.id)}" data-t="${esc(t.id)}"><input name="step" maxlength="120" placeholder="手順を足す（例：下書き）" aria-label="手順を足す"><button class="btn plain sm" type="submit">足す</button></form></div></details>
      <label class="small">種類<select data-act="kind" ${k}><option value="main" ${t.kind!=='derived'?'selected':''}>本作業</option><option value="derived" ${t.kind==='derived'?'selected':''}>派生</option></select></label>
      <label class="small">派生元<select data-act="derivedFrom" ${k}><option value="">（なし）</option>${sourceOptions(p,t)}</select></label>
      <label class="small">場所<select data-act="workspaceMode" ${k} ${t.workspaceStarted || t.state!=='未着手' || t.workdir || live(p.id,t.id) ? 'disabled' : ''}><option value="isolated" ${t.workspaceMode!=='direct'?'selected':''}>作業用コピー</option><option value="direct" ${t.workspaceMode==='direct'?'selected':''}>本体（合体不要）</option></select></label>
      ${t.skills.length ? UI.template`<details class="more"><summary>使ったスキル（${t.skills.length}）</summary><ul class="skills">${t.skills.map(s => UI.template`<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
    </div></details></div></div>`;
  closePanes();
  const kidsDone=$('[data-kids-done]');if(kidsDone)kidsDone.kidsHtml=kidsDoneBar(p,t);
  syncWorkAttention();
  window.HubMobile?.mount(scrollKey);
  if (mode === 'chat') openChat(p, t, savedScroll); else shown.forEach(a => attach(p.id, t.id, a));
  restoreWorkUi(savedUi,p,t);
  syncTaskSteps();
  if (state.museSupported !== false) loadMuseApprovals(p.id,t.id);
  if (mode !== 'chat' && t.copy && !t.mergeExcluded) loadPreview(p.id, t.id);
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback676() {
  return (e => {
  if (e.target.id !== 'ask-form') return;
  e.preventDefault();
  const answer = e.target.elements.namedItem('answer').value.trim();
  if (!answer) { toast(UI.text('答えを書いてください')); return; }
  if (chatSending.has(chatAttachmentKey(e.target.dataset.p, e.target.dataset.t))) return;
  const ta = $('#chat-in');
  if (!ta) { toast(UI.text('会話画面で送ってください（上の「会話」を選ぶ）')); return; }
  const text = UI.template`（質問「${(e.target.closest('.ask-box').querySelector('.ask-head span') || {}).textContent || ''}」への答え）${answer}`;
  if (sendWorkAnswer?.project === e.target.dataset.p && sendWorkAnswer.task === e.target.dataset.t) sendWorkAnswer.send(text);
});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback693() {
  return (async e => {
  if (!e.target.closest || !e.target.closest('#turn-answer-all')) return;
  const list = state.projects.flatMap(p => p.tasks.filter(t => REPLY(p, t)).map(t => ({ p, t })));
  if (list.some(({p,t}) => chatSending.has(chatAttachmentKey(p.id,t.id)))) { toast(UI.text('回答を送っています。受付結果が出てから操作してください')); return; }
  if (!list.length || !confirm(UI.template`${list.length} 件すべての質問を AI に送らずに消しますか？ AI は続きを始めません。`)) return;
  let ok = 0;
  for (const { p, t } of list) { try { await api('/api/task', { project: p.id, task: t.id, question: '', state: '実行中', dismissQuestion: true, memo: UI.text('人が質問を AI に送らずに消した') }); ok++; } catch (err) { toast(err.message); } }
  toast(UI.template`${ok} 件の質問を消しました（AI には送っていません）`); await load();
});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback702() {
  return (e => {
  const b = e.target.closest && e.target.closest('[data-turn-tab]');
  if (b) { turnTab = b.dataset.turnTab; render(); }
});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback1122() {
  return (e=>{disclosurePress={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback1123() {
  return (e=>{
  if(disclosurePress&&disclosurePress.id===e.pointerId&&Math.hypot(e.clientX-disclosurePress.x,e.clientY-disclosurePress.y)>6)disclosurePress.moved=true;
});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback1126() {
  return (()=>{if(disclosurePress)disclosurePress.cancelled=true;});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback1127() {
  return (e=>{
  const press=disclosurePress;disclosurePress=null;
  if(e.detail&&press&&(press.moved||press.cancelled||Math.hypot(e.clientX-press.x,e.clientY-press.y)>6))return;
  dismissDisclosures(e.target);
});
}

// Create the original callback at its original registration point in app.js.
function appWorkCallback1169() {
  return (async e=>{
  const b=e.target.closest?.('[data-handoff-recover]');if(!b||b.disabled)return;
  const {handoffRecover:run,p:project,t:task,token}=b.dataset;
  const issue=(state.chatHandoffErrors||[]).find(x=>x.run===run&&x.project===project&&x.task===task&&x.token===token&&x.recovery==='confirm-finished');
  if(!issue){toast('保存記録が変わっています。画面を更新して確認してください');return;}
  b.disabled=true;
  try{await api('/api/chat/handoff/recover',{project,task,run,token});await load();render();toast('終了保存を確認しました。待ち指示は保持しています。');}
  catch(e){toast(e.message);}finally{b.disabled=false;}
});
}


// Daily-use approval is a human action. Never call decide from an AI tool.
const museApprovalDecisions = new Map();
function museApprovalHtml(row) {
  const status = { accepted:'承認済み・AIへの続きの依頼を受け付けました。', declined:'取りやめました。送信しません。',
    approved:'許可は保存済みです。続きの受付を確認してください。', unknown:'結果の照合が必要です。この会話で確認を依頼してください。',
    unavailable:'Museの依頼内容または期限を確認できません。この会話で確認を依頼してください。' };
  if (row.state !== 'pending') return UI.template`<div class="wq" role="status">${esc(UI.text(status[row.state] || status.unknown))}</div>`;
  const p = row.preview;
  return UI.template`<section class="wq" data-muse-approval="${esc(row.id)}"><b> Museへ送る内容の確認</b>
    <p>送り先：${esc(p.destination)}<br>題名：${esc(p.topic)}<br>期限：${esc(p.expires_at)}<br>質問・操作の上限：${p.rounds} 回／読戻し：${p.max_reads} 回</p>
    <details><summary>資料全文・送る内容を確認</summary><pre>${esc(p.packet_full_text)}</pre><pre>${esc(JSON.stringify(p.request,null,2))}</pre></details>
    <button class="btn sm" type="button" data-muse-decision="approve">承認して続ける</button>
    <button class="btn plain sm" type="button" data-muse-decision="decline">やめる</button>
    <p class="small">承認した資料・題名の範囲でAIが質問と追問を作り、この会話へ結果を返します。</p></section>`;
}
async function loadMuseApprovals(project,task) {
  if (typeof state !== 'undefined' && state.museSupported === false) return;
  const host = $('#muse-approvals');
  if (!host || view.kind !== 'work' || view.project !== project || view.task !== task) return;
  const current = () => $('#muse-approvals') === host && view.kind === 'work' && view.project === project && view.task === task;
  const epoch = host.museEpoch = (host.museEpoch || 0) + 1;
  try {
    const value = await api('/api/muse/approvals?'+new URLSearchParams({project,task}),null,{'X-Hub':'1'});
    if (!current() || epoch !== host.museEpoch) return;
    host.innerHTML = value.approvals.map(row => museApprovalHtml(museApprovalDecisions.has(JSON.stringify([project,task,row.id])) && row.state === 'pending'
      ? { ...row,state:'unknown' } : row)).join('');
    host.hidden = !host.innerHTML;
    host.onclick = async event => {
      const button = event.target.closest('[data-muse-decision]'), card = button?.closest('[data-muse-approval]');
      if (!button || !card || button.disabled || !current()) return;
      const row = value.approvals.find(r=>r.id === card.dataset.museApproval);
      const key = JSON.stringify([project,task,row?.id]);
      if (!row || museApprovalDecisions.has(key)) return;
      if (!confirm(UI.text(button.dataset.museDecision === 'approve' ? '表示された全文・送り先・期限・回数の範囲を承認し、AIが続きを行ってよいですか？' : 'この依頼を取りやめますか？送信もAIの継続も行いません。'))) return;
      museApprovalDecisions.set(key,'pending');
      card.querySelectorAll('button').forEach(b=>{b.disabled=true;});
      // Invalidate a concurrent list response before sending the human decision.
      host.museEpoch++;
      try {
        const result = await api('/api/muse/approvals/decide',{project,task,id:row.id,ticket:row.ticket,decision:button.dataset.museDecision,confirm:true});
        museApprovalDecisions.set(key,result.state);
        if (current()) card.innerHTML = museApprovalHtml({state:result.state});
      } catch {
        museApprovalDecisions.set(key,'unknown');
        if (current()) card.innerHTML = museApprovalHtml({state:'unknown'});
      }
    };
  } catch {
    if (current() && epoch === host.museEpoch) {
      host.innerHTML = '';
      host.onclick = null;
      host.hidden = true;
    }
  }
}
