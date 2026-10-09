'use strict';
// 契約CLIの状態だけを読む。user prompt / thread / turn は送らず、秘密・生出力は公開しない。
const { spawn } = require('./platform');
const os = require('node:os');
const { executable } = require('./ai-tools');

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
  if (mins === 10080) return '週間枠';
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return '利用枠';
  if (mins % 1440 === 0) return `${mins / 1440}日枠`;
  if (mins % 60 === 0) return `${mins / 60}時間枠`;
  return `${mins}分枠`;
}
const label = (v, fallback) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback;
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
      windows.push(row(`${id}:${key}`, id === 'codex' ? name : `${label(bucket.limitName, String(id))}・${name}`, w.usedPercent, w.resetsAt));
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
  for (const [key, name] of [['five_hour','5時間枠'], ['seven_day','週間枠'], ['seven_day_oauth_apps','週間枠（OAuthアプリ）'], ['seven_day_opus','Opus・週間枠'], ['seven_day_sonnet','Sonnet・週間枠']]) {
    const w = limits[key]; if (w && typeof w === 'object') windows.push(row(key, name, w.utilization, w.resets_at));
  }
  if (Array.isArray(limits.model_scoped)) for (const [i, w] of limits.model_scoped.slice(0,20).entries()) {
    if (w && typeof w === 'object') windows.push(row(`model:${i}`, `${label(w.display_name,'モデル別')}・週間枠`, w.utilization, w.resets_at));
  }
  return windows;
}

// stdoutは上限付きJSONL。CLIが要求するツールや認証操作には応答せず、固定の状態要求だけを送る。
function readCli(ai, file, options = {}) {
  const start = options.spawn || spawn;
  const timeoutMs = options.timeoutMs || 20000;
  const args = ai === 'claude' ? ['--print', '--input-format','stream-json','--output-format','stream-json','--verbose',
    '--safe-mode','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources','','--settings','{"disableAllHooks":true}','--disable-slash-commands','--tools','','--model','claude-fable-5-1'] :
    ['app-server','--listen','stdio://','-c','analytics.enabled=false'];
  return new Promise((resolve, reject) => {
    let child;
    try { child = start(file, args, { stdio:['pipe','pipe','pipe'], cwd: os.tmpdir(), env: process.env }); }
    catch { reject(error('start')); return; }
    let bytes = 0, buf = '', stopped = false, settled = false, value, failure, killTimer;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure); else if (value) resolve(value); else reject(error('response'));
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
    let stage = 'init';
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
          const id = { init:0, account:1, usage:2 }[stage];
          if (m.id !== id) continue;
          if (m.error) { stop(error('response')); continue; }
          if (stage === 'init') {
            send({ method:'initialized', params:{} }); stage = 'account';
            send({ id:1, method:'account/read', params:{ refreshToken:false } });
          } else if (stage === 'account') {
            if (m.result?.account?.type !== 'chatgpt') { stop(error('subscription')); continue; }
            stage = 'usage'; send({ id:2, method:'account/rateLimits/read' });
          } else stop(null, m.result);
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
  missing:'CLIが見つかりません', start:'CLIを起動できませんでした', timeout:'CLIの応答が時間切れになりました',
  subscription:'契約アカウントの利用枠を取得できません', unavailable:'利用枠の情報が提供されていません',
  format:'CLIの利用情報を読み取れませんでした', unsupported:'このCLIでは利用情報を取得できません',
  response:'CLIから利用情報を取得できませんでした', dry:'テスト中のため取得していません',
};
class Usage {
  constructor(options = {}) {
    this.find = options.find || executable;
    this.read = options.read || readCli;
    this.now = options.now || Date.now;
    this.dry = Boolean(options.dry);
    this.observe = options.observe || null;
    this.cache = {}; this.inflight = null; this.lastAttempt = null;
  }
  async status(force = false) {
    if (this.inflight) return this.inflight;
    const now = this.now();
    if (force && this.lastAttempt !== null && now - this.lastAttempt < COOLDOWN) return this.snapshot();
    const ais = ['codex','claude'].filter(ai => force || !this.cache[ai] || this.cache[ai].status === 'ok' && now - Date.parse(this.cache[ai].fetchedAt) >= TTL);
    if (!ais.length) return this.snapshot();
    this.lastAttempt = now;
    this.inflight = Promise.all(ais.map(async ai => {
      const attemptedAt = new Date(now).toISOString();
      try {
        if (this.dry) throw error('dry');
        const file = this.find(ai); if (!file) throw error('missing');
        const data = await this.read(ai, file);
        const windows = (ai === 'codex' ? codexWindows(data) : claudeWindows(data)).filter(w => w.usedPercent !== null || w.resetsAt !== null);
        if (!windows.length) throw error('unavailable');
        this.cache[ai] = { status:'ok', windows, fetchedAt:new Date(this.now()).toISOString(), attemptedAt, message:'' };
      } catch (e) {
        this.cache[ai] = { status:'unavailable', windows:[], fetchedAt:null, attemptedAt, message:messages[e.usageCode] || messages.response };
      }
    })).then(() => { this.inflight = null; return this.snapshot(); }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  snapshot() {
    const result = { providers:this.cache, refreshing:Boolean(this.inflight), refreshAfter:this.lastAttempt === null ? null : new Date(this.lastAttempt + COOLDOWN).toISOString(), cacheMinutes:TTL / 60000 };
    this.observe?.(result);
    return result;
  }
}
module.exports = { Usage, readCli, codexWindows, claudeWindows, windowLabel, resetTime };
