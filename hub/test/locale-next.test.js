'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./locale-next-ui-fixture.cjs');
const {isDelegated,isEnvelopeLine,unwrap}=require('../lib/delegation-text');
const auto=require('../lib/task-history-auto'),{summaryView}=require('../lib/text-budget'),selection=require('../public/integration-selection'),uiLocale=require('./ui-locale-fixture');
for(const lang of ['ja','en','zh-TW'])test('newly connected screens translate fixed UI and preserve user data: '+lang,async t=>{
 const f=await fixture(t,lang),views=await f.views();
 assert.deepEqual(f.errors,[]);
 assert.ok(views.empty.includes('/日本語/保存先'));
 assert.ok(views.locationPreview.includes('設定の原文'));
 assert.ok(views.locationPreview.includes(uiLocale(lang).text('読み書きする場所：')));
 assert.ok(views.legacyPreview.includes('日本語の計画'));
 assert.ok(views.ideas.includes('日本語の原文 &lt;表示言語&gt;'));
 const ui=uiLocale(lang);
 for(const [view,label]of [['empty','データの保存先を選ぶ'],['location','フォルダを選ぶ'],['pending','この変更を取り消す'],['legacy','以前のデータを引き継ぐ'],['legacyPreview','この内容を追加する'],['legacyComplete','以前の担当設定を適用する'],['legacyInterrupted','引き継ぎを再開する'],['ideas','アイデア台帳']])assert.ok(views[view].includes(ui.text(label)),view+': '+label);
 if(lang!=='ja'){
  const fixed=Object.values(views).join('').replaceAll('日本語の計画','').replaceAll('日本語の原文 &lt;表示言語&gt;','');
  assert.ok(!fixed.includes('フォルダを選ぶ'));
  assert.equal(ui.html('<select aria-label="表示言語"></select>'),'<select aria-label="'+ui.text('表示言語')+'"></select>');
  const reason=selection.select([], 'selected', [], ui.text, ui.template).reason;
  assert.equal(reason,ui.text('統合する子作業を選んでください'));assert.notEqual(reason,'統合する子作業を選んでください');
 }
 const stored=await f.page.locator('[data-idea-category]').inputValue();assert.equal(stored,'note');
 const option=await f.page.locator('[data-idea-intent]').inputValue();assert.equal(option,'record');
});
test('legacy delegation recognition excludes AI envelopes from human approvals in all supported languages',()=>{
 for(const title of ['【渡した依頼：review】','【已交接的要求：review】','[Delegated request: review]']){
  assert.equal(isDelegated(title+'\nbody'),true);assert.equal(isEnvelopeLine(title),true);
  assert.equal(unwrap(title+'\n[integration-auto:key:review]'),'[integration-auto:key:review]');
  assert.equal(auto.human({role:'user',text:title+'\napproved'}),false);
  assert.equal(auto.human({role:'user',text:'A quotation:\n'+title}),true);
 }
 assert.equal(isDelegated('【渡した依頼：unfinished'),true,'keep legacy Japanese prefix contract');
 assert.equal(unwrap('【渡した依頼：unfinished'),'【渡した依頼：unfinished');
 assert.equal(isEnvelopeLine('[Delegated request: review]\nextra'),false);
 assert.equal(isEnvelopeLine('【渡した依頼：】'),false,'keep legacy nonempty full-line contract');
 assert.equal(auto.human({role:'user',text:'Approved by the user'}),true);
});
test('important English summary lines survive display limits without rewriting their contents',()=>{
 const lines=['Pending: user confirmation','Approval: publication permitted','Stopped: waiting for user','Failure: disk full','Decision: use a separate Mac','Reason: preserve originals','Current status: in progress','Remaining: test update','Evidence: saved locally'];
 const result=summaryView('## 最新の再開要約\n'+'ordinary old detail\n'.repeat(200)+lines.join('\n'));
 assert.equal(result.incomplete,true);for(const line of lines)assert.ok(result.text.includes(line),line);
 const japanese='承認：公開のみ\n未済：購入\n停止：解除待ち';assert.equal(summaryView('## 最新の再開要約\n'+japanese).text,japanese);
});
