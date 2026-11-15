'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-resume-http-'))),root=path.join(tmp,'root'),dir=path.join(root,'Product/Fixture'),key={project:'Fixture',task:'chat'},pause=ms=>new Promise(r=>setTimeout(r,ms));
let hub,base;
const post=async(route,body={},callerHeaders={})=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close',...callerHeaders},body:JSON.stringify({...key,...body})});return {status:r.status,body:await r.json()};};
const send=body=>post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'fixture manual',...body});
async function wait(fn){for(let n=0;n<300;n++){if(await fn())return;await pause(20);}assert.fail('fixture timed out');}
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 for(const task of ['chat','other'])fs.writeFileSync(path.join(dir,'.ai/tasks',task+'.md'),`---\nid: ${task}\ntitle: ${task}\nowner: codex\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] fixture\n`);
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const fs=require('fs'),p=${JSON.stringify(tmp)};fs.appendFileSync(p+'/launches','1');const n=fs.readFileSync(p+'/launches','utf8').length;fs.writeFileSync(p+'/active-'+n,process.env.HUB_HEADERS);console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));setTimeout(()=>{const timer=setInterval(()=>{if(fs.existsSync(p+'/hold-'+n))return;clearInterval(timer);console.log(JSON.stringify({type:'turn.completed'}));},20);},100);});`,{mode:0o755});
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
 assert.equal((await send({manualStopTicket})).status,409);const delegate=await post('/api/delegate',{ai:'codex',model:'gpt-6.1-sol',text:'old automation',title:'fixture'});assert.equal(delegate.status,403);assert.match(delegate.body.error,/設定の［復旧］/);
 assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,200);await wait(()=>!hub.chats.busy(key.project,key.task));await pause(120);assert.equal(fs.readFileSync(path.join(tmp,'launches'),'utf8'),'11');assert.equal(hub.chats.queue(key.project,key.task).length,1);
});


const launches=()=>fs.existsSync(path.join(tmp,'launches'))?fs.readFileSync(path.join(tmp,'launches'),'utf8').length:0;
function holdNext(){const n=launches()+1;fs.writeFileSync(path.join(tmp,'hold-'+n),'');return n;}
const release=n=>fs.unlinkSync(path.join(tmp,'hold-'+n));
async function callerFor(n,verify=true){
 await wait(()=>fs.existsSync(path.join(tmp,'active-'+n)));
 const file=fs.readFileSync(path.join(tmp,'active-'+n),'utf8');
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 const headers=Object.fromEntries(fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>{const i=line.indexOf(':');return [line.slice(0,i),line.slice(i+1).trim()];}));
 if(verify){assert.ok(headers['X-Hub-Delegate-Turn']);
  const saved=fs.readFileSync(path.join(path.dirname(file),'request.json'),'utf8');assert.equal(saved.includes(headers['X-Hub-Delegate-Turn']),false);}
 return headers;
}
const delegate=(headers={},extra={})=>post('/api/delegate',{ai:'codex',model:'gpt-6.1-sol',text:'fixture new delegate',title:'fixture',...extra},headers);
async function startHeldManual(verify=true){
 await post('/api/chat/stop');const n=holdNext();
 assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,200);
 return {n,headers:await callerFor(n,verify)};
}
test('HTTP manual turn delegates and chains launch after queue wait, leaving pre-stop instructions held',async()=>{
 const U=require('../lib/idea-utils');hub.ideas.initialize(key.project,U.uuid());const d=hub.ideas.read(key.project);
 hub.ideas.settings(key.project,{opId:U.uuid(),settingsRev:d.settings.rev},x=>{x.settings.lane={task:key.task};x.settings.auto.enabled=true;});
 const root=await startHeldManual(),run=hub.chats.busy(key.project,key.task);
 for(const headers of [{},{'X-Hub-Delegate-Turn':'unknown'}]){
  const r=await delegate(headers,{stopTicket:run.options.stopTicket,manualStopTicket:run.options.stopTicket});assert.equal(r.status,403);assert.match(r.body.error,/設定の［復旧］/);
 }
 assert.equal((await delegate(root.headers,{task:'other'})).status,403);
 // The same caller header cannot release a terminal or an old waiting instruction.
 assert.throws(()=>hub.sessions.start({...key,ai:'codex'}),/設定の［復旧］/);
 const old=hub.chats.queue(key.project,key.task).find(q=>q.id==='old');assert.equal(old.stopHeld,true);
 const waiting=await post('/api/chat/send',{...old,fromQueue:old.id},root.headers);assert.equal(waiting.status,409);assert.match(waiting.body.error,/設定の［復旧］/);
 const child=holdNext(),r=await delegate(root.headers);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.queued,true);
 assert.equal(launches(),root.n);assert.equal(hub.chats.queue(key.project,key.task).find(q=>q.id===r.body.id).stopTicket.manual,true);
 release(root.n);const childHeaders=await callerFor(child);
 assert.equal((await delegate(root.headers)).status,403); // Completed source cannot impersonate its successor.
 const grandchild=holdNext(),next=await delegate(childHeaders);assert.equal(next.status,200,JSON.stringify(next));release(child);await callerFor(grandchild);release(grandchild);
 await wait(()=>!hub.chats.busy(key.project,key.task));await pause(150);
 assert.equal(launches(),grandchild);assert.deepEqual(hub.chats.queue(key.project,key.task).map(q=>[q.id,q.stopHeld]),[['old',true]]);
 assert.equal(hub.stopControl.held(key),true);assert.equal((await delegate(childHeaders)).status,403);
 const after=hub.ideas.read(key.project);assert.equal(after.settings.auto.enabled,false);assert.equal(after.settings.manualPaused,true);assert.equal(after.settings.auto.generation,d.settings.auto.generation+1);assert.equal(after.settings.stopGeneration,d.settings.stopGeneration+1);
});
test('HTTP in-turn delegate is accepted, but re-stop during queued preflight prevents its launch',async()=>{
 const root=await startHeldManual(false),before=hub.chats.beforeQueued;let pending=false,unblock;
 const gate=new Promise(r=>{unblock=r;});
 hub.chats.beforeQueued=async o=>{if(o.origin==='delegate'){pending=true;await gate;}return before(o);};
 try{
  const r=await delegate(root.headers);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.queued,true);
  release(root.n);await wait(()=>pending);assert.equal(launches(),root.n);
  assert.equal((await post('/api/chat/stop')).status,200);unblock();await wait(()=>!hub.chats.busy(key.project,key.task));await pause(150);
  assert.equal(launches(),root.n);assert.equal(hub.chats.queue(key.project,key.task).find(q=>q.id===r.body.id).stopHeld,true);
 }finally{hub.chats.beforeQueued=before;unblock();if(fs.existsSync(path.join(tmp,'hold-'+root.n)))release(root.n);await wait(()=>!hub.chats.busy(key.project,key.task));}
});
test('HTTP re-stop revokes caller and queued delegates; a new manual turn rejects the old caller',async()=>{
 const root=await startHeldManual(),r=await delegate(root.headers);assert.equal(r.status,200);
 assert.equal((await post('/api/chat/stop')).status,200);release(root.n);await wait(()=>!hub.chats.busy(key.project,key.task));await pause(150);
 assert.equal(launches(),root.n);assert.equal(hub.chats.queue(key.project,key.task).find(q=>q.id===r.body.id).stopHeld,true);
 const n=holdNext();assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,200);await callerFor(n);
 const refused=await delegate(root.headers);assert.equal(refused.status,403);assert.match(refused.body.error,/設定の［復旧］/);
 release(n);await wait(()=>!hub.chats.busy(key.project,key.task));
});
test('HTTP manual-chain delegation still refuses persistence, cleanup, unknown exit and global barriers',async()=>{
 const root=await startHeldManual(),c=hub.stopControl;
 for(const result of [{...key,state:'failed',save:'saved'},{...key,state:'exited',save:'unconfirmed'}]){
  c.setResults([result]);assert.equal((await delegate(root.headers)).status,403);c.setResults([]);
 }
 c.setResults([],[{...key,message:'fixture cleanup failure',blocking:true}]);assert.equal((await delegate(root.headers)).status,403);c.setResults([]);
 c.error='fixture persistence failure';try{assert.equal((await delegate(root.headers)).status,403);}finally{c.error='';}
 c.active=true;try{assert.equal((await delegate(root.headers)).status,403);}finally{c.active=false;}
 c.pause();assert.equal((await delegate(root.headers)).status,403);release(root.n);await wait(()=>!hub.chats.busy(key.project,key.task));c.resume();
});
test('HTTP cold-loaded stop control rejects saved manual permits and live caller proof',async()=>{
 const root=await startHeldManual(),c=hub.stopControl,run=hub.chats.busy(key.project,key.task),{StopControl}=require('../lib/stop-control');
 const cold=new StopControl({dir:c.dir,boot:false});assert.throws(()=>cold.assert(key,run.options.stopTicket),/設定の［復旧］/);
 assert.throws(()=>cold.delegateTicket(key,run,root.headers['X-Hub-Delegate-Turn']),/設定の［復旧］/);
 release(root.n);await wait(()=>!hub.chats.busy(key.project,key.task));
});

async function manualSend(){
 const ticket=hub.stopControl.ticket(key),r=await send({manualStopTicket:ticket});
 assert.equal(r.status,200,JSON.stringify(r));await wait(()=>!hub.chats.busy(key.project,key.task));
 assert.equal(hub.stopControl.data.tasks[JSON.stringify([key.project,key.task])].autoHeld,true);
 assert.equal(hub.chats.queue(key.project,key.task).every(q=>q.stopHeld),true);
 assert.throws(()=>hub.stopControl.assert(key,ticket));
}
test('HTTP cleanup warning stays visible but a new manual send resumes without recovery',async()=>{
 const hook=hub.chats.onStop;hub.chats.onStop=()=>{throw Error('ideas.auto is not a function');};
 try{const stopped=await post('/api/chat/stop');assert.ok(stopped.body.errors.includes('ideas.auto is not a function'));}
 finally{hub.chats.onStop=hook;}
 await manualSend();assert.ok(hub.stopControl.view().errors.includes('ideas.auto is not a function'));
});
test('HTTP errors and unknown exits from another task do not block this task',async()=>{
 await post('/api/chat/stop');const other={...key,task:'other'};
 hub.stopControl.pause(other);hub.stopControl.setResults([{...other,state:'failed',save:'unconfirmed'}],[{...other,message:'fixture other task',blocking:true}]);
 await manualSend();assert.throws(()=>hub.stopControl.checkManual(other,hub.stopControl.ticket(other)));
});
test('HTTP stopping another task preserves this task blocking errors',async()=>{
 await post('/api/chat/stop');hub.stopControl.setResults([],[{...key,message:'fixture queue persistence',blocking:true}]);
 await post('/api/chat/stop',{task:'other'});
 const r=await send({manualStopTicket:hub.stopControl.ticket(key)});assert.equal(r.status,409);assert.match(r.body.error,/後処理/);
 hub.stopControl.setResults([]);
});
test('HTTP legacy missing ideas hook is a warning, unknown legacy errors still refuse',async()=>{
 await post('/api/chat/stop');hub.stopControl.setResults([],['ideas.auto is not a function']);await manualSend();
 hub.stopControl.setResults([],['fixture unknown legacy failure']);assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);hub.stopControl.setResults([]);
});
test('HTTP late chat save is admitted only after the exact stopped run is durably finished',async()=>{
 const run={options:key,ai:'codex',finished:false},k=hub.chats.key(key.project,key.task),terminate=hub.chats.terminateRun;
 hub.chats.running.set(k,run);hub.chats.terminateRun=async()=>({state:'exited',save:'unconfirmed',errors:[]});
 try{await post('/api/chat/stop');}finally{hub.chats.terminateRun=terminate;hub.chats.running.delete(k);}
 const ticket=hub.stopControl.ticket(key);
 assert.equal((await send({manualStopTicket:ticket})).status,409);
 run.finished=true;run.spoolError='fixture save failed';assert.equal((await send({manualStopTicket:ticket})).status,409);
 delete run.spoolError;await manualSend();
 assert.equal(JSON.parse(fs.readFileSync(hub.stopControl.file)).results[0].save,'saved');
});
test('HTTP late-save persistence failure remains fenced and never launches',async()=>{
 const c=hub.stopControl;await post('/api/chat/stop');const result={...key,state:'exited',save:'unconfirmed'};c.setResults([result]);c.watchSave(result,()=>true);
 const write=c.write;let response;
 c.write=()=>{throw Error('fixture stop persistence');};
 try{response=await send({manualStopTicket:c.ticket(key)});assert.equal(response.status,409);assert.match(response.body.error,/保存/);assert.equal(c.data.all,true);assert.ok(c.error);}
 finally{c.write=write;c.error='';c.data.all=false;c.setResults([]);}
});
test('HTTP save probe cannot upgrade a replacement result or unknown ownership',async()=>{
 const c=hub.stopControl;await post('/api/chat/stop');const result={...key,state:'exited',save:'unconfirmed'};c.watchSave(result,()=>true);
 c.setResults([{...result}]);assert.equal((await send({manualStopTicket:c.ticket(key)})).status,409);
 result.state='ownership-unknown';c.setResults([result]);assert.equal((await send({manualStopTicket:c.ticket(key)})).status,409);assert.equal(result.save,'unconfirmed');c.setResults([]);
});
test('HTTP rejected termination and pending cancellation keep the task failed',async()=>{
 const k=hub.chats.key(key.project,key.task),terminate=hub.chats.terminateRun;
 for(const pending of [false,true]){
  const run={options:key,ai:'codex',pending,cancel(){throw Error('fixture pending cancel');}};hub.chats.running.set(k,run);hub.chats.terminateRun=async()=>{throw Error('fixture terminate rejected');};
  try{const r=await post('/api/chat/stop');assert.equal(r.body.results[0].state,'failed');assert.equal(r.body.results[0].project,key.project);assert.equal(r.body.results[0].task,key.task);}
  finally{hub.chats.running.delete(k);hub.chats.terminateRun=terminate;}
  assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);hub.stopControl.setResults([]);
 }
});
test('HTTP real idea-ledger persistence errors refuse even after process exit',async()=>{
 const hook=hub.chats.onStop;hub.chats.onStop=()=>{const e=Error('fixture idea ledger write');e.code='EIO';throw e;};
 try{await post('/api/chat/stop');}finally{hub.chats.onStop=hook;}
 const r=await send({manualStopTicket:hub.stopControl.ticket(key)});assert.equal(r.status,409);assert.match(r.body.error,/後処理/);hub.stopControl.setResults([]);
});
test('HTTP a cold-loaded unconfirmed save has no live probe and stays refused',async()=>{
 const {StopControl}=require('../lib/stop-control'),c=hub.stopControl;
 await post('/api/chat/stop');c.setResults([{...key,state:'exited',save:'unconfirmed'}]);
 const cold=new StopControl({dir:c.dir,boot:false});assert.throws(()=>cold.checkManual(key,cold.ticket(key)),/保存/);
 c.setResults([]);
});
test('HTTP terminal stop confirms exit without claiming durable PTY output; direct send succeeds',async()=>{
 const k=[key.project,key.task,'codex'].join('\0'),s={exited:false,identity:{pid:1073741823,uid:process.getuid(),since:'fixture vanished',command:'fixture',pgid:1073741823},proc:{kill(){s.exited=true;}}};
 hub.sessions.map.set(k,s);
 try{const r=await post('/api/term/stop');assert.equal(r.status,200);assert.equal(r.body.results[0].state,'exited');assert.equal(r.body.results[0].save,'unconfirmed');assert.equal(r.body.results[0].kind,'terminal');await manualSend();}
 finally{hub.sessions.map.delete(k);}
});
for(const state of ['alive','ownership-unknown','failed','external-unconfirmed'])test('HTTP manual resume still refuses '+state,async()=>{
 await post('/api/chat/stop');hub.stopControl.setResults([{...key,state,save:'saved',kind:'terminal',output:'memory-only'}]);
 assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);hub.stopControl.setResults([]);
});
test('HTTP unscoped unknown result and terminal save failure stay blocked',async()=>{
 await post('/api/chat/stop');
 for(const result of [{state:'failed',save:'saved'},{...key,state:'exited',save:'unconfirmed',kind:'terminal',output:'memory-only',saveError:'fixture'}]){
  hub.stopControl.setResults([result]);assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);
 }hub.stopControl.setResults([]);
});
test('HTTP stale stop ticket asks for reload; fresh busy/session/webchat/handoff guards still refuse',async()=>{
 const ticket=hub.stopControl.ticket(key);await post('/api/chat/stop');const stale=await send({manualStopTicket:ticket});assert.equal(stale.status,409);assert.match(stale.body.error,/画面を読み直し/);assert.doesNotMatch(stale.body.error,/復旧/);
 const k=hub.chats.key(key.project,key.task),session=[key.project,key.task,'codex'].join('\0');
 hub.chats.running.set(k,{options:key});try{assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);}finally{hub.chats.running.delete(k);}
 hub.sessions.map.set(session,{exited:false});try{assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);}finally{hub.sessions.map.delete(session);}
 const busy=hub.webchat.busy;hub.webchat.busy=()=>[{...key}];try{assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);}finally{hub.webchat.busy=busy;}
 const ready=hub.chats.assertHandoffReadyAsync;hub.chats.assertHandoffReadyAsync=async()=>{throw Error('fixture strict handoff');};
 try{const r=await send({manualStopTicket:hub.stopControl.ticket(key)});assert.equal(r.status,409);assert.match(r.body.error,/fixture strict handoff/);}finally{hub.chats.assertHandoffReadyAsync=ready;}
});
test('HTTP free core stops idea automation and invalidates generations before manual resume',async()=>{
 const U=require('../lib/idea-utils');hub.ideas.initialize(key.project,U.uuid());let d=hub.ideas.read(key.project);
 hub.ideas.settings(key.project,{opId:U.uuid(),settingsRev:d.settings.rev},d=>{d.settings.lane={task:key.task};d.settings.auto.enabled=true;});
 d=hub.ideas.read(key.project);const result=await post('/api/chat/stop');assert.equal(result.status,200);assert.deepEqual(result.body.errors,[]);
 const after=hub.ideas.read(key.project);assert.equal(after.settings.auto.enabled,false);assert.equal(after.settings.manualPaused,true);assert.equal(after.settings.auto.generation,d.settings.auto.generation+1);assert.equal(after.settings.stopGeneration,d.settings.stopGeneration+1);
 await manualSend();assert.equal(hub.ideas.read(key.project).settings.auto.enabled,false);
 // A stop of another task must not pause this lane.
 d=hub.ideas.read(key.project);await post('/api/chat/stop',{task:'other'});assert.equal(hub.ideas.read(key.project).settings.stopGeneration,d.settings.stopGeneration);
});
test('HTTP simultaneous new sends admit one turn, and global stop cannot be manually resumed',async()=>{
 const ticket=hub.stopControl.ticket(key),responses=await Promise.all([send({manualStopTicket:ticket}),send({manualStopTicket:ticket})]);assert.equal(responses.filter(r=>r.status===200).length,1,JSON.stringify(responses));await wait(()=>!hub.chats.busy(key.project,key.task));
 hub.stopControl.pause();assert.equal((await send({manualStopTicket:hub.stopControl.ticket(key)})).status,409);assert.equal(hub.restartControl.executions,0);
});
test('normal clean exit is safe without owned AI; unknown saved results retain boot protection',async()=>{
 hub.stopControl.setResults([]);assert.equal(await hub.chats.withStrictHandoff(()=>hub.safeShutdown()),true);hub.stopControl.setResults([{...key,state:'exited',save:'unconfirmed'}]);assert.equal(await hub.chats.withStrictHandoff(()=>hub.safeShutdown()),false);hub.stopControl.setResults([]);
});
