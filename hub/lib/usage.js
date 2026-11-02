'use strict';
const { lt } = require('./locale');
// 契約CLIの状態を読み、確認済みの無料チケットだけ使用する。user prompt / thread / turn は送らず、秘密・生出力は公開しない。
const { spawn } = require('node:child_process');
const os = require('node:os');
const { executable } = require('./ai-tools');
const { ResetTickets, checkTicket, validId, outcomes } = require('./reset-tickets');
const { relevant } = require('./model-limits');

const TTL = 5 * 60 * 1000;
const COOLDOWN = 30 * 1000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const error = code => Object.assign(new Error(code), { usageCode: code });
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
function resetTime(value) {
  const ms = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : typeof value === 'string' && value ? Date.parse(value) : NaN;
  // 秒/ミリ秒の取り違えや不正な遠未来は未提供にする。利用枠のリセットは2100年より前。
  return Number.isFinite(ms) && ms > 0 && ms < 4102444800000 ? new Date(ms).toISOString() : null;
}
function windowLabel(mins) {
  if (mins === 10080) return lt('週間枠');
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return lt('利用枠');
  if (mins % 1440 === 0) return lt`${mins / 1440}日枠`;
  if (mins % 60 === 0) return lt`${mins / 60}時間枠`;
  return lt`${mins}分枠`;
}
const label = (v, fallback) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback;
function providerPlan(ai, data) {
  const plans = ai === 'codex'
    ? { free:'Free', plus:'Plus', pro:'Pro', team:'Team', business:'Business', enterprise:'Enterprise', edu:'Edu', go:'Go' }
    : { free:'Free', pro:'Pro', max:'Max', team:'Team', enterprise:'Enterprise' };
  const value = ai === 'codex' ? data?.rateLimits?.planType ?? data?.accountPlanType : data?.subscription_type;
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(plans, key) ? plans[key] : null;
}
// 表示用の許可項目だけを返す。チケットID・説明・アカウント情報は公開しない。
function codexExtras(data) {
  const result = {}, reset = data.rateLimits?.rateLimitResetCredits ?? data.rateLimitResetCredits;
  if (Array.isArray(reset?.credits) || reset?.credits === null) {
    if (reset.credits === null) {
      if (Number.isSafeInteger(reset.availableCount) && reset.availableCount > 0) result.resetCredits = { count: Math.min(reset.availableCount, 1000), items: [] };
    } else {
      const available = reset.credits.slice(0, 1000).filter(item => item?.status === 'available');
      const count = Number.isSafeInteger(reset.availableCount) && reset.availableCount >= 0 ? reset.availableCount : available.length;
      if (count > 0 && available.length) result.resetCredits = {
        count: Math.min(count, 1000),
        items: available.slice(0, 20).map(item => ({ title: label(item.title, lt('リセット')), expiresAt: resetTime(item.expiresAt) })),
      };
    }
  }
  const credits = data.rateLimits?.credits ?? data.credits;
  if(credits?.hasCredits===false)result.credits={hasCredits:false};
  if (credits?.hasCredits === true) {
    const balance = typeof credits.balance === 'string' && credits.balance.length <= 80 && credits.balance.trim() === credits.balance && /^\d+(?:\.\d+)?$/.test(credits.balance) ? credits.balance : null;
    if (credits.unlimited === true || balance !== null) result.credits = { ...(balance !== null ? { balance } : {}), unlimited: credits.unlimited === true };
  }
  return result;
}
function row(id, name, pct, reset) {
  return { id, label: name, usedPercent: percent(pct), resetsAt: resetTime(reset) };
}
function codexWindows(data) {
  if (!data || typeof data !== 'object') throw error('format');
  const byId = data.rateLimitsByLimitId;
  const buckets = byId && typeof byId === 'object' && !Array.isArray(byId) && Object.keys(byId).length ? Object.entries(byId) : data.rateLimits ? [[data.rateLimits.limitId || 'codex', data.rateLimits]] : [];
  const windows = [];
  for (const [id, bucket] of buckets.slice(0, 20)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const key of ['primary', 'secondary']) {
      const w = bucket[key]; if (!w || typeof w !== 'object') continue;
      const name = windowLabel(w.windowDurationMins);
      windows.push(row(`${id}:${key}`, id === 'codex' ? name : lt`${label(bucket.limitName, String(id))}・${name}`, w.usedPercent, w.resetsAt));
    }
  }
  return windows;
}
function claudeWindows(data) {
  if (!data || typeof data !== 'object') throw error('format');
  if (!data.subscription_type || data.rate_limits_available === false) throw error('subscription');
  const limits = data.rate_limits;
  if (!limits || typeof limits !== 'object') throw error('unavailable');
  const windows = [];
  for (const [key, name] of [['five_hour',lt('5時間枠')], ['seven_day',lt('週間枠')], ['seven_day_oauth_apps',lt('週間枠（OAuthアプリ）')], ['seven_day_opus',lt('Opus・週間枠')], ['seven_day_sonnet',lt('Sonnet・週間枠')]]) {
    const w = limits[key]; if (w && typeof w === 'object') windows.push(row(key, name, w.utilization, w.resets_at));
  }
  if (Array.isArray(limits.model_scoped)) for (const [i, w] of limits.model_scoped.slice(0,20).entries()) {
    if (w && typeof w === 'object') windows.push(row(`model:${i}`, lt`${label(w.display_name,lt('モデル別'))}・週間枠`, w.utilization, w.resets_at));
  }
  return windows;
}

// 確認ONの要求だけで使う。Claudeの月間追加利用枠は実残高ではない。
function creditStatus(ai, data) {
  if (ai === 'codex') {
    const credits = codexExtras(data).credits;
    if (credits?.hasCredits === false) return { availability: 'empty' };
    if (credits?.unlimited === true) return { availability: 'available', prepaid: false };
    if (credits?.balance !== undefined) return { availability: /[1-9]/.test(credits.balance) ? 'available' : 'empty', prepaid: /[1-9]/.test(credits.balance) };
    return { availability: 'unknown', reason: 'not-provided' };
  }
  const extra = data.rate_limits?.extra_usage ?? data.extra_usage;
  if (extra?.disabled_reason === 'out_of_credits') return { availability: 'empty', reason: 'out-of-credits' };
  return { availability: 'unknown', reason: 'balance-not-provided',
    ...(typeof extra?.is_enabled === 'boolean' ? { extraUsageEnabled: extra.is_enabled } : {}),
    ...(percent(extra?.utilization) !== null ? { monthlyLimitReached: extra.utilization >= 100 } : {}) };
}

// stdoutは上限付きJSONL。固定の状態要求と、確認済みチケットの使用だけ。ツール・認証要求には応答しない。
function readCli(ai, file, options = {}) {
  const consume = options.consume;
  if (consume && (ai !== 'codex' || !validId(consume.idempotencyKey) || !validId(consume.accountId) || consume.creditId !== undefined && !validId(consume.creditId))) return Promise.reject(error('format'));
  const start = options.spawn || spawn;
  const timeoutMs = options.timeoutMs || 20000;
  const args = ai === 'claude' ? ['--print', '--input-format','stream-json','--output-format','stream-json','--verbose',
    '--safe-mode','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources','','--settings','{"disableAllHooks":true}','--disable-slash-commands','--tools','','--model','claude-fable-5-1'] :
    ['app-server','--listen','stdio://','-c','analytics.enabled=false', ...require('./launch').accountArgs(ai, options.account || 'default')];
  return new Promise((resolve, reject) => {
    let child;
    try { const x = require('./launch').exeArgv(file, args); child = start(x.file, x.args, { stdio:['pipe','pipe','pipe'], cwd: os.tmpdir(), env: require('./launch').accountEnv(ai, options.account || 'default', options.env || process.env) }); }
    catch { reject(error('start')); return; }
    let bytes = 0, buf = '', stopped = false, settled = false, value, failure, killTimer, consumeSent = false;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      if (failure) { failure.consumeSent = consumeSent; reject(failure); } else if (value) resolve(value); else { const e = error('response'); e.consumeSent = consumeSent; reject(e); }
    };
    const stop = (err, result) => {
      if (stopped) return;
      stopped = true; failure = err; value = result;
      try { child.stdin.end(); } catch { /* 閉じている */ }
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop(error('timeout')), timeoutMs);
    const send = msg => { if (!stopped) child.stdin.write(JSON.stringify(msg) + '\n'); };
    let stage = 'init', accountPlanType;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return stop(error('format'));
      buf += chunk;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (stopped) break;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (ai === 'claude') {
          const r = m.type === 'control_response' && m.response;
          if (!r || r.request_id !== `hub-${stage}`) continue;
          if (r.subtype !== 'success') { stop(error('unsupported')); continue; }
          if (stage === 'init') {
            stage = 'usage';
            send({ type:'control_request', request_id:'hub-usage', request:{ subtype:'get_usage', skip_behaviors:true } });
          } else stop(null, r.response);
        } else {
          const id = { init:0, account:1, usage:2, consume:3 }[stage];
          if (m.id !== id) continue;
          if (m.error) { stop(error('response')); continue; }
          if (stage === 'init') {
            send({ method:'initialized', params:{} }); stage = 'account';
            send({ id:1, method:'account/read', params:{ refreshToken:false } });
          } else if (stage === 'account') {
            if (m.result?.account?.type !== 'chatgpt') { stop(error('subscription')); continue; }
            accountPlanType = m.result.account.planType;
            stage = 'usage'; send({ id:2, method:'account/rateLimits/read' });
          } else if (stage === 'usage' && consume) {
            try {
              checkTicket(m.result, consume, options.now?.() ?? Date.now());
              consume.beforeSend(); // 保存と認証世代確認に失敗したら使用要求は送らない。
              stage = 'consume'; consumeSent = true;
              send({ id:3, method:'account/rateLimitResetCredit/consume', params:{ idempotencyKey:consume.idempotencyKey, ...(consume.creditId ? { creditId:consume.creditId } : {}) } });
            } catch (e) { stop(error(e.usageCode || 'journal')); }
          } else if (stage === 'consume') {
            if (!outcomes.has(m.result?.outcome)) stop(error('response'));
            else stop(null, { outcome:m.result.outcome });
          } else stop(null, m.result && { ...m.result, accountPlanType });
        }
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { if (!stopped) stop(error('response')); });
    child.on('error', () => { failure = error('start'); finish(); });
    child.on('close', finish);
    if (ai === 'claude') send({ type:'control_request', request_id:'hub-init', request:{ subtype:'initialize' } });
    else send({ id:0, method:'initialize', params:{ clientInfo:{name:'project_hub_usage',version:'1.0.0'} } });
  });
}
const messages = {
  missing:lt('CLIが見つかりません'), start:lt('CLIを起動できませんでした'), timeout:lt('CLIの応答が時間切れになりました'),
  subscription:lt('契約アカウントの利用枠を取得できません'), unavailable:lt('利用枠の情報が提供されていません'),
  format:lt('CLIの利用情報を読み取れませんでした'), unsupported:lt('このCLIでは利用情報を取得できません'),
  response:lt('CLIから利用情報を取得できませんでした'), dry:lt('テスト中のため取得していません'),
  'account-changed':lt('アカウントが変わりました。利用状況を再確認してください'),
  'ticket-changed':lt('このチケットは現在使えません。利用状況を再確認してください'),
  uncertain:lt('使用結果が不明です。利用状況を再確認してください'),
  journal:lt('使用の記録を保存できませんでした。再確認してください'),
  busy:lt('このアカウントの利用状況を確認中またはチケットを使用中です'),
};
class Usage {
  constructor(options = {}) {
    this.find = options.find || executable;
    this.read = options.read || readCli;
    this.now = options.now || Date.now;
    this.dry = Boolean(options.dry);
    this.observe = options.observe || null;
    this.beforeRead = options.beforeRead || null;
    this.accounts = options.accounts || null;
    this.tickets = new ResetTickets({ file:options.resetFile, now:this.now });
    this.consume = options.consume || ((file, options) => readCli('codex', file, options));
    this.onReset = options.onReset || (() => {});
    this.resetBusy = new Set();
    this.visible = new Map(); this.authCache = new Map(); this.authInflight = new Map(); this.revisions = new Map(); this.authBusy = new Map();
    this.cache = {}; this.inflight = new Map(); this.lastAttempt = new Map(); this.creditRequested = new Set(); this.creditInflight = new Map(); this.attemptSerial = new Map();
    this.subscriptionWindows = new Map();
  }
  key(ai, account = 'default') { return account === 'default' ? ai : ai + ':' + account; }
  revision(key) { return this.revisions.get(key) || 0; }
  async loginStatus(ai, account) {
    const key = this.key(ai, account), revision = this.revision(key), cached = this.authCache.get(key);
    if (cached && this.now() - cached.checkedAt < TTL) return cached.status;
    if (this.authInflight.has(key)) return this.authInflight.get(key);
    const attempt = (async () => {
      let status = 'unknown';
      try { status = (await this.accounts.status(ai, account)).status; } catch { /* 一時失敗は未取得のカードで示す */ }
      if (revision === this.revision(key)) this.authCache.set(key, { status, checkedAt: this.now() });
      return status;
    })().finally(() => { if (this.authInflight.get(key) === attempt) this.authInflight.delete(key); });
    this.authInflight.set(key, attempt); return attempt;
  }
  async targets(selection, only) {
    if (!this.accounts) return ['codex','claude'].map(ai => ({ ai, account: selection[ai] || 'default' }));
    const rows = this.accounts.list().filter(r => ['codex','claude'].includes(r.ai));
    const keys = new Set(rows.map(r => this.key(r.ai, r.id)));
    for (const key of new Set([...Object.keys(this.cache), ...this.visible.keys(), ...this.authCache.keys()])) {
      if (!keys.has(key)) { const [ai, account = 'default'] = key.split(':'); this.invalidate(ai, account); this.authBusy.delete(key); }
    }
    const files = Object.fromEntries(['codex','claude'].map(ai => [ai, this.find(ai)]));
    return (await Promise.all(rows.filter(r => !only || r.ai === only.ai && r.id === only.account).map(async r => {
      const ai = r.ai, account = r.id, key = this.key(ai, account);
      const busy = Boolean(this.accounts.terminalBusy?.(ai, account, true) || this.accounts.locks?.has(ai + ':' + account));
      if (this.authBusy.has(key) && this.authBusy.get(key) !== busy) this.invalidate(ai, account);
      this.authBusy.set(key, busy);
      if (!files[ai]) { this.invalidate(ai, account); return null; }
      const revision = this.revision(key), status = await this.loginStatus(ai, account);
      if (revision !== this.revision(key)) return null;
      if (!['logged-in','unknown'].includes(status)) {
        if (this.cache[key] || this.inflight.has(key) || this.visible.has(key)) this.revisions.set(key, revision + 1);
        delete this.cache[key]; this.subscriptionWindows.delete(key); this.lastAttempt.delete(key); this.visible.delete(key); return null;
      }
      const target = { ai, account, accountName: label(r.name, '既定'), file: files[ai], revision };
      this.visible.set(key, target); return target;
    }))).filter(Boolean);
  }
  async status(force = false, selection = {}, options = {}) {
    const only = options.only;
    const targets = this.accounts ? await this.targets(selection, only) : ['codex','claude'].map(ai => ({ ai, account: selection[ai] || 'default' })).filter(r => !only || r.ai === only.ai && r.account === only.account);
    await Promise.all(targets.map(({ ai, account, file: installed, revision = this.revision(this.key(ai, account)) }) => {
      const key = this.key(ai, account), cached = this.cache[key], now = this.now();
      if (this.resetBusy.has(key)) return;
      // 他アカウントの認証待ち中に破棄されたtargetは、共有・試行時刻の更新より先に拒否する。
      if (revision !== this.revision(key)) return;
      if (this.inflight.has(key)) return this.inflight.get(key);
      if (force && !options.freshCredits && this.lastAttempt.has(key) && now - this.lastAttempt.get(key) < COOLDOWN) return;
      if (!force && cached && (cached.status !== 'ok' || now - Date.parse(cached.fetchedAt) < TTL)) return;
      this.lastAttempt.set(key, now);
      this.attemptSerial.set(key, (this.attemptSerial.get(key) || 0) + 1);
      const attempt = (async () => {
        const attemptedAt = new Date(now).toISOString();
        try {
          if (this.dry) throw error('dry');
          this.beforeRead?.(ai, account);
          const file = installed || this.find(ai); if (!file) throw error('missing');
          if (revision !== this.revision(key)) return;
          const data = await this.read(ai, file, { account });
          const allWindows = ai === 'codex' ? codexWindows(data) : claudeWindows(data);
          const windows = allWindows.filter(w => w.usedPercent !== null || w.resetsAt !== null);
          if (!windows.length) throw error('unavailable');
          const plan = providerPlan(ai, data);
          if (revision === this.revision(key)) {
            const extras = ai === 'codex' ? codexExtras(data) : {};
            if (ai === 'codex') this.tickets.decorate(account, data, extras.resetCredits, revision);
            const creditCheck = this.creditRequested.has(key) ? creditStatus(ai, data) : null;
            this.cache[key] = { account, status: 'ok', windows, ...(plan ? { plan } : {}), ...extras,
              ...(creditCheck ? { creditCheck } : {}), fetchedAt: new Date(this.now()).toISOString(), attemptedAt, message: '' };
            // Keep unknown windows privately: hiding an empty display row must
            // not turn incomplete quota information into positive evidence.
            if (ai === 'codex') this.subscriptionWindows.set(key, { cache: this.cache[key], windows: allWindows,
              complete: !data.rateLimitsByLimitId || Object.keys(data.rateLimitsByLimitId).length <= 20 });
          }
        } catch (e) {
          if (revision === this.revision(key)) {
            this.subscriptionWindows.delete(key);
            this.cache[key] = { account, status: 'unavailable', windows: [], fetchedAt: null, attemptedAt, message: messages[e.usageCode] || messages.response };
          }
        }
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, attempt); return attempt;
    }));
    return this.snapshot(selection);
  }
  async checkCredits(ai, account = 'default', { fresh = false } = {}) {
    if (!['claude', 'codex'].includes(ai)) return { availability: 'unknown', checkedAt: null };
    const key = this.key(ai, account);
    if (this.creditInflight.has(key)) {
      const result = await this.creditInflight.get(key);
      // Sharing a cache lookup is not sharing an actual query. Its caller may
      // still need to join the single fresh query at the dispatch boundary.
      return { ...result, acquisition: result.acquisition === 'cached' ? 'cached' : 'shared' };
    }
    const revision = this.revision(key), serial = this.attemptSerial.get(key) || 0, shared = this.inflight.has(key);
    this.creditRequested.add(key);
    const check = (async () => {
      // fresh is used only for a bounded dispatch recheck, never for a retry loop.
      await this.status(true, { [ai]: account }, { only: { ai, account }, freshCredits: fresh });
      const proof = revision === this.revision(key) ? this.creditState(ai, account) :
        { ai, account, availability: 'unknown', checkedAt: null, attemptedAt: null, reason: 'account-changed' };
      return { ...proof, acquisition: shared ? 'shared' : (this.attemptSerial.get(key) || 0) !== serial ? 'queried' : 'cached' };
    })();
    this.creditInflight.set(key, check);
    try { return await check; }
    finally { this.creditRequested.delete(key); if (this.creditInflight.get(key) === check) this.creditInflight.delete(key); }
  }
  creditState(ai, account = 'default') {
    const key = this.key(ai, account), cached = this.cache[key], now = this.now();
    const fetched = Date.parse(cached?.fetchedAt), attempted = Date.parse(cached?.attemptedAt);
    const times = { ai, account, checkedAt: Number.isFinite(fetched) ? cached.fetchedAt : null,
      attemptedAt: Number.isFinite(attempted) ? cached.attemptedAt : null };
    const unknown = reason => ({ ...times, availability: 'unknown', reason });
    if (this.resetBusy.has(key) || this.inflight.has(key)) return unknown('checking');
    if (!cached) return unknown('no-proof');
    if (cached.account !== account) return unknown('account-changed');
    if (cached.status !== 'ok') return unknown('unavailable');
    if (!cached.creditCheck) return unknown('not-checked');
    if (!(attempted <= fetched && fetched <= now)) return unknown('invalid-time');
    // A slow or failed actual read is not retried as if it were an old cache.
    if (fetched - attempted >= COOLDOWN) return unknown('slow-read');
    if (now - attempted >= COOLDOWN) return unknown('not-fresh');
    return { ...times, ...cached.creditCheck };
  }
  subscriptionAvailable(models, account = 'default') {
    const key = this.key('codex', account), cached = this.cache[key], proof = this.subscriptionWindows.get(key), now = this.now();
    const fetched = Date.parse(cached?.fetchedAt), attempted = Date.parse(cached?.attemptedAt);
    // Only fresh, unrounded contract windows for this account count as positive
    // remaining quota. Credits/context tokens and a missing hold prove nothing.
    if (!Array.isArray(models) || !models.length || this.inflight.has(key) || this.resetBusy.has(key) ||
        this.accounts && !this.visible.has(key) || cached?.status !== 'ok' || cached.account !== account ||
        proof?.cache !== cached || proof.complete !== true ||
        !(attempted <= fetched && fetched <= now && now - attempted < TTL)) return false;
    return models.every(model => {
      if (typeof model !== 'string' || !model) return false;
      const windows = proof.windows.filter(w => relevant('codex', model, w));
      return windows.length > 0 && windows.every(w => typeof w.usedPercent === 'number' &&
        Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100 &&
        (w.resetsAt === null || Date.parse(w.resetsAt) > now));
    });
  }
  invalidate(ai, account = 'default') {
    const k = this.key(ai, account); this.revisions.set(k, this.revision(k) + 1);
    delete this.cache[k]; this.subscriptionWindows.delete(k); this.lastAttempt.delete(k); this.authCache.delete(k); this.authInflight.delete(k); this.visible.delete(k);
    if (ai === 'codex') this.tickets.discard(account);
  }
  async useReset(account, token, { confirmed, retry, selection = {} } = {}) {
    const ai = 'codex', key = this.key(ai, account), revision = this.revision(key);
    const fail = code => { throw Object.assign(error(code), { status:409, publicMessage:messages[code] || messages.response }); };
    if (confirmed !== true || !validId(token)) fail('format');
    if (this.dry) fail('dry');
    if (this.resetBusy.has(key) || this.inflight.has(key)) fail('busy');
    if (this.accounts && !this.visible.has(key) || this.cache[key]?.status !== 'ok') fail('ticket-changed');
    let action;
    try { action = this.tickets.get(account, token, revision, retry); } catch (e) { fail(e.usageCode); }
    this.resetBusy.add(key);
    let outcome, message, unknown = false;
    try {
      const run = async () => {
        this.beforeRead?.(ai, account);
        const file = this.find(ai); if (!file) throw error('missing');
        const result = await this.consume(file, { account, now:this.now, consume:{ ...action, beforeSend:() => {
          if (revision !== this.revision(key)) throw error('account-changed');
          this.tickets.start(action);
        } } });
        if (!outcomes.has(result?.outcome)) throw Object.assign(error('response'), { consumeSent:true });
        outcome = result.outcome;
        // CLIの確定応答を先に保持し、保存失敗でも消費済みを失敗扱いにしない。
        try { this.tickets.finish(action, outcome); } catch { message = messages.journal; }
        if (outcome === 'reset') {
          try { await this.onReset(account); } catch { message = lt('リセット済みですが、上限保持の解除を保存できませんでした'); }
          // clearと同じミリ秒の取得は旧応答として除外されるため、再取得の開始を次の時刻へ。
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      };
      if (this.accounts?.readOnly) await this.accounts.readOnly(ai, account, run); else await run();
    } catch (e) {
      unknown = e.consumeSent === true;
      message = messages[unknown ? 'uncertain' : e.usageCode] || messages.response;
    } finally {
      this.resetBusy.delete(key);
      if (revision === this.revision(key)) { delete this.cache[key]; this.subscriptionWindows.delete(key); this.lastAttempt.delete(key); }
    }
    // 確認の取得だけ。使用要求を自動で再送しない。
    const snapshot = await this.status(true, selection);
    return { outcome:outcome || null, unknown, message:message || '', usage:snapshot };
  }
  loginChecked(ai, account, status) {
    this.invalidate(ai, account);
    this.authCache.set(this.key(ai, account), { status, checkedAt: this.now() });
  }
  snapshot(selection = {}) {
    const empty = account => ({ account, status: 'unavailable', windows: [], message: lt('未取得') });
    const providers = Object.fromEntries(['codex', 'claude'].filter(ai => !this.accounts || this.visible.has(this.key(ai, selection[ai] || 'default'))).map(ai => {
      const key = this.key(ai, selection[ai] || 'default');
      return [ai, { ...(this.cache[key] || empty(selection[ai] || 'default')), ...(this.accounts ? { accountName: this.visible.get(key).accountName } : {}) }];
    }));
    const keys = this.accounts ? [...this.visible.keys()] : ['codex', 'claude'].map(ai => this.key(ai, selection[ai] || 'default'));
    const last = keys.map(k => this.lastAttempt.get(k)).filter(v => v !== undefined);
    const accountProviders = this.accounts ? [...this.visible.entries()].map(([key, r]) => ({ ai: r.ai, ...(this.cache[key] || empty(r.account)), accountName: r.accountName, inUse: selection[r.ai] === r.account })) : Object.entries(this.cache).map(([key, provider]) => ({ ai: key.split(':')[0], ...provider }));
    const result = { providers, accountProviders, selection, refreshing: keys.some(k => this.inflight.has(k)), refreshAfter: last.length ? new Date(Math.max(...last) + COOLDOWN).toISOString() : null, cacheMinutes: TTL / 60000 };
    this.observe?.(result); return result;
  }
}
module.exports = { Usage, readCli, codexWindows, claudeWindows, windowLabel, resetTime };
