'use strict';
const AGY_FIXTURE = { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' };
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
const model = AGY_FIXTURE;
test.beforeEach(() => launch.setDiscoveredModels({agy:{models:[model],known:[model]}}));
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agy-'));

test('Agy passes an explicitly selected model in interactive, print and resume commands', () => {
  const prompt = 'quoted "text"; $(never-run)';
  const argv = launch.buildArgv({ ai: 'agy', model:model.id, prompt });
  assert.deepEqual(argv.args.slice(-3), ['--model', model.id, '--prompt-interactive=' + prompt]);
  const shell = launch.buildCommand({ ai: 'agy', dir: '/tmp/a b', model:model.id, prompt });
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
  assert.deepEqual(chat.parse('agy', { event: 'init', conversation_id: 'sid', init: { model: model.id } }, model.id), [{ kind: 'session', id: 'sid' }]);
  assert.equal(chat.parse('agy', { event: 'init', init: { model: 'other' } }, model.id)[0].abort, true);
  assert.deepEqual(chat.parse('agy', { event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'ignore' } }), []);
  assert.deepEqual(chat.parse('agy', { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello' } }), [{ kind: 'text', text: 'hello' }]);
  assert.equal(chat.parse('agy', { event: 'result', result: { status: 'ERROR', error: { message: 'failure' } } })[0].error, 'failure');
});

test('Agy resolves current IDs before historical labels when a name is reused', () => {
  const current = { id: 'gemini-current', label: model.label };
  launch.setDiscoveredModels({ agy: { models: [current], known: [current] } });
  assert.equal(launch.flagFor('agy', current.label), current.id);
  assert.equal(launch.buildArgv({ ai: 'agy', model: current.id }).args[2], current.id);
  assert.throws(() => launch.buildArgv({ ai: 'agy', model: model.id }));
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

test('Agy keeps every observed model and does not replace a removed selection', async () => {
  const root = fixture(), other={id:'gemini-current',label:'Current Gemini'};
  try {
    let output = model.id+'\t'+model.label+'\n'+other.id+'\t'+other.label;
    assert.deepEqual(agyModels(output), [model,other]);
    const tools = new AiTools({ root, home: root, find: () => '/fixture/agy', run: async () => output });
    await tools.refresh('agy');
    const raw={roles:{code:{main:['agy',model.label,'高'],backup:['人']}}};
    output=other.id+'\t'+other.label;
    await tools.refresh('agy'); roles.setModelCatalog(tools.catalog());launch.setDiscoveredModels(tools.catalog());
    assert.deepEqual(tools.catalog().agy.models,[other]);assert.equal(tools.staleModel('agy',model.id),true);
    assert.throws(()=>launch.buildArgv({ai:'agy',model:model.id}));
    assert.throws(()=>launch.buildArgv({ai:'agy'}));
    const data=roles.normalize(raw);assert.equal(data.roles[0].main.model,model.label);
    assert.ok(data.models.agy.includes(other.label));
    assert.equal(launch.buildArgv({ai:'agy',model:other.id}).args[2],other.id);
    assert.deepEqual(new AiTools({root,home:root,dry:true}).catalog().agy.models,[other]);
    output='unknown response';await assert.rejects(tools.refresh('agy'));
    assert.equal(tools.catalog().agy.state,'failed');assert.deepEqual(tools.catalog().agy.models,[other]);
    output='';await tools.refresh('agy');assert.equal(tools.catalog().agy.state,'empty');assert.deepEqual(tools.catalog().agy.models,[]);
    assert.throws(()=>agyModels('bad;id\tBad'));
    assert.equal(agyModels('safe\t<script>')[0].label,'<script>');
  } finally {roles.setModelCatalog({});fs.rmSync(root,{recursive:true,force:true});}
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
    assert.equal(roles.read(file).data.roles[0].main.ai,'agy'); assert.match(fs.readFileSync(file,'utf8'), /^switch:\n  auto: true\n/m);
    for (const slot of [{ai:'agy',model:model.label,effort:'MAX'},{ai:'agy',model:'other',effort:'高'},{ai:'chatgpt',model:model.label,effort:'高'}]) {
      assert.ok(roles.validate({...data.models,agy:[model.label,'other']},[{...data.roles[0],main:slot}]).length);
    }
    const instructions = require('../lib/instructions');
    assert.match(instructions.templates({roles:[...data.roles,{name:'コーディング',main:{ai:'agy',model:model.label,effort:'高'}}]}), /agy・gemini-3.1-pro-high/);
    const defaults={roles:[{name:'チェック',main:{ai:'claude-code',model:'Fable 5.2'}},{name:'コーディング',main:{ai:'codex',model:'GPT-6.1-Sol'}}]};
    assert.equal(instructions.templates(defaults),instructions.TEMPLATES);
  } finally { roles.setModelCatalog({}); fs.rmSync(root,{recursive:true,force:true}); }
});
