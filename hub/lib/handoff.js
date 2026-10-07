'use strict';
const { lt } = require('./locale');
// 子プロジェクトの結果を親プロジェクトへ渡す：親の「受け取る作業」の「やったこと」に1行書き、会話にも1行足して未読にする
// 同じ出来事（子・種類・文が同じ）は2回渡さない。渡した記録は _hub/handoff.json
const fs = require('fs');
const path = require('path');
const chat = require('./chat');
const { hash } = require('./completion');

const RECEIVE_TITLE = lt('子プロジェクトの結果');
const fileOf = root => path.join(root, '_hub', 'handoff.json');
function load(root) {
  try { const d = JSON.parse(fs.readFileSync(fileOf(root), 'utf8')); return { done: d.done && typeof d.done === 'object' ? d.done : {}, last: d.last && typeof d.last === 'object' ? d.last : {} }; }
  catch (e) { return { done: {}, last: {} }; }
}
function save(root, d) {
  const f = fileOf(root), tmp = `${f}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, f);
}

// 子：parent が id か名前と同じ、または derivedFrom が id と同じ
const isChild = (q, p) => q.id !== p.id && (q.parent === p.id || q.parent === p.name || q.derivedFrom === p.id);
const childrenOf = (p, all) => all.filter(q => isChild(q, p));
const isDone = p => p.status === '完了'; // 人が承認した完了だけ（承認前は readProject が「進行中」にする）
// 一覧用の数：{ プロジェクトID: { total, unfinished } }
function childCounts(all) {
  const out = {};
  for (const p of all) { const c = childrenOf(p, all); out[p.id] = { total: c.length, unfinished: c.filter(q => !isDone(q)).length }; }
  return out;
}
// 引渡し先：分岐は元、所属する子は親（id → 一意な名前）
function parentOf(child, all) {
  const byRef = ref => ref && (all.find(q => q.id === ref) || (all.filter(q => q.name === ref).length === 1 ? all.find(q => q.name === ref) : null));
  const p = byRef(child.derivedFrom) || byRef(child.parent);
  return p && p.id !== child.id ? p : null;
}

// 「やったこと」の最後の1項目（箇条書きなら最後の「- 」から終わりまで、無ければ最後の行）
function lastEntry(done) {
  const lines = String(done || '').split('\n').filter(l => l.trim());
  let i = lines.length - 1;
  while (i > 0 && !/^\s*([-*・]|\d+[.)])\s/.test(lines[i])) i--;
  if (i >= 0 && !/^\s*([-*・]|\d+[.)])\s/.test(lines[i])) i = lines.length - 1;
  return lines.slice(Math.max(0, i)).join('\n').replace(/^\s*[-*・]\s+/, '').trim();
}
// 一番新しい作業（やったことが書いてある物を優先）
const newestTask = p => p.tasks.find(t => String(t.done || '').trim()) || p.tasks[0] || null;
// 完了した時に渡す文：説明＋3行（作業の数・新しい作業・その最後のやったこと）
function completionText(child) {
  const t = newestTask(child), n = child.tasks.length, d = child.tasks.filter(x => x.state === '完了').length;
  return [child.description, lt`作業：全${n}件（完了${d}件）`, lt`最新の作業：${t ? t.title : lt('なし')}`, lt`やったこと：${(t && lastEntry(t.done)) || lt('なし')}`].filter(Boolean).join('\n');
}
// 親の画面で使う子の一覧
function childrenSummary(store, id) {
  const all = store.listProjects(), p = all.find(q => q.id === id);
  if (!p) return null;
  const { last } = load(store.root);
  const children = childrenOf(p, all).map(q => ({
    id: q.id, name: q.name, status: q.status, done: isDone(q),
    tasks: { total: q.tasks.length, done: q.tasks.filter(t => t.state === '完了').length, waiting: q.tasks.filter(t => t.state === '返事待ち' || t.completionPending).length },
    lastReport: last[q.id] ? { at: last[q.id].at, text: last[q.id].text } : null,
    question: (q.tasks.find(t => t.question) || {}).question || '',
  }));
  return { children, unfinished: children.filter(c => !c.done).length };
}

// opts: { record(action, b, extra), unread(project, task), emitRow(project, task, row) }
function reportToParent(store, childProject, { kind, text }, opts = {}) {
  const all = store.listProjects();
  const child = all.find(q => q.id === childProject.id) || childProject;
  const parent = parentOf(child, all);
  const body = String(text || '').trim();
  if (!parent || !body) return false;
  const d = load(store.root), key = hash(`${child.id}\u0000${kind}\u0000${body}`);
  if (d.done[key]) return { parent: d.done[key].parent, task: d.done[key].task, duplicate: true };
  // 受け取る作業：完了していない（完了確認待ちも除く）一番新しく更新された作業。無ければ作る
  let task = parent.tasks.find(t => t.state !== '完了' && !t.completionPending);
  if (!task) task = store.createTask(parent.id, { title: RECEIVE_TITLE, owner: 'claude-code' });
  if (!task) return false;
  const stamp = new Date(), z = n => String(n).padStart(2, '0');
  const at = `${stamp.getFullYear()}-${z(stamp.getMonth() + 1)}-${z(stamp.getDate())} ${z(stamp.getHours())}:${z(stamp.getMinutes())}`;
  store.appendSection(parent.id, task.id, 'やったこと', lt`- ${at} 子プロジェクト「${child.name}」${kind}：${body.replace(/\s*[\r\n]+\s*/g, ' / ')}`);
  const row = chat.append(parent.dir, task.id, { role: 'user', text: lt`（子プロジェクト「${child.name}」の${kind}）\n${body}`, from: 'child', child: child.id });
  if (opts.emitRow) opts.emitRow(parent.id, task.id, row);
  if (opts.unread) opts.unread(parent.id, task.id);
  d.done[key] = { at: row.at, parent: parent.id, task: task.id, child: child.id, kind };
  d.last[child.id] = { at: row.at, kind, text: body, parent: parent.id, task: task.id };
  save(store.root, d);
  if (opts.record) opts.record('childreport', { project: parent.id, task: task.id }, { child: child.id, kind });
  return { parent: parent.id, task: task.id, duplicate: false };
}

module.exports = { reportToParent, childrenOf, childCounts, childrenSummary, parentOf, completionText, lastEntry, newestTask, RECEIVE_TITLE };
