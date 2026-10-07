'use strict';
const { lt } = require('./locale');
// 表示名と関係だけを変更し、場所・作業IDは保つ。
const fs = require('node:fs');
const path = require('node:path');
const {hash}=require('./completion');
const {randomUUID} = require('node:crypto');
const { parseDoc, setScalar, scalar } = require('./frontmatter');
function setList(text, key, values) {
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const lines = text.replace(/\r\n/g,'\n').split('\n'), end = lines.indexOf('---', 1);
  if(lines[0]!=='---' || end<1)throw Error(lt('台帳の先頭形式を確認してください'));
  let i = lines.findIndex((l,n)=>n>0 && n<end && l.startsWith(key+':'));
  if (i < 0) { i=end; lines.splice(i,0,''); }
  let j=i+1; while(j<end && /^(\s+\S|-\s)/.test(lines[j])) j++;
  lines.splice(i,j-i,`${key}:`,...values.map(v=>`  - ${scalar(v)}`));
  return lines.join(newline);
}
class Hierarchy {
  constructor(store, busy = () => false) { this.store=store; this.busy=busy; }
  resolve(ref, projects=this.store.listProjects()) {
    if (!ref) return '';
    const direct=projects.find(p=>p.id===ref); if(direct) return direct.id;
    const matches=projects.filter(p=>p.name===ref);
    if(matches.length!==1) throw Error(lt`関係先「${ref}」を一意に見つけられません。台帳のIDを確認してください`);
    return matches[0].id;
  }
  rename(project, task, value, expectedHash) {
    if(typeof expectedHash!=='string' || !expectedHash)throw Error(lt('内容を取得し直してから変更してください'));
    const name=String(value||'').trim();
    if (!name || name.length>(task?80:60) || /[\p{Cc}\u2028\u2029"]/u.test(name)) throw Error(lt('名前は1行で入力してください（引用符は使えません）'));
    const p=this.store.readProject(project); if(!p) throw Error(lt('プロジェクトがありません'));
    if(this.busy(project)) throw Error(lt('このプロジェクトでAIが作業中です。名前は区切りで変更してください'));
    if(task) {
      const file=this.store.taskFile(project,task); if(!file) throw Error(lt('作業がありません'));
      const t=this.store.readTask(file); if(t.completionHash!==expectedHash) throw Error(lt('名前を確認中に作業が更新されました'));
      const before=fs.readFileSync(file,'utf8');if(hash(before)!==expectedHash)throw Error(lt('確認中に作業が更新されました'));let text=setScalar(before,'title',name);
      if(before.includes('\r\n'))text=text.replace(/\r?\n/g,'\r\n');fs.writeFileSync(file,text);
      if(t.state==='完了') this.store.completion.approveTask(`${project}/${task}`,text);
      return this.store.readTask(file);
    }
    if(p.completionHash!==expectedHash) throw Error(lt('名前を確認中にプロジェクトが更新されました'));
    const projects=this.store.listProjects();
    if(projects.some(q=>q.id!==project && (q.name===name || q.id===name))) throw Error(lt('同じ名前のプロジェクトがあります'));
    if(name!==p.name && projects.some(q=>[q.parent,q.derivedFrom,...q.related].some(ref=>ref===name && !projects.some(x=>x.id===ref) && !projects.some(x=>x.name===ref))))throw Error(lt('この名前は孤立した参照先に使われています。別の名前を選んでください'));
    const changes=[];
    const normalize = ref => {
      if(ref !== p.name || ref === p.id || projects.some(q=>q.id===ref)) return ref;
      if(projects.filter(q=>q.name===ref).length!==1) throw Error(lt`関係先「${ref}」を一意に見つけられません。台帳のIDを確認してください`);
      return p.id;
    };
    for(const q of projects) {
      const file=path.join(q.dir,'PROJECT.md'), before=fs.readFileSync(file,'utf8');
      if(q.id===project && hash(before)!==expectedHash)throw Error(lt('確認中にプロジェクトが更新されました'));let text=before;
      const parent=normalize(q.parent), source=normalize(q.derivedFrom), related=q.related.map(normalize);
      if(parent!==q.parent) text=setScalar(text,'parent',parent);
      if(source!==q.derivedFrom) text=setScalar(text,'derivedFrom',source);
      if(related.some((r,i)=>r!==q.related[i])) text=setList(text,'related',related);
      if(q.id===project) text=setScalar(text,'name',name);
      if(text!==before && before.includes('\r\n'))text=text.replace(/\r?\n/g,'\r\n');
      if(text!==before) changes.push({file,before,text,id:q.id});
    }
    for(const c of changes) {
      if(this.busy(c.id)) throw Error(lt('参照先のプロジェクトでAIが作業中です。名前は区切りで変更してください'));
      if(fs.readFileSync(c.file,'utf8')!==c.before) throw Error(lt('確認中に参照が更新されました'));
    }
    if(!changes.length)return this.store.readProject(project);
    const backup=path.join(this.store.root,'_hub/hierarchy-backups',randomUUID());
    fs.mkdirSync(backup,{recursive:true});
    for(const c of changes) fs.writeFileSync(path.join(backup,`${c.id}.md`),c.before);
    const temps=[];
    try { for(const c of changes) { const tmp=c.file+'.'+randomUUID()+'.tmp';temps.push(tmp);fs.writeFileSync(tmp,c.text);fs.renameSync(tmp,c.file); } }
    catch(e) {
      const failures=[];
      for(const c of changes)try {fs.writeFileSync(c.file,c.before);}catch(err){failures.push(c.id);}
      for(const tmp of temps)try {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catch(err){/* 自動生成した一時物のみ */}
      throw Error(lt`${e.message}。変更前のバックアップ：${backup}${failures.length?lt('。自動復元できなかった台帳：')+failures.join(' / '):''}`);
    }
    return this.store.readProject(project);
  }
}
module.exports={Hierarchy};
