'use strict';
const persistence = require('./platform').persistence;
// Exact provenance, outside product Git. A durable per-file intent precedes every mutation.
const fs=require('./platform/file-io'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const roots=new Set(),digest=x=>createHash('sha256').update(x).digest('hex');
const git=(dir,args)=>execFileSync('git',['-C',dir,...args],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
function links(file){for(let f=path.resolve(file);;f=path.dirname(f)){try{if(fs.lstatSync(f).isSymbolicLink())throw Error('記録のリンク先には書き込めません');}catch(e){if(e.code!=='ENOENT')throw e;}if(f===path.dirname(f))break;}}
function state(file){try{const s=fs.lstatSync(file);if(!s.isFile()||s.nlink!==1)return 'unsupported';return digest(fs.readFileSync(file))+':'+(s.mode&0o777);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function home(file){return [...roots].find(r=>{const rel=path.relative(path.join(r,'Product'),file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);});}
function journal(root){const f=path.join(root,'_hub/integration-writes.json');links(f);try{return {f,data:JSON.parse(fs.readFileSync(f,'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;return {f,data:{}};}}
function syncDir(dir){while(!fs.existsSync(dir)&&dir!==path.dirname(dir))dir=path.dirname(dir);persistence.syncDirectory(dir);}
function atomic(f,data,{exclusive=false}={}){links(f);fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=exclusive?f:f+'.'+randomUUID(),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(!exclusive)fs.renameSync(tmp,f);syncDir(path.dirname(f));}
function journalLock(root){return path.join(root,'_hub/integration-writes.lock');}
// rename makes a publication atomic, but does not serialize read/modify/write
// across Hub and local CLI processes. Lock before reading the shared map.
function updateJournal(root,change){
 const lock=journalLock(root);links(lock);fs.mkdirSync(path.dirname(lock),{recursive:true});const deadline=process.hrtime.bigint()+5000000000n;
 for(;;){try{fs.mkdirSync(lock,{mode:0o700});break;}catch(e){if(e.code!=='EEXIST')throw e;links(lock);if(process.hrtime.bigint()>=deadline)throw Object.assign(Error('書込み証拠の保存状態を確認できません'),{code:'INTEGRATION_WRITE_BUSY'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
 // Never steal a lock, including one left by an interrupted publisher.
 try{const j=journal(root);change(j.data);atomic(j.f,j.data);}finally{fs.rmdirSync(lock);}
}
function intent(file){const root=home(file);return root&&path.join(root,'_hub/integration-write-intents',digest(path.resolve(file))+'.json');}
function pending(file){const f=intent(file);if(!f)return false;try{fs.lstatSync(f);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function topOf(file){let dir=path.dirname(file);while(!fs.existsSync(dir)&&dir!==path.dirname(dir))dir=path.dirname(dir);try{return git(dir,['rev-parse','--show-toplevel']).toString().trim();}catch{return null;}}
function base(dir,rel){
 let row;try{row=git(dir,['ls-tree','HEAD','--',rel]).toString().trim();}catch{
  try{const ref=git(dir,['symbolic-ref','-q','HEAD']).toString().trim();try{git(dir,['show-ref','--verify','--quiet',ref]);}catch(e){if(e.status===1)return null;}}catch{}return 'unsupported';
 }if(!row)return null;const m=row.match(/^(100644|100755) blob ([a-f0-9]+)\t/);if(!m)return 'unsupported';
 return digest(git(dir,['cat-file','blob',m[2]]))+':'+(m[1]==='100755'?'x':'-');
}
const normalized=s=>s===null?null:s==='unsupported'?s:s.split(':')[0]+':'+((Number(s.split(':')[1])&0o111)?'x':'-');
function begin(file){file=path.resolve(file);const root=home(file),top=root&&topOf(file);if(!top)return null;links(file);
 const before=state(file),baseline=base(top,path.relative(top,file)),old=journal(root).data[file];
 // Never launder old external changes, chmod or an unfinished write.
 const trusted=!pending(file)&&baseline!=='unsupported'&&before!=='unsupported'&&(normalized(before)===baseline||old?.top===top&&old.after===before&&old.bases?.includes(baseline));
 const mark=intent(file),retained=pending(file);if(!retained)atomic(mark,{file,top,before,phase:'writing'},{exclusive:true});return {file,root,top,before,baseline,old,trusted,mark,retained};
}
function end(e){if(!e)return;const after=state(e.file);if(after!==null&&after!=='unsupported'){persistence.syncFile(e.file);}syncDir(path.dirname(e.file));
 updateJournal(e.root,data=>{if(e.trusted&&after!=='unsupported')data[e.file]={top:e.top,after,bases:[...new Set([...(e.old?.bases||[]),e.baseline,normalized(e.before),normalized(after)])]};else delete data[e.file];});
 if(!e.retained){fs.unlinkSync(e.mark);syncDir(path.dirname(e.mark));}
}
function write(file,operation){const e=begin(file);let out;try{out=operation();}catch(error){if(e&&!e.retained&&state(e.file)===e.before){fs.unlinkSync(e.mark);syncDir(path.dirname(e.mark));}throw error;}end(e);return out;}
function tree(from,operation){const entries=[];function walk(f){const s=fs.lstatSync(f);if(s.isDirectory())for(const n of fs.readdirSync(f))walk(path.join(f,n));else entries.push(begin(f));}walk(from);const out=operation();for(const e of entries)end(e);return out;}
function ignored(dir){let top;try{top=git(dir,['rev-parse','--show-toplevel']).toString().trim();}catch{return [];}
 const rows=git(top,['status','--porcelain','--no-renames','--untracked-files=all','-z']).toString().split('\0').filter(Boolean),out=[];
 for(const row of rows){const rel=row.slice(3),file=path.join(top,rel),root=home(file);if(!root||fs.existsSync(journalLock(root))||pending(file))continue;
  const entry=journal(root).data[file];if(!entry||entry.top!==top||entry.after!==state(file)||!entry.bases?.includes(base(top,rel)))continue;
  if(row.slice(0,2)!=='??'&&row[0]!==' ')continue;out.push(rel);
 }return out;
}
function inspect(gitw,dir){const ignore=ignored(dir);return gitw.inspect(dir,{readOnly:true,...(ignore.length?{ignore}:{})});}
async function ignoredAsync(dir){return require('./integration-read-worker').run('writes.ignored',{dir,roots:[...roots]},{dirs:[dir]});}
async function inspectAsync(gitw,dir){return require('./git-read').consistent([dir],async()=>{const ignore=await ignoredAsync(dir);return gitw.inspectAsync(dir,{ignore});});}
// Only the formal confirmed commit may retire an interrupted write, anchored to HEAD.
function committed(file){file=path.resolve(file);const root=home(file),top=root&&topOf(file);if(!top)throw Error('保存後の記録を確認できません');updateJournal(root,data=>{if(normalized(state(file))!==base(top,path.relative(top,file)))throw Error('保存後の記録を確認できません');delete data[file];});const f=intent(file);if(pending(file)){fs.unlinkSync(f);syncDir(path.dirname(f));}}
module.exports={ignoredAsync,inspectAsync,register:root=>roots.add(path.resolve(root)),write,tree,inspect,ignored,pending,state,home,atomic,committed};
