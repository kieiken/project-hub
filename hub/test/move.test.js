'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Move, FORMAT, CONFIRM, writeSeedReceipt } = require('../lib/move');
const { Store } = require('../lib/store');
const { Freetalk } = require('../lib/freetalk');
const { parseDoc } = require('../lib/frontmatter');
const hash = b => createHash('sha256').update(b).digest('hex');
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-move-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const oldHome = path.join(temp, 'old-alice'), newHome = path.join(temp, 'new-bob');
  const root = path.join(oldHome, 'Documents/AI-Workspace'), target = path.join(newHome, 'Documents/AI-Workspace');
  fs.mkdirSync(path.join(newHome, 'Documents'), { recursive: true });
  const ext = path.join(oldHome, 'Projects/日本語の本体');
  put(path.join(ext, 'src/アプリ.txt'), 'プロジェクト本体\n');
  put(path.join(root, 'Product/demo/PROJECT.md'), `---\nname: demo\nstatus: 進行中\nfolders:\n  本体: ${JSON.stringify(ext)}\n  別体: ${JSON.stringify(path.join(root, 'System/repo'))}\n  外付け: /Volumes/unavailable-demo\nphases: []\n---\n# demo\n元の説明\n`);
  put(path.join(root, 'Product/demo/.ai/tasks/job.md'), `---\nid: job\ntitle: 保存した仕事\nstate: 未着手\nworkdir: ${JSON.stringify(path.join(root, 'Work/demo/job'))}\n---\n# 作業\n古いパスは原文に残す：${ext}\n`);
  const chat = JSON.stringify({ role: 'user', text: `原文・添付 ${ext}/src/アプリ.txt` }) + '\n';
  put(path.join(root, 'Product/demo/.ai/chat/job.jsonl'), chat);
  const ft = new Freetalk(new Store(root), oldHome); assert.equal(ft.ensure().ready, true);
  const topic = ft.createTopic({ ai: 'codex', model: 'test', effort: '高' });
  put(path.join(ft.ledger, '.ai/chat', topic.id + '.jsonl'), chat);
  put(path.join(ft.dir, '.ai/attachments/picture.bin'), Buffer.from([0, 1, 255, 2]));
  const source = new Move({ home: oldHome, root, version: '4.123.1' });
  const dest = options => new Move({ home: newHome, root: target, ...options });
  const send = async () => {
    const s = await source.export();
    const inbox = path.join(newHome, 'Documents/ProjectHub-Move'); fs.mkdirSync(inbox, { recursive: true });
    const bundle = path.join(inbox, s.bundle); await fsp.cp(s.path, bundle, { recursive: true, verbatimSymlinks: true });
    return { bundle, name: s.bundle, manifest: JSON.parse(read(path.join(bundle, 'manifest.json'))) };
  };
  return { temp, oldHome, newHome, root, target, ext, chat, ft, topic, source, dest, send };
}
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repo(f) {
  const dir = path.join(f.root, 'System/repo'), wt = path.join(f.root, 'Work/demo/job');
  fs.mkdirSync(dir, { recursive: true }); git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Move Test']); git(dir, ['config', 'user.email', 'a@example.test']);
  put(path.join(dir, 'source.txt'), 'committed'); git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'fixture']);
  fs.mkdirSync(path.dirname(wt), { recursive: true }); git(dir, ['worktree', 'add', '-qb', 'hub/job', wt]);
  return { dir, wt, head: git(wt, ['rev-parse', 'HEAD']) };
}
function changeManifest(bundle, change) {
  const file = path.join(bundle, 'manifest.json'), m = JSON.parse(read(file)); change(m); put(file, JSON.stringify(m));
}
test('browser sessions are absent from exports including case aliases; regular configuration and project links round-trip', async t => {
  const f = fixture(t), profile = path.join(f.root, '_hub/WebChat/profile');
  put(path.join(profile, 'Cookies'), 'private-browser-cookie');
  put(path.join(profile, 'Preferences'), 'private-browser-preferences');
  put(path.join(f.root, '_hub/webchat.json'), '{"provider":"example"}');
  const project = path.join(f.root, 'Product/demo/PROJECT.md');
  const outside=path.join(f.temp,'external-volume');fs.mkdirSync(outside);
  put(project, read(project).replace('phases: []', '  ブラウザ: ' + JSON.stringify(profile) + '\n  外部ディスク: '+JSON.stringify(outside)+'\nphases: []'));
  fs.symlinkSync('src', path.join(f.ext, '_hub'));
  const { name, manifest } = await f.send();
  assert.equal(manifest.entries.some(e => /Cookies|Preferences|_hub\/WebChat(?:\/|$)/i.test(e.rel)), false);
  assert.ok(manifest.notIncluded.some(e => e.path === profile));
  assert.ok(manifest.notIncluded.some(e => e.path === outside && e.reason === 'home-outside'));
  assert.ok(manifest.entries.some(e => e.rel === '_hub/webchat.json'));
  await f.dest().import({ bundle: name });
  assert.equal(read(path.join(f.target, '_hub/webchat.json')), '{"provider":"example"}');
  assert.equal(fs.existsSync(path.join(f.target, '_hub/WebChat')), false);
  assert.equal(fs.readlinkSync(path.join(f.newHome, 'Projects/日本語の本体/_hub')), 'src');
});
test('imports refuse browser profiles and workspace control-directory aliases without forbidding unrelated project links', async t => {
  for (const rel of ['_hub/WebChat', '_HUB']) {
    const f = fixture(t), { bundle, name } = await f.send();
    changeManifest(bundle, m => {
      if (rel.includes('/') && !m.entries.some(e => e.root === 'workspace' && e.rel === '_hub')) m.entries.push({ root: 'workspace', rel: '_hub', nameB64: Buffer.from('_hub').toString('base64'), type: 'dir', mode: '700', size: 0, sha256: null });
      m.entries.push({ root: 'workspace', rel, nameB64: Buffer.from(rel).toString('base64'), type: rel.includes('/') ? 'dir' : 'link', link: 'Product', mode: '700', size: 0, sha256: null });
    });
    assert.throws(() => f.dest().manifest(name), /移せない|リンク/);
  }
  const f = fixture(t), { bundle, name } = await f.send();
  changeManifest(bundle, m => m.roots.push({ id: 'ext-99', orig: path.join(f.root.toUpperCase(), '_HUB/WebChat'), project: 'demo', label: 'alias' }));
  assert.throws(() => f.dest().manifest(name), /範囲/);
});
test('M1 M2 M3 M18: two usernames, chat bytes/attachments/freetalk owner and structured paths; local-only credentials excluded', async t => {
  const f = fixture(t), r = repo(f);
  put(path.join(f.root, '_hub/license/device.json'), 'old-device');
  put(path.join(f.root, '_hub/updates/state.json'), 'old-update');
  put(path.join(f.root, 'System/repo/node_modules/dep/index.js'), 'ignored');
  put(path.join(f.root, 'System/repo/hub/lib/license/owner-edition.js'), 'owner');
  f.source.edition = 'owner';
  const { name, manifest } = await f.send(), move = f.dest();
  assert.equal(manifest.source.edition, 'owner');
  assert.ok(manifest.notIncluded.some(e => e.reason === 'home-outside'));
  assert.equal(manifest.entries.some(e => /node_modules|owner-edition|^Work\/|^_hub\/(license|updates)/.test(e.rel)), false);
  assert.equal(move.needsStartup(), true); const result = await move.autoImport(); assert.equal(result.mode, 'imported');
  assert.equal(read(path.join(f.target, 'Product/demo/.ai/chat/job.jsonl')), f.chat);
  assert.equal(read(path.join(f.target, 'Product/freetalk/.ai/chat', f.topic.id + '.jsonl')), f.chat);
  assert.deepEqual(fs.readFileSync(path.join(f.newHome, 'Documents/freetalk/.ai/attachments/picture.bin')), Buffer.from([0, 1, 255, 2]));
  const meta = parseDoc(read(path.join(f.target, 'Product/demo/PROJECT.md'))).data;
  assert.equal(meta.folders['本体'], path.join(f.newHome, 'Projects/日本語の本体'));
  assert.equal(read(path.join(meta.folders['本体'], 'src/アプリ.txt')), 'プロジェクト本体\n');
  const task = parseDoc(read(path.join(f.target, 'Product/demo/.ai/tasks/job.md')));
  assert.equal(task.data.workdir, path.join(f.target, 'Work/demo/job')); assert.ok(task.body.includes(f.ext));
  const restored = new Freetalk(new Store(f.target), f.newHome); assert.equal(restored.ensure().ready, true);
  assert.equal(JSON.parse(read(path.join(restored.dir, '.ai/freetalk.json'))).owner, JSON.parse(read(path.join(f.ft.dir, '.ai/freetalk.json'))).owner);
  assert.equal(fs.existsSync(path.join(f.target, '_hub/license')), false);
  assert.equal(fs.existsSync(path.join(f.target, 'Work')), false);
  assert.equal(git(path.join(f.target, 'System/repo'), ['rev-parse', 'hub/job']), r.head);
  assert.ok(fs.existsSync(path.join(f.newHome, 'Documents/ProjectHub-Move', name, 'imported.json')));
  // Fallback is only used if the original absolute path no longer exists.
  fs.renameSync(f.root, f.root + '-offline');
  const script = `const s=require(${JSON.stringify(path.resolve(__dirname, '../lib/store'))});s.loadMovePathMap(process.argv[1]);console.log(s.expandHome(process.argv[2]));`;
  const oldChat = path.join(f.root, 'Product/demo/.ai/chat/job.jsonl');
  const mapped = execFileSync(process.execPath, ['-e', script, f.target, oldChat], { env: { ...process.env, HOME: f.newHome }, encoding: 'utf8' }).trim();
  assert.equal(mapped, path.join(f.target, 'Product/demo/.ai/chat/job.jsonl'));
});
test('M2 M11: occupied external body gets a unique fallback, existing target needs exact consent and stays preserved', async t => {
  const f = fixture(t); const { name } = await f.send();
  put(path.join(f.target, 'original.txt'), 'keep');
  put(path.join(f.target, '_hub/license/state.json'), 'this-Mac-trial');
  put(path.join(f.newHome, 'Projects/日本語の本体/original.txt'), 'external-keep');
  put(path.join(f.newHome, 'Documents/freetalk/original.txt'), 'freetalk-keep');
  const move = f.dest(); assert.equal((await move.import({ bundle: name })).mode, 'conflict');
  assert.equal((await move.import({ bundle: name, action: 'rename-current-and-import', confirm: 'wrong' })).mode, 'conflict');
  assert.equal(read(path.join(f.target, 'original.txt')), 'keep');
  await move.import({ bundle: name, action: 'rename-current-and-import', confirm: CONFIRM });
  const backup = fs.readdirSync(path.dirname(f.target)).find(n => n.startsWith('AI-Workspace-退避-'));
  assert.equal(read(path.join(path.dirname(f.target), backup, 'original.txt')), 'keep');
  assert.equal(read(path.join(f.target, '_hub/license/state.json')), 'this-Mac-trial');
  assert.equal(read(path.join(f.newHome, 'Projects/日本語の本体/original.txt')), 'external-keep');
  const folders = parseDoc(read(path.join(f.target, 'Product/demo/PROJECT.md'))).data.folders;
  assert.ok(folders['本体'].includes('Project Hub 引っ越し'));
  assert.equal(read(path.join(folders['本体'], 'src/アプリ.txt')), 'プロジェクト本体\n');
});
test('M4: normalization changed in transfer is matched and original UTF-8 names restored', async t => {
  const f = fixture(t), composed = 'がく.txt'; put(path.join(f.ext, composed), 'unicode');
  const { name, bundle } = await f.send();
  const dir = path.join(bundle, 'data/ext-1');
  fs.renameSync(path.join(dir, composed), path.join(dir, 'temporary'));
  fs.renameSync(path.join(dir, 'temporary'), path.join(dir, composed.normalize('NFD')));
  await f.dest().import({ bundle: name });
  const restored = path.join(f.newHome, 'Projects/日本語の本体');
  assert.ok(fs.readdirSync(restored).includes(composed)); assert.equal(read(path.join(restored, composed)), 'unicode');
});
test('M5: dirty Work is refused, clean branch/HEAD survive and a new worktree can be recreated', async t => {
  const f = fixture(t), r = repo(f); put(path.join(r.wt, 'source.txt'), 'not saved');
  await assert.rejects(f.source.export(), /保存していない作業/);
  git(r.wt, ['checkout', '--', 'source.txt']);
  const { name, manifest } = await f.send(); assert.equal(manifest.worktrees[0].head, r.head);
  await f.dest().import({ bundle: name });
  const restoredRepo = path.join(f.target, 'System/repo'), restoredWork = path.join(f.target, 'Work/demo/job');
  const prepareScript = `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../lib/git'))}).prepare(JSON.parse(process.argv[1]))));`;
  const prepared = JSON.parse(execFileSync(process.execPath, ['-e', prepareScript, JSON.stringify({ base: restoredRepo, workRoot: path.dirname(restoredWork), taskId: 'job', isolatedOnly: true })], { env: { ...process.env, HOME: f.newHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }, encoding: 'utf8' }));
  assert.equal(prepared.created, true); assert.equal(prepared.worktree, restoredWork);
  assert.equal(git(restoredWork, ['rev-parse', 'HEAD']), r.head); assert.equal(read(path.join(restoredWork, 'source.txt')), 'committed');
});
test('M6: busy/queue gate refuses export; barrier holds throughout asynchronous copy and rejects a second operation', async t => {
  const f = fixture(t); f.source.busy = () => true; await assert.rejects(f.source.export(), /AI・順番待ち/);
  const flags = []; f.source.busy = () => false; f.source.barrier = x => flags.push(x);
  const pending = f.source.export(); assert.equal(f.source.running, true); assert.deepEqual(flags, [true]);
  await assert.rejects(f.source.export(), /AI・順番待ち/); await pending; assert.deepEqual(flags, [true, false]);
});
test('strict export preflight reserves one operation and does not copy before permission', async t => {
  const f=fixture(t);let release,copies=0;
  f.source.strictBusy=()=>new Promise(r=>{release=r;});
  f.source.inventory=async()=>{copies++;throw Error('fixture inventory stop');};
  const pending=f.source.export();assert.equal(f.source.running,true);assert.equal(copies,0);
  await assert.rejects(f.source.export(),/AI・順番待ち/);assert.equal(copies,0);
  release(false);await assert.rejects(pending,/fixture inventory stop/);assert.equal(copies,1);assert.equal(f.source.running,false);
});
test('M7: AI account folders excluded; a private PEM header blocks export, no complete manifest is published', async t => {
  const f = fixture(t);
  for (const dir of ['.codex', '.claude', '.hub-accounts']) put(path.join(f.root, dir, 'auth.json'), 'private-account');
  put(path.join(f.root, '_hub/accounts.json'), JSON.stringify({ accounts: [{ ai:'codex', id:'old-account', name:'Old', dir:path.join(f.oldHome, '.hub-accounts/codex/old-account') }] }));
  put(path.join(f.root, '_hub/account-processes/old.json'), '{"pid":123}');
  put(path.join(f.root, '_hub/remote.json'), '{"enabled":true,"passcodeHash":"old-hash"}');
  put(path.join(f.root, 'Backups/old.txt'), 'optional');
  const inv = await f.source.inventory(false); assert.equal(inv.entries.some(e => /auth.json|old.txt/.test(e.rel)), false);
  assert.equal(inv.entries.some(e => /^_hub\/(accounts\.json|remote\.json|account-processes)/.test(e.rel)), false);
  assert.equal(inv.notIncluded.filter(e => e.reason.includes('このMac専用')).length, 2);
  assert.ok((await f.source.inventory(true)).entries.some(e => /old.txt/.test(e.rel)));
  put(path.join(f.ext, 'key.pem'), '-----BEGIN ' + 'PRIVATE KEY-----\nsecret');
  await assert.rejects(f.source.export(), /秘密鍵/); assert.deepEqual(f.source.discovery(), []);
});
test('M8: only internal relative links travel; symlink ancestors, escaping entries and sensitive roots rejected', async t => {
  const f = fixture(t); fs.symlinkSync('src/アプリ.txt', path.join(f.ext, 'inside'));
  fs.symlinkSync('/etc/hosts', path.join(f.ext, 'outside'));
  fs.symlinkSync('..', path.join(f.ext, 'parent'));
  const { name, bundle, manifest } = await f.send(); assert.ok(manifest.notIncluded.some(e => e.reason === 'link-outside'));
  assert.ok(manifest.notIncluded.some(e => e.path === path.join(f.ext, 'parent') && e.reason === 'link-outside'));
  await f.dest().import({ bundle: name }); assert.equal(fs.readlinkSync(path.join(f.newHome, 'Projects/日本語の本体/inside')), 'src/アプリ.txt');
  assert.equal(fs.existsSync(path.join(f.newHome, 'Projects/日本語の本体/outside')), false);
  assert.equal(fs.existsSync(path.join(f.newHome, 'Projects/日本語の本体/parent')), false);
  // A fresh target must reject a symlinked data container, rather than following it.
  fs.unlinkSync(path.join(bundle, 'imported.json')); fs.renameSync(path.join(bundle, 'data'), path.join(bundle, 'hidden-data'));
  fs.symlinkSync('hidden-data', path.join(bundle, 'data'));
  await assert.rejects(f.dest().import({ bundle: name }), /リンク/);
  fs.unlinkSync(path.join(bundle, 'data')); fs.renameSync(path.join(bundle, 'hidden-data'), path.join(bundle, 'data'));
  changeManifest(bundle, m => { m.entries[0].rel = '../escape'; }); await assert.rejects(f.dest().import({ bundle: name }), /移せない/);
});
test('M9 M10: low capacity/incomplete manifest/corruption fail before existing data is moved', async t => {
  const f = fixture(t); f.source.freeBytes = () => 0; await assert.rejects(f.source.export(), /空き容量/);
  f.source.freeBytes = () => 1e12; const { name, bundle, manifest } = await f.send();
  const move = f.dest({ freeBytes: () => 0 }); await assert.rejects(move.import({ bundle: name }), /空き容量/);
  put(path.join(move.inbox, 'incomplete.hubmove/data.txt'), 'partial'); assert.deepEqual(move.discovery(), [name]);
  const e = manifest.entries.find(e => e.type === 'file'); put(path.join(bundle, 'data', e.root, e.rel), 'tampered');
  await assert.rejects(f.dest().import({ bundle: name }), /照合|大きさ/); assert.equal(fs.existsSync(f.target), false);
});
test('M12: exact seed receipt permits automatic import with seed retained in Trash; edited seeds do not', async t => {
  const f = fixture(t); const { name } = await f.send(); put(path.join(f.target, 'Product/example/PROJECT.md'), 'seed');
  await writeSeedReceipt(f.target); const move = f.dest(); assert.equal(await move.seedOnly(), true);
  put(path.join(f.target, 'user.txt'), 'keep'); assert.equal(await move.seedOnly(), false); fs.unlinkSync(path.join(f.target, 'user.txt'));
  await move.import({ bundle: name });
  const trash = fs.readdirSync(path.join(f.newHome, '.Trash')).find(n => n.startsWith('AI-Workspace-'));
  assert.equal(read(path.join(f.newHome, '.Trash', trash, 'Product/example/PROJECT.md')), 'seed');
});
for (const point of ['prepared', 'rename-0', 'rename-1', 'rename-2']) test('M13: interruption at ' + point + ' resumes using the rename journal without overwriting', async t => {
  const f = fixture(t); const { name } = await f.send(); put(path.join(f.target, 'keep.txt'), 'original');
  const move = f.dest({ fault: async p => { if (p === point) throw Error('simulated interruption'); } });
  await assert.rejects(move.import({ bundle: name, action: 'rename-current-and-import', confirm: CONFIRM }), /simulated/);
  const restart = f.dest(); assert.equal(restart.needsStartup(), true); await restart.autoImport();
  assert.equal(read(path.join(f.target, 'Product/demo/.ai/chat/job.jsonl')), f.chat);
  const backup = fs.readdirSync(path.dirname(f.target)).find(n => n.startsWith('AI-Workspace-退避-'));
  assert.equal(read(path.join(path.dirname(f.target), backup, 'keep.txt')), 'original');
});
test('M14 M15 M19: no repeat import; multiple candidates require selection; same source Mac keeps current data', async t => {
  const f = fixture(t); const { name, bundle } = await f.send(); assert.equal(f.source.needsStartup(), false);
  await fsp.cp(bundle, path.join(path.dirname(bundle), 'second.hubmove'), { recursive: true });
  const move = f.dest(); assert.equal(move.needsStartup(), true); assert.equal((await move.autoImport()).mode, 'conflict');
  await move.import({ bundle: 'second.hubmove', action: 'skip' }); await move.import({ bundle: name });
  assert.deepEqual(move.discovery(), []); assert.equal(f.dest().needsStartup(), false);
  assert.equal(read(path.join(f.root, 'Product/demo/.ai/chat/job.jsonl')), f.chat);
});
test('M16: boot serves ping and a restricted page during import, then requests normal restart; no Store/License load', async t => {
  const f = fixture(t); await f.send(); const move = f.dest(); move.needsStartup();
  let release; const paused = new Promise(r => { release = r; }); move.fault = p => p === 'prepared' ? paused : undefined;
  const { serve, page } = require('../lib/move-boot'); let restarted = false;
  const server = serve(move, { port: 0, version: 'test', entry: path.resolve(__dirname, '../server.js'), restart: () => { restarted = true; } });
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port, start = Date.now();
  const ping = await (await fetch(url + '/api/ping')).json(); assert.equal(ping.migration, true); assert.ok(Date.now() - start < 15000);
  assert.equal((await fetch(url + '/api/state')).status, 409);
  assert.equal((await fetch(url + '/api/move/import', { method: 'POST', body: '{}' })).status, 403);
  assert.match(page(), /choices/); assert.doesNotMatch(page(), /app\.js/);
  release();
  for (let n = 0; n < 100 && !restarted; n++) await new Promise(r => setTimeout(r, 20));
  assert.equal(restarted, true); assert.equal(move.status().mode, 'imported');
  const source = read(path.resolve(__dirname, '../server.js')); assert.ok(source.indexOf('move.needsStartup()') < source.indexOf('const license ='));
});
test('M17: imported command-capable Git config is preserved as attention, no hook or filter is executed', async t => {
  const f = fixture(t), dir = path.join(f.root, 'System/repo'); fs.mkdirSync(dir, { recursive: true }); git(dir, ['init', '-q']);
  const marker = path.join(f.temp, 'must-not-run');
  git(dir, ['config', 'core.fsmonitor', 'touch ' + marker]); git(dir, ['config', 'core.hooksPath', '/unused-fixture']);
  const config = read(path.join(dir, '.git/config')), { name } = await f.send(); await f.dest().import({ bundle: name });
  assert.equal(read(path.join(f.target, 'System/repo/.git/config')), config); assert.equal(fs.existsSync(marker), false);
  assert.equal(f.dest().status().attention.length, 1);
});
test('M5: detaching omitted Work preserves unrelated stale and explicitly locked registrations', async t => {
  const f = fixture(t), r = repo(f), other = path.join(f.oldHome, 'other-checkout');
  git(r.dir, ['worktree', 'add', '-qb', 'unrelated', other]);
  fs.renameSync(other, other + '-offline');
  git(r.dir, ['worktree', 'lock', r.wt]);
  const registration = path.join(r.dir, '.git/worktrees/other-checkout');
  const original = read(path.join(registration, 'gitdir'));
  const { name } = await f.send(); await f.dest().import({ bundle: name });
  const target = path.join(f.target, 'System/repo/.git/worktrees');
  assert.equal(read(path.join(target, 'other-checkout/gitdir')), original);
  assert.equal(fs.existsSync(path.join(target, 'other-checkout/locked')), false);
  assert.equal(fs.existsSync(path.join(target, 'job/locked')), true);
  assert.ok(f.dest().status().attention.some(row => /ロック/.test(row.reason)));
});
test('normal server move routes enforce local headers, busy and snapshot barriers, then finish export', t => {
  const f = fixture(t);
  const script = `
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const moduleMove=require(${JSON.stringify(path.resolve(__dirname, '../lib/move'))}),Real=moduleMove.Move;let move;
    moduleMove.Move=class extends Real{constructor(o){super(o);move=this;}};
    require(${JSON.stringify(path.resolve(__dirname, '../lib/procwatch'))}).create=()=>({list:()=>[],onChange(){},start(){},stop(){}});
    (async()=>{
      const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
      const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
      const hub=require(${JSON.stringify(path.resolve(__dirname, '../server'))});moduleMove.Move=Real;
      await hub.restoreReady;
      await new Promise(r=>hub.server.listen(port,'127.0.0.1',r));
      const base='http://127.0.0.1:'+hub.server.address().port;
      const get=(p,headers={})=>fetch(base+p,{headers});
      const post=(p,body={},headers={'X-Hub':'1'})=>fetch(base+p,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal((await get('/api/move/status')).status,403);
      assert.equal((await post('/api/move/export',{}, {'X-Hub':'1',Origin:'https://elsewhere.invalid'})).status,403);
      hub.executionGate.barrier=true;
      assert.equal((await post('/api/move/export')).status,409);hub.executionGate.barrier=false;
      let release;const hold=new Promise(r=>release=r),inventory=move.inventory.bind(move);let once=true;
      move.inventory=async(...a)=>{if(once){once=false;await hold;}return inventory(...a);};
      assert.equal((await post('/api/move/export')).status,202);
      assert.equal(move.running,true);
      const deadline=Date.now()+15000;while(!hub.executionGate.barrier&&move.running&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
      assert.equal(hub.executionGate.barrier,true);
      assert.equal((await post('/api/move/export')).status,409);
      assert.equal((await get('/api/state')).status,409);
      assert.equal((await get('/api/ping')).status,200);
      release();for(let n=0;n<1000&&move.running;n++)await new Promise(r=>setTimeout(r,10));
      assert.equal(move.status().mode,'exported',JSON.stringify(move.status()));assert.equal(hub.executionGate.barrier,false);
      const s=await(await get('/api/move/status',{'X-Hub':'1'})).json();
      assert.equal(s.mode,'exported');assert.ok(fs.existsSync(path.join(s.path,'manifest.json')));
      assert.equal((await post('/api/move/reveal')).status,200);
      assert.equal((await post('/api/move/import')).status,409);
      hub.sessions.stopAll();hub.server.closeAllConnections();await new Promise(r=>hub.server.close(r));
      console.log('isolated normal move routes OK');process.exit(0);
    })().catch(e=>{console.error(e);process.exit(1);});
  `;
  const out = execFileSync(process.execPath, ['-e', script], { timeout: 30000, encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: f.oldHome, HUB_ROOT: f.root, HUB_PORT: '0', HUB_LANG: 'ja', HUB_DRY_RUN: '1',
    HUB_AI_HOME: path.join(f.oldHome, 'isolated-ai'), HUB_FREETALK_HOME: f.oldHome,
    HUB_AUTO_TRANSLATE: '0', HUB_AUTO_UPDATE: '0', HUB_STORAGE_GUARD: '', HUB_UPDATE_SOURCE: '', HUB_UPDATE_APP: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
  } });
  assert.match(out, /isolated normal move routes OK/);
});

test('browser credential aliases with ignorable Unicode never export or import', async t => {
  for (const name of ['web\u200cchat','we\uFEFFbchat','webchat\u200d']) {
    const f=fixture(t),rel='_hub/'+name;
    put(path.join(f.root,rel,'Cookies'),'private');
    const {name:bundleName,bundle,manifest}=await f.send();
    assert.equal(manifest.entries.some(e=>e.rel.includes(name)),false);
    changeManifest(bundle,m=>{
      if(!m.entries.some(e=>e.root==='workspace'&&e.rel==='_hub'))m.entries.push({root:'workspace',rel:'_hub',nameB64:Buffer.from('_hub').toString('base64'),type:'dir',mode:'700',size:0,sha256:null});
      m.entries.push({root:'workspace',rel,nameB64:Buffer.from(rel).toString('base64'),type:'dir',mode:'700',size:0,sha256:null});
    });
    await assert.rejects(f.dest().import({bundle:bundleName}),/移せない|ブラウザ/);
    assert.equal(fs.existsSync(f.target),false);
  }
});
test('a fresh Mac rejects credential destinations even when the declared source workspace differs and profile does not exist', async t=>{
  for(const profileRoot of [true,false]) {
    const f=fixture(t),{bundle,name}=await f.send();
    // A bundle from another workspace can still target the receiver's default
    // workspace through an external root. No source profile exists to stat.
    changeManifest(bundle,m=>{
      m.source.workspace=path.join(f.oldHome,'Documents/Other-Workspace');
      m.roots.find(r=>r.id==='workspace').orig=m.source.workspace;
      m.roots.push({id:'ext-99',orig:path.join(f.root,profileRoot?'_hub/webchat':'_hub'),project:'demo',label:'browser'});
      if(!profileRoot)m.entries.push({root:'ext-99',rel:'webchat',nameB64:Buffer.from('webchat').toString('base64'),type:'dir',mode:'700',size:0,sha256:null});
    });
    fs.mkdirSync(path.join(bundle,'data/ext-99'),{recursive:true});
    await assert.rejects(f.dest().import({bundle:name}),/ブラウザ|範囲|安全/);
    assert.equal(fs.existsSync(f.target),false);
  }
});

test('case-distinct ordinary project roots remain portable and receive distinct destinations', async t=>{
  const f=fixture(t),{bundle,name}=await f.send();
  changeManifest(bundle,m=>{
    for(const [id,folder] of [['ext-98','Regular'],['ext-99','regular']])
      m.roots.push({id,orig:path.join(f.oldHome,'Projects',folder),project:'demo',label:folder});
  });
  for(const id of ['ext-98','ext-99'])fs.mkdirSync(path.join(bundle,'data',id));
  const move=f.dest();await move.import({bundle:name});
  assert.equal(move.status().mode,'imported');
  assert.equal(fs.existsSync(path.join(f.newHome,'Projects/Regular')),true);
  assert.equal(fs.existsSync(path.join(f.newHome,'Projects/regular-2')),true);
});

test('APFS long-s workspace aliases cannot export browser profiles or duplicate the workspace', async t=>{
  const f=fixture(t),profile=path.join(f.root,'_hub/webchat/profile');
  put(path.join(profile,'Cookies'),'private-browser-cookie');
  const alias=f.root.replace('Workspace','Work\u017Fpace'),project=path.join(f.root,'Product/demo/PROJECT.md');
  put(project,read(project).replace('phases: []','  別表記: '+JSON.stringify(alias)+'\n  ブラウザ別表記: '+JSON.stringify(path.join(alias,'_hub/webchat/profile'))+'\nphases: []'));
  const {name,manifest}=await f.send();
  assert.equal(manifest.entries.some(e=>e.rel.endsWith('Cookies')),false);
  assert.equal(manifest.roots.some(r=>r.orig===alias),false);
  await f.dest().import({bundle:name});
  assert.equal(fs.existsSync(path.join(f.target,'_hub/webchat')),false);
  assert.equal(read(path.join(f.newHome,'Projects/日本語の本体/src/アプリ.txt')),'プロジェクト本体\n');
});
test('an APFS Unicode alias of a workspace parent cannot export account configuration', async t=>{
  const f=fixture(t),parent=path.join(f.oldHome,'Document\u017F'),project=path.join(f.root,'Product/demo/PROJECT.md');
  put(path.join(f.root,'_hub/accounts.json'),'private-account');
  put(project,read(project).replace('phases: []','  親の別表記: '+JSON.stringify(parent)+'\nphases: []'));
  if(fs.existsSync(parent)) {
    // On APFS this alias resolves to the actual Documents directory.
    assert.equal(fs.statSync(parent).ino,fs.statSync(path.dirname(f.root)).ino);
    await assert.rejects(f.source.export(),/保存場所全体/);
  } else {
    const inv=await f.source.inventory(false);
    assert.equal(inv.roots.some(r=>r.orig===parent),false);
  }
});
test('fresh-Mac imports reject long-s credential destinations before collision relocation', async t=>{
  for(const parent of [false,true]) {
    const f=fixture(t),{bundle,name}=await f.send();
    changeManifest(bundle,m=>{
      m.source.workspace=path.join(f.oldHome,'Documents/Other-Workspace');
      m.roots.find(r=>r.id==='workspace').orig=m.source.workspace;
      const alias=f.root.replace('Workspace','Work\u017Fpace');
      m.roots.push({id:'ext-99',orig:parent?path.dirname(alias).replace('Documents','Document\u017F'):path.join(alias,'_hub/webchat'),project:'demo',label:'alias'});
      if(parent)for(const rel of ['AI-Work\u017Fpace','AI-Work\u017Fpace/_hub','AI-Work\u017Fpace/_hub/webchat'])
        m.entries.push({root:'ext-99',rel,nameB64:Buffer.from(rel).toString('base64'),type:'dir',mode:'700',size:0,sha256:null});
    });
    fs.mkdirSync(path.join(bundle,'data/ext-99'));
    await assert.rejects(f.dest().import({bundle:name}),/ブラウザ/);
    assert.equal(fs.existsSync(f.target),false);
  }
});
test('Unicode parent aliases relocate external imports away from the workspace', async t=>{
  const f=fixture(t),{bundle,name}=await f.send();
  changeManifest(bundle,m=>{
    m.source.workspace=path.join(f.oldHome,'Documents/Other-Workspace');
    m.roots.find(r=>r.id==='workspace').orig=m.source.workspace;
    m.roots.push({id:'ext-99',orig:path.join(f.oldHome,'Document\u017F'),project:'demo',label:'parent'});
  });
  fs.mkdirSync(path.join(bundle,'data/ext-99'));
  const move=f.dest();await move.import({bundle:name});
  const journal=JSON.parse(read(move.journal));
  assert.ok(journal.maps.find(r=>r.id==='ext-99').to.startsWith(path.join(f.newHome,'Documents/Project Hub 引っ越し/')));
});
test('source identities preserve distinct ordinary folders even when portable case folds match', async t=>{
  const f=fixture(t),project=path.join(f.root,'Product/demo/PROJECT.md');
  const upper=path.join(f.oldHome,'Projects/Regular'),lower=path.join(f.oldHome,'Projects/regular');
  fs.mkdirSync(upper);fs.mkdirSync(lower,{recursive:true});
  put(project,read(project).replace('phases: []','  大文字: '+JSON.stringify(upper)+'\n  小文字: '+JSON.stringify(lower)+'\nphases: []'));
  const inv=await f.source.inventory(false),same=fs.statSync(upper).ino===fs.statSync(lower).ino;
  assert.equal(inv.roots.filter(r=>r.orig===upper||r.orig===lower).length,same?1:2);
  // Full folding also conflates some names that APFS itself keeps distinct.
  const a=path.join(f.oldHome,'Projects/stra\u00DFe'),b=path.join(f.oldHome,'Projects/strasse');
  fs.mkdirSync(a);fs.mkdirSync(b,{recursive:true});
  put(project,read(project).replace('phases: []','  別字1: '+JSON.stringify(a)+'\n  別字2: '+JSON.stringify(b)+'\nphases: []'));
  const next=await f.source.inventory(false),sameUnicode=fs.statSync(a).ino===fs.statSync(b).ino;
  assert.equal(next.roots.filter(r=>r.orig===a||r.orig===b).length,sameUnicode?1:2);
});

test('fresh-Mac imports reject capital sharp-S aliases of an ss credential destination', async t=>{
  for(const location of ['profile','control','parent']) {
    const f=fixture(t),{bundle,name}=await f.send();
    const target=path.join(f.newHome,'Documents/AI-Workspace-ss');
    const alias=path.join(f.oldHome,'Documents/AI-Workspace-\u1E9E');
    const orig=location==='profile'?path.join(alias,'_hub/webchat'):location==='control'?path.join(alias,'_hub'):path.join(f.oldHome,'Document\u017F');
    const prefix='AI-Workspace-\u1E9E';
    const rels=location==='profile'?[]:location==='control'?['webchat']:[prefix,prefix+'/_hub',prefix+'/_hub/webchat'];
    changeManifest(bundle,m=>{
      m.roots.push({id:'ext-99',orig,project:'demo',label:'sharp-s'});
      for(const rel of rels)m.entries.push({root:'ext-99',rel,nameB64:Buffer.from(rel).toString('base64'),type:'dir',mode:'700',size:0,sha256:null});
    });
    fs.mkdirSync(path.join(bundle,'data/ext-99'),{recursive:true});
    for(const rel of rels)fs.mkdirSync(path.join(bundle,'data/ext-99',rel));
    assert.equal(fs.existsSync(target),false);
    await assert.rejects(f.dest({root:target}).import({bundle:name}),/ブラウザ/);
    assert.equal(fs.existsSync(target),false);
    assert.equal(fs.existsSync(path.join(f.newHome,'Documents/AI-Workspace-\u1E9E/_hub/webchat')),false);
  }
});

test('local owner capabilities are excluded even with a custom run directory inside portable data', async t=>{
 const f=fixture(t),previous=process.env.HUB_AUTH_DIR;
 process.env.HUB_AUTH_DIR=path.join(f.root,'private-run');
 t.after(()=>{if(previous===undefined)delete process.env.HUB_AUTH_DIR;else process.env.HUB_AUTH_DIR=previous;});
 put(path.join(process.env.HUB_AUTH_DIR,'owner-4545.json'),'fixture-only-owner');
 put(path.join(process.env.HUB_AUTH_DIR,'headers-4545.txt'),'fixture-only-headers');
 const inv=await f.source.inventory(false);
 assert.equal(inv.entries.some(e=>e.rel.startsWith('private-run')),false);
});
