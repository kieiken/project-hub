'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {pending,source}=require('../lib/pending-question'),{Store}=require('../lib/store'),{TaskHistory}=require('../lib/task-history'),chat=require('../lib/chat');
const asks=[{question:'下書きを保存しますか？',options:['保存する（おすすめ：下書きを残し、公開しません）','所有側の保存を待つ'],multi:false},{question:'残す色は？',options:['青','緑'],multi:true}];
const question={at:'2026-11-01T14:23:18Z',role:'assistant',ai:'claude',text:'説明',asks};
test('full question group survives clarification, delegation and summary selection; only matching answers close it',()=>{
  const batch={source:source(question),asks};
  for(const extra of [
    {role:'user',text:'何をどう返事したらいいのか？'},
    {role:'user',origin:'delegate',text:asks[0].options[0]},
    {role:'user',from:'delegate',text:asks[0].options[0]},
    {role:'user',text:'【渡した依頼：会話の自動整理】\n整理してください'},
    {role:'assistant',text:'作業中です'},
    {role:'event',answeredQuestionSource:'old-source'},
  ])assert.deepEqual(pending([question,extra]),batch);
  assert.deepEqual(pending([{role:'event',summaryAuto:true,pendingQuestion:batch}]),batch);
  assert.equal(pending([question,{role:'event',answeredQuestionSource:batch.source}]),null);
  assert.deepEqual(pending([question,{...question,at:'later',asks:[asks[0]]}]).asks,[asks[0]],'new question group supersedes the older group');
});
test('legacy exact answers need a successful reply, not a failed launch; free form is never guessed',()=>{
  const single={...question,asks:[asks[0]]},answer={role:'user',text:asks[0].options[0]};
  assert.ok(pending([single,answer,{role:'assistant',error:'failed',text:''}]));
  assert.equal(pending([single,answer,{role:'assistant',text:'保存しました'}]),null);
  assert.ok(pending([single,{role:'user',text:'相談したい'},{role:'assistant',text:'どうぞ'}]));
  const multi={role:'user',text:asks.map(a=>a.question+'：'+a.options[0]).join('\n\n')};
  assert.equal(pending([question,multi,{role:'assistant',text:'受付'}]),null);
  multi.text=asks[0].question+'：'+asks[0].options[0]+'\n\n'+asks[1].question+'：青、緑';
  assert.equal(pending([question,multi,{role:'assistant',text:'受付'}]),null,'legacy multiple selections stay answered');
});
function fixture(t){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-pending-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'Product','Fixture');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');
  const store=new Store(root),task=store.createTask('Fixture',{title:'質問表示',steps:['実装']}),file=store.taskFile('Fixture',task.id);
  // The task field deliberately disagrees with the saved question.
  store.updateTask('Fixture',task.id,{question:'古い質問'});
  const records=[],history=new TaskHistory({store,record:(...args)=>records.push(args)});
  const commit=()=>history.commit('Fixture',task.id,{requestId:randomUUID(),revision:history.revision('Fixture',task.id),summary:'短い要約',row:{role:'event',summaryAuto:true,text:'要約'}});
  return {root,dir,store,task,file,history,commit,records};
}
test('summary carries all questions/options/reasons across reload and a second summary without changing task metadata',t=>{
  const f=fixture(t);chat.append(f.dir,f.task.id,question);const before=fs.readFileSync(f.file,'utf8');
  f.commit();const saved=chat.read(f.dir,f.task.id)[0];assert.deepEqual(saved.pendingQuestion.asks,asks);
  assert.equal(f.store.readTask(f.file).question,'古い質問');
  const reload=new TaskHistory({store:f.store});assert.deepEqual(reload.pendingQuestion('Fixture',f.task.id),saved.pendingQuestion);
  chat.append(f.dir,f.task.id,{role:'user',origin:'delegate',text:'表示を確認する'});f.commit();
  assert.deepEqual(f.history.pendingQuestion('Fixture',f.task.id).asks,asks);
  chat.append(f.dir,f.task.id,{role:'event',answeredQuestionSource:saved.pendingQuestion.source,text:''});f.commit();
  assert.equal(new TaskHistory({store:f.store}).pendingQuestion('Fixture',f.task.id),null);
  assert.equal(chat.read(f.dir,f.task.id)[0].pendingQuestion,null,'explicit empty state prevents archived questions resurfacing');
  assert.match(before,/古い質問/);
});
test('already archived questions restore from the verified original, read-only, and answer state survives the next archive',t=>{
  const f=fixture(t);const row=chat.append(f.dir,f.task.id,question),out=f.commit(),file=chat.files(f.dir,f.task.id).log;
  const summary=chat.read(f.dir,f.task.id)[0];delete summary.pendingQuestion;fs.writeFileSync(file,JSON.stringify(summary)+'\n');
  const before=fs.readFileSync(file),task=fs.readFileSync(f.file),original=fs.readFileSync(path.join(f.history.archiveRoot('Fixture',f.task.id),out.archiveId,'1.original'));
  const restored=f.history.pendingQuestion('Fixture',f.task.id);assert.deepEqual(restored,{source:source(row),asks});
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(f.file),task);
  assert.deepEqual(fs.readFileSync(path.join(f.history.archiveRoot('Fixture',f.task.id),out.archiveId,'1.original')),original);
  chat.append(f.dir,f.task.id,{role:'event',answeredQuestionSource:restored.source,text:''});f.commit();
  assert.equal(new TaskHistory({store:f.store}).pendingQuestion('Fixture',f.task.id),null);
});
test('legacy recovery refuses altered originals rather than inventing a question',t=>{
  const f=fixture(t);chat.append(f.dir,f.task.id,question);const out=f.commit(),file=chat.files(f.dir,f.task.id).log;
  const summary=chat.read(f.dir,f.task.id)[0];delete summary.pendingQuestion;fs.writeFileSync(file,JSON.stringify(summary)+'\n');
  f.history.pendingQuestion('Fixture',f.task.id); // populate the read cache
  fs.appendFileSync(path.join(f.history.archiveRoot('Fixture',f.task.id),out.archiveId,'1.original'),'\n');
  assert.throws(()=>f.history.pendingQuestion('Fixture',f.task.id),/原文が変わって/);
});

test('question recovery failure does not stop summary or save a false empty question state',t=>{
  const f=fixture(t),row=chat.append(f.dir,f.task.id,question);
  const mock=t.mock.method(f.history,'pendingQuestion',()=>{throw Error('fixture archive unavailable');});
  const result=f.commit();mock.mock.restore();
  const summary=chat.read(f.dir,f.task.id)[0];
  assert.equal(Object.hasOwn(summary,'pendingQuestion'),false);
  assert.equal(summary.summaryAuto,true);assert.equal(summary.archiveId,result.archiveId);
  assert.equal(f.history.state('Fixture',f.task.id).generation,2);
  assert.deepEqual(new TaskHistory({store:f.store}).pendingQuestion('Fixture',f.task.id),{source:source(row),asks});
  assert.deepEqual(f.records,[['question-display-read-error',{project:'Fixture',task:f.task.id},{phase:'summary',error:'fixture archive unavailable'}]]);
});
