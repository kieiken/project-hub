'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { MuseSettings } = require('../lib/muse-settings');
const create = require('../lib/routes/muse-settings');
const { app, snapshot } = require('./fixtures/app-ui-harness.cjs');

for (const platform of ['win32', 'linux']) {
  test(`${platform}: GET chat and approvals are empty without touching Mac context; origin guards remain`, async () => {
    const muse = new MuseSettings({root: '/unused-synthetic', platform, run: () => { throw Error('no helper'); }});
    const routes = create({platform, muse, PORT: 4545, fromRemote: () => false,
      send: (_, status, body) => ({status, body}), direct: {pending() { throw Error('no pending read'); }}});
    for (const [route, body] of [['chat', {pending: null}], ['approvals', {approvals: []}]]) {
      const url = new URL(`http://localhost:4545/api/muse/${route}?project=p&task=t`);
      assert.deepEqual(await routes.read.handle({headers: {'x-hub': '1'}}, {}, url), {status: 200, body});
      for (const headers of [{}, {'x-hub': '1', origin: 'https://foreign.invalid'}])
        assert.equal((await routes.read.handle({headers}, {}, url)).status, 403);
    }
    assert.equal((await muse.status()).supported, false);
    assert.throws(() => muse.workspace('p', 't'));
    assert.equal((await routes.write.handle({headers: {'x-hub':'1'}}, {},
      new URL('http://localhost:4545/api/muse/chat'), {})).status, 403);
  });
}

function ui(supported) {
  const f = app(); f.context.data = {...snapshot(), museSupported: supported,
    initialPick: {ai: 'codex', model: 'GPT-6.1-Sol', effort: '高'}};
  f.context.localStorage.getItem = () => JSON.stringify({ai:'muse', model:'direct'});
  vm.runInContext("state=data;view={kind:'work',project:'p',task:'t'}", f.context);
  return f;
}

test('unsupported UI hides Muse, resolves a saved Muse pick to configured default and skips reads on open/row/idle', async () => {
  const f = ui(false), p = f.context.data.projects[0], t = p.tasks[0], calls = [];
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.chatSelection(p,t))), f.context.data.initialPick);
  assert.doesNotMatch(f.context.chatModelChoices(p,t), /muse|Muse/);
  f.context.api = async route => { calls.push(route); if (route.startsWith('/api/muse/')) throw Error('must not read'); return {}; };
  f.context.refreshTree = () => {};
  f.context.openChat(p,t);
  f.stream().onmessage({data: JSON.stringify({type:'rows', rows:[], queue:[], busy:null, generation:3})});
  f.stream().onmessage({data: JSON.stringify({type:'row', row:{role:'assistant', ai:'codex', text:'reply'}})});
  f.stream().onmessage({data: JSON.stringify({type:'idle'})});
  await f.context.loadMuseApprovals('p','t');
  await new Promise(r => setImmediate(r));
  assert.equal(calls.filter(p => p.startsWith('/api/muse/')).length, 0);
  assert.equal(f.element('#muse-approvals').textContent, '');
  assert.equal(f.element('#muse-reply-status').textContent, '');
});

test('supported UI retains saved Muse selection, menu and state fetch', async () => {
  const f = ui(true), p = f.context.data.projects[0], t = p.tasks[0], calls = [];
  assert.equal(f.context.chatSelection(p,t).ai, 'muse');
  assert.match(f.context.chatModelChoices(p,t), /Muse（外部）/);
  f.context.api = async route => { calls.push(route); return {pending:null}; };
  f.context.openChat(p,t);
  f.stream().onmessage({data: JSON.stringify({type:'rows', rows:[], queue:[], busy:null, generation:3})});
  await new Promise(r => setImmediate(r));
  assert.equal(calls.filter(p => p.startsWith('/api/muse/chat?')).length, 1);
});

for (const platform of ['win32', 'darwin']) test(`${platform}: real state route projects Muse support without reading account status`, async () => {
  const none = () => ({}), list = () => [];
  const ctx = {platform, __dirname: '/synthetic/hub', gitw:{savedHeadAsync:async()=>null}, pruneUnread:()=>{},
    getDiscussion:()=>null, rolesData:none, modelView:{read:none,initial:none,special:none,hidden:none,saved:none,phone:none},
    chats:{handoffErrors:list,running:new Map()}, restartBlockers:list, extensions:{state:none}, stopControl:{view:none},
    readVersion:()=> 'test',license:{status:none},appUpdate:{status:none},appShell:{status:none},freetalkStatus:none,
    onboarding:{state:none},aiUpdates:{status:()=>({tools:{}})},aiTools:{busy:()=>0,find:()=>false,catalog:()=>({agy:{}})},
    updateBusy:()=>false,getRestartControl:()=>({status:none}),bodyNoticeState:list,github:{summary:none},accounts:{list},
    store:{completion:{},listProjects:list},projectOrder:{read:list,readPins:list},taskTransfer:{pending:list},stateOffers:{view:list},taskIntegrate:{pending:list},
    launch:{AIS:[]},handoff:{childCounts:none},sessions:{list,available:()=>false},modelError:()=>'',roles:{EFFORTS:[]},unread:new Set(),
    procwatch:{list},acceleration:{settings:none},remote:{enabled:()=>false},gpt:{settings:none},getWebchat:()=>({view:none}),
    crypto:require('node:crypto'),fromRemote:()=>false,getUpdateRestoreReady:()=>false,sendEncoded:(_q,_s,b)=>JSON.parse(b),lt:s=>s};
  const r = await require('../lib/routes/state')(ctx).read.handle({method:'GET',headers:{}}, new (require('node:events').EventEmitter)(), new URL('http://localhost/api/state'));
  assert.equal(r.museSupported, platform === 'darwin');
});
