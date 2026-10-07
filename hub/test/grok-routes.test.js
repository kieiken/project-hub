'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chat = require('../lib/chat');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-grok-api-')));
const root = path.join(tmp,'workspace'),bin=path.join(tmp,'bin');
const port=48000+Math.floor(Math.random()*1000);
const key={project:'サンプルアプリ',task:'sample-app-01'};
const taskDir=path.join(root,'Product',key.project),model='grok-code-fast-1';
let server,sessions,base,named;
const post=(route,body={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...key,...body})});
const json=async(route,body)=>{const r=await post(route,body),d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;};
async function reply(n){for(let i=0;i<100;i++){const rows=chat.read(taskDir,key.task).filter(x=>x.role==='assistant');if(rows.length===n)return rows.at(-1);await new Promise(r=>setTimeout(r,30));}assert.fail('fake Grok did not finish');}
test.before(async()=>{
 execFileSync('bash',[path.join(__dirname,'../setup.sh')],{env:{...process.env,HUB_ROOT:root,HOME:tmp,HUB_SKIP_NPM:'1'},stdio:'ignore'});
 fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'grok'),`#!${process.execPath}
const args=process.argv.slice(2);
if(process.env.XAI_API_KEY||process.env.GROK_CODE_XAI_API_KEY)process.exit(3);
if(args.includes('--version')){console.log('1.0.46');process.exit(0);}
if(args.includes('models')){console.log('You are logged in with x.ai.\\nAvailable models:\\n  * ${model} (default)');process.exit(0);}
if(args.includes('logout'))process.exit(0);
if(args.includes('-p')){const send=x=>console.log(JSON.stringify(x));
if(args.at(-1).endsWith('WAIT'))setInterval(()=>{},1000);
else if(args.at(-1).endsWith('NOT_LOGIN')){send({type:'error',message:'Not signed in. Use grok login.'});process.exit(1);}
else {send({type:'text',data:JSON.stringify({args,home:process.env.GROK_HOME,updater:process.env.GROK_DISABLE_AUTOUPDATER})});send({type:'end',sessionId:'grok-route-session',stopReason:'end_turn'});}}
else {console.log('PTY_GROK_READY');process.stdin.on('data',d=>process.stdout.write(d));setInterval(()=>{},1000);}
`,{mode:0o755});
 fs.writeFileSync(path.join(root,'_hub/ai-tools-models.json'),JSON.stringify({grok:{models:[{id:model,label:model}],known:[{id:model,label:model}],source:'fixture'}}));
 process.env.PATH=bin+':/usr/bin:/bin';process.env.HUB_ROOT=root;process.env.HUB_PORT=String(port);process.env.HUB_DRY_RUN='1';process.env.HUB_AI_HOME=path.join(tmp,'home');process.env.XAI_API_KEY='fixture';process.env.GROK_CODE_XAI_API_KEY='fixture';
 ({server,sessions}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server?.listening)await post('/api/chat/stop');sessions?.stopAll();if(server)await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});

test('Grok state/catalog/accounts/select and roles keep default assignments',async()=>{
 const state=await(await fetch(base+'/api/state')).json();assert.equal(state.grokAvailable,true);assert.deepEqual(state.roles.models.grok,[model]);assert.equal(state.roles.roles.find(r=>r.name==='コーディング').main.ai,'codex');assert.equal(state.cliFlags.grok[model],model);
 const list=await(await fetch(base+'/api/accounts')).json();assert.equal(list.accounts.filter(r=>r.ai==='grok').length,1);
 named=(await json('/api/accounts',{ai:'grok',name:'仕事'})).account;
 assert.equal(path.basename(path.dirname(named.dir)),'grok');assert.deepEqual(fs.readdirSync(named.dir),[]);
 await json('/api/accounts/select',{ai:'grok',id:named.id});assert.equal(chat.readMeta(taskDir,key.task).accounts.grok,named.id);
 const login=await json('/api/accounts/login',{ai:'grok',id:named.id});assert.match(login.command,/GROK_HOME=/);assert.match(login.command,/'grok' 'login'/);assert.match(login.command,/'-u' 'XAI_API_KEY'/);assert.match(login.command,/'-u' 'GROK_AUTH_PATH'/);
 const roles=JSON.parse(JSON.stringify(state.roles.roles));roles.find(r=>r.name==='調査').main={ai:'grok',model,effort:'高'};
 await json('/api/roles',{roles});assert.equal((await(await fetch(base+'/api/state')).json()).roles.roles.find(r=>r.name==='調査').main.ai,'grok');
 const hints=await(await fetch(base+'/api/cli-models')).json();assert.ok(hints.grok.some(x=>x.name===model));
});

test('Grok terminal/external terminal preserve selected home and positional prompt',async()=>{
 await json('/api/task',{model,effort:'MAX'});
 const term=await json('/api/term/start',{ai:'grok',model,effort:'MAX',account:named.id});
 assert.equal(term.command,'grok');assert.ok(term.args.includes('-m'));assert.ok(term.args.includes('max'));assert.ok(!term.args.includes('exec'));assert.equal(term.accountEnv.GROK_HOME,named.dir);
 const external=await json('/api/continue',{ai:'grok',account:named.id});assert.match(external.command,/GROK_HOME=/);assert.match(external.command,/'-u' 'XAI_API_KEY'/);
 assert.equal((await post('/api/term/switch',{ai:'grok',field:'effort',value:'Ultra'})).status,400);
 assert.equal((await json('/api/term/switch',{ai:'grok',field:'effort',value:'高'})).command,'/effort high');
});

test('Grok chat joins text, resumes same account and starts fresh after selection changes',async()=>{
 const say=(text,account=named.id,effort='高')=>post('/api/chat/send',{ai:'grok',model,effort,account,text});
 assert.equal((await say('first')).status,200);let row=await reply(1);assert.equal(row.error,'');let result=JSON.parse(row.text);assert.equal(result.home,named.dir);assert.equal(result.updater,'1');assert.ok(!result.args.includes('-r'));
 assert.equal((await say('second')).status,200);row=await reply(2);assert.ok(JSON.parse(row.text).args.includes('grok-route-session'));
 assert.equal((await say('third','default')).status,200);row=await reply(3);assert.ok(!JSON.parse(row.text).args.includes('-r'));
 assert.equal((await say('NOT_LOGIN')).status,200);row=await reply(4);assert.match(row.error,/AIアカウント/);
 assert.equal((await say('bad',named.id,'Ultra')).status,400);
});

test('Grok delegate queues exact model, stop and busy protections cover named account',async()=>{
 assert.equal((await post('/api/chat/send',{ai:'grok',model,account:named.id,text:'WAIT'})).status,200);
 assert.equal((await post('/api/accounts/logout',{ai:'grok',id:named.id,confirm:true})).status,409);
 const queued=await json('/api/delegate',{ai:'grok',model,effort:'高',title:'queue',text:'pending'});assert.ok(queued.queued);
 assert.equal((await post('/api/accounts/delete',{ai:'grok',id:named.id,confirm:true})).status,409);
 await json('/api/chat/stop');assert.equal((await reply(5)).error,'止めました');
 assert.equal((await post('/api/accounts/logout',{ai:'grok',confirm:true})).status,400);
 assert.equal((await json('/api/accounts/logout',{ai:'grok',id:named.id,confirm:true})).args[0],'logout');
});

test('Grok PTY strips API keys, uses selected home and hands off screen only',async()=>{
 assert.ok(sessions.available(),'node-pty must be available for PTY test');
 sessions.start({...key,ai:'grok',dir:tmp,account:named.id,command:'grok',args:[],env:{PATH:bin+':/usr/bin:/bin',XAI_API_KEY:'fixture',GROK_CODE_XAI_API_KEY:'fixture'}});
 try{
 for(let i=0;i<50&&!sessions.get(key.project,key.task,'grok').buf.includes('PTY_GROK_READY');i++)await new Promise(r=>setTimeout(r,30));
 assert.ok(sessions.get(key.project,key.task,'grok').buf.includes('PTY_GROK_READY'));
 sessions.get(key.project,key.task,'grok').lastOut=0;
 await json('/api/task',{model:'GPT-6.1-Sol',effort:'高'});
 const result=await json('/api/term/handoff',{from:'grok',to:'codex'});assert.equal(result.kind,'screen');assert.ok(fs.readFileSync(result.packet,'utf8').includes('PTY_GROK_READY'));
 }finally{sessions.stopAll();}
});
