'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),cp=require('node:child_process');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=[path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
const root=path.resolve(__dirname,'../..'),results={at:new Date().toISOString(),series:[]};
test('bottom-followed history has no frame-to-frame shake at desktop and mobile widths',{skip:!chromium||!chrome},async t=>{
 const data=require(root+'/hub/test/fixtures/app-ui-harness.cjs').snapshot();data.museSupported=false;
 const pub=root+'/hub/public',overrides={};let browser;
 const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/api/file/view'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#7ab"/></svg>');}if(u.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(u.pathname==='/api/state'?data:{}));}
 const f=path.resolve(pub,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(pub+'/')||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(overrides[u.pathname]??fs.readFileSync(f));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 browser=await chromium.launch({executablePath:chrome,headless:true});results.browser=browser.version();const base='http://127.0.0.1:'+server.address().port;
 const variant=process.env.HUB_CHAT_SCROLL_REF||'current';
 if(variant!=='current')overrides['/chat-scroll.js']=cp.execFileSync('git',['show',variant+':hub/public/chat-scroll.js'],{cwd:root});
 for(const width of [1280,390])for(const scale of [1,2])for(const count of [512,960]){
 const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:scale,serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 await page.addInitScript(()=>{localStorage.setItem('hub-view',JSON.stringify({kind:'work',project:'p',task:'t'}));localStorage.setItem('hub-mode','chat');window.__streams=[];window.EventSource=class{constructor(){window.__streams.push(this);}close(){this.readyState=2;}};});
 await page.goto(base);await page.waitForSelector('#chat-in',{state:'attached'});
 const sample=await page.evaluate(async count=>{
 loadUsage=()=>{};loadMuseApprovals=()=>{};const emit=ev=>__streams.at(-1).onmessage({data:JSON.stringify(ev)});
 const rows=Array.from({length:count},(_,i)=>({role:i%2?'assistant':'user',ai:'codex',at:new Date(Date.UTC(2026,10,1,0,i)).toISOString(),text:'Synthetic message '+i+'\n'+'合成文章で表示の高さを確かめます。'.repeat(45)+(i%3===0?'\n```js\nconst sample = 123;\n```\n|item|value|\n|--|--|\n|synthetic|ok|\n':'')}));
 rows.at(-1).generatedImages=[{path:'synthetic.png',name:'synthetic.png'}];
 await new Promise((resolve,reject)=>{const image=new Image();image.onload=resolve;image.onerror=reject;image.src=fileViewUrl('synthetic.png');});
 rows.at(-1).text='Tail marker\n'+'末尾の合成本文です。'.repeat(15);for(let i=15;i<count;i+=64)rows[i].generatedImages=[{path:'synthetic.png',name:'synthetic.png'}];
 const start=performance.now();let sync;
 emit({type:'rows',rows,queue:[],busy:{ai:'codex',model:'GPT-6.1-Sol',started:Date.now()-30000,text:count===512?'':'In progress\n'+'合成の作業中の返事です。'.repeat(18)},pendingQuestion:{source:'synthetic-question',asks:[{question:'Synthetic question?',options:['yes','no']}]}});sync=performance.now()-start;
 const box=document.querySelector('#msgs'),frames=[];let initialPaint=null;
 for(let i=0;i<130;i++){
 await new Promise(requestAnimationFrame);const now=performance.now()-start;if(i===1)initialPaint=now;
 const tail=[...box.querySelectorAll('.m[data-role]')].at(-1),busy=box.querySelector('#msg-partial');
 frames.push({ms:now,tailTop:tail?.getBoundingClientRect().top,busyTop:busy?.getBoundingClientRect().top,top:box.scrollTop,height:box.scrollHeight,client:box.clientHeight,count:box.querySelectorAll(':scope > .m[data-role]').length,pending:!!box.hubFlushRows,busyHeight:busy?.getBoundingClientRect().height,boxTop:box.getBoundingClientRect().top});
 }
 // The first two frames include initial image/partial-text appearance. Measure
 // every subsequent frame, with older history still being prepended.
 const summary=key=>{const values=frames.slice(2).map(x=>x[key]);let reversals=0,last=0;for(let i=1;i<values.length;i++){const d=values[i]-values[i-1];if(Math.abs(d)<0.01)continue;const s=Math.sign(d);if(last&&s!==last)reversals++;last=s;}return {range:Math.max(...values)-Math.min(...values),reversals,lastChangeMs:frames.filter((f,i)=>i>2&&Math.abs(f[key]-frames[i-1][key])>0.01).at(-1)?.ms||0};};
 if(![...box.querySelectorAll('.chat-image img')].at(-1)?.naturalWidth)throw Error('synthetic image must load');
 return {sync,initialPaint,frames,tail:summary('tailTop'),busy:summary('busyTop')};
 },count);
 results.series.push({variant,width,scale,count,...sample});if(process.env.HUB_CHAT_SHAKE_OUTPUT)fs.writeFileSync(process.env.HUB_CHAT_SHAKE_OUTPUT,JSON.stringify(results,null,2));
 assert.equal(sample.frames[0].count,32,'tail still paints first');
 assert.equal(sample.frames[2].pending,true,'shake sampling must start before older history finishes');
 assert.equal(sample.frames.at(-1).count,count,'all older rows remain in DOM');
 assert.equal(sample.tail.range,0,`tail shake at ${width}px scale ${scale}: ${JSON.stringify(sample.tail)}`);
 assert.equal(sample.busy.range,0,`busy shake at ${width}px scale ${scale}: ${JSON.stringify(sample.busy)}`);
 assert.deepEqual(errors,[]);await context.close();
 }
});
