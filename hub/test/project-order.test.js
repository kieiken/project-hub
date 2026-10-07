'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { Store } = require('../lib/store');
const { ProjectOrder, siblings, displayParent } = require('../lib/project-order');
const client = require('../public/project-order');
const ids = items => items.map(p => p.id);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, name, parent] of [['a','Alpha',''],['b','Beta',''],['c','Child','Alpha'],['d','Child','a'],['orphan','Orphan','missing']]) {
    const dir = path.join(root, 'Product', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: ${name}\nparent: ${parent}\nstatus: 進行中\n---\nDo not change\n`);
  }
  const store = new Store(root), order = new ProjectOrder(store);
  return { root, store, order };
}
test('shared parent rules: stable ID, unique names, ambiguity, orphan, cycles, derived siblings', () => {
  const all = [{id:'a',name:'Same'}, {id:'b',name:'Same'}, {id:'c',parent:'Same'}, {id:'d',parent:'a'}, {id:'e',parent:'x'}, {id:'f',parent:'g'}, {id:'g',parent:'f'}, {id:'h',derivedFrom:'a'}];
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/project-order.js'),'utf8'), context);
  const expected = ['', '', '', 'a', '', '', '', ''];
  assert.deepEqual(all.map(p => displayParent(p,all)), expected);
  assert.deepEqual(all.map(p => context.ProjectOrder.displayParent(p,all)), expected);
  assert.deepEqual(ids(siblings(all, '', {'':['b','a']})), ['c','e','f','g','b','a','h']);
});
test('saved siblings survive rename/reload, new comes first, deletion/restore keeps slot even across moves', t => {
  const { store, order } = fixture(t), all = store.listProjects(), before = ids(siblings(all,'',{}));
  const after = before.slice().reverse(); order.save({parent:'',before,order:after});
  assert.deepEqual(ids(siblings(all,'',new ProjectOrder(store).read())),after);
  const changed = all.map(p => ({...p, name:p.id==='b'?'Renamed':p.name}));
  assert.deepEqual(ids(siblings(changed,'',order.read())),after);
  assert.deepEqual(ids(siblings([{id:'new'},...all],'',order.read())),['new',...after]);
  const missing = after[1], shortened = all.filter(p=>p.id!==missing), remaining = ids(siblings(shortened,'',order.read()));
  order.store = {root:store.root,listProjects:()=>shortened};
  order.save({parent:'',before:remaining,order:remaining.slice().reverse()});
  assert.equal(order.read()[''][1],missing);
  assert.equal(ids(siblings(all,'',order.read()))[1],missing);
  assert.deepEqual(ids(siblings(shortened,'',order.read())),remaining.slice().reverse());
});
test('only one group saved; ledgers byte-identical; stale, duplicate, cross-parent and incomplete requests keep file', t => {
  const {store, order, root}=fixture(t), all=store.listProjects(), originals=all.map(p=>[p.dir,fs.readFileSync(path.join(p.dir,'PROJECT.md'))]);
  const before=ids(siblings(all,'a')); order.save({parent:'a',before,order:before.slice().reverse()});
  const child=order.read().a;
  const roots=ids(siblings(all,'')); order.save({parent:'',before:roots,order:roots.slice().reverse()});
  assert.deepEqual(order.read().a,child);
  const saved=fs.readFileSync(order.file);
  for(const body of [{parent:'',before:roots,order:roots}, {parent:'a',before:child,order:['a','c']}, {parent:'a',before:child,order:['c','c']}, {parent:'a',before:child,order:['c']}, {parent:'missing',before:[],order:[]}, {parent:'a',before:'bad',order:child}]) {
    assert.throws(()=>order.save(body),/並びが変わりました/);assert.deepEqual(fs.readFileSync(order.file),saved);
  }
  originals.forEach(([dir,bytes])=>assert.deepEqual(fs.readFileSync(path.join(dir,'PROJECT.md')),bytes));
  assert.equal(fs.readdirSync(path.join(root,'_hub')).filter(x=>x.endsWith('.tmp')).length,0);
});
test('corrupt persisted data defaults safely; read failure does not silently overwrite saved order', t => {
  const {order,store}=fixture(t);fs.mkdirSync(path.dirname(order.file),{recursive:true});
  for (const text of ['{','null','{"groups":[]}','{"groups":{"": ["a","a"]}}','{"groups":{"": [4]}}']) {
    fs.writeFileSync(order.file,text);assert.deepEqual(order.read(),{});
    assert.deepEqual(ids(siblings(store.listProjects(),'',order.read())),ids(siblings(store.listProjects(),'')));
  }
  fs.unlinkSync(order.file);fs.mkdirSync(order.file);
  assert.throws(()=>order.save({parent:'',before:[],order:[]}),/EISDIR/);
});

test('HTTP order endpoint uses fixture ROOT, validates snapshot, keeps state order/ledgers, allows authenticated remote', async t => {
  const {root,store}=fixture(t), net=require('net');
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.writeFileSync(path.join(root,'_hub/roles.yaml'),'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nroles: {}\n');
  Object.assign(process.env,{HUB_ROOT:root,HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'ai-home'),HUB_TRASH:path.join(root,'trash')});
  const {server,sessions}=require('../server');await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{sessions.stopAll();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const url=`http://127.0.0.1:${port}`, post=(body,extra={})=>fetch(url+'/api/hierarchy/order',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  const state=await (await fetch(url+'/api/state')).json(), before=ids(siblings(state.projects,'')), order=before.slice().reverse();
  const bytes=store.listProjects().map(p=>[p.dir,fs.readFileSync(path.join(p.dir,'PROJECT.md'))]);
  assert.equal((await post({parent:'',before,order})).status,200);
  const later=await (await fetch(url+'/api/state')).json();assert.deepEqual(ids(later.projects),ids(state.projects));assert.deepEqual(ids(siblings(later.projects,'',later.projectOrder)),order);
  const file=path.join(root,'_hub/project-order.json'), saved=fs.readFileSync(file);
  for(const body of [{parent:'',before,order},{parent:'',before:order,order:['c',...order.slice(1)]},{parent:'',before:order,order:order.slice(1)},{parent:'',before:order,order:order.map(()=>order[0])}]) assert.equal((await post(body)).status,409);
  assert.equal((await post({parent:'',before:order,order:before},{'X-Forwarded-For':'100.1.1.1'})).status,403);
  // 未認証は拒否し、ログイン済みなら同じ競合検査で保存する。
  const remoteHeaders = {'X-Forwarded-For':'100.1.1.1'};
  const request = (route,body,extra={}) => fetch(url+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await request('/api/remote',{enabled:true,passcode:'fixture-passcode'})).status,200);
  const login = await request('/api/login',{passcode:'fixture-passcode'},remoteHeaders);
  assert.equal(login.status,200); remoteHeaders.Cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post({parent:'',before:order,order:before},remoteHeaders)).status,200);
  assert.equal((await post({parent:'',before:order,order:before},remoteHeaders)).status,409);
  const pin = body => request('/api/hierarchy/pin',body,remoteHeaders);
  assert.equal((await pin({project:'b',before:false,pinned:true})).status,200);
  assert.equal((await pin({project:'b',before:false,pinned:true})).status,409);
  const pinnedState=await (await fetch(url+'/api/state')).json();
  assert.deepEqual(pinnedState.projectPins,['b']);
  assert.equal(siblings(pinnedState.projects,'',pinnedState.projectOrder,pinnedState.projectPins)[0].id,'b');
  assert.equal((await pin({project:'b',before:true,pinned:false})).status,200);
  assert.equal((await pin({project:'b',before:true,pinned:false})).status,409);
  assert.deepEqual((await (await fetch(url+'/api/state')).json()).projectPins,[]);
  assert.deepEqual(ids(siblings(store.listProjects(),'',JSON.parse(fs.readFileSync(file)).groups)),before);bytes.forEach(([dir,data])=>assert.deepEqual(fs.readFileSync(path.join(dir,'PROJECT.md')),data));
});

test('分岐は元と同じ段・新規分岐は元の近く、保存済みの並び順と子の階層は維持',()=>{
 const all=[{id:'p',name:'親'},{id:'c',name:'子',parent:'p'},{id:'d',name:'子の分岐',parent:'c',derivedFrom:'c'},{id:'e',name:'親の分岐',parent:'p',derivedFrom:'p'}];
 assert.equal(displayParent(all[2],all),'p');assert.equal(displayParent(all[3],all),'');assert.deepEqual(ids(siblings(all,'p')),['c','d']);assert.deepEqual(ids(siblings(all,'p',{p:['d','c']})),['d','c']);assert.deepEqual(ids(siblings(all,'')),['p','e']);
 const p={id:'p',tasks:[{id:'base'},{id:'kid',parent:'base',kind:'main'},{id:'branch',kind:'derived',parent:'kid',derivedFrom:'p/base'},{id:'kidbranch',kind:'derived',derivedFrom:'p/kid'}]};
 assert.deepEqual(client.taskItems(p).map(x=>x.parent),['','base','','base']);assert.equal(client.taskTarget(p,p.tasks[1]).task.id,'base');assert.equal(client.taskTarget(p,p.tasks[2]).task.id,'base');assert.equal(client.taskTarget(p,p.tasks[3]).task.id,'kid');
});

test('保存順にない新分岐だけ元へ寄せ、元や明示移動済み分岐の順序を保ちサーバーへ保存できる', t => {
 const {store,order}=fixture(t);
 const all=[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'},
  {id:'fork',derivedFrom:'c'},{id:'fork2',derivedFrom:'fork'},{id:'manual',derivedFrom:'c'},
  {id:'kid',parent:'c'},{id:'kid2',parent:'c'},{id:'kidfork',derivedFrom:'kid2',parent:'kid2'}];
 const groups={'':['manual','b','a','c'],c:['kid','kid2']};
 assert.deepEqual(ids(siblings(all,'',groups)),['manual','b','a','c','fork','fork2']);
 assert.deepEqual(ids(siblings(all,'c',groups)),['kid','kid2','kidfork']);
 assert.deepEqual(ids(siblings(all,'',{'':['a','b','c']})),['a','b','c','fork','fork2','manual']);
 const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/project-order.js'),'utf8'),context);
 for(const parent of ['', 'c']) assert.deepEqual(Array.from(context.ProjectOrder.siblings(all,parent,groups),p=>p.id),ids(siblings(all,parent,groups)));
 order.store={root:store.root,listProjects:()=>all};fs.mkdirSync(path.dirname(order.file),{recursive:true});fs.writeFileSync(order.file,JSON.stringify({groups}));
 for(const parent of ['', 'c']) {
  const before=ids(siblings(all,parent,order.read())), after=before.slice().reverse();
  order.save({parent,before,order:after});assert.deepEqual(ids(siblings(all,parent,order.read())),after);
 }
 assert.throws(()=>order.save({parent:'',before:['fork','fork2','manual','b','a','c'],order:['manual','b','a','c','fork','fork2']}),/並びが変わりました/);
});


test('pins survive reload/rename/restore, stay above new projects, preserve ledgers and normal order on unpin', t => {
  const {store, order}=fixture(t), all=store.listProjects();
  const originals=all.map(p=>[p.dir,fs.readFileSync(path.join(p.dir,'PROJECT.md'))]);
  const before=ids(siblings(all,'')); order.save({parent:'',before,order:before.slice().reverse()});
  const groups=order.read(), originalOrder=fs.readFileSync(order.file);
  order.pin({project:'b',before:false,pinned:true});order.pin({project:'d',before:false,pinned:true});
  const reload=new ProjectOrder(store);
  assert.deepEqual(reload.readPins(),['b','d']);
  assert.equal(siblings([{id:'new'},...all],'',groups,reload.readPins())[0].id,'b');
  assert.equal(siblings(all,'a',groups,reload.readPins())[0].id,'d');
  assert.equal(siblings(all.map(p=>({...p,name:'Changed'})),'',groups,reload.readPins())[0].id,'b');
  assert.ok(reload.readPins().includes('b')); // absent projects keep their pin for restoration
  assert.ok(!siblings(all.filter(p=>p.id!=='b'),'',groups,reload.readPins()).some(p=>p.id==='b'));
  const pinnedOrder=ids(siblings(all,'',groups,reload.readPins()));
  assert.throws(()=>reload.save({parent:'',before:pinnedOrder,order:pinnedOrder.slice().reverse()}),/固定/);
  const pinBytes=fs.readFileSync(path.join(store.root,'_hub/project-pins.json'));
  for(const body of [{project:'b',before:false,pinned:false},{project:'missing',before:false,pinned:true},{project:'a',before:false,pinned:'true'}]) assert.throws(()=>reload.pin(body),/固定/);
  assert.deepEqual(fs.readFileSync(path.join(store.root,'_hub/project-pins.json')),pinBytes);
  reload.pin({project:'b',before:true,pinned:false});
  assert.deepEqual(ids(siblings(all,'',groups,reload.readPins())),before.slice().reverse());
  assert.deepEqual(fs.readFileSync(order.file),originalOrder);
  originals.forEach(([dir,bytes])=>assert.deepEqual(fs.readFileSync(path.join(dir,'PROJECT.md')),bytes));
});

test('multiple pins can reorder within the fixed group and keep pins after ordering', t => {
  const {store,order}=fixture(t),all=store.listProjects();
  for(const project of ['a','b'])order.pin({project,before:false,pinned:true});
  const before=ids(siblings(all,'',order.read(),order.readPins()));
  const next=['b','a',...before.filter(id=>id!=='a'&&id!=='b')];
  order.save({parent:'',before,order:next});
  assert.deepEqual(ids(siblings(all,'',order.read(),order.readPins())),next);
  assert.deepEqual(order.readPins(),['a','b']);
});
