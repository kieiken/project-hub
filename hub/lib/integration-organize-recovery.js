'use strict';
// A closed organizer can fail declaration validation without being cancelled.
// Keep that delivery immutable; a human may authorize one distinct repair.
const {createHash}=require('node:crypto'),fs=require('node:fs');
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const base=(r,a)=>hash(r.id+'\0'+a.project+'\0'+a.task+'\0organize');
const next=(r,k)=>hash(r.id+'\0'+k+'\0organize-format-repair-v1');
const fail=()=>{throw Error('整理の正常終了と検査停止の証拠を確認できません。再送せず最新の記録を確認してください');};
function key(r,k,a){
  if(k===base(r,a))return true;
  const old=r.auto.attempts[a.organizeRepair?.previous];
  return Boolean(old&&!old.organizeRepair&&old.phase==='superseded'&&old.supersededBy===k&&old.project===a.project&&old.task===a.task&&old.organizeFailure&&k===next(r,a.organizeRepair.previous));
}
function identity(r,k,a,row){
  const m=row?.integrationAuto;
  if(!key(r,k,a)||!a.request||a.delivery?.state!=='accepted'||!a.delivery.request||row?.request!==a.delivery.request||row.error||row.asks?.length||m?.key!==k||m.phase!=='organize'||m.closed!==true||m.limit||!String(a.request.text||'').startsWith(`[integration-auto:${k}:organize]`)||a.request.project!==a.project||a.request.task!==a.task)fail();
  require('./integration-assignment').completion(r,a,row);
  return {requestHash:hash(a.request),deliveryHash:hash(a.delivery),completionHash:hash(row)};
}
function history(r,k,a,row){
  const proof=a.organizeFailure;
  if(!proof||a.phase!=='superseded'||a.organizeRepair||a.supersededBy!==next(r,k)||!r.auto.attempts[a.supersededBy]?.organizeRepair||JSON.stringify(identity(r,k,a,row))!==JSON.stringify(proof.identity))fail();
  return proof;
}
function failure(h,r,k,a,row){
  const id=identity(r,k,a,row);
  if(r.complete||r.abandoned||r.auto.prepared||r.auto.main||Object.keys(r.auto.migrations||{}).length||r.items.some(i=>i.receipt||i.integrated||i.merge||!['待ち','整理中'].includes(i.state)))fail();
  const stop=r.auto.stopped||r.auto.stopHistory?.findLast(s=>s.code==='ORGANIZE_DECLARATION_INVALID'||s.reason==='子の整理後の保存・成果・残件申告を確認できません');
  if(!stop||(stop.code!=='ORGANIZE_DECLARATION_INVALID'&&stop.reason!=='子の整理後の保存・成果・残件申告を確認できません'))fail();
  const p=h.store.readProject(a.project),file=h.store.taskFile(a.project,a.task),t=file&&h.store.readTask(file),dir=t?.workdir||p&&h.baseOf(p),saved=row.integrationAuto.saved,canonical=require('./resource-scope').canonical;
  const source=dir&&require('./integration-writes').inspect(h.gitw,dir);
  if(!dir||!saved?.dir||canonical(saved.dir)!==canonical(dir)||!/^[a-f0-9]{40}$/.test(saved.head||'')||source?.head!==saved.head||source.status||h.gitw.merging(dir))fail();
  let error;try{h.simple.organizedItem(r,{...a,phase:'organize'},row);}catch(e){error=e;}
  if(error?.code!=='ORGANIZE_DECLARATION_INVALID')fail();
  return {version:1,identity:id,taskHash:hash(fs.readFileSync(file,'utf8')),saved,reason:error.message,stop};
}
function repair(h,r,k,a,row){
  if(a.organizeRepair||r.auto.attempts[next(r,k)])throw Error('この整理のやり直しは依頼済みです。再送せず、中止して選び直してください');
  return failure(h,r,k,a,row);
}
// Abandonment receives nothing. A later saved child may fix its declaration;
// re-running today's declaration validator cannot prove yesterday's stop.
// Keep repair() strict and use this proof only for an explicit human abort,
// before simple integration has ever created any child reservation.
function abandonFailure(h,r,k,a,row){
  try{return failure(h,r,k,a,row);}catch(error){
    const id=identity(r,k,a,row),stop=r.auto.stopped;
    if(!r.auto.mode||r.complete||r.abandoned||r.auto.prepared||r.auto.main||Object.keys(r.auto.migrations||{}).length||stop?.code!=='ORGANIZE_DECLARATION_INVALID'||stop.stage!=='organize-validation'||!Number.isFinite(Date.parse(row.at))||!Number.isFinite(Date.parse(stop.at))||Date.parse(stop.at)<Date.parse(row.at))throw error;
    if(r.items.some(i=>i.partial||i.previous||i.previousHead||i.increment||i.receipt||i.integrated||i.merge||!['待ち','整理中'].includes(i.state)||h.transfer.read(i.project,i.task)!==null))throw error;
    const context=h.ancestor(r.project,r.task,{allowBusy:true}),p=context.all.find(p=>p.id===a.project),t=p?.tasks.find(t=>t.id===a.task),i=r.items.find(i=>i.project===a.project&&i.task===a.task);
    if(!i||!h.simple.related(context,p,t)||t.question||t.integrateKeep!==i.choiceAtStart||context.target!==r.target)throw error;
    const file=h.store.taskFile(a.project,a.task),dir=t.workdir||h.baseOf(p),saved=row.integrationAuto.saved,canonical=require('./resource-scope').canonical;
    const source=require('./integration-writes').inspect(h.gitw,dir);
    if(!saved?.dir||canonical(saved.dir)!==canonical(dir)||!/^[a-f0-9]{40}$/.test(saved.head||'')||!source?.head||source.status||h.gitw.merging(dir)||!h.gitw.isAncestor(dir,saved.head,source.head))throw error;
    // Pin both today's task bytes and Git state through preview -> confirm.
    // IntegrationAbandon independently proves all deliveries, completions,
    // queues, archives and absence of receipts before using this result.
    return {version:2,kind:'stopped-before-reservation',identity:id,taskHash:hash(fs.readFileSync(file,'utf8')),saved,source,stop};
  }
}
module.exports={key,next,failure,history,repair,abandonFailure};
