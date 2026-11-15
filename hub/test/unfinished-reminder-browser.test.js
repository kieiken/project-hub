'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
for(const project of ['p','freetalk']) test('reminder browser '+project+': desktop/mobile badges remain visible, open list, and continue only drafts',{skip:!chromium||!chrome},async()=>{
 const data=snapshot(),p=data.projects[0],t=p.tasks[0];p.id=project;if(project==='freetalk'){p.kind='freetalk';t.freetalk=true;}t.unfinishedCount=1;const root=path.resolve(__dirname,'../public'),writes=[],errors=[];
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
   if(req.method!=='GET'){writes.push(url.pathname);res.writeHead(409,{'Content-Type':'application/json'});return res.end('{}');}
   if(url.pathname==='/api/chat/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.write('data: {"type":"rows","rows":[]}\n\n');}
   res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/state'?data:url.pathname==='/api/chat/unfinished'?{entries:[{id:'receipt',original:'original request',reason:'stopped',at:'2026-11-14',updated:'r1'}]}:url.pathname==='/api/langpacks'?{packs:[],saved:'ja'}:{}));
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.setInterval=()=>0;});await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof renderWork==='function'&&state.projects.length);
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:800});await page.evaluate(project=>{state.projects[0].tasks[0].unfinishedCount=1;view={kind:'work',project,task:'t'};open.add(project);open.add(project==='freetalk'?'g:freetalk':'g:projects');localStorage.setItem('hub-mode','chat');render();},project);
   assert.equal(await page.locator('[data-work-unfinished] .unfinished-badge').count(),1);
   const badge=page.locator(width<720?'#mobile-unfinished .unfinished-badge':'[data-work-unfinished] .unfinished-badge');const box=await badge.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,width:r.width,height:r.height};});assert.ok(box.width>0&&box.height>0);assert.ok(box.x>=0&&box.x+box.width<=width+1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   if(width<720)await page.click('#menu-toggle');const side=page.locator('#list .unfinished-badge');assert.equal(await side.isVisible(),true);if(width<720)await page.click('#menu-toggle');
   await badge.click();await page.waitForSelector('.unfinished-entry');assert.match(await page.locator('.unfinished-entry').innerText(),/original request[\s\S]*stopped[\s\S]*2026-11-14/);await page.click('[data-unfinished-draft="0"]');assert.equal(await page.locator('#unfinished-dialog').count(),0);assert.match(await page.inputValue('#chat-in'),/original request/);
   await page.evaluate(()=>{state.projects[0].tasks[0].unfinishedCount=0;syncWorkQuestion();renderTree();});assert.equal(await page.locator('.unfinished-badge').count(),0);await page.evaluate(()=>{state.projects[0].tasks[0].unfinishedCount=1;syncWorkQuestion();});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes.filter(x=>!['/api/task/read','/api/freetalk/ensure'].includes(x)),[]);
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
