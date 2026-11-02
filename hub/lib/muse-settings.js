'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const expected = require('./muse/tool-hashes.json');
const helper = path.join(__dirname, 'muse', 'terminal.py');

function checkDirectory(folder) {
  if (!path.isAbsolute(folder) || path.normalize(folder) !== folder) throw Error('path');
  let current = path.parse(folder).root;
  for (const part of folder.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('path');
  }
  const st = fs.lstatSync(folder);
  if (st.uid !== process.getuid() || (st.mode & 0o022)) throw Error('owner');
}

class MuseSettings {
  constructor({ root, platform = process.platform, run = promisify(execFile), hashes = expected }) {
    this.root = root;
    this.file = path.join(root, '_hub', 'muse-tool.json');
    // Exact migration location of the already approved installation, never a home scan.
    this.existing = path.join(root, 'Work', 'Project Hub', '20260926-hub-v2', '.ai', 'work', 'metamuse-local-20261024');
    this.platform = platform; this.run = run; this.hashes = hashes;
    this.usageBusy = false;
  }
  validate(folder) {
    checkDirectory(folder);
    for (const [name, hash] of Object.entries(this.hashes)) {
      const file = path.join(folder, name);
      checkDirectory(path.dirname(file));
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) || st.nlink !== 1 || st.size > 2 * 1024 * 1024) throw Error('tool');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== hash) throw Error('version'); }
      finally { fs.closeSync(fd); }
    }
    return folder;
  }
  folder() {
    if (!fs.existsSync(this.file)) return null;
    const st = fs.lstatSync(this.file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 16384) throw Error('selection');
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { return this.validate(JSON.parse(fs.readFileSync(fd, 'utf8')).folder); }
    finally { fs.closeSync(fd); }
  }
  select(folder) {
    if (this.platform !== 'darwin') throw Error('mac required');
    this.validate(folder);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    checkDirectory(path.dirname(this.file));
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ folder }) + '\n', { mode: 0o600, flag: 'wx' });
      if (fs.existsSync(this.file)) {
        const st = fs.lstatSync(this.file);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1) throw Error('selection');
      }
      fs.renameSync(tmp, this.file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  selectExisting() { this.select(this.existing); }
  async status() {
    if (this.platform !== 'darwin') return { supported: false, toolReady: false, configured: false };
    const folder = this.folder();
    if (!folder) {
      let existingAvailable = false;
      try { this.validate(this.existing); existingAvailable = true; } catch { /* No discovery beyond this exact legacy path. */ }
      return { supported: true, toolReady: false, configured: false, existingAvailable };
    }
    // Only projected metadata leaves the sandbox; no credential, reply text or auth reference.
    const { stdout } = await this.run('/usr/bin/python3', ['-I', helper, folder, 'status'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 15000, maxBuffer: 8192,
    });
    const s = JSON.parse(stdout);
    if (typeof s.configured !== 'boolean' || typeof s.trialUsed !== 'boolean' || typeof s.replyReceived !== 'boolean') throw Error('status');
    const result = { supported: true, toolReady: true, configured: s.configured, trialUsed: s.trialUsed,
      replyReceived: s.replyReceived, completionVerified: s.completionVerified === true, busy: s.busy === true };
    if (s.configured) {
      try { Object.assign(result, await this.usageCall('usage-status')); }
      catch { result.usage = null; }
    }
    return result;
  }
  async usageCall(operation) {
    if (!['usage-read','usage-status'].includes(operation) || this.platform !== 'darwin') throw Error('usage');
    const tool = this.folder();
    if (!tool) throw Error('usage');
    const {stdout} = await this.run('/usr/bin/python3', ['-I', path.join(__dirname, 'muse', 'hub_launcher.py'),
      '--bundle', tool, operation], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 75000, maxBuffer: 16384,
    });
    return projectUsage(JSON.parse(stdout));
  }
  async usageRead() {
    if (this.usageBusy) return { usage: null, error: 'busy' };
    this.usageBusy = true;
    try {
      const s = await this.status();
      if (!s.configured) return { usage:null, error:'unconfigured' };
      if (s.busy) return { usage:null, error:'busy' };
      return await this.usageCall('usage-read');
    }
    catch { return { usage: null, error: 'network' }; }
    finally { this.usageBusy = false; }
  }
  async command(action, quote) {
    if (!['register', 'update', 'disconnect'].includes(action)) throw Error('action');
    const s = await this.status();
    if (!s.supported || !s.toolReady || s.busy || (action === 'register' ? s.configured : !s.configured)) throw Error('state');
    return ['/usr/bin/python3', '-I', helper, this.folder(), action].map(quote).join(' ');
  }
  workspace(project, task, { tool: requireTool = true } = {}) {
    const component = value => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
      !['.', '..'].includes(value) && !/[\/\\\p{Cc}\p{Cf}]/u.test(value);
    if (this.platform !== 'darwin' || !component(project) || !component(task)) throw Error('context');
    const folder = path.join(this.root, 'Product', project);
    checkDirectory(folder); checkDirectory(path.join(folder, '.ai', 'tasks'));
    const st = fs.lstatSync(path.join(folder, '.ai', 'tasks', task + '.md'));
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()) throw Error('task');
    if (!requireTool) return { project, task };
    const tool = this.folder(); if (!tool) throw Error('tool');
    return { project, task, tool };
  }
  workspaceCommand(project, task, quote) {
    const context = this.workspace(project, task);
    return ['/usr/bin/python3', '-I', helper, context.tool, 'workspace', context.project, context.task].map(quote).join(' ');
  }
  async approvalCall(project, task, file, digest) {
    const context = this.workspace(project, task);
    const { stdout } = await this.run('/usr/bin/python3', ['-I', path.join(__dirname, 'muse', 'hub_launcher.py'),
      '--bundle', context.tool, '--project', project, '--task', task,
      ...(digest ? ['--checked-digest', digest] : []), digest ? 'approval-issue' : 'approval-preview', file], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
    const value = JSON.parse(stdout);
    if (digest) {
      if (value.status !== 'ok' || !value.data || typeof value.data !== 'object') throw Error('approval issue');
      // Return grant metadata only; auth references and arbitrary helper output stay private.
      return Object.fromEntries(Object.entries(value.data).filter(([k,v]) =>
        ['id','access_grant_id','share_grant_id','discussion_id','expires_at','max_uses'].includes(k) &&
        (typeof v === 'string' || Number.isSafeInteger(v))));
    }
    if (!/^[a-f0-9]{64}$/.test(value.action_digest) ||
        !['destination','topic','packet_full_text','summary','expires_at'].every(k => typeof value[k] === 'string') ||
        !Number.isSafeInteger(value.rounds) || value.rounds < 1 || !Number.isSafeInteger(value.max_reads) || value.max_reads < 0 ||
        !value.request || typeof value.request !== 'object' || Array.isArray(value.request)) throw Error('approval preview');
    return Object.fromEntries(['action_digest','destination','topic','packet_full_text','summary','expires_at','rounds','max_reads','request'].map(k => [k,value[k]]));
  }
  approvalPreview(project, task, file) { return this.approvalCall(project, task, file); }
  approvalIssue(project, task, file, digest) { return this.approvalCall(project, task, file, digest); }
  directChat(project, task, file, signal) { return this.directCall(project,task,file,signal,'direct-chat'); }
  directRead(project, task, file, signal) { return this.directCall(project,task,file,signal,'direct-read'); }
  directPoll(project, task, file, signal) { return this.directCall(project,task,file,signal,'direct-poll'); }
  async directInspect(project, task, file, signal) {
    const context=this.workspace(project,task);
    const {stdout}=await this.run('/usr/bin/python3',['-I',path.join(__dirname,'muse','hub_launcher.py'),
      '--bundle',context.tool,'--project',project,'--task',task,'direct-inspect',file], {
      signal,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},timeout:30000,maxBuffer:8192,
    });
    const v=JSON.parse(stdout);
    const sent=v.status==='sent'&&v.scope==='acknowledged-send'&&typeof v.exchange_id==='string';
    if(!(sent||v.status==='not-sent'&&['question-only','follow-up-none'].includes(v.scope))||v.open_confirmed!==true||v.project!==project||v.task!==task||
       !/^direct_[a-f0-9-]{36}$/.test(v.id)||typeof v.discussion_id!=='string'||
       !['requestSHA','decisionSHA','markerSHA','digest'].every(k=>/^[a-f0-9]{64}$/.test(v[k])))throw Error('unproven send');
    return Object.fromEntries(['status','scope','open_confirmed','project','task','id','discussion_id',...(sent?['exchange_id']:[]),'requestSHA','decisionSHA','markerSHA','digest'].map(k=>[k,v[k]]));
  }
  async directCall(project, task, file, signal, operation) {
    const context = this.workspace(project,task);
    const {stdout} = await this.run('/usr/bin/python3', ['-I', path.join(__dirname,'muse','hub_launcher.py'),
      '--bundle',context.tool,'--project',project,'--task',task,'--run',operation,file], {
      signal,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},timeout:180000,maxBuffer:2*1024*1024,
    });
    const value=JSON.parse(stdout);
    if(value.status==='not-sent') {
      const d=value.diagnostic;
      if(operation!=='direct-chat'||!d||d.code!=='exchange_limit'||d.phase!=='send_prepare'||d.open_confirmed!==true)throw Error('Muse diagnosis unknown');
      return {status:'not-sent',diagnostic:{code:d.code,phase:d.phase,open_confirmed:true}};
    }
    if(['rejected','unknown'].includes(value.status)) {
      const d=value.diagnostic;
      if(!d||!['before_send_rejected','send_uncertain'].includes(d.code)||
         !['prepare','open','history','send_prepare','send'].includes(d.phase)||typeof d.open_confirmed!=='boolean'||
         (value.status==='rejected')!==(d.code==='before_send_rejected')||
         (value.status==='unknown')!==(d.phase==='send'))throw Error('Muse diagnosis unknown');
      return {status:value.status,diagnostic:{code:d.code,phase:d.phase,open_confirmed:d.open_confirmed}};
    }
    if(!['sent','received'].includes(value.status)||value.status==='received'&&(typeof value.text!=='string'||!value.text.trim())||
       value.text!==undefined&&(typeof value.text!=='string'||value.text.length>200000)||
       value.status==='sent'&&value.text!==undefined&&value.partial!==true||
       value.partial!==undefined&&(value.partial!==true||value.status!=='sent'||!value.text?.trim())||
       !['discussion_id','exchange_id'].every(k=>typeof value[k]==='string'))throw Error('Muse response unknown');
    return {status:value.status,...(value.text!==undefined?{text:value.text}:{}),...(value.partial?{partial:true}:{}),discussion_id:value.discussion_id,exchange_id:value.exchange_id,completion_verified:false};
  }
  async workspacePermits(project, task) {
    const context = this.workspace(project, task);
    const { stdout } = await this.run('/usr/bin/python3', ['-I', path.join(__dirname, 'muse', 'hub_launcher.py'),
      '--bundle', context.tool, '--project', project, '--task', task, 'permits'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 30000, maxBuffer: 65536,
    });
    const value = JSON.parse(stdout);
    if (!Array.isArray(value.permits) || value.permits.length > 200) throw Error('permits');
    return { permits: value.permits.map(p => {
      if (typeof p.id !== 'string' || typeof p.kind !== 'string' || typeof p.expires_at !== 'string' ||
          !Number.isSafeInteger(p.remaining) || p.remaining < 0 || typeof p.revoked !== 'boolean') throw Error('permit');
      return { id: p.id, kind: p.kind, expiresAt: p.expires_at, remaining: p.remaining,
        revoked: p.revoked, target: typeof p.target === 'string' ? p.target : '', account: typeof p.account === 'string' ? p.account : '' };
    }) };
  }
}
// This is also applied to the local cache: helper output is never forwarded whole.
function projectUsage(value) {
  const errors = ['auth','site_changed','network','format','unconfigured','busy'];
  if (!value || typeof value !== 'object') throw Error('usage');
  if (value.usage == null) return { usage: null, ...(errors.includes(value.error) ? {error:value.error} : {}) };
  const u = value.usage;
  const label = s => s == null ? null : typeof s === 'string' && s.length > 0 && s.length <= 96 &&
    /^[\p{L}\p{N}_ .,%$()+/\-]+$/u.test(s) && !/[A-Za-z0-9_\-]{32,}/.test(s) ? s : null;
  const date = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
  if (typeof u.usedPercent !== 'number' || !Number.isFinite(u.usedPercent) || u.usedPercent < 0 || u.usedPercent > 100 || !date(u.checkedAt)) throw Error('usage');
  return {usage:{plan:label(u.plan),usedPercent:u.usedPercent,resetsAt:date(u.resetsAt),
    tokensLeftLabel:label(u.tokensLeftLabel),renewsAt:date(u.renewsAt),
    topup:u.topup && label(u.topup.label) && label(u.topup.value) ? {label:label(u.topup.label),value:label(u.topup.value)} : null,
    checkedAt:date(u.checkedAt)}};
}
module.exports = { MuseSettings, checkDirectory, projectUsage };
