'use strict';
const { lt } = require('./locale');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { noLinks, exists } = require('./remove');
const { scalar } = require('./frontmatter');
const chat = require('./chat');
const SETTINGS = ['AGENTS.md','CLAUDE.md','GEMINI.md','.ai/rules.md','.ai/freetalk.json'];
function nextMonth(value) {
  const d = new Date(value), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth()+1);
  const last = new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); d.setDate(Math.min(day,last));
  return d.toISOString();
}
const dayNumber = d => Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()) / 86400000;
class FreetalkLifecycle {
  constructor(history, busy = () => '', now = () => new Date(), template) {
    this.history=history; this.ft=history.ft; this.store=this.ft.store; this.busy=busy; this.now=now; this.template=template; this.operating=false; this.error='';
    this.file=path.join(this.ft.ledger,'.ai/freetalk-maintenance.json');
  }
  state() {
    this.ft.verify(); noLinks(this.file);
    if (exists(this.file)) {
      const s=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if (!Number.isFinite(Date.parse(s.lastClean)) || !Number.isFinite(Date.parse(s.due))) throw Error(lt('掃除の期限を確認できません'));
      return s;
    }
    const activated=fs.statSync(path.join(this.ft.dir,'.ai/freetalk.json')).mtime.toISOString();
    const s={lastClean:activated,due:nextMonth(activated)}; this.save(s); return s;
  }
  save(state) {
    noLinks(this.file); const tmp=this.file+'.'+randomUUID(); fs.writeFileSync(tmp,JSON.stringify(state)+'\n',{flag:'wx'});
    try { fs.renameSync(tmp,this.file); } catch(e) { fs.unlinkSync(tmp); throw e; }
  }
  reason() { return this.operating ? lt('プロジェクト化・掃除の途中です。終了後に操作してください') : this.busy(); }
  status() {
    const s=this.state(), now=this.now(), days=Math.ceil(dayNumber(new Date(s.due))-dayNumber(now));
    const overdue=now.getTime()>=Date.parse(s.due), reason=this.reason();
    return {...s,days,overdue,notice:days<=7,reason,error:this.error,delayed:overdue && Boolean(reason)};
  }
  // 話題の添付と共通相談ファイルだけ。別話題・AI設定・話題メモリは移さない。
  files(task) {
    this.history.topic(task); const rows=[]; let bytes=0, count=0;
    const walk=(file)=>{
      noLinks(file); const st=fs.lstatSync(file); if (++count>20000) throw Error(lt('ファイルが多すぎます'));
      if(st.isDirectory()) { for(const n of fs.readdirSync(file).sort())walk(path.join(file,n)); return; }
      if(!st.isFile())throw Error(lt('特殊なファイルは移せません'));
      bytes+=st.size; if(bytes>256*1024*1024)throw Error(lt('移すファイルが大きすぎます'));
      const rel=path.relative(this.ft.dir,file); rows.push({path:rel,size:st.size,hash:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
    };
    for(const n of fs.readdirSync(this.ft.dir).sort())if(!['.ai','AGENTS.md','CLAUDE.md','GEMINI.md','topics'].includes(n))walk(path.join(this.ft.dir,n));
    const base=path.join(this.ft.dir,'topics',task); noLinks(base);
    if(exists(base))for(const n of fs.readdirSync(base).sort())if(n!=='.ai')walk(path.join(base,n));
    return rows;
  }
  preview(task) {
    this.history.idle(task); const h=this.history.status(task), files=this.files(task);
    if(!h.draft)throw Error(lt('この話題のAIが作った要約を確認してください'));
    const s=this.history.state(task); let promotion=s.promotion;
    if(!promotion || promotion.summaryId!==h.summaryId || promotion.filesHash!==this.filesHash(files)) {
      // この保存もrevisionへ含まれるため、保存後のrevisionを確認画面へ返す。
      promotion={id:randomUUID(),summaryId:h.summaryId,filesHash:this.filesHash(files)};
      this.history.save(task,{...s,promotion});
    }
    return {operationId:promotion.id,revision:this.history.revision(task),summaryId:h.summaryId,summary:h.draft,name:this.history.topic(task).t.title,files};
  }
  filesHash(files) { return createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
  promote(task,b) {
    const s=this.history.state(task);
    if(s.migrated) {
      if(s.migrated.operationId===b.operationId)return {...s.migrated,ok:true,repeated:true};
      throw Error(lt('この話題は移行済みです'));
    }
    this.history.idle(task); const reason=this.reason();if(reason)throw Error(reason);
    const h=this.history.status(task), all=this.files(task);
    if(b.confirm!==true || !s.promotion || b.operationId!==s.promotion.id || b.revision!==h.revision || b.summaryId!==h.summaryId || !h.draft || s.promotion.filesHash!==this.filesHash(all))throw Error(lt('会話やファイルが更新されました。もう一度確認してください'));
    if(typeof b.summary!=='string' || !b.summary.trim() || b.summary.length>50000)throw Error(lt('引き継ぐ要約を確認してください'));
    const name=typeof b.name==='string'?b.name.trim():'';
    if(!name || name.length>60 || /[\/\\\0\r\n]/.test(name) || /^[._]/.test(name) || name.toLowerCase()==='freetalk')throw Error(lt('プロジェクト名を確認してください'));
    if(!Array.isArray(b.files) || new Set(b.files).size!==b.files.length || b.files.some(f=>!all.some(a=>a.path===f)))throw Error(lt('移すファイルを選び直してください'));
    const dest=path.join(this.store.product,name); noLinks(dest);
    if(exists(dest) || this.store.listProjects().some(p=>p.name.toLowerCase()===name.toLowerCase()))throw Error(lt('同じ名前のプロジェクトがあります'));
    const stage=path.join(this.store.product,'.freetalk-'+b.operationId),trash=this.trash('project');noLinks(stage);
    const moved=[]; let published=false; this.operating=true;
    try {
      fs.mkdirSync(stage);
      if(this.template)fs.cpSync(this.template,stage,{recursive:true,filter:src=>!['PROJECT.md','.gitkeep'].includes(path.basename(src))});
      for(const dir of ['資料','作業','成果物','.ai/tasks','.ai/memory','.ai/work','.ai/chat'])fs.mkdirSync(path.join(stage,dir),{recursive:true});
      fs.writeFileSync(path.join(stage,'PROJECT.md'),`---\nname: ${scalar(name)}\nstatus: 進行中\nupdated: ${this.now().toISOString().slice(0,10)}\nphases:\n  - { name: 計画, state: 進行中 }\n  - { name: 作る, state: 未着手 }\n  - { name: チェック, state: 未着手 }\nfolders:\n  本体: ${scalar(dest)}\nrelated: []\nchats: []\nissues: []\n---\n# メモ\nfreetalkから確認済み要約で独立しました。会話原文と移した資料は「資料」に保存しています。\n`);
      const {t,file}=this.history.topic(task),id=this.now().toISOString().slice(0,10).replace(/-/g,'')+'-01';
      fs.writeFileSync(path.join(stage,'.ai/tasks',id+'.md'),`---\nid: ${id}\ntitle: ${scalar(name)}\nstate: 未着手\nworkspaceMode: direct\nworkdir: ${scalar(dest)}\nowner: ${scalar(t.owner)}\nmodel: ${scalar(t.model)}\neffort: ${scalar(t.effort)}\nquestion:\n---\n## 手順\n- [ ] 引き継いだ内容を確認し、進め方を決める\n`);
      const transcript=chat.files(this.ft.ledger,task).log;
      fs.copyFileSync(transcript,path.join(stage,'資料/自由対話原文.jsonl'));
      const mapping=b.files.map(rel=>({from:path.join(this.ft.dir,rel),to:path.join(dest,'資料/相談ファイル',rel)}));
      fs.writeFileSync(path.join(stage,'資料/ファイル移行.json'),JSON.stringify(mapping,null,2)+'\n');
      chat.append(stage,id,{role:'user',text:lt('人が確認した引き継ぎ要約：\n')+b.summary.trim()+lt('\n\n会話原文：資料/自由対話原文.jsonl\n移したファイル：資料/ファイル移行.json'),summaryApproved:true});
      chat.writeMeta(stage,id,{sessions:{},models:{}});
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,project:name,operationId:b.operationId,stage,dest,planned:mapping})+'\n');
      for(const rel of b.files) { const from=path.join(this.ft.dir,rel),to=path.join(stage,'資料/相談ファイル',rel);noLinks(from);if(createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==all.find(f=>f.path===rel).hash)throw Error(lt('移すファイルが更新されました'));fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(from,to);moved.push({from,to}); }
      fs.renameSync(stage,dest);published=true;
      const migrated={operationId:b.operationId,project:name,task:id};
      // 最後に元話題を確定。失敗なら新プロジェクトと移動を戻す。
      this.history.save(task,{...s,migrated});
      return {...migrated,ok:true};
    } catch(e) {
      if(published)fs.renameSync(dest,stage);
      for(const {from,to} of moved.reverse())fs.renameSync(to,from);
      if(exists(stage))fs.renameSync(stage,path.join(trash,'failed-project'));
      throw Error(lt('プロジェクト化に失敗し、元の話題とファイルを保持しました：')+e.message);
    } finally { this.operating=false; }
  }
  trash(label) { const dir=path.join(this.ft.home,'.Trash','ProjectHub freetalk '+label+' '+randomUUID());noLinks(dir);fs.mkdirSync(dir,{recursive:true});return dir; }
  clean({confirm,automatic=false}={}) {
    this.ft.verify();const reason=this.reason();if(reason)throw Error(reason);
    const s=this.state();if(automatic && this.now().getTime()<Date.parse(s.due))return {ok:false,notDue:true};
    if(!automatic && confirm!==true)throw Error(lt('掃除する内容を確認してください'));
    const targets=[];
    const collect=(root,allowed)=>{
      const walk=(dir,rel='')=>{noLinks(dir);for(const n of fs.readdirSync(dir)) {
        const key=rel?rel+'/'+n:n,file=path.join(dir,n);
        if(allowed.includes(key)){noLinks(file);if(!fs.lstatSync(file).isFile())throw Error(lt('AI設定・管理情報は通常ファイルで保管してください'));continue;}
        if(allowed.some(a=>a.startsWith(key+'/')))walk(file,key);
        else targets.push(file);
      }};walk(root);
    };
    collect(this.ft.dir,SETTINGS);collect(this.ft.ledger,['PROJECT.md','.ai/freetalk-maintenance.json']);
    const moved=[],trash=this.trash('cleanup'); this.operating=true;
    try {
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({lastClean:s.lastClean,planned:targets.map((from,i)=>({from,to:path.join(trash,String(i))}))})+'\n');
      for(const [i,from] of targets.entries()){const to=path.join(trash,String(i));fs.renameSync(from,to);moved.push({from,to});}
      const at=this.now().toISOString();this.save({lastClean:at,due:nextMonth(at),lastOperation:randomUUID()});
      this.error=''; return {ok:true,trash,due:nextMonth(at)};
    }catch(e){for(const {from,to} of moved.reverse())fs.renameSync(to,from);throw Error(lt('掃除に失敗し、元の話題とファイルを保持しました：')+e.message);}
    finally{this.operating=false;}
  }
  // 話題1つを丸ごとゴミ箱へ。移行済みでも可（移行先プロジェクトの写しには触らない）。他の話題・AI設定・共通相談ファイルは残す。
  remove(task,{confirm}={}) {
    const {file}=this.history.topic(task);if(confirm!==true)throw Error(lt('削除する話題を確認してください'));
    const reason=this.operating?lt('プロジェクト化・掃除の途中です。終了後に操作してください'):this.history.busy(task);if(reason)throw Error(reason);
    const targets=[file,this.history.file(task)];
    for(const dir of ['chat','handoff','memory','work']) {
      const base=path.join(this.ft.ledger,'.ai',dir);noLinks(base);
      if(exists(base))for(const name of fs.readdirSync(base))if(name===task || name.startsWith(task+'.') || name.startsWith(task+'-'))targets.push(path.join(base,name));
    }
    targets.push(path.join(this.ft.dir,'topics',task));
    for(const target of targets)noLinks(target);
    const moved=[],trash=this.trash('topic '+task);this.operating=true;
    try {
      fs.writeFileSync(path.join(trash,'manifest.json'),JSON.stringify({task,planned:targets.map((from,i)=>({from,to:path.join(trash,String(i))}))})+'\n');
      for(const [i,from] of targets.entries())if(exists(from)){const to=path.join(trash,String(i));fs.renameSync(from,to);moved.push({from,to});}
      return {ok:true,trash};
    }catch(e){for(const {from,to} of moved.reverse())fs.renameSync(to,from);throw Error(lt('削除に失敗し、元の話題を保持しました：')+e.message);}
    finally{this.operating=false;}
  }
  tick() { try {if(!this.ft.status().ready){this.ft.verify();this.ft.result={ready:true,reason:''};}if(this.status().overdue && !this.reason())return this.clean({automatic:true});}catch(e){this.error=e.message;return {error:e.message};}return null; }
}
module.exports={FreetalkLifecycle,nextMonth,SETTINGS};
