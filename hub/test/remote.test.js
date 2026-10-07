'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
// 外から使う（iPhone）：中継された通信の見分け・合言葉のログイン・ログイン後の作業操作
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Remote, isRemote, whoOf, cookieOf } = require('../lib/remote');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remote-'));
const root = path.join(tmp, 'workspace'), pdir = path.join(root, 'Product', 'サンプルアプリ');
const FILE = path.join(root, '_hub', 'remote.json');
const port = 49000 + Math.floor(Math.random() * 500);
const HOST = 'mac.tail1234.ts.net';
const REMOTE = { Host: HOST, 'X-Forwarded-For': '100.64.0.7', 'X-Forwarded-Host': HOST, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': 'owner@example.com' };
// fetch は Host を変えられないので http で送る（tailscale serve は元の Host のまま中継する）
const http = require('http');
function call(p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port, path: encodeURI(p), method, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: { get: k => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, text: async () => text, json: async () => JSON.parse(text) }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
const local = (p, body, headers = {}) => call(p, body === undefined ? { headers } : { method: 'POST', headers: { 'X-Hub': '1', ...headers }, body });
const remoteReq = (p, { body, cookie, headers = {}, method } = {}) => call(p, {
  method: method || (body === undefined ? 'GET' : 'POST'), body,
  headers: { ...REMOTE, ...(body === undefined ? {} : { 'X-Hub': '1', Origin: `https://${HOST}` }), ...(cookie ? { Cookie: cookie } : {}), ...headers } });
let server, sessions, deletionFixture;
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  const body = path.join(tmp, 'SampleApp'); fs.mkdirSync(body, { recursive: true });
  const projectFile = path.join(pdir, 'PROJECT.md');
  fs.writeFileSync(projectFile, fs.readFileSync(projectFile, 'utf8').replace('~/Documents/SampleApp', body));
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nagents: []\nroles: {}\n');
  const {Store}=require('../lib/store'),fixtureStore=new Store(root);
  const parent=fixtureStore.createTask('サンプルアプリ',{title:'Parent fixture'}),child=fixtureStore.createTask('サンプルアプリ',{title:'Child fixture',parent:parent.id});
  const parentChat=path.join(pdir,'.ai/chat',parent.id+'.jsonl'),childChat=path.join(pdir,'.ai/chat',child.id+'.jsonl');fs.mkdirSync(path.dirname(parentChat),{recursive:true});fs.writeFileSync(parentChat,'parent result');fs.writeFileSync(childChat,'child result');
  deletionFixture={parent:parent.id,child:child.id,parentChat,childChat,taskFile:fixtureStore.taskFile('サンプルアプリ',child.id)};
  fs.writeFileSync(path.join(root,'_hub/unread.json'),JSON.stringify({items:['サンプルアプリ\u0000'+parent.id,'サンプルアプリ\u0000'+child.id]}));
  Object.assign(process.env, { HUB_TRASH:path.join(tmp,'Trash'), HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'empty-home') });
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.after(async () => { sessions.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('中継の印がある通信だけを外からとみなす', () => {
  assert.equal(isRemote({ headers: { host: '127.0.0.1:4545' } }), false);
  for (const h of ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host']) assert.equal(isRemote({ headers: { [h]: 'x' } }), true, h);
  assert.equal(whoOf({ headers: { 'x-forwarded-for': '100.1.1.1, 127.0.0.1' } }), '100.1.1.1');
  assert.equal(whoOf({ headers: { 'tailscale-user-login': 'a@b', 'x-forwarded-for': '1.1.1.1' } }), 'a@b');
  assert.equal(cookieOf({ headers: { cookie: 'a=1; hub_session=tok%2B; b=2' } }), 'tok+');

});

test('合言葉は scrypt で保存し、5回まちがえると15分止まる（時間が過ぎれば戻る）', () => {
  let now = Date.parse('2026-10-04T00:00:00Z');
  const f = path.join(tmp, 'unit', 'remote.json'), r = new Remote({ file: f, now: () => now });
  assert.match(r.update({ enabled: true }).error, /合言葉/);
  assert.match(r.update({ passcode: 'short' }).error, /8文字/);
  assert.equal(r.update({ passcode: 'correct horse', enabled: true }).ok, true);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.match(saved.passcodeHash, /^[0-9a-f]{64}$/); assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /correct horse/);
  assert.equal(JSON.stringify(r.status()).includes(saved.passcodeHash), false);
  for (let i = 0; i < 4; i++) assert.equal(r.login('wrong', 'a').status, 401);
  assert.equal(r.login('wrong', 'a').status, 423);
  assert.equal(r.login('correct horse', 'a').status, 423); // 止まっている間は正しくても入れない
  assert.equal(r.login('correct horse', 'b').ok, true); // 別の相手は入れる
  now += 15 * 60000 + 1;
  const ok = r.login('correct horse', 'a'); assert.equal(ok.ok, true);
  assert.ok(r.check(ok.token)); assert.equal(r.check('nope'), null);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).sessions.some(s => s.id === ok.token), false); // 札そのものは残さない
  now += 30 * 86400000; assert.equal(r.check(ok.token), null); // 30日で切れる
});

test('Mac の中からの通信は今まで通り（オフでも使え、印の無い別の Host は断る）', async () => {
  assert.equal((await local('/api/state')).status, 200);
  assert.equal((await local('/api/state', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await local('/api/task/read', {}, { Origin: 'https://evil.example' })).status, 403);
  const st = await (await local('/api/state')).json(); assert.deepEqual(st.remote, { enabled: false });
  const r = await (await local('/api/remote')).json();
  assert.deepEqual({ enabled: r.enabled, hasPasscode: r.hasPasscode, sessions: r.sessions }, { enabled: false, hasPasscode: false, sessions: [] });
  assert.equal('passcodeHash' in r || 'salt' in r, false);
});

test('オフの間は外からの通信をすべて断る', async () => {
  let res = await remoteReq('/api/state'); assert.equal(res.status, 403); assert.equal((await res.json()).error, '外からの利用はオフです');
  res = await remoteReq('/'); assert.equal(res.status, 403); assert.match(res.headers.get('content-type'), /text\/html/); assert.match(await res.text(), /外からの利用はオフです/);
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'x' } })).status, 403);
});

let cookie = '';
test('オンにすると合言葉でログインし、札（Cookie）が無ければ見るだけでも断る', async () => {
  assert.equal((await local('/api/remote', { enabled: true })).status, 400); // 合言葉が先
  assert.equal((await local('/api/remote', { passcode: '1234567' })).status, 400);
  assert.equal((await local('/api/remote', { passcode: 'iphone-pass-1' })).status, 200);
  const on = await (await local('/api/remote', { enabled: true })).json(); assert.equal(on.enabled, true); assert.equal(on.hasPasscode, true);
  assert.equal((await (await local('/api/state')).json()).remote.enabled, true);
  // ログインしていなければ設定にも触れない
  assert.equal((await remoteReq('/api/remote', { body: { enabled: false } })).status, 401);

  let res = await remoteReq('/api/state'); assert.equal(res.status, 401);
  res = await remoteReq('/'); assert.equal(res.status, 302); assert.equal(res.headers.get('location'), '/login');
  res = await remoteReq('/login'); assert.equal(res.status, 200); assert.match(await res.text(), /合言葉/);
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' }, headers: { 'X-Hub': '' } })).status, 403); // 画面からの印が要る
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'wrong-pass' } })).status, 401);
  res = await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' }, headers: { 'User-Agent': 'iPhone Safari' } });
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  assert.match(set, /^hub_session=[\w-]+;/); for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000', 'Path=/']) assert.ok(set.includes(a), a);
  cookie = set.split(';')[0];
  assert.equal((await remoteReq('/api/state', { cookie: 'hub_session=forged' })).status, 401);
  res = await remoteReq('/api/state', { cookie }); assert.equal(res.status, 200); assert.equal((await res.json()).remote.enabled, true);
  assert.equal((await remoteReq('/', { cookie })).status, 200);
  assert.equal((await remoteReq('/app.js', { cookie })).status, 200);
  const r = await (await local('/api/remote')).json();
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].ua, 'iPhone Safari'); assert.equal(r.url, `https://${HOST}`);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(cookie.split('=')[1]));
});

test('ログイン後は作業と設定をMacと同じ条件で操作し、未認証・別サイトからの変更は断る', async () => {
  const identity = { project: 'サンプルアプリ', task: 'sample-app-01' };
  for (const route of ['/api/task/new', '/api/task/step', '/api/roles', '/api/term/start', '/api/hierarchy/rename', '/api/maintenance/preview', '/api/task/merge']) {
    assert.equal((await remoteReq(route, { body: identity })).status, 401, route);
    for (const headers of [{ 'X-Hub': '' }, { Origin: 'https://evil.example' }])
      assert.equal((await remoteReq(route, { cookie, body: identity, headers })).status, 403, route);
  }
  for (const route of ['/api/remote', '/api/mcp/tools']) {
    assert.equal((await remoteReq(route, { cookie, headers: { 'X-Hub': '1' } })).status, 200, route);
  }
  let res = await remoteReq('/api/task', { cookie, body: { ...identity, memo: 'iPhone から', owner: 'codex', model: 'GPT-6.1-Sol', effort: 'high' } });
  assert.equal(res.status, 200); const task = await res.json();
  assert.equal(task.owner, 'codex'); assert.equal(task.model, 'GPT-6.1-Sol'); assert.equal(task.effort, 'high');
  res = await remoteReq('/api/task/step', { cookie, body: { ...identity, add: '遠隔fixtureの手順' } });
  assert.equal(res.status, 200); assert.equal((await res.json()).steps.at(-1).text, '遠隔fixtureの手順');
  res = await remoteReq('/api/term/start', { cookie, body: { ...identity, ai: 'codex' } });
  assert.equal(res.status, 200); const terminal = await res.json();
  assert.equal(terminal.dry, true); assert.ok(terminal.args.includes('gpt-6.1-sol'));
  assert.ok(terminal.dir.startsWith(tmp)); assert.equal(sessions.list().length, 0);
  assert.equal((await remoteReq('/api/task/merge', { cookie, body: { ...identity } })).status, 400); // コピーなしはMacと同じ理由で拒否
  const rolesBefore = fs.readFileSync(path.join(root, '_hub/roles.yaml'));
  assert.equal((await remoteReq('/api/roles', { cookie, body: {} })).status, 400); // 形式検査は維持
  assert.deepEqual(fs.readFileSync(path.join(root, '_hub/roles.yaml')), rolesBefore);
  assert.equal((await remoteReq('/api/maintenance/preview', { cookie, body: { project: identity.project } })).status, 200);
  assert.equal((await remoteReq('/api/hierarchy/remove/preview', { cookie, body: { project: identity.project, task: deletionFixture.child } })).status, 200);
  const created = await remoteReq('/api/project/new', { cookie, body: { name: '遠隔fixture' } });
  assert.equal(created.status, 200); const project = await created.json();
  res = await remoteReq('/api/hierarchy/rename', { cookie, body: { project: project.id, name: '遠隔fixture改名', expectedHash: project.completionHash } });
  assert.equal(res.status, 200); assert.equal((await res.json()).name, '遠隔fixture改名');
  assert.equal((await remoteReq('/api/task', { cookie, body: { ...identity, state: '完了' } })).status, 409); // 完了承認は必要
  assert.equal((await remoteReq('/api/task/read', { cookie, body: identity })).status, 200);
  assert.equal((await remoteReq('/api/chat/stop', { cookie, body: identity })).status, 200);
  const log = fs.readFileSync(path.join(root, '_hub', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  for (const action of ['remotelogin', 'task', 'newproject', 'rename']) assert.ok(log.some(x => x.action === action && x.remote), action);
  assert.ok(log.filter(x => x.action === 'remote').every(x => !x.remote));
});

test('同じ相手から5回まちがえると423で15分止まり、別の相手は入れる', async () => {
  const other = { 'Tailscale-User-Login': 'guest@example.com', 'X-Forwarded-For': '100.64.0.9' };
  for (let i = 0; i < 4; i++) assert.equal((await remoteReq('/api/login', { body: { passcode: 'bad-' + i }, headers: other })).status, 401);
  let res = await remoteReq('/api/login', { body: { passcode: 'bad-5' }, headers: other });
  assert.equal(res.status, 423); assert.equal((await res.json()).error, '15分待ってください');
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' }, headers: other })).status, 423);
  assert.equal((await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' } })).status, 200);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8')).failures).includes('guest@example.com'), true);
});

test('ログアウトはその端末だけ、すべての端末から出るは Mac から', async () => {
  const res = await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' } }), second = res.headers.get('set-cookie').split(';')[0];
  const out = await remoteReq('/api/logout', { cookie, body: {} });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await remoteReq('/api/state', { cookie })).status, 401);
  assert.equal((await remoteReq('/api/state', { cookie: second })).status, 200);
  const all = await (await local('/api/remote/logout-all', {})).json(); assert.equal(all.sessions.length, 0);
  assert.equal((await remoteReq('/api/state', { cookie: second })).status, 401);
  // オフに戻すと、ログインしていても断る
  const res3 = await remoteReq('/api/login', { body: { passcode: 'iphone-pass-1' } }), third = res3.headers.get('set-cookie').split(';')[0];
  await local('/api/remote', { enabled: false });
  assert.equal((await remoteReq('/api/state', { cookie: third })).status, 403);
});

test('deletion APIs preview without moving, reject changed content, preserve parent unread and restore original files',async()=>{
 const f=deletionFixture,body={project:'サンプルアプリ',task:f.child};
 let res=await local('/api/hierarchy/remove/preview',body),d=await res.json();assert.equal(res.status,200);assert.equal(fs.existsSync(f.taskFile),true);assert.equal(d.blockers.length,0);
 fs.appendFileSync(f.childChat,' changed');res=await local('/api/hierarchy/remove/apply',{token:d.token,confirm:true});assert.equal(res.status,409);assert.equal(fs.existsSync(f.taskFile),true);
 d=await (await local('/api/hierarchy/remove/preview',body)).json();res=await local('/api/hierarchy/remove/apply',{token:d.token,optional:[],confirm:true});assert.equal(res.status,200);const moved=await res.json();assert.equal(moved.ok,true);assert.equal(fs.existsSync(f.taskFile),false);
 const unread=JSON.parse(fs.readFileSync(path.join(root,'_hub/unread.json'))).items;assert.equal(unread.includes('サンプルアプリ\u0000'+f.child),false);assert.equal(unread.includes('サンプルアプリ\u0000'+f.parent),true);assert.equal(fs.readFileSync(f.parentChat,'utf8'),'parent result');
 const history=await (await local('/api/hierarchy/remove/history',{})).json();assert.equal(history.history[0].id,moved.record);
 res=await local('/api/hierarchy/remove/restore',{record:moved.record,confirm:true});assert.equal(res.status,200);assert.equal((await res.json()).restored,2);assert.equal(fs.readFileSync(f.childChat,'utf8'),'child result changed');assert.equal(fs.readFileSync(f.parentChat,'utf8'),'parent result');
});
