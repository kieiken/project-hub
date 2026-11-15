'use strict';

const { verifyKey } = require('./jev-verify');
class JevSettings {
  constructor({ platform = require('./platform'), store, dry = false, verify = verifyKey, now = () => new Date().toISOString() } = {}) {
    this.verifyKey = verify; this.now = now; this.busy = false;
    this.verification = { connection: 'unverified', checkedAt: null };
    this.store = dry || (!store && !['darwin', 'win32'].includes(platform.name)) ? null : (store || platform.secretStore());
  }
  status() {
    const supported = typeof this.store?.jevStatus === 'function' && typeof this.store?.putJev === 'function';
    const registered = supported ? this.store.jevStatus() : null;
    if (supported && typeof registered !== 'boolean') throw Error('jev_storage_unavailable');
    if (!registered) this.reset();
    const search = this.search?.status();
    return { supported, registered, ...this.verification, integration: search?.enabled ? 'conversation-search' : 'disconnected', enabled: !!search?.enabled,
      ...(search ? { search } : {}) };
  }
  configureSearch(body) {
    if (!body || Array.isArray(body) || Object.keys(body).length !== 2 || body.confirm !== true || typeof body.enabled !== 'boolean') throw Error('jev_search_invalid');
    if (this.busy || !this.search || (body.enabled && this.status().registered !== true)) throw Error('jev_search_unavailable');
    this.search.budget.configure(body.enabled);
    return this.status();
  }
  reset() { this.verification = { connection: 'unverified', checkedAt: null }; }
  save(body) {
    if (this.busy) throw Error('jev_busy');
    if (!body || Array.isArray(body) || body.confirm !== true || Object.keys(body).length !== 2 ||
        typeof body.key !== 'string' || !/^[\x21-\x7e]{16,1024}$/.test(body.key)) throw Error('jev_key_invalid');
    if (typeof this.store?.putJev !== 'function') throw Error('jev_storage_unavailable');
    this.reset(); // Even an ambiguous failed write must invalidate earlier verification.
    this.store.putJev(body.key);
    const status = this.status();
    if (status.registered !== true) throw Error('jev_storage_unavailable');
    return status;
  }
  async verify(body) {
    if (!body || Array.isArray(body) || body.confirm !== true || Object.keys(body).length !== 1) throw Error('jev_confirm_required');
    if (this.busy) throw Error('jev_busy');
    this.busy = true;
    try {
      // Explicit verification reads a key; opt-in search has its own reader.
      // GET status and registration never read it.
      let connection = 'unavailable';
      try {
        if (typeof this.store?.getJev !== 'function') throw Error('jev_storage_unavailable');
        const key = this.store.getJev();
        if (typeof key === 'string' && /^[\x21-\x7e]{16,1024}$/.test(key)) {
          const result = await this.verifyKey(key);
          if (['verified', 'rejected', 'unavailable'].includes(result)) connection = result;
        }
      } catch { /* Fixed state only; never expose native/network errors. */ }
      this.verification = { connection, checkedAt: this.now() };
      return { ...this.verification };
    } finally { this.busy = false; }
  }
}
module.exports = { JevSettings };
