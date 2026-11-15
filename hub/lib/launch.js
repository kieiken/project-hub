'use strict';
const { FABLE_MODEL, FABLE_LABEL, LEGACY_FABLE_MODEL, LEGACY_FABLE_LABEL } = require('./fable-model');
const { lt } = require('./locale');
// Claude Code / Codex の起動コマンドを組み立てる。フォルダを Finder で開く。
const platform = require('./platform');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WIN = process.platform === 'win32';
const WIN_EXTS = ['.exe', '.cmd', '.bat'];
// 実行ファイルを PATH から探す。Windows は拡張子の無い名前に .exe → .cmd → .bat を補う（npm のシムは .cmd）
function findExe(name, envPath = process.env.PATH, extraDirs = []) {
  if (!name || typeof name !== 'string') return '';
  const ok = f => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  const exts = WIN && !path.extname(name) ? [...WIN_EXTS, ''] : [''];
  if (/[\\/]/.test(name)) return exts.map(e => name + e).find(ok) || '';
  for (const dir of [...String(envPath || '').split(path.delimiter), ...extraDirs]) {
    if (!dir) continue;
    for (const e of exts) { const f = path.join(dir, name + e); if (ok(f)) return f; }
  }
  return '';
}
// spawn / execFile に渡す形にする。Windows の .cmd（npm のシム）は中で呼ぶ本体に展開し、cmd.exe を通さない（引数をそのまま渡すため）
function exeArgv(file, args = [], envPath = process.env.PATH) {
  if (!WIN || !file) return { file, args };
  const ext = path.extname(file).toLowerCase();
  if (!ext) {
    if (!/[\\/]/.test(file)) { const found = findExe(file, envPath); return found ? exeArgv(found, args, envPath) : { file, args }; }
    const sibling = WIN_EXTS.map(e => file + e).find(f => fs.existsSync(f));
    if (sibling) return exeArgv(sibling, args, envPath);
    // 拡張子の無いスクリプト（#! 付き）は Windows では直接動かせないので、その行の解釈系で動かす（node なら自分自身、他は Git for Windows の bash）
    let head = ''; try { head = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]; } catch { return { file, args }; }
    if (!head.startsWith('#!')) return { file, args };
    return /\bnode(?:\.exe)?\b/i.test(head) ? { file: process.execPath, args: [file, ...args] } : { file: gitBash() || file, args: [file, ...args] };
  }
  if (ext === '.exe' || !WIN_EXTS.includes(ext)) return { file, args };
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, args }; }
  const targets = [...text.matchAll(/%~?dp0%?\\([^"\r\n]+?\.(exe|[cm]?js))"/gi)]
    .map(m => ({ target: path.join(path.dirname(file), m[1]), js: m[2].toLowerCase() !== 'exe' }))
    .filter(t => path.basename(t.target).toLowerCase() !== 'node.exe' && fs.existsSync(t.target));
  const t = targets[targets.length - 1]; // npm.cmd は補助 JS（npm-prefix.js）の後に本体（npm-cli.js）が来る
  if (!t) return { file, args };
  return t.js ? { file: process.execPath, args: [t.target, ...args] } : { file: t.target, args };
}
// Preserve native PATH lookup on macOS/Linux; Windows resolves using this request's environment.
function resolveCli(file, args, env = process.env, ai = path.basename(file || '')) {
  if (WIN) return exeArgv(findExe(file, env.PATH) || file, args, env.PATH);
  if (ai === 'claude') file = require('./cli-trust').ensureCliReady(ai, findExe(file, env.PATH) || file);
  return { file, args };
}
// Git for Windows の bash（外部ターミナルとコマンド実行に使う）。他の OS は /bin/bash
function gitBash() {
  if (!WIN) return '/bin/bash';
  if (process.env.HUB_BASH) return process.env.HUB_BASH;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(r => path.join(r, 'Git'));
  const git = findExe('git'); if (git) roots.push(path.dirname(path.dirname(git)));
  return roots.map(r => path.join(r, 'bin', 'bash.exe')).find(f => fs.existsSync(f)) || '';
}
const AIS = ['claude', 'codex', 'agy', 'grok'];
const AI_KEY = { claude: 'claude-code', codex: 'codex', agy: 'agy', grok: 'grok' };
const AI_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Agy CLI', grok: 'Grok' };
const API_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];
const GROK_API_ENV = ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'];
const GROK_AUTH_ENV = ['GROK_AUTH_PATH', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AUTH_PROVIDER_LABEL', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_DEPLOYMENT_KEY', 'GROK_CLI_CHAT_PROXY_BASE_URL'];
function grokCommand(env = process.env, home = process.env.HUB_AI_HOME || os.homedir()) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, 'grok'), fs.constants.X_OK); return 'grok'; } catch { /* 次へ */ }
  }
  const file = path.join(home, '.grok', 'bin', 'grok');
  try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { return 'grok'; }
}
let agyCache = null; // { key, result }：一覧のたびに設定ファイルを読まないため
function agyAccountError(home = process.env.HUB_AI_HOME || os.homedir(), translate = true) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  let key = '';
  try { const st = fs.statSync(file); key = `${file}:${st.mtimeMs}:${st.size}`; } catch (e) { key = `${file}:${e.code}`; }
  if (agyCache && agyCache.key === key) return translate ? lt(agyCache.result) : agyCache.result;
  const result = agyAccountErrorNow(file);
  agyCache = { key, result };
  return translate ? lt(result) : result;
}
function agyAccountErrorNow(file) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (settings.modelProvider && settings.modelProvider !== 'antigravity') return 'Agy が API の利用設定になっています。契約・無料枠のログイン経路を確認してください（Hub は認証を変更しません）';
  } catch (e) { if (e.code !== 'ENOENT') return 'Agy の設定を確認できません。設定ファイルを確認してください'; }
  return '';
}
function agyAccountShell() { return `env ${API_ENV.flatMap(k => ['-u', k]).map(sq).join(' ')} `; }
function childEnv(ai, env) {
  const out = { ...env };
  if (ai === 'agy') for (const key of API_ENV) delete out[key];
  if (ai === 'grok') { for (const key of GROK_API_ENV) delete out[key]; out.GROK_DISABLE_AUTOUPDATER = '1'; }
  return out;
}
let accounts = null;
function setAccounts(value) { accounts = value; }
function accountEnv(ai, account = 'default', env = process.env) {
  if (accounts) return accounts.env(ai, account, env);
  if (account !== 'default') throw Error(lt('アカウント管理が未設定です'));
  return childEnv(ai, env);
}
function accountArgs(ai, account = 'default') { return ai === 'codex' && account !== 'default' ? ['-c', 'cli_auth_credentials_store="file"', '-c', 'model_provider="openai"'] : []; }
function accountShell(ai, account = 'default') {
  if (ai === 'grok') {
    const env = accountEnv(ai, account, {});
    const unset = [...GROK_API_ENV, ...(account !== 'default' ? [...require('./accounts').unsetKeys(process.env), ...GROK_AUTH_ENV] : [])];
    return `env ${[...new Set(unset)].flatMap(k => ['-u', k]).map(sq).join(' ')} 'GROK_DISABLE_AUTOUPDATER=1' ${account !== 'default' ? sq('GROK_HOME=' + env.GROK_HOME) + ' ' : ''}`;
  }
  if (account === 'default') return '';
  const env = accountEnv(ai, account, {}), key = ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  return `env ${require('./accounts').unsetKeys(process.env).flatMap(k => ['-u', k]).map(sq).join(' ')} ${sq(key + '=' + env[key])} `;
}

const DEFAULT_CMD = {
  claude: 'claude --dangerously-skip-permissions',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  agy: 'agy --dangerously-skip-permissions',
  grok: 'grok --always-approve',
};

// 圧縮の開始目安。モデル本来のコンテキスト上限は上書きしない。
const CODEX_CONTEXT_ARGS = Object.freeze([
  '-c', 'model_auto_compact_token_limit=160000',
  '-c', 'model_auto_compact_token_limit_scope="total"',
]);
function accelerationArgs(ai, fast = false) { return ai === 'codex' && fast === true ? ['-c', 'service_tier="fast"'] : []; }
const CONTEXT_RULE = lt('# 長い会話の決まり\n文字数とトークン数は別。160k トークンを目安に作業ファイルと .ai/memory（2000字以内、INDEX.md に1行）へ保存し、180k になる前に圧縮して新しい会話で作業ファイルから再開する。残りが分からない時は区切りごとに保存する。読むのは最新の作業ファイル・要約・必要な箇所だけで、全文の読み直しや長いログの貼り付けはしない。記録は消さない。200k 以内は目安で、厳密には保証できない。');

// 画面の呼び名 → CLI に渡す名前
// ※ 実際の CLI が受け付ける名前と違えば、ここを直すだけでよい
const MODEL_FLAG = {
  // Claude Code は本当のモデル名が分かっているので、それを渡す
  claude: { 'Opus 5.5': 'claude-opus-5-5', [FABLE_LABEL]: FABLE_MODEL, [LEGACY_FABLE_LABEL]: LEGACY_FABLE_MODEL },
  // 6terra は昔の呼び名で GPT-5.6 Terra を指す。GPT-6.1 Terra は現在のモデル一覧から解決する。
  codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol', Astra: 'gpt-6-astra', '6sol': 'gpt-6-sol', '6luna': 'gpt-6-luna', '6terra': 'gpt-5.6-terra' },
  agy: {},
};
// 設定画面で直した名前（_hub/cli-models.json）。空の文字＝モデルを指定しない（CLI の既定を使う）
let overrides = { claude: {}, codex: {} };
let discovered = { claude: {}, codex: {}, agy: {}, grok: {} };
let agyCurrent = [];
let effortCatalog = {};
function setOverrides(o) { overrides = { claude: { ...((o && o.claude) || {}) }, codex: { ...((o && o.codex) || {}) } }; }
function getOverrides() { return overrides; }
function setDiscoveredModels(catalog) {
  effortCatalog = Object.fromEntries(AIS.map(ai => [ai, catalog[ai]?.models || []]));
  discovered = { claude: {}, codex: {}, agy: {}, grok: {} };
  agyCurrent = catalog.agy?.models || [];
  for (const ai of AIS) {
    for (const row of catalog[ai]?.known || catalog[ai]?.models || []) discovered[ai][row.label] = row.id;
  }
}
function agyModelId(model) {
  const id = flagFor('agy', model);
  if (!model || !id || !agyCurrent.some(row => row.id === id)) throw Error(lt('Agy の利用可能なモデルを一覧から選んでください'));
  return id;
}
// 登録済みの呼び名と正式 ID の両方を受け付ける。上書きされた ID は使わない。
function modelNames(ai) {
  return { ...(discovered[ai] || {}), ...(MODEL_FLAG[ai] || {}), ...(overrides[ai] || {}) };
}
function modelLabel(ai, model) {
  const names = modelNames(ai);
  if (Object.prototype.hasOwnProperty.call(names, model)) return model;
  return Object.keys(names).find(label => names[label] && names[label] === model) || model;
}
// 画面の呼び名・正式 ID → CLI に渡す名前（無ければ ''）
function flagFor(ai, model) {
  if (!model) return '';
  if (ai === 'agy') {
    const current = agyCurrent.find(row => row.id === model) || agyCurrent.find(row => row.label === model);
    if (current) return current.id;
  }
  const names = modelNames(ai), label = modelLabel(ai, model);
  return Object.prototype.hasOwnProperty.call(names, label) ? String(names[label] || '') : '';
}
// CLIへ渡す起動設定。実際に応答したモデルの証明とは区別する。
function startupInfo(ai, model, modelFlag = flagFor(ai, model), fast = false) {
  const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ');
  const label = modelLabel(ai, model);
  const setting = (modelFlag ? `${oneLine(label)}（CLI 引数 ${ai === 'grok' ? '-m' : '--model'} ${oneLine(modelFlag)}）` : lt('モデル指定なし（CLI の既定）')) + (ai === 'codex' && fast === true ? lt('・加速ON（Fast）') : '');
  return lt`【この番の起動】Hub がこの番の起動に指定した設定は ${AI_LABEL[ai] || oneLine(ai)}・${setting}。これは起動設定で、実際に応答したモデルの証明ではない。あなた自身にはモデルを確かめる方法がない。起動設定が依頼の指定と一致している場合は、自分で証明できないことだけを理由に停止しない。モデル名を聞かれたら「起動設定：${setting}。自分では確かめられない」と答える。`;
}
const EFFORT_FLAG = {
  claude: { '低': 'low', '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max' },
  codex: { '低': 'low', '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max', 'Ultra': 'ultra' },
  grok: { '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max' },
  agy: {}, // 思考のCLI引数は付けず、選んだモデルIDをそのまま使う。
};

// Legacy Claude Ultra fell back to the CLI default. Keep its effective high setting.
function normalizeEffort(ai, effort) {
  return ['claude', 'claude-code'].includes(ai) && effort === 'Ultra' ? '高' : effort;
}
function effortsFor(ai, model, rows) {
  ai = ai === 'claude-code' ? 'claude' : ai;
  if (ai === 'agy') return ['高'];
  const id = flagFor(ai, model) || model;
  const entry = (rows || effortCatalog[ai] || []).find(r => r.id === id || r.label === model);
  return Object.keys(EFFORT_FLAG[ai] || {}).filter(e => e !== '低' || ai === 'claude' || entry?.efforts?.includes('低'));
}
function effortFlag(ai, effort, model) {
  effort = normalizeEffort(ai, effort);
  if (effort === '低' && !effortsFor(ai, model).includes(effort)) return '';
  return EFFORT_FLAG[ai]?.[effort] || '';
}

// 動いている AI に途中で切り替えを伝える時のコマンド（画面の中で打つのと同じ）
// ※ CLI のコマンドが違えば、ここを直すだけでよい
const SWITCH_CMD = {
  claude: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
  codex: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
  grok: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
};

function switchCommand(ai, field, value, model) {
  const v = field === 'model' ? flagFor(ai, value) : effortFlag(ai, value, model);
  const f = SWITCH_CMD[ai] && SWITCH_CMD[ai][field];
  return v && f ? f(v) : '';
}

function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// シェル用の1行（ターミナルの窓を開く時に使う）
function buildCommand({ ai, dir, prompt, cmd, model, effort, account = 'default', fast = false }) {
  if (ai === 'agy' || ai === 'grok') {
    const argv = buildArgv({ ai, prompt, model, effort, account });
    return `cd ${sq(dir)} && ${ai === 'agy' ? agyAccountShell() : accountShell(ai, account)}${[argv.command, ...argv.args].map(sq).join(' ')}`;
  }
  const base = cmd || DEFAULT_CMD[ai];
  if (!base) throw new Error('unknown ai');
  const args = [...(ai === 'codex' ? CODEX_CONTEXT_ARGS : []), ...accountArgs(ai, account), ...accelerationArgs(ai, fast)];
  const m = flagFor(ai, model);
  const e = effortFlag(ai, effort, model);
  if (m) args.push('--model', m);
  if (e) args.push(...(ai === 'claude' ? ['--effort', e] : ['-c', `model_reasoning_effort=${e}`]));
  return `cd ${sq(dir)} && ${accountShell(ai, account)}${base}${args.map(a => ' ' + sq(a)).join('')} ${sq(prompt)}`;
}

// 画面の中の作業画面用：実行ファイルと引数に分ける（シェルを通さない）
function buildArgv({ ai, prompt, cmd, model, effort, account = 'default', fast = false }) {
  if (ai === 'agy') {
    const id = agyModelId(model);
    return { command: 'agy', args: ['--dangerously-skip-permissions', '--model', id, ...(prompt ? [`--prompt-interactive=${prompt}`] : [])] };
  }
  if (ai === 'grok') {
    const m = flagFor(ai, model), e = EFFORT_FLAG.grok[effort];
    return { command: grokCommand(), args: ['--always-approve', ...(m ? ['-m', m] : []), ...(e ? ['--effort', e] : []), ...(prompt ? [prompt] : [])] };
  }
  const base = (cmd || DEFAULT_CMD[ai] || '').trim().split(/\s+/).filter(Boolean);
  if (!base.length || !['claude', 'codex'].includes(ai)) throw new Error('unknown ai');
  const args = [...base.slice(1), ...accountArgs(ai, account)];
  const m = flagFor(ai, model);
  const e = effortFlag(ai, effort, model);
  if (ai === 'claude') {
    if (m) args.push('--model', m);
    if (e) args.push('--effort', e);
  } else {
    args.push(...CODEX_CONTEXT_ARGS, ...accelerationArgs(ai, fast));
    if (m) args.push('--model', m);
    if (e) args.push('-c', `model_reasoning_effort=${e}`);
  }
  if (prompt) args.push(prompt);
  return { command: base[0], args };
}

const openTerminal = (...args) => platform.openTerminal(...args);
const focusAuthTerminal = (...args) => platform.focusTerminal(...args);
const openFolder = (...args) => platform.openPath(...args);
const revealFile = (...args) => platform.revealPath(...args);
const openUrl = (...args) => platform.openUrl(...args);

module.exports = { WIN, findExe, exeArgv, resolveCli, gitBash, GROK_API_ENV, GROK_AUTH_ENV, grokCommand, accelerationArgs, setAccounts, accountEnv, accountArgs, accountShell, AIS, AI_KEY, AI_LABEL, agyModelId, agyAccountError, agyAccountShell, childEnv, buildCommand, buildArgv, openTerminal, openFolder, revealFile, openUrl, sq, DEFAULT_CMD, CODEX_CONTEXT_ARGS, CONTEXT_RULE, MODEL_FLAG, EFFORT_FLAG, normalizeEffort, effortsFor, effortFlag, SWITCH_CMD, switchCommand, focusAuthTerminal, flagFor, modelLabel, startupInfo, setOverrides, getOverrides, setDiscoveredModels };
