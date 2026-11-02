'use strict';
// Only identity validation and read-only delivery evidence; no automatic execution.
const fs=require('node:fs'),path=require('node:path'),U=require('./idea-utils');
class IdeaRunEvidence {
  constructor(host){Object.assign(this,host);}
  // Historical rows joined commentary and the final response. Recover only from
  // the completed, identity-bound CLI spool, never by searching prose for JSON.
  savedResult(project,r,row) {
    const S=require('./cli-spool'),m=row.automation,id=/^([a-f0-9-]{36}):final$/.exec(row.spoolId||'')?.[1];
    U.check(this.spoolRoot&&id&&r.spoolIds.includes(row.spoolId)&&row.ai==='codex'&&!row.error&&m?.closed===true&&!m.limit,'result-spool','終了原物を確認できません');
    const dir=path.join(this.spoolRoot,id),before=S.evidence(dir),req=S.strictRead(dir,'request.json'),exit=S.strictRead(dir,'exit.json'),finished=S.strictRead(dir,'finished.json');
    U.check(finished?.proofRequired===1&&S.strictRead(dir,'finished-confirmed.json')&&!S.failure(dir)&&exit?.code===0&&!exit.signal&&!exit.error,'result-spool','CLIの正常終了を確認できません');
    const o=req?.options,loc=this.location(project,r),metadata=this.metadata(this.ideas.read(project),r);
    U.check(U.hash(m.metadata)===U.hash(metadata)&&U.hash(o?.automation)===U.hash(metadata)&&o.ai==='codex'&&o.project===project&&o.task===r.task&&o.dir===loc.dir&&o.request===row.request&&row.request===r.requestId&&o.readOnly===true&&o.freshContext===true&&o.preserveTaskState===true&&o.contextMode==='idea'&&(o.limitSwitch?.original||o.text)===r.prompt,'result-spool','CLIの対象や依頼が一致しません');
    const texts=[];let n=0,done=false;
    for(const line of fs.readFileSync(path.join(dir,'out.jsonl'),'utf8').trimEnd().split('\n')){
      const entry=JSON.parse(line);U.check(entry.n===++n&&typeof entry.line==='string','result-spool','CLIの出力順を確認できません');
      for(const e of require('./chat').parse('codex',JSON.parse(entry.line))){
        U.check(!['limit','capacity'].includes(e.kind),'result-spool','CLIは正常終了していません');
        if(e.kind==='text'){U.check(!done,'result-spool','終了後の応答は使いません');texts.push(e.text);}
        if(e.kind==='done'){U.check(!done&&!e.error,'result-spool','CLIは正常終了していません');done=true;}
      }
    }
    U.check(done&&texts.length>1&&texts.join('\n\n')===row.text&&before===S.evidence(dir),'result-spool','会話とCLIの終了原物が一致しません');
    return {text:texts.at(-1),spoolId:row.spoolId,spoolHash:before,rowHash:U.hash(row)};
  }
  metadata(d,r) {return {kind:'idea',schema:1,projectUid:d.projectUid,runId:r.id,targets:r.targets,purpose:r.purpose,laneBindingRev:r.laneBindingRev,requestId:r.requestId,contextMode:'idea',readOnly:r.readOnly,autoGeneration:r.autoGeneration,stopGeneration:r.stopGeneration,releaseId:r.releaseId||null,reviewBinding:r.reviewId?{reviewId:r.reviewId,bundleHash:d.reviews[r.reviewId].bundleHash}:null};}
  location(project,r) {
    const p=this.ideas.project(project),t=p.tasks.find(t=>t.id===r.task);U.check(t,'idea-task','配送先の既存作業を確認してください');
    if(r.purpose==='organize'){U.check(fs.realpathSync(p.dir)===r.deliveryBinding.dir&&U.hash(U.identity(p.dir))===U.hash(r.deliveryBinding.identity),'idea-organize-binding','整理の配送先が変わりました');return {p,t,dir:r.deliveryBinding.dir,pdir:p.dir};}
    const lane=this.lane.resolve(project,r.laneBindingRev);U.check(t.id===lane.task,'idea-task','配送先が変更されました');return {p,t,dir:lane.workdirReal,pdir:p.dir};
  }
  verify(o,{adoption=false}={}) {
    U.check(o.automation?.kind==='idea'&&o.contextMode==='idea'&&o.freshContext===true&&o.preserveTaskState===true,'idea-metadata','台帳の実行情報が一致しません');
    const d=this.ideas.read(o.project),r=d.runs[o.automation.runId];U.check(r&&!r.closed&&U.hash(o.automation)===U.hash(this.metadata(d,r)),'idea-run','台帳の実行対象が変更されています');
    const l=this.location(o.project,r);U.check(o.task===r.task&&o.dir===l.dir&&o.readOnly===r.readOnly,'idea-location','台帳の実行場所や権限が一致しません');
    const original=o.limitSwitch?.original||o.text;U.check(original===r.prompt,'idea-request','台帳の依頼文が変更されています');
    U.check(o.request===r.requestId||String(o.request).startsWith('limit-')&&o.limitSwitch?.sourceRequest,'idea-request','配送識別が一致しません');
    if(!adoption)this.mayStart(o.project,r);this.gate.assert({dir:l.dir,owner:'chat:'+o.project+':'+o.task,adoption});return {r,...l};
  }
  evidence(project,r) {
    try {
      const p=this.ideas.project(project),rows=(U.strictRead(require('./chat').files(p.dir,r.task).log)||Buffer.from('')).toString().split('\n').filter(Boolean).map(line=>JSON.parse(line)),q=this.chats.queue(project,r.task),busy=this.chats.busy(project,r.task);
      const requests=new Set([r.requestId,r.queueId,...(r.segments||[]).map(s=>s.request)].filter(Boolean));
      const matches=x=>Boolean(x&&(x.automation?.runId===r.id||x.automation?.metadata?.runId===r.id||requests.has(x.request)||requests.has(x.id)||requests.has(x.limitSwitch?.sourceRequest)||requests.has(x.limitSwitch?.request)));
      const row=rows.findLast(x=>x.role==='assistant'&&x.automation?.metadata?.runId===r.id);
      if(row)return {state:'finished',row};
      if(matches(busy)||matches(busy?.options)||matches(busy?.userRow))return {state:'running'};
      if(q.some(matches))return {state:'accepted',queue:q.filter(matches)};
      let sent=rows.some(matches),spools=[];
      if(this.spoolRoot){
        if(this.spoolIndex?.root!==this.spoolRoot){this.spoolIndex?.close();this.spoolIndex=new (require('./idea-spool-index').IdeaSpoolIndex)(this.spoolRoot);}
        const entries=this.spoolIndex.snapshot();
        // Erasure also uses this result. An incomplete scan must carry an error
        // fence, not the empty unknown result that erasure may otherwise accept.
        if(!entries)return {state:'unknown',error:this.spoolIndex.error||'CLIの実行記録を確認中です'};
        for(const {name,request:req} of entries)if(matches(req?.options)||(r.spoolIds||[]).includes(name)){spools.push({id:name,request:req});sent=true;}
      }
      return {state:sent?'unknown':'absent',spools,...(rows.some(x=>x.role==='assistant'&&matches(x))?{resultPending:true}:{})};
    }catch(e){return {state:'unknown',error:e.message};}
  }
  async readyEvidence(project,r,timeoutMs=30000) {
    const found=this.evidence(project,r);
    if(found.state!=='unknown'||!this.spoolIndex?.pending)return found;
    if(!await this.spoolIndex.ready(timeoutMs))return {state:'unknown',error:this.spoolIndex.error||found.error};
    return this.evidence(project,r);
  }
  authorizeRecord(req,b) {const token=req.headers['x-idea-record'];if(!token)return false;const d=this.ideas.read(b.project);return Object.values(d.runs).some(r=>!r.closed&&r.recordCapability===token);}
}
module.exports={IdeaRunEvidence};
