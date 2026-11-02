'use strict';
// An organizer stopped by a human or declaration validation is not received.
// This explicit terminal preserves its original record and all delivery facts.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {noLinks,exists}=require('./remove'),continuation=require('./task-continuation'),{lt}=require('./locale');
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x),fail=()=>{throw Error(lt('中止の証拠を確認できません。再送せず最新の記録を確認してください'));};
const recovery=require('./integration-abandon-recovery');
const delegationText=require('./delegation-text');
const marker=x=>delegationText.unwrap(x?.limitSwitch?.original||x?.text).match(/^\[integration-auto:([a-f0-9]{64}):(organize|order|code|review)\]/);
const matches=(x,k,request)=>x?.integrationAuto?.key===k||marker(x)?.[1]===k||Boolean(request&&(x?.request===request||x?.requestKey===request||x?.limitSwitch?.sourceRequest===request));
class IntegrationAbandon {
  constructor({integrate,auto,chats,logFile}){Object.assign(this,{integrate,auto,chats,logFile});}
  previousReceipt(r,i,hand,read){
    const history=hand?.received||[];
    if(!Array.isArray(history)||history.some(x=>x?.integration===r.id))fail();
    if(!i.previous)return;
    // `previous` is the receipt used as the starting point of this increment,
    // not evidence that this integration has received anything. Verify its
    // earlier completed integration and pin that archive in the preview proof.
    const prior=history.filter(x=>x?.id===i.previous);
    if(prior.length!==1)fail();const p=prior[0];
    if(!/^[a-f0-9-]{36}$/.test(p.integration||'')||p.integration===r.id||!Number.isFinite(Date.parse(p.at))||!(Date.parse(p.at)<Date.parse(r.at))||p.target?.project!==r.project||p.target?.task!==r.task||p.target?.dir!==r.target||!i.previousHead||p.head!==i.previousHead||p.sourceHead!==i.previousHead)fail();
    const old=JSON.parse(read(path.join(this.integrate.dir,'history',p.integration+'.json')));
    const items=old.items?.filter(x=>x.project===i.project&&x.task===i.task)||[];
    if(old.id!==p.integration||old.complete!==true||old.abandoned||old.project!==r.project||old.task!==r.task||old.target!==r.target||!(Date.parse(old.at)<=Date.parse(p.at))||items.length!==1)fail();
    const item=items[0];
    if(item.receipt!==i.previous||!['受領済み','保持受領済み','片付け済み'].includes(item.state)||(item.sourceHead||item.source?.head)!==i.previousHead)fail();
  }
  inspect(project,task,allowArchive=false){
    const h=this.integrate,r=h.read(project,task);
    require('./integration-sibling').blocked(h,r);
    if(!r||r.complete||r.abandoned||!r.auto?.stopped||!r.items?.length||r.auto.main||r.auto.prepared||Object.keys(r.auto.migrations||{}).length)fail();
    if(r.items.some(i=>i.receipt||i.integrated||i.merge||!['待ち','整理中'].includes(i.state)))fail();
    const attempts=Object.entries(r.auto.attempts||{});if(!attempts.length)fail();
    const waiting=this.auto.waiting({project,task,selected:r.items});if(waiting.length)throw Object.assign(Error(lt('稼働中の処理の終了後に中止を確認してください')),{waiting});
    const sources=[],directories=[],rows=[],audit=[];
    const read=(file,optional=false)=>{
      noLinks(file);if(!exists(file)){if(!optional)fail();sources.push({file,missing:true});return null;}
      const stat=fs.statSync(file);if(!stat.isFile())fail();const bytes=fs.readFileSync(file);
      sources.push({file,sha256:hash(bytes),mode:stat.mode&0o777});return bytes.toString('utf8');
    };
    const listing=dir=>{noLinks(dir);const names=exists(dir)?fs.readdirSync(dir).sort():[];directories.push({dir,names,missing:!exists(dir)});return names;};
    const lines=(s,file)=>{if(s===null)return [];return s.split('\n').flatMap((line,n)=>{
      if(!line.trim())return [];try{return [{row:JSON.parse(line),file,line:n+1,sha256:hash(line)}];}catch{
        // Escapes could conceal a matching key in a torn JSON row.
        if(line.includes('\\')||/integration/i.test(line)||attempts.some(([k,a])=>[k,a.delivery?.request,...(file===this.logFile||file===this.logFile.replace(/\.jsonl$/,'.old.jsonl')?[a.project,a.task]:[])].filter(Boolean).some(x=>line.includes(x))))fail();
        sources.push({file,line:n+1,sha256:hash(line),unparsed:true});return [];
      }
    });};
    read(h.file(project,task));
    // An archive published before an active-record failure is an uncertain write.
    if(!allowArchive&&exists(path.join(h.dir,'history',r.id+'.json')))throw Error(lt('中止の保存結果が不明です。再送せず最新の記録を確認してください'));
    const all=h.store.listProjects();
    for(const p of all)for(const t of p.tasks){
      const dir=path.join(p.dir,'.ai/chat'),log=path.join(dir,t.id+'.jsonl');rows.push(...lines(read(log,true),log));
      const queueFile=path.join(dir,t.id+'.queue.json'),q=JSON.parse(read(queueFile,true)||'[]');if(!Array.isArray(q))fail();
      for(const [k,a]of attempts){const request=a.delivery?.request;if(q.some(x=>matches(x,k,request)))fail();}
      // The runner's in-memory queues/running turn can lead their on-disk copy.
      for(const [k,a]of attempts){if(this.chats.queue(p.id,t.id).some(x=>matches(x,k,a.delivery?.request)))fail();const run=this.chats.busy(p.id,t.id);if(run&&[run,run.o,run.options,run.row].some(x=>matches(x,k,a.delivery?.request)))fail();}
      const limits=path.join(p.dir,'.ai/handoff');for(const n of listing(limits).filter(n=>n.startsWith(t.id+'-')&&n.endsWith('.json'))){const x=JSON.parse(read(path.join(limits,n)));if(attempts.some(([k,a])=>matches(x,k,a.delivery?.request)||matches(x.request,k,a.delivery?.request)||matches(x.original,k,a.delivery?.request)))fail();}
      const ar=path.join(dir,'history',t.id);
      for(const id of listing(ar)){
        if(!/^[a-f0-9-]{36}$/.test(id))continue;
        const mf=path.join(ar,id,'manifest.json'),m=JSON.parse(read(mf));
        if(m.project!==p.id||m.task!==t.id||m.id!==id||m.stage!=='committed'||!Array.isArray(m.entries))fail();
        for(const e of m.entries.filter(e=>e.kind==='log')){if(!/^[0-9]+\.original$/.test(e.saved))fail();const file=path.join(ar,id,e.saved),s=read(file);if(hash(s)!==e.digest)fail();rows.push(...lines(s,file));}
      }
    }
    for(const file of [this.logFile,this.logFile.replace(/\.jsonl$/,'.old.jsonl')])audit.push(...lines(read(file,file!==this.logFile),file));
    const spool=require('./cli-spool'),spoolRoot=this.chats.spoolRoot;
    if(spoolRoot)for(const n of listing(spoolRoot)){
      const dir=path.join(spoolRoot,n);noLinks(dir);if(!fs.statSync(dir).isDirectory())continue;
      const file=path.join(dir,'request.json'),raw=read(file,true);if(!raw)continue;const o=JSON.parse(raw).options;
      if(attempts.some(([k,a])=>matches(o,k,a.delivery?.request))){if(spool.failure(dir)||!read(path.join(dir,'finished.json'),true))fail();read(path.join(dir,'exit.json'));read(path.join(dir,'out.jsonl'));}
    }
    for(const i of r.items){const p=all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);if(!t||h.removal.busy(i.project,i.task)||h.removal.locked(i.project))fail();read(h.store.taskFile(i.project,i.task));read(h.transfer.file(i.project,i.task),true);const hand=h.transfer.read(i.project,i.task);if(hand?.integrating===r.id)fail();this.previousReceipt(r,i,hand,read);const dir=t.workdir||h.baseOf(p);if(h.gitw.merging(dir))fail();}
    if(h.gitw.merging(r.target))fail();
    const proof={recordHash:hash(json(r)),sources,directories,attempts:{}};let stopped=0;
    for(const [k,a]of attempts){
      if(!/^[a-f0-9]{64}$/.test(k)||!a.request||!a.delivery||['intent','unknown'].includes(a.delivery.state)||a.deliveryHistory?.some(x=>['intent','unknown'].includes(x.delivery?.state)))fail();
      if(a.delivery.state==='not-sent'){
        if(!['organize','order','review'].includes(a.phase)||marker(a.request)?.[1]!==k||marker(a.request)?.[2]!==a.phase)fail();
        const e=this.auto.deliveryEvidence?.(r,k,a);if(!e?.complete||e.sent)fail();proof.attempts[k]={kind:'not-sent',proof:e};continue;
      }
      if(a.delivery.state!=='accepted'||!a.delivery.request)fail();
      const request=a.delivery.request,found=rows.filter(x=>matches(x.row,k,request));
      if(found.some(x=>x.row.request!==request||x.row.integrationAuto&&x.row.integrationAuto.key!==k))fail();
      const users=found.filter(x=>x.row.role==='user'),ends=found.filter(x=>x.row.role==='assistant');
      // Archives can contain a duplicate of an active row, but not a successor.
      const unique=xs=>[...new Map(xs.map(x=>[x.sha256,x])).values()];
      const u=unique(users),e=unique(ends);if(u.length!==1||e.length!==1)fail();
      const end=e[0],row=end.row,m=row.integrationAuto;
      if(!m||m.key!==k||row.asks?.length||m.limit)fail();
      const recovery=require('./integration-organize-recovery');
      if(a.phase==='superseded'&&a.organizeFailure){
        if(u[0].row.text!==a.request.text&&u[0].row.text!==lt`【渡した依頼：${a.request.title}】\n${a.request.text}`)fail();
        recovery.history(r,k,a,row);proof.attempts[k]={kind:'validation-failed-superseded',user:u[0],end,failure:a.organizeFailure};stopped++;continue;
      }
      if(a.phase==='organize'&&m.phase==='organize'&&m.closed===true){
        const failure=recovery.abandonFailure(h,r,k,a,row);
        if(u[0].row.text!==a.request.text&&u[0].row.text!==lt`【渡した依頼：${a.request.title}】\n${a.request.text}`)fail();
        if(this.auto.pendingRequest?.(r,k,'organize')||this.chats.busy(a.project,a.task))fail();
        const sends=audit.filter(x=>x.row.action==='delegate'&&x.row.project===a.project&&x.row.task===a.task&&x.row.request===request);
        if(sends.length!==1||audit.some(x=>x.row.action==='delegate'&&matches(x.row,k,request)&&x!==sends[0]))fail();
        proof.attempts[k]={kind:'validation-failed',user:u[0],end,send:sends[0],failure};stopped++;continue;
      }
      if(a.phase==='verified'||a.phase==='superseded'){
        if(row.error||m.closed!==true||!['organize','order','review'].includes(m.phase)||marker(u[0].row)?.[1]!==k)fail();
        if(m.phase==='review'){if(!row.text?.includes(`[integration-review:${k}:pass]`)||!a.savedResults||!this.auto.isolatedCompletion(a,row))fail();this.auto.verifySavedReview(r,a);}
        else {
          const saved=m.saved,p=all.find(p=>p.id===a.project),t=p?.tasks.find(t=>t.id===a.task),dir=m.phase==='order'?r.target:t?.workdir||h.baseOf(p),canonical=require('./resource-scope').canonical;
          if(!dir||!saved?.dir||canonical(saved.dir)!==canonical(dir)||!/^[a-f0-9]{40}$/.test(saved.head||'')||saved.head!==require('./integration-writes').inspect(h.gitw,dir)?.head||(m.phase==='order'?k!==hash(r.id+'\0order'):!recovery.key(r,k,a)))fail();
          if(m.phase==='order'){
            const prefix=`[integration-order:${k}:`,start=String(row.text||'').indexOf(prefix),end=String(row.text||'').indexOf(']]',start);
            if(start<0||end<0||r.auto.order?.state!=='done')fail();
            const keys=JSON.parse(row.text.slice(start+prefix.length,end+1));
            if(!Array.isArray(keys)||keys.length!==r.items.length||new Set(keys).size!==keys.length||keys.some(x=>!r.items.some(i=>i.project+'/'+i.task===x))||json(keys)!==json(r.auto.order.keys))fail();
          }
          // Completion itself writes Hub records after the CLI's Git save.
          // Reuse the existing provenance and allowed-commit-range guards,
          // rather than mistaking those records for unsaved product changes.
          if(m.phase==='order')h.simple.orderHead(r,k,row);
          else h.simple.organizedItem(r,{...a,phase:'organize'},row);
          read(path.join(h.store.root,'_hub/integration-writes.json'),true);
          proof.attempts[k]={savedHead:saved.head,currentHead:h.gitw.inspect(dir)?.head};
        }proof.attempts[k]={...proof.attempts[k],kind:'verified',user:u[0],end};continue;
      }
      if(u[0].row.text!==a.request.text&&u[0].row.text!==lt`【渡した依頼：${a.request.title}】\n${a.request.text}`)fail();
      if(a.phase!=='organize'||m.phase!=='organize'||m.closed===true||row.error!=='止めました'||marker(u[0].row)?.[1]!==k||!recovery.key(r,k,a))fail();
      if(this.auto.pendingRequest?.(r,k,'organize')||this.chats.busy(a.project,a.task))fail();
      const sends=audit.filter(x=>x.row.action==='delegate'&&x.row.project===a.project&&x.row.task===a.task&&x.row.request===request);
      const stops=audit.filter(x=>x.row.action==='chatstop'&&x.row.project===a.project&&x.row.task===a.task&&Date.parse(x.row.at)>=Date.parse(u[0].row.at)&&Date.parse(x.row.at)<=Date.parse(row.at));
      if(sends.length!==1||stops.length!==1||!Number.isFinite(Date.parse(row.at))||Date.parse(row.at)<Date.parse(u[0].row.at))fail();
      // A second delegate for this key/request, including a limit successor, is unsafe.
      if(audit.some(x=>x.row.action==='delegate'&&matches(x.row,k,request)&&x!==sends[0]))fail();
      proof.attempts[k]={kind:'cancelled-by-human',user:u[0],end,send:sends[0],stop:stops[0]};stopped++;
    }
    if(!stopped)fail();
    // Full live safety checks above still run at confirmation. Only evidence
    // belonging to this abort is pinned; unrelated activity may continue.
    const pinned=new Set(r.items.flatMap(i=>[h.store.taskFile(i.project,i.task),h.transfer.file(i.project,i.task)]));
    for(const i of r.items)if(i.previous){const p=h.transfer.read(i.project,i.task)?.received?.find(x=>x.id===i.previous);if(p)pinned.add(path.join(h.dir,'history',p.integration+'.json'));}
    proof.sha256=hash(json({recordHash:proof.recordHash,attempts:proof.attempts,sources:sources.filter(x=>pinned.has(x.file))}));return {r,proof};
  }
  status(project,task){try{
    const residue=recovery.residue(this.integrate,project,task);
    if(residue){if(residue.action)this.inspect(project,task,true);return {allowed:Boolean(residue.action),id:this.integrate.read(project,task).id,message:residue.message,recovery:recovery.publicInfo(residue)};}
    const {r,proof}=this.inspect(project,task);return {allowed:true,stopKind:Object.values(proof.attempts).some(a=>a.kind.startsWith('validation-failed'))?'validation':'human',id:r.id,evidence:proof.sha256,items:r.items.map(i=>({title:i.title,project:i.project,task:i.task})),message:lt('未受領の統合を中止し、子作業・会話・コピー・引渡しを残します。本体の保留記録も保持します')};
  }catch(e){return {allowed:false,message:e.message,waiting:e.waiting};}}
  preview({project,task,recover}){
    const residue=recovery.residue(this.integrate,project,task);
    if(residue?residue.action!==recover||!recover:Boolean(recover))fail();
    const {r,proof}=this.inspect(project,task,Boolean(residue)),at=new Date().toISOString(),value={action:'abandon',project,task,id:r.id,proof,at,...(residue?{residue:recovery.publicInfo(residue)}:{})};
    return {allowed:true,id:r.id,evidence:proof.sha256,items:r.items.map(i=>({title:i.title,project:i.project,task:i.task})),recovery:recovery.publicInfo(residue),token:this.integrate.token(value).token};
  }
  apply(b){
    const h=this.integrate,x=h.tokens.get(b.token),d=x?.value;
    if(!d||d.action!=='abandon'||d.project!==b.project||d.task!==b.task||d.id!==b.id||b.confirm!==true||Date.now()-x.at>600000)fail();
    // Consume before either durable write. An uncertain response never replays.
    h.tokens.delete(b.token);
    if(d.residue){
      const residue=recovery.residue(h,b.project,b.task);
      if(!residue||!residue.action||residue.sha256!==d.residue.sha256||residue.recordHash!==d.residue.recordHash||residue.action!==d.residue.action)fail();
      const {r,proof}=this.inspect(b.project,b.task,true);if(proof.sha256!==d.proof.sha256)fail();
      try{return {ok:true,id:r.id,received:0,cleaned:0,...recovery.commit(h,residue,r)};}catch(e){throw Object.assign(Error('回復の保存結果が不明です。再送せず最新の記録を確認してください'),{delivery:{state:'unknown'},cause:e});}
    }
    const {r:original,proof}=this.inspect(b.project,b.task);if(proof.sha256!==d.proof.sha256)fail();
    const abandoned={at:d.at,by:'human',reason:'stopped-organize',evidence:proof,original:structuredClone(original),attempts:Object.fromEntries(Object.entries(proof.attempts).map(([k,p])=>[k,p.kind]))};
    const r=recovery.reconstruct(original,abandoned);
    // Immutable archive first: publication cannot discard the former record.
    try{continuation.archive(h.dir,r);h.save(r);}catch(e){throw Object.assign(Error(lt('中止の保存結果が不明です。再送せず最新の記録を確認してください')),{delivery:{state:'unknown'},cause:e});}
    // Notification failure cannot undo a verified durable abort.
    let notificationError;try{this.auto.notify(r);}catch{notificationError=true;}
    return {ok:true,abandoned:true,complete:true,id:r.id,received:0,cleaned:0,...(notificationError?{notificationError:true}:{})};
  }
}
module.exports={IntegrationAbandon};
