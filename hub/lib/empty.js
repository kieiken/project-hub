'use strict';
const { lt } = require('./locale');
// 中身の無い作業・子プロジェクトを探して、ゴミ箱へまとめて移す（AI が勝手に作った物の片付け）
// 中身が無い＝Hub の会話が空・作業用コピーが無い・動いていない。やったことに記録がある物は候補に出すが、最初は選ばない
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const chat = require('./chat');

const talked = (pdir, task) => chat.read(pdir, task).some(r => (r.role === 'user' || r.role === 'assistant') && r.text);
const hasFiles = dir => { try { return fs.readdirSync(dir).some(n => !n.startsWith('.') && (fs.statSync(path.join(dir, n)).isFile() || hasFiles(path.join(dir, n)))); } catch (e) { return false; } };

function scan(store, busy) {
  const out = [];
  for (const p of store.listProjects()) {
    if (p.kind === 'freetalk') continue;
    const child = Boolean(p.parent || p.derivedFrom);
    const tasks = p.tasks.filter(t => !t.workdir && !busy(p.id, t.id) && !talked(p.dir, t.id)).map(t => ({
      project: p.id, projectName: p.name, task: t.id, title: t.title, state: t.state, done: t.done || '',
      // 最初から選ぶのは、派生の作業か子プロジェクトの作業で、やったことも空の物だけ（人が作って未着手の本作業は選ばない）
      pick: !t.done && (t.kind === 'derived' || child),
    }));
    const whole = child && tasks.length === p.tasks.length && !['資料', '作業', '成果物'].some(d => hasFiles(path.join(p.dir, d)));
    if (whole) out.push({ project: p.id, projectName: p.name, whole: true, tasks, pick: tasks.every(t => t.pick) });
    else out.push(...tasks);
  }
  return out;
}

// items: [{project, task}]（task 無し＝子プロジェクトごと）。もう一度確かめてから移す
function trash(store, busy, items, bin = process.env.HUB_TRASH || path.join(os.homedir(), '.Trash')) {
  const now = scan(store, busy);
  const dest = path.join(bin, lt`ProjectHub 片付け ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  const move = (src, project) => { if (!fs.existsSync(src)) return; const d = path.join(dest, project); fs.mkdirSync(d, { recursive: true }); let to = path.join(d, path.basename(src)); if (fs.existsSync(to)) to += '-' + Date.now(); fs.renameSync(src, to); };
  let moved = 0;
  for (const it of items || []) {
    const hit = now.find(x => x.project === it.project && (it.task ? x.task === it.task || (x.whole && x.tasks.some(t => t.task === it.task)) : x.whole));
    if (!hit) continue; // 中身ができた・動き出した物は移さない
    const p = store.readProject(it.project);
    if (!it.task) { move(p.dir, ''); moved++; continue; }
    const f = store.taskFile(p.id, it.task);
    const c = path.join(p.dir, '.ai', 'chat');
    for (const x of [f, path.join(c, `${it.task}.jsonl`), path.join(c, `${it.task}.json`), path.join(c, `${it.task}.queue.json`)]) move(x, p.id);
    moved++;
  }
  return { moved, dest: moved ? dest : '' };
}

// 作業1つ（作業ファイルと会話）をゴミ箱へ。子作業を親に取り込んだ後の片付けに使う
function trashTask(store, projectId, taskId, bin = process.env.HUB_TRASH || path.join(os.homedir(), '.Trash')) {
  const p = store.readProject(projectId); if (!p) return '';
  if (p.kind === 'freetalk') throw Error(require('./freetalk').PROTECTED);
  const dest = path.join(bin, lt`ProjectHub 片付け ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`, p.id);
  const c = path.join(p.dir, '.ai', 'chat');
  for (const x of [store.taskFile(p.id, taskId), path.join(c, `${taskId}.jsonl`), path.join(c, `${taskId}.json`), path.join(c, `${taskId}.queue.json`)]) {
    if (!x || !fs.existsSync(x)) continue;
    fs.mkdirSync(dest, { recursive: true });
    let to = path.join(dest, path.basename(x)); if (fs.existsSync(to)) to += '-' + Date.now();
    fs.renameSync(x, to);
  }
  return dest;
}

module.exports = { scan, trash, trashTask };
