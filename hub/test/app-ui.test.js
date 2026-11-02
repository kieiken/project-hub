'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const git = require('../lib/git');

const {app,project,snapshot}=require('./fixtures/app-ui-harness.cjs');
const source=require('./fixtures/app-source.cjs').readApp();

test('summary-only tasks preserve progress segments, next step and finished filtering',()=>{
 const a=app();a.context.data=snapshot();
 vm.runInContext(`state=data;const st=state.projects[0].tasks[0];delete st.steps;st.stepSummary={total:3,done:2,next:{text:'next',done:false},marks:'101',version:'v1'};`,a.context);
 assert.equal(vm.runInContext('progressOf(st).done',a.context),2);assert.equal(vm.runInContext('progressOf(st).all',a.context),3);
 const html=vm.runInContext('progressBar(st)',a.context);assert.match(html,/<i class="on"><\/i><i class=""><\/i><i class="on"><\/i>/);assert.match(html,/2 \/ 3/);
 assert.match(vm.runInContext('taskRow(state.projects[0],st,false)',a.context),/次：next/);
 const order=require('../public/project-order');
 assert.equal(order.finished({stepSummary:{total:3,done:2}}),false);assert.equal(order.finished({stepSummary:{total:3,done:3}}),true);assert.equal(order.finished({stepSummary:{total:0,done:0}}),false);
});
test('step details load once for the open version; late navigation responses cannot replace current steps',async()=>{
 const a=app(),box=a.element('[data-step-list]');box.dataset={p:'p',t:'t'};a.context.data=snapshot();
 const pending=[];a.context.stepApi=url=>new Promise(resolve=>pending.push({url,resolve}));
 vm.runInContext(`state=data;view={kind:'work',project:'p',task:'t'};delete state.projects[0].tasks[0].steps;state.projects[0].tasks[0].stepSummary={total:1,done:0,next:{text:'one'},marks:'0',version:'v1'};api=stepApi;syncTaskSteps();syncTaskSteps();`,a.context);
 assert.equal(pending.length,1);assert.match(pending[0].url,/^\/api\/task\/steps\?project=p&task=t$/);
 pending[0].resolve({version:'v1',steps:[{text:'<first>',done:false}]});await new Promise(r=>setImmediate(r));
 assert.match(box.innerHTML,/&lt;first&gt;/);assert.match(box.innerHTML,/data-i="0"/);assert.equal(box.dataset.version,'v1');
 vm.runInContext('syncTaskSteps()',a.context);assert.equal(pending.length,1);
 vm.runInContext(`state.projects[0].tasks[0].stepSummary.version='v2';syncTaskSteps();view.task='other';`,a.context);
 pending[1].resolve({version:'v2',steps:[{text:'stale',done:true}]});await new Promise(r=>setImmediate(r));assert.doesNotMatch(box.innerHTML,/stale/);
 vm.runInContext(`view.task='t';syncTaskSteps();`,a.context);assert.equal(pending.length,3);
 pending[2].resolve({version:'v2',steps:[{text:'current',done:true}]});await new Promise(r=>setImmediate(r));assert.match(box.innerHTML,/current/);assert.match(box.innerHTML,/checked/);
});

function disclosureUI() {
  const a=app(),folds=[];
  a.document.querySelectorAll=s=>s==='details[open]'?folds.filter(d=>d.open):[];
  a.context.getComputedStyle=el=>({visibility:el.visibility||'visible'});
  const work={dataset:{p:'p',t:'t'}};
  const fold=(dataset={},parent=null)=>{
    const d={open:true,isConnected:true,dataset,id:'',tagName:'DETAILS',parentElement:parent,classList:{contains:()=>false},
      getClientRects(){for(let n=this;n;n=n.parentElement)if(n.hidden)return [];return [{}];},querySelector(){return null;},
      closest:s=>s==='.work'?work:null,contains(target){for(let n=target;n;n=n.parent)if(n===d)return true;return false;},parent};
    folds.push(d);return d;
  };
  const fire=(type,extra={})=>{for(const l of a.documentListeners.filter(l=>l.name===type&&l.capture===true&&/disclosurePress|dismissDisclosures/.test(l.cb.toString())))l.cb({detail:1,clientX:10,clientY:10,pointerId:1,...extra});};
  return {...a,fold,folds,fire};
}
test('disclosures R1: opening a closed group preserves unseen notices and their remembered open state',()=>{
  const a=disclosureUI(),group=a.fold({workFold:'alerts'}),notice=a.fold({workFold:'transfer'},group);
  group.open=false;a.context.rememberDisclosure(notice);
  a.fire('click',{target:{parent:group}});group.open=true; // Native summary action follows the capture listener.
  assert.equal(notice.open,true);assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'transfer',false),'open');
  const input={parent:notice,value:'kept draft'};a.fire('click',{target:input});
  assert.equal(group.open,true);assert.equal(notice.open,true);assert.equal(input.value,'kept draft');
});
test('disclosures R1: outside closure leaves hidden disclosures and their memories unchanged',()=>{
  const a=disclosureUI(),wrapper={hidden:true},hidden=a.fold({workFold:'hidden'},wrapper),invisible=a.fold({workFold:'invisible'});
  invisible.visibility='hidden';a.context.rememberDisclosure(hidden);a.context.rememberDisclosure(invisible);
  a.fire('click',{target:{}});
  for(const [name,el] of [['hidden',hidden],['invisible',invisible]]){
    assert.equal(el.open,true);assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},name,false),'open');
  }
  wrapper.hidden=false;a.fire('click',{target:{}});assert.equal(hidden.open,false);
  assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'hidden',true),'');
});
test('disclosures R1: capture visibility once so visible parent and child close together but a hidden branch stays open',()=>{
  const a=disclosureUI(),parent=a.fold({workFold:'parent'}),child=a.fold({workFold:'child'},parent),branch=a.fold({},parent),unseen=a.fold({workFold:'unseen'},branch);
  branch.open=false;a.context.rememberDisclosure(unseen);a.fire('click',{target:{}});
  assert.equal(parent.open,false);assert.equal(child.open,false);assert.equal(unseen.open,true);
  assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'parent',true),'');
  assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'child',true),'');
  assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'unseen',false),'open');
});
test('disclosures: every structural details including dynamic and nested folds closes outside without changing inputs or the action',()=>{
  const a=disclosureUI(),parent=a.fold({workFold:'transfer'}),child=a.fold({},parent),sibling=a.fold({workFold:'settings'}),future=a.fold({unexpected:'dynamic'});
  const input={parent:child,value:'draft',checked:true};
  a.fire('click',{target:input});assert.equal(parent.open,true);assert.equal(child.open,true);assert.equal(sibling.open,false);assert.equal(future.open,false);
  const link={parent};a.fire('click',{target:link,detail:0});assert.equal(parent.open,true);assert.equal(child.open,false);
  const outside={},event={target:outside,preventDefault:()=>assert.fail('outside action must run'),stopPropagation:()=>assert.fail('outside action must bubble')};
  a.fire('click',event);assert.equal(parent.open,false);assert.equal(input.value,'draft');assert.equal(input.checked,true);
  const later=a.fold();a.fire('click',event);assert.equal(later.open,false);
});
test('disclosures: drag away and back, pointer cancellation and large release movement stay open; the next tap and keyboard action close',()=>{
  const a=disclosureUI(),d=a.fold(),target={};
  a.fire('pointerdown');a.fire('pointermove',{clientX:30});a.fire('pointermove');a.fire('click',{target});assert.equal(d.open,true);
  a.fire('pointerdown');a.fire('pointercancel');a.fire('click',{target});assert.equal(d.open,true);
  a.fire('pointerdown');a.fire('click',{target,clientY:40});assert.equal(d.open,true);
  a.fire('pointerdown');a.fire('click',{target});assert.equal(d.open,false);
  d.open=true;a.fire('pointerdown');a.fire('pointercancel');a.fire('click',{target,detail:0});assert.equal(d.open,false);
});
test('disclosures: outside closure synchronously updates task, project and settings memories before any redraw',()=>{
  const a=disclosureUI(),task=a.fold({workFold:'transfer'}),settings=a.fold({aiFold:'mcp'}),notes=a.fold({p:'project'}),web=a.fold(),version=a.fold(),steps=a.fold();
  notes.classList.contains=n=>n==='project-notes';steps.classList.contains=n=>n==='steps';web.id='webchat-details';version.id='verd';
  a.context.rememberDisclosure(settings);a.context.rememberDisclosure(notes);
  a.fire('click',{target:{}});
  assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'transfer',true),'');assert.equal(a.context.workFoldAttr({id:'p'},{id:'other'},'transfer',true),'open');
  assert.equal(vm.runInContext('aiSettingsOpen.has("mcp")||projectNotesOpen.has("project")||verOpen||stepsOpen',a.context),false);
  assert.equal(task.open,false);assert.equal(settings.open,false);
});
test('disclosures: freetalk summary remains closed for the same summary after rendering, while a new summary can open',()=>{
  const a=disclosureUI(),p={id:'freetalk'},t={id:'topic',freetalkHistory:{draft:'kept summary',summaryId:'s1'}};
  const d=a.fold({workFold:'freetalk-summary-s1'});d.closest=()=>({dataset:{p:p.id,t:t.id}});
  assert.match(a.context.freetalkHistoryHtml(p,t),/data-work-fold="freetalk-summary-s1" open/);
  a.fire('click',{target:{}});const html=a.context.freetalkHistoryHtml(p,t);assert.doesNotMatch(html,/<details class="freetalk-summary"[^>]*\bopen\b/);assert.match(html,/kept summary/);
  t.freetalkHistory.summaryId='s2';assert.match(a.context.freetalkHistoryHtml(p,t),/data-work-fold="freetalk-summary-s2" open/);
});

test('引っ越し設定: 基本欄の説明と保存操作、バックアップ選択、進行中の再送防止', async () => {
  const a = app(); vm.runInContext('state=' + JSON.stringify(snapshot()) + ';view={kind:"settings"}', a.context);
  a.element('#ai-use-settings').contains = () => false; // Complete the DOM fixture for this settings render.
  a.context.renderSettings(); const html = a.element('#main').innerHTML;
  assert.match(html, /<h3>引っ越し<\/h3>/); assert.match(html, /ProjectHub-Move/);
  assert.match(html, /AIのログイン情報と利用コードは移しません/);
  const calls = []; let mode = 'none';
  a.context.api = async (url, body, headers) => { calls.push({url,body,headers}); if (url.endsWith('/export')) mode = 'exporting'; return { mode, progress: 12 }; };
  await a.context.loadMoveSettings(); assert.equal(calls[0].headers['X-Hub'], '1');
  a.element('#move-backups').checked = true; await a.element('#move-export').onclick();
  assert.equal(calls.filter(c => c.url.endsWith('/export')).length, 1);
  assert.equal(calls.find(c => c.url.endsWith('/export')).body.includeBackups, true);
  assert.equal(a.element('#move-export').disabled, true);
  assert.match(a.element('#move-status').innerHTML, /作成中/);
  assert.ok([...a.timeouts.values()].some(t => t.ms === 1000));
});
test('引っ越し設定: エラーと対象外の場所は文字として表示し、読み込み済みデータの片付けは確認後だけ', async () => {
  const a = app(), html = a.context.moveSettingsHtml({ mode: 'failed', error: '<script>bad()</script>', notIncluded: [{path:'<img src=x>',reason:'outside'}], attention:[{path:'repo',reason:'review'}] });
  assert.doesNotMatch(html, /<script>|<img src=x>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /含めなかったもの/);
  const calls = []; a.context.api = async (url,body) => { calls.push({url,body}); return {mode:'imported',bundle:'x.hubmove'}; };
  await a.context.loadMoveSettings(); a.context.confirm = () => false;
  await a.element('#move-trash').handlers.click(); assert.equal(calls.some(c => c.url.endsWith('/trash')), false);
  a.context.confirm = () => true; await a.element('#move-trash').handlers.click();
  assert.equal(calls.find(c => c.url.endsWith('/trash')).body.bundle, 'x.hubmove');
  assert.equal(calls.find(c => c.url.endsWith('/trash')).body.confirm, true);
});

test('License settings hide maker activation and escape issuer status without retaining a code', () => {
  const a = app(), s = snapshot(); s.license = { edition: 'public', reason: '<img src=x onerror=bad()>' };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings"}', a.context);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /id="license-code" type="password" autocomplete="off"/);
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/); assert.doesNotMatch(html, /<img src=x/);
  vm.runInContext('state.license={edition:"owner"}', a.context); a.context.renderSettings();
  assert.match(a.element('#main').innerHTML, /製作者版：鍵不要・全機能・期限なし/);
  assert.doesNotMatch(a.element('#main').innerHTML, /id="license-form"|id="license-code"/);
});

test('candidate trial dates show local start/end and remaining days; pending and master show no invented dates', () => {
  const a = app(), s = snapshot();
  a.element('#ai-use-settings').contains = () => false; // DOM fixture: no focused descendant.
  s.license = { edition: 'public', reason: '無料体験中', trial: { startsAt: 1800000000, expiry: 1802592000, remainingDays: 30 } };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings"}', a.context); a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /data-trial-dates/); assert.match(html, /残り 30 日/);
  assert.ok(html.includes(new Date(1800000000000).toLocaleString('ja-JP')));
  assert.ok(html.includes(new Date(1802592000000).toLocaleString('ja-JP')));
  vm.runInContext('state.license.trial={state:"pending",expiry:null}', a.context); a.context.renderSettings();
  assert.doesNotMatch(a.element('#main').innerHTML, /data-trial-dates|1970/);
  vm.runInContext('state.license={edition:"owner"}', a.context); a.context.renderSettings();
  assert.doesNotMatch(a.element('#main').innerHTML, /data-trial-dates/);
});

test('91: license purchase link is hidden without configuration and shown only for HTTPS, including expired trials', () => {
  const a=app(),s=snapshot();a.element('#ai-use-settings').contains=()=>false;
  s.license={edition:'public',reason:'無料体験は終わりました',trial:{state:'expired'},purchaseUrl:''};
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"settings"}',a.context);a.context.renderSettings();
  assert.doesNotMatch(a.element('#main').innerHTML,/data-license-purchase/);
  for(const url of ['https://buy.stripe.com/fixture?x=%22','javascript:bad()','http://unsafe.invalid','https://user:pass'+'@unsafe.invalid']) {
    vm.runInContext('state.license.purchaseUrl='+JSON.stringify(url),a.context);a.context.renderSettings();
    const html=a.element('#main').innerHTML;
    if(url.startsWith('https://buy.stripe.com/')){assert.match(html,/data-license-purchase/);assert.match(html,/data-url="https:\/\/buy.stripe.com\/fixture/);assert.match(html,/購入する（4,900円・税込）/);assert.doesNotMatch(html,/data-license-intro|1,100円/);}
    else assert.doesNotMatch(html,/data-license-purchase/);
  }
  vm.runInContext('state.license={edition:"owner",purchaseUrl:"https://buy.stripe.com/fixture"}',a.context);a.context.renderSettings();
  assert.doesNotMatch(a.element('#main').innerHTML,/data-license-purchase/);
  assert.equal(require('../lib/license/policy').purchaseUrl,'https://project-hub-license.kieiyellow.workers.dev/buy');
});

test('113: purchase shows one eligible price and intro clicks coalesce without exposing the Checkout URL', async () => {
  const a=app(),s=snapshot();a.element('#ai-use-settings').contains=()=>false;
  s.license={edition:'public',reason:'trial',trial:{state:'active'},purchaseUrl:'https://issuer.invalid/buy',introAvailable:true};
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"settings"}',a.context);a.context.renderSettings();
  const html=a.element('#main').innerHTML;
  assert.match(html,/data-license-intro/);assert.match(html,/体験中の特別価格で購入/);
  assert.match(html,/1,100円・税込/);
  assert.doesNotMatch(html,/data-license-purchase(?=[\s=>])|4,900円/);
  assert.match(html,/利用コードをコピー/);assert.match(html,/再購入せずコードを登録/);
  assert.doesNotMatch(html,/checkout\.stripe\.com|session_id|nonce|sig=/);
  for(const patch of [{introAvailable:false,trial:{state:'expired'}},{purchaseUrl:''},{edition:'owner'}]){
    vm.runInContext('state.license='+JSON.stringify({...s.license,...patch}),a.context);a.context.renderSettings();
    const rendered=a.element('#main').innerHTML;assert.doesNotMatch(rendered,/data-license-intro/);
    assert.equal(/data-license-purchase(?=[\s=>])/.test(rendered),patch.introAvailable===false);
    if(patch.introAvailable===false){assert.match(rendered,/4,900円・税込/);assert.match(rendered,/data-url="https:\/\/issuer.invalid\/buy"/);assert.doesNotMatch(rendered,/1,100円/);}
  }
  const click=a.documentListeners.find(x=>x.name==='click'&&x.cb.toString().includes('[data-license-intro]')).cb;
  const calls=[],button={disabled:false};let release;
  a.context.fetch=(url,options)=>{calls.push({url,options});return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({ok:true})}));};
  const event={target:{closest:s=>s==='[data-license-intro]'?button:null},preventDefault(){}};
  const first=click(event);await click(event);assert.equal(calls.length,1);assert.equal(button.disabled,true);
  assert.equal(calls[0].url,'/api/license/intro-checkout');assert.equal(calls[0].options.body,'{}');
  release();await first;assert.equal(button.disabled,false);
  a.context.fetch=async()=>({ok:false,json:async()=>({error:'https://checkout.stripe.com/c/pay/private-bearer'})});
  await click(event);assert.equal(button.disabled,false);assert.doesNotMatch(a.element('#toast').textContent,/checkout|private-bearer/);
});

test('purchased public edition hides both purchase buttons while keeping code registration available', () => {
  const a=app(),s=snapshot();
  s.license={edition:'public',purchased:true,reason:'購入した版の全機能を期限なしで使えます',purchaseUrl:'https://issuer.invalid/buy',introAvailable:true};
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"settings"}',a.context);a.context.renderSettings();
  const html=a.element('#main').innerHTML;
  assert.match(html,/購入した版の全機能を期限なしで使えます/);
  assert.doesNotMatch(html,/data-license-intro|data-license-purchase|1,100円|4,900円/);
  assert.match(html,/id="license-form"/);
});

test('License activation clears input before transport, coalesces submits and permits a safe retry', async () => {
  const a = app(), input = { value: 'TEST_ONLY_CODE' }, button = { disabled: false }, notice = { textContent: '' };
  const form = { id: 'license-form', querySelector: selector => ({ '#license-code': input, '#license-notice': notice, button })[selector] };
  const event = { target: form, preventDefault() {} }, calls = [];
  const listener = a.documentListeners.find(x => x.name === 'submit' && x.cb.toString().includes('license-form'));
  let complete;
  a.context.api = (route, body) => { assert.equal(input.value, ''); assert.equal(button.disabled, true); calls.push({ route, code: body.code }); return new Promise(resolve => { complete = resolve; }); };
  a.context.renderSettings = () => {}; a.context.toast = () => {};
  const pending = listener.cb(event); await listener.cb(event);
  assert.deepEqual(calls, [{ route: '/api/license/activate', code: 'TEST_ONLY_CODE' }]);
  complete({ ok: true, status: { edition: 'public' } }); await pending;
  assert.equal(button.disabled, false); assert.equal(input.value, '');
  input.value = 'TEST_ONLY_NEW_CODE'; a.context.api = async () => { throw Error('通信できません'); };
  await listener.cb(event); assert.equal(input.value, ''); assert.equal(button.disabled, false);
  assert.equal(notice.textContent, '通信できません');
});

for (const locale of ['ja','zh-TW']) test('Agy real model choices remain selectable after default removal, keep missing selection and escape metadata: '+locale, () => {
  const a=app(), data=snapshot(), model={id:'gemini-current',label:'Current Gemini <img src=x>'};
  data.agyAvailable=true; data.agyModels=[model];data.agyModelsState='ready';data.roles.models.agy=[model.label,'Gemini 3.1 Pro (High)'];data.cliFlags.agy={[model.label]:model.id};data.efforts=['高'];
  const p=data.projects[0],t=p.tasks[0];t.owner='agy';t.model='Gemini 3.1 Pro (High)';
  a.context.UI=require('./ui-locale-fixture')(locale);vm.runInContext('state='+JSON.stringify(data),a.context);
  const html=a.context.chatHtml(p,t), spec=a.context.specSelect(p,t,'agy',false), list=a.context.agyModelsHtml();
  assert.match(html,/value="agy\|Gemini 3.1 Pro \(High\)"[^>]*selected disabled/);
  const option=html.match(/<option[^>]*value="agy\|Current Gemini[^>]*>[^<]*<\/option>/)[0];
  assert.doesNotMatch(option,/disabled|selected|gemini-current/);assert.match(option,/&lt;img/);
  assert.match(spec,/data-ai="agy"/);assert.match(spec,/value="Current Gemini/);assert.match(list,/<code>gemini-current<\/code>/);assert.doesNotMatch(list,/<img/);
  t.model='';assert.equal(a.context.chatPick(p,t).model,'');assert.match(a.context.chatHtml(p,t),/value="agy\|"[^>]*selected disabled/);
  assert.equal(a.context.modelRequest('agy',model.label),model.id);
  const readyKey=a.context.mainKey();vm.runInContext('state.agyModelsState="failed";state.agyAvailable=false',a.context);
  assert.notEqual(a.context.mainKey(),readyKey);
  const roles=JSON.stringify(data.roles.roles);a.context.adoptAgyCatalog({agyCatalog:{models:[],state:'empty',available:false}});assert.equal(JSON.stringify(data.roles.roles),roles);
});

test('Agy labels keep every thinking tier and route while omitting only duplicate IDs',()=>{
  const a=app(),s=snapshot(),models=[
    ['gemini-3.8-flash-high','Gemini 3.8 Flash (High)'],['gemini-3.8-flash-medium','Gemini 3.8 Flash (Medium)'],['gemini-3.8-flash-low','Gemini 3.8 Flash (Low)'],
    ['claude-sonnet-4-6','Claude Sonnet 4.6 (Thinking)'],['claude-opus-4-6-thinking','Claude Opus 4.6 (Thinking)'],['gpt-oss-120b-medium','GPT-OSS 120B (Medium)'],
  ].map(([id,label])=>({id,label}));
  s.agyAvailable=true;s.agyModels=models;s.roles.models.agy=models.map(r=>r.label);s.cliFlags.agy=Object.fromEntries(models.map(r=>[r.label,r.id]));
  vm.runInContext('state='+JSON.stringify(s),a.context);
  const before=vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.agyModels])',a.context);
  for(const row of models){
    assert.equal(a.context.shortModelLabel('agy',row.label),row.label);
    assert.equal(a.context.modelOptionLabel('agy',row.id),row.label);
    assert.equal(a.context.modelRequest('agy',row.label),row.id);
    const html=a.context.chatModelOption('agy',row.label,'Agy CLI・'+row.label);
    assert.ok(html.endsWith('>Agy CLI・'+row.label+'</option>'));
    assert.ok(html.includes('value="agy|'+row.label+'"'));assert.ok(!html.includes(row.id));
    assert.ok(a.context.roleModelOptions('agy',row.label).includes('value="'+row.label+'" selected'));
  }
  assert.equal(a.context.shortModelLabel('agy','saved-unknown'), 'saved-unknown');
  assert.equal(a.context.modelRequest('agy','saved-unknown'), 'saved-unknown');
  assert.equal(a.context.modelOptionLabel('claude','Opus 5.5'),'Opus 5.5');
  assert.equal(vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.agyModels])',a.context),before);
});

test('Agy composer sends the selected observed ID and blocks an unselected placeholder',async()=>{
  const a=historyUI(), model={id:'gemini-current',label:'Current Gemini'}, calls=[];
  vm.runInContext('state.agyAvailable=true;state.agyModels='+JSON.stringify([model])+';state.roles.models.agy=["Current Gemini"]',a.context);
  a.context.api=async(route,body)=>{calls.push({route,body});return {ok:true,model:model.label};};
  a.type('manual request');a.element('#chat-ai').value='agy|';a.element('#chat-ai').selectedOptions=[{disabled:true}];
  await a.element('#composer').handlers.submit({preventDefault(){}});assert.equal(calls.length,0);
  a.element('#chat-ai').value='agy|Current Gemini';a.element('#chat-ai').selectedOptions=[{disabled:false}];
  await a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(calls[0].route,'/api/chat/send');assert.equal(calls[0].body.model,model.id);
});

test('Agy model refresh sends the protected read header and updates only the observed catalogue', async () => {
  const a=app(),s=snapshot(),row={id:'gemini-current',label:'Current Gemini'};
  vm.runInContext('state='+JSON.stringify(s),a.context);
  a.context.drawAccountSettings=()=>{};a.context.refreshAiToolCatalog=async()=>{};a.context.toast=()=>{};
  let calls=0;
  a.context.fetch=async(path,options)=>{
    calls++;assert.equal(path,'/api/accounts?status=1&ai=agy');assert.equal(options.headers['X-Hub'],'1');
    return {ok:true,status:200,json:async()=>({accounts:[{ai:'agy',id:'default',status:'logged-in'}],agyCatalog:{models:[row],state:'ready',available:true}})};
  };
  const button={disabled:false};
  const listener=a.documentListeners.find(x=>x.name==='click'&&x.cb.toString().includes('[data-agy-model-refresh]'));
  await listener.cb({target:{closest:()=>button}});
  assert.equal(calls,1);assert.equal(a.context.modelRequest('agy',row.label),row.id);
  assert.equal(vm.runInContext('state.agyModelsState',a.context),'ready');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(state.roles.roles)',a.context)),s.roles.roles);
});

for (const locale of ['ja', 'zh-TW']) test('Skills settings distinguish detected files from recorded usage and escape file metadata: ' + locale, async () => {
  const a = app(); a.context.UI = require('./ui-locale-fixture')(locale);
  const malicious = '<script>alert(1)</script>';
  const result = { ais: { claude: { found: true, items: [{ name: malicious, description: '<img src=x onerror=bad()>', source: 'user' }] },
    codex: { found: true, items: [{ name: 'imagegen', description: '', source: 'system' }], limited: true },
    agy: { found: false, items: [] }, grok: { found: false, items: [] } } };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p"}', a.context);
  a.context.fixtureSkills = result;
  vm.runInContext('skillsResult=fixtureSkills', a.context);
  a.context.api = async route => route.startsWith('/api/skills') ? result : new Promise(() => {});
  a.context.renderSettings();
  await new Promise(resolve => setImmediate(resolve)); // VMとホスト間の初回読み込みを終えてから再確認する。
  const html = a.element('#main').innerHTML;
  assert.match(html, /data-tab="ai"><h2 class="pref-caption">(スキル|技能)<\/h2>/);
  const skillsStart = html.indexOf('<h2 class="pref-caption">' + (locale === 'ja' ? 'スキル' : '技能') + '</h2>');
  const card = html.slice(skillsStart, html.indexOf('</section>', skillsStart));
  assert.match(card, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(card, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(card, /<script>|<img/);
  assert.match(card, locale === 'ja' ? /付属/ : /隨附/);
  assert.match(card, locale === 'ja' ? /使えないとは限りません/ : /不代表無法使用/);
  assert.match(card, locale === 'ja' ? /追加アカウント/ : /額外帳號/);
  assert.match(card, locale === 'ja' ? /使ったスキル/ : /使用過的技能/);
  assert.match(card, locale === 'ja' ? /一部のスキルは表示していません/ : /部分技能未列出/);
  const calls = [];
  a.context.api = async route => { calls.push(route); return result; };
  await a.context.loadSkills(true);
  assert.equal(calls.at(-1), '/api/skills?fresh=1');
  assert.equal(a.element('#skills-check').disabled, false);
  a.context.api = async () => { throw Error('<b>failure</b>'); };
  await a.context.loadSkills(true);
  assert.match(a.element('#skills-box').innerHTML, /&lt;b&gt;failure&lt;\/b&gt;/);
  assert.doesNotMatch(a.element('#skills-box').innerHTML, /<b>failure/);
});

test('Skills loading preserves open AI sections, rejects duplicate requests and ignores a response after leaving settings', async () => {
  const a = app(); vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view={kind:"settings"}', a.context);
  const details = [{ open: true, dataset: { skillsAi: 'codex' } }, { open: false, dataset: { skillsAi: 'claude' } }];
  a.element('#skills-box').querySelectorAll = () => details;
  let resolve, calls = 0; a.context.api = () => { calls++; return new Promise(done => { resolve = done; }); };
  const pending = a.context.loadSkills();
  await a.context.loadSkills(); assert.equal(calls, 1); assert.equal(a.element('#skills-check').disabled, true);
  resolve({ ais: Object.fromEntries(['claude', 'codex', 'agy', 'grok'].map(ai => [ai, { found: false, items: [] }])) });
  await pending; assert.equal(details[0].open, true); assert.equal(details[1].open, false);
  const before = a.element('#skills-box').innerHTML, next = a.context.loadSkills(true);
  vm.runInContext('view.kind="project"', a.context); resolve({ ais: {} }); await next;
  assert.equal(a.element('#skills-box').innerHTML, before);
});

test('自動ChatをGPT子の既定にし、旧依頼とrequest別の処理済み表示を保持する', () => {
  const a = app(); a.context.fixture = snapshot();
  vm.runInContext('state=fixture; view={kind:"work",project:"p",task:"t"}; state.projects[0].tasks.push({id:"gpt",title:"GPT：Task",gptChild:true,parent:"t",owner:"chatgpt"});', a.context);
  assert.equal(vm.runInContext('chatPick(state.projects[0],state.projects[0].tasks[1]).model', a.context), 'auto');
  const controls = vm.runInContext('gptChildLink("p","gpt")', a.context);
  assert.match(controls,/GPT子を開く/);assert.match(controls,/data-t="gpt"/);
  assert.doesNotMatch(controls,/data-copy|合図|覚えさせる文/);
  assert.match(vm.runInContext('msgHtml({role:"user",to:"gptchat",request:"r",text:"依頼"})', a.context), /data-gpt-request="r"/);
  assert.match(vm.runInContext('msgHtml({role:"assistant",ai:"chatgpt-chat",request:"r",text:"返事"})', a.context), /data-gpt-report="r"/);
  assert.match(vm.runInContext('msgHtml({role:"user",from:"gptchat-report",childTask:"gpt",text:"通知"})', a.context), /GPT子を開く/);
  const heading = { textContent: '' }, requestRow = { dataset: { gptRequest: 'r' }, querySelector: () => heading };
  const box = { querySelectorAll: selector => selector === '[data-gpt-request]' ? [requestRow] : [] };
  a.context.refreshRequestStatus(box); assert.equal(heading.textContent, 'ChatGPT（Chat）への依頼（未処理）');
  box.querySelectorAll = selector => selector === '[data-gpt-request]' ? [requestRow] : selector === '[data-gpt-report]' ? [{ dataset: { gptReport: 'r' } }] : [];
  a.context.refreshRequestStatus(box); assert.equal(heading.textContent, 'ChatGPT（Chat）への依頼（処理済み）');
});

test('整理と利用状況は外側の一覧タップで閉じ、実際の画面移動を続ける', () => {
  for (const [go, pid, shouldClose] of [['project', 'other', true], ['work', 'other', true], ['work', 'p', true]]) {
    const a = app(); a.context.api = () => new Promise(() => {});
    const navigation = a.documentListeners.find(x => x.name === 'click' && x.cb.toString().includes("e.target.closest('[data-go]')"));
    const before = a.documentListeners.length;
    for (const file of ['maintenance.js', 'usage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), a.context);
    const captures = a.documentListeners.slice(before).filter(x => x.name === 'click' && x.capture);
    vm.runInContext('maintenanceProject="p";view={kind:"project",project:"p"};', a.context);
    a.element('#maintenance-drawer').hidden = false; a.element('#usage-drawer').hidden = false;
    a.element('#usage-toggle').focus = () => assert.fail('outside navigation must retain focus');
    let attached = true, rendered = false;
    const button = { dataset: { go, p: pid, t: go === 'work' ? 't' : undefined }, closest: s => s === '#list' && attached ? a.element('#list') : null };
    const event = { target: { id: '', dataset: {}, closest: s => s === '[data-go]' || s === '#list [data-go][data-p]' && attached ? button : null },
      preventDefault: () => assert.fail('navigation must continue'), stopPropagation: () => assert.fail('navigation must continue') };
    a.context.closeDrawer = () => {}; a.context.markRead = () => {}; a.context.showInTree = () => {}; a.context.save = () => {};
    a.context.render = () => {
      assert.equal(a.element('#maintenance-drawer').hidden, shouldClose);
      assert.equal(a.element('#usage-drawer').hidden, true);
      attached = false; rendered = true;
    };
    for (const listener of captures) listener.cb(event);
    navigation.cb(event);
    assert.equal(rendered, true);
    assert.equal(vm.runInContext('view.kind', a.context), go); assert.equal(vm.runInContext('view.project', a.context), pid);
    assert.equal(a.element('#usage-toggle').attributes['aria-expanded'], 'false');
  }
});

const notesToggle = (id, open, isConnected = true) => ({
  target: { id: '', dataset: { p: id }, open, isConnected,
    classList: { contains: c => c === 'project-notes' } },
});
const notesTag = a => a.element('#main').innerHTML.match(/<details class="more project-notes"[^>]*>/)?.[0];

test('account picker hides the single default, escapes names and preserves deleted selection', () => {
  const a = app(), data = snapshot();
  data.accounts = [{ ai: 'codex', id: 'default', name: '既定' }];
  vm.runInContext('state=' + JSON.stringify(data), a.context);
  assert.match(a.context.taskAccountSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), /hidden/);
  data.accounts.push({ ai: 'codex', id: 'one', name: '<secret>' });
  vm.runInContext('state=' + JSON.stringify(data), a.context);
  const html = a.context.taskAccountSelect(data.projects[0], { ...data.projects[0].tasks[0], accounts: { codex: 'removed' } }, 'codex');
  assert.match(html, /value="removed" selected disabled/); assert.match(html, /&lt;secret&gt;/); assert.doesNotMatch(html, /<secret>/);
});
test('account saving updates the latest task, retains drafts, and restores selection on failure', async () => {
  const a = app(), data = snapshot(), select = { dataset: { p: 'p', t: 't', ai: 'codex' }, value: 'one', disabled: false };
  vm.runInContext('state=' + JSON.stringify(data) + ';chatDraft.keep="入力中"', a.context);
  let resolve; a.context.api = () => new Promise(r => { resolve = r; });
  const pending = a.context.saveTaskAccount(select); assert.equal(select.disabled, true);
  vm.runInContext('state.projects[0].tasks[0]={...state.projects[0].tasks[0]}', a.context);
  resolve({ accounts: { codex: 'one' } }); await pending;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].accounts.codex', a.context), 'one');
  assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
  a.context.api = async () => { throw Error('failed'); }; select.value = 'two'; await a.context.saveTaskAccount(select);
  assert.equal(select.value, 'one'); assert.equal(select.disabled, false);
});

function accountApp(terminal = true) {
  const a = app(), data = snapshot('未着手'); data.terminal = terminal;
  data.projects[0].tasks[0].accounts = { claude: 'old-c', codex: 'old-x' };
  data.accounts = ['claude', 'codex'].flatMap(ai => ['default', 'old-' + (ai === 'claude' ? 'c' : 'x'), 'new-' + (ai === 'claude' ? 'c' : 'x')].map(id => ({ ai, id, name: id })));
  vm.runInContext('state=' + JSON.stringify(data) + ';view={kind:"work",project:"p",task:"t"};chatDraft.keep="入力中"', a.context);
  const select = a.element('#chat-account');
  select.dataset = { p: 'p', t: 't', ai: 'codex' }; select.value = 'new-x'; select.tagName = 'SELECT';
  a.document.querySelectorAll = q => q === '[data-task-account]' ? [select] : [];
  a.document.activeElement = select;
  a.context.toast = () => {};
  return { ...a, data, select };
}
const selectedAccount = (a, ai = 'codex') => vm.runInContext(`state.projects[0].tasks[0].accounts.${ai}`, a.context);

for (const method of ['refreshTree', 'pollState', 'load', 'refreshAiToolCatalog']) {
  for (const arrival of ['during-save', 'after-save']) test(`account selection rejects old ${method} response ${arrival} and sends the shown account`, async () => {
    const a = accountApp(); let saved, fetched;
    a.context.api = route => new Promise(resolve => { if (route === '/api/accounts/select') saved = resolve; else { assert.equal(route, '/api/state'); fetched = resolve; } });
    const saving = a.context.saveTaskAccount(a.select), fetching = a.context[method]();
    if (arrival === 'during-save') { fetched(a.data); await fetching; }
    saved({ accounts: { claude: 'old-c', codex: 'new-x' } }); await saving;
    if (arrival === 'after-save') { fetched(a.data); await fetching; }
    assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
    assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    a.element('#chat-ai').value = 'codex|GPT-6.1-Sol'; a.element('#chat-in').value = 'send shown account';
    let sent;
    a.context.api = async (route, body) => {
      if (route === '/api/chat/send') { sent = body.account; throw Error('request captured without CLI'); }
      return [];
    };
    a.context.openChat(a.data.projects[0], a.data.projects[0].tasks[0]);
    await a.element('#composer').handlers.submit({ preventDefault() {} });
    assert.equal(sent, a.select.value);
  });
}
// Keep the real api/fetchState: only HTTP is simulated, including conditional 304s.
function accountHttp(a) {
  let server = JSON.parse(JSON.stringify(a.data)), tag = '"initial"', held, saved;
  const requests = [];
  a.context.fetch = (route, opt = {}) => {
    if (route === '/api/accounts/select') return new Promise(resolve => {
      saved = () => resolve({ status: 200, ok: true, json: async () => ({ accounts: { codex: 'new-x' } }) });
    });
    assert.equal(route, '/api/state');
    const sentTag = opt.headers?.['If-None-Match'];
    const status = sentTag === tag ? 304 : 200;
    const data = JSON.parse(JSON.stringify(server)), responseTag = tag;
    requests.push({ sentTag, status });
    const response = { status, ok: status === 200, headers: { get: key => key === 'etag' ? responseTag : null }, json: async () => data };
    if (held === true) return new Promise(resolve => { held = () => resolve(response); });
    return Promise.resolve(response);
  };
  return {
    requests,
    update(title, nextTag) {
      server.projects[0].tasks[0].title = title;
      server.projects[0].tasks[0].accounts = { claude: 'new-c', codex: 'new-x' };
      tag = nextTag;
    },
    hold() { held = true; },
    release() { const resolve = held; held = null; resolve(); },
    save() { saved(); },
  };
}

for (const method of ['load', 'refreshTree', 'pollState', 'refreshAiToolCatalog']) {
  for (const start of ['before-save', 'during-save']) for (const arrival of ['during-save', 'after-save']) {
    test(`discarded HTTP ${method} (${start}/${arrival}) leaves its ETag unacknowledged and retries the state`, async () => {
      const a = accountApp(), http = accountHttp(a);
      await a.context.refreshTree();
      assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
      a.select.value = 'new-x';
      http.update('shared updated title', '"shared"'); http.hold();
      let saving, fetching;
      if (start === 'before-save') { fetching = a.context[method](); saving = a.context.saveTaskAccount(a.select); }
      else { saving = a.context.saveTaskAccount(a.select); fetching = a.context[method](); }
      if (arrival === 'during-save') { http.release(); await fetching; }
      http.save(); await saving;
      if (arrival === 'after-save') { http.release(); await fetching; }
      assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'Task');
      assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
      assert.equal(selectedAccount(a, 'claude'), 'old-c');
      await a.context.refreshTree();
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'shared updated title');
      assert.equal(selectedAccount(a, 'claude'), 'new-c');
      assert.equal(vm.runInContext('stateTag', a.context), '"shared"');
      await a.context.refreshTree();
      assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 304]);
      assert.equal(http.requests[2].sentTag, '"initial"');
      assert.equal(http.requests[3].sentTag, '"shared"');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    });
  }
  for (const arrival of ['before-new-state', 'after-new-state']) {
    test(`parallel HTTP ${method} discarded ${arrival} cannot replace the adopted state ETag`, async () => {
      const a = accountApp(), http = accountHttp(a);
      await a.context.refreshTree(); a.select.value = 'new-x';
      const saving = a.context.saveTaskAccount(a.select);
      http.update('discarded title', '"discarded"'); http.hold();
      const fetching = a.context[method]();
      http.save(); await saving;
      if (arrival === 'before-new-state') { http.release(); await fetching; }
      http.update('latest title', '"latest"');
      await a.context.refreshTree();
      if (arrival === 'after-new-state') { http.release(); await fetching; }
      assert.equal(vm.runInContext('stateTag', a.context), '"latest"');
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'latest title');
      assert.equal(selectedAccount(a, 'claude'), 'new-c');
      assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
      await a.context.refreshTree();
      assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 304]);
      assert.equal(http.requests[3].sentTag, '"latest"');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    });
  }
}

for (const method of ['load', 'refreshTree', 'pollState', 'refreshAiToolCatalog']) {
  test(`accepted HTTP ${method} acknowledges exactly its state, then conditional retrieval returns 304`, async () => {
    const a = accountApp(), http = accountHttp(a);
    a.context.render = () => {}; // Only rendering is stubbed; HTTP and adoption stay real.
    http.update('accepted title', '"accepted"');
    await a.context[method]();
    assert.equal(vm.runInContext('stateTag', a.context), '"accepted"');
    assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'accepted title');
    await a.context.refreshTree();
    assert.deepEqual(http.requests.map(r => r.status), [200, 304]);
    assert.equal(http.requests[1].sentTag, '"accepted"');
  });
}

test('parallel HTTP bodies retain their own ETags even when JSON decoding finishes out of order', async () => {
  const a = accountApp(), http = accountHttp(a);
  await a.context.refreshTree();
  const normalFetch = a.context.fetch;
  let finishBody;
  http.update('older title', '"older"');
  a.context.fetch = async (...args) => {
    const r = await normalFetch(...args), data = await r.json();
    return { ...r, json: () => new Promise(resolve => { finishBody = () => resolve(data); }) };
  };
  const older = a.context.refreshTree();
  // Let the headers arrive while the older response body is still pending.
  for (let n = 0; n < 10 && !finishBody; n++) await Promise.resolve();
  assert.equal(typeof finishBody, 'function');
  a.context.fetch = normalFetch;
  http.update('latest title', '"latest"');
  await a.context.refreshTree();
  assert.equal(vm.runInContext('stateTag', a.context), '"latest"');
  finishBody(); await older;
  // Both notifications share an epoch: if the older body is adopted, its own tag
  // must travel with it, so the next request can retrieve the latest state again.
  assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'older title');
  assert.equal(vm.runInContext('stateTag', a.context), '"older"');
  await a.context.refreshTree(); await a.context.refreshTree();
  assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'latest title');
  assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 200, 304]);
});

test('failed HTTP state requests preserve the accepted ETag and untagged adoption clears it', async () => {
  const a = accountApp(), http = accountHttp(a);
  await a.context.refreshTree();
  a.context.fetch = async () => ({ status: 500, ok: false, headers: { get: () => '"error"' }, json: async () => ({ error: 'state unavailable' }) });
  await assert.rejects(a.context.fetchState(), /state unavailable/);
  assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
  const untagged = a.data;
  a.context.fetch = async () => ({ status: 200, ok: true, json: async () => untagged });
  await a.context.refreshTree();
  assert.equal(vm.runInContext('stateTag', a.context), '');
});

for (const order of [['claude', 'codex'], ['codex', 'claude']]) test(`account save responses in ${order.join('/')} order retain both selections`, async () => {
  const a = accountApp(), pending = {}, selects = {}, jobs = {};
  a.context.api = (_route, b) => new Promise(resolve => { pending[b.ai] = resolve; });
  for (const ai of ['claude', 'codex']) {
    selects[ai] = { dataset: { p: 'p', t: 't', ai }, value: ai === 'claude' ? 'new-c' : 'new-x' };
    jobs[ai] = a.context.saveTaskAccount(selects[ai]);
  }
  // Each response is allowed to contain the other AI's stale snapshot.
  for (const ai of order) { pending[ai]({ accounts: { claude: ai === 'claude' ? 'new-c' : 'old-c', codex: ai === 'codex' ? 'new-x' : 'old-x' } }); await jobs[ai]; }
  assert.equal(selectedAccount(a, 'claude'), 'new-c'); assert.equal(selectedAccount(a), 'new-x');
});
test('the same task/AI cannot save through a second picker until the first selection settles', async () => {
  const a = accountApp(); let saved, calls = 0;
  a.context.api = () => { calls++; return new Promise(resolve => { saved = resolve; }); };
  const saving = a.context.saveTaskAccount(a.select);
  const second = { dataset: { ...a.select.dataset }, value: 'default' };
  await a.context.saveTaskAccount(second); assert.equal(calls, 1); assert.equal(second.value, 'old-x');
  saved({ accounts: { codex: 'new-x' } }); await saving;
  assert.equal(selectedAccount(a), 'new-x');
});
test('focused account picker follows a later authoritative state instead of displaying an unsent account', async () => {
  const a = accountApp(); a.context.api = async () => a.data;
  await a.context.refreshTree();
  assert.equal(a.select.value, 'old-x'); assert.equal(selectedAccount(a), a.select.value);
});
for (const terminal of [true, false]) for (const outcome of ['success', 'failure']) test(`${terminal ? 'embedded' : 'external'} terminal waits for account save ${outcome} and pins the settled selection`, async () => {
  const a = accountApp(terminal), calls = []; let resolve, reject, fetched;
  a.context.api = (route, body) => {
    if (route === '/api/accounts/select') return new Promise((yes, no) => { resolve = yes; reject = no; });
    if (route === '/api/state') return new Promise(yes => { fetched = yes; });
    calls.push({ route, body }); return Promise.resolve({ dir: '/fixture' });
  };
  const saving = a.context.saveTaskAccount(a.select), oldFetch = a.context.refreshTree();
  await a.context.startAI('p', 't', 'codex'); assert.equal(calls.length, 0);
  if (outcome === 'success') resolve({ accounts: { codex: 'new-x' } }); else reject(Error('save failed'));
  await saving; fetched(a.data); await oldFetch;
  a.context.load = async () => {};
  const starting = a.context.startAI('p', 't', 'codex');
  // A later selection cannot alter the already constructed request.
  vm.runInContext('state.projects[0].tasks[0].accounts.codex="default"', a.context);
  await starting;
  assert.equal(calls.length, 1); assert.equal(calls[0].route, terminal ? '/api/term/start' : '/api/continue');
  assert.equal(calls[0].body.account, outcome === 'success' ? 'new-x' : 'old-x');
  assert.equal(a.select.value, calls[0].body.account);
  assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
});

for (const action of ['child', 'branch']) test(`ツリーの${action === 'child' ? '子作業は共通の初期AIで作成' : '分岐も共通の初期AIで作成'}する`, async () => {
  const a = app(), data = snapshot(), calls = [];
  const parent = data.projects[0].tasks[0];
  Object.assign(parent, { owner: 'claude-code', role: '司令塔', phase: '設計', parent: 'grandparent', model: 'Opus 5.5', effort: 'MAX' });
  data.roles.models = { codex: ['Astra', 'GPT-6.1-Sol'], 'claude-code': ['Fable 5.1', 'Opus 5.5'] };
  data.roles.roles = [{ name: '司令塔', main: { ai: 'claude-code', model: 'Fable 5.1', effort: '極高' }, backup: { ai: 'codex', model: 'Astra', effort: '極高' } }];
  data.efforts = ['中', '高', '極高', 'MAX'];
  data.initialPick = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/hierarchy.js'), 'utf8'), a.context);
  a.context.innerWidth = 1000; a.context.innerHeight = 700;
  a.context.prompt = () => '新しい作業';
  a.context.api = async (route, body) => { calls.push({ route, body }); return { ...body, id: 'created', steps: [], state: '未着手' }; };
  a.context.load = async () => {};
  const menu = a.element('#menu'); menu.style = {}; menu.offsetWidth = 200; menu.offsetHeight = 160;
  menu.querySelector = () => ({ focus() {} });
  a.context.showTreeMenu('p', 't', 20, 20);
  await menu.onclick({ target: { closest: () => ({ dataset: { treeAction: action } }) } });
  assert.equal(calls.length, 1); assert.equal(calls[0].route, '/api/task/new');
  const body = JSON.parse(JSON.stringify(calls[0].body));
  assert.deepEqual(body, {
    project: 'p', title: '新しい作業', parent: action === 'child' ? 't' : 'grandparent',
    kind: action === 'child' ? 'main' : 'derived', derivedFrom: action === 'child' ? '' : 'p/t',
    owner: 'claude-code', model: 'Opus 5.5', effort: '中', phase: '設計', role: '司令塔',
  });
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(view)', a.context)), { kind: 'work', project: 'p', task: 'created' });
  assert.equal(parent.owner, 'claude-code'); assert.equal(parent.model, 'Opus 5.5'); assert.equal(parent.effort, 'MAX');
  if (action === 'child') {
    const child = { ...body, id: 'created', steps: [] }, html = a.context.chatHtml(data.projects[0], child);
    assert.match(a.context.chip(data.projects[0], child), /Claude Code.*Opus 5\.5・中/);
    assert.match(html, /value="claude\|Opus 5.5"[^>]*\bselected\b/);
    assert.match(html, /<option selected>中<\/option>/);
  }
});

test('問題点は今の問題・未整理・閉じた履歴に分かれ、原文は詳しくの中だけに残る', () => {
  const a = app(), p = project();
  p.issues = [
    { text: '内部ID・commitと経緯\n次の行', level: '高', summary: { title: '場所の確認', state: '確認待ち', next: '場所を確認する', who: '人' } },
    '【作者の見出し】長い経緯', '見出しのない経緯',
    { text: '古い原文', summary: { title: '貼り付けの修正', state: '解決済み', next: '', who: '' } },
    { text: '判断の原文', summary: { title: '対応を決める', state: '判断待ち', next: '選択肢を整理する', who: 'AI' } },
    { text: '未解決の原文', summary: { title: '保存できない', state: '未解決', next: '', who: '' } },
    { text: '過去の原文', summary: { title: '過去の判断', state: '履歴', next: '', who: '' } },
  ];
  a.context.renderOverview(p);
  const html = a.element('#main').innerHTML;
  assert.ok(html.indexOf('今の問題') < html.indexOf('まだまとめていない（2件）'));
  assert.ok(html.indexOf('まだまとめていない（2件）') < html.indexOf('解決済み・履歴（2件）'));
  assert.match(html, /次：あなた：場所を確認する/); assert.match(html, /次：AI：選択肢を整理する/);
  assert.match(html, /<span class="pill">高<\/span>/);
  assert.match(html, /<details class="issue-history issue-group"><summary>解決済み・履歴（2件）/);
  assert.match(html, /<b class="issue-title issue-unprepared">【作者の見出し】<\/b>/);
  assert.match(html, /<b class="issue-title issue-unprepared">見出しなし<\/b>/);
  assert.match(html, /<p class="issue-original">内部ID・commitと経緯\n次の行<\/p>/);
  const collapsed = html.replace(/<details class="issue-detail">[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(collapsed, /長い経緯|見出しのない経緯|内部ID・commitと経緯|古い原文/);
  assert.match(html, /このプロジェクトの作業の会話で「問題点を短くまとめて」/);
});

test('問題点の要約・原文・作者見出しをエスケープし、長文を要約として切り出さない', () => {
  const a = app(), text = '<script>evil</script>\n' + '長文'.repeat(1000);
  const html = a.context.issuesHtml([
    { text, summary: { title: '<img src=x onerror="evil">', state: '確認待ち', next: '<script>next</script>', who: '人' } },
    '【<script>見出し</script>】原文',
  ]);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;evil&quot;&gt;/);
  assert.match(html, /次：あなた：&lt;script&gt;next&lt;\/script&gt;/);
  assert.match(html, /【&lt;script&gt;見出し&lt;\/script&gt;】/);
  assert.ok(html.includes('&lt;script&gt;evil&lt;/script&gt;\n' + '長文'.repeat(1000)));
  assert.doesNotMatch(html.replace(/<details class="issue-detail">[\s\S]*?<\/details>/g, ''), /長文/);
  assert.equal(a.context.issuesHtml([]), '<p class="note">なし</p>');
  assert.match(a.context.issuesHtml(['未整理']), /今の問題はありません/);
  assert.match(a.context.issuesHtml([{ text: '済', summary: { title: '済', state: '解決済み', next: '', who: '' } }]), /今の問題はありません/);
});

test('Agy is manually selectable with High fixed, without changing the default Codex selection', () => {
  const a = app(), s = snapshot();
  s.roles.models.codex = ['GPT-6.1-Sol'];
  s.roles.models.agy = ['Gemini 3.1 Pro (High)'];
  s.efforts = ['中', '高', '極高']; s.agyAvailable = true;
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  assert.equal(a.context.chatPick(s.projects[0], s.projects[0].tasks[0]).ai, 'codex');
  const html = a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  assert.match(html, /value="agy\|Gemini 3.1 Pro \(High\)"/);
  assert.doesNotMatch(html, /value="agy\|[^\"]+"[^>]*selected/);
  s.projects[0].tasks[0].owner = 'agy';
  const selected = a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  assert.match(selected, /id="chat-effort"[^>]*hidden[^>]*disabled/);
  assert.equal(a.context.ownerOf('agy').ic, 'G');
  vm.runInContext('state.agyAvailable = false', a.context);
  assert.match(a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]), /value="agy\|Gemini 3.1 Pro \(High\)"[^>]*disabled/);
});

test('メモ全文は開く時に取得し同じhashでは再取得せず、変更時は古い全文を表示しない', async () => {
  const a=app(),p=project();Object.assign(p,{notesSummary:'先頭',notesBytes:176000,notesHash:'first'});
  a.context.fixture=p;a.context.fixtureState=snapshot();vm.runInContext('state=fixtureState;state.projects=[fixture];view={kind:"project",project:"p"};renderOverview(fixture)',a.context);
  assert.match(a.element('#main').innerHTML,/先頭/);
  const text={textContent:''},detail=a.element('.project-notes');detail.dataset.p='p';detail.querySelector=()=>text;
  let calls=0;a.context.api=async()=>{calls++;return {hash:p.notesHash,notes:'末尾まで全文\n<原文>'+p.notesHash};};
  await a.context.loadProjectNotes('p');await a.context.loadProjectNotes('p');assert.equal(calls,1);assert.match(text.textContent,/末尾まで全文\n<原文>first/);
  p.notesHash='second';p.notesSummary='新しい先頭';assert.equal(vm.runInContext('projectNotesText(fixture)',a.context),'新しい先頭');
  await a.context.loadProjectNotes('p');assert.equal(calls,2);assert.match(text.textContent,/<原文>second/);
});

test('説明・メモは初期状態で閉じ、原文の改行とエスケープを保つ', () => {
  const a = app();
  const p = project(); p.description = '説明1行目\n<b>説明2行目</b>'; p.notes = '代わりのメモ';
  a.context.renderOverview(p);
  assert.ok(notesTag(a));
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  assert.match(a.element('#main').innerHTML, /<summary>説明・メモ<\/summary><p class="desc">説明1行目\n&lt;b&gt;説明2行目&lt;\/b&gt;<\/p>/);
  p.description = '';
  a.context.renderOverview(p);
  assert.match(a.element('#main').innerHTML, /<p class="desc">代わりのメモ<\/p>/);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  p.notes = '';
  a.context.renderOverview(p);
  assert.equal(notesTag(a), undefined);
});

test('説明・メモの開閉を再描画後もプロジェクト別に保持し、開き直すと閉じる', () => {
  const a = app();
  const p = project(); p.notes = 'メモ';
  const q = { ...p, id: 'q' };
  const toggle = a.events.get('toggle');
  toggle(notesToggle('p', true));
  a.context.renderOverview(p);
  assert.match(notesTag(a), /\bopen\b/);
  a.context.renderOverview(q);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', false, false)); // 古いDOMの遅れたイベントは無視
  a.context.renderOverview(p);
  assert.match(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', false));
  a.context.renderOverview(p);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', true));
  const fresh = app();
  fresh.context.renderOverview(p);
  assert.doesNotMatch(notesTag(fresh), /\bopen\b/);
});

test('説明・メモを開いても作業の定期更新を続け、入力用の折りたたみは保護する', async () => {
  const a = app();
  const first = snapshot(); first.projects[0].notes = '長いメモ';
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  const opened = notesToggle('p', true);
  a.events.get('toggle')(opened);
  a.details.push(opened.target);
  const next = snapshot('完了'); next.projects[0].notes = '長いメモ';
  a.context.api = async () => next;
  await a.context.pollState();
  assert.match(a.element('#main').innerHTML, /完了した作業（1）/);
  assert.match(notesTag(a), /\bopen\b/);
  const priorHTML = a.element('#main').innerHTML;
  a.details.push({ open: true, classList: { contains: () => false } });
  a.context.api = async () => first;
  await a.context.pollState();
  assert.equal(a.element('#main').innerHTML, priorHTML);
});

test('非表示中の定期取得を止め、復帰時に1回更新する', async () => {
  const a = app();
  let calls = 0;
  a.context.api = async () => { calls++; return snapshot(); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.document.hidden = true;
  await a.context.pollState();
  await a.context.pollSessions();
  assert.equal(calls, 0);
  a.document.hidden = false;
  a.events.get('visibilitychange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('同じ状態は再描画せず、取得中に始めた入力は次回まで保持する', async () => {
  const a = app();
  let resolveFetch;
  let renders = 0;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const same = a.context.pollState();
  resolveFetch(snapshot());
  await same;
  assert.equal(renders, 0);

  const started = a.context.pollState();
  a.document.activeElement = { tagName: 'TEXTAREA', value: 'draft' };
  resolveFetch(snapshot('完了'));
  await started;
  assert.equal(renders, 0);
  assert.equal(a.document.activeElement.value, 'draft');

  a.document.activeElement = null;
  const later = a.context.pollState();
  resolveFetch(snapshot('完了'));
  await later;
  assert.equal(renders, 1);
});

test('重複する定期取得を抑え、明示 load の結果を古い取得で上書きしない', async () => {
  const a = app();
  const pending = [];
  a.context.api = () => new Promise(resolve => pending.push(resolve));
  a.context.render = () => {};
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const automatic = a.context.pollState();
  await a.context.pollState();
  assert.equal(pending.length, 1);
  const explicit = a.context.load();
  assert.equal(pending.length, 2);
  pending[1](snapshot('完了'));
  await explicit;
  pending[0](snapshot('未着手'));
  await automatic;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].state', a.context), '完了');
});

test('会話の sessions だけ変わっても composer と stream を作り直さない', async () => {
  const a = app();
  let renders = 0;
  a.context.api = async () => snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  a.context.render = () => { renders++; };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  await a.context.pollState();
  assert.equal(renders, 0);
});

test('端末 pane の起動と選択中作業の外部変更は描画する', async () => {
  const a = app();
  let next = snapshot();
  let renders = 0;
  a.context.api = async () => next;
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.context.localStorage.getItem = key => key === 'hub-mode' ? 'term' : null;
  vm.runInContext('renderedMainKey = mainKey()', a.context);
  next = snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  await a.context.pollState();
  assert.equal(renders, 1);
  next = snapshot('完了', next.sessions);
  await a.context.pollState();
  assert.equal(renders, 2);
});

test('部分応答を連続受信しても作業中タイマーは1本、本文は最新になる', () => {
  const a = app();
  const box = a.element('#msgs');
  const partial = {
    mb: { hidden: true, textContent: '' }, time: { textContent: '' }, last: { textContent: '' },
    querySelector(s) { return s === '.mb' ? this.mb : s === '.wk-time' ? this.time : this.last; },
    remove() { a.elements.delete('#msg-partial'); },
  };
  box.insertAdjacentHTML = () => a.elements.set('#msg-partial', partial);
  const stateEl = a.element('#chat-state');
  Object.defineProperty(stateEl, 'innerHTML', {
    get() { return this.html || ''; },
    set(v) { this.html = v; this.writes = (this.writes || 0) + 1; if (v.includes('chat-elapsed')) a.element('#chat-elapsed'); },
  });
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }', a.context);
  a.context.openChat(project(), project().tasks[0]);
  for (let i = 0; i < 12; i++) a.stream().onmessage({ data: JSON.stringify({ type: 'partial', ai: 'codex', text: `answer ${i}` }) });
  assert.equal(partial.mb.innerHTML, 'answer 11');
  a.stream().onmessage({ data: JSON.stringify({ type:'partial', ai:'codex', text:'<script>bad</script>' }) });
  assert.equal(partial.mb.innerHTML, '&lt;script&gt;bad&lt;/script&gt;');
  a.stream().onmessage({ data: JSON.stringify({ type:'partial', ai:'codex', text:'> 送信用の途中\n> 続き' }) });
  assert.match(partial.mb.innerHTML,/書きかけ/); assert.doesNotMatch(partial.mb.innerHTML,/quote-copy/);
  assert.match(a.context.msgHtml({role:'assistant',ai:'codex',text:'> 完了した本文'}),/quote-copy/);
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 1);
  assert.equal(stateEl.writes, 1);
  a.context.closePanes();
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 0);
});

test('AI更新はログイン済みの一覧と一括ボタンにまとめる', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = { codex: {eligible:true,installed:true,version:"0.159.0",method:"standalone",modelsStatus:"changed",models:[{id:"gpt-6.1-sol",label:"GPT-6.1-Sol"}]}, claude: {eligible:false,installed:true,status:"logged-out",version:"2.1.284",models:[]} }; renderSettings()', a.context);
  assert.match(a.element('#main').innerHTML, /AI の更新/);
  const html = a.element('#ai-tools').innerHTML;
  assert.match(html, /Codex/);
  assert.match(html, /0\.159\.0/);
  assert.match(html, /単独インストール/);
  assert.doesNotMatch(html, /2\.1\.284/);
  assert.match(html, /未ログイン/);
  assert.match(html, /data-ai-update-all/);
  assert.match(html, /data-ai-check=/); assert.match(html,/data-ai-update=/); assert.doesNotMatch(html,/data-ai-model-refresh=/);
  assert.match(html, /確認日/);
  assert.match(html, /変更あり/);
  assert.match(html, /GPT-6\.1-Sol/);
});

test('稼働中は一括更新を理由付きで止め、更新候補は残す', () => {
  const a = app(), s = snapshot(); s.chatting = [{project:'p',task:'t',ai:'codex'}];
  vm.runInContext('state = '+JSON.stringify(s)+'; aiTools = {codex:{eligible:true,installed:true,version:"0.159.0",busyCount:1,updateCheck:{ok:true,available:true,applicable:true,latestVersion:"0.160.0",checkedAt:"2026-10-05T00:00:00Z"}}}; drawAiTools()',a.context);
  const html = a.element('#ai-tools').innerHTML;
  assert.doesNotMatch(html,/data-ai-update-all disabled/); assert.match(html,/data-ai-update="codex" disabled/);
  assert.match(html,/稼働中のCLIは飛ばし/);
  assert.match(html,/→ 0\.160\.0/);
  assert.match(html,/data-ai-check="codex" >/);
});

test('CLI 更新だけ成功した時はモデル一覧の失敗理由を残す', () => {
  const a = app();
  const message = a.context.aiToolResultText('update', { beforeVersion: '2.1.283', afterVersion: '2.1.284', changed: true, models: { ok: false, error: '一覧の取得方法がありません' } });
  assert.match(message, /2\.1\.283 → 2\.1\.284/);
  assert.match(message, /一覧の取得方法がありません/);
  assert.doesNotMatch(a.context.aiToolResultText('update', { changed: false, beforeVersion: '', afterVersion: '', verified: false, verifyError: '版コマンドが失敗' }), /最新/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 0, source: 'claude-cache', unchanged: true, warning: '前回と同じ内容です' }), /前回の内容/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 1, source: 'claude-cache', unchanged: false }), /再取得しました（追加 1 件）/);
});

test('別画面の更新終了でモデルを読み直し、日次結果の保持状態は60秒ごとに読む', async () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  let checks = 0, stateReads = 0;
  a.context.api = async route => {
    if (route === '/api/ai-tools') return { tools: { codex: { installed: true }, claude: { installed: true } }, operation: ++checks === 1 ? { ai: 'codex', kind: 'update' } : null };
    if (route === '/api/state') { stateReads++; return fresh; }
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}', a.context);
  await a.context.loadAiTools();
  const [watchId, watch] = [...a.timeouts.entries()].find(([, t]) => t.ms === 3000) || [];
  assert.ok(watch);
  a.timeouts.delete(watchId);
  watch.cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(stateReads, 1);
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.equal([...a.timeouts.values()].filter(t => t.ms === 3000).length, 0);
  const [idleId, idle] = [...a.timeouts.entries()].find(([, t]) => t.ms === 60000) || [];
  assert.ok(idle); a.timeouts.delete(idleId); idle.cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 3); assert.equal(stateReads, 1);
});

test('AI更新後は新しいモデルを取り込み、保存前の役割編集を維持する', async () => {
  const a = app();
  const calls = [];
  const fresh = snapshot();
  fresh.roles.models.codex = ['6sol', 'GPT-6.1-Sol'];
  a.context.api = async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/ai-tools/update') return { ok: true, ai: 'codex', beforeVersion: '0.157.1', afterVersion: '0.159.0', changed: true, models: { ok: true, added: ['GPT-6.1-Sol'] } };
    if (route === '/api/state') return fresh;
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: { version: '0.159.0', method: 'standalone', models: [{ id: 'gpt-6.1-sol' }] }, claude: {} } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; rolesDraft = [{name:"Coding",main:{ai:"codex",model:"6sol",effort:"高"},backup:{ai:"人",model:"",effort:""}}]; aiTools = {codex:{version:"0.157.1"},claude:{}}', a.context);
  vm.runInContext('aiTools.codex.updateCheck = {available:true,ok:true}', a.context);
  await a.context.runAiTool('codex', 'update');
  assert.equal(calls[0][0], '/api/ai-tools/update');
  assert.equal(calls[0][1].ai, 'codex');
  assert.equal(vm.runInContext('rolesDraft[0].main.model', a.context), '6sol');
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.match(a.element('#model-catalog').textContent, /GPT-6\.1-Sol/);
  assert.match(a.element('#ai-tools').innerHTML, /0\.157\.1 → 0\.159\.0/);
});

test('設定にAIアカウントとCodex加速の操作・注意を同時に表示する', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p"}', a.context);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /<h2 class="pref-caption">AIの利用設定<\/h2><div class="pref-list">\s*<div class="pref-row pref-stack"><div id="ai-accounts"/);
  assert.match(html, /<h2 class="pref-caption">Codex の加速（Fast）<\/h2>/);
  assert.match(html, /class="danger"><strong>速度約1\.5倍・利用枠の消耗2\.5倍/);
  assert.match(a.element('#ai-accounts').innerHTML, /data-account-action="add"/);
});

test('加速の初期OFFと保存済ONを表示し、保存中は無効・二重送信しない', async () => {
  const a = app(), input = a.element('#codex-fast');
  vm.runInContext('state = ' + JSON.stringify(snapshot()), a.context);
  a.context.renderAcceleration({ codexAllowed: false });
  assert.match(a.element('#acceleration').innerHTML, />OFF</);
  a.context.renderAcceleration({ codexAllowed: true });
  assert.match(a.element('#acceleration').innerHTML, /checked/);
  assert.match(a.element('#acceleration').innerHTML, />ON</);
  input.dataset.saved = 'false'; input.checked = true;
  let resolve, count = 0;
  a.context.api = async (route, body) => {
    assert.equal(route, '/api/acceleration'); assert.equal(body.codexAllowed, true); count++;
    return new Promise(r => { resolve = r; });
  };
  const saving = a.context.saveCodexFast(input);
  assert.equal(input.disabled, true);
  await a.context.saveCodexFast(input);
  assert.equal(count, 1);
  resolve({ codexAllowed: true }); await saving;
  assert.equal(input.disabled, false); assert.equal(input.dataset.saved, 'true');
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
});

test('加速OFFへの保存失敗はONへ戻し、古い読込応答で切替を上書きしない', async () => {
  const a = app(), input = a.element('#codex-fast');
  vm.runInContext('state = ' + JSON.stringify(snapshot()), a.context);
  input.dataset.saved = 'true'; input.checked = false;
  a.context.api = async () => { throw Error('fixture failure'); };
  await a.context.saveCodexFast(input);
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
  assert.match(a.element('#toast').textContent, /保存できませんでした/);
  let resolveLoad;
  a.context.api = route => route === '/api/cli-models' ? new Promise(r => { resolveLoad = r; }) : Promise.resolve({ codexAllowed: true });
  const loading = a.context.loadCliModels();
  input.checked = true; await a.context.saveCodexFast(input);
  const before = a.element('#acceleration').innerHTML;
  resolveLoad({ claude: [], codex: [], hints: { claude: [], codex: [] }, acceleration: { codexAllowed: false } });
  await loading;
  assert.equal(a.element('#acceleration').innerHTML, before);
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
});

test('加速設定の読込失敗ではOFFに見せず、読み込めない理由を表示する', async () => {
  const a = app();
  a.context.api = async () => { throw Error('fixture failure'); };
  await a.context.loadCliModels();
  assert.match(a.element('#acceleration').textContent, /読み込めませんでした/);
});

for (const mode of ['chat', 'term']) for (const wanted of [true, false]) {
  for (const failure of [false, true]) for (const taskOn of [true, false]) {
    test(`permission save after navigating to ${mode} synchronizes Fast (${wanted}, failure=${failure}, task=${taskOn}) without losing drafts or ETags`, async () => {
      const a = app(), data = snapshot('未着手'), input = a.element('#codex-fast');
      data.acceleration = { codexAllowed: !wanted };
      data.projects[0].tasks[0].codexFast = taskOn;
      vm.runInContext('state=' + JSON.stringify(data) + ';view={kind:"settings",project:"p"};stateTag="initial";chatDraft.keep="入力中"', a.context);
      input.dataset.saved = String(!wanted); input.checked = wanted;
      const box = a.element(mode === 'chat' ? '#chat-fast-box' : '#term-fast-box');
      box.dataset = { p: 'p', t: 't' };
      let picker = null;
      Object.defineProperty(box, 'innerHTML', {
        get() { return this.html || ''; },
        set(html) {
          this.html = html; picker = null;
          if (!html) return;
          const classes = new Set(html.match(/class="([^"]+)"/)[1].split(' '));
          const span = { textContent: taskOn ? '加速ON（Fast）' : '加速（Fast）' };
          const label = { hidden: false, classList: {
            toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
            contains(name) { return classes.has(name); },
          }, querySelector: () => span };
          picker = { dataset: { p: 'p', t: 't' }, checked: /\bchecked\b/.test(html),
            disabled: /\bdisabled\b/.test(html), closest: () => label };
        },
      });
      box.querySelector = () => picker;
      const query = a.document.querySelector;
      let navigated = false;
      a.document.querySelector = sel => sel === '#codex-fast' && navigated ? null
        : sel === '#chat-fast-box' ? (mode === 'chat' && navigated ? box : null) : query(sel);
      a.document.querySelectorAll = sel => sel === '[data-task-fast]' ? (picker ? [picker] : [])
        : sel === '[data-term-fast-box]' && mode === 'term' && navigated ? [box] : [];
      a.element('#chat-ai').value = 'codex|GPT-6.1-Sol';
      let finishSave;
      const held = [], tags = [];
      const response = (body, tag = 'discarded', ok = true) => ({ status: ok ? 200 : 500, ok,
        json: async () => JSON.parse(JSON.stringify(body)), headers: { get: () => tag } });
      a.context.fetch = (route, opt = {}) => {
        if (route === '/api/acceleration') {
          assert.equal(JSON.parse(opt.body).codexAllowed, wanted);
          return new Promise(resolve => { finishSave = () => resolve(response(
            failure ? { error: 'fixture failure' } : { codexAllowed: wanted }, '', !failure)); });
        }
        assert.equal(route, '/api/state'); tags.push(opt.headers?.['If-None-Match']);
        return new Promise(resolve => held.push(() => resolve(response(data))));
      };
      a.context.render = () => { throw Error('must not redraw the work screen'); };
      const saving = a.context.saveCodexFast(input);
      navigated = true;
      vm.runInContext('view={kind:"work",project:"p",task:"t"}', a.context);
      box.innerHTML = a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex');
      const main = a.element('#main'), draft = a.element('#chat-in');
      main.innerHTML = 'work DOM'; draft.value = 'まだ送っていない文章';
      const during = a.context.refreshTree(); held.shift()(); await during;
      const after = a.context.refreshTree();
      await a.context.startAI('p', 't', 'codex'); // 保存中は起動要求を出さない
      assert.equal(vm.runInContext('accelerationSaving', a.context), true);
      finishSave(); await saving;
      held.shift()(); await after;
      const confirmed = failure ? !wanted : wanted;
      assert.equal(vm.runInContext('state.acceleration.codexAllowed', a.context), confirmed);
      assert.equal(!!picker && !picker.closest().hidden, confirmed);
      if (picker) {
        assert.equal(picker.checked, taskOn); assert.equal(picker.disabled, false);
        assert.equal(picker.closest().classList.contains('danger'), taskOn);
        assert.equal(picker.closest().querySelector().textContent, taskOn ? '加速ON（Fast）' : '加速（Fast）');
      }
      assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), taskOn);
      assert.equal(vm.runInContext('accelerationSaving', a.context), false);
      assert.equal(input.disabled, false); assert.equal(input.checked, confirmed);
      assert.equal(vm.runInContext('stateTag', a.context), 'initial');
      assert.deepEqual(tags, ['initial', 'initial']);
      assert.equal(a.element('#main'), main); assert.equal(main.innerHTML, 'work DOM');
      assert.equal(a.element('#chat-in'), draft); assert.equal(draft.value, 'まだ送っていない文章');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
      if (failure) assert.match(a.element('#toast').textContent, /fixture failure/);
    });
  }
}

test('設定タブは表示だけ切り替え、役割とCLI下書きを保持して選択を保存する', () => {
  const a = app(), data = snapshot(), storage = new Map();
  data.roles.roles = [{ name: 'test', main: { ai: 'codex', model: 'draft', effort: '高' }, backup: { ai: '人' } }];
  vm.runInContext('state = ' + JSON.stringify(data) + '; rolesDraft = JSON.parse(JSON.stringify(state.roles.roles)); rolesDraft[0].main.model = "changed"', a.context);
  a.context.localStorage.setItem = (k, v) => storage.set(k, v);
  const tabs = ['basic', 'ai', 'connect', 'manage'].map(key => ({ ...a.element('#tab-' + key), dataset: { settingsTab: key } }));
  const cards = ['basic', 'ai', 'connect', 'manage'].map(key => ({ dataset: { tab: key }, hidden: false }));
  a.document.querySelectorAll = selector => selector === '[data-settings-tab]' ? tabs : selector === '.settings > [data-tab]' ? cards : [];
  a.element('#main').innerHTML = 'same DOM'; a.element('#cli-draft').value = 'unfinished';
  a.context.selectSettingsTab('ai');
  assert.deepEqual(cards.map(c => c.hidden), [true, false, true, true]);
  assert.equal(tabs[1].attributes['aria-label'], 'AI 未保存あり');
  assert.equal(tabs[1].attributes['aria-selected'], 'true');
  assert.equal(storage.get('hub.settingsTab'), 'ai');
  a.context.selectSettingsTab('connect'); a.context.selectSettingsTab('ai');
  assert.equal(a.element('#main').innerHTML, 'same DOM'); assert.equal(a.element('#cli-draft').value, 'unfinished');
  assert.equal(vm.runInContext('rolesDraft[0].main.model', a.context), 'changed');
  a.context.selectSettingsTab('invalid'); assert.equal(storage.get('hub.settingsTab'), 'basic');
});
test('作業別Fastは許可とCodex選択で表示し、保存の連打・古い一覧を防ぐ', async () => {
  const a = app(), data = snapshot(); data.acceleration = { codexAllowed: true };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  assert.match(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), /data-task-fast/);
  assert.equal(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'claude'), '');
  vm.runInContext('state.acceleration.codexAllowed = false', a.context);
  assert.equal(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), '');
  vm.runInContext('state.acceleration.codexAllowed = true', a.context);
  const input = a.element('#task-fast'); input.dataset = { p: 'p', t: 't' }; input.checked = true;
  let resolve, count = 0; a.context.api = (url, body) => {
    assert.equal(url, '/api/acceleration/task'); assert.equal(body.on, true); count++;
    return new Promise(r => { resolve = r; });
  };
  const saving = a.context.saveTaskFast(input);
  assert.equal(input.disabled, true); await a.context.saveTaskFast(input); assert.equal(count, 1);
  await a.context.startAI('p', 't', 'codex');
  await a.context.act({ dataset: { act: 'handoff', p: 'p', t: 't', from: 'claude', to: 'codex' } });
  assert.equal(count, 1, 'launches wait for the saved Fast choice');
  let slowState; a.context.fetchState = () => new Promise(r => { slowState = r; });
  const refreshing = a.context.refreshTree();
  resolve({ codexFast: true }); await saving;
  slowState(data); await refreshing;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), true);
  assert.equal(input.disabled, false);
  input.checked = false; a.context.api = async () => { throw Error('fixture save failure'); };
  await a.context.saveTaskFast(input);
  assert.equal(input.checked, true); assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), true);
});

test('CLI名の再読込中に書き足した下書きを保持する', async () => {
  const a = app();
  const box = a.element('#climodels');
  let current = [{ dataset: { ai: 'codex', name: '6sol' }, value: '元の値' }];
  a.document.querySelectorAll = selector => selector === 'input.cm' ? current : [];
  Object.defineProperty(box, 'innerHTML', {
    get() { return this.html || ''; },
    set(value) { this.html = value; current = [{ dataset: { ai: 'codex', name: '6sol' }, value: 'サーバーの値' }]; },
  });
  let resolveFetch;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  const loading = a.context.loadCliModels(true);
  current[0].value = '取得中に入力した値';
  resolveFetch({ claude: [], codex: [{ name: '6sol', flag: 'サーバーの値' }], hints: { claude: [], codex: [] } });
  await loading;
  assert.equal(current[0].value, '取得中に入力した値');
});

test('利用できなくなった既存モデルを明示し、新しい候補へ選び直せる', () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  fresh.projects[0].tasks[0].model = '旧モデル';
  a.context.localStorage.getItem = key => key.startsWith('hub-chat-') ? JSON.stringify({ ai: 'codex', model: '旧モデル', effort: '高' }) : null;
  vm.runInContext('state = ' + JSON.stringify(fresh), a.context);
  const p = fresh.projects[0], t = p.tasks[0];
  const work = a.context.specSelect(p, t, 'codex', false);
  const chat = a.context.chatHtml(p, t);
  assert.match(work, /旧モデル（現在の指定・利用不可）/);
  assert.match(work, /GPT-6\.1-Sol/);
  assert.match(chat, /旧モデル（利用不可。選び直してください）/);
  assert.match(chat, /GPT-6\.1-Sol/);
});

test('モデルだけの再取得と、段階・理由を含む失敗を表示する', async () => {
  const a = app();
  const calls = [];
  a.context.api = async route => {
    calls.push(route);
    if (route === '/api/ai-tools/models/refresh') return { ok: true, ai: 'codex', added: 1 };
    if (route === '/api/state') return snapshot();
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: {}, claude: {} } };
    const error = new Error('更新できません'); error.stage = 'install'; error.reason = 'CLI が実行中'; throw error;
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = {codex:{},claude:{}}', a.context);
  await a.context.runAiTool('codex', 'models');
  assert.equal(calls[0], '/api/ai-tools/models/refresh');
  assert.match(a.element('#ai-tools').innerHTML, /追加 1 件/);
  vm.runInContext('aiTools.claude.updateCheck = {available:true,ok:true}', a.context);
  await a.context.runAiTool('claude', 'update');
  assert.match(a.element('#ai-tools').innerHTML, /CLI が実行中/);
  assert.match(a.element('#ai-tools').innerHTML, /段階：install/);
});


test('除外中は取り込みと予告を隠し、戻す操作と保管中表示を出す', () => {
  const a = app();
  let previews = 0;
  a.context.loadPreview = () => { previews++; };
  const render = excluded => {
    const data = snapshot('完了');
    Object.assign(data.projects[0].tasks[0], { copy: true, mergeExcluded: excluded });
    vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    return a.element('#main').innerHTML;
  };
  const included = render(false);
  assert.match(included, /data-act="merge"/);
  assert.match(included, /取り込み対象から外す/);
  assert.match(included, /data-act="merge"[^>]*hidden disabled/);
  assert.match(included, /data-act="mergeexclude"[^>]*hidden/);
  assert.equal(previews, 0); // 会話の初回rowsを表示するまでは補助取得を待つ
  a.stream().onmessage({data:JSON.stringify({type:'rows',rows:[],queue:[],busy:null})});
  assert.equal(previews, 1);
  const excluded = render(true);
  assert.doesNotMatch(excluded, /data-act="merge"|data-act="mergeexclude"/);
  assert.match(excluded, /取り込み対象外（コピー保管中）/);
  assert.match(excluded, /data-act="mergeinclude"/);
  assert.equal(previews, 1);
  render(false);
  assert.equal(previews, 1);
  a.stream().onmessage({data:JSON.stringify({type:'rows',rows:[],queue:[],busy:null})});
  assert.equal(previews, 2);
});

test('差分取得は正式な取り込み案内を消さず、ボタンと案内の所有者へ一度渡す', async () => {
  const a=app();vm.runInContext('view={kind:"work",project:"p",task:"t"}',a.context);
  const merge=a.element('[data-act="merge"]'),exclude=a.element('[data-act="mergeexclude"]');
  a.element('[data-main-preview]').remove=()=>assert.fail('must not remove formal scope');
  merge.insertAdjacentHTML=()=>assert.fail('must not insert compact badge');
  let count=0; a.context.prepareOneclickMain=async(p,t,b)=>{assert.equal(p,'p');assert.equal(t,'t');assert.equal(b,merge);count++;};
  for(const files of [0,3,0]){a.context.api=async()=>({files});await a.context.loadPreview('p','t');assert.equal(exclude.hidden,files===0);}
  assert.equal(count,3);assert.equal(merge.hidden,false);assert.equal(merge.disabled,false);
});

test('別の作業へ移動した後の差分結果と取得失敗は取り込み・除外の表示を変えない', async () => {
  const a = app();
  vm.runInContext('view = {kind:"work",project:"p",task:"t"}', a.context);
  const merge = a.element('[data-act="merge"]'), exclude = a.element('[data-act="mergeexclude"]');
  let resolve;
  a.context.api = () => new Promise(done => { resolve = done; });
  const pending = a.context.loadPreview('p', 't');
  vm.runInContext('view.task = "other"', a.context);
  resolve({ noChanges: true, files: 0 }); await pending;
  assert.equal(merge.hidden, false); assert.equal(exclude.hidden, false);
  vm.runInContext('view.task = "t"', a.context);
  a.context.api = async () => { throw new Error('取得失敗'); };
  await a.context.loadPreview('p', 't');
  assert.equal(merge.hidden, false); assert.equal(exclude.hidden, false);
});

test('同じ作業の古い差分応答は、新しい変更なし判定を上書きしない', async () => {
  const a = app();
  vm.runInContext('view = {kind:"work",project:"p",task:"t"}', a.context);
  const merge = a.element('[data-act="merge"]'), exclude = a.element('[data-act="mergeexclude"]');
  a.element('[data-main-preview]').remove = () => {};
  let resolve;
  a.context.api = () => new Promise(done => { resolve = done; });
  const pending = a.context.loadPreview('p', 't');
  a.context.api = async () => ({ files: 0, noChanges: false, mainDirty: true });
  await a.context.loadPreview('p', 't');
  resolve({ files: 3, added: 4, removed: 0 }); await pending;
  assert.equal(merge.hidden, false); assert.equal(exclude.hidden, true);
});

test('同じ作業を再描画した後には、古いDOMへの応答を適用しない', async () => {
  const a = app();
  vm.runInContext('view = {kind:"work",project:"p",task:"t"}', a.context);
  const old = a.element('[data-act="merge"]');
  let resolve;
  a.context.api = () => new Promise(done => { resolve = done; });
  const pending = a.context.loadPreview('p', 't');
  a.elements.delete('[data-act="merge"]');
  const current = a.element('[data-act="merge"]'); current.hidden = true;
  resolve({ files: 3, added: 4, removed: 0 }); await pending;
  assert.equal(current.hidden, true); assert.equal(old.disabled, false);
});

test('画面を作り直さない定期取得でも取り込み表示の変更量を更新する', async () => {
  const a = app(), s = snapshot(); s.projects[0].tasks[0].copy = true;
  vm.runInContext('state = '+JSON.stringify(s)+'; view = {kind:"work",project:"p",task:"t"}', a.context);
  a.context.render();
  a.stream().onmessage({data:JSON.stringify({type:'rows',rows:[],queue:[],busy:null})});
  let previews = 0, renders = 0;
  a.context.loadPreview = (p,t) => { assert.equal(p,'p'); assert.equal(t,'t'); previews++; };
  a.context.render = () => { renders++; };
  vm.runInContext('fetchState = async () => null', a.context);
  await a.context.pollState();
  assert.equal(renders, 0); assert.equal(previews, 1);
});

// 手作りのnoChanges応答だけでは安全判定と表示仕様の取り違えを見逃す。
// 実Gitのpreviewをそのまま実装UIへ渡し、HTMLのhidden属性・予告の有無を観測する。
function gitPreviewApp(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-preview-ui-'));
  t.after(() => git.toTrash(root, path.join(fs.realpathSync(os.tmpdir()), 'hub-preview-ui-trash')));
  const main = path.join(root, 'main'), workRoot = path.join(root, 'Work');
  fs.mkdirSync(main);
  const sh = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Preview UI test', GIT_AUTHOR_EMAIL: 'preview@localhost', GIT_COMMITTER_NAME: 'Preview UI test', GIT_COMMITTER_EMAIL: 'preview@localhost' },
  }).trim();
  sh(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  sh(main, 'add', '-A'); sh(main, 'commit', '-qm', 'base');
  const copy = git.prepare({ base: main, workRoot, taskId: 'copy' }).dir;
  const preview = () => git.preview({ dir: copy, workRoot });
  const a = app(), data = snapshot('完了'); data.projects[0].tasks[0].copy = true;
  a.context.fixture = data;
  vm.runInContext('state=fixture; view={kind:"work",project:"p",task:"t"}', a.context);

  // 既存VMのDOMに、renderWorkが出した実際のbutton属性と予告の挿入/削除を接続する。
  // hiddenの期待値はpreviewのnoChangesから算出しない。
  let html = '';
  const query = a.document.querySelector;
  a.document.querySelector = selector => /^\[data-(?:act="merge(?:exclude)?"|main-preview)\]$/.test(selector)
    ? a.elements.get(selector) || null : query(selector);
  Object.defineProperty(a.element('#main'), 'innerHTML', {
    get: () => html,
    set(value) {
      html = value; a.elements.delete('[data-main-preview]');
      for (const action of ['merge', 'mergeexclude']) {
        const selector = `[data-act="${action}"]`;
        a.elements.delete(selector);
        const tag = html.match(new RegExp(`<button\\b[^>]*data-act="${action}"[^>]*>`))?.[0];
        if (!tag) continue;
        const button = a.element(selector);
        button.hidden = /\shidden(?=\s|>)/.test(tag);
        button.disabled = /\sdisabled(?=\s|>)/.test(tag);
        button.insertAdjacentHTML = (position, notice) => {
          assert.fail('lightweight preview must not insert a badge');
          a.elements.set('[data-main-preview]', { innerHTML: notice, remove() { a.elements.delete('[data-main-preview]'); } });
        };
      }
    },
  });
  const requests = [];
  a.context.api = route => {
    assert.equal(route, '/api/task/preview?project=p&task=t');
    const result = preview(); // API相当の結果は要求時の実Gitから取得し、値を書き換えない。
    return new Promise(resolve => requests.push({ result, resolve }));
  };
  const loadPreview = a.context.loadPreview;
  a.context.loadPreview = (pid, tid) => {
    const pending = loadPreview(pid, tid);
    requests.at(-1).pending = pending;
    return pending;
  };
  const reply = async (request = requests.at(-1)) => { request.resolve(request.result); await request.pending; };
  const controls = hidden => {
    // This fixture loads app.js only. Formal controls belong to task-history.js.
    assert.equal(a.element('[data-act="merge"]').hidden, true);
    assert.equal(a.element('[data-act="merge"]').disabled, true);
    assert.equal(a.element('[data-act="mergeexclude"]').hidden, hidden);
    assert.equal(a.elements.has('[data-main-preview]'), false);
  };
  const render = () => {
    a.context.renderWork();
    a.stream().onmessage({data:JSON.stringify({type:'rows',rows:[],queue:[],busy:null})});
  };
  const refresh = () => a.context.loadPreview('p', 't');
  return { ...a, root, main, copy, workRoot, sh, preview, requests, reply, controls, render, refresh };
}

test('実Git preview→除外操作: 本体dirtyでも0件は初期・取得後とも非表示、差分復帰と再消去を追従する', async t => {
  const a = gitPreviewApp(t);
  fs.writeFileSync(path.join(a.main, 'a.txt'), 'main unsaved\n');
  a.render(); a.controls(true);
  assert.equal(a.requests[0].result.files, 0);
  assert.equal(a.requests[0].result.mainDirty, true);
  assert.equal(a.requests[0].result.noChanges, false);
  await a.reply(); a.controls(true);
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'copy changed\n');
  let pending = a.refresh();
  assert.equal(a.requests.at(-1).result.files, 1);
  await a.reply(); await pending; a.controls(false);
  assert.equal(a.requests.at(-1).result.files,1);
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'one\n');
  pending = a.refresh(); await a.reply(); await pending; a.controls(true);
  const head = a.sh(a.main, 'rev-parse', 'HEAD');
  const merge = git.merge({ dir: a.copy, workRoot: a.workRoot, sourceHead: a.preview().sourceHead, cleanup: false });
  assert.equal(merge.ok, false); assert.match(merge.error, /成果を渡す前/);
  assert.equal(a.sh(a.main, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(a.main, 'a.txt'), 'utf8'), 'main unsaved\n');
});

test('実Git preview→除外操作: 同じtreeの未受領・分岐履歴で安全noChanges=falseでも除外操作を隠す', async t => {
  const a = gitPreviewApp(t);
  a.sh(a.main, 'commit', '--allow-empty', '-qm', 'main history');
  a.sh(a.copy, 'commit', '--allow-empty', '-qm', 'unreceived copy history');
  const mainHead = a.sh(a.main, 'rev-parse', 'HEAD'), copyHead = a.sh(a.copy, 'rev-parse', 'HEAD');
  assert.equal(a.sh(a.main, 'rev-parse', 'HEAD^{tree}'), a.sh(a.copy, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(git.isAncestor(a.copy, mainHead), false); assert.equal(git.isAncestor(a.main, copyHead), false);
  a.render();
  const result = a.requests[0].result;
  assert.equal(result.files, 0); assert.equal(result.conflict, false); assert.equal(result.noChanges, false);
  assert.equal(result.mainDirty, false); assert.equal(result.sourceDirty, false);
  await a.reply(); a.controls(true);
  assert.equal(a.sh(a.main, 'rev-parse', 'HEAD'), mainHead); assert.equal(a.sh(a.copy, 'rev-parse', 'HEAD'), copyHead);
});

test('実Git preview→除外操作: 保存済み競合は除外操作を表示し、取り込みは拒否する', async t => {
  const a = gitPreviewApp(t);
  for (const [dir, text] of [[a.main, 'main'], [a.copy, 'copy']]) {
    fs.writeFileSync(path.join(dir, 'a.txt'), text + '\n');
    a.sh(dir, 'add', '-A'); a.sh(dir, 'commit', '-qm', text);
  }
  a.render(); a.controls(true);
  assert.equal(a.requests[0].result.files, 1); assert.equal(a.requests[0].result.conflict, true);
  await a.reply(); a.controls(false);
  assert.equal(a.elements.has('[data-main-preview]'),false); // no second renderer
  const head = a.sh(a.main, 'rev-parse', 'HEAD');
  const merge = git.merge({ dir: a.copy, workRoot: a.workRoot, cleanup: false });
  assert.equal(merge.ok, false); assert.equal(merge.conflict, true);
  assert.equal(a.sh(a.main, 'rev-parse', 'HEAD'), head); assert.equal(a.sh(a.main, 'status', '--porcelain'), '');
});

test('実Git preview→除外操作: 応答逆転は新しい0件・差分復帰の両方向を上書きしない', async t => {
  const a = gitPreviewApp(t);
  fs.writeFileSync(path.join(a.main, 'a.txt'), 'main unsaved\n');
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'copy changed\n');
  a.render(); const oldChanges = a.requests.at(-1);
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'one\n');
  let pending = a.refresh(); const newEmpty = a.requests.at(-1);
  assert.equal(oldChanges.result.files, 1); assert.equal(newEmpty.result.files, 0); assert.equal(newEmpty.result.noChanges, false);
  await a.reply(newEmpty); await pending; a.controls(true);
  await a.reply(oldChanges); a.controls(true);
  const oldPending = a.refresh(), oldEmpty = a.requests.at(-1);
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'copy changed again\n');
  pending = a.refresh(); await a.reply(); await pending; a.controls(false);
  const notice = a.elements.get('[data-main-preview]');
  await a.reply(oldEmpty); await oldPending; a.controls(false);
  assert.equal(a.elements.get('[data-main-preview]'), notice);
});

test('実Git preview→除外操作: 同じ作業の再描画で古いDOMの差分応答を無視する', async t => {
  const a = gitPreviewApp(t);
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'copy changed\n');
  a.render(); const old = a.requests.at(-1), oldButton = a.element('[data-act="merge"]');
  fs.writeFileSync(path.join(a.main, 'a.txt'), 'main unsaved\n');
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'one\n');
  a.render(); const current = a.element('[data-act="merge"]');
  assert.notEqual(current, oldButton); assert.equal(old.result.files, 1); assert.equal(a.requests.at(-1).result.files, 0);
  await a.reply(old); a.controls(true); assert.equal(oldButton.hidden, true);
  await a.reply(); a.controls(true);
});

test('実Git preview→除外操作: 定期取得は再描画せず実Gitの差分復帰を表示する', async t => {
  const a = gitPreviewApp(t);
  a.context.render();
  a.stream().onmessage({data:JSON.stringify({type:'rows',rows:[],queue:[],busy:null})});
  await a.reply(); a.controls(true);
  const button = a.element('[data-act="merge"]');
  fs.writeFileSync(path.join(a.copy, 'a.txt'), 'copy changed\n');
  let renders = 0; a.context.render = () => { renders++; };
  vm.runInContext('fetchState = async () => null', a.context);
  await a.context.pollState();
  assert.equal(renders, 0); assert.equal(a.requests.length, 2); assert.equal(a.requests.at(-1).result.files, 1);
  await a.reply(); a.controls(false); assert.equal(a.element('[data-act="merge"]'), button);
});

test('除外確認のキャンセルは変更せず、確定と再登録は明示booleanを送る', async () => {
  const a = app();
  const calls = [], messages = [];
  a.context.api = async (route, body) => { calls.push([route, body]); return { ok: true }; };
  a.context.load = async () => {};
  a.context.toast = message => messages.push(message);
  let confirmText = '';
  a.context.confirm = text => { confirmText = text; return false; };
  const el = { dataset: { act: 'mergeexclude', p: 'p', t: 't' }, disabled: false };
  await a.context.act(el);
  assert.equal(calls.length, 0);
  assert.match(confirmText, /本体に取り込まず/);
  assert.match(confirmText, /作業用コピーとファイルは残り/);
  assert.match(confirmText, /取り込み対象に戻す/);
  assert.equal(el.disabled, false);
  a.context.confirm = () => true;
  await a.context.act(el);
  assert.equal(calls[0][0], '/api/task/merge-exclusion');
  assert.equal(calls[0][1].excluded, true);
  assert.match(messages[0], /作業用コピーは残して/);
  a.context.confirm = () => { throw Error('再登録では確認不要'); };
  await a.context.act({ dataset: { act: 'mergeinclude', p: 'p', t: 't' } });
  assert.equal(calls[1][1].excluded, false);
  assert.match(messages[1], /取り込み対象に戻しました/);
});

test('保存のない始める欄はSol・高、前回選択とローカル下書きは初期値より優先する', () => {
  const a = app(), data = snapshot(), saved = { ai: 'claude', model: 'Fable 5.1', effort: '極高' };
  data.roles.models = { codex: ['Astra', 'GPT-6.1-Sol'], 'claude-code': ['Fable 5.1'] };
  data.efforts = ['中', '高', '極高'];
  data.hiddenModels = { codex: ['GPT-6.1-Sol'] };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  const fresh = a.context.quickDraft({ id: 'fresh' });
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), { text: '', images: [], ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  const html = a.context.quickControls({ id: 'fresh' });
  assert.match(html, /value="codex" selected/);
  assert.match(html, /<option[^>]*selected>GPT-6.1-Sol<\/option>/);
  assert.match(html, /<option selected>高<\/option>/);
  const prior = a.context.quickDraft({ id: 'prior', startSpec: saved });
  assert.equal(prior.ai, 'claude'); assert.equal(prior.model, 'Fable 5.1'); assert.equal(prior.effort, '極高');
  a.context.localStorage.getItem = key => key === 'hub-start-local' ? JSON.stringify({ text: '保存した依頼', ai: 'agy', model: 'Gemini 3.1 Pro (High)', effort: '高', images: [] }) : null;
  const local = a.context.quickDraft({ id: 'local', startSpec: saved });
  assert.equal(local.ai, 'agy'); assert.equal(local.text, '保存した依頼');
  const roleTask = { ...data.projects[0].tasks[0], owner: 'claude-code', role: '司令塔' };
  vm.runInContext('state.roles.roles = [{name:"司令塔",main:{ai:"claude-code",model:"Fable 5.1",effort:"極高"},backup:{ai:"codex",model:"Astra",effort:"極高"}}]', a.context);
  assert.deepEqual(JSON.parse(JSON.stringify(a.context.chatPick(data.projects[0], roleTask))), saved);
  a.context.localStorage.getItem = key => key === 'hub-chat-p/t' ? JSON.stringify({ ai: 'codex', model: 'Astra', effort: '中' }) : null;
  assert.equal(a.context.chatPick(data.projects[0], roleTask).model, 'Astra');
});

test('新規プロジェクトの最初の依頼も設定したAIで送り、作業の選択を会話欄へ引き継ぐ', async () => {
  const a = app(), calls = [], fields = new Map([['name', '見本'], ['firstTask', '最初の依頼']]);
  const configured = snapshot(); configured.initialPick = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(configured), a.context);
  a.context.FormData = class { get(k) { return fields.get(k); } getAll() { return []; } entries() { return fields.entries(); } };
  a.context.api = async (route, body) => { calls.push({ route, body }); return route === '/api/project/new' ? { id: 'p', name: '見本' } : { task: 't' }; };
  a.context.load = async () => {};
  await a.events.get('submit')({ target: { id: 'projform', classList: { contains: () => false } }, preventDefault() {} });
  assert.equal(calls[1].route, '/api/start');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { project: 'p', text: '最初の依頼', ai: 'claude', model: 'Opus 5.5', effort: '中', images: [] });
  const data = snapshot(); data.roles.models.codex = ['Astra', 'GPT-6.1-Sol']; data.efforts = ['中', '高', '極高'];
  data.roles.models['claude-code'] = ['Opus 5.5'];
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  const task = { ...data.projects[0].tasks[0], owner: 'claude-code', model: calls[1].body.model, effort: calls[1].body.effort };
  const html = a.context.chatHtml(data.projects[0], task);
  assert.match(html, /value="claude\|Opus 5.5"[^>]*\bselected\b/);
  assert.match(html, /<option selected>中<\/option>/);
});

test('始める下書きは再描画・切替・再起動で復元し、登録済み担当だけを選べる', () => {
  const a = app(), storage = new Map();
  a.context.localStorage.getItem = k => storage.get(k) || null;
  a.context.localStorage.setItem = (k, v) => storage.set(k, v);
  const data = snapshot(); data.projects[0].tasks.push({ ...data.projects[0].tasks[0], owner: 'discord:しおり' });
  data.roles.agents = ['つむぎ', 'りつ'];
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"project",project:"p"}', a.context);
  assert.equal(vm.runInContext('quickDraft(proj("p")).ai', a.context), 'codex');
  vm.runInContext('Object.assign(quickDraft(proj("p")), {text:"入力した指示",ai:"codex",images:[{id:"image",name:"画像.png",url:"/image"}]}); keepQuick("p"); renderOverview(proj("p"))', a.context);
  assert.match(a.element('#main').innerHTML, /入力した指示/);
  assert.match(a.element('#quick-images').innerHTML, /画像.png/);
  assert.match(a.element('#quick-controls').innerHTML, /Codex|しおり|つむぎ|りつ/);
  vm.runInContext('quickDrafts.clear(); renderOverview(proj("p"))', a.context);
  assert.match(a.element('#main').innerHTML, /入力した指示/);
  assert.equal(vm.runInContext('quickDraft(proj("p")).ai', a.context), 'codex');
  assert.equal(vm.runInContext('quickDraft({id:"other"}).text', a.context), '');
});

test('スクショdropはFileListが空でもfile itemから添付し、本文と既存画像を保持する', async () => {
  const a = conversationApp(), got = [], image = {name:'shot.png',type:'image/png'};
  a.element('#chat-in').value = '書きかけの本文';
  a.context.chatImages('p','t').push(attached('existing'));
  a.context.addChatImage = async (...args) => got.push(args);
  const drop = transfer => a.events.get('drop')({dataTransfer:transfer,target:{closest:selector=>selector==='.chat'?{}:null},preventDefault(){}});
  await drop({files:[],items:[{kind:'string',getAsFile:()=>{throw Error('not a file');}},{kind:'file',getAsFile:()=>null},{kind:'file',getAsFile:()=>image}]});
  assert.equal(got.length,1); assert.deepEqual(got[0],['p','t',image]);
  await drop({files:[image],items:[{kind:'file',getAsFile:()=>image}]});
  assert.equal(got.length,2,'FileListとitemsを二重に添付しない');
  assert.equal(a.element('#chat-in').value,'書きかけの本文');
  assert.equal(a.context.chatImages('p','t')[0].id,'existing');
  const messages=[]; a.context.toast=message=>messages.push(message);
  await drop({files:[],items:[]}); assert.equal(got.length,2);
  assert.match(messages[0],/ブラウザから画像データが届きませんでした/);
});

test('スクショNativeの遅延dropは開始時の画面・会話世代に一回だけ結び付く', async () => {
  const a = conversationApp(), got=[];
  a.element('#main').firstElementChild={isConnected:true};
  a.context.addChatImage=async(...args)=>got.push(args);
  const native=a.context.window.hubNativeDrop;
  const ticket=native.begin(); assert.equal(typeof ticket,'string');
  await native(['/tmp/shot.png'],ticket); await native(['/tmp/shot.png'],ticket);
  assert.deepEqual(got,[['p','t','/tmp/shot.png',true]]);
  for(const change of [
    ()=>vm.runInContext('view.task="other"',a.context),
    ()=>{a.element('#main').firstElementChild={isConnected:true};},
    ()=>vm.runInContext('globalThis.HubChatGenerations=new Map([["p\\0t",1]])',a.context),
    ()=>vm.runInContext('fileViewer={}',a.context),
    ()=>{a.document.querySelectorAll=()=>[{}];},
  ]) {
    vm.runInContext('view.task="t";fileViewer=null;delete globalThis.HubChatGenerations',a.context);
    a.document.querySelectorAll=()=>[];
    const id=native.begin(); change(); await native(['/tmp/late.png'],id);
    assert.equal(got.length,1,'遅延画像は別画面・再描画・会話世代更新後・画像ビューア・ダイアログへ入れない');
  }
  assert.equal(native.begin(),null,'ダイアログ中は新しいdropを開始しない');
  a.document.querySelectorAll=()=>[];
  const messages=[];a.context.toast=message=>messages.push(message);
  const failed=native.begin();native.fail(failed);native.fail(failed);
  assert.equal(messages.length,1);await native(['/tmp/failed.png'],failed);assert.equal(got.length,1);
});

test('入力欄へのドロップ・画像貼り付けで本文を保持し、Nativeの非画像は参考資料へ渡す', async () => {
  const a = app(), data = snapshot(), got = [], refs = [];
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"project",project:"p"}; quickDraft(proj("p")).text = "消えない指示"', a.context);
  a.context.addQuickImages = async (p, images, native) => { got.push([p.id, images, native]); };
  a.context.api = async (route, body) => { refs.push([route, body]); return { added: 1 }; };
  a.context.load = async () => {};
  let prevented = 0, stopped = 0;
  const event = { target: { closest: () => ({}) }, preventDefault: () => prevented++, stopPropagation: () => stopped++, dataTransfer: { files: [{name:'drop.png',type:'image/png'}] }, clipboardData: { files: [{name:'paste.png',type:'image/png'}] } };
  a.events.get('drop')(event); a.events.get('paste')(event);
  await a.context.window.hubNativeDrop(['/tmp/native.heic', '/tmp/reference']);
  assert.equal(prevented, 2); assert.equal(stopped, 2); assert.equal(got.length, 3);
  assert.equal(got[2][2], true); assert.deepEqual([...refs[0][1].paths], ['/tmp/reference']);
  assert.equal(vm.runInContext('quickDraft(proj("p")).text', a.context), '消えない指示');
});

function conversationApp() {
  const a = app(), data = snapshot();
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"work",project:"p",task:"t"}', a.context);
  a.element('#chat-ai').value = 'codex|GPT-6.1-Sol';
  a.element('#chat-effort').value = '高';
  a.context.openChat(data.projects[0], data.projects[0].tasks[0]);
  return a;
}
function freetalkConversation() {
  const a=conversationApp();
  vm.runInContext('state.projects[0].id="freetalk";state.projects[0].kind="freetalk";state.projects[0].tasks[0].freetalkHistory={generation:1};view={kind:"work",project:"freetalk",task:"t"};openChat(proj("freetalk"),taskOf(proj("freetalk"),"t"));',a.context);
  return a;
}
for (const [name, screen, paths, terminal, zone] of [
  ['ターミナルの画像', 'work', ['/tmp/promised.png'], true],
  ['会話の画像以外', 'work', ['/tmp/promised.txt']],
  ['会話の画像と文書の混在', 'work', ['/tmp/promised.png', '/tmp/promised.txt']],
  ['プロジェクト参考', 'project', ['/tmp/promised.txt']],
  ['プロジェクトの画像と参考の混在', 'project', ['/tmp/promised.png', '/tmp/promised.txt']],
  ['新規プロジェクトの参考', 'newproject', ['/tmp/promised.png'], false, 'refs'],
  ['新規プロジェクトの本体', 'newproject', ['/tmp/promised.png'], false, 'body'],
]) test(`H1 一時ファイルは${name}へ場所を記録せず全件拒否する`, async () => {
  const a = conversationApp(), writes = [], notices = [];
  a.element('#chat-in').value = '残す本文';
  a.context.chatImages('p', 't').push(attached('existing'));
  vm.runInContext(`view.kind=${JSON.stringify(screen)};lastDropZone=${JSON.stringify(zone || '')}`, a.context);
  if (terminal) {
    const query = a.document.querySelector;
    a.document.querySelector = s => s === '#chat-in' ? null : query(s);
  }
  for (const method of ['api', 'fetch', 'addChatImage', 'addQuickImages', 'addNewRefs', 'setBodyFolder']) {
    a.context[method] = async (...args) => { writes.push([method, ...args]); };
  }
  a.context.toast = text => notices.push(text);
  a.element('#main').firstElementChild = { isConnected: true };
  const native = a.context.window.hubNativeDrop, ticket = native.begin();
  assert.equal(typeof ticket, 'string');
  assert.equal(await native(paths, ticket, { temporary: true }), false);
  assert.deepEqual(writes, [], 'API・参照一覧・本体・画像のどこにも一時パスを渡さない');
  assert.equal(a.element('#chat-in').value, '残す本文');
  assert.deepEqual(Array.from(a.context.chatImages('p', 't'), x => x.id), ['existing']);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /保存したファイルを選ぶか、画像を会話画面に/);
  await native(paths, ticket, { temporary: true });
  assert.equal(notices.length, 1, '拒否したticketも一度で消費する');
});

test('H1 一時画像の会話dropはコピー完了まで待ち本文と既存添付を残す', async () => {
  const a = conversationApp(); let finish, completed = false;
  a.element('#chat-in').value = '残す本文';
  a.context.chatImages('p', 't').push(attached('existing'));
  a.context.api = (route, body) => {
    assert.equal(route, '/api/start/image-path');
    assert.equal(body.project, 'p'); assert.equal(body.path, '/tmp/promised.png');
    return new Promise(resolve => { finish = resolve; });
  };
  a.element('#main').firstElementChild = { isConnected: true };
  const native = a.context.window.hubNativeDrop;
  const pending = native(['/tmp/promised.png'], native.begin(), { temporary: true }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, 'nativeの片付けに戻る前に画像保存を待つ');
  finish(attached('saved-copy')); await pending;
  assert.equal(completed, true);
  assert.equal(a.element('#chat-in').value, '残す本文');
  assert.deepEqual(Array.from(a.context.chatImages('p', 't'), x => x.path), ['/local/existing.png', '/local/saved-copy.png']);
});

test('H1 プロジェクト画面の一時画像は参考パスではなく画像コピーに保存する', async () => {
  const a = conversationApp(), routes = [];
  vm.runInContext('view={kind:"project",project:"p"};quickDraft(proj("p")).text="残す指示"', a.context);
  a.context.api = async (route, body) => {
    routes.push(route); assert.equal(route, '/api/start/image-path');
    assert.equal(body.path, '/tmp/promised.png'); return attached('saved-copy');
  };
  a.element('#main').firstElementChild = { isConnected: true };
  const native = a.context.window.hubNativeDrop;
  await native(['/tmp/promised.png'], native.begin(), { temporary: true });
  assert.deepEqual(routes, ['/api/start/image-path']);
  assert.equal(vm.runInContext('quickDraft(proj("p")).text', a.context), '残す指示');
  assert.equal(vm.runInContext('quickDraft(proj("p")).images[0].path', a.context), '/local/saved-copy.png');
});

test('H1 freetalkの一時文書は話題のコピー保存と世代照合を経由する', async () => {
  const a = freetalkConversation(), routes = [];
  a.element('#chat-in').value = '残す本文';
  a.context.api = async (route, body) => {
    routes.push(route);
    if (route === '/api/task/attach') {
      assert.equal(body.project, 'freetalk'); assert.equal(body.task, 't'); assert.equal(body.generation, 1);
      assert.deepEqual(Array.from(body.paths), ['/tmp/promised.txt']);
      return { attachments: [{ id: 'copy', name: 'copy.txt', generation: 1, kind: 'file', path: '/copy/copy.txt' }] };
    }
    assert.equal(route, '/api/freetalk/status?project=freetalk&task=t');
    return { generation: 1, revision: 'after-upload', reason: '' };
  };
  a.element('#main').firstElementChild = { isConnected: true };
  const native = a.context.window.hubNativeDrop;
  await native(['/tmp/promised.txt'], native.begin(), { temporary: true });
  assert.deepEqual(routes, ['/api/task/attach', '/api/freetalk/status?project=freetalk&task=t']);
  assert.equal(a.context.chatImages('freetalk', 't')[0].path, '/copy/copy.txt');
  assert.equal(a.element('#chat-in').value, '残す本文');
});

test('H1 Finderの通常URLはターミナルでも従来の場所記録へ渡す', async () => {
  for (const options of [undefined, { temporary: false }]) {
    const a = conversationApp(), query = a.document.querySelector, routes = [];
    a.document.querySelector = s => s === '#chat-in' ? null : query(s);
    a.context.api = async (route, body) => {
      routes.push(route); assert.equal(route, '/api/task/attach');
      assert.deepEqual(Array.from(body.paths), ['/saved/shot.png']); return { typed: false };
    };
    a.element('#main').firstElementChild = { isConnected: true };
    const native = a.context.window.hubNativeDrop;
    await native(['/saved/shot.png'], native.begin(), options);
    assert.deepEqual(routes, ['/api/task/attach']);
  }
});
test('スクショNativeはfreetalkの保存世代が更新された後に古い画像を追加しない',async()=>{
  const a=freetalkConversation();a.element('#main').firstElementChild={isConnected:true};
  let added=0;a.context.addChatImage=async()=>added++;
  const native=a.context.window.hubNativeDrop,ticket=native.begin();
  vm.runInContext('state.projects[0].tasks[0].freetalkHistory.generation=2',a.context);
  await native(['/tmp/old-shot.png'],ticket);assert.equal(added,0);
});
test('freetalkはスマホの選択・drop・ネイティブ貼付を話題uploadへ統一し、文書も選べる',async()=>{
 const a=freetalkConversation(),calls=[];a.context.matchMedia=()=>({matches:true});
 a.element('#chat-files').click=()=>{};a.element('#chat-attach').handlers.click();assert.match(a.element('#chat-files').accept,/\.pdf.*\.pptx.*\.key/);
 a.context.fetch=async(url,options)=>{calls.push({url:String(url),options});return {ok:true,json:async()=>({id:'pdf',name:'doc.pdf',kind:'file',path:'/copies/doc.pdf',referencePaths:['/copies/doc.pdf','/copies/.derived/text.txt'],status:'partial',message:'一部のみ',generation:1})};};
 await a.context.sendFiles([{name:'doc.pdf',type:'application/pdf'}],'');assert.match(calls[0].url,/\/api\/task\/upload\?project=freetalk&task=t&name=doc.pdf&generation=1/);
 assert.match(a.element('#chat-images').innerHTML,/一部のみ/);const text=a.context.chatSendText('確認',a.context.chatImages('freetalk','t'));assert.match(text,/\.derived\/text.txt/);assert.match(text,/一部のみ/);
 a.context.api=async(route,body)=>{assert.equal(route,'/api/task/attach');assert.equal(body.generation,1);assert.equal(body.project,'freetalk');return {attachments:[{id:'key',name:'deck.key',kind:'file',status:'unsupported',message:'PDFかPPTX',path:'/copies/deck.key',referencePaths:['/copies/deck.key'],generation:1}]};};
 await a.context.window.hubNativePaste(['/original/deck.key']);assert.match(a.element('#chat-images').innerHTML,/本文を参照できません/);assert.match(a.context.chatSendText('',a.context.chatImages('freetalk','t')),/PDFかPPTX/);assert.doesNotMatch(a.context.chatSendText('',a.context.chatImages('freetalk','t')),/\/original/);
});
test('freetalk添付中はクリア・続行・削除・掃除が無効、古い世代の遅延応答は表示しない',async()=>{
 const a=freetalkConversation(),buttons=['freetalkclear','freetalkcontinue','freetalkdelete','freetalkclean'].map(action=>({dataset:{act:action,t:'t'},disabled:false}));
 a.context.api=async()=>({generation:2});
 a.document.querySelectorAll=selector=>selector==='[data-act^="freetalk"]'?buttons:[];let finish;
 a.context.fetch=()=>new Promise(resolve=>finish=resolve);const pending=a.context.addChatImage('freetalk','t',{name:'photo.png'});
 assert.ok(buttons.every(b=>b.disabled));assert.equal(a.element('#chat-image-state').hidden,false);
 vm.runInContext('globalThis.HubChatGenerations=new Map([["freetalk\\0t",2]])',a.context);
 finish({ok:true,json:async()=>({id:'old',name:'photo.png',path:'/copies/photo.png',generation:1})});await pending;
 assert.equal(a.context.chatImages('freetalk','t').length,0);assert.ok(buttons.every(b=>!b.disabled));assert.equal(a.element('#chat-image-state').hidden,true);
});
test('freetalk添付完了後に最新の確認revisionとbusy解除を画面へ取得する',async()=>{
 const a=freetalkConversation(),routes=[];
 a.context.api=async(route)=>{routes.push(route);return route==='/api/task/attach'?{attachments:[{id:'copy',name:'copy.txt',generation:1,kind:'file',path:'/copy/copy.txt'}]}:{generation:1,revision:'after-upload',reason:''};};
 await a.context.addChatImage('freetalk','t','/original/copy.txt',true);assert.deepEqual(routes,['/api/task/attach','/api/freetalk/status?project=freetalk&task=t']);assert.equal(vm.runInContext('taskOf(proj("freetalk"),"t").freetalkHistory.revision',a.context),'after-upload');
});
test('freetalkの送信は抽出物と非対応注記、添付IDと世代を保持する',async()=>{
 const a=freetalkConversation();let send,request;
 a.context.chatImages('freetalk','t').push({id:'key',name:'deck.key',kind:'file',path:'/copy/deck.key',referencePaths:['/copy/deck.key','/copy/preview.png'],message:'Keynoteの本文は読めません。PDFかPPTXに書き出して添付してください',generation:1});
 a.context.bindAskAnswers=(_box,cb)=>send=cb;vm.runInContext('openChat(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 a.context.api=async(_route,body)=>{request=body;return {ok:true,queued:true,queue:1};};a.context.load=async()=>{};
 assert.equal(await send(),true);assert.deepEqual(Array.from(request.images),['key']);assert.equal(request.generation,1);assert.match(request.text,/\/copy\/preview.png/);assert.match(request.text,/本文は読めません/);
});
test('freetalkの一括添付は途中で世代が変わったら残りを新会話へ追加しない',async()=>{
 const a=freetalkConversation();let finish,calls=0;a.context.syncFreetalkHistory=async()=>{};
 a.context.fetch=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 const pending=a.context.sendFiles([{name:'one.txt'},{name:'two.txt'}],'');assert.equal(calls,1);
 vm.runInContext('state.projects[0].tasks[0].freetalkHistory.generation=2',a.context);
 finish({ok:true,json:async()=>({id:'old',name:'one.txt',generation:1})});await pending;assert.equal(calls,1);assert.equal(a.context.chatImages('freetalk','t').length,0);
});
const attached = (id = 'first') => ({ id, name: id + '.png', url: '/api/start/image?id=' + id, path: '/local/' + id + '.png' });

test('会話の＋は送信しないファイル選択ボタンで、captureと固定acceptを持たない', () => {
  const a = conversationApp(), p = project(), html = a.context.chatHtml(p, p.tasks[0]);
  assert.match(html, /<button[^>]*id="chat-attach"[^>]*type="button"[^>]*aria-label="ファイルを追加"[^>]*>＋<\/button>/);
  const input = html.match(/<input[^>]*id="chat-files"[^>]*>/)?.[0];
  assert.ok(input); assert.match(input, /type="file"/); assert.match(input, /multiple hidden/);
  assert.doesNotMatch(input, /\b(?:accept|capture)\b/);
  assert.ok(html.indexOf('id="chat-attach"') < html.indexOf('id="chat-ai"'));
  assert.match(html, /会話を読み込んでいます/);
  assert.match(vm.runInContext('EMPTY_CHAT',a.context), /［＋］で選ぶ/);
});

test('＋は押した時の画面幅で写真／全ファイルを選び、選択値を空にして同期的に開く', () => {
  const a = conversationApp(), input = a.element('#chat-files'); let phone = true, clicks = 0;
  a.context.matchMedia = query => { assert.equal(query, '(max-width:720px)'); return {matches:phone}; };
  input.click = () => { clicks++; assert.equal(input.value, ''); assert.equal(input.accept, phone ? 'image/*' : ''); };
  for (const mode of [true, false, true]) {
    phone = mode; input.value = '以前の選択'; a.element('#chat-attach').handlers.click();
  }
  assert.equal(clicks, 3);
});

test('＋で選んだ写真はサムネイル、一般ファイルも添付表示になり、選択値と本文を保護する', async () => {
  const a = conversationApp(), input = a.element('#chat-files'), calls = [];
  a.element('#chat-in').value = '確認して';
  a.context.fetch = async (url, options) => {
    calls.push({url:String(url), options});
    return {ok:true,json:async()=>String(url).startsWith('/api/start/image?') ? attached() : {path:'/local/note.txt'}};
  };
  input.files = [{name:'first.png',type:'image/png'}, {name:'note.txt',type:'text/plain'}]; input.value = '選択';
  await input.handlers.change();
  assert.equal(input.value, '');
  assert.match(a.element('#chat-images').innerHTML, /first.png/);
  assert.equal(a.element('#chat-in').value, '確認して');
  assert.match(a.element('#chat-images').innerHTML, /note.txt/);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith('/api/start/image?project=p&name=first.png'));
  assert.ok(calls[1].url.startsWith('/api/task/upload?project=p&task=t&ai=&name=note.txt'));
  assert.equal(calls[0].options.body, input.files[0]); assert.equal(calls[1].options.body, input.files[1]);
  assert.equal(calls[0].options.headers['X-Hub'], '1');
});

test('＋の選択中にプロジェクト・作業・画面・モード・入力要素が変わったら添付しない', async () => {
  for (const change of [
    'view = {kind:"work",project:"q",task:"t"}',
    'view = {kind:"work",project:"p",task:"other"}',
    'view = {kind:"project",project:"p"}',
    'workMode = () => "term"',
    'replace-input',
  ]) {
    const a = conversationApp(), input = a.element('#chat-files'); let uploads = 0;
    a.context.fetch = async () => { uploads++; return {ok:true,json:async()=>attached()}; };
    input.files = [{name:'first.png',type:'image/png'}]; input.value = '選択';
    if (change === 'replace-input') { a.elements.delete('#chat-files'); a.element('#chat-files'); }
    else vm.runInContext(change, a.context);
    await input.handlers.change();
    assert.equal(input.value, ''); assert.equal(uploads, 0, change);
    assert.equal(a.context.chatImages('p','t').length, 0); assert.equal(a.context.chatImages('q','t').length, 0);
  }
});

test('＋の取消・同じ写真の再選択と×取消に対応し、追加中は送信を待つ', async () => {
  const a = conversationApp(), input = a.element('#chat-files'); let finish, uploads = 0, sends = 0;
  a.element('#chat-in').value = '本文';
  a.context.fetch = () => { uploads++; return new Promise(resolve => { finish = resolve; }); };
  a.context.api = async () => { sends++; return {queued:true,queue:1}; };
  input.files = []; input.value = ''; await input.handlers.change();
  assert.equal(uploads, 0); assert.equal(a.element('#chat-in').value, '本文');
  const file = {name:'first.png',type:'image/png'};
  for (let i = 0; i < 2; i++) {
    input.files = [file]; input.value = '選択'; const pending = input.handlers.change();
    assert.equal(input.value, ''); assert.equal(a.element('#chat-image-state').hidden, false);
    a.element('#composer').handlers.submit({preventDefault(){}}); assert.equal(sends, 0);
    finish({ok:true,json:async()=>attached()}); await pending;
    assert.equal(a.element('#chat-image-state').hidden, true); assert.equal(a.context.chatImages('p','t').length, 1);
    a.element('#chat-images').handlers.click({target:{closest:()=>({dataset:{chatRemove:'first'}})}});
    assert.equal(a.context.chatImages('p','t').length, 0);
  }
  assert.equal(uploads, 2); assert.equal(a.element('#chat-in').value, '本文');
});

test('会話の画像ドロップとMac貼り付けは本文を保ち、サムネイルと×を表示する', async () => {
  const a = conversationApp();
  a.element('#chat-in').value = '消さない本文';
  a.context.fetch = async () => ({ ok: true, json: async () => attached() });
  a.context.api = async route => { assert.equal(route, '/api/start/image-path'); return attached('native'); };
  await a.context.sendFiles([{name:'first.png',type:'image/png'}], 'codex');
  await a.context.window.hubNativeDrop(['/local/native.png']);
  assert.equal(a.element('#chat-in').value, '消さない本文');
  assert.match(a.element('#chat-images').innerHTML, /<img src=.*first/);
  assert.match(a.element('#chat-images').innerHTML, /data-chat-remove="native"/);
  a.element('#chat-images').handlers.click({ target: { closest: () => ({ dataset: { chatRemove: 'first' } }) } });
  assert.doesNotMatch(a.element('#chat-images').innerHTML, /first/);
  assert.equal(a.context.chatSendText('指示', a.context.chatImages('p','t')), '指示\n\n参照画像（絶対パス）：\n/local/native.png');
});

test('会話の添付は同名の作業でもプロジェクト別に分かれ、切替と再描画で保持する', () => {
  const a = conversationApp();
  a.context.chatImages('p','t').push(attached());
  a.context.chatImages('q','t').push(attached('other'));
  const p = project(), q = {...p, id:'q'};
  assert.match(a.context.chatHtml(p,p.tasks[0]), /first.png/);
  assert.doesNotMatch(a.context.chatHtml(p,p.tasks[0]), /other.png/);
  assert.match(a.context.chatHtml(q,q.tasks[0]), /other.png/);
  assert.match(a.context.chatHtml(p,p.tasks[0]), /first.png/);
});

test('画像の一部失敗・画面切替中でも成功分を元の会話へ残し、非画像も添付で保持する', async () => {
  const a = conversationApp(), targets = [];
  a.element('#chat-in').value = '本文';
  a.context.fetch = async url => {
    targets.push(String(url));
    if (String(url).includes('bad.png')) return {ok:false,json:async()=>({error:'保存失敗'})};
    if (String(url).includes('note.txt')) return {ok:true,json:async()=>({path:'/local/note.txt'})};
    vm.runInContext('view = {kind:"work",project:"q",task:"t"}', a.context);
    return {ok:true,json:async()=>attached()};
  };
  vm.runInContext('chatDraft[chatAttachmentKey("p","t")] = "本文"', a.context);
  await a.context.sendFiles([{name:'bad.png',type:'image/png'},{name:'first.png',type:'image/png'},{name:'note.txt',type:'text/plain'}], '');
  assert.equal(a.context.chatImages('p','t').length, 2);
  assert.equal(a.context.chatImages('q','t').length, 0);
  assert.equal(a.context.chatImages('p','t')[1].path, '/local/note.txt');
  assert.equal(a.context.chatImages('p','t')[1].kind, 'file');
  assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]',a.context), '本文');
  assert.equal(a.element('#chat-in').value, '本文', '切替先の入力を変えない');
  assert.ok(targets.every(x=> x.includes('project=p')));
});

test('送信失敗なら本文と画像を保持し、画像だけでも送信、成功した分だけを消す', async () => {
  const a = conversationApp();
  a.context.chatImages('p','t').push(attached());
  a.element('#chat-in').value = '依頼';
  a.context.api = async () => { throw Error('送信失敗'); };
  const submit = () => a.element('#composer').handlers.submit({preventDefault(){}});
  submit(); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '依頼');
  assert.equal(a.context.chatImages('p','t').length, 1);
  let finish, request;
  a.context.api = async (route, body) => { request = body; return new Promise(resolve=>finish=resolve); };
  a.element('#chat-in').value = '';
  submit();
  assert.match(request.text, /添付画像を確認してください/);
  assert.match(request.text, /first.png/);
  a.context.chatImages('p','t').push(attached('later'));
  a.element('#chat-in').value = '次の依頼';
  a.element('#chat-in').handlers.input();
  finish({queued:true,queue:1}); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '次の依頼');
  assert.deepEqual(Array.from(a.context.chatImages('p','t'),x=>x.id), ['later']);
});

test('送信直後に入力欄を空にし、受付待ちの新しい下書きを成功後も保つ', async () => {
  const a = conversationApp(); let finish;
  a.element('#chat-in').value = '送る本文';
  a.context.api = async () => new Promise(resolve => { finish = resolve; });
  a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(a.element('#chat-in').value, '');
  assert.equal(a.element('#chat-send').disabled, true);
  assert.equal(a.element('#chat-send').textContent, '送っています…');
  assert.equal(a.element('#chat-send-status').hidden, false);
  assert.equal(a.element('#chat-send-status').textContent, '送信を確認しています…');
  assert.equal(vm.runInContext('chatBusy', a.context), null); // HTTP acceptance is still pending.
  a.element('#chat-in').value = '次の下書き'; a.element('#chat-in').handlers.input();
  finish({queued:true,queue:1}); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '次の下書き');
  assert.equal(a.element('#chat-send').disabled, false);
  assert.equal(a.element('#chat-send-status').hidden, true);
  assert.equal(a.element('#chat-send-status').textContent, '');
});

test('受付失敗なら別の会話を変えず原稿を復元し、新しい下書きも残す', async () => {
  for (const switched of [false, true]) {
    const a = conversationApp(); let fail;
    a.element('#chat-in').value = '送る本文';
    a.context.api = async () => new Promise((resolve,reject) => { fail = reject; });
    a.element('#composer').handlers.submit({preventDefault(){}});
    a.element('#chat-in').value = '次の下書き'; a.element('#chat-in').handlers.input();
    if (switched) {
      vm.runInContext('view.task="other"',a.context);
      a.element('#chat-in').value = '別の会話の本文';
    }
    fail(Error('受付失敗')); await new Promise(setImmediate);
    assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]',a.context), '送る本文\n\n次の下書き');
    assert.equal(a.element('#chat-in').value, switched ? '別の会話の本文' : '送る本文\n\n次の下書き');
    if (!switched) assert.equal(a.element('#chat-send-status').hidden, true);
  }
});

test('画像追加中の送信を待ち、完了後に画像付きで送れる', async () => {
  const a = conversationApp(); let finish, calls = 0;
  a.element('#chat-in').value = '依頼';
  a.context.fetch = () => new Promise(resolve=>finish=resolve);
  const pending = a.context.addChatImage('p','t',{name:'first.png'});
  a.context.api = async () => { calls++; return {queued:true,queue:1}; };
  a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(calls, 0); assert.equal(a.element('#chat-image-state').hidden, false);
  finish({ok:true,json:async()=>attached()}); await pending;
  a.element('#composer').handlers.submit({preventDefault(){}}); await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(a.context.chatImages('p','t').length, 0);
});

test('送信待ちで会話を描き直しても二重送信せず、成功後に表示中の本文と画像を消す', async () => {
  const a = conversationApp(); let finish, calls = 0;
  a.element('#chat-in').value = '送る本文';
  a.context.chatImages('p','t').push(attached());
  a.context.api = async route => { if(route.startsWith('/api/discussion?'))return {session:null,candidates:[],previous:null}; calls++; return new Promise(resolve=>finish=resolve); };
  a.element('#composer').handlers.submit({preventDefault(){}});
  a.context.closePanes();
  a.elements.delete('#chat-in'); a.element('#chat-in').value = vm.runInContext('chatDraft[chatAttachmentKey("p","t")]', a.context);
  a.context.openChat(project(),project().tasks[0]);
  a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(calls, 1);
  finish({queued:true,queue:1}); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '');
  assert.equal(a.context.chatImages('p','t').length, 0);
});

test('受付済み409は失敗のまま受付証拠を渡し、本文と送った添付を戻さず待機理由を表示する', async () => {
  const a = conversationApp(); let sends = 0;
  a.context.fetch = async route => {
    assert.equal(route, '/api/chat/send'); sends++;
    return {ok:false,status:409,json:async()=>({error:'終了・保存を確認できません',queued:true,id:'accepted-test'})};
  };
  await assert.rejects(a.context.api('/api/chat/send', {}), error =>
    error.status === 409 && error.queued === true && error.id === 'accepted-test');
  sends = 0;
  a.element('#chat-in').value = '受付済みの本文'; a.context.chatImages('p','t').push(attached());
  a.element('#chat-amend').handlers.click();
  assert.equal(a.element('#chat-in').value, '');
  await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '');
  assert.equal(a.context.chatImages('p','t').length, 0);
  assert.equal(sends, 1);
  assert.match(a.element('#toast').textContent, /受け付けました.*終了・保存を確認できません/);
  assert.equal(vm.runInContext('chatBusy', a.context), null, '受付をAI開始扱いしない');
});

test('受付済み409の遅延中に入力した同文・添付を同会話再描画や会話切替でも保持する', async t => {
  for (const change of ['same', 'redraw', 'switch']) await t.test(change, async () => {
    const a = conversationApp(); let finish, sends = 0;
    a.context.fetch = (route, options) => {
      assert.equal(route, '/api/chat/send'); sends++;
      assert.match(JSON.parse(options.body).text, /受付済みの本文/);
      return new Promise(resolve => { finish = resolve; });
    };
    a.element('#chat-in').value = '受付済みの本文'; a.context.chatImages('p','t').push(attached());
    a.element('#chat-redo').handlers.click();
    a.element('#chat-in').value = '受付済みの本文'; a.element('#chat-in').handlers.input();
    a.context.chatImages('p','t').push(attached('later'));
    if (change === 'redraw') {
      a.context.closePanes(); a.elements.delete('#chat-in');
      a.element('#chat-in').value = vm.runInContext('chatDraft[chatAttachmentKey("p","t")]', a.context);
      a.context.openChat(project(),project().tasks[0]);
      a.element('#composer').handlers.submit({preventDefault(){}});
    } else if (change === 'switch') {
      vm.runInContext('view.task="other"', a.context);
      a.element('#chat-in').value = '別会話の本文'; a.context.chatImages('p','other').push(attached('other'));
    }
    finish({ok:false,status:409,json:async()=>({error:'停止の保存待ち',queued:true,id:'accepted-test'})});
    await new Promise(setImmediate);
    assert.equal(sends, 1, '再送も待ち指示の開始もしない');
    assert.equal(a.element('#chat-in').value, change === 'switch' ? '別会話の本文' : '受付済みの本文');
    assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]', a.context), '受付済みの本文');
    assert.deepEqual(Array.from(a.context.chatImages('p','t'), x=>x.id), ['later']);
    if (change === 'switch') assert.deepEqual(Array.from(a.context.chatImages('p','other'), x=>x.id), ['other']);
  });
});

test('受付証拠なし409・不正な証拠・通信不明は原文と添付を保持し自動再送しない', async t => {
  for (const [label, status, body] of [
    ['not-accepted',409,{error:'未受付'}], ['missing-id',409,{error:'照合不能',queued:true}],
    ['empty-id',409,{queued:true,id:' '}], ['string-flag',409,{queued:'true',id:'unproven'}],
    ['other-status',500,{error:'結果不明',queued:true,id:'unproven'}], ['network',0,null]
  ]) await t.test(label, async () => {
    const a = conversationApp(); let finish, fail, sends = 0;
    a.context.fetch = route => {
      assert.equal(route, '/api/chat/send'); sends++;
      return new Promise((resolve,reject) => { finish=resolve; fail=reject; });
    };
    a.element('#chat-in').value = '未確認の原文'; a.context.chatImages('p','t').push(attached());
    a.element('#chat-amend').handlers.click();
    a.element('#chat-in').value = '新しい下書き'; a.element('#chat-in').handlers.input();
    a.context.chatImages('p','t').push(attached('later'));
    if (status) finish({ok:false,status,json:async()=>body}); else fail(Error('通信結果不明'));
    await new Promise(setImmediate);
    assert.equal(a.element('#chat-in').value, '未確認の原文\n\n新しい下書き');
    assert.deepEqual(Array.from(a.context.chatImages('p','t'), x=>x.id), ['first','later']);
    assert.equal(sends, 1);
  });
});

test('通常200の受付後に表示更新が失敗しても送った添付を戻さず新しい下書きを保持する', async () => {
  const a = conversationApp(); let finish;
  a.context.fetch = async () => new Promise(resolve => { finish=resolve; });
  a.context.acceptedWorkAnswer = async()=>{throw Error('表示更新失敗');};
  a.element('#chat-in').value = '受付済み'; a.context.chatImages('p','t').push(attached());
  a.element('#composer').handlers.submit({preventDefault(){}});
  a.element('#chat-in').value = '次の下書き'; a.element('#chat-in').handlers.input();
  a.context.chatImages('p','t').push(attached('later'));
  finish({ok:true,status:200,json:async()=>({ok:true,queued:true,id:'accepted-test',queue:1})});
  await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '次の下書き');
  assert.deepEqual(Array.from(a.context.chatImages('p','t'),x=>x.id), ['later']);
  assert.equal(a.element('#toast').textContent, '表示更新失敗');
});

test('受付済み409でも質問の回答済みを推測せず入力欄・別の質問を保護する', async () => {
  const a = conversationApp();
  vm.runInContext('proj("p").tasks[0].question="確認する質問"', a.context);
  a.element('#chat-in').value = '回答とは別の下書き'; a.context.chatImages('p','t').push(attached());
  a.context.fetch = async route => {
    if (route !== '/api/chat/send') return new Promise(()=>{});
    vm.runInContext('proj("p").tasks[0].question="新しい質問"', a.context);
    return {ok:false,status:409,json:async()=>({error:'停止の保存待ち',queued:true,id:'answer-test'})};
  };
  // 受付待ちの表示更新が通信完了を待たないようにする。質問照合は実関数を通す。
  a.context.load = async()=>{};
  assert.equal(await vm.runInContext('sendWorkAnswer.send("質問への回答")', a.context), true);
  assert.equal(a.element('#chat-in').value, '回答とは別の下書き');
  assert.equal(a.context.chatImages('p','t').length, 1);
  assert.equal(vm.runInContext('proj("p").tasks[0].question', a.context), '新しい質問');
});

test('Macの画像以外はサーバーが受理した場所を添付表示に保存し、本文を保持する', async () => {
  const a = conversationApp();
  a.element('#chat-in').value = '確認して';
  a.context.api = async (route, body) => {
    assert.equal(route, '/api/task/attach');
    assert.deepEqual(Array.from(body.paths), ['/local/note.txt']);
    return {paths:['/local/note.txt']};
  };
  await a.context.window.hubNativeDrop(['/local/note.txt']);
  assert.equal(a.element('#chat-in').value, '確認して');
  assert.equal(a.context.chatImages('p','t').length, 1);
  assert.equal(a.context.chatImages('p','t')[0].path, '/local/note.txt');
  assert.match(a.element('#chat-images').innerHTML, /note.txt/);
});

test('ターミナルの添付が全件失敗したら成功表示でエラーを消さない', async () => {
  const a = conversationApp(), query = a.document.querySelector;
  a.document.querySelector = s => s === '#chat-in' ? null : query(s);
  a.context.fetch = async () => ({ok:false,json:async()=>({error:'保存失敗'})});
  await a.context.sendFiles([{name:'note.txt',type:'text/plain'}], 'codex');
  assert.match(a.element('#toast').textContent, /保存失敗/);
  assert.doesNotMatch(a.element('#toast').textContent, /0件/);
});

test('作業一覧は4点だけを表示し、AI情報・手順数・種別・作業場所を作業画面に残す', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0], t = p.tasks[0];
  Object.assign(t, { title: '<本作業>', parent: 'parent', kind: 'derived', copy: true, via: 'Discord経由',
    model: 'GPT-6.1-Sol', effort: '高', done: '検証の詳細', steps: [{ text: '確認済み', done: true }, { text: '<次の手順>', done: false }], next: '残りの整理' });
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  const html = a.context.taskRow(p, t, true);
  assert.match(html, /class="trow child /);
  assert.match(html, /<b>&lt;本作業&gt;<\/b>/);
  assert.match(html, /Project・次：&lt;次の手順&gt;/);
  assert.match(html, /data-act="taskcomplete"[^>]*>完了に移す<\/button>/);
  assert.match(html, /data-go="work" data-p="p" data-t="t"[^>]*>作業画面へ<\/button>/);
  assert.equal((html.match(/<button\b/g) || []).length, 2);
  assert.doesNotMatch(html, /class="(?:tw|chip|via|prog|task-context|pend|wq)|task-status|Discord経由|GPT-6\.1-Sol|検証の詳細|作業用コピー|派生元|1 \/ 2/);
  t.steps = []; assert.match(a.context.taskRow(p, t), /次：残りの整理/);
  t.next = ''; assert.match(a.context.taskRow(p, t), /<span>未着手<\/span>/);
  for (const phone of [false, true]) {
    a.context.matchMedia = () => ({ matches: phone });
    t.completionPending = true;
    vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    const work = a.element('#main').innerHTML;
    assert.match(work, /class="task-context small"/);
    assert.match(work, />派生<\/span>/);
    assert.match(work, /作業用コピー/);
    assert.match(work, /class="wq"><span>AI が手順をすべて済にしました/);
    assert.match(work, /やったこと：/);
    assert.match(work, /検証の詳細/);
  }
  assert.match(a.context.chip(p, t), /GPT-6\.1-Sol/);
  assert.match(a.context.progressBar(t), /class="prog /);
});

test('状態札は質問・正式停止・保存状態・完了確認・稼働の優先順で最大1つ出す', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0];
  const cases = [
    { extra: { question: '<質問>', state: '上限で停止', completionPending: true }, quiet: 61, expected: '返事待ち' },
    { extra: { state: '上限で停止', completionPending: true }, quiet: 61, expected: '上限で停止' },
    { extra: { state: '返事待ち', completionPending: true }, quiet: 0, expected: '返事待ち' },
    { extra: { state: '上限で停止', completionPending: true }, quiet: 0, expected: '上限で停止' },
    { extra: { completionPending: true }, quiet: 0, expected: '作業中' },
    { extra: { completionPending: true }, expected: '完了' },
    { extra: {}, quiet: 59, expected: '作業中' },
    { extra: {}, quiet: 3600, expected: '作業中' },
    { extra: {}, chat: true, expected: '作業中' },
    { extra: { state: '実行中' }, expected: '' },
    { extra: {}, quiet: 61, running: false, expected: '' },
    { extra: {}, quiet: 61, task: 'other', expected: '' },
  ];
  for (const c of cases) {
    const t = { ...p.tasks[0], ...c.extra };
    s.sessions = c.quiet === undefined ? [] : [{ project: 'p', task: c.task || 't', ai: 'codex', running: c.running !== false, quiet: c.quiet }];
    s.chatting = c.chat ? [{ project: 'p', task: 't', ai: 'claude' }] : [];
    vm.runInContext('state = ' + JSON.stringify(s), a.context);
    const html = a.context.taskRow(p, t);
    const badges = [...html.matchAll(/class="pill task-status [^"]+">([^<]+)<\/span>/g)].map(x => x[1]);
    assert.deepEqual(badges, c.expected ? [c.expected] : [], JSON.stringify(c));
    if (t.question) assert.match(html, /あなたへの質問：&lt;質問&gt;/);
    else assert.doesNotMatch(html, /入力を待っています/);
  }
});

test('一覧の完了確認は行内操作だけで、質問とreplyタブの保護を維持する', () => {
  const a = app(), s = snapshot(), p = s.projects[0], t = p.tasks[0];
  t.completionPending = true; t.done = '一覧には出さない詳細';
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  for (const tab of [undefined, 'done']) {
    const html = a.context.taskRow(p, t, false, tab);
    assert.match(html, /<div class="tact"><button[^>]*data-act="taskcomplete"/);
    assert.match(html, /data-act="taskcontinue"[^>]*>まだ続ける<\/button>/);
    assert.match(html, /task-status confirm">完了<\/span>/);
    assert.equal((html.match(/<button\b/g) || []).length, 3);
    assert.doesNotMatch(html, /class="pend|class="wq|やったこと|一覧には出さない詳細/);
  }
  for (const pending of [false, true]) {
    t.question = '答えてください'; t.completionPending = pending;
    const html = a.context.taskRow(p, t);
    assert.doesNotMatch(html, /data-act="taskcomplete"|data-act="taskcontinue"/);
    assert.match(html, /task-status needs">返事待ち<\/span>/);
    const reply = a.context.taskRow(p, t, true, 'reply');
    assert.match(reply, /data-act="answered"[^>]*>送らずに消す<\/button>/);
    assert.equal((reply.match(/<button\b/g) || []).length, 2);
    assert.doesNotMatch(reply, /data-act="taskcomplete"|data-act="taskcontinue"/);
  }
  t.question = ''; t.state = '完了'; t.completionPending = false;
  const finished = a.context.taskRow(p, t);
  assert.match(finished, /class="trow  fin"/);
  assert.match(finished, /<span>完了<\/span>/);
  assert.match(finished, /data-act="taskcontinue"[^>]*>再開する<\/button>/);
  assert.doesNotMatch(finished, /data-act="taskcomplete"|task-status/);
});

test('子プロジェクトも名前と操作の2列に載せ、状態・件数・質問を保持する', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0];
  const child = project('完了'); child.id = 'child'; child.parent = 'p'; child.name = '<子プロジェクト>';
  child.tasks.push({ ...child.tasks[0], id: 'ask', state: '返事待ち', question: '<選択する>' });
  s.projects.push(child);
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  a.context.renderOverview(p);
  const html = a.element('#main').innerHTML.split('子プロジェクト（1）')[1];
  assert.match(html, /class="task-title"><span class="sdot [^"]+"><\/span><b><button[^>]*>&lt;子プロジェクト&gt;/);
  assert.match(html, /進行中・作業 1 \/ 2/);
  assert.match(html, /質問あり：&lt;選択する&gt;/);
  assert.match(html, /class="tact"><button[^>]*data-go="project" data-p="child"[^>]*>開く<\/button>/);
  assert.doesNotMatch(html, /class="tw"|class="prog"/);
});

test('pending completion remains visible and a completed task does not stamp its phase automatically', () => {
  const a = app(), s = snapshot('完了確認待ち'), p = s.projects[0];
  p.tasks[0].completionPending = true; p.phases = [{name:'Build',state:'進行中'}];
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  a.context.renderOverview(p);
  assert.match(a.element('#main').innerHTML, /task-status confirm">完了<\/span>/);
  assert.match(a.element('#main').innerHTML, /まだ続ける/);
  assert.doesNotMatch(a.element('#main').innerHTML, /完了した作業（1）/);
  p.tasks[0].state = '完了'; p.tasks[0].completionPending = false;
  assert.doesNotMatch(a.context.phaseRoad(p, a.context.phaseInfo(p)), /class="stamp"/);
});

test('cancel completion never calls API and approval sends the shown content hash',async()=>{
 const a=app(),s=snapshot('完了確認待ち');s.projects[0].tasks[0].completionHash='shown';
 vm.runInContext('state = '+JSON.stringify(s),a.context);
 let calls=[];a.context.api=async(route,body)=>{calls.push({route,body});return {};};a.context.load=async()=>{};
 // ［完了に移す］は確認画面を開くだけ。完了の送信は確認画面の［完了に移す］で、表示時の内容ハッシュを使う。
 const opened=[];a.context.showCompletion=(...args)=>{opened.push(args);};
 await a.context.act({dataset:{act:'taskcomplete',p:'p',t:'t'}});assert.equal(calls.length,0);assert.deepEqual(opened,[['p','t','shown']]);
 const sheet=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
 assert.match(sheet,/api\('\/api\/task\/completion',\{project:d\.project,task:d\.task,action:'approve',confirm:true,expectedHash:d\.expectedHash\}\)/);
});

test('片付けは完了済み作業の再開ボタンの隣から開き、完了の送信をしない',async()=>{
 const a=app(),s=snapshot();a.context.fixture=s;vm.runInContext('state=fixture',a.context);
 for(const state of ['未着手','実行中','返事待ち','完了確認待ち']){
  s.projects[0].tasks[0].state=state;assert.doesNotMatch(a.context.completionButtons(s.projects[0],s.projects[0].tasks[0]),/data-act="tasktidy"/);
 }
 const t=s.projects[0].tasks[0];t.state='完了';const html=a.context.completionButtons(s.projects[0],t);
 assert.match(html,/data-act="taskcontinue"[^>]*>再開する<\/button><button class="btn plain sm" data-act="tasktidy" data-p="p" data-t="t"[^>]*>片付け…<\/button>/);
 const opened=[];a.context.showTidy=async(...args)=>opened.push(args);a.context.api=()=>assert.fail('片付けの入口は完了承認を送らない');
 await a.context.act({dataset:{act:'tasktidy',p:'p',t:'t'}});assert.deepEqual(opened,[['p','t']]);
 a.context.showTidy=async()=>{throw Error('preview failed');};let notice;a.context.toast=text=>notice=text;await a.context.act({dataset:{act:'tasktidy',p:'p',t:'t'}});assert.equal(notice,'preview failed');
});


test('通知：返事待ちと完了の名前・数を左と上でそろえる', () => {
  const a = app(), s = snapshot(), p = s.projects[0];
  p.tasks[0].completionPending = true; p.tasks[0].parent = '';
  s.unread = [{ project:'p', task:'gone' }];
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  vm.runInContext('open.add("p")',a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent, '返事待ち 0');
  assert.equal(a.element('#turn-done-n').textContent, '完了 1');
  const tree = a.element('#list').innerHTML;
  assert.match(tree, />完了 1</);
  assert.match(tree, />完了</);
  assert.doesNotMatch(tree, />未読/);
  assert.doesNotMatch(tree, />返事待ち/);
  assert.equal(a.context.taskLight(p,p.tasks[0],false,false).tip.includes('返事'),false);
  a.context.renderTurn([{p,t:p.tasks[0]}]);
  assert.match(a.element('#main').innerHTML, /返事待ち（0）/);
  assert.match(a.element('#main').innerHTML, /完了（1）/);
});

test('通知：質問と完了報告が重なったら返事待ちに一度だけ数える', () => {
  const a = app(), s = snapshot(), p = s.projects[0];
  p.tasks[0].completionPending = true; p.tasks[0].question = 'どちらにしますか？';
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 1');
  assert.equal(a.element('#turn-done-n').textContent,'完了 0');
  assert.match(a.element('#list').innerHTML, />返事待ち 1</);
  assert.doesNotMatch(a.element('#list').innerHTML, />完了/);
});

test('通知：未読だけの更新で木も再描画し、完了済みでも読む対象を残す', () => {
  const a = app(), s = snapshot('完了'), p = s.projects[0];
  p.tasks[0].parent = '';
  s.unread = [{project:'p',task:'t'}, {project:'p',task:'gone'}];
  vm.runInContext('state = ' + JSON.stringify(s) + '; open.add("p")', a.context);
  const before = a.context.treeKey();
  const html = a.context.projectNode(p,0);
  assert.match(html, />未読 1</);
  assert.match(a.context.projectNode(p,0), /data-t="t"[^>]*type="button"/);
  a.context.markRead('p','t');
  assert.notEqual(a.context.treeKey(),before);
  assert.doesNotMatch(a.context.projectNode(p,0), />未読/);
  assert.doesNotMatch(a.context.projectNode(p,0), /data-t="t"[^>]*type="button"/);
});

test('通知：正式上限停止を保持し、ターミナルの無出力を返事待ちに数えない', () => {
  const a = app(), s = snapshot('上限で停止');
  s.projects[0].tasks.push({...s.projects[0].tasks[0],id:'terminal',state:'実行中'});
  s.sessions = [{project:'p',task:'terminal',ai:'claude',running:true,quiet:61}];
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 1');
  assert.equal(a.element('#turn-done-n').textContent,'完了 0');
  assert.match(a.element('#list').innerHTML, />返事待ち 1</);
});


for (const locale of ['ja', 'zh-TW']) test('質問なし無出力：会話併存・長時間・再読込でも件数/木/あなたの番/状態札は返事を要求しない '+locale, () => {
  const a = app(), s = snapshot();
  a.context.UI = require('./ui-locale-fixture')(locale);
  for (const chat of [false, true]) for (const quiet of [0, 20, 59, 60, 3600, 86400]) {
    s.sessions = [{project:'p',task:'t',ai:'codex',running:true,quiet}];
    s.chatting = chat ? [{project:'p',task:'t',ai:'claude'}] : [];
    vm.runInContext('state='+JSON.stringify(s)+';view={kind:"turn"}',a.context);
    a.context.render();
    assert.equal(Boolean(vm.runInContext('REPLY(state.projects[0],state.projects[0].tasks[0])',a.context)),false);
    assert.equal(a.element('#turn-n').textContent,a.context.UI.template`返事待ち ${0}`);
    assert.equal(a.element('#turn-work-n').textContent,a.context.UI.template`作業中 ${1}`);
    assert.equal(a.element('#turn-done-n').textContent,a.context.UI.template`完了 ${0}`);
    assert.doesNotMatch(a.element('#main').innerHTML,/data-act="answered"/);
    assert.doesNotMatch(a.context.taskRow(s.projects[0],s.projects[0].tasks[0]),/入力待ち|輸入等待/);
    assert.match(a.context.statusText(s.sessions[0]),/pst busy/);
    assert.equal(a.context.taskLight(s.projects[0],s.projects[0].tasks[0],true).cls,'pl-work');
    assert.match(a.element('#list').innerHTML,/pl-work/);
    const key=a.context.treeKey();s.sessions[0].quiet++;
    vm.runInContext('state='+JSON.stringify(s),a.context);assert.equal(a.context.treeKey(),key);
  }
});
for (const locale of ['ja', 'zh-TW']) test('正式な質問・選択・承認・上限停止・完了確認は無出力や会話併存でも保持 '+locale, () => {
  const a=app();a.context.UI=require('./ui-locale-fixture')(locale);
  for(const extra of [{question:'選んでください'},{question:'承認してください'},{state:'返事待ち'},{state:'上限で停止'},{resultsPending:true},{completionPending:true}]){
    const s=snapshot('実行中',[{project:'p',task:'t',ai:'codex',running:true,quiet:3600}]);Object.assign(s.projects[0].tasks[0],extra);s.chatting=[{project:'p',task:'t',ai:'codex'}];
    vm.runInContext('state='+JSON.stringify(s)+';view={kind:"turn"}',a.context);a.context.render();
    const confirm=Boolean(extra.completionPending || extra.resultsPending);
    assert.equal(Boolean(vm.runInContext('REPLY(state.projects[0],state.projects[0].tasks[0])',a.context)),!confirm);
    assert.equal(Boolean(vm.runInContext('CONFIRM(state.projects[0],state.projects[0].tasks[0])',a.context)),false);
    assert.equal(a.element('#turn-n').textContent,a.context.UI.template`返事待ち ${confirm?0:1}`);
    if(extra.question)assert.equal(a.context.taskLight(s.projects[0],s.projects[0].tasks[0],true).cls,'wait');
    assert.equal(vm.runInContext('JSON.stringify(state)',a.context),JSON.stringify(s));
  }
});

test('通知：変化なしの定期取得でも返事待ち・完了の文字を保持する', async () => {
  const a = app(), s = snapshot();
  s.projects[0].tasks[0].completionPending = true;
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  let renders = 0;
  a.context.render = () => { renders++; };
  vm.runInContext('fetchState = async () => null', a.context);
  await a.context.pollState();
  assert.equal(renders, 0);
  assert.equal(a.element('#turn-n').textContent, '返事待ち 0');
  assert.equal(a.element('#turn-done-n').textContent, '完了 1');
  assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 0件、作業中 0件、成果確認 0件、完了 1件');
});

test('通知：設定・入力・詳しくを開いたまま定期取得しても3区分の件数と説明を更新する', async () => {
  for (const held of ['settings', 'input', 'details']) {
    const a = app(), first = snapshot();
    first.projects[0].tasks[0].completionPending = true;
    vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}', a.context);
    a.context.render();
    if (held === 'settings') vm.runInContext('view.kind = "settings"', a.context);
    if (held === 'input') a.document.activeElement = {tagName:'TEXTAREA'};
    if (held === 'details') a.details.push({open:true, classList:{contains:()=>false}});
    const main = a.element('#main').innerHTML;
    let renders = 0;
    a.context.render = () => { renders++; };
    const changed = snapshot();
    // 質問と完了報告が重なっても返事待ちにだけ数える。
    changed.projects[0].tasks[0].completionPending = true;
    changed.projects[0].tasks[0].question = 'どちらにしますか？';
    vm.runInContext('fetchState = async () => (' + JSON.stringify(changed) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#turn-n').textContent, '返事待ち 1', held);
    assert.equal(a.element('#turn-done-n').textContent, '完了 0', held);
    assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 1件、作業中 0件、成果確認 0件、完了 0件', held);
    vm.runInContext('fetchState = async () => (' + JSON.stringify(snapshot()) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#turn-n').textContent, '返事待ち 0', held);
    assert.equal(a.element('#turn-done-n').textContent, '完了 0', held);
    assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 0件、作業中 0件、成果確認 0件、完了 0件', held);
    assert.equal(renders, 0, held);
    assert.equal(a.element('#main').innerHTML, main, held);
  }
});

test('通知：稼働・順番待ち・成果整理と完了報告を3区分へ一度だけ数える', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0], base = p.tasks[0];
  p.tasks = [
    {...base, id:'reply', title:'返事', question:'選ぶ', completionPending:true, chatQueueCount:2},
    {...base, id:'terminal', title:'端末'}, {...base, id:'chat', title:'会話'},
    {...base, id:'queued', title:'順番', chatQueueCount:3},
    {...base, id:'results', title:'整理', resultsPending:{auto:'running'}},
    {...base, id:'background', title:'背景'}, {...base, id:'web', title:'自動Chat'},
    {...base, id:'done', title:'完了報告', completionPending:true},
    {...base, id:'blocked', title:'待ち停止', chatQueueCount:1, chatQueueBlocked:true},
    {...base, id:'approved', title:'承認済', state:'完了'}, {...base, id:'idle', title:'未稼働', state:'実行中'}
  ];
  s.sessions = [{project:'p',task:'terminal',ai:'codex',running:true,quiet:59}];
  s.chatting = [{project:'p',task:'chat',ai:'claude'}, {project:'p',task:'reply',ai:'codex'}];
  s.background = [{project:'p',task:'background'}, {project:'p',task:null}, {project:'other',task:'idle'}];
  s.webchat = {jobs:[{project:'p',task:'web',parent:'idle',state:'queued'}, {project:'p',task:'idle',state:'done'}]};
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"turn",project:"p"};open.add("p")',a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 2');
  assert.equal(a.element('#turn-work-n').textContent,'作業中 6');
  assert.equal(a.element('#turn-done-n').textContent,'完了 1');
  assert.match(a.element('#list').innerHTML,/>返事待ち 2<.*>作業中 6<.*>完了 1</s);
  const tabs = a.element('#main').innerHTML;
  assert.match(tabs,/data-turn-tab="reply".*返事待ち（2）.*data-turn-tab="work".*作業中（6）.*data-turn-tab="done".*完了（1）/s);
  assert.equal(a.context.taskLight(p,p.tasks[0],true,false).cls,'wait');
  for (const tab of ['work','done']) {
    vm.runInContext('turnTab='+JSON.stringify(tab)+';render()',a.context);
    const html=a.element('#main').innerHTML;
    assert.equal((html.match(/class="trow /g)||[]).length,tab==='work'?6:1);
    assert.doesNotMatch(html,/data-act="answered"/);
    if(tab==='work')assert.doesNotMatch(html,/data-act="taskcomplete"|data-act="taskcontinue"|data-act="resultsorganize"/);
    else assert.match(html,/data-act="taskcomplete".*data-act="taskcontinue"/s);
  }
  assert.deepEqual(p.tasks.map(t=>t.state),s.projects[0].tasks.map(t=>t.state));
  assert.equal(vm.runInContext('state.projects[0].tasks.find(t=>t.id==="done").state',a.context),'未着手');
});

test('停止保留表示：実行中の台帳と未処理指示を保持し一覧・作業・上部件数は保留を示す', () => {
  const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];
  Object.assign(t,{chatQueueCount:1,chatQueueHeld:true,chatQueueBlocked:true,completionPending:true});
  const original=JSON.stringify(t);
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"turn",project:"p"};open.add("p")',a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 1');
  assert.equal(a.element('#turn-work-n').textContent,'作業中 0');
  assert.equal(a.element('#turn-done-n').textContent,'完了 0');
  assert.match(a.element('#list').innerHTML,/notice-reply/);assert.doesNotMatch(a.element('#list').innerHTML,/notice-work|pl-work/);
  assert.match(a.element('#main').innerHTML,/停止保留/);assert.doesNotMatch(a.element('#main').innerHTML,/data-act="answered"|data-act="taskcomplete"/);
  assert.equal(a.context.taskLight(p,t,false).cls,'wait');assert.match(a.context.taskLight(p,t,false).tip,/保留/);
  assert.equal(vm.runInContext('WORKING(state.projects[0],state.projects[0].tasks[0])',a.context),false);
  vm.runInContext('view={kind:"work",project:"p",task:"t"};renderWork()',a.context);
  assert.match(a.element('#main').innerHTML,/停止前の指示は保留中です。自動では始まりません/);
  assert.match(a.context.completionButtons(p,t),/未処理の指示/);
  assert.doesNotMatch(a.context.completionButtons(p,t),/taskcomplete|taskcontinue/);
  assert.equal(vm.runInContext('JSON.stringify(state.projects[0].tasks[0])',a.context),original);
});

test('停止保留表示：実稼働との併存を隠さず返事優先の一分類を維持する',()=>{
  for(const activity of ['chatting','sessions','background','webchat','results']){
    const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];
    Object.assign(t,{chatQueueCount:2,chatQueueHeld:true,chatQueueBlocked:true});
    if(activity==='webchat')s.webchat={jobs:[{project:'p',task:'t',state:'tools'}]};
    else if(activity==='results')t.resultsPending={auto:'running'};
    else s[activity]=[{project:'p',task:'t',ai:'codex',running:true}];
    vm.runInContext('state='+JSON.stringify(s),a.context);a.context.updateTurnCounts();
    assert.equal(vm.runInContext('WORKING(state.projects[0],state.projects[0].tasks[0])',a.context),true,activity);
    assert.match(a.context.taskLight(p,t,true).tip,/作業中.*保留/);
    assert.equal(a.element('#turn-n').textContent,'返事待ち 1',activity);assert.equal(a.element('#turn-work-n').textContent,'作業中 0',activity);
    assert.match(a.context.taskRow(p,t,true,'reply'),/作業中・指示保留/);
  }
});

test('停止保留表示：通常順番待ち・エラー・上限は区別し解除だけでは旧指示を作業中にしない',async()=>{
  const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];
  for(const [fields,kind,working] of [
    [{chatQueueCount:1,chatQueueBlocked:false,chatQueueHeld:false},'work',true],
    [{chatQueueCount:1,chatQueueBlocked:true,chatQueueHeld:false},'reply',false],
    [{chatQueueCount:1,chatQueueBlocked:true,chatQueueHeld:false,state:'上限で停止'},'reply',false],
    [{chatQueueCount:1,chatQueueBlocked:true,chatQueueHeld:true},'reply',false],
    [{chatQueueCount:0,chatQueueBlocked:false,chatQueueHeld:false},'',false],
  ]){
    Object.assign(t,{state:'実行中'},fields);vm.runInContext('state='+JSON.stringify(s),a.context);
    assert.equal(vm.runInContext('notificationKind(state.projects[0],state.projects[0].tasks[0])',a.context),kind);
    assert.equal(vm.runInContext('WORKING(state.projects[0],state.projects[0].tasks[0])',a.context),working);
  }
  Object.assign(t,{chatQueueCount:1,chatQueueBlocked:true,chatQueueHeld:true});
  for(const stopControl of [{all:true,tasks:[]},{all:false,tasks:[]},{all:false,tasks:[{project:'p',task:'t',autoHeld:true}]}]){
    s.stopControl=stopControl;vm.runInContext('fetchState=async()=>('+JSON.stringify(s)+')',a.context);await a.context.pollState();
    assert.equal(a.element('#turn-work-n').textContent,'作業中 0');assert.equal(a.element('#turn-n').textContent,'返事待ち 1');
  }
});

test('通知：無出力は作業中を保持し、実質問・終了・完了報告へ移っても複数AIで重複しない', () => {
  const a=app(),s=snapshot('実行中'),t=s.projects[0].tasks[0];
  s.sessions=[{project:'p',task:'t',ai:'codex',running:true,quiet:59},{project:'p',task:'t',ai:'claude',running:true,quiet:0}];
  s.chatting=[{project:'p',task:'t',ai:'codex'}];t.completionPending=true;
  for (const [change,expected] of [
    ['', ['返事待ち 0','作業中 1','完了 0']],
    ['state.sessions[0].quiet=3600', ['返事待ち 0','作業中 1','完了 0']],
    ['state.projects[0].tasks[0].question="選んでください"', ['返事待ち 1','作業中 0','完了 0']],
    ['state.projects[0].tasks[0].question=""', ['返事待ち 0','作業中 1','完了 0']],
    ['state.sessions.forEach(s=>s.running=false);state.chatting=[]', ['返事待ち 0','作業中 0','完了 1']],
    ['state.projects[0].tasks[0].completionPending=false', ['返事待ち 0','作業中 0','完了 0']],
  ]) {
    if(!change)vm.runInContext('state='+JSON.stringify(s),a.context);
    else vm.runInContext(change,a.context);
    a.context.updateTurnCounts();
    assert.deepEqual(['#turn-n','#turn-work-n','#turn-done-n'].map(k=>a.element(k).textContent),expected);
  }
});

test('通知：入力保持中の定期取得でも作業中件数を更新し、背景と自動Chatだけの変更で再描画できる', async () => {
  const a=app(),s=snapshot('未着手');
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"turn",project:"p"}',a.context);a.context.render();
  const tree=a.context.treeKey(),main=a.context.mainKey(),html=a.element('#main').innerHTML;
  s.background=[{project:'p',task:'t'}];
  a.document.activeElement={tagName:'TEXTAREA'};
  vm.runInContext('fetchState=async()=>('+JSON.stringify(s)+')',a.context);await a.context.pollState();
  assert.equal(a.element('#turn-work-n').textContent,'作業中 1');
  assert.equal(a.element('#main').innerHTML,html);
  assert.notEqual(a.context.treeKey(),tree);assert.notEqual(a.context.mainKey(),main);
  const backgroundTree=a.context.treeKey();
  vm.runInContext('state.background=[];state.webchat={jobs:[{project:"p",task:"t",state:"tools"}]}',a.context);
  assert.notEqual(a.context.treeKey(),backgroundTree);
  a.document.activeElement=null;vm.runInContext('turnTab="work";render()',a.context);
  assert.match(a.element('#main').innerHTML,/task-status busy">作業中/);
});

test('long task steps have an explicit close control without changing steps or task state',()=>{
 const a=app(),p=project(),s=snapshot();p.tasks[0].steps=Array.from({length:80},(_,i)=>({text:'手順 '+i,done:false}));s.projects=[p];
 vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};stepsOpen=true',a.context);
 a.context.render();assert.match(a.element('#main').innerHTML,/data-steps-close/);
 const details={open:true};a.events.get('click')({target:{closest:selector=>selector==='[data-steps-close]'?{closest:()=>details}:null}});
 assert.equal(details.open,false);assert.equal(vm.runInContext('stepsOpen',a.context),false);
 assert.equal(vm.runInContext('state.projects[0].tasks[0].state',a.context),'実行中');assert.equal(vm.runInContext('state.projects[0].tasks[0].steps.filter(s=>s.done).length',a.context),0);
});

test('質問の一括回答は選択モデルへ1回送信し、会話欄の別の下書きと画像を保つ', async () => {
  const a=app(),s=snapshot();s.roles.models.codex=['GPT-6.1-Sol'];let answerSend,request;
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};chatBusy=null',a.context);
  a.context.bindAskAnswers=(_box,send)=>{answerSend=send;};
  a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='高';a.element('#chat-in').value='別の依頼';
  a.context.chatImages('p','t').push(attached());a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  a.context.api=async (route,body)=>{request={route,body};return {queued:true,queue:1};};
  assert.equal(await answerSend('価格：400円\n\n返金：条件付き'),true);
  assert.equal(request.route,'/api/chat/send');assert.equal(request.body.text,'価格：400円\n\n返金：条件付き');assert.equal(request.body.model,'GPT-6.1-Sol');
  assert.equal(a.element('#chat-in').value,'別の依頼');assert.equal(a.context.chatImages('p','t').length,1);
  a.context.api=async()=>{throw Error('通信失敗');};assert.equal(await answerSend('もう一度'),false);assert.equal(a.element('#chat-in').value,'別の依頼');
});

test('稼働中の質問回答は同じ作業の順番待ちへ送り、使えないモデルなら送らない',async()=>{
  const a=app(),s=snapshot();let send,calls=0,body;
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};chatBusy={ai:"codex"}',a.context);
  a.context.bindAskAnswers=(_box,cb)=>{send=cb;};a.element('#chat-ai').value='claude-code|Fable 5.1';a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  a.context.api=async(_r,b)=>{calls++;body=b;return {queued:true,queue:1};};
  assert.equal(await send('自由回答'),true);assert.equal(body.mode,'queue');assert.equal(body.project,'p');assert.equal(body.task,'t');
  a.element('#chat-ai').selectedOptions=[{disabled:true}];assert.equal(await send('自由回答'),false);assert.equal(calls,1);
});

test('操作案内で存在すると伝える作業ボタンは実際の作業画面にあり、質問中は完了操作を出さない', () => {
  const { guidance } = require('../lib/guidance');
  for (const extra of [
    { completionPending: true }, {}, { question: '判断を待つ', completionPending: true },
    { state: '完了' }, { copy: true }, { copy: true, mergeExcluded: true }, { copyMissing: true },
  ]) {
    const a = app(), s = snapshot(), p = s.projects[0], t = Object.assign(p.tasks[0], extra);
    vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    const html = a.element('#main').innerHTML;
    const buttons = [...html.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(x => x[1]);
    const text = guidance(p, t, t);
    for (const line of text.split('\n').filter(line => /^(作業の完了|取り込み)：/.test(line) && line.includes('がある'))) {
      for (const [, label] of line.split('作業一覧')[0].matchAll(/［([^］]+)］/g)) assert.ok(buttons.includes(label), `${JSON.stringify(extra)}: ${label}`);
    }
    const completion = a.context.completionButtons(p, t);
    const line = text.split('\n').find(x => x.startsWith('作業の完了：'));
    for (const label of ['完了に移す', 'まだ続ける', '再開する']) {
      assert.equal(line.includes(`［${label}］`), completion.includes(`>${label}</button>`), `${JSON.stringify(extra)}: ${label}`);
    }
  }
});

test('フェーズ案内のボタンは途中・最終・継続・報告ありの画面条件と一致する', () => {
  const { guidance } = require('../lib/guidance');
  for (const variant of ['途中', '最終', '継続', '未完', '報告', '全フェーズ完了']) {
    const a = app(), p = project(), t = p.tasks[0];
    p.phases = [{ name: '調査', state: '進行中' }, { name: '執筆', state: '未着手' }];
    t.state = '完了'; t.phase = '調査';
    if (variant === '最終') p.phases.pop();
    if (variant === '継続') p.phaseContinueKey = p.phaseOfferKey = 'same';
    if (variant === '未完' || variant === '報告') t.state = '実行中';
    if (variant === '報告') p.phases[0].completionPending = true;
    if (variant === '全フェーズ完了') p.phases.forEach(ph => ph.state = '完了');
    const html = a.context.phaseRoad(p, a.context.phaseInfo(p));
    const line = guidance(p, t).split('\n').find(x => x.startsWith('フェーズ：'));
    assert.equal(line.includes('がある'), html.includes('data-act="nextphase"'), variant);
    for (const [, label] of line.matchAll(/［([^］]+)］/g)) assert.ok(html.includes(`>${label}</button>`), variant + ': ' + label);
  }
});

test('上下の回答は同じ送信枠を使い、受付までの連打を1回にする',async()=>{
 const a=app(),s=snapshot('返事待ち');s.projects[0].tasks[0].question='選んでください';let lower,finish,calls=0;
 vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);a.context.bindAskAnswers=(_box,send)=>{lower=send;};a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='高';a.element('#chat-in').value='別の下書き';a.context.load=async()=>{};a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
 a.context.api=async(route,body)=>{calls++;assert.equal(route,'/api/chat/send');assert.equal(body.answerQuestion,'選んでください');return new Promise(resolve=>{finish=resolve;});};
 const notices=[];a.context.toast=x=>notices.push(x);a.elements.set('#msg-partial',{querySelector:s=>a.element('partial'+s),remove(){a.elements.delete('#msg-partial');}});
 const upper=vm.runInContext('sendWorkAnswer.send("上からの回答")',a.context);assert.equal(await lower('下からも押した'),false);assert.equal(calls,1);finish({answeredQuestion:'選んでください'});assert.equal(await upper,true,notices.join(" / "));assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(vm.runInContext('state.projects[0].tasks[0].question',a.context),'');
});

// 実サーバーが起動失敗時に配信する SSE と 409 を画面処理へ通す。
test('実spawn失敗のSSE後も上下から再操作でき、fake CLI修復後の再送は1回だけ受け付ける',async()=>{
 const os=require('node:os');
 const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-answer-r1-')),root=path.join(tmp,'root'),dir=path.join(root,'Product','p'),bin=path.join(tmp,'bin');
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.mkdirSync(bin);
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: p\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 const question='選んでください',taskFile=path.join(dir,'.ai/tasks/t.md');fs.writeFileSync(taskFile,`---\nid: t\ntitle: R1\nowner: codex\nmodel: GPT-6.1-Sol\nworkspaceMode: direct\nstate: 返事待ち\nquestion: ${question}\n---\n`);
 require('../lib/chat').append(dir,'t',{role:'assistant',ai:'codex',text:'回答を選んでください',asks:[{question,options:['A','B'],multi:false}]});
 const command=path.join(bin,'codex');fs.writeFileSync(command,'#!/nonexistent/r1-fixture-interpreter\n',{mode:0o755});
 const env={PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_TRASH:path.join(tmp,'trash')},previous={};for(const k of Object.keys(env)){previous[k]=process.env[k];process.env[k]=env[k];}
 const serverModule=require.resolve('../server');let server,reader,abort;const events=[];
 try{
  require.cache[serverModule]?.exports.stopControl.cleanExit();delete require.cache[serverModule];({server}=require('../server'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));process.env.HUB_PORT=String(port);require.cache[serverModule]?.exports.stopControl.cleanExit();delete require.cache[serverModule];({server}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`;
  const a=app(),s=snapshot('返事待ち');s.projects[0].tasks[0].question=question;vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);
  const asks=[{question,options:['A','B'],multi:false}],askKey=JSON.stringify(['p','t',asks]);const set=new Set(['ask']),status={textContent:''},option={disabled:false,value:'A'},free={disabled:false,value:'残す補足'},button={disabled:false,textContent:''};
  const ask={dataset:{askKey},classList:{contains:x=>set.has(x),add:(...xs)=>xs.forEach(x=>set.add(x)),toggle:(x,on)=>on?set.add(x):set.delete(x)},querySelector:s=>s==='.ask-status'?status:button,querySelectorAll:()=>[option,free,button]};
  const rows=[{id:'',contains:x=>x===ask}],box=a.element('#msgs');let historyVisible=true;
  box.querySelectorAll=sel=>sel==='.m'?rows:sel==='.ask'&&historyVisible?[ask]:[];
  Object.defineProperty(box,'innerHTML',{set(html){rows.length=0;historyVisible=html.includes('data-ask-key');if(historyVisible)rows.push({id:'',contains:x=>x===ask},{id:'',contains:()=>false});},get(){return '';}});
  box.insertAdjacentHTML=(_pos,html)=>{
   if(html.includes('class="m pending-question"')){historyVisible=true;ask.dataset.questionSource=/data-question-source="([^"]+)"/.exec(html)?.[1];rows.push({id:'',contains:x=>x===ask});}
   else if(html.includes('class="m '))rows.push({id:html.includes('id="msg-partial"')?'msg-partial':'',contains:()=>false});
  };
  a.document.querySelectorAll=sel=>sel==='.ask'?[ask]:[];a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='極高';a.element('#chat-in').value='別の下書き';
  a.context.chatImages('p','t').push(attached('r1-retained'));a.context.load=async()=>{};a.context.refreshTree=async()=>{};a.context.toast=()=>{};let lower;a.context.bindAskAnswers=(_box,send)=>{lower=send;};a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  const installPartial=()=>a.elements.set('#msg-partial',{querySelector:s=>a.element('partial'+s),insertAdjacentHTML:box.insertAdjacentHTML,remove(){a.elements.delete('#msg-partial');}});
  let calls=0,holdResponse;a.context.api=async(route,body)=>{calls++;const res=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(body)});const result=await res.json();if(holdResponse)await holdResponse;if(!res.ok)throw Error(result.error);return result;};
  abort=new AbortController();const response=await fetch(base+'/api/chat/stream?project=p&task=t',{signal:abort.signal});reader=response.body.getReader();
  let buffer='',idleResolve;const pump=(async()=>{while(true){const part=await reader.read();if(part.done)break;buffer+=Buffer.from(part.value).toString();let end;while((end=buffer.indexOf('\n\n'))!==-1){const chunk=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=chunk.split('\n').find(l=>l.startsWith('data:'));if(!data)continue;const ev=JSON.parse(data.slice(5));events.push(ev);if(ev.type==='rows')continue;if(ev.type==='busy')installPartial();a.stream().onmessage({data:JSON.stringify(ev)});if(ev.type==='idle')idleResolve?.();}}})();pump.catch(()=>{});
  const reenter=async()=>{
   // 実openChatの再入場：空DOMでcontrolsを更新してから、実serverの履歴rowsを受け取る。
   vm.runInContext('view.kind="project"',a.context);rows.length=0;historyVisible=false;
   vm.runInContext('view.kind="work"',a.context);a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
   const attempts=vm.runInContext('askAttempts',a.context);assert.equal(attempts.size,1,'初期rows待ちでは再送対象を消さない');
   const historyAbort=new AbortController(),historyResponse=await fetch(base+'/api/chat/stream?project=p&task=t',{signal:historyAbort.signal}),historyReader=historyResponse.body.getReader();
   try{let data='';while(!data.includes('\n\n')){const part=await historyReader.read();assert.equal(part.done,false);data+=Buffer.from(part.value).toString();}const line=data.split('\n').find(l=>l.startsWith('data:'));const history=JSON.parse(line.slice(5));assert.equal(history.type,'rows');a.stream().onmessage({data:JSON.stringify(history)});}finally{historyAbort.abort();await historyReader.cancel().catch(()=>{});}
  };
  for(const path of ['lower','upper']){
   installPartial();let release;holdResponse=new Promise(r=>release=r);const idle=new Promise(r=>idleResolve=r);const failed=path==='lower'?lower('A\n自由入力：残す補足'):vm.runInContext('sendWorkAnswer.send("上部回答")',a.context);
   await idle;await reenter();assert.equal(button.disabled,true,'再入場しても送信中のlockを保つ');release();assert.equal(await failed,false);holdResponse=null;assert.equal(set.has('done'),false);assert.equal(option.disabled,false);assert.equal(free.disabled,false);assert.equal(button.disabled,false);assert.equal(free.value,'残す補足');assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(a.element('#chat-effort').value,'極高');assert.equal(a.context.chatImages('p','t')[0].id,'r1-retained');
   // 409より後の遅いerror行と、同じ会話の再描画でも復活対象を保つ。
   a.stream().onmessage({data:JSON.stringify({type:'row',row:{role:'assistant',ai:'codex',error:'遅い起動失敗'}})});a.context.refreshAsks(box);assert.equal(button.disabled,false);
   await reenter();
   assert.equal(button.disabled,false);assert.equal(set.has('done'),false);assert.equal(free.value,'残す補足');assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(a.element('#chat-ai').value,'codex|GPT-6.1-Sol');assert.equal(a.element('#chat-effort').value,'極高');assert.equal(a.context.chatImages('p','t')[0].id,'r1-retained');
  }
  assert.ok(events.some(e=>e.type==='row'&&e.row.role==='user'));assert.ok(events.some(e=>e.type==='busy'));assert.ok(events.some(e=>e.type==='row'&&e.row.error));assert.ok(events.some(e=>e.type==='idle'));assert.match(fs.readFileSync(taskFile,'utf8'),/state: 返事待ち/);
  // fixtureの起動原因を直してから再送。上下の同時操作は1受付。
  fs.writeFileSync(command,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed'}));},2000));\n`,{mode:0o755});installPartial();const before=calls,pending=lower('A\n自由入力：残す補足');assert.equal(await vm.runInContext('sendWorkAnswer.send("二重回答")',a.context),false);assert.equal(await pending,true);assert.equal(calls,before+1);assert.match(fs.readFileSync(taskFile,'utf8'),/question: *\n/);
  // 成功済みは遅い失敗通知で戻らない。
  a.context.refreshAsks(box);assert.equal(button.disabled,true);
  await fetch(base+'/api/chat/stop',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'p',task:'t'})});
 }finally{abort?.abort();await reader?.cancel().catch(()=>{});if(server)await new Promise(r=>server.close(r));for(const k of Object.keys(env)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}}
});

test('GitHub creation appears only without any origin, and unavailable gh has a disabled button and reason', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify({ ...snapshot(), github: { ready: true } }), a.context);
  a.context.renderOverview(project()); assert.match(a.element('#main').innerHTML, /data-github-create="p"/);
  const linked = { ...project(), github: { url: 'https://github.com/u/r', branch: 'main' }, githubHasOrigin: true };
  a.context.renderOverview(linked); assert.match(a.element('#main').innerHTML, />GitHub<\/button>/); assert.doesNotMatch(a.element('#main').innerHTML, /data-github-create/);
  a.context.renderOverview({ ...project(), githubHasOrigin: true }); assert.doesNotMatch(a.element('#main').innerHTML, /data-github-create/);
  vm.runInContext('state.github = {ready:false,error:"ログインしてください"}', a.context);
  a.context.renderOverview(project()); assert.match(a.element('#main').innerHTML, /data-github-create="p"[^>]*disabled[^>]*title="ログインしてください"/);
});
test('settings keeps connections separate from ChatGPT login', () => {
  const a = app(); vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p"}', a.context);
  a.context.renderSettings(); const html = a.element('#main').innerHTML;
  assert.ok(html.indexOf('id="remote-box"') < html.indexOf('id="github-box"'));
  assert.doesNotMatch(html, /<h2>ChatGPT<\/h2>/);
  assert.match(html, /data-tab="ai"[^>]*><h2 class="pref-caption">AIの利用設定<\/h2>/);
  assert.match(a.element('#ai-accounts').innerHTML, /id="chatgpt-box"/);
});
const languageFixture = () => ({ active: 'ja', saved: 'ja', restartNeeded: false, fallback: false, version: '4.108.0', packs: [
  { id: 'zh-TW', name: '繁體中文 <img>', source: 'installed', verifiedWith: '4.107.1', usable: true, assets: {} },
  { id: 'fr-FR', name: 'French', source: 'installed', verifiedWith: '4.108.0', usable: false, reason: 'この版では選べない言語です', assets: {} },
] });
function languageApp() {
  const a = app(); a.context.fixture = snapshot(); a.context.languageFixture = languageFixture();
  vm.runInContext('state=fixture;view={kind:"settings"};languageSettings=languageFixture;renderSettings()', a.context);
  const click = a.documentListeners.find(row => row.cb.toString().includes("closest?.('[data-language]')")).cb;
  return { ...a, click: (action, id) => click({ target: { closest: () => ({ dataset: { language: action, packId: id } }) } }) };
}
test('language card shows Japanese standard, installed packs, version mismatch and escaped names', () => {
  const a = languageApp(), html = a.element('#main').innerHTML;
  assert.match(html, /<h3>言語<\/h3>/); assert.match(html, /value="ja" selected>日本語（標準）/);
  assert.match(html, /繁體中文 &lt;img&gt;/); assert.doesNotMatch(html, /繁體中文 <img>/);
  assert.match(html, /v4.107.1 で確認/); assert.match(html, /一部が日本語/);
  assert.match(html, /data-language="remove" data-pack-id="fr-FR"/);
  assert.doesNotMatch(html, /<option value="fr-FR"/); assert.match(html, /言語パックを追加…/);
});
test('language draft survives settings refresh; save persists the choice and explains restart/native menus', async () => {
  const a = languageApp(); a.element('#language-choice').value = 'zh-TW';
  const change = a.documentListeners.find(row => row.cb.toString().includes("event.target.id === 'language-choice'")).cb;
  change({ target: { id: 'language-choice', value: 'zh-TW' } });
  a.context.renderSettings(); assert.match(a.element('#main').innerHTML, /value="zh-TW" selected/);
  const calls = []; a.context.api = async (route, body) => { calls.push([route, body]); return { ...languageFixture(), saved: 'zh-TW', restartNeeded: true }; };
  await a.click('save'); assert.deepEqual(calls.map(([route, body]) => [route, JSON.parse(JSON.stringify(body))]), [['/api/language', { language: 'zh-TW' }]]);
  const html = a.element('#language-box').innerHTML;
  assert.match(html, /保存しました/); assert.match(html, /アプリを開き直した時/); assert.match(html, /今すぐ再起動/);
});
test('language import uses a folder picker and cancellation never submits an import', async () => {
  for (const chosen of ['', '/expanded pack']) {
    const a = languageApp(), calls = [];
    a.context.api = async (route, body) => { calls.push([route, body]); return route === '/api/pick-folder' ? { path: chosen } : languageFixture(); };
    await a.click('import'); assert.equal(calls[0][0], '/api/pick-folder'); assert.match(calls[0][1].prompt, /展開した言語パック/);
    assert.equal(calls.length, chosen ? 2 : 1);
    if (chosen) { assert.equal(calls[1][0], '/api/langpacks/import'); assert.equal(calls[1][1].dir, chosen); }
    assert.doesNotMatch(a.element('#language-box').innerHTML, /data-language="import" disabled/);
  }
});
test('language removal returns to Japanese; fallback and import errors are visible', async () => {
  const a = languageApp(); const calls = [];
  a.context.api = async (route, body) => { calls.push([route, body]); return { ...languageFixture(), packs: [], saved: 'ja' }; };
  await a.click('remove', 'zh-TW'); assert.equal(calls[0][0], '/api/langpacks/remove'); assert.equal(calls[0][1].id, 'zh-TW');
  assert.match(a.element('#language-box').innerHTML, /日本語（標準）/);
  a.context.api = async () => { throw Error('Invalid pack'); }; await a.click('save');
  assert.match(a.element('#language-box').innerHTML, /Invalid pack/);
  a.context.fixture = { ...languageFixture(), fallback: true };
  vm.runInContext('languageSettings=fixture;drawLanguageSettings()', a.context);
  assert.match(a.element('#language-box').innerHTML, /選んだ言語パックが読めないため/);
});
test('busy restart uses the existing endpoint and never stops AI or reloads', async () => {
  const a = languageApp(), calls = []; let reloads = 0;
  a.context.location.reload = () => reloads++;
  a.context.api = async route => { calls.push(route); const error = Error('AIの作業が終わるまで更新できません。'); error.status = 409; throw error; };
  await a.click('restart'); assert.deepEqual(calls, ['/api/restart']); assert.equal(reloads, 0);
  assert.match(a.element('#language-box').innerHTML, /AIの作業が終わるまで/);
});
test('language restart waits for the selected language to become active before reload', async () => {
  const a = languageApp(), calls = []; let reloads = 0, polls = 0;
  a.context.location.reload = () => reloads++;
  a.context.setTimeout = callback => { callback(); return 1; };
  a.context.api = async route => { calls.push(route); return route === '/api/restart' ? { ok: true } : { restartNeeded: ++polls < 2 }; };
  await a.click('restart'); assert.equal(reloads, 1);
  assert.deepEqual(calls, ['/api/restart', '/api/langpacks', '/api/langpacks']);
});
test('an older language load cannot overwrite a completed save; remote settings explain local-only access', async () => {
  const a = languageApp(); let finish;
  a.context.api = () => new Promise(resolve => { finish = resolve; });
  const old = a.context.loadLanguageSettings();
  a.element('#language-choice').value = 'zh-TW';
  a.context.api = async () => ({ ...languageFixture(), saved: 'zh-TW', restartNeeded: true });
  await a.click('save'); finish(languageFixture()); await old;
  assert.match(a.element('#language-box').innerHTML, /value="zh-TW" selected/);
  a.context.api = async () => { const error = Error('forbidden'); error.status = 403; throw error; };
  await a.context.loadLanguageSettings(); assert.match(a.element('#language-box').textContent, /このパソコンから/);
});

test('ChatGPT設定からログインと認可を撤去し、MCP許可と未保存の設定を保持する', () => {
 for (const ua of ['', 'ProjectHubApp/1']) {
  const a=app(ua);vm.runInContext('state='+JSON.stringify(snapshot())+';view={kind:"settings"};rolesDraft=[]',a.context);
  a.context.renderSettings();const html=a.element('#ai-accounts').innerHTML;
  assert.match(html,/<summary>MCP /);assert.match(html,/id="chatgpt-box"/);
  assert.doesNotMatch(html,/data-plan-action|chatgpt-plan-box|Web版ログイン|gpt-login-status|gpt\?login|Continue with ChatGPT/);
  assert.equal(a.context.location.href,'');assert.equal(a.context.window.hubGptLogin,undefined);
  assert.equal(vm.runInContext('rolesDraft.length',a.context),0);
 }
});

test('ChatGPT work permission ignores stale reads and preserves the saving choice on account redraw', async () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings"}', a.context);
  const reads = []; let finishSave;
  a.context.api = (route, body) => {
    assert.equal(route, '/api/chatgpt');
    if (body) { assert.equal(body.work, true); return new Promise(resolve => { finishSave = resolve; }); }
    return new Promise(resolve => reads.push(resolve));
  };
  const oldRead = a.context.loadChatgpt(), latestRead = a.context.loadChatgpt();
  reads[1]({work:false}); await latestRead;
  reads[0]({work:true}); await oldRead;
  assert.doesNotMatch(a.element('#chatgpt-box').innerHTML, /checked/);
  const checkbox = a.element('#chatgpt-work'); checkbox.id = 'chatgpt-work'; checkbox.checked = true;
  const change = a.documentListeners.find(x => x.name === 'change' && x.cb.toString().includes("e.target.id !== 'chatgpt-work'"));
  const saving = change.cb({target:checkbox}); assert.equal(checkbox.disabled, true);
  a.context.drawAccountSettings();
  const redrawRead = a.context.loadChatgpt();
  reads[2]({work:false}); reads[3]({work:false}); await redrawRead;
  assert.match(a.element('#chatgpt-box').innerHTML, /checked disabled/);
  finishSave({work:true}); await saving;
  const savedRead = a.context.loadChatgpt();
  reads[4]({work:true}); reads[5]({work:true}); await savedRead;
  assert.match(a.element('#chatgpt-box').innerHTML, /checked/);
  assert.doesNotMatch(a.element('#chatgpt-box').innerHTML, /disabled|chatgpt-register|config.toml/);
});

for (const [before, after] of [
  [{ready:false,error:'GitHubのログインを確認中です'}, {ready:true,error:''}],
  [{ready:true,error:''}, {ready:false,error:'ログインしてください'}],
  [{ready:false,error:'確認中'}, {ready:false,error:'ghがありません'}],
]) test(`GitHub readiness/error poll updates the rendered creation button: ${before.error || 'ready'} -> ${after.error || 'ready'}`, async () => {
  const a = app(), first = {...snapshot(),github:before}, next = {...snapshot(),github:after};
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  const beforeHtml = a.element('#main').innerHTML;
  vm.runInContext('fetchState = async () => (' + JSON.stringify(next) + ')', a.context);
  await a.context.pollState();
  const html = a.element('#main').innerHTML;
  assert.notEqual(html, beforeHtml);
  const button = html.match(/<button[^>]*data-github-create="p"[^>]*>/)[0];
  assert.equal(button.includes('disabled'), !after.ready);
  assert.ok(button.includes(after.ready ? '非公開リポジトリを作る' : after.error));
});

test('GitHub polling updates only the status during input and preserves confirmation/settings drafts', async () => {
  const a = app(), first = {...snapshot(),github:{ready:false,error:'確認中'}};
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  a.document.activeElement = {tagName:'INPUT'};
  a.element('#github-name').value = 'typed-name'; a.element('#github-description').value = 'typed-description';
  a.element('#github-push').checked = true;
  const main = a.element('#main').innerHTML;
  for (const github of [{ready:true,error:''}, {ready:false,error:'ログイン切れ'}]) {
    vm.runInContext('fetchState = async () => (' + JSON.stringify({...snapshot(),github}) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#main').innerHTML, main);
    assert.equal(a.element('#github-create-status').innerHTML.includes('disabled'), !github.ready);
    assert.equal(a.element('#github-name').value, 'typed-name'); assert.equal(a.element('#github-description').value, 'typed-description');
    assert.equal(a.element('#github-push').checked, true);
  }
  vm.runInContext('view.kind = "settings"; renderSettings()', a.context);
  a.element('#github-account').value = 'second'; a.element('#github-owner').value = 'our-org';
  const settings = a.element('#main').innerHTML;
  vm.runInContext('fetchState = async () => (' + JSON.stringify({...snapshot(),github:{ready:true}}) + ')', a.context);
  await a.context.pollState();
  assert.equal(a.element('#main').innerHTML, settings);
  assert.equal(a.element('#github-account').value, 'second'); assert.equal(a.element('#github-owner').value, 'our-org');
});

test('初期AI設定カードの即保存・失敗戻し・入力優先・利用不可表示', async () => {
  const a = app(), data = snapshot(), calls = [], notices = [], storage = new Map();
  data.roles.models = { codex: ['GPT-6.1-Sol'], 'claude-code': ['Fable 5.1', 'Opus 5.5'] };
  data.efforts = ['中', '高', '極高'];
  data.hiddenModels = { 'claude-code': ['Fable 5.1'] };
  vm.runInContext('state = ' + JSON.stringify(data) + '; view.kind = "settings"', a.context);
  a.context.localStorage.getItem = key => storage.get(key) || null;
  a.context.localStorage.setItem = (key, value) => storage.set(key, value);
  a.context.toast = text => notices.push(text);
  a.context.api = async (route, body) => { calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { initialPick: body }; };
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /<section class="pref-section" data-tab="basic">(?:(?!<\/section>)[\s\S])*<h3>新しく始めるときのAI<\/h3>/);
  assert.match(html, /data-tab="ai"><h2 class="pref-caption">選ぶ欄に出すモデル/);
  const card = a.context.initialPickHtml();
  assert.doesNotMatch(card, /Agy|ChatGPT|discord/);
  const fresh = a.context.quickDraft(data.projects[0]); assert.equal(fresh.ai, 'codex');
  a.context.quickDraft({ id: 'typing' }).text = 'まだ保存していない指示';
  const explicit = a.context.quickDraft({ id: 'explicit' }); explicit.effort = '極高';
  storage.set('hub-start-saved', JSON.stringify({ ai: 'agy', model: 'Gemini 3.1 Pro (High)', effort: '高', text: '下書き', images: [] }));
  const saved = a.context.quickDraft({ id: 'saved' });
  const prior = a.context.quickDraft({ id: 'prior', startSpec: { ai: 'codex', model: 'Astra', effort: '極高' } });
  vm.runInContext('state.projects.push({id: "prior", startSpec: {ai: "codex", model: "Astra", effort: "極高"}})', a.context);
  await a.events.get('change')({ target: { dataset: { initial: 'ai' }, value: 'claude' } });
  const initialSaves = calls.filter(call => call.route === '/api/models/initial');
  assert.equal(initialSaves.length, 1);
  assert.deepEqual(initialSaves[0], { route: '/api/models/initial', body: { ai: 'claude', model: 'Opus 5.5', effort: '高' } });
  assert.equal(a.context.quickDraft(data.projects[0]).ai, 'claude');
  assert.equal(a.context.quickDraft({ id: 'typing' }).text, 'まだ保存していない指示');
  assert.equal(a.context.quickDraft({ id: 'saved' }), saved);
  assert.equal(a.context.quickDraft({ id: 'explicit' }), explicit);
  // startSpecのある実プロジェクトはキャッシュを保持する。
  data.projects.push({ id: 'prior', startSpec: { ai: 'codex', model: 'Astra', effort: '極高' } });
  vm.runInContext('state.projects.push(' + JSON.stringify(data.projects.at(-1)) + ')', a.context);
  await a.events.get('change')({ target: { dataset: { initial: 'effort' }, value: '中' } });
  assert.equal(a.context.quickDraft(data.projects.at(-1)), prior);
  assert.equal(vm.runInContext("initialPick()", a.context).effort, '中');
  const before = JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context)));
  let release; a.context.api = () => new Promise((resolve, reject) => { release = () => reject(Error('見本の保存失敗')); });
  const saving = a.context.saveInitialPick({ ...before, effort: '極高' });
  assert.match(a.element('#initial-pick').innerHTML, /data-initial="ai"[^>]*disabled/);
  await a.context.saveInitialPick({ ...before, effort: '高' }); // 多重保存なし
  release(); await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context))), before);
  assert.match(notices.at(-1), /見本の保存失敗/);
  vm.runInContext('state.initialPick.model = "<lost>"', a.context);
  assert.match(a.context.initialPickHtml(), /&lt;lost&gt;（利用不可）/);
  assert.match(a.context.initialPickHtml(), /selected disabled/);
  vm.runInContext('state.initialPick.model = "Opus 5.5"; state.initialPickError = "現在の候補から外れています"', a.context);
  assert.match(a.context.initialPickHtml(), /Opus 5.5（利用不可）/);
  a.context.api = async (route, body) => ({ initialPick: body });
  await a.context.saveInitialPick({ ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context))), { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
});

test('子プロジェクトに分けて始める入口も共通の初期AIを使う', async () => {
  const a = app(), data = snapshot(), calls = [];
  data.initialPick = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  a.element('#split-lines').value = '子の名前｜最初の依頼';
  a.element('#split-lines').focus = () => {};
  a.context.api = async (route, body) => { calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { id: 'child-project' }; };
  a.context.load = async () => {};
  a.context.splitProject(data.projects[0]);
  await a.element('#split-go').onclick();
  assert.equal(calls[0].body.parent, 'p');
  assert.deepEqual(calls[1], { route: '/api/start', body: { project: 'child-project', text: '最初の依頼', ...data.initialPick, images: [] } });
});

test('スマホAI一覧は指定の短い名前、PCは従来名、表示名変更は選択/役割を保持', () => {
  const a = app(), s = snapshot();
  s.roles.models = { 'claude-code': ['Opus 5.5', 'Fable 5.1'], codex: ['GPT-6.1-Sol', 'GPT-6-Astra'], agy: ['Gemini 3.1 Pro (High)'] };
  s.projects[0].tasks[0].model = 'GPT-6.1-Sol'; s.agyAvailable = true;
  vm.runInContext('state=' + JSON.stringify(s), a.context);
  a.context.matchMedia = () => ({ matches: true });
  const html = () => a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  const option = (markup, value) => markup.match(new RegExp('<option value="' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([^<]*)</option>'))[1];
  let h = html();
  for (const [key, text] of [['claude|Opus 5.5', 'Opus 5.5'], ['codex|GPT-6.1-Sol', '6.1-Sol'], ['agy|Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (High)'], ...(a.context.window.HubPaidWebchat ? [['chatgpt|auto', 'Chat／Pro']] : [])]) assert.equal(option(h, key), text);
  assert.match(h, /value="codex\|GPT-6.1-Sol"[^>]*selected/);
  const before = vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(state.projects[0],state.projects[0].tasks[0])])', a.context);
  vm.runInContext('state.phoneLabels={labels:"short",names:{"codex|GPT-6.1-Sol":"私のソル","chatgpt|auto":"貼る <文>"}}', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), '私のソル'); if(a.context.window.HubPaidWebchat)assert.equal(option(html(), 'chatgpt|auto'), '貼る &lt;文&gt;');else assert.doesNotMatch(html(),/value="chatgpt\|auto"/);
  a.context.matchMedia = () => ({ matches: false });
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), 'Codex・GPT-6.1-Sol');
  if(a.context.window.HubPaidWebchat)assert.equal(option(html(), 'chatgpt|auto'), 'ChatGPT（Chat／Pro）');
  a.context.matchMedia = () => ({ matches: true }); vm.runInContext('state.phoneLabels.labels="full"', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), 'Codex・GPT-6.1-Sol');
  assert.equal(vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(state.projects[0],state.projects[0].tasks[0])])', a.context), before);
  vm.runInContext('state.phoneLabels.labels="short";state.cliFlags.codex={"GPT-6.1-Sol":""}', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), '私のソル（既定）');
  s.projects[0].tasks[0].model = 'GPT-lost'; vm.runInContext('state.projects[0].tasks[0].model="GPT-lost"', a.context);
  assert.equal(option(html(), 'codex|GPT-lost'), 'lost（利用不可。選び直してください）');
});

test('スマホ設定カードの保存/失敗と遅いpoll、他端末更新も入力を作り直さない', async () => {
  const a = app(), s = snapshot(), calls = [];
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  let release; const hold = new Promise(r => { release = r; });
  a.context.api = async (route, spec) => { calls.push({ route, spec: JSON.parse(JSON.stringify(spec)) }); await hold; return { phoneLabels: { labels: 'full', names: {} } }; };
  const saving = a.context.savePhoneLabels({ labels: 'full' });
  assert.match(a.element('#phone-labels').innerHTML, /保存中/);
  assert.equal(calls.length, 1);
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: {} } });
  await a.context.refreshTree(); await a.context.pollState();
  assert.equal(vm.runInContext('phoneLabelsSaving', a.context), true);
  release(); await saving;
  assert.equal(vm.runInContext('state.phoneLabels.labels', a.context), 'full');
  assert.match(a.element('#phone-labels').innerHTML, /data-phone-name="codex\|GPT-6.1-Sol"[^>]*disabled/);
  a.context.api = async () => { throw Error('見本の保存失敗'); };
  await a.context.savePhoneLabels({ labels: 'short' });
  assert.equal(vm.runInContext('state.phoneLabels.labels', a.context), 'full'); assert.match(a.element('#phone-labels').innerHTML, /見本の保存失敗/);
  // 設定を入力中に別の端末から更新されても、編集中のカードを描き直さない。
  const input = {}; a.document.activeElement = input; a.element('#phone-labels').contains = el => el === input;
  const previousHtml = a.element('#phone-labels').innerHTML;
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': 'ソル' } } });
  await a.context.pollState(); assert.equal(a.element('#phone-labels').innerHTML, previousHtml);
  a.document.activeElement = null; await a.context.pollState(); assert.match(a.element('#phone-labels').innerHTML, /value="ソル"/);
  // 会話の定期更新ではoptionの文字だけを変え、入力・選択・思考を維持。
  const option = { value: 'codex|GPT-6.1-Sol', dataset: { full: 'Codex・GPT-6.1-Sol', short: '6.1-Sol', phoneSuffix: '' }, textContent: '6.1-Sol' };
  a.element('#chat-ai').options = [option]; a.element('#chat-ai').value = option.value;
  a.element('#chat-in').value = '書きかけ'; a.element('#chat-effort').value = '極高'; a.context.matchMedia = () => ({ matches: true });
  vm.runInContext('view={kind:"work",project:"p",task:"t"};renderedMainKey=mainKey()', a.context);
  let renders = 0; a.context.render = () => { renders++; }; a.context.renderTree = () => {};
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '速いソル' } } });
  await a.context.pollState(); assert.equal(option.textContent, '速いソル'); assert.equal(renders, 0);
  assert.equal(a.element('#chat-ai').value, option.value); assert.equal(a.element('#chat-in').value, '書きかけ'); assert.equal(a.element('#chat-effort').value, '極高');
});

// 保存のたびにカードを置換していないことと、移動先のフォーカスを検証するDOM。
function phoneCard(a, s) {
  const box = a.element('#phone-labels'), keys = a.context.phoneLabelKeys();
  const inputs = keys.map(key => ({ dataset: { phoneName: key }, value: s.phoneLabels.names[key] || '', disabled: false }));
  const radios = ['short', 'full'].map(mode => ({ dataset: { phoneMode: mode }, checked: mode === s.phoneLabels.labels, disabled: false }));
  const status = { textContent: '' }; let replacements = 0;
  Object.defineProperty(box, 'innerHTML', { get: () => '', set() { replacements++; } });
  box.querySelectorAll = selector => selector === '[data-phone-name]' ? inputs : radios;
  box.querySelector = () => status;
  box.contains = el => [...inputs, ...radios].includes(el);
  return { inputs, radios, status, replacements: () => replacements };
}

test('名前保存中の欄移動・追加入力・連続保存でDOMと移動先フォーカスを保つ', async () => {
  const a = app(), s = snapshot(), calls = [], waits = [];
  const input = a.documentListeners.find(x => x.name === 'input' && x.cb.toString().includes('phoneLabelDrafts')).cb;
  s.roles.models = { codex: ['GPT-6.1-Sol','GPT-6-Astra'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [first, second] = card.inputs;
  let stored = JSON.parse(JSON.stringify(s.phoneLabels));
  a.context.api = (route, spec) => new Promise(resolve => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    waits.push(() => { stored.names[spec.key] = spec.name; resolve({ phoneLabels: JSON.parse(JSON.stringify(stored)) }); });
  });
  first.value = '保存する名前';
  const saving = a.context.savePhoneLabels({ key: first.dataset.phoneName, name: first.value });
  a.document.activeElement = second; second.value = '次の欄の入力';
  input({ target: second });
  await a.context.savePhoneLabels({ key: second.dataset.phoneName, name: second.value });
  // 保存途中で編集元にも追加入力した場合、古い応答で消してはいけない。
  a.document.activeElement = first; first.value = 'まだ未確定の追加入力'; input({ target: first });
  waits.shift()(); await new Promise(setImmediate);
  assert.equal(calls.length, 2); assert.equal(first.value, 'まだ未確定の追加入力');
  a.document.activeElement = second; waits.shift()(); await saving;
  assert.equal(a.document.activeElement, second); assert.equal(second.value, '次の欄の入力');
  assert.equal(first.value, 'まだ未確定の追加入力'); assert.equal(card.replacements(), 0);
  assert.ok(card.inputs.every(el => !el.disabled));
  assert.equal(vm.runInContext('state.phoneLabels.names["codex|GPT-6-Astra"]', a.context), '次の欄の入力');
});

test('名前保存中のradioを順に保存し、失敗しても入力を残して自動再試行しない', async () => {
  const a = app(), s = snapshot(), calls = [];
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), first = card.inputs[0];
  let release; const hold = new Promise(resolve => { release = resolve; });
  a.context.api = async (_route, spec) => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    if (spec.key) { await hold; throw Error('保存不可'); }
    return { phoneLabels: { labels: spec.labels, names: {} } };
  };
  first.value = '失敗した名前'; const saving = a.context.savePhoneLabels({ key: first.dataset.phoneName, name: first.value });
  a.document.activeElement = card.radios[1]; await a.context.savePhoneLabels({ labels: 'full' });
  assert.equal(card.radios[1].checked, true); assert.ok(card.radios.every(el => !el.disabled));
  release(); await saving;
  assert.deepEqual(calls, [{ key: 'codex|GPT-6.1-Sol', name: '失敗した名前' }, { labels: 'full' }]);
  assert.equal(a.document.activeElement, card.radios[1]); assert.equal(first.value, '失敗した名前');
  assert.equal(card.replacements(), 0); assert.ok(card.inputs.every(el => el.disabled));
  a.context.api = async () => { throw Error('mode保存不可'); };
  await a.context.savePhoneLabels({ labels: 'short' });
  assert.match(card.status.textContent, /mode保存不可/); assert.equal(card.radios[1].checked, true);
  assert.equal(first.value, '失敗した名前');
  // 外部から別名が届いても保存失敗した入力は保持する。
  a.document.activeElement = null;
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '外部名' } } });
  await a.context.pollState(); assert.equal(first.value, '失敗した名前'); assert.equal(calls.length, 2);
});

for (const next of ['name', 'mode']) test(`名前の保存失敗を後続の${next === 'name' ? '別名' : 'mode'}成功で消さず、該当名の修正成功で解除する`, async () => {
  const a = app(), s = snapshot(), calls = [], notices = [];
  s.roles.models = { 'claude-code': ['Opus 5.5'], codex: ['GPT-6.1-Sol'] };
  s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [opus, sol] = card.inputs;
  let release, fail = true; const hold = new Promise(resolve => { release = resolve; });
  const stored = JSON.parse(JSON.stringify(s.phoneLabels));
  a.context.toast = message => notices.push(message);
  a.context.api = async (_route, spec) => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    if (spec.key === opus.dataset.phoneName && fail) { await hold; throw Error('名前を書き込めません'); }
    if (spec.key) stored.names[spec.key] = spec.name;
    else stored.labels = spec.labels;
    return { phoneLabels: JSON.parse(JSON.stringify(stored)) };
  };
  opus.value = '未保存のOpus名';
  const saving = a.context.savePhoneLabels({ key: opus.dataset.phoneName, name: opus.value });
  const target = next === 'name' ? sol : card.radios[1];
  a.document.activeElement = target;
  sol.value = next === 'name' ? '保存したSol名' : '';
  await a.context.savePhoneLabels(next === 'name' ? { key: sol.dataset.phoneName, name: sol.value } : { labels: 'full' });
  release(); await saving;
  for (const message of [card.status.textContent, notices.at(-1)]) {
    assert.match(message, /Opus 5\.5 の名前は未保存/);
    assert.match(message, /名前を書き込めません/);
    assert.doesNotMatch(message, /保存しました/);
  }
  assert.equal(calls.length, 2); assert.equal(stored.names[opus.dataset.phoneName], undefined);
  assert.equal(opus.value, '未保存のOpus名'); assert.equal(a.document.activeElement, target);
  assert.equal(card.replacements(), 0);
  if (next === 'name') assert.equal(stored.names[sol.dataset.phoneName], '保存したSol名');
  else {
    assert.equal(stored.labels, 'full');
    await a.context.savePhoneLabels({ labels: 'short' });
    assert.match(card.status.textContent, /名前を書き込めません/);
  }
  // 入力・pollだけでは再送/解除しない。利用者が該当項目を直して確定した時だけ保存する。
  fail = false; opus.value = '修正したOpus名'; a.document.activeElement = opus;
  a.events.get('input')({ target: opus });
  a.context.drawPhoneLabels();
  assert.match(card.status.textContent, /名前を書き込めません/);
  const beforeRetry = calls.length;
  await a.context.savePhoneLabels({ key: opus.dataset.phoneName, name: opus.value });
  assert.equal(calls.length, beforeRetry + 1); assert.equal(stored.names[opus.dataset.phoneName], opus.value);
  assert.equal(card.status.textContent, 'スマホの表示を保存しました');
  assert.equal(notices.at(-1), 'スマホの表示を保存しました');
  assert.equal(vm.runInContext('phoneLabelDrafts.size', a.context), 0);
  assert.equal(a.document.activeElement, opus); assert.equal(card.replacements(), 0);
});

test('複数項目の失敗は個別に解除し、mode失敗も無関係な名前成功で消さない', async () => {
  const a = app(), s = snapshot();
  s.roles.models = { codex: ['GPT-6.1-Sol','GPT-6-Astra'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [sol, astra] = card.inputs;
  a.context.api = async () => { throw Error('ディスクエラー'); };
  await a.context.savePhoneLabels({ key: sol.dataset.phoneName, name: 'ソル' });
  await a.context.savePhoneLabels({ key: astra.dataset.phoneName, name: 'アストラ' });
  await a.context.savePhoneLabels({ labels: 'full' });
  assert.match(card.status.textContent, /6\.1-Sol の名前は未保存/);
  assert.match(card.status.textContent, /Astra の名前は未保存/);
  assert.match(card.status.textContent, /表示方法は未保存/);
  const stored = JSON.parse(JSON.stringify(s.phoneLabels));
  let release; const hold = new Promise(resolve => { release = resolve; });
  a.context.api = async (_route, spec) => {
    await hold;
    if (spec.key) stored.names[spec.key] = spec.name; else stored.labels = spec.labels;
    return { phoneLabels: JSON.parse(JSON.stringify(stored)) };
  };
  const saving = a.context.savePhoneLabels({ key: sol.dataset.phoneName, name: '修正ソル' });
  assert.match(card.status.textContent, /保存中.*6\.1-Sol の名前は未保存/);
  release(); await saving;
  assert.doesNotMatch(card.status.textContent, /6\.1-Sol の名前は未保存/);
  assert.match(card.status.textContent, /Astra の名前は未保存/);
  assert.match(card.status.textContent, /表示方法は未保存/);
  await a.context.savePhoneLabels({ labels: 'full' });
  assert.doesNotMatch(card.status.textContent, /表示方法は未保存/);
  assert.match(card.status.textContent, /Astra の名前は未保存/);
  await a.context.savePhoneLabels({ labels: 'short' });
  await a.context.savePhoneLabels({ key: astra.dataset.phoneName, name: '修正アストラ' });
  assert.equal(card.status.textContent, 'スマホの表示を保存しました');
});

test('通知refreshTree先行と304/null後も表示名を同期し、blur後も会話DOMを保つ', async () => {
  const a = app(), s = snapshot();
  s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"work",project:"p",task:"t"};renderedMainKey=mainKey()', a.context);
  const option = { value: 'codex|GPT-6.1-Sol', dataset: { full: 'Codex・GPT-6.1-Sol', short: '6.1-Sol' }, textContent: '6.1-Sol' };
  const select = a.element('#chat-ai'), input = a.element('#chat-in');
  select.options = [option]; select.value = option.value; input.value = '通知中も下書き'; input.tagName = 'TEXTAREA';
  a.document.activeElement = input; a.context.matchMedia = () => ({ matches: true });
  let renders = 0; a.context.render = () => { renders++; }; a.context.renderTree = () => {};
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '通知で届いた名' } } });
  await a.context.refreshTree(); assert.equal(option.textContent, '通知で届いた名');
  // DOMの古い表示もstateの前後差に依存せず修復できる。
  option.textContent = '古い表示'; a.context.fetchState = async () => null;
  await a.context.pollState(); assert.equal(option.textContent, '通知で届いた名');
  a.document.activeElement = null; await a.context.pollState();
  assert.equal(renders, 0); assert.equal(a.element('#chat-ai'), select); assert.equal(a.element('#chat-in'), input);
  assert.equal(input.value, '通知中も下書き'); assert.equal(select.value, option.value);
  a.context.matchMedia = () => ({ matches: false }); await a.context.pollState(); assert.equal(option.textContent, 'Codex・GPT-6.1-Sol');
});

test('役割AIは追加アカウントを含むログイン状態で制限し、Geminiのモデル選択とChatGPT行を表示する', () => {
  const a = app(), data = snapshot(); data.agyAvailable = true;
  data.roles.models = {codex:['GPT-6.1-Sol'], 'claude-code':['Opus 5.5'], agy:['Gemini 3.1 Pro (High)']};
  data.roles.roles = [{name:'調査',main:{ai:'agy',model:'Gemini 3.1 Pro (High)',effort:'高'},backup:{ai:'codex',model:'GPT-6.1-Sol',effort:'MAX'}}];
  data.accounts = [{ai:'claude',id:'default',status:'logged-out',name:'既定'}, {ai:'claude',id:'named',status:'logged-in',name:'追加'}, {ai:'codex',id:'default',status:'api',name:'既定'}, {ai:'agy',id:'default',status:'logged-in',name:'既定'}];
  vm.runInContext('state='+JSON.stringify(data)+'; view={kind:"settings"}; accountAutoChecked=true',a.context);
  const options = a.context.roleAiOptions('codex');
  assert.match(options, /value="claude-code"\s+>Claude Code/);
  assert.match(options, /value="agy"\s+>Gemini/);
  assert.match(options, /value="codex" selected disabled/); assert.doesNotMatch(options, /ChatGPT/);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.doesNotMatch(html,/data-f="model" aria-label="モデル" disabled/); assert.match(html,/data-f="effort" aria-label="思考" hidden disabled/);
  const accounts = a.element('#ai-accounts').innerHTML; assert.match(accounts,/<summary>MCP /); assert.match(accounts,/キーチェーン/); assert.match(accounts,/value="agy" disabled/);
  vm.runInContext('state.agyAvailable=false; state.accounts[3].status="not-installed"',a.context);
  assert.match(a.context.roleAiOptions('agy'),/value="agy" selected disabled>Gemini（Agy CLI）（未導入）/);
});
test('認証用Terminalが開いたままでも再確認でログイン済みになり、未確認の理由を安全に表示する', async () => {
  const a = app(), data = snapshot(); data.agyAvailable = true;
  data.accounts = [{ai:'agy',id:'default',name:'既定',busy:true,authTerminal:true,status:'unknown',message:'確認できません <script>bad</script>'}];
  vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"}',a.context);
  const before = a.context.accountSettingsHtml();
  assert.match(before, /未確認[\s\S]*認証用Terminalを開いています/);
  assert.match(before, /確認できません &lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(before, /<script>bad/);
  assert.doesNotMatch(before, /・作業中／順番待ち/);
  a.context.api = async route => route === '/api/chatgpt' ? {work:false} : {accounts:[{...data.accounts[0],status:'logged-in',message:''}]};
  await a.context.checkRoleAccounts();
  const after = a.context.accountSettingsHtml();
  assert.match(after, /ログイン済み[\s\S]*認証用Terminalを開いています/); assert.doesNotMatch(after.split('<div class="account-row ai-chatgpt-row">')[0], /確認できません|bad/);
  assert.doesNotMatch(after, /data-account-action="login"/); assert.match(after, /data-account-action="logout"\s*>/);
  assert.match(a.context.roleAiOptions('agy'), /value="agy" selected\s+>Gemini/);
});

test('役割状態の自動確認は1回・再確認は共通結果を使い、編集中の値とDOMを保持する', async () => {
  const a = app(), data = snapshot(); data.agyAvailable = true;
  data.roles.roles = [{name:'調査',main:{ai:'codex',model:'draft',effort:'MAX'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+'; view={kind:"settings"}; rolesDraft=JSON.parse(JSON.stringify(state.roles.roles)); rolesDraft[0].main.model="unsaved"',a.context);
  const select = a.element('#role-test'); select.dataset={r:'0',k:'main',f:'ai'};select.value='codex';
  a.document.querySelectorAll = q => q === 'select[data-r][data-f="ai"]' ? [select] : [];
  let finish, calls=0;
  a.context.api = route => { assert.equal(route,'/api/accounts?status=1'); calls++; return new Promise(r=>finish=r); };
  const draft = vm.runInContext('JSON.stringify(rolesDraft)',a.context), main=a.element('#main'); main.innerHTML='kept DOM';
  a.context.selectSettingsTab('ai'); a.context.selectSettingsTab('basic'); a.context.selectSettingsTab('ai');
  assert.equal(calls,1); assert.match(a.element('#role-account-status').textContent,/確認中/);
  const pending = a.context.checkRoleAccounts(); assert.equal(calls,1);
  finish({accounts:[{ai:'agy',id:'default',name:'既定',status:'logged-in'}]}); await pending;
  assert.equal(vm.runInContext('JSON.stringify(rolesDraft)',a.context),draft); assert.equal(main.innerHTML,'kept DOM'); assert.equal(select.value,'codex');
  assert.match(select.innerHTML,/value="agy"\s+>Gemini/); assert.match(select.innerHTML,/value="codex" selected disabled/);
  assert.match(a.element('#role-account-status').textContent,/\d\d:\d\d に確認/);
  a.context.selectSettingsTab('basic'); a.context.selectSettingsTab('ai'); assert.equal(calls,1);
  a.context.api = async route=>{if(route === '/api/chatgpt') return {work:false}; calls++;throw Error('fixture failure');};
  await assert.rejects(a.context.checkRoleAccounts(), /fixture failure/); assert.equal(calls,2);
  a.context.selectSettingsTab('ai'); assert.equal(calls,2); assert.match(a.element('#role-account-status').textContent,/fixture failure/);
});
test('Geminiへ役割を切り替えてもモデルを自動選択せず高を保持する', async () => {
  const a=app(), data=snapshot();data.roles.models.agy=['Gemini 3.1 Pro (High)'];
  data.roles.roles=[{name:'調査',main:{ai:'codex',model:'old',effort:'Ultra'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+';rolesDraft=JSON.parse(JSON.stringify(state.roles.roles));render=()=>{}',a.context);
  await a.events.get('change')({target:{dataset:{r:'0',k:'main',f:'ai'},value:'agy'}});
  assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),''); assert.equal(vm.runInContext('rolesDraft[0].main.effort',a.context),'高');
});

for (const failure of ['HTTP 503', '通信拒否']) test(`アカウント確認の${failure}後も現DOMで再試行でき、busyと役割下書きを保持する`, async () => {
  const a=app(), data=snapshot();
  data.accounts=[{ai:'codex',id:'default',name:'既定',busy:true}];
  data.roles.roles=[{name:'調査',main:{ai:'codex',model:'unsaved',effort:'高'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"};rolesDraft=JSON.parse(JSON.stringify(state.roles.roles))',a.context);
  a.element('#account-new-ai').value='codex';
  const button={disabled:false,dataset:{accountAction:'status'},closest:()=>null};
  let reject; a.context.api=route=>route === '/api/chatgpt' ? Promise.resolve({work:false}) : new Promise((_,r)=>reject=r);
  const pending=a.context.operateAccount(button);
  a.context.drawAccountSettings(); // 操作中の画面交換
  assert.match(a.element('#ai-accounts').innerHTML,/data-account-action="status" disabled/);
  reject(Error(failure)); await pending;
  assert.doesNotMatch(a.element('#ai-accounts').innerHTML,/data-account-action="status" disabled/);
  assert.match(a.element('#ai-accounts').innerHTML,/data-account-action="login" disabled/); // busyは保持
  assert.equal(a.element('#account-message').textContent,failure);
  a.context.api=async()=>({accounts:data.accounts});
  await a.context.operateAccount(button);
  assert.equal(a.element('#account-message').textContent,'完了しました');
  assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),'unsaved');
});

test('Grok availability requires installed catalogue and a logged-in account; selections stay intact', () => {
 const a=app(), data=snapshot();data.grokAvailable=true;data.efforts=['中','高','極高','MAX','Ultra'];
 data.roles.models.grok=['grok-code-1'];data.accounts=[{ai:'grok',id:'default',name:'既定',status:'logged-out'},{ai:'grok',id:'one',name:'仕事',status:'logged-in'}];
 vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"};accountAutoChecked=true',a.context);
 assert.match(a.context.roleAiOptions('grok'),/value="grok" selected\s+>Grok/);assert.doesNotMatch(a.context.roleAiOptions('grok'),/ChatGPT/);
 assert.deepEqual(Array.from(vm.runInContext("effortsFor('grok')",a.context)),['中','高','極高','MAX']);
 vm.runInContext('state.grokAvailable=false',a.context);assert.match(a.context.roleAiOptions('grok'),/value="grok" selected disabled/);
 vm.runInContext('state.accounts.forEach(r=>r.status="not-installed")',a.context);
 const html=a.context.accountSettingsHtml();assert.match(html,/value="grok">Grok/);assert.match(html,/curl -fsSL https:\/\/x.ai\/cli\/install.sh/);
 assert.equal(a.context.ownerOf('grok').kind,'grok');
});

test('Grok role switch replaces unsupported Ultra and preserves other roles',async()=>{
 const a=app(),data=snapshot();data.efforts=['中','高','極高','MAX','Ultra'];data.roles.models.grok=['grok-code-1'];
 data.roles.roles=[{name:'調査',main:{ai:'codex',model:'old',effort:'Ultra'},backup:{ai:'人'}}];
 vm.runInContext('state='+JSON.stringify(data)+';rolesDraft=JSON.parse(JSON.stringify(state.roles.roles));render=()=>{}',a.context);
 await a.events.get('change')({target:{dataset:{r:'0',k:'main',f:'ai'},value:'grok'}});
 assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),'grok-code-1');assert.equal(vm.runInContext('rolesDraft[0].main.effort',a.context),'高');
 assert.equal(vm.runInContext('rolesDraft[0].backup.ai',a.context),'人');
});

test('Grok task chat/terminal account choices and buttons use Grok without changing initial AI',()=>{
 const a=app(),data=snapshot();data.grokAvailable=true;data.efforts=['高','Ultra'];data.roles.models.grok=['grok-code-1'];data.cliFlags.grok={'grok-code-1':'grok-code-1'};
 const p=data.projects[0],t=p.tasks[0];t.owner='grok';t.model='grok-code-1';t.effort='高';t.accounts={grok:'one'};
 data.accounts=[{ai:'grok',id:'default',name:'既定'},{ai:'grok',id:'one',name:'仕事'}];
 vm.runInContext('state='+JSON.stringify(data)+';view={kind:"work",project:"p",task:"t"}',a.context);
 const html=a.context.chatHtml(p,t);assert.match(html,/value="grok\|grok-code-1"/);assert.match(html,/data-task-account[^>]*data-ai="grok"/);
 assert.doesNotMatch(html.match(/id="chat-effort"[\s\S]*?<\/select>/)[0],/Ultra/);
 a.element('#chat-ai').value='grok|grok-code-1';a.context.drawChatAccount(p,t);assert.match(a.element('#chat-account-box').innerHTML,/selected[^>]*>仕事/);
 assert.doesNotMatch(a.context.initialPickHtml(),/Grok/);
});

test('成果整理は完了確認・完了ボタンを出さず、稼働中は作業中にだけ数える',()=>{
 const a=app();vm.runInContext(`state={projects:[],sessions:[],chatting:[],waiting:[]};`,a.context);
 for(const auto of ['running','failed','blocked','none']) {
  const t={id:'kid',title:'子',state:'実行中',steps:[{done:true,text:'完成'}],question:'',completionPending:false,resultsPending:{auto,reason:'書式を確認してください',detail:'理由'}};
  a.context.gateTask=t;a.context.gateProject={id:'P',name:'親',tasks:[t]};
  const html=vm.runInContext('completionButtons(gateProject,gateTask)',a.context);
  assert.doesNotMatch(html,/data-act="taskcomplete"|完了に移しますか/);
  if(auto==='running')assert.doesNotMatch(html,/成果の整理を頼む/);else assert.match(html,/成果の整理を頼む/);
  assert.equal(vm.runInContext('Boolean(NEEDS(gateTask))',a.context),auto!=='running');
  assert.equal(vm.runInContext('Boolean(REPLY(gateProject,gateTask))',a.context),false);
  const row=vm.runInContext('taskRow(gateProject,gateTask,false,"reply")',a.context);assert.match(row,auto==='running'?/成果整理中/:/成果確認/);assert.doesNotMatch(row,/完了確認|送らずに消す/);
  assert.equal(vm.runInContext('notificationKind(gateProject,gateTask)',a.context),auto==='running'?'work':'results');
 }
});

test('契約枠と手動候補を撤去し、自動Chat／ProとCodexのAstraを保持する',()=>{
 const a=app(),s=snapshot();s.roles.models.codex=['GPT-6.1-Sol','Astra'];vm.runInContext('state='+JSON.stringify(s),a.context);
 const p=s.projects[0],t=p.tasks[0];let html=a.context.chatHtml(p,t);
 assert.doesNotMatch(html,/value="chatgpt\|gpt-6-astra"|chat-plan-label|契約枠/);
 assert.doesNotMatch(html,/dot\|inbox/);
 assert.equal(html.includes('value="chatgpt|auto"'),Boolean(a.context.window.HubPaidWebchat));
 assert.ok(s.roles.models.codex.includes('Astra'));
 a.context.chatPick=()=>({ai:'chatgpt',model:'gpt-6-astra',effort:''});html=a.context.chatHtml(p,t);
 assert.match(html,/value="chatgpt\|gpt-6-astra"[^>]*selected disabled/);
 assert.match(html,/利用不可。選び直してください/);
 assert.doesNotMatch(html,/value="chatgpt\|chat"[^>]*selected/);
});

test('stale app warning appears at the top and in ChatGPT settings only inside the app', () => {
 for (const ua of ['', 'ProjectHubApp/1']) {
  const a = app(ua), s = snapshot(); s.appShell = { stale: true, appVersion: '4.53.3' };
  vm.runInContext('state='+JSON.stringify(s), a.context); a.context.drawShellAlerts(); const html = a.context.accountSettingsHtml();
  if (ua) { assert.match(html, /古い版 v4.53.3/); assert.match(a.element('#app-shell-alert').innerHTML, /data-shell-rebuild/); assert.equal(a.element('#app-shell-alert').hidden, false); }
  else { assert.doesNotMatch(html, /data-shell-rebuild/); assert.equal(a.element('#app-shell-alert').hidden, true); }
  s.appShell.stale = false; vm.runInContext('adoptState('+JSON.stringify(s)+')', a.context); assert.equal(a.element('#app-shell-alert').hidden, true);
 }
});
test('rebuild button disables duplicates and reports success or failure without restarting', async () => {
 for (const failed of [false, true]) {
  const a = app('ProjectHubApp/1'), s = snapshot(); s.appShell = { stale: true, appVersion: '4.53.3' }; vm.runInContext('state='+JSON.stringify(s), a.context);
  let finish, calls = 0, notice; a.context.toast = text => { notice = text; };
  a.context.api = route => { assert.equal(route, '/api/app/rebuild'); calls++; return new Promise((resolve, reject) => { finish = () => failed ? reject(Error('fixture failure')) : resolve({ ok: true }); }); };
  const handler = a.documentListeners.find(x => x.cb.toString().includes("closest('[data-shell-rebuild]')")).cb, event = { target: { closest: () => ({}) } };
  const pending = handler(event); assert.match(a.element('#app-shell-alert').innerHTML, /disabled/); await handler(event); assert.equal(calls, 1); finish(); await pending;
  assert.match(notice, failed ? /fixture failure/ : /終了して開き直して/); assert.equal(a.context.location.href, '');
  assert.match(a.element('#app-shell-alert').innerHTML, failed ? /data-shell-rebuild/ : /終了して開き直して/);
 }
});
test('廃止Dotは選択不可で、旧依頼は再送案内のない参照表示にする',async()=>{
  const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];t.owner='dot';
  vm.runInContext('state='+JSON.stringify(s),a.context);
  assert.match(a.context.chatHtml(p,t),/value="dot\|inbox"[^>]*disabled/);
  assert.doesNotMatch(source,/<option value="dot">|const DOT_SETUP/);
  const html=a.context.msgHtml({role:'user',to:'dot',request:'old',text:'<script>old</script>'});
  assert.match(html,/廃止・参照のみ/);assert.doesNotMatch(html,/data-copy|Hubの依頼|<script>/);
  a.context.api=async()=>({work:false});await a.context.loadChatgpt();
  const settings=a.element('#chatgpt-box').innerHTML;assert.match(settings,/id="chatgpt-work"/);assert.doesNotMatch(settings,/Dot|hub_dot_inbox|トンネル/);
});
test('旧Dot選択を残した画面からは送信せず、入力を保持する',async()=>{
  const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);
  a.element('#chat-ai').value='dot|inbox';a.element('#chat-in').value='残す依頼';a.element('#chat-effort').value='高';
  let send,calls=0;a.context.bindAskAnswers=(_box,cb)=>{send=cb;};a.context.toast=()=>{};
  a.context.api=async route=>{if(route.startsWith('/api/discussion?'))return {session:null,candidates:[],previous:null};calls++;throw Error('must not send');};
  a.context.openChat(p,t);assert.equal(await send(),false);assert.equal(calls,0);assert.equal(a.element('#chat-in').value,'残す依頼');
});

function queuedUI() {
 const a=app(),s=snapshot();vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);
 a.context.toast=m=>{a.lastToast=m;};a.element('#chat-in').value='composer draft';a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
 const el=a.element('#chat-queue'),input={dataset:{queueText:'q1'},value:'',selectionStart:0,selectionEnd:0,focus(){a.document.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
 el.querySelector=()=>input;a.input=input;
 a.queue=rows=>a.stream().onmessage({data:JSON.stringify({type:'queue',queue:rows})});
 a.click=d=>el.handlers.click({target:{closest:()=>({dataset:d})}});
 a.type=text=>{input.value=text;el.handlers.input({target:input});};
 return a;
}
const queuedItem={id:'q1',ai:'codex',model:'GPT-6.1-Sol',text:'queued\nline'};
test('停止保留表示：作業画面は解除前後とも未処理理由と同じ指示・モデル・添付を保つ',()=>{
 const a=queuedUI(),item={...queuedItem,stopHeld:true,images:[{id:'kept-image'}]},before=JSON.stringify(item);
 let calls=0;a.context.api=async()=>{calls++;throw Error('display must not send');};
 vm.runInContext('state.stopControl={all:true,tasks:[]}',a.context);a.queue([item]);
 assert.match(a.element('#chat-queue').innerHTML,/保留中.*復旧/);
 vm.runInContext('state.stopControl={all:false,tasks:[]}',a.context);a.queue([item]);
 assert.match(a.element('#chat-queue').innerHTML,/自動では始まりません/);
 assert.match(a.element('#chat-queue').innerHTML,/data-run="q1"/);
 assert.equal(a.element('#chat-in').value,'composer draft');assert.equal(JSON.stringify(item),before);assert.equal(calls,0);
});
test('queued editor keeps multiline draft and cursor through queue changes without touching composer',async()=>{
 const a=queuedUI();a.queue([queuedItem]);assert.match(a.element('#chat-queue').innerHTML,/data-qedit/);assert.doesNotMatch(a.element('#chat-queue').innerHTML,/data-qamend/);
 await a.click({qedit:'q1'});a.type('edited\n<script>literal</script>');a.input.selectionStart=4;a.input.selectionEnd=7;
 a.queue([queuedItem,{...queuedItem,id:'q2',text:'later'}]);assert.match(a.element('#chat-queue').innerHTML,/edited\n&lt;script&gt;literal&lt;\/script&gt;/);assert.equal(a.document.activeElement,a.input);assert.deepEqual([a.input.selectionStart,a.input.selectionEnd],[4,7]);assert.equal(a.element('#chat-in').value,'composer draft');
 a.queue([]);assert.equal(a.element('#chat-queue').hidden,false);assert.match(a.element('#chat-queue').innerHTML,/編集内容は残っています/);
});
test('queue save failures retain draft; save during further typing updates expected text without discarding later edits',async()=>{
 const a=queuedUI();a.queue([queuedItem]);await a.click({qedit:'q1'});a.type('first edit');
 a.context.api=async()=>{throw Error('save failed');};await a.click({qsave:'q1'});assert.match(a.element('#chat-queue').innerHTML,/first edit/);assert.equal(a.lastToast,'save failed');
 let finish,request;a.context.api=(route,body)=>{request={route,body};return new Promise(r=>finish=r);};
 const saving=a.click({qsave:'q1'});a.type('later edit');await a.click({qsave:'q1'});finish({queue:[{...queuedItem,text:'first edit'}]});await saving;
 assert.equal(request.route,'/api/chat/queue/edit');assert.equal(request.body.expectedText,queuedItem.text);assert.match(a.element('#chat-queue').innerHTML,/later edit/);
 a.context.api=async(route,body)=>{assert.equal(body.expectedText,'first edit');return {queue:[{...queuedItem,text:body.text}]};};await a.click({qsave:'q1'});assert.doesNotMatch(a.element('#chat-queue').innerHTML,/qeditor/);assert.match(a.element('#chat-queue').innerHTML,/later edit/);
});
test('queued amend sends selected ID once, retains failure and prevents sending unsaved edits',async()=>{
 const a=queuedUI();vm.runInContext('chatBusy={ai:"codex",model:"GPT-6.1-Sol"}',a.context);a.queue([queuedItem,{...queuedItem,id:'q2',text:'remaining'}]);assert.match(a.element('#chat-queue').innerHTML,/すぐ追加/);
 await a.click({qedit:'q1'});a.type('unsaved');let calls=0;a.context.api=async()=>{calls++;throw Error('launch failed');};await a.click({qamend:'q1'});assert.equal(calls,0);assert.match(a.lastToast,/保存してから/);
 await a.click({qclose:'q1'});await a.click({qamend:'q1'});assert.equal(calls,1);assert.match(a.element('#chat-queue').innerHTML,/queued/);
 let finish,request;a.context.api=(route,body)=>{calls++;request={route,body};return new Promise(r=>finish=r);};const sending=a.click({qamend:'q1'});await a.click({qamend:'q1'});assert.equal(calls,2);finish({ok:true});await sending;
 assert.equal(request.route,'/api/chat/send');assert.equal(request.body.fromQueue,'q1');assert.equal(request.body.mode,'amend');assert.equal(request.body.expectedText,queuedItem.text);assert.doesNotMatch(a.element('#chat-queue').innerHTML,/data-qamend="q1"/);assert.match(a.element('#chat-queue').innerHTML,/remaining/);assert.equal(a.element('#chat-in').value,'composer draft');
});

function historyUI() {
  const a = conversationApp(), ta = a.element('#chat-in');
  ta.selectionStart = ta.selectionEnd = 0;
  ta.setSelectionRange = (start,end) => { ta.selectionStart=start; ta.selectionEnd=end; };
  a.key = (key, extra = {}) => { const e = {key,preventDefault(){this.prevented=true;},...extra}; ta.handlers.keydown(e); return !!e.prevented; };
  a.type = text => { ta.value=text; ta.handlers.input(); };
  a.record = text => { a.context.historyText=text; vm.runInContext('instructionHistory.record(chatAttachmentKey("p","t"), historyText)',a.context); };
  return a;
}
test('composer arrows recall text directly and restore converted draft, cursor and file/image attachments', () => {
  const a=historyUI(), ta=a.element('#chat-in'); a.record('older'); a.record('last\nline');
  a.type('変換済み\n書きかけ'); ta.setSelectionRange(2,2);
  a.context.chatImages('p','t').push(attached()); a.context.appendChatPaths('p','t',['/local/note.txt']);
  const before=JSON.stringify(a.context.chatImages('p','t'));
  assert.equal(a.key('ArrowUp'),true); assert.equal(ta.value,'last\nline');
  a.type('edited last'); assert.equal(a.key('ArrowUp'),true); assert.equal(ta.value,'older');
  assert.equal(a.key('ArrowDown'),true); assert.equal(ta.value,'edited last');
  assert.equal(a.key('ArrowDown'),true); assert.equal(ta.value,'変換済み\n書きかけ');
  assert.deepEqual([ta.selectionStart,ta.selectionEnd],[2,2]);
  assert.equal(JSON.stringify(a.context.chatImages('p','t')),before);
  assert.equal(a.key('ArrowDown'),false);
  a.element('#chat-images').handlers.click({target:{closest:()=>({dataset:{chatRemove:a.context.chatImages('p','t')[1].id}})}});
  assert.equal(a.context.chatImages('p','t').length,1);
});
test('composer keeps native arrows inside instructions and switches history only at the matching edge', () => {
  const a=historyUI(), ta=a.element('#chat-in'); a.record('old\nsecond\nlast');
  const draft='first\nmiddle\nlast'; a.type(draft); ta.setSelectionRange(8,8);
  for (const key of ['ArrowUp','ArrowDown']) { assert.equal(a.key(key),false); assert.equal(ta.value,draft); }
  ta.setSelectionRange(1,3); assert.equal(a.key('ArrowUp'),false);
  ta.setSelectionRange(1,1); assert.equal(a.key('ArrowDown'),false);
  assert.equal(a.key('ArrowUp'),true); assert.equal(ta.value,'old\nsecond\nlast');
  ta.setSelectionRange(5,5);
  assert.equal(a.key('ArrowUp'),false); assert.equal(a.key('ArrowDown'),false);
  ta.setSelectionRange(ta.value.length,ta.value.length);
  assert.equal(a.key('ArrowDown'),true); assert.equal(ta.value,draft);
  assert.deepEqual([ta.selectionStart,ta.selectionEnd],[1,1]);
  ta.setSelectionRange(draft.length,draft.length); assert.equal(a.key('ArrowUp'),false);
});
test('IME composition and modified arrow keys retain native behavior, including converted text at compositionend', () => {
  const a=historyUI(), ta=a.element('#chat-in'); a.record('previous'); a.type('かな');
  for (const extra of [{isComposing:true},{keyCode:229},{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true}]) assert.equal(a.key('ArrowUp',extra),false);
  ta.handlers.compositionstart(); assert.equal(a.key('ArrowUp'),false); assert.equal(ta.value,'かな');
  a.type('漢字'); ta.handlers.compositionend(); assert.equal(a.key('ArrowUp'),true); assert.equal(ta.value,'previous');
  a.key('ArrowDown'); assert.equal(ta.value,'漢字');
});
test('only accepted composer text enters history: failed send, image-only, answers, AI rows and queues are omitted', async () => {
  const a=historyUI(); a.type('not accepted'); a.context.api=async()=>{throw Error('send failed');};
  let send; a.context.bindAskAnswers=(_box,cb)=>{send=cb;};
  a.context.openChat(project(),project().tasks[0]);
  assert.equal(await send(),false); assert.equal(a.key('ArrowUp'),false);
  a.context.api=async()=>({ok:true,queued:true,queue:1}); a.context.load=async()=>{};
  a.type('  human\ninstruction  '); a.context.chatImages('p','t').push(attached()); assert.equal(await send(),true);
  assert.equal(await send('answer chosen from AI question'),true);
  a.type(''); a.context.chatImages('p','t').push(attached('image-only')); assert.equal(await send(),true);
  a.stream().onmessage({data:JSON.stringify({type:'row',row:{role:'user',text:'AI delegation'}})});
  a.stream().onmessage({data:JSON.stringify({type:'queue',queue:[{...queuedItem,text:'AI generated continuation'}]})});
  a.type('new draft'); assert.equal(a.key('ArrowUp'),true); assert.equal(a.element('#chat-in').value,'  human\ninstruction  ');
  a.key('ArrowUp'); assert.equal(a.element('#chat-in').value,'  human\ninstruction  ');
  assert.doesNotMatch(a.element('#chat-in').value,/\/local|AI|answer/);
});
test('history navigation survives a redraw and never discards a newer draft during an accepted send', async () => {
  const a=historyUI(); a.record('previous'); a.type('current'); a.key('ArrowUp');
  a.context.openChat(project(),project().tasks[0]); a.key('ArrowDown'); assert.equal(a.element('#chat-in').value,'current');
  let send,finish; a.context.bindAskAnswers=(_box,cb)=>{send=cb;}; a.context.openChat(project(),project().tasks[0]);
  a.context.api=()=>new Promise(r=>finish=r); a.context.load=async()=>{};
  const sending=send(); a.type('newer converted draft'); a.key('ArrowUp'); finish({ok:true,queued:true,queue:1});
  assert.equal(await sending,true); a.key('ArrowDown'); assert.equal(a.element('#chat-in').value,'newer converted draft');
});
test('send completion cannot erase a new draft when a recalled instruction exactly equals the pending sent text', async () => {
  const a=historyUI(); a.record('same sent text'); a.type('same sent text');
  let send,finish; a.context.bindAskAnswers=(_box,cb)=>{send=cb;}; a.context.openChat(project(),project().tasks[0]);
  a.context.api=()=>new Promise(r=>finish=r);
  const sending=send(); a.type('new converted draft'); a.key('ArrowUp');
  assert.equal(a.element('#chat-in').value,'same sent text'); finish({ok:true,queued:true,queue:1}); await sending;
  assert.equal(a.element('#chat-in').value,'same sent text'); a.key('ArrowDown'); assert.equal(a.element('#chat-in').value,'new converted draft');
});
test('file-only and mixed attachments preserve paths for CLI requests', async () => {
  const a=historyUI(); a.element('#chat-ai').value='codex|GPT-6.1-Sol'; a.context.appendChatPaths('p','t',['/local/note.txt']);
  a.context.chatImages('p','t').push(attached()); let send,request;
  a.context.bindAskAnswers=(_box,cb)=>{send=cb;}; a.context.openChat(project(),project().tasks[0]);
  a.context.api=async(_route,body)=>{request=body;return {ok:true,queued:true,queue:1};}; a.context.load=async()=>{};
  assert.equal(await send(),true); assert.match(request.text,/\/local\/note.txt\n\/local\/first.png/);
  assert.equal(request.images,undefined); assert.equal(a.context.chatImages('p','t').length,0);
  a.type('draft'); assert.equal(a.key('ArrowUp'),false,'file-only fallback is generated, so it is not human history');
});
test('retired manual/app choices reject before clipboard, request, history or draft changes', async () => {
  for(const model of ['chat','app']) {
    const a=historyUI(); a.element('#chat-ai').value='chatgpt|'+model; a.type('keep draft');
    a.context.appendChatPaths('p','t',['/local/note.txt']);
    let send; const notices=[]; a.context.bindAskAnswers=(_box,cb)=>{send=cb;};
    a.context.openChat(project(),project().tasks[0]);
    a.context.api=()=>assert.fail('retired route must not call API');
    a.context.copyText=()=>assert.fail('retired route must not copy');
    a.context.toast=text=>notices.push(text);
    assert.equal(await send(),false); assert.equal(a.element('#chat-in').value,'keep draft');
    assert.equal(a.context.chatImages('p','t').length,1);assert.equal(a.key('ArrowUp'),false);
    assert.match(notices.join(' '),/廃止された経路/);
  }
});

test('当日対象0件の後でもUI一括操作から新鮮な対象確認を要求し連打を防ぐ', async () => {
  const a = app(); a.context.fixture = snapshot(); let posts = 0, release;
  a.context.api = async route => { assert.equal(route, '/api/ai-tools/update-all'); posts++; await new Promise(r => release = r); return { results: [] }; };
  a.context.loadAiTools = async () => {}; a.context.refreshAiToolCatalog = async () => {};
  vm.runInContext('state=fixture;aiTools={codex:{installed:true,eligible:false,status:"logged-out"}};drawAiTools()', a.context);
  assert.doesNotMatch(a.element('#ai-tools').innerHTML, /data-ai-update-all disabled/);
  const pending = a.context.runAiUpdateAll(); await a.context.runAiUpdateAll(); assert.equal(posts, 1); release(); await pending;
});
test('上部UpdateはHub/CLI/両方/無しを保持状態で切り替え、busyでもクリック案内を返す', async () => {
  const a = app(); a.context.fixture = snapshot(); vm.runInContext('state=fixture', a.context);
  for (const [latest, cli, label] of [['2',false,'Update v2'], ['1',true,'Update AI CLI'], ['2',true,'Update v2 / AI CLI'], ['1',false,'']]) {
    a.context.latest = latest; a.context.cli = cli;
    vm.runInContext('state.latest=latest;state.aiCliUpdate={available:cli};showVersion("1",latest)', a.context);
    assert.equal(a.element('#upd').hidden, !label); if (label) assert.equal(a.element('#upd').textContent, label);
  }
  const notices = []; let requests = 0;
  a.context.toast = x => notices.push(x); a.context.api = async () => { requests++; }; a.context.render = () => {};
  for (const busy of ['state.updateBlocked=true', 'state.updateBlocked=false;state.aiCliUpdate.busyCount=1', 'state.aiCliUpdate.busyCount=0;state.chatting=[{}]', 'state.chatting=[];state.sessions=[{running:true}]']) {
    vm.runInContext('state.latest="2";state.aiCliUpdate.available=true;'+busy, a.context);
    await a.element('#upd').handlers.click(); assert.match(notices.at(-1), /CLIは/); assert.equal(requests, 0); assert.equal(a.element('#upd').disabled, false);
  }
  vm.runInContext('state.sessions=[];state.latest="2"', a.context); await a.context.openUpdate();
  assert.equal(vm.runInContext('view.kind', a.context), 'settings'); assert.equal(vm.runInContext('settingsTab', a.context), 'ai');
  assert.match(notices.at(-1), /Hubだけなら/); assert.equal(requests, 0);
  vm.runInContext('state.latest="1"', a.context); await a.context.openUpdate(); assert.match(notices.at(-1), /設定の/);
  let restarts = 0; a.context.restartHub = async () => restarts++;
  vm.runInContext('state.aiCliUpdate.available=false;state.latest="2"', a.context); await a.context.openUpdate(); assert.equal(restarts, 1);
});


for (const outcome of ['unsupported', 'failed', 'unexecuted']) test(`CLI一括が${outcome}でも両方表示から明示的なHub単独切替へ到達する`, async () => {
  const a = app(); a.context.fixture = snapshot(); let restarts = 0;
  a.context.restartHub = async () => restarts++;
  a.context.render = () => {};
  vm.runInContext('state=fixture;state.latest="2";state.aiCliUpdate={available:true};aiTools={codex:{eligible:true,installed:true,version:"0.1",updateCheck:{ok:true,available:true,applicable:true,latestVersion:"0.2"}}}', a.context);
  if (outcome !== 'unexecuted') {
    a.context.api = async () => ({ results: [{ai:'codex',state:outcome}] });
    a.context.loadAiTools = async () => {}; a.context.refreshAiToolCatalog = async () => {};
    await a.context.runAiUpdateAll();
  }
  await a.element('#upd').handlers.click(); assert.equal(restarts,0);
  a.context.drawAiTools(); assert.match(a.element('#ai-tools').innerHTML, /data-hub-update>Hub を v2 に切り替える/);
  const target = { closest: selector => selector === '[data-hub-update]' ? {} : null };
  for (const l of a.documentListeners.filter(l => l.name === 'click' && String(l.cb).includes('[data-hub-update]'))) await l.cb({target});
  assert.equal(restarts,1);
  vm.runInContext('state.updateBlocked=true',a.context);
  await a.context.switchHubUpdate(); assert.equal(restarts,2);
  assert.equal(a.element('#upd').disabled,false);
});
test('未対応CLIの保持取得は上部対象から除外するが行の更新先と未対応案内を保持する', async () => {
  const a = app(); a.context.fixture=snapshot(); vm.runInContext('state=fixture;state.latest="2"',a.context);
  for (const applicable of [false,undefined,true]) {
    a.context.api = async () => ({tools:{codex:{eligible:true,installed:true,version:'0.1',modelsStatus:'changed',updateCheck:{ok:true,available:true,applicable,latestVersion:'0.2'}}}});
    await a.context.loadAiTools();
    assert.equal(a.element('#upd').textContent,applicable?'Update v2 / AI CLI':'Update v2');
    assert.match(a.element('#ai-tools').innerHTML,/→ 0.2/);
    if(applicable===false) assert.match(a.element('#ai-tools').innerHTML,/この導入方法では、Hubから更新できません/);
  }
  a.context.api = async () => ({tools:{codex:{eligible:true,installed:true,modelsStatus:'changed',updateCheck:{ok:true,available:false,applicable:true}}}});
  await a.context.loadAiTools(); assert.equal(a.element('#upd').textContent,'Update v2');
  a.context.renderSettings(); assert.match(a.element('#main').innerHTML,/data-hub-update>Hub を v2 に切り替える/);
});

test('PCとスマホの旧Dot送信は依頼・添付・下書きを保持して拒否する',async()=>{
 for(const ua of ['', 'iPhone']){
  const a=app(ua),data=snapshot(),p=data.projects[0],t=p.tasks[0];
  vm.runInContext('state='+JSON.stringify(data)+';view={kind:"work",project:"p",task:"t"}',a.context);
  a.context.bindAskAnswers=(_b,fn)=>{a.send=fn;};a.context.toast=()=>{};
  a.context.api=()=>assert.fail('retired Dot request');a.context.window.open=()=>assert.fail('retired Dot window');
  a.element('#chat-ai').value='dot|inbox';a.element('#chat-in').value='保持する';a.context.chatImages('p','t').push({id:'keep',name:'image.png',path:'/image.png'});
  a.context.openChat(p,t);assert.equal(await a.send(),false);assert.equal(await a.send(),false);
  assert.equal(a.element('#chat-in').value,'保持する');assert.equal(a.context.chatImages('p','t').length,1);assert.equal(vm.runInContext('chatBusy',a.context),null);
 }
});

test('conversation rotation rejection and generation reset preserve an unsent draft',async()=>{
 const a=app(),p=project(),t=p.tasks[0];a.context.fixture=snapshot();vm.runInContext('state=fixture;view={kind:"work",project:"p",task:"t"};',a.context);
 a.context.openChat(p,t);const input=a.element('#chat-in');input.value='整理後に送る指示';input.handlers.input();a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='高';
 a.context.api=async()=>{throw Error('会話を整理中です');};await a.element('#composer').handlers.submit({preventDefault(){}});await new Promise(r=>setImmediate(r));
 assert.equal(input.value,'整理後に送る指示');assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]',a.context),'整理後に送る指示');
 a.context.load=async()=>{};a.stream().onmessage({data:JSON.stringify({type:'reset',generation:2})});assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]',a.context),'整理後に送る指示');assert.equal(a.context.HubChatGenerations.get('p\0t'),2);
});

test('Project chat links allow only parsed HTTP/HTTPS URLs and retain unsafe values as escaped text', () => {
  const a = app(); a.context.fixture = snapshot();
  const chats = [
    { title: 'Web <chat>', url: 'https://example.com/chat?a=1&b=2' },
    { title: 'HTTP', url: 'HTTP://example.com/room' },
    ...['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///tmp/chat', '//example.com/chat', 'https://', 'https://exa\tmple.com'].map(url => ({ title: '<blocked>', url })),
    { url: 'javascript:<script>alert(1)</script>' },
  ];
  a.context.fixture.projects[0].chats = chats;
  const stored = JSON.stringify(chats);
  vm.runInContext('state=fixture; renderOverview(state.projects[0]);', a.context);
  const html = a.element('#main').innerHTML;
  const card = html.split('<h3 class="sec">ブラウザのチャット</h3>')[1].split('</ul>')[0];
  assert.equal((card.match(/<a /g) || []).length, 2);
  assert.match(card, /href="https:\/\/example\.com\/chat\?a=1&amp;b=2"/);
  assert.match(card, /href="http:\/\/example\.com\/room"/);
  assert.match(card, /Web &lt;chat&gt;/);
  assert.match(card, /javascript:&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((card.match(/&lt;blocked&gt;/g) || []).length, 8);
  assert.doesNotMatch(card, /<script|href="(?:javascript|data|file):/i);
  assert.equal(JSON.stringify(a.context.fixture.projects[0].chats), stored);
});

test('ローカル画像MarkdownとCodex生成画像は端末共通の認証付きURLと開くリンクで表示する',()=>{
  for(const ua of ['', 'ProjectHubApp', 'iPhone']) {
    const a=app(ua);vm.runInContext('view={kind:"work",project:"freetalk",task:"topic"}',a.context);
    a.context.imagePath='/Users/test/空 白&名前.png';
    const html=vm.runInContext('msgHtml({role:"assistant",ai:"codex",text:"完了",generatedImages:[{path:imagePath,name:"画像"}]})',a.context);
    assert.match(html,/class="chat-image"/);assert.match(html,/data-path="\/Users\/test\/空 白&amp;名前.png"/);
    assert.ok(html.includes('/api/file/view?project=freetalk&amp;task=topic&amp;path='+encodeURIComponent(a.context.imagePath)));
    assert.doesNotMatch(html,/src="file:|src="data:/);
    const markdown=vm.runInContext('richText("![Gemini版](<file://"+imagePath+">)")',a.context);
    assert.match(markdown,/class="chat-image"/);assert.match(markdown,/alt="Gemini版"/);
    assert.doesNotMatch(vm.runInContext('richText("![外部](https://example.com/image.png)")',a.context),/<img/);
  }
});

test('受領済み保持子・照合中・未提出は統合を求めず、新成果と進行中だけ表示',()=>{
 const a=app(),s=snapshot(),kid={id:'kid',title:'保持した子',parent:'t',state:'完了',steps:[]};s.projects[0].tasks.push(kid);s.taskOffers=[{project:'p',task:'kid',targetProject:'p',targetTask:'t',pending:false,received:{id:'receipt'},receiptChecked:true}];
 a.context.fixture=s;vm.runInContext('state=fixture',a.context);const html=()=>vm.runInContext('kidsDoneBar(state.projects[0],state.projects[0].tasks[0])',a.context);
 assert.doesNotMatch(html(),/data-act="integrate"/);
 const offer=s.taskOffers[0];offer.pending=true;offer.receiptChecked=false;assert.doesNotMatch(html(),/data-act="integrate"/,'cold receipt check is not a new offer');
 offer.receiptChecked=true;assert.match(html(),/data-act="integrate"/,'verified changed receipt');
 offer.received=null;kid.state='実行中';kid.steps=[{done:false,text:'作業中'}];assert.doesNotMatch(html(),/data-act="integrate"/,'unfinished unsubmitted child');
 offer.handedUp=true;assert.match(html(),/data-act="integrate"/,'explicit partial handoff');
 offer.pending=false;assert.doesNotMatch(html(),/data-act="integrate"/,'received partial child');
 s.taskIntegrations=[{project:'p',task:'t',stage:'children',items:[{task:'kid'}]}];assert.match(html(),/data-act="integrate"/,'unfinished integration');
 s.taskIntegrations[0].stage='main';assert.doesNotMatch(html(),/data-act="integrate"/);
 s.taskHandoffs=[{project:'p',task:'kid',title:kid.title,targetProject:'p',targetTask:'t'}];assert.match(html(),/data-act="integrate"/,'unfinished receipt notification');
});
for(const locale of ['ja','zh-TW'])test('古い本体停止は新鮮な同一証拠だけ履歴にし、変更・再起動・期限・通信失敗で未確認へ戻す：'+locale,async()=>{
 const a=app(),s=snapshot(),old={id:'old',main:{state:'intent',sourceHead:'a'.repeat(40)},stopped:{reason:'本体取り込みの前提を確認できません'}};s.hubInstance='instance1';s.taskOffers=[];s.taskIntegrations=[{project:'p',task:'t',stage:'main',mainPending:old}];
 a.context.UI=require('./ui-locale-fixture')(locale);a.context.fixture=s;vm.runInContext('state=fixture;view={kind:"work",project:"p",task:"t"}',a.context);
 a.element('[data-main-preview]').remove=()=>{};
 let response={files:0,conflict:false,mainDisplay:{key:JSON.stringify(old),reflected:true}};a.context.api=async()=>response;
 const html=()=>vm.runInContext('kidsDoneBar(state.projects[0],state.projects[0].tasks[0])',a.context);
 await a.context.loadPreview('p','t');assert.match(html(),/data-integration-history/);assert.doesNotMatch(html(),/data-integration-main|data-act="integrate"/);assert.match(html(),locale==='ja'?/現在の本体に反映済み/:/已反映至目前本體/);
 if(locale==='ja'){assert.doesNotMatch(html(),/別の未保存変更/);response={files:0,conflict:false,mainDisplay:{key:JSON.stringify(old),reflected:true,mainUncommitted:3}};await a.context.loadPreview('p','t');assert.match(html(),/data-integration-history/);assert.doesNotMatch(html(),/data-integration-main/);assert.match(html(),/本体には別の未保存変更があります。この取り込み結果とは別です（3）/);response={files:0,conflict:false,mainDisplay:{key:JSON.stringify(old),reflected:true}};await a.context.loadPreview('p','t');}
 const original=JSON.stringify(old);old.stopped.reason='different';assert.match(html(),/data-integration-main/);old.stopped.reason='本体取り込みの前提を確認できません';assert.equal(JSON.stringify(old),original);
 s.hubInstance='instance2';assert.match(html(),/data-integration-main/);s.hubInstance='instance1';
 vm.runInContext('integrationMainEvidence.get("p\\0t").at-=30001',a.context);assert.match(html(),/data-integration-main/);
 await a.context.loadPreview('p','t');response=null;await a.context.loadPreview('p','t');assert.match(html(),/data-integration-main/);
 response={files:0,mainDisplay:{key:JSON.stringify(old),reflected:true}};await a.context.loadPreview('p','t');a.context.api=async()=>{throw Error('fixture disconnect');};await a.context.loadPreview('p','t');assert.match(html(),/data-integration-main/);
 // A delayed old proof cannot overwrite a newer negative proof.
 let release,n=0;a.context.api=()=>++n===1?new Promise(r=>release=r):Promise.resolve({files:0,mainDisplay:{key:JSON.stringify(old),reflected:false}});
 const first=a.context.loadPreview('p','t');await a.context.loadPreview('p','t');release(response);await first;assert.match(html(),/data-integration-main/);assert.equal(JSON.stringify(old),original);
});
test('子受領完了の帯は本体待ちだけを分離し、新しい候補がある場合だけ統合入口を表示',()=>{
 const a=app(),data=snapshot();data.taskIntegrations=[{project:'p',task:'t',stage:'main',items:[],mainPending:{id:'old',main:{state:'intent'},stopped:{reason:'本体取り込みの前提を確認できません'}}}];a.context.fixture=data;vm.runInContext('state=fixture',a.context);
 let html=vm.runInContext('kidsDoneBar(state.projects[0],state.projects[0].tasks[0])',a.context);assert.match(html,/data-integration-main/);assert.match(html,/結果が不明/);assert.doesNotMatch(html,/子作業の成果|data-act="integrate"/);
 data.projects[0].tasks.push({id:'new',title:'次の子',parent:'t',state:'完了',steps:[]});html=vm.runInContext('kidsDoneBar(state.projects[0],state.projects[0].tasks[0])',a.context);assert.match(html,/子作業の成果/);assert.match(html,/data-act="integrate"/);assert.match(html,/data-integration-main/);assert.doesNotMatch(html,/片付け済み/);
 data.taskIntegrations[0].stage='children';data.projects[0].tasks.pop();html=vm.runInContext('kidsDoneBar(state.projects[0],state.projects[0].tasks[0])',a.context);assert.match(html,/data-act="integrate"/);
});
test('完了子の入口を隠した後も新候補/受領完了を定期取得と通知で反映し、下書き・会話DOM・無再送を保つ',async()=>{
 const a=app(),s=snapshot();s.taskIntegrations=[{project:'p',task:'t',stage:'main',items:[],mainPending:{id:'old',main:{state:'intent'}}}];a.context.fixture=s;vm.runInContext('state=fixture;view={kind:"work",project:"p",task:"t"};renderedMainKey=mainKey();renderedTreeKey=treeKey()',a.context);
 const box=a.element('[data-kids-done]');let html='',writes=0;Object.defineProperty(box,'innerHTML',{get:()=>html,set:v=>{html=v;writes++;}});a.context.refreshKidsDoneBar();assert.doesNotMatch(html,/data-act="integrate"/);
 let renders=0,posts=0;a.context.render=()=>{renders++;};a.context.api=async()=>{posts++;return [];};a.element('#main').innerHTML='会話DOMを保持';const input=a.element('#chat-in');input.value='入力中の依頼';input.tagName='TEXTAREA';a.document.activeElement=input;
 const next=JSON.parse(JSON.stringify(s));next.projects[0].tasks.push({id:'new',title:'新しい子',parent:'t',state:'完了',steps:[]});a.context.fetchState=async()=>next;await a.context.pollState();assert.match(html,/data-act="integrate"/);assert.match(html,/data-integration-main/);
 const before=writes;a.context.fetchState=async()=>null;await a.context.pollState();assert.equal(writes,before);a.document.activeElement=null;
 a.context.fetchState=async()=>s;await a.context.refreshTree();assert.doesNotMatch(html,/data-act="integrate"/);assert.match(html,/data-integration-main/);assert.equal(renders,0);assert.equal(posts,0);assert.equal(input.value,'入力中の依頼');assert.equal(a.element('#main').innerHTML,'会話DOMを保持');
});

test('再起動の予約と取消は明示操作だけで送信し、待機理由を設定画面に表示する', async () => {
  const a=app(),calls=[];
  vm.runInContext('state.restartBusy=true',a.context);
  assert.match(a.context.restartControls(),/終了後に再起動を予約/);
  a.context.api=async(route,body)=>{calls.push([route,body]);return {restart:route.endsWith('/cancel')?{reserved:null}:{reserved:{at:'fixture'},waiting:[{message:'統合が進行中'}]}};};
  const click=a.documentListeners.find(x=>x.name==='click'&&x.cb.toString().includes('[data-restart-reserve],[data-restart-cancel]')).cb;
  await click({target:{closest:s=>s==='[data-restart-cancel]'?null:{}}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['/api/restart',{reserve:true}]]);
  assert.match(a.context.restartControls(),/再起動予約を取消/);assert.match(a.context.restartControls(),/統合が進行中/);
  assert.equal(calls.length,1);
  await click({target:{closest:()=>({})}});
  assert.equal(calls[1][0],'/api/restart/cancel');assert.doesNotMatch(a.context.restartControls(),/再起動予約を取消/);
  vm.runInContext('state.restart={committed:true}',a.context);assert.doesNotMatch(a.context.restartControls(),/data-restart-reserve|data-restart-cancel/);
});

function restartPollingApp(sessionStorage) {
  const a = app('', sessionStorage); let reloads = 0;
  a.context.location.reload = () => { reloads++; };
  a.context.fixture = { ...snapshot(), hubInstance: 'old', restart: { reserved: { at: 'fixture' }, committed: false } };
  vm.runInContext('state=fixture;view={kind:"settings"}', a.context);
  for (const name of ['syncWebchatSettingsControls', 'syncChatPhoneLabels', 'syncAccountPickers', 'drawPhoneLabels', 'drawModelOrder', 'syncRoleModelOrder', 'drawInitialPick', 'showVersion', 'updateTurnCounts', 'renderTree']) a.context[name] = () => {};
  a.context.treeKey = () => ''; a.context.window.HubMobile = { badges() {} };
  return { ...a, reloads: () => reloads };
}
test('予約再起動の新しい起動を検知し、同じ版・確定の見逃し・重複取得でも一度だけ再読込する', async () => {
  for (const seeCommit of [true, false]) {
    const a = restartPollingApp();
    const next = { ...a.context.fixture, hubInstance: 'new', restart: { reserved: null, committed: false } };
    const states = [...(seeCommit ? [{ ...a.context.fixture, restart: { committed: true } }] : []), next, next];
    a.context.fetchState = async () => states.shift();
    for (let i = 0; i < (seeCommit ? 3 : 2); i++) await a.context.pollState();
    assert.equal(a.reloads(), 1); a.context.observeRestart(next); assert.equal(a.reloads(), 1);
  }
  const a = restartPollingApp();
  a.context.fetchState = async () => ({ ...a.context.fixture, hubInstance: undefined, version: '2', restart: { reserved: null, committed: false } });
  await a.context.pollState(); assert.equal(a.reloads(), 1, '旧状態に起動識別子がなくても新版への変更を検知する');
});
test('予約取消と通常更新では入力を保ち、予約表示を見逃した新起動も検知する', async () => {
  const a = restartPollingApp(), ta = a.element('#chat-in'); ta.value = '入力途中';
  const states = [a.context.fixture, { ...a.context.fixture, restart: { reserved: null, committed: false } }, { ...a.context.fixture, hubInstance: 'new', restart: { reserved: null, committed: false } }];
  a.context.fetchState = async () => states.shift();
  for (let i = 0; i < 3; i++) await a.context.pollState();
  assert.equal(a.reloads(), 1); assert.equal(ta.value, '入力途中');
  a.context.observeRestart({ ...a.context.fixture, restart: { committed: true } }); assert.equal(a.reloads(), 1);
});
test('予約再起動の再読込をまたいで会話・待ち指示・質問・設定・freetalkの下書きを保持する', async () => {
  const rows = new Map(), storage = { getItem: k => rows.get(k) || null, setItem: (k,v) => rows.set(k,v), removeItem: k => rows.delete(k) };
  const a = restartPollingApp(storage);
  vm.runInContext('setChatDraft("draft", "送信前の本文");queueDrafts.set("draft",{id:"held",original:"元",text:"編集中"});askDrafts.set("draft",["選択途中"]);freetalkSummaryDrafts.set("topic","要約編集中");rolesDraft=[{name:"編集中"}]', a.context);
  vm.runInContext('quickDrafts.set("p",{ai:"claude",model:"Opus 5.5",effort:"高"});quickOverrides.add("p");chatFileSequence=3', a.context);
  a.context.fetchState = async () => ({ ...a.context.fixture, hubInstance: 'new', restart: {} });
  await a.context.pollState(); assert.equal(a.reloads(), 1); assert.ok(rows.has('hub-restart-drafts'));
  const b = app('', storage);
  assert.equal(vm.runInContext('chatDraft.draft', b.context), '送信前の本文');
  assert.equal(vm.runInContext('queueDrafts.get("draft").text', b.context), '編集中');
  assert.equal(vm.runInContext('askDrafts.get("draft")[0]', b.context), '選択途中');
  assert.equal(vm.runInContext('freetalkSummaryDrafts.get("topic")', b.context), '要約編集中');
  assert.equal(vm.runInContext('rolesDraft[0].name', b.context), '編集中'); assert.equal(rows.has('hub-restart-drafts'), false);
  b.context.drawSpecialMode = () => {}; b.context.syncSpecialModeChange();
  assert.equal(vm.runInContext('quickDrafts.get("p").model', b.context), 'Opus 5.5');
  assert.equal(vm.runInContext('chatFileSequence', b.context), 3);
});
test('下書きの保存失敗時は再読込を待ち、保存回復後に一度だけ実行する', async () => {
  const a = restartPollingApp({ setItem() { throw Error('quota'); } });
  vm.runInContext('setChatDraft("draft", "保持する入力")', a.context);
  const next = { ...a.context.fixture, hubInstance: 'new', restart: {} }; a.context.fetchState = async () => next;
  await a.context.pollState(); assert.equal(a.reloads(), 0); assert.equal(vm.runInContext('chatDraft.draft', a.context), '保持する入力');
  a.context.sessionStorage = { setItem() {} }; await a.context.pollState(); await a.context.pollState(); assert.equal(a.reloads(), 1);
});

test('freetalk要約完了から確認へ：保存intentから復元し移せる物だけ全選択、入力focusでも表示',async()=>{
 const a=freetalkConversation();let ready=false,preview=0;const h=()=>({generation:1,revision:'r',summaryId:'s',promotionRequested:true,reason:ready?'':'AIが作業中です',draft:ready?'要約':''});
 a.context.api=async route=>{if(route.includes('/status'))return h();if(route.endsWith('project-preview')){preview++;return {operationId:'o',revision:'r',summaryId:'s',name:'旅行',summary:'要約',files:[{path:'safe.txt',size:2},{path:'other',reason:'リンクを含む場所は移せません'},{path:'300MB',reason:'移すファイルが大きすぎます'}]};}throw Error(route);};
 const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 await sync();assert.equal(preview,0);assert.match(a.element('.freetalk-history').outerHTML,/要約を待っています/);
 ready=true;a.document.activeElement={tagName:'TEXTAREA'};await sync();const html=a.element('.freetalk-history').outerHTML;
 assert.match(html,/data-promotion-field="name"/);assert.doesNotMatch(html,/safe.txt" checked/);assert.match(html,/other" disabled/);assert.match(html,/300MB" disabled/);assert.doesNotMatch(html,/AIが作業中です|この要約で続ける/);assert.equal(preview,1);
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(freetalkPromotionDrafts.get("t").files)',a.context)),[]);
});
test('freetalk preview失敗は可視alertと再確認、status失敗を区別し無言で全ボタン無効にしない',async()=>{
 const a=freetalkConversation();let fail=true,calls=0;const h={generation:1,revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''};
 a.context.api=async route=>{if(route.includes('/status'))return h;if(route.endsWith('project-preview')){calls++;if(fail)throw Error('<b>確認準備失敗</b>');return {operationId:'o',revision:'r',summaryId:'s',summary:'要約',name:'名前',files:[]};}throw Error(route);};
 const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 await sync();await sync();assert.equal(calls,1,'修正前の自動再試行なし');let html=a.element('.freetalk-history').outerHTML;
 assert.match(html,/role="alert">&lt;b&gt;確認準備失敗/);assert.match(html,/freetalkretry/);assert.doesNotMatch(html,/要約を待っています|AIが作業中です/);
 fail=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.equal(calls,2);assert.match(a.element('.freetalk-history').outerHTML,/data-act="freetalkcreate"/);
 a.context.api=async()=>{throw Error('状態取得失敗');};await sync();html=a.element('.freetalk-history').outerHTML;assert.match(html,/role="alert">状態取得失敗/);assert.match(html,/もう一度確認/);
});
test('freetalk staleは要約し直し、作成失敗は入力保持と再確認、二重クリックは同操作1回で新プロジェクトへ',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''},fail=true,creates=0,finish;
 const d={operationId:'o',revision:'r',summaryId:'s',name:'元名前',summary:'要約',files:[]};
 a.context.api=async(route,body)=>{if(route.includes('/status'))return h;if(route.endsWith('project-preview'))return d;if(route.endsWith('/promote')){creates++;if(fail)throw Error('試験の作成失敗');return new Promise(r=>finish=r);}if(route.endsWith('/summary')){assert.equal(body.intent,'promote');h={...h,draft:'',stale:false,staleReason:'',summaryId:'new',reason:'AIが作業中です'};return {};}throw Error(route);};
 a.context.load=async()=>{};
 const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);await sync();
 vm.runInContext('freetalkPromotionDrafts.get("t").name="人の名前"',a.context);
 await a.context.act({dataset:{act:'freetalkcreate',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/試験の作成失敗/);assert.match(a.element('.freetalk-history').outerHTML,/value="人の名前"/);
 await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});fail=false;
 const one=a.context.act({dataset:{act:'freetalkcreate',t:'t'},disabled:false});await a.context.act({dataset:{act:'freetalkcreate',t:'t'},disabled:false});assert.equal(creates,2);
 finish({project:'新プロジェクト',task:'new'});await one;assert.equal(vm.runInContext('view.project',a.context),'新プロジェクト');
 vm.runInContext('view={kind:"work",project:"freetalk",task:"t"};freetalkPromotionDrafts.clear()',a.context);
 h={...h,stale:true,staleReason:'要約の後に会話が追加されました。要約し直してください'};await sync();assert.match(a.element('.freetalk-history').outerHTML,/freetalkresummary/);
 await a.context.act({dataset:{act:'freetalkresummary',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/要約を待っています/);
});
test('freetalk通常整理はpromote intentを送らず、確認欄なしで要約続行、取消はサーバーも解除',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''};const routes=[];
 a.context.load=async()=>{};a.context.api=async(route,body)=>{routes.push([route,body]);if(route.includes('/status'))return h;if(route.endsWith('promotion-intent')){assert.equal(body.requested,false);h={...h,promotionRequested:false};return h;}if(route.endsWith('/summary')){assert.equal(body.intent,undefined);h={...h,promotionRequested:false};return {};}throw Error(route);};
 await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/この要約で続ける/);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
 await a.context.act({dataset:{act:'freetalksummary',t:'t'},disabled:false});assert.equal(routes.at(-1)[0],'/api/freetalk/summary');
});
test('freetalk開始前のsummary/intent拒否は同期でも理由を保持し、再確認で開始し直せる',async()=>{
 for(const stage of ['summary','promotion-intent']) {
  const a=freetalkConversation();let fail=true,calls=0;
  let h={revision:'r',summaryId:'s',draft:stage==='summary'?'':'要約',promotionRequested:false,reason:''};
  a.context.api=async(route,body)=>{
   if(route.includes('/status'))return h;
   if(route.endsWith('/'+stage) && body.requested!==false){calls++;if(fail)throw Error(stage+'開始拒否');h={...h,promotionRequested:true};return h;}
   if(route.endsWith('project-preview'))return {operationId:'o',revision:'r',summaryId:'s',name:'名前',summary:'要約',files:[]};
   if(route.endsWith('promotion-intent') && body.requested===false){h={...h,promotionRequested:false};return h;}
   throw Error(route);
  };
  const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
  await a.context.act({dataset:{act:'freetalkpromote',t:'t'},disabled:false});await sync();
  assert.equal(calls,1,'同期は失敗した開始操作を自動再送しない');
  assert.match(a.element('.freetalk-history').outerHTML,new RegExp('role="alert">'+stage+'開始拒否'));
  fail=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.equal(calls,2,'statusだけでなく拒否された開始を再実行');
  assert.equal(h.promotionRequested,true);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/開始拒否/);
  await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
 }
 const a=freetalkConversation();a.context.api=async route=>{assert.match(route,/\/status\?/);return {promotionRequested:false,reason:''};};
 await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});
 assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/,'statusだけの再確認はプロジェクト化を開始しない');
});
test('freetalk status取得失敗中は編集と直接操作でも作成を拒否、取得回復まで無効を維持',async()=>{
 const a=freetalkConversation(),h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''};let statusFail=false,creates=0;
 a.context.api=async route=>{if(route.includes('/status')){if(statusFail)throw Error('状態取得失敗');return {...h};}if(route.endsWith('project-preview'))return {operationId:'o',revision:'r',summaryId:'s',name:'名前',summary:'要約',files:[{path:'safe.txt',size:2}]};if(route.endsWith('/promote'))creates++;else throw Error(route);};
 const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);await sync();statusFail=true;await sync();
 assert.match(a.element('.freetalk-history').outerHTML,/data-act="freetalkcreate"[^>]*disabled/);
 const create={dataset:{act:'freetalkcreate'},disabled:true},size={},block={dataset:{topic:'t'},querySelector:s=>s==='[data-act="freetalkcreate"]'?create:size};
 const input=a.documentListeners.find(x=>x.name==='input' && x.cb.toString().includes('data-promotion-size')).cb;
 for(const dataset of [{promotionField:'name'},{promotionField:'summary'},{promotionFile:'safe.txt'}]) {
  input({target:{closest:()=>block,dataset,value:'人の編集',checked:false}});assert.equal(create.disabled,true);
 }
 await a.context.act({dataset:{act:'freetalkcreate',t:'t'},disabled:false});assert.equal(creates,0,'状態未取得のまま直接操作も送信しない');
 const el=a.element('.freetalk-history');el.contains=()=>true;el.querySelectorAll=()=>[create];a.document.activeElement={tagName:'INPUT'};
 statusFail=false;await sync();assert.equal(create.disabled,false,'編集中の同期も状態回復後に同じ判定で解除');
 h.reason='AIが作業中です';await sync();assert.equal(create.disabled,true);input({target:{closest:()=>block,dataset:{promotionField:'name'},value:'保持する名前'}});assert.equal(create.disabled,true);
 h.reason='';await sync();assert.equal(create.disabled,false);assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'保持する名前');
});
for(const draft of ['', '通常整理の要約']) {
 test('freetalk状態確認だけの連続失敗→回復は開始意図を作らない（要約'+(draft?'あり':'なし')+'）',async()=>{
  const a=freetalkConversation();let fail=true;const starts=[];
  const h={revision:'r',summaryId:'s',draft,promotionRequested:false,reason:''};
  a.context.api=async(route,body)=>{if(route.includes('/status')){if(fail)throw Error('状態503');return h;}starts.push([route,body]);throw Error('未依頼の開始');};
  const sync=()=>vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
  await sync();
  for(let i=0;i<2;i++) {
   await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});
   assert.match(a.element('.freetalk-history').outerHTML,/role="alert">状態503/);
   assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
  }
  fail=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});
  assert.deepEqual(starts,[],'要約開始・intent保存を一度も依頼しない');assert.equal(h.promotionRequested,false);
  assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/状態503|class="freetalk-promotion"/);
  if(draft)assert.match(a.element('.freetalk-history').outerHTML,/この要約で続ける/);
 });
 test('freetalk明示開始の最初のstatus拒否は理由を保持し再確認で開始（要約'+(draft?'あり':'なし')+'）',async()=>{
  const a=freetalkConversation();let fail=true,h={revision:'r',summaryId:'s',draft,promotionRequested:false,reason:''};const starts=[];
  a.context.api=async(route,body)=>{
   if(route.includes('/status')){if(fail)throw Error('開始前の状態503');return h;}
   if(route.endsWith('/summary') || route.endsWith('promotion-intent')) {
    starts.push([route,body]);h={...h,draft:'要約',promotionRequested:body.requested!==false};return h;
   }
   if(route.endsWith('project-preview'))return {operationId:'o',revision:'r',summaryId:'s',name:'名前',summary:'要約',files:[]};
   throw Error(route);
  };
  await a.context.act({dataset:{act:'freetalkpromote',t:'t'},disabled:false});
  await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});
  assert.deepEqual(starts,[]);assert.match(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"[\s\S]*role="alert">開始前の状態503/);
  fail=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});
  assert.equal(starts.length,1);assert.equal(starts[0][0],draft?'/api/freetalk/promotion-intent':'/api/freetalk/summary');
  assert.equal(h.promotionRequested,true);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/開始前の状態503/);
  await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});
  assert.equal(h.promotionRequested,false);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
 });
}

for(const stage of ['summary','promotion-intent']) for(const outcome of ['reject','resolve']) {
 test('freetalk '+stage+'再試行→取消→旧'+outcome+'は確認も開始意図も復活させない',async()=>{
  const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:stage==='summary'?'':'通常要約',promotionRequested:false,reason:''},calls=0,finish;
  const act=action=>a.context.act({dataset:{act:action,t:'t'},disabled:false});
  a.context.api=async(route,body)=>{
   if(route.includes('/status'))return {...h};
   if(route.endsWith('promotion-intent') && body.requested===false){h={...h,promotionRequested:false};return {...h};}
   if(route.endsWith('/'+stage)){calls++;if(calls===1)throw Error('最初の開始拒否');const old={...h,promotionRequested:true};return new Promise((resolve,reject)=>finish=()=>outcome==='reject'?reject(Error('旧開始拒否')):resolve(old));}
   throw Error('取消後に追加通信：'+route);
  };
  await act('freetalkpromote');const retry=act('freetalkretry');await new Promise(r=>setImmediate(r));assert.equal(typeof finish,'function');
  await act('freetalkcancel');assert.equal(h.promotionRequested,false);
  finish();await retry;await act('freetalkretry');
  assert.equal(calls,2,'取消後の再確認は開始を再送しない');assert.equal(vm.runInContext('freetalkPromotionErrors.has("t") || freetalkPromotionDrafts.has("t")',a.context),false);
  assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"|旧開始拒否/);
  assert.equal(vm.runInContext('taskOf(proj("freetalk"),"t").freetalkHistory.promotionRequested',a.context),false);
 });
 test('freetalk '+stage+'の旧'+outcome+'は新しい開始の確認・編集を上書きしない',async()=>{
  const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:stage==='summary'?'':'通常要約',promotionRequested:false,reason:''},calls=0,finish;
  const act=action=>a.context.act({dataset:{act:action,t:'t'},disabled:false});
  a.context.api=async(route,body)=>{
   if(route.includes('/status'))return {...h};
   if(route.endsWith('/'+stage)){calls++;if(calls===1)throw Error('最初の拒否');if(calls===2)return new Promise((resolve,reject)=>finish=()=>outcome==='reject'?reject(Error('旧拒否')):resolve({...h,summaryId:'old'}));h={...h,draft:'新要約',summaryId:'new',promotionRequested:true};return {...h};}
   if(route.endsWith('project-preview'))return {operationId:'new',revision:'r',summaryId:'new',name:'新名前',summary:'新要約',files:[]};
   throw Error(route);
  };
  await act('freetalkpromote');const old=act('freetalkretry');await new Promise(r=>setImmediate(r));assert.equal(typeof finish,'function');
  await act('freetalkpromote');vm.runInContext('freetalkPromotionDrafts.get("t").name="人の新しい編集"',a.context);
  finish();await old;
  assert.equal(calls,3);assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'人の新しい編集');
  assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").summaryId',a.context),'new');assert.equal(vm.runInContext('freetalkPromotionErrors.has("t")',a.context),false);
  assert.equal(vm.runInContext('taskOf(proj("freetalk"),"t").freetalkHistory.summaryId',a.context),'new');
 });
}
for(const outcome of ['reject','resolve']) test('freetalk同期previewの旧'+outcome+'も取消後は確認・理由を復活させない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''},finish,previews=0;
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('promotion-intent')){assert.equal(body.requested,false);h={...h,promotionRequested:false};return h;}
  if(route.endsWith('project-preview')){previews++;return new Promise((resolve,reject)=>finish=()=>outcome==='reject'?reject(Error('旧preview拒否')):resolve({operationId:'old',revision:'r',summaryId:'s',name:'旧名前',summary:'要約',files:[]}));}
  throw Error(route);
 };
 const sync=vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);await new Promise(r=>setImmediate(r));
 await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});finish();await sync;
 assert.equal(previews,1);assert.equal(vm.runInContext('freetalkPromotionErrors.has("t") || freetalkPromotionDrafts.has("t")',a.context),false);
 assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"|旧preview拒否/);
});
test('freetalk遅い取消成功は取消中に行った新しい開始を消さない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''},finish;
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('promotion-intent')){if(body.requested===false){h={...h,promotionRequested:false};return new Promise(resolve=>finish=()=>resolve({...h,promotionRequested:false}));}h={...h,promotionRequested:true};return h;}
  if(route.endsWith('project-preview'))return {operationId:'new',revision:'r',summaryId:'s',name:'新名前',summary:'要約',files:[]};
  throw Error(route);
 };
 const cancel=a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});await new Promise(r=>setImmediate(r));
 await a.context.act({dataset:{act:'freetalkpromote',t:'t'},disabled:false});vm.runInContext('freetalkPromotionDrafts.get("t").name="新しい編集"',a.context);finish();await cancel;
 assert.equal(h.promotionRequested,true);assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'新しい編集');
});
test('freetalk取消拒否は理由と編集を保持し、再確認と取消の復旧ができる',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''},reject=true;
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('project-preview'))return {operationId:'o',revision:'r',summaryId:'s',name:'元名前',summary:'要約',files:[]};
  if(route.endsWith('promotion-intent')){assert.equal(body.requested,false);if(reject)throw Error('取消保存拒否');h={...h,promotionRequested:false};return h;}
  throw Error(route);
 };
 await vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 vm.runInContext('freetalkPromotionDrafts.get("t").name="保持する編集"',a.context);
 h={...h,stale:true,staleReason:'追加会話の古い要約'};
 await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/role="alert">取消保存拒否/);
 assert.match(a.element('.freetalk-history').outerHTML,/data-act="freetalkretry"/);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/data-act="freetalkresummary"/);
 assert.equal(h.promotionRequested,true);assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'保持する編集');
 await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/取消保存拒否/);
 assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'保持する編集');
 reject=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.equal(h.promotionRequested,false);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
});
test('freetalk開始前の取消失敗を再確認しても要約・開始intentを送らない',async()=>{
 const a=freetalkConversation();let reject=true,cancels=0;
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {promotionRequested:false,reason:''};
  assert.equal(route,'/api/freetalk/promotion-intent');assert.equal(body.requested,false);cancels++;if(reject)throw Error('開始前の取消拒否');return {};
 };
 await a.context.act({dataset:{act:'freetalkcancel',t:'t'},disabled:false});
 await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.match(a.element('.freetalk-history').outerHTML,/開始前の取消拒否/);
 reject=false;await a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});assert.equal(cancels,3);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"/);
});

for(const stage of ['summary','promotion-intent']) for(const outcome of ['reject','resolve']) test('freetalk '+stage+'の旧'+outcome+'は通常整理の後にプロジェクト化欄を戻さない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:stage==='summary'?'':'通常要約',promotionRequested:false,reason:''},calls=0,finish;
 a.context.load=async()=>{};
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('/summary') && !body.intent){h={...h,summaryId:'normal-new',draft:'通常整理の新要約',promotionRequested:false};return {};}
  if(route.endsWith('/'+stage)){calls++;if(calls===1)throw Error('最初の開始拒否');const old={...h,promotionRequested:true};if(outcome==='resolve')h=old;return new Promise((resolve,reject)=>finish=()=>outcome==='resolve'?resolve(old):reject(Error('通常整理後の旧開始拒否')));}
  throw Error(route);
 };
 const act=action=>a.context.act({dataset:{act:action,t:'t'},disabled:false});
 await act('freetalkpromote');const retry=act('freetalkretry');await new Promise(r=>setImmediate(r));assert.equal(typeof finish,'function');
 await act('freetalksummary');finish();await retry;
 await vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 assert.equal(h.promotionRequested,false);assert.equal(calls,2);assert.equal(vm.runInContext('freetalkPromotionErrors.has("t") || freetalkPromotionDrafts.has("t")',a.context),false);
 assert.match(a.element('.freetalk-history').outerHTML,/通常整理の新要約/);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"|通常整理後の旧開始拒否/);
 await act('freetalkretry');assert.equal(calls,2,'通常整理後の状態再確認は開始しない');
});
for(const outcome of ['reject','resolve']) test('freetalk通常整理の旧'+outcome+'は新しいプロジェクト化の編集を消さない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'通常要約',promotionRequested:false,reason:''},finish,loads=0;const notices=[];
 a.context.load=async()=>loads++;a.context.toast=x=>notices.push(x);
 vm.runInContext('taskOf(proj("freetalk"),"t").freetalkHistory={revision:"r",summaryId:"s",draft:"通常要約",promotionRequested:false,reason:""}',a.context);
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('/summary')){assert.equal(body.intent,undefined);return new Promise((resolve,reject)=>finish=()=>outcome==='resolve'?resolve({}):reject(Error('古い通常整理の拒否')));}
  if(route.endsWith('promotion-intent')){assert.equal(body.requested,true);h={...h,promotionRequested:true};return h;}
  if(route.endsWith('project-preview'))return {operationId:'new',revision:'r',summaryId:'s',name:'新名前',summary:'通常要約',files:[]};throw Error(route);
 };
 const old=a.context.act({dataset:{act:'freetalksummary',t:'t'},disabled:false});await new Promise(r=>setImmediate(r));
 await a.context.act({dataset:{act:'freetalkpromote',t:'t'},disabled:false});vm.runInContext('freetalkPromotionDrafts.get("t").name="新しい人の編集"',a.context);
 finish();await old;
 assert.equal(h.promotionRequested,true);assert.equal(vm.runInContext('freetalkPromotionDrafts.get("t").name',a.context),'新しい人の編集');assert.equal(loads,0);assert.deepEqual(notices,[]);
});
test('freetalk現在の通常整理拒否は表示され、同じ開始ボタンから復旧する',async()=>{
 const a=freetalkConversation();let fail=true,calls=0,loads=0;const notices=[];
 a.context.load=async()=>loads++;a.context.toast=x=>notices.push(x);a.context.api=async(route,body)=>{assert.equal(route,'/api/freetalk/summary');assert.equal(body.intent,undefined);calls++;if(fail)throw Error('通常整理の開始拒否');return {};};
 const el={dataset:{act:'freetalksummary',t:'t'},disabled:false};await a.context.act(el);assert.equal(notices[0],'通常整理の開始拒否');assert.equal(el.disabled,false);
 fail=false;await a.context.act(el);assert.equal(calls,2);assert.equal(loads,2);assert.match(notices[1],/要約を頼みました/);assert.equal(vm.runInContext('freetalkPromotionErrors.has("t")',a.context),false);
});
for(const action of ['freetalkclear','freetalkcontinue','freetalkdelete','freetalkclean']) for(const outcome of ['reject','resolve']) test('freetalk '+action+'成功後の古い開始'+outcome+'は解除した欄を復活しない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:false,reason:''},calls=0,finish;const notices=[];
 a.context.load=async()=>{};a.context.toast=x=>notices.push(x);
 a.context.api=async(route,body)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('promotion-intent')){calls++;if(calls===1)throw Error('最初の拒否');const old={...h,promotionRequested:true};if(outcome==='resolve')h=old;return new Promise((resolve,reject)=>finish=()=>outcome==='resolve'?resolve(old):reject(Error('解除後の旧拒否')));}
  if(['/api/freetalk/rotate','/api/freetalk/delete','/api/freetalk/clean'].includes(route)){assert.equal(body.confirm,true);h={...h,draft:'',promotionRequested:false};return {};}
  throw Error(route);
 };
 const act=action=>a.context.act({dataset:{act:action,t:'t'},disabled:false});
 await act('freetalkpromote');const old=act('freetalkretry');await new Promise(r=>setImmediate(r));await act(action);finish();await old;
 assert.equal(vm.runInContext('freetalkPromotionErrors.has("t") || freetalkPromotionDrafts.has("t")',a.context),false);assert.equal(h.promotionRequested,false);assert.equal(calls,2);assert.ok(!notices.includes('解除後の旧拒否'));
});
for(const outcome of ['reject','resolve']) test('freetalk背景previewの旧'+outcome+'も通常整理への切替後に反映しない',async()=>{
 const a=freetalkConversation();let h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''},finish;
 a.context.load=async()=>{};a.context.api=async(route)=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('/summary')){h={...h,summaryId:'normal',draft:'通常整理',promotionRequested:false};return {};}
  if(route.endsWith('project-preview'))return new Promise((resolve,reject)=>finish=()=>outcome==='resolve'?resolve({operationId:'old',revision:'r',summaryId:'s',name:'古い確認',summary:'要約',files:[]}):reject(Error('古いpreview拒否')));
  throw Error(route);
 };
 const old=vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);await new Promise(r=>setImmediate(r));
 await a.context.act({dataset:{act:'freetalksummary',t:'t'},disabled:false});finish();await old;
 await vm.runInContext('syncFreetalkHistory(proj("freetalk"),taskOf(proj("freetalk"),"t"))',a.context);
 assert.equal(vm.runInContext('freetalkPromotionErrors.has("t") || freetalkPromotionDrafts.has("t")',a.context),false);assert.doesNotMatch(a.element('.freetalk-history').outerHTML,/class="freetalk-promotion"|古いpreview拒否/);
});
test('freetalk掃除の古い成功は新しい話題のプロジェクト化・編集を消さない',async()=>{
 const a=freetalkConversation();let finish;const h={revision:'new',summaryId:'new',draft:'新話題の要約',promotionRequested:false,reason:''};
 a.context.load=async()=>{};a.context.api=async(route)=>{
  if(route.endsWith('/clean'))return new Promise(resolve=>finish=()=>resolve({}));
  if(route.includes('/status'))return {...h};
  if(route.endsWith('promotion-intent')){h.promotionRequested=true;return {...h};}
  if(route.endsWith('project-preview'))return {operationId:'new',revision:'new',summaryId:'new',name:'新話題',summary:'新話題の要約',files:[]};throw Error(route);
 };
 const old=a.context.act({dataset:{act:'freetalkclean'},disabled:false});await new Promise(r=>setImmediate(r));
 vm.runInContext('state.projects[0].tasks.push({...state.projects[0].tasks[0],id:"new"});view.task="new"',a.context);
 await a.context.act({dataset:{act:'freetalkpromote',t:'new'},disabled:false});vm.runInContext('freetalkPromotionDrafts.get("new").name="新話題の編集"',a.context);finish();await old;
 assert.equal(vm.runInContext('view.task',a.context),'new');assert.equal(vm.runInContext('freetalkPromotionDrafts.get("new").name',a.context),'新話題の編集');
});
test('freetalk掃除の拒否後は複数話題の確認済み作成を妨げない',async()=>{
 const a=freetalkConversation(),h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:true,reason:''};
 vm.runInContext('state.projects[0].tasks.push({...state.projects[0].tasks[0],id:"second"})',a.context);
 a.context.api=async route=>{
  if(route.includes('/status'))return {...h};
  if(route.endsWith('project-preview'))return {operationId:'o',revision:'r',summaryId:'s',name:'名前',summary:'要約',files:[]};
  if(route.endsWith('/clean'))throw Error('掃除の拒否');
  throw Error(route);
 };
 for(const id of ['t','second']){
  vm.runInContext('view.task='+JSON.stringify(id),a.context);
  await a.context.act({dataset:{act:'freetalkpromote',t:id},disabled:false});
 }
 await a.context.act({dataset:{act:'freetalkclean'},disabled:false});
 for(const id of ['t','second'])assert.equal(vm.runInContext('freetalkPromotionBlocked(taskOf(proj("freetalk"),'+JSON.stringify(id)+'))',a.context),false,'掃除が失敗しても確認済みの話題は作成を続けられる');
});
test('freetalkクリアの確認を取り消した場合は未取消の開始失敗を保持する',async()=>{
 const a=freetalkConversation();let finish,calls=0;const h={revision:'r',summaryId:'s',draft:'要約',promotionRequested:false,reason:''};
 a.context.api=async(route)=>{if(route.includes('/status'))return {...h};if(route.endsWith('promotion-intent')){calls++;if(calls===1)throw Error('最初の拒否');return new Promise((resolve,reject)=>finish=()=>reject(Error('まだ有効な開始拒否')));}throw Error(route);};
 await a.context.act({dataset:{act:'freetalkpromote',t:'t'},disabled:false});const old=a.context.act({dataset:{act:'freetalkretry',t:'t'},disabled:false});await new Promise(r=>setImmediate(r));
 a.context.confirm=()=>false;await a.context.act({dataset:{act:'freetalkclear',t:'t'},disabled:false});finish();await old;
 assert.match(a.element('.freetalk-history').outerHTML,/まだ有効な開始拒否/);assert.equal(calls,2);
});

test('予約も確定も取得する前に再起動が完了しても下書きを保存して新画面へ一度だけ切り替える',async()=>{
 const rows=new Map(),storage={getItem:k=>rows.get(k)||null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)},a=restartPollingApp(storage);
 vm.runInContext('state.restart={};setChatDraft("draft","途中の本文");queueDrafts.set("draft",{text:"待ち指示"})',a.context);
 const next={...a.context.fixture,hubInstance:'new',restart:{}};a.context.fetchState=async()=>next;
 await a.context.pollState();await a.context.pollState();assert.equal(a.reloads(),1);assert.equal(JSON.parse(rows.get('hub-restart-drafts')).chatDraft.draft,'途中の本文');
});
test('保存済み要約は次の作業と判断待ちを先頭へ表示し、原文とボタン数は変えない',()=>{
 const a=app(),text='Hubの自動整理\n承認（人の発言のみ）：\n- 昔の承認\n残件・判断待ち：\n- 人の判断\n次にすること：\n- 残作業\n参照先：\n- INDEX.md';
 const row={role:'event',summaryAuto:true,text};a.context.fixture=row;const html=vm.runInContext('msgHtml(fixture)',a.context);
 assert.ok(html.indexOf('次にする作業')<html.indexOf('残件・判断待ち'));assert.ok(html.indexOf('残件・判断待ち')<html.indexOf('承認（人の発言のみ）'));assert.equal(row.text,text);assert.doesNotMatch(html,/<button|<input/);
 assert.equal(a.context.continuationSummary('区画のない旧要約'),'区画のない旧要約');
 const zh='Hub 自動整理\n核准（僅限使用者發言）：\n- 核准\n剩餘工作與待決定事項：\n- 判斷\n次にすること：\n- 待辦\n已決定事項：\n- 完成\n参照先：\n- INDEX.md';
 const sorted=a.context.continuationSummary(zh);assert.ok(sorted.indexOf('次にする作業')<sorted.indexOf('核准'));assert.ok(sorted.includes('已決定事項：\n- 完成'));assert.ok(sorted.includes('INDEX.md'));
});

for (const ai of ['claude', 'codex', 'grok', 'agy']) test(`${ai} account shows exactly one auth action for each state`, () => {
  const a = app(), data = snapshot();
  for (const status of ['logged-in', 'logged-out', 'unknown', 'api']) {
    data.accounts = [{ai,id:'default',name:'test',status,busy:false}];
    vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"}', a.context);
    const html = a.context.accountSettingsHtml();
    const actions = [...html.matchAll(/data-account-action="(login|logout)"/g)].map(m=>m[1]);
    assert.deepEqual(actions, [status === 'logged-in' || status === 'api' ? 'logout' : 'login']);
  }
});
test('auth button resumes existing Terminal without changing cached auth or starting another login', async () => {
  const a = app(), data = snapshot();
  data.accounts = [{ai:'agy',id:'default',name:'test',status:'logged-in',busy:true,authTerminal:true}];
  vm.runInContext('state='+JSON.stringify(data)+';accountStatusRows=state.accounts;view={kind:"settings"}',a.context);
  const calls=[]; a.context.api=async (route,body)=>{
    if(route === '/api/chatgpt') return {work:false};
    calls.push({route,body}); return {existingTerminal:true,warning:'Terminal focused'};
  };
  a.context.confirm=()=>{throw Error('focus does not log out');};
  await a.context.operateAccount({disabled:false,dataset:{accountAction:'logout'},closest:()=>({dataset:{ai:'agy',id:'default',authTerminal:'1'}})});
  assert.equal(calls.length,1);assert.equal(calls[0].route,'/api/accounts/terminal');assert.equal(calls[0].body.action,'logout');
  assert.equal(a.element('#account-message').textContent,'Terminal focused');
  assert.match(a.context.accountSettingsHtml(),/ログイン済み/);
});

test('省スペース：上部単一領域・補助操作と管理の折畳み、メモUIのみ撤去する',()=>{
 const a=app(),s=snapshot();s.projects[0].tasks[0].copy=true;
 vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};stepsOpen=true;renderWork()',a.context);
 const html=a.element('#main').innerHTML;
 assert.equal((html.match(/data-main-preview/g)||[]).length,1);
 for(const name of ['more','info','management','steps'])assert.match(html,new RegExp('data-work-fold="'+name+'"'));
 assert.doesNotMatch(html,/data-work-fold="settings"|chat-settings-summary/);
 assert.match(html,/class="work-topline"[\s\S]*data-act="merge"[\s\S]*class="work-more"/);
 assert.match(html,/work-more-panel[\s\S]*data-go="project"[\s\S]*>アイデア台帳<[\s\S]*>ファイルを見る</);
 assert.doesNotMatch(html,/id="memo"|data-act="memo"|history-footer/);
 assert.match(html,/id="chat-history-help"/);assert.match(html,/aria-describedby="chat-history-help"/);
 assert.match(html,/data-task-history="continue"[\s\S]*id="history-progress"[\s\S]*data-task-history="archives"[\s\S]*id="msgs"/);
 assert.match(html,/work-management[^>]*>[\s\S]*状態：実行中・手順 0\/0/);
 assert.doesNotMatch(html,/data-work-fold="steps" open/,'別の作業で開いた旧フラグを引き継がない');
});
test('省スペース：開閉の記憶は作業別で、再描画時だけ戻して他の作業へ漏らさない',()=>{
 const a=app(),el={dataset:{workFold:'more'},open:true,isConnected:true,closest:()=>({dataset:{p:'p',t:'t'}})};
 a.context.rememberWorkFold(el);
 assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'more'),'open');
 assert.equal(a.context.workFoldAttr({id:'p'},{id:'other'},'more'),'');
 el.open=false;a.context.rememberWorkFold(el);assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'more'),'');
 el.isConnected=false;el.open=true;a.context.rememberWorkFold(el);assert.equal(a.context.workFoldAttr({id:'p'},{id:'t'},'more'),'');
});
test('省スペース：通常会話とfreetalkの設定を直接使え、AI別の許可・選択値を保つ',()=>{
 const a=app(),s=snapshot();s.accounts=[{ai:'codex',id:'default',name:'既定'},{ai:'codex',id:'work',name:'仕事用'}];s.acceleration={codexAllowed:true};
 const p=s.projects[0],t=p.tasks[0];t.accounts={codex:'work'};t.codexFast=true;
 for(const freetalk of [false,true])for(const ai of ['codex','claude','agy','chatgpt']){
   t.freetalk=freetalk;t.owner=ai;t.model=ai==='chatgpt'?'auto':'';vm.runInContext('state='+JSON.stringify(s),a.context);
   const html=a.context.chatHtml(p,t),settings=html.match(/<div class="composer-settings">([\s\S]*?)<\/div>/)[1];
   assert.doesNotMatch(html,/chat-settings-summary|composer-settings-panel|data-work-fold="settings"/);
   assert.match(settings,/id="chat-account-box"/);assert.match(settings,/id="chat-fast-box"/);if(fs.existsSync(path.join(__dirname,'../public/paid/discussion.js')))assert.match(settings,/id="discussion-toggle"[^>]*type="button"/);else assert.doesNotMatch(settings,/id="discussion-toggle"/);
   assert.equal(settings.includes('data-task-fast'),ai==='codex');
   if(ai==='codex'){assert.match(settings,/value="work" selected/);assert.match(settings,/data-task-fast[^>]*checked/);}
 }
 assert.equal(t.accounts.codex,'work');assert.equal(t.codexFast,true);
});

test('queue model draft is local, survives redraw, blocks unsaved start and saves only selected instruction',async()=>{
 const a=queuedUI();a.queue([queuedItem]);await a.click({qedit:'q1'});
 const el=a.element('#chat-queue');el.handlers.change({target:{dataset:{queueModel:'q1'},value:'claude|Fable 5.1'}});
 a.queue([queuedItem,{...queuedItem,id:'q2',text:'other'}]);assert.match(el.innerHTML,/data-queue-model/);assert.match(el.innerHTML,/value="claude\|Fable 5.1"[^>]*selected/);
 let request;a.context.api=async(route,body)=>{request={route,body};return {queue:[{...queuedItem,ai:'claude',model:'Fable 5.1'}]};};
 await a.click({run:'q1'});assert.equal(request,undefined);assert.match(a.lastToast,/保存してから/);
 await a.click({qsave:'q1'});assert.equal(request.body.ai,'claude');assert.equal(request.body.model,'Fable 5.1');assert.equal(request.body.expectedItem,JSON.stringify(queuedItem));assert.equal(a.element('#chat-in').value,'composer draft');
});

test('queue image viewer deletes only selected reference on save; Back and stale save preserve source and draft',async()=>{
 const a=queuedUI(),images=[{id:'one',path:'/fixture/one.png',url:'/api/start/image?id=one',name:'one.png'},{id:'two',path:'/fixture/two.png',url:'/api/start/image?id=two',name:'two.png'}];
 const item={...queuedItem,attachmentDraft:{text:'body',attachments:images}};a.queue([item]);await a.click({qedit:'q1'});let viewer;a.context.showFileViewer=(...args)=>{viewer=args;};
 await a.click({imageOpen:'one'});assert.equal(viewer[0],images[0].path);viewer[3].remove();assert.doesNotMatch(a.element('#chat-queue').innerHTML,/data-image-open="one"/);assert.match(a.element('#chat-queue').innerHTML,/data-image-open="two"/);assert.equal(item.attachmentDraft.attachments.length,2);
 await a.click({qclose:'q1'});await a.click({qedit:'q1'});assert.match(a.element('#chat-queue').innerHTML,/data-image-open="one"/);
 await a.click({imageOpen:'one'});viewer[3].remove();let body;a.context.api=async(_r,b)=>{body=b;throw Error('stale selection');};await a.click({qsave:'q1'});assert.deepEqual(Array.from(body.attachmentIds),['two']);assert.equal(body.text,'body');assert.match(a.element('#chat-queue').innerHTML,/data-image-open="two"/);assert.equal(a.lastToast,'stale selection');
 // A delayed viewer callback cannot alter a newly opened editor, or an instruction that started.
 await a.click({qclose:'q1'});await a.click({qedit:'q1'});viewer[3].remove();assert.match(a.element('#chat-queue').innerHTML,/data-image-open="one"/);
 await a.click({imageOpen:'one'});a.queue([]);viewer[3].remove();assert.match(a.element('#chat-queue').innerHTML,/data-image-open="one"/);
});

test('composer preview uses original resource and a delayed delete cannot touch new attachment identities or other conversations',()=>{
 const a=conversationApp(),image={id:'one',path:'/fixture/one.png',url:'/api/start/image?id=one',name:'one.png'};a.context.chatImages('p','t').push(image);a.context.drawChatImages('p','t');let viewer;a.context.showFileViewer=(...args)=>{viewer=args;};
 a.element('#chat-images').handlers.click({target:{closest:selector=>selector==='[data-image-open]'?{dataset:{imageOpen:'one'}}:null}});assert.equal(viewer[3].url,image.url);
 a.context.clearSentChatImages('p','t',[image]);const newer={...image};a.context.chatImages('p','t').push(newer);viewer[3].remove();assert.equal(a.context.chatImages('p','t').length,1);
 a.element('#chat-images').handlers.click({target:{closest:selector=>selector==='[data-image-open]'?{dataset:{imageOpen:'one'}}:null}});vm.runInContext('view.task="elsewhere"',a.context);viewer[3].remove();assert.equal(a.context.chatImages('p','t').length,1);
});

test('終了保存の未解決表示は当該会話と復旧可能段階だけにボタンを出し、最新の証拠だけ送る',async()=>{
 const a=app(),data=snapshot();data.chatHandoffErrors=[{project:'p',task:'t',run:'run',token:'fresh',stage:'finished',recovery:'confirm-finished',error:'保存 <確認>'},{project:'p',task:'t',run:'unknown',stage:'on-settled',recovery:'not-sent'},{project:'other',task:'else',run:'other',token:'other',recovery:'confirm-finished'}];
 vm.runInContext('state='+JSON.stringify(data),a.context);
 const html=a.context.chatHandoffHtml('p','t');assert.match(html,/保存 &lt;確認&gt;/);assert.match(html,/処理途中の記録の確認/);assert.equal([...html.matchAll(/data-handoff-recover=/g)].length,1);assert.doesNotMatch(html,/data-handoff-recover="other"/);
 const calls=[],button={dataset:{p:'p',t:'t',handoffRecover:'run',token:'stale'},disabled:false};a.context.api=async(route,body)=>{calls.push({route,body});return {ok:true};};a.context.load=async()=>{};a.context.render=()=>{};
 const cb=a.documentListeners.find(x=>x.name==='click'&&String(x.cb).includes("'[data-handoff-recover]'" )).cb;
 await cb({target:{closest:()=>button}});assert.equal(calls.length,0);
 button.dataset.token='fresh';await cb({target:{closest:()=>button}});assert.equal(calls.length,1);assert.equal(calls[0].route,'/api/chat/handoff/recover');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)),{project:'p',task:'t',run:'run',token:'fresh'});assert.equal(button.disabled,false);
 button.disabled=true;await cb({target:{closest:()=>button}});assert.equal(calls.length,1);
});


test('missing discussion bundle removes its settings/actions and preserves the ordinary chat composer',()=>{
 const a=app(),s=snapshot();delete a.context.window.HubPaidDiscussion;s.extensions={version:1,included:[],missing:['discussion'],notice:'有料部品が見つかりません：discussion'};
 vm.runInContext('state='+JSON.stringify(s),a.context);
 const html=a.context.chatHtml(s.projects[0],s.projects[0].tasks[0]);
 assert.match(html,/id="chat-in"/);assert.match(html,/有料部品が見つかりません/);assert.doesNotMatch(html,/id="discussion-(?:toggle|progress|start|settings)"/);
});


test('missing role-review UI preserves free role settings, history and defaults and ignores forged paid actions',async()=>{
 const a=app(),s=snapshot();delete a.context.window.HubPaidRoleReview;
 s.extensions={version:1,included:[],missing:[],notice:''};s.roles.management={revision:'fixture',defaultSavedAt:'2026-10-10T00:00:00Z',review:null};
 vm.runInContext('state='+JSON.stringify(s),a.context);
 const html=a.context.roleSettingsHtml();assert.match(html,/data-role-setting="history"/);assert.match(html,/data-role-setting="save-default"/);assert.match(html,/data-role-setting="default"/);
 assert.doesNotMatch(html,/data-role-setting="(?:review|cancel|topic)"|手動見直し|Opus 5.5|最終見直し日時/);
 const calls=[];a.context.api=async(...args)=>calls.push(args);
 const cb=a.documentListeners.find(x=>x.name==='click'&&String(x.cb).includes('[data-role-setting]')).cb;
 for(const action of ['review','cancel','topic'])await cb({target:{closest:()=>({dataset:{roleSetting:action,task:'forged'}})}});
 assert.equal(calls.length,0);
});

// A public build also exercises this with no private UI file on disk.
test('external screen controls are absent while free MCP settings and old conversation rows remain',()=>{
 const a=app(),s=snapshot();s.extensions={included:[],missing:[],notice:''};a.context.data=s;
 vm.runInContext('state=data;view={kind:"settings"};renderSettings();',a.context);
 const settings=a.context.accountSettingsHtml();
 assert.doesNotMatch(settings,/id="webchat-box"|data-webchat=/);
 assert.match(settings,/id="chatgpt-box"|id="mcp-box"|data-ai-fold="mcp"/);
 assert.doesNotMatch(a.context.chatModelChoices(s.projects[0],s.projects[0].tasks[0]),/value="chatgpt\|auto"/);
 assert.match(a.context.msgHtml({role:'assistant',ai:'chatgpt-chat',text:'Retained old reply'}),/Retained old reply/);
});

test('screen modules preserve the main activation and purchase gate for an unregistered issuer', () => {
  for (const gate of [{supported:true,activationAvailable:false},{supported:false,activationAvailable:true}]) {
    const a=app(),s=snapshot();
    s.license={edition:'public',trial:{state:'active'},purchaseUrl:'https://issuer.invalid/buy',introAvailable:true,...gate};
    vm.runInContext('state='+JSON.stringify(s)+';view={kind:"settings"}',a.context);
    a.element('#ai-use-settings').contains=()=>false;
    a.context.renderSettings();
    assert.doesNotMatch(a.element('#main').innerHTML,/id="license-form"|id="license-code"|data-license-intro|data-license-purchase/);
  }
});


test('entry image: native pending drop owns DOM duplicates only on its original screen', async()=>{
  const a=conversationApp(),got=[],messages=[];
  const anchor={isConnected:true};a.element('#main').firstElementChild=anchor;
  a.context.addChatImage=async(...args)=>got.push(args);a.context.toast=x=>messages.push(x);
  const native=a.context.window.hubNativeDrop,ticket=native.begin();
  const event=files=>({dataTransfer:{files,items:[]},target:{closest:s=>s==='.chat'?{}:null},preventDefault(){}});
  await a.events.get('drop')(event([]));await a.events.get('drop')(event([{name:'same.png',type:'image/png'}]));
  assert.equal(got.length,0);assert.equal(messages.length,0,'no false DOM failure during native receive');
  await native(['/tmp/same.png'],ticket,{temporary:true});assert.equal(got.length,1);
  const stale=native.begin();a.element('#main').firstElementChild={isConnected:true};
  await a.events.get('drop')(event([{name:'fresh.png',type:'image/png'}]));
  assert.equal(got.length,2,'a stale ticket cannot block a new DOM upload');
  await native(['/tmp/stale.png'],stale,{temporary:true});assert.equal(got.length,2);
  a.element('#chat-in').value='keep';
  const failed=native.begin();native.fail(failed,'promise');native.fail(failed,'promise');
  assert.equal(messages.length,1);assert.match(messages[0],/Macから画像ファイル/);
  await a.events.get('drop')(event([]));assert.match(messages[1],/ブラウザから画像データ/);
  assert.equal(a.element('#chat-in').value,'keep');
});

test('entry image: native receive reasons and backend save errors remain distinguishable', async()=>{
  const a=conversationApp(),messages=[];a.element('#main').firstElementChild={isConnected:true};
  a.context.toast=x=>messages.push(x);const native=a.context.window.hubNativeDrop;
  for(const reason of ['promise-count','timeout','temporary-directory','file-location','file-url','image-data'])native.fail(native.begin(),reason);
  assert.equal(new Set(messages).size,6);assert.match(messages[0],/件数/);assert.match(messages[1],/時間/);
  a.context.api=async()=>{throw Error('画像は1枚50MBまでです');};
  a.context.drawChatImages=()=>{};
  await native(['/tmp/large.png'],native.begin(),{temporary:true});
  assert.match(messages.at(-1),/large.png：画像は1枚50MB/);
  assert.equal(a.context.chatImages('p','t').length,0);
});

test('通知：質問なしの成果不備は成果確認へ、確認中・整理中・通常稼働は区別して数える',()=>{
 const a=app(),s=snapshot(),p=s.projects[0],base=p.tasks[0];
 p.tasks=[
  ...['none','failed','blocked'].map(auto=>({...base,id:auto,title:auto,resultsPending:{auto,code:'candidates',reason:'保存先を確認',detail:'整理が停止'}})),
  {...base,id:'checking',title:'checking',resultsPending:{auto:'none',code:'checking'}},
  {...base,id:'organizing',title:'organizing',resultsPending:{auto:'running',code:'format'}},
  {...base,id:'live',title:'live',resultsPending:{auto:'blocked',code:'candidates',detail:'AIが作業中です'}},
  {...base,id:'normal',title:'normal'},
  {...base,id:'done',title:'done',completionPending:true}
 ];
 s.chatting=[{project:p.id,task:'live',ai:'codex'},{project:p.id,task:'normal',ai:'codex'}];
 const original=JSON.stringify(s);
 vm.runInContext('state='+original+';view={kind:"turn",project:"p"};open.add("p")',a.context);a.context.render();
 for(const [id,text] of [['#turn-n','返事待ち 0'],['#turn-work-n','作業中 4'],['#turn-results-n','成果確認 3'],['#turn-done-n','完了 1']])assert.equal(a.element(id).textContent,text);
 assert.match(a.element('#list').innerHTML,/>成果確認 3</);assert.doesNotMatch(a.element('#list').innerHTML,/notice-reply/);
 assert.equal(a.element('#turn').attributes['aria-label'],'あなたの番：返事待ち 0件、作業中 4件、成果確認 3件、完了 1件');
 for(const [id,label] of [['checking','成果確認中'],['organizing','成果整理中'],['live','作業中'],['normal','作業中']]){
  const t=p.tasks.find(t=>t.id===id),row=a.context.taskRow(p,t,true,'work');
  assert.match(row,new RegExp('task-status busy">'+label+'<'));
  assert.doesNotMatch(row,/data-act="answered"|data-act="taskcomplete"|data-act="resultsorganize"/);
  if(t.resultsPending)assert.doesNotMatch(a.context.completionButtons(p,t),/data-act="resultsorganize"|data-act="taskcomplete"/);
  assert.match(a.context.notificationBadges(p,[t]),new RegExp('>'+label+'<'));
 }
 vm.runInContext('turnTab="results";render()',a.context);
 const html=a.element('#main').innerHTML;
 assert.equal((html.match(/class="trow /g)||[]).length,3);assert.equal((html.match(/data-act="resultsorganize"/g)||[]).length,3);
 assert.doesNotMatch(html,/data-act="answered"|data-act="taskcomplete"|id="turn-answer-all"/);
 assert.match(html,/成果整理は現在動いていません/);
 assert.equal(vm.runInContext('JSON.stringify(state)',a.context),original);
});

test('通知：成果不備と実質問・入力待ち・停止保留が併存しても返事と完了承認を保護する',()=>{
 for(const fields of [{question:'確認してください'},{state:'返事待ち'},{state:'上限で停止'},{chatQueueBlocked:true},{chatQueueBlocked:true,chatQueueHeld:true}]){
  const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];Object.assign(t,{completionPending:true,resultsPending:{auto:'failed',code:'format'}},fields);
  const original=JSON.stringify(s);vm.runInContext('state='+original+';view={kind:"turn",project:"p"}',a.context);a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 1');assert.equal(a.element('#turn-results-n').textContent,'成果確認 0');assert.equal(a.element('#turn-done-n').textContent,'完了 0');
  assert.match(a.context.notificationBadges(p,[t]),/notice-reply/);assert.doesNotMatch(a.context.completionButtons(p,t),/data-act="taskcomplete"/);
  assert.equal(vm.runInContext('JSON.stringify(state)',a.context),original);
 }
});

test('通知：成果再確認と通常稼働の遷移を定期取得し、成功後だけ完了承認へ移す',async()=>{
 const a=app(),s=snapshot(),p=s.projects[0],t=p.tasks[0];t.completionPending=true;
 for(const [pending,chatting,tab,count] of [
  [{auto:'blocked',code:'candidates'},[{project:p.id,task:t.id,ai:'codex'}],'work',1],
  [{auto:'blocked',code:'candidates'},[],'results',1],
  [{auto:'none',code:'checking'},[],'work',1],
  [{auto:'running',code:'format'},[],'work',1],
  [{auto:'failed',code:'format'},[],'results',1],
  [null,[],'done',1]
 ]){
  if(pending)t.resultsPending=pending;else delete t.resultsPending;s.chatting=chatting;
  vm.runInContext('fetchState=async()=>('+JSON.stringify(s)+')',a.context);await a.context.pollState();
  for(const kind of ['reply','work','results','done'])assert.equal(a.element({'reply':'#turn-n','work':'#turn-work-n','results':'#turn-results-n','done':'#turn-done-n'}[kind]).textContent,{'reply':'返事待ち ','work':'作業中 ','results':'成果確認 ','done':'完了 '}[kind]+(kind===tab?count:0));
  assert.equal(Boolean(vm.runInContext('CONFIRM(state.projects[0],state.projects[0].tasks[0])',a.context)),tab==='done');
 }
});

test('通知：返事待ちの一括解除は成果確認の状態・質問・成果検査を変更しない',async()=>{
 const a=app(),s=snapshot(),p=s.projects[0],base=p.tasks[0],calls=[];
 p.tasks=[{...base,id:'ask',question:'選んでください'}, {...base,id:'results',question:'',completionPending:false,resultsPending:{auto:'failed',code:'format'}}];
 const before=JSON.stringify(p.tasks[1]);vm.runInContext('state='+JSON.stringify(s),a.context);
 a.context.confirm=()=>true;a.context.api=async(url,body)=>{calls.push({url,body});return {};};a.context.load=async()=>{};
 await a.context.appWorkCallback693()({target:{closest:s=>s==='#turn-answer-all'?{}:null}});
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/task');assert.equal(calls[0].body.task,'ask');
 assert.equal(vm.runInContext('JSON.stringify(state.projects[0].tasks[1])',a.context),before);
});
