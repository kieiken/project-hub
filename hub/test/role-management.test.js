'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), vm=require('node:vm');
const history=require('../lib/role-history'), roles=require('../lib/roles');
const seed='models:\n  claude-code: [Opus 5.5, Fable 5.2]\n  codex: [GPT-6.1-Sol]\nroles:\n  文章: { main: [claude-code, Opus 5.5, 中], backup: [codex, GPT-6.1-Sol, 高], job: 説明文 }\nswitch:\n  auto: true\npermissions:\n  publish: false\n';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-role-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'roles.yaml');fs.writeFileSync(file,seed);return file;}
function edit(file,effort,at,extra={}){const current=history.load(file),next=structuredClone(current.roles);next[0].main.effort=effort;const out=roles.write(file,next,undefined,true,undefined,{at,expectedRevision:current.revision,...extra});assert.equal(out.ok,true,out.errors?.join(' / '));return history.load(file);}

test('baseline persists once, changes alone add history, defaults and unrelated policy stay fixed',t=>{
  const file=fixture(t),base=history.load(file,undefined,'2026-10-10T00:00:00Z'),text=fs.readFileSync(file,'utf8');
  assert.equal(base.journal.defaults,null);assert.equal(history.load(file).journal.history.length,1);assert.equal(fs.readFileSync(file,'utf8'),text);
  const changed=edit(file,'高','2026-10-11T00:00:00Z');assert.equal(changed.journal.history.length,2);
  assert.deepEqual(changed.journal.defaults,base.journal.defaults);
  const before=fs.readFileSync(file,'utf8');assert.equal(roles.write(file,changed.roles).ok,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.deepEqual(roles.read(file).data.switch,{auto:true});assert.deepEqual(roles.read(file).data.permissions,{publish:false});
});
test('date boundaries, multiple changes, empty days, and restore of restore retain exact snapshots',t=>{
  const file=fixture(t);const base=history.load(file,undefined,'2026-10-10T15:00:00Z');
  edit(file,'高','2026-10-11T01:00:00Z');const latest=edit(file,'MAX','2026-10-11T14:59:59Z');
  edit(file,'極高','2026-10-11T15:00:00Z');const j=history.load(file).journal;
  assert.throws(()=>history.select(j,{before:'2026-10-10T15:00:00Z'}),/記録されていません/);
  assert.equal(history.select(j,{before:'2026-10-11T15:00:00Z'}).roles[0].main.effort,'MAX');
  assert.equal(history.select(j,{before:'2026-10-14T15:00:00Z'}).roles[0].main.effort,'極高');
  assert.equal(history.select(j,{id:latest.journal.history.at(-1).id}).roles[0].main.effort,'MAX');
  const before=history.load(file);assert.equal(roles.write(file,base.roles,undefined,true,undefined,{restore:true,kind:'restore'}).ok,true);
  assert.equal(roles.write(file,before.roles,undefined,true,undefined,{restore:true,kind:'restore'}).ok,true);
  assert.equal(history.load(file).journal.history.length,6);assert.deepEqual(history.load(file).journal.defaults,base.journal.defaults);
});
test('compare-and-save rejects stale editors; rename failure leaves both settings and journal intact',t=>{
  const file=fixture(t),old=history.load(file);edit(file,'高');const text=fs.readFileSync(file,'utf8');
  const stale=roles.write(file,old.roles,undefined,true,undefined,{expectedRevision:old.revision});assert.equal(stale.status,409);assert.equal(fs.readFileSync(file,'utf8'),text);
  const rename=fs.renameSync;fs.renameSync=()=>{throw Error('disk failure');};
  try{const out=roles.write(file,old.roles,undefined,true);assert.equal(out.ok,false);assert.equal(fs.readFileSync(file,'utf8'),text);}finally{fs.renameSync=rename;}
  assert.equal(fs.readdirSync(path.dirname(file)).length,1);
});
test('direct file edit is recorded without overwriting fixed defaults and comments remain intact',t=>{
  const file=fixture(t),base=history.load(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Opus 5.5, 中','Opus 5.5, 高')+'# human final comment\n');
  const next=history.load(file);assert.equal(next.journal.history.length,2);assert.equal(next.journal.history.at(-1).kind,'edit');assert.deepEqual(next.journal.defaults,base.journal.defaults);
  const before=fs.readFileSync(file,'utf8');history.load(file);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(before.endsWith('# human final comment\n'));
});
test('browser day selection uses local midnight including DST and does not invent a pre-baseline record',()=>{
  const old=process.env.TZ;process.env.TZ='America/New_York';
  try{const c=vm.createContext({document:{addEventListener(){}},Date});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/role-settings.js'),'utf8'),c);
    assert.equal(c.roleDayBefore('2026-03-08'),'2026-03-09T04:00:00.000Z');assert.equal(c.roleDayBefore('2026-11-01'),'2026-11-02T05:00:00.000Z');assert.equal(c.roleDayBefore('2026-02-30'),'');
    assert.equal(c.roleHistorySelection([{id:'one',at:'2026-03-09T04:00:00Z'}],'2026-03-08',''),undefined);
  }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});

test('defaults are opt-in; displayed draft saves without applying roles or changing review time/history, and stale saves are rejected',t=>{
  const file=fixture(t),base=history.load(file),draft=structuredClone(base.roles);draft[0].main.effort='高';
  assert.equal(history.summary(base).defaultSavedAt,'');
  const out=roles.saveDefault(file,draft,base.revision);assert.equal(out.ok,true);
  const saved=history.load(file);assert.deepEqual(saved.roles,base.roles);assert.deepEqual(saved.journal.defaults.roles,draft);
  assert.deepEqual(saved.journal.history,base.journal.history);assert.equal(saved.journal.lastReviewedAt,'');
  assert.equal(roles.saveDefault(file,base.roles,base.revision).status,409);
  assert.equal(roles.saveDefault(file,[],saved.revision).status,400);
  edit(file,'MAX');assert.deepEqual(history.load(file).journal.defaults,saved.journal.defaults);
  const revision=history.load(file).revision;
  assert.equal(roles.saveDefault(file,base.roles,revision).ok,true);assert.deepEqual(history.load(file).journal.defaults.roles,base.roles);
  const before=fs.readFileSync(file,'utf8'),rename=fs.renameSync;fs.renameSync=()=>{throw Error('disk full');};
  try{assert.equal(roles.saveDefault(file,draft,history.load(file).revision).ok,false);assert.equal(fs.readFileSync(file,'utf8'),before);}finally{fs.renameSync=rename;}
});
test('v1 automatic defaults migrate to unset without losing the old snapshot or history',t=>{
  const file=fixture(t),base=history.load(file),old={at:'2026-10-10T00:00:00Z',roles:base.roles};
  history.updateReview(file,null,j=>{j.version=1;j.defaults=old;});
  const migrated=history.load(file);assert.equal(migrated.journal.version,2);assert.equal(migrated.journal.defaults,null);
  assert.deepEqual(migrated.journal.legacyDefaults,old);assert.deepEqual(migrated.journal.history,base.journal.history);
  roles.saveDefault(file,base.roles,migrated.revision);assert.ok(history.load(file).journal.defaults);
});
