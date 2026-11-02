'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-abandon-http-')),root=path.join(tmp,'root'),home=path.join(tmp,'home'),bin=path.join(tmp,'bin'),trace=path.join(tmp,'trace.jsonl'),control=path.join(tmp,'organize.json');
for(const d of [home,bin,path.join(root,'_hub')])fs.mkdirSync(d,{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
for(const ai of ['codex','claude'])fs.writeFileSync(path.join(bin,ai),'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),{randomUUID}=require('node:crypto');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{
 const current=s.slice(s.lastIndexOf('# 今回の依頼')),m=current.match(/\\[integration-auto:([a-f0-9]{64}):(organize|review|order)\\]/),session=randomUUID();fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({key:m?.[1],phase:m?.[2],session,args:process.argv})+'\\n');
 if(m?.[2]==='organize'){
 const c=fs.existsSync(${JSON.stringify(control)})&&JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));if(!c||c.oldKey===m[1]){setInterval(()=>{},1000);return;}
 fs.appendFileSync(c.taskFile,'\\n## 成果\\n- 本体保存済み：body:.@'+c.saved+'\\n## 残件申告\\n'+String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'あとで決めます',evidence:c.evidence})+'\\n'+String.fromCharCode(96).repeat(3)+'\\n');
 const g=(...a)=>require('node:child_process').execFileSync('git',['-C',c.dir,...a],{stdio:'pipe'});g('add','.');g('commit','-qm','new organizer fixture');
 }
 if(m?.[2]==='order'){const c=fs.existsSync(${JSON.stringify(control)})&&JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));if(c?.orderDir){const g=(...a)=>require('node:child_process').execFileSync('git',['-C',c.orderDir,...a],{stdio:'pipe'});g('add','.');g('commit','-qm','order saved fixture');}}
 const order=fs.existsSync(${JSON.stringify(control)})&&JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
 const file=s.match(/保存差分原物：(.+?)（SHA256 /)?.[1],e=file&&fs.readFileSync(file,'utf8'),text=m?.[2]==='review'&&e?.includes('## saved-results')&&e.includes('saved behavior')?'[integration-review:'+m[1]+':pass]':m?.[2]==='order'&&order?.orderKeys?'[integration-order:'+m[1]+':'+JSON.stringify(order.orderKeys)+']':'fixture ordinary';
 if(${JSON.stringify(ai)}==='codex'){console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed'}));}else{console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));console.log(JSON.stringify({type:'result',is_error:false,result:'',session_id:session}));}
});`,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_AI_HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:'0',PATH:bin+':/usr/bin:/bin'});
if(process.env.HUB_ABANDON_BASELINE){const Module=require('node:module');for(const name of ['task-continuation','integration-simple','task-integrate','integrate-auto']){const file=require.resolve('../lib/'+name),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(path.join(process.env.HUB_ABANDON_BASELINE,name+'.js'),'utf8'),file);require.cache[file]=m;}}
const {IntegrateAuto}=require('../lib/integrate-auto'),tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{};
const chat=require('../lib/chat'),cont=require('../lib/task-continuation');let runtime=require('../server'),base,serial=0;
const g=(dir,...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim(),hash=x=>createHash('sha256').update(x).digest('hex');
const post=async(route,b)=>{const x=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:x.status,out:await x.json()};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function wait(fn,count=500){for(let n=0;n<count;n++){if(fn())return;await delay(20);}assert.fail('fixture timeout');}
const launches=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
test.before(async()=>{await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));await require('../server').restoreReady;const port=runtime.server.address().port;await new Promise(r=>runtime.server.close(r));process.env.HUB_PORT=String(port);require.cache[require.resolve('../server')]?.exports.stopControl.cleanExit();delete require.cache[require.resolve('../server')];runtime=require('../server');await new Promise(r=>runtime.server.listen(port,'127.0.0.1',r));await require('../server').restoreReady;base='http://127.0.0.1:'+port;});
test.after(async()=>{for(const k of runtime.chats.running.keys()){const [p,t]=k.split('\0');runtime.chats.stop(p,t);}await wait(()=>runtime.chats.running.size===0);runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));IntegrateAuto.prototype.tick=tick;fs.rmSync(tmp,{recursive:true,force:true});});
async function cold(){assert.equal(runtime.chats.running.size,0);runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));require.cache[require.resolve('../server')]?.exports.stopControl.cleanExit();delete require.cache[require.resolve('../server')];runtime=require('../server');await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));await require('../server').restoreReady;}
async function fixture(ready=true){
 const store=runtime.taskIntegrate.store,p=store.createProject({name:'Abandon-'+(++serial)}).project,parent=store.createTask(p.id,{title:'親',steps:['親未済']}),children=['1価値','2別件','3別件'].map(title=>store.createTask(p.id,{title,parent:parent.id,steps:['実機未確認'],workspaceMode:'direct'}));
 fs.writeFileSync(path.join(p.dir,'.ai/rules.md'),'日本語の架空成果。実機未確認を未済のまま残す\n');fs.writeFileSync(path.join(p.dir,'saved.txt'),'saved behavior\n');for(const c of children)fs.writeFileSync(path.join(p.dir,'.ai/work',c.id+'-core.log'),'saved behavior test\n# pass 1\n# fail 0\n');g(p.dir,'init','-q');g(p.dir,'config','user.name','Fixture');g(p.dir,'config','user.email','fixture@localhost');g(p.dir,'add','.');g(p.dir,'commit','-qm','saved behavior');const saved=g(p.dir,'rev-parse','HEAD');
 const common={project:p.id,task:parent.id},d=await post('/api/task/integrate/preview',{...common,simple:true});
 assert.equal(d.status,200,JSON.stringify(d.out));
 assert.equal((await post('/api/task/integrate',{...common,token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'batch',selected:children.map(c=>({project:p.id,task:c.id,keep:c===children[0]}))})).status,200);
 await tick.call(runtime.integrateAuto);let r=runtime.taskIntegrate.read(p.id,parent.id);const k=Object.keys(r.auto.attempts)[0],a=r.auto.attempts[k],child=children.find(c=>c.id===a.task);await wait(()=>launches().some(x=>x.key===k));
 assert.equal((await post('/api/chat/stop',{project:p.id,task:child.id})).out.ok,true);await wait(()=>!runtime.chats.busy(p.id,child.id));await wait(()=>runtime.taskIntegrate.read(p.id,parent.id).auto.stopped);
 assert.equal((await post('/api/ai/resume',{confirm:true})).status,200);
 // A newer ordinary conversation and handoff do not turn the old request into not-sent.
 assert.equal((await post('/api/delegate',{project:p.id,task:child.id,ai:'codex',model:'gpt-6.1-sol',text:'fixture ordinary after stop'})).status,200);await wait(()=>!runtime.chats.busy(p.id,child.id));
 if(ready){store.appendSection(p.id,child.id,'成果','- 本体保存済み：body:.@'+saved+'\n- ファイル：body:saved.txt');store.appendSection(p.id,child.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'あとで決めます',evidence:'.ai/work/'+child.id+'-core.log'})+'\n```');fs.writeFileSync(path.join(p.dir,'.ai/work',child.id+'-core.log'),'saved behavior test\n# pass 1\n# fail 0\n');g(p.dir,'add','.');g(p.dir,'commit','-qm','new declaration after stop');
 const hp=await post('/api/task/handup/preview',{project:p.id,task:child.id,partial:true});
 assert.equal(hp.status,200,JSON.stringify(hp.out));const hand=await post('/api/task/handup',{project:p.id,task:child.id,token:hp.out.token,selected:hp.out.selected,partial:true,confirm:true});
 assert.equal(hand.status,200,JSON.stringify(hand.out));
 }else{g(p.dir,'add','.');g(p.dir,'commit','-qm','save stopped fixture before new start');}r=runtime.taskIntegrate.read(p.id,parent.id);r.auto.pendingMain={id:randomUUID(),main:{state:'intent',sourceHead:saved},stopped:{reason:'old unknown'}};runtime.taskIntegrate.save(r);
 return {store,p,parent,children,child,common,k,a,saved,r:()=>runtime.taskIntegrate.read(p.id,parent.id)};
}
async function preview(f){const d=await post('/api/task/integrate/abandon',{...f.common,preview:true});
 assert.equal(d.status,200,JSON.stringify(d.out));return d.out;}
const apply=(f,d)=>post('/api/task/integrate/abandon',{...f.common,id:d.id,token:d.token,confirm:true});
function originalFiles(f){const files=[...f.children.map(c=>f.store.taskFile(f.p.id,c.id)),...f.children.flatMap(c=>Object.values(chat.files(f.p.dir,c.id))),runtime.taskIntegrate.transfer.file(f.p.id,f.child.id)];return Object.fromEntries(files.map(file=>[file,fs.existsSync(file)?hash(fs.readFileSync(file)):null]));}
test('正式HTTP 人の停止→中止→cold→当該子だけ保持受領/他2子候補/原文とpendingMain保持',async()=>{
 const f=await fixture(),prior=f.r(),d0=await post('/api/task/integrate/preview',{...f.common,simple:true});
 assert.equal(d0.out.resumeAllowed,false);
 assert.equal(d0.out.resume,true);assert.equal((await post('/api/task/integrate',{...f.common,token:d0.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]})).status,409);const originals=originalFiles(f),d=await preview(f),n=launches().length;
 if(process.env.HUB_ABANDON_VISUAL){fs.writeFileSync(process.env.HUB_ABANDON_VISUAL,JSON.stringify({base,...f.common,root,tmp}));await wait(()=>fs.existsSync(process.env.HUB_ABANDON_VISUAL+'.done'),30000);}
 assert.equal((await apply(f,d)).status,200);
 assert.equal((await apply(f,d)).status,409);const r=f.r();
 assert.equal(r.complete,true);
 assert.equal(cont.childrenComplete(r),false);
 assert.equal(r.auto.attempts[f.k].phase,'cancelled');
 assert.deepEqual(r.abandoned.original,prior);
 assert.deepEqual(r.auto.pendingMain,prior.auto.pendingMain);
 assert.deepEqual(originalFiles(f),originals);
 assert.equal(launches().length,n);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime.taskIntegrate.dir,'history',r.id+'.json'))),r);
 runtime.integrateAuto.settled({project:f.p.id,task:f.child.id,text:f.a.request.text},{text:'late',request:f.a.delivery.request,integrationAuto:{key:f.k,phase:'organize',closed:true}});
 assert.deepEqual(f.r(),r);await cold();
 assert.equal((await apply(f,d)).status,409);
 const next=await post('/api/task/integrate/preview',{...f.common,simple:true});
 assert.equal(next.status,200,JSON.stringify(next.out));
 assert.equal(next.out.resume,undefined);
 assert.deepEqual(next.out.mainPending,prior.auto.pendingMain);
 assert.equal(next.out.items.filter(i=>i.startable).length,3,JSON.stringify(next.out.items));
 assert.equal((await post('/api/task/integrate',{...f.common,token:next.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]})).status,200);
 for(let n=0;n<500&&!f.r().complete&&!f.r().auto.stopped;n++){await tick.call(runtime.integrateAuto);await delay(20);}assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));
 assert.equal(f.r().complete,true);
 assert.ok(runtime.taskIntegrate.transfer.read(f.p.id,f.child.id).received.some(x=>x.integration===f.r().id));
 assert.equal(f.r().items[0].keep,true);
 assert.deepEqual(f.r().auto.pendingMain,prior.auto.pendingMain);
 assert.equal(f.store.readTask(f.store.taskFile(f.p.id,f.child.id)).steps.some(x=>!x.done),true);
 assert.equal(launches().filter(x=>x.phase==='organize').length,1);
 assert.ok(launches().some(x=>x.phase==='review'));
 for(const c of f.children.filter(c=>c!==f.child)){assert.ok(f.store.taskFile(f.p.id,c.id));
 assert.equal(runtime.taskIntegrate.transfer.read(f.p.id,c.id)?.complete,undefined);}const reload=await post('/api/task/integrate/preview',{...f.common,simple:true});
 assert.equal(reload.out.items.filter(i=>!i.noop).length,2);
});
test('正式HTTP 中止後に整理が必要なら新keyだけ1回→保持受領',async()=>{
 const f=await fixture(false),d=await preview(f);assert.equal((await apply(f,d)).status,200);
 fs.writeFileSync(control,JSON.stringify({oldKey:f.k,taskFile:f.store.taskFile(f.p.id,f.child.id),dir:f.p.dir,saved:f.saved,evidence:'.ai/work/'+f.child.id+'-core.log'}));
 const next=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal((await post('/api/task/integrate',{...f.common,token:next.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]})).status,200);
 for(let n=0;n<500&&!f.r().complete&&!f.r().auto.stopped;n++){await tick.call(runtime.integrateAuto);await delay(20);}fs.rmSync(control,{force:true});
 assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));assert.equal(f.r().complete,true);
 const runs=launches().filter(x=>x.phase==='organize'&&[f.k,hash(f.r().id+'\0'+f.p.id+'\0'+f.child.id+'\0organize')].includes(x.key));assert.equal(runs.length,2);assert.notEqual(runs[0].key,runs[1].key);assert.equal(runs.filter(x=>x.key===f.k).length,1);assert.equal(f.r().items[0].state,'保持受領済み');
});
test('正式HTTP 保管原文の人の停止を照合・preview後の保管原文改変は拒否',async()=>{
 const f=await fixture(),history=new (require('../lib/task-history').TaskHistory)({store:f.store});
 const out=history.commit(f.p.id,f.child.id,{requestId:randomUUID(),revision:history.revision(f.p.id,f.child.id),summary:'fixture archived',row:{role:'user',text:'fixture next generation'},keepTaskFile:true});
 const manifest=history.manifest(f.p.id,f.child.id,out.archiveId),entry=manifest.entries.find(x=>x.kind==='log'),file=path.join(history.archiveRoot(f.p.id,f.child.id),out.archiveId,entry.saved);
 assert.equal(chat.read(f.p.dir,f.child.id).some(x=>x.request===f.a.delivery.request),false);await cold();const d=await preview(f),old=f.r(),original=fs.readFileSync(file);
 fs.appendFileSync(file,'\n');assert.equal((await apply(f,d)).status,409);assert.deepEqual(f.r(),old);fs.writeFileSync(file,original);
 const fresh=await preview(f);assert.equal((await apply(f,fresh)).status,200);const proof=f.r().abandoned.evidence.attempts[f.k];assert.equal(proof.kind,'cancelled-by-human');assert.equal(proof.end.file,file);assert.equal(proof.end.row.integrationAuto.closed,false);assert.deepEqual(fs.readFileSync(file),original);
});
test('正式HTTP 証明済みorderとnot-sentを併せて中止・accepted原文不変',async()=>{
 const f=await fixture();g(f.p.dir,'add','.');g(f.p.dir,'commit','-qm','save fixture before order');const orderKey=hash(f.r().id+'\0order'),text='[integration-auto:'+orderKey+':order]\nfixture order';
 const orderKeys=f.children.map(c=>f.p.id+'/'+c.id);fs.writeFileSync(control,JSON.stringify({orderDir:f.p.dir,orderKeys}));const sent=await runtime.integrateAuto.dispatch({...f.common,role:'コーディング',title:'fixture order',text,requestKey:randomUUID()});assert.equal(sent.delivery.state,'accepted');await wait(()=>!runtime.chats.busy(f.p.id,f.parent.id));
 fs.rmSync(control,{force:true});const end=chat.read(f.p.dir,f.parent.id).find(x=>x.role==='assistant'&&x.integrationAuto?.key===orderKey);assert.equal(end.integrationAuto.closed,true);assert.ok(end.integrationAuto.saved.head);
 const other=f.children.find(x=>x!==f.child);assert.equal((await post('/api/delegate',{project:f.p.id,task:other.id,ai:'codex',model:'gpt-6.1-sol',text:'fixture unrelated'})).status,200);await wait(()=>!runtime.chats.busy(f.p.id,other.id));
 const r=f.r(),notKey=hash(r.id+'\0'+f.p.id+'\0'+other.id+'\0organize');r.auto.attempts[orderKey]={phase:'verified',project:f.p.id,task:f.parent.id,request:{title:'fixture order',text},delivery:{state:'accepted',request:end.request}};r.auto.order={state:'done',keys:orderKeys};
 r.auto.attempts[notKey]={phase:'organize',project:f.p.id,task:other.id,at:new Date().toISOString(),request:{title:'fixture not sent',text:'[integration-auto:'+notKey+':organize]'},delivery:{state:'not-sent'}};runtime.taskIntegrate.save(r);
 const originals=originalFiles(f),d=await preview(f);assert.equal((await apply(f,d)).status,200);assert.equal(f.r().abandoned.evidence.attempts[orderKey].kind,'verified');assert.equal(f.r().abandoned.evidence.attempts[notKey].kind,'not-sent');assert.deepEqual(originalFiles(f),originals);
});
// Prior receipts belong to an earlier completed integration, not this stopped one.
for(const mode of ['valid','missing-history','duplicate-history','current-receipt','late-receipt','wrong-target','wrong-head','missing-archive','incomplete-archive','wrong-receipt','archive-change','history-change'])test('正式HTTP 過去受領を持つ中止 '+mode,async()=>{
 const f=await fixture(),r=f.r(),i=r.items.find(x=>x.task===f.child.id),oldId=randomUUID(),receiptId=randomUUID();
 const at=new Date(Date.parse(r.at)-1000).toISOString(),sourceHead=f.saved;
 const receipt={id:receiptId,integration:oldId,at,head:sourceHead,sourceHead,target:{project:r.project,task:r.task,dir:r.target}};
 const old={id:oldId,project:r.project,task:r.task,target:r.target,at,complete:true,items:[{project:i.project,task:i.task,state:'保持受領済み',receipt:receiptId,sourceHead}]};
 cont.archive(runtime.taskIntegrate.dir,old);
 const h=runtime.taskIntegrate.transfer.read(i.project,i.task);h.received=[receipt];runtime.taskIntegrate.transfer.save(h);
 i.previous=receiptId;i.previousHead=sourceHead;runtime.taskIntegrate.save(r);
 const archive=path.join(runtime.taskIntegrate.dir,'history',oldId+'.json'),d=await preview(f);
 if(mode==='missing-history')h.received=[];
 if(mode==='duplicate-history')h.received.push(structuredClone(receipt));
 if(mode==='current-receipt')h.received.push({...receipt,id:randomUUID(),integration:r.id});
 if(mode==='late-receipt')h.received[0].at=r.at;
 if(mode==='wrong-target')h.received[0].target.task='another';
 if(mode==='wrong-head')h.received[0].head='0'.repeat(40);
 if(mode==='missing-archive')fs.unlinkSync(archive);
 if(mode==='incomplete-archive'){old.complete=false;fs.writeFileSync(archive,JSON.stringify(old));}
 if(mode==='wrong-receipt'){old.items[0].receipt=randomUUID();fs.writeFileSync(archive,JSON.stringify(old));}
 if(mode==='archive-change')fs.appendFileSync(archive,' ');
 if(mode==='history-change')h.received[0].note='changed';
 if(mode!=='valid')runtime.taskIntegrate.transfer.save(h);
 const originals=originalFiles(f),prior=f.r(),runs=launches().length,oldBytes=fs.existsSync(archive)&&fs.readFileSync(archive);
 const out=await apply(f,d);
 assert.equal(out.status,mode==='valid'?200:409,JSON.stringify(out.out));
 assert.equal(launches().length,runs);assert.deepEqual(originalFiles(f),originals);
 if(oldBytes)assert.deepEqual(fs.readFileSync(archive),oldBytes);
 if(mode==='valid'){
  assert.deepEqual(f.r().abandoned.original,prior);assert.equal(f.r().abandoned.evidence.sources.some(x=>x.file===archive&&x.sha256===hash(oldBytes)),true);
  assert.equal(out.out.received,0);assert.equal(out.out.cleaned,0);assert.deepEqual(f.r().auto.pendingMain,prior.auto.pendingMain);
  await cold();assert.equal((await apply(f,d)).status,409);
  const next=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal(next.status,200);assert.equal(next.out.resume,undefined);assert.equal(next.out.items.find(x=>x.task===f.child.id).previous,receiptId);assert.equal(next.out.items.filter(x=>x.task!==f.child.id).every(x=>x.startable),true);
  // This direct-data fixture has no child Git copy; its prior HEAD therefore
  // still blocks a new receipt. Abandonment must not remove that protection.
  assert.equal(next.out.items.find(x=>x.task===f.child.id).startable,false);
 }else{
  assert.deepEqual(f.r(),prior);assert.equal(fs.existsSync(path.join(runtime.taskIntegrate.dir,'history',r.id+'.json')),false);
  if(!['archive-change','history-change'].includes(mode))assert.equal((await post('/api/task/integrate/abandon',{...f.common,preview:true})).status,409);
 }
});
test('正式HTTP archive公開後active保存失敗はunknown/cold再送0・原物保持',async()=>{
 const f=await fixture(),d=await preview(f),old=f.r(),file=runtime.taskIntegrate.file(f.p.id,f.parent.id),rename=fs.renameSync;let injected=false;
 fs.renameSync=(a,b)=>{if(b===file){injected=true;throw Error('fixture active save failure');}return rename(a,b);};let out;try{out=await apply(f,d);}finally{fs.renameSync=rename;}
 assert.equal(injected,true);assert.equal(out.status,500);assert.equal(out.out.delivery.state,'unknown');assert.deepEqual(f.r(),old);assert.ok(fs.existsSync(path.join(runtime.taskIntegrate.dir,'history',old.id+'.json')));await cold();assert.equal((await post('/api/task/integrate/abandon',{...f.common,preview:true})).status,409);assert.equal((await apply(f,d)).status,409);assert.deepEqual(f.r(),old);
});
for(const mode of ['unknown','intent','closed-success','closed-failure','no-chatstop','queue','limit-successor','receipt','integrated','previous','merging','main','delayed-end','record-change','handoff-change','token-action','missing-confirm','unproven-verified','unproven-not-sent','asks','running','archive-change'])test('正式HTTP 中止拒否/受領・CLI・記録変更0 '+mode,async()=>{
 const f=await fixture(),d=await preview(f),r=f.r(),file=chat.files(f.p.dir,f.child.id).log;
 if(mode==='unproven-verified')r.auto.attempts[f.k].phase='verified';if(mode==='unproven-not-sent')r.auto.attempts[f.k].delivery.state='not-sent';
 if(mode==='asks'){const rows=chat.read(f.p.dir,f.child.id);rows.find(x=>x.role==='assistant'&&x.integrationAuto?.key===f.k).asks=[{question:'unanswered'}];fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');}
 if(mode==='archive-change')fs.appendFileSync(file,JSON.stringify({role:'user',request:randomUUID(),text:f.a.request.text})+'\n');
 if(mode==='running')runtime.chats.running.set(runtime.chats.key(f.p.id,f.child.id),{o:{text:f.a.request.text},request:f.a.delivery.request});
 if(['unknown','intent'].includes(mode))r.auto.attempts[f.k].delivery.state=mode;
 if(mode.startsWith('closed-')){const rows=chat.read(f.p.dir,f.child.id),row=rows.find(x=>x.integrationAuto?.key===f.k&&x.role==='assistant');row.integrationAuto.closed=true;row.error=mode==='closed-failure'?'real failure':'';fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');}
 if(mode==='no-chatstop'){const file=path.join(root,'_hub/log.jsonl');fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\n').filter(s=>!s||JSON.parse(s).action!=='chatstop').join('\n'));}
 if(mode==='queue'||mode==='limit-successor')runtime.chats.enqueue(f.p.id,f.child.id,{ai:'codex',model:'gpt-6.1-sol',request:randomUUID(),text:f.a.request.text,...(mode==='limit-successor'?{limitSwitch:{original:f.a.request.text,sourceRequest:f.a.delivery.request}}:{})});
 if(['receipt','integrated','previous'].includes(mode))r.items[0][mode]='changed';
 if(mode==='merging')fs.writeFileSync(path.join(f.p.dir,'.git/MERGE_HEAD'),g(f.p.dir,'rev-parse','HEAD')+'\n');
 if(mode==='main')r.auto.main={state:'intent'};
 if(mode==='record-change')r.error='changed';
 if(mode==='handoff-change')fs.appendFileSync(runtime.taskIntegrate.transfer.file(f.p.id,f.child.id),' ');
 if(mode==='log-change')fs.appendFileSync(path.join(root,'_hub/log.jsonl'),JSON.stringify({at:new Date().toISOString(),action:'fixture'})+'\n');
 if(mode==='original-change')fs.appendFileSync(file,'\n');
 if(mode==='delayed-end')chat.append(f.p.dir,f.child.id,{role:'assistant',request:f.a.delivery.request,text:'delayed success',integrationAuto:{key:f.k,phase:'organize',closed:true}});
 runtime.taskIntegrate.save(r);const before=hash(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id))),originals=originalFiles(f),n=launches().length;
 let body={...f.common,id:d.id,token:d.token,confirm:true};if(mode==='token-action'){const other=runtime.taskIntegrate.token({action:'start',...f.common});body.token=other.token;}if(mode==='missing-confirm')delete body.confirm;
 assert.equal((await post('/api/task/integrate/abandon',body)).status,409);
 if(!['record-change','handoff-change','token-action','missing-confirm'].includes(mode))assert.equal((await post('/api/task/integrate/abandon',{...f.common,preview:true})).status,409);
 assert.equal(hash(fs.readFileSync(runtime.taskIntegrate.file(f.p.id,f.parent.id))),before);
 assert.deepEqual(originalFiles(f),originals);
 assert.equal(launches().length,n);
 assert.equal(fs.existsSync(path.join(runtime.taskIntegrate.dir,'history',r.id+'.json')),false);
 if(mode==='running')runtime.chats.running.delete(runtime.chats.key(f.p.id,f.child.id));runtime.chats.queues.delete(runtime.chats.key(f.p.id,f.child.id));fs.rmSync(chat.files(f.p.dir,f.child.id).queue,{force:true});fs.rmSync(path.join(f.p.dir,'.git/MERGE_HEAD'),{force:true});
});

for(const torn of [false,true])test('archive residue blocks both resume paths without replay: torn='+torn,async()=>{
 const f=await fixture(),r=f.r(),n=launches().length,history=path.join(runtime.taskIntegrate.dir,'history',r.id+'.json');fs.mkdirSync(path.dirname(history),{recursive:true});fs.writeFileSync(history,torn?'{':JSON.stringify({...r,complete:true}));
 assert.throws(()=>cont.assertNoArchive(runtime.taskIntegrate.dir,r),/中止の保存結果/);
 const h=runtime.taskIntegrate;assert.throws(()=>h.resumeRecord({...f.common,token:'old'}),/中止の保存結果/);assert.throws(()=>h.simple.resume({...f.common,token:'old'}),/中止の保存結果/);
 const shown=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal(shown.status,200);assert.equal(shown.out.resumeAllowed,false);assert.equal(shown.out.abandon.recovery.kind,torn?'archive-torn':'diverged');assert.deepEqual(f.r(),r);assert.equal(launches().length,n);
});
test('successful durable abort remains successful when notify throws',async()=>{
 const f=await fixture(),d=await preview(f),notify=runtime.integrateAuto.notify;runtime.integrateAuto.notify=()=>{throw Error('fixture notify failed');};
 try{const out=await apply(f,d);assert.equal(out.status,200);assert.equal(out.out.notificationError,true);assert.equal(out.out.complete,true);assert.equal(f.r().complete,true);assert.equal(fs.readFileSync(path.join(runtime.taskIntegrate.dir,'history',f.r().id+'.json'),'utf8'),JSON.stringify(f.r(),null,2));}finally{runtime.integrateAuto.notify=notify;}
});

for(const mode of ['unrelated-audit','unrelated-torn','unrelated-whitespace'])test('abandon pins only related evidence '+mode,async()=>{
 const f=await fixture(),d=await preview(f),n=launches().length;
 const file=mode==='unrelated-audit'?path.join(root,'_hub/log.jsonl'):chat.files(f.p.dir,f.child.id).log;
 fs.appendFileSync(file,mode==='unrelated-audit'?JSON.stringify({action:'unrelated',at:new Date().toISOString()})+'\n':mode==='unrelated-torn'?'unrelated torn row\n':'\n');
 const out=await apply(f,d);assert.equal(out.status,200,JSON.stringify(out.out));assert.equal(launches().length,n);
});
for(const mode of ['integration','request','escaped'])test('related or escaped torn evidence rejects '+mode,async()=>{
 const f=await fixture(),d=await preview(f),file=chat.files(f.p.dir,f.child.id).log,original=fs.readFileSync(file);
 try{fs.appendFileSync(file,(mode==='integration'?'integration':mode==='request'?f.a.delivery.request:'\\u0069')+' torn\n');
 assert.equal((await apply(f,d)).status,409);}finally{fs.writeFileSync(file,original);}
});
for(const mode of ['torn','saved','diverged'])test('cold abort recovery preserves originals without dispatch '+mode,async()=>{
 const f=await fixture(),d=await preview(f),original=f.r(),file=runtime.taskIntegrate.file(f.p.id,f.parent.id),history=path.join(runtime.taskIntegrate.dir,'history',original.id+'.json');
 const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===file)throw Error('injected active save failure');return rename(a,b);};
 try{assert.equal((await apply(f,d)).status,500);}finally{fs.renameSync=rename;}
 if(mode==='torn')fs.writeFileSync(history,'{"torn":');
 if(mode==='diverged'){const r=f.r();r.error='changed after abort';runtime.taskIntegrate.save(r);}
 const bytes=fs.readFileSync(history),before=f.r(),n=launches().length;await cold();
 const shown=await post('/api/task/integrate/preview',{...f.common,simple:true});assert.equal(shown.status,200,JSON.stringify(shown.out));assert.equal(shown.out.resumeAllowed,false);
 const a=shown.out.abandon;assert.equal(a.recovery.kind,mode==='torn'?'archive-torn':mode==='saved'?'archived-not-saved':'diverged');
 if(mode==='diverged'){assert.equal(a.allowed,false);assert.deepEqual(f.r(),before);assert.deepEqual(fs.readFileSync(history),bytes);return;}
 const d2=await post('/api/task/integrate/abandon',{...f.common,preview:true,recover:a.recovery.action});assert.equal(d2.status,200,JSON.stringify(d2.out));
 // Unrelated Hub activity no longer prevents recovery; every safety check reruns.
 fs.appendFileSync(path.join(root,'_hub/log.jsonl'),JSON.stringify({action:'unrelated'})+'\n');
 const out=await apply(f,d2.out);assert.equal(out.status,200,JSON.stringify(out.out));assert.equal((await apply(f,d2.out)).status,409);assert.equal(launches().length,n);
 if(mode==='saved'){assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readFileSync(history),bytes);assert.deepEqual(f.r().abandoned.original,original);}
 else {assert.deepEqual(fs.readFileSync(out.out.preserved),bytes);assert.equal(fs.existsSync(history),false);assert.deepEqual(f.r(),original);const fresh=await preview(f);assert.equal((await apply(f,fresh)).status,200);}
});
for(const mode of ['archive-change','current-change','queue-appears'])test('recovery confirmation rejects changed safety evidence '+mode,async()=>{
 const f=await fixture(),d=await preview(f),file=runtime.taskIntegrate.file(f.p.id,f.parent.id),rename=fs.renameSync;
 fs.renameSync=(a,b)=>{if(b===file)throw Error('injected active save failure');return rename(a,b);};try{assert.equal((await apply(f,d)).status,500);}finally{fs.renameSync=rename;}
 const history=path.join(runtime.taskIntegrate.dir,'history',f.r().id+'.json'),fresh=await post('/api/task/integrate/abandon',{...f.common,preview:true,recover:'finalize'});assert.equal(fresh.status,200,JSON.stringify(fresh.out));
 const bytes=fs.readFileSync(history),n=launches().length;
 try{
  if(mode==='archive-change')fs.appendFileSync(history,' ');
  if(mode==='current-change'){const r=f.r();r.error='changed';runtime.taskIntegrate.save(r);}
  if(mode==='queue-appears')runtime.chats.enqueue(f.p.id,f.child.id,{ai:'codex',model:'gpt-6.1-sol',text:f.a.request.text,request:f.a.delivery.request});
  const active=fs.readFileSync(file);assert.equal((await apply(f,fresh.out)).status,409);assert.deepEqual(fs.readFileSync(file),active);assert.equal(launches().length,n);assert.equal((await apply(f,fresh.out)).status,409);
 }finally{fs.writeFileSync(history,bytes);runtime.chats.queues.delete(runtime.chats.key(f.p.id,f.child.id));fs.rmSync(chat.files(f.p.dir,f.child.id).queue,{force:true});}
});
