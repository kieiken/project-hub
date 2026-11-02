'use strict';
// The journal and roles travel in ONE atomic roles.yaml replacement. Comments
// keep the file compatible with existing YAML readers and human editing.
const fs = require('./platform/file-io');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseYaml } = require('./frontmatter');
const { lt } = require('./locale');
const PREFIX = '# hub-role-settings: ';
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(Error(lt(message)), { status: 409 }); };
const without = text => text.split(/\r?\n/).filter(l => !l.startsWith(PREFIX)).join('\n');
const revision = text => createHash('sha256').update(without(text)).update(JSON.stringify(decode(text)?.defaults || null)).digest('hex');
function snapshot(text) {
  return Object.entries(parseYaml(text).roles || {}).map(([name, r]) => {
    const slot = v => { const a = Array.isArray(v) ? v : [v]; return { ai: a[0] || '人', model: a[1] || '', effort: a[2] || '' }; };
    return { name, job: r.job || '', main: slot(r.main), backup: slot(r.backup) };
  });
}
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function changes(before, after) {
  const names = [...new Set([...before, ...after].map(r => r.name))];
  return names.flatMap(name => {
    const a = before.find(r => r.name === name), b = after.find(r => r.name === name);
    return same(a, b) ? [] : [{ role: name, before: a || null, after: b || null }];
  });
}
function decode(text) {
  const rows = text.split(/\r?\n/).filter(l => l.startsWith(PREFIX));
  if (!rows.length) return null;
  try {
    const j = JSON.parse(rows[0].slice(PREFIX.length));
    if (rows.length !== 1 || ![1, 2].includes(j.version) || !(j.defaults === null && j.version === 2 || Array.isArray(j.defaults?.roles)) || !j.history?.length ||
      !j.history.every(r => typeof r.id === 'string' && Number.isFinite(Date.parse(r.at)) && Array.isArray(r.roles))) throw Error('format');
    return j;
  } catch { fail('役割の変更履歴を読めません。履歴を上書きせず、保存ファイルを確認してください'); }
}
function encode(text, journal) {
  const row = PREFIX + JSON.stringify(journal);
  return text.split(/\r?\n/).some(l => l.startsWith(PREFIX))
    ? text.replace(/^# hub-role-settings: .*$/m, () => row)
    : text + (text.endsWith('\n') ? '' : '\n') + row + '\n';
}
// Compare the whole source again just before replacing it. No asynchronous gap
// permits another Hub request to sneak a save between the check and the rename.
function atomic(file, before, out) {
  if (fs.readFileSync(file, 'utf8') !== before) fail('役割設定が別の画面で変更されました。読み直してください');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('役割設定は単独の通常ファイルにしてください');
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', stat.mode & 0o777);
    fs.writeFileSync(fd, out); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (fs.readFileSync(file, 'utf8') !== before) fail('役割設定が別の画面で変更されました。読み直してください');
    fs.renameSync(tmp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  // A failed directory fsync cannot undo a successful rename. Both roles and
  // journal are already committed, so never report a false partial failure.
  let dir;
  try { if (process.platform !== 'win32') { dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); } } catch { /* atomic rename remains the authority */ }
  finally { if (dir !== undefined) fs.closeSync(dir); }
}
function entry(roles, at, kind, reason, participants = [], before = []) {
  return { id: randomUUID(), at, kind, reason, participants, roles: clone(roles), changes: changes(before, roles) };
}
function load(file, text = fs.readFileSync(file, 'utf8'), now = new Date().toISOString()) {
  let journal = decode(text);
  const roles = snapshot(text);
  if (!journal) {
    journal = { version: 2, defaults: null, history: [entry(roles, now, 'baseline', lt('記録開始時に保存されていた人の設定'))], lastReviewedAt: '', review: null, lastReview: null };
  } else if (!same(journal.history.at(-1).roles, roles)) {
    // Direct human edits are observed, never backdated to an unverifiable time.
    journal.history.push(entry(roles, now, 'edit', lt('roles.yaml の直接編集を確認'), [], journal.history.at(-1).roles));
    if (journal.review) { journal.lastReview = { project: journal.review.project, task: journal.review.task, at: now, status: 'failed', message: lt('見直し中に役割設定が編集されたため中断しました'), catalogObservations: journal.review.catalogObservations || [] }; journal.review = null; }
  }
  if (journal.version === 1) {
    // v1 silently captured the installation settings. Keep that data for recovery,
    // but only a person's explicit save establishes the new default.
    journal.legacyDefaults = journal.defaults; journal.defaults = null; journal.version = 2;
  }
  const out = encode(text, journal);
  if (out !== text) { atomic(file, text, out); text = out; }
  return { text, journal, revision: revision(text), roles };
}
function commit(file, before, next, options = {}) {
  const current = load(file, before), j = clone(current.journal);
  if (options.expectedRevision && options.expectedRevision !== current.revision) fail('役割設定が別の画面で変更されました。読み直してください');
  if (j.review && options.reviewId !== j.review.id) fail('役割の手動見直しが進行中です。終了してから保存してください');
  const after = snapshot(next), changed = !same(current.roles, after), at = options.at || new Date().toISOString();
  if (changed) j.history.push(entry(after, at, options.kind || 'edit', options.reason || lt('役割分担を手動で保存'), options.participants || [], current.roles));
  if (options.reviewed) {
    if (!j.review || j.review.id !== options.reviewId || j.review.baseRevision !== current.revision) fail('見直し前の役割設定が変わったため保存していません');
    const { project, task, catalogObservations = [] } = j.review;
    j.lastReviewedAt = at; j.review = null;
    j.lastReview = { project, task, at, status: 'success', changed, message: options.reason, participants: options.participants || [], catalogObservations };
  }
  const out = encode(next, j);
  if (out !== current.text) atomic(file, current.text, out);
  return { changed, journal: j, text: out };
}
function saveDefault(file, defaults, expectedRevision) {
  const current = load(file);
  if (!expectedRevision || expectedRevision !== current.revision) fail('役割設定が別の画面で変更されました。読み直してください');
  if (current.journal.review) fail('役割の手動見直しが進行中です。終了してから保存してください');
  const j = clone(current.journal);
  j.defaults = { at: new Date().toISOString(), roles: clone(defaults) };
  atomic(file, current.text, encode(current.text, j));
}
function updateReview(file, id, update) {
  const current = load(file), j = clone(current.journal);
  if (id && j.review?.id !== id) fail('手動見直しの実行記録が変わりました');
  update(j, current);
  atomic(file, current.text, encode(current.text, j));
  return j;
}
function select(journal, { id, before }) {
  let row;
  if (id) row = journal.history.find(r => r.id === id);
  else if (typeof before === 'string' && Number.isFinite(Date.parse(before))) row = journal.history.findLast(r => Date.parse(r.at) < Date.parse(before));
  if (!row) fail('その日時の設定は記録されていません。記録開始以降を選んでください');
  return clone(row);
}
function summary(current) {
  const j = current.journal;
  return { revision: current.revision, lastReviewedAt: j.lastReviewedAt, startedAt: j.history[0].at, defaultSavedAt: j.defaults?.at || '',
    historyCount: j.history.length, review: j.review ? { id: j.review.id, status: j.review.status, message: j.review.message, project: j.review.project, task: j.review.task } : null, lastReview: j.lastReview };
}
module.exports = { load, commit, saveDefault, updateReview, select, summary, snapshot, changes, same, revision };
