'use strict';
// Product scripts and browser layout; the server, SSE and data are isolated.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
for(const kind of ['work','freetalk']) for(const width of [1280,390]) test('automatic request lazy disclosure, keyboard, stream and navigation '+kind+' '+width+'px',{skip:!chromium||!chrome},async t=>{
 const data=snapshot();data.museSupported=false;if(kind==='freetalk'){data.projects[0].id=data.projects[0].kind='freetalk';data.projects[0].tasks[0].freetalk=true;}data.projects[0].tasks.push({...data.projects[0].tasks[0],id:'other',title:'Other'});
 const publicDir=path.resolve(__dirname,'../public'),requests=[],errors=[];let browser;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(req.method+' '+url.pathname);
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/state'?data:{}));}
  const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 });
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage({viewport:{width,height:850}});page.setDefaultTimeout(8000);
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(project=>{
  localStorage.setItem('hub-view',JSON.stringify({kind:'work',project,task:'t'}));localStorage.setItem('hub-mode','chat');
  window.__streams=[];window.EventSource=class{constructor(){window.__streams.push(this);}close(){this.readyState=2;}};
 },data.projects[0].id);
 await page.goto(base);await page.waitForSelector('#chat-in',{state:'attached'});
 await page.evaluate(()=>{
  window.__emit=ev=>window.__streams.at(-1).onmessage({data:JSON.stringify(ev)});
  window.__formats=[];const original=richText;richText=(text,...args)=>{window.__formats.push(text);return original(text,...args);};
  window.__code='　raw <script> & "quoted"\r\n> still code\r\n';
  window.__auto='【渡した依頼：画面を確認】\r\n目的：'+('長い行 '.repeat(80))+'\n```text\r\n'+window.__code+'```\n'+('追加の本文\n'.repeat(50));
  window.__rows=[{role:'user',origin:'delegate',mode:'queued',turn:'auto',text:window.__auto},
   {role:'user',mode:'queued',text:'本人の依頼\n最後まで表示する'},
   {role:'assistant',ai:'codex',text:'AIの返事\n最後まで表示する',asks:[{question:'承認しますか？',options:['はい','いいえ']}]},
   ...Array.from({length:20},(_,i)=>({role:'user',text:('履歴 '+i+'\n').repeat(8)}))];
  window.__emit({type:'rows',rows:window.__rows,queue:[{id:'manual',ai:'codex',text:'本人の順番待ち\n編集できる',model:'fixture'},{id:'auto',origin:'delegate',ai:'codex',text:window.__auto,model:'fixture'}],busy:null});
 });
 const box=page.locator('#msgs'),body=box.locator('.auto-request'),toggle=body.locator('[data-request-toggle]'),full=body.locator('.auto-request-full');
 assert.equal(await body.count(),1);assert.equal(await full.innerHTML(),'');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 assert.equal(await page.evaluate(()=>window.__formats.includes(window.__auto)),false);
 assert.equal(await body.locator('template').evaluate(el=>el.content.textContent),await page.evaluate(()=>window.__auto));
 assert.ok(await body.locator('.auto-request-preview').evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)*2+1));
 assert.equal(await box.locator('.ask-q').count(),1);assert.match(await box.innerText(),/AIの返事\n最後まで表示する/);
 assert.equal(await page.locator('[data-qedit="manual"]').count(),1);
 await toggle.focus();const top=await box.evaluate(el=>el.scrollTop);await toggle.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-request-toggle]').getAttribute('aria-expanded')==='true');
 assert.equal(await full.locator('code').textContent(),await page.evaluate(()=>window.__code));assert.equal(await full.locator('script').count(),0);
 assert.equal(await page.evaluate(()=>window.__formats.filter(x=>x===window.__auto).length),1);
 assert.ok(Math.abs(await box.evaluate(el=>el.scrollTop)-top)<3,'opening must hold the reading position');
 await page.evaluate(()=>window.__emit({type:'row',row:{role:'assistant',ai:'codex',text:'新しい返事'}}));
 assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.equal(await full.locator('code').count(),1);
 assert.ok(Math.abs(await box.evaluate(el=>el.scrollTop)-top)<3,'append must hold position');
 await toggle.press(' ');await page.waitForFunction(()=>document.querySelector('[data-request-toggle]').getAttribute('aria-expanded')==='false');assert.equal(await full.isVisible(),false);
 await toggle.press('Enter');assert.equal(await page.evaluate(()=>window.__formats.filter(x=>x===window.__auto).length),1,'reopen should reuse formatted body');
 // A full reconnect snapshot deliberately rebuilds messages in their default
 // collapsed state; its source must be current, never a detached previous row.
 await page.evaluate(()=>{window.__rows[0]={...window.__rows[0],text:window.__auto+'\n更新された依頼'};window.__emit({type:'rows',rows:window.__rows,queue:[],busy:null});});
 assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await full.innerHTML(),'');
 await toggle.click();assert.match(await full.innerText(),/更新された依頼/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page should not overflow');
 await page.evaluate(()=>{view={kind:'work',project:state.projects[0].id,task:'other'};renderWork();});await page.waitForSelector('#chat-in',{state:'attached'});
 assert.equal(await page.locator('.auto-request').count(),0);
 await page.evaluate(()=>{view={kind:'work',project:state.projects[0].id,task:'t'};renderWork();window.__emit({type:'rows',rows:window.__rows,queue:[],busy:null});});
 assert.equal(await page.locator('[data-request-toggle]').getAttribute('aria-expanded'),'false');
 if(process.env.HUB_AUTO_REQUEST_SCREENSHOT_DIR){
  await body.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(process.env.HUB_AUTO_REQUEST_SCREENSHOT_DIR,'automatic-request-'+kind+'-'+width+'-collapsed.png')});
  await toggle.click();
  await page.screenshot({path:path.join(process.env.HUB_AUTO_REQUEST_SCREENSHOT_DIR,'automatic-request-'+kind+'-'+width+'-expanded.png')});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(x=>x.startsWith('POST ')&&x!=='POST /api/freetalk/ensure'),[]);
});
