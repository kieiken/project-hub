'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const chat = require('../lib/chat');
const { Usage } = require('../lib/usage');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capacity-http-')));
const root = path.join(tmp, 'root'), dir = path.join(root, 'Product', 'Fixture'), bin = path.join(tmp, 'bin');
const rolesFile = path.join(root, '_hub/roles.yaml'), launches = path.join(tmp, 'launches.jsonl');
const capacity = 'Selected model is at capacity. Please try a different model.';
let runtime, base, usageInstance, usageMode = 'available';
const statusReads = [], originalStatus = Usage.prototype.status;
Usage.prototype.status = function(force, selection, options) {
  usageInstance = this; this.dry = false; this.find = ai => path.join(bin, ai);
  this.read = async (ai, file, opts) => {
    statusReads.push({ ai, account: opts.account });
    if (usageMode === 'unknown') throw Error('fixture contract unavailable');
    if (ai !== 'codex') throw Error('fixture provider unavailable');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: usageMode === 'empty' ? 100 : 25,
      windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 } } };
  };
  return originalStatus.call(this, force, selection, options);
};
const sha = f => fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
function config(auto = true) {
  fs.writeFileSync(rolesFile, `models:\n  claude-code: [Opus 5.5, Fable 5.2]\n  codex: [GPT-6.1-Sol, GPT-6-Astra]\nroles:\n  コーディング: { main: [codex, GPT-6.1-Sol, 高], backup: [claude-code, Opus 5.5, 高] }\n  司令塔: { main: [claude-code, Fable 5.2, 高], backup: [codex, GPT-6-Astra, 高] }\nswitch:\n  auto: ${auto}\n`);
  const stamp = new Date(Date.now() + 1000); fs.utimesSync(rolesFile, stamp, stamp);
  require('../lib/role-history').load(rolesFile); // Establish the normal journal before preservation assertions.
}
async function until(fn, detail = () => null) {
  const end = Date.now() + 12000;
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(fn(), 'HTTP mock turn did not settle: ' + JSON.stringify(detail()));
}
const rows = id => chat.read(dir, id);
const calls = () => fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse) : [];
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true }); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ codex: { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }] } }));
  config(); fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
  for (const ai of ['codex', 'claude']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
if(!process.argv.includes('--json')&&!process.argv.includes('--output-format')){console.log('mock cli');process.exit(0);}
const fs=require('node:fs'),out=o=>console.log(JSON.stringify(o));let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({ai:${JSON.stringify(ai)},args:process.argv.slice(2),input})+'\\n');
 if(${JSON.stringify(ai)}==='codex'){
  out({type:'item.completed',item:{type:'agent_message',text:'途中の作業は保存済み'}});
  const model=process.argv[process.argv.indexOf('--model')+1];
  if(input.includes('scenario=astra-sol')&&model==='gpt-6.1-sol'||input.includes('scenario=sol-astra')&&model==='gpt-6-astra'){
   out({type:'turn.completed'});return;
  }
  out({type:'error',message:${JSON.stringify(capacity)}});out({type:'turn.failed',error:{message:${JSON.stringify(capacity)}}});process.exitCode=1;
 }else{out({type:'assistant',message:{content:[{type:'text',text:'引き継いで完了'}]}});out({type:'result',is_error:false,result:''});}
});
`, { mode: 0o755 });
  // The request origin guard must know the actual listening port before server.js loads.
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  Object.assign(process.env, { PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home'), HUB_TRASH: path.join(tmp, 'trash') });
  runtime = require('../server'); await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + runtime.server.address().port;
});
test.after(async () => {
  if (runtime) { runtime.sessions.stopAll(); runtime.stopControl.cleanExit(); await new Promise(r => runtime.server.close(r)); }
  Usage.prototype.status = originalStatus;
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function send(id, { model = 'GPT-6.1-Sol', role = 'コーディング', scenario = '' } = {}) {
  fs.writeFileSync(path.join(dir, '.ai/tasks', id + '.md'), `---\nid: ${id}\ntitle: Fixture\nrole: ${role}\nowner: codex\nmodel: ${model}\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] 元の依頼の残り\n`);
  const r = await fetch(base + '/api/chat/send', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ project: 'Fixture', task: id, ai: 'codex', model, effort: '極高', text: '残りだけ続ける ' + scenario }) });
  const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body));
}
test('実HTTPの混雑停止は残量確認後に同系列Astraへ引継ぎ、Opusへの上限設定・手順は保持', async () => {
  const rolesBefore = sha(rolesFile), limits = path.join(root, '_hub/limits.json'), limitsBefore = sha(limits);
  await send('one', { scenario: 'scenario=sol-astra' });
  await until(() => rows('one').filter(r => r.role === 'assistant').length === 2);
  const all = calls(); assert.deepEqual(all.map(x => x.ai), ['codex', 'codex']);
  assert.equal(all[1].args[all[1].args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(statusReads.some(r => r.ai === 'codex' && r.account === 'default'));
  assert.match(all[1].input, /モデル混雑/); assert.match(all[1].input, /繰り返さず/);
  assert.equal(rows('one').filter(r => r.role === 'assistant')[0].error, capacity);
  assert.equal(rows('one').filter(r => r.role === 'assistant')[1].error, '');
  assert.equal(sha(rolesFile), rolesBefore); assert.equal(sha(limits), limitsBefore);
  assert.match(fs.readFileSync(path.join(dir, '.ai/tasks/one.md'), 'utf8'), /- \[ \] 元の依頼の残り/);
  assert.equal(runtime.stopControl.held({ project: 'Fixture', task: 'one' }), false);
});
test('自動交代OFFはHTTPでも別AIへ送らず、正式な混雑停止を残す', async () => {
  config(false); await send('off');
  await until(() => rows('off').some(r => r.role === 'event' && /待機します/.test(r.text)));
  assert.deepEqual(calls().map(x => x.ai), ['codex', 'codex', 'codex']);
  assert.equal(rows('off').filter(r => r.role === 'assistant').length, 1);
});
test('実HTTPで司令塔のAstraからSolへ再開し、main・利用上限・思考量を変えない', async () => {
  config(); const before = calls().length, rolesBefore = sha(rolesFile), limitsBefore = sha(path.join(root, '_hub/limits.json'));
  await send('astra', { model: 'GPT-6-Astra', role: '司令塔', scenario: 'scenario=astra-sol' });
  await until(() => rows('astra').filter(r => r.role === 'assistant').length === 2);
  const all = calls().slice(before);
  assert.deepEqual(all.map(x => x.ai), ['codex', 'codex']);
  assert.deepEqual(all.map(x => x.args[x.args.indexOf('--model') + 1]), ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.ok(all[1].args.includes('model_reasoning_effort=xhigh'));
  assert.match(all[1].input, /済んだ部分と委任は繰り返さず/);
  assert.equal(rows('astra').findLast(r => r.role === 'assistant').error, '');
  assert.equal(rows('astra').findLast(r => r.role === 'user').limitSwitch.reason, 'capacity');
  assert.equal(sha(rolesFile), rolesBefore); assert.equal(sha(path.join(root, '_hub/limits.json')), limitsBefore);
  assert.equal(runtime.stopControl.held({ project: 'Fixture', task: 'astra' }), false);
});
test('実HTTPでもAstraとSolが両方混雑なら往復せず終了記録と待機を残す', async () => {
  config(); const before = calls().length;
  await send('both', { model: 'GPT-6-Astra', role: '司令塔' });
  await until(() => rows('both').some(r => r.role === 'event' && /使い切ったため/.test(r.text)), () => ({ rows: rows('both'), calls: calls().slice(before) }));
  assert.deepEqual(calls().slice(before).map(x => x.args[x.args.indexOf('--model') + 1]), ['gpt-6-astra', 'gpt-6.1-sol']);
  assert.equal(rows('both').filter(r => r.role === 'assistant').length, 2);
  assert.ok(rows('both').filter(r => r.role === 'assistant').every(r => r.error === capacity));
});
test('Astraからの再開も自動交代OFFなら実HTTPで開始しない', async () => {
  config(false); const before = calls().length;
  await send('astra-off', { model: 'GPT-6-Astra', role: '司令塔', scenario: 'scenario=astra-sol' });
  await until(() => rows('astra-off').some(r => r.role === 'event' && /待機します/.test(r.text)));
  assert.equal(calls().length - before, 1);
  assert.equal(rows('astra-off').filter(r => r.role === 'assistant').length, 1);
});
test('正式混雑でも契約枠の残量不明ならHTTPで自動再開しない', async () => {
  config(); usageMode = 'unknown'; usageInstance.invalidate('codex'); const before = calls().length;
  try {
    await send('unknown');
    await until(() => rows('unknown').some(r => r.role === 'event' && /待機します/.test(r.text)));
    assert.equal(calls().length - before, 1);
    assert.equal(rows('unknown').findLast(r => r.role === 'assistant').error, capacity);
  } finally { usageMode = 'available'; usageInstance.invalidate('codex'); }
});
for (const change of ['empty', 'unknown']) {
  test(`元のCLI終了時に契約枠を読み直し、${change}なら開始時の余裕を再利用しない`, async () => {
    config(); usageInstance.invalidate('codex'); const id = 'after-exit-' + change, before = calls().length, readsBefore = statusReads.length;
    let changed = false;
    const unwatch = runtime.chats.watch('Fixture', id, ev => {
      if (ev.type !== 'row' || ev.row.role !== 'assistant' || ev.row.error !== capacity) return;
      changed = true; usageMode = change; usageInstance.invalidate('codex');
    });
    try {
      await send(id, { scenario: 'scenario=sol-astra' });
      runtime.chats.enqueue('Fixture', id, { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
      await until(() => !runtime.chats.busy('Fixture', id) && rows(id).some(r => r.role === 'event' && /待ち指示を開始せず待機します/.test(r.text)));
      assert.equal(changed, true); assert.equal(calls().length - before, 1);
      assert.equal(statusReads.length - readsBefore, 2);
      assert.equal(rows(id).filter(r => r.role === 'assistant').length, 1);
      assert.ok(runtime.chats.queue('Fixture', id).some(q => q.id === 'later'));
      assert.ok(!runtime.chats.queue('Fixture', id).some(q => q.limitSwitch?.reason === 'capacity'));
    } finally {
      unwatch(); usageMode = 'available'; usageInstance.invalidate('codex');
      const limits = path.join(root, '_hub/limits.json'); if (fs.existsSync(limits)) fs.writeFileSync(limits, '{}');
    }
  });
}
for (const change of ['empty', 'unknown', 'auto-off', 'model-disabled']) {
  test(`引継ぎ保存後・送信直前の${change}でも起動せず、引継ぎと後続を保持`, async () => {
    config(); usageInstance.invalidate('codex'); const id = 'recheck-' + change, before = calls().length;
    const launch = require('../lib/launch'); let changed = false;
    const unwatch = runtime.chats.watch('Fixture', id, ev => {
      if (ev.type !== 'row' || ev.row.role !== 'event' || ev.row.limitSwitch?.reason !== 'capacity') return;
      changed = true;
      if (change === 'auto-off') config(false);
      else if (change === 'model-disabled') launch.setOverrides({ codex: { 'GPT-6-Astra': '' } });
      else { usageMode = change; usageInstance.invalidate('codex'); }
    });
    try {
      await send(id, { scenario: 'scenario=sol-astra' });
      runtime.chats.enqueue('Fixture', id, { id: 'later', ai: 'codex', model: 'GPT-6.1-Sol', text: 'later' });
      await until(() => !runtime.chats.busy('Fixture', id) && rows(id).some(r => r.role === 'event' && /待ち指示は保留しています：モデル混雑の自動再開条件/.test(r.text)), () => ({ rows: rows(id), queue: runtime.chats.queue('Fixture', id) }));
      assert.equal(changed, true); assert.equal(calls().length - before, 1);
      assert.equal(rows(id).filter(r => r.role === 'assistant').length, 1);
      assert.ok(runtime.chats.queue('Fixture', id).some(q => q.limitSwitch?.reason === 'capacity'));
      assert.ok(runtime.chats.queue('Fixture', id).some(q => q.id === 'later'));
    } finally {
      unwatch(); launch.setOverrides({}); usageMode = 'available'; usageInstance.invalidate('codex'); config();
      // Test-local hold records must not affect the next independent scenario.
      const limits = path.join(root, '_hub/limits.json'); if (fs.existsSync(limits)) fs.writeFileSync(limits, '{}');
    }
  });
}
