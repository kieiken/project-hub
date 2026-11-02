'use strict';
const platform = require('./platform');
const { lt } = require('./locale');
// ChatGPT との連携（版1）：ChatGPT が MCP（hub/mcp.js）を通って Hub の作業を読み、結果を書き戻す
// 道具の中身はここ（Hub 本体の中）で動かす。mcp.js は Hub に聞くだけ（書くのは Hub だけ）
// 設定は <ROOT>/_hub/chatgpt.json：{ work }（true＝ファイルの書き換え・コマンドの実行も許す。最初は false）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WIN } = require('./launch');
const { expandHome } = require('./store');
const { resolveWorkspace, WorkspaceSandbox } = require('./workspace-sandbox');

const READ_MAX = 200 * 1024, OUT_MAX = 64 * 1024, CMD_MAX_SEC = 120;
const WORK_OFF = lt('設定で「実作業もできる」をオンにしてください');
// 秘密が入りがちなファイル（OpenAI に送らない）
const SECRET = /^(mcp-events\.(json|auth\.json)|\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.netrc|\.npmrc|\.pypirc)$/i;
const SHELL = platform.shellCandidates().find(f => fs.existsSync(f)) || 'sh';

const S = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const P = str(lt('プロジェクトの ID（hub_list_projects の id）')), T = str(lt('作業の ID（hub_list_tasks の id）'));
const TOOLS = [
  { name: 'hub_list_projects', description: lt('Project Hub のプロジェクト一覧（ID・名前・状態・フェーズ・作業の数）を返す'), inputSchema: S({}, []), read: true },
  { name: 'hub_list_tasks', description: lt('プロジェクトの作業一覧（ID・題名・状態・担当・質問・手順）を返す'), inputSchema: S({ project: P }, ['project']), read: true },
  { name: 'hub_get_task', description: lt('作業とPROJECT.mdを合計24000字以内で返す。表示不足は原文検索で確認する。作業前に必ず読む'), inputSchema: S({ project: P, task: T }, ['project', 'task']), read: true },
  { name: 'hub_search_archive', description: lt('作業・PROJECT・INDEXと保管原文を局所検索する（前後2行、合計8000字まで）'), inputSchema: S({ project: P, task: T, query: str(lt('検索語')), limit: {type:'integer',minimum:100,maximum:8000} }, ['project','query']), read:true },
  { name: 'hub_get_chat', description: lt('その作業の会話画面の記録（新しい方から limit 件。文字だけ）を返す'), inputSchema: S({ project: P, task: T, limit: { type: 'integer', minimum: 1, maximum: 200, description: lt('何件まで（既定 20）') } }, ['project', 'task']), read: true },
  { name: 'hub_read_file', description: lt('プロジェクトの台帳フォルダ・本体フォルダ・作業の場所の中のファイルを読む（200KB まで。フォルダなら中身の一覧）'), inputSchema: S({ project: P, path: str(lt('読む場所（本体フォルダからの相対、または絶対パス）')), task: str(lt('作業の ID（作業の場所も探す時）')) }, ['project', 'path']), read: true },
  { name: 'hub_report', description: lt('結果を作業ファイルの「## やったこと」と会話に報告する。requestは内部自動Chat専用。GPT子への外部報告は禁止。指定なしは従来のChatGPT報告。done=trueなら完了の報告（人が確認して完了にする）'), inputSchema: S({ project: P, task: T, text: str(lt('報告の文（人が読む日本語で）')), request: str(lt('内部自動Chatの依頼ID')), done: { type: 'boolean', description: lt('作業が終わったら true') } }, ['project', 'task', 'text']) },
  { name: 'hub_ask_owner', description: lt('人に質問する（作業を「返事待ち」にして、Hub の「あなたの番」に出す）'), inputSchema: S({ project: P, task: T, question: str(lt('人への質問（選択肢があれば文に書く）')) }, ['project', 'task', 'question']) },
  { name: 'hub_mark_step', description: lt('作業ファイルの「## 手順」の index 番目（0から）に印を付ける・外す'), inputSchema: S({ project: P, task: T, index: { type: 'integer', minimum: 0, description: lt('手順の番号（0から）') }, done: { type: 'boolean', description: lt('終わったら true') } }, ['project', 'task', 'index', 'done']) },
  { name: 'hub_propose_task', description: lt('新しい作業を提案する（担当 ChatGPT・未着手で作る。中身は「## 次にやること」に入る）'), inputSchema: S({ project: P, title: str(lt('作業の題名（40文字くらいまで）')), text: str(lt('やること・理由')) }, ['project', 'title', 'text']) },
  { name: 'hub_write_file', description: lt('【実作業】プロジェクトの本体フォルダ・作業の場所の中のファイルを書く（親のフォルダも作る。.git の中は不可）'), inputSchema: S({ project: P, path: str(lt('書く場所（本体フォルダからの相対、または絶対パス）')), text: str(lt('ファイルの中身（全部）')), task: str(lt('作業の ID（作業の場所に書く時）')) }, ['project', 'path', 'text']), work: true },
  { name: 'hub_run_command', description: lt('【実作業】プロジェクトの本体フォルダ（または作業の場所）でコマンドを実行する（120秒・出力 64KB まで）'), inputSchema: S({ project: P, command: str(lt('実行するコマンド（zsh）')), cwd: str(lt('実行する場所（本体フォルダからの相対。省略で本体）')), timeoutSec: { type: 'integer', minimum: 1, maximum: CMD_MAX_SEC, description: lt('待つ秒数（既定 60）') }, task: str(lt('作業の ID（作業の場所で実行する時）')) }, ['project', 'command']), work: true },
];

// request binds GPT mutations to the inbox item, without changing legacy calls.
for (const tool of TOOLS.filter(t => ['hub_write_file', 'hub_run_command', 'hub_ask_owner', 'hub_mark_step'].includes(t.name))) tool.inputSchema.properties.request = str(lt('内部自動Chatの依頼ID（外部MCPからGPT子は変更不可）'));

const fail = (status, msg, unknown = false) => { const e = Error(msg); e.status = status; e.unknown = unknown; throw e; };
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const real = x => { try { return fs.realpathSync(x); } catch (e) { return path.resolve(x); } };
const within = (x, roots) => roots.some(r => x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

class Chatgpt {
  // deps: store, chat（lib/chat）, baseOf, emitRow(project, task, row), ended(project, task), record(action, b, extra)
  constructor({ file, ...deps }) { this.file = file; Object.assign(this, deps); }
  settings() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { work: d.work === true }; } catch (e) { return { work: false }; } }
  save(o) {
    const s = { ...this.settings(), ...(typeof o.work === 'boolean' ? { work: o.work } : {}) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
    return s;
  }
  tools() { const work = this.settings().work; return TOOLS.filter(t => work || !t.work).map(({ name, description, inputSchema, read }) => ({ name, description, inputSchema, ...(read ? { annotations: { readOnlyHint: true } } : {}) })); }

  project(id) { return this.store.readProject(String(id || '')) || fail(404, lt`プロジェクト「${id}」が見つかりません（hub_list_projects の id を使ってください）`); }
  task(p, id) { const f = this.store.taskFile(p.id, String(id || '')); return f ? { file: f, t: this.store.readTask(f) } : fail(404, lt`作業「${id}」が見つかりません（hub_list_tasks の id を使ってください）`); }
  // 読み書きしてよい場所：作業の場所 → 本体 → 台帳（書く時は台帳を除く）
  roots(p, t, write) { if (write && t?.gptChild) return [this.gptChildren?.workspace(p, t) || fail(403, lt('GPT子の専用作業用コピーが必要です'))]; return [...new Set([t && expandHome(t.workdir), this.baseOf(p), write ? '' : p.dir].filter(d => d && fs.existsSync(d)).map(d => path.resolve(d)))]; }
  resolve(p, t, raw, write) {
    raw = String(raw || '').trim();
    if (!raw) fail(400, lt('場所を指定してください'));
    const roots = this.roots(p, t, write);
    if (write && t?.gptChild) return resolveWorkspace(roots[0], raw);
    if (!roots.length) fail(404, lt('本体フォルダが見つかりません'));
    const abs = raw.startsWith('~') || path.isAbsolute(raw);
    const list = (abs ? [path.resolve(expandHome(raw))] : roots.map(r => path.resolve(r, raw))).filter(x => within(x, roots));
    if (!list.length) fail(403, lt`プロジェクトの外は${write ? lt('書けません') : lt('読めません')}：${raw}`);
    const x = write ? list[0] : list.find(f => fs.existsSync(f)) || fail(404, lt`見つかりません：${raw}`);
    const parts = path.relative(roots.find(r => within(x, [r])), x).split(path.sep);
    if (parts.includes('.git')) fail(403, lt('.git の中は扱えません'));
    if (SECRET.test(path.basename(x)) || SECRET.test(path.basename(real(x)))) fail(403, lt`秘密が入っていそうなファイルは扱えません：${path.basename(x)}`);
    // つながり（シンボリックリンク）で外へ出ていないか
    let probe = x; while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!within(real(probe), roots.map(real))) fail(403, lt`プロジェクトの外を指しています：${raw}`);
    return x;
  }
  optTask(p, id) { return id ? this.task(p, id).t : null; }

  guardGpt(p, name, a, internal) {
    if (!['hub_report', 'hub_ask_owner', 'hub_mark_step', 'hub_write_file', 'hub_run_command', 'hub_propose_task'].includes(name)) return;
    const t = a.task ? this.task(p, a.task).t : null;
    const rows = t ? this.chat.read(p.dir, t.id) : [];
    const own = rows.find(r => r.role === 'user' && r.to === 'gptchat' && r.request === a.request);
    if (t?.gptChild) {
      if (!internal.gptOwner || this.gptChildren?.owners.get(p.id + "/" + t.id) !== internal.gptOwner) fail(403, lt("GPT子の変更はHubの自動Chatだけが行えます"));
      if (!own) fail(404, lt('このGPT子にその依頼はありません'));
      if (name === 'hub_propose_task') fail(403, lt('GPT子から別の作業は作れません'));
      if (name !== 'hub_report') this.gptChildren.idle(p, t, internal.gptOwner);
      if (name !== 'hub_report' && rows.some(r => r.ai === 'chatgpt-chat' && r.request === a.request)) fail(409, lt('このGPT依頼は報告済みです'));
      if (a.done === true && name === 'hub_report') fail(403, lt('GPT子の完了は人が確認します。doneは付けないでください'));
    } else {
      // Legacy MCP calls without a GPT request retain their existing permissions.
      // A GPT request can never authorize a write/report against another task.
      if (a.request !== undefined && (name !== 'hub_report' || p.tasks.some(x => this.chat.read(p.dir, x.id).some(r => r.to === 'gptchat' && r.request === a.request)))) fail(404, lt('このGPT子にその依頼はありません'));
    }
  }

  async call(name, a = {}, internal = {}) {
    const def = TOOLS.find(t => t.name === name);
    if (!def) fail(404, lt`その道具はありません：${name}`, true);
    if (def.work && !this.settings().work) fail(403, WORK_OFF);
    const log = extra => this.record('chatgpt', { project: a.project, task: a.task, ai: 'chatgpt' }, { tool: name, ...extra });
    if (name === 'hub_list_projects') return this.store.listProjects().map(p => {
      const counts = { all: p.tasks.length };
      for (const t of p.tasks) counts[t.state] = (counts[t.state] || 0) + 1;
      return { id: p.id, name: p.name, status: p.status, description: p.description, phases: p.phases.map(ph => ({ name: ph.name, state: ph.state })), counts };
    });
    const p = this.project(a.project);
    this.guardGpt(p, name, a, internal);
    if (p.kind === 'freetalk' && (['hub_mark_step', 'hub_propose_task'].includes(name) || name === 'hub_report' && a.done === true)) fail(409, require('./freetalk').PROTECTED);
    if (name === 'hub_list_tasks') return p.tasks.map(t => ({ id: t.id, title: t.title, state: t.state, owner: t.owner, question: t.question, steps: t.steps }));
    if (name === 'hub_get_task') {
      const { file, t } = this.task(p, a.task);
      const pf = path.join(p.dir, 'PROJECT.md');
      const budget=require('./text-budget');
      return budget.taskView(fs.readFileSync(file,'utf8'),fs.readFileSync(pf,'utf8'),this.textBudget&&p.kind!=='freetalk'?this.textBudget.archives(p.id,t.id):[]);
    }
    if(name==='hub_search_archive'){if(!this.textBudget)fail(409,lt('本文整理の検索は未接続です'));return this.textBudget.search(p.id,a.task,a.query,a.limit);}
    if (name === 'hub_get_chat') {
      this.task(p, a.task);
      const n = Math.min(200, Math.max(1, Number(a.limit) || 20));
      return this.chat.read(p.dir, a.task).filter(r => r.text && r.role !== 'event').slice(-n).map(r => ({ role: r.role, ai: r.ai || r.to || '', text: r.text, at: r.at }));
    }
    if (name === 'hub_read_file') {
      const f = this.resolve(p, this.optTask(p, a.task), a.path, false), st = fs.statSync(f);
      if (st.isDirectory()) return { path: f, entries: fs.readdirSync(f, { withFileTypes: true }).slice(0, 500).map(d => d.name + (d.isDirectory() ? '/' : '')) };
      const buf = Buffer.alloc(Math.min(st.size, READ_MAX)), fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (buf.includes(0)) fail(415, lt`文字のファイルではないため読めません：${path.basename(f)}`);
      return `# ${f}${st.size > READ_MAX ? lt`（${st.size} バイトのうち先頭 ${READ_MAX} バイト）` : ''}\n\n${buf.toString('utf8')}`;
    }
    if (name === 'hub_report') {
      const { file, t } = this.task(p, a.task), text = String(a.text || '').trim();
      const requested = a.request !== undefined;
      let route;
      if (requested) {
        if (typeof a.request !== 'string' || !a.request) fail(400, lt('内部自動Chatの依頼IDを指定してください'));
        const rows = this.chat.read(p.dir, t.id);
        const original = rows.find(r => r.role === 'user' && r.to === 'gptchat' && r.request === a.request);
        if (!original) fail(404, lt('この作業にその内部自動Chat依頼はありません'));
        route = { ai: 'chatgpt-chat', marker: 'gpt', label: 'ChatGPT（Chat）' };
        const previous = rows.find(r => r.role === 'assistant' && r.ai === route.ai && r.request === a.request);
        if (previous) {
          if (route.marker === 'gpt') this.gptChildren.notify(p, t, a.request, previous.commit);
          return { ok: true, duplicate: true, request: a.request, state: t.state };
        }
      }
      if (!text) fail(400, lt('報告の文を書いてください'));
      const commit = route?.marker === 'gpt' ? this.gptChildren.save(p, t, internal.gptOwner) : undefined;
      const resultLine = commit ? this.gptChildren.reportArtifact(p, t, a.request, text, commit) : undefined;
      const [first, ...rest] = text.split(/\r?\n/);
      const marker = requested ? '<!-- ' + route.marker + '-report:' + a.request + ' -->' : '';
      if (!requested || !fs.readFileSync(file, 'utf8').includes(marker)) {
        this.store.appendSection(p.id, t.id, 'やったこと', ['- ' + stamp() + ' ' + (route?.label || 'ChatGPT') + '：' + first, ...rest.map(l => (l.trim() ? '  ' + l : '')), ...(commit ? [lt`- GPT子の作業用コピーのcommit：${commit}`, '<!-- gpt-commit:' + a.request + ' -->'] : []), ...(requested ? [marker] : [])].join('\n'));
      }
      if (resultLine && !fs.readFileSync(file, 'utf8').split('\n').includes(resultLine)) this.store.appendSection(p.id, t.id, '成果', resultLine);
      if (a.done === true) this.store.updateTask(p.id, t.id, { state: '完了', question: '' });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: route?.ai || 'chatgpt', text, ...(requested ? { request: a.request } : {}), ...(commit ? { commit } : {}) }));
      if (route?.marker === 'gpt') this.gptChildren.notify(p, t, a.request, commit);
      this.ended(p.id, t.id); log({ done: a.done === true, ...(requested ? { request: a.request, ai: route.ai } : {}) });
      return { ok: true, state: this.task(p, t.id).t.state, ...(commit ? { commit } : {}) };
    }
    if (name === 'hub_ask_owner') {
      const { t } = this.task(p, a.task), q = String(a.question || '').trim();
      if (!q) fail(400, lt('質問を書いてください'));
      this.store.updateTask(p.id, t.id, { state: '返事待ち', question: q.replace(/\s+/g, ' ').slice(0, 300) });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: 'chatgpt', text: lt`【質問】${q}` }));
      this.ended(p.id, t.id); log({});
      return { ok: true, state: '返事待ち', note: lt('人の返事は ChatGPT のこの会話か、Hub の作業ファイルのメモに来ます') };
    }
    if (name === 'hub_mark_step') {
      this.task(p, a.task);
      const t = this.store.setStep(p.id, a.task, Number(a.index), Boolean(a.done)) || fail(400, lt('その手順が見つかりません'));
      log({ index: Number(a.index), done: Boolean(a.done) });
      return { ok: true, steps: t.steps };
    }
    if (name === 'hub_propose_task') {
      const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title) fail(400, lt('題名を書いてください'));
      const t = this.store.createTask(p.id, { title, owner: 'chatgpt' }) || fail(400, lt('作業を作れませんでした'));
      if (String(a.text || '').trim()) this.store.appendSection(p.id, t.id, '次にやること', String(a.text).trim());
      this.record('chatgpt', { project: p.id, task: t.id, ai: 'chatgpt' }, { tool: name, title });
      return { ok: true, task: t.id, title, state: '未着手' };
    }
    if (name === 'hub_write_file') {
      const f = this.resolve(p, this.optTask(p, a.task), a.path, true);
      if (typeof a.text !== 'string') fail(400, lt('中身（text）を指定してください'));
      if (this.optTask(p, a.task)?.gptChild && Buffer.byteLength(a.text) > 2 * 1024 * 1024) fail(400, 'file_too_large');
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) fail(400, lt('フォルダには書けません'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (this.optTask(p, a.task)?.gptChild) {
        this.resolve(p, this.optTask(p, a.task), a.path, true);
        const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try { if (fs.fstatSync(fd).nlink > 1) fail(403, 'path_not_allowed'); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, a.text); } finally { fs.closeSync(fd); }
      } else fs.writeFileSync(f, a.text);
      log({ path: f, bytes: Buffer.byteLength(a.text) });
      return { ok: true, path: f, bytes: Buffer.byteLength(a.text) };
    }
    if (name === 'hub_run_command') {
      const t = this.optTask(p, a.task), command = String(a.command || '').trim();
      if (!command) fail(400, lt('コマンドを書いてください'));
      const cwd = a.cwd ? this.resolve(p, t, a.cwd, true) : this.roots(p, t, true)[0] || fail(404, lt('本体フォルダが見つかりません'));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(400, lt`フォルダではありません：${cwd}`);
      const sec = Math.min(CMD_MAX_SEC, Math.max(1, Number(a.timeoutSec) || 60));
      const root = t?.gptChild && this.roots(p, t, true)[0];
      if (root && command.length > 16000) fail(400, 'command_too_large');
      const r = root ? await new WorkspaceSandbox({ readFiles: [] }, { workspace: () => this.roots(p, this.task(p, t.id).t, true)[0], timeoutMs: sec * 1000 }).run('cd ' + "'" + cwd.replaceAll("'", "'\\''") + "'" + ' && ' + command) : await run(command, cwd, sec);
      log({ command: command.slice(0, 300), cwd, code: r.code, timedOut: r.timedOut });
      return { cwd, ...r };
    }
    return fail(404, lt`その道具はありません：${name}`, true);
  }
}

// コマンドを動かす：時間を過ぎたら子のプロセスごと止める。出力は合わせて 64KB まで
function run(command, cwd, sec) {
  return new Promise(resolve => {
    const out = { stdout: '', stderr: '' }; let size = 0, truncated = false, timedOut = false;
    const shell = SHELL || require('./launch').gitBash();
    if (!shell) { resolve({ code: -1, ...out, stderr: lt('Git for Windows の bash.exe が見つかりません'), truncated, timedOut }); return; }
    const child = spawn(shell, ['-lc', command], { cwd, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = k => c => { if (size >= OUT_MAX) { truncated = true; return; } const s = c.toString('utf8').slice(0, OUT_MAX - size); size += s.length; out[k] += s; if (s.length < c.length) truncated = true; };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => { timedOut = true; try { platform.killTree(child, 'SIGKILL', { fallback: false }); } catch (e) { child.kill('SIGKILL'); } }, sec * 1000);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, ...out, stderr: out.stderr + String(e.message), truncated, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ...out, truncated, timedOut }); });
  });
}

module.exports = { Chatgpt, TOOLS, WORK_OFF };
