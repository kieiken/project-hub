'use strict';
const { lt } = require('./locale');
// 認証情報はCLIの専用場所にだけ置く。Hubの台帳には名前と場所だけを保存する。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { AGY_MODEL, agyAccountError, childEnv, GROK_AUTH_ENV, grokCommand } = require('./launch');
const AIS = ['claude', 'codex', 'grok'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const API_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
// Claude Code 2.1.291の認証入力を配布物で照合。固定リストはHubに無く
// 外部Terminalだけに存在する入力もenv -uで遮断する。既定には適用しない。
const CLAUDE_AUTH_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_GATEWAY_LINEAGE', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH', 'CLAUDE_BG_SOCKET_TOKENS_PATH',
  'CLAUDE_BG_RV_AUTH', 'CLAUDE_BG_PTY_AUTH', 'CLAUDE_BG_CLAIM_AUTH',
  'CLAUDE_BRIDGE_OAUTH_TOKEN', 'CLAUDE_TRUSTED_DEVICE_TOKEN', 'AGENT_PROXY_AUTH_TOKEN',
  'CLAUDE_CODE_ARTIFACTS_API_TOKEN', 'CLAUDE_CODE_SLACK_TAG_TOKEN', 'CLAUDE_CODE_HFI_BEARER_TOKEN',
  'CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN', 'CLAUDE_CODE_MEMORY_API_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE', 'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_API_KEY', 'ANTHROPIC_UNIX_SOCKET', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_ENVIRONMENT_KEY',
  'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
];
const unsetKeys = env => [...new Set([...API_ENV, ...CLAUDE_AUTH_ENV, ...Object.keys(env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_)/.test(k))])];
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
function noLinks(dir) {
  for (let p = path.resolve(dir);;) {
    try { if (fs.lstatSync(p).isSymbolicLink()) fail(lt('アカウントの場所にリンクは使えません')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(p); if (parent === p) break; p = parent;
  }
}
const run = (file, args, env) => new Promise(resolve => {
  const launch = require('./launch'), x = launch.exeArgv(launch.findExe(file) || file, args); // Windows は .exe / .cmd を解決する
  execFile(x.file, x.args, { env, timeout: 15000, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});
class Accounts {
  constructor({ file, home = process.env.HUB_AI_HOME || os.homedir(), dry = false, busy = () => false, execute = run, trash = process.env.HUB_TRASH || path.join(home, '.Trash') }) {
    Object.assign(this, { file, home, dry, busy, execute, trash }); this.locks = new Set(); this.readers = new Map();
    this.termDir = path.join(path.dirname(file), 'account-processes');
    this.base = path.join(home, '.hub-accounts');
  }
  read() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8')).accounts;
      if (!Array.isArray(rows) || rows.some(r => !AIS.includes(r.ai) || !ID.test(r.id) || r.id === 'default' || r.dir !== this.dir(r.ai, r.id) || typeof r.name !== 'string') || new Set(rows.map(r => r.ai + ':' + r.id)).size !== rows.length) fail(lt('アカウント台帳の形式が不正です'));
      return rows;
    } catch (e) { if (e.code === 'ENOENT') return []; fail(lt('アカウント台帳を読み取れません'), 500); }
  }
  save(rows) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts: rows }, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  dir(ai, id) { return path.join(this.base, ai, id); }
  get(ai, id = 'default') {
    if (!AIS.includes(ai)) { if (ai === 'agy' && id === 'default') return { ai, id, name: lt('既定（今のログイン）'), dir: '' }; fail(lt('Claude Code・Codex・Grokを選んでください')); }
    if (id === 'default') return { ai, id, name: lt('既定（今のログイン）'), dir: '' };
    if (!ID.test(id)) fail(lt('アカウントが不正です'));
    const row = this.read().find(r => r.ai === ai && r.id === id); if (!row) fail(lt('アカウントが見つかりません。選び直してください'), 409);
    noLinks(row.dir);
    if (!fs.existsSync(row.dir)) fail(lt('アカウントの保存場所が見つかりません'), 409);
    return row;
  }
  env(ai, id = 'default', env = process.env) {
    const row = this.get(ai, id), out = { ...env };
    if (id !== 'default') {
      for (const key of unsetKeys(out)) delete out[key];
      if (ai === 'grok') for (const key of GROK_AUTH_ENV) delete out[key];
      out[ai === 'grok' ? 'GROK_HOME' : ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = row.dir;
    }
    return childEnv(ai, out);
  }
  location(ai, id = 'default') {
    const r = this.get(ai, id);
    if (ai === 'agy') return path.join(this.home, '.gemini', 'antigravity-cli');
    if (ai === 'grok') return r.dir || process.env.GROK_HOME || path.join(this.home, '.grok');
    return r.dir || (ai === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || path.join(this.home, ai === 'claude' ? '.claude' : '.codex');
  }
  available(ai, id = 'default') { this.get(ai, id); if (this.locks.has(ai + ':' + id) || this.terminalBusy(ai, id, true)) fail(lt('このアカウントのログアウト・削除を処理中です'), 409); }
  terminalBusy(ai, id, authOnly = false) {
    let files = []; try { files = fs.readdirSync(this.termDir); } catch (e) { if (e.code !== 'ENOENT') return true; }
    for (const f of files) {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(this.termDir, f), 'utf8'));
        if (row.ai !== ai || row.account !== id || authOnly && row.kind !== 'auth') continue;
        if (!Number.isInteger(row.pid) || row.pid < 1) return true;
        try { process.kill(row.pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') return true; }
      } catch { return true; }
    }
    return false;
  }
  // 外部Terminalを開く前から保護し、CLI終了時に札を外す。再起動後も生存PIDを照合する。
  terminalCommand(ai, account, command, sq, kind = 'work') {
    if (this.dry) return { command, cancel() {} };
    this.get(ai, account); noLinks(this.termDir); fs.mkdirSync(this.termDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.termDir, randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify({ ai, account, kind, pid: process.pid }), { mode: 0o600 });
    const prefix = JSON.stringify({ ai, account, kind }).slice(0, -1) + ',"pid":';
    const script = `printf '%s%s%s' ${sq(prefix)} "$$" '}' > ${sq(file)}; trap ${sq('unlink ' + sq(file))} EXIT; ${command}`;
    return { command: '/bin/bash -c ' + sq(script), cancel: () => { fs.unlinkSync(file); } };
  }
  assertIdle(ai, id) {
    this.available(ai, id);
    if (this.readers.get(ai + ':' + id) || this.busy(ai, id) || this.terminalBusy(ai, id)) fail(lt('このアカウントでAIが作業中または順番待ちです。終了してから操作してください'), 409);
  }
  list() { return [...AIS.flatMap(ai => [this.get(ai), ...this.read().filter(r => r.ai === ai)]), this.get('agy')].map(r => ({ ...r, busy: Boolean(this.busy(r.ai, r.id)) || this.terminalBusy(r.ai, r.id) || this.locks.has(r.ai + ':' + r.id) })); }
  add(ai, name) {
    if (!AIS.includes(ai)) fail(lt('Claude Code・Codex・Grokを選んでください'));
    name = this.name(name);
    const rows = this.read(), id = randomUUID(), dir = this.dir(ai, id);
    noLinks(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.base, 0o700); fs.chmodSync(path.dirname(dir), 0o700); fs.chmodSync(dir, 0o700);
    try {
    const source = this.location(ai);
    const copy = file => { const from = path.join(source, file); if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(dir, file)); fs.chmodSync(path.join(dir, file), 0o600); } };
    if (ai !== 'grok') copy(ai === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
    if (ai === 'claude') {
      const from = path.join(source, 'settings.json');
      if (fs.existsSync(from)) {
        const settings = JSON.parse(fs.readFileSync(from, 'utf8'));
        // env・hooks・認証/API provider設定は新しいアカウントへ持ち込まない。
        const allowed = ['permissions', 'language', 'theme', 'outputStyle', 'effortLevel', 'alwaysThinkingEnabled', 'respectGitignore', 'plansDirectory'];
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(Object.fromEntries(allowed.filter(k => k in settings).map(k => [k, settings[k]])), null, 2), { mode: 0o600 });
      }
    } else if (ai === 'codex') {
      // 会話・認証・任意のproviderやMCPの秘密を複製せず、一般的な設定だけ引き継ぐ。
      let config = ''; try { config = fs.readFileSync(path.join(source, 'config.toml'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const root = config.split(/^\s*\[/m)[0];
      const allowed = /^(model|model_reasoning_effort|model_auto_compact_token_limit|model_auto_compact_token_limit_scope|approval_policy|sandbox_mode|personality)\s*=/;
      const prefs = root.split('\n').filter(l => allowed.test(l.trim())).join('\n');
      fs.writeFileSync(path.join(dir, 'config.toml'), prefs + '\ncli_auth_credentials_store = "file"\n', { mode: 0o600 });
    }
    const row = { ai, id, name, dir }; this.save([...rows, row]); return row;
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  }
  name(v) { if (typeof v !== 'string' || !v.trim() || v.trim().length > 60 || /[\x00-\x1f]/.test(v)) fail(lt('名前は1〜60文字で入力してください')); return v.trim(); }
  rename(ai, id, name) { if (id === 'default') fail(lt('既定の名前は変更できません')); this.get(ai, id); const rows = this.read(); this.save(rows.map(r => r.ai === ai && r.id === id ? { ...r, name: this.name(name) } : r)); }
  command(ai, id, action) {
    this.get(ai, id);
    if (ai === 'agy') return { command: ai, args: action === 'status' ? ['models'] : [], env: this.env(ai, id) };
    if (ai === 'grok') return { command: grokCommand(process.env, this.home), args: action === 'status' ? ['models'] : [action], env: this.env(ai, id) };
    const args = ai === 'claude' ? ['auth', action, ...(action === 'status' ? ['--json'] : [])] : action === 'status' ? ['login', 'status'] : action === 'login' ? ['login', '--device-auth'] : ['logout'];
    if (ai === 'codex' && id !== 'default') args.push('-c', 'cli_auth_credentials_store="file"');
    return { command: ai, args, env: this.env(ai, id) };
  }
  async status(ai, id) {
    try { this.available(ai, id); } catch { return { status: 'unknown', message: lt('認証処理中のため確認できません') }; }
    if (ai === 'agy') { const error = agyAccountError(this.home, false); if (error) return { status: error.includes('API の利用設定') ? 'api' : 'unknown', message: lt(error) }; }
    const c = this.command(ai, id, 'status'); if (this.dry) return { status: 'unknown', message: lt('テスト中のため確認していません') };
    const key = ai + ':' + id; this.readers.set(key, (this.readers.get(key) || 0) + 1);
    let r; try { r = await this.execute(c.command, c.args, c.env); }
    finally { const count = this.readers.get(key) - 1; if (count) this.readers.set(key, count); else this.readers.delete(key); }
    if (ai === 'agy') {
      const output = r.stdout + '\n' + r.stderr;
      if (r.error?.code === 'ENOENT') return { status: 'not-installed', message: lt('Agy CLI が未導入です') };
      if (r.error?.killed || r.error?.code === 'ETIMEDOUT') return { status: 'unknown', message: lt('ログイン状態の確認が時間切れになりました') };
      if (!r.error && output.split(/\s+/).includes(AGY_MODEL.id)) return { status: 'logged-in' };
      if (/not (?:logged|signed) in|unauthenticated|please (?:log|sign)[ -]?in|login required|authentication required/i.test(output)) return { status: 'logged-out' };
      return { status: 'unknown', message: lt('ログイン状態を確認できませんでした') };
    }
    if (ai === 'grok') return require('./grok').authStatus(r);
    if (ai === 'claude') {
      try { const d = JSON.parse(r.stdout); return { status: d.loggedIn === true ? (d.authMethod === 'api_key' ? 'api' : 'logged-in') : 'logged-out', email: typeof d.email === 'string' ? d.email.slice(0, 200) : '' }; } catch { return { status: 'unknown', message: lt('ログイン状態を確認できませんでした') }; }
    }
    const s = r.stdout + '\n' + r.stderr;
    if (/Logged in using ChatGPT/i.test(s)) return { status: 'logged-in' };
    if (/Logged in using.*API key/i.test(s)) return { status: 'api', message: lt('APIのログインは対象外です') };
    if (/Not logged in/i.test(s)) return { status: 'logged-out' };
    return { status: 'unknown', message: lt('ログイン状態を確認できませんでした') };
  }
  async logout(ai, id, confirmDefault) {
    if (ai === 'agy') fail(lt('Gemini のログアウトは Terminal で /logout と入力してください'));
    this.assertIdle(ai, id); if (id === 'default' && confirmDefault !== true) fail(lt('既定のログアウトをもう一度確認してください'));
    const key = ai + ':' + id; this.locks.add(key);
    try {
      const c = this.command(ai, id, 'logout'); if (this.dry) return { dry: true, command: c.command, args: c.args };
      const r = await this.execute(c.command, c.args, c.env); if (r.error) fail(lt('ログアウトできませんでした。CLIの状態を確認してください'), 502);
      return { ok: true };
    } finally { this.locks.delete(key); }
  }
  remove(ai, id) {
    if (id === 'default') fail(lt('既定アカウントは削除できません')); this.assertIdle(ai, id);
    const row = this.get(ai, id), rows = this.read(); noLinks(this.trash); fs.mkdirSync(this.trash, { recursive: true });
    const dest = path.join(this.trash, `ProjectHub-account-${ai}-${id}-${Date.now()}`);
    fs.renameSync(row.dir, dest);
    try { this.save(rows.filter(r => r.ai !== ai || r.id !== id)); } catch (e) { fs.renameSync(dest, row.dir); throw e; }
    return { ok: true };
  }
}
module.exports = { Accounts, unsetKeys };
