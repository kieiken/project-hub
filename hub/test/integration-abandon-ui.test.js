'use strict';
// Actual browser script with a synthetic DOM/backend; real Chrome evidence is separate.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'),selection=require('../public/integration-selection');
const preview=(p='A')=>({project:p,task:'parent',simple:true,id:p+'-integration',token:p+'-preview',items:[],auto:{stopped:{reason:'止めました'}},resumeAllowed:false,abandon:{allowed:true,message:'未受領の中止',items:[{title:'価値',project:p,task:'child'}]}});
const deferred=()=>{let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n;});return {promise,resolve,reject};};
function ui(backend){
 const elements=new Map(),listeners=new Map(),el=s=>{if(!elements.has(s)){const x={disabled:false,hidden:false,dataset:{},checked:false,textContent:'',insertAdjacentHTML(){},closest(){return this;},matches(q){return q==='#integration-abandon-confirm'&&s===q;}};let html='';Object.defineProperty(x,'innerHTML',{get:()=>html,set:v=>{html=v;if(s==='#integrate-sheet')el('#integration-abandon-confirm').checked=false;}});elements.set(s,x);}return elements.get(s);};
 const buttons=['abandon-preview','abandon-confirm'].map(a=>{const b=el('#integrate-sheet [data-integrate-action="'+a+'"]');b.dataset.integrateAction=a;return b;});
 const ctx=vm.createContext({$:el,esc:x=>String(x),HubIntegrationSelection:selection,clearTimeout(){},setTimeout(){return 1;},document:{hidden:false,addEventListener(k,v){listeners.set(k,v);},body:{insertAdjacentHTML(){}},querySelectorAll(s){return s.includes('button,')?[...buttons,el('#integration-abandon-confirm')]:[];}},transferError:e=>e.message,api:backend});vm.runInContext(source,ctx);
 return {el,run:s=>vm.runInContext(s,ctx),show:p=>vm.runInContext('showTaskIntegration('+JSON.stringify(p)+',"parent")',ctx),click:a=>listeners.get('click')({target:buttons[a==='abandon-preview'?0:1]}),check(){el('#integration-abandon-confirm').checked=true;listeners.get('change')({target:el('#integration-abandon-confirm')});},button:a=>buttons[a==='abandon-preview'?0:1],view:()=>JSON.parse(vm.runInContext('JSON.stringify({project:integratePreview?.project,refresh:integratePreview?.requiresRefresh,busy:integrateBusy,remembered:integrateAbandonUncertain.has(integratePreview?.id)})',ctx))};
}
const confirm=p=>({allowed:true,id:p+'-integration',token:p+'-abandon-token',items:[{title:'価値'}]});
test('中止UI 対象と確認チェック必須・連打1回・正式結果の再取得',async()=>{
 const pending=deferred(),calls=[];let ended=false;
 const screen=ui(async(route,b)=>{calls.push({route,b});if(route.endsWith('/preview'))return ended?{...preview(b.project),auto:undefined,abandon:undefined}:preview(b.project);if(b.preview)return confirm(b.project);return pending.promise;});
 await screen.show('A');assert.match(screen.el('#integrate-sheet').innerHTML,/中止して選び直す/);await screen.click('abandon-preview');assert.match(screen.el('#integrate-sheet').innerHTML,/価値/);assert.equal(screen.button('abandon-confirm').disabled,true);await screen.click('abandon-confirm');assert.equal(calls.filter(x=>x.b.confirm).length,0);
 screen.check();assert.equal(screen.button('abandon-confirm').disabled,false);const first=screen.click('abandon-confirm');await screen.click('abandon-confirm');assert.equal(calls.filter(x=>x.b.confirm).length,1);ended=true;pending.resolve({abandoned:true,received:0});await first;assert.equal(screen.view().busy,false);assert.equal(calls.filter(x=>x.route.endsWith('/preview')).length,2);
});
for(const [label,reply] of [['unknown',()=>Promise.reject(Object.assign(Error('unknown'),{delivery:{state:'unknown'}}))],['通信欠落',()=>Promise.reject(Error('network'))],['結果欠落',()=>({ok:true})]])test('中止UI '+label+' はfresh同IDでも再送0',async()=>{
 let sends=0;const screen=ui(async(route,b)=>route.endsWith('/preview')?preview(b.project):b.preview?confirm(b.project):(sends++,reply()));await screen.show('A');await screen.click('abandon-preview');screen.check();await screen.click('abandon-confirm');assert.equal(screen.view().remembered,true);assert.equal(screen.button('abandon-confirm').disabled,true);assert.equal(screen.button('abandon-preview').disabled,true);
 await screen.show('A');await screen.click('abandon-preview');screen.check();await screen.click('abandon-confirm');assert.equal(sends,1);assert.equal(screen.button('abandon-preview').disabled,true);
});
test('中止UI 確定not-sentも新preview/token/check前は再送0',async()=>{
 let sends=0,previews=0;const screen=ui(async(route,b)=>route.endsWith('/preview')?preview(b.project):b.preview?(previews++,{...confirm(b.project),token:'token-'+previews}):(sends++,Promise.reject(Object.assign(Error('changed'),{delivery:{state:'not-sent'}}))));await screen.show('A');await screen.click('abandon-preview');screen.check();await screen.click('abandon-confirm');assert.equal(screen.view().remembered,false);assert.equal(screen.view().refresh,true);assert.equal(screen.button('abandon-preview').disabled,true);await screen.click('abandon-confirm');assert.equal(sends,1);
 await screen.show('A');await screen.click('abandon-preview');assert.equal(screen.el('#integration-abandon-confirm').checked,false);assert.equal(screen.button('abandon-confirm').disabled,true);screen.check();await screen.click('abandon-confirm');assert.equal(sends,2);assert.equal(previews,2);
});
for(const action of ['abandon-preview','abandon-confirm'])test('中止UI 別作業の処理中に来た遅延'+action+'は画面/排他を変えない',async()=>{
 const a=deferred(),b=deferred();let aCalls=0;
 const screen=ui(async(route,x)=>route.endsWith('/preview')?preview(x.project):x.project==='A'?(action==='abandon-confirm'&&x.preview?confirm('A'):(aCalls++,a.promise)):x.preview?confirm('B'):b.promise);
 await screen.show('A');if(action==='abandon-confirm'){await screen.click('abandon-preview');screen.check();}const old=screen.click(action);
 screen.run('integrateEpoch++;integrateBusy=false;integratePreview=null');await screen.show('B');await screen.click('abandon-preview');screen.check();const current=screen.click('abandon-confirm'),html=screen.el('#integrate-sheet').innerHTML;
 a.reject(Object.assign(Error('late A'),{delivery:{state:'unknown'}}));await old;assert.equal(screen.view().project,'B');assert.equal(screen.view().busy,true);assert.equal(screen.el('#integrate-sheet').innerHTML,html);assert.equal(aCalls,1);b.reject(Object.assign(Error('B unknown'),{delivery:{state:'unknown'}}));await current;assert.equal(screen.view().busy,false);
});
for(const mode of ['quarantine','finalize'])test('回復UI preserves confirmation and does not resend the aborted request: '+mode,async()=>{
 const calls=[];let ended=false;const recovery={kind:mode==='quarantine'?'archive-torn':'archived-not-saved',action:mode,sha256:'a'.repeat(64)};
 const screen=ui(async(route,b)=>{calls.push({route,b});if(route.endsWith('/preview'))return {...preview(b.project),abandon:{allowed:true,message:'保存だけを回復',recovery}};if(b.preview)return {...confirm(b.project),recovery};ended=true;return mode==='quarantine'?{recovered:mode}:{recovered:mode,abandoned:true};});
 await screen.show('A');await screen.click('abandon-preview');assert.equal(calls[1].b.recover,mode);assert.equal(screen.button('abandon-confirm').disabled,true);screen.check();await screen.click('abandon-confirm');assert.equal(ended,true);assert.equal(calls.filter(x=>x.b.confirm).length,1);assert.equal(Boolean(screen.view().refresh),false);
});
test('回復UI uses a new recovery identity after an uncertain ordinary abort',async()=>{
 let recovery=false,sends=0;
 const screen=ui(async(route,b)=>route.endsWith('/preview')?{...preview(b.project),...(recovery?{abandon:{allowed:true,recovery:{action:'finalize',sha256:'b'.repeat(64)},message:'保存を完了'}}:{})}:b.preview?confirm(b.project):(sends++,Promise.reject(Object.assign(Error('uncertain'),{delivery:{state:'unknown'}}))));
 await screen.show('A');await screen.click('abandon-preview');screen.check();await screen.click('abandon-confirm');assert.equal(sends,1);assert.equal(screen.button('abandon-preview').disabled,true);
 recovery=true;await screen.show('A');assert.equal(screen.button('abandon-preview').disabled,false);await screen.click('abandon-preview');assert.equal(screen.button('abandon-confirm').disabled,true);
});

for(const allowed of [true,false])test('自動検査停止UIは人の停止と区別し、選び直し可否を正しく表示：'+allowed,async()=>{
 const screen=ui(async()=>({...preview(),auto:{stopped:{reason:'成果の形式が不正：作業用コピー保存済み'}},abandon:{allowed,stopKind:'validation',message:'正常終了後の検査停止'}}));
 await screen.show('A');const html=screen.el('#integrate-sheet').innerHTML;
 assert.match(html,/停止した統合/);assert.doesNotMatch(html,/人が止めた統合/);assert.match(html,/停止理由.*成果の形式が不正：作業用コピー保存済み/);
 if(allowed){assert.match(html,/中止して選び直す/);assert.match(html,/選び直せる候補/);}else{assert.doesNotMatch(html,/選び直せる候補/);assert.doesNotMatch(html,/data-integrate-action="abandon-preview"/);assert.match(html,/安全を確認できないため/);}
});
test('人の停止UIは従来の見出しを維持',async()=>{const screen=ui(async()=>({...preview(),abandon:{allowed:true,stopKind:'human',message:'人の停止'}}));await screen.show('A');assert.match(screen.el('#integrate-sheet').innerHTML,/人が止めた統合/);});
