'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MuseSettings } = require('../lib/muse-settings');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-muse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = path.join(root, 'tool'); fs.mkdirSync(tool, { mode: 0o700 });
  fs.writeFileSync(path.join(tool, 'pinned.py'), 'fixed', { mode: 0o600 });
  const hashes = { 'pinned.py': crypto.createHash('sha256').update('fixed').digest('hex') };
  return { root, tool, hashes };
}

test('selection pins reviewed files; status projects metadata and terminal argv never contain credentials', async t => {
  const f = fixture(t), calls = [];
  const service = new MuseSettings({ ...f, platform: 'darwin', run: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ configured: true, trialUsed: true, replyReceived: true,
      completionVerified: false, auth_ref: 'SECRET', cookie_header: 'SECRET', replies: ['SECRET'] }) };
  } });
  assert.deepEqual(await service.status(), { supported: true, toolReady: false, configured: false, existingAvailable: false });
  service.select(f.tool);
  assert.equal(fs.statSync(service.file).mode & 0o777, 0o600);
  const status = await service.status();
  assert.equal(status.replyReceived, true); assert.equal(status.completionVerified, false);
  assert.equal(JSON.stringify(status).includes('SECRET'), false);
  const command = await service.command('update', s => `'${s.replaceAll("'", "'\\''")}'`);
  assert.match(command, /terminal\.py/); assert.match(command, /'update'$/);
  assert.equal(command.includes('SECRET'), false);
  assert.deepEqual(calls[0][2].env, { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
  fs.writeFileSync(path.join(f.tool, 'pinned.py'), 'modified');
  assert.throws(() => service.folder());
});

test('links, writable files and wrong hashes are rejected; busy trial and state reject before terminal', async t => {
  const f = fixture(t);
  const service = new MuseSettings({ ...f, platform: 'darwin', run: async () => ({ stdout: JSON.stringify({ configured: true, trialUsed: true, replyReceived: false, busy: true }) }) });
  fs.chmodSync(path.join(f.tool, 'pinned.py'), 0o666); assert.throws(() => service.select(f.tool));
  fs.chmodSync(path.join(f.tool, 'pinned.py'), 0o600);
  const link = path.join(f.root, 'link'); fs.symlinkSync(f.tool, link); assert.throws(() => service.select(link));
  service.select(f.tool);
  await assert.rejects(service.command('update', String));
  await assert.rejects(service.command('send', String));
  assert.deepEqual(await new MuseSettings({ root: f.root, platform: 'win32' }).status(), { supported: false, toolReady: false, configured: false });
});

test('workspace context must be an existing task; list projects only allowlisted permit metadata', async t => {
  const f = fixture(t);
  const tasks = path.join(f.root, 'Product', 'Synthetic', '.ai', 'tasks'); fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'task.md'), '# fixture');
  const calls = [], service = new MuseSettings({ ...f, platform: 'darwin', run: async (...args) => {
    calls.push(args); return { stdout: JSON.stringify({ permits: [{ id: 'grant', kind: 'share', expires_at: '2026-10-25T00:00:00Z',
      remaining: 2, revoked: false, target: 'Muse', account: 'fixture', auth_ref: 'SECRET', cookie: 'SECRET', scope: 'SECRET' }] }) };
  } });
  service.select(f.tool);
  for (const [project, task] of [['..', 'task'], ['Synthetic', '../task'], ['Synthetic', 'missing'], ['Synthetic\u202e', 'task']]) {
    assert.throws(() => service.workspace(project, task));
  }
  const permits = await service.workspacePermits('Synthetic', 'task');
  assert.equal(permits.permits[0].remaining, 2); assert.doesNotMatch(JSON.stringify(permits), /SECRET/);
  assert.match(service.workspaceCommand('Synthetic', 'task', JSON.stringify), /"workspace" "Synthetic" "task"$/);
  assert.equal(calls[0][1].includes('permits'), true); assert.equal(calls[0][1].includes('--run'), false);
});

test('direct diagnostics and local evidence project only fixed fields; inspection has no live/run authority',async()=>{
  let output,captured;const service=new MuseSettings({root:'/synthetic',run:async(...args)=>{captured=args;return {stdout:JSON.stringify(output)};}});
  service.workspace=()=>({tool:'/synthetic/fixed'});
  output={status:'rejected',diagnostic:{code:'before_send_rejected',phase:'history',open_confirmed:true,secret:'SECRET'},secret:'SECRET'};
  assert.deepEqual(await service.directChat('p','t','/synthetic/request.json'),{status:'rejected',diagnostic:{code:'before_send_rejected',phase:'history',open_confirmed:true}});
  output={status:'unknown',diagnostic:{code:'send_uncertain',phase:'send',open_confirmed:true,secret:'SECRET'}};
  assert.equal((await service.directChat('p','t','/synthetic/request.json')).status,'unknown');
  for(const bad of [{status:'rejected',diagnostic:{code:'send_uncertain',phase:'send',open_confirmed:true}},{status:'unknown',diagnostic:{code:'send_uncertain',phase:'history',open_confirmed:true}}]){output=bad;await assert.rejects(service.directChat('p','t','/synthetic/request.json'));}
  output={status:'not-sent',diagnostic:{code:'exchange_limit',phase:'send_prepare',open_confirmed:true,secret:'SECRET'}};
  assert.deepEqual(await service.directChat('p','t','/synthetic/request.json'),{status:'not-sent',diagnostic:{code:'exchange_limit',phase:'send_prepare',open_confirmed:true}});
  await assert.rejects(service.directRead('p','t','/synthetic/request.json'));
  for(const diagnostic of [{code:'exchange_limit',phase:'send',open_confirmed:true},{code:'send_uncertain',phase:'send_prepare',open_confirmed:true},{code:'exchange_limit',phase:'send_prepare',open_confirmed:false}]) {
    output={status:'not-sent',diagnostic};await assert.rejects(service.directChat('p','t','/synthetic/request.json'));
  }
  output={status:'not-sent',scope:'question-only',open_confirmed:true,project:'p',task:'t',id:'direct_00000000-0000-4000-8000-000000000001',discussion_id:'d',requestSHA:'a'.repeat(64),decisionSHA:'b'.repeat(64),markerSHA:'c'.repeat(64),digest:'d'.repeat(64),secret:'SECRET'};
  assert.doesNotMatch(JSON.stringify(await service.directInspect('p','t','/synthetic/request.json')),/SECRET/);
  assert.ok(captured[1].includes('direct-inspect'));for(const arg of ['--run','direct-chat','direct-read','--checked-digest'])assert.ok(!captured[1].includes(arg));
  assert.deepEqual(captured[2].env,{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'});
  output={...output,scope:'follow-up-none'};assert.equal((await service.directInspect('p','t','/synthetic/request.json')).scope,'follow-up-none');
  output={...output,scope:'unproven'};await assert.rejects(service.directInspect('p','t','/synthetic/request.json'));
  output={...output,scope:'follow-up-none',project:'other'};await assert.rejects(service.directInspect('p','t','/synthetic/request.json'));
});

test('usage projection whitelists fields; explicit read is single-flight with fixed errors and no retries', async () => {
  const {projectUsage}=require('../lib/muse-settings');
  const data={plan:'Power',usedPercent:20,resetsAt:'2026-10-27T00:00:00Z',renewsAt:null,tokensLeftLabel:'2.8B tokens left',topup:{label:'Additional',value:'$2.50 left'},checkedAt:'2026-10-26T00:00:00Z'};
  assert.doesNotMatch(JSON.stringify(projectUsage({usage:{...data,cookie:'SECRET'},headers:'SECRET',body:'SECRET'})),/SECRET/);
  for(const usedPercent of [undefined,null,NaN,Infinity,'0',-1,101])assert.throws(()=>projectUsage({usage:{...data,usedPercent}}));
  assert.deepEqual(projectUsage({usage:null,error:'SECRET'}),{usage:null});
  const service=new MuseSettings({root:'/synthetic'});service.status=async()=>({configured:true});
  let resolve,calls=0;service.usageCall=async op=>{calls++;assert.equal(op,'usage-read');return await new Promise(r=>resolve=r);};
  const first=service.usageRead();await new Promise(r=>setImmediate(r));
  assert.deepEqual(await service.usageRead(),{usage:null,error:'busy'});assert.equal(calls,1);
  resolve({usage:data});assert.deepEqual(await first,{usage:data});
  service.usageCall=async()=>{calls++;throw Error('SECRET');};
  assert.deepEqual(await service.usageRead(),{usage:null,error:'network'});assert.equal(calls,2);
  service.status=async()=>({configured:false});assert.deepEqual(await service.usageRead(),{usage:null,error:'unconfigured'});assert.equal(calls,2);
});

test('usage status and explicit read work without projects or tasks; launcher has no task context', async t => {
  const f=fixture(t),calls=[];
  const service=new MuseSettings({...f,platform:'darwin',run:async(...args)=>{calls.push(args);return {stdout:JSON.stringify(args[1].at(-1)==='status' ? {configured:true,trialUsed:false,replyReceived:false} : {usage:null})};}});
  service.select(f.tool);
  service.workspace=()=>{throw Error('must not depend on a task');};
  assert.equal(fs.existsSync(path.join(f.root,'Product')),false);
  assert.equal((await service.status()).usage,null);
  assert.equal(calls.some(c=>c[1].includes('usage-read')),false);
  assert.deepEqual(await service.usageRead(),{usage:null});
  assert.equal(calls.filter(c=>c[1].includes('usage-read')).length,1);
  for(const call of calls){assert.ok(!call[1].includes('--project'));assert.ok(!call[1].includes('--task'));assert.ok(!call[1].includes('--run'));}
  assert.deepEqual(calls[0][2].env,{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'});
  const count=calls.length;
  await assert.rejects(service.usageCall('arbitrary'));assert.equal(calls.length,count);
});
