'use strict';
// Reply reads only. Slot reservations survive restart; no slot is replayed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {read}=require('./muse-approvals'),{checkDirectory}=require('./muse-settings');
const original=[120,240,420,540],extended=[900,1800,3600];
class MuseReplyScheduler {
  constructor(direct){this.direct=direct;this.inspected=new Map();this.running=false;}
  settings(){
    const file=path.join(this.direct.muse.root,'_hub','muse-direct-settings.json');
    if(!fs.existsSync(file))return {extendedAutoRead:false};
    const v=read(file).value;
    if(Object.keys(v).length!==1||typeof v.extendedAutoRead!=='boolean')throw Error('reply settings');
    return v;
  }
  configure(value){
    if(!value||Object.keys(value).length!==2||value.confirm!==true||typeof value.extendedAutoRead!=='boolean')throw Error('回答の自動確認設定を確認してください。');
    const folder=path.join(this.direct.muse.root,'_hub');checkDirectory(folder);
    const file=path.join(folder,'muse-direct-settings.json'),tmp=file+'.'+crypto.randomUUID()+'.tmp';
    if(fs.existsSync(file))read(file);
    const fd=fs.openSync(tmp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({extendedAutoRead:value.extendedAutoRead})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
    return this.settings();
  }
  slotId(d,slot){
    const s=crypto.createHash('sha256').update(d.project+'\0'+d.task+'\0'+d.id+'\0'+slot.kind+'\0'+slot.seconds).digest('hex').slice(0,32);
    return 'read_'+[s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');
  }
  slots(d){
    if(!['sent','received'].includes(d.state)||!d.result)return [];
    const loc=this.direct.approvals.location(d.project,d.task,d.id),source=read(loc.file).value;
    if(source.kind!=='direct'||source.id!==d.id||source.project!==d.project||source.task!==d.task)return [];
    const at=Date.parse(d.at),expiry=Date.parse(source.request.expires_at);
    if(!Number.isFinite(at)||!Number.isFinite(expiry))return [];
    const slots=original.map((seconds,i)=>({kind:'original',seconds,at:at+seconds*1000,
      until:Math.min(expiry,at+(original[i+1]??600)*1000)}));
    if(d.state==='sent'&&this.settings().extendedAutoRead)slots.push(...extended.map((seconds,i)=>({kind:'extended',seconds,
      at:at+seconds*1000,until:at+(extended[i+1]??4200)*1000})));
    return slots.filter(slot=>this.direct.now()<slot.until&&
      !fs.existsSync(this.direct.approvals.location(d.project,d.task,this.slotId(d,slot)).file));
  }
  next(d){try{const slot=this.slots(d)[0];return slot?new Date(Math.max(slot.at,this.direct.now())).toISOString():null;}catch{return null;}}
  authorized(d,slot){
    return this.slots(d).some(s=>s.kind===slot.kind&&s.seconds===slot.seconds&&this.direct.now()>=s.at);
  }
  // Scan decision metadata, not conversation bodies. A damaged directory is
  // skipped; it never supplies authority to another task.
  targets(){
    const product=path.join(this.direct.muse.root,'Product'),out=[];
    if(!fs.existsSync(product))return out;
    checkDirectory(product);
    for(const project of fs.readdirSync(product)){
      try{
        const base=path.join(product,project,'.ai','muse-approvals','.decisions');
        if(!fs.existsSync(base))continue;checkDirectory(base);
        for(const task of fs.readdirSync(base)){
          try{checkDirectory(path.join(base,task));out.push({project,task});}catch{}
          if(out.length>=10000)return out;
        }
      }catch{}
    }
    return out;
  }
  async tick(generation){
    if(this.running)return;this.running=true;
    try{
      for(const b of this.targets()){
        const key=b.project+'\0'+b.task;
        if(this.direct.active.has(key))continue;
        try{
          for(const d of this.direct.decisions(b.project,b.task).filter(d=>d.state==='unknown')){
            const loc=this.direct.approvals.location(b.project,b.task,d.id),raw=read(loc.decision);
            if(this.inspected.get(loc.decision)===raw.sha)continue;
            this.inspected.set(loc.decision,raw.sha);
            this.direct.active.set(key,{...b,ai:'muse',muse:true,model:'',started:this.direct.now(),text:''});
            try{await this.direct.recoverSent({...b,id:d.id});}finally{this.direct.active.delete(key);try{this.direct.emit(b.project,b.task,{type:'idle'});}catch{}}
          }
          const pending=this.direct.pending(b.project,b.task);
          if(pending&&pending.state!=='sent')continue;
          // A stable introduction may precede the body. Keep using the original
          // permit for the latest received turn, without blocking a new send.
          // A later question moves the session; never read an older turn then.
          const id=pending?.id||this.direct.decisions(b.project,b.task)[0]?.id;
          if(!id)continue;
          const d=read(this.direct.approvals.location(b.project,b.task,id).decision).value;
          const slot=this.slots(d).find(s=>s.at<=this.direct.now());
          if(!slot)continue;
          const g=generation(b);
          if(!Number.isSafeInteger(g))continue;
          await this.direct.readReply({...b,sourceId:d.id,id:this.slotId(d,slot),generation:g},
            {kind:slot.kind,seconds:slot.seconds});
        }catch{/* A blocked/expired slot never acquires authority or retries. */}
      }
    }finally{this.running=false;}
  }
  start(generation){
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.tick(generation).catch(()=>{});},5000);this.timer.unref();
    void this.tick(generation).catch(()=>{});
  }
  stop(){clearInterval(this.timer);this.timer=null;}
}
module.exports={MuseReplyScheduler};
