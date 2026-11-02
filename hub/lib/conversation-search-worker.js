'use strict';
// Runs outside the HTTP event loop. No index, transcript copies, CLI metadata or image recovery.
const fs = require('node:fs'), path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { parseDoc } = require('./frontmatter');
const { noLinks } = require('./remove');
const hash = x => createHash('sha256').update(x).digest('hex');
const safe = x => typeof x === 'string' && !!x && !/^[._]|[/\\\0]/.test(x);
const normalize = x => x.normalize('NFKC').toLowerCase();
const LIMITS = { file: 64 * 1024 * 1024, total: 512 * 1024 * 1024, line: 2 * 1024 * 1024, sources: 10000, hits: 1000 };
function visible(row) {
  if (!row || !['user', 'assistant'].includes(row.role)) return '';
  return [typeof row.text === 'string' ? row.text : '', ...(Array.isArray(row.asks) ? row.asks : []).flatMap(a => [typeof a?.question === 'string' ? a.question : '', ...(Array.isArray(a?.options) ? a.options.filter(x => typeof x === 'string') : [])])].filter(Boolean).join('\n');
}
function regular(file) { noLinks(file); const st = fs.lstatSync(file); if (!st.isFile()) throw Error('unsafe'); return st; }
const stamp = st => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
function document(file) { const st = regular(file); if (st.size > 4 * 1024 * 1024) throw Error('large-document'); return parseDoc(fs.readFileSync(file, 'utf8')).data; }
function names(dir) { noLinks(dir); try { return fs.readdirSync(dir).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
function topic(root, project, task) {
  if (!safe(project) || !safe(task)) throw Error('target');
  const dir = path.join(root, 'Product', project), p = document(path.join(dir, 'PROJECT.md'));
  const t = document(path.join(dir, '.ai/tasks', task + '.md'));
  return { dir, project, task, projectName: typeof p.name === 'string' ? p.name : project, taskName: typeof t.title === 'string' ? t.title : task, freetalk: p.kind === 'freetalk' };
}
function current(t) { return { ...t, file: path.join(t.dir, '.ai/chat', t.task + '.jsonl'), archiveId: '' }; }
function archived(t, id, stats) {
  if (t.freetalk || !/^[a-f0-9-]{36}$/.test(id)) throw Error('archive');
  const dir = path.join(t.dir, '.ai/chat/history', t.task, id), f = path.join(dir, 'manifest.json');
  regular(f); if (fs.statSync(f).size > 4 * 1024 * 1024) throw Error('manifest-size');
  if (stats) stats.manifests++;
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.id !== id || m.project !== t.project || m.task !== t.task || m.stage !== 'committed' || !Array.isArray(m.entries)) throw Error('manifest');
  const logs = m.entries.filter(e => e.kind === 'log' && e.existed);
  if (logs.length !== 1) throw Error('log');
  const log = logs[0];
  if (!/^\d+\.original$/.test(log.saved) || !/^[a-f0-9]{64}$/.test(log.digest) || !Number.isSafeInteger(log.bytes) || !Number.isInteger(log.mode)) throw Error('log-metadata');
  return { ...t, file: path.join(dir, log.saved), archiveId: id, expected: log, manifest: f, manifestHash: hash(fs.readFileSync(f)) };
}
// Chunked parsing bounds memory even for a malformed single huge JSONL row.
function read(source, onRow, stats) {
  const st = regular(source.file);
  if (st.size > LIMITS.file || (stats.scannedBytes ?? stats.bytes) + st.size > LIMITS.total) throw Error('size-limit');
  const e = source.expected;
  if (e && (st.size !== e.bytes || (st.mode & 0o777) !== e.mode)) throw Error('archive-changed');
  const fd = fs.openSync(source.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let tail = Buffer.alloc(0), oversized = false, index = 0;
  try {
    if (stamp(fs.fstatSync(fd)) !== stamp(st)) throw Error('changed');
    const line = bytes => {
      if (!bytes.length) return;
      const i = index++;
      if (bytes.length > LIMITS.line) { stats.skippedRows++; if (e) throw Error('archive-row'); return; }
      let row; try { row = JSON.parse(bytes.toString('utf8')); } catch { stats.skippedRows++; if (e) throw Error('archive-row'); return; }
      onRow(row, i, stamp(st));
    };
    let pos = 0;
    while (pos < st.size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, st.size - pos), pos); if (!n) throw Error('changed');
      pos += n; stats.bytes += n; if(stats.scannedBytes!==undefined)stats.scannedBytes+=n; if (e) stats.archiveBytes = (stats.archiveBytes || 0) + n; const chunk = buffer.subarray(0, n); digest.update(chunk);
      let start = 0;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) {
        if (!oversized) line(tail.length ? Buffer.concat([tail, chunk.subarray(start, i)]) : chunk.subarray(start, i));
        else { index++; stats.skippedRows++; if (e) throw Error('archive-row'); }
        tail = Buffer.alloc(0); oversized = false; start = i + 1;
      }
      if (!oversized) { tail = Buffer.concat([tail, chunk.subarray(start)]); if (tail.length > LIMITS.line) { tail = Buffer.alloc(0); oversized = true; } }
    }
    if (oversized) { stats.skippedRows++; if (e) throw Error('archive-row'); } else line(tail);
    if (stamp(fs.fstatSync(fd)) !== stamp(st) || stamp(regular(source.file)) !== stamp(st)) throw Error('changed');
    if (e && (digest.digest('hex') !== e.digest || hash(fs.readFileSync(source.manifest)) !== source.manifestHash)) throw Error('archive-changed');
    noLinks(source.file); if (source.manifest) noLinks(source.manifest);
  } finally { fs.closeSync(fd); }
}
// The persistent search worker retains only verified archived visible rows.
// A manifest SHA alone is not a freshness proof: file identity/mtime/ctime/mode
// and live no-link checks must also match. Context reads always re-read bytes.
const archiveCache=new Map(),CACHE_BYTES=32*1024*1024;let cacheBytes=0;
function searchRows(source,onRow,stats){
  const e=source.expected;
  if(!e)return read(source,(row,index,signature)=>onRow({text:visible(row),role:row.role,at:row.at,index},signature),stats);
  const st=regular(source.file),signature=stamp(st),key=JSON.stringify([source.file,source.manifestHash,e.digest,signature,st.mode]);
  if(st.size!==e.bytes||(st.mode&0o777)!==e.mode||st.size>LIMITS.file||(stats.scannedBytes??stats.bytes)+st.size>LIMITS.total)throw Error('archive-changed');
  const valid=()=>{noLinks(source.file);noLinks(source.manifest);if(stamp(regular(source.file))!==signature||hash(fs.readFileSync(source.manifest))!==source.manifestHash)throw Error('archive-changed');};
  const hit=archiveCache.get(key);
  if(hit){valid();archiveCache.delete(key);archiveCache.set(key,hit);stats.archiveCacheHits=(stats.archiveCacheHits||0)+1;stats.scannedBytes+=st.size;for(const row of hit.rows)onRow(row,signature);valid();return;}
  let rows=[],size=0;
  read(source,(row,index,sig)=>{
    const text=visible(row);if(!text)return;
    const value=normalize(text),item={text,value,role:row.role,at:row.at,index,rowHash:hash(JSON.stringify([row.role,row.at,text]))};
    onRow(item,sig);
    if(rows){size+=2*(text.length+value.length)+256;if(size<=CACHE_BYTES)rows.push(item);else rows=null;}
  },stats);
  valid();
  if(rows){while(archiveCache.size>=128||cacheBytes+size>CACHE_BYTES){const k=archiveCache.keys().next().value;cacheBytes-=archiveCache.get(k).size;archiveCache.delete(k);}archiveCache.set(key,{rows,size});cacheBytes+=size;}
}
function excerpt(text, words) {
  // Normalization can change lengths; choose an original-codepoint window, then highlight in the UI.
  const chars = Array.from(text); let at = 0, found = false;
  for (let i = 0; i < chars.length && !found; i += 100) if (words.some(w => normalize(chars.slice(i, i + 180).join('')).includes(w))) { at = Math.max(0, i - 30); found = true; }
  return (at ? '…' : '') + chars.slice(at, at + 280).join('') + (at + 280 < chars.length ? '…' : '');
}
function search({ root, query, mode = 'simple' }) {
  if (!['simple', 'detailed'].includes(mode)) throw Error('mode');
  const phrase = normalize(query.trim()), words = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  const stats = { bytes: 0, scannedBytes: 0, archiveBytes: 0, historyDirectories: 0, manifests: 0, sources: 0, skipped: 0, skippedRows: 0, limited: false }, hits = new Map();
  const compare = (a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)) || a.key.localeCompare(b.key);
  let last = 0;
  const progress = () => { if (Date.now() - last > 100) { parentPort?.postMessage({ type: 'progress', stats, found: hits.size }); last = Date.now(); } };
  function scan(s) {
    if (stats.sources >= LIMITS.sources || (stats.scannedBytes||0) >= LIMITS.total) { stats.limited = true; return; }
    stats.sources++; const pending = [];
    try {
      searchRows(s, (row, signature) => {
        const {text,index}=row; if (!text) return;
        const value = row.value??normalize(text), matched = words.filter(w => value.includes(w)).length; if (!matched) return;
        const rowHash = row.rowHash??hash(JSON.stringify([row.role, row.at, text])), key = hash(s.project + '\0' + s.task + '\0' + rowHash);
        pending.push({ key, project: s.project, task: s.task, projectName: s.projectName, taskName: s.taskName, archiveId: s.archiveId, row: index, rowHash, signature, at: typeof row.at === 'string' ? row.at : '', role: row.role, snippet: excerpt(text, words), score: value.includes(phrase) ? 3 : matched === words.length ? 2 : 1, matched, words: words.length });
        if (pending.length >= LIMITS.hits * 2) { pending.sort(compare); pending.length = LIMITS.hits; stats.limited = true; }
      }, stats);
      if (pending.length > LIMITS.hits) { pending.sort(compare); pending.length = LIMITS.hits; stats.limited = true; }
      for (const hit of pending) if (!hits.has(hit.key)) hits.set(hit.key, hit);
      if (hits.size > LIMITS.hits) { const best = [...hits.values()].sort(compare).slice(0, LIMITS.hits); hits.clear(); for (const h of best) hits.set(h.key, h); stats.limited = true; }
    } catch (e) { if (e.code !== 'ENOENT' || s.archiveId) stats.skipped++; }
    progress();
  }
  projects: for (const project of names(path.join(root, 'Product')).filter(safe)) {
    let tasks;
    try { document(path.join(root, 'Product', project, 'PROJECT.md')); tasks = names(path.join(root, 'Product', project, '.ai/tasks')); } catch { stats.skipped++; continue; }
    for (const n of tasks.filter(n => n.endsWith('.md') && safe(n.slice(0, -3)))) {
      if (stats.sources >= LIMITS.sources || (stats.scannedBytes||0) >= LIMITS.total) { stats.limited = true; break projects; }
      let t; try { t = topic(root, project, n.slice(0, -3)); } catch { stats.skipped++; continue; }
      scan(current(t));
      // Simple search never enumerates history, opens a manifest, or reads archived text.
      if (mode === 'detailed' && !t.freetalk) try {
        stats.historyDirectories++;
        for (const id of names(path.join(t.dir, '.ai/chat/history', t.task)).filter(n => /^[a-f0-9-]{36}$/.test(n))) {
          if (stats.sources >= LIMITS.sources || (stats.scannedBytes||0) >= LIMITS.total) { stats.limited = true; break projects; }
          try { scan(archived(t, id, stats)); } catch { stats.skipped++; }
        }
      } catch { stats.skipped++; }
    }
  }
  return { hits: [...hits.values()].sort(compare), stats };
}
function context({ root, hit, mode = 'simple' }) {
  if (!['simple', 'detailed'].includes(mode) || (mode === 'simple' && hit.archiveId)) throw Error('mode');
  const t = topic(root, hit.project, hit.task), s = hit.archiveId ? archived(t, hit.archiveId) : current(t), rows = []; let target = false;
  read(s, (row, index, signature) => {
    // A changed transcript must be searched again; never jump by a stale timestamp.
    if (signature !== hit.signature) throw Error('changed');
    const text = visible(row); if (!text) return;
    if (index === hit.row) { if (hash(JSON.stringify([row.role, row.at, text])) !== hit.rowHash) throw Error('changed'); target = true; }
    if (index >= hit.row - 8 && index <= hit.row + 8) rows.push({ role: row.role, at: row.at, text: text.slice(0, 100000), truncated: text.length > 100000, target: index === hit.row });
  }, { bytes: 0, skippedRows: 0 });
  if (!target) throw Error('changed');
  return { rows, mode, target: { project: t.project, task: t.task, freetalk: t.freetalk } };
}
function execute(data){
  try { parentPort.postMessage({ type: 'done', result: data.action === 'context' ? context(data) : search(data) }); }
  catch { parentPort.postMessage({ type: 'failed' }); }
}
if(parentPort){if(workerData?.persistent)parentPort.on('message',execute);else execute(workerData);}
module.exports = { visible, normalize, LIMITS, search, cacheInfo:()=>({bytes:cacheBytes,entries:archiveCache.size,limit:CACHE_BYTES}) };
