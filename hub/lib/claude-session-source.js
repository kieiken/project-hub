'use strict';
// Pure read-only Claude Desktop/CLI source. No Hub storage, chat or runtime dependency.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const LIMITS = { metadata: 2000, directories: 1024, files: 10000, selected: 200, fileBytes: 128 * 1024 * 1024, inputBytes: 256 * 1024 * 1024, lineBytes: 8 * 1024 * 1024, textBytes: 8 * 1024 * 1024, rows: 10000 };
const fail = (code, status = 400) => Object.assign(Error(code), { code, status });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const sessionName = /^[A-Za-z0-9_-]{1,160}$/;
function rootOf(file) { try { return fs.realpathSync(file); } catch { return null; } }
function sourceFile(root, file) {
  const resolved = fs.realpathSync(file);
  if (!inside(root, resolved) || !fs.statSync(resolved).isFile()) throw fail('unsafe');
  return resolved;
}
function readJSON(root, file, limit = 1024 * 1024) {
  const resolved = sourceFile(root, file), before = stamp(resolved), fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (sourceFile(root, file) !== resolved || stamp(resolved) !== before) throw fail('stale', 409);
    const stat = fs.fstatSync(fd); if (stat.size > limit) throw fail('limit');
    const buffer = Buffer.alloc(stat.size + 1); let bytes = 0, read;
    while (bytes < buffer.length && (read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += read;
    if (bytes > stat.size || stamp(resolved) !== before) throw fail('stale', 409);
    const body = buffer.subarray(0, bytes).toString('utf8');
    return { value: JSON.parse(body), file: resolved, signature: digest(body) };
  } finally { fs.closeSync(fd); }
}
function names(directory, limit = LIMITS.files) {
  const result = [], dir = fs.opendirSync(directory);
  try { let item; while ((item = dir.readSync())) { if (result.length >= limit) throw fail('limit'); result.push(item.name); } }
  finally { dir.closeSync(); }
  return result.sort();
}
const stamp = file => { const s = fs.statSync(file); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); };
const iso = value => { const d = new Date(typeof value === 'string' && /^\d{10,13}$/.test(value) ? +value : value); return Number.isFinite(d.getTime()) ? d.toISOString() : ''; };
class ClaudeSessionSource {
  constructor(options = {}) {
    const env = { ...process.env, ...(options.env || {}) }, home = options.home || os.homedir();
    this.desktop = options.desktopRoot || env.HUB_CLAUDE_DESKTOP_DIR || path.join(home, 'Library/Application Support/Claude');
    this.cli = options.cliRoot || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
    this.language = options.language || (env.HUB_LANG === 'zh-TW' ? 'zh-TW' : 'ja');
    this.now = options.now || Date.now; this.salt = crypto.randomBytes(24).toString('hex');
  }
  text(code) {
    const words = { partial: ['Claude CLI の一覧が読み取り上限に達しました。一部の会話だけを表示します', 'Claude CLI 清單已達讀取上限，目前只顯示部分會話'], desktop: ['Claude Desktop のグループ情報を読めません', '無法讀取 Claude Desktop 群組資訊'], metadata: ['一部の会話情報を読めませんでした', '部分會話資訊無法讀取'], grouped: ['グループ外の Desktop 会話', '未分組的 Desktop 會話'], title: ['題名の無い会話', '未命名會話'] };
    return (words[code] || [code, code])[this.language === 'zh-TW' ? 1 : 0];
  }
  transcriptIndex(cliRoot) {
    const result = new Map(); if (!cliRoot) return result;
    let count = 0, directories = 0;
    for (const dir of names(cliRoot, LIMITS.directories)) {
      if (++directories > LIMITS.directories) throw fail('limit');
      const base = rootOf(path.join(cliRoot, dir));
      if (!base || !inside(cliRoot, base) || !fs.statSync(base).isDirectory()) continue;
      for (const file of names(base)) {
        if (++count > LIMITS.files) throw fail('limit');
        if (!/^[A-Za-z0-9_-]{1,160}\.jsonl$/.test(file)) continue;
        try {
          const full = sourceFile(cliRoot, path.join(base, file)), id = path.basename(file, '.jsonl');
          if (!result.has(id)) result.set(id, []);
          if (!result.get(id).includes(full)) result.get(id).push(full);
        } catch { /* Links escaping the configured source root are never candidates. */ }
      }
    }
    return result;
  }
  scan() {
    const desktop = rootOf(this.desktop), cliRoot = rootOf(this.cli), warnings = [], projects = [], lookup = new Map();
    let scopes = {}, desktopSupported = false;
    try { if (!desktop) throw fail('missing'); scopes = readJSON(desktop, path.join(desktop, 'claude_desktop_config.json'), 8 * 1024 * 1024).value?.preferences?.epitaxyPrefs?.['dframe-group-scopes']; if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw fail('format'); desktopSupported = true; }
    catch { scopes = {}; warnings.push(this.text('desktop')); }
    let transcripts;
    try { transcripts = this.transcriptIndex(cliRoot); }
    catch (error) { transcripts = new Map(); warnings.push(error.status ? error.message : this.text('metadata')); }
    let metadata = 0, scopeCount = 0;
    for (const [scope, value] of Object.entries(scopes)) {
      if (++scopeCount > LIMITS.directories) throw fail('limit');
      if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(scope) || !Array.isArray(value?.groups)) continue;
      const scopedGroups = new Map();
      if (value.groups.length > LIMITS.metadata) throw fail('limit');
      for (const group of value.groups) if (typeof group?.id === 'string' && typeof group.name === 'string' && group.name) {
        const publicGroup = { id: digest(scope + '/' + group.id), name: group.name, sessions: [] };
        scopedGroups.set(group.id, publicGroup); projects.push(publicGroup);
      }
      const directory = rootOf(path.join(desktop, 'claude-code-sessions', ...scope.split('/')));
      if (!directory || !inside(desktop, directory)) continue;
      const scopeSignature = digest(JSON.stringify(value));
      for (const name of names(directory)) {
        if (!/^local_[A-Za-z0-9_-]{1,160}\.json$/.test(name)) continue;
        if (++metadata > LIMITS.metadata) throw fail('limit');
        try {
          const info = readJSON(desktop, path.join(directory, name)), meta = info.value;
          if (!meta || typeof meta !== 'object') throw fail('format');
          const localId = path.basename(name, '.json'), assignment = value.assignments?.['code:' + localId];
          let group = scopedGroups.get(assignment);
          if (!group) { group = scopedGroups.get('__ungrouped'); if (!group) { group = { id: digest(scope + '/__ungrouped'), name: this.text('grouped'), sessions: [] }; scopedGroups.set('__ungrouped', group); projects.push(group); } }
          const key = digest(desktop + '/' + scope + '/' + localId), id = key;
          const candidates = sessionName.test(String(meta.cliSessionId || '')) ? transcripts.get(meta.cliSessionId) || [] : [];
          const transcript = candidates.length === 1 ? candidates[0] : null;
          const title = typeof meta.title === 'string' && meta.title ? meta.title : this.text('title');
          const session = { id, title, updatedAt: iso(meta.lastActivityAt || meta.createdAt), hasTranscript: Boolean(transcript), source: 'Claude Desktop' };
          group.sessions.push(session);
          lookup.set(id, { ...session, key, groupId: group.id, groupName: group.name, sourceSessionId: meta.cliSessionId, cwd: meta.cwd || meta.originCwd || '', desktopRoot: desktop, metadataFile: info.file, metadataSignature: info.signature, scopeSignature, transcript, cliRoot, reference: { key }, fingerprint: digest(JSON.stringify([info.signature, scopeSignature, transcript, transcript ? stamp(transcript) : ''])) });
        } catch { if (!warnings.includes(this.text('metadata'))) warnings.push(this.text('metadata')); }
      }
      for (const [id, group] of scopedGroups) {
        const order = Array.isArray(value.order?.[id]) ? value.order[id] : [];
        const positions = new Map(order.map((x, i) => ['code:' + String(x).replace(/^code:/, ''), i]));
        group.sessions.sort((a, b) => {
          const local = item => 'code:' + path.basename(lookup.get(item.id).metadataFile, '.json');
          return (positions.get(local(a)) ?? Infinity) - (positions.get(local(b)) ?? Infinity) || b.updatedAt.localeCompare(a.updatedAt);
        });
      }
    }
    this.cliFallback(cliRoot, transcripts, projects, lookup, warnings);
    return { projects, warnings, supported: desktopSupported || Boolean(cliRoot), lookup };
  }
  cliFallback(cliRoot, transcripts, projects, lookup, warnings) {
    if (!cliRoot) return;
    const known = new Set([...lookup.values()].map(entry => entry.sourceSessionId)), groups = new Map(); let bytesRead = 0;
    const candidatesByNewest = [...transcripts.entries()].filter(([sid, candidates]) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sid) && !known.has(sid) && candidates.length === 1)
      .map(([sid, candidates]) => { let modified = 0; try { modified = fs.statSync(candidates[0]).mtimeMs; } catch {} return { sid, candidates, modified }; }).sort((a, b) => b.modified - a.modified);
    for (const { sid, candidates } of candidatesByNewest) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sid) || known.has(sid) || candidates.length !== 1) continue;
      if (lookup.size >= LIMITS.metadata || bytesRead + 64 * 1024 > LIMITS.inputBytes) { warnings.push(this.text('partial')); break; }
      try {
        const file = sourceFile(cliRoot, candidates[0]), before = stamp(file), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let info;
        try {
          if (stamp(file) !== before || sourceFile(cliRoot, file) !== file) throw fail('stale', 409);
          const buffer = Buffer.alloc(64 * 1024), count = fs.readSync(fd, buffer, 0, buffer.length, 0); bytesRead += count;
          if (bytesRead > LIMITS.inputBytes) throw fail('limit');
          const end = buffer.subarray(0, count).lastIndexOf(10); if (end < 0 && fs.fstatSync(fd).size > count) throw fail('limit');
          const lines = buffer.subarray(0, end < 0 ? count : end).toString('utf8').split('\n');
          for (const line of lines) { if (!line.trim()) continue; const value = JSON.parse(line); if (value.sessionId === sid && typeof value.cwd === 'string') { info = { sessionId: value.sessionId, cwd: value.cwd, title: value.title, isSidechain: value.isSidechain }; break; } }
          if (!info) throw fail('format');
          if (stamp(file) !== before) throw fail('stale', 409);
        } finally { fs.closeSync(fd); }
        if (info.sessionId !== sid || info.isSidechain || typeof info.cwd !== 'string' || !path.isAbsolute(info.cwd) || info.cwd.length > 4096) continue;
        const groupId = digest(cliRoot + ':cli:' + info.cwd);
        if (!groups.has(groupId)) { const group = { id: groupId, name: path.basename(info.cwd) || 'Claude CLI', sessions: [] }; groups.set(groupId, group); projects.push(group); }
        const group = groups.get(groupId), id = digest(cliRoot + ':cli:' + file), title = typeof info.title === 'string' && info.title.length <= 2000 && info.title ? info.title : 'Claude CLI ' + sid.slice(0, 8);
        const session = { id, title, updatedAt: fs.statSync(file).mtime.toISOString(), hasTranscript: true, source: 'Claude CLI' }; group.sessions.push(session);
        lookup.set(id, { ...session, key: id, groupId, groupName: group.name, sourceSessionId: sid, cwd: info.cwd, desktopRoot: null, metadataFile: file,
          metadataSignature: digest(JSON.stringify([sid, info.cwd, title])), scopeSignature: '', transcript: file, cliRoot,
          fingerprint: digest(JSON.stringify([sid, info.cwd, title, file, before])) });
      } catch (error) { const warning = this.text(error.code === 'limit' ? 'partial' : 'metadata'); if (!warnings.includes(warning)) warnings.push(warning); }
    }
  }
  inventory() { const { lookup, ...publicResult } = this.scan(); return publicResult; }
  async history(entry, budget) {
    if (!entry.transcript) return { rows: [], signature: '' };
    const file = sourceFile(entry.cliRoot, entry.transcript), size = fs.statSync(file).size, before = stamp(file);
    if (size > LIMITS.fileBytes || budget.input + size > LIMITS.inputBytes) throw fail('limit');
    let lifecycle = { state: 'unknown', event: '', at: '' };
    const rows = [], hash = crypto.createHash('sha256'), decoder = new StringDecoder('utf8'), seen = new Set(); let pending = '', actual = 0;
    const parseLine = line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > LIMITS.lineBytes) throw fail('limit');
      let item; try { item = JSON.parse(line); } catch { throw fail('format'); }
      if (item.type === 'system' && item.subtype === 'turn_duration') lifecycle = { state: 'idle', event: 'turn_duration', at: iso(item.timestamp) };
      if (item.type === 'assistant' && ['end_turn', 'max_tokens'].includes(item.message?.stop_reason)) lifecycle = { state: 'idle', event: item.message.stop_reason, at: iso(item.timestamp) };
      if (!['user', 'assistant'].includes(item.type) || item.isMeta || item.isSidechain || item.message?.role !== item.type) return;
      const content = item.message.content;
      const body = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
      if (!body || /^\s*<(command-|local-command|system-reminder)/.test(body)) return;
      if (item.type === 'user') lifecycle = { state: 'busy', event: 'user', at: iso(item.timestamp) };
      if (item.type === 'assistant' && !['end_turn', 'max_tokens', 'tool_use'].includes(item.message?.stop_reason)) lifecycle = { state: 'unknown', event: 'assistant', at: iso(item.timestamp) };
      const duplicate = item.uuid ? digest(item.type + item.uuid + body) : null; if (duplicate && seen.has(duplicate)) return; if (duplicate) seen.add(duplicate);
      if ((budget.text += Buffer.byteLength(body)) > LIMITS.textBytes || ++budget.rows > LIMITS.rows) throw fail('limit');
      rows.push({ role: item.type, text: body, at: iso(item.timestamp) || entry.updatedAt || new Date(this.now()).toISOString(),  });
    };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { if (sourceFile(entry.cliRoot, file) !== file || stamp(file) !== before) throw fail('stale', 409); }
    catch (error) { fs.closeSync(fd); throw error; }
    const stream = fs.createReadStream(file, { fd, autoClose: true, highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        actual += chunk.length; budget.input += chunk.length;
        if (actual > LIMITS.fileBytes || budget.input > LIMITS.inputBytes) throw fail('limit');
        hash.update(chunk); pending += decoder.write(chunk);
        let end; while ((end = pending.indexOf('\n')) >= 0) { parseLine(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (Buffer.byteLength(pending) > LIMITS.lineBytes) throw fail('limit');
      }
      pending += decoder.end(); if (pending) parseLine(pending);
    } finally { stream.destroy(); }
    if (stamp(file) !== before) throw fail('stale', 409);
    return { rows, signature: hash.digest('hex'), lifecycle, active: lifecycle.state === 'busy' ? true : lifecycle.state === 'idle' ? false : null };
  }
  discover() {
    const scanned = this.scan();
    return { sessions: scanned.projects.flatMap(group => group.sessions.map(session => scanned.lookup.get(session.id))).map(entry => ({ id: entry.id, provider: 'claude', title: entry.title, cwd: entry.cwd,
      projectId: entry.groupId, projectName: entry.groupName, identity: digest(String(entry.sourceSessionId || '') + '\0' + entry.cwd), updatedAt: entry.updatedAt, hasTranscript: entry.hasTranscript, source: entry.source })),
      warnings: scanned.warnings, supported: scanned.supported };
  }
  resolve(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('selection');
    const found = this.scan().lookup.get(id); if (!found) throw fail('missing', 404); return found;
  }
  fingerprint(id) { return this.resolve(id).fingerprint; }
  async read(id, options = {}) {
    const entry = this.resolve(id);
    if (options.expectedSignature && entry.fingerprint !== options.expectedSignature) throw fail('stale', 409);
    const history = await this.history(entry, options.budget || { input: 0, text: 0, rows: 0 });
    if (this.resolve(id).fingerprint !== entry.fingerprint) throw fail('stale', 409);
    return { rows: history.rows, signature: history.signature, lifecycle: history.lifecycle, active: history.active ?? null, warnings: entry.hasTranscript ? [] : [this.language === 'zh-TW' ? '來源會話沒有可讀取的歷史記錄；連結仍會保留' : '元の会話履歴を読めません。リンクは保持します'] };
  }
  referenceFor(id) {
    const entry = this.resolve(id), cwd = rootOf(entry.cwd);
    if (!entry.hasTranscript || !sessionName.test(String(entry.sourceSessionId || '')) || !path.isAbsolute(entry.cwd) || !cwd || !fs.statSync(cwd).isDirectory()) throw fail('missing', 404);
    return { provider: 'claude', sourceSessionId: entry.sourceSessionId, cwd, file: sourceFile(entry.cliRoot, entry.transcript), transcriptPath: sourceFile(entry.cliRoot, entry.transcript), signature: entry.fingerprint, identity: digest(String(entry.sourceSessionId || '') + '\0' + entry.cwd), roots: { claudeConfigDir: path.dirname(entry.cliRoot), HUB_CLAUDE_DESKTOP_DIR: entry.desktopRoot, CLAUDE_CONFIG_DIR: path.dirname(entry.cliRoot) }, fingerprint: entry.fingerprint };
  }
}
module.exports = { ClaudeSessionSource, LIMITS };
