'use strict';
var UI = globalThis.HubI18n || { text: value => value, html: value => value, message: value => value, dateLocale: 'ja-JP',
  template: (strings, ...values) => strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '') };
let sessionLinkData = null, sessionLinkPreview = null, sessionLinkResult = null;
let sessionLinkSelected = new Set(), sessionLinkOpen = new Set(), sessionLinkQuery = '', sessionLinkPending = '', sessionLinkError = '', sessionLinkEpoch = 0, sessionLinkOpener = null;
const sessionLinkSessions = project => [...new Map((project.sessions || []).map(session => [session.id, session])).values()];
const sessionLinkSelectable = project => sessionLinkSessions(project).filter(session => !session.linked);
function sessionLinkWarnings(warnings) {
  return [...new Set(warnings || [])].map(warning => `<p class="note">${esc(UI.message(warning))}</p>`).join('');
}
function sessionLinkChanged() {
  sessionLinkPreview = null; sessionLinkError = ''; drawSessionLinkPreview(); updateSessionLinkControls();
}
function drawSessionLinkGroups() {
  const box = $('#session-links-groups'), top = box.scrollTop, query = sessionLinkQuery.trim().toLocaleLowerCase();
  const matching = (sessionLinkData?.projects || []).map(project => {
    const sessions = sessionLinkSessions(project), groupMatch = String(project.name || '').toLocaleLowerCase().includes(query);
    return { project, sessions: query && !groupMatch ? sessions.filter(session => String(session.title || '').toLocaleLowerCase().includes(query)) : sessions };
  }).filter(group => group.sessions.length || !query);
  const candidates = matching.flatMap(group => group.sessions).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const visible = new Set(candidates.slice(0, 200).map(session => session.id));
  const projects = matching.map(group => ({ ...group, sessions: group.sessions.filter(session => visible.has(session.id)) })).filter(group => group.sessions.length);
  box.innerHTML = (candidates.length > 200 ? UI.html('<p class="note">最近または検索に合う200件だけを表示しています。ほかの会話も名前で検索できます。選択は検索を変えても残ります。</p>') : '') + projects.map(({ project, sessions }) => {
    const selectable = sessionLinkSelectable(project), chosen = selectable.filter(session => sessionLinkSelected.has(session.id)).length;
    return UI.template`<section class="session-links-group"><label class="chk"><input type="checkbox" data-session-select-group="${esc(project.id)}" ${chosen && chosen === selectable.length ? 'checked' : ''} ${!selectable.length || selectable.length > 200 ? 'disabled data-session-unavailable' : sessionLinkPending ? 'disabled' : ''}><b>${esc(project.name || UI.text('名前のないグループ'))}</b> <span class="small">${externalProvider(project.provider)}</span></label>
      <p class="small">${selectable.length > 200 ? UI.text('このグループは200件を超えています。検索して会話を個別に選んでください。') : UI.text('このグループの未リンクの会話をすべて選びます。')}</p>
      <details data-session-group="${esc(project.id)}" ${sessionLinkOpen.has(project.id) || query ? 'open' : ''}><summary>会話を見る（${sessions.length}）</summary>
      ${sessions.map(session => UI.template`<label class="session-links-session"><input type="checkbox" data-session-choice="${esc(session.id)}" ${sessionLinkSelected.has(session.id) ? 'checked' : ''} ${session.linked ? 'disabled data-session-unavailable' : sessionLinkPending ? 'disabled' : ''}><span>${esc(session.title || UI.text('名前のない会話'))}<small>${externalProvider(session.provider || project.provider)} · ${esc(externalSourceLabel(session.source, session.sourceKind, session.isSubagent))} · ${session.linked ? UI.text('リンク済み') : !session.hasTranscript ? UI.text('元の履歴が見つかりません（リンクだけ保存します）') : ''}${session.updatedAt && Number.isFinite(Date.parse(session.updatedAt)) ? ' · ' + esc(new Date(session.updatedAt).toLocaleString(UI.dateLocale)) : ''}</small></span></label>`).join('')}
      </details></section>`;
  }).join('') || UI.html('<p class="note">該当するグループ・会話がありません。</p>');
  box.scrollTop = top;
  for (const checkbox of box.querySelectorAll('[data-session-select-group]')) {
    const project = sessionLinkData.projects.find(project => project.id === checkbox.dataset.sessionSelectGroup);
    const sessions = sessionLinkSelectable(project), count = sessions.filter(session => sessionLinkSelected.has(session.id)).length;
    checkbox.indeterminate = count > 0 && count < sessions.length;
  }
}
function drawSessionLinkPreview() {
  const box = $('#session-links-preview'), preview = sessionLinkPreview;
  if (sessionLinkResult) {
    const result = sessionLinkResult;
    box.innerHTML = UI.template`<h3>リンクしました</h3><p>リンクした会話：${esc(result.linkedCount)} ／ リンク済みで見送った会話：${esc(result.skippedCount)}</p>
      ${(result.links || []).map(link => `<p>${esc(link.title)}</p>`).join('')}${sessionLinkWarnings(result.warnings)}`;
    return;
  }
  if (!preview) { box.innerHTML = ''; return; }
  const groups = preview.groups || [], sessions = groups.reduce((sum, group) => sum + group.sessionCount, 0);
  box.innerHTML = UI.template`<h3>リンクする内容の確認</h3><p>グループ：${groups.length} ／ 会話：${esc(sessions)}</p>
    ${groups.map(group => UI.template`<div class="session-links-preview-group"><b>${esc(group.name)}</b><p class="small">会話：${esc(group.sessionCount)} ／ メッセージ：${esc(group.messageCount)} ／ リンク済み：${esc(group.alreadyLinkedCount)} ／ 履歴のない会話：${esc(group.missingHistoryCount)}</p></div>`).join('')}
    ${sessionLinkWarnings(preview.warnings)}${(preview.blockers || []).map(blocker => `<p class="danger">${esc(UI.message(blocker))}</p>`).join('')}
    <p class="small">この内容でよければ［確認してリンクする］を押してください。</p>`;
}
function updateSessionLinkControls() {
  const sheet = $('#session-links-sheet'); if (!sheet || sheet.hidden) return;
  const busy = Boolean(sessionLinkPending), finished = Boolean(sessionLinkResult), unavailable = sessionLinkData?.supported === false;
  for (const control of sheet.querySelectorAll('input,button')) control.disabled = busy || finished || unavailable || control.hasAttribute('data-session-unavailable');
  const close = $('#session-links-close'); close.disabled = sessionLinkPending === 'apply';
  $('#session-links-refresh').disabled = busy || finished;
  const preview = $('#session-links-check'); preview.hidden = finished; preview.disabled = busy || unavailable || !sessionLinkData || !sessionLinkSelected.size || finished;
  const apply = $('#session-links-apply'); apply.hidden = !sessionLinkPreview || finished;
  apply.disabled = busy || unavailable || !sessionLinkSelected.size || !sessionLinkPreview?.token || !sessionLinkPreview?.groups?.length || Boolean(sessionLinkPreview?.blockers?.length) || finished;
  const groups = (sessionLinkData?.projects || []).filter(project => sessionLinkSessions(project).some(session => sessionLinkSelected.has(session.id))).length;
  $('#session-links-selection').textContent = UI.template`選択中：${groups}グループ・${sessionLinkSelected.size}件の会話`;
  $('#session-links-warnings').innerHTML = sessionLinkWarnings(sessionLinkData?.warnings);
  $('#session-links-status').textContent = sessionLinkError || (sessionLinkPending === 'inventory' ? UI.text('Codex・Claude のグループ・会話を読み込んでいます…') : sessionLinkPending === 'preview' ? UI.text('選んだ内容を確認しています…') : sessionLinkPending === 'apply' ? UI.text('選んだ会話のリンクを保存しています…') : unavailable ? UI.text('この環境では外部会話のリンクを使えません。') : '');
}
async function loadSessionLink() {
  if (sessionLinkPending || sessionLinkResult) return;
  const epoch = ++sessionLinkEpoch; sessionLinkPending = 'inventory'; sessionLinkError = ''; sessionLinkPreview = null;
  drawSessionLinkPreview(); updateSessionLinkControls();
  try {
    const data = await api('/api/session-links'); if (epoch !== sessionLinkEpoch) return;
    sessionLinkData = data; externalSessionLinks = data.links || []; if (typeof renderTree === 'function') renderTree();
    const ids = new Set((data.projects || []).flatMap(sessionLinkSelectable).map(session => session.id));
    sessionLinkSelected = new Set([...sessionLinkSelected].filter(id => ids.has(id)));
    drawSessionLinkGroups();
  } catch (error) { if (epoch === sessionLinkEpoch) sessionLinkError = UI.message(error.message); }
  finally { if (epoch === sessionLinkEpoch) { sessionLinkPending = ''; updateSessionLinkControls(); } }
}
async function showSessionLink(opener) {
  if (sessionLinkPending) return;
  sessionLinkEpoch++; sessionLinkData = null; sessionLinkSelected = new Set(); sessionLinkOpen = new Set(); sessionLinkQuery = '';
  sessionLinkPreview = null; sessionLinkResult = null; sessionLinkError = ''; sessionLinkOpener = opener;
  if (!$('#session-links-sheet')) document.body.insertAdjacentHTML('beforeend', '<div id="session-links-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-labelledby="session-links-title"></div>');
  const sheet = $('#session-links-sheet'); sheet.hidden = false;
  sheet.innerHTML = UI.template`<div class="remove-box session-links-box"><h2 id="session-links-title" tabindex="-1">Codex・Claude の会話をリンク</h2>
    <p>選んだ会話だけをリンクします。元の会話・コードは元の場所に残り、送った指示は元のアプリの同じ会話につながります。リンクだけでは AI を起動しません。</p>
    <div class="row"><input id="session-links-search" type="search" placeholder="グループ・会話の名前を探す" aria-label="グループ・会話の名前を探す"><button class="btn plain" id="session-links-refresh" data-session-links="refresh" type="button">一覧を読み直す</button></div>
    <div id="session-links-groups" class="session-links-groups"></div><p id="session-links-selection" class="small"></p>
    <div id="session-links-warnings"></div><div id="session-links-preview"></div><p id="session-links-status" class="small" role="status" aria-live="polite"></p>
    <div class="acts"><button class="btn plain" id="session-links-close" data-session-links="close" type="button">閉じる</button><button class="btn" id="session-links-check" data-session-links="preview" type="button" disabled>選んだ内容を確認</button><button class="btn" id="session-links-apply" data-session-links="apply" type="button" disabled hidden>確認してリンクする</button></div></div>`;
  $('#session-links-title').focus({ preventScroll: true });
  await loadSessionLink();
}
function closeSessionLink() {
  if (sessionLinkPending === 'apply') return;
  sessionLinkEpoch++; sessionLinkPending = ''; $('#session-links-sheet').hidden = true;
  sessionLinkOpener?.focus({ preventScroll: true });
}
async function previewSessionLink() {
  if (sessionLinkPending || sessionLinkResult || sessionLinkData?.supported === false || !sessionLinkSelected.size) return;
  const epoch = ++sessionLinkEpoch, selected = [...sessionLinkSelected];
  sessionLinkPreview = null; sessionLinkError = ''; sessionLinkPending = 'preview'; drawSessionLinkPreview(); updateSessionLinkControls();
  try { const preview = await api('/api/session-links/preview', { selected }); if (epoch === sessionLinkEpoch) { sessionLinkPreview = preview; drawSessionLinkPreview(); } }
  catch (error) { if (epoch === sessionLinkEpoch) sessionLinkError = UI.message(error.message); }
  finally { if (epoch === sessionLinkEpoch) { sessionLinkPending = ''; updateSessionLinkControls(); } }
}
async function applySessionLink() {
  const preview = sessionLinkPreview;
  if (sessionLinkPending || sessionLinkResult || sessionLinkData?.supported === false || !sessionLinkSelected.size || !preview?.token || !preview.groups?.length || preview.blockers?.length) return;
  const epoch = ++sessionLinkEpoch; sessionLinkPending = 'apply'; sessionLinkError = ''; updateSessionLinkControls();
  try {
    const result = await api('/api/session-links/apply', { token: preview.token, confirm: true });
    if (epoch !== sessionLinkEpoch) return;
    sessionLinkResult = result; externalSessionLinks = result.links || []; sessionLinkPreview = null; drawSessionLinkPreview(); if (typeof renderTree === 'function') renderTree();
  } catch (error) {
    if (epoch === sessionLinkEpoch) { sessionLinkPreview = null; sessionLinkError = UI.template`${UI.message(error.message)}。もう一度、選んだ内容を確認してください。`; drawSessionLinkPreview(); }
  } finally { if (epoch === sessionLinkEpoch) { sessionLinkPending = ''; updateSessionLinkControls(); } }
}
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-session-links]'); if (!button || button.disabled) return;
  const action = button.dataset.sessionLinks;
  if (action === 'show') await showSessionLink(button);
  else if (action === 'close') closeSessionLink();
  else if (action === 'refresh') await loadSessionLink();
  else if (action === 'preview') await previewSessionLink();
  else if (action === 'apply') await applySessionLink();
});
document.addEventListener('change', event => {
  if (sessionLinkPending || sessionLinkResult || sessionLinkData?.supported === false) return;
  const input = event.target;
  if (input.matches?.('[data-session-choice]') && !input.disabled) {
    const valid = (sessionLinkData?.projects || []).flatMap(sessionLinkSelectable).some(session => session.id === input.dataset.sessionChoice);
    if (!valid) return;
    if (input.checked && !sessionLinkSelected.has(input.dataset.sessionChoice) && sessionLinkSelected.size >= 200) { input.checked = false; sessionLinkError = UI.text('一度に選べる会話は200件までです。'); updateSessionLinkControls(); return; }
    if (input.checked) sessionLinkSelected.add(input.dataset.sessionChoice); else sessionLinkSelected.delete(input.dataset.sessionChoice);
  } else if (input.matches?.('[data-session-select-group]') && !input.disabled) {
    const project = sessionLinkData?.projects?.find(project => project.id === input.dataset.sessionSelectGroup); if (!project) return;
    if (input.checked && new Set([...sessionLinkSelected, ...sessionLinkSelectable(project).map(session => session.id)]).size > 200) { input.checked = false; sessionLinkError = UI.text('一度に選べる会話は200件までです。'); updateSessionLinkControls(); return; }
    for (const session of sessionLinkSelectable(project)) { if (input.checked) sessionLinkSelected.add(session.id); else sessionLinkSelected.delete(session.id); }
  } else return;
  const group = input.dataset.sessionSelectGroup;
  drawSessionLinkGroups(); sessionLinkChanged();
  [...$('#session-links-groups').querySelectorAll('[data-session-select-group],[data-session-choice]')].find(control => group ? control.dataset.sessionSelectGroup === group : control.dataset.sessionChoice === input.dataset.sessionChoice)?.focus({ preventScroll: true });
});
document.addEventListener('input', event => {
  if (event.target.id !== 'session-links-search' || sessionLinkPending || sessionLinkResult) return;
  sessionLinkQuery = event.target.value; drawSessionLinkGroups();
});
document.addEventListener('toggle', event => {
  const detail = event.target; if (!detail.matches?.('[data-session-group]') || !$('#session-links-sheet')?.contains(detail)) return;
  if (detail.open) sessionLinkOpen.add(detail.dataset.sessionGroup); else sessionLinkOpen.delete(detail.dataset.sessionGroup);
}, true);
document.addEventListener('keydown', event => {
  const sheet = $('#session-links-sheet'); if (!sheet || sheet.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSessionLink(); }
  else if (event.key === 'Tab') {
    const controls = [...sheet.querySelectorAll('button,input,summary')].filter(control => !control.disabled && !control.hidden && control.getClientRects().length);
    const index = controls.indexOf(document.activeElement);
    if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) {
      event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  }
});

// Linked sessions keep their records and code in the original provider.
let externalSessionLinks = [], externalSessionEpoch = 0, externalSessionPolling = false, externalSessionRemoving = false;
const externalSessionState = new Map(), externalSessionRequests = new Map();
const EXTERNAL_PHASES = { idle: '指示待ち', preparing: '元の会話を確認しています', running: '元の会話で実行中', approval: '許可の確認待ち', completed: '完了', failed: '失敗しました', stopped: '停止しました' };
const externalProvider = provider => provider === 'codex' ? 'Codex' : 'Claude';
function externalSourceLabel(source, kind, child) { if (child) return UI.text(kind === 'guardian' ? '補助の会話' : '子の会話'); return UI.text(({ Desktop: 'デスクトップ版', CLI: 'CLI', IDE: 'IDE', unknown: '種類不明' })[source] || source || '種類不明'); }
function externalStored(id) {
  try { return JSON.parse(localStorage.getItem('hub-external-' + id) || 'null') || { draft: '' }; } catch (_) { return { draft: '' }; }
}
function storeExternalDraft(id, draft) {
  try { localStorage.setItem('hub-external-' + id, JSON.stringify({ draft, request: externalSessionRequests.get(id) || null })); } catch (_) {}
}
function sessionLinkTreeHtml() {
  return UI.template`<div class="cap">外部の会話</div>${externalSessionLinks.map(link => `<button class="proj ${view.kind === 'external' && view.link === link.id ? 'sel' : ''}" data-external-session="${esc(link.id)}" type="button"><span class="nm"><b>${esc(link.title)}</b><span>${externalProvider(link.provider)} · ${esc(externalSourceLabel(link.source, link.sourceKind, link.isSubagent))}${link.broken ? ' · ' + UI.text('元の記録がありません') : ''}</span></span></button>`).join('') || UI.html('<p class="small external-list-empty">設定から会話をリンクできます。</p>')}`;
}
async function loadExternalSessionLinks() {
  try {
    const data = await api('/api/session-links'); externalSessionLinks = data.links || [];
    if (typeof renderTree === 'function') renderTree();
    if (view.kind === 'external') renderSessionLink();
  } catch (error) { if (view.kind === 'external') { const box = $('#external-status'); if (box) box.textContent = error.message; } }
}
function currentExternal(id) { return view.kind === 'external' && view.link === id && $('#external-view')?.dataset.externalId === id; }
function renderSessionLink() {
  const id = view.link, link = externalSessionLinks.find(link => link.id === id);
  if (currentExternal(id)) return;
  externalSessionEpoch++;
  const stored = externalStored(id); if (stored.request?.requestId && stored.request.text) externalSessionRequests.set(id, stored.request);
  $('#main').innerHTML = UI.template`<div class="external-view" id="external-view" data-external-id="${esc(id)}"><div class="external-header"><h2>${esc(link?.title || UI.text('外部の会話'))}</h2>
    <p class="small">${externalProvider(link?.provider)} · ${esc(externalSourceLabel(link?.source, link?.sourceKind, link?.isSubagent))}</p><p class="small">履歴とコードは元の場所に残ります。送った指示は、元のアプリの同じ会話で続けます。</p>
    <div class="acts"><button class="btn plain sm" data-external-action="refresh" type="button">元の履歴を読み直す</button><button class="btn plain sm" data-external-action="remove" type="button">リンクだけを外す</button></div></div>
    <div class="msgs external-history" id="external-history"></div><div class="external-run-output" id="external-output" hidden></div><div class="external-approvals" id="external-approvals"></div>
    <div class="composer"><p id="external-status" class="small" role="status" aria-live="polite">元の会話を確認しています…</p>
    <textarea id="external-compose" aria-label="元の会話へ送る指示" placeholder="元の会話へ送る指示">${esc(stored.draft || '')}</textarea>
    <div class="acts"><button class="btn" id="external-send" data-external-action="send" type="button" disabled>同じ会話へ送る</button><button class="btn plain" id="external-stop" data-external-action="stop" type="button" hidden>このツールからの実行を止める</button></div></div></div>`;
  const cached = externalSessionState.get(id);
  if (cached) { cached.shownSignature = null; cached.shownBroken = null; if (cached.history) drawExternalHistory(id, cached.history); drawExternalSession(id); }
  refreshExternalSession(id, true);
}
function drawExternalSession(id) {
  if (!currentExternal(id)) return;
  const data = externalSessionState.get(id) || {}, history = data.history, status = data.status, request = externalSessionRequests.get(id), compose = $('#external-compose');
  if (request && status?.requestId === request.requestId) {
    request.uncertain = false;
    if (status.verifiedSession && !request.cleared) {
      if (compose.value === request.text) compose.value = '';
      request.cleared = true; storeExternalDraft(id, compose.value);
    }
  }
  const ownBusy = Boolean(status?.busy), sourceBusy = history?.active === true, blocked = data.historyError || data.statusError || history?.broken || !history?.signature;
  const uncertain = request?.uncertain;
  $('#external-send').textContent = uncertain ? UI.text('同じ指示の送信をもう一度確認') : UI.text('同じ会話へ送る');
  $('#external-send').disabled = Boolean(!status || blocked || ownBusy || sourceBusy || data.action || !compose.value.trim() || uncertain && compose.value !== request.text);
  $('#external-stop').hidden = !ownBusy; $('#external-stop').disabled = Boolean(data.action);
  $('#external-view').querySelector('[data-external-action="remove"]').disabled = ownBusy || Boolean(data.action) || externalSessionRemoving;
  const messages = [data.error, data.historyError, data.statusError, ...(history?.warnings || [])].filter(Boolean);
  if (status?.error) messages.push(status.error);
  if (sourceBusy && !ownBusy) messages.push(UI.text('元のアプリで実行中です。終わってから送ってください。'));
  if (history && history.active === null) messages.push(UI.text('元の会話の実行状態は不明です。送信時に元のアプリで再確認します。'));
  if (uncertain) messages.push(UI.text('送信結果を確認できません。状態を読み直すか、同じ指示だけを再確認してください。'));
  if (status?.verifiedSession) messages.push(UI.text('元の会話と同じ識別であることを確認しました。'));
  const phase = status ? UI.text(EXTERNAL_PHASES[status.phase] || '待機中') : UI.text('元の会話を確認しています…');
  $('#external-status').textContent = [phase, ...messages].join('\n');
  const output = $('#external-output'); output.hidden = !status?.text;
  output.textContent = status?.text || '';
  $('#external-approvals').innerHTML = (status?.approvals || []).map(approval => UI.template`<section class="external-approval"><b>元のアプリが許可を求めています</b><pre>${esc(JSON.stringify(approval.detail || {}, null, 2))}</pre>
    <button class="btn" data-external-approval="${esc(approval.id)}" data-allow="true" type="button" ${data.action ? 'disabled' : ''}>今回だけ許可する</button><button class="btn plain" data-external-approval="${esc(approval.id)}" data-allow="false" type="button" ${data.action ? 'disabled' : ''}>許可しない</button></section>`).join('');
}
function drawExternalHistory(id, history) {
  if (!currentExternal(id)) return;
  const box = $('#external-history'), position = { top: box.scrollTop, follow: box.scrollHeight - box.scrollTop - box.clientHeight < 80 }, data = externalSessionState.get(id);
  if (data?.shownSignature === history.signature && data.shownBroken === history.broken) return;
  box.innerHTML = (history.messages || []).map(message => `<div class="m ${message.role === 'user' ? 'me' : 'ai'}"><div class="mh small">${message.role === 'user' ? UI.text('あなた') : externalProvider(history.provider)}${message.at ? ' · ' + esc(message.at) : ''}</div><div class="mb">${esc(message.text)}</div></div>`).join('') || UI.html('<p class="chat-empty">元の履歴はまだ表示できません。連結は保持しています。</p>');
  box.scrollTop = data?.shownSignature && !position.follow ? position.top : box.scrollHeight;
  data.shownSignature = history.signature; data.shownBroken = history.broken;
}
async function refreshExternalSession(id = view.link, forceHistory = false) {
  if (!currentExternal(id) || externalSessionPolling) return;
  externalSessionPolling = true; const epoch = externalSessionEpoch;
  const data = externalSessionState.get(id) || {}; externalSessionState.set(id, data);
  try {
    try { data.status = await api('/api/session-links/status?id=' + encodeURIComponent(id)); data.statusError = ''; }
    catch (error) { data.statusError = error.message; }
    const updateKey = [data.status?.requestId, data.status?.phase, data.status?.historyUpdated].join('/');
    if (forceHistory || !data.history || Date.now() - (data.lastHistory || 0) >= 10000 || data.status?.historyUpdated && updateKey !== data.historyUpdateKey) {
      try { data.history = await api('/api/session-links/history?id=' + encodeURIComponent(id)); data.historyError = ''; data.lastHistory = Date.now(); data.historyUpdateKey = updateKey; }
      catch (error) { data.historyError = error.message; }
    }
    if (epoch === externalSessionEpoch && currentExternal(id)) { if (data.history) drawExternalHistory(id, data.history); drawExternalSession(id); }
  } finally { externalSessionPolling = false; }
}
async function sendExternalSession(id = view.link) {
  if (!currentExternal(id)) return;
  const data = externalSessionState.get(id), compose = $('#external-compose'), text = compose.value;
  if (!data || $('#external-send').disabled || !text.trim()) return;
  const previous = externalSessionRequests.get(id), request = previous?.uncertain ? previous : { requestId: crypto.randomUUID(), text, uncertain: false };
  if (request.text !== text) return;
  externalSessionRequests.set(id, request); data.action = 'send'; data.error = ''; storeExternalDraft(id, text); drawExternalSession(id);
  try { data.status = await api('/api/session-links/send', { id, text, requestId: request.requestId }); request.uncertain = false; data.statusError = ''; }
  catch (error) { request.uncertain = true; data.error = error.message; storeExternalDraft(id, text); }
  finally { data.action = ''; drawExternalSession(id); }
}
async function externalSessionAction(action, approvalId, allow) {
  const id = view.link, data = externalSessionState.get(id); if (!currentExternal(id) || !data || data.action) return;
  if (action === 'answer' && !data.status?.approvals?.some(approval => approval.id === approvalId) || action === 'stop' && !data.status?.busy) return;
  data.action = action; data.error = ''; drawExternalSession(id);
  try { data.status = await api('/api/session-links/' + action, action === 'answer' ? { id, approvalId, allow } : { id }); }
  catch (error) { data.error = error.message; }
  finally { data.action = ''; drawExternalSession(id); }
}
async function removeExternalSession(id = view.link) {
  if (externalSessionRemoving || externalSessionState.get(id)?.status?.busy || !confirm(UI.text('Hub のリンクだけを外しますか？元の会話とコードは削除しません。'))) return;
  externalSessionRemoving = true; drawExternalSession(id);
  try {
    const result = await api('/api/session-links/remove', { id, confirm: true }); externalSessionLinks = result.links || [];
    if (view.kind === 'external' && view.link === id) { view = { kind: 'settings', project: view.project, task: null }; save(); render(); }
    else renderTree();
  } catch (error) { const data = externalSessionState.get(id); if (data) data.error = error.message; drawExternalSession(id); }
  finally { externalSessionRemoving = false; }
}
document.addEventListener('click', async event => {
  const link = event.target.closest?.('[data-external-session]');
  if (link) { view = { ...view, kind: 'external', link: link.dataset.externalSession, task: null }; save(); closeDrawer(); render(); return; }
  const approval = event.target.closest?.('[data-external-approval]');
  if (approval && !approval.disabled) { await externalSessionAction('answer', approval.dataset.externalApproval, approval.dataset.allow === 'true'); return; }
  const button = event.target.closest?.('[data-external-action]'); if (!button || button.disabled) return;
  if (button.dataset.externalAction === 'send') await sendExternalSession();
  else if (button.dataset.externalAction === 'refresh') await refreshExternalSession(view.link, true);
  else if (button.dataset.externalAction === 'stop') await externalSessionAction('stop');
  else if (button.dataset.externalAction === 'remove') await removeExternalSession();
});
document.addEventListener('input', event => { if (event.target.id === 'external-compose') { storeExternalDraft(view.link, event.target.value); drawExternalSession(view.link); } });
setInterval(() => { if (!document.hidden && view.kind === 'external') refreshExternalSession(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && view.kind === 'external') refreshExternalSession(view.link, true); });
loadExternalSessionLinks();
