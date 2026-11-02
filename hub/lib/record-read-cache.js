'use strict';
// Cache only unchanged record contents. Directory enumeration and link checks
// remain live, including callers outside the display scope and mutation guards.
const fs=require('./platform/file-io'),path=require('node:path');
const {noLink}=require('./remove');
class RecordReadCache {
 constructor(build){this.build=build;this.entries=new Map();this.bytes=0;}
 read(file,{regular=false}={}){
  try{
   const st=noLink(file);
   if(!st){this.invalidate(file);return null;}
   if(regular&&(!st.isFile()||st.nlink!==1))throw Error('終了記録にリンク・不明な種類があります');
   const stamp=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.mode,st.nlink].join(':');
   const old=this.entries.get(file);if(old?.stamp===stamp)return old.value;
   const bytes=fs.readFileSync(file),value=this.build(bytes);
   this.invalidate(file);
   // Bound retained memory by record count and individual input size. Large
   // records still work; they simply do not become long-lived cache entries.
   if(st.size<=8*1024*1024){while(this.entries.size>=256||this.bytes+st.size>16*1024*1024)this.invalidate(this.entries.keys().next().value);this.entries.set(file,{stamp,value,size:st.size});this.bytes+=st.size;}
   return value;
  }catch(e){this.invalidate(file);throw e;}
 }
 invalidate(file){this.bytes-=this.entries.get(file)?.size||0;this.entries.delete(file);}
 clear(){this.entries.clear();this.bytes=0;}
 prune(dir,names){const live=new Set(names.map(n=>path.join(dir,n)));for(const f of this.entries.keys())if(path.dirname(f)===dir&&!live.has(f))this.invalidate(f);}
}
module.exports={RecordReadCache};
