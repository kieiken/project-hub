'use strict';
// ChatGPT との連携（版1）：ChatGPT が MCP（hub/mcp.js）を通って Hub の作業を読み、結果を書き戻す
// 道具の中身はここ（Hub 本体の中）で動かす。mcp.js は Hub に聞くだけ（書くのは Hub だけ）
// 設定は <ROOT>/_hub/chatgpt.json：{ work }（true＝ファイルの書き換え・コマンドの実行も許す。最初は false）
const fs = require('fs');
const path = require('path');
const { spawn } = require('./platform');
const { expandHome } = require('./store');

const READ_MAX = 200 * 1024, OUT_MAX = 64 * 1024, CMD_MAX_SEC = 120;
const WORK_OFF = '設定で「実作業もできる」をオンにしてください';
// 秘密が入りがちなファイル（OpenAI に送らない）
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.netrc|\.npmrc|\.pypirc)$/i;
const SHELL = process.platform === 'win32' ? 'powershell.exe' : ['/bin/zsh', '/bin/bash', '/bin/sh'].find(f => fs.existsSync(f)) || 'sh';

const S = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const P = str('プロジェクトの ID（hub_list_projects の id）'), T = str('作業の ID（hub_list_tasks の id）');
const TOOLS = [
  { name: 'hub_list_projects', description: 'Project Hub のプロジェクト一覧（ID・名前・状態・フェーズ・作業の数）を返す', inputSchema: S({}, []), read: true },
  { name: 'hub_list_tasks', description: 'プロジェクトの作業一覧（ID・題名・状態・担当・質問・手順）を返す', inputSchema: S({ project: P }, ['project']), read: true },
  { name: 'hub_get_task', description: '作業ファイル（依頼・手順・やったこと・メモ）と台帳 PROJECT.md の全文を返す。作業を始める前に必ず読む', inputSchema: S({ project: P, task: T }, ['project', 'task']), read: true },
  { name: 'hub_get_chat', description: 'その作業の会話画面の記録（新しい方から limit 件。文字だけ）を返す', inputSchema: S({ project: P, task: T, limit: { type: 'integer', minimum: 1, maximum: 200, description: '何件まで（既定 20）' } }, ['project', 'task']), read: true },
  { name: 'hub_read_file', description: 'プロジェクトの台帳フォルダ・本体フォルダ・作業の場所の中のファイルを読む（200KB まで。フォルダなら中身の一覧）', inputSchema: S({ project: P, path: str('読む場所（本体フォルダからの相対、または絶対パス）'), task: str('作業の ID（作業の場所も探す時）') }, ['project', 'path']), read: true },
  { name: 'hub_report', description: '結果を作業ファイルの「## やったこと」に書き、会話画面に ChatGPT の報告として出す。done=true なら完了の報告（人が確認して完了にする）', inputSchema: S({ project: P, task: T, text: str('報告の文（人が読む日本語で）'), done: { type: 'boolean', description: '作業が終わったら true' } }, ['project', 'task', 'text']) },
  { name: 'hub_ask_owner', description: '人に質問する（作業を「返事待ち」にして、Hub の「あなたの番」に出す）', inputSchema: S({ project: P, task: T, question: str('人への質問（選択肢があれば文に書く）') }, ['project', 'task', 'question']) },
  { name: 'hub_mark_step', description: '作業ファイルの「## 手順」の index 番目（0から）に印を付ける・外す', inputSchema: S({ project: P, task: T, index: { type: 'integer', minimum: 0, description: '手順の番号（0から）' }, done: { type: 'boolean', description: '終わったら true' } }, ['project', 'task', 'index', 'done']) },
  { name: 'hub_propose_task', description: '新しい作業を提案する（担当 ChatGPT・未着手で作る。中身は「## 次にやること」に入る）', inputSchema: S({ project: P, title: str('作業の題名（40文字くらいまで）'), text: str('やること・理由') }, ['project', 'title', 'text']) },
  { name: 'hub_write_file', description: '【実作業】プロジェクトの本体フォルダ・作業の場所の中のファイルを書く（親のフォルダも作る。.git の中は不可）', inputSchema: S({ project: P, path: str('書く場所（本体フォルダからの相対、または絶対パス）'), text: str('ファイルの中身（全部）'), task: str('作業の ID（作業の場所に書く時）') }, ['project', 'path', 'text']), work: true },
  { name: 'hub_run_command', description: '【実作業】プロジェクトの本体フォルダ（または作業の場所）でコマンドを実行する（120秒・出力 64KB まで）', inputSchema: S({ project: P, command: str('実行するコマンド（zsh）'), cwd: str('実行する場所（本体フォルダからの相対。省略で本体）'), timeoutSec: { type: 'integer', minimum: 1, maximum: CMD_MAX_SEC, description: '待つ秒数（既定 60）' }, task: str('作業の ID（作業の場所で実行する時）') }, ['project', 'command']), work: true },
];

const fail = (status, msg) => { const e = Error(msg); e.status = status; throw e; };
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

  project(id) { return this.store.readProject(String(id || '')) || fail(404, `プロジェクト「${id}」が見つかりません（hub_list_projects の id を使ってください）`); }
  task(p, id) { const f = this.store.taskFile(p.id, String(id || '')); return f ? { file: f, t: this.store.readTask(f) } : fail(404, `作業「${id}」が見つかりません（hub_list_tasks の id を使ってください）`); }
  // 読み書きしてよい場所：作業の場所 → 本体 → 台帳（書く時は台帳を除く）
  roots(p, t, write) { return [...new Set([t && expandHome(t.workdir), this.baseOf(p), write ? '' : p.dir].filter(d => d && fs.existsSync(d)).map(d => path.resolve(d)))]; }
  resolve(p, t, raw, write) {
    raw = String(raw || '').trim();
    if (!raw) fail(400, '場所を指定してください');
    const roots = this.roots(p, t, write);
    if (!roots.length) fail(404, '本体フォルダが見つかりません');
    const abs = raw.startsWith('~') || path.isAbsolute(raw);
    const list = (abs ? [path.resolve(expandHome(raw))] : roots.map(r => path.resolve(r, raw))).filter(x => within(x, roots));
    if (!list.length) fail(403, `プロジェクトの外は${write ? '書けません' : '読めません'}：${raw}`);
    const x = write ? list[0] : list.find(f => fs.existsSync(f)) || fail(404, `見つかりません：${raw}`);
    const parts = path.relative(roots.find(r => within(x, [r])), x).split(path.sep);
    if (parts.some(part => part.toLowerCase() === '.git')) fail(403, '.git の中は扱えません');
    if (SECRET.test(path.basename(x))) fail(403, `秘密が入っていそうなファイルは扱えません：${path.basename(x)}`);
    // つながり（シンボリックリンク）で外へ出ていないか
    let probe = x; while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!within(real(probe), roots.map(real))) fail(403, `プロジェクトの外を指しています：${raw}`);
    return x;
  }
  optTask(p, id) { return id ? this.task(p, id).t : null; }

  async call(name, a = {}) {
    const def = TOOLS.find(t => t.name === name);
    if (!def) fail(404, `その道具はありません：${name}`);
    if (def.work && !this.settings().work) fail(403, WORK_OFF);
    const log = extra => this.record('chatgpt', { project: a.project, task: a.task, ai: 'chatgpt' }, { tool: name, ...extra });
    if (name === 'hub_list_projects') return this.store.listProjects().map(p => {
      const counts = { all: p.tasks.length };
      for (const t of p.tasks) counts[t.state] = (counts[t.state] || 0) + 1;
      return { id: p.id, name: p.name, status: p.status, description: p.description, phases: p.phases.map(ph => ({ name: ph.name, state: ph.state })), counts };
    });
    const p = this.project(a.project);
    if (name === 'hub_list_tasks') return p.tasks.map(t => ({ id: t.id, title: t.title, state: t.state, owner: t.owner, question: t.question, steps: t.steps }));
    if (name === 'hub_get_task') {
      const { file, t } = this.task(p, a.task);
      const pf = path.join(p.dir, 'PROJECT.md');
      return `# 作業ファイル（${file}）\n状態：${t.state}\n\n${fs.readFileSync(file, 'utf8')}\n\n# 台帳（${pf}）\n\n${fs.readFileSync(pf, 'utf8')}`;
    }
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
      if (buf.includes(0)) fail(415, `文字のファイルではないため読めません：${path.basename(f)}`);
      return `# ${f}${st.size > READ_MAX ? `（${st.size} バイトのうち先頭 ${READ_MAX} バイト）` : ''}\n\n${buf.toString('utf8')}`;
    }
    if (name === 'hub_report') {
      const { t } = this.task(p, a.task), text = String(a.text || '').trim();
      if (!text) fail(400, '報告の文を書いてください');
      const [first, ...rest] = text.split(/\r?\n/);
      this.store.appendSection(p.id, t.id, 'やったこと', [`- ${stamp()} ChatGPT：${first}`, ...rest.map(l => (l.trim() ? '  ' + l : ''))].join('\n'));
      if (a.done === true) this.store.updateTask(p.id, t.id, { state: '完了', question: '' });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: 'chatgpt', text }));
      this.ended(p.id, t.id); log({ done: a.done === true });
      return { ok: true, state: this.task(p, t.id).t.state };
    }
    if (name === 'hub_ask_owner') {
      const { t } = this.task(p, a.task), q = String(a.question || '').trim();
      if (!q) fail(400, '質問を書いてください');
      this.store.updateTask(p.id, t.id, { state: '返事待ち', question: q.replace(/\s+/g, ' ').slice(0, 300) });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: 'chatgpt', text: `【質問】${q}` }));
      this.ended(p.id, t.id); log({});
      return { ok: true, state: '返事待ち', note: '人の返事は ChatGPT のこの会話か、Hub の作業ファイルのメモに来ます' };
    }
    if (name === 'hub_mark_step') {
      this.task(p, a.task);
      const t = this.store.setStep(p.id, a.task, Number(a.index), Boolean(a.done)) || fail(400, 'その手順が見つかりません');
      log({ index: Number(a.index), done: Boolean(a.done) });
      return { ok: true, steps: t.steps };
    }
    if (name === 'hub_propose_task') {
      const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title) fail(400, '題名を書いてください');
      const t = this.store.createTask(p.id, { title, owner: 'chatgpt' }) || fail(400, '作業を作れませんでした');
      if (String(a.text || '').trim()) this.store.appendSection(p.id, t.id, '次にやること', String(a.text).trim());
      this.record('chatgpt', { project: p.id, task: t.id, ai: 'chatgpt' }, { tool: name, title });
      return { ok: true, task: t.id, title, state: '未着手' };
    }
    if (name === 'hub_write_file') {
      const f = this.resolve(p, this.optTask(p, a.task), a.path, true);
      if (typeof a.text !== 'string') fail(400, '中身（text）を指定してください');
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) fail(400, 'フォルダには書けません');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, a.text);
      log({ path: f, bytes: Buffer.byteLength(a.text) });
      return { ok: true, path: f, bytes: Buffer.byteLength(a.text) };
    }
    if (name === 'hub_run_command') {
      const t = this.optTask(p, a.task), command = String(a.command || '').trim();
      if (!command) fail(400, 'コマンドを書いてください');
      const cwd = a.cwd ? this.resolve(p, t, a.cwd, true) : this.roots(p, t, true)[0] || fail(404, '本体フォルダが見つかりません');
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(400, `フォルダではありません：${cwd}`);
      const r = await run(command, cwd, Math.min(CMD_MAX_SEC, Math.max(1, Number(a.timeoutSec) || 60)));
      log({ command: command.slice(0, 300), cwd, code: r.code, timedOut: r.timedOut });
      return { cwd, ...r };
    }
    return fail(404, `その道具はありません：${name}`);
  }
}

// コマンドを動かす：時間を過ぎたら子のプロセスごと止める。出力は合わせて 64KB まで
function run(command, cwd, sec) {
  return new Promise(resolve => {
    const out = { stdout: '', stderr: '' }; let size = 0, truncated = false, timedOut = false;
    const child = spawn(SHELL, process.platform === 'win32' ? ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] : ['-lc', command], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const take = k => c => { if (size >= OUT_MAX) { truncated = true; return; } const s = c.toString('utf8').slice(0, OUT_MAX - size); size += s.length; out[k] += s; if (s.length < c.length) truncated = true; };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); } }, sec * 1000);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, ...out, stderr: out.stderr + String(e.message), truncated, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ...out, truncated, timedOut }); });
  });
}

module.exports = { Chatgpt, TOOLS, WORK_OFF };
