'use strict';
(() => {
  const template = document.querySelector('#conversation-search-template'); if (!template) return;
  const panel = template.content.firstElementChild.cloneNode(true);
  const form = document.querySelector('#conversation-search-sidebar-template').content.firstElementChild.cloneNode(true);
  // Template contents are inert during locale.js's initial document scan.
  form.innerHTML = UI.html(form.innerHTML);
  form.setAttribute('aria-label', UI.text(form.getAttribute('aria-label')));
  const el = id => panel.querySelector('#conversation-search-' + id) || form.querySelector('#conversation-search-' + id), text = x => UI.text(x);
  let epoch = 0, timer, poll, job = '', running = false, next = null, terms = [], detailEpoch = 0, composing = false;
  let resultMode = 'simple', previousView, resultsScroll = 0, hasResults = false, lastSummary = '', treeFree, treeProjects, focus = null;
  const MISSING = 'この発言は今の会話に見つかりません。検索結果の［発言と前後を読む］で読めます';
  // Same visible text as the search worker: message text plus question/options.
  const visible = row => [typeof row?.text === 'string' ? row.text : '', ...(Array.isArray(row?.asks) ? row.asks : []).flatMap(a => [typeof a?.question === 'string' ? a.question : '', ...(Array.isArray(a?.options) ? a.options.filter(x => typeof x === 'string') : [])])].filter(Boolean).join('\n');
  const same = (row, want) => row && row.role === want.role && String(row.at || '') === String(want.at || '') && visible(row).slice(0, 200) === String(want.text || '').slice(0, 200);
  function highlightNode(node, container) {
    node.classList.add('search-focus'); node.tabIndex = -1;
    node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
    // Pin the chat reader to this message so later reflow does not jump to the bottom.
    if (container && window.HubChatScroll?.change) window.HubChatScroll.change(container, () => {});
    setTimeout(() => node.classList.remove('search-focus'), 4000);
  }
  const active = version => version === epoch && view.kind === 'search';
  const notice = value => { el('status').textContent = value; };
  const request = async (route, body) => {
    const r = await fetch('/api/conversation-search' + route, { method: body ? 'POST' : 'GET', headers: { 'X-Hub': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json(); if (!r.ok) throw Error(data.error || text('検索できませんでした。')); return data;
  };
  function scope() {
    el('scope').textContent = text(resultMode === 'simple' ? '簡易検索：現在保存されている会話のみ。正式保管した過去会話は調べません。' : '詳細検索：現在の会話と、検証できる正式保管の過去会話。') + ' ' + el('query').value;
  }
  function show() {
    if (view.kind !== 'search') { previousView = { ...view }; view = { kind: 'search', project: view.project, task: null }; render(); }
  }
  function stop() {
    epoch++; detailEpoch++; clearTimeout(timer); clearTimeout(poll);
    if (running && job) void request('/cancel', { id: job }).catch(() => {});
    running = false; el('stop').hidden = true;
  }
  function mount() {
    const main = document.querySelector('#main');
    if (panel.parentNode !== main) { main.replaceChildren(panel); el('results').scrollTop = resultsScroll; }
  }
  window.HubConversationSearch = {
    treeRender(free, projects) {
      const list = document.querySelector('#list');
      if (!treeFree || treeFree.parentNode !== list) {
        treeFree = document.createElement('div'); treeProjects = document.createElement('div');
        list.replaceChildren(form, treeFree, treeProjects);
      }
      treeFree.innerHTML = free; treeProjects.innerHTML = projects; return true;
    },
    beforeRender() {
      if (panel.isConnected && view.kind !== 'search') {
        if (!el('results').hidden) resultsScroll = el('results').scrollTop;
        el('context').hidden = true; el('results').hidden = false;
        panel.remove();
        if (running) { stop(); notice(text('検索を中断しました。検索ボタンで再開してください。')); }
        else { detailEpoch++; clearTimeout(timer); if (hasResults) notice(lastSummary); }
      }
    },
    mount,
    // Called by the chat after a work conversation's rows are drawn.
    focusRows(project, task, box, rows) {
      const f = focus;
      if (!f || f.archiveId || f.project !== project || f.task !== task) return;
      focus = null; if (Date.now() > f.until) return;
      let index = same(rows[f.row], f) ? f.row : rows.findIndex(r => same(r, f));
      if (index < 0) { toast(text(MISSING)); return; }
      // Map by order among messages with the same time and role (data-at/data-role on .m).
      const ordinal = rows.slice(0, index).filter(r => r.role === f.role && String(r.at || '') === String(f.at || '')).length;
      const nodes = [...box.querySelectorAll('.m[data-role]')].filter(n => n.dataset.role === f.role && n.dataset.at === String(f.at || ''));
      const node = nodes[ordinal];
      if (!node) { toast(text(MISSING)); return; }
      highlightNode(node, box);
    },
    afterRender() {
      if (view.kind === 'search' || !hasResults) return;
      const header = document.querySelector('#main .whead, #main .ph');
      if (header && !header.querySelector('[data-search-return]')) {
        const back = document.createElement('button'); back.type = 'button'; back.className = 'btn plain sm'; back.dataset.searchReturn = '1'; back.textContent = text('← 検索結果へ戻る'); back.addEventListener('click', show); header.append(back);
      }
    },
  };
  function highlight(node, value) {
    // Keep combining marks with their base (e.g. halfwidth ｶﾞ); map back to original text.
    let normalized = '', offsets = [];
    const segments = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value) : Array.from(value.matchAll(/[\s\S]/gu), m => ({ segment: m[0], index: m.index }));
    for (const { segment, index } of segments) { const n = segment.normalize('NFKC').toLowerCase(); normalized += n; for (let i = 0; i < n.length; i++) offsets.push([index, index + segment.length]); }
    const ranges = [];
    for (const term of terms) { let i = 0; while (term && (i = normalized.indexOf(term, i)) >= 0) { ranges.push([offsets[i][0], offsets[i + term.length - 1][1]]); i += term.length; } }
    ranges.sort((a, b) => a[0] - b[0]); const merged = [];
    for (const range of ranges) { const prev = merged.at(-1); if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]); else merged.push(range); }
    let end = 0; for (const [a, b] of merged) { node.append(document.createTextNode(value.slice(end, a))); const mark = document.createElement('mark'); mark.textContent = value.slice(a, b); node.append(mark); end = b; } node.append(document.createTextNode(value.slice(end)));
  }
  function results(data, append) {
    if (!append) el('list').replaceChildren();
    for (const hit of data.hits) {
      const card = document.createElement('article'); card.className = 'conversation-search-card';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'conversation-search-hit';
      const title = document.createElement('strong'); title.textContent = hit.projectName + ' ／ ' + hit.taskName;
      const meta = document.createElement('small'); meta.textContent = [hit.at || text('日時なし'), text(hit.archiveId ? '過去の会話' : '現在の会話'), text(hit.role === 'user' ? '人' : 'AI'), text(hit.score === 3 ? '一致候補：語句一致' : hit.score === 2 ? '一致候補：全語一致' : '関連候補：一部の語が一致') + ' (' + hit.matched + '/' + hit.words + ')'].join(' · ');
      const snippet = document.createElement('span'); highlight(snippet, hit.snippet); button.append(title, meta, snippet);
      button.addEventListener('click', () => void go(hit)); card.append(button);
      const actions = document.createElement('div'); actions.className = 'row';
      for (const [label, fn] of [['該当作業・話題を開く', () => go(hit)], ['発言と前後を読む', () => showContext(hit)]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn plain sm'; b.textContent = text(label); b.addEventListener('click', fn); actions.append(b);
      }
      card.append(actions); el('list').append(card);
    }
    next = data.next; el('more').hidden = next === null; el('more').disabled = false;
  }
  function summary(data) {
    const s = data.stats;
    return text(data.total ? '候補' : '一致する候補はありません') + (data.total ? ' ' + data.total + text('件') : '') + ' ／ ' + s.sources + text('ファイルを確認') +
      (s.limited ? text('。上限に達したため全範囲ではありません。検索語を絞ってください。') : '') +
      (s.skipped || s.skippedRows ? text('。読取・検証できない範囲：') + (s.skipped || 0) + text('ファイル、') + (s.skippedRows || 0) + text('行（未検索）') : '');
  }
  async function page(version, offset = 0, delay = 50) {
    const id = job, mode = resultMode;
    try {
      const data = await request('?' + new URLSearchParams({ id, offset })); if (!active(version) || data.mode !== mode) return;
      // Fast local searches often finish just after the first GET. Check once
      // promptly, then back off to the existing cadence for longer searches.
      if (data.status === 'running') { notice(text('検索中…') + ' ' + (data.stats.sources || 0) + text('ファイルを確認（全範囲は未完了）')); poll = setTimeout(() => page(version, offset, Math.min(delay * 2, 300)), delay); return; }
      running = false; el('stop').hidden = true;
      if (data.status !== 'done') { notice(text('検索を完了できませんでした。結果は未確定です。検索語を絞って、もう一度検索してください。')); return; }
      results(data, offset > 0); lastSummary = summary(data); notice(lastSummary); hasResults = true;
    } catch (e) { if (active(version)) { stop(); notice(UI.message(e.message)); el('more').disabled = false; } }
  }
  async function start() {
    if (composing) return;
    stop(); const version = epoch, query = el('query').value.trim(); job = ''; next = null; hasResults = false;
    resultMode = el('mode').value; scope(); show();
    el('list').replaceChildren(); el('more').hidden = true; el('context').hidden = true; el('results').hidden = false; resultsScroll = 0;
    if (!query) { notice(text('検索語を入力してください。')); return; }
    terms = [...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean))];
    running = true; el('stop').hidden = false; notice(text('検索中…（全範囲は未完了）'));
    try { const data = await request('', { query, mode: resultMode }); if (!active(version) || data.mode !== resultMode) { void request('/cancel', { id: data.id }).catch(() => {}); return; } job = data.id; await page(version); }
    catch (e) { if (active(version)) { running = false; el('stop').hidden = true; notice(UI.message(e.message)); } }
  }
  async function go(hit) {
    const version = epoch, serial = ++detailEpoch, id = job;
    notice(text('移動先を確認しています…'));
    try {
      // Revalidate the original hit, then refresh destination metadata. Never infer a new ID.
      const data = await request('/context?' + new URLSearchParams({ id, hit: hit.id }));
      if (!active(version) || serial !== detailEpoch || data.mode !== resultMode) return;
      const latest = await fetchState();
      if (!active(version) || serial !== detailEpoch) return;
      if (latest) adoptState(latest);
      const dest = data.target, p = proj(dest.project), t = taskOf(p, dest.task);
      if (!p || !t || (p.kind === 'freetalk') !== dest.freetalk) throw Error(text('移動先が見つからないか、移行されています。検索し直してください。'));
      open.add('g:' + (dest.freetalk ? 'freetalk' : 'projects'));
      el('context').hidden = true; el('results').hidden = false;
      notice(lastSummary);
      // Both the card and the button open the conversation at the matched message.
      const row = (data.rows || []).find(r => r.target);
      focus = row ? { project: p.id, task: t.id, archiveId: hit.archiveId || '', row: hit.row, role: row.role, at: row.at, text: row.text, until: Date.now() + 20000 } : null;
      if (!dest.freetalk) { try { localStorage.setItem('hub-mode', 'chat'); } catch { /* 無視 */ } }
      navigateView({ kind: 'work', project: p.id, task: t.id }, true);
      if (focus?.archiveId) {
        const f = focus; focus = null;
        const shown = await window.HubTaskHistory?.openArchiveAt(f.project, f.task, f.archiveId, f.row, r => same(r, f), node => highlightNode(node)).catch(() => false);
        if (!shown) toast(text(MISSING));
      }
    } catch (e) { if (active(version) && serial === detailEpoch) notice(UI.message(e.message)); }
  }
  async function showContext(hit) {
    const version = epoch, serial = ++detailEpoch; resultsScroll = el('results').scrollTop;
    el('results').hidden = true; el('context').hidden = false; el('rows').textContent = text('発言を読み込んでいます…');
    el('location').textContent = hit.projectName + ' ／ ' + hit.taskName + ' ／ ' + text(hit.archiveId ? '過去の会話' : '現在の会話');
    try {
      const data = await request('/context?' + new URLSearchParams({ id: job, hit: hit.id })); if (!active(version) || serial !== detailEpoch || data.mode !== resultMode) return;
      el('rows').replaceChildren(); let target;
      for (const row of data.rows) {
        const article = document.createElement('article'), heading = document.createElement('strong'), pre = document.createElement('pre');
        heading.textContent = text(row.role === 'user' ? '人' : 'AI') + ' · ' + (row.at || text('日時なし')); highlight(pre, row.text); article.append(heading, pre);
        if (row.truncated) { const note = document.createElement('p'); note.textContent = text('長い発言のため10万字まで表示しています。'); article.append(note); }
        if (row.target) { article.className = 'conversation-search-target'; article.tabIndex = -1; target = article; } el('rows').append(article);
      }
      target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true });
    } catch (e) { if (active(version) && serial === detailEpoch) el('rows').textContent = UI.message(e.message); }
  }
  function back() { detailEpoch++; el('context').hidden = true; el('results').hidden = false; el('results').scrollTop = resultsScroll; }
  el('close').addEventListener('click', () => {
    if (!previousView || !proj(previousView.project) || previousView.kind === 'work' && !taskOf(proj(previousView.project), previousView.task)) { notice(text('前の画面が見つかりません。左の一覧から選んでください。')); return; }
    navigateView(previousView);
  });
  form.addEventListener('submit', e => { e.preventDefault(); if (!composing) { void start(); closeDrawer(); } });
  el('query').addEventListener('compositionstart', () => { composing = true; stop(); });
  el('query').addEventListener('input', e => { stop(); if (e.isComposing || composing) return; timer = setTimeout(start, 350); });
  el('query').addEventListener('compositionend', () => { composing = false; clearTimeout(timer); timer = setTimeout(start, 350); });
  el('mode').addEventListener('change', () => { void start(); });
  el('stop').addEventListener('click', () => { stop(); notice(text('検索を中断しました。検索ボタンで再開してください。')); });
  el('more').addEventListener('click', () => { if (next !== null) { el('more').disabled = true; void page(epoch, next); } });
  el('back').addEventListener('click', back);
  scope(); renderTree(); if (view.kind === 'search') render();
})();
