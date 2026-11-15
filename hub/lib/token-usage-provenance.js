'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Projection,SCHEMA}=require('./token-log-fields');
const {open,noLinks}=require('./token-usage-scan');
async function project(file,schema,found=()=>false){const {fd}=open(file),stream=fs.createReadStream(file,{fd,autoClose:true});let value;const parser=new Projection(v=>{value=v;},schema,true);try{for await(const chunk of stream){parser.write(chunk);if(found(value))break;}parser.finish();return value;}finally{stream.destroy();}}
// Only fixed spool paths are opened. The escaped CLI line is projected directly
// from bytes; it is never unescaped into a conversation string.
async function provenance(root,state){const rows=state.provenance ||= {};if(!root)return Object.values(rows);let entries;try{noLinks(root);entries=await fs.promises.readdir(root,{withFileTypes:true});}catch{return Object.values(rows);}
 for(const entry of entries){if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;const dir=path.join(root,entry.name);try{
  const prev=rows[entry.name];if(prev?.end&&prev.role!==undefined&&prev.model!==undefined)continue;
  const q=await project(path.join(dir,'request.json'),{options:SCHEMA.options,meta:{sessions:{codex:1,claude:1}}});const o=q?.options;if(!o||!['codex','claude'].includes(o.ai)||typeof o.project!=='string'||typeof o.task!=='string')continue;
  let sid;
  const {fd,st}=open(path.join(dir,'out.jsonl'));const signature=[st.dev,st.ino,st.size,st.mtimeMs].join(':');const missing=state.provenanceMissing ||= {};if(missing[entry.name]===signature){fs.closeSync(fd);continue;}const stream=fs.createReadStream(path.join(dir,'out.jsonl'),{fd,autoClose:true});const parser=new Projection(row=>{const r=row.line;if(r?.type==='thread.started')sid=r.thread_id;else if(r?.type==='system')sid=r.session_id;},{line:{$json:SCHEMA}});
  let bytes=0;try{for await(const chunk of stream){parser.write(chunk);bytes+=chunk.length;if(sid||bytes>=1048576)break;}}finally{stream.destroy();}
  if(typeof sid!=='string'){missing[entry.name]=signature;continue;}delete missing[entry.name];
  let end=0;try{end=(await project(path.join(dir,'finished.json'),{at:1}))?.at||0;}catch{}
  rows[entry.name]={id:entry.name,ai:o.ai,sid,project:o.project,task:o.task,effort:o.effort||'',role:o.role||'',model:o.model||'',start:Number(o.started)||0,end:Number(end)||0};
 }catch{/* Absent/incomplete or linked provenance is unknown, never guessed. */}}
 return Object.values(rows);
}
function attribute(record,proofs){const matches=proofs.filter(p=>p.ai===record.ai&&p.sid===record.sid&&p.start<=record.ts&&(!p.end||record.ts<=p.end));const proof=matches.sort((a,b)=>b.start-a.start)[0];
 const cwd=record.cwd||'';const work=cwd.match(/\/Work\/([^/]+)\/([^/]+)(?:\/|$)/),product=cwd.match(/\/Product\/([^/]+)(?:\/|$)/);
 const projectName=proof?.project||work?.[1]||product?.[1]||'',task=proof?.task||work?.[2]||'';
 const origin=proof?'Hub（確認済み）':(['vscode','claude-desktop'].includes(record.caller)||record.originator==='Codex Desktop')?'Hub 以外（確認済み）':'経由不明';
 return {...record,origin,project:projectName,task,role:proof?.role||'',effort:record.ai==='claude'?(proof?.effort||''):record.effort||'',run:proof?.id||record.sid||'',start:proof?.start,end:proof?.end,attribution:proof?'verified':projectName?'cwd':'unknown'};
}
module.exports={provenance,attribute,project};
