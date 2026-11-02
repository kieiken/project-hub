'use strict';
// Formal HTTP, persisted queue and cold server; fixture executables only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const file=require.resolve('./integration-organizer-start.test'),source=fs.readFileSync(file,'utf8'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(source.slice(0,source.indexOf("for(const state of ['完了'"))+`\nmodule.exports={post,g,chat,tick,root,tmp,runtime:()=>runtime,cold:async()=>{assert.equal(runtime.chats.running.size,0);runtime.stopControl.cleanExit();runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));delete require.cache[require.resolve('../server')];runtime=require('../server');await new Promise(r=>runtime.server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));await require('../server').restoreReady;}};`,file);
const h=m.exports,rt=()=>h.runtime(),git=require('../lib/git'),sibling=require('../lib/integration-sibling');
const wait=async fn=>{for(let n=0;n<400;n++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('fixture timeout');};
let serial=0;
async function fixture(){
 const x=rt().taskIntegrate,store=x.store,p=store.createProject({name:'Sibling-HTTP-'+(++serial)}).project,parent=store.createTask(p.id,{title:'親',steps:['未済']}),body=path.join(h.root,'Body-'+serial);
 fs.mkdirSync(body);h.g(body,'init','-q');h.g(body,'config','user.name','Fixture');h.g(body,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(body,'base'),'base');h.g(body,'add','.');h.g(body,'commit','-qm','base');
 const project=path.join(p.dir,'PROJECT.md');fs.writeFileSync(project,fs.readFileSync(project,'utf8').replace('folders:\n','folders:\n  本体: '+JSON.stringify(body)+'\n'));
 const pw=git.prepare({base:body,workRoot:x.removal.workRoot(p),taskId:parent.id});store.updateTask(p.id,parent.id,{workdir:pw.dir});
 const child=(title,report)=>{const c=store.createTask(p.id,{title,parent:parent.id,steps:['実機未確認']}),w=git.prepare({base:body,workRoot:x.removal.workRoot(p),taskId:c.id}),f=path.join(w.dir,report?'成果物/'+c.id+'/report.md':'web-code.txt');store.updateTask(p.id,c.id,{workdir:w.dir});fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,title);git.save(w.dir,'saved child');store.appendSection(p.id,c.id,'成果','- 本体保存済み：body:.@'+git.inspect(w.dir).head);store.appendSection(p.id,c.id,'残件申告','```json\n'+JSON.stringify({status:'あり',items:'実機未確認',undecided:'なし',evidence:'local fixture'})+'\n```');return store.readTask(store.taskFile(p.id,c.id));};
 const oldChild=child('Web',false),common={project:p.id,task:parent.id},post=(route,b={})=>h.post(route,{...common,...b});
 let d=await post('/api/task/integrate/preview',{simple:true});assert.equal(d.status,200,JSON.stringify(d));assert.equal((await post('/api/task/integrate',{token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:p.id,task:oldChild.id,keep:true}]})).status,200);
 const auto=rt().integrateAuto,dispatch=auto.dispatch;let request;auto.dispatch=async q=>{request=q;return {delivery:{state:'accepted'}};};try{await h.tick.call(auto);}finally{auto.dispatch=dispatch;}
 const old=x.read(p.id,parent.id);assert.equal(old.items[0].state,'検証中',JSON.stringify(old.auto.stopped));assert.ok(request);const key=request.review.key;
 old.auto.stopped={reason:'独立確認の合格を確認できません',at:'2026-10-19T20:35:16.600Z'};x.save(old);h.chat.append(p.dir,parent.id,{role:'assistant',request:request.requestKey,text:'合格なし',integrationAuto:{key,phase:'review',closed:true,isolation:{version:1,resumed:false,request:request.requestKey}}});
 const bytes=fs.readFileSync(x.file(p.id,parent.id)),offer=fs.readFileSync(x.transfer.file(p.id,oldChild.id)),oldTask=fs.readFileSync(store.taskFile(p.id,oldChild.id)),report=child('Windows報告',true);
 d=await post('/api/task/integrate/preview',{simple:true});assert.equal(d.out.siblingOption.allowed,true,JSON.stringify(d));
 d=await post('/api/task/integrate/preview',{simple:true,sibling:true});assert.equal(d.status,200,JSON.stringify(d));assert.equal(d.out.items.find(i=>i.task===report.id).startable,true,JSON.stringify(d));assert.equal((await post('/api/task/integrate',{token:d.out.token,confirm:true,auto:true,thenMain:false,mode:'single',selected:[{project:p.id,task:report.id,keep:true}]})).status,200);
 return {p,parent,oldChild,report,common,post,lane:()=>sibling.read(rt().taskIntegrate,p.id,parent.id),unchanged:()=>{const x=rt().taskIntegrate;assert.deepEqual(fs.readFileSync(x.file(p.id,parent.id)),bytes);assert.deepEqual(fs.readFileSync(x.transfer.file(p.id,oldChild.id)),offer);assert.deepEqual(fs.readFileSync(x.store.taskFile(p.id,oldChild.id)),oldTask);}};
}
test('formal sibling HTTP dispatch reviews new delta and completes kept receipt after cold restart',async()=>{
 const f=await fixture();await h.tick.call(rt().integrateAuto);await wait(()=>Object.values(f.lane().auto.attempts).some(a=>a.phase==='verified')||f.lane().auto.stopped);assert.equal(f.lane().auto.stopped,undefined,JSON.stringify(f.lane().auto.stopped));await wait(()=>!rt().chats.busy(f.p.id,f.parent.id));
 await h.cold();for(let n=0;n<3&&!f.lane().complete;n++)await h.tick.call(rt().integrateAuto);const r=f.lane();assert.equal(r.complete,true,JSON.stringify(r.auto.stopped));assert.equal(r.auto.main.skipped,true);assert.equal(rt().taskIntegrate.transfer.read(f.p.id,f.report.id).retained,true);assert.ok(fs.existsSync(f.report.workdir));f.unchanged();
});
test('cold queued sibling request cannot become ordinary chat by removing its markers',async()=>{
 const f=await fixture(),auto=rt().integrateAuto,dispatch=auto.dispatch;let blocker;
 // Competing ordinary request arrives after integration admission, before delivery.
 auto.dispatch=async request=>{blocker=rt().chats.enqueue(f.p.id,f.parent.id,{ai:'codex',model:'GPT-6.1-Sol',text:'fixture blocker'});return dispatch(request);};
 try{await h.tick.call(auto);}finally{auto.dispatch=dispatch;if(blocker)rt().chats.unqueue(f.p.id,f.parent.id,blocker.id);}
 const q=rt().chats.queue(f.p.id,f.parent.id);assert.equal(q.length,1,JSON.stringify(f.lane().auto.stopped));const original=q[0];assert.equal(original.isolatedReview,true);
 rt().chats.setQueue(f.p.id,f.parent.id,q.map(row=>({...row,text:'ordinary chat',shown:'ordinary chat',isolatedReview:false,readOnly:false,integrationReviewRequest:undefined})),true);
 await h.cold();const before=h.chat.read(f.p.dir,f.parent.id).filter(x=>x.role==='user').length,rows=rt().chats.queue(f.p.id,f.parent.id),out=await f.post('/api/chat/send',{fromQueue:original.id,expectedText:rows[0].text});assert.equal(out.status,409,JSON.stringify(out));assert.equal(h.chat.read(f.p.dir,f.parent.id).filter(x=>x.role==='user').length,before);assert.equal(rt().taskIntegrate.transfer.read(f.p.id,f.report.id)?.complete,undefined);f.unchanged();
});
