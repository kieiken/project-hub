'use strict';
const crypto=require('node:crypto');
const {localDay}=require('./token-usage-scan');
const id=(...parts)=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const median=xs=>{const a=xs.slice().sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length?(a.length%2?a[m]:(a[m-1]+a[m])/2):0;};
const quantile=(xs,p)=>{const a=xs.slice().sort((a,b)=>a-b);return a[Math.max(0,Math.ceil(a.length*p)-1)]||0;};
const dayBefore=(day,n)=>{const d=new Date(day+'T12:00:00');d.setDate(d.getDate()-n);return localDay(d);};
const FLOOR=1000000;
function facts(records,runs,now=Date.now(),startedAt=0){
 const beforeRuns=new Map();
 const today=localDay(now),from=dayBefore(today,60),daily={},turns=[];
 for(const r of records){const day=localDay(r.ts);if(day<from||day>today)continue;const key=r.ai+' / '+day,b=daily[key] ||= {ai:r.ai,day,total:0,lastTs:0,before:0,work:{}};b.total+=r.total;if(r.ts<=startedAt){b.before+=r.total;const key=crypto.createHash('sha256').update(r.ai+' / '+r.run).digest('hex');beforeRuns.set(key,(beforeRuns.get(key)||0)+r.total);}b.lastTs=Math.max(b.lastTs,r.ts);const work=[r.project,r.task].filter(Boolean).join(' / ');if(work)b.work[work]=(b.work[work]||0)+r.total;
 turns.push({ai:r.ai,day,ts:r.ts,total:r.total,input:r.input,cache:r.cache,unknown:r.unknown||0,project:r.project,task:r.task,run:r.origin==='Hub（確認済み）'?r.run:''});}
 return {today,daily:Object.values(daily),runs:runs.filter(r=>localDay(r.end)>=from&&localDay(r.end)<=today).map(r=>({...r,before:beforeRuns.get(r.id)||0})),turns};
}
function evaluate(f,limits={},acknowledged={},options={}){
 if(!f)return [];const alerts=[],today=f.today,oldest=dayBefore(today,30);
 const add=(kind,ai,key,total,threshold,extra={})=>{const keyId=id(kind,ai,key);alerts.push({id:keyId,kind,ai,total,threshold,...extra,historical:(extra.at||0)<=(options.startedAt||0)||(extra.before>threshold&&total-extra.before<=threshold),acknowledged:total<=(acknowledged[keyId]?.through||0)*1.25});};
 const histories=new Map();const history=(ai,day)=>{const key=ai+' / '+day;if(!histories.has(key))histories.set(key,f.daily.filter(d=>d.ai===ai&&d.day<day&&d.day>=dayBefore(day,30)&&d.total>0).map(d=>d.total));return histories.get(key);};
 for(const d of f.daily){if(d.day<oldest)continue;const hist=history(d.ai,d.day),work=Object.entries(d.work).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,total])=>({name,total}));if(hist.length>=7){const threshold=Math.max(FLOOR,median(hist)*3);if(d.total>threshold)add('daily',d.ai,d.day,d.total,threshold,{day:d.day,work,before:d.before,at:d.lastTs});}const limit=limits[d.ai]?.daily;if(d.day===today&&limit&&d.total>limit)add('daily-limit',d.ai,d.day,d.total,limit,{day:d.day,work,before:d.before,at:d.lastTs});}
 const runs=f.runs.slice().sort((a,b)=>a.start-b.start),responses=f.turns.filter(r=>!r.run).map(r=>({...r,start:r.ts,end:r.ts,lastTs:r.ts,id:id(r.ai,r.ts,r.total),bounded:true,response:true}));
 const units=[...runs.filter(r=>r.bounded),...responses].map(r=>({...r,day:localDay(r.end)})),peerCache=new Map();
 for(const r of units){const day=localDay(r.end),hist=history(r.ai,day);if(day<oldest)continue;const peerKey=r.ai+' / '+Boolean(r.response)+' / '+day;if(!peerCache.has(peerKey)){const from=dayBefore(day,30),prior=units.filter(x=>x.ai===r.ai&&Boolean(x.response)===Boolean(r.response)&&x.day<day&&x.day>=from).map(x=>x.total);peerCache.set(peerKey,{count:prior.length,threshold:Math.max(FLOOR,median(hist)*.5,quantile(prior,.99)*3)});}const peers=peerCache.get(peerKey);if(hist.length>=7&&peers.count>=20&&r.total>peers.threshold)add('run',r.ai,r.id,r.total,peers.threshold,{day,project:r.project,task:r.task,before:r.before,at:r.lastTs||r.end});const limit=limits[r.ai]?.run;if(day===today&&limit&&r.total>limit)add('run-limit',r.ai,r.id,r.total,limit,{day,project:r.project,task:r.task,before:r.before,at:r.lastTs||r.end});}
 // A chain must stay in the same role/model/AI. Any other role in the task
 // breaks it, including a check or commander turn performed by another AI.
 const recent=new Map();for(const r of runs.filter(r=>r.bounded&&r.project&&r.task&&localDay(r.start)>=oldest&&localDay(r.start)<=today)){
  const key=r.project+' / '+r.task,signature=[r.ai,r.role,r.model].join('/');let a=(recent.get(key)||[]).filter(x=>x.start>=r.start-15*60000);if(!r.role||!r.model||a.at(-1)?.signature!==signature)a=[];a.push({...r,signature});recent.set(key,a);const hist=history(r.ai,localDay(r.start));if(a.length>=5&&hist.length>=7){const total=a.reduce((s,x)=>s+x.total,0),threshold=Math.max(FLOOR,median(hist)*.5);if(total>threshold)add('repeat',r.ai,r.id,total,threshold,{day:localDay(r.start),project:r.project,task:r.task,count:a.length,before:a.reduce((s,x)=>s+(x.before||0),0),at:r.lastTs||r.end});}}
 for(const r of f.turns){const hist=history(r.ai,r.day);if(r.day<oldest||r.unknown||r.input+r.cache<Math.max(FLOOR,median(hist)*.25)||hist.length<7)continue;const ratio=r.cache/(r.input+r.cache);if(ratio<.2)add('cache',r.ai,[r.ts,r.total,r.project,r.task],r.total,.2,{day:r.day,project:r.project,task:r.task,cacheRatio:ratio,at:r.ts});}
 // One automatic signal per AI/kind/day is enough to investigate a busy day.
 // Preserve individual custom-limit breaches because the owner chose those limits.
 const grouped=new Map();for(const a of alerts){const key=a.kind.endsWith('-limit')?a.id:[a.kind,a.ai,a.day,a.historical].join('/');const prev=grouped.get(key);if(!prev||a.total>prev.total)grouped.set(key,a);}
 return [...grouped.values()].sort((a,b)=>b.day.localeCompare(a.day)||b.total-a.total);
}
// Keep the full acknowledgement targets even when the display list is capped.
function summarize(alerts){return {alerts:alerts.slice().sort((a,b)=>Number(a.historical)-Number(b.historical)||Number(a.acknowledged)-Number(b.acknowledged)).slice(0,300),unacknowledgedAlerts:alerts.filter(a=>!a.acknowledged).map(({id,total})=>({id,total})),alertCount:alerts.filter(a=>!a.acknowledged&&!a.historical).length,alertTotal:alerts.length,historicalAlertCount:alerts.filter(a=>a.historical).length};}
module.exports={facts,evaluate,summarize,median,quantile,FLOOR};
