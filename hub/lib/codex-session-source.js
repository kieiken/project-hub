'use strict';
// Standalone source adapter: no Hub state, provider process, config or auth reads.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { pathToFileURL } = require('node:url');
const LIMITS = Object.freeze({ metadataRows: 5000, directories: 2048, files: 10000, depth: 6, headerBytes: 64 * 1024,
  indexBytes: 16 * 1024 * 1024, databaseBytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024,
  inputBytes: 256 * 1024 * 1024, lineBytes: 8 * 1024 * 1024, textBytes: 8 * 1024 * 1024, rows: 10000 });
const fail = code => Object.assign(Error({ unsafe: 'Source path is outside the permitted Codex history roots', stale: 'Codex source changed; discover and confirm again',
  limit: 'Codex source exceeds the configured reading limits', format: 'Codex history contains invalid JSONL', selection: 'Select a discovered Codex session ID', missing: 'This Codex session has no readable local transcript' }[code]), { code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const stampOf = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const stamp = file => stampOf(fs.statSync(file, { bigint: true }));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const clean = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum ? value : '';
function date(value, milliseconds = false) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  const input = numeric ? Number(value) * (milliseconds || Number(value) >= 1e12 ? 1 : 1000) : value;
  const result = new Date(input); return Number.isFinite(result.getTime()) ? result.toISOString() : '';
}
function origin(meta) {
  let raw = meta.source || meta.thread_source, invalidDescriptor = false;
  // SQLite stores compound SessionSource enums as JSON, while headers use objects.
  if (typeof raw === 'string' && /^[{[]/.test(raw.trim())) {
    try { raw = JSON.parse(clean(raw, 4096)); } catch { raw = null; invalidDescriptor = true; }
  }
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
  const childKey = keys.find(key => /^subagent/i.test(key)), guardianKey = keys.find(key => /guardian/i.test(key));
  const nested = childKey ? raw[childKey] : null;
  const sourceKind = clean(raw, 80) || (childKey ? 'subAgent' : guardianKey ? 'guardian' : ''), originator = clean(meta.originator, 160);
  const parent = clean(meta.parent_thread_id || meta.parentThreadId || nested?.parent_thread_id || nested?.thread_spawn?.parent_thread_id, 160);
  const isSubagent = /^(subagent|guardian)/i.test(sourceKind) || Boolean(parent);
  const evidence = [sourceKind, originator].map(value => value.toLowerCase());
  const source = evidence.some(value => ['desktop', 'codex_desktop', 'codex-desktop', 'codex desktop', 'codex_work_desktop'].includes(value)) ? 'Desktop'
    : ['codex-tui', 'codex_cli_rs', 'codex-cli'].includes(originator.toLowerCase()) || sourceKind.toLowerCase() === 'cli' ? 'CLI'
      : ['codex_vscode', 'codex_vscode_rs'].includes(originator.toLowerCase()) || !originator && ['vscode', 'ide'].includes(sourceKind.toLowerCase()) ? 'IDE' : 'unknown';
  return { source: isSubagent || invalidDescriptor ? 'unknown' : source, sourceKind, originator, isSubagent, parent };
}
function safeFile(root, file) {
  const resolved = fs.realpathSync(file);
  if (!inside(root, resolved) || !fs.statSync(resolved).isFile()) throw fail('unsafe');
  return resolved;
}
function openStable(root, file, before) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { if (safeFile(root, file) !== file || stampOf(fs.fstatSync(fd, { bigint: true })) !== before) throw fail('stale'); }
  catch (error) { fs.closeSync(fd); throw error; }
  return fd;
}
class CodexSessionSource {
  #entries = new Map();
  constructor(options = {}) {
    const env = options.env || process.env;
    this.configuredRoot = path.resolve(options.root || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    this.configuredSqliteRoot = path.resolve(options.sqliteRoot || env.CODEX_SQLITE_HOME || this.configuredRoot);
    this.limits = { ...LIMITS };
    for (const [key, value] of Object.entries(options.limits || {})) {
      if (!(key in LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw fail('limit');
      this.limits[key] = value;
    }
    this.root = null;
  }
  checkRoot() { if (!this.root || fs.realpathSync(this.configuredRoot) !== this.root) throw fail('stale'); }
  transcript(file) {
    const resolved = safeFile(this.root, file);
    if (!resolved.endsWith('.jsonl') || !['sessions', 'archived_sessions'].some(folder => inside(path.join(this.root, folder), resolved))) throw fail('unsafe');
    return resolved;
  }
  list(directory, maximum) {
    const result = [], dir = fs.opendirSync(directory);
    try { let entry; while ((entry = dir.readSync())) { if (result.length >= maximum) throw fail('limit'); result.push(entry); } }
    finally { dir.closeSync(); }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  add(meta, file = '', priority = 0) {
    const threadId = clean(meta.id, 160); if (!threadId) return;
    const id = 'codex_' + hash(this.root + '\0' + threadId);
    const previous = this.#entries.get(id), evidence = origin(meta), session = { id, provider: 'codex', title: clean(meta.title || meta.name || meta.thread_name, 2000),
      cwd: clean(meta.cwd), projectId: clean(meta.project_id, 2000), createdAt: date(meta.created_at_ms, true) || date(meta.created_at || meta.timestamp),
      updatedAt: date(meta.updated_at_ms, true) || date(meta.updated_at || meta.updatedAt || meta.timestamp),
      source: evidence.source, sourceKind: evidence.sourceKind, originator: evidence.originator, isSubagent: evidence.isSubagent,
      parentId: evidence.parent ? 'codex_' + hash(this.root + '\0' + evidence.parent) : '',
      archived: Boolean(meta.archived), hasTranscript: Boolean(file) };
    session.identity = hash(threadId + '\0' + session.cwd);
    if (!previous && this.#entries.size >= this.limits.metadataRows) throw fail('limit');
    if (previous) {
      const preferred = priority > previous.priority || priority === previous.priority && session.updatedAt >= previous.session.updatedAt ? session : previous.session, fallback = preferred === session ? previous.session : session;
      for (const key of ['title', 'cwd', 'projectId', 'createdAt', 'updatedAt', 'sourceKind', 'originator']) if (!preferred[key]) preferred[key] = fallback[key];
      if (session.title && session.updatedAt && session.updatedAt >= previous.session.updatedAt) preferred.title = session.title;
      preferred.updatedAt = [session.updatedAt, previous.session.updatedAt].sort().at(-1);
      preferred.identity = hash(threadId + '\0' + preferred.cwd);
      preferred.isSubagent ||= fallback.isSubagent;
      preferred.parentId ||= fallback.parentId;
      if (preferred.isSubagent) preferred.source = 'unknown';
      else preferred.source = origin({ source: preferred.sourceKind, originator: preferred.originator }).source;
      const selectedFile = previous.file || file;
      preferred.hasTranscript = Boolean(selectedFile);
      if (selectedFile) preferred.archived = inside(path.join(this.root, 'archived_sessions'), selectedFile);
      this.#entries.set(id, { session: preferred, threadId, file: selectedFile, stamp: selectedFile ? stamp(selectedFile) : '', priority: Math.max(priority, previous.priority) });
    } else {
      if (file) session.archived = inside(path.join(this.root, 'archived_sessions'), file);
      this.#entries.set(id, { session, threadId, file, stamp: file ? stamp(file) : '', priority });
    }
  }
  database(file, sqliteRoot, warnings) {
    const resolved = safeFile(sqliteRoot, file), companions = [resolved, resolved + '-wal', resolved + '-shm', resolved + '-journal'];
    if (fs.statSync(resolved).size > this.limits.databaseBytes) throw fail('limit');
    const states = () => companions.map(file => exists(file) ? [safeFile(sqliteRoot, file), stamp(file)] : null);
    const before = JSON.stringify(states());
    // A normal readOnly connection can write SQLite's -shm. Immutable mode
    // avoids locks/sidecar writes (https://sqlite.org/uri.html). Pending WAL
    // must instead use index/header metadata, never silently stale DB results.
    if ([resolved + '-wal', resolved + '-journal'].some(file => exists(file) && fs.statSync(file).size > 0)) {
      warnings.add('SQLite has pending journal data; using bounded session index/header metadata instead'); return false;
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(pathToFileURL(resolved).href + '?mode=ro&immutable=1', { readOnly: true });
    let rows;
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      if (!columns.has('id')) return false;
      const fields = ['id', 'rollout_path', 'title', 'name', 'cwd', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'source', 'thread_source', 'originator', 'project_id', 'archived', 'parent_thread_id', 'parentThreadId'].filter(field => columns.has(field));
      const select = fields.map(field => ['created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'archived'].includes(field) ? '"' + field + '"' : `substr("${field}",1,4097) AS "${field}"`).join(',');
      const native = columns.has('originator') ? "CASE WHEN lower(originator) IN ('codex desktop','codex_desktop','codex_work_desktop') THEN 0 WHEN lower(originator) IN ('codex-tui','codex_cli_rs','codex_vscode','codex_vscode_rs') THEN 1 ELSE 2 END," : '';
      const newest = columns.has('updated_at_ms') ? 'updated_at_ms DESC' : columns.has('updated_at') ? 'updated_at DESC' : 'id DESC';
      rows = db.prepare(`SELECT ${select} FROM threads ORDER BY ${native}${newest} LIMIT ?`).all(this.limits.metadataRows + 1);
    } finally { db.close(); }
    if (before !== JSON.stringify(states())) throw fail('stale');
    if (rows.length > this.limits.metadataRows) { warnings.add('Codex SQLite metadata reached its row limit; the list prioritizes Desktop and recent sessions'); rows.length = this.limits.metadataRows; }
    for (const row of rows) {
      let transcript = '';
      if (row.rollout_path) try { transcript = this.transcript(path.isAbsolute(row.rollout_path) ? row.rollout_path : path.join(this.root, row.rollout_path)); }
      catch { warnings.add('Some Codex transcript paths are missing or outside permitted history roots'); }
      this.add(row, transcript, 3);
    }
    return true;
  }
  async index(warnings, budget) {
    const file = path.join(this.root, 'session_index.jsonl'); if (!exists(file)) return;
    await this.lines(safeFile(this.root, file), this.root, this.limits.indexBytes, budget, line => {
      let item; try { item = JSON.parse(line); } catch { warnings.add('Some Codex index metadata is invalid'); return; }
      this.add(item, '', 2);
    });
  }
  firstMeta(file, budget) {
    const before = stamp(file), fd = openStable(this.root, file, before), buffer = Buffer.alloc(this.limits.headerBytes);
    let bytes = 0;
    try {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); budget.input += bytes;
      if (budget.input > this.limits.inputBytes) throw fail('limit');
      const end = buffer.subarray(0, bytes).indexOf(10);
      if (end < 0 && fs.fstatSync(fd).size > bytes) throw fail('limit');
      const line = buffer.subarray(0, end < 0 ? bytes : end).toString('utf8'), item = JSON.parse(line);
      if (stamp(file) !== before) throw fail('stale');
      if (item.type !== 'session_meta' || !item.payload || typeof item.payload !== 'object') throw fail('format');
      // Only bounded metadata fields are retained; instructions are excluded.
      return { id: item.payload.id, title: item.payload.title, name: item.payload.name, cwd: item.payload.cwd, project_id: item.payload.project_id,
        source: item.payload.source, thread_source: item.payload.thread_source, originator: item.payload.originator,
        parent_thread_id: item.payload.parent_thread_id, parentThreadId: item.payload.parentThreadId, timestamp: item.timestamp };
    } finally { fs.closeSync(fd); }
  }
  walk(directory, counters, budget, warnings, depth = 0) {
    if (depth > this.limits.depth || ++counters.directories > this.limits.directories) throw fail('limit');
    for (const entry of this.list(directory, this.limits.files).reverse()) {
      if (++counters.files > this.limits.files) throw fail('limit');
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { warnings.add('Linked Codex history entries were skipped'); continue; }
      if (entry.isDirectory()) this.walk(file, counters, budget, warnings, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { this.add(this.firstMeta(this.transcript(file), budget), file, 1); }
        catch (error) { if (error.code === 'limit') throw error; warnings.add('Some Codex session headers could not be read safely'); }
      }
    }
  }
  async discover() {
    this.#entries.clear(); const warnings = new Set(), budget = { input: 0 }, counters = { directories: 0, files: 0 };
    try { this.root = fs.realpathSync(this.configuredRoot); if (!fs.statSync(this.root).isDirectory()) throw fail('unsafe'); }
    catch { this.root = null; return { sessions: [], warnings: ['Codex history root is unavailable'], supported: false }; }
    try {
      let sqliteRoot;
      try { sqliteRoot = fs.realpathSync(this.configuredSqliteRoot); }
      catch { warnings.add('Codex SQLite metadata root is unavailable; using session index/headers'); }
      if (sqliteRoot) {
        const databases = this.list(sqliteRoot, this.limits.files).filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)).sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
        for (const entry of databases) {
          try { if (this.database(path.join(sqliteRoot, entry.name), sqliteRoot, warnings)) break; }
          catch (error) { if (error.code === 'limit') throw error; warnings.add('Codex SQLite metadata could not be read safely; using session index/headers'); }
        }
      }
      await this.index(warnings, budget);
      for (const folder of ['sessions', 'archived_sessions']) {
        const directory = path.join(this.root, folder);
        if (!exists(directory)) continue;
        if (fs.lstatSync(directory).isSymbolicLink()) { warnings.add('Linked Codex history entries were skipped'); continue; }
        this.walk(directory, counters, budget, warnings);
      }
      this.checkRoot();
    } catch (error) { if (error.code === 'stale') { this.#entries.clear(); warnings.add('Codex source changed during discovery; discover again'); } else warnings.add(error.code === 'limit' ? 'Codex metadata discovery reached its reading limit; the list is incomplete' : 'Some Codex metadata could not be read safely'); }
    return { sessions: [...this.#entries.values()].map(entry => ({ ...entry.session })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), warnings: [...warnings], supported: true };
  }
  async lines(file, root, maximum, budget, parse) {
    const before = stamp(file), size = fs.statSync(file).size;
    if (size > maximum || budget.input + size > this.limits.inputBytes) throw fail('limit');
    const fd = openStable(root, file, before), stream = fs.createReadStream(file, { fd, autoClose: true, highWaterMark: 64 * 1024 });
    const decoder = new StringDecoder('utf8'), signature = crypto.createHash('sha256'); let pending = '', actual = 0;
    const line = value => { if (Buffer.byteLength(value) > this.limits.lineBytes) throw fail('limit'); if (value.trim()) parse(value); };
    try {
      for await (const chunk of stream) {
        actual += chunk.length; budget.input += chunk.length;
        if (actual > maximum || budget.input > this.limits.inputBytes) throw fail('limit');
        signature.update(chunk); pending += decoder.write(chunk);
        let end; while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (Buffer.byteLength(pending) > this.limits.lineBytes) throw fail('limit');
      }
      pending += decoder.end(); if (pending) line(pending);
    } finally { stream.destroy(); if (!stream.closed) await new Promise(resolve => stream.once('close', resolve)); }
    if (safeFile(root, file) !== file || stamp(file) !== before || actual !== size) throw fail('stale');
    return signature.digest('hex');
  }
  async read(session, options = {}) {
    const id = typeof session === 'string' ? session : session?.id, entry = this.#entries.get(id);
    if (!entry) throw fail('selection'); this.checkRoot();
    if (!entry.file) throw fail('missing');
    if (options.expectedFingerprint && this.fingerprint(id) !== options.expectedFingerprint) throw fail('stale');
    const file = this.transcript(entry.file); if (stamp(file) !== entry.stamp) throw fail('stale');
    const budget = options.budget || { input: 0, text: 0, rows: 0 };
    for (const key of ['input', 'text', 'rows']) { if (budget[key] === undefined) budget[key] = 0; if (!Number.isSafeInteger(budget[key]) || budget[key] < 0) throw fail('limit'); }
    if (this.firstMeta(file, budget)?.id !== entry.threadId) throw fail('stale');
    const rows = [], seen = new Set(); let legacyEvents = 0, lifecycle = { state: 'unknown', event: '', at: '' };
    const signature = await this.lines(file, this.root, this.limits.fileBytes, budget, line => {
      let item; try { item = JSON.parse(line); } catch { throw fail('format'); }
      if (item.type === 'event_msg' && ['user_message', 'agent_message'].includes(item.payload?.type)) legacyEvents++;
      if (item.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(item.payload?.type)) {
        lifecycle = { state: item.payload.type === 'task_started' ? 'busy' : 'idle', event: item.payload.type, at: date(item.timestamp) };
      }
      const message = item.payload;
      if (item.type !== 'response_item' || message?.type !== 'message' || !['user', 'assistant'].includes(message.role) || message.channel === 'analysis' || !Array.isArray(message.content)) return;
      const body = message.content.filter(part => ['input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n');
      if (!body) return;
      const key = typeof message.id === 'string' ? hash(message.role + '\0' + message.id + '\0' + body) : '';
      if (key && seen.has(key)) return; if (key) seen.add(key);
      budget.text += Buffer.byteLength(body); budget.rows++;
      if (budget.text > this.limits.textBytes || budget.rows > this.limits.rows) throw fail('limit');
      rows.push({ role: message.role, text: body, at: date(item.timestamp) });
    });
    this.checkRoot();
    if (options.expectedSignature && options.expectedSignature !== signature) throw fail('stale');
    if (options.expectedFingerprint && this.fingerprint(id) !== options.expectedFingerprint) throw fail('stale');
    const warnings = !rows.length && legacyEvents ? ['Only legacy events were found; this adapter retains canonical response messages only'] : [];
    if (lifecycle.state === 'unknown') warnings.push('Codex lifecycle events are unavailable; native activity is unknown');
    return { rows, signature, warnings, lifecycle, active: lifecycle.state === 'busy' ? true : lifecycle.state === 'idle' ? false : null };
  }
  fingerprint(session) {
    const id = typeof session === 'string' ? session : session?.id, entry = this.#entries.get(id);
    if (!entry) throw fail('selection'); this.checkRoot();
    if (!entry.file) throw fail('missing');
    const file = this.transcript(entry.file);
    if (stamp(file) !== entry.stamp || this.firstMeta(file, { input: 0 })?.id !== entry.threadId) throw fail('stale');
    return hash(JSON.stringify([entry.session, entry.threadId, this.root, file, entry.stamp]));
  }
  referenceFor(session) {
    const id = typeof session === 'string' ? session : session?.id, entry = this.#entries.get(id);
    const signature = this.fingerprint(id);
    try { if (!entry.session.cwd || !fs.statSync(entry.session.cwd).isDirectory()) throw fail('missing'); }
    catch { throw fail('missing'); }
    let sqliteRoot; try { sqliteRoot = fs.realpathSync(this.configuredSqliteRoot); } catch { sqliteRoot = this.configuredSqliteRoot; }
    return { provider: 'codex', sourceSessionId: entry.threadId, sessionId: entry.threadId, cwd: entry.session.cwd, identity: entry.session.identity,
      file: entry.file, transcriptPath: entry.file, signature, isSubagent: entry.session.isSubagent,
      roots: { codexHome: this.root, sqliteRoot } };
  }
}
module.exports = { CodexSessionSource, LIMITS };
