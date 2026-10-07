'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
// 子プロジェクトの結果を親が受け取る：完了の承認・作業の完了・［親に結果を渡す］、子の一覧、一覧の子の数
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { lastEntry } = require('../lib/handoff');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-'));
const root = path.join(tmp, 'workspace');
const port = 49500 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const get = async p => (await fetch(base + p)).json();
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const proj = async id => (await get('/api/state')).projects.find(p => p.id === id);
const taskText = (project, task) => fs.readFileSync(path.join(root, 'Product', project, '.ai', 'tasks', `${task}.md`), 'utf8');
const chatRows = (project, task) => { try { return fs.readFileSync(path.join(root, 'Product', project, '.ai', 'chat', `${task}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } };
let server, sessions;
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Product'), { recursive: true });
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nagents: []\nroles: {}\n');
  Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'empty-home') });
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.after(async () => { sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('やったことの最後の項目を取り出す', () => {
  assert.equal(lastEntry('- 一つ目\n- 二つ目\n  続き'), '二つ目\n  続き');
  assert.equal(lastEntry('ただの文\n最後の行'), '最後の行');
  assert.equal(lastEntry(''), '');
});

test('子の完了を承認すると、親の作業に結果が届き、会話・未読・子の一覧・一覧の数に出る', async () => {
  assert.equal((await post('/api/project/new', { name: '親', description: '親の説明' })).status, 200);
  assert.equal((await post('/api/project/new', { name: '子', description: '画面を分けて作る', parent: '親' })).status, 200);
  const recv = (await post('/api/task/new', { project: '親', title: '全体をまとめる' })).body;
  const work = (await post('/api/task/new', { project: '子', title: '画面を作る' })).body;
  const f = path.join(root, 'Product', '子', '.ai', 'tasks', `${work.id}.md`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## やったこと\n', '## やったこと\n- 下書きを作った\n- ログイン画面を作った\n'));

  let parent = await proj('親');
  assert.deepEqual(parent.children, { total: 1, unfinished: 1 });
  let kids = await get('/api/project/children?project=親');
  assert.equal(kids.unfinished, 1);
  assert.equal(kids.children[0].id, '子'); assert.equal(kids.children[0].done, false); assert.equal(kids.children[0].lastReport, null);

  // 作業の完了を承認 → 「作業の完了」
  const t = (await proj('子')).tasks.find(x => x.id === work.id);
  assert.equal((await post('/api/task/completion', { project: '子', task: work.id, action: 'approve', confirm: true, expectedHash: t.completionHash })).status, 200);
  assert.match(taskText('親', recv.id), /子プロジェクト「子」作業の完了：画面を作る \/ ログイン画面を作った/);

  // プロジェクトの完了を承認 → 「完了」
  const c = await proj('子');
  const st = await post('/api/project/status', { project: '子', status: '完了', confirm: true, expectedHash: c.completionHash });
  assert.equal(st.status, 200); assert.equal(st.body.status, '完了');
  const text = taskText('親', recv.id);
  assert.match(text, /## やったこと\n- \d{4}-\d\d-\d\d \d\d:\d\d 子プロジェクト「子」作業の完了：/);
  assert.match(text, /子プロジェクト「子」完了：画面を分けて作る \/ 作業：全1件（完了1件） \/ 最新の作業：画面を作る \/ やったこと：ログイン画面を作った/);
  const rows = chatRows('親', recv.id).filter(r => r.from === 'child');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].role, 'user'); assert.equal(rows[1].child, '子');
  assert.match(rows[1].text, /^（子プロジェクト「子」の完了）\n画面を分けて作る\n作業：全1件/);

  const state = await get('/api/state');
  assert.ok(state.unread.some(u => u.project === '親' && u.task === recv.id));
  parent = state.projects.find(p => p.id === '親');
  assert.deepEqual(parent.children, { total: 1, unfinished: 0 });
  assert.deepEqual(state.projects.find(p => p.id === '子').children, { total: 0, unfinished: 0 });
  kids = await get('/api/project/children?project=親');
  assert.equal(kids.unfinished, 0);
  assert.equal(kids.children[0].done, true); assert.equal(kids.children[0].status, '完了');
  assert.deepEqual(kids.children[0].tasks, { total: 1, done: 1, waiting: 0 });
  assert.match(kids.children[0].lastReport.text, /^画面を分けて作る/);
  const log = fs.readFileSync(path.join(root, '_hub', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.action === 'childreport');
  assert.equal(log.length, 2); assert.equal(log[0].project, '親'); assert.equal(log[0].task, recv.id); assert.equal(log[0].child, '子');
  assert.equal((await fetch(`${base}/api/project/children?project=ない`)).status, 404);
});

test('［親に結果を渡す］は同じ内容を2回渡さない。文が無ければ最新のやったこと、親が無ければ断る', async () => {
  const one = await post('/api/project/handoff', { project: '子', text: '見た目の確認が済んだ' });
  assert.equal(one.status, 200); assert.equal(one.body.ok, true); assert.equal(one.body.parent, '親'); assert.equal(one.body.duplicate, false);
  const two = await post('/api/project/handoff', { project: '子', text: '見た目の確認が済んだ' });
  assert.equal(two.status, 200); assert.equal(two.body.task, one.body.task); assert.equal(two.body.duplicate, true);
  assert.equal(taskText('親', one.body.task).split('子プロジェクト「子」報告：見た目の確認が済んだ').length, 2);
  assert.equal(chatRows('親', one.body.task).filter(r => /の報告）\n見た目の確認が済んだ$/.test(r.text)).length, 1);
  assert.match(taskText('親', (await post('/api/project/handoff', { project: '子' })).body.task), /子プロジェクト「子」報告：ログイン画面を作った/);
  assert.equal((await post('/api/project/handoff', { project: '親', text: 'x' })).status, 400);
  assert.equal((await post('/api/project/handoff', { project: 'ない', text: 'x' })).status, 400);
});

test('派生元の親に開いた作業が無ければ「子プロジェクトの結果」を作って受け取る', async () => {
  assert.equal((await post('/api/project/new', { name: '元' })).status, 200);
  assert.equal((await post('/api/project/new', { name: '派生', derivedFrom: '元' })).status, 200);
  assert.deepEqual((await proj('元')).children, { total: 1, unfinished: 1 });
  const r = await post('/api/project/handoff', { project: '派生', text: '調べた結果' });
  assert.equal(r.status, 200); assert.equal(r.body.parent, '元');
  const t = (await proj('元')).tasks.find(x => x.id === r.body.task);
  assert.equal(t.title, '子プロジェクトの結果'); assert.equal(t.owner, 'claude-code'); assert.equal(t.state, '未着手');
  assert.match(taskText('元', t.id), /子プロジェクト「派生」報告：調べた結果/);
});

test('子の分岐は共通の親ではなく分岐元へ報告する',async()=>{
  await post('/api/project/new',{name:'子の別案',parent:'親',derivedFrom:'子'});
  const r=await post('/api/project/handoff',{project:'子の別案',text:'比較結果'});
  assert.equal(r.status,200);assert.equal(r.body.parent,'子');
  assert.match(taskText('子',r.body.task),/比較結果/);
});
