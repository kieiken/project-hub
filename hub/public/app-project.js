'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function transferNeedsUpdate() {
  if (!/^\d+\.\d+\.\d+$/.test(state.version || '')) return false;
  const parts = state.version.split('.').map(Number);
  for (let i = 0; i < TASK_TRANSFER_MIN_VERSION.length; i++) if (parts[i] !== TASK_TRANSFER_MIN_VERSION[i]) return parts[i] < TASK_TRANSFER_MIN_VERSION[i];
  return false;
}

function transferUpdateMessage() {
  const next = state.latest ? `［${updateLabel(state.version, state.latest)}］` : UI.text('新版へ切り替えるボタン');
  const reason = transferNeedsUpdate() ? UI.template`受け取りは新しい版の機能です。今動いている Hub はまだ v${state.version} です。` : UI.template`この稼働版では受け取りの窓口を確認できませんでした（稼働版 v${state.version || UI.text('不明')}）。`;
  return UI.template`${reason}AI と順番待ちが終わってから、プロジェクト「${proj(view.project)?.name || view.project}」の画面上部に${next}が表示されていれば押してください。`;
}

function transferButton(project, task, title, label = UI.text('成果を受け取る'), action = 'absorb', classes = 'btn sm') {
  const update = transferNeedsUpdate();
  const hint = action === 'handup' ? UI.template`「${title}」の成果を親へ知らせます。途中の成果は親の［統合…］で受け取り、子を閉じずに続けられます` : UI.template`子作業「${title}」の成果と統合内容を確認します`;
  return UI.template`<button class="${classes}" data-act="${action}" data-p="${esc(project)}" data-t="${esc(task)}" data-expect-title="${esc(title)}" type="button" ${update ? 'disabled' : ''} title="${esc(update ? transferUpdateMessage() : hint)}">${label}</button>`;
}

// A held ancestor also keeps its descendants outside integration. Missing or
// unreadable records stay visible so uncertainty is never hidden.
function taskFutureHeld(p,t,all=state.projects||[]){
  if(!p||!t)return false;
  const rows=[{project:p,task:t},...ProjectOrder.ancestorsOf(p,t,all)];
  return !rows.some(x=>x.task.futureHoldError)&&rows.some(x=>x.task.futureHold===true);
}
function futureHoldBadge(p,t){return taskFutureHeld(p,t)?UI.template`<span class="pill">将来検討</span>`:t.futureHoldError?UI.template`<span class="small">${esc(t.futureHoldError)}</span>`:'';}
function futureHoldAttrs(t){return `data-future-before="${Boolean(t.futureHold)}" data-future-revision="${esc(t.futureHoldRevision||'')}" data-future-hash="${esc(t.completionHash||'')}"`;}
async function saveFutureHold(project,task,el){
  if(el?.disabled)return;
  const p=proj(project),t=taskOf(p,task);if(!t)throw Error(UI.text('作業が見つかりません'));
  if(t.futureHoldError)throw Error(t.futureHoldError);
  const displayed=el?.dataset?.futureBefore,before=displayed===undefined?Boolean(t.futureHold):displayed==='true';
  const held=!before,body={project,task,held,before,revision:displayed===undefined?t.futureHoldRevision||null:el.dataset.futureRevision||null,expectedHash:displayed===undefined?t.completionHash:el.dataset.futureHash,confirm:true};
  if(el)el.disabled=true;
  try{const r=await api('/api/task/future-hold',body);if(r.ok!==true||r.held!==held)throw Error(UI.text('保留の保存結果を確認できません。最新の表示を確認してください'));await load();toast(UI.text(held?'将来検討として保留しました。作業と会話は残っています':'保留を解除しました。AIや統合は再開しません'));}
  finally{if(el)el.disabled=false;}
}

function integrationOfferPending(offer){return offer?.pending===true&&(!offer.received||offer.receiptChecked===true);}

function integrationMainNotice(p,t,pending){
  if(!pending)return '';
  const evidence=integrationMainEvidence.get(p.id+'\0'+t.id);
  const reflected=evidence?.key===JSON.stringify(pending)&&evidence.instance===state.hubInstance&&Date.now()-evidence.at<30000&&evidence.reflected===true;
  const history=UI.template`${pending.stopped?UI.template`<p>${UI.text('過去の停止理由')}：${esc(UI.text(pending.stopped.reason||'状態未確認'))}</p>`:''}<p>${UI.text('以前の記録を保持しています。この記録から再送はしません')}</p>${reflected&&evidence.mainUncommitted?UI.template`<p>${UI.text('本体には別の未保存変更があります。この取り込み結果とは別です')}（${String(evidence.mainUncommitted)}）</p>`:''}`;
  if(reflected)return UI.template`<details class="note" data-integration-history><summary>過去の本体取り込み記録（現在の本体に反映済み）</summary>${history}</details>`;
  return UI.template`<div class="wq" data-integration-main><span>${UI.text('本体への反映が未確認です')}${pending.stopped?UI.template`<br>${UI.text('過去の停止理由')}：${esc(UI.text(pending.stopped.reason||'状態未確認'))}`:''}${pending.main?.state==='intent'?UI.template`<br>${UI.text('本体取り込みの結果が不明です。再送はしません')}`:''}</span></div>`;
}

function kidsDoneBar(p, t) {
  const all=state.projects || [p];
  const heldRow=r=>{const q=all.find(q=>q.id===(r.project||p.id)),x=q?.tasks.find(t=>t.id===r.task);return taskFutureHeld(q,x,all);};
  const pending = (state.taskHandoffs || []).filter(r=>r.targetProject===p.id&&r.targetTask===t.id&&!heldRow(r));
  const kids=all.flatMap(q=>q.tasks.filter(x=>ProjectOrder.canIntegrate({project:p,task:t},q,x,all)&&!x.freetalk&&!taskFutureHeld(q,x,all)).map(x=>({project:q,task:x})));
  const retained=kids.filter(({project:q,task:x})=>(state.taskOffers||[]).some(r=>r.project===q.id&&r.task===x.id&&r.targetProject===p.id&&r.targetTask===t.id&&r.pending===false));
  const receivedKeys=new Set(retained.map(({project:q,task:x})=>q.id+'\0'+x.id));
  const fresh=kids.filter(({project:q,task:x})=>{
    const offer=(state.taskOffers||[]).find(r=>r.project===q.id&&r.task===x.id&&r.targetProject===p.id&&r.targetTask===t.id);
    return offer?integrationOfferPending(offer)&&(offer.handedUp||ProjectOrder.finished(x)):!Array.isArray(state.taskOffers)&&!receivedKeys.has(q.id+'\0'+x.id)&&ProjectOrder.finished(x);
  });
  const active=(state.taskIntegrations || []).find(r=>r.project===p.id&&r.task===t.id);
  const mainPending=active?.mainPending,childrenActive=active&&active.stage!=='main'&&(!active.items?.length||!active.items.every(heldRow));
  const mainNotice=integrationMainNotice(p,t,mainPending);
  if (!fresh.length && !pending.length && !childrenActive) return mainNotice;
  const button=UI.template`<button class="btn sm" data-act="integrate" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" ${transferNeedsUpdate()?'disabled':''}>統合…</button>`;
  return UI.template`<div class="wq kids-done"><b>子作業の成果：</b>${button}${pending.map(r=>UI.template`<span class="kid">${esc(r.title)}${transferButton(r.project,r.task,r.title,UI.text('引渡しの残りを続ける'))}</span>`).join('')}${transferNeedsUpdate()?UI.template`<p class="transfer-hint">${esc(transferUpdateMessage())}</p>`:''}</div>`+mainNotice;
}

function refreshKidsDoneBar() {
  if(view.kind!=='work')return;
  const box=$('[data-kids-done]'),p=proj(view.project),t=taskOf(p,view.task);
  if(box&&t){const html=kidsDoneBar(p,t);if((box.kidsHtml??box.innerHTML)!==html){const old=document.querySelector('[data-work-history]');if(old){old.querySelectorAll('details[data-work-fold]').forEach(rememberWorkFold);old.innerHTML='';}box.innerHTML=html;box.kidsHtml=html;}syncWorkAttention();}
}

function partialReceiptBar(p,t){
  const r=(state.taskOffers||[]).find(x=>x.project===p.id&&x.task===t.id)?.received;
  return r?UI.template`<div class="wq">途中受領済み：${esc(r.head?.slice(0,7)||'—')}・${esc(r.at)} ／ ${UI.text('まだ渡していない保存')} ${r.pendingCommits===null?UI.text('不明'):r.pendingCommits} 件</div>`:'';
}

function copiesHtml(p) {
  const list = p.tasks.filter(t => t.copy), other = p.copies - list.length;
  return UI.template`<details class="copies small"><summary title="Work フォルダに残っている作業用コピー">作業用コピー ${p.copies} 件</summary><div>${list.map(t => UI.template`<button class="lnk" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button">${esc(t.title)}</button>`).join(' ')}${other > 0 ? UI.template`<span>ほか、作業の記録が無いコピー ${other} 件</span>` : ''}<span>作業の［本体に取り込む］で、取り込み後も続けるか片付けるかを確認できます</span></div></details>`;
}

function nextName(base, existing) {
  const stem = String(base || '').replace(/\s+\d+$/, '').trim();
  const used = new Set(existing.map(x => String(x || '').trim()));
  for (let n = 2; n < 1000; n++) if (!used.has(`${stem} ${n}`)) return `${stem} ${n}`;
  return `${stem} 2`;
}

function renderEmpty() {
  $('#main').innerHTML = UI.template`<div class="view"><div class="empty"><h2>台帳が見つかりません</h2>
    <p><code>${esc(state.root)}/Product/</code> に台帳（PROJECT.md）がありません。</p>
    <p>ターミナルで <code>bash setup.sh</code> を実行すると、今の作業の台帳が作られます。</p>
    <p>AIの準備は、順番に案内します。</p><button class="btn" type="button" data-onboarding-open>はじめの設定</button></div></div>`;
}

function renderTurn(list) {
  const reply = list.filter(({ p, t }) => notificationKind(p, t) === 'reply');
  const work = list.filter(({ p, t }) => notificationKind(p, t) === 'work');
  const done = list.filter(({ p, t }) => notificationKind(p, t) === 'done');
  const results = list.filter(({ p, t }) => notificationKind(p, t) === 'results');
  const cur = turnTab === 'done' ? done : turnTab === 'work' ? work : turnTab === 'results' ? results : reply;
  $('#main').innerHTML = UI.template`<div class="view"><div class="ph"><h2>あなたの番</h2>
      <div class="seg turn-tabs" role="tablist"><button class="${turnTab === 'reply' ? 'on' : ''}" data-turn-tab="reply" type="button" role="tab" aria-selected="${turnTab === 'reply'}">返事待ち（${reply.length}）</button><button class="${turnTab === 'work' ? 'on' : ''}" data-turn-tab="work" type="button" role="tab" aria-selected="${turnTab === 'work'}">作業中（${work.length}）</button><button class="${turnTab === 'results' ? 'on' : ''}" data-turn-tab="results" type="button" role="tab" aria-selected="${turnTab === 'results'}">成果確認（${results.length}）</button><button class="${turnTab === 'done' ? 'on' : ''}" data-turn-tab="done" type="button" role="tab" aria-selected="${turnTab === 'done'}">完了（${done.length}）</button></div>
      <span class="small">${turnTab === 'done' ? UI.text('AI が終わったと言っている作業。中身を見て、完了に移すか続けるかを決めます') : turnTab === 'work' ? UI.text('AI・成果確認・成果整理が動いている、または指示が順番待ちの作業') : turnTab === 'results' ? UI.text('成果の記録に確認が必要な作業。内容を開いて、整理を頼むか確認します') : UI.text('返事待ち・上限で止まっている作業と、AI が入力や選択を待っている作業')}</span><span class="sp"></span>
      ${turnTab === 'reply' && reply.length > 1 ? UI.template`<button class="btn plain sm" id="turn-answer-all" type="button" title="AI には送らず、すべての返事待ちの表示を消します。AI は続きを始めません。">すべて送らずに消す（${reply.length}）</button>` : ''}</div>
    ${turnTab === 'reply' && cur.length ? UI.html('<p class="small">［送らずに消す］は質問と返事待ちの表示だけを消します。AI には送らず、続きを始めません。</p>') : ''}
    ${cur.length ? UI.template`<div class="card">${cur.map(({ p, t }) => taskRow(p, t, true, turnTab)).join('')}</div>` : UI.template`<p class="note">${turnTab === 'done' ? UI.text('完了に移すものはありません。') : turnTab === 'work' ? UI.text('作業中のものはありません。') : turnTab === 'results' ? UI.text('成果の確認が必要なものはありません。') : UI.text('返事が必要なものはありません。')}</p>`}</div>`;
}

function splitProject(p) {
  if (!p) return;
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  el.innerHTML = UI.template`<div class="fs-box"><div class="fs-head"><b>「${esc(p.name)}」を子プロジェクトに分ける</b><span class="small">1行に1つ。「名前｜やること」の形。名前を省くと「${esc(p.name)} 2」「${esc(p.name)} 3」…になります。作ったあと、それぞれの最初の作業をすぐ AI に頼みます（同時に進みます）</span></div>
    <div class="fs-list" style="padding:12px"><textarea id="split-lines" rows="6" style="width:100%" placeholder="例：\n受付画面｜入退室の受付画面を作る\n決済｜決済の仕組みを調べて設計する\n通知｜保護者への通知を作る"></textarea></div>
    <div class="acts fs-acts"><span class="small" id="split-note"></span><span class="sp"></span><button type="button" class="btn plain" data-fs-close>やめる</button><button type="button" class="btn" id="split-go">分けて始める</button></div></div>`;
  $('#split-lines').focus();
  $('#split-go').onclick = async () => {
    const lines = $('#split-lines').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) { toast(UI.text('1行以上書いてください')); return; }
    if (lines.length > 8) { toast(UI.text('一度に分けるのは8つまでにしてください')); return; }
    if (!confirm(UI.template`${lines.length} つの子プロジェクトを作り、それぞれの最初の作業を AI に頼みます。よいですか？`)) return;
    $('#split-go').disabled = true;
    const names = state.projects.map(x => x.name);
    let made = 0;
    for (const line of lines) {
      const m = line.match(/^(.*?)\s*[|｜:：]\s*(.+)$/);
      const text = m ? m[2].trim() : line;
      const name = m && m[1].trim() ? m[1].trim() : nextName(p.name, names);
      names.push(name);
      $('#split-note').textContent = UI.template`${name} を作っています…`;
      try {
        const child = await api('/api/project/new', { name, parent: p.id, description: text.slice(0, 200), phases: (p.phases || []).map(x => x.name).join('\n') });
        await api('/api/start', { project: child.id, text, ...defaultWorkPick('司令塔'), images: [] });
        open.add(child.id); made++;
      } catch (err) { toast(`${name}：${err.message}`); }
    }
    $('#fsheet').hidden = true;
    toast(UI.template`${made} つの子プロジェクトを作って、作業を始めました`);
    open.add(p.id); save(); await load();
  };
}

function warnChildren(p) {
  const u = p ? unfinishedChildren(p) : [];
  return !u.length || confirm(UI.template`子プロジェクトの作業が ${u.length} 件終わっていません（${u.map(x => x.name).join('、')}）。\n親で作業を進めますか？`);
}

function drawRefs() {
  const box = $('#np-reflist'); if (!box) return;
  box.innerHTML = newRefs.length ? newRefs.map((r, i) => UI.template`<span class="ref" title="${esc(r)}">${esc(r.split('/').filter(Boolean).pop() || r)}<button type="button" data-rmref="${i}" aria-label="外す">×</button></span>`).join('') : UI.html('<span class="small">ここに落とす、または［選ぶ］</span>');
}

function addNewRefs(paths) {
  for (const x of paths) if (x && !newRefs.includes(x)) newRefs.push(x);
  drawRefs();
  const d = $('#np-refs') && $('#np-refs').closest('details'); if (d) d.open = true;
}

function renderNewProject() {
  const opts = state.projects.filter(p => p.kind !== 'freetalk').map(p => UI.template`<option value="${esc(p.id)}" ${newProjectPreset?.parent === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#main').innerHTML = UI.template`<div class="view"><div class="ph"><h2>${newProjectPreset?.derivedFrom ? UI.text('同じ階層に分岐') : newProjectPreset?.parent ? UI.text('子プロジェクトを作る') : UI.text('新しいプロジェクト')}</h2></div>
    <div class="card"><form class="newform" id="projform">
      <input type="hidden" name="derivedFrom" value="${esc(newProjectPreset?.derivedFrom || '')}"><label>プロジェクト名<input name="name" id="np-name" required maxlength="60" placeholder="例：HD 占いアプリ" value="${esc(newProjectPreset?.name || '')}"></label>
      ${newProjectPreset ? UI.template`<label>最初の作業（やりたいこと。書くと、作ったあとすぐ AI に頼みます。名前だけのプロジェクトにしないため）<textarea name="firstTask" rows="2" maxlength="4000" placeholder="例：台湾向けの投稿を3本作る"></textarea></label>` : ''}
      <label>説明（何を作るか・誰のためか。1〜2行）<textarea name="description" id="np-desc" rows="2" maxlength="400"></textarea></label>
      <label>フェーズ（1行に1つ。順番どおり）<textarea name="phases" id="np-phases" rows="4" maxlength="400">計画\n作る\nチェック\n仕上げ</textarea></label>
      <details class="more"><summary>くわしく（なくてもよい）</summary><div class="newform" style="margin-top:10px">
        <label>本体のフォルダ（もうコードや資料がある時）
          <div class="dropfield" id="np-drop"><input name="body" id="np-body" maxlength="300" placeholder="ここにフォルダを落とす、または［選ぶ］"><button class="btn plain sm" id="np-pick" type="button">選ぶ…</button></div></label>
        <label>親プロジェクト（小分けにする時）<select name="parent" id="np-parent"><option value="">（なし）</option>${opts}</select></label>
        <label>参考にするフォルダ・ファイル（Hub の外。AI は読むだけで書き換えない。何個でも）
          <div class="dropfield refs" id="np-refs"><div class="reflist" id="np-reflist"><span class="small">ここに落とす、または［選ぶ］</span></div><button class="btn plain sm" id="np-refpick" type="button">選ぶ…</button></div></label>
        ${state.projects.length ? UI.template`<fieldset class="rels"><legend>関連プロジェクト（Hub の他のプロジェクト。AI がその資料を読んでよい）</legend>${state.projects.filter(p => p.kind !== 'freetalk').map(p => UI.template`<label class="chk"><input type="checkbox" name="related" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')}</fieldset>` : ''}
      </div></details>
      <p class="small">台帳（PROJECT.md）・AI 用の指示（CLAUDE.md・AGENTS.md）・作業用のフォルダ（資料・作業・成果物・.ai）を <span class="path">${esc(state.root)}/Product/</span> に作ります。</p>
      <div><button class="btn" type="submit">プロジェクトを作る</button></div>
    </form></div></div>`;
  drawRefs();
  if (newRefs.length) $('#np-refs').closest('details').open = true;
}

function projectFamily(p) {
  const root = q => { let seen = new Set(); while (q && !seen.has(q.id)) { seen.add(q.id); const next = proj(displayParent(q,state.projects)); if (!next) return q.id; q=next; } return p.id; };
  const id=root(p); return state.projects.filter(q=>root(q)===id);
}

function sourceTask(p, ref) {
  if (!ref) return null; const i=ref.indexOf('/'); const q=i<0?p:proj(ref.slice(0,i)), t=taskOf(q,i<0?ref:ref.slice(i+1)); return q&&t?{p:q,t}:null;
}

function taskContext(p,t,compact) {
  const src = sourceTask(p,t.derivedFrom);
  if (compact) {
    const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
    const busy = derived.filter(x => live(x.p.id, x.t.id)).length, fin = derived.filter(x => x.t.state === '完了').length;
    const parts = [UI.template`<span class="pill">${t.kind==='derived'?UI.text('派生'):UI.text('本作業')}</span>`];
    if (src) parts.push(UI.template`派生元：<button class="lnk" data-go="work" data-p="${esc(src.p.id)}" data-t="${esc(src.t.id)}" type="button">${esc(src.t.title)}</button>`);
    if (derived.length) parts.push(UI.template`渡した作業 ${derived.length}件（作業中 ${busy}・終わった ${fin}）`);
    parts.push(t.copy ? UI.text('作業用コピー') : t.workspaceMode==='direct' || t.workspaceStarted ? UI.text('本体で作業') : UI.text('場所は開始時に決定'));
    return UI.template`<div class="task-context small">${parts.join(UI.html('<i class="sep">・</i>'))}</div>`;
  }
  const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
  const stat = x => (live(x.p.id, x.t.id) ? UI.template`<span class="pst busy"><i></i>${esc(ownerOf(x.t.owner).name)} が作業中</span>` : x.t.state === '完了' ? UI.html('<span class="small">終わった</span>') : UI.template`<span class="small">${esc(UI.label(x.t.state))}</span>`);
  const link = x => UI.template`<button class="lnk" data-go="work" data-p="${esc(x.p.id)}" data-t="${esc(x.t.id)}" type="button">${esc(x.p.name)} / ${esc(x.t.title)}</button>`;
  return UI.template`<div class="task-context small"><span class="pill">${t.kind==='derived'?UI.text('派生'):UI.text('本作業')}</span>${src ? UI.text(' 派生元：')+link(src) : ''}${derived.length ? UI.text('　渡した・派生した作業：')+derived.map(x => `${link(x)} ${stat(x)}`).join(' / ') : ''}　${t.copy?UI.text('作業用コピーで作業'):t.workspaceMode==='direct' || t.workspaceStarted?UI.text('本体で作業（合体不要）'):UI.text('作業場所：開始時に決定（Gitのない場所は本体）')}</div>`;
}

function sourceOptions(p,t) {
  return projectFamily(p).flatMap(q=>q.tasks.filter(x=>!t || x.id!==t.id || q.id!==p.id).map(x=>UI.template`<option value="${esc(q.id+'/'+x.id)}" ${t && (t.derivedFrom===q.id+'/'+x.id || q.id===p.id && t.derivedFrom===x.id) ? 'selected' : ''}>${esc(q.name)} / ${esc(x.title)}</option>`)).join('');
}

function taskRow(p, t, showProject, tab) {
  const cur = t.stepSummary ? t.stepSummary.next : t.steps?.find(x => !x.done);
  const sub = t.question ? UI.template`<span class="q2">あなたへの質問：${linkify(t.question)}</span>`
    : UI.template`<span>${showProject ? esc(p.name) + '・' : ''}${t.state === '完了' ? UI.text('完了') : cur ? UI.text('次：') + esc(cur.text) : t.next ? UI.text('次：') + esc(t.next.split('\n')[0]) : esc(UI.label(t.state))}</span>`;
  const kind = notificationKind(p, t);
  const status = t.question ? UI.text('返事待ち')
    : t.state === '返事待ち' || t.state === '上限で停止' ? UI.label(t.state)
    : kind === 'reply' ? t.chatQueueHeld ? WORKING(p,t) ? UI.text('作業中・指示保留') : UI.text('停止保留') : UI.text('返事待ち')
    : t.resultsPending ? resultsNotice(p,t).label : kind === 'work' ? UI.text('作業中') : kind === 'done' ? UI.text('完了') : '';
  const badge = status ? UI.template`<span class="pill task-status ${kind === 'work' ? 'busy' : kind === 'done' ? 'confirm' : kind === 'results' ? 'results' : 'needs'}">${status}</span>` : '';
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const pending = CONFIRM(p, t) && tab !== 'reply';
  const action = tab === 'work' || kind === 'work' ? '' : t.resultsPending || t.chatQueueHeld ? completionButtons(p,t) : tab === 'reply' ? UI.template`<button class="btn sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button>`
    : pending ? pendingBar(p, t) : completionButtons(p, t);
  return UI.template`<div class="trow ${t.parent ? 'child' : ''} ${t.state === '完了' ? 'fin' : ''}">
    <div class="tt"><div class="task-title"><b>${esc(t.title)}</b>${futureHoldBadge(p,t)}${badge}</div>${sub}</div>
    <div class="tact">${action}<button class="btn plain sm" data-go="work" ${k} type="button">作業画面へ</button></div>
  </div>`;
}

function pendingBar(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  return UI.template`<button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>`;
}

// 一覧・ツリー・作業画面で、検査と整理の実稼働を同じ条件で示す。
function resultsNotice(p, t) {
  if (t.resultsPending.auto === 'running') return {label:UI.text('成果整理中'),text:UI.text('手順は済みです。AIが成果の記録を整えています'),active:true};
  if (t.resultsPending.code === 'checking') return {label:UI.text('成果確認中'),text:UI.text('成果を確認しています。確認が終わるまで完了には移せません'),active:true};
  if (WORKING(p,t)) return {label:UI.text('作業中'),text:UI.text('AIが作業中、または指示が順番待ちです。成果の確認は終了後に行います'),active:true};
  return {label:UI.text('成果確認'),text:UI.text('成果の記録に確認が必要です。成果整理は現在動いていません'),active:false};
}

function completionButtons(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  if (t.chatQueueHeld) return UI.html('<div class="wq">停止前の未処理の指示が保留中です。作業画面の待ち指示を確認してください。</div>');
  if (t.question && t.state !== '完了') return ''; // 質問がある間は、まず答える（完了の操作は出さない）
  if (t.resultsPending) {
    const notice = resultsNotice(p,t);
    return UI.template`<div class="wq"><span>${notice.text}</span>${t.resultsPending.reason ? UI.template`<div class="small">${esc(t.resultsPending.reason)}</div>` : ''}${t.resultsPending.detail && !notice.active ? UI.template`<div class="small">${esc(t.resultsPending.detail)}</div>` : ''}${notice.active ? '' : UI.template`<button class="btn sm" data-act="resultsorganize" ${k} type="button">成果の整理を頼む</button>`}</div>`;
  }
  if (t.completionPending) return UI.template`<div class="wq"><span>AI が手順をすべて済にしました。完了に移しますか？</span><button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>
    ${t.done ? UI.template`<div class="small done-note"><b>やったこと：</b>${linkify(t.done.length > 400 ? t.done.slice(0, 400) + '…' : t.done)}</div>` : ''}</div>`;
  return UI.template`<button class="btn plain sm" data-act="${t.state === '完了' ? 'taskcontinue' : 'taskcomplete'}" ${k} type="button">${t.state === '完了' ? UI.text('再開する') : UI.text('完了に移す')}</button>${t.state === '完了' ? UI.template`<button class="btn plain sm" data-act="tasktidy" ${k} type="button">片付け…</button>` : ''}`;
}

function phaseRoad(p, info) {
  if (!info.list.length) return '';
  const road = info.list.map((ph, i) => {
    const done = ph.state === '完了';
    return UI.template`<div class="step ${done ? 'done' : ''} ${i === info.cur && !done ? 'now' : ''}">
      ${done ? '<span class="stamp">COMPLETE</span>' : ''}
      <span class="no">フェーズ ${i + 1}</span><span class="nm">${esc(ph.name)}</span>
      <div class="pbar"><i style="width:${Math.round((done ? 1 : ph.ratio) * 100)}%"></i></div>
      <span class="st">${esc(ph.state === '完了' ? UI.text('完了') : ph.completionPending ? UI.text('完了報告あり・確認待ち') : i === info.cur ? UI.text('進行中') : UI.text('未着手'))}・作業 ${ph.tasks.filter(t => t.state === '完了').length} / ${ph.tasks.length}</span></div>`;
  }).join('');
  const c = info.list[info.cur];
  const continued = p.phaseContinueKey && p.phaseContinueKey === p.phaseOfferKey;
  const banner = c && (c.tasksDone && !continued || p.phases[info.cur]?.completionPending) ? UI.template`<div class="banner"><b>確認</b><span>「${esc(c.name)}」を完了に移しますか？</span><span class="sp"></span>
      <button class="btn" data-act="nextphase" data-p="${esc(p.id)}" type="button">${info.list[info.cur + 1] ? UI.template`次のフェーズ「${esc(info.list[info.cur + 1].name)}」へ進む` : UI.text('プロジェクトを完了にする')}</button><button class="btn plain" data-act="phasecontinue" data-p="${esc(p.id)}" type="button">まだ続ける</button></div>` : '';
  return UI.template`<div class="road">${road}</div>${banner}`;
}

function syncSpecialModeChange() {
  for (const [id, draft] of quickDrafts) {
    if (quickOverrides.has(id) || quickStarting.has(id) || draft.task || draft.request) continue;
    Object.assign(draft, defaultWorkPick('司令塔')); keepQuick(id);
  }
  const p = proj(view.project), t = taskOf(p, view.task);
  if (p && view.kind === 'project' && !quickStarting.has(p.id)) drawQuick(p);
  if (p && t) syncSpecialPick(p, t);
  drawSpecialMode();
}

function quickDraft(p) {
  if (!quickDrafts.has(p.id)) {
    let old; try { old = JSON.parse(localStorage.getItem('hub-start-' + p.id) || 'null'); } catch (e) { /* 初回 */ }
    const spec = p.startSpec || defaultWorkPick('司令塔');
    quickDrafts.set(p.id, { text: '', images: [], ...spec, ...old, ...(state.specialMode?.enabled ? defaultWorkPick('司令塔') : {}) });
  }
  return quickDrafts.get(p.id);
}

function keepQuick(pid) {
  try { localStorage.setItem('hub-start-' + pid, JSON.stringify(quickDrafts.get(pid))); }
  catch (e) { toast(UI.text('下書きを保存できません。保存領域を確認してください')); }
}

function quickOwners() {
  const agents = new Set(state.roles.agents || []);
  state.projects.forEach(p => p.tasks.forEach(t => { if (ownerOf(t.owner).kind === 'agent') agents.add(ownerOf(t.owner).name); }));
  return [...AIS.map(ai => ({ ai, name: AI_LABEL[ai] })), ...[...agents].map(a => ({ ai: 'discord:' + a, name: a + '（Discord）' }))];
}

function quickControls(p) {
  const d = quickDraft(p), busy = quickStarting.has(p.id), cli = AIS.includes(d.ai), models = shownModels(AI_KEY[d.ai], d.model);
  const missing = d.model && !models.includes(d.model);
  return UI.template`<button class="btn plain" id="quick-attach" ${busy ? 'disabled' : ''} type="button" aria-label="画像を選ぶ" title="画像を選ぶ">📎</button>
    <input type="file" id="quick-files" accept=".png,.jpg,.jpeg,.webp,.gif,.heic" multiple hidden>
    <select id="quick-ai" ${busy ? 'disabled' : ''} aria-label="始めるAI">${quickOwners().map(x => UI.template`<option value="${esc(x.ai)}" ${x.ai === d.ai ? 'selected' : ''} ${aiUnavailable(x.ai) ? 'disabled' : ''}>${esc(x.name)}</option>`).join('')}</select>
    ${cli ? UI.template`<select id="quick-model" aria-label="モデル" ${busy ? 'disabled' : ''}><option value="" ${d.model ? '' : 'selected'}>${d.ai === 'agy' ? UI.text('モデルを選んでください') : UI.text('モデル：役割どおり')}</option>${missing ? UI.template`<option selected disabled value="${esc(d.model)}">${esc(d.model)}（利用不可）</option>` : ''}${models.map(m => UI.template`<option value="${esc(m)}" ${m === d.model ? 'selected' : ''}>${esc(modelOptionLabel(d.ai,m))}</option>`).join('')}</select>
    <select id="quick-effort" aria-label="思考" ${effortHidden(d.ai) ? 'hidden' : ''} ${d.ai === 'agy' || busy ? 'disabled' : ''}><option value="">思考：役割どおり</option>${effortsFor(d.ai).map(e => UI.template`<option ${e === d.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>` : UI.html('<span class="small">Discordへの自動送信は未対応。依頼と画像の場所を保存します。</span>')}
    <span class="sp"></span><button class="btn" type="submit" ${quickUploading.has(p.id) || quickStarting.has(p.id) ? 'disabled' : ''}>${quickUploading.has(p.id) ? UI.text('画像を保存中…') : quickStarting.has(p.id) ? UI.text('始めています…') : UI.text('始める')}</button>`;
}

function drawQuick(p) {
  if (view.kind !== 'project' || view.project !== p.id) return;
  const thumbs = $('#quick-images'), controls = $('#quick-controls'), d = quickDraft(p);
  if (thumbs) thumbs.innerHTML = d.images.map((x, i) => UI.template`<span class="quick-image"><img src="${esc(globalThis.HubLocalAuth?.url(x.url) || x.url)}" alt="${esc(x.name)}"><button type="button" data-quick-remove="${i}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.name)}">${esc(x.name)}</small></span>`).join('');
  if (controls) controls.innerHTML = quickControls(p);
}

async function addQuickImages(p, files, native = false) {
  if (!p || quickUploading.has(p.id) || quickStarting.has(p.id)) { toast(UI.text('保存が終わってから画像を追加してください')); return; }
  const d = quickDraft(p);
  const images = files.filter(isQuickImage);
  if (d.images.length + images.length > 10) { toast(UI.text('画像は1回10枚までです。不要な画像を取り消してください')); return; }
  quickUploading.add(p.id); drawQuick(p);
  try {
    for (const f of images) {
      let r;
      if (native) r = await api('/api/start/image-path', { project: p.id, path: f });
      else {
        const name = f.name || UI.template`貼り付け画像-${Date.now()}.png`;
        const response = await fetch('/api/start/image?' + new URLSearchParams({ project: p.id, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: f });
        r = await response.json(); if (!response.ok) throw Error(r.error || UI.text('画像を保存できません'));
      }
      d.images.push(r); keepQuick(p.id); drawQuick(p);
    }
    if (images.length) toast(UI.template`画像を${images.length}枚追加しました`);
    return true;
  } catch (e) { toast(e.message); return false; }
  finally { quickUploading.delete(p.id); drawQuick(p); }
}

function projectNotesText(p){const hit=projectNotesCache.get(p.id),notes=hit&&hit.hash===p.notesHash?hit.notes:p.notesSummary||p.notes||'';return p.notesHash?[p.description,notes].filter(Boolean).join('\n\n'):(p.description||notes);}

async function loadProjectNotes(id){
  const p=proj(id);if(!p||projectNotesLoading.get(id)===p.notesHash)return;
  const hash=p.notesHash;projectNotesLoading.set(id,hash);
  try{
    let hit=projectNotesCache.get(id);
    if(!hit||hit.hash!==hash){hit=await api('/api/project/notes?project='+encodeURIComponent(id));if(proj(id)?.notesHash!==hash||hit.hash!==hash)return;projectNotesCache.set(id,hit);if(projectNotesCache.size>50)projectNotesCache.delete(projectNotesCache.keys().next().value);}
    const detail=document.querySelector('.project-notes');if(detail?.dataset.p===id){const text=detail.querySelector('.desc');if(text)text.textContent=projectNotesText(proj(id));}
  }catch(e){const detail=document.querySelector('.project-notes');if(detail?.dataset.p===id){const text=detail.querySelector('.desc');if(text)text.textContent=projectNotesText(p)+'\n'+UI.text('メモ全文を取得できません。開き直して確認してください');}}
  finally{if(projectNotesLoading.get(id)===hash)projectNotesLoading.delete(id);}
}

function renderOverview(p) {
  if(projectNotesOpen.has(p?.id))void loadProjectNotes(p.id);
  if (!p) return renderEmpty();
  if (p.kind === 'freetalk') { $('#main').innerHTML = UI.template`<div class="view freetalk-overview"><div class="ph"><h2>freetalk</h2><span class="small">話題${p.tasks.length}件</span><button class="btn" data-act="freetalknew" type="button" ${state.freetalk?.ready ? '' : 'disabled'}>新しい話題</button></div><p class="note">気軽に相談して、話題ごとに会話を続けられます。</p>${freetalkCleanupHtml()}${freetalkTopics(p)}</div>`; return; }
  const info = phaseInfo(p);
  const here = t => !info.list.length || info.cur < 0 || info.inPhase(t, info.cur);
  const active = p.tasks.filter(t => t.state !== '完了' && here(t));
  const others = p.tasks.filter(t => t.state !== '完了' && !here(t));
  const done = p.tasks.filter(t => t.state === '完了');
  const phaseOpts = p.phases.map((ph, i) => UI.template`<option ${i === info.cur ? 'selected' : ''}>${esc(ph.name)}</option>`).join('');
  const agentOpts = (state.roles.agents || []).map(a => UI.template`<option value="discord:${esc(a)}">${esc(a)}（Discord）</option>`).join('');
  const roleOpts = state.roles.roles.map(r => UI.template`<option value="${esc(r.name)}">${esc(UI.label(r.name))}</option>`).join('');
  const taskOpts = p.tasks.map(t => UI.template`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
  const description = projectNotesText(p);
  $('#main').innerHTML = UI.template`<div class="view">
    <div class="ph"><h2>${esc(p.name)}</h2>${p.id!=='freetalk'?UI.template`<button class="btn plain" type="button" data-idea-open="${esc(p.id)}">アイデア台帳</button>`:''}<span class="pill s-${esc(p.status)}">${esc(UI.label(p.status))}</span>
      <span class="small">最終更新 ${esc(p.updated || '—')}</span>
      ${p.copies ? copiesHtml(p) : ''}<span class="sp"></span>
      <button class="btn plain" data-act="split" data-p="${esc(p.id)}" type="button" title="やることを子プロジェクトに分けて、それぞれ同時に始めます">子プロジェクトに分ける</button>
      ${(p.parent || p.derivedFrom) ? UI.template`<button class="btn plain" data-act="handoff-parent" data-p="${esc(p.id)}" type="button" title="このプロジェクトの結果を、親の作業に書き込みます（親の AI が次に読みます）">親に結果を渡す</button>` : ''}
      <button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="${p.status === '完了' ? '進行中' : '完了'}" type="button">${p.status === '完了' ? UI.text('完了を取り消す') : UI.text('プロジェクトを完了にする')}</button>
      <button class="btn plain" data-maintenance="1" data-p="${esc(p.id)}" type="button">整理と確認</button>${githubUrl(p) ? UI.template`<button class="btn plain" data-url="${esc(githubUrl(p))}" type="button" title="GitHub で開く（${esc(githubUrl(p))}）">GitHub</button>` : ''}<span id="github-create-status">${githubCreateButton(p)}</span>${p.github?.target && p.github.target !== '.' ? UI.template`<span class="small">接続フォルダ：${esc(p.github.target)}</span>` : ''}<button class="btn plain" data-act="files" type="button">ファイルを見る</button></div>
    ${description ? UI.template`<details class="more project-notes" data-p="${esc(p.id)}" ${projectNotesOpen.has(p.id) ? 'open' : ''}><summary>説明・メモ</summary><p class="desc">${esc(description)}</p></details>` : ''}
    ${state.completionWarning ? UI.template`<p class="wq">${esc(state.completionWarning)}</p>` : ''}
    ${p.completionPending ? UI.template`<p class="wq">プロジェクトの完了報告があります。上の［完了にする］で確認するか、［まだ続ける］を選んでください。</p><button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="進行中" type="button">まだ続ける</button>` : ''}
    ${p.derivedFrom ? UI.template`<p class="small">派生元：${proj(p.derivedFrom) ? UI.template`<button class="lnk" data-go="project" data-p="${esc(p.derivedFrom)}" type="button">${esc(proj(p.derivedFrom).name)}</button>` : esc(p.derivedFrom)}</p>` : ''}
    ${phaseRoad(p, info)}
    <div class="card"><h3 class="sec">${info.curName ? UI.template`今のフェーズの作業（${esc(info.curName)}）` : UI.text('作業')}</h3>
      <form class="quick" id="quickform" data-p="${esc(p.id)}">
        <textarea name="text" rows="2" maxlength="4000" placeholder="やりたいことを書くだけで始められます（例：入退室の画面を作って）">${esc(quickDraft(p).text)}</textarea>
        <div class="quick-images" id="quick-images"></div>
        <div class="quick-controls" id="quick-controls">${quickControls(p)}</div>
        <p class="small">画像はここに落とす・⌘V・📎で追加（最大10枚）。入力内容はプロジェクトごとに保存します。</p>
      </form>
      ${active.length ? active.map(t => taskRow(p, t)).join('') : UI.html('<p class="note">進行中の作業はありません。</p>')}
      ${others.length ? UI.template`<details class="more"><summary>他のフェーズの作業（${others.length}）</summary>${others.map(t => taskRow(p, t)).join('')}</details>` : ''}
      ${done.length ? UI.template`<details class="more"><summary>完了した作業（${done.length}）</summary>${done.map(t => taskRow(p, t)).join('')}</details>` : ''}
      <details class="more"><summary>＋ 細かく決めて作業を足す</summary>
        <form class="newform" id="newform" style="margin-top:10px">
          <label>作業名<input name="title" required maxlength="80" placeholder="例：メモ一覧の文言を直す"></label>
          <label>作業の種類<select name="kind"><option value="main">本作業</option><option value="derived">派生</option></select></label>
          <label>派生元<select name="derivedFrom"><option value="">（派生の場合は選ぶ）</option>${sourceOptions(p)}</select></label>
          <label>作業する場所<select name="workspaceMode"><option value="isolated">作業用コピー（コードは後で本体へ取り込む）</option><option value="direct">本体で作業（合体不要・同時作業不可）</option></select></label>
          <label>ツリーの親作業<select name="parent"><option value="">（なし）</option>${taskOpts}</select></label>
          <label>役割<select name="role"><option value="">（なし）</option>${roleOpts}</select></label>
          ${phaseOpts ? UI.template`<label>フェーズ<select name="phase">${phaseOpts}</select></label>` : ''}
          <label>担当<select name="owner"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="agy">Agy CLI</option><option value="grok">Grok</option>${webchatUI()?UI.html('<option value="chatgpt">ChatGPT</option>'):''}${agentOpts}<option value="人">あなた</option></select></label>
          <label>どこで頼んだか（Discord の時。例：#サンプル作業）<input name="via" maxlength="80"></label>
          <label>手順（1行に1つ。3〜5個）<textarea name="steps" rows="4" maxlength="600" placeholder="題材を決める&#10;下書き&#10;チェック&#10;投稿"></textarea></label>
          <div><button class="btn" type="submit">作業を足す</button></div>
        </form></details>
    </div>
    ${projectFamily(p).length>1 ? UI.template`<details class="more"><summary>同じ大きなプロジェクトの作業</summary>${projectFamily(p).filter(q=>q.id!==p.id).map(q=>UI.template`<h3><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></h3>${q.tasks.map(t=>taskRow(q,t,true)).join('')}`).join('')}</details>` : ''}
    ${bgOf(p.id).length ? UI.template`<div class="wq bg-note"><b>裏で作業中：</b><span>${esc(bgText(bgOf(p.id)))}</span><span class="small">Hub を通さずに起動された AI（作業：${esc(bgOf(p.id).map(x => x.task ? (taskOf(p, x.task) || {}).title || x.task : UI.text('不明')).join(UI.text('・')))}）</span></div>` : ''}
    ${childrenOf(p).length ? UI.template`<div class="card"><h3 class="sec">子プロジェクト（${childrenOf(p).length}）${unfinishedChildren(p).length ? UI.template`<span class="small">・終わっていない ${unfinishedChildren(p).length} 件</span>` : UI.html('<span class="small">・すべて終わりました</span>')}</h3>
      ${orderedChildren(p).map(q => { const open = q.tasks.filter(t => t.state !== '完了'); const ask = q.tasks.find(t => t.question); return UI.template`<div class="trow"><div class="tt"><div class="task-title"><span class="sdot ${projectLight(q).cls}"></span><b><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></b></div><span>${q.status === '完了' ? '完了' : UI.template`${esc(UI.label(q.status))}・作業 ${q.tasks.length - open.length} / ${q.tasks.length}`}${ask ? UI.template`・<span class="q2">質問あり：${esc(ask.question.slice(0, 60))}</span>` : ''}</span></div><div class="tact"><button class="btn plain sm" data-go="project" data-p="${esc(q.id)}" type="button">開く</button></div></div>`; }).join('')}
      <p class="small">子が終わると、結果は親のいちばん新しい作業に書き込まれ、「新」が付きます。子が途中のまま親で作業を始めようとすると、知らせます。</p></div>` : ''}
    <div class="grid2">
      <div class="card issues-card"><h3 class="sec">問題点</h3>${issuesHtml(p.issues)}</div>
      <div class="card"><h3 class="sec">関連プロジェクト・参考（AI が読むだけ）</h3>${p.related.length || refsOf(p).length ? UI.template`<ul>${p.related.map(r => { const q = state.projects.find(x => x.name === r || x.id === r); return UI.template`<li>${q ? UI.template`<button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button>` : esc(r)}</li>`; }).join('')}${refsOf(p).map(f => UI.template`<li><span class="ref" title="${esc(f.path)}">${esc(f.path.split('/').filter(Boolean).pop() || f.path)}</span></li>`).join('')}</ul>` : UI.html('<p class="note">なし</p>')}
        <p class="small">参考にしたいフォルダは、この画面に落とすと足せます。</p></div>
      ${p.chats.length ? UI.template`<div class="card"><h3 class="sec">ブラウザのチャット</h3><ul>${p.chats.map(c => { const url = safeChatUrl(c.url); return UI.template`<li>${url ? UI.template`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a>` : esc(c.title || c.url || c)}</li>`; }).join('')}</ul></div>` : ''}
    </div></div>`;
  drawQuick(p);
}

function issuesHtml(issues = []) {
  if (!issues.length) return UI.html('<p class="note">なし</p>');
  const current = [], pending = [], history = [];
  for (const issue of issues) {
    if (!issue.summary) pending.push(issue);
    else if (['解決済み', '履歴'].includes(issue.summary.state)) history.push(issue);
    else current.push(issue);
  }
  const row = issue => {
    const text = typeof issue === 'string' ? issue : issue.text;
    const s = issue.summary;
    const heading = String(text).match(/^\s*(【[^】\r\n]+】)/)?.[1] || UI.text('見出しなし');
    return UI.template`<li class="issue-row"><div class="issue-heading">${issue.level ? UI.template`<span class="pill">${esc(issue.level)}</span>` : ''}${s ? UI.template`<span class="pill">${esc(UI.label(s.state))}</span>` : ''}<b class="issue-title${s ? '' : ' issue-unprepared'}">${esc(s ? s.title : heading)}</b></div>
      ${s ? (s.next ? UI.template`<p class="issue-next">次：${s.who === '人' ? UI.text('あなた：') : s.who === 'AI' ? 'AI：' : ''}${esc(s.next)}</p>` : '') : UI.html('<p class="small">まだ短くまとめていません</p>')}
      <details class="issue-detail"><summary>詳しく</summary><p class="issue-original">${esc(text)}</p></details></li>`;
  };
  const list = items => UI.template`<ul class="issue-list">${items.map(row).join('')}</ul>`;
  return UI.template`<section class="issue-group"><h4>今の問題</h4>${current.length ? list(current) : UI.html('<p class="note">今の問題はありません</p>')}</section>
    ${pending.length ? UI.template`<section class="issue-group"><h4>まだまとめていない（${pending.length}件）</h4>${list(pending)}<p class="small">要約がないか、原文との照合に合いません。このプロジェクトの作業の会話で「問題点を短くまとめて」と頼むと、AI が読んでまとめます。</p></section>` : ''}
    ${history.length ? UI.template`<details class="issue-history issue-group"><summary>解決済み・履歴（${history.length}件）</summary>${list(history)}</details>` : ''}`;
}

async function openFiles(btn) {
  const p = proj(view.project); if (!p) return;
  const t = view.kind === 'work' ? taskOf(p, view.task) : null;
  const list = [];
  if (t && t.workdir) list.push({ label: UI.text('作業の場所'), path: t.workdir, kind: 'workdir' });
  p.folders.forEach(f => list.push({ label: f.label, path: f.path, kind: 'folder' }));
  list.push({ label: UI.text('台帳（PROJECT.md・指示ファイル）'), path: p.dir, kind: 'project' });
  const go = async it => {
    try { await api('/api/open', { project: p.id, kind: it.kind, label: it.label, task: t && t.id }); toast(UI.template`${it.label}を開きました`); }
    catch (e) { toast(`${it.label}：${e.message}`); }
  };
  if (list.length === 1) return go(list[0]);
  const m = $('#menu');
  m.innerHTML = list.map((it, i) => UI.template`<button type="button" data-i="${i}">${esc(UI.label(it.label))}<span>${esc(it.path)}</span></button>`).join('');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; m.hidden = true; go(list[+b.dataset.i]); };
}

async function loadPreview(pid, tid) {
  const el = document.querySelector('[data-act="merge"]');
  if (!el) return;
  const request = ++mainPreviewRequest;
  try {
    const r = await api(`/api/task/preview?project=${encodeURIComponent(pid)}&task=${encodeURIComponent(tid)}`);
    if (request !== mainPreviewRequest || el !== document.querySelector('[data-act="merge"]') || view.kind !== 'work' || view.task !== tid || view.project !== pid) return;
    const pending=(state.taskIntegrations||[]).find(x=>x.project===pid&&x.task===tid)?.mainPending;
    const key=pid+'\0'+tid;
    if(pending&&r?.mainDisplay?.key===JSON.stringify(pending))integrationMainEvidence.set(key,{...r.mainDisplay,at:Date.now(),instance:state.hubInstance});
    else integrationMainEvidence.delete(key);
    refreshKidsDoneBar();
    if(!r)return;
    const exclude = document.querySelector('[data-act="mergeexclude"]');
    if (exclude) exclude.hidden = r.files === 0 && !r.conflict;
    if(typeof prepareOneclickMain==='function')await prepareOneclickMain(pid,tid,el);
  } catch (e) {
    if(request===mainPreviewRequest&&el===document.querySelector('[data-act="merge"]')&&view.kind==='work'&&view.project===pid&&view.task===tid){integrationMainEvidence.delete(pid+'\0'+tid);refreshKidsDoneBar();}
    if(request===mainPreviewRequest&&view.kind==='work'&&view.project===pid&&view.task===tid&&el===document.querySelector('[data-act="merge"]')&&typeof prepareOneclickMain==='function')await prepareOneclickMain(pid,tid,el);
  }
}

// Create the original callback at its original registration point in app.js.
function appProjectCallback891() {
  return (e => {
  const f = e.target.closest && e.target.closest('#quickform');
  if (f && e.target.name === 'text') { quickDraft(proj(f.dataset.p)).text = e.target.value; keepQuick(f.dataset.p); }
});
}

// Create the original callback at its original registration point in app.js.
function appProjectCallback895() {
  return (e => {
  const p = view.kind === 'project' && proj(view.project); if (!p) return;
  if (e.target.id === 'quick-attach') $('#quick-files').click();
  if (e.target.dataset && e.target.dataset.quickRemove !== undefined && !quickStarting.has(p.id)) { quickDraft(p).images.splice(+e.target.dataset.quickRemove, 1); keepQuick(p.id); drawQuick(p); }
});
}
