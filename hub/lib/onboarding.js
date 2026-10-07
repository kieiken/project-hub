'use strict';
const { lt } = require('./locale');
// 初回案内だけを保存する。CLIの確認は固定の読み取りコマンドに限定する。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AIS, childEnv } = require('./launch');
const STEPS = ['ai', 'cli', 'check', 'first'];
const STATUSES = ['in-progress', 'skipped', 'done'];
function invalid() { return Object.assign(Error(lt('はじめの設定の指定が正しくありません')), { status: 400 }); }
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['status', 'step', 'ais'].includes(k)) ||
      !STATUSES.includes(body.status) || !STEPS.includes(body.step) ||
      !Array.isArray(body.ais) || !body.ais.length || body.ais.length > AIS.length ||
      body.ais.some(ai => !AIS.includes(ai)) || new Set(body.ais).size !== body.ais.length) throw invalid();
  return { status: body.status, step: body.step, ais: [...body.ais] };
}
function runStatus(file, args, timeout) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024, env: childEnv(path.basename(file) === 'grok' ? 'grok' : '', process.env) }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, failed: Boolean(error && (error.killed || typeof error.code !== 'number')),
        text: String(stdout || '') + '\n' + String(stderr || ''), stdout: String(stdout || '') });
    });
  });
}
function agyStatus(home) {
  // 固定の状態だけを返す。設定の存在はログイン済みの証明にはならない。
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        (settings.modelProvider !== undefined && (typeof settings.modelProvider !== 'string' || !settings.modelProvider))) {
      return { login: 'unknown', notice: 'settings-unreadable' };
    }
    return settings.modelProvider && settings.modelProvider !== 'antigravity'
      ? { login: 'unknown', notice: 'api-provider' } : { login: 'unknown' };
  } catch (e) {
    return e.code === 'ENOENT' ? { login: 'required' } : { login: 'unknown', notice: 'settings-unreadable' };
  }
}
class Onboarding {
  constructor({ root, home, tools, projects, terminal, dry = false, run = runStatus, timeout = 5000 }) {
    Object.assign(this, { root, home, tools, projects, terminal, dry, run, timeout });
    this.file = path.join(root, '_hub', 'onboarding.json');
    this.pending = null;
  }
  existing() {
    if (fs.existsSync(path.join(this.root, '_hub', 'log.jsonl'))) return true;
    const seed = path.join(__dirname, '..', 'seed');
    return this.projects().some(p => p.tasks.some(t => {
      // 同じIDのサンプルでも、使って編集済みなら既存利用者として扱う。
      try {
        return !fs.readFileSync(path.join(p.dir, '.ai', 'tasks', t.id + '.md'))
          .equals(fs.readFileSync(path.join(seed, p.id, '.ai', 'tasks', t.id + '.md')));
      } catch { return true; }
    }));
  }
  state() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (doc.version !== 1) throw invalid();
      const clean = validate({ status: doc.status, step: doc.step, ais: doc.ais });
      return { version: 1, ...clean, auto: clean.status === 'in-progress' && !this.existing() };
    } catch (e) {
      if (e.code !== 'ENOENT') return { status: 'skipped', step: 'ai', ais: ['claude'], auto: false, warning: lt('案内の記録を読めませんでした。設定から開き直せます。') };
      return { status: 'new', step: 'ai', ais: ['claude'], auto: !this.existing() };
    }
  }
  save(body) {
    const clean = validate(body), value = { version: 1, ...clean, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* 書き込み成功時は存在しない */ } }
    return this.state();
  }
  async login(ai, file) {
    if (!file || this.dry) return 'unknown';
    if (ai === 'agy') return agyStatus(this.home).login;
    if (ai === 'grok') {
      const result = await this.run(file, ['models'], this.timeout);
      const auth = require('./grok').authStatus({ stdout: result.stdout, error: result.failed || result.code !== 0 ? { code: result.code } : null });
      return auth.status === 'logged-in' ? 'ready' : auth.status === 'logged-out' ? 'required' : 'unknown';
    }
    const args = ai === 'codex' ? ['login', 'status'] : ['auth', 'status'];
    const started = Date.now();
    const help = await this.run(file, [...args, '--help'], this.timeout);
    if (help.failed || help.code !== 0 || !/Show (?:login|authentication) status/i.test(help.text)) return 'unknown';
    const left = this.timeout - (Date.now() - started);
    if (left <= 0) return 'unknown';
    const result = await this.run(file, ai === 'claude' ? [...args, '--json'] : args, left);
    if (result.failed) return 'unknown';
    if (ai === 'claude') {
      try {
        const doc = JSON.parse(result.stdout);
        return doc.loggedIn === true && result.code === 0 ? 'ready' : doc.loggedIn === false ? 'required' : 'unknown';
      } catch { return 'unknown'; }
    }
    if (result.code === 0 && /^Logged in using /m.test(result.text)) return 'ready';
    if (/^Not logged in\s*$/m.test(result.text)) return 'required';
    return 'unknown';
  }
  check(ais) {
    validate({ status: 'in-progress', step: 'check', ais });
    if (this.pending) throw Object.assign(Error(lt('確認中です。終わるまでお待ちください')), { status: 409 });
    this.pending = Promise.all(ais.map(async ai => {
      const file = this.tools.find(ai);
      const agy = ai === 'agy' && file && !this.dry ? agyStatus(this.home) : null;
      // versionは推論を行わない既存の確認。ログイン確認の生出力は返さない。
      const [version, login] = await Promise.all([this.tools.version(ai, file), agy ? agy.login : this.login(ai, file)]);
      return [ai, { installed: Boolean(file), version, login, ...(agy?.notice ? { notice: agy.notice } : {}) }];
    })).then(rows => ({ tools: Object.fromEntries(rows), terminal: this.terminal() }));
    return this.pending.finally(() => { this.pending = null; });
  }
}
module.exports = { Onboarding, validate, runStatus };
