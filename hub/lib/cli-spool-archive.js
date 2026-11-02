'use strict';
const platform = require('./platform'), persistence = platform.persistence;
// Explicit, reviewed maintenance only. Never called by state polling or startup.
// Completed ordinary turns must have identity-bound, independently saved final rows.
// Automation, unresolved runs and evidence needed by their recovery stay put.
const fs=require('./platform/file-io'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const spool=require('./cli-spool'),{noLinks,exists}=require('./remove');
const proofs=require('./spool-archive-proof');
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x);
function presence(pid){try{process.kill(pid,0);return 'present';}catch(e){return e.code==='ESRCH'?'absent':e.code==='EPERM'?'present':'unknown';}}
// Do not let Date normalize invalid native dates into a later, apparently safe
// birth. POSIX lstart is local time at second precision; Windows is UTC.
function birthMillis(s){
 if(typeof s!=='string')return NaN;
 if(platform.name==='win32'){
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(s))return NaN;
  const ms=Date.parse(s);return Number.isFinite(ms)&&new Date(ms).toISOString()===s.replace(/(\.\d{3})\d{4}Z$/,'$1Z')?ms:NaN;
 }
 if(!['darwin','linux'].includes(platform.name))return NaN;
 const m=s.trim().match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
 if(!m)return NaN;
 const ms=Date.parse(platform.parseLstart(s));if(!Number.isFinite(ms))return NaN;
 const fields=d=>[d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes(),d.getSeconds()].join(',');
 const expected=[+m[7],'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(m[2]),+m[3],+m[4],+m[5],+m[6]].join(','),d=new Date(ms);
 if(fields(d)!==expected||'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d.getDay()]!==m[1])return NaN;
 // A repeated local hour has two possible births. Neither proves reuse.
 if([-7200000,-3600000,-1800000,1800000,3600000,7200000].some(delta=>fields(new Date(ms+delta))===expected))return NaN;
 return ms;
}
function assertInactive(pids,finishedAt){
 const fail=()=>{throw Error('稼働中または起動時刻・番号の再使用を確認できません');};
 const ids=[...new Set(pids.filter(pid=>Number.isSafeInteger(pid)&&pid>0))],states=ids.map(pid=>presence(pid));
 if(states.includes('unknown'))fail();
 const live=ids.filter((pid,i)=>states[i]==='present');
 if(live.length){
  if(!Number.isFinite(finishedAt)||finishedAt<=0||finishedAt>Date.now())fail();
  let first,second;
  try{first=platform.processSnapshot();second=platform.processSnapshot();}catch{fail();}
  for(const pid of live){
   const a=first.filter(r=>r.pid===pid),b=second.filter(r=>r.pid===pid);
   if(a.length!==1||b.length!==1||!require('./owned-processes').same(a[0],b[0],platform))fail();
   const birth=birthMillis(a[0].since);
   // Leave a full second beyond the saved finish boundary. No rounded or
   // ambiguous timestamp, future birth, or changed/disappearing process passes.
   if(!Number.isFinite(birth)||birth<=finishedAt+1000||birth>Date.now())fail();
  }
 }
 if(ids.some((pid,i)=>presence(pid)!==states[i]))fail();
}
function snapshot(dir){
 noLinks(dir);const stat=fs.statSync(dir);if(!stat.isDirectory())throw Error('実行記録がフォルダではありません');
 const files=[];
 const walk=(base,prefix='')=>{for(const name of fs.readdirSync(base).sort()){
  const file=path.join(base,name),rel=prefix+name;noLinks(file);const s=fs.lstatSync(file);
  if(s.isDirectory()){files.push({name:rel,kind:'directory',mode:s.mode&0o7777,uid:s.uid,gid:s.gid,bytes:0});walk(file,rel+'/');}
  else {if(!s.isFile()||s.nlink!==1)throw Error('リンクや未確認の項目は退避しません');files.push({name:rel,mode:s.mode&0o7777,uid:s.uid,gid:s.gid,bytes:s.size,sha256:hash(fs.readFileSync(file))});}
 }};walk(dir);
 return {mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid,files,sha256:hash(json(files)),bytes:files.reduce((n,f)=>n+f.bytes,0)};
}
function eligible(dir,{now,minAgeMs,protectedProjects=[],context,expectedEvidence}){
 noLinks(dir);
 const f=spool.strictRead(dir,'finished.json'),p=spool.strictRead(dir,'finalizing.json'),q=spool.strictRead(dir,'request.json'),o=q?.options;
 if(!f||!Number.isFinite(f.at)||f.at>now-minAgeMs||p?.stage!=='finished'||!o||protectedProjects.includes(o.project)||spool.failure(dir))throw Error('終了確認・保持期間・保護対象');
 if(['automation','resultsOrganize','readOnly','selectionOnly','limitSwitch','isolatedReview','integrationReviewRequest','integrationAssignment','discussionTurn','discussion','resultsRecoveryHash','limitPolicy'].some(k=>o[k])||/\[(?:integration-|idea-run:)/.test(o.text||''))throw Error('専用実行の証拠は保持');
 for(const name of ['owner.lock','failure.json'])if(exists(path.join(dir,name)))throw Error('未解決・処理中の記録は保持');
 const owner=spool.strictRead(dir,'owner.json'),launch=spool.strictRead(dir,'launch.json'),started=spool.strictRead(dir,'started.json');
 if(!owner||typeof owner.serverId!=='string'||owner.generation!==p.generation||f.generation!==p.generation)throw Error('所有権と終了の世代が一致しません');
 if(p.requestHash!==hash(fs.readFileSync(path.join(dir,'request.json')))||p.completionHash!==spool.completion(dir))throw Error('実行証拠が変わっています');
 if(typeof o.pdir!=='string'||typeof o.task!=='string'||/[\/\\]/.test(o.task)||!o.userRow?.turn)throw Error('会話との対応が不明');
 const unfinished=path.join(o.pdir,'.ai/chat',o.task+'.unfinished.json');noLinks(unfinished);
 if(exists(unfinished)){
  const d=JSON.parse(fs.readFileSync(unfinished,'utf8'));
  if(!d||(d.advances!==undefined&&(typeof d.advances!=='object'||!d.advances||Array.isArray(d.advances))))throw Error('待ち指示の状態が不明');
  if(Object.values(d.advances||{}).some(a=>['waiting','blocked'].includes(a?.phase)&&typeof a.source?.spool==='string'&&path.basename(a.source.spool)===path.basename(dir)))throw Error('未解決・処理中の記録は保持');
 }
 const evidence=proofs.resolve(o,p,path.basename(dir),context,expectedEvidence);
 // Only authenticated, generation-bound completion evidence may establish
 // the cutoff. Keep proofOf/plan format unchanged for already approved plans.
 assertInactive([owner?.pid,launch?.supervisorPid,started?.supervisorPid,started?.cliPid],f.at);
 return {project:o.project,task:o.task,turn:o.userRow.turn,finalRowHash:p.finalRowHash,finishedAt:f.at,evidence,delivery:require('./idea-spool-index').identity(q)};
}
function plan(root,{now=Date.now(),minAgeMs=3*86400000,protectedProjects=[],trashRoot=require('./platform').trashDir()}={}){
 noLinks(root);root=fs.realpathSync(root);if(!Number.isFinite(minAgeMs)||minAgeMs<86400000)throw Error('保持期間は1日以上必要です');
 const options={now,minAgeMs,protectedProjects,trashRoot},context=proofs.context(root,trashRoot),items=[],skipped=[];
 for(const name of fs.readdirSync(root).sort()){
  if(!/^[a-f0-9-]{36}$/.test(name)){skipped.push({name,reason:'実行番号以外'});continue;}
  try{const dir=path.join(root,name),proof=eligible(dir,{...options,context}),tree=snapshot(dir);items.push({name,...proof,...tree});}catch(e){skipped.push({name,reason:e.message});}
 }
 return {version:2,id:randomUUID(),root,archiveRoot:root+'-archive',...options,items,skipped,bytes:items.reduce((n,i)=>n+i.bytes,0)};
}
function apply(p,resultFile){
 validatePlan(p);if(!p.items.length)throw Error('退避対象がありません');
 if(p.version!==2||!Number.isFinite(p.now)||!Number.isFinite(p.minAgeMs)||p.minAgeMs<86400000||!Array.isArray(p.items)||!Array.isArray(p.protectedProjects)||!path.isAbsolute(p.root)||p.archiveRoot!==p.root+'-archive'||!Array.isArray(p.skipped)||!/^[a-f0-9-]{36}$/.test(p.id)||p.items.some(i=>!/^[a-f0-9-]{36}$/.test(i.name))||new Set(p.items.map(i=>i.name)).size!==p.items.length)throw Error('退避計画が不正です');
 noLinks(p.root);noLinks(p.archiveRoot);checkResult(p,resultFile);if(exists(resultFile))throw Error('結果が既にあります。再実行せず照合してください');
 const context=proofs.context(p.root,p.trashRoot);
 // Recheck all inputs before creating the one-use operation directory.
 for(const i of p.items){const dir=path.join(p.root,i.name);if(!matchesProof(dir,p,i,context))throw Error('固定した会話の証拠が変わっています');if(json(snapshot(dir))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes}))throw Error('固定した実行記録が変わっています');}
 fs.mkdirSync(p.archiveRoot,{recursive:true,mode:0o700});const batch=path.join(p.archiveRoot,p.id);fs.mkdirSync(batch,{mode:0o700});
 exclusive(path.join(batch,'plan.json'),p);
 // Publish identity evidence before any move; even interrupted moves must never
 // turn an accepted request into absence for delivery/erasure checks.
 const catalog={version:1,id:p.id,items:p.items.map(i=>({name:i.name,request:i.delivery}))};
 exclusive(path.join(p.root,'archive-'+p.id+'.json'),catalog);
 persistence.syncDirectory(p.root);
 const out={id:p.id,complete:false,moved:[],active:null,failed:null};
 const save=()=>{const tmp=resultFile+'.'+randomUUID();exclusive(tmp,out);fs.renameSync(tmp,resultFile);persistence.syncDirectory(path.dirname(resultFile));};
 try{
  for(const i of p.items){
   out.active=i.name;save();const src=path.join(p.root,i.name),dst=path.join(batch,i.name);if(!matchesProof(src,p,i,proofs.context(p.root,p.trashRoot)))throw Error('退避直前に会話の証拠が変わりました');if(json(snapshot(src))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes}))throw Error('退避直前に記録が変わりました');
   if(exists(dst)||fs.statSync(src).dev!==fs.statSync(batch).dev)throw Error('同じディスク内の新しい場所にだけ退避できます');
   fs.renameSync(src,dst);
   if(json(snapshot(dst))!==json({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes})||exists(src))throw Error('退避後の内容を確認できません');
   for(const parent of [p.root,batch])persistence.syncDirectory(parent);
   out.moved.push({name:i.name,path:dst,sha256:i.sha256,bytes:i.bytes});out.active=null;save();
  }
  out.complete=true;save();return out;
 }catch(e){out.failed=e.message;save();throw e;}
}
function locate(p,name){
 validatePlan(p);noLinks(path.join(p.archiveRoot,p.id,'plan.json'));
 if(json(JSON.parse(fs.readFileSync(path.join(p.archiveRoot,p.id,'plan.json'),'utf8')))!==json(p))throw Error('保存した計画と一致しません');if(!p.items.some(i=>i.name===name))throw Error('計画にない実行記録です');
 const dir=path.join(p.archiveRoot,p.id,name),i=p.items.find(i=>i.name===name);noLinks(dir);
 if(json(snapshot(dir))!==json(treeOf(i)))throw Error('退避した原物が変わっています');return dir;
}
const proofOf=i=>({project:i.project,task:i.task,turn:i.turn,finalRowHash:i.finalRowHash,finishedAt:i.finishedAt,evidence:i.evidence,delivery:i.delivery});
// Shared by both apply guards and read-only maintenance verification.
function matchesProof(dir,p,i,context=proofs.context(p.root,p.trashRoot)){
 return json(eligible(dir,{...p,context,expectedEvidence:i.evidence}))===json(proofOf(i));
}
const treeOf=i=>({mode:i.mode,uid:i.uid,gid:i.gid,files:i.files,sha256:i.sha256,bytes:i.bytes});
function validatePlan(p){
 if(![1,2].includes(p?.version)||!path.isAbsolute(p.root||'')||path.resolve(p.root)!==p.root||p.archiveRoot!==p.root+'-archive'||!/^[a-f0-9-]{36}$/.test(p.id||'')||!Array.isArray(p.items)||p.items.some(i=>!/^[a-f0-9-]{36}$/.test(i.name||''))||new Set(p.items.map(i=>i.name)).size!==p.items.length)throw Error('退避計画が不正です');
}
function exclusive(file,value){
 noLinks(file);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}persistence.syncDirectory(path.dirname(file));
}
function checkResult(p,file){
 noLinks(file);if(!path.isAbsolute(file)||[p.root,p.archiveRoot].some(root=>file===root||file.startsWith(root+path.sep)))throw Error('結果は実行記録と退避先の外へ保存してください');
}
function restore(p,resultFile){
 validatePlan(p);noLinks(p.root);checkResult(p,resultFile);if(exists(resultFile))throw Error('復元結果が既にあります。再実行せず照合してください');
 const batch=path.join(p.archiveRoot,p.id);noLinks(batch);
 if(json(JSON.parse(fs.readFileSync(path.join(batch,'plan.json'),'utf8')))!==json(p))throw Error('保存した計画と一致しません');
 // A partial apply can be restored too, but no new original is ever overwritten.
 const items=p.items.filter(i=>exists(path.join(batch,i.name)));
 for(const i of items){locate(p,i.name);if(exists(path.join(p.root,i.name)))throw Error('新しい原物があるため上書きしません');}
 if(!items.length)throw Error('復元する原物がありません。再実行せず照合してください');
 exclusive(path.join(batch,'restore-intent.json'),{resultFile});
 const out={id:p.id,complete:false,restored:[],active:null,failed:null};
 const save=()=>{const tmp=resultFile+'.'+randomUUID();exclusive(tmp,out);fs.renameSync(tmp,resultFile);persistence.syncDirectory(path.dirname(resultFile));};
 save();try{for(const i of items){out.active=i.name;save();const src=locate(p,i.name),dst=path.join(p.root,i.name);
  if(exists(dst)||fs.statSync(src).dev!==fs.statSync(p.root).dev)throw Error('同じディスクの空いた元の場所にだけ戻せます');
  fs.renameSync(src,dst);if(json(snapshot(dst))!==json(treeOf(i)))throw Error('復元後の内容を確認できません');
  for(const parent of [p.root,batch])persistence.syncDirectory(parent);out.restored.push(i.name);out.active=null;save();
 }out.complete=true;save();return out;}catch(e){out.failed=e.message;save();throw e;}
}
module.exports={snapshot,eligible,matchesProof,plan,apply,restore,locate};
if(require.main===module){
 const [mode,input,output]=process.argv.slice(2);
 if(mode==='--plan')fs.writeFileSync(output,JSON.stringify(plan(input,{protectedProjects:['子育て支援センター入退室開発プロジェクト']}),null,2),{flag:'wx',mode:0o600});
 else if(mode==='--apply')apply(JSON.parse(fs.readFileSync(input,'utf8')),output);
 else if(mode==='--restore')restore(JSON.parse(fs.readFileSync(input,'utf8')),output);
 else throw Error('--plan root output / --apply plan result / --restore plan result');
}
