'use strict';
// Read-only identity index. Full request bodies are parsed only in a worker;
// the main thread validates file metadata before using a completed snapshot.
const fs=require('node:fs'),path=require('node:path'),{Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
function mark(file){try{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile())throw Error('CLIの実行記録が通常ファイルではありません');return ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid'].map(k=>String(s[k])).join(':');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function folders(root){try{
 const names=fs.readdirSync(root),archive=root+'-archive';
 // A missing receipt cannot erase the fact that a request was archived. An
 // incomplete maintenance operation fences absence until explicitly repaired.
 if(fs.existsSync(archive)){
  require('./remove').noLinks(archive);
  for(const id of fs.readdirSync(archive).filter(n=>/^[a-f0-9-]{36}$/.test(n)))if(!names.includes('archive-'+id+'.json'))names.push('@legacy/'+id);
 }
 return names.filter(n=>legacy(n)||fs.statSync(path.join(root,n)).isDirectory()||/^archive-[a-f0-9-]{36}\.json$/.test(n)).sort();
 }catch(e){if(e.code==='ENOENT'&&!fs.existsSync(root))return [];throw e;}}

const catalog=n=>/^archive-[a-f0-9-]{36}\.json$/.test(n);
const legacy=n=>/^@legacy\/[a-f0-9-]{36}$/.test(n);
const batch=(root,name)=>path.join(root+'-archive',legacy(name)?name.slice(8):name.slice(8,-5));
const input=(root,name)=>catalog(name)?path.join(root,name):path.join(root,name,'request.json');
// Legacy batches have no compact receipt. Pin their plan, complete directory
// inventory and every archived request stamp; request bodies stay in the worker.
function legacyFiles(root,name){
 const dir=batch(root,name);require('./remove').noLinks(dir);
 return fs.readdirSync(dir).filter(n=>{const file=path.join(dir,n);require('./remove').noLinks(file);const s=fs.lstatSync(file);if(/^[a-f0-9-]{36}$/.test(n)&&!s.isDirectory())throw Error('invalid archived run');return s.isDirectory();}).sort();
}
function originalPresent(root,id){
 if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('invalid archived run');
 const dir=path.join(root,id);require('./remove').noLinks(dir);
 try{return fs.lstatSync(dir).isDirectory();}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
function stamp(root,name){
 if(legacy(name)){
  const dir=batch(root,name),planFile=path.join(dir,'plan.json'),planMark=mark(planFile),names=legacyFiles(root,name),restoreMark=mark(path.join(dir,'restore-intent.json'));
  // Only restored batches need their missing originals pinned. The compact
  // plan contains file metadata; full request bodies remain worker-only.
  const restored=restoreMark===null?[]:JSON.parse(fs.readFileSync(planFile,'utf8')).items.filter(i=>!names.includes(i.name)).map(i=>[i.name,originalPresent(root,i.name)]);
  return JSON.stringify([planMark,restoreMark,names.map(n=>[n,mark(path.join(dir,n,'request.json'))]),restored]);
 }
 if(catalog(name))return JSON.stringify([mark(input(root,name)),mark(path.join(batch(root,name),'plan.json'))]);
 return mark(input(root,name));
}
function legacyEntries(root,name){
 const dir=batch(root,name),file=path.join(dir,'plan.json');require('./remove').noLinks(file);
 const plan=JSON.parse(fs.readFileSync(file,'utf8')),names=legacyFiles(root,name);
 if(plan.version!==1||plan.id!==name.slice(8)||plan.root!==root||plan.archiveRoot!==root+'-archive'||!Array.isArray(plan.items)||plan.items.some(i=>!/^[a-f0-9-]{36}$/.test(i.name||''))||new Set(plan.items.map(i=>i.name)).size!==plan.items.length||names.some(n=>!plan.items.some(i=>i.name===n)))throw Error('invalid legacy archive plan');
 const missing=plan.items.filter(i=>!names.includes(i.name));
 if(missing.length&&(mark(path.join(dir,'restore-intent.json'))===null||missing.some(i=>!originalPresent(root,i.name))))throw Error('missing legacy archive original');
 // Restored runs are indexed through the ordinary root inventory, avoiding
 // duplicate identities after complete or interrupted formal restoration.
 return plan.items.filter(i=>names.includes(i.name)).map(i=>{
  const requestFile=path.join(dir,i.name,'request.json');require('./remove').noLinks(requestFile);
  const raw=fs.readFileSync(requestFile),expected=i.files?.find(f=>f.name==='request.json'),digest=x=>require('node:crypto').createHash('sha256').update(x).digest('hex');
  if(!expected||raw.length!==expected.bytes||digest(raw)!==expected.sha256||digest(JSON.stringify(i.files))!==i.sha256)throw Error('legacy request does not match plan');
  const request=JSON.parse(raw);if(!request?.options)throw Error('invalid legacy request');
  return {name:i.name,request:identity(request)};
 });
}
function identity(req){
 if(!req)return null;const o=req.options;if(!o)return {options:null};
 return {options:{project:o.project,task:o.task,request:o.request,id:o.id,automation:{runId:o.automation?.runId,metadata:{runId:o.automation?.metadata?.runId}},limitSwitch:{sourceRequest:o.limitSwitch?.sourceRequest,request:o.limitSwitch?.request}}};
}
function scan(root,previous){
 const old=new Map(previous.map(e=>[e.name,e])),entries=[];let reads=0;
 for(const name of folders(root)){
  const file=input(root,name),before=stamp(root,name),cached=old.get(name);
  if(cached&&cached.stamp===before){entries.push(cached);continue;}
  let request=null,error=null,archived=null;
  // Cache failed parses too: unchanged corrupt files remain unknown without
  // repeatedly loading their bodies. A replacement stamp permits a new read.
  try{if(legacy(name)){reads++;archived=legacyEntries(root,name);}else if(before!==null){reads++;const raw=JSON.parse(fs.readFileSync(file,'utf8'));
   if(catalog(name)){
    require('./remove').noLinks(file);
    if(raw.version!==1||'archive-'+raw.id+'.json'!==name||!Array.isArray(raw.items)||raw.items.some(i=>!/^[a-f0-9-]{36}$/.test(i.name)||!i.request?.options)||new Set(raw.items.map(i=>i.name)).size!==raw.items.length)throw Error('invalid archive evidence');
    const pf=path.join(root+'-archive',raw.id,'plan.json');require('./remove').noLinks(pf);const plan=JSON.parse(fs.readFileSync(pf,'utf8'));
    if(plan.version!==2||plan.id!==raw.id||plan.root!==root||plan.archiveRoot!==root+'-archive'||!Array.isArray(plan.items)||JSON.stringify(raw.items)!==JSON.stringify(plan.items.map(i=>({name:i.name,request:i.delivery}))))throw Error('archive evidence does not match plan');
    archived=raw.items.map(i=>({name:i.name,request:identity(i.request)}));
   }else request=identity(raw);}}catch{error='CLIの実行記録を読み取れません';}
  if(stamp(root,name)!==before)error='CLIの実行記録が確認中に変わりました';
  entries.push({name,stamp:before,request,error,...(archived?{archived}:{})});
 }
 return {entries,reads};
}
class IdeaSpoolIndex {
 constructor(root){this.root=root;this.entries=null;this.pending=null;this.error=null;this.reads=0;}
 refresh(){
  if(this.pending)return;
  this.error=null;
  const worker=new Worker(__filename,{workerData:{root:this.root,previous:this.entries||[]}});this.pending=worker;
  worker.once('message',data=>{if(this.pending!==worker)return;if(data.error)this.error=data.error;else{this.entries=data.entries;this.reads+=data.reads;this.error=data.entries.find(e=>e.error)?.error||null;}this.pending=null;});
  worker.once('error',()=>{if(this.pending===worker){this.error='CLIの実行記録を読み取れません';this.pending=null;}});
  worker.once('exit',code=>{if(this.pending===worker){this.error='CLIの実行記録の確認が終了しませんでした';this.pending=null;}});
  worker.unref();
 }
 snapshot(){
  if(this.pending)return null;
  // Revalidate the complete inventory as well as each request: neither a newly
  // created spool nor a replacement may turn stale absence into non-delivery.
  if(this.entries){try{const names=folders(this.root);if(names.length===this.entries.length&&names.every((n,i)=>n===this.entries[i].name&&stamp(this.root,n)===this.entries[i].stamp))return this.error?null:this.entries.flatMap(e=>e.archived||[e]);}catch(e){this.error=e.message;}}
  this.refresh();return null;
 }
 async ready(timeoutMs=30000){
  const end=performance.now()+Math.max(0,timeoutMs);
  for(;;){
   const entries=this.snapshot();if(entries)return entries;
   const worker=this.pending,left=end-performance.now();if(!worker||left<=0)return null;
   const completed=await new Promise(resolve=>{
    const finish=value=>{clearTimeout(timer);for(const event of ['message','error','exit'])worker.off(event,done);resolve(value);};
    const done=()=>finish(true),timer=setTimeout(()=>finish(false),left);
    for(const event of ['message','error','exit'])worker.once(event,done);
   });
   // A failed scan remains unknown; do not retry an unchanged read failure.
   if(!completed||this.error)return null;
  }
 }
 close(){const worker=this.pending;this.pending=null;if(worker)void worker.terminate();}
}
if(!isMainThread){try{parentPort.postMessage(scan(workerData.root,workerData.previous));}catch{parentPort.postMessage({error:'CLIの実行記録を読み取れません'});}}
module.exports={IdeaSpoolIndex,identity};
