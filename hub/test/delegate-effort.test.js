'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chat=require('../lib/chat'),launch=require('../lib/launch'),roles=require('../lib/roles');
const {lt}=require('../lib/locale');
const {createDelivery}=require('../lib/request-delivery');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-delegate-effort-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Delegate\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 const taskFile=path.join(dir,'.ai/tasks/task.md');fs.writeFileSync(taskFile,'---\nid: task\ntitle: Task\nrole: コーディング\nstate: 進行中\neffort: 中\n---\n## 手順\n- [ ] fixture\n');
 const roleFile=path.join(dir,'roles.yaml');fs.writeFileSync(roleFile,'models:\n  codex: [GPT-6.1-Sol]\nroles:\n  コーディング: { main: [codex, GPT-6.1-Sol, MAX], backup: [claude-code, Opus 5.5, 高] }\n  チェック: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\n');
 let data=roles.read(roleFile).data;const originalRole=fs.readFileSync(roleFile,'utf8');
 chat.writeMeta(dir,'task',{selection:{ai:'codex',model:'GPT-6.1-Sol',effort:'中'},sessions:{},models:{}});
 const initialMeta=fs.readFileSync(path.join(dir,'.ai/chat/task.json'),'utf8');
 const p={id:'Delegate',dir},task={id:'task',role:'コーディング',state:'進行中',effort:'中'};
 const catalog={codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol',efforts:['低','中','高','極高','MAX','Ultra']},{id:'codex-no-ultra',label:'No Ultra',efforts:['高']} ]}};
 catalog.grok={models:[{id:'grok-fixture',label:'Grok fixture'}]};catalog.agy={models:[{id:'agy-fixture',label:'Agy fixture'}]};launch.setDiscoveredModels(catalog);
 let usageSnapshot;const usage={snapshot:()=>usageSnapshot,status:async()=>usageSnapshot};
 let held=false;const limits={forRequest:()=>held};
 const resolve=o=>require('../lib/delegate-effort').resolve(o,{data,catalog,limits,usage:usage.snapshot()});
 const runner=new chat.ChatRunner({dirOf:()=>dir,delegateEffort:resolve,beforeQueued:o=>require('../lib/delegate-effort').refreshUsage(o,usage)});const turns=[];
 runner.run=(o,turn)=>{turns.push({o,turn});return {startedP:Promise.resolve(true)};};
 const updates=[];
 const host={license:{prepare(){}},licenseGuard(){},send:(_r,status,body)=>({status,...body}),
 store:{readProject:()=>p,taskFile:()=>taskFile,readTask:()=>task,updateTask:(_p,_t,change)=>{updates.push(change);Object.assign(task,change);}},
 launch,lt,discussion:{active:()=>false},aiTools:{isOperating:()=>false,catalog:()=>catalog},specialMode:{pick:()=>null},modelView:{special:()=>({enabled:false})},rolesData:()=>data,
 modelError:()=>'',delegateTerminalError:()=>'',chats:runner,webchatActive:()=>false,startDir:()=>({dir}),roles,requestAccount:()=> 'default',stopControl:{ticket:()=>({}),assert(){}},permCmd:()=>'',record(){},
 taskPrompt:()=>'',modelPolicy:()=>'',chatEnded(){},refreshLimitEvidence:async()=>{},verifyIntegrationAssignmentSend(){},limitEvidence:limits,usage};
 const deliver=b=>createDelivery(host)({project:p.id,task:'task',ai:'codex',model:'gpt-6.1-sol',text:'fixture',...b},{},{origin:'delegate'});
 const unchanged=()=>{assert.equal(fs.readFileSync(roleFile,'utf8'),originalRole);assert.equal(fs.readFileSync(path.join(dir,'.ai/chat/task.json'),'utf8'),initialMeta);assert.equal(task.effort,'中');assert.equal(fs.readFileSync(taskFile,'utf8').includes('effort: 中'),true);for(const u of updates)assert.deepEqual(Object.keys(u).sort(),['question','state']);};
 return {deliver,runner,turns,data,catalog,host,dir,roleFile,unchanged,setHeld:v=>held=v,setUsage:v=>usageSnapshot=v};
}
const flag=f=>f.turns.at(-1).turn.args.find(x=>x.startsWith('model_reasoning_effort='));

test('explicit effort equal to the named role is recorded as role effort: immediate and queued',async t=>{
 for(const queued of [false,true]){
  const f=fixture(t);f.data.allowDelegateUltra=true;
  if(queued)f.runner.running.set(f.runner.key('Delegate','task'),{userRow:{turn:'parent'}});
  const r=await f.deliver({role:'コーディング',effort:'MAX'});assert.equal(r.status,200,r.error);assert.equal(r.delegationEffort.source,'role');assert.equal(r.effort,'MAX');
  if(queued){f.runner.running.clear();const q=f.runner.queue('Delegate','task')[0];await f.runner.sendQueued({...q,project:'Delegate',task:'task',pdir:f.dir,dir:f.dir,request:q.id});f.runner.unqueue('Delegate','task',q.id);}
  assert.equal(f.turns.at(-1).o.delegationEffort.source,'role');assert.equal(chat.read(f.dir,'task').at(-1).delegationEffort.source,'role');assert.equal(flag(f),'model_reasoning_effort=max');
  const changed=await f.deliver({role:'コーディング',effort:'極高'});assert.equal(changed.delegationEffort.source,'override');
  const unnamed=await f.deliver({effort:'MAX'});assert.equal(unnamed.delegationEffort.source,'override');f.unchanged();
 }
});

test('role effort and one-request overrides reach CLI args without changing saved settings: immediate and queued',async t=>{
 for(const queued of [false,true]){
  const f=fixture(t);f.data.allowDelegateUltra=true;
  async function send(b){if(queued)f.runner.running.set(f.runner.key('Delegate','task'),{userRow:{turn:'parent'}});
   const r=await f.deliver(b);assert.equal(r.status,200,r.error);
   if(queued){f.runner.running.clear();const q=f.runner.queue('Delegate','task').at(-1);assert.ok(q);await f.runner.sendQueued({...q,project:'Delegate',task:'task',pdir:f.dir,dir:f.dir,request:q.id});f.runner.unqueue('Delegate','task',q.id);}
   return r;
  }
  await send({role:'コーディング'});assert.equal(flag(f),'model_reasoning_effort=max');assert.equal(f.turns.at(-1).o.delegationEffort.source,'role');
  await send({role:'コーディング',effort:'Ultra'});assert.equal(flag(f),'model_reasoning_effort=ultra');assert.equal(f.turns.at(-1).o.delegationEffort.source,'override');
  await send({role:'コーディング'});assert.equal(flag(f),'model_reasoning_effort=max');
  await send({role:'コーディング',effort:'低'});assert.equal(flag(f),'model_reasoning_effort=low');f.unchanged();
 }
});
test('automatic Ultra is default-off and falls back by role, matching AI/model, or empty CLI default',async t=>{
 const f=fixture(t);assert.equal(f.data.allowDelegateUltra,false);
 for(const b of [{role:'コーディング'},{},{model:'gpt-6-astra'}]){
  const r=await f.deliver({...b,effort:'Ultra'});assert.equal(r.status,200,r.error);assert.match(r.note,/Ultraの指定を適用せず/);
  assert.equal(r.effort,b.model?'':'MAX');assert.equal(flag(f),b.model?undefined:'model_reasoning_effort=max');assert.equal(r.delegationEffort.source,'fallback');
 }
 f.unchanged();
});
test('unsupported models and held handoffs accept Ultra with saved effort and a note',async t=>{
 const f=fixture(t);f.data.allowDelegateUltra=true;
 for(const b of [{model:'codex-no-ultra',role:'コーディング'},{ai:'claude',model:'claude-opus-5-5',role:'チェック'},{ai:'grok',model:'grok-fixture'},{ai:'agy',model:'agy-fixture'}]){
  const r=await f.deliver({...b,effort:'Ultra'});assert.equal(r.status,200,r.error);assert.notEqual(r.effort,'Ultra');assert.match(r.note,b.ai==='claude'?/利用状況/:/対象外/);
 }
 f.setHeld(true);const held=await f.deliver({role:'コーディング',effort:'Ultra'});assert.equal(held.effort,'MAX');assert.match(held.note,/交代を保持/);
 f.setHeld(false);f.host.limitEvidence.active=()=>({model:'gpt-6.1-sol'});
 const credit=await f.deliver({role:'コーディング',effort:'Ultra'});assert.equal(credit.effort,'MAX');assert.match(credit.note,/交代を保持/);
 f.data.roles[0].backup={ai:'human',model:'',effort:''};
 f.host.limitEvidence.active=(_account,model)=>model?null:{model:'unrelated-default'};
 const human=await f.deliver({role:'コーディング',effort:'Ultra'});assert.equal(human.effort,'Ultra');f.unchanged();
});
test('queued Ultra is rechecked at launch, while human-saved Ultra and manual choices are unaffected',async t=>{
 for(const change of ['permission','limit','catalog']){
  const f=fixture(t);f.data.allowDelegateUltra=true;f.runner.running.set(f.runner.key('Delegate','task'),{userRow:{turn:'parent'}});
  const r=await f.deliver({role:'コーディング',effort:'Ultra'});assert.equal(r.effort,'Ultra');f.runner.running.clear();
  if(change==='permission')f.data.allowDelegateUltra=false;else if(change==='limit')f.setHeld(true);else f.catalog.codex.models[0].efforts=['高'];
  const q=f.runner.queue('Delegate','task')[0];const started=await f.runner.sendQueued({...q,project:'Delegate',task:'task',pdir:f.dir,dir:f.dir,request:q.id});
  assert.equal(started.effort,'MAX');assert.equal(started.userRow.delegationEffort.source,'fallback');assert.equal(flag(f),'model_reasoning_effort=max');f.unchanged();
 }
 const f=fixture(t);f.data.roles[0].main.effort='Ultra';await f.deliver({role:'コーディング'});assert.equal(flag(f),'model_reasoning_effort=ultra');
 f.runner.sendNow({project:'Delegate',task:'task',pdir:f.dir,dir:f.dir,ai:'codex',model:'gpt-6.1-sol',effort:'Ultra',text:'manual'});assert.equal(flag(f),'model_reasoning_effort=ultra');
});
test('Ultra permission saves independently through role settings API and rejects non-booleans',t=>{
 const f=fixture(t);const route=require('../lib/routes/role-settings')({roles,ROLES_FILE:f.roleFile,send:(_r,status,body)=>({status,body}),lt}).write;
 for(const value of ['true',1,null])assert.equal(route.handle(null,null,null,{roles:f.data.roles,allowDelegateUltra:value}).status,400);
 const before=f.data.roles.map(r=>({...r}));const out=route.handle(null,null,null,{roles:f.data.roles,allowDelegateUltra:true});assert.equal(out.status,200);assert.equal(out.body.allowDelegateUltra,true);assert.deepEqual(out.body.roles,before);
 assert.equal(roles.write(f.roleFile,out.body.roles).data.allowDelegateUltra,true);
});

test('Claude workflow admission and queued starts recheck account usage without changing saved settings',async t=>{
 for(const queued of [false,true])for(const block of [false,true]){
  const f=fixture(t);f.data.allowDelegateUltra=true;
  const windows=p=>({providers:{claude:{account:'default',status:'ok',fetchedAt:new Date().toISOString(),windows:[{id:'five_hour',usedPercent:p},{id:'seven_day',usedPercent:10}]}}});
  f.setUsage(windows(10));let reads=0;
  f.host.usage.status=async(_force,selection,options)=>{reads++;assert.deepEqual(selection,{claude:'default'});assert.deepEqual(options.only,{ai:'claude',account:'default'});if(block&&reads===2)f.setUsage(windows(70));};
  if(queued)f.runner.running.set(f.runner.key('Delegate','task'),{userRow:{turn:'parent'}});
  const r=await f.deliver({ai:'claude',model:'claude-opus-5-5',role:'チェック',effort:'Ultra'});assert.equal(r.status,200,r.error);
  if(queued){assert.equal(r.delegationEffort.workflow,true);f.runner.running.clear();const q=f.runner.queue('Delegate','task')[0];await f.runner.sendQueued({...q,project:'Delegate',task:'task',pdir:f.dir,dir:f.dir,request:q.id});f.runner.unqueue('Delegate','task',q.id);}
  assert.ok(reads>=2);const {turn,o}=f.turns.at(-1);assert.equal(o.delegationEffort.workflow,!block);assert.equal(turn.effortFlag,block?'high':'xhigh');
  const args=JSON.parse(turn.args[turn.args.indexOf('--settings')+1]);assert.equal(args.ultracode,!block);assert.equal(turn.args.includes('--disallowedTools'),block);
  if(block){assert.equal(o.delegationEffort.source,'fallback');assert.match(o.delegationEffort.note,/安全基準/);}
  f.unchanged();
  await f.deliver({ai:'claude',model:'claude-opus-5-5',role:'チェック'});assert.equal(f.turns.at(-1).turn.effortFlag,'high');assert.equal(f.turns.at(-1).o.delegationEffort.workflow,false);f.unchanged();
 }
});
