'use strict';
// Transactional, bounded working set: incoming projected numbers are journaled,
// then merged one shard at a time. Only the final manifest publishes checkpoints,
// raw deduplication evidence and rollups together. Two reusable slots bound
// derived storage growth; the original v1/v2 index is never overwritten.
const fs=require('node:fs'),path=require('node:path');
const {scan,hash,noLinks,localDay,open}=require('./token-usage-scan');
const {read,json,atomic,GROUPS}=require('./token-usage-store');
const rollup=require('./token-usage-rollup');
const valid=(key,digest)=>/^[a-f0-9]{2}(?:[a-f0-9]{62})?$/.test(key)&&/^[a-f0-9]{64}$/.test(digest);
function checked(file,digest){const value=read(file);if(!value||hash(json(value))!==digest)throw Error('partition integrity');return value;}
function objectFile(dir,manifest,prefix,key,digest){if(!valid(key,digest))throw Error('partition');const slot=manifest.slots?.[prefix+':'+key];if(slot!==undefined&&!['a','b'].includes(slot))throw Error('slot');return path.join(dir,prefix+'-'+key+'-'+(slot||digest)+'.json');}
function metadata(dir,manifest){const state={...manifest.properties};for(const group of GROUPS.filter(g=>g!=='records')){state[group]={};for(const [key,digest]of Object.entries(manifest.partitions[group]||{})){if(!valid(key,digest))throw Error('partition');const rows=manifest.version===3?checked(objectFile(dir,manifest,group,key,digest),digest):read(path.join(dir,group+'-'+key+'.json'));if(!rows)throw Error('missing partition');Object.assign(state[group],rows);}}return state;}
function shard(key,row){return row.kind!=='tool'&&row.ai==='codex'?hash('codex\0'+(row.sid||key)):hash('claude-key\0'+key.slice(1,3));}
function rawFile(dir,manifest,key,digest){return objectFile(dir,manifest,'raw',key,digest);}
async function run({dir,roots,provenanceRoot,preferences={},progress=()=>{},now=Date.now(),fault=()=>{}}){
 noLinks(dir);const stats={bytes:0,files:0,rawReads:0,rollupReads:0,rebuilt:0};let peakHeap=process.memoryUsage().heapUsed;const sample=()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);};
 const previous=read(path.join(dir,'compact-manifest.json')),legacy=previous?null:read(path.join(dir,'manifest.json'));
 if(previous&&previous.version!==3||legacy&&legacy.version!==2)throw Error('version');
 const manifest=previous||{version:3,properties:{},partitions:{},raw:{},rollups:{}};
 let state=previous||legacy?metadata(dir,previous||legacy):read(path.join(dir,'index.json'));
 if(state&&state.version!==1)throw Error('version');state ||= {version:1,files:{}};state.monitorStartedAt ||= now;state.sessions ||= {};
 const rebuildTools=state.toolCountsVersion!==1;
 if(rebuildTools)state.files={};
 const next={version:3,properties:{},partitions:{},raw:{...manifest.raw},rollups:rebuildTools?{}:{...manifest.rollups},slots:{...manifest.slots},...(manifest.journalSlot?{journalSlot:manifest.journalSlot}:{})},pending=new Map(),buffers=new Map();let buffered=0;
 const journalSlot=manifest.journalSlot==='a'?'b':'a';const fileFor=key=>path.join(dir,'pending-'+key+'-'+journalSlot+'.jsonl');
 function flush(){for(const [key,rows]of buffers){const file=fileFor(key),raw=rows.join('');if(pending.has(key)){const probe=open(file);fs.closeSync(probe.fd);const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW||0));try{fs.writeFileSync(fd,raw);}finally{fs.closeSync(fd);}stats.bytes+=Buffer.byteLength(raw);stats.files++;}else{atomic(file,raw,stats);pending.set(key,file);next.journalSlot=journalSlot;}}buffers.clear();buffered=0;sample();}

 const records={put(key,row){const bucket=shard(key,row),line=JSON.stringify([key,row])+'\n';(buffers.get(bucket)||buffers.set(bucket,[]).get(bucket)).push(line);buffered+=Buffer.byteLength(line);if(buffered>=1048576)flush();}};
 if(!previous){if(legacy){for(const [key,digest]of Object.entries(legacy.partitions.records||{})){if(!valid(key,digest))throw Error('partition');const rows=read(path.join(dir,'records-'+key+'.json'));if(!rows)throw Error('missing partition');for(const [id,r]of Object.entries(rows))records.put(id,r);sample();}}else if(state.records){for(const [key,r]of Object.entries(state.records))records.put(key,r);delete state.records;}}
 state.records=records;
 await scan({roots,state,provenanceRoot,preferences,progress,summarize:false});delete state.records;flush();sample();
 state.toolCountsVersion=1;
 const save=(prefix,key,value)=>{const raw=json(value),digest=hash(raw),prior=prefix==='raw'?manifest.raw[key]:prefix==='rollup'?manifest.rollups[key]?.digest:manifest.partitions[prefix]?.[key];if(prior===digest)return digest;const token=prefix+':'+key,slot=manifest.slots?.[token]==='a'?'b':'a';next.slots[token]=slot;atomic(objectFile(dir,next,prefix,key,digest),raw,stats);return digest;};

 for(const [key,file]of pending){const rows=next.raw[key]?checked(rawFile(dir,next,key,next.raw[key]),next.raw[key]):{};if(next.raw[key])stats.rawReads++;
  const {fd}=open(file),stream=fs.createReadStream(file,{fd,autoClose:true,encoding:'utf8'});let tail='';try{for await(const chunk of stream){const lines=(tail+chunk.toString('utf8')).split('\n');tail=lines.pop();for(const line of lines){const [id,r]=JSON.parse(line),old=rows[id];if(!old||r.kind==='tool'&&(r.ts<old.ts||r.ts===old.ts&&old.fork&&!r.fork)||r.ai==='claude'&&r.total>old.total)rows[id]=r;}}if(tail)throw Error('incomplete journal');}finally{stream.destroy();}
  next.raw[key]=save('raw',key,rows);sample();}
 fault('raw');
 const proofs=new Map();for(const p of Object.values(state.provenance||{})){const key=p.ai+'\0'+p.sid;(proofs.get(key)||proofs.set(key,[]).get(key)).push(p);}
 // Dependencies include raw parent evidence and all attribution intervals. A
 // delayed parent checkpoint or a finished Hub run invalidates the child too.
 const dependency=inputs=>hash(json({started:state.monitorStartedAt,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,inputs:inputs.map(([ai,sid,parent])=>({ai,sid,parent,metadata:ai==='codex'?state.sessions[sid]:null,parentDigest:ai==='codex'&&state.sessions[sid]?.fork?next.raw[hash('codex\0'+state.sessions[sid].fork)]:null,proofs:(proofs.get(ai+'\0'+sid)||proofs.get(ai+'\0'+parent)||[]).slice().sort((a,b)=>a.id.localeCompare(b.id))}))}));
 const result=rollup.collector(state,preferences,now);
 for(const [key,digest]of Object.entries(next.raw)){
  if(!valid(key,digest))throw Error('partition');const old=rebuildTools?null:manifest.rollups[key];let part;
  if(old){if(!valid(key,old.digest))throw Error('partition');part=checked(objectFile(dir,manifest,'rollup',key,old.digest),old.digest);stats.rollupReads++;}
  if(old&&old.raw===digest&&old.dependency===dependency(part.inputs)&&old.day<=localDay(now)){
   // The small rollup is sufficient: no raw partition is opened here.
  }else{
   const rows=checked(rawFile(dir,next,key,digest),digest);stats.rawReads++;const parents={};const sids=new Set(Object.values(rows).filter(r=>r.ai==='codex').map(r=>r.sid));for(const sid of sids){const parent=state.sessions[sid]?.fork;if(parent&&!sids.has(parent)){const pk=hash('codex\0'+parent),pd=next.raw[pk];if(pd){Object.assign(parents,checked(rawFile(dir,next,pk,pd),pd));stats.rawReads++;}}}
   part=rollup.build(rows,state,proofs,parents,now);part.inputs=[...new Map(Object.values(rows).map(r=>{const input=[r.ai,r.sid||'',r.parent||''];return [JSON.stringify(input),input];})).values()];const pd=save('rollup',key,part);next.rollups[key]={raw:digest,dependency:dependency(part.inputs),digest:pd,day:part.day};stats.rebuilt++;sample();
  }
  result.add(part);
 }
 const snapshot=result.finish();sample();
 for(const [k,v]of Object.entries(state))if(!GROUPS.includes(k))next.properties[k]=v;
 for(const group of GROUPS.filter(g=>g!=='records')){const buckets={};for(const [key,row]of Object.entries(state[group]||{})){const bucket=hash(key).slice(0,2);(buckets[bucket] ||= {})[key]=row;}next.partitions[group]={};for(const [key,rows]of Object.entries(buckets)){const digest=hash(json(rows));next.partitions[group][key]=digest;if(manifest.partitions[group]?.[key]!==digest)save(group,key,rows);}}
 fault('commit');const raw=json(next);if(!previous||json(previous)!==raw)atomic(path.join(dir,'compact-manifest.json'),raw,stats);
 // If interrupted after manifest commit, the next run recreates summary.json.
 fault('summary');const old=read(path.join(dir,'summary.json')),comparable=s=>{if(!s)return '';const {updated,...rest}=s;return json(rest);};if(comparable(old)!==comparable(snapshot))atomic(path.join(dir,'summary.json'),json(snapshot),stats);else snapshot.updated=old.updated;
 stats.heapUsed=process.memoryUsage().heapUsed;stats.peakHeap=Math.max(peakHeap,stats.heapUsed);stats.maxRssKiB=process.resourceUsage().maxRSS;return {snapshot,storage:stats};
}
module.exports={run,shard};
