'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const create = require('../lib/routes/chat-read');
const target = new URL('http://localhost/api/chat/stream?project=p&task=t');

function fixture(t, { kind = 'project' } = {}) {
  const order = [], writes = [], requests = [], queue = Object.freeze([{ id: 'manual-hold', hold: true }]);
  let project = { id: 'p', dir: '/fixture', kind }, exists = true, run = null, external, generation = 3, watching;
  let rows = [{ role: 'user', text: 'hello', at: 1 }];
  const timer = {};
  t.mock.method(global, 'setInterval', (callback, ms) => { order.push(['timer', ms]); timer.callback = callback; return timer; });
  t.mock.method(global, 'clearInterval', id => { assert.equal(id, timer); order.push('clear-timer'); });
  const records=[];
  const ctx = {
    record: (...args) => records.push(args),
    send: (res, status, body) => { order.push(['send', status]); return { status, body }; }, lt: s => s,
    store: { readProject: id => { assert.equal(id, 'p'); order.push('project'); return project; },
      taskFile: (p, task) => { assert.deepEqual([p, task], ['p', 't']); order.push('task'); return exists; } },
    setUnread: (p, task, value) => { assert.deepEqual([p, task, value], ['p', 't', false]); order.push('read'); },
    taskHistory: { state: () => { order.push('task-generation'); return { generation }; } },
    freetalkHistory: { state: task => { assert.equal(task, 't'); order.push('topic-generation'); return { generation: 9 }; } },
    ideaRows: (value, current) => { order.push(['decorate', current]); return value.map(row => ({ ...row, idea: current })); },
    chat: { read: (dir, task) => { assert.deepEqual([dir, task], ['/fixture', 't']); order.push('history'); return rows; } },
    chats: { busy: () => { order.push('busy'); return run; }, queue: () => { order.push('queue'); return queue; },
      watch: (p, task, emit) => { assert.deepEqual([p, task], ['p', 't']); order.push('watch'); watching = emit; return () => order.push('unwatch'); } },
    getWebchat: () => { order.push('external'); return external; },
  };
  const route = create(Object.freeze(ctx)).stream;
  assert.deepEqual(order, [], 'registration must not read late state');
  external = { busy: () => [] };
  function open() {
    const req = new EventEmitter(); req.method = 'GET'; requests.push(req);
    const res = { writeHead: (status, headers) => { order.push(['head', status, headers]); },
      write: value => { order.push('write'); writes.push(value); } };
    const value = route.handle(req, res, target);
    return { req, res, value };
  }
  t.after(() => { for (const req of requests) req.emit('close'); });
  return { route, order, writes, timer, queue, open, records,
    events: () => writes.filter(v => v.startsWith('data: ')).map(v => JSON.parse(v.slice(6))),
    pending: fn => { ctx.taskHistory.pendingQuestion = fn; },
    emit: ev => watching(ev), project: value => { project = value; }, exists: value => { exists = value; },
    run: value => { run = value; }, external: value => { external = value; }, generation: value => { generation = value; }, rows: value => { rows = value; } };
}

test('chat stream accepts only its GET and rejects a missing target before read marks or subscription', t => {
  const f = fixture(t);
  assert.equal(f.route.matches({ method: 'GET' }, target), true);
  for (const [method, pathname] of [['POST', '/api/chat/stream'], ['GET', '/api/chat/send'], ['GET', '/api/chat/stream/']])
    assert.equal(f.route.matches({ method }, new URL(pathname, target)), false);
  f.project(null);
  assert.deepEqual(f.open().value, { status: 404, body: { error: '作業が見つかりません' } });
  assert.deepEqual(f.order, ['project', ['send', 404]]);
  f.order.length = 0; f.project({ id: 'p', dir: '/fixture' }); f.exists(false);
  assert.equal(f.open().value.status, 404);
  assert.deepEqual(f.order, ['project', 'task', ['send', 404]]);
});

test('chat stream sends history and queue before subscribing and releases the subscription and ping on close', t => {
  const f = fixture(t), { req, value } = f.open();
  assert.equal(value, undefined);
  assert.deepEqual(f.order, ['project', 'task', 'read', ['head', 200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }],
    'busy', 'external', 'task-generation', 'history', 'queue', 'task-generation', ['decorate', 3], 'write', 'watch', ['timer', 20000]]);
  assert.deepEqual(f.events(), [{ type: 'rows', generation: 3, rows: [{ role: 'user', text: 'hello', at: 1, idea: 3 }], busy: null, queue: f.queue }]);
  f.timer.callback(); assert.equal(f.writes.at(-1), ': ping\n\n');
  req.emit('close'); req.removeAllListeners('close');
  assert.deepEqual(f.order.slice(-2), ['unwatch', 'clear-timer']);
  assert.deepEqual(f.queue, [{ id: 'manual-hold', hold: true }], 'reading must not execute or release a held queue');
});

test('chat stream retains CLI precedence and the model-specific partial reply separators', t => {
  const f = fixture(t);
  f.external({ busy: () => [{ project: 'p', task: 't', model: 'external', at: '2026-10-19T00:00:00Z' }] });
  for (const ai of ['claude', 'codex', 'agy', 'grok']) {
    f.run({ ai, model: 'selected', texts: ['one', 'two'], started: 10, last: 11 });
    f.open();
    assert.deepEqual(f.events().at(-1).busy, { ai, model: 'selected', text: ['agy', 'grok'].includes(ai) ? 'onetwo' : 'one\n\ntwo', started: 10, last: 11 });
  }
});

test('chat stream gets current external progress at each request and ignores other conversations', t => {
  const f = fixture(t);
  f.external({ busy: () => [{ project: 'other', task: 't', model: 'wrong' }, { project: 'p', task: 'other', model: 'wrong' },
    { project: 'p', task: 't', model: 'latest', at: '2026-10-19T01:02:03Z' }] });
  f.open();
  assert.deepEqual(f.events().at(-1).busy, { ai: 'chatgpt', model: 'latest', started: Date.parse('2026-10-19T01:02:03Z'), text: '', webchat: true });
  f.external({ busy: () => [] }); f.open();
  assert.equal(f.events().at(-1).busy, null);
});

test('chat stream decorates new task events with the current generation and the latest matching saved row', t => {
  const f = fixture(t); f.open(); f.generation(8);
  const first = { role: 'assistant', text: 'answer', at: 2, saved: 'old' }, last = { ...first, saved: 'latest' };
  f.rows([first, last]);
  const event = Object.freeze({ type: 'row', row: Object.freeze({ role: 'assistant', text: 'answer', at: 2 }) });
  f.emit(event);
  assert.deepEqual(f.events().at(-1), { type: 'row', row: { ...last, idea: 8 } });
  assert.equal(event.row.saved, undefined);
  f.emit({ type: 'rows', rows: [first] });
  assert.deepEqual(f.events().at(-1), { type: 'rows', rows: [{ ...first, idea: 8 }] });
  const unmatched = { type: 'row', row: { role: 'user', text: 'not yet saved', at: 3 } };
  f.emit(unmatched); assert.deepEqual(f.events().at(-1), unmatched);
  const system = { type: 'row', row: { role: 'system', text: 'notice' } };
  f.emit(system); assert.deepEqual(f.events().at(-1), system);
});

test('chat stream uses topic generations without task-only idea decorations for freetalk', t => {
  const f = fixture(t, { kind: 'freetalk' }); f.open();
  assert.equal(f.events()[0].generation, 9);
  assert.deepEqual(f.events()[0].rows, [{ role: 'user', text: 'hello', at: 1 }]);
  f.emit({ type: 'row', row: { role: 'assistant', text: 'topic answer', at: 2 } });
  assert.deepEqual(f.events().at(-1), { type: 'row', row: { role: 'assistant', text: 'topic answer', at: 2 } });
  assert.equal(f.order.includes('task-generation'), false);
  assert.equal(f.order.some(e => Array.isArray(e) && e[0] === 'decorate'), false);
});

test('chat stream preserves synchronous failures without opening headers after an unread-save failure', () => {
  const failure = Error('save rejected'), order = [];
  const route = create({ store: { readProject: () => ({}), taskFile: () => true }, setUnread: () => { order.push('read'); throw failure; } }).stream;
  assert.throws(() => route.handle({ method: 'GET' }, { writeHead: () => order.push('head') }, target), error => error === failure);
  assert.deepEqual(order, ['read']);
});

test('task stream delivers restored questions separately from collapsed summaries, and updates on answer events',t=>{
  const f=fixture(t),asks=[{question:'保存しますか？',options:['保存（おすすめ：下書きを保持）','待つ'],multi:false}];
  let pending={source:'saved-source',asks};f.pending(()=>pending);
  f.rows([{role:'event',summaryAuto:true,text:'要約'},{role:'assistant',asks,text:'説明'}]);f.open();
  const initial=f.events().at(-1);assert.deepEqual(initial.pendingQuestion,pending);assert.equal(initial.rows[1].questionsManaged,true);
  assert.equal(initial.rows[0].pendingQuestion,undefined,'the active card is outside the summary');
  pending=null;f.emit({type:'row',row:{role:'event',answeredQuestionSource:'saved-source',text:''}});
  assert.equal(f.events().at(-1).pendingQuestion,null);
});

test('question recovery failure keeps initial and watched messages visible with legacy inline questions',t=>{
  const f=fixture(t),asks=[{question:'保存しますか？',options:['保存','待つ'],multi:false}];
  f.pending(()=>{throw Error('fixture archive unavailable');});
  f.rows([{role:'assistant',asks,text:'説明',at:2}]);
  assert.doesNotThrow(()=>f.open());
  const initial=f.events().at(-1);
  assert.equal(Object.hasOwn(initial,'pendingQuestion'),false);
  assert.equal(Object.hasOwn(initial.rows[0],'questionsManaged'),false);
  assert.deepEqual(initial.rows[0].asks,asks);
  assert.doesNotThrow(()=>f.emit({type:'row',row:{role:'assistant',asks,text:'説明',at:2}}));
  const next=f.events().at(-1);
  assert.equal(Object.hasOwn(next,'pendingQuestion'),false);
  assert.equal(Object.hasOwn(next.row,'questionsManaged'),false);
  assert.deepEqual(next.row.asks,asks);
  assert.deepEqual(f.records,Array.from({length:2},()=>['question-display-read-error',{project:'p',task:'t'},{phase:'stream',error:'fixture archive unavailable'}]));
});
