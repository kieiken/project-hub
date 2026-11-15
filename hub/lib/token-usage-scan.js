'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {Projection}=require('./token-log-fields');
const n=v=>Number.isSafeInteger(v)&&v>=0?v:0;
const label=v=>typeof v==='string'&&v.length<=1024&&!/[\x00-\x1f]/.test(v)?v:'';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function noLinks(file){const absolute=path.resolve(file);let p=path.parse(absolute).root;for(const part of absolute.slice(p.length).split(path.sep).filter(Boolean)){p=path.join(p,part);if(fs.lstatSync(p).isSymbolicLink())throw Error('link');}return absolute;}
function open(file){noLinks(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const st=fs.fstatSync(fd);noLinks(file);const current=fs.lstatSync(file);if(st.ino!==current.ino||st.dev!==current.dev||!st.isFile()||st.nlink!==1){throw Error('not regular');}return {fd,st};}catch(e){fs.closeSync(fd);throw e;}}
async function walk(dir,files,root,depth=0){if(depth>12)return;let rows;try{noLinks(dir);rows=await fs.promises.readdir(dir,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')root.skipped++;return;}for(const row of rows){const file=path.join(dir,row.name);if(row.isSymbolicLink()){root.skipped++;continue;}if(row.isDirectory())await walk(file,files,root,depth+1);else if(row.isFile()&&/\.jsonl(?:\.zst)?$/.test(row.name))files.push({file,ai:root.ai,account:root.account});}}
function localDay(ts){const d=new Date(ts);return Number.isFinite(+d)?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';}
function putTool(records,key,r){if(records.put)records.put(key,r);else if(!records[key]||r.ts<records[key].ts||r.ts===records[key].ts&&records[key].fork&&!r.fork)records[key]=r;}
function take(row,ai,context,records){
 const ts=Date.parse(row.timestamp);if(row.type==='session_meta'){context.sid=label(row.payload?.id);context.originator=require('./token-usage-metadata').short(row.payload?.originator);context.fork=label(row.payload?.forked_from_id);context.forkAt=Number.isFinite(ts)?ts:0;context.cwd=label(row.payload?.cwd);context.caller=label(row.payload?.source);context.parent=label(row.payload?.source?.subagent?.thread_spawn?.parent_thread_id);context.sub=Boolean(context.parent)||context.sub;}
 if(row.type==='turn_context'){context.model=label(row.payload?.model);context.effort=label(row.payload?.effort||row.payload?.reasoning_effort);context.cwd=label(row.payload?.cwd)||context.cwd;}
 if(!Number.isFinite(ts))return;
 if(ai==='claude'&&row.type==='assistant'&&row.message?.id&&row.message?.usage){const u=row.message.usage;const r={ai,ts,sid:label(row.sessionId),model:label(row.message.model),cwd:label(row.cwd),caller:label(row.entrypoint),sub:row.isSidechain===true||context.sub,input:n(u.input_tokens),output:n(u.output_tokens),cache:n(u.cache_read_input_tokens),write:n(u.cache_creation_input_tokens)};r.total=r.input+r.output+r.cache+r.write;const key='c'+hash(label(row.message.id)+'\0'+label(row.requestId));if(records.put)records.put(key,r);else{const old=records[key];if(!old||r.total>old.total)records[key]=r;}}
 // Only projected type/ID fields are examined: names, arguments and text are
 // skipped by the byte parser. A stable call ID also deduplicates fork copies.
 if(ai==='claude'&&row.type==='assistant'&&row.message?.id){
  for(const [i,block]of (Array.isArray(row.message.content)?row.message.content:[]).entries())if(['tool_use','server_tool_use'].includes(block?.type)){
   const key='t'+hash('claude\0'+(label(block.id)||label(row.message.id)+'\0'+i));
   putTool(records,key,{kind:'tool',tools:1,total:0,ai,ts,sid:label(row.sessionId),model:label(row.message.model),cwd:label(row.cwd),caller:label(row.entrypoint),sub:row.isSidechain===true||context.sub});
  }
 }
 if(ai==='codex'&&row.type==='response_item'&&context.sid&&typeof row.payload?.type==='string'&&row.payload.type.endsWith('_call')){
  const id=label(row.payload.call_id)||label(row.payload.id);
  if(id)putTool(records,'t'+hash('codex\0'+id),{...context,kind:'tool',tools:1,total:0,ai,ts});
 }
 if(ai==='codex'&&row.type==='event_msg'&&row.payload?.type==='token_count'&&context.sid){const u=row.payload.info?.total_token_usage;if(!u)return;const total=n(u.total_tokens);if(!total)return;const input=n(u.input_tokens),cached=Math.min(input,n(u.cached_input_tokens));const r={ai,ts,...context,input:input-cached,output:n(u.output_tokens),cache:cached,write:0,reasoning:n(u.reasoning_output_tokens),total};const key='x'+hash(context.sid+'\0'+total);if(records.put)records.put(key,r);else records[key] ||=r;}
}
async function readLog(file,checkpoint,onRow){
 const {fd,st}=open(file);const compressed=file.endsWith('.zst');const same=checkpoint&&checkpoint.ino===st.ino&&checkpoint.dev===st.dev&&st.size>=checkpoint.size;
 if(same&&st.size===checkpoint.size&&st.mtimeMs===checkpoint.mtime){fs.closeSync(fd);return {checkpoint,unchanged:true,bad:0};}
 const start=!compressed&&same?checkpoint.offset:0;
 const parser=new Projection(onRow);let offset=start,last=start,bytes=0;
 const stream=fs.createReadStream(file,{fd,autoClose:true,start});
 let input=stream;
 if(compressed){if(typeof zlib.createZstdDecompress!=='function'){stream.destroy();return {unsupported:true};}const decoder=zlib.createZstdDecompress();stream.on('error',e=>decoder.destroy(e));input=stream.pipe(decoder);}
 try{for await(const chunk of input){parser.write(chunk);bytes+=chunk.length;if(!compressed){const i=chunk.lastIndexOf(10);if(i>=0)last=offset+i+1;offset+=chunk.length;}}if(compressed)parser.finish();}
 finally{stream.destroy();}
 return {checkpoint:{ino:st.ino,dev:st.dev,size:st.size,mtime:st.mtimeMs,offset:compressed?st.size:last},bad:parser.bad,bytes};
}
function forkBaseline(meta,parents=[]){
 const first=meta?.firstUsage;if(!meta?.fork||!(meta.forkAt>0)||!first)return null;
 const prior=parents.filter(p=>p.kind!=='tool'&&p.ts<=meta.forkAt),keys=['total','input','cache','output'];
 // A first checkpoint copied verbatim from the parent contains no new usage.
 if(prior.some(p=>keys.every(k=>p[k]===first.total[k])))return {counters:first.total,kind:'snapshot'};
 const counters=Object.fromEntries(Object.keys(first.total).map(k=>[k,first.total[k]-first.last[k]]));
 if(counters.total>0&&Object.values(counters).every(v=>v>=0)&&prior.some(p=>keys.every(k=>p[k]===counters[k])))return {counters,kind:'increment'};
 return null;
}
function deltaRecords(records,sessionMetadata={},audit={}){const claude=[],sessions=new Map();for(const raw of Object.values(records)){const r=raw.ai==='codex'?{...raw,...sessionMetadata[raw.sid]}:raw;if(r.kind==='tool'){claude.push(r);continue;}if(r.ai==='claude'){claude.push(r);continue;}if(!sessions.has(r.sid))sessions.set(r.sid,[]);sessions.get(r.sid).push(r);}
 for(const [sid,rows] of sessions){rows.sort((a,b)=>a.ts-b.ts||b.total-a.total);let prev={input:0,output:0,cache:0,write:0,total:0,reasoning:0};const meta=sessionMetadata[sid],baseline=forkBaseline(meta,sessions.get(meta?.fork));if(baseline){prev=baseline.counters;audit[baseline.kind]=(audit[baseline.kind]||0)+1;audit.excluded=(audit.excluded||0)+prev.total;}else if(meta?.fork&&(!meta.firstUsage||meta.firstUsage.total.total>meta.firstUsage.last.total))audit.unverified=(audit.unverified||0)+1;for(const r of rows){if(r.total<=prev.total)continue;const d={...r,unknown:0,tools:0};for(const k of ['input','output','cache','write','total','reasoning'])d[k]=(r[k]||0)-(prev[k]||0);if(['input','output','cache','write'].some(k=>d[k]<0)||d.input+d.output+d.cache+d.write!==d.total){d.unknown=d.total;for(const k of ['input','output','cache','write','reasoning'])d[k]=0;}d.reasoning=Math.min(d.output,Math.max(0,d.reasoning));claude.push(d);prev=r;}}return claude;
}
function summary(state,preferences={},now=Date.now()){const {attribute}=require('./token-usage-provenance');const daily={},models={},origins={},providers={},projects={},efforts={},helpers={},runs={};
 const proofs=Object.values(state.provenance||{}),bySession=new Map();for(const p of proofs){const key=p.ai+'\0'+p.sid;if(!bySession.has(key))bySession.set(key,[]);bySession.get(key).push(p);}
 const forkAudit={};const enriched=deltaRecords(state.records,state.sessions,forkAudit).map(r=>attribute(r,bySession.get(r.ai+'\0'+r.sid)||bySession.get(r.ai+'\0'+r.parent)||[]));
 for(const r of enriched){const day=localDay(r.ts);if(!day)continue;const dims=[[daily,day],[models,r.ai+' / '+(r.model||'?')],[origins,r.origin],[providers,r.ai],[projects,(r.project||'不明')+' / '+(r.task||'不明')],[efforts,r.ai+' / '+(r.effort||'不明')],[helpers,r.sub?'補助の AI':'主な AI']];for(const [group,key]of dims){const b=group[key] ||= {total:0,input:0,output:0,cache:0,write:0,unknown:0,tools:0};for(const k of Object.keys(b))b[k]+=r[k]||0;}
  if(r.kind==='tool')continue;
  const key=r.ai+' / '+r.run;const run=runs[key] ||= {id:hash(key),ai:r.ai,project:r.project,task:r.task,model:r.model,effort:r.effort,role:r.role,origin:r.origin,attribution:r.attribution,start:r.start||r.ts,end:r.end||r.ts,verified:Boolean(r.start&&r.end),bounded:Boolean(r.start),total:0,input:0,output:0,cache:0,write:0,unknown:0,tools:0,turns:0,lastTs:0};run.lastTs=Math.max(run.lastTs,r.ts);run.start=Math.min(run.start,r.ts);run.end=Math.max(run.end,r.ts);run.turns++;for(const k of ['total','input','output','cache','write','unknown'])run[k]+=r[k]||0;
 }
 const days=Object.keys(daily).sort();let streak=0,best=0,prev='';for(const d of days){if(!daily[d].total)continue;const date=new Date(d+'T12:00:00');date.setDate(date.getDate()-1);streak=localDay(date)===prev?streak+1:1;best=Math.max(best,streak);prev=d;}
 const today=localDay(now),yesterday=new Date(today+'T12:00:00');yesterday.setDate(yesterday.getDate()-1);const currentStreak=prev===today||prev===localDay(yesterday)?streak:0;
 const allRuns=Object.values(runs);for(const r of allRuns)r.ms=r.end-r.start;
 const alertsLib=require('./token-usage-alerts'),alerts=alertsLib.evaluate(alertsLib.facts(enriched.filter(r=>r.kind!=='tool'),allRuns,now,state.monitorStartedAt||now),preferences.limits,preferences.acknowledged,{startedAt:state.monitorStartedAt||now});
 return {...require('./token-usage-alerts').summarize(alerts),preferencesRevision:preferences.revision||0,version:1,updated:Date.now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,daily,models,origins,providers,projects,efforts,helpers,runs:allRuns.sort((a,b)=>b.total-a.total).slice(0,50),longest:allRuns.reduce((a,b)=>!a||b.ms>a.ms?b:a,null),total:Object.values(daily).reduce((s,r)=>s+r.total,0),peak:Math.max(0,...Object.values(daily).map(r=>r.total)),streak:best,currentStreak,monitorStartedAt:state.monitorStartedAt,coverage:{...state.coverage,forks:forkAudit}};}
async function scan({roots,state,provenanceRoot,preferences={},progress=()=>{},summarize=true}){state ||= {version:1,files:{},records:{}};state.monitorStartedAt ||= Date.now();state.sessions ||= {};state.coverage={files:0,read:0,skipped:0,unsupported:0,broken:0};const files=[];
 for(const root of roots){const r={...root,skipped:0};await walk(root.dir,files,r);state.coverage.skipped+=r.skipped;}
 state.coverage.files=files.length;progress(state.coverage);
 for(const {file,ai,account}of files){const key=hash(file),old=state.files[key];const context=old?.context||{sub:file.includes(path.sep+'subagents'+path.sep),account};try{if(ai==='codex'&&old?.checkpoint&&context.metadataVersion!==2){const m=await require('./token-usage-metadata').metadata(file);if(m){state.sessions[m.sid]={...state.sessions[m.sid],...m};const {firstUsage,...header}=m;Object.assign(context,header);}context.metadataVersion=2;}const out=await readLog(file,old?.checkpoint,row=>{take(row,ai,context,state.records);if(ai==='codex'&&context.sid){const m=state.sessions[context.sid] ||= {};if(row.type==='session_meta')Object.assign(m,{originator:context.originator||'',fork:context.fork||'',forkAt:context.forkAt||0});if(m.fork&&!Object.hasOwn(m,'firstUsage')&&row.type==='event_msg'&&row.payload?.type==='token_count')m.firstUsage=require('./token-usage-metadata').firstUsage(row);}});context.metadataVersion=2;if(out.unsupported)state.coverage.unsupported++;else{const bad=out.unchanged?(old?.bad||0):(old?.bad||0)+(out.bad||0);state.files[key]={checkpoint:out.checkpoint,context,bad};state.coverage.broken+=bad;}}catch{state.coverage.skipped++;}state.coverage.read++;if(state.coverage.read%20===0)progress(state.coverage);}
 if(provenanceRoot)await require('./token-usage-provenance').provenance(provenanceRoot,state);
 return {state,snapshot:summarize?summary(state,preferences):null};
}
module.exports={scan,summary,deltaRecords,forkBaseline,localDay,readLog,noLinks,open,hash};
