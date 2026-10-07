'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
const gitw=require('../lib/git');
function fixture(t,opts={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-remove-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 const project=(id,extra='')=>write(path.join(root,'Product',id,'PROJECT.md'),`---\nname: ${id}\nfolders: {}\nrelated: []\n${extra}---\n`);
 project('Parent');project('Child','parent: Parent\n');const store=new Store(root);const t1=store.createTask('Child',{title:'Task'}),t2=store.createTask('Child',{title:'Other'});
 const dir=path.join(root,'Product/Child'),chat=write(path.join(dir,'.ai/chat',t1.id+'.jsonl'),'original chat');
 const r=new Removal({store,trash:path.join(root,'Trash'),...opts});return {root,dir,write,project,store,r,task:t1.id,other:t2.id,chat};
}
function copyFixture(t,opts={},taskId){
 const f=fixture(t,opts),main=path.join(f.root,'System/Body');fs.mkdirSync(main,{recursive:true});
 if(taskId){const file=f.store.taskFile('Child',f.task),dest=path.join(f.dir,'.ai/tasks',taskId+'.md'),text=fs.readFileSync(file,'utf8').replace('id: '+f.task,'id: '+taskId);fs.renameSync(file,dest);fs.writeFileSync(dest,text);const chat=path.join(f.dir,'.ai/chat',taskId+'.jsonl');fs.renameSync(f.chat,chat);f.task=taskId;f.chat=chat;}
 const sh=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sh(main,'init','-q');sh(main,'config','user.name','Fixture');sh(main,'config','user.email','fixture@localhost');
 f.write(path.join(main,'file.txt'),'original');f.write(path.join(main,'.gitignore'),'ignored\n');sh(main,'add','.');sh(main,'commit','-qm','initial');
 f.project('Child',`parent: Parent\nfolders:\n  本体: ${main}\n`);
 const copy=gitw.prepare({base:main,workRoot:path.join(f.root,'Work/Child'),taskId:f.task}).dir;
 f.store.updateTask('Child',f.task,{workdir:copy});return {...f,main,copy,sh};
}
test('unchanged linked copy appears in deletion preview, moves with Git registration, and restores bytes and task record',t=>{
 const f=copyFixture(t),head=f.sh(f.main,'rev-parse','HEAD'),taskFile=f.store.taskFile('Child',f.task),before=fs.readFileSync(taskFile);
 f.write(path.join(f.main,'ignored'),'local ignored data');f.write(path.join(f.copy,'ignored'),'local ignored data');
 const d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);assert.equal(d.move[0].path,f.copy);assert.ok(d.move[0].copy);assert.equal(d.keep[0].path,f.main);
 const out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,true);assert.equal(fs.existsSync(f.copy),false);assert.equal(fs.existsSync(taskFile),false);assert.equal(f.sh(f.main,'rev-parse','HEAD'),head);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries[0];
 assert.equal(f.sh(e.to,'status','--porcelain'),'');assert.match(f.sh(f.main,'worktree','list','--porcelain'),new RegExp(e.to.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.equal(f.r.restore(out.record,true).restored,r.entries.length);assert.equal(f.sh(f.copy,'rev-parse','HEAD'),head);assert.equal(f.sh(f.copy,'status','--porcelain'),'');assert.equal(fs.readFileSync(path.join(f.copy,'ignored'),'utf8'),'local ignored data');assert.deepEqual(fs.readFileSync(taskFile),before);assert.equal(f.r.history()[0].restored,true);
});
test('unmerged commits, staged changes, unstaged changes, and untracked files keep copy and task',t=>{
 for(const kind of ['commit','staged','unstaged','untracked','ignored']){
  const f=copyFixture(t);f.write(path.join(f.copy,kind==='untracked'?'new.txt':kind==='ignored'?'ignored':'file.txt'),'changed');
  if(kind==='staged'||kind==='commit')f.sh(f.copy,'add','.');if(kind==='commit')f.sh(f.copy,'commit','-qm','unique');
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/未保存または未統合|保存対象外/);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));assert.equal(fs.existsSync(f.copy),true);assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);
 }
});
test('deletion detects untracked files hidden by status configuration and refuses index flags that suppress changes',t=>{
 for(const kind of ['untracked','assume-unchanged','skip-worktree']){
  const f=copyFixture(t);
  if(kind==='untracked')f.sh(f.copy,'config','status.showUntrackedFiles','no');
  else f.sh(f.copy,'update-index','--'+kind,'file.txt');
  f.write(path.join(f.copy,kind==='untracked'?'new.txt':'file.txt'),'hidden unsaved data');
  assert.equal(f.sh(f.copy,'status','--porcelain'),'');
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/未保存|変更検出/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/未保存|変更検出/);
  assert.equal(fs.readFileSync(path.join(f.copy,kind==='untracked'?'new.txt':'file.txt'),'utf8'),'hidden unsaved data');
  assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('hidden changes introduced after clean preview also prevent deletion; unchanged flagged copies stay until flags are cleared',t=>{
 for(const kind of ['untracked','assume-unchanged','skip-worktree']){
  const f=copyFixture(t),d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);
  if(kind==='untracked')f.sh(f.copy,'config','status.showUntrackedFiles','no');
  else {
   f.sh(f.copy,'update-index','--'+kind,'file.txt');
   assert.match(f.r.preview('Child',f.task).blockers.join(' '),/変更検出/);
  }
  f.write(path.join(f.copy,kind==='untracked'?'new.txt':'file.txt'),'hidden after preview');
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/未保存|変更検出/);
  assert.equal(fs.existsSync(f.copy),true);
  if(kind!=='untracked'){
   f.write(path.join(f.copy,'file.txt'),'original');f.sh(f.copy,'update-index','--no-'+kind,'file.txt');
   const out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).ok,true);
  }
 }
});
test('copy sharing uses filesystem identity for differently cased task and project references, including descendants',t=>{
 for(const kind of ['task','folder'])for(const suffix of ['', '/nested', '/nested/missing']){
  const f=copyFixture(t),alias=f.copy.replace('/Work/Child/','/work/child/');
  if(!fs.existsSync(alias)){t.skip('filesystem is case-sensitive');return;}
  assert.equal(fs.statSync(alias).ino,fs.statSync(f.copy).ino);assert.equal(fs.statSync(alias).dev,fs.statSync(f.copy).dev);
  fs.mkdirSync(path.join(f.copy,'nested'));
  if(kind==='task')f.store.updateTask('Child',f.other,{workdir:alias+suffix});
  else f.project('Another',`folders:\n  参考: ${alias+suffix}\n`);
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/他の記録/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);assert.equal(fs.existsSync(f.copy),true);
 }
});
test('copy sharing follows reference links but leaves separate similarly named copies eligible',t=>{
 for(const kind of ['task','folder']){
  const f=copyFixture(t),sibling=f.copy+'-separate',alias=path.join(f.root,'reference');fs.mkdirSync(sibling);fs.mkdirSync(path.join(f.copy,'nested'));
  const record=ref=>kind==='task'?f.store.updateTask('Child',f.other,{workdir:ref}):f.project('Another',`folders:\n  参考: ${ref}\n`);
  record(sibling);assert.deepEqual(f.r.preview('Child',f.task).blockers,[]);
  fs.symlinkSync(path.join(f.copy,'nested'),alias);record(path.join(alias,'missing'));
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/他の記録/);assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);
 }
});
test('copy sharing resolves link targets before parent segments for task and project references',t=>{
 for(const kind of ['task','folder','relative-folder'])for(const suffix of ['/..','/../file.txt']){
  const f=copyFixture(t),alias=path.join(f.root,'reference');fs.mkdirSync(path.join(f.copy,'nested'));
  // 相対リンクの先も、参照文字列の .. より先に辿る。
  fs.symlinkSync(path.relative(f.root,path.join(f.copy,'nested')),alias);
  const ref=alias+suffix;
  assert.equal(fs.statSync(ref).ino,fs.statSync(suffix==='/..'?f.copy:path.join(f.copy,'file.txt')).ino);
  if(kind==='task')f.store.updateTask('Child',f.other,{workdir:ref});
  else f.project('Another',`folders:
  参考: ${kind==='relative-folder'?'../../reference'+suffix:ref}
`);
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/他の記録/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);
  assert.equal(fs.existsSync(ref),true);assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('copy sharing protects dangling and chained link targets beneath the copy',t=>{
 for(const kind of ['task','folder'])for(const chained of [false,true]){
  const f=copyFixture(t),alias=path.join(f.root,'reference'),target=path.join(f.copy,'absent');
  fs.symlinkSync(path.relative(f.root,target),alias);
  let ref=alias+'/future';
  if(chained){const outer=path.join(f.root,'outer');fs.symlinkSync('reference',outer);ref=outer+'/future';}
  assert.equal(fs.existsSync(ref),false);
  if(kind==='task')f.store.updateTask('Child',f.other,{workdir:ref});else f.project('Another',`folders:
  参考: ${ref}
`);
  const d=f.r.preview('Child',f.task);assert.match(d.blockers.join(' '),/他の記録/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);
  assert.equal(fs.readFileSync(path.join(f.copy,'file.txt'),'utf8'),'original');assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('new sharing records and retargeted links after preview prevent moving the copy',t=>{
 for(const kind of ['task','folder'])for(const dangling of [false,true])for(const change of ['record','link']){
  const f=copyFixture(t),alias=path.join(f.root,'reference'),sibling=path.join(f.root,'separate');
  fs.mkdirSync(sibling);fs.mkdirSync(path.join(sibling,'nested'));fs.mkdirSync(path.join(f.copy,'nested'));
  const target=base=>path.join(base,dangling?'absent':'nested'),ref=alias+(dangling?'/future':'/..');
  const record=()=>kind==='task'?f.store.updateTask('Child',f.other,{workdir:ref}):f.project('Another',`folders:
  参考: ${ref}
`);
  fs.symlinkSync(target(change==='record'?f.copy:sibling),alias);if(change==='link')record();
  const d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);
  if(change==='record')record();else {fs.unlinkSync(alias);fs.symlinkSync(target(f.copy),alias);}
  const file=kind==='task'?f.store.taskFile('Child',f.other):path.join(f.root,'Product/Another/PROJECT.md'),before=fs.readFileSync(file);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);
  assert.equal(f.sh(f.copy,'status','--porcelain'),'');assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('references that traverse the copy before reaching an outside sibling keep the copy',t=>{
 for(const kind of ['task','folder','relative-folder'])for(const after of [false,true]){
  const f=copyFixture(t),alias=path.join(f.root,'reference'),shared=path.join(path.dirname(f.copy),'shared');
  fs.mkdirSync(path.join(f.copy,'nested'));f.write(path.join(shared,'keep.txt'),'shared data');
  fs.symlinkSync(path.relative(f.root,path.join(f.copy,'nested')),alias);
  const ref=alias+'/../../shared',record=()=>kind==='task'?f.store.updateTask('Child',f.other,{workdir:ref}):f.project('Another',`folders:\n  参考: ${kind==='relative-folder'?'../../reference/../../shared':ref}\n`);
  assert.equal(fs.statSync(ref).ino,fs.statSync(shared).ino);assert.equal(fs.statSync(ref).dev,fs.statSync(shared).dev);
  if(!after)record();const d=f.r.preview('Child',f.task);
  if(after){assert.deepEqual(d.blockers,[]);record();}else assert.match(d.blockers.join(' '),/他の記録/);
  const file=kind==='task'?f.store.taskFile('Child',f.other):path.join(f.root,'Product/Another/PROJECT.md'),before=fs.readFileSync(file);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/他の記録/);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(ref),true);
  assert.equal(fs.readFileSync(path.join(shared,'keep.txt'),'utf8'),'shared data');
  assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('retargeting an outside reference through the copy after preview prevents removal',t=>{
 for(const kind of ['task','folder']){
  const f=copyFixture(t),alias=path.join(f.root,'reference'),sibling=path.join(path.dirname(f.copy),'separate'),shared=path.join(path.dirname(f.copy),'shared');
  fs.mkdirSync(path.join(f.copy,'nested'));fs.mkdirSync(path.join(sibling,'nested'),{recursive:true});f.write(path.join(shared,'keep.txt'),'shared data');
  fs.symlinkSync(path.relative(f.root,path.join(sibling,'nested')),alias);const ref=alias+'/../../shared';
  if(kind==='task')f.store.updateTask('Child',f.other,{workdir:ref});else f.project('Another',`folders:\n  参考: ${ref}\n`);
  const d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);
  // コピーを使わない同じ最終参照先なら移動・復元できる。
  const out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,true);assert.equal(fs.existsSync(ref),true);assert.equal(f.r.restore(out.record,true).ok,true);
  const clean=f.r.preview('Child',f.task);assert.deepEqual(clean.blockers,[]);
  fs.unlinkSync(alias);fs.symlinkSync(path.relative(f.root,path.join(f.copy,'nested')),alias);
  assert.equal(fs.statSync(ref).ino,fs.statSync(shared).ino);
  assert.throws(()=>f.r.apply({token:clean.token,confirm:true}),/他の記録/);
  assert.equal(fs.existsSync(ref),true);assert.equal(fs.readFileSync(path.join(shared,'keep.txt'),'utf8'),'shared data');
  assert.equal(f.sh(f.copy,'status','--porcelain'),'');
 }
});
test('unresolvable link loops keep the copy while separate dangling references permit removal and restoration',t=>{
 const f=copyFixture(t),alias=path.join(f.root,'reference');fs.symlinkSync('reference',alias);
 f.store.updateTask('Child',f.other,{workdir:alias+'/future'});
 const d=f.r.preview('Child',f.task);assert.ok(d.blockers.length);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));assert.equal(fs.existsSync(f.r.records),false);
 fs.unlinkSync(alias);fs.symlinkSync('separate/absent',alias);
 const out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).ok,true);
});
test('merged commits and main advancement allow removal; new copy changes after preview refuse apply',t=>{
 const f=copyFixture(t);f.write(path.join(f.copy,'file.txt'),'merged');f.sh(f.copy,'add','.');f.sh(f.copy,'commit','-qm','merged');f.sh(f.main,'merge','--ff-only','hub/'+f.task);
 f.write(path.join(f.main,'main-only'),'main advanced');f.sh(f.main,'add','.');f.sh(f.main,'commit','-qm','advance');
 let d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);f.write(path.join(f.main,'ignored'),'added after preview');f.write(path.join(f.copy,'ignored'),'added after preview');assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/変わりました/);
 d=f.r.preview('Child',f.task);f.write(path.join(f.copy,'file.txt'),'not saved');assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/未保存/);
});
test('unknown, mismatched, shared, and linked copy directories remain blocked',t=>{
 for(const kind of ['record','shared','folder','link','wrong-main','nested']){
  const f=copyFixture(t);
  if(kind==='record')f.store.updateTask('Child',f.task,{workdir:path.join(f.root,'Work/Child',f.other)});
  if(kind==='shared')f.store.updateTask('Child',f.other,{workdir:f.copy});
  if(kind==='folder')f.project('Another',`folders:\n  参考: ${f.copy}\n`);
  if(kind==='link'){fs.renameSync(f.copy,f.copy+'-real');fs.symlinkSync(f.copy+'-real',f.copy);}
  if(kind==='wrong-main')f.project('Child');
  if(kind==='nested'){const nested=path.join(f.copy,'inner');fs.mkdirSync(nested);f.store.updateTask('Child',f.task,{workdir:nested});f.sh(nested,'init','-q');}
  const d=f.r.preview('Child',f.task);assert.ok(d.blockers.length,kind);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));
 }
});
test('copy move failure preserves task; interrupted copy journal recovers and restores registered worktree',t=>{
 let f=copyFixture(t);f.sh(f.main,'worktree','lock',f.copy);let out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,false);assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);assert.equal(fs.existsSync(f.copy),true);
 f=copyFixture(t);const save=f.r.save.bind(f.r);let count=0;f.r.save=r=>{if(++count>=3)throw Error('journal unavailable');save(r);};
 assert.throws(()=>f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true}),/journal/);
 const fresh=new Removal({store:f.store,trash:f.r.trash}),h=fresh.history();assert.equal(h[0].count,1);assert.equal(fresh.restore(h[0].id,true).restored,1);assert.equal(f.sh(f.copy,'status','--porcelain'),'');
});
test('copy restore rejects changed contents, occupied original path and tampered copy paths',t=>{
 for(const kind of ['changed','occupied','tampered']){
  const f=copyFixture(t),out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true}),file=path.join(f.r.records,out.record+'.json'),r=JSON.parse(fs.readFileSync(file)),e=r.entries[0];
  if(kind==='changed')f.write(path.join(e.to,'ignored'),'tampered');
  if(kind==='occupied')f.write(path.join(f.copy,'preserve'),'new');
  if(kind==='tampered'){e.from=path.join(f.root,'Work/Child',f.other);fs.writeFileSync(file,JSON.stringify(r));}
  const restored=f.r.restore(out.record,true);assert.equal(restored.ok,false);assert.equal(restored.skipped.length,1);assert.equal(fs.existsSync(e.to),true);
 }
});
test('unchanged copies keep AI, queue, verification and whole-project deletion protections',t=>{
 for(const kind of ['busy','queue','locked','project']){
  const f=copyFixture(t,{busy:()=>kind==='busy',locked:()=>kind==='locked'});
  if(kind==='queue')f.write(path.join(f.dir,'.ai/chat',f.task+'.queue.json'),'[{"text":"pending"}]');
  const d=f.r.preview('Child',kind==='project'?undefined:f.task);assert.ok(d.blockers.length,kind);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));assert.equal(fs.existsSync(f.copy),true);
 }
});
test('partial failure after moving copy restores Git registration and interrupted restoration is recovered',t=>{
 const f=copyFixture(t,{rename:()=>{throw Error('task move unavailable');}}),out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});
 assert.equal(out.ok,false);assert.deepEqual(out.moved,[f.copy]);assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);
 const save=f.r.save.bind(f.r);let count=0;f.r.save=r=>{if(++count>=2)throw Error('restore journal unavailable');save(r);};
 const restored=f.r.restore(out.record,true);assert.equal(restored.ok,false);assert.equal(fs.existsSync(f.copy),true);
 const fresh=new Removal({store:f.store,trash:f.r.trash});assert.equal(fresh.history()[0].restored,true);assert.equal(f.sh(f.copy,'status','--porcelain'),'');
});
test('restoring original ignored configuration remains possible after main configuration changes',t=>{
 const f=copyFixture(t);f.write(path.join(f.main,'ignored'),'original local config');f.write(path.join(f.copy,'ignored'),'original local config');
 const out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});f.write(path.join(f.main,'ignored'),'new main config');
 assert.equal(f.r.restore(out.record,true).ok,true);assert.equal(fs.readFileSync(path.join(f.copy,'ignored'),'utf8'),'original local config');assert.equal(fs.readFileSync(path.join(f.main,'ignored'),'utf8'),'new main config');
});
test('integration and transfer descriptions keep separate copy cleanup and do not reject unmerged code as deletion would',t=>{
 const f=copyFixture(t);let d=f.r.describe('Child',f.task);assert.ok(d.blockers.every(x=>x.startsWith('作業用コピー')));assert.equal(d.move.some(x=>x.copy),false);
 f.write(path.join(f.copy,'file.txt'),'for integration');f.sh(f.copy,'add','.');f.sh(f.copy,'commit','-qm','for integration');
 d=f.r.describe('Child',f.task);assert.ok(d.blockers.every(x=>x.startsWith('作業用コピー')));assert.equal(d.move.some(x=>x.copy),false);assert.match(f.r.preview('Child',f.task).blockers.join(' '),/未統合/);
});
test('legacy task identifiers also round-trip an unchanged copy',t=>{
 const f=copyFixture(t,{},'20260926-hub-v2'),out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).ok,true);assert.equal(f.sh(f.copy,'status','--porcelain'),'');
});
test('task removal is explicit, leaves parent and other task unchanged, optional folders start separate and restore exact bytes',t=>{
 const f=fixture(t),optional=f.write(path.join(f.dir,'作業',f.task,'draft.txt'),'optional');const pfile=path.join(f.root,'Product/Parent/PROJECT.md'),other=f.store.taskFile('Child',f.other),before=[pfile,other].map(x=>fs.readFileSync(x));
 const d=f.r.preview('Child',f.task);assert.equal(d.blockers.length,0);assert.equal(d.optional.length,1);assert.throws(()=>f.r.apply({token:d.token,confirm:false}),/確認/);
 const out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,true);assert.equal(fs.existsSync(f.chat),false);assert.equal(fs.readFileSync(optional,'utf8'),'optional');assert.deepEqual([pfile,other].map(x=>fs.readFileSync(x)),before);
 assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');assert.equal(f.r.history()[0].restored,true);
});
test('optional attachments are selected only by id; references, symlinks and shared folders are kept',t=>{
 const f=fixture(t);const a=f.write(path.join(f.dir,'attachments',f.task,'x.txt'),'attach');let d=f.r.preview('Child',f.task);assert.equal(d.optional.length,1);
 fs.appendFileSync(f.store.taskFile('Child',f.other),`\nReference attachments/${f.task}/x.txt`);d=f.r.preview('Child',f.task);assert.equal(d.optional.length,0);assert.match(d.keep.at(-1).why,/参照/);
 const b=fixture(t);b.write(path.join(b.dir,'作業',b.task,'x.txt'),'draft');fs.symlinkSync('/etc/hosts',path.join(b.dir,'作業',b.task,'link'));assert.match(b.r.preview('Child',b.task).keep.at(-1).why,/リンク/);
 const c=fixture(t);const file=c.write(path.join(c.dir,'attachments',c.task,'x.txt'),'attach');d=c.r.preview('Child',c.task);const out=c.r.apply({token:d.token,optional:[d.optional[0].id],confirm:true});assert.equal(fs.existsSync(file),false);assert.equal(c.r.restore(out.record,true).restored,3);
});
test('shared references resolve the whole path from the reader project, not a matching suffix',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task);
 const reader=f.store.createTask('Parent',{title:'Reader'}),file=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(file,'utf8'),relative='.ai/work/'+f.task+'/shared.txt';
 for(const ref of [relative,'成果物/受取/receipt/project/'+relative]){fs.writeFileSync(file,base+'\n読む：'+ref+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,ref);}
 for(const ref of ['../Child/'+relative,'../Child/./.ai/work/'+f.task+'/../'+f.task+'/shared.txt']){fs.writeFileSync(file,base+'\n読む：'+ref+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,ref);}
});
test('JSON and JSONL reference strings decode tabs, newlines, escaped slashes and Unicode',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt';
 for(const ext of ['.json','.jsonl']){
  const file=path.join(f.dir,'.ai/chat',f.other+ext);
  for(const separator of ['\t','\n']){
   f.write(file,JSON.stringify({nested:[{text:'読む'+separator+ref}]}).replace(/\//g,'\\/').replace(/\.ai/g,'\\u002eai')+'\n');
   assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,ext+' '+JSON.stringify(separator));
  }
  // コピー先の中の部分パスをデコードしても、元フォルダを指してはいない。
  f.write(file,JSON.stringify({text:'読む\t成果物/受取/receipt/project/'+ref})+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false);
 }
});
test('Japanese punctuation keeps whole shared paths and does not match receipt destination suffixes',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt';
 const spellings=[['plain','読む ',''],['colon','読む：',''],['backticks','読む `','`'],['markdown','[参照](',')'],['corner','読む「','」'],['double-corner','読む『','』'],['parentheses','参照（','）'],['comma','参照、',''],['fullwidth-comma','参照，',''],['brackets','参照【','】'],['angle','参照〈','〉'],['double-angle','参照《','》'],['square','参照［','］'],['period','参照。','。']];
 for(const medium of ['markdown','jsonl']){
  const file=medium==='markdown'?f.store.taskFile('Child',f.other):path.join(f.dir,'.ai/chat',f.other+'.jsonl'),base=medium==='markdown'?fs.readFileSync(file,'utf8'):'';
  for(const [name,before,after] of spellings)for(const copied of [false,true]){
   const text=before+(copied?'成果物/受取/receipt/project/':'')+ref+after;
   f.write(file,base+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
   assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,medium+' '+name+' copied='+copied);
  }
  // 次の媒体に前の参照を持ち越さない。
  f.write(file,base);
 }
});
test('children, derived tasks, queued requests, running AI, active verification and work copies block deletion',t=>{
 for(const kind of ['child','derived','queue','busy','locked','copy','copyRecord']){
  const f=fixture(t,{busy:()=>kind==='busy',locked:()=>kind==='locked'});
  if(kind==='child')f.store.createTask('Child',{title:'Kid',parent:f.task});
  if(kind==='derived')f.store.createTask('Child',{title:'Derived',kind:'derived',derivedFrom:'Child/'+f.task});
  if(kind==='queue')f.write(path.join(f.dir,'.ai/chat',f.task+'.queue.json'),'[{"text":"pending"}]');
  if(kind==='copy')fs.mkdirSync(path.join(f.root,'Work/Child',f.task),{recursive:true});
  if(kind==='copyRecord')f.store.updateTask('Child',f.task,{workdir:path.join(f.root,'Work/Child',f.task)});
  const d=f.r.preview('Child',f.task);assert.ok(d.blockers.length,kind);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');
 }
});
test('child project keeps external parent body; nonempty original material needs typed name and restores project',t=>{
 const f=fixture(t),parent=path.join(f.root,'Product/Parent'),original=f.write(path.join(parent,'資料/source.txt'),'parent original');
 f.project('Child',`parent: Parent\nrelated: [Parent]\nfolders:\n  本体: ${parent}\n`);f.write(path.join(f.dir,'資料/source.txt'),'child original');let d=f.r.preview('Child');assert.equal(d.keep[0].path,parent);assert.ok(d.keep.some(x=>x.why.includes('参考・関連')));assert.equal(d.typed,true);
 assert.throws(()=>f.r.apply({token:d.token,confirm:true,typed:'wrong'}),/プロジェクト名/);const out=f.r.apply({token:d.token,confirm:true,typed:'Child'});assert.equal(fs.existsSync(f.dir),false);assert.equal(fs.readFileSync(original,'utf8'),'parent original');assert.equal(f.r.restore(out.record,true).restored,1);assert.equal(fs.readFileSync(path.join(f.dir,'資料/source.txt'),'utf8'),'child original');
});
test('project deletion rejects descendants, shared contained body, external Git tracking, Project Hub and symlinks',t=>{
 let f=fixture(t);assert.match(f.r.preview('Parent').blockers.join(' '),/子/);
 f=fixture(t);f.project('Another',`folders:\n  本体: ${f.dir}/作業\n`);assert.match(f.r.preview('Child').blockers.join(' '),/使っています/);
 f=fixture(t);execFileSync('git',['init','-q',f.root]);execFileSync('git',['-C',f.root,'add','Product/Child/PROJECT.md']);assert.match(f.r.preview('Child').blockers.join(' '),/外側/);
 f=fixture(t);f.project('Project Hub');assert.match(f.r.preview('Project Hub').blockers.join(' '),/自身/);
 f=fixture(t);fs.renameSync(f.dir,f.dir+'-real');fs.symlinkSync(f.dir+'-real',f.dir);assert.match(f.r.preview('Child').blockers.join(' '),/リンク/);
});
test('own Git root is recoverable, preview changes and invalid optional ids are refused',t=>{
 const f=fixture(t);execFileSync('git',['init','-q',f.dir]);execFileSync('git',['-C',f.dir,'add','PROJECT.md']);let d=f.r.preview('Child');assert.equal(d.blockers.length,0);
 const x=f.r.apply({token:d.token,confirm:true});assert.equal(f.r.restore(x.record,true).restored,1);assert.equal(fs.existsSync(path.join(f.dir,'.git')),true);
 d=f.r.preview('Child',f.task);fs.appendFileSync(f.chat,'changed');assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/変わりました/);
 d=f.r.preview('Child',f.task);assert.throws(()=>f.r.apply({token:d.token,optional:['../../Parent'],confirm:true}),/選び直/);
});
test('partial move failure is journaled and reversible; EXDEV never copies or deletes',t=>{
 let calls=0;const f=fixture(t,{rename:(a,b)=>{if(++calls===2)throw Error('fixture fail');fs.renameSync(a,b);}});const d=f.r.preview('Child',f.task),out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,false);assert.equal(out.moved.length,1);assert.equal(out.failed.length,1);assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');assert.equal(f.r.restore(out.record,true).restored,1);
 const g=fixture(t,{rename:()=>{throw Object.assign(Error('cross volume'),{code:'EXDEV'});}});const e=g.r.preview('Child',g.task),r=g.r.apply({token:e.token,confirm:true});assert.equal(r.moved.length,0);assert.match(r.failed[0].why,/同じディスク/);assert.equal(fs.existsSync(g.store.taskFile('Child',g.task)),true);
});
test('restore never overwrites, refuses changed Trash content and tampered path traversal',t=>{
 const f=fixture(t),d=f.r.preview('Child',f.task),out=f.r.apply({token:d.token,confirm:true});f.write(f.chat,'new content');let r=f.r.restore(out.record,true);assert.equal(r.restored,1);assert.match(r.skipped[0].why,/上書き/);assert.equal(fs.readFileSync(f.chat,'utf8'),'new content');
 const file=path.join(f.r.records,out.record+'.json'),record=JSON.parse(fs.readFileSync(file));record.entries[1].from=path.join(f.dir,'..','Parent','bad');fs.writeFileSync(file,JSON.stringify(record));assert.match(f.r.restore(out.record,true).skipped[0].why,/不正/);
 const g=fixture(t),a=g.r.apply({token:g.r.preview('Child',g.task).token,confirm:true}),saved=JSON.parse(fs.readFileSync(path.join(g.r.records,a.record+'.json')));fs.appendFileSync(saved.entries[1].to,'tamper');assert.match(g.r.restore(a.record,true).skipped[0].why,/中身/);
});

test('a stopped journal write after rename remains discoverable and recoverable',t=>{
 const f=fixture(t),save=f.r.save.bind(f.r);let count=0;
 f.r.save=r=>{if(++count>=3)throw Error('journal unavailable');save(r);};
 assert.throws(()=>f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true}),/journal/);
 const fresh=new Removal({store:f.store,trash:f.r.trash}),history=fresh.history();
 assert.equal(history[0].count,1);assert.equal(fresh.restore(history[0].id,true).restored,1);
 assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);
});

test('Japanese punctuation inside path components stays intact in relative references and receipt destinations',t=>{
 const f=fixture(t),reader=f.store.createTask('Parent',{title:'Reader'}),taskFile=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(taskFile,'utf8');
 for(const name of ['対象（共有）','対象「共有」','対象『共有』','対象、共有']){
  f.project(name);const owner=f.store.createTask(name,{title:'Owner'}),p=f.store.readProject(name),temp=f.write(path.join(p.dir,'.ai/work',owner.id,'shared.txt'),'shared'),ref='../'+name+'/.ai/work/'+owner.id+'/shared.txt';
  assert.equal(fs.realpathSync(path.resolve(f.root,'Product/Parent',ref)),fs.realpathSync(temp));
  for(const medium of ['markdown','jsonl']){
   const file=medium==='markdown'?taskFile:path.join(f.root,'Product/Parent/.ai/chat',reader.id+'.jsonl');
   for(const [before,after] of [['読む ',''],['読む「','」'],['参照（','）'],['参照、','。']])for(const copied of [false,true]){
    const text=before+(copied?'成果物/受取/receipt/project/':'')+ref+after;
    f.write(file,(medium==='markdown'?base:'')+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
    assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,name+' '+medium+' '+text);
   }
   f.write(file,medium==='markdown'?base:'');
  }
 }
});

test('separate Japanese quoted references remain readable without extracting quotes inside a copied path',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt',file=f.store.taskFile('Child',f.other),base=fs.readFileSync(file,'utf8');
 for(const text of ['読む「別の場所/file.txt」、読む「'+ref+'」','読む（別の場所/file.txt）、読む（'+ref+'）']){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,text);
 }
 for(const text of ['読む 成果物/受取/receipt/「'+ref+'」','読む 成果物/受取/receipt/（'+ref+'）']){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,text);
 }
});


test('Japanese path lists read every reference while preserving path names and receipt destinations',t=>{
 const f=fixture(t),reader=f.store.createTask('Parent',{title:'List reader'}),taskFile=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(taskFile,'utf8');
 const formats=[ref=>'読む：資料/a.md、'+ref,ref=>'読む【資料/a.md】、読む【'+ref+'】',ref=>'読む 資料/a.md。参照、'+ref,ref=>'読む「資料/a.md」、読む「'+ref+'」',ref=>'読む（資料/a.md）、読む（'+ref+'）',ref=>'資料/a.md，'+ref,ref=>'資料/a.md；'+ref];
 for(const name of ['Child','対象（共有）','対象「共有」','対象『共有』','対象、共有']){
  if(name!=='Child')f.project(name);const p=f.store.readProject(name),owner=name==='Child'?p.tasks.find(x=>x.id===f.task):f.store.createTask(name,{title:'Owner'}),temp=f.write(path.join(p.dir,'.ai/work',owner.id,'shared.txt'),'shared'),ref='../'+name+'/.ai/work/'+owner.id+'/shared.txt';
  for(const medium of ['markdown','jsonl']){
   const file=medium==='markdown'?taskFile:path.join(f.root,'Product/Parent/.ai/chat',reader.id+'.jsonl');
   for(const format of formats)for(const copied of [false,true]){
    const text=format((copied?'成果物/受取/receipt/project/':'')+ref);
    f.write(file,(medium==='markdown'?base:'')+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
    assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,name+' '+medium+' '+text);
   }
   f.write(file,medium==='markdown'?base:'');
  }
 }
});

test('list boundaries do not extract quoted source suffixes or split existing comma directory components',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt',file=f.store.taskFile('Child',f.other),base=fs.readFileSync(file,'utf8');
 f.write(path.join(f.dir,'成果物/受取/対象、.ai/work',f.task,'shared.txt'),'received copy');
 for(const text of ['資料/a.md、成果物/受取/receipt/【'+ref+'】','資料/a.md。読む 成果物/受取/receipt/「'+ref+'」','資料/a.md、成果物/受取/対象、'+ref]){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,text);
 }
 f.write(file,base+'\n資料/a.md、'+ref);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true);
});

test('copy and ledger entries select their own volume trash and restore fingerprints and Git registration',t=>{
 const f=copyFixture(t),taskFile=f.store.taskFile('Child',f.task),before=fs.readFileSync(taskFile),head=f.sh(f.main,'rev-parse','HEAD');
 const copyTrash=path.join(f.root,'copy-volume-trash'),ledgerTrash=path.join(f.root,'ledger-volume-trash');
 f.r.trashFor=source=>source===f.copy?copyTrash:ledgerTrash;
 f.r.trashDestination=(source,dest)=>{const base=f.r.trashFor(source);return dest.startsWith(base+path.sep);};
 const out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,true);
 const record=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json')));
 for(const entry of record.entries)assert.ok(entry.to.startsWith(f.r.trashFor(entry.from)+path.sep));
 assert.equal(fs.existsSync(f.copy),false);assert.equal(fs.existsSync(taskFile),false);
 assert.equal(f.r.restore(out.record,true).restored,record.entries.length);
 assert.deepEqual(fs.readFileSync(taskFile),before);assert.equal(f.sh(f.copy,'rev-parse','HEAD'),head);assert.equal(f.sh(f.copy,'status','--porcelain'),'');
});
test('a trash-selection failure consumes confirmation without moving files, and recovery requires fresh confirmation',t=>{
 const f=fixture(t),token=f.r.preview('Child',f.task).token,original=f.r.trashFor;
 f.r.trashFor=()=>{throw Error('missing volume trash');};
 assert.throws(()=>f.r.apply({token,confirm:true}),/missing volume trash/);assert.equal(f.r.tokens.has(token),false);assert.ok(fs.existsSync(f.chat));
 f.r.trashFor=original;
 assert.throws(()=>f.r.apply({token,confirm:true}),/もう一度/);
 const out=f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).ok,true);
});

test('external folders are unchecked candidates; selecting moves and restores paths outside workspace in the same journal',t=>{
 const f=fixture(t),outside=f.write(path.join(f.root,'Outside','file.txt'),'outside bytes'),dir=path.dirname(outside);
 f.project('Child',`folders:\n  本体: ${dir}\n  duplicate: ${dir}\n`);let d=f.r.preview('Child');
 assert.equal(d.keep.length,1);assert.equal(d.keep[0].selectable,true);assert.ok(d.keep[0].fingerprint);assert.equal(d.optional.length,0);
 let out=f.r.apply({token:d.token,confirm:true});assert.equal(fs.readFileSync(outside,'utf8'),'outside bytes');assert.equal(f.r.restore(out.record,true).restored,1);
 d=f.r.preview('Child');out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);assert.equal(out.moved.length,2);assert.equal(fs.existsSync(outside),false);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json')));assert.equal(r.entries[1].external,true);assert.ok(r.entries.every(e=>e.to.startsWith(f.r.trash+'/')));assert.equal(r.confirmedExternal.length,1);assert.equal(f.r.history()[0].external.length,1);
 assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(outside,'utf8'),'outside bytes');
});
test('important roots and their parents, other project trees and shared external folders cannot be selected',t=>{
 const f=fixture(t),p=f.store.readProject('Child'),all=f.store.listProjects(),home=os.homedir();
 for(const q of [path.parse(home).root,home,path.dirname(home),...['Documents','Desktop','Downloads'].map(n=>path.join(home,n)),path.join(home,'Documents/AI-Workspace'),f.root,f.store.product,path.join(f.root,'Work'),path.join(f.root,'System/ProjectHub')])assert.equal(f.r.externalCandidate(q,p,all,false).selectable,false,q);
 for(const q of [path.join(f.root,'Product/Parent'),path.join(f.root,'Product/Parent/sub')])assert.match(f.r.externalCandidate(q,p,all,false).unavailableWhy,/プロジェクト/);
 const shared=path.dirname(f.write(path.join(f.root,'shared','x'),'x'));f.project('Parent',`folders:\n  使用: ${shared}/sub\n`);
 for(const q of [shared,shared+'/sub',shared+'/sub/inside'])assert.match(f.r.externalCandidate(q,p,f.store.listProjects(),false).unavailableWhy,/使っています/);
});
test('missing, linked, too large, cross-device and task-only external paths stay disabled with reasons',t=>{
 const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'Outside/x'),'x')),p=f.store.readProject('Child'),all=f.store.listProjects();
 assert.match(f.r.externalCandidate(dir+'/missing',p,all,false).unavailableWhy,/見つかりません/);
 fs.symlinkSync(dir,path.join(f.root,'link'));assert.match(f.r.externalCandidate(path.join(f.root,'link'),p,all,false).unavailableWhy,/リンク.*Finder/);
 f.write(path.join(dir,'link'),'x');fs.unlinkSync(path.join(dir,'link'));fs.symlinkSync('/etc/hosts',path.join(dir,'link'));assert.match(f.r.externalCandidate(dir,p,all,false).unavailableWhy,/リンク.*Finder/);fs.unlinkSync(path.join(dir,'link'));
 const huge=f.write(path.join(dir,'huge'),'');fs.truncateSync(huge,257*1024*1024);assert.match(f.r.externalCandidate(dir,p,all,false).unavailableWhy,/大きさ.*Finder/);fs.unlinkSync(huge);
 assert.match(f.r.externalCandidate(dir,p,all,true).unavailableWhy,/プロジェクトの削除/);
 const stat=fs.statSync;try{fs.statSync=(q,...args)=>{const s=stat(q,...args);if(q===dir)s.dev+=1;return s;};assert.match(f.r.externalCandidate(dir,p,all,false).unavailableWhy,/別ディスク.*Finder/);}finally{fs.statSync=stat;}
});
test('external choices reject fabricated, duplicate, disabled ids, content changes and new sharing after preview',t=>{
 const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'Outside/x'),'x'));f.project('Child',`folders:\n  本体: ${dir}\n  親: ${f.root}\n`);
 let d=f.r.preview('Child');for(const ids of [['bad'],[d.keep[0].id,d.keep[0].id],[d.keep[1].id]])assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:ids}),/選び直/);
 fs.appendFileSync(path.join(dir,'x'),'change');assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました/);
 d=f.r.preview('Child');f.project('Parent',`folders:\n  使用: ${dir}\n`);assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました/);
 assert.equal(fs.existsSync(f.dir),true);assert.equal(fs.existsSync(dir),true);
});
test('overlapping selected external paths move once; signed confirmation prevents forged destinations and manifests',t=>{
 const f=fixture(t),file=f.write(path.join(f.root,'Outside/sub/x'),'x'),dir=path.join(f.root,'Outside');f.project('Child',`folders:\n  本体: ${dir}\n  子: ${dir}/sub\n`);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:d.keep.map(x=>x.id)});assert.equal(out.moved.length,2);
 const journal=path.join(f.r.records,out.record+'.json'),r=JSON.parse(fs.readFileSync(journal)),original=JSON.stringify(r);
 r.entries[1].from=path.join(f.root,'forged');r.confirmedExternal[0].from=r.entries[1].from;fs.writeFileSync(journal,JSON.stringify(r));assert.match(f.r.restore(out.record,true).skipped[0].why,/不正/);assert.equal(fs.existsSync(path.join(f.root,'forged')),false);
 fs.writeFileSync(journal,original);assert.equal(f.r.restore(out.record,true).restored,1);assert.equal(fs.readFileSync(file,'utf8'),'x');
});
test('external move and restore recover after rename before journal save; changed trash and new sharing refuse restore',t=>{
 for(const phase of ['move','restore']){
  const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'Outside/x'),'x'));f.project('Child',`folders:\n  本体: ${dir}\n`);
  let out,armed=phase==='move',save=f.r.save.bind(f.r),rename=f.r.rename;
  f.r.rename=(a,b)=>{rename(a,b);if((phase==='move'&&a===dir)||(phase==='restore'&&b===dir))armed=true;};
  f.r.save=r=>{if(armed&&r.entries.some(e=>e.external&&(phase==='move'?e.moved:e.restored)))throw Error('journal interrupted');save(r);};
  if(phase==='move')assert.throws(()=>f.r.apply({token:f.r.preview('Child').token,confirm:true,optional:f.r.describe('Child').keep.map(x=>x.id)}),/journal/);
  else{out=f.r.apply({token:f.r.preview('Child').token,confirm:true,optional:f.r.describe('Child').keep.map(x=>x.id)});assert.equal(f.r.restore(out.record,true).ok,false);}
  const fresh=new Removal({store:f.store,trash:f.r.trash}),history=fresh.history();assert.equal(history[0].count,2);if(phase==='move')assert.equal(fresh.restore(history[0].id,true).restored,2);else assert.equal(history[0].restored,true);
  assert.equal(fs.readFileSync(path.join(dir,'x'),'utf8'),'x');
 }
 const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'Outside/x'),'x'));f.project('Child',`folders:\n  本体: ${dir}\n`);const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});
 f.project('Parent',`folders:\n  使用: ${dir}\n`);assert.match(f.r.restore(out.record,true).skipped[0].why,/不正/);assert.equal(fs.existsSync(dir),false);
});
test('other projects using symlink, normalized Unicode or case aliases of external paths remain protected',t=>{
 const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'External-Alias/x'),'x')),alias=path.join(f.root,'alias');fs.symlinkSync(dir,alias);
 f.project('Child',`folders:\n  本体: ${dir}\n`);f.project('Parent',`folders:\n  使用: ${alias}\n`);assert.match(f.r.preview('Child').keep[0].unavailableWhy,/使っています/);
 f.project('Parent',`folders:\n  使用: ${alias}/future-child\n`);assert.match(f.r.preview('Child').keep[0].unavailableWhy,/使っています/);
 if(fs.existsSync(dir.toLowerCase())){f.project('Parent',`folders:\n  使用: ${dir.toLowerCase()}\n`);assert.match(f.r.preview('Child').keep[0].unavailableWhy,/使っています/);}
 const unicode=path.dirname(f.write(path.join(f.root,'é/x'),'unicode'));f.project('Child',`folders:\n  本体: ${unicode}\n`);f.project('Parent',`folders:\n  使用: ${unicode.normalize('NFD')}\n`);assert.match(f.r.preview('Child').keep[0].unavailableWhy,/使っています/);
});
test('multiple external spellings of one physical directory move once without removing the selection',t=>{
 const f=fixture(t),dir=path.dirname(f.write(path.join(f.root,'é/x'),'unicode'));f.project('Child',`folders:\n  本体: ${dir}\n  同じ場所: ${dir.normalize('NFD')}\n`);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:d.keep.map(x=>x.id)});assert.equal(out.ok,true);assert.equal(out.moved.length,2);assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(path.join(dir,'x'),'utf8'),'unicode');
});

function externalSharingFixture(t){
 const f=fixture(t),outside=path.join(f.root,'External'),link=path.join(f.root,'refs/link');
 f.write(path.join(outside,'file.txt'),'shared bytes');fs.mkdirSync(path.join(outside,'nested'));f.write(path.join(f.root,'Sibling/file.txt'),'sibling bytes');
 fs.mkdirSync(path.dirname(link));fs.symlinkSync(outside+'/nested',link);
 f.project('Child',`folders:\n  外: ${outside}\n`);
 const share=ref=>f.project('Parent',`folders:\n  使用: ${ref}\n`);
 return {...f,outside,link,share};
}
for(const kind of ['absolute','relative'])for(const exit of [false,true])for(const timing of ['before','after']){
 test(`external raw shared paths preserve symlink order and traversal: ${kind}/${exit?'exit':'inside'}/${timing}`,t=>{
  const f=externalSharingFixture(t),suffix=exit?'/../../Sibling/file.txt':'/../file.txt',raw=f.link+suffix;
  const ref=kind==='absolute'?raw:'../../refs/link'+suffix;
  assert.equal(fs.readFileSync(raw,'utf8'),exit?'sibling bytes':'shared bytes');
  if(timing==='before')f.share(ref);
  const d=f.r.preview('Child');
  if(timing==='after'){assert.equal(d.keep[0].selectable,true);f.share(ref);}
  const now=f.r.describe('Child');assert.equal(now.keep[0].selectable,false);assert.match(now.keep[0].unavailableWhy,/使っています/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました|選び直/);
  assert.equal(fs.existsSync(f.r.records),false);assert.equal(fs.readFileSync(raw,'utf8'),exit?'sibling bytes':'shared bytes');assert.equal(fs.existsSync(f.dir),true);
 });
}
test('external raw sharing protects parents, absent descendants and chained relative links without blocking independent siblings',t=>{
 const f=externalSharingFixture(t),p=f.store.readProject('Child'),chain=path.join(f.root,'refs/chain');fs.symlinkSync('link',chain);
 for(const ref of [f.link+'/../future/child',f.link+'/../../',chain+'/../file.txt','../../refs/chain/../future/child']){
  f.share(ref);assert.match(f.r.externalCandidate(f.outside,p,f.store.listProjects(),false).unavailableWhy,/使っています/,ref);
 }
 f.share(path.join(f.root,'Sibling/file.txt'));const d=f.r.preview('Child');assert.equal(d.keep[0].selectable,true);
 const out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).restored,2);
 assert.equal(fs.readFileSync(path.join(f.root,'Sibling/file.txt'),'utf8'),'sibling bytes');
});
test('external raw sharing rechecks changed link destinations after preview',t=>{
 const f=externalSharingFixture(t);fs.unlinkSync(f.link);fs.symlinkSync(path.join(f.root,'Sibling'),f.link);f.share(f.link+'/../file.txt');
 const d=f.r.preview('Child');assert.equal(d.keep[0].selectable,true);
 fs.unlinkSync(f.link);fs.symlinkSync(f.outside+'/nested',f.link);
 assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました/);assert.equal(fs.existsSync(f.outside),true);assert.equal(fs.existsSync(f.r.records),false);
});
test('external raw sharing fails closed on symlink loops before and after preview',t=>{
 for(const timing of ['before','after']){
  const f=externalSharingFixture(t),loop=path.join(f.root,'refs/loop');fs.symlinkSync('loop',loop);
  if(timing==='before')f.share(loop+'/../file.txt');const d=f.r.preview('Child');
  if(timing==='after'){assert.equal(d.keep[0].selectable,true);f.share(loop+'/../file.txt');}
  const now=f.r.describe('Child');assert.equal(now.keep[0].selectable,false);assert.match(now.keep[0].unavailableWhy,/リンク.*解決/);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました|選び直/);assert.equal(fs.existsSync(f.outside),true);assert.equal(fs.existsSync(f.r.records),false);
 }
});
test('signed external entries recheck raw sharing while absent and refuse restore and interrupted recovery',t=>{
 for(const refKind of ['inside','exit','loop']){
  const f=externalSharingFixture(t),d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
  const journal=path.join(f.r.records,out.record+'.json'),r=JSON.parse(fs.readFileSync(journal)),e=r.entries.find(x=>x.external);
  let ref=f.link+(refKind==='exit'?'/../../Sibling/file.txt':'/../file.txt');
  if(refKind==='loop'){const loop=path.join(f.root,'refs/loop');fs.symlinkSync('loop',loop);ref=loop+'/../file.txt';}
  f.share(ref);assert.equal(fs.existsSync(f.outside),false);assert.equal(f.r.validEntry(r,e,f.dir),false,refKind);
  e.moved=false;e.moving=true;f.r.save(r);f.r.recover(r);assert.equal(e.moved,false);assert.equal(e.moving,true);
  e.moved=true;e.moving=false;f.r.save(r);const restored=f.r.restore(out.record,true);assert.equal(restored.ok,false);assert.match(restored.skipped[0].why,/不正/);assert.equal(fs.existsSync(e.to),true);
  fs.renameSync(e.to,e.from);e.restoring=true;f.r.save(r);f.r.recover(r);assert.equal(e.restoring,true);assert.equal(e.restored,false);
  assert.equal(fs.readFileSync(path.join(f.outside,'file.txt'),'utf8'),'shared bytes');
 }
});

// 実ホームを読まない。一時ホームの実体を使い、macOSでは同一inodeの別表記も照合する。
function withProtectedHome(t,run){
 const f=fixture(t),home=path.join(f.root,'Home'),homedir=os.homedir;
 for(const dir of ['Desktop','Downloads','Documents'])fs.mkdirSync(path.join(home,dir),{recursive:true});
 fs.mkdirSync(path.join(f.root,'System/ProjectHub'),{recursive:true});
 f.r.trash=path.join(home,'.Trash');fs.mkdirSync(f.r.trash);
 os.homedir=()=>home;try{run(f,home);}finally{os.homedir=homedir;}
}
test('protected directories and ancestors reject physical case aliases in preview and apply',t=>withProtectedHome(t,(f,home)=>{
 const paths=[path.join(home,'Desktop'),path.join(home,'Downloads'),path.join(f.root,'System/ProjectHub'),f.r.trash,home,path.join(f.root,'System')];
 for(const original of paths){
  f.write(path.join(original,'marker.txt'),'protected');
  const alias=path.join(path.dirname(original),path.basename(original).toLowerCase());
  // 大文字小文字を区別するディスクでは、存在しない別表記を同一視しない。
  if(!fs.existsSync(alias))continue;
  assert.equal(fs.statSync(alias).ino,fs.statSync(original).ino);
  f.project('Child',`folders:\n  外: ${alias}\n`);
  const d=f.r.preview('Child'),x=d.keep[0];assert.equal(x.selectable,false,alias);assert.match(x.unavailableWhy,/選べません/,alias);
  assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[x.id]}),/選び直/);
  assert.equal(fs.readFileSync(path.join(original,'marker.txt'),'utf8'),'protected');assert.equal(fs.existsSync(f.dir),true);
 }
}));
test('case aliases of system, records and trash descendants stay protected including missing descendants',t=>withProtectedHome(t,(f)=>{
 for(const base of [path.join(f.root,'System/ProjectHub'),f.r.records,path.join(f.root,'_hub'),f.r.trash]){
  f.write(path.join(base,'inside/marker.txt'),'protected');
  const alias=path.join(path.dirname(base),path.basename(base).toLowerCase());if(!fs.existsSync(alias))continue;
  for(const suffix of ['inside','inside/future']){
   const q=path.join(alias,suffix),p=f.store.readProject('Child');
   assert.match(f.r.externalCandidate(q,p,f.store.listProjects(),false).unavailableWhy,/システム・記録・ゴミ箱/,q);
  }
 }
}));
test('ordinary Desktop documents remain selectable, move and restore through case aliases',t=>withProtectedHome(t,(f,home)=>{
 const original=path.join(home,'Desktop'),alias=path.join(home,'desktop'),desktop=fs.existsSync(alias)?alias:original;
 const file=f.write(path.join(original,'DocumentsForChild/marker.txt'),'ordinary');
 f.project('Child',`folders:\n  資料: ${desktop}/DocumentsForChild\n`);
 const d=f.r.preview('Child');assert.equal(d.keep[0].selectable,true);
 const out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);assert.equal(fs.existsSync(file),false);
 assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(file,'utf8'),'ordinary');
}));
test('case aliases newly protected after preview are refused by apply',t=>withProtectedHome(t,(f)=>{
 const original=path.join(f.root,'OutsideHub'),alias=path.join(f.root,'outsidehub');f.write(path.join(original,'inside/marker.txt'),'protected');
 const dir=path.join(fs.existsSync(alias)?alias:original,'inside');f.project('Child',`folders:\n  外: ${dir}\n`);
 const d=f.r.preview('Child');assert.equal(d.keep[0].selectable,true);
 f.r.trash=original;assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました/);
 assert.equal(fs.existsSync(f.dir),true);assert.equal(fs.readFileSync(path.join(dir,'marker.txt'),'utf8'),'protected');
}));
test('signed external entries newly under a protected alias cannot restore or recover',t=>withProtectedHome(t,(f)=>{
 const original=path.join(f.root,'OutsideHub'),alias=path.join(f.root,'outsidehub');f.write(path.join(original,'inside/marker.txt'),'protected');
 const dir=path.join(fs.existsSync(alias)?alias:original,'inside');f.project('Child',`folders:\n  外: ${dir}\n`);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),file=path.join(f.r.records,out.record+'.json'),r=JSON.parse(fs.readFileSync(file)),e=r.entries.find(x=>x.external);
 // 復元先の親がHubの記録用になった場合。署名は正しくても現在の保護を優先する。
 f.r.records=original;
 assert.equal(f.r.validEntry(r,e,f.dir),false);
 e.moved=false;e.moving=true;f.r.save(r);f.r.recover(r);assert.equal(e.moving,true);assert.equal(e.moved,false);
 e.moved=true;e.moving=false;f.r.save(r);assert.match(f.r.restore(out.record,true).skipped[0].why,/不正/);assert.equal(fs.existsSync(dir),false);
 fs.mkdirSync(path.dirname(dir),{recursive:true});fs.renameSync(e.to,dir);e.restoring=true;f.r.save(r);f.r.recover(r);
 assert.equal(e.restoring,true);assert.equal(e.restored,false);assert.equal(fs.readFileSync(path.join(dir,'marker.txt'),'utf8'),'protected');
}));

test('task copy deletion keeps all external folders disabled, rejects their ids, and round-trips copy plus optional material',t=>withProtectedHome(t,(unused,home)=>{
 const f=copyFixture(t),doc=f.write(path.join(home,'Desktop/Material/doc.txt'),'external material');
 f.project('Child',`parent: Parent\nfolders:\n  本体: ${f.main}\n  資料: ${path.dirname(doc)}\n  保護: ${path.join(home,'desktop')}\n`);
 const attachment=f.write(path.join(f.dir,'attachments',f.task,'draft.txt'),'attachment');
 const d=f.r.preview('Child',f.task);assert.deepEqual(d.blockers,[]);assert.ok(d.move[0].copy);
 assert.equal(d.keep.filter(x=>x.external).length,3);assert.ok(d.keep.every(x=>!x.selectable));
 assert.match(d.keep.find(x=>x.path===path.dirname(doc)).unavailableWhy,/プロジェクトの削除/);
 assert.match(d.keep.find(x=>x.path===path.join(home,'desktop')).unavailableWhy,/大事な場所/);
 for(const x of d.keep)assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[x.id]}),/選び直/);
 const out=f.r.apply({token:d.token,confirm:true,optional:[d.optional[0].id]});assert.equal(out.ok,true);
 assert.equal(fs.existsSync(f.copy),false);assert.equal(fs.existsSync(attachment),false);assert.equal(fs.readFileSync(doc,'utf8'),'external material');
 const record=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json')));assert.ok(record.entries[0].copy);assert.equal(record.confirmedExternal.length,0);
 assert.equal(f.r.restore(out.record,true).restored,record.entries.length);assert.equal(f.sh(f.copy,'status','--porcelain'),'');assert.equal(fs.readFileSync(attachment,'utf8'),'attachment');
}));
test('sharing review started after task-copy preview blocks copy deletion until a fresh preview',t=>{
 let active=false;const f=copyFixture(t,{reviewBusy:()=>active}),d=f.r.preview('Child',f.task);
 active=true;assert.match(f.r.preview('Child',f.task).blockers.join(' '),/共有を確認中/);
 assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/共有を確認中/);assert.equal(fs.existsSync(f.copy),true);
 active=false;const next=f.r.preview('Child',f.task),out=f.r.apply({token:next.token,confirm:true});assert.equal(out.ok,true);assert.equal(f.r.restore(out.record,true).ok,true);
});
test('mixed signed external and copy metadata cannot bypass external restore or recovery guards',t=>{
 const f=fixture(t),outside=path.join(f.root,'Outside');f.write(path.join(outside,'doc'),'external');f.project('Child',`folders:\n  外: ${outside}\n`);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),file=path.join(f.r.records,out.record+'.json'),r=JSON.parse(fs.readFileSync(file)),e=r.entries.find(x=>x.external);
 e.copy={main:outside,head:'forged',branch:'forged'};assert.equal(f.r.validEntry(r,e,f.dir),false);
 e.moved=false;e.moving=true;f.r.save(r);f.r.recover(r);assert.equal(e.moved,false);assert.equal(e.moving,true);
 e.moving=false;e.moved=true;f.r.save(r);const restored=f.r.restore(out.record,true);assert.equal(restored.ok,false);assert.match(restored.skipped[0].why,/不正/);assert.equal(fs.existsSync(e.to),true);
});
test('freetalk identity blocks old token apply and sharing-review launch without creating tasks or moving data',async t=>{
 const f=fixture(t),outside=path.join(f.root,'Outside');f.write(path.join(outside,'doc'),'external');f.project('Child',`folders:\n  外: ${outside}\n`);const d=f.r.preview('Child');
 f.project('Child',`kind: freetalk\nfolders:\n  外: ${outside}\n`);
 assert.throws(()=>f.r.preview('Child'),/常設/);assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/常設/);
 let starts=0;const review=new (require('../lib/removal-review').RemovalReview)({store:f.store,removal:f.r,start:()=>{starts++;},busy:()=>false,rows:()=>[]});
 const before=fs.readdirSync(path.join(f.dir,'.ai/tasks')).sort();await assert.rejects(()=>review.begin(d.token),/常設/);
 assert.deepEqual(fs.readdirSync(path.join(f.dir,'.ai/tasks')).sort(),before);assert.equal(starts,0);assert.equal(fs.existsSync(f.r.records),false);assert.equal(fs.existsSync(review.file('Child')),false);assert.equal(fs.readFileSync(path.join(outside,'doc'),'utf8'),'external');
});

// R2残存A/B: ホーム展開でもリンク後の親成分を保ち、不在側の別表記を再照合する。
for(const exit of [false,true])for(const timing of ['before','after'])test(`external tilde sharing preserves traversal: ${exit?'exit':'inside'}/${timing}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=path.join(f.root,'External'),link=path.join(home,'link');
 f.write(outside+'/file.txt','shared');fs.mkdirSync(outside+'/nested');f.write(f.root+'/Sibling/file.txt','sibling');fs.symlinkSync(outside+'/nested',link);
 const suffix=exit?'/../../Sibling/file.txt':'/../file.txt',raw=home+'/link'+suffix,ref='~/link'+suffix;
 const target=exit?f.root+'/Sibling/file.txt':outside+'/file.txt';assert.equal(fs.statSync(raw).ino,fs.statSync(target).ino);
 f.project('Child',`folders:\n  外: ${outside}\n`);const share=()=>f.project('Parent',`folders:\n  使用: ${ref}\n`);
 if(timing==='before')share();const d=f.r.preview('Child');if(timing==='after'){assert.equal(d.keep[0].selectable,true);share();}
 const now=f.r.describe('Child');assert.equal(now.keep[0].selectable,false);assert.match(now.keep[0].unavailableWhy,/使っています/);
 assert.throws(()=>f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]}),/変わりました|選び直/);assert.equal(fs.existsSync(f.r.records),false);assert.equal(fs.existsSync(f.dir),true);assert.equal(fs.readFileSync(raw,'utf8'),exit?'sibling':'shared');
}));
for(const refKind of ['absolute-alias','tilde-alias','tilde'])for(const mode of ['restore','moving','restoring'])test(`external absent sharing refuses signed restore and recovery: ${refKind}/${mode}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=f.root+'/External',link=home+'/link';f.write(outside+'/file.txt','shared');fs.mkdirSync(outside+'/nested');
 const alias=f.root+'/external';if(refKind.includes('alias')){if(!fs.existsSync(alias)){t.skip('filesystem has distinct case names');return;}assert.equal(fs.statSync(alias).ino,fs.statSync(outside).ino);}
 fs.symlinkSync((refKind.includes('alias')?alias:outside)+'/nested',link);
 f.project('Child',`folders:\n  外: ${outside}\n`);const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(e=>e.external);
 const ref=refKind.startsWith('tilde')?'~/link/../file.txt':link+'/../file.txt';f.project('Parent',`folders:\n  使用: ${ref}\n`);
 assert.equal(fs.existsSync(outside),false);assert.equal(f.r.validEntry(r,e,f.dir),false);
 if(mode==='restore'){const result=f.r.restore(out.record,true);assert.equal(result.ok,false);assert.match(result.skipped.find(x=>x.path===outside).why,/不正/);assert.equal(fs.existsSync(e.to),true);assert.equal(fs.existsSync(outside),false);}
 else if(mode==='moving'){e.moving=true;e.moved=false;f.r.save(r);f.r.recover(r);assert.equal(e.moving,true);assert.equal(e.moved,false);assert.equal(fs.existsSync(e.to),true);}
 else{fs.renameSync(e.to,e.from);e.restoring=true;f.r.save(r);f.r.recover(r);assert.equal(e.restoring,true);assert.equal(e.restored,false);assert.equal(fs.readFileSync(outside+'/file.txt','utf8'),'shared');}
}));
test('external absent independent sibling does not prevent signed restore',t=>{
 const f=externalSharingFixture(t),d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 f.share(f.root+'/Sibling/file.txt');assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(f.outside+'/file.txt','utf8'),'shared bytes');
});

test('external absent aliases require filesystem identity evidence rather than global case folding',t=>{
 const f=externalSharingFixture(t),alias=f.root+'/external',parentAlias=path.join(path.dirname(f.root),path.basename(f.root).replace(/[A-Za-z]/,c=>c===c.toLowerCase()?c.toUpperCase():c.toLowerCase()));
 if(!fs.existsSync(alias)){t.skip('filesystem already treats case names as distinct');return;}
 assert.equal(fs.statSync(alias).ino,fs.statSync(f.outside).ino);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(e=>e.external);f.share(alias+'/future/child');
 const stat=fs.statSync,distinct=stat(f.root+'/Sibling');
 try{fs.statSync=(q,...args)=>q===parentAlias?distinct:stat(q,...args);assert.equal(f.r.validEntry(r,e,f.dir),true,'distinct parent inode must not enable missing-name case folding');}
 finally{fs.statSync=stat;}
 assert.equal(f.r.validEntry(r,e,f.dir),false,'same-inode parent aliases protect the absent candidate');
 f.share(f.root+'/Sibling/file.txt');assert.equal(f.r.restore(out.record,true).restored,2);
});

// R2残存C: Unicodeの一致は文字列変換で推測せず、署名済み移動先のFSに照合する。
for(const [name,alias] of [['Straße','STRASSE'],['Σ','ς'],['ſ','s']])for(const mode of ['restore','moving','restoring'])test(`external absent Unicode identity refuses signed recovery: ${name}/${mode}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=path.join(f.root,name),other=path.join(f.root,alias),link=path.join(home,'link');
 f.write(outside+'/file.txt','shared');fs.mkdirSync(outside+'/nested');
 if(!fs.existsSync(other)){t.skip('filesystem treats Unicode spellings as distinct');return;}
 const original=fs.statSync(outside),equivalent=fs.statSync(other);assert.equal(equivalent.dev,original.dev);assert.equal(equivalent.ino,original.ino);
 fs.symlinkSync(other+'/nested',link);f.project('Child',`folders:\n  外: ${outside}\n`);
 f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');assert.equal(f.r.preview('Child').keep[0].selectable,false);
 f.project('Parent');const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external);assert.equal(r.externalSeal,f.r.seal(r));
 f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');
 if(mode==='restoring'){fs.renameSync(e.to,e.from);e.restoring=true;f.r.save(r);}
 assert.equal(f.r.validEntry(r,e,f.dir),false);
 if(mode==='restore'){const result=f.r.restore(out.record,true);assert.equal(result.ok,false);assert.match(result.skipped.find(x=>x.path===outside).why,/不正/);assert.equal(fs.existsSync(outside),false);assert.equal(fs.readFileSync(e.to+'/file.txt','utf8'),'shared');}
 else if(mode==='moving'){e.moving=true;e.moved=false;f.r.save(r);f.r.recover(r);assert.equal(e.moving,true);assert.equal(e.moved,false);assert.equal(fs.existsSync(e.to),true);}
 else{f.r.recover(r);assert.equal(e.restoring,true);assert.equal(e.restored,false);assert.equal(fs.readFileSync(outside+'/file.txt','utf8'),'shared');}
}));
for(const alias of ['Strasse-Other','Σ-other','é','Sibling'])test(`external absent Unicode identity permits distinct reference: ${alias}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=f.root+'/Straße',other=path.join(f.root,alias),link=home+'/link';f.write(outside+'/file.txt','external');f.write(other+'/file.txt','independent');fs.mkdirSync(other+'/nested');fs.symlinkSync(other+'/nested',link);
 assert.notEqual(fs.statSync(outside).ino,fs.statSync(other).ino);f.project('Child',`folders:\n  外: ${outside}\n`);
 const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external);
 assert.equal(f.r.validEntry(r,e,f.dir),true);assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(outside+'/file.txt','utf8'),'external');assert.equal(fs.readFileSync(other+'/file.txt','utf8'),'independent');
}));

// 元親も不在: 葉だけでなく複数の不在成分をFSの規則で照合する。
for(const [parent,name,aliasParent,alias] of [
 ['Bucket','Straße','Bucket','STRASSE'],['Bucket','Σ','Bucket','ς'],['Bucket','ſ','Bucket','s'],
 ['Bucket','External','Bucket','external'],['Bucket','Straße','Bucket','Straße'],
 ['Straße','Σ','STRASSE','ς'],['Σ/ſ','Straße','ς/s','STRASSE']
])for(const mode of ['restore','moving','restoring'])test(`external missing ancestors refuse signed recovery: ${parent}/${name}/${mode}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=path.join(f.root,parent,name),other=path.join(f.root,aliasParent,alias),link=home+'/link';
 f.write(outside+'/file.txt','shared');fs.mkdirSync(outside+'/nested');
 if(!fs.existsSync(other)){t.skip('filesystem treats spellings as distinct');return;}
 assert.equal(fs.statSync(other).dev,fs.statSync(outside).dev);assert.equal(fs.statSync(other).ino,fs.statSync(outside).ino);
 fs.symlinkSync(other+'/nested',link);f.project('Child',`folders:\n  外: ${outside}\n`);
 f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');assert.equal(f.r.preview('Child').keep[0].selectable,false);
 f.project('Parent');const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external);assert.equal(r.externalSeal,f.r.seal(r));
 const top=path.join(f.root,parent.split('/')[0]);fs.renameSync(top,top+'-retained');
 f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');
 if(mode==='restoring'){fs.mkdirSync(path.dirname(e.from),{recursive:true});fs.renameSync(e.to,e.from);e.restoring=true;f.r.save(r);}
 assert.equal(f.r.validEntry(r,e,f.dir),false);
 if(mode==='restore'){const result=f.r.restore(out.record,true);assert.equal(result.ok,false);assert.equal(fs.existsSync(e.from),false);assert.equal(fs.readFileSync(e.to+'/file.txt','utf8'),'shared');}
 else if(mode==='moving'){e.moving=true;e.moved=false;f.r.save(r);f.r.recover(r);assert.equal(e.moving,true);assert.equal(e.moved,false);assert.equal(fs.existsSync(e.to),true);}
 else{f.r.recover(r);assert.equal(e.restoring,true);assert.equal(e.restored,false);}
 assert.equal(fs.readdirSync(path.dirname(e.to)).some(n=>n.startsWith('.name-check-')),false,'temporary name probes must be removed');
}));
for(const kind of ['existing-sibling','missing-sibling','different-missing-parent','different-missing-leaf'])test(`external missing ancestors permit independent restore: ${kind}`,t=>withProtectedHome(t,(f)=>{
 const outside=f.root+'/Bucket/Straße';f.write(outside+'/file.txt','external');f.write(f.root+'/Sibling/file.txt','independent');
 f.project('Child',`folders:\n  外: ${outside}\n`);const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 fs.renameSync(f.root+'/Bucket',f.root+'/Bucket-retained');
 const ref=kind==='existing-sibling'?f.root+'/Sibling/file.txt':kind==='missing-sibling'?f.root+'/Bucket/Independent/file.txt':kind==='different-missing-parent'?f.root+'/Bucket-Other/STRASSE/file.txt':f.root+'/Bucket/Strasse-Other/file.txt';
 f.project('Parent',`folders:\n  使用: ${ref}\n`);const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external);
 assert.equal(f.r.validEntry(r,e,f.dir),true);assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(outside+'/file.txt','utf8'),'external');
}));

for(const ref of ['~/link','~/link/../future'])test(`external missing Unicode ancestors protect parent reference: ${ref}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=f.root+'/Straße/Σ';f.write(outside+'/file.txt','external');fs.mkdirSync(outside+'/nested');
 const other=f.root+'/STRASSE/ς';assert.equal(fs.statSync(other).ino,fs.statSync(outside).ino);
 fs.symlinkSync(ref==='~/link'?f.root+'/STRASSE':other+'/nested',home+'/link');
 f.project('Child',`folders:\n  外: ${outside}\n`);const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 fs.renameSync(f.root+'/Straße',f.root+'/Retained');f.project('Parent',`folders:\n  使用: ${ref}\n`);
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external);
 assert.equal(f.r.validEntry(r,e,f.dir),false);assert.equal(f.r.restore(out.record,true).ok,false);assert.equal(fs.existsSync(e.to),true);
}));

for(const fault of ['create','lookup'])test(`external missing ancestor FS lookup failure blocks restore and cleans probes: ${fault}`,t=>withProtectedHome(t,(f,home)=>{
 const outside=f.root+'/Straße/Σ';f.write(outside+'/file.txt','external');fs.mkdirSync(outside+'/nested');fs.symlinkSync(f.root+'/STRASSE/ς/nested',home+'/link');
 f.project('Child',`folders:\n  外: ${outside}\n`);const d=f.r.preview('Child'),out=f.r.apply({token:d.token,confirm:true,optional:[d.keep[0].id]});assert.equal(out.ok,true);
 fs.renameSync(f.root+'/Straße',f.root+'/Retained');f.project('Parent','folders:\n  使用: ~/link/../file.txt\n');
 const r=JSON.parse(fs.readFileSync(path.join(f.r.records,out.record+'.json'))),e=r.entries.find(x=>x.external),method=fault==='create'?'mkdtempSync':'statSync',original=fs[method];let injected=0;
 t.mock.method(fs,method,(q,...args)=>{if(String(q).includes('.name-check-')&&(fault==='create'||String(q).endsWith('/STRASSE'))){injected++;throw Object.assign(Error('probe unavailable'),{code:'EACCES'});}return original(q,...args);});
 assert.equal(f.r.validEntry(r,e,f.dir),false);assert.equal(f.r.restore(out.record,true).ok,false);assert.ok(injected>0);
 assert.equal(fs.readFileSync(e.to+'/file.txt','utf8'),'external');assert.equal(fs.existsSync(e.from),false);assert.equal(fs.readdirSync(path.dirname(e.to)).some(n=>n.startsWith('.name-check-')),false);
}));

test('external selection keeps per-volume trash and signed shared-path refusal after alignment',t=>{
 const f=fixture(t),outside=path.join(f.root,'VolumeFixture','External');
 f.write(path.join(outside,'file.txt'),'external bytes');f.project('Child',`folders:\n  本体: ${outside}\n`);
 const externalTrash=path.join(f.root,'external-volume-trash'),ledgerTrash=path.join(f.root,'ledger-volume-trash');
 f.r.trashFor=source=>source===outside?externalTrash:ledgerTrash;
 f.r.trashDestination=(source,destination)=>destination.startsWith(f.r.trashFor(source)+path.sep);
 let preview=f.r.preview('Child');const selected=preview.keep.find(x=>x.path===outside);assert.equal(selected.selectable,true);
 const moved=f.r.apply({token:preview.token,optional:[selected.id],typed:preview.title,confirm:true});assert.equal(moved.ok,true);
 const record=JSON.parse(fs.readFileSync(path.join(f.r.records,moved.record+'.json'))),entry=record.entries.find(x=>x.external);
 assert.ok(entry.to.startsWith(externalTrash+path.sep));assert.equal(fs.existsSync(outside),false);
 f.project('Observer',`folders:\n  shared: ${outside}\n`);
 const blocked=f.r.restore(moved.record,true);assert.ok(blocked.skipped.some(x=>x.path===outside));assert.equal(fs.existsSync(outside),false);
 f.project('Observer','folders: {}\n');const restored=f.r.restore(moved.record,true);assert.equal(restored.ok,true);
 assert.equal(fs.readFileSync(path.join(outside,'file.txt'),'utf8'),'external bytes');
});
