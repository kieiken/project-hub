'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const send = (_res, status, body) => ({ status, body });
const url = p => new URL('http://localhost' + p), lt = s => s;

test('transfer matching evaluates the original destination checks once before applying', () => {
  const calls = [], b = { project: 'p', task: 't' };
  const routes = require('../lib/routes/task-integration')({ send, taskTransfer: {
    read: () => { calls.push('read'); return { destination: 'parent' }; },
    apply: input => { assert.equal(input, b); calls.push('apply'); return { parentProject: 'p', parent: 'parent' }; },
  }, setUnread: () => calls.push('unread'), record: () => calls.push('audit') });
  assert.deepEqual(calls, []);
  assert.equal(routes.handup.matches({}, url('/api/task/absorb'), b), true);
  assert.equal(routes.handup.handle({}, {}, url('/api/task/absorb'), b).status, 200);
  assert.deepEqual(calls, ['read', 'read', 'apply', 'unread', 'audit']);
});

test('an integrating transfer falls through to integration without applying a handup', () => {
  let applied = false;
  const routes = require('../lib/routes/task-integration')({ taskTransfer: { read: () => ({ destination: 'parent', integrating: true }), apply: () => { applied = true; } } });
  assert.equal(routes.handup.matches({}, url('/api/task/absorb'), {}), false);
  assert.equal(routes.apply.matches({}, url('/api/task/absorb')), true);
  assert.equal(applied, false);
});

test('merge status obtains the current flow only when requested, without an initialization snapshot', async () => {
  let current = { statusAsync: async () => ({ state: 'first' }) }, reads = 0;
  const t = { id: 't', workdir: 'copy' }, routes = require('../lib/routes/task-integration')({ send,
    store: { readProject: () => ({ tasks: [t] }) }, inWork: () => true, copyMissing: () => false,
    expandHome: s => s, gitw: { mainOfAsync: async () => 'main' }, getMainMergeFlow: () => { reads++; return current; } });
  assert.equal(reads, 0);
  const run = () => routes.mergeStatus.handle({}, {}, url('/api/task/merge/status'), { project: 'p', task: 't', flow: true });
  assert.equal((await run()).body.state, 'first'); current = { statusAsync: async () => ({ state: 'second' }) };
  assert.equal((await run()).body.state, 'second'); assert.equal(reads, 2);
});

test('MCP rejects missing Hub marker before reading a request body', async () => {
  let read = false, called = false;
  const routes = require('../lib/routes/mcp-settings')({ send, lt, readBody: async () => { read = true; }, gpt: { call: () => { called = true; } } });
  assert.equal((await routes.tools.handle({ method: 'POST', headers: {} }, {}, url('/api/mcp/call'))).status, 403);
  assert.equal(read, false); assert.equal(called, false);
});

test('MCP refuses forged internal requests and migrated topic writes before dispatch', async () => {
  let body = { origin: 'hub-internal' }, called = false;
  const routes = require('../lib/routes/mcp-settings')({ send, lt, readBody: async () => body,
    gpt: { call: () => { called = true; return 'read result'; } }, freetalkHistory: { state: () => ({ migrated: true }) } });
  const run = () => routes.tools.handle({ method: 'POST', headers: { 'x-hub': '1' } }, {}, url('/api/mcp/call'));
  assert.equal((await run()).body.delivery, 'not-sent'); assert.equal(called, false);
  body = { name: 'hub_update_task', arguments: { project: 'freetalk', task: 't' } };
  assert.equal((await run()).status, 409); assert.equal(called, false);
  body.name = 'hub_get_chat'; assert.equal((await run()).status, 200); assert.equal(called, true);
});

test('raw attachment rejects stale conversation before consuming or storing bytes', async () => {
  let read = false, resumed = false;
  const routes = require('../lib/routes/task-attachments')({ send, lt, store: { readProject: () => ({ id: 'p' }), taskFile: () => 'task-file' }, taskHistory: { state: () => ({ generation: 2 }) }, readRaw: () => { read = true; } });
  const result = await routes.upload.handle({ headers: {}, resume: () => { resumed = true; } }, {}, url('/api/task/upload?project=p&task=t&generation=1'));
  assert.equal(result.status, 409); assert.equal(read, false); assert.equal(resumed, true);
});

test('oversized freetalk attachment releases its upload hold without storing', async () => {
  const calls = [];
  const routes = require('../lib/routes/task-attachments')({ send, lt, store: { readProject: () => ({ id: 'freetalk', kind: 'freetalk' }), taskFile: () => 'task-file' },
    freetalk: { holdUpload: () => { calls.push('hold'); return () => calls.push('release'); } },
    readRaw: async () => { calls.push('read'); throw Error('oversized'); } });
  const result = await routes.upload.handle({ headers: {}, resume() {} }, {}, url('/api/task/upload?project=freetalk&task=t&generation=1'));
  assert.equal(result.status, 413); assert.deepEqual(calls, ['hold', 'read', 'release']);
});

test('path attachment rolls back earlier attachments and releases its hold on a later failure', async () => {
  const calls = [], attachment = { referencePaths: ['first'] };
  const routes = require('../lib/routes/task-attachments')({ send, lt, store: { readProject: () => ({ id: 'freetalk', kind: 'freetalk' }), taskFile: () => 'task-file' },
    freetalk: { holdUpload: () => { calls.push('hold'); return () => calls.push('release'); } },
    freetalkAttachments: { fromPath: async (_task, p) => { calls.push(p); if (p === 'second') throw Error('failed'); return attachment; }, discard: (_task, a) => { assert.equal(a, attachment); calls.push('discard'); } } });
  const result = await routes.attach.handle({}, {}, url('/api/task/attach'), { task: 't', paths: ['first', 'second'], generation: 1 });
  assert.equal(result.status, 409); assert.deepEqual(calls, ['hold', 'first', 'second', 'discard', 'release']);
});

test('terminal stream replays before watching and removes its subscription on close', () => {
  const calls = [], req = new EventEmitter(), res = { writeHead: () => calls.push('headers'), write: s => calls.push(s) };
  const routes = require('../lib/routes/terminal-io')({ send, lt, sessions: { get: () => ({ buf: 'output', exited: true, code: 0 }), watch: () => { calls.push('watch'); return () => calls.push('off'); } }, setUnread: () => calls.push('read') });
  routes.stream.handle(req, res, url('/api/term/stream?project=p&task=t&ai=codex'));
  try { assert.deepEqual(calls.slice(0, 2), ['read', 'headers']); assert.match(calls[2], /"replay":true/); assert.match(calls[3], /"type":"exit"/); assert.equal(calls[4], 'watch'); }
  finally { req.emit('close'); }
  assert.equal(calls[5], 'off');
});
