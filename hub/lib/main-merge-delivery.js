'use strict';
// One durable identity per confirmed main merge. Absence alone never proves not sent.
const fs=require('node:fs'),path=require('node:path'),safe=require('./safe-file'),check=require('./main-merge-check');
const {execFileSync}=require('node:child_process');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const head=x=>typeof x==='string'&&/^[a-f0-9]{40,64}$/.test(x);
const snapshot=x=>x&&head(x.head)&&typeof x.branch==='string'&&typeof x.status==='string'&&/^[a-f0-9]{64}$/.test(x.content||'');
function valid(r,id){
 return r&&r.id===id&&uuid.test(id)&&['project','task','sourceDir','targetDir'].every(k=>typeof r[k]==='string'&&r[k])&&path.isAbsolute(r.sourceDir)&&path.isAbsolute(r.targetDir)&&snapshot(r.source)&&snapshot(r.target)&&['unknown','applied','aborted','not-sent'].includes(r.state)&&typeof r.at==='string'&&Number.isFinite(Date.parse(r.at))&&(!r.commit||head(r.commit))&&(r.state!=='applied'||head(r.commit))&&(r.alias===undefined||(typeof r.alias==='string'&&uuid.test(r.alias)&&r.alias!==id&&r.state==='unknown'&&!r.commit&&!r.flow))&&(!r.flow||(r.flow.keep===true&&typeof r.flow.restart==='boolean'&&typeof r.flow.version==='string'&&(!r.flow.restart||/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(r.flow.version))&&typeof r.flow.instance==='string'&&r.flow.instance&&['approved','waiting','switching','complete','blocked'].includes(r.flow.stage)&&(!['waiting','switching','complete'].includes(r.flow.stage)||(r.state==='applied'&&head(r.commit)))&&(!['waiting','switching'].includes(r.flow.stage)||typeof r.flow.sentInstance==='string')));
}
class MainMergeDelivery {
 constructor(root,gitw,log){this.root=root;this.dir=path.join(root,'_hub','main-merge-delivery');this.git=gitw;this.log=log;}
 file(id){if(!uuid.test(id||''))throw Error('取り込みの送信番号を確認できません');return path.join(this.dir,id+'.json');}
 raw(id){const raw=safe.read(this.file(id));if(!raw)return null;const r=JSON.parse(raw.text);if(!valid(r,id))throw Error('取り込みの送信記録が破損しています');return r;}
 read(id){const r=this.raw(id);if(r?.alias)this.aliasTarget(r);return r;}
 aliasTarget(r){const target=this.raw(r.alias);if(!target?.flow||target.alias||['project','task','sourceDir','targetDir','source','target'].some(k=>!same(r[k],target[k])))throw Error('取り込みの送信番号と確認範囲が一致しません');return target;}
 resolve(id){const r=this.read(id);return r?.alias?this.aliasTarget(r):r;}
 link(id,scope,canonicalId){
  const target=this.read(canonicalId);if(!target?.flow||target.alias||['project','task','sourceDir','targetDir','source','target'].some(k=>!same(scope[k],target[k])))throw Error('取り込みの送信範囲が一致しません');
  // Save the second approved identity before replying; it never owns a second flow or Git send.
  return this.start(id,{...scope,alias:canonicalId});
 }
 start(id,scope){
  fs.mkdirSync(this.dir,{recursive:true});
  if(this.read(id))throw Error('この取り込みは送信済みです。結果を照合してください');
  const r={...scope,id,state:'unknown',at:new Date().toISOString()};if(!valid(r,id))throw Error('取り込みの送信範囲を確認できません');safe.atomic(this.file(id),JSON.stringify(r));return r;
 }
 finish(id,result){
  const r=this.read(id);if(!r)throw Error('取り込みの送信記録がありません');
  const next={...r,...result,finished:new Date().toISOString()};if(!valid(next,id))throw Error('取り込みの結果を確認できません');safe.atomic(this.file(id),JSON.stringify(next));
 }
 missingStatus({project,task,sourceDir,targetDir,id,mainMergeTokens}){
  // Only the HTTP status route supplies the live token registry. No receipt means
  // not-sent only when this identity cannot still reach the synchronous start().
  if(!(mainMergeTokens instanceof Map))return {state:'unknown'};
  const token=mainMergeTokens.get(id);
  if(mainMergeTokens.has(id)&&!token)return {state:'unknown'};
  if(token&&(!Number.isFinite(token.at)||Date.now()-token.at<=600000||token.project!==project||token.task!==task||token.targetDir!==targetDir||!snapshot(token.target)))return {state:'unknown'};
  if(fs.existsSync(this.dir))for(const name of fs.readdirSync(this.dir)){
   if(name.endsWith('.json.tmp'))return {state:'unknown'};
   if(!name.endsWith('.json'))continue;
   const r=this.read(name.slice(0,-5));
   if(!r||r.id===id||r.alias===id)return {state:'unknown'};
  }
  if(this.unresolved({project,task,sourceDir,targetDir}))return {state:'unknown'};
  const target=check.check(this.git,targetDir,'target');
  if(target.blocker||!snapshot(target.snapshot)||token&&!same(target.snapshot,token.target))return {state:'unknown'};
  return {state:'not-sent',requestId:id};
 }
 readAsync(method,scope){return require('./integration-read-worker').run('delivery.'+method,{root:this.root,log:this.log,scope:{...scope,mainMergeTokens:undefined},tokens:[...(scope.mainMergeTokens||[])]},{dirs:[scope.sourceDir,scope.targetDir].filter(Boolean)});}
 statusAsync(scope){return this.readAsync('status',scope);}
 legacyAsync(scope){return this.readAsync('legacy',scope);}
 unresolvedAsync(scope){return this.readAsync('unresolved',scope);}
 status({project,task,sourceDir,targetDir,id,mainMergeTokens}){
  try{
   const r=this.resolve(id);if(!r)return this.missingStatus({project,task,sourceDir,targetDir,id,mainMergeTokens});
   if(r.project!==project||r.task!==task||r.sourceDir!==sourceDir||r.targetDir!==targetDir)return {state:'unknown'};
   const source=check.check(this.git,sourceDir,'source'),target=check.check(this.git,targetDir,'target');
   if(source.blocker||target.blocker)return {state:'unknown'};
   if(['aborted','not-sent'].includes(r.state)&&same(target.snapshot,r.target))return {state:r.state,requestId:id};
   // Even a crash after the Git commit is safe to identify as reflected, but never as aborted.
   if(this.git.isAncestor(targetDir,r.source.head)&&this.git.isAncestor(targetDir,r.target.head))return {state:'applied',requestId:id};
  }catch{}
  return {state:'unknown'};
 }
 unresolved(scope){
  try{
   if(!fs.existsSync(this.dir))return false;
   for(const name of fs.readdirSync(this.dir)){
    if(name.endsWith('.json.tmp'))return true;
    if(!name.endsWith('.json'))continue;const r=this.read(name.slice(0,-5));if(!r)return true;
    if(r?.project===scope.project&&r.task===scope.task&&r.state==='unknown'&&this.status({...scope,id:r.id}).state==='unknown')return true;
   }return false;
  }catch{return true;}
 }
 flows(scope){
  if(!fs.existsSync(this.dir))return [];
  return fs.readdirSync(this.dir).filter(n=>n.endsWith('.json')).map(n=>this.read(n.slice(0,-5))).filter(r=>r?.flow&&r.project===scope.project&&r.task===scope.task&&r.sourceDir===scope.sourceDir&&r.targetDir===scope.targetDir).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 }
 latest(project,task){
  for(const file of [this.log,this.log.replace(/\.jsonl$/,'.old.jsonl')]){
   let lines;try{lines=fs.readFileSync(file,'utf8').trim().split('\n');}catch(e){if(e.code==='ENOENT')continue;throw e;}
   for(let i=lines.length-1;i>=0;i--){let r;try{r=JSON.parse(lines[i]);}catch{continue;}if(r.action==='merge'&&r.project===project&&r.task===task)return r;}
  }return null;
 }
 legacy({project,task,sourceDir,targetDir,abortAt,confirm,sourceHead,targetHead}){
  // Legacy strings have no send identity. Never silently associate them with an old failure.
  // A reflected current source is conclusive; an abort needs explicit association and reset evidence.
  try{
   const source=check.check(this.git,sourceDir,'source'),target=check.check(this.git,targetDir,'target');
   if(source.blocker||target.blocker)return {state:'unknown'};
   const r=this.latest(project,task);if(!r)return {state:'unknown'};
   if(r.ok===true&&r.main===targetDir&&this.git.isAncestor(targetDir,r.commit)&&this.git.isAncestor(targetDir,source.snapshot.head,r.commit))return {state:'applied'};
   if(this.unresolved({project,task,sourceDir,targetDir}))return {state:'unknown'};
   if(r.ok!==false||r.conflict!==true||!Number.isFinite(Date.parse(r.at)))return {state:'unknown'};
   const rows=execFileSync('git',['-C',targetDir,'reflog','-2','--date=unix','--format=%H%x00%gD%x00%gs'],{encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim().split('\n').map(x=>x.split('\0'));
   const [last,prior]=rows,when=Number(last?.[1]?.match(/@\{(\d+)\}/)?.[1])*1000;
   if(last?.[2]!=='reset: moving to HEAD'||last[0]!==target.snapshot.head||prior?.[0]!==last[0]||when>Date.parse(r.at)||Date.parse(r.at)-when>5000)return {state:'unknown'};
   const recovery={at:r.at,sourceHead:source.snapshot.head,targetHead:target.snapshot.head};
   // Candidate only: no clear and no merge. Caller must identify this as the stopped legacy attempt.
   if(confirm!==true||abortAt!==r.at||sourceHead!==source.snapshot.head||targetHead!==target.snapshot.head)return {state:'unknown',recovery};
   return {state:'aborted',legacyAt:r.at};
  }catch{return {state:'unknown'};}
 }
}
module.exports={MainMergeDelivery};
