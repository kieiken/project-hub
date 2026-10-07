'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
// ChatGPT 連携（版1）：mcp.js を本当に起動し、標準入出力の JSON-RPC で Hub の道具を呼ぶ
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
const root = path.join(tmp, 'workspace'), pdir = path.join(root, 'Product', 'サンプルアプリ'), body = path.join(tmp, 'SampleApp');
const P = 'サンプルアプリ', T = 'sample-app-01';
const port = 49500 + Math.floor(Math.random() * 400);
const taskFile = () => fs.readFileSync(path.join(pdir, '.ai', 'tasks', T + '.md'), 'utf8');
function local(p, b) {
  return new Promise((resolve, reject) => {
    const data = b === undefined ? null : JSON.stringify(b);
    const rq = http.request({ host: '127.0.0.1', port, path: encodeURI(p), method: data ? 'POST' : 'GET', headers: { Host: `127.0.0.1:${port}`, 'X-Hub': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}

let server, sessions, mcp, nextId = 1, out = '', stderr = '';
const waiting = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  return new Promise((resolve, reject) => { waiting.set(id, resolve); setTimeout(() => reject(Error(`返事が来ません: ${method}\n${stderr}`)), 10000); });
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const names = async () => (await rpc('tools/list')).result.tools.map(t => t.name);

test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.mkdirSync(body, { recursive: true });
  fs.writeFileSync(path.join(body, 'README.md'), '# 見本の本体\n');
  fs.writeFileSync(path.join(body, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), '外のファイル');
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  const pf = path.join(pdir, 'PROJECT.md');
  fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace('本体: ~/Documents/SampleApp', `本体: ${body}`));
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nagents: []\nroles: {}\n');
  Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'empty-home') });
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], { env: { ...process.env, HUB_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.on('data', c => { stderr += c; });
  mcp.stdout.on('data', c => {
    out += c; let i;
    while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
});
test.after(async () => { mcp.kill(); sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('初期化・ping・知らない名前は JSON-RPC の決まりどおりに答える', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'project-hub');
  assert.ok(init.result.capabilities.tools);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); // 返事しない
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal((await rpc('nothing/here')).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'hub_nothing', arguments: {} })).error.code, -32602);
  assert.equal(stderr.includes('起動しました'), true); // 記録は標準エラーだけ
});

test('ChatGPT アプリ（Codex）の設定ファイルに Hub の道具を登録できる（2回目は足さない）', async () => {
  const home = process.env.HUB_AI_HOME, file = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'model = "gpt-6.1-sol"\n# checkout: project-hub\n');
  const BASE = `http://127.0.0.1:${port}`;
  const j = async (u, b) => (await fetch(BASE + u, b ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(b) } : { headers: { 'X-Hub': '1' } })).json();
  assert.strictEqual((await j('/api/chatgpt')).registered, false);
  const r = await j('/api/chatgpt/register', {});
  assert.strictEqual(r.added, true); assert.strictEqual(r.registered, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^model = "gpt-6\.1-sol"\n/); assert.match(text, /\[mcp_servers\.project-hub\]\ncommand = "node"\nargs = \[".*mcp\.js"\]/);
  assert.ok(fs.existsSync(file + '.bak-' + new Date().toISOString().slice(0, 10)));
  assert.strictEqual((await j('/api/chatgpt/register', {})).added, false);
  assert.strictEqual((fs.readFileSync(file, 'utf8').match(/^\s*\[mcp_servers\.project-hub\]/gm) || []).length, 1);
});

test('実作業の道具は設定がオンの時だけ出る。Mac の外からは呼べない', async () => {
  const base = await names();
  for (const n of ['hub_list_projects', 'hub_list_tasks', 'hub_get_task', 'hub_get_chat', 'hub_read_file', 'hub_report', 'hub_ask_owner', 'hub_mark_step', 'hub_propose_task']) assert.ok(base.includes(n), n);
  assert.equal(base.includes('hub_write_file') || base.includes('hub_run_command'), false);
  const refused = await call('hub_run_command', { project: P, command: 'echo ok' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /実作業もできる/);
  assert.equal((await local('/api/chatgpt')).json.work, false);
  assert.equal((await local('/api/chatgpt', { work: true })).json.work, true);
  assert.equal((await local('/api/state')).json.chatgpt.work, true);
  assert.ok((await names()).includes('hub_run_command'));
  const ran = JSON.parse((await call('hub_run_command', { project: P, command: 'echo ok' })).content[0].text);
  assert.equal(ran.code, 0); assert.equal(ran.stdout.trim(), 'ok'); assert.equal(fs.realpathSync(ran.cwd), fs.realpathSync(body));
  const wrote = await call('hub_write_file', { project: P, path: 'src/a.txt', text: 'あ' });
  assert.equal(wrote.isError, undefined); assert.equal(fs.readFileSync(path.join(body, 'src/a.txt'), 'utf8'), 'あ');
  assert.equal((await call('hub_write_file', { project: P, path: '.git/config', text: 'x' })).isError, true);
  assert.equal((await call('hub_write_file', { project: P, path: '../outside.txt', text: 'x' })).isError, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8'), '外のファイル');
  await local('/api/chatgpt', { work: false });
  assert.equal((await names()).includes('hub_write_file'), false);
  assert.ok(fs.readFileSync(path.join(root, '_hub', 'log.jsonl'), 'utf8').includes('"tool":"hub_run_command"'));
  assert.equal((await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/api/mcp/tools', headers: { Host: `127.0.0.1:${port}` } }, r => { r.resume(); resolve(r.statusCode); }))), 403); // X-Hub が無い
});

test('一覧と作業を読む', async () => {
  const projects = JSON.parse((await call('hub_list_projects', {})).content[0].text);
  const p = projects.find(x => x.id === P);
  assert.equal(p.counts.all, 1); assert.equal(p.phases[0].name, '試作');
  const tasks = JSON.parse((await call('hub_list_tasks', { project: P })).content[0].text);
  assert.equal(tasks[0].id, T); assert.equal(tasks[0].steps.length, 3);
  const text = (await call('hub_get_task', { project: P, task: T })).content[0].text;
  assert.match(text, /## 手順/); assert.match(text, /name: サンプルアプリ/);
  assert.equal((await call('hub_get_task', { project: P, task: 'nope' })).isError, true);
  assert.match((await call('hub_read_file', { project: P, path: 'README.md' })).content[0].text, /見本の本体/);
  assert.match((await call('hub_read_file', { project: P, path: 'PROJECT.md' })).content[0].text, /サンプルアプリ/); // 台帳も読める
  for (const bad of ['../outside.txt', path.join(tmp, 'outside.txt'), '/etc/passwd', '.env']) {
    const r = await call('hub_read_file', { project: P, path: bad });
    assert.equal(r.isError, true, bad); assert.doesNotMatch(r.content[0].text, /外のファイル|SECRET/);
  }
});

test('報告・質問・手順・提案が作業ファイルと会話画面に残る', async () => {
  await local('/api/task/read', { project: P, task: T });
  const r = await call('hub_report', { project: P, task: T, text: 'レビューしました。\n問題は2つです。' });
  assert.equal(r.isError, undefined);
  const file = taskFile();
  assert.match(file, /## やったこと\n台帳の表示[^\n]*\n- \d{4}-\d\d-\d\d \d\d:\d\d ChatGPT：レビューしました。\n  問題は2つです。\n## 次にやること/);
  const chatRows = fs.readFileSync(path.join(pdir, '.ai', 'chat', T + '.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual({ role: chatRows.at(-1).role, ai: chatRows.at(-1).ai }, { role: 'assistant', ai: 'chatgpt' });
  assert.ok((await local('/api/state')).json.unread.some(u => u.project === P && u.task === T));
  const chatLog = JSON.parse((await call('hub_get_chat', { project: P, task: T, limit: 5 })).content[0].text);
  assert.equal(chatLog.at(-1).ai, 'chatgpt');

  await call('hub_ask_owner', { project: P, task: T, question: 'A と B のどちらにしますか？' });
  let t = (await local('/api/state')).json.projects.find(p => p.id === P).tasks.find(x => x.id === T);
  assert.equal(t.state, '返事待ち'); assert.equal(t.question, 'A と B のどちらにしますか？');

  const step = JSON.parse((await call('hub_mark_step', { project: P, task: T, index: 1, done: true })).content[0].text);
  assert.equal(step.steps[1].done, true);

  await call('hub_report', { project: P, task: T, text: '終わりました', done: true });
  t = (await local('/api/state')).json.projects.find(p => p.id === P).tasks.find(x => x.id === T);
  assert.equal(t.state, '完了確認待ち'); // 人が確認して完了にする

  const made = JSON.parse((await call('hub_propose_task', { project: P, title: 'テストを足す', text: '一覧の画面にテストが無い。\n足すとよい。' })).content[0].text);
  const nt = fs.readFileSync(path.join(pdir, '.ai', 'tasks', made.task + '.md'), 'utf8');
  assert.match(nt, /owner: chatgpt/); assert.match(nt, /state: 未着手/); assert.match(nt, /## 次にやること\n一覧の画面にテストが無い。\n足すとよい。/);
});
