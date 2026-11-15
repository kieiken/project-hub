'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const { Usage }=require('../lib/usage');
const { ModelLimits }=require('../lib/model-limits');
const { checkTicket }=require('../lib/reset-tickets');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-reset-tickets-'));
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const NOW=Date.parse('2026-10-10T00:00:00Z');
const data=(account='default')=>({accountId:'PRIVATE-ACCOUNT-'+account,rateLimits:{primary:{usedPercent:50,windowDurationMins:10080,resetsAt:(NOW+86400000)/1000}},rateLimitResetCredits:{availableCount:1,credits:[{id:'PRIVATE-CREDIT-'+account,status:'available',resetType:'codexRateLimits',title:'Full reset',expiresAt:(NOW+86400000)/1000}]}});
const accounts={list:()=>['default','work'].map(id=>({ai:'codex',id,name:id})),status:async()=>({status:'logged-in'})};
const setup=(options={})=>new Usage({accounts,now:()=>NOW,find:()=> 'fake-cli',read:async(ai,file,{account})=>data(account),...options});
const token=u=>u.snapshot().providers.codex.resetCredits.items[0].action.token;
test('Public ticket actions hide account IDs, ticket IDs and idempotency keys; unknown types and expiry have no action',async()=>{
  const u=setup();await u.status();assert.doesNotMatch(JSON.stringify(u.snapshot()),/PRIVATE|idempotencyKey|accountId/);
  const t=token(u);await u.status(true);assert.equal(token(u),t);
  for (const item of [{expiresAt:1},{resetType:'unknown'},{status:'redeeming'},{id:''},{expiresAt:'bad'},{expiresAt:Infinity},{expiresAt:1791046922000}]) {
    const v=setup({read:async()=>{const d=data();Object.assign(d.rateLimitResetCredits.credits[0],item);return d;}});await v.status();
    assert.equal(v.snapshot().providers.codex.resetCredits?.items?.[0]?.action,undefined);
  }
});
test('Confirmation, wrong account, stale auth and concurrent use reject before consumption',async()=>{
  let calls=0,release;
  const u=setup({consume:async(file,o)=>{calls++;o.consume.beforeSend();await new Promise(r=>release=r);return{outcome:'reset'};}});await u.status();
  const t=token(u);
  await assert.rejects(u.useReset('default',t,{}));await assert.rejects(u.useReset('work',t,{confirmed:true}));assert.equal(calls,0);
  const p=u.useReset('default',t,{confirmed:true});await assert.rejects(u.useReset('default',t,{confirmed:true}),/busy/);assert.equal(calls,1);
  assert.equal(u.resetBusy.has('codex'),true);release();await p;assert.equal(u.resetBusy.size,0);
  await assert.rejects(u.useReset('default',t,{confirmed:true}));
  const next=token(u);u.invalidate('codex');await assert.rejects(u.useReset('default',next,{confirmed:true}));assert.equal(calls,1);
});
test('Unknown consumption survives restart; only explicit manual retry reuses the same idempotency key',async()=>{
  const file=path.join(dir,'attempts.json'), sent=[];
  const consume=async(file,o)=>{o.consume.beforeSend();sent.push(o.consume);throw Object.assign(Error('SECRET'),{consumeSent:true});};
  const u=setup({resetFile:file,consume});await u.status();const t=token(u);
  const r=await u.useReset('default',t,{confirmed:true});assert.equal(r.unknown,true);assert.equal(sent.length,1);assert.match(r.message,/不明/);
  await u.status(true);assert.equal(sent.length,1);assert.equal(token(u),t);assert.equal(u.snapshot().providers.codex.resetCredits.items[0].action.retry,true);
  await assert.rejects(u.useReset('default',t,{confirmed:true}),/uncertain/);
  const v=setup({resetFile:file,consume});await v.status();assert.equal(token(v),t);
  await v.useReset('default',t,{confirmed:true,retry:true});assert.equal(sent.length,2);assert.equal(sent[0].idempotencyKey,sent[1].idempotencyKey);
  assert.equal(fs.statSync(file).mode & 0o777,0o600);assert.doesNotMatch(fs.readFileSync(file,'utf8'),/PRIVATE/);
});
test('Reset alone clears only the target account models; fresh 100% can restore its hold',async()=>{
  for(const outcome of ['reset','nothingToReset','noCredit','alreadyRedeemed']) {
    let now=NOW;
    const limits=new ModelLimits(path.join(dir,outcome+'.json'),{now:()=>now});
    limits.record({ai:'codex',model:'gpt-6.1-sol',account:'default',limitError:'limit'});limits.record({ai:'codex',model:'gpt-6.1-sol',account:'work',limitError:'limit'});limits.record({ai:'claude',model:'claude-fable-5-2'});
    now++;
    const u=setup({now:()=>now,observe:s=>limits.observe(s),onReset:account=>{limits.clearAccount('codex',account);now++;},consume:async(file,o)=>{o.consume.beforeSend();return{outcome};}});
    await u.status();const r=await u.useReset('default',token(u),{confirmed:true});assert.equal(r.outcome,outcome);
    for(const model of ['gpt-6.1-sol','gpt-6-astra'])assert.equal(Boolean(limits.active('default',model)),outcome!=='reset');
    assert.ok(limits.active('work','gpt-6.1-sol'));assert.ok(limits.active('default','claude-fable-5-2'));
    if(outcome==='reset') {now+=31000;u.read=async(ai,file,{account})=>{const d=data(account);d.rateLimits.primary.usedPercent=100;return d;};await u.status(true);assert.ok(limits.active('default','gpt-6.1-sol'));}
  }
});
test('Broken or unwritable journal prevents sending; stale in-flight reads prevent use',async()=>{
  const file=path.join(dir,'broken.json');fs.writeFileSync(file,'bad');let calls=0;
  const u=setup({resetFile:file,consume:async()=>calls++});await u.status();assert.equal(u.snapshot().providers.codex.resetCredits.items[0].action,undefined);
  const v=setup();await v.status();const t=token(v);v.inflight.set('codex',Promise.resolve());await assert.rejects(v.useReset('default',t,{confirmed:true}),/busy/);assert.equal(calls,0);
});
test('Count-only tickets display their official count and use an opaque automatic-selection action',async()=>{
  const u=setup({read:async()=>{const d=data();d.rateLimitResetCredits.credits=null;return d;}});await u.status();
  const r=u.snapshot().providers.codex.resetCredits;assert.equal(r.count,1);assert.deepEqual(r.items,[]);assert.ok(r.action.token);
  checkTicket({...data(),rateLimitResetCredits:{availableCount:1,credits:null}},{accountId:'PRIVATE-ACCOUNT-default'},NOW);
  assert.throws(()=>checkTicket(data(),{accountId:'PRIVATE-ACCOUNT-work'},NOW));
});
test('An uncertain count-only request keeps its key when details appear; missing details cannot bypass a pending specific request',async()=>{
  const file=path.join(dir,'count-transition.json');let detailed=false;const keys=[];
  const u=setup({resetFile:file,read:async()=>{const d=data();if(!detailed)d.rateLimitResetCredits.credits=null;return d;},consume:async(file,o)=>{o.consume.beforeSend();keys.push(o.consume.idempotencyKey);throw Object.assign(Error('fixture timeout'),{consumeSent:true});}});
  await u.status();const r=u.snapshot().providers.codex.resetCredits;detailed=true;
  await u.useReset('default',r.action.token,{confirmed:true});const next=u.snapshot().providers.codex.resetCredits;
  assert.equal(next.action.token,r.action.token);assert.equal(next.items[0].action,undefined);
  await u.useReset('default',next.action.token,{confirmed:true,retry:true});assert.equal(keys[0],keys[1]);
  const v=setup({resetFile:path.join(dir,'specific-transition.json'),consume:async(file,o)=>{o.consume.beforeSend();throw Object.assign(Error('fixture'),{consumeSent:true});}});
  await v.status();await v.useReset('default',token(v),{confirmed:true});v.read=async()=>{const d=data();d.rateLimitResetCredits.credits=null;return d;};v.lastAttempt.clear();await v.status(true);
  assert.equal(v.snapshot().providers.codex.resetCredits.action,undefined);
});
