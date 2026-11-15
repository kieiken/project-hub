'use strict';
// Records remain globally keyed for deduplication; persistence is partitioned by
// logical source conversation. File checkpoints and provenance use small buckets.
const fs=require('node:fs'),path=require('node:path');
const {open,noLinks,hash}=require('./token-usage-scan');
const json=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const GROUPS=['records','files','provenance','provenanceMissing','sessions'];
function read(file){try{const {fd}=open(file);try{return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function atomic(file,raw,stats){noLinks(path.dirname(file));if(fs.existsSync(file))noLinks(file);const tmp=file+'.'+process.pid+'.tmp',fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);stats.bytes+=Buffer.byteLength(raw);stats.files++;}
function load(dir){const manifest=read(path.join(dir,'manifest.json'));if(!manifest){const state=read(path.join(dir,'index.json'));if(state&&state.version!==1)throw Error('version');return {state,manifest:null};}if(manifest.version!==2)throw Error('version');const state={...manifest.properties};for(const group of GROUPS){state[group]={};for(const [key,digest]of Object.entries(manifest.partitions[group]||{})){if(!/^[a-f0-9]{2}(?:[a-f0-9]{62})?$/.test(key)||!/^[a-f0-9]{64}$/.test(digest))throw Error('partition');const rows=read(path.join(dir,group+'-'+key+'.json'));if(!rows)throw Error('missing partition');for(const [id,row]of Object.entries(rows)){const old=state[group][id];if(group!=='records'||!old||row.total>old.total)state[group][id]=row;}}}return {state,manifest};}
function persist(dir,state,snapshot,previous){const stats={bytes:0,files:0},manifest={version:2,properties:{},partitions:{}};for(const [key,value]of Object.entries(state))if(!GROUPS.includes(key))manifest.properties[key]=value;
 for(const group of GROUPS){const buckets={};for(const [key,row]of Object.entries(state[group]||{})){const bucket=group==='records'?hash(row.ai+'\0'+(row.sid||key)):hash(key).slice(0,2);(buckets[bucket] ||= {})[key]=row;}manifest.partitions[group]={};for(const [bucket,rows]of Object.entries(buckets)){const raw=json(rows),digest=hash(raw);manifest.partitions[group][bucket]=digest;if(previous?.partitions[group]?.[bucket]!==digest)atomic(path.join(dir,group+'-'+bucket+'.json'),raw,stats);}}
 const raw=json(manifest);if(!previous||json(previous)!==raw)atomic(path.join(dir,'manifest.json'),raw,stats);
 const before=read(path.join(dir,'summary.json'));const comparable=s=>{if(!s)return '';const {updated,...rest}=s;return json(rest);};if(comparable(before)!==comparable(snapshot))atomic(path.join(dir,'summary.json'),json(snapshot),stats);else snapshot.updated=before.updated;
 return stats;
}
module.exports={load,persist,read,json,atomic,GROUPS};
