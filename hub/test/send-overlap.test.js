'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, wait } = require('./fixtures/send-overlap.cjs');
test('actual direct route overlaps first scan with one formal query and keeps both handoff scans', async t => {
  const f = fixture(t); let releaseRead, releaseScan;
  f.state.onRead = () => new Promise(r => { releaseRead = r; });
  f.state.onScan = n => n === 1 ? new Promise(r => { releaseScan = r; }) : undefined;
  const pending = f.send(); await wait(10);
  assert.equal(typeof releaseRead, 'function'); assert.equal(typeof releaseScan, 'function'); assert.equal(f.launches.length, 0);
  releaseScan(); await wait(5); assert.equal(f.launches.length, 0);
  releaseRead(); const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'codex');
  assert.equal(f.scans.length, 2); assert.equal(f.reads.length, 1); assert.equal(f.checks.length, 1);
  assert.equal(f.checks[0][2].fresh, true);
});
for (const setting of ['priority', 'check']) test(`early query disabled when ${setting} is off`, async t => {
  const f = fixture(t); if (setting === 'priority') f.policy.preferCredits = false; else f.policy.checkCredits.codex = false;
  assert.equal(f.engine.startCreditCheck(f.options), undefined); assert.equal(f.checks.length, 0);
});
for (const mode of ['error', 'empty']) test(`early ${mode} consumes one check and retains fallback`, async t => {
  const f = fixture(t); f.state.mode = mode; const result = await f.send();
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'claude');
  assert.equal(f.reads.filter(r => r.ai === 'codex').length, 1); assert.equal(f.checks.filter(r => r[0] === 'codex').length, 1);
});
test('formal CLI refusal remains held despite the early positive credit read', async t => {
  const f = fixture(t); f.limits.record({ ...f.options, limitError: "You've hit your usage limit." });
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'claude');
  assert.equal(f.reads.filter(r => r.ai === 'codex').length, 1);
});
for (const age of [29999, 30000, 30001]) test(`early proof aged ${age}ms at admission keeps the strict final freshness boundary`, async t => {
  const f = fixture(t); f.state.onScan = n => { if (n === 2) f.advance(age); };
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.launches[0].ai, 'codex'); assert.equal(f.reads.length, age < 30000 ? 1 : 2); assert.equal(f.checks.length, age < 30000 ? 1 : 2);
  assert.equal(f.scans.length, age < 30000 ? 2 : 3);
});
for (const phase of ['first-scan', 'read', 'admission']) test(`stop during ${phase} never launches or repeats the read`, async t => {
  const f = fixture(t);
  if (phase === 'read') f.state.onRead = () => f.stop();
  else f.state.onScan = n => { if (n === (phase === 'first-scan' ? 1 : 2)) f.stop(); };
  const result = await f.send(); assert.equal(result.status, 409); assert.equal(f.launches.length, 0); assert.ok(f.reads.length <= 1);
});
test('failed first handoff abandons even a rejected early read without launching', async t => {
  const f = fixture(t); f.state.scanError = true;
  f.usage.checkCredits = async () => { await wait(15); throw Error('fixture rejected early check'); };
  const result = await f.send(); assert.equal(result.status, 409); await wait(30); assert.equal(f.launches.length, 0);
});
test('post-scan validation cancellation never starts an AI after the early read', async t => {
  const f = fixture(t); const result = await f.send({ projectImages: 'invalid' });
  assert.equal(result.status, 400); await wait(10); assert.equal(f.launches.length, 0); assert.equal(f.reads.length, 1);
});
for (const setting of ['priority', 'check', 'account']) test(`${setting} change during first scan cannot reuse invalid proof or retry`, async t => {
  const f = fixture(t); f.state.onScan = async n => { if (n !== 1) return; await wait(10);
    if (setting === 'priority') f.policy.preferCredits = false;
    else if (setting === 'check') f.policy.checkCredits.codex = false;
    else f.usage.invalidate('codex', 'work'); };
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'claude');
  assert.equal(f.reads.filter(r => r.ai === 'codex').length, 1);
});
test('concurrent duplicate direct sends share the query and admit at most one launch', async t => {
  const f = fixture(t, { queryDelay: 10, scanDelay: 5 });
  const results = await Promise.all([f.send(), f.send()]); assert.equal(f.reads.length, 1); assert.equal(f.launches.length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 1);
});
test('an early receipt never supplies a different account or task', async t => {
  const f = fixture(t), receipt = f.engine.startCreditCheck(f.options);
  await f.engine.refreshLimitEvidence({ ...f.options, account: 'other', task: 'other' }, receipt);
  assert.equal(f.reads.filter(r => r.account === 'work').length, 1); assert.equal(f.reads.filter(r => r.account === 'other').length, 1);
  assert.equal(f.limits.creditDecision({ ...f.options, account: 'other' }).allowed, true);
});
test('slow early read ages out without a second attempt', async t => {
  const f = fixture(t); f.state.onRead = () => f.advance(30000);
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.launches[0].ai, 'claude'); assert.equal(f.reads.filter(r => r.ai === 'codex').length, 1);
  assert.equal(f.logs.find(r => r.action === 'credit-priority-check')?.reason, 'slow-read');
});
test('both providers formally held stay waiting after early proof, with no launch', async t => {
  const f = fixture(t);
  f.limits.record({ ...f.options, limitError: "You've hit your usage limit." });
  f.limits.record({ ai: 'claude', model: 'Opus 5.5', limitError: "You've reached your session limit" });
  const result = await f.send(); assert.equal(result.status, 409); assert.equal(f.launches.length, 0);
  assert.equal(f.reads.filter(r => r.ai === 'codex').length, 1);
});
test('early read is not started for another AI or an already held human stop', async t => {
  const f = fixture(t);
  assert.equal(f.engine.startCreditCheck({ ...f.options, ai: 'claude', model: 'Opus 5.5' }), undefined);
  f.stop(); assert.equal(f.engine.startCreditCheck(f.options), undefined); assert.equal(f.reads.length, 0);
});
test('account reset permits only one replacement lookup and no actual query', async t => {
  const f = fixture(t); f.usage.resetBusy.add(f.usage.key('codex', 'work'));
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'claude');
  assert.equal(f.checks.filter(r => r[0] === 'codex').length, 2); assert.equal(f.reads.filter(r => r.ai === 'codex').length, 0);
});
test('a still in-flight ordinary account read is shared and counts as this send query', async t => {
  const f = fixture(t); let release;
  f.state.onRead = () => new Promise(r => { release = r; });
  const status = f.usage.status(true, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  await wait(5); const pending = f.send(); await wait(5); release(); await status; const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'codex'); assert.equal(f.reads.length, 1);
  assert.equal(f.logs.find(r => r.action === 'credit-priority-check')?.acquisition, 'shared');
});
test('unexpected query rejection on an otherwise valid send fails closed once', async t => {
  const f = fixture(t); let calls = 0;
  f.usage.checkCredits = async () => { calls++; throw Error('fixture unexpected query rejection'); };
  const result = await f.send(); assert.equal(result.status, 409); assert.equal(f.launches.length, 0); assert.equal(calls, 1);
});

for (const duration of [2000, 16000, 32000]) test(`both handoff scans take ${duration}ms: bounded credit refresh keeps Codex when possible`, async t => {
  const f = fixture(t);
  f.state.onScan = async () => { await wait(5); f.advance(duration); };
  const result = await f.send();
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.scans.length, duration === 16000 ? 3 : 2);
  // At 32s per scan the replacement itself expires during scan two: no third query.
  assert.equal(f.launches[0].ai, duration === 32000 ? 'claude' : 'codex');
  assert.equal(f.reads.filter(r => r.ai === 'codex').length, duration === 2000 ? 1 : 2);
  assert.equal(f.checks.filter(r => r[0] === 'codex').length, duration === 2000 ? 1 : 2);
});
test('an early receipt sharing a cache-only check gets one actual query', async t => {
  const f = fixture(t); await f.usage.checkCredits('codex', 'work');
  const status = f.usage.status.bind(f.usage); let releaseCache;
  f.usage.status = async (...args) => {
    const result = await status(...args);
    if (args[2]?.freshCredits === false) await new Promise(r => { releaseCache = r; });
    return result;
  };
  const cached = f.usage.checkCredits('codex', 'work'); await wait(5);
  const pending = f.send(); await wait(5); releaseCache(); await cached;
  const result = await pending;
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'codex');
  assert.equal(f.scans.length, 2); assert.equal(f.reads.length, 2); // seed + one send query
  assert.equal(f.logs.filter(r => r.action === 'credit-priority-check').at(-1).acquisition, 'queried');
});
for (const mode of ['error', 'empty', 'slow', 'cli-limit', 'stop', 'account']) test(`expired early proof: replacement ${mode} never retries or wrongly starts Codex`, async t => {
  const f = fixture(t); let reads = 0;
  f.state.onScan = async n => { await wait(5); if (n === 1) f.advance(32000); };
  f.state.onRead = ai => {
    if (ai !== 'codex' || ++reads !== 2) return;
    if (['error', 'empty'].includes(mode)) f.state.mode = mode;
    else if (mode === 'slow') f.advance(30000);
    else if (mode === 'stop') f.stop();
    else if (mode === 'account') f.usage.invalidate('codex', 'work');
    else f.limits.record({ ...f.options, limitError: "You've hit your usage limit." });
  };
  const result = await f.send();
  assert.equal(f.scans.length, mode === 'stop' ? 1 : 2); assert.equal(reads, 2);
  assert.equal(f.checks.filter(r => r[0] === 'codex').length, 2);
  if (mode === 'stop') { assert.equal(result.status, 409); assert.equal(f.launches.length, 0); }
  else { assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(f.launches[0].ai, 'claude'); }
});
test('no early formal query without a usage-100 hold', async t => {
  const f = fixture(t);
  f.limits.clearAccount('codex', 'work');
  assert.equal(f.engine.startCreditCheck(f.options), undefined); assert.equal(f.checks.length, 0);
});

for (const duration of [29999, 30000, 30001]) test(`replacement proof ages ${duration}ms in the additional scan: strict boundary and no loop`, async t => {
  const f = fixture(t); f.state.onScan = async n => { await wait(5); f.advance(n === 3 ? duration : 16000); };
  const result = await f.send(); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.scans.length, 3); assert.equal(f.checks.length, 2); assert.equal(f.reads.length, 2);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].ai, duration < 30000 ? 'codex' : 'claude');
});
for (const mode of ['error','empty','slow','cli-limit','stop','account','priority','check','runtime','identity','request','ai','save','save-verdict']) test(`replacement after final scan: ${mode} cannot authorize an unsafe start`, async t => {
  const f = fixture(t); let reads=0;
  f.state.onScan = async n => { await wait(5); if(n<=2) f.advance(16000); };
  f.state.onRead = ai => {
    if(ai!=='codex'||++reads!==2)return;
    if(['error','empty'].includes(mode))f.state.mode=mode;
    else if(mode==='slow')f.advance(30000);
    else if(mode==='cli-limit')f.limits.record({...f.options,limitError:"You've hit your usage limit."});
    else if(mode==='stop')f.stop();
    else if(mode==='account')f.usage.invalidate('codex','work');
    else if(mode==='priority')f.policy.preferCredits=false;
    else if(mode==='check')f.policy.checkCredits.codex=false;
    else if(mode==='runtime')f.runner.adoptErrors.push({project:'p',task:'t',error:'fixture runtime change'});
    else if(mode==='identity')f.runner.busy('p','t').options.account='other';
    else if(mode==='request')f.runner.busy('p','t').options.request='other';
    else if(mode==='ai')f.runner.busy('p','t').options.ai='claude';
    else if(mode==='save-verdict')f.state.saveErrors=[{project:'p',task:'t',error:'new unsaved completion'}];
    else f.state.scanError=true;
  };
  const result=await f.send();assert.equal(reads,2);assert.equal(f.checks.filter(c=>c[0]==='codex').length,2);
  if(['stop','runtime','identity','request','ai','save','save-verdict'].includes(mode)){assert.equal(result.status,409);assert.equal(f.launches.length,0);}
  else {assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.launches.length,1);assert.equal(f.launches[0].ai,'claude');}
});
test('additional scan failure and stop never spawn or repeat refresh', async t => {
  for(const mode of ['failure','stop']){
    const f=fixture(t);f.state.onScan=async n=>{await wait(5);if(n<3)f.advance(16000);else if(mode==='stop')f.stop();else throw Error('additional scan failed');};
    const result=await f.send();assert.equal(result.status,409);assert.equal(f.launches.length,0);assert.equal(f.reads.length,2);assert.equal(f.scans.length,3);
  }
});
test('duplicate arriving during replacement shares read and admits only one start',async t=>{
  const f=fixture(t);let release,reads=0;
  f.state.onScan=async n=>{await wait(5);if(n<=2)f.advance(16000);};
  f.state.onRead=ai=>{if(ai==='codex'&&++reads===2)return new Promise(r=>release=r);};
  const first=f.send();for(let i=0;i<100&&!release;i++)await wait(5);assert.equal(typeof release,'function');
  const second=f.send();await wait(5);release();const results=await Promise.all([first,second]);
  assert.equal(f.reads.length,2);assert.equal(f.launches.length,1);assert.equal(results.filter(r=>r.status===200).length,1);
});

test('cancelling the pending send during replacement returns before the read and never revives it',async t=>{
  const f=fixture(t);let release,reads=0;
  f.state.onScan=async n=>{await wait(5);if(n<=2)f.advance(16000);};
  f.state.onRead=ai=>{if(ai==='codex'&&++reads===2)return new Promise(r=>release=r);};
  const sent=f.send();for(let i=0;i<100&&!release;i++)await wait(5);assert.equal(typeof release,'function');
  const stopped=f.runner.stop('p','t',{interrupting:true});
  const result=await sent;await stopped;assert.equal(result.status,409);assert.equal(f.launches.length,0);
  release();await wait(10);assert.equal(f.launches.length,0);assert.equal(f.reads.length,2);assert.equal(f.scans.length,2);
});
