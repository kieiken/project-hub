'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { LocalAuth } = require('../lib/local-auth');
const { app, snapshot } = require('./fixtures/app-ui-harness.cjs');
const denied = () => ({ ok: false, status: 401, json: async () => ({ code: 'local_auth_required', error: 'Open Project Hub from its app or launcher' }) });
function fixture({ native = true, rows = new Map(), storage } = {}) {
  storage ||= { getItem: key => rows.get(key) || null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
  const a = app('', storage), calls = [];
  a.context.fixture = { ...snapshot(), hubInstance: 'before', restart: { reserved: { at: 'old' } } };
  // The harness leaves its synthetic initial fetch unresolved. Our fixture
  // represents an already loaded page, with no startup request in flight.
  vm.runInContext('state=fixture;apiPendingWrites=0;setChatDraft("p/t","未送信の本文");chatAttachments.set("p/t",[{id:"image-1"}]);askDrafts.set("p/t",["選択中"]);queueDrafts.set("p/t",{text:"編集中の指示"});rolesDraft=[{name:"未保存設定"}]', a.context);
  a.context.window.HubLocalAuth = { canReconnect: native, pendingWrites: 0 };
  a.context.fetch = async (url, options) => { calls.push({ url, options }); return denied(); };
  const querySelector = a.document.querySelector;
  a.document.querySelector = selector => selector === 'dialog[open], .ideas-dialog[open]' ? null : querySelector(selector);
  a.element('#toast').querySelector = selector => selector === '[data-local-recovery-reload]' ? a.element('recovery-button') : null;
  let reloads = 0;
  a.context.location.reload = () => reloads++;
  const flush = () => {
    for (const [id, timer] of [...a.timeouts]) if (timer.ms === 0) { a.timeouts.delete(id); timer.cb(); }
  };
  const poll = async () => { await assert.rejects(a.context.fetchState(), e => e.status === 401); flush(); };
  return { ...a, calls, rows, storage, flush, poll, reloads: () => reloads };
}
test('controlled replacement rejects the old browser session; native document issues a fresh bounded session', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-restart-window-'));
  fs.chmodSync(dir, 0o700);
  const previous = { headers: process.env.HUB_HEADERS, dir: process.env.HUB_AUTH_DIR };
  let now = 1000, b;
  const a = new LocalAuth({ dir, now: () => now });
  try {
    a.activate(45688);
    const old = a.browserSession(true), req = { headers: { 'x-hub-token': old.token } };
    assert.equal(a.authenticated(req), true);
    a.restartEnv(); a.close();
    b = new LocalAuth({ dir, now: () => now }); b.activate(45688);
    assert.equal(a.token, b.token, 'controlled owner handover is preserved');
    assert.equal(b.authenticated(req), false, 'browser sessions are not carried across restart');
    const fresh = b.browserSession(true);
    assert.notEqual(fresh.token, old.token);
    assert.equal(b.authenticated({ headers: { 'x-hub-token': fresh.token } }), true);
    now = fresh.expires;
    assert.equal(b.authenticated({ headers: { 'x-hub-token': fresh.token } }), false, 'eight-hour expiry is unchanged');
  } finally {
    b?.close(); a.close(); fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ HUB_HEADERS: previous.headers, HUB_AUTH_DIR: previous.dir })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
test('401 before any state success recovers once and preserves all restart draft maps', async () => {
  const a = fixture(); await a.poll(); await a.poll();
  assert.equal(a.reloads(), 1);
  const saved = JSON.parse(a.rows.get('hub-restart-drafts'));
  assert.equal(saved.chatDraft['p/t'], '未送信の本文');
  assert.equal(saved.maps.chatAttachments[0][1][0].id, 'image-1');
  assert.equal(saved.maps.askDrafts[0][1][0], '選択中');
  assert.equal(saved.maps.queueDrafts[0][1].text, '編集中の指示');
  assert.equal(saved.rolesDraft[0].name, '未保存設定');
  assert.equal(a.rows.get('hub-local-recovery'), 'attempted');
  assert.doesNotMatch(a.context.restartControls(), /再起動を予約中|data-restart-cancel/);
  assert.match(a.element('#upd').textContent, /画面の接続/);
  assert.equal(a.calls.filter(x => x.options?.method === 'POST').length, 0);
  const b = app('', a.storage);
  assert.equal(vm.runInContext('chatDraft["p/t"]', b.context), '未送信の本文');
  assert.equal(vm.runInContext('chatAttachments.get("p/t")[0].id', b.context), 'image-1');
});
test('a failed native recovery stays latched across page loads, without losing restored input', async () => {
  const rows = new Map([['hub-local-recovery', 'attempted']]);
  const a = fixture({ rows }); await a.poll(); await a.poll();
  assert.equal(a.reloads(), 0);
  assert.equal(vm.runInContext('chatDraft["p/t"]', a.context), '未送信の本文');
  assert.match(a.element('#toast').textContent, /一度試しました/);
});
test('browser, remote or old documents without native recovery keep their view and show the reopening action', async () => {
  const a = fixture({ native: false }); await a.poll(); await a.poll();
  assert.equal(a.reloads(), 0); assert.equal(a.rows.has('hub-local-recovery'), false);
  assert.equal(vm.runInContext('state.hubInstance', a.context), 'before');
  assert.match(a.element('#toast').textContent, /AIの停止や再起動の再予約は不要/);
});
test('draft storage failure prevents navigation, then storage recovery allows one attempt', async () => {
  const rows = new Map(); let blocked = true;
  const storage = { getItem: k => rows.get(k) || null, removeItem: k => rows.delete(k), setItem(k, v) { if (blocked) throw Error('storage full'); rows.set(k, v); } };
  const a = fixture({ rows, storage }); await a.poll(); assert.equal(a.reloads(), 0);
  assert.equal(vm.runInContext('chatDraft["p/t"]', a.context), '未送信の本文');
  blocked = false; await a.poll(); assert.equal(a.reloads(), 1);
});
test('failed POST is not replayed or followed by navigation before its caller restores input', async () => {
  const a = fixture();
  await assert.rejects(a.context.api('/api/chat/send', { text: '送信する本文' }), e => e.status === 401);
  a.flush(); assert.equal(a.reloads(), 0);
  vm.runInContext('setChatDraft("p/t","失敗後に復元した本文")', a.context);
  await a.poll(); assert.equal(a.reloads(), 1);
  assert.equal(a.calls.filter(x => x.options?.method === 'POST').length, 1);
  assert.equal(JSON.parse(a.rows.get('hub-restart-drafts')).chatDraft['p/t'], '失敗後に復元した本文');
});
test('recovery waits for an in-flight mutation body and for the caller send lock', async () => {
  const a = fixture(); let finish;
  a.context.fetch = async url => url === '/api/chat/send' ? { ok: true, json: () => new Promise(resolve => { finish = resolve; }) } : denied();
  const sending = a.context.api('/api/chat/send', { text: 'kept' });
  await new Promise(setImmediate); await a.poll(); assert.equal(a.reloads(), 0);
  vm.runInContext('chatSending.add("p/t")', a.context);
  finish({ ok: true }); await sending; await a.poll(); assert.equal(a.reloads(), 0);
  vm.runInContext('chatSending.clear()', a.context);
  a.context.window.HubLocalAuth.pendingWrites = 1;
  await a.poll(); assert.equal(a.reloads(), 0, 'non-api upload still in flight');
  a.context.window.HubLocalAuth.pendingWrites = 0;
  await a.poll(); assert.equal(a.reloads(), 1);
});
test('successful state clears the stale-connection status and latch; reservation status comes from the server', async () => {
  const a = fixture({ native: false }); await a.poll();
  a.rows.set('hub-local-recovery', 'attempted');
  const next = { ...a.context.fixture, restart: { reserved: null } };
  a.context.fetch = async () => ({ ok: true, status: 200, json: async () => next, headers: { get: () => '' } });
  const result = await a.context.fetchState(); a.context.adoptState(result);
  assert.equal(a.rows.has('hub-local-recovery'), false);
  assert.doesNotMatch(a.context.restartControls(), /接続が切れ|予約中/);
  assert.match(a.context.restartControls(), /Hubを再起動/);
});
test('pending attachments/native drop, quick sends and untracked forms defer automatic navigation', async () => {
  for (const [hold, release] of [
    ['quickUploading.add("p")', 'quickUploading.clear()'],
    ['quickStarting.add("p")', 'quickStarting.clear()'],
    ['chatImageUploads.set("p/t",1)', 'chatImageUploads.set("p/t",0)'],
    ['nativeDropTickets.set("drop",{})', 'nativeDropTickets.clear()'],
    ['view.kind="newproject"', 'view.kind="work"'],
  ]) {
    const a = fixture(); vm.runInContext(hold, a.context);
    await a.poll(); assert.equal(a.reloads(), 0, hold);
    vm.runInContext(release, a.context); await a.poll(); assert.equal(a.reloads(), 1, release);
  }
});
test('network failures, unrelated 401 and permission 403 cannot trigger recovery', async () => {
  for (const response of [() => { throw Error('offline'); }, () => ({ ok: false, status: 401, json: async () => ({ error: 'other login' }) }), () => ({ ok: false, status: 403, json: async () => ({ code: 'local_auth_required' }) })]) {
    const a = fixture(); a.context.fetch = response;
    await assert.rejects(a.context.fetchState()); a.flush();
    assert.equal(a.reloads(), 0); assert.equal(a.rows.has('hub-local-recovery'), false);
    assert.match(a.context.restartControls(), /予約中/);
  }
});
test('untracked edited settings and forms defer recovery without serializing their values', async () => {
  for (const input of [
    { value: 'unsaved value', defaultValue: '', tagName: 'INPUT' },
    { type: 'checkbox', checked: true, defaultChecked: false },
    { tagName: 'SELECT', options: [{ selected: true, defaultSelected: false }] },
    { isContentEditable: true },
  ]) {
    const a = fixture(), queryAll = a.document.querySelectorAll;
    const field = { ...input, matches: () => false }; field.closest = () => field;
    a.context.trackLocalRecoveryEdit({isTrusted:true,target:field});
    a.document.querySelectorAll = selector => selector === 'input, textarea, select, [contenteditable="true"]' ? [field] : queryAll(selector);
    await a.poll(); assert.equal(a.reloads(), 0); assert.equal(a.rows.has('hub-restart-drafts'), false);
    assert.match(a.element('#toast').textContent, /変更中の欄/);
    a.document.querySelectorAll = queryAll; await a.poll(); assert.equal(a.reloads(), 1);
  }
});
test('untouched implicit select, programmatic settings and empty contenteditable never block recovery', async () => {
  const a=fixture(), fields=[{tagName:'SELECT',options:[{selected:true,defaultSelected:false}]},{type:'checkbox',checked:true,defaultChecked:false},{value:'loaded',defaultValue:''},{isContentEditable:true}].map(el=>({...el,matches:()=>false}));
  a.document.querySelectorAll=()=>fields;
  for(const field of fields){field.closest=()=>field;a.context.trackLocalRecoveryEdit({isTrusted:false,target:field});}
  assert.equal(a.context.localRecoveryHasUnsavedInputs(),false);
  await a.poll();await a.poll();assert.equal(a.reloads(),1);
  assert.equal(a.documentListeners.filter(r=>r.cb===a.context.trackLocalRecoveryEdit&&r.capture).length,2);
});
test('snapshot editors and disposable search fields are excluded even after trusted input; file selection is protected', async () => {
  const a=fixture();
  const field={matches:selector=>selector.includes('#conversation-search-mode')};field.closest=()=>field;
  a.context.trackLocalRecoveryEdit({isTrusted:true,target:field});a.document.querySelectorAll=()=>[field];
  assert.equal(a.context.localRecoveryHasUnsavedInputs(),false);
  const file={type:'file',files:[{}],matches:()=>false};a.document.querySelectorAll=()=>[file];
  await a.poll();assert.equal(a.reloads(),0);
});
test('all safety blockers report fixed codes, resolve on next poll, and refuse even manual reload', async () => {
  for(const [hold,release,code] of [
    ['apiPendingWrites=1','apiPendingWrites=0','pending-write'],
    ['chatSending.add("p/t")','chatSending.clear()','sending'],
    ['quickUploading.add("p")','quickUploading.clear()','uploading'],
    ['view.kind="newproject"','view.kind="work"','new-project'],
  ]){
    const a=fixture();vm.runInContext(hold,a.context);await a.poll();
    assert.equal(JSON.parse(a.rows.get('hub-local-recovery-reasons')).at(-1).code,code);
    a.context.attemptLocalRecovery(true);assert.equal(a.reloads(),0);
    assert.equal(a.element('recovery-button').disabled,true);
    vm.runInContext(release,a.context);await a.poll();assert.equal(a.reloads(),1);
  }
  const a=fixture(),query=a.document.querySelector;a.document.querySelector=s=>s==='dialog[open], .ideas-dialog[open]'?{}:query(s);
  await a.poll();assert.equal(JSON.parse(a.rows.get('hub-local-recovery-reasons')).at(-1).code,'dialog-open');
  a.context.attemptLocalRecovery(true);assert.equal(a.reloads(),0);
});
test('manual recovery requires a trusted button click, saves snapshots, and never repeats a POST', async () => {
  const a=fixture({rows:new Map([['hub-local-recovery','attempted']])});await a.poll();
  const button=a.element('recovery-button');assert.equal(button.disabled,false);
  button.handlers.click({isTrusted:false});assert.equal(a.reloads(),0);
  button.handlers.click({isTrusted:true});button.handlers.click({isTrusted:true});
  assert.equal(a.reloads(),1);assert.equal(a.calls.filter(r=>r.options?.method==='POST').length,0);
  assert.equal(JSON.parse(a.rows.get('hub-restart-drafts')).maps.askDrafts[0][1][0],'選択中');
});
test('manual recovery warns before discarding other edited forms; cancel keeps them', async () => {
  const a=fixture(),field={matches:()=>false};field.closest=()=>field;a.context.trackLocalRecoveryEdit({isTrusted:true,target:field});a.document.querySelectorAll=()=>[field];
  let confirmations=0;a.context.confirm=text=>{confirmations++;assert.match(text,/内容は失われます/);return false;};
  await a.poll();a.element('recovery-button').handlers.click({isTrusted:true});assert.equal(a.reloads(),0);assert.equal(confirmations,1);
  a.context.confirm=()=>true;a.element('recovery-button').handlers.click({isTrusted:true});assert.equal(a.reloads(),1);
});
test('sanitized reason history is bounded to ten and a successful state removes unresolved notice and latch', async () => {
  const a=fixture({native:false});
  a.rows.set('hub-local-recovery-reasons',JSON.stringify([{at:1,code:'pending-write',value:'SECRET'},{at:2,code:'BAD?token=SECRET'}]));
  for(let i=0;i<15;i++)a.context.localConnectionNotice(i%2?'sending':'pending-write');
  const history=JSON.parse(a.rows.get('hub-local-recovery-reasons'));assert.equal(history.length,10);
  for(const row of history)assert.deepEqual(Object.keys(row).sort(),['at','code']);
  assert.doesNotMatch(JSON.stringify(history),/SECRET|token|未送信/);
  await a.poll();a.rows.set('hub-local-recovery','attempted');
  a.context.fetch=async()=>({ok:true,status:200,json:async()=>a.context.fixture,headers:{get:()=>''}});
  await a.context.fetchState();assert.equal(a.rows.has('hub-local-recovery'),false);assert.equal(vm.runInContext('localRecoveryReason',a.context),'');assert.equal(a.element('#toast').hidden,true);
});
test('storage failure reasons stay visible and never navigate without a saved snapshot and latch', async () => {
  for(const broken of ['get','draft','latch']){
    const rows=new Map(),storage={getItem:k=>{if(broken==='get'&&k==='hub-local-recovery')throw Error('fixture');return rows.get(k)||null;},setItem:(k,v)=>{if(k===(broken==='draft'?'hub-restart-drafts':'hub-local-recovery'))throw Error('fixture');rows.set(k,v);},removeItem:k=>rows.delete(k)};
    const a=fixture({rows,storage});await a.poll();assert.equal(a.reloads(),0);
    assert.equal(vm.runInContext('localRecoveryReason',a.context),broken==='draft'?'draft-save-failed':'storage-unavailable');
  }
});
test('saved Jev switch clears its trusted edit marker after readback without clearing other forms', () => {
  const a=fixture(),toggle=a.element('#jev-search-enabled'),other={matches:()=>false};
  toggle.matches=()=>false;toggle.closest=()=>toggle;other.closest=()=>other;
  a.context.trackLocalRecoveryEdit({isTrusted:true,target:toggle});a.context.trackLocalRecoveryEdit({isTrusted:true,target:other});
  a.context.fixtureJev={supported:true,registered:true,search:{enabled:true,available:true}};
  vm.runInContext('jevSettingsStatus=fixtureJev;jevSettingsBusy=false;drawJevStatus()',a.context);
  a.document.querySelectorAll=()=>[toggle];assert.equal(a.context.localRecoveryHasUnsavedInputs(),false);
  a.document.querySelectorAll=()=>[other];assert.equal(a.context.localRecoveryHasUnsavedInputs(),true);
});
test('merge display escapes at most three restart blockers and refreshes to the completed flow', async () => {
  const a=fixture();vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8'),a.context);
  const button=a.element('[data-act="merge"]'),region=a.element('[data-main-preview]');button.classList={toggle(){}};
  a.context.waitingRows=[{message:'作業A：AI実行中'},{message:'作業B：保存中'},{message:'<script>第三</script>'},{message:'第四：非表示'}];
  vm.runInContext('view={kind:"work",project:"p",task:"t"};state.restart.waiting=waitingRows',a.context);
  const plan={main:{sourceHead:'fresh',target:'本体',files:2},flow:{stage:'waiting'}};
  a.context.drawOneclickMain('p','t',plan);
  assert.match(region.innerHTML,/作業A：AI実行中.*作業B：保存中/);assert.match(region.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(region.innerHTML,/第四|<script>/);
  const next={...a.context.fixture,restart:{reserved:null,waiting:[]}};
  a.context.fetch=async()=>({ok:true,status:200,json:async()=>next,headers:{get:()=>''}});
  const fresh=await a.context.fetchState();a.context.adoptState(fresh);
  a.context.drawOneclickMain('p','t',{...plan,flow:{stage:'complete',sourceHead:'fresh',restart:true}});
  assert.equal(button.textContent,'本体へ反映済み');assert.match(region.innerHTML,/新版の起動確認が完了/);assert.doesNotMatch(region.innerHTML,/切替を待って|作業A：AI実行中|取り込み中/);
  assert.doesNotMatch(a.context.oneclickText({stage:'waiting'}),/待機中：/);
});
