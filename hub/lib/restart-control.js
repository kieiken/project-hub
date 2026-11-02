'use strict';
const { lt } = require('./locale');
// Reservation does not lock ongoing work. Commit is synchronous: inspect, verify,
// then close the start gate before any asynchronous restart operation is scheduled.
class RestartControl {
  constructor({ blockers, verify, execute, admit, now = () => new Date().toISOString() }) {
    Object.assign(this, { blockers, verify, execute, admit, now });
    this.reserved = null; this.committed = false; this.executions = 0; this.error = '';
  }
  status(waiting) { return { reserved: this.reserved, committed: this.committed, executions: this.executions, error: this.error, waiting: this.reserved ? waiting ?? this.blockers() : [] }; }
  commit() {
    if(!this.admit)return this.commitNow();
    if(this.committed)return Promise.resolve(this.status());
    if(this.flight)return this.flight;
    const epoch=this.epoch||0;
    this.flight=this.admit(()=>{if(epoch!==(this.epoch||0))throw Error('再起動の予約は取り消されました');return this.commitNow();}).finally(()=>{this.flight=null;});
    return this.flight;
  }
  commitNow() {
    if (this.committed) return this.status();
    const waiting = this.blockers();
    if (waiting.length) throw Object.assign(Error(lt('AIの作業が終わるまで更新できません。')), { status: 409, code: 'RESTART_WAITING', waiting });
    this.verify();
    this.committed = true; this.reserved = null; this.error = ''; this.executions++;
    this.execute();
    return this.status();
  }
  request(reserve = false) {
    if (this.committed) return this.status();
    if (reserve) {
      if (!this.reserved) this.reserved = { at: this.now() };
      void this.tick(); return this.status();
    }
    return this.commit();
  }
  cancel() { if (this.committed) throw Object.assign(Error(lt('再起動を開始しています')), { status: 409 }); this.epoch=(this.epoch||0)+1; this.reserved = null; this.error = ''; return this.status(); }
  tick() {
    if (!this.reserved || this.committed || !this.admit && this.blockers().length) return;
    const reservation=this.reserved,epoch=this.epoch||0;
    const failed=e=>{
      if((this.epoch||0)!==epoch||this.reserved!==reservation&&!this.committed)return;
      // Only commitNow's ordinary busy result is a wait. Admission/verification
      // failures (including unrelated 409s) remain errors and stop the flow.
      if(e.code==='RESTART_WAITING'&&e.status===409&&e.waiting?.length)return;
      this.error=e.message;
    };
    try { const result=this.commit();if(result?.then)return result.catch(failed); } catch (e) { failed(e); }
  }
}
module.exports = { RestartControl };
