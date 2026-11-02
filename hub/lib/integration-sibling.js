'use strict';
// This lane never moves, closes or overwrites the stopped integration. Only the
// separately reviewed consultation-close transaction may retire both originals.
// This lane receives reports only; it cannot authorize product code/main merge.
const fs=require('./platform/file-io'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {noLinks,exists}=require('./remove'),graph=require('../public/project-order');
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw Error(message);};
function file(h,p,t){return path.join(h.dir,'siblings',path.basename(h.file(p,t)));}
function version(r,value){Object.defineProperty(r,'siblingVersion',{value,writable:true,configurable:true});return r;}
function read(h,p,t,saving=false){
 const f=file(h,p,t);noLinks(f);
 if(!saving&&exists(path.dirname(f))&&fs.readdirSync(path.dirname(f)).some(n=>n.startsWith(path.basename(f)+'.')))fail('別の子の受領記録の保存が途中です。再送せず記録を確認してください');
 if(!exists(f))return null;
 const stat=fs.statSync(f);if(!stat.isFile()||stat.nlink!==1)fail('別の子の受領記録を確認できません');
 const bytes=fs.readFileSync(f),r=JSON.parse(bytes);if(!r.stoppedSibling||r.project!==p||r.task!==t)fail('別の子の受領記録が一致しません');return version(r,hash(bytes));
}
function save(h,r){
 require('./integration-consultation-close').assertWritable(h,r);
 const f=file(h,r.project,r.task),old=read(h,r.project,r.task);
 // Only a stop may be saved when an execution guard has become invalid.
 const withoutStop=x=>{const v=JSON.parse(JSON.stringify(x));delete v.auto.stopped;return JSON.stringify(v);};
 const onlyStop=old&&r.auto?.stopped&&!old.auto?.stopped&&withoutStop(old)===withoutStop(r);
 if(!onlyStop)assert(h,r);
 if(!Object.hasOwn(r,'siblingVersion')||(old?.siblingVersion||null)!==r.siblingVersion||old&&old.id!==r.id)fail('別の子の受領記録が更新されました。再送せず最新の記録を確認してください');
 const bytes=JSON.stringify(r,null,2),tmp=f+'.'+randomUUID(),lock=f+'.lock';noLinks(f);noLinks(tmp);noLinks(lock);fs.mkdirSync(path.dirname(f),{recursive:true});
 // Exclusive lock + CAS covers another process as well as stale UI/tick objects.
 // A failed write retains its lock/partial file and never retries automatically.
 fs.writeFileSync(lock,r.id,{flag:'wx',mode:0o600});
 if((read(h,r.project,r.task,true)?.siblingVersion||null)!==r.siblingVersion)fail('別の子の受領記録が更新されました');
 if(!onlyStop)assert(h,r);
 fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o600});fs.renameSync(tmp,f);h.pendingCache?.invalidate(f);fs.unlinkSync(lock);version(r,hash(bytes));
}
function digest(f){noLinks(f);if(!exists(f))return null;const s=fs.statSync(f);if(!s.isFile()||s.nlink!==1)fail('停止記録を確認できません');return hash(fs.readFileSync(f));}
function pin(h,r){return {id:r.id,sha256:digest(h.file(r.project,r.task)),offers:r.items.map(i=>({project:i.project,task:i.task,sha256:digest(h.transfer.file(i.project,i.task))}))};}
function original(h,p,t){
 const r=h.read(p,t);
 if(!r||r.complete||r.abandoned||!r.auto?.mode||!r.auto.stopped||!r.items?.length)fail('未完了で停止した統合だけを残せます');
 if(require('./task-continuation').pendingMain(r)||r.auto.main||Object.keys(r.auto.migrations||{}).length||r.items.some(i=>i.receipt))fail('以前の受領・本体反映の結果を確認するまで別の子を受け取れません');
 require('./task-continuation').assertNoArchive(h.dir,r);
 const a=h.ancestor(p,t,{allowBusy:true});
 if(a.target!==r.target||!h.gitw.inspect(r.target)?.head||h.gitw.merging(r.target))fail('停止記録の統合先を確認できません');
 for(const i of r.items){
  const q=a.all.find(p=>p.id===i.project),x=q?.tasks.find(t=>t.id===i.task);
  if(!x||h.removal.busy(i.project,i.task)||h.removal.locked(i.project))fail('以前の子の処理が終わるまで受け取れません');
  const queue=path.join(q.dir,'.ai/chat',i.task+'.queue.json');noLinks(queue);
  if(exists(queue)){const rows=JSON.parse(fs.readFileSync(queue,'utf8'));if(!Array.isArray(rows)||rows.length)fail('以前の子の順番待ちが残っています');}
  const receipt=h.transfer.read(i.project,i.task);if(receipt?.receiving||receipt?.integrating&&receipt.integrating!==r.id)fail('以前の子の受領結果を確認できません');
  if(i.integrated?.commit&&!h.gitw.isAncestor(r.target,i.integrated.commit))fail('以前の取り込み履歴がありません');
 }
 if(!h.siblingQuiescent?.(r))fail('以前の委任の終了を確認できません。再送せず記録を確認してください');
 return r;
}
function binding(h,p,t){return pin(h,original(h,p,t));}
function blocked(h,r){if(r&&!r.stoppedSibling&&read(h,r.project,r.task))fail('別の子の受領記録があります。以前の統合は再開せず個別に確認してください');}
function assert(h,r){
 if(!r)return;
 require('./integration-consultation-close').assertWritable(h,r);
 if(!r.stoppedSibling){blocked(h,r);return;}
 if(JSON.stringify(binding(h,r.project,r.task))!==JSON.stringify(r.stoppedSibling)||r.auto?.thenMain!==false||r.auto?.mode!=='single'||r.items.length!==1||r.target!==h.read(r.project,r.task)?.target||Object.keys(r.auto.migrations||{}).length||r.auto.order?.state!=='none'||r.auto.main&&!(r.auto.main.state==='done'&&r.auto.main.skipped===true)||Object.values(r.auto.attempts||{}).some(a=>!['review','verified','needs-review'].includes(a.phase)))fail('停止記録または別の子の受領範囲が変わりました');
 const a=h.ancestor(r.project,r.task,{allowBusy:true});
 for(const i of r.items)checkItem(h,a,h.read(r.project,r.task),i);
 for(const i of r.items)if(i.integrated?.reportProjection){if(JSON.stringify(i.integrated.reportProjection)!==JSON.stringify(i.reportProjection)||i.integrated.previousTargetHead!==i.reportProjection.targetHead||i.reportIntent?.commit!==i.integrated.commit||i.reportIntent.projection!==i.reportProjection.sha256)fail('報告の受領範囲が一致しません');require('./integration-report-projection').verify(r.target,i.reportProjection,i.integrated.commit);}
 for(const i of r.items)if(i.integrated?.commit){const paths=h.gitw.changedBetween(r.target,i.integrated.previousTargetHead,i.integrated.commit);if(paths.some(f=>!i.preview.paths.includes(f)))fail('報告以外の変更が受領範囲に含まれています');}
}
function checkItem(h,a,old,i){
 const q=a.all.find(p=>p.id===i.project),t=q?.tasks.find(t=>t.id===i.task);
 const related=(x,y)=>x.project===y.project&&x.task===y.task;
 if(!t||old.items.some(x=>related(x,i)||graph.ancestorsOf(q,t,a.all).some(y=>related(x,{project:y.project.id,task:y.task.id}))||i.descendants?.some(y=>related(x,y))))fail('停止した子とその子孫・祖先は別の受領に含められません');
 if(i.keep!==true||i.disposition==='cleanup'||i.partial||i.question||i.questionBinding||i.needsResults||i.needsRemaining||i.files.length||!i.copy||!i.source?.head||i.source.status||!Array.isArray(i.preview?.paths)||!i.preview.paths.length||i.preview.noChanges)fail('この経路では保存済みの報告だけを、子を残して受け取れます');
 // Restrict both the incoming delta and the complete saved source declaration.
 // A report's static inspection script is evidence, never executed by this lane.
 const projection=require('./integration-report-projection'),p=projection.plan(a.target,i,i.reportProjection?.targetHead);
 if(i.reportProjection&&JSON.stringify(i.reportProjection)!==JSON.stringify(p))fail('報告だけを受け取る範囲が変わりました');
 if(p)i.reportProjection=p;
 if(i.preview.conflict&&!p)fail('報告の競合を確認してください');
 const prefix='成果物/'+i.task+'/';
 if(!p&&i.preview.paths.some(f=>!f.startsWith(prefix)||!/\.(?:md|json|txt|py)$/i.test(f)||f.includes('\\')||f.split('/').some(x=>x==='..'||x==='')))fail('製品コードや実行ファイルを含む子は、この経路では受け取れません');
 const tree=require('node:child_process').execFileSync('git',['--literal-pathspecs','-C',i.copy,'ls-tree','-r','-z',i.source.head,'--',...i.preview.paths],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}}).split('\0').filter(Boolean);
 const regular=tree.map(row=>{const m=row.match(/^100644 blob [a-f0-9]+\t([\s\S]+)$/);if(!m)fail('報告以外の種類・実行権限は受け取れません');return m[1];});
 if(regular.length!==i.preview.paths.length||i.preview.paths.some(f=>!regular.includes(f)))fail('報告の削除や種類の変更は受け取れません');
 for(const f of i.preview.paths){const local=path.join(i.copy,f);noLinks(local);const st=fs.statSync(local);if(!st.isFile()||st.nlink!==1)fail('報告のリンク・種類を確認してください');}
 if(!i.results?.length||i.results.some(x=>x.kind!=='本体保存済み'||!/^body:\.@[a-f0-9]{7,64}$/.test(x.value)||x.commit!==i.source.head))fail('報告の保存履歴と成果宣言を確認してください');
}
function decorate(h,a,d,old){
 const stoppedSibling=binding(h,a.p.id,a.t.id);
 d.items=d.items.filter(i=>!old.items.some(x=>x.project===i.project&&x.task===i.task)).map(i=>{
  const next={...i,keep:true,keepLocked:true,keepLockedReason:'停止した子を残し、今回の子も残します',disposition:'continue'};
  try{checkItem(h,a,old,next);if(next.reportProjection)next.reportScope='報告'+next.reportProjection.entries.length+'件だけを受け取ります。引継ぎメモ'+next.reportProjection.excluded.length+'件は子に残します';}catch(e){next.startable=false;next.reason=e.message;}
  return next;
 });
 return {...d,sibling:true,stoppedSibling,stoppedWarning:{id:old.id,reason:old.auto.stopped.reason,items:old.items.map(i=>({title:i.title,state:i.state})),main:old.auto.main||old.auto.pendingMain||null},mainPending:d.mainPending||require('./task-continuation').pendingMain(old)};
}
module.exports={file,read,save,version,pin,binding,blocked,assert,checkItem,decorate};

// Find durable ownership even if a queued request loses its visible marker.
function requestRecords(h,o,q){
 const refs=[o.request,o.requestKey,o.integrationReviewRequest,o.limitSwitch?.sourceRequest,q?.id,q?.request,q?.integrationReviewRequest,q?.limitSwitch?.sourceRequest].filter(Boolean);
 const markers=[...String(o.limitSwitch?.original||o.text||'').matchAll(/\[integration-auto:([a-f0-9]{64}):(code|review|organize|order)\]/g)].map(m=>m[1]);
 const rows=new Map();for(const e of [{project:o.project,task:o.task},...h.pending()])for(const r of h.records(e.project,e.task))rows.set(r.id,r);
 // Retired request identities must stay guarded after the old lanes leave the
 // live directory, including a queue item stripped of its visible marker.
 for(const r of require('./integration-consultation-close').retired(h))rows.set(r.id,r);
 return [...rows.values()].filter(r=>Object.entries(r.auto?.attempts||{}).some(([k,a])=>markers.includes(k)||refs.some(id=>[a.delivery?.request,a.delivery?.queueId,'limit-'+a.delivery?.request,'limit-'+a.delivery?.queueId].includes(id))));
}
function review(h,r,a){
 assert(h,r);if(!r?.stoppedSibling)return;
 if(a.phase!=='review'||a.request?.review?.integrationId!==r.id||JSON.stringify(a.request.review.stoppedSibling)!==JSON.stringify(r.stoppedSibling)||a.request.review.targetHead!==a.targetHead||a.request.review.reviewHead!==a.reviewHead)fail('別の子の独立確認範囲が変わりました');
 const target=require('./integration-safety').target(h,{target:r.target,p:h.store.readProject(r.project)});
 if(target.status||target.head!==a.reviewHead||a.targetHead!==r.items[0].integrated?.previousTargetHead||a.reviewHead!==r.items[0].integrated?.commit)fail('別の子の独立確認範囲が変わりました');
 if(JSON.stringify(a.request.review.reportProjection||null)!==JSON.stringify(r.items[0].reportProjection||null))fail('報告の独立確認範囲が一致しません');
 h.simple.validate(r,{allowBusy:true});
}
module.exports.requestRecords=requestRecords;module.exports.review=review;

// Primary writes share the same exclusive lock so an old snapshot cannot cross
// the first sibling reservation. Legacy primary write/recovery format is kept.
function primarySave(h,r,write){
 require('./integration-consultation-close').assertWritable(h,r);
 const f=file(h,r.project,r.task),lock=f+'.lock';noLinks(f);noLinks(lock);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(lock,r.id,{flag:'wx',mode:0o600});
 try{if(read(h,r.project,r.task,true))fail('別の子の受領記録があります。以前の統合は再開せず個別に確認してください');return write();}finally{fs.unlinkSync(lock);}
}
module.exports.primarySave=primarySave;
