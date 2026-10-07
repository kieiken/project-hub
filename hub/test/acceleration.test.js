'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Acceleration } = require('../lib/acceleration');
const { Accounts } = require('../lib/accounts');
const launch = require('../lib/launch');
const chat = require('../lib/chat');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acceleration-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '_hub', 'acceleration.json');
}
test('加速は既定OFF、保存後に再読み込みしてON/OFFを保持する', t => {
  const file = fixture(t), settings = new Acceleration(file);
  assert.deepEqual(settings.settings(), { codexAllowed: false });
  assert.equal(fs.existsSync(file), false);
  for (const on of [true, false]) {
    settings.save({ codexAllowed: on });
    assert.deepEqual(new Acceleration(file).settings(), { codexAllowed: on });
    const copy = settings.settings(); copy.codexAllowed = !on;
    assert.equal(settings.settings().codexAllowed, on);
  }
});
test('不正な入力では保存しない。壊れた設定や文字列trueもONにしない', t => {
  const file = fixture(t), settings = new Acceleration(file);
  for (const body of [null, {}, [], { codexAllowed: 'true' }, { codexAllowed: 1 }, { codexAllowed: true, claudeFast: true }]) {
    assert.throws(() => settings.save(body), { status: 400 });
  }
  assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(path.dirname(file));
  for (const raw of ['{bad', '{"codexAllowed":"true"}', 'null']) {
    fs.writeFileSync(file, raw);
    assert.equal(new Acceleration(file).settings().codexAllowed, false);
  }
});
test('保存失敗で直前の設定とファイルを保持し、一時ファイルを残さない', t => {
  const file = fixture(t), settings = new Acceleration(file);
  settings.save({ codexAllowed: true });
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Error('fixture: save failed'); });
  assert.throws(() => settings.save({ codexAllowed: false }), /save failed/);
  assert.equal(settings.settings().codexAllowed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['acceleration.json']);
});
test('旧FastのONは利用許可にだけ移行し、新キーのOFFを優先する', t => {
  const file = fixture(t); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ codexFast: true }));
  const settings = new Acceleration(file);
  assert.deepEqual(settings.settings(), { codexAllowed: true });
  assert.throws(() => settings.save({ codexFast: true }), { status: 400 });
  settings.save({ codexAllowed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { codexAllowed: true });
  fs.writeFileSync(file, JSON.stringify({ codexAllowed: false, codexFast: true }));
  assert.equal(new Acceleration(file).settings().codexAllowed, false);
  assert.ok(!launch.buildArgv({ ai: 'codex', model: 'GPT-6.1-Sol' }).args.includes('service_tier="fast"'));
  for (const fast of [undefined, false, 'true', 1]) assert.deepEqual(launch.accelerationArgs('codex', fast), []);
});
test('Codex新規・再開・ターミナル・外部Terminalの次回起動にだけFastを付ける', t => {
  const opts = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', prompt: 'hello' };
  for (const on of [false, true, false]) {
    const argv = launch.buildArgv({ ...opts, fast: on }), shell = launch.buildCommand({ ...opts, fast: on, dir: '/fixture' });
    assert.equal(argv.args.includes('service_tier="fast"'), on);
    assert.equal(shell.includes("'-c' 'service_tier=\"fast\"'"), on);
    assert.equal(argv.args.some(a => a.startsWith('service_tier=')), on);
    for (const resume of [false, true]) {
      const turn = chat.buildTurn({ ...opts, fast: on, meta: resume ? { sessions: { codex: 'sid' }, models: { codex: opts.model } } : {}, rows: [], text: 'hello' });
      assert.equal(turn.resume, resume);
      assert.equal(turn.args.filter(a => a === 'service_tier="fast"').length, on ? 1 : 0);
      if (on && resume) assert.ok(turn.args.indexOf('service_tier="fast"') < turn.args.indexOf('resume'));
      assert.equal(turn.stdin.includes('加速ON（Fast）'), on);
      assert.ok(turn.args.includes('gpt-6.1-sol'));
      assert.ok(turn.args.includes('model_reasoning_effort=high'));
    }
  }
});
test('加速ONでもClaudeとAgyの新規・再開・ターミナル引数と起動情報を変えない', t => {
  for (const [ai, model] of [['claude', 'Opus 5.5'], ['agy', 'Gemini 3.1 Pro (High)']]) {
    const opts = { ai, model, prompt: 'hello', effort: '高' };
    const argv = launch.buildArgv(opts), info = launch.startupInfo(ai, model);
    const shell = launch.buildCommand({ ...opts, dir: '/fixture' });
    assert.deepEqual(launch.buildArgv({ ...opts, fast: true }), argv);
    assert.equal(launch.startupInfo(ai, model, undefined, true), info);
    assert.equal(launch.buildCommand({ ...opts, fast: true, dir: '/fixture' }), shell);
    for (const resume of [false, true]) {
      const turn = chat.buildTurn({ ...opts, fast: true, meta: resume ? { sessions: { [ai]: 'sid' }, models: { [ai]: model } } : {}, rows: [], text: 'hello' });
      assert.ok(!turn.args.some(a => a.includes('service_tier')));
      assert.ok(!JSON.stringify(turn).includes('加速ON'));
    }
  }
});

for (const named of [false, true]) for (const on of [false, true]) {
  test(`Fast ${on ? 'ON' : 'OFF'}と${named ? '追加' : '既定'}Codexの認証分離・再開を全起動経路で保持する`, t => {
    const file = fixture(t), home = path.join(path.dirname(file), 'home');
    fs.mkdirSync(home, { recursive: true });
    const accounts = new Accounts({ file, home, trash: path.join(home, 'trash') });
    const profile = accounts.add('codex', 'fixture'), account = named ? profile.id : 'default';
    launch.setAccounts(accounts);
    t.after(() => launch.setAccounts(null));
    const opts = { ai: 'codex', fast: on, account, model: 'GPT-6.1-Sol', effort: '高', prompt: 'hello' };
    const env = { CODEX_HOME: '/fixture-existing', OPENAI_API_KEY: 'fixture-key', LANG: 'ja_JP.UTF-8' };
    const isolated = launch.accountEnv('codex', account, env);
    assert.equal(isolated.CODEX_HOME, named ? profile.dir : env.CODEX_HOME);
    assert.equal(isolated.OPENAI_API_KEY, named ? undefined : env.OPENAI_API_KEY);
    assert.equal(isolated.LANG, env.LANG);
    const argv = launch.buildArgv(opts), shell = launch.buildCommand({ ...opts, dir: home });
    const auth = ['cli_auth_credentials_store="file"', 'model_provider="openai"'];
    for (const arg of ['service_tier="fast"', ...auth]) {
      const wanted = arg.startsWith('service_tier') ? on : named;
      assert.equal(argv.args.filter(a => a === arg).length, wanted ? 1 : 0);
      assert.equal(shell.includes(launch.sq(arg)), wanted);
    }
    assert.equal(shell.includes(launch.sq('CODEX_HOME=' + profile.dir)), named);
    assert.equal(shell.includes("'-u' 'OPENAI_API_KEY'"), named);
    for (const sessionAccount of ['default', profile.id]) {
      const turn = chat.buildTurn({ ...opts, meta: { sessions: { codex: 'sid' }, models: { codex: opts.model }, sessionAccounts: { codex: sessionAccount } }, rows: [], text: 'hello' });
      assert.equal(turn.resume, sessionAccount === account);
      assert.equal(turn.args.includes('resume'), turn.resume);
      assert.equal(turn.args.includes('sid'), turn.resume);
      for (const arg of ['service_tier="fast"', ...auth]) {
        assert.equal(turn.args.filter(a => a === arg).length, (arg.startsWith('service_tier') ? on : named) ? 1 : 0);
        if (turn.resume && turn.args.includes(arg)) assert.ok(turn.args.indexOf(arg) < turn.args.indexOf('resume'));
      }
      assert.equal(turn.stdin.includes('加速ON（Fast）'), on);
    }
  });
}
