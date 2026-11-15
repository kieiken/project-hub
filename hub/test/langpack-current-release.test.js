'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),pub=path.join(root,'hub/public');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
function context(lang){const pack=JSON.parse(read('langpacks/'+(lang==='ja'?'en':lang)+'/ui.json'));const c=vm.createContext({HUB_LOCALE:{locale:lang,messages:pack},document:{addEventListener(){},querySelectorAll:()=>[],documentElement:{style:{setProperty(){}}}},setInterval(){},localStorage:{getItem(){return null;}},esc:s=>String(s).replace(/[<>&"']/g,x=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[x]))});vm.runInContext(read('hub/public/locale.js')+'\nconst UI=HubI18n;',c);return c;}
const fixture={roles:{roles:[]},roleTiers:{revision:'x',data:{roles:{},stops:[]},draft:{},catalogs:{codex:{models:[{id:"gpt-6-luna",efforts:["極高"]}]}},changes:[]},efforts:['極高'],accounts:[]};
for(const lang of ['ja','en','zh-TW'])test(lang+': new tier and Token text is translated without changing data or control values',()=>{
 const c=context(lang);c.state=structuredClone(fixture);c.state.roles.roles=[{name:'日本語の役割 <unsafe>',main:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}}];c.state.roleTiers.draft[c.state.roles.roles[0].name]={light:{ai:'codex',model:'gpt-6-luna',effort:'極高'}};c.rolesDraft=c.state.roles.roles;c.AI_LABEL={codex:'Codex'};
 vm.runInContext(read('hub/public/role-tiers.js'),c);vm.runInContext(read('hub/public/app-token-usage.js'),c);
 const tier=c.roleTiersHtml(),token=c.tokenUsageHtml({acknowledgementToken:'a'.repeat(64),snapshot:{updated:0,providers:{codex:{input:1,cache:1,tools:2}},unacknowledgedAlerts:[{id:'a',total:3}],alertCount:1,coverage:{},alerts:[],daily:{}}});
 a.match(tier,/日本語の役割 &lt;unsafe&gt;/);a.match(tier,/value="gpt-6-luna"/);a.match(tier,/value="on"/);a.match(tier,/value="stopped"/);a.match(token,/data-token-ack-all="a{64}"/);
 a.ok(tier.includes(c.HubI18n.text('仕事の難しさで分ける')));a.ok(token.includes(c.HubI18n.text('すべて確認済みにする')));a.ok(token.includes(c.HubI18n.text('キャッシュ命中率')));
 a.equal(c.tokenCacheRate({input:1,cache:1}),'50.0%');a.match(c.tokenAmount(1),lang==='en'?/less than 0.01M/:lang==='zh-TW'?/不到 0.01 百萬/:/0.01百万未満/);
 if(lang==='ja'){
  const before=vm.createContext({...c,state:structuredClone(c.state)});
  vm.runInContext(cp.execFileSync('git',['show','3c258dcc:hub/public/role-tiers.js'],{cwd:root,encoding:'utf8'}),before);
  a.equal(tier,before.roleTiersHtml(),'Japanese tier markup and opaque values match the approved baseline');
 }
});
test('new backend translations preserve API values and review parser delimiters',()=>{
 for(const lang of ['en','zh-TW']){
  const pack=JSON.parse(read('langpacks/'+lang+'/backend.json')).messages;
  const lt=(s,...values)=>{const key=Array.isArray(s)?s.map((x,i)=>x+(i<values.length?'${'+i+'}':'')).join(''):s;return (pack[key]||key).replace(/\$\{(\d+)\}/g,(_,i)=>String(values[i]));};
  const mod={exports:{}};const req=x=>x==='./locale'?{lt}:require(path.resolve(root,'hub/lib',x));
  const c=vm.createContext({module:mod,exports:mod.exports,require:x=>x.startsWith('.')?req(x):require(x)});
  vm.runInContext(read('hub/lib/role-tier-review.js'),c);a.deepEqual(JSON.parse(JSON.stringify(mod.exports.parse('[[段の見直し結果]]\n{"tiers":{}}\n[[/段の見直し結果]]'))),{tiers:{}});
  a.notEqual(mod.exports.basePrompt,'役割の段の見直し案を作ります。公式資料は検索・参照できます。ファイル編集・CLI起動・委任・購入・API従量課金・認証変更は禁止。設定は人の承認後だけHubが保存します。');
  const tier=pack[Object.keys(pack).find(k=>k.startsWith('【段分け】'))];a.ok(tier.includes('軽い/標準/難しい'));a.ok(tier.includes('role'));a.ok(tier.includes('model'));
 }
});
