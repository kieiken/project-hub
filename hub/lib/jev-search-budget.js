'use strict';
const fs = require('./platform/file-io'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { noLinks } = require('./remove');
// Official models page, read 2026-11-05. Pin model and standard context;
// reserve the entire 64k input ceiling, not an estimated snippet token count.
const POLICY = Object.freeze({ model: 'jev-1.14.0', readAt: '2026-11-05', url: 'https://docs.typesafe.ai/models',
  inputTokens: 64000, perQuestionTokens: 32000, usdPerMillion: 0.042,
  attemptMicros: 2688, maxRequests: 1000, maxMicros: 3000000, id: 'jev-1.14-20261105-64k' });
class JevSearchBudget {
  constructor(file, { now = () => new Date(), persistence = require('./platform').persistence } = {}) {
    this.file = file; this.now = now; this.persistence = persistence;
  }
  month() { return this.now().toISOString().slice(0, 7); }
  read() {
    noLinks(this.file);
    let st;
    try { st = fs.lstatSync(this.file); } catch (e) {
      if (e.code === 'ENOENT') return { schema: 1, policy: POLICY.id, enabled: false, month: this.month(), requests: 0, micros: 0 };
      throw e;
    }
    if (!st.isFile() || st.nlink !== 1 || st.size > 4096) throw Error('jev_budget_invalid');
    const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (s.schema !== 1 || s.policy !== POLICY.id || typeof s.enabled !== 'boolean' ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) || s.month > this.month() ||
        !Number.isSafeInteger(s.requests) || s.requests < 0 || s.requests > POLICY.maxRequests ||
        !Number.isSafeInteger(s.micros) || s.micros < 0 || s.micros > POLICY.maxMicros ||
        s.micros < s.requests * POLICY.attemptMicros) throw Error('jev_budget_invalid');
    return s.month === this.month() ? s : { ...s, month: this.month(), requests: 0, micros: 0 };
  }
  status() {
    try { const s = this.read(); return { available: true, enabled: s.enabled, month: s.month, requests: s.requests,
      reservedUSD: s.micros / 1e6, maxRequests: POLICY.maxRequests, maxUSD: POLICY.maxMicros / 1e6 }; }
    catch { return { available: false, enabled: false, maxRequests: POLICY.maxRequests, maxUSD: POLICY.maxMicros / 1e6 }; }
  }
  change(operation) {
    const dir = path.dirname(this.file), lock = this.file + '.lock';
    noLinks(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); noLinks(this.file); noLinks(lock);
    // Exclusive across processes. Never steal a lock after a crash: fail closed.
    fs.mkdirSync(lock, { mode: 0o700 });
    let temp;
    try {
      this.persistence.syncDirectory(dir);
      const s = this.read(), next = operation(s);
      temp = this.file + '.' + randomUUID() + '.tmp';
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.persistence.withDirectorySync(dir, () => { noLinks(this.file); fs.renameSync(temp, this.file); });
      temp = null;
      return next;
    } finally {
      // Never roll back an ambiguous rename/flush. Its charge remains reserved.
      if (temp) try { fs.unlinkSync(temp); } catch { /* no secret or payload in this file */ }
      fs.rmdirSync(lock);
    }
  }
  configure(enabled) { this.change(s => ({ ...s, enabled })); return this.status(); }
  reserve() {
    try {
      this.change(s => {
        if (!s.enabled) throw Error('off');
        if (s.requests + 1 > POLICY.maxRequests || s.micros + POLICY.attemptMicros > POLICY.maxMicros) throw Error('limit');
        return { ...s, requests: s.requests + 1, micros: s.micros + POLICY.attemptMicros };
      });
      return { ok: true };
    } catch (e) { return { ok: false, reason: ['off', 'limit'].includes(e.message) ? e.message : 'budget-unavailable' }; }
  }
}
module.exports = { JevSearchBudget, POLICY };
