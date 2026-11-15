'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// Baseline represents the former behavior (launch without preparing trust).
const modulePath = path.join(__dirname, '../lib/cli-trust.js');
const { createCliTrust } = fs.existsSync(modulePath) ? require(modulePath) : { createCliTrust: () => (_ai, file) => file };
const blocked = e => e.stage === 'mac-confirmation' && e.status === 409 && /Mac の確認が必要/.test(e.reason);
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-trust-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), real = path.join(home, '.local/share/claude/versions/2.1.323');
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, 'fake signed Mach-O bytes', { mode: 0o755 });
  const link = path.join(home, 'claude'); fs.symlinkSync(real, link);
  const state = { quarantined: true, deletes: 0, calls: [], ...options };
  const run = (tool, args, opts) => {
    state.calls.push({ tool, args });
    assert.ok(['/usr/bin/xattr', '/usr/bin/codesign', '/usr/sbin/spctl'].includes(tool));
    assert.equal(fs.fstatSync(opts.stdio[3]).ino, fs.statSync(state.original || real).ino);
    if (tool.endsWith('/xattr')) {
      assert.equal(args.at(-1), '/dev/fd/3');
      if (args[0] === '-p') {
        state.readChange?.({ real, link, state });
        return state.fail === 'quarantine-read' ? { status: 1 } : { status: 0, stdout: state.flags ?? '0081;65530000;Homebrew;' };
      }
      if (args[0] === '-d') { if(state.fail==='remove')return {status:1}; state.deletes++; state.quarantined = false; }
      return state.fail === 'xattr' ? { status: 1 } : { status: 0, stdout: state.quarantined ? 'com.apple.quarantine\n' : '' };
    }
    const snapshot = args.at(-1);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), 'fake signed Mach-O bytes');
    assert.equal(fs.statSync(path.dirname(snapshot)).mode & 0o777, 0o700);
    if (tool.endsWith('/codesign') && args[0] === '--verify') {
      assert.ok(args.includes('--strict')); assert.ok(args.includes('--all-architectures'));
      assert.match(args[args.indexOf('-R') + 1], /anchor apple generic.*Q6L2SF6YDW.*com.anthropic.claude-code/);
      return state.fail === 'signature' ? { status: 1 } : { status: 0 };
    }
    if (tool.endsWith('/codesign') && state.fail==='identity-read')return {status:1};
    if (tool.endsWith('/codesign')) return { status: 0, stderr: `TeamIdentifier=${state.fail === 'team' ? 'EVILTEAM' : 'Q6L2SF6YDW'}\nIdentifier=${state.fail === 'identifier' ? 'com.other.app' : 'com.anthropic.claude-code'}\n` };
    state.change?.({ real, link, state });
    if (state.fail === 'timeout') return { error: Error('ETIMEDOUT'), status: null };
    return { status: state.fail === 'notarization' ? 1 : 0, stderr: state.assessment ?? `${snapshot}: accepted\nsource=${state.fail === 'unnotarized' ? 'Developer ID' : 'Notarized Developer ID'}\n` };
  };
  const ensure = createCliTrust({ platform: 'darwin', home, temporary: root, run });
  return { root, home, real, link, state, run, ensure };
}
test('署名・発行元・公証が一致した同じ実体だけから印を外す', t => {
  const f = fixture(t);
  assert.equal(f.ensure('claude', f.link), f.real);
  assert.equal(f.state.deletes, 1); assert.equal(f.state.quarantined, false);
  assert.deepEqual(f.state.calls.map(c => path.basename(c.tool)), ['xattr','xattr','codesign','codesign','spctl','xattr','xattr']);
  assert.equal(fs.readFileSync(f.real, 'utf8'), 'fake signed Mach-O bytes');
  assert.equal(fs.readdirSync(f.root).filter(x => x.startsWith('hub-cli-trust-')).length, 0);
});
for (const fail of ['signature','team','identifier','notarization','unnotarized','timeout','xattr','identity-read','remove']) test(`確認が不合格なら印を外さない：${fail}`, t => {
  const f = fixture(t, { fail });
  assert.throws(() => f.ensure('claude', f.link), blocked);
  assert.equal(f.state.deletes, 0); assert.equal(f.state.quarantined, true);
});
test('想定外の導入先なら公証を調べる前に止まる', t => {
  const f = fixture(t), outside = path.join(f.root, 'untrusted');
  fs.renameSync(f.real, outside); fs.unlinkSync(f.link); fs.symlinkSync(outside, f.link);
  f.state.original = outside;
  assert.throws(() => f.ensure('claude', f.link), blocked);
  assert.equal(f.state.deletes, 0); assert.equal(f.state.calls.length, 1);
});
test('確認中にリンクの実体が差し替わったら両方の印を残す', t => {
  const f = fixture(t, { change: ({ real, state }) => {
    const saved = real + '.old'; fs.renameSync(real, saved); fs.writeFileSync(real, 'replacement'); state.original = saved;
  } });
  assert.throws(() => f.ensure('claude', f.link), blocked); assert.equal(f.state.deletes, 0);
});
test('確認中に同じ実体の内容が変わったら印を残す', t => {
  const f = fixture(t, { change: ({ real }) => fs.appendFileSync(real, 'changed') });
  assert.throws(() => f.ensure('claude', f.link), blocked); assert.equal(f.state.deletes, 0);
});
test('実体が存在しなければ起動を許可しない', t => {
  const f = fixture(t); fs.unlinkSync(f.real);
  assert.throws(() => f.ensure('claude', f.link), blocked); assert.equal(f.state.calls.length, 0);
});
test('印がなければ署名確認も変更も不要', t => {
  const f = fixture(t, { quarantined: false });
  assert.equal(f.ensure('claude', f.link), f.link); assert.equal(f.state.calls.length, 1); assert.equal(f.state.deletes, 0);
});
test('macOS以外と発行元を確定していない道具には何もしない', t => {
  const f = fixture(t);
  for (const platform of ['win32','linux']) assert.equal(createCliTrust({ platform, run: () => assert.fail('must not run') })('claude', f.link), f.link);
  for (const ai of ['codex','grok','agy']) assert.equal(f.ensure(ai, f.link), f.link);
  assert.equal(f.state.calls.length, 0);
});

test('codesignの条件はファイル名ではなくインラインの要求として渡す', t => {
  const f = fixture(t); f.ensure('claude', f.link);
  const args = f.state.calls.find(c => c.args[0] === '--verify').args;
  assert.equal(args[args.indexOf('-R') + 1], '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW" and identifier "com.anthropic.claude-code"');
});
test('単体プログラムの公証はopenとprimary-signatureで検証する', t => {
  const f = fixture(t); f.ensure('claude', f.link);
  const args = f.state.calls.find(c => c.tool === '/usr/sbin/spctl').args;
  assert.deepEqual(args.slice(0, -1), ['--assess','--type','open','--context','context:primary-signature','--ignore-cache','--no-cache','--verbose=2']);
});
test('公証のsourceだけやrejectedでは成功終了でも印を外さない', t => {
  for (const assessment of ['source=Notarized Developer ID\n', 'rejected\nsource=Notarized Developer ID\n', 'not accepted\nsource=Notarized Developer ID\n']) {
    const f = fixture(t, { assessment });
    assert.throws(() => f.ensure('claude', f.link), blocked);
    assert.equal(f.state.deletes, 0); assert.equal(f.state.quarantined, true);
  }
});
test('人が許可済みの印は消さずOSに起動の判断を戻す', t => {
  for (const flags of ['01c1;65530000;Homebrew;', '00C1;65530000;Safari;']) {
    const f = fixture(t, { flags, fail: 'signature' });
    assert.equal(f.ensure('claude', f.link), f.real);
    assert.equal(f.state.deletes, 0); assert.equal(f.state.quarantined, true);
    assert.deepEqual(f.state.calls.map(c => c.tool), ['/usr/bin/xattr','/usr/bin/xattr']);
  }
});
test('壊れた許可フラグを人の許可として扱わない', t => {
  for (const flags of ['01c1junk;time;agent;', 'zz40;time;agent;', '0x01c1;time;agent;', '10040;time;agent;']) {
    const f = fixture(t, { flags, fail: 'signature' });
    assert.throws(() => f.ensure('claude', f.link), blocked); assert.equal(f.state.deletes, 0);
  }
});
test('許可フラグを読めない時は起動を許可せず印も残す', t => {
  const f = fixture(t, { fail: 'quarantine-read' });
  assert.throws(() => f.ensure('claude', f.link), blocked);
  assert.equal(f.state.deletes, 0); assert.equal(f.state.calls.length, 2);
});
test('許可済みの印の読み取り中に実体が変わっても起動を許可しない', t => {
  const f = fixture(t, { flags: '01c1;65530000;Homebrew;', readChange: ({ real }) => fs.appendFileSync(real, 'changed') });
  assert.throws(() => f.ensure('claude', f.link), blocked); assert.equal(f.state.deletes, 0);
});
test('確認失敗の表示にはMacで許可したあとの再操作を案内する', t => {
  const f = fixture(t, { fail: 'signature' });
  assert.throws(() => f.ensure('claude', f.link), e => blocked(e) && /Mac で Claude Code を開いて内容を確認し、許可したあとにもう一度操作してください。/.test(e.reason));
});

test('Macの標準道具で実物の複製だけを検証し、未署名と改変は拒否する', { timeout: 120000 }, t => {
  if (process.platform !== 'darwin') return t.skip('macOS only');
  const { spawnSync } = require('node:child_process'), { createHash } = require('node:crypto');
  const candidates = [...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'claude')),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local/bin/claude')];
  const source = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!source) return t.skip('Claude Code not installed');
  const realSource = fs.realpathSync(source);
  const hash = file => { const fd = fs.openSync(file, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); try {
    for (let pos = 0, n; (n = fs.readSync(fd, buffer, 0, buffer.length, pos)); pos += n) digest.update(buffer.subarray(0, n));
    return digest.digest('hex');
  } finally { fs.closeSync(fd); } };
  const tool = (file, args) => spawnSync(file, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
  const attribute = file => { const r = tool('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file]); assert.ok(!r.error); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const before = { hash: hash(realSource), attr: attribute(realSource), stat: fs.statSync(realSource, { bigint: true }) };
  const root = fs.mkdtempSync('/private/tmp/hub-real-cli-trust-'), home = path.join(root, 'home');
  const copy = path.join(home, '.local/share/claude/versions/test-copy');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  t.after(() => {
    try {
      assert.equal(hash(realSource), before.hash); assert.deepEqual(attribute(realSource), before.attr);
      const after = fs.statSync(realSource, { bigint: true });
      for (const key of ['dev','ino','mode','uid','gid','size','mtimeNs','ctimeNs']) assert.equal(after[key], before.stat[key], key);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const ensure = createCliTrust({ home, temporary: root });
  const mark = () => { fs.chmodSync(copy, 0o755); const r = tool('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;65530000;HubTest;', copy]); assert.equal(r.status, 0, r.stderr); };
  fs.copyFileSync(realSource, copy); mark();
  assert.equal(ensure('claude', copy), copy);
  assert.equal(attribute(copy).status, 1, 'genuine copy loses quarantine');
  fs.unlinkSync(copy); fs.writeFileSync(copy, 'unsigned test file'); mark();
  assert.throws(() => ensure('claude', copy), blocked);
  assert.equal(attribute(copy).stdout.trim(), '0081;65530000;HubTest;');
  fs.unlinkSync(copy); fs.copyFileSync(realSource, copy);
  const fd = fs.openSync(copy, 'r+'); try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, 4096); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 4096); } finally { fs.closeSync(fd); }
  mark(); assert.throws(() => ensure('claude', copy), blocked);
  assert.equal(attribute(copy).stdout.trim(), '0081;65530000;HubTest;');
  t.diagnostic('genuine copy passed; unsigned/one-byte modified copies retained quarantine; installed CLI read-only and never executed');
});
