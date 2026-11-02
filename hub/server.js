'use strict';
const platform = require('./lib/platform');
const { lt, locale, config:localeConfig, configScript, activePack } = require('./lib/locale');
const langpacks = require('./lib/langpack');
const { loadPack } = langpacks;
// Project Hub 第2版：台帳の一覧、画面の中の作業画面、役割・モデル・思考の設定
// 使い方: node server.js  →  http://127.0.0.1:4545
const http = require('http');
const crypto = require('crypto');
const fs = require('./lib/platform/file-io');
const path = require('path');
const os = require('os');
const { StaticFiles, sendEncoded } = require('./lib/static-files');
const { Store, expandHome } = require('./lib/store');
// Resolve the saved language before dependencies create translated constants.
const ROOT = expandHome(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'AI-Workspace'));
// Acquire before any user store, migration or licence is opened. Older releases
// do not implement this lease; trial selection also checks running old servers.
const dataUse = require.main === module ? require('./lib/workspace-use').acquire([ROOT, path.join(os.homedir(), 'Documents', 'freetalk')].filter(p => p === ROOT || fs.existsSync(p))) : null;
if (dataUse) process.once('exit', () => dataUse.release());
const localAuth = new (require('./lib/local-auth').LocalAuth)({ root: ROOT });
const move = new (require('./lib/move').Move)({ root: ROOT, version: require('./package.json').version });
if (require.main === module && move.needsStartup()) {
  module.exports = { move, server: require('./lib/move-boot').serve(move, { port: Number(process.env.HUB_PORT || 4545), version: require('./package.json').version, entry: __filename, auth: localAuth }) };
  return;
}
require('./lib/store').loadMovePathMap(ROOT);
langpacks.setRoot(ROOT);
const license = new (require('./lib/license').License)({ root: ROOT });
const launch = require('./lib/launch');
const roles = require('./lib/roles');
const roleHistory = require('./lib/role-history');
let roleReview;
const extensions = require('./lib/extensions').loadExtensions();
const discussionRuntime = extensions.definition('discussion');
const roleReviewRuntime = extensions.definition('role_review');
const limitEngine = require('./lib/engines/limit-switch')({ getTerminalLimits: () => TerminalLimits, accountFor, getAccounts: () => accounts, getAiTools: () => aiTools, getAppUpdate: () => appUpdate, assertWorkspaceIdle, getBuildHandoffCard: () => buildHandoffCard, getCaptureTerminalLimit: () => captureTerminalLimit, getChat: () => chat, getChats: () => chats, codexFastFor, crypto, getDiscussion: () => discussion, discussionRuntime, expandHome, extensions, fs, getGitSnapshot: () => gitSnapshot, integrationPolicyRequest, launch, license, getLimitEvidence: () => limitEvidence, lt, modelError, getModelView: () => modelView, path, permCmd, record, getRestartControl: () => restartControl, roleReviewRuntime, rolesData, getSessions: () => sessions, setUnread, getStopControl: () => stopControl, getStore: () => store, taskPrompt, getTranscript: () => transcript, getUsage: () => usage, verifyIntegrationAssignmentSend });
let discussion;
const specialMode = require('./public/special-mode');
const { Sessions } = require('./lib/sessions');
const gitw = require('./lib/git');
const transcript = require('./lib/transcript');
const chat = require('./lib/chat');
const start = require('./lib/start');
const { AiTools } = require('./lib/ai-tools');
const { listSkills } = require('./lib/skills');
const { Onboarding } = require('./lib/onboarding');
const { Usage } = require('./lib/usage');
const { ModelLimits } = require('./lib/model-limits');
const { limitIdentity } = require('./lib/limit-route');
const { TerminalLimits, capture: captureTerminalLimit } = require('./lib/terminal-limits');
const { buildHandoffCard, snapshot: gitSnapshot } = require('./lib/handoff-card');
const remoteLib = require('./lib/remote');
const { guidance } = require('./lib/guidance');
const instructions = require('./lib/instructions');
const { AsyncLocalStorage } = require('async_hooks');
let webchat, museDirect;
const webchatActive = (project, task) => Boolean([...(webchat?.busy() || []),...(museDirect?.busy() || [])].some(j => j.project === project && (!task || [j.task, j.parent].includes(task))));

const PORT = Number(process.env.HUB_PORT || 4545);
let conversationHistory;
const historyBusy=(project,task)=>Boolean(conversationHistory?.activeAutos().some(a=>a.project===project&&(!task||a.task===task)&&conversationHistory.organizing(a.project,a.task)));
const DRY = process.env.HUB_DRY_RUN === '1'; // テスト用：実際には起動しない
const stopControl = new (require('./lib/stop-control').StopControl)({dir:path.join(ROOT,'_hub','stop-control')});
const accounts = new (require('./lib/accounts').Accounts)({ file: path.join(ROOT, '_hub', 'accounts.json'), dry: DRY, busy: accountBusy });
launch.setAccounts(accounts);
function limitModels() { return limitEngine.limitModels(); }
const limitEvidence = new ModelLimits(path.join(ROOT, '_hub', 'limits.json'), { models: limitModels,
  creditPolicy: rolesData, creditState: (ai, account) => usage.creditState(ai, account),
  onCreditDecision: (o, decision) => record('credit-priority-decision', o, decision) });
const usage = new Usage({ dry: DRY, accounts, resetFile:path.join(ROOT, '_hub', 'reset-ticket-attempts.json'),
  onReset:account => limitEvidence.clearAccount('codex', account),
  beforeRead: (ai, account) => accounts.available(ai, account), observe: snapshot => {
  try { limitEvidence.observe(snapshot); } catch { /* 保存失敗では直前の保持状態を維持 */ }
} });
// Private role-review requests cannot use paid-credit overrides. Without that
// optional hook, ordinary conversations retain their existing limit policy.
function roleReviewLimit(request) { return limitEngine.roleReviewLimit(request); }
function startCreditCheck(request) { return limitEngine.startCreditCheck(request); }
async function refreshLimitEvidence(request, earlyCreditCheck) { return limitEngine.refreshLimitEvidence(request, earlyCreditCheck); }
const PUBLIC = path.join(__dirname, 'public');
const bootModules=require('./lib/runtime-generation').preload(__filename,{optional:[path.join(__dirname,'lib/license/owner-edition'),path.join(__dirname,'paid')]});
const extensionUI = extensions.uiSource(), extensionCSS = extensions.uiSource('style');
const staticFiles=new StaticFiles({root:PUBLIC,live:process.env.HUB_STATIC_LIVE==='1'});
const ROLES_FILE = path.join(ROOT, '_hub', 'roles.yaml');
const store = new Store(ROOT);
const { Ideas } = require('./lib/ideas');
const { IdeaAPI, isSaveRoute: ideaSaveRoute } = require('./lib/idea-api');
const { IdeaSource, decorate: ideaRows } = require('./lib/idea-source');
const ideas = new Ideas({store,root:ROOT,baseOf});
const ideaSource = new IdeaSource({store,generation:(p,t)=>taskHistory.state(p,t).generation,blocked:()=>Boolean(taskHistory.failure)});
const ideaAPI = new IdeaAPI({ideas,source:ideaSource});
const executionGate = new (require('./lib/execution-gate').ExecutionGate)();
const parallelEngine = require('./lib/engines/parallel')({ getAiTools: () => aiTools, getAppUpdate: () => appUpdate, baseOf, getChats: () => chats, getConversationHistory: () => conversationHistory, executionGate, expandHome, extensions, getFreetalkHistory: () => freetalkHistory, fs, getGithub: () => github, getGithubProject: () => githubProject, getGpt: () => gpt, historyBusy, getIdeaRunner: () => ideaRunner, license, lt, getMaintenance: () => maintenance, path, getProcwatch: () => procwatch, getRemoval: () => removal, getRemovalReview: () => removalReview, getReqCtx: () => reqCtx, getRestartControl: () => restartControl, getSessions: () => sessions, stopControl, store, getTaskIntegrate: () => taskIntegrate, getWebchat: () => webchat, webchatActive });
let ideaRunner, ideaDispatch, ideaLane, ideaRelease, queueRetreat;
const freetalkLib = require('./lib/freetalk');
// DRY_RUN は明示した一時 HOME または隔離 ROOT の中だけを使う。
const freetalk = new freetalkLib.Freetalk(store, DRY ? process.env.HUB_FREETALK_HOME || path.join(ROOT, '_hub/freetalk-home') : os.homedir());
const acceleration = new (require('./lib/acceleration').Acceleration)(path.join(ROOT, '_hub', 'acceleration.json'));
const projectOrder = new (require('./lib/project-order').ProjectOrder)(store);
// 外から使う（iPhone）の設定と、今の要求が外からかどうか（記録に「外から」と印を付けるため）
const remote = new remoteLib.Remote({ file: path.join(ROOT, '_hub', 'remote.json') });
const reqCtx = new AsyncLocalStorage();
const fromRemote = () => Boolean(reqCtx.getStore()?.remote);
const sessions = new Sessions({stopControl});
let restartControl = null, emergencyRestart = null;
let activeRequests = 0;
const queueActions = new Set();
const queueEdit = require('./lib/queue-edit');
const queueEditable = item => item.origin !== 'hub-internal' && !item.automation && !item.readOnly && !item.selectionOnly && !item.limitSwitch && !item.resultsOrganize && !item.integrationAssignment && !item.isolatedReview && !item.integrationReviewRequest;
const queueEngine = require('./lib/engines/queue')({ getDelegateCompletedError: () => DELEGATE_COMPLETED_ERROR, getLogFile: () => LOG_FILE, ROOT, accountFor, accounts, getAiTools: () => aiTools, getAppUpdate: () => appUpdate, assertWorkspaceIdle, autoTick, chat, getChatEnded: () => chatEnded, getChats: () => chats, codexFastFor, crypto, delegateTerminalError, getDiscussion: () => discussion, discussionRuntime, executionGate, getFreetalkHistory: () => freetalkHistory, fs, gitw, getIdeaDispatch: () => ideaDispatch, getIdeaRunner: () => ideaRunner, ideas, getIntegrateAuto: () => integrateAuto, integrationPolicyRequest, integrationReviewPrompt, isolatedReviewDir, launch, license, licenseGuard, limitBackup, capacityBackup, assertCapacityHandoff, limitEvidence, limitIdentity, limitRoutingEnabled, lt, modelError, modelPolicy, getModelView: () => modelView, path, permCmd, queueActions, getQueueRetreat: () => queueRetreat, readLog, record, refreshLimitEvidence, requestAccount, getRestartControl: () => restartControl, getResultsGate: () => resultsGate, getRoleReview: () => roleReview, roleReviewLimit, roleReviewRuntime, roles, rolesData, selectionPrompt, send, specialMode, startDir, stopControl, store, getTaskIntegrate: () => taskIntegrate, taskPrompt, usage, verifyIntegrationAssignmentSend, verifyIntegrationReviewSend, webchatActive, workDir });
const chats = queueEngine.createChatRunner();
queueRetreat = queueEngine.createQueueRetreat();
const { Maintenance } = require('./lib/maintenance');
const emptyLib = require('./lib/empty');
const maintenance = new Maintenance({store,baseOf,busy:id=>{
  const p=store.readProject(id);if(!p)return false;
  if (executionGate.busy(baseOf(p))||discussion?.active(id)||webchatActive(id)||problemResolution.starting.has(id)||historyBusy(id)) return true;
  const all=store.listProjects(), familyIds=require('./lib/work-context').family(p,all).map(q=>q.id);
  const base=fs.realpathSync(baseOf(p));
  if (github.locked(base)) return true;
  const active=[...sessions.list().filter(x=>x.running),...[...chats.running.keys()].map(k=>({project:k.split('\u0000')[0]}))];
  return procwatch.list().some(x=>x.project && (familyIds.includes(x.project)||all.some(q=>q.id===x.project&&fs.realpathSync(baseOf(q))===base))) || active.some(a=>{const q=all.find(x=>x.id===a.project);return q && (familyIds.includes(q.id) || fs.realpathSync(baseOf(q))===base);});
}});
const {Removal}=require('./lib/remove');
const removal=new Removal({store,reviewBusy:id=>removalReview.active(id),locked:id=>{const p=store.readProject(id);return p?maintenance.locked(id):false;},busy:(project,task)=>
  (()=>{const p=store.readProject(project);return p&&executionGate.busy(baseOf(p));})() || discussion?.active(project,task) || webchatActive(project,task) || historyBusy(project,task) || sessions.list().some(x=>x.running&&x.project===project&&(!task||x.task===task)) ||
  [...chats.running.keys()].some(k=>k.split('\u0000')[0]===project&&(!task||k.split('\u0000')[1]===task)) ||
  procwatch.list().some(x=>x.project===project&&(!task||!x.task||x.task===task))});
const removalReview=new (require('./lib/removal-review').RemovalReview)({store,removal,
 pick:()=>{const s=specialMode.pick(modelView.special(),rolesData(),'チェック');return s?{owner:launch.AI_KEY[s.ai],model:s.model,effort:s.effort}:null;},
 busy:(p,t)=>webchatActive(p,t)||Boolean(chats.busy(p,t)),queued:(p,t)=>chats.queue(p,t).length>0,
 rows:(p,t)=>{const dir=store.readProject(p)?.dir;return dir?chat.read(dir,t):[];},
 start:async o=>{
  const p=store.readProject(o.project),t=p.tasks.find(t=>t.id===o.task),ai=t.owner==='codex'?'codex':'claude',account=requestAccount(p,t.id,ai);
  const model=t.model || 'claude-fable-5-1',invalid=modelError(ai,model);if(invalid)throw Error(invalid);
  const turn={...o,ai,model,account,effort:t.effort || '高',role:'チェック',requireModel:true,requiredModel:launch.flagFor(ai,model),
   basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')};
  chats.enqueue(p.id,t.id,{...turn,id:o.request});
  try{const r=await chats.sendQueued(turn);chats.unqueue(p.id,t.id,o.request);return r;}
  catch(e){chats.unqueue(p.id,t.id,o.request);throw e;}
 }});
const aiTools = new AiTools({ root: ROOT, dry: DRY, busy: ai => sessions.list().filter(x => x.running && (!ai || x.ai === ai)).length + [...chats.running.values()].filter(x => !ai || x.ai === ai).length + procwatch.list().filter(x => x.project && (!ai || !x.ai || x.ai === ai)).length + Number(accounts.terminalBusy(ai)) });
aiTools.canOperate = () => restartControl?.committed ? lt('再起動を開始しています') : taskIntegrate.active || integrateAuto.active ? lt('統合の処理が進行中です') : appUpdate.applying() || appShell.rebuilding ? lt('Hubの更新が進行中です') : '';
parallelEngine.installTerminal();
const aiUpdates = new (require('./lib/ai-updates').AiUpdates)({ tools: aiTools, accounts, root: ROOT, onCatalog: applyModelCatalog });
const onboarding = new Onboarding({ root: ROOT, home: aiTools.home, tools: aiTools,
  projects: () => store.listProjects(), terminal: () => sessions.available(), dry: DRY });
function applyModelCatalog() {
  const catalog = aiTools.catalog();
  launch.setDiscoveredModels(catalog);
  roles.setModelCatalog(catalog);
}
applyModelCatalog();

// 版：起動した時の番号と、ファイル上の番号（更新を取り込むと変わる）
const PKG = path.join(__dirname, 'package.json');
// 版の番号：package.json が変わっていなければ読み直さない（一覧のたびに読んでいた）
let pkgSeen = null;
const readVersion = () => {
  try {
    const st = fs.statSync(PKG), key = `${st.mtimeMs}:${st.size}`;
    if (!pkgSeen || pkgSeen.key !== key) pkgSeen = { key, version: JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '' };
    return pkgSeen.version;
  } catch (e) { return ''; }
};
const VERSION = readVersion();
const BOOT_HEAD=gitw.savedHead(__dirname)||null;
const HUB_INSTANCE = crypto.randomUUID();
localAuth.instance = HUB_INSTANCE;
function changelog(n) {
  let text = '';
  const pack = activePack(['docs']);
  try { text = fs.readFileSync(pack ? path.join(pack.directory, 'docs', 'CHANGELOG.md') : path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^([\d.]+)\s*（?([^）]*)）?/);
    out.push({ version: m ? m[1] : head.trim(), date: m ? m[2] : '', items: rest.filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim()) });
    if (out.length >= n) break;
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };

function stepSummary(steps) {
  return {total:steps.length,done:steps.filter(s=>s.done).length,next:steps.find(s=>!s.done)||null,
    marks:steps.map(s=>s.done?'1':'0').join(''),version:crypto.createHash('sha256').update(JSON.stringify(steps)).digest('hex')};
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// このパソコンの画面からの操作だけ受け付ける
function allowed(req) {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
  return req.headers['x-hub'] === '1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// 操作の記録（_hub/log.jsonl に1行ずつ）。1MB を超えたら log.old.jsonl に回す
const LOG_FILE = path.join(ROOT, '_hub', 'log.jsonl');
function record(action, b, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'));
    const row = { at: new Date().toISOString(), action, project: b.project, task: b.task, ai: b.ai || b.to, ...(extra || {}), ...(fromRemote() ? { remote: true } : {}) };
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch (e) { /* 記録できなくても操作は続ける */ }
}
function integrationFailure(b,e,phase){
  // Log only typed fields, including on invalid requests. Logging must never
  // replace the original rejection, even if projection or recording fails.
  try {
    const text=(value,fallback='')=>typeof value==='string'&&value?value:fallback;
    const targets=Array.isArray(b?.selected)?b.selected.filter(x=>x&&typeof x.project==='string'&&typeof x.task==='string').map(x=>({project:x.project,task:x.task})):[];
    const paths=Array.isArray(e?.paths)?e.paths.filter(x=>typeof x==='string'):[];
    record('integrate-failed',{project:text(b?.project),task:text(b?.task)},{phase:text(phase,'unknown'),stage:text(e?.stage,'refresh'),code:text(e?.code,'INTEGRATION_REJECTED'),reason:text(e?.message,'統合を開始できません').slice(0,1000),targets,paths});
  } catch (err) { /* 記録の失敗で元の拒否応答を変更しない */ }
}
function readLog(n, file = LOG_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}

// 受け取ったファイルの置き場：AI-Workspace/Inbox/hub/<日付>/<時刻>-<名前>（場所に空白が入らないように）
const MAX_UPLOAD = 50 * 1024 * 1024;
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function saveUpload(name, data) {
  const d = new Date(), z = x => String(x).padStart(2, '0');
  const day = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
  const time = `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const safe = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const dir = path.join(ROOT, 'Inbox', 'hub', day);
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, `${time}-${safe}`), i = 1;
  while (fs.existsSync(f)) f = path.join(dir, `${time}-${i++}-${safe}`);
  fs.writeFileSync(f, data);
  return f;
}

// CLI に渡すモデル名（設定画面で直せる）。空の文字＝モデルを指定しない（CLI の既定）
const CLI_MODELS = path.join(ROOT, '_hub', 'cli-models.json');
function loadCliModels() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(CLI_MODELS, 'utf8')); } catch (e) { o = {}; }
  // 4.5.1 までに「断られたので渡さない」と自動で覚えた空の名前は、推測した名前へのものなので消す（1回だけ）
  if (o && !o.v && Object.keys(o).length) {
    for (const ai of launch.AIS) for (const [k, v] of Object.entries(o[ai] || {})) if (v === '') delete o[ai][k];
    o.v = 2;
    try { fs.writeFileSync(CLI_MODELS, JSON.stringify(o, null, 2)); } catch (e) { /* 書けなくても続ける */ }
  }
  launch.setOverrides(o);
}
function saveCliModels(o) { fs.mkdirSync(path.dirname(CLI_MODELS), { recursive: true }); fs.writeFileSync(CLI_MODELS, JSON.stringify({ ...o, v: 2 }, null, 2)); loadCliModels(); }
loadCliModels();
// 候補：CLI 自身の設定から、実際に使えそうなモデル名を集める
function cliModelHints() {
  const home = process.env.HUB_AI_HOME || os.homedir();
  const catalog = aiTools.catalog();
  const out = { claude: new Set(catalog.claude.models.map(x => x.id)), codex: new Set(catalog.codex.models.map(x => x.id)), agy: new Set(catalog.agy.models.map(x => x.id)), grok: new Set(catalog.grok.models.map(x => x.id)) };
  try { const m = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m); if (m) out.codex.add(m[1]); } catch (e) { /* 無い */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); if (j.model) out.claude.add(j.model); } catch (e) { /* 無い */ }
  return { claude: [...out.claude], codex: [...out.codex], agy: [...out.agy], grok: [...out.grok] };
}

function rolesData() { return roles.read(ROLES_FILE).data; }
function limitRoutingEnabled() { return limitEngine.limitRoutingEnabled(); }
function executionRoles() {
  const raw = rolesData(), mode = modelView.special();
  return mode.enabled ? { ...raw, specialMode: mode, roles: raw.roles.map(r => ({ ...r,
    main: { ...specialMode.pick(mode, raw, r.name), ai: launch.AI_KEY[mode.ai] } })) } : raw;
}

function delegateTerminalError(project, task) {
  const terminals = sessions.list().filter(s => s.project === project && s.task === task && s.running);
  if (!terminals.length) return '';
  const names = [...new Set(terminals.map(s => launch.AI_LABEL[s.ai] || s.ai))].join('・');
  return lt`この作業のターミナルで AI（${names}）が動いているため、委任できません。人に「この作業の作業画面で［ターミナル］に切り替え、${names}の欄の［停止］を押してから、会話でもう一度頼んでください」と案内してください。会話画面の［停止］は押させない（待っている指示も取り消されます）。裏で別の CLI を起動したり、この依頼を繰り返し送ったりしないでください。`;
}

function limitBackup(o, reason) { return limitEngine.limitBackup(o, reason); }
async function capacityBackup(o) { return limitEngine.capacityBackup(o); }
function assertCapacityHandoff(o) { return limitEngine.assertCapacityHandoff(o); }
// ChatGPT アプリ・Codex の設定ファイル（~/.codex/config.toml）に、Hub の MCP が登録されているか
const CODEX_CONFIG = () => path.join(process.env.HUB_AI_HOME || os.homedir(), '.codex', 'config.toml');
const MCP_BLOCK = () => lt`\n# Project Hub の道具（作業を読む・結果を書き戻す）。Hub を起動しておくこと\n[mcp_servers.project-hub]\ncommand = "node"\nargs = ["${path.join(__dirname, 'mcp.js').split(path.sep).join('/')}"]\n`;
function codexMcpStatus() {
  let text = '';
  try { text = fs.readFileSync(CODEX_CONFIG(), 'utf8'); } catch (e) { return { registered: false, configFile: CODEX_CONFIG(), configExists: false }; }
  return { registered: /^\s*\[mcp_servers\.project-hub\]/m.test(text), configFile: CODEX_CONFIG(), configExists: true };
}
function codexMcpRegister() {
  const file = CODEX_CONFIG();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { error: lt`設定ファイルを読めません：${file}` }; }
  if (/^\s*\[mcp_servers\.project-hub\]/m.test(text)) return { file, added: false };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().slice(0, 10)}`); // 念のため前の内容を残す
    fs.writeFileSync(file, text.replace(/\s*$/, '') + (text ? '\n' : '') + MCP_BLOCK());
  } catch (e) { return { error: lt`設定ファイルに書けません：${e.message}` }; }
  return { file, added: true };
}
// 表示・非表示と順番を同じ設定へ、互いを保って保存する。
const modelView = new (require('./lib/model-view').ModelView)(path.join(ROOT, '_hub', 'model-view.json'));
const hiddenModels = () => modelView.hidden();
const problemResolution = new (require('./lib/problem-resolution').ProblemResolution)({
  store, maintenance, pick: () => specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial(),
  validate: pick => { if (aiTools.isOperating(pick.ai)) throw Error(lt('AI の更新・モデル再取得が進行中です')); const error = modelError(pick.ai, pick.model); if (error) throw Error(error); },
  active: (project, task) => removal.busy(project, task) || chats.busy(project, task),
  start: body => quickStart(body, true)
});

// 未読：見ていない間に AI の作業が終わった作業（_hub/unread.json に「プロジェクト\0作業」で残す）
const UNREAD_FILE = path.join(ROOT, '_hub', 'unread.json');
const unread = new Set((() => { try { return [].concat(JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8')).items || []).map(String); } catch (e) { return []; } })());
function saveUnread() {
  try { // 書きかけを読まないよう、別の名前に書いてから置き換える
    fs.mkdirSync(path.dirname(UNREAD_FILE), { recursive: true });
    const tmp = `${UNREAD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: [...unread] }, null, 2));
    fs.renameSync(tmp, UNREAD_FILE);
  } catch (e) { /* 書けなくても続ける */ }
}
function setUnread(project, task, on) {
  const k = `${project}\u0000${task}`;
  if (!project || !task || on === unread.has(k)) return;
  if (on) unread.add(k); else unread.delete(k);
  saveUnread();
}
function pruneUnread() {
  if (require('./lib/unread').removeMissing(unread, store.product)) saveUnread();
}
// 会話の1回分が終わった時：誰も会話画面を見ていなければ未読にする
const chatEnded = (project, task) => { if (!(chats.watchers.get(chats.key(project, task))?.size > 0)) setUnread(project, task, true); };
// 作業画面（端末）が終わった時：見ている画面が無く、人が止めたのでなければ未読にする
function terminalLimitNotice(o, text) { return limitEngine.terminalLimitNotice(o, text); }
function terminalPendingFile(p, t) { return limitEngine.terminalPendingFile(p, t); }
function terminalPending(p, t) { return limitEngine.terminalPending(p, t); }
function saveTerminalPending(p, t, data) { return limitEngine.saveTerminalPending(p, t, data); }
function terminalBusy(p, t, exceptAI) { return limitEngine.terminalBusy(p, t, exceptAI); }
async function terminalLimitHandoff(o, src) { return limitEngine.terminalLimitHandoff(o, src); }
const { terminalLimits, terminalLimitTimer } = limitEngine.installTerminal();

// ChatGPT との連携：mcp.js から /api/mcp/* で呼ばれる道具。報告は会話画面にも流し、未読にする
// 子プロジェクトの結果を親へ渡す（親の受け取る作業に書き、会話に流し、未読にする）。失敗しても元の操作は続ける
const handoff = require('./lib/handoff');
function reportChild(child, kind, text) {
  try { return handoff.reportToParent(store, child, { kind, text }, { record, unread: chatEnded, emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }) }); }
  catch (e) { console.log(lt`[親への報告] ${e.message}`); return false; }
}
// 背景AIの終了は、対応する未完了作業だけを未読にする。
// cwdの一致は古い完了作業を指す場合がある。不明な作業を先頭の作業で補わない。
const procwatch = require('./lib/procwatch').create({ projects: () => store.listProjects(), baseOf });
procwatch.onChange((list, { removed }) => {
  for (const x of removed) {
    if (!x.project) continue;
    let task = null;
    try { task = store.listProjects().find(p => p.id === x.project)?.tasks.find(t => t.id === x.task && t.state !== '完了')?.id; } catch (e) { /* 読めない時は通知先を推測しない。 */ }
    if (task) setUnread(x.project, task, true);
    record('bgended', { project: x.project, task: x.task || null, ai: x.ai }, { pid: x.pid, notified: Boolean(task) });
  }
});
const gpt = new (require('./lib/chatgpt').Chatgpt)({ file: path.join(ROOT, '_hub', 'chatgpt.json'), store, chat, baseOf, record,
  emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }), ended: (project, task) => chatEnded(project, task) });

gpt.gptChildren = new (require('./lib/gpt-children').GptChildren)({ store, chat, baseOf, workRoot: p => path.join(ROOT, 'Work', p.id), record,
  emitRow: gpt.emitRow, ended: gpt.ended, assertIdle: (p, t, owner) => {
    if (chats.queue(p.id, t.id).length) { const e = Error(lt('AI・整理・確認が動いています')); e.status = 409; throw e; }
    assertWorkspaceIdle(p, t, false, false, owner, true);
  } });
webchat = extensions.create('webchat', { root: ROOT, gpt, store, chat, admit:action=>chats.withStrictHandoff(action), assertIdle: assertConversationIdle, onSettled: dispatchAfterWebchat,
  onReply: (p,t,row) => {
    if (p.kind !== 'freetalk' && row.asks?.length) {
      try { store.updateTask(p.id,t.id,{state:'返事待ち',question:row.asks.map(a=>a.question).filter(Boolean).join(' / ').slice(0,300)}); }
      catch(e) { record('webchat-metadata-error',{project:p.id,task:t.id},{error:e.message}); }
    }
  }, changed: () => {
  for (const j of webchat?.jobs || []) for (const task of new Set([j.task, j.parent].filter(Boolean))) chats.emit(j.project, task, { type: 'webchat' });
} });
// Conversations need a stable history and exclusive turn, not a clean Git tree.
function licenseGuard(options, stage = 'start') { return parallelEngine.licenseGuard(options, stage); }
chats.licenseGuard = licenseGuard;
sessions.licenseGuard = licenseGuard;
webchat.licenseGuard = licenseGuard;
webchat.stopControl = stopControl;
webchat.licensePrepare = () => { void license.prepare(); };
function assertConversationIdle(p, t, owner, handoffErrors) { return parallelEngine.assertConversationIdle(p, t, owner, handoffErrors); }
async function dispatchAfterWebchat(j) { return queueEngine.dispatchAfterWebchat(j); }
const github = require('./lib/github').createGithub({ settingsFile: path.join(ROOT, '_hub', 'github.json'), dry: DRY,
  idle: p => {
    assertWorkspaceIdle(p, { workspaceMode: 'isolated' }, false, true);
    const canonical = d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const base = canonical(baseOf(p));
    const githubFolder = p.githubFolder ? canonical(p.githubFolder) : base;
    const all = store.listProjects();
    const active = [...sessions.list().filter(s => s.running), ...[...chats.running.keys()].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }), ...procwatch.list()];
    if (active.some(a => {
      const q = all.find(x => x.id === a.project); if (!q) return false;
      const qbase = canonical(baseOf(q)); if (qbase !== base && qbase !== githubFolder) return false;
      const t = q.tasks.find(x => x.id === a.task);
      return !t || t.workspaceMode === 'direct' || !t.workdir || [qbase, githubFolder].includes(canonical(expandHome(t.workdir)));
    })) { const e = Error(lt('同じ本体でAIが作業中です。終わってから作ってください')); e.status = 409; throw e; }
  }
});
const githubProject = p => ({ ...p, base: baseOf(p) });
// Only mapped project AI can affect this Hub; unrelated app helpers stay alive independently.
// queue() reloads saved requests too, including the permanent freetalk project.
const appShell = new (require('./lib/app-shell').AppShell)({ hub: __dirname, dry: DRY });
const updateBlockers = () => {
  const all=store.listProjects(),out=[];
  const add=(kind,project,task,message)=>{
    const p=all.find(p=>p.id===project),t=p?.tasks.find(t=>t.id===task);
    const label=p ? p.name+(t ? '／'+t.title : '') : project||'';
    out.push({kind,project:project||'',task:task||'',message:label ? label+'：'+message : message});
  };
  for(const j of webchat?.busy() || []) add('webchat',j.project,j.task,lt('Chat／Proの自動送信が進行中です'));
  for(const j of museDirect?.busy() || []) add('muse',j.project,j.task,lt('Museへの送信と結果の受信が進行中です'));
  if(webchat?.control)add('webchat-control','','',lt('Chat／Proの操作が進行中です'));
  if(appShell.rebuilding)add('rebuild','','',lt('アプリの作り直しが進行中です'));
  if(aiTools.isOperating())add('cli','','',lt('AI CLIの操作が進行中です'));
  for(const x of sessions.list())if(x.running)add('terminal',x.project,x.task,lt('ターミナルのAIが稼働しています'));
  for(const k of chats.running.keys()){const [project,task]=k.split('\0');add('chat',project,task,lt('会話のAIが稼働しています'));}
  for(const x of procwatch.list())if(x.project){add('background',x.project,x.task,lt('関連するAIプロセスが残っています'));out[out.length-1].pid=x.pid;}
  for(const [k,q] of chats.queues)if(q.length){const [project,task]=k.split('\0');add('queue',project,task,lt('順番待ちがあります'));}
  for(const p of all){
    if(historyBusy(p.id))add('history',p.id,'',lt('会話を整理中です'));
    if(problemResolution.starting.has(p.id))add('resolution',p.id,'',lt('問題の整理が進行中です'));
    if(maintenance.locked(p.id))add('maintenance',p.id,'',lt('整理・確認が進行中です'));
    if(github.locked(baseOf(p)))add('github',p.id,'',lt('GitHubの操作が進行中です'));
    for(const t of p.tasks)if(chats.queue(p.id,t.id).length)add('queue',p.id,t.id,lt('順番待ちがあります'));
  }
  return out.filter((x,n)=>{
    if(x.kind==='background'&&(!Number.isSafeInteger(x.pid)||x.pid<=0))return true;
    return out.findIndex(y=>y.kind===x.kind&&y.project===x.project&&y.task===x.task&&(x.kind!=='background'||y.pid===x.pid))===n;
  });
};
const updateRuntimeBusy = () => restartControl?.committed || executionGate.barrier || executionGate.leases.size>0 || discussion?.active() || Boolean(webchat?.busy().length || webchat?.control || museDirect?.busy().length) || appShell.rebuilding || aiTools.isOperating() || sessions.list().some(x => x.running) || chats.running.size > 0 || procwatch.list().some(x => x.project) ||
  store.listProjects().some(p => maintenance.locked(p.id) || github.locked(baseOf(p)));
const updateBusy = (handoffErrors) => restartControl?.committed || taskIntegrate.active || integrateAuto.active || updateRuntimeBusy() || [...chats.queues.values()].some(q => q.length > 0) || store.listProjects().some(p => p.tasks.some(t => chats.queue(p.id, t.id).length > 0)) || (handoffErrors ?? chats.guardErrors()).length>0;
const updateSource = process.env.HUB_UPDATE_SOURCE || '';
// Translation is opt-in and requires an optional pack in the update source.
const translationReady = fs.existsSync(path.join(updateSource, 'hub/lib/locale.js')) && Boolean(loadPack({ dir: path.join(updateSource, 'langpacks/zh-TW'), warn: false }));
const automation = process.env.HUB_AUTO_TRANSLATE === '1' && process.env.HUB_TRANSLATION_FORK && translationReady
  ? require('./lib/app-update-workflow').createAutomation({ root: ROOT, env: process.env }) : {};
const appUpdate = new (require('./lib/app-update').AppUpdate)({ root: ROOT, source: updateSource,
  appPath: process.env.HUB_UPDATE_APP || '', version: VERSION, hubPath: __dirname, license, env: process.env, dry: DRY, busy: updateBusy, ownerEdition: license.owner, ...automation });
appUpdate.strictBusy=()=>chats.withStrictHandoff(()=>updateBusy());
move.strictBusy=()=>chats.withStrictHandoff(()=>move.busy());
move.edition = license.owner ? 'owner' : 'public';
move.busy = () => updateBusy() || appUpdate.running || appUpdate.applying() || activeRequests > 0 || taskHistory.activeWrites.size > 0 || freetalkHistory.activeWrites?.size > 0 || restartBlockers().length > 0;
move.barrier = on => { executionGate.barrier = on; };

let updateRestoreReady = false;
function permCmd(ai) {
  const p = rolesData().permissions || {};
  if (ai === 'agy' || ai === 'grok') return launch.DEFAULT_CMD[ai];
  const v = p[launch.AI_KEY[ai]];
  return typeof v === 'string' && /^(claude|codex)\b/.test(v) ? v : launch.DEFAULT_CMD[ai];
}

// 作業の役割 → いつもの担当（AI・モデル・思考）。作業ファイルに指定があればそちら
function pickSpec(task, ai) {
  const data = rolesData();
  const r = data.roles.find(x => x.name === task.role);
  const slot = r ? (r.main.ai === (launch.AI_KEY[ai]) ? r.main : r.backup.ai === (launch.AI_KEY[ai]) ? r.backup : null) : null;
  // 作業に指定があれば、候補から消えていても別のモデルへ置き換えない。
  const mode = modelView.special();
  const modeSpec = specialMode.pick({ ...mode, ai }, data, task.role);
  const taskModel = task.model && (!mode.enabled || !modelError(ai, task.model)) ? task.model : '';
  const model = launch.modelLabel(ai, taskModel || (slot && slot.model) || modeSpec?.model || '');
  const effort = roles.EFFORTS.includes(task.effort) ? task.effort : (slot && slot.effort) || '';
  return { model, effort: ai === 'agy' ? '高' : effort };
}

function modelError(ai, model) {
  if (ai === 'chatgpt') return chat.CHATGPT_RETIRED;
  model = launch.modelLabel(ai, model);
  if (ai === 'agy') {
    const route = launch.agyAccountError();
    if (route) return route;
    const catalog = aiTools.catalog().agy;
    if (catalog.state === 'failed') return lt('モデル一覧の取得に失敗しています。再取得してから選んでください');
    if (!model) return lt('Agy の利用可能なモデルを一覧から選んでください');
    const id = launch.flagFor(ai, model);
    if (!catalog.models.some(row => row.id === id)) return lt`モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  }
  if (!model) return '';
  if (aiTools.staleModel(ai, model)) return lt`モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  if (Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, model)) return '';
  return launch.flagFor(ai, model) ? '' : lt`モデル「${model}」の CLI 名が分かりません。設定で直してください`;
}

// 作業する場所：作業ファイルの workdir → なければ用意する（Git なら作業用コピー、無ければ保存を始めて本体）
const workRoot = p => path.join(ROOT, 'Work', p.id);
function baseOf(p) {
  const body = p.folders.find(f => f.label === '本体');
  const d = body && expandHome(body.path);
  return d && fs.existsSync(d) ? d : p.dir;
}
function assertWorkspaceIdle(p, t, permitChat, githubOperation = false, gptOwner, gptOperation = false) { return parallelEngine.assertWorkspaceIdle(p, t, permitChat, githubOperation, gptOwner, gptOperation); }
function workDir(p, t) {
  if (p.kind === 'freetalk') { freetalk.verify(); return { dir: freetalk.dir }; }
  const wd = expandHome(t.workdir);
  if (wd && fs.existsSync(wd)) return { dir: wd };
  const pending = taskIntegrate.startTarget(p,t);
  if (pending) return pending;
  const base = baseOf(p);
  if (DRY) return { dir: base };
  try {
    const r = gitw.prepare({ base, workRoot: workRoot(p), taskId: t.id, direct: t.workspaceMode === 'direct' || base === p.dir });
    if (r.worktree) store.updateTask(p.id, t.id, { workdir: r.dir });
    return r;
  } catch (e) {
    return { dir: base, note: lt`作業用コピーを作れなかったため、本体で作業します（${String(e.message || e).split('\n')[0]}）` };
  }
}
function startDir(p,t,permitChat=false) {
  if(discussion?.active(p.id,t.id))throw Error('話し合いが進行中です。停止または完了後に始めてください');
  assertWorkspaceIdle(p,t,permitChat);
  const result=workDir(p,t);
  if(!t.workspaceStarted)store.updateTask(p.id,t.id,{workspaceStarted:new Date().toISOString()});
  return result;
}
const inWork = (p, t) => { const wd = expandHome(t.workdir); const rel = wd && path.relative(workRoot(p), wd); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
// 作業ファイルに作業用コピーの場所が書いてあるのに、その場所が無い（取り込んでゴミ箱へ移した後に、AI が古い内容で書き戻した時など）
const copyMissing = (p, t) => inWork(p, t) && !fs.existsSync(expandHome(t.workdir));
// この作業を本体に取り込んだ記録（いちばん新しいもの）
const lastMerge = (project, task) => require('./lib/integration-log').lastMerge(LOG_FILE, project, task);

const taskTransfer = new (require('./lib/task-transfer').TaskTransfer)({store,removal,baseOf,
  integration:(p,t)=>gitw.integrationReceipt(baseOf(p),lastMerge(p.id,t.id),t),
  notify:(project,task,id)=>{const p=store.readProject(project);const row=p&&chat.read(p.dir,task).find(x=>x.handoff===id||x.offer===id||x.partialReceipt===id);if(row)chats.emit(project,task,{type:'row',row});chatEnded(project,task);}
});
// Display workers receive the record only; its Git validation stays off the HTTP loop.
taskTransfer.integrationRead=(p,t)=>({dir:baseOf(p),record:lastMerge(p.id,t.id),task:t});
const taskIntegrate = new (require('./lib/task-integrate').TaskIntegrate)({store,transfer:taskTransfer,removal,baseOf});
const projectNotes = new (require('./lib/project-notes').ProjectNotes)({store,busy:project=>updateBusy()||maintenance.locked(project)});
const mainMergeTokens=new Map();
const mainMergeDelivery=new (require('./lib/main-merge-delivery').MainMergeDelivery)(ROOT,gitw,LOG_FILE);
let mainMergeFlow;
async function internalResult(call){
  let status,body;const response={writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}};
  await call(response);if(status!==200||!body?.ok)throw Object.assign(Error(body?.error||lt('正式操作の結果を確認できません')),{delivery:body?.delivery});return body;
}
const integrationBlockers = (b,{op,gitState}={}) => {
  if(!['receipt','main-merge'].includes(op))throw Error('統合操作の種類を確認できません');
  if(!b?.project)return [...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])];
  const record=op==='receipt'&&taskIntegrate.read(b.project,b.task,b.id||taskIntegrate.tokens.get(b.token)?.value?.id),all=store.listProjects();
  let selected=b.selected||record&&!require('./lib/task-continuation').closed(record)&&record.items;
  if(!selected&&op==='receipt'){const a=taskIntegrate.ancestor(b.project,b.task,{allowBusy:true});selected=all.flatMap(p=>p.tasks.filter(t=>taskIntegrate.simple.related(a,p,t)).map(t=>({project:p.id,task:t.id})));}
  const p=all.find(p=>p.id===b.project),t=p?.tasks.find(t=>t.id===b.task),target=op==='main-merge'&&t&&(gitState?gitState.target:gitw.mainOf(expandHome(t.workdir)));
  const paths=gitState?gitState.paths:target?gitw.changedBetween(target,gitw.inspect(target,{readOnly:true}).head,gitw.inspect(expandHome(t.workdir),{readOnly:true}).head):[];
  const gatedDirs=[target||t&&(expandHome(t.workdir)||baseOf(p)),...(Array.isArray(selected)?selected:[]).map(c=>{const q=all.find(p=>p.id===c.project),x=q?.tasks.find(t=>t.id===c.task);return q&&(expandHome(x?.workdir)||baseOf(q));})].filter(Boolean);
  const executionWaiting=gatedDirs.some(dir=>executionGate.busy(dir));
  return require('./lib/integration-safety').blockers({op,target,paths,b:{...b,selected},all,baseOf,expand:expandHome,activities:updateBlockers(),global:[
    ...(executionWaiting?[{kind:'execution',message:lt('同じ開発場所の実行・検証・復旧が終わるまで待っています')}]:[]),
    ...(target?mainMergeFlow?.blockers(target)||[]:[]),
    ...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),
    ...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])]});
};
async function integrationBlockersAsync(b,{op}={}){
 if(op!=='main-merge')return integrationBlockers(b,{op});
 const p=store.readProject(b.project),t=p?.tasks.find(t=>t.id===b.task),dir=t&&expandHome(t.workdir);
 const target=dir&&await gitw.mainOfAsync(dir);let paths=[];
 if(target){const main=await gitw.inspectAsync(target),source=await gitw.inspectAsync(dir);if(!main||!source)throw Error('統合対象の保存状態を確認できません');paths=(await gitw.readAsync(target,['diff','--name-only','-z',main.head,source.head])).split('\0').filter(Boolean);}
 return integrationBlockers(b,{op,gitState:{target,paths}});
}
taskIntegrate.consultationWait=b=>integrationBlockers(b,{op:'receipt'});
const integrateAuto=new (require('./lib/integrate-auto').IntegrateAuto)({integrate:taskIntegrate,busy:b=>Boolean(stopControl.held(b)||integrationBlockers(b,{op:'receipt'}).length>0),waitStatus:b=>integrationBlockers(b,{op:'receipt'}),
  dispatch:async request=>{
    let started=false,status,body;
    const res={integrationDelivery:{begin:()=>{started=true;}},writeHead:code=>{status=code;},end:text=>{body=JSON.parse(text);}};
    try{
      const assigned=integrationAssignment(request);
      await delegateRequest(assigned,res,{allowCompleted:Boolean(request.organize),resultsOrganize:Boolean(request.organize),resultsRecovery:Boolean(request.organize),...(request.organize?{beforeStart:()=>taskIntegrate.simple.organizeStart(request)}:{}),preserveTaskState:Boolean(request.organize||request.isolatedReview),isolatedReview:request.isolatedReview===true&&request.role==='チェック',review:request.review,requestKey:request.requestKey,integrationAssignment:assigned.integrationAssignment});
      const delivery={state:status===200&&body?.ok?'accepted':started?'unknown':'not-sent',request:request.requestKey,...(body?.queued&&body.id?{queueId:body.id}:{}),status,at:new Date().toISOString()};
      if(status!==200||!body?.ok)throw Object.assign(Error(body?.error||lt('正式操作の結果を確認できません')),{delivery});
      return {...body,delivery};
    }catch(e){if(!e.delivery)e.delivery={state:started?'unknown':'not-sent',request:request.requestKey,at:new Date().toISOString()};throw e;}
  },
  mergeMain:(r,{begin})=>internalResult(async res=>{
    const p=store.readProject(r.project),t=p?.tasks.find(t=>t.id===r.task);
    if(t&&r.target===baseOf(p))return send(res,200,{ok:true,retained:true,main:r.target});
    if(!t||!inWork(p,t)||expandHome(t.workdir)!==r.target)throw Error(lt('本体取り込みの対象が変わりました'));
    const source=gitw.inspect(r.target),target=gitw.mainOf(r.target),main=target&&require('./lib/integration-writes').inspect(gitw,target);
    if(integrationBlockers(r,{op:'main-merge'}).length||!source||source.status||!main||main.status||main.head!==r.auto.mainHead||gitw.merging(target))throw Error(lt('本体取り込みの前提を確認できません'));
    const req=require('node:stream').Readable.from([Buffer.from(JSON.stringify({project:r.project,task:r.task,disposition:'continue',confirm:true,sourceHead:source.head,targetHead:main.head}))]);
    req.method='POST';req.headers={'x-hub':'1'};res.integrationMain={begin};await api(req,res,new URL('http://localhost/api/task/merge'));
  }),
  notify:r=>{if(r.auto.stopped)integrationFailure({...r,selected:r.items},Object.assign(Error(r.auto.stopped.reason),r.auto.stopped),'tick');const p=store.readProject(r.project);if(!p)return;const text=r.auto.stopped?lt`自動統合を停止しました：${r.auto.stopped.reason}`:r.auto.main?.state==='done'?lt(r.auto.main.skipped?'子作業の受領が完了しました。本体への反映は別に確認してください':'本体に取り込み済み・新しい版を待っています'):lt('統合を自動で続けています');
    const row=chat.append(p.dir,r.task,{role:'event',text});chats.emit(r.project,r.task,{type:'row',row});pruneUnread();}
});
taskIntegrate.validateAssignment=(ai,model)=>{const invalid=modelError(ai,model);if(invalid)throw Error(invalid);};
function integrationPolicyRequest(o){
  const q=o.project&&o.task?chats.queue(o.project,o.task).find(q=>q.id===o.request):undefined;
  return require('./lib/integration-assignment').find(taskIntegrate,o,q);
}
function verifyIntegrationAssignmentSend(o){
  const q=o.project&&o.task?chats.queue(o.project,o.task).find(q=>q.id===o.request):undefined;
  return require('./lib/integration-assignment').verify(taskIntegrate,o,q,taskIntegrate.validateAssignment);
}
function integrationAssignment(request){
  const fixed=require('./lib/integration-assignment').assign(taskIntegrate,request);
  if(fixed){taskIntegrate.validateAssignment(fixed.ai,fixed.model);return fixed;}
  const b=require('./lib/integration-delivery').assignment(request,executionRoles()),role=rolesData().roles.find(r=>r.name===b.role);
  if(!modelView.special().enabled&&role?.main.ai!==launch.AI_KEY[b.ai])throw Error(lt('role は指定した AI が主担当の役割を選んでください'));
  const invalid=modelError(b.ai,b.model);if(invalid)throw Error(invalid);
  if(!launch.flagFor(b.ai,b.model))throw Error(lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません'));
  return b;
}
integrateAuto.probeRequest=request=>{
  const assigned=integrationAssignment(request),p=store.readProject(request.project),t=p?.tasks.find(t=>t.id===request.task);
  if(!t||t.state==='完了'&&!request.organize)throw Error(DELEGATE_COMPLETED_ERROR);
  if(assigned.integrationAssignment&&limitEvidence.active(requestAccount(p,t.id,assigned.ai),launch.flagFor(assigned.ai,assigned.model)))throw Error('指定した統合担当が上限中です。担当を替えず解除まで待機します');
  if(typeof request.text!=='string'||!request.text.trim()||request.text.trim().length>8000)throw Error(lt('text は1〜8000文字'));
  if(assigned.ai==='grok'&&assigned.effort==='Ultra')throw Error(lt('Grok の思考は 中・高・極高・MAX です'));
  const error=delegateTerminalError(request.project,request.task);if(error)throw Error(error);
  assertWorkspaceIdle(p,t,false);
  if(aiTools.isOperating()||chats.busy(request.project,request.task)||chats.queue(request.project,request.task).length)throw Error(lt('別の依頼が作業中・順番待ちのため成果整理を開始していません'));
  return assigned;
};
integrateAuto.deliveryEvidence=(r,k,a)=>{const c=a.phase==='organize'?a:r,p=store.readProject(c.project);return p?require('./lib/integration-delivery').evidence({pdir:p.dir,task:c.task,logFile:LOG_FILE,k,phase:a.phase,attempt:a,queueFiles:store.listProjects().flatMap(p=>p.tasks.map(t=>path.join(p.dir,'.ai/chat',t.id+'.queue.json')))}):{complete:false,sent:true};};
const integrationAbandon=new (require('./lib/integration-abandon').IntegrationAbandon)({integrate:taskIntegrate,auto:integrateAuto,chats,logFile:LOG_FILE});
integrateAuto.abandon=integrationAbandon;
const integrationConversation=(r,k,phase)=>phase==='organize'?r.auto.attempts[k]:r;
integrateAuto.pendingRequest=(r,k,phase,sourceRequest)=>{const c=integrationConversation(r,k,phase);return chats.pendingIntegration(c.project,c.task,k,phase,sourceRequest);};
integrateAuto.savedCompletion=(r,k,phase)=>{const c=integrationConversation(r,k,phase),p=store.readProject(c.project);return p&&chat.read(p.dir,c.task).findLast(row=>row.role==='assistant'&&row.integrationAuto?.key===k&&row.integrationAuto.phase===phase&&row.integrationAuto.closed===true);};
integrateAuto.questionResolution=(r,k,a,row)=>{const p=store.readProject(r.project),q=require('./lib/integration-question');return p&&q.resolution(q.read(p.dir,r.task),{k,a,row});};
const integrateTimer=setInterval(()=>{void integrateAuto.tick();},60000);integrateTimer.unref();
const resultsGate = new (require('./lib/results-gate').ResultsGate)({store,transfer:taskTransfer,
  blocked:(p,t)=> t.question || ['返事待ち','上限で停止'].includes(t.state) ? lt('質問・返事待ちを先に済ませてください')
    : chats.busy(p.id,t.id) ? lt('AIが作業中です') : chats.queue(p.id,t.id).length ? lt('順番待ちがあります')
    : delegateTerminalError(p.id,t.id) || (removal.busy(p.id,t.id) || removal.locked(p.id) ? lt('AI・整理・確認が動いています') : '')
    || (()=>{const hand=taskTransfer.read(p.id,t.id),batches=taskIntegrate.records(p.id,t.id);
      return hand?.integrating&&!hand.complete || batches.some(batch=>!batch.complete) ? lt('統合が進行中です') : '';})(),
  launch:async(p,t,issue)=>{
    const role=executionRoles().roles.find(r=>r.name==='調査');
    if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定の調査担当を確かめてください'));
    const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await delegateRequest({...taskTransfer.organizeRequest(p,t,issue.reason),role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,
      {allowCompleted:true,resultsOrganize:true,resultsRecovery:true,beforeStart:()=>{
        const current=store.readTask(store.taskFile(p.id,t.id));
        if(current.completionHash!==t.completionHash)throw Error(lt('成果整理の開始前に作業が変わりました'));
      }});
    if(res.status!==200 || res.body?.queued)throw Error(res.body?.error || lt('別の依頼が始まったため成果整理を開始していません'));
  }
});


// iPhone で開くアドレス（Tailscale の Mac の名前）。tailscale が無い・止まっている時は空。1分は覚えておく
let tsCache = { at: 0, url: '' }, tsPending;
function tailscaleUrl() {
  if (Date.now() - tsCache.at < 60000) return Promise.resolve(tsCache.url);
  if (tsPending) return tsPending;
  const { execFile } = require('child_process');
  const bins = platform.tailscaleCandidates();
  const tryAt = i => new Promise(done => {
    if (i >= bins.length) return done('');
    execFile(bins[i], ['status', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return tryAt(i + 1).then(done);
      try { const dns = String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, ''); done(dns ? 'https://' + dns : ''); } catch (e) { done(''); }
    });
  });
  tsPending = tryAt(0).then(u => { tsCache = { at: Date.now(), url: u }; return u; }).finally(() => { tsPending = null; });
  return tsPending;
}
// User delegation guidance is supplied by the optional paid extension.
const TERMINAL_LIMIT_NOTE = lt('ターミナルでもHubが確定上限または新鮮な100%を確認して共通フラグを保持し、元AIの終了を確認してから同じ作業を交代先へ引き継ぐ。自分で別のCLIを起動しない。人の停止では自動交代しない。');
const TERMINAL_HANDOFF_NOTE = lt('あなたはターミナルで動いている。ここからは別の AI に委任できない。渡したい時は、渡す内容と指定モデルを作業ファイルに書いて返事を終える。人には「この作業の作業画面で［会話］に切り替えて、記録した依頼を送ってください」とだけ案内する。ターミナルを止める操作は頼まない（会話から送った依頼が断られた時に、会話側の AI が案内する）。');
const DELEGATE_COMPLETED_ERROR = lt('この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません');
function delegateRule(p,t) { return userDelegate?.policy?.(p,t) || ''; }
// 人が決めた役割とモデル（roles.yaml）。AI が他のファイル（エージェントの設定など）の古い指定に従わないよう、毎回伝える
function modelPolicy(p, t, where = 'chat', projects) {
  // startDir が保存したコピーの場所・手順なども、同じ台帳の最新値で渡す。
  const current = store.readProject(p.id);
  if (current) { p = current; t = current.tasks.find(x => x.id === t.id) || t; }
  const d = rolesData();
  const label = s => (launch.AI_LABEL[s.ai === 'claude-code' ? 'claude' : s.ai] || s.ai);
  const slot = s => { if (!s || s.ai === '人' || !s.model) return ''; const ai=s.ai === 'claude-code' ? 'claude' : s.ai, f=launch.flagFor(ai,s.model), available=aiTools.catalog()[ai]?.models.some(m=>m.id===f); return lt`${label(s)}・${s.model}${f ? `（${f}）` : ''}${available ? '' : '（利用不可：最新の一覧にありません）'}`; };
  const mode = modelView.special();
  const specialPolicy = mode.enabled ? lt`【特殊モード（通常の役割分担より優先）】人が今回の依頼でAI・モデルを直接指定した場合と手動選択した依頼だけ、その指定を優先する。指定がなければ ${launch.AI_LABEL[mode.ai]} を使用し続ける（選択可能なモデル：${(d.models[launch.AI_KEY[mode.ai]] || []).join(' / ')}）。同じAI内のモデル・思考は作業に合わせてAIが選んでよい。別のAIへの切替は人の直接指定がある依頼だけに限る。その依頼が終われば、続きは特殊モードのAIへ戻る。以前の作業ファイルや引用・役割分担のモデル指定は今回の直接指定と見なさない。モデルは設定の選択可能な一覧から選ぶ。新しいCLIは裏で起動せず、モデル変更も同じ作業の委任APIを使う。選んだAIが上限なら待機し、別のAIへ自動交代しない。従量課金・認証変更はしない。` : '';
  const limitPolicy = mode.enabled ? lt('【利用上限の時】特殊モード中は別のAIへ自動交代せず、解除まで待機する。済んだ操作・委任は繰り返さない。') : d.switch.auto === true ? lt('【利用上限の時】Hubが契約CLIの正式上限または新鮮な100%を確認すると共通フラグを保持し、会話とターミナルで同じ作業を交代する。交代時の設定画面「役割分担」に保存した担当・モデル・思考に従う（mainの上限ではbackupへ、backupの上限ではmainへ）。画像生成も保存した交代先へ引き継ぐ。元AIの終了後に引き継ぐ。保持中は解除日時または手動解除まで交代先で開始。両側上限なら往復せず待機。AIは確認不要。本文や引用の「上限」で自分の担当を変えない・止まらない。既定のmainは変えない。済んだ部分と委任を繰り返さず残りを続ける。追加課金・API従量課金は使わない。') : lt('【利用上限の時】自動交代はオフ。自分で別のモデルへ切り替えない。');
  const list = d.roles.map(r => slot(r.main) ? `${roles.label ? roles.label(r.name) : require("./lib/locale").label(r.name)}＝${slot(r.main)}` : '').filter(Boolean).join('、');
  const modelRule = mode.enabled ? specialPolicy : lt`【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】${list}。役割分担で Agy CLI が担当の役割/人の手動選択依頼だけHub確認の最新候補（${aiTools.catalog().agy.models.map(m=>m.label+'（'+m.id+'）').join('、') || '利用可能なモデルなし'}）を使用可。既定の役割は変更しない。claude-opus-4-6 などの古いモデルは使わない。エージェントも担当モデル。`;
  const credits = instructions.creditRule(d);
  const paidModelRule = credits ? modelRule.replace(lt('従量課金・認証変更はしない。'), lt('購入・自動チャージ・APIキー課金・認証変更は禁止。')) : modelRule;
  const paidPolicy = credits ? limitPolicy.replace(lt('追加課金・API従量課金は使わない。'), lt('購入・自動チャージ・APIキー課金は禁止。')) : limitPolicy;
  return `${paidModelRule}\n${paidPolicy}${credits ? '\n' + credits : ''}\n${instructions.WORKFLOW_RULE}\n${delegateRule(p, t)}\n\n${p.kind === 'freetalk' ? '自由対話の会話画面。新しい話題は人が［新しい話題］から作る。手順・完了・統合・取り込みの操作はありません。' : guidance(p, resultsGate.decorate(p,t,projects || store.listProjects()), { where, projects: projects || (t.kind === 'derived' && t.derivedFrom?.includes('/') && !t.derivedFrom.startsWith(p.id + '/') ? store.listProjects() : [p]), copy: inWork(p, t) && !copyMissing(p, t), copyMissing: copyMissing(p, t) })}`;
}

function taskPrompt(p, t, file, dir, where = 'chat', startup, { readIndex = true } = {}) {
  if (p.kind === 'freetalk') return [modelPolicy(p, t, where), freetalk.prompt(p, t)].join('\n\n');
  const issuesRule = lt`【問題点を短くまとめる決まり】PROJECT.md の issues を足す・変える時は、同じプロジェクトの .ai/issues-summary.json も更新する（他プロジェクトには書かない）。保存形式は {"items":[{"hash":"原文のsha256先頭16文字","title":"30字までの問題名","state":"未解決/確認待ち/判断待ち/解決済み/履歴のいずれか","next":"50字までの次の対応（無ければ空）","who":"人/AI/空のいずれか"}]}。原文は文字列ならそのまま、オブジェクトなら text。hash は Node の require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) で計算する（text は原文そのもの。空白・改行を変えない）。問題名と次の対応に作業ID・commit・テスト件数を入れない。新しい状態の項目を足したら、同じ件の古い項目は「履歴」にする。確かめていない事は「確認待ち」にし、不具合・解決と断定しない。原文は消さない。`;
  const rel = dir && path.relative(workRoot(p), dir);
  const copy = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? lt`今いるフォルダ（${dir}）はこの作業専用の作業用コピー。ここだけで作業し、本体には触らないこと（取り込みは人が作業画面の［本体に取り込む］で行う）。`
    : dir ? lt`今いるフォルダ（${dir}）は本体。この作業は作業用コピーを使わず、ここで作業してよい（Hub が本体で作業すると決めた。作業ルールに「作業用コピーの中だけ」とあっても、この作業では本体に保存してよい。作業用コピーを作るよう人に頼まない）。` : '';
  const refs = p.folders.filter(f => /^参考/.test(f.label)).map(f => expandHome(f.path));
  let projects;
  const rels = p.related.map(r => {
    const byId = store.readProject(r);
    if (byId) return byId.dir;
    projects ||= store.listProjects();
    return projects.find(x => x.name === r)?.dir;
  }).filter(Boolean);
  const { family, sourceOf } = require('./lib/work-context');
  const all = projects ||= store.listProjects(), same = family(p, all);
  const source = sourceOf(p,t.derivedFrom,all);
  const sameRefs = same.filter(q=>q.id!==p.id).map(q=>q.dir);
  const context = lt`この作業は${t.kind === 'derived' ? lt('派生作業') : lt('本作業')}。${source ? '派生元の作業ファイル: ' + store.taskFile(source.project.id,source.task.id) + '。' : ''}${sameRefs.length ? '同じ大きなプロジェクト内の参照（読むだけ）: '+sameRefs.join(' / ')+'。' : ''}`;
  const look = refs.length || rels.length ? lt`参考にしてよい場所（読むだけ。書き換えない）: ${[...refs, ...rels].join(' / ')}。` : '';
  if (where !== 'terminal') {
    const taskRaw=fs.readFileSync(file,'utf8'),resumeView=require('./lib/text-budget').summaryView(taskRaw),resumeSummary=resumeView.text;
    const index=readIndex===false?'':require('./lib/task-read-index').taskReadIndex(taskRaw,{task:t.id,summaryIncluded:!!resumeSummary&&!resumeView.incomplete});
    const pastIndex=taskHistory.indexFile(p.id,t.id),past=pastIndex?lt`過去の会話の目次：台帳/${path.relative(p.dir,pastIndex).split(path.sep).join('/')}（全文を読まず、必要な話題だけ開く。根拠は保管先の原文の行番号で確認）\n`:'';
    const read = past+(resumeView.warning?resumeView.warning+'\n':'')+(resumeSummary?lt`最新の再開要約：\n${resumeSummary}\n読む：作業ファイルの最新の再開要約・手順・成果。昔の詳細と保管会話は必要箇所だけ。\n`:'')+lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きを。読む（台帳内）：.ai/rules.md・PROJECT.md・.ai/tasks/${t.id}.md${resumeSummary?'の最新の再開要約・手順・成果（過去全文を読み直さない）':''}。区切りで更新・実施手順のみ[x]（無ければ3〜5個）。workdir・state・questionは書き換えない（Hub管理）。`;
    return instructions.packet({ pdir: p.dir, project: p.id, task: t.id, dynamic: index, roleData: executionRoles(), policy: modelPolicy(p, t, where, all), issues: issuesRule, port: PORT, contextRule: launch.CONTEXT_RULE, askRule: chat.ASK_RULE,
      common: [dir ? `cwd=${dir === p.dir ? '台帳' : '台帳/' + path.relative(p.dir, dir).split(path.sep).join('/')}。${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? lt('作業用コピー限定。本体には触らない（人が［本体に取り込む］）。') : lt('本体。コピーは使わず、ここで作業してよい（Hub指定）。')}` : '', look, context, read,require('./lib/chat-continuation').prompt(p.dir,t.id,PORT)].filter(Boolean).join('\n') });
  }
  const resumeView=require('./lib/text-budget').summaryView(fs.readFileSync(file,'utf8'));
  return [resumeView.text&&lt`最新の再開要約：\n${resumeView.text}`,resumeView.warning,modelPolicy(p, t, where, all), where === 'terminal' ? TERMINAL_HANDOFF_NOTE + '\n' + (modelView.special().enabled ? lt('特殊モード中は別のAIへ自動交代せず、解除まで待機する。') : TERMINAL_LIMIT_NOTE) : '', where === 'terminal' && startup ? launch.startupInfo(startup.ai, startup.model, undefined, codexFastFor(p.id, t.id)) : '', launch.CONTEXT_RULE, copy, look, context, issuesRule,require('./lib/chat-continuation').prompt(p.dir,t.id,PORT), lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きをしてください。${require('./lib/task-history').latest(fs.readFileSync(file,'utf8'))?'作業ファイルは先頭の最新の再開要約・手順・成果から再開し、旧全文や保管会話は必要箇所だけ参照する。':''}まず次の3つを読むこと: ${path.join(p.dir, '.ai', 'rules.md')} / ${path.join(p.dir, 'PROJECT.md')} / ${file}。区切りごとに作業ファイルを更新し、「## 手順」の終わった所を [x] にすること（手順が無ければ3〜5個書く）。作業ファイルの先頭の workdir・state・question の行は Hub が管理する：書き換えない（特に、取り込み済みの後に古い内容で書き戻さない）。`].filter(Boolean).join('\n\n');
}

// 会話整理では作業用の更新・委任指示を付けず、読む台帳とJSON選別の依頼だけを渡す。
function selectionPrompt(p){return `台帳=${p.dir}。`;}

function codexFastFor(project, task) {
  const p = store.readProject(project);
  return Boolean(p && acceleration.settings().codexAllowed && chat.readMeta(p.dir, task).codexFast === true);
}
function accountFor(project, task, ai) {
  const p = store.readProject(project);
  const id = p ? chat.readMeta(p.dir, task).accounts?.[ai] || 'default' : 'default';
  accounts.get(ai, id); return id;
}
function requestAccount(p, task, ai, supplied) {
  const id = supplied ?? accountFor(p.id, task, ai); accounts.available(ai, id, { forWork: true }); return id;
}
function accountBusy(ai, id) {
  if (usage?.inflight?.has(usage.key(ai, id)) || usage?.resetBusy?.has(usage.key(ai, id))) return true;
  if (id === 'default' && aiTools.isOperating()) return true;
  if (sessions.list().some(s => s.running && s.ai === ai && (s.account || 'default') === id)) return true;
  if ([...chats.running.values()].some(r => r.ai === ai && (r.account || 'default') === id)) return true;
  for (const p of store.listProjects()) for (const t of p.tasks) {
    if (chats.queue(p.id, t.id).some(q => (q?.ai === ai && (q.account || 'default') === id) || (ai === 'claude' && q?.limitSwitch && (q.limitSwitch.sourceAccount || 'default') === id))) return true;
  }
  // 外部Terminal等のAIはアカウントを特定できないので、該当AIの認証変更を保留する。
  return procwatch.list().some(r => r.ai === ai || r.ai === launch.AI_KEY[ai]);
}
function usageSelection(url, b = {}) {
  const project = b.project || url.searchParams.get('project'), task = b.task || url.searchParams.get('task');
  if (!task) return {};
  const p = store.readProject(project); if (!p || !store.taskFile(project, task)) throw Error(lt('作業が見つかりません'));
  return Object.fromEntries(['claude', 'codex'].map(ai => {
    const id = b[ai + 'Account'] ?? url.searchParams.get(ai + 'Account') ?? accountFor(project, task, ai);
    accounts.get(ai, id); return [ai, id];
  }));
}
function usageWithLimit(snapshot) {
  // 表示も開始前の共通判定から作る。旧fable-limit.jsonは読まず変更もしない。
  const account = snapshot.selection?.claude || snapshot.providers?.claude?.account || 'default';
  const state = limitRoutingEnabled() && limitEvidence.active(account);
  return { ...snapshot, creditException:limitEvidence.creditException(), limits: limitRoutingEnabled() ? limitEvidence.list(snapshot.selection || {}) : [], fableLimit: state ? { model: 'claude-fable-5-1', account, at: state.at, until: state.validUntil, untilSource: state.untilSource, hold: true } : null };
}

const { FreetalkHistory } = require('./lib/freetalk-history');
const freetalkHistory = new FreetalkHistory(freetalk, task => {
  if (webchatActive('freetalk',task) || chats.busy('freetalk',task) || sessions.list().some(x=>x.running && x.project==='freetalk' && x.task===task)) return lt('AIが作業中です。返事が終わってから整理してください');
  if (chats.queue('freetalk',task).length) return lt('順番待ちがあります。終了または取り消し後に整理してください');
  // Restarted Hub supervisors and their descendants belong to the guarded
  // topic above; shared-cwd guesses must not block every other topic.
  if (procwatch.list().some(x=>x.project==='freetalk' && !chats.supervisedPid(x.pid) && !procwatch.hasAncestor(x.pid,pid=>chats.supervisedPid(pid,{activeOnly:true})))) return lt('freetalkでAIが作業中です。終了後に整理してください');
  return '';
});
const freetalkAttachments = new (require('./lib/freetalk-attachments').FreetalkAttachments)(freetalk);
const taskHistory = new (require('./lib/task-history').TaskHistory)({store,record,
  busy:(project,task,{history=true,bodyPreview}={})=>{
    if(discussion?.active(project,task))return {code:'target-ai',message:'話し合いが進行中です。停止または完了後に整理してください'};
    const all=store.listProjects(),own=all.find(p=>p.id===project)?.tasks.find(t=>t.id===task),wd=own?.workdir&&path.resolve(expandHome(own.workdir));
    const shared=wd&&all.some(p=>p.tasks.some(t=>!(p.id===project&&t.id===task)&&t.workdir&&path.resolve(expandHome(t.workdir))===wd));
    const external=procwatch.list().some(x=>x.project===project&&(x.task===task||!x.task&&wd&&!shared&&x.cwd&&path.resolve(x.cwd)===wd));
    if(webchat?.busy().some(j=>j.project===project&&j.task===task)||chats.busy(project,task)||chats.queue(project,task).length||sessions.list().some(x=>x.running&&x.project===project&&x.task===task)||external)return {code:'target-ai',message:lt('この作業のAIが作業中です。作業が終わってから、もう一度［要約して続ける］を押してください')};
    const blocker=historyBlockers(project)[0];if(blocker)return {code:blocker.kind,message:blocker.message};
    if(history){
      // Display-only snapshot. Mutation callers omit this context and retain full reads.
      if(bodyPreview&&textBudget.journalKey()!==bodyPreview.key)throw Error('本文整理の確認中に記録が変わりました');
      if((bodyPreview?bodyPreview.pending:textBudget.pending(project)).some(x=>x.j.task===task))return lt('本文整理の復旧が必要です');
    }
    if(!history&&shared)return lt('他の作業も同じ作業場所を使っています');
    const integration=history?taskIntegrate.historyBlocker(project,task):taskIntegrate.pending().some(r=>r.project===project&&r.task===task)&&lt('統合・引渡しの続きが残っています');
    if(integration)return integration;
    if(taskTransfer.pending().some(r=>(r.project===project&&r.task===task)||(r.targetProject===project&&r.targetTask===task)))return lt('引渡しの続きが残っています。成果の引渡し・受領を完了してから、もう一度［要約して続ける］を押してください');
    const h=taskTransfer.read(project,task);if(h&&!h.complete&&h.receiving)return lt('受領の続きが残っています');
    return '';
  },reset:(project,task,generation)=>{chats.base.delete(chats.key(project,task));chats.queues.delete(chats.key(project,task));for(const ai of launch.AIS){const key=sessions.key(project,task,ai);if(sessions.get(project,task,ai)?.exited)sessions.map.delete(key);}chats.emit(project,task,{type:'reset',generation});}
});
conversationHistory=taskHistory;
const historyProjects = project => require('./lib/resource-scope').relatedProjects(project, store.listProjects(), baseOf, expandHome, __dirname, {hubGlobal:false});
function historyBlockers(project,{body=false}={}){
  const all=store.listProjects(),ids=historyProjects(project);
  return [...updateBlockers().filter(x=>{
    if(x.kind==='cli')return false;
    if(!x.project||ids===null||!all.some(p=>p.id===x.project))return true;
    return ids.has(x.project)&&(body||['maintenance','github','resolution'].includes(x.kind));
  }),...(appUpdate.applying()?[{kind:'update',message:lt('Hubの更新が進行中です')}]:[]),
    ...(restartControl?.committed?[{kind:'restart',message:lt('再起動を開始しています')}]:[])];
}
const textBudget=new (require('./lib/text-budget').TextBudget)({store,busy:(project,task)=>{
  const ids=historyProjects(project),related=r=>!r?.project||ids===null||ids.has(r.project)||r.items?.some(i=>ids.has(i.project));
  const pending=taskIntegrate.pending();
  if(historyBlockers(project,{body:true}).length||taskIntegrate.active&&related(taskIntegrate.active)||integrateAuto.active&&(!pending.length||pending.some(related))||taskHistory.activeWrites.size||freetalkHistory.activeWrites?.size)return lt('AI・整理・確認が動いています');
  if(taskHistory.organizing(project,task))return lt('会話を整理中です');
  // Shared PROJECT and INDEX are protected against all task integrations/receipts.
  if(pending.some(related)||taskTransfer.pending().some(r=>related(r)||related({project:r.targetProject})))return lt('統合・引渡しの続きが残っています');
  const reason=taskHistory.busy(project,task,{history:false});return reason?.message||reason;
}});
gpt.textBudget=textBudget;
// ［要約して新しい会話へ］の自動整理。段階は台帳外の記録に残し、再起動後もここから続ける。
const LONG_CHAT=120000,autoRunning=new Set();
function autoView(project,task,job){
  const state=taskHistory.state(project,task),auto=job||state.auto||null,p=store.readProject(project);let chars=0,compacted=false;
  if(p&&p.kind!=='freetalk'){for(const r of chat.read(p.dir,task))if((r.role==='user'||r.role==='assistant')&&r.text)chars+=Array.from(r.text).length;compacted=Boolean(chat.readMeta(p.dir,task).compacted);}
  const running=auto?.stage==='selecting'&&chats.busy(project,task),queued=auto?.stage==='selecting'&&!running&&chats.queue(project,task).find(q=>q.selectionOnly&&taskHistory.selectionQueueState(project,task,q));
  return {generation:state.generation,auto:auto&&{...auto,...(queued?{ai:queued.ai,model:queued.model,waiting:queued.limitWaiting?'limit':'start'}:{}),...(running?{ai:running.ai,model:running.model}:{}),reply:undefined},long:chars>LONG_CHAT||compacted,chars,compacted};
}
async function autoTick(project,task){
  if(stopControl.held({project,task}))return;
  if(historyBlockers(project).length)return;
  const key=project+'\0'+task;if(autoRunning.has(key))return;autoRunning.add(key);
  try{await autoStep(project,task);}catch(e){/* 理由は整理の記録に残す */}
  finally{autoRunning.delete(key);try{chats.emit(project,task,{type:'history-auto',...autoView(project,task)});}catch(e){/* 次の確認で表示 */}}
}
async function autoStep(project,task){
  if(stopControl.held({project,task}))return;
  const a=taskHistory.autoJob(project,task);if(!a||['done','failed','cancelled'].includes(a.stage))return;
  const p=store.readProject(project),file=p&&store.taskFile(project,task);if(!file)return taskHistory.setAuto(project,task,{stage:'failed',error:lt('通常の作業が見つかりません')});
  if(a.stage==='reserved'||a.stage==='collecting'){
    let reason='';try{if(chats.busy(project,task)||chats.queue(project,task).length)throw Error(lt('AIの返事が終わったら自動で整理します'));taskHistory.idle(project,task);reason=delegateTerminalError(project,task)||'';}catch(e){reason=e.message;}
    if(reason){if(a.reason!==reason||a.stage!=='reserved')taskHistory.setAuto(project,task,{stage:'reserved',reason});return;}
    const t=store.readTask(file),role=rolesData().roles.find(r=>r.name==='文章');
    if(role?.main.model&&t.state!=='完了'&&!t.completionPending){
      const target={project,task,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model};target.account=accountFor(project,task,target.ai);
      const held=limitRoutingEnabled()&&limitEvidence.forRequest(target),backup=held&&limitBackup(target);
      if(held&&(!backup||limitEvidence.forRequest(backup))){taskHistory.setAuto(project,task,{stage:'reserved',reason:lt('両方の担当が上限中です。解除後に再開してください')});return;}
      if(aiTools.isOperating(target.ai)||backup&&aiTools.isOperating(backup.ai)){taskHistory.setAuto(project,task,{stage:'reserved',reason:lt('AI の更新・モデル再取得が進行中です')});return;}
    }
    let plan;try{plan=taskHistory.autoCollect(project,task);}catch(e){return taskHistory.setAutoSafe(project,task,{stage:'failed',error:e.message});}
    const {prompt,...inputPlan}=plan;
    // 完了済みの作業はAIを起動せず（状態を変えない）、代替要約で会話だけ切り替える。
    if(t.state==='完了'||t.completionPending||!role?.main.model){taskHistory.setAuto(project,task,{stage:'selecting',...inputPlan,reason:'',delegated:false});return taskHistory.autoFinish(project,task,{});}
    taskHistory.setAuto(project,task,{stage:'selecting',...inputPlan,reason:'',delegated:true,selectionRequest:a.id,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model});
    const captured={writeHead(code){this.statusCode=code;},end(body){this.body=body;}};
    await delegateRequest({project,task,text:prompt,title:lt('会話の自動整理'),role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},captured,{preserveTaskState:true,selectionOnly:true,requestKey:a.id,beforeStart:()=>{
      if(taskHistory.autoJob(project,task)?.id!==a.id||taskHistory.autoJob(project,task)?.stage!=='selecting')throw Error(lt('整理の予約を取り消しました'));
      taskHistory.idle(project,task);
    }});
    if(captured.statusCode!==200){
      if(taskHistory.autoJob(project,task)?.stage==='cancelled')return;
      const failure=JSON.parse(captured.body||'{}'),error=String(failure.error||'');
      if(['HUB_LIMIT_WAIT','HUB_AI_MAINTENANCE'].includes(failure.code)){taskHistory.setAuto(project,task,{stage:'reserved',delegated:false,reason:error});return;}
      taskHistory.setAuto(project,task,{delegated:false,error});return taskHistory.autoFinish(project,task,{});
    }
    return;
  }
  if(a.stage==='selecting'){
    if(chats.busy(project,task)||delegateTerminalError(project,task))return;
    const queue=chats.queue(project,task);
    if(queue.length){
      const item=queue[0];
      if(queue.length!==1)return;
      const state=taskHistory.selectionQueueState(project,task,item);
      if(!state)return; // Never consume or retry another task's queued instruction.
      if(state.started){
        // A saved user turn is an attempted launch. After a crash, consume its
        // saved result (or use fallback) instead of sending that request again.
        if(state.error)return taskHistory.setAuto(project,task,{stage:'failed',error:state.error});
        chats.unqueue(project,task,item.id,true);
        taskHistory.setAuto(project,task,{selectionResume:null});
      }else{
        const resume=a.selectionResume?.request===item.id&&['starting','waiting'].includes(a.selectionResume.state);
        if(!item.limitWaiting&&!resume&&item.error)return taskHistory.setAuto(project,task,{stage:'failed',error:item.error});
        if(!limitRoutingEnabled()||limitEvidence.forRequest(item))return;
        if(aiTools.isOperating(item.ai))return;
        // Persist intent before altering the queue. Both writes may be interrupted;
        // the accepted request's user row decides whether it can still be launched.
        taskHistory.setAuto(project,task,{selectionResume:{request:item.id,state:'starting'}});
        try{
          const t=store.readTask(file),dir=item.selectionOnly?p.dir:startDir(p,t).dir;
          chats.setQueue(project,task,[{...item,limitWaiting:false}],true);
          const r=await chats.sendQueued({...item,project,task,pdir:p.dir,dir,request:item.id,perm:permCmd(item.ai),
            basePrompt:item.selectionOnly?selectionPrompt(p):taskPrompt(p,t,file,dir),policy:item.selectionOnly?selectionPrompt(p):modelPolicy(p,t),onEnd:()=>chatEnded(project,task)});
          if(!(await r.started))throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
          chats.unqueue(project,task,item.id,true);
          taskHistory.setAuto(project,task,{selectionResume:null});
        }catch(e){
          // Startup rechecks after asynchronous limit retrieval can meet a CLI
          // operation that began after the first guard. Keep the accepted item.
          if(e.message===lt('AI の更新・モデル再取得が進行中です')){
            taskHistory.setAuto(project,task,{selectionResume:{request:item.id,state:'waiting'}});
            chats.setQueue(project,task,chats.queue(project,task).map(q=>q.id===item.id?item:q),true);return;
          }
          const sw=item.limitSwitch,limitWaiting=Boolean(limitEvidence.forRequest(item)&&limitEvidence.forRequest({ai:sw.sourceAI,model:sw.sourceModel,account:sw.sourceAccount}));
          // Persist the terminal failure first: a crash between these writes must
          // not turn an ordinary launch failure into an automatic retry.
          taskHistory.setAuto(project,task,limitWaiting?{selectionResume:{request:item.id,state:'waiting'}}:
            {stage:'failed',error:e.message,selectionResume:{request:item.id,state:'failed'}});
          chats.setQueue(project,task,chats.queue(project,task).map(q=>q.id===item.id?{...q,error:e.message,limitWaiting}:q),true);
        }
        return;
      }
    }
    // 返事が無い（停止・再起動）時も委任し直さず、代替要約で続ける。
    const reply=taskHistory.selectionReply(project,task);
    return taskHistory.autoFinish(project,task,reply?{reply:reply.text,source:'ai',model:reply.model||a.model||'',replyReceivedAt:reply.at}:{});
  }
  if(a.stage==='writing')return taskHistory.autoFinish(project,task,{});
}
const autoTimer=setInterval(()=>{try{const autos=taskHistory.activeAutos();if(!autos.length||restartControl?.committed||appUpdate.applying()||appShell.rebuilding)return;for(const a of autos)if(!historyBlockers(a.project).length)autoTick(a.project,a.task);}catch(e){/* 次の周期で再確認 */}},1500);autoTimer.unref();
// Context rotation uses the same job as the button; no separate clearing path.
const rotateTimer=setInterval(()=>{
  try{if(restartControl?.committed||appUpdate.applying())return;for(const p of store.listProjects()){
    if(p.kind==='freetalk')continue;
    for(const t of p.tasks){if(t.state==='完了'||t.completionPending)continue;const view=autoView(p.id,t.id);
      if(view.long){const a=taskHistory.autoReserveLong(p.id,t.id,{chars:view.chars,compacted:view.compacted});if(a&&!['cancelled','failed'].includes(a.stage))autoTick(p.id,t.id);}
    }
  }}catch(e){/* Individual jobs keep their own durable progress. */}
},15000);rotateTimer.unref();
const bodyNotices=new Map();
function bodyNoticeState(){
  const notices=new Map(bodyNotices);
  try{for(const p of store.listProjects()){if(p.kind==='freetalk')continue;for(const task of textBudget.state(p.id).tasks){const warnings=textBudget.summaryWarnings(p.id,task);if(warnings.length){const key=p.id+' / '+task;notices.set(key,[notices.get(key),...warnings].filter(Boolean).join(' '));}}}}catch(e){notices.set('本文整理',e.message);}
  return [...notices].map(([scope,message])=>({scope,message}));
}
let bodyChecking=false,bodyClosed=false;
const bodyTimer=setInterval(async()=>{
  if(bodyChecking||bodyClosed)return;bodyChecking=true;
  try{
    // Cheap live busy checks first. A failed save is scanned off-thread during
    // periodic preflight; real writes await a fresh strict worker verdict.
    const busy=()=>updateBusy([])||appUpdate.applying();
    const errors=busy()?null:await chats.handoffErrorsAsync();
    if(bodyClosed)return;
    let globalWarning=false;
    const notice=(scope,warnings)=>{
      if(scope==='本文整理'&&warnings.length)globalWarning=true;
      if(warnings.length)bodyNotices.set(scope,warnings.join(' '));else bodyNotices.delete(scope);
    };
    // Worker reads must finish before the permit: it expires across any await.
    await textBudget.prepareMaintenance(notice);
    if(bodyClosed)return;
    const maintain=()=>{
      textBudget.maintainEnabled(() => bodyClosed || busy() || errors?.length>0 || updateBusy(),notice);
      // Both read and maintenance passes completed without a global failure.
      // Keep individual scope warnings and durable summary conflicts intact.
      if(!globalWarning)bodyNotices.delete('本文整理');
    };
    if(busy()||errors?.length)maintain();else{
      try{await chats.withStrictHandoff(maintain,undefined,false,{background:true});}
      catch(e){
        // Only this background check may defer state churn to the next tick.
        // The strict guard still refuses the action; user operations keep errors.
        if(e.message!=='確認中に実行状態が変わりました。少し待ってから操作し直してください')throw e;
      }
    }
  }catch(e){bodyNotices.set('本文整理',e.message);}finally{bodyChecking=false;}
},15000);bodyTimer.unref();
const { FreetalkLifecycle } = require('./lib/freetalk-lifecycle');
const freetalkLifecycle = new FreetalkLifecycle(freetalkHistory, () => {
  if ([...chats.running.keys()].some(k=>k.startsWith('freetalk\u0000')) || sessions.list().some(x=>x.running && x.project==='freetalk') || procwatch.list().some(x=>x.project==='freetalk')) return lt('AIが作業中です。終了後に掃除します');
  if([...chats.queues.entries()].some(([k,q])=>k.startsWith('freetalk\u0000') && q.length))return lt('順番待ちがあります。終了後に掃除します');
  for (const t of store.readProject('freetalk')?.tasks || []) {
    if(chats.busy('freetalk',t.id))return lt('AIが作業中です。終了後に掃除します');
    if(chats.queue('freetalk',t.id).length)return lt('順番待ちがあります。終了後に掃除します');
  }
  return '';
}, () => new Date(), path.join(__dirname,'../docs/project-hub/templates/project'));
const freetalkAutomaticStarting=new Set();
async function startAutomaticFreetalk(task) {
  const saved=freetalkHistory.state(task);
  if(saved.migrated) {
    if(!saved.migrated.cleanupPending)return {ok:true,...saved.migrated,repeated:true};
    // Retry deletion only: neither re-summarize nor create a second project.
    freetalkHistory.save(task,{...saved,migrated:{...saved.migrated,cleanupError:undefined}});
    return {ok:true,automatic:true,pending:true};
  }
  if(saved.summary?.intent==='promote' && saved.summary.automatic) {
    if(saved.summary.automatic.uncertain)throw Error(saved.summary.automatic.error);
    if(!saved.summary.automatic.error)return {ok:true,automatic:true,pending:true};
  }
  // Reuse a successful current summary; retries do not repeat completed AI work.
  if(saved.summary) {
    const h=freetalkHistory.status(task);
    if(h.draft && !h.stale) {
      freetalkHistory.idle(task);
      freetalkHistory.save(task,{...saved,summary:{...saved.summary,intent:'promote',automatic:{phase:'create'}}});
      return {ok:true,automatic:true,pending:true};
    }
  }
  const request=freetalkHistory.prepareSummary(task,{intent:'promote',automatic:true});
  const summaryId=freetalkHistory.state(task).summary.id;
  freetalkAutomaticStarting.add(task);
  let code=500,body={error:lt('要約の開始結果を確認できませんでした')};
  const response={writeHead:c=>{code=c;},end:value=>{body=JSON.parse(String(value));}};
  try {
    await delegateRequest({...request,project:'freetalk',task,title:lt('話題の整理用の要約')},response,{requestKey:summaryId,beforeStart:()=>freetalkHistory.idle(task)});
    const state=freetalkHistory.state(task);
    if(state.summary?.id===summaryId && state.summary.intent==='promote') {
      freetalkHistory.save(task,{...state,summary:{...state.summary,automatic:{phase:'summary',...(code!==200 || !body.ok?{error:body.error || lt('要約を開始できませんでした')}:{})}}});
    }
    if(code!==200 || !body.ok)throw Error(body.error || lt('要約を開始できませんでした'));
    return {...body,automatic:true,pending:true};
  }catch(e){freetalkLifecycle.automaticError(task,e.message);throw e;}
  finally{freetalkAutomaticStarting.delete(task);}
}
function finishAutomaticFreetalk() {
  if(restartControl?.committed || appUpdate.applying())return;
  let tasks;try{tasks=freetalkLifecycle.automaticTasks();}catch(e){freetalkLifecycle.error=e.message;return;}
  for(const task of tasks) {
    try {
      const state=freetalkHistory.state(task);
      if(freetalkAutomaticStarting.has(task) || (state.migrated?!state.migrated.cleanupPending || state.migrated.cleanupError:state.summary?.intent!=='promote' || !state.summary.automatic || state.summary.automatic.error))continue;
      const result=freetalkLifecycle.completeAutomatic(task);
      if(result?.ok){chats.base.delete(chats.key('freetalk',task));chats.queues.delete(chats.key('freetalk',task));chats.emit('freetalk',task,{type:'reset'});setUnread('freetalk',task,false);setUnread(result.project,result.task,true);}
    }catch(e){try{freetalkLifecycle.automaticError(task,e.message);}catch{/* leave saved intent available for inspection */}}
  }
}
const freetalkAutomaticTimer=setInterval(finishAutomaticFreetalk,1000);freetalkAutomaticTimer.unref();
function cleanFreetalkMemory() {
  for(const key of [...chats.base.keys()])if(key.startsWith('freetalk\u0000'))chats.base.delete(key);
  for(const key of [...chats.queues.keys()])if(key.startsWith('freetalk\u0000'))chats.queues.delete(key);
  for(const key of [...unread])if(key.startsWith('freetalk\u0000'))setUnread('freetalk',key.split('\u0000')[1],false);
}
function freetalkStatus() {
  const result=freetalk.status(); if(!result.ready)return result;
  try{return {...result,cleanup:freetalkLifecycle.status()};}catch(e){return {...result,cleanup:{reason:e.message}};}
}
const freetalkSweep=setInterval(()=>{
  if(restartControl?.committed)return;
  try {
    if(freetalkLifecycle.automaticTasks().some(task=>{const s=freetalkHistory.state(task);return s.migrated?.cleanupPending || (!s.migrated && s.summary?.intent==='promote' && s.summary.automatic);} ))return;
    const result=freetalkLifecycle.tick();if(result?.ok)cleanFreetalkMemory();
  }catch(e){freetalkLifecycle.error=e.message;}
},60000);
freetalkSweep.unref();
const restartBlockers = (handoffErrors) => {
  const out=updateBlockers().filter(x=>x.kind!=='queue'&&!(x.kind==='chat'&&chats.handoffSafe(x.project,x.task))&&!(x.kind==='background'&&chats.supervisedPid(x.pid)));
  const add=(kind,message)=>out.push({kind,message:lt(message)});
  for(const e of handoffErrors ?? chats.guardErrors())out.push({kind:'chat-handoff',project:e.project,task:e.task,stage:e.stage,run:e.run,message:lt('会話の終了保存が未解決です。自動では再処理しません')});
  if(webchat?.control)add('webchat-control','Chat／Proの操作が進行中です');
  if(taskIntegrate.active || integrateAuto.active)add('integration','統合の処理が進行中です');
  if([...executionGate.leases.values()].some(l=>l.kind==='verification'))add('verification','開発場所の検証と子プロセスの終了確認が進行中です');
  if(terminalLimits.busy || sessions.list().some(x=>{const s=sessions.get(x.project,x.task,x.ai);return s?.limitTransition&&!s.limitTransitionDone;}))add('limit-transition','上限による交代の準備中です');
  if(activeRequests || taskHistory.activeWrites.size || freetalkHistory.activeWrites?.size)add('write','保存・送信が進行中です');
  if(appUpdate.running || ['installing','publishing'].includes(appUpdate.data.phase))add('update','Hubの更新が進行中です');
  if(problemResolution.starting.size)add('resolution','問題の整理が進行中です');
  return out;
};
restartControl = new (require('./lib/restart-control').RestartControl)({
  blockers:restartBlockers,admit:action=>chats.withStrictHandoff(action),
  verify:()=>{mainMergeFlow?.verifyRestart();for(const p of store.listProjects())for(const t of p.tasks)chats.queue(p.id,t.id);chats.verifyQueues();},
  execute:()=>{
    record('restart', {}, {from:VERSION,to:readVersion()});
    if(DRY)return;
    setTimeout(async()=>{
      let ownerRestart;
      try{await chats.withStrictHandoff(()=>{emergencyRestart?.verifyCommitted();mainMergeFlow?.verifyRestart();if(restartBlockers().length)throw Error('再起動の直前に状態が変わりました');ownerRestart=localAuth.restartEnv();chats.detachChecked();stopControl.cleanExit();});}catch(e){if(localAuth.preserve)try{localAuth.cancelRestart();}catch{}restartControl.committed=false;restartControl.error=e.message;emergencyRestart?.fail(e.message);record('restart-handoff-error',{}, {error:e.message});return;}
      server.close();
      if(process.platform==='win32' && process.env.HUB_WINDOW_LAUNCH) { process.exit(42); return; } // Owned native window/launcher performs the relaunch.
      const nextHub=appUpdate.restartNeeded ? appUpdate.nextHub() : __dirname;
      const restartEnv={...process.env,...ownerRestart,HUB_UPDATE_SOURCE:appUpdate.source,HUB_UPDATE_CONFIRM:appUpdate.data.pendingConfirm?.token || '',HUB_RESTART_WAIT:'1'};
      delete restartEnv.HUB_AUTH_RESTART;
      const child=require('node:child_process').spawn(process.execPath,[path.join(nextHub,'server.js')],{cwd:nextHub,env:restartEnv,detached:true,stdio:['ignore','inherit','inherit']});
      child.unref();process.exit(0);
    },200);
  }
});
mainMergeFlow=new (require('./lib/main-merge-flow').MainMergeFlow)({ledger:mainMergeDelivery,git:gitw,restart:()=>restartControl,
  runtime:()=>({instance:HUB_INSTANCE,version:VERSION,bootHead:BOOT_HEAD,targetDir:path.resolve(__dirname,'..'),updatePending:appUpdate.restartNeeded}),
  keep:r=>{const p=store.readProject(r.project),t=p?.tasks.find(t=>t.id===r.task);if(!t||expandHome(t.workdir)!==r.sourceDir)throw Error('保持する作業が変わりました。取り込みは送り直しません。');if(!t.continuation)store.updateTask(p.id,t.id,{continuation:true,memo:lt`本体に取り込み、同じ作業とコピーを保持しました（${r.targetDir}）`});}
});
const mainMergeFlowTimer=setInterval(()=>mainMergeFlow.tick(),500);mainMergeFlowTimer.unref();
const restartTimer=setInterval(()=>{emergencyRestart?.tick();restartControl.tick();},500);restartTimer.unref();
// 会話の引継ぎと、親の統合画面からの衝突解消依頼は同じ起動・排他・モデル指定を使う。
function integrationReviewPrompt(p,t){
  return modelPolicy(p,t).split('\n\n')[0]+'\n'+`統合差分の独立確認です。実装担当の会話とCLIセッションは引き継いでいません。依頼にある保存差分・試験原物から判定してください。親作業の再開要約・会話本文・成果の判定文を確認の代わりに使わないでください。読むだけ。ファイル・作業記録の編集、試験の再実行、委任、受領、本体取り込み、起動は行わず、判定だけをこの会話へ返してください。台帳：${p.dir}。`;
}
function isolatedReviewDir(p,t){
  const dir=expandHome(t.workdir)||baseOf(p);
  if(!dir||!fs.existsSync(dir))throw Error(lt('作業場所を用意できませんでした'));
  return dir;
}
function verifyIntegrationReviewSend(o) {
  verifyIntegrationAssignmentSend(o);
  if(discussionRuntime.isRequest(o.request)){discussion.verify(o);return;}
  if(roleReviewRuntime.isRequest(o.request)){roleReview.verify(o);return;}
  const queued=o.mode==='queued'||o.mode==='amend',q=queued?chats.queue(o.project,o.task).find(q=>q.id===o.request):null;
  const original=x=>x?.limitSwitch?.original||x?.shown||x?.text;
  const markers=[...String(o.limitSwitch?.original||o.text||'').matchAll(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/g)];
  const owned=require('./lib/integration-sibling').requestRecords(taskIntegrate,o,q);
  if(owned.length>1)throw Error('Ambiguous integration request');
  for(const record of owned){require('./lib/integration-sibling').assert(taskIntegrate,record);if(record.auto?.stopped)throw Error('Stopped integration cannot dispatch');}
  const r=owned[0]||taskIntegrate.read(o.project,o.task);
  // Classification comes from the durable delivery and actual queue, never
  // from an isolation flag. Keep the queue id at acceptance so a replacement
  // that removes every request/marker still cannot become an ordinary chat.
  const refs=[o.request,o.integrationReviewRequest,o.limitSwitch?.sourceRequest,q?.id,q?.request,q?.integrationReviewRequest,q?.limitSwitch?.sourceRequest].filter(Boolean);
  const owns=a=>refs.some(id=>id===a.delivery?.request||id===a.delivery?.queueId||id==='limit-'+a.delivery?.request||a.delivery?.queueId&&id==='limit-'+a.delivery.queueId);
  const bound=Object.entries(r?.auto?.attempts||{}).filter(([,a])=>(a.phase==='review'||a.request?.review)&&owns(a));
  const queueReview=/\[integration-auto:[a-f0-9]{64}:review\]/.test(String(original(q)||''));
  if(!markers.some(m=>m[2]==='review')&&!o.integrationReviewRequest&&!q?.integrationReviewRequest&&!queueReview&&!bound.length)return;
  const a=markers.length===1&&markers[0][2]==='review'&&r?.auto?.attempts[markers[0][1]];
  if(!a||bound.some(([k])=>k!==markers[0][1])||r.auto.stopped||a.phase!=='review'||!o.integrationReviewRequest||a.delivery?.request!==o.integrationReviewRequest||!['intent','accepted'].includes(a.delivery.state))throw Error('Saved result review request changed');
  if(o.isolatedReview!==true||o.readOnly!==true)throw Error('Saved result review isolation changed');
  if(queued){
    if(q?.isolatedReview!==true||q.readOnly!==true||q.integrationReviewRequest!==o.integrationReviewRequest||original(q)!==original(o))throw Error('Saved result review queue changed');
    if(a.delivery.queueId&&q.id!==a.delivery.queueId&&q.id!=='limit-'+a.delivery.queueId&&q.id!=='limit-'+a.delivery.request)throw Error('Saved result review queue changed');
  }
  require('./lib/integration-sibling').review(taskIntegrate,r,a);
  if(!a.savedResults)return;
  // Callbacks cannot survive a saved queue or a limit successor. Bind the
  // request to its durable attempt, then read the current material again.
  if(a.request?.review?.key!==markers[0][1]||JSON.stringify(a.request.review.savedResults)!==JSON.stringify(a.savedResults))throw Error('Saved result review request changed');
  // ChatRunner has already checked exclusive startup ownership. Its own
  // persisted queue is expected here; all scope/content checks still apply.
  taskIntegrate.simple.validate(r,{allowBusy:true});
  const head=require('./lib/integration-safety').target(taskIntegrate,{target:r.target,p:store.readProject(r.project)});
  if(!head||head.status||head.head!==a.reviewHead||gitw.merging(r.target))throw Error('Integration review range changed');
  integrateAuto.verifySavedReview(r,a);
}
function delegateRequest(b,res,options={}) { return queueEngine.delegateRequest(b, res, options); }
function userDelivery(b,res,options) { return queueEngine.userDelivery(b, res, options); }

// 場所リンクの候補順は、Mac操作とブラウザ表示で共通にする。
const placeRoots = () => [os.homedir(), ROOT].map(d => path.resolve(d));
const insidePlaceRoots = (target, roots) => roots.some(h => target === h || target.startsWith(h + path.sep));
// Mac の許可が無くて中を読めない時の知らせ（Finder が違う場所で開くのを防ぐ）
const denied = x => { try { fs.readdirSync(fs.statSync(x).isDirectory() ? x : path.dirname(x)); return ''; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code) ? lt('Mac の許可が無くて開けません。設定画面の「Mac のファイルの許可」で［確認をもう一度出す］を押し、「許可」を選んでください') : ''; } };
function resolvePlace(b) {
  const raw = String(b.path || '').trim();
  if (!raw) throw Object.assign(Error(lt('場所がありません')), { status: 400 });
  const p = store.readProject(b.project);
  const f = p && b.task ? store.taskFile(b.project, b.task) : null;
  const t = f ? store.readTask(f) : null;
  const bases = [t && expandHome(t.workdir), p && baseOf(p), p && p.dir, ROOT, store.product].filter(Boolean);
  const list = raw.startsWith('~') || path.isAbsolute(raw) ? [expandHome(raw)] : bases.map(d => path.join(d, raw));
  const home = placeRoots();
  const target = list.map(x => path.resolve(x)).find(x => insidePlaceRoots(x, home) && fs.existsSync(x));
  if (!target) throw Object.assign(Error(lt`見つかりません：${raw}`), { status: 404 });
  const error = denied(target);
  if (error) throw Object.assign(Error(error), { status: 403 });
  return { target, home };
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml']);
const DOC_EXTENSIONS = new Set(['.docx', '.doc', '.rtf', '.odt']);
function viewInfo(target) {
  try {
    const real = fs.realpathSync(target);
    if (localAuth.protect(real)) return { status: 403 };
    // macOSの /var → /private/var 等も同じルートとして比較する。
    const roots = placeRoots().map(d => { try { return fs.realpathSync(d); } catch { return d; } });
    if (!insidePlaceRoots(real, roots)) return { status: 404 };
    const ext = path.extname(target).toLowerCase(), stat = fs.statSync(real);
    const kind = IMAGE_TYPES[ext] ? 'image' : ext === '.pdf' ? 'pdf' : TEXT_EXTENSIONS.has(ext) ? 'text' : DOC_EXTENSIONS.has(ext) ? 'doc' : '';
    const limit = ({ image: 30, pdf: 50, text: 2, doc: 20 })[kind] * 1024 * 1024;
    const type = IMAGE_TYPES[ext] || ({ pdf: 'application/pdf', text: 'text/plain; charset=utf-8', doc: 'text/html; charset=utf-8' })[kind];
    if (!kind || !stat.isFile() || stat.size > limit) return { status: 415 };
    return { status: 200, path: real, kind, type, limit, ext, stat };
  } catch { return { status: 404 }; }
}
function documentHtml(fd, info, size) {
  // textutilに場所を再び開かせず、確認済みfdから上限内の内容だけを渡す。
  const input = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = fs.readSync(fd, input, read, size - read, read);
    if (!n) throw Error('document changed');
    read += n;
  }
  return platform.convertDocument(input, info.ext.slice(1));
}

const stateOffers = new (require('./lib/state-offers').StateOffers)({transfer:taskTransfer,removal,baseOf});

const museSettings = new (require('./lib/muse-settings').MuseSettings)({root:ROOT});
museDirect = new (require('./lib/muse-direct').MuseDirect)({muse:museSettings,
  probe:b=>{
    stopControl.assert(b);
    if(restartControl?.committed||appUpdate.applying()||executionGate.barrier)throw Error('停止・更新中です。終わってから送ってください。');
    const p=store.readProject(b.project),t=p?.tasks.find(x=>x.id===b.task);
    if(!t||t.state==='完了')throw Error('作業または会話が変わりました。新しい会話を開いてください。');
    if(p.kind==='freetalk') {
      freetalkHistory.idle(b.task);
      if(freetalkHistory.state(b.task).generation!==b.generation)throw Error('作業または会話が変わりました。新しい会話を開いてください。');
    } else if(taskHistory.organizing(b.project,b.task)||taskHistory.state(b.project,b.task).generation!==b.generation)throw Error('作業または会話が変わりました。新しい会話を開いてください。');
    if(chats.busy(b.project,b.task)||chats.queue(b.project,b.task).length||webchatActive(b.project,b.task))throw Error('前の処理が終わってからMuseへ送ってください。');
    assertWorkspaceIdle(p,t,false);
  },emit:(p,t,ev)=>chats.emit(p,t,ev)});
const conversationSearch = new (require('./lib/conversation-search').ConversationSearch)(store.root);
const routes = require('./lib/routes').createRoutes([
  { name: 'musesettings', create: require('./lib/routes/muse-settings'), ctx: { send, PORT, fromRemote, muse: museSettings, direct:museDirect, launch, DRY, record,
    approvalProbe: request => integrationAssignment(request),
    approvalDispatch: async request => {
      const assigned = integrationAssignment(request);
      let status, body;
      const response = {writeHead: code => {status = code;}, end: text => {body = JSON.parse(text);}};
      await delegateRequest(assigned, response, {requestKey: request.requestKey});
      if (status !== 200 || !body?.ok) throw Error('Muse continuation not confirmed');
      return body;
    } } },
  { name: 'queuecontrol', create: require('./lib/routes/queue-control'), ctx: { ROLES_FILE, chats, freetalkAttachments, fromRemote, fs, launch, limitIdentity, lt, modelError, permCmd, pickSpec, queueActions, queueEdit, queueEditable, getQueueRetreat: () => queueRetreat, record, requestAccount, roleHistory, getRoleReview: () => roleReview, roles, rolesData, send, store } },
  { name: 'terminalstart', create: require('./lib/routes/terminal-start'), ctx: { DRY, accountFor, accounts, aiTools, codexFastFor, crypto, fs, gitSnapshot, launch, license, licenseGuard, limitBackup, limitEvidence, limitIdentity, lt, modelError, modelView, path, permCmd, pickSpec, record, refreshLimitEvidence, requestAccount, getRestartControl: () => restartControl, rolesData, saveTerminalPending, send, sessions, startDir, store, taskPrompt, terminalBusy, terminalPending, transcript } },
  { name: 'chatsend', create: require('./lib/routes/chat-send'), ctx: { DELEGATE_COMPLETED_ERROR, assertWorkspaceIdle, chat, chatEnded, chats, getDiscussion: () => discussion, extensions, freetalk, freetalkAttachments, fs, holdStoppedQueue, getIdeaDispatch: () => ideaDispatch, ideas, integrationReviewPrompt, isolatedReviewDir, launch, license, licenseGuard, lt, modelError, modelPolicy, modelView, permCmd, pickSpec, queueActions, queueEdit, queueEditable, record, startCreditCheck, refreshLimitEvidence, removalReview, reqCtx, requestAccount, roles, rolesData, send, sessions, specialMode, start, startDir, stopControl, store, taskHistory, taskPrompt, verifyIntegrationReviewSend, getWebchat: () => webchat, webchatActive } },
  { name: 'ideaimage', create: require('./lib/routes/idea-image-upload'), ctx: { send, ideas } },
  { name: 'chatrecovery', create: require('./lib/routes/chat-recovery'), ctx: { send, chats, store } },
  { name: 'terminalio', create: require('./lib/routes/terminal-io'), ctx: { send, lt, sessions, setUnread, launch, modelError, store, pickSpec, limitIdentity, rolesData, record } },
  { name: 'localfiles', create: require('./lib/routes/local-files'), ctx: { send, lt, resolvePlace, viewInfo, fs, documentHtml, fromRemote, record, store, expandHome, denied, launch, DRY, path, platform } },
  { name: 'mcpsettings', create: require('./lib/routes/mcp-settings'), ctx: { send, lt, gpt, readBody, freetalkHistory, codexMcpStatus, codexMcpRegister, record } },
  { name: 'rolesettings', create: require('./lib/routes/role-settings'), ctx: { send, lt, roleHistory, ROLES_FILE, roles } },
  { name: 'taskmanagement', create: require('./lib/routes/task-management'), ctx: { send, lt, store, fs, acceleration, chat, record, webchatActive, sessions, chats, emptyLib, removal } },
  { name: 'taskattachments', create: require('./lib/routes/task-attachments'), ctx: { send, lt, store, taskHistory, freetalk, freetalkAttachments, readRaw, MAX_UPLOAD, record, saveUpload, launch, sessions, path, fs } },
  { name: 'taskintegration', create: require('./lib/routes/task-integration'), ctx: { send, lt, store, inWork, copyMissing, expandHome, gitw, mainMergeDelivery, getMainMergeFlow: () => mainMergeFlow, workRoot, mainMergeTokens, crypto, integrationBlockers, integrationBlockersAsync, HUB_INSTANCE, lastMerge, record, taskIntegrate, launch, sessions, taskTransfer, setUnread, integrationFailure, integrationAbandon, integrateAuto, pruneUnread, resultsGate, executionRoles, delegateRequest } },
  { name: 'taskbodywrite', create: require('./lib/routes/task-body-write'), ctx: { send, textBudget, record } },
  { name: 'taskcontinuation', create: require('./lib/routes/task-continuation'), ctx: { send, taskHistory, textBudget, autoTick, record } },
  { name: 'taskhistorywrite', create: require('./lib/routes/task-history-write'), ctx: { send, lt, taskHistory, autoTick, autoView, rolesData, delegateRequest } },
  { name: 'phase', create: require('./lib/routes/phase'), ctx: { send, lt, store, sessions, chats, record } },
  { name: 'taskcopy', create: require('./lib/routes/task-copy-record'), ctx: { send, lt, store, copyMissing, lastMerge, record, inWork } },
  { name: 'taskprogress', create: require('./lib/routes/task-progress'), ctx: { send, lt, getDiscussion: () => discussion, webchatActive, chats, launch, sessions, resultsGate, store, record, reportChild, handoff } },
  { name: 'chatnote', create: require('./lib/routes/chat-note'), ctx: { send, lt, store, freetalk, chat, chats } },
  { name: 'tasksettings', create: require('./lib/routes/task-settings'), ctx: { send, lt, store, fromRemote, record, chats, sessions, setUnread, taskHistory, chat } },
  { name: 'taskread', create: require('./lib/routes/task-read'), ctx: { send, lt, store, stepSummary, inWork, gitw, expandHome, workRoot, taskIntegrate } },
  { name: 'taskbody', create: require('./lib/routes/task-body-read'), ctx: { send, lt, textBudget, path, store, fs } },
  { name: 'taskhistory', create: require('./lib/routes/task-history-read'), ctx: { send, taskHistory, autoView, textBudget } },
  { name: 'conversationsearch', create: require('./lib/routes/conversation-search'), ctx: { send, search: conversationSearch, PORT, fromRemote } },
  { name: 'chatread', create: require('./lib/routes/chat-read'), ctx: { send, lt, store, record, setUnread, taskHistory, ideaRows, chat, chats, getWebchat: () => webchat, getMuseDirect: () => museDirect, freetalkHistory } },
  { name: 'freetalk', create: require('./lib/routes/freetalk'), ctx: { send, lt, freetalkHistory, freetalkAttachments, freetalk, specialMode, modelView, rolesData, freetalkLifecycle, chats, setUnread, cleanFreetalkMemory, startAutomaticFreetalk, delegateRequest } },
  { name: 'project', create: require('./lib/routes/project'), ctx: { send, projectNotes, store, expandHome, github, githubProject, fs, path, gitw, lt, handoff, sessions, chats, record, reportChild, activePack, __dirname } },
  { name: 'start', create: require('./lib/routes/start'), ctx: { store, start, send, fs, lt, readRaw, quickStart: (...args) => quickStart(...args) } },
  { name: 'state', create: require('./lib/routes/state'), ctx: { gitw, __dirname, pruneUnread, getDiscussion: () => discussion, rolesData, modelView, stepSummary, chats, restartBlockers, extensions, stopControl, ROOT, HUB_INSTANCE, VERSION, readVersion, BOOT_HEAD, license, appUpdate, appShell, freetalkStatus, onboarding, aiUpdates, aiTools, updateBusy, getRestartControl: () => restartControl, bodyNoticeState, github, accounts, store, projectOrder, taskTransfer, stateOffers, taskIntegrate, launch, handoff, baseOf, githubProject, start, workRoot, copyMissing, chat, path, expandHome, fs, resultsGate, freetalkHistory, inWork, getWebchat: () => webchat, getMuseDirect: () => museDirect, sessions, modelError, roles, unread, procwatch, acceleration, remote, gpt, crypto, fromRemote, getUpdateRestoreReady: () => updateRestoreReady, record, sendEncoded, lt } },
  { name: 'acceleration', create: require('./lib/routes/acceleration'), ctx: { send, acceleration, record } },
  { name: 'modelsettings', create: require('./lib/routes/model-settings'), ctx: { send, saveCliModels, record, launch, modelView, rolesData, modelError, roles, ROLES_FILE, lt } },
  { name: 'limits', create: require('./lib/routes/limits'), ctx: { send, usageSelection, accounts, usage, limitEvidence, record, usageWithLimit, lt, limitModels, getDiscussion: () => discussion } },
  { name: 'aiupdate', create: require('./lib/routes/ai-update'), ctx: { send, aiUpdates, applyModelCatalog, record, lt } },
  { name: 'hierarchy', create: require('./lib/routes/hierarchy'), ctx: { send, removal, removalReview, ideas, crypto, pruneUnread, record, projectOrder, store, sessions, chats } },
  { name: 'accounts', create: require('./lib/routes/accounts'), ctx: { send, accounts, launch, usage, aiTools, applyModelCatalog, lt, sessions, store, chat, DRY, limitEvidence, record } },
  { name: 'modelinfo', create: require('./lib/routes/model-info'), ctx: { send, aiUpdates, applyModelCatalog, listSkills, accounts, rolesData, launch, cliModelHints, acceleration } },
  { name: 'information', create: require('./lib/routes/information'), ctx: { send, procwatch, VERSION, readVersion, changelog, sessions, readLog } },
  { name: 'remote', create: require('./lib/routes/remote'), ctx: { send, remote, tailscaleUrl, record } },
  { name: 'usage', create: require('./lib/routes/usage'), ctx: { send, usage, usageSelection, usageWithLimit, accounts, PORT, lt } },
  { name: 'onboarding', create: require('./lib/routes/onboarding'), ctx: { send, onboarding, lt } },
  { name: 'maintenance', create: require('./lib/routes/maintenance'), ctx: { send, maintenance, problemResolution, executionGate, baseOf, store, record, lt } },
  { name: 'github', create: require('./lib/routes/github'), ctx: { send, github, store, githubProject, record, lt } },
  { name: 'language', create: require('./lib/routes/language'), ctx: { send, localeConfig, fromRemote, allowed, langpacks, ROOT, VERSION, readBody } },
]);

async function api(req, res, url) {
  const mutation = req.method === 'POST' && !['/api/restart','/api/restart/cancel','/api/quit'].includes(url.pathname);
  // GETの利用枠取得も、非同期取得後に上限記録を保存するまで再起動を待たせる。
  const accountRead = req.method === 'GET' && (url.pathname === '/api/usage' || url.pathname === '/api/accounts' && url.searchParams.get('status') === '1');
  if ((req.method === 'POST' && !['/api/restart','/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop'].includes(url.pathname) || accountRead) && restartControl?.committed) { req.resume(); return send(res,url.pathname.startsWith('/api/ideas')?503:409,{error:lt('再起動を開始しています'),...(url.pathname.startsWith('/api/ideas')?{code:'restarting',saved:false,retry:'receipt'}:{})}); }
  const active = mutation || accountRead;
  if (active) activeRequests++;
  try { return await reqCtx.run({...reqCtx.getStore(),stopSnapshot:structuredClone(stopControl.data)},()=>apiRequest(req,res,url)); } finally { if (active) activeRequests--; }
}
async function apiRequest(req, res, url) {
  if (routes.queuecontrol.draft.matches(req, url)) return routes.queuecontrol.draft.handle(req, res, url);
  if(req.method==='GET'&&url.pathname==='/api/ai/stop/status')return send(res,200,{...stopControl.view(),targets:emergencyStop.targets()});
  if(req.method==='POST'&&['/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop'].includes(url.pathname)){
    let b;try{b=await readBody(req);if(!b||typeof b!=='object'||Array.isArray(b))throw Error('形式が違います');}catch(e){return send(res,400,{error:e.message});}
    try{
      if(url.pathname==='/api/ai/resume'){if(b.confirm!==true)throw Error('再開の確認が必要です');if(restartControl.committed)throw Error('再起動を開始しています');return send(res,200,stopControl.resume());}
      const all=url.pathname==='/api/ai/stop';
      if(all&&b.confirm!==true)throw Error('停止対象の確認が必要です');
      if(!all&&(typeof b.project!=='string'||!b.project||typeof b.task!=='string'||!b.task))throw Error('停止する作業を選んでください');
      if(!all){const protectedError=freetalkLib.guard('/api/chat/stop',{project:b.project,task:b.task});if(protectedError)throw Error(protectedError);}
      if(all){if(typeof b.opId!=='string'||!/^[a-f0-9-]{36}$/i.test(b.opId))throw Error('停止の受付番号を確認できません');return send(res,200,await emergencyRestart.request(b.opId));}
      return send(res,200,await emergencyStop.stop({project:b.project,task:b.task}));
    }catch(e){return send(res,409,{error:e.message,...stopControl.view()});}
  }

  if (fromRemote() && ['/api/langpacks', '/api/langpacks/import', '/api/langpacks/remove', '/api/language'].includes(url.pathname)) return send(res, 403, { error: 'forbidden' });
  if (routes.taskhistory.continuation.matches(req, url)) return routes.taskhistory.continuation.handle(req, res, url);
  if (routes.taskhistory.history.matches(req, url)) return routes.taskhistory.history.handle(req, res, url);

  // Preview, start and resume report the same blockers without mutating while waiting.
  const integrationWaitingRoute=['/api/task/integrate/preview','/api/task/integrate/resume','/api/task/integrate','/api/task/absorb'].includes(url.pathname);
  if (req.method === 'POST' && appShell.rebuilding && !integrationWaitingRoute && !['/api/restart','/api/restart/cancel'].includes(url.pathname)) return send(res, 409, { error: lt('アプリを作り直しています') });
  if (routes.language.locale.matches(req, url)) return routes.language.locale.handle(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/app-update') return send(res, 200, appUpdate.status());
  if (req.method === 'POST' && ['/api/app-update', '/api/app-update/check'].includes(url.pathname)) {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    let body; try { body = await readBody(req); } catch { return send(res, 400, { error: lt('形式が違います') }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: lt('形式が違います') });
    if (url.pathname.endsWith('/check') || body.action === 'check') { void appUpdate.check().catch(() => {}); return send(res, 200, appUpdate.status()); }
    if (body.action === 'apply') {
      if (appUpdate.status().mode !== 'packaged' || !appUpdate.data.prepared || appUpdate.running) return send(res, 409, { error: '適用できる更新はありません' });
      void appUpdate.apply().catch(() => {}); return send(res, 200, appUpdate.status());
    }
    if (typeof body.enabled !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
    try { return send(res, 200, await appUpdate.settings(body.enabled)); } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && appUpdate.applying() && !integrationWaitingRoute && !(['/api/restart','/api/restart/cancel'].includes(url.pathname)) && !(['/api/quit'].includes(url.pathname) && ['installed','confirming'].includes(appUpdate.status().phase))) return send(res, 409, { error: appUpdate.busyMessage() });
  if (routes.language.packs.matches(req, url)) return routes.language.packs.handle(req, res, url);
  // SSE・添付などJSON共通guardより前の経路も、別表記で別セッションを作らない。
  if (freetalkLib.hasTarget(Object.fromEntries(url.searchParams), true)) { req.resume(); return send(res, 409, { error: lt('freetalk は正規の名前「freetalk」で指定してください') }); }
  // 本体が台帳のフォルダ（書類フォルダの中）を読めるか。Mac の許可が本体に効いているかをアプリが確かめる
  if (req.method === 'GET' && url.pathname === '/api/access') {
    try { fs.readdirSync(ROOT); return send(res, 200, { ok: true, root: ROOT }); }
    catch (e) { return send(res, 200, { ok: false, root: ROOT, code: e.code || '' }); }
  }
  // 一覧
  // 生きているかだけ答える（ファイルを読まないので、台帳が大きくても・iCloud が遅くてもすぐ返る）
  if (routes.queuecontrol.receipt.matches(req, url)) return routes.queuecontrol.receipt.handle(req, res, url);
  if(req.method==='GET' && (url.pathname==='/api/ideas' || url.pathname.startsWith('/api/ideas/'))) return ideaAPI.handle(req,res,url,null,send);
  if (routes.remote.enrollment.matches(req,url)) return routes.remote.enrollment.handle(req,res,url);
  if (routes.remote.forget.matches(req,url)) return routes.remote.forget.handle(req,res,url);
  if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid, runtimePath: __dirname, instance: HUB_INSTANCE, restored: updateRestoreReady, ...(process.platform === 'win32' && process.env.HUB_WINDOW_LAUNCH ? { windowLaunch: process.env.HUB_WINDOW_LAUNCH, windowRoot: ROOT } : {}), updateConfirm: process.env.HUB_UPDATE_CONFIRM || '', ...localAuth.ping(url.searchParams.get('challenge')) });
  if (routes.rolesettings.history.matches(req, url)) return routes.rolesettings.history.handle(req, res, url);
  if (routes.taskintegration.wait.matches(req, url)) return routes.taskintegration.wait.handle(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/discussion') return extensions.route('discussion',req,res,url,null,send);
  if (routes.state.read.matches(req, url)) return routes.state.read.handle(req, res, url);
  // Full steps are fetched only for the open task. Reading never marks it read.
  if (routes.taskread.steps.matches(req, url)) return routes.taskread.steps.handle(req, res, url);
  // 裏で動いている AI の全部（どのプロジェクトにも当たらない物も含む）
  if (routes.information.background.matches(req, url)) return routes.information.background.handle(req, res, url);
  if (routes.modelinfo.tools.matches(req, url)) return routes.modelinfo.tools.handle(req, res, url);
  if (routes.modelinfo.skills.matches(req, url)) return routes.modelinfo.skills.handle(req, res, url);
  if (routes.accounts.read.matches(req, url)) return routes.accounts.read.handle(req, res, url);
  if (routes.usage.read.matches(req, url)) return routes.usage.read.handle(req, res, url);


  // 会話画面：今までの会話と、書いている途中の返事を流す
  if (req.method === 'GET' && routes.conversationsearch.access.matches(req, url)) return routes.conversationsearch.access.handle(req, res, url);
  if (routes.chatread.stream.matches(req, url)) return routes.chatread.stream.handle(req, res, url);
  if (routes.modelinfo.models.matches(req, url)) return routes.modelinfo.models.handle(req, res, url);
  if (/^\/api\/chatgpt\/plan(?:\/|$)/.test(url.pathname)) {
    if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    return send(res, 410, { error: chat.CHATGPT_RETIRED });
  }
  // ChatGPT の道具（mcp.js から）。X-Hub の印がある物だけ
  if (routes.mcpsettings.tools.matches(req, url)) return routes.mcpsettings.tools.handle(req, res, url);
  if (routes.github.read.matches(req, url)) return routes.github.read.handle(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/webchat') return extensions.route('webchat',req,res,url,null,send);
  if (routes.mcpsettings.read.matches(req, url)) return routes.mcpsettings.read.handle(req, res, url);
  if (routes.musesettings.read.matches(req, url)) return routes.musesettings.read.handle(req, res, url);
  // 外から使う（iPhone）の設定
  if (routes.remote.read.matches(req, url)) return routes.remote.read.handle(req, res, url);
  if (routes.information.read.matches(req, url)) return routes.information.read.handle(req, res, url);
  // 取り込む前の見通し（変更の量・ぶつかりそうか）
  if (routes.taskread.preview.matches(req, url)) return routes.taskread.preview.handle(req, res, url);
  if (routes.taskbody.preview.matches(req, url)) return routes.taskbody.preview.handle(req, res, url);
  // 保管した本文の原文は読むだけ。保管先の一覧にある場所だけを返す。
  if (routes.taskbody.archives.matches(req, url)) return routes.taskbody.archives.handle(req, res, url);
  if (routes.project.notes.matches(req, url)) return routes.project.notes.handle(req, res, url);

  // 作業画面の出力を流す（Server-Sent Events）
  if (routes.terminalio.stream.matches(req, url)) return routes.terminalio.stream.handle(req, res, url);

  // GitHub の場所（その場で読み直す）。作業に作業用コピーがあればそのブランチ
  if (routes.project.github.matches(req, url)) return routes.project.github.handle(req, res, url);

  // 子プロジェクトの一覧（親で作業を続ける前に、終わっていない子を知らせるため）
  if (routes.project.children.matches(req, url)) return routes.project.children.handle(req, res, url);
  if (routes.start.image.matches(req, url)) return routes.start.image.handle(req, res, url);

  if (routes.localfiles.view.matches(req, url)) return routes.localfiles.view.handle(req, res, url);

  if (routes.freetalk.status.matches(req, url)) return routes.freetalk.status.handle(req, res, url);
  if (routes.freetalk.attachment.matches(req, url)) return routes.freetalk.attachment.handle(req, res, url);
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  if (routes.ideaimage.upload.matches(req, url)) return routes.ideaimage.upload.handle(req, res, url);

  // ファイル・スクショを受け取る（本文はファイルそのもの）。Inbox に置き、作業ファイルに記録し、動いている AI の入力欄に場所を入れる
  if (routes.taskattachments.upload.matches(req, url)) return routes.taskattachments.upload.handle(req, res, url);

  if (routes.start.upload.matches(req, url)) return routes.start.upload.handle(req, res, url);
  let b;
  try { b = await readBody(req); }
  catch (error) {
    if (routes.conversationsearch.access.matches(req, url)) return send(res, 400, { error: lt('検索の形式が違います。') });
    if (routes.musesettings.write.matches(req, url)) return send(res, 400, { error: lt('形式が違います。ログイン情報は設定画面に送らないでください。') });
    throw error;
  }
  if (routes.conversationsearch.access.matches(req, url)) return routes.conversationsearch.access.handle(req, res, url, b);
  if(b?.origin==='hub-internal')return send(res,403,{error:lt('内部依頼の指定はHubからだけ受け付けます'),delivery:'not-sent'});
  req.historyWrite?.target(b?.project,b?.task);
  if(b?.project&&b.task&&b.project!=='freetalk'&&taskHistory.organizing(b.project,b.task)&&/^\/api\/(chat(?:gpt)?\/|muse\/(?:chat|read)$|term\/|delegate$|task$|task\/(?:history\/(summary|rotate)$|(?:merge|integrate|absorb|handoff|receive|update|delete|decide|step|completion|copyclear|handup|results)(?:\/|$)))/.test(url.pathname))return send(res,409,{error:lt('会話を整理中です。終わると新しい会話で送れます（入力は残っています）'),...(['/api/muse/chat','/api/muse/read'].includes(url.pathname)?{delivery:'not-sent'}:{})});
  if (routes.taskhistorywrite.auto.matches(req, url)) return routes.taskhistorywrite.auto.handle(req, res, url, b);
  if (routes.taskhistorywrite.cancel.matches(req, url)) return routes.taskhistorywrite.cancel.handle(req, res, url, b);
  if(url.pathname.startsWith('/api/ideas/')) return ideaAPI.handle(req,res,url,b,send);
  if(b?.project&&b.task&&!['/api/task/history/rotate','/api/task/continue','/api/task/continue/recover','/api/restart','/api/restart/cancel'].includes(url.pathname)&&b.project!=='freetalk'){
    const generation=taskHistory.state(b.project,b.task).generation;
    const browserConversation=req.headers.origin&&generation>1&&/^\/api\/(chat(?:gpt)?\/|muse\/(?:chat|read)$|term\/|delegate$|task\/history\/summary$)/.test(url.pathname);
    if((b.generation!==undefined||browserConversation)&&b.generation!==generation)return send(res,409,{error:lt('会話が切り替わりました。新しい会話を開いてください'),...(['/api/muse/chat','/api/muse/read'].includes(url.pathname)?{delivery:'not-sent'}:{})});
  }
  if (routes.taskhistorywrite.rotate.matches(req, url)) return routes.taskhistorywrite.rotate.handle(req, res, url, b);
  if (routes.taskcontinuation.recover.matches(req, url)) return routes.taskcontinuation.recover.handle(req, res, url, b);
  if (routes.taskcontinuation.continue.matches(req, url)) return routes.taskcontinuation.continue.handle(req, res, url, b);
  if (routes.taskhistorywrite.summary.matches(req, url)) return routes.taskhistorywrite.summary.handle(req, res, url, b);
  if (url.pathname === '/api/app/rebuild') {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    if (appUpdate.running || appUpdate.applying() || await chats.withStrictHandoff(()=>updateBusy())) return send(res, 409, { error: appUpdate.idleMessage() });
    try { return send(res, 200, await appShell.rebuild()); }
    catch (error) { return send(res, error.status || 500, { error: error.message }); }
  }
  if (routes.freetalk.ensure.matches(req, url)) return routes.freetalk.ensure.handle(req, res, url);
  if (routes.freetalk.topic.matches(req, url)) return routes.freetalk.topic.handle(req, res, url);
  if (['/api/chatgpt/prompt','/api/chatgpt/result'].includes(url.pathname)) return send(res, 410, { error: lt('アプリへのコピー経路は廃止しました。ChatGPT（Chat／Pro）を選び直してください') });
  if(b?.project==='freetalk' && b.task && !['/api/task/read','/api/chat/stop','/api/chat/unqueue','/api/freetalk/project-start','/api/freetalk/promote','/api/freetalk/delete'].includes(url.pathname)) {
    try {
      const state=freetalkHistory.state(b.task);
      if(state.migrated)return send(res,409,{error:lt('この話題はプロジェクトへ移行済みで、読み取り専用です')});
      if(state.summary?.intent==='promote' && state.summary.automatic && !state.summary.automatic.error)return send(res,409,{error:lt('プロジェクトへの移行中です。完了までお待ちください')});
    }
    catch(e) { return send(res,409,{error:e.message}); }
  }
  const freetalkBlock = freetalkLib.guard(url.pathname, b);
  if (freetalkBlock) return send(res, 409, { error: freetalkBlock });
  if (routes.freetalk.lifecycle.matches(req, url)) return routes.freetalk.lifecycle.handle(req, res, url, b);
  if (routes.freetalk.projectStart.matches(req, url)) return routes.freetalk.projectStart.handle(req, res, url, b);
  if (routes.freetalk.history.matches(req, url)) return routes.freetalk.history.handle(req, res, url, b);

  if (routes.onboarding.write.matches(req, url)) return routes.onboarding.write.handle(req, res, url, b);
  if (routes.limits.clear.matches(req, url)) return routes.limits.clear.handle(req, res, url, b);
  if (routes.limits.write.matches(req, url)) return routes.limits.write.handle(req, res, url, b);
  if (routes.usage.write.matches(req, url)) return routes.usage.write.handle(req, res, url, b);
  if (routes.taskmanagement.acceleration.matches(req, url)) return routes.taskmanagement.acceleration.handle(req, res, url, b);
  if (routes.acceleration.write.matches(req, url)) return routes.acceleration.write.handle(req, res, url, b);
  if (routes.github.write.matches(req, url)) return routes.github.write.handle(req, res, url, b);
  if (routes.remote.write.matches(req, url)) return routes.remote.write.handle(req, res, url, b);
  if (url.pathname === '/api/license/intro-checkout') {
    try {
      const checkout = await license.introCheckout();
      await launch.openUrl(checkout.url, DRY);
      return send(res, 200, { ok: true }); // Do not expose/log the bearer Checkout URL.
    } catch { return send(res, 400, { error: lt('体験価格の購入画面を開けません。支払い状況を確認してください'), code: 'intro_checkout' }); }
  }
  if (url.pathname === '/api/license/activate') {
    try { return send(res, 200, await license.activate(b.code)); }
    catch (e) { return send(res, e.status || 400, require('./lib/license').activationError(e)); }
  }
  // 自動ChatとMCPで共有する実作業の許可
  if (routes.accounts.write.matches(req, url)) return routes.accounts.write.handle(req, res, url, b);
  if (url.pathname.startsWith('/api/dot/')) return send(res,410,{error:'Dot連携は廃止しました'});
  if (url.pathname.startsWith('/api/webchat')) {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    return extensions.route('webchat',req,res,url,b,send);
  }
  // 通常MCPの互換登録：~/.codex/config.toml に [mcp_servers.project-hub] を書き足す
  if (routes.mcpsettings.register.matches(req, url)) return routes.mcpsettings.register.handle(req, res, url, b);
  if (routes.mcpsettings.write.matches(req, url)) return routes.mcpsettings.write.handle(req, res, url, b);
  if (routes.musesettings.write.matches(req, url)) return routes.musesettings.write.handle(req, res, url, b);
  if (routes.remote.logout.matches(req, url)) return routes.remote.logout.handle(req, res, url, b);
  if (routes.start.write.matches(req, url)) return routes.start.write.handle(req, res, url, b);
  if (routes.aiupdate.write.matches(req, url)) return routes.aiupdate.write.handle(req, res, url, b);
  if (aiTools.isOperating(b.ai) && ['/api/term/start', '/api/term/handoff', '/api/continue', '/api/chat/send'].includes(url.pathname)) {
    return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です。終わってから始めてください') });
  }

  // 作業画面を開く（画面の中）
  if (routes.terminalstart.start.matches(req, url)) return routes.terminalstart.start.handle(req, res, url, b);

  // 交代する：前の AI の会話を「引き継ぎ資料」にまとめ、相手の AI に読ませて続けさせる
  // 相手が動いていなければ、役割どおりのモデル・思考で始める。相手が作業中なら断る（勝手に割り込まない）
  if (routes.terminalstart.handoff.matches(req, url)) return routes.terminalstart.handoff.handle(req, res, url, b);
  // 動いている AI のモデル・思考を変える：作業ファイルに残し、その AI に /model・/effort を打つ
  if (routes.terminalio.switch.matches(req, url)) return routes.terminalio.switch.handle(req, res, url, b);
  if (routes.terminalio.input.matches(req, url)) return routes.terminalio.input.handle(req, res, url, b);
  if (routes.terminalio.resize.matches(req, url)) return routes.terminalio.resize.handle(req, res, url, b);


  // 別の窓で開く（作業画面の部品が無い時の代わり）
  if (routes.terminalstart.continue.matches(req, url)) return routes.terminalstart.continue.handle(req, res, url, b);

  // フォルダを Finder で開く（台帳に書かれた場所だけ）
  if (routes.localfiles.open.matches(req, url)) return routes.localfiles.open.handle(req, res, url, b);

  // 文の中のファイル・フォルダを Finder で開く（作業の場所からの相対でもよい。ホームの中だけ）
  if (routes.localfiles.reveal.matches(req, url)) return routes.localfiles.reveal.handle(req, res, url, b);
  // URL を既定のブラウザで開く（http・https だけ）
  if (routes.localfiles.url.matches(req, url)) return routes.localfiles.url.handle(req, res, url, b);

  // 作業の状態・質問・メモ・モデル・思考
  // 作業用コピーの古い記録を片付ける（場所が無い時だけ。取り込み済みの後に AI が書き戻した時など）
  if (routes.taskcopy.clear.matches(req, url)) return routes.taskcopy.clear.handle(req, res, url, b);
  if (routes.tasksettings.update.matches(req, url)) return routes.tasksettings.update.handle(req, res, url, b);
  if (routes.taskprogress.completion.matches(req, url)) return routes.taskprogress.completion.handle(req, res, url, b);
  // 手順に印を付ける・外す
  if (routes.taskprogress.step.matches(req, url)) return routes.taskprogress.step.handle(req, res, url, b);
  if (routes.phase.continue.matches(req, url)) return routes.phase.continue.handle(req, res, url, b);
  // プロジェクトを完了にする・戻す（人がはっきり押した時だけ）
  if (routes.project.status.matches(req, url)) return routes.project.status.handle(req, res, url, b);
  // 親に結果を渡す（人がはっきり押した時）。文が無ければ一番新しい作業の「やったこと」の最後
  if (routes.project.handoff.matches(req, url)) return routes.project.handoff.handle(req, res, url, b);
  // 次のフェーズへ進む（今のフェーズを完了に）
  if (routes.phase.next.matches(req, url)) return routes.phase.next.handle(req, res, url, b);
  // コピーと再開先は保持したまま、取り込み対象から外す・戻す
  if (routes.taskcopy.exclusion.matches(req, url)) return routes.taskcopy.exclusion.handle(req, res, url, b);
  // 作業用コピーを本体に取り込んで片付ける
  if (routes.taskintegration.mergeStatus.matches(req, url)) return routes.taskintegration.mergeStatus.handle(req, res, url, b);
  if (routes.taskintegration.mergePreview.matches(req, url)) return routes.taskintegration.mergePreview.handle(req, res, url, b);
  if (routes.taskintegration.merge.matches(req, url)) return routes.taskintegration.merge.handle(req, res, url, b);
  // 成果ファイルを選び、保存と受領通知の後に子作業・派生を片付ける。
  if (routes.taskintegration.handupPreview.matches(req, url)) return routes.taskintegration.handupPreview.handle(req, res, url, b);
  if (routes.taskintegration.handup.matches(req, url, b)) return routes.taskintegration.handup.handle(req, res, url, b);
  if (routes.taskintegration.records.matches(req, url)) return routes.taskintegration.records.handle(req, res, url, b);
  if (routes.taskintegration.consultationClose.matches(req, url)) return routes.taskintegration.consultationClose.handle(req, res, url, b);
  if (routes.taskintegration.abandon.matches(req, url)) return routes.taskintegration.abandon.handle(req, res, url, b);
  if (routes.taskintegration.futureHold.matches(req, url)) return routes.taskintegration.futureHold.handle(req, res, url, b);
  if (routes.taskintegration.keep.matches(req, url)) return routes.taskintegration.keep.handle(req, res, url, b);
  if (routes.taskintegration.preview.matches(req, url)) return routes.taskintegration.preview.handle(req, res, url, b);
  if (routes.taskbodywrite.write.matches(req, url)) return routes.taskbodywrite.write.handle(req, res, url, b);
  if (routes.project.archive.matches(req, url)) return chats.withStrictHandoff(()=>routes.project.archive.handle(req, res, url, b));
  if (routes.taskintegration.resume.matches(req, url)) return routes.taskintegration.resume.handle(req, res, url, b);
  if (routes.taskintegration.apply.matches(req, url)) return routes.taskintegration.apply.handle(req, res, url, b);
  if (routes.taskintegration.organize.matches(req, url)) return routes.taskintegration.organize.handle(req, res, url, b);
  if (routes.taskintegration.results.matches(req, url)) return routes.taskintegration.results.handle(req, res, url, b);
  if (routes.taskintegration.resolve.matches(req, url)) return routes.taskintegration.resolve.handle(req, res, url, b);
  if (url.pathname === '/api/delegate') return extensions.route('delegate',req,res,url,b,send);
  // 会話に「人の依頼」を残すだけ。ここではAIを動かさない。
  if (routes.chatnote.write.matches(req, url)) return routes.chatnote.write.handle(req, res, url, b);
  if (routes.chatsend.send.matches(req, url)) return routes.chatsend.send.handle(req, res, url, b);
  if (routes.chatrecovery.handoff.matches(req, url)) return routes.chatrecovery.handoff.handle(req, res, url, b);
  if (routes.queuecontrol.retreat.matches(req, url)) return routes.queuecontrol.retreat.handle(req, res, url, b);
  if (routes.chatrecovery.unfinished.matches(req, url)) return routes.chatrecovery.unfinished.handle(req, res, url, b);
  if (routes.queuecontrol.edit.matches(req, url)) return routes.queuecontrol.edit.handle(req, res, url, b);
  // 未読の印を消す（画面が作業を開いた時）
  if (routes.tasksettings.read.matches(req, url)) return routes.tasksettings.read.handle(req, res, url, b);
  if (routes.queuecontrol.unqueue.matches(req, url)) return routes.queuecontrol.unqueue.handle(req, res, url, b);
  if (url.pathname === '/api/discussion/start' || url.pathname === '/api/discussion/summary') return extensions.route('discussion',req,res,url,b,send);


  // 新しい版にする：本体を起動し直す（動いている AI があれば断る。止まってしまうため）
  // 本体を止める（アプリが、許可のある自分から起動し直すため）。AI が動いている間は断る
  if (url.pathname === '/api/quit') {
    if ((b.reason === 'windows-window' || process.platform === 'win32' && process.env.HUB_WINDOW_LAUNCH && b.reason === 'update') && (process.platform !== 'win32' || !process.env.HUB_WINDOW_LAUNCH || b.windowLaunch !== process.env.HUB_WINDOW_LAUNCH || b.instance !== HUB_INSTANCE)) return send(res, 409, { error: '起動した専用窓と本体の一致を確認できません' });
    if (await chats.withStrictHandoff(()=>updateBusy())) return send(res, 409, { error: appUpdate.idleMessage() });
    if (aiTools.isOperating()) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: lt`動いている AI が ${busy} つあります` });
    if(!DRY)executionGate.barrier=true;
    record('quit', {}, { reason: String(b.reason || '') });
    send(res, 200, { ok: true });
    if (!DRY) setTimeout(()=>{void shutdown({graceful:true});}, 200);
    return undefined;
  }
  if (url.pathname === '/api/restart' || url.pathname === '/api/restart/cancel') {
    try {
      if(emergencyRestart?.pending())throw Object.assign(Error('緊急停止後の再起動を確認しています。［復旧］で状態を確認してください'),{status:409});
      if (url.pathname.endsWith('/cancel')) return send(res,200,{ok:true,restart:restartControl.cancel()});
      if (b.reserve !== undefined && typeof b.reserve !== 'boolean') return send(res,400,{error:lt('形式が違います')});
      const result=await restartControl.request(b.reserve === true);
      return send(res,200,{ok:true,from:VERSION,to:readVersion(),restart:result});
    } catch(e) { return send(res,e.status||409,{error:e.message,waiting:e.waiting}); }
  }

  // CLI に渡すモデル名を保存する
  if (routes.modelsettings.cli.matches(req, url)) return routes.modelsettings.cli.handle(req, res, url, b);
  // Mac のフォルダ選択の窓を出して、選んだ場所を返す
  if (routes.localfiles.pick.matches(req, url)) return routes.localfiles.pick.handle(req, res, url, b);
  // アプリの窓に落としたファイル（場所が分かる物）を渡す：作業ファイルに記録し、AI の入力欄に場所を入れる
  if (routes.taskattachments.attach.matches(req, url)) return routes.taskattachments.attach.handle(req, res, url, b);

  // 参考フォルダ・ファイルを足す（作った後のプロジェクトにも）
  if (routes.project.refs.matches(req, url)) return routes.project.refs.handle(req, res, url, b);

  // 新しいプロジェクトを始める
  // 中身の無い作業・子プロジェクトを探す／ゴミ箱へまとめて移す
  if (routes.taskmanagement.empty.matches(req, url)) return routes.taskmanagement.empty.handle(req, res, url, b);
  if (routes.taskmanagement.tidy.matches(req, url)) return routes.taskmanagement.tidy.handle(req, res, url, b);
  if (routes.hierarchy.remove.matches(req, url)) return routes.hierarchy.remove.handle(req, res, url, b);
  if (routes.maintenance.write.matches(req, url)) return routes.maintenance.write.handle(req, res, url, b);
  if (routes.hierarchy.organize.matches(req, url)) return routes.hierarchy.organize.handle(req, res, url, b);
  if (routes.project.create.matches(req, url)) return routes.project.create.handle(req, res, url, b);
  if (routes.taskmanagement.create.matches(req, url)) return routes.taskmanagement.create.handle(req, res, url, b);

  // 選ぶ欄にモデルを出す・出さない
  if (routes.modelsettings.write.matches(req, url)) return routes.modelsettings.write.handle(req, res, url, b);
  // 役割分担の保存
  if (routes.rolesettings.write.matches(req, url)) return routes.rolesettings.write.handle(req, res, url, b);
  if (url.pathname === '/api/roles/review' || url.pathname === '/api/roles/review/cancel') return extensions.route('role_review', req, res, url, b, send);
  if (routes.rolesettings.defaults.matches(req, url)) return routes.rolesettings.defaults.handle(req, res, url, b);
  if (routes.rolesettings.restore.matches(req, url)) return routes.rolesettings.restore.handle(req, res, url, b);

  return send(res, 404, { error: 'not found' });
}


function serveStatic(req, res, pathname) {
  if(pathname==='/extensions-ui.css')return send(res,200,extensionCSS,TYPES['.css']);
  if(pathname==='/extensions-ui.js')return send(res,200,extensionUI,TYPES['.js']);
  if(pathname==='/locale-config.js')return send(res,200,configScript(),TYPES['.js']);
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  return staticFiles.send(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream', send);
}

// 外から（tailscale serve 越し）の要求：オフなら断る。オンなら合言葉で入った札が要る
async function remoteGate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!remote.enabled()) return isApi ? send(res, 403, { error: lt('外からの利用はオフです') }) : send(res, 403, remoteLib.offPage(), 'text/html; charset=utf-8');
  // 書き換える操作は、この画面から送った物だけ（ほかのサイトから送らせない）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin, hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => `https://${h}`);
    if (req.headers['x-hub'] !== '1' || (origin && !hosts.includes(origin))) return send(res, 403, { error: 'forbidden' });
  }
  if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, remoteLib.loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: lt('形式が違います') }); }
    const who = remoteLib.whoOf(req), r = remote.login(b.passcode, who, req.headers['user-agent'], { deviceToken: remoteLib.cookieOf(req, remoteLib.DEVICE), enrollment: b.enrollment });
    record('remotelogin', {}, { ok: Boolean(r.ok), who });
    if (!r.ok) return send(res, r.status, { error: r.error });
    res.setHeader('Set-Cookie', [remoteLib.sessionCookie(r.token), remoteLib.deviceCookie(r.deviceToken)]);
    return send(res, 200, { ok: true });
  }
  const token = remoteLib.cookieOf(req);
  if (!remote.check(token)) {
    if (isApi) return send(res, 401, { error: lt('ログインしてください'), login: true });
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end();
  }
  // iPhone で開くアドレスは、合言葉で入った端末の通信からだけ覚える（未ログインの通信に書き換えさせない）
  remote.noteHost(req.headers['x-forwarded-host'] || req.headers.host);
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    remote.logout(token); record('remotelogout', {});
    res.setHeader('Set-Cookie', remoteLib.clearCookie());
    return send(res, 200, { ok: true });
  }
  if (['/api/remote/enrollment','/api/remote/forget-devices','/api/local-auth/launch'].includes(url.pathname)) return send(res, 403, { error: 'local owner only' });
  if (isApi) return api(req, res, url);
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  return serveStatic(req, res, url.pathname);
}

async function quickStart(b, maintenanceRequest = false) {
  const reply = (status, body) => ({ status, body });
  const p = store.readProject(b.project), text = String(b.text || '').trim();
  const automatic = !b.model && specialMode.pick(modelView.special(), rolesData(), p?.phases.find(x => x.state !== '完了')?.role || '司令塔');
  if (automatic && ['claude', 'claude-code', 'codex'].includes(b.ai)) b = { ...b, ...automatic };
  const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
  const agents = new Set([...rolesData().agents, ...store.listProjects().flatMap(x => x.tasks.map(t => t.owner).filter(o => o && !/claude|codex|agy|grok|^chatgpt$|^dot$|^(人|あなた)$/i.test(o)).map(o => o.replace(/^discord:\s*/i, '')))]);
  const agent = typeof ai === 'string' && ai.startsWith('discord:') && agents.has(ai.slice(8));
  if (!p || (!text && !(b.images || []).length) || (!launch.AIS.includes(ai) && !agent)) return reply(400, { error: lt('依頼と担当を確認してください') });
  if ((!maintenanceRequest && text.length > 4000) || !Array.isArray(b.images) || b.images.length > 10) return reply(400, { error: lt('依頼は4000文字、画像は10枚までです') });
  if (!agent && aiTools.isOperating(ai)) return reply(409, { error: lt('AI の更新・モデル再取得が進行中です') });
  const ph = p.phases.find(x => x.state !== '完了');
  const spec = agent ? { model: '', effort: '' } : pickSpec({ role: ph?.role, model: b.model, effort: b.effort }, ai);
  const invalid = !agent && modelError(ai, spec.model);
  if (invalid) return reply(409, { error: invalid });
  const receiptFile = path.join(p.dir, '.ai', 'start-request.json');
  let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { /* 初回 */ }
  if (b.request && receipt?.request === b.request && receipt.result) return reply(200, receipt.result);
  const writeReceipt = value => { if (b.request) { fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); require('./lib/integration-writes').write(receiptFile,()=>fs.writeFileSync(receiptFile, JSON.stringify({ request: b.request, ...value }))); } };
  let t;
  try {
    for (const id of b.images) if (!fs.existsSync(start.imageFile(p, id))) throw Error(lt('添付画像が見つかりません'));
    // 途中で失敗しても同じ作業を再開し、重複作成を防ぐ。
    if (b.request && receipt?.request === b.request) b.task = receipt.task;
    t = b.task && store.taskFile(p.id, b.task) ? store.readTask(store.taskFile(p.id, b.task)) : null;
    if (t && chats.busy(p.id, t.id)) throw Error(lt('この作業はすでに始まっています'));
    t ||= store.createTask(p.id, { title: (text.split('\n')[0] || lt('画像を確認する')).slice(0, 40), owner: agent ? ai : launch.AI_KEY[ai], role: ph?.role || '', phase: ph?.name || '' });
    writeReceipt({ task: t.id });
    const { dir, note } = startDir(p, t);
    const images = start.copyImages(p, b.images, dir, t.id);
    store.updateTask(p.id, t.id, { owner: agent ? ai : launch.AI_KEY[ai], ...spec });
    const prompt = start.imagePrompt(ai, text || lt('添付画像を確認してください。'), images);
    const file = store.taskFile(p.id, t.id);
    if (agent) {
      const notice = lt('Discordへの自動送信は未対応です。依頼文と画像の場所を保存しました。Discordで担当へ渡してください。');
      store.updateTask(p.id, t.id, { state: '返事待ち', question: notice, memo: prompt });
      chat.append(p.dir, t.id, { role: 'user', to: ai, text: prompt });
    } else {
      const basePrompt = taskPrompt(p, t, file, dir);
      const turn = { request: b.request, role: t.role, project: p.id, task: t.id, pdir: p.dir, dir, ai, account: requestAccount(p, t.id, ai), ...spec, text: prompt, images, basePrompt, policy: modelPolicy(p, t), perm: permCmd(ai), onEnd: row => {
        if (row.asks?.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).join(' / ').slice(0, 300) });
        chatEnded(p.id, t.id);
      } };
      if (!DRY && !(await (await chats.send(turn)).started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
      store.updateTask(p.id, t.id, { state: '実行中', question: '', memo: images.length ? '参照画像: ' + images.join(' / ') : '' });
      if (DRY) t.turn = chat.buildTurn({ ...turn, fast: false, rows: [], meta: {} });
    }
    start.saveSpec(p, { ai, ...spec });
    record('quickstart', { project: p.id, task: t.id, ai }, { ...spec, images });
    const result = { ok: true, task: t.id, agent, note, images, ...(DRY ? { dry: true, turn: t.turn } : {}) };
    writeReceipt({ task: t.id, result });
    return reply(200, result);
  } catch (e) { return reply(409, { error: e.message, task: t?.id }); }
}

const ownerIndex = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const server = http.createServer(async (req, res) => {
  try {
    require('./lib/platform/win32-window-policy').applyWindowPolicy(res, {
      platform: platform.name, launch: process.env.HUB_WINDOW_LAUNCH, port: PORT,
    });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (remoteLib.isRemote(req)) {
      if (!remoteLib.validRemote(req, req.headers.host)) { req.resume(); return send(res, 403, { error: 'unrecognized proxy' }); }
      // Recover from an obsolete saved name without trusting arbitrary proxy headers.
      const savedHostMatches = remoteLib.validRemote(req, remote.load().host);
      if (!savedHostMatches && !remoteLib.validRemote(req, new URL(await tailscaleUrl() || 'https://invalid').host)) { req.resume(); return send(res, 403, { error: 'unrecognized proxy' }); }
    }
    const navigation = localAuth.ping(req.headers['x-hub-navigation']);
    if (navigation.proof) { res.setHeader('X-Hub-Instance', navigation.instance); res.setHeader('X-Hub-Proof', navigation.proof); }
    if (!remoteLib.isRemote(req)) {
      if (await require('./lib/local-auth').launchGate(localAuth, req, res, url)) return;
      if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
      // This public document contains no owner data or credentials. Native
      // windows supply a verified header to receive a fresh browser session.
      if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
        const html = localAuth.authenticated(req) ? ownerIndex.replace('<head>', '<head>' + localAuth.bootstrap()) : ownerIndex;
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/ping' && !localAuth.authenticated(req)) return send(res, 200, { ok: true, ...localAuth.ping(url.searchParams.get('challenge')) });
      if (!localAuth.authenticated(req)) {
        if (!url.pathname.startsWith('/api/') && !['/', '/index.html'].includes(url.pathname)) return serveStatic(req, res, url.pathname);
        req.resume();
        return url.pathname.startsWith('/api/') ? send(res, 401, { error: 'Open Project Hub from its app or launcher' }) : send(res, 401, require('./lib/local-auth').lockedPage, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/local-auth/launch') return send(res, 200, { ticket: localAuth.issue() });
      url.searchParams.delete('hubResource'); req.url = url.pathname + url.search;
    }

    // Local owner authentication finished.
    if (url.pathname.startsWith('/api/move/')) {
      if (remoteLib.isRemote(req) || !allowed(req) || req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
      if (req.method === 'GET' && url.pathname === '/api/move/status') return send(res, 200, move.status());
      if (req.method === 'POST' && url.pathname === '/api/move/export') {
        const body = await readBody(req);
        if (move.running || await move.strictBusy()) return send(res, 409, { error: 'AI・順番待ち・保存・更新が終わってから引っ越してください' });
        const pending = move.export(body); pending.catch(() => {}); return send(res, 202, move.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/move/reveal') {
        await readBody(req);
        const target = move.status().path;
        if (!target || path.dirname(target) !== move.inbox || !fs.existsSync(target)) return send(res, 409, { error: '作成済みの引っ越しデータがありません' });
        if (platform.name === 'darwin' && !DRY) platform.revealPath(target, false, { absolute: true }).catch(() => {});
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/move/trash') return send(res, 200, await move.trash(await readBody(req)));
      return send(res, 409, { error: '読み込みは引っ越しデータを置いてアプリを開き直してください' });
    }
    if (move.running && url.pathname !== '/api/ping') return send(res, 409, { error: '引っ越しデータを作成しています。終了までお待ちください' });
    if(req.method!=='GET'&&!ideaSaveRoute(url.pathname)&&!url.pathname.startsWith('/api/task/history/')&&!['/api/ai/stop','/api/ai/resume','/api/chat/stop','/api/term/stop','/api/task/read','/api/task/body/apply','/api/task/body/recover','/api/task/body/summary','/api/task/continue','/api/task/continue/recover','/api/restart','/api/restart/cancel'].includes(url.pathname)){
    let release;try{release=taskHistory.hold();req.historyWrite=release;}catch(e){return send(res,409,{error:e.message});}
    res.once('finish',release);res.once('close',release);
  }
    if (remoteLib.isRemote(req)) return await reqCtx.run({ remote: true }, () => remoteGate(req, res, url));
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    return send(res, e.status || 500, { error: String(e.message || e) });
  }
});

function holdStoppedQueue(project,task){chats.holdQueue(project,task);}
const emergencyStop=new (require('./lib/emergency-stop').EmergencyStop)({control:stopControl,chats,sessions,webchat,muse:museDirect,onPause:scope=>{
  const scopes=scope?[scope]:[...new Map([...chats.running.values()].map(r=>r.options).filter(Boolean).map(o=>[JSON.stringify([o.project,o.task]),o])).values()];
  for(const o of scopes)record('chatstop',o);
},unmanaged:()=>{
  const terminalPids=new Set([...sessions.map.values()].map(s=>s.identity?.pid).filter(Boolean));
  return procwatch.list().filter(p=>p.project&&!chats.supervisedPid(p.pid)&&!terminalPids.has(p.pid)&&!procwatch.hasAncestor(p.pid,pid=>chats.supervisedPid(pid)||terminalPids.has(pid)));
},ancillary:(scope,errors)=>{
  const attempt=fn=>{try{fn();}catch(e){errors.push(e.message);}};
  const scopes=scope?[scope]:[...new Map([...emergencyStop.targets(),...store.listProjects().flatMap(p=>(p.tasks||[]).map(t=>({project:p.id,task:t.id})))].map(o=>[JSON.stringify([o.project,o.task]),o])).values()];
  for(const o of scopes){attempt(()=>holdStoppedQueue(o.project,o.task));attempt(()=>chats.onStop?.(o.project,o.task));attempt(()=>discussion.stop(o.project,o.task));attempt(()=>integrateAuto.stop(o.project,o.task));}
  attempt(()=>{const p=fs.existsSync(ROLES_FILE)?roleHistory.load(ROLES_FILE).journal.review:null;if(p&&(!scope||p.project===scope.project&&p.task===scope.task))roleReview.cancel?.();});
}});

emergencyRestart=new (require('./lib/emergency-restart').EmergencyRestart)({control:stopControl,stop:()=>emergencyStop.stop(),restart:restartControl,boot:HUB_INSTANCE,
  target:()=>{
    const head=gitw.savedHead(__dirname);
    if(!head||head!==BOOT_HEAD||readVersion()!==VERSION||appUpdate.restartNeeded)throw Error('稼働中と保存済みのHubが異なります。別版へは自動で切り替えません');
    return {head,version:VERSION,dir:__dirname};
  },conflicts:()=>mainMergeFlow.blockers(path.resolve(__dirname,'..'))});
function safeShutdown(){
  if(stopControl.error||stopControl.active||stopControl.data.errors?.length||stopControl.results.some(r=>!['exited','not-started'].includes(r.state)||r.save!=='saved')||chats.running.size||sessions.list().some(s=>s.running)||webchat.busy().length||museDirect.busy().length||webchat.control||chats.guardErrors().length||activeRequests||taskHistory.activeWrites.size||freetalkHistory.activeWrites?.size||taskIntegrate.active||integrateAuto.active||executionGate.leases.size||appUpdate.running||['installing','publishing'].includes(appUpdate.data.phase)||aiTools.isOperating())return false;
  const unknown=emergencyStop.targets();if(!unknown.length)return true;
  const P=require('./lib/owned-processes'),rows=P.snapshot(),terminalPids=new Set([...sessions.map.values()].map(s=>s.identity?.pid));
  return unknown.every(o=>o.kind==='unmanaged'&&P.independentExternal(procwatch.list().find(p=>p.pid===o.pid)||{},rows,pid=>chats.supervisedPid(pid)||terminalPids.has(pid)));
}
async function shutdown({graceful=false}={}) {
  executionGate.barrier=true;
  try{const safe=await chats.withStrictHandoff(()=>safeShutdown());if(graceful&&!safe)throw Error('終了の直前に状態が変わりました。Hubは終了していません');if(safe)stopControl.cleanExit();}
  catch(e){if(graceful){executionGate.barrier=false;record('quit-handoff-error',{}, {error:e.message});return;}}
  museDirect.scheduler.stop();webchat.shutdown();aiUpdates.stop();appUpdate.stop();procwatch.stop();sessions.stopAll();chats.stopAll();server.close();process.exit(0);
}

roleReview = extensions.create('role_review', { license:Object.freeze({require:features=>license.require(features)}), file:ROLES_FILE, store, chats, tools:aiTools, accounts, usage, limits:limitEvidence, accountFor,
  createTopic:()=>freetalk.createTopic(specialMode.pick(modelView.special(), rolesData(), '司令塔') || modelView.initial(), {title:lt('役割分担の見直し')}),
  applyCatalog:applyModelCatalog, migrated:task=>freetalkHistory.state(task).migrated,
  workDir:isolatedReviewDir, ended:chatEnded,
  blocked:p=>Boolean(stopControl.held(p)||restartControl?.committed || appUpdate.applying() || delegateTerminalError(p.project,p.task) || webchatActive(p.project,p.task)),
  notice:(message,last)=>record('role-review',{}, {message,status:last?.status}) });
if(fs.existsSync(ROLES_FILE)) roleReview.recover();
const roleReviewTimer=setInterval(()=>{if(fs.existsSync(ROLES_FILE))void roleReview.tick().catch(e=>record('role-review-error',{}, {error:e.message}));},1500);roleReviewTimer.unref();
const userDelegate=extensions.create('delegate',{license:Object.freeze({prepare:()=>license.prepare()}),licenseGuard,deliver:userDelivery,lt,roles,executionRoles,PORT});
discussion = extensions.create('discussion', { license:Object.freeze({require:features=>license.require(features)}), file:path.join(ROOT,'_hub','discussions.json'), store, chats, tools:aiTools, accounts, usage, limits:limitEvidence, accountFor, modelError,
  notice:message=>record('discussion-error',{}, {error:message}),
  migrated:(p,t)=>p.kind==='freetalk'&&freetalkHistory.state(t.id).migrated, workDir:isolatedReviewDir, ended:chatEnded,
  blocked:p=>Boolean(stopControl.held(p)||restartControl?.committed||appUpdate.applying()||delegateTerminalError(p.project,p.task)||webchatActive(p.project,p.task)) });
const ideaAutomationHost={ideas,store,baseOf,executionGate,chats,ROOT,rolesData,DRY,delegateRequest,gitw,stopControl,webchatActive,sessions,record};
const ideaAutomation=extensions.state().included.includes('idea_automation')
  ? extensions.create('idea_automation',ideaAutomationHost)
  : require('./lib/idea-unavailable').create(ideaAutomationHost);
({lane:ideaLane,release:ideaRelease,dispatch:ideaDispatch,runner:ideaRunner}=ideaAutomation);
const {verification:ideaVerification,review:ideaReview}=ideaAutomation;
Object.assign(ideaAPI,{runner:ideaRunner,lane:ideaLane,release:ideaRelease,automation:ideaAutomation.handle,available:()=>extensions.state().included.includes('idea_automation'),wake:p=>{if(!DRY)ideaRunner.wake(p);},authorizeRecord:(req,b)=>ideaDispatch.authorizeRecord(req,b)||[...chats.running.values()].some(x=>x.options?.project===b.project&&x.options?.ideaRecord?.token===req.headers['x-idea-record'])});
ideaRunner.restore();
for(const e of queueRetreat.restore())record('queue-retreat-recovery',e,{error:e.error});
// Recover only unavailable features, before adoption can resume saved work.
// Keep the existing journal/queue writers: an unconfirmed cleanup aborts boot.
const includedExtensions=extensions.state().included;
if(!includedExtensions.includes('role_review')&&fs.existsSync(ROLES_FILE)){
  const pending=roleHistory.load(ROLES_FILE).journal.review;
  if(pending){
    if(pending.task)for(const q of chats.queue(pending.project,pending.task))if([pending.request,`limit-${pending.request}`].includes(q.id))chats.unqueue(pending.project,pending.task,q.id,true);
    const message=lt('Hubの再起動で見直しを中断しました。設定と最終見直し日時は維持しています');
    roleHistory.updateReview(ROLES_FILE,pending.id,j=>{j.lastReview={project:j.review.project,task:j.review.task,at:new Date().toISOString(),status:'failed',message};j.review=null;});
    record('role-review',{}, {message,status:'failed'});
  }
}
if(!includedExtensions.includes('discussion'))for(const p of store.listProjects())for(const t of p.tasks){
  const queue=chats.queue(p.id,t.id),remaining=queue.filter(q=>!/^(?:limit-)*discussion-/.test(q.id));
  if(remaining.length!==queue.length)chats.setQueue(p.id,t.id,remaining,true);
}
// These flags were assigned by the internal dispatcher, not copied from HTTP.
const legacyInternalDelivery=q=>q.origin==='delegate'&&!q.automation&&Boolean(q.selectionOnly||q.resultsOrganize||q.integrationAssignment||q.integrationReviewRequest);
for(const p of store.listProjects())for(const t of p.tasks){
  const queue=chats.queue(p.id,t.id);
  const remaining=queue.filter(q=>q.origin!=='delegate'||q.automation||legacyInternalDelivery(q)||includedExtensions.includes('delegate'))
    .map(q=>legacyInternalDelivery(q)?{...q,origin:'hub-internal'}:q);
  if(JSON.stringify(remaining)!==JSON.stringify(queue)){
    chats.setQueue(p.id,t.id,remaining,true);
    if(remaining.length!==queue.length)record('delegate-unavailable',{project:p.id,task:t.id},{removed:queue.filter(q=>!remaining.some(x=>x.id===q.id)).map(q=>q.id)});
  }
}
const restoreReady=Promise.resolve(chats.adopt()).then(()=>Promise.all([...chats.running.values()].filter(r=>r.child?.dir&&require('./lib/cli-spool').strictRead(r.child.dir,'exit.json')).map(r=>r.settledP))).then(()=>{ideaRunner.restored();chats.resumeDeferred();for(const p of store.listProjects())for(const t of p.tasks)try{chats.recoverContinuations(p,t);}catch(e){record('chat-continuation-error',{project:p.id,task:t.id},{error:e.message});}if(!DRY)ideaRunner.start();updateRestoreReady=true;});
restoreReady.catch(e=>record('idea-restore-error',{}, {error:e.message}));
discussion.recover();
const discussionTimer=setInterval(()=>{void discussion.tick().catch(e=>record('discussion-error',{}, {error:e.message}));},1000);discussionTimer.unref();
if (require.main === module) {
  // 新しい版に切り替える時は、前の本体が待ち受けを空けるまで少し待つ
  let tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && process.env.HUB_RESTART_WAIT && tries++ < 50) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 200);
    console.error(e.code === 'EADDRINUSE' ? lt`ポート ${PORT} は使われています（もう起動しているかもしれません）` : e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    if(!DRY) museDirect.scheduler.start(({project,task})=>{
      const p=store.readProject(project);
      if(!p?.tasks.some(t=>t.id===task&&t.state!=='完了'))return null;
      return p.kind==='freetalk'?freetalkHistory.state(task).generation:taskHistory.state(project,task).generation;
    });
    console.log(`Project Hub ${VERSION}`);
    console.log(lt`Project Hub: http://127.0.0.1:${PORT}  （台帳の場所: ${ROOT}）`);
    console.log(sessions.available() ? lt('作業画面: 使えます') : lt('作業画面: 部品（node-pty）が未設定。setup.sh を実行してください'));
    console.log(lt('止める時は、この窓で Control + C'));
    if (!DRY) { license.start(); procwatch.start(); appUpdate.start(); aiUpdates.start(); }
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

server.on('listening', () => require('./lib/local-auth').activateServer(localAuth, server));
process.once('exit', () => localAuth.close());
server.on('close', () => { localAuth.close(); bodyClosed=true;clearInterval(bodyTimer);chats.handoffScanner?.close();chats.handoffAdmission?.close(); museDirect.scheduler.stop();conversationSearch.close(); ideaRunner?.close();ideas.close(); license.stop(); clearInterval(discussionTimer); clearInterval(roleReviewTimer);clearInterval(freetalkAutomaticTimer);stateOffers.close(); clearInterval(integrateTimer);clearInterval(terminalLimitTimer);clearInterval(restartTimer); aiUpdates.stop(); });
module.exports = { localAuth, queueRetreat, store, stopControl, emergencyStop, emergencyRestart, safeShutdown, ideas, ideaAPI, executionGate, ideaRunner, ideaDispatch, ideaLane, ideaRelease, ideaVerification, ideaReview, restoreReady, discussion, roleReview, textBudget, server, PORT, sessions, taskPrompt, aiUpdates, webchat, chats, restartControl, taskIntegrate, integrateAuto, integrationAbandon, bootModules, restartBlockers };
