'use strict';
// Rollups are replaceable, per-partition derivatives. Raw deduplication keys and
// parent checkpoints stay on disk even after their alert window has expired.
const {hash,localDay,deltaRecords,forkBaseline}=require('./token-usage-scan');
const {attribute}=require('./token-usage-provenance');
const groups=['daily','models','origins','providers','projects','efforts','helpers'];
const amounts=['total','input','output','cache','write','unknown','tools'];
function empty(){return Object.fromEntries([...groups,'runs','forks'].map(k=>[k,{}]));}
function addAmounts(a,b){for(const k of amounts)a[k]=(a[k]||0)+(b[k]||0);}
function addRun(runs,key,r){const old=runs[key];if(!old){runs[key]={...r};return;}if(r.firstTs<old.firstTs||r.firstTs===old.firstTs&&r.firstKey<old.firstKey){for(const k of ['model','effort','role','origin','attribution','project','task','verified','bounded','firstTs','firstKey'])old[k]=r[k];}addAmounts(old,r);old.start=Math.min(old.start,r.start);old.end=Math.max(old.end,r.end);old.lastTs=Math.max(old.lastTs,r.lastTs);old.turns+=r.turns;}
function cutoff(now,n){const d=new Date(now);d.setDate(d.getDate()-n);return localDay(d);}
function build(records,state,proofs,parentRecords,now){
 const out={...empty(),contexts:[],events:[],day:localDay(now)},contexts=new Map(),audit={};
 const combined=Object.fromEntries(Object.entries({...parentRecords,...records}).map(([key,r])=>[key,{...r,_key:key}]));
 const own=new Set(Object.values(records).filter(r=>r.ai==='codex'&&r.kind!=='tool').map(r=>r.sid));
 // Parent rows are used only as evidence, never as contributions of this shard.
 const deltas=deltaRecords(combined,state.sessions,audit).filter(r=>Object.hasOwn(records,r._key));
 // The audit from deltaRecords includes evidence-only parents; audit each own
 // session separately so a multi-generation parent's inheritance is not repeated.
 out.forks={};for(const sid of own){const meta=state.sessions[sid],baseline=forkBaseline(meta,Object.values(parentRecords||{}).filter(r=>r.sid===meta?.fork));if(baseline){out.forks[baseline.kind]=(out.forks[baseline.kind]||0)+1;out.forks.excluded=(out.forks.excluded||0)+baseline.counters.total;}else if(meta?.fork&&(!meta.firstUsage||meta.firstUsage.total.total>meta.firstUsage.last.total))out.forks.unverified=(out.forks.unverified||0)+1;}

 const from=cutoff(now,60);
 for(const raw of deltas){const r=attribute(raw,proofs.get(raw.ai+'\0'+raw.sid)||proofs.get(raw.ai+'\0'+raw.parent)||[]),day=localDay(r.ts);if(!day)continue;
  const dims=[day,r.ai+' / '+(r.model||'?'),r.origin,r.ai,(r.project||'不明')+' / '+(r.task||'不明'),r.ai+' / '+(r.effort||'不明'),r.sub?'補助の AI':'主な AI'];
  groups.forEach((g,i)=>addAmounts(out[g][dims[i]] ||= {},r));
  if(r.kind==='tool')continue;
  const key=r.ai+' / '+r.run;
  addRun(out.runs,key,{id:hash(key),ai:r.ai,project:r.project,task:r.task,model:r.model,effort:r.effort,role:r.role,origin:r.origin,attribution:r.attribution,start:Math.min(r.start||r.ts,r.ts),end:Math.max(r.end||r.ts,r.ts),verified:Boolean(r.start&&r.end),bounded:Boolean(r.start),...Object.fromEntries(amounts.map(k=>[k,r[k]||0])),turns:1,lastTs:r.ts,firstTs:r.ts,firstKey:r._key});
  if(day>=from){const c={ai:r.ai,project:r.project,task:r.task,run:r.run,origin:r.origin},id=JSON.stringify(c);if(!contexts.has(id)){contexts.set(id,out.contexts.length);out.contexts.push(c);}out.events.push([contexts.get(id),r.ts,r.total,r.input,r.cache,r.unknown||0]);}
 }
 return out;
}
function collector(state,preferences={},now=Date.now()){
 const out=empty(),today=localDay(now),from=cutoff(now,60),daily={},turns=[],beforeRuns={};
 return {add(part){
  for(const g of groups)for(const [k,r]of Object.entries(part[g]))addAmounts(out[g][k] ||= {},r);
  for(const [k,r]of Object.entries(part.runs))addRun(out.runs,k,r);
  for(const [k,v]of Object.entries(part.forks))out.forks[k]=(out.forks[k]||0)+v;
  for(const [i,ts,total,input,cache,unknown]of part.events){const day=localDay(ts);if(day<from||day>today)continue;const c=part.contexts[i],key=c.ai+' / '+day,b=daily[key] ||= {ai:c.ai,day,total:0,lastTs:0,before:0,work:{}};b.total+=total;b.lastTs=Math.max(b.lastTs,ts);if(ts<=state.monitorStartedAt){b.before+=total;const id=hash(c.ai+' / '+c.run);beforeRuns[id]=(beforeRuns[id]||0)+total;}const work=[c.project,c.task].filter(Boolean).join(' / ');if(work)b.work[work]=(b.work[work]||0)+total;
   turns.push({ai:c.ai,day,ts,total,input,cache,unknown,project:c.project,task:c.task,run:c.origin==='Hub（確認済み）'?c.run:''});}
 },finish(){
  const allRuns=Object.values(out.runs);for(const r of allRuns){r.ms=r.end-r.start;delete r.firstTs;delete r.firstKey;}
  // Stable tie order is explicit so persisted shard order cannot change a top
  // entry or a grouped alert when totals and times happen to be identical.
  allRuns.sort((a,b)=>a.id.localeCompare(b.id));turns.sort((a,b)=>a.ts-b.ts||a.ai.localeCompare(b.ai)||a.total-b.total);
  const f={today,daily:Object.values(daily),turns,runs:allRuns.filter(r=>localDay(r.end)>=from&&localDay(r.end)<=today).map(r=>({...r,before:beforeRuns[r.id]||0}))};
  const alerts=require('./token-usage-alerts').evaluate(f,preferences.limits,preferences.acknowledged,{startedAt:state.monitorStartedAt||now});
  const days=Object.keys(out.daily).sort();let streak=0,best=0,prev='';for(const day of days){if(!out.daily[day].total)continue;const d=new Date(day+'T12:00:00');d.setDate(d.getDate()-1);streak=localDay(d)===prev?streak+1:1;best=Math.max(best,streak);prev=day;}
  const yesterday=new Date(today+'T12:00:00');yesterday.setDate(yesterday.getDate()-1);
  const {runs,forks,...dims}=out;
  return {...dims,...require('./token-usage-alerts').summarize(alerts),preferencesRevision:preferences.revision||0,version:1,updated:Date.now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,runs:allRuns.sort((a,b)=>b.total-a.total||a.id.localeCompare(b.id)).slice(0,50),longest:allRuns.reduce((a,b)=>!a||b.ms>a.ms?b:a,null),total:Object.values(out.daily).reduce((s,r)=>s+r.total,0),peak:Math.max(0,...Object.values(out.daily).map(r=>r.total)),streak:best,currentStreak:prev===today||prev===localDay(yesterday)?streak:0,monitorStartedAt:state.monitorStartedAt,coverage:{...state.coverage,forks}};
 }};
}
module.exports={build,collector};
