'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'), {Hierarchy}=require('../lib/hierarchy');
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-tree-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const [id,name,parent,related] of [['p','Original','','[]'],['child','Child','Original','[Original]']]) {const d=path.join(root,'Product',id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'PROJECT.md'),`---\nname: ${name}\nstatus: 進行中\nparent: ${parent}\nrelated: ${related}\n---\nKeep me\n`);}
 const store=new Store(root);return{root,store,h:new Hierarchy(store)};
}
test('rename preserves IDs, paths, notes and old-name hierarchy/related links with backups',t=>{
 const f=setup(t),p=f.store.readProject('p');
 f.h.rename('p',null,'Renamed',p.completionHash);
 assert.equal(f.store.readProject('p').dir,p.dir); assert.equal(f.store.readProject('p').name,'Renamed');
 const c=f.store.readProject('child');assert.equal(c.parent,'p');assert.deepEqual(c.related,['p']);assert.match(c.notes,/Keep me/);
 assert.ok(fs.readdirSync(path.join(f.root,'_hub/hierarchy-backups')).length);
 assert.throws(()=>f.h.rename('p',null,'Again',p.completionHash),/更新/);
});
test('ambiguous old name prevents any rename; sibling and nested child use stable references',t=>{
 const f=setup(t);fs.mkdirSync(path.join(f.root,'Product','dup'));fs.writeFileSync(path.join(f.root,'Product','dup','PROJECT.md'),'---\nname: Original\n---\n');
 assert.throws(()=>f.h.rename('p',null,'New',f.store.readProject('p').completionHash),/一意/);
 assert.equal(f.store.readProject('p').name,'Original');
 const b=f.store.createProject({name:'Branch',parent:'child',derivedFrom:'p'},null).project;
 assert.equal(b.parent,'child');assert.equal(b.derivedFrom,'p');
 assert.ok(f.store.createProject({name:'Bad',parent:'missing'},null).error);
});
test('renaming an approved completed task preserves its approval',t=>{
 const f=setup(t),task=f.store.createTask('p',{title:'Task'});
 const done=f.store.decideTask('p',task.id,'approve',task.completionHash);
 const r=f.h.rename('p',task.id,'Changed',done.completionHash);assert.equal(r.state,'完了');assert.equal(r.id,task.id);
});
test('unrelated orphan links remain unchanged; active affected project prevents changes',t=>{
 const f=setup(t),file=path.join(f.root,'Product/child/PROJECT.md');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('parent: Original','parent: missing'));
 const before=fs.readFileSync(file,'utf8');
 assert.throws(()=>new Hierarchy(f.store,id=>id==='child').rename('p',null,'New',f.store.readProject('p').completionHash),/作業中/);
 assert.equal(fs.readFileSync(file,'utf8'),before);
 f.h.rename('p',null,'New',f.store.readProject('p').completionHash);
 assert.equal(f.store.readProject('child').parent,'missing');assert.deepEqual(f.store.readProject('child').related,['p']);
});
test('renaming unapproved completion cannot approve it, including CRLF references',t=>{
 const f=setup(t),task=f.store.createTask('p',{title:'Task'});
 f.store.updateTask('p',task.id,{state:'完了'});let pending=f.store.readTask(f.store.taskFile('p',task.id));
 assert.equal(pending.state,'完了確認待ち');pending=f.h.rename('p',task.id,'Renamed',pending.completionHash);assert.equal(pending.state,'完了確認待ち');
 const file=path.join(f.root,'Product/child/PROJECT.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\n/g,'\r\n'));
 f.h.rename('p',null,'New',f.store.readProject('p').completionHash);assert.deepEqual(f.store.readProject('child').related,['p']);assert.ok(!/(?<!\r)\n/.test(fs.readFileSync(file,'utf8')));
});

test('missing hash and renames that would bind orphan references are rejected',t=>{
 const f=setup(t);assert.throws(()=>f.h.rename('p',null,'New',undefined),/取得し直/);
 const file=path.join(f.root,'Product/child/PROJECT.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('parent: Original','parent: orphan'));
 assert.throws(()=>f.h.rename('p',null,'orphan',f.store.readProject('p').completionHash),/孤立/);
 assert.equal(f.store.readProject('p').name,'Original');
});

test('mixed newline unrelated ledger is unchanged and display punctuation round trips',t=>{
 const f=setup(t),other=path.join(f.root,'Product/other');fs.mkdirSync(other);const text='---\r\nname: Other\nrelated: []\r\n---\nMixed';fs.writeFileSync(path.join(other,'PROJECT.md'),text);
 const name='Title: # [x] C:\\new';f.h.rename('p',null,name,f.store.readProject('p').completionHash);
 assert.equal(f.store.readProject('p').name,name);assert.equal(fs.readFileSync(path.join(other,'PROJECT.md'),'utf8'),text);
});
