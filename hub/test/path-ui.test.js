'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const code=source.slice(source.indexOf('// 場所を押した時は開き方を選ぶ。'),source.indexOf('// コマンドなどの細かい作業を会話に出すか'));
function fixture(inApp=false) {
 const elements=new Map(),events=new Map(),calls=[],notices=[];
 const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true});return elements.get(id);};
 const ctx=vm.createContext({UI:require('./ui-locale-fixture')(),navigator:{userAgent:inApp?'ProjectHubApp':''},location:{href:''},view:{project:'p',task:'t'},$:el,
  document:{body:{insertAdjacentHTML(){}},addEventListener:(name,f)=>events.set(name,f)},
  esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  toast:x=>notices.push(x),copyText:x=>notices.push(x),
  api:async(route,b)=>{calls.push({route,...b});return {ok:true,path:'/Users/test/資料 <元>/記事.md',dir:false,how:b.how};}});
 vm.runInContext(code,ctx);
 const click=dataset=>events.get('click')({target:{closest:()=>({dataset,classList:{contains:()=>false}})}});
 return {ctx,el,calls,notices,click};
}
test('ファイルを押しても開かず、元ファイル/Finderの選択と場所を表示する',async()=>{
 const f=fixture();await f.ctx.showPath('資料/記事.md');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].how,'info');assert.equal(f.calls[0].path,'資料/記事.md');
 const html=f.el('#fsheet').innerHTML;
 assert.match(html,/元のファイルを開く/);assert.match(html,/Finderで表示/);assert.match(html,/コピーを作らず/);
 assert.match(html,/data-fs-open="\/Users\/test\/資料 &lt;元&gt;\/記事.md"/);
 assert.doesNotMatch(html,/ダウンロード/);assert.equal(f.ctx.location.href,'');assert.equal(f.notices.length,0);
});
test('選んだ時だけ元ファイルを開くかFinderで表示するAPIを送る',async()=>{
 const f=fixture();const original='/Users/test/資料 <元>/記事.md';
 await f.click({fsOpen:original});await f.click({fsFinder:original});
 assert.deepEqual(f.calls.map(x=>({path:x.path,how:x.how,app:x.app})),[{path:original,how:'open',app:false},{path:original,how:'finder',app:false}]);
});
test('Macアプリでも選択前は開かず、選択後に元の場所をアプリへ渡す',async()=>{
 const f=fixture(true),original='/Users/test/空 白/原文.png';
 f.ctx.api=async(route,b)=>{f.calls.push({route,...b});return {ok:true,path:original,dir:false,how:b.how,...(b.how==='info'?{}:{byApp:true})};};
 await f.ctx.showPath(original);assert.equal(f.ctx.location.href,'');
 await f.click({fsOpen:original});
 assert.equal(f.ctx.location.href,'hubapp://reveal?dir=0&open=1&path='+encodeURIComponent(original));
 await f.click({fsFinder:original});
 assert.equal(f.ctx.location.href,'hubapp://reveal?dir=0&open=0&path='+encodeURIComponent(original));
});
test('フォルダはFinder/中身を見るを選び、一覧のファイルも開き方を選ぶ',async()=>{
 const f=fixture(),folder='/Users/test/資料';
 f.ctx.api=async(route,b)=>{f.calls.push({route,...b});return {ok:true,path:b.path,dir:b.path===folder,how:b.how,...(b.how==='list'?{entries:[{name:'記事.md',path:folder+'/記事.md',dir:false,size:20}],parent:'/Users/test'}:{})};};
 await f.ctx.showPath(folder);
 assert.match(f.el('#fsheet').innerHTML,/Finderで開く/);assert.match(f.el('#fsheet').innerHTML,/中身を見る/);
 assert.doesNotMatch(f.el('#fsheet').innerHTML,/data-fs-open/);
 await f.click({fsList:folder});assert.equal(f.calls.at(-1).how,'list');
 assert.match(f.el('#fsheet').innerHTML,/data-fs-file/);assert.match(f.el('#fsheet').innerHTML,/data-fs-list="\/Users\/test"/);
 await f.click({fsFile:folder+'/記事.md'});assert.equal(f.calls.at(-1).how,'info');
 assert.match(f.el('#fsheet').innerHTML,/元のファイルを開く/);
 await f.click({fsDir:folder});assert.equal(f.calls.at(-1).how,'info');
});
test('読み取り失敗は理由を知らせ、開いたことにせず選択画面も出さない',async()=>{
 const f=fixture();f.ctx.api=async()=>{throw Error('見つかりません');};
 await f.ctx.showPath('/missing');assert.deepEqual(f.notices,['見つかりません']);
 assert.equal(f.el('#fsheet').hidden,true);assert.equal(f.ctx.location.href,'');
});
