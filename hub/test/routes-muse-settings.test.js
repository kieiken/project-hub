'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const create = require('../lib/routes/muse-settings');
const url = p => new URL(p, 'http://localhost:4545');
const send = (_, status, body) => ({ status, body });
const req = headers => ({ headers: headers || { 'x-hub': '1', origin: 'http://localhost:4545' } });

test('remote, unmarked and foreign-origin requests cannot read metadata or open authentication terminal', async () => {
  let calls = 0, remote = false;
  const routes = create({ send, PORT: 4545, fromRemote: () => remote,
    muse: { status: () => { calls++; }, select: () => { calls++; }, command: () => { calls++; } } });
  for (const headers of [{}, { 'x-hub': '1', origin: 'https://evil.invalid' }]) {
    assert.equal((await routes.read.handle(req(headers), {})).status, 403);
    assert.equal((await routes.write.handle(req(headers), {}, url('/api/muse/tool'), { folder: '/tmp', confirm: true })).status, 403);
  }
  remote = true; assert.equal((await routes.read.handle(req(), {})).status, 403);
  assert.equal(calls, 0);
});

test('exact action schemas reject secrets, deletion without confirmation and sends; errors/logs never echo input', async () => {
  const calls = [];
  const routes = create({ send, PORT: 4545, fromRemote: () => false, DRY: true,
    muse: { status: async () => ({ configured: true }), select: folder => calls.push(['select', folder]),
      command: async action => { calls.push(['command', action]); return 'bounded'; } },
    launch: { sq: String, openTerminal: async (...v) => calls.push(['terminal', ...v]) },
    record: (...v) => calls.push(['record', ...v]),
  });
  for (const body of [null, [], { action: 'update', confirm: true, cookie: 'SECRET' }, { action: 'disconnect' }, { action: 'send', confirm: true }]) {
    const result = await routes.write.handle(req(), {}, url('/api/muse/terminal'), body);
    assert.equal(result.status, 400); assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  assert.equal(calls.length, 0);
  assert.equal((await routes.write.handle(req(), {}, url('/api/muse/terminal'), { action: 'update', confirm: true })).status, 200);
  assert.deepEqual(calls, [['command', 'update'], ['terminal', 'bounded', true], ['record', 'museTerminal', {}, { operation: 'update' }]]);
});

test('workspace entry accepts only metadata and human menu, never arbitrary tools or approvals', async () => {
  const calls = [];
  const routes = create({ send, PORT: 4545, fromRemote: () => false,
    muse: { workspacePermits: async (...args) => { calls.push(args); return { permits: [] }; },
      workspaceCommand: (...args) => { calls.push(args.slice(0, 2)); return 'human menu'; } },
    launch: { sq: String, openTerminal: async c => calls.push(c) }, record: () => {} });
  const target = url('/api/muse/workspace'), context = { project: 'Synthetic', task: 'task', confirm: true };
  assert.equal(routes.write.matches({ method: 'POST' }, target), true);
  for (const body of [{ ...context, action: 'send' }, { ...context, action: 'manage', cookie: 'SECRET' }, { ...context, action: 'approve' }, { ...context, action: 'manage', confirm: false }]) {
    const response = await routes.write.handle(req(), {}, target, body);
    assert.equal(response.status, 400); assert.doesNotMatch(JSON.stringify(response), /SECRET/);
  }
  assert.equal(calls.length, 0);
  assert.equal((await routes.write.handle(req(), {}, target, { ...context, action: 'permits' })).status, 200);
  assert.equal((await routes.write.handle(req(), {}, target, { ...context, action: 'manage' })).status, 200);
  assert.deepEqual(calls, [['Synthetic', 'task'], ['Synthetic', 'task'], 'human menu']);
});

test('workspace accepts a server-checked generation without passing it to commands or records', async () => {
  const calls = [], quote = String;
  const routes = create({ send, PORT: 4545, fromRemote: () => false, DRY: true,
    muse: { workspacePermits: async (...args) => { calls.push(['permits', ...args]); return { permits: [] }; },
      workspaceCommand: (...args) => { calls.push(['command', ...args]); return 'human menu'; } },
    launch: { sq: quote, openTerminal: async (...args) => calls.push(['terminal', ...args]) },
    record: (...args) => calls.push(['record', ...args]) });
  // The shared server guard checks the current generation before this route runs.
  const context = { project: 'Synthetic', task: 'task', confirm: true, generation: 3 };
  for (const action of ['permits', 'manage']) {
    assert.equal((await routes.write.handle(req(), {}, url('/api/muse/workspace'), { ...context, action })).status, 200);
  }
  assert.deepEqual(calls, [['permits', 'Synthetic', 'task'], ['command', 'Synthetic', 'task', quote],
    ['terminal', 'human menu', true], ['record', 'museWorkspaceTerminal', {}, { operation: 'manage' }]]);
});

test('workspace rejects non-safe-integer generations and preserves the remaining schema restrictions', async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw Error('must not run'); };
  const routes = create({ send, PORT: 4545, fromRemote: () => false,
    muse: { workspacePermits: unexpected, workspaceCommand: unexpected },
    launch: { sq: String, openTerminal: unexpected }, record: unexpected });
  const context = { project: 'Synthetic', task: 'task', confirm: true, generation: 3 };
  for (const action of ['permits', 'manage']) {
    const body = { ...context, action };
    const { confirm, ...unconfirmed } = body;
    for (const invalid of [
      ...[undefined, null, '3', 3.5, true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1].map(generation => ({ ...body, generation })),
      { ...body, cookie: 'SECRET' }, { ...body, command: 'SECRET' },
      { ...body, confirm: false }, unconfirmed, { ...body, action: 'approve' },
    ]) {
      const response = await routes.write.handle(req(), {}, url('/api/muse/workspace'), invalid);
      assert.equal(response.status, 400);
      assert.doesNotMatch(JSON.stringify(response), /SECRET/);
    }
  }
  assert.equal(calls, 0);
});

test('usage requires a local browser Origin, Hub marker and exact human confirmation; GET never fetches usage', async () => {
  let calls=0,remote=false;
  const routes=create({send,PORT:4545,fromRemote:()=>remote,muse:{usageRead:async()=>{calls++;return {usage:null,error:'auth'};},status:async()=>({configured:true})}});
  const target=url('/api/muse/usage');assert.equal(routes.write.matches({method:'POST'},target),true);
  for(const headers of [{},{'x-hub':'1'},{origin:'http://localhost:4545'},{'x-hub':'1',origin:'https://evil.invalid'}])assert.equal((await routes.write.handle(req(headers),{},target,{confirm:true})).status,403);
  for(const body of [null,[],{}, {confirm:false},{confirm:true,cookie:'SECRET'},{confirm:true,action:'send'}]) {
    const r=await routes.write.handle(req(),{},target,body);assert.equal(r.status,400);assert.doesNotMatch(JSON.stringify(r),/SECRET/);
  }
  remote=true;assert.equal((await routes.write.handle(req(),{},target,{confirm:true})).status,403);remote=false;
  assert.equal(calls,0);
  assert.equal((await routes.read.handle(req(),{},url('/api/muse'))).status,200);assert.equal(calls,0);
  assert.equal((await routes.write.handle(req(),{},target,{confirm:true})).body.error,'auth');assert.equal(calls,1);
});
