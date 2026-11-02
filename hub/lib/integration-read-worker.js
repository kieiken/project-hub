'use strict';
// The legacy receipt preview traverses removal/provenance/recovery readers.
// Run that existing read graph off the HTTP loop instead of duplicating its
// authorization rules. Live hooks below are explicit read-only RPCs; no action
// method, token consumption, save, dispatch or restart is exposed to the worker.
const {Worker,isMainThread,parentPort,workerData,MessageChannel,receiveMessageOnPort}=require('node:worker_threads');
const path=require('node:path');
function errorData(e){return {message:e.message,code:e.code,paths:e.paths,status:e.status,stdout:e.stdout,stderr:e.stderr};}
function failure(e){for(const k of ['stdout','stderr'])if(e[k] instanceof Uint8Array)e[k]=Buffer.from(e[k]);return Object.assign(Error(e.message),e);}
function run(operation,args,{dirs=[],hooks={}}={}){
 return require('./git-read').consistent(dirs,()=>new Promise((resolve,reject)=>{
  const channel=new MessageChannel(),signal=new Int32Array(new SharedArrayBuffer(4));
  const worker=new Worker(__filename,{workerData:{operation,args,port:channel.port2,signal},transferList:[channel.port2],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  let received=false;
  channel.port1.on('message',m=>{
   const reply=m=>{channel.port1.postMessage(m);Atomics.store(signal,0,1);Atomics.notify(signal,0);};
   if(m.name==='git.read'){
    const [dir,argv,options]=m.args;
    require('./git-read').command(dir,argv,options).then(value=>reply({id:m.id,value}),e=>reply({id:m.id,error:errorData(e)}));return;
   }
   try{if(!Object.hasOwn(hooks,m.name))throw Error('unknown read hook');const value=hooks[m.name](...m.args);if(value?.then)throw Error('read hook must be synchronous');reply({id:m.id,value});}
   catch(e){reply({id:m.id,error:errorData(e)});}
  });
  worker.once('message',m=>{received=true;if(m.error)reject(failure(m.error));else resolve(m.value);});
  worker.once('error',reject);worker.once('exit',code=>{channel.port1.close();if(!received)reject(Error('read worker exited: '+code));});
 }));
}
function context(h,auto){
 const hooks={},bind=(name,f)=>{if(f)hooks[name]=f;};
 for(const name of ['listProjects','readProject','taskFile','readTask'])bind('store.'+name,(...a)=>h.store[name](...a));
 bind('baseOf',p=>h.baseOf(p));
 for(const name of ['busy','locked','reviewBusy'])bind('removal.'+name,(...a)=>h.removal[name](...a));
 bind('transfer.integration',(...a)=>h.transfer.integration(...a));
 if(h.transfer.integrationRead)bind('transfer.integrationRead',(...a)=>h.transfer.integrationRead(...a));
 bind('validateAssignment',(...a)=>h.validateAssignment?.(...a));
 if(auto){
  for(const name of ['busy','waitStatus','savedCompletion','pendingRequest','deliveryEvidence','questionResolution','probeRequest'])if(auto[name])bind('auto.'+name,(...a)=>auto[name](...a));
  const chats=auto.abandon?.chats;
  if(chats){bind('chats.queue',(...a)=>chats.queue(...a));bind('chats.busy',(...a)=>{const r=chats.busy(...a);if(!r||typeof r!=='object')return r;return JSON.parse(JSON.stringify({request:r.request,text:r.text,integrationAuto:r.integrationAuto,o:r.o,options:r.options,row:r.row}));});}
 }
 const all=h.store.listProjects(),expand=require('./store').expandHome;
 const dirs=[...new Set(all.flatMap(p=>[p.dir,h.baseOf(p),...p.tasks.map(t=>expand(t.workdir)).filter(Boolean)]))];
 return {dirs,hooks,args:{root:h.store.root,product:h.store.product,trash:h.removal.trash,transferRead:Boolean(h.transfer.integrationRead),active:Boolean(h.active),auto: auto?{active:auto.active,hooks:Object.keys(hooks),abandon:auto.abandon?{logFile:auto.abandon.logFile,spoolRoot:auto.abandon.chats?.spoolRoot}:null}:null}};
}
const pendingIntegrations=new WeakMap();
function integration(h,auto,b){
 const owner=auto||h;let pending=pendingIntegrations.get(owner);if(!pending)pendingIntegrations.set(owner,pending=new Map());
 const key=JSON.stringify(b);if(pending.has(key))return pending.get(key);
 const request=integrationRead(h,auto,b).finally(()=>pending.delete(key));pending.set(key,request);return request;
}
async function integrationRead(h,auto,b){
 const c=context(h,auto);const result=await run(auto?'auto.preview':'integration.preview',{...c.args,b},{dirs:c.dirs,hooks:c.hooks});
 // Install display tokens only in the real owner. Actions still repeat every
 // synchronous source/target, receipt, assignment and scope check before use.
 for(const [id,x]of h.tokens)if(Date.now()-x.at>600000||auto&&result.waiting?.length&&x.value.project===b.project&&x.value.task===b.task)h.tokens.delete(id);
 for(const [id,x]of result.tokens)h.tokens.set(id,x);
 return result.value;
}
module.exports={run,integration};
if(!isMainThread&&workerData?.operation){
 const {operation,args,port,signal}=workerData;let sequence=0;
 const operations=new Set(['git.preview','writes.ignored','delivery.status','delivery.legacy','delivery.unresolved','flow.approval','flow.applied','flow.status','flow.versionAt','flow.blockedCompletion','integration.preview','auto.preview']);
 const rpc=(name,...a)=>{
  const id=++sequence;Atomics.store(signal,0,0);port.postMessage({id,name,args:a});
  for(;;){const m=receiveMessageOnPort(port)?.message;if(m){if(m.id!==id)throw Error('read hook order changed');if(m.error)throw failure(m.error);return m.value;}Atomics.wait(signal,0,0,1000);}
 };
 // Enforce the display boundary even if a future reader accidentally starts
 // writing. Git merge-tree may create unreachable objects, as in old preview;
 // no Git index/ref/worktree mutation is permitted.
 const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');
 // Record-save readiness probes use a disposable private index. Preserve that
 // existing dry-run, without granting any real-index/ref/worktree writes.
 const privateIndexes=new Set(),mkdtemp=fs.mkdtempSync,copyFile=fs.copyFileSync,remove=fs.rmSync,unlink=fs.unlinkSync,rmdir=fs.rmdirSync;
 const deny=()=>{throw Error('display worker cannot write');};
 for(const name of ['writeFile','appendFile','rename','unlink','mkdir','rmdir','rm','chmod','chown','copyFile','truncate','link','symlink','write','fsync','fdatasync','fchmod','fchown','ftruncate','utimes','futimes','lutimes','lchmod','lchown','mkdtemp','cp']){
  if(fs[name])fs[name]=deny;if(fs[name+'Sync'])fs[name+'Sync']=deny;if(fs.promises[name])fs.promises[name]=deny;
 }
 fs.mkdtempSync=prefix=>{if(prefix!==path.join(os.tmpdir(),'hub-record-index-'))deny();const dir=mkdtemp(prefix);privateIndexes.add(path.join(dir,'index'));return dir;};
 fs.copyFileSync=(from,to)=>{if(!privateIndexes.has(to))deny();return copyFile(from,to);};
 const privatePath=file=>{if(Buffer.isBuffer(file))file=file.toString();return typeof file==='string'&&[...privateIndexes].some(index=>file===path.dirname(index)||file.startsWith(path.dirname(index)+path.sep));};
 fs.unlinkSync=file=>{if(!privatePath(file))deny();return unlink(file);};
 fs.rmdirSync=(dir,options)=>{if(!privatePath(dir))deny();return rmdir(dir,options);};
 fs.rmSync=(dir,options)=>{const index=path.join(dir,'index');if(!privateIndexes.has(index))deny();try{return remove(dir,options);}finally{privateIndexes.delete(index);}};
 fs.createWriteStream=deny;fs.open=deny;fs.promises.open=deny;
 cp.exec=deny;cp.execSync=deny;cp.execFile=deny;cp.spawn=deny;cp.spawnSync=deny;cp.fork=deny;
 const open=fs.openSync;fs.openSync=(file,flags,...a)=>{if(flags!=='r'&&flags!==0)deny();return open(file,flags,...a);};
 cp.execFileSync=(file,argv,options={})=>{
  if(file!=='git'||!Array.isArray(argv))deny();
  // Each allowed command is read-only, except merge-tree's existing temporary
  // object output. `config` is limited to the existing identity read.
  const allowed=new Set(['rev-parse','status','diff','ls-files','merge-base','merge-tree','show','ls-tree','cat-file','symbolic-ref','show-ref','rev-list','log','reflog','config','check-ignore','diff-tree']);
  let i=0,dir;const prefix=[];while(i<argv.length){
   if(argv[i]==='-C'){if(dir||!path.isAbsolute(argv[i+1]||''))deny();dir=argv[i+1];i+=2;}
   else if(argv[i]==='-c'){if(!argv[i+1])deny();prefix.push(argv[i],argv[i+1]);i+=2;}
   else if(['--no-pager','--literal-pathspecs'].includes(argv[i]))prefix.push(argv[i++]);else break;
  }if(!dir)deny();
  const temporaryIndex=options.env?.GIT_INDEX_FILE;
  if(temporaryIndex&&!privateIndexes.has(temporaryIndex))deny();
  const probe=temporaryIndex&&(
   argv[i]==='add'&&argv[i+1]==='--intent-to-add'&&argv[i+2]==='--'&&argv.slice(i+3).every(p=>p.startsWith(':(top,literal)'))||
   argv[i]==='commit'&&argv[i+1]==='--only'&&argv[i+2]==='--dry-run'&&argv[i+3]==='--'&&argv.slice(i+4).every(p=>p.startsWith(':(top,literal)'))&&argv.includes('core.hooksPath=/dev/null')&&argv.includes('commit.gpgSign=false'));
  if(!allowed.has(argv[i])&&!probe||argv[i]==='config'&&!(['user.email','hub.mode'].includes(argv[i+1])&&argv.length===i+2||argv[i+1]==='--get'&&argv[i+2]==='remote.origin.url'&&argv.length===i+3))deny();
  const value=rpc('git.read',dir,[...prefix,...argv.slice(i)],{encoding:options.encoding||null,maxBuffer:options.maxBuffer||256*1024*1024,trim:false,...(temporaryIndex?{temporaryIndex}:{})});
  return value instanceof Uint8Array?Buffer.from(value):value;
 };
 const execute=()=>{
  if(!operations.has(operation))throw Error('unknown display operation');
  const git=require('./git'),writes=require('./integration-writes');if(args.root)writes.register(args.root);
  if(operation==='git.preview')return git.preview({...args,targetGuard:d=>writes.inspect(git,d)});
  if(operation==='writes.ignored'){for(const root of args.roots)writes.register(root);return writes.ignored(args.dir);}
  if(operation.startsWith('delivery.')||operation.startsWith('flow.')){
   const {MainMergeDelivery}=require('./main-merge-delivery'),ledger=new MainMergeDelivery(args.root,git,args.log);
   if(operation.startsWith('delivery.'))return ledger[operation.slice(9)]({...args.scope,mainMergeTokens:new Map(args.tokens||[])});
   const {MainMergeFlow}=require('./main-merge-flow'),flow=new MainMergeFlow({ledger,git,runtime:()=>args.runtime,restart:()=>({status:()=>args.restart}),keep:deny});
   return flow[operation.slice(5)](...args.call);
  }
  const store={root:args.root,product:args.product};for(const name of ['listProjects','readProject','taskFile','readTask'])store[name]=(...a)=>rpc('store.'+name,...a);
  const {Removal}=require('./remove'),removal=new Removal({store,trash:args.trash,...Object.fromEntries(['busy','locked','reviewBusy'].map(name=>[name,(...a)=>rpc('removal.'+name,...a)]))});
  const baseOf=p=>rpc('baseOf',p),{TaskTransfer}=require('./task-transfer'),transfer=new TaskTransfer({store,removal,baseOf,integration:(...a)=>{if(!args.transferRead)return rpc('transfer.integration',...a);const r=rpc('transfer.integrationRead',...a);return git.integrationReceipt(r.dir,r.record,r.task);}});
  const {TaskIntegrate}=require('./task-integrate'),h=new TaskIntegrate({store,transfer,removal,baseOf});h.active=args.active;h.validateAssignment=(...a)=>rpc('validateAssignment',...a);
  let value;
  if(operation==='integration.preview'){const b=args.b;value=h.preview(b.project,b.task,b.only,b.options);}
  else {
   const {IntegrateAuto}=require('./integrate-auto'),auto=new IntegrateAuto({integrate:h});auto.active=args.auto.active;
   for(const key of args.auto.hooks.filter(k=>k.startsWith('auto.'))){const name=key.slice(5);auto[name]=(...a)=>rpc(key,...a);}
   if(args.auto.abandon){const chats={spoolRoot:args.auto.abandon.spoolRoot,queue:(...a)=>rpc('chats.queue',...a),busy:(...a)=>rpc('chats.busy',...a)};auto.abandon=new (require('./integration-abandon').IntegrationAbandon)({integrate:h,auto,chats,logFile:args.auto.abandon.logFile});}
   value=auto.preview(args.b);
  }
  return {value,tokens:[...h.tokens],waiting:value.waiting};
 };
 try{parentPort.postMessage({value:execute()});}catch(e){parentPort.postMessage({error:errorData(e)});}finally{port.close();}
}
