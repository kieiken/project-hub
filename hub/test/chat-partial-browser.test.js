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
