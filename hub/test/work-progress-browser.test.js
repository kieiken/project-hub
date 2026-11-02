'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));

// Static, in-memory fixture only: no Hub runtime, real ledger, AI or project creation.
test('work progress Chrome: default off, saved preferences retained, enabled modes update on desktop/mobile',{skip:!chromium||!chrome},async()=>{
  const data=snapshot(),p=data.projects[0],t=p.tasks[0];
  p.phases=[{name:'計画',state:'完了'},{name:'作る',state:'進行中'},{name:'チェック',state:'未着手'},{name:'仕上げ',state:'未着手'}];
  t.phase='作る';t.steps=[{text:'one',done:true},{text:'two',done:true},{text:'three',done:false}];
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
    const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({executablePath:chrome,headless:true});
    const page=await browser.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.stack));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>typeof renderWork==='function'&&state.projects.length);
    // Fresh and saved preferences agree in settings and every work/mode. Reading
    // or rendering must not create, clear or rewrite the saved preference.
    for(const saved of [null,'1','0']){
      phase='preference-'+saved;
      await page.evaluate(saved=>{
        if(saved===null)localStorage.removeItem('hub-work-progress');else localStorage.setItem('hub-work-progress',saved);
      },saved);
      for(const reload of [false,true]){
        if(reload){await page.reload();await page.waitForFunction(()=>state.projects.length);}
        await page.evaluate(()=>{view={kind:'settings'};settingsTab='basic';render();});
        assert.equal(await page.isChecked('#set-work-progress'),saved==='1');
        for(const mode of ['chat','term'])for(const id of ['t','second']){
          await page.evaluate(({data,mode,id})=>{
            state=structuredClone(data);state.projects[0].tasks[0].id=id;
            view={kind:'work',project:'p',task:id};localStorage.setItem('hub-mode',mode);render();
          },{data,mode,id});
          assert.equal(await page.locator('[data-work-progress]').isVisible(),saved==='1');
        }
        assert.equal(await page.evaluate(()=>localStorage.getItem('hub-work-progress')),saved);
      }
    }
    // Simulate only this preference's read failure. Keep the stored opt-in and
    // verify recovery uses it once reads resume.
    await page.evaluate(()=>{
      localStorage.setItem('hub-work-progress','1');window.progressGetItem=Storage.prototype.getItem;
      Storage.prototype.getItem=function(key){if(key==='hub-work-progress')throw Error('unavailable');return progressGetItem.call(this,key);};
      view={kind:'settings'};settingsTab='basic';render();
    });
    assert.equal(await page.isChecked('#set-work-progress'),false);
    for(const mode of ['chat','term']){
      await page.evaluate(({data,mode})=>{state=structuredClone(data);view={kind:'work',project:'p',task:'t'};localStorage.setItem('hub-mode',mode);render();},{data,mode});
      assert.equal(await page.locator('[data-work-progress]').isHidden(),true);
    }
    await page.evaluate(()=>{Storage.prototype.getItem=progressGetItem;delete window.progressGetItem;syncWorkProgress();});
    assert.equal(await page.evaluate(()=>localStorage.getItem('hub-work-progress')),'1');
    assert.equal(await page.locator('[data-work-progress]').isVisible(),true);
    const shot=async name=>{if(process.env.HUB_WORK_PROGRESS_SCREENSHOTS){fs.mkdirSync(process.env.HUB_WORK_PROGRESS_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.HUB_WORK_PROGRESS_SCREENSHOTS,name+'.png')});}};
    for(const mode of ['chat','term'])for(const width of [1280,390,320]){
      phase=mode+'-'+width;
      await page.setViewportSize({width,height:800});
      // Wait for the two independently scheduled conversation auxiliaries before
      // measuring progress-only traffic. Keep the original server count check.
      const auxiliary=mode==='chat'?Promise.all(['/api/usage','/api/muse/chat'].map(route=>
        page.waitForResponse(response=>new URL(response.url()).pathname===route))):null;
      await page.evaluate(({data,mode})=>{state=structuredClone(data);view={kind:'work',project:'p',task:'t'};localStorage.setItem('hub-mode',mode);render();}, {data,mode});
      if(auxiliary)await auxiliary;
      if(width<720)await page.waitForFunction(()=>document.querySelector('#list').getBoundingClientRect().right<=0);
      const strip=page.locator('[data-work-progress]');assert.equal(await strip.isVisible(),true);
      assert.match(await strip.innerText(),/フェーズ 2 \/ 4「作る」/);assert.match(await strip.innerText(),/手順 済 2 \/ 3・残り 1/);
      assert.equal(await strip.locator('li').count(),4);
      assert.equal(await strip.evaluate(el=>el.closest('#mobile-work-info')===null),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      for(const item of await strip.locator('li').all()){const b=await item.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);}
      const chatArea=await page.locator(mode==='chat'?'.chat':'.panes').boundingBox();assert.ok(chatArea.height>300,'conversation keeps usable height');
      if(width===390||width===1280)await shot(mode+'-'+width);
      if(mode==='chat'){
        if(await page.locator('#chat-in').isHidden())await page.click('#mobile-compose');
        await page.fill('#chat-in','未送信の下書き');
        // Capture API invocations inside the operation itself. Earlier render()
        // requests can reach the fixture while later Playwright reads await.
        const before=requests.length;
        const calls=await page.evaluate(()=>{const original=api,calls=[];
          api=(...args)=>{calls.push(args[0]);return original(...args);};
          try {window.keptInput=document.querySelector('#chat-in');window.keptStrip=document.querySelector('[data-work-progress]');const t=state.projects[0].tasks[0];t.steps[2].done=true;syncWorkQuestion();}
          finally {api=original;}return calls;});
        assert.match(await strip.innerText(),/作業全体：未完了/);assert.match(await strip.innerText(),/作業の完了は未確定/);
        assert.equal(await page.inputValue('#chat-in'),'未送信の下書き');
        assert.equal(await page.evaluate(()=>keptInput===document.querySelector('#chat-in')&&keptStrip===document.querySelector('[data-work-progress]')),true);
        assert.deepEqual(calls,[],'strip refresh adds no API request');
        assert.equal(requests.length,before,'strip refresh adds no server request');
        await page.evaluate(()=>{state.projects[0].tasks[0].state='完了';syncWorkQuestion();});
        assert.match(await strip.innerText(),/作業全体：完了/);
      }
    }
    await page.evaluate(()=>{const p=state.projects[0];p.phases=[];p.tasks[0].phase='';p.tasks[0].steps=[];p.tasks[0].state='実行中';syncWorkQuestion();});
    assert.match(await page.locator('[data-work-progress]').innerText(),/フェーズ未設定/);
    assert.match(await page.locator('[data-work-progress]').innerText(),/手順未設定/);
    // Close only this work's strip, preserve the composer and offer a way back.
    await page.setViewportSize({width:1280,height:800});
    await page.evaluate(()=>{localStorage.setItem('hub-mode','chat');render();});
    await page.fill('#chat-in','閉じても残る下書き');
    await page.click('[data-progress-toggle="close"]');
    assert.equal(await page.locator('[data-work-progress] ol').count(),0);
    await page.evaluate(()=>{syncWorkProgress();render();});
    assert.equal(await page.locator('[data-progress-toggle="open"]').count(),1);
    assert.equal(await page.inputValue('#chat-in'),'閉じても残る下書き');
    await page.click('[data-progress-toggle="open"]');
    assert.equal(await page.locator('[data-progress-toggle="close"]').count(),1);
    // Basic display setting hides across views, modes and reloads. Enabling
    // again also clears per-work collapsed state; no work/phase state is written.
    await page.evaluate(()=>{view={kind:'settings'};settingsTab='basic';render();});
    await page.uncheck('#set-work-progress');
    assert.equal(await page.evaluate(()=>localStorage.getItem('hub-work-progress')),'0');
    for(const mode of ['chat','term']){
      await page.evaluate(mode=>{view={kind:'work',project:'p',task:'t'};localStorage.setItem('hub-mode',mode);render();},mode);
      assert.equal(await page.locator('[data-work-progress]').isHidden(),true);
    }
    await page.reload();await page.waitForFunction(()=>state.projects.length);
    await page.evaluate(()=>{view={kind:'work',project:'p',task:'t'};render();});
    assert.equal(await page.locator('[data-work-progress]').isHidden(),true);
    await page.evaluate(()=>{view={kind:'settings'};settingsTab='basic';render();});
    await page.check('#set-work-progress');
    await page.evaluate(()=>{view={kind:'work',project:'p',task:'t'};render();});
    assert.equal(await page.locator('[data-work-progress]').isVisible(),true);
    // Large step details stay absent until both disclosures are opened.
    fetchedSteps={version:'large-v1',steps:Array.from({length:1086},(_,i)=>({text:'large step '+i,done:i<941}))};
    await page.evaluate(()=>{const t=state.projects[0].tasks[0];delete t.steps;t.stepSummary={total:1086,done:941,version:'large-v1'};workFolds.clear();render();});
    const fetchBefore=requests.filter(r=>r==='GET /api/task/steps').length;
    assert.equal(await page.locator('[data-step-list] label').count(),0);
    await page.click('details[data-work-fold="management"] > summary');
    assert.equal(requests.filter(r=>r==='GET /api/task/steps').length,fetchBefore);
    await page.click('details.steps > summary');
    await page.waitForFunction(()=>document.querySelectorAll('[data-step-list] label').length===1086);
    assert.equal(requests.filter(r=>r==='GET /api/task/steps').length,fetchBefore+1);
    await page.click('[data-steps-close]');
    await page.evaluate(()=>render());
    assert.equal(await page.locator('[data-step-list] label').count(),0);
    await page.click('details.steps > summary');
    await page.waitForFunction(()=>document.querySelectorAll('[data-step-list] label').length===1086);
    assert.equal(requests.filter(r=>r==='GET /api/task/steps').length,fetchBefore+1,'reopen uses matching cached step version');
    assert.deepEqual(errors,[]);
    // Normal app startup also attempts these two bookkeeping calls. The fixture
    // refuses every POST; progress must never send work or mutate idea records.
    assert.deepEqual(requests.filter(r=>!r.startsWith('GET ')&&!['POST /api/task/read','POST /api/freetalk/ensure'].includes(r)),[]);
  }finally{console.log('progress request trace '+JSON.stringify(requestTrace));await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
