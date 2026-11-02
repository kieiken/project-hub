'use strict';
const {terminate}=require('./stop-control');
// This entry point does not read a project ledger before closing the barrier.
class EmergencyStop {
  constructor({control,chats,sessions,webchat,muse,unmanaged=()=>[],ancillary=()=>{},onPause=()=>{}}){Object.assign(this,{control,chats,sessions,webchat,muse,unmanaged,ancillary,onPause});this.flight=null;}
  targets(scope){const match=o=>!scope||o.project===scope.project&&o.task===scope.task;
    return [...[...this.chats.running.values()].filter(r=>match(r.options||{})).map(r=>({kind:'chat',project:r.options?.project,task:r.options?.task,ai:r.ai,pending:!!r.pending})),
      ...[...this.sessions.map].map(([k,s])=>({kind:'terminal',...Object.fromEntries(['project','task','ai'].map((n,i)=>[n,k.split('\0')[i]])),exited:s.exited})).filter(s=>!s.exited&&match(s)),
      ...this.webchat.busy().filter(match).map(j=>({kind:'webchat',project:j.project,task:j.task,ai:'chatgpt'})),
      ...(this.muse?.busy()||[]).filter(match).map(j=>({kind:'muse',project:j.project,task:j.task,ai:'muse'})),
      ...this.unmanaged().filter(o=>!scope||o.project===scope.project&&(!o.task||o.task===scope.task)).map(o=>({kind:'unmanaged',project:o.project,task:o.task,ai:o.ai,pid:o.pid}))];
  }
  stop(scope){
    // Even a concurrent stop fences its scope immediately. Joining the current
    // operation must not silently leave additional scopes running.
    this.control.pause(scope);
    this.onPause(scope);
    if(this.flight)return this.flight.then(()=>this.stop(scope));
    this.control.active=true;
    this.flight=this.perform(scope).then(r=>({...r,stopping:false})).finally(()=>{this.control.active=false;this.flight=null;});return this.flight;
  }
  async perform(scope){const match=o=>!scope||o.project===scope.project&&o.task===scope.task,errors=[],jobs=[],seen=new Set();
    // Mark every selected run before the first await or fallible ancillary hook.
    for(const r of this.chats.running.values())if(match(r.options||{})){r.stopped=true;const o=r.options,k=this.chats.key(o.project,o.task);this.chats.stops.set(k,(this.chats.stops.get(k)||0)+1);}
    for(const [k,s] of this.sessions.map)if(!s.exited&&match({project:k.split('\0')[0],task:k.split('\0')[1]}))s.stopped=true;
    for(const r of [...this.chats.running.values()])if(match(r.options||{})){
      const o=r.options;seen.add(r.identity?.pid);
      if(r.pending){try{r.cancel();}catch(e){errors.push(e.message);}jobs.push(Promise.resolve({project:o.project,task:o.task,label:r.ai,state:'not-started',save:'saved',errors:[]}));}
      else {r.stopResultP ||= this.chats.terminateRun(r);jobs.push(r.stopResultP.then(x=>({...x,project:o.project,task:o.task})));}
    }
    for(const [k,s] of this.sessions.map){const [project,task,ai]=k.split('\0');if(s.exited||!match({project,task}))continue;seen.add(s.identity?.pid);
      // PTY scrollback is memory only; an exit callback does not prove that
      // its output was saved durably. Never report it as saved merely on exit.
      jobs.push(terminate({identity:s.identity,owns:()=>this.sessions.map.get(k)===s,cancel:signal=>s.proc.kill(signal),label:ai}).then(x=>({...x,project,task,errors:[...x.errors,...(s.saveError?[s.saveError]:[]),'ターミナル出力の永続保存は確認できません']})));
    }
    // On a reboot, terminal objects no longer exist. Keep positive identities
    // from the prior stop so a still-owned survivor can be stopped again.
    for(const r of this.control.results)if(!r.unmanaged&&match(r)&&!seen.has(r.identity?.pid)&&['alive','ownership-unknown','failed'].includes(r.state))jobs.push(terminate({identity:r.identity,identities:r.tracked,observed:r.observed,label:r.label,saved:()=>r.save==='saved'}).then(x=>({...x,project:r.project,task:r.task})));
    for(const j of [...this.webchat.busy()])if(match(j)){try{this.webchat.stop(j.project,j.task);jobs.push(Promise.resolve({project:j.project,task:j.task,label:'ChatGPT',state:'external-unconfirmed',save:j.sent?'unconfirmed':'saved',errors:['外部サービス側の生成終了は確認できません。自動再送しません']}));}catch(e){errors.push(e.message);jobs.push(Promise.resolve({project:j.project,task:j.task,label:'ChatGPT',state:'external-unconfirmed',save:'unconfirmed',errors:[e.message]}));}}
    for(const j of this.muse?.busy()||[])if(match(j)){this.muse.stop(j.project,j.task);jobs.push(Promise.resolve({project:j.project,task:j.task,label:'Muse',state:'external-unconfirmed',save:'unconfirmed',errors:['Museの停止・結果は未確認です。自動再送しません']}));}
    try{for(const o of this.targets(scope).filter(o=>o.kind==='unmanaged'))jobs.push(Promise.resolve({project:o.project,task:o.task,label:o.ai,pid:o.pid,unmanaged:true,state:'ownership-unknown',save:'unconfirmed',errors:['関連するAIを検出しましたが、Hub所有の識別を確認できないため信号を送っていません。別のターミナルなどの状態を確認してください']}));}catch(e){errors.push(e.message);jobs.push(Promise.resolve({state:'ownership-unknown',save:'unconfirmed',errors:[e.message]}));}
    try{this.ancillary(scope,errors);}catch(e){errors.push(e.message);}
    const settled=await Promise.allSettled(jobs),results=settled.map(r=>r.status==='fulfilled'?r.value:{state:'failed',save:'unconfirmed',errors:[r.reason?.message||String(r.reason)]});
    this.control.setResults([...this.control.results.filter(r=>!match(r)),...results],errors);return {ok:!results.some(r=>['alive','ownership-unknown','failed'].includes(r.state)),...this.control.view(),errors};
  }
}
module.exports={EmergencyStop};
