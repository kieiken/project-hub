'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// Project Hub 第3版の画面
// 左：プロジェクトと作業の木 ／ 右：概要画面 または 作業画面（Claude Code と Codex を並べられる）
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeChatUrl = value => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
};
const STATES = ['未着手', '実行中', '返事待ち', '停止', '上限で停止', '完了'];
const RESULTS_WAIT = t => t.resultsPending && t.resultsPending.auto !== 'running' && t.resultsPending.code !== 'checking';
const NEEDS = t => RESULTS_WAIT(t) || t.completionPending || t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
// 返事が必要（あなたの番の数に入れる）。完了に移すだけのものは入れない
// Only recorded requests need a reply. Terminal silence also occurs during work.
const REPLY = (p, t) => t.chatQueueBlocked || t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
const WORKING = (p, t) => Boolean(live(p.id, t.id) || (t.chatQueueCount > 0 && !t.chatQueueBlocked) || t.resultsPending?.auto === 'running' || t.resultsPending?.code === 'checking' || bgOf(p.id, t.id).length || (state.webchat?.jobs || []).some(j => j.project === p.id && j.task === t.id && ['queued', 'checking', 'sending', 'tools', 'reporting'].includes(j.state)));
// 成果不備だけでは返事を求めない。実質問・停止対応 → 稼働 → 成果確認 → 完了承認の順に一度だけ数える。
const notificationKind = (p, t) => REPLY(p, t) ? 'reply' : WORKING(p, t) ? 'work' : RESULTS_WAIT(t) ? 'results' : t.completionPending ? 'done' : '';
const CONFIRM = (p, t) => notificationKind(p, t) === 'done';
const CLI = o => /claude|codex|agy|grok/i.test(o || '') || !o;
const aiOf = o => (/grok/i.test(o || '') ? 'grok' : /agy/i.test(o || '') ? 'agy' : /codex/i.test(o || '') ? 'codex' : 'claude');
const AIS = ['claude', 'codex', 'agy', 'grok'];
const AI_ICON = { muse: 'M', claude: 'C', codex: 'X', agy: 'G', grok: 'K', chatgpt: 'G', 'chatgpt-chat': 'G', dot: 'D' };
const AI_KEY = { claude: 'claude-code', codex: 'codex', agy: 'agy', grok: 'grok' };
const effortsFor = ai => ai === 'agy' ? ['高'] : (state.efforts || []).filter(e => ai !== 'grok' || e !== 'Ultra');
const effortHidden = ai => ['agy', 'chatgpt', 'muse'].includes(ai);
const aiUnavailable = ai => ai === 'agy' ? !state.agyAvailable : ai === 'grok' ? !state.grokAvailable : false;
const AI_LABEL = { muse: 'Muse', claude: 'Claude Code', codex: 'Codex', agy: 'Agy CLI', grok: 'Grok', chatgpt: 'ChatGPT', 'chatgpt-chat': UI.text('ChatGPT（Chat）'), dot: 'Dot' };
// 未保存の新規開始とツリーからの子作業に使う初期AI。役割の担当設定とは別。
const INITIAL_PICK = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
const initialPick = () => state?.initialPick || INITIAL_PICK;
const defaultWorkPick = role => state.specialMode?.enabled ? window.HubSpecialMode.pick(state.specialMode, state.roles, role) : initialPick();
const specialOverrides = new Map(); // ON/OFFにかかわらず現在の手動指定を受付まで保持。過去の保存選択とは分ける。
// 担当の種類：画面の中の AI（丸）・Discord のエージェント（角）・あなた（黄）・ChatGPT（会話画面から自動送信し、GPT子で作業する）
function ownerOf(o) {
  const v = String(o || '').trim();
  if (/^dot$/i.test(v)) return { kind: 'dot', name: 'Dot', ic: 'D' };
  if (/^chatgpt$/i.test(v)) return { kind: 'chatgpt', name: 'ChatGPT', ic: 'G' };
  if (!v || /claude|codex|agy|grok/i.test(v)) return { kind: aiOf(v), name: AI_LABEL[aiOf(v)], ic: AI_ICON[aiOf(v)] };
  if (/^(人|あなた)$/.test(v)) return { kind: 'you', name: UI.text('あなた'), ic: '人' };
  const name = v.replace(/^discord:\s*/i, '');
  return { kind: 'agent', name, ic: name.slice(0, 1), sub: 'Discord' };
}
function chip(p, t) {
  const o = ownerOf(t.owner), running = AIS.includes(o.kind) ? live(p.id, t.id, o.kind) : false;
  const sub = o.kind === 'agent' ? o.sub : (['you', 'chatgpt', 'dot'].includes(o.kind) ? '' : specText(t, o.kind));
  return UI.template`<span class="chip k-${o.kind}"><span class="ic">${esc(o.ic)}</span>${esc(o.name)}${sub ? UI.template`<small>・${esc(sub)}</small>` : ''}${running ? UI.html('<span class="blink" title="作業中"></span>') : ''}</span>`;
}
// 進み具合：手順があれば手順の数、なければ状態から
function progressOf(t) {
  if (stepCount(t)) return { done: t.stepSummary?.done ?? t.steps.filter(x => x.done).length, all: stepCount(t) };
  return { done: t.state === '完了' ? 1 : 0, all: 1 };
}
const stepCount = t => t.stepSummary?.total ?? t.steps?.length ?? 0;
function progressBar(t) {
  const { done, all } = progressOf(t), fin = t.state === '完了';
  const marks = t.stepSummary?.marks ?? (t.steps || []).map(s=>s.done?'1':'0').join('');
  const segs = stepCount(t) ? Array.from(marks,x => UI.template`<i class="${x === '1' ? 'on' : ''}"></i>`).join('') : UI.template`<i class="${fin ? 'on' : ''}"></i>`;
  return UI.template`<div class="prog ${fin ? 'fin' : ''}"><div class="segs">${segs}</div><span>${stepCount(t) ? `${done} / ${all}` : ''}${fin ? UI.text('　完了 ✓') : ''}</span></div>`;
}
// フェーズ：今のフェーズ＝最初の未完了。作業は phase で分ける（無ければ今のフェーズに入れる）
function phaseInfo(p) {
  const names = p.phases.map(ph => ph.name);
  const cur = p.phases.findIndex(ph => ph.state !== '完了');
  const curName = cur >= 0 ? names[cur] : '';
  const inPhase = (t, i) => (names.includes(t.phase) ? t.phase === names[i] : i === cur);
  const list = p.phases.map((ph, i) => {
    const ts = p.tasks.filter(t => inPhase(t, i));
    const got = ts.reduce((a, t) => a + progressOf(t).done, 0), all = ts.reduce((a, t) => a + progressOf(t).all, 0);
    const tasksDone = ts.length > 0 && ts.every(t => t.state === '完了');
    return { name: ph.name, role: ph.role, completionPending: ph.completionPending, state: ph.state || '未着手', tasks: ts, ratio: ph.state === '完了' ? 1 : all ? got / all : 0, tasksDone };
  });
  return { list, cur, curName, done: list.filter(x => x.state === '完了').length, inPhase };
}
function ring(done, all) {
  const c = 37.7, off = all ? c * (1 - done / all) : c;
  return UI.template`<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--idle-bg)" stroke-width="3"/><circle cx="8" cy="8" r="6" fill="none" stroke="${done === all && all ? 'var(--ok)' : 'var(--accent)'}" stroke-width="3" stroke-dasharray="${c}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`;
}

let state = { projects: [], root: '', roles: { models: {}, roles: [] }, sessions: [], terminal: false, efforts: [] };
let view = { kind: 'project', project: null, task: null }; // project | work | turn | settings
let open = new Set(); // 左の木で開いているプロジェクト
const projectNotesOpen = new Set(); // 説明・メモは初期状態で閉じ、ページ内だけ開閉を覚える
let panes = {}; // ai → { xterm, fit, es, ro }
let rolesDraft = null;
let rolesDraftRevision = null;
let checkCreditsDraft = null;
let preferCreditsDraft = null;
const creditCheckSettings = () => ({ claude: state.roles.checkCredits?.claude === true, codex: state.roles.checkCredits?.codex === true });
const roleAssignmentsDirty = () => Boolean(rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles));
const creditsDirty = () => Boolean(checkCreditsDraft && JSON.stringify(checkCreditsDraft) !== JSON.stringify(creditCheckSettings()) || preferCreditsDraft !== null && preferCreditsDraft !== (state.roles.preferCredits === true));
function rolesDirty() {
  return Boolean(rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles) ||
    checkCreditsDraft && JSON.stringify(checkCreditsDraft) !== JSON.stringify(creditCheckSettings()) ||
    preferCreditsDraft !== null && preferCreditsDraft !== (state.roles.preferCredits === true));
}
function clearRolesDraft() { rolesDraft = null; rolesDraftRevision = null; checkCreditsDraft = null; preferCreditsDraft = null; }
let stateLoadEpoch = 0;
let renderedTreeKey = '', renderedMainKey = '';
try { const v = JSON.parse(localStorage.getItem('hub-view') || 'null'); if (v) view = v; open = new Set(JSON.parse(localStorage.getItem('hub-open') || '[]')); } catch (e) { /* 使えない時はそのまま */ }

let stateTag = ''; // 一覧の印（本体が「変わっていない」を答えるために送り返す）
const stateResponseTags = new WeakMap(); // 採用前の印は応答ごとに保持し、破棄・並行取得で混ぜない。
async function api(path, body, headers) {
  if(body?.project&&body.task&&globalThis.HubChatGenerations?.has(body.project+'\0'+body.task)&&body.generation===undefined)body={...body,generation:globalThis.HubChatGenerations.get(body.project+'\0'+body.task)};
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) } : {};
  if (headers) opt.headers = { ...opt.headers, ...headers };
  const r = await fetch(path, opt);
  if (r.status === 304) return null; // 変わっていない（一覧の取得）
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || UI.text('失敗しました')); e.status = r.status; e.reason = j.reason; e.stage = j.stage; e.code = j.code; e.waiting = j.waiting; e.task = j.task; e.blocker = j.blocker; e.delivery = j.delivery; e.queued = j.queued; e.id = j.id; throw e; }
  if (path === '/api/state') stateResponseTags.set(j, (r.headers && r.headers.get && r.headers.get('etag')) || '');
  return j;
}
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { e.hidden = true; }, 3000); }
function save() { try { localStorage.setItem('hub-view', JSON.stringify(view)); localStorage.setItem('hub-open', JSON.stringify([...open])); } catch (e) { /* 無視 */ } }

const proj = id => state.projects.find(p => p.id === id);
const taskOf = (p, id) => p && p.tasks.find(t => t.id === id);
const sessOf = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && s.ai === ai && s.running);
function statusText(s) {
  if (!s) return '';
  return UI.html('<span class="pst busy"><i></i>作業中</span>');
}
const live = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && (!ai || s.ai === ai) && s.running)
  || (!ai && (state.chatting || []).find(c => c.project === p && c.task === t));

function specOf(t, ai) {
  const r = state.roles.roles.find(x => x.name === t.role);
  const key = AI_KEY[ai];
  const slot = r ? (r.main.ai === key ? r.main : r.backup.ai === key ? r.backup : null) : null;
  const model = t.model || (slot && slot.model) || '';
  return { model: ai === 'agy' ? agyModelLabel(model) : model, effort: ai === 'agy' ? '高' : state.efforts.includes(t.effort) ? t.effort : (slot && slot.effort) || '' };
}
function agyModelLabel(model) { return (state.agyModels || []).find(row => row.id === model || row.label === model)?.label || model; }
function modelRequest(ai, model) { return ai === 'agy' ? (state.agyModels || []).find(row => row.label === model || row.id === model)?.id || model : model; }
function modelOptionLabel(ai, model) { return ai === 'agy' ? agyModelLabel(model) : model; }
function adoptAgyCatalog(result) {
  const catalog = result.agyCatalog; if (!catalog) return;
  state.agyModels = catalog.models; state.agyModelsState = catalog.state; state.agyModelError = catalog.error; state.agyAvailable = catalog.available;
  state.roles.models.agy = catalog.models.map(row => row.label);
  state.cliFlags ||= {}; state.cliFlags.agy = { ...state.cliFlags.agy, ...Object.fromEntries(catalog.models.map(row => [row.label,row.id])) };
}
const specText = (t, ai) => { const s = specOf(t, ai); return [s.model, UI.label(s.effort)].filter(Boolean).join(UI.text('・')); };

// 一覧の取得。本体は前回と同じなら中身を送らない（304）ので、その時は今の state を使う
async function fetchState() {
  const next = await api('/api/state', null, stateTag ? { 'If-None-Match': stateTag } : undefined);
  return next || (state ? null : await api('/api/state'));
}
let restartWatch = null, restartReloaded = false;
const RESTART_DRAFT_KEY = 'hub-restart-drafts';
function restartDraftMaps() {
  return { queueDrafts, askDrafts, chatAttachments, quickDrafts, specialOverrides, freetalkSummaryDrafts, freetalkPromotionDrafts };
}
function restoreRestartDrafts() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RESTART_DRAFT_KEY) || 'null');
    if (!saved) return;
    chatDraft = saved.chatDraft || {};
    rolesDraft = saved.rolesDraft ?? null; rolesDraftRevision = saved.rolesDraftRevision ?? null; checkCreditsDraft = saved.checkCreditsDraft ?? null; preferCreditsDraft = saved.preferCreditsDraft ?? null;
    for (const [name, map] of Object.entries(restartDraftMaps())) for (const [key, value] of saved.maps?.[name] || []) map.set(key, name==='freetalkPromotionDrafts'?{...value,creating:false}:value);
    for (const key of saved.quickOverrides || []) quickOverrides.add(key);
    chatFileSequence = saved.chatFileSequence || 0;
    sessionStorage.removeItem(RESTART_DRAFT_KEY);
  } catch (_) { /* 保存が使えなくても起動は続ける */ }
}
function reloadAfterRestart() {
  if (restartReloaded) return true;
  const maps = Object.fromEntries(Object.entries(restartDraftMaps()).map(([name, map]) => [name, [...map]]));
  const hasDraft = Object.values(chatDraft).some(Boolean) || rolesDirty() || Object.values(maps).some(rows => rows.length);
  if (hasDraft) {
    try { sessionStorage.setItem(RESTART_DRAFT_KEY, JSON.stringify({ chatDraft, rolesDraft, rolesDraftRevision, checkCreditsDraft, preferCreditsDraft, maps, quickOverrides: [...quickOverrides], chatFileSequence })); }
    catch (_) { toast(UI.text('入力の保存ができないため、画面の再読込を待っています。')); return false; }
  }
  save(); restartReloaded = true; location.reload(); return true;
}
function observeRestart(next) {
  // 200msの再起動を15秒の一覧取得が見逃しても、旧画面のJSを残さない。
  if(state.hubInstance&&next.hubInstance&&state.hubInstance!==next.hubInstance){restartWatch ||= {instance:state.hubInstance,version:state.version};reloadAfterRestart();return;}
  if (!restartWatch && (state.restart?.reserved || state.restart?.committed)) restartWatch = { instance: state.hubInstance, version: state.version };
  if (!restartWatch && (next.restart?.reserved || next.restart?.committed)) restartWatch = { instance: next.hubInstance, version: next.version };
  if (!restartWatch) return;
  // 予約→確定の短い間を一覧取得が飛ばしても、新しい起動を検知する。取消では再読込しない。
  const changed = next.hubInstance && restartWatch.instance ? next.hubInstance !== restartWatch.instance : next.version !== restartWatch.version;
  if (changed) { reloadAfterRestart(); return; }
  if (!next.restart?.reserved && !next.restart?.committed) restartWatch = null;
}
function adoptState(next) {
  const previousSpecial = JSON.stringify(state.specialMode);
  const previousModels = JSON.stringify([state.roles?.models,state.modelOrder,state.hiddenModels,state.agyModels]);
  observeRestart(next);
  if (!rolesDirty() && state.roles.management?.revision !== next.roles.management?.revision) clearRolesDraft();
  state = next;
  if (previousSpecial !== JSON.stringify(state.specialMode)) syncSpecialModeChange();
  if (previousModels !== JSON.stringify([state.roles?.models,state.modelOrder,state.hiddenModels,state.agyModels])) syncChatModelChoices();
  drawShellAlerts();
  syncChatHandoff();
  stateTag = stateResponseTags.get(next) || ''; // 一覧を採用した時だけ、その一覧の印も進める。
}
async function load({ preserveMain = false } = {}) {
  const epoch = ++stateLoadEpoch;
  const next = await fetchState();
  if (epoch !== stateLoadEpoch || webchatUIPending() || accountSelectionSaving || taskFastSaving || accelerationSaving) return;
  if (next) adoptState(next);
  syncAccountPickers();
  syncChatWebchatAvailability();
  if (!proj(view.project)) view.project = state.projects[0] ? state.projects[0].id : null;
  if (view.kind === 'work' && !taskOf(proj(view.project), view.task)) {
    const source={...view};
    if(source.project==='freetalk' && source.task)try {
      const h=await api('/api/freetalk/status?project=freetalk&task='+encodeURIComponent(source.task));
      if(epoch!==stateLoadEpoch || view.project!==source.project || view.task!==source.task)return;
      if(h.automaticCompleted && proj(h.migrated.project)){view={kind:'work',project:h.migrated.project,task:h.migrated.task};save();}
    }catch{/* A normally deleted topic has no migration receipt. */}
    if(view.project===source.project && view.task===source.task)view.kind='project';
  }
  showInTree();
  if (preserveMain && view.kind === 'work') { syncWorkQuestion(); syncTaskSteps(); updateTurnCounts(); renderTree(); window.HubMobile?.badges(); }
  else render();
}
// 今見ている物が左の木で見えるように、上の階層だけ開く（開き直すのは見る物が変わった時だけ。閉じた物は閉じたまま）
let shownKey = '';
/* @app-function app-tree.js:showInTree */

// ---- 左の木 ----
/* @app-function app-tree.js:childrenProjects */
// 子プロジェクト：親（parent）か派生元（derivedFrom）がこのプロジェクト
/* @app-function app-tree.js:childrenOf */
const unfinishedChildren = p => childrenOf(p).filter(q => q.status !== '完了');
/* @app-function app-tree.js:displayParent */
const isProjectPinned = id => (state.projectPins || []).includes(id);
const canReorderProjects = () => true;
const canDragProjects = () => !isPhone();
const projectSiblings = parent => ProjectOrder.siblings(state.projects, parent, state.projectOrder || {}, state.projectPins || []);
// 派生元も載せる既存の子一覧は保ち、各階層内だけを左の一覧と同じ順にする。
/* @app-function app-tree.js:orderedChildren */
/* @app-function app-tree.js:treeMenuButton */
// 未読：AI の作業が終わったのに、まだその作業を開いていない（本体の unread に入っている）
const isUnread = (pid, tid) => (state.unread || []).some(u => u.project === pid && u.task === tid);
/* @app-function app-tree.js:markRead */
// 数字だけでは用件が分からないため、プロジェクト・作業で同じ名前を使う。
/* @app-function app-tree.js:notificationBadges */
// GitHub の場所（作業用コピーがあればその枝、無ければ本体）
/* @app-function app-tree.js:githubCreateButton */
/* @app-function app-tree.js:githubUrl */
const TASK_TRANSFER_MIN_VERSION = [4, 61, 0];
/* @app-function app-project.js:transferNeedsUpdate */
/* @app-function app-project.js:transferUpdateMessage */
/* @app-function app-project.js:transferButton */
// Fresh preview evidence is scoped to the exact old record and expires. It is
// presentation only; the persisted intent and replay protection stay untouched.
const integrationMainEvidence=new Map();
/* @app-function app-project.js:integrationOfferPending */
/* @app-function app-project.js:integrationMainNotice */
// An unchanged retained child is available in history, but never a request to
// integrate again. Only new offers, handoffs, or unfinished receipt work use it.
/* @app-function app-project.js:kidsDoneBar */
/* @app-function app-project.js:refreshKidsDoneBar */
/* @app-function app-project.js:partialReceiptBar */
// 作業用コピーが残っている作業の一覧（押すとその作業へ。作業画面の［本体に取り込む］で取り込み、コピーはゴミ箱へ）
/* @app-function app-project.js:copiesHtml */
// 所属する子だけを字下げし、派生は元と同じ段に並べる。
/* @app-function app-tree.js:treeTasks */
/* @app-function app-tree.js:taskTarget */
/* @app-function app-tree.js:branchText */
/* @app-function app-tree.js:taskTree */
// プロジェクトの丸：灰＝まだ始めていない／赤＝AI が作業中／薄緑＝処理が終わった／紫＝人が完了にした
// 裏で動いている AI：Hub を通さずに起動された codex / claude / agy（本体の見張りが見つけたもの）
const bgOf = (pid, tid) => (state.background || []).filter(x => x.project === pid && (!tid || x.task === tid));
const bgText = list => list.map(x => `${AI_LABEL[x.ai] || x.ai}（${dur(Date.now() - Date.parse(x.since))}）`).join(UI.text('・'));
/* @app-function app-tree.js:projectLight */
// 作業（子）の丸：黄＝返事待ち／赤＝作業中／青＝完了報告。承認済みの状態色は別に保つ。
/* @app-function app-tree.js:taskLight */
/* @app-function app-tree.js:projectNode */
const waitingKey = s => [s.project, s.task, s.ai, s.running];
/* @app-function app-tree.js:treeKey */
/* @app-function app-tree.js:mainKey */
const freetalkSummaryDrafts = new Map();
const freetalkPromotionDrafts = new Map(), freetalkPromotionErrors = new Map();
const freetalkPromotionOperations = new Map();
const FREETALK_DRAFT_KEY='hub-freetalk-promotion-drafts';
/* @app-function app-freetalk.js:persistFreetalkPromotionDrafts */
/* @app-function app-freetalk.js:restoreFreetalkPromotionDrafts */
document.addEventListener('visibilitychange',/* @app-callback app-freetalk.js:appFreetalkCallback450 */appFreetalkCallback450());
/* @app-function app-freetalk.js:beginFreetalkPromotionOperation */
/* @app-function app-freetalk.js:beginFreetalkCleanupOperation */
/* @app-function app-freetalk.js:freetalkCleanupHtml */
/* @app-function app-freetalk.js:freetalkPromotionSize */
/* @app-function app-freetalk.js:freetalkPromotionBlocked */
/* @app-function app-freetalk.js:freetalkPromotionHtml */
/* @app-function app-freetalk.js:prepareFreetalkPromotion */
document.addEventListener('input',/* @app-callback app-freetalk.js:appFreetalkCallback490 */appFreetalkCallback490());

/* @app-function app-freetalk.js:replaceFreetalkHistory */
/* @app-function app-freetalk.js:syncFreetalkMigrationControls */
/* @app-function app-freetalk.js:freetalkHistoryHtml */
let freetalkStatusSeq=0;
/* @app-function app-freetalk.js:syncFreetalkHistory */
document.addEventListener('input',/* @app-callback app-freetalk.js:appFreetalkCallback557 */appFreetalkCallback557());
/* @app-function app-tree.js:freetalkTopics */
// 左の2グループは表示だけを切り替える。detailsの外側タップ閉鎖とは独立する。
/* @app-function app-tree.js:sidebarGroup */
// 掃除や会話量は話題画面と一覧画面で扱う。
/* @app-function app-tree.js:freetalkFrame */
/* @app-function app-tree.js:renderTree */

// ---- 全体 ----
/* @app-function app-tree.js:updateTurnCounts */
function render() {
  window.HubConversationSearch?.beforeRender();
  if(typeof invalidateMainNavigation==='function')invalidateMainNavigation();
  drawShellAlerts();
  if (view.kind !== 'settings') { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  const waiting = state.projects.flatMap(p => p.tasks.filter(t => notificationKind(p, t)).map(t => ({ p, t })));
  updateTurnCounts();
  showVersion(state.version, state.latest);
  $('#turn').setAttribute('aria-pressed', view.kind === 'turn');
  $('#gear').setAttribute('aria-pressed', view.kind === 'settings');
  renderTree();
  if (view.kind !== 'work') closePanes();
  if (view.kind === 'search' && window.HubConversationSearch) window.HubConversationSearch.mount();
  else if (view.kind === 'settings') renderSettings();
  else if (view.kind === 'newproject') renderNewProject();
  else if (!state.projects.length) renderEmpty();
  else if (view.kind === 'turn') renderTurn(waiting);
  else if (view.kind === 'work') renderWork();
  else renderOverview(proj(view.project));
  window.HubConversationSearch?.afterRender();
  renderedMainKey = mainKey();
  window.HubMobile?.badges();
  window.HubOnboarding?.sync();
  if (typeof usageContextChanged === 'function') usageContextChanged();
}

// 分岐・子の名前：元の名前のまま、後ろに空いている番号（「台湾市場 2」「台湾市場 3」…）
/* @app-function app-project.js:nextName */
/* @app-function app-project.js:renderEmpty */

let turnTab = 'reply'; // reply＝返事待ち ／ work＝作業中 ／ results＝成果確認 ／ done＝完了報告
/* @app-function app-project.js:renderTurn */
// 子プロジェクトに分ける：1行に1つ「名前｜やること」。名前が無ければ元の名前＋番号。それぞれ作って、最初の作業をすぐ AI に頼む
/* @app-function app-project.js:splitProject */
// 作業画面の質問に答える：答えを、この作業の AI に指示として送る（送ると質問は済んだことになる）
document.addEventListener('submit', /* @app-callback app-work.js:appWorkCallback676 */appWorkCallback676());
// 子が途中のまま親で作業を始めようとした時の知らせ
/* @app-function app-project.js:warnChildren */
// AI へ送らず、返事待ちの表示だけをまとめて消す
document.addEventListener('click', /* @app-callback app-work.js:appWorkCallback693 */appWorkCallback693());
document.addEventListener('click', /* @app-callback app-work.js:appWorkCallback702 */appWorkCallback702());

// ---- 新しいプロジェクト ----
let newRefs = [];
let newProjectPreset = null;
/* @app-function app-project.js:drawRefs */
/* @app-function app-project.js:addNewRefs */
/* @app-function app-project.js:renderNewProject */

// ---- 概要画面（プロジェクトの説明と作業の一覧） ----
/* @app-function app-project.js:projectFamily */
/* @app-function app-project.js:sourceTask */
// compact：一覧の行では1行に詰める（派生は件数だけ）。作業画面では全部の名前と状態を出す
/* @app-function app-project.js:taskContext */
/* @app-function app-project.js:sourceOptions */
// tab：あなたの番のタブ（reply＝［送らずに消す］／work＝開く／done＝完了の操作）
/* @app-function app-project.js:taskRow */
// 一覧の完了確認は操作欄のボタンだけ。作業画面の確認帯はcompletionButtonsに残す。
/* @app-function app-project.js:pendingBar */
/* @app-function app-project.js:completionButtons */

/* @app-function app-project.js:phaseRoad */

// プロジェクトごとの下書き。画像本体はMac内、ここには参照番号だけを残す。
const quickDrafts = new Map(), quickUploading = new Set(), quickStarting = new Set();
const quickOverrides = new Set(); // 手動指定は、その依頼が受け付けられるまで保持する。
/* @app-function app-project.js:syncSpecialModeChange */
const isQuickImage = f => /\.(png|jpe?g|webp|gif|heic)$/i.test(typeof f === 'string' ? f : f.name || '') || /^image\/(png|jpeg|webp|gif|heic)$/i.test(f.type || '');
/* @app-function app-project.js:quickDraft */
/* @app-function app-project.js:keepQuick */
/* @app-function app-project.js:quickOwners */
/* @app-function app-project.js:quickControls */
/* @app-function app-project.js:drawQuick */
/* @app-function app-project.js:addQuickImages */
document.addEventListener('input', /* @app-callback app-project.js:appProjectCallback891 */appProjectCallback891());
document.addEventListener('click', /* @app-callback app-project.js:appProjectCallback895 */appProjectCallback895());

// Polling carries only metadata; full notes are fetched when this detail is opened.
const projectNotesCache=new Map(),projectNotesLoading=new Map();
/* @app-function app-project.js:projectNotesText */
/* @app-function app-project.js:loadProjectNotes */
const refsOf = p => p.folders.filter(f => /^参考/.test(f.label));
/* @app-function app-project.js:renderOverview */

// 保存された要約と未整理の原文を区別する。ここでは意味や状態を推測しない。
/* @app-function app-project.js:issuesHtml */

// 「ファイルを見る」：場所が1つならすぐ開く。複数なら選ぶ
/* @app-function app-project.js:openFiles */

// ---- 作業画面 ----
let sendWorkAnswer = null;
/* @app-function app-work.js:workQuestionHtml */
// 会話や入力欄を作り直さず、質問の変更だけを反映する。
/* @app-function app-work.js:syncWorkQuestion */
/* @app-function app-work.js:updateWorkAnswerControls */
/* @app-function app-work.js:acceptedWorkAnswer */

// UI-only state, scoped to a task. No task data or delivery record is changed.
const workFolds = new Map();
/* @app-function app-work.js:workFoldAttr */
/* @app-function app-work.js:rememberWorkFold */
/* @app-function app-work.js:rememberDisclosure */
/* @app-function app-work.js:dismissDisclosures */
let disclosurePress=null;
document.addEventListener('pointerdown',/* @app-callback app-work.js:appWorkCallback1122 */appWorkCallback1122(),true);
document.addEventListener('pointermove',/* @app-callback app-work.js:appWorkCallback1123 */appWorkCallback1123(),true);
document.addEventListener('pointercancel',/* @app-callback app-work.js:appWorkCallback1126 */appWorkCallback1126(),true);
document.addEventListener('click',/* @app-callback app-work.js:appWorkCallback1127 */appWorkCallback1127(),true);
/* @app-function app-work.js:captureWorkUi */
/* @app-function app-work.js:restoreWorkUi */
/* @app-function app-work.js:syncWorkAttention */
/* @app-function app-work.js:syncChatHandoff */
/* @app-function app-work.js:chatHandoffHtml */
document.addEventListener('click',/* @app-callback app-work.js:appWorkCallback1169 */appWorkCallback1169());
// Keep one open task's details, keyed by the semantic steps version. Never
// replace the conversation/composer just because step details finish loading.
let openTaskSteps = null;
const stepLoads = new Map();
/* @app-function app-work.js:fullSteps */
/* @app-function app-work.js:stepLabels */
/* @app-function app-work.js:syncTaskSteps */
/* @app-function app-work.js:renderWork */

// ---- 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選ぶ ----
let chatES = null, chatDraft = {}, chatBusy = null, chatScroller = null;
const chatDraftRevisions = new Map();
/* @app-function app-composer.js:setChatDraft */
let historyStorage;
try { historyStorage = localStorage; } catch (_) { /* 保存不可でも履歴は使える */ }
const instructionHistory = window.HubChatHistory.create(historyStorage);
const chatAttachments = new Map();
let chatFileSequence = 0;
const chatImageUploads = new Map();
const FREETALK_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.heic,.txt,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.log,.rtf,.pdf,.pptx,.key';
const chatSending = new Set();
const chatAttachmentKey = (project, task) => JSON.stringify([project, task]);
/* @app-function app-composer.js:chatImages */
/* @app-function app-composer.js:attachmentImagesHtml */
/* @app-function app-composer.js:chatImagesHtml */
/* @app-function app-composer.js:drawChatImages */
/* @app-function app-composer.js:addChatImage */
/* @app-function app-composer.js:attachmentGeneration */
/* @app-function app-composer.js:syncFreetalkAttachmentControls */
/* @app-function app-composer.js:addFreetalkAttachment */
/* @app-function app-composer.js:removeChatImage */
/* @app-function app-composer.js:chatSendText */
/* @app-function app-composer.js:clearSentChatImages */
const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width:720px)').matches;
// 表示用の文字だけを短縮する。選択値やCLIに渡すモデル名には使わない。
/* @app-function app-composer.js:shortModelLabel */
/* @app-function app-composer.js:phoneModelLabel */
/* @app-function app-composer.js:chatModelOption */
/* @app-function app-composer.js:syncChatPhoneLabels */
/* @app-function app-composer.js:workMode */
/* @app-function app-composer.js:setMode */
const EMPTY_CHAT = UI.html('<p class="chat-empty">ここで AI と話します。<br>下で答える AI とモデルを選び、依頼を書いて送ってください（⌘ + Enter でも送れます）。<br>途中で AI を変えると、それまでの会話を自動で引き継ぎます。ファイルやスクショは、［＋］で選ぶか、ここに落とす／⌘V で貼れます。</p>');
// 選ぶ欄に出すモデル（設定で隠したものは出さない。ただし今選んでいるものは残す）
/* @app-function app-composer.js:orderedModels */
/* @app-function app-composer.js:shownModels */
/* @app-function app-composer.js:roleModelOptions */
/* @app-function app-composer.js:chatSelection */
let discussionUIInstance;
/* @app-function app-composer.js:discussionUI */
/* @app-function app-composer.js:bindDiscussion */
/* @app-function app-composer.js:chatModelChoices */
/* @app-function app-composer.js:syncChatModelChoices */
/* @app-function app-composer.js:chatHtml */
// 最初に選んでおく AI：前回選んだもの → 作業の担当と役割の設定
/* @app-function app-composer.js:chatPick */
/* @app-function app-composer.js:syncSpecialPick */
// 文の中の URL とファイルの場所を押せるようにする（URL＝ブラウザで開く・コピー、場所＝開き方を選ぶ）
// [名前](行先) は [ だけを拾い、続きは markdownLinks で確かめる（[ ごとに長い行を読み直さない）。
const LINK_RE = /\[|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+)|`([^`\n]+)`|((?:~\/|\/(?:Users|Volumes|private|tmp|opt|home)\/)[^\s<>"'`()（）「」『』【】\[\]、。，]+)|((?<![\p{L}\p{N}_\/.:@-])(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_@-]+\.[A-Za-z0-9]{1,6})(?![\p{L}\p{N}_\/])/gu;
const urlLink = (u, label) => UI.template`<a href="#" class="lk" data-url="${esc(u)}" title="ブラウザで開く">${esc(label || u)}</a><button type="button" class="cp" data-copy="${esc(u)}" title="コピー" aria-label="コピー">⧉</button>`;
const pathLink = (x, label) => UI.template`<a href="#" class="lk lp" data-path="${esc(x)}" title="ファイル・フォルダの開き方を選ぶ">${esc(label || x)}</a>`;
// Local image links use Hub's authenticated viewer on both Mac and phones.
const imagePathLink = (p, label) => UI.template`<a href="#" class="chat-image" data-path="${esc(p)}" title="${UI.text('画像を見る')}"><img src="${esc(fileViewUrl(p))}" alt="${esc(label || p.split('/').pop())}" loading="lazy"><span>${esc(label || p.split('/').pop())}</span></a>`;
// URL の終わりの句読点や、対になっていない ) ] は URL に含めない
/* @app-function app-messages.js:trimUrl */
const isPath = x => /^(~\/|\/)/.test(x) || (/\//.test(x) && !/\s{2,}/.test(x) && !/^[\/.]$/.test(x));
/* @app-function app-messages.js:markdownLinks */
/* @app-function app-messages.js:linkify */
// 囲みの中はリンクにせず、そのままコピーできる形にする。
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};

/* @app-function app-messages.js:richText */
document.addEventListener('click', /* @app-callback app-messages.js:appMessagesCallback1642 */appMessagesCallback1642());
// コピーできたかを返す（できなかった時に「コピーしました」と言わない）
/* @app-function app-messages.js:copyText */
document.addEventListener('click', /* @app-callback app-files.js:appFilesCallback1658 */appFilesCallback1658());
// 場所を押した時は開き方を選ぶ。元ファイルを開く・Finderで表示・フォルダの中身を見る。
const IN_APP = /ProjectHubApp/.test(navigator.userAgent);
const fsize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
let fileViewer = null;
const localResourceUrl = url => globalThis.HubLocalAuth?.url(url) || url;
const fileViewUrl = p => localResourceUrl('/api/file/view?project=' + encodeURIComponent(view.project || '') + '&task=' + encodeURIComponent(view.task || '') + '&path=' + encodeURIComponent(p));
/* @app-function app-files.js:finishFileViewer */
/* @app-function app-files.js:closeFileViewer */
/* @app-function app-files.js:prepareFileViewerFrame */
/* @app-function app-files.js:prepareFileViewerControls */
/* @app-function app-files.js:showFileViewer */
window.addEventListener?.('popstate', () => {
  if (fileViewer && history.state?.fviewer !== fileViewer.id) finishFileViewer();
  if (!fileViewer && history.state?.fviewer) { const { fviewer, ...state } = history.state; history.replaceState(state, ''); }
});
// sandbox文書や端末のPDF表示からキーイベントは親へ届かない。
// 本文へのクリック・タッチは通し、キーボードの操作先は閉じるボタンへ戻す。
window.addEventListener?.('blur', () => {
  const current = fileViewer;
  if (!current || document.activeElement?.className !== 'fv-frame') return;
  const refocus = () => {
    if (fileViewer === current) {
      window.focus();
      const button = current.el.querySelector('[data-fv-close]');
      button.blur(); button.focus({ preventScroll: true });
    }
  };
  refocus();
  clearTimeout(current.focusTimer);
  current.focusTimer = setTimeout(() => { refocus(); current.focusTimer = null; }, 0);
});
const fileViewerEscape = e => {
  if (fileViewer && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeFileViewer(); }
};
document.addEventListener('keydown', fileViewerEscape);
document.addEventListener('keyup', fileViewerEscape);
/* @app-function app-files.js:openPath */
/* @app-function app-files.js:showPath */
document.addEventListener('click', /* @app-callback app-files.js:appFilesCallback1845 */appFilesCallback1845());
// コマンドなどの細かい作業を会話に出すか（設定画面で変える。最初は出さない）
const showDetail = () => { try { return localStorage.getItem('hub-detail') === '1'; } catch (e) { return false; } };
// Enter だけで送るか（設定。最初は ⌘ + Enter）。Shift + Enter はいつも改行
const enterSends = () => { try { return localStorage.getItem('hub-enter') === '1'; } catch (e) { return false; } };
const isSendKey = e => e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (enterSends() && !e.shiftKey && !e.altKey));
const isToolRow = r => r.tool || !/やり直/.test(r.text || ''); // 前の記録には印が無いため、やり直しの知らせ以外は細かい作業とみなす
// 保存済みの旧要約は原文を変更せず、続きと判断待ちの区画を表示の先頭へ。
/* @app-function app-messages.js:continuationSummary */
/* @app-function app-messages.js:msgHtml */
/* @app-function app-messages.js:automaticRequest */
/* @app-function app-messages.js:requestBodyHtml */
/* @app-function app-messages.js:baseMsgHtml */
// 質問ごとに選択と自由入力を保持し、最後にまとめて送る。
const askDrafts = new Map();
const askPending = new Set();
// 起動前の user/error 行でも、受付に失敗した質問は再送できるようにする。
// 作業・原文・回答欄を限定し、新質問や受付済みの欄には引き継がない。
const askAttempts = new Map();
const cleanOpt = o => o.replace(/[（(]おすすめ[）)]/g, '').trim();
/* @app-function app-messages.js:drawPendingQuestion */
/* @app-function app-messages.js:askHtml */
/* @app-function app-messages.js:askValues */
/* @app-function app-messages.js:askAnswer */
/* @app-function app-messages.js:updateAskControls */
/* @app-function app-messages.js:bindAskAnswers */
// 答えられるのは最後の返事の質問だけ。過去の回答欄は読み取り専用。
/* @app-function app-messages.js:refreshAsks */
// かかった時間：「45秒」「1分20秒」
/* @app-function app-messages.js:dur */
let busyTimer = null;
const queueDrafts = new Map();
/* @app-function app-chat.js:refreshRequestStatus */
/* @app-function app-chat.js:chatHistoryPending */
/* @app-function app-chat.js:openChat */

// 取り込み案内は task-history が所有する。ここでは既存の反映証拠だけを更新する。
let mainPreviewRequest = 0;
/* @app-function app-project.js:loadPreview */

// live=true：動いている AI の見出しに置く。変えるとその AI に切り替えを伝える
/* @app-function app-terminal.js:specSelect */

// 端末の部品（xterm.js・290KB）は、ターミナル画面を初めて開く時だけ読み込む（会話画面しか使わない時は読まない）
let xtermLoading = null;
/* @app-function app-terminal.js:loadXterm */
/* @app-function app-terminal.js:attach */
document.addEventListener('hub-theme-change', /* @app-callback app-terminal.js:appTerminalCallback2461 */appTerminalCallback2461());
/* @app-function app-terminal.js:closePanes */

/* @app-function app-terminal.js:startAI */

// DOMを書き換える直前の位置を保つ。通信待ちの間に人がスクロールした位置も尊重する。
/* @app-function app-settings.js:preserveSettingsScroll */
// 設定内の局所更新と全体再描画のどちらでも、開閉・編集中の値・フォーカスを保つ。
const aiSettingsOpen = new Set(), aiSettingsInputs = new Map();
let aiSettingsDrawing = false;
/* @app-function app-settings.js:aiSettingsInputKey */
/* @app-function app-settings.js:preserveAiSettings */
// ---- 設定（役割・モデル・思考） ----
let skillsResult = null, skillsError = '', skillsLoadingBox = null;
/* @app-function app-settings-ai.js:skillsHtml */
/* @app-function app-settings-ai.js:drawSkills */
/* @app-function app-settings-ai.js:loadSkills */
let aiTools = null, aiToolsOperation = null, aiToolsError = '', aiToolsLoadingBox = null, aiToolsWatchTimer = null;
let aiToolsBusyCount = 0, aiBatchPending = false, aiBatchMessage = '';
const aiCheckPending = { claude: false, codex: false, agy: false, grok: false };
const aiToolPending = { claude: false, codex: false, agy: false, grok: false };
const aiToolMessage = { claude: '', codex: '', agy: '', grok: '' };
const aiToolMethod = method => ({ standalone: UI.text('単独インストール'), 'homebrew-cask': 'Homebrew', native: UI.text('公式インストール'), missing: UI.text('未導入'), unknown: UI.text('確認できません') }[method] || method || UI.text('不明'));
const aiToolErrorText = e => [e.message, e.reason && e.reason !== e.message ? e.reason : '', e.stage ? UI.template`段階：${e.stage}` : ''].filter(Boolean).join('。');
/* @app-function app-settings-ai.js:drawAiTools */
/* @app-function app-settings-ai.js:scheduleAiToolsWatch */
/* @app-function app-settings-ai.js:loadAiTools */
/* @app-function app-settings-ai.js:refreshRoleModelChoices */
/* @app-function app-settings-ai.js:refreshAiToolCatalog */
/* @app-function app-settings-ai.js:aiToolResultText */
/* @app-function app-settings-ai.js:runAiTool */
/* @app-function app-settings-ai.js:runAiUpdateAll */
document.addEventListener('click', /* @app-callback app-settings-ai.js:appSettingsAiCallback2703 */appSettingsAiCallback2703());
// モデル一覧の並べ替え。役割や会話の選択値には触れない。
let modelViewSaving = false, modelOrderDrag = '', modelOrderNotice = '';
/* @app-function app-settings-ai.js:modelOrderHtml */
/* @app-function app-settings-ai.js:drawModelOrder */
/* @app-function app-settings-ai.js:syncRoleModelOrder */
/* @app-function app-settings-ai.js:saveModelOrder */
/* @app-function app-settings-ai.js:toggleModelVisibility */
document.addEventListener('click', /* @app-callback app-settings-ai.js:appSettingsAiCallback2779 */appSettingsAiCallback2779());
document.addEventListener('dragstart', /* @app-callback app-settings-ai.js:appSettingsAiCallback2790 */appSettingsAiCallback2790());
/* @app-function app-settings-ai.js:clearModelDrop */
document.addEventListener('dragover', /* @app-callback app-settings-ai.js:appSettingsAiCallback2797 */appSettingsAiCallback2797(), true);
document.addEventListener('drop', /* @app-callback app-settings-ai.js:appSettingsAiCallback2803 */appSettingsAiCallback2803(), true);
document.addEventListener('dragend', /* @app-callback app-settings-ai.js:appSettingsAiCallback2812 */appSettingsAiCallback2812());
let specialModeSaving = false;
/* @app-function app-settings-ai.js:specialModeHtml */
/* @app-function app-settings-ai.js:drawSpecialMode */
/* @app-function app-settings-ai.js:saveSpecialMode */
document.addEventListener('change', /* @app-callback app-settings-ai.js:appSettingsAiCallback2829 */appSettingsAiCallback2829());
let initialPickSaving = false;
/* @app-function app-settings-ai.js:initialPickHtml */
/* @app-function app-settings-ai.js:drawInitialPick */
/* @app-function app-settings-ai.js:saveInitialPick */
document.addEventListener('click', /* @app-callback app-settings-ai.js:appSettingsAiCallback2868 */appSettingsAiCallback2868());
let phoneLabelsSaving = false, phoneLabelsNotice = '', renderedPhoneKey = '';
const phoneLabelDrafts = new Map(), phoneLabelQueue = [], phoneLabelErrors = new Map();
let phoneLabelActive = null;
/* @app-function app-settings-ai.js:phoneLabelStatus */
/* @app-function app-settings-ai.js:phoneLabelMode */
/* @app-function app-settings-ai.js:phoneLabelKeys */
const phoneSettingsKey = () => JSON.stringify([state.phoneLabels, phoneLabelKeys()]);
/* @app-function app-settings-ai.js:phoneLabelsHtml */
/* @app-function app-settings-ai.js:drawPhoneLabels */
/* @app-function app-settings-ai.js:savePhoneLabels */
document.addEventListener('input', /* @app-callback app-settings-ai.js:appSettingsAiCallback2942 */appSettingsAiCallback2942());
document.addEventListener('change', /* @app-callback app-settings-ai.js:appSettingsAiCallback2945 */appSettingsAiCallback2945());
// AIアカウント：選択は台帳で共有し、送信時にも明示して待ち順へ固定する。
let accountSelectionSaving = 0, accountOperation = false;
const accountSelectionsPending = new Set();
let accountStatusRows = null;
let accountCheckedAt = '', accountCheckPromise = null, accountAutoChecked = false, accountCheckError = '';
/* @app-function app-settings-ai.js:roleAiAvailability */
/* @app-function app-settings-ai.js:roleAiOptions */
/* @app-function app-settings-ai.js:syncRoleAccountChoices */
/* @app-function app-settings-ai.js:checkRoleAccounts */
/* @app-function app-settings-ai.js:autoCheckRoleAccounts */
/* @app-function app-settings-ai.js:accountOptions */
/* @app-function app-settings-ai.js:taskAccountSelect */
const taskFastPending = new Set();
let taskFastSaving = 0;
/* @app-function app-settings-ai.js:taskFastSelect */
/* @app-function app-settings-ai.js:syncTaskFastPickers */
/* @app-function app-settings-ai.js:saveTaskFast */
/* @app-function app-settings-ai.js:drawChatAccount */
/* @app-function app-settings-ai.js:syncAccountPickers */
/* @app-function app-settings-ai.js:saveTaskAccount */
let shellRebuilding = false, shellRestartNeeded = false;
/* @app-function app-settings-ai.js:shellWarningHtml */
/* @app-function app-settings-ai.js:drawShellAlerts */
document.addEventListener('click', /* @app-callback app-settings-ai.js:appSettingsAiCallback3109 */appSettingsAiCallback3109());
let webchatUIInstance;
/* @app-function app-settings-ai.js:webchatUI */
/* @app-function app-settings-ai.js:webchatReady */
/* @app-function app-settings-ai.js:webchatNoticeHtml */
/* @app-function app-settings-ai.js:webchatProgress */
/* @app-function app-settings-ai.js:syncChatWebchatAvailability */
/* @app-function app-settings-ai.js:syncWebchatSettingsControls */
/* @app-function app-settings-ai.js:drawWebchatSettings */
/* @app-function app-settings-ai.js:loadWebchat */
/* @app-function app-settings-ai.js:webchatUIPending */
webchatUI(); // Register private handlers at the same point as the original settings handlers.
document.addEventListener('toggle',/* @app-callback app-settings-ai.js:appSettingsAiCallback3135 */appSettingsAiCallback3135(),true);

let chatgptLoadEpoch = 0;
let chatgptWorkPending = null;
let agyModelsRefreshing = false;
/* @app-function app-settings-ai.js:agyModelsHtml */
document.addEventListener('click',/* @app-callback app-settings-ai.js:appSettingsAiCallback3145 */appSettingsAiCallback3145());
/* @app-function app-settings-ai.js:accountSettingsHtml */
/* @app-function app-settings-ai.js:drawAccountSettings */
/* @app-function app-settings-ai.js:operateAccount */

const SETTINGS_TABS = { basic: UI.text('基本'), ai: 'AI', connect: UI.text('つなぐ'), recovery: UI.text('復旧'), manage: UI.text('管理') };
/* @app-function app-settings.js:stopResultText */
/* @app-function app-settings.js:drawEmergencyStatus */
/* @app-function app-settings.js:refreshEmergencyStatus */
let museSettingsEpoch = 0;
let museUsageBusy = false;
/* @app-function app-settings.js:museSettingsHtml */
/* @app-function app-settings.js:loadMuseSettings */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsMuseCallback */appSettingsMuseCallback());
document.addEventListener('click',/* @app-callback app-settings.js:appSettingsCallback3230 */appSettingsCallback3230());
setInterval(/* @app-callback app-settings.js:appSettingsCallback3248 */appSettingsCallback3248(),3000);
let settingsTab = localStorage.getItem('hub.settingsTab') || 'basic';
/* @app-function app-settings.js:selectSettingsTab */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsCallback3264 */appSettingsCallback3264());
document.addEventListener('keydown', /* @app-callback app-settings.js:appSettingsCallback3268 */appSettingsCallback3268());
/* @app-function app-settings.js:licensePurchaseHtml */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsCallback3289 */appSettingsCallback3289());
document.addEventListener('submit', /* @app-callback app-settings.js:appSettingsCallback3299 */appSettingsCallback3299());
/* @app-function app-settings.js:rolesSaveStatus */
/* @app-function app-settings.js:creditSettingsHtml */
/* @app-function app-settings.js:renderSettings */
let moveSettingsTimer;
/* @app-function app-settings.js:moveSettingsHtml */
/* @app-function app-settings.js:loadMoveSettings */
let languageSettings = null, languageNotice = '', languageBusy = false, languageDraft = null, languageLoadEpoch = 0;
/* @app-function app-settings.js:languageSettingsHtml */
/* @app-function app-settings.js:drawLanguageSettings */
/* @app-function app-settings.js:loadLanguageSettings */
document.addEventListener('change', /* @app-callback app-settings.js:appSettingsCallback3550 */appSettingsCallback3550());
/* @app-function app-settings.js:applyLanguageRestart */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsCallback3563 */appSettingsCallback3563());
// ChatGPT：実作業（ファイルの書き換え・コマンド）を許すか
// 説明のコピー用。Hubから起動・認証・外部通信は実行しない。
const CHATGPT_TUNNEL_START = String.raw`/bin/zsh -f -c 'if ! read -rs "PROJECT_HUB_TUNNEL_API_KEY?中継用の鍵を貼り付けて Enter: "; then printf "\n"; exit 1; fi; printf "\n"; [[ -n "$PROJECT_HUB_TUNNEL_API_KEY" ]] || exit 1; export PROJECT_HUB_TUNNEL_API_KEY; "$HOME/.local/bin/tunnel-client" doctor --profile hub --explain && "$HOME/.local/bin/tunnel-client" run --profile hub'`;
const CHATGPT_TUNNEL_CHECK = String.raw`/bin/zsh -f -c '
hub_pid=$(pgrep -f "(^|/)tunnel-client run --profile hub([[:space:]]|$)" 2>/dev/null | head -n 1)
if [[ -z "$hub_pid" ]]; then
  printf "中継は停止中です。\n"
  exit 1
fi
hub_port=$(lsof -nP -a -p "$hub_pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n "s/^n127[.]0[.]0[.]1://p" | head -n 1)
if [[ -z "$hub_port" ]]; then
  printf "中継は動作中ですが、確認用の入口が見つかりません。\n"
  exit 1
fi
hub_ready=$(curl --noproxy "*" --max-time 3 --silent --output /dev/null --write-out "%{http_code}" "http://127.0.0.1:$hub_port/readyz")
if [[ "$hub_ready" == "200" ]]; then
  printf "中継は準備完了（ready）です。ChatGPTからの確認も行ってください。\n"
else
  printf "中継は動作中ですが、まだ準備完了を確認できません（HTTP %s）。\n" "$hub_ready"
fi
printf "詳しい状態：http://127.0.0.1:%s/ui\n" "$hub_port"
'`;
/* @app-function app-settings.js:chatgptConnectionHelpHtml */
const SEND_TEXT_RULE = UI.text('人が他のAI・アプリ・会話へ送る文は、本文だけを独立した ```text 枠に入れ、送り先と「枠内を全部コピーして送る」は枠外に書く。引用記号・説明を枠に入れず、送り先・送信ごとに枠を分ける。');
/* @app-function app-settings.js:gptChildLink */
/* @app-function app-settings.js:loadChatgpt */
document.addEventListener('change', /* @app-callback app-settings.js:appSettingsCallback3655 */appSettingsCallback3655());
// 外から使う（iPhone）：設定を読み込んで出す・変える
/* @app-function app-settings.js:loadRemote */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsCallback3679 */appSettingsCallback3679());
document.addEventListener('change', /* @app-callback app-settings.js:appSettingsCallback3691 */appSettingsCallback3691());
// CLI に渡すモデル名：読み込んで表にする・保存する
let cliModelsLoadSeq = 0;
let accelerationRevision = 0, accelerationSaving = false;
/* @app-function app-settings.js:renderAcceleration */
/* @app-function app-settings.js:saveCodexFast */
document.addEventListener('change', /* @app-callback app-settings.js:appSettingsCallback3727 */appSettingsCallback3727());
/* @app-function app-settings.js:loadCliModels */
document.addEventListener('click', /* @app-callback app-settings.js:appSettingsCallback3754 */appSettingsCallback3754());
// 全画面の保持状態からHub/CLIの更新表示をまとめる。表示のためにCLIを実行しない。
/* @app-function app-settings.js:updateLabel */
/* @app-function app-settings.js:showVersion */
/* @app-function app-settings.js:restartControls */
document.addEventListener('click',/* @app-callback app-settings.js:appSettingsCallback3782 */appSettingsCallback3782());
/* @app-function app-settings.js:hubUpdateButton */
/* @app-function app-settings.js:updateBlocked */
/* @app-function app-settings.js:switchHubUpdate */
/* @app-function app-settings.js:openUpdate */
let verOpen = false;
/* @app-function app-settings.js:loadChangelog */
// 新しい版にする：本体を起動し直し、戻ってきたら画面を読み直す
/* @app-function app-settings.js:restartHub */
const ACTION = { gptchat: UI.text('GPT子への依頼を保存した'), dot: UI.text('Dotへの依頼を保存した'), githubcreate: UI.text('GitHubの非公開リポジトリ作成を実行した'), githubconnect: UI.text('既存GitHubへの接続を実行した'), emptytrash: UI.text('空の作業を片付けた'), chatredo: UI.text('取り消してやり直した'), chatamend: UI.text('追加説明を送った'), chatqueue: UI.text('順番待ちにした'), chatqueueedit: UI.text('待ち指示を編集した'), climodels: UI.text('モデル名を直した'), refs: UI.text('参考を足した'), restart: UI.text('新しい版にした'), chat: UI.text('会話で頼んだ'), newproject: UI.text('プロジェクトを作った'), start: UI.text('始めた'), stop: UI.text('止めた'), handoff: UI.text('交代した'), upload: UI.text('ファイルを渡した'), switch: UI.text('モデル・思考を変えた'), merge: UI.text('本体に取り込んだ'), mergeexclude: UI.text('取り込み対象から外した'), mergeinclude: UI.text('取り込み対象に戻した'), nextphase: UI.text('次のフェーズへ'), projectdone: UI.text('プロジェクトを完了にした'), projectreopen: UI.text('プロジェクトの完了を取り消した'), newtask: UI.text('作業を足した'), chatgpt: UI.text('ChatGPT が道具を使った'), chatgptwork: UI.text('ChatGPT の実作業の設定を変えた') };
/* @app-function app-settings.js:loadLog */
/* @app-function app-settings.js:saveRoles */

// 空の作業を片付ける：探した結果（画面を描き直しても残す）
let emptyFound = null;
/* @app-function app-settings.js:emptyHtml */
// Shared by normal navigation and validated search destinations.
function navigateView(destination, fromSidebar = false) {
  view = { ...destination };
  if (fromSidebar) closeDrawer();
  if (view.kind === 'work' && view.task) markRead(view.project, view.task);
  showInTree(); save(); render();
}

// ---- 操作 ----
/* @app-function app-actions.js:act */

document.addEventListener('click', e => {
  const button = e.target.closest('[data-theme-choice]');
  if (!button) return;
  const saved = window.HubTheme.set(button.dataset.themeChoice);
  toast(saved ? UI.text('配色を保存しました') : UI.text('配色を変更しましたが、保存できませんでした。次回は以前の配色に戻ります。'));
});

document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-tree-menu]') && !e.target.closest('[data-act="files"]')) $('#menu').hidden = true;
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const id = tg.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); save(); renderTree(); if(tg.dataset.sidebarGroup)$('#sidebar-'+tg.dataset.sidebarGroup+'-toggle')?.focus({preventScroll:true}); e.stopPropagation(); return; }
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'newproject') newProjectPreset = null;
    navigateView({ kind: go.dataset.go, project: go.dataset.p || view.project, task: go.dataset.t || null }, !!go.closest('#list')); return;
  }
  const progressButton=e.target.closest?.('[data-progress-toggle]'), progressHost=progressButton?.closest('[data-work-progress]');
  if(progressHost&&view.kind==='work'&&progressHost.dataset.p===view.project&&progressHost.dataset.t===view.task){
    const key=JSON.stringify([view.project,view.task]);
    if(!workFolds.has(key))workFolds.set(key,new Map());
    workFolds.get(key).set('progress',progressButton.dataset.progressToggle==='open');
    syncWorkProgress();
    progressHost.querySelector('button')?.focus({preventScroll:true});
    return;
  }
  if (e.target.id === 'set-work-progress') {
    try { localStorage.setItem('hub-work-progress', e.target.checked ? '1' : '0'); }
    catch { e.target.checked=showWorkProgress(); toast(UI.text('表示設定を保存できませんでした。')); return; }
    if(e.target.checked)for(const folds of workFolds.values())folds.delete('progress');
    syncWorkProgress(); return;
  }
  if (e.target.id === 'set-enter') { try { localStorage.setItem('hub-enter', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? UI.text('Enter だけで送ります') : UI.text('⌘ + Enter で送ります')); return; }
  if (e.target.id === 'set-detail') { try { localStorage.setItem('hub-detail', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? UI.text('細かい作業を出します') : UI.text('細かい作業を隠します')); return; }
  if (e.target.id === 'models-tidy') {
    if (rolesDirty() && !confirm(UI.text('役割分担とクレジット設定の保存していない変更は消えます。整理しますか？'))) return;
    api('/api/models/tidy', {expectedRevision:state.roles.management?.revision}).then(async r => {
      clearRolesDraft(); await load();
      const box = $('#tidy-result');
      const msg = r.changes.length ? UI.template`整理しました（${r.changes.length} か所）：` + r.changes.map(c => UI.template`${c.role}の${c.slot} ${c.from} → ${c.to}`).join('、') : UI.text('整理しました。役割はもう最新のモデルを使っています');
      if (box) box.textContent = msg; toast(r.changes.length ? UI.template`${r.changes.length} か所を最新のモデルにしました` : UI.text('役割はもう最新です'));
    }).catch(err => toast(err.message));
    return;
  }
  if (e.target.dataset && e.target.dataset.mv !== undefined) { toggleModelVisibility(e.target); return; }
  if (e.target.id === 'roles-save' || e.target.closest?.('[data-roles-save]')) { saveRoles(); return; }
  if (e.target.id === 'roles-reset' || e.target.closest?.('[data-roles-reset]')) { clearRolesDraft(); render(); return; }
  const b = e.target.closest('[data-act]');
  if (b && b.tagName !== 'SELECT') act(b);
});
let stepsOpen = false;
document.addEventListener('toggle', e => {
  if (e.target.classList && e.target.classList.contains('project-notes') && e.target.isConnected !== false) {
    const id = e.target.dataset.p;
    if (e.target.open) {projectNotesOpen.add(id);void loadProjectNotes(id);} else projectNotesOpen.delete(id);
  }
  if (e.target.classList && e.target.classList.contains('steps')) { stepsOpen = e.target.open; if(e.target.open)syncTaskSteps(); }
  if (e.target.matches?.('details[data-work-fold="management"]')&&e.target.open)syncTaskSteps();
  if (e.target.id === 'logd' && e.target.open) loadLog();
  if (e.target.id === 'verd') { verOpen = e.target.open; if (verOpen) loadChangelog(); }
}, true);
document.addEventListener('change', async e => {
  if (e.target.hasAttribute?.('data-task-account')) { await saveTaskAccount(e.target); return; }
  const f = e.target.closest && e.target.closest('#quickform');
  if (f) {
    const p = proj(f.dataset.p), d = quickDraft(p);
    if (e.target.id === 'quick-files') { await addQuickImages(p, [...e.target.files]); return; }
    if (['quick-ai', 'quick-model', 'quick-effort'].includes(e.target.id)) quickOverrides.add(p.id);
    if (e.target.id === 'quick-ai') { d.ai = e.target.value; d.model = ''; d.effort = d.ai === 'agy' ? '高' : ''; }
    if (e.target.id === 'quick-model') d.model = e.target.value;
    if (e.target.id === 'quick-effort') d.effort = e.target.value;
    keepQuick(p.id); drawQuick(p); return;
  }

  const s = e.target;
  if (s.dataset.initial) {
    if (initialPickSaving) { drawInitialPick(); return; }
    const next = { ...initialPick(), [s.dataset.initial]: s.value };
    if (s.dataset.initial === 'ai') {
      next.model = shownModels(AI_KEY[next.ai])[0] || '';
      if (!state.efforts.includes(next.effort)) next.effort = '高';
    }
    await saveInitialPick(next); return;
  }
  if (['claude', 'codex'].includes(s.dataset.checkCredits) && checkCreditsDraft) {
    checkCreditsDraft[s.dataset.checkCredits] = s.checked;
    render(); return;
  }
  if (s.dataset.preferCredits !== undefined && preferCreditsDraft !== null) {
    preferCreditsDraft = s.checked; render(); return;
  }
  if (s.dataset.r !== undefined && rolesDraft) {
    const r = rolesDraft[+s.dataset.r][s.dataset.k];
    r[s.dataset.f] = s.value;
    if (s.dataset.f === 'ai') {
      const list = shownModels(s.value);
      r.model = s.value === '人' ? '' : (list.includes(r.model) ? r.model : s.value === 'agy' ? '' : list[0] || '');
      r.effort = s.value === '人' ? '' : s.value === 'agy' ? '高' : (r.effort || '高');
      if (s.value === 'grok' && r.effort === 'Ultra') r.effort = '高';
      if (s.value === 'agy' && !list.includes(r.model)) r.model = '';
    }
    render(); return;
  }
  const a = s.dataset.act;
  if (a === 'step') {
    try { const r = await api('/api/task/step', { project: s.dataset.p, task: s.dataset.t, index: +s.dataset.i, done: s.checked }); toast(r.resultsPending ? UI.text('成果の記録を確認しています') : r.completionPending ? UI.text('手順が終わりました。完了に移すか確認してください') : UI.text('手順を更新しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (a === 'phase') {
    try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, phase: s.value }); toast(UI.text('フェーズを変えました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (['kind','derivedFrom','workspaceMode'].includes(a)) {
    const t=taskOf(proj(s.dataset.p),s.dataset.t), body={project:s.dataset.p,task:s.dataset.t,[a]:s.value};
    if(a==='kind' && s.value==='derived') body.derivedFrom=$('[data-act="derivedFrom"]').value;
    if(a==='derivedFrom' && s.value) body.kind='derived';
    if(a==='workspaceMode' && s.value==='direct' && !confirm(UI.text('本体で作業しますか？同じ場所での同時作業はできません。'))) {s.value=t.workspaceMode || 'isolated';return;}
    try {await api('/api/task',body);await load();} catch(err) {s.value=t[a] || '';toast(err.message);} return;
  }
  if (!['state', 'model', 'effort'].includes(a)) return;
  if (s.dataset.ai && a !== 'state') {
    try {
      const r = await api('/api/term/switch', { project: s.dataset.p, task: s.dataset.t, ai: s.dataset.ai, field: a, value: a === 'model' ? modelRequest(s.dataset.ai,s.value) : s.value });
      toast(r.sent ? UI.template`${AI_LABEL[s.dataset.ai]} に「${r.command}」を送りました` : UI.text('保存しました（次に始める時から使います）'));
      await load();
    } catch (err) { toast(err.message); }
    return;
  }
  if (a === 'state' && s.value === '完了') {
    const t = taskOf(proj(s.dataset.p), s.dataset.t);
    if (!confirm(UI.text('この作業を完了に移しますか？'))) { s.value = t.state; return; }
    try { await api('/api/task/completion', { project: s.dataset.p, task: s.dataset.t, action: 'approve', confirm: true, expectedHash: t.completionHash }); await load(); } catch (err) { s.value = t.state; toast(err.message); } return;
  }
  try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, [a]: s.value }); toast(a === 'state' ? UI.template`「${s.value}」にしました` : UI.text('変えました')); await load(); }
  catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.classList.contains('addstep')) {
    e.preventDefault();
    const f = e.target, v = f.step.value.trim();
    if (!v) return;
    try { await api('/api/task/step', { project: f.dataset.p, task: f.dataset.t, add: v }); if(f.step.value.trim()===v)f.step.value='';stepsOpen = true; const key=JSON.stringify([f.dataset.p,f.dataset.t]);if(!workFolds.has(key))workFolds.set(key,new Map());workFolds.get(key).set('steps',true);workFolds.get(key).set('management',true);if(f.isConnected!==false){const work=f.closest('.work-compact');for(const name of ['steps','management']){const fold=work?.querySelector('[data-work-fold="'+name+'"]');if(fold)fold.open=true;}}toast(UI.text('手順を足しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'projform') {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const first = String(f.get('firstTask') || '').trim();
      const p = await api('/api/project/new', { ...Object.fromEntries(f.entries()), related: f.getAll('related'), refs: newRefs });
      newRefs = []; newProjectPreset = null;
      if (first) {
        // 作ったプロジェクトで、最初の作業を初期選択で始める（役割は今のフェーズから）
        try {
          const r = await api('/api/start', { project: p.id, text: first, ...defaultWorkPick('司令塔'), images: [] });
          try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
          toast(UI.template`「${p.name}」を作り、最初の作業を AI に頼みました`);
          view = { kind: 'work', project: p.id, task: r.task }; open.add(p.id); save(); await load(); return;
        } catch (err) { toast(UI.template`「${p.name}」は作りましたが、最初の作業を始められませんでした：${err.message}`); }
      } else toast(UI.template`「${p.name}」を作りました。作業を足して始めましょう`);
      view = { kind: 'project', project: p.id, task: null }; open.add(p.id); save(); await load();
    } catch (err) { toast(err.message); }
    return;
  }
  // すぐ始める：書いた文から作業を作り、会話画面で AI に送る（役割・担当は今のフェーズから）
  if (e.target.id === 'quickform') {
    e.preventDefault();
    const f = e.target, p = proj(f.dataset.p);
    if (!p || quickStarting.has(p.id) || quickUploading.has(p.id)) return;
    if (!warnChildren(p)) return;
    const d = quickDraft(p); d.text = f.elements.namedItem('text').value; keepQuick(p.id);
    if (!d.text.trim() && !d.images.length) { toast(UI.text('依頼を書くか画像を追加してください')); return; }
    d.request ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`; keepQuick(p.id);
    quickStarting.add(p.id); f.elements.namedItem('text').disabled = true; drawQuick(p);
    try {
      const r = await api('/api/start', { project: p.id, text: d.text, ai: d.ai, model: modelRequest(d.ai,d.model), effort: d.effort, images: d.images.map(x => x.id), task: d.task, request: d.request });
      d.text = ''; d.images = []; delete d.task; delete d.request; quickOverrides.delete(p.id); if (state.specialMode?.enabled) Object.assign(d, defaultWorkPick('司令塔')); keepQuick(p.id);
      try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
      toast(r.agent ? UI.text('担当・依頼・画像の場所を保存しました。Discordで渡してください') : UI.text('作業を作って、AI に頼みました'));
      view = { kind: 'work', project: p.id, task: r.task }; save(); await load();
    } catch (err) { if (err.task) { d.task = err.task; keepQuick(p.id); } toast(err.message); }
    finally { quickStarting.delete(p.id); f.elements.namedItem('text').disabled = false; drawQuick(p); }
    return;
  }
  if (e.target.id !== 'newform') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const t = await api('/api/task/new', { project: view.project, title: f.get('title'), owner: f.get('owner'), role: f.get('role'), kind:f.get('kind'),derivedFrom:f.get('derivedFrom'),workspaceMode:f.get('workspaceMode'),parent: f.get('parent'), phase: f.get('phase') || '', via: f.get('via') || '', steps: f.get('steps') || '' });
    toast(UI.text('作業を足しました')); view = { kind: 'work', project: view.project, task: t.id }; save(); await load();
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#menu').hidden = true; if ($('#fsheet')) $('#fsheet').hidden = true; }
  if (isSendKey(e) && e.target.closest && e.target.closest('#quickform')) { e.preventDefault(); $('#quickform').requestSubmit(); }
});
$('#turn').addEventListener('click', () => { view = { ...view, kind: view.kind === 'turn' ? 'project' : 'turn' }; render(); });
$('#ver').addEventListener('click', () => { view = { ...view, kind: 'settings' }; clearRolesDraft(); verOpen = true; settingsTab = 'manage'; render(); loadChangelog(); });
$('#upd').addEventListener('click', openUpdate);
document.addEventListener('click', async e => {
  if (e.target.closest('[data-hub-update]')) await switchHubUpdate();
});
// 本体のフォルダ：Mac のフォルダ選択の窓で選ぶ
document.addEventListener('click', /* @app-callback app-actions.js:appActionsCallback4224 */appActionsCallback4224());
/* @app-function app-actions.js:setBodyFolder */
// アプリの窓に落とした時（本当の場所が分かる）：Mac アプリから呼ばれる
let nativeDropSequence = 0;
const nativeDropTickets = new Map();
window.hubNativeDrop = /* @app-callback app-files.js:appFilesCallback4244 */appFilesCallback4244();
/* @app-function app-files.js:droppedFiles */
/* @app-function app-files.js:beginNativeDrop */
/* @app-function app-files.js:consumeNativeDrop */
/* @app-function app-files.js:failNativeDrop */
window.hubNativeDrop.begin = beginNativeDrop;
window.hubNativeDrop.fail = failNativeDrop;
window.hubNativePaste = /* @app-callback app-files.js:appFilesCallback4290 */appFilesCallback4290();
// スマホ：☰ で左の一覧を出し入れ。一覧で何かを選んだらしまう
$('#menu-toggle').addEventListener('click', () => { const on = document.body.classList.toggle('show-list'); $('#menu-toggle').setAttribute('aria-expanded', String(on)); });
function closeDrawer() { document.body.classList.remove('show-list'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
// 一覧の外を押したら、引き出しをしまう（一覧の中の選択は、下の [data-go] の処理でしまう）
document.addEventListener('click', e => { if(e.target.closest?.('[data-steps-retry]')){syncTaskSteps();return;} const b=e.target.closest?.('[data-steps-close]'); if(b){const d=b.closest('.steps');if(d)d.open=false;stepsOpen=false;return;} if (document.body.classList.contains('show-list') && e.target.closest && !e.target.closest('#list') && !e.target.closest('#menu-toggle')) closeDrawer(); }, true);
$('#gear').addEventListener('click', () => { view = { ...view, kind: view.kind === 'settings' ? 'project' : 'settings' }; clearRolesDraft(); render(); });

// 左の木だけすぐ読み直す（AI が始めた・終わった時。丸の色を変えるため）
async function refreshTree(isCurrent = () => true) {
  const epoch = stateLoadEpoch;
  try { const next = await fetchState(); if (!isCurrent() || epoch !== stateLoadEpoch || webchatUIPending() || accountSelectionSaving || taskFastSaving || accelerationSaving || initialPickSaving || specialModeSaving || phoneLabelsSaving || !next) return; adoptState(next); syncWebchatSettingsControls(); syncChatPhoneLabels(); syncAccountPickers(); syncChatWebchatAvailability(); refreshKidsDoneBar(); if (treeKey() !== renderedTreeKey) renderTree(); }
  catch (e) { /* 次に */ }
}
const editing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
let statePolling = false;
async function pollState() {
  if (document.hidden || statePolling) return;
  statePolling = true;
  const epoch = stateLoadEpoch;
  try {
    const next = await fetchState();
    if (epoch !== stateLoadEpoch || webchatUIPending() || accountSelectionSaving || taskFastSaving || accelerationSaving || initialPickSaving || specialModeSaving || phoneLabelsSaving) return; // 保存後などの明示 load() を古い定期取得で上書きしない
    const previousModels = JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]);
    const previousInitial = JSON.stringify([state.initialPick, state.initialPickError]);
    if (next) adoptState(next);
    refreshKidsDoneBar(); syncWorkQuestion(); syncTaskSteps();
    syncWebchatSettingsControls();
    // 通知のrefreshTreeが先にstateを更新した時や304でも、実際のoptionを同期する。
    // 表示名はmainKeyに含めず、会話の入力欄・選択欄は作り直さない。
    syncChatPhoneLabels();
    syncAccountPickers();
    syncChatWebchatAvailability();
    if (typeof syncRoleSettings === 'function') syncRoleSettings();
    if(view.kind==='settings'&&state.stopControl)drawEmergencyStatus(state.stopControl);
    if (view.kind === 'settings' && !phoneLabelsSaving && renderedPhoneKey !== phoneSettingsKey() && !$('#phone-labels')?.contains?.(document.activeElement)) drawPhoneLabels();
    if (view.kind === 'settings' && !modelViewSaving && previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models])) { drawModelOrder(); syncRoleModelOrder(); }
    if (view.kind === 'settings' && !initialPickSaving && (previousInitial !== JSON.stringify([state.initialPick, state.initialPickError]) || previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]))) drawInitialPick();
    if (!next && state.sessions.length) { state.sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; } // 止まっている秒数だけ取り直す
    if (document.hidden) return;
    if (typeof syncMaintenanceControls === 'function') syncMaintenanceControls();
    showVersion(state.version, state.latest);
    updateTurnCounts();
    window.HubMobile?.badges();
    const keepMain = view.kind === 'settings' || view.kind === 'newproject' || editing() || document.querySelector('details[open]:not(.project-notes)');
    if (!keepMain && mainKey() !== renderedMainKey) render();
    else {
      if (treeKey() !== renderedTreeKey) renderTree();
      // 入力中は画面を作り直さず、このボタンと理由だけ最新にする。
      if (keepMain && view.kind === 'project') {
        const box = $('#github-create-status'), p = proj(view.project);
        if (box && p) box.innerHTML = githubCreateButton(p);
      }
      if (!keepMain) updateStatus();
      if (view.kind === 'work') {
        const p = proj(view.project), t = taskOf(p, view.task);
        if (!chatHistoryPending() && t?.copy && !t.mergeExcluded) loadPreview(p.id, t.id);
      }
    }
  } catch (e) { /* 次に */ }
  finally { statePolling = false; }
}
setInterval(pollState, 15000);
// Only an explicitly requested review gets faster progress updates.
setInterval(/* @app-callback app-settings-ai.js:appSettingsAiCallback4358 */appSettingsAiCallback4358(),1500);

// ---- ファイル・スクショを渡す（落とす／⌘V で貼る） ----
// 落とした AI の画面に渡す。画面の外なら、動いている AI が1つの時はそれに、無ければ保存して作業ファイルに記録するだけ
/* @app-function app-files.js:dropTarget */
/* @app-function app-files.js:sendFiles */
/* @app-function app-files.js:appendChatPaths */
let dropTimer = null, lastDropAi = '', lastDropZone = '';
/* @app-function app-files.js:showDrop */
// 窓にファイルを落としても、ファイルが開いて Hub が消えないようにする
document.addEventListener('dragover', /* @app-callback app-files.js:appFilesCallback4414 */appFilesCallback4414());
document.addEventListener('drop', /* @app-callback app-files.js:appFilesCallback4430 */appFilesCallback4430());
document.addEventListener('paste', /* @app-callback app-files.js:appFilesCallback4442 */appFilesCallback4442(), true);

// 作業画面では稼働状況を数秒ごとに更新する（無出力だけで入力待ちにはしない）。
/* @app-function app-terminal.js:updateStatus */
let sessionsPolling = false;
async function pollSessions() {
  if (document.hidden || sessionsPolling || view.kind !== 'work' || !document.querySelector('.pstat')) return;
  sessionsPolling = true;
  const epoch = stateLoadEpoch;
  try { const sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; state.sessions = sessions; if (!document.hidden) updateStatus(); } catch (e) { /* 次に */ }
  finally { sessionsPolling = false; }
}
setInterval(pollSessions, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  else { pollState(); pollSessions(); if (view.kind === 'settings') loadAiTools(); }
});

restoreRestartDrafts();
restoreFreetalkPromotionDrafts();
api('/api/freetalk/ensure', {}).catch(() => {}).then(() => load()).catch(e => { $('#main').innerHTML = UI.template`<div class="view"><p class="note">読み込めませんでした：${esc(e.message)}</p></div>`; });
