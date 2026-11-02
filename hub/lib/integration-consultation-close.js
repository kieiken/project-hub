'use strict';
// Explicit recovery for a stopped, empty-tree consultation merge. Never turn
// the failed review into a pass. Retire its request identities permanently and
// preserve the completed sibling's original pin before retiring either lane.
const fs=require('./platform/file-io'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {noLinks,exists,snapshot,inside}=require('./remove');
const writes=require('./integration-writes'),continuation=require('./task-continuation'),persistence=require('./platform').persistence;
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=s=>{throw Error(s);},uuid=s=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s||'');
const codeFiles=['integration-consultation-close.js','task-integrate.js','task-transfer.js','integration-sibling.js','routes/task-integration.js','../server.js'];
function codeInputs(){return Object.fromEntries(codeFiles.map(p=>[p,hash(fs.readFileSync(path.join(__dirname,p)))]));}
function index(h,p,t){return path.join(h.dir,'consultation-closures',path.basename(h.file(p,t)));}
function regular(f){noLinks(f);const s=fs.statSync(f);if(!s.isFile()||s.nlink!==1)fail('終了記録にリンク・不明な種類があります');return fs.readFileSync(f);}
const records=new (require('./record-read-cache').RecordReadCache)(bytes=>({value:JSON.parse(bytes)}));
const originals=new (require('./record-read-cache').RecordReadCache)(bytes=>({text:bytes.toString('utf8'),sha256:hash(bytes)}));
function saveClosure(file,r){records.invalidate(file);writes.atomic(file,r);}
function load(h,f){
 noLinks(f);const entry=records.read(f,{regular:true});if(!entry)return null;const r=entry.value;
 if(r.version!==1||!uuid(r.id)||!['intent','preserved','trash-intent','trashed','retired','complete'].includes(r.stage)||!Array.isArray(r.originals)||r.originals.length!==4)fail('相談終了の記録を確認できません');
 // The former second JSON parse also rejected object-valued identities.
 if(r.project&&typeof r.project==='object'||r.task&&typeof r.task==='object')fail('相談終了の記録を確認できません');
 if(f!==index(h,r.project,r.task))fail('相談終了の記録名が一致しません');
 const dir=path.join(path.dirname(f),r.id);
 for(const o of r.originals){if(!['primary','sibling','offer','hold'].includes(o.kind)||o.file!==path.join(dir,o.kind+'.json'))fail('相談終了の原記録が一致しません');noLinks(o.file);if(originals.read(o.file,{regular:true})?.sha256!==o.sha256)fail('相談終了の原記録が一致しません');}
 if(new Set(r.originals.map(x=>x.kind)).size!==4)fail('相談終了の原記録が重複しています');
 return r;
}
function read(h,p,t){
 const r=load(h,index(h,p,t));if(!r)return null;
 if(r.project!==p||r.task!==t)fail('相談終了の記録を確認できません');
 return structuredClone(r);
}
function all(h){
 const dir=path.join(h.dir,'consultation-closures');noLinks(dir);if(!exists(dir)){records.prune(dir,[]);return [];}
 const names=fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));records.prune(dir,names);
 return names.map(n=>{const r=load(h,path.join(dir,n));if(!r)fail('相談終了の記録を確認できません');return r;});
}
function original(r,kind){const f=r.originals.find(o=>o.kind===kind).file;noLinks(f);const entry=originals.read(f,{regular:true});if(!entry)fail('相談終了の原記録が一致しません');return JSON.parse(entry.text);}
function retired(h){return all(h).flatMap(r=>['primary','sibling'].map(kind=>({...original(r,kind),consultationRetired:r.id})));}
function assertWritable(h,r){
 if(!r)return;
 const rows=all(h);
 if(rows.some(x=>x.project===r.project&&x.task===r.task&&x.stage!=='complete')||rows.some(x=>['primary','sibling'].some(k=>original(x,k).id===r.id)))fail('相談終了の対象です。古い統合は再開・再保存しません');
}
function assertOfferWritable(transfer,r){
 const h={dir:path.join(transfer.store.root,'_hub/task-integrations'),file:(p,t)=>path.join(transfer.store.root,'_hub/task-integrations',hash(p+'\0'+t)+'.json')};
 if(all(h).some(x=>original(x,'offer').id===r.id||['primary','sibling'].some(k=>original(x,k).id===r.integrating)||x.childProject===r.project&&x.childTask===r.task)||r.consultationClosure)fail('相談終了の受領記録です。古い引渡しは再開しません');
}
function pending(h){return all(h).filter(r=>r.stage!=='complete').map(r=>({project:r.project,task:r.task,id:r.id,stage:'consultation-close',items:[],auto:{stopped:{reason:'相談終了の保存・移動を確認してください'}}}));}
function wait(h,b){
 if(typeof h.consultationWait!=='function')fail('正式な稼働確認がありません');
 const rows=h.consultationWait({...b,selected:[{project:b.childProject,task:b.childTask}]});
 if(!Array.isArray(rows)||rows.length||h.active)fail('関係するAI・整理・順番待ちの終了後に片付けます');
}
function inventory(f){
 const rows=[];let bytes=0;
 const walk=(q,rel)=>{noLinks(q);const s=fs.lstatSync(q);if(rows.length>=20000||!s.isFile()&&!s.isDirectory()||s.isFile()&&s.nlink!==1)fail('保存対象の種類・件数を確認できません');
  const row={path:rel,kind:s.isDirectory()?'directory':'file',mode:s.mode&0o777};
  if(s.isFile()){bytes+=s.size;if(bytes>256*1024*1024)fail('保存対象が大きすぎます');row.size=s.size;row.sha256=hash(fs.readFileSync(q));}rows.push(row);
  if(s.isDirectory())for(const n of fs.readdirSync(q).sort())walk(path.join(q,n),rel?rel+'/'+n:n);};walk(f,'');return rows;
}
function durableTree(f){
 const rows=inventory(f);for(const e of rows)if(e.kind==='file')persistence.syncFile(path.join(f,e.path));
 for(const e of rows.filter(e=>e.kind==='directory').reverse())persistence.syncDirectory(path.join(f,e.path));
 persistence.syncDirectory(path.dirname(f));
}
function duplicate(from,to){
 noLinks(to);if(exists(to))fail('保存先が既にあります。上書きしません');
 const rows=inventory(from);
 for(const e of rows){const src=path.join(from,e.path),dst=path.join(to,e.path);if(e.kind==='directory')fs.mkdirSync(dst,{mode:0o700});else{fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);fs.chmodSync(dst,e.mode);}}
 for(const e of rows.filter(e=>e.kind==='directory').reverse())fs.chmodSync(path.join(to,e.path),e.mode);
 durableTree(to);if(JSON.stringify(inventory(to))!==JSON.stringify(rows)||JSON.stringify(inventory(from))!==JSON.stringify(rows))fail('保存内容の照合に失敗しました');return rows;
}
function inspect(h,b){
 if(read(h,b.project,b.task))fail('相談終了は既に予約されています。結果を照合し、再送しないでください');
 const a=h.ancestor(b.project,b.task,{allowBusy:true}),r=h.read(b.project,b.task),side=require('./integration-sibling').read(h,b.project,b.task);
 if(!r||r.complete||r.abandoned||!uuid(r.id)||!r.auto?.stopped||r.auto.prepared!==true||r.items?.length!==1||r.auto.main||continuation.pendingMain(r)||Object.keys(r.auto.migrations||{}).length)fail('空差分で停止した相談統合だけを正式終了できます');
 if(!side||!continuation.childrenComplete(side)||side.auto?.thenMain!==false||side.auto.main?.state!=='done'||side.auto.main.skipped!==true||side.items.some(i=>!i.receipt||i.keep!==true))fail('別の子の受領が完了していません');
 require('./integration-sibling').assert(h,side);
 if(!h.siblingQuiescent?.(r)||!h.siblingQuiescent?.(side))fail('以前の委任の終了を確認できません');
 const i=r.items[0],p=a.all.find(p=>p.id===b.childProject),t=p?.tasks.find(t=>t.id===b.childTask);
 if(!t||i.project!==p.id||i.task!==t.id||!i.copy||i.keep!==true||i.receipt||i.files?.length||i.selected?.length||i.preview?.paths?.length||i.results?.length!==1||i.results[0].kind!=='なし'||i.integrated?.files?.length||i.integrated?.dir!==a.target)fail('製品・ファイル成果のある統合はこの終了方法を使えません');
 const ancestors=require('../public/project-order').ancestorsOf(p,t,a.all);
 if(!ancestors.some(x=>x.project.id===a.p.id&&x.task.id===a.t.id)||a.all.some(q=>q.tasks.some(x=>require('../public/project-order').ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id))))fail('片付ける親子関係を確認できません');
 if(t.question||t.steps.some(s=>!s.done)||continuation.declaration(h.store.taskFile(p.id,t.id)).status!=='なし'||h.transfer.results(p,t).some(x=>x.kind!=='なし'))fail('相談の残件・成果宣言を確認してください');
 const target=h.gitw.inspect(a.target),source=h.gitw.inspect(i.copy),merge=i.integrated;
 if(!target||target.status||h.gitw.merging(a.target)||!source||source.status||source.head!==i.sourceHead||h.gitw.merging(i.copy)||!merge?.commit||!merge.previousTargetHead||h.gitw.changedBetween(a.target,merge.previousTargetHead,merge.commit).length||!h.gitw.isAncestor(a.target,merge.commit)||!h.gitw.isAncestor(a.target,source.head))fail('保存済みの空差分・出典履歴を確認できません');
 const offer=h.transfer.read(p.id,t.id);if(!offer||offer.integrating!==r.id||offer.receiving||offer.complete)fail('元の受領予約を確認できません');
 const hold=require('./task-future-hold').file(h.store.root,p.id,t.id),held=require('./task-future-hold').read(h.store.root,p.id,t.id);
 // A released, validated record still belongs to this consultation. Preserve
 // its exact bytes in the plan/CAS and append closure without re-holding it.
 if(held.futureHoldError||typeof held.futureHold!=='boolean')fail('今回の保留状態を確認できません');
 const d=h.removal.describe(p.id,t.id,{removableCopy:true});
 // Preview can run while the caller's chat is active; apply checks the formal
 // wait gate and the exact same description again after all activity finishes.
 const ownBusy=['AIが作業中です。終わってから操作してください','整理・確認が実行中です。終わってから操作してください','順番待ちを取り消してから操作してください'];
 if(d.blockers.some(s=>!ownBusy.includes(s)))fail(d.blockers.join(' / '));
 const paths=[...d.move.map(x=>x.path),...d.optional.map(x=>x.path),...d.keep.map(x=>x.path).filter(f=>inside(p.dir,f)&&[path.join(p.dir,'.ai/work',t.id),path.join(p.dir,'attachments',t.id),path.join(p.dir,'作業',t.id)].includes(f))];
 const originals=[['primary',h.file(r.project,r.task)],['sibling',require('./integration-sibling').file(h,r.project,r.task)],['offer',h.transfer.file(p.id,t.id)],['hold',hold]].map(([kind,file])=>({kind,path:file,sha256:hash(regular(file)),mode:fs.statSync(file).mode&0o777}));
 const preserve=[...new Set(paths)].map(from=>({from,entries:inventory(from)}));
 return {project:b.project,task:b.task,childProject:p.id,childTask:t.id,title:t.title,target:a.target,targetHead:target.head,sourceHead:source.head,originals,preserve,move:d.move,keep:d.keep,optional:d.optional,scope:{primarySHA:originals[0].sha256,siblingSHA:originals[1].sha256,offerSHA:originals[2].sha256,childHead:source.head},codeInputs:codeInputs()};
}
function preview(h,b){const plan=inspect(h,b),token=randomUUID();h.tokens.set(token,{at:Date.now(),consultationClose:plan});return {...plan,token,waiting:h.consultationWait?.({...b,selected:[{project:b.childProject,task:b.childTask}]})||[{message:'稼働確認待ち'}]};}
function checkReview(plan,b){
 const file=b.reviewFile;if(typeof file!=='string'||!inside(path.join(plan.target,'.ai/work'),file)||!path.isAbsolute(file))fail('今回の独立確認結果を指定してください');
 const bytes=regular(file),r=JSON.parse(bytes);
 if(hash(bytes)!==b.reviewSHA||r.verdict!=='pass'||JSON.stringify(r.scope)!==JSON.stringify(plan.scope)||JSON.stringify(r.codeInputs)!==JSON.stringify(plan.codeInputs))fail('今回の対象と保存コードに合格した独立確認がありません');
 return {file,sha256:b.reviewSHA};
}
function checkSources(plan){for(const x of plan.originals)if(hash(regular(x.path))!==x.sha256)fail('元の統合記録が更新されました');for(const x of plan.preserve)if(JSON.stringify(inventory(x.from))!==JSON.stringify(x.entries))fail('元の相談・会話・コピーが更新されました');}
function apply(h,b){
 const saved=h.tokens.get(b.token),plan=saved?.consultationClose;
 if(!plan||Date.now()-saved.at>600000||b.confirm!==true||plan.project!==b.project||plan.task!==b.task||typeof b.authorization!=='string'||!b.authorization.trim()||b.authorization.length>2000)fail('今回の相談終了と片付けを確認してください');
 wait(h,plan);const now=inspect(h,plan);
 if(JSON.stringify(now)!==JSON.stringify(plan))fail('確認中に対象が変わりました。元の記録は残しています');
 const review=checkReview(plan,b),id=randomUUID(),file=index(h,plan.project,plan.task),dir=path.join(path.dirname(file),id),lock=require('./integration-sibling').file(h,plan.project,plan.task)+'.lock';
 noLinks(lock);fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,id,{flag:'wx',mode:0o600});
 let r,success=false;
 try{return h.transfer.withSaveLock(plan.childProject,plan.childTask,()=>{
  checkSources(plan);wait(h,plan);noLinks(dir);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const originals=plan.originals.map(o=>{const f=path.join(dir,o.kind+'.json');fs.writeFileSync(f,regular(o.path),{flag:'wx',mode:o.mode});fs.chmodSync(f,o.mode);persistence.syncFile(f);if(hash(regular(f))!==o.sha256||(fs.statSync(f).mode&0o777)!==o.mode)fail('元記録を保存できません');return {kind:o.kind,file:f,sha256:o.sha256};});persistence.syncDirectory(dir);
  r={version:1,id,project:plan.project,task:plan.task,childProject:plan.childProject,childTask:plan.childTask,stage:'intent',at:new Date().toISOString(),authorization:b.authorization,review,originals,plan};
  saveClosure(file,r);h.tokens.delete(b.token);
  const destination=path.join(plan.target,'.ai/work/consultation-preserved',id);noLinks(destination);if(exists(destination))fail('保存先が既にあります');fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const manifest=plan.preserve.map((p,n)=>{const to=path.join(destination,String(n));const entries=duplicate(p.from,to);return {from:p.from,to,entries};});
  writes.atomic(path.join(destination,'manifest.json'),manifest);r.destination=destination;r.manifest=manifest;r.stage='preserved';saveClosure(file,r);
  checkSources(plan);wait(h,plan);
  const current=h.removal.describe(plan.childProject,plan.childTask,{removableCopy:true});
  if(current.blockers.length||JSON.stringify(current.move)!==JSON.stringify(plan.move)||JSON.stringify(current.keep)!==JSON.stringify(plan.keep)||JSON.stringify(current.optional)!==JSON.stringify(plan.optional))fail('保存中に片付け範囲が変わりました');
  r.stage='trash-intent';saveClosure(file,r);
  const d={project:plan.childProject,task:plan.childTask,title:plan.title};
  const moved=h.removal.transfer(d,plan.move,'相談終了',{consultationClosure:id});r.removal=moved;saveClosure(file,r);
  if(!moved.ok)fail('片付けが途中で止まりました。保存済み原文と移動記録を照合し、押し直さないでください');
  r.stage='trashed';saveClosure(file,r);
  exclusiveFinalize(h,r);
  success=true;return {ok:true,complete:true,id,destination,removal:moved.record,mainApplied:false};
 });
 }finally{
  // A partial operation deliberately keeps its exclusive lock. Recovery is an
  // explicit, reviewed operation; polling, a late callback and a retry do nothing.
  if(success||!r){fs.unlinkSync(lock);persistence.syncDirectory(path.dirname(lock));}
 }
}
function exclusiveFinalize(h,r){
 const lock=index(h,r.project,r.task)+'.finish.lock';noLinks(lock);
 fs.writeFileSync(lock,r.id,{flag:'wx',mode:0o600});
 try{finalize(h,r);}finally{fs.unlinkSync(lock);persistence.syncDirectory(path.dirname(lock));}
}
function finalize(h,r){
 const plan=r.plan;
 if(r.stage!=='trashed'&&r.stage!=='retired')fail('移動完了を確認するまで正式終了しません');
 const removalFile=path.join(h.removal.records,r.removal.record+'.json'),record=JSON.parse(regular(removalFile));
 if(record.consultationClosure!==r.id||record.project!==plan.childProject||record.task!==plan.childTask||record.entries.length!==plan.move.length||record.entries.some((e,n)=>e.from!==plan.move[n].path||e.fingerprint!==plan.move[n].fingerprint||JSON.stringify(e.copy)!==JSON.stringify(plan.move[n].copy)||!e.moved||e.moving||e.restored||exists(e.from)||!h.removal.validEntry(record,e,path.join(h.store.product,plan.childProject))||snapshot(e.to,{contentOnly:Boolean(e.copy)})!==e.fingerprint))fail('ゴミ箱への全件移動を確認できません');
 for(const e of record.entries){durableTree(e.to);persistence.syncDirectory(path.dirname(e.from));}persistence.syncFile(removalFile);persistence.syncDirectory(path.dirname(removalFile));
 for(const m of r.manifest)if(JSON.stringify(inventory(m.to))!==JSON.stringify(m.entries))fail('保存した原文・会話・コピーが変わりました');
 // Canonical old lanes are retired only after all source records are preserved
 // and all selected moves are confirmed. Windows' original bytes remain exact.
 for(const kind of ['primary','sibling']){const o=plan.originals.find(o=>o.kind===kind),to=path.join(path.dirname(r.originals[0].file),kind+'.retired.json');
  if(exists(o.path)){if(hash(regular(o.path))!==o.sha256||exists(to))fail('統合記録が更新されています');h.pendingCache?.invalidate(o.path);fs.renameSync(o.path,to);persistence.syncDirectory(path.dirname(o.path));persistence.syncDirectory(path.dirname(to));}else if(!exists(to)||hash(regular(to))!==o.sha256)fail('統合記録の退避結果を確認できません');}
 r.stage='retired';saveClosure(index(h,r.project,r.task),r);
 const old=original(r,'offer'),f=h.transfer.file(r.childProject,r.childTask),receipt={id:r.id,project:r.childProject,task:r.childTask,title:plan.title,targetProject:r.project,targetTask:r.task,destination:r.destination,files:[],results:original(r,'primary').items[0].results,complete:true,retained:false,cleanup:r.removal.record,consultationClosure:r.id,previousOffer:old.id,sourceHead:plan.sourceHead,mainApplied:false};
 if(exists(f)&&hash(regular(f))!==plan.originals.find(o=>o.kind==='offer').sha256&&JSON.stringify(JSON.parse(regular(f)))!==JSON.stringify(receipt))fail('受領予約が変わりました');
 h.transfer.pendingCache?.invalidate(f);writes.atomic(f,receipt);
 const holdFile=plan.originals.find(o=>o.kind==='hold').path,hold=original(r,'hold');
 const ended={...hold,held:false,revision:r.id,at:r.at,history:[...hold.history,{before:hold.held,held:false,revision:r.id,at:r.at,consultationClosure:r.id,reason:'本人承認による正式終了・片付け。自動再開なし'}]};
 if(hash(regular(holdFile))!==plan.originals.find(o=>o.kind==='hold').sha256&&JSON.stringify(JSON.parse(regular(holdFile)))!==JSON.stringify(ended))fail('保留記録が変わりました');
 writes.atomic(holdFile,ended);r.receipt=receipt;r.stage='complete';saveClosure(index(h,r.project,r.task),r);
}
function status(h,b){const r=read(h,b.project,b.task);return r?{id:r.id,stage:r.stage,complete:r.stage==='complete',destination:r.destination,removal:r.removal?.record,mainApplied:false}:{stage:'not-started',complete:false};}
// Explicit completion only. A crash before/during a move is not permission to
// move again: all entries must already be durably recorded as moved. Partial
// trash can instead be restored using Removal's existing reviewed recovery.
function finish(h,b){
 const r=read(h,b.project,b.task);if(!r||r.id!==b.id||b.confirm!==true)fail('今回の終了記録を指定してください');
 if(r.stage==='complete'){
  const lock=require('./integration-sibling').file(h,r.project,r.task)+'.lock';
  // A crash can happen after the complete journal but before releasing its
  // reservation. Only this explicit request may remove the matching lock.
  if(exists(lock)){checkReview(r.plan,b);if(regular(lock).toString()!==r.id)fail('終了予約が別の処理のものです');fs.unlinkSync(lock);persistence.syncDirectory(path.dirname(lock));}
  return status(h,b);
 }
 wait(h,r.plan);checkReview(r.plan,b);
 if(JSON.stringify(r.plan.codeInputs)!==JSON.stringify(codeInputs())||!['trash-intent','trashed','retired'].includes(r.stage)||!r.removal?.ok)fail('移動完了の証拠が足りません。再移動せず保管・ゴミ箱の記録を確認してください');
 const lock=require('./integration-sibling').file(h,r.project,r.task)+'.lock';if(regular(lock).toString()!==r.id)fail('今回の終了処理の予約を確認できません');
 return h.transfer.withSaveLock(r.childProject,r.childTask,()=>{
  if(r.stage==='trash-intent'){r.stage='trashed';saveClosure(index(h,r.project,r.task),r);}
  exclusiveFinalize(h,r);fs.unlinkSync(lock);persistence.syncDirectory(path.dirname(lock));return status(h,b);
 });
}
module.exports={read,retired,assertWritable,assertOfferWritable,pending,preview,apply,inspect,status,finish,inventory,codeInputs};
