'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));

// Read-only real-browser fixture: no user ledger, real AI or Hub process.
test('waiting UI: distinct state, counts/filter, priority, composer and 3-language desktop/mobile', {skip:!chromium||!chrome}, async()=>{
  const data=snapshot('処理待ち');data.projects[0].tasks[0].waitReason='時刻待ち（22:00 に自動で動く）';
  let lang='ja';
  const publicDir=path.resolve(__dirname,'../public'),requests=[],errors=[];let fetchedSteps=null;
  let phase='startup';const requestTrace=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      requests.push(req.method+' '+url.pathname);requestTrace.push({phase,request:req.method+' '+url.pathname});
      if(req.method!=='GET'){res.writeHead(409,{'Content-Type':'application/json'});return res.end('{"error":"read-only fixture"}');}
      if(url.pathname==='/api/chat/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"rows","rows":[]}\n\n');return;}
      if(url.pathname==='/api/task/steps'&&fetchedSteps){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(fetchedSteps));}
      if(url.pathname==='/api/langpacks'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({packs:[],saved:'ja'}));}
      if(url.pathname==='/api/skills'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ais:Object.fromEntries(['claude','codex','agy','grok'].map(ai=>[ai,{items:[],found:false}]))}));}
      res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(url.pathname==='/api/state'?data:{}));
    }
    if(url.pathname==='/locale-config.js'){res.setHeader('Content-Type','application/javascript');return res.end('window.HUB_LOCALE='+JSON.stringify({locale:lang,messages:lang==='ja'?{}:require('../../langpacks/'+lang+'/ui.json')})+';');}
    const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({executablePath:chrome,headless:true});
    for(lang of ['ja','en','zh-TW']){
      const page=await browser.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.stack));
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.waitForFunction(()=>typeof renderWork==='function'&&state.projects.length);
      const label=lang==='ja'?'処理待ち':require('../../langpacks/'+lang+'/ui.json')['処理待ち'];
      for(const width of [1280,390,320]){
        await page.setViewportSize({width,height:850});
        await page.evaluate(data=>{state=structuredClone(data);view={kind:'work',project:'p',task:'t'};localStorage.setItem('hub-mode','chat');render();},data);
        if(width<720)await page.waitForFunction(()=>document.querySelector('#list').getBoundingClientRect().right<=0);
        const banner=page.locator('[data-work-wait]');
        assert.equal(await banner.isVisible(),true);
        assert.ok((await banner.innerText()).includes(label));
        assert.match(await banner.innerText(),/22:00/);
        if(process.env.HUB_WAIT_SCREENSHOTS){fs.mkdirSync(process.env.HUB_WAIT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.HUB_WAIT_SCREENSHOTS,lang+'-work-'+width+'.png')});}
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if(await page.locator('#chat-in').isHidden())await page.click('#mobile-compose');
        await page.fill('#chat-in','draft remains');
        await page.evaluate(()=>{window.inputBefore=document.querySelector('#chat-in');state.projects[0].tasks[0].waitReason='外部の処理待ち';syncWorkQuestion();});
        assert.equal(await page.inputValue('#chat-in'),'draft remains');
        assert.equal(await page.evaluate(()=>inputBefore===document.querySelector('#chat-in')),true);
        // A question and a queued/running request take precedence over waiting.
        assert.equal(await page.evaluate(()=>{const p=state.projects[0],t=p.tasks[0];t.question='answer me';syncWorkQuestion();return notificationKind(p,t);}), 'reply');
        assert.equal(await banner.isHidden(),true);
        assert.equal(await page.evaluate(()=>{const p=state.projects[0],t=p.tasks[0];t.question='';t.chatQueueCount=1;syncWorkQuestion();return notificationKind(p,t);}), 'work');
        assert.equal(await banner.isHidden(),true);
        await page.evaluate(()=>{const t=state.projects[0].tasks[0];t.chatQueueCount=0;syncWorkQuestion();updateTurnCounts();});
        assert.equal(await banner.isVisible(),true);
        assert.ok((await page.locator('#turn-wait-n').innerText()).includes('1'));
        await page.evaluate(()=>{view={kind:'turn'};turnTab='wait';render();});
        assert.equal(await page.locator('[data-turn-tab="wait"]').getAttribute('aria-selected'),'true');
        assert.match(await page.locator('.task-status.waiting-process').innerText(),new RegExp(label));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if(process.env.HUB_WAIT_SCREENSHOTS){fs.mkdirSync(process.env.HUB_WAIT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.HUB_WAIT_SCREENSHOTS,lang+'-'+width+'.png')});}
      }
      // Untrusted reason remains text, including after an incremental refresh.
      await page.evaluate(()=>{view={kind:'work',project:'p',task:'t'};state.projects[0].tasks[0].waitReason='<img src=x onerror="window.waitInjected=1">';render();});
      assert.equal(await page.locator('[data-work-wait] img').count(),0);
      assert.equal(await page.evaluate(()=>Boolean(window.waitInjected)),false);
      await page.evaluate(()=>{state.projects[0].kind='freetalk';state.projects[0].tasks[0].waitReason='外部の処理待ち';render();});
      assert.equal(await page.locator('.freetalk-work [data-work-wait]').isVisible(),true);
      assert.ok((await page.locator('[data-work-wait]').innerText()).includes(label));
      await page.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(x=>!x.startsWith('GET ')),Array(3).fill('POST /api/freetalk/ensure')); // Existing startup only; fixture rejects all writes.
  } finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
