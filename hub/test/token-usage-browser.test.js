'use strict';
// Offline, synthetic settings fixture: no running Hub, accounts or AI access.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||[path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
for(const locale of ['ja','en','zh-TW'])test('Token settings render, preserve drafts, save and acknowledge offline: '+locale,{skip:!chromium||!chrome},async t=>{
 const root=path.resolve(__dirname,'../public'),state=snapshot(),errors=[];
 Object.assign(state,{efforts:['中','高'],unread:[],hiddenModels:{},modelOrder:[],museSupported:true});state.roles.models={codex:['GPT-6.1-Sol'],'claude-code':['Opus 5.5'],agy:[]};
 const ext=require('../lib/extensions').loadExtensions({hub:path.resolve(__dirname,'..')}),generated={'/extensions-ui.js':ext.uiSource(),'/extensions-ui.css':ext.uiSource('style'),'/locale-config.js':'/* synthetic locale */'};
 const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(u.pathname==='/api/state'?state:{}));}if(Object.hasOwn(generated,u.pathname)){res.setHeader('Content-Type',u.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(generated[u.pathname]);}const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
 let browser;t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});const page=await browser.newPage({viewport:{width:1024,height:850}});page.setDefaultTimeout(6000);await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({locale,messages})=>{window.HUB_LOCALE={locale,messages};window.EventSource=class{close(){}};},{locale,messages:locale==='ja'?{}:require('../../langpacks/'+locale+'/ui.json')});await page.goto(base);await page.waitForFunction(()=>typeof renderSettings==='function'&&state?.projects?.length);
 await page.evaluate(async()=>{
  for(const name of ['loadAiTools','loadSkills','loadAppUpdate','loadCliModels','loadRemote','loadGithub','loadLanguageSettings','loadMoveSettings','loadMuseSettings','loadJevSettings','loadChatgpt','refreshEmergencyStatus','autoCheckRoleAccounts'])window[name]=()=>{};
  window.tokenCalls=[];window.fixtureToken={running:false,revision:0,limits:{},snapshot:{updated:Date.now(),timezone:'Asia/Tokyo',total:3000000,peak:2000000,streak:2,daily:{'2026-11-12':{total:1000000},'2026-11-14':{total:2000000}},models:{'codex / synthetic':{total:3000000,input:100,cache:300,write:100,tools:15}},providers:{codex:{total:3000000,input:100,cache:300,write:100,tools:15}},coverage:{},alerts:[{id:'a'.repeat(64),kind:'daily',ai:'codex',day:'2026-11-14',total:2000000,work:[{name:'Synthetic project / synthetic task',total:2000000}]}],alertCount:1}};
  api=async(route,body)=>{tokenCalls.push({route,body});if(route==='/api/token-usage/limits'){fixtureToken={...fixtureToken,limits:body.limits,revision:fixtureToken.revision+1,pending:true};}if(route==='/api/token-usage/acknowledge'){fixtureToken={...fixtureToken,pending:false,snapshot:{...fixtureToken.snapshot,alertCount:0,alerts:fixtureToken.snapshot.alerts.map(a=>({...a,acknowledged:true}))}};}return route.startsWith('/api/token-usage')?fixtureToken:{};};
  aiTools={};view={kind:'settings',project:'p',task:null};renderSettings();selectSettingsTab('ai',true);await loadTokenUsage();
 });
 assert.equal(await page.locator('#token-usage-badge').count(),0);assert.equal(await page.locator('#gear').isVisible(),true);assert.equal(await page.locator('#token-usage-box').isVisible(),true);assert.equal(await page.locator('#token-usage-box').evaluate(el=>Boolean(el.closest('.settings-layout-more'))),false);
 for(const width of [320,375,1024]){await page.setViewportSize({width,height:850});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.locator('#token-usage-box details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));const measure=await page.locator('#token-usage-box').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,parents:[el,...function*(e){while(e.parentElement){e=e.parentElement;yield e;}}(el)].slice(0,7).map(x=>({tag:x.tagName,cls:x.className,hidden:x.hidden,display:getComputedStyle(x).display,w:x.getBoundingClientRect().width}))}));assert.ok(measure.scroll<=measure.width+2,JSON.stringify({width,...measure}));assert.ok(await page.locator('[name="codex-daily"]').isVisible());}
 await page.locator('[name="codex-daily"]').fill('1234567');await page.evaluate(async()=>{fixtureToken.revision=9;await loadTokenUsage();});assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'1234567');await page.locator('[data-token-mode]').selectOption('week');assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'1234567');
 if(locale==='ja'){
  assert.equal(await page.locator('[data-token-unit]').inputValue(),'mixed');
  assert.match(await page.locator('.token-metrics').textContent(),/60.0%/);
  assert.match(await page.locator('.token-metrics').textContent(),/ツール呼び出し（回数）15/);
  assert.equal(await page.locator('[data-token-amount="3000000"]').first().getAttribute('title'),'3,000,000');
  await page.locator('[data-token-unit]').selectOption('oku');
  assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'1234567');
  assert.equal(await page.locator('[data-token-amount="3000000"]').first().textContent(),'0.03億');
  assert.equal(await page.evaluate(()=>localStorage.getItem('hub-token-unit')),'oku');
  await page.locator('[data-token-unit]').selectOption('million');
  assert.equal(await page.locator('[data-token-amount="3000000"]').first().textContent(),'3百万');
 }
 await page.locator('[data-token-limits] button[type="submit"]').click();const save=await page.evaluate(()=>tokenCalls.find(x=>x.route==='/api/token-usage/limits'));assert.equal(save.body.revision,0);assert.equal(save.body.limits.codex.daily,1234567);assert.equal(save.body.limits.claude.run,null);
 await page.evaluate(()=>{fixtureToken.pending=false;document.activeElement.blur();});await page.evaluate(()=>loadTokenUsage());await page.locator('[name="claude-run"]').fill('55');await page.locator('[data-token-ack]').click();assert.equal(await page.locator('[name="claude-run"]').inputValue(),'55');assert.equal(await page.evaluate(()=>tokenCalls.filter(x=>x.route==='/api/token-usage/acknowledge').length),1);
 await page.evaluate(()=>{document.querySelector('[data-token-limits]').dataset.dirty='';document.activeElement.blur();});await page.evaluate(()=>loadTokenUsage());assert.equal(await page.locator('[data-token-ack]').count(),0);assert.equal(await page.locator('#token-usage-badge').count(),0);assert.equal(await page.evaluate(()=>tokenCalls.some(x=>x.route==='/api/token-usage/alerts')),false);
 if(locale==='ja'){
  await page.evaluate(async()=>{
   const alerts=Array.from({length:305},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),total:1000000+i,kind:'run',ai:'claude',day:'2026-11-14',historical:i>=290}));
   fixtureToken={...fixtureToken,revision:10,pending:false,acknowledgementToken:'b'.repeat(64),snapshot:{...fixtureToken.snapshot,alerts:alerts.slice(0,300),unacknowledgedAlerts:alerts.map(({id,total})=>({id,total})),alertTotal:305,alertCount:290,historicalAlertCount:15}};
   const previous=api;window.bulkFail=false;api=async(route,body)=>{
    if(route!=='/api/token-usage/acknowledge-all')return previous(route,body);
    tokenCalls.push({route,body});await new Promise(r=>window.releaseBulk=r);if(bulkFail)throw Error('synthetic conflict');
    fixtureToken={...fixtureToken,revision:11,pending:true};return fixtureToken;
   };
   document.activeElement.blur();await loadTokenUsage();
  });
  assert.match(await page.locator('[data-token-alert-list]').textContent(),/過去の記録を含む未確認：305/);
  for(const width of [320,375,1024]){await page.setViewportSize({width,height:850});const measure=await page.locator('#token-usage-box').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(measure.scroll<=measure.width+2,JSON.stringify({width,...measure}));assert.equal(await page.locator('[data-token-ack-all]').count(),1);}
  assert.equal(await page.locator('[data-token-ack]').count(),300);assert.match(await page.locator('[data-token-alert-list]').textContent(),/表示されていない過去の未確認も対象/);
  await page.locator('[name="codex-daily"]').fill('9876543');
  // Put the button in view first, then measure only movement caused by the operation.
  await page.locator('[data-token-ack-all]').scrollIntoViewIfNeeded();
  const before=await page.evaluate(()=>{document.querySelectorAll('#token-usage-box details').forEach(n=>n.open=true);const box=document.querySelector('#token-usage-box'),sc=tokenUsageScroller(box);window.savedBulkForm=box.querySelector('[data-token-limits]');return {top:sc.scrollTop,open:box.querySelectorAll('details[open]').length};});
  await page.evaluate(()=>{const b=document.querySelector('[data-token-ack-all]');b.click();b.click();document.querySelector('[data-token-ack]').click();});
  await page.waitForFunction(()=>typeof releaseBulk==='function');
  assert.equal(await page.evaluate(()=>tokenCalls.filter(x=>x.route==='/api/token-usage/acknowledge-all').length),1);
  assert.equal(await page.locator('[data-token-ack-all]').isDisabled(),true);assert.equal(await page.locator('[data-token-ack]').first().isDisabled(),true);
  await page.evaluate(()=>{bulkFail=true;releaseBulk();});await page.waitForFunction(()=>!tokenAckBusy);
  assert.match(await page.locator('[data-token-ack-status]').textContent(),/確認済みにできませんでした/);assert.equal(await page.locator('[data-token-ack-all]').isEnabled(),true);
  assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'9876543');
  // A polling read started before the write must not replace the pending result afterwards.
  await page.evaluate(()=>{const previous=api;let held=false;api=async(route,body,...rest)=>{if(route==='/api/token-usage'&&!held){held=true;const stale=structuredClone(fixtureToken);await new Promise(r=>window.releaseStaleTokenRead=r);return stale;}return previous(route,body,...rest);};void loadTokenUsage();});await page.waitForFunction(()=>typeof releaseStaleTokenRead==='function');
  await page.evaluate(()=>{bulkFail=false;delete window.releaseBulk;document.querySelector('[data-token-ack-all]').click();});await page.waitForFunction(()=>typeof releaseBulk==='function');
  await page.evaluate(()=>releaseBulk());await page.waitForFunction(()=>!tokenAckBusy);
  assert.equal(await page.locator('[data-token-ack-all]').isDisabled(),true);assert.match(await page.locator('[data-token-ack-status]').textContent(),/集計中/);
  await page.evaluate(()=>releaseStaleTokenRead());await page.waitForFunction(()=>!tokenUsageBusy);assert.equal(await page.locator('[data-token-ack-all]').isDisabled(),true);
  const after=await page.evaluate(()=>({top:tokenUsageScroller(document.querySelector('#token-usage-box')).scrollTop,open:document.querySelectorAll('#token-usage-box details[open]').length,sameForm:savedBulkForm===document.querySelector('[data-token-limits]'),revision:document.querySelector('[data-token-limits]').dataset.revision}));
  assert.equal(after.top,before.top);assert.equal(after.open,before.open);assert.equal(after.sameForm,true);assert.equal(after.revision,'11');
  assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'9876543');
  assert.deepEqual(await page.evaluate(()=>tokenCalls.filter(x=>x.route==='/api/token-usage/acknowledge-all').map(x=>x.body)),[{token:'b'.repeat(64)},{token:'b'.repeat(64)}]);
  // The next scan confirms only the captured totals; a later new alert stays actionable.
  await page.evaluate(async()=>{const fresh={id:'c'.repeat(64),total:5000000,kind:'run',ai:'claude',day:'2026-11-15'};fixtureToken={...fixtureToken,pending:false,acknowledgementToken:'d'.repeat(64),snapshot:{...fixtureToken.snapshot,alerts:[...fixtureToken.snapshot.alerts.map(a=>({...a,acknowledged:true})),fresh],alertCount:1,unacknowledgedAlerts:[{id:fresh.id,total:fresh.total}]}};await loadTokenUsage();});
  assert.equal(await page.locator('[data-token-ack]').count(),1);assert.match(await page.locator('[data-token-alert-list]').textContent(),/過去の記録を含む未確認：1/);
  assert.equal(await page.locator('[name="codex-daily"]').inputValue(),'9876543');
  await page.screenshot({path:'/private/tmp/hub-token-bulk-browser.png'});
  await page.evaluate(()=>{document.querySelector('[data-token-limits]').dataset.dirty='';});
 }
 await page.evaluate(()=>{fixtureToken={running:true,progress:{read:5,files:20}};document.activeElement.blur();});await page.evaluate(()=>loadTokenUsage());assert.match(await page.locator('#token-usage-box').textContent(),/5 \/ 20/);assert.deepEqual(errors,[]);
});
