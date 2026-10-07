 'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// 右クリックと、キーボードで押せる「…」は同じ操作を開く。
function showTreeMenu(pId, tId, x, y) {
  const p = proj(pId), t = tId && taskOf(p, tId); if (!p || tId && !t) return;
  const menu = $('#menu');
  // 表示した操作の意図を保持し、定期取得後も同じ before で競合を照合する。
  const pinBefore = !t && isProjectPinned(p.id);
  menu.innerHTML = UI.template`<button type="button" data-tree-action="rename" role="menuitem">名前の変更</button><button type="button" data-tree-action="branch" role="menuitem">同じ階層に分岐</button><button type="button" data-tree-action="child" role="menuitem">さらに子${t ? '作業' : UI.text('プロジェクト')}を作る</button><button class="danger" type="button" data-tree-action="remove" role="menuitem">削除…</button>`;
  if (!t && canReorderProjects()) {
    const siblings = projectSiblings(displayParent(p, state.projects)), index = siblings.findIndex(q => q.id === p.id);
    const pinned = pinBefore;
    menu.innerHTML += UI.template`<button type="button" data-tree-action="pin" role="menuitem" ${projectOrderBusy ? 'disabled' : ''}>${pinned ? UI.text('固定を解除') : UI.text('上部に固定')}</button>`;
    menu.innerHTML += UI.template`<button type="button" data-tree-action="up" role="menuitem" ${index <= 0 || isProjectPinned(siblings[index - 1]?.id) !== pinned || projectOrderBusy ? 'disabled' : ''}>上へ移動</button><button type="button" data-tree-action="down" role="menuitem" ${index >= siblings.length - 1 || isProjectPinned(siblings[index + 1]?.id) !== pinned || projectOrderBusy ? 'disabled' : ''}>下へ移動</button>`;
  }
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button').focus();
  menu.onclick = async e => {
    const b = e.target.closest('[data-tree-action]'); if (!b || b.disabled) return;
    menu.hidden = true;
    const action = b.dataset.treeAction;
    try {
      if (action === 'pin') { await saveProjectPin(p.id, pinBefore); return; }
      if (action === 'up' || action === 'down') {
        const parent = displayParent(p, state.projects), before = projectSiblings(parent).map(q => q.id), i = before.indexOf(p.id);
        const target = before[i + (action === 'up' ? -1 : 1)];
        if (target && isProjectPinned(target) === isProjectPinned(p.id)) await saveProjectOrder(parent, before, ProjectOrder.moved(before, p.id, target, action === 'down'));
        return;
      }
      if(action==='remove') {await showRemoval(p.id,t?.id);return;}
      if (action === 'rename') {
        const name = prompt(UI.text('新しい名前（場所・作業IDは変わりません）'), t ? t.title : p.name);
        if (name === null || name === (t ? t.title : p.name)) return;
        await api('/api/hierarchy/rename', { project: p.id, task: t?.id, name, expectedHash: (t || p).completionHash });
        await load(); toast(UI.text('名前を変更しました'));
      } else if (t) {
        const title = prompt(action === 'child' ? UI.text('子作業の名前') : UI.text('派生する作業の名前'), nextName(t.title, p.tasks.map(x => x.title))); if (!title?.trim()) return;
        // 子作業・分岐は設定の初期AIを使い、親の役割と階層は保持する。
        const pick = initialPick();
        const initialAI = { owner: AI_KEY[pick.ai], model: pick.model, effort: pick.effort };
        const created = await api('/api/task/new', { project: p.id, title, parent: action === 'child' ? t.id : t.parent || '', kind: action==='branch' ? 'derived' : 'main', derivedFrom: action==='branch' ? `${p.id}/${t.id}` : '', ...initialAI, phase: t.phase, role: t.role });
        view = { kind: 'work', project: p.id, task: created.id }; save(); await load();
      } else {
        newProjectPreset = { parent: action === 'child' ? p.id : displayParent(p, state.projects), derivedFrom: action === 'branch' ? p.id : '', name: nextName(p.name, state.projects.map(x => x.name)) };
        view = { kind: 'newproject', project: p.id, task: null }; newRefs = []; save(); render();
        $('#np-parent').closest('details').open = true;
        $('#np-name').focus();
      }
    } catch (err) { toast(err.message); }
  };
}
document.addEventListener('contextmenu', e => {
  const node = e.target.closest('#list .node[data-p]'); if (!node) return;
  e.preventDefault(); showTreeMenu(node.dataset.p, node.dataset.t, e.clientX, e.clientY);
});
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-tree-menu]'); if (!btn) return;
  const r = btn.getBoundingClientRect(); showTreeMenu(btn.dataset.p, btn.dataset.t, r.left, r.bottom + 6);
});

let projectDrag = null, projectOrderBusy = false, projectClickUntil = 0;
async function saveProjectPin(project, before) {
  if (projectOrderBusy) return;
  projectOrderBusy = true;
  try {
    await api('/api/hierarchy/pin', { project, before, pinned: !before });
    await load(); toast(before ? UI.text('固定を解除しました') : UI.text('上部に固定しました'));
  } catch (err) { toast(err.message); }
  finally { projectOrderBusy = false; }
}
function clearProjectDrop() {
  document.querySelectorAll('.project-drop-before,.project-drop-after').forEach(node => node.classList.remove('project-drop-before', 'project-drop-after'));
}
async function saveProjectOrder(parent, before, order) {
  if (projectOrderBusy || !canReorderProjects() || JSON.stringify(before) === JSON.stringify(order)) return;
  projectOrderBusy = true;
  try {
    await api('/api/hierarchy/order', { parent, before, order });
    await load(); toast(UI.text('並び順を保存しました'));
  } catch (err) { toast(err.message); }
  finally { projectOrderBusy = false; }
}
document.addEventListener('dragstart', e => {
  const node = e.target.closest?.('#list .node.p[data-p]'); if (!node) return;
  if (!canDragProjects() || projectOrderBusy) { e.preventDefault(); return; }
  const p = proj(node.dataset.p), parent = displayParent(p, state.projects);
  projectDrag = { from: p.id, parent, before: projectSiblings(parent).map(q => q.id) };
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-hub-project', p.id);
  projectClickUntil = Date.now() + 500;
}, true);
function projectDropTarget(e) {
  const node = e.target.closest?.('#list .node.p[data-p]'), p = node && proj(node.dataset.p);
  if (!p || isProjectPinned(p.id) !== isProjectPinned(projectDrag.from) || p.id === projectDrag.from || !projectDrag.before.includes(p.id) || displayParent(p, state.projects) !== projectDrag.parent) return null;
  const r = node.getBoundingClientRect();
  return { node, id: p.id, after: e.clientY >= r.top + r.height / 2 };
}
document.addEventListener('dragover', e => {
  if (!projectDrag) return;
  e.preventDefault(); e.stopImmediatePropagation(); clearProjectDrop();
  const target = projectDropTarget(e);
  e.dataTransfer.dropEffect = target ? 'move' : 'none';
  if (target) target.node.classList.add(target.after ? 'project-drop-after' : 'project-drop-before');
  const list = $('#list'), r = list.getBoundingClientRect();
  if (e.clientY < r.top + 30) list.scrollTop -= 15;
  else if (e.clientY > r.bottom - 30) list.scrollTop += 15;
}, true);
document.addEventListener('drop', e => {
  if (!projectDrag) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const target = projectDropTarget(e), drag = projectDrag;
  projectDrag = null; clearProjectDrop(); projectClickUntil = Date.now() + 350;
  if (target) void saveProjectOrder(drag.parent, drag.before, ProjectOrder.moved(drag.before, drag.from, target.id, target.after));
}, true);
document.addEventListener('dragend', () => {
  if (!projectDrag) return;
  projectDrag = null; clearProjectDrop(); projectClickUntil = Date.now() + 350;
}, true);
document.addEventListener('dragleave', e => { if (projectDrag && !e.target.contains?.(e.relatedTarget)) clearProjectDrop(); }, true);
document.addEventListener('click', e => {
  if (Date.now() < projectClickUntil && e.target.closest?.('#list')) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
