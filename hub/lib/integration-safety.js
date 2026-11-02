'use strict';
// Confirmation is semantic; receipt/migration still owns the full original text.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {parseDoc}=require('./frontmatter'),resource=require('./resource-scope'),{snapshot}=require('./remove');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function parent(a){
 const t=a.t;
 return hash([resource.canonical(a.target),a.p.id,a.p.parent,a.p.derivedFrom,a.p.folders,
  [t.id,t.parent,t.derivedFrom,t.kind,t.workspaceMode,t.workdir,t.mergeExcluded,t.question,t.state,t.continuation],
  a.all.flatMap(p=>p.tasks.filter(x=>x.id===t.id&&p.id===a.p.id||require('../public/project-order').ancestorsOf(p,x,a.all).some(c=>c.project.id===a.p.id&&c.task.id===t.id)).map(t=>[p.id,t.id,p.parent,p.derivedFrom,t.parent,t.derivedFrom,t.kind])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}
function task(file){
 const {data,body}=parseDoc(fs.readFileSync(file,'utf8'));
 delete data.updated;delete data.workspaceStarted;
 // Display notes have no bearing on receipt authorization; their current raw
 // text is captured again before starting, and guarded thereafter.
 const {sectionPattern}=require('./locale');
 const meaningful=body.replace(new RegExp('^## (?:'+sectionPattern('メモ')+'|'+sectionPattern('やったこと')+'|Memo|Done)\\s*\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))','gm'),'');
 return {data,body:meaningful.trimEnd()};
}
function item(h,i){
 return hash([task(h.store.taskFile(i.project,i.task)),i.source,i.files,i.results,i.remaining,i.descendants,i.offerId,i.questionBinding||null,i.previous,i.receiptState,
  [...i.move,...i.optional,...i.keep].map(x=>[x.path,x.copy||null,x.id||null]),
  i.optional.map(x=>[x.path,snapshot(x.path,{contentOnly:true})])]);
}
function target(h,a){
 // A null inspection is permitted only for a genuinely Git-free direct body.
 // A damaged .git directory/failed status never becomes a clean destination.
 const value=require('./integration-writes').inspect(h.gitw,a.target);
 if(value)return value;
 let current=path.resolve(a.target);
 for(;;){if(fs.existsSync(path.join(current,'.git')))throw Error('統合先のGitを確認できません');const up=path.dirname(current);if(up===current)break;current=up;}
 if(resource.canonical(a.target)!==resource.canonical(h.baseOf(a.p)))throw Error('統合先のGitを確認できません');
 return {head:null,status:'',direct:true,dir:resource.canonical(a.target)};
}
async function targetAsync(h,a){
 // A null inspection is permitted only for a genuinely Git-free direct body.
 // A damaged .git directory/failed status never becomes a clean destination.
 const value=await require('./integration-writes').inspectAsync(h.gitw,a.target);
 if(value)return value;
 let current=path.resolve(a.target);
 for(;;){if(fs.existsSync(path.join(current,'.git')))throw Error('統合先のGitを確認できません');const up=path.dirname(current);if(up===current)break;current=up;}
 if(resource.canonical(a.target)!==resource.canonical(h.baseOf(a.p)))throw Error('統合先のGitを確認できません');
 return {head:null,status:'',direct:true,dir:resource.canonical(a.target)};
}
function blockers({b,all,baseOf,expand=x=>x,activities,global=[],op='receipt',target,paths=[]}){
 if(!['receipt','main-merge'].includes(op))throw Error('統合操作の種類を確認できません');
 const p=all.find(p=>p.id===b.project),t=p?.tasks.find(t=>t.id===b.task);
 if(!t)return [{kind:'unknown',message:'統合対象の保存先を確認できません'}];
 if(op==='main-merge'){
  if(!target)return [{kind:'unknown',message:'本体の保存先を確認できません'}];
  const main=resource.canonical(target),changed=paths.map(f=>resource.canonical(path.resolve(target,f)));
  return [...activities.flatMap(a=>{
   if(!a.project)return ['rebuild','cli','update','restart'].includes(a.kind)?[a]:[];
   const q=all.find(p=>p.id===a.project),x=q?.tasks.find(t=>t.id===a.task);
   let conflict='';
   if(a.project===p.id&&(!a.task||a.task===t.id))conflict=expand(t.workdir)||baseOf(p);
   else if(!q)conflict=target;
   else {
    const work=x?expand(x.workdir)||baseOf(q):baseOf(q);
    if(resource.overlaps(main,resource.canonical(work))||['github','maintenance'].includes(a.kind)&&resource.commonGit(work)===resource.commonGit(target))conflict=work;
    else {
     const records=x?[path.join(q.dir,'.ai/tasks',x.id+'.md'),path.join(q.dir,'作業',x.id),
      ...[x.id+'.json',x.id+'.jsonl',x.id+'.queue.json'].map(n=>path.join(q.dir,'.ai/chat',n))]:[q.dir];
     conflict=changed.find(f=>records.some(r=>resource.overlaps(f,resource.canonical(r)))||x&&f.startsWith(resource.canonical(path.join(q.dir,'.ai/chat',x.id))+'.'))||'';
    }
   }
   return conflict?[{...a,conflictsWith:conflict,message:a.message+' → 本体取り込みと競合：'+conflict}]:[];
  }),...global];
 }
 const selected=b.selected||b.items||[],pairs=[{project:p.id,task:t.id},...selected];
 const dirs=[expand(t.workdir)||baseOf(p)];
 for(const c of pairs){const q=all.find(p=>p.id===c.project),x=q?.tasks.find(t=>t.id===c.task);if(!x)continue;
  dirs.push(path.join(q.dir,'.ai/tasks',x.id+'.md'),path.join(q.dir,'.ai/chat',x.id),path.join(q.dir,'作業',x.id));
  if(c.task!==t.id||c.project!==p.id)dirs.push(expand(x.workdir)||baseOf(q));
 }
 const own={dirs:dirs.map(resource.canonical),git:[...new Set(dirs.map(resource.commonGit).filter(Boolean))]};
 return [...activities.filter(a=>{
  // Truly global writes (Hub replacement, restart, tool installation) have no task scope.
  if(!a.project)return ['rebuild','cli','update','restart'].includes(a.kind);
  const q=all.find(p=>p.id===a.project),x=q?.tasks.find(t=>t.id===a.task);
  if(!q)return true;
  if(pairs.some(c=>c.project===a.project&&(!a.task||c.task===a.task)))return true;
  const locations=a.task&&x?[expand(x.workdir)||baseOf(q),path.join(q.dir,'.ai/tasks',x.id+'.md'),path.join(q.dir,'.ai/chat',x.id)]:[q.dir,baseOf(q)];
  return resource.shared(own,{dirs:locations.map(resource.canonical),git:locations.map(resource.commonGit).filter(Boolean)});
 }).map(a=>({...a,conflictsWith:`${p.name||p.id}／${t.title||t.id}`,message:a.message+` → ${p.name||p.id}／${t.title||t.id}の統合・保存先と競合` })),...global];
}
function assertTarget(h,a){const value=target(h,a),merging=h.gitw.merging(a.target);if(value.status||merging){const paths=value.status.split('\n').filter(Boolean).map(x=>x.replace(/^\s*[? MADRCU!]+\s+/,''));const e=Error(merging?'統合先で取り込みが途中です':'統合先の未保存の変更を保存してください：'+paths.slice(0,20).join('、')+(paths.length>20?' ほか'+(paths.length-20)+'件':''));Object.assign(e,{code:'INTEGRATION_TARGET_DIRTY',stage:merging?'merge':'save',paths});throw e;}return value;}
const confirmationParent=a=>hash([parent(a),task(path.join(a.p.dir,'.ai/tasks',a.t.id+'.md'))]);
module.exports={hash,parent,confirmationParent,item,target,targetAsync,assertTarget,blockers};
