'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {app}=require('./fixtures/app-ui-harness.cjs');
const envelope='【渡した依頼：確認する】\n目的：本文\n続き';
test('automatic requests use source metadata; queued personal input stays full',()=>{
 const c=app().context;
 for(const row of [{origin:'delegate'},{origin:'hub-internal'},{limitSwitch:{request:'switch-id'}}]) {
  assert.equal(c.automaticRequest({role:'user',text:'長い自動指示',...row}),true);
 }
 for(const row of [{mode:'queued'},{origin:'person',text:envelope},{origin:'other',text:envelope},{limitSwitch:{}}]) {
  assert.equal(c.automaticRequest({role:'user',text:'本人の指示',...row}),false);
 }
});
test('legacy recognition matches only the existing complete first-line envelope',()=>{
 const c=app().context,server=require('../lib/delegation-text');
 for(const text of [envelope,'【已交接的要求：確認】\r\n本文','[Delegated request: Check]\nBody']) {
  assert.ok(server.isEnvelopeLine(text.split(/\r?\n/)[0]));
  assert.equal(c.automaticRequest({role:'user',text}),true);
 }
 for(const text of ['引用\n'+envelope,' '+envelope,'【渡した依頼：未完','【渡した依頼：確認】後書き\n本文','【渡した依頼：】\n本文','[Delegated request: x] suffix\nBody']) {
  assert.equal(c.automaticRequest({role:'user',mode:'queued',text}),false,text);
 }
});
test('answers, questions, errors and receipt notices retain the existing full rendering',()=>{
 const c=app().context;
 vm.runInContext('state={projects:[]};view={project:"p",task:"t"}',c);
 for(const row of [{role:'assistant',ai:'codex'},{role:'user',from:'delegate'},{role:'user',from:'child'},
  {role:'user',from:'subtask'},{role:'user',error:'Error'},{role:'user',asks:[{question:'Approval?'}]}]) {
  const r={text:envelope,origin:'delegate',...row};
  assert.equal(c.automaticRequest(r),false);
  assert.doesNotMatch(c.baseMsgHtml(r),/auto-request/);
 }
});
test('collapsed requests never rich-format their source and never mutate the row',()=>{
 const c=app().context,text=envelope+'\n```text\r\n<unsafe>&\r\n```\n'.repeat(400),row={role:'user',origin:'delegate',text};
 const before=JSON.stringify(row);let formats=0;
 c.richText=()=>{formats++;return 'formatted';};
 const html=c.baseMsgHtml(row);
 assert.equal(formats,0);assert.equal(JSON.stringify(row),before);
 assert.match(html,/aria-expanded="false"/);assert.match(html,/auto-request-full" hidden/);
 assert.match(html,/&lt;unsafe&gt;&amp;&#13;/);assert.doesNotMatch(html,/<unsafe>|class="codeblock"/);
 c.baseMsgHtml({role:'user',mode:'queued',text:'本人の依頼\n'+text});assert.equal(formats,1);
});
