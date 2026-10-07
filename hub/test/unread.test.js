'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeMissing } = require('../lib/unread');

test('未読整理：不存在だけ消し、権限エラー・一時的なIOエラーでは保持する', () => {
  for (const code of ['EACCES','EPERM','EIO','ENOENT','ENOTDIR']) {
    const items = new Set(['project\u0000task']);
    const changed = removeMissing(items, '/work/Product', file => {
      if (file.endsWith('task.md')) throw Object.assign(new Error(code),{code});
    });
    const missing = ['ENOENT','ENOTDIR'].includes(code);
    assert.equal(changed,missing); assert.equal(items.size,missing ? 0 : 1);
  }
});

test('未読整理：不正な保存キーで別フォルダを参照せず、日本語の既存作業は保持する', () => {
  const items = new Set(['../p\u0000t', 'p\u0000../t', 'p\\x\u0000t', 'broken', '日本の人物。\u0000作業-01']);
  const seen = [];
  assert.equal(removeMissing(items,'/work/Product',file=>seen.push(file)),true);
  assert.deepEqual([...items],['日本の人物。\u0000作業-01']);
  assert.deepEqual(seen,[
    '/work/Product/日本の人物。/PROJECT.md',
    '/work/Product/日本の人物。/.ai/tasks/作業-01.md',
  ]);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'hub-unread-'));
const root = path.join(tmp,'workspace'), dir = path.join(root,'Product','通知の試験');
const key = task => '通知の試験\u0000'+task;
const file = path.join(root,'_hub/unread.json');
let server, base;
test.before(async () => {
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
  fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: 通知の試験\nphases: []\n---\n');
  fs.writeFileSync(path.join(dir,'.ai/tasks/parent.md'),'---\nid: parent\ntitle: 本作業\nstate: 実行中\n---\n');
  fs.writeFileSync(path.join(dir,'.ai/tasks/child.md'),'---\nid: child\ntitle: 子作業\nkind: derived\nderivedFrom: parent\nstate: 実行中\n---\n');
  fs.writeFileSync(file,JSON.stringify({items:[key('parent'),key('child'),key('gone'),'無いプロジェクト\u0000old']}));
  process.env.PATH = '/usr/bin:/bin'; // 本物のAIを発見・起動させない。
  process.env.HUB_ROOT=root; process.env.HUB_PORT='0'; process.env.HUB_DRY_RUN='1';
  process.env.HUB_AI_HOME=path.join(tmp,'ai-home'); process.env.HUB_TRASH=path.join(tmp,'trash');
  ({server}=require('../server'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  await new Promise(r=>server.close(r));
  process.env.HUB_PORT=String(port); delete require.cache[require.resolve('../server')];
  ({server}=require('../server'));
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  base='http://127.0.0.1:'+port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));});
const state = async()=> (await fetch(base+'/api/state')).json();
const post = (route,task,extra={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},
  body:JSON.stringify({project:'通知の試験',task,...extra})});

test('未読整理：起動前の消えた作業・プロジェクトの通知を保存記録からも消す',async()=>{
  const s=await state();
  assert.deepEqual(s.unread,[{project:'通知の試験',task:'parent'},{project:'通知の試験',task:'child'}]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).items,[key('parent'),key('child')]);
});

test('引渡し後は子作業の未読を消し、本作業を未読にして成果と復元記録を残す',async()=>{
  const document=path.join(dir,'資料.txt');fs.writeFileSync(document,'原文');
  fs.appendFileSync(path.join(dir,'.ai/tasks/child.md'),'\n## 手順\n- [x] 完成\n');
  const d=await (await post('/api/task/handup/preview','child',{paths:['資料.txt']})).json();assert.deepEqual(d.blockers,[]);
  assert.equal((await post('/api/task/handup','child',{token:d.token,selected:['project:資料.txt'],confirm:true})).status,200);
  const p=await (await post('/api/task/integrate/preview','parent')).json();
  const r=await post('/api/task/absorb','parent',{token:p.token,selected:[{project:'通知の試験',task:'child',files:['project:資料.txt']}],confirm:true});assert.equal(r.status,200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).items,[key('parent')]);assert.deepEqual((await state()).unread,[{project:'通知の試験',task:'parent'}]);
  const receipt=new (require('../lib/task-transfer').TaskTransfer)({store:{root}}).read('通知の試験','child');assert.equal(fs.readFileSync(receipt.files[0].to,'utf8'),'原文');assert.equal(fs.readFileSync(document,'utf8'),'原文');assert.ok(require('../lib/chat').read(dir,'parent').some(r=>r.child==='child'&&r.text.includes('最終確認')));
  assert.equal((await post('/api/task/read','parent')).status,200);assert.deepEqual((await state()).unread,[]);
});
