'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-path-rule-'));
const root = path.join(tmp, 'root');
Object.assign(process.env, { HUB_ROOT: root, HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home'), HUB_FREETALK_HOME: path.join(tmp, 'freetalk') });
fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
const agy = { id: 'gemini-current-fixture', label: 'Current Gemini fixture' };
fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ agy: { models: [agy] } }));
const store = new (require('../lib/store').Store)(root);
const p = store.createProject({ name: 'Path fixture' }).project;
const t = store.createTask(p.id, { title: 'Path instructions' });
const hub = require('../server'), chat = require('../lib/chat'), instructions = require('../lib/instructions'), launch = require('../lib/launch');
launch.setDiscoveredModels({ agy: { models: [agy] } });
const file = store.taskFile(p.id, t.id);
const rule = '【場所の伝え方】フォルダ・ファイルの場所は省略しない絶対パスで書く（Mac は /Users/ から、Windows は C:\\ など実際のドライブから）。~ や「…」で略さない。1つの場所を独立した1つの ```text 枠に入れ、枠内には場所だけを書く。枠外に貼り先を一言添える（Finder やアプリの「開く」画面用／ブラウザのアドレス欄用／ターミナル用など）。file:// はブラウザのアドレス欄用に限る。フォルダを選ぶ画面用はファイル名を付けずフォルダまでにする。出す前に実在を確かめ、確かめられない時はそう書く。';
const count = (text, part) => String(text).split(part).length - 1;
const models = { claude: 'Fable 5.2', codex: 'GPT-6.1-Sol', agy: agy.label, grok: 'grok-current-fixture' };
// These are the actual CLI input channels; no CLI is executed.
function input(turn, ai) {
  return ai === 'agy' ? turn.args.find(a => a.startsWith('--print=')).slice('--print='.length)
    : ai === 'grok' ? turn.args[turn.args.indexOf('-p') + 1] : turn.stdin;
}
function once(text, expected = rule) {
  assert.equal(count(text, expected), 1);
  assert.equal(count(text, instructions.SEND_TEXT_RULE), 1);
}
const captures = {};
test.after(async () => {
  if (process.env.HUB_PATH_RULE_CAPTURE) {
    fs.mkdirSync(process.env.HUB_PATH_RULE_CAPTURE, { recursive: true });
    fs.writeFileSync(path.join(process.env.HUB_PATH_RULE_CAPTURE, 'prompt-readback.json'), JSON.stringify(captures, null, 2) + '\n');
  }
  hub.stopControl.cleanExit();
  await new Promise(r => hub.server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('path rule: six requirements, full rules section, and both rule versions change', () => {
  assert.equal(instructions.PATH_RULE, rule);
  const base = hub.taskPrompt(p, t, file, p.dir);
  const full = fs.readFileSync(path.join(p.dir, '.ai/chat', t.id + '.rules.md'), 'utf8');
  once(full); once(base);
  assert.match(full, /## 人がコピーする文と場所\n\n/);
  const fullHash = require('node:crypto').createHash('sha256').update(full).digest('hex').slice(0, 12);
  assert.ok(base.includes('全文版：' + fullHash));
  const oldHash = require('node:crypto').createHash('sha256').update(full.replace('\n\n' + rule, '')).digest('hex').slice(0, 12);
  assert.notEqual(fullHash, oldHash);
  const old = instructions.select(base.replace('\n' + rule, ''), { ai: 'claude', sid: 'sid', meta: {}, resume: false });
  const updated = instructions.select(base, { ai: 'claude', sid: 'sid', meta: { rulesSent: { claude: old.rules } }, resume: true });
  assert.equal(updated.short, false); assert.notEqual(updated.rules.hash, old.rules.hash);
  captures.full = full;
});

for (const [ai, model] of Object.entries(models)) {
  test('path rule: ' + ai + ' conversation, short resumed input, and terminal input each contain one rule', () => {
    const basePrompt = hub.taskPrompt(p, t, file, p.dir);
    const opts = { ai, model, rows: [], text: 'fixture request', basePrompt, meta: {} };
    const first = chat.buildTurn(opts); once(input(first, ai));
    const meta = { sessions: { [ai]: 'sid' }, models: { [ai]: model }, rulesSent: { [ai]: { ...first.rules, sid: 'sid' } } };
    const resumed = chat.buildTurn({ ...opts, meta });
    assert.equal(resumed.shortRules, true); once(input(resumed, ai));
    const prompt = hub.taskPrompt(p, t, file, p.dir, 'terminal', { ai, model }); once(prompt);
    const argv = launch.buildArgv({ ai, model, prompt, cmd: 'fixture-cli' });
    assert.ok(argv.args.includes(prompt) || argv.args.includes('--prompt-interactive=' + prompt));
    const command = launch.buildCommand({ ai, model, prompt, dir: p.dir, cmd: 'fixture-cli' });
    assert.ok(command.includes(launch.sq(ai === 'agy' ? '--prompt-interactive=' + prompt : prompt)));
    captures[ai] = { conversation: input(first, ai), resumed: input(resumed, ai), terminal: prompt, terminalArgv: argv, terminalCommand: command };
  });
}

test('path rule: freetalk first and resumed turns receive the rule for every AI', () => {
  const fp = { ...p, id: 'freetalk-fixture', kind: 'freetalk' };
  // Request delivery uses modelPolicy as the resumed freetalk prefix.
  const basePrompt = hub.taskPrompt(fp, t, file, p.dir);
  const policyEnd = basePrompt.indexOf('\n\n自由対話「');
  assert.ok(policyEnd > 0);
  const policy = basePrompt.slice(0, policyEnd); // modelPolicy output before freetalk.prompt
  for (const [ai, model] of Object.entries(models)) {
    const opts = { ai, model, rows: [], text: 'fixture request', basePrompt, policy, meta: {} };
    const first = chat.buildTurn(opts); once(input(first, ai));
    const resumed = chat.buildTurn({ ...opts, meta: { sessions: { [ai]: 'sid' }, models: { [ai]: model } } });
    assert.equal(resumed.resume, true); once(input(resumed, ai));
    captures[ai].freetalk = input(first, ai); captures[ai].freetalkResumed = input(resumed, ai);
  }
});

test('path rule: text-only webchat receives the rule once without claiming file access', () => {
  const prompt = hub.webchat.prompt({}, { recentHistory: [] });
  once(prompt); assert.ok(prompt.includes('You have NO tools'));
  captures.webchat = prompt;
});

for (const lang of ['en', 'zh-TW']) test('path rule: ' + lang + ' has the same copy contract and matching size baseline', () => {
  const messages = require('../../langpacks/' + lang + '/backend.json').messages;
  const expected = messages[rule]; assert.ok(expected); assert.notEqual(expected, rule);
  const script = `const i=require('./lib/instructions'),fs=require('node:fs');const prefix=i.packet({pdir:process.env.HUB_ROOT,task:'locale',policy:'policy',issues:'',common:'',port:1});const first=i.select(prefix,{ai:'codex',sid:'s',meta:{},resume:false});const short=i.select(prefix,{ai:'codex',sid:'s',meta:{rulesSent:{codex:first.rules}},resume:true});console.log(JSON.stringify({rule:i.PATH_RULE,send:i.SEND_TEXT_RULE,prefix,short:short.prefix,full:fs.readFileSync(process.env.HUB_ROOT+'/.ai/chat/locale.rules.md','utf8')}));`;
  const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, HUB_LANG: lang, HUB_ROOT: path.join(tmp, lang) },
  }));
  assert.equal(actual.rule, expected);
  assert.equal(require('./fixtures/instruction-baseline.json').pathRuleChars[lang], actual.rule.length);
  for (const text of [actual.prefix, actual.short, actual.full]) {
    assert.equal(count(text, expected), 1); assert.equal(count(text, actual.send), 1);
    assert.equal(count(text, rule), 0);
  }
  for (const literal of ['/Users/', 'C:\\', '~', '```text', 'file://']) assert.ok(expected.includes(literal));
  assert.ok(actual.full.includes(messages['## 人がコピーする文と場所']));
  captures[lang] = actual;
});
