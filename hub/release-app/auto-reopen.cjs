'use strict';
// Release Mac only. The helper asks the existing shell to quit normally; it
// never kills a process or edits the update/confirmation journal.
const path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {noLinks}=require('../lib/license/storage');
const WAIT='作業が終わったら自動で開き直します。', MANUAL='自動で開き直せませんでした。処理が終わったらアプリを閉じて同じアプリを開き直してください。';
function native(updater,onFailure){
  const app=updater.env.HUB_UPDATE_APP, helper=path.join(updater.hubPath,'release-app/auto-reopen-native');
  if(typeof app!=='string'||!path.isAbsolute(app)||!app.endsWith('.app'))throw Error('reopen_app');
  noLinks(app);noLinks(helper);updater.verifyPackage(path.dirname(updater.hubPath),'darwin');
  const child=cp.spawn(helper,[String(process.ppid),String(process.pid),app],{detached:true,stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin',HOME:require('node:os').homedir()}});
  let approved=false, stopped=false, buffer='';
  const stop=()=>{if(stopped)return;stopped=true;child.stdin.end('cancel\n');};
  child.stdin.on('error',()=>{if(!stopped&&!approved)onFailure();});
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{stop();reject(Error('reopen_helper_timeout'));},3000);timer.unref?.();
    child.on('error',()=>{clearTimeout(timer);reject(Error('reopen_helper'));onFailure();});
    child.stdout.on('data',bytes=>{buffer+=bytes; if(buffer.length>256){stop();reject(Error('reopen_protocol'));return;}
      if(buffer.includes('ready\n')){clearTimeout(timer);resolve();}
      if(buffer.includes('failed\n'))onFailure();
    });
    child.on('exit',code=>{clearTimeout(timer);if(!stopped&&!approved){reject(Error('reopen_helper_exit'));onFailure();}});
  });
  child.unref();
  return {ready,go(){child.stdin.write('go\n');},approve(){approved=true;child.stdin.end('approved\n');},stop};
}
class AutoReopen {
  constructor(updater,{now=Date.now,launch=native}={}){this.updater=updater;this.now=now;this.launch=launch;this.clients=new Map();this.phase='idle';this.ticket='';this.helper=null;}
  status(){return {phase:this.phase,ticket:this.ticket,reason:this.phase==='waiting'?WAIT:this.phase==='starting'?'アプリを閉じて開き直しています。':this.phase==='manual'?MANUAL:''};}
  request(){if(['waiting','starting','committed'].includes(this.phase))return;this.phase='waiting';this.ticket=crypto.randomUUID();this.requested=this.now();for(const c of this.clients.values())c.ready=false;}
  cancel(){if(this.phase==='committed')return;this.helper?.stop();this.helper=null;this.phase='cancelled';this.ticket='';}
  failure(){if(this.phase==='committed')return;this.helper?.stop();this.helper=null;this.phase='manual';this.ticket='';}
  pulse(b){
    if(typeof b.client!=='string'||!/^[\w-]{16,80}$/.test(b.client))throw Error('reopen_client');
    if(b.action==='reopen-leave'){this.clients.delete(b.client);return;}
    if(!this.clients.has(b.client)&&this.clients.size>=32)throw Error('reopen_clients');
    this.clients.set(b.client,{at:this.now(),ready:b.ready===true&&b.ticket===this.ticket&&Boolean(this.ticket)});
  }
  ready(){return this.clients.size>0&&[...this.clients.values()].every(c=>c.ready&&this.now()-c.at<8000);}
  async advance(canQuit){
    if(this.advancing)return;this.advancing=true;
    try {await this.step(canQuit);} finally {this.advancing=false;}
  }
  async step(canQuit){
    if(this.phase!=='waiting')return;
    const ticket=this.ticket;
    // Never discard an unresponsive window: its unsent input may still exist.
    if([...this.clients.values()].some(c=>this.now()-c.at>=10000)){this.failure();return;}
    const u=this.updater;
    if(u.running)return;
    if(u.data.phase==='failed'){this.failure();return;}
    if(!u.restartNeeded){
      if(u.data.prepared)await u.apply();
      if(u.data.phase==='failed')this.failure();
      return;
    }
    if(!this.ready()||this.now()-this.requested<1500)return;
    if(u.data.phase!=='installed'||!u.data.pendingConfirm||!await canQuit()||this.phase!=='waiting'||this.ticket!==ticket)return;
    this.phase='starting';
    try {
      const h=this.launch(u,()=>this.failure());this.helper=h;await h.ready;
      if(this.phase!=='starting'||this.ticket!==ticket||!this.ready()||!await canQuit()){h.stop();if(this.helper===h)this.helper=null;if(this.phase==='starting'&&this.ticket===ticket)this.phase='waiting';return;}
      // Return the HTTP response before the native shell requests /api/quit.
      // No force-exit fallback is permitted.
      setTimeout(()=>this.beginNativeQuit(h),200).unref?.();
    }catch{this.failure();}
  }
  beginNativeQuit(helper){if(this.phase!=='starting'||this.helper!==helper)return;this.nativeQuitTicket=this.ticket;helper.go();}
  quitTicket(){return this.nativeQuitTicket || (this.phase==='starting'?this.ticket:'');}
  beforeQuit(expected){
    if(expected&&(this.phase!=='starting'||this.ticket!==expected)||this.phase==='starting'&&!this.ready()){
      // A native quit event may already be queued when the person cancels.
      // Reject that one stale event too, rather than treating it as manual quit.
      this.nativeQuitTicket='';throw Error('reopen_input_changed');
    }
  }
  approved(){if(this.phase==='starting'){this.phase='committed';this.helper.approve();}}
}
function attach(updater,options){
  const controller=new AutoReopen(updater,options),status=updater.status.bind(updater);
  updater.reopener=controller;
  updater.status=()=>({...status(),autoReopen:controller.status(),manualReopen:!['waiting','starting','committed'].includes(controller.phase)});
  return updater;
}
module.exports={AutoReopen,attach,native};
