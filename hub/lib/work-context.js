'use strict';
const { lt } = require('./locale');
function parentId(p, all) { return all.find(x=>x.id===p.parent)?.id || (all.filter(x=>x.name===p.parent).length===1 ? all.find(x=>x.name===p.parent).id : ''); }
function familyRoot(p, all) {
 const seen=new Set(); let cur=p;
 while(cur && !seen.has(cur.id)) {seen.add(cur.id); const id=parentId(cur,all); if(!id)return cur.id;cur=all.find(x=>x.id===id);}
 return p.id;
}
function family(p, all) { const root=familyRoot(p,all);return all.filter(q=>familyRoot(q,all)===root); }
function sourceOf(p, value, all) {
 if(!value)return null;
 const slash=value.indexOf('/'), pid=slash<0?p.id:value.slice(0,slash), tid=slash<0?value:value.slice(slash+1);
 const project=family(p,all).find(q=>q.id===pid),task=project?.tasks.find(t=>t.id===tid);
 return task ? {project,task} : null;
}
function validateTask(p,t,change,all) {
 const kind=change.kind ?? t?.kind ?? 'main', ref=change.derivedFrom ?? t?.derivedFrom ?? '', mode=change.workspaceMode ?? t?.workspaceMode ?? 'isolated';
 if(!['main','derived'].includes(kind) || !['isolated','direct'].includes(mode)) throw Error(lt('作業の種類・場所を確認してください'));
 if(kind==='derived') {
  let src=sourceOf(p,ref,all); if(!src)throw Error(lt('同じ大きなプロジェクト内から派生元を選んでください'));
  const seen=new Set(t?[`${p.id}/${t.id}`]:[]);
  while(src) {const key=`${src.project.id}/${src.task.id}`;if(seen.has(key))throw Error(lt('派生元が循環しています'));seen.add(key);src=sourceOf(src.project,src.task.derivedFrom,all);}
 }
 const parent=change.parent ?? t?.parent ?? '';
 if(parent && change.parent !== undefined) {
  let cur=p.tasks.find(x=>x.id===parent),seen=new Set(t?[t.id]:[]);
  if(!cur)throw Error(lt('親作業が見つかりません'));
  while(cur) {if(seen.has(cur.id))throw Error(lt('親子関係が循環しています'));seen.add(cur.id);cur=p.tasks.find(x=>x.id===cur.parent);}
 }
 return {kind,derivedFrom:kind==='derived'?ref:'',workspaceMode:mode};
}
module.exports={familyRoot,family,sourceOf,validateTask};
