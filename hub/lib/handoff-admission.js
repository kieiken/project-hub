'use strict';
// Action preflight, deliberately separate from the 60-second display shortcut.
// Requests may share only a scan begun after they arrived. One pending batch
// follows the current batch; deadlines measure execution, never queue residence.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const message='会話の終了保存の点検を完了できません。少し待ってから操作し直してください';
const failure=()=>Object.assign(Error(message),{code:'HANDOFF_CHECK_UNAVAILABLE',status:409});
class HandoffAdmission {
 constructor(root,{timeoutMs=30000}={}){this.root=root;this.timeoutMs=timeoutMs;this.closed=false;this.sequence=0;this.retiring=Promise.resolve();}
 createWorker(){return new Worker(__filename,{workerData:{handoffAdmission:true,root:this.root}});}
 scan({background=false}={}){
  if(this.closed)return Promise.reject(failure());
  // Maintenance never adds a scan behind a human operation. It can use the
  // not-yet-started batch, or skip this tick while a lone scan is in flight.
  if(background&&this.active&&!this.pending)return Promise.resolve(null);
  if(!this.pending){
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
   this.pending={id:++this.sequence,promise,resolve,reject};
  }
  const promise=this.pending.promise;
  this.schedule();return promise;
 }
 schedule(){
  if(this.scheduled||this.active||this.closed)return;
  this.scheduled=true;setImmediate(()=>{this.scheduled=false;void this.start();});
 }
 async start(){
  if(this.starting||this.active||!this.pending||this.closed)return;
  this.starting=true;await this.retiring;this.starting=false;
  if(this.active||!this.pending||this.closed)return;
  const batch=this.active=this.pending;this.pending=null;
  try{
   if(!this.worker){
    const worker=this.worker=this.createWorker();
    worker.on('message',result=>{
     if(this.worker!==worker)return;
     if(!this.active||result?.id!==this.active.id||result.ok!==true||!Array.isArray(result.errors)||!Array.isArray(result.dirs))return this.fail();
     const current=this.active;clearTimeout(current.timer);this.active=null;worker.unref();current.resolve(result);this.schedule();
    });
    worker.on('error',()=>{if(this.worker===worker)this.fail();});
    worker.on('exit',()=>{if(this.worker===worker)this.fail();});
   }
   this.worker.ref();
   batch.timer=setTimeout(()=>this.fail(),this.timeoutMs);
   this.worker.postMessage({op:'scan',id:batch.id});
  }catch{this.fail();}
 }
 fail(){
  // Only current waiters fail. No sticky fault: a subsequent request creates a
  // new worker after termination and gets its own full execution deadline.
  const worker=this.worker;this.worker=null;
  if(worker)this.retiring=Promise.resolve(worker.terminate()).catch(()=>{});
  for(const batch of [this.active,this.pending])if(batch){clearTimeout(batch.timer);batch.reject(failure());}
  this.active=this.pending=null;
 }
 close(){this.closed=true;this.fail();}
}
module.exports={HandoffAdmission};
if(!isMainThread&&workerData?.handoffAdmission===true){
 const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
 const deny=()=>{throw Error('handoff admission worker cannot write or launch');};
 for(const name of ['writeFile','appendFile','rename','unlink','mkdir','rmdir','rm','chmod','chown','copyFile','truncate','link','symlink','write','fsync','fdatasync','fchmod','fchown','ftruncate','utimes','futimes','lutimes','lchmod','lchown','mkdtemp','cp']){
  if(fs[name])fs[name]=deny;if(fs[name+'Sync'])fs[name+'Sync']=deny;if(fs.promises[name])fs.promises[name]=deny;
 }
 fs.createWriteStream=deny;fs.open=deny;fs.promises.open=deny;
 const open=fs.openSync;fs.openSync=(file,flags,...args)=>{if(flags!=='r'&&flags!==0)deny();return open(file,flags,...args);};
 for(const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])cp[name]=deny;
 const spool=require('./cli-spool'),root=workerData.root;
 const core=['request.json','finalizing.json','failure.json','finished.json','finished-confirmed.json','recovered.json'];
 const proof=['exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json'];
 const stat=(file,directory=false)=>{
  try{const s=fs.lstatSync(file,{bigint:true});if(directory?!s.isDirectory():!s.isFile())throw Error('nonregular receipt');fs.accessSync(file,fs.constants.R_OK|(directory?fs.constants.X_OK:0));return (directory?['dev','ino','mode','uid','gid']:['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid','nlink']).map(k=>String(s[k])).join(':');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
 };
 const snapshot=()=>{
  if(!stat(root,true))return 'absent';
  const dirs=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
  return JSON.stringify(dirs.map(name=>{
   const dir=path.join(root,name),base=core.map(n=>[n,stat(path.join(dir,n))]);
   // Output/cursor churn of an unfinished, failure-free CLI is not a change
   // in its save verdict. As soon as a finish/failure phase exists, all proof
   // inputs participate (including permissions and in-place replacements).
   const sealed=base.some(([n,s])=>s&&['finalizing.json','failure.json','finished.json','recovered.json'].includes(n));
   return [name,stat(dir,true),base,sealed?proof.map(n=>[n,stat(path.join(dir,n))]):[]];
  }));
 };
 parentPort.on('message',request=>{
  if(request?.op!=='scan'||!Number.isSafeInteger(request.id)||request.id<1){parentPort.postMessage({ok:false});return;}
  try{
   let result;
   for(let attempt=0;attempt<2;attempt++){
    const before=snapshot(),errors=[],dirs=spool.pending(root);
    for(const dir of dirs){const issue=spool.failure(dir);if(issue){const o=spool.read(dir,'request.json')?.options;errors.push({run:path.basename(dir),project:o?.project,task:o?.task,...issue});}}
    if(before===snapshot()){result={ok:true,errors,dirs};break;}
   }
   parentPort.postMessage({id:request.id,...(result||{ok:false})});
  }catch{parentPort.postMessage({id:request.id,ok:false});}
 });
}
