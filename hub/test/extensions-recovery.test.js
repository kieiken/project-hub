'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { excluded } = require('../../scripts/export-public');
const source = path.resolve(__dirname, '..');
const hasBundle = fs.existsSync(path.join(source, 'paid'));
const project = 'サンプルアプリ', task = 'sample-app-01';
const restartMessage = 'Hubの再起動で見直しを中断しました。設定と最終見直し日時は維持しています';

function fixture(t, mode) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-extension-recovery-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const hub = path.join(temp, 'source/hub'), root = path.join(temp, 'workspace');
  fs.cpSync(source, hub, { recursive: true, filter: file => {
    const name = 'hub/' + path.relative(source, file).split(path.sep).join('/') + (fs.statSync(file).isDirectory() ? '/' : '');
    return mode === 'bundled' ? !name.includes('/node_modules/') : !excluded(name);
  } });
  if (mode === 'missing') fs.writeFileSync(path.join(hub, 'paid-bundle.json'), JSON.stringify({ version: 1, features: ['discussion', 'role_review'] }));
  execFileSync('/bin/bash', [path.join(source, 'setup.sh')], { env: { ...process.env, HOME: temp, HUB_ROOT: root, HUB_SKIP_NPM: '1', HUB_SKIP_APP: '1' }, stdio: 'ignore' });
  const pdir = path.join(root, 'Product', project), rolesFile = path.join(root, '_hub/roles.yaml');
  const projectFile = path.join(pdir, 'PROJECT.md'), taskFile = path.join(pdir, '.ai/tasks', task + '.md');
  fs.writeFileSync(projectFile, fs.readFileSync(projectFile, 'utf8').replace(/^(  [^\n:]+:\s*)~\/[^\n]*$/gm, (_line, label) => label + pdir));
  fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace(/^workdir:.*$/m, 'workdir:'));
  const history = require('../lib/role-history'), current = history.load(rolesFile);
  history.updateReview(rolesFile, null, j => {
    j.lastReviewedAt = '2026-10-10T00:00:00Z';
    j.review = { id: 'stale-review', project, task, request: 'role-review-stale-review-0', status: 'running' };
  });
  const normal = [{ id: 'ordinary-before', text: '人の通常の依頼', ai: 'codex', nested: { unchanged: true } }, { id: 'ordinary-after', text: '文中に discussion- があっても通常の依頼', error: '既存の保留', stopHeld: true }];
  const discussion = ['discussion-stale-0', 'limit-discussion-stale-1', 'limit-limit-discussion-stale-2'].map(id => ({ id, ai: 'codex', text: '話し合いの残り' }));
  const review = ['role-review-stale-review-0', 'limit-role-review-stale-review-0'].map(id => ({ id, ai: 'codex', text: '見直しの残り' }));
  const delegates=[{id:'old-user-delegate',origin:'delegate',ai:'codex',text:'利用者の委任'}, {id:'new-internal',origin:'hub-internal',ai:'codex',text:'内部整理'}, {id:'old-internal',origin:'delegate',selectionOnly:true,ai:'codex',text:'履歴整理'}];
  const automation={id:'old-idea-run',origin:'delegate',ai:'codex',text:'old automatic request',automation:{kind:'idea',runId:'old'}};
  if(mode!=='bundled'){
    const {Ideas}=require('../lib/ideas'),ideaStore={root,readProject:id=>id===project?{id:project,dir:pdir,tasks:[{id:task}]}:null},ideas=new Ideas({store:ideaStore});
    ideas.add(project,{opId:require('node:crypto').randomUUID(),text:'FREE-RECOVERY-IDEA',intent:'record'},{human:true});
    ideas.internal(project,require('node:crypto').randomUUID(),{seed:true},d=>{d.settings.auto.enabled=true;d.runs.old={id:'old',delivery:'unknown',closed:false,targets:[]};});ideas.close();
  }
  const queueFile = path.join(pdir, '.ai/chat', task + '.queue.json');
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, JSON.stringify([normal[0], ...discussion, ...review, ...delegates, ...(mode==='bundled'?[]:[automation]), normal[1]]));
  const otherFile = path.join(root, 'Product/サンプルサイト/.ai/chat/sample-site-01.queue.json');
  const other = [{ id: 'unrelated-user-turn', text: '別作業はそのまま' }];
  fs.mkdirSync(path.dirname(otherFile), { recursive: true }); fs.writeFileSync(otherFile, JSON.stringify(other));
  const env = { ...process.env, HOME: temp, PATH: '/usr/bin:/bin', HUB_ROOT: root, HUB_AI_HOME: temp, HUB_FREETALK_HOME: path.join(temp, 'home'), HUB_DRY_RUN: '1', HUB_LANG: 'ja', HUB_PORT: String(50000 + Math.floor(Math.random() * 5000)), TEST_HUB: hub, TEST_MODE: mode };
  return { temp, hub, root, rolesFile, queueFile, otherFile, env, current, normal, discussion, delegates, other };
}

function bootProbe() {
  const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
  const hub = process.env.TEST_HUB, root = process.env.HUB_ROOT, fixture = JSON.parse(process.env.TEST_EXPECTED);
  // No activation/network/Keychain work or real AI. Production guards remain.
  require(path.join(hub, 'lib/license')).License.prototype.prepare = async () => {};
  const app = require(path.join(hub, 'server'));
  const history = require(path.join(hub, 'lib/role-history'));
  (async () => {
    await app.restoreReady;
    const journal = history.load(path.join(root, '_hub/roles.yaml')).journal;
    assert.equal(journal.review, null);
    assert.deepEqual(journal.history, fixture.history);
    assert.deepEqual(journal.defaults, fixture.defaults);
    assert.deepEqual(history.load(path.join(root, '_hub/roles.yaml')).roles, fixture.roles);
    assert.equal(journal.lastReviewedAt, '2026-10-10T00:00:00Z');
    assert.equal(journal.lastReview.status, 'failed');
    assert.equal(journal.lastReview.message, fixture.restartMessage);
    assert.equal(journal.lastReview.project, fixture.project); assert.equal(journal.lastReview.task, fixture.task);
    const queue = app.chats.queue(fixture.project, fixture.task);
    const internal=fixture.delegates.slice(1).map(q=>({...q,origin:'hub-internal'}));
    assert.deepEqual(queue, process.env.TEST_MODE === 'bundled' ? [fixture.normal[0], ...fixture.discussion, fixture.delegates[0], ...internal, fixture.normal[1]] : [fixture.normal[0], ...internal, fixture.normal[1]]);
    app.chats.verifyQueues();
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.otherFile, 'utf8')), fixture.other);
    // With the bundle installed, its unchanged verifier rejects stale rounds.
    if (process.env.TEST_MODE === 'bundled') assert.throws(() => app.chats.refreshQueued({ project: fixture.project, task: fixture.task, request: fixture.discussion[0].id }), /この話し合いの回は終了/);
    assert.equal(app.chats.running.size, 0);
    if(process.env.TEST_MODE!=='bundled'){
      const d=app.ideas.read(fixture.project);assert.equal(d.settings.auto.enabled,false);assert.equal(d.settings.manualPaused,true);assert.equal(d.runs.old.delivery,'unknown');assert.equal(d.runs.old.closed,false);assert.ok(app.ideas.view(fixture.project).items.some(i=>i.text==='FREE-RECOVERY-IDEA'));
    }

    await new Promise(resolve => app.server.listen(Number(process.env.HUB_PORT), '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const response = await fetch(base + '/api/state'), state = await response.json();
    assert.equal(response.status, 200, JSON.stringify(state));
    assert.ok(state.extensions, JSON.stringify(state));
    assert.equal(Boolean(state.extensions.notice), process.env.TEST_MODE === 'missing');
    const post = async (route, body) => {
      const res = await fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
    };
    const initial = state.roles;
    const saved = await post('/api/roles/default', { roles: initial.roles, expectedRevision: initial.management.revision });
    assert.ok(saved.management.defaultSavedAt);
    const changed = structuredClone(saved.roles); changed[0].main.effort = changed[0].main.effort === '高' ? '中' : '高';
    const edited = await post('/api/roles', { roles: changed, expectedRevision: saved.management.revision });
    assert.equal(edited.roles[0].main.effort, changed[0].main.effort);
    const restored = await post('/api/roles/restore', { defaults: true, expectedRevision: edited.management.revision });
    assert.deepEqual(restored.roles, initial.roles);
    assert.equal(restored.management.lastReviewedAt, '2026-10-10T00:00:00Z');
    // A second cold boot may not rewrite the interruption or repeat cleanup.
    console.log('recovery-ok:' + JSON.stringify(journal.lastReview));
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  })().catch(e => { console.error(e); process.exitCode = 1; app.server.closeAllConnections(); app.server.close(); app.chats.stopAll(); });
}

for (const mode of ['public', 'missing', 'bundled']) test('startup recovers unavailable paid leftovers and preserves free roles: ' + mode, { skip: mode === 'bundled' && !hasBundle }, t => {
  const f = fixture(t, mode), probe = path.join(f.temp, 'probe.cjs');
  fs.writeFileSync(probe, '(' + bootProbe.toString() + ')();');
  f.env.TEST_EXPECTED = JSON.stringify({ history: f.current.journal.history, defaults: f.current.journal.defaults, roles: f.current.roles, restartMessage, project, task, normal: f.normal, discussion: f.discussion, delegates:f.delegates, otherFile: f.otherFile, other: f.other });
  const first = execFileSync(process.execPath, [probe], { env: f.env, encoding: 'utf8', timeout: 30000 });
  const saved = require('../lib/role-history').load(f.rolesFile);
  f.env.TEST_EXPECTED = JSON.stringify({ ...JSON.parse(f.env.TEST_EXPECTED), history: saved.journal.history, defaults: saved.journal.defaults, roles: saved.roles });
  const second = execFileSync(process.execPath, [probe], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.match(first, /recovery-ok:/); assert.match(second, /recovery-ok:/);
  assert.equal(first.match(/recovery-ok:(.*)/)[1], second.match(/recovery-ok:(.*)/)[1]);
});

for (const failure of ['review', 'queue']) test('unconfirmed missing-bundle cleanup aborts boot: ' + failure, t => {
  const f = fixture(t, 'missing'), probe = path.join(f.temp, 'failure.cjs');
  fs.writeFileSync(probe, `
    const assert=require('node:assert/strict'),path=require('node:path'),hub=process.env.TEST_HUB;
    require(path.join(hub,'lib/license')).License.prototype.prepare=async()=>{};
    require(path.join(hub,'lib/chat')).ChatRunner.prototype.adopt=()=>{throw Error('adoption must not run after failed cleanup');};
    if(process.env.TEST_FAILURE==='review')require(path.join(hub,'lib/role-history')).updateReview=()=>{throw Error('injected review save failure');};
    else {const C=require(path.join(hub,'lib/chat')).ChatRunner,save=C.prototype.setQueue;C.prototype.setQueue=function(p,t,q,...args){if(this.queue(p,t).some(x=>x.id.startsWith('discussion-'))&&!q.some(x=>x.id.startsWith('discussion-')))throw Error('injected queue save failure');return save.call(this,p,t,q,...args);};}
    assert.throws(()=>require(path.join(hub,'server')),/injected .* save failure/);
    console.log('boot-refused');
  `);
  assert.match(execFileSync(process.execPath, [probe], { env: { ...f.env, TEST_FAILURE: failure }, encoding: 'utf8', timeout: 30000 }), /boot-refused/);
});
