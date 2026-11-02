'use strict';
// A display/integration choice, separate from the task/receipt originals. In
// particular, holding then releasing a stopped integration must not rewrite its
// approved task hash, source, receipt or replay guards.
const fs=require('./platform/file-io'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const graph=require('../public/project-order'),continuation=require('./task-continuation');
const {noLinks,readNoLinks,exists}=require('./remove'),{lt}=require('./locale');
const key=(p,t)=>p+'\0'+t;
const message=()=>lt('将来検討として保留中です。子作業で保留を解除してから統合してください');
function file(root,project,task){return path.join(root,'_hub/task-future-holds',createHash('sha256').update(key(project,task)).digest('hex')+'.json');}
function read(root,project,task){
  const f=file(root,project,task);
  try{
    readNoLinks(f);if(!exists(f))return {};
    const stat=fs.statSync(f),r=JSON.parse(fs.readFileSync(f,'utf8'));
    if(!stat.isFile()||stat.nlink!==1||r?.version!==1||r.project!==project||r.task!==task||typeof r.held!=='boolean'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.revision||'')||!Array.isArray(r.history))throw Error('invalid hold record');
    return {futureHold:r.held,futureHoldRevision:r.revision};
  }catch{return {futureHoldError:lt('将来検討の保留記録を確認できません。記録を確認するまで統合しません')};}
}
function scope(p,t,all){return t?[{project:p,task:t},...graph.ancestorsOf(p,t,all)]:[];}
function reason(p,t,all){
  const rows=scope(p,t,all);
  return rows.find(x=>x.task.futureHoldError)?.task.futureHoldError|| (rows.some(x=>x.task.futureHold===true)?message():'');
}
function held(p,t,all){return !scope(p,t,all).some(x=>x.task.futureHoldError)&&scope(p,t,all).some(x=>x.task.futureHold===true);}
function assertCleanup(p,t,all){if(all.some(q=>q.tasks.some(x=>(x.futureHold||x.futureHoldError)&&graph.ancestorsOf(q,x,all).some(y=>y.project.id===p.id&&y.task.id===t.id))))throw Error(lt('将来検討として残す子孫があるため、この子作業を片付けられません'));}
function assertAllowed(p,t,all){const why=reason(p,t,all);if(why)throw Error(why);}
function assertRecord(h,r){
  const all=h.store.listProjects();
  const p=all.find(x=>x.id===r.project),t=p?.tasks.find(x=>x.id===r.task);if(t)assertAllowed(p,t,all);
  for(const i of r.items||[]){
    const p=all.find(x=>x.id===i.project),t=p?.tasks.find(x=>x.id===i.task);
    if(t){assertAllowed(p,t,all);if(i.disposition==='cleanup')assertCleanup(p,t,all);}
  }
}
function save(h,b){
  if(typeof b.held!=='boolean'||typeof b.before!=='boolean'||b.confirm!==true)throw Error(lt('保留するか解除するかを確認してください'));
  const all=h.store.listProjects(),p=all.find(p=>p.id===b.project),t=p?.tasks.find(t=>t.id===b.task);
  if(!t||t.freetalk||!graph.ancestorsOf(p,t,all).length)throw Error(lt('親のある子作業で操作してください'));
  const registryError=scope(p,t,all).find(x=>x.task.futureHoldError)?.task.futureHoldError;if(registryError)throw Error(registryError);
  if(t.completionHash!==b.expectedHash||Boolean(t.futureHold)!==b.before||(t.futureHoldRevision||null)!==b.revision)throw Error(lt('保留の状態が変わりました。最新の表示を確認してください'));
  // Check both directions of the task graph: an ancestor's integration or a
  // descendant's organizer must not race this choice. No stop/cancel is sent.
  const related=all.flatMap(q=>q.tasks.filter(x=>q.id===p.id&&x.id===t.id||scope(q,x,all).some(a=>a.project.id===p.id&&a.task.id===t.id)||scope(p,t,all).some(a=>a.project.id===q.id&&a.task.id===x.id)).map(x=>({project:q,task:x})));
  for(const {project:q,task:x} of related){
    if(h.removal.busy(q.id,x.id)||h.removal.locked(q.id))throw Error(lt('関係するAI・整理・確認の終了後に保留を変更してください'));
    const queue=path.join(q.dir,'.ai/chat',x.id+'.queue.json');noLinks(queue);
    if(exists(queue)){const rows=JSON.parse(fs.readFileSync(queue,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error(lt('関係する作業の順番待ちが残っています'));
    }
    const records=h.records?h.records(q.id,x.id):[h.read(q.id,x.id)].filter(Boolean);
    for(const r of records)if(r&&(h.active?.id===r.id||!r.auto?.stopped&&(!continuation.closed(r)||r.auto&&r.auto.main?.state!=='done')))throw Error(lt('統合が動いています。停止した記録を確認してから変更してください'));
    const offer=h.transfer.read(q.id,x.id);
    if(offer&&!offer.complete&&(offer.receiving||offer.destination&&!offer.handedUp&&!offer.integrating))throw Error(lt('成果の受領が進行中です。結果を確認してから変更してください'));
  }
  if(Boolean(t.futureHold)===b.held)return {ok:true,held:b.held,revision:t.futureHoldRevision||null};
  const f=file(h.store.root,p.id,t.id),revision=randomUUID(),previous=exists(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;
  const r={version:1,project:p.id,task:t.id,held:b.held,revision,at:new Date().toISOString(),history:[...(previous?.history||[]),{before:b.before,held:b.held,revision,at:new Date().toISOString()}]};
  noLinks(f);fs.mkdirSync(path.dirname(f),{recursive:true});
  require('./integration-writes').atomic(f,r);
  // All previous authorizations are stale even after a hold/release round trip.
  h.tokens.clear();h.transfer.tokens.clear();
  return {ok:true,held:b.held,revision};
}
module.exports={file,read,held,reason,assertAllowed,assertCleanup,assertRecord,save};
