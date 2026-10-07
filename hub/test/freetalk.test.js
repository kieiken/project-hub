'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../lib/store');
const { Freetalk, TOPIC_RULE, guard } = require('../lib/freetalk');
const { Removal } = require('../lib/remove');
const { ProjectOrder, siblings, integrators, finished } = require('../lib/project-order');
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-freetalk-unit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const store = new Store(path.join(tmp, 'root')), ft = new Freetalk(store, path.join(tmp, 'home'));
  return { tmp, store, ft };
}
const pick = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
test('常設IDの別表記は親・派生元・ネストした統合対象でも拒否し、通常名は維持', () => {
  for (const id of ['freetalk','FreeTalk','FREETALK']) {
    for (const body of [{project:id}, {parent:id}, {derivedFrom:id+'/topic'},
      {only:[{childProject:id}]}, {selected:[{ancestorProject:id}]}, {items:[{targetProject:id}]},
      {before:[id],order:[id]}]) assert.match(guard('/api/task/new',body), /常設/);
    assert.match(guard('/api/project/new',{name:' '+id+' '}), /常設/);
  }
  assert.equal(guard('/api/task/new',{project:'FreeTalk Notes'}),'');
  assert.equal(guard('/api/chat/send',{project:'freetalk',text:'FreeTalk'}),'');
  assert.match(guard('/api/chat/send',{project:'FreeTalk',text:'相談'}), /freetalk/);
});
test('Storeは非正規の常設IDを解決せず、予約名を新規作成しない', t => {
  const {store,ft}=fixture(t); ft.ensure();
  for(const id of ['FreeTalk','FREETALK']) {
    assert.equal(store.projectDir(id),null); assert.equal(store.readProject(id),null);
    assert.match(store.createProject({name:id}).error,/常設/);
  }
  assert.match(store.createProject({name:'freetalk'}).error,/常設/);
  assert.equal(store.createProject({name:'FreeTalk Notes'}).project.id,'FreeTalk Notes');
  assert.equal(store.readProject('freetalk').kind,'freetalk');
});
test('削除tokenだけのapplyも対象を再検証し常設枠を移さない', t => {
  const {store,ft,tmp}=fixture(t); ft.ensure();
  const removal=new Removal({store,trash:path.join(tmp,'trash')});
  for(const project of ['freetalk','FreeTalk','FREETALK']) {
    assert.throws(()=>removal.preview(project),/常設|ありません/);
    // 旧版で発行された確認が残っていても、applyの再検証で拒否する。
    removal.tokens.set(project,{at:Date.now(),d:{project,task:''}});
    assert.throws(()=>removal.apply({token:project,confirm:true}),/常設|ありません/);
  }
  assert.ok(fs.existsSync(path.join(ft.ledger,'PROJECT.md')));
  assert.ok(fs.existsSync(path.join(ft.dir,'AGENTS.md'))); assert.equal(fs.existsSync(removal.trash),false);
});
test('初回だけ登録・短いAI設定、再起動でも人の設定と話題を保持', t => {
  const { store, ft } = fixture(t);
  assert.deepEqual(ft.ensure(), { ready: true, reason: '' });
  const file = path.join(ft.dir, 'AGENTS.md'), original = fs.readFileSync(file, 'utf8');
  assert.ok(original.length < 500); assert.match(original, /別の話題に分けますか/);
  assert.deepEqual(fs.readdirSync(ft.dir).sort(), ['.ai','AGENTS.md','CLAUDE.md']);
  const topic = ft.createTopic(pick); fs.appendFileSync(file, '\n人の設定');
  const project = fs.readFileSync(path.join(ft.ledger, 'PROJECT.md'));
  const restart = new Freetalk(store, ft.home); assert.equal(restart.ensure().ready, true);
  assert.deepEqual(fs.readFileSync(path.join(ft.ledger, 'PROJECT.md')), project);
  assert.equal(fs.readFileSync(file, 'utf8'), original + '\n人の設定');
  assert.equal(store.readProject('freetalk').tasks[0].id, topic.id);
});
for (const side of ['dir','ledger']) test('同名の既存 ' + side + ' を上書きも取り込みもしない', t => {
  const { ft } = fixture(t); fs.mkdirSync(ft[side], { recursive: true });
  const file = path.join(ft[side], 'original.txt'); fs.writeFileSync(file, '元資料');
  const result = ft.ensure(); assert.equal(result.ready, false); assert.match(result.reason, /同名|既に/);
  assert.equal(fs.readFileSync(file, 'utf8'), '元資料');
  assert.deepEqual(fs.readdirSync(ft[side]), ['original.txt']);
  assert.equal(fs.existsSync(ft[side === 'dir' ? 'ledger' : 'dir']), false);
});
test('リンク先を既存専用フォルダや設定として採用しない', t => {
  const { ft, tmp } = fixture(t);
  fs.mkdirSync(path.dirname(ft.dir), { recursive: true }); fs.mkdirSync(path.join(tmp, 'external'));
  fs.symlinkSync(path.join(tmp, 'external'), ft.dir);
  assert.equal(ft.ensure().ready, false); assert.deepEqual(fs.readdirSync(path.join(tmp,'external')), []);
  fs.unlinkSync(ft.dir); assert.equal(ft.ensure().ready, true);
  fs.unlinkSync(path.join(ft.dir,'AGENTS.md')); fs.symlinkSync(path.join(tmp, 'external'), path.join(ft.dir,'AGENTS.md'));
  assert.equal(new Freetalk(ft.store,ft.home).ensure().ready, false);
});
test('話題は単調な別ID・軽い形式・最初の発言だけ短い題名、添付も話題ごと', t => {
  const { store, ft } = fixture(t); ft.ensure();
  const a = ft.createTopic(pick), b = ft.createTopic(pick); assert.notEqual(a.id,b.id);
  for (const topic of [a,b]) {
    assert.equal(topic.freetalk,true); assert.equal(topic.completionPending,false);
    assert.equal(topic.workdir,ft.dir); assert.deepEqual(topic.steps,[]); assert.equal(topic.phase,''); assert.equal(topic.parent,'');
    assert.equal(topic.model,pick.model); assert.equal(topic.effort,pick.effort);
    assert.doesNotMatch(fs.readFileSync(store.taskFile('freetalk',topic.id),'utf8'), /## 手順|## 次にやること/);
  }
  ft.nameTopic(a.id, '  海辺の旅行\n相談 🏝️ ' + 'あ'.repeat(70));
  const title = store.readTask(store.taskFile('freetalk',a.id)).title; assert.equal(Array.from(title).length,40);
  assert.ok(title.startsWith('海辺の旅行 相談')); ft.nameTopic(a.id,'改名しない');
  assert.equal(store.readTask(store.taskFile('freetalk',a.id)).title,title);
  assert.equal(store.readTask(store.taskFile('freetalk',b.id)).title,'新しい話題');
  const file = ft.upload(a.id,'../同名.txt',Buffer.from('資料'));
  assert.ok(file.startsWith(path.join(ft.dir,'topics',a.id)+path.sep));
  assert.equal(fs.readFileSync(file,'utf8'),'資料'); assert.match(ft.prompt(store.readProject('freetalk'),a),new RegExp(TOPIC_RULE));
});
test('通常の固定・兄弟順を維持し常設枠を別扱い、統合先にしない', t => {
  const { store, ft } = fixture(t); ft.ensure();
  const template = path.join(__dirname,'../../docs/project-hub/templates/project');
  const a = store.createProject({name:'A'},template).project, b = store.createProject({name:'B'},template).project;
  const order = new ProjectOrder(store); order.pin({project:a.id,pinned:true,before:false});
  assert.equal(siblings(store.listProjects(),'',{},order.readPins())[0].id,'A');
  const before = siblings(store.listProjects(),'').map(p=>p.id); order.save({parent:'',before,order:before});
  assert.throws(()=>order.pin({project:'freetalk',pinned:true,before:false}),/常設/);
  assert.throws(()=>order.save({parent:'',before,order:['freetalk',...before]}),/常設/);
  const topic = ft.createTopic(pick); assert.equal(finished({...topic,state:'完了'}),false);
  assert.deepEqual(integrators(store.readProject('freetalk'),topic,store.listProjects()),[]);
  assert.ok(!require('../lib/empty').scan(store,()=>false).some(x=>x.project==='freetalk'));
  assert.equal(guard('/api/task/integrate',{project:b.id,only:[{project:'freetalk',task:topic.id}]}).includes('常設'),true);
  assert.equal(guard('/api/hierarchy/order',{parent:'',before,order:before}),'');
});
