'use strict';
// Continue the approved delivery; polling never sends another Git merge.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const check=require('./main-merge-check');
class MainMergeFlow {
 constructor({ledger,git,runtime,restart,keep}){Object.assign(this,{ledger,git,runtime,restart,keep});this.sent=new Set();}
 approval({sourceDir,targetDir,source,target}){
  const rt=this.runtime(),alreadyIncluded=this.git.isAncestor(targetDir,source.head,target.head),switchHub=path.resolve(targetDir)===path.resolve(rt.targetDir);
  // Git's already-included success keeps the target HEAD, even when preview.noChanges is false.
  const switchHead=alreadyIncluded?target.head:source.head;
  const switchVersion=switchHub?JSON.parse(execFileSync('git',['-C',alreadyIncluded?targetDir:sourceDir,'show',switchHead+':hub/package.json'],{encoding:'utf8',stdio:'pipe'})).version:'';
  return {alreadyIncluded,switchHub,switchHead,switchVersion,switchNeeded:switchHub&&(!alreadyIncluded||rt.bootHead!==switchHead||rt.version!==switchVersion)};
 }
 readAsync(method,...call){
  const first=call[0]||{},dirs=[first.sourceDir,first.targetDir].filter(Boolean);
  return require('./integration-read-worker').run('flow.'+method,{root:this.ledger.root||path.dirname(path.dirname(this.ledger.dir)),log:this.ledger.log,runtime:this.runtime(),restart:['status','blockedCompletion'].includes(method)?this.restart().status():null,call},{dirs});
 }
 approvalAsync(scope){return this.readAsync('approval',scope);}
 appliedAsync(r){return this.readAsync('applied',r);}
 statusAsync(scope,id){return this.readAsync('status',scope,id);}
 versionAtAsync(r){return this.readAsync('versionAt',r);}
 records(){if(!fs.existsSync(this.ledger.dir))return [];return fs.readdirSync(this.ledger.dir).filter(n=>n.endsWith('.json')).map(n=>this.ledger.read(n.slice(0,-5))).filter(r=>r?.flow);}
 blockers(targetDir){try{return this.records().filter(r=>r.targetDir===targetDir&&r.flow.stage!=='complete'&&!['aborted','not-sent'].includes(r.state)).map(()=>({kind:'main-flow',message:'前回の取り込みから新版の確認までが未完了です。取り込みは送り直しません。'}));}catch{return [{kind:'main-flow',message:'取り込み記録の照合が必要です。再送しません。'}];}}
 write(r,flow,extra={}){this.ledger.finish(r.id,{...extra,flow:{...r.flow,...flow}});return this.ledger.read(r.id);}
 applied(r){
  const target=check.check(this.git,r.targetDir,'target');if(target.blocker)throw Error('本体の保存状態を確認できません。取り込みは送り直しません。');
  const current=target.snapshot.head;
  if(!this.git.isAncestor(r.targetDir,r.source.head)||!this.git.isAncestor(r.targetDir,r.target.head))return null;
  if(r.commit){if(current!==r.commit)throw Error('取り込み後に本体が変わりました。新版への切替を止めています。');return current;}
  // Recover only the recorded no-op or this exact two-parent merge, never an arbitrary later HEAD.
  if(current===r.target.head)return current;
  const parents=execFileSync('git',['-C',r.targetDir,'show','-s','--format=%P',current],{encoding:'utf8',stdio:'pipe'}).trim().split(' ');
  if(parents.length===2&&parents[0]===r.target.head&&parents[1]===r.source.head)return current;
  throw Error('反映はありますが、今回の保存を特定できません。取り込みは送り直しません。');
 }
 status(scope,id){
  try{
   const r=id?this.ledger.resolve(id):this.ledger.flows(scope)[0];
   if(!r)return {stage:'ready'};
   if(!r.flow||['project','task','sourceDir','targetDir'].some(k=>r[k]!==scope[k]))return {stage:'unknown',error:'取り込みの送信範囲が一致しません。再送しません。'};
   const base={requestId:id||r.id,sourceHead:r.source.head,targetHead:r.target.head,commit:r.commit,version:r.flow.version,retained:true,restart:r.flow.restart};
   if(['aborted','not-sent'].includes(r.state))return {...base,stage:'stopped',delivery:this.ledger.status({...scope,id:r.id})};
   if(r.flow.stage==='complete')return this.git.isAncestor(r.targetDir,r.commit)&&this.git.isAncestor(r.targetDir,r.source.head,r.commit)&&this.git.isAncestor(r.targetDir,r.target.head,r.commit)?{...base,stage:'complete',applied:true}:{...base,stage:'unknown',error:'完了後の保存履歴を照合できません。再送しません。'};
   let applied=false;try{applied=Boolean(this.applied(r));}catch(e){return {...base,stage:'blocked',applied:r.state==='applied',error:e.message};}
   return {...base,stage:applied?r.flow.stage:'unknown',applied,error:r.flow.error||'',waiting:r.flow.stage==='waiting'?this.restart().status().waiting:[]};
  }catch{return {stage:'unknown',error:'取り込みの送信記録を確認できません。再送しません。'};}
 }
 verifyRestart(){
  const rt=this.runtime();
  for(const r of this.records())if(r.flow.restart&&r.flow.stage!=='complete'&&r.flow.sentInstance===rt.instance){
   if(this.applied(r)!==r.commit||path.resolve(r.targetDir)!==path.resolve(rt.targetDir)||rt.updatePending)throw Error('新版への切替範囲が変わりました。取り込みは送り直しません。');
   if(this.versionAt(r)!==r.flow.version)throw Error('切替先の版が確認した内容と一致しません。');
  }
 }
 versionAt(r){return JSON.parse(execFileSync('git',['-C',r.targetDir,'show',r.commit+':hub/package.json'],{encoding:'utf8',stdio:'pipe'})).version;}
 blockedCandidate(r){
  // Recover only the old ordinary-AI-wait failure, never a verification failure
  // or an uncertain merge. This path records an existing success; it cannot send.
  const rt=this.runtime(),restart=this.restart().status();
  return r.state==='applied'&&r.flow.stage==='blocked'&&r.flow.restart&&Boolean(r.commit)&&r.flow.error==='AIの作業が終わるまで更新できません。'&&r.flow.sentInstance===r.flow.instance&&
   Boolean(rt.instance)&&rt.instance!==r.flow.instance&&rt.targetDir===r.targetDir&&rt.updatePending===false&&rt.bootHead===r.commit&&rt.version===r.flow.version&&
   restart.reserved===null&&restart.committed===false&&restart.error==='';
 }
 blockedCompletion(r){
  if(!this.blockedCandidate(r))return null;
  const rt=this.runtime();
  if(this.applied(r)!==r.commit||this.versionAt(r)!==r.flow.version)return null;
  const parents=execFileSync('git',['-C',r.targetDir,'show','-s','--format=%P',r.commit],{encoding:'utf8',stdio:'pipe'}).trim().split(' ');
  if(r.commit!==r.target.head&&(parents.length!==2||parents[0]!==r.target.head||parents[1]!==r.source.head))return null;
  return {commit:r.commit,version:r.flow.version,instance:rt.instance};
 }
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try {
  let rows;try{rows=this.records();}catch{return;}
  for(let r of rows){
   if(r.flow.stage==='complete'||['aborted','not-sent'].includes(r.state))continue;
   if(r.flow.stage==='blocked'){
    try{
     if(!this.blockedCandidate(r))continue;
     const before=JSON.stringify(r),rt=JSON.stringify(this.runtime()),restart=JSON.stringify(this.restart().status());
     const proof=await this.readAsync('blockedCompletion',r);
     // The worker is a preflight, not permission to write from a stale read.
     // Repeat the exact check synchronously at the durable-record boundary.
     if(proof&&JSON.stringify(this.blockedCompletion(r))===JSON.stringify(proof)&&JSON.stringify(this.ledger.read(r.id))===before&&JSON.stringify(this.runtime())===rt&&JSON.stringify(this.restart().status())===restart)
      this.write(r,{stage:'complete',error:'',recovery:{...proof,at:new Date().toISOString(),previousFlow:r.flow,previousFinished:r.finished}});
    }catch{/* Keep the original blocked receipt on any unknown or changed input. */}
    continue;
   }
   try{
    const before=JSON.stringify(r);let commit;try{commit=await this.appliedAsync(r);}catch(e){if(JSON.stringify(this.ledger.read(r.id))!==before)continue;throw e;}if(JSON.stringify(this.ledger.read(r.id))!==before||!commit)continue;
    if(!r.commit)r=this.write(r,{}, {state:'applied',commit});
    this.keep(r); // Idempotent retained task update, including recovery after Git success.
    if(!r.flow.restart){this.write(r,{stage:'complete'});continue;}
    let rt=this.runtime();
    if(path.resolve(r.targetDir)!==path.resolve(rt.targetDir)||rt.updatePending)throw Error('Hubの切替先が変わりました。取り込みは送り直しません。');
    const beforeVersion=JSON.stringify(r);let version;try{version=await this.versionAtAsync(r);}catch(e){if(JSON.stringify(this.ledger.read(r.id))!==beforeVersion)continue;throw e;}if(JSON.stringify(this.ledger.read(r.id))!==beforeVersion)continue;
    rt=this.runtime();if(path.resolve(r.targetDir)!==path.resolve(rt.targetDir)||rt.updatePending)throw Error('Hubの切替先が変わりました。取り込みは送り直しません。');
    if(version!==r.flow.version)throw Error('切替先の版が確認した内容と一致しません。');
    if(rt.bootHead===r.commit&&rt.version===r.flow.version){this.write(r,{stage:'complete'});continue;}
    if(rt.instance!==r.flow.instance)throw Error('起動した保存または版が一致しません。取り込みは送り直しません。');
    if(['switching','waiting'].includes(r.flow.stage)){
     const s=this.restart().status();if(s.error||(!s.committed&&!s.reserved))throw Error(s.error||'新版への切替が停止しました。取り込みは反映済みです。');
     continue;
    }
    if(this.sent.has(r.id))continue;
    // Durable switch intent precedes the existing reservation, just as the merge intent precedes Git.
    r=this.write(r,{stage:'switching',sentInstance:rt.instance});this.sent.add(r.id);
    const result=this.restart().request(true);
    if(result.reserved)this.write(r,{stage:'waiting'});
   }catch(e){try{const restart=this.restart();if(r.flow.sentInstance===this.runtime().instance&&restart.status().reserved&&!restart.status().committed)restart.cancel();this.write(r,{stage:'blocked',error:e.message});}catch{/* preserve the last durable intent */}}
  }
  }finally{this.ticking=false;}
 }
}
module.exports={MainMergeFlow};
