'use strict';
// インストール済み CLI の版・更新・モデル一覧。CLI の実行は固定した引数だけを execFile に渡す。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('./platform');

const { AIS, AI_LABEL, AGY_MODEL, childEnv, agyAccountError } = require('./launch');
const { latestVersion, newer } = require('./update-check');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_OUTPUT = 5 * 1024 * 1024;

function toolError(status, stage, reason) {
  const e = new Error(reason);
  e.status = status;
  e.stage = stage;
  e.reason = reason;
  return e;
}

function runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout || 30000, maxBuffer: MAX_OUTPUT, env: childEnv(path.basename(file) === 'agy' ? 'agy' : '', process.env) }, (err, stdout, stderr) => {
      if (err) return reject(err); // stdout/stderr には認証情報が入り得るので外へ出さない
      resolve(String(stdout || ''));
    });
  });
}

function failure(stage, err) {
  const detail = err?.killed ? '時間切れ' : typeof err?.code === 'number' ? `終了コード ${err.code}` : 'CLI を実行できませんでした';
  return toolError(502, stage, `${stage === 'update' ? '更新' : 'モデル再取得'}に失敗しました（${detail}）`);
}

// PATH の中から探す。結果は30秒だけ覚える（一覧のたびに PATH を全部確かめないため。入れ直した時は30秒で反映）
const foundAt = new Map();
function executable(name) {
  const hit = foundAt.get(name);
  if (hit && Date.now() - hit.at < 30000) return hit.file;
  const file = require('./platform').executable(name);
  foundAt.set(name, { file, at: Date.now() });
  return file;
}

function methodFor(ai, file) {
  if (!file) return 'missing';
  let real;
  try { real = fs.realpathSync(file); } catch (e) { return 'unknown'; }
  if (ai === 'agy') return path.basename(real) === 'agy' ? 'native' : 'unknown';
  if (ai === 'codex') return /[/\\]\.codex[/\\]packages[/\\]standalone[/\\]/.test(real) ? 'standalone' : 'unknown';
  if (/[/\\]Caskroom[/\\]claude-code@latest[/\\]/.test(real)) return 'homebrew-cask';
  if (/[/\\]\.claude[/\\]local[/\\]|[/\\]\.local[/\\]share[/\\]claude[/\\]/.test(real)) return 'native';
  return 'unknown';
}

function cleanModels(rows) {
  if (!Array.isArray(rows)) throw toolError(502, 'models', 'モデル一覧の形式が正しくありません');
  const seen = new Set();
  return rows.filter(row => row && typeof row.id === 'string' && ID.test(row.id))
    .map(row => ({ id: row.id, label: typeof row.label === 'string' && row.label.length <= 80 ? row.label : row.id }))
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
  if (!Array.isArray(rows)) throw toolError(502, 'models', 'Codex のモデル一覧を読めませんでした');
  const models = cleanModels(rows.filter(row => row && row.visibility === 'list').map(row => ({ id: row.slug, label: row.display_name || row.slug })));
  if (!models.length) throw toolError(502, 'models', 'Codex の表示対象モデルが見つかりませんでした');
  return models;
}

function agyModels(text) {
  const found = String(text).split(/\r?\n/).map(line => line.split('\t')).find(([id]) => id === AGY_MODEL.id);
  if (!found) { const error = toolError(502, 'models', 'Agy の一覧に承認された Gemini 3.1 Pro (High) がありません。別のモデルへは切り替えません'); error.unavailable = true; throw error; }
  return [{ ...AGY_MODEL }];
}

function claudeModels(json) {
  const rows = JSON.parse(json)?.catalog?.config?.models;
  if (!Array.isArray(rows)) throw toolError(502, 'models', 'Claude Code のモデル一覧を読めませんでした');
  const models = cleanModels(rows.filter(row => row && row.section === 'main').map(row => ({ id: row.id, label: row.name || row.id })));
  if (!models.length) throw toolError(502, 'models', 'Claude Code の表示対象モデルが見つかりませんでした');
  return models;
}

function latestClaudeCache(home) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
      const file = path.join(dir, name);
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0] || null;
  } catch (e) { return null; }
}

// Claude Code の制御 initialize だけを送り、推論やユーザー文は送らない。
function claudeInitialize(file, timeoutMs = 12000) {
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--model', 'claude-fable-5-1'];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
      if (bytes > MAX_OUTPUT) { pendingError = toolError(502, 'models', 'Claude Code の応答が大きすぎます'); stopChild(); return; }
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
    child.on('error', () => finish(toolError(502, 'models', 'Claude Code を起動できませんでした')));
    child.on('close', () => finish(pendingError || (timedOut ? toolError(502, 'models', 'Claude Code のモデル取得が時間切れになりました') : success ? null : toolError(502, 'models', 'Claude Code がモデル一覧を返しませんでした'))));
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
    this.methods = opts.methods || {};
    this.busy = opts.busy || (() => 0);
    this.dry = Boolean(opts.dry);
    this.refreshClaude = opts.refreshClaude || claudeInitialize;
    this.operation = null;
    this.latest = opts.latest || latestVersion;
    this.updateChecks = {};
    this.checking = new Map();
    this.updateEpoch = {};
    this.catalogs = Object.fromEntries(AIS.map(ai => [ai, { models: [], known: [], refreshedAt: '', source: '' }]));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const ai of AIS) if (saved[ai]) {
        const models = cleanModels(saved[ai].models).filter(x => ai !== 'agy' || x.id === AGY_MODEL.id);
        this.catalogs[ai] = { models, known: mergeKnown(cleanModels(saved[ai].known || []).filter(x => ai !== 'agy' || x.id === AGY_MODEL.id), models),
          refreshedAt: String(saved[ai].refreshedAt || ''), source: String(saved[ai].source || 'saved') };
      }
    } catch (e) { /* 保存が無ければ CLI のローカルキャッシュを読む */ }
    this.syncCaches();
  }

  syncCaches() {
    const codex = path.join(this.home, '.codex', 'models_cache.json');
    if (!this.catalogs.codex.models.length) try {
      const mtime = fs.statSync(codex).mtimeMs;
      if (mtime) {
        const models = uniqueLabels(this.catalogs.codex.known, codexModels(fs.readFileSync(codex, 'utf8')));
        this.catalogs.codex = { models, known: mergeKnown(this.catalogs.codex.known, models), refreshedAt: new Date(mtime).toISOString(), source: 'local-cache' };
      }
    } catch (e) { /* キャッシュが無い・壊れている時は保存済みを使う */ }
    if (!this.catalogs.claude.models.length) try {
      const latest = latestClaudeCache(this.home);
      if (latest) {
        const models = uniqueLabels(this.catalogs.claude.known, claudeModels(fs.readFileSync(latest.file, 'utf8')));
        this.catalogs.claude = { models, known: mergeKnown(this.catalogs.claude.known, models), refreshedAt: new Date(latest.mtime).toISOString(), source: 'local-cache' };
      }
    } catch (e) { /* キャッシュが無い・壊れている時は保存済みを使う */ }
  }

  catalog() {
    return this.catalogs;
  }

  staleModel(ai, label) {
    const c = this.catalogs[ai];
    const old = c?.known.find(row => row.label === label);
    return Boolean(old && !c.models.some(row => row.id === old.id));
  }

  async version(ai, file, strict = false) {
    if (!file || this.dry) return '';
    try {
      const value = (await this.run(file, ['--version'], { timeout: 10000 })).trim().split('\n')[0];
      const number = value.match(/\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/);
      if (number) return number[0];
    } catch (e) { /* status は不明、更新後は検証失敗として返す */ }
    if (strict) throw toolError(502, 'verify', '更新は実行されましたが、CLI の版を確認できませんでした');
    return '';
  }

  async status() {
    if (!this.operation) this.syncCaches();
    const entries = await Promise.all(AIS.map(async ai => {
      const file = this.find(ai);
      const method = this.methods[ai] || methodFor(ai, file);
      return [ai, {
        installed: Boolean(file), version: await this.version(ai, file), method,
        updating: Boolean(this.operation && this.operation.ai === ai),
        checking: this.checking.has(ai), updateCheck: this.updateChecks[ai] || null,
        models: this.catalogs[ai].models, refreshedAt: this.catalogs[ai].refreshedAt, source: this.catalogs[ai].source,
        modelRefreshAvailable: true,
      }];
    }));
    return { tools: Object.fromEntries(entries), operation: this.operation, busyCount: this.busy() };
  }

  async checkUpdate(ai) {
    if (!AIS.includes(ai)) throw toolError(400, 'input', 'AI の指定が正しくありません');
    if (this.operation?.ai === ai && this.operation.kind === 'update') throw toolError(409, 'busy', 'このAIの更新適用が終わってから確認してください');
    if (this.checking.has(ai)) return this.checking.get(ai);
    const file = this.find(ai);
    if (!file) throw toolError(400, 'detect', `${AI_LABEL[ai]} が見つかりません`);
    const pending = (async () => {
      const epoch = this.updateEpoch[ai] || 0;
      try {
        const currentVersion = await this.version(ai, file);
        if (!currentVersion && !this.dry) throw Error('現在版が不明');
        const method = this.methods[ai] || methodFor(ai, file);
        const latest = this.dry ? { version: currentVersion || '0.0.0', source: 'dry-run' } : await this.latest(ai, method, this.home);
        if (epoch !== (this.updateEpoch[ai] || 0) || this.operation?.ai === ai && this.operation.kind === 'update') throw toolError(409, 'busy', '確認中に更新が適用されました。適用後に確認してください');
        const result = { ok: true, ai, currentVersion, latestVersion: latest.version, source: latest.source,
          available: newer(latest.version, currentVersion), checkedAt: new Date().toISOString(), applicable: ['standalone', 'native', 'homebrew-cask'].includes(method) };
        this.updateChecks[ai] = result; return result;
      } catch (e) {
        if (e.status === 409) throw e;
        this.updateChecks[ai] = { ...this.updateChecks[ai], ok: false, available: null, error: '更新情報を確認できませんでした。配布元への接続とCLIの版を確認してください', failedAt: new Date().toISOString() };
        throw toolError(502, 'check', this.updateChecks[ai].error);
      }
    })();
    this.checking.set(ai, pending);
    try { return await pending; } finally { this.checking.delete(ai); }
  }

  check(ai) {
    if (!AIS.includes(ai)) throw toolError(400, 'input', 'AI の指定が正しくありません');
    if (this.operation) throw toolError(409, 'busy', '別の更新・モデル再取得が進行中です');
    const n = this.busy();
    if (n) throw toolError(409, 'busy', `動いている AI が ${n} つあります。止めてから更新してください`);
    const file = this.find(ai);
    if (!file) throw toolError(400, 'detect', `${AI_LABEL[ai]} が見つかりません`);
    if (ai === 'agy') { const error = agyAccountError(this.home); if (error) throw toolError(409, 'auth', error); }
    return { file, method: this.methods[ai] || methodFor(ai, file) };
  }

  saveCatalog(ai, found) {
    const previous = new Set(this.catalogs[ai].models.map(x => x.id));
    const clean = uniqueLabels(this.catalogs[ai].known, cleanModels(found.models));
    if (!clean.length && !(ai === 'agy' && found.unavailable)) throw toolError(502, 'models', '取得したモデル一覧が空のため、以前の候補を残しました');
    const known = mergeKnown(this.catalogs[ai].known, clean);
    const refreshedAt = new Date().toISOString();
    const next = { ...this.catalogs, [ai]: { models: clean, known, refreshedAt, source: found.source } };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...next }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) { /* 無い */ }
      throw e;
    }
    this.catalogs = next;
    return { ok: true, models: clean, added: clean.filter(x => !previous.has(x.id)).length, refreshedAt, source: found.source,
      ...(found.unavailable ? { unavailable: true, warning: '承認された Gemini 3.1 Pro (High) が一覧から外れたため、Agy を選べない状態にしました。別のモデルへは切り替えません' } : {}) };
  }

  async fetchModels(ai, file) {
    if (ai === 'agy') {
      const text = await this.run(file, ['models']);
      try { return { models: agyModels(text), source: 'agy-cli' }; }
      catch (e) { if (!e.unavailable) throw e; return { models: [], source: 'agy-cli', unavailable: true }; }
    }
    if (ai === 'codex') return { models: codexModels(await this.run(file, ['debug', 'models'], { timeout: 120000 })), source: 'codex-cli' };
    const before = latestClaudeCache(this.home);
    const liveIds = await this.refreshClaude(file); // 応答の main/overflow は混在するので、モデル名は cache の main から取る
    const after = latestClaudeCache(this.home);
    const unchanged = !after || (before && after.file === before.file && after.mtime <= before.mtime);
    if (unchanged) {
      if (!this.catalogs.claude.models.length) throw toolError(502, 'models', 'Claude Code の新しいモデル一覧を確認できませんでした');
      return { models: this.catalogs.claude.models, source: this.catalogs.claude.source, unchanged: true };
    }
    try {
      const models = claudeModels(fs.readFileSync(after.file, 'utf8'));
      const matches = id => liveIds.includes(id) || ['opus', 'sonnet', 'haiku'].some(family => id.startsWith(`claude-${family}-`) && liveIds.includes(family));
      if (!Array.isArray(liveIds) || !models.every(row => matches(row.id))) {
        if (!this.catalogs.claude.models.length) throw toolError(502, 'models', 'Claude Code の応答とモデル一覧が一致しません');
        return { models: this.catalogs.claude.models, source: this.catalogs.claude.source, unchanged: true };
      }
      return {
        models,
        source: 'claude-cache',
      };
    }
    catch (e) { throw e.status ? e : toolError(502, 'models', 'Claude Code のモデル一覧を読めませんでした'); }
  }

  async refresh(ai) {
    const { file } = this.check(ai);
    if (this.dry) return { ok: true, dry: true, ai, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt };
    this.operation = { ai, kind: 'models', startedAt: new Date().toISOString() };
    try {
      const found = await this.fetchModels(ai, file);
      const result = found.unchanged
        ? { ok: true, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt,
          source: this.catalogs[ai].source, unchanged: true, warning: 'Claude Code のローカル候補を新しく確認できず、前回の内容を残しました' }
        : this.saveCatalog(ai, found);
      return { ai, ...result };
    } catch (e) { throw e.status ? e : failure('models', e); }
    finally { this.operation = null; }
  }

  async update(ai) {
    const { file, method } = this.check(ai);
    let updater, args;
    if (ai === 'codex' && method === 'standalone') { updater = file; args = ['update']; }
    else if (ai === 'claude' && method === 'homebrew-cask') { updater = this.find('brew'); args = ['upgrade', '--cask', 'claude-code@latest']; }
    else if (ai === 'claude' && method === 'native') { updater = file; args = ['update']; }
    else if (ai === 'agy' && method === 'native') { updater = file; args = ['update']; }
    else throw toolError(400, 'detect', 'この導入方法の更新手順を確認できませんでした');
    if (!updater) throw toolError(400, 'detect', 'Homebrew が見つかりません');
    if (this.dry) return { ok: true, dry: true, ai, beforeVersion: '', afterVersion: '', changed: false, models: { ok: true, models: this.catalogs[ai].models, added: 0 } };
    this.operation = { ai, kind: 'update', startedAt: new Date().toISOString() };
    this.updateEpoch[ai] = (this.updateEpoch[ai] || 0) + 1;
    try {
      const beforeVersion = await this.version(ai, file);
      await this.run(updater, args, { timeout: 600000 });
      delete this.updateChecks[ai];
      let afterVersion = '', verifyError = '';
      try { afterVersion = await this.version(ai, this.find(ai) || file, true); }
      catch (e) { verifyError = e.reason || e.message; }
      let models;
      try {
        const found = await this.fetchModels(ai, this.find(ai) || file);
        models = found.unchanged
          ? { ok: true, models: this.catalogs[ai].models, added: 0, refreshedAt: this.catalogs[ai].refreshedAt,
            source: this.catalogs[ai].source, unchanged: true, warning: 'Claude Code のローカル候補を新しく確認できず、前回の内容を残しました' }
          : this.saveCatalog(ai, found);
      }
      catch (e) { models = { ok: false, error: e.status ? e.reason : failure('models', e).reason }; }
      return { ok: true, ai, beforeVersion, afterVersion, changed: Boolean(afterVersion && beforeVersion !== afterVersion),
        verified: Boolean(afterVersion), ...(verifyError ? { verifyError } : {}), models };
    } catch (e) { throw e.status ? e : failure('update', e); }
    finally { this.operation = null; }
  }

  isOperating() { return Boolean(this.operation); }
}

module.exports = { AiTools, agyModels, codexModels, claudeModels, claudeInitialize, methodFor, toolError, executable };
