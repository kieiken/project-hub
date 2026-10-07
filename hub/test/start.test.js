'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const start = require('../lib/start');
const chat = require('../lib/chat');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-start-')));
const root = path.join(tmp, 'workspace'), pdir = path.join(root, 'Product', 'サンプルアプリ');
const port = 48000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let server, sessions;
const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'サンプルアプリ', ...body }) });
async function recordedArgs(pdir, task, captured, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // ChatRunnerは子のclose後にassistant行を保存する。存在だけでは書込完了を保証しない。
    const rows = chat.read(pdir, task), sent = rows.findLastIndex(row => row.role === 'user');
    const completed = sent < 0 ? undefined : rows.slice(sent + 1).find(row => row.role === 'assistant');
    if (completed) {
      assert.ok(!completed.error, `模擬CLIが失敗した：${completed.error}`);
      return JSON.parse(fs.readFileSync(captured, 'utf8'));
    }
    assert.ok(Date.now() < deadline, '模擬CLIの完了通知が期限内に届かない');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nagents: [しおり, つむぎ, りつ]\nroles: {}\n');
  Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'empty-home') });
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.after(async () => { sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('模擬CLIの引数は空・書込済みでも対象会話の完了まで読まず、子失敗と期限切れを検出する', async () => {
  const captured = path.join(tmp, 'sync-argv.json'), task = 'capture-sync';
  fs.writeFileSync(captured, '');
  chat.append(tmp, task, { role: 'assistant', text: '前回の完了' });
  chat.append(tmp, task, { role: 'user', text: '今回' });
  let settled = false;
  const waiting = recordedArgs(tmp, task, captured);
  waiting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '空ファイルや過去の完了では読み進まない');
  const args = ['--model', 'gpt-6.1-sol'];
  fs.writeFileSync(captured, JSON.stringify(args));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '書込完了だけで子の成功を扱わない');
  chat.append(tmp, task, { role: 'assistant', error: '', text: '完了' });
  assert.deepEqual(await waiting, args);
  chat.append(tmp, task, { role: 'user', text: '失敗する子' });
  chat.append(tmp, task, { role: 'assistant', error: '終了コード 7' });
  await assert.rejects(recordedArgs(tmp, task, captured), /模擬CLIが失敗した：終了コード 7/);
  chat.append(tmp, task, { role: 'user', text: '完了しない子' });
  await assert.rejects(recordedArgs(tmp, task, captured, 30), /完了通知が期限内に届かない/);
});

test('画像を作業フォルダへコピーし、選択したCodexの-i・担当・モデル・思考・前回選択を保存する', async () => {
  const upload = await fetch(base + '/api/start/image?project=' + encodeURIComponent('サンプルアプリ') + '&name=test.png', { method: 'POST', headers: { 'X-Hub': '1' }, body: png });
  const image = await upload.json(); assert.equal(upload.status, 200);
  assert.equal(image.path, start.imageFile({dir:pdir}, image.id, true));
  assert.deepEqual(fs.readFileSync(image.path), png);
  assert.deepEqual(Buffer.from(await (await fetch(base + image.url)).arrayBuffer()), png);
  const body = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '極高', text: '文章を保ち、画像を確認', images: [image.id], request: 'req-codex' };
  const res = await post('/api/start', body), r = await res.json(); assert.equal(res.status, 200, r.error);
  assert.equal(r.turn.command, 'codex'); assert.equal(r.turn.args[0], 'exec');
  const i = r.turn.args.indexOf('-i'); assert.ok(i > 0); assert.equal(r.turn.args[i + 1], r.images[0]);
  assert.deepEqual(fs.readFileSync(r.images[0]), png); assert.match(r.images[0], /attachments/);
  assert.match(r.turn.stdin, /文章を保ち、画像を確認/);
  const state = await (await fetch(base + '/api/state')).json(), p = state.projects.find(x => x.id === 'サンプルアプリ'), t = p.tasks.find(x => x.id === r.task);
  assert.equal(t.owner, 'codex'); assert.equal(t.model, body.model); assert.equal(t.effort, body.effort);
  assert.deepEqual(p.startSpec, { ai: body.ai, model: body.model, effort: body.effort });
  assert.equal((await (await post('/api/start', body)).json()).task, r.task, '通信再試行で作業を重複作成しない');
});

test('ClaudeはRead指示、画像のみも開始、Discordは送信しないことを作業画面に明示する', async () => {
  const p = { id: 'サンプルアプリ', dir: pdir }, image = start.saveImage(p, '添付.png', png);
  const claude = await (await post('/api/start', { ai: 'claude', text: '', images: [image.id] })).json();
  assert.equal(claude.turn.command, 'claude'); assert.match(claude.turn.stdin, /これらの画像を Read で見てから始める/);
  assert.ok(!claude.turn.args.includes('-i'));
  const discord = await (await post('/api/start', { ai: 'discord:しおり', text: '確認してください', images: [image.id] })).json();
  assert.equal(discord.agent, true); assert.equal(discord.turn, undefined);
  const pstate = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === p.id);
  const t = pstate.tasks.find(x => x.id === discord.task);
  assert.equal(t.owner, 'discord:しおり'); assert.match(t.question, /自動送信は未対応/);
  assert.ok(chat.read(pdir, t.id).at(-1).text.includes(discord.images[0]));
});

test('Sol・高の初期選択はCLIと会話用作業へ保存し、役割設定と過去の作業を保持する', async () => {
  const rolesFile = path.join(root, '_hub/roles.yaml');
  const roleText = 'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [Astra, GPT-6.1-Sol]\nagents: [しおり, つむぎ, りつ]\nroles:\n  コーディング: { main: [claude-code, Fable 5.1, 極高], backup: [codex, Astra, 極高] }\n';
  fs.writeFileSync(rolesFile, roleText);
  const before = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === 'サンプルアプリ');
  const res = await post('/api/start', { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: '初期選択の確認', images: [] }), r = await res.json();
  assert.equal(res.status, 200, r.error); assert.equal(r.turn.command, 'codex');
  assert.equal(r.turn.args[r.turn.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(r.turn.args.includes('model_reasoning_effort=high'));
  const after = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === 'サンプルアプリ');
  const task = after.tasks.find(x => x.id === r.task);
  assert.equal(task.owner, 'codex'); assert.equal(task.model, 'GPT-6.1-Sol'); assert.equal(task.effort, '高');
  assert.deepEqual(after.startSpec, { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  for (const old of before.tasks) assert.deepEqual(after.tasks.find(x => x.id === old.id), old);
  assert.equal(fs.readFileSync(rolesFile, 'utf8'), roleText);
});

test('子作業のSol・高は保存・再読込・会話とターミナルの起動に通り、既存作業と分岐を保持する', async () => {
  const { Store } = require('../lib/store'), rolesFile = path.join(root, '_hub/roles.yaml');
  const bin = path.join(tmp, 'child-cli'), captured = path.join(tmp, 'child-argv.json'), oldPath = process.env.PATH;
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'turn.completed'}));});\n`, { mode: 0o755 });
  process.env.PATH = bin + ':/usr/bin:/bin';
  const oldRoles = fs.readFileSync(rolesFile, 'utf8');
  const roleText = 'models:\n  claude-code: [Fable 5.1]\n  codex: [Astra, GPT-6.1-Sol]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 極高], backup: [codex, Astra, 極高] }\n';
  fs.writeFileSync(rolesFile, roleText);
  try {
    const parentRes = await post('/api/task/new', { title: '親の司令塔', owner: 'claude-code', role: '司令塔', phase: '設計' });
    const parent = await parentRes.json(); assert.equal(parentRes.status, 200, parent.error);
    const before = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    const made = await post('/api/task/new', { title: '新しい子', parent: parent.id, kind: 'main', derivedFrom: '', owner: 'codex', role: parent.role, phase: parent.phase, model: 'GPT-6.1-Sol', effort: '高' });
    assert.equal(made.status, 200); const child = await made.json();
    const check = task => {
      assert.equal(task.owner, 'codex'); assert.equal(task.model, 'GPT-6.1-Sol'); assert.equal(task.effort, '高');
      assert.equal(task.parent, parent.id); assert.equal(task.phase, '設計'); assert.equal(task.role, '司令塔'); assert.equal(task.kind, 'main');
    };
    check(child);
    const fresh = new Store(root); check(fresh.readTask(fresh.taskFile('サンプルアプリ', child.id)));
    const after = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    check(after.tasks.find(t => t.id === child.id));
    for (const old of before.tasks) assert.deepEqual(after.tasks.find(t => t.id === old.id), old);
    const branched = await post('/api/task/new', { title: '分岐', parent: parent.parent, kind: 'derived', derivedFrom: 'サンプルアプリ/' + parent.id, owner: parent.owner, role: parent.role, phase: parent.phase });
    assert.equal(branched.status, 200); const branch = await branched.json();
    assert.equal(branch.owner, 'claude-code'); assert.equal(branch.model, ''); assert.equal(branch.effort, '');
    assert.equal(branch.derivedFrom, 'サンプルアプリ/' + parent.id); assert.equal(branch.phase, '設計');
    const termRes = await post('/api/term/start', { task: child.id, ai: 'codex' }), term = await termRes.json();
    assert.equal(termRes.status, 200, term.error); assert.equal(term.command, 'codex');
    assert.equal(term.args[term.args.indexOf('--model') + 1], 'gpt-6.1-sol'); assert.ok(term.args.includes('model_reasoning_effort=high'));
    const chatRes = await post('/api/chat/send', { task: child.id, ai: 'codex', text: '子作業の確認' }), result = await chatRes.json();
    assert.equal(chatRes.status, 200, result.error); assert.equal(result.model, 'GPT-6.1-Sol'); assert.equal(result.effort, '高');
    const args = await recordedArgs(pdir, child.id, captured);
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol'); assert.ok(args.includes('model_reasoning_effort=high'));
    check(new Store(root).readTask(fresh.taskFile('サンプルアプリ', child.id)));
    assert.equal(fs.readFileSync(rolesFile, 'utf8'), roleText);
  } finally { fs.writeFileSync(rolesFile, oldRoles); process.env.PATH = oldPath; }
});

test('最大10枚・画像形式・参照範囲を検証し、不正入力では作業を作らない', async () => {
  const p = { id: 'サンプルアプリ', dir: pdir };
  assert.throws(() => start.saveImage(p, 'data.txt', png));
  assert.throws(() => start.imageFile(p, '../PROJECT.md'));
  const before = (await (await fetch(base + '/api/state')).json()).projects[0].tasks.length;
  assert.equal((await post('/api/start', { ai: 'codex', text: 'a', images: Array(11).fill('x') })).status, 400);
  assert.equal((await post('/api/start', { ai: 'unknown', text: 'a', images: [] })).status, 400);
  assert.equal((await post('/api/start', { ai: 'codex', text: 'a', images: ['../file'] })).status, 409);
  assert.equal((await post('/api/start', { ai: 'claude', model: 'fake-model', text: 'a', images: [] })).status, 409);
  assert.equal((await (await fetch(base + '/api/state')).json()).projects[0].tasks.length, before);
});

test('Macの画像パスを追加、GIF/HEICは元を残しPNGへ変換してCLIへ渡す', { skip: process.platform !== 'darwin' }, async () => {
  const input = path.join(tmp, 'source.png'); fs.writeFileSync(input, png);
  const image = await (await post('/api/start/image-path', { path: input })).json(); assert.ok(image.id);
  assert.equal(image.path, start.imageFile({dir:pdir}, image.id, true));
  assert.deepEqual(fs.readFileSync(image.path), png);
  const p = { id: 'サンプルアプリ', dir: pdir };
  for (const ext of ['gif', 'heic']) {
    const source = path.join(tmp, 'source.' + ext);
    execFileSync('/usr/bin/sips', ['-s', 'format', ext, input, '--out', source], { stdio: 'pipe' });
    const saved = start.imageFromPath(p, source), copied = start.copyImages(p, [saved.id], tmp, 'conversion');
    assert.equal(saved.path, start.imageFile(p, saved.id, true));
    assert.match(copied[0], /\.png$/); assert.ok(fs.existsSync(start.imageFile(p, saved.id)));
  }
});

test('Codex再開時も-iをresumeの後に渡す', () => {
  const turn = chat.buildTurn({ ai: 'codex', model: 'GPT-6.1-Sol', meta: { sessions: { codex: 'sid' }, models: { codex: 'GPT-6.1-Sol' } }, rows: [], text: '確認', images: ['/tmp/image.png'] });
  assert.deepEqual(turn.args.slice(-5), ['resume', 'sid', '-i', '/tmp/image.png', '-']);
});

test('非DRYのChatRunnerをローカルCLIで起動して画像引数を実際に受け取り、起動失敗も通知する', async () => {
  const executable = path.join(tmp, 'local-codex');
  fs.writeFileSync(executable, `#!${process.execPath}\nlet text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),text})}})));\n`, {mode:0o755});
  const runner = new chat.ChatRunner();
  let completed; const ended = new Promise(resolve => { completed = resolve; });
  const sent = runner.send({project:'local',task:'local-test',pdir:tmp,dir:tmp,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'画像を見る',images:['/tmp/添付 画像.png'],perm:'./local-codex',onEnd:completed});
  assert.equal(await sent.started, true);
  const row = await ended, captured = JSON.parse(row.text);
  const index = captured.args.indexOf('-i'); assert.equal(captured.args[index+1], '/tmp/添付 画像.png');
  assert.match(captured.text, /画像を見る/);
  const failed = runner.send({project:'local',task:'failure',pdir:tmp,dir:tmp,ai:'codex',text:'a',perm:path.join(tmp,'missing-cli')});
  assert.equal(await failed.started, false); assert.equal(runner.busy('local','failure'), null);
});

test('設定したClaude Opus中の子/分岐は保存・再読込・模擬会話CLIへ通る', async () => {
  const { ModelView } = require('../lib/model-view'), { Store } = require('../lib/store');
  const rolesFile = path.join(root, '_hub/roles.yaml'), oldRoles = fs.readFileSync(rolesFile), oldPath = process.env.PATH;
  const bin = path.join(tmp, 'initial-cli'), captured = path.join(tmp, 'initial-argv.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'result',subtype:'success',result:'見本確認済み'}));});\n`, { mode: 0o755 });
  process.env.PATH = bin + ':/usr/bin:/bin';
  fs.writeFileSync(rolesFile, 'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6.1-Sol]\nroles: {}\n');
  try {
    const initial = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
    const setting = await post('/api/models/initial', initial); assert.equal(setting.status, 200);
    assert.deepEqual(new ModelView(path.join(root, '_hub/model-view.json')).initial(), initial);
    const p = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    const parent = p.tasks[0];
    for (const kind of ['main', 'derived']) {
      const res = await post('/api/task/new', { title: '設定済み' + kind, owner: 'claude-code', model: initial.model, effort: initial.effort, parent: kind === 'main' ? parent.id : parent.parent, kind, derivedFrom: kind === 'derived' ? p.id + '/' + parent.id : '', role: parent.role, phase: parent.phase });
      assert.equal(res.status, 200); const made = await res.json();
      const fresh = new Store(root); const task = fresh.readTask(fresh.taskFile(p.id, made.id));
      assert.equal(task.model, initial.model); assert.equal(task.effort, initial.effort); assert.equal(task.owner, 'claude-code');
      assert.equal(task.role, parent.role); assert.equal(task.phase, parent.phase);
      const term = await (await post('/api/term/start', { task: made.id, ai: 'claude' })).json();
      assert.equal(term.args[term.args.indexOf('--model') + 1], 'claude-opus-5-5'); assert.equal(term.args[term.args.indexOf('--effort') + 1], 'medium');
      if (kind === 'main') {
        const chatRes = await post('/api/chat/send', { task: made.id, ai: 'claude', text: '設定起動確認' }); assert.equal(chatRes.status, 200);
        const args = await recordedArgs(pdir, made.id, captured);
        assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5'); assert.equal(args[args.indexOf('--effort') + 1], 'medium');
      }
    }
    const after = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === p.id);
    for (const old of p.tasks) assert.deepEqual(after.tasks.find(x => x.id === old.id), old);
    assert.deepEqual(after.startSpec, p.startSpec);
  } finally { fs.writeFileSync(rolesFile, oldRoles); process.env.PATH = oldPath; }
});

test('問題解決APIは最新構造を再確認して親なし作業を初期AIで始め、停止中の同じ作業を再利用する', async () => {
  const { Store } = require('../lib/store'), { MARKER } = require('../lib/problem-resolution');
  const pid = '修復API確認', dir = path.join(root, 'Product', pid), fresh = new Store(root);
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: 修復API確認\nphases: []\nfolders: {}\nrelated: []\n---\n');
  fresh.updateTask(pid, 'sample-app-01', { workdir: '' });
  const settings = path.join(root, '_hub/model-view.json'), before = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
  const solve = body => post('/api/maintenance/solve', { project: pid, ...body });
  try {
    const beforeTasks = fresh.readProject(pid).tasks.length;
    const clear = await solve({ checks: [{ ok: false, name: '画面の古い結果' }] });
    assert.equal(clear.status, 200); assert.equal((await clear.json()).clear, true);
    assert.equal(fresh.readProject(pid).tasks.length, beforeTasks);
    const manual = fresh.createTask(pid, { title: '問題解決' });
    fresh.updateTask(pid, manual.id, { workdir: path.join(tmp, 'missing-workdir') });
    const pick = await post('/api/models/initial', { ai: 'claude', model: 'Opus 5.5', effort: '高' }); assert.equal(pick.status, 200);
    const madeRes = await solve({ ai: 'codex', text: '信用しない画面の依頼' }), made = await madeRes.json();
    assert.equal(madeRes.status, 200, made.error); assert.equal(made.reused, false);
    let p = fresh.readProject(pid), t = p.tasks.find(t => t.id === made.task);
    assert.notEqual(t.id, manual.id); assert.equal(t.title, '問題解決'); assert.equal(t.parent, ''); assert.equal(t.via, MARKER);
    assert.equal(t.model, 'Opus 5.5'); assert.equal(t.owner, 'claude-code'); assert.equal(t.effort, '高');
    assert.equal(made.turn.command, 'claude'); assert.equal(made.turn.args[made.turn.args.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.ok(made.turn.stdin.includes('× 作業場所：問題解決'));
    assert.ok(made.turn.stdin.includes('Gitへ保存'));
    assert.ok(!made.turn.stdin.includes('信用しない画面の依頼')); assert.ok(!made.turn.stdin.includes('画面の古い結果'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.ai/start-request.json')));
    assert.equal(receipt.task, made.task); assert.match(receipt.request, /^maintenance-/);
    const again = await (await solve()).json(); assert.equal(again.task, made.task); assert.equal(again.reused, true);
    assert.equal(fresh.readProject(pid).tasks.length, p.tasks.length);
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(dir, '.ai/start-request.json'))).request, receipt.request);
    // すでに動いている同じ解決作業へは移動だけ。別の作業の稼働中は拒否。
    const running = { exited: false, started: Date.now(), lastOut: Date.now() }, key = sessions.key(pid, made.task, 'claude');
    sessions.map.set(key, running);
    try { const r = await solve(); assert.equal(r.status, 200); assert.equal((await r.json()).active, true); }
    finally { sessions.map.delete(key); }
    const otherKey = sessions.key(pid, manual.id, 'claude'); sessions.map.set(otherKey, running);
    try { const r = await solve(); assert.equal(r.status, 409); assert.match((await r.json()).error, /AIまたは検証/); }
    finally { sessions.map.delete(otherKey); }
    fresh.updateTask(pid, manual.id, { workdir: '' });
    assert.equal((await (await solve()).json()).clear, true);
    const approval = await post('/api/task/completion', { project: pid, task: t.id, action: 'approve', confirm: true, expectedHash: fresh.readTask(fresh.taskFile(pid, t.id)).completionHash });
    assert.equal(approval.status, 200);
    fresh.updateTask(pid, manual.id, { workdir: path.join(tmp, 'missing-again') });
    const next = await (await solve()).json(); assert.notEqual(next.task, t.id); assert.equal(next.reused, false);
  } finally {
    if (before) fs.writeFileSync(settings, before); else if (fs.existsSync(settings)) fs.unlinkSync(settings);
  }
});

test('問題解決APIは多数の×を省略せず渡し、通常の開始APIは4000文字上限を維持する', async () => {
  const { Store } = require('../lib/store');
  const pid = '多数修復確認', dir = path.join(root, 'Product', pid), fresh = new Store(root);
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), dir, { recursive: true });
  const file = path.join(dir, 'PROJECT.md');
  // 不在の関連プロジェクトを長い名前で列挙し、構造の失敗だけで4000文字を越える。
  const names = Array.from({ length: 80 }, (_, i) => '欠落' + i + '長い関連名'.repeat(15));
  fs.writeFileSync(file, '---\nname: 多数修復確認\nphases: []\nfolders: {}\nrelated: ' + JSON.stringify(names) + '\n---\n');
  const res = await post('/api/maintenance/solve', { project: pid }), r = await res.json();
  assert.equal(res.status, 200, r.error);
  for (const name of names) assert.ok(r.turn.stdin.includes('× 関連プロジェクト：' + name), name);
  const count = fresh.readProject(pid).tasks.length;
  const normal = await post('/api/start', { project: pid, ai: 'codex', model: 'GPT-6.1-Sol', images: [], text: 'x'.repeat(4001) });
  assert.equal(normal.status, 400); assert.equal(fresh.readProject(pid).tasks.length, count);
});
