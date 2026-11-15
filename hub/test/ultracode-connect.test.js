'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chat=require('../lib/chat'),launch=require('../lib/launch'),policy=require('../lib/delegate-effort');
const now=Date.now();
function usage(percent=10,account='default',at=now){return {providers:{claude:{account,status:'ok',fetchedAt:new Date(at).toISOString(),windows:[{id:'five_hour',usedPercent:percent},{id:'seven_day',usedPercent:percent}]}}};}
function fixture(){
 const data={allowDelegateUltra:true,roles:[{name:'チェック',main:{ai:'claude-code',model:'Opus 5.5',effort:'高'},backup:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}},{name:'司令塔',main:{ai:'claude-code',model:'Fable 5.2',effort:'高'}}]};
 const request={origin:'delegate',ai:'claude',account:'default',model:'Opus 5.5',role:'チェック',effort:'Ultra',delegationEffort:{requested:'Ultra',source:'override'}};
 const options={data,usage:usage(),now};
 return {data,request,options,resolve:()=>policy.resolve(request,options)};
}
function turn(o){return chat.buildTurn({meta:{},rows:[],text:'fixture',basePrompt:'',policy:'',...o});}
function settings(t){const i=t.args.indexOf('--settings');return i<0?null:JSON.parse(t.args[i+1]);}

test('approved Claude delegated Ultra uses xhigh, workflow settings and the assigned subagent model',()=>{
 const f=fixture(),o=f.resolve(),t=turn(o);
 assert.equal(o.delegationEffort.workflow,true);assert.equal(t.effortFlag,'xhigh');
 assert.deepEqual(settings(t),{ultracode:true,workflowKeywordTriggerEnabled:false});
 assert.deepEqual(t.env,{CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL:'claude-opus-5-5',CLAUDE_CODE_SUBAGENT_MODEL:'claude-opus-5-5',CLAUDE_CODE_SUBAGENT_MODEL_FORCE:'1'});
 assert.doesNotMatch(t.args.join(' '),/--effort ultra/);
});
test('Claude Ultra falls back on permission, orchestrator identity, held limit, stale or uncertain usage and either 70 percent window',()=>{
 const cases=[f=>f.data.allowDelegateUltra=false,f=>f.request.role='司令塔',f=>f.request.model='Fable 5.2',f=>f.options.limits={forRequest:()=>true},f=>f.options.usage=undefined,f=>f.options.usage=usage(70),f=>f.options.usage=usage(10,'other'),f=>f.options.usage=usage(10,'default',now-600001),f=>f.options.usage.providers.claude.status='unavailable',f=>f.options.usage.providers.claude.windows.pop(),f=>f.options.usage.providers.claude.windows[1].usedPercent=70,f=>f.options.usage.providers.claude.windows[0].usedPercent=null,f=>f.options.usage.providers.claude.windows[0].usedPercent='10',f=>f.options.usage=usage(10,'default',now+60000)];
 for(const change of cases){const f=fixture();change(f);const o=f.resolve(),t=turn(o);assert.equal(o.delegationEffort.source,'fallback');assert.ok(o.delegationEffort.note);assert.equal(o.delegationEffort.workflow,false);assert.equal(settings(t).ultracode,false);assert.equal(settings(t).workflowKeywordTriggerEnabled,false);assert.match(t.args[t.args.indexOf('--disallowedTools')+1],/Workflow/);assert.equal(t.env,undefined);assert.equal(o.effort,'高');}
 const f=fixture();f.options.usage=usage(69.999);assert.equal(f.resolve().delegationEffort.workflow,true);
 f.request.account='work';f.options.usage=usage(10,'work');assert.equal(f.resolve().delegationEffort.workflow,true);
 const fallback=policy.resolve({...f.request,delegationEffort:{requested:'Ultra',source:'fallback'},effort:'高'},f.options);assert.equal(fallback.effort,'高');
});
test('human Claude turns stay unchanged and delegated settings merge without losing existing restrictions',()=>{
 const manual=turn({ai:'claude',model:'Opus 5.5',effort:'Ultra'});
 assert.equal(manual.effortFlag,'high');assert.equal(settings(manual),null);assert.equal(manual.env,undefined);assert.ok(!manual.args.includes('--disallowedTools'));
 const delegated=turn({ai:'claude',model:'Opus 5.5',origin:'delegate',effort:'高',perm:'claude --settings {"existing":true,"ultracode":true} --disallowedTools Bash'});
 assert.deepEqual(settings(delegated),{existing:true,ultracode:false,workflowKeywordTriggerEnabled:false});assert.equal(delegated.args.filter(x=>x==='--settings').length,1);assert.equal(delegated.args[delegated.args.indexOf('--disallowedTools')+1],'Bash,Workflow');
});
test('workflow modelUsage is summed while ordinary Claude usage stays unchanged',()=>{
 const record={type:'result',result:'final',usage:{input_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:5},modelUsage:{'claude-opus-5-5':{inputTokens:100,cacheReadInputTokens:200,cacheCreationInputTokens:300},'claude-opus-5-5[1m]':{inputTokens:10,cacheReadInputTokens:20,cacheCreationInputTokens:30}}};
 assert.deepEqual(chat.parse('claude',record,'claude-opus-5-5',{workflow:true}).find(e=>e.kind==='done').usage,{input_tokens:110,cache_read_input_tokens:220,cache_creation_input_tokens:330});
 assert.deepEqual(chat.parse('claude',record).find(e=>e.kind==='done').usage,record.usage);
});
test('usage refresh is Claude-delegate-only, selected-account scoped and fails closed',async()=>{
 const f=fixture(),calls=[],service={status:async(...args)=>calls.push(args)};
 await policy.refreshUsage(f.request,service);assert.deepEqual(calls,[[true,{claude:'default'},{only:{ai:'claude',account:'default'}}]]);
 for(const o of [{...f.request,origin:'human'},{...f.request,ai:'codex'},{...f.request,automation:{}},{...f.request,delegationEffort:{requested:'',source:'role'}}])await policy.refreshUsage(o,service);
 assert.equal(calls.length,1);await policy.refreshUsage(f.request,{status:async()=>{throw Error('offline');}});assert.equal(f.resolve().delegationEffort.source,'fallback');assert.equal(policy.readUsage({snapshot(){throw Error('unavailable');}},'default'),undefined);
});
test('two Claude result records keep only the final answer and total usage, including idea automation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-workflow-mock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script=path.join(dir,'mock.cjs'),record=path.join(dir,'launch.json');
 fs.writeFileSync(script,`require('fs').writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({args:process.argv.slice(2),model:process.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL,forced:process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE}));process.stdin.resume();process.stdin.on('end',()=>{for(const x of [
 {type:'assistant',message:{content:[{type:'text',text:'途中の文'}]}},
 {type:'result',result:'途中の文',usage:{input_tokens:1}},
 {type:'task_progress',task_id:'fixture'},
 {type:'assistant',message:{content:[{type:'text',text:'最終の答え'}]}},
 {type:'result',result:'最終の答え',usage:{input_tokens:3},modelUsage:{opus:{inputTokens:100,cacheReadInputTokens:20,cacheCreationInputTokens:5}}}
 ])console.log(JSON.stringify(x));});`);
 const f=fixture(),o={...f.resolve(),project:'Fixture',task:'task',pdir:dir,dir,userRow:{at:new Date().toISOString(),turn:'fixture'},env:{FIXTURE_RECORD:record,CLAUDE_CODE_SUBAGENT_MODEL_FORCE:'wrong'},perm:process.execPath+' '+script,automation:{runId:'fixture'},text:'fixture'};
 const runner=new chat.ChatRunner({dirOf:()=>dir});const run=runner.run(o,turn(o),{sessions:{},models:{}},[]);assert.equal(await run.startedP,true);await run.finishedP;
 const row=chat.read(dir,'task').findLast(r=>r.role==='assistant');assert.equal(row.text,'最終の答え');assert.equal(row.automation.resultText,'最終の答え');assert.equal(row.error,'');assert.equal(row.automation.closed,true);assert.deepEqual(row.usage,{input_tokens:100,cache_read_input_tokens:20,cache_creation_input_tokens:5});
 const actual=JSON.parse(fs.readFileSync(record));assert.equal(actual.model,'claude-opus-5-5');assert.equal(actual.forced,'1');assert.ok(actual.args.includes('xhigh'));assert.ok(actual.args.includes('--settings'));
});

test('queue engine refreshes selected Claude usage and passes the snapshot to the launch guard',async()=>{
 const f=fixture(),calls=[],service={snapshot:selection=>{assert.deepEqual(selection,{claude:'default'});return usage();},status:async(...args)=>calls.push(args)};
 const engine=require('../lib/engines/queue')({ROOT:'/private/tmp/fixture',path,usage:service,chat:{ChatRunner:class{constructor(options){Object.assign(this,options);}}},rolesData:()=>f.data,getAiTools:()=>({catalog:()=>({})}),accountFor:()=> 'default',license:{prepare(){}},refreshLimitEvidence:async()=>{},assertCapacityHandoff(){}});
 const runner=engine.createChatRunner();await runner.beforeQueued(f.request);assert.equal(calls.length,1);assert.equal(runner.delegateEffort(f.request).delegationEffort.workflow,true);
});
test('delegated workflow settings preserve existing settings files without writing them',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-workflow-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'settings.json'),content=JSON.stringify({permissions:{deny:['Bash']},other:1});fs.writeFileSync(file,content);
 const f=fixture(),t1=turn({...f.resolve(),dir,perm:'claude --settings settings.json'});
 assert.deepEqual(settings(t1),{permissions:{deny:['Bash']},other:1,ultracode:true,workflowKeywordTriggerEnabled:false});assert.equal(fs.readFileSync(file,'utf8'),content);
});
