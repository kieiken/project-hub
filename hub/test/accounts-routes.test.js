'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const chat = require('../lib/chat');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-account-routes-')));
const root = path.join(tmp, 'workspace'), dir = path.join(root, 'Product', 'Accounts fixture'), home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin');
let server, sessions, base, counter = 0;
const fakeAuth = { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'fixture-only', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9', CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/fixture-only', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture-only' };
const task = (role = '') => {
  const id = 'account-' + ++counter;
  fs.writeFileSync(path.join(dir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: test\nowner: codex\nrole: ${role}\nstate: 未着手\nworkspaceMode: shared\nworkdir: ${dir}\n---\n`);
  return id;
};
const post = (route, body = {}, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close', ...headers }, body: JSON.stringify({ ...(route === '/api/acceleration' ? {} : { project: 'Accounts fixture' }), ...body }) });
async function ok(route, body) { const r = await post(route, body), d = await r.json(); assert.equal(r.status, 200, d.error); return d; }
const add = async (ai, name) => (await ok('/api/accounts', { ai, name })).account;
const select = (id, ai, account) => ok('/api/accounts/select', { task: id, ai, id: account });
const replies = id => chat.read(dir, id).filter(r => r.role === 'assistant');
const capture = id => JSON.parse(replies(id).at(-1).text);
async function wait(pred) { for (let i = 0; i < 250; i++) { if (pred()) return; await new Promise(r => setTimeout(r, 10)); } assert.ok(pred(), 'mock finished'); }
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Accounts fixture\nstatus: 進行中\nfolders: {}\nrelated: []\nphases: []\n---\n');
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6.1-Sol, Astra]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 高], backup: [codex, Astra, 高] }\nswitch:\n  auto: true\n');
  for (const ai of ['claude', 'codex']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const ai=${JSON.stringify(ai)},profile=process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR||'default';
const info=JSON.stringify({ai,profile,args:process.argv.slice(2),input,api:process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||null,authKeys:${JSON.stringify(Object.keys(fakeAuth))}.filter(key=>process.env[key]!==undefined)});
const out=x=>console.log(JSON.stringify(x));
const finish=()=>{if(ai==='codex'){out({type:'thread.started',thread_id:'mock-'+profile});out({type:'item.completed',item:{type:'agent_message',text:info}});out({type:'turn.completed'});}else{out({type:'system',session_id:'mock-'+profile});out({type:'assistant',message:{content:[{type:'text',text:info}]}});out({type:'result',is_error:false,result:''});}};
if(input.slice(input.lastIndexOf('# 今回の依頼')).includes('HOLD')){fs.writeFileSync(path.join(${JSON.stringify(tmp)},'started-'+path.basename(profile)),'yes');const timer=setInterval(()=>{if(fs.existsSync(path.join(${JSON.stringify(tmp)},'release-'+path.basename(profile)))){clearInterval(timer);finish();}},10);}else finish();
});
`, { mode: 0o755 });
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  Object.assign(process.env, fakeAuth, { PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_AI_HOME: home, HUB_TRASH: path.join(tmp, 'trash'), HUB_DRY_RUN: '1', HUB_PORT: String(48000 + Math.floor(Math.random() * 1000)) });
  ({ server, sessions } = require('../server')); await new Promise(r => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { sessions.stopAll(); await new Promise(r => server.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });
test('account writes require Hub/Origin; status is dry, Agy named accounts rejected', async () => {
  assert.equal((await post('/api/accounts', { ai: 'codex', name: 'x' }, { 'X-Hub': '' })).status, 403);
  assert.equal((await post('/api/accounts', { ai: 'codex', name: 'x' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('/api/accounts', { ai: 'agy', name: 'x' })).status, 400);
  assert.equal((await fetch(base + '/api/accounts?status=1')).status, 403);
  const d = await (await fetch(base + '/api/accounts?status=1', { headers: { 'X-Hub': '1' } })).json();
  assert.ok(d.accounts.every(r => r.status === 'unknown')); assert.equal(d.accounts.length, 4);
});
test('selection applies to task chat, embedded terminal, external terminal, login and usage', async () => {
  const x = await add('codex', '仕事用'), id = task(); await select(id, 'codex', x.id);
  const term = await ok('/api/term/start', { task: id, ai: 'codex' }); assert.equal(term.accountEnv.CODEX_HOME, x.dir); assert.equal(term.account, x.id);
  const external = await ok('/api/continue', { task: id, ai: 'codex' }); assert.match(external.command, /CODEX_HOME=/); assert.ok(external.command.includes(x.dir));
  const login = await ok('/api/accounts/login', { ai: 'codex', id: x.id }); assert.equal(login.dry, true); assert.match(login.command, /--device-auth/); assert.ok(login.command.includes(x.dir));
  await ok('/api/chat/send', { task: id, ai: 'codex', text: 'first' }); await wait(() => replies(id).length === 1);
  assert.equal(capture(id).profile, x.dir); assert.equal(capture(id).api, null);
  assert.ok(capture(id).args.includes('model_provider="openai"'));
  const usage = await (await fetch(base + '/api/usage?project=Accounts%20fixture&task=' + id, { headers: { 'X-Hub': '1' } })).json();
  assert.equal(usage.providers.codex.account, x.id); assert.equal(usage.providers.codex.accountName, x.name);
  assert.ok(usage.accountProviders.some(p=>p.ai==='codex'&&p.account===x.id&&p.accountName===x.name&&p.inUse));
  assert.ok(usage.accountProviders.some(p=>p.ai==='codex'&&p.account==='default'&&!p.inUse));
  assert.ok(usage.accountProviders.every(p=>!('email' in p)&&!('dir' in p)));
  const logout = await ok('/api/accounts/logout', { ai: 'codex', id: x.id, confirm: true }); assert.equal(logout.dry, true);
});
test('default remains no-env and default logout needs explicit second confirmation', async () => {
  const id = task(), term = await ok('/api/term/start', { task: id, ai: 'codex' }); assert.deepEqual(term.accountEnv, {});
  assert.equal((await post('/api/accounts/logout', { ai: 'codex', confirm: true })).status, 400);
  assert.equal((await ok('/api/accounts/logout', { ai: 'codex', confirm: true, confirmDefault: true })).dry, true);
  assert.equal((await post('/api/accounts/delete', { ai: 'codex', confirm: true })).status, 400);
});
test('explicit terminal account stays pinned when the task selection has since changed', async () => {
  const x = await add('codex', 'request account'), y = await add('codex', 'later selection'), id = task();
  await select(id, 'codex', y.id);
  const term = await ok('/api/term/start', { task: id, ai: 'codex', account: x.id });
  assert.equal(term.account, x.id); assert.equal(term.accountEnv.CODEX_HOME, x.dir);
  const external = await ok('/api/continue', { task: id, ai: 'codex', account: x.id });
  assert.ok(external.command.includes(x.dir)); assert.ok(!external.command.includes(y.dir));
  assert.equal(chat.readMeta(dir, id).accounts.codex, y.id);
});
test('mock Claude chat strips OAuth/session/FD/file inputs only for added accounts', async () => {
  const c = await add('claude', 'isolated'), named = task(), original = task();
  await select(named, 'claude', c.id);
  await ok('/api/chat/send', { task: named, ai: 'claude', model: 'claude-opus-5-5', text: 'mock only' });
  await ok('/api/chat/send', { task: original, ai: 'claude', model: 'claude-opus-5-5', text: 'mock default only' });
  await wait(() => replies(named).length === 1 && replies(original).length === 1);
  assert.equal(capture(named).profile, c.dir); assert.deepEqual(capture(named).authKeys, []);
  assert.deepEqual(capture(original).authKeys, Object.keys(fakeAuth));
  for (const route of ['/api/continue', '/api/accounts/login']) {
    const result = await ok(route, { task: named, ai: 'claude', id: c.id });
    for (const key of Object.keys(fakeAuth)) assert.ok(result.command.includes("'-u' '" + key + "'"), key);
  }
});
test('concurrent distinct accounts stay isolated, busy logout/delete refused, selected changes survive completion', async () => {
  const x = await add('codex', 'one'), y = await add('codex', 'two'), one = task(), two = task();
  await select(one, 'codex', x.id); await select(two, 'codex', y.id);
  await Promise.all([ok('/api/chat/send', { task: one, ai: 'codex', text: 'HOLD one' }), ok('/api/chat/send', { task: two, ai: 'codex', text: 'HOLD two' })]);
  await wait(() => fs.existsSync(path.join(tmp, 'started-' + x.id)) && fs.existsSync(path.join(tmp, 'started-' + y.id)));
  for (const action of ['login', 'logout', 'delete']) assert.equal((await post('/api/accounts/' + action, { ai: 'codex', id: x.id, confirm: true })).status, 409);
  await select(one, 'codex', y.id);
  fs.writeFileSync(path.join(tmp, 'release-' + x.id), 'go'); fs.writeFileSync(path.join(tmp, 'release-' + y.id), 'go');
  await wait(() => replies(one).length === 1 && replies(two).length === 1);
  assert.equal(capture(one).profile, x.dir); assert.equal(capture(two).profile, y.dir);
  assert.equal(chat.readMeta(dir, one).accounts.codex, y.id); assert.equal(chat.readMeta(dir, one).sessionAccounts.codex, x.id);
  const next = await ok('/api/chat/send', { task: one, ai: 'codex', text: 'after switching' }); assert.equal(next.resume, false);
  await wait(() => replies(one).length === 2); assert.equal(capture(one).profile, y.dir); assert.match(capture(one).input, /HOLD one/);
  const again = await ok('/api/chat/send', { task: one, ai: 'codex', text: 'same account' }); assert.equal(again.resume, true);
  await wait(() => replies(one).length === 3);
});
test('saved queues block deletion, live terminal blocks selection, removed selections fail closed', async () => {
  const x = await add('codex', 'queued'), y = await add('codex', 'new'), id = task(); await select(id, 'codex', x.id);
  sessions.pty = { spawn() { let exit; return { onData() {}, onExit(cb) { exit = cb; }, kill() { exit({ exitCode: 0 }); } }; } };
  sessions.start({ project: 'Accounts fixture', task: id, ai: 'codex', dir, command: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
  // A saved queue is created directly by the runner; no real AI or subscription is started.
  const runner = new chat.ChatRunner({ dirOf: () => dir }); runner.enqueue('Accounts fixture', id, { ai: 'codex', account: x.id, text: 'saved' });
  assert.equal((await post('/api/accounts/delete', { ai: 'codex', id: x.id, confirm: true })).status, 409);
  assert.equal((await post('/api/accounts/select', { task: id, ai: 'codex', id: y.id })).status, 409);
  sessions.stopAll(); await wait(() => sessions.list().every(s => !s.running));
  await select(id, 'codex', y.id); assert.equal(runner.queue('Accounts fixture', id)[0].account, x.id);
  await ok('/api/chat/unqueue', { task: id, id: runner.queue('Accounts fixture', id)[0].id });
  await ok('/api/accounts/delete', { ai: 'codex', id: y.id, confirm: true });
  assert.equal((await post('/api/chat/send', { task: id, ai: 'codex', text: 'must not default' })).status, 409);
  assert.equal(replies(id).length, 0); assert.ok(fs.readdirSync(path.join(tmp, 'trash')).some(f => f.includes(y.id)));
});
test('chat and delegate queues execute with their reception account after selection changes', async () => {
  const x = await add('codex', 'queue-source'), y = await add('codex', 'later'), id = task();
  await select(id, 'codex', x.id); await ok('/api/chat/send', { task: id, ai: 'codex', text: 'HOLD queue' });
  await wait(() => fs.existsSync(path.join(tmp, 'started-' + x.id)));
  await ok('/api/chat/send', { task: id, ai: 'codex', text: 'queued-chat', mode: 'queue' });
  await ok('/api/delegate', { task: id, ai: 'codex', model: 'gpt-6.1-sol', title: 'mock', text: 'queued-delegate' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.ai/chat', id + '.queue.json')));
  assert.deepEqual(saved.map(q => q.account), [x.id, x.id]);
  await select(id, 'codex', y.id); fs.writeFileSync(path.join(tmp, 'release-' + x.id), 'go');
  await wait(() => replies(id).length === 3);
  assert.ok(replies(id).every(r => r.account === x.id && JSON.parse(r.text).profile === x.dir));
  assert.equal(chat.readMeta(dir, id).accounts.codex, y.id);
});
test('Fable preflight and manual clear affect only their Claude account and retain Astra policy', async () => {
  const x = await add('claude', 'limited'), y = await add('claude', 'other'), z = await add('codex', 'backup'), one = task('司令塔'), two = task('司令塔');
  await select(one, 'claude', x.id); await select(two, 'claude', y.id); await select(one, 'codex', z.id);
  const now = new Date().toISOString(), evidence = { version: 2, source: 'cli-limit', hold: true, at: now, lastLimitAt: now, project: 'Accounts fixture', task: one, request: 'mock', validUntil: null, untilSource: 'unknown', checkedAt: null };
  fs.writeFileSync(path.join(root, '_hub/limits.json'), JSON.stringify({ ['claude-fable-5-1:' + x.id]: evidence, ['claude-fable-5-1:' + y.id]: evidence }));
  const usage = await (await fetch(base + '/api/usage?project=Accounts%20fixture&task=' + one, { headers: { 'X-Hub': '1' } })).json(); assert.equal(usage.fableLimit.account, x.id);
  const cleared = await ok('/api/limits/fable/clear', { task: two }); assert.equal(cleared.fableLimit, null);
  await ok('/api/chat/send', { task: one, ai: 'claude', model: 'claude-fable-5-1', text: 'account limit' });
  await ok('/api/chat/send', { task: two, ai: 'claude', model: 'claude-fable-5-1', text: 'other account' });
  await wait(() => replies(one).length === 1 && replies(two).length === 1);
  assert.equal(capture(one).ai, 'codex'); assert.equal(capture(one).profile, z.dir); assert.ok(capture(one).args.includes('gpt-6-astra'));
  assert.equal(capture(two).ai, 'claude'); assert.equal(capture(two).profile, y.dir);
  assert.equal(chat.read(dir, one).find(r => r.limitSwitch)?.limitSwitch.sourceAccount, x.id);
  await ok('/api/limits/fable/clear', { task: one });
  await ok('/api/chat/send', { task: one, ai: 'claude', model: 'claude-fable-5-1', text: 'after clear' });
  await wait(() => replies(one).length === 2); assert.equal(capture(one).ai, 'claude'); assert.equal(capture(one).profile, x.dir);
});
test('Fast permission alone never accelerates; task picks gate every launch and request fast is ignored', async () => {
  const one = task(), two = task();
  await ok('/api/acceleration', { codexAllowed: false });
  assert.equal((await post('/api/acceleration/task', { task: 'missing', on: false })).status, 404);
  assert.equal((await post('/api/acceleration/task', { task: one, on: 'true' })).status, 400);
  assert.equal((await post('/api/acceleration/task', { task: one, on: true })).status, 409);
  assert.equal((await post('/api/acceleration/task', { task: one, on: false }, { 'X-Hub': '' })).status, 403);
  await ok('/api/acceleration/task', { task: one, on: false });
  await ok('/api/acceleration', { codexAllowed: true });
  await ok('/api/acceleration/task', { task: one, on: true });
  // Creation never copies the parent's Fast preference, even if a caller supplies it.
  for (const spec of [{}, { parent: one }, { kind: 'derived', derivedFrom: one }]) {
    const fresh = await ok('/api/task/new', { title: 'mock fresh Fast default', owner: 'codex', codexFast: true, ...spec });
    assert.notEqual(chat.readMeta(dir, fresh.id).codexFast, true);
    const term = await ok('/api/term/start', { task: fresh.id, ai: 'codex', fast: true });
    assert.ok(!term.args.includes('service_tier="fast"'));
  }
  for (const allowed of [true, false, true]) {
    await ok('/api/acceleration', { codexAllowed: allowed });
    for (const id of [one, two]) {
      const fast = allowed && id === one;
      const term = await ok('/api/term/start', { task: id, ai: 'codex', fast: true });
      assert.equal(term.args.includes('service_tier="fast"'), fast);
      assert.equal(term.args.join('\n').includes('加速ON（Fast）'), fast);
      const external = await ok('/api/continue', { task: id, ai: 'codex', fast: true });
      assert.equal(external.command.includes('service_tier="fast"'), fast);
      const handoff = await ok('/api/term/handoff', { task: id, from: 'claude', to: 'codex', fast: true });
      assert.equal(handoff.args.includes('service_tier="fast"'), fast);
      const count = replies(id).length;
      await ok('/api/chat/send', { task: id, ai: 'codex', fast: true, text: 'mock gating' });
      await wait(() => replies(id).length === count + 1);
      assert.equal(capture(id).args.includes('service_tier="fast"'), fast);
      assert.equal(capture(id).input.split('\n').find(line => line.startsWith('【この番の起動】')).includes('加速ON（Fast）'), fast);
      assert.equal(chat.read(dir, id).findLast(r => r.role === 'user').fast, fast);
      await ok('/api/delegate', { task: id, ai: 'codex', model: 'gpt-6.1-sol', title: 'mock', text: 'mock delegate', fast: true });
      await wait(() => replies(id).length === count + 2);
      assert.equal(capture(id).args.includes('service_tier="fast"'), fast);
    }
    assert.equal(chat.readMeta(dir, one).codexFast, true);
  }
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.acceleration.codexAllowed, true);
  assert.equal(state.projects[0].tasks.find(t => t.id === one).codexFast, true);
  assert.equal(state.projects[0].tasks.find(t => t.id === two).codexFast, false);
  await ok('/api/acceleration', { codexAllowed: false });
  await ok('/api/acceleration/task', { task: one, on: false });
});
test('queued chat/delegate use current task/permission, preserve changes during a running turn', async () => {
  for (const turnOff of ['task', 'permission']) {
    const id = task(), x = await add('codex', 'Fast queue ' + turnOff);
    await select(id, 'codex', x.id);
    await ok('/api/acceleration', { codexAllowed: true });
    await ok('/api/acceleration/task', { task: id, on: true });
    await ok('/api/chat/send', { task: id, ai: 'codex', text: 'HOLD mock Fast queue' });
    await wait(() => fs.existsSync(path.join(tmp, 'started-' + x.id)));
    await ok('/api/chat/send', { task: id, ai: 'codex', fast: true, text: 'queued mock', mode: 'queue' });
    await ok('/api/delegate', { task: id, ai: 'codex', model: 'gpt-6.1-sol', text: 'queued mock delegate', title: 'mock', fast: true });
    // Even a forged persisted Fast field cannot authorize acceleration.
    const queueFile = path.join(dir, '.ai/chat', id + '.queue.json');
    const queued = JSON.parse(fs.readFileSync(queueFile)); queued.forEach(q => { q.fast = true; }); fs.writeFileSync(queueFile, JSON.stringify(queued));
    if (turnOff === 'task') await ok('/api/acceleration/task', { task: id, on: false });
    else await ok('/api/acceleration', { codexAllowed: false });
    fs.writeFileSync(path.join(tmp, 'release-' + x.id), 'go');
    await wait(() => replies(id).length === 3);
    assert.deepEqual(replies(id).map(r => JSON.parse(r.text).args.includes('service_tier="fast"')), [true, false, false]);
    assert.equal(chat.readMeta(dir, id).codexFast, turnOff === 'permission');
  }
});
test('Fable preflight Astra obeys task Fast; empty/new task metadata stays OFF', async () => {
  const one = task('司令塔'), two = task('司令塔');
  const limited = await add('claude', 'Fast limit');
  for (const id of [one, two]) await select(id, 'claude', limited.id);
  await ok('/api/acceleration', { codexAllowed: true });
  await ok('/api/acceleration/task', { task: one, on: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(root, '_hub/limits.json'), JSON.stringify({ ['claude-fable-5-1:' + limited.id]: { version: 2, source: 'cli-limit', hold: true, at, lastLimitAt: at, project: 'Accounts fixture', task: one, request: 'mock', validUntil: null, untilSource: 'unknown', checkedAt: null } }));
  for (const id of [one, two]) {
    await ok('/api/chat/send', { task: id, ai: 'claude', model: 'claude-fable-5-1', text: 'mock preflight', fast: true });
    await wait(() => replies(id).length === 1);
    assert.equal(capture(id).ai, 'codex');
    assert.ok(capture(id).args.includes('gpt-6-astra'));
    assert.equal(capture(id).args.includes('service_tier="fast"'), id === one);
  }
  await ok('/api/limits/fable/clear', { task: one });
  await ok('/api/acceleration', { codexAllowed: false });
});

test('Gemini auth routes open interactive Terminal with API env removed, default confirmation and no named accounts', async () => {
  for (const route of ['/api/accounts/login', '/api/accounts/logout']) {
    const result = await ok(route, {ai:'agy', confirm:true, confirmDefault:true});
    assert.equal(result.dry, true); assert.match(result.command, /env.*'-u' 'GEMINI_API_KEY'/);
    assert.ok(result.command.endsWith("'agy'")); assert.ok(!result.command.includes("'logout'"));
    assert.match(result.warning, route.endsWith('logout') ? /\/logout/ : /\/login/);
    assert.equal((await post(route, {ai:'agy', id:'named', confirm:true, confirmDefault:true})).status, 400);
  }
  assert.equal((await post('/api/accounts/logout', {ai:'agy', confirm:true})).status,400);
  assert.equal((await post('/api/accounts/delete', {ai:'agy', confirm:true})).status,400);
  assert.equal((await post('/api/accounts/login', {ai:'chatgpt'})).status,400);
});
