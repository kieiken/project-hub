'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launch = require('../lib/launch');
const chat = require('../lib/chat');
const roles = require('../lib/roles');
const { AiTools, agyModels } = require('../lib/ai-tools');
const model = launch.AGY_MODEL;
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agy-'));

test('Agy pins the approved model in interactive, print and resume commands', () => {
  const prompt = 'quoted "text"; $(never-run)';
  const argv = launch.buildArgv({ ai: 'agy', prompt });
  assert.deepEqual(argv.args.slice(-3), ['--model', model.id, '--prompt-interactive=' + prompt]);
  const shell = launch.buildCommand({ ai: 'agy', dir: '/tmp/a b', prompt });
  assert.ok(shell.includes("env '-u' 'GEMINI_API_KEY'"));
  assert.ok(shell.includes(model.id));
  for (const resume of [false, true]) {
    const turn = chat.buildTurn({ ai: 'agy', model: model.label, effort: 'Ultra',
      meta: resume ? { sessions: { agy: 'sid' }, models: { agy: model.label } } : {},
      rows: [], text: prompt, basePrompt: 'base', policy: 'policy' });
    assert.equal(turn.resume, resume);
    assert.ok(turn.args.includes(model.id));
    assert.equal(turn.args.includes('--conversation'), resume);
    assert.ok(turn.args.find(x => x.startsWith('--print=')).includes(prompt));
    assert.equal(turn.stdin, '');
    assert.ok(!turn.args.includes('--effort'));
  }
  launch.setOverrides({ agy: { [model.label]: 'claude-opus-4-6' } });
  assert.equal(launch.flagFor('agy', model.label), model.id);
  assert.throws(() => launch.buildArgv({ ai: 'agy', model: 'other' }));
  assert.equal(launch.switchCommand('agy', 'model', model.label), '');
  launch.setOverrides({});
});

test('Agy parsing preserves text deltas, failure and model mismatch', () => {
  assert.deepEqual(chat.parse('agy', { event: 'init', conversation_id: 'sid', init: { model: model.id } }), [{ kind: 'session', id: 'sid' }]);
  assert.equal(chat.parse('agy', { event: 'init', init: { model: 'other' } })[0].abort, true);
  assert.deepEqual(chat.parse('agy', { event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'ignore' } }), []);
  assert.deepEqual(chat.parse('agy', { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello' } }), [{ kind: 'text', text: 'hello' }]);
  assert.equal(chat.parse('agy', { event: 'result', result: { status: 'ERROR', error: { message: 'failure' } } })[0].error, 'failure');
});

test('Agy removes API credentials and rejects an API provider without editing preferences', () => {
  const env = { PATH: '/bin', GEMINI_API_KEY: 'secret', GOOGLE_API_KEY: 'secret', OPENAI_API_KEY: 'secret' };
  assert.deepEqual(launch.childEnv('agy', env), { PATH: '/bin' });
  assert.deepEqual(launch.childEnv('codex', env), env);
  const root = fixture();
  try {
    const file = path.join(root, '.gemini/antigravity-cli/settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assert.equal(launch.agyAccountError(root), '');
    const text = '{"modelProvider":"gemini"}';
    fs.writeFileSync(file, text);
    assert.ok(launch.agyAccountError(root));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Agy catalogue exposes only the approved model and disables it on explicit removal', async () => {
  const root = fixture();
  try {
    let output = 'Fetching...\nother\tOther\n' + model.id + '\tGemini 3.1 Pro (High)\nclaude-opus-4-6-thinking\tOld';
    assert.deepEqual(agyModels(output), [model]);
    const tools = new AiTools({ root, home: root, find: ai => ai === 'agy' ? '/fixture/agy' : '', run: async () => output });
    assert.deepEqual(tools.catalog().agy.models, []);
    await tools.refresh('agy');
    roles.setModelCatalog(tools.catalog());
    const raw = { models: { codex: ['GPT-6.1-Sol'] }, roles: { code: { main: ['codex', 'GPT-6.1-Sol', '高'] } } };
    const data = roles.normalize(raw);
    assert.deepEqual(data.models.agy, [model.label]);
    assert.equal(data.roles[0].main.ai, 'codex');
    output = 'other\tOther';
    const result = await tools.refresh('agy');
    assert.equal(result.unavailable, true);
    assert.deepEqual(tools.catalog().agy.models, []);
    const restarted = new AiTools({ root, home: root, dry: true });
    assert.deepEqual(restarted.catalog().agy.models, []);
    assert.equal(restarted.staleModel('agy', model.label), true);
  } finally { roles.setModelCatalog({}); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Agy runner joins deltas, handles a final line without newline and resumes its own ID', async () => {
  const root = fixture();
  try {
    const executable = path.join(root, 'agy-fixture');
    fs.writeFileSync(executable, `#!${process.execPath}
const events = [
  {event:'init',conversation_id:'agy-session',init:{model:'${model.id}'}},
  {event:'step_update',step_update:{step_type:'agent_response',text_delta:'hello'}},
  {event:'step_update',step_update:{step_type:'agent_response',text_delta:' world'}},
  {event:'result',result:{status:'SUCCESS',response:'hello world'}}
];
if(process.env.GEMINI_API_KEY)process.exit(3);
process.stdout.write(events.map(x=>JSON.stringify(x)).join('\\n'));
`, { mode: 0o755 });
    const runner = new chat.ChatRunner();
    const opts = { project: 'p', task: 't', pdir: root, dir: root, ai: 'agy', model: model.label,
      text: 'check', perm: './agy-fixture', env: { GEMINI_API_KEY: 'fixture-secret' } };
    const run = () => new Promise(resolve => runner.send({ ...opts, onEnd: resolve }));
    const first = await run();
    assert.equal(first.text, 'hello world');
    assert.equal(first.error, '');
    assert.equal(chat.readMeta(root, 't').sessions.agy, 'agy-session');
    const second = await run();
    assert.equal(second.error, '');
    assert.equal(chat.read(root, 't').filter(r => r.role === 'assistant').length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Agy runner stops a mismatched model without displaying or persisting its output', async () => {
  const root = fixture();
  try {
    const executable = path.join(root, 'agy-wrong');
    fs.writeFileSync(executable, `#!${process.execPath}
console.log(JSON.stringify({event:'init',conversation_id:'wrong',init:{model:'other'}}));
console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'unsafe-output'}}));
setInterval(()=>{},1000);
`, { mode: 0o755 });
    const runner = new chat.ChatRunner();
    const row = await new Promise(resolve => runner.send({ project: 'p', task: 't', pdir: root, dir: root,
      ai: 'agy', model: model.label, text: 'check', perm: './agy-wrong', onEnd: resolve }));
    assert.ok(row.error);
    assert.equal(row.text, '');
    assert.equal(chat.readMeta(root, 't').sessions.agy, undefined);
    assert.equal(runner.busy('p', 't'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Gemini role validation pins model and high effort, saves only roles and templates follow assignments', () => {
  roles.setModelCatalog({agy:{models:[model]}}); const root = fixture();
  try {
    const file = path.join(root, 'roles.yaml'), before = 'models:\n  codex: [GPT-6.1-Sol]\nroles:\n  チェック: { main: [codex, GPT-6.1-Sol, 高], backup: [人] }\nswitch:\n  auto: true\n';
    fs.writeFileSync(file,before); const data = roles.read(file).data;
    data.roles[0].main = {ai:'agy',model:model.label,effort:'高'};
    assert.equal(roles.write(file,data.roles).ok,true);
    assert.equal(roles.read(file).data.roles[0].main.ai,'agy'); assert.ok(fs.readFileSync(file,'utf8').endsWith('switch:\n  auto: true\n'));
    for (const slot of [{ai:'agy',model:model.label,effort:'MAX'},{ai:'agy',model:'other',effort:'高'},{ai:'chatgpt',model:model.label,effort:'高'}]) {
      assert.ok(roles.validate({...data.models,agy:[model.label,'other']},[{...data.roles[0],main:slot}]).length);
    }
    const instructions = require('../lib/instructions');
    assert.match(instructions.templates({roles:[...data.roles,{name:'コーディング',main:{ai:'agy',model:model.label,effort:'高'}}]}), /agy・gemini-3.1-pro-high/);
    const defaults={roles:[{name:'チェック',main:{ai:'claude-code',model:'Fable 5.1'}},{name:'コーディング',main:{ai:'codex',model:'GPT-6.1-Sol'}}]};
    assert.equal(instructions.templates(defaults),instructions.TEMPLATES);
  } finally { roles.setModelCatalog({}); fs.rmSync(root,{recursive:true,force:true}); }
});
