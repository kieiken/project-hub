'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function specSelect(p, t, ai, live) {
  if (ai === 'agy') {
    const s = specOf(t,ai), models = shownModels('agy',s.model), selected = live ? agyModelLabel(sessOf(p.id,t.id,ai)?.model || s.model) : s.model;
    return UI.template`<span class="spec"><select data-act="model" data-ai="agy" data-p="${esc(p.id)}" data-t="${esc(t.id)}" aria-label="モデル" ${live ? 'disabled' : ''}><option value="" ${selected ? '' : 'selected'}>モデルを選んでください</option>${selected && !models.includes(selected) ? UI.template`<option selected disabled value="${esc(selected)}">${esc(selected)}（利用不可）</option>` : ''}${models.map(m => UI.template`<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(modelOptionLabel(ai,m))}</option>`).join('')}</select><select aria-label="思考" hidden disabled><option>高</option></select></span>`;
  }
  const key = AI_KEY[ai], active = live && ai === 'codex' ? sessOf(p.id,t.id,ai) : null;
  const scope = active ? { ...t, accounts: { ...t.accounts, codex: active.account || 'default' } } : t;
  const models = taskModels(key, scope, t.model), s = specOf(t, ai);
  const missing = t.model && !models.includes(t.model);
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"${live ? ` data-ai="${ai}"` : ''}`;
  return UI.template`<span class="spec" data-model-ai="${ai}" title="${live ? UI.template`変えると ${AI_LABEL[ai]} に切り替えを伝えます` : UI.template`次に始める時の ${AI_LABEL[ai]} のモデルと思考（空なら役割の設定）`}">
    <select data-act="model" ${k} aria-label="モデル"><option value="" ${t.model ? '' : 'selected'}>モデル：役割どおり（${esc(s.model || '—')}）</option>${missing ? UI.template`<option selected disabled value="${esc(t.model)}">${esc(t.model)}（現在の指定・利用不可）</option>` : ''}${models.map(m => UI.template`<option ${t.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select data-act="effort" ${k} aria-label="思考"><option value="" ${t.effort ? '' : 'selected'}>思考：役割どおり（${esc(s.effort || '—')}）</option>${effortsFor(ai, s.model, t.accounts?.codex).map(e => UI.template`<option ${t.effort === e ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select></span>`;
}

function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (!xtermLoading) {
    const one = src => new Promise((ok, ng) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => ng(new Error(UI.template`${src} を読み込めませんでした`)); document.head.appendChild(sc); });
    xtermLoading = one('vendor/xterm.js').then(() => one('vendor/addon-fit.js')).catch(e => { xtermLoading = null; throw e; });
  }
  return xtermLoading;
}

async function attach(project, task, ai) {
  try { await loadXterm(); } catch (e) { toast(e.message); return; }
  const el = document.getElementById('pane-' + ai);
  if (!el || panes[ai]) return; // 読み込みを待つ間に画面が変わった・もう付いている
  const xterm = new window.Terminal({ fontSize: 13, fontFamily: 'Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: window.HubTheme?.terminalTheme() || { background: '#10131a' } });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  const pane = { xterm, fit, es: null, ro: null };
  panes[ai] = pane;
  const doFit = () => { try { fit.fit(); api('/api/term/resize', { project, task, ai, cols: xterm.cols, rows: xterm.rows }).catch(() => {}); } catch (e) { /* 表示前 */ } };
  pane.ro = new ResizeObserver(doFit); pane.ro.observe(el);
  setTimeout(doFit, 0);
  xterm.onData(d => api('/api/term/input', { project, task, ai, data: d }).catch(() => {}));
  const es = new EventSource(`/api/term/stream?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&ai=${ai}`);
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'data') xterm.write(ev.data);
    if (ev.type === 'exit') { xterm.write("\r\n" + UI.template`\x1b[90m— 終了しました（code ${ev.code}）—\x1b[0m` + "\r\n"); es.close(); setTimeout(() => load().catch(() => {}), 500); }
  };
  pane.es = es;
}

function closePanes() {
  $('#msgs')?.hubCancelRows?.();
  chatScroller?.dispose(); chatScroller = null;
  if (chatES) { chatES.close(); chatES = null; }
  discussionUIInstance?.close();
  clearInterval(busyTimer); busyTimer = null; chatBusy = null;
  for (const ai of Object.keys(panes)) {
    const p = panes[ai];
    if (p.es) p.es.close();
    if (p.ro) p.ro.disconnect();
    try { p.xterm.dispose(); } catch (e) { /* 無視 */ }
  }
  panes = {};
}

async function startAI(p, t, ai) {
  if (accountSelectionSaving) { toast(UI.text('アカウントの選択を保存中です')); return; }
  if (taskFastSaving || accelerationSaving) { toast(UI.text('加速の選択を保存中です')); return; }
  const account = taskOf(proj(p), t)?.accounts?.[ai] || 'default';
  const model = ai === 'agy' ? modelRequest(ai,specOf(taskOf(proj(p),t),ai).model) : undefined;
  if (!state.terminal) {
    const r = await api('/api/continue', { project: p, task: t, ai, account, model });
    toast(UI.template`別の窓で起動しました（${r.dir}）`);
    return;
  }
  const r = await api('/api/term/start', { project: p, task: t, ai, account, model, cols: 100, rows: 30 });
  toast(UI.template`${AI_LABEL[r.ai || ai]} を起動しました${r.model ? `（${r.model}${r.effort ? '・' + r.effort : ''}）` : ''}${r.note ? '。' + r.note : ''}`);
  await load();
}

function updateStatus() {
  if (view.kind !== 'work') return;
  document.querySelectorAll('.pstat').forEach(el => { el.innerHTML = statusText(sessOf(view.project, view.task, el.dataset.ai)); });
}

// Create the original callback at its original registration point in app.js.
function appTerminalCallback2461() {
  return (() => {
  for (const pane of Object.values(panes)) pane.xterm.options.theme = window.HubTheme.terminalTheme();
});
}
