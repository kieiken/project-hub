'use strict';
const { FABLE_MODEL } = require('./fable-model');
const { lt } = require('./locale');
// インストール済み CLI の版・更新・モデル一覧。CLI の実行は固定した引数だけを execFile に渡す。
const fs = require('./platform/file-io');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ensureCliReady } = require('./cli-trust');

const { AIS, AI_LABEL, childEnv, agyAccountError, findExe, exeArgv } = require('./launch');
const { models: grokModels } = require('./grok');
const { agyModels } = require('./agy-models');
const { latestVersion, newer } = require('./update-check');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_OUTPUT = 5 * 1024 * 1024;
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '極高', max: 'MAX', ultra: 'Ultra' };
function modelEfforts(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(r => EFFORT_LABEL[typeof r === 'string' ? r : r?.effort]).filter(Boolean))];
}

function toolError(status, stage, reason) {
  const e = new Error(reason);
  e.status = status;
  e.stage = stage;
  e.reason = reason;
  return e;
}

function runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const x = exeArgv(file, args);
    execFile(x.file, x.args, { timeout: opts.timeout || 30000, maxBuffer: MAX_OUTPUT, env: childEnv(['agy', 'grok'].includes(path.basename(file)) ? path.basename(file) : '', opts.env || process.env) }, (err, stdout, stderr) => {
      if (err) return reject(err); // stdout/stderr には認証情報が入り得るので外へ出さない
      resolve(String(stdout || ''));
    });
  });
}

function failure(stage, err) {
  const detail = err?.killed ? lt('時間切れ') : typeof err?.code === 'number' ? lt`終了コード ${err.code}` : lt('CLI を実行できませんでした');
  return toolError(502, stage, lt`${stage === 'update' ? lt('更新') : lt('モデル再取得')}に失敗しました（${detail}）`);
}

// PATH の中から探す。結果は30秒だけ覚える（一覧のたびに PATH を全部確かめないため。入れ直した時は30秒で反映）
const foundAt = new Map();
function executable(name) {
  const hit = foundAt.get(name);
  if (hit && Date.now() - hit.at < 30000) return hit.file;
  const file = findExe(name, process.env.PATH, name === 'grok' ? [path.join(process.env.HUB_AI_HOME || os.homedir(), '.grok', 'bin')] : []);
  foundAt.set(name, { file, at: Date.now() });
  return file;
}

function methodFor(ai, file) {
  if (!file) return 'missing';
  let real;
  try { real = fs.realpathSync(file); } catch (e) { return 'unknown'; }
  if (ai === 'agy') return path.basename(real) === 'agy' ? 'native' : 'unknown';
  if (ai === 'grok') return /[/\\]\.grok[/\\]bin[/\\]/.test(real) ? 'native' : 'unknown';
  if (ai === 'codex') return /[/\\]\.codex[/\\]packages[/\\]standalone[/\\]/.test(real) ? 'standalone' : 'unknown';
  if (/[/\\]Caskroom[/\\]claude-code@latest[/\\]/.test(real)) return 'homebrew-cask';
  if (/[/\\]\.claude[/\\]local[/\\]|[/\\]\.local[/\\]share[/\\]claude[/\\]/.test(real)) return 'native';
  return 'unknown';
}

function cleanModels(rows) {
  if (!Array.isArray(rows)) throw toolError(502, 'models', lt('モデル一覧の形式が正しくありません'));
  const seen = new Set();
  return rows.filter(row => row && typeof row.id === 'string' && ID.test(row.id))
    .map(row => ({ id: row.id, label: typeof row.label === 'string' && row.label.length <= 80 ? row.label : row.id,
      ...(Array.isArray(row.efforts) ? { efforts: row.efforts.filter(e => Object.values(EFFORT_LABEL).includes(e)) } : {}) }))
    .filter(row => !seen.has(row.id) && seen.add(row.id));
}

function mergeKnown(known, current) {
  const out = [...known];
  const labels = new Map(out.map(row => [row.label, row.id]));
  for (const row of current) {
    const label = labels.has(row.label) && labels.get(row.label) !== row.id ? row.id : row.label;
    if (!labels.has(label)) { out.push({ id: row.id, label }); labels.set(label, row.id); }
  }
  return out;
}

function uniqueLabels(known, current) {
  const seen = new Map(known.map(row => [row.label, row.id]));
  return current.map(row => {
    const label = seen.has(row.label) && seen.get(row.label) !== row.id ? row.id : row.label;
    seen.set(label, row.id);
    return { ...row, label };
  });
}

function codexModels(json) {
  const rows = JSON.parse(json).models;
  if (!Array.isArray(rows)) throw toolError(502, 'models', lt('Codex のモデル一覧を読めませんでした'));
  const models = cleanModels(rows.filter(row => row && row.visibility === 'list').map(row => ({ id: row.slug, label: row.display_name || row.slug,
    efforts: modelEfforts(row.supported_reasoning_levels) })));
  if (!models.length) throw toolError(502, 'models', lt('Codex の表示対象モデルが見つかりませんでした'));
  return models;
}

function claudeModels(json) {
  const rows = JSON.parse(json)?.catalog?.config?.models;
  if (!Array.isArray(rows)) throw toolError(502, 'models', lt('Claude Code のモデル一覧を読めませんでした'));
  const models = cleanModels(rows.filter(row => row && row.section === 'main').map(row => ({ id: row.id, label: row.name || row.id,
    efforts: modelEfforts(row.supported_reasoning_levels || row.supportedEfforts) })));
  if (!models.length) throw toolError(502, 'models', lt('Claude Code の表示対象モデルが見つかりませんでした'));
  return models;
}

function latestClaudeCache(home, configDir = path.join(home, '.claude')) {
  const dir = path.join(configDir, 'cache', 'model-catalog');
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
      const file = path.join(dir, name);
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0] || null;
  } catch (e) { return null; }
}

// Claude Code の制御 initialize だけを送り、推論やユーザー文は送らない。
function claudeInitialize(file, timeoutMs = 12000, env = process.env) {
  file = ensureCliReady('claude', file);
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--model', FABLE_MODEL];
  return new Promise((resolve, reject) => {
    const x = exeArgv(file, args);
    const child = spawn(x.file, x.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let done = false, success = false, timedOut = false, buf = '', bytes = 0, modelIds = [], pendingError = null;
    let killTimer;
    const stopChild = () => {
      try { child.stdin.end(); } catch (e) { /* 既に閉じている */ }
      child.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (err) reject(err); else resolve(modelIds);
    };
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { pendingError = toolError(502, 'models', lt('Claude Code の応答が大きすぎます')); stopChild(); return; }
      buf += chunk.toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch (e) { continue; }
        if (event.type !== 'control_response' || event.response?.subtype !== 'success' || !Array.isArray(event.response.response?.models)) continue;
        success = true;
        modelIds = event.response.response.models.map(x => x && x.value).filter(x => typeof x === 'string' && ID.test(x));
        stopChild();
        break;
      }
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // アカウント情報をログや API に出さない
    child.on('error', () => finish(toolError(502, 'models', lt('Claude Code を起動できませんでした'))));
    child.on('close', () => finish(pendingError || (timedOut ? toolError(502, 'models', lt('Claude Code のモデル取得が時間切れになりました')) : success ? null : toolError(502, 'models', lt('Claude Code がモデル一覧を返しませんでした')))));
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'hub-model-catalog', request: { subtype: 'initialize' } }) + '\n');
  });
}

class AiTools {
  constructor(opts = {}) {
    this.root = opts.root || '';
    this.home = opts.home || process.env.HUB_AI_HOME || os.homedir();
    this.file = path.join(this.root, '_hub', 'ai-tools-models.json');
    this.run = opts.run || runFile;
    this.find = opts.find || executable;
    this.ready = opts.ready || ensureCliReady;
    this.methods = opts.methods || {};
    this.busy = opts.busy || (() => 0);
    this.dry = Boolean(opts.dry);
    this.accounts = opts.accounts;
    this.codexAccounts = {};
    this.refreshClaude = opts.refreshClaude || claudeInitialize;
    this.operation = null;
    this.maintenance = null;
    this.latest = opts.latest || latestVersion;
    this.updateChecks = {};
    this.checking = new Map();
    this.updateEpoch = {};
    this.clientVersions = {};
    this.catalogs = Object.fromEntries(AIS.map(ai => [ai, { models: [], known: [], refreshedAt: '', source: '' }]));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const ai of AIS) if (saved[ai]) {
        const known = cleanModels(saved[ai].known || []);
        const models = uniqueLabels(known, cleanModels(saved[ai].models));
        this.catalogs[ai] = { models, known: mergeKnown(known, models),
          refreshedAt: String(saved[ai].refreshedAt || ''), source: String(saved[ai].source || 'saved'),
          ...(ai === 'agy' ? { state: saved[ai].state || (models.length ? 'ready' : 'unconfirmed'), error: String(saved[ai].error || '') } : {}) };
      }
      for (const [id, c] of Object.entries(saved.codexAccounts || {})) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !c || typeof c !== 'object') continue;
        const known = cleanModels(c.known || []), models = uniqueLabels(known, cleanModels(c.models));
        this.codexAccounts[id] = { models, known: mergeKnown(known, models), refreshedAt: String(c.refreshedAt || ''), source: String(c.source || '') };
      }
    } catch (e) { /* 保存が無ければ CLI のローカルキャッシュを読む */ }
    // 旧形式は既定用としてのみ引き継ぐ。追加アカウントへ複製しない。
    this.codexAccounts.default ||= this.catalogs.codex;
    this.syncCaches();
  }

  syncCaches() {
    const codex = path.join(this.accounts?.location('codex', 'default') || path.join(this.home, '.codex'), 'models_cache.json');
    if (!this.catalogs.codex.models.length) try {
      const mtime = fs.statSync(codex).mtimeMs;
      if (mtime) {
        const models = uniqueLabels(this.catalogs.codex.known, codexModels(fs.readFileSync(codex, 'utf8')));
        this.catalogs.codex = { models, known: mergeKnown(this.catalogs.codex.known, models), refreshedAt: new Date(mtime).toISOString(), source: 'local-cache' };
        this.codexAccounts.default = this.catalogs.codex;
      }
    } catch (e) { /* キャッシュが無い・壊れている時は保存済みを使う */ }
    if (this.accounts) for (const id of this.codexAccountIds().filter(id => id !== 'default')) {
      if (this.codexAccounts[id]?.models.length) continue;
      try {
        const file = path.join(this.accounts.location('codex', id), 'models_cache.json');
        const models = uniqueLabels(this.catalog().codex.known, codexModels(fs.readFileSync(file, 'utf8')));
        this.codexAccounts[id] = { models, known: models, source: 'local-cache', refreshedAt: fs.statSync(file).mtime.toISOString() };
      } catch { /* 別アカウントの一覧で補わない */ }
    }
    if (!this.catalogs.claude.models.length) try {
      const latest = latestClaudeCache(this.home);
      if (latest) {
        const models = uniqueLabels(this.catalogs.claude.known, claudeModels(fs.readFileSync(latest.file, 'utf8')));
        this.catalogs.claude = { models, known: mergeKnown(this.catalogs.claude.known, models), refreshedAt: new Date(latest.mtime).toISOString(), source: 'local-cache' };
      }
    } catch (e) { /* キャッシュが無い・壊れている時は保存済みを使う */ }
  }

  catalog() {
    const rows = Object.values(this.codexCatalogs());
    const known = rows.reduce((all, c) => mergeKnown(all, c.known), []);
    const models = uniqueLabels(known, cleanModels(rows.flatMap(c => c.models)));
    return { ...this.catalogs, codex: { ...this.catalogs.codex, models, known } };
  }

  accountCatalog(ai, id = 'default') {
    return ai === 'codex' ? this.codexAccounts[id] || { models: [], known: [], source: '', refreshedAt: '' } : this.catalogs[ai];
  }

  codexAccountIds() {
    try {
      if (this.accounts) return this.accounts.list({ includeActivity: false }).filter(r => r.ai === 'codex').map(r => r.id);
    } catch { /* 台帳が読めない時も既定と保存済みの一覧で起動を続ける */ }
    return Object.keys(this.codexAccounts);
  }

  codexCatalogs() {
    return Object.fromEntries(this.codexAccountIds().map(id => [id, this.accountCatalog('codex', id)]));
  }

  persist(catalogs = this.catalogs, codexAccounts = this.codexAccounts) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 2, ...catalogs, codexAccounts }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally { try { fs.unlinkSync(tmp); } catch { /* renamed or absent */ } }
  }

  staleModel(ai, label) {
    const c = this.catalog()[ai];
    const old = c?.known.find(row => row.label === label || row.id === label);
    return Boolean(old && !c.models.some(row => row.id === old.id));
  }

  // 一分ごとの確認ではCLIを起動しない。リンク先・実体の変更だけを読む。
  clientIdentity(ai) {
    const file = this.find(ai);
    if (!file) return '';
    try {
      const real = fs.realpathSync(file), s = fs.statSync(real);
      return JSON.stringify([file, real, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch { return JSON.stringify([file]); }
  }

  async modelClient(ai, opts) {
    const identity = this.clientIdentity(ai), cached = this.clientVersions[ai];
    const version = cached?.identity === identity ? cached.version : await this.version(ai, this.find(ai), false, opts);
    return { identity, version };
  }

  async version(ai, file, strict = false, opts = {}) {
    if (!file || this.dry) return '';
    try {
      file = this.ready(ai, file);
      const value = (await this.run(file, ['--version'], { timeout: 10000, env: opts.env })).trim().split('\n')[0];
      const number = value.match(/\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/);
      if (number) {
        this.clientVersions[ai] = { identity: this.clientIdentity(ai), version: number[0] };
        return number[0];
      }
    } catch (e) { if (e.stage === 'mac-confirmation') throw e; /* status は不明、更新後は検証失敗として返す */ }
    if (strict) throw toolError(502, 'verify', lt('更新は実行されましたが、CLI の版を確認できませんでした'));
    return '';
  }

  async versionStatus(ai, file) {
    try { return { version: await this.version(ai, file) }; }
    catch (e) { if (e.stage !== 'mac-confirmation') throw e; return { version: '', notice: e.reason, confirmationRequired: true }; }
  }

  async status() {
    if (!this.operation) this.syncCaches();
    const entries = await Promise.all(AIS.map(async ai => {
      const file = this.find(ai);
      const method = this.methods[ai] || methodFor(ai, file);
      return [ai, {
        installed: Boolean(file), ...(await this.versionStatus(ai, file)), method,
        updating: Boolean(this.operation && this.operation.ai === ai),
        checking: this.checking.has(ai), updateCheck: this.updateChecks[ai] || null,
        models: this.catalogs[ai].models, refreshedAt: this.catalogs[ai].refreshedAt, source: this.catalogs[ai].source,
        modelRefreshAvailable: true,
      }];
    }));
    return { tools: Object.fromEntries(entries), operation: this.operation || this.maintenance?.operation || null, busyCount: this.busy() };
  }

  async checkUpdate(ai, opts = {}) {
    this.assertOwner(opts);
    if (!AIS.includes(ai)) throw toolError(400, 'input', lt('AI の指定が正しくありません'));
    if (this.operation?.ai === ai && this.operation.kind === 'update') throw toolError(409, 'busy', lt('このAIの更新適用が終わってから確認してください'));
    if (this.checking.has(ai)) return this.checking.get(ai);
    const file = this.find(ai);
    if (!file) throw toolError(400, 'detect', lt`${AI_LABEL[ai]} が見つかりません`);
    const pending = (async () => {
      const epoch = this.updateEpoch[ai] || 0;
      try {
        const currentVersion = await this.version(ai, file, false, opts);
        if (!currentVersion && !this.dry) throw Error(lt('現在版が不明'));
        const method = this.methods[ai] || methodFor(ai, file);
        const latest = this.dry ? { version: currentVersion || '0.0.0', source: 'dry-run' } : await this.latest(ai, method, this.home, undefined, ai === 'claude' ? opts.cacheDir : undefined);
        if (epoch !== (this.updateEpoch[ai] || 0) || this.operation?.ai === ai && this.operation.kind === 'update') throw toolError(409, 'busy', lt('確認中に更新が適用されました。適用後に確認してください'));
        const result = { ok: true, ai, currentVersion, latestVersion: latest.version, source: latest.source,
          available: newer(latest.version, currentVersion), checkedAt: new Date().toISOString(), applicable: ['standalone', 'native', 'homebrew-cask'].includes(method) };
        this.updateChecks[ai] = result; return result;
      } catch (e) {
        if (e.status === 409) throw e;
        this.updateChecks[ai] = { ...this.updateChecks[ai], ok: false, available: null, error: lt('更新情報を確認できませんでした。配布元への接続とCLIの版を確認してください'), failedAt: new Date().toISOString() };
        throw toolError(502, 'check', this.updateChecks[ai].error);
      }
    })();
    this.checking.set(ai, pending);
    try { return await pending; } finally { this.checking.delete(ai); }
  }

  check(ai, opts = {}) {
    this.assertOwner(opts);
    if (!AIS.includes(ai)) throw toolError(400, 'input', lt('AI の指定が正しくありません'));
    if (this.operation) throw toolError(409, 'busy', lt('別の更新・モデル再取得が進行中です'));
    const n = this.busy(ai);
    if (n) throw toolError(409, 'busy', lt`動いている AI が ${n} つあります。止めてから更新してください`);
    const file = this.find(ai);
    if (!file) throw toolError(400, 'detect', lt`${AI_LABEL[ai]} が見つかりません`);
    if (ai === 'agy') { const error = agyAccountError(this.home); if (error) throw toolError(409, 'auth', error); }
    return { file, method: this.methods[ai] || methodFor(ai, file) };
  }

  saveCatalog(ai, found, account = 'default') {
    if (ai === 'codex' && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(account))) throw toolError(400, 'input', lt('アカウントが不正です'));
    if (ai === 'codex') this.accounts?.get(ai, account);
    const current = this.accountCatalog(ai, account);
    const previous = new Set(current.models.map(x => x.id));
    const clean = uniqueLabels(this.catalog()[ai].known, cleanModels(found.models));
    if (!clean.length && !(ai === 'agy' && (found.empty || found.authRequired))) throw toolError(502, 'models', lt('取得したモデル一覧が空のため、以前の候補を残しました'));
    const known = mergeKnown(current.known, clean);
    const refreshedAt = new Date().toISOString();
    const next = { ...this.catalogs, [ai]: { models: clean, known, refreshedAt, source: found.source,
      ...(ai === 'agy' ? { state: found.authRequired ? 'auth-required' : clean.length ? 'ready' : 'empty', error: '' } : {}) } };
    const { refreshedAt: _previousTime, ...previousContent } = current;
    const { refreshedAt: _nextTime, ...nextContent } = next[ai];
    if (JSON.stringify(previousContent) === JSON.stringify(nextContent)) {
      return { ok: true, models: clean, added: 0, refreshedAt: current.refreshedAt, source: found.source, saved: false,
        ...(ai === 'agy' && !clean.length ? { empty: true, warning: lt('利用可能なモデルがありません。モデル一覧を再取得してください') } : {}) };
    }
    const profiles = ai === 'codex' ? { ...this.codexAccounts, [account]: next.codex } : this.codexAccounts;
    if (ai === 'codex' && account !== 'default') next.codex = this.catalogs.codex;
    this.persist(next, profiles);
    this.codexAccounts = profiles;
    this.catalogs = next;
    return { ok: true, models: clean, added: clean.filter(x => !previous.has(x.id)).length, refreshedAt, source: found.source,
      ...(ai === 'agy' && !clean.length ? { empty: true, warning: lt('利用可能なモデルがありません。モデル一覧を再取得してください') } : {}) };
  }

  modelFailure(ai, message) {
    const current = this.catalogs[ai];
    this.catalogs[ai] = { ...current, state: 'failed', error: message };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.persist();
    } catch (e) { this.catalogs[ai] = current; throw e; }
  }

  async fetchModels(ai, file, opts = {}) {
    file = this.ready(ai, file);
    if (ai === 'agy') {
      const text = await this.run(file, ['models'], { env: opts.env });
      try { const models = agyModels(text); return { models, source: 'agy-cli', empty: !models.length }; }
      catch { throw toolError(502, 'models', lt('Agy のモデル一覧の形式を確認できませんでした。前回の候補を保持しています')); }
    }
    if (ai === 'grok') return { models: grokModels(await this.run(file, ['models'], { env: opts.env })), source: 'grok-cli' };
    if (ai === 'codex') return { models: codexModels(await this.run(file, ['debug', 'models', ...(opts.fileAuth ? ['-c', 'cli_auth_credentials_store="file"'] : [])], { timeout: 120000, env: opts.env })), source: 'codex-cli' };
    const before = latestClaudeCache(this.home, opts.cacheDir);
    let liveIds = await this.refreshClaude(file, 12000, opts.env); // 応答の main/overflow は混在するので、モデル名は cache の main から取る
    let after = latestClaudeCache(this.home, opts.cacheDir);
    const unchanged = !after || (before && after.file === before.file && after.mtime <= before.mtime);
    if (!after) {
      if (!this.catalogs.claude.models.length) throw toolError(502, 'models', lt('Claude Code の新しいモデル一覧を確認できませんでした'));
      return { models: this.catalogs.claude.models, source: this.catalogs.claude.source, unchanged: true };
    }
    try {
      // cacheを再書込しないCLIでも、今回の制御応答とmainが一致すれば新しい観測として保存する。
      let models = claudeModels(fs.readFileSync(after.file, 'utf8'));
      const matches = () => Array.isArray(liveIds) && models?.every(row => liveIds.includes(row.id)
        || ['opus', 'sonnet', 'haiku', 'fable'].some(family => row.id.startsWith(`claude-${family}-`) && liveIds.includes(family)));
      // 初回応答が旧cache基準でも、同じ実行でcacheが新しくなった時だけ制御initializeを一回取り直す。
      if (!matches() && (!before || after.mtime > before.mtime)) {
        liveIds = await this.refreshClaude(file, 12000, opts.env);
        after = latestClaudeCache(this.home, opts.cacheDir);
        models = after ? claudeModels(fs.readFileSync(after.file, 'utf8')) : null;
      }
      if (!matches()) {
        if (!this.catalogs.claude.models.length) throw toolError(502, 'models', lt('Claude Code の応答とモデル一覧が一致しません'));
        return { models: this.catalogs.claude.models, source: this.catalogs.claude.source, unchanged: true };
      }
      return {
        models,
        source: 'claude-cache',
      };
    }
    catch (e) {
      if (unchanged && this.catalogs.claude.models.length) {
        return { models: this.catalogs.claude.models, source: this.catalogs.claude.source, unchanged: true };
      }
      throw e.status ? e : toolError(502, 'models', lt('Claude Code のモデル一覧を読めませんでした'));
    }
  }

  async refresh(ai, opts = {}) {
    const { file } = this.check(ai, opts);
    if (this.dry) return { ok: true, dry: true, ai, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt };
    this.operation = { ai, kind: 'models', startedAt: new Date().toISOString() };
    try {
      const found = await this.fetchModels(ai, file, opts);
      const result = found.unchanged
        ? { ok: true, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt,
          source: this.catalogs[ai].source, unchanged: true, warning: lt('Claude Code のローカル候補を新しく確認できず、前回の内容を残しました') }
        : this.saveCatalog(ai, found, opts.account);
      return { ai, ...result, observedModels: found.unchanged ? undefined : found.models };
    } catch (e) {
      const error = e.status ? e : failure('models', e);
      if (ai === 'agy') this.modelFailure(ai, error.message);
      throw error;
    }
    finally { this.operation = null; }
  }

  async update(ai, opts = {}) {
    const { file, method } = this.check(ai, opts);
    let updater, args;
    if (ai === 'codex' && method === 'standalone') { updater = file; args = ['update']; }
    else if (ai === 'claude' && method === 'homebrew-cask') { updater = this.find('brew'); args = ['upgrade', '--cask', 'claude-code@latest']; }
    else if (ai === 'claude' && method === 'native') { updater = file; args = ['update']; }
    else if (['agy', 'grok'].includes(ai) && method === 'native') { updater = file; args = ['update']; }
    else throw toolError(400, 'detect', lt('この導入方法の更新手順を確認できませんでした'));
    if (!updater) throw toolError(400, 'detect', lt('Homebrew が見つかりません'));
    if (this.dry) return { ok: true, dry: true, ai, beforeVersion: '', afterVersion: '', changed: false, models: { ok: true, models: this.catalogs[ai].models, added: 0 } };
    this.operation = { ai, kind: 'update', startedAt: new Date().toISOString() };
    this.updateEpoch[ai] = (this.updateEpoch[ai] || 0) + 1;
    try {
      const beforeVersion = await this.version(ai, file, false, opts);
      if (updater === file) updater = this.ready(ai, updater);
      await this.run(updater, args, { timeout: 600000, env: opts.env });
      delete this.updateChecks[ai];
      foundAt.delete(ai); // re-resolve an updater's new symlink before any execution
      const updatedFile = this.ready(ai, this.find(ai) || file);
      let afterVersion = '', verifyError = '';
      try { afterVersion = await this.version(ai, updatedFile, true, opts); }
      catch (e) { if (e.stage === 'mac-confirmation') throw e; verifyError = e.reason || e.message; }
      let models;
      try {
        const found = await this.fetchModels(ai, updatedFile, opts);
        models = found.unchanged
          ? { ok: true, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt,
            source: this.catalogs[ai].source, unchanged: true, warning: lt('Claude Code のローカル候補を新しく確認できず、前回の内容を残しました') }
          : this.saveCatalog(ai, found, opts.account);
        if (!found.unchanged) models.observedModels = found.models;
      }
      catch (e) { if (e.stage === 'mac-confirmation') throw e; models = { ok: false, error: e.status ? e.reason : failure('models', e).reason }; }
      return { ok: true, ai, beforeVersion, afterVersion, changed: Boolean(afterVersion && beforeVersion !== afterVersion),
        verified: Boolean(afterVersion), ...(verifyError ? { verifyError } : {}), models };
    } catch (e) { throw e.status ? e : failure('update', e); }
    finally { this.operation = null; }
  }

  assertOwner(opts = {}) {
    const blocked=this.canOperate?.();if(blocked)throw toolError(409,'busy',blocked);
    if (this.maintenance && opts.owner !== this.maintenance.owner) throw toolError(409, 'busy', lt('別の更新・モデル再取得が進行中です'));
  }
  acquire(kind, ai) {
    const blocked=this.canOperate?.();if(blocked)throw toolError(409,'busy',blocked);
    if (this.isOperating() || this.checking.size) throw toolError(409, 'busy', lt('別の更新・モデル再取得が進行中です'));
    const owner = Symbol('ai-maintenance');
    this.maintenance = { owner, operation: { kind, ai, startedAt: new Date().toISOString() } };
    return owner;
  }
  release(owner) { if (this.maintenance?.owner === owner) this.maintenance = null; }
  isOperating(ai) {
    const op = this.operation || this.maintenance?.operation;
    if (!ai) return Boolean(op);
    // Pure update checks never replace a CLI or run a model refresh.
    if (!this.operation && op?.kind === 'check') return false;
    return Boolean(op && (!op.ai || op.ai === ai));
  }
}

module.exports = { grokModels, AiTools, agyModels, codexModels, claudeModels, claudeInitialize, methodFor, toolError, executable };
