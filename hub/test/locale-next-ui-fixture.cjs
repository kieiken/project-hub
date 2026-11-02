'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
let chromium;try{({chromium}=require('playwright-core'));}catch{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}
const publicDir=path.resolve(__dirname,'../public');
const chrome=process.env.HUB_TEST_CHROME||[path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
module.exports=async function fixture(t,locale='ja',sources={}){
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body><main id="main"></main><div data-tab="manage"><div class="pref-list"></div></div><section class="pref-section"><div id="app-update-box"></div></section></body></html>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync']});
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 const messages=locale==='ja'?{}:require('../../langpacks/'+locale+'/ui.json');
 await page.evaluate(({locale,messages})=>window.HUB_LOCALE={locale,messages},{locale,messages});
 await page.addScriptTag({content:fs.readFileSync(path.join(publicDir,'locale.js'),'utf8')});
 await page.addScriptTag({content:`var UI=HubI18n,$=s=>document.querySelector(s),state={root:'/日本語/保存先'},settingsTab='manage',view={},rolesDirty=false;
 var esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 var render=()=>{},toast=()=>{},confirm=()=>false;
 var locationPending=false,importMode='preview';
 async function api(route){
  const current={workspace:'/日本語/保存先',freetalk:'/自由対話'};
  if(route==='/api/data-location')return {current,management:'/管理',standard:{workspace:'/標準',exists:true},pending:locationPending?{workspace:'/次の保存先'}:null};
  if(route==='/api/data-location/preview')return {notice:'日本語の利用者データ',workspace:'/日本語/保存先',freetalk:'/自由対話',projects:[{name:'日本語の計画'}],settings:['設定の原文'],warnings:[],token:'opaque'};
  if(route==='/api/legacy-import')return {defaults:{workspace:'/以前',freetalk:'/以前の会話'}};
  if(route==='/api/legacy-import/preview')return {mode:importMode,projects:[{name:'日本語の計画',target:'/保存先'}],files:3,topics:2,settings:{preserved:'利用者の原文'},notice:'利用者の注意',token:'opaque'};
  if(route==='/api/legacy-import/settings')return {view:{order:['codex']},roles:[{name:'コーディング',main:{ai:'codex',model:'gpt-6.1-sol'},backup:{ai:'claude',model:'claude-opus-5-5'}}]};
  throw Error('Unexpected route '+route);
 }
 window.fetch=async()=>({ok:true,json:async()=>({rev:1,orderRev:1,items:[{id:'one',text:'日本語の原文 <表示言語>',category:'note',intent:'record',status:'note',contentRev:1,controlRev:1,questions:[]}],itemOrder:['one'],total:1,counts:{categories:{note:1},all:1,waiting:0},erased:{}})});`});
 for(const name of ['data-location','legacy-import','ideas'])await page.addScriptTag({content:sources[name]??fs.readFileSync(path.join(publicDir,name+'.js'),'utf8')});
 return {page,errors,async views(){const output={};await page.evaluate(()=>renderDataLocationEmpty());output.empty=await page.locator('#main').innerHTML();await page.evaluate(()=>loadDataLocation());output.location=await page.locator('#data-location').innerHTML();await page.locator('#data-location-preview').click();output.locationPreview=await page.locator('#data-location-plan').innerHTML();await page.evaluate(()=>{locationPending=true;return loadDataLocation();});output.pending=await page.locator('#data-location').innerHTML();await page.evaluate(()=>loadLegacyImport());output.legacy=await page.locator('#legacy-import-section').innerHTML();await page.locator('#legacy-preview').click();output.legacyPreview=await page.locator('#legacy-preview-result').innerHTML();await page.evaluate(()=>{importMode='complete';return loadLegacyImport();});await page.locator('#legacy-preview').click();output.legacyComplete=await page.locator('#legacy-preview-result').innerHTML();await page.evaluate(()=>{importMode='interrupted';return loadLegacyImport();});await page.locator('#legacy-preview').click();output.legacyInterrupted=await page.locator('#legacy-preview-result').innerHTML();await page.evaluate(()=>HubIdeas.open('日本語の計画','task'));output.ideas=await page.locator('.ideas-dialog').innerHTML();return output;}};
};
