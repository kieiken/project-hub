'use strict';
const { lt } = require('./locale');
// 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選べる
// - Claude Code は `claude -p --output-format stream-json`、Codex は `codex exec --json` を1回ずつ動かす
// - 同じ AI の続きは、その AI 自身の会話を再開（resume）する
// - 別の AI に変えた時は、その AI がまだ見ていない会話（人と AI の文字だけ）を引き継ぎとして一緒に渡す
// 会話は <台帳>/.ai/chat/<作業ID>.jsonl に1行ずつ、AI ごとの再開用の番号は <作業ID>.json、待っている指示は <作業ID>.queue.json に残す
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('node:crypto');
const launch = require('./launch');
const instructions = require('./instructions');
const { snapshot, buildHandoffCard } = require('./handoff-card');

const LIMIT = 60000; // 引き継ぎの文字数。モデル全体のトークン上限とは別。
const HANDOFF_LIMIT = 12000;
const LABEL = launch.AI_LABEL;

const files = (pdir, task) => ({ log: path.join(pdir, '.ai', 'chat', `${task}.jsonl`), meta: path.join(pdir, '.ai', 'chat', `${task}.json`), queue: path.join(pdir, '.ai', 'chat', `${task}.queue.json`) });

function read(pdir, task) {
  try {
    return fs.readFileSync(files(pdir, task).log, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function append(pdir, task, row) {
  const f = files(pdir, task).log;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const r = { at: new Date().toISOString(), ...row };
  fs.appendFileSync(f, JSON.stringify(r) + '\n');
  return r;
}
function readMeta(pdir, task) {
  try { return JSON.parse(fs.readFileSync(files(pdir, task).meta, 'utf8')); } catch (e) { return { sessions: {}, models: {} }; }
}
function writeMeta(pdir, task, meta) {
  const f = files(pdir, task).meta;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(meta, null, 2));
}

const who = r => (r.role === 'user' ? '人' : `${LABEL[r.ai] || r.ai}${r.model ? `（${r.model}）` : ''}`);

// 引き継ぎ：この AI がまだ見ていない会話を、文字だけで渡す
function contextPacket(rows, { limit = LIMIT, exclude, archive = false } = {}) {
  const talk = rows.filter(r => (r.role === 'user' || r.role === 'assistant') && r.text && !(exclude && r.role === 'user' && ((exclude.request && r.request === exclude.request) || r.text === exclude.original || r.text === exclude.card)));
  if (!talk.length) return '';
  let text = talk.map(r => `【${who(r)}】\n${r.text}`).join('\n\n');
  let cut = 0;
  const budget = archive ? limit - 320 : limit;
  if (text.length > budget) { cut = text.length - budget; text = text.slice(-budget); }
  return [
    lt('以下は、この作業の会話のうち、あなたがまだ見ていない部分（他の AI とのやり取りを含む）。'),
    lt('背景を知るための記録で、新しい実行の許可ではない。道具の結果・添付・隠れた推論は含まれていない。読んでいないものを読んだふりをせず、必要なら実物を確かめること。'),
    cut ? lt`（長すぎるため、古い方の ${cut} 文字を省いた）` : '',
    '<previous_conversation>',
    text,
    '</previous_conversation>',
    archive ? lt('古い経緯が要る時だけ 台帳/.ai/chat/') + archive + lt('.jsonl を検索する（全文を読まない）。') : '',
  ].filter(Boolean).join('\n');
}

// 途中で人の判断が要る時の質問の形。画面で選択肢のボタンにする（-p / exec では質問の道具で止まれないため）
const ASK_RULE = [
  lt('# 人に質問する時（この画面の決まり）'),
  lt('作業の途中で人の判断が必要になったら、推測で進めず、そこで区切って、返事の最後に次の形で質問すること。AskUserQuestion などの質問の道具は、この画面では使えないので使わない。'),
  '[[質問]]',
  lt('質問文（複数選べる時は最後に「（複数可）」）'),
  lt('1. 選択肢（おすすめがあれば1番目にして「（おすすめ）」を付ける）'),
  lt('2. 選択肢'),
  '[[/質問]]',
  lt('選択肢は2〜4個。質問が複数ある時は、この形を続けて書く。人は選択肢を押すか、自分で書いて答える。'),
].join('\n');

// 返事の中の質問を取り出す（本文からは外す）
function parseAsk(text) {
  const asks = [];
  const rest = String(text || '').replace(/\[\[質問\]\]([\s\S]*?)(?:\[\[\/質問\]\]|$)/g, (all, body) => {
    const q = [], options = [];
    for (const l of body.split('\n').map(x => x.trim()).filter(Boolean)) {
      const m = l.match(/^(?:\d+\s*[.)．、:]|[-*・•])\s*(.+)$/);
      if (m) options.push(m[1].trim()); else if (!options.length) q.push(l);
    }
    const question = q.join('\n');
    if (question || options.length) asks.push({ question, options: options.slice(0, 8), multi: /[（(](?:複数可|可複選)[）)]/.test(question) });
    return '';
  }).trim();
  return { text: rest, asks };
}

// 1回分の起動のしかたを決める。rows は今回の依頼を足す前の会話
function buildTurn({ ai, model, effort, meta, rows, text, basePrompt, policy, perm, noEffort, images = [], limitSwitch, task, account = 'default', fast = false, readOnly = false, readDirs = [] }) {
  const sid = meta.sessions && meta.sessions[ai];
  // Codex はモデルを変えたら新しい会話にする（再開の時にモデルを変えられるか確かでないため）
  const resume = Boolean(sid) && (meta.sessionAccounts?.[ai] || 'default') === account && (ai === 'claude' || (meta.models || {})[ai] === model);
  let unseen = rows;
  if (resume) {
    let last = -1;
    rows.forEach((r, i) => { if (r.role === 'assistant' && r.ai === ai && (r.account || 'default') === account) last = i; });
    unseen = rows.slice(last + 1);
  }
  const ctx = contextPacket(unseen, limitSwitch ? { limit: HANDOFF_LIMIT, exclude: { request: limitSwitch.sourceRequest, original: limitSwitch.original, card: text }, archive: task } : {});
  // 同一セッションの固定部分は版を照合して短縮し、変わる情報は毎回つける。
  const selected = instructions.select(basePrompt, { meta, ai, sid, resume, restore: Boolean(rows.findLast(r => r.role === 'assistant')?.error) });
  const prefix = selected.rules ? selected.prefix : resume ? policy : basePrompt;
  const m = launch.flagFor(ai, model);
  const prompt = [prefix, launch.startupInfo(ai, model, m, fast) + (limitSwitch ? lt('（Fable の利用上限による自動の引き継ぎ）') : ''), String(prefix || '').includes(launch.CONTEXT_RULE) ? '' : launch.CONTEXT_RULE, ASK_RULE, ctx, lt`# 今回の依頼\n${text}`].filter(Boolean).join('\n\n');
  const base = (readOnly ? ai === 'claude' ? 'claude' : 'codex' : perm || launch.DEFAULT_CMD[ai]).trim().split(/\s+/).filter(Boolean);
  const e = noEffort ? '' : effort && launch.EFFORT_FLAG[ai][effort];
  let args;
  if (ai === 'agy') {
    if (m !== launch.AGY_MODEL.id) throw new Error(lt('Agy で承認されているモデルは Gemini 3.1 Pro (High) だけです'));
    args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--model', m, '--print=' + prompt];
    if (resume) args.push('--conversation', sid);
  } else if (ai === 'grok') {
    args = ['--always-approve', '--output-format', 'streaming-json'];
    if (m) args.push('-m', m);
    if (e) args.push('--effort', e);
    if (resume) args.push('-r', sid);
    args.push('-p', prompt);
  } else if (ai === 'claude') {
    args = [...base.slice(1), '-p', '--output-format', 'stream-json', '--verbose'];
    if(readOnly){args.push('--tools','Read,Glob,Grep','--allowedTools','Read,Glob,Grep','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}');for(const dir of readDirs)args.push('--add-dir',dir);}
    if (m) args.push('--model', m);
    if (e) args.push('--effort', e);
    if (resume) args.push('--resume', sid);
  } else {
    args = ['exec', ...base.slice(1), '--json', '--skip-git-repo-check', ...launch.CODEX_CONTEXT_ARGS, ...launch.accountArgs(ai, account), ...launch.accelerationArgs(ai, fast)];
    if(readOnly)args.push('--sandbox','read-only','-c','approval_policy="never"','-c','mcp_servers={}','-c','web_search="disabled"');
    if (m) args.push('--model', m);
    if (e) args.push('-c', `model_reasoning_effort=${e}`);
    if (resume) args.push('resume', sid);
    for (const image of images) args.push('-i', image);
    args.push('-'); // 依頼は標準入力から渡す（長い引き継ぎでも入るように）
  }
  return { command: ai === 'grok' && base[0] === 'grok' ? launch.grokCommand() : base[0], args, stdin: ['agy', 'grok'].includes(ai) ? '' : prompt, resume, modelFlag: m, effortFlag: e, rules: selected.rules, fixed: selected.fixed, shortRules: selected.short };
}

// 道具の使い方を1行にする
function toolLine(name, input) {
  const i = input || {};
  const x = i.command || i.file_path || i.path || i.pattern || i.url || i.description || '';
  return `${name}${x ? '：' + String(Array.isArray(x) ? x.join(' ') : x).split('\n')[0].slice(0, 160) : ''}`;
}

// CLI 自身の設定の警告など、この作業に関係ない知らせは出さない
const NOISE = /^(Ignoring malformed agent role definition|Model metadata for .* not found)/;
// CLI がモデル名を受け付けなかった時の文言
const EFFORT_REJECTED = /(reasoning[_ ]effort|--effort|unknown variant)/i;
const MODEL_REJECTED = /model[^\n]{0,80}(not supported|not found|does not exist|is not available|invalid|unknown|not exist)|(unknown|invalid) model|model_not_found/i;
const USAGE_LIMIT = /^\s*You've reached your [^\r\n]{1,40} limit\b/i;

// 出力の1行（JSON）を、画面に出す出来事に変える
function parse(ai, o) {
  const ev = [];
  if (!o || typeof o !== 'object') return ev;
  if (ai === 'agy') {
    if (o.event === 'init') {
      if (o.init?.model !== launch.AGY_MODEL.id) return [{ kind: 'done', error: lt('Agy の応答モデルが承認された Gemini 3.1 Pro (High) と一致しないため停止しました'), abort: true }];
      if (o.conversation_id) ev.push({ kind: 'session', id: o.conversation_id });
    }
    const step = o.step_update;
    if (o.event === 'step_update' && step) {
      if (step.step_type === 'agent_response' && step.text_delta) ev.push({ kind: 'text', text: step.text_delta });
      else if (step.state === 'ACTIVE' && step.step_type !== 'user_input') ev.push({ kind: 'tool', text: toolLine(step.tool_name || step.step_type || 'Agy', step) });
    }
    if (o.event === 'result') {
      const result = o.result || {};
      ev.push({ kind: 'done', error: result.status === 'SUCCESS' ? '' : String(result.error?.message || result.error || result.message || lt('Agy が途中で止まりました')), result: typeof result.response === 'string' ? result.response : '' });
    }
    if (o.event === 'error') ev.push({ kind: 'done', error: String(o.error?.message || o.error || o.message || lt('Agy のエラー')) });
    return ev;
  }
  if (ai === 'grok') {
    if (o.type === 'text' && typeof o.data === 'string') ev.push({ kind: 'text', text: o.data });
    if (o.type === 'tool_call') ev.push({ kind: 'tool', text: toolLine(o.title || o.toolName || 'Grok', o.rawInput) });
    if (o.type === 'end') {
      if (o.sessionId) ev.push({ kind: 'session', id: o.sessionId });
      ev.push({ kind: 'done', error: ['refusal', 'cancelled'].includes(o.stopReason) ? lt`Grok が途中で止まりました（${o.stopReason}）` : '', usage: inputUsage(ai, o.usage) });
    }
    if (o.type === 'error') ev.push({ kind: 'done', error: require('./grok').loginError(String(o.message || lt('Grok のエラー'))) });
    return ev;
  }
  if (ai === 'claude') {
    // 本文の引用や一時的な rate_limit だけでは交代しない。CLI のエラー構造と正式文の両方が要る。
    const limitText = o.type === 'result' ? o.result : (Array.isArray(o.message?.content) ? o.message.content : []).filter(c => c.type === 'text').map(c => c.text || '').join('\n');
    if (typeof limitText === 'string' && USAGE_LIMIT.test(limitText) &&
      ((o.type === 'result' && o.is_error === true) || (o.type === 'assistant' &&
        (o.error === 'rate_limit' || (o.isApiErrorMessage === true && o.message?.model === '<synthetic>'))))) ev.push({ kind: 'limit', error: limitText });
    if (o.type === 'system' && o.subtype === 'compact_boundary') ev.push({ kind: 'compact' });
    if (o.session_id && (o.type === 'system' || o.type === 'result')) ev.push({ kind: 'session', id: o.session_id });
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text) ev.push({ kind: 'text', text: c.text });
        // 質問の道具を使ってしまった時も、画面の選択肢にする
        if (c.type === 'tool_use' && c.name === 'AskUserQuestion') ev.push({ kind: 'ask', asks: ((c.input && c.input.questions) || []).map(q => ({ question: String(q.question || ''), options: (q.options || []).map(x => String((x && x.label) || x)), multi: Boolean(q.multiSelect) })) });
        else if (c.type === 'tool_use') ev.push({ kind: 'tool', text: toolLine(c.name, c.input) });
      }
    }
    if (o.type === 'result') ev.push({ kind: 'done', error: o.is_error ? String(o.result || lt('エラー')) : '', result: typeof o.result === 'string' ? o.result : '', usage: inputUsage('claude', o.usage) });
    return ev;
  }
  // Codex（新しい形）
  if (o.type === 'thread.started' && o.thread_id) ev.push({ kind: 'session', id: o.thread_id });
  if (o.type === 'item.completed' && o.item) {
    const it = o.item;
    if (it.type === 'agent_message' && it.text) ev.push({ kind: 'text', text: it.text });
    else if (it.type === 'command_execution') ev.push({ kind: 'tool', text: toolLine(lt('コマンド'), { command: it.command }) });
    else if (it.type === 'file_change') ev.push({ kind: 'tool', text: lt`ファイル変更：${(it.changes || []).map(c => c.path).join('、')}` });
    else if (it.type === 'error' && it.message && !NOISE.test(it.message)) ev.push({ kind: 'tool', text: lt`注意：${it.message}` });
  }
  if (o.type === 'turn.completed') ev.push({ kind: 'done', error: '', usage: inputUsage('codex', o.usage) });
  if (o.type === 'turn.failed' || o.type === 'error') ev.push({ kind: 'done', error: String((o.error && o.error.message) || o.message || lt('エラー')) });
  // Codex（古い形）
  const m = o.msg;
  if (m && typeof m === 'object') {
    if (m.type === 'session_configured' && m.session_id) ev.push({ kind: 'session', id: m.session_id });
    if (m.type === 'agent_message' && m.message) ev.push({ kind: 'text', text: m.message });
    if (m.type === 'exec_command_begin') ev.push({ kind: 'tool', text: toolLine(lt('コマンド'), { command: m.command }) });
    if (m.type === 'task_complete') ev.push({ kind: 'done', error: '' });
    if (m.type === 'error') ev.push({ kind: 'done', error: String(m.message || lt('エラー')) });
  }
  return ev;
}

function inputUsage(ai, usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const keys = ai === 'claude' ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] : ['input_tokens', 'cached_input_tokens'];
  const out = Object.fromEntries(keys.filter(k => Number.isFinite(usage[k]) && usage[k] >= 0).map(k => [k, usage[k]]));
  return Object.keys(out).length ? out : undefined;
}

// 実行中の会話（作業ごとに1つまで）
class ChatRunner {
  // dirOf: プロジェクトID → 台帳の場所（待っている指示を保存して、再起動しても残すため）
  constructor(opts) { this.running = new Map(); this.watchers = new Map(); this.queues = new Map(); this.base = new Map(); this.stops = new Map(); this.dirOf = (opts && opts.dirOf) || null; this.canStart = (opts && opts.canStart) || null; this.refreshQueued = (opts && opts.refreshQueued) || null; this.limitBackup = (opts && opts.limitBackup) || null; this.limitPreflight = opts?.limitPreflight || null; this.beforeQueued = opts?.beforeQueued || null; this.onLimit = opts?.onLimit || null; this.onFableSuccess = opts?.onFableSuccess || null; this.onSettled = opts?.onSettled || null; this.delegates = opts?.delegates; this.permFor = opts?.permFor; this.accountFor = opts?.accountFor; this.fastFor = opts?.fastFor; }
  key(p, t) { return `${p}\u0000${t}`; }
  busy(p, t) { return this.running.get(this.key(p, t)) || null; }
  watch(p, t, fn) {
    const k = this.key(p, t);
    if (!this.watchers.has(k)) this.watchers.set(k, new Set());
    this.watchers.get(k).add(fn);
    return () => this.watchers.get(k).delete(fn);
  }
  emit(p, t, ev) { for (const w of this.watchers.get(this.key(p, t)) || []) w(ev); }

  // 自動開始と保存キュー再開は、再確認中も作業を確保する。
  async sendQueued(o) {
    const { project, task } = o, k = this.key(project, task);
    if (this.busy(project, task)) throw Error(lt('まだ前の返事を書いています。終わるか［止める］を押してから送ってください'));
    const pending = { account: o.account || 'default', pending: true, options: o, request: o.request, ai: o.ai, model: o.model, texts: [], started: Date.now(), last: '', stopped: false };
    pending.finishedP = new Promise(resolve => { pending.resolveFinished = resolve; });
    const cancelled = new Promise((_, reject) => { pending.cancel = () => reject(Error(lt('利用枠の確認中に停止されました。AIは開始していません'))); });
    this.running.set(k, pending);
    this.emit(project, task, { type: 'busy', ai: o.ai, model: o.model, started: pending.started });
    try {
      // 旧事前交代キューも、保存済みの交代先ではなく元のFableを再確認する。
      const request = o.limitSwitch?.direct || o.limitSwitch?.preflight
        ? { ...o, ai: 'claude', model: 'Fable 5.1', account: o.limitSwitch.sourceAccount || 'default', limitSwitch: undefined } : o;
      await Promise.race([Promise.resolve().then(() => this.beforeQueued?.(request)), cancelled]);
      if (pending.stopped) throw Error(lt('利用枠の確認中に停止されました。AIは開始していません'));
      if (!this.queue(project, task).some(x => x.id === o.request)) throw Error(lt('その指示はもう待っていません'));
      this.running.delete(k);
      return this.send({ ...o, mode: 'queued' }); // active判定・端末競合などを待機後に再確認する。
    } finally {
      if (this.running.get(k) === pending) this.running.delete(k);
      if (!this.busy(project, task)) this.emit(project, task, { type: 'idle' });
      pending.resolveFinished();
    }
  }

  // 確認中の追加説明・やり直しは、未保存の依頼と起動条件を引き継ぐ。
  replacePending(p, t, text, mode) {
    const pending = this.busy(p, t);
    if (!pending?.pending || pending.stopped) throw Error(lt('その依頼の利用枠確認は終了しています。現在の状態を確かめてください'));
    const q = this.queue(p, t), index = q.findIndex(x => x.id === pending.request);
    if (index < 0) throw Error(lt('その指示はもう待っていません'));
    let o = pending.options;
    if (o.limitSwitch?.direct || o.limitSwitch?.preflight) {
      o = { ...o, ai: 'claude', model: 'Fable 5.1', requireModel: true, requiredModel: 'claude-fable-5-1', perm: this.permFor?.('claude') || launch.DEFAULT_CMD.claude,
        text: o.limitSwitch.original || o.shown || o.text, shown: o.limitSwitch.original || o.shown || o.text, account: o.limitSwitch.sourceAccount || 'default', limitSwitch: undefined };
    }
    const original = o.shown || o.text;
    const combined = mode === 'amend'
      ? lt`（人が追加の説明を送りました。次の元の指示は取り消さず、この追加説明も合わせて行ってください）\n${original}\n\n追加説明：\n${text}`
      : lt`（人が利用枠確認中の依頼を取り消しました。この新しい指示だけを行ってください）\n${text}`;
    // 旧確認の遅延完了・失敗通知が、新しい依頼を取り消したり復活させないようIDを分ける。
    const request = randomUUID();
    const replacement = { ...q[index], id: request, ai: o.ai, account: o.account || 'default', model: o.model, effort: o.effort, role: o.role, perm: o.perm,
      requireModel: o.requireModel, requiredModel: o.requiredModel, text: combined, shown: combined, limitSwitch: undefined, error: undefined };
    this.setQueue(p, t, q.map((item, i) => i === index ? replacement : item), true);
    const finished = this.stop(p, t, { interrupting: true });
    return { options: { ...o, request, text: combined, shown: combined, started: undefined }, finished };
  }

  // 1回分を動かす。終わったら onEnd を呼ぶ。
  send(o) {
    const { project, task, pdir } = o;
    let { ai, model } = o;
    if (this.busy(project, task)) throw new Error(lt('まだ前の返事を書いています。終わるか［止める］を押してから送ってください'));
    // 旧直行キューも共通の証拠判定へ戻す。保存済みのdirect印を許可として使わない。
    if (o.limitSwitch?.direct || o.limitSwitch?.preflight) {
      o = { ...o, ai: 'claude', model: 'Fable 5.1', requireModel: true, requiredModel: 'claude-fable-5-1', perm: this.permFor?.('claude') || launch.DEFAULT_CMD.claude,
        text: o.limitSwitch.original || o.shown || o.text, shown: o.limitSwitch.original || o.shown || o.text, account: o.limitSwitch.sourceAccount || 'default', limitSwitch: undefined };
    }
    o = { ...o, account: o.account ?? this.accountFor?.(o.project, o.task, o.ai) ?? 'default' };
    ({ ai, model } = o);
    const original = o.shown || o.text;
    const repeated = o.request && read(pdir, task).findLast(r => r.role === 'user' && r.request === o.request &&
      (r.text === original || r.limitSwitch?.original === original));
    const completed = repeated && read(pdir, task).findLast(r => r.role === 'assistant' && (r.request === o.request || r.request === `limit-${o.request}`) && !r.error);
    if (completed) {
      const ai = completed.ai || repeated.to, model = completed.model || repeated.model;
      const completedUser = read(pdir, task).findLast(r => r.role === 'user' && r.request === completed.request);
      return { userRow: repeated, ai, model, effort: completed.effort || repeated.effort,
        limitSwitch: ai === 'codex' && launch.flagFor(ai, model) === 'gpt-6-astra' ? completedUser?.limitSwitch : undefined,
        resume: false, started: Promise.resolve(true) };
    }
    const modelFlag = launch.flagFor(ai, model);
    if (o.requireModel && !modelFlag) throw new Error(lt`指定モデル「${model}」の CLI 名が使えないため、委任を開始できません。モデル指定なしでは起動しません`);
    if (o.requiredModel && o.requiredModel !== modelFlag) throw new Error(lt`指定モデル「${model}」の CLI 名が依頼時から変更されたため、委任を開始できません。別のモデルへは切り替えません`);
    const unavailable = this.canStart && this.canStart(ai, model, o);
    if (unavailable) throw new Error(unavailable);
    // 自動の順番待ちは前の番の prompt を引き継ぐため、起動前に表示情報を更新する。
    if (o.mode === 'queued' && this.refreshQueued) o = { ...o, ...this.refreshQueued(o) };
    let preflight = null;
    if (ai === 'claude' && modelFlag === 'claude-fable-5-1' && !o.limitSwitch && this.limitBackup && this.limitPreflight) {
      const backup = this.limitBackup(o);
      const evidence = backup && this.limitPreflight(o);
      if (evidence && backup.ai === 'codex' && backup.requiredModel === 'gpt-6-astra') {
        const request = String(o.request || Date.now());
        const limitSwitch = { from: 'Fable 5.1', request, sourceRequest: o.request, original, sourceAccount: o.account, preflight: true, until: evidence.validUntil };
        const card = buildHandoffCard({ original: o.text, direct: true, evidence });
        const shown = buildHandoffCard({ original, direct: true, evidence });
        o = { ...o, ...backup, account: backup.account ?? this.accountFor?.(project, task, backup.ai) ?? 'default', requireModel: true, requiredModel: 'gpt-6-astra', request, shown,
          text: card, limitSwitch };
        if (launch.flagFor(o.ai, o.model) !== 'gpt-6-astra') throw Error(lt('上限による引き継ぎの指定モデルが使えません。別のモデルでは起動しません'));
        const unavailable = this.canStart && this.canStart(o.ai, o.model, o);
        if (unavailable) throw Error(unavailable);
        const time = at => at === null ? lt('手動解除まで') : new Date(at).toLocaleString('ja-JP');
        preflight = { role: 'event', ai: 'claude', limitSwitch, text: lt`Fable 5.1 上限保持中（記録 ${time(evidence.at)}・解除 ${time(evidence.validUntil)}）。最初から Astra で開始` };
      }
    }
    ({ ai, model } = o);
    const { effort, text } = o;
    const rows = read(pdir, task);
    const meta = readMeta(pdir, task);
    o = { ...o, fast: o.ai === 'codex' && this.fastFor?.(project, task) === true };
    const turn = buildTurn({ ...o, meta, rows });
    this.base.set(this.key(project, task), o); // 追加の指示を送る時に使う
    const existing = repeated || o.request && rows.findLast(r => r.role === 'user' && r.request === o.request && r.text === (o.shown || text));
    const userRow = existing || append(pdir, task, { role: 'user', ...(ai === 'codex' ? { fast: o.fast } : {}), account: o.account, text: o.shown || text, to: ai, model, effort, turn: randomUUID(), startedAt: new Date().toISOString(), ...snapshot(o.dir), ...(o.limitSwitch ? { limitSwitch: o.limitSwitch, handoff: o.text } : {}), ...(o.request ? { request: o.request } : {}), ...(o.mode ? { mode: o.mode } : {}) });
    if (!existing) this.emit(project, task, { type: 'row', row: userRow });
    if (preflight && !rows.some(r => r.role === 'event' && r.limitSwitch?.request === preflight.limitSwitch.request)) {
      this.emit(project, task, { type: 'row', row: append(pdir, task, preflight) });
    }
    o = { ...o, userRow };
    const running = this.run(o, turn, meta, rows);
    return { userRow, ai, model, effort, limitSwitch: o.limitSwitch, resume: turn.resume, started: running.startedP };
  }

  run(o, turn, meta, rows) {
    const { project, task, pdir, dir, ai, model, effort, env, onEnd, account = 'default' } = o;
    const child = spawn(turn.command, turn.args, { cwd: dir, env: launch.childEnv(ai, launch.accountEnv(ai, account, { ...process.env, ...(env || {}) })), stdio: ['pipe', 'pipe', 'pipe'] });
    if (!o.started) o.started = Date.now(); // 思考の指定をやり直しても、最初に送った時から数える
    const run = { child, ai, account, model, effort, userRow: o.userRow, texts: [], err: '', done: null, sid: null, stopped: false, started: o.started, limitSwitch: o.limitSwitch, last: '', stopVersion: this.stops.get(this.key(project, task)) || 0 };
    run.startedP = new Promise(resolve => { child.once('spawn', () => { run.spawned = true; resolve(true); }); child.once('error', () => resolve(false)); });
    run.finishedP = new Promise(r => { run.resolveFinished = r; });
    this.running.set(this.key(project, task), run);
    this.emit(project, task, { type: 'busy', ai, model, started: run.started });
    child.stdin.on('error', () => {});
    child.stdin.end(turn.stdin);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let rest = '';
    const consume = l => {
      let x; try { x = JSON.parse(l); } catch (e) { return; }
      if (run.blocked) return;
      for (const ev of parse(ai, x)) {
        if (ev.kind === 'session') run.sid = ev.id;
        else if (ev.kind === 'text') { run.texts.push(ev.text); this.emit(project, task, { type: 'partial', ai, text: run.texts.join(['agy', 'grok'].includes(ai) ? '' : '\n\n') }); }
        else if (ev.kind === 'tool') { run.last = ev.text; this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, tool: true, text: ev.text }) }); }
        else if (ev.kind === 'ask') run.asks = [...(run.asks || []), ...ev.asks];
        else if (ev.kind === 'limit') run.limit = ev.error;
        else if (ev.kind === 'compact') run.compact = true;
        else if (ev.kind === 'done') { run.done = ev; if (ev.abort) { run.blocked = true; run.sid = null; child.kill('SIGTERM'); } }
      }
    };
    child.stdout.on('data', d => {
      rest += d.toString('utf8');
      const ls = rest.split('\n'); rest = ls.pop();
      for (const l of ls) consume(l);
    });
    child.stderr.on('data', d => { run.err = (run.err + d.toString('utf8')).slice(-4000); });
    const finish = (code, closed = false) => {
      if (run.finished) return; run.finished = true;
      this.running.delete(this.key(project, task));
      let text = run.texts.join(['agy', 'grok'].includes(ai) ? '' : '\n\n') || (run.done && run.done.result) || '';
      let error = '';
      if (run.stopped) error = lt('止めました');
      else if (run.done && run.done.error) error = run.done.error;
      else if (code !== 0 && code !== null) error = (run.err.trim().split('\n').slice(-3).join(' ') || lt`終了コード ${code}`);
      else if (code === null && !text) error = run.err.trim() || lt('途中で終わりました');
      if (!run.stopped && run.limit && !run.done && !run.err.trim()) error = run.limit;
      if (ai === 'grok' && error) error = require('./grok').loginError(error);
      const modelRejected = error && !text && turn.modelFlag && !run.stopped && MODEL_REJECTED.test(error + ' ' + run.err);
      if (modelRejected) error = lt`指定したモデル「${turn.modelFlag}」を ${LABEL[ai]} が受け付けませんでした。設定画面の「AI の更新」と「CLI に渡すモデル名」を確認してください。${error}`;
      // 思考の指定を断られた：指定なしで1回だけやり直す
      if (!modelRejected && error && !text && turn.effortFlag && !run.stopped && EFFORT_REJECTED.test(error + ' ' + run.err)) {
        this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, text: lt`思考「${effort}」の指定は使えなかったため、指定なしでやり直します` }) });
        const next = { ...o, noEffort: true, fast: ai === 'codex' && this.fastFor?.(project, task) === true };
        return this.run(next, buildTurn({ ...next, meta, rows }), meta, rows);
      }
      const currentMeta = readMeta(pdir, task);
      meta.accounts = currentMeta.accounts; meta.codexFast = currentMeta.codexFast;
      if (run.sid && !modelRejected && !run.blocked) { const current = readMeta(pdir, task); meta.accounts = current.accounts; meta.sessionAccounts = { ...(meta.sessionAccounts || {}), [ai]: account }; meta.sessions = { ...(meta.sessions || {}), [ai]: run.sid }; meta.models = { ...(meta.models || {}), [ai]: model }; writeMeta(pdir, task, meta); }
      if (turn.rules) { meta.rulesSent = { ...(meta.rulesSent || {}), [ai]: { ...turn.rules, sid: run.sid || meta.sessions?.[ai], restore: Boolean(error || run.compact) } }; writeMeta(pdir, task, meta); }
      const pa = parseAsk(text);
      const asks = [...(run.asks || []), ...pa.asks];
      if (asks.length) text = pa.text;
      const row = append(pdir, task, { role: 'assistant', ai, account, model, effort, text, error, ms: Date.now() - o.started, ...(o.request ? { request: o.request } : {}), ...(run.done?.usage ? { usage: run.done.usage } : {}), ...(asks.length ? { asks } : {}) });
      this.emit(project, task, { type: 'row', row });
      if (onEnd) onEnd(row);
      run.resolveFinished();
      // 待っている指示：普通に終わったら次を始める。［止める］で止めた時は取り消す（［中断して送る］の時は残す）
      const k = this.key(project, task);
      const cancelled = () => run.stopped || (this.stops.get(k) || 0) !== run.stopVersion;
      if (closed && run.spawned && !cancelled() && !modelRejected && !run.blocked && ai === 'claude' && turn.modelFlag === 'claude-fable-5-1') {
        try {
          if (run.limit && USAGE_LIMIT.test(error)) this.onLimit?.(o);
          else if (!error && code === 0 && run.done && !run.limit) this.onFableSuccess?.(o.started);
        } catch (e) {
          this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, text: lt`上限の確認記録を更新できませんでした：${e.message}` }) });
        }
      }
      if (closed && run.spawned && !cancelled() && !o.limitSwitch && ai === 'claude' &&
        turn.modelFlag === 'claude-fable-5-1' && run.limit && USAGE_LIMIT.test(error) && !modelRejected && this.limitBackup) {
        const request = String(o.request || o.started);
        // 起動前の案内は交代キューを作った証拠ではない。失敗後Fableへ戻った再送は正式上限で交代できる。
        const already = this.queue(project, task).some(x => x.limitSwitch?.request === request) ||
          read(pdir, task).some(x => x.role === 'event' && x.limitSwitch?.request === request &&
            !x.limitSwitch.preflight && !x.limitSwitch.direct);
        if (!already) {
          try {
            const backup = this.limitBackup(o);
            if (backup) {
              const original = o.shown || o.text;
              const limitSwitch = { from: 'Fable 5.1', request, sourceRequest: o.request, original, sourceAccount: account };
              const shown = buildHandoffCard({ original, user: o.userRow, rows: read(pdir, task), dir, pdir, task, queue: this.queue(project, task), delegates: this.delegates?.(project, task) || [] });
              const item = { ...backup, account: backup.account ?? this.accountFor?.(project, task, backup.ai) ?? 'default', id: `limit-${request}`, readOnly:o.readOnly, readDirs:o.readDirs, at: new Date().toISOString(), text: shown, shown, limitSwitch };
              this.setQueue(project, task, [item, ...this.queue(project, task)], true);
              this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, limitSwitch, text: lt('Fable 5.1 が利用上限で止まったため、同じ作業を Codex・GPT-6-Astra で続けます（人の決まり：司令塔・チェックの Fable 上限の時だけ）') }) });
            }
          } catch (e) {
            run.limitSaveFailed = true;
            this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai, text: lt`上限による引き継ぎを保存できませんでした：${e.message}` }) });
          }
        }
      }
      this.emit(project, task, { type: 'idle' });
      const q = this.queue(project, task);
      if (cancelled() && !run.interrupting) { if (q.length) this.setQueue(project, task, []); }
      // CLI を起動できなかった時は、待ち順の同じ依頼や後続を勝手に再送しない。
      else if (q.length && !run.interrupting && run.spawned && !run.limitSaveFailed && !this.busy(project, task)) {
        const next = q[0];
        const b = this.base.get(k) || o;
        const retain = error => {
          if ((this.stops.get(k) || 0) !== run.stopVersion) return; // 停止後に起動失敗の通知が来ても、取り消した依頼を復活させない。
          if (!this.queue(project, task).some(x => x.id === next.id)) return;
          // 確認中に取り消された依頼を戻さず、後続の順序も保持する。
          this.setQueue(project, task, this.queue(project, task).map(x => x.id === next.id ? { ...x, error } : x));
          this.emit(project, task, { type: 'row', row: append(pdir, task, { role: 'event', ai: next.ai, text: lt`順番待ちの依頼を始められませんでした：${error}` }) });
        };
        try {
          this.sendQueued({ ...b, resultsOrganize: Boolean(next.resultsOrganize), ai: next.ai, account: next.account || 'default', model: next.model, effort: next.effort, text: next.text, perm: next.perm, requireModel: Boolean(next.requireModel), requiredModel: next.requiredModel, role: next.role || '', limitSwitch: next.limitSwitch, images: [], mode: 'queued', shown: next.shown, request: next.id, started: undefined, noEffort: false })
            .then(async r => {
              if (await r.started) this.unqueue(project, task, next.id);
              else retain(lt('AIを起動できませんでした。CLIの導入状態を確認してください'));
            }).catch(e => retain(String(e.message || e)));
        } catch (e) { retain(String(e.message || e)); }
      }
      // 終了行・上限交代・待ち順の処理後に、全入口共通の後処理を行う。
      setImmediate(() => this.onSettled?.(o, {...row, error: row.error || (!closed ? lt('AIが途中で終了しました') : '')}));
      return undefined;
    };
    child.on('error', e => { run.err = e.code === 'ENOENT' ? lt`「${turn.command}」が見つかりません。ターミナルで ${turn.command} が動くか確かめてください` : String(e.message); finish(1); });
    child.on('close', (code, signal) => { if (rest.trim()) consume(rest); finish(code, !signal); });
    return run;
  }

  stop(p, t, opts) {
    const k = this.key(p, t);
    if (!opts?.interrupting) this.stops.set(k, (this.stops.get(k) || 0) + 1);
    const run = this.busy(p, t);
    if (!run) { const q = this.queue(p, t); if (q.length) this.setQueue(p, t, []); return Boolean(q.length); }
    run.stopped = true;
    if (opts && opts.interrupting) run.interrupting = true;
    if (run.pending) {
      if (!opts?.interrupting) this.setQueue(p, t, []);
      else this.unqueue(p, t, run.request);
      run.cancel();
      return run.finishedP;
    }
    try { run.child.kill('SIGTERM'); } catch (e) { /* 無視 */ }
    return run.finishedP;
  }

  // 追加の指示（今の作業が終わったら続けて行う）。ファイルにも残し、再起動したら読み直す
  queue(p, t) {
    const k = this.key(p, t);
    if (!this.queues.has(k)) {
      let q = [];
      const d = this.dirOf && this.dirOf(p);
      if (d) { try { q = JSON.parse(fs.readFileSync(files(d, t).queue, 'utf8')); } catch (e) { q = []; } }
      this.queues.set(k, Array.isArray(q) ? q : []);
    }
    return this.queues.get(k);
  }
  setQueue(p, t, q, requireSave = false) {
    const d = this.dirOf && this.dirOf(p);
    if (d) {
      const f = files(d, t).queue;
      try {
        if (q.length || fs.existsSync(f)) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          if (requireSave) { const tmp = f + `.limit-${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(q, null, 2)); fs.renameSync(tmp, f); }
          else fs.writeFileSync(f, JSON.stringify(q, null, 2));
        }
      } catch (e) { if (requireSave) throw e; /* 通常の待ち順は今までどおり画面に残す */ }
    } else if (requireSave) throw Error(lt('作業の台帳が見つかりません'));
    this.queues.set(this.key(p, t), q);
    this.emit(p, t, { type: 'queue', queue: q });
    return q;
  }
  enqueue(p, t, item) {
    const it = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), sourceTurn: this.busy(p, t)?.userRow?.turn || null, ...item, account: item.account ?? this.accountFor?.(p, t, item.ai) ?? 'default' };
    this.setQueue(p, t, [...this.queue(p, t), it]);
    return it;
  }
  unqueue(p, t, id) { return this.setQueue(p, t, this.queue(p, t).filter(x => x.id !== id)); }
  stopAll() { for (const [, r] of this.running) { r.stopped = true; if (r.pending) r.cancel(); else try { r.child.kill('SIGTERM'); } catch (e) { /* 無視 */ } } }
}

module.exports = { files, HANDOFF_LIMIT, inputUsage, ChatRunner, read, append, readMeta, writeMeta, buildTurn, parse, parseAsk, contextPacket, LIMIT, ASK_RULE };
