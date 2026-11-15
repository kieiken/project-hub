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
// Protocol tests replace every spawn; do not inspect the installed real CLI.
test.mock.method(require('../lib/cli-trust'), 'ensureCliReady', (_ai, file) => file);

const NOW = Date.parse('2026-10-03T00:00:00Z');
const codex = { rateLimits:{ limitId:'codex',primary:{usedPercent:0,windowDurationMins:10080,resetsAt:1791046922},secondary:null,credits:{balance:'SECRET'}} };
const claude = { subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:20,resets_at:'2026-10-03T05:00:00Z'},seven_day:null,model_scoped:[{display_name:'Fable',utilization:33,resets_at:'2026-10-07T13:00:00Z'}]},behaviors:{private:'SECRET'} };

const capacityModels = ['gpt-6.2-sol', 'gpt-6.1-astra'];
const contract = usedPercent => ({ rateLimits: { limitId: 'codex', primary: {
  usedPercent, windowDurationMins: 300, resetsAt: (NOW + 3600000) / 1000
}, credits: { hasCredits: true, balance: '10000' } } });
for (const used of [0, 25, 99.999, 100, 100.001, -1, null, '20', NaN]) {
  test(`混雑交代の残量は未丸め契約枠の数値だけで判定（${String(used)}）`, async () => {
    const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => contract(used) });
    assert.equal(u.subscriptionAvailable(capacityModels), false);
    await u.status(false, {}, { only: { ai: 'codex', account: 'default' } });
    assert.equal(u.subscriptionAvailable(capacityModels), typeof used === 'number' && used >= 0 && used < 100);
    assert.equal(u.subscriptionAvailable(capacityModels, 'other'), false);
  });
}
test('共有枠とモデル専用枠を両方確認し、別モデルの余裕・クレジット・context tokenで補わない', async () => {
  for (const [buckets, expected] of [
    [{ codex: { primary: { usedPercent: 30 } } }, true],
    [Object.fromEntries(capacityModels.map(id => [id, { primary: { usedPercent: 20 } }])), true],
    [{ [capacityModels[0]]: { primary: { usedPercent: 20 } } }, false],
    [{ codex: { primary: { usedPercent: 30 } }, [capacityModels[1]]: { secondary: { usedPercent: 100 } } }, false],
    [{ codex: { primary: { usedPercent: 30 }, secondary: { usedPercent: null, resetsAt: (NOW + 3600000) / 1000 } } }, false],
    [{ codex: { primary: { usedPercent: 30 }, secondary: { usedPercent: null } } }, false],
    [{ codex: { primary: { usedPercent: 30 } }, [capacityModels[1]]: { primary: {} } }, false],
    [{ codex: { primary: { usedPercent: 30 } }, ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => ['other-' + i, { primary: { usedPercent: 0 } }])), [capacityModels[1]]: { primary: { usedPercent: 100 } } }, false],
    [{ 'gpt-9-luna': { primary: { usedPercent: 0 } } }, false],
    [{}, false]
  ]) {
    const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => ({
      rateLimitsByLimitId: buckets, credits: { hasCredits: true, balance: '10000' }, tokens_remaining: 100000
    }) });
    await u.status(false, {}, { only: { ai: 'codex', account: 'default' } });
    assert.equal(u.subscriptionAvailable(capacityModels), expected, JSON.stringify(buckets));
    assert.ok(!JSON.stringify(u.snapshot()).includes('subscriptionWindows'));
  }
});
test('残量証明は古い/未来/遅い取得・失敗・認証変更・取得中・reset中・期限後には失効する', async () => {
  let now = NOW, fail = false;
  const u = new Usage({ now: () => now, find: ai => ai, read: async () => { if (fail) throw Error('unavailable'); return contract(25); } });
  const status = () => u.status(true, {}, { only: { ai: 'codex', account: 'default' } });
  await status(); assert.equal(u.subscriptionAvailable(capacityModels), true);
  now = NOW - 1; assert.equal(u.subscriptionAvailable(capacityModels), false);
  now = NOW + 300000; assert.equal(u.subscriptionAvailable(capacityModels), false);
  await status(); assert.equal(u.subscriptionAvailable(capacityModels), true);
  u.inflight.set('codex', Promise.resolve()); assert.equal(u.subscriptionAvailable(capacityModels), false); u.inflight.delete('codex');
  u.resetBusy.add('codex'); assert.equal(u.subscriptionAvailable(capacityModels), false); u.resetBusy.delete('codex');
  u.cache.codex.windows[0].resetsAt = new Date(now).toISOString(); assert.equal(u.subscriptionAvailable(capacityModels), false);
  now += 31000; fail = true; await status(); assert.equal(u.subscriptionAvailable(capacityModels), false);
  fail = false; now += 31000; await status(); u.invalidate('codex'); assert.equal(u.subscriptionAvailable(capacityModels), false);
  const slow = new Usage({ now: () => now, find: ai => ai, read: async () => { now += 300000; return contract(25); } });
  await slow.status(false, {}, { only: { ai: 'codex', account: 'default' } });
  assert.equal(slow.subscriptionAvailable(capacityModels), false);
});
test('混雑交代の証明は取得したアカウントだけに属し、ログアウトやアカウント削除で失う', async () => {
  let accountRows = ['default', 'work'].map(id => ({ ai: 'codex', id })), loggedIn = true, now = NOW;
  const u = new Usage({ now: () => now, find: ai => ai, accounts: {
    list: () => accountRows, status: async () => ({ status: loggedIn ? 'logged-in' : 'logged-out' })
  }, read: async () => contract(25) });
  await u.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  assert.equal(u.subscriptionAvailable(capacityModels, 'work'), true);
  assert.equal(u.subscriptionAvailable(capacityModels), false);
  assert.equal(u.subscriptionAvailable([], 'work'), false);
  loggedIn = false; now += 300000;
  await u.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  assert.equal(u.subscriptionAvailable(capacityModels, 'work'), false);
  loggedIn = true; u.loginChecked('codex', 'work', 'logged-in');
  await u.status(false, { codex: 'work' }, { only: { ai: 'codex', account: 'work' } });
  assert.equal(u.subscriptionAvailable(capacityModels, 'work'), true);
  accountRows = []; await u.status(false);
  assert.equal(u.subscriptionAvailable(capacityModels, 'work'), false);
});

test('Priority proof requires fresh numeric prepaid credits and is lost on failure, invalidation and slow reads', async () => {
  let now = NOW;
  for (const credits of [{ hasCredits: true, unlimited: true }, { hasCredits: true, unlimited: true, balance: '20' },
    { hasCredits: true, unlimited: false, balance: '20' }, { hasCredits: false, balance: '20' }, { hasCredits: true, balance: '0' }]) {
    const u = new Usage({ now: () => now, find: ai => ai, read: async () => ({ ...codex, rateLimits: { ...codex.rateLimits, credits } }) });
    assert.notEqual(u.creditState('codex').prepaid, true);
    const proof = await u.checkCredits('codex');
    assert.equal(proof.prepaid === true, credits.hasCredits === true && credits.unlimited !== true && credits.balance === '20');
    assert.notEqual(u.creditState('codex', 'other').prepaid, true);
    u.invalidate('codex'); assert.equal(u.creditState('codex').availability, 'unknown');
  }
  const slow = new Usage({ now: () => now, find: ai => ai, read: async () => {
    now += 30000; return { ...codex, rateLimits: { ...codex.rateLimits, credits: { hasCredits: true, balance: '20' } } };
  } });
  assert.equal((await slow.checkCredits('codex')).availability, 'unknown');
});

test('Priority setting is strict boolean, survives old-client writes and keeps roles, switch and permissions', () => {
  const roles = require('../lib/roles'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prefer-settings-')), file = path.join(dir, 'roles.yaml');
  const text = '# fixture\nroles: {}\nswitch:\n  auto: true\npermissions:\n  publish: false\n'; fs.writeFileSync(file, text);
  assert.equal(roles.read(file).data.preferCredits, false);
  const initialized = fs.readFileSync(file, 'utf8');
  for (const value of [null, 'true', 1, {}, []]) {
    assert.equal(roles.write(file, [], { codex: true }, false, value).ok, false); assert.equal(fs.readFileSync(file, 'utf8'), initialized);
  }
  assert.equal(roles.write(file, [], { codex: true }, false, true).data.preferCredits, true);
  const saved = fs.readFileSync(file, 'utf8'); assert.ok(saved.startsWith(text));
  assert.equal(roles.write(file, []).data.preferCredits, true); assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.equal(roles.write(file, [], undefined, false, false).data.preferCredits, false);
  fs.writeFileSync(file, 'preferCredits: "true"\n'); assert.equal(roles.read(file).data.preferCredits, false);
});

test('Credit checks read only the requested provider and account, share requests and preserve ordinary display', async () => {
  const calls = [], auth = [], rows = ['claude', 'codex'].flatMap(ai => ['default', 'work'].map(id => ({ ai, id })));
  let now = NOW;
  const u = new Usage({ now: () => now, find: ai => ai,
    accounts: { list: () => rows, status: async (ai, id) => { auth.push(ai + ':' + id); return { status: 'logged-in' }; } },
    read: async (ai, file, options) => {
      calls.push({ ai, ...options });
      await new Promise(resolve => setTimeout(resolve, 5));
      return ai === 'codex' ? { ...codex, rateLimits: { ...codex.rateLimits, credits: { hasCredits: true, balance: '12', unlimited: false } } } : claude;
    } });
  const results = await Promise.all([u.checkCredits('codex', 'work'), u.checkCredits('codex', 'work')]);
  assert.deepEqual(results.map(r => r.availability), ['available', 'available']);
  assert.deepEqual(calls, [{ ai: 'codex', account: 'work' }]);
  assert.deepEqual(auth, ['codex:work']);
  assert.equal(u.snapshot({ codex: 'work' }).providers.codex.credits.balance, '12');
  await u.checkCredits('codex', 'work'); assert.equal(calls.length, 1);
  now += 31000; await u.checkCredits('claude', 'default');
  assert.equal(calls.at(-1).ai, 'claude'); assert.equal(calls.at(-1).account, 'default');
  assert.ok(calls.every(c => Object.keys(c).sort().join(',') === 'account,ai'));
});

test('Claude monthly allowance is display-only and never proves a prepaid balance', async () => {
  for (const extra of [undefined, { is_enabled: true, monthly_limit: 100, used_credits: 1, utilization: 1, currency: 'USD', private: 'SECRET' },
    { is_enabled: true, utilization: 100 }, { is_enabled: false }, { is_enabled: 'true', utilization: '0' }]) {
    const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => ({ ...claude, rate_limits: { ...claude.rate_limits, extra_usage: extra } }) });
    const result = await u.checkCredits('claude');
    assert.equal(result.availability, 'unknown');
    assert.equal(result.balance, undefined);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|monthly_limit|used_credits|currency/);
    const visible = u.snapshot().providers.claude.extraUsage;
    if (extra?.currency === 'USD') assert.deepEqual(visible, { is_enabled: true, monthly_limit: 100, used_credits: 1, utilization: 1, currency: 'USD' });
    assert.doesNotMatch(JSON.stringify(u.snapshot()), /SECRET|private|disabled_reason/);
  }
  const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => ({ ...claude, extra_usage: { disabled_reason: 'out_of_credits' } }) });
  assert.equal((await u.checkCredits('claude')).availability, 'empty');
});

test('Claude extra usage exposes only validated display fields at both response locations', async () => {
  for (const nested of [true, false]) {
    const extra = { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD', utilization: 24.68,
      private: 'SECRET', disabled_reason: 'SECRET', balance: 999, account: 'SECRET', auto_reload: { enabled: true } };
    const data = { ...claude, rate_limits: { ...claude.rate_limits, ...(nested ? { extra_usage: extra } : {}) }, ...(nested ? {} : { extra_usage: extra }) };
    const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => data });
    const snapshot = await u.status(false, {}, { only: { ai: 'claude', account: 'default' } });
    const expected = { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD', utilization: 24.68 };
    assert.deepEqual(snapshot.providers.claude.extraUsage, expected);
    assert.deepEqual(snapshot.accountProviders[0].extraUsage, expected);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private|disabled_reason|balance|auto_reload/);
    assert.deepEqual(snapshot.providers.claude.windows, claudeWindows(claude));
    assert.equal(u.creditState('claude').availability, 'unknown');
  }
});

test('Claude extra usage omits malformed fields without coercion or default amounts/currency', async () => {
  const visible = async extra => {
    const u = new Usage({ now: () => NOW, find: ai => ai, read: async () => ({ ...claude, rate_limits: { ...claude.rate_limits, extra_usage: extra } }) });
    return (await u.status(false, {}, { only: { ai: 'claude', account: 'default' } })).providers.claude.extraUsage;
  };
  for (const extra of [undefined, null, [], 'SECRET', {}, { is_enabled: 'true' }, { is_enabled: 1 }]) assert.equal(await visible(extra), undefined);
  for (const value of [-1, Infinity, -Infinity, NaN, '1', null, undefined, {}, true]) {
    assert.deepEqual(await visible({ is_enabled: true, used_credits: value, monthly_limit: value, utilization: value }), { is_enabled: true });
  }
  for (const currency of ['usd', ' USD', 'USD\n', 'US', 'USDD', '<svg>', null, 123, {}]) {
    assert.deepEqual(await visible({ is_enabled: true, currency }), { is_enabled: true });
  }
  assert.deepEqual(await visible({ is_enabled: false }), { is_enabled: false });
  assert.deepEqual(await visible({ is_enabled: true, used_credits: 0, monthly_limit: 0, utilization: 0, currency: 'JPY' }),
    { is_enabled: true, used_credits: 0, monthly_limit: 0, utilization: 0, currency: 'JPY' });
});

test('Credit failures, stale/future timestamps and malformed balances remain unknown, and account invalidation rejects late reads', async () => {
  let now = NOW, fail = false, calls = 0;
  const u = new Usage({ now: () => now, find: ai => ai, read: async () => {
    calls++; if (fail) throw Error('SECRET');
    return { ...codex, rateLimits: { ...codex.rateLimits, credits: { hasCredits: true, balance: '7' } } };
  } });
  assert.equal((await u.checkCredits('codex')).availability, 'available');
  now -= 1; assert.equal((await u.checkCredits('codex')).availability, 'unknown');
  now = NOW + 31000; fail = true;
  assert.equal((await u.checkCredits('codex')).availability, 'unknown');
  assert.equal(calls, 2); assert.equal(u.snapshot().providers.codex.credits, undefined);
  for (const balance of ['0', '0.00', '9007199254740993123456789.50', '1e5', ' 3', null]) {
    const v = new Usage({ now: () => NOW, find: ai => ai, read: async () => ({ ...codex, rateLimits: { ...codex.rateLimits, credits: { hasCredits: true, balance } } }) });
    assert.equal((await v.checkCredits('codex')).availability, balance === '0' || balance === '0.00' ? 'empty' : balance === '9007199254740993123456789.50' ? 'available' : 'unknown');
  }
  let release;
  const v = new Usage({ now: () => NOW, find: ai => ai, read: () => new Promise(resolve => { release = resolve; }) });
  const pending = v.checkCredits('codex', 'work');
  await new Promise(resolve => setImmediate(resolve));
  v.invalidate('codex', 'work'); release(codex);
  assert.equal((await pending).availability, 'unknown'); assert.equal(v.cache['codex:work'], undefined);
});

test('Ordinary usage does not parse new credit check fields, and recent ordinary reads do not invent a balance check', async () => {
  let reads = 0;
  const u = new Usage({ now: () => NOW, find: ai => ai, read: async ai => { reads++; return ai === 'codex' ? codex : { ...claude, extra_usage: { is_enabled: true } }; } });
  const status = await u.status();
  assert.equal(status.providers.claude.creditCheck, undefined); assert.equal(status.providers.codex.creditCheck, undefined);
  assert.equal((await u.checkCredits('claude')).availability, 'unknown'); assert.equal(reads, 2);
});

test('Credit settings default OFF, reject non-booleans without saving, and preserve omitted provider settings and unrelated lines', () => {
  const roles = require('../lib/roles');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-credit-settings-')), file = path.join(d, 'roles.yaml');
  const text = '# fixture\nmodels: {}\nroles: {} # keep role comment\nswitch:\n  auto: true # keep auto\npermissions:\n  publish: false # keep permissions\n';
  fs.writeFileSync(file, text);
  assert.deepEqual(roles.read(file).data.checkCredits, { claude: false, codex: false });
  const initialized = fs.readFileSync(file, 'utf8');
  for (const value of [null, [], 'true', { claude: 'true' }, { codex: 1 }, { claude: null }, { other: true }]) {
    assert.equal(roles.write(file, [], value).ok, false); assert.equal(fs.readFileSync(file, 'utf8'), initialized);
  }
  assert.deepEqual(roles.write(file, [], { claude: true }).data.checkCredits, { claude: true, codex: false });
  assert.deepEqual(roles.write(file, [], { codex: true }).data.checkCredits, { claude: true, codex: true });
  fs.appendFileSync(file, '# final comment\n');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(saved.startsWith(text));
  assert.deepEqual(roles.write(file, []).data.checkCredits, { claude: true, codex: true });
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.deepEqual(roles.write(file, [], { claude: false }).data.checkCredits, { claude: false, codex: true });
  assert.deepEqual(roles.read(file).data.switch, { auto: true });
  assert.deepEqual(roles.read(file).data.permissions, { publish: false });
  fs.writeFileSync(file, 'checkCreditsClaude: "true"\ncheckCreditsCodex: 1\n');
  assert.deepEqual(roles.read(file).data.checkCredits, { claude: false, codex: false });
});

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
  for(const credits of [undefined,{balance:'10'},{hasCredits:'true',balance:'10'}]) assert.equal(await read(credits),undefined);
  assert.deepEqual(await read({hasCredits:true,unlimited:true,balance:null}),{unlimited:true});
  assert.deepEqual(await read({hasCredits:false,balance:'10',unlimited:true}),{hasCredits:false});
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
const ticketData = { ...codex, accountId:'remote-account', rateLimitResetCredits:{ availableCount:1, credits:[{ id:'PRIVATE-CREDIT', resetType:'codexRateLimits', status:'available', title:'Full reset', expiresAt:1794438000 }] } };
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
    if(m.id===2){const data=mode.startsWith('reset-')?${JSON.stringify(ticketData)}:${JSON.stringify(codex)};
      if(mode==='reset-account-change')data.accountId='different';
      if(mode==='reset-expired')data.rateLimitResetCredits.credits[0].expiresAt=1;
      if(mode==='reset-redeeming')data.rateLimitResetCredits.credits[0].status='redeeming';
      if(mode==='reset-count-only')data.rateLimitResetCredits.credits=null;
      send({id:2,result:data});}
    if(m.id===3){if(mode==='reset-timeout')return;if(mode==='reset-exit')process.exit(0);
      send({id:3,result:{outcome:mode==='reset-count-only'?'reset':mode.slice(6)}});}
  }else{
    const id=m.request_id;
    if(m.request.subtype==='initialize')send({type:'control_response',response:{request_id:id,subtype:'success',response:{account:{email:'SECRET'}}}});
    if(m.request.subtype==='get_usage')send({type:'control_response',response:{request_id:id,subtype:mode==='unsupported'?'error':'success',error:'SECRET',response:mode==='extra'?${JSON.stringify({ ...claude, rate_limits: { ...claude.rate_limits, extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD', utilization: 100, private: 'SECRET' } } })}:${JSON.stringify(claude)}}});
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
      assert.equal(f.args[0][f.args[0].indexOf('--model')+1],'claude-fable-5-2');
    }
    assert.ok(requests.every(x=>x.type!=='user' && !x.method?.includes('turn') && !x.method?.includes('thread')));
  }
});
test('Claude extra usage survives the existing control protocol without inference and does not affect limit holds', async t => {
  const f = fixture('claude', 'extra'), { ModelLimits } = require('../lib/model-limits');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-extra-display-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const limits = new ModelLimits(path.join(dir, 'limits.json'), { now: () => NOW });
  const u = new Usage({ now: () => NOW, find: ai => ai, observe: snapshot => limits.observe(snapshot),
    read: (ai, file) => readCli(ai, file, { spawn: f.spawn, timeoutMs: 3000 }) });
  const snapshot = await u.status(false, {}, { only: { ai: 'claude', account: 'default' } });
  assert.deepEqual(snapshot.providers.claude.extraUsage, { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: 'USD', utilization: 100 });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private|behaviors/);
  assert.equal(limits.active('default', 'claude-fable-5-2'), null, '100% extra usage must not add a subscription hold');
  assert.equal(u.creditState('claude').availability, 'unknown');
  const requests = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(r => r.request.subtype), ['initialize', 'get_usage']);
  assert.equal(requests[1].request.skip_behaviors, true);
  assert.ok(requests.every(r => r.type === 'control_request'));
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
test('Ticket consume protocol validates identity first, sends one UUID and exposes only the known outcome', async () => {
  for (const outcome of ['reset','nothingToReset','noCredit','alreadyRedeemed']) {
    const f=fixture('codex','reset-'+outcome);let saved=0;
    const r=await readCli('codex','codex',{spawn:f.spawn,timeoutMs:3000,now:()=>NOW,consume:{accountId:'remote-account',creditId:'PRIVATE-CREDIT',idempotencyKey:'attempt-uuid',beforeSend:()=>saved++}});
    assert.deepEqual(r,{outcome});assert.equal(saved,1);
    const req=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(req.map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read','account/rateLimitResetCredit/consume']);
    assert.deepEqual(req.at(-1).params,{idempotencyKey:'attempt-uuid',creditId:'PRIVATE-CREDIT'});
  }
});
test('Account change, expiry, redeeming and journal failure all stop before consume', async () => {
  for (const mode of ['reset-account-change','reset-expired','reset-redeeming','reset-reset']) {
    const f=fixture('codex',mode);
    await assert.rejects(readCli('codex','codex',{spawn:f.spawn,timeoutMs:3000,now:()=>NOW,consume:{accountId:'remote-account',creditId:'PRIVATE-CREDIT',idempotencyKey:'uuid',beforeSend:()=>{throw Error('SECRET');}}}),e=>e.consumeSent===false);
    assert.doesNotMatch(fs.readFileSync(f.log,'utf8'),/Credit\/consume/);
  }
});
test('Count-only ticket omits creditId; malformed outcomes, disconnects and timeout never resend', async () => {
  const f=fixture('codex','reset-count-only');
  await readCli('codex','codex',{spawn:f.spawn,timeoutMs:3000,now:()=>NOW,consume:{accountId:'remote-account',idempotencyKey:'uuid',beforeSend(){}}});
  const requests=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.at(-1).params,{idempotencyKey:'uuid'});
  for (const mode of ['reset-timeout','reset-exit','reset-unknown']) {
    const g=fixture('codex',mode);
    await assert.rejects(readCli('codex','codex',{spawn:g.spawn,timeoutMs:mode==='reset-timeout'?200:3000,now:()=>NOW,consume:{accountId:'remote-account',creditId:'PRIVATE-CREDIT',idempotencyKey:'uuid',beforeSend(){}}}),e=>e.consumeSent===true);
    assert.equal(fs.readFileSync(g.log,'utf8').split('account/rateLimitResetCredit/consume').length-1,1);
  }
});
