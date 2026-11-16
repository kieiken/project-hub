'use strict';
// Settings presentation only. Original controls are moved, never cloned. Portal
// bookmarks restore dynamic controls to their source before those are redrawn.
// No fetches, server settings, launch flags, or startup side effects live here.

function settingsLayoutCurrent() {
  const current = mountSettingsLayout.current;
  return current?.root.isConnected ? current : null;
}

function settingsLayoutTabs() {
  return ['basic', 'ai', 'recovery', 'connect', 'manage'];
}

function mountSettingsLayout() {
  const previous = mountSettingsLayout.current;
  previous?.observer?.disconnect();
  const presentation = previous ? {
    query: previous.search.querySelector('input').value,
    previousTab: previous.previousTab,
    folds: Object.fromEntries(Object.entries(previous.folds).map(([key, node]) => [key, previous.searchOpen.get(node) ?? node.open])),
    detailStates: previous.detailStates,
  } : null;
  const root = document.querySelector('#main .settings');
  // Older focused test fixtures intentionally have no DOM implementation.
  if (!root?.prepend || typeof document.createElement !== 'function') return;
  const c = { root, portals: {}, panels: {}, folds: {}, entries: [], buttons: [...root.querySelectorAll('[data-settings-tab]')], query: '', previousTab: '', searchOpen: new Map(), detailStates: new Map() };
  mountSettingsLayout.current = c;
  buildSettingsLayout(c);
  if (presentation) {
    for (const [key, open] of Object.entries(presentation.folds)) c.folds[key].open = open;
    c.search.querySelector('input').value = presentation.query;
    if (presentation.query.trim()) {
      c.detailStates = new Map(presentation.detailStates);
      settingsLayoutRememberSearchDetails(c);
      c.query = presentation.query.trim().toLocaleLowerCase();
      c.previousTab = presentation.previousTab;
    }
    settingsLayoutFilter(c);
  }
}

function settingsLayoutMove(c, node, parent, portal) {
  if (!node || !parent) return;
  if (portal) {
    const marker = document.createComment('settings-layout-position');
    node.before(marker);
    (c.portals[portal] ||= []).push({ node, marker });
  }
  parent.append(node);
}

function settingsLayoutRestoreSource(source) {
  const c = settingsLayoutCurrent();
  if (!c) return;
  for (const { node, marker } of (c.portals[source] || []).reverse()) {
    if (marker.parentNode) marker.replaceWith(node); else node.remove();
  }
  c.portals[source] = [];
}

function buildSettingsLayout(c) {
  c.root.classList.add('settings-layout-v2');
  c.labels = { basic: UI.text('見た目'), ai: UI.text('AI'), recovery: UI.text('安全'), connect: UI.text('つなぐ'), manage: UI.text('更新と記録') };
  const original = [...c.root.querySelectorAll(':scope > section[data-tab]')];
  const section = selector => c.root.querySelector(selector)?.closest('section.pref-section');
  const row = selector => c.root.querySelector(selector)?.closest('.pref-row');
  const tabs = c.root.querySelector('.settings-tabs');
  for (const key of settingsLayoutTabs()) tabs.append(c.buttons.find(b => b.dataset.settingsTab === key));
  const create = (tag, className, parent) => { const node = document.createElement(tag); node.className = className; parent.append(node); return node; };
  c.search = create('div', 'settings-layout-search', c.root);
  c.search.innerHTML = `<label for="settings-layout-query">${esc(UI.text('設定を探す'))}</label><div><input id="settings-layout-query" type="search" placeholder="${esc(UI.text('項目名や説明で検索'))}" autocomplete="off"><button type="button" class="btn plain">${esc(UI.text('検索を消す'))}</button></div><p class="small" role="status" aria-live="polite"></p>`;
  tabs.before(c.search);
  for (const key of settingsLayoutTabs()) {
    const panel = create('div', 'settings-layout-panel', c.root);
    panel.dataset.layoutTab = key;
    panel.id = 'settings-layout-panel-' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'settings-layout-tab-' + key);
    c.panels[key] = panel;
    if (key !== 'basic') {
      const status = create('div', 'settings-layout-status', panel);
      status.dataset.layoutStatus = key;
      status.setAttribute('aria-label', UI.text('いまの状態'));
    } else {
      const sample = create('div', 'settings-layout-theme', panel);
      sample.innerHTML = `<span class="settings-layout-swatch" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(UI.text('いまの配色'))}</span>`;
    }
    const fold = create('details', 'settings-layout-more', panel);
    fold.append(document.createElement('summary'));
    c.folds[key] = fold;
  }
  const add = (node, key, advanced = false, title = '') => {
    if (!node || c.entries.some(entry => entry.node === node)) return;
    const parent = advanced ? c.folds[key] : c.panels[key];
    settingsLayoutMove(c, node, parent);
    if (!advanced) parent.insertBefore(node, c.folds[key]);
    node.hidden = false;
    c.entries.push({ node, key, advanced, title });
  };
  const split = (node, title, key, advanced = false) => {
    if (!node) return;
    const wrapper = document.createElement('section'); wrapper.className = 'pref-section';
    const heading = document.createElement('h2'); heading.className = 'pref-caption'; heading.textContent = UI.text(title);
    heading.hidden = node.querySelector('h3')?.textContent.trim() === heading.textContent;
    const list = document.createElement('div'); list.className = 'pref-list'; wrapper.append(heading, list);
    c.root.append(wrapper);
    settingsLayoutMove(c, node, list);
    add(wrapper, key, advanced, title);
    return wrapper;
  };
  split(row('[data-theme-choice]'), '配色', 'basic');
  split(row('#language-box'), '言語', 'basic');
  add(section('#set-work-progress'), 'basic');
  split(row('#initial-pick'), '新しく始めるときのAI', 'ai');
  add(section('#set-detail'), 'basic');
  add(section('#roles-save'), 'ai');
  split(row('#special-mode'), '特殊モード', 'ai', true);
  add(section('#ai-accounts'), 'ai');
  split(row('#climodels'), '上級：CLIに渡すモデル名', 'ai', true);
  add(section('#model-order-list'), 'ai');
  add(section('#ai-tools'), 'ai');
  add(section('#token-usage-box'), 'ai');
  for (const selector of ['#acceleration', '#skills-box']) add(section(selector), 'ai', true);
  c.mcp = split(document.createElement('div'), 'MCP', 'ai', true);
  c.language = split(document.createElement('div'), '言語パックの追加', 'basic', true);
  // Emergency stop precedes the read-only permission summary.
  add(section('#emergency-status'), 'recovery');
  const emergency = section('#emergency-status');
  if (emergency) c.panels.recovery.prepend(emergency);
  c.workPermissions = split(document.createElement('div'), '作業ごとの許可・導入・復旧', 'recovery');
  c.workPermissions.classList.add('settings-layout-permits');
  c.workPermissions.querySelector('.pref-list').firstElementChild.textContent = UI.text('Muse連携の確認結果に応じて、作業ごとの既存の操作をここに表示します。');
  add(section('[data-act="emptyscan"]'), 'recovery');
  split(row('[data-act="emptyscan"]'), '空の作業を片付ける', 'manage');
  add(section('#phone-labels'), 'connect');
  add(section('#github-box'), 'connect');
  add(section('#muse-settings-box'), 'connect', true);
  // Mac / Windows sections have no IDs. Identify by their original position and
  // invariant controls, rather than translated headings or text matching.
  const connection = original.filter(el => el.dataset.tab === 'connect');
  add(connection.find(el => !el.querySelector('#remote-box,#muse-settings-box,#github-box')), 'recovery', true);
  add(original.find(el => el.dataset.tab === 'basic' && !el.querySelector('.pref-list')), 'recovery', true);
  add(section('#app-update-box'), 'manage');
  add(section('#logd'), 'manage');
  add(section('#license-form') || original.find(el => el.dataset.tab === 'basic' && el.querySelector('[role="status"].pref-name')), 'manage', true);
  const intro = section('[data-onboarding-open]');
  split(row('[data-onboarding-open]'), 'はじめの設定', 'manage', true);
  split(row('#move-export'), '引っ越し', 'manage', true);
  add(intro, 'manage', true);
  // Keep any extension/edition-specific sections, including ones absent from the
  // mockup. They remain reachable instead of silently disappearing.
  for (const node of original) if (!c.entries.some(entry => entry.node === node)) add(node, node.dataset.tab, true);
  for (const [key, selectors] of Object.entries({ ai: ['#ai-tools', '#roles-save', '#ai-accounts', '#token-usage-box'], manage: ['#app-update-box', '#logd', '[data-act="emptyscan"]'] })) {
    for (const selector of selectors) {
      const entry = c.entries.find(e => e.key === key && !e.advanced && e.node.querySelector(selector));
      if (entry) c.panels[key].insertBefore(entry.node, c.folds[key]);
    }
  }
  // Keep frequent actions ahead of the login summary and first-use preferences.
  const aiPanel = c.panels.ai;
  aiPanel.insertBefore(aiPanel.querySelector('[data-layout-status]'), c.folds.ai);
  c.start = create('div', 'settings-layout-start', aiPanel);
  c.start.setAttribute('role', 'group');
  c.start.setAttribute('aria-labelledby', 'settings-layout-start-title');
  const startTitle = create('h2', 'pref-caption', c.start);
  startTitle.id = 'settings-layout-start-title';
  startTitle.textContent = UI.text('使い始めの設定');
  for (const selector of ['#initial-pick', '#model-order-list']) {
    const entry = c.entries.find(e => e.key === 'ai' && e.node.querySelector(selector));
    if (entry) c.start.append(entry.node);
  }
  aiPanel.insertBefore(c.start, c.folds.ai);
  c.search.querySelector('input').addEventListener('input', () => settingsLayoutSearch(c));
  c.search.querySelector('button').addEventListener('click', () => { const field = c.search.querySelector('input'); field.value = ''; settingsLayoutSearch(c); field.focus(); });
  c.observer = new MutationObserver(records => {
    if (records.every(record => record.target.closest?.('.settings-layout-status,.settings-tabs,.settings-layout-search,.settings-layout-more > summary'))) return;
    settingsLayoutSync();
  });
  c.observer.observe(c.root, { childList: true, characterData: true, subtree: true });
  c.onChange = () => settingsLayoutSync();
  c.root.addEventListener('change', c.onChange);
  settingsLayoutSync();
}

function settingsLayoutSync() {
  const c = settingsLayoutCurrent();
  if (!c) return;
  const portal = (source, nodes, target) => {
    if ((c.portals[source] || []).length || !nodes.length) return;
    for (const node of nodes) settingsLayoutMove(c, node, target, source);
  };
  portal('accounts', [...c.root.querySelectorAll('#ai-accounts .ai-mcp-detail')], c.mcp.querySelector('.pref-list'));
  portal('language', [...c.root.querySelectorAll('#language-box > details')], c.language.querySelector('.pref-list'));
  const permits = c.root.querySelector('#muse-settings-box #muse-workspace-context');
  if (permits && !c.portals.muse?.length) {
    const first = permits.closest('label')?.previousElementSibling;
    const end = c.root.querySelector('#muse-workspace-permits');
    const nodes = [];
    if (first && end && first.parentElement === end.parentElement) {
      for (let node = first; node; node = node.nextSibling) { nodes.push(node); if (node === end) break; }
      portal('muse', nodes, c.workPermissions.querySelector('.pref-list'));
    }
  }
  c.workPermissions.querySelector('.pref-list').firstElementChild.hidden = Boolean(c.portals.muse?.length);
  c.workPermissions.querySelector('.pref-caption').hidden = Boolean(c.portals.muse?.length);
  settingsLayoutStatus(c);
  settingsLayoutFilter(c);
}

function selectSettingsLayoutTab(tab) {
  const c = settingsLayoutCurrent();
  if (!c) return false;
  settingsTab = Object.hasOwn(c.labels, tab) ? tab : 'basic';
  // Keep the existing selected-tab preference and tab IDs.
  for (const [key, panel] of Object.entries(c.panels)) panel.hidden = key !== settingsTab;
  settingsLayoutStatus(c);
  settingsLayoutFilter(c);
  return true;
}

function settingsLayoutSearch(c) {
  const query = c.search.querySelector('input').value.trim().toLocaleLowerCase();
  if (!c.query && query) {
    c.previousTab = settingsTab;
    settingsLayoutRememberSearchDetails(c);
  }
  c.query = query;
  if (!query) {
    for (const [details, open] of c.searchOpen) if (details.isConnected) details.open = open;
    c.searchOpen.clear();
    c.detailStates.clear();
    const tab = c.previousTab || settingsTab; c.previousTab = '';
    selectSettingsTab(tab, true);
  } else {
    const matches = settingsLayoutMatches(c);
    if (matches.length && !matches.some(entry => entry.key === settingsTab)) selectSettingsTab(matches[0].key, true);
    else { settingsLayoutStatus(c); settingsLayoutFilter(c); }
  }
}

// A dynamic account/language redraw replaces details nodes. Stable keys keep
// search's temporary expansion from becoming their new ordinary open state.
function settingsLayoutRememberSearchDetails(c) {
  for (const node of c.root.querySelectorAll('details')) {
    const fold = Object.keys(c.folds).find(key => c.folds[key] === node);
    const entry = c.entries.find(item => item.node.contains(node));
    const key = fold ? 'fold:' + fold : node.id ? 'id:' + node.id : node.dataset.aiFold ? 'ai:' + node.dataset.aiFold : entry ? 'entry:' + c.entries.indexOf(entry) + ':' + [...entry.node.querySelectorAll('details')].indexOf(node) : null;
    if (!c.searchOpen.has(node)) {
      if (key && !c.detailStates.has(key)) c.detailStates.set(key, node.open);
      c.searchOpen.set(node, key ? c.detailStates.get(key) : node.open);
    }
  }
}

function settingsLayoutMatches(c) {
  return c.entries.filter(entry => {
    if (entry.node === c.workPermissions && !c.portals.muse?.length) return false;
    if (!c.query) return true;
    const text = [UI.text(entry.title), c.start.contains(entry.node) ? c.start.firstElementChild.textContent : '', ...[...entry.node.querySelectorAll('.pref-caption,.pref-text,.pref-name,.pref-desc,h3,summary')].map(el => el.textContent)].join(' ');
    return text.toLocaleLowerCase().includes(c.query);
  });
}

function settingsLayoutFilter(c) {
  if (c.query) settingsLayoutRememberSearchDetails(c);
  const matches = settingsLayoutMatches(c), matched = new Set(matches);
  for (const entry of c.entries) {
    entry.node.hidden = !matched.has(entry);
    if (c.query && matched.has(entry)) for (const details of entry.node.querySelectorAll('details')) details.open = true;
  }
  c.start.hidden = !matches.some(entry => c.start.contains(entry.node));
  for (const [key, fold] of Object.entries(c.folds)) {
    const entries = matches.filter(entry => entry.key === key && entry.advanced);
    fold.hidden = !entries.length;
    const summary = UI.text('詳しい設定') + '（' + entries.length + ' ' + UI.text('項目') + '）';
    if (fold.firstElementChild.textContent !== summary) fold.firstElementChild.textContent = summary;
    if (c.query && entries.length) fold.open = true;
    c.panels[key].querySelector('.settings-layout-status,.settings-layout-theme')?.toggleAttribute('hidden', Boolean(c.query));
  }
  const message = c.query ? (matches.length ? UI.text('見つかった項目') + '：' + matches.length : UI.text('見つかりません。別の言葉で探してください。')) : UI.text('項目名と説明から探します。');
  const notice = c.search.querySelector('[role="status"]');
  if (notice.textContent !== message) notice.textContent = message;
  for (const button of c.buttons) {
    const count = matches.filter(entry => entry.key === button.dataset.settingsTab).length;
    button.dataset.matchCount = c.query ? String(count) : '';
    button.title = c.query ? UI.text('見つかった項目') + '：' + count : '';
  }
}

function settingsLayoutPermission(ai, raw) {
  const defaults = {
    'claude-code': 'claude --dangerously-skip-permissions',
    codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  };
  // Match server permCmd() before normalizing whitespace for comparison only.
  const configured = typeof raw === 'string' && /^(claude|codex)\b/.test(raw);
  const command = configured ? raw : defaults[ai];
  const isDefault = command.trim().replace(/\s+/g, ' ') === defaults[ai];
  let text = UI.text(isDefault
    ? ai === 'claude-code' ? '許可確認を省いて動きます。' : '許可確認とサンドボックスを省いて動きます。'
    : '独自の起動設定です。確認のしかたは下の設定値を確かめてください。');
  if (!configured) text += '\n' + UI.text('（設定が空のため既定を使っています）');
  return { tone: 'hold', text, command };
}

function settingsLayoutStatus(c) {
  const cards = { ai: [], recovery: [], connect: [], manage: [] };
  const card = (key, label, tone, text, action = '') => cards[key].push({ label, tone, text, action });
  const rows = typeof accountRowsWithStatus === 'function' ? accountRowsWithStatus() : [];
  for (const ai of ['claude', 'codex', 'agy', ...(rows.some(row => row.ai === 'grok') ? ['grok'] : [])]) {
    const accounts = rows.filter(row => row.ai === ai);
    const ready = accounts.some(row => row.status === 'logged-in');
    const busy = (state.sessions || []).some(s => s.running && (s.ai === ai || s.owner === ai)) || (state.chatting || []).some(s => (s.ai || s.owner) === ai);
    const needsLogin = !ready && accounts.some(row => row.status === 'logged-out');
    const notInstalled = !ready && accounts.some(row => row.status === 'not-installed');
    const tone = needsLogin ? 'bad' : busy ? 'run' : ready ? 'ok' : 'hold';
    card('ai', ai === 'agy' ? 'Gemini（Agy CLI）' : AI_LABEL[ai], tone,
      UI.text(needsLogin ? '未ログイン' : busy ? 'AIが作業中です' : ready ? 'ログイン済み' : notInstalled ? '未導入' : '未確認'),
      needsLogin ? UI.text('ログインする') : !ready ? UI.text('アカウントを確認') : '');
  }
  for (const [ai, label] of [['claude-code', 'Claude Code'], ['codex', 'Codex']]) {
    const raw = state.roles?.permissions?.[ai];
    const permission = settingsLayoutPermission(ai, raw);
    card('recovery', label, permission.tone, permission.text + '\n' + permission.command);
  }
  const remote = c.root.querySelector('#remote-on');
  card('connect', UI.text('外から使う（iPhone）'), remote?.checked ? 'hold' : remote ? 'ok' : 'hold', UI.text(remote?.checked ? '外からの接続を許可しています。中継の稼働は未確認です。' : remote ? '外からの接続は停止中です。' : '接続状態は未確認です。'));
  const update = typeof appUpdateData !== 'undefined' ? appUpdateData : null;
  const updateSummary = appUpdateSummary(update || { currentVersion: state.version, latestVersion: state.latest });
  card('manage', UI.text('Project Hub の更新'), updateSummary.tone, UI.text(updateSummary.text));
  for (const [key, items] of Object.entries(cards)) {
    const target = c.panels[key].querySelector('[data-layout-status]');
    const html = items.map(item => `<div class="settings-layout-card" data-tone="${item.tone}"><strong>${esc(item.label)}</strong><span>${esc(item.text)}</span>${item.action ? `<button class="btn plain sm" type="button" data-layout-account>${esc(item.action)}</button>` : ''}</div>`).join('');
    if (target.innerHTML !== html) {
      target.innerHTML = html;
      target.querySelectorAll('[data-layout-account]').forEach(button => button.addEventListener('click', () => {
        const entry = c.entries.find(e => e.node.id === 'ai-use-settings');
        if (c.query) { c.search.querySelector('input').value = ''; settingsLayoutSearch(c); }
        selectSettingsTab('ai');
        if (entry) { entry.node.scrollIntoView({ block: 'start' }); entry.node.querySelector('button')?.focus({ preventScroll: true }); }
      }));
    }
  }
  const rank = { ok: 0, hold: 1, run: 2, bad: 3 };
  for (const button of c.buttons) {
    const key = button.dataset.settingsTab, label = c.labels[key];
    const tone = (cards[key] || []).reduce((worst, item) => rank[item.tone] > rank[worst] ? item.tone : worst, 'ok');
    const status = UI.text({ bad: 'あなたの番', run: 'AIが動いている', hold: '注意・未確認', ok: '問題なし' }[tone]);
    const dirty = key === 'ai' && rolesDirty();
    const html = `${esc(label)}${tone === 'ok' ? '' : `<i class="settings-layout-dot" data-tone="${tone}" aria-hidden="true"></i>`}${dirty ? ' •' : ''}`;
    if (button.innerHTML !== html) button.innerHTML = html;
    button.id = 'settings-layout-tab-' + key;
    button.setAttribute('aria-controls', c.panels[key].id);
    button.setAttribute('aria-selected', String(key === settingsTab));
    button.setAttribute('aria-label', label + '：' + status + (dirty ? UI.text(' 未保存あり') : ''));
    button.tabIndex = key === settingsTab ? 0 : -1;
  }
}
