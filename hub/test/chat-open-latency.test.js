'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');

function fixture() {
  const a=app(),s=snapshot(),frames=[],calls=[];
  s.projects[0].tasks[0].copy=true;
  s.projects[0].tasks.push({...s.projects[0].tasks[0],id:'other',title:'Other'});
  a.context.data=s;
  a.context.requestAnimationFrame=cb=>frames.push(cb);
  a.context.loadPreview=(p,t)=>calls.push(['preview',p,t]);
  a.context.loadUsage=()=>calls.push(['usage']);
  vm.runInContext('state=data;view={kind:"work",project:"p",task:"t"};render()',a.context);
  return Object.assign(a,{frames,calls,frame(){frames.splice(0).forEach(cb=>cb());},
    rows(rows=[],stream=a.stream()){stream.onmessage({data:JSON.stringify({type:'rows',rows,generation:1,queue:[],busy:null})});}});
}
const message=text=>({role:'assistant',ai:'codex',text,at:'2026-10-24T00:00:00Z'});

test('会話を受け取る前は空会話の案内も取り込み予告も出さず、表示後に補助取得する',()=>{
  const a=fixture();
  assert.match(a.element('#main').innerHTML,/会話を読み込んでいます/);
  assert.doesNotMatch(a.element('#main').innerHTML,/ここでAIと話します/);
  assert.equal(a.context.chatHistoryPending(),true);
  assert.deepEqual(a.calls,[]);
  a.rows([message('届いた会話')]);
  assert.match(a.element('#msgs').innerHTML,/届いた会話/);
  assert.equal(a.context.chatHistoryPending(),false);
  assert.equal(a.element('#msgs').dataset.askHistoryPending,undefined);
  assert.deepEqual(a.calls,[]);
  a.frame();assert.deepEqual(a.calls,[]); // one browser paint opportunity
  a.frame();assert.deepEqual(a.calls,[['preview','p','t'],['usage']]);
  a.rows([message('再接続後')]);a.frame();a.frame();
  assert.equal(a.calls.length,2);
});

test('正常な会話0件と読み込み失敗を区別し、失敗中の質問送信保護を残す',()=>{
  const a=fixture();a.stream().onerror();
  assert.match(a.element('#msgs').innerHTML,/読み込めませんでした.*再試行/);
  assert.equal(a.element('#msgs').dataset.askHistoryPending,'1');
  a.frame();a.frame();assert.equal(a.calls.length,2);
  a.rows();assert.match(a.element('#msgs').innerHTML,/chat-empty/);
  assert.doesNotMatch(a.element('#msgs').innerHTML,/読み込めません/);
  assert.equal(a.element('#msgs').dataset.askHistoryPending,undefined);
  const b=fixture();b.stream().readyState=2;b.stream().onerror();
  assert.match(b.element('#msgs').innerHTML,/開き直してください/);
  assert.doesNotMatch(b.element('#msgs').innerHTML,/再試行しています/);
});

test('切替後に届いた前の会話・失敗通知・描画待ち処理は今の作業を変更しない',()=>{
  const a=fixture(),old=a.stream();a.rows([message('前の会話')]);
  vm.runInContext('view.task="other";render()',a.context);
  const current=a.stream(),html=a.element('#msgs').innerHTML;
  old.onmessage({data:JSON.stringify({type:'rows',rows:[message('古い遅延応答')]})});old.onerror();
  assert.equal(a.element('#msgs').innerHTML,html);
  a.frame();a.frame();assert.deepEqual(a.calls,[]);
  a.rows([message('今の会話')],current);a.frame();a.frame();
  assert.deepEqual(a.calls,[['preview','p','other'],['usage']]);
  assert.match(a.element('#msgs').innerHTML,/今の会話/);
  assert.doesNotMatch(a.element('#msgs').innerHTML,/古い遅延応答/);
});

test('同じ作業への入り直しでも古い描画待ちは補助取得せず、下書きと添付を保持する',()=>{
  const a=fixture();a.element('#chat-in').value='保存する下書き';a.element('#chat-in').handlers.input();
  a.context.chatImages('p','t').push({id:'image-retained',name:'test.png',path:'test.png',url:'/fixture',kind:'image'});
  a.rows([message('前の表示')]);
  a.elements.delete('#chat-in'); // real DOM replacement on re-render
  vm.runInContext('render()',a.context);a.frame();a.frame();assert.deepEqual(a.calls,[]);
  assert.match(a.element('#main').innerHTML,/保存する下書き/);
  assert.equal(a.context.chatImages('p','t')[0].id,'image-retained');
  a.rows([message('新しい表示')]);a.frame();a.frame();assert.equal(a.calls.length,2);
});

test('初回読み込み中の定期更新は取り込み予告を競合させず、受信後は更新する',async()=>{
  const a=fixture();vm.runInContext('fetchState=async()=>null',a.context);
  await a.context.pollState();assert.deepEqual(a.calls,[]);
  a.rows();a.frame();a.frame();a.calls.length=0;
  await a.context.pollState();assert.deepEqual(a.calls,[['preview','p','t']]);
});

test('会話以外の画面では取り込み予告を待たせない',()=>{
  const a=fixture();a.context.localStorage.getItem=k=>k==='hub-mode'?'term':null;
  vm.runInContext('render()',a.context);
  assert.deepEqual(a.calls,[['preview','p','t']]);assert.equal(a.context.chatHistoryPending(),false);
});

test('受信済み会話で切断しても本文と読んでいる位置を保持し、再接続で表示を戻す',()=>{
  const a=fixture(),box=a.element('#msgs'),restores=[];
  a.context.window.HubChatScroll={capture:()=>null,create:()=>({capture:()=>({top:42,follow:false}),rows(){},restore:(p,force)=>restores.push([p.top,p.follow,force]),dispose(){}})};
  vm.runInContext('render()',a.context);a.rows([message('保持する会話')]);
  let added='';box.insertAdjacentHTML=(_where,html)=>{added+=html;};
  a.stream().onerror();assert.match(box.innerHTML,/保持する会話/);assert.match(added,/再接続/);
  assert.deepEqual(restores.at(-1),[42,false,false]);
  a.rows([message('戻った会話')]);assert.match(box.innerHTML,/戻った会話/);
  assert.doesNotMatch(box.innerHTML,/接続が切れました/);
});
