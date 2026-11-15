'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-review-queue-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin'),trace=path.join(tmp,'reviews.jsonl');
for(const d of [home,bin,path.join(root,'_hub')])fs.mkdirSync(d,{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));fs.writeFileSync(path.join(root,'_hub/roles.yaml'),fs.readFileSync(path.join(root,'_hub/roles.yaml'),'utf8').replace('auto: false','auto: true'));
// This executable is a local fixture. It checks supplied material and emits a
// fresh session; it cannot contact an AI provider or certify a real product.
for(const ai of ['codex','claude'])fs.writeFileSync(path.join(bin,ai),'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),{randomUUID}=require('node:crypto');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{
 const k=s.match(/\\[integration-auto:([a-f0-9]{64}):review\\]/)?.[1],file=s.match(/保存差分原物：(.+?)（SHA256 /)?.[1],e=file&&fs.readFileSync(file,'utf8'),session=randomUUID();
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({key:k,file,session,args:process.argv,hasResults:e?.includes('## saved-results'),hasTest:e?.includes('# pass 1'),hasCommit:e?.includes('saved behavior'),hasOriginal:e?.includes('## original')})+'\\n');
 const text=k&&e?.includes('## saved-results')&&e.includes('# pass 1')&&e.includes('saved behavior')?'[integration-review:'+k+':pass]':'判定：要修正（確認資料不足）。\\n指定Git範囲も同一HEAD間で差分ゼロ';
 const gate=s.match(/fixture-hold=([\\w-]+)/)?.[1],gateFile=gate&&${JSON.stringify(tmp)}+'/release-'+gate;
 const finish=()=>{
 if(${JSON.stringify(ai)}==='claude'&&k&&fs.existsSync(${JSON.stringify(tmp)}+'/limit-'+k)){fs.unlinkSync(${JSON.stringify(tmp)}+'/limit-'+k);console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));console.log(JSON.stringify({type:'result',is_error:true,result:"You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai.",session_id:session}));process.exitCode=1;return;}
 if(${JSON.stringify(ai)}==='codex'){console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed'}));}
 else{console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));console.log(JSON.stringify({type:'result',is_error:false,result:'',session_id:session}));}
 };if(gateFile){const timer=setInterval(()=>{if(fs.existsSync(gateFile)){clearInterval(timer);finish();}},10);}else finish();
});`,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:'0',PATH:bin+':/usr/bin:/bin'});
// Baseline mode compiles the exact old ChatRunner/server with this final input.
const Module=require('node:module');
function loadBaseline(name,filename){if(!process.env.HUB_QUEUE_BASELINE)return require(filename);const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(fs.readFileSync(path.join(process.env.HUB_QUEUE_BASELINE,name+'.js'),'utf8'),filename);require.cache[filename]=m;return m.exports;}
loadBaseline('chat',require.resolve('../lib/chat'));
loadBaseline('integration-simple',require.resolve('../lib/integration-simple'));
const loadRuntime=()=>loadBaseline('server',require.resolve('../server'));
const {IntegrateAuto}=require('../lib/integrate-auto'),tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{};
const chat=require('../lib/chat'),review=require('../lib/integration-review');let runtime=loadRuntime(),base,serial=0;
const g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();
const post=async(route,b)=>{const x=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:x.status,out:await x.json()};};
test.before(async()=>{await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const port=runtime.server.address().port;runtime.stopControl.cleanExit();await new Promise(r=>runtime.server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];runtime=loadRuntime();await new Promise(r=>runtime.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;});
test.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));IntegrateAuto.prototype.tick=tick;fs.rmSync(tmp,{recursive:true,force:true});});
async function fixture(separate=false){
 const store=runtime.taskIntegrate.store,p=store.createProject({name:'Saved-review-'+(++serial)}).project,parent=store.createTask(p.id,{title:'親',steps:['親の未済']}),children=[1,2].map(n=>store.createTask(p.id,{title:'子'+n,parent:parent.id,steps:['実機未確認'+n],workspaceMode:'direct'}));
 let dir=p.dir;if(separate){dir=path.join(tmp,'body-'+serial);fs.mkdirSync(dir);const f=path.join(p.dir,'PROJECT.md');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(dir)+'\n'));}
 g(dir,'init','-q');g(dir,'config','user.name','Fixture');g(dir,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(dir,'saved.txt'),'saved behavior\n');g(dir,'add','.');g(dir,'commit','-qm','saved behavior');const saved=g(dir,'rev-parse','HEAD');
 for(const c of children){store.appendSection(p.id,c.id,'成果','- 本体保存済み：body:.@'+saved+'\n- ファイル：body:saved.txt');store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認'+c.title,undecided:'なし',evidence:'.ai/work/'+c.id+'-core.log'})+'\n```');fs.writeFileSync(path.join(p.dir,'.ai/work/'+c.id+'-core.log'),'test saved behavior\n# pass 1\n# fail 0\n');}
 if(!separate){g(dir,'add','.');g(dir,'commit','-qm','declarations and test originals');}
 const common={project:p.id,task:parent.id},d=await post('/api/task/integrate/preview',{...common,simple:true});assert.equal(d.status,200,JSON.stringify(d.out));const start=await post('/api/task/integrate',{...common,token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'batch',selected:children.map(c=>({project:p.id,task:c.id,keep:false}))});assert.equal(start.status,200,JSON.stringify(start.out));
 let r=runtime.taskIntegrate.read(p.id,parent.id);r.auto.order={state:'done',fixturePreviouslyDone:true};runtime.taskIntegrate.save(r);assert.equal(await runtime.taskIntegrate.simple.prepare(runtime.integrateAuto,r),true);runtime.taskIntegrate.run(r);r=runtime.taskIntegrate.read(p.id,parent.id);assert.equal(r.items[0].state,'検証待ち');
 return {p,parent,children,dir,common,r:()=>runtime.taskIntegrate.read(p.id,parent.id),store,head:g(dir,'rev-parse','HEAD')};
}
function legacy(f){
 const r=f.r(),i=r.items[0],k=createHash('sha256').update(r.id+'\0legacy-empty-review').digest('hex'),request=randomUUID(),file=review.prepare({dir:f.dir,pdir:f.p.dir,task:f.parent.id,key:k,targetHead:f.head,reviewHead:f.head});
 const a={project:i.project,task:i.task,phase:'review',targetHead:f.head,reviewHead:f.head,isolatedReview:true,delivery:{state:'accepted',request}},row={role:'assistant',request,text:'判定：要修正（確認資料不足）。\n指定Git範囲も同一HEAD間で差分ゼロ',integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request,session:'original-closed-session'}}};chat.append(f.p.dir,f.parent.id,row);r.auto.attempts[k]=a;r.items[0].state='検証中';r.auto.stopped={reason:'独立確認の合格を確認できません',at:new Date().toISOString()};runtime.taskIntegrate.save(r);return {k,file,row,record:fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),original:fs.readFileSync(file.file)};
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){for(let n=0;n<400;n++){if(fn())return;await delay(20);}assert.fail('fixture timeout');}
const launches=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').map(x=>JSON.parse(x)):[];
const userRows=f=>chat.read(f.p.dir,f.parent.id).filter(r=>r.role==='user');
async function cold(){assert.equal(runtime.chats.running.size,0);runtime.stopControl.cleanExit();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));delete require.cache[require.resolve('../server')];runtime=loadRuntime();await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));}
async function queued(f,{supplement=false,hold}={}){
 let old;if(supplement){old=legacy(f);const d=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal(d.out.resumeAllowed,true);assert.equal((await post('/api/task/integrate/resume',{...f.common,token:d.out.token,confirm:true})).status,200);}
 // Complete first-use task/rules preparation before fixing scope. A later
 // hold injected during usage await must leave those originals unchanged.
 if(hold){const count=launches().length,d=await post('/api/chat/send',{...f.common,ai:'codex',model:'GPT-6.1-Sol',text:'fixture warm preparation'});assert.equal(d.status,200,JSON.stringify(d));await wait(()=>launches().length===count+1&&!runtime.chats.busy(f.p.id,f.parent.id));}
 const {Usage}=require('../lib/usage'),status=Usage.prototype.status;let blocker,injected=false;
 // Inject only while delegateRequest awaits usage, after its first scope check.
 Usage.prototype.status=async function(...args){const out=await status.apply(this,args);if(!injected){injected=true;if(hold){const count=launches().length,d=await post('/api/chat/send',{...f.common,ai:'codex',model:'GPT-6.1-Sol',text:'fixture-hold='+hold});assert.equal(d.status,200,JSON.stringify(d));await wait(()=>launches().length===count+1);}else blocker=runtime.chats.enqueue(f.p.id,f.parent.id,{ai:'codex',model:'GPT-6.1-Sol',text:'fixture blocker'});}return out;};
 const busy=runtime.integrateAuto.busy,pending=runtime.taskIntegrate.pending;runtime.integrateAuto.busy=b=>b?busy(b):false;runtime.taskIntegrate.pending=function(){return pending.call(this).filter(r=>r.project===f.p.id&&r.task===f.parent.id);};
 try{await tick.call(runtime.integrateAuto);}finally{runtime.taskIntegrate.pending=pending;runtime.integrateAuto.busy=busy;Usage.prototype.status=status;if(blocker)runtime.chats.unqueue(f.p.id,f.parent.id,blocker.id);}
 const q=runtime.chats.queue(f.p.id,f.parent.id);assert.equal(q.length,1,JSON.stringify({stopped:f.r().auto.stopped,delivery:Object.values(f.r().auto.attempts).map(a=>a.delivery)}));assert.equal(q[0].isolatedReview,true);const k=q[0].text.match(/\[integration-auto:([a-f0-9]{64}):review\]/)[1],a=f.r().auto.attempts[k];assert.equal(a.delivery.state,'accepted');assert.equal(q[0].integrationReviewRequest,a.delivery.request);return {q:q[0],k,a,old};
}
const start=(f,q)=>post('/api/chat/send',{...f.common,fromQueue:q.id,expectedText:q.text});
function untouched(f,prior){assert.equal(launches().length,prior.launches);assert.equal(userRows(f).length,prior.users);assert.equal(g(f.dir,'rev-parse','HEAD'),prior.head);for(const c of f.children)assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,c.id)?.complete,undefined);}
function before(f){return {launches:launches().length,users:userRows(f).length,head:g(f.dir,'rev-parse','HEAD')};}
for(const separate of [false,true])for(const mode of ['changed-test','missing-test','changed-result','wrong-request','missing-binding','missing-attempt','unknown','cold-change','old-proof','head-change'])test('D2正式HTTP 待ちキュー送信拒否 '+(separate?'別Git':'同Git')+' '+mode,async()=>{
 const f=await fixture(separate),x=await queued(f,{supplement:mode==='old-proof'}),prior=before(f),proof=fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id));
 if(['changed-test','cold-change'].includes(mode))fs.appendFileSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'),'changed');
 if(mode==='missing-test')fs.unlinkSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'));
 if(mode==='changed-result')fs.appendFileSync(path.join(f.dir,'saved.txt'),'changed');
 if(mode==='head-change'){fs.writeFileSync(path.join(f.dir,'unrelated.txt'),'unrelated');g(f.dir,'add','unrelated.txt');g(f.dir,'commit','-qm','unrelated');prior.head=g(f.dir,'rev-parse','HEAD');}
 if(mode==='old-proof')fs.appendFileSync(x.old.file.file,'tampered');
 if(['missing-attempt','unknown'].includes(mode)){const r=f.r();if(mode==='missing-attempt')delete r.auto.attempts[x.k];else r.auto.attempts[x.k].delivery.state='unknown';runtime.taskIntegrate.save(r);}
 if(mode==='wrong-request')runtime.chats.setQueue(f.p.id,f.parent.id,[{...x.q,integrationReviewRequest:'other-request'}],true);
 if(mode==='missing-binding'){x.q={...x.q,integrationReviewRequest:undefined,text:'binding removed',shown:'binding removed'};runtime.chats.setQueue(f.p.id,f.parent.id,[x.q],true);}
 if(mode==='cold-change')await cold();
 const expected=fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),d=await start(f,x.q);assert.equal(d.status,409,JSON.stringify(d));untouched(f,prior);assert.deepEqual(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),expected);assert.equal(runtime.chats.queue(f.p.id,f.parent.id).length,1);assert.equal(runtime.chats.base.has(runtime.chats.key(f.p.id,f.parent.id)),false);
 if(!['missing-attempt','unknown'].includes(mode))assert.deepEqual(expected,proof);
});
for(const separate of [false,true])for(const changed of ['material','queue'])test('D2正式HTTP 利用枠await中の変更・二重送信・遅い応答は起動前停止 '+(separate?'別Git':'同Git')+' '+changed,async()=>{
 const f=await fixture(separate),x=await queued(f),prior=before(f),original=runtime.chats.beforeQueued;let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 runtime.chats.beforeQueued=async o=>{await original(o);entered();await gate;};
 const first=start(f,x.q);await ready;assert.equal((await start(f,x.q)).status,409);if(changed==='material')fs.appendFileSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'),'changed during await');else runtime.chats.setQueue(f.p.id,f.parent.id,[{...x.q,integrationReviewRequest:'replaced-during-await'}],true);release();try{assert.equal((await first).status,409);}finally{runtime.chats.beforeQueued=original;}untouched(f,prior);
});
for(const separate of [false,true])test('D2正式HTTP coldキュー同一資料は新session1回・二重開始不可 '+(separate?'別Git':'同Git'),async()=>{
 const f=await fixture(separate),x=await queued(f,{supplement:true}),prior=before(f);await cold();const responses=await Promise.all([start(f,x.q),start(f,x.q)]);assert.equal(responses.filter(d=>d.status===200).length,1,JSON.stringify(responses));await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));await wait(()=>f.r().auto.attempts[x.k].phase==='verified');const out=launches().slice(prior.launches);assert.equal(out.length,1);assert.ok(out[0].session);assert.equal(out[0].hasResults,true);assert.equal(runtime.chats.queue(f.p.id,f.parent.id).length,0);assert.deepEqual(fs.readFileSync(x.old.file.file),x.old.original);
});
for(const changed of [false,true])test('D2正式HTTP 自動キュー開始 '+(changed?'変更拒否':'同一資料継続'),async()=>{
 const f=await fixture(true),gate=randomUUID(),x=await queued(f,{hold:gate}),prior=before(f);if(changed)fs.appendFileSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'),'changed');fs.writeFileSync(path.join(tmp,'release-'+gate),'go');
 if(changed){await wait(()=>runtime.chats.queue(f.p.id,f.parent.id)[0]?.error);untouched(f,prior);}else{await wait(()=>f.r().auto.attempts[x.k].phase==='verified');assert.equal(launches().length,prior.launches+1);}await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));
});
for(const changed of [false,true])test('D2正式HTTP 正式CLI上限→待機→交代担当 '+(changed?'await後変更拒否':'同一資料の正規継続'),async()=>{
 const f=await fixture(true),x=await queued(f),prior=before(f),original=runtime.chats.beforeQueued;let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 fs.writeFileSync(path.join(tmp,'limit-'+x.k),'once');runtime.chats.beforeQueued=async o=>{await original(o);if(o.limitSwitch){entered();await gate;}};
 assert.equal((await start(f,x.q)).status,200);await ready;const q=runtime.chats.queue(f.p.id,f.parent.id)[0];assert.ok(q.limitSwitch);assert.equal(q.integrationReviewRequest,x.a.delivery.request);assert.equal(q.ai,'codex');const afterLimit=before(f);assert.equal(afterLimit.launches,prior.launches+1);if(changed)fs.appendFileSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'),'changed after limit');release();
 try{if(changed){await wait(()=>runtime.chats.queue(f.p.id,f.parent.id)[0]?.error);untouched(f,afterLimit);}else{await wait(()=>f.r().auto.attempts[x.k].phase==='verified');assert.equal(launches().length,prior.launches+2);assert.equal(launches().at(-1).args.some(a=>a.includes('gpt-6.1-sol')),true);}await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));}finally{runtime.chats.beforeQueued=original;fs.writeFileSync(path.join(root,'_hub/limits.json'),'{}');}
});

for(const changed of [false,true])test('D2正式HTTP 両側上限待機→cold→事前交代 '+(changed?'変更拒否':'同一資料継続'),async()=>{
 const f=await fixture(true),x=await queued(f),prior=before(f),at=new Date().toISOString(),held={version:2,hold:true,source:'cli-limit',at,lastLimitAt:at,project:'fixture',task:'fixture',request:'fixture',untilSource:'unknown',validUntil:null,checkedAt:null};
 const file=path.join(root,'_hub/limits.json');fs.writeFileSync(file,JSON.stringify({'claude-fable-5-2':held,'gpt-6.1-sol':held}));await cold();assert.equal((await start(f,x.q)).status,409);untouched(f,prior);
 if(changed)fs.appendFileSync(path.join(f.p.dir,'.ai/work/'+f.children[0].id+'-core.log'),'changed while both held');fs.writeFileSync(file,JSON.stringify({'claude-fable-5-2':held}));await cold();
 try{const d=await start(f,x.q);assert.equal(d.status,changed?409:200,JSON.stringify(d));if(changed)untouched(f,prior);else{await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));await wait(()=>f.r().auto.attempts[x.k].phase==='verified');assert.equal(launches().length,prior.launches+1);assert.ok(launches().at(-1).args.some(a=>a.includes('gpt-6.1-sol')));}}finally{fs.writeFileSync(file,'{}');}
});

// D3 identifies a saved review from durable delivery + the actual queue, even
// when its optional labels vanish. These cases reuse fixtures, not old results.
function loseClassification(q,mode){
 const next={...q};
 if(mode==='false')next.isolatedReview=false;
 else if(mode==='readOnly-false')next.readOnly=false;
 else if(mode==='readOnly-missing')delete next.readOnly;
 else delete next.isolatedReview;
 if(['both-missing','all-missing','legacy-no-queue-id'].includes(mode)){
  delete next.integrationReviewRequest;next.text=next.shown='review identity removed';
 }
 if(mode==='all-missing'){delete next.request;delete next.limitSwitch;}
 return next;
}
function d3Before(f){return {...before(f),task:fs.readFileSync(f.store.taskFile(f.p.id,f.parent.id)),record:fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id))};}
function d3Untouched(f,prior){untouched(f,prior);assert.deepEqual(fs.readFileSync(f.store.taskFile(f.p.id,f.parent.id)),prior.task);assert.deepEqual(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),prior.record);}
for(const separate of [false,true])for(const mode of ['false','missing','both-missing','all-missing','readOnly-false','readOnly-missing','unknown-missing','legacy-no-queue-id'])test('D3正式HTTP cold保存キューの分類不整合拒否 '+(separate?'別Git':'同Git')+' '+mode,async()=>{
 const f=await fixture(separate),x=await queued(f);if(mode==='unknown-missing'||mode==='legacy-no-queue-id'){const r=f.r();if(mode==='unknown-missing')r.auto.attempts[x.k].delivery.state='unknown';else delete r.auto.attempts[x.k].delivery.queueId;runtime.taskIntegrate.save(r);}
 const changed=loseClassification(x.q,mode),prior=d3Before(f);runtime.chats.setQueue(f.p.id,f.parent.id,[changed],true);await cold();const d=await start(f,changed);await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(d.status,409,JSON.stringify(d));d3Untouched(f,prior);assert.equal(runtime.chats.queue(f.p.id,f.parent.id).length,1);assert.equal(runtime.chats.base.has(runtime.chats.key(f.p.id,f.parent.id)),false);
});
for(const separate of [false,true])for(const mode of ['false','all-missing'])test('D3正式HTTP await後同ID置換・遅延二重は書込み前拒否 '+(separate?'別Git':'同Git')+' '+mode,async()=>{
 const f=await fixture(separate),x=await queued(f),prior=d3Before(f),original=runtime.chats.beforeQueued;let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);runtime.chats.beforeQueued=async o=>{await original(o);entered();await gate;};
 try{const first=start(f,x.q);await ready;assert.equal((await start(f,x.q)).status,409);runtime.chats.setQueue(f.p.id,f.parent.id,[loseClassification(x.q,mode)],true);release();const d=await first;await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(d.status,409,JSON.stringify(d));d3Untouched(f,prior);}finally{release?.();runtime.chats.beforeQueued=original;}
});
for(const separate of [false,true])for(const mode of ['missing','all-missing'])test('D3正式HTTP 自動キューの分類欠落は起動前拒否 '+(separate?'別Git':'同Git')+' '+mode,async()=>{
 const f=await fixture(separate),gate=randomUUID(),x=await queued(f,{hold:gate}),prior=d3Before(f);runtime.chats.setQueue(f.p.id,f.parent.id,[loseClassification(x.q,mode)],true);fs.writeFileSync(path.join(tmp,'release-'+gate),'go');await wait(()=>runtime.chats.queue(f.p.id,f.parent.id)[0]?.error||launches().length>prior.launches);await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(launches().length,prior.launches);d3Untouched(f,prior);assert.ok(runtime.chats.queue(f.p.id,f.parent.id)[0]?.error);
});
for(const separate of [false,true])for(const changed of [false,true])test('D3正式HTTP 正式上限後の分類'+(changed?'欠落拒否':'保持・新session継続')+' '+(separate?'別Git':'同Git'),async()=>{
 const f=await fixture(separate),x=await queued(f),original=runtime.chats.beforeQueued;let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);fs.writeFileSync(path.join(tmp,'limit-'+x.k),'once');runtime.chats.beforeQueued=async o=>{await original(o);if(o.limitSwitch){entered();await gate;}};
 try{assert.equal((await start(f,x.q)).status,200);await ready;const q=runtime.chats.queue(f.p.id,f.parent.id)[0],prior=d3Before(f);assert.ok(q.limitSwitch);if(changed)runtime.chats.setQueue(f.p.id,f.parent.id,[loseClassification(q,'all-missing')],true);release();if(changed){await wait(()=>runtime.chats.queue(f.p.id,f.parent.id)[0]?.error||launches().length>prior.launches);await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));d3Untouched(f,prior);}else{await wait(()=>f.r().auto.attempts[x.k].phase==='verified');await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(launches().length,prior.launches+1);const sessions=launches().filter(v=>v.key===x.k).map(v=>v.session);assert.equal(new Set(sessions).size,2);assert.ok(launches().at(-1).args.includes('gpt-6.1-sol'));}}finally{release?.();runtime.chats.beforeQueued=original;fs.writeFileSync(path.join(root,'_hub/limits.json'),'{}');}
});
for(const separate of [false,true])test('D3正式HTTP cold事前上限交代でも隔離欠落は未開始 '+(separate?'別Git':'同Git'),async()=>{
 const f=await fixture(separate),x=await queued(f),changed=loseClassification(x.q,'both-missing'),prior=d3Before(f),at=new Date().toISOString(),held={version:2,hold:true,source:'cli-limit',at,lastLimitAt:at,project:'fixture',task:'fixture',request:'fixture',untilSource:'unknown',validUntil:null,checkedAt:null};runtime.chats.setQueue(f.p.id,f.parent.id,[changed],true);const file=path.join(root,'_hub/limits.json');fs.writeFileSync(file,JSON.stringify({'claude-fable-5-2':held}));await cold();try{const d=await start(f,changed);await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(d.status,409,JSON.stringify(d));d3Untouched(f,prior);}finally{fs.writeFileSync(file,'{}');}
});
for(const separate of [false,true])test('D3正式HTTP 同じ親の一般会話は確認依頼と混同しない '+(separate?'別Git':'同Git'),async()=>{
 const f=await fixture(separate),x=await queued(f),reviewRecord=fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),count=launches().length,generic=runtime.chats.enqueue(f.p.id,f.parent.id,{ai:'codex',model:'GPT-6.1-Sol',text:'ordinary queued conversation'}),original=runtime.chats.beforeQueued;runtime.chats.setQueue(f.p.id,f.parent.id,[generic,x.q],true);runtime.chats.beforeQueued=async o=>{if(o.request===x.q.id)throw Error('fixture keeps the unrelated review pending');return original(o);};try{const d=await start(f,generic);assert.equal(d.status,200,JSON.stringify(d));await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(launches().length,count+1);assert.equal(launches().at(-1).key,undefined);assert.deepEqual(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id)),reviewRecord);assert.equal(runtime.chats.queue(f.p.id,f.parent.id)[0].id,x.q.id);}finally{runtime.chats.beforeQueued=original;}
});
for(const separate of [false,true])test('D3正式HTTP 保存成果を持つattemptの別コード依頼を混同しない '+(separate?'別Git':'同Git'),async()=>{
 const f=await fixture(separate),x=await queued(f),request=randomUUID(),q={...x.q,request,integrationReviewRequest:undefined,isolatedReview:undefined,readOnly:undefined,text:'[integration-auto:'+x.k+':code] fixture code turn',shown:'fixture code turn'};const r=f.r();r.auto.attempts[x.k].phase='code';r.auto.attempts[x.k].request={role:'コーディング',text:q.text};r.auto.attempts[x.k].delivery={state:'accepted',request};runtime.taskIntegrate.save(r);runtime.chats.setQueue(f.p.id,f.parent.id,[q],true);const count=launches().length,d=await start(f,q);assert.equal(d.status,200,JSON.stringify(d));await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));assert.equal(launches().length,count+1);assert.equal(launches().at(-1).key,undefined);
});
