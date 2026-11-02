'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');
function fixture(){
  const a=app(),data=snapshot();
  data.projects[0].phases=[{name:'計画',state:'完了'},{name:'作る',state:'進行中'},{name:'確認',state:'未着手'}];
  a.context.data=data;
  vm.runInContext('state=data;view={kind:"work",project:"p",task:"t"}',a.context);
  const p=data.projects[0],t=p.tasks[0];
  return {...a,p,t,html:()=>a.context.workProgressHtml(p,t)};
}
test('work progress: explicit assignment and default current phase use the existing rule',()=>{
  const a=fixture();
  assert.match(a.html(),/この作業：フェーズ 2 \/ 3「作る」/);
  a.t.phase='確認';
  assert.match(a.html(),/この作業：フェーズ 3 \/ 3「確認」/);
  assert.match(a.html(),/aria-current="step"><span>3\. 確認/);
  assert.match(a.html(),/フェーズ 完了 1 \/ 3・残り 2/);
  a.p.phases[1].completionPending=true;
  assert.match(a.html(),/完了確認待ち/);
});
test('work progress: phase completion and all steps checked never imply whole-task completion',()=>{
  const a=fixture();a.t.phase='計画';a.t.steps=[{done:true},{done:true}];
  let html=a.html();assert.match(html,/作業全体：未完了（実行中）/);
  assert.match(html,/手順 済 2 \/ 2・残り 0（作業の完了は未確定）/);
  a.p.phases.forEach(ph=>ph.state='完了');a.t.phase='';
  assert.match(a.html(),/作業全体：未完了/);
  assert.match(a.html(),/未指定（全フェーズ完了）/);
  a.t.state='完了';a.t.steps[1].done=false;
  html=a.html();assert.match(html,/作業全体：完了/);assert.match(html,/手順 済 1 \/ 2・残り 1/);
});
test('work progress: missing or unknown phases and absent steps are explicit; names are escaped',()=>{
  const a=fixture();a.t.phase='<old>';assert.match(a.html(),/フェーズ「&lt;old&gt;」は一覧にありません/);
  assert.doesNotMatch(a.html(),/aria-current=/);
  a.t.phase='';a.p.phases=[];assert.match(a.html(),/フェーズ未設定/);assert.match(a.html(),/手順未設定/);
  assert.doesNotMatch(a.html(),/手順 済|100%|aria-current=/);
  a.p.phases=[{name:'<img onerror="bad">',state:'未着手'}];assert.doesNotMatch(a.html(),/<img/);
});
test('work progress: summary counts need neither full steps nor the other project tasks',()=>{
  const a=fixture();delete a.t.steps;a.t.stepSummary={total:1059,done:916};
  Object.defineProperty(a.p,'tasks',{get(){throw Error('must not scan project tasks');}});
  assert.match(a.html(),/手順 済 916 \/ 1059・残り 143/);
});
test('work progress: live refresh replaces only changed strip content, retaining the draft and mismatched views',()=>{
  const a=fixture(),host=a.element('[data-work-progress]');host.dataset={p:'p',t:'t'};
  let writes=0,html='';Object.defineProperty(host,'innerHTML',{get:()=>html,set:value=>{writes++;html=value;}});
  const input=a.element('#chat-in');input.value='未送信の下書き';
  a.context.syncWorkProgress();a.context.syncWorkProgress();assert.equal(writes,1);
  a.t.stepSummary={total:3,done:2};a.context.syncWorkQuestion();
  assert.equal(writes,2);assert.match(html,/残り 1/);assert.equal(input.value,'未送信の下書き');
  host.dataset.t='other';a.t.state='完了';a.context.syncWorkProgress();assert.equal(writes,2);
  host.dataset.t='t';vm.runInContext('view.kind="project"',a.context);a.context.syncWorkProgress();assert.equal(writes,2);
});
test('work progress: enabled strip is rendered in both conversation and terminal, outside disclosures',()=>{
  for(const mode of ['chat','term']){
    const a=fixture();a.context.localStorage.getItem=k=>k==='hub-mode'?mode:k==='hub-work-progress'?'1':null;
    a.context.renderWork();const html=a.element('#main').innerHTML;
    assert.match(html,/<section class="work-progress" data-work-progress[^>]*>[\s\S]*aria-label="フェーズ一覧"/);
    assert.doesNotMatch(html,/<section class="work-progress"[^>]*\bhidden\b/);
    assert.ok(html.indexOf('data-work-progress')<html.indexOf(mode==='chat'?'class="chat"':'class="panes'));
    assert.ok(html.indexOf('data-work-progress')<html.indexOf('class="wfoot"'));
  }
});
