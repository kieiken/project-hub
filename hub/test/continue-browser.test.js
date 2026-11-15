'use strict';
// 本番のボタン・入力・再読込を、隔離台帳とAIを起動しない選別で確認する。
process.env.HUB_LANG='ja';
const net=require('node:net'),test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
let chromium;try{({chromium}=require('playwright-core'));}catch{try{({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core')));}catch{}}
const chrome=process.env.HUB_TEST_CHROME||[path.join(os.homedir(),'.local/bin/chrome-headless-arm64'),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
if(!chromium||!chrome)test('1クリック実ブラウザ回帰（Playwright/Chromeがある環境で実行）',{skip:true},()=>{});
else{
 const {Store}=require('../lib/store'),chat=require('../lib/chat'),{TaskHistory}=require('../lib/task-history');
 const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-continue-browser-')),root=path.join(tmp,'root');fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 fs.writeFileSync(path.join(root,'_hub/onboarding.json'),JSON.stringify({version:1,status:'done',step:'first',ais:['codex']}));
 Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'freetalk'),HUB_DRY_RUN:'1',HUB_PORT:'0',HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0'});
 const store=new Store(root),p=store.createProject({name:'One click browser'}).project,history=new TaskHistory({store}),originalFinish=TaskHistory.prototype.autoFinish,originalSend=chat.ChatRunner.prototype.send;
 let selectionStarts=0;chat.ChatRunner.prototype.send=function(){selectionStarts++;throw Error('Browser fixture never starts an AI CLI');};
 let hold=false,rt,base,browser,context,page,target,posts;
 TaskHistory.prototype.autoFinish=function(...args){if(hold)return;return originalFinish.apply(this,args);};
 const get=async(route)=>await(await fetch(base+route,{headers:{'X-Hub':'1','X-Hub-Token':require('../lib/local-auth').capability(rt.localAuth.token)}})).json();
 const completed=async()=>{for(let n=0;n<400;n++){const s=await get('/api/task/continue/status?'+new URLSearchParams(target));if(s.status==='done')return s;if(s.status==='failed')throw Error(JSON.stringify(s));await new Promise(r=>setTimeout(r,25));}throw Error('browser continuation timeout '+JSON.stringify({posts,status:await get('/api/task/continue/status?'+new URLSearchParams(target)),notice:await page.locator('#history-progress').textContent()}));};
 // Use only this isolated server's ephemeral browser capability, never the live Hub.
 async function openPage(tab){await tab.addInitScript(({view,session})=>{localStorage.setItem('hub-view',JSON.stringify(view));sessionStorage.setItem('hub-local-session',JSON.stringify(session));},{view:{kind:'work',...target},session:rt.localAuth.browserSession()});await tab.goto(base);await tab.waitForSelector('[data-task-history="continue"]');}
 test.before(async()=>{const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);rt=require('../server');await new Promise(r=>rt.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+rt.server.address().port;browser=await chromium.launch({executablePath:chrome,headless:true});});
 test.beforeEach(async()=>{
  const task=store.createTask(p.id,{title:'One click',steps:['done']});store.setStep(p.id,task.id,0,true);target={project:p.id,task:task.id};chat.append(p.dir,task.id,{role:'user',text:'BROWSER-ORIGINAL'});
  context=await browser.newContext({viewport:{width:1200,height:900}});page=await context.newPage();posts=[];context.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/task/continue'))posts.push(r.postDataJSON());});await openPage(page);
 });
 test.afterEach(async()=>{hold=false;rt.chats.running.clear();for(const tab of context?.pages()||[])await tab.unrouteAll({behavior:'wait'});await context?.close();assert.equal(selectionStarts,0,'完了判断待ちの作業でAIを起動しない');});
 test.after(async()=>{await browser?.close();rt.server.closeAllConnections();await new Promise(r=>rt.server.close(r));TaskHistory.prototype.autoFinish=originalFinish;chat.ChatRunner.prototype.send=originalSend;fs.rmSync(tmp,{recursive:true,force:true});});
 test('遅い通信でもクリックした時点で整理中が見え、三つの確認は並行する',async()=>{
  const reads=[];let release;const held=new Promise(r=>release=r);
  for(const routePath of ['continue/status','history/status','body/preview'])await page.route('**/api/task/'+routePath+'?*',async route=>{reads.push(route.request().url());await held;await route.continue();});
  const start=await page.evaluate(()=>{const at=performance.now(),b=document.querySelector('[data-task-history="continue"]');b.click();return {ms:performance.now()-at,disabled:b.disabled,label:b.textContent,hint:document.querySelector('#history-progress').textContent,visible:!document.querySelector('#history-progress').hidden};});
  assert.equal(start.disabled,true);assert.equal(start.label,'整理中…');assert.match(start.hint,/会話の準備中/);assert.equal(start.visible,true);assert.ok(start.ms<100);
  try{await page.waitForTimeout(250);assert.equal(reads.length,3);assert.ok(reads.some(url=>url.includes('selection=0')));assert.equal(posts.length,0);await page.screenshot({path:path.join(os.tmpdir(),'hub-summary-immediate.png')});}
  finally{release();}
  await completed();console.log(JSON.stringify({immediateFeedbackMs:start.ms,parallelReads:reads.length}));
 });
 test('実ボタン1回で会話切替し、下書き・原文・過去の会話入口を保持',async()=>{
  const dialogs=[];page.on('dialog',d=>{dialogs.push(d.type());d.dismiss();});await page.locator('#chat-in').fill('KEEP-DRAFT');await page.locator('[data-task-history="continue"]').click();await completed();
  await page.waitForFunction(({project,task})=>globalThis.HubChatGenerations?.get(project+'\0'+task)===2,target);assert.equal(posts.length,1);assert.deepEqual(dialogs,[]);assert.equal(await page.locator('#task-history-sheet:visible').count(),0);assert.equal(await page.locator('#chat-in').inputValue(),'KEEP-DRAFT');assert.equal(history.archives(target.project,target.task).length,1);
  await page.locator('[data-task-history="archives"]').click();await page.waitForSelector('[data-history-archive]');assert.ok(await page.locator('[data-history-action="bodyarchives"]').isVisible());
 });
 test('対象AI稼働時の下部ヒントは通常幅・スマホ幅で見え、POSTは0件',async()=>{
  rt.chats.running.set(target.project+'\0'+target.task,{ai:'codex'});const message='この作業のAIが作業中です。作業が終わってから、もう一度［要約して続ける］を押してください';
  for(const width of [1200,390]){await page.setViewportSize({width,height:900});await page.locator('[data-task-history="continue"]').click();await page.waitForFunction(m=>document.querySelector('#history-progress')?.textContent===m,message);await page.waitForTimeout(1100);assert.equal(await page.locator('#history-progress').textContent(),message);const positions=await page.evaluate(()=>({hint:document.querySelector('#history-progress').getBoundingClientRect().top,toolbar:document.querySelector('.task-history-toolbar').getBoundingClientRect().top,toolbarBottom:document.querySelector('.task-history-toolbar').getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>innerWidth}));assert.equal(await page.locator('#history-progress').isVisible(),true);assert.ok(positions.hint>=positions.toolbar&&positions.hint<positions.toolbarBottom,'ヒントは現在の会話ツールバー内で見える');assert.equal(positions.overflow,false);}
  assert.equal(posts.length,0);assert.equal(history.autoJob(target.project,target.task),null);await page.screenshot({path:path.join(os.tmpdir(),'hub-oneclick-browser.png')});
 });
 test('連打・複数タブは1件に接続し、完了後の確認画面を表示しない',async()=>{
  hold=true;const other=await context.newPage();await openPage(other);await Promise.all([page.locator('[data-task-history="continue"]').evaluate(b=>{b.click();b.click();}),other.locator('[data-task-history="continue"]').evaluate(b=>b.click())]);
  for(let n=0;n<100&&!history.autoJob(target.project,target.task);n++)await page.waitForTimeout(20);assert.ok(history.autoJob(target.project,target.task));hold=false;await completed();
  for(const tab of [page,other]){await tab.waitForFunction(({project,task})=>globalThis.HubChatGenerations?.get(project+'\0'+task)===2,target);assert.equal(await tab.locator('#task-history-sheet:visible').count(),0);}
  assert.ok(posts.length<=2);assert.equal(history.archives(target.project,target.task).length,1);
 });
 test('POST応答の消失・ページ再読込はID照合で接続し、再送しない',async()=>{
  hold=true;await page.route('**/api/task/continue',async route=>{await route.fetch();await route.abort('failed');});await page.locator('[data-task-history="continue"]').click();
  for(let n=0;n<100&&!history.autoJob(target.project,target.task);n++)await page.waitForTimeout(20);assert.ok(history.autoJob(target.project,target.task));await page.reload();await page.waitForSelector('[data-task-history="continue"]');hold=false;await completed();
  await page.waitForFunction(({project,task})=>globalThis.HubChatGenerations?.get(project+'\0'+task)===2,target);assert.equal(posts.length,1);assert.equal(history.archives(target.project,target.task).length,1);assert.equal(await page.locator('#task-history-sheet:visible').count(),0);
 });
 test('旧画面で人の画像と同じ未確認ダイアログを再現し、新画面は追加操作なしで同じIDへ復帰',async()=>{
  // 実際のe7741c8で再現済みの旧入口と旧再起動検知を戻す。配布ソース・浅いcloneでもGit履歴を要求しない。
  let old=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
  const start=old.indexOf('  // 旧入口・復旧後の呼出しも'),end=old.indexOf('  cancelMainPreview();',start);assert.ok(start>=0&&end>start);old=old.slice(0,start)+old.slice(end);
  const actionStart=old.indexOf('  if(d.status&&!d.finish&&!d.mainView'),actionEnd=old.indexOf('  if(d.mainView',actionStart);assert.ok(actionStart>=0&&actionEnd>actionStart);old=old.slice(0,actionStart)+old.slice(actionEnd);
  old=old.replace("showArchives:continueDirect)","showArchives:showContinue)");
  const currentApp=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),oldApp=currentApp.replace(/^  \/\/ 200msの再起動[^\n]*\n  if\(state\.hubInstance[^\n]*\n/m,'');assert.notEqual(oldApp,currentApp);
  await page.route('**/task-history.js',r=>r.fulfill({contentType:'application/javascript',body:old}));await page.route('**/app.js',r=>r.fulfill({contentType:'application/javascript',body:oldApp}));await page.reload();await page.waitForSelector('[data-task-history="continue"]');
  await page.locator('#chat-in').fill('LEGACY-DRAFT');hold=true;
  await page.locator('[data-task-history="continue"]').click();await page.waitForSelector('#task-history-sheet:visible');assert.equal(posts.length,0,'旧画面は最初のクリックで確認画面だけ開く');
  await page.locator('[data-history-action="continue"]').click();await page.waitForFunction(()=>document.querySelector('#task-history-sheet')?.textContent.includes('会話整理の結果が未確認です'));
  assert.equal(posts.length,1);assert.ok(await page.locator('[data-history-action="continuerecover"]').isVisible());
  assert.equal(await page.evaluate(()=>{let reloads=0;const reload=reloadAfterRestart;reloadAfterRestart=()=>{reloads++;};state.restart={};observeRestart({...state,hubInstance:'changed',restart:{}});reloadAfterRestart=reload;return reloads;}),0,'旧画面は予約表示を見逃すと新起動でも更新しない');
  await page.unroute('**/task-history.js');await page.unroute('**/app.js');
  // 旧画面のデータ・ジョブを削除せず、既存の下書き保存による画面更新を再現。
  const loaded=page.waitForEvent('load');await page.evaluate(()=>{observeRestart({...state,restart:{committed:true}});observeRestart({...state,hubInstance:'new-boot',restart:{}});});await loaded;await page.waitForSelector('[data-task-history="continue"]');hold=false;await completed();
  await page.waitForFunction(({project,task})=>globalThis.HubChatGenerations?.get(project+'\0'+task)===2,target);
  assert.equal(posts.length,1);assert.equal(history.archives(target.project,target.task).length,1);assert.equal(await page.locator('#chat-in').inputValue(),'LEGACY-DRAFT');assert.equal(await page.locator('#task-history-sheet:visible').count(),0);
 });
 test('再起動表示を見逃した開きっぱなし画面も新起動を検知し下書き・保存IDを保って自動更新',async()=>{
  await page.locator('#chat-in').fill('AUTO-REFRESH-DRAFT');hold=true;await page.locator('[data-task-history="continue"]').click();
  for(let n=0;n<100&&!history.autoJob(target.project,target.task);n++)await page.waitForTimeout(20);assert.ok(history.autoJob(target.project,target.task));
  const nextState={...await get('/api/state'),hubInstance:'simulated-new-boot',restart:{}};await page.route('**/api/state',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(nextState)}));
  const loaded=page.waitForEvent('load');await page.evaluate(()=>pollState()).catch(e=>{if(!/context was destroyed/.test(e.message))throw e;});await loaded;
  await page.waitForSelector('[data-task-history="continue"]');assert.equal(await page.locator('#chat-in').inputValue(),'AUTO-REFRESH-DRAFT');hold=false;await completed();await page.waitForFunction(({project,task})=>globalThis.HubChatGenerations?.get(project+'\0'+task)===2,target);
  assert.equal(posts.length,1);assert.equal(history.archives(target.project,target.task).length,1);assert.equal(await page.locator('#task-history-sheet:visible').count(),0);
 });

 test('保存済みの整理結果を展開すると次の作業が先頭にあり、保存本文とボタン数を保つ',async()=>{
  const text='Hubの自動整理（人の確認なし・AI選別）\n承認（人の発言のみ）：\n- 過去の承認\n残件・判断待ち：\n- 人が選ぶ\n次にすること：\n- 続きの検証\n参照先：\n- INDEX.md';
  chat.append(p.dir,target.task,{role:'event',summaryAuto:true,text});await page.reload();await page.waitForSelector('.handoff details');await page.locator('.handoff summary').click();
  const shown=await page.locator('.handoff .mb').innerText();assert.ok(shown.indexOf('次にする作業')<shown.indexOf('残件・判断待ち'));assert.ok(shown.indexOf('残件・判断待ち')<shown.indexOf('承認（人の発言のみ）'));
  assert.equal(chat.read(p.dir,target.task).at(-1).text,text);assert.equal(await page.locator('.handoff button,.handoff input').count(),0);assert.equal(await page.locator('[data-task-history="continue"]').count(),1);
  await page.setViewportSize({width:390,height:900});await page.evaluate(()=>closeDrawer());await page.waitForFunction(()=>document.querySelector('#list').getBoundingClientRect().right<=0);assert.equal(await page.locator('.handoff .mb').isVisible(),true);await page.screenshot({path:path.join(os.tmpdir(),'hub-oneclick2-next.png')});
 });

 test('real SSE terminal notifications switch immediately once, and progress displays an elapsed clock',async()=>{
  hold=true;const job=history.autoStart(target.project,target.task,{requestId:require('node:crypto').randomUUID(),generation:1,trigger:'continue'}),plan=history.autoCollect(target.project,target.task);
  history.setAuto(target.project,target.task,{...plan,prompt:undefined,stage:'selecting',model:'Opus 5.5'});history.setAuto(target.project,target.task,{stageStarted:new Date(Date.now()-80000).toISOString()});
  await page.evaluate(({target,job})=>{window.summaryReloads=0;const previous=load;load=async(...args)=>{window.summaryReloads++;return previous(...args);};HubTaskHistory.drawAuto(target.project,target.task,{generation:1,auto:job});clearTimeout(autoPoll);autoPoll=null;}, {target,job:history.autoJob(target.project,target.task)});
  assert.match(await page.locator('#history-progress').textContent(),/Opus 5.5.*経過 1分/);
  await page.screenshot({path:path.join(os.tmpdir(),'hub-summary-refinement-progress.png')});
  await page.setViewportSize({width:390,height:900});await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok(await page.locator('#history-progress').isVisible());await page.screenshot({path:path.join(os.tmpdir(),'hub-summary-refinement-progress-mobile.png')});
  const at=Date.now();originalFinish.call(history,target.project,target.task,{});const event={type:'history-auto',generation:2,auto:history.autoJob(target.project,target.task)};
  rt.chats.emit(target.project,target.task,{type:'reset',generation:2});rt.chats.emit(target.project,target.task,event);rt.chats.emit(target.project,target.task,event);
  await page.waitForFunction(({project,task})=>HubChatGenerations.get(project+'\0'+task)===2,target);await page.waitForFunction(()=>window.summaryReloads===1);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.summaryReloads),1);const delay=Date.now()-at;assert.ok(delay<1200,'SSE completion delay '+delay);console.log(JSON.stringify({sseCompletionMs:delay,reloads:1}));
 });

}
