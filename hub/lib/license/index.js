'use strict';
const c = require('node:crypto');
const platforms = require('../platform');
const policy = require('./policy');
const { PAID, MAX_TERM, fingerprint, verifyEnvelope, validateProof, scopeMatches, evaluate } = require('./codec');
const { LicenseClock } = require('./clock');
const { LicenseStore } = require('./storage');
const issuerMessages = Object.freeze({
  device_limit_mac: 'この利用権のMacは登録台数の上限です。前の端末を外す時は運営に連絡してください',
  device_limit_windows: 'この利用権のWindowsは登録台数の上限です。前の端末を外す時は運営に連絡してください',
  unregistered: 'この端末は登録されていません。移行について運営に連絡してください',
  unsupported_os: 'このOSは利用コードの対象外です',
  entitlement: 'この利用コードの有効性を確認できませんでした。発行先・対象の版・有効期間の確認が必要です。再送・再購入せず、発行元に確認してください。',
  issuer_unavailable: '発行先からエラー応答があり、登録を完了できませんでした。保存済みの利用証明は保持しています。',
  issuer_connection: '発行先の応答を確認できませんでした。登録結果は未確認です。再送・再購入せず、状況を確認してください。',
  issuer_response: '発行先の応答を読み取れませんでした。登録結果は未確認です。再送・再購入せず、状況を確認してください。',
  invalid_code: '利用コードを入力してください（256文字以内）。',
  license_busy: '利用権を確認中です。登録結果を確認するまで、再送しないでください。',
  license_activation: '利用コードの登録結果を確認できませんでした。保存済みの利用証明は保持しています。再送・再購入せず、状況を確認してください。',
  // Preserve the fixed local precondition guidance added in the 4.125 line.
  issuer_unconfigured: 'この版の利用コード受付は準備中です。実際のコードは入力せずお待ちください',
  license_unsupported: 'このOSは利用コードの対象外です',
  legacy_license_unavailable: '以前の利用権を確認できません。選んだデータの保存先は使えますが、有料機能・無料体験の開始・コード登録は保留しています。購入や登録を繰り返さず、この表示をお知らせください。',
  license_registration_pending: '利用コードの登録は受付済みです。再送・再購入せず結果を確認してください。',
});
const issuerHttpCodes = new Set(['device_limit_mac', 'device_limit_windows', 'unregistered', 'unsupported_os', 'entitlement', 'trial_used', 'challenge', 'signature', 'build_os', 'trial_daily_limited']);
// Only fixed classifications/messages cross the registration API boundary.
function activationError(error) {
  let value = error?.code;
  // These two existing local validation errors have a fixed message but no code.
  if (value === undefined && ['invalid_code', 'license_busy'].includes(error?.message)) value = error.message;
  const code = typeof value === 'string' && (Object.hasOwn(issuerMessages, value) || issuerHttpCodes.has(value)) ? value : 'license_activation';
  return { error: issuerMessages[code] || issuerMessages.issuer_unavailable, code };
}
function ownerEdition() {
  try { return require('./owner-edition').ownerEdition === true; }
  catch (e) { if (e.code === 'MODULE_NOT_FOUND' && e.message.includes("'./owner-edition'")) return false; throw e; }
}
const message = '利用権を確認できません。利用コードを登録するか、表示された期限と時刻を確認してください。資料の閲覧・保存・取り出しは使えます';
const macMachineHint = platforms.forPlatform('darwin').machineHint;
class License {
  constructor({ root, platform = process.platform, config = policy.forPlatform(platform), owner = ownerEdition(),
    store = new LicenseStore(root, platforms.forPlatform(platform)), secret = platforms.forPlatform(platform).secretStore(), fetcher = fetch,
    elapsed, wall = () => Date.now() / 1000, machineHint = platforms.forPlatform(platform).machineHint, extensions = require('../extensions').loadExtensions(), onDiagnostic = () => {} } = {}) {
    this.config = config; this.owner = owner; this.store = store; this.secret = secret; this.fetcher = fetcher;
    this.elapsed = elapsed || (() => secret.elapsed()); this.wall = wall; this.platform = platform;
    this.onDiagnostic = onDiagnostic;
    this.suspended = false;
    this.execution = ['queue_auto','limit_switch','parallel'].map(id => ({id,included:extensions.state().included.includes(id),policy:extensions.create(id,{})}));
    for (const {policy} of this.execution) if (typeof policy.features !== 'function') throw Error('invalid execution decision contract');
    this.machineHint = machineHint; this.trialUsed = false;
    this.identity = null; this.clock = null; this.proofs = []; this.lastResult = null; this.lastOnline = 0; this.retryAfter = 0;
    if (!owner && ['darwin', 'win32'].includes(platform)) {
      try {
        this.proofs = this.checked('load-state', () => store.read('state'))?.proofs || [];
        const meta = this.checked('load-device', () => store.read('device'));
        if (meta) {
          this.identity = this.checked('key-restore', () => {
            const raw = secret.get(meta.id);
            if (!raw) throw Error('device_key_missing');
            return this.identityFrom(raw, meta);
          });
        }
        if (this.proofs.length) this.makeClock();
      } catch { this.loadError = true; }
    }
  }
  recordFailure(stage, error, hold = true) {
    if (hold) this.loadError = true;
    // Watcher loss invalidates trusted time without itself holding the licence.
    // Keep its first event separately so it cannot hide the first holding fault.
    const field = hold ? 'firstFailure' : 'resumeWatchFailure';
    if (!this[field]) {
      this[field] = require('./diagnostics').failure(stage, error);
      try { this.onDiagnostic(this[field]); } catch {} // Diagnostic I/O never replaces the original result.
    }
  }
  checked(stage, operation) {
    try { return operation(); } catch (error) { this.recordFailure(stage, error); throw error; }
  }
  identityFrom(raw, meta) {
    const b = JSON.parse(raw), privateKey = c.createPrivateKey({ key: Buffer.from(b.privateKeyPkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
    const publicKey = c.createPublicKey(privateKey), dev = fingerprint(publicKey);
    const nonce = c.randomBytes(32);
    if (dev !== meta.dev || !c.verify(null, nonce, publicKey, c.sign(null, nonce, privateKey))) throw Error('device');
    return { id: meta.id, dev, privateKey, publicKeySpkiB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  }
  ensureIdentity() {
    this.requireSupported();
    if (this.identity) return this.identity;
    // An unreadable identity must never be silently replaced.
    if (this.store.read('device') || this.loadError) throw Error('device_key_unavailable');
    const id = c.randomUUID(), account = 'device-' + id, pair = c.generateKeyPairSync('ed25519');
    const bundle = JSON.stringify({ privateKeyPkcs8B64: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
    this.secret.put(account, bundle);
    const meta = { id: account, dev: fingerprint(pair.publicKey) };
    this.store.write('device', meta);
    this.identity = this.identityFrom(this.secret.get(account), meta);
    return this.identity;
  }
  makeClock() {
    if (!this.clock) this.clock = new LicenseClock({ state: this.checked('load-state', () => this.store.read('state')), elapsed: this.elapsed, wall: this.wall,
      save: s => this.store.write('state', { ...s, proofs: this.proofs }), onFailure: (stage, error) => this.recordFailure(stage, error) });
    return this.clock;
  }
  status() {
    if (this.owner) return { edition: 'owner', enforcement: false, features: Object.fromEntries(['chat_basic', ...PAID].map(f => [f, { allowed: true, state: 'owner', expiry: null }])) };
    if (!['darwin', 'win32'].includes(this.platform)) return { edition: 'public', enforcement: true, supported: false, reason: 'このOSは利用コードの対象外です',
      features: Object.fromEntries(['chat_basic', ...PAID].map(f => [f, { allowed: f === 'chat_basic', state: f === 'chat_basic' ? 'basic' : 'held', expiry: null }])) };
    let clock = { t: this.wall(), wall: this.wall(), mode: 'U', valid: false };
    if (this.platform === 'win32' && this.resumeUnavailable && this.clock) this.clock.mode = 'U';
    try { if (!this.suspended && this.proofs.length) clock = this.makeClock().tick(); } catch (error) { this.recordFailure('status-tick', error); }
    const result = evaluate({ proofs: this.proofs, keys: this.config.trustedKeys, device: { ok: Boolean(this.identity) && !(this.platform === 'win32' && this.loadError), dev: this.identity?.dev }, build: this.config.build, clock });
    const personal = this.proofs.map(e => { try { return validateProof(verifyEnvelope(e, this.config.trustedKeys, 'proof')); } catch { return null; } })
      .find(p => p?.kind === 'trial' && p.dev === this.identity?.dev && scopeMatches(p.scope, this.config.build));
    const expiry = personal ? Math.min(personal.exp, personal.entEndsAt, personal.betaExpiresAt ?? Infinity, personal.globalEndAt ?? Infinity) : null;
    const trial = { state: personal ? clock.t >= expiry ? 'expired' : result.features[PAID[0]].state === 'held' ? 'held' : 'active' : this.trialUsed ? 'used' : 'pending',
      days: this.config.trialDays, startsAt: personal?.entStartsAt ?? null, expiry, remainingDays: expiry ? Math.max(0, Math.ceil((expiry - clock.t) / 86400)) : null };
    const reasons = { active: `無料体験中：あと ${trial.remainingDays} 日（${expiry ? new Date(expiry * 1000).toLocaleDateString('ja-JP') : ''}まで）。すべての機能を使えます`,
      expired: '無料体験は終わりました。基本の機能と資料はこのまま使えます。有効な利用コードを登録すると、対象の版の全機能が使えます',
      used: 'このPCでは無料体験をすでに使いました。基本の機能と資料はこのまま使えます',
      pending: `インターネットにつながると、無料体験${trial.days ? `（${trial.days}日間）` : ''}が自動で始まります。今は基本の機能と資料が使えます` };
    let purchaseUrl = '';
    try { const url = new URL(this.config.purchaseUrl); if (url.protocol === 'https:' && !url.username && !url.password) purchaseUrl = url.href; } catch {}
    const purchased = PAID.every(f => result.features[f].state === 'purchased');
    return { edition: 'public', enforcement: this.config.licenseEnforcement, ...result, trial, purchaseUrl, purchased, activationAvailable: Boolean(this.config.endpoint),
      ...(this.firstFailure ? { diagnostic: this.firstFailure } : {}),
      ...(this.resumeWatchFailure ? { resumeDiagnostic: this.resumeWatchFailure } : {}),
      introAvailable: Boolean(purchaseUrl && !purchased && !this.loadError && personal && trial.state === 'active' && personal.entStartsAt <= clock.t && clock.t < expiry),
      reason: purchased ? '購入した版の全機能を期限なしで使えます' :
        this.loadError ? '端末の鍵・保存内容・経過時計を確認できません' :
        this.platform === 'win32' && !this.config.endpoint && trial.state === 'pending' ? 'Windows確認版です。無料体験と購入の受付は準備中です。基本の機能と資料は使えます' : reasons[trial.state] || message };
  }
  require(features) {
    const result = this.status(); this.lastResult = result;
    // Only the existing basic conversation is free. New named capabilities use
    // the full paid entitlement; an unknown name must never silently bypass it.
    const denied = features.filter(f => f !== 'chat_basic' &&
      !(PAID.includes(f) ? result.features[f]?.allowed : PAID.every(p => result.features[p]?.allowed)));
    if (result.enforcement && denied.length) {
      const e = Error(result.reason); e.code = 'license_held'; e.status = 403; e.features = denied; throw e;
    }
    return result;
  }
  guard(options = {}, { active = [], stage = 'start' } = {}) {
    const features = [];
    if (options.licenseFeatures) features.push(...options.licenseFeatures);
    if (options.ai === 'chatgpt') features.push('webchat');
    if (options.origin === 'delegate') features.push('delegate');
    if (options.origin === 'discussion') features.push('discussion');
    if (options.origin === 'role-review') features.push('role_review');
    if (options.automation?.kind === 'idea') features.push('idea_automation');
    for (const {policy} of this.execution) features.push(...policy.features(options, active));
    try {
      const required=[...new Set(features)], result=this.require(required);
      const unavailable=this.execution.filter(x=>!x.included && required.includes(x.id)).map(x=>x.id);
      if(unavailable.length)throw Object.assign(Error(result.reason || message),{code:'license_held',status:403,features:unavailable});
      return result;
    }
    catch (e) { if (stage === 'start') e.licenseHeld = true; throw e; }
  }
  os() { const value = { darwin: 'mac', win32: 'windows' }[this.platform]; if (!value) throw Error('unsupported_os'); return value; }
  requireSupported() {
    if (!this.owner && !['darwin', 'win32'].includes(this.platform)) throw Object.assign(Error('このOSは利用コードの対象外です'), { code: 'license_unsupported', status: 403 });
  }
  async post(route, body) {
    this.requireSupported();
    const url = this.config.endpoint;
    if (!url || !/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(url)) throw Error('issuer_unconfigured');
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) };
    let response;
    try { response = await this.fetcher(url.replace(/\/$/, '') + route, request); }
    catch { throw Object.assign(Error(issuerMessages.issuer_connection), { code: 'issuer_connection' }); }
    if (!response.ok) {
      let value; try { value = (await response.json())?.code; } catch {}
      const code = issuerHttpCodes.has(value) ? value : 'issuer_unavailable';
      const retryAt = code === 'trial_daily_limited' && response.status === 429
        ? this.wall() + Math.min(86400, Math.max(60, Number(response.headers.get('Retry-After')) || 86400)) : 0;
      throw Object.assign(Error(activationError({ code }).error), { code, retryAt });
    }
    try { return await response.json(); }
    catch { throw Object.assign(Error(issuerMessages.issuer_response), { code: 'issuer_response' }); }
  }
  async signedRequest(purpose, params) {
    const d = this.ensureIdentity();
    const body = { ...params, purpose, dev: d.dev, publicKeySpkiB64: d.publicKeySpkiB64, os: this.os(), buildId: this.config.build.buildId };
    const challenge = await this.post('/challenge', body);
    const claim = { purpose, nonce: challenge.nonce, dev: d.dev, os: body.os, buildId: body.buildId,
      ...(purpose === 'trial' ? { machineHint: params.machineHint } : {}), ...(params.timeNonce ? { timeNonce: params.timeNonce, lastSeq: params.lastSeq } : {}) };
    const sig = c.sign(null, Buffer.from(JSON.stringify(claim)), d.privateKey).toString('base64url');
    return this.post(purpose === 'intro' ? '/purchase/intro' : '/' + purpose, { ...claim, sig });
  }
  acceptProof(envelope) {
    const p = validateProof(verifyEnvelope(envelope, this.config.trustedKeys, 'proof'));
    if (!this.identity || p.dev !== this.identity.dev || !scopeMatches(p.scope, this.config.build)) throw Error('proof_target');
    const clock = this.makeClock();
    if (p.seq <= (clock.state?.maxSeq || 0)) throw Error('proof_replay');
    // Sequence and proofs share one durable document to avoid split writes.
    const next = [...this.proofs.filter(e => { try { return verifyEnvelope(e, this.config.trustedKeys, 'proof').ent !== p.ent; } catch { return false; } }), envelope];
    const s = { ...(clock.state || { lastSeenAt: 0, uptimeSinceAnchor: 0, anchor: { serverTime: 0, seq: 0 } }), maxSeq: p.seq };
    this.store.write('state', { ...s, proofs: next }); this.proofs = next; clock.state = s;
    return p;
  }
  async introCheckout() {
    if (this.owner || !this.status().introAvailable) throw Error('intro_unavailable');
    if (this.online) throw Error('license_busy');
    const p = this.proofs.map(e => { try { return validateProof(verifyEnvelope(e, this.config.trustedKeys, 'proof')); } catch { return null; } })
      .find(p => p?.kind === 'trial' && p.dev === this.identity?.dev && scopeMatches(p.scope, this.config.build));
    this.online = true;
    try {
      const result = await this.signedRequest('intro', { ent: p.ent });
      const target = new URL(result.url);
      if (target.origin !== 'https://checkout.stripe.com' || target.username || target.password || !target.pathname.startsWith('/c/') || /[\s\x00-\x1f\x7f\\]/.test(result.url)) throw Error('intro_unavailable');
      return { url: target.href };
    } catch { throw Error('体験価格の購入画面を開けません。支払い状況を確認してから、もう一度操作してください'); }
    finally { this.online = false; }
  }
  async activate(code) {
    if (this.owner) return { ok: true, owner: true, note: '製作者版は利用コードの登録が不要です' };
    this.requireSupported();
    if (!this.config.endpoint) throw Object.assign(Error(issuerMessages.issuer_unconfigured), { code: 'issuer_unconfigured' });
    if (typeof code !== 'string' || !code.trim() || code.length > 256) throw Error('invalid_code');
    if (this.online) throw Error('license_busy');
    this.online = true;
    try {
      const result = await this.signedRequest('activate', { code: code.trim() });
      const p = this.acceptProof(result.proof);
      // A successful paid activation supersedes a wait for new-trial admission.
      this.retryAfter = 0;
      try { await this.refreshTime(p.ent); } catch {} // Proof remains safe; short-term stays held until a time anchor.
      return { ok: true, status: this.status() };
    } finally { this.online = false; }
  }
  async refreshTime(ent) {
    this.requireSupported();
    const d = this.identity, clock = this.makeClock();
    if (!d) return false;
    const req = clock.request(d.dev);
    try {
      const result = await this.signedRequest('time', { ent, timeNonce: req.nonce, lastSeq: req.lastSeq });
      return clock.accept(result.time, this.config.trustedKeys);
    } finally { clock.cancel(); }
  }
  async prepare() {
    if (this.owner || !['darwin', 'win32'].includes(this.platform) || !this.config.endpoint) return;
    if (this.suspended) return;
    if (this.preparing) return this.preparing;
    if (this.online) return;
    this.preparing = this.prepareOnline();
    try { await this.preparing; } finally { this.preparing = null; }
  }
  async prepareOnline() {
    this.requireSupported();
    if (this.wall() < this.retryAfter) return;
    this.online = true;
    let failed = false, retryAt = 0;
    try {
      let proofs = this.proofs.map(e => { try { return validateProof(verifyEnvelope(e, this.config.trustedKeys, 'proof')); } catch { return null; } })
        .filter(p => p && p.dev === this.identity?.dev && scopeMatches(p.scope, this.config.build));
      if (!proofs.length && !this.trialUsed) {
        this.requireSupported();
        const hint = this.machineHint();
        const r = await this.signedRequest('trial', { machineHint: hint });
        const p = this.acceptProof(r.proof); proofs = [p];
      }
      if (!proofs.length) return;
      // Network failure does not tick or alter saved state.
      for (const p of proofs) { try { if (await this.refreshTime(p.ent)) { this.lastOnline = this.wall(); break; } failed = true; } catch { failed = true; } }
      const now = this.clock?.tPrev || this.wall();
      for (const p of proofs) if (!['purchase', 'trial'].includes(p.kind) && p.exp > now && p.exp - now <= 7 * 86400) {
        try { const r = await this.signedRequest('renew', { ent: p.ent }); this.acceptProof(r.proof); } catch { failed = true; }
      }
    } catch (e) { failed = true; retryAt = e.retryAt || 0; if (e.code === 'trial_used') this.trialUsed = true; }
    finally {
      // Retry failures separately from start()'s six-hour successful refresh cadence.
      this.retryAfter = failed ? Math.max(this.wall() + 60, retryAt) : 0;
      this.online = false;
    }
  }
  start() {
    if (this.owner || !['darwin', 'win32'].includes(this.platform) || this.timer) return;
    const resume = () => { this.suspended = false; try { this.clock?.resume(); } catch (error) { this.recordFailure('resume-tick', error); } };
    // A suspend notification must never start synchronous native/SQLite I/O.
    // Windows may freeze those children before they reply, making a healthy
    // guard time out and permanently poisoning this process's licence bridge.
    const suspend = () => { this.suspended = true; this.clock?.suspend(); };
    if (this.config.endpoint || this.proofs.length) {
      const unavailable = error => { this.resumeUnavailable = true; this.recordFailure('resume-watch', error, false); this.clock?.suspend(); };
      this.stopResume = this.secret.watchResume?.(resume, unavailable, suspend);
      if (this.platform === 'win32' && !this.stopResume) unavailable();
    }
    void this.prepare();
    this.timer = setInterval(() => {
      try { if (this.proofs.length) this.status(); } catch {}
      if (this.wall() - this.lastOnline >= 6 * 3600) void this.prepare();
    }, 60000); this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; this.stopResume?.(); this.stopResume = null; }
}
module.exports = { License, ownerEdition, macMachineHint, activationError };
