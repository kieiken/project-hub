'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {MuseApprovals} = require('../lib/muse-approvals');
const {MuseSettings} = require('../lib/muse-settings');
const routes = require('../lib/routes/muse-settings');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'muse-approval-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir = path.join(root,'Product','Synthetic','.ai','muse-approvals'); fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let now = Date.now(), issues = 0, dispatches = 0;
  const preview = {action_digest:'a'.repeat(64), destination:'Muse fixture', topic:'Example', packet_full_text:'FULL <script>data</script>',
    summary:'one topic',expires_at:new Date(now+3600000).toISOString(),rounds:2,max_reads:3,request:{question:'full question'}};
  const muse = {root,workspace:(p,t)=>{if(p!=='Synthetic'||t!=='task')throw Error('context');},
    approvalPreview:async()=>preview,approvalIssue:async()=>{issues++;return {id:'pmt_fixture'};}};
  const service = new MuseApprovals({muse,now:()=>now,probe:()=>{},dispatch:async r=>{dispatches++;assert.equal(r.requestKey,'muse-approval:example');return {ok:true};}});
  const file = path.join(dir,'example.json');
  const envelope = {schema:1,id:'example',project:'Synthetic',task:'task',kind:'research',request:{value:'one'},
    continuation:{role:'司令塔',text:'Continue within the approved scope.'},createdAt:new Date(now).toISOString()};
  const write = (v=envelope)=>fs.writeFileSync(file,JSON.stringify(v),{mode:0o600}); write();
  const decide = async (decision='approve')=>{
    const {approvals:[item]} = await service.list('Synthetic','task');
    return {project:'Synthetic',task:'task',id:'example',ticket:item.ticket,decision,confirm:true};
  };
  return {root,file,dir,preview,muse,service,envelope,write,decide,counts:()=>[issues,dispatches],advance:n=>{now+=n;}};
}
test('human approve issues once, journals before dispatch, and restart cannot decide again',async t=>{
  const f=fixture(t),b=await f.decide();
  assert.deepEqual(await f.service.decide(b),{ok:true,state:'accepted'});
  assert.deepEqual(f.counts(),[1,1]);
  await assert.rejects(f.service.decide(b));
  const fresh=new MuseApprovals({muse:f.muse,dispatch:()=>{throw Error('must not dispatch');}});
  const rows=await fresh.list('Synthetic','task');assert.equal(rows.approvals[0].state,'accepted');assert.equal(rows.approvals[0].ticket,undefined);
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'.decisions/task/example.json')));
  assert.equal(saved.grant.id,'pmt_fixture');assert.equal(saved.state,'accepted');
});
test('decline and simultaneous duplicate never issue additional authority or continuation',async t=>{
  const f=fixture(t),b=await f.decide('decline');
  const result=await Promise.allSettled([f.service.decide(b),f.service.decide(b)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.counts(),[0,0]);
});
test('an unavailable or expired preview gets no ticket and cannot hide another pending request',async t=>{
  const f=fixture(t);
  const other=path.join(f.dir,'other.json');
  fs.writeFileSync(other,JSON.stringify({...f.envelope,id:'other'}),{mode:0o600});
  f.muse.approvalPreview=async(p,task,file)=>{if(file===f.file)throw Error('expired scope');return f.preview;};
  const rows=(await f.service.list('Synthetic','task')).approvals;
  assert.equal(rows.find(r=>r.id==='example').state,'unavailable');
  assert.equal(rows.find(r=>r.id==='example').ticket,undefined);
  assert.equal(rows.find(r=>r.id==='other').state,'pending');
  assert.equal(f.service.tickets.size,1);assert.deepEqual(f.counts(),[0,0]);
});
test('simultaneous approves reserve the ID before awaiting helper completion',async t=>{
  const f=fixture(t),b=await f.decide();
  const result=await Promise.allSettled([f.service.decide(b),f.service.decide(b)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.counts(),[1,1]);
});
test('changed bytes, expired tickets, other tasks and ID reuse fail closed',async t=>{
  for(const mode of ['bytes','expiry','task','id']){
    const f=fixture(t),b=await f.decide();
    if(mode==='bytes')f.write({...f.envelope,request:{value:'changed'}});
    if(mode==='expiry')f.advance(600000);
    if(mode==='task')b.task='other';
    if(mode==='id')b.id='../example';
    await assert.rejects(f.service.decide(b));assert.deepEqual(f.counts(),[0,0]);
  }
});
test('response unknown from either grant or continuation is durable and never resent',async t=>{
  for(const stage of ['grant','continuation']){
    const f=fixture(t),b=await f.decide();
    if(stage==='grant')f.muse.approvalIssue=async()=>{throw Error('lost response');};
    else f.service.dispatch=async()=>{throw Error('accepted but response lost');};
    const r=await f.service.decide(b);assert.equal(r.state,'unknown');
    await assert.rejects(f.service.decide(b));
    const row=(await f.service.list('Synthetic','task')).approvals[0];assert.equal(row.state,'unknown');assert.equal(row.ticket,undefined);
  }
});
test('file links, unsafe modes, envelope mismatch and changed during preview are refused',async t=>{
  for(const mode of ['link','permissions','context','race']){
    const f=fixture(t);
    if(mode==='link'){fs.renameSync(f.file,f.file+'.old');fs.symlinkSync(f.file+'.old',f.file);}
    if(mode==='permissions')fs.chmodSync(f.file,0o644);
    if(mode==='context')f.write({...f.envelope,project:'Other'});
    if(mode==='race')f.muse.approvalPreview=async()=>{f.write({...f.envelope,request:{value:'changed'}});return f.preview;};
    await assert.rejects(f.service.list('Synthetic','task'));assert.deepEqual(f.counts(),[0,0]);
  }
});
test('decision endpoint requires exact browser origin, Hub marker, confirm and strict schema',async t=>{
  const f=fixture(t),send=(res,status,body)=>({status,body});
  const r=routes({send,PORT:4545,fromRemote:()=>false,muse:f.muse,approvalProbe:()=>{},approvalDispatch:async()=>({ok:true})});
  const url=new URL('http://127.0.0.1:4545/api/muse/approvals');
  const req={method:'GET',headers:{'x-hub':'1'}};
  const list=await r.read.handle(req,{},new URL(url+'?project=Synthetic&task=task'));
  assert.equal(list.status,200);
  const b={project:'Synthetic',task:'task',id:'example',ticket:list.body.approvals[0].ticket,decision:'approve',confirm:true,generation:3};
  url.pathname+='/decide';assert.equal(r.write.matches({method:'POST'},url),true);
  for(const headers of [{'x-hub':'1'},{'x-hub':'1',origin:'https://foreign.invalid'},{origin:'http://127.0.0.1:4545'}]){
    assert.equal((await r.write.handle({headers},{},url,b)).status,403);
  }
  const headers={'x-hub':'1',origin:'http://127.0.0.1:4545'};
  for(const bad of [{...b,confirm:false},{...b,generation:'3'},{...b,command:'bad'},{...b,decision:'send'}]){
    assert.equal((await r.write.handle({headers},{},url,bad)).status,400);
  }
  assert.deepEqual(f.counts(),[0,0]);assert.equal((await r.write.handle({headers},{},url,b)).status,200);
});
test('service projects previews and grants and launcher always uses offline control arguments',async t=>{
  const f=fixture(t),calls=[];let stdout;
  const s=new MuseSettings({root:f.root,run:async(...args)=>{calls.push(args);return {stdout:JSON.stringify(stdout)};}});
  s.workspace=()=>({tool:'/synthetic/pinned'});
  stdout={...f.preview,cookie:'SECRET'};
  assert.equal(JSON.stringify(await s.approvalPreview('Synthetic','task',f.file)).includes('SECRET'),false);
  stdout={status:'ok',data:{id:'pmt_test',auth_ref:'SECRET'}};
  assert.deepEqual(await s.approvalIssue('Synthetic','task',f.file,'a'.repeat(64)),{id:'pmt_test'});
  assert.ok(calls[1][1].includes('--checked-digest'));assert.ok(calls[1][1].includes('approval-issue'));assert.ok(!calls[1][1].includes('--run'));
  stdout={status:'error',data:{id:'pmt_test'}};await assert.rejects(s.approvalIssue('Synthetic','task',f.file,'a'.repeat(64)));
});
function uiFixture() {
  const UI={text:String,html:String,template:(s,...v)=>s.reduce((out,p,i)=>out+p+(v[i]??''),'')};
  const host={innerHTML:'',museEpoch:0},calls=[];
  let resolve;
  const row={id:'example',state:'pending',ticket:'ticket',preview:{destination:'Muse',topic:'Topic',packet_full_text:'FULL <tag>',expires_at:'future',rounds:2,max_reads:3,request:{question:'exact'},summary:'scope'}};
  const context=vm.createContext({UI,esc:v=>String(v).replaceAll('<','&lt;'),URLSearchParams,view:{kind:'work',project:'Synthetic',task:'task'},
    $:key=>key==='#muse-approvals'?host:null,confirm:()=>true,
    api:async(...args)=>{calls.push(args);if(args[0].includes('/decide'))return new Promise(r=>{resolve=r;});return {approvals:[row]};}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app-work.js'),'utf8'),context);
  const card={dataset:{museApproval:'example'},querySelectorAll:()=>buttons,innerHTML:''};
  const buttons=['approve','decline'].map(decision=>({dataset:{museDecision:decision},disabled:false,closest:()=>card}));
  return {context,host,card,buttons,calls,finish:()=>resolve({state:'accepted'}),click:()=>host.onclick({target:{closest:()=>buttons[0]}})};
}
test('work card shows full review without input fields; confirm precedes one disabled decision',async()=>{
  const f=uiFixture();await f.context.loadMuseApprovals('Synthetic','task');
  assert.match(f.host.innerHTML,/FULL &lt;tag>/);assert.match(f.host.innerHTML,/exact/);assert.match(f.host.innerHTML,/承認して続ける/);
  assert.doesNotMatch(f.host.innerHTML,/<input|<textarea/);
  f.context.confirm=()=>false;await f.click();assert.equal(f.calls.length,1);
  f.context.confirm=()=>true;const pending=f.click();assert.ok(f.buttons.every(b=>b.disabled));
  await f.click();assert.equal(f.calls.length,2);f.finish();await pending;assert.match(f.card.innerHTML,/受け付けました/);
});
test('late list after navigation does not draw a different task approval',async()=>{
  const f=uiFixture();let done;f.context.api=()=>new Promise(r=>{done=r;});
  const pending=f.context.loadMuseApprovals('Synthetic','task');f.context.view.task='Other';
  done({approvals:[]});await pending;assert.equal(f.host.innerHTML,'');
});
