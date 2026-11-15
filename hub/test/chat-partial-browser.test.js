'use strict';
// The stream is synthetic; page scripts and DOM/selection/scrolling are real.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
test('tool progress preserves partial reply selection; changed text, idle, reconnect and stale streams stay correct',{skip:!chromium||!chrome},async t=>{
 const data=snapshot();data.museSupported=false;data.projects[0].tasks.push({...data.projects[0].tasks[0],id:'other',title:'Other'});
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
 browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(8000);
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  localStorage.setItem('hub-view',JSON.stringify({kind:'work',project:'p',task:'t'}));localStorage.setItem('hub-mode','chat');localStorage.setItem('hub-detail','1');
  window.__streams=[];window.EventSource=class{constructor(){window.__streams.push(this);}close(){this.readyState=2;}};
 });
 await page.goto(base);await page.waitForSelector('#chat-in');
 const result=await page.evaluate(async()=>{
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const stream=()=>window.__streams.at(-1),emit=(ev,s=stream())=>s.onmessage({data:JSON.stringify(ev)});
  const rows=Array.from({length:30},(_,i)=>({role:'user',text:('保存済み会話 '+i+'\n').repeat(8)}));
  emit({type:'rows',rows,queue:[],busy:null});
  const text='生成中の本文\n> 引用\r\n```text\n<unsafe>&\r\n';
  const busy={ai:'codex',started:Date.now()-3000,text};
  emit({type:'busy',...busy});emit({type:'partial',ai:'codex',text});
  const box=document.querySelector('#msgs'),mb=box.querySelector('#msg-partial .mb'),code=mb.querySelector('.codeblock:not(.quote-block) code');
  const html=mb.innerHTML;check(html.includes('&lt;unsafe&gt;')&&!mb.querySelector('unsafe'),'escaping');
  check(!mb.querySelector('.cb-copy'),'unfinished quote/fence has no copy button');
  const range=document.createRange();range.selectNodeContents(code);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const selected=selection.toString();
  emit({type:'row',row:{role:'event',tool:true,text:'ツールの経過'}});emit({type:'partial',ai:'codex',text});
  check(mb.querySelector('.codeblock:not(.quote-block) code')===code&&mb.innerHTML===html,'unchanged text DOM');check(selection.toString()===selected,'reading selection lost');
  check(document.querySelector('.wk-last').textContent.includes('ツールの経過'),'tool status stopped');check(document.querySelector('.wk-time').textContent,'elapsed label missing');
  const complete=text+'```\n';emit({type:'partial',ai:'codex',text:complete});check(mb.innerHTML!==html&&mb.querySelector('.codeblock:not(.quote-block) code').textContent.includes('<unsafe>&\r\n'),'changed partial or CRLF lost');
  emit({type:'partial',ai:'codex',text:''});check(mb.hidden&&mb.innerHTML==='','empty partial not cleared');
  emit({type:'partial',ai:'codex',text:complete});check(!mb.hidden&&mb.innerHTML,'partial not restored');
  const previous=document.querySelector('#msg-partial');emit({type:'idle'});check(!document.querySelector('#msg-partial'),'idle left partial');
  emit({type:'busy',...busy});emit({type:'partial',ai:'codex',text:complete});check(document.querySelector('#msg-partial')!==previous&&document.querySelector('#msg-partial .mb').innerHTML,'new run reused disposed reply');
  emit({type:'rows',rows,queue:[],busy:{...busy,text:complete}});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));check(document.querySelector('#msg-partial .mb').innerHTML,'snapshot busy lost text');
  emit({type:'row',row:{role:'assistant',ai:'codex',text:complete}});emit({type:'idle'});check(box.querySelector('.m.ai .cb-copy'),'final copy button absent');
  const finalCode=box.querySelector('.m.ai .codeblock:not(.quote-block) code');check(finalCode.textContent==='<unsafe>&\r\n','copy source changed');
  // Reading older messages must stay at the same point on tool status changes.
  emit({type:'busy',...busy});emit({type:'partial',ai:'codex',text:complete});box.scrollTop=120;box.dispatchEvent(new Event('scroll'));const top=box.scrollTop;
  emit({type:'row',row:{role:'event',tool:true,text:'次の経過'}});check(Math.abs(box.scrollTop-top)<1,'reading scroll changed');
  const old=stream();view={kind:'work',project:'p',task:'other'};renderWork();const current=stream();emit({type:'rows',rows:[],queue:[],busy:null},current);
  emit({type:'partial',ai:'codex',text:'古い応答'},old);check(!document.querySelector('#msg-partial'),'stale stream wrote into new view');
  emit({type:'busy',...busy},current);emit({type:'partial',ai:'codex',text:complete},current);check(document.querySelector('#msg-partial .mb').innerHTML,'new view cache not reset');
  return {selectionPreserved:true,copySourcePreserved:true,scrollPreserved:true,staleStreamIgnored:true};
 });
 assert.deepEqual(result,{selectionPreserved:true,copySourcePreserved:true,scrollPreserved:true,staleStreamIgnored:true});assert.deepEqual(errors,[]);
 assert.deepEqual(requests.filter(x=>x.startsWith('POST ')&&x!=='POST /api/freetalk/ensure'),[]);
});

for (const width of [1280,390]) test('long history tail paint, selection flush, anchors, streaming, cancellation and fallback '+width+'px', {skip:!chromium||!chrome}, async t=>{
 const data=snapshot();data.museSupported=false;
 const publicDir=path.resolve(__dirname,'../public'),errors=[],requests=[];let browser;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(req.method+' '+url.pathname);
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/state'?data:{}));}
  const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 });
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(8000);
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  localStorage.setItem('hub-view',JSON.stringify({kind:'work',project:'p',task:'t'}));localStorage.setItem('hub-mode','chat');
  window.__streams=[];window.EventSource=class{constructor(){window.__streams.push(this);}close(){this.readyState=2;}};
 });
 await page.goto(base);await page.waitForSelector('#chat-in',{state:'attached'});
 await page.evaluate(()=>{
  loadUsage=()=>{};loadMuseApprovals=()=>{};
  window.__emit=ev=>window.__streams.at(-1).onmessage({data:JSON.stringify(ev)});
  window.__rows=Array.from({length:2048},(_,i)=>({role:i%2?'assistant':'user',ai:'codex',at:new Date(Date.UTC(2026,10,1,0,i)).toISOString(),text:'history-'+i+'\n'+('long fixture text '.repeat(30))}));
  __rows[0].text='first history <script>\n```text\nraw <tag> & value\n```';
  __rows[2047].text='last history';__rows[2047].generatedImages=[{path:'fixture/image.png',name:'fixture.png'}];
  window.__snapshot=()=>__emit({type:'rows',rows:__rows,queue:[],busy:{ai:'codex',text:'streaming reply'},pendingQuestion:{source:'fixture-source',asks:[{question:'Choose?',options:['Yes','No']}]}});
 });
 const initial=await page.evaluate(()=>{__snapshot();return {count:document.querySelectorAll('#msgs > .m[data-role]').length,pending:typeof document.querySelector('#msgs').hubFlushRows,history:document.querySelector('#msgs').dataset.askHistoryPending};});
 assert.equal(initial.count,32,'initial task must leave older history for later frames');assert.equal(initial.pending,'function');assert.equal(initial.history,'1');
 // A connection error while older rows are pending must retain the tail.
 await page.evaluate(()=>{const stream=__streams.at(-1);stream.readyState=1;stream.onerror();});
 assert.equal(await page.locator('#msgs .chat-loading').count(),0);
 assert.match(await page.locator('#msgs').innerText(),/last history/);
 if (await page.locator('#chat-in').isHidden()) await page.locator('#mobile-compose').click();
 await page.locator('#chat-in').fill('retained draft');
 await page.waitForFunction(()=>document.querySelector('#msg-partial .mb')?.textContent==='streaming reply');
 // Move upward while prepends are still running; the same existing DOM row
 // must stay at the same viewport position across subsequent prepends.
 const reading=await page.evaluate(async()=>{
  const box=document.querySelector('#msgs');box.scrollTop-=240;
  HubChatScroll.change(box,()=>{});
  const node=[...box.children].find(n=>n.getBoundingClientRect().bottom>box.getBoundingClientRect().top);
  window.__reading=node;const top=node.getBoundingClientRect().top;
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  return {drift:node.getBoundingClientRect().top-top,pending:typeof box.hubFlushRows};
 });
 assert.ok(Math.abs(reading.drift)<2,'prepending must hold the visible reading anchor');
 assert.equal(reading.pending,'function','anchor check must run before the history finishes');
 // New rows and partial text must remain after history, without rebuilding
 // the question controls or losing an answer draft.
 await page.locator('.ask-free').fill('answer draft');
 await page.evaluate(()=>{__emit({type:'row',row:{role:'assistant',ai:'codex',text:'new appended row'}});__emit({type:'partial',ai:'codex',text:'updated streaming reply'});});
 await page.waitForFunction(()=>!document.querySelector('#msgs').hubFlushRows);
 assert.equal(await page.locator('#msgs > .m[data-role]').count(),2049);
 assert.equal(await page.locator('.ask-free').inputValue(),'answer draft');assert.equal(await page.locator('#chat-in').inputValue(),'retained draft');
 assert.equal(await page.locator('#msg-partial .mb').textContent(),'updated streaming reply');
 assert.equal(await page.locator('#msgs > .m[data-role]').last().locator('.mb').textContent(),'new appended row');
 assert.equal(await page.locator('#msgs > .m[data-role]').first().locator('code').textContent(),'raw <tag> & value\n');
 assert.equal(await page.locator('#msgs script').count(),0);assert.ok(await page.locator('#msgs [data-image-path], #msgs [data-file-path], #msgs a, #msgs [data-view-file]').count());
 assert.equal(await page.locator('#msgs').evaluate(e=>e.dataset.askHistoryPending),undefined);
 // A fresh bottom snapshot defers again; selecting the conversation must
 // finish it before the browser's default Select All / Copy operation.
 const selected=await page.evaluate(()=>{
  document.querySelector('#chat-latest').click();__snapshot();
  const box=document.querySelector('#msgs'),pending=typeof box.hubFlushRows;
  if(box.dataset.askHistoryPending!=='1')throw Error('reconnected history must keep pending question drafts');
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
  const selection=getSelection(),range=document.createRange();range.selectNodeContents(box);selection.removeAllRanges();selection.addRange(range);
  document.body.dispatchEvent(new Event('copy',{bubbles:true}));
  const value=selection.toString();selection.removeAllRanges();
  return {pending,count:box.querySelectorAll(':scope > .m[data-role]').length,first:value.includes('first history'),last:value.includes('last history')};
 });
 assert.equal(selected.pending,'function');assert.equal(selected.count,2048);assert.ok(selected.first&&selected.last);
 // Pointer selection and context-menu copy also finish early; copying a
 // single message retains the complete original text, not the rendered HTML.
 await page.evaluate(()=>{document.querySelector('#chat-latest').click();__snapshot();document.querySelector('#msgs').dispatchEvent(new Event('pointerdown',{bubbles:true}));});
 assert.equal(await page.locator('#msgs > .m[data-role]').count(),2048);
 await page.evaluate(()=>{document.querySelector('#chat-latest').click();__snapshot();document.body.dispatchEvent(new Event('contextmenu',{bubbles:true}));});
 assert.equal(await page.locator('#msgs > .m[data-role]').count(),2048);
 assert.equal(await page.locator('#msgs > .m[data-role]').last().locator('.cp-msg').getAttribute('data-copy'),'last history');
 // Reconnect supersedes an unfinished snapshot; old batches must not return.
 await page.evaluate(()=>{document.querySelector('#chat-latest').click();__snapshot();__emit({type:'rows',rows:[{role:'user',text:'replacement snapshot'}],queue:[],busy:null});});
 await page.waitForTimeout(100);assert.equal(await page.locator('#msgs > .m[data-role]').count(),1);assert.match(await page.locator('#msgs').innerText(),/replacement snapshot/);
 // Navigation disposes pending callbacks; a detached box stops changing.
 const detached=await page.evaluate(()=>{__snapshot();window.__oldBox=document.querySelector('#msgs');navigateView({kind:'project',project:'p'});return __oldBox.childElementCount;});
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>__oldBox.childElementCount),detached);
 await page.evaluate(()=>navigateView({kind:'work',project:'p',task:'t'}));
 // Missing scheduling capability takes the synchronous existing path.
 const fallback=await page.evaluate(()=>{const original=cancelAnimationFrame;window.cancelAnimationFrame=undefined;try{__snapshot();return document.querySelectorAll('#msgs > .m[data-role]').length;}finally{window.cancelAnimationFrame=original;}});
 assert.equal(fallback,2048);
 // A redraw while reading preserves the saved position with the complete
 // snapshot immediately, rather than replacing the view with just its tail.
 const redraw=await page.evaluate(()=>{const box=document.querySelector('#msgs');box.scrollTop=100;HubChatScroll.change(box,()=>{});__snapshot();return {count:box.querySelectorAll(':scope > .m[data-role]').length,top:box.scrollTop};});
 assert.equal(redraw.count,2048);assert.ok(Math.abs(redraw.top-100)<2);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.deepEqual(errors,[]);assert.equal(requests.filter(x=>/POST \/api\/chat\/send/.test(x)).length,0);
});
