'use strict';
// Maintenance-only proof resolver. Absence of a chat is never completion proof.
const fs=require('./platform/file-io'),path=require('node:path'),{createHash}=require('node:crypto'),{TextDecoder}=require('node:util');
const {noLinks,exists,snapshot}=require('./remove'),{isTrashDestination}=require('./trash');
const hash=x=>createHash('sha256').update(x).digest('hex'),id=/^[a-f0-9-]{36}$/;
const inside=(base,file)=>file===base||file.startsWith(base+path.sep);
// No cached content: each eligible call, including each pre-rename guard, reads
// the current source and pins. Reject replacement or writes during that read.
function read(file){
 noLinks(file);const before=fs.lstatSync(file);
 const regular=s=>s.isFile()&&s.nlink===1;
 const same=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
 if(!regular(before))throw Error('会話の証拠にリンクや特殊ファイルがあります');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  const opened=fs.fstatSync(fd);if(!regular(opened)||!same(before,opened))throw Error('会話の証拠が読取中に変わりました');
  const raw=fs.readFileSync(fd),after=fs.fstatSync(fd);noLinks(file);const current=fs.lstatSync(file);
  if(!regular(current)||!same(opened,after)||!same(after,current)||raw.length!==after.size)throw Error('会話の証拠が読取中に変わりました');
  return {file,sha256:hash(raw),bytes:raw.length,mode:after.mode&0o777,raw};
 }finally{fs.closeSync(fd);}
}
function rowsOf(raw,complete=false){
 if(complete&&raw.length&&raw[raw.length-1]!==10)throw Error('現役会話の行が未完了です');
 // Fatal decoding rejects invalid sequences even inside otherwise valid JSON.
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw).split('\n').filter(x=>x.trim()).map(JSON.parse);
}
function plannedSource(source,expected){
 const current=pin(source.log),old=expected?.source;
 if(source.kind!=='active'||expected?.kind!=='active'||!old||current.bytes<=old.bytes)return current;
 if(!Number.isSafeInteger(old.bytes)||old.bytes<1||source.log.raw[old.bytes-1]!==10||hash(source.log.raw.subarray(0,old.bytes))!==old.sha256)throw Error('固定した会話の原文部分が変わっています');
 // Only bytes/hash may grow. Path, permissions and all other proof fields are
 // still compared by matchesProof. Never mutate the approved plan or its hash.
 return {...current,bytes:old.bytes,sha256:old.sha256};
}
const record=f=>{const r=read(f);return {...r,value:JSON.parse(r.raw)};};
const pin=r=>({file:r.file,sha256:r.sha256,bytes:r.bytes,mode:r.mode});
function context(root,trashRoot){return {root,trashRoot};}
function resolve(o,p,spoolId,c,expected){
 if(!c)throw Error('退避の証拠照合には計画のコンテキストが必要です');
 if(!path.isAbsolute(o.pdir)||path.resolve(o.pdir)!==o.pdir||typeof o.project!=='string')throw Error('会話の所属が不明です');
 const log=path.join(o.pdir,'.ai/chat',o.task+'.jsonl'),queue=path.join(o.pdir,'.ai/chat',o.task+'.queue.json');noLinks(log);noLinks(queue);
 const refs=[o.request,o.userRow.turn,o.userRow.request].filter(Boolean);
 const checkQueue=file=>{if(!exists(file))return;const r=record(file),rows=r.value;if(!Array.isArray(rows)||rows.some(row=>refs.some(ref=>JSON.stringify(row).includes(ref))))throw Error('待ち列に関わる記録は保持');};
 checkQueue(queue);
 const sources=(()=>{
  const out=[];
  if(exists(log))out.push({kind:'active',log:read(log),pins:[]});
  // Standard task rotation has a committed manifest and content-bound originals.
  const history=path.join(o.pdir,'.ai/chat/history',o.task);noLinks(history);
  if(exists(history))for(const name of fs.readdirSync(history).sort().filter(n=>id.test(n))){
   const base=path.join(history,name),mf=path.join(base,'manifest.json');noLinks(mf);if(!exists(mf))continue;
   const r=record(mf),m=r.value;
   if(m.id!==name||m.project!==o.project||m.task!==o.task||m.stage!=='committed')continue;
   if(!Number.isSafeInteger(m.generation)||m.generation<1||!Array.isArray(m.entries))throw Error('保管会話の世代・一覧を照合できません');
   const entries=m.entries.filter(e=>e.existed&&e.kind==='log'&&e.file===log);if(entries.length!==1)throw Error('保管会話の所属が不明です');
   const e=entries[0],original=verifyOriginal(base,e);
   const pins=[pin(r)];
   for(const q of m.entries.filter(e=>e.existed&&e.file===queue)){const qr=verifyOriginal(base,q);checkQueue(qr.file);pins.push(pin(qr));}
   out.push({kind:'history',generation:m.generation,log:original,pins});
  }
  // Only completed formal removal receipts, never guessed Trash paths. Freetalk
  // legacy manifests lack committed/content fingerprints and remain retained.
  const removed=path.join(path.dirname(c.root),'removed');noLinks(removed);
  if(exists(removed))for(const name of fs.readdirSync(removed).sort().filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
   const r=record(path.join(removed,name)),m=r.value;
   if(m.project!==o.project||m.kind==='task'&&m.task!==o.task||!['task','project'].includes(m.kind)||m.tidy)continue;
   if(m.id+'.json'!==name||m.error||!Array.isArray(m.entries)||m.entries.some(e=>!e.moved||e.moving||e.restoring||e.restored))continue;
   for(const e of m.entries){
    if(typeof e.from!=='string'||!inside(e.from,log)||e.external||e.copy)continue;
    if(path.resolve(e.from)!==e.from||!path.isAbsolute(e.to)||path.resolve(e.to)!==e.to||!isTrashDestination(e.from,e.to,c.trashRoot))throw Error('削除先の所属を照合できません');
    noLinks(e.from);noLinks(e.to);
    if(exists(e.from)||snapshot(e.to)!==e.fingerprint)throw Error('削除済み原文が変わったか復元されています');
    const file=path.join(e.to,path.relative(e.from,log)),original=read(file),pins=[pin(r)];
    const qe=m.entries.find(e=>inside(e.from,queue));if(qe){const qf=path.join(qe.to,path.relative(qe.from,queue));checkQueue(qf);if(exists(qf))pins.push(pin(read(qf)));}
    out.push({kind:'removed',log:original,pins});
   }
  }
  return out;
 })();
 let selected;
 for(const source of sources){
  const rows=rowsOf(source.log.raw,source.kind==='active');
  const users=rows.filter(r=>r.role==='user'&&(r.turn===o.userRow.turn||o.request&&r.request===o.request)),ends=rows.filter(r=>r.role==='assistant'&&hash(JSON.stringify(r))===p.finalRowHash);
  const finals=rows.filter(r=>r.role==='assistant'&&(r.spoolId===spoolId+':final'||o.request&&r.request===o.request&&typeof r.spoolId==='string'&&r.spoolId.endsWith(':final')));
  if(!users.length&&!ends.length&&!finals.length)continue;
  if(users.length!==1||ends.length!==1||finals.length!==1||finals[0]!==ends[0]||hash(JSON.stringify(users[0]))!==hash(JSON.stringify(o.userRow))||rows.indexOf(users[0])>=rows.indexOf(ends[0])||ends[0].spoolId!==spoolId+':final'||users[0].integrationAuto||ends[0].integrationAuto||users[0].automation||ends[0].automation)throw Error('会話原文と最終保存の対応を照合できません');
  const requests=[o.request,users[0].request,ends[0].request].filter(Boolean);if(new Set(requests).size>1)throw Error('依頼と最終行の所属が違います');
  selected??={kind:source.kind,...(source.generation?{generation:source.generation}:{}),source:plannedSource(source,expected),pins:source.pins,userRowHash:hash(JSON.stringify(users[0]))};
 }
 if(!selected)throw Error(o.project==='freetalk'?'自由対話の旧退避には完了・原文照合の証拠がありません':'現役・保管・正式削除の会話原文と最終保存を照合できません');
 return selected;
}
function verifyOriginal(base,e){
 if(!/^[0-9]+\.original$/.test(e.saved))throw Error('保管原文の場所が不正です');const r=read(path.join(base,e.saved));
 if(r.sha256!==e.digest||r.bytes!==e.bytes||r.mode!==e.mode)throw Error('保管原文の内容・権限が変わっています');return r;
}
module.exports={context,resolve};
