'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ModelLimits,MAX_AGE}=require('../lib/model-limits'),{amount}=require('../lib/credit-exception');
const {ChatRunner}=require('../lib/chat');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-credit-exception-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=Date.now();
  const state=new ModelLimits(path.join(dir,'limits.json'),{now:()=>now});
  const snapshot=(balance='62500.0000000000',extra={})=>({accountProviders:[{ai:'codex',account:'default',status:'ok',attemptedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString(),windows:[{id:'codex:secondary',label:'週間枠',usedPercent:100,resetsAt:null}],credits:{balance,unlimited:false},...extra}]});
  const start=()=>state.startCreditException({ai:'codex',account:'default',confirm:true,expectedBalance:'62500.0000000000'},snapshot());
  return {state,snapshot,start,tick:(ms=1)=>now+=ms,now:()=>now};
}
test('one human grant removes only Codex default usage holds and survives restart/preflight',t=>{
 const f=fixture(t);f.state.observe(f.snapshot());assert.equal(f.state.list().length,2);
 f.state.observe(f.snapshot('62500',{account:'work'}));f.state.observe(f.snapshot('62500',{ai:'claude',windows:[{id:'five_hour',usedPercent:100,resetsAt:null}]}));
 const e=f.start();f.tick();f.state.observe(f.snapshot('62499.9999999999'));assert.equal(f.state.active('default','gpt-6.1-sol'),null);assert.equal(f.state.active('default','gpt-6-astra'),null);
 assert.ok(f.state.active('work','gpt-6.1-sol'));assert.ok(f.state.active('default','claude-fable-5-2'));
 const restored=new ModelLimits(f.state.file,{now:f.now});assert.equal(restored.creditException().consumed,'0.0000000001');
 assert.equal(restored.startCreditException({ai:'codex',account:'default',confirm:true,expectedBalance:'outdated'},{}).grantedAt,e.grantedAt);
 const runner=new ChatRunner({limitPreflight:o=>restored.forRequest(o)});let captured;runner.run=o=>(captured=o,{startedP:Promise.resolve(true)});
 runner.send({project:'fixture',task:'fixture',pdir:path.dirname(f.state.file),ai:'codex',model:'GPT-6.1-Sol',text:'next'});assert.equal(captured.ai,'codex');
});
test('scope, confirmation, stale balance, unlimited and mismatched balance are rejected',t=>{
 const f=fixture(t),input={ai:'codex',account:'default',confirm:true,expectedBalance:'62500.0000000000'};
 for(const change of [{ai:'claude'},{account:'work'},{confirm:false},{expectedBalance:'62500'},{expectedBalance:'62501'},{model:'gpt-5.6-luna'},{models:['gpt-6.1-sol']}])assert.throws(()=>f.state.startCreditException({...input,...change},f.snapshot()));
 for(const extra of [{status:'unavailable'},{attemptedAt:new Date(f.now()-MAX_AGE-1).toISOString()},{credits:{balance:'62500.0000000000',unlimited:true}}])assert.throws(()=>f.state.startCreditException(input,f.snapshot(undefined,extra)));
 assert.equal(f.state.creditException(),null);assert.equal(amount('62500.0000000001'),625000000000001n);for(const s of ['1e5','-1','0.00000000001',1])assert.equal(amount(s),null);
});
test('zero and explicit no credits end once and restore holds within the same observation',t=>{
 for(const credits of [{balance:'0',unlimited:false},{hasCredits:false}]){const f=fixture(t);f.start();f.tick();f.state.observe(f.snapshot(undefined,{credits}));assert.equal(f.state.creditException().endReason,'exhausted');assert.ok(f.state.active('default','gpt-6.1-sol'));assert.throws(f.start,/再作成/);}
});
test('unknown, stale and out-of-order balances preserve the current exception and holds',t=>{
 const f=fixture(t);f.start();const before=f.state.creditException();
 f.tick();for(const extra of [{credits:undefined},{credits:{unlimited:true}},{status:'unavailable'},{attemptedAt:new Date(f.now()-MAX_AGE-1).toISOString()}])f.state.observe(f.snapshot(undefined,extra));
 assert.deepEqual(f.state.creditException(),before);assert.equal(f.state.list().length,0);
 f.state.data['gpt-6.1-sol']={version:2,source:'usage-100',hold:true,at:new Date(f.now()).toISOString(),lastLimitAt:new Date(f.now()).toISOString(),project:'',task:'',request:'',validUntil:null,untilSource:'unknown',checkedAt:null};f.state.save(f.state.data);
 f.state.observe(f.snapshot(undefined,{credits:undefined}));assert.ok(f.state.active('default','gpt-6.1-sol'));
});
test('top-ups never increase the grant; accumulated decimal spending ends it',t=>{
 const f=fixture(t);f.start();f.tick();f.state.observe(f.snapshot('1.0000000000'));assert.equal(f.state.creditException().consumed,'62499.0000000000');
 f.tick();f.state.observe(f.snapshot('62500.0000000000'));f.tick();f.state.observe(f.snapshot('62499.0000000000'));assert.equal(f.state.creditException().endReason,'allowance-used');assert.ok(f.state.active('default','gpt-6.1-sol'));
});
test('weekly reset, manual ending and formal CLI rejection retain normal routing',t=>{
 const f=fixture(t);f.start();f.tick();f.state.observe(f.snapshot('62500',{windows:[{id:'codex:secondary',label:'週間枠',usedPercent:99.9,resetsAt:null}]}));assert.equal(f.state.creditException().endReason,'reset');
 f.tick();f.state.observe(f.snapshot());assert.ok(f.state.active('default','gpt-6.1-sol'));
 const g=fixture(t);g.start();g.state.endCreditException({ai:'codex',account:'default',confirm:true},g.snapshot());assert.equal(g.state.creditException().endReason,'manual');assert.ok(g.state.active('default','gpt-6.1-sol'));
 const h=fixture(t);h.start();h.state.record({ai:'codex',model:'GPT-6.1-Sol',limitError:"You've hit your usage limit."});h.tick();h.state.observe(h.snapshot());assert.equal(h.state.creditException().endReason,'cli-limit');assert.equal(h.state.active('default','gpt-6.1-sol').source,'cli-limit');
});
