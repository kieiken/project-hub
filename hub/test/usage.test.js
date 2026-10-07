'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Usage, readCli, codexWindows, claudeWindows, resetTime } = require('../lib/usage');

const NOW = Date.parse('2026-10-03T00:00:00Z');
const codex = { rateLimits:{ limitId:'codex',primary:{usedPercent:0,windowDurationMins:10080,resetsAt:1791046922},secondary:null,credits:{balance:'SECRET'}} };
const claude = { subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:20,resets_at:'2026-10-03T05:00:00Z'},seven_day:null,model_scoped:[{display_name:'Fable',utilization:33,resets_at:'2026-10-07T13:00:00Z'}]},behaviors:{private:'SECRET'} };

test('Codex uses actual window duration including weekly-only primary and allows zero usage', () => {
  const rows = codexWindows(codex);
  assert.equal(rows[0].label,'週間枠'); assert.equal(rows[0].usedPercent,0);
  assert.equal(rows[0].resetsAt,new Date(1791046922000).toISOString());
  assert.doesNotMatch(JSON.stringify(rows),/SECRET|credits/);
  const byId = { rateLimits:codex.rateLimits,rateLimitsByLimitId:{codex:{primary:{usedPercent:45,windowDurationMins:300},secondary:{usedPercent:71,windowDurationMins:10080}},other:{limitName:'Other',primary:{usedPercent:12,windowDurationMins:60}}} };
  assert.deepEqual(codexWindows(byId).map(r=>r.label),['5時間枠','週間枠','Other・1時間枠']);
});
test('Claude exposes only available subscription windows, including model scope', () => {
  assert.deepEqual(claudeWindows(claude).map(r=>[r.label,r.usedPercent]),[['5時間枠',20],['Fable・週間枠',33]]);
  assert.doesNotMatch(JSON.stringify(claudeWindows(claude)),/SECRET|behaviors/);
  assert.throws(()=>claudeWindows({subscription_type:null,rate_limits_available:false}),/subscription/);
  assert.throws(()=>claudeWindows({subscription_type:'max',rate_limits:null}),/unavailable/);
});
test('Only recognized CLI plan types are published; unknown plans and private billing data are omitted', async () => {
  for(const [ai,field,plan] of [['codex','pro','Pro'],['codex','plus','Plus'],['codex','team','Team'],['claude','max','Max'],['claude','pro','Pro'],['claude','enterprise','Enterprise'],['codex','unknown',undefined],['claude','max_5x',undefined],['codex','toString',undefined],['claude',null,undefined]]){
    const data=ai==='codex'?{...codex,rateLimits:{...codex.rateLimits,planType:field}}:{...claude,subscription_type:field || 'unknown'};
    data.email='SECRET';data.rateLimitResetCredits={availableCount:1};
    const u=new Usage({now:()=>NOW,find:provider=>provider,read:async provider=>provider===ai?data:provider==='codex'?codex:claude});
    const result=await u.status();assert.equal(result.providers[ai].plan,plan);
    assert.doesNotMatch(JSON.stringify(result),/SECRET|credits|ResetCredits|5x|unknown|toString/);
  }
});
test('Codex account plan is a fallback when rate limit response omits it, and failure drops old plan', async () => {
  let now=NOW;
  const u=new Usage({now:()=>now,find:ai=>ai,read:async ai=>ai==='codex'?{...codex,accountPlanType:'pro'}:claude});
  assert.equal((await u.status()).providers.codex.plan,'Pro');
  u.read=async ai=>ai==='codex'?{...codex,accountPlanType:'pro',rateLimits:{...codex.rateLimits,planType:'plus'}}:claude;
  now+=31000;assert.equal((await u.status(true)).providers.codex.plan,'Plus');
  u.read=async()=>{throw Error('fixture failure');};now+=31000;
  assert.equal((await u.status(true)).providers.codex.plan,undefined);
});
test('Codex tickets and balance use existing reads, publish only allowed fields and stay account-specific', async () => {
  const extra = { rateLimitResetCredits: { availableCount: 1, accountId: 'SECRET', credits: [
    { status:'available', title:'Full reset', expiresAt:1794438000, id:'SECRET', description:'SECRET' },
    { status:'used', title:'SECRET', expiresAt:1794438000 },
    { status:'expired', title:'SECRET', expiresAt:1794438000 },
  ] }, credits:{ hasCredits:true, unlimited:false, balance:'62500', accountId:'SECRET' } };
  let calls = 0, now = NOW;
  const u = new Usage({ now:()=>now, find:ai=>ai, read:async (ai,file,{account})=>{
    calls++; return ai === 'codex' ? { ...codex, rateLimits:{ ...codex.rateLimits, ...(account === 'default' ? extra : {}) } } : { ...claude, ...extra };
  } });
  const r = await u.status(); assert.equal(calls,2);
  assert.deepEqual(r.providers.codex.resetCredits,{count:1,items:[{title:'Full reset',expiresAt:new Date(1794438000000).toISOString()}]});
  assert.deepEqual(r.providers.codex.credits,{balance:'62500',unlimited:false});
  assert.equal(r.providers.claude.resetCredits,undefined); assert.equal(r.providers.claude.credits,undefined);
  assert.doesNotMatch(JSON.stringify(r),/SECRET|description|accountId|availableCount|hasCredits/);
  await u.status(); assert.equal(calls,2);
  const other = await u.status(false,{codex:'work'}); assert.equal(calls,3);
  assert.equal(other.providers.codex.credits,undefined);assert.equal(other.providers.codex.resetCredits,undefined);
  assert.equal(u.snapshot().providers.codex.credits.balance,'62500');
  u.read=async()=>{throw Error('SECRET');};now+=31000;
  const failed=await u.status(true);assert.equal(failed.providers.codex.credits,undefined);assert.equal(failed.providers.codex.resetCredits,undefined);
});
test('Reset ticket count, list and titles are bounded and only available items are exposed', async () => {
  const read = async reset => (await new Usage({now:()=>NOW,find:ai=>ai,read:async ai=>ai==='codex'?{...codex,rateLimitResetCredits:reset}:claude}).status()).providers.codex;
  const credits=Array.from({length:1005},()=>({status:'available',title:'X'.repeat(200),expiresAt:'bad',id:'SECRET'}));
  const p=await read({availableCount:999999,credits});
  assert.equal(p.resetCredits.count,1000);assert.equal(p.resetCredits.items.length,20);
  assert.ok(p.resetCredits.items.every(item=>item.title.length===80&&item.expiresAt===null));
  assert.deepEqual((await read({availableCount:'bad',credits:[{status:'available',title:null}]})).resetCredits,{count:1,items:[{title:'リセット',expiresAt:null}]});
  for(const reset of [undefined,{availableCount:1},{availableCount:0,credits:[{status:'available'}]},{availableCount:1,credits:[{status:'used'},{status:'expired'},{status:'AVAILABLE'}]}]) assert.equal((await read(reset)).resetCredits,undefined);
});
test('Credits require hasCredits and an exact bounded numeric string, or explicitly unlimited', async () => {
  const read = async credits => (await new Usage({now:()=>NOW,find:ai=>ai,read:async ai=>ai==='codex'?{...codex,rateLimits:{...codex.rateLimits,credits}}:claude}).status()).providers.codex.credits;
  for(const balance of ['0','62500','9007199254740993123456789.50']) assert.deepEqual(await read({hasCredits:true,balance}),{balance,unlimited:false});
  for(const balance of [62500,null,'SECRET','1e5','-1','1,000',' 5','5\n','Infinity','9'.repeat(81)]) assert.equal(await read({hasCredits:true,balance}),undefined);
  for(const credits of [undefined,{balance:'10'},{hasCredits:false,balance:'10',unlimited:true},{hasCredits:'true',balance:'10'}]) assert.equal(await read(credits),undefined);
  assert.deepEqual(await read({hasCredits:true,unlimited:true,balance:null}),{unlimited:true});
  assert.deepEqual(await read({hasCredits:true,unlimited:true,balance:'0'}),{balance:'0',unlimited:true});
});
test('Missing, non-finite and malformed fields remain unknown rather than zero or an invented reset', () => {
  assert.equal(resetTime(null),null); assert.equal(resetTime('bad'),null); assert.equal(resetTime(Infinity),null);
  assert.equal(resetTime(1791046922000),null); assert.equal(resetTime('9999-01-01'),null);
  assert.equal(resetTime('2026-10-03T00:00:00+09:00'),'2026-10-02T15:00:00.000Z');
  const rows=codexWindows({rateLimits:{primary:{usedPercent:null,resetsAt:null},secondary:{usedPercent:NaN,resetsAt:'bad'}}});
  assert.ok(rows.every(r=>r.usedPercent===null && r.resetsAt===null));
  assert.equal(rows[0].label,'利用枠'); assert.throws(()=>codexWindows(null),/format/);
});
test('Successful reads are cached, coalesced and manually limited; automatic failures do not retry', async () => {
  let now=NOW, calls=0, unblock;
  const u = new Usage({now:()=>now,find:ai=>ai,read:async ai=>{calls++; if(calls<=2) await new Promise(r=>{const old=unblock;unblock=()=>{old?.();r();};}); return ai==='codex'?codex:claude;}});
  const a=u.status(), b=u.status(true); assert.equal(calls,2); unblock();
  assert.deepEqual(await a,await b); assert.equal((await u.status()).providers.codex.status,'ok'); assert.equal(calls,2);
  await u.status(true); assert.equal(calls,2);
  now+=31000; await u.status(true); assert.equal(calls,4);
  now+=300001; await u.status(); assert.equal(calls,6);
  u.read=async()=>{calls++;throw new Error('SECRET');}; now+=31000;
  const failed=await u.status(true); assert.ok(Object.values(failed.providers).every(p=>p.windows.length===0 && p.status==='unavailable'));
  assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
  const count=calls; now+=3600000; await u.status(); assert.equal(calls,count);
  u.read=async ai=>ai==='codex'?codex:claude; assert.equal((await u.status(true)).providers.claude.status,'ok');
});
test('Missing CLI and dry mode never spawn a CLI', async () => {
  let calls=0;
  for(const opts of [{find:()=>''},{dry:true,find:()=>{throw new Error('must not find');}}]) {
    const u=new Usage({...opts,read:()=>{calls++;}}); const r=await u.status();
    assert.equal(r.providers.codex.status,'unavailable'); assert.equal(r.providers.claude.status,'unavailable');
  }
  assert.equal(calls,0);
});

test('All registered eligible accounts are read, excluded accounts never spawn, and selected providers stay scoped', async () => {
  const rows=[{ai:'claude',id:'default',name:'既定'},{ai:'claude',id:'work',name:'仕事用'},{ai:'codex',id:'default',name:'既定'},{ai:'codex',id:'work',name:'仕事用'},{ai:'codex',id:'out',name:'ログアウト'},{ai:'agy',id:'default',name:'Gemini'}];
  const states={'claude:default':'logged-out','claude:work':'logged-in','codex:default':'api','codex:work':'unknown','codex:out':'logged-out'},calls=[],checked=[];
  const accounts={list:()=>rows,status:async(ai,id)=>{checked.push(ai+':'+id);return{status:states[ai+':'+id],email:'SECRET',token:'SECRET'};}};
  const u=new Usage({accounts,now:()=>NOW,find:ai=>ai,read:async(ai,file,{account})=>{calls.push(ai+':'+account);if(ai==='codex')throw Error('SECRET');return claude;}});
  const r=await u.status(false,{claude:'work',codex:'default'});
  assert.deepEqual(calls.sort(),['claude:work','codex:work']);assert.equal(checked.length,5);
  assert.deepEqual(Object.keys(r.providers),['claude']);assert.equal(r.providers.claude.accountName,'仕事用');
  assert.deepEqual(r.accountProviders.map(p=>[p.ai,p.account,p.inUse,p.status]),[['claude','work',true,'ok'],['codex','work',false,'unavailable']]);
  assert.doesNotMatch(JSON.stringify(r),/SECRET|email|token|ログアウト/);
  assert.deepEqual(Object.keys(u.snapshot().providers),[]);
});
test('Login checks coalesce and cache for five minutes, including force refresh; CLI absence skips auth and usage', async () => {
  let now=NOW,auth=0,reads=0,installed=true;
  const accounts={list:()=>[{ai:'codex',id:'default',name:'既定'}],status:async()=>{auth++;return{status:'logged-in'};}};
  const u=new Usage({accounts,now:()=>now,find:()=>installed?'cli':'',read:async()=>{reads++;return codex;}});
  await Promise.all([u.status(),u.status(true)]);assert.equal(auth,1);assert.equal(reads,1);
  now+=31000;await u.status(true);assert.equal(auth,1);assert.equal(reads,2);
  now+=300001;await u.status();assert.equal(auth,2);assert.equal(reads,3);
  installed=false;assert.deepEqual((await u.status()).providers,{});assert.equal(auth,2);assert.equal(reads,3);
  installed=true;await u.status();assert.equal(auth,3);assert.equal(reads,4);
});
test('Auth changes, additions, deletion, rename and externally completed login discard only the affected account', async () => {
  let rows=[{ai:'codex',id:'default',name:'既定'}],status='logged-out',auth=0,reads=0,busy=false;
  const accounts={list:()=>rows,terminalBusy:()=>busy,status:async()=>{auth++;return{status:busy?'unknown':status};}};
  const u=new Usage({accounts,now:()=>NOW,find:ai=>ai,beforeRead:()=>{if(busy)throw Error('fixture busy');},read:async()=>{reads++;return codex;}});
  assert.equal((await u.status()).accountProviders.length,0);
  status='logged-in';u.invalidate('codex');await u.status();assert.equal(reads,1);
  rows.push({ai:'codex',id:'work',name:'仕事用'});assert.equal((await u.status()).accountProviders.length,2);assert.equal(reads,2);
  rows[1].name='新しい名前';assert.equal((await u.status()).accountProviders[1].accountName,'新しい名前');assert.equal(reads,2);
  rows=rows.slice(0,1);assert.equal((await u.status()).accountProviders.length,1);assert.equal(u.cache['codex:work'],undefined);
  busy=true;assert.equal((await u.status()).providers.codex.status,'unavailable');const checks=auth;
  await u.status();assert.equal(auth,checks);busy=false;assert.equal((await u.status()).providers.codex.status,'ok');assert.equal(reads,3);
  u.loginChecked('codex','default','logged-out');assert.deepEqual((await u.status()).providers,{});assert.equal(auth,checks+1);
  u.loginChecked('codex','default','logged-in');await u.status();assert.equal(auth,checks+1);assert.equal(reads,4);
});
test('Invalidation rejects late auth and usage responses so deleted or logged-out accounts cannot return', async () => {
  let status='logged-in',resolveAuth,resolveRead,reading=false;
  const rows=[{ai:'codex',id:'default',name:'既定'}],accounts={list:()=>rows,status:()=>new Promise(r=>{resolveAuth=r;})};
  const u=new Usage({accounts,now:()=>NOW,find:ai=>ai,read:()=>{reading=true;return new Promise(r=>{resolveRead=r;});}});
  const pending=u.status();u.invalidate('codex');resolveAuth({status});await pending;assert.equal(reading,false);assert.deepEqual(u.snapshot().providers,{});
  accounts.status=async()=>({status});const next=u.status();while(!reading)await new Promise(r=>setImmediate(r));
  status='logged-out';u.invalidate('codex');assert.deepEqual((await u.status()).providers,{});
  resolveRead(codex);await next;assert.deepEqual(u.snapshot().providers,{});assert.equal(u.cache.codex,undefined);
});
test('Logout while another AI auth is pending skips stale targets before sharing, cooldown and reads', async () => {
  let codexStatus='logged-in',resolveAuth,resolveRead;
  const reads=[],beforeReads=[],rows=[{ai:'codex',id:'default',name:'既定'},{ai:'claude',id:'default',name:'既定'}];
  const accounts={list:()=>rows,status:ai=>ai==='codex'?Promise.resolve({status:codexStatus}):new Promise(r=>{resolveAuth=r;})};
  const u=new Usage({accounts,now:()=>NOW,find:ai=>ai,beforeRead:ai=>beforeReads.push(ai),read:ai=>{
    reads.push(ai);return ai==='codex'?Promise.resolve(codex):new Promise(r=>{resolveRead=r;});
  }});
  const first=u.status(),shared=u.status(true);
  while(!u.visible.has('codex'))await new Promise(r=>setImmediate(r));
  codexStatus='logged-out';u.invalidate('codex');resolveAuth({status:'logged-in'});
  while(!reads.includes('claude'))await new Promise(r=>setImmediate(r));
  // 両方のstatusがtargetsを処理し終えるまで、他AIの取得は保留する。
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(reads,['claude']);assert.deepEqual(beforeReads,['claude']);
  assert.equal(u.inflight.has('codex'),false);assert.equal(u.lastAttempt.has('codex'),false);
  resolveRead(claude);
  for(const r of await Promise.all([first,shared])){
    assert.deepEqual(Object.keys(r.providers),['claude']);assert.equal(r.accountProviders.length,1);
    assert.equal(r.accountProviders[0].ai,'claude');assert.equal(r.providers.claude.status,'ok');
  }
  assert.equal(u.cache.codex,undefined);
});
test('Invalidation during beforeRead prevents usage read and leaves no attempt or visible card', async () => {
  let reads=0;
  const accounts={list:()=>[{ai:'codex',id:'default',name:'既定'}],status:async()=>({status:'logged-in'})};
  const u=new Usage({accounts,now:()=>NOW,find:ai=>ai,beforeRead:(ai,account)=>u.invalidate(ai,account),read:async()=>{reads++;return codex;}});
  const r=await u.status();
  assert.equal(reads,0);assert.equal(u.lastAttempt.has('codex'),false);assert.equal(u.cache.codex,undefined);
  assert.deepEqual(r.providers,{});assert.deepEqual(r.accountProviders,[]);
});
test('Every visible Claude account still updates only its own recorded Fable limit evidence', async () => {
  const {LimitEvidence}=require('../lib/limit-evidence');let now=NOW;
  const e=new LimitEvidence(path.join(dir,'usage-accounts-limits.json'),{now:()=>now});e.record({account:'default'});e.record({account:'work'});now+=10;
  const rows=[{ai:'claude',id:'default',name:'既定'},{ai:'claude',id:'work',name:'仕事用'}];
  const u=new Usage({accounts:{list:()=>rows,status:async()=>({status:'logged-in'})},now:()=>now,find:ai=>ai,observe:r=>e.observe(r),read:async(ai,file,{account})=>({...claude,rate_limits:{model_scoped:[{display_name:'Fable',utilization:100,resets_at:new Date(NOW+(account==='work'?7200000:3600000)).toISOString()}]}})});
  const r=await u.status(false,{claude:'work'});assert.equal(r.accountProviders.length,2);
  assert.equal(e.active().validUntil,new Date(NOW+3600000).toISOString());assert.equal(e.active('work').validUntil,new Date(NOW+7200000).toISOString());
});

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-usage-'));
const fake=path.join(dir,'cli.cjs');
fs.writeFileSync(fake,`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const [ai,log,mode]=process.argv.slice(2);
const send=x=>{const s=JSON.stringify(x)+'\\n';process.stdout.write(s.slice(0,7));process.stdout.write(s.slice(7));};
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
  if(mode==='timeout')return;
  if(mode==='oversize'){process.stdout.write('x'.repeat(2100000));return;}
  if(ai==='codex'){
    if(m.id===0)send({id:0,result:{}});
    if(m.id===1)send({id:1,result:{account:{type:mode==='api'?'apiKey':'chatgpt',planType:'pro',email:'SECRET'}}});
    if(m.id===2)send({id:2,result:${JSON.stringify(codex)}});
  }else{
    const id=m.request_id;
    if(m.request.subtype==='initialize')send({type:'control_response',response:{request_id:id,subtype:'success',response:{account:{email:'SECRET'}}}});
    if(m.request.subtype==='get_usage')send({type:'control_response',response:{request_id:id,subtype:mode==='unsupported'?'error':'success',error:'SECRET',response:${JSON.stringify(claude)}}});
  }
  process.stderr.write('SECRET\\n');
});
`);
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
function fixture(ai,mode='ok') {
  const log=path.join(dir,`${ai}-${mode}-${Math.random()}.jsonl`), children=[], args=[], envs=[];
  return {log,children,args,envs,spawn(file,argv,opts){args.push(argv); envs.push(opts.env); const p=spawn(process.execPath,[fake,ai,log,mode],opts); children.push(p);return p;}};
}
test('usage protocol subprocesses receive only the selected profile environment and Codex storage override', async () => {
  const launch = require('../lib/launch'), { Accounts } = require('../lib/accounts');
  const home = path.join(fs.realpathSync(dir), 'profile-home');
  const accounts = new Accounts({ home, file: path.join(home, 'registry.json') });
  launch.setAccounts(accounts);
  try {
    for (const ai of ['claude', 'codex']) {
      const row = accounts.add(ai, 'selected'), f = fixture(ai);
      const auth = { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'fixture-only', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9', CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/fixture-only', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture-only' };
      await readCli(ai, ai, { spawn: f.spawn, timeoutMs: 3000, account: row.id, env: { ...process.env, ...auth, OPENAI_API_KEY: 'SECRET', ANTHROPIC_API_KEY: 'SECRET' } });
      assert.equal(f.envs[0][ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], row.dir);
      assert.equal(f.envs[0].OPENAI_API_KEY, undefined); assert.equal(f.envs[0].ANTHROPIC_API_KEY, undefined);
      for (const key of Object.keys(auth)) assert.equal(f.envs[0][key], undefined, key);
      if (ai === 'codex') assert.ok(f.args[0].includes('cli_auth_credentials_store="file"'));
    }
  } finally { launch.setAccounts(null); }
});
test('Both real subprocess protocols send only fixed state requests and exit before completion', async () => {
  for(const ai of ['codex','claude']) {
    const f=fixture(ai);
    const r=await readCli(ai,ai,{spawn:f.spawn,timeoutMs:3000});
    const rows=ai==='codex'?codexWindows(r):claudeWindows(r);
    assert.ok(rows.length); assert.doesNotMatch(JSON.stringify(rows),/SECRET/);
    if(ai==='codex') { assert.equal(r.accountPlanType,'pro');assert.equal(r.account,undefined); }
    assert.notEqual(f.children[0].exitCode===null && f.children[0].signalCode===null,true);
    const requests=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
    if(ai==='codex') assert.deepEqual(requests.map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read']);
    else {
      assert.deepEqual(requests.map(x=>x.request.subtype),['initialize','get_usage']);
      assert.equal(requests[1].request.skip_behaviors,true);
      assert.ok(f.args[0].includes('--safe-mode')); assert.ok(f.args[0].includes('{"disableAllHooks":true}'));
      assert.equal(f.args[0][f.args[0].indexOf('--model')+1],'claude-fable-5-1');
    }
    assert.ok(requests.every(x=>x.type!=='user' && !x.method?.includes('turn') && !x.method?.includes('thread')));
  }
});
test('API-only account stops before Codex rate-limit request', async () => {
  const f=fixture('codex','api');
  await assert.rejects(readCli('codex','codex',{spawn:f.spawn,timeoutMs:3000}),/subscription/);
  assert.doesNotMatch(fs.readFileSync(f.log,'utf8'),/rateLimits/);
});
test('Unsupported Claude control returns sanitized error and ends the process', async () => {
  const f=fixture('claude','unsupported');
  await assert.rejects(readCli('claude','claude',{spawn:f.spawn,timeoutMs:3000}),e=>e.usageCode==='unsupported' && !e.message.includes('SECRET'));
});
test('Hanging or oversized CLI output is bounded and process is stopped', async () => {
  for(const mode of ['timeout','oversize']) {
    const f=fixture('codex',mode);
    await assert.rejects(readCli('codex','codex',{spawn:f.spawn,timeoutMs:mode==='timeout'?100:3000}),e=>e.usageCode===(mode==='timeout'?'timeout':'format'));
    assert.ok(f.children[0].signalCode || f.children[0].exitCode!==null);
  }
});
