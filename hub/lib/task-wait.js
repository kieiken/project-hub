'use strict';

// Only an explicit, closed block at the end of a successful assistant reply
// counts. Quoted examples, code fences and incomplete streamed output do not.
function parse(text) {
  text = String(text || '');
  const match = /(?:^|\n)\[\[待ち\]\]\s*\n([^]*?)\n\[\[\/待ち\]\]\s*$/.exec(text);
  if (!match) return { text };
  const before = text.slice(0, match.index);
  let fence = null;
  for (const line of before.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) { if (!fence) fence = m[1]; else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null; }
  }
  const reason = match[1].trim();
  if (fence || !reason || reason.length > 500 || /\[\[|[\u0000-\u0008\u000b-\u001f\u007f]/.test(reason)) return { text };
  return { text: before.trimEnd(), waitReason: reason.replace(/\s*\n\s*/g, ' ') };
}
function eligible(o) {
  return !o.preserveTaskState && !o.automation && !o.discussionTurn && !o.isolatedReview && !o.selectionOnly && !o.readOnly && o.origin !== 'tier-review';
}
function started(store, o) {
  if (!eligible(o)) return;
  const t = store.readProject(o.project)?.tasks.find(t => t.id === o.task);
  if (t?.waitReason) store.updateTask(o.project, o.task, { state: '実行中', waitReason: '' });
}
function ended(store, o, row, { queued = false, stopped = false } = {}) {
  if (!eligible(o) || !row.waitReason || row.error || row.asks?.length || stopped) return;
  const t = store.readProject(o.project)?.tasks.find(t => t.id === o.task);
  if (!t || t.question || ['返事待ち', '停止', '上限で停止', '完了', '完了確認待ち'].includes(t.state)) return;
  // Keep the legacy value on disk. Older Hub versions ignore waitReason and
  // can continue to open and operate this task as an ordinary running task.
  store.updateTask(o.project, o.task, { state: '実行中', waitReason: queued ? '' : row.waitReason });
}
module.exports = { parse, eligible, started, ended };
