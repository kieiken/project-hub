'use strict';
// 正式なCLI上限だけを保持。利用率からフラグを作ったり解除したりしない。
const fs = require('node:fs');
const path = require('node:path');
const MODEL = 'claude-fable-5-1';
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const relevant = w => w && (['five_hour', 'seven_day'].includes(w.id) ||
  /^model:/.test(w.id || '') && /^Fable(?:\s|・|$)/i.test(w.label || ''));
const nullableTime = value => value === null || Number.isFinite(stamp(value));

class LimitEvidence {
  constructor(file, options = {}) {
    this.file = file; this.account = options.account || 'default'; this.scopes = new Map();
    this.key = this.account === 'default' ? MODEL : MODEL + ':' + this.account;
    this.now = options.now || Date.now;
    this.evidence = null;
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'))[this.key];
      if (e?.source !== 'cli-limit' || !Number.isFinite(stamp(e.at)) ||
          !nullableTime(e.validUntil) || !nullableTime(e.checkedAt)) return;
      if (e.version === 2 && e.hold === true && stamp(e.lastLimitAt) >= stamp(e.at) &&
          ['project', 'task', 'request'].every(key => typeof e[key] === 'string') &&
          ['usage', 'unknown'].includes(e.untilSource) &&
          (e.untilSource === 'unknown' ? e.validUntil === null && e.checkedAt === null :
            stamp(e.validUntil) > stamp(e.at) && stamp(e.checkedAt) >= stamp(e.at))) {
        this.evidence = e;
      } else if (e.version === undefined && stamp(e.validUntil) > this.now() && stamp(e.checkedAt) > stamp(e.at)) {
        this.evidence = { ...e, project: String(e.project || ''), task: String(e.task || ''), request: String(e.request || ''), version: 2, hold: true, lastLimitAt: e.at, untilSource: 'usage' };
      }
    } catch { /* 初回・破損・不完全な記録は保持なし */ }
  }
  scope(account = 'default') {
    if (account === this.account) return this;
    if (!this.scopes.has(account)) this.scopes.set(account, new LimitEvidence(this.file, { now: this.now, account }));
    return this.scopes.get(account);
  }
  save(e) {
    // 書込・置換が成功するまで直前のメモリ状態を変えない。
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + `.${process.pid}.tmp`;
    let all = {}; try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (e) all[this.key] = { ...e, account: this.account }; else delete all[this.key];
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.evidence = e;
  }
  record(o) {
    if ((o.account || 'default') !== this.account) return this.scope(o.account || 'default').record(o);
    const old = this.active(), at = new Date(this.now()).toISOString();
    this.save(old ? { ...old, lastLimitAt: at } : {
      account: this.account, version: 2, source: 'cli-limit', hold: true, at, lastLimitAt: at,
      project: String(o.project || ''), task: String(o.task || ''), request: String(o.request || o.started || ''),
      validUntil: null, untilSource: 'unknown', checkedAt: null });
  }
  success() { /* 成功は保持を解除しない */ }
  clear(account = this.account) { if (account !== this.account) return this.scope(account).clear(); this.save(null); }
  observe(snapshot) {
    if (Array.isArray(snapshot?.accountProviders)) {
      for (const p of snapshot.accountProviders.filter(p => p.ai === 'claude')) this.scope(p.account || 'default').observe({ providers: { claude: p } });
      return;
    }
    const p = snapshot?.providers?.claude;
    if ((p?.account || 'default') !== this.account) return;
    const e = this.active();
    if (!e || p?.status !== 'ok' || !Array.isArray(p.windows)) return;
    // 取得開始が新しいフラグより前なら、後から届いても使わない。
    const attempted = stamp(p.attemptedAt), checked = stamp(p.fetchedAt);
    if (!(attempted >= stamp(e.at)) || !(checked >= attempted) || checked <= stamp(e.checkedAt)) return;
    const resets = p.windows.filter(relevant).filter(w =>
      Number.isFinite(w.usedPercent) && w.usedPercent >= 100 && stamp(w.resetsAt) > this.now()
    ).map(w => stamp(w.resetsAt));
    if (!resets.length) return;
    const until = Math.max(stamp(e.validUntil) || 0, ...resets);
    this.save({ ...e, validUntil: new Date(until).toISOString(), untilSource: 'usage', checkedAt: p.fetchedAt });
  }
  active(account = this.account) {
    if (account !== this.account) return this.scope(account).active();
    const e = this.evidence;
    if (!e?.hold) return null;
    if (e.validUntil === null || stamp(e.validUntil) > this.now()) return { ...e };
    // 期限切れは保存失敗でも無効。再起動時も同じ期限判定をする。
    try { this.save(null); } catch { this.evidence = null; }
    return null;
  }
  needsRefresh() { return false; }
}
module.exports = { LimitEvidence };
