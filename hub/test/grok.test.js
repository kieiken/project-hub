'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launch = require('../lib/launch');
const chat = require('../lib/chat');
const roles = require('../lib/roles');
const { Accounts } = require('../lib/accounts');
const { AiTools, grokModels, methodFor, executable } = require('../lib/ai-tools');
const { latestVersion } = require('../lib/update-check');
const { Onboarding } = require('../lib/onboarding');
const { authStatus } = require('../lib/grok');
const model = {id:'grok-code-fast-1',label:'grok-code-fast-1'};
const output = 'You are logged in with x.ai.\nDefault model: '+model.id+'\nAvailable models:\n  * '+model.id+' (default)\n  - grok-code-1\n';
const fixture = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-grok-')));
const catalogue = () => { launch.setDiscoveredModels({grok:{models:[model]}}); roles.setModelCatalog({grok:{models:[model]}}); };
test.afterEach(()=>{launch.setAccounts(null); launch.setDiscoveredModels({}); roles.setModelCatalog({});});

for (const [stdout,error,status] of [
  [output,null,'logged-in'],['You are not authenticated.',null,'logged-out'],
  ['You are using XAI_API_KEY.',null,'api'],["Model 'grok' is using its own API key.",null,'api'],
  ['You are authenticated via deployment key.',null,'api'],['private arbitrary output',null,'unknown'],
  ['',{code:'ENOENT'},'not-installed'],[output,{killed:true},'unknown'],[output,{code:1},'unknown'],
]) test(`Grok auth output: ${status} ${stdout.slice(0,25)}`,()=>{
  const result=authStatus({stdout,error}); assert.equal(result.status,status);
  assert.ok(!JSON.stringify(result).includes('private arbitrary output')); assert.ok(!JSON.stringify(result).includes('x.ai'));
});

test('Grok accounts isolate authentication and copy no default settings',async()=>{
  const root=fixture();
  try{
    fs.mkdirSync(path.join(root,'.grok'),{recursive:true});fs.writeFileSync(path.join(root,'.grok/config.json'),'secret');
    let captured;
    const a=new Accounts({home:root,file:path.join(root,'accounts.json'),execute:async(file,args,env)=>{captured={file,args,env};return {stdout:output,stderr:''};}});
    launch.setAccounts(a);const row=a.add('grok','仕事');
    assert.deepEqual(fs.readdirSync(row.dir),[]);assert.equal(fs.statSync(row.dir).mode & 0o777,0o700);
    const incoming={PATH:'/usr/bin:/bin',GROK_HOME:'/default',KEEP:'safe',XAI_API_KEY:'secret',GROK_CODE_XAI_API_KEY:'secret',...Object.fromEntries(launch.GROK_AUTH_ENV.map(k=>[k,'external']))};
    const named=a.env('grok',row.id,incoming),def=a.env('grok','default',incoming);
    for(const key of [...launch.GROK_API_ENV,...launch.GROK_AUTH_ENV])assert.equal(named[key],undefined,key);
    assert.equal(named.GROK_HOME,row.dir);assert.equal(named.KEEP,'safe');assert.equal(named.GROK_DISABLE_AUTOUPDATER,'1');
    for(const key of launch.GROK_API_ENV)assert.equal(def[key],undefined);
    for(const key of launch.GROK_AUTH_ENV)assert.equal(def[key],'external');assert.equal(def.GROK_HOME,'/default');
    assert.equal((await a.status('grok',row.id)).status,'logged-in');assert.deepEqual(captured.args,['models']);
    assert.equal(captured.env.GROK_HOME,row.dir);assert.equal(captured.env.GROK_DISABLE_AUTOUPDATER,'1');
    const shell=launch.accountShell('grok',row.id);for(const key of [...launch.GROK_API_ENV,...launch.GROK_AUTH_ENV])assert.ok(shell.includes(`'-u' '${key}'`));
    assert.ok(shell.includes('GROK_HOME='+row.dir));assert.ok(!shell.includes('CODEX_HOME='));
    assert.deepEqual(a.command('grok',row.id,'login').args,['login']);
    await assert.rejects(a.logout('grok','default',false));
    await a.logout('grok',row.id);assert.deepEqual(captured.args,['logout']);
    a.rename('grok',row.id,'新しい名前');assert.equal(a.get('grok',row.id).name,'新しい名前');
    a.remove('grok',row.id);assert.throws(()=>a.get('grok',row.id));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Grok account read lock and terminal auth ticket protect logout/delete/start',async()=>{
  const root=fixture();try{
    let done;const a=new Accounts({home:root,file:path.join(root,'accounts.json'),execute:()=>new Promise(r=>done=r)});
    const row=a.add('grok','one'),pending=a.status('grok',row.id);
    assert.throws(()=>a.remove('grok',row.id));await assert.rejects(a.logout('grok',row.id));
    done({stdout:output});await pending;
    const ticket=a.terminalCommand('grok',row.id,'true',launch.sq,'auth');
    assert.throws(()=>a.available('grok',row.id));assert.throws(()=>a.remove('grok',row.id));ticket.cancel();a.available('grok',row.id);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Grok launches terminal/print, resumes only identical account/model and supports four efforts',()=>{
  catalogue();const prompt='quoted "text"; $(never-run)';
  const args=launch.buildArgv({ai:'grok',model:model.id,effort:'極高',prompt}).args;
  assert.deepEqual(args,['--always-approve','-m',model.id,'--effort','xhigh',prompt]);
  const shell=launch.buildCommand({ai:'grok',dir:'/a b',model:model.id,effort:'高',prompt});assert.ok(shell.includes(launch.sq(prompt)));assert.ok(shell.includes("'-u' 'XAI_API_KEY'"));
  for(const [account,chosen,resume] of [['one',model.id,true],['two',model.id,false],['one','other',false]]){
    const turn=chat.buildTurn({ai:'grok',model:chosen,effort:'MAX',account,meta:{sessions:{grok:'sid'},models:{grok:model.id},sessionAccounts:{grok:'one'}},rows:[],text:prompt});
    assert.equal(turn.resume,resume);assert.equal(turn.args.includes('-r'),resume);assert.equal(turn.stdin,'');assert.ok(turn.args.at(-1).includes(prompt));assert.equal(turn.args.includes('exec'),false);
  }
  assert.equal(launch.switchCommand('grok','model',model.id),'/model '+model.id);assert.equal(launch.switchCommand('grok','effort','MAX'),'/effort max');
  for(const effort of ['中','高','極高','MAX'])assert.deepEqual(roles.validate({grok:[model.id]},[{name:'code',main:{ai:'grok',model:model.id,effort},backup:{ai:'人'}}]),[]);
  assert.ok(roles.validate({grok:[model.id]},[{name:'code',main:{ai:'grok',model:model.id,effort:'Ultra'},backup:{ai:'人'}}]).length);
  assert.ok(!launch.buildArgv({ai:'grok',effort:'Ultra'}).args.includes('--effort'));
  assert.match(launch.startupInfo('grok',model.id),/Grok・grok-code-fast-1/);
});

test('Grok parses deltas/tools/end/errors without treating modelUsage as model proof',()=>{
  assert.deepEqual(chat.parse('grok',{type:'text',data:'hello'}),[{kind:'text',text:'hello'}]);
  assert.deepEqual(chat.parse('grok',{type:'thought',data:'hidden'}),[]);
  assert.deepEqual(chat.parse('grok',{type:'tool_call',title:'read',rawInput:{path:'app.js'}}),[{kind:'tool',text:'read：app.js'}]);
  const end=chat.parse('grok',{type:'end',sessionId:'sid',stopReason:'end_turn',modelUsage:{other:{}},usage:{input_tokens:42}});
  assert.equal(end[0].id,'sid');assert.equal(end[1].error,'');assert.equal(end[1].usage.input_tokens,42);
  for(const stopReason of ['refusal','cancelled'])assert.ok(chat.parse('grok',{type:'end',stopReason})[0].error);
  assert.match(chat.parse('grok',{type:'error',message:'Not signed in. Login first.'})[0].error,/AIアカウント/);
  assert.equal(chat.parse('grok',{type:'error',message:'plan limit'})[0].error,'plan limit');
});

test('Grok fake runner joins deltas, persists/resumes ID and retries only rejected effort',async()=>{
  catalogue();const root=fixture();try{
    const file=path.join(root,'fake-grok');
    fs.writeFileSync(file,`#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync('args.jsonl',JSON.stringify({args,env:process.env})+'\\n');
if(process.env.XAI_API_KEY||process.env.GROK_CODE_XAI_API_KEY||process.env.GROK_DISABLE_AUTOUPDATER!=='1')process.exit(3);
if(args.includes('--effort')){process.stderr.write('invalid --effort');process.exit(1);}
process.stdout.write([{type:'text',data:'hello'},{type:'text',data:' world'},{type:'tool_call',title:'read',rawInput:{path:'code.js'}},{type:'end',sessionId:'grok-sid',stopReason:'end_turn'}].map(x=>JSON.stringify(x)).join('\\n'));
`,{mode:0o755});
    const runner=new chat.ChatRunner(),opts={project:'p',task:'t',pdir:root,dir:root,ai:'grok',model:model.id,effort:'高',perm:file,env:{XAI_API_KEY:'secret',GROK_CODE_XAI_API_KEY:'secret'},text:'check'};
    const run=()=>new Promise(resolve=>runner.send({...opts,onEnd:resolve}));
    const first=await run();assert.equal(first.text,'hello world');assert.equal(first.error,'');assert.equal(chat.readMeta(root,'t').sessions.grok,'grok-sid');
    const second=await run();assert.equal(second.error,'');
    const calls=fs.readFileSync(path.join(root,'args.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,4);
    assert.ok(calls[2].args.includes('-r'));assert.ok(calls[3].args.includes('grok-sid'));assert.equal(chat.read(root,'t').filter(r=>r.role==='user').length,2);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Grok models/update/version preserve previous catalogue on malformed output',async()=>{
  const root=fixture();try{
    let text=output;const calls=[];
    const tools=new AiTools({root,home:root,find:ai=>ai==='grok'?'/fake/grok':'',methods:{grok:'native'},run:async(file,args)=>{calls.push(args);return args[0]==='models'?text:'grok 1.0.46';}});
    assert.deepEqual(grokModels(output),[model,{id:'grok-code-1',label:'grok-code-1'}]);
    await tools.refresh('grok');assert.equal(tools.catalog().grok.models.length,2);text='unreadable';
    await assert.rejects(tools.refresh('grok'));assert.equal(tools.catalog().grok.models.length,2);
    text=output;await tools.update('grok');assert.ok(calls.some(args=>args[0]==='update'));
    assert.equal((await tools.status()).tools.grok.version,'1.0.46');
    assert.equal((await latestVersion('grok','native',root,async url=>{assert.equal(url,'https://x.ai/cli/stable');return '1.0.47\nmetadata';})).version,'1.0.47');
    await assert.rejects(latestVersion('grok','native',root,async()=> 'evil;command'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Grok native fallback discovery and onboarding are read-only',async()=>{
  const root=fixture();const before={PATH:process.env.PATH,HUB_AI_HOME:process.env.HUB_AI_HOME};try{
    const file=path.join(root,'.grok/bin/grok');fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,`#!${process.execPath}\nif(process.env.XAI_API_KEY||process.env.GROK_CODE_XAI_API_KEY)process.exit(3);console.log(${JSON.stringify(output)});`,{mode:0o755});
    process.env.HUB_AI_HOME=root;process.env.PATH='/usr/bin:/bin';assert.equal(executable('grok'),file);assert.equal(launch.grokCommand(),file);assert.equal(methodFor('grok',file),'native');
    const o=new Onboarding({root,home:root,run:async(cmd,args)=>{assert.equal(cmd,file);assert.deepEqual(args,['models']);return {code:0,stdout:output};}});
    assert.equal(await o.login('grok',file),'ready');
    const tools=new AiTools({root,home:root,find:()=>file});const old=process.env.XAI_API_KEY;process.env.XAI_API_KEY='fixture';
    try{await tools.refresh('grok');}finally{if(old===undefined)delete process.env.XAI_API_KEY;else process.env.XAI_API_KEY=old;}
    assert.equal(tools.catalog().grok.models.length,2);
    const collected=require('../lib/transcript').collect({ai:'grok',dir:root,buf:'screen only'});assert.ok(JSON.stringify(collected).includes('screen only'));
    assert.equal(require('../lib/procwatch').aiOf('/home/.grok/bin/grok --always-approve'),'grok');
  }finally{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
});
