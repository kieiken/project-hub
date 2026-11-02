'use strict';
// Real page/DOM; local delayed HTTP acceptance, synthetic SSE. No AI starts.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
test('送信確認を受付前に描画し、成功・順番待ち・拒否で下書きと添付を守る',{skip:!chromium||!chrome},async t=>{
 const data=snapshot();data.museSupported=false;
 const publicDir=path.resolve(__dirname,'../public'),errors=[];let browser,pending,sends=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/chat/send'){sends++;req.resume();pending=res;return;}
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/state'?data:{}));}
  const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 });
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:chrome,headless:true});
 for(const [i,result] of [{ok:true},{queued:true,queue:1},{error:'fixture refused'}].entries()){
  const page=await browser.newPage({viewport:{width:i===1?390:1280,height:850}});page.setDefaultTimeout(8000);
  await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   localStorage.setItem('hub-view',JSON.stringify({kind:'work',project:'p',task:'t'}));localStorage.setItem('hub-mode','chat');
   window.__streams=[];window.EventSource=class{constructor(){window.__streams.push(this);}close(){this.readyState=2;}};
  });
  await page.goto(base);await page.waitForSelector('#chat-in',{state:'attached'});
  if(i===1)await page.locator('#mobile-compose').click();
  await page.waitForSelector('#chat-in');
  await page.evaluate(()=>{
   const emit=ev=>window.__streams.at(-1).onmessage({data:JSON.stringify(ev)});
   emit({type:'rows',rows:Array.from({length:600},(_,i)=>({role:'user',text:('Saved history '+i+'\n').repeat(10)})),queue:[],busy:null});
   chatImages('p','t').push({id:'kept',name:'kept.png',path:'/fixture/kept.png',url:'/fixture.png',kind:'image'});
   const input=document.querySelector('#chat-in');input.value='送る本文';input.dispatchEvent(new Event('input',{bubbles:true}));
   document.querySelector('#composer').requestSubmit();
   window.__statusAtSubmit={text:document.querySelector('#chat-send-status').textContent,visible:!document.querySelector('#chat-send-status').hidden,busy:Boolean(chatBusy)};
  });
  const status=await page.evaluate(()=>window.__statusAtSubmit);
  assert.equal(status.text,'送信を確認しています…');assert.equal(status.visible,true);assert.equal(status.busy,false);
  // Wait across a paint while the server has not accepted the request.
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('#chat-send-status').isVisible(),true);
  assert.equal(await page.locator('#msg-partial').count(),0);
  await page.locator('#chat-in').fill('次の下書き');
  await page.waitForFunction(()=>document.querySelector('#chat-send').disabled);
  for(let n=0;!pending&&n<100;n++)await new Promise(r=>setTimeout(r,5));
  assert.ok(pending);const response=pending;pending=null;
  response.writeHead(result.error?409:200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
  await page.waitForFunction(()=>document.querySelector('#chat-send-status').hidden);
  assert.equal(await page.locator('#chat-in').inputValue(),result.error?'送る本文\n\n次の下書き':'次の下書き');
  assert.equal(await page.evaluate(()=>chatImages('p','t').length),result.error?1:0);
  if(result.queued||result.error)assert.equal(await page.locator('#msg-partial').count(),0);
  else assert.equal(await page.locator('#msg-partial').count(),1);
  await page.close();
 }
 assert.equal(sends,3);assert.deepEqual(errors,[]);
});
