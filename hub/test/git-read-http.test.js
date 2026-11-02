'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-git-http-')),root=path.join(tmp,'root');
Object.assign(process.env,{HUB_ROOT:root,HUB_FREETALK_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_TRASH:path.join(tmp,'Trash'),HUB_PORT:String(55000+Math.floor(Math.random()*1000))});
const git=require('../lib/git'),{Store}=require('../lib/store'),runtime=require('../server'),store=new Store(root);
const nativeGit=execFileSync('/usr/bin/which',['git'],{encoding:'utf8'}).trim();
let base;
test.before(async()=>{await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+runtime.server.address().port;});
test.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){
 const p=store.createProject({name:'Async read'}).project,body=path.join(tmp,'body');fs.mkdirSync(body);
 const pf=path.join(p.dir,'PROJECT.md');fs.writeFileSync(pf,fs.readFileSync(pf,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));
 fs.writeFileSync(path.join(body,'base'),'base');const sh=(...a)=>execFileSync(nativeGit,['-C',body,...a],{stdio:'pipe'});for(const a of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@localhost'],['add','.'],['commit','-qm','base']])sh(...a);
 const t=store.createTask(p.id,{title:'parent',steps:['remaining']}),w=git.prepare({base:body,workRoot:path.join(root,'Work',p.id),taskId:t.id});store.updateTask(p.id,t.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'saved'),'saved');git.save(w.dir,'saved');return {project:p.id,task:t.id};
}
async function quick(b){
 const start=performance.now(),ping=await fetch(base+'/api/ping');await ping.text();const pingMs=performance.now()-start;
 const abort=new AbortController(),at=performance.now();try{const response=await fetch(base+'/api/chat/stream?'+new URLSearchParams(b),{signal:abort.signal}),reader=response.body.getReader();let text='';while(!text.includes('"type":"rows"')){const row=await reader.read();assert.equal(row.done,false);text+=new TextDecoder().decode(row.value);}const rowsMs=performance.now()-at;assert.ok(pingMs<100,'ping '+pingMs+'ms');assert.ok(rowsMs<100,'first rows '+rowsMs+'ms');return {pingMs,rowsMs};}finally{abort.abort();}
}
test('slow Git in actual merge/integration HTTP previews leaves ping and first conversation rows below 100ms',async()=>{
 const b=fixture(),bin=path.join(tmp,'bin'),marker=path.join(tmp,'calls');fs.mkdirSync(bin);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nprintf x >> '+quote(marker)+'\nsleep 0.12\nexec '+quote(nativeGit)+' "$@"\n',{mode:0o700});
 const previous=process.env.PATH;process.env.PATH=bin+path.delimiter+previous;
 try{
  for(const route of ['/api/task/merge/preview','/api/task/integrate/preview']){
   fs.writeFileSync(marker,'');let done=false;
   const pending=fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...b,simple:true})}).then(async r=>({status:r.status,data:await r.json()})).finally(()=>{done=true;});
   try{for(let n=0;!fs.statSync(marker).size&&n<100;n++)await pause(10);assert.ok(fs.statSync(marker).size,'real Git subprocess started');
    for(let n=0;n<3;n++){const result=await quick(b);console.log(JSON.stringify({route,...result}));assert.equal(done,false,'probe overlaps pending Git');}
    const wait=await fetch(base+'/api/task/integrate/wait?'+new URLSearchParams(b));assert.equal(wait.status,200);
   }finally{const result=await pending;assert.equal(result.status,200,JSON.stringify(result.data));}
  }
 }finally{process.env.PATH=previous;}
});
