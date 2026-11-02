'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=require('../../../hub/test/fixtures/app-source.cjs').readApp();
const code=source.slice(source.indexOf('// 場所を押した時は開き方を選ぶ。'),source.indexOf('// コマンドなどの細かい作業を会話に出すか'));
function fixture(inApp=false,info={},locale='ja') {
 const elements=new Map(),events=new Map(),windowEvents=new Map(),calls=[],notices=[];
 const node=()=>({innerHTML:'',hidden:true,inert:false,isConnected:true,dataset:{},style:{position:'',top:'',left:'',width:'',overflow:''},handlers:{},attributes:{},children:[],
  setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,f){this.handlers[k]=f;},
  querySelector(s){return this.parts?.get(s)||((this.parts||=new Map()).set(s,node()).get(s));},
  querySelectorAll(s){return s==='[data-fv-close]'?[this.querySelector(s),this.querySelector('.fv-mobile-close')]:[];},
  replaceChildren(...kids){this.children=kids;},focus(options){this.focused=options;doc.activeElement=this;},blur(){doc.activeElement=doc.body;},
  remove(){this.isConnected=false;doc.body.children=doc.body.children.filter(x=>x!==this);}});
 const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const doc={body:node(),createElement:node,addEventListener:(name,f)=>events.set(name,f)};
 doc.body.insertAdjacentHTML=()=>{};doc.body.appendChild=n=>doc.body.children.push(n);
 doc.body.children=[el('#conversation'),el('#fsheet'),el('#draft')];
 const win={scrollX:0,scrollY:240,focus(){},addEventListener:(k,f)=>windowEvents.set(k,f),scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
 const history={state:{original:true},pushState(s){this.previous=this.state;this.state=s;},back(){this.state=this.previous;windowEvents.get('popstate')();},replaceState(s){this.state=s;}};
 const ctx=vm.createContext({UI:require('./ui-locale-fixture')(locale),navigator:{userAgent:inApp?'ProjectHubApp':''},location:{href:''},view:{project:'p &',task:'t/'},$:el,
  window:win,document:doc,history,AbortController,setTimeout,clearTimeout,
  fetch:async()=>({ok:true,text:async()=>'<script>bad()</script>\n文字'}),
  esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  toast:x=>notices.push(x),copyText:x=>notices.push(x),
  api:async(route,b)=>{calls.push({route,...b});return {ok:true,path:'/Users/test/資料 <元>/記事.md',dir:false,how:b.how,...info};}});
 vm.runInContext(code,ctx);
 const click=dataset=>events.get('click')({target:{closest:()=>({dataset,classList:{contains:()=>false}})}});
 return {ctx,el,calls,notices,click,events,windowEvents,history,doc,win};
}
test('繁体中文でも画像と外からの説明が翻訳される',async()=>{
 for(const remote of [false,true]) {
  const f=fixture(false,{view:true,remote},'zh-TW');await f.ctx.showPath('資料/画像.png');const html=f.el('#fsheet').innerHTML;
  assert.match(html,/查看圖片/);assert.match(html,/可在此畫面查看圖片/);
  if(remote)assert.match(html,/僅能在這台 Mac 前使用/);else assert.match(html,/開啟原始檔案/);
  assert.doesNotMatch(html,/この画面|画像を見る|Macの画面で/);
 }
});

test('PDF・テキスト・Wordは開くボタンで閲覧し、画像プレビューを出さない',async()=>{
 for(const kind of ['pdf','text','doc'])for(const locale of ['zh-TW']) {
  const f=fixture(false,{view:true,viewKind:kind,remote:true},locale);await f.ctx.showPath('資料/文書');
  const html=f.el('#fsheet').innerHTML;
  assert.match(html,new RegExp('data-view-kind="'+kind+'"'));
  assert.match(html,locale==='ja'?/>開く<\/button>/:/>開啟<\/button>/);
  assert.doesNotMatch(html,/target="_blank"|fs-img|data-fs-open|data-fs-finder/);
  if(kind==='doc')assert.match(html,locale==='ja'?/複雑な表/:/複雜表格/);
 }
});
test('対象外形式と容量超過の遠隔案内は日繁で閲覧ボタンを出さない',async()=>{
 for(const locale of ['zh-TW']) {
  const f=fixture(false,{view:false,viewKind:'',remote:true},locale);await f.ctx.showPath('資料/対象外.xlsx');
  const html=f.el('#fsheet').innerHTML;
  assert.match(html,locale==='ja'?/この形式はスマホでは開けません/:/手機無法開啟此格式/);
  assert.doesNotMatch(html,/data-fs-view|data-fs-open|data-fs-finder/);
 }
});
test('iframeの履歴だけが戻りpopstateが無くても閉じるは即座に会話を復元する',async()=>{
 for(const locale of ['zh-TW'])for(const kind of ['doc','pdf']) {
  const f=fixture(false,{},locale);let back=0;
  const sheet=f.el('#fsheet'),chat=f.el('#conversation'),draft=f.el('#draft');
  sheet.hidden=false;sheet.innerHTML='選択画面';chat.scrollTop=140;draft.value='入力中';
  // iframe内の戻るでは親のpopstateが来ない。何度待っても解除不能だった経路。
  f.history.back=()=>{back++;};
  const trigger={isConnected:true,focus(options){this.options=options;}};
  await f.ctx.showFileViewer('/Users/test/文書',kind,trigger);
  const viewer=f.doc.body.children.at(-1);
  viewer.querySelector('[data-fv-close]').handlers.click();
  assert.equal(viewer.isConnected,false);assert.equal(chat.inert,false);assert.equal(f.doc.body.style.position,'');
  assert.equal(chat.scrollTop,140);assert.equal(draft.value,'入力中');assert.equal(sheet.innerHTML,'選択画面');assert.equal(sheet.hidden,false);
  assert.equal(trigger.options.preventScroll,true);assert.equal(f.win.scrollY,240);
  assert.equal(f.history.state.original,true);assert.equal(f.history.state.fviewer,undefined);assert.equal(back,0);
  f.ctx.closeFileViewer();assert.equal(back,0);
 }
});
test('文書とPDF本文のフォーカスから親へ戻しEscの押下または解放で閉じる',async()=>{
 for(const locale of ['zh-TW'])for(const kind of ['doc','pdf'])for(const event of ['keydown','keyup']) {
  const f=fixture(false,{},locale);await f.ctx.showFileViewer('/Users/test/文書',kind,{isConnected:true,focus(){}});
  const viewer=f.doc.body.children.at(-1),button=viewer.querySelector('[data-fv-close]'),frame=viewer.querySelector('.fv-body').children[0];
  assert.equal(frame.tabIndex,-1);f.doc.activeElement=frame;f.windowEvents.get('blur')();
  assert.equal(f.doc.activeElement,button);
  let prevented=false;f.events.get(event)({key:'Escape',preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert.equal(prevented,true);assert.equal(viewer.isConnected,false);assert.equal(f.el('#conversation').inert,false);
  await new Promise(setImmediate);
  assert.equal(viewer.isConnected,false);
 }
});
