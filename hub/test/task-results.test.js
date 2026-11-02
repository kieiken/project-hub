'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const git = require('../lib/git'), { verifyResults } = require('../lib/task-results');
const sh = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
function fixture(t, nested = false) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-task-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = path.join(root, 'Body'), workRoot = path.join(root, 'Work/P'), ledger = path.join(root, 'Product/P');
  fs.mkdirSync(body); fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(body, 'base.txt'), 'base');
  sh(body, 'init', '-q'); sh(body, 'config', 'user.email', 'test@localhost'); sh(body, 'config', 'user.name', 'Test');
  sh(body, 'add', '.'); sh(body, 'commit', '-qm', 'base');
  const base = nested ? path.join(body, 'app') : body;
  fs.mkdirSync(base, { recursive: true });
  if (nested) { fs.writeFileSync(path.join(base, 'app.txt'), 'app'); git.save(body, 'app'); }
  const w = git.prepare({ base, workRoot, taskId: 'child' }), task = { id: 'child', workdir: w.dir };
  fs.writeFileSync(path.join(w.dir, 'child.txt'), 'child'); git.save(w.dir, 'child');
  const commit = sh(w.dir, 'rev-parse', 'HEAD'), original = git.inspect(body);
  const p = { dir: ledger }, row = { kind: '本体保存済み', value: (nested ? 'body:../' : '.') + '@' + commit, description: 'saved' };
  if (nested) row.value = '.@' + commit; // app is not a repo root; this must remain invalid.
  const verify = (value = '.@' + commit, context = { task, workRoot }) => verifyResults([{ ...row, value }], p, base, context);
  return { root, body, base, workRoot, p, task, commit, original, verify };
}
test('所属するcleanコピーの保存済みcommitを受け付け、宣言先とcommitを統合後も保持', t => {
  const f = fixture(t);
  assert.equal(git.isAncestor(f.body, f.commit), false);
  for (const prefix of ['.', 'body:.']) {
    const before = f.verify(prefix + '@' + f.commit.slice(0, 8));
    assert.equal(before[0].dir, f.body); assert.equal(before[0].commit, f.commit);
    assert.deepEqual(git.inspect(f.body), f.original);
  }
  const before = f.verify(); sh(f.body, 'merge', '--no-ff', '--no-edit', f.commit);
  assert.deepEqual(f.verify(), before);
  assert.deepEqual(f.verify('.@' + f.commit, {}), before, '本体包含後はコピー文脈不要');
});
test('未追跡ファイルを隠す設定でも未保存コピーを拒否し、保存済みコピーは受け付ける', t => {
  const f = fixture(t), dir = f.task.workdir;
  sh(dir, 'config', 'status.showUntrackedFiles', 'no');
  const saved = f.verify(), file = path.join(dir, 'unsaved.js');
  fs.writeFileSync(file, 'unsaved source');
  assert.equal(sh(dir, 'status', '--porcelain'), '', '通常の表示では未保存ファイルが隠れる');
  assert.throws(() => f.verify(), /子の変更を保存/, '表示設定にかかわらず未保存を拒否');
  assert.equal(fs.readFileSync(file, 'utf8'), 'unsaved source', '検証で未保存ファイルを変更しない');
  fs.unlinkSync(file);
  assert.deepEqual(f.verify(), saved, '非表示設定でも保存済みコピーは有効');
  assert.deepEqual(git.inspect(f.body), f.original, '検証で本体を書き換えない');
});
for (const mode of ['contextなし', '別作業', '別作業履歴', '別作業登録', '別repo', 'clone', '未保存', 'staged', 'untracked', '非祖先', 'missing', 'symlink', 'wrong-subdir', 'project宣言', '別repo宣言'])
test('未統合commitの所属・保存条件を満たさない場合は拒否：' + mode, t => {
  const f = fixture(t); let value = '.@' + f.commit, context = { task: f.task, workRoot: f.workRoot };
  if (mode === 'contextなし') context = {};
  if (mode === '別作業') context.task = { ...f.task, id: 'other' };
  if (mode === '別作業履歴' || mode === '別作業登録') {
    const other = git.prepare({ base: f.body, workRoot: f.workRoot, taskId: 'other' }).dir;
    fs.writeFileSync(path.join(other, 'other.txt'), 'other'); git.save(other, 'other');
    if (mode === '別作業履歴') value = '.@' + sh(other, 'rev-parse', 'HEAD');
    else fs.copyFileSync(path.join(other, '.git'), path.join(f.task.workdir, '.git'));
  }
  if (mode === '別repo' || mode === 'clone') {
    const otherRoot = path.join(f.root, 'OtherWork'), dir = path.join(otherRoot, 'child'); fs.mkdirSync(otherRoot);
    if (mode === 'clone') sh(f.root, 'clone', '-q', '--no-hardlinks', f.body, dir);
    // Create an independent worktree with the expected path for this task.
    if (mode === '別repo') {
      fs.mkdirSync(dir); sh(dir, 'init', '-q'); sh(dir, 'config', 'user.email', 'test@localhost'); sh(dir, 'config', 'user.name', 'Test');
      sh(dir, 'commit', '--allow-empty', '-qm', 'unrelated');
    }
    context = { task: { ...f.task, workdir: dir }, workRoot: otherRoot };
  }
  if (['未保存', 'staged', 'untracked'].includes(mode)) {
    fs.writeFileSync(path.join(f.task.workdir, mode === 'untracked' ? 'new.txt' : 'child.txt'), 'unsaved');
    if (mode === 'staged') sh(f.task.workdir, 'add', '.');
  }
  if (mode === '非祖先') sh(f.task.workdir, 'reset', '--hard', 'HEAD~1');
  if (mode === 'missing') context.task = { id: 'missing', workdir: path.join(f.workRoot, 'missing') };
  if (mode === 'symlink') { const link = path.join(f.root, 'linked'); fs.symlinkSync(f.workRoot, link); context = { task: { ...f.task, workdir: path.join(link, 'child') }, workRoot: link }; }
  if (mode === 'wrong-subdir') { fs.mkdirSync(path.join(f.task.workdir, 'sub')); context.task = { ...f.task, workdir: path.join(f.task.workdir, 'sub') }; }
  if (mode === 'project宣言') { sh(f.p.dir, 'init', '-q'); sh(f.p.dir, 'fetch', '-q', f.body, f.commit); value = 'project:.@' + f.commit; }
  if (mode === '別repo宣言') { const dir = path.join(f.body, 'other'); fs.mkdirSync(dir); sh(dir, 'init', '-q'); sh(dir, 'fetch', '-q', f.body, f.commit); value = 'other@' + f.commit; }
  assert.throws(() => f.verify(value, context));
  if (mode !== '別repo宣言') assert.deepEqual(git.inspect(f.body), f.original, '検証で本体を書き換えない');
});
test('コピーの途中mergeも拒否、元のmerge状態は保持', t => {
  const f = fixture(t), dir = f.task.workdir;
  sh(dir, 'checkout', '-qb', 'other'); sh(dir, 'commit', '--allow-empty', '-qm', 'other'); sh(dir, 'checkout', '-q', '-');
  sh(dir, 'merge', '--no-ff', '--no-commit', 'other');
  assert.throws(() => f.verify(), /取り込みが途中/); assert.equal(git.merging(dir), true);
});
test('本体保存済みの既存経路は不正なコピー記録や未保存コピーへ範囲を広げない', t => {
  const f = fixture(t), commit = sh(f.body, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.task.workdir, 'child.txt'), 'dirty');
  const before = git.inspect(f.task.workdir);
  const result = f.verify('.@' + commit, { task: { id: 'other', workdir: f.task.workdir }, workRoot: f.workRoot });
  assert.equal(result[0].dir, f.body); assert.equal(result[0].commit, commit);
  assert.deepEqual(git.inspect(f.task.workdir), before);
});
test('本体のrepo内サブフォルダと独立repoは既存のrepo境界規則を保持', t => {
  const f = fixture(t, true);
  assert.throws(() => f.verify(), /リポジトリが見つかりません/);
});
for (const value of ['../outside@', '/absolute@', 'body:../outside@', 'other//repo@', '.hidden@', 'other\\..\\repo@'])
test('コピーの履歴があっても不正な宣言パスは拒否：' + value, t => {
  const f = fixture(t); assert.throws(() => f.verify(value + f.commit), /相対リポジトリ/);
});

test('成果の別名は緩和せず行番号・種類・正規例を示して拒否',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-result-format-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'task.md');
 fs.writeFileSync(file,'# 子\n## 成果\n- 作業用コピー保存済み：body:.@12345678\n');
 assert.throws(()=>require('../lib/task-results').readResults(file),e=>e.code==='TASK_RESULTS_FORMAT'&&e.line===3&&/未対応の種類「作業用コピー保存済み」/.test(e.message)&&/本体保存済み：body/.test(e.message));
 fs.writeFileSync(file,'## 成果\n- 本体保存済み：body:.@12345678（専用コピーへの保存）\n');assert.equal(require('../lib/task-results').readResults(file)[0].kind,'本体保存済み');
 const request=new (require('../lib/integration-simple').SimpleIntegration)({}).organizeRequest({},{title:'子'},'a'.repeat(64));
 for(const text of ['ファイル','本体保存済み','なし','別名は禁止','場所・commitを推測しない','専用コピーへの保存'])assert.ok(request.text.includes(text),text);
});
