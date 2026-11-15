'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const {noLinks,open}=require('./token-usage-scan');
function read(file){try{const {fd}=open(file);try{return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
class TokenUsage {
 constructor({dir,accounts,provenanceRoot}){this.dir=dir;this.accounts=accounts;this.provenanceRoot=provenanceRoot;this.snapshot=null;this.progress=null;this.running=false;this.failed=false;this.preferences={revision:0,limits:{},acknowledged:{}};try{this.snapshot=read(path.join(dir,'summary.json'));this.preferences=read(path.join(dir,'preferences.json'))||this.preferences;}catch{this.failed=true;}}
 roots(){const rows=this.accounts.list({includeActivity:false}).filter(r=>['codex','claude'].includes(r.ai)),seen=new Set(),out=[];for(const r of rows){const home=this.accounts.location(r.ai,r.id);for(const name of r.ai==='codex'?['sessions','archived_sessions']:['projects']){const dir=path.resolve(home,name);if(!seen.has(dir)){seen.add(dir);out.push({dir,ai:r.ai,account:r.id});}}}return out;}
 status(){const targets=this.snapshot?.unacknowledgedAlerts;return {acknowledgementToken:Array.isArray(targets)?crypto.createHash('sha256').update(JSON.stringify([this.preferences.revision,targets])).digest('hex'):null,snapshot:this.snapshot,running:this.running,progress:this.progress,failed:this.failed,limits:this.preferences.limits,revision:this.preferences.revision,pending:this.snapshot?.preferencesRevision!==this.preferences.revision};}
 badge(){return {count:this.snapshot?.alertCount||0,running:this.running,failed:this.failed,pending:this.status().pending};}
 ensure(){noLinks(path.dirname(this.dir));if(!fs.existsSync(this.dir))fs.mkdirSync(this.dir,{mode:0o700});noLinks(this.dir);}
 save(preferences){this.ensure();const file=path.join(this.dir,'preferences.json');if(fs.existsSync(file))noLinks(file);const tmp=file+'.'+crypto.randomUUID();const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(preferences));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);this.preferences=preferences;this.start();return this.status();}
 setLimits(limits,revision){if(revision!==this.preferences.revision)throw Error('stale');if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(k=>!['codex','claude'].includes(k)))throw Error('invalid');const clean={};for(const ai of ['codex','claude']){const row=limits[ai]||{};if(typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['daily','run'].includes(k)))throw Error('invalid');clean[ai]={};for(const k of ['daily','run']){const v=row[k];if(v!==null&&v!==undefined&&(!Number.isSafeInteger(v)||v<=0))throw Error('invalid');clean[ai][k]=v??null;}}return this.save({...this.preferences,limits:clean,revision:this.preferences.revision+1});}
 acknowledge(id,total){if(typeof id!=='string'||!(/^[a-f0-9]{64}$/).test(id))throw Error('invalid');const alert=this.snapshot?.alerts?.find(a=>a.id===id);if(!alert||alert.total!==total)throw Error('stale');return this.save({...this.preferences,revision:this.preferences.revision+1,acknowledged:{...this.preferences.acknowledged,[id]:{through:total}}});}
 // The token identifies every unseen alert and its observed total, including
 // those beyond the display cap. Reject a changed snapshot before any write.
 acknowledgeAll(token){
  if(typeof token!=='string'||!(/^[a-f0-9]{64}$/).test(token))throw Error('invalid');
  const status=this.status(),alerts=this.snapshot?.unacknowledgedAlerts;
  if(status.pending||status.acknowledgementToken!==token||!alerts?.length)throw Error('stale');
  const acknowledged={...this.preferences.acknowledged};for(const {id,total}of alerts)acknowledged[id]={through:total};
  return this.save({...this.preferences,revision:this.preferences.revision+1,acknowledged});
 }
 start(){if(this.running)return;this.running=true;this.failed=false;const revision=this.preferences.revision;try{this.ensure();const worker=new Worker(path.join(__dirname,'token-usage-worker.js'),{workerData:{dir:this.dir,roots:this.roots(),provenanceRoot:this.provenanceRoot}});this.worker=worker;worker.unref();worker.on('message',m=>{if(m.progress)this.progress=m.progress;if(m.snapshot)this.snapshot=m.snapshot;if(m.failed)this.failed=true;});worker.on('error',()=>{this.failed=true;});worker.on('exit',code=>{if(code)this.failed=true;this.running=false;this.worker=null;if(!this.failed&&this.preferences.revision!==revision)this.start();});}catch{this.failed=true;this.running=false;}}
 schedule(){this.start();this.timer=setInterval(()=>{if(!this.failed)this.start();},300000);this.timer.unref();}
 close(){clearInterval(this.timer);return this.worker?.terminate();}
}
module.exports={TokenUsage};
