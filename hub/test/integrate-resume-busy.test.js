'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),{IntegrateAuto}=require('../lib/integrate-auto');
function fixture(){
 let waits=[],saves=0,applies=0,previewOptions;
 const tokens=new Map([['old',{value:{project:'p',task:'t'}}],['other',{value:{project:'q',task:'t'}}]]);
 const integrate={read:()=>({auto:{stopped:{reason:'stop'},attempts:{}}}),tokens,apply:b=>{applies++;return{ok:true,token:b.token};},preview:(p,t,o,options)=>{previewOptions=options;return{project:p,task:t,auto:{stopped:{reason:'stop'}},...(options.issueToken?{token:'new'}:{})};},resumeRecord:()=>{throw Error('must not mutate while waiting');}};
 integrate.readLane=integrate.read;
 const auto=new IntegrateAuto({integrate,waitStatus:()=>waits,notify:()=>saves++});
 return {auto,integrate,setWait:x=>{waits=x;},get options(){return previewOptions;},get saves(){return saves;},get applies(){return applies;}};
}
for(const kind of ['chat','terminal','background','queue','maintenance','github','cli','rebuild','update'])test('待機 '+kind+'：表示と拒否は同じ理由、停止記録と他作業tokenは保持',()=>{
 const f=fixture(),wait={kind,project:'q',task:'other',message:'別プロジェクト／別作業：待機原因'};f.setWait([wait]);
 const d=f.auto.preview({project:'p',task:'t'});assert.deepEqual(d.waiting,[wait]);assert.equal(d.token,undefined);assert.deepEqual(f.options,{allowBusy:true,issueToken:false,assignments:undefined,sibling:false});assert.equal(f.integrate.tokens.has('old'),false);assert.equal(f.integrate.tokens.has('other'),true);
 f.integrate.tokens.set('old',{value:{project:'p',task:'t'}});assert.throws(()=>f.auto.resume({project:'p',task:'t',token:'old'}),e=>e.stage==='waiting'&&e.code==='INTEGRATION_BUSY'&&JSON.stringify(e.waiting)===JSON.stringify(d.waiting));assert.equal(f.saves,0);assert.equal(f.integrate.tokens.has('old'),false);
 f.setWait([]);assert.deepEqual(f.auto.preview({project:'p',task:'t'}).waiting,[]);assert.deepEqual(f.options,{allowBusy:false,issueToken:true,assignments:undefined,sibling:false});
});
for(const kind of ['chat','terminal','background','queue','maintenance','github','cli','rebuild','update'])test('初回開始直前の '+kind+' は変更せず待機へ戻し、古いtokenを失効する',()=>{
 const f=fixture(),wait={kind,message:'別作業の処理中'};f.setWait([wait]);
 assert.throws(()=>f.auto.apply({project:'p',task:'t',token:'old'}),e=>e.code==='INTEGRATION_BUSY'&&e.stage==='waiting'&&e.waiting[0]===wait&&e.message.startsWith('統合の開始は待機中です'));
 assert.equal(f.applies,0);assert.equal(f.saves,0);assert.equal(f.integrate.tokens.has('old'),false);assert.equal(f.integrate.tokens.has('other'),true);
 f.setWait([]);assert.deepEqual(f.auto.apply({project:'p',task:'t',token:'fresh'}),{ok:true,token:'fresh'});assert.equal(f.applies,1);
});
test('統合処理の二重実行も同じ待機理由で拒否する',()=>{
 for(const owner of ['auto','integrate']){const f=fixture();f[owner].active=true;assert.equal(f.auto.waiting()[0].kind,'integration');assert.throws(()=>f.auto.resume({token:'old'}),e=>e.stage==='waiting');assert.equal(f.saves,0);}
});
test('既存busy callbackの利用側も同じ例外契約を維持する',()=>{
 const auto=new IntegrateAuto({integrate:{tokens:new Map()},busy:()=>true});assert.equal(auto.waiting()[0].kind,'busy');assert.throws(()=>auto.resume({}),e=>e.code==='INTEGRATION_BUSY');
});

const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function resumeUiFixture(locale='ja'){
 const elements=new Map(),handlers={},calls=[],timers=new Map();let timerId=0;
 const el=s=>{if(!elements.has(s))elements.set(s,{hidden:false,disabled:false,innerHTML:'',textContent:'',dataset:{},insertAdjacentHTML(position,html){this.textContent=position==='afterbegin'?html+this.textContent:this.textContent+html;}});return elements.get(s);};
 const ctx=vm.createContext({console,HubIntegrationSelection:require('../public/integration-selection'),HubI18n:require('./ui-locale-fixture')(locale),setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id);},document:{hidden:false,body:{insertAdjacentHTML(){}},querySelectorAll:()=>[],addEventListener:(event,fn)=>{handlers[event]=fn;}},$:el,esc:String,transferError:e=>e.message,load:async()=>{},render(){},toast(){}});
 const run=source=>vm.runInContext(source,ctx);
 let preview={id:'integration',resume:true,target:'copy',items:[],blockers:[],auto:{stopped:{at:'stop-one',reason:'review'},resumed:[]}};
 ctx.backend=async(route,body)=>{calls.push({route,body});if(route.endsWith('/preview'))return JSON.parse(JSON.stringify(preview));if(route.split('?')[0].endsWith('/wait'))return{waiting:ctx.waiting||[]};if(route.endsWith('/resume')||route==='/api/task/integrate'){if(ctx.gate)await ctx.gate;if(ctx.failure)throw ctx.failure;return route.endsWith('/resume')?{resumed:true,thenMain:false}:{complete:true};}throw Error(route);};
 run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));run('api=backend');
 const show=(project='p',task='parent')=>run(`showTaskIntegration(${JSON.stringify(project)},${JSON.stringify(task)})`);
 // Deliberately dispatch even when disabled: the handler must also reject a resend.
 const click=action=>handlers.click({target:{closest:s=>s==='[data-integrate-action]'?{disabled:false,dataset:{integrateAction:action}}:null}});
 const posts=()=>calls.filter(x=>x.route.endsWith('/resume'));
 return{ctx,run,el,show,click,posts,calls,timers,handlers,get preview(){return preview;},set preview(value){preview=value;},locked:()=>el('#integrate-sheet [data-integrate-action="resume"]').disabled};
}
test('再開の通信不明は再確認・閉じる・別親往復後も同じ停止へのPOSTを増やさない',async()=>{
 const f=resumeUiFixture();await f.show();f.ctx.failure=Error('connection lost');await f.click('resume');assert.equal(f.posts().length,1);assert.equal(f.locked(),true);
 f.ctx.failure=null;await f.click('refresh');await f.click('resume');assert.equal(f.posts().length,1);
 await f.click('close');await f.show();assert.equal(f.locked(),true);
 await f.click('close');await f.show('q','other');assert.equal(f.locked(),false);
 await f.click('close');await f.show();assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,1);assert.match(f.el('#integrate-status').textContent,/同じ停止記録への再送はしません/);
});
test('通信不明の記憶は親project・task・統合IDごとに分かれ、元の停止は保持する',async()=>{
 const f=resumeUiFixture();await f.show();f.ctx.failure=Error('connection lost');await f.click('resume');f.ctx.failure=null;
 for(const [project,task] of [['q','parent'],['p','other']]){await f.show(project,task);assert.equal(f.locked(),false);await f.show();assert.equal(f.locked(),true);}
 f.preview.id='another-integration';await f.show();assert.equal(f.locked(),false);f.preview.id='integration';await f.show();assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,1);
});
test('同じ統合IDでも別の停止時刻または再開履歴の世代には通信不明を持ち越さない',async()=>{
 const f=resumeUiFixture();await f.show();f.ctx.failure=Error('connection lost');await f.click('resume');f.ctx.failure=null;
 f.preview.auto.stopped.at='stop-two';await f.show();assert.equal(f.locked(),false);
 f.preview.auto.stopped.at='stop-one';f.preview.auto.resumed=[{at:'resumed'}];await f.show();assert.equal(f.locked(),false);
 f.preview.auto.resumed=[];await f.show();assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,1);
});
test('確定した進行表示を通信不明扱いにせず、古い停止の再表示は引き続きロックする',async()=>{
 const f=resumeUiFixture();await f.show();f.ctx.failure=Error('connection lost');await f.click('resume');const stop=f.preview.auto.stopped;
 delete f.preview.auto.stopped;await f.show();assert.equal(f.run('Boolean(integratePreview.resumeUncertain)'),false);assert.doesNotMatch(f.el('#integrate-sheet').innerHTML,/data-integrate-action="resume"/);
 f.preview.auto.stopped=stop;await f.show();assert.equal(f.locked(),true);assert.equal(f.posts().length,1);
});
test('busy拒否や記録変更の409は通信不明の記憶に混ぜず、新確認後だけ操作可能',async()=>{
 for(const busy of [false,true]){
  const f=resumeUiFixture();await f.show();f.ctx.failure=Object.assign(Error('changed'),{status:409,...(busy?{code:'INTEGRATION_BUSY',stage:'waiting',waiting:[{kind:'chat',message:'other AI'}]}:{stage:'refresh'})});
  await f.click('resume');assert.equal(f.locked(),true);f.ctx.failure=null;await f.show('q','other');await f.show();assert.equal(f.locked(),false);assert.equal(f.posts().length,1);await f.click('resume');assert.equal(f.posts().length,2);
 }
});
test('再開の遅延応答中は二重押し・別画面表示を拒否し、不明確定後も元対象だけロックする',async()=>{
 const f=resumeUiFixture();await f.show();let release;f.ctx.gate=new Promise(resolve=>{release=resolve;});f.ctx.failure=Error('delayed connection lost');
 const pending=f.click('resume');await f.click('resume');await f.show('q','other');assert.equal(f.posts().length,1);assert.equal(f.run('integratePreview.project'),'p');
 release();await pending;assert.equal(f.locked(),true);f.ctx.gate=null;f.ctx.failure=null;await f.show('q','other');assert.equal(f.locked(),false);await f.show();assert.equal(f.locked(),true);assert.equal(f.posts().length,1);
});
for(const failure of ['unknown','refresh'])for(const response of ['same','changed','waiting'])test('再開失敗後の遅い定期応答は再確認ロックを保持する '+failure+'/'+response,async()=>{
 const f=resumeUiFixture();await f.show();const backend=f.ctx.backend;let release;
 const stale=JSON.parse(JSON.stringify(f.preview));stale.token='stale-token';
 if(response==='changed')stale.confirmationHash='changed';
 if(response==='waiting')stale.waiting=[{message:'old waiting'}];
 f.ctx.api=(route,body)=>route.endsWith('/preview')?new Promise(resolve=>{release=resolve;}):backend(route,body);
 const checking=f.run('integrationCheckLatest()');
 f.ctx.failure=Object.assign(Error('resume failed'),failure==='refresh'?{status:409,stage:'refresh'}:{});
 await f.click('resume');assert.equal(f.posts().length,1);assert.equal(f.locked(),true);
 const message=f.el('#integrate-status').textContent;
 release(stale);await checking;
 assert.equal(f.run('Boolean(integratePreview.requiresRefresh)'),true);
 assert.equal(f.run('Boolean(integratePreview.resumeUncertain)'),failure==='unknown');
 assert.equal(f.el('#integrate-status').textContent,message);assert.equal(f.locked(),true);assert.equal(f.timers.size,0);
 await f.click('resume');assert.equal(f.posts().length,1);
 f.ctx.api=backend;f.ctx.failure=null;await f.click('refresh');
 assert.equal(f.locked(),failure==='unknown');await f.click('resume');assert.equal(f.posts().length,failure==='unknown'?1:2);
});
test('再開失敗がない遅い定期応答は最新tokenを採用し、再開を自動送信しない',async()=>{
 const f=resumeUiFixture();await f.show();let release;
 f.ctx.api=()=>new Promise(resolve=>{release=resolve;});
 const checking=f.run('integrationCheckLatest()');release({...f.preview,token:'fresh-token'});await checking;
 assert.equal(f.run('integratePreview.token'),'fresh-token');assert.equal(f.locked(),false);assert.equal(f.posts().length,0);assert.equal(f.timers.size,1);
});
test('不明送信後の待機解除でも新previewだけを取得し、同じ停止は再送しない',async()=>{
 const f=resumeUiFixture();await f.show();f.ctx.failure=Error('connection lost');await f.click('resume');f.ctx.failure=null;
 f.preview.waiting=[{kind:'chat',message:'other AI'}];await f.show();assert.equal(f.locked(),true);delete f.preview.waiting;
 await f.run('integrationCheckWait()');assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,1);
});
function initialPreview(waiting=[]){
 return {target:'copy',token:waiting.length?undefined:'fresh-token',items:[{project:'p',task:'child',title:'子',blockers:[],cleanupBlockers:[],descendants:[],results:[],files:[],remaining:{status:'あり',items:'端末確認',undecided:'なし',evidence:'確認記録'},source:{head:'new-head'},review:{scope:'対象成果',planned:'端末確認',undecided:'なし',residual:'端末確認',evidence:'確認記録'}}],blockers:[],waiting};
}
for(const locale of ['ja','zh-TW'])test('初回待機は開始と表示し、15秒確認後に新tokenで開始可能、開始は人が押した時だけ '+locale,async()=>{
 const f=resumeUiFixture(locale),waiting=[{kind:'chat',message:'別作業：AI稼働中'}];f.preview=initialPreview(waiting);f.ctx.waiting=waiting;await f.show();
 const button=f.el('#integrate-sheet [data-integrate-action="apply"]'),status=f.el('#integrate-status');assert.equal(button.disabled,true);assert.equal(button.textContent,locale==='ja'?'稼働中の処理の終了待ち':'等待執行中的處理結束');assert.match(status.textContent,locale==='ja'?/統合の開始は待機中です/:/整合開始目前正在等待/);assert.match(status.textContent,/別作業：AI稼働中/);
 await f.click('apply');assert.equal(f.calls.filter(x=>x.route==='/api/task/integrate').length,0);
 const timer=[...f.timers.values()][0];assert.equal(timer.ms,15000);timer.fn();await new Promise(setImmediate);assert.equal(button.disabled,true);
 f.preview=initialPreview();f.ctx.waiting=[];const next=[...f.timers.values()].at(-1);next.fn();await new Promise(setImmediate);
 assert.equal(button.disabled,false);assert.equal(button.textContent,locale==='ja'?'統合を始める':'開始整合');assert.equal(f.run('integratePreview.token'),'fresh-token');assert.equal(f.calls.filter(x=>x.route==='/api/task/integrate').length,0);
 await f.click('apply');const sends=f.calls.filter(x=>x.route==='/api/task/integrate');assert.equal(sends.length,1);assert.equal(sends[0].body.token,'fresh-token');assert.equal(sends[0].body.selected[0].disposition,'continue');
});
for(const locale of ['ja','zh-TW'])test('待機ボタンなし：確認中/継続/失敗/終了を表示し、自動再開も再送もしない '+locale,async()=>{
 const f=resumeUiFixture(locale),waiting=[{kind:'chat',message:'AI busy'}];f.preview.waiting=waiting;f.preview.resumeAllowed=true;f.ctx.waiting=waiting;await f.show();
 const status=f.el('#integrate-status');assert.equal(status.dataset.waitPhase,'waiting');assert.doesNotMatch(status.textContent,/data-integrate-action="wait"/);assert.equal(f.locked(),true);
 const backend=f.ctx.backend;let release;f.ctx.api=async(route,body)=>{if(route.split('?')[0].endsWith('/wait'))await new Promise(r=>release=r);return backend(route,body);};
 const check=f.run('integrationCheckWait()');assert.equal(status.dataset.waitPhase,'checking');assert.equal(f.locked(),true);release();await check;assert.equal(status.dataset.waitPhase,'waiting');
 f.ctx.api=async()=>{throw Error('connection lost');};await f.run('integrationCheckWait()');assert.equal(status.dataset.waitPhase,'failed');assert.equal(f.locked(),true);assert.equal([...f.timers.values()].at(-1).ms,15000);
 f.ctx.api=backend;f.ctx.waiting=[];f.preview.waiting=[];f.preview.token='fresh';await f.run('integrationCheckWait()');assert.equal(status.dataset.waitPhase,'finished');assert.equal(f.locked(),false);assert.match(status.textContent,locale==='ja'?/待機は終了/:/等待已結束/);assert.equal(f.posts().length,0);
 assert.ok(f.calls.every(x=>x.route.endsWith('/preview')||x.route.split('?')[0].endsWith('/wait')));
});
test('自動確認：busy/バックグラウンドは送らず、復帰時だけ確認、閉鎖中と古い応答は無効',async()=>{
 const f=resumeUiFixture(),waiting=[{message:'AI busy'}];f.preview.waiting=waiting;f.preview.resumeAllowed=true;f.ctx.waiting=waiting;await f.show();const calls=f.calls.length;
 f.run('integrateBusy=true');await f.run('integrationCheckWait()');assert.equal(f.calls.length,calls);assert.equal(f.el('#integrate-status').dataset.waitPhase,'busy');f.run('integrateBusy=false');
 f.ctx.document.hidden=true;await f.run('integrationCheckWait()');assert.equal(f.calls.length,calls);assert.equal(f.el('#integrate-status').dataset.waitPhase,'hidden');
 f.ctx.document.hidden=false;await f.run('integrationCheckWait()');assert.equal(f.calls.filter(x=>x.route.split('?')[0].endsWith('/wait')).length,1);
 const backend=f.ctx.backend;let release;f.ctx.api=async(route,body)=>{if(route.split('?')[0].endsWith('/wait'))await new Promise(r=>release=r);return backend(route,body);};const check=f.run('integrationCheckWait()');
 await f.click('close');assert.equal(f.el('#integrate-sheet').hidden,true);assert.equal(f.timers.size,0);assert.equal(f.run('integrateBusy'),false);
 f.ctx.api=backend;f.preview.waiting=[];await f.show('q','other');const token=f.run('integratePreview.token');release();await check;assert.equal(f.run('integratePreview.project'),'q');assert.equal(f.run('integratePreview.token'),token);assert.equal(f.run('integrateBusy'),false);assert.equal(f.posts().length,0);
});
test('画面復帰は即時の読取確認だけ、閉じた画面/再読込で余分な確認や再開を送らない',async()=>{
 const f=resumeUiFixture(),waiting=[{message:'AI busy'}];f.preview.waiting=waiting;f.ctx.waiting=waiting;await f.show();
 f.ctx.document.hidden=true;f.handlers.visibilitychange();await new Promise(setImmediate);assert.equal(f.calls.filter(x=>x.route.split('?')[0].endsWith('/wait')).length,0);
 f.ctx.document.hidden=false;f.handlers.visibilitychange();await new Promise(setImmediate);assert.equal(f.calls.filter(x=>x.route.split('?')[0].endsWith('/wait')).length,1);assert.equal(f.posts().length,0);
 await f.click('close');f.handlers.visibilitychange();await new Promise(setImmediate);assert.equal(f.calls.filter(x=>x.route.split('?')[0].endsWith('/wait')).length,1);assert.equal(f.timers.size,0);
 const reloaded=resumeUiFixture();reloaded.preview=f.preview;await reloaded.show();assert.equal(reloaded.locked(),true);assert.equal(reloaded.timers.size,1);assert.equal([...reloaded.timers.values()][0].ms,15000);assert.equal(reloaded.posts().length,0);
});
test('待機解消後の最新範囲が拒否/結果不明なら再開を有効にせず、閉じて再読込も無再送',async()=>{
 for(const mode of ['blocked','preview-failure','unknown']){
  const f=resumeUiFixture(),waiting=[{message:'AI busy'}];f.preview.waiting=waiting;f.preview.resumeAllowed=true;await f.show();
  f.preview.waiting=[];f.ctx.waiting=[];
  if(mode==='blocked'){f.preview.resumeAllowed=false;f.preview.resumeMessage='cannot resume';}
  if(mode==='unknown')f.run('integrationRememberUncertain(integratePreview)');
  if(mode==='preview-failure'){const backend=f.ctx.backend;f.ctx.api=(route,body)=>route.endsWith('/preview')?Promise.reject(Error('preview failed')):backend(route,body);}
  await f.run('integrationCheckWait()');assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,0);
  await f.click('close');f.ctx.api=f.ctx.backend;if(mode==='preview-failure')f.preview.resumeAllowed=false;await f.show();await f.click('resume');assert.equal(f.posts().length,0);
 }
});
test('開始のbusy拒否は再読込だけで解除し、未送信の確認範囲を保持して自動再送しない',async()=>{
 const f=resumeUiFixture();f.preview=initialPreview();await f.show();f.run('integratePreview.items[0].review.scope="人が選んだ範囲";integratePreview.items[0].review.confirmed=true');
 const waiting=[{kind:'queue',message:'別作業の順番待ち'}];f.ctx.failure=Object.assign(Error('busy'),{status:409,code:'INTEGRATION_BUSY',stage:'waiting',waiting});await f.click('apply');
 assert.equal(f.el('#integrate-sheet [data-integrate-action="apply"]').disabled,true);assert.equal(f.run('integratePreview.token'),undefined);assert.equal(f.run('Boolean(integratePreview.requiresRefresh)'),false);
 f.ctx.failure=null;f.preview=initialPreview();f.preview.token='new-token';await f.run('integrationCheckWait()');
 assert.equal(f.run('integratePreview.items[0].review.scope'),'人が選んだ範囲');assert.equal(f.run('integratePreview.items[0].review.confirmed'),false);assert.equal(f.calls.filter(x=>x.route==='/api/task/integrate').length,1);
 await f.click('apply');assert.equal(f.calls.filter(x=>x.route==='/api/task/integrate').length,2);assert.equal(f.calls.at(-1).body.token,'new-token');
});

function simplePreview(){
 return {simple:true,id:'simple-integration',resume:true,target:'copy',blockers:[],auto:{thenMain:true},items:['待ち','検証中','保持受領済み','片付け済み'].map((state,n)=>({project:'p',task:'child'+n,title:'子'+n,state,keep:n!==3,startable:false,descendants:[]}))};
}
for(const locale of ['ja','zh-TW'])test('開始済みの待機解除は実状態を表示し、読取から開始・再開を送らない '+locale,async()=>{
 const f=resumeUiFixture(locale),waiting=[{kind:'chat',message:'別作業のAI終了待ち'}];f.preview=simplePreview();f.preview.waiting=waiting;f.ctx.waiting=waiting;await f.show();
 assert.match(f.el('#integrate-status').textContent,/開始済みの統合は待機中/);assert.match(f.el('#integrate-status').textContent,/追加操作は不要/);
 const html=f.el('#integrate-sheet').innerHTML;assert.match(html,/順番待ち/);assert.doesNotMatch(html,/進行中/);assert.match(html,/検証中|檢查中/);assert.match(html,/保持受領済み|已接收並保留/);
 f.preview.waiting=[];f.ctx.waiting=[];await f.run('integrationCheckWait()');
 assert.match(f.el('#integrate-status').textContent,/待機は終了しました。開始済み/);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,true);
 await f.click('batch');await f.click('resume');assert.ok(f.calls.every(x=>x.route.endsWith('/preview')||x.route.split('?')[0].endsWith('/wait')));
});
for(const locale of ['ja','zh-TW'])test('停止は手動再開と受領までを案内し、完了行と停止理由を保持する '+locale,async()=>{
 const f=resumeUiFixture(locale);f.preview=simplePreview();f.preview.auto.stopped={at:'stopped',reason:'送信結果が不明です。再送はしません'};f.preview.resumeAllowed=false;f.preview.resumeMessage='正式な送信結果が未確認';await f.show();
 const html=f.el('#integrate-sheet').innerHTML;assert.match(html,locale==='ja'?/自動では再開しません/:/不會自動續行/);assert.match(html,locale==='ja'?/今回は本作業への受領まで/:/此次只接收至主作業/);assert.match(html,/保持受領済み|已接收並保留/);
 assert.match(html,/再送はしません/);assert.match(html,/正式な送信結果が未確認/);assert.equal(f.locked(),true);await f.click('resume');assert.equal(f.posts().length,0);
});
test('本体結果の未確認・完了・受領までを混同せず、未開始の対象と子孫範囲を案内する',async()=>{
 const f=resumeUiFixture();f.preview=simplePreview();f.preview.auto.main={state:'intent'};await f.show();assert.match(f.el('#integrate-sheet').innerHTML,/結果が不明/);
 f.preview.auto.main={state:'done'};await f.show();assert.match(f.el('#integrate-sheet').innerHTML,/本体に取り込み済み/);
 f.preview.auto.main.skipped=true;f.preview.auto.thenMain=false;await f.show();assert.match(f.el('#integrate-sheet').innerHTML,/本体への反映は別/);assert.match(f.el('#integrate-sheet').innerHTML,/今回は本作業への受領まで/);
 delete f.preview.auto;delete f.preview.resume;await f.show();assert.match(f.el('#integrate-sheet').innerHTML,/残さない］では子孫も含めます/);assert.match(f.el('#integrate-sheet').innerHTML,/表示された統合可能な子すべて/);
});

for(const state of ['pending','not-sent','intent'])test('完了子を再掲せず本体待ちは別表示、新候補の開始/保持を妨げない '+state,async()=>{
 const f=resumeUiFixture();f.preview={...initialPreview(),simple:true,mainPending:{id:'old',main:{state},stopped:{reason:'本体取り込みの前提を確認できません'}},items:[],blockers:[],waiting:[]};await f.show();
 let html=f.el('#integrate-sheet').innerHTML;assert.match(html,/data-integration-main/);assert.match(html,/本体への反映が未確認です/);assert.match(html,/新しい成果はありません/);assert.doesNotMatch(html,/integration-row|統合を再開/);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,true);assert.equal(f.posts().length,0);
 const i=initialPreview().items[0];f.preview.items=[{...i,startable:true,keep:true,noop:false,taskHash:'fresh',descendants:[]}];await f.show();html=f.el('#integrate-sheet').innerHTML;assert.match(html,/integration-row/);assert.match(html,/今回は本作業への受領まで/);assert.equal(f.el('#integrate-sheet [data-integrate-action="batch"]').disabled,false);assert.equal(f.posts().length,0);
 if(state==='intent')assert.match(html,/本体取り込みの結果が不明/);else assert.doesNotMatch(html,/本体取り込みの結果が不明/);
 await f.click('close');await f.show();assert.equal(f.posts().length,0);
});
