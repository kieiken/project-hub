'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');
const { Usage } = require('../lib/usage');
const { LimitEvidence } = require('../lib/limit-evidence');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-limit-preflight-'));
const root = path.join(tmp, 'root'), dir = path.join(root, 'Product', 'Preflight'), bin = path.join(tmp, 'bin');
const file = path.join(root, '_hub/limits.json'), rolesFile = path.join(root, '_hub/roles.yaml');
const launchFile = path.join(tmp, 'launches.jsonl');
const launches = ai => fs.existsSync(launchFile) ? fs.readFileSync(launchFile, 'utf8').trim().split('\n').filter(x => x === ai).length : 0;
const LIMIT = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai.";
let server, sessions, base, count = 0, reads = 0, statuses = 0, usageData = null, delayRead = null;
const originalStatus = Usage.prototype.status;
Usage.prototype.status = function(force) {
  statuses++;
  this.dry = false; this.find = ai => ai;
  this.read = async ai => {
    reads++; if (delayRead) await delayRead;
    // 保留の応答が証拠より確実に後になるよう取得を非同期にする。
    await new Promise(r => setTimeout(r, 5));
    if (!usageData) throw Error('fixture unavailable');
    return ai === 'claude' ? usageData : { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } };
  };
  return originalStatus.call(this, force);
};
function config(auto = true, backup = 'GPT-6-Astra') {
  fs.writeFileSync(rolesFile, `models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6-Astra, GPT-6.1-Sol]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 極高], backup: [codex, ${backup}, 極高] }\n  チェック: { main: [claude-code, Fable 5.1, 極高], backup: [codex, ${backup}, 極高] }\n  文章: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\nswitch:\n  auto: ${auto}\n`);
  const stamp = new Date(Date.now() + ++count * 10); fs.utimesSync(rolesFile, stamp, stamp);
}
function task(role = 'チェック') {
  const id = 'case-' + ++count;
  fs.writeFileSync(path.join(dir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: Fixture\nrole: ${role}\nowner: claude-code\nmodel: Fable 5.1\nworkspaceMode: direct\nstate: 実行中\nworkspaceStarted: 2026-10-06T00:00:00.000Z\n---\n## 手順\n- [ ] Review\n`); return id;
}
const rows = id => chat.read(dir, id), replies = id => rows(id).filter(r => r.role === 'assistant');
const post = (route, id, body = {}) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ project: 'Preflight', task: id, ...body }) });
const send = (id, scenario = 'ok', body = {}) => post('/api/chat/send', id, { ai: 'claude', model: 'Fable 5.1', text: 'scenario=' + scenario, ...body });
const delegate = (id, body = {}) => post('/api/delegate', id, { ai: 'claude', model: 'claude-fable-5-1', role: 'チェック', title: 'Review', text: 'scenario=ok', ...body });
async function wait(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('fixture timed out');
}
async function reply(id, n = 1) { await wait(() => replies(id).length >= n); return replies(id).at(-1); }
function evidence(valid = true, until = Date.now() + 3600000) {
  const at = Date.now() - 1000;
  return { version: 2, hold: true, lastLimitAt: new Date(at).toISOString(), untilSource: valid ? 'usage' : 'unknown', at: new Date(at).toISOString(), source: 'cli-limit', project: 'Other', task: 'other', request: 'earlier', validUntil: valid ? new Date(until).toISOString() : null, checkedAt: valid ? new Date(at + 1).toISOString() : null };
}
const full = (name = 'Fable') => ({ subscription_type: 'max', rate_limits_available: true, rate_limits: { model_scoped: [{ display_name: name, utilization: 100, resets_at: new Date(Date.now() + 3600000).toISOString() }] } });
async function restart(e = null) {
  if (server) await new Promise(r => server.close(r));
  fs.writeFileSync(file, typeof e === 'string' ? e : JSON.stringify(e ? { 'claude-fable-5-1': e } : {}));
  delete require.cache[require.resolve('../server')];
  ({ server, sessions } = require('../server')); await new Promise(r => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', r));
}
async function confirmRestored() {
  usageData = full();
  await post('/api/usage/refresh');
}
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ codex: { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] } }));
  config(); fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Preflight\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
  for (const ai of ['claude', 'codex']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
const ai=${JSON.stringify(ai)},limit=${JSON.stringify(LIMIT)};let input='';
require('node:fs').appendFileSync(${JSON.stringify(launchFile)},ai+'\\n');
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const scenario=(input.slice(input.lastIndexOf('# 今回の依頼')).match(/scenario=([\\w-]+)/)||[])[1]||'ok';
 const out=o=>console.log(JSON.stringify(o)), info=JSON.stringify({ai,args:process.argv.slice(2),input:input.replaceAll('[[質問]]','(template)').replaceAll('[[/質問]]','(end)')});
 const finish=()=>{
  if(ai==='codex'){out({type:'item.completed',item:{type:'agent_message',text:info}});out(scenario==='astra-fail'?{type:'turn.failed',error:{message:'fixture failure'}}:{type:'turn.completed',usage:{input_tokens:40,cached_input_tokens:10}});return;}
  if(['limit','hold-limit'].includes(scenario)){out({type:'result',is_error:true,result:limit});process.exitCode=1;return;}
  if(['temporary','model'].includes(scenario)){out({type:'result',is_error:true,result:scenario==='model'?'unknown model':'Too many requests'});process.exitCode=1;return;}
  out({type:'assistant',message:{content:[{type:'text',text:scenario==='quote'?limit:info}]}});out({type:'result',is_error:false,result:''});
 };
 if(scenario.startsWith('hold'))setTimeout(finish,700);else finish();
});process.on('SIGTERM',()=>process.exit(143));
`, { mode: 0o755 });
  Object.assign(process.env, { PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home'), HUB_TRASH: path.join(tmp, 'trash') });
  ({ server, sessions } = require('../server')); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; base = 'http://127.0.0.1:' + port; process.env.HUB_PORT = String(port);
  await restart();
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); Usage.prototype.status = originalStatus; });


test('モデル順・非表示の保存と再起動は正式証拠判定を迂回せず、担当設定を保持する', async () => {
  config(); usageData = full(); await restart();
  const order = require('../public/model-order');
  const initial = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  assert.equal((await post('/api/models/initial', null, initial)).status, 200);
  const before = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(before.initialPick, initial);
  const defaults = order.ordered(before.roles.models, before.modelOrder), next = defaults.slice().reverse();
  assert.equal((await post('/api/models/order', null, { order: next, before: defaults })).status, 200);
  for (const [ai, model] of [['claude-code', 'Fable 5.1'], ['codex', 'GPT-6-Astra']]) {
    assert.equal((await post('/api/models/hidden', null, { ai, model, hidden: true })).status, 200);
  }
  const viewFile = path.join(root, '_hub/model-view.json'), savedView = fs.readFileSync(viewFile);
  const savedRoles = fs.readFileSync(rolesFile);
  const unconfirmed = task(), initialReads = statuses;
  assert.equal((await (await delegate(unconfirmed)).json()).model, 'Fable 5.1');
  assert.equal((await reply(unconfirmed)).ai, 'claude');
  assert.equal(statuses, initialReads); // 並び順・100%表示・非表示だけで枠確認や交代を始めない。

  await restart(evidence()); // 設定を保った再起動後も保持を使う。
  usageData = null;
  const failed = task();
  assert.equal((await (await delegate(failed)).json()).model, 'GPT-6-Astra');
  assert.equal((await reply(failed)).ai, 'codex');

  await restart(evidence()); usageData = full();
  const confirmed = task(), result = await (await delegate(confirmed)).json();
  assert.equal(result.model, 'GPT-6-Astra'); assert.match(result.note, /Fable上限保持中のため Astra/);
  const answer = await reply(confirmed), args = JSON.parse(answer.text).args;
  assert.equal(answer.ai, 'codex'); assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.equal(rows(confirmed).filter(r => r.role === 'event' && r.limitSwitch?.preflight).length, 1);
  const after = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(after.modelOrder, next); assert.deepEqual(after.roles, before.roles);
  assert.deepEqual(after.initialPick, initial); // 初期AI設定は再起動・正式上限判定でも保持し、チェック役割を変更しない。
  assert.ok(after.hiddenModels['claude-code'].includes('Fable 5.1'));
  assert.ok(after.hiddenModels.codex.includes('GPT-6-Astra'));
  assert.deepEqual(fs.readFileSync(viewFile), savedView); assert.deepEqual(fs.readFileSync(rolesFile), savedRoles);
  for (const id of [unconfirmed, failed, confirmed]) {
    assert.match(fs.readFileSync(path.join(dir, '.ai/tasks', id + '.md'), 'utf8'), /^model: Fable 5.1$/m);
  }
});

test('証拠なしの委任は100%表示でもFable、利用枠要求を増やさない', async () => {
  config(); usageData = full(); await restart();
  await (await fetch(base + '/api/usage', { headers: { 'X-Hub': '1', Connection: 'close' } })).json();
  const before = statuses, id = task();
  const res = await (await delegate(id)).json(); assert.equal(res.model, 'Fable 5.1'); assert.equal(statuses, before);
  assert.equal((await reply(id)).ai, 'claude'); assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
});
test('正式上限だけを記録、引用/一時上限/モデル拒否/停止は保存しない', async () => {
  config(false); usageData = null;
  for (const scenario of ['quote', 'temporary', 'model', 'hold-limit']) {
    await restart(); const id = task(); assert.equal((await send(id, scenario)).status, 200);
    if (scenario === 'hold-limit') await post('/api/chat/stop', id);
    await reply(id); assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
  }
  await restart(); const id = task(); await send(id, 'limit'); await reply(id);
  await wait(() => statuses > 0 && JSON.parse(fs.readFileSync(file))['claude-fable-5-1']);
  const e = JSON.parse(fs.readFileSync(file))['claude-fable-5-1']; assert.equal(e.source, 'cli-limit'); assert.equal(e.task, id); assert.equal(e.validUntil, null);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /You've|credits|input/);
});
test('共通send入口でstrictモデルを維持し、同requestを重複させず失敗後も再交代しない', async () => {
  config(); await restart(evidence()); await confirmRestored(); const id = task();
  const result = await (await send(id, 'astra-fail')).json(); assert.equal(result.model, 'GPT-6-Astra'); assert.match((await reply(id)).error, /fixture failure/);
  await new Promise(r => setTimeout(r, 60)); assert.equal(replies(id).length, 1); assert.equal(rows(id).filter(r => r.role === 'event' && r.limitSwitch).length, 1);
  const e = new LimitEvidence(file);
  e.observe({ providers: { claude: { status: 'ok', fetchedAt: new Date(Date.now() + 1).toISOString(), windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: new Date(Date.now() + 3600000).toISOString() }] } } });
  const runner = new chat.ChatRunner({ dirOf: () => dir, limitBackup: () => ({ ai: 'codex', model: 'GPT-6-Astra', requiredModel: 'gpt-6-astra' }), limitPreflight: () => e.active() });
  let captured;
  runner.run = o => { captured = o; return { startedP: Promise.resolve(true) }; };
  const o = { project: 'Preflight', task: task(), pdir: dir, ai: 'claude', model: 'Fable 5.1', text: 'original', request: 'fixed' };
  runner.send(o); runner.send(o);
  assert.equal(captured.requiredModel, 'gpt-6-astra'); assert.equal(captured.requireModel, true); assert.equal(captured.limitSwitch.preflight, true);
  assert.equal(rows(o.task).filter(r => r.role === 'user').length, 1); assert.equal(rows(o.task).filter(r => r.role === 'event' && r.limitSwitch).length, 1);
});
test('順番待ちは開始時に判定し、解除期限を過ぎたFable依頼をAstraにしない', async () => {
  config(); await restart(evidence(true, Date.now() + 400));
  usageData = { ...full(), rate_limits: { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 400).toISOString() } } };
  await post('/api/usage/refresh'); const id = task();
  await send(id, 'hold-ok', { ai: 'codex', model: 'GPT-6.1-Sol' });
  const before = statuses, queued = await (await delegate(id)).json(); assert.equal(queued.queued, true); assert.equal(queued.model, 'Fable 5.1'); assert.equal(statuses, before);
  await reply(id, 2); assert.deepEqual(replies(id).map(r => r.model), ['GPT-6.1-Sol', 'Fable 5.1']); assert.equal(rows(id).filter(r => r.limitSwitch).length, 0);
});
test('順番待ちと保存キュー再開も有効証拠なら同じ依頼をAstraで始める', async () => {
  config(); await restart(evidence()); await confirmRestored(); const id = task();
  await send(id, 'hold-ok', { ai: 'codex', model: 'GPT-6.1-Sol' }); const queued = await (await delegate(id)).json();
  await reply(id, 2); assert.equal(replies(id).at(-1).model, 'GPT-6-Astra'); assert.equal(rows(id).find(r => r.limitSwitch).limitSwitch.request, queued.id);
  const saved = task(), queueFile = path.join(dir, '.ai/chat', saved + '.queue.json');
  fs.writeFileSync(queueFile, JSON.stringify([{ id: 'saved', ai: 'claude', model: 'Fable 5.1', role: 'チェック', requireModel: true, requiredModel: 'claude-fable-5-1', text: 'scenario=ok' }]));
  const result = await (await post('/api/chat/send', saved, { fromQueue: 'saved' })).json(); assert.equal(result.model, 'GPT-6-Astra'); await reply(saved); assert.deepEqual(JSON.parse(fs.readFileSync(queueFile)), []);
});
test('自動交代オフ・対象外role・Astra以外のbackup・Fable以外へ広げない', async () => {
  for (const [auto, backup, role, model] of [[false, 'GPT-6-Astra', 'チェック', 'Fable 5.1'], [true, 'GPT-6-Astra', '文章', 'Fable 5.1'], [true, 'GPT-6.1-Sol', 'チェック', 'Fable 5.1'], [true, 'GPT-6-Astra', 'チェック', 'Opus 5.5']]) {
    config(auto, backup); await restart(evidence()); const id = task(role); const result = await (await send(id, 'ok', { model })).json(); assert.equal(result.model, model); assert.equal((await reply(id)).ai, 'claude'); assert.equal(rows(id).filter(r => r.limitSwitch).length, 0);
  }
});
test('正式上限の終了後に取った利用枠を次の委任で再利用し、Fableの再失敗を省く', async () => {
  config(false); usageData = full(); await restart(); const first = task();
  await send(first, 'limit'); await reply(first);
  await wait(() => JSON.parse(fs.readFileSync(file))['claude-fable-5-1']?.validUntil);
  config(); const second = task(), before = reads;
  assert.equal((await (await delegate(second)).json()).model, 'GPT-6-Astra');
  assert.equal((await reply(second)).ai, 'codex'); assert.equal(reads, before);
});

test('旧上限ファイルだけでは送信・委任・旧直行キュー・利用量表示を有効にしない', async () => {
  config(); usageData = full(); await restart();
  const legacy = path.join(root, '_hub/fable-limit.json');
  const old = JSON.stringify({ model: 'claude-fable-5-1', at: new Date().toISOString(), until: new Date(Date.now() + 3600000).toISOString(), untilSource: 'unknown' });
  fs.writeFileSync(legacy, old); await restart();
  const direct = task(); assert.equal((await (await send(direct)).json()).model, 'Fable 5.1'); await reply(direct);
  const delegated = task(); assert.equal((await (await delegate(delegated)).json()).model, 'Fable 5.1'); await reply(delegated);
  const queued = task(), queueFile = path.join(dir, '.ai/chat', queued + '.queue.json');
  fs.writeFileSync(queueFile, JSON.stringify([{ id: 'legacy', ai: 'codex', model: 'GPT-6-Astra', role: 'チェック', requireModel: true, requiredModel: 'gpt-6-astra', text: 'obsolete-card', shown: 'obsolete-card', limitSwitch: { direct: true, original: 'scenario=ok queue-original' } }]));
  const result = await (await post('/api/chat/send', queued, { fromQueue: 'legacy' })).json();
  assert.equal(result.model, 'Fable 5.1'); assert.equal((await reply(queued)).ai, 'claude');
  const input = JSON.parse(replies(queued)[0].text).input; assert.match(input, /queue-original/); assert.doesNotMatch(input, /obsolete-card/);
  const status = await (await post('/api/usage/refresh')).json(); assert.equal(status.fableLimit, null);
  assert.equal(fs.readFileSync(legacy, 'utf8'), old); assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
});

test('確認済み上限の表示と事前カードは1経路にそろい、CLI入力量も保持する', async () => {
  config(); usageData = full(); await restart(evidence()); await confirmRestored();
  const status = await (await fetch(base + '/api/usage', { headers: { 'X-Hub': '1', Connection: 'close' } })).json();
  assert.equal(status.fableLimit.untilSource, 'usage'); assert.equal(status.fableLimit.until, JSON.parse(fs.readFileSync(file))['claude-fable-5-1'].validUntil);
  const id = task(), result = await (await delegate(id, { text: 'scenario=ok integrated-unique' })).json();
  assert.equal(result.model, 'GPT-6-Astra'); const row = await reply(id), input = JSON.parse(row.text).input;
  assert.match(input, /Fable 5.1 上限保持中/); assert.match(input, /前の番は無い/);
  assert.doesNotMatch(input, /Fable 5.1 は利用上限で止まった/); assert.equal(input.split('integrated-unique').length - 1, 1);
  assert.deepEqual(row.usage, { input_tokens: 40, cached_input_tokens: 10 });
  const user = rows(id).find(r => r.role === 'user'); assert.ok(user.turn); assert.equal(user.limitSwitch.preflight, true);
  const log = fs.readFileSync(path.join(root, '_hub/log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).findLast(r => r.task === id && r.action === 'delegate');
  assert.equal(log.receivedTurn, user.turn); assert.equal(log.sourceTurn, null); assert.equal(log.preflight, true);
});

for (const known of [true, false]) {
  for (const method of ['send', 'delegate']) {
    test(`${method}は再起動直後も${known ? '既知' : '不明'}期限の保持だけでAstra、利用枠を取得しない`, async () => {
      config(); usageData = null; await restart(evidence(known)); const id = task(), before = statuses;
      const rolesBefore = fs.readFileSync(rolesFile), fableBefore = launches('claude');
      const result = await (await (method === 'send' ? send(id) : delegate(id))).json();
      assert.equal(result.model, 'GPT-6-Astra'); assert.match(result.note, /保持中/);
      const row = await reply(id), got = JSON.parse(row.text);
      assert.equal(statuses, before); assert.equal(launches('claude'), fableBefore);
      assert.equal(got.args[got.args.indexOf('--model') + 1], 'gpt-6-astra');
      assert.match(got.input, /保持中.*最初から Astra で開始/);
      assert.match(got.input, /AIは確認不要/);
      const ev = rows(id).filter(r => r.role === 'event' && r.limitSwitch);
      assert.equal(ev.length, 1); assert.equal(ev[0].limitSwitch.preflight, true);
      assert.match(ev[0].text, known ? /解除/ : /手動解除まで/); assert.doesNotMatch(ev[0].text, /1970/);
      assert.deepEqual(fs.readFileSync(rolesFile), rolesBefore);
      assert.match(fs.readFileSync(path.join(dir, '.ai/tasks', id + '.md'), 'utf8'), /model: Fable 5.1/);
    });
  }
}
test('期限後・破損・移行できないv1はFableのまま、v1の未来の証拠だけ移行', async () => {
  config(); usageData = null;
  const old = evidence(); delete old.version; delete old.hold; delete old.lastLimitAt; delete old.untilSource;
  for (const e of [evidence(true, Date.now() - 1), '{broken', { ...old, validUntil: null }, { ...old, checkedAt: old.at }]) {
    await restart(e); const id = task(); assert.equal((await (await delegate(id)).json()).model, 'Fable 5.1'); assert.equal((await reply(id)).ai, 'claude');
  }
  await restart(old); const id = task(); assert.equal((await (await send(id)).json()).model, 'GPT-6-Astra'); await reply(id);
});
test('100%未満の利用状況・取得失敗・自動交代オフでのFable成功でも保持を残す', async () => {
  config(); usageData = { ...full(), rate_limits: { five_hour: { utilization: 99, resets_at: new Date(Date.now() + 3600000).toISOString() } } };
  await restart(evidence(false));
  const low = await (await post('/api/usage/refresh')).json(); assert.equal(low.fableLimit.hold, true); assert.equal(low.fableLimit.until, null);
  config(false); const id = task(); await send(id); await reply(id); assert.equal(JSON.parse(fs.readFileSync(file))['claude-fable-5-1'].hold, true);
  config(); usageData = null; await restart(evidence(false));
  const failed = await (await post('/api/usage/refresh')).json(); assert.equal(failed.providers.claude.status, 'unavailable'); assert.equal(failed.fableLimit.hold, true);
  const next = task(), before = statuses; assert.equal((await (await delegate(next)).json()).model, 'GPT-6-Astra'); await reply(next); assert.equal(statuses, before);
});
test('手動解除APIはX-HubとOriginを守り、解除保存とlogの後でFableへ戻す', async () => {
  config(); usageData = null; await restart(evidence(false));
  const saved = fs.readFileSync(file);
  for (const headers of [{}, { 'X-Hub': '1', Origin: 'https://elsewhere.invalid' }]) {
    const res = await fetch(base + '/api/limits/fable/clear', { method: 'POST', headers: { ...headers, Connection: 'close' } });
    assert.equal(res.status, 403); assert.deepEqual(fs.readFileSync(file), saved);
  }
  const result = await post('/api/limits/fable/clear'); assert.equal(result.status, 200); assert.equal((await result.json()).fableLimit, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
  const log = fs.readFileSync(path.join(root, '_hub/log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.equal(log.at(-1).action, 'limit-clear');
  const id = task(); assert.equal((await (await send(id)).json()).model, 'Fable 5.1'); await reply(id);
  await restart(JSON.parse(fs.readFileSync(file))['claude-fable-5-1'] || null);
  const next = task(); assert.equal((await (await delegate(next)).json()).model, 'Fable 5.1'); await reply(next);
});
test('解除保存失敗は500で保持を続け、原因修復後に解除できる', async () => {
  config(); await restart(evidence(false)); const original = fs.renameSync, saved = fs.readFileSync(file);
  fs.renameSync = (src, dest) => { if (dest === file) throw Error('fixture clear denied'); return original(src, dest); };
  try {
    const res = await post('/api/limits/fable/clear'); assert.equal(res.status, 500); assert.equal((await res.json()).error, '解除を保存できませんでした');
    assert.deepEqual(fs.readFileSync(file), saved);
    const id = task(); assert.equal((await (await delegate(id)).json()).model, 'GPT-6-Astra'); await reply(id);
  } finally { fs.renameSync = original; }
  assert.equal((await post('/api/limits/fable/clear')).status, 200);
});
test('初回正式上限の保存失敗をevent/logへ残し、終了後引継ぎだけ実行', async () => {
  config(); usageData = null; await restart(); const original = fs.renameSync;
  fs.renameSync = (src, dest) => { if (dest === file) throw Error('fixture record denied'); return original(src, dest); };
  try {
    const id = task(); await send(id, 'limit'); await reply(id, 2);
    assert.deepEqual(replies(id).map(r => r.ai), ['claude', 'codex']);
    assert.ok(rows(id).some(r => r.role === 'event' && /確認記録を更新できませんでした/.test(r.text)));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), {});
    assert.ok(fs.readFileSync(path.join(root, '_hub/log.jsonl'), 'utf8').includes('limit-save-error'));
    const next = task(); assert.equal((await (await delegate(next)).json()).model, 'Fable 5.1'); await reply(next);
  } finally { fs.renameSync = original; }
});
test('手動解除後に届く利用枠の応答は保持を復活させず、新しい保持より古い取得も無視', async () => {
  config(false); usageData = full(); await restart(evidence(false)); let release;
  delayRead = new Promise(r => { release = r; }); const before = reads;
  try {
    const pending = post('/api/usage/refresh'); await wait(() => reads > before);
    assert.equal((await post('/api/limits/fable/clear')).status, 200);
    await new Promise(r => setTimeout(r, 10));
    // 新規上限後のstatusは同じ取得を共有するが、この古い応答は期限に使えない。
    const id = task(); await send(id, 'limit'); await reply(id);
    release(); delayRead = null;
    const result = await (await pending).json(); assert.equal(result.fableLimit, null); // auto off
    assert.equal(JSON.parse(fs.readFileSync(file))['claude-fable-5-1'].validUntil, null);
    assert.equal((await post('/api/limits/fable/clear')).status, 200);
    config(); const next = task(); assert.equal((await (await delegate(next)).json()).model, 'Fable 5.1'); await reply(next);
  } finally { release(); delayRead = null; }
});
function saveQueue(id, item = {}) {
  const queueFile = path.join(dir, '.ai/chat', id + '.queue.json');
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, JSON.stringify([{ id: 'saved', ai: 'claude', model: 'Fable 5.1', role: 'チェック', requireModel: true, requiredModel: 'claude-fable-5-1', text: 'scenario=ok', ...item }])); return queueFile;
}
for (const automatic of [true, false]) {
  const route = automatic ? '自動キュー' : '保存キュー再開';
  test(`${route}は期限不明・取得停止中でも待たずAstra、後続を順に1回だけ実行`, async () => {
    config(); usageData = null; await restart(evidence(false)); const id = task(), before = statuses, fableBefore = launches('claude');
    let request;
    if (automatic) {
      await send(id, 'hold-ok', { ai: 'codex', model: 'GPT-6.1-Sol' });
      const result = await (await delegate(id)).json(); assert.equal(result.queued, true); request = result.id;
      await delegate(id, { ai: 'codex', role: null, model: 'gpt-6.1-sol', text: 'scenario=ok follower' });
    } else {
      saveQueue(id); request = 'saved';
      const result = await (await post('/api/chat/send', id, { fromQueue: request })).json(); assert.equal(result.model, 'GPT-6-Astra');
    }
    await reply(id, automatic ? 3 : 1);
    assert.deepEqual(replies(id).map(r => r.model), automatic ? ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6.1-Sol'] : ['GPT-6-Astra']);
    assert.equal(statuses, before); assert.equal(launches('claude'), fableBefore);
    assert.equal(rows(id).filter(r => r.role === 'user' && r.request === request).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.ai/chat', id + '.queue.json'))), []);
    assert.equal((await post('/api/chat/send', id, { fromQueue: request })).status, 404);
  });
}
test('保存キューのAstra起動失敗は先頭を残し、修復後も保持でAstraへ1回再開', async () => {
  config(); usageData = null; await restart(evidence(false)); const id = task(), queueFile = saveQueue(id);
  const saved = JSON.parse(fs.readFileSync(queueFile)); fs.renameSync(path.join(bin, 'codex'), path.join(bin, 'codex.disabled'));
  try { assert.equal((await post('/api/chat/send', id, { fromQueue: 'saved' })).status, 409); await reply(id); assert.deepEqual(JSON.parse(fs.readFileSync(queueFile)), saved); }
  finally { fs.renameSync(path.join(bin, 'codex.disabled'), path.join(bin, 'codex')); }
  const before = statuses;
  assert.equal((await (await post('/api/chat/send', id, { fromQueue: 'saved' })).json()).model, 'GPT-6-Astra'); await reply(id, 2);
  assert.equal(statuses, before); assert.deepEqual(replies(id).map(r => r.ai), ['codex', 'codex']);
  assert.equal(rows(id).filter(r => r.role === 'event' && r.limitSwitch).length, 1);
  assert.equal(rows(id).filter(r => r.role === 'user' && r.request === 'saved').length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(queueFile)), []);
});
test('待機中に手動解除したキューは開始時にFable、開始済みAstraは解除後も継続', async () => {
  config(); await restart(evidence(false)); const id = task();
  await send(id, 'hold-ok', { ai: 'codex', model: 'GPT-6.1-Sol' }); await delegate(id);
  assert.equal((await post('/api/limits/fable/clear')).status, 200); await reply(id, 2);
  assert.deepEqual(replies(id).map(r => r.model), ['GPT-6.1-Sol', 'Fable 5.1']);
  await restart(evidence(false)); const started = task(); await send(started, 'hold-ok');
  assert.equal((await post('/api/limits/fable/clear')).status, 200); await reply(started);
  assert.equal(replies(started)[0].model, 'GPT-6-Astra'); assert.equal(replies(started)[0].error, '');
});
