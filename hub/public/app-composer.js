'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function setChatDraft(key, text) {
  chatDraft[key] = text; chatDraftRevisions.set(key, (chatDraftRevisions.get(key) || 0) + 1);
}

function chatImages(project, task) {
  const key = chatAttachmentKey(project, task);
  if (!chatAttachments.has(key)) chatAttachments.set(key, []);
  return chatAttachments.get(key);
}

function attachmentImagesHtml(images) {
  return images.map(x => UI.template`<span class="quick-image">${x.kind === 'file' ? UI.html('<span class="quick-file" aria-hidden="true">📄</span>') : UI.template`<img src="${esc(globalThis.HubLocalAuth?.url(x.url) || x.url)}" alt="${esc(x.name)}" role="button" tabindex="0" data-image-open="${esc(x.id)}" aria-label="${esc(x.name)}を原寸で開く">`}<button type="button" data-chat-remove="${esc(x.id)}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.message || x.name)}">${esc(x.name)}${x.status && x.status !== 'ok' ? ' · ' + esc(UI.text(x.status === 'partial' ? '一部のみ' : '本文を参照できません')) : ''}</small>${x.message ? `<small>${esc(x.message)}</small>` : ''}</span>`).join('');
}

function chatImagesHtml(project, task) { return attachmentImagesHtml(chatImages(project, task)); }

function drawChatImages(project, task) {
  if (view.kind !== 'work' || view.project !== project || view.task !== task || workMode() !== 'chat') return;
  const box = $('#chat-images');
  if (box) { box.innerHTML = chatImagesHtml(project, task); box.hidden = !chatImages(project, task).length; }
  const status = $('#chat-image-state');
  if (status) status.hidden = !chatImageUploads.get(chatAttachmentKey(project, task));
  syncFreetalkAttachmentControls();
  window.HubMobile?.draft();
}

async function addChatImage(project, task, file, native = false) {
  if (project === 'freetalk') return addFreetalkAttachment(task,file,native);
  const key = chatAttachmentKey(project, task);
  chatImageUploads.set(key, (chatImageUploads.get(key) || 0) + 1);
  drawChatImages(project, task);
  try {
    let image;
    if (native) image = await api('/api/start/image-path', { project, path: file });
    else {
      const name = file.name || `screenshot-${Date.now()}.png`;
      const r = await fetch('/api/start/image?' + new URLSearchParams({ project, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: file });
      image = await r.json();
      if (!r.ok) throw Error(image.error || UI.text('画像を追加できませんでした'));
    }
    chatImages(project, task).push(image);
  } finally {
    chatImageUploads.set(key, chatImageUploads.get(key) - 1);
    drawChatImages(project, task);
  }
}

function attachmentGeneration(task) {
  return Math.max(globalThis.HubChatGenerations?.get('freetalk\0'+task) || 0,taskOf(proj('freetalk'),task)?.freetalkHistory?.generation || 0) || undefined;
}

function syncFreetalkAttachmentControls() {
  for(const el of document.querySelectorAll('[data-act^="freetalk"]')) {
    const action=el.dataset.act;
    if(!['freetalkclear','freetalkcontinue','freetalksummary','freetalkdelete','freetalkclean','freetalkautopromote','freetalkpromote','freetalkcreate','freetalkretry','freetalkresummary'].includes(action))continue;
    const task=el.dataset.t || view.task;
    const busy=action==='freetalkclean' ? [...chatImageUploads.entries()].some(([key,n])=>n && JSON.parse(key)[0]==='freetalk') : chatImageUploads.get(chatAttachmentKey('freetalk',task));
    if(busy && !el.dataset.attachmentBusy){el.dataset.attachmentBusy='1';el.dataset.attachmentDisabled=String(el.disabled);el.disabled=true;}
    else if(!busy && el.dataset.attachmentBusy){el.disabled=el.dataset.attachmentDisabled==='true';delete el.dataset.attachmentBusy;delete el.dataset.attachmentDisabled;}
  }
}

async function addFreetalkAttachment(task,file,native=false) {
  const project='freetalk',generation=attachmentGeneration(task),key=chatAttachmentKey(project,task);
  if(!generation)throw Error(UI.text('話題の状態を確認してください'));
  chatImageUploads.set(key,(chatImageUploads.get(key)||0)+1);drawChatImages(project,task);syncFreetalkAttachmentControls();
  try {
    let attachment;
    if(native){const r=await api('/api/task/attach',{project,task,paths:[file],generation});attachment=r.attachments[0];}
    else {
      const q=new URLSearchParams({project,task,name:file.name || `screenshot-${Date.now()}.png`,generation});
      const r=await fetch('/api/task/upload?'+q,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/octet-stream'},body:file});
      attachment=await r.json();if(!r.ok)throw Error(attachment.error || UI.text('渡せませんでした'));
    }
    if(generation!==attachment.generation || generation!==attachmentGeneration(task) || !taskOf(proj(project),task) || taskOf(proj(project),task).freetalkHistory?.migrated)return;
    chatImages(project,task).push(attachment);
  } finally {
    chatImageUploads.set(key,chatImageUploads.get(key)-1);drawChatImages(project,task);syncFreetalkAttachmentControls();
    if(view.kind==='work' && view.project===project && view.task===task){const p=proj(project),t=taskOf(p,task);if(t)await syncFreetalkHistory(p,t);}
  }
}

function removeChatImage(project, task, id) {
  const images = chatImages(project, task), i = images.findIndex(x => x.id === id);
  if (i >= 0) images.splice(i, 1);
  drawChatImages(project, task);
}

function chatSendText(text, images) {
  const files = images.some(x => x.kind === 'file');
  return images.length ? (text.trim() || UI.text(files ? '添付ファイルを確認してください。' : '添付画像を確認してください。')) + UI.text(files ? '\n\n参照ファイル・画像（絶対パス）：\n' : '\n\n参照画像（絶対パス）：\n') + images.map(x => (x.referencePaths || [x.path]).join('\n') + (x.message ? '\n' + x.message : '')).join('\n') : text.trim();
}

function clearSentChatImages(project, task, sent) {
  const ids = new Set(sent.map(x => x.id));
  chatAttachments.set(chatAttachmentKey(project, task), chatImages(project, task).filter(x => !ids.has(x.id)));
  drawChatImages(project, task);
}

function shortModelLabel(ai, model) {
  if (ai === 'muse') return 'Muse';
  if (ai === 'dot') return 'Dot';
  if (ai === 'chatgpt') return UI.text(model === 'auto' ? 'Chat／Pro' : '廃止された経路');
  if (ai === 'codex') return String(model).replace(/^GPT-/, '');
  if (ai === 'agy') return modelOptionLabel(ai, model);
  return String(model);
}

function phoneModelLabel(ai, model, full, suffix = '') {
  const phone = state.phoneLabels, key = `${AI_KEY[ai] || ai}|${model}`;
  return phone?.labels === 'full' ? full : (phone?.names?.[key] || shortModelLabel(ai, model)) + suffix;
}

function chatModelOption(ai, model, full, attrs = '', suffix = '') {
  if (ai === 'agy') full = full.replace(model, modelOptionLabel(ai,model));
  const short = phoneModelLabel(ai, model, full, suffix);
  return UI.template`<option value="${ai}|${esc(model)}" data-full="${esc(full)}" data-short="${esc(short)}" data-phone-suffix="${esc(suffix)}" ${attrs}>${esc(isPhone() ? short : full)}</option>`;
}

function syncChatPhoneLabels() {
  for (const option of ($('#chat-ai')?.options || [])) {
    if (option.dataset.full === undefined) continue;
    const [ai, model] = option.value.split('|');
    option.dataset.short = phoneModelLabel(ai, model, option.dataset.full, option.dataset.phoneSuffix || '');
    option.textContent = isPhone() ? option.dataset.short : option.dataset.full;
  }
}

function workMode() { if (proj(view.project)?.kind === 'freetalk') return 'chat'; try { return localStorage.getItem('hub-mode') === 'term' ? 'term' : 'chat'; } catch (e) { return 'chat'; } }

function setMode(m) { try { localStorage.setItem('hub-mode', m); } catch (e) { /* 無視 */ } render(); }

function orderedModels() { return ModelOrder.ordered(state.roles.models, state.modelOrder); }

function shownModels(key, ...keep) {
  const hidden = (state.hiddenModels || {})[key] || [];
  return orderedModels().filter(id => id.startsWith(key + '|')).map(id => id.slice(key.length + 1)).filter(m => (!hidden.includes(m) || keep.includes(m)) && (key !== 'agy' || !state.agyModels || state.agyModels.some(row => row.label === m)));
}

function roleModelOptions(ai, selected) {
  const models = shownModels(ai, selected);
  const saved = selected && !models.includes(selected) ? UI.template`<option selected disabled value="${esc(selected)}">${esc(modelOptionLabel(ai,selected))}（利用不可）</option>` : ai === 'agy' && !selected ? UI.html('<option selected disabled value="">モデルを選んでください</option>') : '';
  return saved + models.map(m => UI.template`<option ${ai === 'agy' ? UI.template`value="${esc(m)}" ` : ''}${m === selected ? 'selected' : ''}>${esc(modelOptionLabel(ai,m))}</option>`).join('');
}

function chatSelection(p, t) {
  const saved = chatPick(p, t);
  const pick = { ...(saved.ai === 'muse' && state.museSupported === false ? defaultWorkPick(t.role) : saved) };
  if (!['chatgpt', 'dot', 'muse'].includes(pick.ai) && pick.model && !(state.roles.models[AI_KEY[pick.ai]] || []).includes(pick.model)) { // 作業ファイルに本当の名前で書かれていた時
    const hit = Object.entries((state.cliFlags || {})[pick.ai] || {}).find(([, id]) => id === pick.model);
    if (hit) pick.model = hit[0];
  }
  return pick;
}

function discussionUI() {
  if (!window.HubPaidDiscussion || state.extensions && !state.extensions.included.includes('discussion')) return null;
  return discussionUIInstance ||= window.HubPaidDiscussion.create(Object.freeze({
    UI, $, esc, AI_LABEL, api:(...args)=>api(...args), toast, chatImages, chatAttachmentKey, chatDraftRevisions, setChatDraft,
    get state() { return state; }, get chatDraft() { return chatDraft; },
  }));
}

function bindDiscussion(p,t) { return discussionUI()?.bind(p,t) || (()=>{}); }

function chatModelChoices(p, t, selected) {
  const pick = selected || chatSelection(p, t);
  // 名前が未設定のモデルは、CLI の既定のモデルで動く（設定画面で名前を入れられる）
  const flag = (a, m) => ((state.cliFlags || {})[a] || {})[m];
  const available = pick.ai === 'muse' ? pick.model === 'direct' : pick.ai === 'chatgpt' ? (pick.model === 'auto' && webchatReady(t)) : shownModels(AI_KEY[pick.ai],pick.model).includes(pick.model);
  const unavailable = UI.text(pick.ai === 'chatgpt' && ['chat','app'].includes(pick.model) ? '（廃止された経路です。選び直してください）' : '（利用不可。選び直してください）');
  const old = pick.ai === 'agy' && !pick.model ? chatModelOption('agy', '', UI.text('Agy のモデルを選んでください'), 'selected disabled') : pick.model && !available && !(pick.ai === 'chatgpt' && pick.model === 'auto') ? chatModelOption(pick.ai, pick.model, UI.template`${AI_LABEL[pick.ai]}・${pick.model}${unavailable}`, 'selected disabled', unavailable) : '';
  const autoOpt = webchatUI()?.option(t,pick) || '';
  const gptOpt = autoOpt;
  return old + orderedModels().filter(id => { const [key, m] = id.split('|'); const a = key === 'claude-code' ? 'claude' : key; return shownModels(key, pick.ai === a ? pick.model : '').includes(m); }).map(id => {
    const [key, m] = id.split('|'), a = key === 'claude-code' ? 'claude' : key;
    const suffix = flag(a, m) === '' ? UI.text('（既定）') : '';
    return chatModelOption(a, m, UI.template`${AI_LABEL[a]}・${m}${suffix}`, `${aiUnavailable(a) ? 'disabled' : ''} ${pick.ai === a && pick.model === m ? 'selected' : ''}`, suffix);
  }).join('') + gptOpt + (state.museSupported !== false ? chatModelOption('muse','direct',UI.text('Muse（外部）'),pick.ai === 'muse' ? 'selected' : '') : '');
}

function syncChatModelChoices() {
  if (view.kind !== 'work') return;
  const p = proj(view.project), t = taskOf(p, view.task), select = $('#chat-ai');
  if (p && t && select) { select.innerHTML = chatModelChoices(p,t); const pick = chatSelection(p,t); select.value = pick.ai + '|' + pick.model; }
}

function chatHtml(p, t) {
  const pick = chatSelection(p, t), opts = chatModelChoices(p,t);
  const bodyNotice=(state.bodyNotices||[]).filter(x=>x.scope===p.id+' / '+t.id||x.scope==='本文整理').map(x=>UI.template`<p class="small danger" role="status">${esc(x.message)}</p>`).join('');
  return UI.template`<div class="chat" data-p="${esc(p.id)}" data-t="${esc(t.id)}">${!t.freetalk?UI.template`<div class="task-history-toolbar"><button class="btn plain sm" type="button" data-task-history="continue" data-p="${esc(p.id)}" data-t="${esc(t.id)}">要約して続ける</button><span class="history-progress small" id="history-progress" role="status" data-p="${esc(p.id)}" data-t="${esc(t.id)}" hidden></span><button class="btn plain sm" type="button" data-task-history="archives" data-p="${esc(p.id)}" data-t="${esc(t.id)}">過去の会話</button></div>`:''}
    ${bodyNotice}${state.extensions?.notice ? UI.template`<p class="small danger" role="status">${esc(state.extensions.notice)}</p>` : ''}<div id="webchat-notice">${webchatNoticeHtml(t,pick.ai==='chatgpt' && pick.model==='auto')}</div><div id="webchat-progress">${webchatProgress(p,t)}</div>${discussionUI()?.progressHtml() || ''}<div class="msgs" id="msgs"><p class="chat-loading small" role="status">会話を読み込んでいます…</p></div>
    <button class="chat-latest btn plain sm" id="chat-latest" type="button" hidden>↓ 最新へ</button>
    <div id="muse-reply-status" class="small" role="status" hidden></div>
    <form class="composer" id="composer">
      <div class="queue" id="chat-queue" hidden></div>
      <div class="quick-images" id="chat-images" aria-label="添付ファイル・画像" ${chatImages(p.id, t.id).length ? '' : 'hidden'}>${chatImagesHtml(p.id, t.id)}</div>
      <span class="small" id="chat-image-state" role="status" ${chatImageUploads.get(chatAttachmentKey(p.id, t.id)) ? '' : 'hidden'}>添付ファイルを追加中…</span>
      <p class="small muse-send-scope" id="muse-send-scope" role="status" ${pick.ai === 'muse' ? '' : 'hidden'}>送信先：Muse（外部）。今回の質問と選択した文字資料だけを送ります。追問は同じMuse相談の続きです。他AIとの会話は送りません。</p>
      <textarea id="chat-in" rows="3" maxlength="100000" placeholder="依頼を書く（例：このスクショの崩れを直して）" aria-label="依頼" aria-describedby="chat-history-help" title="↑ 前の指示（3件まで）・↓ 入力中の文章へ戻る">${esc(chatDraft[chatAttachmentKey(p.id, t.id)] || '')}</textarea>
      <span class="sr-only" id="chat-history-help">↑ 前の指示（3件まで）・↓ 入力中の文章へ戻る</span>
      <span class="small" id="chat-send-status" role="status" hidden></span>
      <div class="crow composer-controls">
        <button class="btn plain" id="chat-attach" type="button" aria-label="ファイルを追加" title="ファイルを追加">＋</button>
        <input type="file" id="chat-files" ${p.id === 'freetalk' ? 'accept="' + FREETALK_ACCEPT + '"' : ''} multiple hidden>
        <select id="chat-ai" aria-label="答える AI とモデル">${opts}</select>
        <select id="chat-effort" aria-label="思考" ${effortHidden(pick.ai) ? 'hidden' : ''} ${['agy','chatgpt','dot','muse'].includes(pick.ai) ? 'disabled' : ''}>${effortsFor(pick.ai).map(e => UI.template`<option ${(pick.ai === 'agy' ? '高' : pick.effort) === e ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>
        <span class="small" id="chat-state"></span><span class="sp"></span>
        <div class="composer-settings">
        <span id="chat-account-box">${['claude','codex','grok'].includes(pick.ai) ? taskAccountSelect(p,t,pick.ai,true) : ''}</span>
        <span id="chat-fast-box">${taskFastSelect(p,t,pick.ai)}</span>
        ${discussionUI()?.buttonHtml() || ''}</div><span class="voice-actions" id="chat-send-actions"><button id="chat-send" type="submit" class="btn ${pick.ai === 'muse' ? 'muse-send' : ''}">${esc(UI.text(pick.ai === 'muse' ? 'Museへ送る（外部）' : '送る'))}</button></span>
      </div>
      ${discussionUI()?.settingsHtml() || ''}<div class="crow busyrow" id="chat-busyrow" hidden>
        <button class="btn plain" id="chat-stop" type="button" title="今の作業を止めます（待っている指示も取り消します）">停止</button>
        <button class="btn warn" id="chat-redo" type="button" hidden title="今の指示が間違いだった時。今の指示を取り消し、この指示でやり直します">やり直し</button>
        <button class="btn" id="chat-amend" type="button" hidden title="今の指示に足りない所がある時。今の指示は続け、この指示も合わせて行います">追加指示</button>
        <button class="btn plain" id="chat-q" type="button" hidden title="別の作業を順番待ちにします。今の作業が終わったら自動で始めます（⌘ + Enter）">次の作業</button>
      </div>
    </form>
    </div>`;
}

function chatPick(p, t) {
  if (state.specialMode?.enabled) return specialOverrides.get(p.id + '/' + t.id) || defaultWorkPick(t.role);
  try { const v = JSON.parse(localStorage.getItem('hub-chat-' + p.id + '/' + t.id) || 'null'); if (v && v.ai) return v; } catch (e) { /* 無視 */ }
  if (t.gptChild) return { ai: 'chatgpt', model: 'auto', effort: '' };
  if (ownerOf(t.owner).kind === 'dot') return { ai: 'dot', model: 'inbox', effort: '' };
  if (ownerOf(t.owner).kind === 'chatgpt') return { ai: 'chatgpt', model: 'auto', effort: '' };
  const ai = aiOf(t.owner), sp = specOf(t, ai);
  return { ai, model: sp.model || (ai === 'agy' ? '' : (state.roles.models[AI_KEY[ai]] || [])[0]), effort: sp.effort || '高' };
}

function syncSpecialPick(p, t) {
  if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id) return;
  const select = $('#chat-ai'), effort = $('#chat-effort');
  if (!select || !effort) return;
  const pick = chatSelection(p, t);
  select.innerHTML = chatModelChoices(p,t);
  select.value = pick.ai + '|' + pick.model;
  effort.hidden = effortHidden(pick.ai); effort.disabled = ['agy', 'chatgpt', 'dot', 'muse'].includes(pick.ai); effort.innerHTML = effortsFor(pick.ai).map(e => UI.template`<option ${e === pick.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join(''); effort.value = pick.effort;
  drawChatAccount(p, t);
}
