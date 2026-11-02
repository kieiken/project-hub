'use strict';
const {randomUUID}=require('node:crypto');
// A durable, non-replaying continuation of one confirmed global stop. It uses
// the ordinary restart controller; it never kills the Hub or relaxes blockers.
class EmergencyRestart {
  constructor({control,stop,restart,target,conflicts=()=>[],boot}) {
    Object.assign(this,{control,stop,restart,target,conflicts,boot});this.flight=null;
    const prior=control.data.restart;
    if(prior&&prior.boot!==boot&&['stopping','waiting','committed'].includes(prior.phase)){
      let returned=false;try{returned=prior.phase==='committed'&&JSON.stringify(prior.target)===JSON.stringify(target());}catch{/* A changed or unknown boot is not a successful return. */}
      this.save({...prior,phase:returned?'returned':'interrupted',reason:returned?'Hubを再起動しました。AIと待ち指示は保留中です':'前回の停止・再起動の完了を確認できません。自動では繰り返しません'});
    }
  }
  save(value){this.control.data.restart=value;const ids=this.control.data.restartIds||=[];if(value.id&&!ids.includes(value.id))ids.push(value.id);this.control.restarting=['stopping','waiting','committed'].includes(value.phase);if(!this.control.persist()){this.control.data.restart={...value,phase:'blocked',reason:'停止・再起動状態の保存を確認できません。再起動せず保留しています'};this.control.restarting=false;return false;}return true;}
  status(){return this.control.view();}
  request(id=randomUUID()) {
    const prior=this.control.data.restart;
    if(this.flight)return this.flight;
    // Duplicate clicks and ambiguous HTTP replies only read the same receipt.
    if(this.control.data.restartIds?.includes(id)||prior&&(prior.id===id||this.control.data.all))return Promise.resolve(this.status());
    this.control.pause();
    let target,reason='';
    try{target=this.target();const s=this.restart.status();if(s.reserved||s.committed)reason='既存の再起動が予約・開始済みです。重ねて再起動しません';const c=this.conflicts();if(c.length)reason=c.map(x=>x.message).join('\n');}catch(e){reason=e.message;}
    if(!this.save({id,boot:this.boot,target,phase:'stopping',at:new Date().toISOString(),reason}))reason='停止状態の保存を確認できません';
    this.flight=(async()=>{
      try{await this.stop();
        const s=this.status();
        if(s.persistence!=='saved'||s.errors.length||s.results.some(r=>!['exited','not-started'].includes(r.state)||r.save!=='saved'))reason ||= 'AIの終了・所有・結果の保存を確認できません。再起動せず保留しています';
        this.save({...this.control.data.restart,phase:reason?'blocked':'waiting',reason});
      }catch(e){this.save({...this.control.data.restart,phase:'blocked',reason:e.message});}
      return this.status();
    })().finally(()=>{this.flight=null;});return this.flight;
  }
  tick(){
    if(!this.restart.admit)return this.tickChecked();
    if(this.checking)return this.checking;
    const r=this.control.data.restart;if(r?.phase!=='waiting'&&r?.phase!=='committed')return;
    this.checking=this.restart.admit(()=>this.tickChecked()).catch(e=>this.fail(e.message)).finally(()=>{this.checking=null;});return this.checking;
  }
  tickChecked(){
    const r=this.control.data.restart;if(r?.phase==='committed'&&!this.restart.committed&&this.restart.error){this.fail(this.restart.error);return;}if(!r||r.phase!=='waiting'||this.flight)return;
    try{
      const view=this.status();
      if(this.control.active)return;
      if(this.control.error||!this.control.data.all||view.errors.length||view.results.some(r=>!['exited','not-started'].includes(r.state)||r.save!=='saved'))throw Error('停止の保留・保存を確認できません');
      const s=this.restart.status();if(s.reserved||s.committed)throw Error('別の再起動が予約・開始されています。重ねて再起動しません');
      if(JSON.stringify(this.target())!==JSON.stringify(r.target))throw Error('再起動するHubの保存内容が変わりました。自動では切り替えません');
      const conflicts=this.conflicts();if(conflicts.length)throw Error(conflicts.map(x=>x.message).join('\n'));
      const waiting=this.restart.blockers();
      if(waiting.length){const reason=waiting.map(x=>x.message).join('\n');if(reason!==r.reason)this.save({...r,reason});return;}
      // Validate before writing the intent and again inside the formal commit.
      this.restart.verify();
      if(!this.save({...r,phase:'committed',reason:'停止・保存を確認しました。Hubを再起動しています'}))return;
      const result=this.restart.request();if(result?.catch)void result.catch(e=>this.fail(e.message));
    }catch(e){this.save({...r,phase:'blocked',reason:e.message});}
  }
  pending(){return Boolean(this.control.restarting);}
  verifyCommitted(){const r=this.control.data.restart;if(r?.phase!=='committed')return;const s=this.status();if(this.control.active||this.control.error||!this.control.data.all||s.errors.length||s.results.some(r=>!['exited','not-started'].includes(r.state)||r.save!=='saved')||JSON.stringify(this.target())!==JSON.stringify(r.target)||this.conflicts().length||this.restart.blockers().length)throw Error('停止・保存または再起動先を再確認できません');}
  fail(reason){if(this.control.data.restart)this.save({...this.control.data.restart,phase:'blocked',reason:String(reason)});}
}
module.exports={EmergencyRestart};
