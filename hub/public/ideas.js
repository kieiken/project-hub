/* Project-scoped idea intake. Drafts and operation IDs survive uncertain responses. */
(() => {
  'use strict';
  const UI = window.HubI18n || {text:x=>x,html:x=>x,template:(s,...v)=>s.reduce((out,x,i)=>out+x+(i<v.length?v[i]:''),'')};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const id = () => crypto.randomUUID();
  let dialog, project, task, data, generation = 0, timer, busy = false, lastRev = -1, page = 0, attaching = false, filter = '', settingsOpen = false, laneEditing = false, firstRender = true;
  function automation(method,...args) { return window.HubIdeaAutomation?.[method]?.({dialog,project,data,esc,load,save,request,id,mutate,render,showSettings,laneEditing,firstRender,settingsOpen,lastRev,update(v){if('laneEditing'in v)laneEditing=v.laneEditing;if('firstRender'in v)firstRender=v.firstRender;if('settingsOpen'in v)settingsOpen=v.settingsOpen;if('lastRev'in v)lastRev=v.lastRev;}},...args); }
  const categories = { note: UI.text('メモ'), bug: UI.text('バグ'), improve: UI.text('改善'), feature: UI.text('アイデア'), research: UI.text('相談') };
  const categoryValue = value => value && value !== 'uncategorized' ? value : 'note';
  const categoryOptions = value => Object.entries(categories).map(([key, label]) => `<option value="${key}" ${key === categoryValue(value) ? 'selected' : ''}>${label}</option>`).join('');
  const intentOptions = value => UI.template`<option value="record" ${value !== 'build' ? 'selected' : ''}>記録だけ</option><option value="build" ${value === 'build' ? 'selected' : ''}>作る予定に入れる</option>`;
  const messages = new Map(), drafts = new Map(), imageURLs = new Map(), savingItems = new Set();
  let editing = false, deleting = null, listBusy = false, deleteReview = null;
  const rowErrors = new Map();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hub-ideas-erased') : null;
  const pendingList = () => listBusy || Object.values(load(project).operations || {}).some(a => ['/api/ideas/reorder', '/api/ideas/delete'].includes(a.route) || a.body?.change?.category);
  let drag = null, dragFrame;
  function paintDrag() {
    dialog.querySelectorAll('.idea-dragging,.idea-drop-before,.idea-drop-after').forEach(el => el.classList.remove('idea-dragging','idea-drop-before','idea-drop-after'));
    dialog.querySelectorAll('[data-idea-drag]').forEach(el => el.setAttribute('aria-pressed', String(drag?.id === el.dataset.ideaDrag && drag.active)));
    if (!drag?.active) return;
    dialog.querySelector(`[data-item="${drag.id}"]`)?.classList.add('idea-dragging');
    const rest = data.itemOrder.filter(id => id !== drag.id), before = rest[drag.index];
    const row = before && dialog.querySelector(`.idea-edit-row[data-item="${before}"]`);
    if (row) row.classList.add('idea-drop-before');
    else if (drag.index) dialog.querySelector(`.idea-edit-row[data-item="${rest[drag.index-1]}"]`)?.classList.add('idea-drop-after');
    dialog.querySelector('[data-drag-status]').textContent = UI.template`${drag.index+1} / ${data.total}件目へ移動${drag.keyboard ? UI.text('。Enterで保存、Escで取消') : UI.text('。離して保存、Escで取消')}`;
  }
  function cancelDrag(message = '') {
    const old = drag; drag = null; cancelAnimationFrame(dragFrame);
    if (old?.pointerId !== undefined && dialog.hasPointerCapture(old.pointerId)) dialog.releasePointerCapture(old.pointerId);
    if (dialog) { paintDrag(); dialog.querySelector('[data-drag-status]').textContent = message; }
    return old;
  }
  async function finishDrag() {
    if (!drag) return;
    if (drag.pageLoading) {
      if (!drag.keyboard) return void cancelDrag(UI.text('移動をやめました'));
      const current = drag; await current.pagePromise; if(drag===current)return finishDrag(); return;
    }
    const old = cancelDrag();
    if (!old.active || old.project !== project || old.generation !== generation || old.orderRev !== data?.orderRev || pendingList()) return;
    if (old.index !== old.from) {
      await rowAction('move', old.id, old.index);
    } else {
      page = Math.floor(old.from/100); lastRev = -1; await refresh();
      dialog.querySelector(`[data-idea-drag="${old.id}"]`)?.focus();
    }
  }
  function startDrag(handle, keyboard, e) {
    if (!editing || pendingList() || deleting || !data || handle.disabled) return false;
    const from = data.itemOrder.indexOf(handle.dataset.ideaDrag); if (from < 0) return false;
    drag = { id: handle.dataset.ideaDrag, project, generation, rev: data.rev, orderRev: data.orderRev, from, index: from, keyboard, active: keyboard, x: e?.clientX, y: e?.clientY, startY: e?.clientY, startX: e?.clientX, pointerId: e?.pointerId };
    paintDrag(); return true;
  }
  async function dragPage(nextPage) {
    const current = drag; if (!current || current.pageLoading || nextPage < 0 || nextPage*100 >= data.total) return;
    current.pageLoading = true; page = nextPage; lastRev = -1;
    try { current.pagePromise = refresh(); await current.pagePromise; } finally { if (drag === current) { current.pageLoading = false; current.hover = null; paintDrag(); if(current.keyboard)dialog.focus(); } }
  }
  function pointerTarget() {
    if (!drag?.active || drag.pageLoading) return;
    const rows = [...dialog.querySelectorAll('.idea-edit-row')], box = dialog.getBoundingClientRect();
    const first = rows[0]?.getBoundingClientRect(), last = rows.at(-1)?.getBoundingClientRect();
    drag.valid = Boolean(first && drag.x >= first.left && drag.x <= first.right && drag.y >= Math.max(box.top, first.top-16) && drag.y <= Math.min(box.bottom, last.bottom+16));
    if (!drag.valid) return;
    const candidates = rows.filter(row => row.dataset.item !== drag.id);
    const before = candidates.find(row => { const r = row.getBoundingClientRect(); return drag.y < (r.top+r.bottom)/2; });
    const lastId = candidates.at(-1)?.dataset.item;
    const boundary = before ? data.itemOrder.indexOf(before.dataset.item) : lastId ? data.itemOrder.indexOf(lastId)+1 : drag.from;
    drag.index = Math.max(0, Math.min(data.total-1, boundary-(drag.from < boundary ? 1 : 0)));
    paintDrag();
  }
  function dragTick(time) {
    if (!drag || drag.keyboard) return;
    if (drag.active && !drag.pageLoading) {
      const box = dialog.getBoundingClientRect(), inside = drag.x >= box.left && drag.x <= box.right && drag.y >= box.top && drag.y <= box.bottom;
      if (inside) {
        const delta = drag.y < box.top+64 ? -14 : drag.y > box.bottom-64 ? 14 : 0;
        if(delta) dialog.scrollTop += delta;
        const nav = document.elementFromPoint(drag.x,drag.y)?.closest('[data-idea-action=prev],[data-idea-action=next]');
        if(nav && !nav.disabled) {
          const nextPage = page + (nav.dataset.ideaAction === 'next' ? 1 : -1);
          if(drag.hover?.page !== nextPage)drag.hover={page:nextPage,since:time};
          else if(time-drag.hover.since > 650)void dragPage(nextPage);
        } else drag.hover = null;
      }
      pointerTarget();
    }
    dragFrame = requestAnimationFrame(dragTick);
  }
  function setupDrag() {
    dialog.addEventListener('pointerdown', e => {
      const handle = e.target.closest('[data-idea-drag]');
      if (!handle || e.button !== 0 || !e.isPrimary || drag || !startDrag(handle,false,e)) return;
      e.preventDefault(); handle.focus(); dialog.setPointerCapture(e.pointerId); dragFrame = requestAnimationFrame(dragTick);
    });
    dialog.addEventListener('pointermove', e => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.hypot(drag.y-drag.startY,drag.x-drag.startX) >= 6) drag.active = true;
      if (drag.active) { e.preventDefault(); pointerTarget(); }
    });
    dialog.addEventListener('pointerup', e => {
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.preventDefault(); drag.x = e.clientX; drag.y = e.clientY; pointerTarget();
      if(drag.valid)void finishDrag();else cancelDrag(UI.text('移動をやめました'));
    });
    dialog.addEventListener('pointercancel', () => cancelDrag(UI.text('移動をやめました')));
    dialog.addEventListener('lostpointercapture', () => { if(drag&&!drag.keyboard)cancelDrag(UI.text('移動をやめました')); });
    dialog.addEventListener('keydown', e => {
      if (!drag) {
        const handle = e.target.closest('[data-idea-drag]');
        if (handle && ['Enter',' '].includes(e.key) && !e.repeat) { e.preventDefault(); startDrag(handle,true); }
        return;
      }
      if (e.key === 'Escape' || e.key === 'Tab') { if(e.key==='Escape'){e.preventDefault();e.stopPropagation();} const old=cancelDrag(UI.text('移動をやめました'));dialog.querySelector(`[data-idea-drag="${old.id}"]`)?.focus();return; }
      if (!drag.keyboard) return;
      if (['Enter',' '].includes(e.key)) { e.preventDefault(); if(!e.repeat)void finishDrag(); return; }
      const step = { ArrowUp:-1,ArrowDown:1,PageUp:-100,PageDown:100 }[e.key];
      if(step !== undefined || ['Home','End'].includes(e.key)) {
        e.preventDefault(); if(drag.pageLoading)return;
        drag.index = Math.max(0,Math.min(data.total-1,e.key==='Home'?0:e.key==='End'?data.total-1:drag.index+step));
        const nextPage = Math.floor(drag.index/100); if(nextPage!==page)void dragPage(nextPage);else paintDrag();
      }
    });
    window.addEventListener('blur', () => { if(drag)cancelDrag(UI.text('移動をやめました')); });
  }
  let imageDB;
  function db() { return imageDB ||= new Promise((resolve, reject) => { const r = indexedDB.open('hub-idea-images', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error(UI.text('画像の下書きを保存できませんでした'))); }); }
  async function draftFile(p, key, value) { const store = await db(); return new Promise((resolve, reject) => { const tx = store.transaction('files', value === undefined ? 'readonly' : 'readwrite'), os = tx.objectStore('files'), r = value === undefined ? os.get(p + ':' + key) : value === null ? os.delete(p + ':' + key) : os.put(value, p + ':' + key); tx.oncomplete = () => resolve(r.result); tx.onerror = () => reject(Error(UI.text('画像の一時保存を変更できませんでした'))); tx.onabort = tx.onerror; }); }
  function revoke(p, ids) { for (const [key,url] of imageURLs) if(ids.some(id=>key.startsWith(p+':'+id+':'))) {URL.revokeObjectURL(url);imageURLs.delete(key);} }
  async function purge(p, itemId, imageIds = []) {
    const before=load(p),removed=new Set();
    const pending=[before.attempt,...Object.values(before.operations||{})].filter(a=>a?.route==='/api/ideas/add');
    for(const a of pending){const r=await request('/api/ideas/receipt?'+new URLSearchParams({project:p,opId:a.body.opId}));if(r.removed)removed.add(a.body.opId);}
    // Read again after network awaits, so cleanup cannot overwrite newly typed drafts.
    const d=load(p), operations={...d.operations}, itemSettings={...d.itemSettings};delete itemSettings[itemId];
    for(const [key,a] of Object.entries(operations))if(a.body?.id===itemId||removed.has(a.body?.opId))delete operations[key];
    let attempt=d.attempt,text=d.text;
    if(attempt&&removed.has(attempt.body.opId)){if(text===attempt.body.text)text='';attempt=null;}
    const images=(d.images||[]).filter(i=>!imageIds.includes(i.id));
    if(!save(p,{...d,text,attempt,images,operations,itemSettings}))throw Error(UI.text('一時保存の消去を確認できません'));
    if(p===project&&dialog?.open){
      const input=dialog.querySelector('#idea-text');
      if(text!==d.text&&input.value===d.text){input.value=text||'';resizeInput();}
      if(images.length!==(d.images||[]).length)renderDraftImages();
    }
    for(const key of imageIds)await draftFile(p,key,null);revoke(p,imageIds);
  }
  async function reconcile(d) {
    const p=d.project;
    for(const [id,tombstone] of Object.entries(d.erased||{}))await purge(p,id,tombstone.imageIds);
    // Saved/removed attachments from older versions must not remain as orphan File objects.
    const store=await db(),keys=await new Promise((resolve,reject)=>{const tx=store.transaction('files'),r=tx.objectStore('files').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const keep=new Set((load(p).images||[]).map(i=>p+':'+i.id));
    for(const key of keys)if(typeof key==='string'&&key.startsWith(p+':')&&!keep.has(key))await draftFile(p,key.slice(p.length+1),null);
  }
  async function invalidated(event) {
    const m=event.data;if(!m?.project||!m.id)return;
    drafts.delete(m.project);
    if(project===m.project&&dialog?.open){cancelDrag();generation++;lastRev=-1;data=null;dialog.querySelector('[data-idea-list]').replaceChildren();clearImageURLs();}
    try{await purge(m.project,m.id,m.imageIds);if(project===m.project&&dialog?.open)await refresh();}catch{status(UI.text('台帳から削除済み・この画面の一時保存の消去を確認中'),true);}
  }
  if(channel)channel.onmessage=invalidated;
  window.addEventListener('storage',e=>{if(e.key==='hub-idea-erased'&&e.newValue)void invalidated({data:JSON.parse(e.newValue)});});
  function imageURL(p, key, blob) { const k = p + ':' + key; if (!imageURLs.has(k)) imageURLs.set(k, URL.createObjectURL(blob)); return imageURLs.get(k); }
  function clearImageURLs() { for (const url of imageURLs.values()) URL.revokeObjectURL(url); imageURLs.clear(); }
  function originalViewer(p,key,url) {
    // A plain image document cannot react to deletion after its parent reloads.
    // Keep this viewer independent, with content-free notifications and a read check.
    function watch(p,key,url,origin,removedText,imageTitle,checkURL) {
      let timer,removed=false;
      function erase(){removed=true;document.querySelector('img')?.remove();document.body.textContent=removedText;URL.revokeObjectURL(url);clearInterval(timer);}
      function message(m){if(m?.project===p&&m.imageIds?.includes(key))erase();}
      const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('hub-ideas-erased'):null;if(channel)channel.onmessage=e=>message(e.data);
      addEventListener('storage',e=>{if(e.key==='hub-idea-erased'&&e.newValue)try{message(JSON.parse(e.newValue));}catch{}});
      async function check(){try{const r=await fetch(checkURL,{headers:{'X-Hub':'1'}});if(!r.ok)return;const d=await r.json();if(!d.imageIds.includes(key)){erase();return;}if(!removed&&!document.querySelector('img')){const img=document.createElement('img');img.src=url;img.alt=imageTitle;document.body.replaceChildren(img);}}catch{}}
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});timer=setInterval(()=>{if(!document.hidden&&!removed)void check();},3000);void check();
    }
    const args=JSON.stringify([p,key,url,location.origin,UI.text('この画像は削除されました'),UI.text('画像の原本'),globalThis.HubLocalAuth?.url(location.origin+'/api/ideas?'+new URLSearchParams({project:p})) || location.origin+'/api/ideas?'+new URLSearchParams({project:p})]).replace(/</g,'\\u003c');
    const html='<!doctype html><meta charset="utf-8"><title>'+esc(UI.text('画像の原本'))+'</title><style>body{margin:0;background:#171b24;color:#e6e9f0}img{max-width:100%;height:auto}</style><script>('+watch.toString()+')(...'+args+');</script>';
    return imageURL(p,key+':viewer',new Blob([html],{type:'text/html'}));
  }
  async function imageBlob(p, key, preview = true) { const r = await fetch('/api/ideas/image?' + new URLSearchParams({ project: p, id: key, ...(preview ? { preview: '1' } : {}) }), { headers: { 'X-Hub': '1' } }); if (!r.ok) throw Error(UI.text('画像を読み込めませんでした。原本の照合が必要です。')); return r.blob(); }
  async function hydrateImages() { const p = project, seq = generation; for (const el of dialog.querySelectorAll('[data-image-id]')) { if (el.src) continue; try { const key = el.dataset.imageId, local = el.dataset.draft ? await draftFile(p, key) : null, blob = local || await imageBlob(p, key); if (p === project && seq === generation && el.isConnected) el.src = imageURL(p, key + (local ? ':draft' : ':preview'), blob); } catch (e) { if (p === project && seq === generation) { el.alt = e.message; status(e.message); } } } }
  function renderDraftImages() {
    const d = load(project);
    dialog.querySelector('[data-idea-images]').innerHTML = (d.images || []).map(i => UI.template`<figure title="${esc(i.name)}"><img data-image-id="${esc(i.id)}" data-draft="1" alt="${esc(i.name)}"><button type="button" class="btn plain" data-image-remove="${esc(i.id)}" ${busy || d.attempt ? 'disabled' : ''} aria-label="${esc(i.name)}を取り外す">×</button></figure>`).join('');
    dialog.querySelector('[data-idea-pick]').disabled = busy || attaching || Boolean(d.attempt);
    for (const el of dialog.querySelectorAll('[data-idea-category], [data-idea-intent]')) el.disabled = busy || Boolean(d.attempt);
    automation('draftIntent',busy);
    void hydrateImages();
  }
  function resizeInput() { const el = dialog.querySelector('#idea-text'); el.style.height = 'auto'; el.style.height = Math.min(192, Math.max(72, el.scrollHeight)) + 'px'; }
  function intentHint() {const el=dialog.querySelector('[data-idea-intent-hint]');el.textContent='';automation('intentHint');}
  async function addFiles(files) {
    if (busy || attaching || load(project).attempt) { status(UI.text('保存結果を照合してから画像を変更してください。')); return; }
    const p = project; attaching = true;
    try { const d = load(p), before = d.images || [], all = [...files];
      if (before.length + all.length > 10) throw Error(UI.text('画像は10枚までです。'));
      if (all.some(f => !/\.(png|jpe?g|gif|webp)$/i.test(f.name) || !f.size || f.size > 20 * 1024 * 1024)) throw Error(UI.text('PNG・JPEG・GIF・WebPを選んでください。画像は1枚20MBまでです。'));
      if (before.reduce((n, i) => n + i.bytes, 0) + all.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) throw Error(UI.text('画像は合計50MBまでです。'));
      const added = []; for (const f of all) { const key = id(); await draftFile(p, key, f); added.push({ id: key, name: f.name, bytes: f.size }); }
      if (!save(p, { ...load(p), images: [...before, ...added] })) throw Error(UI.text('下書きの保存容量が不足しています。画像を選び直してください。'));
      if (p === project) status(UI.text('画像を追加しました。［保存］で台帳へ保存します。'));
    } catch (e) { if (p === project) status(e.message); }
    finally { attaching = false; if (p === project) renderDraftImages(); }
  }
  async function uploadImages(p) { for (const ref of load(p).images || []) { if (ref.image) continue;
    if (ref.uncertain) { const r = await request('/api/ideas/receipt?' + new URLSearchParams({ project: p, opId: ref.id })); if (r.saved === 'unknown') throw Error(UI.text('画像の保存結果を照合中です。下書きを保持しています。')); if (r.saved === true) { ref.image = r.image; save(p, load(p)); continue; } }
    const file = await draftFile(p, ref.id); if (!file) throw Error(UI.text('画像の下書きを読み込めません。画像を選び直してください。'));
    try { const r = await fetch('/api/ideas/image?' + new URLSearchParams({ project: p, opId: ref.id, name: ref.name }), { method: 'POST', headers: { 'X-Hub': '1', 'X-Hub-UI': 'ideas', 'Content-Type': 'application/octet-stream' }, body: file }); const result = await r.json(); if (!r.ok) throw Object.assign(Error(result.message || result.error), result); ref.image = result.image; ref.uncertain = false; }
    catch (e) { if (e.saved !== false) ref.uncertain = true; throw e; } finally { save(p, load(p)); }
  } }
  const labels = { note: UI.text('記録'), queued: UI.text('予定'), planning: UI.text('作業中'), running: UI.text('作業中'), waiting: UI.text('回答待ち'), blocked: UI.text('要対応'), implemented: UI.text('できた'), withdrawn: UI.text('停止済み') };
  function load(p) { if (drafts.has(p)) return drafts.get(p); let d = { text: '' }; try { d = JSON.parse(localStorage.getItem('hub-idea-draft:' + p)) || d; } catch {} drafts.set(p, d); return d; }
  function save(p, d) { drafts.set(p, d); try { localStorage.setItem('hub-idea-draft:' + p, JSON.stringify(d)); return true; } catch { if (p === project) status(UI.text('この画面の下書きは再読み込み後に残せません。原文を控えてください。')); return false; } }
  function status(text, error = false) { if (dialog) { const el = dialog.querySelector('[data-idea-status]'); el.textContent = text; el.classList.toggle('error', error); } }
  async function request(route, body) {
    const response = await fetch(route, { method: body ? 'POST' : 'GET', headers: { 'X-Hub': '1', ...(body ? { 'Content-Type': 'application/json', 'X-Hub-UI': 'ideas' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let d; try { d = await response.json(); } catch { throw Object.assign(Error(UI.text('保存結果を確認できません。原文を保持しています。')), { saved: 'unknown' }); }
    if (!response.ok) throw Object.assign(Error(d.message || d.error || UI.text('保存できませんでした')), d); return d;
  }
  async function submit(p, attempt) {
    if (attempt.uncertain) {
      const receipt = await request('/api/ideas/receipt?' + new URLSearchParams({ project: p, opId: attempt.body.opId }));
      if (receipt.saved === true) return receipt;
      if (receipt.saved === 'unknown') throw Object.assign(Error(UI.text('保存結果の照合を待っています。原文を保持しています。')), { saved: 'unknown' });
    }
    try { return await request(attempt.route, attempt.body); }
    catch (e) { if (e.saved !== false) attempt.uncertain = true; throw e; }
  }
  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.className = 'ideas-dialog'; dialog.setAttribute('aria-labelledby', 'ideas-title');
    dialog.innerHTML = UI.template`<header class="ideas-header"><div class="ideas-heading"><h2 id="ideas-title">アイデア台帳</h2><span data-idea-project></span></div><div class="ideas-header-actions">${automation('header') || ''}<button type="button" class="btn plain idea-icon" data-idea-close aria-label="閉じる">×</button></div></header>
    <form data-idea-form class="idea-composer" data-idea-drop><label class="idea-sr" for="idea-text">思いついたこと</label><textarea id="idea-text" rows="3" placeholder="思いついたこと（画像だけでも残せます）"></textarea><div class="idea-images idea-draft-images" data-idea-images></div><div class="idea-toolbar"><button type="button" class="btn plain" data-idea-pick title="1枚20MB・合計50MB・10枚まで">📎 画像</button><input type="file" data-idea-files accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><label><span class="idea-sr">種類</span><select data-idea-category aria-label="種類">${categoryOptions('note')}</select></label><label><span class="idea-sr">扱い</span><select data-idea-intent aria-label="扱い">${intentOptions('record')}</select></label><span class="voice-actions idea-save-actions"><button type="submit" class="btn" data-idea-add>保存</button></span></div><p class="idea-hint" data-idea-intent-hint></p></form>
    <p data-idea-status role="status" aria-live="polite"></p><section id="idea-settings" class="idea-settings" hidden><div data-idea-controls></div></section><div class="idea-list-tools" data-idea-filters></div><p id="idea-drag-help" class="idea-sr">Enterまたはスペースで移動開始、上下矢印で位置選択、HomeとEndで先頭と末尾、Enterで保存、Escapeで取消。</p><p class="idea-drag-status" data-drag-status role="status" aria-live="polite"></p><div data-idea-list></div>`;
    // Keep the header controls visually above the composer, after it in keyboard order.
    dialog.querySelector('[data-idea-form]').after(dialog.querySelector('.ideas-header-actions'));
    document.body.append(dialog);
    dialog.querySelector('[data-idea-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { if(dialog.open)return; window.HubVoice?.cancel(dialog.querySelector('#idea-text')); cancelDrag(); clearInterval(timer); generation++; clearImageURLs(); automation('close'); });
    dialog.querySelector('[data-idea-pick]').onclick = () => dialog.querySelector('[data-idea-files]').click();
    dialog.querySelector('[data-idea-files]').onchange = e => { void addFiles(e.target.files); e.target.value = ''; };
    dialog.addEventListener('dragover', e => { if(![...(e.dataTransfer?.types||[])].includes('Files'))return; e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; dialog.querySelector('[data-idea-drop]').classList.add('dropping'); });
    dialog.addEventListener('dragleave', e => { if (!dialog.contains(e.relatedTarget)) dialog.querySelector('[data-idea-drop]').classList.remove('dropping'); });
    dialog.addEventListener('drop', e => { if(!e.dataTransfer?.files.length)return; cancelDrag(); e.preventDefault(); e.stopPropagation(); dialog.querySelector('[data-idea-drop]').classList.remove('dropping'); void addFiles(e.dataTransfer?.files || []); });
    dialog.addEventListener('paste', e => { if (e.clipboardData?.files.length) { e.preventDefault(); e.stopPropagation(); void addFiles(e.clipboardData.files); } });
    dialog.addEventListener('click', async e => { const remove = e.target.closest('[data-image-remove]'), view = e.target.closest('[data-image-view]'); if (remove && !busy && !load(project).attempt) { save(project, { ...load(project), images: (load(project).images || []).filter(i => i.id !== remove.dataset.imageRemove) }); await draftFile(project,remove.dataset.imageRemove,null); revoke(project,[remove.dataset.imageRemove]); renderDraftImages(); } if (view) { const p=project,seq=generation; try { const blob=await imageBlob(p,view.dataset.imageView,false);if(p!==project||seq!==generation||!view.isConnected)return;const url=imageURL(p,view.dataset.imageView+':original',blob), a=document.createElement('a'); a.href=originalViewer(p,view.dataset.imageView,url); a.target='_blank'; a.rel='noopener'; a.click(); } catch(err) { status(err.message); } } });
    setupDrag();
    const input = dialog.querySelector('textarea');
    input.addEventListener('input', () => { save(project, { ...load(project), text: input.value }); resizeInput(); });
    for (const name of ['category', 'intent']) dialog.querySelector(`[data-idea-${name}]`).onchange = e => { save(project, { ...load(project), [name]: e.target.value }); intentHint(); };
    dialog.querySelectorAll('[data-idea-settings]').forEach(el => el.onclick = () => { settingsOpen = !settingsOpen; showSettings(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!busy) void add(); } });
    dialog.querySelector('form').onsubmit = e => { e.preventDefault(); void add(); };
    dialog.addEventListener('click', e => { const el = e.target.closest('[data-idea-action]'); if (el) void action(el); });
    dialog.addEventListener('change', e => {
      if(e.target.matches('[data-row-category]'))void rowAction('category',e.target.dataset.rowCategory,e.target.value);
      if(deleteReview&&e.target.matches('[data-markdown-line],[data-markdown-confirm]')){
        if(e.target.matches('[data-markdown-line]')){const selected=deleteReview.documents.find(d=>d.hash===e.target.dataset.markdownHash).removeLines,n=Number(e.target.dataset.markdownLine);if(e.target.checked)selected.push(n);else selected.splice(selected.indexOf(n),1);deleteReview.confirmed=false;dialog.querySelector('[data-markdown-confirm]').checked=false;}
        else deleteReview.confirmed=e.target.checked;
        const button=dialog.querySelector('[data-idea-action=delete-confirm]');if(button)button.disabled=listBusy||!reviewReady();
      }
    });
    dialog.addEventListener('cancel',e=>{if(drag){e.preventDefault();cancelDrag(UI.text('移動をやめました'));return;}if(deleting){e.preventDefault();deleting=null;deleteReview=null;document.activeElement?.blur();lastRev=-1;render(data);}});
    dialog.addEventListener('submit', e => { const itemSettings=e.target.closest('[data-idea-item-settings]'); if(itemSettings){e.preventDefault();void saveItemSettings(itemSettings);return;}const manual=e.target.closest('[data-idea-manual]');if(manual){e.preventDefault();const i=data.items.find(x=>x.id===manual.dataset.ideaManual),fields=new FormData(manual);void mutate('/api/ideas/update',{id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{manualEvidence:{acceptanceId:manual.dataset.condition,head:data.laneSnapshot?.head,checks:[fields.get('checks')],answer:fields.get('answer')}}},'manual:'+i.id+':'+manual.dataset.condition);return;}const edit=e.target.closest('[data-idea-edit]');if(edit){e.preventDefault();const i=data.items.find(x=>x.id===edit.dataset.ideaEdit);void mutate('/api/ideas/update',{id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{text:new FormData(edit).get('text')}},'edit:'+i.id);return;}if(automation('submit',e))return; const form = e.target.closest('[data-idea-answer]'); if (form) { e.preventDefault(); void answer(form); } });
  }
  async function open(p, t) {
    if (!p || p === 'freetalk') return;
    ensure(); cancelDrag(); clearImageURLs(); project = p; task = t; data = null; lastRev = -1; page = 0; filter = ''; settingsOpen = false; laneEditing = false; firstRender = true; editing = false; deleting = null; deleteReview = null; rowErrors.clear(); generation++; const seq = generation;
    clearInterval(timer); dialog.querySelector('[data-idea-project]').textContent = p; dialog.querySelector('textarea').value = load(p).text || ''; dialog.querySelector('[data-idea-list]').textContent = ''; dialog.querySelector('[data-idea-controls]').textContent = ''; status(UI.text('読み込み中'));
    dialog.querySelector('[data-idea-category]').value = categoryValue(load(p).category); dialog.querySelector('[data-idea-intent]').value = load(p).intent || 'record';
    const voiceInput = dialog.querySelector('#idea-text');
    window.HubVoice?.cancel(voiceInput);
    // Rebind the generation guard while reusing this dialog's input node.
    window.HubVoice?.mount(voiceInput, { buttonHost: dialog.querySelector('.idea-save-actions'), current: () => dialog.open && seq === generation && project === p && !busy && !load(p).attempt });
    renderDraftImages(); if (!dialog.open) dialog.showModal(); resizeInput();
    await refresh(seq); if (seq !== generation) return; timer = setInterval(() => { if (!document.hidden) {void refresh(); void automation('heartbeat');} }, 3000); dialog.querySelector('textarea').focus();
  }
  async function refresh(seq = generation) {
    const p = project, selectedFilter = filter, selectedPage = page, selectedDelete = deleting;
    try { const d = await request('/api/ideas?' + new URLSearchParams({ project: p, offset: selectedPage * 100, category: selectedFilter, ...(selectedDelete ? {deleteId:selectedDelete} : {}) })); if (seq !== generation || project !== p || filter !== selectedFilter || page !== selectedPage || deleting !== selectedDelete || !dialog.open || data&&d.rev<data.rev) return; for(const id of Object.keys(d.erased||{}))dialog.querySelector(`[data-item="${id}"]`)?.remove();try{await reconcile(d);}catch(e){if(Object.keys(d.erased||{}).length)throw Error(UI.text('台帳から削除済み・この画面の一時保存の消去を確認中'));throw e;} if(seq!==generation||project!==p)return; if(drag&&(d.rev!==drag.rev||d.orderRev!==drag.orderRev||!d.itemOrder.includes(drag.id)))cancelDrag(UI.text('一覧が更新されたため移動をやめました')); data = d; const pendingMove=Object.values(load(p).operations||{}).find(a=>a.route==='/api/ideas/reorder'), pendingAt=pendingMove?d.itemOrder.indexOf(pendingMove.body.id):-1; if(editing&&pendingAt>=0&&Math.floor(pendingAt/100)!==page){page=Math.floor(pendingAt/100);lastRev=-1;return refresh(seq);} if (page && page * 100 >= d.total) { page = Math.max(0, Math.ceil(d.total / 100) - 1); return refresh(seq); } render(d); }
    catch (e) { if (seq === generation) status(e.message,true); }
  }
  function showSettings() {
    dialog.querySelector('#idea-settings').hidden = !settingsOpen;
    dialog.querySelectorAll('[data-idea-settings]').forEach(el => el.setAttribute('aria-expanded', String(settingsOpen)));
  }
  function reviewReady() {
    const review=data?.deleteAvailability?.markdownReview;
    return Boolean(deleteReview?.confirmed&&review?.token===deleteReview.token&&review.documents.every(doc=>{const selected=deleteReview.documents.find(d=>d.hash===doc.hash)?.removeLines;return selected&&doc.targetLines.every(n=>selected.includes(n))&&(!selected.length||doc.canRemoveAll||doc.lines.filter((_,n)=>!selected.includes(n+1)).join('\n').trim());}));
  }
  function reviewMarkup(review) {
    if(!deleteReview||deleteReview.token!==review.token)return '';
    return UI.template`<div class="idea-markdown-review"><p>保存されていた原文です。この項目だけの行にチェックを付けてください。チェックのない行は、そのまま残ります。対象の記載がなければ、行を選ばず確認してください。</p>${review.documents.map((doc,n)=>UI.template`<fieldset><legend>原文 ${n+1}</legend><div class="idea-markdown-lines">${doc.lines.map((line,index)=>{const number=index+1,protectedLine=doc.protectedLines.includes(number),selected=deleteReview.documents.find(d=>d.hash===doc.hash).removeLines.includes(number);return UI.template`<label class="idea-markdown-line ${selected?'selected':''}"><input type="checkbox" data-markdown-line="${number}" data-markdown-hash="${doc.hash}" ${selected?'checked':''} ${protectedLine||listBusy?'disabled':''}><span class="idea-markdown-number">${number}</span><span>${esc(line)||' '}${protectedLine?UI.html('<small>（他の項目の記載・残します）</small>'):''}</span></label>`;}).join('')}</div></fieldset>`).join('')}<label class="idea-markdown-ack"><input type="checkbox" data-markdown-confirm ${deleteReview.confirmed?'checked':''} ${listBusy?'disabled':''}><span>原文を確認しました。選んだ行だけがこの項目の記載で、ほかの原文は残して削除します。</span></label></div>`;
  }
  function rowFeedback(d, i) {
    const pending=load(project).operations?.['delete:'+i.id],retry=Object.values(load(project).operations||{}).find(a=>a.body?.id===i.id&&['/api/ideas/reorder','/api/ideas/update'].includes(a.route)),availability=d.deleteAvailability?.id===i.id?d.deleteAvailability:null,review=availability?.markdownReview;
    const reviewing=Boolean(deleting===i.id&&review&&deleteReview?.token===review.token),deleteBlocked=!availability?.allowed&&!(reviewing&&reviewReady());
    return `${rowErrors.has(i.id)?`<p class="idea-row-error" role="alert">${esc(rowErrors.get(i.id))}</p>`:''}${retry?UI.template`<button type="button" class="btn sub" data-idea-action="row-retry" data-item="${i.id}" ${listBusy?'disabled':''}>保存結果を確認</button>`:''}${deleting===i.id||pending?UI.template`<div class="idea-delete-confirm"><p>この項目と画像を完全に削除します。元に戻せません。元の会話や、すでに作った変更は残ります。</p>${pending?UI.html('<p role="status">同じ受付の削除結果を確認します。</p>'):reviewing?reviewMarkup(review):deleteBlocked?`<p class="idea-row-error" role="status">${esc(availability?.message||UI.text('削除できるか確認中です'))}</p>`:''}<div class="idea-actions">${review&&!reviewing&&!pending?UI.template`<button type="button" class="btn sub" data-idea-action="delete-review" data-item="${i.id}" ${listBusy?'disabled':''}>原文を確認して削除</button>`:''}<button type="button" class="btn idea-danger" data-idea-action="delete-confirm" data-item="${i.id}" ${listBusy||!pending&&deleteBlocked?'disabled':''}>${pending?UI.text('削除の結果を確認'):reviewing?UI.text('確認した内容で削除する'):deleteBlocked?availability?UI.text('削除できません'):UI.text('確認中…'):UI.text('削除する')}</button><button type="button" class="btn sub" data-idea-action="delete-cancel" data-item="${i.id}" ${pending||listBusy?'disabled':''}>やめる</button></div></div>`:''}`;
  }
  function render(d) {
    if(deleteReview&&deleteReview.token!==d.deleteAvailability?.markdownReview?.token){
      deleteReview=null;
      if(dialog.querySelector('[data-idea-list]').contains(document.activeElement))document.activeElement.blur();
      status(UI.text('保存内容が変わりました。原文を確認し直してください'));
    }
    const intent = dialog.querySelector('[data-idea-intent]');
    intent.disabled = busy || Boolean(load(project).attempt);
    intent.title='';automation('intent',intent,busy);
    intentHint();
    if(drag&&!drag.pageLoading)return;
    const viewRev = JSON.stringify([d.rev, d.laneSnapshot, filter, page, editing, deleting, d.deleteAvailability, pendingList()]);
    if (viewRev === lastRev) return;
    const list = dialog.querySelector('[data-idea-list]'), controls = dialog.querySelector('[data-idea-controls]');
    if ((list.contains(document.activeElement) || controls.contains(document.activeElement)) && (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName))) return;
    const opened = new Set([...list.querySelectorAll('details[open]')].map(x => x.dataset.item)); lastRev = viewRev;
    automation('render',d,controls);showSettings();
    const counts = d.counts.categories || {};
    dialog.querySelector('[data-idea-filters]').innerHTML = UI.template`<div class="idea-list-heading"><strong>アイデア一覧</strong><span class="idea-list-count">${d.total}件</span><button type="button" class="btn plain" data-idea-action="list-edit" ${editing&&pendingList()?'disabled':''}>${editing?UI.text('編集を終える'):UI.text('編集')}</button></div><div class="idea-filter-scroll" role="group" aria-label="種類で絞り込み">${d.counts.waiting ? UI.template`<button type="button" class="idea-filter idea-waiting" data-idea-action="waiting" ${editing?'disabled':''}>回答待ち ${d.counts.waiting}</button>` : ''}${[['', UI.text('すべて')], ...Object.entries(categories)].map(([key, label]) => `<button type="button" class="idea-filter" data-idea-action="filter" data-category="${key}" aria-pressed="${filter === key}" ${editing?'disabled':''}>${label} <span>${key ? counts[key] || 0 : d.counts.all}</span></button>`).join('')}</div>${editing?UI.html('<p class="idea-hint">つまみをドラッグして並べ替え。ラベルと移動は自動保存します。</p>'):''}`;
    list.innerHTML = d.items.length ? d.items.map(i => {
      if(editing) {
        const pending=load(project).operations?.['delete:'+i.id],disabled=pendingList()?'disabled':'';
        return UI.template`<div class="idea-edit-row" tabindex="-1" data-item="${esc(i.id)}"><div class="idea-edit-line"><select data-row-category="${esc(i.id)}" aria-label="この項目のラベル" ${disabled}>${categoryOptions(i.category)}</select><span class="idea-summary-text">${esc(i.text.split('\n')[0]||UI.text('画像の記録'))}</span><button type="button" class="btn plain idea-drag-handle" data-idea-drag="${i.id}" aria-label="この項目を移動" title="ドラッグで移動。キーボードはEnterで開始、矢印で移動、Enterで保存、Escで取消" aria-describedby="idea-drag-help" aria-pressed="false" ${disabled}>⠿</button><button type="button" class="btn plain idea-delete" data-idea-action="delete" data-item="${i.id}" aria-label="削除" ${disabled&&!pending?'disabled':''}><span aria-hidden="true">×</span><span class="idea-delete-word">削除</span></button></div>${rowFeedback(d, i)}</div>`;
      }
      const background = i.organized?.background, itemDraft = load(project).itemSettings?.[i.id], itemBusy = savingItems.has(project + ':' + i.id), pendingSettings = ['category', 'intent'].some(name => load(project).operations?.['settings-' + name + ':' + i.id]);
      let label = labels[i.status];
      label=automation('label',d,i,label) ?? label;
      return UI.template`<details class="idea-item" data-item="${esc(i.id)}" ${opened.has(i.id) ? 'open' : ''}><summary><span class="idea-category" data-category="${esc(i.category)}">${esc(categories[i.category] || categories.note)}</span><span class="idea-summary-text">${esc(i.organized?.summary || i.text.split('\n')[0] || UI.text('画像の記録'))}</span>${i.images?.length ? UI.template`<span class="idea-image-count" aria-label="画像${i.images.length}枚">🖼${i.images.length}</span>` : ''}<small data-status="${esc(i.status)}">${esc(label)}</small></summary><div class="idea-detail-tools"><label>${UI.text('種類')}<select data-row-category="${esc(i.id)}" aria-label="${esc(UI.text('この項目のラベル'))}" ${pendingList()?'disabled':''}>${categoryOptions(i.category)}</select></label><button type="button" class="btn plain idea-delete" data-idea-action="delete" data-item="${esc(i.id)}" ${pendingList()&&!load(project).operations?.['delete:'+i.id]?'disabled':''}>${UI.text('削除')}</button></div>${rowFeedback(d, i)}<pre>${esc(i.text)}</pre>${i.images?.length ? `<div class="idea-images">${i.images.map(x => UI.template`<figure><button type="button" class="btn plain idea-image-view" data-image-view="${esc(x.id)}" aria-label="${esc(x.name)}の原本を開く"><img data-image-id="${esc(x.id)}" alt="${esc(x.name)}"></button><figcaption>${esc(x.name)}</figcaption></figure>`).join('')}</div>` : ''}${background ? UI.template`<p>背景（${esc(({ explicit: UI.text('会話で明示'), inferred: UI.text('AIの推測'), unknown: UI.text('不明') })[background.kind] || background.kind)}）：${esc(background.text)}</p><details><summary>背景の根拠</summary><pre>${esc(JSON.stringify(background.refs || []))}</pre></details>` : ''}${i.source?.capture === 'unverified' ? UI.html('<p>出どころ：確認待ち（原文は保存済み）</p>') : ''}${i.acceptance?.filter(a=>a.verification==='manual'&&!i.manualEvidence?.some(e=>e.acceptanceId===a.id&&e.contentRev===i.contentRev&&e.head===d.laneSnapshot?.head)).map(a=>UI.template`<form data-idea-manual="${esc(i.id)}" data-condition="${esc(a.id)}"><label>人による確認：${esc(a.text)}<textarea name="checks" placeholder="確かめた操作" required></textarea></label><label>確認結果<textarea name="answer" required></textarea></label><button type="submit" class="btn sub">この変更の確認を記録</button></form>`).join('')||''}${i.questions.filter(q => q.answer === undefined && q.contentRev === i.contentRev).map(q => UI.template`<form data-idea-answer="${esc(q.id)}" data-item="${esc(i.id)}"><label>${esc(q.text)}<select name="choice"><option value="">回答を選ぶ</option>${(q.choices || []).map(c => `<option>${esc(c)}</option>`).join('')}</select></label><label>補足・自由回答<textarea name="answer" rows="2"></textarea></label><button type="submit" class="btn sub">回答する</button></form>`).join('')}<form class="idea-item-settings" data-idea-item-settings="${esc(i.id)}"><label><span class="idea-sr">扱い</span><select name="intent" aria-label="この項目の扱い" ${itemBusy || pendingSettings || i.status === 'withdrawn' || i.intent === 'build' && !i.canUnbuild ? UI.template`disabled title="${esc(UI.text('実行終了後に削除できます'))}"` : ''}>${intentOptions(itemDraft?.intent || i.intent)}</select></label><button type="submit" class="btn sub" ${itemBusy ? 'disabled' : ''}>保存</button></form><div class="idea-actions idea-row-actions">${i.status !== 'withdrawn' ? UI.template`<button type="button" class="btn plain" data-idea-action="edit" data-item="${esc(i.id)}">原文を編集</button><button type="button" class="btn plain" data-idea-action="priority" data-item="${esc(i.id)}">${i.priority==='urgent'?UI.text('急ぎを解除'):UI.text('急ぎにする')}</button>` : ''}</div></details>`;
    }).join('') : `<p class="idea-empty">${filter ? UI.text('この種類の記録はありません。') : UI.text('まだ記録はありません。上の欄に書いて［保存］で残せます。')}</p>`;
    if(d.total>100)list.insertAdjacentHTML('beforeend',UI.template`<nav class="idea-actions"><button type="button" class="btn sub" data-idea-action="prev" title="移動中に重ねると前のページへ" ${page===0?'disabled':''}>前へ</button><span>${page*100+1}〜${Math.min(d.total,(page+1)*100)} / ${d.total}件</span><button type="button" class="btn sub" data-idea-action="next" title="移動中に重ねると次のページへ" ${(page+1)*100>=d.total?'disabled':''}>次へ</button></nav>`);
    list.querySelectorAll('[data-idea-item-settings] select').forEach(el => el.onchange = () => { const form = el.form, fields = new FormData(form); save(project, { ...load(project), itemSettings: { ...load(project).itemSettings, [form.dataset.ideaItemSettings]: { category: fields.get('category'), intent: fields.get('intent') } } }); });
    if(drag)paintDrag();
    void hydrateImages();
    if (!busy && !load(project).attempt && !dialog.querySelector('[data-idea-status]').classList.contains('error')) {
      const reason=d.observed?.reason||'',preserved=d.projection?.preserved?UI.text('手で編集されたアイデア帳は保全しています。表示は正式な記録から読み込んでいます。'):'';
      status([reason,preserved].filter(Boolean).join('\n'));
    }
  }
  async function add() {
    window.HubVoice?.cancel(dialog.querySelector('#idea-text'));
    const intent = dialog.querySelector('[data-idea-intent]').value, category = dialog.querySelector('[data-idea-category]').value;
    if (busy || attaching) return; const p = project, seq = generation, input = dialog.querySelector('#idea-text'), d = load(p), text = input.value;
    if (!text.trim() && !d.images?.length && !d.attempt) return;
    busy = true; dialog.querySelector('[data-idea-add]').disabled = true; dialog.querySelector('[data-idea-intent]').disabled = true; renderDraftImages(); status(UI.text('保存中'));
    let attempt = d.attempt;
    try {
      if (!attempt) { await uploadImages(p); attempt = { route: '/api/ideas/add', body: { project: p, opId: id(), text, intent, category, ...(load(p).images?.length ? { images: load(p).images.map(i => i.id) } : {}) } }; save(p, { ...load(p), attempt }); }
      if (attempt.uncertain) status(UI.text('保存結果を照合中'));
      const result=await submit(p, attempt); for(const key of attempt.body.images||[])await draftFile(p,key,null);revoke(p,attempt.body.images||[]); const current = load(p), nextText = current.text === attempt.body.text ? '' : current.text;
      save(p, { ...current, text: nextText, images: (current.images || []).filter(i => !attempt.body.images?.includes(i.id)), attempt: null, category: 'note', intent: 'record' });
      if (seq === generation) { input.value = nextText; dialog.querySelector('[data-idea-category]').value = 'note'; dialog.querySelector('[data-idea-intent]').value = 'record'; resizeInput(); intentHint(); renderDraftImages(); status(result.removed?UI.text('削除済みの項目のため再登録しません'):UI.text('保存済み・整理待ち')); await refresh(seq); }
    } catch (e) { save(p, { ...load(p), ...(e.saved === false ? { attempt: null } : attempt ? { attempt } : {}) }); if (seq === generation) status((attempt?.uncertain || (load(p).images || []).some(i => i.uncertain) ? UI.text('保存結果不明。') : UI.text('保存に失敗しました。')) + e.message + UI.text(' 本文と画像は保持しています。［保存］で照合できます。'), true); }
    finally { busy = false; dialog.querySelector('[data-idea-add]').disabled = false; renderDraftImages(); }
  }
  async function mutate(route, body, key) {
    const p = project, seq = generation, d = load(p), attempts = d.operations || {};
    const attempt = attempts[key] || { route, body: { project: p, opId: id(), ...body } }; attempts[key] = attempt; save(p, { ...d, operations: attempts });
    let serverDeleted=false;
    try {
      const result=await submit(p,attempt);
      automation('result',key,result,p);
      delete attempts[key];save(p,{...load(p),operations:attempts});
      if(result.deleted){
        serverDeleted=true;
        if(p===project&&dialog?.open){generation++;data=null;lastRev=-1;dialog.querySelector('[data-idea-list]').replaceChildren();clearImageURLs();}
        try{await purge(p,result.id,result.imageIds);}catch{throw Object.assign(Error(UI.text('台帳から削除済み・この画面の一時保存の消去を確認中')),{saved:'unknown',browserCleanup:true});}
        const message={project:p,id:result.id,imageIds:result.imageIds,nonce:id()};
        try{channel?.postMessage(message);localStorage.setItem('hub-idea-erased',JSON.stringify(message));}catch{/* Other open views also reconcile on their regular refresh. */}
      }
      if(seq===generation){if(Number.isInteger(result.index))page=Math.floor(result.index/100);status('');lastRev=-1;await refresh(seq);}
      return result;
    }catch(e){
      if(e.saved===false)delete attempts[key];save(p,{...load(p),operations:attempts});
      if(p===project&&(seq===generation||serverDeleted)){if(e.saved===false&&(['/api/ideas/delete','/api/ideas/reorder'].includes(route)||body.change?.category))await refresh(seq);status(e.message,true);}
      return null;
    }
  }
  async function rowAction(action,itemId,value) {
    if(listBusy)return;if(action==='delete-confirm'&&!load(project).operations?.['delete:'+itemId]&&!(data.deleteAvailability?.id===itemId&&(data.deleteAvailability.allowed||reviewReady()))){await refresh();return;}const item=data.items.find(i=>i.id===itemId);if(!item&&!(action==='move'&&data.itemOrder.includes(itemId)))return;
    const key=(action==='category'?'settings-category':action==='delete-confirm'?'delete':'reorder')+':'+itemId;
    if(pendingList()&&!load(project).operations?.[key])return;
    rowErrors.delete(itemId);listBusy=true;document.activeElement?.blur();lastRev=-1;render(data);status(UI.text('保存中'));
    let result;
    try {
      result=await mutate(action==='category'?'/api/ideas/update':action==='delete-confirm'?'/api/ideas/delete':'/api/ideas/reorder',action==='category'?{id:itemId,baseContentRev:item.contentRev,baseControlRev:item.controlRev,change:{category:value}}:action==='delete-confirm'?{id:itemId,baseContentRev:item.contentRev,baseControlRev:item.controlRev,confirm:true,...(reviewReady()?{markdownReview:deleteReview}:{})}:{id:itemId,baseOrderRev:data.orderRev,...(action==='move'?{toIndex:value}:{direction:action})},key);
      if(!result)rowErrors.set(itemId,dialog.querySelector('[data-idea-status]').textContent);
      if(result?.deleted){deleting=null;deleteReview=null;generation++;data=null;dialog.querySelector('[data-idea-list]').replaceChildren();clearImageURLs();await refresh();status(UI.text('削除しました'));}
    } catch(e){status(e.message,true);}
    finally{listBusy=false;lastRev=-1;if(data)render(data);if(result&&!result.deleted){const row=dialog.querySelector(`[data-item="${itemId}"]`),control=row?.querySelector(action==='category'?'select':action==='move'?'[data-idea-drag]':'[data-idea-action='+action+']');(control&&!control.disabled?control:row)?.focus();}}
  }
  async function saveItemSettings(form) {
    const savingKey = project + ':' + form.dataset.ideaItemSettings;
    if (savingItems.has(savingKey)) return;
    savingItems.add(savingKey);
    const p = project, seq = generation, itemId = form.dataset.ideaItemSettings, fields = new FormData(form);
    const pendingSettings = ['category', 'intent'].some(name => load(p).operations?.['settings-' + name + ':' + itemId]);
    const desired = { intent: fields.get('intent') ?? (pendingSettings ? form.elements.intent.value : null) };
    form.querySelectorAll('select').forEach(el => el.disabled = true);
    form.dataset.saving = 'true'; const button = form.querySelector('button'); button.disabled = true;
    try {
      for (const name of ['intent']) {
        if (project !== p || generation !== seq) return;
        const item = data.items.find(i => i.id === itemId); if (!item) return;
        const key = 'settings-' + name + ':' + itemId;
        if (!load(p).operations?.[key] && (!desired[name] || desired[name] === (item[name] || (name === 'category' ? 'note' : 'record')))) continue;
        const change = name === 'category' ? { category: desired[name] } : { build: desired[name] === 'build' };
        const result = await mutate('/api/ideas/update', { id: itemId, baseContentRev: item.contentRev, baseControlRev: item.controlRev, change }, key);
        if (!result) return;
      }
      if (project === p && generation === seq) { const drafts = { ...load(p).itemSettings }; delete drafts[itemId]; save(p, { ...load(p), itemSettings: drafts }); status(UI.text('扱いを保存しました')); lastRev = -1; render(data); }
    } finally { savingItems.delete(savingKey); if (project === p && generation === seq) { lastRev = -1; render(data); } }
  }
  async function action(el) {
    if (!data || el.disabled) return; const act = el.dataset.ideaAction, i = data.items.find(i => i.id === el.dataset.item); el.disabled = true;
    if(drag)cancelDrag(UI.text('移動をやめました'));
    if(act==='list-edit'){editing=!editing;deleting=null;deleteReview=null;filter='';lastRev=-1;await refresh();}
    if(i&&act==='row-retry'){const op=Object.values(load(project).operations||{}).find(a=>a.body?.id===i.id);if(op)await rowAction(op.body.change?.category?'category':Object.hasOwn(op.body,'toIndex')?'move':op.body.direction,i.id,op.body.change?.category??op.body.toIndex);return;}
    if(i&&['up','down','delete-confirm'].includes(act)){await rowAction(act,i.id);return;}
    if(i&&act==='delete-review'){
      const review=data.deleteAvailability?.id===i.id&&data.deleteAvailability.markdownReview;
      if(review){deleteReview={token:review.token,confirmed:false,documents:review.documents.map(d=>({hash:d.hash,removeLines:[]}))};lastRev=-1;render(data);dialog.querySelector('[data-markdown-line]:not(:disabled),[data-markdown-confirm]')?.focus();}return;
    }
    if(i&&act==='delete'){deleting=i.id;deleteReview=null;lastRev=-1;render(data);await refresh();dialog.querySelector(`[data-item="${i.id}"] [data-idea-action=delete-cancel]`)?.focus();return;}
    if(act==='delete-cancel'){deleting=null;deleteReview=null;lastRev=-1;render(data);dialog.querySelector(`[data-item="${i.id}"] [data-idea-action=delete]`)?.focus();return;}
    await automation('action',act,el);
    if (!editing && (act === 'filter' || act === 'waiting')) { filter = act === 'filter' ? el.dataset.category : ''; page = 0; if(act==='waiting'){const at=data.itemOrder.indexOf(data.waitingId);if(at>=0)page=Math.floor(at/100);}lastRev = -1; await refresh(); if (act === 'waiting') {const waiting=data.items.find(i=>i.status==='waiting'),row=waiting&&dialog.querySelector(`.idea-item[data-item="${waiting.id}"]`);if(row){row.open=true;row.scrollIntoView({block:'nearest'});}} }
    if(['prev','next'].includes(act)){page+=act==='next'?1:-1;lastRev=-1;await refresh();}
    if(i&&act==='priority')await mutate('/api/ideas/update',{id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{priority:i.priority==='urgent'?'normal':'urgent'}},'priority:'+i.id);
    if(i&&act==='edit'){const box=el.closest('details');if(!box.querySelector('[data-idea-edit]')){box.insertAdjacentHTML('beforeend',UI.template`<form data-idea-edit="${esc(i.id)}"><label>原文<textarea name="text" ${i.images?.length ? '' : 'required'}>${esc(i.text)}</textarea></label><p>編集後は記録として保存します。作る場合は、保存後に扱いを「作る予定に入れる」にしてください。</p><button type="submit" class="btn sub">原文を保存</button></form>`);box.querySelector('[data-idea-edit] textarea').focus();}}
    if (i && ['build'].includes(act)) await mutate('/api/ideas/update', { id: i.id, baseControlRev: i.controlRev, baseContentRev: i.contentRev, change: { [act]: true } }, act + ':' + i.id);
    el.disabled = false;
  }
  async function answer(form) { const i = data.items.find(i => i.id === form.dataset.item), q = i.questions.find(q => q.id === form.dataset.ideaAnswer), fields = new FormData(form), value = [fields.get('choice'), fields.get('answer')].filter(Boolean).join('\n'); if (value.trim()) await mutate('/api/ideas/update', { id: i.id, baseControlRev: i.controlRev, baseContentRev: i.contentRev, change: { answer: { id: q.id, rev: q.rev, value } } }, 'answer:' + q.id); }
  function messageButton(r, ctx) { if (!r.ideaSource || !r.text || ctx.project === 'freetalk' || !['user', 'assistant'].includes(r.role)) return ''; const key = JSON.stringify([ctx.project, ctx.task, r.ideaSource.rowRef]); messages.set(key, { ...messages.get(key), saved:load(ctx.project).savedMessages?.[key]||messages.get(key)?.saved, ...ctx, ref: r.ideaSource, text: r.text }); return `<button type="button" class="btn plain sm idea-save-message" data-idea-message="${esc(key)}">${messages.get(key).saved ? UI.text('台帳を見る') : UI.text('台帳に残す')}</button>`; }
  document.addEventListener('click', async e => {
    const entry = e.target.closest('[data-idea-open]'); if (entry) { void open(entry.dataset.ideaOpen, entry.dataset.ideaTask); return; }
    const btn = e.target.closest('[data-idea-message]'); if (!btn) return; const m = messages.get(btn.dataset.ideaMessage); if (!m || btn.disabled) return;
    if (m.saved) return void open(m.project, m.task);
    const d = load(m.project), ops = d.operations || {}, key = btn.dataset.ideaMessage;
    const attempt = ops[key] || { route: '/api/ideas/add', body: { project: m.project, opId: id(), intent: 'record', sourceRef: { task: m.task, ...m.ref }, ...(new TextEncoder().encode(m.text).length <= 65536 ? { sourceText: m.text } : {}) } };
    ops[key] = attempt; save(m.project, { ...d, operations: ops }); btn.disabled = true;
    try { await submit(m.project, attempt); m.saved = true; delete ops[key]; save(m.project, { ...load(m.project), operations: ops,savedMessages:{...load(m.project).savedMessages,[key]:true} }); btn.textContent = UI.text('台帳を見る'); }
    catch (e) { save(m.project, { ...load(m.project), operations: ops }); btn.textContent = attempt.uncertain ? UI.text('保存結果を確認') : UI.text('もう一度保存'); btn.title = e.message; }
    finally { btn.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dialog?.open) void refresh(); });
  window.HubIdeas = { open, messageButton };
})();
