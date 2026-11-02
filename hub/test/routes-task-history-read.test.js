'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const create = require('../lib/routes/task-history-read');

function fixture() {
  const calls = [], values = { status: { generation: 3 }, selectionPreview: { model: 'chosen' }, continueStatus: { status: 'pending' },
    archives: [{ id: 'old' }], archive: { text: 'saved' }, auto: { generation: 3, auto: null } };
  const taskHistory = Object.fromEntries(['status', 'selectionPreview', 'continueStatus', 'archives', 'archive'].map(name =>
    [name, (...args) => { calls.push([name, ...args]); if (values[name] instanceof Error) throw values[name]; return values[name]; }]));
  const routes = create({ textBudget: {previewPending: async project => {calls.push(['previewPending',project]);if(values.pending instanceof Error)throw values.pending;return {key:'snapshot',pending:[]};}}, taskHistory, autoView: (...args) => { calls.push(['autoView', ...args]); if (values.auto instanceof Error) throw values.auto; return values.auto; },
    send: (res, status, body) => { calls.push(['send', status]); return { status, body }; } });
  assert.deepEqual(calls, [], 'registration must not read history or automatic progress');
  const run = (slot, path, header = '1') => routes[slot].handle({ method: 'GET', headers: header === undefined ? {} : { 'x-hub': header } }, {}, new URL(path, 'http://localhost'));
  return { routes, calls, values, run };
}

test('task history read matches only its GET routes and retains prefix/suffix matching', () => {
  const f = fixture(), matches = (slot, method, path) => f.routes[slot].matches({ method }, new URL(path, 'http://localhost'));
  assert.equal(matches('continuation', 'GET', '/api/task/continue/status'), true);
  assert.equal(matches('history', 'GET', '/api/task/history/nested/status'), true);
  assert.equal(matches('history', 'GET', '/api/task/history/unknown'), true);
  for (const [slot, method, path] of [['continuation', 'POST', '/api/task/continue/status'], ['continuation', 'GET', '/api/task/continue/status/'],
    ['history', 'POST', '/api/task/history/status'], ['history', 'GET', '/api/task/history'], ['history', 'GET', '/api/task/steps']])
    assert.equal(matches(slot, method, path), false);
});

test('task history read rejects an unconfirmed connection before reading any state, even for an unknown path', async () => {
  const f = fixture();
  for (const [slot, path] of [['continuation', '/api/task/continue/status'], ['history', '/api/task/history/status'], ['history', '/api/task/history/unknown']]) {
    for (const header of ['', 'true', 1]) {
      f.calls.length = 0;
      assert.deepEqual(await f.run(slot, path, header), { status: 403, body: { error: 'forbidden' } });
      assert.deepEqual(f.calls, [['send', 403]]);
    }
  }
});

test('continuation status passes the request identity through and returns synchronous errors as 409', async () => {
  const f = fixture();
  assert.deepEqual(await f.run('continuation', '/api/task/continue/status?project=p&task=t&requestId=request'), { status: 200, body: f.values.continueStatus });
  assert.deepEqual(f.calls, [['continueStatus', 'p', 't', 'request'], ['send', 200]]);
  f.calls.length = 0; f.values.continueStatus = Error('request mismatch');
  assert.deepEqual(await f.run('continuation', '/api/task/continue/status'), { status: 409, body: { error: 'request mismatch' } });
  assert.deepEqual(f.calls, [['continueStatus', null, null, null], ['send', 409]]);
});

test('history status reads status before selection and only selection=0 suppresses the preview', async () => {
  const f = fixture();
  for (const suffix of ['', '&selection=', '&selection=1']) {
    f.calls.length = 0;
    assert.deepEqual(await f.run('history', '/api/task/history/status?project=p&task=t' + suffix),
      { status: 200, body: { generation: 3, selection: f.values.selectionPreview } });
    assert.deepEqual(f.calls, [['previewPending','p'], ['status', 'p', 't', {bodyPreview:{key:'snapshot',pending:[]}}], ['selectionPreview', 'p', 't'], ['send', 200]]);
  }
  f.calls.length = 0;
  assert.deepEqual(await f.run('history', '/api/task/history/status?project=p&task=t&selection=0'), { status: 200, body: { generation: 3 } });
  assert.deepEqual(f.calls, [['previewPending','p'], ['status', 'p', 't', {bodyPreview:{key:'snapshot',pending:[]}}], ['send', 200]]);
});

test('history status stops at the first failing read and selection failure remains a 409', async () => {
  const f = fixture(); f.values.status = Error('missing task');
  assert.deepEqual(await f.run('history', '/api/task/history/status'), { status: 409, body: { error: 'missing task' } });
  assert.deepEqual(f.calls, [['previewPending',null], ['status', null, null, {bodyPreview:{key:'snapshot',pending:[]}}], ['send', 409]]);
  f.calls.length = 0; f.values.status = {}; f.values.selectionPreview = Error('selection unavailable');
  assert.deepEqual(await f.run('history', '/api/task/history/status'), { status: 409, body: { error: 'selection unavailable' } });
  assert.deepEqual(f.calls, [['previewPending',null], ['status', null, null, {bodyPreview:{key:'snapshot',pending:[]}}], ['selectionPreview', null, null], ['send', 409]]);
});

test('history auto reads current progress at request time without starting automatic work', async () => {
  const f = fixture();
  for (const generation of [3, 4]) {
    f.values.auto = { generation, auto: { phase: 'held' } }; f.calls.length = 0;
    assert.deepEqual(await f.run('history', '/api/task/history/auto?project=p&task=t'), { status: 200, body: f.values.auto });
    assert.deepEqual(f.calls, [['autoView', 'p', 't'], ['send', 200]]);
  }
  f.values.auto = Error('read unavailable');
  assert.equal((await f.run('history', '/api/task/history/auto')).status, 409);
});

test('history archives preserve wrappers, archive identifiers and offsets without coercion', async () => {
  const f = fixture();
  assert.deepEqual(await f.run('history', '/api/task/history/archives?project=p&task=t'), { status: 200, body: { archives: f.values.archives } });
  assert.deepEqual(f.calls, [['archives', 'p', 't'], ['send', 200]]);
  f.calls.length = 0;
  assert.deepEqual(await f.run('history', '/api/task/history/archive?project=p&task=t&archiveId=old%2F2&offset=004'), { status: 200, body: f.values.archive });
  assert.deepEqual(f.calls, [['archive', 'p', 't', 'old/2', '004'], ['send', 200]]);
  f.calls.length = 0; f.values.archive = Error('archive missing');
  assert.deepEqual(await f.run('history', '/api/task/history/archive'), { status: 409, body: { error: 'archive missing' } });
  assert.deepEqual(f.calls, [['archive', null, null, null, null], ['send', 409]]);
});

test('unknown history paths return 404 after connection validation without accessing task state', async () => {
  const f = fixture();
  assert.deepEqual(await f.run('history', '/api/task/history/status/'), { status: 404, body: { error: 'not found' } });
  assert.deepEqual(f.calls, [['send', 404]]);
});

test('history display refuses an unreadable journal snapshot before displaying readiness', async () => {const f=fixture();f.values.pending=Error('journal changed');assert.deepEqual(await f.run('history','/api/task/history/status?project=p&task=t'),{status:409,body:{error:'journal changed'}});assert.deepEqual(f.calls,[['previewPending','p'],['send',409]]);});
