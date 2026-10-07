'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-order-http-'));
process.env.HUB_ROOT=root;process.env.HUB_DRY_RUN='1';process.env.HUB_AI_HOME=path.join(root,'home');const port=49000+Math.floor(Math.random()*500);process.env.HUB_PORT=String(port);
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
const {server}=require('../server'),order=require('../public/model-order');let base;
test.before(async()=>{await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
const post=(route,b,headers={'X-Hub':'1'})=>fetch(base+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(b)});
test('隔離HTTP：保存/再読・相互保持・before拒否・不正入力・既存権限条件',async()=>{
 const first=await(await fetch(base+'/api/state')).json(),before=order.ordered(first.roles.models,first.modelOrder),next=before.slice().reverse(),roles=fs.readFileSync(path.join(root,'_hub/roles.yaml'));
 assert.equal((await post('/api/models/order',{order:next,before},{})).status,403);
 const r=await post('/api/models/order',{order:next,before});assert.equal(r.status,200);assert.deepEqual((await r.json()).modelOrder,next);
 const key=next.find(x=>x.startsWith('codex|')),model=key.split('|')[1];
 await post('/api/models/hidden',{ai:'codex',model,hidden:true});let state=await(await fetch(base+'/api/state')).json();assert.deepEqual(state.modelOrder,next);assert.ok(state.hiddenModels.codex.includes(model));
 const file=path.join(root,'_hub/model-view.json'),snapshot=fs.readFileSync(file);assert.equal((await post('/api/models/order',{order:before,before})).status,409);assert.equal((await post('/api/models/order',{order:['bad'],before:next})).status,400);assert.deepEqual(fs.readFileSync(file),snapshot);
 assert.equal((await post('/api/models/order',{order:[],before:next})).status,200);state=await(await fetch(base+'/api/state')).json();assert.deepEqual(state.modelOrder,[]);assert.ok(state.hiddenModels.codex.includes(model));assert.deepEqual(state.roles,first.roles);assert.deepEqual(state.cliFlags,first.cliFlags);assert.deepEqual(fs.readFileSync(path.join(root,'_hub/roles.yaml')),roles);
});

test('初期AI APIの検証・状態・再読込・相互保持と既存役割の保持', async () => {
  const { ModelView } = require('../lib/model-view');
  const initial = { ai: 'claude', model: 'Opus 5.5', effort: '中' }, file = path.join(root, '_hub/model-view.json');
  const before = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(before.initialPick, { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  assert.equal((await post('/api/models/initial', initial, {})).status, 403);
  const r = await post('/api/models/initial', { ...initial, model: 'claude-opus-5-5' });
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).initialPick, initial);
  let current = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(current.initialPick, initial); assert.equal(current.initialPickError, '');
  assert.deepEqual(new ModelView(file).initial(), initial);
  assert.deepEqual(current.hiddenModels, before.hiddenModels); assert.deepEqual(current.modelOrder, before.modelOrder);
  assert.deepEqual(current.roles, before.roles);
  const stored = fs.readFileSync(file);
  for (const bad of [{ ...initial, ai: 'agy' }, { ...initial, ai: 'discord:しおり' }, { ...initial, model: 'unknown' }, { ...initial, effort: 'invalid' }]) {
    assert.equal((await post('/api/models/initial', bad)).status, 400); assert.deepEqual(fs.readFileSync(file), stored);
  }
  await post('/api/models/hidden', { ai: 'claude-code', model: initial.model, hidden: true });
  current = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(current.initialPick, initial);
  // 候補消失時も保存値を勝手に置き換えない。
  const data = JSON.parse(fs.readFileSync(file)); data.initial.model = 'lost-model'; fs.writeFileSync(file, JSON.stringify(data));
  current = await (await fetch(base + '/api/state')).json();
  assert.equal(current.initialPick.model, 'lost-model'); assert.match(current.initialPickError, /CLI|候補/);
  assert.equal((await post('/api/models/initial', { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' })).status, 200);
});

test('スマホ表示API：初期値・権限・保存再読・不正値400・モデル/役割/他設定保持', async () => {
  const { ModelView } = require('../lib/model-view'), file = path.join(root, '_hub/model-view.json');
  const first = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(first.phoneLabels, { labels: 'short', names: {} });
  const key = 'codex|GPT-6.1-Sol';
  assert.equal((await post('/api/models/phone', { labels: 'full' }, {})).status, 403);
  assert.equal((await post('/api/models/phone', { key, name: 'ソル' })).status, 200);
  assert.equal((await post('/api/models/phone', { labels: 'full' })).status, 200);
  const current = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(current.phoneLabels, { labels: 'full', names: { [key]: 'ソル' } });
  assert.deepEqual(new ModelView(file).phone(), current.phoneLabels);
  for (const property of ['roles', 'cliFlags', 'hiddenModels', 'modelOrder', 'initialPick']) assert.deepEqual(current[property], first[property]);
  const stored = fs.readFileSync(file);
  for (const bad of [{ labels: 'bad' }, { key, name: 'bad\n' }, { key, name: 'あ'.repeat(25) }, { key: 'bad', name: '' }, { key: 'codex|unknown', name: 'x' }, { labels: 'short', names: {} }]) {
    assert.equal((await post('/api/models/phone', bad)).status, 400); assert.deepEqual(fs.readFileSync(file), stored);
  }
  await post('/api/models/hidden', { ai: 'codex', model: 'GPT-6.1-Sol', hidden: true });
  await post('/api/models/order', { order: [], before: order.ordered(current.roles.models, current.modelOrder) });
  assert.deepEqual((await (await fetch(base + '/api/state')).json()).phoneLabels, current.phoneLabels);
  await post('/api/models/phone', { key, name: '' }); await post('/api/models/phone', { labels: 'short' });
  assert.deepEqual((await (await fetch(base + '/api/state')).json()).phoneLabels, first.phoneLabels);
});
