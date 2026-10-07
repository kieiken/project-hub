'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const chat=require('../lib/chat');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-removal-http-')),root=path.join(tmp,'workspace'),bin=path.join(tmp,'bin'),home=path.join(tmp,'home');
let server,sessions,base,count=0;const fixtures=[];
const post=(route,b,headers={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close',...headers},body:JSON.stringify(b)});
async function ok(route,b){const r=await post(route,b),d=await r.json();assert.equal(r.status,200,d.error);return d;}
function fixture(){const project='P'+ ++count,dir=path.join(root,'Product',project),outside=path.join(tmp,'Outside'+count);fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'x'),'original');fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: ${project}\nfolders:\n  本体: ${outside}\nrelated: []\n---\n`);const f={project,dir,outside};fixtures.push(f);return f;}
async function wait(pred){for(let i=0;i<300;i++){if(pred())return;await new Promise(r=>setTimeout(r,10));}assert.ok(pred(),'mock completed');}
test.before(async()=>{
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.mkdirSync(path.join(root,'Product'));fs.mkdirSync(bin);fs.mkdirSync(home);
 fs.writeFileSync(path.join(root,'_hub/roles.yaml'),'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [Astra, GPT-6.1-Sol]\nroles:\n  チェック: { main: [claude-code, Fable 5.1, 高], backup: [codex, Astra, 高] }\nswitch:\n  auto: true\n');
 for(const ai of ['claude','codex'])fs.writeFileSync(path.join(bin,ai),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const dir=process.cwd(),project=path.basename(dir),args=process.argv.slice(2),out=x=>console.log(JSON.stringify(x));
 const captured=path.join(${JSON.stringify(tmp)},project+'-args-${ai}.json');
 fs.writeFileSync(captured+'.tmp',JSON.stringify({args,input,cwd:dir,api:process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY||null}));fs.renameSync(captured+'.tmp',captured);
 const candidates=JSON.parse(input.split('\\n').find(line=>line.startsWith('[{"id":"external:')));
 const finish=()=>{if(${JSON.stringify(ai)}==='claude'&&fs.existsSync(path.join(${JSON.stringify(tmp)},project+'-limit'))){out({type:'result',is_error:true,subtype:'error_during_execution',error:'rate_limit',result:"You've reached your Fable limit. Switch to another model."});return;}
 const text=JSON.stringify({results:candidates.map(x=>({id:x.id,sharing:'なし',reason:'mock:用途と他台帳を照合'}))});
 if(${JSON.stringify(ai)}==='claude'){out({type:'assistant',message:{content:[{type:'text',text}]}});out({type:'result',is_error:false,result:''});}else{out({type:'item.completed',item:{type:'agent_message',text}});out({type:'turn.completed'});}};
 const timer=setInterval(()=>{if(fs.existsSync(path.join(${JSON.stringify(tmp)},project+'-release'))){clearInterval(timer);finish();}},10);
});`,{mode:0o755});
 const reserve=require('node:net').createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 Object.assign(process.env,{PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_AI_HOME:home,HUB_TRASH:path.join(tmp,'Trash'),HUB_DRY_RUN:'1',HUB_PORT:String(port)});
 ({server,sessions}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{
 // 途中でassertが失敗しても、待機中の模擬会話を残さない。
 for(const f of fixtures){const tasks=path.join(f.dir,'.ai/tasks');if(fs.existsSync(tasks))for(const name of fs.readdirSync(tasks).filter(n=>n.endsWith('.md')))await ok('/api/chat/stop',{project:f.project,task:name.slice(0,-3)});}
 sessions.stopAll();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});
});
test('HTTP review uses fixed Fable and read tools, refuses concurrent deletion/review and refreshes token before removal/restore',async()=>{
 const f=fixture(),d=await ok('/api/hierarchy/remove/preview',{project:f.project});assert.equal((await post('/api/hierarchy/remove/review/start',{token:d.token},{'X-Hub':''})).status,403);
 const r=await ok('/api/hierarchy/remove/review/start',{token:d.token});await wait(()=>fs.existsSync(path.join(tmp,f.project+'-args-claude.json')));
 const info=JSON.parse(fs.readFileSync(path.join(tmp,f.project+'-args-claude.json')));assert.equal(info.args[info.args.indexOf('--model')+1],'claude-fable-5-1');assert.equal(info.args[info.args.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(info.cwd,f.dir);assert.ok(info.args.includes(f.outside));assert.ok(info.args.includes(path.join(root,'Product')));assert.equal(info.args[info.args.indexOf('--allowedTools')+1],'Read,Glob,Grep');assert.equal(info.api,null);assert.ok(!info.args.includes('--dangerously-skip-permissions'));
 assert.equal((await post('/api/hierarchy/remove/apply',{token:d.token,confirm:true})).status,409);assert.equal((await post('/api/hierarchy/remove/review/start',{token:d.token})).status,409);
 assert.equal((await post('/api/chat/send',{project:f.project,task:r.task,ai:'claude',text:'modify files',model:'claude-opus-5-5'})).status,409);
 assert.equal((await ok('/api/hierarchy/remove/review/status',{project:f.project})).review.status,'running');
 fs.writeFileSync(path.join(tmp,f.project+'-release'),'yes');await wait(()=>chat.read(f.dir,r.task).some(x=>x.role==='assistant'));
 const status=await ok('/api/hierarchy/remove/review/status',{project:f.project});assert.equal(status.review.status,'done');assert.ok(status.preview.token);assert.equal(status.preview.blockers.length,0);assert.equal(fs.existsSync(path.join(root,'Work',f.project)),false);
 assert.equal((await post('/api/hierarchy/remove/apply',{token:d.token,confirm:true})).status,409);
 const moved=await ok('/api/hierarchy/remove/apply',{token:status.preview.token,confirm:true,optional:[status.preview.keep[0].id]});assert.equal(moved.moved.length,2);assert.equal(fs.existsSync(f.outside),false);
 const restored=await ok('/api/hierarchy/remove/restore',{record:moved.record,confirm:true});assert.equal(restored.restored,2);assert.equal(fs.readFileSync(path.join(f.outside,'x'),'utf8'),'original');
});
test('stopping a review and reopening reports failed, preserves external data and allows manual selection',async()=>{
 const f=fixture(),d=await ok('/api/hierarchy/remove/preview',{project:f.project}),r=await ok('/api/hierarchy/remove/review/start',{token:d.token});await wait(()=>fs.existsSync(path.join(tmp,f.project+'-args-claude.json')));
 await ok('/api/chat/stop',{project:f.project,task:r.task});await wait(()=>chat.read(f.dir,r.task).some(x=>x.role==='assistant'));
 const next=await ok('/api/hierarchy/remove/preview',{project:f.project});assert.equal(next.review.status,'failed');assert.equal(next.review.results.length,0);assert.equal(next.blockers.length,0);assert.equal(fs.existsSync(f.outside),true);
});
test('formal Fable limit continues in read-only Astra and records one completed result',async()=>{
 const f=fixture();fs.writeFileSync(path.join(tmp,f.project+'-limit'),'yes');const d=await ok('/api/hierarchy/remove/preview',{project:f.project}),r=await ok('/api/hierarchy/remove/review/start',{token:d.token});
 await wait(()=>fs.existsSync(path.join(tmp,f.project+'-args-claude.json')));fs.writeFileSync(path.join(tmp,f.project+'-release'),'yes');
 await wait(()=>chat.read(f.dir,r.task).some(x=>x.role==='assistant'&&x.ai==='codex'));
 const info=JSON.parse(fs.readFileSync(path.join(tmp,f.project+'-args-codex.json')));assert.equal(info.args[info.args.indexOf('--model')+1],'gpt-6-astra');assert.equal(info.args[info.args.indexOf('--sandbox')+1],'read-only');assert.ok(info.args.includes('mcp_servers={}'));assert.ok(!info.args.includes('--dangerously-bypass-approvals-and-sandbox'));
 const status=await ok('/api/hierarchy/remove/review/status',{project:f.project});assert.equal(status.review.status,'done');assert.equal(status.review.results.length,1);
 await ok('/api/limits/fable/clear',{});
});
test('saved read-only continuation after restart uses review directory and cannot inherit unrestricted permissions',async()=>{
 const f=fixture(),d=await ok('/api/hierarchy/remove/preview',{project:f.project}),task='restart-review',id='saved-review',queued='limit-'+id;
 fs.mkdirSync(path.join(f.dir,'.ai/tasks'),{recursive:true});fs.mkdirSync(path.join(f.dir,'.ai/chat'));fs.mkdirSync(path.join(f.dir,'.ai/work'));
 fs.writeFileSync(path.join(f.dir,'.ai/tasks',task+'.md'),'---\nid: restart-review\ntitle: 削除前の共有確認\nrole: チェック\nstate: 実行中\nworkspaceMode: direct\n---\n## 手順\n- [ ] 外の場所を確認\n');
 fs.writeFileSync(path.join(f.dir,'.ai/work/remove-sharing.json'),JSON.stringify({id,task,status:'running',candidates:d.keep,results:[],error:''}));
 fs.writeFileSync(path.join(f.dir,'.ai/chat',task+'.queue.json'),JSON.stringify([{id:queued,ai:'codex',model:'gpt-6-astra',requiredModel:'gpt-6-astra',requireModel:true,role:'チェック',readOnly:true,perm:'codex --dangerously-bypass-approvals-and-sandbox',text:JSON.stringify(d.keep.map(({id,path})=>({id,path})))}]));
 fs.writeFileSync(path.join(tmp,f.project+'-release'),'yes');await ok('/api/chat/send',{project:f.project,task,fromQueue:queued});await wait(()=>chat.read(f.dir,task).some(x=>x.role==='assistant'));
 const info=JSON.parse(fs.readFileSync(path.join(tmp,f.project+'-args-codex.json')));assert.equal(info.cwd,f.dir);assert.equal(info.args[info.args.indexOf('--sandbox')+1],'read-only');assert.ok(!info.args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.equal((await ok('/api/hierarchy/remove/review/status',{project:f.project})).review.status,'done');assert.equal(fs.existsSync(path.join(root,'Work',f.project)),false);
});
