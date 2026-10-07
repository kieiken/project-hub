'use strict';
const { lt } = require('./locale');
// 祖先側の確認→子孫ごとの取り込み→受領→片付け。段階を保存し再開する。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const graph = require('../public/project-order'), git = require('./git');
const { noLinks, exists, snapshot } = require('./remove');
const hash = s => createHash('sha256').update(s).digest('hex');
const key = x => x.project + '\0' + x.task;
const expand = s => s?.startsWith('~/') ? path.join(os.homedir(),s.slice(2)) : s;
class TaskIntegrate {
  constructor({store,transfer,removal,baseOf=p=>p.dir,gitw=git}) {
    Object.assign(this,{store,transfer,removal,baseOf,gitw});this.tokens=new Map();
    this.dir=path.join(store.root,'_hub/task-integrations');
    transfer.beforeCleanup=r=>this.cleanupCopy(r);
  }
  file(project,task){return path.join(this.dir,hash(project+'\0'+task)+'.json');}
  read(project,task){const f=this.file(project,task);noLinks(f);return exists(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;}
  save(r){const f=this.file(r.project,r.task);noLinks(f);fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(f+'.tmp',JSON.stringify(r,null,2));fs.renameSync(f+'.tmp',f);}
  pending(){
    if(!exists(this.dir))return [];noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{
      try{const f=path.join(this.dir,n);noLinks(f);const r=JSON.parse(fs.readFileSync(f,'utf8'));return r.complete?[]:[{project:r.project,task:r.task,id:r.id,items:r.items.map(x=>({project:x.project,task:x.task,title:x.title,state:x.state}))}];}catch{return [];}
    });
  }
  ancestor(project,task){
    const all=this.store.listProjects(),p=all.find(x=>x.id===project),t=p?.tasks.find(x=>x.id===task);
    if(!t)throw Error(lt('統合する親作業が見つかりません'));
    if(this.removal.busy(project,task)||this.removal.locked(project))throw Error(lt('親作業でAI・整理・確認が動いています。この返事が終わってから統合してください'));
    const q=path.join(p.dir,'.ai/chat',task+'.queue.json');noLinks(q);
    if(exists(q)){const rows=JSON.parse(fs.readFileSync(q,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error(lt('親作業に順番待ちがあります'));}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))throw Error(lt('親の作業場所の記録が不正です'));
    if(copy&&!exists(wd))throw Error(lt('親の作業用コピーが見つかりません。記録を片付けてから統合してください'));
    const target=copy?wd:this.baseOf(p);noLinks(target);
    return {all,p,t,target};
  }
  details(a,p,t,ownId){
    const r=this.transfer.read(p.id,t.id),d=this.removal.describe(p.id,t.id);
    const blockers=d.blockers.filter(x=>!x.startsWith(lt('作業用コピー'))&&!x.startsWith(lt('下の作業や')));
    if(!graph.finished(t)||t.question)blockers.push(lt('子作業の手順・質問が残っています'));
    if(t.mergeExcluded)blockers.push(lt('取り込み対象から外されています'));
    if(t.kind==='derived'&&!require('./work-context').sourceOf(p,t.derivedFrom,a.all))blockers.push(lt('派生元が同じ大きなプロジェクト内にありません'));
    if(r?.complete)blockers.push(lt('受領済みの作業が復元されています。再統合はできません'));
    if(r?.integrating&&r.integrating!==ownId)blockers.push(lt('別の祖先の統合が進行中です'));
    if(r&&!r.handedUp&&!r.integrating&&!r.complete)blockers.push(lt('旧版の引渡しが進行中です。先にその続きを行ってください'));
    const ancestors=graph.ancestorsOf(p,t,a.all),depth=ancestors.findIndex(x=>x.project.id===a.p.id&&x.task.id===a.t.id)+1;
    const route=ancestors.slice(0,depth-1).reverse().map(x=>x.task.title).concat(t.title).join(' › ');
    const descendants=a.all.flatMap(q=>q.tasks.filter(x=>graph.ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id)).map(x=>({project:q.id,task:x.id,title:x.title,finished:graph.finished(x)&&!x.question})));
    if(descendants.some(x=>!x.finished))blockers.push(lt('未完了の子孫があります。先に下の作業を済ませてください'));
    const issue=this.transfer.resultIssue(p,t),candidates=issue.candidates;
    const {files,candidateError,skipped}=candidates;
    if(candidateError)blockers.push(lt`子の成果候補を確認できません：${candidateError}。子のAIに成果の整理を頼んでください`);
    else if(!issue.ok)blockers.push(issue.reason+lt('。子のAIに成果の整理を頼んでください'));
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))blockers.push(lt('子の作業場所の記録が不正です'));
    if(copy&&!exists(wd))blockers.push(lt('子の作業用コピーが見つかりません。記録を確認してください'));
    const preview=copy&&exists(wd)?this.gitw.preview({dir:wd,workRoot:this.removal.workRoot(p),target:a.target}):null;
    const source=copy&&exists(wd)?this.gitw.inspect(wd):null;
    if(copy&&!source)blockers.push(lt('子の作業用コピーのGitを確認できません'));
    if(copy&&source&&this.gitw.merging(wd))blockers.push(lt('子の作業用コピーで取り込みが途中です。解消して保存してください'));
    const {integrated,results,resultReady}=issue;
    const safeOptional=this.transfer.safeOptional(d.optional,files);
    const retained=d.optional.filter(m=>!safeOptional.includes(m));
    const needsResults=!issue.ok;
    return {project:p.id,task:t.id,title:t.title,taskHash:t.completionHash,route,depth,handedUp:Boolean(r?.handedUp),files,results,resultReady,needsResults,candidateError,skipped,selected:candidates.selected,copy:copy?wd:null,source,preview,integrated,descendants,blockers:[...new Set(blockers)],move:d.move,optional:safeOptional,retainedFolders:retained.map(m=>m.path),keep:[...d.keep,...retained.map(m=>({path:m.path,why:lt('未受領の内容があるためフォルダ全体を残します')}))]};
  }
  // AI開始時も保存された統合先を使い、途中で新しいコピーを作らない。
  startTarget(p,t){
    const r=this.read(p.id,t.id);if(!r||r.complete)return null;
    const target=r.target,base=this.baseOf(p),rel=target&&path.relative(this.removal.workRoot(p),target);
    if(!target || (path.resolve(target)!==path.resolve(base) && (!rel||rel.startsWith('..')||path.isAbsolute(rel))))throw Error(lt('途中の統合先の場所が不正です。統合の続きを確認してください'));
    noLinks(target);if(!exists(target))throw Error(lt('途中の統合先が見つかりません。統合の続きを確認してください'));
    // ファイル成果だけのGit未導入の本体も、保存先のまま開始する。
    // 衝突を解消するAIの開始だけは途中mergeを保持して許す。受領確認では拒否する。
    if(path.resolve(target)!==path.resolve(base)||this.gitw.repoTop(base))this.gitw.recoveryTarget(target,base,{clean:false,allowMerge:true});
    return {dir:target,note:lt`途中の統合先 ${target} で作業します。新しい作業用コピーは作りません`};
  }
  resumePreview(a,r){
    const changed=path.resolve(r.target)!==path.resolve(a.target),reasons=[],blockers=[];
    if(changed)reasons.push(lt('統合先が変わっています'));
    if(this.gitw.merging(a.target))blockers.push(lt('統合先で取り込みが途中です。解消して保存してください'));
    const items=r.items.map(i=>{
      if(i.state==='片付け済み')return {...i,retained:true};
      const h=this.transfer.read(i.project,i.task),out={...i,blockers:[]};
      // 受領の開始以降は保存した受領段階から再開し、再選択しない。
      if(!h?.integrating&&!h?.complete&&!h?.destination)out.reservationMissing=true;
      if(!h || h.integrating!==r.id)out.blockers.push(lt('子の統合予約が変わりました'));
      if(changed && h?.complete)out.blockers.push(lt('子の受領記録が完了しています。保存された統合先で続きを確認してください'));
      if(h?.receiving||h?.complete){out.receiving=true;return out;}
      const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
      if(!t){out.blockers.push(lt('子作業が見つかりません'));return out;}
      const why=graph.integrateBlock({project:a.p,task:a.t},p,t,a.all);if(why)out.blockers.push(why);
      const now=this.details(a,p,t,r.id);out.blockers.push(...now.blockers);
      out.results=now.results;out.resultReady=now.resultReady;out.taskHash=now.taskHash;out.source=now.source;out.copy=now.copy;out.branch=now.source?.branch;
      out.recordChanged=i.taskHash!==now.taskHash;out.sourceChanged=JSON.stringify(i.source)!==JSON.stringify(now.source)||i.copy!==now.copy;
      if(out.recordChanged)reasons.push(lt`子作業「${i.title}」の記録が更新されています`);
      if(out.sourceChanged)reasons.push(lt`子作業「${i.title}」の変更が更新されています`);
      out.codeAlready=Boolean(now.source?.head&&!now.source.status&&this.gitw.isAncestor(a.target,now.source.head));
      for(const f of i.files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))out.blockers.push(lt('成果ファイルが変わりました。元の記録は残しています'));
      if((i.optional||[]).some(id=>!now.optional.some(f=>f.id===id)))out.blockers.push(lt('片付ける専用フォルダが変わりました'));
      return out;
    });
    const recover=changed||items.some(i=>i.recordChanged||i.sourceChanged);
    // 初回の予約保存だけが中断した場合は、従来どおりrunで予約を補う。復旧時は一致必須。
    if(!recover)for(const i of items)if(i.reservationMissing)i.blockers=i.blockers.filter(x=>x!=='子の統合予約が変わりました');
    const targetSnapshot=this.gitw.inspect(a.target);
    if(recover){
      try{this.gitw.recoveryTarget(a.target,this.baseOf(a.p));}catch(e){blockers.push(e.message);}
    }
    // 同じパスの履歴も変わり得る。全再開で保存済みの取り込みを照合してから受領する。
    for(const i of r.items)if(i.integrated?.commit&&!this.gitw.isAncestor(a.target,i.integrated.commit))blockers.push(lt('済んだ子の取り込みが現在の統合先にありません：')+i.title);
    for(const i of items)blockers.push(...(i.blockers||[]));
    return {project:r.project,task:r.task,target:a.target,resume:true,id:r.id,items,ancestorHash:a.t.completionHash,targetSnapshot,recordHash:hash(JSON.stringify(r)),handoffHash:hash(JSON.stringify(r.items.map(i=>this.transfer.read(i.project,i.task)))),blockers:[...new Set(blockers)],recover:recover?{savedTarget:r.target,currentTarget:a.target,reasons}:null};
  }
  preview(project,task,only){
    const a=this.ancestor(project,task),old=this.read(project,task);
    if(old&&!old.complete){
      return this.token(this.resumePreview(a,old));
    }
    if(this.gitw.merging(a.target))throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
    let items=a.all.flatMap(p=>p.tasks.filter(t=>graph.canIntegrate({project:a.p,task:a.t},p,t,a.all)&&graph.finished(t)).map(t=>this.details(a,p,t)));
    if(only){
      if(!Array.isArray(only))throw Error(lt('統合対象を確認してください'));
      const keys=new Set(only.map(key));
      for(const x of only){
        this.transfer.expectTitle(x.project,x.task,x.expectTitle);
        if(!items.some(i=>key(i)===key(x))){
          const p=a.all.find(p=>p.id===x.project),t=p?.tasks.find(t=>t.id===x.task);
          throw Error(graph.integrateBlock({project:a.p,task:a.t},p,t,a.all)||lt('統合対象が変わりました。もう一度確認してください'));
        }
      }
      // 子を選んだ時は完了した孫も拾い、下から片付ける。
      for(const i of items)if(keys.has(key(i)))for(const d of i.descendants)keys.add(key(d));
      items=items.filter(i=>keys.has(key(i)));
    }
    items.sort((x,y)=>y.depth-x.depth||(x.preview?.files||0)-(y.preview?.files||0)||x.title.localeCompare(y.title));
    for(const i of items){
      if(i.descendants.some(d=>!items.some(x=>key(x)===key(d))))i.blockers.push(lt('子孫を先に統合する必要があります'));
      if(i.descendants.some(d=>items.find(x=>key(x)===key(d))?.blockers.length))i.blockers.push(lt('先に統合する子孫に確認が必要です'));
      i.overlaps=items.filter(j=>key(j)!==key(i)&&(j.preview?.paths||[]).some(f=>i.preview?.paths?.includes(f))).map(j=>j.title);
    }
    return this.token({project,task,target:a.target,ancestorHash:a.t.completionHash,targetSnapshot:this.gitw.inspect(a.target),items});
  }
  token(value){for(const [id,x]of this.tokens)if(Date.now()-x.at>600000)this.tokens.delete(id);const token=randomUUID();this.tokens.set(token,{at:Date.now(),value});return {...value,token};}
  apply({project,task,token,selected,confirm,recover}){
    const x=this.tokens.get(token);
    if(!x||Date.now()-x.at>600000||confirm!==true||x.value.project!==project||x.value.task!==task)throw Error(lt('もう一度統合内容を確認してください'));
    const d=x.value,a=this.ancestor(project,task);let r=this.read(project,task);
    if(r?.complete&&r.id===d.id)return {ok:true,complete:true,duplicate:true};
    if(!d.resume){
      if(r&&!r.complete)throw Error(lt('別の統合が始まりました。続きを確認してください'));
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(this.gitw.inspect(a.target))!==JSON.stringify(d.targetSnapshot))throw Error(lt('確認中に親作業・統合先が変わりました'));
      if(!Array.isArray(selected)||!selected.length||new Set(selected.map(key)).size!==selected.length)throw Error(lt('統合する子作業を選んでください'));
      const items=selected.map(s=>{
        const i=d.items.find(i=>key(i)===key(s));if(!i||i.blockers.length)throw Error(i?.blockers.join(' / ')||lt('統合対象が不正です'));
        const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error(lt('確認中に子作業・祖先の関係が変わりました'));
        const now=this.details(a,p,t);if(now.blockers.length)throw Error(now.blockers.join(' / '));
        if(JSON.stringify(now.source)!==JSON.stringify(i.source))throw Error(lt('確認中に子の変更が変わりました'));
        if(JSON.stringify(now.files)!==JSON.stringify(i.files))throw Error(lt('確認中に成果ファイルが変わりました'));
        const ids=s.files===undefined?i.selected:s.files;
        if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!i.files.some(f=>f.id===id)))throw Error(lt('成果ファイルの選択が不正です'));
        const optional=s.optional===undefined?i.optional.map(f=>f.id):s.optional;if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!i.optional.some(f=>f.id===id)))throw Error(lt('片付ける専用フォルダが不正です'));
        // 新規統合では成果全件を受け取る。APIでも人による間引きを許さない。
        if(ids.length!==i.files.length)throw Error(lt('成果はAIが整理した全件を統合してください'));
        if(JSON.stringify(now.results)!==JSON.stringify(i.results))throw Error(lt('確認中に成果の保存記録が変わりました'));
        const files=i.files.filter(f=>ids.includes(f.id));if(!files.length&&!i.copy&&!i.integrated?.files?.length&&!i.resultReady)throw Error(lt('成果の記録を先に整えてください'));
        for(const f of files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('確認中に成果ファイルが変わりました'));
        return {...i,files,optional,allResults:true,branch:i.source?.branch,state:'待ち'};
      });
      // 表示順を変更できても孫→子の制約は崩さない。
      for(let n=0;n<items.length;n++)for(const kid of items[n].descendants)if(!items.slice(0,n).some(i=>key(i)===key(kid)))throw Error(lt('子孫を一緒に選び、孫から先に統合してください'));
      // HEAD・status・内容が同じでも別のmergeが始まり得る。記録・予約の保存直前に拒否する。
      if(this.gitw.merging(a.target))throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
      r={id:randomUUID(),project,task,target:a.target,items,at:new Date().toISOString(),complete:false};this.save(r);d.id=r.id;
      for(const i of items){const h=this.transfer.read(i.project,i.task);if(h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }else {
      if(!r||r.id!==d.id||r.complete||hash(JSON.stringify(r))!==d.recordHash)throw Error(lt('統合記録が変わりました'));
      const now=this.resumePreview(a,r);
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(now)!==JSON.stringify(d))throw Error(lt('確認中に親・子・統合先・予約が変わりました。もう一度続きを確認してください'));
      if(now.blockers.length)throw Error(now.blockers.join(' / '));
      if(d.recover && recover!==true)throw Error(lt('復旧内容を確認し、統合先と子の更新を承認してください'));
      if(d.recover){
        if(path.resolve(r.target)!==path.resolve(d.target)){
          r.targetHistory=[...(r.targetHistory||[]),{from:r.target,to:d.target,at:new Date().toISOString(),reason:d.recover.reasons.join(' / ')}];r.target=d.target;
        }
        for(let n=0;n<r.items.length;n++){
          const i=r.items[n],v=d.items[n];if(i.state==='片付け済み'||v.receiving)continue;
          if(v.sourceChanged||path.resolve(d.recover.savedTarget)!==path.resolve(d.target))i.state='待ち';
          Object.assign(i,{taskHash:v.taskHash,source:v.source,copy:v.copy,branch:v.branch,results:v.results,resultReady:v.resultReady});
        }
        this.save(r);
      }
    }
    if(path.resolve(a.target)!==path.resolve(r.target))throw Error(lt('統合先が変わりました'));
    this.active=r;
    try { return this.run(r); }catch(e){r.error=e.message;this.save(r);throw e;}finally{this.active=null;}
  }
  run(r){
    const a=this.ancestor(r.project,r.task);
    // 初回の予約保存が途中で止まった場合も、残りを予約してから処理する。
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const h=this.transfer.read(i.project,i.task);
      if(h?.integrating&&h.integrating!==r.id)throw Error(lt('別の祖先が同じ子を統合しています'));
      if(!h?.integrating){if(h?.complete||h?.destination)throw Error(lt('子の受領記録が変わりました'));this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const waiting=(i.descendants||[]).filter(d=>r.items.some(x=>key(x)===key(d)&&x.state!=='片付け済み'));
      if(waiting.length){i.waitingFor=waiting.map(x=>x.title);this.save(r);continue;}
      delete i.waitingFor;
      const receipt=this.transfer.read(i.project,i.task);
      if(receipt?.integrating!==r.id)throw Error(lt('子の統合予約が変わりました'));
      if(!receipt.receiving&&!receipt.complete){
        const current=this.ancestor(r.project,r.task),p=current.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:current.p,task:current.t},p,t,current.all))throw Error(lt('途中で子作業・祖先の関係が変わりました'));
        const details=this.details(current,p,t,r.id);if(details.blockers.length)throw Error(details.blockers.join(' / '));
        if(JSON.stringify(details.source)!==JSON.stringify(i.source))throw Error(lt('途中で子の変更が変わりました。続きを確認してください'));
        if(i.results && JSON.stringify(details.results)!==JSON.stringify(i.results))throw Error(lt('途中で成果の保存記録が変わりました。続きを確認してください'));
        if(i.allResults && JSON.stringify(details.files)!==JSON.stringify(i.files))throw Error(lt('途中で成果ファイルが変わりました。続きを確認してください'));
        for(const f of i.files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('成果ファイルが変わりました'));
        if(i.state==='待ち'||i.state==='衝突'){
          if(i.copy){
            const merged=this.gitw.merge({dir:i.copy,workRoot:this.removal.workRoot(p),title:`${i.task} ${i.title}`,target:r.target,cleanup:false});
            if(merged.conflict){
              i.state='衝突';i.conflictPaths=merged.conflictPaths||[];i.conflictKind='content';this.save(r);
              continue;
            }
            if(!merged.ok)throw Error(merged.error);
            delete i.conflictPaths;delete i.conflictKind;i.autoResolved=merged.autoResolved||i.autoResolved;
            i.integrated={dir:r.target,commit:merged.commit,files:merged.files,already:merged.already};i.sourceSnapshot=this.gitw.inspect(i.copy);i.sourceHead=i.sourceSnapshot.head;i.source=i.sourceSnapshot;
          }
          i.state='取り込み済み';this.save(r);
        }
      }
      const out=this.transfer.receiveIntegrated({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,results:i.results,optional:i.optional});
      i.receipt=out.record;i.state='片付け済み';this.save(r);
    }
    const conflicts=r.items.filter(i=>i.state==='衝突').map(i=>({project:i.project,task:i.task,title:i.title,paths:i.conflictPaths||[]}));
    if(conflicts.length){
      r.error=lt('コードがぶつかった子を後回しにしました');this.save(r);
      this.store.updateTask(r.project,r.task,{state:'返事待ち',question:conflicts.map(i=>lt`子作業「${i.title}」でぶつかりました（${i.paths.join('、')}）`).join(' ／ ')+lt`。統合先 ${r.target} で［AIでぶつかりを解消］を頼み、AI終了後に［統合の続きを行う］を押してください。新しい作業用コピーは作りません`});
      return {ok:false,partial:true,conflict:true,complete:false,conflicts,error:r.error,items:r.items};
    }
    r.complete=true;r.error='';this.save(r);
    return {ok:true,complete:true,items:r.items.map(x=>({title:x.title,state:x.state})),parentProject:a.p.id,parent:a.t.id};
  }
  resultsRequest({project,task,childProject,childTask,token}) {
    const x=this.tokens.get(token),d=x?.value;
    if(!d||Date.now()-x.at>600000||d.project!==project||d.task!==task||d.resume)throw Error(lt('もう一度統合内容を確認してください'));
    const a=this.ancestor(project,task),i=d.items.find(i=>i.project===childProject&&i.task===childTask);
    if(!i?.needsResults)throw Error(lt('成果の整理が必要な子を確認してください'));
    const p=a.all.find(p=>p.id===childProject),t=p?.tasks.find(t=>t.id===childTask);
    if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error(lt('確認中に子作業が変わりました'));
    const now=this.details(a,p,t);
    if(!now.needsResults||now.blockers.some(b=>!b.includes('成果')&&!b.includes('保存済み')&&!b.includes('本体保存済み')))throw Error(lt('子の作業状態を先に確認してください'));
    return {...this.transfer.organizeRequest(p,t,now.candidateError || lt('成果の記録を確認してください')),title:lt('統合する成果の整理')};
  }
  conflictRequest({project,task,childProject,childTask,token}){
    const x=this.tokens.get(token),a=this.ancestor(project,task),r=this.read(project,task);
    if(!x||Date.now()-x.at>600000||!x.value.resume||x.value.project!==project||x.value.task!==task||!r||r.complete||r.id!==x.value.id)throw Error(lt('もう一度統合の続きを確認してください'));
    const now=this.resumePreview(a,r);
    if(JSON.stringify(now)!==JSON.stringify(x.value))throw Error(lt('確認中に親・子・統合先・予約が変わりました'));
    if(now.blockers.length)throw Error(now.blockers.join(' / '));
    if(now.recover)throw Error(lt('先に統合先と子の更新を確認して続けてください'));
    const i=r.items.find(i=>i.project===childProject&&i.task===childTask);
    if(!i||i.state!=='衝突'||!i.branch||!i.copy)throw Error(lt('衝突した子作業を選んでください'));
    return {project,task,title:lt`ぶつかりを解消：${i.title}`,text:lt`目的：子作業「${i.title}」のコードのぶつかりを解消する。
読む：保存された統合先 ${r.target}、ブランチ ${i.branch}、衝突パス ${JSON.stringify(i.conflictPaths||[])}。
やる：この統合先でブランチをmergeし、両側の意図を保って解消。関連試験と版・履歴の一致を確認してcommitする。
条件：新しいコピーを作らない。ours/theirsの一括採用は禁止。意味を決められない時は推測せず[[質問]]形式で人に聞いて止まる。統合・受領・片付けの記録は変更しない。
出力：保存したcommitと試験結果をこの親の会話へ返す。
次：AI終了後に人が［統合の続きを行う］で正式受領と片付けを進める。`};
  }
  cleanupCopy(receipt){
    const r=this.active?.id===receipt.integrating?this.active:this.read(receipt.targetProject,receipt.targetTask),i=r?.items.find(x=>x.project===receipt.project&&x.task===receipt.task);
    if(!r||r.id!==receipt.integrating||!i)throw Error(lt('統合の片付け記録が見つかりません'));
    if(!i.copy||i.copyTrashed)return;
    if(!exists(i.copy)){
      // 移動後に停止しても、退避先とコミットを照合して登録整理を続ける。
      if(!i.copyTrashPlanned||!exists(i.copyTrashPlanned)||!i.sourceHead||!this.gitw.isAncestor(r.target,i.sourceHead))throw Error(lt('作業用コピーの退避先を確認できません'));
      noLinks(i.copyTrashPlanned);
      this.gitw.finishCleanupCopy({target:r.target,branch:i.branch,sourceHead:i.sourceHead});
      i.copyTrashed=i.copyTrashPlanned;this.save(r);return;
    }
    const out=this.gitw.cleanupCopy({dir:i.copy,workRoot:path.join(this.store.root,'Work',i.project),target:r.target,expectedSnapshot:i.sourceSnapshot,beforeMove:({trashed,branch,sourceHead})=>{i.copyTrashPlanned=trashed;i.branch=branch;i.sourceHead=sourceHead;this.save(r);}});
    i.copyTrashed=out.trashed;this.save(r);
  }
}
module.exports={TaskIntegrate};
