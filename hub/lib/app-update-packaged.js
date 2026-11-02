'use strict';
const platforms = require('./platform');
// Completed-App updates. No Git, npm, downloaded scripts, AI or elevated access.
const fs = require('./platform/file-io');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const TRUST = require('./update-trust');
const DAY = 86400000, HOUR = 3600000, MAX_ASSET = 256 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{64}$/;
const REASONS = {
  windows: 'Windowsでは未対応：アプリの自動更新はまだ使えません',
  owner: '製作者版は自動更新の対象外です',
  'not-configured': '準備中：配布元の設定がまだありません',
  'not-bundled': '完成アプリの中から起動している本体ではありません',
  platform: 'このMac用の更新には対応していません',
  translocated: '一度 Finder で［アプリケーション］へ移してから開き直してください',
  'read-only': 'アプリの場所に書き込めません。ディスクイメージの中なら［アプリケーション］へ移してから開いてください',
  'app-name': 'アプリの名前を Project Hub.app にして開き直してください',
  quarantine: 'このアプリにはMacの初回確認が必要です。Finderで開いて確認してください',
};
function fail(code) { throw Object.assign(Error(code), { code }); }
function readJSON(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.size > 256 * 1024) fail('state'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function noLinks(file) {
  const abs = path.resolve(file); let cur = path.parse(abs).root;
  for (const part of abs.slice(cur.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try { if (fs.lstatSync(cur).isSymbolicLink()) fail('path-link'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function securePath(file, base) {
  noLinks(file);
  if (file !== base && !file.startsWith(base + path.sep)) fail('path');
  let cur = base;
  for (const part of ['', ...path.relative(base, file).split(path.sep).filter(Boolean)]) {
    if (part) cur = path.join(cur, part);
    try { const s = fs.lstatSync(cur); if (s.uid !== process.getuid() || (s.mode & 0o022)) fail('ownership'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function writeJSON(file, data, base) {
  securePath(file, base); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); securePath(file, base);
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }, (e, out) => e ? reject(Error('app-inspection')) : resolve(String(out).trim())));
}
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); const i = x.findIndex((v, i) => v !== y[i]); return i >= 0 && x[i] > y[i]; };
function base64url(text, max) {
  if (typeof text !== 'string' || !/^[\w-]+$/.test(text) || text.length > max) fail('encoding');
  const buf = Buffer.from(text, 'base64url'); if (buf.toString('base64url') !== text) fail('encoding'); return buf;
}
// Preserve previously signed whitespace/formatting, but never let native and JS
// JSON parsers choose different values for the same (possibly escaped) key.
function parseSigningPayload(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('format');
  const parsed = JSON.parse(text); // Validate grammar before the token walk.
  let i = 0;
  const space = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '\\') i++;
      else if (ch === '"') return text.slice(start, i);
    }
    fail('format');
  }
  function value() {
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        space(); const key = JSON.parse(string());
        if (keys.has(key)) fail('format');
        keys.add(key); space(); i++; // colon, grammar already checked
        value(); space();
        if (text[i++] === '}') return;
      }
    }
    if (text[i] === '[') {
      i++; space();
      if (text[i] === ']') { i++; return; }
      while (true) { value(); space(); if (text[i++] === ']') return; }
    }
    if (text[i] === '"') { string(); return; }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  }
  value();
  return parsed;
}
function verifyManifest(envelope, trust, { now = Date.now(), version, maxSeq = 0, allowAccepted = false, installed = false } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Object.keys(envelope).every(k => ['kid', 'payload', 'sig'].includes(k))) fail('envelope');
  const key = Object.hasOwn(trust.keys || {}, envelope.kid) ? trust.keys[envelope.kid] : null;
  if (!key || trust.revokedKids.includes(envelope.kid) || !key.purposes?.includes('app-update')) fail('key');
  const bytes = base64url(envelope.payload, 86000), sig = base64url(envelope.sig, 100);
  let pub;
  try { pub = crypto.createPublicKey({ key: Buffer.from(key.spkiB64, 'base64'), format: 'der', type: 'spki' }); } catch { fail('key'); }
  // Missing alg means legacy Ed25519 only, for existing release constants.
  // The untrusted manifest never chooses the verification algorithm.
  const alg = key.alg === undefined ? 'ed25519' : key.alg;
  if (sig.length !== 64) fail('signature');
  if (alg === 'ed25519') {
    if (pub.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, pub, sig)) fail('signature');
  } else if (alg === 'p256-sha256') {
    if (pub.asymmetricKeyType !== 'ec' || pub.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        !crypto.verify('sha256', bytes, { key: pub, dsaEncoding: 'ieee-p1363' }, sig)) fail('signature');
  } else fail('key');
  let m; try { m = parseSigningPayload(bytes); } catch { fail('format'); }
  // A trial feed cannot authorize a stable application, or the reverse. These
  // expectations come from committed release constants, never the envelope.
  const trial = trust.channel === 'purchase-test', runtime = trust.runtimeProtocol === 1;
  if (trust.runtimeProtocol !== undefined && (!runtime || trial)) fail('format');
  if (m?.v !== 1 || m.typ !== 'hub-app-update' || m.product !== (trial ? 'project-hub-purchase-test' : 'project-hub') || (trial ? m.channel !== 'purchase-test' : m.channel !== undefined) || m.edition !== 'public' || m.lang !== 'ja' || !SEMVER.test(m.version || '') || !['feature', 'bugfix'].includes(m.kind)) fail('format');
  if (!Number.isSafeInteger(m.seq) || m.seq < 1 || (allowAccepted ? m.seq < maxSeq : m.seq <= maxSeq)) fail('sequence');
  const seconds = Math.floor(now / 1000);
  if (![m.issuedAt, m.expiresAt].every(Number.isSafeInteger) || m.issuedAt > seconds + 300 || (!installed && m.expiresAt <= seconds) || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > 365 * 86400) fail('expiry');
  if (version && !newer(m.version, version)) fail('version');
  if (typeof m.product_line !== 'string' || !m.product_line || m.product_line.length > 128 || !Array.isArray(m.bugfixOf) || m.bugfixOf.length > 100 || !m.bugfixOf.every(x => typeof x === 'string' && x.length > 0 && x.length <= 128)) fail('format');
  const windows = m.requires?.os === 'win32';
  if (!m.requires || m.requires.node !== '>=22' || (windows ? m.requires.arch !== 'x64' || !/^\d+\.\d+\.\d+$/.test(m.requires.minWindows || '') : m.requires.os !== 'darwin' || m.requires.arch !== 'arm64' || !/^\d+\.\d+(?:\.\d+)?$/.test(m.requires.minMacOS || ''))) fail('requirements');
  const a = m.asset, app = m.app;
  if (!a || !((windows || trial || runtime) ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.zip$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.dmg$/).test(a.name || '') || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_ASSET || !SHA.test(a.sha256 || '') || a.url !== trust.assetPrefix + 'v' + m.version + (trial ? '-purchase-test.update/' : '/') + a.name) fail('asset');
  if (!runtime && app?.format === 'release-runtime-v1') fail('app');
  if (runtime && (m.issuedAt < 0 || m.kind !== 'bugfix' || m.product_line !== 'project-hub-4.123' || JSON.stringify(m.bugfixOf) !== '["project-hub-4.123"]' || app?.format !== 'release-runtime-v1' || app.shellProtocol !== 1 || app.runtime !== 'hub' || a.name !== `Project-Hub-${m.version}-Runtime-${windows ? 'Windows-x64' : 'Apple-Silicon'}.zip`)) fail('app');
  if (trial ? app?.format !== 'purchase-runtime-v1' || app?.shellProtocol !== 1 || app?.runtime !== 'hub' : !runtime && windows && (app?.format !== 'windows-zip-v1' || app?.runtime !== 'hub')) fail('app');
  if (!app || app.bundleId !== (trial ? 'local.projecthub.purchase-test' : 'local.projecthub') || app.shortVersion !== m.version || !SHA.test(app.treeSha256 || '') || !Number.isSafeInteger(app.entries) || app.entries < 1 || app.entries > 10000) fail('app');
  if (!m.notes || typeof m.notes.ja !== 'string' || m.notes.ja.length > 4000) fail('notes');
  return m;
}
// The hash uses exact UTF-8 path bytes, never Unicode normalization.
function treeHash(dir) {
  const records = []; let bytes = 0;
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder)) {
      const rel = prefix + name, full = path.join(folder, name), s = fs.lstatSync(full);
      if (rel.includes('\0') || rel.includes('\n') || (s.mode & 0o6000) || (!s.isSymbolicLink() && (s.mode & 0o022))) fail('app-permissions');
      let kind, content;
      if (s.isSymbolicLink()) {
        kind = 'link'; content = fs.readlinkSync(full);
        const dest = path.resolve(path.dirname(full), content);
        if (path.isAbsolute(content) || (dest !== dir && !dest.startsWith(dir + path.sep)) || !fs.existsSync(dest) || !fs.realpathSync(dest).startsWith(dir + path.sep)) fail('app-link');
      } else if (s.isDirectory()) { kind = 'dir'; content = ''; }
      else if (s.isFile()) {
        kind = 'file'; bytes += s.size; if (bytes > 1024 * 1024 * 1024) fail('app-size');
        const fd = fs.openSync(full, 'r'), hash = crypto.createHash('sha256'), buf = Buffer.alloc(65536);
        try { let n; while ((n = fs.readSync(fd, buf)) > 0) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); } content = hash.digest('hex');
      } else fail('app-type');
      records.push({ rel, record: `${kind}\0${rel}\0${(s.mode & 0o7777).toString(8)}\0${content}\n` });
      if (records.length > 10000) fail('app-entries');
      if (s.isDirectory()) walk(full, rel + '/');
    }
  }
  const root = fs.lstatSync(dir); if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o6022)) fail('app-root');
  walk(dir); records.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
  return { treeSha256: crypto.createHash('sha256').update(records.map(x => x.record).join('')).digest('hex'), entries: records.length, bytes };
}
function compatible(m, { platform, arch, macOS, node }) {
  const pad = x => x.split('.').concat(['0', '0']).slice(0, 3).join('.');
  return m.requires.os === platform && m.requires.arch === arch && !newer(pad(m.requires.os === 'win32' ? m.requires.minWindows : m.requires.minMacOS), pad(macOS)) && Number(node.split('.')[0]) >= 22;
}
function eligibility(m, status = {}, build = {}) {
  if (status.enforcement === false) return 'install';
  const states = Object.values(status.features || {}).filter(x => x.allowed).map(x => x.state);
  if (states.includes('purchased') && !status.updateScope?.hasShortTerm && !states.some(x => ['trial', 'course_trial', 'course_benefit', 'beta'].includes(x))) {
    return m.kind === 'bugfix' && m.bugfixOf.some(p => (status.updateScope?.purchaseProducts || [build.product]).includes(p)) ? 'install' : 'purchase-scope';
  }
  return 'install';
}
class PackagedUpdate {
  constructor(o) {
    this.root = o.root; this.home = path.join(o.root, '_hub', 'updates', 'packaged');
    this.stateFile = path.join(this.home, 'state.json'); this.settingsFile = path.join(this.home, 'settings.json');
    this.appPath = o.appPath || ''; this.hubPath = o.hubPath || ''; this.currentVersion = o.version || '';
    this.source = ''; this.ownerEdition = o.ownerEdition === true; this.trust = o.trust || TRUST;
    this.now = o.now || Date.now; this.run = o.run || run; this.fetch = o.fetch || fetch; this.testOrigin = o.testOrigin; // Constructor-only local fixture transport.
    this.platform = o.platform || process.platform; this.arch = o.arch || process.arch;
    this.platformApi = o.platformApi || platforms.forPlatform(this.platform);
    this.macOS = o.macOS || (() => this.platformApi.appUpdater.macOS(this.run.bind(this))); this.node = o.node || process.versions.node;
    this.busy = o.busy || (() => false); this.license = o.license; this.env = { ...process.env, ...(o.env || {}) };
    this.rename = o.rename || fs.renameSync; this.dry = o.dry === true; this.running = null; this.timer = null; this.restartNeeded = false;
    this.data = {}; this.stateError = false;
    this.enabled = false;
    if (this.platform !== 'win32') {
      try { securePath(this.stateFile, this.root); this.data = readJSON(this.stateFile); } catch { this.stateError = true; }
      try { securePath(this.settingsFile, this.root); this.enabled = readJSON(this.settingsFile).enabled === true; } catch { this.enabled = false; this.stateError = true; }
    }
    if (this.ownerEdition) this.enabled = false;
    this.quarantined = false;
    if (!this.dry && !this.reason()) {
      try {
        this.quarantined = this.platformApi.appUpdater.hasQuarantine(this.appPath);
        // Keep the observed attribute if reading its approval flags fails.
        if (this.quarantined) this.quarantined = !this.platformApi.appUpdater.quarantineApproved(this.appPath);
      }
      catch { this.stateError = true; }
    }
  }
  get mode() { return this.supported() ? 'packaged' : 'unsupported'; }
  reason() {
    if (this.platform === 'win32') return 'windows';
    if (this.ownerEdition) return 'owner';
    if (!this.trust.feedUrl || !this.trust.assetPrefix || !Object.keys(this.trust.keys).length) return 'not-configured';
    if (!this.platformApi.appUpdater.packagedSupported(this.arch)) return 'platform';
    if (!path.isAbsolute(this.appPath) || path.basename(this.appPath) !== 'Project Hub.app') return 'app-name';
    if (this.appPath.includes('/AppTranslocation/')) return 'translocated';
    if (this.quarantined) return 'quarantine';
    try {
      noLinks(this.appPath); noLinks(this.hubPath);
      if (fs.realpathSync(this.hubPath) !== fs.realpathSync(path.join(this.appPath, 'Contents/Resources/runtime/hub'))) return 'not-bundled';
      const app = fs.statSync(this.appPath);
      if (app.uid !== process.getuid() || (app.mode & 0o022)) return 'read-only';
      const parent = fs.statSync(path.dirname(this.appPath));
      // /Applications is normally root-owned and admin-group writable. Never
      // elevate; W_OK below decides whether this user can replace an App there.
      if (![0, process.getuid()].includes(parent.uid) || (parent.mode & (parent.uid === 0 ? 0o002 : 0o022)) || !(parent.mode & 0o220)) return 'read-only';
      fs.accessSync(path.dirname(this.appPath), fs.constants.W_OK);
    } catch { return 'read-only'; }
    return '';
  }
  supported() { return !this.reason() && !this.stateError; }
  status() {
    const m = this.data.manifest, p = this.data.pendingConfirm;
    return { mode: this.mode, unsupportedReason: this.stateError ? 'state' : this.reason(), supported: this.supported(), enabled: this.enabled,
      currentVersion: this.currentVersion, sourceVersion: this.currentVersion, latestVersion: m?.version || '', latestKind: m?.kind || '', notes: m?.notes?.ja || '',
      phase: this.data.phase || 'idle', pending: Boolean(this.data.prepared || p), eligibility: this.data.eligibility || '',
      reason: this.reason() ? REASONS[this.reason()] : this.data.reason || '', error: this.stateError ? '更新の保存場所を確認できません' : this.data.error || '',
      lastCheck: this.data.lastCheck || null, nextCheck: this.data.retryAfter ? new Date(this.data.retryAfter).toISOString() : null,
      rejected: this.data.rejected || null, previousVersion: this.data.previousVersion || '', restartNeeded: this.restartNeeded,
      autoTranslate: false, publishEnabled: false, upstream: this.trust.feedUrl || '', appPath: this.appPath };
  }
  applying() { if (this.platform === 'win32') return false; return ['installing', 'confirming'].includes(this.data.phase) || this.restartNeeded; }
  busyMessage() { return 'アプリの更新を適用中です。少し待ってください'; }
  idleMessage() { return 'AI・順番待ち・整理が終わるまで更新を待ちます'; }
  nextHub() { return path.join(this.appPath, 'Contents/Resources/runtime/hub'); }
  secure(file) { securePath(file, this.root); }
  persist() { if (this.stateError) fail('state'); writeJSON(this.stateFile, this.data, this.root); }
  phase(phase, extra = {}) { Object.assign(this.data, { phase }, extra); this.persist(); }
  lock(action) {
    if (this.running) return Promise.resolve(this.status());
    this.running = Promise.resolve().then(action).finally(() => { this.running = null; }); return this.running;
  }
  async settings(enabled) {
    if (typeof enabled !== 'boolean') fail('enabled');
    if (!this.supported()) return this.status();
    writeJSON(this.settingsFile, { enabled }, this.root); this.enabled = enabled;
    if (enabled && !this.dry) this.tick(); return this.status();
  }
  due(manual = false) {
    if (this.data.retryAfter > this.now()) return false;
    const last = Date.parse(this.data.lastCheck || ''); return !Number.isFinite(last) || this.now() - last >= (manual ? HOUR : DAY);
  }
  start() {
    if (!this.supported() || this.dry || this.timer) return;
    void this.lock(() => this.recover()).then(() => this.tick()).catch(() => {});
    this.timer = setInterval(() => this.tick(), 60000); this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  tick() {
    if (!this.supported() || !this.enabled || this.running || this.dry || this.data.pendingConfirm) return;
    if (this.data.prepared) void this.apply().catch(() => {});
    else if (this.due()) void this.check(false).catch(() => {});
  }
  async check(manual = true) {
    if (!this.supported() || this.dry || this.running || this.data.pendingConfirm) return this.status();
    return this.lock(async () => {
      await this.recover(); if (!this.due(manual)) return this.status();
      if (this.data.prepared) { if (this.enabled) await this.install(); return this.status(); }
      this.phase('checking', { lastCheck: new Date(this.now()).toISOString(), error: '', reason: '', retryAfter: this.now() + (manual ? HOUR : DAY) });
      let m;
      try {
        const raw = await this.receive(this.trust.feedUrl, { limit: 65536, timeout: 15000 });
        const envelope = JSON.parse(raw.toString('utf8'));
        // A known bad artifact is not downloaded again, even on another day.
        m = verifyManifest(envelope, this.trust, { now: this.now(), maxSeq: this.data.maxSeq || 0, allowAccepted: true });
        if (this.data.rejected && this.data.rejected.seq === m.seq && this.data.rejected.sha256 === m.asset.sha256) fail('rejected');
        if (m.seq === this.data.maxSeq) {
          if (envelope.payload !== this.data.envelope?.payload || envelope.sig !== this.data.envelope?.sig) fail('sequence');
          // The signed release is unchanged, but entitlement or runtime
          // requirements may now be satisfied. Re-evaluate before preparing.
        }
        if (!newer(m.version, this.currentVersion)) { this.phase('idle', { eligibility: 'up-to-date', reason: '最新版を使用しています' }); return this.status(); }
        this.data.maxSeq = m.seq; this.data.manifest = m; this.data.envelope = envelope;
        this.data.eligibility = compatible(m, { platform: this.platform, arch: this.arch, macOS: await this.macOS(), node: this.node }) ? eligibility(m, this.license?.status(), this.license?.config?.build) : 'requirements';
        this.persist();
        if (this.data.eligibility !== 'install') { this.phase('idle', { reason: this.data.eligibility === 'purchase-scope' ? '新しい版があります（購入した版の対象外）' : (this.platform === 'win32' ? 'このWindowsのOS・CPU・Node.jsでは使えない版です' : 'このMacのOS・CPU・Node.jsでは使えない版です') }); return this.status(); }
        await this.prepare(m);
        if (this.enabled) await this.install();
      } catch (e) { this.failed(e, m); }
      return this.status();
    });
  }
  failed(e, m) {
    this.data.phase = 'failed'; this.data.error = '更新を確認できませんでした。今のアプリを保持しています（' + (e.code || 'inspection') + '）';
    this.data.retryAfter = this.now() + DAY;
    if (m && !this.data.pendingConfirm) this.data.rejected = { seq: m.seq, sha256: m.asset.sha256, reason: e.code || 'inspection' };
    try { this.persist(); } catch {}
  }
  allowedURL(raw, initial = false) {
    let u; try { u = new URL(raw); } catch { fail('url'); }
    if (u.username || u.password || u.hash || u.port && u.port !== '443') {
      if (!(this.testOrigin && u.origin === this.testOrigin && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.hash)) fail('url');
    }
    if (this.testOrigin && u.origin === this.testOrigin && u.hostname === '127.0.0.1') return u;
    if (u.protocol !== 'https:' || !['github.com', ...this.trust.redirectHosts].includes(u.hostname)) fail('url');
    if (initial && raw !== this.trust.feedUrl && !raw.startsWith(this.trust.assetPrefix)) fail('url');
    return u;
  }
  async receive(raw, { limit, timeout, file, expectedHash }) {
    let url = this.allowedURL(raw, true), fd;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
    let ok = false;
    try {
      let res;
      for (let n = 0; n <= 5; n++) {
        res = await this.fetch(url.href, { redirect: 'manual', signal: abort.signal, credentials: 'omit', headers: { 'User-Agent': 'ProjectHub/' + this.currentVersion } });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const next = res.headers.get('location'); await res.body?.cancel(); if (!next || n === 5) fail('redirect');
          url = this.allowedURL(new URL(next, url).href); continue;
        }
        break;
      }
      if (!res || res.status !== 200 || Number(res.headers.get('content-length')) > limit) { await res?.body?.cancel(); fail('download'); }
      const hash = crypto.createHash('sha256'), chunks = []; let size = 0;
      if (file) { this.secure(file); fd = fs.openSync(file, 'wx', 0o600); }
      for await (const chunk of res.body) {
        size += chunk.length; if (size > limit) { abort.abort(); fail('size'); } hash.update(chunk);
        if (file) { let offset = 0; while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset); } else chunks.push(chunk);
      }
      if (expectedHash && (size !== limit || hash.digest('hex') !== expectedHash)) fail('hash');
      if (fd !== undefined) { fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; }
      ok = true; return file || Buffer.concat(chunks);
    } finally {
      clearTimeout(timer); if (fd !== undefined) fs.closeSync(fd);
      if (!ok && file) { this.secure(file); fs.rmSync(file, { force: true }); }
    }
  }
  siblingValid(sibling) {
    if (typeof sibling !== 'string' || path.dirname(sibling) !== path.dirname(this.appPath) || !/^\.ProjectHub-update-[A-Za-z0-9]+$/.test(path.basename(sibling))) fail('journal');
    securePath(sibling, sibling); noLinks(this.appPath);
  }
  async inspectApp(app, m) {
    const hash = treeHash(app); if (hash.treeSha256 !== m.app.treeSha256 || hash.entries !== m.app.entries) fail('tree-hash');
    await this.platformApi.appUpdater.verify(app, undefined, this.run.bind(this), true);
    const quarantine = await this.platformApi.appUpdater.quarantine(app, this.run.bind(this)); if (quarantine.split('\n').includes('com.apple.quarantine')) fail('quarantine');
    const plist = await this.platformApi.appUpdater.bundlePlist(app, this.run.bind(this));
    if (plist.CFBundleIdentifier !== 'local.projecthub' || plist.CFBundleShortVersionString !== m.version || plist.HubDir !== '@bundle/runtime/hub' || plist.HubRoot || plist.HubStorageGuard || !/^[A-Za-z0-9_-]+$/.test(plist.CFBundleExecutable || '')) fail('plist');
    const executable = path.join(app, 'Contents/MacOS', plist.CFBundleExecutable);
    if (!fs.lstatSync(executable).isFile() || !(fs.statSync(executable).mode & 0o111) || (await this.platformApi.appUpdater.architecture(executable, this.run.bind(this))) !== 'arm64') fail('architecture');
    const hub = path.join(app, 'Contents/Resources/runtime/hub');
    if (readJSON(path.join(hub, 'package.json')).version !== m.version) fail('runtime-version');
    const forbidden = new Set(['.git', 'owner-edition.js', 'license-issuer']);
    const scan = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (forbidden.has(e.name)) fail('private-content'); if (e.isDirectory()) scan(path.join(dir, e.name)); } };
    scan(app); return hash;
  }
  async prepare(m) {
    this.phase('downloading');
    const downloads = path.join(this.home, 'downloads', m.version); securePath(downloads, this.root); fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
    const dmg = path.join(downloads, m.asset.name), part = dmg + '.part'; securePath(part, this.root); fs.rmSync(part, { force: true });
    // Downloads are verified again; never trust a leftover file after a crash.
    if (fs.existsSync(dmg)) { securePath(dmg, this.root); fs.rmSync(dmg); }
    await this.receive(m.asset.url, { limit: m.asset.size, timeout: 600000, file: part, expectedHash: m.asset.sha256 }); fs.renameSync(part, dmg);
    this.phase('verifying');
    const mount = fs.mkdtempSync(path.join(this.home, 'mnt-'));
    const sibling = fs.mkdtempSync(path.join(path.dirname(this.appPath), '.ProjectHub-update-'));
    fs.chmodSync(sibling, 0o700); const fresh = path.join(sibling, 'new.app');
    let attached = false, ready = false;
    try {
      await this.platformApi.appUpdater.verifyDmg(dmg, this.run.bind(this));
      this.data.mount = mount; this.persist(); attached = true; // Also detach after an interrupted attach.
      await this.platformApi.appUpdater.attachDmg(dmg, mount, this.run.bind(this));
      const names = fs.readdirSync(mount);
      if (!names.includes('Project Hub.app') || names.some(x => !['Project Hub.app', 'Applications'].includes(x))) fail('dmg-content');
      if (names.includes('Applications') && (!fs.lstatSync(path.join(mount, 'Applications')).isSymbolicLink() || fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications')) fail('dmg-content');
      await this.inspectApp(path.join(mount, 'Project Hub.app'), m);
      await this.platformApi.appUpdater.copyApp(path.join(mount, 'Project Hub.app'), fresh, this.run.bind(this));
      await this.inspectApp(fresh, m);
      this.data.prepared = { sibling, dmg }; this.phase('ready', { reason: '', error: '' }); ready = true;
    } finally {
      if (attached) await this.detach(mount);
      if (!ready) { this.siblingValid(sibling); fs.rmSync(sibling, { recursive: true, force: true }); }
      if (!attached || !this.data.mount) fs.rmdirSync(mount);
    }
  }
  async detach(mount) {
    if (path.dirname(mount) !== this.home || !/^mnt-[A-Za-z0-9]+$/.test(path.basename(mount))) fail('mount');
    for (const extra of [[], ['-force']]) {
      try { await this.platformApi.appUpdater.detachDmg(mount, extra, this.run.bind(this)); delete this.data.mount; this.persist(); return; } catch {}
    }
    this.data.reason = 'ディスクイメージを閉じられません。次の起動時に確認します'; this.persist();
  }
  async install() {
    if (this.platform === 'win32') return this.status();
    const job = this.data.prepared, m = this.data.manifest;
    if (!job || this.data.pendingConfirm) return this.status();
    if ((this.strictBusy ? await this.strictBusy() : this.busy())) { this.phase('deferred', { reason: this.idleMessage() }); return this.status(); }
    this.siblingValid(job.sibling);
    const fresh = path.join(job.sibling, 'new.app'), old = path.join(job.sibling, 'old.app');
    verifyManifest(this.data.envelope, this.trust, { now: this.now(), version: this.currentVersion, maxSeq: this.data.maxSeq, allowAccepted: true });
    if (!compatible(m, { platform: this.platform, arch: this.arch, macOS: await this.macOS(), node: this.node }) || eligibility(m, this.license?.status(), this.license?.config?.build) !== 'install') fail('requirements');
    await this.inspectApp(fresh, m); this.siblingValid(job.sibling);
    securePath(this.appPath, this.appPath); securePath(old, job.sibling);
    if (!this.supported()) fail('unsupported');
    const install = { target: this.appPath, old, fresh, sibling: job.sibling, from: this.currentVersion, to: m.version, at: this.now() };
    this.phase('installing', { install });
    if ((this.strictBusy ? await this.strictBusy() : this.busy())) { delete this.data.install; this.phase('deferred', { reason: this.idleMessage() }); return this.status(); }
    let moved = false;
    try {
      this.rename(this.appPath, old); moved = true;
      this.rename(fresh, this.appPath);
      this.data.pendingConfirm = { ...install, version: m.version, attempts: 0, deadline: this.now() + 600000, token: crypto.randomUUID(), dmg: job.dmg };
      delete this.data.install; delete this.data.prepared;
      this.phase('installed', { reason: '', error: '' }); this.restartNeeded = true;
    } catch (e) {
      if (moved && fs.existsSync(old)) {
        if (fs.existsSync(this.appPath)) fs.renameSync(this.appPath, fresh);
        fs.renameSync(old, this.appPath);
      }
      delete this.data.pendingConfirm; delete this.data.install; this.restartNeeded = false; throw e;
    }
    return this.status();
  }
  async apply() {
    if (!this.supported() || this.running || this.dry) return this.status();
    return this.lock(async () => { try { await this.install(); } catch (e) { this.failed(e, this.data.manifest); } return this.status(); });
  }
  async recover() {
    if (this.platform === 'win32') return;
    if (this.ownerEdition) return;
    if (this.data.confirmation) await this.finishConfirmation();
    if (this.data.mount) await this.detach(this.data.mount);
    const j = this.data.install;
    if (j) {
      this.siblingValid(j.sibling); if (j.target !== this.appPath || j.old !== path.join(j.sibling, 'old.app') || j.fresh !== path.join(j.sibling, 'new.app')) fail('journal');
      if (fs.existsSync(j.old)) {
        if (fs.existsSync(this.appPath)) fs.renameSync(this.appPath, path.join(j.sibling, 'interrupted-new.app'));
        fs.renameSync(j.old, this.appPath);
      }
      delete this.data.install; delete this.data.prepared;
      this.phase('failed', { error: '前の更新は途中で止まったため、前のアプリへ戻しました' });
    }
    const p = this.data.pendingConfirm;
    if (p) {
      this.siblingValid(p.sibling); if (p.target !== this.appPath) fail('journal');
      if (this.data.rollback === true) {
        const old = path.join(p.sibling, 'old.app'), failed = path.join(p.sibling, 'failed.app');
        if (p.old !== old || p.fresh !== path.join(p.sibling, 'new.app')) fail('journal');
        securePath(old, p.sibling); securePath(failed, p.sibling);
        if (fs.existsSync(old)) {
          if (fs.existsSync(this.appPath)) { if (fs.existsSync(failed)) fail('journal'); fs.renameSync(this.appPath, failed); }
          fs.renameSync(old, this.appPath);
        } else if (!fs.existsSync(failed) || readJSON(path.join(this.nextHub(), 'package.json')).version !== p.from) fail('journal');
        delete this.data.rollback; delete this.data.pendingConfirm; this.restartNeeded = false;
        this.data.rejected = { seq: this.data.manifest?.seq, sha256: this.data.manifest?.asset.sha256, reason: 'startup' };
        this.phase('rolled-back', { reason: '新しい版が2回起動しなかったため前の版へ戻しました' }); return;
      }
      if (this.currentVersion === p.version && this.env.HUB_UPDATE_CONFIRM === p.token) this.phase('confirming');
      else if (this.currentVersion === p.from && this.data.phase === 'rolled-back') this.restartNeeded = false;
      // An old process still running after a successful install must not confirm.
    }
  }
  async finishConfirmation() {
    const p = this.data.confirmation; if (!p) return;
    this.siblingValid(p.sibling);
    const previous = path.join(path.dirname(this.appPath), '.ProjectHub-previous'); noLinks(previous);
    if (fs.existsSync(p.sibling)) {
      if (!fs.existsSync(path.join(p.sibling, 'old.app'))) fail('previous');
      if (fs.existsSync(previous)) {
        if (!this.data.previousVersion) fail('previous');
        securePath(previous, previous); fs.rmSync(previous, { recursive: true });
      }
      fs.renameSync(p.sibling, previous);
    } else if (!fs.existsSync(path.join(previous, 'old.app'))) fail('previous');
    if (p.dmg && p.dmg.startsWith(this.home + path.sep + 'downloads' + path.sep)) { securePath(p.dmg, this.root); fs.rmSync(p.dmg, { force: true }); }
    this.data.previousVersion = p.from; this.data.lastInstalled = { version: p.version, instance: p.instance, at: new Date(this.now()).toISOString() };
    delete this.data.pendingConfirm; delete this.data.confirmation; this.restartNeeded = false;
    this.phase('idle', { reason: '', error: '' });
  }

  async healthy({ version, hubPath, token, restored, instance } = {}) {
    if (!this.data.pendingConfirm || this.running || !restored || !instance) return false;
    return this.lock(async () => {
      const p = this.data.pendingConfirm;
      if (!p || version !== p.version || token !== p.token || token !== this.env.HUB_UPDATE_CONFIRM || hubPath !== this.nextHub() || this.hubPath !== hubPath) return false;
      this.data.confirmation = { ...p, instance };
      this.persist();
      await this.finishConfirmation(); return true;
    });
  }
}
module.exports = { PackagedUpdate, verifyManifest, parseSigningPayload, treeHash, compatible, eligibility, noLinks, securePath, writeJSON, newer, REASONS, run };
