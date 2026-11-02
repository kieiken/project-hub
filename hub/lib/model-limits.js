'use strict';
// 契約CLIの確定上限と新鮮な100%だけを保存。表示の丸め値は使わない。
const fs = require('./platform/file-io');
const path = require('node:path');
const launch = require('./launch');
const {lt}=require('./locale');
const credit = require('./credit-exception');
const MODELS = Object.freeze({ claude: ['claude-fable-5-1', 'claude-opus-5-5'], codex: ['gpt-6-astra', 'gpt-6.1-sol'] });
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const MAX_AGE = 5 * 60 * 1000;
function relevant(ai, model, w) {
  if (ai === 'claude') return w.id === 'model:' + model || ['five_hour', 'seven_day'].includes(w.id) ||
    model === 'claude-opus-5-5' && (w.id === 'seven_day_opus' || /^model:/.test(w.id) && /^Opus(?:\s|・|$)/i.test(w.label)) ||
    model === 'claude-fable-5-1' && /^model:/.test(w.id) && /^Fable(?:\s|・|$)/i.test(w.label);
  const bucket = String(w.id || '').replace(/:(primary|secondary)$/, '');
  return bucket === 'codex' || bucket === model;
}
class ModelLimits {
  constructor(file, { now = Date.now, models = () => MODELS, creditPolicy = () => ({}), creditState = () => null, onCreditDecision = null } = {}) {
    this.file = file; this.now = now; this.models = models; this.creditPolicy = creditPolicy; this.creditState = creditState; this.onCreditDecision = onCreditDecision; this.data = {};
    this.reload();
  }
  reload() {
    try {
      const st = fs.statSync(this.file), signature = `${st.mtimeMs}:${st.size}`;
      if (signature === this.signature) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      this.data = data; this.signature = signature;
    } catch (e) { if (e.code === 'ENOENT') { this.data = {}; this.signature = null; } /* 破損は直前の保持を残す */ }
  }
  key(model, account = 'default') { return model + (account === 'default' ? '' : ':' + account); }
  save(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 破損したファイルは消さずに保存失敗として通知する。
    try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('invalid limits file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const tmp = this.file + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(tmp, this.file); this.data = next;
  }
  active(account = 'default', model = 'claude-fable-5-1', contractOnly = false) {
    this.reload();
    const shared = contractOnly ? this.active(account, model) : null;
    const e = (contractOnly ? this.data._discussion : this.data)?.[this.key(model, account)];
    if (!e || !['cli-limit', 'usage-100'].includes(e.source) || !Number.isFinite(stamp(e.at)) ||
        !(e.validUntil === null || Number.isFinite(stamp(e.validUntil))) ||
        !(e.checkedAt === null || Number.isFinite(stamp(e.checkedAt)))) return shared;
    const v2 = e.version === 2 && e.hold === true && stamp(e.lastLimitAt) >= stamp(e.at) &&
      ['project', 'task', 'request'].every(key => typeof e[key] === 'string') &&
      (e.untilSource === 'unknown' ? e.validUntil === null : e.untilSource === 'usage' && stamp(e.validUntil) > stamp(e.at) && stamp(e.checkedAt) >= stamp(e.at));
    const v1 = e.version === undefined && e.source === 'cli-limit' && stamp(e.validUntil) > this.now() && stamp(e.checkedAt) > stamp(e.at);
    if (!v2 && !v1) return shared;
    if (e.validUntil !== null && stamp(e.validUntil) <= this.now()) return shared;
    return { ...e, version: 2, lastLimitAt: e.lastLimitAt || e.at, untilSource: e.untilSource || 'usage', project: e.project || '', task: e.task || '', request: e.request || '', model, account, hold: true };
  }
  creditDecision(o, held = this.active(o.account || 'default', launch.flagFor(o.ai, o.model))) {
    const policy = this.creditPolicy(), account = o.account || 'default', now = this.now();
    const proof = this.creditState(o.ai, account);
    const attempted = stamp(proof?.attemptedAt), checked = stamp(proof?.checkedAt);
    let reason;
    if (o.ai !== 'codex') reason = 'unsupported-provider';
    else if (policy.preferCredits !== true) reason = 'priority-off';
    else if (policy.checkCredits?.[o.ai] !== true) reason = 'check-off';
    else if (held?.source !== 'usage-100') reason = held?.source === 'cli-limit' ? 'cli-limit' : 'no-usage-hold';
    else if (!proof) reason = 'no-proof';
    else if (proof.ai !== o.ai || proof?.account !== account) reason = 'account-changed';
    else if (proof.availability !== 'available') reason = proof.availability === 'empty' ? 'empty' :
      ['checking','no-proof','not-checked','unavailable','invalid-time','slow-read','not-fresh','account-changed'].includes(proof.reason) ? proof.reason : 'unknown';
    else if (proof.prepaid !== true) reason = 'not-prepaid';
    else if (!(attempted <= checked && checked <= now)) reason = 'invalid-time';
    else if (now - attempted >= 30000) reason = 'not-fresh';
    else if (checked < stamp(held.lastLimitAt)) reason = 'before-limit';
    else reason = 'available';
    return { allowed: reason === 'available', reason, availability: ['available','empty'].includes(proof?.availability) ? proof.availability : 'unknown',
      attemptedAt: Number.isFinite(attempted) ? proof.attemptedAt : null, checkedAt: Number.isFinite(checked) ? proof.checkedAt : null,
      evaluatedAt: new Date(now).toISOString() };
  }
  creditPriority(o, held = this.active(o.account || 'default', launch.flagFor(o.ai, o.model))) {
    return this.creditDecision(o, held).allowed;
  }
  forRequest(o) {
    const held = this.active(o.account || 'default', launch.flagFor(o.ai, o.model));
    if (!held) return null;
    const decision = this.creditDecision(o, held);
    // Only typed decision fields: no balances, CLI output, credentials or prompts.
    try { this.onCreditDecision?.(o, { ...decision, model: held.model, account: held.account, limitSource: held.source }); } catch { /* logging cannot authorize a start */ }
    return decision.allowed ? null : held;
  }
  creditException() { this.reload(); return credit.valid(this.data._creditException) ? { ...this.data._creditException } : null; }
  startCreditException(input, snapshot) {
    this.reload();
    if(input?.ai!=='codex'||input.account!=='default'||input.confirm!==true)throw Error(lt('Codexの既定アカウントだけを確認して指定してください'));
    if(input.model!==undefined||input.models!==undefined)throw Error(lt('例外のモデルは既定のSolとAstraに固定されています'));
    const old=this.creditException();
    if(old?.state==='active')return old;
    if(this.data._creditException)throw Error(lt('今回限りの例外は終了済みです。再作成しません'));
    const p=credit.providers(snapshot).find(p=>p.ai==='codex'&&(p.account||'default')==='default'),balance=credit.amount(p?.credits?.balance);
    if(!credit.fresh(p,this.now(),MAX_AGE)||p.credits?.unlimited!==false||p.credits?.hasCredits===false||p.credits?.balance!==input.expectedBalance||balance===null||balance<=0n||balance>credit.CAP)throw Error(lt('新しい残高と確認した残高が一致しません（最大62,500）'));
    const at=new Date(this.now()).toISOString(),e={version:1,ai:'codex',account:'default',models:[...MODELS.codex],grantedAt:at,grantedBy:'human',reason:'今回限り既存クレジット',startBalance:p.credits.balance,lastBalance:p.credits.balance,lastCheckedAt:p.fetchedAt,consumed:credit.decimal(0n),state:'active'};
    const next={...this.data,_creditException:e};
    for(const model of MODELS.codex){const key=this.key(model);if(next[key]?.source==='usage-100')delete next[key];}
    this.save(next);return e;
  }
  endCreditException(input, snapshot) {
    if(input?.ai!=='codex'||input.account!=='default'||input.confirm!==true)throw Error(lt('Codexの既定アカウントだけを確認して指定してください'));
    const e=this.creditException();if(!e||e.state==='ended')return e;
    this.save({...this.data,_creditException:credit.finish(e,'manual',this.now())});
    this.observe(snapshot);return this.creditException();
  }
  record(o, models = this.models(), contractOnly = false) {
    this.reload();
    const model = launch.flagFor(o.ai, o.model), account = o.account || 'default';
    if (!['claude', 'codex'].includes(o.ai) || !model) return;
    const shared = o.ai === 'codex' && o.limitError || o.ai === 'claude' && /your (?:session|5[- ](?:hour|hr)|five[- ]hour) limit/i.test(o.limitError || '');
    const targets = shared ? [...new Set([model, ...(models[o.ai] || [])])] : [model];
    const at = new Date(this.now()).toISOString(), next = { ...(contractOnly ? this.data._discussion : this.data) };
    if(!contractOnly&&o.ai==='codex'&&account==='default'&&o.limitError&&this.creditException()?.state==='active')next._creditException=credit.finish(this.data._creditException,'cli-limit',this.now());
    for (const target of targets) {
      const key = this.key(target, account), old = this.active(account, target, contractOnly);
      next[key] = old ? { ...old, source:'cli-limit', lastLimitAt: at } : { version: 2, source: 'cli-limit', hold: true, at, lastLimitAt: at,
        model: target, ai: o.ai, account, project: String(o.project || ''), task: String(o.task || ''), request: String(o.request || o.started || ''),
        validUntil: null, untilSource: 'unknown', checkedAt: null };
    }
    this.save(contractOnly ? { ...this.data, _discussion: next } : next);
  }
  clear(account = 'default', model = 'claude-fable-5-1', models = this.models()) {
    this.reload();
    if (!Object.values(models).flat().includes(model)) throw Error('unknown limit model');
    const key = this.key(model, account), next = { ...this.data, _cleared: { ...this.data._cleared, [key]: new Date(this.now()).toISOString() } };
    delete next[key];
    if (next._discussion) { next._discussion = { ...next._discussion }; delete next._discussion[key]; }
    this.save(next);
  }
  clearAccount(ai, account = 'default') {
    this.reload();
    const models = this.models()[ai]; if (!models) throw Error('unknown limit provider');
    const next = { ...this.data, _cleared:{ ...this.data._cleared } }, at = new Date(this.now()).toISOString();
    for (const model of models) { const key = this.key(model, account); delete next[key]; next._cleared[key] = at; }
    if (next._discussion) { next._discussion = { ...next._discussion }; for (const model of models) delete next._discussion[this.key(model, account)]; }
    this.save(next);
  }
  observe(snapshot, models = this.models(), contractOnly = false) {
    this.reload();
    const providers = credit.providers(snapshot);
    // Contract-only evidence has its own durable holds. It must not add normal
    // holds or finish/suppress an approved credit exception for normal work.
    let next = { ...(contractOnly ? this.data._discussion : this.data) }, changed = false;
    for (const p of providers) {
      const attempted = stamp(p.attemptedAt), checked = stamp(p.fetchedAt), now = this.now();
      if (!MODELS[p.ai] || p.status !== 'ok' || !(attempted <= checked) ||
          checked > now + 5000 || now - attempted > MAX_AGE) continue;
      const exception=contractOnly ? {} : credit.observe(next._creditException,p,now,MAX_AGE);
      if(!contractOnly&&exception.exception!==next._creditException){next._creditException=exception.exception;changed=true;}
      if(!Array.isArray(p.windows))continue;
      for (const model of models[p.ai] || []) {
        const account = p.account || 'default', key = this.key(model, account), old = this.active(account, model, contractOnly);
        if(exception.preserve&&MODELS.codex.includes(model))continue;
        if(exception.suppress&&MODELS.codex.includes(model)){
          if(old?.source==='usage-100'){delete next[key];changed=true;}
          continue;
        }
        if (attempted <= stamp(this.data._cleared?.[key]) || old && (attempted < stamp(old.lastLimitAt || old.at) || checked <= stamp(old.checkedAt))) continue;
        const full = p.windows.filter(w => relevant(p.ai, model, w) && Number.isFinite(w.usedPercent) && w.usedPercent >= 100 &&
          (w.resetsAt === null || stamp(w.resetsAt) > now));
        if (!full.length) continue; // 99%、取得失敗、成功しただけでは保持を解除しない。
        const unknown = full.some(w => w.resetsAt === null), reset = Math.max(...full.map(w => stamp(w.resetsAt) || 0), stamp(old?.validUntil) || 0);
        const at = old?.at || p.fetchedAt;
        next[key] = { ...(old || { version: 2, source: 'usage-100', project: '', task: '', request: '' }), model, ai: p.ai, account,
          hold: true, at, lastLimitAt: old?.lastLimitAt || at, checkedAt: p.fetchedAt,
          windows: full.map(w => w.id), validUntil: unknown ? null : new Date(reset).toISOString(), untilSource: unknown ? 'unknown' : 'usage' };
        changed = true;
      }
    }
    if (changed) this.save(contractOnly ? { ...this.data, _discussion: next } : next);
  }
  list(selection = {}) {
    return Object.entries(this.models()).flatMap(([ai, models]) => models.map(model => this.active(selection[ai] || 'default', model)).filter(Boolean).map(e => ({ ...e, ai, until: e.validUntil, creditPriority: this.creditPriority({ ai, model: e.model, account: e.account }, e) })));
  }
  success() {}
  needsRefresh() { return false; }
}
module.exports = { ModelLimits, MODELS, relevant, MAX_AGE };
