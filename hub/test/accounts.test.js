'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Accounts } = require('../lib/accounts');
const launch = require('../lib/launch'), chat = require('../lib/chat');
const { Usage } = require('../lib/usage'), { Sessions } = require('../lib/sessions');
const { LimitEvidence } = require('../lib/limit-evidence');
const claudeAuth = Object.fromEntries([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH', 'CLAUDE_BG_SOCKET_TOKENS_PATH',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_BRIDGE_OAUTH_TOKEN', 'AGENT_PROXY_AUTH_TOKEN', 'ANTHROPIC_UNIX_SOCKET',
].map(k => [k, 'fixture-only']));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-accounts-')));
let n = 0;
function fixture(options = {}) {
  const root = path.join(tmp, String(++n)), home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return new Accounts({ file: path.join(root, 'registry/accounts.json'), home, trash: path.join(root, 'trash'), ...options });
}
test.after(() => { launch.setAccounts(null); fs.rmSync(tmp, { recursive: true, force: true }); });
test('default preserves every inherited variable and creates no credentials or profile', () => {
  const a = fixture(), env = { CODEX_HOME: '/existing', ANTHROPIC_API_KEY: 'SECRET', OTHER: 'x' };
  assert.deepEqual(a.env('codex', 'default', env), env);
  assert.deepEqual(a.env('claude', 'default', env), env);
  assert.equal(a.list().length, 4); assert.equal(fs.existsSync(a.base), false);
  assert.equal(a.get('agy').id, 'default'); assert.throws(() => a.add('agy', 'other'));
});
test('profiles and registry are private, preferences copied without authentication/provider/hooks', () => {
  const a = fixture();
  for (const ai of ['claude', 'codex']) fs.mkdirSync(path.join(a.home, '.' + ai));
  fs.writeFileSync(path.join(a.home, '.claude/settings.json'), JSON.stringify({ language: 'japanese', permissions: { allow: ['Read'] }, env: { ANTHROPIC_API_KEY: 'SECRET' }, hooks: { Stop: 'SECRET' }, apiKeyHelper: 'SECRET' }));
  fs.writeFileSync(path.join(a.home, '.claude/.credentials.json'), 'SECRET');
  fs.writeFileSync(path.join(a.home, '.claude/CLAUDE.md'), 'keep guidance');
  fs.writeFileSync(path.join(a.home, '.codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_provider="secret"\ncli_auth_credentials_store="keyring"\n[model_providers.secret]\nenv_key="SECRET"\n');
  fs.writeFileSync(path.join(a.home, '.codex/auth.json'), 'SECRET');
  const c = a.add('claude', '仕事'), x = a.add('codex', '個人');
  for (const r of [c, x]) assert.equal(fs.statSync(r.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(a.file, 'utf8'), /SECRET/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.dir, 'settings.json'))), { language: 'japanese', permissions: { allow: ['Read'] } });
  assert.equal(fs.readFileSync(path.join(c.dir, 'CLAUDE.md'), 'utf8'), 'keep guidance');
  assert.equal(fs.existsSync(path.join(c.dir, '.credentials.json')), false);
  assert.equal(fs.existsSync(path.join(x.dir, 'auth.json')), false);
  const config = fs.readFileSync(path.join(x.dir, 'config.toml'), 'utf8');
  assert.match(config, /cli_auth_credentials_store = "file"/); assert.doesNotMatch(config, /SECRET|secret|keyring/);
  a.rename('codex', x.id, '新しい名前'); assert.equal(a.get('codex', x.id).name, '新しい名前');
  assert.throws(() => a.rename('claude', 'default', 'new')); assert.throws(() => a.add('claude', '\n'));
});
test('failed addition cleans only its incomplete profile and leaves registry unchanged', () => {
  const a = fixture(); fs.mkdirSync(path.join(a.home, '.claude')); fs.writeFileSync(path.join(a.home, '.claude/settings.json'), '{invalid');
  assert.throws(() => a.add('claude', 'broken'));
  assert.deepEqual(fs.readdirSync(path.join(a.base, 'claude')), []); assert.equal(a.list().length, 4);
});
test('malformed registry, traversal and symlink profiles fail closed', () => {
  const a = fixture(), c = a.add('claude', 'one');
  assert.throws(() => a.get('claude', '../one'));
  fs.renameSync(c.dir, c.dir + '-moved'); fs.symlinkSync(c.dir + '-moved', c.dir);
  assert.throws(() => a.env('claude', c.id), /リンク/);
  fs.writeFileSync(a.file, JSON.stringify({ accounts: [{ ...c, dir: '/somewhere' }] }));
  assert.throws(() => a.list(), /台帳/);
});
test('named launches isolate homes, strip metered API variables and force Codex file/OpenAI settings', () => {
  const a = fixture(), c = a.add('claude', 'one'), x = a.add('codex', 'two'); launch.setAccounts(a);
  const env = { ANTHROPIC_API_KEY: 'SECRET', OPENAI_ORG_ID: 'SECRET', CLAUDE_CODE_USE_VERTEX: '1', CODEX_API_KEY: 'SECRET', PATH: process.env.PATH };
  for (const [ai, r, key] of [['claude', c, 'CLAUDE_CONFIG_DIR'], ['codex', x, 'CODEX_HOME']]) {
    const e = launch.accountEnv(ai, r.id, env); assert.equal(e[key], r.dir); assert.equal(e.PATH, env.PATH); assert.doesNotMatch(JSON.stringify(e), /SECRET/);
    const shell = launch.buildCommand({ ai, dir: tmp, prompt: 'hello', model: ai === 'codex' ? 'GPT-6.1-Sol' : 'Opus 5.5', account: r.id });
    assert.match(shell, new RegExp(key + '=')); assert.match(shell, /env /); assert.match(shell, /'-u' 'OPENAI_API_KEY'/);
    if (ai === 'codex') assert.ok(launch.buildArgv({ ai, model: 'GPT-6.1-Sol', account: r.id }).args.includes('cli_auth_credentials_store="file"'));
  }
  assert.equal(launch.accountShell('codex'), ''); assert.deepEqual(launch.accountArgs('codex'), []);
});
test('Claude auth overrides are absent from added profiles and preserved for default', () => {
  const a = fixture(), c = a.add('claude', 'separate'); launch.setAccounts(a);
  const env = { ...claudeAuth, PATH: process.env.PATH, LANG: 'ja_JP.UTF-8', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000' };
  const isolated = launch.accountEnv('claude', c.id, env);
  for (const key of Object.keys(claudeAuth)) assert.equal(isolated[key], undefined, key);
  assert.equal(isolated.CLAUDE_CONFIG_DIR, c.dir); assert.equal(isolated.LANG, env.LANG);
  assert.equal(isolated.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '1000');
  assert.deepEqual(launch.accountEnv('claude', 'default', env), env);
});
test('external work/login shells strip auth inputs existing only in Terminal and retain default', () => {
  const a = fixture(), c = a.add('claude', 'separate'); launch.setAccounts(a);
  // This harmless command replaces a CLI; the fake Terminal env is not process.env.
  const inspect = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'].map(launch.sq).join(' ');
  const terminalEnv = { ...claudeAuth, PATH: process.env.PATH, KEEP_ACCOUNT_TEST: 'yes' };
  for (const action of ['work', 'login']) {
    const shell = action === 'work' ? launch.buildCommand({ ai: 'claude', account: c.id, dir: tmp, cmd: inspect, prompt: '' }) : launch.accountShell('claude', c.id) + inspect;
    const env = JSON.parse(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], { env: terminalEnv, encoding: 'utf8' }));
    for (const key of Object.keys(claudeAuth)) assert.equal(env[key], undefined, `${action}: ${key}`);
    assert.equal(env.CLAUDE_CONFIG_DIR, c.dir); assert.equal(env.KEEP_ACCOUNT_TEST, 'yes');
  }
  const env = JSON.parse(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', launch.accountShell('claude') + inspect], { env: terminalEnv, encoding: 'utf8' }));
  for (const key of Object.keys(claudeAuth)) assert.equal(env[key], claudeAuth[key]);
});
test('Claude status/login/logout and PTY use the common authentication isolation', async () => {
  const captures = [], a = fixture({ execute: async (_file, _args, env) => { captures.push(env); return { stdout: '{"loggedIn":false}', stderr: '' }; } });
  const c = a.add('claude', 'separate'); launch.setAccounts(a);
  const previous = Object.fromEntries(Object.keys(claudeAuth).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, claudeAuth);
    for (const action of ['login', 'status', 'logout']) {
      const command = a.command('claude', c.id, action);
      for (const key of Object.keys(claudeAuth)) assert.equal(command.env[key], undefined, `${action}: ${key}`);
    }
    await a.status('claude', c.id); await a.logout('claude', c.id);
    const s = new Sessions({ pty: { spawn(_file, _args, opts) { captures.push(opts.env); return { onData() {}, onExit() {}, kill() {} }; } } });
    s.start({ project: 'p', task: 'auth', ai: 'claude', account: c.id, dir: tmp, command: '/bin/bash', args: [] });
    assert.equal(captures.length, 3);
    for (const env of captures) { for (const key of Object.keys(claudeAuth)) assert.equal(env[key], undefined, key); assert.equal(env.CLAUDE_CONFIG_DIR, c.dir); }
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test('status exposes only login/email; login command preserves default credential storage', async () => {
  const replies = [{ stdout: '{"loggedIn":true,"email":"a@example.test","token":"SECRET"}' }, { stdout: 'Logged in using ChatGPT', stderr: 'SECRET' }, { stdout: 'SECRET' }];
  const a = fixture({ execute: async () => replies.shift() });
  assert.deepEqual(await a.status('claude', 'default'), { status: 'logged-in', email: 'a@example.test' });
  assert.deepEqual(await a.status('codex', 'default'), { status: 'logged-in' });
  assert.doesNotMatch(JSON.stringify(await a.status('claude', 'default')), /SECRET/);
  const x = a.add('codex', 'one');
  assert.deepEqual(a.command('codex', 'default', 'login').args, ['login', '--device-auth']);
  assert.ok(a.command('codex', x.id, 'status').args.includes('cli_auth_credentials_store="file"'));
});
test('busy, default confirmation and an in-progress logout protect both auth and starts', async () => {
  let busy = true, resolve, calls = 0;
  const a = fixture({ busy: () => busy, execute: () => { calls++; return new Promise(r => { resolve = r; }); } }), x = a.add('codex', 'one');
  await assert.rejects(a.logout('codex', x.id), /作業中/); assert.throws(() => a.remove('codex', x.id), /作業中/); assert.equal(calls, 0);
  busy = false; await assert.rejects(a.logout('codex', 'default', false), /もう一度/);
  const pending = a.logout('codex', x.id); assert.equal(calls, 1);
  assert.throws(() => a.available('codex', x.id), /処理中/); assert.throws(() => a.remove('codex', x.id), /処理中/);
  resolve({}); await pending; a.available('codex', x.id);
});
test('a pending login-status read prevents logout and deletion until it finishes', async () => {
  let resolve;
  const a = fixture({ execute: () => new Promise(r => { resolve = r; }) }), x = a.add('codex', 'one');
  const pending = a.status('codex', x.id);
  await assert.rejects(a.logout('codex', x.id), /作業中/);
  assert.throws(() => a.remove('codex', x.id), /作業中/);
  resolve({ stdout: 'Logged in using ChatGPT', stderr: '' });
  assert.equal((await pending).status, 'logged-in'); a.assertIdle('codex', x.id);
});
test('external Terminal markers reserve the account and are removed after a harmless shell exits', () => {
  const a = fixture(), x = a.add('codex', 'one');
  const work = a.terminalCommand('codex', x.id, 'true', launch.sq);
  assert.throws(() => a.assertIdle('codex', x.id), /作業中/); a.available('codex', x.id);
  work.cancel(); const login = a.terminalCommand('codex', x.id, 'true', launch.sq, 'auth');
  assert.throws(() => a.available('codex', x.id), /処理中/);
  execFileSync('/bin/bash', ['-c', login.command]); a.assertIdle('codex', x.id);
  assert.deepEqual(fs.readdirSync(a.termDir), []);
});
test('delete moves complete profile to trash and never deletes the default home', () => {
  const a = fixture(), x = a.add('codex', 'one'); fs.writeFileSync(path.join(x.dir, 'auth.json'), 'fixture-token');
  a.remove('codex', x.id); assert.equal(fs.existsSync(x.dir), false);
  const dest = path.join(a.trash, fs.readdirSync(a.trash)[0]);
  assert.equal(fs.readFileSync(path.join(dest, 'auth.json'), 'utf8'), 'fixture-token'); assert.equal(a.list().length, 4);
  assert.throws(() => a.remove('codex', 'default')); assert.ok(fs.existsSync(a.home));
});
test('same-account sessions resume; switching accounts carries visible history without the old session', () => {
  for (const ai of ['claude', 'codex']) {
    const base = { ai, model: ai === 'codex' ? 'GPT-6.1-Sol' : 'Opus 5.5', text: 'next', rows: [{ role: 'assistant', ai, text: 'previous history' }], meta: { sessions: { [ai]: 'old-session' }, models: { [ai]: ai === 'codex' ? 'GPT-6.1-Sol' : 'Opus 5.5' } } };
    assert.equal(chat.buildTurn(base).resume, true);
    const changed = chat.buildTurn({ ...base, account: 'new-account' }); assert.equal(changed.resume, false); assert.ok(!changed.args.includes('old-session')); assert.match(changed.stdin, /previous history/);
    assert.equal(chat.buildTurn({ ...base, account: 'new-account', meta: { ...base.meta, sessionAccounts: { [ai]: 'new-account' } } }).resume, true);
  }
});
test('queued accounts persist across selection changes and a new runner', () => {
  const pdir = path.join(tmp, 'queue'); let selected = 'first';
  const runner = new chat.ChatRunner({ dirOf: () => pdir, accountFor: () => selected });
  runner.enqueue('p', 't', { ai: 'codex', text: 'one', account: undefined }); selected = 'second';
  runner.enqueue('p', 't', { ai: 'codex', text: 'two' });
  assert.deepEqual(new chat.ChatRunner({ dirOf: () => pdir }).queue('p', 't').map(q => q.account), ['first', 'second']);
});
test('terminal handoff reads the source account even when both profiles contain the same working directory', () => {
  const transcript = require('../lib/transcript'), a = fixture();
  for (const ai of ['claude', 'codex']) {
    const first = a.add(ai, 'first'), second = a.add(ai, 'second');
    for (const [r, text] of [[first, 'first account'], [second, 'second account']]) {
      const logDir = path.join(r.dir, ai === 'claude' ? 'projects/p' : 'sessions/2026/10/07');
      fs.mkdirSync(logDir, { recursive: true });
      const rows = ai === 'claude' ? [{ cwd: tmp, type: 'assistant', message: { content: text } }] :
        [{ type: 'session_meta', payload: { cwd: tmp } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: text } }];
      fs.writeFileSync(path.join(logDir, 'rollout-same.jsonl'), rows.map(JSON.stringify).join('\n'));
    }
    const convo = transcript.collect({ ai, dir: tmp, accountDir: first.dir });
    assert.equal(convo.kind, 'log'); assert.deepEqual(convo.msgs, [{ role: 'assistant', text: 'first account' }]);
    assert.ok(convo.source.startsWith(first.dir + path.sep));
  }
});
test('PTY environments support two tasks with different accounts, refusing a live same-task switch', () => {
  const a = fixture(), x = a.add('codex', 'one'), y = a.add('codex', 'two'), captures = [];
  launch.setAccounts(a);
  const pty = { spawn(file, args, opts) { captures.push(opts); return { onData() {}, onExit() {}, kill() {} }; } }, s = new Sessions({ pty });
  const opts = { project: 'p', ai: 'codex', dir: tmp, command: '/bin/bash', args: [] };
  s.start({ ...opts, task: 'one', account: x.id }); s.start({ ...opts, task: 'two', account: y.id });
  assert.deepEqual(captures.map(c => c.env.CODEX_HOME), [x.dir, y.dir]);
  assert.throws(() => s.start({ ...opts, task: 'one', account: y.id }), /別のアカウント/);
  assert.deepEqual(s.list().map(r => r.account), [x.id, y.id]);
});
test('usage caches, cooldowns and failures are independent for each account', async () => {
  const calls = [], u = new Usage({ find: ai => ai, read: async (ai, file, o) => { calls.push(ai + ':' + o.account); if (o.account === 'failed') throw Error('SECRET'); return ai === 'codex' ? { rateLimits: { primary: { usedPercent: o.account === 'first' ? 10 : 80, windowDurationMins: 300 } } } : { subscription_type: 'max', rate_limits: { five_hour: { utilization: 20 } } }; } });
  const first = await u.status(false, { codex: 'first' }), second = await u.status(false, { codex: 'second' });
  assert.equal(first.providers.codex.windows[0].usedPercent, 10); assert.equal(second.providers.codex.windows[0].usedPercent, 80);
  await u.status(true, { codex: 'first' }); assert.deepEqual(calls, ['codex:first', 'claude:default', 'codex:second']);
  await u.status(false, { codex: 'failed' }); await u.status(false, { codex: 'failed' });
  assert.equal(calls.filter(x => x === 'codex:failed').length, 1);
  assert.equal(u.snapshot({ claude: 'not-read' }).providers.claude.account, 'not-read');
});
test('Fable holds and usage observations persist and clear only the selected account', () => {
  const file = path.join(tmp, 'limits.json'), now = Date.now(), e = new LimitEvidence(file, { now: () => now });
  e.record({ account: 'first', project: 'p', task: 'one' }); e.record({ account: 'second', task: 'two' }); e.record({});
  e.observe({ accountProviders: [{ ai: 'claude', account: 'first', status: 'ok', attemptedAt: new Date(now).toISOString(), fetchedAt: new Date(now + 1).toISOString(), windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: new Date(now + 60000).toISOString() }] }] });
  assert.ok(e.active('first').validUntil); assert.equal(e.active('second').validUntil, null);
  e.clear('first'); const fresh = new LimitEvidence(file); assert.equal(fresh.active('first'), null); assert.ok(fresh.active('second')); assert.ok(fresh.active());
});

 test('Gemini default status strips API inputs, classifies safe output and never changes auth', async () => {
  let response = { stdout: 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', stderr: '' }, calls = 0;
  const a = fixture({ execute: async (file, args, env) => {
    calls++; assert.equal(file, 'agy'); assert.deepEqual(args, ['models']);
    assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_API_KEY, undefined);
    return response;
  } });
  assert.equal(a.list().filter(r => r.ai === 'agy').length, 1);
  assert.throws(() => a.add('agy', 'named')); assert.throws(() => a.get('agy', 'named'));
  assert.throws(() => a.rename('agy', 'default', 'named')); assert.throws(() => a.remove('agy', 'default'));
  assert.equal((await a.status('agy', 'default')).status, 'logged-in');
  for (const [r, status] of [
    [{stdout:'',stderr:'Please sign in'}, 'logged-out'],
    [{stdout:'secret arbitrary output',stderr:''}, 'unknown'],
    [{stdout:'gemini-3x1-pro-high gemini-3.1-pro-high-extra',stderr:''}, 'unknown'],
    [{stdout:'gemini-3.1-pro-high',stderr:'',error:{code:1}}, 'unknown'],
    [{stdout:'',stderr:'Not signed in',error:{killed:true}}, 'unknown'],
    [{stdout:'',stderr:'',error:{code:'ENOENT'}}, 'not-installed'],
  ]) { response = r; const result = await a.status('agy', 'default'); assert.equal(result.status, status); assert.ok(!JSON.stringify(result).includes('secret')); }
  const file = path.join(a.home, '.gemini/antigravity-cli/settings.json'); fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, '{"modelProvider":"gemini"}'); const before = calls;
  assert.equal((await a.status('agy', 'default')).status, 'api'); assert.equal(calls, before);
  await assert.rejects(a.logout('agy', 'default', true), /Terminal/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"modelProvider":"gemini"}');
  const c = a.command('agy', 'default', 'login'); assert.deepEqual(c.args, []);
  assert.equal(a.env('agy', 'default', {GEMINI_API_KEY:'fixture',GOOGLE_API_KEY:'fixture',PATH:'/bin'}).PATH, '/bin');
  assert.equal(a.env('agy', 'default', {GEMINI_API_KEY:'fixture'}).GEMINI_API_KEY, undefined);
 });
 test('Gemini status reader and auth terminal protect the same default account', async () => {
   let finish; const a = fixture({execute: () => new Promise(r => finish = r)});
   const waiting = a.status('agy', 'default'); assert.throws(() => a.assertIdle('agy', 'default'), /作業中/);
   finish({stdout:'gemini-3.1-pro-high',stderr:''}); await waiting; a.assertIdle('agy', 'default');
   const term = a.terminalCommand('agy', 'default', "'agy'", launch.sq, 'auth');
   assert.throws(() => a.assertIdle('agy', 'default')); assert.equal((await a.status('agy', 'default')).status, 'unknown');
   term.cancel(); a.assertIdle('agy', 'default');
 });
