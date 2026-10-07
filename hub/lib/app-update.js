'use strict';
const { lt } = require('./locale');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { readPublic } = require('./update-check');
const UPSTREAM = 'https://github.com/kieiken/project-hub';
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;
const messages = {
  unsupported: '自動更新には Mac のアプリ・Git のソース・Storage Guard の設定が必要です',
  guard: 'Storage Guard が更新を止めました。今のアプリは変更していません',
  dirty: 'ソースに未保存の変更があります。保存するまで更新を待ちます',
  busy: 'AI・順番待ち・整理が終わるまで更新を待ちます',
  changed: '準備中にソースが変わりました。更新を準備し直します',
  conflict: '翻訳と上流の変更を安全に合わせられません。今のアプリは保持しています',
  invalid: '上流の版・コミットを確認できません',
  download: '上流を取得できませんでした。次の確認は24時間後です',
  prepare: '更新の準備・翻訳・試験・組み立てに失敗しました。今のアプリは保持しています',
  install: 'アプリの入れ替えに失敗しました。前のアプリとバックアップを保持しています',
  publish: 'アプリは更新できましたが、元のプロジェクトへの PR を送れませんでした',
  state: 'アプリは更新できましたが、更新状態を保存できませんでした。前のアプリのバックアップは保持しています',
  interrupted: '前の更新は途中で止まりました。保存した版から続けます',
  disabled: '自動更新はオフです',
  restarting: 'アプリの更新を適用中です。少し待ってください',
  format: 'enabled は true または false にしてください',
  retry: '翻訳の次の試行は24時間後です。今のアプリは保持しています',
};
const message = key => lt(messages[key] || messages.prepare);
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
function noLinks(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error(message('unsupported')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout) => {
    if (error) { const safe = Error('command failed'); safe.code = error.code; reject(safe); }
    else resolve(String(stdout || '').trim());
  }));
}

class AppUpdate {
  constructor(options) {
    this.root = options.root;
    this.home = path.join(this.root, '_hub', 'updates');
    this.stateFile = path.join(this.home, 'state.json');
    this.settingsFile = path.join(this.home, 'settings.json');
    this.env = { ...process.env, ...(options.env || {}) };
    this.now = options.now || Date.now;
    this.run = options.run || run;
    this.busy = options.busy || (() => false);
    this.translate = options.translate;
    this.publish = options.publish;
    this.validate = options.validate;
    this.platform = options.platform || process.platform;
    this.upstream = options.upstream || UPSTREAM + '.git'; // Constructor injection is only used by isolated tests.
    this.latest = options.latest;
    this.build = options.build;
    this.verify = options.verify;
    this.beforeInstall = options.beforeInstall;
    this.rename = options.rename || fs.renameSync;
    this.guard = options.guard || (async () => {
      if (!this.env.HUB_STORAGE_GUARD) return false;
      try { return (await this.run(this.env.HUB_STORAGE_GUARD, [], { env: this.env })).includes('STATUS=OK'); } catch { return false; }
    });
    this.data = readJSON(this.stateFile);
    const savedSource = this.data.installedSource;
    this.source = savedSource && savedSource.startsWith(this.home + path.sep) && fs.existsSync(path.join(savedSource, '.git')) ? savedSource : options.source;
    this.appPath = options.appPath || '';
    const settings = readJSON(this.settingsFile);
    this.enabled = typeof settings.enabled === 'boolean' ? settings.enabled : this.env.HUB_AUTO_UPDATE === '1';
    this.dry = options.dry === true;
    this.running = null;
    this.timer = null;
    this.restartNeeded = false;
    if (['checking', 'preparing', 'translating', 'testing', 'building', 'verifying'].includes(this.data.phase)) {
      this.data.phase = 'deferred'; this.data.reason = message('interrupted');
    }
    if (this.data.phase === 'installing' && !this.data.install && this.data.installedSource) this.data.phase = 'installed';
    if (this.data.phase === 'publishing') { this.data.phase = 'installed'; this.data.publishError = message('publish'); }
  }
  supported() {
    try {
      return this.platform === 'darwin' && path.isAbsolute(this.source || '') && fs.existsSync(path.join(this.source, '.git')) &&
        path.isAbsolute(this.appPath) && path.basename(this.appPath) === 'Project Hub.app' && fs.existsSync(path.dirname(this.appPath)) && Boolean(this.env.HUB_STORAGE_GUARD);
    } catch { return false; }
  }
  version(source = this.source) { const version = String(readJSON(path.join(source || '', 'hub', 'package.json')).version || ''); return VERSION.test(version) ? version : ''; }
  status() {
    const { job, install, publication, ...publicState } = this.data;
    const last = Date.parse(this.data.lastCheck || this.data.lastAttempt || '');
    return { enabled: this.enabled, supported: this.supported(), sourceVersion: this.version(), latestVersion: '', lastCheck: null, lastAttempt: null,
      nextCheck: Number.isFinite(last) ? new Date(last + DAY).toISOString() : null, pending: false, publishPending: false, error: '', phase: 'idle', reason: '', ...publicState,
      upstream: UPSTREAM, autoTranslate: Boolean(this.translate), publishEnabled: Boolean(this.publish), appPath: this.appPath, restartNeeded: this.restartNeeded };
  }
  applying() { return ['installing', 'publishing'].includes(this.data.phase) || this.restartNeeded; }
  busyMessage() { return message('restarting'); }
  idleMessage() { return message('busy'); }
  async persist() {
    if (!(await this.guard())) throw Object.assign(Error(message('guard')), { kind: 'guard' });
    noLinks(this.home); writeJSON(this.stateFile, this.data);
  }
  async phase(phase, extra = {}) { Object.assign(this.data, { phase }, extra); await this.persist(); }
  async settings(enabled) {
    if (typeof enabled !== 'boolean') throw Error(message('format'));
    if (!(await this.guard())) throw Error(message('guard'));
    noLinks(this.home); writeJSON(this.settingsFile, { enabled }); this.enabled = enabled;
    if (enabled && !this.dry) this.tick();
    return this.status();
  }
  due() { const last = Date.parse(this.data.lastCheck || this.data.lastAttempt || ''); return !Number.isFinite(last) || this.now() - last >= DAY; }
  publishDue() { const last = Date.parse(this.data.lastPublishAttempt || ''); return !Number.isFinite(last) || this.now() - last >= DAY; }
  translationDue() { const last = Date.parse(this.data.lastTranslationAttempt || ''); return !Number.isFinite(last) || this.now() - last >= DAY; }
  start() {
    if (this.dry || this.timer) return;
    void this.lock(() => this.recover()).then(() => this.tick()).catch(() => {});
    this.timer = setInterval(() => this.tick(), 60000); this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  tick() {
    if (!this.enabled || this.running || this.dry) return;
    if (this.due()) void this.check().catch(() => {});
    else if ((this.data.pending || (this.data.publishPending && this.publishDue())) && ['idle', 'deferred', 'ready', 'installed'].includes(this.data.phase)) void this.resume().catch(() => {});
  }
  async git(args, cwd = this.source) { return this.run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: this.env }); }
  async dirty() { return Boolean(await this.git(['status', '--porcelain', '--untracked-files=normal'])); }
  lock(action) {
    if (this.running) return Promise.resolve(this.status());
    this.running = Promise.resolve().then(action).finally(() => { this.running = null; });
    return this.running;
  }
  async check() {
    if (this.dry || this.running) return this.status();
    return this.lock(async () => {
      await this.recover();
      if (!this.due()) return this.status(); // Manual requests use the same persisted daily gate.
      return this.checkOnce();
    });
  }
  async checkOnce() {
    const at = new Date(this.now()).toISOString();
    Object.assign(this.data, { lastCheck: at, lastAttempt: at, phase: 'checking', error: this.data.publishError || '', reason: '' });
    try {
      await this.persist();
      if (!this.supported()) { await this.phase('failed', { error: message('unsupported') }); return this.status(); }
      const latest = this.latest ? await this.latest() : await this.readLatest();
      if (!/^[a-f0-9]{40,64}$/.test(latest.commit || '') || !VERSION.test(latest.version || '')) throw Object.assign(Error(message('invalid')), { kind: 'invalid' });
      if (this.data.job && this.data.job.context?.upstreamSha !== latest.commit) this.data.job = null;
      Object.assign(this.data, { latestCommit: latest.commit, latestVersion: latest.version });
      let contains = this.data.installedCommit === latest.commit;
      if (!contains) { try { await this.git(['merge-base', '--is-ancestor', latest.commit, 'HEAD']); contains = true; } catch {} }
      await this.phase('idle', { pending: !contains, reason: this.enabled ? '' : message('disabled') });
      if (this.enabled && !contains) { try { await this.advance(); } catch (error) { error.kind ||= 'prepare'; throw error; } }
      else if (this.enabled && contains && this.data.publishPending) await this.publishPrepared();
    } catch (error) { this.data.phase = error.kind === 'conflict' ? 'conflict' : 'failed'; this.data.error = error.kind ? message(error.kind) : message('download'); try { await this.persist(); } catch {} }
    return this.status();
  }
  async readLatest() {
    const out = await this.run('git', ['ls-remote', this.upstream, 'refs/heads/main'], { env: this.env });
    const commit = out.split(/\s/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Object.assign(Error(message('invalid')), { kind: 'invalid' });
    const body = JSON.parse(await readPublic(`https://raw.githubusercontent.com/kieiken/project-hub/${commit}/hub/package.json`));
    return { commit, version: String(body.version || '') };
  }
  async resume() {
    if (this.running || !this.enabled || !(this.data.pending || this.data.publishPending)) return this.status();
    return this.lock(() => (this.data.pending ? this.advance() : this.publishPrepared()).catch(async error => { this.data.phase = error.kind === 'conflict' ? 'conflict' : 'failed'; this.data.error = message(error.kind || 'prepare'); try { await this.persist(); } catch {} return this.status(); }));
  }
  async defer(reason) { if (this.data.phase !== 'deferred' || this.data.reason !== message(reason)) await this.phase('deferred', { reason: message(reason) }); return this.status(); }
  async advance() {
    if (!this.enabled) return this.defer('disabled');
    if (this.busy()) return this.defer('busy');
    if (await this.dirty()) return this.defer('dirty');
    await this.persist();
    if (this.data.job && this.data.job.context?.upstreamSha !== this.data.latestCommit) this.data.job = null;
    // A restarted translation job uses the same durable daily gate as a failed one.
    if (!this.data.job && this.translate && !this.translationDue()) return this.defer('retry');
    if (!this.data.job) await this.prepare();
    if (!this.enabled) return this.defer('disabled');
    if (this.busy()) return this.defer('busy');
    if (await this.dirty()) return this.defer('dirty');
    if (await this.git(['rev-parse', 'HEAD']) !== this.data.job.sourceHead) { this.data.job = null; return this.defer('changed'); }
    await this.install();
    return this.status();
  }
  async prepare() {
    const sourceHead = await this.git(['rev-parse', 'HEAD']);
    const folder = path.join(this.home, 'versions', crypto.randomUUID());
    const stage = path.join(folder, 'source');
    noLinks(this.source); noLinks(folder); fs.mkdirSync(folder, { recursive: true });
    await this.phase('preparing', { reason: '' });
    await this.run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', this.source, stage], { env: this.env });
    await this.git(['checkout', '-b', 'hub-auto/' + path.basename(folder), sourceHead], stage);
    await this.git(['remote', 'add', 'official', this.upstream], stage);
    await this.git(['fetch', '--no-tags', 'official', this.data.latestCommit], stage);
    let conflicted = false;
    try { await this.git(['-c', 'user.name=Project Hub', '-c', 'user.email=hub@localhost', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify', this.data.latestCommit], stage); }
    catch { conflicted = Boolean(await this.git(['ls-files', '-u'], stage)); if (!conflicted) throw Error(message('prepare')); }
    const context = { upstreamSha: this.data.latestCommit, sourceHead, conflicted, root: this.root, appPath: this.appPath, version: this.data.latestVersion };
    if (conflicted && !this.translate) throw Object.assign(Error(message('conflict')), { kind: 'conflict' });
    if (this.translate) {
      await this.phase('translating', { lastTranslationAttempt: new Date(this.now()).toISOString() });
      await this.translate(stage, context);
    }
    if (await this.git(['ls-files', '-u'], stage)) throw Object.assign(Error(message('conflict')), { kind: 'conflict' });
    await this.git(['diff', '--check'], stage);
    const version = this.version(stage); if (!version) throw Object.assign(Error(message('invalid')), { kind: 'invalid' });
    const env = { ...this.env, HUB_ROOT: path.join(folder, 'test-workspace'), HUB_AI_HOME: path.join(folder, 'test-ai-home'), HUB_DRY_RUN: '1', HUB_SKIP_APP: '1', HUB_SKIP_NPM: '1', TMPDIR: path.join(folder, 'temp') };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    await this.phase('testing');
    await this.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(stage, 'hub'), env, timeout: 600000 });
    await this.run('npm', ['test'], { cwd: path.join(stage, 'hub'), env, timeout: 1800000 });
    await this.phase('building');
    const built = path.join(folder, 'built'), buildEnv = { ...this.env, HUB_APP_DIR: built, HUB_ROOT: this.root, HUB_UPDATE_SOURCE: stage, HUB_UPDATE_APP: this.appPath, HUB_NO_DESKTOP_LINK: '1', TMPDIR: env.TMPDIR };
    if (this.build) await this.build(stage, built, buildEnv);
    else await this.run('/bin/bash', [path.join(stage, 'hub', 'app', 'build-app.sh')], { cwd: stage, env: buildEnv, timeout: 600000 });
    const candidate = path.join(built, 'Project Hub.app'); noLinks(candidate);
    if (!fs.existsSync(candidate)) throw Error(message('prepare'));
    await this.phase('verifying');
    if (this.verify) await this.verify(candidate);
    else await this.run('codesign', ['--verify', '--deep', '--strict', candidate], { env: this.env });
    if (await this.git(['diff', '--name-only'], stage)) throw Error(message('prepare')); // Only the reviewed/staged index may be committed.
    if (await this.git(['diff', '--cached', '--name-only'], stage)) await this.git(['-c', 'user.name=Project Hub', '-c', 'user.email=hub@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Project Hub: synchronize upstream and Traditional Chinese'], stage);
    if (await this.git(['status', '--porcelain', '--untracked-files=normal'], stage)) throw Error(message('prepare'));
    if (this.validate) await this.validate(stage, context);
    this.data.job = { folder, stage, candidate, sourceHead, version, context, head: await this.git(['rev-parse', 'HEAD'], stage) };
    await this.phase('ready');
  }
  async install() {
    const job = this.data.job;
    if (job.context?.upstreamSha !== this.data.latestCommit) { this.data.job = null; return this.defer('changed'); }
    const previous = structuredClone(this.data), previousSource = this.source;
    await this.phase('installing');
    noLinks(this.appPath); noLinks(job.candidate);
    const sibling = fs.mkdtempSync(path.join(path.dirname(this.appPath), '.ProjectHub-update-'));
    const fresh = path.join(sibling, 'new.app'), old = path.join(sibling, 'old.app');
    const backup = path.join(job.folder, 'backup', 'Project Hub.app');
    let moved = false, installed = false;
    try {
      fs.cpSync(job.candidate, fresh, { recursive: true });
      if (this.verify) await this.verify(fresh); else await this.run('codesign', ['--verify', '--deep', '--strict', fresh], { env: this.env });
      if (this.beforeInstall) await this.beforeInstall(fresh);
      if (!this.enabled) { await this.defer('disabled'); return; }
      if (this.busy()) { await this.defer('busy'); return; }
      if (await this.dirty()) { await this.defer('dirty'); return; }
      if (await this.git(['rev-parse', 'HEAD']) !== job.sourceHead) { this.data.job = null; await this.defer('changed'); return; }
      // A candidate waiting for AI must still point at exactly the tested source.
      noLinks(job.stage);
      if (await this.git(['status', '--porcelain', '--untracked-files=normal'], job.stage) ||
          await this.git(['rev-parse', 'HEAD'], job.stage) !== job.head) throw Error(message('prepare'));
      if (!(await this.guard())) throw Error(message('guard'));
      if (fs.existsSync(this.appPath)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.cpSync(this.appPath, backup, { recursive: true }); }
      this.data.install = { target: this.appPath, old, fresh, backup };
      await this.persist();
      if (!this.enabled) { this.data.install = null; await this.defer('disabled'); return; }
      if (this.busy()) { this.data.install = null; await this.defer('busy'); return; }
      if (fs.existsSync(this.appPath)) { this.rename(this.appPath, old); moved = true; }
      this.rename(fresh, this.appPath); installed = true;
      this.data.install = null;
      Object.assign(this.data, { installedSource: job.stage, installedCommit: job.context.upstreamSha, installedVersion: job.version, installedAt: new Date(this.now()).toISOString(), backup, pending: false, reason: '',
        publishPending: Boolean(this.publish), publication: this.publish ? { stage: job.stage, context: job.context, head: job.head } : null });
      this.source = job.stage;
      await this.persist();
      this.restartNeeded = true;
    } catch (error) {
      if (installed && fs.existsSync(this.appPath)) fs.renameSync(this.appPath, fresh);
      if (moved && fs.existsSync(old)) fs.renameSync(old, this.appPath);
      this.source = previousSource; this.data = previous; this.restartNeeded = false;
      throw Object.assign(Error(message('install')), { kind: 'install' });
    } finally { if (!moved || fs.existsSync(this.appPath)) fs.rmSync(sibling, { recursive: true, force: true }); }
    this.data.job = null;
    if (this.data.publishPending) await this.publishPrepared();
    else await this.installedStatus();
  }
  async installedStatus() {
    this.data.phase = 'installed';
    try { await this.persist(); }
    catch { this.data.stateError = message('state'); this.data.error = this.data.stateError; }
    return this.status();
  }
  async publishPrepared() {
    if (!this.enabled || !this.publish || !this.data.publishPending || !this.data.publication || !this.publishDue()) return this.installedStatus();
    const publication = this.data.publication;
    try {
      if (this.busy()) return await this.defer('busy');
      noLinks(publication.stage);
      if (await this.git(['status', '--porcelain', '--untracked-files=normal'], publication.stage) ||
        await this.git(['rev-parse', 'HEAD'], publication.stage) !== publication.head) throw Error(message('publish'));
      await this.phase('publishing');
      if (!this.enabled) return await this.defer('disabled');
      if (this.busy()) return await this.defer('busy');
      Object.assign(this.data, { lastPublishAttempt: new Date(this.now()).toISOString(), lastPublishCommit: publication.context.upstreamSha });
      await this.persist();
      if (!this.enabled) return await this.defer('disabled');
      const result = await this.publish(publication.stage, publication.context);
      Object.assign(this.data, { prUrl: result?.prUrl || '', publishPending: false, publication: null, publishError: '', error: '', stateError: '' });
    } catch { this.data.publishError = message('publish'); this.data.error = this.data.publishError; }
    return this.installedStatus();
  }
  async recover() {
    const journal = this.data.install;
    if (!journal) return;
    if (!(await this.guard())) throw Error(message('guard'));
    const parent = path.dirname(this.appPath);
    if (journal.target !== this.appPath || path.dirname(path.dirname(journal.old)) !== parent || !path.basename(path.dirname(journal.old)).startsWith('.ProjectHub-update-')) throw Error(message('install'));
    noLinks(journal.old); noLinks(this.appPath);
    if (fs.existsSync(journal.old)) {
      if (fs.existsSync(this.appPath)) fs.renameSync(this.appPath, path.join(path.dirname(journal.old), 'interrupted-new.app'));
      fs.renameSync(journal.old, this.appPath);
    }
    this.data.install = null;
    await this.phase('failed', { error: message('install'), pending: true });
  }
}
module.exports = { AppUpdate, UPSTREAM, DAY, VERSION };
