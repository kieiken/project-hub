'use strict';
const { lt } = require("./locale");
// Claude Code / Codex の起動コマンドを組み立てる。フォルダを Finder で開く。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AIS = ['claude', 'codex', 'agy'];
const AI_KEY = { claude: 'claude-code', codex: 'codex', agy: 'agy' };
const AI_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Agy CLI' };
const AGY_MODEL = Object.freeze({ id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' });
const API_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];
let agyCache = null; // { key, result }：一覧のたびに設定ファイルを読まないため
function agyAccountError(home = process.env.HUB_AI_HOME || os.homedir()) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  let key = '';
  try { const st = fs.statSync(file); key = `${file}:${st.mtimeMs}:${st.size}`; } catch (e) { key = `${file}:${e.code}`; }
  if (agyCache && agyCache.key === key) return agyCache.result;
  const result = agyAccountErrorNow(file);
  agyCache = { key, result };
  return result;
}
function agyAccountErrorNow(file) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (settings.modelProvider && settings.modelProvider !== 'antigravity') return lt('Agy が API の利用設定になっています。契約・無料枠のログイン経路を確認してください（Hub は認証を変更しません）');
  } catch (e) { if (e.code !== 'ENOENT') return lt('Agy の設定を確認できません。設定ファイルを確認してください'); }
  return '';
}
function childEnv(ai, env) {
  const out = { ...env };
  if (ai === 'agy') for (const key of API_ENV) delete out[key];
  return out;
}

const DEFAULT_CMD = {
  claude: 'claude --permission-mode acceptEdits',
  codex: 'codex --sandbox workspace-write',
  agy: 'agy --dangerously-skip-permissions',
};

// 圧縮の開始目安。モデル本来のコンテキスト上限は上書きしない。
const CODEX_CONTEXT_ARGS = Object.freeze([
  '-c', 'model_auto_compact_token_limit=160000',
  '-c', 'model_auto_compact_token_limit_scope="total"',
]);
const CONTEXT_RULE = lt('# 長い会話の決まり\n文字数とトークン数は別。160k トークンを目安に作業ファイルと .ai/memory（2000字以内、INDEX.md に1行）へ保存し、180k になる前に圧縮して新しい会話で作業ファイルから再開する。残りが分からない時は区切りごとに保存する。読むのは最新の作業ファイル・要約・必要な箇所だけで、全文の読み直しや長いログの貼り付けはしない。記録は消さない。200k 以内は目安で、厳密には保証できない。');

// 画面の呼び名 → CLI に渡す名前
// ※ 実際の CLI が受け付ける名前と違えば、ここを直すだけでよい
const MODEL_FLAG = {
  // Claude Code は本当のモデル名が分かっているので、それを渡す
  claude: { 'Opus 5.5': 'claude-opus-5-5', 'Fable 5.1': 'claude-fable-5-1' },
  // Codex の /model の一覧（v0.157）に合わせた名前。GPT-6 に Terra は無いので 6terra は GPT-5.6-Terra
  codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol', Astra: 'gpt-6-astra', '6sol': 'gpt-6-sol', '6luna': 'gpt-6-luna', '6terra': 'gpt-5.6-terra' },
  agy: { [AGY_MODEL.label]: AGY_MODEL.id, [AGY_MODEL.id]: AGY_MODEL.id },
};
// 設定画面で直した名前（_hub/cli-models.json）。空の文字＝モデルを指定しない（CLI の既定を使う）
let overrides = { claude: {}, codex: {} };
let discovered = { claude: {}, codex: {} };
function setOverrides(o) { overrides = { claude: { ...((o && o.claude) || {}) }, codex: { ...((o && o.codex) || {}) } }; }
function getOverrides() { return overrides; }
function setDiscoveredModels(catalog) {
  discovered = { claude: {}, codex: {} };
  for (const ai of ['claude', 'codex']) {
    for (const row of catalog[ai]?.known || catalog[ai]?.models || []) discovered[ai][row.label] = row.id;
  }
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
  const names = modelNames(ai), label = modelLabel(ai, model);
  return Object.prototype.hasOwnProperty.call(names, label) ? String(names[label] || '') : '';
}
// CLIへ渡す起動設定。実際に応答したモデルの証明とは区別する。
function startupInfo(ai, model, modelFlag = flagFor(ai, model)) {
  const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ');
  const label = ai === 'agy' && modelFlag === AGY_MODEL.id ? AGY_MODEL.label : modelLabel(ai, model);
  const setting = modelFlag ? lt`${oneLine(label)}（CLI 引数 --model ${oneLine(modelFlag)}）` : lt('モデル指定なし（CLI の既定）');
  return lt`【この番の起動】Hub がこの番の起動に指定した設定は ${AI_LABEL[ai] || oneLine(ai)}・${setting}。これは起動設定で、実際に応答したモデルの証明ではない。あなた自身にはモデルを確かめる方法がない。起動設定が依頼の指定と一致している場合は、自分で証明できないことだけを理由に停止しない。モデル名を聞かれたら「起動設定：${setting}。自分では確かめられない」と答える。`;
}
const EFFORT_FLAG = {
  claude: { '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max', 'Ultra': 'ultra' },
  codex: { '中': 'medium', '高': 'high', '極高': 'xhigh', 'MAX': 'max', 'Ultra': 'ultra' },
  agy: {}, // High はモデル ID に含まれる。別の思考指定で変えない。
};

// 動いている AI に途中で切り替えを伝える時のコマンド（画面の中で打つのと同じ）
// ※ CLI のコマンドが違えば、ここを直すだけでよい
const SWITCH_CMD = {
  claude: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
  codex: { model: m => `/model ${m}`, effort: e => `/effort ${e}` },
};

function switchCommand(ai, field, value) {
  const v = field === 'model' ? flagFor(ai, value) : (EFFORT_FLAG[ai] && EFFORT_FLAG[ai][value]);
  const f = SWITCH_CMD[ai] && SWITCH_CMD[ai][field];
  return v && f ? f(v) : '';
}

function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function as(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// Hub-owned work gets writable access to its cwd and explicitly supplied project ledger only.
// References in prompts remain read only. Native linked sessions do not use this helper.
function scopedArgs(ai, original = [], { dir, writableDirs = [] } = {}) {
  if (!['claude', 'codex'].includes(ai)) return [...original];
  const args = [];
  for (let i = 0; i < original.length; i++) {
    const value = original[i];
    if (/^--(?:dangerously-|allow-dangerously-)/.test(value) || ['--yolo', '--full-auto'].includes(value)) continue;
    if (['--sandbox', '-s', '--permission-mode', '--cd', '-C'].includes(value)) { i++; continue; }
    if (/^--(?:sandbox|permission-mode|cd)=/.test(value)) continue;
    if (value === '--add-dir') { while (i + 1 < original.length && !original[i + 1].startsWith('-')) i++; continue; }
    if (value.startsWith('--add-dir=')) continue;
    if (['-c', '--config'].includes(value) && /^(?:sandbox_mode|sandbox_workspace_write|permissions|permission_profile)(?:[.=]|$)/.test(original[i + 1] || '')) { i++; continue; }
    args.push(value);
  }
  args.push(...(ai === 'codex' ? ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.writable_roots=[]'] : ['--permission-mode', 'acceptEdits']));
  const home = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : path.resolve(os.homedir());
  const broadRoot = actual => actual === path.parse(actual).root || actual === home || actual === '/Volumes' || path.dirname(actual) === '/Volumes';
  let current;
  if (dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error(lt('形式が違います'));
    current = path.resolve(dir);
    try {
      current = fs.realpathSync(current);
      if (!fs.statSync(current).isDirectory()) throw new Error(lt('形式が違います'));
    } catch (error) {
      // Pure command-composition callers may provide an as-yet nonexistent project path.
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (broadRoot(current)) throw new Error(lt('形式が違います'));
  }
  const roots = new Set();
  for (const candidate of writableDirs) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error(lt('形式が違います'));
    const actual = fs.realpathSync(candidate);
    if (!fs.statSync(actual).isDirectory() || broadRoot(actual)) throw new Error(lt('形式が違います'));
    if (actual !== current) roots.add(actual);
  }
  for (const root of roots) args.push('--add-dir', root);
  return args;
}

// シェル用の1行（ターミナルの窓を開く時に使う）
function buildCommand({ ai, dir, prompt, cmd, model, effort, writableDirs }) {
  if (ai === 'agy') {
    const argv = buildArgv({ ai, prompt, model, effort });
    return `cd ${sq(dir)} && env ${API_ENV.flatMap(k => ['-u', k]).map(sq).join(' ')} ${[argv.command, ...argv.args].map(sq).join(' ')}`;
  }
  const base = (cmd || DEFAULT_CMD[ai] || '').trim().split(/\s+/).filter(Boolean);
  if (!base.length || !['claude', 'codex'].includes(ai)) throw new Error('unknown ai');
  const args = scopedArgs(ai, base.slice(1), { dir, writableDirs });
  if (ai === 'codex') args.push(...CODEX_CONTEXT_ARGS);
  const m = flagFor(ai, model);
  const e = effort && EFFORT_FLAG[ai]?.[effort];
  if (m) args.push('--model', m);
  if (e) args.push(...(ai === 'claude' ? ['--effort', e] : ['-c', `model_reasoning_effort=${e}`]));
  return `cd ${sq(dir)} && ${sq(base[0])}${args.map(a => ' ' + sq(a)).join('')} ${sq(prompt)}`;
}

// 画面の中の作業画面用：実行ファイルと引数に分ける（シェルを通さない）
function buildArgv({ ai, prompt, cmd, model, effort, dir, writableDirs }) {
  if (ai === 'agy') {
    if (model && !flagFor(ai, model)) throw new Error(lt('Agy で承認されているモデルは Gemini 3.1 Pro (High) だけです'));
    return { command: 'agy', args: ['--dangerously-skip-permissions', '--model', AGY_MODEL.id, ...(prompt ? [`--prompt-interactive=${prompt}`] : [])] };
  }
  const base = (cmd || DEFAULT_CMD[ai] || '').trim().split(/\s+/).filter(Boolean);
  if (!base.length || !['claude', 'codex'].includes(ai)) throw new Error('unknown ai');
  const args = scopedArgs(ai, base.slice(1), { dir, writableDirs });
  const m = flagFor(ai, model);
  const e = effort && EFFORT_FLAG[ai][effort];
  if (ai === 'claude') {
    if (m) args.push('--model', m);
    if (e) args.push('--effort', e);
  } else {
    args.push(...CODEX_CONTEXT_ARGS);
    if (m) args.push('--model', m);
    if (e) args.push('-c', `model_reasoning_effort=${e}`);
  }
  if (prompt) args.push(prompt);
  return { command: base[0], args };
}

function run(file, args, dry) {
  if (dry) return Promise.resolve({ dry: true, file, args });
  return new Promise((resolve, reject) => {
    execFile(file, args, err => (err ? reject(err) : resolve({ ok: true })));
  });
}

function openTerminal(command, dry) {
  return run('osascript', [
    '-e', `tell application "Terminal" to do script "${as(command)}"`,
    '-e', 'tell application "Terminal" to activate',
  ], dry);
}

function openFolder(p, dry) { return run('open', [p], dry); }
// ファイルは Finder でその場所を開いて選ぶ。URL は Mac の既定のブラウザで開く
function revealFile(p, dry) { return run('open', ['-R', p], dry); }
function openUrl(u, dry) { return run('open', [u], dry); }

module.exports = { AIS, AI_KEY, AI_LABEL, AGY_MODEL, agyAccountError, childEnv, buildCommand, buildArgv, openTerminal, openFolder, revealFile, openUrl, sq, DEFAULT_CMD, CODEX_CONTEXT_ARGS, CONTEXT_RULE, MODEL_FLAG, EFFORT_FLAG, SWITCH_CMD, switchCommand, flagFor, modelLabel, startupInfo, scopedArgs, setOverrides, getOverrides, setDiscoveredModels };
