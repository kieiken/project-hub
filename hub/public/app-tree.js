'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function showInTree() {
  const key = [view.kind, view.project, view.task].join('/');
  if (key === shownKey) return;
  shownKey = key;
  let p = proj(view.project);
  if (!p) return;
  if (view.task) { const all = treeTasks(p); for (let t = all.find(x => x.id === view.task), n = 0; t && t.parent && n < 20; n++) { open.add(`t:${p.id}/${t.parent}`); t = all.find(x => x.id === t.parent); } }
  for (let n = 0; p && n < 20; n++) { open.add(p.id); p = p.parent ? state.projects.find(x => x.id === p.parent || x.name === p.parent) : null; }
  save();
}

function childrenProjects(parent) {
  return state.projects.filter(p => (p.parent || '') === parent || (parent && proj(parent) && p.parent === proj(parent).name));
}

function childrenOf(p) { return state.projects.filter(q => q.id !== p.id && (q.parent === p.id || q.parent === p.name || q.derivedFrom === p.id)); }

function displayParent(item, all) {
  return ProjectOrder.displayParent(item, all);
}

function orderedChildren(p) {
  const children = childrenOf(p), result = children.slice(), groups = new Map();
  children.forEach((q, i) => { const parent = displayParent(q, state.projects); if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push(i); });
  for (const [parent, slots] of groups) {
    const ordered = projectSiblings(parent).filter(q => children.some(c => c.id === q.id));
    slots.forEach((slot, i) => { result[slot] = ordered[i]; });
  }
  return result;
}

function treeMenuButton(p, t) {
  return UI.template`<button class="tree-menu" data-tree-menu="1" data-p="${esc(p.id)}" ${t ? `data-t="${esc(t.id)}"` : ''} type="button" aria-label="${esc(t ? t.title : p.name)}の操作" title="名前の変更・分岐・子を作成">⋯</button>`;
}

function markRead(pid, tid) {
  if (!isUnread(pid, tid)) return;
  state.unread = state.unread.filter(u => !(u.project === pid && u.task === tid));
  api('/api/task/read', { project: pid, task: tid }).catch(() => {});
}

function notificationBadges(p, tasks, count = false) {
  const unread = tasks.filter(t => isUnread(p.id, t.id)).length;
  const kinds = tasks.map(t => notificationKind(p, t));
  const reply = kinds.filter(k => k === 'reply').length;
  const work = kinds.filter(k => k === 'work').length;
  const done = kinds.filter(k => k === 'done').length;
  const results = kinds.filter(k => k === 'results').length;
  const badge = (n, kind, label, tip) => n ? UI.template`<span class="notice ${kind}" title="${tip}">${label}${count ? ' ' + n : ''}</span>` : '';
  const html = badge(unread, 'notice-unread', UI.text('未読'), UI.text('まだ開いていないAIの結果です。作業の会話を開くと消えます'))
    + badge(reply, 'notice-reply', UI.text('返事待ち'), UI.text('質問への返事・停止の対処・AIへの入力が必要です'))
    + badge(work, 'notice-work', !count && tasks.length === 1 && tasks[0].resultsPending ? resultsNotice(p, tasks[0]).label : UI.text('作業中'), UI.text('AI・成果確認・成果整理が動いている、または指示が順番待ちです'))
    + badge(results, 'notice-results', UI.text('成果確認'), UI.text('成果の記録に確認が必要です。質問への返事待ちではありません'))
    + badge(done, 'notice-confirm', UI.text('完了'), UI.text('完了に移すか、まだ続けるかを選んでください'));
  return html ? UI.template`<span class="notifications">${html}</span>` : '';
}

function githubCreateButton(p) {
  const reason = state.github?.ready ? '' : state.github?.error || UI.text('GitHubのログインを設定画面で確認してください');
  return UI.template`${p.github || p.githubHasOrigin ? '' : UI.template`<button class="btn plain" data-github-create="${esc(p.id)}" type="button" ${reason ? 'disabled' : ''} title="${esc(reason || UI.text('非公開リポジトリを作る'))}">GitHubに作る（非公開）</button>`}<button class="btn plain" data-github-connect="${esc(p.id)}" data-github-target="${esc(p.github?.target || '.')}" type="button" ${reason ? 'disabled' : ''}>既存のGitHubに接続</button>${reason || p.githubTargetError ? UI.template`<span class="small">${esc(reason || p.githubTargetError)}</span>` : ''}`;
}

function githubUrl(p, t) {
  const g = (t && t.github) || p.github;
  if (!g || !g.url) return '';
  return g.branch && !['main', 'master', 'HEAD'].includes(g.branch) ? `${g.url}/tree/${encodeURIComponent(g.branch)}` : g.url;
}

function treeTasks(p) { return ProjectOrder.taskItems(p); }

function taskTarget(p,t) { return ProjectOrder.taskTarget(p,taskOf(proj(p.id),t.id)||t,state.projects); }

function branchText(p,t) {
  const src = taskTarget(p,t); return t.kind === 'derived' ? UI.template`⑂ 分岐：${src ? src.task.title : t.derivedFrom || UI.text('元が不明')}から` : '';
}

function taskTree(p, parentId) {
  const all = treeTasks(proj(p.id)||p).filter(x=>p.tasks.some(t=>t.id===x.id)), kids = ProjectOrder.nearSources(all.filter(t => displayParent(t, all) === (parentId || '')).map(t=>({...t, derivedFrom:t.kind==='derived' ? (taskTarget(p,t)?.task.id || t.derivedFrom) : ''})));
  if (!kids.length) return '';
  return kids.map(t => {
    const isLive = live(p.id, t.id) || bgOf(p.id, t.id).length > 0;
    const sub = taskTree(p, t.id);
    const tk = `t:${p.id}/${t.id}`;
    const hot = all.some(x => x.parent === t.id && (notificationKind(p, x) || isUnread(p.id, x.id))); // 作業中・返事待ち・新がある子は見せる
    const tOpen = open.has(tk) || hot;
    return UI.template`<div class="tree-line"><button class="node t ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">
        <span class="caret" ${sub ? `data-toggle="${esc(tk)}"` : ''}>${sub ? (tOpen ? '▼' : '▶') : ''}</span><span class="sdot ${taskLight(p, t, isLive).cls}" title="${taskLight(p, t, isLive).tip}"></span>
        ${t.parent && t.kind !== 'derived' ? UI.html('<span class="fork" title="子作業（小作業）">↳</span>') : ''}<span class="nm">${esc(t.title)}${taskFutureHeld(p,t)?UI.template`<small class="branch-label">将来検討</small>`:''}${branchText(p,t) ? UI.template`<small class="branch-label">${esc(branchText(p,t))}</small>` : ''}</span>${notificationBadges(p, [t])}</button>${treeMenuButton(p, t)}</div>
      ${sub && tOpen ? UI.template`<div class="kids">${sub}</div>` : ''}`;
  }).join('');
}

function projectLight(p) {
  if (p.status === '完了') return { cls: 'pl-fin', tip: '完了' };
  const working = state.sessions.some(s => s.project === p.id && s.running) || (state.chatting || []).some(c => c.project === p.id) || bgOf(p.id).length;
  if (working) return { cls: 'pl-work', tip: UI.text('AI が作業中') };
  if (p.tasks.some(t => t.state && t.state !== '未着手')) return { cls: 'pl-rest', tip: UI.text('処理が終わりました（完了にするまで続けられます）') };
  return { cls: 'pl-new', tip: UI.text('まだ始めていません') };
}

function taskLight(p, t, isLive) {
  const kind = notificationKind(p, t);
  if (kind === 'reply' && t.chatQueueHeld) return { cls: 'wait', tip: WORKING(p,t) ? UI.text('AIや成果整理は作業中です。停止前の指示は保留中です') : UI.text('停止前の指示は保留中です。自動では始まりません') };
  if (kind === 'reply') return { cls: 'wait', tip: UI.text('返事待ち：質問への返事や停止の対処が必要です') };
  if (kind === 'results') return { cls: 'wait', tip: UI.text('成果確認：成果の記録を確認してください。質問への返事は不要です') };
  if (kind === 'work' && t.resultsPending) return { cls: 'pl-work', tip: resultsNotice(p,t).text };
  if (kind === 'work' || isLive) return { cls: 'pl-work', tip: UI.text('AIや成果整理が動いている、または指示が順番待ちです') };
  if (kind === 'done') return { cls: 'confirm', tip: UI.text('完了：完了に移すか、まだ続けるかを選んでください') };
  if (t.state === '停止') return { cls: 'wait', tip: UI.text('停止中です') };
  if (t.state === '完了') return { cls: 'pl-fin', tip: '完了' };
  if (!t.state || t.state === '未着手') return { cls: 'pl-new', tip: UI.text('まだ始めていません') };
  return { cls: 'pl-rest', tip: UI.text('処理が終わりました') };
}

function projectNode(p, depth) {
  const isOpen = open.has(p.id);
  const subs = projectSiblings(p.id);
  const forks = state.projects.filter(q=>ProjectOrder.source(q,state.projects)?.id===p.id).length;
  const visible = new Set(p.tasks.filter(t => t.state !== '完了' || isUnread(p.id,t.id)).map(t=>t.id));
  const full = treeTasks(p);
  for(const t of full.filter(x=>visible.has(x.id))) {
    let parent=t.parent;const seen=new Set([t.id]);
    while(parent&&!seen.has(parent)){seen.add(parent);const x=full.find(x=>x.id===parent);if(!x)break;visible.add(x.id);parent=x.parent;}
  }
  const tasks = p.tasks.filter(t=>visible.has(t.id));
  return UI.template`<div class="tree-line${depth === 0 ? ' project-root' : ''}"><button class="node p ${view.kind === 'project' && view.project === p.id ? 'sel' : ''}" data-go="project" data-p="${esc(p.id)}" type="button" ${canDragProjects() ? 'draggable="true"' : ''}>
      ${canDragProjects() ? UI.html('<span class="project-grip" aria-hidden="true" title="ドラッグで並べ替え（同じ階層の中だけ）">⋮⋮</span>') : ''}
      <span class="caret" data-toggle="${esc(p.id)}">${tasks.length || subs.length ? (isOpen ? '▼' : '▶') : ''}</span>
      <span class="sdot ${projectLight(p).cls}" title="${projectLight(p).tip}"></span>
      ${isProjectPinned(p.id) ? UI.html('<span class="project-pin" title="上部に固定中" aria-label="上部に固定中">📌</span>') : ''}${p.parent && !p.derivedFrom ? UI.html('<span class="fork" title="子プロジェクト">↳</span>') : ''}<span class="nm">${esc(p.name)}${p.derivedFrom ? UI.template`<small class="branch-label">⑂ 分岐：${esc(ProjectOrder.source(p,state.projects)?.name || p.derivedFrom)}から</small>` : ''}</span>
      ${forks ? UI.template`<span class="fork" title="分岐の数">分岐${forks}</span>` : ''}
      ${p.phases.length ? UI.template`<span class="phn" title="終わったフェーズ ${phaseInfo(p).done} / ${p.phases.length}">${ring(phaseInfo(p).done, p.phases.length)}</span>` : ''}${notificationBadges(p, p.tasks, true)}</button>${treeMenuButton(p)}</div>
    ${isOpen ? UI.template`<div class="kids">${taskTree({ ...p, tasks }, '')}${subs.map(s => projectNode(s, depth + 1)).join('')}</div>` : ''}`;
}

function treeKey() {
  return JSON.stringify([state.freetalk, state.projects, state.projectOrder, state.projectPins, state.unread, state.sessions.map(waitingKey), state.chatting, state.background, state.webchat?.jobs, view.kind, view.project, view.task, [...open]]);
}

function mainKey() {
  const p = proj(view.project);
  const common = [view.kind, view.project, view.task, state.root, state.freetalk, state.terminal, state.roles, state.efforts, state.cliFlags, state.agyModels, state.agyModelsState, state.agyAvailable, state.completionWarning, state.modelOrder, state.hiddenModels, state.specialMode];
  if (view.kind === 'work') {
    const sessions = workMode() === 'term' ? state.sessions.filter(s => s.project === view.project && s.task === view.task).map(s => [s.ai, s.running]) : [];
    return JSON.stringify([...common, p && p.name, p && p.phases, taskOf(p, view.task), sessions]);
  }
  if (view.kind === 'project') return JSON.stringify([...common, p, state.github, state.projectOrder, state.projectPins, state.projects.map(x => [x.id, x.name]), state.sessions.filter(s => s.project === view.project).map(waitingKey), state.chatting, state.background, state.webchat?.jobs]);
  if (view.kind === 'turn') return JSON.stringify([...common, state.projects, state.sessions.map(waitingKey), state.chatting, state.background, state.webchat?.jobs]);
  return JSON.stringify([...common, state.projects]);
}

function freetalkTopics(p) {
  return p.tasks.map(t => UI.template`<div class="freetalk-row ${notificationKind(p, t) === 'reply' ? 'waiting' : WORKING(p, t) ? 'running' : ''} ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}"><button class="freetalk-topic" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">${esc(t.title)}${(state.unread || []).some(x => x.project === p.id && x.task === t.id) ? ' ●' : ''}</button><button class="freetalk-del" data-act="freetalkdelete" data-t="${esc(t.id)}" type="button" aria-label="この話題を削除" title="この話題を削除">×</button></div>`).join('');
}

function sidebarGroup(name, label, content, action = '') {
  const expanded = open.has('g:' + name), id = 'sidebar-' + name;
  return UI.template`<section class="sidebar-group"><div class="sidebar-group-header"><button class="sidebar-group-toggle" id="${id}-toggle" data-toggle="g:${name}" data-sidebar-group="${name}" type="button" aria-expanded="${expanded}" aria-controls="${id}-content"><span aria-hidden="true">${expanded ? '▼' : '▶'}</span> ${label}</button>${action}</div><div class="sidebar-group-body" id="${id}-content" ${expanded ? '' : 'hidden'}>${content}</div></section>`;
}

function freetalkFrame() {
  const p = state.projects.find(x => x.kind === 'freetalk');
  return sidebarGroup('freetalk', 'freetalk', UI.template`<div class="freetalk-frame" aria-label="freetalk 自由対話"><button class="newp freetalk-new" type="button" data-act="freetalknew" ${state.freetalk?.ready ? '' : 'disabled'}>＋ 新しい話題</button>${state.freetalk?.reason ? UI.template`<p class="note" role="status">${esc(state.freetalk.reason)}</p>` : ''}${p ? freetalkTopics(p) : ''}</div>`, UI.template`<button class="btn plain sm freetalk-overview-link" type="button" data-go="project" data-p="freetalk" ${p ? '' : 'disabled'}>全体を見る</button>`);
}

function renderTree() {
  const roots = projectSiblings('');
  const free = freetalkFrame(), projects = sidebarGroup('projects', UI.text('プロジェクト'), UI.template`<button class="newp ${view.kind === 'newproject' ? 'sel' : ''}" data-go="newproject" type="button">＋ 新しいプロジェクト</button><div class="tree">${roots.map(p => projectNode(p, 0)).join('')}</div>`);
  if (!window.HubConversationSearch?.treeRender(free, projects)) $('#list').innerHTML = UI.template`${free}${projects}`;
  renderedTreeKey = treeKey();
  syncFreetalkAttachmentControls();
}

function updateTurnCounts() {
  const items = state.projects.flatMap(p => p.tasks.map(t => ({ p, t })));
  const kinds = items.map(({ p, t }) => notificationKind(p, t));
  const replies = kinds.filter(k => k === 'reply').length;
  const working = kinds.filter(k => k === 'work').length;
  const confirmations = kinds.filter(k => k === 'done').length;
  const results = kinds.filter(k => k === 'results').length;
  $('#turn-n').textContent = UI.text('返事待ち ') + replies;
  $('#turn-work-n').textContent = UI.text('作業中 ') + working;
  $('#turn-results-n').textContent = UI.text('成果確認 ') + results;
  $('#turn-done-n').textContent = UI.text('完了 ') + confirmations;
  $('#turn').setAttribute('aria-label', UI.template`あなたの番：返事待ち ${replies}件、作業中 ${working}件、成果確認 ${results}件、完了 ${confirmations}件`);
}
