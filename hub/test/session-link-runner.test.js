'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { SessionLinkRunner } = require('../lib/session-link-runner');
const SID = '11111111-2222-4333-8444-555555555555', WRONG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LINK = 'linked_source_01', REQ = 'request_number_01';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function wait(runner, expected) {
  for (let n = 0; n < 200; n++) { const state = runner.status(LINK); if (state.phase === expected && (expected === 'approval' || !state.busy)) return state; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(JSON.stringify(runner.status(LINK)));
}
function fixture(t, provider, options = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-session-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'native-session.jsonl'); fs.writeFileSync(file, 'original-session-history\n');
  const original = fs.readFileSync(file), frames = [], children = [], calls = [];
  const append = text => fs.appendFileSync(file, JSON.stringify({ sourceSessionId: SID, user: text, assistant: 'native answer' }) + '\n');
  const emit = (child, frame) => queueMicrotask(() => { if (!child.killed) child.stdout.write(JSON.stringify(frame) + '\n'); });
  const spawn = (command, argv, spec) => {
    calls.push({ command, argv, spec });
    const child = new EventEmitter(); children.push(child); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    child.kill = signal => { child.killed = true; child.signal = signal; queueMicrotask(() => { child.exitCode = 143; child.emit('close', 143); }); return true; };
    let rest = '', message;
    const answer = () => {
      if (options.noHistory) {} else append(message);
      if (provider === 'codex') {
        if (options.foreignTurn) {
          emit(child, { method: 'item/completed', params: { threadId: SID, turnId: 'older-turn', item: { id: 'foreign', type: 'agentMessage', text: 'foreign answer' } } });
          emit(child, { method: 'turn/completed', params: { threadId: SID, turn: { id: 'older-turn', status: 'failed' } } });
        }
        emit(child, { method: 'item/completed', params: { threadId: SID, turnId: 'turn1', item: { id: 'a1', type: 'agentMessage', text: 'native answer' } } });
        emit(child, { method: 'turn/completed', params: { threadId: SID, turn: { id: 'turn1', status: 'completed' } } });
      } else {
        emit(child, { type: 'assistant', session_id: SID, message: { id: 'a1', content: [{ type: 'thinking', thinking: 'not visible' }, { type: 'text', text: 'native answer' }] } });
        emit(child, { type: 'result', session_id: SID, is_error: false, result: 'native answer' });
      }
    };
    child.stdin = new Writable({
      write(data, _encoding, done) {
        rest += data.toString(); let end;
        while ((end = rest.indexOf('\n')) >= 0) {
          const frame = JSON.parse(rest.slice(0, end)); rest = rest.slice(end + 1); frames.push(frame);
          if (provider === 'codex') {
            if (frame.method === 'initialize') { if (options.signalExit) queueMicrotask(() => child.emit('close', null, 'SIGTERM')); else emit(child, { id: frame.id, result: {} }); }
            else if (frame.method === 'thread/read') emit(child, { id: frame.id, result: { thread: { id: options.wrong ? WRONG : SID, status: { type: options.active ? 'active' : 'idle' } } } });
            else if (frame.method === 'thread/resume') { if (options.changeAtResume) fs.appendFileSync(file, 'external update\n'); if (options.administrativeResume) fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }) + '\n'); emit(child, { id: frame.id, result: { thread: { id: SID } } }); }
            else if (frame.method === 'turn/start') {
              message = frame.params.input[0].text;
              if (!options.earlyFrames) emit(child, { id: frame.id, result: { turn: { id: 'turn1' } } });
              if (options.hang) {} else if (options.approval) setTimeout(() => emit(child, { id: 88, method: 'item/commandExecution/requestApproval', params: { threadId: SID, turnId: 'turn1', command: 'fixture tool' } }), 1); else answer();
              if (options.earlyFrames) emit(child, { id: frame.id, result: { turn: { id: 'turn1' } } });
            } else if (frame.method === 'turn/interrupt') emit(child, { id: frame.id, result: {} });
            else if (frame.id === 88 && frame.result) answer();
          } else {
            if (frame.type === 'control_request' && frame.request.subtype === 'initialize') { if (options.administrativeResume) fs.appendFileSync(file, JSON.stringify({ type: 'mode', sessionId: SID, mode: 'default' }) + '\n'); if (options.timestampOnly) fs.utimesSync(file, new Date(), new Date(Date.now() + 1000)); emit(child, { type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {} } }); }
            else if (frame.type === 'user') {
              message = frame.message.content; emit(child, { type: 'system', subtype: 'init', session_id: options.wrong ? WRONG : SID });
              if (options.wrong || options.hang) {} else if (options.background) {
                emit(child, { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'running', sdk_host_only: true });
                emit(child, { type: 'system', subtype: 'task_started', session_id: SID, task_id: 'native-agent-1', task_type: 'local_agent' });
                emit(child, { type: 'assistant', session_id: SID, message: { id: 'first-turn', content: [{ type: 'text', text: 'First native turn' }] } });
                emit(child, { type: 'result', session_id: SID, is_error: false, result: 'First native turn' });
                setTimeout(() => emit(child, { type: 'control_request', request_id: 'background-permission', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { path: 'fixture.md' } } }), 5);
              } else if (options.stateOnly) {
                emit(child, { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'running', sdk_host_only: true });
                emit(child, { type: 'system', subtype: 'task_started', session_id: SID, task_id: 'native-agent-1', task_type: 'local_workflow' });
                emit(child, { type: 'system', subtype: 'task_updated', session_id: SID, task_id: 'native-agent-1', patch: { status: 'killed' } });
                emit(child, { type: 'result', session_id: SID, is_error: false, result: 'Initial result' });
                setTimeout(() => { answer(); emit(child, { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'idle' }); }, 5);
              } else if (options.nonDeferring) {
                emit(child, { type: 'system', subtype: 'task_started', session_id: SID, task_id: 'shell-1', task_type: 'local_bash' }); answer();
              } else if (options.approval) emit(child, { type: 'control_request', request_id: 'tool1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { path: 'fixture.md' } } }); else answer();
            } else if (frame.type === 'control_response') {
              if (options.background) {
                emit(child, { type: 'system', subtype: 'task_updated', session_id: SID, task_id: 'native-agent-1', patch: { status: 'completed' } });
                answer(); emit(child, { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'idle', sdk_host_only: true });
              } else answer();
            }
            else if (frame.type === 'control_request' && frame.request.subtype === 'interrupt') emit(child, { type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {} } });
          }
        }
        done();
      },
      final(done) { done(); setTimeout(() => { if (!child.killed) { child.exitCode = 0; child.emit('close', 0); } }, 1); },
    });
    return child;
  };
  let refs = 0;
  const ref = async () => { refs++; return { provider, sourceSessionId: SID, cwd: dir, file, roots: { codexHome: dir, claudeConfigDir: dir } }; };
  const history = async () => ({ signature: hash(file), broken: false });
  const base = { referenceFor: ref, history, guard: async () => true, spawn, receiptsFile: path.join(dir, 'receipts.json'), rpcTimeout: 500, timeout: 2000, ...options.runner };
  const runner = new SessionLinkRunner(base);
  return { dir, file, original, frames, children, calls, runner, base, history, refs: () => refs };
}
for (const provider of ['codex', 'claude']) test(provider + ' resumes the exact native session and verifies updates in the original file without copying history', async t => {
  const f = fixture(t, provider);
  await f.runner.send({ id: LINK, text: 'new user message', requestId: REQ });
  const state = await wait(f.runner, 'completed');
  assert.equal(state.verifiedSession, true); assert.equal(state.historyUpdated, true); assert.equal(state.text, 'native answer');
  assert.ok(fs.readFileSync(f.file).subarray(0, f.original.length).equals(f.original));
  assert.ok(fs.readFileSync(f.file, 'utf8').includes(SID));
  assert.equal(fs.existsSync(path.join(f.dir, 'Product')), false); assert.equal(fs.existsSync(path.join(f.dir, '.ai')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'receipts.json'), 'utf8').includes('new user message'), false);
  const argv = f.calls[0].argv.join(' '); assert.equal(/dangerously|fork|ephemeral|ignore-user/.test(argv), false);
  if (provider === 'codex') {
    const methods = f.frames.map(x => x.method).filter(Boolean); assert.ok(methods.includes('thread/resume')); assert.equal(methods.includes('thread/start'), false); assert.equal(methods.includes('thread/fork'), false);
    assert.equal(f.frames.find(x => x.method === 'turn/start').params.threadId, SID);
  } else { assert.ok(argv.includes('--resume=' + SID)); assert.equal(f.frames.find(x => x.type === 'user').session_id, SID); }
});
for (const provider of ['codex', 'claude']) test(provider + ' rejects another session ID instead of creating a replacement', async t => {
  const f = fixture(t, provider, { wrong: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const state = await wait(f.runner, 'failed'); assert.equal(state.code, 'mismatch');
  assert.deepEqual(fs.readFileSync(f.file), f.original); assert.equal(f.frames.some(x => x.method === 'thread/start'), false);
  if (provider === 'codex') assert.equal(f.frames.some(x => x.method === 'turn/start'), false);
});
test('missing source, changed source, active native thread and Storage Guard failures send no model turn', async t => {
  for (const kind of ['missing', 'changed', 'active', 'guard']) {
    const f = fixture(t, 'codex', { changeAtResume: kind === 'changed', active: kind === 'active' });
    if (kind === 'missing') fs.unlinkSync(f.file);
    if (kind === 'guard') f.runner.guard = async () => false;
    try { await f.runner.send({ id: LINK, text: 'message', requestId: REQ }); } catch {}
    await wait(f.runner, 'failed'); assert.equal(f.frames.some(x => x.method === 'turn/start'), false, kind);
  }
});
for (const provider of ['codex', 'claude']) test(provider + ' waits for a person to answer a native approval, without persisting permission changes', async t => {
  const f = fixture(t, provider, { approval: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const pending = await wait(f.runner, 'approval'); assert.equal(pending.approvals.length, 1);
  assert.equal(f.frames.some(x => x.id === 88 && x.result), false);
  f.runner.answer({ id: LINK, approvalId: pending.approvals[0].id, allow: false });
  await wait(f.runner, 'completed');
  if (provider === 'codex') assert.deepEqual(f.frames.find(x => x.id === 88 && x.result).result, { decision: 'decline' });
  else assert.equal(f.frames.find(x => x.type === 'control_response').response.response.behavior, 'deny');
  assert.throws(() => f.runner.answer({ id: LINK, approvalId: pending.approvals[0].id, allow: true }), e => e.code === 'input');
});
test('request IDs deduplicate after success and across a restart; no retry silently re-sends a prompt', async t => {
  const f = fixture(t, 'codex'); const args = { id: LINK, text: 'message', requestId: REQ };
  await f.runner.send(args); await f.runner.send(args); await wait(f.runner, 'completed'); assert.equal(f.calls.length, 1);
  const restarted = new SessionLinkRunner(f.base), state = await restarted.send(args);
  assert.equal(state.duplicate, true); assert.equal(f.calls.length, 1);
});
test('explicit stop affects only this runner child and retains unknown delivery on restart', async t => {
  const f = fixture(t, 'codex', { hang: true }); const args = { id: LINK, text: 'message', requestId: REQ };
  await f.runner.send(args); await new Promise(r => setTimeout(r, 10));
  await assert.rejects(f.runner.send({ ...args, requestId: 'request_number_02' }), e => e.code === 'busy');
  await f.runner.stop(LINK); await wait(f.runner, 'stopped'); assert.equal(f.children[0].signal, 'SIGTERM');
  const restarted = new SessionLinkRunner(f.base); await assert.rejects(restarted.send(args), e => e.code === 'unknown');
});
test('provider success without an original-history update remains unverified', async t => {
  const f = fixture(t, 'codex', { noHistory: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const result = await wait(f.runner, 'failed'); assert.equal(result.code, 'unverified'); assert.equal(result.historyUpdated, false);
});
test('invalid inputs and unknown confirmations cannot invoke any provider', async t => {
  const f = fixture(t, 'claude');
  for (const input of [{ id: '../outside', text: 'x', requestId: REQ }, { id: LINK, text: '', requestId: REQ }, { id: LINK, text: 'x', requestId: '' }]) await assert.rejects(f.runner.send(input), e => e.code === 'input');
  assert.equal(f.calls.length, 0);
});
test('Codex accepts early own-turn notifications and ignores a different turn in the same thread', async t => {
  const f = fixture(t, 'codex', { earlyFrames: true, foreignTurn: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const state = await wait(f.runner, 'completed');
  assert.equal(state.text, 'native answer'); assert.equal(state.historyUpdated, true);
});
test('receipt loading rejects oversized, malformed, duplicate and symlinked journals without spawning', t => {
  const f = fixture(t, 'codex'), journal = f.base.receiptsFile;
  const row = { requestId: REQ, linkId: LINK, sourceSessionId: SID, provider: 'codex', phase: 'completed', at: new Date().toISOString() };
  const invalid = ['x'.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ rows: [] }), JSON.stringify([row, row]), JSON.stringify([{ ...row, phase: 'sent' }]), JSON.stringify([{ ...row, sourceSessionId: '../outside' }])];
  for (const content of invalid) { fs.writeFileSync(journal, content); assert.throws(() => new SessionLinkRunner(f.base)); }
  fs.unlinkSync(journal); fs.symlinkSync(f.file, journal);
  assert.throws(() => new SessionLinkRunner(f.base), e => e.code === 'source');
  assert.equal(f.calls.length, 0);
});
for (const provider of ['codex', 'claude']) test(provider + ' allows native resume bookkeeping but does not count it as a delivered turn', async t => {
  const f = fixture(t, provider, { administrativeResume: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  assert.equal((await wait(f.runner, 'completed')).historyUpdated, true);
  const g = fixture(t, provider, { administrativeResume: true, noHistory: true });
  await g.runner.send({ id: LINK, text: 'message', requestId: REQ });
  assert.equal((await wait(g.runner, 'failed')).code, 'unverified');
});

test('Claude keeps stdin open after the first result for native background permissions and its follow-up turn', async t => {
  const f = fixture(t, 'claude', { background: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const pending = await wait(f.runner, 'approval');
  assert.equal(f.children[0].stdin.writableEnded, false); assert.equal(pending.busy, true);
  assert.equal(pending.phase, 'approval'); assert.equal(pending.approvals[0].detail.tool, 'Read');
  f.runner.answer({ id: LINK, approvalId: pending.approvals[0].id, allow: false });
  const state = await wait(f.runner, 'completed'); assert.equal(state.historyUpdated, true);
  assert.ok(state.text.includes('First native turn')); assert.ok(state.text.includes('native answer'));
  assert.equal(f.frames.filter(frame => frame.type === 'user').length, 1);
});
test('Claude waits for idle after task completion before result when the native parent still owes a continuation', async t => {
  const f = fixture(t, 'claude', { stateOnly: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  await wait(f.runner, 'completed'); assert.equal(f.children[0].stdin.writableEnded, true);
  assert.ok(f.runner.status(LINK).text.includes('native answer'));
});
test('Claude background shells are not treated as deferring agent work', async t => {
  const f = fixture(t, 'claude', { nonDeferring: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  await wait(f.runner, 'completed'); assert.equal(f.children[0].stdin.writableEnded, true);
});
test('Claude native timestamp-only initialization keeps the exact unchanged source prefix', async t => {
  const f = fixture(t, 'claude', { timestampOnly: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  await wait(f.runner, 'completed'); assert.ok(fs.readFileSync(f.file).subarray(0, f.original.length).equals(f.original));
});
test('a concurrent conversation append while resume bookkeeping is checked cannot become the new baseline', async t => {
  const f = fixture(t, 'codex', { administrativeResume: true }), read = fs.readSync;
  const size = f.original.length; let injected = false;
  fs.readSync = function(fd, buffer, offset, length, position) {
    const result = read.call(this, fd, buffer, offset, length, position);
    if (!injected && position === size && length > 0) { injected = true; fs.appendFileSync(f.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }) + '\n'); }
    return result;
  };
  t.after(() => { fs.readSync = read; });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  assert.equal((await wait(f.runner, 'failed')).code, 'source'); assert.equal(injected, true);
  assert.equal(f.frames.some(x => x.method === 'turn/start'), false);
});
test('stop during the initial asynchronous check prevents even a native child from starting', async t => {
  let release;
  const f = fixture(t, 'codex', { runner: { guard: () => new Promise(resolve => { release = resolve; }) } });
  const sending = f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  await f.runner.stop(LINK); release(true);
  await assert.rejects(sending, e => e.code === 'stopped');
  assert.equal(f.calls.length, 0); assert.equal(f.runner.busy(), false);
  assert.deepEqual(fs.readFileSync(f.file), f.original);
});
test('stop while the final native pre-send guard waits cannot send a model turn afterwards', async t => {
  let release, count = 0;
  const f = fixture(t, 'codex', { runner: { guard: () => ++count === 3 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true) } });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  for (let n = 0; n < 100 && !release; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(typeof release, 'function'); await f.runner.stop(LINK); release(true);
  await wait(f.runner, 'stopped'); await new Promise(r => setTimeout(r, 10));
  assert.equal(f.frames.some(x => x.method === 'turn/start'), false);
  assert.equal(f.calls.length, 1); assert.equal(f.children[0].killed, true);
});
test('an already closed native process leaves failed status available without keeping Hub permanently busy', async t => {
  const f = fixture(t, 'codex', { signalExit: true });
  await f.runner.send({ id: LINK, text: 'message', requestId: REQ });
  const result = await wait(f.runner, 'failed');
  assert.equal(result.busy, false); assert.equal(f.runner.busy(), false);
  assert.equal(f.children[0].killed, false); assert.equal(f.frames.some(x => x.method === 'turn/start'), false);
});
