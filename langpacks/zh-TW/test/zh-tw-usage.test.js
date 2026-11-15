'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../../hub/public/usage.js'),'utf8');
const NOW=Date.parse('2026-10-03T00:00:00Z');
const snapshot={providers:{codex:{status:'ok',fetchedAt:new Date(NOW).toISOString(),windows:[{id:'codex:primary',label:'週間枠',usedPercent:0,resetsAt:'2026-10-04T00:00:00Z'}]},claude:{status:'unavailable',message:'CLIが見つかりません',attemptedAt:new Date(NOW).toISOString()}}};
function app(language='ja'){
  const elements=new Map(),events=new Map();
  const media={matches:false,addEventListener(n,cb){events.set('media:'+n,cb);}};
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:id==='#usage-drawer',get textContent(){return this.innerHTML.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&quot;/g,'"').replace(/&amp;/g,'&');},set textContent(v){this.innerHTML=String(v);},innerHTML:'',addEventListener(n,cb){events.set(id+':'+n,cb);},setAttribute(n,v){this[n]=v;},focus(){this.focused=true;}});return elements.get(id);};
  const c=vm.createContext({$:el,esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),api:()=>new Promise(()=>{}),document:{hidden:false,addEventListener(n,cb,capture){events.set(n+(capture?':capture':''),cb);}},matchMedia(query){assert.equal(query,'(max-width: 900px)');return media;},setInterval(){},console});
  if(language==='zh-TW'){
    c.HUB_LOCALE={locale:language,messages:require('../ui.json')};
    c.document.documentElement={};c.document.querySelectorAll=()=>[];
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../hub/public/locale.js'),'utf8'),c);
  }
  vm.runInContext(source,c);return{c,el,events,media};
}
test('繁体字のチケット操作とClaude案内を翻訳し、アカウント名・チケット名・識別子は保持する',()=>{
  const a=app('zh-TW'),p={...snapshot.providers.codex,account:'work',accountName:'日本語の名前',resetCredits:{count:1,items:[{title:'日本語のチケット名',expiresAt:null,action:{token:'opaque-token'}}]}};
  const html=a.c.usageHtml({accountProviders:[{ai:'codex',...p},{ai:'claude',status:'unavailable'}]},NOW);
  assert.match(html,/>使用<\/button>/);assert.match(html,/開啟使用狀況/);assert.match(html,/可在 Claude 的設定頁面/);assert.match(html,/請核對瀏覽器中的帳號/);
  assert.doesNotMatch(html,/リセットチケットはClaude|利用状況を開く|期限切れのチケットは使えません/);
  assert.match(html,/日本語の名前/);assert.match(html,/日本語のチケット名/);assert.match(html,/data-reset-account="work" data-reset-token="opaque-token"/);
  const expired=a.c.usageExtras('codex',{...p,resetCredits:{count:1,items:[{title:'Expired',expiresAt:new Date(NOW-1).toISOString()}]}},NOW);
  assert.match(expired,/已過期的票券無法使用/);
});
test('Claude追加利用は本月の金額と上限・利用できない状態を繁体字で表示する',()=>{
  const a=app('zh-TW'),p={status:'ok',extraUsage:{is_enabled:true,used_credits:1234,monthly_limit:5000,currency:'USD'}};
  const html=a.c.usageExtras('claude',p,NOW);
  assert.match(html,/額外用量：本月 USD\s*12\.34 \/ 上限 USD\s*50\.00/);
  assert.doesNotMatch(html,/追加利用|今月/);
  const disabled=a.c.usageExtras('claude',{...p,extraUsage:{...p.extraUsage,is_enabled:false}},NOW);
  assert.match(disabled,/額外用量：目前無法使用（本月 USD\s*12\.34 \/ 上限 USD\s*50\.00）/);
  const missing=a.c.usageExtras('claude',{...p,extraUsage:{is_enabled:false}},NOW);
  assert.match(missing,/額外用量：目前無法使用/);assert.doesNotMatch(missing,/USD|本月|追加利用|未啟用/);
});
