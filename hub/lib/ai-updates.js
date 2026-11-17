'use strict';
// 日次は読取だけ。一括全体のロックと同日予約を、CLI個別操作とは分けて保持する。
const fs = require('./platform/file-io');
const path = require('node:path');
const { AIS } = require('./launch');
const { toolError } = require('./ai-tools');
const { lt } = require('./locale');
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const normalized = models => models.map(({ id, label }) => ({ id, label: label || id })).sort((a, b) => a.id.localeCompare(b.id));
function compare(before, after) {
  const old = new Map((before || []).map(m => [m.id, m.label]));
  const current = new Map(after.map(m => [m.id, m.label]));
  const added = after.filter(m => !old.has(m.id)).map(m => m.id);
  const removed = [...old.keys()].filter(id => !current.has(id));
  const renamed = after.filter(m => old.has(m.id) && old.get(m.id) !== m.label).map(m => m.id);
  return { state: !before ? 'first' : added.length || removed.length || renamed.length ? 'changed' : 'same', added, removed, renamed };
}
class AiUpdates {
  constructor({ tools, accounts, root, now = () => new Date(), onCatalog = () => {} }) {
    Object.assign(this, { tools, accounts, now, onCatalog });
    this.file = path.join(root, '_hub', 'ai-updates.json');
    this.data = { version: 1, day: '', rows: {}, baselines: {} };
    this.error = ''; this.batch = false; this.pending = null; this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.rows || typeof saved.rows !== 'object' || Array.isArray(saved.rows) || !saved.baselines || typeof saved.baselines !== 'object' || Array.isArray(saved.baselines) || typeof saved.day !== 'string') throw Error('format');
      this.data = saved;
    } catch (e) { if (e.code !== 'ENOENT') this.error = lt('更新確認の記録を読めませんでした。保存先を確認してください。'); }
    this.data.clients ||= {};
    this.data.modelClients ||= {};
    if ([this.data.clients, this.data.modelClients].some(value => typeof value !== 'object' || Array.isArray(value))) {
      this.error = lt('更新確認の記録を読めませんでした。保存先を確認してください。');
    }
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* なし */ }
      this.error = lt('更新確認の記録を保存できませんでした。保存先を確認してください。');
      throw toolError(500, 'save', this.error);
    }
  }
  status() {
    const tools = Object.fromEntries(AIS.map(ai => {
      const row = this.data.rows[ai] || { eligible: false, status: 'unknown' };
      const catalog = this.tools.catalog()[ai];
      return [ai, { ...row, installed: Boolean(this.tools.find(ai)), models: catalog.models, source: catalog.source,
        method: row.check ? row.method : row.method || '', updateCheck: row.check || null,
        updating: this.tools.operation?.ai === ai, busyCount: this.tools.busy(ai), checking: this.tools.checking.has(ai) }];
    }));
    return { tools, operation: this.tools.operation || this.tools.maintenance?.operation || null,
      busyCount: this.tools.busy(), error: this.error, day: this.data.day };
  }
  assertStorage() { if (this.error) throw toolError(500, 'save', this.error); }
  modelBlocker(ai) {
    if (this.tools.busy(ai)) return lt('モデル一覧はAIの作業・順番待ちが終わってから確認します。');
    if ([...(this.accounts.locks || [])].some(key => key.startsWith(ai + ':')) || this.accounts.terminalBusy?.(ai, undefined, true)) {
      return lt('モデル一覧はログインなどのアカウント操作が終わってから確認します。');
    }
    return '';
  }
  defer(row, reason) {
    row.deferred = true; row.modelsStatus = 'unknown'; row.notice = reason;
    return { ok: false, deferred: true, warning: reason };
  }
  modelReport(row) {
    return { ok: !row.deferred && ['first', 'changed', 'same'].includes(row.modelsStatus),
      added: row.deferred || row.modelsStatus === 'unknown' ? 0 : row.modelAdded || 0,
      ...(row.deferred ? { deferred: true } : {}), warning: row.notice || '' };
  }
  async refreshModels(ai, row, owner, observation) {
    const blocked = this.modelBlocker(ai);
    if (blocked) return this.defer(row, blocked);
    const opts = this.scope(ai, row, owner);
    const client = await this.tools.modelClient(ai, opts);
    const changed = this.modelBlocker(ai);
    if (changed) return this.defer(row, changed);
    // 失敗や中断を同じ実体で毎分やり直さない。成功した一覧は別途保持する。
    this.data.modelClients[`${ai}:${row.account}`] = client;
    this.save();
    const result = observation ? this.observe(ai, row, observation) : await this.tools.refresh(ai, opts);
    if (!observation) this.modelResult(ai, row, result);
    return result;
  }
  async select(ai, fn, checking = false, account) {
    if (!this.tools.find(ai)) return fn({ eligible: false, status: 'not-installed' });
    if (!this.tools.dry) this.tools.ready(ai, this.tools.find(ai)); // before auth status or any CLI startup
    // Agy/Grokの認証確認自身がmodelsを実行するため、稼働中は認証も補完へ回す。
    const blocked = this.modelBlocker(ai);
    if (blocked && (['agy', 'grok'].includes(ai) || !this.tools.busy(ai))) {
      return fn({ eligible: false, status: 'unknown', ...(this.data.rows[ai] || {}), ...(account ? { account } : {}), deferred: true, authDeferred: true, reason: blocked });
    }
    let rows;
    try { rows = this.accounts.list().filter(r => r.ai === ai && (account === undefined || r.id === account)); }
    catch { return fn({ eligible: false, status: 'unknown' }); }
    let status = 'unknown';
    for (const r of rows) {
      let selected = false;
      try {
        const result = await this.accounts.readOnly(ai, r.id, async () => {
          const auth = await this.accounts.status(ai, r.id, { models: true });
          if (r.id === 'default') status = auth.status;
          if (ai === 'agy' && auth.modelsState === 'failed') {
            this.tools.modelFailure(ai, auth.message); selected = true;
            return { value: await fn({ eligible: false, status: auth.status, account: r.id, modelFailure: auth.message }) };
          }
          if (auth.status !== 'logged-in' && !auth.modelObservation) {
            return null;
          }
          selected = true;
          return { value: await fn({ eligible: auth.status === 'logged-in', status: auth.status, account: r.id }, auth.modelObservation) };
        });
        if (result) return result.value;
      } catch (e) {
        if (selected || e.stage === 'mac-confirmation') throw e;
        if (e.status === 409) return fn({ eligible: false, status: 'unknown', account: r.id, deferred: true, authDeferred: true, reason: lt('モデル一覧はログインなどのアカウント操作が終わってから確認します。') });
        /* このアカウントは対象外 */
      }
    }
    return fn({ eligible: false, status });
  }
  setTarget(ai, target) {
    const old = this.data.rows[ai] || {};
    const row = this.data.rows[ai] = { ...old, ...target,
      ...(old.account !== target.account ? { check: null, modelsStatus: 'unknown', modelDiff: null, modelCheckedAt: '' } : {}),
      deferred: Boolean(target.deferred), authDeferred: Boolean(target.authDeferred), notice: '' };
    if (!target.eligible) row.modelsStatus = 'unknown';
    return row;
  }
  observe(ai, row, observation) {
    const result = { ...this.tools.saveCatalog(ai, observation, row.account), observedModels: observation.models };
    this.modelResult(ai, row, result);
    return result;
  }
  scope(ai, row, owner) {
    return { owner, account: row.account, env: this.accounts.env(ai, row.account), cacheDir: this.accounts.location(ai, row.account), fileAuth: ai === 'codex' && row.account !== 'default' };
  }
  modelResult(ai, row, result) {
    row.deferred = false;
    if (!result?.ok || result.unchanged || result.dry) {
      row.modelsStatus = 'unknown';
      row.notice = lt('モデル一覧を新しく確認できませんでした。前回の候補を保持しています。');
      return;
    }
    const models = normalized(result.observedModels || result.models);
    const key = `${ai}:${row.account}`;
    const diff = compare(this.data.baselines[key], models);
    row.modelAdded = result.added || 0;
    row.modelsStatus = diff.state; row.modelDiff = diff;
    row.modelCheckedAt = this.now().toISOString();
    this.data.baselines[key] = models;
    if (result.unavailable) row.notice = result.warning;
    if (result.saved !== false) this.onCatalog();
  }
  async runRow(ai, owner, apply, account) {
    this.data.clients[ai] = { identity: this.tools.clientIdentity(ai), version: this.tools.clientVersions[ai]?.version || '' };
    this.save();
    try { return await this.select(ai, async (target, observation) => {
      const row = this.setTarget(ai, target);
      if (row.authDeferred) {
        row.check = null; this.defer(row, target.reason);
        this.save(); return { ai, state: 'deferred' };
      }
      let outcome = row.eligible ? 'checked' : 'excluded';
      row.modelsStatus = 'unknown';
      try {
        // 実際の一覧と認証状態を別々に保持する。
        if (observation) await this.refreshModels(ai, row, owner, observation);
        if (!row.eligible) { row.check = null; this.save(); return { ai, state: 'excluded', modelsStatus: row.modelsStatus }; }
        const opts = this.scope(ai, row, owner);
        try {
          row.check = await this.tools.checkUpdate(ai, opts); row.version = row.check.currentVersion;
          this.data.clients[ai] = { identity: this.tools.clientIdentity(ai), version: row.version };
        }
        catch (e) { row.check = { ok: false, available: null, failedAt: this.now().toISOString() }; throw e; }
        row.method = this.tools.methods[ai] || require('./ai-tools').methodFor(ai, this.tools.find(ai));
        this.save();
        if (apply && row.check.available === true && row.check.applicable) {
          // 読取ロックを保ち、適用の直前には新しい認証応答を確認する。
          const auth = await this.accounts.status(ai, row.account, { models: true });
          if (auth.modelObservation) await this.refreshModels(ai, row, owner, auth.modelObservation);
          if (auth.status !== 'logged-in') {
            row.eligible = false; row.status = auth.status; row.check = null;
            throw toolError(409, 'auth', lt('契約ログインを確認できないため対象外です。'));
          }
          const result = await this.tools.update(ai, opts);
          row.version = result.afterVersion || row.version;
          row.check = result.verified ? { ...row.check, currentVersion: result.afterVersion, available: require('./update-check').newer(row.check.latestVersion, result.afterVersion) } : { ok: false, available: null, failedAt: this.now().toISOString() };
          this.modelResult(ai, row, result.models);
          this.data.clients[ai] = await this.tools.modelClient(ai, opts);
          this.data.modelClients[`${ai}:${row.account}`] = this.data.clients[ai];
          outcome = result.verified ? 'updated' : 'unverified';
          if (!result.verified) row.notice = lt('更新操作は終わりましたが、版を確認できませんでした。');
        } else if (this.modelBlocker(ai)) {
          this.defer(row, this.modelBlocker(ai));
        } else {
          if (!observation) await this.refreshModels(ai, row, owner);
          if (apply && row.check.available === true && !row.check.applicable) { outcome = 'unsupported'; row.notice = lt('この導入方法では、Hubから更新できません。導入時の方法で更新してください。'); }
        }
      } catch (e) {
        if (e.stage === 'save') throw e;
        outcome = e.stage === 'mac-confirmation' ? 'mac-confirmation' : 'failed'; row.modelsStatus = 'unknown';
        row.notice = e.stage === 'mac-confirmation' ? e.reason : e.stage === 'auth' ? lt('契約ログインを確認できないため対象外です。') : e.stage === 'check' ? lt('更新情報を確認できませんでした。配布元への接続とCLIの版を確認してください') : lt('CLI の操作に失敗しました。状態を確認してください。');
      }
      this.save();
      return { ai, state: outcome, modelsStatus: row.modelsStatus, ...(outcome === 'mac-confirmation' ? { notice: row.notice } : {}) };
    }, false, account); } catch (e) {
      if (e.stage !== 'mac-confirmation') throw e;
      const row = this.data.rows[ai] = { ...this.data.rows[ai], modelsStatus: 'unknown', notice: e.reason };
      this.save();
      return { ai, state: 'mac-confirmation', notice: row.notice, modelsStatus: 'unknown' };
    }
  }
  async run(kind, fn, ai) {
    this.assertStorage();
    const owner = this.tools.acquire(kind, ai); // awaitより前に一括全体を排他
    try { return await fn(owner); }
    finally { this.tools.release(owner); }
  }
  async updateAll() {
    this.assertStorage();
    if (this.batch || this.tools.isOperating()) throw toolError(409, 'busy', lt('別の更新・モデル再取得が進行中です'));
    this.batch = true;
    try {
      const results = [];
      for (const ai of AIS) {
        if (this.tools.busy(ai)) { results.push({ ai, state: 'busy' }); continue; }
        results.push(await this.run('update', owner => this.runRow(ai, owner, true), ai));
      }
      return { ok: true, results };
    } finally { this.batch = false; }
  }
  // 古いAPIにも同じ対象制限と新鮮確認を適用する。
  single(ai, action, account) {
    if (!AIS.includes(ai)) return Promise.reject(toolError(400, 'input', lt('AI の指定が正しくありません')));
    if (account !== undefined) {
      if (ai !== 'codex' || !['models', 'check'].includes(action) || typeof account !== 'string') return Promise.reject(toolError(400, 'input', lt('アカウントの指定が正しくありません')));
      try { this.accounts.get(ai, account); } catch (e) { return Promise.reject(e); }
    }
    if (this.batch) return Promise.reject(toolError(409, 'busy', lt('別の更新・モデル再取得が進行中です')));
    if (this.tools.busy(ai) && action !== 'check') return Promise.reject(toolError(409, 'busy', lt('AIの作業が終わるまで更新できません。')));
    return this.run(action === 'check' ? 'check-models' : action, async owner => {
      if (action === 'update') {
        const result = await this.runRow(ai, owner, true);
        if (result.state === 'excluded') throw toolError(409, 'auth', lt('契約ログインを確認できないため対象外です。'));
        return result;
      }
      if (action === 'check') {
        const result = await this.runRow(ai, owner, false, account);
        const row = this.data.rows[ai];
        if (result.state === 'excluded') throw toolError(409, 'auth', lt('契約ログインを確認できないため対象外です。'));
        if (result.state === 'mac-confirmation') throw toolError(409, 'mac-confirmation', row.notice);
        if (!row.check?.ok && !row.deferred) throw toolError(502, 'check', row.notice);
        const response = { ...(row.check || { ok: true, ai }), models: this.modelReport(row) };
        if (ai === 'codex' && account === undefined && !row.deferred) {
          response.models.accounts = await this.refreshKnownCodex(owner, row.account, true);
        }
        return response;
      }
      return this.select(ai, async (target, observation) => {
        const row = this.setTarget(ai, target);
        if (row.authDeferred) { this.defer(row, target.reason); this.save(); return this.modelReport(row); }
        const observed = observation ? await this.refreshModels(ai, row, owner, observation) : null;
        if (!row.eligible) {
          row.check = null; this.save();
          if (action === 'models' && observation?.empty) return observed;
          if (target.modelFailure) throw toolError(502, 'models', target.modelFailure);
          throw toolError(409, 'auth', lt('契約ログインを確認できないため対象外です。'));
        }
        try {
          const result = observed || await this.refreshModels(ai, row, owner);
          this.save(); return result;
        } catch (e) {
          if (e.stage === 'save') throw e;
          row.modelsStatus = 'unknown'; row.notice = lt('モデル一覧を新しく確認できませんでした。前回の候補を保持しています。'); this.save(); throw e;
        }
      }, action === 'check', account);
    }, ai);
  }

  async refreshKnownCodex(owner, except, force = false) {
    const identity = this.tools.clientIdentity('codex'), version = this.tools.clientVersions.codex?.version, reports = [];
    for (const [account, catalog] of Object.entries(this.tools.codexCatalogs())) {
      const previous = this.data.modelClients[`codex:${account}`];
      if (account === except || !catalog.models.length || !force && previous?.identity === identity && !previous.deferred && !(previous.version && version && previous.version !== version)) continue;
      if (this.modelBlocker('codex')) break;
      // ログアウト済み・失敗したアカウントも同じ実体では自動再試行しない。
      this.data.modelClients[`codex:${account}`] = { identity, version: this.tools.clientVersions.codex?.version || '' };
      this.save();
      // 補助アカウントの取得で、設定画面の確認結果・対象アカウントを置き換えない。
      const primary = this.data.rows.codex;
      try {
        await this.refreshOnly('codex', owner, account);
        const row = this.data.rows.codex;
        this.data.modelClients[`codex:${account}`].deferred = Boolean(row.deferred);
        reports.push({ account, ...this.modelReport(row) });
      }
      finally { this.data.rows.codex = primary; this.save(); }
    }
    return reports;
  }
  async refreshOnly(ai, owner, account) {
    try {
      await this.select(ai, async (target, observation) => {
        const row = this.setTarget(ai, target);
        if (row.authDeferred) this.defer(row, target.reason);
        else if (row.eligible || observation) await this.refreshModels(ai, row, owner, observation);
      }, false, account);
    } catch (e) {
      if (e.stage === 'save') throw e;
      const row = this.data.rows[ai] ||= {};
      row.modelsStatus = 'unknown'; row.notice = e.stage === 'mac-confirmation' ? e.reason : lt('モデル一覧を新しく確認できませんでした。前回の候補を保持しています。');
    }
    this.save();
  }

  tick() {
    if (this.pending) return this.pending;
    if (this.tools.canOperate?.() || this.error || this.batch || this.tools.isOperating() || this.tools.checking.size) return Promise.resolve();
    const day = dayOf(this.now());
    const deferred = AIS.filter(ai => this.data.rows[ai]?.deferred && !this.modelBlocker(ai));
    const changed = AIS.filter(ai => {
      const identity = this.tools.clientIdentity(ai), previous = this.data.clients[ai];
      const version = this.tools.clientVersions[ai];
      return identity && (identity !== previous?.identity || version?.identity === identity && previous?.version && version.version !== previous.version);
    });
    const codexStale = this.tools.find('codex') && !this.modelBlocker('codex') && Object.entries(this.tools.codexCatalogs()).some(([id, c]) => {
      const client = this.data.modelClients[`codex:${id}`], version = this.tools.clientVersions.codex?.version;
      return c.models.length && (client?.identity !== this.tools.clientIdentity('codex') || client?.deferred || client?.version && version && client.version !== version);
    });
    if (this.data.day === day && !deferred.length && !changed.length && !codexStale) return Promise.resolve();
    this.pending = (async () => {
      if (this.data.day !== day) {
        this.data.day = day; this.save(); // 失敗/中断後も同日には再試行しない
        for (const ai of AIS) await this.run('daily', owner => this.runRow(ai, owner, false), ai);
      } else {
        for (const ai of changed) await this.run('client-change', owner => this.runRow(ai, owner, false), ai);
        for (const ai of deferred) {
          if (changed.includes(ai)) continue;
          const row = this.data.rows[ai]; row.deferred = false; this.save();
          try {
            if (row.authDeferred) await this.run('daily', owner => this.runRow(ai, owner, false, ai === 'codex' ? row.account : undefined), ai);
            else await this.run('daily', owner => this.refreshOnly(ai, owner, ai === 'codex' ? row.account : undefined), ai);
          }
          catch (e) { if (e.stage === 'save') throw e; row.modelsStatus = 'unknown'; row.notice = lt('モデル一覧を新しく確認できませんでした。前回の候補を保持しています。'); }
          this.save();
        }
      }
      if (!this.modelBlocker('codex') && this.tools.find('codex')) await this.run('client-change', owner => this.refreshKnownCodex(owner), 'codex');
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  start() { if (this.timer) return; void this.tick().catch(() => {}); this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 60000); this.timer.unref(); }
  stop() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { AiUpdates, compare, dayOf };
