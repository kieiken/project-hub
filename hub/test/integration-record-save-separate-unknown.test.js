'use strict';
// U3: real Git and isolated official HTTP. Start validation is real; the
// background tick is held so a failing baseline cannot dispatch a fixture AI.
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-separate-unknown-')),root=path.join(tmp,'root'),home=path.join(tmp,'home');
fs.mkdirSync(home);fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
Object.assign(process.env,{HUB_ROOT:root,HOME:home,HUB_FREETALK_HOME:home,HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(58000+Math.floor(Math.random()*1000))});
function baseline(files){if(process.env.HUB_U3_BEFORE==='1')for(const file of files){const name=require('node:path').basename(file,'.js'),Module=require('node:module'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(require('node:path').dirname(file));m._compile(require('node:child_process').execFileSync('git',['show','e5f51c7:hub/lib/'+name+'.js'],{encoding:'utf8'}),file);require.cache[file]=m;}}
const baselineFiles=['integration-record-save','integration-simple'].map(n=>require.resolve('../lib/'+n));baseline(baselineFiles);
const {IntegrateAuto}=require('../lib/integrate-auto');let auto;const original=IntegrateAuto.prototype.preview;IntegrateAuto.prototype.preview=function(...a){auto=this;return original.apply(this,a);};
const originalAsync=IntegrateAuto.prototype.previewAsync;IntegrateAuto.prototype.previewAsync=function(...a){auto=this;return originalAsync.apply(this,a);};
let ticks=0;const originalTick=IntegrateAuto.prototype.tick;IntegrateAuto.prototype.tick=async()=>{ticks++;};
const {Store}=require('../lib/store'),chat=require('../lib/chat'),writes=require('../lib/integration-writes'),store=new Store(root),server=require('../server').server;let base,serial=0;
const g=(d,...a)=>execFileSync('git',['-C',d,'-c','core.fsmonitor=false',...a],{encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
const hash=x=>createHash('sha256').update(x).digest('hex'),write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
const request=async(route,b)=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(b)});return {status:r.status,out:await r.json()};};
function fixture(same){const p=store.createProject({name:'U3-'+(++serial)}).project,body=same?p.dir:path.join(tmp,'body-'+serial);fs.mkdirSync(body,{recursive:true});if(!same){const f=path.join(p.dir,'PROJECT.md');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));}
 const parent=store.createTask(p.id,{title:'親',steps:['未済']}),child=store.createTask(p.id,{title:'子',parent:parent.id,steps:['完成']});store.setStep(p.id,child.id,0,true);store.appendSection(p.id,child.id,'成果','- なし：隔離データ');store.appendSection(p.id,child.id,'残件申告','```json\n{"status":"なし","items":"なし","undecided":"なし","evidence":"fixture"}\n```');chat.append(p.dir,parent.id,{role:'user',text:'baseline'});write(path.join(body,'product.txt'),'baseline');
 for(const dir of [...new Set([body,p.dir])]){g(dir,'init','-q');g(dir,'config','user.name','Fixture');g(dir,'config','user.email','fixture@localhost');g(dir,'add','.');g(dir,'commit','-qm','base');}
 const common={project:p.id,task:parent.id},preview=async()=>{const r=await request('/api/task/integrate/preview',{...common,simple:true});assert.equal(r.status,200,JSON.stringify(r.out));return r.out;};return {p,parent,child,body,common,preview};}
const save=(f,d)=>request('/api/task/integrate/records/save',{...f.common,token:d.token,confirm:true});
function state(dir){const index=path.join(g(dir,'rev-parse','--absolute-git-dir'),'index');return {head:g(dir,'rev-parse','HEAD'),index:hash(fs.readFileSync(index)),status:g(dir,'status','--porcelain'),count:Number(g(dir,'rev-list','--count','HEAD'))};}
function receipt(f){const file=path.join(root,'_hub/record-saves',hash(g(f.p.dir,'rev-parse','--show-toplevel'))+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;}
async function cold(f){const probe=require('node:net').createServer();await new Promise(y=>probe.listen(0,'127.0.0.1',y));const port=probe.address().port;await new Promise(y=>probe.close(y));const source=`(${baseline.toString()})(${JSON.stringify(baselineFiles)});const s=require(${JSON.stringify(require.resolve('../server'))}).server;(async()=>{await new Promise(y=>s.listen(Number(process.env.HUB_PORT),'127.0.0.1',y));const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/task/integrate/preview',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({...f.common,simple:true}))}});const out=await r.json();s.closeAllConnections();await new Promise(y=>s.close(y));process.stdout.write(JSON.stringify({status:r.status,out}));})();`;const raw=execFileSync(process.execPath,['-e',source],{encoding:'utf8',env:{...process.env,HUB_PORT:String(port)}});return JSON.parse(raw.slice(raw.indexOf('{"status":')));}
test.before(async()=>{await new Promise(y=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',y));base='http://127.0.0.1:'+server.address().port;await new Promise(setImmediate);});
test.after(async()=>{server.closeAllConnections();await new Promise(y=>server.close(y));IntegrateAuto.prototype.preview=original;IntegrateAuto.prototype.previewAsync=originalAsync;IntegrateAuto.prototype.tick=originalTick;fs.rmSync(tmp,{recursive:true,force:true});});

const unknownReason=/保存結果が不明/;
const integrationRequest=(f,d)=>({...f.common,token:d.token,auto:true,confirm:true,mode:'single',selected:[{project:f.p.id,task:f.child.id,keep:true}]});
const start=(f,d)=>request('/api/task/integrate',integrationRequest(f,d));
const receiptFile=f=>path.join(root,'_hub/record-saves',hash(g(f.p.dir,'rev-parse','--show-toplevel'))+'.json');
async function unknown(f){
 const clean=await f.preview();assert.ok(clean.items.some(i=>i.task===f.child.id&&i.startable));
 const rel='.ai/chat/'+f.parent.id+'.queue.json',file=write(path.join(f.p.dir,rel),'[]\n');fs.chmodSync(file,0o755);
 const before=state(f.p.dir),bodyBefore=state(f.body),contents=writes.state(file),d=await f.preview();assert.equal(d.recordSave.allowed,true);
 const rename=fs.renameSync;let failed=false;fs.renameSync=(a,b)=>{if(!failed&&b===receiptFile(f)&&JSON.parse(fs.readFileSync(a,'utf8')).phase==='done'){failed=true;throw Error('U3 done acknowledgement failed');}return rename(a,b);};
 let out;try{out=await save(f,d);}finally{fs.renameSync=rename;}
 assert.equal(failed,true);assert.equal(out.status,409);assert.equal(out.out.delivery.state,'unknown');assert.equal(receipt(f).phase,'unknown');
 const after=state(f.p.dir);assert.equal(after.count,before.count+1);assert.equal(g(f.p.dir,'rev-parse','HEAD^'),before.head);assert.equal(after.status,'');assert.equal(g(f.p.dir,'diff','--cached','--name-only'),'');assert.equal(g(f.p.dir,'diff-tree','--no-commit-id','--name-only','-r',before.head,after.head),rel);assert.equal(writes.state(file),contents);assert.equal(hash(execFileSync('git',['-C',f.p.dir,'show','HEAD:'+rel])),contents.split(':')[0]);assert.match(g(f.p.dir,'ls-files','--stage','--',rel),/^100755 /);if(f.body!==f.p.dir)assert.deepEqual(state(f.body),bodyBefore);
 return {clean,d,after,rel,file,contents};
}
function blocked(d){assert.equal(d.recordSave.unresolved,true,JSON.stringify(d.recordSave));assert.equal(d.recordSave.allowed,false);assert.match(d.recordSave.reason,unknownReason);assert.ok(d.items.length&&d.items.every(i=>!i.startable));}
for(const same of [true,false])for(const dirty of [false,true])test('U3 ack未知→fresh/cold/最新確認/直API/R1再送拒否 '+(same?'同Git':'別Git')+'/'+(dirty?'製品dirty':'clean'),async()=>{
 const f=fixture(same),u=await unknown(f);if(dirty)write(path.join(f.body,'product.txt'),'external product');
 const ledger=state(f.p.dir),target=state(f.body),packet=fs.readFileSync(receiptFile(f)),tickBefore=ticks;
 const fresh=await f.preview();blocked(fresh);const boot=await cold(f);assert.equal(boot.status,200);blocked(boot.out);
 const denied=await start(f,fresh);assert.equal(denied.status,409);assert.match(denied.out.error,unknownReason);
 for(const d of [u.d,fresh])assert.equal((await save(f,d)).status,409);
 assert.deepEqual(state(f.p.dir),ledger);assert.deepEqual(state(f.body),target);assert.equal(writes.state(u.file),u.contents);assert.deepEqual(fs.readFileSync(receiptFile(f)),packet);assert.equal(auto.integrate.read(f.p.id,f.parent.id),null);assert.equal(auto.integrate.transfer.read(f.p.id,f.child.id),null);assert.equal(ticks,tickBefore);
});
for(const same of [true,false])test('U3 開始可能な旧tokenでも実行直前に未知を拒否・保持選択/受領/後処理0 '+(same?'同Git':'別Git'),async()=>{
 const f=fixture(same),u=await unknown(f),ledger=state(f.p.dir),target=state(f.body),parent=fs.readFileSync(store.taskFile(f.p.id,f.parent.id)),child=fs.readFileSync(store.taskFile(f.p.id,f.child.id)),tickBefore=ticks;
 const denied=await start(f,u.clean);assert.equal(denied.status,409);assert.match(denied.out.error,unknownReason);
 assert.deepEqual(state(f.p.dir),ledger);assert.deepEqual(state(f.body),target);assert.deepEqual(fs.readFileSync(store.taskFile(f.p.id,f.parent.id)),parent);assert.deepEqual(fs.readFileSync(store.taskFile(f.p.id,f.child.id)),child);assert.equal(auto.integrate.read(f.p.id,f.parent.id),null);assert.equal(auto.integrate.transfer.read(f.p.id,f.child.id),null);assert.equal(ticks,tickBefore);
});
for(const same of [true,false])test('U3 doneと確定not-sentは未知停止にしない・新tokenの限定保存 '+(same?'同Git':'別Git'),async()=>{
 const f=fixture(same),file=write(path.join(f.p.dir,'.ai/chat',f.parent.id+'.queue.json'),'[]\n'),d=await f.preview(),before=state(f.p.dir),read=fs.readFileSync,idx=path.join(g(f.p.dir,'rev-parse','--absolute-git-dir'),'index');let injected=false;
 fs.readFileSync=(p,...a)=>{const bytes=read(p,...a);if(!injected&&p===idx&&g(f.p.dir,'ls-files','--',file)){injected=true;fs.appendFileSync(file,' ');}return bytes;};
 let denied;try{denied=await save(f,d);}finally{fs.readFileSync=read;}
 assert.equal(injected,true);assert.equal(denied.status,409);assert.equal(denied.out.delivery.state,'not-sent');assert.equal(receipt(f).phase,'not-sent');assert.equal(state(f.p.dir).head,before.head);assert.equal(state(f.p.dir).index,before.index);assert.equal(state(f.p.dir).count,before.count);assert.equal((await f.preview()).recordSave.unresolved,false);assert.equal((await cold(f)).out.recordSave.unresolved,false);
 const fresh=await f.preview();assert.equal(fresh.recordSave.allowed,true);assert.equal((await save(f,fresh)).status,200);assert.equal(receipt(f).phase,'done');assert.equal(state(f.p.dir).count,before.count+1);assert.equal((await f.preview()).recordSave.unresolved,false);const boot=await cold(f);assert.equal(boot.out.recordSave.unresolved,false);assert.ok(boot.out.items.some(i=>i.task===f.child.id&&i.startable));
});
test('U3 関連する統合先Gitの未知も台帳dirty/cleanに依存せず検出',async()=>{
 const other=fixture(true);await unknown(other);const f=fixture(false),project=path.join(f.p.dir,'PROJECT.md');fs.writeFileSync(project,fs.readFileSync(project,'utf8').replace(JSON.stringify(f.body),JSON.stringify(other.body)));g(f.p.dir,'add','--',project);g(f.p.dir,'commit','-qm','fixture target');f.body=other.body;
 for(const dirty of [false,true]){if(dirty)write(path.join(f.p.dir,'.ai/chat',f.parent.id+'.queue.json'),'[]\n');const before=state(f.p.dir),target=state(f.body),fresh=await f.preview();blocked(fresh);blocked((await cold(f)).out);assert.equal((await save(f,fresh)).status,409);const denied=await start(f,fresh);assert.equal(denied.status,409);assert.match(denied.out.error,unknownReason);assert.deepEqual(state(f.p.dir),before);assert.deepEqual(state(f.body),target);}
});
test('U3 無関係な保存先のunknownは分離し、製品/HEAD/index保護を維持',async()=>{
 const unrelated=fixture(false);await unknown(unrelated);
 const f=fixture(false),file=write(path.join(f.p.dir,'.ai/chat',f.parent.id+'.queue.json'),'[]\n'),d=await f.preview();assert.equal(d.recordSave.unresolved,false);assert.equal(d.recordSave.allowed,true);assert.equal((await save(f,d)).status,200);const clean=await f.preview();assert.equal(clean.recordSave.unresolved,false);assert.ok(clean.items.some(i=>i.task===f.child.id&&i.startable));
 for(const change of ['product','head','index']){const x=fixture(true),q=write(path.join(x.p.dir,'.ai/chat',x.parent.id+'.queue.json'),'[]\n'),old=await x.preview();if(change==='product')write(path.join(x.body,'product.txt'),'external');if(change==='head')g(x.body,'commit','--allow-empty','-qm','external');if(change==='index')g(x.body,'add','--',q);const before=state(x.body),denied=await save(x,old);assert.equal(denied.status,409);assert.deepEqual(state(x.body),before);assert.equal(receipt(x),null);if(change!=='head')assert.equal((await x.preview()).recordSave.allowed,false);}
 assert.equal(receipt(unrelated).phase,'unknown');assert.equal(fs.readFileSync(file,'utf8'),'[]\n');
});
test('U3 関連するreceiptが読取不能ならcleanでも未知停止',async()=>{
 const f=fixture(false);await unknown(f);const read=fs.readFileSync,receiptPath=receiptFile(f);fs.readFileSync=(p,...a)=>{if(p===receiptPath)throw Object.assign(Error('receipt unavailable'),{code:'EACCES'});return read(p,...a);};try{const d=await f.preview();blocked(d);const denied=await start(f,d);assert.equal(denied.status,409);assert.match(denied.out.error,unknownReason);}finally{fs.readFileSync=read;}assert.equal(receipt(f).phase,'unknown');
});
test('U3 Gitなしの直接本体を妨げず、台帳の未知はGitなし本体でも保持',async()=>{
 const clean=fixture(false);fs.rmSync(path.join(clean.body,'.git'),{recursive:true,force:true});const d=await clean.preview();assert.equal(d.recordSave.unresolved,false);assert.ok(d.items.some(i=>i.task===clean.child.id&&i.startable));assert.equal(require('../lib/integration-record-save').unresolved?.(auto.integrate,auto.integrate.ancestor(clean.p.id,clean.parent.id))??false,false);
 const f=fixture(false),u=await unknown(f);fs.rmSync(path.join(f.body,'.git'),{recursive:true,force:true});blocked(await f.preview());blocked((await cold(f)).out);const before=state(f.p.dir),denied=await start(f,u.clean);assert.equal(denied.status,409);assert.match(denied.out.error,unknownReason);assert.deepEqual(state(f.p.dir),before);assert.equal(receipt(f).phase,'unknown');assert.equal(auto.integrate.read(f.p.id,f.parent.id),null);
});
