'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {Usage}=require('../lib/usage'), {checkTicket}=require('../lib/reset-tickets');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-reset-http-'))), root=path.join(tmp,'root');
let server,base,mode='reset',calls=0,release;
const data=account=>({accountId:'PRIVATE-'+account,rateLimits:{primary:{usedPercent:50,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+3600}},rateLimitResetCredits:{availableCount:1,credits:[{id:'PRIVATE-CREDIT',status:'available',resetType:'codexRateLimits',expiresAt:Math.floor(Date.now()/1000)+7200,title:'Full reset'}]}});
const original=Usage.prototype.status;
Usage.prototype.status=function(...args){
  this.dry=false;this.find=()=> 'fake-cli';this.read=async(ai,file,{account})=>ai==='codex'?data(account):{subscription_type:'max',rate_limits:{five_hour:{utilization:5}}};
  this.consume=async(file,o)=>{checkTicket(data(o.account),o.consume);o.consume.beforeSend();calls++;if(mode==='hold')await new Promise(r=>release=r);if(mode==='unknown')throw Object.assign(Error('SECRET'),{consumeSent:true});return{outcome:mode==='hold'?'reset':mode};};
  return original.apply(this,args);
};
const post=(body,headers={})=>fetch(base+'/api/usage/reset',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close',...headers},body:JSON.stringify(body)});
async function read(){const r=await fetch(base+'/api/usage',{headers:{'X-Hub':'1',Connection:'close'}});assert.equal(r.status,200);return r.json();}
const request=async()=>{const s=await read();return{ai:'codex',account:'default',confirmed:true,token:s.providers.codex.resetCredits.items[0].action.token};};
test.before(async()=>{
  fs.mkdirSync(path.join(root,'Product','Fixture','.ai/tasks'),{recursive:true});fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.writeFileSync(path.join(root,'Product','Fixture','PROJECT.md'),'---\nname: Fixture\nstatus: 進行中\nfolders: {}\nphases: []\n---\n');
  fs.writeFileSync(path.join(root,'_hub','roles.yaml'),'models:\n  claude-code: [Fable 5.2, Opus 5.5]\n  codex: [GPT-6.1-Sol, Astra]\nroles: {}\nswitch:\n  auto: true\n');
  Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:path.join(tmp,'home'),HUB_DRY_RUN:'1',HUB_PORT:String(54000+Math.floor(Math.random()*1000)),PATH:'/usr/bin:/bin'});
  ({server}=require('../server'));await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{Usage.prototype.status=original;await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('HTTP requires Hub, same origin, confirmation and a valid displayed action; no real CLI is used',async()=>{
  const b=await request();
  for(const headers of [{'X-Hub':''},{Origin:'https://evil.test'}])assert.equal((await post(b,headers)).status,403);
  for(const body of [{...b,ai:'claude'},{...b,confirmed:false},{...b,account:null}])assert.equal((await post(body)).status,400);
  assert.equal((await post({...b,token:'wrong'})).status,409);assert.equal((await post({...b,account:'missing'})).status,409);
  assert.equal(calls,0);const r=await post(b);assert.equal(r.status,200);const s=await r.json();assert.equal(s.outcome,'reset');assert.doesNotMatch(JSON.stringify(s),/PRIVATE|idempotencyKey/);
  assert.equal((await post(b)).status,409);assert.equal(calls,1);
});
test('HTTP account lock blocks parallel posts and unknown results require an explicit retry',async()=>{
  mode='hold';const b=await request(), pending=post(b);
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
  assert.equal((await post(b)).status,409);release();assert.equal((await pending).status,200);
  mode='unknown';const u=await request(), before=calls;const r=await (await post(u)).json();assert.equal(r.unknown,true);assert.equal(calls,before+1);
  assert.equal((await post(u)).status,409);assert.equal(calls,before+1);
  const next=await request();assert.equal(next.token,u.token);mode='alreadyRedeemed';const s=await (await post({...next,retry:true})).json();assert.equal(s.outcome,'alreadyRedeemed');assert.equal(calls,before+2);
});
