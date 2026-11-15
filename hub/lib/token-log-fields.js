'use strict';
// Streaming projection: unselected string values (conversation/tool/auth payloads)
// are skipped as bytes, never decoded, materialised as lines, or retained.
const NUM={input_tokens:1,cached_input_tokens:1,output_tokens:1,reasoning_output_tokens:1,total_tokens:1,cache_read_input_tokens:1,cache_creation_input_tokens:1};
const SCHEMA={type:1,timestamp:1,sessionId:1,session_id:1,requestId:1,cwd:1,entrypoint:1,isSidechain:1,
 message:{id:1,model:1,usage:NUM,content:{$items:{type:1,id:1}}},payload:{id:1,call_id:1,cwd:1,originator:1,forked_from_id:1,type:1,model:1,effort:1,reasoning_effort:1,source:{$scalar:true,subagent:{thread_spawn:{parent_thread_id:1}}},
 info:{total_token_usage:NUM,last_token_usage:NUM}},
 // Hub spool provenance: no prompt, environment, CLI arguments or rows.
 options:{ai:1,project:1,task:1,dir:1,effort:1,account:1,started:1,role:1,model:1},
 thread_id:1,id:1};
class Projection {
 constructor(emit,schema=SCHEMA,whole=false){this.emit=emit;this.schema=schema;this.whole=whole;this.reset();this.bad=0;}
 reset(){this.stack=[];this.root=undefined;this.invalid=false;this.mode='';this.raw='';this.escape=false;this.keep=false;this.done=false;this.inner=null;this.unicode='';this.hexLeft=0;}
 target(){const f=this.stack.at(-1);if(!f)return this.schema;return f.array?f.schema?.$items:f.schema?.[f.key];}
 put(value){const f=this.stack.at(-1);if(!f){if(this.done)this.invalid=true;this.root=value;this.done=true;}else{if(f.state!=='value')this.invalid=true;if(f.out){if(f.array)f.out.push(value);else if(f.key&&f.schema?.[f.key])f.out[f.key]=value;}f.state='comma';f.empty=false;f.afterComma=false;}}
 scalar(){if(this.keep){try{const v=JSON.parse(Buffer.from(this.raw,'latin1').toString('utf8'));if(typeof v==='string'&&v.length>1024)throw Error();this.put(v);}catch{this.invalid=true;this.put(undefined);}}else {if(this.mode==='number'&&!/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(this.raw))this.invalid=true;this.put(undefined);}this.raw='';this.mode='';}
 byte(c){
  if(c===10&&this.whole&&!this.mode)return;
  if(c===10){if(this.mode==='number')this.scalar();if(this.stack.length||this.mode)this.invalid=true;if(this.root&&!this.invalid)this.emit(this.root);else if(this.invalid)this.bad++;this.reset();return;}
  if(this.mode==='string'){
   if(this.inner){
    if(this.unicode){this.unicode+=String.fromCharCode(c);if(this.unicode.length===5){const hex=this.unicode.slice(1);if(!/^[0-9a-f]{4}$/i.test(hex))this.invalid=true;else this.inner.write(Buffer.from(String.fromCharCode(parseInt(hex,16))));this.unicode='';}return;}
    if(this.escape){this.escape=false;if(c===117)this.unicode='u';else{const map={34:34,92:92,47:47,98:8,102:12,110:10,114:13,116:9};if(map[c]===undefined)this.invalid=true;else this.inner.byte(map[c]);}return;}
    if(c===92){this.escape=true;return;}if(c===34){this.inner.finish();if(this.inner.bad)this.invalid=true;this.inner=null;this.mode='';this.put(this.innerValue);this.innerValue=undefined;return;}this.inner.byte(c);return;
   }
   if(this.keep&&this.raw.length<8192)this.raw+=String.fromCharCode(c);else if(this.keep){this.invalid=true;this.keep=false;this.raw='';}
   if(c<32)this.invalid=true;if(this.hexLeft){if(!/[0-9a-f]/i.test(String.fromCharCode(c)))this.invalid=true;this.hexLeft--;return;}if(this.escape){this.escape=false;if(c===117)this.hexLeft=4;else if(![34,92,47,98,102,110,114,116].includes(c))this.invalid=true;return;}if(c===92){this.escape=true;return;}if(c!==34)return;
   if(this.keyMode){let key='';if(this.keep)try{key=JSON.parse(Buffer.from(this.raw,'latin1').toString('utf8'));}catch{this.invalid=true;}const f=this.stack.at(-1);f.key=key;f.state='colon';this.mode='';this.raw='';}else this.scalar();return;
  }
  if(this.mode==='number'){if(![32,9,13,44,125,93].includes(c)){if(this.raw.length<128)this.raw+=String.fromCharCode(c);else this.invalid=true;return;}this.scalar();}
  if([32,9,13].includes(c))return;
  const f=this.stack.at(-1);
  if(c===34){this.hexLeft=0;this.keyMode=Boolean(f&&!f.array&&f.state==='key');this.keep=this.keyMode||this.target()===1||this.target()?.$scalar===true;this.mode='string';if(!this.keyMode&&this.target()?.$json)this.inner=new Projection(v=>this.innerValue=v,this.target().$json,true);this.raw=this.keep?'"':'';this.escape=false;return;}
  if(c===123||c===91){const schema=this.target();const out=c===91?(schema?.$items?[]:undefined):(schema&&schema!==1&&!schema.$items?Object.create(null):undefined);this.put(out);if(this.stack.length>=64){this.invalid=true;}this.stack.push({schema,out,array:c===91,state:c===91?'value':'key',key:'',empty:true,afterComma:false});return;}
  if(c===125||c===93){const x=this.stack.pop();if(!x||x.array!==(c===93)||!(x.state==='comma'||(x.empty&&!x.afterComma&&x.state===(x.array?'value':'key'))))this.invalid=true;return;}
  if(c===58){if(!f||f.state!=='colon')this.invalid=true;else f.state='value';return;}
  if(c===44){if(!f||f.state!=='comma')this.invalid=true;else {f.state=f.array?'value':'key';f.afterComma=true;}return;}
  if(!f||f.state!=='value')this.invalid=true;this.keyMode=false;this.keep=this.target()===1;this.mode='number';this.raw=String.fromCharCode(c);
 }
 write(buffer){for(const c of buffer)this.byte(c);}
 finish(){// A complete final JSON value need not end with a newline.
  if(this.whole){if(this.mode==='number')this.scalar();if(this.stack.length||this.mode)this.invalid=true;if(this.root&&!this.invalid)this.emit(this.root);else this.bad++;}else this.byte(10);
 }
}
module.exports={Projection,SCHEMA};
