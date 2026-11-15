'use strict';
const persistence = require('./platform').persistence;
const fs=require('./platform/file-io'),path=require('node:path'),crypto=require('node:crypto');
const key=(o={})=>JSON.stringify([o.project,o.task]);
const blocked=(reason='AIは停止・保留中です。ターミナル起動・AI間の依頼・待ち指示の開始には、設定の［復旧］でAIの開始を再び許可してください。会話の入力欄から新しい指示を手で送る場合は、その1回だけ再開できます')=>Object.assign(Error(reason),{code:'ai-paused'});
const matches=(r,o)=>(!r.project||r.project===o.project)&&(!r.task||r.task===o.task);
function validState(d){return d?.version===1&&Number.isSafeInteger(d.epoch)&&d.epoch>=0&&typeof d.all==='boolean'&&d.tasks&&typeof d.tasks==='object'&&!Array.isArray(d.tasks)&&Object.entries(d.tasks).every(([k,t])=>t&&typeof t.project==='string'&&typeof t.task==='string'&&k===key(t)&&Number.isSafeInteger(t.epoch)&&t.epoch>=0&&typeof t.held==='boolean'&&(t.autoHeld===undefined||typeof t.autoHeld==='boolean'))&&(!d.results||Array.isArray(d.results))&&(d.restartIds===undefined||Array.isArray(d.restartIds)&&d.restartIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=80));}
// Durable start barrier, independent of any project/idea ledger. An unclean Hub
// exit also pauses new starts, including when a stop could not be persisted.
class StopControl{
  constructor({dir,write,boot=true}={}){this.dir=dir;this.file=path.join(dir,'state.json');this.write=write||((f,d)=>{fs.mkdirSync(dir,{recursive:true,mode:0o700});const tmp=f+'.'+crypto.randomUUID(),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(d));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,f);persistence.syncDirectory(dir);});this.data={version:1,epoch:0,all:false,tasks:{}};this.error='';this.results=[];this.saveChecks=new WeakMap();this.active=false;this.instance=crypto.randomUUID();this.manualChains=new Map();
    try{const d=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!validState(d))throw Error('停止記録の形式を確認できません');this.data=d;this.results=d.results||[];}catch(e){if(e.code!=='ENOENT'){this.error=e.message;this.data.all=true;}}
    if(boot){try{if(!fs.existsSync(this.file))this.persist();if(fs.existsSync(path.join(dir,'armed'))||fs.existsSync(path.join(dir,'intent.json'))){this.data.all=true;this.data.epoch++;this.persist();}fs.mkdirSync(dir,{recursive:true,mode:0o700});this.write(path.join(dir,'armed'),{at:Date.now(),instance:this.instance});}catch(e){this.error=e.message;this.data.all=true;}}
  }
  persist(){try{this.write(this.file,this.data);return true;}catch(e){this.error=e.message;this.data.all=true;return false;}}
  ticket(o){return {epoch:this.data.epoch,task:this.data.tasks[key(o)]?.epoch||0};}
  changed(o,t){const n=this.ticket(o);return !t||t.epoch!==n.epoch||t.task!==n.task;}
  held(o){const task=this.data.tasks[key(o)];return Boolean(this.error||this.data.all||task?.held||task?.autoHeld);}
  manualChain(o,t){return Boolean(t?.manual===true&&t.chain&&this.manualChains.get(key(o))===t.chain&&!this.changed(o,t));}
  delegateTicket(o,run,caller){
    // A busy task alone is not caller proof. Only the live CLI's private
    // header, bound to this manual turn (or its admitted successor), qualifies.
    if(!caller||!run||run.pending||run.stopped||run.finished||run.finalizing||run.spoolError||run.delegateToken!==caller||key(run.options)!==key(o)||!this.manualChain(o,run.options.stopTicket))throw blocked();
    const t=run.options.stopTicket;this.assert(o,t);return {...t};
  }
  delegated(o,t){return o.origin==='delegate'&&!o.stopHeld&&this.manualChain(o,t);}
  assert(o,t){
    if(this.error)throw blocked('AIは保留中です。停止状態の保存を確認できません。設定の［復旧］で保存エラーを確認してください');
    if(this.data.all)throw blocked('非常停止による保留中です。設定の［復旧］でAIの開始を再び許可してください');
    if(t&&this.changed(o,t))throw blocked('AIは保留中です。停止状態が更新されています。画面を読み直し、内容を確認してもう一度送ってください');
    const task=this.data.tasks[key(o)];if(task?.held||task?.autoHeld&&!this.manualChain(o,t))throw blocked();
    if(task?.autoHeld)this.checkManual(o,t);
  }
  // This probe is tied to the exact stopped run, never serialized or reused
  // after a boot. It can upgrade saving only, never process/ownership evidence.
  watchSave(result, saved){this.saveChecks.set(result,saved);}
  checkManual(o,t){
    const task=this.data.tasks[key(o)];
    if(this.active||this.restarting)throw blocked('停止・再起動の処理中です。終わってからもう一度送ってください');
    if(this.error)throw blocked('停止状態の保存を確認できません。設定の［復旧］で保存エラーを確認してください');
    if(this.data.all)throw blocked('非常停止による保留中です。設定の［復旧］でAIの開始を再び許可してください');
    if(!task||(task.held!==true&&task.autoHeld!==true)||this.changed(o,t))throw blocked('停止状態が更新されています。画面を読み直し、内容を確認してもう一度送ってください');
    const issues=(this.data.errors||[]).filter(e=>typeof e==='string'
      // Legacy missing-hook errors are known cleanup failures, not exit proof.
      ? e!=='ideas.auto is not a function' : e.blocking!==false&&matches(e,o));
    if(issues.length)throw blocked('中止の後処理を確認できません。設定の［復旧］でこの作業の停止結果を確認してください');
    let updated=false;
    const results=this.results.filter(r=>matches(r,o));
    for(const r of results)if(r.state==='exited'&&r.save!=='saved'){
      try{if(this.saveChecks.get(r)?.()===true){r.save='saved';updated=true;}}catch{/* Keep saving unconfirmed. */}
    }
    if(updated&&!this.persist())throw blocked('終了結果の保存に失敗しました。設定の［復旧］で保存エラーを確認してください');
    for(const r of results){
      if(!['exited','not-started'].includes(r.state))throw blocked(r.state==='external-unconfirmed'
        ? '外部サービス側の終了は未確認です。サービス側を確認し、設定の［復旧］で停止結果を確認してください'
        : '前のAIの終了・所有関係を確認できません。設定の［復旧］で停止結果を確認してください');
      // A PTY has no durable output transaction. Confirmed exit is enough for
      // a manual send, but never pretend its memory-only output was saved.
      if(r.save!=='saved'&&!(r.kind==='terminal'&&r.output==='memory-only'&&!r.saveError))throw blocked('前の会話の終了保存が未確認です。保存が終わってからもう一度送ってください。保存エラーが残る場合は設定の［復旧］を確認してください');
    }
  }
  resumeTask(o,t){
    this.checkManual(o,t);
    // Only this new manual turn is admitted. Automatic starts and old tickets
    // remain fenced, including after this turn finishes and after a cold boot.
    this.data.tasks[key(o)]={...this.data.tasks[key(o)],held:false,autoHeld:true,epoch:t.task+1};
    if(!this.persist())throw blocked('再開状態の保存に失敗しました。設定の［復旧］で保存エラーを確認してください');const chain=crypto.randomUUID();this.manualChains.set(key(o),chain);return {...this.ticket(o),manual:true,chain};
  }
  pause(o){if(o){const k=key(o),old=this.data.tasks[k];this.manualChains.delete(k);this.data.tasks[k]={project:o.project,task:o.task,held:true,epoch:(old?.epoch||0)+1};}else{this.manualChains.clear();this.data.all=true;this.data.epoch++;}
    // In-memory barrier is already closed before either write can fail.
    try{this.write(path.join(this.dir,'intent.json'),{all:!o,...o,at:Date.now()});}catch(e){this.error=e.message;this.data.all=true;}
    const saved=this.persist();if(saved&&!this.error)try{fs.unlinkSync(path.join(this.dir,'intent.json'));}catch(e){if(e.code!=='ENOENT')this.error=e.message;}return !this.error;
  }
  resume(){if(this.active||this.restarting)throw Error('停止・再起動の処理が終わるまでお待ちください');if(this.results.some(r=>r.state==='alive'||r.state==='ownership-unknown'||r.state==='failed'))throw Error('停止できたか確認できないAIがあります。結果を確認してください');
    const old=this.data;this.manualChains.clear();this.data={version:1,epoch:old.epoch+1,all:false,tasks:{},...(old.restart?{restart:{...old.restart,phase:'released',reason:'停止後の保留を解除しました。停止前の待ち指示は自動では始まりません'}}:{}),...(old.restartIds?{restartIds:old.restartIds}:{})};this.error='';if(!this.persist())throw blocked();try{fs.unlinkSync(path.join(this.dir,'intent.json'));}catch(e){if(e.code!=='ENOENT'){this.error=e.message;this.data.all=true;throw blocked();}}return this.view();
  }
  setResults(results,errors=[]){this.results=results;this.data.results=results;this.data.errors=errors;this.persist();}
  cleanExit(){if(!this.error)try{fs.unlinkSync(path.join(this.dir,'armed'));}catch{}}
  view(){return {paused:Boolean(this.error||this.data.all||Object.values(this.data.tasks).some(t=>t.held||t.autoHeld)),all:this.data.all,tasks:Object.values(this.data.tasks).filter(t=>t.held||t.autoHeld),epoch:this.data.epoch,persistence:this.error?'unconfirmed':'saved',error:this.error,stopping:this.active,restart:this.data.restart||null,errors:(this.data.errors||[]).map(e=>typeof e==='string'?e:e.message),results:this.results};}
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function terminate({identity,owns=()=>true,cancel=()=>{},saved=()=>false,label='',identities=[],observed=[],scan,kill,grace=1200,settle=500}){
  const result={label,identity,state:'ownership-unknown',save:'unconfirmed',errors:[],signals:[]};let group;
  const P=require('./owned-processes'),exitSeen=new Map();let latest=[],firstObservation=true;result.observationComplete=false;
  for(const p of [identity,...identities,...observed])if(p)exitSeen.set(p.pid,{...p});
  // Keep a conservative exit-only view even when collect rejects a changed
  // parent before registering its children. These identities never authorize
  // signals, including when a later explicit stop reads the saved result.
  const watch=()=>{
    const first=firstObservation;firstObservation=false;
    const rows=(scan||P.snapshot)();if(first)result.observationComplete=true;let changed=true;
    while(changed){changed=false;for(const p of rows)if(p.pid!==process.pid&&!exitSeen.has(p.pid)&&exitSeen.has(p.ppid)){exitSeen.set(p.pid,{...p});changed=true;}}
    latest=rows;return rows;
  };
  const remaining=()=>latest.filter(p=>exitSeen.has(p.pid)).map(p=>p.pid);
  // An exec/exit race can invalidate a captured identity while cancellation is
  // already in flight. Never signal that identity or adopt its replacement.
  // Only a fresh, successful empty observation in the same owner generation
  // proves exit; a live/changed identity or unreadable snapshot remains unknown.
  const observeExit=async()=>{
    const end=Date.now()+grace;
    do{
      try{if(!owns())return;}catch{return;}
      try{if(!group.collect().length&&!remaining().length){result.state='exited';result.remaining=[];return;}}catch{/* Observation only; no signal or ownership change. */}
      if(Date.now()>=end)return;await delay(40);
    }while(true);
  };
  const finish=async()=>{const end=Date.now()+settle;while(!saved()&&Date.now()<end)await delay(25);result.save=saved()?'saved':'unconfirmed';result.observed=[...exitSeen.values()];if(result.state==='ownership-unknown')result.remaining=remaining();if(group)result.tracked=[...group.known.values()];return result;};
  try{if(!owns())throw Error('停止対象の所有世代が変わりました');group=new P.OwnedProcesses(identity,{scan:watch,kill});for(const p of identities)group.known.set(p.pid,p);group.collect();}catch(e){result.errors.push(e.message);if(group)await observeExit();return finish();}
  const signal=s=>{try{if(!owns())throw Error('停止対象の所有世代が変わりました');result.signals.push(...group.signal(s));}catch(e){result.errors.push(e.message);}};
  try{cancel('SIGTERM');}catch(e){result.errors.push('停止通知の保存：'+e.message);}signal('SIGTERM');
  const until=Date.now()+grace;let alive;
  try{while((alive=group.collect()).length&&Date.now()<until)await delay(40);if(alive.length){signal('SIGKILL');await delay(settle);}alive=group.collect();result.state=alive.length?'alive':remaining().length?'ownership-unknown':'exited';result.remaining=remaining();if(result.state==='ownership-unknown')await observeExit();}catch(e){result.state='ownership-unknown';result.errors.push(e.message);await observeExit();}
  return finish();
}
module.exports={StopControl,terminate};
