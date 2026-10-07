'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const definitions=[{question:'記事の価格は？',options:['500円（おすすめ）','300円'],multi:false},{question:'返金は？',options:['受け付ける','受け付けない'],multi:false}];
const classes=(...initial)=>{const set=new Set(initial);return {contains:x=>set.has(x),add:(...x)=>x.forEach(v=>set.add(v)),remove:x=>set.delete(x),toggle(x,on){on=on===undefined?!set.has(x):on;on?set.add(x):set.delete(x);}};};
function fixture(asks=definitions,send=async()=>true){
 const context=vm.createContext({UI:require('./ui-locale-fixture')(),esc,richText:esc,view:{project:'p',task:'t'},document:{querySelectorAll:()=>[]}});
 vm.runInContext(source.slice(source.indexOf('// 質問ごとに選択'),source.indexOf('// かかった時間：')),context);
 const handlers={},box={addEventListener:(event,cb)=>handlers[event]=cb};
 const key=JSON.stringify(['p','t',asks]),status={textContent:''},submit={textContent:'',disabled:false};
 const ask={dataset:{askKey:key},classList:classes('ask')};
 const qs=asks.map(a=>{
  const q={dataset:{q:a.question,multi:a.multi?'1':'0'}};
  const free={value:'',disabled:false,focus(){this.focused=true;},matches:x=>x==='.ask-free',closest:()=>ask};
  const opts=a.options.map(o=>({dataset:{ask:o},disabled:false,classList:classes('ask-o'),attributes:{},setAttribute(k,v){this.attributes[k]=v;},closest:s=>s==='.ask-q'?q:s==='.ask-o'?opts.find(b=>b.dataset.ask===o):s==='.ask'?ask:null}));
  q.querySelector=s=>s==='.ask-free'?free:null;
  q.querySelectorAll=s=>s==='.ask-o.on'?opts.filter(b=>b.classList.contains('on')):s==='.ask-o'?opts:[];
  return Object.assign(q,{free,opts});
 });
 submit.closest=s=>s==='.ask'?ask:s==='.ask-send'?submit:null;
 ask.querySelector=s=>s==='.ask-status'?status:s==='.ask-send'?submit:null;
 ask.querySelectorAll=s=>s==='.ask-q'?qs:s==='.ask-free'?qs.map(q=>q.free):s==='button, textarea'?[submit,...qs.flatMap(q=>[...q.opts,q.free])]:[];
 context.bindAskAnswers(box,send);
 return {context,ask,qs,status,submit,handlers,key,click:target=>handlers.click({target}),input(i,text){qs[i].free.value=text;handlers.input({target:qs[i].free});},draft:()=>vm.runInContext('askDrafts',context).get(key)};
}
test('each question has escaped free input and one explicit send button, even for one question',()=>{
 const f=fixture(),html=f.context.askHtml(definitions);assert.equal((html.match(/class="ask-free"/g)||[]).length,2);assert.equal((html.match(/class="btn sm ask-send"/g)||[]).length,1);
 assert.match(f.context.askHtml([definitions[0]]),/ask-send/);
 f.input(1,'</textarea><script>x</script>');const restored=f.context.askHtml(definitions);assert.match(restored,/&lt;\/textarea&gt;&lt;script&gt;x&lt;\/script&gt;/);assert.doesNotMatch(restored,/<script>/);
});
test('mixed selected and free answers are sent together once, no immediate send on option click',async()=>{
 const sent=[],f=fixture(definitions,async text=>{sent.push(text);return true;});
 await f.click(f.qs[0].opts[0]);assert.equal(sent.length,0);assert.equal(f.qs[0].opts[0].attributes['aria-pressed'],'true');
 f.input(1,'条件付きで受け付ける\n購入から7日以内');await f.click(f.submit);
 assert.deepEqual(sent,['記事の価格は？：500円\n\n返金は？：条件付きで受け付ける\n購入から7日以内']);
 assert.ok(f.ask.classList.contains('done'));assert.equal(f.draft(),undefined);assert.equal(f.qs[1].free.disabled,true);
 await f.click(f.submit);assert.equal(sent.length,1);
});
test('single choice switches/deselects, multiple choice plus supplement remains grouped',async()=>{
 const defs=[definitions[0],{question:'必要な物（複数可）',options:['資料','図','表'],multi:true}],sent=[];
 const f=fixture(defs,async text=>{sent.push(text);return true;});
 await f.click(f.qs[0].opts[0]);await f.click(f.qs[0].opts[1]);assert.equal(f.qs[0].opts[0].classList.contains('on'),false);
 await f.click(f.qs[0].opts[1]);assert.equal(f.qs[0].opts[1].classList.contains('on'),false);f.input(0,'400円');
 await f.click(f.qs[1].opts[0]);await f.click(f.qs[1].opts[2]);f.input(1,'原文は残してください');await f.click(f.submit);
 assert.equal(sent[0],'記事の価格は？：400円\n\n必要な物（複数可）：資料、表\n自由入力：原文は残してください');
});
test('missing answer prevents partial send and focuses the unanswered question',async()=>{
 let calls=0;const f=fixture(definitions,async()=>{calls++;return true;});await f.click(f.qs[0].opts[0]);f.input(1,'  \n ');await f.click(f.submit);
 assert.equal(calls,0);assert.match(f.status.textContent,/質問2/);assert.ok(f.qs[1].free.focused);assert.ok(f.draft());
});
test('pending requests prevent double send; false or thrown failure retains exact drafts and enables retry',async()=>{
 let finish,calls=0;const f=fixture(definitions,async()=>{calls++;return new Promise(resolve=>finish=resolve);});
 f.input(0,'700円');f.input(1,'　自由回答\n2行目');const pending=f.click(f.submit);assert.ok(f.submit.disabled);assert.ok(f.qs[0].free.disabled);
 await f.click(f.submit);assert.equal(calls,1);finish(false);await pending;assert.equal(f.submit.disabled,false);assert.ok(!f.ask.classList.contains('done'));assert.equal(f.draft()[1].free,'　自由回答\n2行目');assert.match(f.status.textContent,/残っています/);
 const html=f.context.askHtml(definitions);assert.match(html,/700円/);assert.match(html,/　自由回答\n2行目/);
 const g=fixture(definitions,async()=>{throw Error('offline');});g.input(0,'a');g.input(1,'b');await g.click(g.submit);assert.equal(g.submit.disabled,false);assert.match(g.status.textContent,/offline/);assert.ok(g.draft());
});
test('drafts are scoped by project/task and the actual question set; historical fields are disabled',()=>{
 const f=fixture();f.input(0,'draft');assert.match(f.context.askHtml(definitions),/draft/);f.context.view.task='other';assert.doesNotMatch(f.context.askHtml(definitions),/>draft<\/textarea>/);
 f.context.view.task='t';assert.doesNotMatch(f.context.askHtml([{...definitions[0],question:'別の質問'}]),/>draft<\/textarea>/);
 const old={id:'',contains:()=>false},last={id:'',contains:()=>false},box={querySelectorAll:s=>s==='.m'?[old,last]:[f.ask]};f.context.refreshAsks(box);assert.ok(f.qs.every(q=>q.free.disabled));
});

test('a redraw during send unlocks the current fields on failure and marks the current question answered on success',async()=>{
 for(const accepted of [false,true]){
  let finish;const f=fixture(definitions,async()=>new Promise(resolve=>finish=resolve));f.input(0,'a');f.input(1,'b');const pending=f.click(f.submit);
  const next=fixture();next.qs.forEach(q=>q.free.disabled=true);next.submit.disabled=true;f.context.document.querySelectorAll=()=>[next.ask];
  finish(accepted);await pending;assert.equal(next.qs[0].free.disabled,accepted);assert.equal(next.ask.classList.contains('done'),accepted);
  assert.match(next.status.textContent,accepted?/送信しました/:/残っています/);
 }
});

test('上部や通常欄からの送信中も、下部の選択肢と補足を操作できない',()=>{
 const f=fixture();f.context.chatSending=new Set([JSON.stringify(['p','t'])]);f.context.updateAskControls(f.ask);assert.equal(f.submit.disabled,true);assert.ok(f.qs.every(q=>q.free.disabled&&q.opts.every(o=>o.disabled)));f.context.chatSending.clear();f.context.updateAskControls(f.ask);assert.equal(f.submit.disabled,false);
});

test('失敗対象だけを再操作可能にし、新質問・別作業・受付済みを復活させない',()=>{
 const f=fixture(),t={question:'原文'},work=JSON.stringify(['p','t']);f.context.proj=()=>({});f.context.taskOf=()=>t;
 const attempts=vm.runInContext('askAttempts',f.context);attempts.set(work,{question:'原文',askKey:f.key});
 const history=fixture([{...definitions[0],question:'過去'}]).ask;
 const rows=[{contains:a=>a===f.ask||a===history},{contains:()=>false}],asks=[history,f.ask],box={querySelectorAll:s=>s==='.m'?rows:asks};
 f.context.refreshAsks(box);assert.equal(f.submit.disabled,false);assert.equal(history.classList.contains('done'),true);
 // 同じ質問のDOMが再構築されても入力draftの識別子を保つ。
 const redraw=fixture();asks[1]=redraw.ask;f.context.refreshAsks(box);assert.equal(redraw.submit.disabled,false);
 t.question='新しい質問';f.context.refreshAsks(box);assert.equal(redraw.submit.disabled,true);assert.equal(attempts.size,0);
 t.question='原文';attempts.set(work,{question:'原文',askKey:f.key});f.context.view.task='別作業';f.context.refreshAsks(box);assert.equal(redraw.submit.disabled,true);
 f.context.view.task='t';redraw.ask.classList.add('answered');f.context.refreshAsks(box);assert.equal(redraw.submit.disabled,true);assert.equal(attempts.size,0);
});

test('遅い失敗通知が来ても後続の新しい質問を優先する',()=>{
 const f=fixture(),newer=fixture([{question:'次の質問',options:['はい'],multi:false}]);f.context.proj=()=>({});f.context.taskOf=()=>({question:'原文'});
 const attempts=vm.runInContext('askAttempts',f.context);attempts.set(JSON.stringify(['p','t']),{question:'原文',askKey:f.key});
 const box={querySelectorAll:s=>s==='.m'?[{contains:a=>a===f.ask},{contains:a=>a===newer.ask}]:[f.ask,newer.ask]};f.context.refreshAsks(box);assert.equal(f.submit.disabled,true);assert.equal(newer.submit.disabled,false);assert.equal(attempts.size,0);
});


test('初期履歴待ちの空DOMだけで再送対象を消さず、取得済み履歴と原文変更では失効させる',()=>{
 const f=fixture(),t={question:'原文'},work=JSON.stringify(['p','t']);f.context.proj=()=>({});f.context.taskOf=()=>t;
 const attempts=vm.runInContext('askAttempts',f.context),attempt={question:'原文',askKey:f.key};
 const box={dataset:{askHistoryPending:'1'},querySelectorAll:()=>[]};attempts.set(work,attempt);
 f.context.refreshAsks(box);assert.equal(attempts.get(work),attempt);
 f.context.chatSending=new Set([work]);box.querySelectorAll=s=>s==='.m'?[{contains:a=>a===f.ask},{contains:()=>false}]:[f.ask];
 delete box.dataset.askHistoryPending;f.context.refreshAsks(box);assert.equal(f.submit.disabled,true);assert.equal(f.ask.classList.contains('done'),false);
 f.context.chatSending.clear();f.context.refreshAsks(box);assert.equal(f.submit.disabled,false);
 box.querySelectorAll=()=>[];f.context.refreshAsks(box);assert.equal(attempts.size,0,'履歴取得後に対象が無い場合は失効');
 box.dataset.askHistoryPending='1';attempts.set(work,attempt);t.question='新質問';f.context.refreshAsks(box);assert.equal(attempts.size,0,'履歴待ちでも原文変更は確定情報');
 attempts.set(work,attempt);t.question='';f.context.refreshAsks(box);assert.equal(attempts.size,0,'解除済みも復活させない');
});


test('プロジェクト化した自由対話の質問は読取専用で、下書きを保持して送信を無効化',()=>{
 const f=fixture();f.input(0,'元の下書き');f.ask.closest=()=>({dataset:{readonly:'true'}});f.context.updateAskControls(f.ask);
 assert.equal(f.submit.disabled,true);assert.ok(f.qs.every(q=>q.free.disabled&&q.opts.every(o=>o.disabled)));assert.equal(f.draft()[0].free,'元の下書き');
});
