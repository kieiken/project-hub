'use strict';
// This is a receipt for interrupted work, not another task or an AI retry queue.
const fs=require('node:fs'),path=require('node:path');
const safe=require('./safe-file');
const file=(pdir,task)=>path.join(pdir,'.ai','chat',`${task}.unfinished.json`);
const nonempty=s=>typeof s==='string'&&Boolean(s.trim());
const statuses=new Set(['open','waiting','resuming','continued','cancelled','resolved']);
function read(pdir,task){
 const saved=safe.read(file(pdir,task));if(!saved)return {version:1,entries:{},advances:{}};
 const d=JSON.parse(saved.text);
 if(d?.version!==1||!d.entries||!d.advances||typeof d.entries!=='object'||typeof d.advances!=='object'||Array.isArray(d.entries)||Array.isArray(d.advances))throw Error('未完の依頼の記録を照合してください');
 for(const [id,e] of Object.entries(d.entries)){
  if(!nonempty(id)||!e||e.id!==id||!statuses.has(e.status)||!nonempty(e.updated)||
   e.status==='resolved'&&(!nonempty(e.resolution?.evidence)||!nonempty(e.resolution?.at)||e.updated!==e.resolution.at))throw Error('未完の依頼の記録を照合してください');
 }
 return d;
}
function update(pdir,task,fn){
 const d=read(pdir,task);fn(d);const f=file(pdir,task);fs.mkdirSync(path.dirname(f),{recursive:true});
 safe.recoverAtomic(f,JSON.stringify(d,null,2)+'\n');return d;
}
function source(o,run){return {turn:run.userRow.turn,entryId:o.unfinishedId||run.userRow.turn,request:o.request||null,text:run.userRow.handoff||o.text||run.userRow.text,images:o.images||[],at:run.userRow.at,
 project:o.project,task:o.task,pdir:o.pdir,dir:o.dir,conversation:path.join(o.pdir,'.ai','chat',`${o.task}.jsonl`),spool:run.child.dir||null,stopTicket:o.stopTicket,stopVersion:run.stopVersion};}
function entry(s,row,reason,status='open'){return {id:s.turn,status,original:s.text,partial:row?.text||'',reason,
 remaining:'未確認。元の依頼と途中成果を照合してから再開する',source:s,updated:new Date().toISOString()};}
function record(d,s,row,reason,status){const id=s.entryId||s.turn,old=d.entries[id];
 if(!old)d.entries[id]={...entry(s,row,reason,status),id};
 else{if(old.status!=='cancelled')Object.assign(old,{status,reason,updated:new Date().toISOString()});old.interruptions||=[];if(!old.interruptions.some(x=>x.source.turn===s.turn))old.interruptions.push({source:s,partial:row?.text||'',reason});}
}
function compose(mode,original,text){return mode==='redo'
 ? `（人が前の指示を取り消しました。途中で変えたファイルがあれば、必要に応じて元に戻してから、この新しい指示だけを行ってください）\n${text}`
 : `（人が追加の説明を送りました。次の元の依頼は取り消さず、途中成果を確認して続けてください）\n${original}\n\n（追加説明）\n${text}`;}
function proven(s){
 if(!s.spool)return false;const spool=require('./cli-spool');
 const req=spool.strictRead(s.spool,'request.json'),end=spool.strictRead(s.spool,'exit.json'),started=spool.strictRead(s.spool,'started.json');
 const phase=spool.strictRead(s.spool,'finalizing.json'),row=require('./chat').read(s.pdir,s.task).find(r=>r.spoolId===path.basename(s.spool)+':final');
 return Boolean(req?.options?.userRow?.turn===s.turn&&req.options.project===s.project&&req.options.task===s.task&&
  path.resolve(req.options.pdir)===path.resolve(s.pdir)&&end&&(!started||started.identity&&!started.ownershipError)&&phase?.stage==='finished'&&row&&phase.finalRowHash===spool.digest(JSON.stringify(row))&&spool.strictRead(s.spool,'finished.json')&&!spool.failure(s.spool));
}
function switches(o){return o.request?Object.values(read(o.pdir,o.task).advances).filter(a=>a.id===o.request&&a.mode!=='fifo'&&a.phase!=='done'):[];}
function verifyStopped(a){
 if(!proven(a.source))throw Error('前のAIの終了保存が未確認です。待ち指示は保留しています');
 if(a.stopVerified)return;
 const e=a.stopEvidence;
 // A durable exit result can precede the stopVerified write. Saving alone is
 // never an exit result, and historical uncertainty must not authorize signals.
 if(e?.state==='exited')return;
 const observed=e?.observed,identity=e?.identity;
 if(e?.observationComplete!==true||!identity||!Array.isArray(observed)||!observed.length||!observed.some(p=>require('./owned-processes').same(p,identity))||observed.some(p=>!Number.isSafeInteger(p?.pid)||p.pid<=1))
  throw Error('前のAIの子プロセスの終了確認記録が不足しています。保存は完了していても、待ち指示は開始していません');
 const started=require('./cli-spool').strictRead(a.source.spool,'started.json');
 if(started?.ownershipError||!require('./owned-processes').same(started?.identity,identity))throw Error('前のAIの所有記録を照合できません。待ち指示は保留しています');
 let rows;try{rows=require('./owned-processes').snapshot();}catch{throw Error('前のAIの終了確認一覧を取得できません。待ち指示は保留しています');}
 const pids=new Set(observed.map(p=>p.pid)),added=[];
 // A held descendant can fork before the next check. Retain positive parent
 // links before rejecting, so later reparenting cannot erase that observation.
 // These rows only extend exit evidence; they never become signal ownership.
 for(let changed=true;changed;){changed=false;for(const p of rows){
  if(!Number.isSafeInteger(p.pid)||p.pid<=1||p.pid===process.pid||pids.has(p.pid)||!pids.has(p.ppid))continue;
  pids.add(p.pid);added.push(p);changed=true;
 }}
 if(added.length)update(a.source.pdir,a.source.task,d=>{
  const saved=d.advances[a.source.turn].stopEvidence.observed,known=new Set(saved.map(p=>p.pid));
  for(const p of added)if(!known.has(p.pid)){saved.push(p);known.add(p.pid);}
 });
 const groups=new Set([...observed,...added].map(p=>p.pgid).filter(n=>Number.isSafeInteger(n)&&n>1));
 if(rows.some(p=>pids.has(p.pid)||groups.has(p.pgid)&&require('./owned-processes').sameOwner(p,identity)))throw Error('前のAIまたは子プロセスが残っています。待ち指示は開始していません');
}
function resolve(pdir,task,{id,expectedUpdated,evidence}){
 if(typeof evidence!=='string'||!evidence.trim()||evidence.length>4000)throw Error('完了を確認した成果と参照を記録してください');
 return update(pdir,task,d=>{const e=nonempty(id)&&Object.hasOwn(d.entries,id)?d.entries[id]:null;if(!e)throw Error('未完の依頼が見つかりません');if(!nonempty(expectedUpdated)||e.updated!==expectedUpdated)throw Error('未完の記録が変わりました。読み直して確認してください');if(e.status==='cancelled')throw Error('取り消した依頼です');e.status='resolved';e.resolution={evidence:evidence.trim(),at:new Date().toISOString()};e.updated=e.resolution.at;}).entries[id];
}
function prompt(pdir,task,port=4545){try{
 const items=Object.values(read(pdir,task).entries).filter(x=>['open','waiting','resuming'].includes(x.status));
 return items.length?`未完の依頼の記録：${file(pdir,task)}（${items.length}件）。「未完の作業は？」と聞かれたらこの記録の原文・途中成果・会話参照を読み、完了済みや取消済みを重ねて依頼しない。再開は人の指示後だけ。完了を確認した時だけ http://127.0.0.1:${port}/api/chat/unfinished/resolve に X-Hub:1（ローカル認証は curl -H @"$HUB_HEADERS" を使用。秘密を本文に書かない） / Content-Type:application/json で {project,task,id,expectedUpdated:記録のupdated,evidence:確認した成果の参照と理由} をPOSTする。記録を直接編集せず、未確認のまま完了扱いにしない。`:'';
 }catch{return `未完の依頼の記録を読めません：${file(pdir,task)}。確認せず再送・自動開始しない。`;}}

// Kept apart from process termination: no signal, ownership or stop generation is changed here.
const methods={
 prepareSwitch(p,t,id,mode,ticket){
  const run=this.busy(p,t);if(!run?.userRow||run.pending)throw Error('切り替える元の依頼を確認できません');
  const s=source(run.options,run);s.stopTicket=ticket;
  const d=read(s.pdir,t),old=Object.values(d.advances).find(a=>a.source.turn===s.turn&&a.mode!=='fifo');
  if(old){if(old.id!==id||old.mode!==mode)throw Error('前の切替を確認中です。待ち指示は残っています');return old;}
  if(!this.queue(p,t).some(q=>q.id===id))throw Error('その指示はもう待っていません');
  const a={source:s,id,mode,phase:'waiting'};update(s.pdir,t,d=>{d.advances[s.turn]=a;});return a;
 },
 continuationOptions(o){
  if(!o.pdir)return o;
  const all=switches(o);if(!all.length)return o;
  if(all.some(a=>a.phase==='started')||require('./chat').read(o.pdir,o.task).some(r=>r.role==='user'&&r.request===o.request))throw Error('この指示の開始記録があります。再送せず結果を確認してください');
  // Check every interrupted source, not just the oldest unresolved receipt or
  // the newest successful stop. No old stop history is deleted or rewritten.
  all.forEach(verifyStopped);
  // A redo cancels previous originals, while subsequent amendments retain
  // each intervening instruction and the queue's latest edited text/model.
  const redo=all.findLastIndex(a=>a.mode==='redo'),active=all.slice(Math.max(0,redo));
  let text=o.text;for(const a of [...active].reverse())text=compose(a.mode,a.source.text,text);
  const carried=active.filter(a=>a.mode==='amend'),first=carried[0];
  const images=[...new Set([...carried.flatMap(a=>a.source.images||[]),...(o.images||[])])];
  return {...o,images,text,mode:all.at(-1).mode,unfinishedId:first?(first.source.entryId||first.source.turn):undefined};
 },
 saveUnfinished(o,run,row,closed,modelRejected){
  if(o.automation||o.discussion||o.discussionTurn||o.isolatedReview||o.selectionOnly)return;
  const s=source(o,run),d=read(o.pdir,o.task),a=d.advances[s.turn];
  const unexpected=!run.stopped&&(row.error||!closed)&&!run.limit&&!run.blocked&&!modelRejected;
  if(!a&&!unexpected&&!o.unfinishedId)return;
  update(o.pdir,o.task,d=>{
   if(o.unfinishedId&&d.entries[o.unfinishedId]){
    // A continued turn is not evidence that the product task itself is complete.
    const e=d.entries[o.unfinishedId],success=!row.error&&closed;
    // A successful close is only a handoff receipt; keep an explicit resolution's revision.
    if(e.status!=='cancelled'&&!(success&&e.status==='resolved')){e.status=success?'continued':'open';e.result={request:o.request,turn:s.turn,spool:s.spool,error:row.error||(!closed?'途中で終了':'')};e.updated=new Date().toISOString();}
   }
   if(a){record(d,s,row,a.mode==='redo'?'人が前の指示を取り消しました':a.reason||'追加説明への切替で中断しました',a.mode==='redo'?'cancelled':'waiting');}
   else if(unexpected){
    // A carried request is the same unfinished work, never another failed retry.
    if(!o.unfinishedId)record(d,s,row,row.error||'AIが途中で終了しました','open');
    d.advances[s.turn]={source:s,mode:'fifo',phase:run.spawned?'waiting':'blocked',...(!run.spawned?{reason:'AIを起動できませんでした。導入状態を確認してから再開してください'}:{})};
   }
  });
 },
 queuedOptions(b,next){return {...b,...Object.fromEntries(['automation','contextMode','freshContext','preserveTaskState','reviewKind','origin','integrationAssignment','limitPolicy','isolatedReview','selectionOnly','integrationReviewRequest','readOnly','readDirs','role','limitSlot','limitSwitch','requiredModel'].map(k=>[k,next[k]])),
  resultsOrganize:Boolean(next.resultsOrganize),ai:next.ai,account:next.account||'default',model:next.model,effort:next.effort,text:next.text,perm:next.perm,requireModel:Boolean(next.requireModel),
  images:b.project==='freetalk'&&next.ai==='codex'?next.images||[]:[],mode:'queued',shown:next.shown||next.text,request:next.id,started:undefined,noEffort:false,unfinishedId:undefined};},
 continuationNotice(o,a,text){
  const chat=require('./chat');const row=chat.append(o.pdir,o.task,{role:'event',continuation:{id:a.source.entryId||a.source.turn,file:file(o.pdir,o.task)},text});this.emit(o.project,o.task,{type:'row',row});
 },
 launchAdvance(a,b,automatic=true){
  this.continuationStarts||=new Map();const key=this.key(b.project,b.task)+'\0'+a.source.turn;
  if(this.continuationStarts.has(key))return this.continuationStarts.get(key);
  const work=(async()=>{
   const d=read(b.pdir,b.task),current=d.advances[a.source.turn],entryId=a.source.entryId||a.source.turn;
   if(!current||!['waiting','blocked'].includes(current.phase))throw Error('この切替は既に受け付けています');
   if(a.liveRun?.stopResultP&&a.mode!=='fifo'){
    const stopped=await a.liveRun.stopResultP;
    update(b.pdir,b.task,d=>{d.advances[a.source.turn].stopEvidence={state:stopped.state,save:stopped.save,errors:stopped.errors||[],identity:stopped.identity,observed:stopped.observed,tracked:stopped.tracked,observationComplete:stopped.observationComplete};});
    if(stopped.state!=='exited'){
     if(!stopped.observationComplete||!proven(a.source))throw Error('前のAIの終了・所有を確認できません。待ち指示は保留しています');
     verifyStopped(read(b.pdir,b.task).advances[a.source.turn]);
    }
    update(b.pdir,b.task,d=>{d.advances[a.source.turn].stopVerified=true;});
    a={...a,stopVerified:true};
   }
   if(a.mode!=='fifo'&&!a.stopVerified)verifyStopped(a);
   if(!proven(a.source)&&!a.liveFinished)throw Error('前のAIの終了・保存を確認できません。待ち指示は保留しています');
   if(automatic){this.stopControl?.assert(b,a.source.stopTicket);if(this.stopControl?.held(b))throw Error('停止後の指示は保留しています');if(this.stops.has(this.key(b.project,b.task))&&this.stops.get(this.key(b.project,b.task))!==a.source.stopVersion)throw Error('停止後の指示は保留しています');}
   await this.assertHandoffReadyAsync(b.project,b.task);
   const latest=read(b.pdir,b.task).advances[a.source.turn];
   if(!latest||!['waiting','blocked'].includes(latest.phase))throw Error('この切替は既に受け付けています');
   if(!proven(a.source)&&!a.liveFinished)throw Error('前のAIの終了・保存を確認できません。待ち指示は保留しています');
   if(automatic){this.stopControl?.assert(b,a.source.stopTicket);if(this.stopControl?.held(b)||this.stops.has(this.key(b.project,b.task))&&this.stops.get(this.key(b.project,b.task))!==a.source.stopVersion)throw Error('停止後の指示は保留しています');}
   this.startBarrier?.(b);
   if(this.busy(b.project,b.task))throw Error('別の指示の開始・終了を確認中です');
   let q=this.queue(b.project,b.task);
   // A durable user row is evidence of a start attempt, including an unknown or failed outcome.
   // Never replay it after a response loss or a crash between start and queue removal.
   const rows=require('./chat').read(b.pdir,b.task);
   const checkStarted=id=>{if(id&&rows.some(r=>r.role==='user'&&r.request===id)){
    update(b.pdir,b.task,d=>{Object.assign(d.advances[a.source.turn],{id,phase:'started'});});throw Error('この指示の開始記録があります。再送せず結果を確認してください');
   }};
   checkStarted(a.id);
   if(a.mode==='fifo'){
    if(q[0]?.id===a.source.request){this.unqueue(b.project,b.task,q[0].id,true);q=this.queue(b.project,b.task);}
    a={...a,id:q[0]?.id};
   }
   let next=q.find(x=>x.id===a.id);
   if(!next&&a.mode!=='fifo'&&q.length){
    // A cancelled additional explanation must not be resurrected or merged.
    // Keep the interrupted original open, then continue the remaining FIFO.
    update(b.pdir,b.task,d=>{Object.assign(d.advances[a.source.turn],{mode:'fifo',id:q[0].id,cancelledOriginal:a.mode==='redo'});if(a.mode==='amend'&&d.entries[entryId])d.entries[entryId].status='open';});
    a={...a,cancelledOriginal:a.mode==='redo',mode:'fifo',id:q[0].id};next=q[0];
   }
   if(!next||next.stopHeld){update(b.pdir,b.task,d=>{d.advances[a.source.turn].phase='done';if(d.entries[entryId]?.status==='waiting')d.entries[entryId].status='open';});this.continuationNotice(b,a,a.mode==='redo'?'前の依頼の取消を記録しました。':'未完の依頼を記録しました。「未完の作業は？」で確認できます。');return null;}
   // FIFO and cancelled cutovers select their final request after the original check.
   checkStarted(next.id);
   if(next.error&&automatic)throw Error('開始できなかった待ち指示は、人の確認を待っています');
   update(b.pdir,b.task,d=>{d.advances[a.source.turn].id=next.id;if(a.mode==='amend'&&d.entries[entryId])Object.assign(d.entries[entryId],{status:'resuming',resumedBy:next.id});});
   const r=await this.sendQueued(this.queuedOptions(b,next));
   if(!(await r.started))throw Error('AIを起動できませんでした。待ち指示を保留しています');
   update(b.pdir,b.task,d=>{d.advances[a.source.turn].phase='started';});
   this.unqueue(b.project,b.task,next.id,true);
   this.continuationNotice(b,a,a.mode==='redo'||a.cancelledOriginal?'前の依頼を取り消し、次の指示を開始しました。':a.mode==='amend'?'中断した依頼を記録し、追加説明と合わせて続けています。':'未完の依頼を記録し、次の指示を開始しました。');
   return r;
  })();
  this.continuationStarts.set(key,work);
  work.finally(()=>{const timer=setTimeout(()=>this.continuationStarts.delete(key),30000);timer.unref?.();}).catch(()=>{});
  // A failure is retained, not automatically retried by the HTTP and completion paths.
  work.catch(e=>{if(e.code==='restore-barrier'){this.continuationStarts.delete(key);this.deferredDispatches.set(key,()=>this.launchAdvance(a,b,automatic).catch(()=>{}));return;}try{update(b.pdir,b.task,d=>{const adv=d.advances[a.source.turn],entry=d.entries[a.source.entryId||a.source.turn];if(adv?.phase==='waiting'){adv.phase='blocked';adv.reason=e.message;}if(['waiting','resuming'].includes(entry?.status))entry.status='open';});this.continuationNotice(b,a,`待ち指示は保留しています：${e.message}`);}catch{/* Saving failed: keep the original durable intent and do not start. */}});
  return work;
 },
 dispatchAdvance(o,run){
  const a=read(o.pdir,o.task).advances[run.userRow.turn];if(!a||a.phase!=='waiting')return false;
  if(!run.finished||run.spoolError||run.limitSaveFailed)return true;
  const b=this.base.get(this.key(o.project,o.task))||o;
  this.launchAdvance({...a,liveRun:run,liveFinished:!run.supervised&&run.finished&&!run.ownershipError},b).catch(()=>{});return true;
 },
 recoverContinuations(p,t){
  const d=read(p.dir,t.id);for(const a of Object.values(d.advances)){
   if(a.phase!=='waiting'||!a.source.spool||!proven(a.source))continue;
   const req=require('./cli-spool').strictRead(a.source.spool,'request.json');
   // Resolve current location through the same queued refresh/start barriers as a live turn.
   const b={...req.options,onEnd:row=>this.onAdoptEnd?.(req.options,row)};
   if(path.resolve(b.pdir)!==path.resolve(p.dir)||b.project!==p.id||b.task!==t.id)continue;
   this.launchAdvance(a,b).catch(()=>{});
  }
 }
};
module.exports={file,read,update,source,proven,prompt,compose,resolve,methods};
