'use strict';
// Bounded metadata-only migration of an existing checkpoint. Forks also need
// the first numeric usage counters; conversation values are never decoded.
const fs=require('node:fs'),zlib=require('node:zlib');
const {Projection,SCHEMA}=require('./token-log-fields');
const short=v=>typeof v==='string'&&v.length<=64&&!/[\x00-\x1f]/.test(v)?v:'';
const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function counters(u){if(!u)return null;const a={total:number(u.total_tokens),input:number(u.input_tokens),cache:number(u.cached_input_tokens),output:number(u.output_tokens),write:0};if(Object.values(a).some(v=>v===null)||a.cache>a.input)return null;a.input-=a.cache;return a;}
function firstUsage(row){if(row.type!=='event_msg'||row.payload?.type!=='token_count')return null;const info=row.payload.info,total=counters(info?.total_token_usage),last=counters(info?.last_token_usage);return total&&last?{total,last}:null;}
async function metadata(file){const {open}=require('./token-usage-scan');const {fd}=open(file),stream=fs.createReadStream(file,{fd,autoClose:true});let input=stream,found=null,usageSeen=false;
 if(file.endsWith('.zst')){if(typeof zlib.createZstdDecompress!=='function'){stream.destroy();return null;}const decoder=zlib.createZstdDecompress();stream.on('error',e=>decoder.destroy(e));input=stream.pipe(decoder);}
 const parser=new Projection(r=>{if(!found&&r.type==='session_meta'&&typeof r.payload?.id==='string')found={sid:r.payload.id,originator:short(r.payload.originator),fork:r.payload.forked_from_id||'',forkAt:Date.parse(r.timestamp)||0};if(found?.fork&&!usageSeen&&r.type==='event_msg'&&r.payload?.type==='token_count'){found.firstUsage=firstUsage(r);usageSeen=true;}},{type:1,timestamp:1,payload:{id:1,originator:1,forked_from_id:1,type:1,info:SCHEMA.payload.info}});let bytes=0;
 try{for await(const chunk of input){parser.write(chunk);bytes+=chunk.length;if(found&&(!found.fork||usageSeen)||bytes>=(found?.fork?134217728:262144))break;}return found;}finally{input.destroy();stream.destroy();}
}
module.exports={metadata,short,firstUsage};
