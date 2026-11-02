'use strict';
// Display-only reads. No completed result cache and no identity/config writes.
const fs=require('./platform/file-io'),path=require('node:path'),{execFile}=require('node:child_process');
const inflight=new Map();
function command(dir,args,{encoding='utf8',maxBuffer=256*1024*1024,trim=true,temporaryIndex}={}){
 const key=JSON.stringify([path.resolve(dir),args,encoding,maxBuffer,trim,temporaryIndex]);
 if(inflight.has(key))return inflight.get(key);
 const pending=new Promise((resolve,reject)=>execFile('git',['-C',dir,'-c','gc.auto=0','-c','diff.autoRefreshIndex=false',...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',...(temporaryIndex?{GIT_INDEX_FILE:temporaryIndex}:{})},encoding,maxBuffer},(error,stdout,stderr)=>{
  if(error){error.status=error.code;error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve(encoding&&trim?stdout.trim():stdout);
 })).finally(()=>inflight.delete(key));inflight.set(key,pending);return pending;
}
async function attempt(dir,args,options){try{return await command(dir,args,options);}catch{return null;}}
function stamp(dir){
 // Disposable-index dry runs add/remove temporary metadata, not HEAD/index.
 const head=require('./git').headStamp(dir,{directoryMetadata:false});if(head===null)return null;
 // Ordinary external status can refresh index metadata without a saved change.
 // Keep that retry hint separate from HEAD/ref and paused-operation changes.
 let base=path.resolve(dir);for(;;){let own=path.join(base,'.git');if(fs.existsSync(own)){
  try{if(fs.statSync(own).isFile())own=path.resolve(base,fs.readFileSync(own,'utf8').match(/^gitdir: (.+)\s*$/)[1].trim());
   const stat=n=>{try{const s=fs.lstatSync(path.join(own,n));return [n,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];}catch(e){if(e.code==='ENOENT')return [n,null];throw e;}};
   return {strong:JSON.stringify([head,...['HEAD.lock','MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG','BISECT_START'].map(stat)]),weak:JSON.stringify(['index','index.lock'].map(stat))};
  }catch{return null;}
 }const up=path.dirname(base);if(up===base)return null;base=up;}
}
async function consistent(dirs,read){
 for(let round=0;round<2;round++){
  const before=dirs.map(stamp);let result,error;try{result=await read();}catch(e){error=e;}
  const after=dirs.map(stamp),strongChanged=before.some((s,i)=>s?.strong!==after[i]?.strong),weakChanged=before.some((s,i)=>s?.weak!==after[i]?.weak);
  if(!round&&(strongChanged||weakChanged))continue;
  // Display-only results may tolerate repeated index refreshes. Actual writes
  // retain their synchronous preflight; read errors are never suppressed.
  if(strongChanged)throw Object.assign(Error('確認中にGitの状態が変わりました。最新の記録を確認してください'),{code:'GIT_READ_CHANGED'});
  if(error)throw error;return result;
 }
}
async function repoTop(dir){return fs.existsSync(dir)?attempt(dir,['rev-parse','--show-toplevel']):null;}
async function mainOf(dir){const common=await attempt(dir,['rev-parse','--path-format=absolute','--git-common-dir']),own=await attempt(dir,['rev-parse','--path-format=absolute','--git-dir']);return common&&own&&common!==own?path.dirname(common):null;}
async function isAncestor(dir,commit,descendant='HEAD'){return /^[a-f0-9]{40,64}$/.test(commit||'')&&(descendant==='HEAD'||/^[a-f0-9]{40,64}$/.test(descendant||''))&&(await attempt(dir,['merge-base','--is-ancestor',commit,descendant]))!==null;}
async function merging(dir){const own=await attempt(dir,['rev-parse','--absolute-git-dir']);return own!==null&&['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'].some(n=>fs.existsSync(path.join(own,n)));}
async function mergeTargetProblem(dir){const own=await command(dir,['rev-parse','--absolute-git-dir']);if(['BISECT_LOG','BISECT_START'].some(n=>fs.existsSync(path.join(own,n))))return 'bisect';return await attempt(dir,['symbolic-ref','-q','HEAD'])?null:'detached';}
module.exports={command,attempt,stamp,consistent,repoTop,mainOf,isAncestor,merging,mergeTargetProblem};
