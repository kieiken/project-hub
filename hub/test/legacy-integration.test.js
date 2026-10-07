'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const git = require('../lib/git'), {Store} = require('../lib/store');
const {Removal} = require('../lib/remove'), {TaskTransfer} = require('../lib/task-transfer'), chat = require('../lib/chat');
const at = '2026-10-06T10:09:35.295Z', date = '2026-10-06T10:09:35Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-legacy-receipt-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const body = path.join(root, 'System', 'Body'), dir = path.join(root, 'Product', 'Project Hub');
  fs.mkdirSync(body, {recursive:true}); fs.mkdirSync(dir, {recursive:true});
  const sh = (...args) => execFileSync('git', ['-C', body, ...args], {encoding:'utf8', env:{...process.env,
    GIT_AUTHOR_NAME:'fixture', GIT_AUTHOR_EMAIL:'fixture@localhost', GIT_COMMITTER_NAME:'fixture', GIT_COMMITTER_EMAIL:'fixture@localhost', GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date}}).trim();
  sh('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(body, 'base.txt'), 'base'); sh('add', '.'); sh('commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Project Hub\nphases: []\nrelated: []\n---\n');
  const store = new Store(root), parent = store.createTask('Project Hub', {title:'本作業'});
  const child = store.createTask('Project Hub', {title:'固定機能', parent:parent.id, steps:['完成']});
  store.setStep('Project Hub', child.id, 0, true);
  const record = {at, action:'merge', project:'Project Hub', task:child.id, ok:true, conflict:false};
  fs.mkdirSync(path.join(root, '_hub'), {recursive:true});
  const log = path.join(root, '_hub', 'log.jsonl'); fs.writeFileSync(log, JSON.stringify(record) + '\n');
  let sequence = 0;
  const merge = (title = child.title, count = 11) => {
    const branch = 'fixture-' + ++sequence; sh('checkout', '-qb', branch);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(body, `${branch}-${i}.txt`), 'result');
    sh('add', '.'); sh('commit', '-qm', branch); sh('checkout', '-q', 'main');
    sh('merge', '--no-ff', '-qm', `取り込み: ${child.id} ${title}`, branch);
    return sh('rev-parse', 'HEAD');
  };
  const receipt = (r = record, task = child) => git.integrationReceipt(body, r, task);
  const transfer = busy => new TaskTransfer({store, baseOf:()=>body,
    removal:new Removal({store, trash:path.join(root, 'Trash'), busy}), integration:(p,t)=>git.integrationReceipt(body, record, t)});
  return {root, body, dir, store, parent, child, sh, log, record, merge, receipt, transfer};
}
test('旧成功記録は一意の2親履歴から11ファイルを補い、証跡だけ受領し旧ログと本体を保持する', t => {
  const f = fixture(t);
  // 親で先に追加した無関係な変更は、第一親との差に混ぜない。
  fs.writeFileSync(path.join(f.body, 'parent.txt'), 'unrelated'); f.sh('add', '.'); f.sh('commit', '-qm', 'parent change');
  const commit = f.merge(), bytes = fs.readFileSync(f.log), head = f.sh('rev-parse', 'HEAD');
  const r = f.receipt(); assert.equal(r.commit, commit); assert.equal(r.recovered, true); assert.equal(r.files.length, 11);
  assert.ok(!r.files.includes('parent.txt')); assert.deepEqual(f.receipt(), r);
  const transfer = f.transfer(), d = transfer.preview('Project Hub', f.child.id, [], f.child.title);
  assert.deepEqual(d.blockers, []); assert.deepEqual(d.files, []); assert.deepEqual(d.integrated, r);
  const out = transfer.apply({project:'Project Hub', task:f.child.id, token:d.token, confirm:true, expectTitle:f.child.title});
  assert.equal(out.ok, true); assert.deepEqual(out.files, []);
  const saved = transfer.read('Project Hub', f.child.id); assert.equal(saved.complete, true); assert.deepEqual(saved.integrated, r);
  const rows = chat.read(f.dir, f.parent.id); assert.equal(rows.length, 1); assert.match(rows[0].text, /古い取り込み記録を本体の履歴と照合/);
  assert.match(rows[0].text, new RegExp(commit)); assert.match(rows[0].text, /fixture-1-10.txt/);
  assert.match(fs.readFileSync(f.store.taskFile('Project Hub', f.parent.id), 'utf8'), /古い取り込み記録を本体の履歴と照合/);
  assert.equal(f.store.taskFile('Project Hub', f.child.id), null); assert.equal(fs.existsSync(out.destination), false);
  assert.equal(f.sh('rev-parse', 'HEAD'), head); assert.equal(f.sh('status', '--porcelain'), ''); assert.deepEqual(fs.readFileSync(f.log), bytes);
  assert.equal(transfer.apply({project:'Project Hub', task:f.child.id, token:d.token, confirm:true, expectTitle:f.child.title}).duplicate, true);
  assert.equal(chat.read(f.dir, f.parent.id).length, 1);
});
test('同じ番号の別名・改名・番号不一致・失敗ログ・無効日時は補わない', t => {
  const f = fixture(t); f.merge('確認'); assert.equal(f.receipt(), null);
  const d = f.transfer().preview('Project Hub', f.child.id); assert.equal(d.integrated, null); assert.ok(d.blockers.some(x=>x.includes('成果の記録がありません')));
  f.merge(); assert.equal(f.receipt({...f.record, ok:false}), null);
  assert.equal(f.receipt({...f.record, at:'invalid'}), null); assert.equal(f.receipt({...f.record, task:'other'}), null);
  assert.equal(f.receipt(f.record, {...f.child, title:'改名'}), null); assert.equal(f.receipt(f.record, null), null);
});
test('一致する履歴が複数なら補わず、時刻±10秒の外は補わない', t => {
  const f = fixture(t); f.merge();
  assert.ok(f.receipt({...f.record, at:'2026-10-06T10:09:45Z'}));
  assert.ok(f.receipt({...f.record, at:'2026-10-06T10:09:25Z'}));
  assert.equal(f.receipt({...f.record, at:'2026-10-06T10:09:45.001Z'}), null);
  assert.equal(f.receipt({...f.record, at:'2026-10-06T10:09:24.999Z'}), null);
  f.merge(); assert.equal(f.receipt(), null);
});
test('HEAD祖先でない取り込みと単一親の同件名は補わない', t => {
  const f = fixture(t), before = f.sh('rev-parse', 'HEAD'), commit = f.merge(), files = f.receipt().files; f.sh('checkout', '-qb', 'other-head', before);
  assert.equal(f.receipt(), null);
  assert.equal(f.receipt({...f.record, main:f.body, commit, files}), null);
  fs.writeFileSync(path.join(f.body, 'single.txt'), 'single'); f.sh('add', '.'); f.sh('commit', '-qm', `取り込み: ${f.child.id} ${f.child.title}`);
  assert.equal(f.receipt(), null);
});
test('同件名・同時刻でも3親の取り込みは旧証跡として採用しない', t => {
  const f = fixture(t);
  for (const branch of ['one', 'two']) {
    f.sh('checkout', '-qb', branch, 'main'); fs.writeFileSync(path.join(f.body, branch+'.txt'), branch);
    f.sh('add', '.'); f.sh('commit', '-qm', branch);
  }
  f.sh('checkout', '-q', 'main'); f.sh('merge', '--no-ff', '-qm', `取り込み: ${f.child.id} ${f.child.title}`, 'one', 'two');
  assert.equal(f.sh('show', '-s', '--format=%P', 'HEAD').split(' ').length, 3); assert.equal(f.receipt(), null);
});
test('現行の証跡は従来の形を維持し、不完全な現行証跡を旧記録扱いにしない', t => {
  const f = fixture(t), commit = f.merge(), files = f.receipt().files;
  const modern = {...f.record, main:f.body, commit, files};
  assert.deepEqual(f.receipt(modern), {dir:f.body, commit, files, github:null});
  for (const partial of [{main:f.body}, {commit}, {files}, {files:null}, {main:null}]) assert.equal(f.receipt({...f.record, ...partial}), null);
  assert.equal(f.receipt({...modern, main:path.join(f.root, 'Other')}), null);
  assert.equal(f.receipt({...modern, commit:'f'.repeat(40)}), null);
});
test('旧証跡を補っても本作業AI中のpreview/apply保護を維持し、保存・通知・片付けをしない', t => {
  const f = fixture(t); f.merge(); const bytes = fs.readFileSync(f.log);
  const transfer = f.transfer((p,id)=>id===f.parent.id), d = transfer.preview('Project Hub', f.child.id);
  assert.equal(d.integrated.recovered, true); assert.ok(d.blockers.some(x=>x.includes('本作業でAI')));
  assert.throws(()=>transfer.apply({project:'Project Hub', task:f.child.id, token:d.token, confirm:true}), /本作業でAI/);
  assert.equal(transfer.read('Project Hub', f.child.id), null); assert.equal(chat.read(f.dir, f.parent.id).length, 0);
  assert.ok(f.store.taskFile('Project Hub', f.child.id)); assert.deepEqual(fs.readFileSync(f.log), bytes);
});
