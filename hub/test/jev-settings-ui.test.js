'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {app}=require('./fixtures/app-ui-harness.cjs');
const key='fictional-jev-key-for-offline-ui';
function fixture() {
  const h=app(), run=s=>vm.runInContext(s,h.context); let dialog;
  h.document.createElement=()=>{
    dialog=h.element('dialog');dialog.open=false;
    dialog.querySelector=s=>h.element('dialog '+s);
    dialog.showModal=()=>{dialog.open=true;}; dialog.close=()=>{dialog.open=false;}; dialog.remove=()=>{};
    h.element('dialog form').querySelector=s=>h.element('dialog '+s);
    return dialog;
  };
  h.document.body={appendChild(){}};
  run(`state.accounts=[{ai:'codex',id:'default',name:'default',status:'logged-in'}];jevSettingsStatus={supported:true,registered:false};`);
  return {...h,run,dialog:()=>dialog};
}
test('same account screen offers official login and separate local registration without claiming active use',()=>{
  const h=fixture(), html=h.run('accountSettingsHtml()');
  assert.match(html,/https:\/\/console.typesafe.ai\/keys/);assert.match(html,/data-account-action="logout"/);
  assert.match(html,/キー未設定/);assert.match(html,/提供元へ1回/);
  const row=html.slice(html.indexOf('<b>Jev（TypeSafe AI）'),html.indexOf('data-ai-fold="jev-install"'));
  assert.equal((row.match(/<button /g)||[]).length,2); assert.ok(!row.includes('<a '));
  assert.match(row,/>APIキーを登録<.*>接続状態を確認</);
  h.run('jevSettingsStatus.registered=true');assert.match(h.run('jevStatusText()'),/キー登録済み・接続未確認/);
});
test('password dialog survives account redraw without snapshotting; success clears raw input and never starts external transport',async()=>{
  const h=fixture(), calls=[], persisted=[]; let resolve;
  h.context.localStorage.setItem=(...v)=>persisted.push(v);
  h.context.fetch=(url,opt)=>{calls.push({url,opt});return new Promise(r=>{resolve=r;});};
  h.run('openJevKeyDialog()'); const dialog=h.dialog(), input=dialog.querySelector('#jev-key-input');input.value=key;
  h.run(`view={kind:'settings'};jevSettingsLoaded=true;loadChatgpt=()=>{};drawWebchatSettings=()=>{};drawAccountSettings()`);
  assert.equal(input.value,key);assert.equal(dialog.open,true);assert.equal(persisted.length,0);
  const submit=dialog.querySelector('form').handlers.submit({preventDefault(){}});
  assert.equal(input.value,'');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/jev/key');
  assert.equal(JSON.parse(calls[0].opt.body).key,key);
  resolve({ok:true,json:async()=>({supported:true,registered:true,enabled:false,connection:'unverified',integration:'disconnected'})});
  await submit;assert.equal(dialog.open,false);assert.equal(persisted.length,0);
  assert.match(h.run('jevStatusText()'),/接続未確認/);assert.equal(h.run('jevKeyDialog'),null);
});
test('failed save is not retried, discards key, closes dialog and requires local status read before another save',async()=>{
  const h=fixture(),calls=[];
  h.context.fetch=async(url,opt)=>{calls.push(url);throw Error(key);};
  h.run('openJevKeyDialog()');const d=h.dialog();d.querySelector('#jev-key-input').value=key;
  await d.querySelector('form').handlers.submit({preventDefault(){}});
  assert.deepEqual(calls,['/api/jev/key']);assert.equal(d.querySelector('#jev-key-input').value,'');assert.equal(d.open,false);
  assert.ok(!h.run('jevStatusText()').includes(key));assert.match(h.run('jevStatusText()'),/設定画面を開き直して/);
  h.run('openJevKeyDialog()');assert.equal(h.run('jevKeyDialog'),null);
  assert.equal(h.run('jevSettingsLoaded'),false); // Reopening/redrawing settings refreshes local metadata only.
});
test('status reads use only local GET; cancel clears key without saving or persistent browser storage',async()=>{
  const h=fixture(),calls=[];
  h.context.fetch=async(url,opt)=>{calls.push({url,opt});return {ok:true,json:async()=>({supported:true,registered:false})};};
  await h.run('loadJevSettings()');assert.equal(calls[0].url,'/api/jev');assert.equal(calls[0].opt.body,undefined);
  h.run('openJevKeyDialog()');const d=h.dialog();d.querySelector('#jev-key-input').value=key;
  d.handlers.cancel({preventDefault(){}});assert.equal(d.open,false);assert.equal(d.querySelector('#jev-key-input').value,'');assert.equal(calls.length,1);
});

test('explicit check sends one POST despite concurrent presses; status-only result stays in memory',async()=>{
  const h=fixture(), calls=[], persisted=[]; let resolve;
  h.run('jevSettingsStatus.registered=true');
  h.context.localStorage.setItem=(...v)=>persisted.push(v);
  h.context.fetch=(url,opt)=>{calls.push({url,opt});return new Promise(r=>{resolve=r;});};
  const first=h.run('verifyJevConnection()');await h.run('verifyJevConnection()');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/jev/verify');
  assert.deepEqual(JSON.parse(calls[0].opt.body),{confirm:true});
  resolve({ok:true,json:async()=>({connection:'verified',checkedAt:'2026-11-05T01:00:00.000Z'})});
  await first;assert.match(h.run('jevStatusText()'),/接続確認済み（/);assert.equal(persisted.length,0);
  for(const [state,label] of [['rejected','キーが拒否されました'],['unavailable','確認できません（通信）']]){
    h.run(`jevSettingsStatus.connection=${JSON.stringify(state)}`);assert.equal(h.run('jevStatusText()'),label);
  }
});
test('failed check is never resent; absent key cannot start check; opening settings only loads local metadata',async()=>{
  const h=fixture(),calls=[];h.context.fetch=async(url)=>{calls.push(url);throw Error(key);};
  await h.run('verifyJevConnection()');assert.equal(calls.length,0);
  h.run('jevSettingsStatus.registered=true');await h.run('verifyJevConnection()');
  assert.deepEqual(calls,['/api/jev/verify']);assert.equal(h.run('jevStatusText()'),'確認できません（通信）');
  assert.ok(!h.run('jevStatusText()').includes(key));
});
test('search switch defaults off, requires registered key, displays caps, saves once without sending a query',async()=>{
  const h=fixture(),calls=[];
  h.run(`jevSettingsStatus.search={available:true,enabled:false,requests:999,reservedUSD:2.685312}`);
  const html=h.run('accountSettingsHtml()');assert.match(html,/会話検索の並べ替えに使う/);assert.match(html,/999 \/ 1000回/);assert.match(html,/検索の待ち時間は増えます/);
  h.run('drawJevStatus()');assert.equal(h.element('#jev-search-enabled').checked,false);assert.equal(h.element('#jev-search-enabled').disabled,true);
  h.run('jevSettingsStatus.registered=true');h.element('#jev-search-enabled').checked=true;
  h.context.fetch=async(url,opt)=>{calls.push({url,body:JSON.parse(opt.body)});return {ok:true,json:async()=>({supported:true,registered:true,search:{available:true,enabled:true,requests:999,reservedUSD:2.685312}})};};
  await h.run('configureJevSearch()');assert.deepEqual(calls,[{url:'/api/jev/search',body:{enabled:true,confirm:true}}]);
  assert.equal(h.element('#jev-search-enabled').checked,true);
});
