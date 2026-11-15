'use strict';
// Display/periodic preflight only. Action permission is checked separately by
// handoff-admission; its strict scan never uses this display shortcut.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const fs=require('./platform/file-io');
const {noLinks}=require('./remove');
const message='会話の終了保存の点検を完了できません。少し待ってから開き直してください';
class HandoffScan {
 constructor(root,{cacheFile=root+'-display-cache.json'}={}){this.root=root;this.cacheFile=cacheFile;this.worker=null;this.pending=null;this.fault=null;this.closed=false;}
 scan(freshDirs=new Set()){
  if(this.closed||this.fault)return Promise.resolve([{stage:'spool',error:message}]);
  if(!this.worker){
   const worker=this.worker=new Worker(__filename,{workerData:{handoffScan:true,root:this.root,cacheFile:this.cacheFile}});
   const fail=()=>{this.fault=true;this.complete?.([{stage:'spool',error:message}]);};
   worker.on('message',result=>{
    // A cache write is optional and never turns a failed scan into all-clear.
    // The read-only worker can only propose metadata; it cannot write receipts.
    if(result.cache&&this.cacheFile)this.saveCache(result.cache);
    this.complete?.(result.errors||[{stage:'spool',error:message}]);
   });
   worker.once('error',fail);worker.once('exit',fail);worker.unref();
  }
  if(!this.pending){
   this.pending=new Promise(resolve=>{this.complete=errors=>{this.complete=null;this.pending=null;this.worker?.unref();resolve(errors);};});
   this.worker.ref();this.worker.postMessage({operation:'scan',freshDirs:[...freshDirs].filter(dir=>typeof dir==='string')});
  }
  // A slow first scan continues off-thread after a caller times out. Never
  // substitute an empty/old all-clear result or restart an unchanged failure.
  return new Promise(resolve=>{
   const timer=setTimeout(()=>resolve([{stage:'spool',error:message}]),30000);
   this.pending.then(errors=>{clearTimeout(timer);resolve(errors);});
  });
 }
 saveCache(cache){
  let tmp;
  try{
   noLinks(this.cacheFile);tmp=this.cacheFile+'.'+require('node:crypto').randomUUID();
   fs.writeFileSync(tmp,JSON.stringify(cache),{flag:'wx',mode:0o600});
   fs.renameSync(tmp,this.cacheFile);
  }catch{/* Corrupt, unwritable or missing cache always falls back to strict reads. */}
  finally{if(tmp)try{fs.unlinkSync(tmp);}catch{}}
 }
 close(){this.closed=true;this.complete?.([{stage:'spool',error:message}]);if(this.worker)void this.worker.terminate();this.worker=null;}
}
module.exports={HandoffScan};
if(!isMainThread&&workerData?.handoffScan===true){
 // No action method is reachable over this fixed read-only message interface.
 // Also deny accidental writes/process launches in any future scanner reader.
 const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
 const deny=()=>{throw Error('handoff display worker cannot write or launch');};
 for(const name of ['writeFile','appendFile','rename','unlink','mkdir','rmdir','rm','chmod','chown','copyFile','truncate','link','symlink','write','fsync','fdatasync','fchmod','fchown','ftruncate','utimes','futimes','lutimes','lchmod','lchown','mkdtemp','cp']){
  if(fs[name])fs[name]=deny;if(fs[name+'Sync'])fs[name+'Sync']=deny;if(fs.promises[name])fs.promises[name]=deny;
 }
 fs.createWriteStream=deny;fs.open=deny;fs.promises.open=deny;
 const open=fs.openSync;fs.openSync=(file,flags,...args)=>{if(flags!=='r'&&flags!==0)deny();return open(file,flags,...args);};
 for(const name of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])cp[name]=deny;
 const spool=require('./cli-spool');
 if(workerData.cacheFile)try{
  // Optional local display metadata only. Broken or linked caches are ignored.
  noLinks(workerData.cacheFile);const st=fs.lstatSync(workerData.cacheFile);
  if(st.isFile()&&st.size<=16*1024*1024)spool.importDisplayCache(workerData.root,JSON.parse(fs.readFileSync(workerData.cacheFile,'utf8')));
 }catch{}
 let lastCache;

 parentPort.on('message',operation=>{
  try{
   if(operation?.operation!=='scan'||!Array.isArray(operation.freshDirs)||!operation.freshDirs.every(dir=>typeof dir==='string'))throw Error('unknown handoff display operation');
   const errors=[];
   for(const dir of spool.pending(workerData.root,{display:true,freshDirs:new Set(operation.freshDirs)})){
    const issue=spool.failure(dir);if(!issue)continue;
    const o=spool.read(dir,'request.json')?.options;
    errors.push({run:path.basename(dir),project:o?.project,task:o?.task,...issue});
   }
   const cache=spool.exportDisplayCache(workerData.root),encoded=JSON.stringify(cache);
   parentPort.postMessage({errors,...(workerData.cacheFile&&lastCache!==encoded?{cache}:{})});lastCache=encoded;
  }catch{parentPort.postMessage({errors:[{stage:'spool',error:message}]});}
 });
}
