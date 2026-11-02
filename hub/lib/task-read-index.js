'use strict';
const { sectionNames, lt } = require('./locale');

const MAX_BYTES = 800, MAX_SOURCE_BYTES = 2 * 1024 * 1024;
// Advisory only: never changes the source, summary, or existing reading rules.
function taskReadIndex(raw, { summaryIncluded = false, task = '<id>' } = {}) {
  if (typeof raw !== 'string' || raw.length > MAX_SOURCE_BYTES || Buffer.byteLength(raw) > MAX_SOURCE_BYTES) return '';
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const headings = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (fence) {
      if (new RegExp('^ {0,3}' + fence.char + '{' + fence.length + ',}\\s*$').test(line)) fence = null;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) { fence = { char: opening[1][0], length: opening[1].length }; continue; }
    const match = line.match(/^(##|###) (.+)$/);
    if (match) headings.push({ level: match[1].length, name: match[2].trim(), line: i + 1 });
  }
  if (fence) return ''; // Incomplete Markdown is not a reliable index.
  const top = headings.filter(h => h.level === 2), selected = [];
  for (const name of ['やったこと', '次にやること', '手順', '成果']) {
    const aliases = sectionNames(name), matches = top.filter(h => aliases.includes(h.name));
    if (matches.length !== 1) return '';
    const h = matches[0], end = top[top.indexOf(h) + 1]?.line - 1 || lines.length;
    selected.push({ ...h, label: name, end });
  }
  const steps = selected[2], subs = headings.filter(h => h.level === 3 && h.line > steps.line && h.line <= steps.end);
  if (new Set(subs.map(h => h.name)).size !== subs.length) return '';
  const range = h => `L${h.line}-${h.end}`;
  const title = s => { const chars = Array.from(s.replace(/\s/g, ' ')); return chars.slice(0, 18).join('') + (chars.length > 18 ? '…' : ''); };
  const latest = subs.slice(0, 3).map((h, i) => `${range({ ...h, end: subs[i + 1]?.line - 1 || steps.end })}「${title(h.name)}」`);
  const parts = selected.map(h => `${lt(h.label)} ${range(h)}${h === steps && latest.length ? lt`（最新の節：${latest.join('／')}）` : ''}`);
  const first = selected[0];
  const target = "'" + `.ai/tasks/${task}.md`.replaceAll("'", "'\\''") + "'";
  const line = lt`節の行範囲（起動時点の目安。更新でずれるため再読時は見出し確認）：${parts.join('／')}。範囲だけ読む（例：sed -n '${first.line},${first.end}p' ${target}）。全文は読まない。` + (summaryIncluded ? lt('再開要約は上記に含むため再読不要。') : '');
  return Buffer.byteLength(line + '\n') <= MAX_BYTES ? line + '\n' : '';
}
module.exports = { taskReadIndex, MAX_BYTES, MAX_SOURCE_BYTES };
