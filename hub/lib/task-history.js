'use strict';
const {lt}=require('./locale');
const fs=require('./platform/file-io'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {noLinks,readNoLinks,noLink,exists}=require('./remove'),chat=require('./chat'),auto=require('./task-history-auto'),questions=require('./pending-question');
const AUTO_ACTIVE=['collecting','selecting','writing','switching'],AUTO_END=['done','failed','cancelled'];
const KEYS=['decision','reason','current','approved','residual','evidence'];
const LABELS=['決定事項','理由','現状','承認済みの範囲','残件・判断待ち','証拠の場所・次にすること'];
const taskDigest=t=>digest(JSON.stringify([t.steps,t.question,t.next,t.note,t.done]));
const digest=x=>createHash('sha256').update(x).digest('hex');
function atomic(f,bytes,mode){return require('./integration-writes').write(f,()=>{noLinks(f);fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=f+'.'+randomUUID();fs.writeFileSync(tmp,bytes,{flag:'wx',...(mode===undefined?{}:{mode})});if(mode!==undefined)fs.chmodSync(tmp,mode);fs.renameSync(tmp,f);});}
function summaryFields(input){const out={};for(const k of KEYS){if(typeof input?.[k]!=='string'||!input[k].trim())throw Error(lt('引き継ぎ要約の六欄を記入してください'));out[k]=input[k].trim();}if(Array.from(summaryText(out)).length>2000)throw Error(lt('引き継ぎ要約は合計2000字以内にしてください'));return out;}
function summaryText(fields){return KEYS.map((k,n)=>lt(LABELS[n])+'：'+fields[k]).join('\n');}
function latest(text){return (text.match(/^## 最新の再開要約\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)||[])[1]?.trim()||'';}
function replaceLatest(text,summary){const block='## 最新の再開要約\n\n'+summary+'\n\n';const match=/^## 最新の再開要約[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/m;if(match.test(text))return text.replace(match,()=>block);const end=text.startsWith('---\n')?text.indexOf('\n---',4)+4:0;return text.slice(0,end)+'\n\n'+block+text.slice(end);}
class TaskHistory{
  constructor({store,busy=()=>'',reset=()=>{},checkpoint=()=>{},record=()=>{}}){Object.assign(this,{store,busy,reset,checkpoint,record});this.dir=path.join(store.root,'_hub/task-history');this.activeWrites=new Set();this.failure='';try{this.recoverAll();}catch(e){this.failure=e.message;}}
  hold(project,task){if(this.failure)throw Error(lt('会話整理の復旧が必要です：')+this.failure);const write={project,task};this.activeWrites.add(write);const release=()=>this.activeWrites.delete(write);release.target=(p,t)=>{write.project=p;write.task=t;};return release;}
  topic(project,task){const p=this.store.readProject(project),file=p&&this.store.taskFile(project,task);if(!file||p.kind==='freetalk')throw Error(lt('通常の作業が見つかりません'));noLinks(file);return {p,t:this.store.readTask(file),file};}
  file(project,task){return path.join(this.dir,digest(project+'\0'+task)+'.json');}
  state(project,task){const f=this.file(project,task);readNoLinks(f);const state=exists(f)?JSON.parse(fs.readFileSync(f,'utf8')):{generation:1};if(!Number.isSafeInteger(state?.generation)||state.generation<1)throw Error(lt('会話の世代記録が不正です'));return state;}
  continueFile(project,task){return this.file(project,task)+'.continue';}
  continueRecord(project,task){const f=this.continueFile(project,task);noLinks(f);if(!exists(f))return null;const r=JSON.parse(fs.readFileSync(f,'utf8'));if(!r||!/^[a-f0-9-]{36}$/.test(r.requestId||'')||!['pending','done','failed','uncertain'].includes(r.status))throw Error(lt('会話整理の送信記録を読めません'));return r;}
  saveContinue(project,task,r){atomic(this.continueFile(project,task),JSON.stringify(r));}
  continueStatus(project,task,requestId){
    const r=this.continueRecord(project,task),state=this.state(project,task);
    if(!r||requestId&&r.requestId!==requestId)return {status:'unknown'};
    if(state.requestId===r.requestId){
      const recovery=Boolean(this.failure||exists(this.journalFile(project,task)));
      if(!recovery&&r.status!=='done')this.saveContinue(project,task,{...r,status:'done',phase:'done',result:{...r.result,ok:true,body:r.body||'skipped',rotate:'ok',generation:state.generation,archiveId:state.archiveId}});
      return {requestId:r.requestId,status:recovery?'uncertain':'done',phase:recovery?'switching':'done',result:{...r.result,body:r.body||'skipped',ok:!recovery,rotate:recovery?'committed':'ok',generation:state.generation,archiveId:state.archiveId,completionHash:this.topic(project,task).t.completionHash},recovery};
    }
    return {requestId:r.requestId,status:r.status,phase:r.phase,result:r.result,recovery:Boolean(this.failure||exists(this.journalFile(project,task))||r.status==='pending')};
  }
  recoverContinue(project,task,requestId){
    const r=this.continueRecord(project,task);if(!r||r.requestId!==requestId)throw Error(lt('会話整理の送信記録を確認してください'));
    this.recoverAll();this.failure='';
    if(this.state(project,task).requestId!==requestId&&r.phase==='selection'&&!exists(this.journalFile(project,task))){
      this.idle(project,task);const a=this.autoJob(project,task);
      if(!a||a.requestId!==requestId)this.autoStart(project,task,{requestId,generation:r.generation,trigger:'continue'});
      else if(a.stage==='failed')this.setAuto(project,task,{stage:a.reply?'writing':'reserved',error:'',reason:''});
      this.saveContinue(project,task,{...r,status:'pending',result:{ok:false,pending:true,body:r.body||'skipped',rotate:'pending'}});
      return {ok:false,pending:true,body:r.body||'skipped',rotate:'pending'};
    }
    const running=this.autoJob(project,task);if(running?.requestId===requestId&&['reserved','selecting','writing'].includes(running.stage)&&!this.failure)return {ok:false,pending:true,body:r.body||'skipped',rotate:'pending'};
    const status=this.continueStatus(project,task,requestId);
    if(status.status!=='done'){
      const current=this.continueRecord(project,task);
      if(current.status==='failed')return current.result;
      if(this.state(project,task).generation!==r.generation||!r.revision||r.revision!==this.revision(project,task))throw Error(lt('会話整理の結果が未確認です。再送せず記録を確認してください'));
      const result={ok:false,body:r.body||'skipped',rotate:'failed',error:lt('会話の切り替えは未実行です：')};
      this.saveContinue(project,task,{...r,status:'failed',result});return result;
    }
    this.saveContinue(project,task,{...r,status:'done',result:status.result});return status.result;
  }
  sources(project,task){const {p,file}=this.topic(project,task);const files=[file,...Object.values(chat.files(p.dir,task)),path.join(p.dir,'.ai/chat',task+'.rules.md'),path.join(p.dir,'.ai/handoff',task+'-limit.json'),this.file(project,task)];const handoff=path.join(p.dir,'.ai/handoff');noLinks(handoff);if(exists(handoff))for(const n of fs.readdirSync(handoff).sort())if(n.startsWith(task+'-')){const f=path.join(handoff,n);noLinks(f);if(fs.statSync(f).isFile())files.push(f);}for(const d of ['task-integrations','task-handoffs'])files.push(path.join(this.store.root,'_hub',d,digest(project+'\0'+task)+'.json'));return [...new Set(files)];}
  revision(project,task){return digest(JSON.stringify(this.sources(project,task).map(f=>{noLinks(f);return [f,exists(f)?digest(fs.readFileSync(f)):null,exists(f)?fs.statSync(f).mode&0o777:null];})));}
  idle(project,task,readContext){this.topic(project,task);if(this.failure)throw Error(lt('会話整理の復旧が必要です：')+this.failure);if([...this.activeWrites].some(w=>!w.project||w.project===project&&(!w.task||w.task===task)))throw Error(lt('保存・送信が進行中です。終了後に整理してください'));const reason=this.busy(project,task,readContext);if(reason)throw Object.assign(Error(reason.message||reason),{code:reason.code});const {p}=this.topic(project,task),files=chat.files(p.dir,task),q=files.queue;noLinks(files.log);const rows=exists(files.log)?fs.readFileSync(files.log,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];if(rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error(lt('会話原文の形式が不正です'));if(rows.some(r=>r.role==='user'&&r.to==='dot'&&r.request&&!rows.some(a=>a.role==='assistant'&&a.ai==='dot'&&a.request===r.request)))throw Error(lt('未処理のDot依頼があります'));noLinks(q);if(exists(q)){const rows=JSON.parse(fs.readFileSync(q,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error(lt('順番待ちまたは不正な待機記録があります'));}for(const d of ['task-integrations','task-handoffs']){const dir=path.join(this.store.root,'_hub',d);noLinks(dir);if(exists(dir))for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const f=path.join(dir,name);noLinks(f);const record=JSON.parse(fs.readFileSync(f,'utf8'));if(!record||typeof record!=='object'||Array.isArray(record))throw Error(lt('統合・受領記録を読めません'));}}const pending=path.join(p.dir,'.ai/handoff',task+'-limit.json');noLinks(pending);if(exists(pending)&&JSON.parse(fs.readFileSync(pending,'utf8')).pending)throw Error(lt('利用上限の引き継ぎが待機中です'));}
  status(project,task,readContext){const {p,t,file}=this.topic(project,task),state=this.state(project,task);let reason='',code;try{this.idle(project,task,readContext);}catch(e){reason=e.message;code=e.code;}if(t.state==='完了'&&!reason)reason=lt('完了した作業は、再開してから要約してください');const rows=chat.read(p.dir,task),summary=state.summary;const i=rows.findLastIndex(r=>summary&&r.role==='user'&&r.text?.includes('[task-summary:'+summary.id+']')),last=rows.at(-1);const draft=summary&&i>=0&&rows.slice(i+1).filter(r=>r.role!=='event').length===1&&last?.role==='assistant'&&!last.error&&!last.asks?.length?last.text:'';const fields={decision:lt('未確認'),reason:lt('未確認'),current:t.title+' ／ '+t.state,approved:lt('未確認'),residual:[...(t.steps||[]).filter(s=>!s.done).map(s=>s.text),t.question].filter(Boolean).join('\n')||lt('未確認'),evidence:lt('未確認')};return {fields,generation:state.generation,revision:this.revision(project,task),reason,code,latest:latest(fs.readFileSync(file,'utf8')),draft,summaryId:summary?.id||''};}
  prepareSummary(project,task){this.idle(project,task);const state=this.state(project,task),id=randomUUID();atomic(this.file(project,task),JSON.stringify({...state,summary:{id,revision:this.revision(project,task)}}));return {summaryId:id,revision:this.revision(project,task),text:`[task-summary:${id}]\nこの作業の引き継ぎ要約を六欄（決定事項／理由／現状／承認済みの範囲／残件・判断待ち／証拠の場所・次にすること）で合計2000字以内に作成してください。不明は未確認、無い項目はなし。未採用を決定扱いにせず、ファイル変更や質問をせず要約だけ返してください。`};}
  archiveRoot(project,task){const {p}=this.topic(project,task);return path.join(p.dir,'.ai/chat/history',task);}
  archives(project,task){const root=this.archiveRoot(project,task);noLinks(root);if(!exists(root))return [];return fs.readdirSync(root).filter(n=>/^[a-f0-9-]{36}$/.test(n)&&exists(path.join(root,n,'manifest.json'))).map(id=>{const m=this.manifest(project,task,id);return {id,at:m.at,generation:m.generation,summary:m.summary,committed:m.stage==='committed'};}).filter(m=>m.committed).sort((a,b)=>String(b.at).localeCompare(String(a.at)));}
  manifest(project,task,id){if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error(lt('履歴の番号が不正です'));const f=path.join(this.archiveRoot(project,task),id,'manifest.json');noLinks(f);const m=JSON.parse(fs.readFileSync(f,'utf8'));if(!Array.isArray(m.entries)||m.entries.some(e=>!/^[0-9]+\.original$/.test(e.saved)))throw Error(lt('復旧範囲が不正です'));if(m.project!==project||m.task!==task||m.id!==id)throw Error(lt('履歴の所属が不正です'));return m;}
  archive(project,task,id,offset=0){const m=this.manifest(project,task,id);if(m.stage!=='committed')throw Error(lt('履歴の保存が完了していません'));const log=m.entries.find(e=>e.kind==='log');if(!log)return {rows:[],total:0};const f=path.join(this.archiveRoot(project,task),id,log.saved);noLinks(f);const bytes=fs.readFileSync(f);if(digest(bytes)!==log.digest)throw Error(lt('履歴の原文が変わっています'));const rows=bytes.toString('utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));const start=Math.max(0,Math.floor(Number(offset)||0));return {rows:rows.slice(start,start+100),total:rows.length,offset:start,summary:m.summary};}
  pendingQuestion(project,task,rows){
    const p=this.store.readProject(project);
    if(!p||!this.store.taskFile(project,task)||p.kind==='freetalk')throw Error(lt('通常の作業が見つかりません'));
    rows=rows||chat.read(p.dir,task);
    const restore=(log,seen=new Set())=>{
      // A newer saved question group supersedes older groups; no archive scan is needed.
      if(log.some(r=>r.role==='assistant'&&questions.validAsks(r.asks)))return questions.pending(log);
      const first=log.find(r=>r.summaryAuto||r.summaryApproved);
      let initial=null;
      if(first&&!Object.hasOwn(first,'pendingQuestion')&&first.archiveId){
        if(seen.has(first.archiveId))throw Error(lt('履歴の番号が不正です'));seen.add(first.archiveId);
        const m=this.manifest(project,task,first.archiveId),entry=m.entries.find(e=>e.kind==='log'&&e.existed);
        if(m.stage!=='committed')throw Error(lt('履歴の保存が完了していません'));
        if(entry){
          const f=path.join(this.archiveRoot(project,task),first.archiveId,entry.saved);noLinks(f);
          const st=fs.statSync(f),key=JSON.stringify([f,entry.digest,st.size,st.mtimeMs,st.ctimeMs]);
          this.questionCache||=new Map();
          if(this.questionCache.has(key))initial=this.questionCache.get(key);
          else{
            const bytes=fs.readFileSync(f);if(digest(bytes)!==entry.digest)throw Error(lt('履歴の原文が変わっています'));
            initial=restore(bytes.toString('utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)),seen);
            if(this.questionCache.size>=16)this.questionCache.delete(this.questionCache.keys().next().value);
            this.questionCache.set(key,initial);
          }
        }
      }
      return questions.pending(log,initial);
    };
    return restore(rows);
  }
  journalFile(project,task){return this.file(project,task)+'.journal';}
  verifyArchive(j){for(const e of j.entries)if(e.existed){const f=path.join(j.archive,e.saved);noLinks(f);const st=fs.statSync(f);if(st.size!==e.bytes||(st.mode&0o777)!==e.mode||digest(fs.readFileSync(f))!==e.digest)throw Error(lt('旧会話の保存内容・権限を照合できません'));}}
  recover(j){this.verifyArchive(j);
    if(j.auto&&j.stage!=='committed'&&j.next){
      if(j.next.length!==j.replacements.length||j.next.some((n,i)=>n.file!==j.replacements[i].file||n.digest!==j.replacements[i].digest||!/^next-[0-9]+$/.test(n.saved)))throw Error(lt('復旧範囲が不正です'));
      for(const e of j.entries.filter(e=>e.replace)){
        const next=j.next.find(n=>n.file===e.file),bytes=exists(e.file)?fs.readFileSync(e.file):null;
        const original=bytes?e.existed&&digest(bytes)===e.digest:!e.existed;
        const replaced=next&&bytes&&digest(bytes)===next.digest;
        if(bytes&&e.existed&&(fs.statSync(e.file).mode&0o777)!==e.mode)throw Error(lt('旧会話の保存内容・権限を照合できません'));
        const deleted=j.deleted.includes(e.file)&&!bytes&&j.stage==='switching';
        if(!original&&!replaced&&!deleted)throw Error(lt('切り替え済み会話の復旧照合が必要です'));
      }
      for(const n of j.next){const f=path.join(j.archive,n.saved);noLinks(f);if(digest(fs.readFileSync(f))!==n.digest||(fs.statSync(f).mode&0o777)!==n.mode)throw Error(lt('旧会話の保存内容・権限を照合できません'));}
      j.stage='switching';atomic(this.journalFile(j.project,j.task),JSON.stringify(j));
      for(const n of j.next)atomic(n.file,fs.readFileSync(path.join(j.archive,n.saved)),j.entries.find(e=>e.file===n.file)?.mode);
      for(const f of j.deleted){noLinks(f);if(exists(f))require('./integration-writes').write(f,()=>fs.unlinkSync(f));}
      j.stage='committed';atomic(this.journalFile(j.project,j.task),JSON.stringify(j));
    }
    if(j.stage==='committed'){for(const e of j.replacements){noLinks(e.file);if(!exists(e.file)||digest(fs.readFileSync(e.file))!==e.digest)throw Error(lt('切り替え済み会話の復旧照合が必要です'));}for(const f of j.deleted||[]){noLinks(f);if(exists(f))throw Error(lt('切り替え済み会話の復旧照合が必要です'));}atomic(path.join(j.archive,'manifest.json'),JSON.stringify(j));this.writeIndex(j.project,j.task);this.reset(j.project,j.task,j.generation+1);return;}
    for(const e of j.entries.filter(e=>e.replace)){if(e.existed)atomic(e.file,fs.readFileSync(path.join(j.archive,e.saved)),e.mode);else{noLinks(e.file);if(exists(e.file))require('./integration-writes').write(e.file,()=>fs.unlinkSync(e.file));}}j.stage='rolledback';atomic(path.join(j.archive,'manifest.json'),JSON.stringify(j));}
  recoverAll(){noLinks(this.dir);if(!exists(this.dir))return;for(const n of fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json\.journal$/.test(n))){const f=path.join(this.dir,n);noLinks(f);const j=JSON.parse(fs.readFileSync(f,'utf8'));if(!/^[a-f0-9-]{36}$/.test(j.id||'')||!['prepared','switching','committed'].includes(j.stage)||!Array.isArray(j.entries)||!Array.isArray(j.replacements)||n!==path.basename(this.journalFile(j.project,j.task)))throw Error(lt('復旧範囲が不正です'));const {p}=this.topic(j.project,j.task);if(path.resolve(j.archive)!==path.join(p.dir,'.ai/chat/history',j.task,j.id))throw Error(lt('復旧先の場所が不正です'));const allowed=this.sources(j.project,j.task);if(j.entries.some(e=>!allowed.includes(e.file)||!/^[0-9]+\.original$/.test(e.saved))||j.replacements.some(e=>!j.entries.some(original=>original.file===e.file&&original.replace))||(j.deleted||[]).some(f=>!j.entries.some(e=>e.file===f&&e.replace)))throw Error(lt('復旧範囲が不正です'));this.recover(j);
    const request=this.continueRecord(j.project,j.task);
    if(j.requestId&&request?.requestId===j.requestId)this.saveContinue(j.project,j.task,{...request,phase:j.stage==='committed'?'done':'selection',status:j.stage==='committed'?'done':'failed',result:{ok:j.stage==='committed',body:request.body||'skipped',rotate:j.stage==='committed'?'ok':'failed',generation:this.state(j.project,j.task).generation,archiveId:j.id}});
    require('./integration-writes').write(f,()=>fs.unlinkSync(f));}}
  rotate(project,task,input){
    this.idle(project,task);const old=this.state(project,task);
    if(input.requestId&&old.requestId===input.requestId)return {ok:true,duplicate:true,generation:old.generation,archiveId:old.archiveId};
    const request=this.continueRecord(project,task);
    if(request&&['pending','uncertain'].includes(request.status))throw Error(lt('会話整理の結果が未確認です。再送せず記録を確認してください'));
    if(this.topic(project,task).t.state==='完了')throw Error(lt('完了した作業は、再開してから要約してください'));
    throw Error(lt('新しい［要約して続ける］を使ってください'));
  }
  // 手動・自動で共通の切替：旧原文を保管し、journalで世代を一つ進める。
  commit(project,task,{requestId,revision,summary,record,row,keepTaskFile=false,extra,auto}){
    this.idle(project,task);const old=this.state(project,task),{p,file}=this.topic(project,task),id=randomUUID(),archive=path.join(this.archiveRoot(project,task),id),files=chat.files(p.dir,task),stateFile=this.file(project,task);noLinks(archive);fs.mkdirSync(archive,{recursive:true});
    const replace=new Set([file,...Object.values(files),path.join(p.dir,'.ai/chat',task+'.rules.md'),stateFile]);const handoff=path.join(p.dir,'.ai/handoff',task+'-limit.json');replace.add(handoff);
    const entries=this.sources(project,task).map((f,n)=>{noLinks(f);const existed=exists(f),bytes=existed?fs.readFileSync(f):null,mode=existed?fs.statSync(f).mode&0o777:undefined,saved=n+'.original';if(existed){if(!fs.statSync(f).isFile())throw Error(lt('保存する原文はファイルにしてください'));atomic(path.join(archive,saved),bytes,mode);}return {file:f,relative:path.relative(this.store.root,f),saved,existed,replace:replace.has(f),kind:f===files.log?'log':'record',bytes:bytes?.length,digest:bytes&&digest(bytes),mode};});
    const meta=exists(files.meta)?JSON.parse(fs.readFileSync(files.meta,'utf8')):{},generation=old.generation+1,at=new Date().toISOString();
    let made={};if(extra){const log=entries.find(e=>e.kind==='log'&&e.existed);made=extra({archive:path.relative(p.dir,archive),log:log?.saved||'',generation:old.generation,at});for(const x of made.files||[]){const f=path.join(archive,x.name);if(path.relative(archive,f).startsWith('..'))throw Error(lt('保管先が不正です'));noLinks(path.dirname(f));fs.mkdirSync(path.dirname(f),{recursive:true});noLinks(f);atomic(f,x.text,0o600);}if(made.summary)summary=made.summary;}
    row={...row};delete row.pendingQuestion;
    try{row.pendingQuestion=this.pendingQuestion(project,task);}
    catch(e){this.record('question-display-read-error',{project,task},{phase:'summary',error:e.message});}
    const fresh={accounts:meta.accounts||{},codexFast:meta.codexFast===true,models:meta.models||{},sessions:{},generation};
    const nextState={generation,requestId,archiveId:id,...(auto?{auto:{...auto,stage:'done',stageStarted:at,updated:at,timings:{...auto.timings,doneAt:at},stageHistory:[...(auto.stageHistory||[]),{stage:'done',at,attempt:auto.attempt||0}],archiveId:id,reply:undefined}}:{})};const replacements=[...(keepTaskFile?[]:[{file,bytes:replaceLatest(fs.readFileSync(file,'utf8'),summary)}]),{file:files.log,bytes:JSON.stringify({at,...row,...(made.summary?{text:row.text+made.summary}:{}),archiveId:id,generation})+'\n'},{file:files.meta,bytes:JSON.stringify(fresh)},{file:files.queue,bytes:'[]'},{file:stateFile,bytes:JSON.stringify(nextState)}];
    const j={id,project,task,archive,requestId,generation:old.generation,at,summary:record??summary,revision,entries,deleted:[path.join(p.dir,'.ai/chat',task+'.rules.md'),handoff],replacements:replacements.map(r=>({file:r.file,digest:digest(r.bytes)})),stage:'prepared',...(auto?{auto:{source:auto.source||'fallback',model:auto.model||''},index:'INDEX.md',topics:made.topics||[]}:{})};const jf=this.journalFile(project,task);
    if(auto)j.next=replacements.map((r,i)=>{const saved='next-'+i,mode=0o600;atomic(path.join(archive,saved),r.bytes,mode);return {file:r.file,saved,mode,digest:digest(r.bytes)};});
    atomic(jf,JSON.stringify(j));
    const request=this.continueRecord(project,task);if(request?.requestId===requestId)this.saveContinue(project,task,{...request,phase:'archive',archiveId:id});
    this.checkpoint('archive',j);
    try{this.idle(project,task);if(revision!==this.revision(project,task))throw Error(lt('会話が変わりました。内容を確認し直してください'));this.verifyArchive(j);j.stage='switching';atomic(jf,JSON.stringify(j));if(request?.requestId===requestId)this.saveContinue(project,task,{...request,phase:'switching',archiveId:id});this.checkpoint('switching',j);for(const r of replacements)atomic(r.file,r.bytes,entries.find(e=>e.file===r.file)?.mode);for(const r of replacements)if(digest(fs.readFileSync(r.file))!==digest(r.bytes))throw Error(lt('切り替え済み会話の復旧照合が必要です'));for(const f of [path.join(p.dir,'.ai/chat',task+'.rules.md'),handoff]){noLinks(f);if(exists(f))require('./integration-writes').write(f,()=>fs.unlinkSync(f));}const committed={...j,stage:'committed'};atomic(jf,JSON.stringify(committed));j.stage='committed';atomic(path.join(archive,'manifest.json'),JSON.stringify(j));this.writeIndex(project,task);this.reset(project,task,generation);fs.unlinkSync(jf);return {ok:true,generation,archiveId:id};}
    catch(e){e.rotation=j.stage==='committed'?'committed':'failed';if(j.stage!=='committed'){try{this.recover(j);if(j.stage==='committed')e.rotation='committed';fs.unlinkSync(jf);}catch(r){this.failure=r.message;e.rotation='uncertain';}}else this.failure=e.message;e.archiveId=id;e.generation=generation;throw e;}
  }
  // 作業ごとの総目次。保存済みmanifestから作り直すので、失敗しても原文・切替には影響しない。
  writeIndex(project,task){try{const root=this.archiveRoot(project,task),list=this.archives(project,task).map(a=>({...this.manifest(project,task,a.id),...a})).filter(m=>m.index).sort((a,b)=>a.at.localeCompare(b.at));if(list.length)for(const f of auto.totalIndexes(task,list))atomic(path.join(root,f.name),f.text);}catch(e){/* 目次は再生成できる */}}
  indexFile(project,task){const f=path.join(this.archiveRoot(project,task),'INDEX.md');try{noLinks(f);return exists(f)?f:'';}catch(e){return '';}}
  selectionPreview(project,task){const job=this.autoJob(project,task);if(job?.stage==='done'&&job.counts)return {...job.counts};const sel=auto.build({rows:this.logRows(project,task),task:this.topic(project,task).t});return {topics:sel.topics.length,residual:sel.items.filter(x=>x.type==='residual').length,unconfirmed:sel.items.filter(x=>x.type==='residual'&&x.text.includes(lt('承認未確認（AI推定）：'))).length};}
  // ---- ボタン一回の自動整理（人の入力なし）----
  autoJob(project,task){return this.state(project,task).auto||null;}
  organizing(project,task){try{const a=this.autoJob(project,task);return a&&(AUTO_ACTIVE.includes(a.stage)||a.stage==='reserved'&&a.trigger==='continue')?a:null;}catch(e){return null;}}
  setAuto(project,task,patch){const s=this.state(project,task);if(!s.auto)throw Error(lt('整理の記録がありません'));const at=new Date().toISOString(),changed=patch.stage&&patch.stage!==s.auto.stage;const next={...s.auto,...patch,updated:at,...(changed?{stageStarted:at,timings:{...s.auto.timings,...patch.timings,[patch.stage+'At']:at},stageHistory:[...(s.auto.stageHistory||[]),{stage:patch.stage,at,attempt:patch.attempt??s.auto.attempt??0}]}:{})};atomic(this.file(project,task),JSON.stringify({...s,auto:next}));
    const r=this.continueRecord(project,task);if(r?.requestId===next.requestId){const ended=['failed','cancelled'].includes(next.stage);this.saveContinue(project,task,{...r,phase:next.stage==='writing'?'archive':r.phase||'selection',status:ended&&!['uncertain','done'].includes(r.status)?'failed':r.status,result:ended&&!['uncertain','done'].includes(r.status)?{ok:false,body:r.body||'skipped',rotate:'failed',error:next.error||next.reason||''}:r.result});}return next;}
  autoStart(project,task,{requestId,generation,trigger='manual'}={}){
    this.topic(project,task);if(this.failure)throw Error(lt('会話整理の復旧が必要です：')+this.failure);if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw Error(lt('整理の番号が不正です'));
    const s=this.state(project,task),a=s.auto;if(a?.requestId===requestId)return a; // 同じ要求（再送・通信不明）は同じ仕事を返す
    if(generation!==undefined&&generation!==s.generation)throw Error(lt('会話が切り替わりました。新しい会話を開いてください'));
    if(a&&a.generation===s.generation&&!AUTO_END.includes(a.stage))return a; // 二重クリック・他タブは実行中の仕事へ合流
    const previous=this.continueRecord(project,task);
    if(previous&&['pending','uncertain'].includes(previous.status)&&previous.requestId!==requestId)throw Error(lt('会話整理の結果が未確認です。再送せず記録を確認してください'));
    if(!previous||previous.requestId!==requestId)this.saveContinue(project,task,{requestId,generation:s.generation,revision:this.revision(project,task),body:'skipped',phase:'selection',status:'pending',result:{ok:false,pending:true,body:'skipped',rotate:'pending'}});
    const job={id:randomUUID(),requestId,project,task,generation:s.generation,trigger,stage:'reserved',attempt:0,reason:'',error:'',started:new Date().toISOString()};job.stageStarted=job.started;job.timings={reservedAt:job.started};job.stageHistory=[{stage:'reserved',at:job.started,attempt:0}];
    atomic(this.file(project,task),JSON.stringify({...s,auto:job}));return job;
  }
  autoReserveLong(project,task,{chars=0,compacted=false}={}){
    const {p,t}=this.topic(project,task);if(p.kind==='freetalk'||t.state==='完了'||t.completionPending)return null;
    if(chars<=120000&&!compacted)return null;
    const s=this.state(project,task),a=s.auto;
    // A cancelled/failed automatic rotation stays stopped for this generation.
    if(a?.generation===s.generation)return a;
    return this.autoStart(project,task,{requestId:randomUUID(),generation:s.generation,trigger:'context'});
  }
  autoCancel(project,task){const a=this.autoJob(project,task);if(!a||AUTO_END.includes(a.stage))return a;if(!['reserved','selecting','writing'].includes(a.stage)||exists(this.journalFile(project,task)))throw Error(lt('切替中のため取り消せません'));return this.setAuto(project,task,{stage:'cancelled',reason:''});}
  activeAutos(){return require('./state-read').memo(this,'activeAutos',()=>this.readActiveAutos());}
  readActiveAutos(){readNoLinks(this.dir);if(!exists(this.dir))return [];const out=[];for(const n of fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){try{const f=path.join(this.dir,n);noLink(f);const a=JSON.parse(fs.readFileSync(f,'utf8')).auto;if(a&&!AUTO_END.includes(a.stage)&&a.project&&a.task&&this.file(a.project,a.task)===f)out.push(a);}catch(e){/* 壊れた記録は個別の操作で知らせる */}}return out;}
  logRows(project,task){const {p}=this.topic(project,task),f=chat.files(p.dir,task).log;noLinks(f);return exists(f)?fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];}
  autoCollect(project,task){
    this.idle(project,task);const a=this.setAuto(project,task,{stage:'collecting',reason:'',timings:{...this.autoJob(project,task).timings,replyReceivedAt:undefined,writingAt:undefined,doneAt:undefined}}),rows=this.logRows(project,task),marker=a.id;
    const input=auto.selectionInput(rows);let inputFile='';
    if(input.text.length>auto.INPUT_INLINE){
      // Content-addressed private spool, outside every project's ledger. Keep it for saved queues/restarts.
      inputFile=path.join(this.dir,'inputs',digest(project+'\0'+task+'\0'+marker+'\0'+input.text)+'.txt');
      atomic(inputFile,input.text,0o600);
    }
    return {rowsAt:rows.length,marker,rowsHash:digest(JSON.stringify(rows)),taskHash:taskDigest(this.topic(project,task).t),inputFile,inputStats:{characters:input.text.length,lines:input.text.split('\n').length,messages:input.messages,excludedTools:input.tools},prompt:auto.prompt({marker,rowsAt:rows.length,task,input:input.text,inputFile})};
  }
  selectionReply(project,task){return auto.selectionTurns(this.logRows(project,task),this.autoJob(project,task)).reply;}
  selectionQueued(project,task,item){return auto.selectionTurns(this.logRows(project,task),this.autoJob(project,task)).queued(item);}
  selectionQueueState(project,task,item){return auto.selectionTurns(this.logRows(project,task),this.autoJob(project,task)).queueState(item);}
  autoFinish(project,task,{reply=null,source='fallback',model='',replyReceivedAt}={}){
    const a=this.autoJob(project,task);if(!a||!['selecting','writing'].includes(a.stage))throw Error(lt('整理の段階が不正です'));
    const rows=this.logRows(project,task),{t}=this.topic(project,task),{related}=auto.selectionTurns(rows,a);
    // 選別の依頼・返事・知らせ以外に人やAIの発言が増えたら、選び直す（2回目は止めて知らせる）。
    if((a.rowsHash&&a.rowsHash!==digest(JSON.stringify(rows.slice(0,a.rowsAt))))||(a.taskHash&&a.taskHash!==taskDigest(t))||rows.some((r,i)=>i>=a.rowsAt&&(r.role==='user'||a.selectionRequest&&r.role==='assistant')&&!related.has(i))){const attempt=(a.attempt||0)+1;return this.setAuto(project,task,attempt<2?{stage:'reserved',attempt,reason:lt('整理中に会話が増えたため選び直します')}:{stage:'failed',attempt,error:lt('整理中に会話が増えたため止めました。もう一度押してください')});}
    if(reply&&source==='ai'&&!a.timings?.replyReceivedAt)this.setAuto(project,task,{timings:{...a.timings,replyReceivedAt:replyReceivedAt||new Date().toISOString()}});
    const job=a.stage==='writing'?a:this.setAuto(project,task,{stage:'writing',reply:typeof reply==='string'?reply.slice(0,60000):null,source,model,reason:''});
    const previous=this.archives(project,task)[0],sel=auto.build({rows:rows.slice(0,a.rowsAt),reply:job.reply,task:t,source:job.source,previous:previous?path.relative(this.topic(project,task).p.dir,path.join(this.archiveRoot(project,task),previous.id)):''});
    const row={role:'event',summaryAuto:true,text:''};
    const request=this.continueRecord(project,task);
    this.checkpoint('selection',job);
    try{const out=this.commit(project,task,{requestId:a.requestId,revision:this.revision(project,task),summary:'',row,keepTaskFile:t.state==='完了'||t.completionPending===true||t.state==='完了確認待ち',auto:{...job,source:sel.source,counts:{topics:sel.topics.length,residual:sel.items.filter(x=>x.type==='residual').length,unconfirmed:sel.items.filter(x=>x.type==='residual'&&x.text.includes(lt('承認未確認（AI推定）：'))).length}},extra:ctx=>{const r=auto.files(sel,{...ctx,model:job.model});return {files:r.files,summary:r.handoff,topics:sel.topics.map(x=>x.title)};}});
      const result={...out,body:request?.body||'skipped',rotate:'ok',completionHash:this.topic(project,task).t.completionHash};
      const done=this.autoJob(project,task),at=new Date().toISOString();this.setAuto(project,task,{stageStarted:at,timings:{...done.timings,doneAt:at},stageHistory:done.stageHistory.map(h=>h.stage==='done'?{...h,at}:h)});
      if(request?.requestId===a.requestId)this.saveContinue(project,task,{...request,phase:'done',status:'done',result});return result;}

    catch(e){if(request?.requestId===a.requestId){const rotate=e.rotation==='committed'||this.state(project,task).requestId===a.requestId?'committed':e.rotation==='uncertain'||this.failure||exists(this.journalFile(project,task))?'uncertain':'failed';this.saveContinue(project,task,{...request,phase:rotate==='committed'?'switching':'archive',status:rotate==='failed'?'failed':'uncertain',result:{ok:false,body:request.body||'skipped',rotate,error:e.message,recovery:rotate!=='failed'}});}if(!exists(this.journalFile(project,task))&&this.state(project,task).requestId!==a.requestId)this.setAutoSafe(project,task,{stage:'failed',error:e.message});throw e;}
  }
  setAutoSafe(project,task,patch){try{return this.setAuto(project,task,patch);}catch(e){return null;}}
}
module.exports={TaskHistory,summaryFields,summaryText,latest,replaceLatest};
