'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-task-ids-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product','Fixture');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');
 return {root,dir,store:new Store(root),write:(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);}};
}
test('通常削除・再起動後も番号を再利用せず、元作業を上書きなしで復元できる',t=>{
 const f=fixture(t),task=f.store.createTask('Fixture',{title:'最初'}),removal=new Removal({store:f.store,trash:path.join(f.root,'Trash')});
 const p=removal.preview('Fixture',task.id),r=removal.apply({token:p.token,confirm:true});assert.equal(r.ok,true);
 const next=new Store(f.root).createTask('Fixture',{title:'次'});assert.notEqual(next.id,task.id);
 assert.equal(removal.restore(r.record,true).ok,true);assert.equal(f.store.readTask(f.store.taskFile('Fixture',task.id)).title,'最初');assert.equal(f.store.readTask(f.store.taskFile('Fixture',next.id)).title,'次');
});
test('旧版の削除/受領/取り込み履歴・専用成果・コピーに残る番号を再割当しない',t=>{
 for(const source of ['removed','task-handoffs','log.jsonl','log.old.jsonl','作業','成果物','attachments','Work','completion','chat','handoff']) {
  const f=fixture(t),old=f.store.createTask('Fixture',{title:'旧作業'});fs.unlinkSync(f.store.taskFile('Fixture',old.id));fs.rmSync(path.join(f.root,'_hub/task-ids'),{recursive:true});
  if(['removed','task-handoffs'].includes(source))f.write(path.join(f.root,'_hub',source,'legacy.json'),JSON.stringify({project:'Fixture',task:old.id,complete:true}));
  else if(source.startsWith('log'))f.write(path.join(f.root,'_hub',source),JSON.stringify({action:'merge',project:'Fixture',task:old.id,ok:true})+'\n');
  else if(source==='completion'){f.store.completion.data.tasks['Fixture/'+old.id]={hash:'legacy'};f.store.completion.save();}
  else if(source==='Work')fs.mkdirSync(path.join(f.root,'Work','Fixture',old.id),{recursive:true});
  else if(source==='chat')f.write(path.join(f.dir,'.ai/chat',old.id+'.jsonl'),'{}\n');
  else if(source==='handoff')f.write(path.join(f.dir,'.ai/handoff',old.id+'-20261006-010203-codex.md'),'old');
  else f.write(path.join(f.dir,source,old.id,'old.txt'),'old');
  const next=new Store(f.root).createTask('Fixture',{title:'新規'});assert.notEqual(next.id,old.id,source);
 }
});
test('予約後の作成失敗でも番号を使い直さず、壊れた旧履歴では作成しない',t=>{
 const f=fixture(t),first=f.store.createTask('Fixture',{title:'先頭'}),write=fs.writeFileSync;
 fs.writeFileSync=(file,...args)=>{if(path.dirname(file)===path.join(f.dir,'.ai/tasks'))throw Error('fixture task write');return write(file,...args);};
 try{assert.throws(()=>f.store.createTask('Fixture',{title:'失敗'}),/task write/);}finally{fs.writeFileSync=write;}
 const next=new Store(f.root).createTask('Fixture',{title:'次'});assert.equal(Number(next.id.split('-')[1]),Number(first.id.split('-')[1])+2);
 f.write(path.join(f.root,'_hub/task-handoffs/broken.json'),'{');assert.throws(()=>f.store.createTask('Fixture',{title:'保全'}));assert.equal(f.store.readProject('Fixture').tasks.length,2);
});
