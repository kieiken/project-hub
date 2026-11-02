'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const speech=fs.readFileSync(path.join(__dirname,'../public/speech-input.js'),'utf8');
const mock=`window.sessions=[];window.SpeechRecognition=class {
 constructor(){sessions.push(this);} start(){this.started=true;if(window.throwStart)throw Error('fixture');this.onstart?.();}
 stop(){this.stopped=true;} abort(){this.aborted=true;}
 result(text,index=0){const result=[{transcript:text}];result.isFinal=true;const results=Array.from({length:index+1},()=>result);this.onresult({resultIndex:index,results});}
 end(){this.onend();} error(error){this.onerror({error});}
};`;
// No real recognition.start: the constructor is replaced before Hub loads.
test('dictation Chrome isolated boundary cases',{skip:!chromium||!fs.existsSync(chrome)},async t=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://127.0.0.1:17771/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><textarea id="input">前後</textarea><div id="elsewhere" tabindex="0">other</div>'}));
  const setup=async({supported=true}={})=>{
   await page.goto('http://127.0.0.1:17771/');
   if(supported)await page.addScriptTag({content:mock});else await page.evaluate(()=>{window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;});
   await page.addScriptTag({content:speech});
   await page.evaluate(()=>{window.owns=true;HubVoice.mount(document.querySelector('#input'),{current:()=>owns});});
  };
  const start=async()=>{await page.focus('#input');await page.evaluate(()=>document.querySelector('#input').setSelectionRange(1,2));await page.click('.voice-button');};
  const content=()=>page.inputValue('#input');const status=()=>page.locator('.voice-status').innerText();
  await t.test('final insertion keeps selected text and caret, deduplicates results, never submits',async()=>{
   await setup();await page.evaluate(()=>{window.inputs=0;document.querySelector('#input').addEventListener('input',()=>inputs++);});await start();
   assert.equal(await page.evaluate(()=>sessions[0].lang),'ja-JP');assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),true);
   await page.evaluate(()=>{sessions[0].result('日本語');sessions[0].result('日本語');});assert.equal(await content(),'前後');
   await page.click('.voice-button');assert.equal(await page.evaluate(()=>sessions[0].stopped),true);await page.evaluate(()=>sessions[0].end());
   assert.equal(await content(),'前日本語後');assert.equal(await page.evaluate(()=>document.querySelector('#input').selectionStart),4);assert.equal(await page.evaluate(()=>inputs),1);
   assert.match(await status(),/確認・修正/);assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),false);
  });
  await t.test('partial results do not become confirmed text',async()=>{await setup();await start();await page.evaluate(()=>{const r=[{transcript:'未確定'}];r.isFinal=false;sessions[0].onresult({results:[r]});sessions[0].end();});assert.equal(await content(),'前後');});
  await t.test('several phrases keep listening and stay out of the draft until explicit stop',async()=>{
   await setup();await start();assert.equal(await page.evaluate(()=>sessions[0].continuous),true);
   await page.evaluate(()=>{sessions[0].result('一文目。');sessions[0].result('二文目。',1);sessions[0].result('二文目。',1);});
   assert.equal(await content(),'前後');assert.equal(await page.getAttribute('.voice-button','aria-pressed'),'true');assert.equal(await page.evaluate(()=>!!sessions[0].stopped),false);
   await page.click('.voice-button');await page.evaluate(()=>{sessions[0].result('三文目。',2);sessions[0].end();sessions[0].end();});assert.equal(await content(),'前一文目。二文目。三文目。後');
  });
  const captureTimers=()=>page.evaluate(()=>{window.voiceTimers=new Map();const original=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms>=3000){voiceTimers.set(ms,fn);return original(()=>{},1000000000);}return original(fn,ms,...args);};});
  await t.test('five-minute cap stops gracefully and keeps confirmed phrases, rather than aborting them',async()=>{
   await setup();await captureTimers();await start();await page.evaluate(()=>sessions[0].result('長く話した文'));
   assert.deepEqual(await page.evaluate(()=>[...voiceTimers.keys()]),[300000]);await page.evaluate(()=>voiceTimers.get(300000)());
   assert.equal(await page.evaluate(()=>sessions[0].stopped),true);assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');assert.equal(await content(),'前後');
   await page.evaluate(()=>sessions[0].end());assert.equal(await content(),'前長く話した文後');assert.match(await status(),/5分/);assert.equal(await page.evaluate(()=>sessions.length),1);
  });
  await t.test('missing end notification preserves confirmed text once and invalidates late callbacks',async()=>{
   await setup();await captureTimers();await start();await page.evaluate(()=>sessions[0].result('残す文'));await page.click('.voice-button');
   await page.evaluate(()=>voiceTimers.get(3000)());assert.equal(await content(),'前残す文後');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);
   await start();await page.evaluate(()=>{sessions[0].result('古い');sessions[0].end();voiceTimers.get(3000)();});assert.equal(await content(),'前残す文後');assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),true);
  });
  await t.test('editing while stop is pending rejects the fallback transcript',async()=>{
   await setup();await captureTimers();await start();await page.evaluate(()=>sessions[0].result('破棄する文'));await page.click('.voice-button');await page.fill('#input','編集を優先');
   await page.evaluate(()=>{voiceTimers.get(3000)();sessions[0].end();});assert.equal(await content(),'編集を優先');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);
  });
  await t.test('stop exception preserves confirmed text and late results cannot append again',async()=>{
   await setup();await start();await page.evaluate(()=>{sessions[0].result('残せる文');sessions[0].stop=()=>{throw Error('engine already stopped');};});await page.click('.voice-button');
   await page.evaluate(()=>{sessions[0].result('重複');sessions[0].end();});assert.equal(await content(),'前残せる文後');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');
  });
  await t.test('browser-initiated end preserves confirmed text, explains end and never restarts itself',async()=>{
   await setup();await start();await page.evaluate(()=>{sessions[0].result('途中まで');sessions[0].end();});assert.equal(await content(),'前途中まで後');
   assert.match(await status(),/ブラウザが聞き取りを終了/);assert.equal(await page.evaluate(()=>sessions.length),1);assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');
  });
  await t.test('manual editing aborts and delayed old result cannot alter draft',async()=>{await setup();await start();await page.fill('#input','手入力');await page.evaluate(()=>{sessions[0].result('古い声');sessions[0].end();});assert.equal(await content(),'手入力');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);});
  await t.test('old result cannot cancel a new session on same node',async()=>{await setup();await start();await page.evaluate(()=>HubVoice.cancel());await start();await page.evaluate(()=>{sessions[0].result('古い');sessions[0].end();});assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),true);await page.evaluate(()=>{sessions[1].result('新');sessions[1].end();});assert.equal(await content(),'前新後');});
  await t.test('view identity change rejects result even before DOM disposal',async()=>{await setup();await start();await page.evaluate(()=>{owns=false;sessions[0].result('別作業');sessions[0].end();});assert.equal(await content(),'前後');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);});
  await t.test('detached input is stopped, replacement never receives result',async()=>{await setup();await start();await page.evaluate(()=>{document.querySelector('#input').outerHTML='<textarea id="input">別画面</textarea>';});await page.evaluate(()=>{sessions[0].result('遅延');sessions[0].end();});assert.equal(await content(),'別画面');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);});
  await t.test('blur stops recognition',async()=>{await setup();await start();await page.focus('#elsewhere');await page.evaluate(()=>{sessions[0].result('遅延');sessions[0].end();});assert.equal(await content(),'前後');assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),false);});
  await t.test('explicit cancel before send rejects delayed completion',async()=>{await setup();await start();await page.evaluate(()=>{HubVoice.cancel(document.querySelector('#input'));document.querySelector('#input').value='次の依頼';sessions[0].result('古い声');sessions[0].end();});assert.equal(await content(),'次の依頼');});
  await t.test('hidden tab cancels without automatic restart',async()=>{await setup();await start();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));sessions[0].result('遅延');sessions[0].end();});assert.equal(await content(),'前後');assert.equal(await page.evaluate(()=>sessions.length),1);});
  for(const error of ['not-allowed','service-not-allowed','audio-capture','network','no-speech','language-not-supported','unknown'])await t.test('error '+error+' preserves manual input',async()=>{await setup();await start();await page.evaluate(error=>{sessions[0].error(error);sessions[0].result('遅延');sessions[0].end();},error);assert.equal(await content(),'前後');assert.equal(await page.getAttribute('.voice-button','aria-pressed'),'false');assert.ok(await status());});
  await t.test('constructor/start failure restores button',async()=>{await setup();await page.evaluate(()=>{throwStart=true;});await start();assert.match(await status(),/開始できません/);assert.equal(await page.evaluate(()=>HubVoice.permissionPending()),false);});
  await t.test('unsupported disables dictation and keeps keyboard input',async()=>{await setup({supported:false});assert.equal(await page.isDisabled('.voice-button'),true);await page.fill('#input','手入力継続');assert.equal(await content(),'手入力継続');assert.match(await status(),/使えません/);});
  await t.test('old Mac shell requires an app update before any recognition attempt',async()=>{
   await page.goto('http://127.0.0.1:17771/');await page.addScriptTag({content:mock});
   await page.evaluate(()=>Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Macintosh ProjectHubApp/oldhash'}));
   await page.addScriptTag({content:speech});await page.evaluate(()=>HubVoice.mount(document.querySelector('#input')));
   assert.equal(await page.isDisabled('.voice-button'),true);assert.match(await status(),/Macアプリ本体の更新/);assert.equal(await page.evaluate(()=>sessions.length),0);
   await page.fill('#input','手入力継続');assert.equal(await content(),'手入力継続');
  });
  await t.test('new Mac shell keeps explicit browser recognition and reports permission failures accurately',async()=>{
   await page.goto('http://127.0.0.1:17771/');await page.addScriptTag({content:mock});
   await page.evaluate(()=>Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Macintosh ProjectHubApp/newhash HubVoice/1'}));
   await page.addScriptTag({content:speech});await page.evaluate(()=>HubVoice.mount(document.querySelector('#input')));
   await start();assert.equal(await page.evaluate(()=>sessions.length),1);await page.evaluate(()=>sessions[0].error('not-allowed'));
   assert.match(await status(),/マイクと音声認識の両方/);assert.equal(await content(),'前後');
  });
  await t.test('unchanged-node remount updates generation guard without duplicate button',async()=>{await setup();await page.evaluate(()=>{owns=false;HubVoice.mount(document.querySelector('#input'),{current:()=>true});});await start();await page.evaluate(()=>{sessions[0].result('再開');sessions[0].end();});assert.equal(await content(),'前再開後');assert.equal(await page.locator('.voice-button').count(),1);});
  await t.test('length limit preserves input instead of truncating transcript',async()=>{await setup();await page.evaluate(()=>document.querySelector('#input').maxLength=3);await start();await page.evaluate(()=>{sessions[0].result('長い文章');sessions[0].end();});assert.equal(await content(),'前後');assert.match(await status(),/文字数/);});
  await t.test('untrusted click does not start recognition',async()=>{await setup();await page.evaluate(()=>document.querySelector('.voice-button').click());assert.equal(await page.evaluate(()=>sessions.length),0);});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('dictation full Hub Chrome fixture: conversation/ideas, narrow width, send and navigation isolation',{skip:!chromium||!fs.existsSync(chrome)},async()=>{
 const data=snapshot(),requests=[],errors=[],publicDir=path.resolve(__dirname,'../public');
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname.startsWith('/api/')){
   requests.push(req.method+' '+u.pathname);
   if(req.method!=='GET'){res.writeHead(409,{'Content-Type':'application/json'});return res.end('{"error":"read-only fixture"}');}
   if(u.pathname==='/api/chat/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"rows","rows":[]}\n\n');return;}
   res.setHeader('Content-Type','application/json');
   return res.end(JSON.stringify(u.pathname==='/api/state'?data:u.pathname==='/api/ideas'?{rev:1,items:[],total:0,counts:{all:0,waiting:0,categories:{}},itemOrder:[],settings:{},controls:{},observed:{},erased:{}}:{}));
  }
  const f=path.resolve(publicDir,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(publicDir+path.sep)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);await page.addInitScript(mock);
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof renderWork==='function'&&state.projects.length);
  await page.evaluate(()=>{view={kind:'work',project:'p',task:'t'};localStorage.setItem('hub-mode','chat');render();});
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:850});
   if(await page.locator('#chat-in').isHidden())await page.click('#mobile-compose');
   const send=await page.locator('#chat-send').boundingBox(),mic=await page.locator('#composer .voice-button').boundingBox();
   assert.ok(mic.x>=send.x+send.width,width+' mic follows send');assert.ok(Math.abs((send.y+send.height/2)-(mic.y+mic.height/2))<1,width+' same row');
   assert.equal(await page.locator('#chat-send-actions .voice-button').count(),1);
   if(width===1280)assert.equal((await page.locator('#composer .voice-tools').boundingBox()).height,0,'idle microphone adds no separate row');
   await page.fill('#chat-in','依頼');await page.click('#composer .voice-button');
   await page.evaluate(()=>{sessions.at(-1).result('音声');sessions.at(-1).end();});assert.equal(await page.inputValue('#chat-in'),'依頼音声');
   assert.equal(await page.evaluate(()=>chatDraft[chatAttachmentKey('p','t')]),'依頼音声');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  if(process.env.HUB_VOICE_SCREENSHOT)await page.screenshot({path:process.env.HUB_VOICE_SCREENSHOT.replace(/\.png$/,'-chat.png')});
  // Busy-state controls hide send, while the same mic remains in the action group.
  await page.evaluate(()=>{document.querySelector('#chat-send').hidden=true;});assert.equal(await page.locator('#chat-send-actions .voice-button').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>{document.querySelector('#chat-send').hidden=false;});
  // Exercise the real submit handler without contacting any AI. Upload-in-progress blocks delivery after cancellation.
  await page.click('#composer .voice-button');await page.evaluate(()=>{chatImageUploads.set(chatAttachmentKey('p','t'),true);document.querySelector('#composer').requestSubmit();chatImageUploads.delete(chatAttachmentKey('p','t'));sessions.at(-1).result('送信後の遅延');sessions.at(-1).end();});
  assert.equal(await page.evaluate(()=>sessions.at(-1).aborted),true);assert.equal(await page.inputValue('#chat-in'),'依頼音声');
  await page.click('#composer .voice-button');await page.evaluate(()=>{view={kind:'project',project:'p',task:null};render();});await page.evaluate(()=>{sessions.at(-1).result('遅延');sessions.at(-1).end();});assert.equal(await page.evaluate(()=>chatDraft[chatAttachmentKey('p','t')]),'依頼音声');
  await page.evaluate(()=>{void HubIdeas.open('p','t');});await page.waitForSelector('.ideas-dialog[open]');await page.waitForSelector('.idea-empty');assert.equal(await page.locator('[data-idea-status].error').count(),0);await page.fill('#idea-text','記録');await page.click('.ideas-dialog .voice-button');await page.evaluate(()=>{sessions.at(-1).result('追加');sessions.at(-1).end();});assert.equal(await page.inputValue('#idea-text'),'記録追加');
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:850});const save=await page.locator('[data-idea-add]').boundingBox(),mic=await page.locator('.ideas-dialog .voice-button').boundingBox();
   assert.ok(mic.x>=save.x+save.width,width+' mic follows save');assert.ok(Math.abs((save.y+save.height/2)-(mic.y+mic.height/2))<1,width+' save and mic same row');
   assert.equal(await page.locator('.ideas-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  }
  await page.click('.ideas-dialog .voice-button');await page.evaluate(()=>document.querySelector('.ideas-dialog').close());await page.evaluate(()=>{sessions.at(-1).result('閉じた後');sessions.at(-1).end();});
  await page.evaluate(()=>{void HubIdeas.open('p','t');});await page.waitForSelector('.ideas-dialog[open]');assert.equal(await page.inputValue('#idea-text'),'記録追加');await page.click('.ideas-dialog .voice-button');await page.evaluate(()=>{sessions.at(-1).result('再開');sessions.at(-1).end();});assert.equal(await page.inputValue('#idea-text'),'記録追加再開');
  assert.deepEqual(errors,[]);assert.ok(!requests.some(x=>/transcribe|audio|chat\/send|ideas\/add/.test(x)));
  if(process.env.HUB_VOICE_SCREENSHOT)await page.screenshot({path:process.env.HUB_VOICE_SCREENSHOT});
  // Submit with an empty idea: cancellation still happens before validation, without a save request.
  await page.fill('#idea-text','');await page.click('.ideas-dialog .voice-button');await page.evaluate(()=>{document.querySelector('[data-idea-form]').requestSubmit();sessions.at(-1).result('保存後の遅延');sessions.at(-1).end();});
  assert.equal(await page.evaluate(()=>sessions.at(-1).aborted),true);assert.equal(await page.inputValue('#idea-text'),'');assert.ok(!requests.some(x=>/ideas\/add/.test(x)));
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('dictation native permission ticket changes per session and disappears on stop/cancel',{skip:!chromium||!fs.existsSync(chrome)},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage();await page.route('http://127.0.0.1:17772/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<textarea id="input"></textarea>'}));await page.goto('http://127.0.0.1:17772/');await page.addScriptTag({content:mock});await page.addScriptTag({content:speech});await page.evaluate(()=>HubVoice.mount(document.querySelector('#input')));
  assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');await page.click('.voice-button');const first=await page.evaluate(()=>HubVoice.permissionTicket());assert.ok(first);await page.click('.voice-button');assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');await page.evaluate(()=>sessions[0].end());await page.click('.voice-button');const second=await page.evaluate(()=>HubVoice.permissionTicket());assert.ok(second);assert.notEqual(second,first);await page.evaluate(()=>HubVoice.cancel());assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');
 }finally{await browser.close();}
});

test('dictation F1 focus ownership: native prompt blur keeps ticket, page movement still cancels',{skip:!chromium||!fs.existsSync(chrome)},async t=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(4000);
  await page.route('http://127.0.0.1:17773/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><textarea id="input">前後</textarea><button id="other">別の操作</button>'}));
  const setup=async()=>{
   await page.goto('http://127.0.0.1:17773/');await page.bringToFront();await page.addScriptTag({content:mock});await page.addScriptTag({content:speech});await page.evaluate(()=>HubVoice.mount(document.querySelector('#input')));
   await page.focus('#input');await page.evaluate(()=>document.querySelector('#input').setSelectionRange(1,1));await page.click('.voice-button');
  };
  const tick=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,10)));
  for(const target of ['input','button'])await t.test('native prompt on '+target+' retains same ticket and inserts after focus returns',async()=>{
   await setup();if(target==='button')await page.focus('.voice-button');const ticket=await page.evaluate(()=>HubVoice.permissionTicket());assert.ok(ticket);
   await page.evaluate(target=>{
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});
    document.querySelector(target==='input'?'#input':'.voice-button').dispatchEvent(new FocusEvent('blur',{relatedTarget:null}));
   },target);await tick();
   assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),ticket);assert.equal(await page.evaluate(()=>!!sessions[0].aborted),false);
   await page.evaluate(()=>{delete document.hasFocus;sessions[0].result('許可後');sessions[0].end();});await tick();assert.equal(await page.inputValue('#input'),'前許可後後');
  });
  await t.test('window focus loss settling after blur does not cancel',async()=>{
   await setup();const ticket=await page.evaluate(()=>HubVoice.permissionTicket());
   await page.evaluate(()=>{window.focused=true;Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>focused});document.querySelector('#input').dispatchEvent(new FocusEvent('blur',{relatedTarget:null}));focused=false;});await tick();
   assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),ticket);await page.evaluate(()=>{focused=true;sessions[0].result('復帰');sessions[0].end();});assert.equal(await page.inputValue('#input'),'前復帰後');
  });
  await t.test('in-page focus destination cancels and rejects late text',async()=>{
   await setup();assert.equal(await page.evaluate(()=>document.hasFocus()),true);await page.focus('#other');await page.evaluate(()=>{sessions[0].result('遅延');sessions[0].end();});assert.equal(await page.inputValue('#input'),'前後');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');
  });
  await t.test('explicit element blur within focused page cancels after focus settles',async()=>{
   await setup();await page.evaluate(()=>document.querySelector('#input').blur());await tick();assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);await page.evaluate(()=>{sessions[0].result('遅延');sessions[0].end();});assert.equal(await page.inputValue('#input'),'前後');
  });
  await t.test('keyboard movement between input and mic keeps ticket; leaving pair cancels',async()=>{
   await setup();const ticket=await page.evaluate(()=>HubVoice.permissionTicket());await page.focus('.voice-button');await page.focus('#input');await tick();assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),ticket);await page.focus('.voice-button');await page.focus('#other');assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);
  });
  await t.test('editing during native prompt still aborts',async()=>{
   await setup();await page.evaluate(()=>{Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});document.querySelector('#input').dispatchEvent(new FocusEvent('blur',{relatedTarget:null}));const input=document.querySelector('#input');input.value='手入力';input.dispatchEvent(new Event('input',{bubbles:true}));sessions[0].result('遅延');sessions[0].end();});await tick();assert.equal(await page.inputValue('#input'),'手入力');assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);
  });
  await t.test('hidden page still aborts while window lacks focus',async()=>{
   await setup();await page.evaluate(()=>{Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});document.querySelector('#input').dispatchEvent(new FocusEvent('blur',{relatedTarget:null}));Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));sessions[0].result('遅延');sessions[0].end();});await tick();assert.equal(await page.inputValue('#input'),'前後');assert.equal(await page.evaluate(()=>HubVoice.permissionTicket()),'');assert.equal(await page.evaluate(()=>sessions[0].aborted),true);
  });
 }finally{await browser.close();}
});
