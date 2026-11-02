'use strict';
// Offline local fixture: real browser DOM/events and real display-name persistence, no Muse helper.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {snapshot}=require('./fixtures/app-ui-harness.cjs'),{ModelView}=require('../lib/model-view');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
for (const projectId of ['p','freetalk']) test('Muse phone/PC labels: edit, immediate sync, reload, defaults, modes, support change and existing names ('+projectId+')',{skip:!chromium||!chrome},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'muse-label-browser-')),modelView=new ModelView(path.join(root,'view.json'));
 const data=snapshot();data.museSupported=true;data.roles.models={codex:['GPT-6.1-Sol']};data.initialPick={ai:'codex',model:'GPT-6.1-Sol',effort:'高'};
 if(projectId==='freetalk'){data.projects[0].id=data.projects[0].kind='freetalk';data.projects[0].tasks[0].freetalk=true;}
 modelView.setPhone({key:'codex|GPT-6.1-Sol',name:'ソル'},data.roles.models);
 const publicDir=path.resolve(__dirname,'../public'),requests=[],errors=[];let browser;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(req.method+' '+url.pathname);
  if(url.pathname==='/api/models/phone'&&req.method==='POST'){
   let raw='';req.on('data',s=>raw+=s);req.on('end',()=>{const r=modelView.setPhone(JSON.parse(raw),data.roles.models);res.writeHead(r.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(r));});return;
  }
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname==='/api/state'?{...data,phoneLabels:modelView.phone()}:{}));}
  const file=path.resolve(publicDir,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(publicDir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 });
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage({viewport:{width:390,height:844},userAgent:'iPhone Mobile test'});page.setDefaultTimeout(8000);
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(project=>{
  localStorage.setItem('hub-view',JSON.stringify({kind:'work',project,task:'t'}));localStorage.setItem('hub-mode','chat');
  window.EventSource=class{close(){}};
 },projectId);
 await page.goto(base);await page.waitForSelector('#chat-ai option[value="muse|direct"]',{state:'attached'});
 const label=()=>page.locator('#chat-ai option[value="muse|direct"]').textContent();
 assert.equal(await label(),'Muse');
 const mount=()=>page.evaluate(()=>{
  view.kind='settings';let card=document.querySelector('#phone-labels');if(!card){card=document.createElement('div');card.id='phone-labels';document.body.append(card);}card.innerHTML=phoneLabelsHtml();
 });
 await mount();const input=page.locator('[data-phone-name="muse|direct"]');
 assert.equal(await input.getAttribute('placeholder'),'Muse');assert.equal(await input.getAttribute('maxlength'),'24');
 const edit=async name=>{await input.fill(name);await input.press('Tab');await page.waitForFunction(()=>!phoneLabelsSaving&&!phoneLabelDrafts.has('muse|direct'));};
 await edit('ミューズ <&>');assert.equal(await label(),'ミューズ <&>');assert.equal(modelView.phone().names['muse|direct'],'ミューズ <&>');
 await page.reload();await page.waitForSelector('#chat-ai option[value="muse|direct"]',{state:'attached'});assert.equal(await label(),'ミューズ <&>');await mount();assert.equal(await input.inputValue(),'ミューズ <&>');
 await page.locator('[data-phone-mode="full"]').check();await page.waitForFunction(()=>!phoneLabelsSaving&&state.phoneLabels.labels==='full');
 assert.equal(await input.isDisabled(),true);assert.equal(await label(),'Muse（外部）');
 await page.locator('[data-phone-mode="short"]').check();await page.waitForFunction(()=>!phoneLabelsSaving&&state.phoneLabels.labels==='short');assert.equal(await label(),'ミューズ <&>');
 await page.setViewportSize({width:1280,height:850});await page.evaluate(()=>syncChatPhoneLabels());assert.equal(await label(),'Muse（外部）');
 await edit('PCから編集');assert.equal(await label(),'Muse（外部）');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>syncChatPhoneLabels());assert.equal(await label(),'PCから編集');
 await edit('');assert.equal(await label(),'Muse');assert.equal(modelView.phone().names['muse|direct'],undefined);assert.equal(modelView.phone().names['codex|GPT-6.1-Sol'],'ソル');
 // Capability is supplied by the server, independent of this phone's user agent.
 assert.equal(await page.evaluate(()=>{const before=phoneSettingsKey();state.museSupported=false;const changed=before!==phoneSettingsKey();drawPhoneLabels();return changed;}),true);
 assert.equal(await input.count(),0);
 assert.equal(await page.evaluate(project=>chatModelChoices(proj(project),taskOf(proj(project),'t')).includes('muse|direct'),projectId),false);
 await page.evaluate(()=>{state.museSupported=true;drawPhoneLabels();});assert.equal(await input.count(),1);
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>r.startsWith('POST ')&&!['POST /api/models/phone','POST /api/freetalk/ensure'].includes(r)),[]);
});
