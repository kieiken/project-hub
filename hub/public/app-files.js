'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function finishFileViewer() {
  if (!fileViewer) return;
  const old = fileViewer; fileViewer = null;
  clearTimeout(old.focusTimer);
  old.viewportCleanup?.();
  old.abort.abort(); old.el.remove();
  for (const [el, inert] of old.inert) el.inert = inert;
  Object.assign(document.body.style, old.style);
  window.scrollTo(old.x, old.y);
  const target = old.selection?.[0]?.isConnected ? old.selection[0] : old.trigger;
  if (target?.isConnected) target.focus({ preventScroll: true });
  if (old.selection?.[0]?.isConnected) { const [input, start, end, top] = old.selection; input.setSelectionRange(start, end); input.scrollTop = top; }
  old.restore?.();
}

function closeFileViewer() {
  if (!fileViewer) return;
  const old = fileViewer, restore = old.history && history.state?.fviewer === old.id;
  // iframeの遷移や遅いpopstateに左右されず、その場で会話に戻す。
  finishFileViewer();
  if (restore) {
    // 閉じた履歴は次に開く時に再利用し、開閉だけで履歴を増やさない。
    try { history.replaceState({ ...old.historyState, fviewerClosed: { state: old.historyState } }, ''); } catch { /* 履歴が使えなくても画面は解除済み */ }
  }
}

function prepareFileViewerFrame(frame, current) {
  frame.tabIndex = -1;
  let loaded = false;
  frame.addEventListener('load', () => {
    if (!loaded) { loaded = true; return; }
    if (fileViewer !== current || !current.history || history.state?.fviewer !== current.id) return;
    // 文書内の遷移後は親にも印を置き、戻る操作で閲覧画面を閉じられるようにする。
    const id = current.id + '-frame';
    try { history.pushState({ ...history.state, fviewer: id }, ''); current.id = id; } catch { /* 閉じるは履歴に依存しない */ }
  });
}

function prepareFileViewerControls(el, current) {
  for (const button of el.querySelectorAll('[data-fv-close]')) button.addEventListener('click', closeFileViewer);
  const viewport = window.visualViewport;
  if (!viewport) return;
  const controls = el.querySelector('.fv-mobile-controls');
  // ピンチ拡大・移動中も、閉じる操作だけを実際に見える画面の下端へ置く。
  // 画像そのものの拡大は保ち、ボタンは指で押せる大きさを保つ。
  const place = () => {
    const scale = viewport.scale || 1;
    Object.assign(controls.style, { top: '0', bottom: 'auto', right: 'auto', width: viewport.width * scale + 'px',
      transform: `translate(${viewport.offsetLeft}px, ${viewport.offsetTop + viewport.height}px) scale(${1 / scale}) translateY(-100%)` });
  };
  viewport.addEventListener('resize', place);
  viewport.addEventListener('scroll', place);
  current.viewportCleanup = () => {
    viewport.removeEventListener('resize', place);
    viewport.removeEventListener('scroll', place);
  };
  place();
}

async function showFileViewer(p, kind, trigger, attachment) {
  if (fileViewer) return;
  const el = document.createElement('div'), name = p.split('/').pop();
  el.id = 'fviewer'; el.className = 'fviewer' + (attachment ? ' fv-attachment' : ''); el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'fv-name');
  el.innerHTML = UI.template`<div class="fv-bar"><b id="fv-name">${esc(name)}</b><button type="button" class="btn fv-close" data-fv-close>閉じる</button></div><div class="fv-body" aria-busy="true"><p class="note">読み込み中…</p></div><div class="fv-mobile-controls"><button type="button" class="btn fv-close" data-fv-close>閉じる</button></div>`;
  if (attachment) {
    el.querySelector('.fv-bar [data-fv-close]').remove();
    const controls = el.querySelector('.fv-mobile-controls');
    controls.innerHTML = UI.html('<button type="button" class="btn fv-close" data-fv-close>閉じる</button><button type="button" class="btn fv-close" data-fv-delete>削除</button>');
    controls.querySelector('[data-fv-delete]').addEventListener('click', () => { closeFileViewer(); attachment.remove(); });
  }
  const style = {}, keys = ['position', 'top', 'left', 'width', 'overflow'];
  for (const key of keys) style[key] = document.body.style[key];
  const active = document.activeElement, selection = active && typeof active.selectionStart === 'number' ? [active, active.selectionStart, active.selectionEnd, active.scrollTop] : null;
  const current = fileViewer = { el, trigger, selection, restore: attachment?.restore, style, x: window.scrollX, y: window.scrollY, id: Date.now() + '-' + Math.random(), abort: new AbortController(), inert: [] };
  document.body.appendChild(el);
  for (const child of document.body.children) if (child !== el) { current.inert.push([child, child.inert]); child.inert = true; }
  Object.assign(document.body.style, { position: 'fixed', top: -current.y + 'px', left: -current.x + 'px', width: '100%', overflow: 'hidden' });
  const slot = history.state?.fviewerClosed;
  current.historyState = slot ? slot.state : history.state;
  try {
    const state = { ...current.historyState, fviewer: current.id };
    if (slot) history.replaceState(state, ''); else history.pushState(state, '');
    current.history = true;
  } catch { /* 履歴が使えなくても閉じるボタンを使える */ }
  prepareFileViewerControls(el, current);
  el.querySelector('[data-fv-close]').focus({ preventScroll: true });
  const body = el.querySelector('.fv-body'), url = globalThis.HubLocalAuth?.url(attachment?.url || fileViewUrl(p)) || attachment?.url || fileViewUrl(p);
  const fail = () => { if (fileViewer === current) { body.innerHTML = UI.template`<p class="note fv-error" role="alert">このファイルを表示できません。Macで開いてください。</p>`; body.setAttribute('aria-busy', 'false'); } };
  try {
    if (kind === 'text' || kind === 'doc') {
      const response = await fetch(url + (kind === 'doc' ? '&as=html' : ''), { signal: current.abort.signal });
      if (!response.ok) throw Error('view failed');
      const text = await response.text();
      if (fileViewer !== current) return;
      if (kind === 'doc') {
        const frame = document.createElement('iframe'); frame.className = 'fv-frame'; frame.title = name;
        prepareFileViewerFrame(frame, current);
        frame.setAttribute('sandbox', '');
        // 一度だけ変換し、エラーは親で表示。srcdocにも外部読込禁止を適用する。
        frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">' + text;
        body.replaceChildren(frame);
      } else body.innerHTML = /\.md$/i.test(p) ? `<div class="fv-text mb">${richText(text)}</div>` : `<pre class="fv-text">${esc(text)}</pre>`;
    } else if (kind === 'image') {
      const img = document.createElement('img'); img.className = 'fv-image'; img.alt = name;
      img.onerror = fail; img.onload = () => body.setAttribute('aria-busy', 'false');
      img.src = url; body.replaceChildren(img);
    } else {
      // Range確認でHTTPエラーを親に表示し、本文は端末のPDF表示に任せる。
      const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: current.abort.signal });
      if (!response.ok) throw Error('view failed');
      await response.body?.cancel();
      if (fileViewer !== current) return;
      const frame = document.createElement('iframe'); frame.className = 'fv-frame'; frame.title = name;
      prepareFileViewerFrame(frame, current);
      frame.onerror = fail; frame.src = url; body.replaceChildren(frame);
    }
    body.setAttribute('aria-busy', 'false');
  } catch (e) { if (e.name !== 'AbortError') fail(); }
}

async function openPath(p, how) {
  try {
    const r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how });
    if (r.byApp) location.href = `hubapp://reveal?dir=${r.dir ? 1 : 0}&open=${r.how === 'open' ? 1 : 0}&path=${encodeURIComponent(r.path)}`;
    toast(`${r.how === 'open' ? UI.text('開きました') : UI.text('Finder で開きました')}：${r.path.split('/').pop()}`);
  } catch (err) { toast(err.message); }
}

async function showPath(p, how = 'info') {
  let r;
  try { r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how }); }
  catch (err) { toast(err.message); return; }
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  const head = UI.template`<div class="fs-head"><b>${r.dir ? '📁' : '📄'} ${esc(r.path.split('/').pop())}</b><span class="small fs-path">${esc(r.path)}</span></div>`;
  if (!r.entries) {
    const imageUrl = fileViewUrl(r.path), kind = r.viewKind || (r.view ? 'image' : '');
    const viewNote = kind === 'image' ? UI.text('この画面で画像を見られます。') : UI.text('この画面でファイルを見られます。');
    const note = r.remote ? !r.view && !r.dir ? UI.text('この形式はスマホでは開けません。Macで開いてください。') : UI.text('Macの画面で開く操作は、このMacの前でだけ使えます。') : r.view ? UI.text('Macで開く時は［元のファイルを開く］。') : r.dir ? UI.text('フォルダの開き方を選んでください。') : UI.text('コピーを作らず、元のファイルを既定のアプリで開けます。');
    const mac = r.remote ? '' : r.dir ? UI.template`<button type="button" class="btn" data-fs-finder="${esc(r.path)}">Finderで開く</button>` : UI.template`<button type="button" class="btn${r.view ? ' plain' : ''}" data-fs-open="${esc(r.path)}">元のファイルを開く</button><button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finderで表示</button>`;
    el.innerHTML = UI.template`<div class="fs-box">${head}<div class="fs-list">${kind === 'image' ? `<img class="fs-img" src="${esc(imageUrl)}" alt="${esc(r.path.split('/').pop())}" loading="lazy">` : ''}<p class="note">${r.view ? viewNote + ' ' : ''}${note}</p>${kind === 'doc' ? UI.html('<p class="note">文書の画像や複雑な表は表示が崩れる場合があります。</p>') : ''}</div>
      <div class="acts fs-acts">${r.view ? `<button type="button" class="btn" data-fs-view="${esc(r.path)}" data-view-kind="${esc(kind)}">${kind === 'image' ? UI.text('画像を見る') : UI.text('開く')}</button>` : ''}${mac}${r.dir ? UI.template`<button type="button" class="btn plain" data-fs-list="${esc(r.path)}">中身を見る</button>` : ''}
      <button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn plain" data-fs-close>閉じる</button></div></div>`;
    return;
  }
  el.innerHTML = UI.template`<div class="fs-box">${head}
    <div class="fs-list">${r.parent ? UI.template`<button type="button" class="fs-row" data-fs-list="${esc(r.parent)}">↩︎ 上のフォルダへ</button>` : ''}
    ${r.entries.length ? r.entries.map(x => UI.template`<button type="button" class="fs-row" ${x.dir ? `data-fs-dir="${esc(x.path)}"` : `data-fs-file="${esc(x.path)}"`}><span>${x.dir ? '📁' : '📄'} ${esc(x.name)}</span><span class="small">${x.dir ? '' : fsize(x.size)}</span></button>`).join('') : UI.html('<p class="note">空のフォルダです</p>')}</div>
    <div class="acts fs-acts">${r.remote ? '' : UI.template`<button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finder で開く</button>`}<button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn" data-fs-close>閉じる</button></div></div>`;
}

// Some drag sources expose their image as an item instead of FileList.
function droppedFiles(transfer) {
  const files = Array.from(transfer?.files || []);
  if (files.length) return files;
  return Array.from(transfer?.items || []).filter(x => x.kind === 'file').map(x => x.getAsFile?.()).filter(Boolean);
}

// Bind a delayed macOS file promise to the original screen, not the screen open
// when its producer eventually finishes writing the screenshot.
function beginNativeDrop() {
  if (fileViewer || document.querySelectorAll('dialog[open]').length || !['work','project','newproject'].includes(view.kind)) return null;
  const anchor = $('#main')?.firstElementChild;
  if (!anchor) return null;
  const ticket = String(++nativeDropSequence);
  nativeDropTickets.set(ticket, {kind:view.kind,project:view.project,task:view.task,anchor,
    generation:view.project === 'freetalk' ? attachmentGeneration(view.task) : globalThis.HubChatGenerations?.get(view.project+'\0'+view.task)});
  while (nativeDropTickets.size > 20) nativeDropTickets.delete(nativeDropTickets.keys().next().value);
  return ticket;
}

function currentNativeDropTarget(target) {
  return Boolean(target && target.kind === view.kind && target.project === view.project && target.task === view.task
    && target.anchor === $('#main')?.firstElementChild && target.anchor.isConnected !== false
    && target.generation === (view.project === 'freetalk' ? attachmentGeneration(view.task) : globalThis.HubChatGenerations?.get(view.project+'\0'+view.task))
    && !fileViewer && !document.querySelectorAll('dialog[open]').length);
}

function consumeNativeDrop(ticket) {
  const target = nativeDropTickets.get(ticket); nativeDropTickets.delete(ticket);
  return currentNativeDropTarget(target);
}

function failNativeDrop(ticket, reason) {
  if (!consumeNativeDrop(ticket)) return;
  const messages = {
    promise: 'Macから画像ファイルを受け取れませんでした。保存した画像を選ぶか、貼り付けてください',
    'promise-count': 'Macから画像の件数を確認できませんでした。保存した画像を選ぶか、貼り付けてください',
    timeout: 'Macから画像を受け取るまでに時間がかかりすぎました。保存した画像を選ぶか、貼り付けてください',
    'temporary-directory': '画像の一時保存先を用意できませんでした。保存した画像を選んでください',
    'file-location': 'Macから受け取った画像の保存先や形式を確認できませんでした。保存した画像を選んでください',
    'file-url': '落としたファイルを読み取れませんでした。保存先を確認して選び直してください',
    'image-data': 'Macから受け取った画像データを読み取れませんでした。保存した画像を選ぶか、貼り付けてください',
  };
  toast(UI.text(messages[reason] || '画像を受け取れませんでした。保存した画像を選ぶか、貼り付けてください'));
}

function dropTarget(el) {
  if (el && el.closest && el.closest('.chat')) return '';
  const pane = el && el.closest && el.closest('.pane[data-ai]');
  if (pane) return pane.dataset.ai;
  const run = AIS.filter(a => document.getElementById('pane-' + a));
  return run.length === 1 ? run[0] : '';
}

async function sendFiles(files, ai) {
  if (view.kind !== 'work' || !files.length) return;
  const project = view.project, task = view.task;
  const topicGeneration=project==='freetalk'?attachmentGeneration(task):undefined;
  const ta = $('#chat-in');
  if (ta) ai = ''; // 会話画面では、場所を依頼の欄に入れる
  const got = [];
  for (const f of files) {
    if(project==='freetalk' && attachmentGeneration(task)!==topicGeneration)break;
    if (ta && (project === 'freetalk' || isQuickImage(f))) {
      try { await addChatImage(project, task, f); }
      catch (e) { toast(`${f.name || UI.text('画像')}：${e.message}`); }
      continue;
    }
    const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const q = new URLSearchParams({ project, task, ai, name });
    const generation=globalThis.HubChatGenerations?.get(project+'\0'+task);if(generation)q.set('generation',generation);
    try {
      const r = await fetch('/api/task/upload?' + q, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || UI.text('渡せませんでした'));
      got.push(j);
    } catch (e) { toast(`${f.name || UI.text('ファイル')}：${e.message}`); }
  }
  if (ta) {
    if (got.length) appendChatPaths(project, task, got.map(x => x.path));
    return;
  }
  if (!got.length) return;
  const typed = got.some(x => x.typed);
  toast(typed ? UI.template`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : UI.template`ファイルを保存し、作業ファイルに記録しました（${got.length}件）。AI を始めると読めます`);
  if (typed && panes[ai]) panes[ai].xterm.focus();
}

function appendChatPaths(project, task, paths) {
  for (const path of paths) chatImages(project, task).push({ id: 'file:' + (++chatFileSequence) + ':' + path, kind: 'file', path, name: path.split(/[\\/]/).pop() });
  drawChatImages(project, task);
  toast(UI.text('ファイルを添付しました。続けて指示を書いて送ってください'));
}

function showDrop(ai) {
  document.querySelectorAll('.pane, .chat').forEach(p => p.classList.toggle('dropping', p.dataset.ai ? p.dataset.ai === ai : !ai));
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => document.querySelectorAll('.dropping').forEach(p => p.classList.remove('dropping')), 250);
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback1658() {
  return (async e => {
  const el = e.target.closest && e.target.closest('[data-url],[data-path],[data-copy]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.copy) {
    const ok = await copyText(el.dataset.copy);

  }
  else if (el.dataset.url) api('/api/open-url', { url: el.dataset.url }).catch(err => toast(err.message));
  else showPath(el.dataset.path);
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback1845() {
  return (async e => {
  const t = e.target.closest && e.target.closest('[data-fs-dir],[data-fs-file],[data-fs-open],[data-fs-list],[data-fs-finder],[data-fs-copy],[data-fs-close],[data-fs-view],.fsheet');
  if (!t) return;
  const d = t.dataset;
  if (d.fsView) await showFileViewer(d.fsView, d.viewKind, t);
  else if (d.fsDir || d.fsFile) await showPath(d.fsDir || d.fsFile);
  else if (d.fsList) await showPath(d.fsList, 'list');
  else if (d.fsOpen || d.fsFinder) await openPath(d.fsOpen || d.fsFinder, d.fsOpen ? 'open' : 'finder');
  else if (d.fsCopy) copyText(d.fsCopy);
  else if (d.fsClose !== undefined || t.classList.contains('fsheet') && e.target === t) $('#fsheet').hidden = true;
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback4244() {
  return (async (paths, ticket, options) => {
  if (ticket !== undefined && !consumeNativeDrop(ticket)) return false;
  if (document.querySelectorAll('dialog[open]').length) return false;
  if (!Array.isArray(paths) || !paths.length) return;
  // Promised files disappear after this callback. Only consumers which copy
  // their contents now may receive them; never store their temporary paths.
  if (options?.temporary === true) {
    const copiesNow = view.kind === 'project' && view.project && paths.every(isQuickImage)
      || view.kind === 'work' && $('#chat-in') && (view.project === 'freetalk' || paths.every(isQuickImage));
    if (!copiesNow) {
      toast(UI.text('一時ファイルはここでは使えません。保存したファイルを選ぶか、画像を会話画面に落としてください'));
      return false;
    }
  }
  if (view.kind === 'newproject') {
    // 参考の欄に落とした時は参考に。本体の欄（や本体が空の時）は1つ目を本体に、残りは参考に
    if (lastDropZone === 'refs') { addNewRefs(paths); toast(UI.template`参考に ${paths.length} 件足しました`); return; }
    const body = $('#np-body');
    if (lastDropZone === 'body' || (body && !body.value.trim())) { setBodyFolder(paths[0]); if (paths.length > 1) addNewRefs(paths.slice(1)); return; }
    addNewRefs(paths); toast(UI.template`参考に ${paths.length} 件足しました`); return;
  }
  if (view.kind === 'project' && view.project) {
    const images = paths.filter(isQuickImage), other = paths.filter(x => !isQuickImage(x));
    if (images.length) await addQuickImages(proj(view.project), images, true);
    if (!other.length) return;
    paths = other;
    try { const r = await api('/api/project/refs', { project: view.project, paths }); toast(r.added ? UI.template`参考に ${r.added} 件足しました（AI は読むだけ）` : UI.text('もう入っています')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (view.kind !== 'work') { toast(UI.text('ファイルは作業画面に落としてください')); return; }
  const ta = $('#chat-in');
  if (ta) {
    const project = view.project, task = view.task;
    const topicGeneration=project==='freetalk'?attachmentGeneration(task):undefined;
    const other = [];
    for (const file of paths) {
      if(project==='freetalk' && attachmentGeneration(task)!==topicGeneration)break;
      if (project === 'freetalk' || isQuickImage(file)) {
        try { await addChatImage(project, task, file, true); }
        catch (e) { toast(`${file.split('/').pop()}：${e.message}`); }
      } else other.push(file);
    }
    if (other.length) {
      try {
        const r = await api('/api/task/attach', { project, task, paths: other });
        appendChatPaths(project, task, r.paths);
      } catch (e) { toast(e.message); }
    }
    return;
  }
  const ai = lastDropAi;
  try {
    const r = await api('/api/task/attach', { project: view.project, task: view.task, ai, paths });
    toast(r.typed ? UI.template`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : UI.text('作業ファイルに記録しました。AI を始めると読めます'));
    if (r.typed && panes[ai]) panes[ai].xterm.focus();
  } catch (err) { toast(err.message); }
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback4290() {
  return (paths => {
  if (view.kind === 'project') return addQuickImages(proj(view.project), paths, true);
  if (view.kind === 'work') return window.hubNativeDrop(paths);
  toast(UI.text('画像は依頼の入力欄か作業画面で貼り付けてください'));
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback4414() {
  return (e => {
  if (document.querySelector('.ideas-dialog[open]')) { e.preventDefault(); return; }
  e.preventDefault();
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform')) {
    e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; return;
  }
  if (view.kind === 'work' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.dataTransfer.dropEffect = 'copy'; lastDropAi = dropTarget(e.target); showDrop(lastDropAi); }
  else if (view.kind === 'newproject' && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
    const inRefs = e.target.closest && e.target.closest('#np-refs');
    lastDropZone = inRefs ? 'refs' : (e.target.closest && e.target.closest('#np-drop')) ? 'body' : '';
    const z = inRefs ? $('#np-refs') : $('#np-drop');
    if (z) { document.querySelectorAll('.dropfield.dropping').forEach(x => x !== z && x.classList.remove('dropping')); z.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => z.classList.remove('dropping'), 250); }
  } else if (view.kind === 'project' && e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; const v = document.querySelector('.view'); if (v) { v.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => v.classList.remove('dropping'), 250); } }
  else if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback4430() {
  return (e => {
  if (document.querySelector('.ideas-dialog[open]')) { e.preventDefault(); return; }
  e.preventDefault();
  // The native receiver owns this physical drop until its ticket is consumed.
  // WebKit can also emit an empty or populated DOM drop for the same gesture.
  if ([...nativeDropTickets.values()].some(currentNativeDropTarget)) return;
  if (view.kind === 'project' && e.dataTransfer) {
    const images = droppedFiles(e.dataTransfer).filter(isQuickImage);
    if (images.length) { e.stopPropagation(); addQuickImages(proj(view.project), images); return; }
  }
  // ブラウザで開いている時は、落としたフォルダの場所が分からない
  if (view.kind === 'newproject' || view.kind === 'project') { toast(UI.text('ブラウザでは場所が分かりません。［選ぶ…］を押すか、アプリの窓で落としてください')); return; }
  if (view.kind !== 'work' || !e.dataTransfer) return;
  const files = droppedFiles(e.dataTransfer);
  if (!files.length) { toast(UI.text('ブラウザから画像データが届きませんでした。保存した画像を選ぶか、貼り付けてください')); return; }
  return sendFiles(files, dropTarget(e.target));
});
}

// Create the original callback at its original registration point in app.js.
function appFilesCallback4442() {
  return (e => {
  if (document.querySelector('.ideas-dialog[open]')) return;
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform') && files.some(isQuickImage)) {
    e.preventDefault(); e.stopPropagation(); addQuickImages(proj(view.project), files); return;
  }
  if (view.kind !== 'work' || !files.length) return;
  e.preventDefault(); e.stopPropagation();
  sendFiles(files, dropTarget(document.activeElement));
});
}
