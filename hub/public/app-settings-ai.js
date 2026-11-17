'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function skillsHtml() {
  if (skillsError) return UI.template`<p class="small" role="status">確認できませんでした：${esc(skillsError)}</p>`;
  if (!skillsResult) return UI.html('<p class="small" role="status">確認中…</p>');
  return ['claude', 'codex', 'agy', 'grok'].map(ai => {
    const row = skillsResult.ais[ai], items = row.items;
    const message = row.error ? UI.text('スキルの置き場所を読み取れませんでした。') : !row.found ? UI.text('検出できる置き場所がありません（使えないとは限りません）。') : !items.length ? UI.text('この置き場所にはスキルが見つかりませんでした。') : '';
    return UI.template`<details class="more" data-skills-ai="${ai}"><summary>${esc(AI_LABEL[ai])}（${items.length}）</summary>
      ${message ? UI.template`<p class="small">${esc(message)}</p>` : ''}
      ${items.length ? UI.template`<div class="tbl"><table><thead><tr><th scope="col">名前</th><th scope="col">用途</th></tr></thead><tbody>${items.map(item => UI.template`<tr><td>${esc(item.name)}${item.source === 'system' ? UI.html(' <span class="small">付属</span>') : ''}</td><td>${esc(item.description || UI.text('（説明なし）'))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${row.limited ? UI.html('<p class="small">表示上限に達したため、一部のスキルは表示していません。</p>') : ''}</details>`;
  }).join('');
}

function drawSkills() {
  return preserveSettingsScroll(() => {
    const box = $('#skills-box'); if (!box || view.kind !== 'settings') return;
    const opened = new Set([...box.querySelectorAll('[data-skills-ai]')].filter(node => node.open).map(node => node.dataset.skillsAi));
    box.innerHTML = skillsHtml();
    box.querySelectorAll('[data-skills-ai]').forEach(node => { node.open = opened.has(node.dataset.skillsAi); });
    const button = $('#skills-check'); if (button) button.disabled = skillsLoadingBox === box;
  });
}

async function loadSkills(fresh = false) {
  const box = $('#skills-box'); if (view.kind !== 'settings' || !box || skillsLoadingBox === box) return;
  skillsLoadingBox = box; skillsError = ''; drawSkills();
  try {
    const result = await api('/api/skills' + (fresh ? '?fresh=1' : ''));
    if (view.kind !== 'settings' || $('#skills-box') !== box) return;
    skillsResult = result;
  } catch (error) { if (view.kind === 'settings' && $('#skills-box') === box) skillsError = error.message; }
  finally {
    if (skillsLoadingBox === box) skillsLoadingBox = null;
    if (view.kind === 'settings' && $('#skills-box') === box) drawSkills();
  }
}

function aiToolsNeedDataLocation() {
  return Boolean(state.dataManagementRoot && state.root === state.dataManagementRoot);
}

function aiToolsDataLocationMessage() {
  return UI.text('CLIの更新には、先にデータの保存先を選択し、同じアプリを開き直してください。');
}

function drawAiTools() {
  return preserveSettingsScroll(() => {
    const box = $('#ai-tools'); if (!box) return;
    if (!aiTools) { box.textContent = aiToolsError || UI.text('確認中…'); return; }
    const opened = box.querySelector?.('details')?.open || false;
    const running = Math.max(aiToolsBusyCount, (state.chatting || []).length + state.sessions.filter(s => s.running).length);
    const targets = AIS.filter(ai => aiTools[ai]?.eligible && aiTools[ai]?.installed);
    const excluded = AIS.filter(ai => !targets.includes(ai));
    const busy = aiBatchPending || Boolean(aiToolsOperation) || AIS.some(ai => aiToolPending[ai]);
    const needsDataLocation = aiToolsNeedDataLocation();
    const reason = needsDataLocation ? aiToolsDataLocationMessage() : aiToolsError || (busy ? UI.text('確認・更新中です…') : running ? UI.text('稼働中のCLIは飛ばし、ほかのCLIを更新できます。') : !targets.length ? UI.text('ログイン済みのCLIがありません。') : '');
    const modelText = status => ({ changed: UI.text('変更あり'), same: UI.text('変更なし'), first: UI.text('初回確認'), unknown: UI.text('未確認') }[status] || UI.text('未確認'));
    const excludedText = status => ({ 'not-installed': UI.text('未導入'), 'logged-out': UI.text('未ログイン'), api: UI.text('APIのログインは対象外です'), unknown: UI.text('ログイン状態を確認できませんでした') }[status] || UI.text('ログイン状態を確認できませんでした'));
    box.innerHTML = UI.template`<div class="ai-update-toolbar"><span class="small">ログイン済みを毎日確認します。</span><button class="btn" type="button" data-ai-update-all ${needsDataLocation || busy || aiToolsError ? 'disabled' : ''}>一括更新</button>${hubUpdateButton()}<span data-local-restart-status>${restartControls()}</span></div>
      ${reason ? UI.template`<p class="ai-tool-result" role="status">${esc(reason)}</p>` : ''}
      ${needsDataLocation ? UI.html('<button type="button" class="btn plain" data-ai-data-location>データの保存先を設定</button>') : ''}
      ${excluded.filter(ai => aiTools[ai]?.notice).map(ai => UI.template`<p class="ai-tool-result" role="status">${esc(AI_LABEL[ai])}：${esc(aiTools[ai].notice)}</p>`).join('')}
      <div class="ai-update-columns small"><span>CLI</span><span>バージョン</span><span>確認日</span><span>モデル一覧</span></div>
      ${targets.map(ai => {
        const tool = aiTools[ai], check = tool.updateCheck;
        const notice = tool.notice || (check?.ok && check.available === true && check.applicable === false ? UI.text('この導入方法では、Hubから更新できません。導入時の方法で更新してください。') : '');
        const date = check?.ok ? check.checkedAt : check?.failedAt;
        const formatted = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toLocaleString(UI.dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : UI.text('未確認');
        return UI.template`<div class="ai-update-entry" data-ai="${ai}"><div class="ai-update-row"><b>${esc(AI_LABEL[ai])}</b><span class="ai-update-version">${esc(tool.version || UI.text('未確認'))}${check?.ok && check.available === true ? UI.template` <span class="ai-update-change">→ ${esc(check.latestVersion)}</span>` : ''}</span><span class="ai-update-date small" title="${esc(date ? new Date(date).toLocaleString() : '')}"><span class="ai-update-date-label">確認 </span>${esc(formatted)}${check?.ok === false ? UI.text('（失敗）') : ''}</span><span class="ai-update-model small ${tool.modelsStatus === 'changed' ? 'ai-update-change' : ''}">${esc(modelText(tool.modelsStatus))}</span></div><div class="ai-tool-actions"><button type="button" class="btn plain" data-ai-check="${ai}" ${needsDataLocation || busy || aiCheckPending[ai] || tool.checking ? 'disabled' : ''}>更新を確認</button><button type="button" class="btn" data-ai-update="${ai}" ${needsDataLocation || busy || tool.busyCount || !check?.ok || !check.available || !check.applicable ? 'disabled' : ''}>更新</button>${tool.busyCount ? UI.template`<span class="small">このCLIが稼働中です</span>` : ''}</div>${notice ? UI.template`<p class="ai-tool-result" role="status">${esc(notice)}</p>` : ''}</div>`;
      }).join('')}
      <details class="more ai-update-details" ${opened ? 'open' : ''}><summary>${UI.template`詳細（対象外 ${excluded.length} 件）`}</summary>
      ${excluded.map(ai => UI.template`<p class="small">${esc(AI_LABEL[ai])}：${esc(excludedText(aiTools[ai]?.installed === false ? 'not-installed' : aiTools[ai]?.status))}${aiTools[ai]?.notice ? ` · ${esc(aiTools[ai].notice)}` : ''}${aiTools[ai]?.installed ? UI.template` <button type="button" class="btn plain" data-ai-check="${ai}" ${needsDataLocation || busy || aiCheckPending[ai] ? 'disabled' : ''}>更新を確認</button>` : ''}</p>`).join('')}
      ${targets.map(ai => {
        const tool = aiTools[ai], diff = tool.modelDiff;
        return UI.template`<p class="small">${esc(AI_LABEL[ai])} · ${esc(aiToolMethod(tool.method))} · ${esc(tool.source || UI.text('未確認'))}</p><p class="small">${esc((tool.models || []).map(m => m.label || m.id).join(' / '))}</p>${diff ? UI.template`<p class="small">${UI.template`追加：${esc(diff.added.join(' / ') || '—')} · 削除：${esc(diff.removed.join(' / ') || '—')} · 名称変更：${esc(diff.renamed.join(' / ') || '—')}`}</p>` : ''}${tool.modelCheckedAt ? UI.template`<p class="small">${UI.template`モデル確認：${esc(new Date(tool.modelCheckedAt).toLocaleString())}`}</p>` : ''}`;
      }).join('')}</details>
      <p class="ai-tool-result">毎日は確認のみ。一括更新時にも最新情報を確認します。</p>
      ${AIS.filter(ai => aiToolMessage[ai]).map(ai => UI.template`<p class="ai-tool-result" role="status">${esc(AI_LABEL[ai])}：${esc(aiToolMessage[ai])}</p>`).join('')}
      ${aiBatchMessage ? UI.template`<p class="ai-tool-result" role="status">${esc(aiBatchMessage)}</p>` : ''}`;
  });
}

function scheduleAiToolsWatch() {
  clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null;
  if (view.kind !== 'settings' || document.hidden) return;
  aiToolsWatchTimer = setTimeout(() => {
    aiToolsWatchTimer = null;
    if (view.kind === 'settings' && !document.hidden) loadAiTools();
  }, aiToolsOperation ? 3000 : aiToolsBusyCount ? 10000 : 60000);
}

async function loadAiTools() {
  const box = $('#ai-tools'); if (!box || aiToolsLoadingBox === box) return;
  aiToolsLoadingBox = box;
  const wasOperating = Boolean(aiToolsOperation);
  try {
    const r = await api('/api/ai-tools');
    if ($('#ai-tools') !== box) return;
    aiTools = r.tools || {}; aiToolsOperation = r.operation || null; aiToolsBusyCount = r.busyCount || 0; aiToolsError = r.error || '';
    state.aiCliUpdate = { available: AIS.some(ai => r.tools?.[ai]?.eligible && r.tools[ai].installed && r.tools[ai].updateCheck?.ok && r.tools[ai].updateCheck.available === true && r.tools[ai].updateCheck.applicable === true), busyCount: aiToolsBusyCount };
    showVersion(state.version, state.latest);
    if (wasOperating && !aiToolsOperation && !AIS.some(a => aiToolPending[a])) {
      try { await refreshAiToolCatalog(); }
      catch (e) { aiToolsError = UI.template`モデル一覧を画面へ反映できませんでした：${aiToolErrorText(e)}`; }
    }
  } catch (e) { if ($('#ai-tools') === box) { aiTools = null; aiToolsError = aiToolErrorText(e); } }
  finally { if (aiToolsLoadingBox === box) aiToolsLoadingBox = null; if ($('#ai-tools') === box) { drawAiTools(); scheduleAiToolsWatch(); } }
}

function refreshRoleModelChoices() {
  return preserveSettingsScroll(() => {
    if (view.kind !== 'settings') return;
    document.querySelectorAll('select[data-r][data-f="model"]').forEach(el => {
      const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
      el.innerHTML = roleModelOptions(slot.ai,slot.model);
      el.value = slot.model;
    });
    const note = $('#model-catalog');
    if (note) note.textContent = UI.template`選べるモデル：Claude Code は ${(state.roles.models['claude-code'] || []).join(' / ')}、Codex は ${(state.roles.models.codex || []).join(' / ')}、Grok は ${(state.roles.models.grok || []).join(' / ')}（思考は中・高・極高・MAX）、Gemini（Agy CLI）は取得したモデル一覧から選択・思考「高」。思考は ${state.efforts.join(' → ')}。`;
  });
}

async function refreshAiToolCatalog() {
  const epoch = ++stateLoadEpoch;
  const next = await api('/api/state');
  if (epoch !== stateLoadEpoch || webchatUIPending() || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  adoptState(next);
  refreshRoleModelChoices();
  if (view.kind === 'settings') await loadCliModels(true);
}

function aiToolResultText(action, r) {
  const modelReport = result => {
    if (!result) return UI.text('モデル一覧の状態を確認できませんでした。');
    if (result.deferred) return result.warning || UI.text('モデル一覧はAIの作業・順番待ちが終わってから確認します。');
    if (result.ok === false) return UI.template`モデル一覧の再取得に失敗しました：${result.error || result.warning || UI.text('理由を確認できません')}。`;
    const unchanged = Boolean(result.unchanged);
    const added = !unchanged && typeof result.added === 'number' ? UI.template`（追加 ${result.added} 件）` : '';
    return `${unchanged ? UI.text('モデル一覧は前回の内容を使用しています') : UI.template`モデル一覧を再取得しました${added}`}。`
      + (result.source ? UI.template`取得元：${result.source}。` : '')
      + (result.warning ? UI.template`注意：${result.warning}。` : '');
  };
  if (action === 'models') return modelReport(r);
  if (action === 'check') return (r.available ? UI.text('更新があります。適用する時は別のボタンを押してください。') : UI.text('更新の確認が終わりました。')) + modelReport(r.models)
    + (r.models?.accounts || []).map(result => UI.text('別のアカウント：') + modelReport(result)).join('');
  if (r.state) return UI.template`更新結果：${({updated:UI.text('更新済み'),checked:UI.text('確認済み'),failed:UI.text('失敗'),unsupported:UI.text('未対応'),unverified:UI.text('版未確認'),busy:UI.text('稼働中'),'mac-confirmation':UI.text('Mac の確認が必要')})[r.state] || r.state}。` + (r.notice || '');
  const before = r.beforeVersion || '', after = r.afterVersion || '';
  const base = r.verified === false ? UI.template`更新操作は終わりましたが、版を確認できませんでした${r.verifyError ? `：${r.verifyError}` : ''}。` : r.changed
    ? before && after ? UI.template`更新しました：${before} → ${after}。` : UI.template`更新しましたが、版を確認できませんでした。`
    : before || after ? UI.template`版は変わりませんでした（${after || before}）。` : UI.text('版の変化を確認できませんでした。');
  return base + modelReport(r.models);
}

async function runAiTool(ai, action) {
  if (aiToolsNeedDataLocation()) { drawAiTools(); return; }
  if (action === 'check') {
    if (!AIS.includes(ai) || aiCheckPending[ai] || aiTools?.[ai]?.checking || aiTools?.[ai]?.installed === false) return;
    aiCheckPending[ai] = true; aiToolMessage[ai] = UI.text('更新情報を確認しています…'); drawAiTools();
    try {
      const r = await api('/api/ai-tools/check', { ai });
      if (aiTools) aiTools[ai].updateCheck = r;
      aiToolMessage[ai] = aiToolResultText('check', r);
      await refreshAiToolCatalog();
    }
    catch (e) { aiToolMessage[ai] = aiToolErrorText(e); }
    finally { aiCheckPending[ai] = false; await loadAiTools(); drawAiTools(); }
    return;
  }
  if (!AIS.includes(ai) || !['update', 'models'].includes(action) || AIS.some(a => aiToolPending[a]) || aiToolsOperation || aiTools?.[ai]?.updating || aiTools?.[ai]?.installed === false || (action === 'models' && aiTools?.[ai]?.modelRefreshAvailable === false)) return;
  if (action === 'update' && (!aiTools?.[ai]?.updateCheck?.available || aiTools?.[ai]?.busyCount)) return; // 確認は［更新を確認］で済んでいるので、そのまま適用する
  aiToolPending[ai] = true; aiToolsOperation = { ai, kind: action }; aiToolMessage[ai] = action === 'update' ? UI.text('更新を適用しています…') : UI.text('モデル一覧を確認しています…'); drawAiTools();
  try {
    const path = action === 'update' ? '/api/ai-tools/update' : '/api/ai-tools/models/refresh';
    const result = await api(path, { ai });
    aiToolMessage[ai] = aiToolResultText(action, result);
    try { await refreshAiToolCatalog(); }
    catch (e) { aiToolMessage[ai] += UI.template`画面のモデル一覧を更新できませんでした：${aiToolErrorText(e)}。`; }
  } catch (e) { aiToolMessage[ai] = UI.template`失敗しました：${aiToolErrorText(e)}`; }
  finally { aiToolPending[ai] = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}

async function runAiUpdateAll() {
  if (aiToolsNeedDataLocation()) { drawAiTools(); return; }
  if (aiBatchPending || aiToolsOperation || aiToolsError) return;
  aiBatchPending = true; aiToolsOperation = { kind: 'update-all' }; aiBatchMessage = ''; drawAiTools();
  try {
    const result = await api('/api/ai-tools/update-all', {});
    const counts = key => (result.results || []).filter(r => r.state === key).length;
    aiBatchMessage = UI.template`一括更新が終わりました。更新 ${counts('updated')} 件、失敗 ${counts('failed')} 件、版未確認 ${counts('unverified')} 件、未対応 ${counts('unsupported')} 件、稼働中 ${counts('busy')} 件。` + UI.template`Mac の確認が必要 ${counts('mac-confirmation')} 件。`;
    await refreshAiToolCatalog();
  } catch (e) { aiBatchMessage = aiToolErrorText(e); }
  finally { aiBatchPending = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}

function modelOrderHtml() {
  const ids = orderedModels();
  const scoped = Boolean(state.codexModelCatalogs);
  if (!(state.accounts || []).some(r => r.ai === 'codex' && r.id === codexModelAccount)) codexModelAccount = 'default';
  const catalog = state.codexModelCatalogs?.[codexModelAccount];
  const hidden = state.codexHiddenModels?.[codexModelAccount] || (codexModelAccount === 'default' ? state.hiddenModels?.codex || [] : []);
  return UI.template`${scoped ? UI.template`<div class="acts"><label>Codexのモデル一覧 <select id="codex-model-account" ${modelViewSaving || codexModelsPending ? 'disabled' : ''}>${accountOptions('codex',codexModelAccount)}</select></label><button class="btn plain sm" id="codex-model-refresh" ${codexModelsPending || modelViewSaving ? 'disabled' : ''}>${codexModelsPending ? UI.text('取得中…') : UI.text('このアカウントの一覧を取得')}</button></div><p class="small">${catalog?.source ? UI.text('チェックしたモデルを、このアカウントの選ぶ欄に表示します。変更は自動で保存します。') : UI.text('このアカウントの一覧は未確認です。ログイン後に一覧を取得してください。')} 役割の指定と稼働中・順番待ちの依頼は変わりません。</p>` : ''}<div class="model-order-rows">${ids.map((id, i) => {
    const [ai, model] = id.split('|'), label = UI.template`${AI_LABEL[ai === 'claude-code' ? 'claude' : ai]}・${model}`;
    const absent = scoped && ai === 'codex' && !(catalog?.models || []).some(row => row.id === (state.cliFlags?.codex?.[model] || model));
    return UI.template`<div class="model-order-row" data-mo-row="${esc(id)}">
      <span class="model-grip" draggable="${!modelViewSaving}" data-mo-grip="${esc(id)}" aria-hidden="true" title="ドラッグして順番を変える">⋮⋮</span>
      <label class="chk"><input type="checkbox" data-mv-ai="${ai}" data-mv="${esc(model)}" ${(scoped && ai === 'codex' ? hidden : (state.hiddenModels || {})[ai] || []).includes(model) || absent ? '' : 'checked'} ${modelViewSaving || absent || codexModelsPending ? 'disabled' : ''}> <span>${esc(label)}${absent ? UI.text('（このアカウントの候補外）') : ''}</span></label>
      <button class="btn plain sm" type="button" data-mo-up="${esc(id)}" aria-label="${esc(label)} を上へ" ${modelViewSaving || i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn plain sm" type="button" data-mo-down="${esc(id)}" aria-label="${esc(label)} を下へ" ${modelViewSaving || i === ids.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`;
  }).join('') || UI.html('<span class="small">まだありません</span>')}</div>
  <div class="acts"><button class="btn plain sm" id="model-order-reset" type="button" ${modelViewSaving || !ModelOrder.clean(state.modelOrder).length ? 'disabled' : ''}>元の順に戻す</button></div>
  <p class="small" id="model-order-status" role="status">${esc(modelViewSaving ? UI.text('保存中…') : modelOrderNotice)}</p>`;
}

function drawModelOrder(focus) {
  return preserveSettingsScroll(() => {
    const box = $('#model-order-list');
    if (view.kind !== 'settings' || !box) return;
    box.innerHTML = modelOrderHtml();
    if (focus) {
      const id = typeof focus === 'string' ? focus : focus.id;
      const controls = [...box.querySelectorAll('[data-mo-up],[data-mo-down],[data-mv]')].filter(x => !x.disabled && (x.dataset.moUp === id || x.dataset.moDown === id || `${x.dataset.mvAi}|${x.dataset.mv}` === id));
      const button = controls.find(x => focus.checkbox ? x.dataset.mv !== undefined : focus.direction === 'down' ? x.dataset.moDown === id : x.dataset.moUp === id)
        || controls.find(x => x.dataset.moUp || x.dataset.moDown) || controls[0];
      button?.focus({ preventScroll: true });
    }
  });
}

function syncRoleModelOrder() {
  return preserveSettingsScroll(() => {
    if (view.kind !== 'settings') return;
    document.querySelectorAll('select[data-f="model"]').forEach(select => {
      const spec = rolesDraft?.[select.dataset.r]?.[select.dataset.k];
      if (!spec) return;
      const value = spec.model;
      select.innerHTML = roleModelOptions(spec.ai,value);
      select.value = value;
    });
  });
}

async function saveModelOrder(visible, focus, reset = false) {
  if (modelViewSaving) return;
  const before = orderedModels(), previous = state.modelOrder;
  const next = reset ? [] : ModelOrder.retainMissing(previous, visible);
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; state.modelOrder = next; drawModelOrder();
  try {
    const r = await api('/api/models/order', { order: next, before });
    state.modelOrder = r.modelOrder; state.hiddenModels = r.hiddenModels;
    modelOrderNotice = UI.text('並び順を保存しました'); toast(modelOrderNotice);
    syncRoleModelOrder(); drawInitialPick();
  } catch (e) {
    state.modelOrder = previous;
    modelOrderNotice = UI.template`並び順を保存できませんでした：${e.message}`; toast(modelOrderNotice);
    // 他の画面が先に保存した順を読み直す。役割の入力欄は作り直さない。
    if (e.status === 409) { try { const fresh = await fetchState(); if (fresh) { state.modelOrder = fresh.modelOrder; state.hiddenModels = fresh.hiddenModels; syncRoleModelOrder(); } } catch (_) {} }
  } finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder(focus); }
}

async function toggleModelVisibility(el) {
  if (modelViewSaving) { el.checked = !el.checked; return; }
  const { mvAi: ai, mv: model } = el.dataset, checked = el.checked;
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; drawModelOrder();
  try {
    const r = await api('/api/models/hidden', { ai, model, hidden: !checked, ...(ai === 'codex' && state.codexModelCatalogs ? { account: codexModelAccount } : {}) });
    if (r.codexHiddenModels) state.codexHiddenModels = r.codexHiddenModels;
    state.hiddenModels = r.hiddenModels; state.modelOrder = r.modelOrder;
    syncRoleModelOrder(); drawInitialPick();
    toast(checked ? UI.template`${model} を出します` : UI.template`${model} を隠しました`);
  } catch (e) { modelOrderNotice = UI.template`表示の設定を保存できませんでした：${e.message}`; toast(modelOrderNotice); }
  finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder({ id: `${ai}|${model}`, checkbox: true }); }
}

async function refreshCodexAccountModels() {
  if (codexModelsPending || modelViewSaving) return;
  const account = codexModelAccount;
  codexModelsPending = true; modelOrderNotice = ''; drawModelOrder();
  try {
    await api('/api/ai-tools/models/refresh', { ai: 'codex', account });
    await refreshAiToolCatalog();
    modelOrderNotice = UI.text('このアカウントのモデル一覧を保存しました');
  } catch (e) { modelOrderNotice = e.message; toast(e.message); }
  finally { codexModelsPending = false; drawModelOrder(); }
}

function clearModelDrop() { document.querySelectorAll('.model-order-row').forEach(x => x.classList.remove('model-drop-before','model-drop-after')); }

function specialModeHtml() {
  const mode = state.specialMode || { enabled: false, ai: 'codex' }, disabled = specialModeSaving ? 'disabled' : '';
  return UI.template`<label class="chk"><input id="special-mode-on" type="checkbox" ${mode.enabled ? 'checked' : ''} ${disabled}> 使う</label>
    <select id="special-mode-ai" aria-label="特殊モードのAI" ${disabled}>${['claude', 'codex'].map(ai => UI.template`<option value="${ai}" ${mode.ai === ai ? 'selected' : ''}>${AI_LABEL[ai]}</option>`).join('')}</select>
    <span class="small" role="status">${specialModeSaving ? UI.text('保存中…') : UI.text('すぐ保存・次の依頼から')}</span>`;
}

function drawSpecialMode() { preserveSettingsScroll(() => { const box = $('#special-mode'); if (box && view.kind === 'settings') box.innerHTML = specialModeHtml(); }); }

async function saveSpecialMode(next) {
  if (specialModeSaving) return;
  const previous = state.specialMode;
  ++stateLoadEpoch; specialModeSaving = true; state.specialMode = next; drawSpecialMode();
  try { const r = await api('/api/special-mode', next); state.specialMode = r.specialMode; syncSpecialModeChange(); }
  catch (e) { state.specialMode = previous; toast(e.message); }
  finally { ++stateLoadEpoch; specialModeSaving = false; drawSpecialMode(); }
}

function initialPickHtml() {
  const pick = initialPick(), key = AI_KEY[pick.ai];
  const missing = !(state.roles.models[key] || []).includes(pick.model), unavailable = missing || state.initialPickError;
  const disabled = initialPickSaving ? 'disabled' : '';
  return UI.template`<div class="cfg">
    <select data-initial="ai" aria-label="新規開始のAI" ${disabled}>${['claude', 'codex'].map(ai => UI.template`<option value="${ai}" ${pick.ai === ai ? 'selected' : ''}>${AI_LABEL[ai]}</option>`).join('')}</select>
    <select data-initial="model" aria-label="新規開始のモデル" ${disabled}>${missing ? UI.template`<option selected disabled value="${esc(pick.model)}">${esc(pick.model)}（利用不可）</option>` : ''}${shownModels(key, pick.model).map(m => UI.template`<option ${m === pick.model ? 'selected' : ''}>${esc(m)}${m === pick.model && state.initialPickError ? UI.text('（利用不可）') : ''}</option>`).join('')}</select>
    <select data-initial="effort" aria-label="新規開始の思考" ${disabled}>${effortsFor(pick.ai, pick.model).map(e => UI.template`<option ${e === pick.effort ? 'selected' : ''}${UI.valueAttribute(e)}>${esc(UI.label(e))}</option>`).join('')}</select>
    </div><div class="acts"><button type="button" class="btn plain" data-initial-reset ${disabled}>初期値に戻す</button></div>
    <p class="small" role="status">${initialPickSaving ? UI.text('保存中…') : unavailable ? UI.template`選んだモデルは利用不可です。モデルを選び直してください。${esc(state.initialPickError || '')}` : UI.text('変更するとすぐ保存します。')}</p>`;
}

function drawInitialPick() {
  return preserveSettingsScroll(() => {
    if (view.kind === 'settings') $('#initial-pick').innerHTML = initialPickHtml();
  });
}

async function saveInitialPick(next) {
  if (initialPickSaving) return;
  const previous = state.initialPick, previousError = state.initialPickError, previousPick = initialPick();
  ++stateLoadEpoch; initialPickSaving = true; state.initialPick = next; state.initialPickError = ''; drawInitialPick();
  try {
    const r = await api('/api/models/initial', next);
    state.initialPick = r.initialPick;
    // 保存した下書き・前回選択・入力中の内容を残し、未入力の初期値だけ更新する。
    for (const [id, draft] of quickDrafts) {
      let saved = true;
      try { saved = Boolean(localStorage.getItem('hub-start-' + id)); } catch (_) { /* 読めなければ保持 */ }
      if (!saved && !proj(id)?.startSpec && !draft.text && !draft.images.length &&
          ['ai', 'model', 'effort'].every(key => draft[key] === previousPick[key])) quickDrafts.delete(id);
    }
    toast(UI.text('新しく始めるときのAIを保存しました'));
  } catch (e) { state.initialPick = previous; state.initialPickError = previousError; toast(UI.template`初期AIを保存できませんでした：${e.message}`); }
  finally { ++stateLoadEpoch; initialPickSaving = false; drawInitialPick(); }
}

function phoneLabelStatus() {
  const failures = [...phoneLabelErrors.values()].join(' ／ ');
  return failures ? `${phoneLabelsSaving ? UI.text('保存中… ') : ''}${failures}` : phoneLabelsSaving ? UI.text('保存中…') : phoneLabelsNotice;
}

function phoneLabelMode() {
  return [...phoneLabelQueue].reverse().find(spec => spec.labels)?.labels || phoneLabelActive?.labels || state.phoneLabels?.labels || 'short';
}

function phoneLabelKeys() {
  return [...orderedModels(), ...(webchatUI() ? ['chatgpt|auto'] : []), ...(state.museSupported !== false ? ['muse|direct'] : [])];
}

function phoneLabelsHtml() {
  const phone = state.phoneLabels || { labels: 'short', names: {} }, full = phoneLabelMode() === 'full';
  return UI.template`<div class="phone-label-mode" role="group" aria-label="AI一覧の名前">
    <label><input type="radio" name="phone-label-mode" data-phone-mode="short" ${full ? '' : 'checked'}> 短い名前</label>
    <label><input type="radio" name="phone-label-mode" data-phone-mode="full" ${full ? 'checked' : ''}> AI名・モデル名（PCと同じ）</label>
  </div><p class="small">名前を入力するとスマホの一覧に使います。空欄で元の短い名前に戻ります（24字以内・改行なし）。</p>
  <div class="phone-label-rows">${phoneLabelKeys().map(key => {
    const [k, model] = key.split('|'), ai = k === 'claude-code' ? 'claude' : k;
    const label = ai === 'muse' ? UI.text('Muse（外部）') : ai === 'chatgpt' ? 'ChatGPT' : UI.template`${AI_LABEL[ai]}・${model}`;
    return UI.template`<label class="phone-label-row"><span>${esc(label)}</span><input type="text" data-phone-name="${esc(key)}" maxlength="24" aria-label="${esc(label)} のスマホ表示名" placeholder="${esc(shortModelLabel(ai, model))}" value="${esc(phoneLabelDrafts.has(key) ? phoneLabelDrafts.get(key) : phone.names?.[key] || '')}" ${full ? 'disabled' : ''}></label>`;
  }).join('')}</div><p class="small" role="status" id="phone-label-status">${esc(phoneLabelStatus())}</p>`;
}

function drawPhoneLabels() {
  return preserveSettingsScroll(() => {
    const box = $('#phone-labels');
    if (view.kind !== 'settings' || !box) return;
    const inputs = [...box.querySelectorAll('[data-phone-name]')], keys = phoneLabelKeys();
    if (JSON.stringify(inputs.map(el => el.dataset.phoneName)) !== JSON.stringify(keys)) {
      // 候補が変わった時だけ組み直す。入力・保存中は次のpollまで待つ。
      if (inputs.length && (phoneLabelsSaving || box.contains(document.activeElement))) return;
      box.innerHTML = phoneLabelsHtml();
    } else {
      const full = phoneLabelMode() === 'full';
      for (const el of box.querySelectorAll('[data-phone-mode]')) el.checked = el.dataset.phoneMode === (full ? 'full' : 'short');
      for (const el of inputs) {
        el.disabled = full;
        if (el !== document.activeElement && !phoneLabelDrafts.has(el.dataset.phoneName)) el.value = state.phoneLabels?.names?.[el.dataset.phoneName] || '';
      }
      const status = box.querySelector('#phone-label-status');
      if (status) status.textContent = phoneLabelStatus();
    }
    renderedPhoneKey = phoneSettingsKey();
  });
}

async function savePhoneLabels(spec) {
  if (spec.key) phoneLabelDrafts.set(spec.key, spec.name);
  phoneLabelQueue.push(spec);
  if (phoneLabelsSaving) { drawPhoneLabels(); return; }
  ++stateLoadEpoch; phoneLabelsSaving = true; phoneLabelsNotice = '';
  try {
    while (phoneLabelQueue.length) {
      phoneLabelActive = phoneLabelQueue.shift(); drawPhoneLabels();
      try {
        const r = await api('/api/models/phone', phoneLabelActive);
        state.phoneLabels = r.phoneLabels; syncChatPhoneLabels();
        if (phoneLabelActive.key && phoneLabelDrafts.get(phoneLabelActive.key) === phoneLabelActive.name) phoneLabelDrafts.delete(phoneLabelActive.key);
        phoneLabelErrors.delete(phoneLabelActive.key || 'mode');
        phoneLabelsNotice = UI.text('スマホの表示を保存しました');
        toast(phoneLabelErrors.size ? [...phoneLabelErrors.values()].join(' ／ ') : phoneLabelsNotice);
      } catch (e) {
        const [key, model] = (phoneLabelActive.key || '').split('|');
        const item = key ? UI.template`${shortModelLabel(key === 'claude-code' ? 'claude' : key, model)} の名前` : UI.text('AI一覧の名前の表示方法');
        phoneLabelErrors.set(phoneLabelActive.key || 'mode', UI.template`${item}は未保存です。保存できませんでした：${e.message}`);
        toast([...phoneLabelErrors.values()].join(' ／ '));
      }
      finally { phoneLabelActive = null; }
    }
  } finally { ++stateLoadEpoch; phoneLabelsSaving = false; drawPhoneLabels(); }
}

function roleAiAvailability(ai) {
  if (ai === '人') return '';
  const rows = (accountStatusRows || state.accounts || []).filter(r => r.ai === (ai === 'claude-code' ? 'claude' : ai));
  if ((ai === 'agy' || ai === 'grok') && aiUnavailable(ai)) return rows.some(r => r.status === 'api') ? UI.text('API認証（対象外）') : rows.some(r => r.status === 'not-installed') ? UI.text('未導入') : UI.text('利用を確認できません');
  if (rows.some(r => r.status === 'logged-in')) return '';
  if (rows.some(r => r.status === 'api')) return UI.text('API認証（対象外）');
  if (rows.some(r => r.status === 'not-installed')) return UI.text('未導入');
  return rows.length && rows.every(r => r.status === 'logged-out') ? UI.text('未ログイン') : UI.text('確認できません');
}

function roleAiOptions(selected) {
  return ['claude-code', 'codex', 'agy', 'grok', '人'].map(ai => {
    const reason = roleAiAvailability(ai), label = ai === 'claude-code' ? 'Claude Code' : ai === 'agy' ? 'Gemini（Agy CLI）' : ai === '人' ? UI.text('あなた') : AI_LABEL[ai];
    return UI.template`<option value="${ai}" ${selected === ai ? 'selected' : ''} ${reason ? 'disabled' : ''}>${label}${reason ? '（' + reason + '）' : ''}</option>`;
  }).join('');
}

function syncRoleAccountChoices() {
  if (view.kind !== 'settings') return;
  document.querySelectorAll('select[data-r][data-f="ai"]').forEach(el => {
    const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
    el.innerHTML = roleAiOptions(slot.ai); el.value = slot.ai;
  });
  const note = $('#role-account-status');
  if (note) note.textContent = accountCheckPromise ? UI.text('ログイン状態を確認中…') : accountCheckError || UI.template`ログイン済みの AI だけ選べます${accountCheckedAt ? UI.template`（${accountCheckedAt} に確認）` : ''}`;
  const button = $('#role-account-check'); if (button) button.disabled = Boolean(accountCheckPromise);
}

async function checkRoleAccounts() {
  if (accountCheckPromise) return accountCheckPromise;
  accountAutoChecked = true; accountCheckError = '';
  accountCheckPromise = (async () => {
    try {
      const result = await api('/api/accounts?status=1', undefined, { 'X-Hub': '1' });
      accountStatusRows = result.accounts; state.accounts = result.accounts;
      adoptAgyCatalog(result); refreshRoleModelChoices();
      accountCheckedAt = new Date().toLocaleTimeString(UI.dateLocale, { hour: '2-digit', minute: '2-digit' });
    } catch (e) { accountCheckError = UI.text('ログイン状態を確認できませんでした：') + e.message; throw e; }
    finally { accountCheckPromise = null; syncRoleAccountChoices(); drawAccountSettings(); }
  })();
  syncRoleAccountChoices(); return accountCheckPromise;
}

function autoCheckRoleAccounts() {
  if (settingsTab === 'ai' && !accountAutoChecked && !accountStatusRows) checkRoleAccounts().catch(() => {});
}

function accountOptions(ai, selected) {
  const rows = (state.accounts || []).filter(r => r.ai === ai);
  const missing = selected !== 'default' && !rows.some(r => r.id === selected);
  return (missing ? UI.template`<option value="${esc(selected)}" selected disabled>削除済み（選び直してください）</option>` : '') + rows.map(r => UI.template`<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''}>${esc(UI.label(r.name))}</option>`).join('');
}

function taskAccountSelect(p, t, ai, chat = false) {
  const rows = (state.accounts || []).filter(r => r.ai === ai), selected = t.accounts?.[ai] || 'default';
  const hidden = rows.length < 2 && selected === 'default';
  return UI.template`<label class="account-pick small" ${hidden ? 'hidden' : ''}>${chat ? '' : UI.template`${esc(AI_LABEL[ai])}のアカウント`} <select ${chat ? 'id="chat-account"' : ''} data-task-account data-p="${esc(p.id)}" data-t="${esc(t.id)}" data-ai="${esc(ai)}" aria-label="${UI.template`${esc(AI_LABEL[ai] || '')}のアカウント`}">${accountOptions(ai, selected)}</select></label>`;
}

function taskFastSelect(p, t, ai) {
  if (ai !== 'codex' || !state.acceleration?.codexAllowed) return '';
  const on = t.codexFast === true, pending = taskFastPending.has(JSON.stringify([p.id, t.id]));
  return UI.template`<label class="fast-pick small ${on ? 'danger' : ''}"><input type="checkbox" data-task-fast data-p="${esc(p.id)}" data-t="${esc(t.id)}" ${on ? 'checked' : ''} ${pending ? 'disabled' : ''}> <span>${on ? UI.text('加速ON（Fast）') : UI.text('加速（Fast）')}</span></label>`;
}

function syncTaskFastPickers() {
  if (!state) return;
  document.querySelectorAll('[data-task-fast]').forEach(el => {
    const t = taskOf(proj(el.dataset.p), el.dataset.t); if (!t) return;
    const pending = taskFastPending.has(JSON.stringify([el.dataset.p, el.dataset.t]));
    el.disabled = pending; if (!pending) el.checked = t.codexFast === true;
    const label = el.closest('.fast-pick');
    label.hidden = !state.acceleration?.codexAllowed;
    label.classList.toggle('danger', el.checked);
    label.querySelector('span').textContent = el.checked ? UI.text('加速ON（Fast）') : UI.text('加速（Fast）');
  });
  // 別端末で利用許可が変わった時も、入力欄を作り直さず選択欄だけ同期する。
  const box = $('#chat-fast-box');
  if (box && !box.querySelector('[data-task-fast]') && view.kind === 'work') {
    const p = proj(view.project), t = p && taskOf(p, view.task);
    if (t) box.innerHTML = taskFastSelect(p, t, $('#chat-ai')?.value.split('|')[0]);
  }
  document.querySelectorAll('[data-term-fast-box]').forEach(box => {
    const p = proj(box.dataset.p), t = p && taskOf(p, box.dataset.t);
    if (t && !box.querySelector('[data-task-fast]')) box.innerHTML = taskFastSelect(p, t, 'codex');
  });
}

async function saveTaskFast(el) {
  const { p: project, t: task } = el.dataset, key = JSON.stringify([project, task]);
  const previous = taskOf(proj(project), task)?.codexFast === true, on = el.checked;
  if (taskFastPending.has(key) || el.disabled) { el.checked = previous; return; }
  taskFastPending.add(key); taskFastSaving++; ++stateLoadEpoch;
  el.disabled = true; syncTaskFastPickers();
  try {
    const saved = await api('/api/acceleration/task', { project, task, on });
    const current = taskOf(proj(project), task); if (current) current.codexFast = saved.codexFast === true;
    toast(UI.template`この作業のCodexを加速${saved.codexFast ? 'ON' : 'OFF'}にしました（次の会話・起動から）`);
  } catch (err) { el.checked = previous; toast(err.message); }
  finally { ++stateLoadEpoch; taskFastPending.delete(key); taskFastSaving--; el.disabled = false; syncTaskFastPickers(); }
}

function drawChatAccount(p, t) {
  const box = $('#chat-account-box'); if (!box) return;
  t = taskOf(proj(p.id), t.id) || t;
  const ai = $('#chat-ai').value.split('|')[0];
  box.innerHTML = ['codex', 'claude', 'grok'].includes(ai) ? taskAccountSelect(p, t, ai, true) : '';
  const fastBox = $('#chat-fast-box'); if (fastBox) fastBox.innerHTML = taskFastSelect(p, t, ai);
}

function syncAccountPickers() {
  if (!state || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  const speed = $('#codex-fast');
  if (speed && state.acceleration && speed.dataset.saved !== String(state.acceleration.codexAllowed === true)) renderAcceleration(state.acceleration);
  syncTaskFastPickers();
  document.querySelectorAll('[data-task-account]').forEach(el => {
    const t = taskOf(proj(el.dataset.p), el.dataset.t), ai = el.dataset.ai;
    if (!t) return;
    const selected = t.accounts?.[ai] || 'default', rows = (state.accounts || []).filter(r => r.ai === ai);
    const key = JSON.stringify([selected, rows.map(r => [r.id, r.name])]);
    if (el.dataset.accountsKey !== key) { el.innerHTML = accountOptions(ai, selected); el.dataset.accountsKey = key; }
    el.value = selected;
    const label = el.closest?.('.account-pick'); if (label) label.hidden = rows.length < 2 && selected === 'default';
  });
  if (view.kind === 'work' && state.codexModelCatalogs) {
    const p = proj(view.project), t = p && taskOf(p, view.task);
    if (t) {
      const key = JSON.stringify([t.accounts?.codex || 'default', state.codexModelCatalogs, state.codexHiddenModels]);
      const select = $('#chat-ai');
      if (select && select.dataset.accountModelsKey !== key) { syncChatModelChoices(); select.dataset.accountModelsKey = key; }
      document.querySelectorAll('.spec[data-model-ai="codex"]').forEach(box => {
        if (box.dataset.accountModelsKey === key) return;
        box.outerHTML = specSelect(p,t,'codex',Boolean(sessOf(p.id,t.id,'codex')));
      });
      document.querySelectorAll('.spec[data-model-ai="codex"]').forEach(box => { box.dataset.accountModelsKey = key; });
    }
  }
  if (typeof usageContextChanged === 'function') usageContextChanged();
}

async function saveTaskAccount(el) {
  if (el.disabled) return;
  const { p: project, t: task, ai } = el.dataset, id = el.value;
  const t = taskOf(proj(project), task), previous = t?.accounts?.[ai] || 'default';
  const key = JSON.stringify([project, task, ai]);
  if (accountSelectionsPending.has(key)) { el.value = previous; toast(UI.text('アカウントの選択を保存中です')); return; }
  accountSelectionsPending.add(key);
  el.disabled = true; accountSelectionSaving++;
  stateLoadEpoch++;
  try {
    const r = await api('/api/accounts/select', { project, task, ai, id });
    // 他AIの保存応答は古い選択を含み得るので、保存したAIだけ反映する。
    const current = taskOf(proj(project), task);
    if (current) current.accounts = { ...current.accounts, [ai]: r.accounts[ai] };
    toast(UI.text('アカウントを選びました。作業中・順番待ちの指示は元のアカウントで続きます'));
    if (typeof usageContextChanged === 'function') usageContextChanged();
  } catch (e) { el.value = previous; toast(e.message); }
  finally {
    ++stateLoadEpoch; // 保存中に始まった取得も、完了後に選択を戻せない。
    accountSelectionsPending.delete(key); accountSelectionSaving--; el.disabled = false;
    syncAccountPickers();
  }
}

function shellWarningHtml() {
  if (!IN_APP) return '';
  if (shellRestartNeeded) return UI.template`<p role="status">アプリを終了して開き直してください</p>`;
  if (!state.appShell?.stale) return '';
  return UI.template`<p role="status">${state.appShell.appVersion ? UI.template`アプリ（Project Hub.app）が古い版 v${esc(state.appShell.appVersion)} です。ファイルの受け渡しなどの機能が動かない可能性があります` : UI.text('アプリ（Project Hub.app）の版を確認できません。ファイルの受け渡しなどの機能が動かない可能性があります')} <button class="btn plain sm" type="button" data-shell-rebuild ${shellRebuilding || state.appShell.rebuilding ? 'disabled' : ''}>${shellRebuilding || state.appShell.rebuilding ? UI.text('アプリを作り直しています') : UI.text('アプリを作り直す')}</button></p>`;
}

function drawShellAlerts() {
  const html = shellWarningHtml();
  for (const selector of ['#app-shell-alert', '#chatgpt-shell-alert']) {
    const box = $(selector); if (box) { box.hidden = !html; box.innerHTML = html; }
  }
}

function webchatUI() {
  if(!window.HubPaidWebchat || state.extensions && !state.extensions.included.includes('webchat'))return null;
  return webchatUIInstance ||= window.HubPaidWebchat.create(Object.freeze({
    UI,$,esc,api:(...args)=>api(...args),toast:(...args)=>toast(...args),taskOf,proj,preserveAiSettings,load:(...args)=>load(...args),chatModelOption,
    get state(){return state;},get view(){return view;},get epoch(){return stateLoadEpoch;},advanceEpoch:()=>++stateLoadEpoch,
  }));
}

function webchatReady(t){return webchatUI()?.ready(t)||false;}

function webchatNoticeHtml(t,selected){return webchatUI()?.notice(t,selected)||'';}

function webchatProgress(p,t){return webchatUI()?.progress(p,t)||'';}

function syncChatWebchatAvailability(){webchatUI()?.syncAvailability();}

function syncWebchatSettingsControls(){webchatUI()?.syncControls();}

function drawWebchatSettings(){webchatUI()?.draw();}

function loadWebchat(){return webchatUI()?.load();}

function webchatUIPending(){return webchatUI()?.pending()||false;}

function agyModelsHtml() {
  const models = state.agyModels || [], status = state.agyModelsState || 'unconfirmed';
  const message = status === 'failed' ? UI.text('モデル一覧の取得に失敗しました。前回の候補を表示しています。再取得するまで実行できません') : status === 'auth-required' ? UI.text('モデル一覧の取得にはログインが必要です') : !models.length ? UI.text('利用可能なモデルがありません。モデル一覧を再取得してください') : UI.text('会話またはTerminalのモデル欄で選んでください。別のモデルへ自動では切り替えません');
  return UI.template`<div class="agy-models"><b>利用可能なモデル</b><p class="small" role="status">${esc(message)}</p>${models.length ? UI.template`<ul>${models.map(row => UI.template`<li>${esc(row.label)} <code>${esc(row.id)}</code></li>`).join('')}</ul>` : ''}<button class="btn plain sm" type="button" data-agy-model-refresh ${agyModelsRefreshing ? 'disabled' : ''}>${agyModelsRefreshing ? UI.text('確認中…') : UI.text('モデル一覧を再取得')}</button></div>`;
}

let jevSettingsStatus = null, jevSettingsLoaded = false, jevSettingsBusy = false, jevSettingsError = '';
let jevKeyDialog = null;

function jevStatusText() {
  if (jevSettingsError) return jevSettingsError;
  if (!jevSettingsStatus) return '登録状態は未確認';
  if (!jevSettingsStatus.supported) return 'この環境では保護されたキー保管を利用できません';
  if (!jevSettingsStatus.registered) return 'キー未設定';
  if (jevSettingsStatus.connection === 'verified') {
    const time = new Date(jevSettingsStatus.checkedAt);
    return Number.isFinite(time.getTime()) ? `接続確認済み（${time.toLocaleString()}）` : '接続未確認';
  }
  if (jevSettingsStatus.connection === 'rejected') return 'キーが拒否されました';
  if (jevSettingsStatus.connection === 'unavailable') return '確認できません（通信）';
  return 'キー登録済み・接続未確認';
}

function drawJevStatus() {
  const status = $('#jev-status'); if (status) status.textContent = UI.text(jevStatusText());
  const save = $('#jev-register'); if (save) save.disabled = jevSettingsBusy || !jevSettingsStatus?.supported;
  const check = $('#jev-status-check'); if (check) check.disabled = jevSettingsBusy || !jevSettingsStatus?.registered;
  const toggle = $('#jev-search-enabled'); if (toggle) { toggle.checked = !!jevSettingsStatus?.search?.enabled; toggle.disabled = jevSettingsBusy || !jevSettingsStatus?.registered || !jevSettingsStatus?.search?.available; if (!jevSettingsBusy && jevSettingsStatus) localRecoveryEdits.delete(toggle); }
  const usage = $('#jev-search-usage'); if (usage) usage.textContent = UI.text(jevSearchUsageText());
}

async function loadJevSettings() {
  if (jevSettingsBusy) return;
  jevSettingsBusy = true; jevSettingsLoaded = true; drawJevStatus();
  try { jevSettingsStatus = await api('/api/jev', null, {'X-Hub':'1'}); jevSettingsError = ''; }
  catch { jevSettingsStatus = null; jevSettingsError = '登録状態を確認できません。再登録せず、保存先を確認してください。'; }
  finally { jevSettingsBusy = false; drawJevStatus(); }
}

async function verifyJevConnection() {
  if (jevSettingsBusy || !jevSettingsStatus?.registered) return;
  jevSettingsBusy = true; jevSettingsError = ''; drawJevStatus();
  try { Object.assign(jevSettingsStatus, await api('/api/jev/verify', {confirm:true})); }
  catch { jevSettingsStatus.connection = 'unavailable'; jevSettingsStatus.checkedAt = null; }
  finally { jevSettingsBusy = false; drawJevStatus(); }
}

function jevSearchUsageText() {
  const s = jevSettingsStatus?.search;
  if (!s?.available) return '利用回数の記録を確認できないため、並べ替えは使いません。';
  return `今月 ${s.requests} / 1000回・予約額 $${Number(s.reservedUSD).toFixed(6)} / $3.00（UTCの月初に更新）`;
}

async function configureJevSearch() {
  if (jevSettingsBusy || !jevSettingsStatus?.registered) return;
  const enabled = !!$('#jev-search-enabled')?.checked;
  jevSettingsBusy = true; jevSettingsError = ''; drawJevStatus();
  try { jevSettingsStatus = await api('/api/jev/search', {enabled, confirm:true}); }
  catch {
    jevSettingsStatus = null; jevSettingsLoaded = false;
    jevSettingsError = '利用設定の保存を確認できません。設定を開き直して確認してください。';
  } finally { jevSettingsBusy = false; drawJevStatus(); }
}

function openJevKeyDialog() {
  if (jevKeyDialog || jevSettingsBusy || !jevSettingsStatus?.supported) return;
  // Outside the periodically redrawn settings tree. Raw input lives only in
  // this password field and is never included in settings/draft snapshots.
  const dialog = document.createElement('dialog'); jevKeyDialog = dialog;
  dialog.className = 'onboarding-sheet'; dialog.setAttribute('aria-labelledby', 'jev-key-title');
  dialog.innerHTML = UI.template`<form id="jev-key-form" autocomplete="off"><h2 id="jev-key-title">Jevの接続用キーを登録</h2><p>公式サイトで取得したキーを、この端末の保護された保管先へ登録します。他のAIのログインとは別です。</p><p>登録だけでは接続しません。［接続状態を確認］を押すと、登録したキーで提供元へ1回接続します。登録済みの場合は、この端末のJev用キーを置き換えます。</p><label for="jev-key-input">接続用APIキー</label><input id="jev-key-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" minlength="16" maxlength="1024" required><p id="jev-key-notice" class="small" role="status"></p><div class="acts"><button class="btn" type="submit">この端末に登録</button><button id="jev-key-close" class="btn plain" type="button">閉じる</button></div></form>`;
  document.body.appendChild(dialog);
  const field = dialog.querySelector('#jev-key-input'), form = dialog.querySelector('form');
  const close = () => { field.value = ''; dialog.close(); dialog.remove(); jevKeyDialog = null; };
  dialog.querySelector('#jev-key-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (jevSettingsBusy) return;
    if (!/^[\x21-\x7e]{16,1024}$/.test(field.value)) {
      dialog.querySelector('#jev-key-notice').textContent = UI.text('キーの形式を確認してください。空白や改行は含められません。'); return;
    }
    jevSettingsBusy = true; drawJevStatus();
    const request = api('/api/jev/key', {key:field.value, confirm:true});
    field.value = ''; form.querySelector('button[type="submit"]').disabled = true;
    try { jevSettingsStatus = await request; jevSettingsError = ''; close(); }
    catch {
      jevSettingsStatus = null; jevSettingsLoaded = false;
      jevSettingsError = '登録の完了を確認できません。設定画面を開き直して登録状態を確認してください。';
      if (jevKeyDialog === dialog) close();
    } finally { jevSettingsBusy = false; drawJevStatus(); }
  });
  dialog.showModal(); field.focus();
}

function accountRowsWithStatus() {
  return (state.accounts || accountStatusRows || []).map(row => {
    const checked = accountStatusRows?.find(r => r.ai === row.ai && r.id === row.id);
    return checked ? { ...row, status: checked.status, email: checked.email, message: checked.message } : row;
  });
}
function accountHoldReason(row) {
  return UI.text(row.busyReason === 'unknown-process' ? '同じAIの処理のアカウントを確認できないため保留中です。［状態を確認］で再確認できます。' : row.busyReason === 'external-codex' ? 'Hub外のCodex（デスクトップアプリ等）が使用中です。終了してから操作してください。' : '作業中／順番待ちです。終了してから操作してください。');
}
function accountSettingsHtml() {
  const grokInstallReason = r => r.ai === 'grok' && r.status === 'not-installed' && r.message === 'Grok Build が未導入です';
  const rows = accountRowsWithStatus();
  const label = r => r.status === 'logged-in' ? UI.text('ログイン済み') : r.status === 'logged-out' ? UI.text('未ログイン') : r.status === 'api' ? UI.text('API認証（対象外）') : r.status === 'not-installed' ? UI.text('未導入') : UI.text('未確認');
  const agyFailed = ['failed', 'auth-required'].includes(state.agyModelsState) || !(state.agyModels || []).length;
  const agyReason = state.agyModelsState === 'failed' ? 'モデル一覧の取得に失敗しました。再取得するまで実行できません。' : state.agyModelsState === 'auth-required' ? 'モデル一覧の取得にはログインが必要です。' : '利用可能なモデルがありません。モデル一覧を再取得してください。';
  return UI.template`<section class="ai-use-section"><div class="ai-section-heading"><h3>アカウント</h3><button type="button" class="btn plain sm" data-account-action="status" ${accountOperation ? 'disabled' : ''}>状態を確認</button></div>
    <p id="account-message" class="small" role="status"></p>
    ${rows.map(r => UI.template`<div class="account-row" data-account-row data-auth-terminal="${r.authTerminal ? '1' : '0'}" data-ai="${esc(r.ai)}" data-id="${esc(r.id)}"><div class="ai-account-line"><b>${esc(r.ai === 'agy' ? 'Gemini（Agy）' : AI_LABEL[r.ai])}${r.id !== 'default' ? '・' + esc(UI.label(r.name)) : ''}</b><span class="ai-account-status small">${label(r)}</span><div class="ai-account-note small">${r.email ? UI.template`<span title="${esc(r.email)}">${esc(r.email)}</span>` : ''}${r.authTerminal ? UI.text(' 認証用Terminalを開いています') : r.busy ? UI.text(r.busyReason === 'unknown-process' ? ' 同じAIの処理のアカウントを確認できないため保留中' : r.busyReason === 'external-codex' ? ' Hub外のCodex（デスクトップアプリ等）が使用中' : ' 作業中／順番待ち') : ''}${grokInstallReason(r) ? UI.template`<span>${esc(UI.message(r.message))}</span>` : ''}
      ${r.ai === 'agy' ? UI.template`<details class="more" data-ai-fold="agy-${esc(r.id)}"><summary>モデル ${esc((state.agyModels || []).length)}件</summary>${agyModelsHtml()}</details>` : ''}
      ${r.id !== 'default' ? UI.template`<details class="more" data-ai-fold="edit-${esc(r.ai)}-${esc(r.id)}"><summary>編集</summary><div class="acts ai-detail-body"><input data-account-name maxlength="60" value="${esc(r.name)}" aria-label="${esc(UI.label(r.name))}の新しい名前"><button class="btn plain sm" type="button" data-account-action="rename" ${accountOperation ? 'disabled' : ''}>名前変更</button><button class="btn plain sm" type="button" data-account-action="delete" ${r.busy || accountOperation ? `disabled title="${esc(UI.text('終了してから操作してください'))}"` : ''}>削除（ゴミ箱へ）</button></div></details>` : ''}</div>
      <div class="acts">${r.ai === 'grok' && r.status === 'not-installed' ? UI.template`<details class="more" data-ai-fold="grok-install"><summary>導入方法</summary><p class="small ai-detail-body">MacのTerminalで <code>curl -fsSL https://x.ai/cli/install.sh | bash</code> を実行してください。Hubは実行しません。</p></details>` : UI.template`<button class="btn plain sm" type="button" data-account-action="${r.status === 'logged-in' || r.status === 'api' ? 'logout' : 'login'}" ${accountOperation ? 'disabled' : r.busy && !r.authTerminal ? `data-account-held="true" title="${esc(accountHoldReason(r))}"` : ''}>${r.status === 'logged-in' || r.status === 'api' ? UI.text('ログアウト') : UI.text('ログイン')}</button>`}</div></div>
      ${r.busy && !r.authTerminal && accountHoldNotices.has(r.ai + '/' + r.id) ? UI.template`<p class="small ai-account-message" data-account-hold-message role="status">${esc(accountHoldReason(r))}</p>` : ''}${r.message && !grokInstallReason(r) ? UI.template`<p class="small ai-account-message" role="status">${esc(UI.message(r.message))}</p>` : ''}${r.ai === 'agy' && agyFailed ? UI.template`<p class="small ai-account-message" role="status">${esc(UI.text(agyReason))}</p>` : ''}</div>`).join('')}
    <div class="account-row"><div class="ai-account-line"><b>Jev（TypeSafe AI）</b><span id="jev-status" class="ai-account-status small" role="status">${esc(UI.text(jevStatusText()))}</span><div class="ai-account-note small">会話検索の順位付けを補助するサービスです。キー登録とHubでの実利用は別です。AIの返答を自動で速くする機能ではありません。</div><div class="acts"><button id="jev-register" type="button" class="btn plain sm" ${jevSettingsBusy || !jevSettingsStatus?.supported ? 'disabled' : ''}>APIキーを登録</button><button id="jev-status-check" type="button" class="btn plain sm" ${jevSettingsBusy || !jevSettingsStatus?.registered ? 'disabled' : ''}>接続状態を確認</button></div></div><div class="ai-detail-body small"><label><input id="jev-search-enabled" type="checkbox" ${jevSettingsStatus?.search?.enabled ? 'checked' : ''} ${jevSettingsBusy || !jevSettingsStatus?.registered || !jevSettingsStatus?.search?.available ? 'disabled' : ''}>会話検索の並べ替えに使う</label><p id="jev-search-usage" role="status">${esc(UI.text(jevSearchUsageText()))}</p><p>オンにすると、検索した言葉と、上位候補のAIの返事から短い抜粋をJevへ送ります。人の発言・引用・秘密らしい文字列・画像・添付・自由会話は除外します。対象にできる候補の順位だけを変えます。</p><p>月1000回・3ドルまで。入力中の自動検索も、Jevへ送るたびに回数へ含めます。送信前に1回の最大費用を予約し、失敗しても予約は戻しません。上限や通信失敗時は今までどおりの検索に戻ります。検索の待ち時間は増えます。追加購入・自動チャージはしません。</p></div><details class="more" data-ai-fold="jev-install"><summary>接続設定について</summary><div class="ai-detail-body small"><p>公式サイトでログインしてキーを取得し、［APIキーを登録］でこの端末へ保存します。キーは再表示しません。Macはキーチェーン、Windowsは資格情報マネージャーと端末の保護機能を使います。</p><p>［接続状態を確認］を押した時だけ、キーが有効か提供元へ1回問い合わせます。会話の内容は送りません。確認に料金がかかる場合は支払い済み残高を使います。接続確認済みは確認時点でキーが有効という意味です。検索の並べ替えは、下のスイッチをオンにした時だけ使います。通常のAI送信には使いません。</p><p><a href="https://console.typesafe.ai/keys" target="_blank" rel="noopener noreferrer">公式ログイン・キー取得</a> ／ <a href="https://docs.typesafe.ai/introduction/quickstart" target="_blank" rel="noopener noreferrer">公式の導入案内</a></p></div></details></div>
    <div class="account-row ai-chatgpt-row">${webchatUI()?.slot() || ''}
      <details class="more ai-mcp-detail" data-ai-fold="mcp"><summary>MCP <span id="chatgpt-mcp-status" class="small" role="status">確認中…</span></summary><div class="ai-detail-body"><div id="chatgpt-box" aria-live="polite">確認中…</div>${chatgptConnectionHelpHtml()}</div></details>
      <div id="chatgpt-shell-alert">${shellWarningHtml()}</div></div>
    <details class="more ai-account-manage" data-ai-fold="account-manage"><summary>アカウントを追加・管理</summary><div class="acts ai-detail-body"><select id="account-new-ai" aria-label="追加するAI"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="grok">Grok</option><option value="agy" disabled>Gemini（Agy CLI）・既定のみ</option></select><input id="account-new-name" maxlength="60" placeholder="名前（例：仕事用）" aria-label="アカウント名"><button type="button" class="btn" data-account-action="add" ${accountOperation ? 'disabled' : ''}>追加</button></div><p class="small">作業ごとに使うアカウントを選べます。今のログインは「既定」です。追加アカウントは別の場所に保存します。別作業で別アカウントを選ぶと同時に使えます。ログインはMacのTerminalで本人が操作します。会話や認証情報はコピーしません。MCPなどの接続設定は追加先で設定してください。Gemini（Agy CLI）はログイン情報をMacのキーチェーンに1件だけ保存するため、既定のみです。ログアウトは開いたTerminalで /logout と入力してください。</p></details></section>`;
}

function drawAccountSettings() {
  const box = $('#ai-accounts'); if (!box || view.kind !== 'settings') return;
  preserveAiSettings(() => {
    if (typeof settingsLayoutRestoreSource === 'function') settingsLayoutRestoreSource('accounts');
    box.innerHTML = accountSettingsHtml();
    box.querySelectorAll('[data-account-action]').forEach(b => b.addEventListener('click', () => operateAccount(b)));
    $('#jev-register')?.addEventListener('click', openJevKeyDialog);
    $('#jev-status-check')?.addEventListener('click', verifyJevConnection);
    $('#jev-search-enabled')?.addEventListener('change', configureJevSearch);
    if (!jevSettingsLoaded) void loadJevSettings();
    loadChatgpt();
    drawWebchatSettings();
    if (state.webchat?.location && !state.webchat.check && !state.webchat.busy) loadWebchat();
    if (typeof settingsLayoutSync === 'function') settingsLayoutSync();
  });
}

async function operateAccount(button) {
  if (accountOperation || button.disabled) return;
  const action = button.dataset.accountAction, row = button.closest('[data-account-row]');
  const ai = row?.dataset.ai || $('#account-new-ai').value, id = row?.dataset.id || 'default';
  let existingTerminal = row?.dataset.authTerminal === '1' && ['login', 'logout'].includes(action);
  const body = { ai, id };
  if (action === 'add') body.name = $('#account-new-name').value;
  if (action === 'rename') body.name = row.querySelector('[data-account-name]').value;
  accountOperation = true; button.disabled = true;
  let notice = UI.text('処理中…');
  drawAccountSettings(); $('#account-message').textContent = notice;
  try {
    if (['login', 'logout'].includes(action) && !existingTerminal) {
      // A held button remains clickable so it can explain the current reason.
      // Never use the cached status check to authorize an authentication action.
      const latest = await api('/api/accounts'); state.accounts = latest.accounts;
      const current = state.accounts.find(r => r.ai === ai && r.id === id);
      if (!current) throw Error(UI.text('アカウントを確認できません。［状態を確認］を押してください。'));
      existingTerminal = !!current.authTerminal;
      if (current.busy && !existingTerminal) {
        accountHoldNotices.set(ai + '/' + id, true);
        notice = accountHoldReason(current);
        return;
      }
      accountHoldNotices.delete(ai + '/' + id);
    }
    if (existingTerminal) body.action = action;
    if (!existingTerminal && (action === 'logout' || action === 'delete')) {
      if (!confirm(action === 'logout' ? UI.text('このアカウントからログアウトしますか？') : UI.text('アカウントの保存場所をゴミ箱へ移しますか？ 会話と認証情報もその場所に含まれます。'))) { notice = ''; return; }
      body.confirm = true;
      if (id === 'default' && action === 'logout') {
        if (!confirm(UI.text('既定のログアウトは、Hub以外の同じCLIにも影響します。ログアウトしますか？'))) { notice = ''; return; }
        body.confirmDefault = true;
      }
    }
    const result = action === 'status' ? await checkRoleAccounts() : await api(existingTerminal ? '/api/accounts/terminal' : action === 'add' ? '/api/accounts' : '/api/accounts/' + action, body);
    if (action !== 'status' && !existingTerminal) { accountStatusRows = null; accountCheckedAt = ''; accountAutoChecked = false; const r = await api('/api/accounts'); state.accounts = r.accounts; }
    notice = result?.warning || (action === 'login' ? UI.text('Macで開いたTerminalでログインし、終わったら［状態を確認］を押してください。') : UI.text('完了しました'));
    if (typeof usageContextChanged === 'function') usageContextChanged();
  } catch (e) { notice = e.message; }
  finally {
    accountOperation = false; button.disabled = false;
    drawAccountSettings(); syncRoleAccountChoices();
    if (view.kind === 'settings' && $('#account-message')) $('#account-message').textContent = notice;
    if (notice) toast(notice);
  }
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2703() {
  return (e => {
  if (e.target.closest?.('[data-ai-data-location]')) { openDataLocation(); return; }
  if (e.target.closest?.('[data-ai-update-all]')) { void runAiUpdateAll(); return; }
  const ai = e.target.dataset.aiCheck || e.target.dataset.aiUpdate || e.target.dataset.aiModelRefresh;
  if (ai) runAiTool(ai, e.target.dataset.aiCheck ? 'check' : e.target.dataset.aiUpdate ? 'update' : 'models');
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2779() {
  return (e => {
  const b = e.target.closest('[data-mo-up],[data-mo-down],#model-order-reset');
  if (!b || b.disabled || modelViewSaving) return;
  if (b.id === 'model-order-reset') {
    if (confirm(UI.text('モデルの並びを元の順（AI ごと・取り直した順）に戻しますか？ 出す・隠すの設定はそのままです。'))) saveModelOrder([], '', true);
    return;
  }
  const id = b.dataset.moUp || b.dataset.moDown, ids = orderedModels(), i = ids.indexOf(id), j = i + (b.dataset.moUp ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i],ids[j]] = [ids[j],ids[i]]; saveModelOrder(ids, { id, direction: b.dataset.moUp ? 'up' : 'down' });
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2790() {
  return (e => {
  const grip = e.target.closest('[data-mo-grip]');
  if (!grip) return;
  if (modelViewSaving || window.matchMedia?.('(max-width:720px)').matches) { e.preventDefault(); return; }
  modelOrderDrag = grip.dataset.moGrip; e.dataTransfer.setData('text/plain', modelOrderDrag); e.dataTransfer.effectAllowed = 'move';
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2797() {
  return (e => {
  const row = e.target.closest('[data-mo-row]');
  if (!modelOrderDrag || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = 'move';
  clearModelDrop(); row.classList.add(e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'model-drop-before' : 'model-drop-after');
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2803() {
  return (e => {
  const row = e.target.closest('[data-mo-row]'), id = modelOrderDrag; modelOrderDrag = ''; clearModelDrop();
  if (!id || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); const before = orderedModels(), ids = before.filter(x => x !== id);
  const i = ids.indexOf(row.dataset.moRow); if (i < 0) return;
  const after = e.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  ids.splice(i + (after ? 1 : 0), 0, id);
  if (JSON.stringify(ids) !== JSON.stringify(before)) saveModelOrder(ids, id);
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2812() {
  return (() => { modelOrderDrag = ''; clearModelDrop(); });
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2829() {
  return (e => {
  if (!['special-mode-on', 'special-mode-ai'].includes(e.target.id)) return;
  saveSpecialMode({ enabled: $('#special-mode-on').checked, ai: $('#special-mode-ai').value });
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2868() {
  return (e => {
  const button = e.target.closest('[data-initial-reset]');
  if (button && !button.disabled) void saveInitialPick({ ...INITIAL_PICK });
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2942() {
  return (e => {
  if (e.target.dataset.phoneName) phoneLabelDrafts.set(e.target.dataset.phoneName, e.target.value);
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback2945() {
  return (e => {
  const el = e.target;
  if (el.disabled) return;
  if (el.dataset.phoneMode) void savePhoneLabels({ labels: el.dataset.phoneMode });
  if (el.dataset.phoneName) void savePhoneLabels({ key: el.dataset.phoneName, name: el.value });
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback3109() {
  return (async e => {
  const button = e.target.closest('[data-shell-rebuild]'); if (!button || button.disabled || shellRebuilding) return;
  shellRebuilding = true; drawShellAlerts();
  try {
    await api('/api/app/rebuild', {}); shellRestartNeeded = true;
    toast(UI.text('アプリを終了して開き直してください'));
  } catch (error) { toast(error.message); }
  finally { shellRebuilding = false; drawShellAlerts(); }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback3135() {
  return (e=>{rememberDisclosure(e.target);});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback3145() {
  return (async event => {
  const button = event.target.closest?.('[data-agy-model-refresh]');
  if (!button || button.disabled || agyModelsRefreshing) return;
  agyModelsRefreshing = true; drawAccountSettings();
  try {
    const checked = await api('/api/accounts?status=1&ai=agy', undefined, { 'X-Hub': '1' });
    adoptAgyCatalog(checked);
    accountStatusRows = [...(accountStatusRows || state.accounts || []).filter(row => row.ai !== 'agy'), ...checked.accounts];
    await refreshAiToolCatalog();
    const row = checked.accounts[0]; if (row?.message) toast(UI.message(row.message));
  } catch(error) { toast(error.message); }
  finally { agyModelsRefreshing = false; drawAccountSettings(); }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsAiCallback4358() {
  return (()=>{if(view.kind==='settings' && state.roles?.management?.review && !roleSettingsBusy)void pollState();});
}
