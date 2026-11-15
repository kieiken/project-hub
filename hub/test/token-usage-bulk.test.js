'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {TokenUsage}=require('../lib/token-usage'),{summarize,evaluate}=require('../lib/token-usage-alerts');
const id=n=>n.toString(16).padStart(64,'0');
function fixture(t,alerts){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'token-bulk-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const u=new TokenUsage({dir,accounts:{}});let starts=0;u.start=()=>{starts++;};u.snapshot={...summarize(alerts),preferencesRevision:0};return {u,dir,starts:()=>starts};}
test('bulk acknowledges every unseen current/historical alert past the 300 display cap in one write, preserving limits and existing receipts',t=>{
 const alerts=Array.from({length:355},(_,n)=>({id:id(n+1),total:n+100,day:'2026-11-15',historical:n>290,acknowledged:n===0}));
 const {u,dir,starts}=fixture(t,alerts);u.preferences.limits={codex:{daily:123}};u.preferences.acknowledged[id(1)]={through:100};
 assert.equal(u.snapshot.alerts.length,300);assert.equal(u.snapshot.unacknowledgedAlerts.length,354);const token=u.status().acknowledgementToken;
 u.acknowledgeAll(token);assert.equal(starts(),1);assert.equal(u.preferences.revision,1);assert.deepEqual(u.preferences.limits,{codex:{daily:123}});
 for(const a of alerts)assert.equal(u.preferences.acknowledged[a.id].through,a.total);
 assert.equal(new TokenUsage({dir,accounts:{}}).preferences.acknowledged[id(355)].through,454);
 assert.throws(()=>u.acknowledgeAll(token));assert.equal(starts(),1);
});
test('bulk rejects any changed total, new/expired alert, stale preferences, missing metadata or invalid token without partial writes',t=>{
 const base=[{id:id(1),total:100},{id:id(2),total:200,historical:true}];
 for(const change of [u=>{u.snapshot=summarize([...base,{id:id(3),total:300}]);u.snapshot.preferencesRevision=0;},u=>{u.snapshot.unacknowledgedAlerts[0].total++;},u=>{u.snapshot.unacknowledgedAlerts.pop();},u=>{u.preferences.revision++;},u=>{delete u.snapshot.unacknowledgedAlerts;}]){
  const {u,dir,starts}=fixture(t,base),token=u.status().acknowledgementToken;change(u);assert.throws(()=>u.acknowledgeAll(token));assert.deepEqual(u.preferences.acknowledged,{});assert.equal(starts(),0);assert.equal(fs.existsSync(path.join(dir,'preferences.json')),false);
 }
 const {u}=fixture(t,base);for(const invalid of [undefined,{},[],123,'bad','f'.repeat(64)])assert.throws(()=>u.acknowledgeAll(invalid));
});
test('bulk keeps the observed through amount; a new alert remains unseen and the existing strict 25 percent renotification boundary holds',t=>{
 const f={today:'2026-11-15',daily:[{ai:'codex',day:'2026-11-15',total:100,work:{},lastTs:2}],runs:[],turns:[]},limits={codex:{daily:1}},a=evaluate(f,limits,{}, {startedAt:1});
 const {u}=fixture(t,a);u.acknowledgeAll(u.status().acknowledgementToken);f.daily[0].total=125;let out=evaluate(f,limits,u.preferences.acknowledged,{startedAt:1});assert.equal(out[0].acknowledged,true);f.daily[0].total=126;out=evaluate(f,limits,u.preferences.acknowledged,{startedAt:1});assert.equal(out[0].acknowledged,false);f.daily.push({ai:'claude',day:'2026-11-15',total:200,work:{},lastTs:3});out=evaluate(f,{...limits,claude:{daily:1}},u.preferences.acknowledged,{startedAt:1});assert.equal(out.find(a=>a.ai==='claude').acknowledged,false);assert.equal(u.preferences.acknowledged[a[0].id].through,100);
});
test('both legacy and production rollup summaries retain uncapped targets without changing existing totals or alert counts',()=>{
 const now=Date.parse('2026-11-15T03:00:00Z'),state={records:{},sessions:{},monitorStartedAt:now-1,coverage:{}};
 for(let n=1;n<=350;n++)state.records[n]={ai:'claude',sid:'s'+n,run:'r'+n,ts:now,start:now,total:100+n,input:100+n,output:0,cache:0,write:0};
 const prefs={revision:0,limits:{claude:{run:1}},acknowledged:{}},legacy=require('../lib/token-usage-scan').summary(state,prefs,now),rollup=require('../lib/token-usage-rollup'),c=rollup.collector(state,prefs,now);c.add(rollup.build(state.records,state,new Map(),{},now));const prod=c.finish();
 for(const s of [legacy,prod]){assert.equal(s.alerts.length,300);assert.equal(s.unacknowledgedAlerts.length,350);assert.equal(s.alertTotal,350);assert.equal(s.alertCount,350);assert.equal(s.total,96425);}
 assert.deepEqual(prod.unacknowledgedAlerts,legacy.unacknowledgedAlerts);
});
test('bulk route uses a bounded snapshot token, preserves single acknowledgement and reports conflicts',()=>{
 let result,calls=[];const routes=require('../lib/routes/token-usage')({PORT:4545,send:(_,status,body)=>result={status,body},tokenUsage:{acknowledgeAll:token=>{calls.push(token);if(token!=='valid')throw Error('stale');return {pending:true};},acknowledge:(id,total)=>{calls.push([id,total]);return {};}}}),req={method:'POST',headers:{'x-hub':'1'}},url={pathname:'/api/token-usage/acknowledge-all'};
 assert.equal(routes.write.matches(req,url),true);routes.write.handle(req,{},url,{token:'valid'});assert.equal(result.status,200);assert.equal(result.body.pending,true);routes.write.handle(req,{},url,{token:'stale'});assert.equal(result.status,409);routes.write.handle({...req,headers:{}},{},url,{token:'valid'});assert.equal(result.status,403);assert.equal(calls.length,2);routes.write.handle(req,{},{pathname:'/api/token-usage/acknowledge'},{id:'one',total:12});assert.deepEqual(calls.at(-1),['one',12]);
});
