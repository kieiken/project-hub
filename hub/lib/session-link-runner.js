'use strict';
// Resume through native provider protocols; never write conversation transcripts here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const IDS = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_RECEIPTS = 2 * 1024 * 1024;
const ERRORS = {
  input: 'Choose an existing linked session and enter a message.',
  busy: 'This session is already running. Wait for the current turn.',
  source: 'The source session changed or is unavailable. Refresh before continuing.',
  guard: 'Storage Guard stopped this operation. No message was sent.',
  unsupported: 'This source cannot be resumed by its native provider.',
  mismatch: 'The provider returned a different session ID. The turn was stopped.',
  unknown: 'The previous delivery has an unknown outcome. Check the original conversation before sending again.',
  protocol: 'The native provider protocol was not recognized. The turn was stopped.',
  limit: 'The native provider output exceeded the supported limit. The turn was stopped.',
  stopped: 'This turn was stopped.',
  unverified: 'The provider finished, but its update to the original history could not be confirmed.',
};
const error = (code, status = 409) => Object.assign(Error(ERRORS[code]), { code, status });
function fileStamp(file) {
  const actual = fs.realpathSync(file), s = fs.statSync(actual);
  if (!s.isFile()) throw error('source');
  return [actual, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
function sourceSnapshot(file, length) {
  const actual = fs.realpathSync(file), fd = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd), size = length ?? before.size;
    if (!before.isFile() || before.size < size || size > 256 * 1024 * 1024) throw error('source');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
    for (let at = 0; at < size;) { const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - at), at); if (!n) throw error('source'); hash.update(buffer.subarray(0, n)); at += n; }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw error('source');
    return { actual, dev: before.dev, ino: before.ino, size, digest: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function safeParent(file) {
  if (!path.isAbsolute(file)) throw error('source');
  for (let current = file; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw error('source'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current === path.dirname(current)) break;
  }
  if (!fs.statSync(path.dirname(file)).isDirectory()) throw error('source');
}
function guardFor(env) {
  return () => new Promise(resolve => {
    if (!env.HUB_STORAGE_GUARD) return resolve(true);
    execFile(env.HUB_STORAGE_GUARD, [], { env, timeout: 10000 }, (e, out) => resolve(!e && String(out).includes('STATUS=OK')));
  });
}
function nativeCommand(provider, ref, env) {
  const explicit = provider === 'codex' ? env.AI_SESSION_CODEX_BIN : env.AI_SESSION_CLAUDE_BIN;
  if (explicit) return explicit;
  if (process.platform !== 'darwin') return provider;
  const candidates = provider === 'codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex'] : [];
  const desktop = ref.roots?.HUB_CLAUDE_DESKTOP_DIR || env.HUB_CLAUDE_DESKTOP_DIR;
  if (provider === 'claude' && desktop) {
    try {
      const base = path.join(fs.realpathSync(desktop), 'claude-code');
      const versions = fs.readdirSync(base).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 10);
      for (const version of versions) for (const build of fs.readdirSync(path.join(base, version)).filter(v => /^[a-f0-9]{1,64}$/i.test(v)).slice(0, 20)) candidates.push(path.join(base, version, build, 'claude.app/Contents/MacOS/claude'));
    } catch { /* An installed CLI remains a supported fallback. */ }
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } } catch {}
  }
  return provider;
}
class SessionLinkRunner {
  constructor(options) {
    this.referenceFor = options.referenceFor;
    this.history = options.history;
    this.env = { ...process.env, ...(options.env || {}) };
    this.spawn = options.spawn || spawn;
    this.message = options.message || ((_code, value) => value);
    this.guard = options.guard || guardFor(this.env);
    this.commands = options.commands;
    this.receiptsFile = options.receiptsFile;
    this.timeout = options.timeout || 30 * 60 * 1000;
    this.rpcTimeout = options.rpcTimeout || 60000;
    this.runs = new Map(); this.receipts = new Map();
    if (this.receiptsFile && fs.existsSync(this.receiptsFile)) {
      safeParent(this.receiptsFile);
      const fd = fs.openSync(this.receiptsFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let raw;
      try {
        const before = fs.fstatSync(fd); if (before.size > MAX_RECEIPTS) throw error('source');
        const buffer = Buffer.alloc(before.size + 1); let n = 0, read;
        while (n < buffer.length && (read = fs.readSync(fd, buffer, n, buffer.length - n, null))) n += read;
        const after = fs.fstatSync(fd);
        if (n > before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw error('source');
        raw = buffer.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 2000) throw error('source');
      for (const row of rows) { if (!IDS.test(row.requestId || '') || !IDS.test(row.linkId || '') || !UUID.test(row.sourceSessionId || '') || !['claude', 'codex'].includes(row.provider) || !['preparing', 'sending', 'completed', 'unknown'].includes(row.phase) || !Number.isFinite(Date.parse(row.at)) || this.receipts.has(row.requestId)) throw error('source'); this.receipts.set(row.requestId, row); }
    }
  }
  persist(run, phase) {
    this.receipts.set(run.requestId, { requestId: run.requestId, linkId: run.id, sourceSessionId: run.sid, provider: run.provider, phase, at: new Date().toISOString() });
    while (this.receipts.size > 2000) this.receipts.delete(this.receipts.keys().next().value);
    if (!this.receiptsFile) return;
    safeParent(this.receiptsFile);
    const tmp = this.receiptsFile + '.' + crypto.randomUUID() + '.tmp';
    const content = JSON.stringify([...this.receipts.values()]) + '\n'; if (Buffer.byteLength(content) > MAX_RECEIPTS) throw error('source');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.receiptsFile);
    let directory;
    try { directory = fs.openSync(path.dirname(this.receiptsFile), 'r'); fs.fsyncSync(directory); }
    catch (e) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes(e.code)) throw e; }
    finally { if (directory !== undefined) fs.closeSync(directory); }
  }
  busy() { return [...this.runs.values()].some(run => run.busy); }
  alive(run) { if (run.finished) throw error('stopped'); }
  status(id) {
    const run = this.runs.get(id);
    return run ? { id, requestId: run.requestId, busy: run.busy, phase: run.phase, text: [...run.texts.values()].join('\n\n'), error: run.error || '', code: run.code || '',
      verifiedSession: run.verifiedSession || false, historyUpdated: run.historyUpdated || false,
      approvals: [...run.approvals.values()].map(a => ({ id: a.token, kind: a.kind, detail: a.detail })) } : { id, busy: false, phase: 'idle', text: '', error: '', approvals: [] };
  }
  async send({ id, text, requestId }) {
    if (!IDS.test(id || '') || !IDS.test(requestId || '') || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 100000) throw error('input', 400);
    const receipt = this.receipts.get(requestId);
    if (receipt) {
      if (receipt.linkId !== id) throw error('input', 400);
      const current = this.runs.get(id);
      if (current?.requestId === requestId) return this.status(id);
      if (receipt.phase === 'completed') return { id, requestId, busy: false, phase: 'completed', duplicate: true, text: '', error: '', approvals: [] };
      throw error('unknown');
    }
    if (this.runs.get(id)?.busy) throw error('busy');
    const run = { id, requestId, busy: true, phase: 'preparing', texts: new Map(), approvals: new Map(), pending: new Map(), nextRpc: 1, outBytes: 0 };
    this.runs.set(id, run);
    try {
      if (!(await this.guard())) throw error('guard');
      this.alive(run);
      const ref = await this.referenceFor(id);
      this.alive(run);
      run.provider = ref.provider; run.sid = ref.sourceSessionId || ref.sessionId;
      run.file = ref.file || ref.transcriptPath; run.cwd = ref.cwd;
      if (!['claude', 'codex'].includes(run.provider) || !UUID.test(run.sid || '')) throw error('unsupported');
      if (!run.file || !path.isAbsolute(run.cwd || '') || !fs.statSync(run.cwd).isDirectory() || ref.active === true) throw error('source');
      const original = await this.history(id);
      this.alive(run);
      if (original.broken || original.active === true || !original.signature) throw error('source');
      run.originalSignature = original.signature; run.stamp = fileStamp(run.file); run.sourceSnapshot = sourceSnapshot(run.file);
      if (!(await this.guard())) throw error('guard');
      this.alive(run);
      const fresh = await this.referenceFor(id);
      this.alive(run);
      if ((fresh.sourceSessionId || fresh.sessionId) !== run.sid || (fresh.file || fresh.transcriptPath) !== run.file || fileStamp(run.file) !== run.stamp) throw error('source');
      if ([...this.runs.values()].some(other => other !== run && other.busy && other.provider === run.provider && other.sid === run.sid)) throw error('busy');
      this.persist(run, 'preparing');
      const env = { ...this.env };
      if (run.provider === 'codex' && ref.roots?.codexHome) env.CODEX_HOME = ref.roots.codexHome;
      if (run.provider === 'codex' && ref.roots?.sqliteRoot) env.CODEX_SQLITE_HOME = ref.roots.sqliteRoot;
      if (run.provider === 'claude' && (ref.roots?.claudeConfigDir || ref.roots?.CLAUDE_CONFIG_DIR)) env.CLAUDE_CONFIG_DIR = ref.roots.claudeConfigDir || ref.roots.CLAUDE_CONFIG_DIR;
      if (run.provider === 'claude') env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1';
      const args = run.provider === 'codex' ? ['app-server', '--listen', 'stdio://'] :
        ['--resume=' + run.sid, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
      run.child = this.spawn(this.commands?.[run.provider] || nativeCommand(run.provider, ref, env), args, { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.attach(run);
      run.timer = setTimeout(() => this.fail(run, error('protocol')), this.timeout); run.timer.unref?.();
      run.boot = this.start(run, text).catch(e => this.fail(run, e));
      return this.status(id);
    } catch (e) { e.message = this.message(e.code, e.message); this.fail(run, e); throw e; }
  }
  write(run, value) { if (!run.child?.stdin?.writable) throw error('protocol'); run.child.stdin.write(JSON.stringify(value) + '\n'); }
  rpc(run, method, params) {
    const id = run.nextRpc++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(error('protocol')); }, this.rpcTimeout); timer.unref?.();
      run.pending.set(id, { resolve, reject, timer });
      try {
        this.write(run, run.provider === 'codex' ? { id, method, params } : { type: 'control_request', request_id: String(id), request: { subtype: method, ...params } });
      } catch (e) { clearTimeout(timer); run.pending.delete(id); reject(e); }
    });
  }
  async start(run, text) {
    if (run.provider === 'codex') {
      await this.rpc(run, 'initialize', { clientInfo: { name: 'ai_session_link', title: 'AI Session Link', version: '0.1.0' } });
      this.alive(run);
      this.write(run, { method: 'initialized' });
      const read = await this.rpc(run, 'thread/read', { threadId: run.sid, includeTurns: false });
      this.alive(run);
      if (read.thread?.id !== run.sid || read.thread?.status?.type === 'active') throw error(read.thread?.id !== run.sid ? 'mismatch' : 'busy');
      const result = await this.rpc(run, 'thread/resume', { threadId: run.sid });
      this.alive(run);
      if (result.thread?.id !== run.sid) throw error('mismatch');
      await this.acceptNativeBookkeeping(run);
      if (!(await this.guard())) throw error('guard');
      this.alive(run);
      run.verifiedSession = true; run.phase = 'running'; this.persist(run, 'sending');
      run.turnRequested = true; run.earlyFrames = [];
      const started = await this.rpc(run, 'turn/start', { threadId: run.sid, input: [{ type: 'text', text }] });
      if (typeof started.turn?.id !== 'string' || !started.turn.id || started.turn.id.length > 160) throw error('protocol');
      run.turnId = started.turn.id;
      for (const frame of run.earlyFrames.splice(0)) this.frame(run, frame);
    } else {
      await this.rpc(run, 'initialize', { hooks: null });
      this.alive(run);
      await this.acceptNativeBookkeeping(run);
      if (!(await this.guard())) throw error('guard');
      this.alive(run);
      run.phase = 'running'; this.persist(run, 'sending');
      this.write(run, { type: 'user', session_id: run.sid, parent_tool_use_id: null, message: { role: 'user', content: text } });
    }
  }
  async acceptNativeBookkeeping(run) {
    if (fileStamp(run.file) === run.stamp) return;
    const boundStamp = fileStamp(run.file), prior = run.sourceSnapshot, now = sourceSnapshot(run.file, prior.size), size = fs.statSync(run.file).size;
    if (fileStamp(run.file) !== boundStamp) throw error('source');
    if (now.actual !== prior.actual || now.dev !== prior.dev || now.ino !== prior.ino || now.digest !== prior.digest || size < prior.size || size - prior.size > 128 * 1024) throw error('source');
    const fd = fs.openSync(now.actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), tail = Buffer.alloc(size - prior.size);
    try { if (fs.readSync(fd, tail, 0, tail.length, prior.size) !== tail.length) throw error('source'); } finally { fs.closeSync(fd); }
    const lines = tail.length ? tail.toString('utf8').trim().split('\n') : [];
    if (lines.length > 128) throw error('source');
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { throw error('source'); }
      // Official resume writes these administrative rows before a new user turn.
      const allowed = run.provider === 'codex' ? row.type === 'event_msg' && row.payload?.type === 'thread_settings_applied' :
        ['mode', 'cost-state'].includes(row.type) && row.sessionId === run.sid;
      if (!allowed) throw error('source');
    }
    if (fileStamp(run.file) !== boundStamp) throw error('source');
    const history = await this.history(run.id);
    if (history.broken || history.active === true || !history.signature || fileStamp(run.file) !== boundStamp) throw error('source');
    run.originalSignature = history.signature; run.stamp = boundStamp;
  }
  attach(run) {
    const child = run.child; let rest = '';
    child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', part => {
      run.outBytes += Buffer.byteLength(part); rest += part;
      if (run.outBytes > 64 * 1024 * 1024 || Buffer.byteLength(rest) > 8 * 1024 * 1024) return this.fail(run, error('limit'));
      let end; while ((end = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, end); rest = rest.slice(end + 1);
        if (!line.trim()) continue;
        try { this.frame(run, JSON.parse(line)); } catch (e) { this.fail(run, e.code ? e : error('protocol')); }
      }
    });
    child.stderr.on('data', part => { run.stderr = ((run.stderr || '') + part).slice(-4000); });
    child.on('error', e => this.fail(run, Object.assign(Error(e.code === 'ENOENT' ? 'The native provider CLI is not installed or is not on PATH.' : 'The native provider could not start.'), { code: 'cli' })));
    child.once('close', code => {
      run.closed = true;
      if (run.finished) { run.busy = false; clearTimeout(run.killTimer); return; }
      if (!run.result || code !== 0) return this.fail(run, Object.assign(Error(run.resultError || run.stderr || 'The native provider ended before completing the turn.'), { code: 'provider' }));
      this.complete(run).catch(e => this.fail(run, e));
    });
  }
  pendingReply(run, id, result, failure) {
    const pending = run.pending.get(Number(id)); if (!pending) return false;
    clearTimeout(pending.timer); run.pending.delete(Number(id));
    if (failure) pending.reject(Object.assign(Error(String(failure.message || failure)), { code: 'provider' })); else pending.resolve(result || {});
    return true;
  }
  finishClaude(run) {
    // A result closes one turn. Delegated native work can still need this
    // control channel for permissions and its continuation turn.
    if (!run.claudeResultReceived || run.claudeTurnInProgress || run.claudeTasks?.size || run.approvals.size || run.claudeInputEnded) return;
    if (run.claudeState !== undefined && run.claudeState !== 'idle') return;
    run.claudeInputEnded = true; run.child.stdin.end();
  }
  frame(run, value) {
    if (run.finished) return;
    if (run.provider === 'claude' && value.type === 'control_response') {
      const response = value.response || {}; this.pendingReply(run, response.request_id, response.response, response.subtype === 'error' ? response.error : null); return;
    }
    if (run.provider === 'codex' && !value.method && value.id != null) { this.pendingReply(run, value.id, value.result, value.error); return; }
    if (run.provider === 'claude') {
      if (value.session_id && ['system', 'assistant', 'result'].includes(value.type)) {
        if (value.session_id !== run.sid) throw error('mismatch'); run.verifiedSession = true;
      }
      if (value.type === 'system') {
        if (!run.claudeTasks) run.claudeTasks = new Set();
        const taskId = value.task_id;
        if (value.subtype === 'task_started' && ['local_agent', 'local_workflow'].includes(value.task_type)) {
          if (typeof taskId !== 'string' || !taskId || taskId.length > 160 || run.claudeTasks.size >= 256 && !run.claudeTasks.has(taskId)) throw error('limit');
          run.claudeTasks.add(taskId);
        } else if (value.subtype === 'task_notification' || value.subtype === 'task_updated' && ['completed', 'failed', 'stopped', 'killed'].includes(value.patch?.status)) {
          run.claudeTasks.delete(taskId);
          // A terminal task can wake its parent for another turn; wait for
          // that result or the provider's idle event instead of closing now.
        } else if (value.subtype === 'session_state_changed') {
          if (!['idle', 'running', 'requires_action'].includes(value.state)) throw error('protocol');
          run.claudeState = value.state;
          if (value.state === 'idle') this.finishClaude(run);
        }
      }
      if (value.type === 'control_cancel_request') {
        for (const [id, approval] of run.approvals) if (String(approval.nativeId) === String(value.request_id)) run.approvals.delete(id);
        return;
      }
      if (value.type === 'control_request') {
        if (value.request?.subtype !== 'can_use_tool') return this.write(run, { type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'Unsupported client request; use the original application.' } });
        this.approval(run, value.request_id, 'tool', { tool: value.request.tool_name, input: value.request.input, reason: value.request.decision_reason }, value.request); return;
      }
      if (['assistant', 'stream_event'].includes(value.type) && value.parent_tool_use_id == null) run.claudeTurnInProgress = true;
      if (value.type === 'assistant') {
        if (!run.verifiedSession) throw error('protocol');
        const text = (value.message?.content || []).filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
        if (text) run.texts.set(value.message?.id || value.uuid || String(run.texts.size), text);
      }
      if (value.type === 'result') {
        if (!run.verifiedSession) throw error('protocol');
        run.result = !value.is_error; run.resultError = value.is_error ? String(value.result || 'The provider rejected the turn.') : '';
        run.claudeResultReceived = true; run.claudeTurnInProgress = false;
        this.finishClaude(run);
      }
    } else {
      const p = value.params || {};
      if (p.threadId && p.threadId !== run.sid) throw error('mismatch');
      const scoped = /^(item\/|turn\/)/.test(value.method || '');
      if (scoped) {
        if (!run.turnRequested) return;
        if (!run.turnId) { if (run.earlyFrames.length >= 100 || Buffer.byteLength(JSON.stringify(run.earlyFrames)) > 2 * 1024 * 1024) throw error('limit'); run.earlyFrames.push(value); return; }
        const turnId = p.turnId || p.turn?.id;
        if (!turnId) throw error('protocol');
        if (turnId !== run.turnId) return;
      }
      if (value.method === 'serverRequest/resolved') for (const [key, a] of run.approvals) if (String(a.nativeId) === String(p.requestId)) run.approvals.delete(key);
      if (value.id != null && value.method) {
        const kinds = { 'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'file', 'item/permissions/requestApproval': 'permissions' };
        if (!kinds[value.method]) return this.write(run, { id: value.id, error: { code: -32601, message: 'Unsupported client request; use the original application.' } });
        if (!run.verifiedSession || (run.turnId && p.turnId !== run.turnId)) throw error('mismatch');
        this.approval(run, value.id, kinds[value.method], p, p); return;
      }
      if (value.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') run.texts.set(p.item.id, p.item.text);
      if (value.method === 'item/agentMessage/delta') run.texts.set(p.itemId, (run.texts.get(p.itemId) || '') + String(p.delta || ''));
      if (value.method === 'turn/completed') {
        if (!run.verifiedSession) throw error('protocol');
        run.result = p.turn?.status === 'completed'; run.resultError = run.result ? '' : String(p.turn?.error?.message || 'The native turn did not complete.');
        run.child.stdin.end();
      }
    }
    if (Buffer.byteLength([...run.texts.values()].join('')) > 4 * 1024 * 1024) throw error('limit');
  }
  approval(run, nativeId, kind, detail, original) {
    if (run.approvals.size >= 16 || Buffer.byteLength(JSON.stringify(detail)) > 512000) throw error('limit');
    const token = crypto.randomUUID(); run.approvals.set(token, { token, nativeId, kind, detail, original }); run.phase = 'approval';
  }
  answer({ id, approvalId, allow }) {
    const run = this.runs.get(id), item = run?.approvals.get(approvalId);
    if (!run?.busy || !item || typeof allow !== 'boolean') throw error('input', 400);
    if (run.provider === 'claude') this.write(run, { type: 'control_response', response: { subtype: 'success', request_id: item.nativeId,
      response: allow ? { behavior: 'allow', updatedInput: item.original.input } : { behavior: 'deny', message: 'The user declined this tool operation.' } } });
    else this.write(run, { id: item.nativeId, result: item.kind === 'permissions' ? { permissions: allow ? item.original.permissions || {} : {}, scope: 'turn' } : { decision: allow ? 'accept' : 'decline' } });
    run.approvals.delete(approvalId); run.phase = run.approvals.size ? 'approval' : 'running'; return this.status(id);
  }
  async complete(run) {
    if (!run.verifiedSession) throw error('mismatch');
    if (run.provider === 'claude' && (run.claudeTasks?.size || run.claudeTurnInProgress || run.approvals.size || run.claudeState !== undefined && run.claudeState !== 'idle')) throw error('protocol');
    const history = await this.history(run.id);
    run.historyUpdated = !history.broken && Boolean(history.signature && history.signature !== run.originalSignature);
    if (!run.historyUpdated) throw error('unverified');
    try { this.persist(run, 'completed'); } catch { throw error('unknown'); }
    run.phase = 'completed'; run.busy = false; run.finished = true; this.cleanup(run);
  }
  cleanup(run) { clearTimeout(run.timer); for (const p of run.pending.values()) { clearTimeout(p.timer); p.reject(error('protocol')); } run.pending.clear(); run.approvals.clear(); }
  fail(run, e) {
    if (run.finished) return;
    run.finished = true; run.busy = Boolean(run.child && !run.closed && run.child.exitCode == null); run.phase = e.code === 'stopped' ? 'stopped' : 'failed'; run.error = this.message(e.code, e.message || ERRORS.protocol); run.code = e.code || 'protocol';
    this.cleanup(run);
    if (run.child && !run.closed && !run.child.killed) {
      run.child.kill('SIGTERM');
      if (run.busy) { run.killTimer = setTimeout(() => { if (run.child.exitCode == null) run.child.kill('SIGKILL'); }, 5000); run.killTimer.unref?.(); }
    }
    if (run.sid && this.receipts.has(run.requestId)) { try { this.persist(run, 'unknown'); } catch { run.error = ERRORS.unknown; run.code = 'unknown'; } }
  }
  async stop(id) {
    const run = this.runs.get(id); if (!run?.busy) return this.status(id);
    try {
      if (run.provider === 'codex' && run.turnId) await this.rpc(run, 'turn/interrupt', { threadId: run.sid, turnId: run.turnId });
      else if (run.provider === 'claude') await this.rpc(run, 'interrupt', {});
    } catch { /* Only the process started by this runner may be stopped. */ }
    this.fail(run, error('stopped')); return this.status(id);
  }
}
module.exports = { SessionLinkRunner, ERRORS, fileStamp, nativeCommand };
