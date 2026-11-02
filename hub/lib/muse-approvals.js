'use strict';
// Human UI control plane. Reserve a decision before issuing authority; uncertain
// execution never becomes an automatic retry, including after a Hub restart.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { checkDirectory } = require('./muse-settings');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
function read(file) {
  checkDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.size > 2 * 1024 * 1024) throw Error('approval file');
    const raw = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('changed file');
    return { value: JSON.parse(raw), sha: sha(raw) };
  } finally { fs.closeSync(fd); }
}
class MuseApprovals {
  constructor({ muse, dispatch, probe, now = Date.now }) {
    Object.assign(this, { muse, dispatch, probe, now }); this.tickets = new Map();
  }
  location(project, task, id) {
    this.muse.workspace(project, task, { tool: false });
    if (!idPattern.test(id)) throw Error('id');
    const dir = path.join(this.muse.root, 'Product', project, '.ai', 'muse-approvals');
    return { dir, file: path.join(dir, id + '.json'), decisions: path.join(dir, '.decisions', task),
      decision: path.join(dir, '.decisions', task, id + '.json') };
  }
  request(project, task, id) {
    const loc = this.location(project, task, id), row = read(loc.file), v = row.value;
    if (!v || v.schema !== 1 || v.id !== id || v.project !== project || v.task !== task ||
        Object.keys(v).some(k => !['schema','id','project','task','kind','request','continuation','createdAt'].includes(k)) ||
        !['research','permit'].includes(v.kind) || !v.request || typeof v.request !== 'object' || Array.isArray(v.request) ||
        !v.continuation || Object.keys(v.continuation).some(k => !['role','text'].includes(k)) ||
        typeof v.continuation.role !== 'string' || typeof v.continuation.text !== 'string' ||
        !v.continuation.text.trim() || v.continuation.text.length > 6000 || !Number.isFinite(Date.parse(v.createdAt))) throw Error('approval schema');
    return { ...loc, ...row };
  }
  decision(loc) {
    try { return read(loc.decision).value; } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  cleanTickets() {
    for (const [k,v] of this.tickets) if (this.now() >= v.expires) this.tickets.delete(k);
    if (this.tickets.size >= 256) throw Error('ticket capacity');
  }
  async list(project, task) {
    // No request directory is created by reads; an unprepared task has no cards.
    const loc = this.location(project, task, 'index');
    if (!fs.existsSync(loc.dir)) return { approvals: [] };
    checkDirectory(loc.dir); this.cleanTickets();
    const names = fs.readdirSync(loc.dir).filter(n => n.endsWith('.json'));
    if (names.length > 10000) throw Error('too many approvals');
    const approvals = [];
    for (const name of names) {
      const id = name.slice(0,-5);
      const raw = read(path.join(loc.dir,name)).value;
      if (raw.task !== task || ['direct','direct-read','direct-poll'].includes(raw.kind)) continue;
      if(approvals.length>=100)throw Error('too many approvals');
      const row = this.request(project, task, id), decision = this.decision(row);
      if (decision) { approvals.push({ id, state: decision.state }); continue; }
      let preview;
      try { preview = await this.muse.approvalPreview(project, task, row.file); }
      catch {
        // An expired scope or temporarily locked workspace must not hide the
        // other requests. No authority was issued and no ticket is created.
        approvals.push({ id, state: 'unavailable' }); continue;
      }
      // A file changed during helper execution cannot acquire a ticket.
      if (this.request(project, task, id).sha !== row.sha) throw Error('changed request');
      let ticket;
      for (const [key,t] of this.tickets) if (t.project === project && t.task === task && t.id === id && t.sha === row.sha && t.digest === preview.action_digest) ticket = key;
      if (!ticket) {
        this.cleanTickets(); ticket = crypto.randomUUID();
        this.tickets.set(ticket, { project, task, id, sha: row.sha, digest: preview.action_digest, expires: this.now() + 600000 });
      }
      approvals.push({ id, state: 'pending', ticket, preview });
    }
    return { approvals };
  }
  save(loc, value, exclusive = false) {
    for (const dir of [path.dirname(loc.decisions), loc.decisions]) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if(e.code !== 'EEXIST') throw e; }
      checkDirectory(dir);
    }
    const raw = JSON.stringify(value) + '\n';
    if (exclusive) {
      const fd = fs.openSync(loc.decision, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd,raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else {
      read(loc.decision);
      const tmp = loc.decision + '.' + crypto.randomUUID() + '.tmp';
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd,raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp,loc.decision);
    }
    const fd = fs.openSync(loc.decisions, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  async decide(b) {
    const t = this.tickets.get(b.ticket);
    if (!t || t.project !== b.project || t.task !== b.task || t.id !== b.id || this.now() >= t.expires) throw Error('ticket');
    // Synchronous consume + exclusive durable reservation precede the first await.
    this.tickets.delete(b.ticket);
    const row = this.request(b.project,b.task,b.id);
    if (row.sha !== t.sha || this.decision(row)) throw Error('changed or already decided');
    const continuation = { project: b.project, task: b.task, role: row.value.continuation.role,
      title: 'Muse承認後の続き', text: row.value.continuation.text,
      requestKey: 'muse-approval:' + b.id };
    if (b.decision === 'approve') this.probe(continuation);
    const decision = { schema:1, project:b.project, task:b.task, id:b.id, requestSHA:t.sha,
      digest:t.digest, decision:b.decision, state:b.decision === 'decline' ? 'declined' : 'unknown', at:new Date(this.now()).toISOString() };
    this.save(row,decision,true);
    if (b.decision === 'decline') return { ok:true, state:'declined' };
    try {
      const grant = await this.muse.approvalIssue(b.project,b.task,row.file,t.digest);
      decision.grant = grant; decision.state = 'approved'; this.save(row,decision);
      // Only fixed, task-bound metadata is added. The continuation reads the saved
      // grant; it must not ask the owner to type an ID or approve again in scope.
      continuation.text += '\nMuseの本人承認済みです。許可と入力は台帳の .ai/muse-approvals/.decisions/' + b.task + '/' + b.id + '.json と .ai/muse-approvals/' + b.id + '.json にあります。承認範囲内で続きを実行し、結果をこの会話へ返してください。不明な送信は再送しません。';
      decision.state = 'unknown'; decision.stage = 'continuation'; this.save(row,decision);
      const accepted = await this.dispatch(continuation);
      if (!accepted?.ok) throw Error('continuation unknown');
      decision.state = 'accepted'; this.save(row,decision);
      return { ok:true, state:'accepted' };
    } catch {
      decision.state = 'unknown';
      try { this.save(row,decision); } catch { /* Durable intent remains; never retry. */ }
      return { ok:false, state:'unknown', notice:'結果の照合が必要です。承認・送信を繰り返さず、この会話で確認を依頼してください。' };
    }
  }
}
module.exports = { MuseApprovals, read };
