'use strict';
// 実行: node --test hub/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { stripVTControlCharacters } = require('util');
const { parseYaml, parseDoc, setScalar } = require('../lib/frontmatter');
const { buildCommand } = require('../lib/launch');
const chatLib = require('../lib/chat');
const launchLib = require('../lib/launch');

const HUB = path.join(__dirname, '..');
const TPL = path.join(HUB, '..', 'docs', 'project-hub', 'templates');
// The handoff text starts with "Claude Code". On a case-insensitive Mac this
// could run a real `claude` from a shell; keep PTY fixtures off the user's PATH.
const SHELL_ENV = { PATH: '/usr/bin:/bin', INPUTRC: '/dev/null', BASH_ENV: '/dev/null',
  ENV: '/dev/null', PS1: 'test> ', BASH_SILENCE_DEPRECATION_WARNING: '1' };

// PTY startup and output depend on the runner's load; wait for evidence, not elapsed time.
async function waitFor(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const atShellPrompt = session => stripVTControlCharacters(session.buf).replace(/\r/g, '').endsWith('test> ');

async function withPtyFixture(sessions, options, fn) {
  const session = sessions.start(options), got = [];
  const off = sessions.watch(options.project, options.task, options.ai, event => got.push(event));
  try { return await fn({ session, got }); }
  finally {
    off();
    sessions.stop(options.project, options.task, options.ai);
  }
}

test('roles.yaml を読める', () => {
  const r = parseYaml(fs.readFileSync(path.join(TPL, '_hub', 'roles.yaml'), 'utf8'));
  assert.deepStrictEqual(r.models.codex, ['GPT-6.1-Sol']);
  assert.deepStrictEqual(r.roles['文章'].main, ['claude-code', 'Opus 5.5', '中']);
  assert.strictEqual(r.permissions['claude-code'], 'claude --permission-mode acceptEdits');
  assert.strictEqual(r.switch.auto, false);
});

test('指示ひな形は改行込み500文字以内で、圧縮の詳細は共通ルールに置く', () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(TPL, 'project', name), 'utf8');
    assert.ok(Array.from(text).length <= 500, name);
    assert.match(text, /\.ai\/rules\.md/);
    assert.match(text, /160k/);
  }
  const rules = fs.readFileSync(path.join(TPL, 'project', '.ai/rules.md'), 'utf8');
  assert.match(rules, /180k/);
  assert.doesNotMatch(rules, /200k トークンを超えたら/);
});

test('Codexの全起動経路と再開で160k・全体の自動圧縮設定を付け、モデルとeffortを保つ', () => {
  const hasSettings = args => {
    assert.strictEqual(args.filter(x => x === 'model_auto_compact_token_limit=160000').length, 1);
    assert.strictEqual(args.filter(x => x === 'model_auto_compact_token_limit_scope="total"').length, 1);
    assert.ok(!args.some(x => x.startsWith('model_context_window=')));
  };
  const opts = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', prompt: 'hello' };
  hasSettings(launchLib.buildArgv(opts).args);
  hasSettings(launchLib.buildArgv({ ...opts, effort: '' }).args);
  const shell = launchLib.buildCommand({ ...opts, dir: '/tmp/demo' });
  assert.match(shell, /'-c' 'model_auto_compact_token_limit=160000'/);
  assert.match(shell, /'-c' 'model_auto_compact_token_limit_scope="total"'/);
  for (const resume of [false, true]) {
    const turn = chatLib.buildTurn({ ...opts, meta: resume ? { sessions: { codex: 'sid' }, models: { codex: opts.model } } : {}, rows: [], text: 'hello', basePrompt: launchLib.CONTEXT_RULE, policy: 'POLICY' });
    hasSettings(turn.args);
    assert.strictEqual(turn.resume, resume);
    assert.ok(turn.args.includes('gpt-6.1-sol'));
    assert.ok(turn.args.includes('model_reasoning_effort=high'));
    assert.strictEqual(turn.stdin.split(launchLib.CONTEXT_RULE).length - 1, 1);
  }
  const claude = chatLib.buildTurn({ ai: 'claude', model: 'Fable 5.1', meta: { sessions: { claude: 'sid' } }, rows: [], text: 'hello', policy: 'POLICY' });
  assert.ok(claude.args.includes('--resume'));
  assert.ok(!claude.args.some(x => x.includes('auto_compact')));
  assert.ok(claude.stdin.includes(launchLib.CONTEXT_RULE));
});

test('各AIの最初と継続の番にCLI引数と一致する起動設定を渡す', () => {
  for (const [ai, model, label, flag] of [
    ['codex', 'GPT-6.1-Sol', 'GPT-6.1-Sol', 'gpt-6.1-sol'],
    ['codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'gpt-6.1-sol'],
    ['claude', 'claude-fable-5-1', 'Fable 5.1', 'claude-fable-5-1'],
    ['agy', 'gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)', 'gemini-3.1-pro-high'],
  ]) for (const resumed of [false, true]) {
    const turn = chatLib.buildTurn({ ai, model, meta: resumed ? { sessions: { [ai]: 'sid' }, models: { [ai]: model } } : {}, rows: [], text: '依頼', basePrompt: 'BASE', policy: 'POLICY' });
    const input = ai === 'agy' ? turn.args.find(a => a.startsWith('--print=')).slice(8) : turn.stdin;
    const line = input.split('\n').find(l => l.startsWith('【この番の起動】'));
    assert.equal(turn.args[turn.args.indexOf('--model') + 1], flag);
    assert.ok(line.includes(`${launchLib.AI_LABEL[ai]}・${label}（CLI 引数 --model ${flag}）`));
    assert.match(line, /実際に応答したモデルの証明ではない/);
    assert.match(line, /起動設定が依頼の指定と一致している場合/);
    assert.match(line, /自分で証明できないことだけを理由に停止しない/);
    assert.equal(input.split('【この番の起動】').length - 1, 1);
    assert.equal(turn.resume, resumed);
  }
});

test('モデルを指定しない起動は既定と明記し、指定モデルを証明したと案内しない', () => {
  const old = structuredClone(launchLib.getOverrides());
  try {
    launchLib.setOverrides({ codex: { 'GPT-6.1-Sol': '' } });
    for (const model of ['', 'GPT-6.1-Sol']) {
      const turn = chatLib.buildTurn({ ai: 'codex', model, meta: {}, rows: [], text: '依頼' });
      assert.ok(!turn.args.includes('--model'));
      const line = turn.stdin.split('\n').find(l => l.startsWith('【この番の起動】'));
      assert.match(line, /Codex・モデル指定なし（CLI の既定）/);
      assert.doesNotMatch(line, /GPT-6.1-Sol|--model/);
    }
  } finally { launchLib.setOverrides(old); }
});

test('引き継ぎの会話を6万文字に抑え、直近の依頼と省略の表示を保つ', () => {
  const rows = [{ role: 'user', text: 'x'.repeat(70000) }, { role: 'user', text: '最新の依頼' }];
  const packet = chatLib.contextPacket(rows);
  const body = packet.split('<previous_conversation>\n')[1].split('\n</previous_conversation>')[0];
  assert.strictEqual(body.length, 60000);
  assert.match(packet, /文字を省いた/);
  assert.ok(body.endsWith('最新の依頼'));
  assert.strictEqual(rows[0].text.length, 70000); // 元の会話記録は変更しない
});

test('台帳の先頭部分を読める', () => {
  const { data, body } = parseDoc(fs.readFileSync(path.join(HUB, 'seed', 'サンプルアプリ', 'PROJECT.md'), 'utf8'));
  assert.strictEqual(data.name, 'サンプルアプリ');
  assert.strictEqual(data.phases[0].role, 'コーディング');
  assert.strictEqual(data.folders['作業用コピー'], '~/Documents/AI-Workspace/Work/サンプルアプリ');
  assert.deepStrictEqual(data.related, ['サンプルサイト', 'サンプル文書']);
  assert.strictEqual(data.issues[0].level, '低');
  assert.match(body, /# メモ/);
});

test('空の値・コメント・URL を正しく扱う', () => {
  const d = parseYaml('a:\nb: []\nc: {}\nd: 値 # コメント\ne: http://x.y/#z\nf: "a # b"');
  assert.strictEqual(d.a, '');
  assert.deepStrictEqual(d.b, []);
  assert.deepStrictEqual(d.c, {});
  assert.strictEqual(d.d, '値');
  assert.strictEqual(d.e, 'http://x.y/#z');
  assert.strictEqual(d.f, 'a # b');
});

test('1行だけ書き換え、コメントを残す', () => {
  const t = '---\nstate: 実行中           # 説明\nquestion:\n---\n本文\n';
  const out = setScalar(setScalar(t, 'state', '完了'), 'question', '改行\nなし $1');
  assert.match(out, /^state: 完了\s+# 説明$/m);
  assert.match(out, /^question: 改行 なし \$1$/m);
  assert.match(out, /本文/);
});

test('起動コマンドは場所と指示を安全に囲む', () => {
  const c = buildCommand({ ai: 'claude', dir: "/a/サンプルアプリ/it's", prompt: 'x; rm -rf ~' });
  assert.strictEqual(c, "cd '/a/サンプルアプリ/it'\\''s' && 'claude' '--permission-mode' 'acceptEdits' 'x; rm -rf ~'");
  assert.throws(() => buildCommand({ ai: 'evil', dir: '/', prompt: '' }));
});

// ここから: 仮の AI-Workspace を作ってサーバーを動かす
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
const ROOT = path.join(tmp, 'AI-Workspace');
const PORT = 45000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

// seed の見本パスが利用者の環境に存在しても、テスト用台帳だけを隔離する。
// 元のseedは書き換えず、利用者のフォルダやAI設定の有無に依存させない。
function isolateSeedFolders(root) {
  for (const name of fs.readdirSync(path.join(root, 'Product'))) {
    const file = path.join(root, 'Product', name, 'PROJECT.md');
    const text = fs.readFileSync(file, 'utf8');
    let i = 0;
    fs.writeFileSync(file, text.replace(/^(  [^\n:]+:\s*)~\/[^\n]*$/gm,
      (line, label) => label + path.join(root, 'missing-source', name, String(++i))));
  }
}

test('setup.sh で台帳が作られ、2回目は触らない', () => {
  const env = { ...process.env, HUB_ROOT: ROOT, HOME: tmp, HUB_SKIP_NPM: '1' };
  execFileSync('bash', [path.join(HUB, 'setup.sh')], { env });
  for (const n of ['Project Hub', 'サンプルアプリ', 'サンプルサイト', 'サンプル文書']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, 'PROJECT.md')), n);
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, '.ai', 'rules.md')), n + ' rules');
    assert.ok(fs.existsSync(path.join(ROOT, 'Product', n, 'CLAUDE.md')), n + ' CLAUDE');
  }
  assert.ok(fs.existsSync(path.join(ROOT, '_hub', 'roles.yaml')));
  const f = path.join(ROOT, 'Product', 'サンプルアプリ', 'PROJECT.md');
  fs.appendFileSync(f, '\n手で足した行\n');
  const out = execFileSync('bash', [path.join(HUB, 'setup.sh')], { env }).toString();
  assert.match(out, /そのまま: サンプルアプリ/);
  assert.match(fs.readFileSync(f, 'utf8'), /手で足した行/);
  isolateSeedFolders(ROOT);
});

let server;
test('サーバーを起動', async () => {
  process.env.HUB_ROOT = ROOT;
  process.env.HUB_PORT = String(PORT);
  process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp, 'ai-home');
  ({ server } = require('../server'));
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
});

const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1', ...headers }, body: JSON.stringify(body) });

test('一覧に4つのプロジェクトと作業が出る', async () => {
  const s = await (await fetch(BASE + '/api/state')).json();
  assert.strictEqual(s.projects.length, 4);
  const h = s.projects.find(p => p.id === 'サンプルアプリ');
  assert.strictEqual(h.tasks[0].state, '返事待ち');
  assert.match(h.tasks[0].question, /プレビュー/);
  assert.strictEqual(s.roles.roles.find(r => r.name === 'コーディング').main.ai, 'codex');
});

test('続きをやる: 作業場所が無ければ台帳のフォルダで起動', async () => {
  const r = await (await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.dir, path.join(ROOT, 'Product', 'サンプルアプリ'));
  assert.match(r.command, /^cd '.*サンプルアプリ' && 'codex' '--sandbox' 'workspace-write' /);
  assert.match(r.command, /'【モデルの決まり.*作業ID sample-app-01/s);
  assert.ok(r.command.includes(launchLib.CONTEXT_RULE));
  assert.match(r.command, /【この番の起動】[^\n]*Codex・GPT-6.1-Sol（CLI 引数 --model gpt-6.1-sol）/);
  assert.match(r.command, /［会話］に切り替えて、記録した依頼を送ってください/);
  assert.match(r.command, /ターミナルを止める操作は頼まない/);
  assert.doesNotMatch(r.command, /ターミナルのAIを終了/);
  assert.strictEqual(r.r.file, 'osascript');
});

test('続きをやる: 作業場所があればそこで起動', async () => {
  const wd = path.join(ROOT, 'Work', 'サンプルアプリ', 'sample-app-01');
  fs.mkdirSync(wd, { recursive: true });
  const f = path.join(ROOT, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'sample-app-01.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^workdir:.*$/m, `workdir: ${wd}`));
  const r = await (await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' })).json();
  assert.strictEqual(r.dir, wd);
});

test('状態・メモ・返事済み', async () => {
  const k = { project: 'サンプルサイト', task: 'sample-site-01' };
  let t = await (await post('/api/task', { ...k, state: '返事待ち', question: '2本を確認して' })).json();
  assert.strictEqual(t.state, '返事待ち');
  t = await (await post('/api/task', { ...k, memo: 'Discord に依頼した' })).json();
  assert.match(t.memo, /Discord に依頼した/);
  t = await (await post('/api/task', { ...k, question: '', state: '実行中' })).json();
  assert.strictEqual(t.question, '');
  assert.strictEqual(t.state, '実行中');
});

test('作業を足す', async () => {
  const t = await (await post('/api/task/new', { project: 'Project Hub', title: '第2版の設計', owner: 'claude-code', next: 'Discord とつなぐ' })).json();
  assert.match(t.id, /^\d{8}-01$/);
  assert.strictEqual(t.next, 'Discord とつなぐ');
  assert.strictEqual((await post('/api/task/new', { project: 'Project Hub', title: ' ' })).status, 400);
});

test('フォルダを開く: 台帳にある場所だけ', async () => {
  const r = await post('/api/open', { project: 'サンプルアプリ', kind: 'project' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await post('/api/open', { project: 'サンプルアプリ', kind: 'folder', label: '本体' })).status, 404);
});

test('守り: 他サイトからの操作・おかしな名前・外のファイルは拒否', async () => {
  assert.strictEqual((await post('/api/task', { project: 'サンプルサイト', task: 'sample-site-01', state: '完了' }, { 'X-Hub': '' })).status, 403);
  assert.strictEqual((await post('/api/continue', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await post('/api/continue', { project: '../..', task: 'x', ai: 'claude' })).status, 400);
  assert.strictEqual((await post('/api/task', { project: 'サンプルアプリ', task: '../../PROJECT', state: 'x' })).status, 400);
  assert.strictEqual((await post('/api/task', { project: 'サンプルアプリ', task: '_template', state: 'x' })).status, 400);
  const trav = await fetch(BASE + '/%2e%2e/server.js');
  assert.notStrictEqual(trav.status, 200);
  assert.doesNotMatch(await trav.text(), /createServer/);
  const code = await new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.strictEqual(code, 403);
});

test('画面が返る', async () => {
  const r = await fetch(BASE + '/');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Project Hub/);
});

test('後片付け', () => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 第2版: 作業画面・設定 ----
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub2-'));
const ROOT2 = path.join(tmp2, 'AI-Workspace');
const PORT2 = 46000 + Math.floor(Math.random() * 1000);
const BASE2 = `http://127.0.0.1:${PORT2}`;
const post2 = (p, body) => fetch(BASE2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) });
let server2, sessions2;

test('第2版: 準備して起動（実際に AI は動かさず、代わりに bash を使う）', async () => {
  execFileSync('bash', [path.join(HUB, 'setup.sh')], { env: { ...process.env, HUB_ROOT: ROOT2, HOME: tmp2, HUB_SKIP_NPM: '1' } });
  isolateSeedFolders(ROOT2);
  // HUB_DRY_RUN=1 なので本物の claude / codex は起動しない（コマンドの組み立てだけ確かめる）
  delete require.cache[require.resolve('../server')];
  process.env.HUB_ROOT = ROOT2; process.env.HUB_PORT = String(PORT2); process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp2, 'ai-home');
  process.env.HUB_TRASH = path.join(tmp2,'fixture-trash');
  ({ server: server2, sessions: sessions2 } = require('../server'));
  await new Promise(r => server2.listen(PORT2, '127.0.0.1', r));
});

test('利用状況APIはdryモードでCLIを呼ばず、更新は画面からの操作だけ許可する', async () => {
  assert.strictEqual((await fetch(BASE2+'/api/usage')).status,403);
  assert.strictEqual((await fetch(BASE2+'/api/usage',{headers:{'X-Hub':'1','Origin':'https://evil.example'}})).status,403);
  const r=await fetch(BASE2+'/api/usage',{headers:{'X-Hub':'1'}}); assert.strictEqual(r.status,200);
  const data=await r.json();
  assert.deepStrictEqual(Object.keys(data.providers).sort(),['claude','codex']);
  for(const p of Object.values(data.providers)) { assert.strictEqual(p.status,'unavailable'); assert.deepStrictEqual(p.windows,[]); assert.match(p.message,/テスト中/); }
  assert.strictEqual((await fetch(BASE2+'/api/usage/refresh',{method:'POST'})).status,403);
  assert.strictEqual((await fetch(BASE2+'/api/usage/refresh',{method:'POST',headers:{'X-Hub':'1','Origin':'https://evil.example'}})).status,403);
  const manual=await post2('/api/usage/refresh',{}); assert.strictEqual(manual.status,200);
  const html=await (await fetch(BASE2+'/')).text(); assert.match(html,/id="usage-toggle"/); assert.match(html,/<script src="usage.js">/);
  assert.strictEqual((await fetch(BASE2+'/usage.js')).status,200);
});

test('モデルと思考は役割から決まり、作業ファイルの指定が優先される', async () => {
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.ok(Array.isArray(st.roles.roles) && st.roles.roles.length === 8);
  assert.deepStrictEqual(st.efforts, ['中', '高', '極高', 'MAX', 'Ultra']);
  // サンプルアプリ の作業は role: コーディング → codex GPT-6.1-Sol・高
  let r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, 'GPT-6.1-Sol'); assert.strictEqual(r.effort, '高');
  assert.match(r.args.join('\n'), /【この番の起動】[^\n]*Codex・GPT-6.1-Sol（CLI 引数 --model gpt-6.1-sol）/);
  assert.match(r.args.join('\n'), /［会話］に切り替えて、記録した依頼を送ってください/);
  assert.match(r.args.join('\n'), /ターミナルを止める操作は頼まない/);
  assert.doesNotMatch(r.args.join('\n'), /ターミナルのAIを終了/);
  assert.strictEqual(r.command, 'codex');
  assert.ok(r.args.includes('--model') && r.args.includes('gpt-6.1-sol') && r.args.includes('model_reasoning_effort=high'));
  // claude で開くと backup（claude-code Opus 5.5・高）
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'claude' })).json();
  assert.strictEqual(r.model, 'Opus 5.5'); assert.strictEqual(r.command, 'claude');
  assert.ok(r.args.includes('--effort') && r.args.includes('high'));
  // 作業ファイルで上書き
  await post2('/api/task', { project: 'サンプルアプリ', task: 'sample-app-01', model: '6luna', effort: 'Ultra' });
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, '6luna'); assert.strictEqual(r.effort, 'Ultra');
  // 空に戻すと役割どおり
  await post2('/api/task', { project: 'サンプルアプリ', task: 'sample-app-01', model: '', effort: '' });
  r = await (await post2('/api/term/start', { project: 'サンプルアプリ', task: 'sample-app-01', ai: 'codex' })).json();
  assert.strictEqual(r.model, 'GPT-6.1-Sol');
});

test('役割分担を画面から保存でき、おかしな値は拒否', async () => {
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const rs = JSON.parse(JSON.stringify(st.roles.roles));
  const bun = rs.find(x => x.name === '文章');
  bun.main.model = 'Fable 5.1'; bun.main.effort = 'MAX';
  const saved = await (await post2('/api/roles', { roles: rs })).json();
  assert.strictEqual(saved.roles.find(x => x.name === '文章').main.model, 'Fable 5.1');
  const text = fs.readFileSync(path.join(ROOT2, '_hub', 'roles.yaml'), 'utf8');
  assert.match(text, /文章: \{ main: \[claude-code, Fable 5\.1, MAX\]/);
  assert.match(text, /# 文章は Opus 5\.5/); // コメント行は残る
  assert.match(text, /permissions:/);
  bun.main.model = 'Astra';
  const bad = await post2('/api/roles', { roles: rs });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /Astra/);
});

test('作業画面: 本物の端末を開き、入力と出力が通る', async ctx => {
  if (!sessions2.available()) { console.log('node-pty なし: 省略'); return; }
  ctx.after(() => sessions2.stopAll());
  const s = sessions2.start({ project: 'サンプルアプリ', task: 'pty-test', ai: 'claude', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 80, rows: 24 });
  // 同じ作業にもう1つ（codex 役）を並べられる
  sessions2.start({ project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 80, rows: 24 });
  assert.strictEqual(sessions2.list().length, 2);
  const got = [];
  const off = sessions2.watch('サンプルアプリ', 'pty-test', 'claude', ev => got.push(ev));
  ctx.after(off);
  await waitFor(() => ['claude', 'codex'].every(ai => sessions2.get('サンプルアプリ', 'pty-test', ai).buf.includes('test> ')), 'both PTY shell prompts');
  assert.ok(sessions2.write('サンプルアプリ', 'pty-test', 'claude', 'echo HELLO-$((1+2))\r'));
  await waitFor(() => got.some(e => e.type === 'data') && got.map(e => e.data || '').join('').includes('HELLO-3'), 'PTY command output');
  const text = got.filter(e => e.type === 'data').map(e => e.data).join('');
  assert.match(text, /HELLO-3/);
  assert.ok(sessions2.resize('サンプルアプリ', 'pty-test', 'claude', 120, 40));
  // 相手に渡す：codex 側の画面に文字が届く
  const got2 = [];
  const off2 = sessions2.watch('サンプルアプリ', 'pty-test', 'codex', ev => got2.push(ev));
  ctx.after(off2);
  const hp = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'pty-test.md');
  fs.writeFileSync(hp, '---\nid: pty-test\ntitle: t\nstate: 実行中\n---\n');
  // 相手が作業中（画面が動いている）なら断る
  assert.strictEqual((await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' })).status, 409);
  sessions2.get('サンプルアプリ', 'pty-test', 'codex').lastOut = 0;
  const ho = await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' });
  assert.strictEqual(ho.status, 200);
  const hj = await ho.json();
  assert.strictEqual(hj.kind, 'screen'); // bash なので会話の記録は無く、画面の文字で代わりにする
  assert.match(fs.readFileSync(hj.packet, 'utf8'), /HELLO-3/);
  assert.match(fs.readFileSync(hj.packet, 'utf8'), /新しい実行の許可ではない/);
  await waitFor(() => got2.map(e => e.data || '').join('').includes('Claude Code から交代') && atShellPrompt(sessions2.get('サンプルアプリ', 'pty-test', 'codex')), 'PTY handoff input and the next shell prompt');
  assert.match(got2.filter(e => e.type === 'data').map(e => e.data).join(''), /Claude Code から交代/);
  // モデル・思考を変える：作業ファイルに残り、動いている AI に /model・/effort が届く
  await post2('/api/cli-models', { claude: {}, codex: { '6terra': '6terra' } });
  const sw = await (await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'model', value: '6terra' })).json();
  assert.deepStrictEqual([sw.sent, sw.command, sw.model], [true, '/model 6terra', '6terra']);
  await waitFor(() => got2.map(e => e.data || '').join('').includes('/model 6terra') && atShellPrompt(sessions2.get('サンプルアプリ', 'pty-test', 'codex')), 'PTY model input and the next shell prompt');
  const sw2 = await (await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'effort', value: 'MAX' })).json();
  assert.strictEqual(sw2.command, '/effort max');
  await waitFor(() => ['/model 6terra', '/effort max'].every(command => got2.map(e => e.data || '').join('').includes(command)) && atShellPrompt(sessions2.get('サンプルアプリ', 'pty-test', 'codex')), 'PTY model and effort input and the next shell prompt');
  const out2 = got2.filter(e => e.type === 'data').map(e => e.data).join('');
  assert.match(out2, /\/model 6terra/);
  assert.match(out2, /\/effort max/);
  assert.match(fs.readFileSync(hp, 'utf8'), /model: 6terra/);
  assert.strictEqual((await post2('/api/term/switch', { project: 'サンプルアプリ', task: 'pty-test', ai: 'codex', field: 'rm', value: 'x' })).status, 400);
  off2();
  off();
  // ストリームで読める
  const ac = new AbortController();
  ctx.after(() => ac.abort());
  const r = await fetch(`${BASE2}/api/term/stream?project=${encodeURIComponent('サンプルアプリ')}&task=pty-test&ai=claude`, { signal: ac.signal });
  const reader = r.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /HELLO-3/);
  ac.abort();
  assert.ok(sessions2.stop('サンプルアプリ', 'pty-test', 'claude'));
  assert.ok(sessions2.stop('サンプルアプリ', 'pty-test', 'codex'));
  assert.strictEqual(sessions2.list().length, 0);
  assert.strictEqual((await post2('/api/term/input', { project: 'サンプルアプリ', task: 'pty-test', ai: 'claude', data: 'x' })).status, 404);
  // 相手が動いていなければ、役割どおりに始める（テストでは組み立てだけ）
  const dj = await (await post2('/api/term/handoff', { project: 'サンプルアプリ', task: 'pty-test', to: 'codex' })).json();
  assert.strictEqual(dj.dry, true);
  assert.match(dj.args.join(' '), /から交代です/);
  const modelFlag = dj.args[dj.args.indexOf('--model') + 1];
  const startupLine = dj.args.join('\n').split('\n').find(l => l.startsWith('【この番の起動】'));
  assert.ok(startupLine.includes(`CLI 引数 --model ${modelFlag}`));
  assert.match(dj.args.join('\n'), /［会話］に切り替えて、記録した依頼を送ってください/);
  assert.match(dj.args.join('\n'), /ターミナルを止める操作は頼まない/);
  assert.doesNotMatch(dj.args.join('\n'), /ターミナルのAIを終了/);
});

test('担当と進み具合：手順・フェーズ・エージェント', async () => {
  const t = await (await post2('/api/task/new', { project: 'サンプルサイト', title: '紹介文の下書き', owner: 'discord:サンプル担当', via: '#サンプル作業', phase: '紹介文', steps: '題材\n下書き\n\n投稿' })).json();
  assert.deepStrictEqual(t.steps.map(x => x.text), ['題材', '下書き', '投稿']);
  assert.deepStrictEqual([t.owner, t.via, t.phase], ['discord:サンプル担当', '#サンプル作業', '紹介文']);
  let r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 0, done: true })).json();
  assert.strictEqual(r.steps[0].done, true);
  r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, add: 'チェック' })).json();
  assert.strictEqual(r.steps.length, 4);
  for (const i of [1, 2, 3]) r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: i, done: true })).json();
  assert.strictEqual(r.state, '未着手'); assert.strictEqual(r.completionPending, true); // 人の確認待ち
  r = await (await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 3, done: false })).json();
  assert.strictEqual(r.state, '未着手'); // 状態は人の判断まで維持
  assert.strictEqual((await post2('/api/task/step', { project: 'サンプルサイト', task: t.id, index: 9, done: true })).status, 400);
  // 次のフェーズへ：今のフェーズを完了に、次を進行中に（コメントは残る）
  const before = (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === 'サンプルサイト').phases;
  const cur = before.findIndex(ph => ph.state !== '完了');
  const n = await (await post2('/api/phase/next', { project: 'サンプルサイト', confirm: true, expectedHash: (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === 'サンプルサイト').completionHash })).json();
  assert.strictEqual(n.phases[cur].state, '完了');
  if (n.phases[cur + 1]) assert.strictEqual(n.phases[cur + 1].state, '進行中');
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual(st.roles.agents, ['サンプル担当']);
  // 操作の記録
  const log = await (await fetch(BASE2 + '/api/log?n=5')).json();
  assert.ok(log.some(r => r.action === 'nextphase' && r.project === 'サンプルサイト'));
  assert.ok(log.some(r => r.action === 'newtask'));
  assert.ok(Array.isArray(await (await fetch(BASE2 + '/api/sessions')).json()));
});

test('分岐：作業に分岐元を持たせられ、台帳の説明も読める', async () => {
  const t = await (await post2('/api/task/new', { project: 'サンプルアプリ', title: '文言だけ直す', owner: 'codex', parent: 'sample-app-01' })).json();
  assert.strictEqual(t.parent, 'sample-app-01');
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const h = st.projects.find(p => p.id === 'サンプルアプリ');
  assert.ok(h.tasks.some(x => x.parent === 'sample-app-01'));
  assert.strictEqual(typeof h.notes, 'string');
});

test('取り込み対象から外す・戻す：本体・コピー・再開先・作業状態を保ち、除外中の取り込みを拒否', async () => {
  const gitw = require('../lib/git');
  const { Store } = require('../lib/store');
  const main = path.join(tmp2, 'exclusion-code');
  fs.mkdirSync(main);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { env }).toString().trim();
  git('init', '-q');
  fs.writeFileSync(path.join(main, 'a.txt'), 'current\n');
  git('add', '-A'); git('commit', '-q', '-m', 'initial');
  const r = gitw.prepare({ base: main, workRoot: path.join(ROOT2, 'Work', 'サンプルアプリ'), taskId: 'exclusion-test' });
  const copy = path.join(r.dir, 'draft.txt');
  fs.writeFileSync(copy, 'keep draft\n');
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'exclusion-test.md');
  fs.writeFileSync(tf, `---\nid: exclusion-test\ntitle: 除外の確認\nstate: 返事待ち\nquestion: 元の質問\nworkdir: ${r.dir}\n---\n## 手順\n- [x] 元の手順\n`);
  const key = { project: 'サンプルアプリ', task: 'exclusion-test' };
  const mainHead = git('rev-parse', 'HEAD');
  const copyHead = execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD']).toString();
  const readState = async () => (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === key.project);
  const before = await readState();
  assert.strictEqual(before.tasks.find(t => t.id === key.task).mergeExcluded, false); // 既存作業は既定で対象
  for (const excluded of [undefined, 'true', 1, null]) {
    assert.strictEqual((await post2('/api/task/merge-exclusion', { ...key, excluded })).status, 400);
  }
  const res = await post2('/api/task/merge-exclusion', { ...key, excluded: true });
  assert.strictEqual(res.status, 200);
  const task = (await res.json()).task;
  assert.strictEqual(task.mergeExcluded, true);
  assert.strictEqual(task.workdir, r.dir);
  assert.strictEqual(task.state, '返事待ち');
  assert.strictEqual(task.question, '元の質問');
  assert.deepStrictEqual(task.steps, [{ text: '元の手順', done: true }]);
  assert.strictEqual(new Store(ROOT2).readTask(tf).mergeExcluded, true); // 新しいStoreでも永続化済み
  const after = await readState();
  assert.strictEqual(after.copies, before.copies);
  assert.strictEqual(after.tasks.find(t => t.id === key.task).copy, true);
  const contents = fs.readFileSync(tf, 'utf8');
  assert.strictEqual((await post2('/api/task/merge-exclusion', { ...key, excluded: true })).status, 200);
  assert.strictEqual(fs.readFileSync(tf, 'utf8'), contents); // 同じ操作を重ねても記録を増やさない
  const denied = await post2('/api/task/merge', key);
  assert.strictEqual(denied.status, 409);
  assert.match((await denied.json()).error, /取り込み対象から外/);
  const continued = await (await post2('/api/continue', { ...key, ai: 'codex' })).json();
  assert.strictEqual(continued.dir, r.dir); // 除外後も同じ場所から再開
  assert.strictEqual(git('rev-parse', 'HEAD'), mainHead);
  assert.strictEqual(execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD']).toString(), copyHead);
  assert.strictEqual(fs.readFileSync(copy, 'utf8'), 'keep draft\n');
  assert.strictEqual(fs.existsSync(path.join(main, 'draft.txt')), false);
  const restored = await (await post2('/api/task/merge-exclusion', { ...key, excluded: false })).json();
  assert.strictEqual(restored.task.mergeExcluded, false);
  assert.strictEqual(restored.task.workdir, r.dir);
  assert.strictEqual(restored.task.state, '返事待ち');
  assert.strictEqual(new Store(ROOT2).readTask(tf).mergeExcluded, false);
  assert.strictEqual((await post2('/api/task/merge-exclusion', { ...key, task: 'missing', excluded: true })).status, 400);
  assert.strictEqual((await post2('/api/task/merge-exclusion', { ...key, task: '../exclusion-test', excluded: true })).status, 400);
  assert.strictEqual((await fetch(BASE2 + '/api/task/merge-exclusion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...key, excluded: true }) })).status, 403);
  const noCopy = path.join(ROOT2, 'Product', key.project, '.ai', 'tasks', 'no-copy.md');
  fs.writeFileSync(noCopy, `---\nworkdir: ${main}\n---\n`);
  assert.strictEqual((await post2('/api/task/merge-exclusion', { ...key, task: 'no-copy', excluded: true })).status, 400);
  const logs = await (await fetch(BASE2 + '/api/log?n=50')).json();
  assert.strictEqual(logs.filter(l => l.task === key.task && l.action === 'mergeexclude').length, 1);
  assert.strictEqual(logs.filter(l => l.task === key.task && l.action === 'mergeinclude').length, 1);
  process.env.HUB_TRASH = path.join(tmp2, 'Trash');
  const merged = await post2('/api/task/merge', key);
  assert.strictEqual(merged.status, 200, JSON.stringify(await merged.json()));
  assert.strictEqual(fs.readFileSync(path.join(main, 'draft.txt'), 'utf8'), 'keep draft\n');
  assert.strictEqual(fs.existsSync(r.dir), false);
});

test('本体に取り込む：作業用コピーを取り込み、作業を完了にする。AI が動いている間は断る', async () => {
  const gitw = require('../lib/git');
  process.env.HUB_TRASH = path.join(tmp2, 'Trash');
  const main = path.join(tmp2, 'code');
  fs.mkdirSync(main);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', main, 'init', '-q'], { env });
  fs.writeFileSync(path.join(main, 'a.txt'), '1\n');
  execFileSync('git', ['-C', main, 'add', '-A'], { env }); execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'i'], { env });
  const wr = path.join(ROOT2, 'Work', 'サンプルアプリ');
  const r = gitw.prepare({ base: main, workRoot: wr, taskId: 'merge-test' });
  fs.writeFileSync(path.join(r.dir, 'c.txt'), 'done\n');
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'merge-test.md');
  fs.writeFileSync(tf, `---\nid: merge-test\ntitle: 取り込みの確認\nstate: 実行中\nworkdir: ${r.dir}\n---\n`);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const h = st.projects.find(p => p.id === 'サンプルアプリ');
  assert.ok(h.copies >= 1);
  assert.strictEqual(h.tasks.find(t => t.id === 'merge-test').copy, true);
  // AI が動いている間は取り込まない
  if (sessions2.available()) {
    sessions2.start({ project: 'サンプルアプリ', task: 'merge-test', ai: 'codex', dir: r.dir, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc'], cols: 80, rows: 24 });
    assert.strictEqual((await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' })).status, 409);
    sessions2.stop('サンプルアプリ', 'merge-test', 'codex');
  }
  const res = await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' });
  const j = await res.json();
  assert.strictEqual(res.status, 200, j.error);
  assert.strictEqual(fs.readFileSync(path.join(main, 'c.txt'), 'utf8'), 'done\n');
  assert.strictEqual(j.task.state, '完了確認待ち');
  assert.strictEqual(j.task.workdir, '');
  assert.ok(!fs.existsSync(r.dir));
  // 作業用コピーの無い作業は断る
  assert.strictEqual((await post2('/api/task/merge', { project: 'サンプルアプリ', task: 'merge-test' })).status, 400);
});


test('PTY の準備を待ち、検証が失敗してもテストの端末と監視を片付ける', async () => {
  const { Sessions } = require('../lib/sessions');
  const sessions = new Sessions();
  if (!sessions.available()) return;
  const failure = new Error('fixture assertion failure');
  let fixture;
  await assert.rejects(withPtyFixture(sessions, {
    project: 'fixture', task: 'cleanup', ai: 'codex', dir: ROOT2,
    command: '/bin/bash', env: SHELL_ENV,
    // Deliberately start after the old 400ms wait to exercise runner startup delay.
    args: ['--noprofile', '--norc', '-c', 'sleep 0.6; PS1="test> " exec /bin/bash --noprofile --norc -i'], cols: 80, rows: 24
  }, async ({ session }) => {
    fixture = session;
    await waitFor(() => session.buf.includes('test> '), 'delayed PTY shell prompt');
    throw failure;
  }), error => error === failure);
  assert.strictEqual(sessions.get('fixture', 'cleanup', 'codex'), null);
  assert.strictEqual(fixture.watchers.size, 0);
  await waitFor(() => fixture.exited, 'failed fixture PTY exit');
});

test('ファイルを渡す：Inbox に保存し、作業ファイルに記録し、動いている AI の入力欄に場所を入れる', async () => {
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'up-test.md');
  fs.writeFileSync(tf, '---\nid: up-test\ntitle: 渡す\nstate: 実行中\n---\n');
  const up = (q, body) => fetch(`${BASE2}/api/task/upload?${new URLSearchParams(q)}`, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream' }, body });
  // AI が動いていない時は保存と記録だけ。名前の「../」などは消す
  let j = await (await up({ project: 'サンプルアプリ', task: 'up-test', ai: 'codex', name: '../../evil name.png' }, Buffer.from('PNG'))).json();
  assert.strictEqual(j.typed, false);
  assert.ok(j.path.startsWith(path.join(ROOT2, 'Inbox', 'hub')));
  assert.match(path.basename(j.path), /^\d{6}-evil_name\.png$/);
  assert.strictEqual(fs.readFileSync(j.path, 'utf8'), 'PNG');
  assert.ok(fs.readFileSync(tf, 'utf8').includes(`ファイルを渡した: ${j.path}`));
  if (sessions2.available()) {
    // Keep the file name intact even when the runner's temporary path is long.
    await withPtyFixture(sessions2, { project: 'サンプルアプリ', task: 'up-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc', '-i'], cols: 512, rows: 24 }, async ({ session, got }) => {
      await waitFor(() => session.buf.includes('test> '), 'upload PTY shell prompt');
      j = await (await up({ project: 'サンプルアプリ', task: 'up-test', ai: 'codex', name: 'shot.png' }, Buffer.from('x'))).json();
      assert.strictEqual(j.typed, true);
      await waitFor(() => got.map(e => e.data || '').join('').includes(path.basename(j.path)), 'uploaded file path in the PTY');
      assert.ok(got.map(e => e.data || '').join('').includes(path.basename(j.path)));
    });
    assert.strictEqual(sessions2.get('サンプルアプリ', 'up-test', 'codex'), null);
  }
  // 無い作業・CSRF の印なしは断る
  assert.strictEqual((await up({ project: 'サンプルアプリ', task: 'nai', name: 'a' }, Buffer.from('x'))).status, 400);
  const noHeader = await fetch(`${BASE2}/api/task/upload?project=%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB%E3%82%A2%E3%83%97%E3%83%AA&task=up-test&name=a`, { method: 'POST', body: Buffer.from('x') });
  assert.strictEqual(noHeader.status, 403);
});

test('会話画面：送るたびに AI を選べ、変えた時は見ていない会話を引き継ぐ。同じ AI は続きから', async () => {
  // 本物の代わりの claude / codex（受け取った依頼と引数を、そのまま返事にする）
  const bin = path.join(tmp2, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const js = (code) => `#!/usr/bin/env node\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const a=process.argv.slice(2).join(' ');${code}});\n`;
  fs.writeFileSync(path.join(bin, 'claude'), js(`const o=x=>console.log(JSON.stringify(x));o({type:'system',subtype:'init',session_id:'S-claude'});o({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'npm test'}},{type:'text',text:'GOT['+i+'] ARGS['+a+']'}]}});o({type:'result',is_error:false,result:'x',session_id:'S-claude'});`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), js(`const o=x=>console.log(JSON.stringify(x));o({type:'thread.started',thread_id:'T-codex'});o({type:'item.completed',item:{type:'command_execution',command:'ls'}});o({type:'item.completed',item:{type:'agent_message',text:'CODEX['+i+'] ARGS['+a+']'}});o({type:'turn.completed'});`), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'chat-test.md');
  fs.writeFileSync(tf, '---\nid: chat-test\ntitle: 会話\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'chat-test');
  const waitReply = async n => { for (let i = 0; i < 100 && rows().filter(r => r.role === 'assistant').length < n; i++) await new Promise(r => setTimeout(r, 50)); };
  const say = (ai, model, text) => post2('/api/chat/send', { project: 'サンプルアプリ', task: 'chat-test', ai, model, effort: '高', text });
  try {
    assert.strictEqual((await say('claude', 'Opus 5.5', 'はじめまして')).status, 200);
    assert.strictEqual((await say('claude', 'Opus 5.5', '二重')).status, 409); // 返事の途中は送れない
    await waitReply(1);
    let a = rows().filter(r => r.role === 'assistant');
    assert.match(a[0].text, /GOT\[.*はじめまして/s);
    assert.match(a[0].text, /-p --output-format stream-json --verbose --model claude-opus-5-5 --effort high/);
    assert.doesNotMatch(a[0].text, /--resume/);
    assert.ok(rows().some(r => r.role === 'event' && r.text === 'Bash：npm test'));
    // Codex に変える → 前の会話（人の依頼と Claude の返事）を引き継ぐ
    await say('codex', '6sol', 'つづきをお願い');
    await waitReply(2);
    a = rows().filter(r => r.role === 'assistant');
    assert.strictEqual(a[1].ai, 'codex');
    assert.match(a[1].text, /<previous_conversation>[\s\S]*はじめまして[\s\S]*<\/previous_conversation>[\s\S]*つづきをお願い/);
    assert.match(a[1].text, /ARGS\[exec --sandbox workspace-write -c sandbox_workspace_write\.writable_roots=\[\](?: --add-dir [^\]]+)? --json --skip-git-repo-check -c model_auto_compact_token_limit=160000 -c model_auto_compact_token_limit_scope="total" --model gpt-6-sol -c model_reasoning_effort=high -\]/);
    // Claude に戻す → 自分の会話の続き（--resume）。見ていないのは Codex とのやり取りだけ
    await say('claude', 'Opus 5.5', 'まとめて');
    await waitReply(3);
    a = rows().filter(r => r.role === 'assistant');
    assert.match(a[2].text, /--resume S-claude/);
    // モデルの決まりは、最初も続きの時も毎回つく
    for (const x of [a[0], a[1], a[2]]) assert.match(x.text, /【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】.*コーディング＝Codex・GPT-6.1-Sol（gpt-6.1-sol）.*claude-opus-4-6 などの古いモデルは使わない/s);
    assert.match(a[0].text, /【プロジェクトや作業を増やさない】.*自分で作らない/);
    assert.match(a[0].text, /作業用コピー|は本体。この作業は作業用コピーを使わず/);
    assert.match(a[2].text, /つづきをお願い/);
    assert.doesNotMatch(a[2].text.split('<previous_conversation>')[1] || '', /はじめまして/);
    // 見つからないコマンドは日本語で知らせる
    process.env.PATH = '/nonexistent';
    await say('codex', '6sol', 'x');
    await waitReply(4);
    assert.match(rows().filter(r => r.role === 'assistant')[3].error, /見つかりません/);
  } finally { process.env.PATH = oldPath; }
});

test('新しいプロジェクトを始められる（ひな形・フェーズ・本体）', async () => {
  const r = await post2('/api/project/new', { name: '新しいサンプルアプリ', description: 'メモの一覧を見せる: 試作', phases: '計画\n作る\n公開', related: 'サンプルアプリ、Database' });
  const p = await r.json();
  assert.strictEqual(r.status, 200, p.error);
  assert.strictEqual(p.name, '新しいサンプルアプリ');
  assert.strictEqual(p.description, 'メモの一覧を見せる: 試作');
  assert.deepStrictEqual(p.phases.map(x => [x.name, x.state]), [['計画', '進行中'], ['作る', '未着手'], ['公開', '未着手']]);
  assert.deepStrictEqual(p.related, ['サンプルアプリ', 'Database']);
  const dir = path.join(ROOT2, 'Product', '新しいサンプルアプリ');
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.ai/rules.md', '.ai/tasks', '資料', '成果物']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.strictEqual((await post2('/api/project/new', { name: '新しいサンプルアプリ' })).status, 400); // 同じ名前は作らない
  assert.strictEqual((await post2('/api/project/new', { name: '../x' })).status, 400); // 外に作る名前は断る
  assert.ok(!fs.existsSync(path.join(ROOT2, 'x')));
  assert.strictEqual((await post2('/api/project/new', { name: 'a/b' })).status, 200); // 「/」は置き換える
  assert.ok(fs.existsSync(path.join(ROOT2, 'Product', 'a・b', 'PROJECT.md')));
  assert.strictEqual((await post2('/api/project/new', { name: 'y', body: '/nai/folder' })).status, 400);
  // 作ったプロジェクトに作業を足せる
  const t = await (await post2('/api/task/new', { project: '新しいサンプルアプリ', title: '画面を作る', phase: '計画' })).json();
  assert.strictEqual(t.phase, '計画');
});

test('バージョン：package.json と変更の記録の一番上が同じ番号。画面にも出る', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
  const top = fs.readFileSync(path.join(HUB, 'CHANGELOG.md'), 'utf8').match(/^## ([\d.]+)/m)[1];
  assert.strictEqual(top, pkg.version, '更新したら package.json と CHANGELOG.md の両方の番号を上げる');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual([st.version, st.latest], [pkg.version, pkg.version]);
  assert.deepStrictEqual(await (await fetch(BASE2 + '/api/version')).json(), { version: pkg.version, latest: pkg.version });
  const log = await (await fetch(BASE2 + '/api/changelog')).json();
  assert.strictEqual(log[0].version, pkg.version);
  assert.ok(log[0].items.length > 0);
  // AI が動いている間は切り替えない
  if (sessions2.available()) {
    sessions2.start({ project: 'サンプルアプリ', task: 'ver-test', ai: 'codex', dir: ROOT2, command: '/bin/bash', env: SHELL_ENV, args: ['--noprofile', '--norc'], cols: 80, rows: 24 });
    assert.strictEqual((await post2('/api/restart', {})).status, 409);
    sessions2.stop('サンプルアプリ', 'ver-test', 'codex');
  }
  assert.strictEqual((await post2('/api/restart', {})).status, 200); // テストでは実際には起動し直さない
});

test('アプリの窓に落とした物：本当の場所で渡す。フォルダ選択。本体はフォルダだけ', async () => {
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'att-test.md');
  fs.writeFileSync(tf, '---\nid: att-test\ntitle: 渡す\nstate: 実行中\n---\n');
  const f = path.join(tmp2, 'メモ 1.txt');
  fs.writeFileSync(f, 'x');
  const j = await (await post2('/api/task/attach', { project: 'サンプルアプリ', task: 'att-test', paths: [f, '/nai/file', 'relative.txt'] })).json();
  assert.deepStrictEqual(j.paths, [f]); // 無い物・相対の場所は渡さない
  assert.ok(fs.readFileSync(tf, 'utf8').includes(`ファイルを渡した: ${f}`));
  assert.strictEqual((await post2('/api/task/attach', { project: 'サンプルアプリ', task: 'att-test', paths: ['/nai'] })).status, 400);
  assert.deepStrictEqual(await (await post2('/api/pick-folder', {})).json(), { path: '' }); // テストでは窓を出さない
  const bad = await post2('/api/project/new', { name: 'ファイルを本体に', body: f });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /フォルダではありません/);
  const ok = await post2('/api/project/new', { name: 'フォルダを本体に', body: tmp2 });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual((await ok.json()).folders, [{ label: '本体', path: tmp2 }]);
});

test('参考フォルダ：作る時に何個でも、作った後にも足せる。関連は一覧から選ぶ。AI への指示に入る', async () => {
  const r1 = path.join(tmp2, 'ref-a'), r2 = path.join(tmp2, 'ref b');
  fs.mkdirSync(r1, { recursive: true }); fs.mkdirSync(r2, { recursive: true });
  const p = await (await post2('/api/project/new', { name: '参考つき', related: ['サンプルアプリ', 'サンプルサイト'], refs: [r1, '/nai/folder'] })).json();
  assert.deepStrictEqual(p.related, ['サンプルアプリ', 'サンプルサイト']);
  assert.deepStrictEqual(p.folders, [{ label: '参考1', path: r1 }]); // 無い場所は入れない
  let j = await (await post2('/api/project/refs', { project: '参考つき', paths: [r1, r2] })).json();
  assert.strictEqual(j.added, 1); // 同じ場所は足さない
  assert.deepStrictEqual(j.folders.map(f => [f.label, f.path]), [['参考1', r1], ['参考2', r2]]);
  assert.strictEqual((await post2('/api/project/refs', { project: '参考つき', paths: ['/nai'] })).status, 400);
  // 空の folders: {} のプロジェクトにも足せる
  j = await (await post2('/api/project/refs', { project: 'サンプルサイト', paths: [r2] })).json();
  assert.deepStrictEqual(j.folders.map(f => f.label), ['参考1']);
  // AI への最初の指示に、参考にしてよい場所が入る
  await post2('/api/task/new', { project: '参考つき', title: 't' });
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const t = st.projects.find(x => x.id === '参考つき').tasks[0];
  const d = await (await post2('/api/term/start', { project: '参考つき', task: t.id, ai: 'claude' })).json();
  const prompt = d.args[d.args.length - 1];
  assert.match(prompt, /参考にしてよい場所（読むだけ。書き換えない）/);
  assert.match(prompt, /【問題点を短くまとめる決まり】/);
  assert.match(prompt, /\.ai\/issues-summary\.json/);
  assert.match(prompt, /createHash\('sha256'\)\.update\(text, 'utf8'\)\.digest\('hex'\)\.slice\(0, 16\)/);
  assert.match(prompt, /30字までの問題名/); assert.match(prompt, /50字までの次の対応/);
  assert.match(prompt, /同じ件の古い項目は「履歴」/);
  assert.match(prompt, /確かめていない事は「確認待ち」/);
  assert.match(prompt, /原文は消さない/); assert.match(prompt, /他プロジェクトには書かない/);
  assert.ok(prompt.includes(r1) && prompt.includes(r2) && prompt.includes(path.join(ROOT2, 'Product', 'サンプルアプリ')));
});

test('モデル名を断られたら1回で止まり、理由と設定を残す', async () => {
  const bin = path.join(tmp2, 'fakebin2');
  fs.mkdirSync(bin, { recursive: true });
  const countFile = path.join(tmp2, 'model-invocations.txt');
  // 本物と同じように、--model があれば断る Codex
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(countFile)},'1\\n');
let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const a=process.argv.slice(2);const o=x=>console.log(JSON.stringify(x));
o({type:'thread.started',thread_id:'T'});
o({type:'item.completed',item:{type:'error',message:'Ignoring malformed agent role definition: failed to deserialize'}});
const m=a.indexOf('--model');
if(m>=0){o({type:'turn.failed',error:{message:'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \\''+a[m+1]+'\\' model is not supported when using Codex with a ChatGPT account."}}'}});process.exit(1);}
o({type:'item.completed',item:{type:'agent_message',text:'OK ARGS['+a.join(' ')+']'}});o({type:'turn.completed'});});
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'model-test.md');
  fs.writeFileSync(tf, '---\nid: model-test\ntitle: m\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'model-test');
  const waitReply = async n => { for (let i = 0; i < 100 && rows().filter(r => r.role === 'assistant').length < n; i++) await new Promise(r => setTimeout(r, 50)); };
  await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'wrong-model-id' } }); // 名前を入れた時だけ渡す
  try {
    await post2('/api/chat/send', { project: 'サンプルアプリ', task: 'model-test', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'こんにちは' });
    await waitReply(1);
    const a = rows().filter(r => r.role === 'assistant');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].text, '');
    assert.match(a[0].error, /指定したモデル「wrong-model-id」を Codex が受け付けませんでした/);
    assert.match(a[0].error, /AI の更新.*CLI に渡すモデル名/);
    assert.strictEqual(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 1);
    assert.ok(!rows().some(r => /既定のモデルでやり直/.test(r.text || '')));
    assert.ok(!rows().some(r => /Ignoring malformed/.test(r.text || ''))); // 関係ない警告は出さない
    // 拒否された設定を勝手に空へ変えない
    const cm = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.deepStrictEqual(cm.codex.find(x => x.name === 'GPT-6.1-Sol'), { name: 'GPT-6.1-Sol', flag: 'wrong-model-id', set: true });
    // 設定で直せる（おかしな文字は入れない）
    await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol' } });
    const cm2 = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.strictEqual(cm2.codex.find(x => x.name === 'GPT-6.1-Sol').flag, 'gpt-6.1-sol');
    await post2('/api/cli-models', { claude: {}, codex: { 'GPT-6.1-Sol': 'bad name;rm' } });
    const cm3 = await (await fetch(BASE2 + '/api/cli-models')).json();
    assert.strictEqual(cm3.codex.find(x => x.name === 'GPT-6.1-Sol').set, false);
    await post2('/api/cli-models', { claude: {}, codex: {} });
  } finally { process.env.PATH = oldPath; }
});

test('作業中の指示：① 取り消してやり直す／② 追加説明（一緒にやる）／③ 終わったら次に。［止める］は待っている指示も取り消す', async () => {
  const bin = path.join(tmp2, 'fakebin3');
  fs.mkdirSync(bin, { recursive: true });
  // 0.6秒かかる Claude（受け取った依頼をそのまま返す）
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const o=x=>console.log(JSON.stringify(x));
o({type:'system',subtype:'init',session_id:'S-q'});
setTimeout(()=>{o({type:'assistant',message:{content:[{type:'text',text:'DONE['+(i.split('# 今回の依頼\\n')[1]||i)+']'}]}});o({type:'result',is_error:false,result:'',session_id:'S-q'});},600);});
process.on('SIGTERM',()=>process.exit(143));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'q-test.md');
  fs.writeFileSync(tf, '---\nid: q-test\ntitle: q\nstate: 実行中\n---\n');
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'q-test');
  const done = () => rows().filter(r => r.role === 'assistant');
  const waitN = async n => { for (let i = 0; i < 200 && done().length < n; i++) await new Promise(r => setTimeout(r, 30)); };
  const say = (text, mode) => post2('/api/chat/send', { project: 'サンプルアプリ', task: 'q-test', ai: 'claude', model: 'Opus 5.5', effort: '高', text, mode });
  try {
    await say('一つ目');
    assert.strictEqual((await say('選ばずに送る')).status, 409); // 作業中は選ぶ
    const q = await (await say('二つ目', 'queue')).json();
    assert.deepStrictEqual([q.queued, q.queue], [true, 1]);
    await waitN(2); // 一つ目が終わると、二つ目が自動で始まる
    assert.match(done()[0].text, /DONE\[一つ目/);
    assert.match(done()[1].text, /DONE\[二つ目/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '二つ目').mode, 'queued');
    // ① 中断して送る
    await say('三つ目');
    await new Promise(r => setTimeout(r, 150));
    const it = await say('四つ目', 'redo');
    assert.strictEqual(it.status, 200);
    await waitN(4);
    assert.strictEqual(done()[2].error, '止めました');
    assert.match(done()[3].text, /前の指示「三つ目」を取り消しました[\s\S]*四つ目/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '四つ目').mode, 'redo');
    // ② 追加説明（一緒にやる）：元の指示は続け、説明を合わせる
    await say('七つ目');
    await new Promise(r => setTimeout(r, 150));
    await say('色は青で', 'amend');
    await waitN(6);
    assert.match(done()[5].text, /今の指示「七つ目」は取り消さずに続けて[\s\S]*色は青で/);
    assert.strictEqual(rows().find(r => r.role === 'user' && r.text === '色は青で').mode, 'amend');
    // ［止める］は、待っている指示も取り消す
    await say('五つ目');
    await say('六つ目', 'queue');
    await post2('/api/chat/stop', { project: 'サンプルアプリ', task: 'q-test' });
    await waitN(7);
    await new Promise(r => setTimeout(r, 800));
    assert.strictEqual(done().length, 7);
    assert.ok(!rows().some(r => r.text === '六つ目'));
  } finally { process.env.PATH = oldPath; }
});

test('未読：見ていない間に会話が終わると印が付き、開くと・既読にすると消える。見ている時は付けない', async () => {
  const bin = path.join(tmp2, 'fakebin-unread');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
let i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{const o=x=>console.log(JSON.stringify(x));
o({type:'system',subtype:'init',session_id:'S-u'});o({type:'assistant',message:{content:[{type:'text',text:'OK'}]}});o({type:'result',is_error:false,result:'',session_id:'S-u'});});
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  const P = 'サンプルアプリ', T = 'unread-test';
  fs.writeFileSync(path.join(ROOT2, 'Product', P, '.ai', 'tasks', `${T}.md`), `---\nid: ${T}\ntitle: 未読\nstate: 実行中\n---\n`);
  const rows = () => chatLib.read(path.join(ROOT2, 'Product', P), T).filter(r => r.role === 'assistant');
  const waitN = async n => { for (let i = 0; i < 200 && rows().length < n; i++) await new Promise(r => setTimeout(r, 30)); await new Promise(r => setTimeout(r, 50)); };
  const isUnread = async () => (await (await fetch(BASE2 + '/api/state')).json()).unread.some(x => x.project === P && x.task === T);
  const file = path.join(ROOT2, '_hub', 'unread.json');
  const say = text => post2('/api/chat/send', { project: P, task: T, ai: 'claude', model: 'Opus 5.5', effort: '高', text });
  const openStream = async () => { const ac = new AbortController(); const r = await fetch(`${BASE2}/api/chat/stream?project=${encodeURIComponent(P)}&task=${T}`, { signal: ac.signal }); assert.strictEqual(r.status, 200); ac.response = r; return ac; };
  try {
    assert.strictEqual(await isUnread(), false);
    assert.strictEqual((await say('一つ目')).status, 200);
    await waitN(1);
    assert.strictEqual(await isUnread(), true);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).items.includes(`${P}\u0000${T}`));
    // 会話画面を開くと消える
    let ac = await openStream();
    assert.strictEqual(await isUnread(), false);
    assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).items.includes(`${P}\u0000${T}`));
    // 見ている間に終わった時は付けない
    await say('二つ目');
    await waitN(2);
    assert.strictEqual(await isUnread(), false);
    ac.abort();
    await new Promise(r => setTimeout(r, 100));
    // 見ていない時はまた付き、既読にすると消える
    await say('三つ目');
    await waitN(3);
    assert.strictEqual(await isUnread(), true);
    assert.strictEqual((await post2('/api/task/read', { project: P, task: T })).status, 200);
    assert.strictEqual(await isUnread(), false);
    assert.strictEqual((await post2('/api/task/read', {})).status, 400);
  } finally { process.env.PATH = oldPath; }
});

test('GitHub の場所：本体に origin があれば一覧と専用の窓口で返し、無ければ 404', async () => {
  const P = 'サンプルアプリ';
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const p = st.projects.find(x => x.id === P);
  assert.ok('github' in p);
  const r = await fetch(`${BASE2}/api/project/github?project=${encodeURIComponent(P)}`);
  if (p.github) assert.deepStrictEqual(await r.json(), p.github);
  else { assert.strictEqual(r.status, 404); assert.strictEqual((await r.json()).error, 'GitHub の場所が見つかりません'); }
  assert.strictEqual((await fetch(`${BASE2}/api/project/github?project=nothing`)).status, 404);
});

test('プロジェクトを完了にする・戻す（おかしな状態は拒否）', async () => {
  const f = path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md');
  const status = () => parseDoc(fs.readFileSync(f, 'utf8')).data.status;
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: '完了', confirm: true, expectedHash: (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ').completionHash })).status, 200);
  assert.strictEqual(status(), '完了');
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: '進行中' })).status, 200);
  assert.strictEqual(status(), '進行中');
  assert.strictEqual((await post2('/api/project/status', { project: 'サンプルアプリ', status: 'x' })).status, 400);
});

test('文の中の場所は Finder で、URL はブラウザで開く（ホームの外・おかしな URL は断る）', async () => {
  const j = async (p, b) => { const r = await post2(p, b); return { status: r.status, body: await r.json() }; };
  const a = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md' });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.body.r.args, ['-R', path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md')]);
  assert.strictEqual((await j('/api/reveal', { project: 'サンプルアプリ', path: '/etc/hosts' })).status, 404);
  assert.strictEqual((await j('/api/reveal', { project: 'サンプルアプリ', path: 'nothing/here.txt' })).status, 404);
  // 開き方の選択前には、Mac/ブラウザとも開かず種類と解決した元の場所だけ返す
  for (const app of [false,true]) for (const [name,dir] of [['PROJECT.md',false],['.ai',true]]) {
    const info = await j('/api/reveal', { project: 'サンプルアプリ', path: name, how: 'info', app });
    assert.strictEqual(info.status,200);assert.strictEqual(info.body.dir,dir);assert.strictEqual(info.body.how,'info');
    assert.strictEqual(info.body.path,path.join(ROOT2,'Product','サンプルアプリ',name));
    assert.strictEqual(info.body.r,undefined);assert.strictEqual(info.body.byApp,undefined);assert.strictEqual(info.body.entries,undefined);
  }
  assert.strictEqual((await j('/api/reveal', {path:'/etc/hosts',how:'info'})).status,404);
  assert.strictEqual((await j('/api/reveal', {path:'nothing/here.txt',how:'info'})).status,404);
  // フォルダは中身を返す（Finder を使わない）。ファイルはそのアプリで開く
  const l = await j('/api/reveal', { project: 'サンプルアプリ', path: '.ai', how: 'list' });
  assert.strictEqual(l.status, 200);
  assert.ok(l.body.entries.some(x => x.name === 'tasks' && x.dir));
  assert.strictEqual(l.body.parent, path.join(ROOT2, 'Product', 'サンプルアプリ'));
  const o = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md', how: 'open' });
  assert.deepStrictEqual(o.body.r.args, [path.join(ROOT2, 'Product', 'サンプルアプリ', 'PROJECT.md')]);
  const inApp = await j('/api/reveal', { project: 'サンプルアプリ', path: 'PROJECT.md', how: 'open', app: true });
  assert.strictEqual(inApp.body.byApp, true); assert.strictEqual(inApp.body.how, 'open');
  const u = await j('/api/open-url', { url: 'http://127.0.0.1:8796/a?b=1' });
  assert.deepStrictEqual(u.body.r.args, ['http://127.0.0.1:8796/a?b=1']);
  assert.strictEqual((await j('/api/open-url', { url: 'javascript:alert(1)' })).status, 400);
});

test('一覧は画面で使う物だけ送り、変わっていなければ 304 で中身を送らない。ファイルを書き換えると反映する', async () => {
  const a = await fetch(BASE2 + '/api/state');
  const tag = a.headers.get('etag'); assert.ok(tag);
  const st = await a.json();
  const t = st.projects.flatMap(p => p.tasks)[0];
  assert.ok(t && !('done' in t) && !('memo' in t) && !('note' in t) && !String(t.next).includes('\n'));
  const b = await fetch(BASE2 + '/api/state', { headers: { 'If-None-Match': tag } });
  assert.strictEqual(b.status, 304);
  // 作業ファイルを外から書き換える → 次の一覧に出る（読み込みの使い回しが古い物を返さない）
  const pid = st.projects[0].id;
  const tf = path.join(ROOT2, 'Product', pid, '.ai', 'tasks', 'etag-test.md');
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.writeFileSync(tf, '---\nid: etag-test\ntitle: 一つ目\nstate: 実行中\n---\n## 次にやること\n一行目\n二行目\n');
  const c = await fetch(BASE2 + '/api/state', { headers: { 'If-None-Match': tag } });
  assert.strictEqual(c.status, 200);
  const find = async () => (await (await fetch(BASE2 + '/api/state')).json()).projects.find(p => p.id === pid).tasks.find(x => x.id === 'etag-test');
  assert.strictEqual((await find()).title, '一つ目'); assert.strictEqual((await find()).next, '一行目');
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(tf, '---\nid: etag-test\ntitle: 二つ目\nstate: 実行中\n---\n');
  assert.strictEqual((await find()).title, '二つ目');
  fs.rmSync(tf);
});

test('生きているかは、ファイルを読まずにすぐ答える', async () => {
  const r = await (await fetch(BASE2 + '/api/ping')).json();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.pid, process.pid);
});

test('本体が台帳を読めるか答える。止める時は、外からの操作を断る', async () => {
  const a = await (await fetch(BASE2 + '/api/access')).json();
  assert.strictEqual(a.ok, true);
  const r = await fetch(BASE2 + '/api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403); // X-Hub が無い
  assert.strictEqual((await post2('/api/quit', { reason: 'test' })).status, 200); // 試しの時は止まらない
});

test('AI の質問を選択肢にする（決まった形・質問の道具のどちらでも）', () => {
  const r = chatLib.parseAsk('料金案を2つ作りました。\n\n[[質問]]\nどちらで進めますか？\n1. 月額を下げる（おすすめ）\n2. 初期費用を下げる\n[[/質問]]\n[[質問]]\n入れる機能は？（複数可）\n- 予約\n- 来所受付\n[[/質問]]');
  assert.strictEqual(r.text, '料金案を2つ作りました。');
  assert.deepStrictEqual(r.asks, [
    { question: 'どちらで進めますか？', options: ['月額を下げる（おすすめ）', '初期費用を下げる'], multi: false },
    { question: '入れる機能は？（複数可）', options: ['予約', '来所受付'], multi: true },
  ]);
  assert.deepStrictEqual(chatLib.parseAsk('質問なしの返事').asks, []);
  assert.strictEqual(chatLib.parseAsk('[[質問]]\nA と B どちら？\n1. A\n2. B').asks[0].options.length, 2); // 閉じ忘れ
  const ev = chatLib.parse('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: '色は？', multiSelect: false, options: [{ label: '赤' }, { label: '青' }] }] } }] } });
  assert.deepStrictEqual(ev, [{ kind: 'ask', asks: [{ question: '色は？', options: ['赤', '青'], multi: false }] }]);
  const turn = chatLib.buildTurn({ ai: 'claude', model: '', meta: {}, rows: [], text: 'やって', basePrompt: 'B' });
  assert.match(turn.stdin, /\[\[質問\]\]/);
});

test('モデルを最新に整理：今の一覧だけ出し、役割の古い名前を同じ系統の一番新しいモデルにする', () => {
  const rolesLib = require('../lib/roles');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tidy-'));
  const f = path.join(d, 'roles.yaml');
  fs.copyFileSync(path.join(TPL, '_hub', 'roles.yaml'), f);
  // 古い設定を持つ利用者の移行を確かめる。配布ひな形の既定値に依存しない。
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8')
    .replace('main: [codex, GPT-6.1-Sol, 高]', 'main: [codex, 6sol, 高]')
    .replace('main: [codex, GPT-6.1-Sol, 中]', 'main: [codex, Astra, 中]')
    .replaceAll('backup: [codex, GPT-6.1-Sol, 高]', 'backup: [codex, 6terra, 高]'));
  try {
    assert.strictEqual(rolesLib.tidy(f).ok, false); // 一覧を取り直す前は断る
    rolesLib.setModelCatalog({
      claude: { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-fable-5-1', label: 'Fable 5.1' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
      codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }, { id: 'gpt-6.1-astra', label: 'GPT-6.1-Astra' }] },
    });
    const before = rolesLib.read(f).data;
    assert.deepStrictEqual(before.models.codex.slice(0, 4), ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-6.1-Astra']);
    assert.strictEqual(before.roles.find(r => r.name === '調査').backup.model, 'GPT-5.6-Terra'); // 6terra は同じモデルなので今の名前で見せる
    const r = rolesLib.tidy(f);
    assert.ok(r.changes.some(c => c.role === 'コーディング' && c.from === '6sol' && c.to === 'GPT-6.1-Sol'));
    assert.ok(r.changes.some(c => c.from === 'Astra' && c.to === 'GPT-6.1-Astra'));
    const after = rolesLib.read(f).data;
    assert.deepStrictEqual(after.models.codex, ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-6.1-Astra']);
    assert.match(fs.readFileSync(f, 'utf8'), /codex:\s+\[GPT-6\.1-Sol, GPT-5\.6-Sol, GPT-5\.6-Terra, GPT-6\.1-Astra\]/);
    assert.deepStrictEqual(rolesLib.tidy(f).changes, []); // 2回目は何も変えない
  } finally { rolesLib.setModelCatalog({}); fs.rmSync(d, { recursive: true, force: true }); }
});

test('選ぶ欄に出すモデルを、設定で隠せる・戻せる', async () => {
  const j = async b => (await post2('/api/models/hidden', b)).json();
  assert.deepStrictEqual((await j({ ai: 'codex', model: '6luna', hidden: true })).hiddenModels.codex, ['6luna']);
  const st = await (await fetch(BASE2 + '/api/state')).json();
  assert.deepStrictEqual(st.hiddenModels.codex, ['6luna']);
  assert.deepStrictEqual((await j({ ai: 'codex', model: '6luna', hidden: false })).hiddenModels.codex, []);
  assert.strictEqual((await post2('/api/models/hidden', { ai: 'x', model: 'a' })).status, 400);
});

test('作業用コピーの場所が無い時：取り込むと説明して記録を片付ける。片付けは場所が無い時だけ', async () => {
  const pid = 'サンプルアプリ';
  const tf = path.join(ROOT2, 'Product', pid, '.ai', 'tasks', 'gone-copy.md');
  const gone = path.join(ROOT2, 'Work', pid, 'gone-copy');
  fs.writeFileSync(tf, `---\nid: gone-copy\ntitle: 消えたコピー\nstate: 実行中\nworkdir: ${gone}\n---\n`);
  // 取り込んだ記録を1つ残しておく
  fs.mkdirSync(path.join(ROOT2, '_hub'), { recursive: true });
  fs.appendFileSync(path.join(ROOT2, '_hub', 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'merge', project: pid, task: 'gone-copy', ok: true }) + '\n');
  const st = await (await fetch(BASE2 + '/api/state')).json();
  const t = st.projects.find(x => x.id === pid).tasks.find(x => x.id === 'gone-copy');
  assert.strictEqual(t.copy, false); assert.strictEqual(t.copyMissing, true);
  const r = await post2('/api/task/merge', { project: pid, task: 'gone-copy' });
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /本体へ取り込み済み/);
  assert.doesNotMatch(fs.readFileSync(tf, 'utf8'), /workdir: \//); // 記録は片付いた
  fs.writeFileSync(tf, `---\nid: gone-copy\ntitle: 消えたコピー\nstate: 実行中\nworkdir: ${gone}\n---\n`);
  const c = await (await post2('/api/task/copyclear', { project: pid, task: 'gone-copy' })).json();
  assert.strictEqual(c.ok, true); assert.strictEqual(c.merged, true);
  fs.mkdirSync(gone, { recursive: true }); fs.writeFileSync(tf, `---\nid: gone-copy\ntitle: 消えたコピー\nstate: 実行中\nworkdir: ${gone}\n---\n`);
  assert.strictEqual((await post2('/api/task/copyclear', { project: pid, task: 'gone-copy' })).status, 409); // 場所があるなら片付けない
  fs.rmSync(gone, { recursive: true, force: true }); fs.rmSync(tf);
});

test('別の AI に作業を渡す（/api/delegate）：同じ作業で動かし、子作業を作らない', async () => {
  const bin = path.join(tmp2, 'fakebin3'); // 上の試験で作った、0.6秒で返事する Claude
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  try {
    const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'dlg-parent.md');
    fs.mkdirSync(path.dirname(tf), { recursive: true });
    fs.writeFileSync(tf, '---\nid: dlg-parent\ntitle: 親の作業\nstate: 実行中\n---\n## やったこと\n');
    const before = fs.readdirSync(path.dirname(tf)).sort();
    const r = await (await post2('/api/delegate', { project: 'サンプルアプリ', task: 'dlg-parent', ai: 'claude', model: 'claude-fable-5-1', title: '計算を頼む', text: '合計を出して' })).json();
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.task, 'dlg-parent');
    for (let i = 0; i < 100; i++) { await new Promise(x => setTimeout(x, 50)); const rows = chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'dlg-parent'); if (rows.some(x => x.role === 'assistant')) break; }
    const rows = chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'dlg-parent');
    const got = rows.find(x => x.role === 'assistant');
    assert.ok(got, '結果の行が元の会話に無い'); assert.strictEqual(got.model, 'Fable 5.1'); assert.match(got.text, /DONE\[/);
    const st = await (await fetch(BASE2 + '/api/state')).json();
    const p = st.projects.find(x => x.id === 'サンプルアプリ');
    assert.strictEqual(p.tasks.filter(x => x.derivedFrom === 'dlg-parent').length, 0);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(tf)).sort(), before);
    assert.ok(st.unread.some(u => u.project === 'サンプルアプリ' && u.task === 'dlg-parent'));
    assert.strictEqual((await post2('/api/delegate', { project: 'サンプルアプリ', task: 'dlg-parent', ai: 'gpt', text: 'x' })).status, 400);
    // 動かせない時も作業・会話を作らず、指定なしでの再試行は受け付けない。
    assert.strictEqual((await post2('/api/delegate', { project: 'サンプルアプリ', task: 'dlg-parent', ai: 'claude', model: 'ない名前', title: '失敗', text: 'x' })).status, 409);
    assert.strictEqual((await post2('/api/delegate', { project: 'サンプルアプリ', task: 'dlg-parent', ai: 'claude', text: 'x' })).status, 400);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(tf)).sort(), before);
  } finally { process.env.PATH = oldPath; }
});

test('ChatGPT：貼る文に作業の中身を入れ、貼った返事を会話に残す', async () => {
  const tf = path.join(ROOT2, 'Product', 'サンプルアプリ', '.ai', 'tasks', 'gpt-paste.md');
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.writeFileSync(tf, '---\nid: gpt-paste\ntitle: 見てもらう\nstate: 実行中\n---\n## 手順\n- [ ] 目印XYZを確かめる\n## やったこと\n');
  const r = await (await post2('/api/chatgpt/prompt', { project: 'サンプルアプリ', task: 'gpt-paste', text: '急ぎで' })).json();
  assert.match(r.text, /目印XYZ/); assert.match(r.text, /# 今回の依頼\n急ぎで/); assert.doesNotMatch(r.text, /hub_get_task/);
  assert.strictEqual((await post2('/api/chatgpt/result', { project: 'サンプルアプリ', task: 'gpt-paste', text: '' })).status, 400);
  assert.strictEqual((await post2('/api/chatgpt/result', { project: 'サンプルアプリ', task: 'gpt-paste', text: '## 結果\nよい' })).status, 200);
  const row = chatLib.read(path.join(ROOT2, 'Product', 'サンプルアプリ'), 'gpt-paste').pop();
  assert.strictEqual(row.role, 'assistant'); assert.strictEqual(row.ai, 'chatgpt'); assert.match(row.text, /よい/);
  assert.match(fs.readFileSync(tf, 'utf8'), /ChatGPT の返事を受け取った/);
});

test('空の作業を片付ける：会話が空の派生作業と子プロジェクトを探し、ゴミ箱へ移す', async () => {
  const P = path.join(ROOT2, 'Product');
  const td = path.join(P, 'サンプルアプリ', '.ai', 'tasks');
  fs.writeFileSync(path.join(td, 'emp-a.md'), '---\nid: emp-a\ntitle: 空の派生\nkind: derived\nstate: 未着手\n---\n## やったこと\n');
  fs.writeFileSync(path.join(td, 'emp-b.md'), '---\nid: emp-b\ntitle: 人の作業\nkind: main\nstate: 未着手\n---\n## やったこと\n');
  const kid = path.join(P, '空の子'); fs.mkdirSync(path.join(kid, '.ai', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(kid, 'PROJECT.md'), '---\nname: 空の子\nparent: サンプルアプリ\n---\n');
  fs.writeFileSync(path.join(kid, '.ai', 'tasks', 'k1.md'), '---\nid: k1\ntitle: 子の作業\nstate: 完了\n---\n## やったこと\n');
  const items = (await (await post2('/api/empty/scan', {})).json()).items;
  const a = items.find(x => x.task === 'emp-a'), bb = items.find(x => x.task === 'emp-b'), k = items.find(x => x.whole && x.project === '空の子');
  assert.ok(a && a.pick); assert.ok(bb && !bb.pick); assert.ok(k && k.pick);
  assert.ok(!items.some(x => x.task === 'gpt-paste')); // 会話がある作業は出さない
  const r = await (await post2('/api/empty/trash', { items: [{ project: 'サンプルアプリ', task: 'emp-a' }, { project: '空の子' }] })).json();
  assert.strictEqual(r.moved, 2);
  assert.ok(!fs.existsSync(path.join(td, 'emp-a.md'))); assert.ok(fs.existsSync(path.join(td, 'emp-b.md'))); assert.ok(!fs.existsSync(kid));
  assert.ok(fs.existsSync(path.join(r.dest, 'サンプルアプリ', 'emp-a.md')));
  fs.rmSync(path.join(td, 'emp-b.md'));
});

test('子作業：渡す操作は通知だけ、祖先の統合後に成果を保存し管理記録を片付ける', async () => {
  const pdir = path.join(ROOT2, 'Product', 'サンプルアプリ'), td = path.join(pdir, '.ai', 'tasks');
  fs.writeFileSync(path.join(td, 'up-parent.md'), '---\nid: up-parent\ntitle: 本作業\nstate: 実行中\n---\n## やったこと\n');
  fs.writeFileSync(path.join(td, 'up-kid.md'), '---\nid: up-kid\ntitle: 小作業\nparent: up-parent\nstate: 実行中\n---\n## 手順\n- [x] 調べる\n');
  chatLib.append(pdir,'up-kid',{role:'assistant',ai:'codex',text:'長い会話は渡さない'});
  fs.mkdirSync(path.join(pdir,'作業/up-kid'),{recursive:true});fs.writeFileSync(path.join(pdir,'作業/up-kid/result.txt'),'成果A');
  const body={project:'サンプルアプリ',task:'up-kid'};
  const ownMerge=await post2('/api/task/merge',body);assert.equal(ownMerge.status,409);assert.match((await ownMerge.json()).error,/親|祖先/);
  assert.equal((await post2('/api/task/handup',body)).status,409);
  const stale=await post2('/api/task/handup/preview',{...body,expectTitle:'昔の子'});assert.equal(stale.status,409);assert.match((await stale.json()).error,/同じ番号の別の作業/);
  const d=await (await post2('/api/task/handup/preview',{...body,expectTitle:'小作業'})).json();assert.deepEqual(d.blockers,[]);
  const input={...body,token:d.token,selected:['project:作業/up-kid/result.txt'],confirm:true,expectTitle:'小作業'};
  assert.equal((await post2('/api/task/handup',{...input,expectTitle:'昔の子'})).status,409);
  assert.ok(fs.existsSync(path.join(td,'up-kid.md')));assert.equal(chatLib.read(pdir,'up-parent').length,0);
  const r=await (await post2('/api/task/handup',input)).json();assert.equal(r.ok,true);assert.equal(r.handedUp,true);assert.ok(fs.existsSync(path.join(td,'up-kid.md')));
  assert.equal((await (await post2('/api/task/handup',input)).json()).ok,true);
  const preview=await (await post2('/api/task/integrate/preview',{project:body.project,task:'up-parent'})).json();assert.deepEqual(preview.items[0].blockers,[]);
  const integrated=await (await post2('/api/task/integrate',{project:body.project,task:'up-parent',token:preview.token,confirm:true,selected:[{...body,files:input.selected}]})).json();assert.equal(integrated.ok,true);assert.ok(!fs.existsSync(path.join(td,'up-kid.md')));
  const received=await post2('/api/task/handup/preview',body);assert.equal(received.status,409);assert.match((await received.json()).error,/もう受け取って片付けてあります/);
  const rows=chatLib.read(pdir,'up-parent').filter(r=>r.handoff);assert.equal(rows.length,1);assert.match(rows[0].text,/result.txt/);assert.doesNotMatch(rows[0].text,/長い会話/);
  fs.writeFileSync(path.join(td,'up-kid2.md'),'---\nid: up-kid2\ntitle: 未完成\nparent: up-parent\n---\n## 手順\n- [ ] まだ\n');
  const x=await (await post2('/api/task/handup/preview',{project:'サンプルアプリ',task:'up-kid2'})).json();assert.ok(x.blockers.length);
  assert.equal((await post2('/api/task/absorb',{project:'サンプルアプリ',task:'up-kid2',token:x.token,confirm:true})).status,409);
});

test('待っている指示はファイルに残り、再起動しても消えない', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-q-'));
  try {
    const a = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') });
    const it = a.enqueue('P', 'T', { ai: 'claude', model: 'Opus 5.5', effort: '高', text: 'あとで' });
    a.enqueue('P', 'T', { ai: 'codex', model: '6sol', effort: '中', text: 'その次' });
    const b = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') }); // 起動し直した
    assert.deepStrictEqual(b.queue('P', 'T').map(x => x.text), ['あとで', 'その次']);
    b.unqueue('P', 'T', it.id);
    const c = new chatLib.ChatRunner({ dirOf: id => (id === 'P' ? d : '') });
    assert.deepStrictEqual(c.queue('P', 'T').map(x => x.text), ['その次']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('main/derived task fields persist and direct workspace rejects concurrent AI', async()=>{
 const p='サンプルアプリ',a=await (await post2('/api/task/new',{project:p,title:'Main work',kind:'main',workspaceMode:'direct'})).json();
 const d=await (await post2('/api/task/new',{project:p,title:'Derived',kind:'derived',derivedFrom:a.id})).json();
 assert.equal(d.kind,'derived');assert.equal(d.derivedFrom,a.id);
 assert.equal((await post2('/api/task',{project:p,task:a.id,kind:'derived',derivedFrom:d.id})).status,409);
 const old=sessions2.list;
 try {sessions2.list=()=>[{project:p,task:d.id,running:true}];
  assert.equal((await post2('/api/term/start',{project:p,task:a.id,ai:'codex'})).status,409);
 } finally {sessions2.list=old;}
 const started=await (await post2('/api/term/start',{project:p,task:a.id,ai:'codex'})).json();
 assert.equal(started.dry,true);assert.ok(started.args.join(' ').includes('本作業'));
});

test('tree rename and branch project APIs keep IDs and source links', async()=>{
 const p=await (await post2('/api/project/new',{name:'Tree original',phases:['A']})).json();
 const child=await (await post2('/api/project/new',{name:'Tree child',parent:p.id})).json();
 const branch=await (await post2('/api/project/new',{name:'Tree branch',parent:child.parent,derivedFrom:child.id})).json();
 assert.equal(branch.parent,p.id);assert.equal(branch.derivedFrom,child.id);
 const r=await (await post2('/api/hierarchy/rename',{project:p.id,name:'Tree renamed',expectedHash:p.completionHash})).json();
 assert.equal(r.id,p.id);assert.equal(r.name,'Tree renamed');
});

test('completion routes require explicit confirmation, fresh content and idle AI', async () => {
 const t=await (await post2('/api/task/new',{project:'サンプルアプリ',title:'Approval check'})).json();
 const b={project:'サンプルアプリ',task:t.id,action:'approve',expectedHash:t.completionHash};
 assert.equal((await post2('/api/task/completion',b)).status,400);
 assert.equal((await post2('/api/task',{...b,state:'完了'})).status,409);
 assert.equal((await post2('/api/task/completion',{...b,confirm:true,expectedHash:'stale'})).status,409);
 const oldGet=sessions2.get, oldList=sessions2.list;
 try {
  sessions2.get=()=>({exited:false});sessions2.list=()=>[{project:b.project,running:true}];
  assert.equal((await post2('/api/task/completion',{...b,confirm:true})).status,409);
  const p=(await (await fetch(BASE2+'/api/state')).json()).projects.find(p=>p.id===b.project);
  assert.equal((await post2('/api/project/status',{project:p.id,status:'完了',confirm:true,expectedHash:p.completionHash})).status,409);
  assert.equal((await post2('/api/phase/next',{project:p.id,confirm:true,expectedHash:p.completionHash})).status,409);
 } finally {sessions2.get=oldGet;sessions2.list=oldList;}
 const approved=await (await post2('/api/task/completion',{...b,confirm:true})).json();
 assert.equal(approved.state,'完了');
 const reopened=await (await post2('/api/task/completion',{...b,action:'continue',confirm:true,expectedHash:approved.completionHash})).json();
 assert.equal(reopened.state,'実行中');
 assert.equal((await post2('/api/phase/continue',{project:b.project,expectedHash:'stale'})).status,409);
 const p=(await (await fetch(BASE2+'/api/state')).json()).projects.find(p=>p.id===b.project);
 assert.equal((await post2('/api/phase/continue',{project:p.id,expectedHash:p.completionHash})).status,200);
 assert.equal((await post2('/api/phase/next',{project:p.id,confirm:true,expectedHash:'stale'})).status,409);
 assert.equal((await post2('/api/project/status',{project:p.id,status:'完了',confirm:true,expectedHash:'stale'})).status,409);
});

test('maintenance endpoints enforce confirmation and busy guards, allow preview, move and restore selected fixture files',async()=>{
 const p=await (await post2('/api/project/new',{name:'Maintenance fixture'})).json();
 const dir=path.join(ROOT2,'Product',p.id,'.ai/work');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'unused.dat');fs.writeFileSync(file,'maintenance fixture');const when=new Date(Date.now()-40*86400000);fs.utimesSync(file,when,when);
 assert.equal((await fetch(BASE2+'/api/maintenance/preview',{method:'POST'})).status,403);
 let d=await (await post2('/api/maintenance/preview',{project:p.id})).json();assert.equal(d.candidates.length,1);
 const payload={project:p.id,token:d.token,selected:[d.candidates[0].id],confirm:true};
 const old=sessions2.list;try {sessions2.list=()=>[{project:p.id,running:true}];
  assert.equal((await post2('/api/maintenance/preview',{project:p.id})).status,200);
  assert.equal((await post2('/api/maintenance/apply',payload)).status,409);
  assert.equal((await post2('/api/maintenance/verify',{project:p.id})).status,409);
 }finally{sessions2.list=old;}
 assert.equal((await post2('/api/maintenance/apply',{...payload,confirm:false})).status,409);
 const r=await (await post2('/api/maintenance/apply',payload)).json();assert.equal(r.moved,1);assert.equal(fs.existsSync(file),false);
 const restored=await (await post2('/api/maintenance/restore',{project:p.id,transaction:r.id,confirm:true})).json();assert.equal(restored.restored,1);assert.equal(fs.readFileSync(file,'utf8'),'maintenance fixture');
 assert.equal((await (await post2('/api/maintenance/verify',{project:p.id})).json()).ok,true);
});

test('separate body allows isolated peers and idempotent sessions, explicit direct excludes peers and locks started mode', async()=>{
 const body=path.join(tmp2,'body-fixture');fs.mkdirSync(body);
 const p=await (await post2('/api/project/new',{name:'Separate body',folders:{本体:body}})).json();
 const pf=path.join(ROOT2,'Product',p.id,'PROJECT.md');
 fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:',`folders:\n  本体: ${body}`));
 const a=await (await post2('/api/task/new',{project:p.id,title:'Isolated A'})).json();
 const b=await (await post2('/api/task/new',{project:p.id,title:'Isolated B'})).json();
 const d=await (await post2('/api/task/new',{project:p.id,title:'Direct',workspaceMode:'direct'})).json();
 const oldList=sessions2.list,oldGet=sessions2.get;
 try {
  sessions2.list=()=>[{project:p.id,task:a.id,running:true}];
  assert.equal((await post2('/api/term/start',{project:p.id,task:b.id,ai:'codex'})).status,200);
  assert.equal((await post2('/api/term/start',{project:p.id,task:a.id,ai:'codex'})).status,200);
  assert.equal((await post2('/api/term/start',{project:p.id,task:d.id,ai:'codex'})).status,409);
  sessions2.list=()=>[{project:p.id,task:d.id,running:true}];
  assert.equal((await post2('/api/term/start',{project:p.id,task:b.id,ai:'codex'})).status,409);
  sessions2.get=()=>({exited:false,dir:body});
  assert.equal((await post2('/api/term/start',{project:p.id,task:d.id,ai:'codex'})).status,200);
 } finally {sessions2.list=oldList;sessions2.get=oldGet;}
 const result=await (await post2('/api/term/start',{project:p.id,task:d.id,ai:'codex'})).json();
 assert.equal(result.dir,body);
 assert.ok(!result.args.join(' ').includes('参照（読むだけ）: '+path.dirname(pf)));
 assert.equal((await post2('/api/task',{project:p.id,task:d.id,workspaceMode:'isolated'})).status,409);
 const persisted=(await (await fetch(BASE2+'/api/state')).json()).projects.find(x=>x.id===p.id).tasks.find(t=>t.id===d.id);
 assert.ok(persisted.workspaceStarted);
});

test('chat launch hook receives queued task context before any AI process is created',()=>{
 const runner=new chatLib.ChatRunner({canStart:(ai,model,o)=>{assert.equal(o.project,'p');assert.equal(o.mode,'queued');return 'blocked fixture';}});
 assert.throws(()=>runner.send({project:'p',task:'t',ai:'codex',mode:'queued'}),/blocked fixture/);
 assert.equal(runner.running.size,0);
});

test('a running selected verification blocks new AI launch while state remains readable',async()=>{
 const p=await (await post2('/api/project/new',{name:'Verify launch lock'})).json();const dir=path.join(ROOT2,'Product',p.id);
 fs.writeFileSync(path.join(dir,'wait.cjs'),'setTimeout(()=>console.log("verified"),700)');fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({scripts:{test:'node wait.cjs'}}));
 const t=await (await post2('/api/task/new',{project:p.id,title:'launch after verify'})).json();
 const preview=await (await post2('/api/maintenance/preview',{project:p.id})).json();
 const pending=post2('/api/maintenance/verify',{project:p.id,script:'test',expectedHash:preview.scripts[0].hash,confirm:true});
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await post2('/api/term/start',{project:p.id,task:t.id,ai:'codex'})).status,409);
 assert.equal((await fetch(BASE2+'/api/state')).status,200);
 assert.equal((await (await pending).json()).ok,true);
 assert.equal((await post2('/api/term/start',{project:p.id,task:t.id,ai:'codex'})).status,200);
});

test('第2版: 後片付け', () => {
  sessions2.stopAll();
  server2.close();
  fs.rmSync(tmp2, { recursive: true, force: true });
});
