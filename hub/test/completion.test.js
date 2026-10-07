'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { setScalar } = require('../lib/frontmatter');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Product/p'); fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true });
  const project = path.join(dir, 'PROJECT.md'), task = path.join(dir, '.ai/tasks/t.md');
  fs.writeFileSync(project, '---\nname: P\nstatus: 進行中\nphases:\n  - { name: A, state: 完了 }\n  - { name: B, state: 進行中 }\n  - { name: C, state: 未着手 }\n---\n');
  fs.writeFileSync(task, '---\ntitle: T\nstate: 完了\n---\n## 手順\n- [x] one\n');
  return { root, project, task, store: new Store(root) };
}
test('legacy completion is preserved once; subsequent AI completion needs approval and stale approval fails', t => {
  const f = fixture(t), get = () => f.store.readTask(f.task);
  assert.equal(get().state, '完了');
  fs.writeFileSync(f.task, setScalar(fs.readFileSync(f.task, 'utf8'), 'state', '実行中')); get();
  fs.writeFileSync(f.task, setScalar(fs.readFileSync(f.task, 'utf8'), 'state', '完了'));
  assert.equal(get().state, '完了確認待ち'); assert.equal(get().completionPending, true);
  assert.equal(f.store.decideTask('p', 't', 'approve', 'old').status, 409);
  assert.equal(f.store.decideTask('p', 't', 'continue', get().completionHash).completionPending, false);
  assert.equal(get().state, '実行中');
  f.store.addStep('p','t','two'); f.store.setStep('p','t',1,true);
  assert.equal(get().completionPending, true); assert.equal(get().state, '実行中');
  assert.equal(f.store.decideTask('p', 't', 'approve', get().completionHash).state, '完了');
  fs.appendFileSync(f.task, '\nAI changed context\n'); assert.equal(get().state, '完了確認待ち');
});
test('approving current phase cannot approve a later AI-completed phase', t => {
  const f = fixture(t);
  fs.writeFileSync(f.project, fs.readFileSync(f.project,'utf8').replace('C, state: 未着手', 'C, state: 完了'));
  let p = f.store.readProject('p'); assert.equal(p.phases[2].completionPending, true);
  p = f.store.nextPhase('p'); assert.equal(p.phases[1].state, '完了');
  assert.equal(p.phases[2].state, '進行中');
  f.store.continuePhase('p');
  fs.writeFileSync(f.project, fs.readFileSync(f.project,'utf8').replace('C, state: 進行中', 'C, state: 完了'));
  assert.equal(f.store.readProject('p').phases[2].completionPending, true);
});
test('lost/corrupt approval ledger restores pending items and preserves the corrupt file', t => {
  const f = fixture(t), file = path.join(f.root, '_hub/completion.json');
  fs.writeFileSync(file, 'broken'); const s = new Store(f.root);
  assert.equal(s.readTask(f.task).state, '完了確認待ち'); assert.ok(s.completion.warning);
  assert.ok(fs.readdirSync(path.dirname(file)).some(x=>x.startsWith('completion.json.corrupt-')));
  assert.equal(s.readProject('p').phases[0].completionPending, true);
});
test('a partial read cannot discard phase approval; project approval does not approve phases', t => {
 const f=fixture(t);
 const original=fs.readFileSync(f.project,'utf8');fs.writeFileSync(f.project,'');f.store.readProject('p');fs.writeFileSync(f.project,original);
 assert.equal(f.store.readProject('p').phases[0].state,'完了');
 fs.writeFileSync(f.project,original.replace('C, state: 未着手','C, state: 完了'));
 f.store.setProjectStatus('p','完了');f.store.setProjectStatus('p','進行中');
 assert.equal(f.store.readProject('p').phases[2].completionPending,true);
 const done=f.store.readTask(f.task);f.store.updateTask('p','t',{memo:'Human note'});assert.equal(f.store.readTask(f.task).state,'完了');
});

test('approved step edits and new work have intentional completion behavior', t=>{const f=fixture(t); assert.equal(f.store.setStep('p','t',0,true).state,'完了'); assert.equal(f.store.addStep('p','t','new work').state,'実行中');});
