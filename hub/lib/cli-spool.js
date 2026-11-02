'use strict';
const persistence = require('./platform').persistence;
// One detached supervisor per turn. It owns only that CLI, never Hub tasks or
// model selection. Persisted requests contain no environment or credentials.
const fs=require('./platform/file-io'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{EventEmitter}=require('node:events'),{StringDecoder}=require('node:string_decoder');
const WORKER_SOURCE=fs.readFileSync(__filename),OWNED_SOURCE=fs.readFileSync(path.join(__dirname,process.argv[2]==='--worker'?'owned-processes.cjs':'owned-processes.js'));
const PLATFORM_SOURCE=new Map(require('./platform').supervisorFiles.map(name=>{
 if(!/^[a-z][a-z0-9-]*\.js$/.test(name))throw Error('監督のOS部品の同梱先を確認できません');
 return [name,fs.readFileSync(path.join(__dirname,'platform',name))];
}));
function strictRead(dir,name){try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function read(dir,name,fallback=null){try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return fallback;}}
function atomic(dir,name,value){const file=path.join(dir,name),tmp=file+'.'+crypto.randomUUID(),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);persistence.syncDirectory(dir);}
// Publish an acknowledgement only AFTER the receipt and its directory synced.
// The proof file itself is synced before rename. Rename is the last operation:
// no subsequent failing directory sync can leave an apparent failed commit.
// A power loss may drop this last directory entry, which only restores the
// quarantine; it cannot acknowledge a receipt whose durable write failed.
function acknowledge(dir,name,value){const file=path.join(dir,name),tmp=file+'.'+crypto.randomUUID(),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function digest(value){return crypto.createHash('sha256').update(value).digest('hex');}
function filesDigest(dir,names){return digest(JSON.stringify(names.map(n=>{try{return [n,digest(fs.readFileSync(path.join(dir,n)))];}catch(e){return [n,e.code||'unreadable'];}})));}
function completion(dir){return filesDigest(dir,['request.json','exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json']);}
function receiptEvidence(dir){return digest(JSON.stringify(['request.json','exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json','finalizing.json','finished.json'].map(name=>{try{return [name,digest(fs.readFileSync(path.join(dir,name)))];}catch(e){if(e.code!=='ENOENT'||['finalizing.json','finished.json'].includes(name))throw e;return [name,'ENOENT'];}})));}
function evidence(dir){return filesDigest(dir,['request.json','exit.json','cursor.json','out.jsonl','finalizing.json','failure.json','finished.json','finished-confirmed.json']);}
const verified=new Map(),verificationFiles=['request.json','exit.json','cursor.json','out.jsonl','stderr.json','started.json','launch.json','control.json','cancel.json','finalizing.json','failure.json','finished.json','finished-confirmed.json','recovered.json'];
// Cache only successful validation. Include ctime/permissions as well as mtime:
// replacing content and restoring its size/mtime must still invalidate it.
// Missing files participate too, so new failure/recovery receipts are noticed.
function verificationStamp(dir){
 try{return digest(JSON.stringify(verificationFiles.map(name=>{const file=path.join(dir,name);try{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile())throw Error('non-regular receipt');fs.accessSync(file,fs.constants.R_OK);return [name,...['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid','nlink'].map(k=>String(s[k]))];}catch(e){if(e.code==='ENOENT')return [name,'ENOENT'];throw e;}})));}catch{return null;}
}
function failure(dir){
 const stamp=verificationStamp(dir);if(stamp&&verified.get(dir)===stamp)return null;
 verified.delete(dir);const issue=inspectFailure(dir);
 if(!issue&&read(dir,'finished.json')&&stamp&&verificationStamp(dir)===stamp)verified.set(dir,stamp);
 return issue;
}
function inspectFailure(dir){
 const failed=fs.existsSync(path.join(dir,'failure.json')),phase=read(dir,'finalizing.json'),finished=read(dir,'finished.json');
 const token=evidence(dir),resolved=read(dir,'recovered.json');
 if(resolved?.version===1&&resolved.evidence===token&&finished)return null;
 const phased=fs.existsSync(path.join(dir,'finalizing.json')),proof=read(dir,'finished-confirmed.json');let confirmed=false;
 try{confirmed=finished&&(phased||finished.proofRequired?proof?.version===1&&proof.evidence===receiptEvidence(dir):true);}catch{/* Unreadable evidence is never proof of completion. */}
 if(!failed&&(!phased&&!fs.existsSync(path.join(dir,'finished.json'))||confirmed))return null;
 return {stage:phase?.stage||'spool',error:read(dir,'failure.json')?.error||'会話の終了保存を確認できません',token,recovery:phase?.stage==='finished'?'confirm-finished':'not-sent'};
}
function claim(dir,serverId){const lock=path.join(dir,'owner.lock');try{fs.mkdirSync(lock,{mode:0o700});}catch{throw Error('会話の所有権を確認中です');}try{const old=read(dir,'owner.json');if(old&&!old.released&&alive(old.pid))throw Error('会話は別のHubが受け取り中です');const owner={pid:process.pid,serverId,generation:(old?.generation||0)+1,released:false};atomic(dir,'owner.json',owner);return owner;}finally{fs.rmdirSync(lock);}}
function worker(dir){
 const req=read(dir,'request.json');if(!req)process.exit(1);
 try{const fd=fs.openSync(path.join(dir,'started-once'),'wx',0o600);fs.closeSync(fd);}catch{process.exit(1);}
 const fd=fs.openSync(path.join(dir,'out.jsonl'),'a',0o600),decoder=new StringDecoder('utf8');let n=0,rest='',err='',ended=false,timer;
 const line=l=>{fs.writeSync(fd,JSON.stringify({n:++n,line:l,at:Date.now()})+'\n');fs.fsyncSync(fd);};
 const chunk=d=>{rest+=d;const parts=rest.split('\n');rest=parts.pop();for(const l of parts)line(l);};
 let owned;let cli;
 const stop=signal=>{if(owned)return owned.signal(signal);};const end=(code,signal,error)=>{if(ended)return;ended=true;clearInterval(timer);chunk(decoder.end());if(rest)line(rest);fs.closeSync(fd);atomic(dir,'stderr.json',{text:err});atomic(dir,'exit.json',{code,signal,error});};
 try{
   if(read(dir,'cancel.json'))throw Error('開始前に停止されました');
   require(path.join(__dirname,'owned-processes.cjs')).assertLaunchOwnership();
   if(req.options.stopSafety){const c=req.options.stopSafety,d=strictRead(c.dir,'state.json');
     if(d?.version!==1||!Number.isSafeInteger(d.epoch)||d.epoch<0||typeof d.all!=='boolean'||!d.tasks||typeof d.tasks!=='object'||Array.isArray(d.tasks)||Object.entries(d.tasks).some(([k,t])=>!t||k!==JSON.stringify([t.project,t.task])||typeof t.project!=='string'||typeof t.task!=='string'||!Number.isSafeInteger(t.epoch)||t.epoch<0||typeof t.held!=='boolean'||t.autoHeld!==undefined&&typeof t.autoHeld!=='boolean')||d.restartIds!==undefined&&(!Array.isArray(d.restartIds)||d.restartIds.some(id=>typeof id!=='string'||!id||id.length>80)))throw Error('停止記録を確認できないため開始しません');
     const t=d.tasks[JSON.stringify([req.options.project,req.options.task])];
     if(!d||fs.existsSync(path.join(c.dir,'intent.json'))||d.all||t?.held||t?.autoHeld&&c.ticket?.manual!==true||d.epoch!==c.ticket?.epoch||(t?.epoch||0)!==c.ticket?.task)throw Error('停止後の依頼は開始しません');}
   cli=spawn(req.turn.command,req.turn.args,{cwd:req.options.dir,env:process.env,detached:true,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(e){end(1,null,e.message);return;}
 timer=setInterval(()=>{const c=read(dir,'cancel.json');if(c&&c.n!==lastCancel){lastCancel=c.n;try{stop(c.signal);}catch{}}},25);let lastCancel=0;
 cli.on('spawn',()=>{let identity,ownershipError;try{const P=require(path.join(__dirname,'owned-processes.cjs'));identity=P.capture(cli.pid);owned=new P.OwnedProcesses(identity);owned.collect();}catch(e){ownershipError=e.message;}atomic(dir,'started.json',{supervisorPid:process.pid,cliPid:cli.pid,at:Date.now(),identity,ownershipError});});
 cli.stdin.on('error',()=>{});cli.stdin.end(req.turn.stdin);
 cli.stdout.on('data',d=>chunk(decoder.write(d)));cli.stderr.on('data',d=>{err=(err+d.toString('utf8')).slice(-4000);atomic(dir,'stderr.json',{text:err});});
 cli.on('error',e=>end(1,null,e.code==='ENOENT'?'CLIが見つかりません：'+req.turn.command:e.message));cli.on('close',(code,signal)=>end(code,signal));
 process.on('SIGTERM',()=>{try{stop('SIGTERM');}catch{}});
}
class SpoolChild extends EventEmitter{
 constructor(dir,owner){super();this.dir=dir;this.owner=owner;try{this.requestHash=digest(fs.readFileSync(path.join(dir,'request.json')));}catch{this.requestHash=null;}this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.stdout.setEncoding=this.stderr.setEncoding=()=>{};this.stdin=new EventEmitter();this.stdin.end=()=>{};this.cursor=read(dir,'cursor.json',{n:0}).n;this.cancelN=read(dir,'cancel.json',{n:0}).n;this.offset=0;this.partial='';this.decoder=new StringDecoder('utf8');this.closed=false;}
 owns(){const o=read(this.dir,'owner.json');return !o?.released&&o?.serverId===this.owner.serverId&&o?.generation===this.owner.generation;}
 start(){this.timer=setInterval(()=>this.poll(),25);this.poll();}
 poll(){if(this.failure)return this.pause();if(!this.owns())return this.pause();try{
  const started=read(this.dir,'started.json');if(started&&!this.spawned){this.spawned=true;this.pid=started.cliPid;this.supervisorPid=started.supervisorPid;this.emit('spawn');return;} // Let spawn acknowledgements settle before consuming a fast CLI's final output.
  const file=path.join(this.dir,'out.jsonl');let drained=true;
  if(fs.existsSync(file)){const size=fs.statSync(file).size;if(size<this.offset)throw Error('会話の出力記録が短くなりました');const amount=Math.min(size-this.offset,1024*1024);drained=amount===size-this.offset;if(amount){const fd=fs.openSync(file,'r'),buf=Buffer.alloc(amount);let got;try{got=fs.readSync(fd,buf,0,amount,this.offset);}finally{fs.closeSync(fd);}this.offset+=got;this.partial+=this.decoder.write(buf.subarray(0,got));const lines=this.partial.split('\n');this.partial=lines.pop();for(const l of lines){if(!l)continue;const r=JSON.parse(l);if(!Number.isSafeInteger(r.n)||typeof r.line!=='string')throw Error('会話の出力記録が不正です');if(!this.owns())return;if(r.n<=this.cursor)this.emit('line',r.line,r.n,true);else{if(r.n!==this.cursor+1)throw Error('会話の出力記録に欠落があります');this.emit('line',r.line,r.n,false);this.checkpoint();atomic(this.dir,'cursor.json',{n:r.n});this.cursor=r.n;}}}}
  const err=read(this.dir,'stderr.json');if(err&&err.text!==this.err){this.err=err.text;this.emit('stderr',err.text);}
  const exit=read(this.dir,'exit.json');const launched=read(this.dir,'launch.json');if(!exit&&launched&&!alive(launched.supervisorPid))throw Error('監督プロセスが終了し、終了結果を確認できません');const allRead=!fs.existsSync(file)||fs.statSync(file).size===this.offset;if(exit&&drained&&allRead&&!this.closed){if(this.partial)throw Error('会話の出力記録の末尾が未完了です');this.closed=true;clearInterval(this.timer);if(exit.error)this.emit('error',Error(exit.error));else this.emit('close',exit.code,exit.signal);}
 }catch(e){this.fail(e);}}
 fail(e){this.failure=e.message;this.pause();try{atomic(this.dir,'failure.json',{error:e.message,stage:this.stage||'spool',at:Date.now(),generation:this.owner.generation});}catch{}try{this.emit('spool-error',e);}catch{/* Failure reporting must not remove the quarantined run. */}}
 phase(stage,details={}){this.stage=stage;if(this.owns())atomic(this.dir,'finalizing.json',{stage,requestHash:this.requestHash,generation:this.owner.generation,at:Date.now(),...details});else throw Error('会話の所有権が変わりました');}
 checkpoint(){if(this.run&&this.owns()){const c={};for(const k of ['stopped','interrupting','blocked','limitTerminating','stopVersion'])if(this.run[k]!==undefined)c[k]=this.run[k];atomic(this.dir,'control.json',c);}}
 kill(signal='SIGTERM'){if(!this.owns())return false;atomic(this.dir,'cancel.json',{n:++this.cancelN,signal});this.checkpoint();return true;}
 pause(){clearInterval(this.timer);}
 release(){this.pause();this.checkpoint();if(this.owns())atomic(this.dir,'owner.json',{...this.owner,released:true});}
 resumeAfterRelease(){
  const owner=read(this.dir,'owner.json');
  if(!owner||owner.serverId!==this.owner.serverId||owner.generation!==this.owner.generation||owner.pid!==this.owner.pid)throw Error('会話の所有権が変わりました');
  if(owner.released)atomic(this.dir,'owner.json',{...this.owner,released:false});
  this.pause();this.start();
 }
 finish(){if(!this.owns())throw Error('会話の所有権が変わりました');if(!fs.existsSync(path.join(this.dir,'finalizing.json')))this.phase(this.stage||'finished');atomic(this.dir,'finished.json',{at:Date.now(),generation:this.owner.generation,id:crypto.randomUUID(),proofRequired:1});acknowledge(this.dir,'finished-confirmed.json',{version:1,evidence:receiptEvidence(this.dir)});}
 safe(){return this.spawned&&!this.failure&&!this.closed&&this.owns()&&alive(this.supervisorPid);}
}
function start(root,serverId,options,turn,meta,rows,env){
 require('./owned-processes').assertLaunchOwnership();
 fs.mkdirSync(root,{recursive:true,mode:0o700});const dir=path.join(root,crypto.randomUUID());fs.mkdirSync(dir,{mode:0o700});
 // Capture this generation's worker bytes before launch; replacement on disk
 // cannot change the code governing a running CLI.
 fs.writeFileSync(path.join(dir,'worker.cjs'),WORKER_SOURCE,{mode:0o600});
 fs.writeFileSync(path.join(dir,'owned-processes.cjs'),OWNED_SOURCE,{mode:0o600});
 fs.mkdirSync(path.join(dir,'platform'),{mode:0o700});
 for(const [name,source]of PLATFORM_SOURCE)fs.writeFileSync(path.join(dir,'platform',name),source,{mode:0o600});
 const clean={};for(const [k,v]of Object.entries(options))if(k!=='env'&&typeof v!=='function')clean[k]=v;
 atomic(dir,'request.json',{options:clean,turn,meta,rows});const owner=claim(dir,serverId);
 const p=spawn(process.execPath,[path.join(dir,'worker.cjs'),'--worker',dir],{env,detached:true,windowsHide:true,stdio:'ignore'});p.unref();if(p.pid){let identity;try{identity=require('./owned-processes').capture(p.pid);}catch{}atomic(dir,'launch.json',{supervisorPid:p.pid,identity});}
 const child=new SpoolChild(dir,owner);p.once('error',e=>atomic(dir,'exit.json',{code:1,error:e.message}));return child;
}
// Display-only shortcut for proven, finished runs. Directory changes catch
// atomic receipts immediately; in-place edits are rechecked within 60 seconds.
// Action/adoption callers use pending(root) and failure(dir), never this cache.
const displayVerified=new Map(),DISPLAY_MAX_AGE=60000;
function directoryStamp(dir){try{const s=fs.lstatSync(dir,{bigint:true});return s.isDirectory()?['dev','ino','mtimeNs','ctimeNs','mode','uid','gid','nlink'].map(k=>String(s[k])).join(':'):null;}catch{return null;}}
function displayFinished(dir,fresh){
 const now=Date.now(),stamp=directoryStamp(dir),hit=displayVerified.get(dir);
 if(!fresh&&stamp&&hit&&hit.dirStamp===stamp&&hit.proof===verified.get(dir)&&now>=hit.at&&now-hit.at<DISPLAY_MAX_AGE)return true;
 displayVerified.delete(dir);
 if(failure(dir)||!read(dir,'finished.json'))return false;
 const proof=verified.get(dir);
 if(proof&&stamp&&directoryStamp(dir)===stamp)displayVerified.set(dir,{dirStamp:stamp,proof,at:now});
 return true;
}
function pending(root,{display=false,freshDirs=new Set()}={}){
 const dirs=fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(root,e.name)):[],present=new Set(dirs);
 for(const cache of [verified,displayVerified])for(const d of cache.keys())if(path.dirname(d)===root&&!present.has(d))cache.delete(d);
 return dirs.filter(d=>display? !displayFinished(d,freshDirs.has(d))&&(failure(d)||!read(d,'finished.json')&&fs.existsSync(path.join(d,'request.json'))) : failure(d)||!read(d,'finished.json')&&fs.existsSync(path.join(d,'request.json')));
}
function adopt(dir,serverId){if(failure(dir))throw Error('会話の保存失敗が未解決です。自動では再処理しません');return new SpoolChild(dir,claim(dir,serverId));}
// Only the final durable receipt can be repaired. Hooks and queue dispatch are
// never replayed after a failure, even when a final assistant row exists.
function recover(dir,serverId,token,row){
 const lock=path.join(dir,'owner.lock');try{fs.mkdirSync(lock,{mode:0o700});}catch{throw Error('会話の所有権を確認中です');}
 try{
 const problem=failure(dir),phase=read(dir,'finalizing.json'),owner=read(dir,'owner.json');
 if(phase?.stage!=='finished'||!row||phase.finalRowHash!==digest(JSON.stringify(row))||phase.requestHash!==digest(fs.readFileSync(path.join(dir,'request.json')))||phase.completionHash!==completion(dir)||phase.generation!==owner?.generation)throw Error('終了処理の結果が不明です。自動では再処理しません');
 const prior=read(dir,'recovered.json');if(prior?.version===1&&prior.requestToken===token&&prior.evidence===evidence(dir)&&read(dir,'finished.json'))return;
 if(!problem||problem.token!==token)throw Error('確認中に会話の保存記録が変わりました');
 if(!read(dir,'exit.json')||owner&&!owner.released&&owner.serverId!==serverId&&alive(owner.pid))throw Error('会話は別のHubが受け取り中です');
 atomic(dir,'finished.json',{at:Date.now(),generation:phase.generation,id:crypto.randomUUID(),proofRequired:1});
 acknowledge(dir,'recovered.json',{version:1,requestToken:token,evidence:evidence(dir),at:Date.now()});
 }finally{fs.rmdirSync(lock);}
}
if(require.main===module&&process.argv[2]==='--worker')worker(process.argv[3]);
module.exports={strictRead,start,adopt,pending,read,atomic,claim,SpoolChild,failure,evidence,digest,completion,recover};
