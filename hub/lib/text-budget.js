'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {lt,sectionNames}=require('./locale'),{noLinks,exists}=require('./remove'),{atomic,read,recoverAtomic}=require('./safe-file');
const LIMITS=Object.freeze({summary:2000,notes:20000,trigger:24000,index:8000,total:24000,search:8000});
const count=s=>Array.from(s).length,cut=(s,n)=>Array.from(s).slice(0,Math.max(0,n)).join(''),hash=s=>createHash('sha256').update(s).digest('hex');
const lines=s=>s.match(/[^\n]*\n|[^\n]+$/g)||[];
const pointer=l=>/^\[.*\]\(\.ai\/memory\/[^\r\n]+\)\r?\n?$/.test(l);
const critical=l=>/未済|判断待ち|承認|停止|失敗|決定事項|理由|現状|残件|証拠の場所|待確認|核准|未完成|暫停|失敗|決定事項|原因|目前|待處理/.test(l)||/\b(?:unfinished|pending|approval|approved|stopped|failed|failure|decisions?|reasons?|current status|outstanding|evidence|remaining|awaiting (?:review|confirmation|decision))\b/i.test(l);
function partition(original,kept,moved){const bag=new Map();for(const l of lines(original))bag.set(l,(bag.get(l)||0)+1);for(const l of [...lines(kept),...lines(moved)])bag.set(l,(bag.get(l)||0)-1);if([...bag.values()].some(n=>n!==0))throw Error('原文の分割照合に失敗しました');}
function sections(raw,level=2){
  const matches=[...raw.matchAll(new RegExp('^'+ '#'.repeat(level)+' ([^\\r\\n]+)\\r?\\n','gm'))];
  return matches.map((m,i)=>({name:m[1].trim(),head:m[0],start:m.index,bodyStart:m.index+m[0].length,end:matches[i+1]?.index??raw.length,body:raw.slice(m.index+m[0].length,matches[i+1]?.index??raw.length)}));
}
const names=n=>sectionNames(n),is=(s,n)=>names(n).includes(s.name);
const summaryName=s=>/^(最新の再開要約|最新續接摘要)/.test(s.name);
function summaryView(raw){
  const s=sections(raw).find(summaryName),body=s?.body.trim()||'';
  if(count(body)<=LIMITS.summary)return {text:body,incomplete:false};
  const ls=lines(body),priority=ls.filter(critical),other=ls.filter(l=>!critical(l));
  if(count(priority.join(''))>LIMITS.summary)return {text:cut(priority.join(''),LIMITS.summary),incomplete:true,warning:lt('重要情報だけで要約上限を超えています。原文を検索し、最新の再開要約を書き直してください。')};
  let kept=priority.join('');for(const l of other){if(count(kept+l)>LIMITS.summary)break;kept+=l;}
  return {text:kept.trim(),incomplete:true,warning:lt('要約の表示は一部です。承認・未済・停止・失敗を原文検索で確認してください。')};
}
function splitKeep(body,max,order='newest-first'){
  // Writers fix the order: notes prepend, completed work and INDEX append.
  const original=lines(body),ls=order==='oldest-first'?[...original].reverse():original;
  const kept=[],moved=[];let used=0,overflow=false;
  for(const l of ls){if(pointer(l)){kept.push(l);continue;}if(!overflow&&used+count(l)<=max){kept.push(l);used+=count(l);}else{overflow=true;moved.push(l);}}
  if(original.length!==kept.length+moved.length)throw Error('原文の分割照合に失敗しました');
  if(order==='oldest-first'){kept.reverse();moved.reverse();}
  partition(body,kept.join(''),moved.join(''));
  return {kept:kept.join(''),moved:moved.join('')};
}
// 会話の自動整理で作った目次・引き継ぎ・話題ファイル（原文jsonlは行番号で直接読む）。
function historyFiles(dir,task){
  const root=path.join(dir,'.ai/chat/history',task),out=[];
  try{noLinks(root);if(!exists(root))return out;
    for(const n of fs.readdirSync(root).filter(n=>n==='INDEX.md'||/^index-[0-9]+\.md$/.test(n)))out.push(path.join(root,n));
    for(const id of fs.readdirSync(root).filter(n=>/^[a-f0-9-]{36}$/.test(n)).sort()){
      const d=path.join(root,id),mfile=path.join(d,'manifest.json');noLinks(mfile);if(!exists(mfile))continue;
      const m=JSON.parse(fs.readFileSync(mfile,'utf8'));if(m.stage!=='committed'||m.task!==task||m.id!==id)continue;
      for(const n of ['INDEX.md','handoff.md'])if(exists(path.join(d,n)))out.push(path.join(d,n));
      const t=path.join(d,'topics');noLinks(t);if(exists(t))for(const n of fs.readdirSync(t).filter(n=>/^[0-9]{2,}(-[0-9]+)?\.md$/.test(n)).sort())out.push(path.join(t,n));
      const log=m.entries?.find(e=>e.kind==='log'&&e.existed);if(log&&/^[0-9]+\.original$/.test(log.saved)){
        const f=path.join(d,log.saved);noLinks(f);if(hash(fs.readFileSync(f))===log.digest)out.push(f);
      }
    }
  }catch(e){/* Unverifiable archives are never used as source evidence. */}
  return out;
}
function searchHit(relative,ls,i,start,end,query,available){
  const full='\n'+relative+':'+(start+1)+'\n'+ls.slice(start,end).join('');
  if(count(full)<=available)return {text:full,partial:false};
  // A JSONL message can be one very long line. Spend the budget on the match
  // before its neighbouring lines; report the actual original line number.
  const head='\n'+relative+':'+(i+1)+'\n',room=available-count(head)-3;
  if(room<count(query))return {text:'',partial:true};
  const chars=Array.from(ls[i]),at=count(ls[i].slice(0,ls[i].indexOf(query)));
  const a=Math.max(0,Math.min(at-Math.floor((room-count(query))/2),chars.length-room)),b=Math.min(chars.length,a+room);
  return {text:head+(a?'…':'')+chars.slice(a,b).join('')+(b<chars.length?'…':'')+'\n',partial:true};
}
// Read-only plans depend on every input and destination, including absent files.
// Writers still perform the original full byte/mode checks in transact().
function planStamp(file){require('./remove').readNoLinks(file);try{const s=fs.statSync(file,{bigint:true});if(!s.isFile()||s.nlink!==1n)throw Error('原文は単独の通常ファイルにしてください');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode].join(':');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function validPlan(dependencies){return [...dependencies].every(([file,stamp])=>planStamp(file)===stamp);}
class TextBudget{
  constructor({store,busy=()=>'',checkpoint=()=>{}}){Object.assign(this,{store,busy,checkpoint});this.tokens=new Map();this.completedJournals=new Map();this.dir=path.join(store.root,'_hub/notes-archive');this.planCache=new Map();this.planReads=new Map();this.previewJournals=new Map();}
  topic(project,task){const p=this.store.readProject(project),file=p&&this.store.taskFile(project,task);if(!file||p.kind==='freetalk')throw Error(lt('通常の作業が見つかりません'));return {p,file};}
  stateFile(project){return path.join(this.dir,'policy-'+hash(project)+'.json');}
  summaryRequestFile(project,task){return path.join(this.dir,'summary-'+hash(project+'\0'+task)+'.json');}
  summaryWarnings(project,task){const q=JSON.parse(read(this.summaryRequestFile(project,task))?.text||'null');return q&&(q.stage==='conflict'||q.stage==='queued'&&q.conflictPending)?[lt('要約の原文が変わっています。再送せず確認してください')]:[];}
  state(project){return JSON.parse(read(this.stateFile(project))?.text||'{"tasks":[]}');}
  pending(project,{preflight=false}={}){
    noLinks(this.dir);if(!exists(this.dir)){this.completedJournals.clear();return [];}
    const files=fs.readdirSync(this.dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>path.join(this.dir,n)),live=new Set(files),pending=[];
    for(const file of this.completedJournals.keys())if(!live.has(file))this.completedJournals.delete(file);
    for(const file of files){
      // Only the read-only periodic preflight may skip unchanged completed
      // journals. Recovery and every write gate still read the full originals.
      let stamp;
      if(preflight){
        noLinks(file);const st=fs.statSync(file,{bigint:true});
        if(!st.isFile()||st.nlink!==1n)throw Error('原文は単独の通常ファイルにしてください');
        stamp=[st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs,st.mode].join(':');
        if(this.completedJournals.get(file)===stamp)continue;
      }
      this.completedJournals.delete(file);
      const j=JSON.parse(read(file).text);
      if(preflight&&j.stage==='done')this.completedJournals.set(file,stamp);
      if(j.project===project&&j.stage!=='done')pending.push({file,j});
    }
    return pending;
  }
  idle(project,task){const why=this.busy(project,task);if(why)throw Error(why===true?lt('AI・整理・確認が動いています'):why);const {p}=this.topic(project,task);const legacy=read(path.join(p.dir,'.ai/memory/.project-notes-archive.json'));if(legacy&&JSON.parse(legacy.text).state==='intent')throw Error(lt('メモ保管の復旧が必要です'));}
  planKey(project,task,replacement){return JSON.stringify([project,task,replacement??null,new Date().toISOString().slice(0,7),process.env.HUB_LANG||'',this.store.readTask(this.topic(project,task).file).state]);}
  cachedPlan(key){const hit=this.planCache.get(key);if(hit&&validPlan(hit.dependencies))return structuredClone(hit.value);this.planCache.delete(key);return null;}
  rememberPlan(key,value,dependencies){
    if(!validPlan(dependencies))throw Error('本文整理の計算中に原文が変わりました');
    const size=Buffer.byteLength(JSON.stringify(value));
    this.planCache.delete(key);
    if(size<=8*1024*1024){while(this.planCache.size>=16||[...this.planCache.values()].reduce((n,x)=>n+x.size,0)+size>16*1024*1024)this.planCache.delete(this.planCache.keys().next().value);this.planCache.set(key,{value:structuredClone(value),dependencies,size});}
    return value;
  }
  plan(project,task,replacement){
    const key=this.planKey(project,task,replacement),hit=this.cachedPlan(key);if(hit)return hit;
    const dependencies=new Map(),value=this.buildPlan(project,task,replacement,dependencies);return this.rememberPlan(key,value,dependencies);
  }
  async planAsync(project,task){
    const key=this.planKey(project,task),hit=this.cachedPlan(key);if(hit)return hit;
    if(this.planReads.has(key))return structuredClone(await this.planReads.get(key));
    const {p,file}=this.topic(project,task),state=this.store.readTask(file).state;
    const pending=require('./text-budget-read-worker').plan({root:this.store.root,project,task,p:{id:p.id,dir:p.dir,kind:p.kind},file,state}).then(({value,dependencies})=>{if(this.planKey(project,task)!==key)throw Error('本文整理の計算中に原文が変わりました');return this.rememberPlan(key,value,new Map(dependencies));}).finally(()=>this.planReads.delete(key));
    this.planReads.set(key,pending);return structuredClone(await pending);
  }
  journalKey(){
    noLinks(this.dir);if(!exists(this.dir))return 'absent';
    const s=fs.statSync(this.dir,{bigint:true});
    return JSON.stringify([[s.dev,s.ino,s.mode,s.mtimeNs,s.ctimeNs].join(':'),...fs.readdirSync(this.dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).sort().map(n=>[n,planStamp(path.join(this.dir,n))])]);
  }
  async previewPending(project,task,request){
    const scope=JSON.stringify([project,request?task:'',request||'']),key=this.journalKey(),old=this.previewJournals.get(scope);
    if(old?.key===key)return {key,...structuredClone(old.value)};
    const value=await require('./text-budget-read-worker').pending({root:this.store.root,project,task,request});
    if(this.journalKey()!==key)throw Error('本文整理の確認中に記録が変わりました');
    this.previewJournals.delete(scope);
    if(Buffer.byteLength(JSON.stringify(value))+Buffer.byteLength(key)<=1024*1024){while(this.previewJournals.size>=16)this.previewJournals.delete(this.previewJournals.keys().next().value);this.previewJournals.set(scope,{key,value:structuredClone(value)});}
    return {key,...value};
  }
  async previewAsync(project,task,request){
    const [v,j]=await Promise.all([this.planAsync(project,task),this.previewPending(project,task,request)]);
    if(this.journalKey()!==j.key)throw Error('本文整理の確認中に記録が変わりました');
    return this.preview(project,task,request,v,j.pending,j.status);
  }
  buildPlan(project,task,replacement,dependencies){
    const read=f=>{const before=planStamp(f),value=require('./safe-file').read(f);if(planStamp(f)!==before)throw Error('本文整理の計算中に原文が変わりました');dependencies.set(f,before);return value;};
    read(this.summaryRequestFile(project,task));
    read(this.topic(project,task).file);
    const {p,file}=this.topic(project,task),month=new Date().toISOString().slice(0,7).replace('-',''),changes=[],moves=[],warnings=replacement===undefined?this.summaryWarnings(project,task):[],links=[];
    const add=(f,next)=>{const before=read(f);if(before?.text!==next)changes.push({file:f,before:before?.text??null,next,mode:before?.mode??0o600});};
    const move=(source,section,text,relative)=>{
      if(!text)return '';
      const archive=path.join(p.dir,relative),before=changes.find(x=>x.file===archive)?.next??read(archive)?.text??'';
      const block='\n<!-- '+hash(text)+' '+JSON.stringify({source:path.relative(p.dir,source),section})+' -->\n'+text;
      const prior=changes.find(x=>x.file===archive);if(prior)prior.next=before+block;else add(archive,before+block);
      moves.push({source:path.relative(p.dir,source),section,sha256:hash(text),characters:count(text),lines:lines(text).length,archive:relative});
      const link=`[${lt('原文の保管先')}](${relative})\n`;if(source===file&&!links.includes(link))links.push(link);return link;
    };
    const transform=(f,level,kind)=>{
      const raw=read(f)?.text;if(raw===undefined)return;const ss=sections(raw,level);let next='',end=0,seenSummary=false;
      for(const s of ss){next+=raw.slice(end,s.start);end=s.end;let body=s.body,heading=s.head;
        if(kind==='task'&&summaryName(s)){
          if(seenSummary){move(f,s.name,heading+body,`.ai/memory/task-archive/${task}/summary-${month}.md`);continue;}
          seenSummary=true;
          if(replacement!==undefined){move(f,s.name,body,`.ai/memory/task-archive/${task}/summary-${month}.md`);body=replacement+'\n\n';}
          else if(count(body.trim())>LIMITS.summary){const ls=lines(body),keep=ls.map(l=>critical(l)||pointer(l)),important=ls.filter((l,i)=>keep[i]);
            if(count(important.join('').trim())>LIMITS.summary){warnings.push(lt('重要情報だけで要約上限を超えています。要約を書き直してください。'));}
            else{let used=count(important.join(''));for(let i=0;i<ls.length;i++)if(!keep[i]&&used+count(ls[i])<=LIMITS.summary){keep[i]=true;used+=count(ls[i]);}const kept=ls.filter((l,i)=>keep[i]).join(''),moved=ls.filter((l,i)=>!keep[i]).join('');partition(body,kept,moved);move(f,s.name,moved,`.ai/memory/task-archive/${task}/summary-${month}.md`);body=kept;}
          }
        }else if(is(s,'メモ')||kind==='task'&&is(s,'やったこと')){
          if(count(body)>LIMITS.trigger){const r=splitKeep(body,LIMITS.notes-300,is(s,'やったこと')?'oldest-first':'newest-first');if(r.moved){const rel=kind==='project'?`.ai/memory/project-notes-archive-${month}.md`:`.ai/memory/task-archive/${task}/${is(s,'メモ')?'notes':'completed'}-${month}.md`,link=move(f,s.name,r.moved,rel);body=(r.kept.includes(']('+rel+')')?'':link)+r.kept;if(count(body)>LIMITS.notes)warnings.push(lt('保管先リンクだけで上限を超えています。原文を確認してください。'));}}
        }else if(kind==='task'&&!['残件申告','剩餘工作申報'].includes(s.name)&&!['手順','成果','次にやること','注意','メモ','やったこと','依頼','本文保管'].some(n=>is(s,n))){
          move(f,s.name,heading+body,`.ai/memory/task-archive/${task}/sections-${month}.md`);continue;
        }
        next+=heading+body;
      }
      next+=raw.slice(end);add(f,next);
    };
    // Approved completion fingerprints cover the whole task; never invalidate them.
    if(this.store.readTask(file).state==='完了')warnings.push(lt('完了済みの作業本文は承認を保つため変更しません。AI用の表示だけ制限します。'));else transform(file,2,'task');
    const tc=changes.find(x=>x.file===file);if(tc&&links.length){const previous=sections(tc.next).find(s=>s.name==='本文保管');const missing=links.filter(l=>!previous?.body.includes(l));if(missing.length){if(previous)tc.next=tc.next.slice(0,previous.bodyStart)+missing.join('')+tc.next.slice(previous.bodyStart);else{const first=sections(tc.next)[0]?.start??tc.next.length;tc.next=tc.next.slice(0,first)+'## 本文保管\n'+missing.join('')+tc.next.slice(first);}}}
    transform(path.join(p.dir,'PROJECT.md'),1,'project');
    const index=path.join(p.dir,'.ai/memory/INDEX.md'),old=read(index)?.text;
    if(old&&count(old)>LIMITS.index){const r=splitKeep(old,LIMITS.index-300,'oldest-first'),rel=`.ai/memory/INDEX-archive-${month}.md`,link=move(index,'INDEX',r.moved,rel);add(index,(r.kept.includes(']('+rel+')')?'':link)+r.kept);}
    return {project,task,changes,moves,warnings};
  }
  snapshot(project,task){const {p,file}=this.topic(project,task);return [file,path.join(p.dir,'PROJECT.md'),path.join(p.dir,'.ai/memory/INDEX.md'),this.stateFile(project)].map(f=>({file:f,...read(f)}));}
  requestStatus(project,task,request){if(!request)return '';noLinks(this.dir);if(!exists(this.dir))return 'unconfirmed';for(const n of fs.readdirSync(this.dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const j=JSON.parse(read(path.join(this.dir,n)).text);if(j.project===project&&j.task===task&&j.request===request)return j.stage;}return 'unconfirmed';}
  preview(project,task,request,planned,displayPending,displayStatus){const v=planned||this.plan(project,task),pending=displayPending||this.pending(project);let reason='';try{this.idle(project,task);}catch(e){reason=e.message;}if(pending.length)reason=lt('本文整理の結果が不明です。復旧を確認してください');
    const token=randomUUID();for(const [k,t] of this.tokens)if(Date.now()-t.at>600000)this.tokens.delete(k);
    if(!reason)this.tokens.set(token,{...v,request:token,at:Date.now(),snapshot:this.snapshot(project,task)});
    return {project,task,token:reason?'':token,reason,warnings:v.warnings,moves:v.moves,limits:LIMITS,enabled:this.state(project).tasks.includes(task),requestStatus:displayStatus??this.requestStatus(project,task,request),noChanges:!v.changes.length,pending:pending.filter(x=>x.j.task===task).map(x=>x.j.id),files:v.changes.map(x=>({file:path.relative(this.topic(project,task).p.dir,x.file),before:count(x.before||''),after:count(x.next)}))};
  }
  transact(v,enable=true){
    this.idle(v.project,v.task);if(this.pending(v.project).length)throw Error(lt('本文整理の復旧が必要です'));
    const snapshot=v.snapshot||this.snapshot(v.project,v.task);for(const x of [...snapshot,...v.changes]){const r=read(x.file);if((r?.text??null)!==(x.before!==undefined?x.before:x.text??null)||(r?.mode??0o600)!==(x.mode??0o600))throw Error(lt('確認中に原文・保管先・権限が変わりました'));}
    const state=this.state(v.project),stateFile=this.stateFile(v.project),changes=[...v.changes];if(enable&&!state.tasks.includes(v.task))changes.push({file:stateFile,before:read(stateFile)?.text??null,next:JSON.stringify({...state,tasks:[...state.tasks,v.task]}),mode:0o600});
    if(!changes.length)return {ok:true,noChanges:true,warnings:v.warnings};
    this.idle(v.project,v.task);noLinks(this.dir);fs.mkdirSync(this.dir,{recursive:true});
    const id=randomUUID(),jf=path.join(this.dir,id+'.json'),j={id,request:v.request||'',project:v.project,task:v.task,stage:'intent',at:new Date().toISOString(),moves:v.moves,changes:changes.map(x=>({...x,beforeHash:x.before===null?null:hash(x.before),nextHash:hash(x.next)}))};
    atomic(jf,JSON.stringify(j));this.checkpoint('intent',j);
    return {...this.finish(j,jf),warnings:v.warnings};
  }
  validate(j,jf){
    if(path.basename(jf)!==j.id+'.json'||!['intent','done'].includes(j.stage)||!Array.isArray(j.changes))throw Error('復旧記録が不正です');
    const {p,file}=this.topic(j.project,j.task),allowed=new Set([file,path.join(p.dir,'PROJECT.md'),path.join(p.dir,'.ai/memory/INDEX.md'),this.stateFile(j.project),this.summaryRequestFile(j.project,j.task)]);
    const prefix=path.join(p.dir,'.ai/memory/task-archive',j.task)+path.sep;
    for(const x of j.changes){const rel=path.relative(p.dir,x.file);if(!allowed.has(x.file)&&!(x.file.startsWith(prefix)&&/^(summary|notes|completed|sections)-\d{6}\.md$/.test(path.basename(x.file)))&&!/^\.ai\/memory\/(project-notes-archive|INDEX-archive)-\d{6}\.md$/.test(rel))throw Error('復旧先が不正です');if(hash(x.next)!==x.nextHash||(x.before===null?null:hash(x.before))!==x.beforeHash)throw Error('復旧原文の照合に失敗しました');}
  }
  finish(j,jf){
    this.validate(j,jf);this.idle(j.project,j.task);
    // Verify every original or already committed result before touching any file.
    for(const x of j.changes){const r=read(x.file),h=r?hash(r.text):null;if(h!==x.beforeHash&&h!==x.nextHash||r&&(r.mode!==x.mode))throw Error(lt('原文または保管先が変わっています。再送せず確認してください'));}
    for(const x of j.changes){this.idle(j.project,j.task);if(read(x.file)?.text===x.next)continue;noLinks(path.dirname(x.file));fs.mkdirSync(path.dirname(x.file),{recursive:true});
      // A crash leaves an exclusive temp; use it only if bytes and mode match this journal.
      recoverAtomic(x.file,x.next,x.mode);
      if(read(x.file)?.text!==x.next)throw Error('書込み結果の照合に失敗しました');this.checkpoint('write',x);
    }
    recoverAtomic(jf,JSON.stringify({...j,stage:'done'}));return {ok:true,id:j.id,warnings:[],moves:j.moves};
  }
  apply({project,task,token,confirm}){const v=this.tokens.get(token);if(!v||v.project!==project||v.task!==task||confirm!==true||Date.now()-v.at>600000)throw Error(lt('本文の整理内容を確認してください'));this.tokens.delete(token);return this.transact(v);}
  recover({project,task,confirm}){if(confirm!==true)throw Error(lt('復旧内容を確認してください'));this.idle(project,task);const jobs=this.pending(project);if(jobs.length!==1||jobs[0].j.task!==task)throw Error('復旧対象を確認してください');return this.finish(jobs[0].j,jobs[0].file);}
  maintain(project,task){if(!this.state(project).tasks.includes(task))return;this.idle(project,task);if(this.pending(project).length)throw Error(lt('本文整理の復旧が必要です'));
    const requestFile=this.summaryRequestFile(project,task),q=JSON.parse(read(requestFile)?.text||'null');
    if(q?.stage==='conflict')return {warnings:this.plan(project,task).warnings};
    if(q&&q.stage==='queued'){
      if(q.project!==project||q.task!==task||typeof q.summary!=='string'||count(q.summary)>LIMITS.summary)throw Error('要約更新記録が不正です');
      if(this.requestStatus(project,task,q.id)!=='done'){
        const file=this.topic(project,task).file;if(this.store.readTask(file).state==='完了')throw Error(lt('完了済みの作業本文は承認を保つため変更しません。AI用の表示だけ制限します。'));
        const old=sections(read(file).text).find(summaryName);if(!old||hash(old.body)!==q.previousHash){recoverAtomic(requestFile,JSON.stringify({...q,stage:'conflict'}));return {warnings:[lt('要約の原文が変わっています。再送せず確認してください')]};}
        const v=this.plan(project,task,q.summary);v.request=q.id;const r=this.transact(v,false);recoverAtomic(requestFile,JSON.stringify({...q,stage:'done'}));return r;
      }
      recoverAtomic(requestFile,JSON.stringify({...q,stage:'done'}));
    }
    const v=this.plan(project,task);if(v.changes.length)return this.transact(v,false);return {warnings:v.warnings};
  }
  // Read-only preflight. It authorizes nothing: maintain/transact still repeat
  // the current policy, originals, pending journals and full idle checks.
  maintenanceCheck(project,task){
    const cached=this.previewJournals.get(JSON.stringify([project,'','']));
    const pending=cached?.key===this.journalKey()?cached.value.pending:this.pending(project,{preflight:true});
    if(pending.length)throw Error(lt('本文整理の復旧が必要です'));
    const q=JSON.parse(read(this.summaryRequestFile(project,task))?.text||'null');
    if(q?.stage==='queued')return {needed:true,warnings:[]};
    const v=this.plan(project,task);
    return {needed:q?.stage!=='conflict'&&v.changes.length>0,warnings:v.warnings};
  }
  async maintenanceCheckAsync(project,task){
    const journals=await this.previewPending(project);
    if(journals.pending.length)throw Error(lt('本文整理の復旧が必要です'));
    const q=JSON.parse(read(this.summaryRequestFile(project,task))?.text||'null');
    if(q?.stage==='queued')return {needed:true,warnings:[]};
    const key=this.planKey(project,task),v=await this.planAsync(project,task);
    if(this.planKey(project,task)!==key)throw Error('本文整理の計算中に原文が変わりました');
    if(this.journalKey()!==journals.key)throw Error('本文整理の確認中に記録が変わりました');
    const latest=JSON.parse(read(this.summaryRequestFile(project,task))?.text||'null');
    if(JSON.stringify(latest)!==JSON.stringify(q))throw Error('本文整理の計算中に原文が変わりました');
    // Oversized plans intentionally are not retained. This is only a preflight;
    // maintain/transact still validate all current originals before any write.
    return {needed:latest?.stage!=='conflict'&&v.changes.length>0,warnings:v.warnings};
  }
  // Read and warm only. Callers must await this BEFORE acquiring a synchronous
  // handoff permit, then invoke maintainEnabled without awaiting inside it.
  async prepareMaintenance(notice=()=>{}){
    if(this.maintenanceReading)return;this.maintenanceReading=true;
    try{for(const p of this.store.listProjects()){
      if(p.kind==='freetalk')continue;
      for(const task of this.state(p.id).tasks){
        try{await this.maintenanceCheckAsync(p.id,task);}
        catch(e){notice(p.id+' / '+task,[e.message]);}
      }
    }}catch(e){notice('本文整理',[e.message]);}finally{this.maintenanceReading=false;}
  }
  needsMaintenance(project,task){return this.maintenanceCheck(project,task).needed;}
  maintainEnabled(blocked,notice){
    try{for(const p of this.store.listProjects()){
      if(p.kind==='freetalk')continue;
      for(const task of this.state(p.id).tasks){
        const scope=p.id+' / '+task;
        try{
          const {needed,warnings}=this.maintenanceCheck(p.id,task);
          if(needed&&blocked())continue;
          const r=needed?this.maintain(p.id,task):null,persistent=this.summaryWarnings(p.id,task);
          notice(scope,(r?.warnings||warnings).filter(w=>!persistent.includes(w)));
        }catch(e){notice(scope,[e.message]);}
      }
    }}catch(e){notice('本文整理',[e.message]);}
  }
  replaceSummary({project,task,summary}){if(typeof summary!=='string'||count(summary)>LIMITS.summary)throw Error(lt('要約は2000字以内で置き換えてください'));if(!this.state(project).tasks.includes(task))throw Error(lt('最初の本文整理は画面のプレビューから行ってください'));const file=this.topic(project,task).file;if(this.store.readTask(file).state==='完了')throw Error(lt('完了済みの作業本文は承認を保つため変更しません。AI用の表示だけ制限します。'));const old=sections(read(file).text).find(summaryName);if(!old)throw Error('最新の再開要約の欄がありません');
    const requestFile=this.summaryRequestFile(project,task),queued=JSON.parse(read(requestFile)?.text||'null');if(queued&&queued.stage==='queued'){if(queued.summary===summary&&queued.previousHash===hash(old.body))return {ok:true,queued:true,id:queued.id};throw Error(lt('要約の更新依頼が残っています。結果を確認してください'));}
    if(this.pending(project).length)throw Error(lt('本文整理の復旧が必要です'));noLinks(this.dir);fs.mkdirSync(this.dir,{recursive:true});const history=queued?[...(queued.history||[]),Object.fromEntries(Object.entries(queued).filter(([k])=>k!=='history'))]:[];
    const q={id:randomUUID(),project,task,summary,previousHash:hash(old.body),stage:'queued',conflictPending:queued?.stage==='conflict'||queued?.stage==='queued'&&!!queued.conflictPending,history};
    if(this.busy(project,task)){atomic(requestFile,JSON.stringify(q));return {ok:true,queued:true,id:q.id};}
    // Resolve an idle replacement in the same journal, after the archive and source.
    // A failure keeps the old conflict; only explicit recovery may finish the write.
    const v=this.plan(project,task,summary),previous=read(requestFile);v.request=q.id;
    v.changes.push({file:requestFile,before:previous?.text??null,next:JSON.stringify({...q,stage:'done'}),mode:previous?.mode??0o600});
    return this.transact(v,false);
  }
  archives(project,task){const {p}=this.topic(project,task),roots=[path.join(p.dir,'.ai/memory')],result=[];for(const root of roots){noLinks(root);if(!exists(root))continue;for(const n of fs.readdirSync(root)){if(!/^(project-notes-archive|INDEX-archive)-\d{6}\.md$/.test(n))continue;const f=path.join(root,n),r=read(f);result.push({path:path.relative(p.dir,f),characters:count(r.text)});}}
    const td=path.join(p.dir,'.ai/memory/task-archive',task);noLinks(td);if(exists(td))for(const n of fs.readdirSync(td)){if(!/^(summary|notes|completed|sections)-\d{6}\.md$/.test(n))continue;const f=path.join(td,n),r=read(f);result.push({path:path.relative(p.dir,f),characters:count(r.text)});}return result;
  }
  search(project,task,query,limit=8000){if(typeof query!=='string'||!query.trim()||count(query)>200)throw Error('検索語を確認してください');const p=this.store.readProject(project);if(!p||p.kind==='freetalk')throw Error('通常のプロジェクトが見つかりません');const tasks=task?[this.topic(project,task).file]:p.tasks.map(t=>this.topic(project,t.id).file);const archives=task?this.archives(project,task):p.tasks.flatMap(t=>this.archives(project,t.id));const history=(task?[task]:p.tasks.map(t=>t.id)).flatMap(id=>historyFiles(p.dir,id));const files=[...new Set([...tasks,path.join(p.dir,'PROJECT.md'),path.join(p.dir,'.ai/memory/INDEX.md'),...archives.map(x=>path.join(p.dir,x.path)),...history])];const max=Math.min(LIMITS.search,Math.max(100,Math.floor(Number(limit)||8000)));let out='',omitted=false;
    const notice=lt('\n検索結果は一部です。検索語を絞るか保管先を直接読んでください。');
    for(const f of files){const ls=lines(read(f)?.text||'');let last=-1;for(let i=0;i<ls.length;i++)if(ls[i].includes(query)){const a=Math.max(last+1,i-2),b=Math.min(ls.length,i+3);last=b-1;const hit=searchHit(path.relative(p.dir,f),ls,i,a,b,query,max-count(notice)-count(out));out+=hit.text;if(hit.partial){omitted=true;break;}}if(omitted)break;}
    return out+(omitted?notice:'');
  }
}
// Display-only bounds: avoid allocating a code-point array for entire archived sections.
// Keep the write/archive helpers above unchanged.
const viewCount=s=>s.length-(s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length||0);
function viewHead(s,n){
  if(s.length<=n)return s;
  let i=0;for(let used=0;used<n&&i<s.length;used++)i+=s.codePointAt(i)>0xffff?2:1;
  return s.slice(0,i);
}
function viewTail(s,n){
  let i=s.length;for(let used=0;used<n&&i>0;used++){
    const low=s.charCodeAt(--i),high=s.charCodeAt(i-1);
    if(low>=0xdc00&&low<=0xdfff&&high>=0xd800&&high<=0xdbff)i--;
  }
  return s.slice(i);
}
function taskView(raw,projectRaw,archives=[]){
  const ss=sections(raw),sv=summaryView(raw),pick=n=>ss.find(s=>is(s,n))?.body||'',front=raw.slice(0,ss[0]?.start??raw.length);
  const results=pick('成果'),resultsLength=viewCount(results),marker='\n'+lt('（中略。全文は原文検索で確認）')+'\n',remaining=12000-viewCount(marker),head=Math.ceil(remaining/2);
  const resultsView=resultsLength<=12000?results:viewHead(results,head)+marker+viewTail(results,remaining-head);
  const st=lines(pick('手順')),pending=st.filter(l=>/^\s*[-*] \[ \]/.test(l)),done=st.filter(l=>/^\s*[-*] \[[xX]\]/.test(l)).slice(-10);
  const warnings=[lt('Unicode文字で合計24000字以内の表示。成果原文と受領判定は変更していません。省略された承認・未済は hub_search_archive で原文を検索してください。'),sv.warning].filter(Boolean);
  const parts=[['管理情報',front],['最新の再開要約',sv.text],['手順（未済すべて・直近の済10件）',[...pending,...done].join('')],['次にやること',pick('次にやること')],['注意',pick('注意')],['成果',resultsView],['メモ',viewHead(pick('メモ'),4000)],['PROJECT.md',viewHead(projectRaw.slice(0,sections(projectRaw,1)[0]?.start??projectRaw.length),800)+'\n'+viewHead(sections(projectRaw,1).find(s=>is(s,'メモ'))?.body||'',3100)],['保管先',archives.map(x=>x.path+' '+x.characters+'字').join('\n')]];
  let out='',used=0,omitted=ss.filter(s=>!summaryName(s)&&!['手順','成果','次にやること','注意','メモ','本文保管'].some(n=>is(s,n))).map(s=>s.name);const max=LIMITS.total-750;for(const [label,body]of parts){const block='\n## '+lt(label)+'\n'+body,available=max-used,blockLength=viewCount(block);if(blockLength>available){omitted.push(label);out+=viewHead(block,available);used=max;}else{out+=block;used+=blockLength;}}
  if(resultsLength>12000)omitted.push('成果');if(viewCount(pick('メモ'))>4000)omitted.push('メモ');if(viewCount(projectRaw)>4000)omitted.push('PROJECT.md');
  const detail=omitted.length?'\n'+lt('表示不足：')+viewHead(omitted.join('、'),300)+lt('。hub_search_archive または hub_read_file で必要箇所を確認してください。'):'';
  return viewHead(out+'\n'+warnings.join('\n')+detail,LIMITS.total);
}
module.exports={TextBudget,LIMITS,count,cut,hash,lines,sections,summaryView,taskView,splitKeep};
