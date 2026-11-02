'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-colocated-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
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
test('旧原因回帰：会話追記の後にpreview→start→正式受領',async()=>{
 const f=fixture(true,1);chat.append(f.p.dir,f.parent.id,{text:'tracked chat append'});const d=await f.preview();assert.equal(d.items[0].startable,true);const r=await request('/api/task/integrate',{...f.common,token:d.token,auto:true,thenMain:false,confirm:true,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(r.status,200,JSON.stringify(r.out));await finish(f);
});
test('旧原因回帰：cleanから開始時の保持保存→tick→正式受領',async()=>{
 const f=fixture(true,1),d=await f.preview();assert.equal(git.inspect(f.body).status,'');const r=await request('/api/task/integrate',{...f.common,token:d.token,auto:true,thenMain:false,confirm:true,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(r.status,200,JSON.stringify(r.out));await finish(f);
});
for(const colocated of [true,false])for(const mode of ['single','selected','batch'])for(const keep of [true,false])test('画面→正式HTTP→受領→再取得：'+[colocated?'同Git':'別構成',mode,keep?'残す':'片付け'].join('/'),async()=>{
 const f=fixture(colocated,2,true),u=ui(f),before=await f.preview();
 chat.append(f.p.dir,f.parent.id,{role:'assistant',text:'確認後の会話追記'});chat.writeMeta(f.p.dir,f.parent.id,{sessions:{},models:{},fixture:true});
 store.appendSection(f.p.id,f.parent.id,'メモ','安全範囲を変えない表示メモ');
 assert.equal((await f.preview()).confirmationHash,before.confirmationHash,'Hub notes/chat do not invalidate');
 for(const c of f.children){const r=await request('/api/task/integrate/keep',{...f.common,childProject:f.p.id,childTask:c.id,keep});assert.equal(r.status,200,JSON.stringify(r.out));}
 await u.show();u.run('integratePreview.items.forEach(i=>i.selected=true);integrationApplyState()');const d=u.run('integratePreview'),chosen=mode==='single'?[d.items[0]]:d.items,selected=chosen.map(i=>({project:i.project,task:i.task,keep}));
 const packet={...f.common,token:d.token,confirm:true,auto:true,thenMain:false,mode,selected};
 await u.run('startSimpleIntegration('+JSON.stringify(mode)+',0)');assert.ok(f.r(),u.el('#integrate-status').textContent);
 const id=f.r().id;assert.equal((await request('/api/task/integrate',packet)).status,409,'double send rejected');assert.equal(f.r().id,id);
 await finish(f);
 for(const c of chosen){const r=auto.integrate.transfer.read(c.project,c.task);assert.equal(r.complete,true);assert.equal(r.retained===true,keep);assert.equal(Boolean(store.taskFile(c.project,c.task)),keep);assert.equal(chat.read(f.p.dir,f.parent.id).filter(x=>x.handoff===r.id).length,1);}
 const latest=await f.preview();assert.equal(latest.resume,undefined);for(const c of chosen){const i=latest.items.find(i=>i.task===c.task);if(keep){assert.equal(i.alreadyReceived,true);assert.equal(i.noop,true);}else assert.equal(i,undefined);}
 if(mode==='single')assert.ok(store.taskFile(f.p.id,f.children.find(c=>c.id!==chosen[0].task).id),'unselected child preserved');
 assert.equal(writes.inspect(git,f.body).status,'');assert.ok(!fs.readFileSync(path.join(root,'_hub/log.jsonl'),'utf8').includes(d.token),'confirmation token never logged');
});
test('未保存製品はpreviewで保存指示・HTTP拒否を記録、外部.ai編集も除外しない',async()=>{
 const f=fixture(),clean=await f.preview();write(path.join(f.body,'product.txt'),'external product change');const d=await f.preview();assert.ok(d.items.every(i=>!i.startable));assert.match(d.items[0].reason,/保存.*product.txt/);const r=await request('/api/task/integrate',{...f.common,token:clean.token,confirm:true,auto:true,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(r.status,409);assert.equal(r.out.stage,'save');
 const rows=fs.readFileSync(path.join(root,'_hub/log.jsonl'),'utf8').trim().split('\n').map(JSON.parse),last=rows.at(-1);assert.equal(last.action,'integrate-failed');assert.equal(last.stage,'save');assert.ok(last.paths.includes('product.txt'));
 write(path.join(f.body,'product.txt'),'product baseline');const log=path.join(f.p.dir,'.ai/chat',f.parent.id+'.jsonl');fs.appendFileSync(log,'{"external":true}\n');chat.append(f.p.dir,f.parent.id,{text:'cannot launder external edits'});assert.match(writes.inspect(git,f.body).status,/chat/);
});
test('Hub書込みの後も外部chmod・index・HEAD・成果・親子関係の変更は保護',async()=>{
 const f=fixture(),log=path.join(f.p.dir,'.ai/chat',f.parent.id+'.jsonl');chat.append(f.p.dir,f.parent.id,{text:'owned'});const index=path.join(g(f.body,'rev-parse','--absolute-git-dir'),'index'),b=fs.readFileSync(index);writes.inspect(git,f.body);assert.deepEqual(fs.readFileSync(index),b,'readonly index');
 const originalMode=fs.statSync(log).mode&0o777,externalMode=originalMode===0o600?0o644:0o600;fs.chmodSync(log,externalMode);assert.notEqual(fs.statSync(log).mode&0o777,originalMode,'fixture really changes mode');assert.match(writes.inspect(git,f.body).status,/chat/);fs.chmodSync(log,originalMode);g(f.body,'add',path.relative(f.body,log));assert.match(writes.inspect(git,f.body).status,/chat/);g(f.body,'reset','-q','HEAD','--',path.relative(f.body,log));
 const d=await f.preview();store.appendSection(f.p.id,f.children[0].id,'成果','- 追加：未受領の成果');const changed=await f.preview();assert.notEqual(changed.confirmationHash,d.confirmationHash);
 const fail=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(fail.status,409);assert.equal(f.r(),null);
});
test('確認後の内部会話保存だけなら古いtokenでも開始・受領可、途中停止は同記録で再開',async()=>{
 const f=fixture(true,1);await request('/api/task/integrate/keep',{...f.common,childProject:f.p.id,childTask:f.children[0].id,keep:true});const d=await f.preview();chat.append(f.p.dir,f.parent.id,{text:'after preview'});const out=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(out.status,200,JSON.stringify(out.out));await finish(f,{failure:true});
});

test('実際の親子関係とHEAD更新は古い確認を拒否する',async()=>{
 for(const change of ['head','graph']){const f=fixture(),d=await f.preview();if(change==='head')g(f.body,'commit','--allow-empty','-qm','external head');else store.updateTask(f.p.id,f.children[0].id,{parent:''});
 const r=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(r.status,409);assert.equal(f.r(),null);}
});
test('遅延したpreviewは最新の確認情報を巻き戻さない',async()=>{
 const f=fixture(),u=ui(f),fresh=await f.preview();let release;u.ctx.backend=async()=>await new Promise(r=>{release=r;});u.run('api=backend');
 const old=u.show();await new Promise(setImmediate);await u.close();u.ctx.backend=async()=>fresh;u.run('api=backend');await u.show();const latest=u.run('integratePreview');release({...fresh,confirmationHash:'obsolete',token:'obsolete'});await old;assert.equal(u.run('integratePreview'),latest);assert.notEqual(u.run('integratePreview.token'),'obsolete');
});

test('同Gitの会話をcommitせずコード成果を正式HTTPで統合・保持受領する',async()=>{
 const f=fixture(true,1),work=path.join(root,'Work',f.p.id,f.children[0].id);fs.mkdirSync(path.dirname(work),{recursive:true});g(f.body,'worktree','add','-qb','synthetic-child',work);write(path.join(work,'product.txt'),'approved child product');g(work,'add','product.txt');g(work,'commit','-qm','child product');const source=g(work,'rev-parse','HEAD');
 store.updateTask(f.p.id,f.children[0].id,{workdir:work});chat.append(f.p.dir,f.parent.id,{text:'Hub record must not enter commit'});f.code=true;const d=await f.preview();const start=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:f.p.id,task:f.children[0].id,keep:true}]});assert.equal(start.status,200,JSON.stringify(start.out));await finish(f);assert.ok(git.isAncestor(f.body,source));assert.equal(fs.readFileSync(path.join(f.body,'product.txt'),'utf8'),'approved child product');assert.ok(!g(f.body,'show','HEAD:.ai/chat/'+f.parent.id+'.jsonl').includes('Hub record must not enter commit'));assert.equal(auto.integrate.transfer.read(f.p.id,f.children[0].id).retained,true);
});

test('初回commit前のHub保存は機能し、既存の外部ファイルを除外根拠にしない',()=>{
 const p=store.createProject({name:'Unborn'}).project;g(p.dir,'init','-q');const t=store.createTask(p.id,{title:'初回'});assert.doesNotThrow(()=>store.updateTask(p.id,t.id,{memo:'正常保存'}));assert.match(fs.readFileSync(store.taskFile(p.id,t.id),'utf8'),/正常保存/);const file=path.join(p.dir,'.ai/chat',t.id+'.jsonl');write(file,'{"external":true}\n');chat.append(p.dir,t.id,{text:'Hub追記'});assert.ok(!writes.ignored(p.dir).includes(path.relative(p.dir,file)));
});

const failureRows=()=>fs.existsSync(path.join(root,'_hub/log.jsonl'))?fs.readFileSync(path.join(root,'_hub/log.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.action==='integrate-failed'):[];
function failureGuard(f){
 const taskFiles=[store.taskFile(f.p.id,f.parent.id),...f.children.map(c=>store.taskFile(f.p.id,c.id))],texts=taskFiles.map(x=>fs.readFileSync(x)),chatBefore=chat.read(f.p.dir,f.parent.id),sent=requests.length,index=path.join(g(f.body,'rev-parse','--absolute-git-dir'),'index'),indexBefore=fs.readFileSync(index);
 return ()=>{assert.equal(f.r(),null);for(const c of f.children)assert.equal(auto.integrate.transfer.read(f.p.id,c.id),null);taskFiles.forEach((x,n)=>assert.deepEqual(fs.readFileSync(x),texts[n]));assert.deepEqual(chat.read(f.p.dir,f.parent.id),chatBefore);assert.equal(requests.length,sent);assert.equal(g(f.body,'rev-parse','HEAD'),f.head);assert.deepEqual(fs.readFileSync(index),indexBefore);};
}
for(const [label,selected]of [['object',{}],['string','child'],['null element',[null]],['null',null],['mixed',[null,4,false,'child',{}]]])test('拒否ログ補強：正式HTTP keep拒否/'+label,async()=>{
 const f=fixture(true,1);await f.preview();const unchanged=failureGuard(f),before=failureRows().length;
 const r=await request('/api/task/integrate/keep',{...f.common,keep:'invalid',selected,token:'SYNTHETIC_TOKEN',auth:{secret:'SYNTHETIC_AUTH'}});
 assert.equal(r.status,409);assert.equal(r.out.error,'残す・残さないを選んでください');
 const rows=failureRows().slice(before);assert.equal(rows.length,1);const row=rows[0];assert.equal(row.phase,'keep');assert.equal(row.stage,'refresh');assert.equal(row.reason,r.out.error);assert.deepEqual(row.targets,[]);assert.deepEqual(row.paths,[]);assert.equal(row.project,f.p.id);assert.equal(row.task,f.parent.id);assert.ok(!JSON.stringify(row).includes('SYNTHETIC_'));unchanged();
});
test('拒否ログ補強：正式HTTPの非文字列project/taskは入れ子情報を記録しない',async()=>{
 const f=fixture(false,1);await f.preview();const unchanged=failureGuard(f),before=failureRows().length,valid={project:f.p.id,task:f.children[0].id};
 const r=await request('/api/task/integrate/keep',{project:{authorization:'SYNTHETIC_AUTH'},task:['SYNTHETIC_SECRET'],keep:'invalid',selected:[{project:{token:'SYNTHETIC_TOKEN'},task:'child'},null,{project:'child',task:{auth:'SYNTHETIC_SECRET'}},{...valid,auth:'SYNTHETIC_AUTH'}],token:'SYNTHETIC_TOKEN',authorization:'SYNTHETIC_AUTH'});
 assert.equal(r.status,409);assert.equal(r.out.error,'残す・残さないを選んでください');const rows=failureRows().slice(before);assert.equal(rows.length,1);assert.equal(rows[0].project,'');assert.equal(rows[0].task,'');assert.deepEqual(rows[0].targets,[valid]);assert.equal(rows[0].reason,r.out.error);assert.ok(!JSON.stringify(rows[0]).includes('SYNTHETIC_'));unchanged();
});
test('拒否ログ補強：正式HTTP startの不正selectedでも元の拒否応答を保持',async()=>{
 const f=fixture(true,1),d=await f.preview(),unchanged=failureGuard(f),before=failureRows().length;
 const r=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,mode:'single',selected:{}});
 assert.equal(r.status,409);assert.match(r.out.error,/selected.*iterable/);assert.equal(r.out.stage,'refresh');const rows=failureRows().slice(before);assert.equal(rows.length,1);assert.equal(rows[0].phase,'start');assert.equal(rows[0].reason,r.out.error);assert.deepEqual(rows[0].targets,[]);unchanged();
});
test('拒否ログ補強：正常なstart拒否は理由・段階・対象だけを記録',async()=>{
 const f=fixture(true,1),d=await f.preview(),unchanged=failureGuard(f),before=failureRows().length,valid={project:f.p.id,task:f.children[0].id};
 const r=await request('/api/task/integrate',{...f.common,token:d.token,confirm:false,auto:true,mode:'single',selected:[{...valid,keep:true,token:'SYNTHETIC_TOKEN',auth:'SYNTHETIC_AUTH'}],authorization:'SYNTHETIC_AUTH',prompt:'SYNTHETIC_PROMPT'});
 assert.equal(r.status,409);assert.equal(r.out.error,'もう一度統合内容を確認してください');assert.equal(r.out.stage,'refresh');const rows=failureRows().slice(before);assert.equal(rows.length,1);const row=rows[0];assert.equal(row.reason,r.out.error);assert.equal(row.phase,'start');assert.equal(row.code,'INTEGRATION_REJECTED');assert.deepEqual(row.targets,[valid]);assert.deepEqual(Object.keys(row).sort(),['action','at','code','paths','phase','project','reason','stage','targets','task'].sort());assert.ok(!JSON.stringify(row).includes('SYNTHETIC_'));unchanged();
});
test('拒否ログ補強：製品dirtyの正式HTTP拒否は保存理由とパスを保持',async()=>{
 const f=fixture(false,1),d=await f.preview();write(path.join(f.body,'product.txt'),'external change');const unchanged=failureGuard(f),before=failureRows().length,valid={project:f.p.id,task:f.children[0].id};
 const r=await request('/api/task/integrate',{...f.common,token:d.token,confirm:true,auto:true,mode:'single',selected:[{...valid,keep:true}],tokenExtra:'SYNTHETIC_TOKEN'});
 assert.equal(r.status,409);assert.equal(r.out.code,'INTEGRATION_TARGET_DIRTY');assert.equal(r.out.stage,'save');assert.match(r.out.error,/保存.*product.txt/);const rows=failureRows().slice(before);assert.equal(rows.length,1);const row=rows[0];assert.equal(row.reason,r.out.error);assert.equal(row.stage,r.out.stage);assert.equal(row.code,r.out.code);assert.deepEqual(row.paths,['product.txt']);assert.deepEqual(row.targets,[valid]);assert.ok(!JSON.stringify(row).includes('SYNTHETIC_'));unchanged();
});
test('拒否ログ補強：ログ書込み失敗でも正式HTTPの409を保持',async()=>{
 const f=fixture(true,1);await f.preview();const unchanged=failureGuard(f),before=failureRows().length,append=fs.appendFileSync;let attempts=0,r;
 fs.appendFileSync=function(file,...args){if(file===path.join(root,'_hub/log.jsonl')){attempts++;throw Error('synthetic log I/O failure');}return append.call(this,file,...args);};
 try{r=await request('/api/task/integrate/keep',{...f.common,keep:'invalid'});}finally{fs.appendFileSync=append;}
 assert.equal(attempts,1);assert.equal(r.status,409);assert.equal(r.out.error,'残す・残さないを選んでください');assert.equal(failureRows().length,before);unchanged();
});
function failureFunction(record){const src=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),a=src.indexOf('function integrationFailure('),b=src.indexOf('\nfunction readLog',a),ctx=vm.createContext({record});assert.ok(a>=0&&b>a);vm.runInContext(src.slice(a,b),ctx);return ctx.integrationFailure;}
test('拒否ログ補強：エラー側も固定schemaへ型投影し、理由の長さを制限',()=>{
 const rows=[],log=failureFunction((...args)=>rows.push(JSON.parse(JSON.stringify(args))));
 log({project:'Synthetic',task:'parent',selected:[]},{stage:{auth:'SYNTHETIC_AUTH'},code:['SYNTHETIC_TOKEN'],message:{token:'SYNTHETIC_SECRET'},paths:[{auth:'SYNTHETIC_AUTH'},null,8,'product.txt']},{token:'SYNTHETIC_TOKEN'});
 assert.equal(rows.length,1);assert.deepEqual(rows[0],['integrate-failed',{project:'Synthetic',task:'parent'},{phase:'unknown',stage:'refresh',code:'INTEGRATION_REJECTED',reason:'統合を開始できません',targets:[],paths:['product.txt']}]);assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_'));
 log(null,{message:'a'.repeat(1001)},'start');assert.equal(rows[1][2].reason.length,1000);
});
test('拒否ログ補強：記録呼出し・投影の例外を元の拒否へ伝播しない',()=>{
 const log=failureFunction(()=>{throw Error('synthetic recorder failure');});assert.doesNotThrow(()=>log({},Error('元の拒否'),'start'));assert.doesNotThrow(()=>log({get project(){throw Error('synthetic getter');}},Error('元の拒否'),'start'));
});
