'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-record-save-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(57000+Math.floor(Math.random()*1000))});
if(process.env.HUB_COLOCATED_BEFORE==='1')for(const name of ['integration-safety','integration-simple','integrate-auto']){
 const file=require.resolve('../lib/'+name),Module=require('node:module'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
 m._compile(execFileSync('git',['show','bdbccce:hub/lib/'+name+'.js'],{encoding:'utf8'}),file);require.cache[file]=m;
}
const {IntegrateAuto}=require('../lib/integrate-auto');let auto;const tick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async function(){auto=this;};
const originalPreview=IntegrateAuto.prototype.preview;IntegrateAuto.prototype.preview=function(...a){auto=this;this.dispatch=async q=>{requests.push(q);return {delivery:{state:'accepted'}};};this.pendingRequest=()=>true;return originalPreview.apply(this,a);};
const originalPreviewAsync=IntegrateAuto.prototype.previewAsync;IntegrateAuto.prototype.previewAsync=function(...a){auto=this;this.dispatch=async q=>{requests.push(q);return {delivery:{state:'accepted'}};};this.pendingRequest=()=>true;return originalPreviewAsync.apply(this,a);};
const {Store}=require('../lib/store'),chat=require('../lib/chat'),git=require('../lib/git'),writes=require('../lib/integration-writes'),safety=require('../lib/integration-safety');
const store=new Store(root),runtime=require('../server'),server=runtime.server;let base,serial=0;
const g=(d,...args)=>execFileSync('git',['-C',d,...args],{encoding:'utf8',stdio:'pipe'}).trim();
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
const request=async(route,b)=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});const out=await r.json();return {status:r.status,out};};
test.before(async()=>{await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;await new Promise(setImmediate);});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));IntegrateAuto.prototype.tick=tick;IntegrateAuto.prototype.preview=originalPreview;IntegrateAuto.prototype.previewAsync=originalPreviewAsync;fs.rmSync(tmp,{recursive:true,force:true});});
const requests=[];
function fixture(colocated=true,count=2,organize=false){
 const p=store.createProject({name:'Colocated-'+(++serial)}).project,body=colocated?p.dir:path.join(tmp,'body-'+serial);fs.mkdirSync(body,{recursive:true});
 if(!colocated){const f=path.join(p.dir,'PROJECT.md');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));}
 const parent=store.createTask(p.id,{title:'親',steps:['親の未済']}),children=[];
 for(let n=0;n<count;n++){const c=store.createTask(p.id,{title:'子'+n,parent:parent.id,steps:['完成']});store.setStep(p.id,c.id,0,true);store.appendSection(p.id,c.id,'成果','- なし：隔離したファイル成果');if(!organize)store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'fixture'})+'\n```');write(path.join(p.dir,'作業',c.id,'report.txt'),'report '+n);chat.append(p.dir,c.id,{role:'assistant',text:'子の元会話'});children.push(c);}
 chat.append(p.dir,parent.id,{role:'user',text:'最初の親会話'});write(path.join(body,'product.txt'),'product baseline');g(body,'init','-q');g(body,'config','user.name','Fixture');g(body,'config','user.email','fixture@localhost');g(body,'add','.');g(body,'commit','-qm','before integration');
 const common={project:p.id,task:parent.id},head=git.inspect(body).head;
 const preview=async()=>{const r=await request('/api/task/integrate/preview',{...common,simple:true});assert.equal(r.status,200,JSON.stringify(r.out));return r.out;};
 return {p,parent,children,body,common,head,preview,r:()=>auto.integrate.read(p.id,parent.id)};
}
function ui(f){
 const listeners={},els=new Map(),el=s=>{if(!els.has(s))els.set(s,{disabled:false,hidden:false,dataset:{},textContent:'',innerHTML:'',insertAdjacentHTML(){},remove(){},focus(){}});return els.get(s);};
 const ctx=vm.createContext({console,HubIntegrationSelection:require('../public/integration-selection'),$:el,esc:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),transferError:e=>e.message,load:async()=>{},render(){},toast(){},setTimeout(){return 1;},clearTimeout(){},document:{hidden:false,body:{insertAdjacentHTML(){}},querySelectorAll(s){return s.includes('single')?f.children.map((_,n)=>({...el('single-'+n),dataset:{integrateIndex:String(n)}})):[];},addEventListener(t,fn){listeners[t]=fn;}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'),ctx);
 ctx.backend=async(route,b)=>{const r=await request(route,{...f.common,...b});if(r.status!==200)throw Object.assign(Error(r.out.error),r.out,{status:r.status});return r.out;};vm.runInContext('api=backend',ctx);
 return {ctx,el,close:()=>listeners.click({target:{closest:()=>({dataset:{integrateAction:'close'},disabled:false})}}),run:s=>vm.runInContext(s,ctx),show:()=>vm.runInContext('showTaskIntegration('+JSON.stringify(f.p.id)+','+JSON.stringify(f.parent.id)+')',ctx)};
}
async function finish(f,{failure=false}={}){
 let seen=requests.length,paused=false;
 for(let n=0;n<30&&!f.r()?.complete;n++){
  await tick.call(auto);
  assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));
  if(failure&&!paused&&f.r().items.some(i=>i.state==='検証中')){paused=true;const saved=f.r();auto.stop(f.p.id,f.parent.id,'隔離した中断');const d=await f.preview();assert.equal(d.resumeAllowed,true);const out=await request('/api/task/integrate/resume',{...f.common,token:d.token});assert.equal(out.status,200,JSON.stringify(out.out));assert.equal(f.r().id,saved.id);}
  for(;seen<requests.length;seen++){
   const q=requests[seen],m=q.text.match(/integration-auto:([a-f0-9]{64}):(\w+)/);assert.ok(m);
   chat.append(f.p.dir,q.task,{role:'assistant',text:'保存された '+m[2]+' の返事'});
   let text;if(m[2]==='order')text='[integration-order:'+m[1]+':'+JSON.stringify(f.r().items.map(i=>i.project+'/'+i.task))+']';else if(m[2]==='review')text='[integration-review:'+m[1]+':pass]';else if(m[2]==='organize'){store.appendSection(q.project,q.task,'残件申告','```json\n'+JSON.stringify({status:'なし',items:'なし',undecided:'なし',evidence:'synthetic organizer'})+'\n```');text='架空の整理完了';}else throw Error('unexpected '+m[2]);
   auto.settled(q,{text,...(q.isolatedReview?{integrationAuto:{closed:true,isolation:{version:1,resumed:false,request:q.requestKey}}}:{})});
   assert.equal(f.r().auto.stopped,undefined,JSON.stringify(f.r().auto.stopped));
  }

 }
 if(failure)assert.equal(paused,true,'interruption really exercised');
 assert.equal(f.r().complete,true,JSON.stringify(f.r()));assert.ok(f.r().items.every(i=>['保持受領済み','片付け済み'].includes(i.state)));if(!f.code)assert.equal(git.inspect(f.body).head,f.head,'no automatic ledger commit');
}

function legacy(f){const log=chat.files(f.p.dir,f.parent.id).log;fs.appendFileSync(log,'{"role":"assistant","text":"legacy final"}\n');return log;}
function separateLedger(f){g(f.p.dir,'init','-q');g(f.p.dir,'config','user.name','Fixture');g(f.p.dir,'config','user.email','fixture@localhost');g(f.p.dir,'add','.');g(f.p.dir,'commit','-qm','ledger baseline');}
async function restore(f,u){await u.show();const d=u.run('integratePreview');assert.equal(d.recordSave.allowed,true,JSON.stringify(d.recordSave));assert.ok(d.recordSave.records.some(r=>r.headPrefix===true));u.el('#integration-record-confirm').checked=true;await u.run('saveIntegrationRecords()');assert.notEqual(u.run('integratePreview.token'),d.token);assert.equal((await request('/api/task/integrate/records/save',{...f.common,token:d.token,confirm:true})).status,409);return u.run('integratePreview');}
for(const colocated of [true,false])for(const mode of ['single','selected','batch'])for(const keep of [true,false])test('旧dirty→画面R1→正式受領→再取得：'+[colocated?'同Git':'別Git',mode,keep?'残す':'片付け'].join('/'),async()=>{
 const f=fixture(colocated,2,true);if(!colocated)separateLedger(f);legacy(f);const u=ui(f),d=await restore(f,u);f.head=git.inspect(f.body).head;
 chat.append(f.p.dir,f.parent.id,{text:'new Hub append'});chat.writeMeta(f.p.dir,f.parent.id,{sessions:{}});
 for(const c of f.children)assert.equal((await request('/api/task/integrate/keep',{...f.common,childProject:f.p.id,childTask:c.id,keep})).status,200);
 await u.show();u.run('integratePreview.items.forEach(i=>i.selected=true)');const fresh=u.run('integratePreview'),chosen=mode==='single'?[fresh.items[0]]:fresh.items;
 await u.run('startSimpleIntegration('+JSON.stringify(mode)+',0)');assert.ok(f.r(),u.el('#integrate-status').textContent);await finish(f,{failure:mode==='single'});
 for(const c of chosen){const r=auto.integrate.transfer.read(c.project,c.task);assert.equal(r.complete,true);assert.equal(r.retained===true,keep);assert.equal(Boolean(store.taskFile(c.project,c.task)),keep);assert.equal(chat.read(f.p.dir,f.parent.id).filter(x=>x.handoff===r.id).length,1);}
 const latest=await f.preview();for(const c of chosen){const i=latest.items.find(i=>i.task===c.task);if(keep){assert.equal(i.alreadyReceived,true);assert.equal(i.noop,true);}else assert.equal(i,undefined);}
 assert.equal(writes.inspect(git,f.body).status,'');if(!colocated)assert.equal(writes.inspect(git,f.p.dir).status,'');
});
test('R1の製品dirty/未知/ステージ/merge/rebase/lock/linkを拒否、HEADと成果・親子変更を再確認',async()=>{
 for(const change of ['product','unknown','staged','merge','rebase','lock','link','head','graph','result']){
 const f=fixture(),log=legacy(f),d=await f.preview(),head=g(f.body,'rev-parse','HEAD');
 if(change==='product')write(path.join(f.body,'product.txt'),'dirty');if(change==='unknown')write(path.join(f.p.dir,'.ai/unknown.md'),'unknown');if(change==='staged')g(f.body,'add',path.relative(f.body,log));
 const gd=g(f.body,'rev-parse','--absolute-git-dir');if(change==='merge')write(path.join(gd,'MERGE_HEAD'),head);if(change==='rebase')fs.mkdirSync(path.join(gd,'rebase-merge'));if(change==='lock')write(path.join(gd,'index.lock'),'fake');
 if(change==='link'){fs.unlinkSync(log);fs.symlinkSync(path.join(f.body,'product.txt'),log);}if(change==='head')g(f.body,'commit','--allow-empty','-qm','head changed');if(change==='graph')store.updateTask(f.p.id,f.children[0].id,{parent:''});if(change==='result')write(path.join(f.p.dir,'作業',f.children[0].id,'report.txt'),'additional');
 const out=await request('/api/task/integrate/records/save',{...f.common,token:d.token,confirm:true});assert.equal(out.status,409,change+JSON.stringify(out.out));assert.equal(g(f.body,'rev-parse','HEAD'),change==='head'?g(f.body,'rev-parse','HEAD'):head);assert.equal(f.r(),null);
 }
});
test('先頭不一致を明示、token後の外部追記拒否、二重押下はcommit一回',async()=>{
 const f=fixture(),log=legacy(f);fs.writeFileSync(log,'{"role":"user","text":"changed prefix"}\n');const d=await f.preview();assert.equal(d.recordSave.records[0].headPrefix,false);assert.ok(d.recordSave.warning);fs.appendFileSync(log,'{"text":"later external"}\n');assert.equal((await request('/api/task/integrate/records/save',{...f.common,token:d.token,confirm:true})).status,409);
 const fresh=await f.preview(),packet={...f.common,token:fresh.token,confirm:true},count=Number(g(f.body,'rev-list','--count','HEAD'));const out=await Promise.all([request('/api/task/integrate/records/save',packet),request('/api/task/integrate/records/save',packet)]);assert.deepEqual(out.map(x=>x.status).sort(),[200,409]);assert.equal(Number(g(f.body,'rev-list','--count','HEAD')),count+1);
});
test('途中終了印はcold再取得で理由を表示しR1以外で信頼しない',async()=>{
 const f=fixture(true,1),log=chat.files(f.p.dir,f.parent.id).log,original=fs.renameSync;let fault=true;
 fs.renameSync=(from,to)=>{if(fault&&to===path.join(root,'_hub/integration-writes.json')){fault=false;throw Error('injected after write');}return original(from,to);};try{assert.throws(()=>chat.append(f.p.dir,f.parent.id,{text:'interrupted'}),/injected/);}finally{fs.renameSync=original;}
 assert.equal(writes.pending(log),true);chat.append(f.p.dir,f.parent.id,{text:'cannot launder pending'});assert.equal(writes.pending(log),true);assert.match(writes.inspect(git,f.body).status,/chat/);const d=await f.preview();assert.ok(d.recordSave.records.some(r=>r.interrupted));
 const out=await request('/api/task/integrate/records/save',{...f.common,token:d.token,confirm:true});assert.equal(out.status,200,JSON.stringify(out.out));assert.equal(writes.pending(log),false);assert.equal((await f.preview()).items[0].startable,true);
});
test('P1 子作成/参考追加を証拠経由で保存、外部を信頼しない',async()=>{
 const f=fixture();store.createTask(f.p.id,{title:'new child',parent:f.parent.id,steps:['todo']});store.addRefs(f.p.id,[tmp]);assert.equal(writes.inspect(git,f.body).status,'');
 fs.appendFileSync(path.join(f.p.dir,'PROJECT.md'),'external\n');store.addRefs(f.p.id,[home]);assert.match(writes.inspect(git,f.body).status,/PROJECT/);
});
test('遅延したR1応答で閉じた画面を復活させない、結果不明は再送しない',async()=>{
 const f=fixture(),u=ui(f);legacy(f);await u.show();u.el('#integration-record-confirm').checked=true;let release,calls=0;u.ctx.backend=async()=>{calls++;return new Promise(r=>release=r);};u.run('api=backend');const send=u.run('saveIntegrationRecords()');await new Promise(setImmediate);u.run('integrateEpoch++;integratePreview=null');release({saved:true,commit:'a'.repeat(40)});await send;assert.equal(u.run('integratePreview'),null);assert.equal(calls,1);
});
test('R1 commit後の応答不明は永続停止、再送と統合を拒否',async()=>{
 const f=fixture(),u=ui(f);legacy(f);await u.show();u.el('#integration-record-confirm').checked=true;const token=u.run('integratePreview.token'),before=Number(g(f.body,'rev-list','--count','HEAD')),rename=fs.renameSync;let failed=false;
 fs.renameSync=(a,b)=>{if(b.includes('/record-saves/')&&!failed&&JSON.parse(fs.readFileSync(a,'utf8')).phase==='done'){failed=true;throw Error('completion ack failed');}return rename(a,b);};
 try{await u.run('saveIntegrationRecords()');}finally{fs.renameSync=rename;}
 assert.equal(failed,true);assert.equal(Number(g(f.body,'rev-list','--count','HEAD')),before+1);await u.run('saveIntegrationRecords()');assert.equal(Number(g(f.body,'rev-list','--count','HEAD')),before+1);
 const d=await f.preview();assert.equal(d.recordSave.unresolved,true);assert.ok(d.items.every(i=>!i.startable));assert.match(u.run('integrationRecordsPanel('+JSON.stringify(d)+')'),/保存結果が不明/);assert.equal((await request('/api/task/integrate/records/save',{...f.common,token,confirm:true})).status,409);assert.equal(f.r(),null);
});
test('P2の途中印を新プロセスの正式HTTPが読み、再起動で信頼しない',async()=>{
 const f=fixture(true,1),log=chat.files(f.p.dir,f.parent.id).log,rename=fs.renameSync;let failed=false;
 fs.renameSync=(a,b)=>{if(!failed&&b===path.join(root,'_hub/integration-writes.json')){failed=true;throw Error('write evidence fault');}return rename(a,b);};try{assert.throws(()=>chat.append(f.p.dir,f.parent.id,{text:'interrupted cold boot'}));}finally{fs.renameSync=rename;}
 const probe=require('node:net').createServer();await new Promise(y=>probe.listen(0,'127.0.0.1',y));const coldPort=probe.address().port;await new Promise(y=>probe.close(y));
 const source=`const r=require(${JSON.stringify(require.resolve('../server'))});(async()=>{await new Promise(y=>r.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',y));const out=await fetch('http://127.0.0.1:'+r.server.address().port+'/api/task/integrate/preview',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({...f.common,simple:true}))}});const data=await out.json();r.server.closeAllConnections();await new Promise(y=>r.server.close(y));process.stdout.write(JSON.stringify({status:out.status,data}));})();`;
 const raw=execFileSync(process.execPath,['-e',source],{env:{...process.env,HUB_PORT:String(coldPort)},encoding:'utf8'}),out=JSON.parse(raw.slice(raw.indexOf('{"status":')));assert.equal(out.status,200);assert.equal(out.data.recordSave.allowed,true);assert.ok(out.data.recordSave.records.some(x=>x.interrupted));assert.ok(out.data.items.every(i=>!i.startable));assert.equal(writes.pending(log),true);
});
for(const automatic of [false,true])test('P1 '+(automatic?'自動':'手動')+'会話切替の原文保管と置換が証拠を残す',()=>{
 const f=fixture(true,1),{TaskHistory}=require('../lib/task-history'),h=new TaskHistory({store}),id=require('node:crypto').randomUUID();
 const out=h.commit(f.p.id,f.parent.id,{requestId:id,revision:h.revision(f.p.id,f.parent.id),summary:'隔離引継ぎ',row:{role:'user',text:'new generation'},...(automatic?{keepTaskFile:true,auto:{source:'fixture'},extra:()=>({files:[{name:'source.md',text:'preserved'}]})}:{})});
 assert.equal(out.generation,2);assert.ok(h.archive(f.p.id,f.parent.id,out.archiveId).rows.length);assert.equal(writes.inspect(git,f.body).status,'');chat.append(f.p.dir,f.parent.id,{text:'after generation'});assert.equal(writes.inspect(git,f.body).status,'');
});

test('R1不要の確認では成果全体を重複走査しない',async()=>{
 const f=fixture();await f.preview();const h=auto.integrate,a=h.ancestor(f.p.id,f.parent.id),details=h.details;
 h.details=()=>{throw Error('unnecessary result scan');};
 try{for(const trusted of [false,true]){if(trusted)chat.append(f.p.dir,f.parent.id,{text:'trusted append'});const d=require('../lib/integration-record-save').preview(h,a);assert.equal(d.records.length,0);assert.equal(d.allowed,false);assert.doesNotMatch(d.reason,/読み取れません/);}}finally{h.details=details;}
});
