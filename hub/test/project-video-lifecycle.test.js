'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{ProjectAttachments}=require('../lib/project-attachments'),chat=require('../lib/chat');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-video-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);return file;};
 const dir=path.join(root,'Product','Source');write(path.join(dir,'PROJECT.md'),'---\nname: Source\nparent: Target\nfolders: {}\nrelated: []\n---\n');write(path.join(root,'Product/Target/PROJECT.md'),'---\nname: Target\nfolders: {}\nrelated: []\n---\n');
 const store=new Store(root),parent=store.createTask('Target',{title:'Parent'}),task=store.createTask('Source',{title:'Video task',kind:'derived',derivedFrom:'Target/'+parent.id}),other=store.createTask('Source',{title:'Reader'}),p=store.readProject('Source');
 const service=new ProjectAttachments(store,{state:()=>({generation:1})}).forProject(p);
 // Storage fixture: actual extraction and descriptor creation are covered by project-video-http.
 const original=service.ft.upload(task.id,'phone.mov',Buffer.from('original video fixture')),base=path.dirname(original),derived=path.join(base,'.derived',path.basename(original).slice(0,36));
 const transcript=write(path.join(derived,'transcript.txt'),'[00:00] speech fixture'),frame=write(path.join(derived,'frame-01.jpg'),'frame fixture'),descriptor=write(path.join(derived,'attachment.json'),JSON.stringify({path:original,imagePaths:[frame]}));
 store.updateTask(p.id,task.id,{memo:'動画参照 '+original});chat.append(dir,task.id,{role:'user',text:'動画の参照\n'+original+'\n'+frame});
 const removal=new Removal({store,trash:path.join(root,'Trash')}),temp=path.join(dir,'.ai/work',task.id);
 return {root,dir,store,task,other,p,original,frame,transcript,descriptor,base,temp,write,removal};
}
test('task deletion moves originals and derived frames despite its own memo/chat references, and restores them',t=>{
 const f=fixture(t);assert.equal(f.base,path.join(f.temp,'chat-attachments'));
 assert.equal(f.removal.referenced(f.temp,f.p,f.task,f.store.listProjects()),false);
 // Tidying preserves a live conversation's referenced media; deleting the conversation moves both together.
 const tidy=f.removal.tidyPreview(f.p.id,f.task.id);assert.ok(tidy.keep.some(x=>x.path===f.temp));assert.ok(!tidy.move.some(x=>x.path===f.temp));
 const d=f.removal.preview(f.p.id,f.task.id);assert.deepEqual(d.blockers,[]);assert.ok(d.move.some(x=>x.path===f.temp));
 const bytes=[f.original,f.frame,f.transcript,f.descriptor].map(file=>fs.readFileSync(file));const out=f.removal.apply({token:d.token,confirm:true});assert.ok(!fs.existsSync(f.temp));assert.equal(f.store.taskFile(f.p.id,f.task.id),null);
 f.removal.restore(out.record,true);[f.original,f.frame,f.transcript,f.descriptor].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),bytes[i]));
});
test('another task reference still protects video storage from removal',t=>{
 const f=fixture(t);chat.append(f.dir,f.other.id,{role:'user',text:'共有 '+f.frame});assert.equal(f.removal.referenced(f.temp,f.p,f.task,f.store.listProjects()),true);
 const d=f.removal.preview(f.p.id,f.task.id);assert.ok(d.keep.some(x=>x.path===f.temp));assert.ok(!d.move.some(x=>x.path===f.temp));
});
test('cross-project task transfer includes the task video folder in reversible cleanup',t=>{
 const f=fixture(t);const taskFile=f.store.taskFile(f.p.id,f.task.id);fs.appendFileSync(taskFile,'\n## 手順\n- [x] fixture complete\n');
 const report=f.write(path.join(f.dir,'作業',f.task.id,'report.txt'),'video result');f.store.appendSection(f.p.id,f.task.id,'成果','- ファイル：作業/'+f.task.id+'/report.txt（結果）');
 const transfer=new TaskTransfer({store:f.store,removal:f.removal}),d=transfer.preview(f.p.id,f.task.id);assert.deepEqual(d.blockers,[]);assert.ok(d.move.some(x=>x.path===f.temp));assert.equal(d.targetProject,'Target');
 const out=transfer.apply({project:f.p.id,task:f.task.id,token:d.token,selected:d.files.map(x=>x.id),confirm:true});assert.equal(out.ok,true);assert.ok(!fs.existsSync(f.temp));assert.ok(fs.existsSync(report));assert.equal(fs.readFileSync(out.files[0],'utf8'),'video result');
 const record=JSON.parse(fs.readFileSync(path.join(f.removal.records,out.record+'.json'),'utf8')),entry=record.entries.find(e=>e.from===f.temp);assert.ok(entry.moved);assert.equal(fs.readFileSync(path.join(entry.to,path.relative(f.temp,f.original)),'utf8'),'original video fixture');
 f.removal.restore(out.record,true);assert.ok(fs.existsSync(f.original));assert.ok(fs.existsSync(f.frame));assert.ok(fs.existsSync(f.descriptor));
});
