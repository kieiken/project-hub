'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-main-preflight-')),root=path.join(tmp,'root');
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(54000+Math.floor(Math.random()*1000))});
const {Store}=require('../lib/store'),git=require('../lib/git'),locale=require('./ui-locale-fixture'),runtime=require('../server'),store=new Store(root);let base,serial=0;
const g=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8',stdio:'pipe'}).trim();
const calls=[];async function api(route,body){calls.push({route,body});const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw Object.assign(Error(d.error),d,{status:r.status});return d;}
const post=async(route,b)=>{try{return {status:200,...await api(route,b)};}catch(e){return e;}};
test.before(async()=>{await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;});
test.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
function fixture(){const p=store.createProject({name:'Preflight-'+(++serial)}).project,body=path.join(tmp,'body'+serial);fs.mkdirSync(body);const pf=path.join(p.dir,'PROJECT.md');fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));fs.writeFileSync(path.join(body,'base.txt'),'base');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','base');const t=store.createTask(p.id,{title:'parent',steps:['remaining']}),w=git.prepare({base:body,workRoot:path.join(root,'Work',p.id),taskId:t.id});store.updateTask(p.id,t.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'saved.txt'),'saved');git.save(w.dir,'saved');return {p,t,body,w,b:{project:p.id,task:t.id}};}
const source=fs.readFileSync(path.join(__dirname,'../public/task-history.js'),'utf8');
function browser(b,language='ja',request=api,storage=new Map()){const elements=new Map(),handlers=new Map();const el=k=>{if(!elements.has(k))elements.set(k,{hidden:false,innerHTML:'',textContent:''});return elements.get(k);};const ctx=vm.createContext({$:el,UI:locale(language),esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),view:{kind:'work',...b},crypto:{randomUUID:()=> 'fixture'},URLSearchParams,api:request,document:{addEventListener:(k,f)=>handlers.set(k,f),body:{insertAdjacentHTML(){}},querySelectorAll:()=>[]},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},load:async()=>{},render(){},toast(){},setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true});vm.runInContext(source,ctx);return {ctx,el,storage,html:()=>el('#task-history-sheet').innerHTML,run:s=>vm.runInContext(s,ctx),click:async action=>{const button={dataset:{historyAction:action},disabled:false};await handlers.get('click')({target:{closest:s=>s==='[data-history-action]'?button:null}});return button;}};}
test('dirty refusal has safe paths and no token/delivery; saved retry uses fresh source and target',async()=>{const f=fixture(),head=g(f.body,'rev-parse','HEAD');fs.writeFileSync(path.join(f.body,'product.txt'),'PRIVATE_BODY');fs.writeFileSync(path.join(f.body,'secret-credentials.txt'),'TOKEN_AUTH_VALUE');const d=await post('/api/task/merge/preview',f.b);assert.equal(d.status,409);assert.equal(d.blocker.kind,'dirty');assert.equal(d.blocker.side,'target');assert.ok(d.blocker.paths.includes('product.txt'));assert.doesNotMatch(JSON.stringify(d),/PRIVATE_BODY|TOKEN_AUTH_VALUE|secret-credentials/);assert.equal(d.token,undefined);assert.equal(d.delivery.state,'not-sent');assert.equal(g(f.body,'rev-parse','HEAD'),head);g(f.body,'add','.');g(f.body,'commit','-qm','preserve fixture changes');const ready=await api('/api/task/merge/preview',f.b);assert.equal(ready.targetHead,g(f.body,'rev-parse','HEAD'));const result=await api('/api/task/merge',{...f.b,token:ready.token});assert.equal(result.retained,true);assert.equal(fs.readFileSync(path.join(f.body,'product.txt'),'utf8'),'PRIVATE_BODY');assert.equal(fs.readFileSync(path.join(f.body,'saved.txt'),'utf8'),'saved');assert.equal((await post('/api/task/merge',{...f.b,token:ready.token})).status,409);});
for(const side of ['source','target'])test('HTTP distinguishes dirty, merge and unreadable: '+side,async()=>{const f=fixture(),dir=side==='source'?f.w.dir:f.body;fs.writeFileSync(path.join(dir,'dirty.txt'),'keep');const dirty=await post('/api/task/merge/preview',f.b);assert.equal(dirty.blocker.side,side);assert.equal(dirty.blocker.kind,'dirty');fs.unlinkSync(path.join(dir,'dirty.txt'));const mh=path.join(g(dir,'rev-parse','--absolute-git-dir'),'MERGE_HEAD');fs.writeFileSync(mh,g(dir,'rev-parse','HEAD')+'\n');assert.equal((await post('/api/task/merge/preview',f.b)).blocker.kind,'merging');fs.unlinkSync(mh);const original=git.inspectAsync;git.inspectAsync=async(d,...args)=>{if(d===dir)throw Error('raw secret stderr');return original(d,...args);};try{const denied=await post('/api/task/merge/preview',f.b);assert.equal(denied.blocker.kind,'unreadable');assert.doesNotMatch(JSON.stringify(denied),/raw secret/);}finally{git.inspectAsync=original;}});
for(const side of ['source','target'])test('HTTP refuses unfinished Git operations at preview and after token issue: '+side,async()=>{
 for(const name of ['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']){
  const f=fixture(),dir=side==='source'?f.w.dir:f.body,ready=await api('/api/task/merge/preview',f.b),file=path.resolve(dir,g(dir,'rev-parse','--git-path',name));
  if(name.endsWith('_HEAD'))fs.writeFileSync(file,g(dir,'rev-parse','HEAD')+'\n');else{fs.mkdirSync(file);fs.writeFileSync(path.join(file,'fixture-proof'),'preserve');}
  const before=[git.inspect(f.body,{readOnly:true}),git.inspect(f.w.dir,{readOnly:true})];
  for(const [route,body] of [['/api/task/merge/preview',f.b],['/api/task/merge',{...f.b,token:ready.token}]]){
   const denied=await post(route,body);assert.equal(denied.status,409,name);assert.equal(denied.blocker?.side,side);assert.equal(denied.blocker.kind,'merging');assert.equal(denied.delivery.state,'not-sent');assert.equal(denied.token,undefined);
  }
  assert.deepEqual([git.inspect(f.body,{readOnly:true}),git.inspect(f.w.dir,{readOnly:true})],before);assert.ok(fs.existsSync(file));assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);assert.ok(fs.existsSync(f.w.dir));
 }
});
for(const language of ['ja','zh-TW'])test('persistent UI refusal, save then refresh and one formal merge: '+language,async()=>{const f=fixture(),a=browser(f.b,language);fs.writeFileSync(path.join(f.body,'shown.txt'),'keep');await a.ctx.showMainContinuation(f.b.project,f.b.task);assert.equal(a.el('#task-history-sheet').hidden,false);assert.match(a.html(),/shown.txt/);assert.match(a.html(),/data-history-action="main-refresh"/);assert.equal(a.run('historyDialog.main?.token'),undefined);await a.click('merge');assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);g(f.body,'add','.');g(f.body,'commit','-qm','saved fixture');await a.click('main-refresh');assert.ok(a.run('historyDialog.main.token'));assert.equal(a.run('historyDialog.main.targetHead'),g(f.body,'rev-parse','HEAD'));const n=calls.length;await Promise.all([a.click('merge'),a.click('merge')]);assert.equal(calls.slice(n).filter(x=>x.route==='/api/task/merge').length,1);assert.equal(fs.readFileSync(path.join(f.body,'shown.txt'),'utf8'),'keep');assert.ok(store.readTask(store.taskFile(f.p.id,f.t.id)).continuation);});
test('late preview, double refresh, close and task navigation never restore stale token',async()=>{const b={project:'fixture',task:'a'},pending=[];const a=browser(b,'ja',()=>new Promise(resolve=>pending.push(resolve)));const one=a.ctx.showMainContinuation(b.project,b.task),two=a.ctx.showMainContinuation(b.project,b.task);pending[1]({token:'new',files:1});await two;pending[0]({token:'old',files:2});await one;assert.equal(a.run('historyDialog.main.token'),'new');const closed=a.ctx.showMainContinuation(b.project,b.task);await a.click('close');pending[2]({token:'closed'});await closed;assert.equal(a.el('#task-history-sheet').hidden,true);const switched=a.ctx.showMainContinuation(b.project,b.task);a.ctx.view.task='b';pending[3]({token:'wrong-task'});await switched;assert.notEqual(a.run('historyDialog?.main?.token'),'wrong-task');});
test('failure at execution is persistent and no-send permits only fresh preview retry',async()=>{const f=fixture(),a=browser(f.b);await a.ctx.showMainContinuation(f.b.project,f.b.task);const old=a.run('historyDialog.main.token');fs.writeFileSync(path.join(f.body,'after-preview.txt'),'keep');await a.click('merge');assert.match(a.html(),/after-preview.txt/);assert.equal(a.run('historyDialog.main?.token'),undefined);assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);g(f.body,'add','.');g(f.body,'commit','-qm','saved after preview');await a.click('main-refresh');assert.notEqual(a.run('historyDialog.main.token'),old);await a.click('merge');assert.equal(fs.readFileSync(path.join(f.body,'after-preview.txt'),'utf8'),'keep');});
test('unknown delivery survives close/reopen without re-enabling send',async()=>{const f=fixture();let merges=0;const request=async(r,b)=>{if(r==='/api/task/merge'){merges++;throw Error('lost response');}return api(r,b);};const a=browser(f.b,'ja',request);await a.ctx.showMainContinuation(f.b.project,f.b.task);await a.click('merge');await a.click('close');await a.ctx.showMainContinuation(f.b.project,f.b.task);await a.click('main-refresh');await a.click('merge');assert.equal(merges,1);assert.ok(!a.run('historyDialog.main?.token'));});
test('late merge outcomes never reopen the old task after navigation',async()=>{
 for(const outcome of ['success','not-sent','unknown']){
  const f=fixture();let resolve,reject;
  const a=browser(f.b,'ja',(route,body)=>route==='/api/task/merge'?new Promise((ok,no)=>{resolve=ok;reject=no;}):api(route,body));
  await a.ctx.showMainContinuation(f.b.project,f.b.task);const sending=a.click('merge');a.ctx.view.task='other-task';a.run('invalidateMainNavigation()');
  if(outcome==='success')resolve({retained:true});else reject(Object.assign(Error('delayed fixture response'),outcome==='not-sent'?{delivery:{state:'not-sent'}}:{}));
  await sending;assert.equal(a.el('#task-history-sheet').hidden,true,outcome);assert.equal(a.run('historyDialog'),null,outcome);
 }
});
function conflictFixture(){const f=fixture();fs.writeFileSync(path.join(f.body,'base.txt'),'main');git.save(f.body,'main conflict');fs.writeFileSync(path.join(f.w.dir,'base.txt'),'copy');git.save(f.w.dir,'copy conflict');return f;}
const deliveryKey=b=>'hub-main-delivery-'+JSON.stringify([b.project,b.task]);
test('confirmed conflict abort returns typed delivery, preserves target snapshot and permits fresh preview',async()=>{
 const f=conflictFixture(),before=git.inspect(f.body),a=browser(f.b);await a.ctx.showMainContinuation(f.b.project,f.b.task);const token=a.run('historyDialog.main.token');await a.click('merge');
 assert.equal(a.run('mainDelivery(historyDialog.project,historyDialog.task)'),null);assert.match(a.html(),/中止して元の状態/);assert.deepEqual(git.inspect(f.body),before);assert.equal(git.merging(f.body),false);
 assert.equal((await api('/api/task/merge/status',{...f.b,requestId:token})).state,'aborted');
 await a.click('main-refresh');assert.ok(a.run('historyDialog.main.token'));assert.notEqual(a.run('historyDialog.main.token'),token);
 const duplicate=await post('/api/task/merge',{...f.b,token});assert.equal(duplicate.status,409);assert.equal(duplicate.delivery.state,'unknown');assert.deepEqual(git.inspect(f.body),before);
});
for(const outcome of ['aborted','applied'])test('lost '+outcome+' response reconciles exact identity across reload without resending',async()=>{
 const f=outcome==='aborted'?conflictFixture():fixture();let sends=0;
 const request=async(route,body)=>{if(route==='/api/task/merge'){sends++;await post(route,body);throw Error('response lost after result');}return api(route,body);};
 const a=browser(f.b,'ja',request);await a.ctx.showMainContinuation(f.b.project,f.b.task);await a.click('merge');assert.ok(a.storage.has(deliveryKey(f.b)));
 const reloaded=browser(f.b,'ja',request,a.storage);await reloaded.ctx.showMainContinuation(f.b.project,f.b.task);assert.equal(reloaded.storage.has(deliveryKey(f.b)),false);assert.equal(sends,1);assert.match(reloaded.html(),outcome==='applied'?/反映済み/:/元の状態に戻った/);
});
test('missing, other-task, damaged and pending delivery records remain unknown even when clean',async()=>{
 const f=fixture(),preview=await api('/api/task/merge/preview',f.b),id=preview.token,D=require('../lib/main-merge-delivery').MainMergeDelivery,ledger=new D(root,git,path.join(root,'_hub/log.jsonl'));
 assert.equal((await api('/api/task/merge/status',{...f.b,requestId:id})).state,'unknown');
 const scope={...f.b,sourceDir:f.w.dir,targetDir:f.body,source:git.inspect(f.w.dir),target:git.inspect(f.body)};ledger.start(id,scope);
 assert.equal((await api('/api/task/merge/status',{...f.b,requestId:id})).state,'unknown');
 assert.equal((await api('/api/task/merge/status',{project:f.b.project,task:'other',requestId:id})).state,'unknown');
 const blocked=await post('/api/task/merge',{...f.b,token:id});assert.equal(blocked.delivery.state,'unknown');assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);
 const intact=fs.readFileSync(ledger.file(id));fs.writeFileSync(ledger.file(id),'{broken');assert.equal((await api('/api/task/merge/status',{...f.b,requestId:id})).state,'unknown');fs.writeFileSync(ledger.file(id),intact);
});
test('abort reconciliation rejects target changes and in-progress merge',async()=>{
 const f=conflictFixture(),p=await api('/api/task/merge/preview',f.b);await post('/api/task/merge',{...f.b,token:p.token});
 const status=()=>api('/api/task/merge/status',{...f.b,requestId:p.token});assert.equal((await status()).state,'aborted');
 fs.writeFileSync(path.join(f.body,'new.txt'),'keep');assert.equal((await status()).state,'unknown');fs.unlinkSync(path.join(f.body,'new.txt'));
 const mh=path.join(g(f.body,'rev-parse','--absolute-git-dir'),'MERGE_HEAD');fs.writeFileSync(mh,g(f.body,'rev-parse','HEAD'));assert.equal((await status()).state,'unknown');fs.unlinkSync(mh);
 g(f.body,'commit','--allow-empty','-qm','later main');assert.equal((await status()).state,'unknown');
});
function legacyAbort(f){const row={at:new Date().toISOString(),action:'merge',...f.b,ok:false,conflict:true};fs.appendFileSync(path.join(root,'_hub/log.jsonl'),JSON.stringify(row)+'\n');return row;}
test('legacy uncertain needs explicit scoped abort association plus original reset proof; no global storage clear',async()=>{
 const f=conflictFixture(),p=await api('/api/task/merge/preview',f.b);await post('/api/task/merge',{...f.b,token:p.token});const row=legacyAbort(f),storage=new Map([[deliveryKey(f.b),'uncertain'],['unrelated','keep']]),a=browser(f.b,'ja',api,storage);
 await a.ctx.showMainContinuation(f.b.project,f.b.task);assert.equal(a.run('historyDialog.main.token'),'');assert.match(a.html(),/前回の中止記録を照合する/);assert.equal(storage.get(deliveryKey(f.b)),'uncertain');
 const r=a.run('historyDialog.recovery'),wrong=await api('/api/task/merge/status',{...f.b,legacy:true,abortAt:row.at,confirm:true,sourceHead:r.sourceHead,targetHead:'0'.repeat(40)});assert.equal(wrong.state,'unknown');
 a.ctx.confirm=()=>false;await a.click('main-recover');assert.equal(storage.get(deliveryKey(f.b)),'uncertain');
 a.ctx.confirm=()=>true;await a.click('main-recover');assert.ok(a.run('historyDialog.main.token'));assert.equal(storage.has(deliveryKey(f.b)),false);assert.equal(storage.get('unrelated'),'keep');assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);
});
test('legacy conflict log without reset, later unknown result or pending identity cannot unlock',async()=>{
 const f=fixture();legacyAbort(f);let a=browser(f.b);a.storage.set(deliveryKey(f.b),'uncertain');await a.ctx.showMainContinuation(f.b.project,f.b.task);assert.equal(a.run('historyDialog.main.token'),'');assert.equal(a.run('historyDialog.recovery'),undefined);
 const c=conflictFixture(),p=await api('/api/task/merge/preview',c.b);await post('/api/task/merge',{...c.b,token:p.token});legacyAbort(c);
 fs.appendFileSync(path.join(root,'_hub/log.jsonl'),JSON.stringify({at:new Date().toISOString(),action:'merge',...c.b,ok:false,conflict:false})+'\n');assert.equal((await api('/api/task/merge/status',{...c.b,legacy:true})).recovery,undefined);
 legacyAbort(c);const D=require('../lib/main-merge-delivery').MainMergeDelivery,l=new D(root,git,path.join(root,'_hub/log.jsonl')),id=require('node:crypto').randomUUID();l.start(id,{...c.b,sourceDir:c.w.dir,targetDir:c.body,source:git.inspect(c.w.dir),target:git.inspect(c.body)});
 assert.equal((await api('/api/task/merge/status',{...c.b,legacy:true})).recovery,undefined);
});
test('late reconciliation cannot clear changed marker, navigate back or replace a newer preview',async()=>{
 const f=fixture(),storage=new Map([[deliveryKey(f.b),JSON.stringify({requestId:require('node:crypto').randomUUID()})]]),pending=[];
 const a=browser(f.b,'ja',(route,body)=>route==='/api/task/merge/status'?new Promise(resolve=>pending.push(resolve)):api(route,body),storage);
 const first=a.ctx.showMainContinuation(f.b.project,f.b.task);await a.click('close');pending.shift()({state:'aborted'});await first;assert.equal(storage.has(deliveryKey(f.b)),true);assert.equal(a.el('#task-history-sheet').hidden,true);
 const second=a.ctx.showMainContinuation(f.b.project,f.b.task);const newer=JSON.stringify({requestId:require('node:crypto').randomUUID()});storage.set(deliveryKey(f.b),newer);pending.shift()({state:'applied'});await second;assert.equal(storage.get(deliveryKey(f.b)),newer);assert.equal(a.run('historyDialog.main.token'),'');
 const third=a.ctx.showMainContinuation(f.b.project,f.b.task);a.ctx.view.task='other';pending.shift()({state:'aborted'});await third;assert.equal(storage.get(deliveryKey(f.b)),newer);
});
test('48 long residual items are closed by default below persistent reason and next action',async()=>{
 const f=fixture(),a=browser(f.b),residual=Array.from({length:48},(_,i)=>'残件'+i+'長い説明'.repeat(20)).join('\n');
 a.ctx.api=async(route,body)=>route==='/api/task/merge/preview'?{...await api(route,body),residual,waiting:[{message:'AI終了後に最新の記録を確認してください'}]}:api(route,body);
 await a.ctx.showMainContinuation(f.b.project,f.b.task);const html=a.html();assert.match(html,/<details class="main-merge-residual"><summary>/);assert.doesNotMatch(html,/<details[^>]*\bopen\b/);assert.ok(html.indexOf('AI終了後')<html.indexOf('<details'));assert.ok(html.includes('残件47'));assert.match(fs.readFileSync(path.join(__dirname,'../public/app.css'),'utf8'),/\.main-merge-status\{position:sticky/);
});
test('pending server identity blocks a new browser/token and legacy direct send',async()=>{
 const f=fixture(),D=require('../lib/main-merge-delivery').MainMergeDelivery,ledger=new D(root,git,path.join(root,'_hub/log.jsonl')),id=require('node:crypto').randomUUID();
 ledger.start(id,{...f.b,sourceDir:f.w.dir,targetDir:f.body,source:git.inspect(f.w.dir),target:git.inspect(f.body)});
 assert.equal((await post('/api/task/merge/preview',f.b)).delivery.state,'unknown');assert.equal((await post('/api/task/merge',{...f.b,disposition:'continue',confirm:true,sourceHead:g(f.w.dir,'rev-parse','HEAD'),targetHead:g(f.body,'rev-parse','HEAD')})).delivery.state,'unknown');assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);
});
test('delivery intent write failure prevents Git mutation',async()=>{
 const f=fixture(),p=await api('/api/task/merge/preview',f.b),D=require('../lib/main-merge-delivery').MainMergeDelivery,original=D.prototype.start;D.prototype.start=()=>{throw Error('disk unavailable');};
 try{const r=await post('/api/task/merge',{...f.b,token:p.token});assert.equal(r.delivery.state,'not-sent');assert.equal(fs.existsSync(path.join(f.body,'saved.txt')),false);}finally{D.prototype.start=original;}
});
test('unknown legacy string values cannot use abort recovery',async()=>{
 const f=conflictFixture(),p=await api('/api/task/merge/preview',f.b);await post('/api/task/merge',{...f.b,token:p.token});legacyAbort(f);const a=browser(f.b);a.storage.set(deliveryKey(f.b),'some-other-value');
 await a.ctx.showMainContinuation(f.b.project,f.b.task);assert.equal(a.run('historyDialog.recovery'),undefined);assert.equal(a.run('historyDialog.main.token'),'');assert.equal(a.storage.get(deliveryKey(f.b)),'some-other-value');
});

for(const mode of ['detached','bisect'])test('main '+mode+' is not-sent at preview, stale token and direct merge; copy retained',async()=>{
 const f=fixture(),ready=await api('/api/task/merge/preview',f.b);
 if(mode==='detached')g(f.body,'checkout','--detach','-q');else g(f.body,'bisect','start');
 const before=git.inspect(f.body,{readOnly:true}),source=git.inspect(f.w.dir,{readOnly:true});
 for(const [route,b]of [['/api/task/merge/preview',f.b],['/api/task/merge',{...f.b,token:ready.token}]]){
  const denied=await post(route,b);assert.equal(denied.status,409);assert.equal(denied.blocker.kind,mode);assert.equal(denied.delivery.state,'not-sent');
 }
 const denied=git.merge({dir:f.w.dir,workRoot:path.join(root,'Work',f.p.id),target:f.body,title:'blocked fixture'});
 assert.equal(denied.ok,false);assert.equal(denied.delivery.state,'not-sent');assert.equal(fs.existsSync(f.w.dir),true);
 assert.deepEqual(git.inspect(f.body,{readOnly:true}),before);assert.deepEqual(git.inspect(f.w.dir,{readOnly:true}),source);
});
test('target guard refusal before Git merge is not-sent and never cleans the copy',()=>{
 const f=fixture(),before=git.inspect(f.body,{readOnly:true});
 const out=git.merge({dir:f.w.dir,workRoot:path.join(root,'Work',f.p.id),target:f.body,title:'guard fixture',targetGuard:()=>{throw Error('dirty target before merge');}});
 assert.equal(out.delivery.state,'not-sent');assert.equal(fs.existsSync(f.w.dir),true);assert.deepEqual(git.inspect(f.body,{readOnly:true}),before);
});
for(const side of ['source','target'])test('nested Git refusal is precise and no-send in HTTP preview: '+side,async()=>{
 const f=fixture(),dir=side==='source'?f.w.dir:f.body,nested=path.join(dir,'.ai/work/unreceived');fs.mkdirSync(nested,{recursive:true});g(nested,'init','-q');g(nested,'config','user.email','fixture@localhost');g(nested,'config','user.name','Fixture');fs.writeFileSync(path.join(nested,'result'),'unreceived original');g(nested,'add','.');g(nested,'commit','-qm','unreceived');
 const before=[g(f.body,'rev-parse','HEAD'),g(f.w.dir,'rev-parse','HEAD'),g(nested,'rev-parse','HEAD')],d=await post('/api/task/merge/preview',f.b);
 assert.equal(d.status,409);assert.equal(d.blocker.kind,'nested-git');assert.equal(d.blocker.side,side);assert.deepEqual(d.blocker.paths,['.ai/work/unreceived/']);assert.equal(d.delivery.state,'not-sent');assert.equal(d.token,undefined);assert.doesNotMatch(d.error,/読み取れません|多すぎ/);assert.deepEqual([g(f.body,'rev-parse','HEAD'),g(f.w.dir,'rev-parse','HEAD'),g(nested,'rev-parse','HEAD')],before);assert.equal(fs.readFileSync(path.join(nested,'result'),'utf8'),'unreceived original');
});
