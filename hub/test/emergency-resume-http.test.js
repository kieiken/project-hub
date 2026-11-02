'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-resume-http-')),root=path.join(tmp,'root'),dir=path.join(root,'Product/Fixture'),key={project:'Fixture',task:'chat'},pause=ms=>new Promise(r=>setTimeout(r,ms));
let hub,base;
const post=async(route,body={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify({...key,...body})});return {status:r.status,body:await r.json()};};
const send=body=>post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'fixture manual',...body});
async function wait(fn){for(let n=0;n<300;n++){if(await fn())return;await pause(20);}assert.fail('fixture timed out');}
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 for(const task of ['chat','other'])fs.writeFileSync(path.join(dir,'.ai/tasks',task+'.md'),`---\nid: ${task}\ntitle: ${task}\nowner: codex\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] fixture\n`);
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(path.join(tmp,'launches'))},'1');console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),100);});`,{mode:0o755});
 Object.assign(process.env,{PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_FREETALK_HOME:path.join(tmp,'ft'),HUB_TRASH:path.join(tmp,'trash')});
 hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(0,'127.0.0.1',r));const port=hub.server.address().port;hub.stopControl.cleanExit();await new Promise(r=>hub.server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];hub=require('../server');await hub.restoreReady;await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
});
test.after(async()=>{await new Promise(r=>hub.server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('HTTP valid new send resumes only stopped chat; rejects old modes, bad input and stale sends; keeps old queue after completion',async()=>{
 hub.chats.setQueue(key.project,key.task,[{id:'old',ai:'codex',model:'gpt-6.1-sol',text:'old waiting instruction'}],true);
 assert.equal((await post('/api/chat/stop')).status,200);await post('/api/chat/stop',{task:'other'});const manualStopTicket=hub.stopControl.ticket(key);
 for(const payload of [{text:''},{model:'invalid-fixture'},{mode:'amend'},{mode:'redo'},{mode:'queue'},{fromQueue:'old'},{}]){const r=await send({...payload,...(Object.keys(payload).length?{manualStopTicket}:{})});assert.notEqual(r.status,200,JSON.stringify(payload));assert.equal(hub.stopControl.data.tasks[JSON.stringify([key.project,key.task])].held,true);}
 const r=await send({manualStopTicket});assert.equal(r.status,200,JSON.stringify(r));await wait(()=>!hub.chats.busy(key.project,key.task));await pause(200);
 assert.equal(fs.readFileSync(path.join(tmp,'launches'),'utf8'),'1');assert.deepEqual(hub.chats.queue(key.project,key.task).map(q=>[q.id,q.text,q.stopHeld]),[['old','old waiting instruction',true]]);assert.ok(hub.stopControl.held({...key,task:'other'}));assert.equal(hub.stopControl.data.all,false);assert.equal(hub.restartControl.executions,0);
 assert.equal((await send({manualStopTicket})).status,409);const delegate=await post('/api/delegate',{ai:'codex',model:'gpt-6.1-sol',text:'old automation',title:'fixture'});assert.equal(delegate.status,403);assert.match(delegate.body.error,/保留/);
 assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,200);await wait(()=>!hub.chats.busy(key.project,key.task));await pause(120);assert.equal(fs.readFileSync(path.join(tmp,'launches'),'utf8'),'11');assert.equal(hub.chats.queue(key.project,key.task).length,1);
});
test('HTTP simultaneous new sends admit one turn, and global stop cannot be manually resumed',async()=>{
 const ticket=hub.stopControl.ticket(key),responses=await Promise.all([send({manualStopTicket:ticket}),send({manualStopTicket:ticket})]);assert.equal(responses.filter(r=>r.status===200).length,1,JSON.stringify(responses));await wait(()=>!hub.chats.busy(key.project,key.task));
 hub.stopControl.pause();assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);assert.equal(hub.restartControl.executions,0);
});
test('normal clean exit is safe without owned AI; unknown saved results retain boot protection',async()=>{
 hub.stopControl.setResults([]);assert.equal(await hub.chats.withStrictHandoff(()=>hub.safeShutdown()),true);hub.stopControl.setResults([{...key,state:'exited',save:'unconfirmed'}]);assert.equal(await hub.chats.withStrictHandoff(()=>hub.safeShutdown()),false);hub.stopControl.setResults([]);
});
