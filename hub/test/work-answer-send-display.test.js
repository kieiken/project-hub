'use strict';
// Adapt the attachment's seven memory-only checks to installed source paths
// and the offline launcher; exercise the real send handler as well.
// Shared classic scripts run through the same harness on Mac and Windows.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { app, snapshot } = require('./fixtures/app-ui-harness.cjs');
const run = (a, code) => vm.runInContext(code, a.context);

function fixture(userAgent = '') {
  const a = app(userAgent), data = snapshot('返事待ち'), p = data.projects[0], t = p.tasks[0];
  t.question = '続けますか？';
  a.context.fixture = data;
  run(a, 'state=fixture;view={kind:"work",project:"p",task:"t"}');
  let lower;
  a.context.bindAskAnswers = (_box, send) => { lower = send; };
  a.element('#chat-ai').value = 'codex|gpt-6.1-sol';
  a.element('#chat-effort').value = '高';
  a.context.load = async () => {};
  const notices = [], requests = [];
  a.context.toast = message => notices.push(message);
  a.context.openChat(p, t);
  a.element('#msgs').insertAdjacentHTML = (_where, html) => {
    if (html.includes('id="msg-partial"')) a.elements.set('#msg-partial', {
      querySelector: selector => a.element('partial' + selector),
      remove() { a.elements.delete('#msg-partial'); },
    });
  };
  a.context.syncWorkQuestion();
  const slot = a.element('#work-question');
  let writes = 0, html = slot.innerHTML;
  Object.defineProperty(slot, 'innerHTML', { get: () => html, set: value => { html = value; writes++; } });
  a.context.api = (route, body) => route === '/api/chat/send'
    ? new Promise((resolve, reject) => requests.push({ route, body, resolve, reject }))
    : Promise.resolve({}); // Read-only Muse status on opening another view.
  const send = text => run(a, 'sendWorkAnswer').send(text);
  return { ...a, data, p, t, slot, notices, requests, send, lower: text => lower(text), writes: () => writes,
    emit: event => a.stream().onmessage({ data: JSON.stringify(event) }) };
}
const content = a => a.element('#work-question [data-work-answer-content]');
const pending = a => a.element('#work-question [data-work-answer-pending]');
const kind = a => run(a, 'notificationKind(state.projects[0],state.projects[0].tasks[0])');

test('all four integrated browser scripts parse without transforming the installed files', () => {
  for (const name of ['app.js', 'app-work.js', 'app-chat.js', 'app-tree.js'])
    new vm.Script(fs.readFileSync(path.join(__dirname, '../public', name), 'utf8'), { filename: name });
});

for (const agent of ['Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 14_0']) {
  test(agent + ': sending is display-only; rejection restores the same question and input nodes', async () => {
    const a = fixture(agent), before = JSON.stringify(a.t);
    const input = a.element('#ask-form input'); input.value = '上部の回答';
    const sent = a.send('回答');
    assert.equal(a.requests.length, 1); assert.equal(a.requests[0].route, '/api/chat/send');
    assert.equal(a.requests[0].body.answerQuestion, a.t.question);
    assert.equal(JSON.stringify(a.t), before);
    assert.equal(kind(a), 'work'); assert.equal(content(a).hidden, true); assert.equal(pending(a).hidden, false);
    assert.equal(a.element('.whead .pill').textContent, '送信中');
    assert.equal(a.element('#turn-n').textContent, '送信中 1・返事待ち 0');
    assert.equal(a.element('#turn-work-n').textContent, '作業中 0');
    assert.match(a.element('#turn').attributes['aria-label'], /送信中 1件/);
    assert.equal(await a.lower('二重送信'), false); assert.equal(a.requests.length, 1);
    a.requests[0].reject(Error('接続失敗')); assert.equal(await sent, false);
    assert.equal(JSON.stringify(a.t), before); assert.equal(a.writes(), 0);
    assert.equal(content(a).hidden, false); assert.equal(pending(a).hidden, true);
    assert.equal(a.element('#ask-form input'), input); assert.equal(input.value, '上部の回答');
    assert.equal(kind(a), 'reply'); assert.equal(a.element('#turn-n').textContent, '返事待ち 1');
    assert.equal(run(a, 'workAnswerSends.size+chatSending.size'), 0);
  });
}

test('composer rejection keeps the sent draft and any text typed during the request', async () => {
  const a = fixture();
  a.element('#chat-in').value = '最初の回答';
  run(a, 'setChatDraft(chatAttachmentKey("p","t"),"最初の回答")');
  a.element('#composer').handlers.submit({ preventDefault() {} });
  assert.equal(a.element('#chat-in').value, '');
  a.element('#chat-in').value = '新しい下書き';
  run(a, 'setChatDraft(chatAttachmentKey("p","t"),"新しい下書き")');
  a.requests[0].reject(Error('接続失敗'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.element('#chat-in').value, '最初の回答\n\n新しい下書き');
  assert.equal(run(a, 'chatDraft[chatAttachmentKey("p","t")]'), '最初の回答\n\n新しい下書き');
  assert.equal(a.t.question, '続けますか？'); assert.equal(a.t.state, '返事待ち');
  assert.equal(content(a).hidden, false); assert.equal(a.writes(), 0);
});

test('accepted queued answer unlocks controls before a slow refresh and preserves queued notice', async () => {
  const a = fixture(); let finishRefresh;
  a.context.load = () => new Promise(resolve => { finishRefresh = resolve; });
  const sent = a.send('回答');
  a.requests[0].resolve({ queued: true, queue: 1, answeredQuestion: a.t.question });
  assert.equal(await sent, true, a.notices.join(' / '));
  assert.equal(a.t.question, ''); assert.equal(a.t.state, '実行中');
  assert.equal(a.element('#chat-send').disabled, false);
  assert.equal(run(a, 'workAnswerSends.size+chatSending.size'), 0);
  assert.match(a.slot.innerHTML, /回答を受け付けました/);
  finishRefresh();
});

test('refresh failure after acceptance reports the display error without restoring the accepted draft', async () => {
  const a = fixture(); a.context.load = async () => { throw Error('一覧失敗'); };
  const sent = a.send('回答'); a.requests[0].resolve({ answeredQuestion: a.t.question });
  assert.equal(await sent, true, a.notices.join(' / ')); assert.equal(a.t.question, '');
  assert.ok(a.notices.some(message => /表示の再取得に失敗/.test(message)));
  assert.equal(a.element('#chat-send').disabled, false);
});

for (const attention of ['new question', 'blocked queue', 'limit']) test(attention + ' remains visible during the old request', async () => {
  const a = fixture(), old = a.t.question, sent = a.send('回答');
  if (attention === 'new question') a.t.question = '別の質問';
  if (attention === 'blocked queue') a.t.chatQueueBlocked = true;
  if (attention === 'limit') a.t.state = '上限で停止';
  a.context.refreshWorkAnswerSend();
  assert.equal(kind(a), 'reply'); assert.equal(content(a).hidden, false); assert.equal(pending(a).hidden, true);
  assert.equal(a.element('#turn-n').textContent, '返事待ち 1');
  assert.notEqual(a.element('.whead .pill').textContent, '送信中');
  // A new question cannot be erased by the acceptance of an older answer.
  if (attention === 'new question') {
    a.requests[0].resolve({ answeredQuestion: old }); assert.equal(await sent, true, a.notices.join(' / '));
    assert.equal(a.t.question, '別の質問'); assert.equal(a.t.state, '返事待ち');
  } else { a.requests[0].reject(Error('停止')); await sent; }
});

test('fresh assistant row invalidates the old display even when the question text is repeated', async () => {
  const a = fixture(), sent = a.send('回答');
  a.emit({ type: 'row', row: { role: 'assistant', text: '次の質問', at: '2026-11-04T00:00:00Z' } });
  assert.equal(kind(a), 'reply'); assert.equal(content(a).hidden, false);
  assert.equal(run(a, 'workAnswerSends.size'), 0);
  a.requests[0].reject(Error('未受付')); await sent;
});

test('two task sends are independent and finishing the old view preserves the current task request', async () => {
  const a = fixture(), first = a.send('一つ目');
  const other = { ...a.t, id: 'other', question: '別作業の質問' }; a.p.tasks.push(other);
  assert.equal(run(a, 'notificationKind(state.projects[0],state.projects[0].tasks[1])'), 'reply');
  a.context.other = other;
  run(a, 'view.task="other";openChat(state.projects[0],other);syncWorkQuestion()');
  const second = run(a, 'sendWorkAnswer.send("二つ目")');
  assert.equal(a.requests.length, 2); assert.equal(run(a, 'workAnswerSends.size'), 2);
  assert.equal(a.element('#turn-n').textContent, '送信中 2・返事待ち 0');
  a.requests[0].reject(Error('一つ目は失敗')); assert.equal(await first, false);
  assert.equal(run(a, 'workAnswerSending(state.projects[0],other)'), true);
  assert.equal(a.element('.whead .pill').textContent, '送信中');
  a.requests[1].resolve({ queued: true, queue: 1, answeredQuestion: other.question });
  assert.equal(await second, true); assert.equal(other.question, ''); assert.equal(a.t.question, '続けますか？');
  assert.equal(run(a, 'workAnswerSends.size+chatSending.size'), 0);
});

for (const queued of [false, true]) for (const repeated of [false, true]) {
  test('late acceptance preserves a fresh question: ' + (repeated ? 'same text' : 'different text') + (queued ? ', queued' : ', immediate'), async () => {
    const a = fixture(), old = a.t.question, sent = a.send('回答');
    a.context.load = async () => { throw Error('offline refresh'); };
    a.t.question = repeated ? old : '別の新しい質問';
    a.emit({ type: 'row', row: { role: 'assistant', text: '次の確認', at: '2026-11-04T01:00:00Z' } });
    a.context.syncWorkQuestion();
    assert.equal(run(a, 'workAnswerSends.size'), 0);
    const next = a.t.question;
    a.requests[0].resolve({ answeredQuestion: old, queued, queue: queued ? 1 : undefined });
    assert.equal(await sent, true);
    assert.equal(a.t.question, next); assert.equal(a.t.state, '返事待ち');
    assert.equal(kind(a), 'reply'); assert.equal(content(a).hidden, false);
    assert.equal(a.element('#turn-n').textContent, '返事待ち 1');
    assert.equal(a.element('#chat-send').disabled, false);
    assert.doesNotMatch(a.slot.innerHTML, /回答を受け付けました/);
    assert.equal(run(a, 'workAnswerSends.size+chatSending.size'), 0);
  });
}

test('late acceptance from the old view preserves its repeated new question and the other task send', async () => {
  const a = fixture(), old = a.t.question, first = a.send('一つ目');
  a.emit({ type: 'row', row: { role: 'assistant', text: '次の確認', at: '2026-11-04T01:00:00Z' } });
  const other = { ...a.t, id: 'other', question: '別作業の質問' }; a.p.tasks.push(other);
  a.context.other = other;
  run(a, 'view.task="other";openChat(state.projects[0],other);syncWorkQuestion()');
  const second = run(a, 'sendWorkAnswer.send("二つ目")');
  a.requests[0].resolve({ queued: true, queue: 1, answeredQuestion: old });
  assert.equal(await first, true); assert.equal(a.t.question, old); assert.equal(a.t.state, '返事待ち');
  assert.equal(run(a, 'workAnswerSending(state.projects[0],other)'), true);
  assert.equal(a.element('.whead .pill').textContent, '送信中');
  a.requests[1].resolve({ queued: true, queue: 1, answeredQuestion: other.question });
  assert.equal(await second, true); assert.equal(other.question, '');
});
