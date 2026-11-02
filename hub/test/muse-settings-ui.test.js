'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const nodes = { '#muse-settings-box': {}, '#muse-settings-notice': {} }, calls = [];
  const UI = { text: String, html: String, template: (s, ...v) => s.reduce((out, part, i) => out + part + (v[i] ?? ''), '') };
  const context = vm.createContext({ UI, esc: v => String(v).replaceAll('<', '&lt;'),
    $: key => nodes[key], museSettingsEpoch: 0, museUsageBusy: false,
    confirm: () => true,
    api: async (...args) => { calls.push(args); return args[0] === '/api/muse' ? { supported: true, toolReady: true, configured: true } : { notice: '本人用ターミナルで続けてください' }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app-settings.js'), 'utf8'), context);
  return { context, nodes, calls, click: action => context.handleMuseSettingsClick({ target: { closest: () => ({ disabled: false, dataset: { museAction: action } }) } }) };
}

test('daily settings are concise and existing account and recovery controls stay in details', () => {
  const f = fixture();
  const html = f.context.museSettingsHtml({ supported: true, toolReady: true, configured: true, replyReceived: true, trialUsed: true, completionVerified: false });
  const daily = html.split('<details')[0], details = html.split('<details')[1];
  assert.match(daily, /接続済み|利用枠|会話の送り先/);
  assert.deepEqual([...daily.matchAll(/data-muse-action="([^"]+)"/g)].map(m=>m[1]), ['usage', 'reply-auto']);
  assert.match(daily, /10分以降の回答の自動確認：オフ/);
  assert.match(details, /詳細設定/);
  assert.doesNotMatch(html, /前回の試験|試験の実行記録|ターミナルで承認してから/);
  assert.match(html, /結果不明の質問は送り直しません/);
  assert.match(html, /data-muse-action="update"/);
  assert.match(html, /data-muse-action="disconnect"/);
  assert.doesNotMatch(html, /<input|<textarea|data-muse-action="send/);
  assert.doesNotMatch(f.context.museSettingsHtml({ supported: false }), /data-muse-action/);
});

test('confirmation precedes auth terminal entry; refresh is local-only GET with explicit Hub marker', async () => {
  const f = fixture();
  f.context.confirm = () => false;
  await f.click('disconnect'); assert.equal(f.calls.length, 0);
  f.context.confirm = () => true;
  await f.click('update');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), ['/api/muse/terminal', { action: 'update', confirm: true }]);
  assert.equal(f.nodes['#muse-settings-notice'].textContent, '本人用ターミナルで続けてください');
  await f.click('refresh');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), ['/api/muse', null, { 'X-Hub': '1' }]);
});

test('existing installation is selected explicitly without registering or sending again', async () => {
  const f = fixture(); await f.click('existing');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['/api/muse/tool', { useExisting: true, confirm: true }], ['/api/muse', null, { 'X-Hub': '1' }]]);
});

test('task permit list uses selected context; changed selection discards late metadata', async () => {
  const f = fixture();
  f.context.state = { projects: [{ id: 'Synthetic', name: 'Synthetic', tasks: [{ id: 'task', title: 'Task' }] }] };
  const html = f.context.museSettingsHtml({ supported: true, toolReady: true });
  assert.match(html, /muse-workspace-context/); assert.match(html, /Facebook収集・投稿は準備中/);
  f.nodes['#muse-workspace-context'] = { value: JSON.stringify({ project: 'Synthetic', task: 'task' }) };
  f.nodes['#muse-workspace-permits'] = { textContent: 'initial' };
  f.context.api = async () => { f.nodes['#muse-workspace-context'].value = JSON.stringify({ project: 'Other', task: 'task' }); return { permits: [] }; };
  await f.click('permits'); assert.equal(f.nodes['#muse-workspace-permits'].textContent, 'initial');
});


test('Muse defaults to the existing Hub task on each render and permits manual selection', async () => {
  const f = fixture();
  f.context.state = { projects: [
    { id: 'Synthetic', tasks: [{ id: 'task', title: 'Task' }] },
    { id: 'Project Hub', tasks: [{ id: 'other', title: 'Other' }, { id: '20260926-hub-v2', title: '本作業' }] },
  ] };
  const render = () => f.context.museSettingsHtml({ supported: true, toolReady: true });
  const html = render();
  assert.equal((html.match(/ selected/g) || []).length, 1);
  assert.match(html, /<option value="[^>]+ selected>Project Hub \/ 本作業<\/option>/);
  assert.doesNotMatch(html, /<select[^>]+disabled|<option[^>]+disabled/);
  const manual = { project: 'Synthetic', task: 'task' };
  f.nodes['#muse-workspace-context'] = { value: JSON.stringify(manual) };
  f.nodes['#muse-workspace-permits'] = {};
  f.context.api = async (...args) => { f.calls.push(args); return { permits: [], notice: 'opened' }; };
  await f.click('permits');
  await f.click('manage');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), ['permits', 'manage'].map(action =>
    ['/api/muse/workspace', { ...manual, action, confirm: true }]));
  assert.equal(render(), html);
});

test('Muse retains the first-option fallback without inventing an absent default task', () => {
  const f = fixture();
  for (const projects of [
    [{ id: 'Synthetic', tasks: [{ id: '20260926-hub-v2', title: 'Task' }] }],
    [{ id: 'Project Hub', tasks: [{ id: 'other', title: 'Other' }] }],
  ]) {
    f.context.state = { projects };
    const before = JSON.stringify(projects);
    const html = f.context.museSettingsHtml({ supported: true, toolReady: true });
    assert.equal((html.match(/<option /g) || []).length, 1);
    assert.doesNotMatch(html, / selected/);
    assert.equal(JSON.stringify(projects), before);
  }
});


test('unconfigured settings expose registration; unavailable tool exposes only recovery helpers', () => {
  const f=fixture();
  let daily=f.context.museSettingsHtml({supported:true,toolReady:true,configured:false}).split('<details')[0];
  assert.match(daily,/data-muse-action="register"/);assert.match(daily,/data-muse-action="usage" disabled/);
  assert.doesNotMatch(daily,/data-muse-action="update"|data-muse-action="tool"/);
  daily=f.context.museSettingsHtml({supported:true,toolReady:false}).split('<details')[0];
  assert.match(daily,/data-muse-action="refresh"/);assert.match(daily,/data-muse-action="tool"/);
});

test('usage is explicitly clicked once; shows fixed projection, failures and discards late results', async () => {
  const f=fixture();f.nodes['#muse-usage-box']={};
  const u={plan:'Power',usedPercent:25,resetsAt:'2026-10-27T00:00:00Z',checkedAt:'2026-10-26T00:00:00Z',topup:{label:'追加',value:'$2.50 left'}};
  let complete; f.context.api=async (...args)=>{f.calls.push(args);return await new Promise(r=>complete=r);};
  const first=f.click('usage');await f.click('usage');assert.equal(f.calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),['/api/muse/usage',{confirm:true}]);
  complete({usage:u});await first;
  assert.match(f.nodes['#muse-usage-box'].innerHTML,/Power|25%|週の枠とは別/);
  const prior=f.nodes['#muse-usage-box'].innerHTML;
  const pending=f.click('usage');f.context.museSettingsEpoch++;complete({usage:{...u,plan:'late'}});await pending;
  assert.equal(f.nodes['#muse-usage-box'].innerHTML,prior);
  const unavailable = {disabled:true,dataset:{museUnavailable:'1'}};
  f.nodes['#muse-settings-box'].querySelector=()=>unavailable;
  f.context.api=async()=>{throw Error('auth');};await f.click('usage');
  assert.equal(unavailable.disabled,true);
  assert.match(f.nodes['#muse-usage-box'].innerHTML,/未取得.*ログイン期限切れ/);
  assert.doesNotMatch(f.nodes['#muse-usage-box'].innerHTML,/0%|100%|無料/);
  const missing=f.context.museUsageHtml({});assert.match(missing,/未取得/);assert.doesNotMatch(missing,/0%|100%|無料/);
});

test('real UI api helper reaches real usage route with Hub header and a single confirmation', async () => {
  const f=fixture(),create=require('../lib/routes/muse-settings');let reads=0;
  const routes=create({send:(_,status,body)=>({status,body}),PORT:4545,fromRemote:()=>false,
    muse:{usageRead:async()=>{reads++;return {usage:null,error:'auth'};}}});
  f.context.fetch=async (path,opt={})=>{
    const result=await routes.write.handle({headers:{origin:'http://localhost:4545',
      ...Object.fromEntries(Object.entries(opt.headers||{}).map(([k,v])=>[k.toLowerCase(),v]))}},
      {},new URL(path,'http://localhost:4545'),JSON.parse(opt.body||'null'));
    return {status:result.status,ok:result.status<400,json:async()=>result.body};
  };
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  vm.runInContext('const stateResponseTags = new WeakMap();\n'+source.slice(source.indexOf('async function api('),source.indexOf('\nfunction toast(')),f.context);
  const rejected=await f.context.fetch('/api/muse/usage',{method:'POST',body:'{"confirm":true}'});
  assert.equal(rejected.status,403);assert.equal(reads,0);
  f.nodes['#muse-usage-box']={};
  await f.click('usage');
  assert.equal(reads,1);assert.match(f.nodes['#muse-usage-box'].innerHTML,/未取得.*ログイン期限切れ/);
});
