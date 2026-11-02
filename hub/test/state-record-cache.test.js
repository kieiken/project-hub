'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const {TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),close=require('../lib/integration-consultation-close');
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'record-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store={root},transfer=new TaskTransfer({store,removal:{}}),h=new TaskIntegrate({store,transfer,removal:{}});return {root,transfer,h};}
const write=(f,r)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(r));};
test('pending observes external additions, atomic replacements, corrupt/recovered files and removals immediately',t=>{
 const {transfer}=fixture(t),a=transfer.file('P','a'),b=transfer.file('P','b');
 assert.deepEqual(transfer.pending(),[]);write(a,{project:'P',task:'a',title:'one'});assert.equal(transfer.pending()[0].title,'one');
 const result=transfer.pending();result[0].title='mutated';result.push({});assert.equal(transfer.pending().length,1);assert.equal(transfer.pending()[0].title,'one');
 write(a+'.tmp',{project:'P',task:'a',title:'two'});fs.renameSync(a+'.tmp',a);assert.equal(transfer.pending()[0].title,'two');
 write(b,{project:'P',task:'b'});assert.equal(transfer.pending().length,2);fs.writeFileSync(a,'broken');assert.equal(transfer.pending().length,1);
 write(a,{project:'P',task:'a',complete:true});assert.equal(transfer.pending().length,1);fs.unlinkSync(b);assert.deepEqual(transfer.pending(),[]);
 write(a,{project:'P',task:'a'});assert.equal(transfer.pending().length,1);
});
test('warm pending rejects replacement links and directory links without returning cached content',t=>{
 const {transfer}=fixture(t),f=transfer.file('P','a');write(f,{project:'P',task:'a'});assert.equal(transfer.pending().length,1);
 const other=path.join(transfer.dir,'other');fs.renameSync(f,other);fs.symlinkSync(other,f);assert.deepEqual(transfer.pending(),[]);
 fs.unlinkSync(f);fs.renameSync(other,f);assert.equal(transfer.pending().length,1);
 const moved=transfer.dir+'-moved';fs.renameSync(transfer.dir,moved);fs.symlinkSync(moved,transfer.dir);assert.throws(()=>transfer.pending(),/リンク/);
});
test('pending detects same-size writes even when mtime is restored, and local save invalidates it',t=>{
 const {transfer}=fixture(t),f=transfer.file('P','a');write(f,{project:'P',task:'a',title:'one'});const stat=fs.statSync(f);assert.equal(transfer.pending()[0].title,'one');
 write(f,{project:'P',task:'a',title:'two'});fs.utimesSync(f,stat.atime,stat.mtime);assert.equal(transfer.pending()[0].title,'two');
 transfer.save({project:'P',task:'a',title:'end',complete:true});assert.deepEqual(transfer.pending(),[]);
});
test('integration pending includes both lanes, isolates nested output and refreshes the mutation guard',t=>{
 const {h}=fixture(t),r={id:randomUUID(),project:'P',task:'a',items:[{project:'P',task:'child',title:'child',state:'未開始'}],auto:{stopped:{reason:'stop'}}};
 const f=h.file('P','a'),side=path.join(h.dir,'siblings',path.basename(h.file('P','b')));write(f,r);write(side,{...r,task:'b'});
 const first=h.pending();assert.equal(first.length,2);first[0].auto.stopped.reason='changed';first[0].items[0].title='changed';assert.equal(h.pending()[0].auto.stopped.reason,'stop');assert.equal(h.pending()[0].items[0].title,'child');
 write(f,{...r,items:r.items.map(x=>({...x,state:'保持受領済み'})),complete:true,auto:{main:{state:'done'}}});assert.equal(h.pending().length,1);
 fs.unlinkSync(side);assert.deepEqual(h.pending(),[]);write(f,r);assert.equal(h.pending().length,1);
});
function closure(f){const id=randomUUID(),p='P',t='task',file=path.join(f.h.dir,'consultation-closures',path.basename(f.h.file(p,t))),dir=path.join(path.dirname(file),id);
 const originals=['primary','sibling','offer','hold'].map(kind=>{const file=path.join(dir,kind+'.json');write(file,{id:kind});return {kind,file,sha256:hash(fs.readFileSync(file))};});
 write(file,{version:1,id,project:p,task:t,stage:'intent',originals});return {file,originals,p,t};}
test('closure rechecks pinned original bytes, missing files, hardlinks and symlinks after a warm hit',t=>{
 for(const mode of ['changed','missing','hardlink','symlink']){
  const f=fixture(t),r=closure(f);assert.equal(close.read(f.h,r.p,r.t).stage,'intent');assert.equal(close.pending(f.h).length,1);
  const target=r.originals[0].file,stat=fs.statSync(target);
  if(mode==='changed'){fs.writeFileSync(target,'{"id":"changed"}');fs.utimesSync(target,stat.atime,stat.mtime);}
  if(mode==='missing')fs.unlinkSync(target);
  if(mode==='hardlink')fs.linkSync(target,target+'.other');
  if(mode==='symlink'){fs.renameSync(target,target+'.other');fs.symlinkSync(target+'.other',target);}
  assert.throws(()=>close.read(f.h,r.p,r.t));assert.throws(()=>close.pending(f.h));
 }
});
test('closure copies returned records and immediately observes external phase transitions',t=>{
 const f=fixture(t),r=closure(f),a=close.read(f.h,r.p,r.t);a.stage='complete';a.originals.length=0;assert.equal(close.pending(f.h).length,1);
 const stored=JSON.parse(fs.readFileSync(r.file));write(r.file,{...stored,stage:'complete'});assert.deepEqual(close.pending(f.h),[]);assert.equal(close.read(f.h,r.p,r.t).originals.length,4);
});
test('closure listing keeps rejecting non-scalar identities after removing the redundant parse',t=>{
 const f=fixture(t),r=closure(f),stored=JSON.parse(fs.readFileSync(r.file));
 const malformed={...stored,project:{name:'P'}},file=path.join(path.dirname(r.file),path.basename(f.h.file(malformed.project,r.t)));
 fs.unlinkSync(r.file);write(file,malformed);assert.throws(()=>close.pending(f.h));
});
test('unchanged pending performs metadata checks but no record-content reads',t=>{
 const f=fixture(t);for(let i=0;i<12;i++)write(f.transfer.file('P',String(i)),{project:'P',task:String(i),text:'large'.repeat(1000)});
 f.transfer.pending();const native=require('../lib/platform/file-io'),old=native.readFileSync;let reads=0;native.readFileSync=function(file,...args){if(String(file).startsWith(f.transfer.dir))reads++;return old.call(this,file,...args);};
 try{assert.equal(f.transfer.pending().length,12);assert.equal(reads,0);write(f.transfer.file('P','1'),{project:'P',task:'1',title:'new'});assert.equal(f.transfer.pending().length,12);assert.equal(reads,1);}finally{native.readFileSync=old;}
});
