'use strict';
const { lt, locale, config:localeConfig, configScript } = require('./lib/locale');
// Project Hub 第2版：台帳の一覧、画面の中の作業画面、役割・モデル・思考の設定
// 使い方: node server.js  →  http://127.0.0.1:4545
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store, expandHome } = require('./lib/store');
const launch = require('./lib/launch');
const roles = require('./lib/roles');
const { Sessions } = require('./lib/sessions');
const gitw = require('./lib/git');
const transcript = require('./lib/transcript');
const chat = require('./lib/chat');
const start = require('./lib/start');
const { AiTools } = require('./lib/ai-tools');
const { Onboarding } = require('./lib/onboarding');
const { Usage } = require('./lib/usage');
const { LimitEvidence } = require('./lib/limit-evidence');
const remoteLib = require('./lib/remote');
const { guidance } = require('./lib/guidance');
const instructions = require('./lib/instructions');
const { AsyncLocalStorage } = require('async_hooks');

const PORT = Number(process.env.HUB_PORT || 4545);
const ROOT = expandHome(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'AI-Workspace'));
const DRY = process.env.HUB_DRY_RUN === '1'; // テスト用：実際には起動しない
const accounts = new (require('./lib/accounts').Accounts)({ file: path.join(ROOT, '_hub', 'accounts.json'), dry: DRY, busy: accountBusy });
launch.setAccounts(accounts);
const limitEvidence = new LimitEvidence(path.join(ROOT, '_hub', 'limits.json'));
const usage = new Usage({ dry: DRY, accounts, beforeRead: (ai, account) => accounts.available(ai, account), observe: snapshot => {
  try { limitEvidence.observe(snapshot); } catch { /* 保存失敗では直前の保持状態を維持 */ }
} });
async function refreshLimitEvidence(request) {
  if (request.ai !== 'claude' || launch.flagFor('claude', request.model) !== 'claude-fable-5-1' ||
      request.limitSwitch || !fableBackup(rolesData(), request.role) || !limitEvidence.needsRefresh()) return;
  let timer;
  try {
    await Promise.race([usage.status(true, { claude: request.account || 'default' }), new Promise(resolve => { timer = setTimeout(resolve, 20000); })]);
  } catch { /* 取得失敗では上限継続として扱わない */ } finally { clearTimeout(timer); }
}
const PUBLIC = path.join(__dirname, 'public');
const ROLES_FILE = path.join(ROOT, '_hub', 'roles.yaml');
const store = new Store(ROOT);
const freetalkLib = require('./lib/freetalk');
// DRY_RUN は明示した一時 HOME または隔離 ROOT の中だけを使う。
const freetalk = new freetalkLib.Freetalk(store, DRY ? process.env.HUB_FREETALK_HOME || path.join(ROOT, '_hub/freetalk-home') : os.homedir());
const acceleration = new (require('./lib/acceleration').Acceleration)(path.join(ROOT, '_hub', 'acceleration.json'));
const projectOrder = new (require('./lib/project-order').ProjectOrder)(store);
// 外から使う（iPhone）の設定と、今の要求が外からかどうか（記録に「外から」と印を付けるため）
const remote = new remoteLib.Remote({ file: path.join(ROOT, '_hub', 'remote.json') });
const reqCtx = new AsyncLocalStorage();
const fromRemote = () => Boolean(reqCtx.getStore()?.remote);
const sessions = new Sessions();
const chats = new chat.ChatRunner({ dirOf: id => { const p = store.readProject(id); return p ? p.dir : ''; },
  delegates: (p, t) => [...readLog(5000), ...readLog(5000, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'))].filter(r => r.project === p && r.task === t),
  permFor: permCmd,
  limitBackup: o => { const backup = fableBackup(rolesData(), o.role); return backup && { ...backup, account: accountFor(o.project, o.task, backup.ai) }; },
  accountFor, fastFor: codexFastFor,
  onSettled: (o,row) => { void resultsGate.trigger(o.project,o.task,{row,organized:Boolean(o.resultsOrganize)}).catch(e=>record('results-organize-error',{project:o.project,task:o.task},{error:e.message})); },
  limitPreflight: o => limitEvidence.active(o.account || 'default'),
  beforeQueued: refreshLimitEvidence,
  onLimit: o => {
    try { limitEvidence.record(o); }
    catch (e) { record('limit-save-error', o); throw e; }
    void usage.status(true, { claude: o.account || 'default' }).catch(() => {});
  },
  onFableSuccess: started => limitEvidence.success(started),
  refreshQueued: o => {
    const p = store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
    if (!p || !t) throw Error(lt('作業が見つかりません'));
    if(o.readOnly)return {dir:p.dir,basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。')};
    const dir = o.dir && fs.existsSync(o.dir) ? o.dir : workDir(p, t).dir;
    if (!dir || !fs.existsSync(dir)) throw Error(lt('作業場所を用意できませんでした'));
    return { dir, policy: modelPolicy(p, t), basePrompt: taskPrompt(p, t, store.taskFile(p.id, t.id), dir) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。') };
  },
  canStart: (ai, model, o) => {
    if (appUpdate.applying()) return appUpdate.busyMessage();
    if (aiTools.isOperating()) return lt('AI の更新・モデル再取得が進行中です');
    const invalid=modelError(ai,model); if(invalid)return invalid;
    if(o) { const p=store.readProject(o.project), t=p?.tasks.find(t=>t.id===o.task);
      if(!p || !t)return lt('作業が見つかりません');
      if(p.kind==='freetalk' && freetalkHistory.state(t.id).migrated)return lt('移行済みの話題は読み取り専用です');
      if(o.resultsRecoveryHash && t.completionHash!==o.resultsRecoveryHash)return lt('成果整理の開始前に子作業が変わりました');
      if(o.requireModel && t.state === '完了' && !o.resultsRecoveryHash)return DELEGATE_COMPLETED_ERROR;
      if(o.requireModel) {const blocked=delegateTerminalError(p.id,t.id);if(blocked)return blocked;}
      try { accounts.available(ai, o.account || 'default'); } catch (e) { return e.message; }
      try {assertWorkspaceIdle(p,t,false);} catch(e) {return e.message;}
    }
    return '';
  } });
const { Maintenance } = require('./lib/maintenance');
const emptyLib = require('./lib/empty');
const maintenance = new Maintenance({store,baseOf,busy:id=>{
  const p=store.readProject(id);if(!p)return false;
  if (problemResolution.starting.has(id)) return true;
  const all=store.listProjects(), familyIds=require('./lib/work-context').family(p,all).map(q=>q.id);
  const base=fs.realpathSync(baseOf(p));
  if (github.locked(base)) return true;
  const active=[...sessions.list().filter(x=>x.running),...[...chats.running.keys()].map(k=>({project:k.split('\u0000')[0]}))];
  return procwatch.list().some(x=>x.project && (familyIds.includes(x.project)||all.some(q=>q.id===x.project&&fs.realpathSync(baseOf(q))===base))) || active.some(a=>{const q=all.find(x=>x.id===a.project);return q && (familyIds.includes(q.id) || fs.realpathSync(baseOf(q))===base);});
}});
const {Removal}=require('./lib/remove');
const removal=new Removal({store,reviewBusy:id=>removalReview.active(id),locked:id=>{const p=store.readProject(id);return p?maintenance.locked(id):false;},busy:(project,task)=>
  sessions.list().some(x=>x.running&&x.project===project&&(!task||x.task===task)) ||
  [...chats.running.keys()].some(k=>k.split('\u0000')[0]===project&&(!task||k.split('\u0000')[1]===task)) ||
  procwatch.list().some(x=>x.project===project&&(!task||!x.task||x.task===task))});
const removalReview=new (require('./lib/removal-review').RemovalReview)({store,removal,
 busy:(p,t)=>Boolean(chats.busy(p,t)),queued:(p,t)=>chats.queue(p,t).length>0,
 rows:(p,t)=>{const dir=store.readProject(p)?.dir;return dir?chat.read(dir,t):[];},
 start:async o=>{
  const p=store.readProject(o.project),t=p.tasks.find(t=>t.id===o.task),account=requestAccount(p,t.id,'claude');
  const model='claude-fable-5-1',invalid=modelError('claude',model);if(invalid)throw Error(invalid);
  const turn={...o,ai:'claude',model,account,effort:'高',role:'チェック',requireModel:true,requiredModel:model,
   basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')};
  chats.enqueue(p.id,t.id,{...turn,id:o.request});
  try{const r=await chats.sendQueued(turn);chats.unqueue(p.id,t.id,o.request);return r;}
  catch(e){chats.unqueue(p.id,t.id,o.request);throw e;}
 }});
const aiTools = new AiTools({ root: ROOT, dry: DRY, busy: () => sessions.list().filter(x => x.running).length + chats.running.size });
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
function changelog(n) {
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, locale()==='zh-TW'?'CHANGELOG.zh-TW.md':'CHANGELOG.md'), 'utf8'); } catch (e) { return []; }
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

function delegateTerminalError(project, task) {
  const terminals = sessions.list().filter(s => s.project === project && s.task === task && s.running);
  if (!terminals.length) return '';
  const names = [...new Set(terminals.map(s => launch.AI_LABEL[s.ai] || s.ai))].join('・');
  return lt`この作業のターミナルで AI（${names}）が動いているため、委任できません。人に「この作業の作業画面で［ターミナル］に切り替え、${names}の欄の［停止］を押してから、会話でもう一度頼んでください」と案内してください。会話画面の［停止］は押させない（待っている指示も取り消されます）。裏で別の CLI を起動したり、この依頼を繰り返し送ったりしないでください。`;
}

// 人が承認した例外は司令塔・チェックの Fable → Astra だけ。別の予備担当には広げない。
function fableBackup(data, role) {
  if (data.switch.auto !== true || (role && !['司令塔', 'チェック'].includes(role))) return null;
  const r = data.roles.find(r => ['司令塔', 'チェック'].includes(r.name) && (!role || r.name === role) &&
    r.main.ai === 'claude-code' && launch.flagFor('claude', r.main.model) === 'claude-fable-5-1' &&
    r.backup.ai === 'codex' && launch.flagFor('codex', r.backup.model) === 'gpt-6-astra' && roles.EFFORTS.includes(r.backup.effort));
  return r ? { ai: 'codex', model: launch.modelLabel('codex', r.backup.model), effort: r.backup.effort, role: r.name,
    requireModel: true, requiredModel: 'gpt-6-astra', perm: permCmd('codex') } : null;
}
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
  store, maintenance, pick: () => modelView.initial(),
  validate: pick => { if (aiTools.isOperating()) throw Error(lt('AI の更新・モデル再取得が進行中です')); const error = modelError(pick.ai, pick.model); if (error) throw Error(error); },
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
sessions.onExit = (project, task, ai, s) => { if (!s?.stopped && !(s?.watchers.size > 0)) setUnread(project, task, true); };
// ChatGPT との連携：mcp.js から /api/mcp/* で呼ばれる道具。報告は会話画面にも流し、未読にする
// 子プロジェクトの結果を親へ渡す（親の受け取る作業に書き、会話に流し、未読にする）。失敗しても元の操作は続ける
const handoff = require('./lib/handoff');
function reportChild(child, kind, text) {
  try { return handoff.reportToParent(store, child, { kind, text }, { record, unread: chatEnded, emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }) }); }
  catch (e) { console.log(lt`[親への報告] ${e.message}`); return false; }
}
// 裏で動いている AI（チャットの AI が nohup などで起動した codex / claude / agy / grok）。終わったら、その作業を未読にする
const procwatch = require('./lib/procwatch').create({ projects: () => store.listProjects(), baseOf });
procwatch.onChange((list, { removed }) => {
  for (const x of removed) {
    if (!x.project) continue;
    let task = x.task;
    if (!task) { try { task = store.listProjects().find(p => p.id === x.project)?.tasks.find(t => t.state !== '完了')?.id; } catch (e) { task = null; } }
    if (!task) continue;
    setUnread(x.project, task, true);
    record('bgended', { project: x.project, task, ai: x.ai }, { pid: x.pid });
  }
});
const gpt = new (require('./lib/chatgpt').Chatgpt)({ file: path.join(ROOT, '_hub', 'chatgpt.json'), store, chat, baseOf, record,
  emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }), ended: (project, task) => chatEnded(project, task) });

const github = require('./lib/github').createGithub({ settingsFile: path.join(ROOT, '_hub', 'github.json'), dry: DRY,
  idle: p => {
    assertWorkspaceIdle(p, { workspaceMode: 'isolated' }, false, true);
    const canonical = d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const base = canonical(baseOf(p));
    const all = store.listProjects();
    const active = [...sessions.list().filter(s => s.running), ...[...chats.running.keys()].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }), ...procwatch.list()];
    if (active.some(a => {
      const q = all.find(x => x.id === a.project); if (!q || canonical(baseOf(q)) !== base) return false;
      const t = q.tasks.find(x => x.id === a.task);
      return !t || t.workspaceMode === 'direct' || !t.workdir || canonical(expandHome(t.workdir)) === base;
    })) { const e = Error(lt('同じ本体でAIが作業中です。終わってから作ってください')); e.status = 409; throw e; }
  }
});
const githubProject = p => ({ ...p, base: baseOf(p) });
// queue() reloads saved requests too, including the permanent freetalk project.
const updateBusy = () => aiTools.isOperating() || sessions.list().some(x => x.running) || chats.running.size > 0 || procwatch.list().length > 0 ||
  [...chats.queues.values()].some(q => q.length > 0) || store.listProjects().some(p => maintenance.locked(p.id) || github.locked(baseOf(p)) || p.tasks.some(t => chats.queue(p.id, t.id).length > 0));
const updateSource = process.env.HUB_UPDATE_SOURCE || '';
// B installs the automation mechanism; C supplies the translation catalogs.
const translationReady = ['hub/lib/locale.js', 'hub/locales/zh-TW.json'].every(file => fs.existsSync(path.join(updateSource, file)));
const automation = process.env.HUB_AUTO_TRANSLATE === '1' && process.env.HUB_TRANSLATION_FORK && translationReady
  ? require('./lib/app-update-workflow').createAutomation({ root: ROOT, env: process.env }) : {};
const appUpdate = new (require('./lib/app-update').AppUpdate)({ root: ROOT, source: updateSource,
  appPath: process.env.HUB_UPDATE_APP || '', env: process.env, dry: DRY, busy: updateBusy, ...automation });

function permCmd(ai) {
  const p = rolesData().permissions || {};
  if (ai === 'agy' || ai === 'grok') return launch.DEFAULT_CMD[ai];
  const v = p[launch.AI_KEY[ai]];
  return typeof v === 'string' && /^(claude|codex)\b/.test(v) ? v : launch.DEFAULT_CMD[ai];
}

// 作業の役割 → いつもの担当（AI・モデル・思考）。作業ファイルに指定があればそちら
function pickSpec(task, ai) {
  if (ai === 'agy') return { model: launch.AGY_MODEL.label, effort: '高' };
  const data = rolesData();
  const r = data.roles.find(x => x.name === task.role);
  const slot = r ? (r.main.ai === (launch.AI_KEY[ai]) ? r.main : r.backup.ai === (launch.AI_KEY[ai]) ? r.backup : null) : null;
  // 作業に指定があれば、候補から消えていても別のモデルへ置き換えない。
  const model = launch.modelLabel(ai, task.model || (slot && slot.model) || '');
  const effort = roles.EFFORTS.includes(task.effort) ? task.effort : (slot && slot.effort) || '';
  return { model, effort };
}

function modelError(ai, model) {
  model = launch.modelLabel(ai, model);
  if (ai === 'agy') {
    const route = launch.agyAccountError();
    if (route) return route;
    if (launch.flagFor(ai, model) !== launch.AGY_MODEL.id) return lt('Agy で承認されているモデルは Gemini 3.1 Pro (High) だけです');
    if (!aiTools.catalog().agy.models.some(x => x.id === launch.AGY_MODEL.id)) return lt('設定画面で Agy のモデル一覧を再取得してください。別のモデルへは切り替えません');
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
function assertWorkspaceIdle(p, t, permitChat, githubOperation = false) {
  if (appUpdate.applying()) { const error = Error(appUpdate.busyMessage()); error.status = 409; throw error; }
  if (maintenance.locked(p.id)) {const e=Error(lt('同じ本体で検証中です。終わってからAIを始めてください'));e.status=409;throw e;}
  const canonical = dir => { try { return fs.realpathSync(dir); } catch(e) { return path.resolve(dir); } };
  const base = canonical(baseOf(p));
  const chosenDir = (p,t) => {
    const wd=expandHome(t.workdir);if(wd&&fs.existsSync(wd))return wd;
    const r=taskIntegrate.read(p.id,t.id);return r&&!r.complete?r.target:wd;
  };
  const onBase = (p,t) => {
    if(t.workspaceMode==='direct')return true;
    const r=t.id&&taskIntegrate.read(p.id,t.id),dir=chosenDir(p,t);
    return Boolean(r&&!r.complete&&dir&&canonical(dir)===canonical(baseOf(p)));
  };
  const targetDirect = onBase(p,t);
  if (!githubOperation) github.assertStart(githubProject(p), { ...t, workdir: chosenDir(p,t) });
  const active = [...sessions.list().filter(s=>s.running), ...[...chats.running.keys()].map(k=>{const [project,task]=k.split('\u0000');return {project,task,chat:true};})];
  if (!active.length) return;
  const all = store.listProjects();
  for (const a of active) {
    if (permitChat && a.chat && a.project===p.id && a.task===t.id) continue;
    const q=all.find(x=>x.id===a.project), at=q?.tasks.find(x=>x.id===a.task); if(!q || !at)continue;
    if(canonical(baseOf(q))===base && (targetDirect || onBase(q,at))) {
      const e=Error(lt('同じ本体でAIが作業中です。本体での同時作業はできません'));e.status=409;throw e;
    }
  }
}
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
  notify:(project,task,id)=>{const p=store.readProject(project);const row=p&&chat.read(p.dir,task).find(x=>x.handoff===id||x.offer===id);if(row)chats.emit(project,task,{type:'row',row});chatEnded(project,task);}
});
const taskIntegrate = new (require('./lib/task-integrate').TaskIntegrate)({store,transfer:taskTransfer,removal,baseOf});
const resultsGate = new (require('./lib/results-gate').ResultsGate)({store,transfer:taskTransfer,
  blocked:(p,t)=> t.question || ['返事待ち','上限で停止'].includes(t.state) ? lt('質問・返事待ちを先に済ませてください')
    : chats.busy(p.id,t.id) ? lt('AIが作業中です') : chats.queue(p.id,t.id).length ? lt('順番待ちがあります')
    : delegateTerminalError(p.id,t.id) || (removal.busy(p.id,t.id) || removal.locked(p.id) ? lt('AI・整理・確認が動いています') : '')
    || (taskTransfer.read(p.id,t.id)?.integrating || taskIntegrate.read(p.id,t.id) && !taskIntegrate.read(p.id,t.id).complete ? lt('統合が進行中です') : ''),
  launch:async(p,t,issue)=>{
    const role=rolesData().roles.find(r=>r.name==='調査');
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
let tsCache = { at: 0, url: '' };
function tailscaleUrl() {
  if (Date.now() - tsCache.at < 60000) return Promise.resolve(tsCache.url);
  const { execFile } = require('child_process');
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  const tryAt = i => new Promise(done => {
    if (i >= bins.length) return done('');
    execFile(bins[i], ['status', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return tryAt(i + 1).then(done);
      try { const dns = String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, ''); done(dns ? 'https://' + dns : ''); } catch (e) { done(''); }
    });
  });
  return tryAt(0).then(u => { tsCache = { at: Date.now(), url: u }; return u; });
}
// 別の AI に作業を渡す時の決まり（AI が裏で codex/claude を起動すると Hub に見えず、画面では終わったことになるため）
const CHAT_DELEGATE_NOTE = lt('この委任APIは会話画面からだけ使えます。委任が「この作業のターミナルで AI が動いています」と断られた時だけ、人に次のように頼む：「この作業の作業画面で［ターミナル］に切り替え、動いている AI の欄の［停止］を押してから、もう一度この会話で頼んでください」。断られていない時は、ターミナルの停止や終了を人に頼まない。裏で別のCLIを起動したり、この依頼を繰り返し送ったりしないでください。');
const TERMINAL_LIMIT_NOTE = lt('ターミナルでは自動の引き継ぎは無い。上限で止まったら、渡す内容を作業ファイルに書いて返事を終える。人が［会話］から依頼を送った番で Fable の正式な上限が確認された時は、上の決まりで引き継がれる。');
const TERMINAL_HANDOFF_NOTE = lt('あなたはターミナルで動いている。ここからは別の AI に委任できない。渡したい時は、渡す内容と指定モデルを作業ファイルに書いて返事を終える。人には「この作業の作業画面で［会話］に切り替えて、記録した依頼を送ってください」とだけ案内する。ターミナルを止める操作は頼まない（会話から送った依頼が断られた時に、会話側の AI が案内する）。');
const DELEGATE_COMPLETED_ERROR = lt('この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません');
function delegateRule(p, t) {
  const d = rolesData(), coding = roles.delegateSlot(d, 'コーディング');
  let examples = ['チェック', '文章', '調査', 'デザイン'].map(name => { const s = roles.delegateSlot(d, name); return s ? lt`${name}は ai: ${s.ai}・model: ${s.model}` : lt`${name}は人が担当`; }).join('、');
  if (roles.delegateSlot(d, 'チェック')?.model === 'claude-fable-5-1' && ['文章', '調査', 'デザイン'].every(name => roles.delegateSlot(d, name)?.ai === 'claude' && roles.delegateSlot(d, name)?.model === 'claude-opus-5-5')) examples = lt('チェックは ai: claude・model: claude-fable-5-1、文章・調査・デザインは claude-opus-5-5');
  const ids = p && t ? `"project":"${p.id}","task":"${t.id}"` : lt('"project":"<プロジェクトID>","task":"<作業ID>"');
  return lt`【別の AI に作業を渡す時】自分で codex / claude / agy / grok を裏で起動しない。${CHAT_DELEGATE_NOTE} 会話画面で渡す時は Hub を使う：curl -s -X POST http://127.0.0.1:${PORT}/api/delegate -H 'X-Hub: 1' -H 'Content-Type: application/json' -d '{${ids},"ai":"${coding?.ai || 'codex'}","model":"${coding?.model || 'gpt-6.1-sol'}","title":"短い名前","text":"頼む内容（必要な背景も）"}'。ai は codex / claude / agy / grok。model は依頼文の中だけでなく、この欄で必ず指定する（${examples}）。Hub は同じ作業の会話で担当 AI を切り替え、今の AI が動いている間は順番待ちにする。子作業は作らない。画面に順番待ち・作業中と出て、結果もこの会話に残る。相手に「実際のモデルを確かめて違えば止まれ」と書かない。モデルは model 欄で Hub が起動設定として保証する（実際のモデルの証明ではない）。モデル名を返させる時は「起動設定のモデル名」と頼む。上記の自動交代が有効な時は、Fable が上限なら Hub が Astra に引き継ぐので、自分で別のモデルへ委任し直さない。渡したらこの番を終えること。\n【プロジェクトや作業を増やさない】新しいプロジェクト・子プロジェクト・作業ファイル（.ai/tasks）を自分で作らない。分ける必要がある時は、人に提案して決めてもらう。やっていない手順に [x] を付けない。`;
}
// 人が決めた役割とモデル（roles.yaml）。AI が他のファイル（エージェントの設定など）の古い指定に従わないよう、毎回伝える
function modelPolicy(p, t, where = 'chat', projects) {
  // startDir が保存したコピーの場所・手順なども、同じ台帳の最新値で渡す。
  const current = store.readProject(p.id);
  if (current) { p = current; t = current.tasks.find(x => x.id === t.id) || t; }
  const d = rolesData();
  const label = s => (launch.AI_LABEL[s.ai === 'claude-code' ? 'claude' : s.ai] || s.ai);
  const slot = s => { if (!s || s.ai === '人' || !s.model) return ''; const f = launch.flagFor(s.ai === 'claude-code' ? 'claude' : s.ai, s.model); return lt`${label(s)}・${s.model}${f ? `（${f}）` : ''}`; };
  const limitPolicy = fableBackup(d) ? lt('【利用上限の時】司令塔・チェックの Fable 5.1 が利用上限で止まった時だけ、Hub が同じ作業で Codex・GPT-6-Astra に自動で引き継ぐ（人の決まり、会話画面のみ）。上限かどうかは Hub が CLI のエラー構造と正式な上限文で判断し、プロセス終了後に交代する。保持中は解除日時または手動解除までHubがAstraで開始。AIは確認不要。あなたは本文の「上限」という言葉や過去の引用で担当を変えない・止まらない。人の決めた担当モデル（main）は変わらない。引き継ぎで始まった番は、済んだ部分を繰り返さず残りを続ける。') : lt('【利用上限の時】現在は自動交代がオフ、または司令塔・チェックの Fable から Astra への予備担当が設定されていない。自分で別のモデルへ切り替えない。');
  const list = d.roles.map(r => slot(r.main) ? `${roles.label ? roles.label(r.name) : require("./lib/locale").label(r.name)}＝${slot(r.main)}` : '').filter(Boolean).join('、');
  return lt`【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】${list}。役割分担で Agy CLI が担当の役割と、人が手動選択した依頼に限り Gemini 3.1 Pro (High)（gemini-3.1-pro-high）を使ってよい。既定の役割は変更しない。claude-opus-4-6 などの古いモデルは使わない。エージェント（紬・律など）に頼む時も、この決まりのモデルを指定すること。\n${limitPolicy}\n${delegateRule(p, t)}\n\n${p.kind === 'freetalk' ? '自由対話の会話画面。新しい話題は人が［新しい話題］から作る。手順・完了・統合・取り込みの操作はありません。' : guidance(p, resultsGate.decorate(p,t,projects || store.listProjects()), { where, projects: projects || (t.kind === 'derived' && t.derivedFrom?.includes('/') && !t.derivedFrom.startsWith(p.id + '/') ? store.listProjects() : [p]), copy: inWork(p, t) && !copyMissing(p, t), copyMissing: copyMissing(p, t) })}`;
}

function taskPrompt(p, t, file, dir, where = 'chat', startup) {
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
    const read = lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きを。読む：台帳/.ai/rules.md・台帳/PROJECT.md・台帳/.ai/tasks/${t.id}.md。区切りで更新、実施した手順だけ[x]（無ければ3〜5個）。workdir・state・questionは書き換えない（Hub管理）。`;
    return instructions.packet({ pdir: p.dir, project: p.id, task: t.id, roleData: rolesData(), policy: modelPolicy(p, t, where, all), issues: issuesRule, port: PORT, contextRule: launch.CONTEXT_RULE, askRule: chat.ASK_RULE,
      common: [dir ? `cwd=${dir === p.dir ? '台帳' : '台帳/' + path.relative(p.dir, dir).split(path.sep).join('/')}。${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? lt('専用の作業用コピー。ここだけで作業。本体には触らない（取り込みは人の［本体に取り込む］）。') : lt('本体。コピーは使わず、ここで作業してよい（Hub指定）。')}` : '', look, context, read].filter(Boolean).join('\n') });
  }
  return [modelPolicy(p, t, where, all), where === 'terminal' ? TERMINAL_HANDOFF_NOTE + '\n' + TERMINAL_LIMIT_NOTE : '', where === 'terminal' && startup ? launch.startupInfo(startup.ai, startup.model, undefined, codexFastFor(p.id, t.id)) : '', launch.CONTEXT_RULE, copy, look, context, issuesRule, lt`作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きをしてください。まず次の3つを読むこと: ${path.join(p.dir, '.ai', 'rules.md')} / ${path.join(p.dir, 'PROJECT.md')} / ${file}。区切りごとに作業ファイルを更新し、「## 手順」の終わった所を [x] にすること（手順が無ければ3〜5個書く）。作業ファイルの先頭の workdir・state・question の行は Hub が管理する：書き換えない（特に、取り込み済みの後に古い内容で書き戻さない）。`].filter(Boolean).join('\n\n');
}

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
  const id = supplied ?? accountFor(p.id, task, ai); accounts.available(ai, id); return id;
}
function accountBusy(ai, id) {
  if (usage?.inflight?.has(usage.key(ai, id))) return true;
  if (id === 'default' && aiTools.isOperating()) return true;
  if (sessions.list().some(s => s.running && s.ai === ai && (s.account || 'default') === id)) return true;
  if ([...chats.running.values()].some(r => r.ai === ai && (r.account || 'default') === id)) return true;
  for (const p of store.listProjects()) for (const t of p.tasks) {
    if (chats.queue(p.id, t.id).some(q => (q.ai === ai && (q.account || 'default') === id) || (ai === 'claude' && q.limitSwitch && (q.limitSwitch.sourceAccount || 'default') === id))) return true;
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
  const state = fableBackup(rolesData()) && limitEvidence.active(account);
  return { ...snapshot, fableLimit: state ? { model: 'claude-fable-5-1', account, at: state.at, until: state.validUntil, untilSource: state.untilSource, hold: true } : null };
}

const { FreetalkHistory } = require('./lib/freetalk-history');
const freetalkHistory = new FreetalkHistory(freetalk, task => {
  if (chats.busy('freetalk',task) || sessions.list().some(x=>x.running && x.project==='freetalk' && x.task===task)) return lt('AIが作業中です。返事が終わってから整理してください');
  if (chats.queue('freetalk',task).length) return lt('順番待ちがあります。終了または取り消し後に整理してください');
  if (procwatch.list().some(x=>x.project==='freetalk')) return lt('freetalkでAIが作業中です。終了後に整理してください');
  return '';
});
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
function cleanFreetalkMemory() {
  for(const key of [...chats.base.keys()])if(key.startsWith('freetalk\u0000'))chats.base.delete(key);
  for(const key of [...chats.queues.keys()])if(key.startsWith('freetalk\u0000'))chats.queues.delete(key);
  for(const key of [...unread])if(key.startsWith('freetalk\u0000'))setUnread('freetalk',key.split('\u0000')[1],false);
}
function freetalkStatus() {
  const result=freetalk.status(); if(!result.ready)return result;
  try{return {...result,cleanup:freetalkLifecycle.status()};}catch(e){return {...result,cleanup:{reason:e.message}};}
}
const freetalkSweep=setInterval(()=>{const result=freetalkLifecycle.tick();if(result?.ok)cleanFreetalkMemory();},60000);
freetalkSweep.unref();
// 会話の引継ぎと、親の統合画面からの衝突解消依頼は同じ起動・排他・モデル指定を使う。
async function delegateRequest(b,res,{beforeStart,allowCompleted=false,resultsRecovery,resultsOrganize=false}={}) {
    const p = store.readProject(b.project);
    const file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    if (!p || !file || !launch.AIS.includes(ai)) return send(res, 400, { error: lt('project・task・ai（codex / claude / agy / grok）を確かめてください') });
    if (!text || text.length > 8000) return send(res, 400, { error: lt('text は1〜8000文字') });
    if (aiTools.isOperating()) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const t = store.readTask(file);
    const sizeNote = text.length > 1500 ? lt(' Hub が付ける内容を除き、差分だけにすると短くなります') : '';
    const title = String(b.title || text.split('\n')[0]).trim().slice(0, 60) || lt('渡した作業');
    if (t.state === '完了' && !allowCompleted) return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    // 委任先の役割は元の担当と異なることがある。親の role/model や CLI の既定へは戻さない。
    const role = b.role && rolesData().roles.find(r => r.name === b.role);
    if (b.role && (!role || role.main.ai !== launch.AI_KEY[ai])) return send(res, 400, { error: lt('role は指定した AI が主担当の役割を選んでください') });
    const model = launch.modelLabel(ai, typeof b.model === 'string' ? b.model.trim() : role?.main.model || '');
    if (!model) return send(res, 400, { error: lt('model 又は role を明示してください。例：チェックは ai: claude・model: claude-fable-5-1、書込は ai: codex・model: gpt-6.1-sol。作業は増やしていません') });
    const invalid = modelError(ai, model);
    if (invalid) return send(res, 409, { error: invalid });
    if (!launch.flagFor(ai, model)) return send(res, 409, { error: lt('委任には CLI に渡すモデル名が必要です。指定なしでは起動しません') });
    const terminalError = delegateTerminalError(p.id, t.id);
    if (terminalError) return send(res, 409, { error: terminalError });
    const sourceTurn = chats.busy(p.id, t.id)?.userRow?.turn || null;
    const busy = Boolean(chats.busy(p.id, t.id));
    let dir;
    try { if(!beforeStart)({ dir } = startDir(p, t, busy)); } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
    if (ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : role?.main.effort || '';
    const shown = lt`【渡した依頼：${title}】\n${text}`;
    const account = requestAccount(p, t.id, ai, b.account);
    const request = { resultsOrganize, ai, account, model, effort, sourceTurn, role: b.role || '', requireModel: true, requiredModel: launch.flagFor(ai, model), shown, text: shown + lt('\n\n新しい作業・子作業を作らず、この既存作業で依頼を行い、結果をこの会話へ返してください。'), perm: permCmd(ai) };
    const enqueue = () => {
      if(resultsOrganize)return send(res,409,{error:lt('別の依頼が作業中・順番待ちのため成果整理を開始していません')});
      const item = chats.enqueue(p.id, t.id, request);
      record('delegate', { project: p.id, task: t.id, ai }, { title, model, effort, queued: true, id: item.id, sourceTurn });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, model, effort, queued: true, id: item.id, queue: chats.queue(p.id, t.id).length, note: (chats.busy(p.id, t.id) ? lt('今の AI が終わったら、同じ作業で指定の AI が始まります。開始時に上限継続を確かめた時は Astra で始めます。この番を終えてください') : lt('同じ作業の順番待ちに追加しました。画面の［始める］で再開できます')) + sizeNote });
    };
    if (busy || chats.queue(p.id, t.id).length) return enqueue();
    const basePrompt = beforeStart?null:taskPrompt(p, t, file, dir) + lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
    const onEnd = row => {
      if (row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') });
      chatEnded(p.id, t.id);
      record('delegateend', { project: p.id, task: t.id, ai: row.ai }, { title, model: row.model, error: Boolean(row.error) });
    };
    try {
      const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
      await refreshLimitEvidence(request);
      if(beforeStart){beforeStart();({dir}=startDir(p,t));if(resultsRecovery)request.resultsRecoveryHash=store.readTask(file).completionHash;}
      if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error(lt('利用上限の確認中に停止されたため、委任を開始していません'));
      const terminalError = delegateTerminalError(p.id, t.id);
      if (terminalError) throw Error(terminalError);
      // 状態要求を待つ間に他の依頼が始まった場合も同じ待ち順へ入れる。
      if (chats.busy(p.id, t.id) || chats.queue(p.id, t.id).length) return enqueue();
      const prompt=basePrompt??taskPrompt(p,t,file,dir)+lt(' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。');
      const r = chats.send({ ...request, project: p.id, task: t.id, pdir: p.dir, dir, basePrompt:prompt, policy: modelPolicy(p, t), onEnd });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      record('delegate', { project: p.id, task: t.id, ai: r.ai }, { title, model: r.model, effort: r.effort, queued: false, preflight: Boolean(r.limitSwitch?.preflight), sourceTurn, receivedTurn: r.userRow.turn });
      return send(res, 200, { ok: true, project: p.id, task: t.id, title, ai: r.ai, model: r.model, effort: r.effort, queued: false, resume: r.resume, note: lt`${r.limitSwitch?.preflight ? lt('Fable上限保持中のため Astra で開始しました。') : ''}同じ作業で ${launch.AI_LABEL[r.ai]}・${r.model} が作業中です。結果もこの会話へ届きます` + sizeNote });
    } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
}

async function api(req, res, url) {
  if(req.method==='GET' && url.pathname==='/api/locale')return send(res,200,localeConfig());
  if (req.method === 'GET' && url.pathname === '/api/app-update') return send(res, 200, appUpdate.status());
  if (req.method === 'POST' && ['/api/app-update', '/api/app-update/check'].includes(url.pathname)) {
    if (fromRemote()) return send(res, 403, { error: 'forbidden' });
    let body; try { body = await readBody(req); } catch { return send(res, 400, { error: lt('形式が違います') }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: lt('形式が違います') });
    if (url.pathname.endsWith('/check') || body.action === 'check') { void appUpdate.check().catch(() => {}); return send(res, 200, appUpdate.status()); }
    if (typeof body.enabled !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
    try { return send(res, 200, await appUpdate.settings(body.enabled)); } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && appUpdate.applying() && !(['/api/quit', '/api/restart'].includes(url.pathname) && appUpdate.status().phase === 'installed')) return send(res, 409, { error: appUpdate.busyMessage() });
  // SSE・添付などJSON共通guardより前の経路も、別表記で別セッションを作らない。
  if (freetalkLib.hasTarget(Object.fromEntries(url.searchParams), true)) { req.resume(); return send(res, 409, { error: lt('freetalk は正規の名前「freetalk」で指定してください') }); }
  // Mac の許可が無くて中を読めない時の知らせ（Finder が違う場所で開くのを防ぐ）
  const denied = x => { try { fs.readdirSync(fs.statSync(x).isDirectory() ? x : path.dirname(x)); return ''; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code) ? lt('Mac の許可が無くて開けません。設定画面の「Mac のファイルの許可」で［確認をもう一度出す］を押し、「許可」を選んでください') : ''; } };
  // 本体が台帳のフォルダ（書類フォルダの中）を読めるか。Mac の許可が本体に効いているかをアプリが確かめる
  if (req.method === 'GET' && url.pathname === '/api/access') {
    try { fs.readdirSync(ROOT); return send(res, 200, { ok: true, root: ROOT }); }
    catch (e) { return send(res, 200, { ok: false, root: ROOT, code: e.code || '' }); }
  }
  // 一覧
  // 生きているかだけ答える（ファイルを読まないので、台帳が大きくても・iCloud が遅くてもすぐ返る）
  if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const t0 = Date.now();
    res.on('finish', () => { const ms = Date.now() - t0; if (ms > 2000) console.log(lt`[遅い] 一覧を作るのに ${ms}ms かかりました（台帳のファイルの読み込みが遅い可能性）`); });
    const roleData = rolesData(), modelSettings = modelView.read(), initialPick = modelView.initial(modelSettings);
    pruneUnread(); // 起動前から残っていた通知・外で片付けられた作業にも対応する。
    // 画面で使う物だけ送る：作業の「やったこと」「注意」「メモ」の本文は送らず、「次にやること」は1行目だけ（1MB → 数百KB）
    const slim = t => { const { done, note, memo, next, ...rest } = t; return { ...rest, next: String(next || '').split('\n')[0] }; };
    const state = {
      root: ROOT, roles: roleData, version: VERSION, latest: readVersion(), appUpdate: appUpdate.status(), freetalk: freetalkStatus(),
      onboarding: onboarding.state(),
      github: github.summary(), accounts: accounts.list(),
      completionWarning: store.completion.warning, projectOrder: projectOrder.read(), projectPins: projectOrder.readPins(),
      taskHandoffs: taskTransfer.pending(),
      taskOffers: taskTransfer.offers(), taskIntegrations: taskIntegrate.pending(),
      cliFlags: Object.fromEntries(launch.AIS.map(ai => [ai, Object.fromEntries((roleData.models[launch.AI_KEY[ai]] || []).map(m => [m, launch.flagFor(ai, m)]))])),
      // github：origin の場所と今のブランチ（120秒覚えておく）。作業は作業用コピーがある物だけ（ブランチが別のため）
      projects: (all => { const kids = handoff.childCounts(all); return all.map(p => {
        const base = baseOf(p);
        return { ...p, children: kids[p.id], startSpec: start.lastSpec(p), copies: gitw.countCopies(workRoot(p)), githubHasOrigin: gitw.hasOrigin(base), github: gitw.remoteInfo(base), tasks: p.tasks.map(t => {
          const missing = copyMissing(p, t);
          const meta = chat.readMeta(p.dir, t.id);
          return { ...slim(resultsGate.decorate(p,t,all)), ...(p.kind === 'freetalk' ? { freetalkHistory: (()=>{try{return freetalkHistory.status(t.id);}catch(e){return {reason:e.message};}})() } : {}), accounts: meta.accounts || {}, codexFast: meta.codexFast === true, copy: inWork(p, t) && !missing, copyMissing: missing, ...(t.workdir && !missing ? { github: gitw.remoteInfo(expandHome(t.workdir)) } : {}) };
        }) };
      }); })(store.listProjects()),
      sessions: sessions.list(), terminal: sessions.available(),
      chatting: [...chats.running.entries()].map(([k, r]) => { const [project, task] = k.split('\u0000'); return { project, task, ai: r.ai, model: r.model }; }),
      initialPick, initialPickError: modelError(initialPick.ai, initialPick.model),
      efforts: roles.EFFORTS, hiddenModels: modelView.hidden(modelSettings), modelOrder: modelView.saved(modelSettings), phoneLabels: modelView.phone(modelSettings),
      unread: [...unread].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }),
      background: procwatch.list().filter(x => x.project),
      acceleration: acceleration.settings(), remote: { enabled: remote.enabled() }, chatgpt: gpt.settings(), hubDir: __dirname,
      grokAvailable: Boolean(aiTools.find('grok') && aiTools.catalog().grok.models.length),
      agyAvailable: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.some(x => x.id === launch.AGY_MODEL.id) && !launch.agyAccountError()),
    };
    // 変わっていなければ中身を送らない（304）。画面は15秒ごとに聞いてくるので、何も変わらない時はほぼ空の返事で済む
    // 止まっている秒数（quiet）は毎秒変わるので印には入れない（画面は別に /api/sessions で取る）
    const body = JSON.stringify(state);
    const tagBody = state.sessions.length ? JSON.stringify({ ...state, sessions: state.sessions.map(({ quiet, ...x }) => x) }) : body;
    const tag = `"${crypto.createHash('sha1').update(tagBody).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: tag });
    return res.end(body);
  }
  // 裏で動いている AI の全部（どのプロジェクトにも当たらない物も含む）
  if (req.method === 'GET' && url.pathname === '/api/background') return send(res, 200, { items: procwatch.list() });
  if (req.method === 'GET' && url.pathname === '/api/ai-tools') {
    const status = await aiTools.status();
    applyModelCatalog();
    return send(res, 200, status);
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    if (url.searchParams.get('status') === '1' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    const rows = accounts.list();
    const checked = url.searchParams.get('status') === '1' ? await Promise.all(rows.map(async r => {
      const status = await accounts.status(r.ai, r.id); usage.loginChecked(r.ai, r.id, status.status);
      return { ...r, ...status };
    })) : rows;
    return send(res, 200, { accounts: checked });
  }
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const origin = req.headers.origin;
    if (req.headers['x-hub'] !== '1' || origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin)) return send(res,403,{ error:'forbidden' });
    return send(res, 200, usageWithLimit(await usage.status(false, usageSelection(url))));
  }


  // 会話画面：今までの会話と、書いている途中の返事を流す
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task');
    const p = store.readProject(project);
    if (!p || !store.taskFile(project, task)) return send(res, 404, { error: lt('作業が見つかりません') });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const run = chats.busy(project, task);
    emit({ type: 'rows', rows: chat.read(p.dir, task), busy: run ? { ai: run.ai, model: run.model, text: run.texts.join(['agy', 'grok'].includes(run.ai) ? '' : '\n\n'), started: run.started, last: run.last } : null, queue: chats.queue(project, task) });
    const off = chats.watch(project, task, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/api/cli-models') {
    const m = rolesData().models;
    const rows = ai => (m[launch.AI_KEY[ai]] || []).map(name => ({ name, flag: launch.flagFor(ai, name), set: Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, name) }));
    return send(res, 200, { claude: rows('claude'), codex: rows('codex'), agy: rows('agy'), grok: rows('grok'), hints: cliModelHints(), acceleration: acceleration.settings() });
  }
  if (req.method === 'GET' && url.pathname === '/api/acceleration') return send(res, 200, acceleration.settings());
  // ChatGPT の道具（mcp.js から）。X-Hub の印がある物だけ
  if (url.pathname.startsWith('/api/mcp/')) {
    if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/api/mcp/tools') return send(res, 200, { tools: gpt.tools(), work: gpt.settings().work });
    if (req.method === 'POST' && url.pathname === '/api/mcp/call') {
      const b = await readBody(req);
      try { if(b.arguments?.project==='freetalk' && b.arguments.task && !['hub_get_task','hub_get_chat','hub_read_file','hub_list_tasks'].includes(b.name) && freetalkHistory.state(b.arguments.task).migrated)return send(res,409,{error:lt('移行済みの話題は読み取り専用です')}); const r = await gpt.call(String(b.name || ''), b.arguments && typeof b.arguments === 'object' ? b.arguments : {}); return send(res, 200, { text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }); }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e), unknown: e.status === 404 && e.unknown === true }); }
    }
    return send(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/github') return send(res, 200, { ...await github.status({ fresh: url.searchParams.get('fresh') === '1' }), settings: github.settings() });
  if (req.method === 'GET' && url.pathname === '/api/chatgpt') return send(res, 200, { ...gpt.settings(), ...codexMcpStatus() });
  // 外から使う（iPhone）の設定
  if (req.method === 'GET' && url.pathname === '/api/remote') { const st = remote.status(); return (st.url ? Promise.resolve(st.url) : tailscaleUrl()).then(u => send(res, 200, { ...st, url: u })); }
  if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: VERSION, latest: readVersion() });
  if (req.method === 'GET' && url.pathname === '/api/changelog') return send(res, 200, changelog(12));
  if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, sessions.list());
  if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, readLog(Math.min(200, Number(url.searchParams.get('n')) || 50)));
  // 取り込む前の見通し（変更の量・ぶつかりそうか）
  if (req.method === 'GET' && url.pathname === '/api/task/preview') {
    const p = store.readProject(url.searchParams.get('project'));
    const file = p && store.taskFile(p.id, url.searchParams.get('task'));
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 200, null);
    let r = null;
    try { r = gitw.preview({ dir: expandHome(t.workdir), workRoot: workRoot(p) }); } catch (e) { r = null; }
    return send(res, 200, r);
  }

  // 作業画面の出力を流す（Server-Sent Events）
  if (req.method === 'GET' && url.pathname === '/api/term/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task'), ai = url.searchParams.get('ai');
    const s = sessions.get(project, task, ai);
    if (!s) return send(res, 404, { error: lt('作業画面がありません') });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    emit({ type: 'data', data: s.buf, replay: true });
    if (s.exited) emit({ type: 'exit', code: s.code });
    const off = sessions.watch(project, task, ai, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }

  // GitHub の場所（その場で読み直す）。作業に作業用コピーがあればそのブランチ
  if (req.method === 'GET' && url.pathname === '/api/project/github') {
    const p = store.readProject(url.searchParams.get('project'));
    const task = url.searchParams.get('task');
    const file = p && task ? store.taskFile(p.id, task) : null;
    const wd = file ? expandHome(store.readTask(file).workdir) : '';
    const info = p ? gitw.remoteInfo(wd && fs.existsSync(wd) ? wd : baseOf(p), { fresh: true }) : null;
    return info ? send(res, 200, info) : send(res, 404, { error: lt('GitHub の場所が見つかりません') });
  }

  // 子プロジェクトの一覧（親で作業を続ける前に、終わっていない子を知らせるため）
  if (req.method === 'GET' && url.pathname === '/api/project/children') {
    const r = handoff.childrenSummary(store, url.searchParams.get('project'));
    return r ? send(res, 200, r) : send(res, 404, { error: lt('プロジェクトが見つかりません') });
  }
  if (req.method === 'GET' && url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    try {
      if (!p) throw Error(lt('プロジェクトがありません'));
      const f = start.imageFile(p, url.searchParams.get('id'), true);
      return send(res, 200, fs.readFileSync(f), /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
    } catch { return send(res, 404, { error: lt('画像が見つかりません') }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/freetalk/status') {
    try {
      if (url.searchParams.get('project') !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
      return send(res,200,freetalkHistory.status(url.searchParams.get('task')));
    } catch(e) { return send(res,409,{error:e.message}); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  // ファイル・スクショを受け取る（本文はファイルそのもの）。Inbox に置き、作業ファイルに記録し、動いている AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/upload') {
    const q = k => url.searchParams.get(k) || '';
    const p = store.readProject(q('project'));
    const file = p && store.taskFile(p.id, q('task'));
    if (!file) { req.resume(); return send(res, 400, { error: lt('作業が見つかりません') }); }
    let data;
    try { data = await readRaw(req, MAX_UPLOAD); } catch (e) { return send(res, 413, { error: lt('ファイルが大きすぎます（50MB まで）') }); }
    let saved;
    try { if(p.kind==='freetalk' && freetalkHistory.state(q('task')).migrated)throw Error(lt('移行済みの話題は読み取り専用です')); saved = p.kind === 'freetalk' ? freetalk.upload(q('task'), q('name'), data) : saveUpload(q('name'), data); }
    catch (e) { return send(res, 409, { error: e.message }); }
    store.updateTask(p.id, q('task'), { memo: lt`ファイルを渡した: ${saved}` });
    const ai = launch.AIS.includes(q('ai')) ? q('ai') : '';
    const typed = ai ? sessions.write(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ') : false;
    record('upload', { project: p.id, task: q('task'), ai }, { file: saved, bytes: data.length });
    return send(res, 200, { ok: true, path: saved, typed });
  }

  if (url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    if (!p) { req.resume(); return send(res, 400, { error: lt('プロジェクトがありません') }); }
    try { return send(res, 200, start.saveImage(p, url.searchParams.get('name') || 'image.png', await readRaw(req, start.MAX))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  const b = await readBody(req);
  if (url.pathname === '/api/freetalk/ensure') return send(res, 200, freetalk.ensure());
  if (url.pathname === '/api/freetalk/topic') {
    try { return send(res, 200, freetalk.createTopic(modelView.initial())); }
    catch (e) { return send(res, 409, { error: e.message }); }
  }
  if(b?.project==='freetalk' && b.task && !['/api/task/read','/api/chat/stop','/api/chat/unqueue','/api/freetalk/promote','/api/freetalk/delete'].includes(url.pathname)) {
    try { if(freetalkHistory.state(b.task).migrated)return send(res,409,{error:lt('この話題はプロジェクトへ移行済みで、読み取り専用です')}); }
    catch(e) { return send(res,409,{error:e.message}); }
  }
  const freetalkBlock = freetalkLib.guard(url.pathname, b);
  if (freetalkBlock) return send(res, 409, { error: freetalkBlock });
  if(['/api/freetalk/project-preview','/api/freetalk/promote','/api/freetalk/clean','/api/freetalk/delete'].includes(url.pathname)) {
    try {
      if(b.project!=='freetalk')throw Error(lt('freetalkを指定してください'));
      if(url.pathname==='/api/freetalk/project-preview')return send(res,200,freetalkLifecycle.preview(b.task));
      if(url.pathname==='/api/freetalk/promote') {
        const r=freetalkLifecycle.promote(b.task,b); chats.emit('freetalk',b.task,{type:'reset'});return send(res,200,r);
      }
      if(url.pathname==='/api/freetalk/delete') {
        const r=freetalkLifecycle.remove(b.task,{confirm:b.confirm});
        chats.base.delete(chats.key('freetalk',b.task));chats.queues.delete(chats.key('freetalk',b.task));
        chats.emit('freetalk',b.task,{type:'reset'});setUnread('freetalk',b.task,false);return send(res,200,r);
      }
      const r=freetalkLifecycle.clean({confirm:b.confirm});cleanFreetalkMemory();return send(res,200,r);
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (['/api/freetalk/summary','/api/freetalk/rotate'].includes(url.pathname)) {
    try {
      if (b.project !== 'freetalk') throw Error(lt('freetalk の話題を指定してください'));
      if (url.pathname === '/api/freetalk/rotate') {
        const result = freetalkHistory.rotate(b.task,b);
        chats.base.delete(chats.key('freetalk',b.task)); chats.queues.delete(chats.key('freetalk',b.task));
        chats.emit('freetalk',b.task,{type:'reset'}); setUnread('freetalk',b.task,false);
        return send(res,200,result);
      }
      const request = freetalkHistory.prepareSummary(b.task);
      if (request.ai === 'chatgpt') {
        const p=store.readProject('freetalk');
        const row=chat.append(p.dir,b.task,{role:'user',to:'chatgpt',text:request.text});
        chats.emit('freetalk',b.task,{type:'row',row});
        return send(res,200,{ok:true,manual:true,text:request.text});
      }

      return await delegateRequest({...request, project:'freetalk',task:b.task,title:lt('話題の整理用の要約')},res,{beforeStart:()=>freetalkHistory.idle(b.task)});
    } catch(e) { return send(res,409,{error:e.message}); }
  }

  if (url.pathname === '/api/onboarding') return send(res, 200, { onboarding: onboarding.save(b) });
  if (url.pathname === '/api/onboarding/check') {
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => k !== 'ais')) return send(res, 400, { error: lt('確認の指定が正しくありません') });
    return send(res, 200, await onboarding.check(b.ais));
  }
  if (req.method === 'POST' && url.pathname === '/api/limits/fable/clear') {
    try { const selection = usageSelection(url, b); limitEvidence.clear(selection.claude || 'default'); }
    catch { return send(res, 500, { error: lt('解除を保存できませんでした') }); }
    record('limit-clear', {});
    // 解除に利用枠の取得を待たせない。遅れて届く応答もフラグを作らない。
    return send(res, 200, usageWithLimit(usage.snapshot(usageSelection(url, b))));
  }
  if (req.method === 'POST' && url.pathname === '/api/usage/refresh') return send(res, 200, usageWithLimit(await usage.status(true, usageSelection(url, b))));

  if (url.pathname === '/api/acceleration/task') {
    const p = store.readProject(b.project), file = p && store.taskFile(p.id, b.task);
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: lt('作業が見つかりません') });
    if (typeof b.on !== 'boolean') return send(res, 400, { error: lt('加速はオン・オフで指定してください') });
    if (b.on && !acceleration.settings().codexAllowed) return send(res, 409, { error: lt('設定で加速を使えるようにしてください') });
    const meta = chat.readMeta(p.dir, b.task); meta.codexFast = b.on;
    chat.writeMeta(p.dir, b.task, meta);
    record('task-acceleration', { project: p.id, task: b.task }, { codexFast: b.on });
    return send(res, 200, { codexFast: b.on });
  }
  if (url.pathname === '/api/acceleration') {
    const saved = acceleration.save(b);
    record('acceleration', {}, saved);
    return send(res, 200, saved);
  }
  if (url.pathname === '/api/github') return send(res, 200, await github.save(b));
  if (url.pathname === '/api/github/owners') return send(res, 200, { owners: await github.owners(b.account) });
  if (url.pathname === '/api/github/preview' || url.pathname === '/api/github/create') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 404, { error: lt('プロジェクトが見つかりません') });
    if (url.pathname.endsWith('/preview')) return send(res, 200, await github.preview(githubProject(p)));
    if (b.confirm !== true) return send(res, 400, { error: lt('確認画面で［作る］を押してください') });
    const r = await github.create(githubProject(p), b);
    record('githubcreate', { project: p.id }, { ok: r.ok, pushed: r.pushed, private: true, partial: Boolean(r.partial) });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/remote') {
    const r = remote.update({ enabled: b.enabled, passcode: b.passcode });
    if (r.error) return send(res, 400, { error: r.error });
    record('remote', {}, { enabled: remote.enabled(), passcode: b.passcode !== undefined });
    return send(res, 200, remote.status());
  }
  // ChatGPT に貼る文：普段の ChatGPT の会話は Mac の道具（MCP）を使えないので、作業の中身を文に入れる
  if (url.pathname === '/api/accounts' || url.pathname.startsWith('/api/accounts/')) {
    try {
      let result = { ok: true };
      const ai = b.ai, id = b.id || 'default';
      if (url.pathname === '/api/accounts') { result.account = accounts.add(ai, b.name); usage.invalidate(ai, result.account.id); }
      else if (url.pathname === '/api/accounts/rename') accounts.rename(ai, id, b.name);
      else if (url.pathname === '/api/accounts/select') {
        const p = store.readProject(b.project);
        if (!p || !store.taskFile(p.id, b.task)) throw Error(lt('作業が見つかりません'));
        accounts.available(ai, id);
        const live = sessions.get(p.id, b.task, ai);
        if (live && !live.exited && (live.account || 'default') !== id) return send(res, 409, { error: lt('このAIのターミナルが作業中です。終了してから切り替えてください') });
        const meta = chat.readMeta(p.dir, b.task); meta.accounts = { ...meta.accounts, [ai]: id }; chat.writeMeta(p.dir, b.task, meta);
        result.accounts = meta.accounts;
      } else if (url.pathname === '/api/accounts/login' || ai === 'agy' && url.pathname === '/api/accounts/logout') {
        if (url.pathname.endsWith('/logout') && (b.confirm !== true || b.confirmDefault !== true)) return send(res, 400, { error: lt('既定のログアウトをもう一度確認してください') });
        accounts.assertIdle(ai, id);
        const c = accounts.command(ai, id, 'login');
        const command = (ai === 'agy' ? launch.agyAccountShell() : launch.accountShell(ai, id)) + [c.command, ...c.args].map(launch.sq).join(' ');
        const terminal = accounts.terminalCommand(ai, id, command, launch.sq, 'auth');
        try { result = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
        usage.invalidate(ai, id);
        if (DRY) result = { dry: true, command };
        if (ai === 'agy') result.warning = url.pathname.endsWith('/logout') ? lt('Macで開いたTerminalで /logout と入力し、終わったら［状態を確認］を押してください。') : lt('Macで開いたTerminalで /login と入力し、終わったら［状態を確認］を押してください。');
      } else if (url.pathname === '/api/accounts/logout' || url.pathname === '/api/accounts/delete') {
        if (b.confirm !== true) return send(res, 400, { error: lt('確認してから操作してください') });
        if (url.pathname.endsWith('/logout')) result = await accounts.logout(ai, id, b.confirmDefault);
        else { result = accounts.remove(ai, id); if (ai === 'claude') { try { limitEvidence.clear(id); } catch { result.warning = lt('削除は完了しましたが、上限記録の片付けを保存できませんでした'); } } }
        usage.invalidate(ai, id);
      } else return send(res, 404, { error: lt('操作が見つかりません') });
      record('account' + url.pathname.split('/').pop(), { ai }, { account: id });
      return send(res, 200, result);
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  if (url.pathname === '/api/chatgpt/prompt') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    if (!file || !fs.existsSync(file)) return send(res, 400, { error: lt('作業が見つかりません') });
    const cut = (v, n) => (v.length > n ? v.slice(0, n) + lt('\n…（長いので省略）') : v);
    let ledger = ''; try { ledger = fs.readFileSync(path.join(p.dir, 'PROJECT.md'), 'utf8'); } catch (e) { /* 無くてもよい */ }
    const rows = chat.read(p.dir, b.task).filter(r => (r.role === 'user' || r.role === 'assistant') && r.text).slice(-6);
    const talk = rows.map(r => `[${r.role === 'user' ? (r.from ? lt('結果') : '人') : (launch.AI_LABEL[r.ai] || r.ai || 'AI')}] ${cut(r.text, 1500)}`).join('\n\n');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const out = [lt`Project Hub の作業「${b.task}」をお願いします。必要な中身は下に全部入れてあります（道具やファイルを探す必要はありません）。相談・レビュー役として、日本語で答えてください。最後に「## 結果」と「## 次にやること」を短くまとめてください。人に決めてほしいことがあれば「## 質問」に書いてください。`,
      lt`# 作業ファイル\n${cut(fs.readFileSync(file, 'utf8'), 12000)}`,
      ledger && lt`# 台帳（PROJECT.md）\n${cut(ledger, 4000)}`,
      p.kind === 'freetalk' && freetalk.prompt(p, store.readTask(file)),
      talk && lt`# これまでの会話（新しい6件）\n${talk}`,
      text && lt`# 今回の依頼\n${text}`].filter(Boolean).join('\n\n');
    return send(res, 200, { ok: true, text: out });
  }
  // ChatGPT の返事を貼って Hub に戻す（会話に ChatGPT の返事として残し、作業ファイルに1行書く）
  if (url.pathname === '/api/chatgpt/result') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!file || !fs.existsSync(file) || !text || text.length > 50000) return send(res, 400, { error: lt('作業と返事を確かめてください') });
    const row = chat.append(p.dir, b.task, { role: 'assistant', ai: 'chatgpt', text });
    chats.emit(p.id, b.task, { type: 'row', row });
    try { store.appendSection(p.id, b.task, 'やったこと', lt`- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ChatGPT の返事を受け取った（会話に記録）`); } catch (e) { /* 無くてもよい */ }
    return send(res, 200, { ok: true });
  }
  // ChatGPT アプリ（中身は Codex）に Hub の道具を登録する：~/.codex/config.toml に [mcp_servers.project-hub] を書き足す
  if (url.pathname === '/api/chatgpt/register') {
    const r = codexMcpRegister();
    if (r.error) return send(res, 400, { error: r.error });
    record('chatgptregister', {}, { file: r.file, added: r.added });
    return send(res, 200, { ...gpt.settings(), ...codexMcpStatus(), ...r });
  }
  if (url.pathname === '/api/chatgpt') {
    if (typeof b.work !== 'boolean') return send(res, 400, { error: lt('形式が違います') });
    const s = gpt.save({ work: b.work }); record('chatgptwork', {}, { work: s.work });
    return send(res, 200, s);
  }
  if (url.pathname === '/api/remote/logout-all') {
    const n = remote.logoutAll();
    record('remotelogoutall', {}, { sessions: n });
    return send(res, 200, remote.status());
  }
  if (url.pathname === '/api/start/image-path') {
    const p = store.readProject(b.project);
    try { if (!p) throw Error(lt('プロジェクトがありません')); return send(res, 200, start.imageFromPath(p, b.path)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/start') {
    const r = await quickStart(b);
    return send(res, r.status, r.body);
  }

  if (url.pathname === '/api/ai-tools/check') {
    try { return send(res, 200, await aiTools.checkUpdate(b.ai)); }
    catch (e) { return send(res, e.status || 502, { error: e.reason || lt('更新情報の確認に失敗しました'), stage: e.stage }); }
  }
  if (url.pathname === '/api/ai-tools/update' || url.pathname === '/api/ai-tools/models/refresh') {
    try {
      const result = url.pathname.endsWith('/update') ? await aiTools.update(b.ai) : await aiTools.refresh(b.ai);
      applyModelCatalog();
      record(url.pathname.endsWith('/update') ? 'aiupdate' : 'aimodels', { ai: b.ai }, { added: result.models?.added ?? result.added ?? 0 });
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 502, { error: e.reason || e.message || lt('CLI の操作に失敗しました'), stage: e.stage || 'operation', reason: e.reason || e.message || '' });
    }
  }
  if (aiTools.isOperating() && ['/api/term/start', '/api/term/handoff', '/api/continue', '/api/chat/send'].includes(url.pathname)) {
    return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です。終わってから始めてください') });
  }

  // 作業画面を開く（画面の中）
  if (url.pathname === '/api/term/start') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    const { model, effort } = pickSpec(t, b.ai);
    const account = requestAccount(p, t.id, b.ai, b.account);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const cur = sessions.get(b.project, b.task, b.ai);
    const { dir, note } = cur && !cur.exited ? { dir: cur.dir } : startDir(p, t);
    const argv = launch.buildArgv({ ai: b.ai, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model }), cmd: permCmd(b.ai), model, effort, account, fast: codexFastFor(p.id, t.id) });
    if (DRY) return send(res, 200, { ok: true, dry: true, dir, model, effort, account, ...argv, accountEnv: account === 'default' ? {} : { [b.ai === 'grok' ? 'GROK_HOME' : b.ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: accounts.get(b.ai, account).dir } });
    try {
      const s = sessions.start({ project: b.project, task: b.task, ai: b.ai, dir, account, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows });
      record('start', b, { model, effort, dir });
      return send(res, 200, { ok: true, dir, note, model, effort, running: !s.exited });
    } catch (e) {
      return send(res, e.status || 500, { error: String(e.message || e) });
    }
  }
  // 交代する：前の AI の会話を「引き継ぎ資料」にまとめ、相手の AI に読ませて続けさせる
  // 相手が動いていなければ、役割どおりのモデル・思考で始める。相手が作業中なら断る（勝手に割り込まない）
  if (url.pathname === '/api/term/handoff') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.to)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    const from = b.from || (b.to === 'claude' ? 'codex' : b.to === 'codex' ? 'claude' : '');
    if (!launch.AIS.includes(from) || from === b.to) return send(res, 400, { error: lt('交代元を指定してください') });
    const LABEL = launch.AI_LABEL;
    const account = requestAccount(p, t.id, b.to, b.account);
    const tgt = sessions.get(b.project, b.task, b.to);
    const tgtLive = tgt && !tgt.exited;
    if (tgtLive && (tgt.account || 'default') !== account) return send(res, 409, { error: lt('交代先は別のアカウントで作業中です') });
    if (!tgtLive) {
      const invalidModel = modelError(b.to, pickSpec(t, b.to).model);
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    if (tgtLive && Date.now() - tgt.lastOut < 20000) return send(res, 409, { error: lt`${LABEL[b.to]} が作業中です。止まってから（入力待ちになってから）交代してください` });
    const src = sessions.get(b.project, b.task, from);
    const { dir } = tgtLive ? { dir: tgt.dir } : startDir(p, t);
    const convo = transcript.collect({ ai: from, dir: (src && src.dir) || dir, since: src ? src.started : Date.now() - 3 * 86400000, buf: src && src.buf, accountDir: accounts.location(from, src?.account || accountFor(p.id, t.id, from)) });
    const board = path.join(p.dir, '.ai', 'board.md');
    const note = b.note ? String(b.note).replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
    const hdir = path.join(p.dir, '.ai', 'handoff');
    fs.mkdirSync(hdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const packetFile = path.join(hdir, `${t.id}-${stamp}-${from}.md`);
    fs.writeFileSync(packetFile, transcript.packet({ fromLabel: LABEL[from], toLabel: LABEL[b.to], taskFile: file, board, convo, extra: note }));
    const msg = lt`${LABEL[from]} から交代です。引き継ぎ資料 ${packetFile} を読み、${file} と ${board} も確かめてから、あなたの役割で続けてください。`;
    let started = false, spec = null;
    if (tgtLive) {
      sessions.type(b.project, b.task, b.to, msg);
    } else {
      spec = pickSpec(t, b.to);
      const argv = launch.buildArgv({ ai: b.to, prompt: msg + ' ' + taskPrompt(p, t, file, dir, 'terminal', { ai: b.to, model: spec.model }), cmd: permCmd(b.to), model: spec.model, effort: spec.effort, account, fast: codexFastFor(p.id, t.id) });
      if (DRY) return send(res, 200, { ok: true, dry: true, packet: packetFile, kind: convo.kind, ...argv });
      try { sessions.start({ project: b.project, task: b.task, ai: b.to, dir, account, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows }); started = true; }
      catch (e) { return send(res, 500, { error: String(e.message || e), packet: packetFile }); }
    }
    store.updateTask(p.id, t.id, { owner: launch.AI_KEY[b.to], memo: lt`${LABEL[from]} から ${LABEL[b.to]} へ交代（引き継ぎ資料: ${packetFile}）` });
    record('handoff', b, { packet: packetFile, kind: convo.kind, started });
    return send(res, 200, { ok: true, packet: packetFile, kind: convo.kind, started, ...(spec || {}) });
  }
  // 動いている AI のモデル・思考を変える：作業ファイルに残し、その AI に /model・/effort を打つ
  if (url.pathname === '/api/term/switch') {
    if (b.ai === 'agy') return send(res, 409, { error: lt('Agy は承認された Gemini 3.1 Pro (High) に固定しています') });
    if (!launch.AIS.includes(b.ai) || !['model', 'effort'].includes(b.field)) return send(res, 400, { error: lt('指定が正しくありません') });
    if (b.ai === 'grok' && b.field === 'effort' && b.value && !launch.EFFORT_FLAG.grok[b.value]) return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    if (b.field === 'model') {
      const invalidModel = modelError(b.ai, String(b.value || ''));
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    const t = store.updateTask(b.project, b.task, { [b.field]: typeof b.value === 'string' ? b.value : '' });
    if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
    const spec = pickSpec(t, b.ai);
    const cmd = launch.switchCommand(b.ai, b.field, spec[b.field]);
    const sent = Boolean(cmd) && sessions.type(b.project, b.task, b.ai, cmd);
    record('switch', b, { [b.field]: spec[b.field], sent });
    return send(res, 200, { ok: true, sent, command: cmd, ...spec });
  }
  if (url.pathname === '/api/term/input') {
    return send(res, sessions.write(b.project, b.task, b.ai, String(b.data || '')) ? 200 : 404, { ok: true });
  }
  if (url.pathname === '/api/term/resize') {
    return send(res, sessions.resize(b.project, b.task, b.ai, b.cols, b.rows) ? 200 : 404, { ok: true });
  }
  if (url.pathname === '/api/term/stop') {
    record('stop', b);
    return send(res, 200, { ok: sessions.stop(b.project, b.task, b.ai) });
  }

  // 別の窓で開く（作業画面の部品が無い時の代わり）
  if (url.pathname === '/api/continue') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    const spec = pickSpec(t, b.ai);
    const account = requestAccount(p, t.id, b.ai, b.account);
    const invalidModel = modelError(b.ai, spec.model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir } = startDir(p, t);
    const command = launch.buildCommand({ ai: b.ai, dir, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model: spec.model }), cmd: permCmd(b.ai), ...spec, account, fast: codexFastFor(p.id, t.id) });
    const terminal = accounts.terminalCommand(b.ai, account, command, launch.sq);
    let r; try { r = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
    return send(res, 200, { ok: true, dir, ...(DRY ? { command, r } : {}) });
  }

  // フォルダを Finder で開く（台帳に書かれた場所だけ）
  if (url.pathname === '/api/open') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    let target = null;
    if (b.kind === 'project') target = p.dir;
    else if (b.kind === 'folder') target = (p.folders.find(f => f.label === b.label) || {}).path;
    else if (b.kind === 'workdir') { const f = store.taskFile(b.project, b.task); target = f && store.readTask(f).workdir; }
    target = expandHome(target || '');
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: lt('その場所が見つかりません'), path: target });
    if (denied(target)) return send(res, 403, { error: denied(target), path: target });
    const r = await launch.openFolder(target, DRY);
    return send(res, 200, { ok: true, path: target, ...(DRY ? { r } : {}) });
  }

  // 文の中のファイル・フォルダを Finder で開く（作業の場所からの相対でもよい。ホームの中だけ）
  if (url.pathname === '/api/reveal') {
    const raw = String(b.path || '').trim();
    if (!raw) return send(res, 400, { error: lt('場所がありません') });
    const p = store.readProject(b.project);
    const f = p && b.task ? store.taskFile(b.project, b.task) : null;
    const t = f ? store.readTask(f) : null;
    const bases = [t && expandHome(t.workdir), p && baseOf(p), p && p.dir, ROOT, store.product].filter(Boolean);
    const list = raw.startsWith('~') || path.isAbsolute(raw) ? [expandHome(raw)] : bases.map(d => path.join(d, raw));
    const home = [os.homedir(), ROOT].map(d => path.resolve(d));
    const target = list.map(x => path.resolve(x)).find(x => home.some(h => x === h || x.startsWith(h + path.sep)) && fs.existsSync(x));
    if (!target) return send(res, 404, { error: lt`見つかりません：${raw}` });
    if (denied(target)) return send(res, 403, { error: denied(target) });
    const isDir = fs.statSync(target).isDirectory();
    // info＝開かず種類と場所を返す／list＝フォルダの中身／open＝元ファイルを既定アプリで開く／finder＝Finderで表示
    const how = ['info', 'list', 'open'].includes(b.how) ? b.how : 'finder';
    if (how === 'info') return send(res, 200, { ok: true, path: target, dir: isDir, how });
    if (how === 'list' && isDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 500)
          .map(d => { const full = path.join(target, d.name); let st = null; try { st = fs.statSync(full); } catch (e) { /* 読めない物 */ } return { name: d.name, path: full, dir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }; })
          .sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name, 'ja') : x.dir ? -1 : 1));
      } catch (e) { return send(res, 403, { error: denied(target) || String(e.message) }); }
      const up = path.dirname(target);
      return send(res, 200, { ok: true, path: target, dir: true, entries, parent: home.some(h => up === h || up.startsWith(h + path.sep)) ? up : '' });
    }
    record('reveal', { project: b.project, task: b.task }, { path: target, dir: isDir, how, app: Boolean(b.app) });
    const act = how === 'list' ? 'open' : how; // ファイルに list が来たら開く
    // アプリの中では、アプリ自身が開く（許可がアプリに付いているため）。ブラウザの時は本体が open で開く
    if (b.app) return send(res, 200, { ok: true, path: target, dir: isDir, byApp: true, how: act });
    const r = act === 'open' || isDir ? await launch.openFolder(target, DRY) : await launch.revealFile(target, DRY);
    return send(res, 200, { ok: true, path: target, dir: isDir, how: act, ...(DRY ? { r } : {}) });
  }
  // URL を既定のブラウザで開く（http・https だけ）
  if (url.pathname === '/api/open-url') {
    const u = String(b.url || '');
    if (!/^https?:\/\/[^\s]+$/.test(u)) return send(res, 400, { error: lt('開けない URL です') });
    const r = await launch.openUrl(u, DRY);
    return send(res, 200, { ok: true, ...(DRY ? { r } : {}) });
  }

  // 作業の状態・質問・メモ・モデル・思考
  // 作業用コピーの古い記録を片付ける（場所が無い時だけ。取り込み済みの後に AI が書き戻した時など）
  if (url.pathname === '/api/task/copyclear') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task), t = file && store.readTask(file);
    if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!copyMissing(p, t)) return send(res, 409, { error: lt('作業用コピーはまだあります（片付けるのは、場所が無い時だけ）') });
    const m = lastMerge(p.id, t.id);
    const done = store.updateTask(p.id, t.id, { workdir: '', memo: m ? lt('本体に取り込み済み。作業用コピーの古い記録を片付けた') : lt('作業用コピーの古い記録を片付けた') });
    record('copyclear', b, { merged: Boolean(m) });
    return send(res, 200, { ok: true, merged: Boolean(m), task: done });
  }
  if (url.pathname === '/api/task') {
    if (fromRemote()) record('task', b, { state: b.state, question: b.question !== undefined, memo: b.memo !== undefined });
    if (b.state === '完了') return send(res, 409, { error: lt('［完了に移す］で内容を確認してから完了にしてください') });
    const str = k => (typeof b[k] === 'string' ? b[k] : undefined);
    let context = {};
    if (['kind','derivedFrom','parent','workspaceMode'].some(k => b[k] !== undefined)) {
      try {
        const p=store.readProject(b.project), file=store.taskFile(b.project,b.task), t=file && store.readTask(file);
        if (!p || !t) throw Error(lt('作業がありません'));
        context=require('./lib/work-context').validateTask(p,t,b,store.listProjects());
        if (b.workspaceMode !== undefined && b.workspaceMode !== t.workspaceMode && (t.workspaceStarted || t.state !== '未着手' || t.workdir || chats.busy(p.id,t.id) || sessions.list().some(s=>s.project===p.id && s.task===t.id && s.running))) throw Error(lt('場所は作業開始前に選んでください。既存コピーは自動で移しません'));
      } catch(e) { return send(res,409,{error:e.message}); }
    }
    const t = store.updateTask(b.project, b.task, {
      state: str('state'), question: str('question'), owner: str('owner'), role: str('role'),
      ...context, model: str('model'), effort: str('effort'), parent: str('parent'), phase: str('phase'), via: str('via'), memo: b.memo,
    });
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業が見つかりません') });
  }
  if (url.pathname === '/api/task/completion') {
    if (b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
    if (b.action === 'approve' && (chats.running.has(`${b.project}\u0000${b.task}`) || launch.AIS.some(a => { const s = sessions.get(b.project, b.task, a); return s && !s.exited; }))) return send(res, 409, { error: lt('AIが作業中です。終わってから完了を確認してください') });
    if(b.action==='approve') {
      const {all,p,t}=resultsGate.current(b.project,b.task);
      if(t && t.completionHash!==b.expectedHash)return send(res,409,{error:lt('確認中に作業が更新されました')});
      if(t) { const issue=resultsGate.approvalIssue(p,t,all); if(!issue.ok)return send(res,409,{error:lt('成果の記録が整っていません：')+issue.reason}); }
    }
    const t = store.decideTask(b.project, b.task, b.action, b.expectedHash);
    if (t?.error) return send(res, t.status, { error: t.error });
    if (t) record(b.action === 'approve' ? 'taskdone' : 'taskreopen', b);
    if (t && b.action === 'approve') { const p = store.readProject(b.project); if (p) reportChild(p, lt('作業の完了'), [t.title, handoff.lastEntry(t.done)].filter(Boolean).join('\n')); }
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業が見つかりません') });
  }
  // 手順に印を付ける・外す
  if (url.pathname === '/api/task/step') {
    const t = typeof b.add === 'string' ? store.addStep(b.project, b.task, b.add) : store.setStep(b.project, b.task, Number(b.index), Boolean(b.done));
    if(t) {
      try { await resultsGate.trigger(b.project,b.task); } catch(e) {record('results-organize-error',b,{error:e.message});}
      const {all,p,t:current}=resultsGate.current(b.project,b.task);
      return send(res,200,resultsGate.decorate(p,current,all));
    }
    return send(res,400,{error:lt('その手順が見つかりません')});
  }
  if (url.pathname === '/api/phase/continue') {
    const current = store.readProject(b.project);
    if (!current || current.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました') });
    const p = store.continuePhase(b.project); return send(res, 200, p);
  }
  // プロジェクトを完了にする・戻す（人がはっきり押した時だけ）
  if (url.pathname === '/api/project/status') {
    if (b.status === '完了' && b.confirm !== true) return send(res, 400, { error: lt('完了に移すか確認してください') });
    const current = store.readProject(b.project);
    if ((b.status === '完了' || b.expectedHash) && current?.completionHash !== b.expectedHash) return send(res, 409, { error: lt('確認中にプロジェクトが更新されました') });
    if (!['完了', '進行中'].includes(b.status)) return send(res, 400, { error: lt('形式が違います') });
    if (b.status === '完了') {
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
    }
    const p = store.setProjectStatus(b.project, b.status);
    if (p) record(b.status === '完了' ? 'projectdone' : 'projectreopen', { project: b.project });
    if (p && b.status === '完了' && p.status === '完了') reportChild(p, '完了', handoff.completionText(p));
    return p ? send(res, 200, { ok: true, status: p.status }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
  }
  // 親に結果を渡す（人がはっきり押した時）。文が無ければ一番新しい作業の「やったこと」の最後
  if (url.pathname === '/api/project/handoff') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    const t = handoff.newestTask(p);
    const text = (typeof b.text === 'string' && b.text.trim()) || (t ? handoff.lastEntry(t.done) : '');
    if (!text) return send(res, 400, { error: lt('渡す内容がありません。文を書くか、作業の「やったこと」を書いてください') });
    if (text.length > 4000) return send(res, 400, { error: lt('渡す文は4000文字までです') });
    const r = reportChild(p, lt('報告'), text);
    if (!r) return send(res, 400, { error: lt('親プロジェクトが見つかりません') });
    return send(res, 200, { ok: true, parent: r.parent, task: r.task, duplicate: r.duplicate });
  }
  // 次のフェーズへ進む（今のフェーズを完了に）
  if (url.pathname === '/api/phase/next') {
    if (b.confirm !== true) return send(res, 400, { error: lt('今のフェーズを完了に移すか確認してください') });
    const current = store.readProject(b.project);
    if (!current || b.expectedHash !== current.completionHash) return send(res, 409, { error: lt('確認中にフェーズが更新されました。内容を読み直してください') });
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: lt('このプロジェクトでAIが作業中です。終わってから完了を確認してください') });
    const p = store.nextPhase(b.project);
    if (p) record('nextphase', b);
    return p ? send(res, 200, { ok: true, phases: p.phases }) : send(res, 400, { error: lt('プロジェクトが見つかりません') });
  }
  // コピーと再開先は保持したまま、取り込み対象から外す・戻す
  if (url.pathname === '/api/task/merge-exclusion') {
    if (typeof b.excluded !== 'boolean') return send(res, 400, { error: lt('除外するかどうかを指定してください') });
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 400, { error: lt('この作業には作業用コピーがありません') });
    if (t.mergeExcluded === b.excluded) return send(res, 200, { ok: true, task: t });
    const updated = store.updateTask(p.id, t.id, {
      mergeExcluded: b.excluded,
      memo: b.excluded ? lt('取り込み対象から外しました（作業用コピーと再開先は保持）') : lt('取り込み対象に戻しました'),
    });
    record(b.excluded ? 'mergeexclude' : 'mergeinclude', b);
    return send(res, 200, { ok: true, task: updated });
  }
  // 作業用コピーを本体に取り込んで片付ける
  if (url.pathname === '/api/task/merge') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file) return send(res, 400, { error: lt('作業が見つかりません') });
    const t = store.readTask(file);
    if(require('./public/project-order').integrators(p,t,store.listProjects()).length) return send(res,409,{error:lt('親作業の［統合…］で取り込みます。子作業では［成果を渡す］を行ってください')});
    if (!inWork(p, t)) return send(res, 400, { error: lt('この作業には作業用コピーがありません') });
    if (copyMissing(p, t)) {
      const m = lastMerge(p.id, t.id);
      const when = m ? new Date(m.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const note = m ? lt`この作業は ${when} に本体へ取り込み済みです（作業用コピーはゴミ箱へ移してあります）。` : lt('作業用コピーの場所が見つかりません（消えたか、別の場所に移っています）。');
      store.updateTask(p.id, t.id, { workdir: '', memo: lt`${note} 作業ファイルの古い記録を片付けました` });
      record('mergeskip', b, { merged: Boolean(m) });
      return send(res, 409, { error: lt`${note} 変更は本体に入っています。作業ファイルの古い記録を片付けたので、続きは本体でそのまま始められます` });
    }
    if (t.mergeExcluded) return send(res, 409, { error: lt('取り込み対象から外されています。先に［取り込み対象に戻す］を選んでください') });
    if (removal.busy(p.id, t.id) || maintenance.locked(p.id)) return send(res, 409, { error: lt('AI・整理・確認が動いています。この返事が終わってから取り込んでください') });
    let r;
    try { r = gitw.merge({ dir: expandHome(t.workdir), workRoot: workRoot(p), title: `${t.id} ${t.title}` }); }
    catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    record('merge', b, { ok: Boolean(r.ok), conflict: Boolean(r.conflict), ...(r.ok ? {main:r.main,commit:r.commit,files:r.files} : {}) });
    if (r.conflict) {
      store.updateTask(p.id, t.id, { state: '返事待ち', question: lt('本体に取り込む時にぶつかりました。AI を始めて「本体の最新を取り込み、ぶつかった所を直して」と頼んでから、もう一度［本体に取り込む］を押してください') });
      return send(res, 409, { error: r.error, conflict: true });
    }
    if (!r.ok) return send(res, 400, { error: r.error });
    for (const a of launch.AIS) sessions.stop(b.project, b.task, a);
    const done = store.updateTask(p.id, t.id, { workdir: '', state: '完了', question: '', memo: lt`本体に取り込み、作業用コピーをゴミ箱へ移しました（${r.main}）` });
    try { store.appendSection(p.id, t.id, 'やったこと', lt`- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 本体に取り込み済み（${r.main}）。作業用コピーはゴミ箱へ。workdir は空のままにすること`); } catch (e) { /* 無くてもよい */ }
    return send(res, 200, { ok: true, main: r.main, trashed: r.trashed, task: done });
  }
  // 成果ファイルを選び、保存と受領通知の後に子作業・派生を片付ける。
  if (url.pathname === '/api/task/handup/preview') {
    try { return send(res, 200, taskTransfer.offerPreview(b.project, b.task, b.paths || [], b.expectTitle)); }
    catch (e) { return send(res, 409, {error:e.message}); }
  }
  if (url.pathname === '/api/task/handup' || url.pathname === '/api/task/absorb' && taskTransfer.read(b.project,b.task)?.destination && !taskTransfer.read(b.project,b.task)?.integrating) {
    try {
      const r = url.pathname === '/api/task/handup' ? taskTransfer.offer(b) : taskTransfer.apply(b); if(!r.handedUp)setUnread(b.project,b.task,false);
      record('absorb', {project:r.parentProject,task:r.parent}, {child:b.task,childProject:b.project,files:r.files,receipt:r.record});
      return send(res,200,r);
    } catch(e) { return send(res,409,{error:e.message}); }
  }
  if(url.pathname === '/api/task/integrate/preview') {
    try{return send(res,200,taskIntegrate.preview(b.project,b.task,b.only));}catch(e){return send(res,409,{error:e.message});}
  }
  if(['/api/task/integrate','/api/task/absorb'].includes(url.pathname)) {
    try { const r=taskIntegrate.apply(b); record('integrate',b,{ok:r.ok,complete:r.complete,conflict:r.conflict});pruneUnread();return send(res,r.partial?200:r.conflict?409:200,r); }
    catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/task/results/organize') {
    try { await resultsGate.trigger(b.project,b.task,{manual:true,expectedHash:b.expectedHash}); return send(res,200,{ok:true}); }
    catch(e) {return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/task/integrate/results') {
    try {
      const request=taskIntegrate.resultsRequest(b),role=rolesData().roles.find(r=>r.name==='調査');
      if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定の調査担当を確かめてください'));
      // この画面の明示操作だけ、完了した子へ成果整理を依頼できる。起動失敗時は完了状態を保持。
      return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{allowCompleted:true,resultsOrganize:true,resultsRecovery:b,beforeStart:()=>taskIntegrate.resultsRequest(b)});
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/task/integrate/resolve') {
    try {
      const request=taskIntegrate.conflictRequest(b);
      const role=rolesData().roles.find(r=>r.name==='コーディング');
      if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定のコーディング担当を確かめてください'));
      return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{beforeStart:()=>taskIntegrate.conflictRequest(b)});
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/delegate') return delegateRequest(b,res);
  // 会話に「人の依頼」を残すだけ（ChatGPT アプリに貼って頼んだ時など、Hub では AI を動かさない）
  if (url.pathname === '/api/chat/note') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!file || !text || text.length > 8000) return send(res, 400, { error: lt('作業と依頼を確かめてください') });
    if (p.kind === 'freetalk') freetalk.nameTopic(b.task, text);
    const row = chat.append(p.dir, b.task, { role: 'user', text, to: String(b.to || '').slice(0, 20) });
    chats.emit(p.id, b.task, { type: 'row', row });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/send') {
    // 待っている指示を今すぐ始める（再起動の後など、作業中でない時）
    const fromQueue = b.fromQueue ? chats.queue(b.project, b.task).find(x => x.id === String(b.fromQueue)) : null;
    if (b.fromQueue && !fromQueue) return send(res, 404, { error: lt('その指示はもう待っていません') });
    if (fromQueue) Object.assign(b, { account: fromQueue.account || 'default', ai: fromQueue.ai, model: fromQueue.model, effort: fromQueue.effort, text: fromQueue.text, mode: '' });
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const sharing=p&&removalReview.read(p.id);
    if(sharing?.task===b.task){
      if(!fromQueue?.readOnly||sharing.status!=='running'||![sharing.id,'limit-'+sharing.id].includes(fromQueue.id))return send(res,409,{error:lt('共有確認は削除画面から操作してください')});
      try{
        const r=await chats.sendQueued({...fromQueue,project:p.id,task:b.task,pdir:p.dir,dir:p.dir,request:fromQueue.id,readOnly:true,
          basePrompt:lt('読み取り専用の共有確認です。ファイルを編集せず、判定のJSONだけを返してください。'),policy:lt('読み取り専用。JSONだけを返してください。')});
        if(!(await r.started))throw Error(lt('AIを起動できませんでした'));chats.unqueue(p.id,b.task,fromQueue.id);return send(res,200,{ok:true,ai:r.ai,model:r.model});
      }catch(e){return send(res,409,{error:e.message});}
    }

    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!text) return send(res, 400, { error: lt('依頼を書いてください') });
    const t = store.readTask(file);
    const delegated = Boolean(fromQueue?.requireModel);
    if (delegated && t.state === '完了') return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    const busy = chats.busy(p.id, b.task);
    // redo: 取り消してやり直す ／ amend: 追加説明（一緒にやる）／ queue: 終わったら次に（interrupt は前の呼び名）
    const want = b.mode === 'interrupt' ? 'redo' : b.mode;
    const mode = busy ? (['redo', 'amend', 'queue'].includes(want) ? want : '') : '';
    if (busy && !mode) return send(res, 409, { error: lt('まだ作業中です。［取り消してやり直す］［追加説明（一緒にやる）］［終わったら次に］から選んでください') });
    const spec = pickSpec(t, b.ai);
    const account = requestAccount(p, t.id, b.ai, b.account);
    const model = launch.modelLabel(b.ai, b.model || spec.model);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir, note } = startDir(p, t, Boolean(mode));
    if (b.ai === 'grok' && b.effort === 'Ultra') return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
    const effort = b.ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : spec.effort;
    const basePrompt = taskPrompt(p, t, file, dir) + lt(' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。');
    // 受付時の質問だけを消す。起動待ち中に来た新しい質問には触れない。
    const answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
    const acceptAnswer = () => {
      const current = store.readTask(file);
      if (current.question !== answerQuestion) return null;
      if (current.question || current.state === '返事待ち') store.updateTask(p.id, t.id, { question: '', state: '実行中' });
      return answerQuestion;
    };
    // 追加：今の作業が終わったら続けて行う
    if (mode === 'queue') {
      const it = chats.enqueue(p.id, t.id, { ai: b.ai, account, model, effort, role: t.role, text, perm: permCmd(b.ai) });
      if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
      record('chatqueue', { project: p.id, task: t.id, ai: b.ai }, { model });
      return send(res, 200, { ok: true, queued: true, id: it.id, queue: chats.queue(p.id, t.id).length, answeredQuestion: acceptAnswer() });
    }
    // 取り消し・追加説明：今の作業を区切って（終わるのを待って）から、元の指示と合わせて伝え直す
    let sendText = text;
    if (!busy?.pending && (mode === 'redo' || mode === 'amend')) {
      const last = chat.read(p.dir, t.id).filter(r => r.role === 'user').pop();
      const prev = last ? String(last.text).replace(/\s+/g, ' ').slice(0, 400) : '';
      await chats.stop(p.id, t.id, { interrupting: true });
      record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: b.ai });
      sendText = mode === 'redo'
        ? lt`（人が前の指示「${prev}」を取り消しました。途中で変えたファイルがあれば、必要に応じて元に戻してから、この新しい指示だけを行ってください）\n${text}`
        : lt`（人が追加の説明を送りました。今の指示「${prev}」は取り消さずに続けてください。途中までの作業を活かし、この追加説明も合わせて行ってください）\n${text}`;
    }
    try {
      // 答えを送ったら、AI からの質問は済んだことにする
      // 質問は spawn の成功後にだけ解除する。
      // AI が質問して終わったら「あなたの番」にする（左の丸が黄色になる）
      const onEnd = row => { if (row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || lt('選んでください') }); chatEnded(p.id, t.id); };
      let replacement;
      if (busy?.pending && (mode === 'redo' || mode === 'amend')) {
        replacement = chats.replacePending(p.id, t.id, text, mode);
        await replacement.finished;
      }
      const r = replacement
        ? await chats.sendQueued(replacement.options)
        : await (fromQueue ? chats.sendQueued.bind(chats) : chats.send.bind(chats))({ project: p.id, task: t.id, pdir: p.dir, dir, ai: b.ai, account, model, effort, role: fromQueue ? fromQueue.role || '' : t.role, limitSwitch: fromQueue?.limitSwitch, request: fromQueue?.id, requireModel: Boolean(fromQueue?.requireModel), requiredModel: fromQueue?.requiredModel, text: sendText, shown: fromQueue?.shown || text, mode: mode || (fromQueue ? 'queued' : undefined), basePrompt, policy: modelPolicy(p, t), perm: permCmd(b.ai), onEnd });
      if (!(await r.started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません'));
      if (p.kind === 'freetalk') freetalk.nameTopic(t.id, text);
      const answeredQuestion = delegated ? null : acceptAnswer();
      if (delegated) {
        store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      }
      if (fromQueue) chats.unqueue(p.id, t.id, fromQueue.id);
      if (replacement) {
        chats.unqueue(p.id, t.id, replacement.options.request);
        record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: r.ai });
      }
      record('chat', { project: p.id, task: t.id, ai: r.ai }, { model: r.model, effort: r.effort, resume: r.resume });
      return send(res, 200, { ok: true, model: r.model, effort: r.effort, note: r.limitSwitch?.preflight ? lt('Fable上限保持中のため Astra で開始しました。') : note, resume: r.resume, answeredQuestion });
    } catch (e) { return send(res, 409, { error: String(e.message || e) }); }
  }
  // 未読の印を消す（画面が作業を開いた時）
  if (url.pathname === '/api/task/read') {
    if (typeof b.project !== 'string' || typeof b.task !== 'string') return send(res, 400, { error: lt('作業が見つかりません') });
    setUnread(b.project, b.task, false);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/unqueue') {
    if (fromRemote()) record('chatunqueue', b);
    return send(res, 200, { ok: true, queue: chats.unqueue(b.project, b.task, String(b.id || '')) });
  }
  if (url.pathname === '/api/chat/stop') {
    const ok = Boolean(chats.stop(b.project, b.task));
    if (ok) record('chatstop', b);
    return send(res, 200, { ok });
  }

  // 新しい版にする：本体を起動し直す（動いている AI があれば断る。止まってしまうため）
  // 本体を止める（アプリが、許可のある自分から起動し直すため）。AI が動いている間は断る
  if (url.pathname === '/api/quit') {
    if (updateBusy()) return send(res, 409, { error: appUpdate.idleMessage() });
    if (aiTools.isOperating()) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: lt`動いている AI が ${busy} つあります` });
    record('quit', {}, { reason: String(b.reason || '') });
    send(res, 200, { ok: true });
    if (!DRY) setTimeout(shutdown, 200);
    return undefined;
  }
  if (url.pathname === '/api/restart') {
    if (updateBusy()) return send(res, 409, { error: appUpdate.idleMessage() });
    if (aiTools.isOperating()) return send(res, 409, { error: lt('AI の更新・モデル再取得が進行中です') });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: lt`動いている AI が ${busy} つあります。止めてから（または返事が終わってから）押してください` });
    record('restart', {}, { from: VERSION, to: readVersion() });
    send(res, 200, { ok: true, from: VERSION, to: readVersion() });
    if (DRY) return undefined;
    setTimeout(() => {
      server.close();
      const { spawn } = require('child_process');
      // 同じ設定で新しい本体を起動してから、この本体は終わる（新しい方は待ち受けが空くまで少し待つ）
      const nextHub = appUpdate.restartNeeded ? path.join(appUpdate.source, 'hub') : __dirname;
      const child = spawn(process.execPath, [path.join(nextHub, 'server.js')], { cwd: nextHub, env: { ...process.env, HUB_UPDATE_SOURCE: appUpdate.source, HUB_RESTART_WAIT: '1' }, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      process.exit(0);
    }, 200);
    return undefined;
  }

  // CLI に渡すモデル名を保存する
  if (url.pathname === '/api/cli-models') {
    const clean = x => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length < 40 && /^[\w.:\-/\[\]]*$/.test(v.trim())).map(([k, v]) => [k, v.trim()])) : {});
    saveCliModels({ claude: clean(b.claude), codex: clean(b.codex) });
    record('climodels', {});
    return send(res, 200, { ok: true, overrides: launch.getOverrides() });
  }

  // Mac のフォルダ選択の窓を出して、選んだ場所を返す
  if (url.pathname === '/api/pick-folder') {
    if (DRY) return send(res, 200, { path: '' });
    const { execFile } = require('child_process');
    if (process.platform === 'win32') {
      // Windows はフォルダ選択の窓（.NET）を PowerShell から出す。出力は UTF-8 にそろえる
      const prompt = String(b.prompt || lt('フォルダを選んでください')).replace(/[\r\n'"`$]/g, '');
      const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { timeout: 10 * 60 * 1000, windowsHide: true }, (err, out) => send(res, 200, { path: err ? '' : String(out).trim() }));
      return undefined;
    }
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(b.prompt || lt('フォルダを選んでください')).replace(/["\\]/g, '')}")`], (err, out) => {
      if (err) return send(res, 200, { path: '' }); // 取り消した時
      return send(res, 200, { path: String(out).trim().replace(/\/$/, '') });
    });
    return undefined;
  }
  // アプリの窓に落としたファイル（場所が分かる物）を渡す：作業ファイルに記録し、AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/attach') {
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x)).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 20);
    if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
    if (!paths.length) return send(res, 400, { error: lt('ファイルが見つかりません') });
    store.updateTask(p.id, b.task, { memo: lt`ファイルを渡した: ${paths.join(' , ')}` });
    const ai = launch.AIS.includes(b.ai) ? b.ai : '';
    const typed = ai ? sessions.write(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ') : false;
    record('upload', { project: p.id, task: b.task, ai }, { file: paths.join(' , ') });
    return send(res, 200, { ok: true, paths, typed });
  }

  // 参考フォルダ・ファイルを足す（作った後のプロジェクトにも）
  if (url.pathname === '/api/project/refs') {
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 30);
    if (!paths.length) return send(res, 400, { error: lt('フォルダが見つかりません') });
    const r = store.addRefs(b.project, paths);
    if (!r) return send(res, 400, { error: lt('プロジェクトが見つかりません') });
    record('refs', { project: b.project }, { paths: paths.join(' , ') });
    return send(res, 200, { ok: true, added: r.added, folders: r.project.folders });
  }

  // 新しいプロジェクトを始める
  // 中身の無い作業・子プロジェクトを探す／ゴミ箱へまとめて移す
  if (url.pathname === '/api/empty/scan' || url.pathname === '/api/empty/trash') {
    const busy = (project, task) => sessions.list().some(x => x.running && x.project === project && x.task === task) || Boolean(chats.busy(project, task));
    if (url.pathname === '/api/empty/scan') return send(res, 200, { ok: true, items: emptyLib.scan(store, busy) });
    const r = emptyLib.trash(store, busy, Array.isArray(b.items) ? b.items : []);
    record('emptytrash', {}, { moved: r.moved });
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname.startsWith('/api/hierarchy/remove/')) {
    try {
      let result;
      if(url.pathname.endsWith('/preview')) {const review=b.task?null:removalReview.status(b.project);result={...removal.preview(b.project,b.task),review};}
      else if(url.pathname.endsWith('/review/start')) result=await removalReview.begin(b.token);
      else if(url.pathname.endsWith('/review/status')) {const review=removalReview.status(b.project);result={review,...(review?.status!=='running'?{preview:{...removal.preview(b.project),review}}:{})};}
      else if(url.pathname.endsWith('/apply')) {result=removal.apply(b);pruneUnread();record('remove',{}, {transaction:result.record,moved:result.moved.length});}
      else if(url.pathname.endsWith('/restore')) {result=removal.restore(b.record,b.confirm);record('removerestore',{}, {transaction:b.record});}
      else if(url.pathname.endsWith('/history')) result={history:removal.history()};
      else return send(res,404,{error:'not found'});
      return send(res,200,result);
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname.startsWith('/api/maintenance/')) {
    try {
      let result;
      if (url.pathname === '/api/maintenance/preview') result=maintenance.preview(b.project);
      else if (url.pathname === '/api/maintenance/apply') {result=maintenance.apply(b.project,b.token,b.selected,b.confirm);record('cleanup', {project:b.project}, {transaction:result.id,moved:result.moved});}
      else if (url.pathname === '/api/maintenance/restore') {result=maintenance.restore(b.project,b.transaction,b.confirm);record('restore',{project:b.project},{transaction:b.transaction});}
      else if (url.pathname === '/api/maintenance/solve') {result=await problemResolution.solve(b.project);record('problemsolve',{project:b.project,task:result.task},{reused:result.reused,clear:result.clear});}
      else if (url.pathname === '/api/maintenance/verify') {result=await maintenance.verify(b.project,b.script,b.expectedHash,b.confirm);record('verify',{project:b.project},{ok:result.ok,script:b.script});}
      else return send(res,404,{error:lt('操作が見つかりません')});
      return send(res,200,result);
    } catch(e) {return send(res,409,{error:e.message,...(e.task?{task:e.task}:{})});}
  }
  if (url.pathname === '/api/hierarchy/pin') {
    try {
      const result = projectOrder.pin(b);
      record('projectpin', { project: b.project }, { pinned: b.pinned });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/order') {
    try {
      const result = projectOrder.save(b);
      record('projectorder', {}, { parent: b.parent, order: b.order });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/rename') {
    try {
      const { Hierarchy } = require('./lib/hierarchy');
      const value = new Hierarchy(store, id => sessions.list().some(s=>s.project===id && s.running) || [...chats.running.keys()].some(k=>k.startsWith(id+'\u0000'))).rename(b.project, b.task, b.name, b.expectedHash);
      record('rename', { project: b.project, task: b.task }); return send(res, 200, value);
    } catch(e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/project/new') {
    const body = expandHome(b.body || '');
    if (body && !fs.existsSync(body)) return send(res, 400, { error: lt`本体のフォルダが見つかりません: ${body}` });
    if (body && !fs.statSync(body).isDirectory()) return send(res, 400, { error: lt`フォルダではありません（ファイルです）: ${body}` });
    const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x));
    const r = store.createProject({ ...b, body, refs }, path.join(__dirname, '..', 'docs', 'project-hub', 'templates', ...(locale()==='zh-TW'?['zh-TW']:[]), 'project'));
    if (r.error) return send(res, 400, { error: r.error });
    record('newproject', { project: r.project.id });
    return send(res, 200, r.project);
  }
  if (url.pathname === '/api/task/new') {
    const t = store.createTask(b.project, b);
    if (t) record('newtask', { project: b.project, task: t.id }, { title: t.title });
    return t ? send(res, 200, t) : send(res, 400, { error: lt('作業名・親作業・派生元を確認してください') });
  }

  // 選ぶ欄にモデルを出す・出さない
  if (url.pathname === '/api/models/hidden') {
    if (!['claude-code', 'codex', 'agy', 'grok'].includes(b.ai) || typeof b.model !== 'string' || !b.model) return send(res, 400, { error: lt('形式が違います') });
    return send(res, 200, { ok: true, ...modelView.setHidden(b.ai, b.model, Boolean(b.hidden)) });
  }
  if (url.pathname === '/api/models/initial') {
    const r = modelView.setInitial(b, rolesData().models, modelError);
    if (r.error) return send(res, r.status, { error: r.error });
    record('initialai', {}, r.initialPick);
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/phone') {
    const r = modelView.setPhone(b, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/order') {
    const r = modelView.setOrder(b.order, b.before, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  // 最新のモデルに整理：役割の古いモデル名を、同じ系統の一番新しいモデルに。roles.yaml の一覧も今のものに
  if (url.pathname === '/api/models/tidy') {
    const r = roles.tidy(ROLES_FILE);
    if (!r.ok) return send(res, 400, { error: r.error });
    record('modeltidy', {}, { changes: r.changes.length });
    return send(res, 200, { ok: true, changes: r.changes, roles: rolesData() });
  }
  // 役割分担の保存
  if (url.pathname === '/api/roles') {
    if (!Array.isArray(b.roles)) return send(res, 400, { error: lt('形式が違います') });
    const r = roles.write(ROLES_FILE, b.roles);
    return r.ok ? send(res, 200, r.data) : send(res, 400, { error: r.errors.join(' / ') });
  }

  return send(res, 404, { error: 'not found' });
}

function serveStatic(res, pathname) {
  if(pathname==='/locale-config.js')return send(res,200,configScript(),TYPES['.js']);
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// 外から（tailscale serve 越し）の要求：オフなら断る。オンなら合言葉で入った札が要る
async function remoteGate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!remote.enabled()) return isApi ? send(res, 403, { error: lt('外からの利用はオフです') }) : send(res, 403, remoteLib.offPage(), 'text/html; charset=utf-8');
  remote.noteHost(req.headers['x-forwarded-host'] || req.headers.host);
  // 書き換える操作は、この画面から送った物だけ（ほかのサイトから送らせない）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin, hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => `https://${h}`);
    if (req.headers['x-hub'] !== '1' || (origin && !hosts.includes(origin))) return send(res, 403, { error: 'forbidden' });
  }
  if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, remoteLib.loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: lt('形式が違います') }); }
    const who = remoteLib.whoOf(req), r = remote.login(b.passcode, who, req.headers['user-agent']);
    record('remotelogin', {}, { ok: Boolean(r.ok), who });
    if (!r.ok) return send(res, r.status, { error: r.error });
    res.setHeader('Set-Cookie', remoteLib.sessionCookie(r.token));
    return send(res, 200, { ok: true });
  }
  const token = remoteLib.cookieOf(req);
  if (!remote.check(token)) {
    if (isApi) return send(res, 401, { error: lt('ログインしてください'), login: true });
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    remote.logout(token); record('remotelogout', {});
    res.setHeader('Set-Cookie', remoteLib.clearCookie());
    return send(res, 200, { ok: true });
  }
  if (isApi) return api(req, res, url);
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  return serveStatic(res, url.pathname);
}

async function quickStart(b, maintenanceRequest = false) {
  const reply = (status, body) => ({ status, body });
  const p = store.readProject(b.project), text = String(b.text || '').trim();
  const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
  const agents = new Set([...rolesData().agents, ...store.listProjects().flatMap(x => x.tasks.map(t => t.owner).filter(o => o && !/claude|codex|agy|grok|^chatgpt$|^(人|あなた)$/i.test(o)).map(o => o.replace(/^discord:\s*/i, '')))]);
  const agent = typeof ai === 'string' && ai.startsWith('discord:') && agents.has(ai.slice(8));
  if (!p || (!text && !(b.images || []).length) || (!launch.AIS.includes(ai) && !agent)) return reply(400, { error: lt('依頼と担当を確認してください') });
  if ((!maintenanceRequest && text.length > 4000) || !Array.isArray(b.images) || b.images.length > 10) return reply(400, { error: lt('依頼は4000文字、画像は10枚までです') });
  if (!agent && aiTools.isOperating()) return reply(409, { error: lt('AI の更新・モデル再取得が進行中です') });
  const ph = p.phases.find(x => x.state !== '完了');
  const spec = agent ? { model: '', effort: '' } : pickSpec({ role: ph?.role, model: b.model, effort: b.effort }, ai);
  const invalid = !agent && modelError(ai, spec.model);
  if (invalid) return reply(409, { error: invalid });
  const receiptFile = path.join(p.dir, '.ai', 'start-request.json');
  let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { /* 初回 */ }
  if (b.request && receipt?.request === b.request && receipt.result) return reply(200, receipt.result);
  const writeReceipt = value => { if (b.request) { fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); fs.writeFileSync(receiptFile, JSON.stringify({ request: b.request, ...value })); } };
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
      if (!DRY && !(await chats.send(turn).started)) throw Error(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (remoteLib.isRemote(req)) return await reqCtx.run({ remote: true }, () => remoteGate(req, res, url));
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    return send(res, e.status || 500, { error: String(e.message || e) });
  }
});

function shutdown() { appUpdate.stop(); procwatch.stop(); sessions.stopAll(); chats.stopAll(); server.close(); process.exit(0); }

if (require.main === module) {
  // 新しい版に切り替える時は、前の本体が待ち受けを空けるまで少し待つ
  let tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && process.env.HUB_RESTART_WAIT && tries++ < 50) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 200);
    console.error(e.code === 'EADDRINUSE' ? lt`ポート ${PORT} は使われています（もう起動しているかもしれません）` : e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Project Hub ${VERSION}`);
    console.log(lt`Project Hub: http://127.0.0.1:${PORT}  （台帳の場所: ${ROOT}）`);
    console.log(sessions.available() ? lt('作業画面: 使えます') : lt('作業画面: 部品（node-pty）が未設定。setup.sh を実行してください'));
    console.log(lt('止める時は、この窓で Control + C'));
    if (!DRY) { procwatch.start(); appUpdate.start(); }
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, PORT, sessions, taskPrompt };
