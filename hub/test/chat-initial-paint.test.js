'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {app, snapshot} = require('./fixtures/app-ui-harness.cjs');
function fixture() {
  const a=app(), frames=[], formats=[], restores=[];
  const state=snapshot();a.context.fixture=state;
  vm.runInContext('state=fixture;view={kind:"work",project:"p",task:"t"}',a.context);
  a.context.api=()=>new Promise(()=>{});
  a.context.requestAnimationFrame=cb=>frames.push(cb);
  const original=a.context.richText;a.context.richText=(text,...args)=>{formats.push(text);return original(text,...args);};
  const box=a.element('#msgs');let partial=null,top=10;
  const query=a.document.querySelector;
  a.document.querySelector=s=>s==='#msg-partial'?partial:query(s);
  box.insertAdjacentHTML=(_where,html)=>{if(html.includes('id="msg-partial"'))partial={querySelector:s=>a.element('partial'+s),remove(){partial=null;}};};
  a.context.window.HubChatScroll={create:()=>({capture:()=>({top,follow:false}),restore:before=>restores.push(before.top),rows(){}})};
  a.context.openChat(state.projects[0],state.projects[0].tasks[0]);
  const emit=ev=>a.stream().onmessage({data:JSON.stringify(ev)});
  const rows=text=>emit({type:'rows',generation:1,rows:[{role:'user',text:'Saved question',at:'2026-10-26T00:00:00Z'}],busy:{ai:'codex',text,started:1},queue:[]});
  return {...a,box,formats,restores,rows,emit,frame(){const next=frames.splice(0);next.forEach(cb=>cb());},move(value){top=value;},html:()=>a.element('partial.mb').innerHTML};
}
test('initial history and busy controls appear before complete progress formatting; the full reply is retained',()=>{
  const a=fixture(),text='Full progress <tag> **bold**\n'.repeat(1000);
  a.rows(text);
  assert.match(a.box.innerHTML,/Saved question/);assert.equal(a.box.dataset.askHistoryPending,undefined);
  assert.equal(a.box.dataset.chatLoading,undefined);assert.equal(a.element('#chat-send').hidden,true);
  assert.equal(vm.runInContext('chatBusy.text',a.context),text);assert.equal(a.formats.filter(t=>t===text).length,0);
  a.frame();assert.equal(a.formats.filter(t=>t===text).length,0);
  a.move(77);a.frame();assert.equal(a.formats.filter(t=>t===text).length,1);
  assert.equal(a.html(),a.context.richText(text,true));assert.equal(a.restores.at(-1),77);
});
test('a newer partial supersedes the deferred initial text without stale replacement',()=>{
  const a=fixture();a.rows('Old progress');a.emit({type:'partial',ai:'codex',text:'New progress'});
  const html=a.html();a.frame();a.frame();assert.equal(a.html(),html);assert.match(html,/New progress/);
  assert.equal(a.formats.filter(t=>t==='Old progress').length,0);
});
test('idle cancels delayed progress and keeps idle controls',()=>{
  const a=fixture();a.context.refreshTree=()=>{};a.rows('Old progress');a.emit({type:'idle'});a.frame();a.frame();
  assert.equal(a.formats.filter(t=>t==='Old progress').length,0);assert.equal(a.element('#chat-send').hidden,false);
  assert.equal(vm.runInContext('chatBusy',a.context),null);
});
for(const change of ['navigation','replacement stream'])test(change+' cancels progress from the old view',()=>{
  const a=fixture();a.rows('Old progress');
  vm.runInContext(change==='navigation'?'view={kind:"project",project:"p"}':'chatES={}',a.context);
  a.frame();a.frame();assert.equal(a.formats.filter(t=>t==='Old progress').length,0);
});
test('reconnected rows render only the latest complete snapshot',()=>{
  const a=fixture();a.rows('Old progress');a.rows('Reconnected progress');a.frame();a.frame();
  assert.equal(a.formats.filter(t=>t==='Old progress').length,0);assert.match(a.html(),/Reconnected progress/);
});
