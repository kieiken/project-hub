'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const chat = require('../lib/chat');
const LIMIT = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fable-switch-'));
const root = path.join(tmp, 'workspace'), dir = path.join(root, 'Product', 'Switch fixture'), bin = path.join(tmp, 'bin');
let server, base, count = 0;
const rolesFile = path.join(root, '_hub/roles.yaml');
function config(auto = true, backup = 'GPT-6-Astra') {
  fs.writeFileSync(rolesFile, `models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6-Astra, GPT-6.1-Sol]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 極高], backup: [codex, ${backup}, 極高] }\n  チェック: { main: [claude-code, Fable 5.1, 極高], backup: [codex, ${backup}, 極高] }\n  文章: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\nswitch:\n  auto: ${auto}\n`);
  const stamp = new Date(Date.now() + ++count * 10); fs.utimesSync(rolesFile, stamp, stamp);
}
function task(role = '司令塔', cwd = '') {
  const id = 'case-' + ++count;
  fs.writeFileSync(path.join(dir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: Existing fixture\nrole: ${role}\nowner: claude-code\nmodel: Fable 5.1\nworkspaceMode: direct\nworkdir: ${cwd}\nstate: 実行中\n---\n## 手順\n- [ ] fixture review\n`);
  return id;
}
const rows = id => chat.read(dir, id);
const replies = id => rows(id).filter(r => r.role === 'assistant');
const queue = id => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.ai/chat', id + '.queue.json'))); } catch { return []; } };
const post = (route, id, body) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ project: 'Switch fixture', task: id, ...body }) });
const wait = async pred => { for (let i = 0; i < 250; i++) { if (pred()) return; await new Promise(r => setTimeout(r, 20)); } assert.ok(pred(), 'fixture completed'); };
const clearLimit = async () => { if (base) assert.equal((await post('/api/limits/fable/clear', null, {})).status, 200); try { fs.unlinkSync(path.join(root, '_hub/fable-limit.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
test.beforeEach(clearLimit);
const send = async (id, scenario, extra = {}) => { await clearLimit(); const r = await post('/api/chat/send', id, { ai: 'claude', model: 'claude-fable-5-1', text: 'scenario=' + scenario, ...extra }); assert.equal(r.status, 200, await r.text()); };
const captured = row => JSON.parse(row.text);
const policy = input => input.split('以下は、この作業の会話')[0].split('# 今回の依頼')[0];
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Switch fixture\nstatus: 進行中\nfolders: {}\nrelated: []\nphases: []\n---\n'); config();
  fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ codex: { models: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }
  ] } }));
  for (const ai of ['claude', 'codex']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),ai=${JSON.stringify(ai)},limit=${JSON.stringify(LIMIT)},tmp=${JSON.stringify(tmp)};let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',async ()=>{
 const current=input.slice(input.lastIndexOf('# 今回の依頼')), scenario=(current.match(/scenario=([\\w-]+)/)||[])[1]||'ok',out=o=>console.log(JSON.stringify(o));
 const info=JSON.stringify({ai,args:process.argv.slice(2),cwd:process.cwd(),input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)')});
 if(ai==='codex'){out({type:'thread.started',thread_id:'switch-codex'});out({type:'item.completed',item:{type:'agent_message',text:info}});out({type:'turn.completed'});return;}
 out({type:'system',session_id:'switch-claude'});
 if(['ok','quote'].includes(scenario)){out({type:'assistant',message:{content:[{type:'text',text:scenario==='quote'?limit:info}]}});out({type:'result',is_error:false,result:''});return;}
 if(['auth','network','model','temporary','synthetic-auth'].includes(scenario)){
  const msg={auth:'authentication failed',network:'network failed',model:'unknown model',temporary:'Too many requests', 'synthetic-auth':'authentication failed'}[scenario];
  out({type:'assistant',error:scenario==='temporary'?'rate_limit':'auth_error',isApiErrorMessage:true,message:{model:'<synthetic>',content:[{type:'text',text:msg}]}});out({type:'result',is_error:true,result:msg});return;
 }
 if(scenario==='tool'){fs.appendFileSync(path.join(tmp,'side-effect'),'once\\n');out({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:'fixture-only'}}]}});}
 if(scenario==='delegate-then-limit'){
  const task=(current.match(/fixtureTask=([\\w-]+)/)||[])[1];
  const response=await fetch('http://127.0.0.1:'+process.env.HUB_PORT+'/api/delegate',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify({project:'Switch fixture',task,ai:'codex',model:'gpt-6.1-sol',title:'OUTGOING_IMPLEMENTATION',text:'scenario=ok outgoing-only'})});
  if(!response.ok)throw Error(await response.text());
  out({type:'assistant',message:{content:[{type:'tool_use',name:'delegate',input:{result:await response.json()}}]}});
 }
 if(scenario==='missing')fs.rmdirSync(process.cwd());
 if(scenario!=='result-only')out({type:'assistant',error:'rate_limit',isApiErrorMessage:true,message:{model:'<synthetic>',content:[{type:'text',text:limit}]}});
 if(scenario!=='assistant-only')out({type:'result',is_error:true,result:limit});
 if(scenario==='hold'){const timer=setInterval(()=>{if(fs.existsSync(path.join(tmp,'release'))){clearInterval(timer);process.exit(1);}},20);}else process.exitCode=1;
});process.on('SIGTERM',()=>process.exit(143));
`, { mode: 0o755 });
  Object.assign(process.env, { PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home'), HUB_TRASH: path.join(tmp, 'trash') });
  ({ server } = require('../server')); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  await new Promise(r => server.close(r)); process.env.HUB_PORT = String(port); delete require.cache[require.resolve('../server')];
  ({ server } = require('../server')); await new Promise(r => server.listen(port, '127.0.0.1', r)); base = 'http://127.0.0.1:' + port;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });

test('CLI構造と正式文を両方検査し、本文引用・混雑・他エラーを上限にしない', () => {
  const limitEvents = o => chat.parse('claude', o).filter(e => e.kind === 'limit');
  assert.equal(limitEvents({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: LIMIT }] } }).length, 1);
  assert.equal(limitEvents({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] } }).length, 1);
  assert.equal(limitEvents({ type: 'result', is_error: true, result: LIMIT }).length, 1);
  for (const o of [{ type: 'assistant', message: { content: [{ type: 'text', text: LIMIT }] } }, { type: 'result', is_error: false, result: LIMIT },
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Too many requests' }] } },
    { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'authentication failed' }] } },
    { type: 'result', is_error: true, result: 'network failed; quoted: ' + LIMIT }]) assert.equal(limitEvents(o).length, 0);
});

test('正式上限はcloseを待ち、後続2件の前にAstraを保存し元依頼/引数を引き継ぐ', async () => {
  config(); const id = task(), beforeTasks = fs.readdirSync(path.join(dir, '.ai/tasks')); await send(id, 'hold');
  await wait(() => rows(id).some(r => r.role === 'user'));
  for (const text of ['next-one', 'next-two']) assert.equal((await post('/api/chat/send', id, { ai: 'codex', model: 'gpt-6.1-sol', mode: 'queue', text })).status, 200);
  await new Promise(r => setTimeout(r, 150)); assert.equal(replies(id).length, 0); assert.equal(queue(id).length, 2);
  let saved;
  const original = chat.ChatRunner.prototype.setQueue;
  chat.ChatRunner.prototype.setQueue = function(p, t, q, strict) { const result = original.call(this, p, t, q, strict); if (strict && t === id) saved = queue(id); return result; };
  try { fs.writeFileSync(path.join(tmp, 'release'), 'go'); await wait(() => replies(id).length === 4 && queue(id).length === 0); }
  finally { chat.ChatRunner.prototype.setQueue = original; }
  assert.deepEqual(saved.map(x => x.model), ['GPT-6-Astra', 'GPT-6.1-Sol', 'GPT-6.1-Sol']);
  const restored = new chat.ChatRunner({ dirOf: () => dir }); restored.queues.clear();
  // 実行直前に保存されていたJSONは別Runnerでも読める。
  fs.writeFileSync(path.join(dir, '.ai/chat', 'saved.queue.json'), JSON.stringify(saved)); assert.deepEqual(restored.queue('Switch fixture', 'saved'), saved);
  assert.equal(saved[0].limitSwitch.from, 'Fable 5.1'); assert.equal(saved[0].requiredModel, 'gpt-6-astra');
  const got = captured(replies(id)[1]); assert.equal(got.args[got.args.indexOf('--model') + 1], 'gpt-6-astra'); assert.ok(got.args.includes('model_reasoning_effort=xhigh'));
  assert.match(got.input, /元の依頼：\nscenario=hold/); assert.match(got.input, /すでに済んだ部分.*は繰り返さず、残り/); assert.match(got.input, /【この番の起動】[^\n]*自動の引き継ぎ/);
  assert.match(policy(got.input), /【利用上限の時】/); assert.match(policy(got.input), /司令塔＝Claude Code・Fable 5.1/);
  assert.deepEqual(replies(id).map(r => r.model), ['Fable 5.1', 'GPT-6-Astra', 'GPT-6.1-Sol', 'GPT-6.1-Sol']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ai/tasks')), beforeTasks);
});

test('assistantだけ/resultだけの正式上限にも交代しtool済みの残りを指示する', async () => {
  config(); for (const scenario of ['assistant-only', 'result-only', 'tool']) {
    const id = task('チェック'); await send(id, scenario); await wait(() => replies(id).length === 2);
    assert.equal(replies(id)[1].model, 'GPT-6-Astra'); assert.match(captured(replies(id)[1]).input, /済んだ部分.*繰り返さず/);
  }
  assert.equal(fs.readFileSync(path.join(tmp, 'side-effect'), 'utf8'), 'once\n');
});

test('本文引用/認証/通信/モデル拒否/一時混雑/対象外モデル・役割は交代しない', async () => {
  config(); for (const scenario of ['quote', 'auth', 'network', 'model', 'temporary', 'synthetic-auth']) {
    const id = task(); await send(id, scenario); await wait(() => replies(id).length === 1); assert.equal(queue(id).length, 0); assert.equal(rows(id).some(r => r.limitSwitch), false); assert.equal(fs.existsSync(path.join(root, '_hub/fable-limit.json')), false);
  }
  for (const [role, model] of [['文章', 'claude-fable-5-1'], ['司令塔', 'claude-opus-5-5']]) { const id = task(role); await send(id, 'result-only', { model }); await wait(() => replies(id).length === 1); assert.equal(queue(id).length, 0); }
});

test('autoオフやAstra以外のbackupは尊重しmain・他役割を変更しない', async () => {
  for (const [auto, backup] of [[false, 'GPT-6-Astra'], [true, 'GPT-6.1-Sol']]) {
    config(auto, backup); const before = fs.readFileSync(rolesFile); const id = task(); await send(id, 'result-only'); await wait(() => replies(id).length === 1);
    assert.equal(queue(id).length, 0); assert.deepEqual(fs.readFileSync(rolesFile), before);
  } config();
});

test('人の停止は交代せず待ち順を消す（上限出力後でも）', async () => {
  config(); const id = task(); fs.unlinkSync(path.join(tmp, 'release')); await send(id, 'hold');
  assert.equal((await post('/api/chat/send', id, { ai: 'codex', model: 'gpt-6.1-sol', text: 'never', mode: 'queue' })).status, 200);
  await new Promise(r => setTimeout(r, 100)); await post('/api/chat/stop', id, {}); await wait(() => replies(id).length === 1 && queue(id).length === 0);
  assert.equal(replies(id)[0].error, '止めました'); assert.equal(rows(id).some(r => r.limitSwitch), false);
});

test('委任の明示Fableにも適用し、継続/キュー/terminalへ例外文を渡す', async () => {
  config(); const id = task('文章');
  const delegated = await post('/api/delegate', id, { ai: 'claude', model: 'claude-fable-5-1', text: 'scenario=result-only', title: 'fixture check' }); assert.equal(delegated.status, 200);
  await wait(() => replies(id).length === 2); assert.match(captured(replies(id)[1]).input, /fixture check/);
  await send(id, 'ok', { model: 'claude-opus-5-5' }); await wait(() => replies(id).length === 3); const resumed = captured(replies(id)[2]);
  assert.ok(resumed.args.includes('--resume')); assert.match(policy(resumed.input), /【利用上限の時】/);
  const terminal = await post('/api/term/start', id, { ai: 'claude' }); assert.equal(terminal.status, 200);
  const prompt = (await terminal.json()).args.join('\n'); assert.match(prompt, /ターミナルでは自動の引き継ぎは無い/); assert.match(prompt, /【利用上限の時】/);
});

test('消えた前のcwdを安全な現在の作業場所に更新する', async () => {
  config(); const cwd = path.join(tmp, 'vanishing'); fs.mkdirSync(cwd); const id = task('チェック', cwd);
  await send(id, 'missing'); await wait(() => replies(id).length === 2);
  assert.equal(fs.realpathSync(captured(replies(id)[1]).cwd), fs.realpathSync(dir)); assert.equal(fs.existsSync(cwd), false);
});

test('Astra起動失敗では引き継ぎと後続を失わず、再開時の印も保つ', async () => {
  config(); const id = task(); await send(id, 'hold'); await post('/api/chat/send', id, { ai: 'codex', model: 'gpt-6.1-sol', text: 'later', mode: 'queue' });
  fs.renameSync(path.join(bin, 'codex'), path.join(bin, 'codex.disabled')); fs.writeFileSync(path.join(tmp, 'release'), 'go');
  try { await wait(() => queue(id).length === 2 && queue(id)[0].error); assert.equal(queue(id)[0].model, 'GPT-6-Astra'); assert.equal(queue(id)[1].text, 'later'); }
  finally { fs.renameSync(path.join(bin, 'codex.disabled'), path.join(bin, 'codex')); }
  const queued = queue(id)[0]; assert.equal((await post('/api/chat/send', id, { fromQueue: queued.id })).status, 200);
  await wait(() => queue(id).length === 0 && replies(id).length === 4);
  assert.match(captured(replies(id)[2]).input, /自動の引き継ぎ/); assert.equal(rows(id).filter(r => r.role === 'event' && r.limitSwitch).length, 1);
});

test('二重close/同じ依頼/交代の番は再交代せず、終了境界の停止も復活させない', async () => {
  const d = path.join(tmp, 'runner'); fs.mkdirSync(d); let switches = 0;
  const runner = new chat.ChatRunner({ dirOf: () => d, limitBackup: () => { switches++; return { ai: 'codex', model: 'GPT-6-Astra', effort: '極高', requireModel: true, requiredModel: 'gpt-6-astra' }; } });
  const o = { project: 'p', task: 't', pdir: d, dir: d, ai: 'claude', model: 'Fable 5.1', text: 'scenario=result-only', request: 'same' };
  runner.send(o); const run = runner.busy('p', 't'); await wait(() => chat.read(d, 't').filter(r => r.role === 'assistant').length === 2);
  run.child.emit('close', 1); assert.equal(switches, 1);
  runner.send({ ...o, limitSwitch: { request: 'same' } }); await wait(() => !runner.busy('p', 't')); assert.equal(switches, 1);
  runner.send(o); await wait(() => !runner.busy('p', 't')); assert.equal(switches, 1);
  const id = 'stop-boundary'; runner.watch('p', id, ev => { if (ev.type === 'idle') runner.stop('p', id); });
  runner.send({ ...o, task: id, request: 'boundary' }); await wait(() => !runner.busy('p', id)); assert.equal(runner.queue('p', id).length, 0); assert.equal(chat.read(d, id).filter(r => r.role === 'assistant').length, 1);
});

test('初回正式上限は終了後引継ぎ、利用枠がなくても次は保持でAstra、旧状態は読まない', async () => {
  config(); const first = task('チェック'); await send(first, 'result-only'); await wait(() => replies(first).length === 2);
  const stateFile = path.join(root, '_hub/limits.json');
  const state = JSON.parse(fs.readFileSync(stateFile))['claude-fable-5-1']; assert.equal(state.validUntil, null);
  const legacy = path.join(root, '_hub/fable-limit.json'), old = JSON.stringify({ model: 'claude-fable-5-1', at: new Date().toISOString(), until: new Date(Date.now() + 3600000).toISOString(), untilSource: 'unknown' });
  fs.writeFileSync(legacy, old);
  const rolesBefore = fs.readFileSync(rolesFile), id = task('司令塔');
  const res = await post('/api/chat/send', id, { ai: 'claude', model: 'claude-fable-5-1', text: 'scenario=ok' }); assert.equal(res.status, 200);
  await wait(() => replies(id).length === 1); assert.equal(replies(id)[0].ai, 'codex');
  assert.deepEqual(fs.readFileSync(rolesFile), rolesBefore);
  const status = await (await fetch(base + '/api/usage', { headers: { 'X-Hub': '1', Connection: 'close' } })).json(); assert.equal(status.fableLimit.hold, true); assert.equal(status.fableLimit.until, null);
  assert.equal(fs.readFileSync(legacy, 'utf8'), old);
});

test('Astra直行の同じrequestは完了後再実行せず、起動失敗後もuser/eventを重複しない', async () => {
  const { LimitEvidence } = require('../lib/limit-evidence'); const d = path.join(tmp, 'direct-runner'); fs.mkdirSync(d);
  let now = Date.now() - 10; const state = new LimitEvidence(path.join(d, 'state.json'), { now: () => now }); state.record({}); now += 1;
  state.observe({ providers: { claude: { status: 'ok', fetchedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(), windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: new Date(now + 3600000).toISOString() }] } } });
  const backup = { ai: 'codex', model: 'GPT-6-Astra', effort: '極高', requireModel: true, requiredModel: 'gpt-6-astra' };
  const runner = new chat.ChatRunner({ dirOf: () => d, limitPreflight: () => state.active(), limitBackup: () => backup });
  const o = { project: 'p', task: 'direct', pdir: d, dir: d, ai: 'claude', model: 'Fable 5.1', text: 'scenario=ok', request: 'same-direct' };
  runner.send(o); await wait(() => !runner.busy('p', 'direct'));
  runner.send(o); await new Promise(r => setTimeout(r, 30));
  assert.equal(chat.read(d, 'direct').filter(r => r.role === 'assistant').length, 1); assert.equal(chat.read(d, 'direct').filter(r => r.role === 'user').length, 1);
  const failed = { ...o, task: 'failed', request: 'same-failed' };
  fs.renameSync(path.join(bin, 'codex'), path.join(bin, 'codex.disabled'));
  try { runner.send(failed); await wait(() => !runner.busy('p', 'failed')); } finally { fs.renameSync(path.join(bin, 'codex.disabled'), path.join(bin, 'codex')); }
  runner.send(failed); await wait(() => !runner.busy('p', 'failed'));
  assert.equal(chat.read(d, 'failed').filter(r => r.role === 'user').length, 1); assert.equal(chat.read(d, 'failed').filter(r => r.role === 'event' && r.limitSwitch).length, 1);
  assert.equal(chat.read(d, 'failed').filter(r => r.role === 'assistant').at(-1).ai, 'codex');
});

test('旧直行印・旧limitStateは現在の証拠判定を迂回せずFable', async () => {
  const d = path.join(tmp, 'legacy-direct'); fs.mkdirSync(d);
  const backup = { ai: 'codex', model: 'GPT-6-Astra', requiredModel: 'gpt-6-astra' };
  const runner = new chat.ChatRunner({ dirOf: () => d, limitState: { active: () => ({ until: new Date(Date.now() + 3600000).toISOString() }) }, limitBackup: () => backup, limitPreflight: () => null });
  const o = { project: 'p', task: 'legacy', pdir: d, dir: d, ai: 'codex', model: 'GPT-6-Astra', requireModel: true, requiredModel: 'gpt-6-astra', text: 'old-card', shown: 'old-card', request: 'legacy-direct', limitSwitch: { direct: true, original: 'scenario=ok legacy-original' } };
  const result = runner.send(o); await wait(() => !runner.busy('p', 'legacy'));
  assert.equal(result.ai, 'claude'); assert.equal(result.limitSwitch, undefined);
  const input = captured(chat.read(d, 'legacy').find(r => r.role === 'assistant')).input;
  assert.match(input, /legacy-original/); assert.doesNotMatch(input, /old-card/);
});

test('即時APIで受信した委任は送信済みに含めず、同じ番がAPIで送った委任だけ保持', async () => {
  config();
  for (const outgoing of [false, true]) {
    await clearLimit();
    const cwd = path.join(tmp, outgoing ? 'outgoing-git' : 'received-git'); fs.mkdirSync(cwd);
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@invalid']);
    fs.writeFileSync(path.join(cwd, 'file'), 'before'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const id = task('チェック', cwd), beforeTasks = fs.readdirSync(path.join(dir, '.ai/tasks'));
    const res = await post('/api/delegate', id, { ai: 'claude', model: 'claude-fable-5-1', title: 'RECEIVED_REVIEW', text: `scenario=${outgoing ? 'delegate-then-limit' : 'result-only'} fixtureTask=${id}` });
    assert.equal(res.status, 200, await res.text());
    await wait(() => replies(id).length === (outgoing ? 3 : 2) && !queue(id).length);
    const card = captured(replies(id)[1]).input.split('# 今回の依頼\n')[1].split('元の依頼：')[0];
    assert.doesNotMatch(card, /RECEIVED_REVIEW/);
    if (outgoing) {
      assert.match(card, /送った委任：1件/); assert.match(card, /OUTGOING_IMPLEMENTATION/);
      assert.match(card, /同じ委任を送り直さない/); assert.doesNotMatch(card, /最初から始めてよい/);
    } else {
      assert.match(card, /送った委任：なし/); assert.match(card, /最初から始めてよい/);
    }
    const log = fs.readFileSync(path.join(root, '_hub/log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.task === id && r.action === 'delegate');
    const user = rows(id).find(r => r.role === 'user');
    assert.equal(log.find(r => r.title === 'RECEIVED_REVIEW').receivedTurn, user.turn);
    assert.equal(log.find(r => r.title === 'RECEIVED_REVIEW').sourceTurn, null);
    if (outgoing) assert.equal(log.find(r => r.title === 'OUTGOING_IMPLEMENTATION').sourceTurn, user.turn);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.ai/tasks')), beforeTasks);
  }
});

test('正式上限の終了後に始まるAstraも許可×作業選択だけで加速する', async () => {
  config();
  for (const [allowed, selected] of [[true, false], [true, true], [false, true]]) {
    const id = task('チェック');
    const permission = on => fetch(base + '/api/acceleration', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ codexAllowed: on }) });
    assert.equal((await permission(true)).status, 200);
    assert.equal((await post('/api/acceleration/task', id, { on: selected })).status, 200);
    assert.equal((await permission(allowed)).status, 200);
    await send(id, 'assistant-only', { fast: true });
    await wait(() => replies(id).length === 2);
    const got = captured(replies(id)[1]);
    assert.ok(got.args.includes('gpt-6-astra'));
    assert.equal(got.args.includes('service_tier="fast"'), allowed && selected);
    assert.equal(rows(id).findLast(r => r.role === 'user').fast, allowed && selected);
  }
});
