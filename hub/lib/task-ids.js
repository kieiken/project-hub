'use strict';
const { lt } = require('./locale');
// 作業番号は片付け・復元後も再利用しない。旧版の成果・履歴も予約に取り込む。
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const TASK_ID = /^\d{8}-\d{2,}$/;
function reserveTaskId(store, project, dir, day) {
  const { noLinks, exists } = require('./remove');
  const reserved = path.join(store.root, '_hub/task-ids', createHash('sha256').update(project).digest('hex'));
  noLinks(reserved); fs.mkdirSync(reserved, { recursive: true });
  const used = new Set(), add = id => { if (typeof id === 'string' && TASK_ID.test(id)) used.add(id); };
  const names = folder => { noLinks(folder); return exists(folder) ? fs.readdirSync(folder) : []; };
  for (const folder of ['.ai/tasks', '.ai/chat', '.ai/handoff', '作業', '成果物', 'attachments']) {
    for (const name of names(path.join(dir, folder))) add(name.match(/^(\d{8}-\d{2,})(?:\.|-|$)/)?.[1]);
  }
  names(path.join(store.root, 'Work', project)).forEach(add);
  for (const key of Object.keys(store.completion.data.tasks)) if (key.startsWith(project + '/')) add(key.slice(project.length + 1));
  const observe = row => {
    if (row.project === project) add(row.task);
    if (row.targetProject === project) add(row.targetTask);
    // 作業ID欄がない旧削除記録も、管理ファイルの元の場所で照合する。
    const prefix = path.join(dir, '.ai/tasks') + path.sep;
    for (const entry of row.entries || []) if (typeof entry.from === 'string' && entry.from.startsWith(prefix)) add(path.basename(entry.from, '.md'));
  };
  for (const folder of ['removed', 'task-handoffs']) {
    const base = path.join(store.root, '_hub', folder);
    for (const name of names(base).filter(n => n.endsWith('.json'))) {
      const file = path.join(base, name); noLinks(file); observe(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
  for (const name of ['log.jsonl', 'log.old.jsonl']) {
    const file = path.join(store.root, '_hub', name); noLinks(file);
    if (exists(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(x => x.trim())) {
      let row; try { row = JSON.parse(line); } catch { throw Error(lt('作業番号の履歴を読めません。記録を確認してください')); }
      observe(row);
    }
  }
  const reserve = id => {
    const file = path.join(reserved, id); noLinks(file);
    try { fs.writeFileSync(file, '', { flag: 'wx' }); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  };
  used.forEach(reserve);
  // 排他的な予約を先に保存。途中停止・再起動・複数Storeでも番号を使い直さない。
  for (let n = 1; ; n++) { const id = `${day}-${String(n).padStart(2, '0')}`; if (reserve(id)) return id; }
}
module.exports = { reserveTaskId };
