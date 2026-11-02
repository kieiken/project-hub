'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-state-offers-'));
const root = path.join(tmp, 'root'), home = path.join(tmp, 'home');
fs.mkdirSync(home); fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
Object.assign(process.env, { HUB_ROOT: root, HOME: home, HUB_FREETALK_HOME: home, HUB_DRY_RUN: '1', HUB_PORT: String(51000 + Math.floor(Math.random() * 1000)) });
const { Store } = require('../lib/store'), { TaskTransfer } = require('../lib/task-transfer');
const { TaskIntegrate } = require('../lib/task-integrate'), { StateOffers } = require('../lib/state-offers');
const store = new Store(root), p = store.createProject({ name: 'Fixture' }).project;
const parent = store.createTask(p.id, { title: '親' }), child = store.createTask(p.id, { title: '子', parent: parent.id, steps: ['完成'] });
store.setStep(p.id, child.id, 0, true); store.appendSection(p.id, child.id, '成果', '- なし：保存成果なし');
const receipt = path.join(root, '_hub/task-handoffs', createHash('sha256').update(p.id + '\0' + child.id).digest('hex') + '.json');
fs.mkdirSync(path.dirname(receipt), { recursive: true });
const transfer=new TaskTransfer({store,removal:new (require('../lib/remove').Removal)({store})}), current=store.readTask(store.taskFile(p.id,child.id));
fs.writeFileSync(receipt,JSON.stringify({id:'received',complete:true,retained:true,project:p.id,task:child.id,received:[{id:'received',head:null,target:{project:p.id,task:parent.id,dir:p.dir},files:[],manifest:[],results:transfer.verifyResults(require('../lib/task-results').readResults(store.taskFile(p.id,child.id)),p,current),taskHash:current.completionHash}]}));
let refreshed=0,heavy=0,asyncPreviews=0,view;
const readWorker=require('../lib/integration-read-worker'),integration=readWorker.integration;
readWorker.integration=function(...args){asyncPreviews++;return integration.apply(this,args);};
const refresh=StateOffers.prototype.refresh, details=TaskIntegrate.prototype.details;
StateOffers.prototype.refresh=function(...args){refreshed++;view=this;return refresh.apply(this,args);};
TaskIntegrate.prototype.details=function(...args){heavy++;return details.apply(this,args);};
const { server } = require('../server');
test('正式HTTP：受領検査は別スレッド、任意POSTで捨てず、記録変更・期限は再検査', async () => {
  await new Promise(resolve => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const now = Date.now; let offset = 0; Date.now = () => now() + offset;
  const state = async () => { const r = await fetch(base + '/api/state', { headers: { 'X-Hub': '1' } }); assert.equal(r.status, 200); return r.json(); };
  const row = s => s.taskOffers.find(x => x.task === child.id && x.targetTask === parent.id);
  const settled=async()=>{for(let i=0;i<100;i++){const s=await state();if(!row(s).pending)return s;await new Promise(r=>setTimeout(r,20));}assert.fail('receipt never settled: '+JSON.stringify(view.cache));};
  try {
    assert.equal(row(await settled()).pending,false); assert.equal(heavy,0);
    // 成果の表示検査は1秒単位で再検査するため、ここでは対象手順を未済へ戻して受領検査だけを観察。
    store.setStep(p.id,child.id,0,false);
    await state();for(let i=0;i<100&&view.pending;i++)await new Promise(r=>setTimeout(r,20));await state();
    const before=refreshed;
    const denied=await fetch(base+'/api/term/input',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:'{}'});
    assert.ok(denied.status>=400);await state();assert.equal(refreshed,before);assert.equal(heavy,0);
    offset=60001;await state();assert.equal(refreshed,before+1);
    const raw=JSON.stringify({project:p.id,task:child.id,received:{}});fs.writeFileSync(receipt,raw);
    const s=await state();assert.equal(row(s).pending,true);assert.ok(row(s).reason);assert.equal(row(s).received,null);
    assert.equal(fs.readFileSync(receipt,'utf8'),raw);
    const preview=await fetch(base+'/api/task/integrate/preview',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:p.id,task:parent.id})});
    assert.equal(preview.status,409);assert.ok((await preview.json()).error);assert.equal(asyncPreviews,1);assert.equal(heavy,0);
  } finally {
    Date.now = now;readWorker.integration=integration; StateOffers.prototype.refresh=refresh;TaskIntegrate.prototype.details=details;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
