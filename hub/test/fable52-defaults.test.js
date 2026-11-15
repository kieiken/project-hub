'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawn } = require('node:child_process');
const launch = require('../lib/launch');
const { ModelLimits, MODELS } = require('../lib/model-limits');
const { LimitEvidence } = require('../lib/limit-evidence');
const CURRENT = 'claude-fable-5-2', OLD = 'claude-fable-5-1';
const NOW = Date.now(), iso = n => new Date(n).toISOString();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fable52-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'limits.json');
  return { dir, file, limits: new ModelLimits(file, { now: () => NOW }) };
}
function oldHold(model = OLD) {
  return { version: 2, model, source: 'cli-limit', hold: true, at: iso(NOW - 100), lastLimitAt: iso(NOW - 100),
    project: '', task: '', request: '', validUntil: null, untilSource: 'unknown', checkedAt: null };
}
test('Fable52: current launch identity and persisted 5.1 aliases stay distinct without rewriting roles', t => {
  const { dir } = fixture(t), file = path.join(dir, 'roles.yaml');
  const original = fs.readFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), 'utf8')
    .replaceAll('Fable 5.2', 'Fable 5.1');
  fs.writeFileSync(file, original);
  require('../lib/role-history').load(file); // Seed the existing settings journal before testing read-only loading.
  const saved = fs.readFileSync(file, 'utf8');
  const data = require('../lib/roles').read(file).data;
  assert.ok(data.roles.some(r => r.main.model === 'Fable 5.1'));
  for (const [label, id] of [['Fable 5.2', CURRENT], ['Fable 5.1', OLD]]) {
    for (const model of [label, id]) {
      const argv = launch.buildArgv({ ai: 'claude', model, effort: '高', prompt: 'fixture only', cmd: 'fixture' });
      assert.equal(argv.args[argv.args.indexOf('--model') + 1], id);
      assert.equal(launch.modelLabel('claude', id), label);
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});
test('Fable52: 5.1 holds never become the default 5.2 hold, including v1 and contract-only evidence', t => {
  const { file, limits } = fixture(t);
  for (const hold of [oldHold(), { source: 'cli-limit', at: iso(NOW - 200), checkedAt: iso(NOW - 100), validUntil: iso(NOW + 10000) }]) {
    const saved = JSON.stringify({ [OLD]: hold, _discussion: { [OLD]: oldHold() } });
    fs.writeFileSync(file, saved); limits.signature = null;
    assert.equal(limits.active(), null);
    assert.equal(limits.forRequest({ ai: 'claude', model: CURRENT }), null);
    assert.ok(limits.forRequest({ ai: 'claude', model: OLD }));
    assert.equal(limits.active('default', CURRENT, true), null);
    assert.equal(new LimitEvidence(file, { now: () => NOW }).active(), null);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
});
test('Fable52: retired hold is visible and can be cleared through the existing route without clearing 5.2', t => {
  const { file, limits } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ [OLD]: oldHold(), [CURRENT]: oldHold(CURRENT), _discussion: { [OLD]: oldHold() } }));
  assert.deepEqual(new Set(limits.list().map(e => e.model)), new Set([OLD, CURRENT]));
  let status;
  const route = require('../lib/routes/limits')({ limitEvidence: limits, limitModels: () => ({ claude: [...MODELS.claude], codex: [...MODELS.codex] }),
    getDiscussion: () => ({ limitModels: () => ({}) }), usageSelection: () => ({}), accounts: { get() {} },
    usage: { snapshot: () => ({}) }, usageWithLimit: () => ({ limits: limits.list() }), record() {}, lt: s => s,
    send(res, code) { status = code; } }).clear;
  route.handle({ method: 'POST' }, {}, new URL('http://localhost/api/limits/clear'), { ai: 'claude', model: OLD });
  assert.equal(status, 200); assert.equal(limits.active('default', OLD, true), null);
  assert.ok(limits.active());
  assert.ok(JSON.parse(fs.readFileSync(file))._cleared[OLD]);
  limits.clearAccount('claude'); assert.equal(limits.list().length, 0);
});
test('Fable52: fresh exact and family quota evidence creates 5.2 holds; stale and rounded evidence do not', t => {
  const { limits } = fixture(t);
  for (const id of ['model:' + CURRENT, 'model:fable']) {
    for (const [usedPercent, age, expected] of [[99.9999, 0, false], [100, 301000, false], [100, 0, true]]) {
      const state = new ModelLimits(limits.file + id.replaceAll(':', '-') + usedPercent + age, { now: () => NOW });
      state.observe({ providers: { claude: { status: 'ok', attemptedAt: iso(NOW - age), fetchedAt: iso(NOW - age), windows: [
        { id, label: 'Fable・週間枠', usedPercent, resetsAt: iso(NOW + 10000) }
      ] } } });
      assert.equal(!!state.forRequest({ ai: 'claude', model: CURRENT }), expected);
      assert.equal(state.active('default', OLD), null);
    }
  }
});
test('Fable52: usage and model inquiry subprocesses request 5.2, without sending a user turn', async t => {
  const { dir } = fixture(t), cli = path.join(dir, 'fixture-cli'), log = path.join(dir, 'args.json'), input = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(input)},line+'\\n');console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:m.request.subtype==='initialize'?{models:[{value:'${CURRENT}'}]}:{rate_limits:{five_hour:{utilization:20,resets_at:'${iso(NOW + 10000)}'}}}}}));});\n`, { mode: 0o755 });
  const { claudeInitialize } = require('../lib/ai-tools');
  const { readCli } = require('../lib/usage');
  for (const run of [() => claudeInitialize(cli, 3000), () => readCli('claude', cli, { spawn, timeoutMs: 3000 })]) {
    await run();
    const args = JSON.parse(fs.readFileSync(log));
    assert.equal(args[args.indexOf('--model') + 1], CURRENT);
    assert.ok(fs.readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse).every(r => r.type === 'control_request'));
  }
});
test('Fable52: usage renders the current hold in Japanese and translated legacy-display responses', () => {
  for (const language of ['ja', 'en', 'zh-TW']) {
    const el = () => ({ hidden: true, addEventListener() {}, setAttribute() {} });
    const c = vm.createContext({ $: el, esc: String, document: { hidden: false, addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
      matchMedia: () => ({ matches: false, addEventListener() {} }), setInterval() {}, api: () => new Promise(() => {}), console });
    c.HUB_LOCALE = { locale: language, messages: language === 'ja' ? {} : require('../../langpacks/' + language + '/ui.json') };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/locale.js'), 'utf8'), c);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/usage.js'), 'utf8'), c);
    const html = c.usageHtml({ fableLimit: { model: CURRENT, hold: true, until: null } });
    assert.match(html, /Fable 5\.2/); assert.doesNotMatch(html, /Fable 5\.1/);
    assert.match(c.usageHtml({ limits: [{ model: CURRENT, ai: 'claude', account: 'default', hold: true, until: null }] }), /data-limit-model="claude-fable-5-2"/);
  }
});
