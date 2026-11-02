'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), c = require('node:crypto');
const { PackagedUpdate, verifyManifest, compatible, eligibility, noLinks } = require('./app-update-packaged');
const { UpdateStore } = require('./platform/win32-update-store');
const zip = require('./update-zip'), TRUST = require('./update-trust');
const fail = code => { throw Object.assign(Error(code), { code }); };
function inspectRuntime(folder, m) {
  noLinks(folder); const hash = zip.treeHash(folder);
  if (hash.treeSha256 !== m.app.treeSha256 || hash.entries !== m.app.entries) fail('tree-hash');
  if (fs.readdirSync(folder).join() !== 'hub') fail('zip-layout');
  const hub = path.join(folder, 'hub');
  for (const name of ['server.js', 'start-window.js', 'start-window.cmd', 'package.json']) if (!fs.lstatSync(path.join(hub, name)).isFile()) fail('zip-layout');
  if (JSON.parse(fs.readFileSync(path.join(hub, 'package.json'), 'utf8')).version !== m.version) fail('runtime-version');
  return hash;
}
function versionDirectory(home, m) { return path.join(home, 'versions', m.version + '-' + m.asset.sha256); }
function validateCurrent(home, entry, trust, { now = Date.now(), pending = false } = {}) {
  const m = verifyManifest(entry?.envelope, trust, { now, installed: !pending });
  if (m.requires.os !== 'win32' || entry.version !== m.version || entry.runtime !== path.join(versionDirectory(home, m), 'hub')) fail('current');
  inspectRuntime(path.dirname(entry.runtime), m); return entry;
}
class WindowsPackagedUpdate extends PackagedUpdate {
  constructor(o) {
    super({ ...o, platform: 'win32', dry: true, trust: o.trust || { ...TRUST, feedUrl: TRUST.windowsFeedUrl } });
    this.dry = o.dry === true; this.macOS = o.windowsVersion || (() => os.release());
    this.home = path.join(this.root, '_hub', 'updates', 'windows');
    this.bootstrap = o.bootstrap || this.env.HUB_UPDATE_BOOTSTRAP || '';
    this.windowLaunch = this.env.HUB_WINDOW_LAUNCH || '';
    this.store = o.updateStore || new UpdateStore(this.root);
    this.revision = 0; this.initialized = false;
    if (this.bootstrap && this.windowLaunch && this.arch === 'x64' && !this.ownerEdition) {
      try {
        const r = this.store.read(); this.data = r.value; this.revision = r.revision;
        if (this.data.origin !== this.bootstrap) fail('bootstrap');
        this.enabled = this.data.enabled === true; this.initialized = true;
      } catch { this.stateError = true; }
    }
    this.restartNeeded = Boolean(this.data.pendingConfirm && this.currentVersion === this.data.pendingConfirm.from);
  }
  reason() {
    if (this.ownerEdition) return 'owner';
    if (!this.trust.feedUrl || !Object.keys(this.trust.keys || {}).length) return 'not-configured';
    if (this.arch !== 'x64') return 'platform';
    if (!this.bootstrap || !this.windowLaunch || !this.initialized) return 'not-bundled';
    return '';
  }
  status() { return { ...super.status(), packageOS: 'win32', packageFormat: 'zip', reason: this.reason() === 'not-bundled' ? 'Windows専用窓から開くとアプリの更新を使えます' : super.status().reason }; }
  secure(file) {
    noLinks(file); if (!file.startsWith(this.home + path.sep)) fail('path');
    this.store.guard(this.home, false);
    if (fs.existsSync(file)) { const s = fs.lstatSync(file); if (s.isFile() && s.nlink !== 1) fail('path'); }
  }
  persist() { if (this.stateError) fail('state'); const saved = this.store.write(this.data, this.revision); this.revision = saved.revision; }
  applying() { return ['installing', 'confirming'].includes(this.data.phase) || this.restartNeeded; }
  nextHub() { return this.data.current?.runtime || this.hubPath; }
  async settings(enabled) {
    if (typeof enabled !== 'boolean') fail('enabled'); if (!this.supported()) return this.status();
    this.data.enabled = enabled; this.persist(); this.enabled = enabled; if (enabled && !this.dry) this.tick(); return this.status();
  }
  async prepare(m) {
    this.phase('downloading');
    const downloads = path.join(this.home, 'downloads'); this.secure(downloads); fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
    const part = path.join(downloads, c.randomUUID() + '.part');
    await this.receive(m.asset.url, { limit: m.asset.size, timeout: 600000, file: part, expectedHash: m.asset.sha256 });
    this.phase('verifying');
    const versions = path.join(this.home, 'versions'); this.secure(versions); fs.mkdirSync(versions, { recursive: true, mode: 0o700 });
    const fresh = versionDirectory(this.home, m); this.secure(fresh);
    try {
      if (!fs.existsSync(fresh)) zip.unpack(fs.readFileSync(part), fresh);
      inspectRuntime(fresh, m);
      this.data.prepared = { runtime: path.join(fresh, 'hub'), version: m.version, envelope: this.data.envelope };
      this.phase('ready', { reason: '', error: '' });
    } finally { this.secure(part); fs.unlinkSync(part); }
  }
  async install() {
    const job = this.data.prepared; if (!job || this.data.pendingConfirm) return this.status();
    if ((this.strictBusy ? await this.strictBusy() : this.busy())) { this.phase('deferred', { reason: this.idleMessage() }); return this.status(); }
    const m = verifyManifest(job.envelope, this.trust, { now: this.now(), version: this.currentVersion, maxSeq: this.data.maxSeq, allowAccepted: true });
    if (job.envelope.payload !== this.data.envelope?.payload || !compatible(m, { platform: 'win32', arch: this.arch, macOS: await this.macOS(), node: this.node }) || eligibility(m, this.license?.status(), this.license?.config?.build) !== 'install') fail('requirements');
    validateCurrent(this.home, job, this.trust, { now: this.now(), pending: true });
    if (!this.supported()) fail('unsupported');
    if ((this.strictBusy ? await this.strictBusy() : this.busy())) { this.phase('deferred', { reason: this.idleMessage() }); return this.status(); }
    // current, previous and confirmation journal change in ONE SQLite FULL commit.
    // No live executable, native DLL, original launcher or license file is replaced.
    const previous = this.data.current || { runtime: this.bootstrap, version: this.currentVersion };
    this.data.pendingConfirm = { from: this.currentVersion, version: m.version, token: c.randomUUID(), attempts: 0 };
    this.data.previous = previous; this.data.current = job; delete this.data.prepared;
    this.phase('installed', { reason: '', error: '' }); this.restartNeeded = true; return this.status();
  }
  async recover() {
    const p = this.data.pendingConfirm;
    if (p && this.currentVersion === p.version && this.env.HUB_UPDATE_CONFIRM === p.token) this.phase('confirming');
  }
  async healthy({ version, hubPath, token, restored, instance } = {}) {
    if (this.running || !this.data.pendingConfirm || !restored || !instance) return false;
    return this.lock(async () => {
      const p = this.data.pendingConfirm;
      if (version !== p.version || token !== p.token || token !== this.env.HUB_UPDATE_CONFIRM || hubPath !== this.nextHub() || hubPath !== this.hubPath) return false;
      validateCurrent(this.home, this.data.current, this.trust, { now: this.now(), pending: true });
      this.data.previousVersion = p.from; this.data.lastInstalled = { version, instance, at: new Date(this.now()).toISOString() };
      delete this.data.pendingConfirm; this.restartNeeded = false; this.phase('idle', { error: '', reason: '' }); return true;
    });
  }
}
// Called by the ORIGINAL stable launcher before any downloaded module is loaded.
// A failed startup is rolled back only AFTER its owned window/backend has exited.
function selectLaunch(store, origin, { trust = { ...TRUST, feedUrl: TRUST.windowsFeedUrl }, now = Date.now(), windowsVersion = os.release(), arch = process.arch, node = process.versions.node } = {}) {
  let selected;
  store.access(data => {
    if (!data.origin) { data.origin = origin; selected = { runtime: origin, token: '' }; return data; }
    if (data.origin !== origin) fail('bootstrap');
    if (!data.current) { selected = { runtime: origin, token: '' }; return; }
    if (data.pendingConfirm?.attempts >= 2) rollback(data, origin);
    if (!data.current) { selected = { runtime: origin, token: '' }; return data; }
    try {
      validateCurrent(store.home, data.current, trust, { now, pending: Boolean(data.pendingConfirm) });
      const m = verifyManifest(data.current.envelope, trust, { now, installed: !data.pendingConfirm });
      if (!compatible(m, { platform: 'win32', arch, macOS: windowsVersion, node })) fail('requirements');
    } catch (e) { if (!data.pendingConfirm) throw e; rollback(data, origin); }
    if (data.current) {
      validateCurrent(store.home, data.current, trust, { now });
      const m = verifyManifest(data.current.envelope, trust, { now, installed: true });
      if (!compatible(m, { platform: 'win32', arch, macOS: windowsVersion, node })) fail('requirements');
    }
    selected = { runtime: data.current?.runtime || origin, token: data.pendingConfirm?.token || '' };
    if (data.pendingConfirm) data.pendingConfirm.attempts++;
    return data;
  });
  return selected;
}
function rollback(data, origin) {
  if (data.previous?.runtime === origin && !data.previous.envelope) delete data.current;
  else if (data.previous?.envelope) data.current = data.previous;
  else fail('rollback');
  data.rejected = { seq: data.manifest?.seq, sha256: data.manifest?.asset?.sha256, reason: 'startup' };
  delete data.pendingConfirm; delete data.previous; data.phase = 'rolled-back'; data.reason = '新版の起動を確認できなかったため前の版へ戻しました';
}
function failedLaunch(store, origin, token) {
  let rolledBack = false;
  store.access(data => { if (data.origin !== origin) fail('bootstrap'); if (!token || data.pendingConfirm?.token !== token) return;
    rollback(data, origin); rolledBack = true; return data; }); return rolledBack;
}
module.exports = { WindowsPackagedUpdate, inspectRuntime, validateCurrent, selectLaunch, failedLaunch, versionDirectory };
