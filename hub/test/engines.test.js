'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const queue=require('../lib/engines/queue'),parallel=require('../lib/engines/parallel'),limit=require('../lib/engines/limit-switch');
const send=(_res,status,body)=>({status,body}),lt=s=>s;
const immediate=()=>new Promise(resolve=>setImmediate(resolve));

test('settled queue callbacks read current private services and deferred result service without copying state',async()=>{
 const events=[];let discussion,review,integrate={settled:()=>events.push('settled-old')},results;
 class Runner{constructor(config){this.config=config;}}
 const engine=queue({ROOT:'/fixture',path,chat:{ChatRunner:Runner},discussionRuntime:{isRequest:r=>r==='discussion'},roleReviewRuntime:{isRequest:r=>r==='review'},getDiscussion:()=>discussion,getRoleReview:()=>review,getIntegrateAuto:()=>integrate,getResultsGate:()=>results,
  stopControl:{held:()=>false,assert:()=>events.push('stop')},getChats:()=>({assertHandoffReadyAsync:async()=>events.push('saved')}),record:()=>assert.fail('unexpected error')});
 const hooks=engine.createChatRunner().config;
 discussion={settled:async()=>events.push('discussion-one')};await hooks.onSettled({request:'discussion'},{});
 discussion={settled:async()=>events.push('discussion-two')};await hooks.onSettled({request:'discussion'},{});
 review={settled:async()=>events.push('review')};await hooks.onSettled({request:'review'},{});
 await hooks.onSettled({project:'p',task:'t'},{});
 integrate={tick:()=>events.push('tick-new')};results={trigger:async()=>events.push('results-new')};
 await immediate();assert.deepEqual(events,['discussion-one','discussion-two','review','settled-old','stop','saved','stop','tick-new','results-new']);
});

test('post-webchat dispatch leaves held/error/limit queues untouched and saves one failed launch without retry',async()=>{
 let item={id:'one',ai:'codex',text:'request'},held=true,restart,attempts=0,writes=0;
 const chats={queue:()=>[item],sendQueued:async()=>{attempts++;return {started:Promise.resolve(false)};},setQueue:(_p,_t,q)=>{writes++;item=q[0];},unqueue:()=>assert.fail('failed launch must remain queued')};
 const engine=queue({stopControl:{held:()=>held},getChats:()=>chats,getRestartControl:()=>restart,webchatActive:()=>false,store:{readProject:()=>({id:'p',dir:'/ledger'})},lt});
 const run=()=>engine.dispatchAfterWebchat({project:'p',task:'t'});
 await run();held=false;
 for(const flag of ['stopHeld','error','limitWaiting']){item={id:'one',[flag]:true};await run();}
 item={id:'one'};restart={committed:true};await run();assert.equal(attempts,0);assert.equal(writes,0);
 restart=null;await run();assert.equal(attempts,1);assert.equal(writes,1);assert.match(item.error,/起動できません/);
 await run();assert.equal(attempts,1);assert.equal(writes,1);
});

test('terminal execution gates acquire/release the original owner and read restart/tools/runner at invocation',()=>{
 let sessions,runner,restart,tools={isOperating:()=>false};const events=[];
 const engine=parallel({getSessions:()=>sessions,getIdeaRunner:()=>runner,getRestartControl:()=>restart,getAiTools:()=>tools,lt,
  executionGate:{assert:o=>events.push(['assert',o.owner]),acquire:o=>events.push(['acquire',o.owner]),release:o=>events.push(['release',o])}});
 sessions={};engine.installTerminal();const o={project:'p',task:'t',ai:'codex',dir:'/work'};
 sessions.startGate(o);runner={wake:p=>events.push(['wake',p])};sessions.endGate(o);
 assert.equal(sessions.canStart('codex',o),'');restart={committed:true};assert.match(sessions.canStart('codex',o),/再起動/);
 restart=null;tools={isOperating:()=>true};assert.match(sessions.canStart('codex',o),/更新/);
 assert.deepEqual(events.slice(0,3),[['acquire','terminal:p:t:codex'],['release','terminal:p:t:codex'],['wake','p']]);
});

test('execution admission uses the request stop snapshot/manual ticket and excludes supervised process duplicates',()=>{
 let request={stopSnapshot:{epoch:7,tasks:{'["p","t"]':{epoch:3}}}};const checks=[],options={project:'p',task:'t',ai:'codex',origin:'hub-internal',mode:'queued',licenseFeatures:['queue_auto']};
 const engine=parallel({getReqCtx:()=>({getStore:()=>request}),stopControl:{assert:(_o,ticket)=>checks.push(['assert',ticket]),checkManual:(_o,ticket)=>checks.push(['manual',ticket])},
  getSessions:()=>({list:()=>[]}),getChats:()=>({running:new Map(),supervisedPid:pid=>pid===10}),getWebchat:()=>({busy:()=>[]}),getProcwatch:()=>({list:()=>[{pid:10},{pid:20}]}),
  license:{guard:(o,state)=>({o,state})},extensions:{state:()=>({included:[]})},lt});
 const first=engine.licenseGuard(options,'accept');assert.deepEqual(checks,[['assert',{epoch:7,task:3}]]);assert.equal(first.o.mode,undefined);assert.deepEqual(first.o.licenseFeatures,[]);assert.deepEqual(first.state.active,[{pid:20,running:true}]);assert.equal(first.state.stage,'accept');
 const ticket={epoch:8,task:4};request={manualResume:{project:'p',task:'t',ticket}};engine.licenseGuard(options);assert.deepEqual(checks.at(-1),['manual',ticket]);
 assert.equal(options.mode,'queued');assert.deepEqual(options.licenseFeatures,['queue_auto']);
});

function limitHost(extra={}){
 const policy={enabled:()=>true,backup:()=>({ai:'codex',model:'backup',account:'default'})};
 return {policy,ctx:{extensions:{create:(id,host)=>{assert.equal(id,'limit_switch');assert.ok(Object.isFrozen(host.license));return policy;}},license:{require:()=>{}},rolesData:()=>({roles:[],checkCredits:{}}),launch:{flagFor:(_a,m)=>m,AI_LABEL:{claude:'Claude',codex:'Codex'},modelLabel:(_a,m)=>m},discussionRuntime:{isRequest:()=>false},roleReviewRuntime:{},integrationPolicyRequest:()=>false,verifyIntegrationAssignmentSend:()=>{},lt,...extra}};
}

test('limit host creates only the original private policy and reads its late store/model services on demand',()=>{
 let store,view,host,reads=0;
 const fixture=limitHost({extensions:{create:(id,h)=>{assert.equal(id,'limit_switch');host=h;return {enabled:()=>true,backup:()=>null};}},getStore:()=>{reads++;return store;},getModelView:()=>{reads++;return view;}});
 const engine=limit(fixture.ctx);assert.equal(reads,0);store={readProject:p=>p};view={special:()=>({enabled:true})};
 assert.equal(host.store.readProject('p'),'p');assert.deepEqual(host.modelView.special(),{enabled:true});assert.equal(reads,2);assert.equal(engine.limitBackup({}),null);
});

test('terminal limit setup preserves the constructor, non-blocking hooks and latest account/unread service',async t=>{
 let sessions={},accounts={location:()=>'/account-one'},checked=0,prepared,unread=[];
 class Limits{constructor(options){this.options=options;}async check(){checked++;}async tick(){}}
 const f=limitHost({getSessions:()=>sessions,getTerminalLimits:()=>Limits,getLimitEvidence:()=>({}),getAccounts:()=>accounts,getCaptureTerminalLimit:()=>((...args)=>{prepared=args;return 'capture';}),setUnread:(...v)=>unread.push(v),getRestartControl:()=>null,record:()=>{}});
 const engine=limit(f.ctx),{terminalLimits:instance,terminalLimitTimer}=engine.installTerminal();t.after(()=>clearInterval(terminalLimitTimer));assert.ok(instance instanceof Limits);
 accounts={location:()=>'/account-two'};assert.equal(sessions.prepare({ai:'codex',account:'work',limitMarker:'marker'}),'capture');assert.deepEqual(prepared,['codex','/account-two','marker']);
 sessions.onExit('p','t','codex',{stopped:false,watchers:new Set()});await immediate();assert.equal(checked,1);assert.deepEqual(unread,[['p','t',true]]);
});

test('terminal handoff saves recovery material and rechecks stop after awaited limit evidence before any successor',async()=>{
 const writes=[],pending=new Map();let release,changed=false,starts=0;
 const usage={status:()=>new Promise(resolve=>{release=resolve;})},task={id:'t',state:'実行中'},project={id:'p',dir:'/ledger',tasks:[task]};
 const f=limitHost({path,crypto:require('node:crypto'),fs:{mkdirSync:()=>{},writeFileSync:(file,text)=>{writes.push(file);pending.set(file,text);},renameSync:(a,b)=>pending.set(b,pending.get(a))},
  getStore:()=>({readProject:()=>project,taskFile:()=>'/ledger/.ai/tasks/t.md'}),getStopControl:()=>({ticket:()=>({epoch:1,task:2}),held:()=>false,changed:()=>changed}),
  getTranscript:()=>({collect:()=>({}),packet:()=> 'saved transcript'}),getAccounts:()=>({location:()=>'/account'}),getBuildHandoffCard:()=>()=> 'saved original request',getLimitEvidence:()=>({forRequest:()=>null}),getUsage:()=>usage,getSessions:()=>({start:()=>{starts++;}})});
 const run=limit(f.ctx).terminalLimitHandoff({project:'p',task:'t',ai:'claude',model:'main'},{exited:true,stopped:false,dir:'/work',started:'stamp',original:'original request'});
 assert.equal(typeof release,'function');assert.equal(writes.length,2);assert.equal(JSON.parse(pending.get('/ledger/.ai/handoff/t-limit.json')).pending,true);
 changed=true;release({});await run;assert.equal(starts,0);assert.match(pending.get('/ledger/.ai/handoff/t-limit-stamp.md'),/saved original request/);assert.equal(writes.length,2);
});

test('manual queue change rejects a send lock before retreat/private state and uses the current retreat guard',()=>{
 let locked=true,retreat,unqueue=0,reads=0;
 const route=require('../lib/routes/queue-control')({send,lt,chats:{key:()=> 'key',unqueue:()=>{unqueue++;return [];}},queueActions:{has:()=>locked},getQueueRetreat:()=>retreat,fs:{existsSync:()=>{reads++;return false;}},fromRemote:()=>false}).unqueue;
 const b={project:'p',task:'t',id:'one'};assert.equal(route.handle({}, {},{},b).status,409);assert.equal(reads,0);
 locked=false;retreat={guard:()=>{throw Error('retreat pending');}};assert.equal(route.handle({}, {},{},b).body.error,'retreat pending');assert.equal(reads,0);assert.equal(unqueue,0);
 retreat={guard:()=>{}};assert.equal(route.handle({}, {},{},b).status,200);assert.equal(unqueue,1);
});

test('external terminal launch failure cancels its prepared command and propagates to the original caller',async()=>{
 const events=[],project={id:'p'},task={id:'t'};
 const route=require('../lib/routes/terminal-start')({send,lt,licenseGuard:()=>events.push('guard'),store:{readProject:()=>project,taskFile:()=>'/task',readTask:()=>task},launch:{AIS:['codex'],buildCommand:()=> 'command',openTerminal:async()=>{events.push('launch');throw Error('launch failed');}},pickSpec:()=>({model:'model'}),requestAccount:()=> 'default',modelError:()=>'',startDir:()=>({dir:'/work'}),taskPrompt:()=> 'prompt',permCmd:()=> 'codex',codexFastFor:()=>false,accounts:{terminalCommand:()=>({command:'prepared',cancel:()=>events.push('cancel')})}}).continue;
 await assert.rejects(route.handle({}, {},{}, {project:'p',task:'t',ai:'codex'}),/launch failed/);assert.deepEqual(events,['guard','launch','cancel']);
});
