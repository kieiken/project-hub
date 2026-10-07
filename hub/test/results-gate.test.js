'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{ResultsGate}=require('../lib/results-gate'),{TaskIntegrate}=require('../lib/task-integrate');
const git=require('../lib/git'),{execFileSync}=require('node:child_process');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-results-gate-')),dir=path.join(root,'Product/P');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: P\n---\n');
 const store=new Store(root),parent=store.createTask('P',{title:'親'}),child=store.createTask('P',{title:'子',parent:parent.id,workspaceMode:'direct',steps:['完成']});
 store.setStep('P',child.id,0,true);const file=store.taskFile('P',child.id),removal=new Removal({store}),transfer=new TaskTransfer({store,removal});
 let launches=0,block='';const make=launch=>new ResultsGate({store,transfer,blocked:()=>block,launch:launch || (async()=>{launches++;})});const gate=make();
 const current=()=>gate.current('P',child.id),declare=s=>{const text=fs.readFileSync(file,'utf8').split('\n## 成果\n')[0];fs.writeFileSync(file,text+'\n## 成果\n'+s+'\n');};
 return {root,dir,store,parent,child,file,transfer,removal,gate,make,current,declare,get launches(){return launches;},set block(v){block=v;}};
}
test('不正宣言は完了表示を抑止し二重契機・再起動でも自動依頼は同hashで一度',async t=>{
 const f=fixture(t);f.declare('できました');const {all,p,t:task}=f.current(),shown=f.gate.decorate(p,task,all);
 assert.equal(task.completionPending,true);assert.equal(shown.completionPending,false);assert.equal(shown.resultsPending.code,'format');assert.equal(f.launches,0);
 await Promise.all([f.gate.trigger('P',task.id),f.gate.trigger('P',task.id)]);assert.equal(f.launches,1);
 await f.gate.trigger('P',task.id);await f.make().trigger('P',task.id);assert.equal(f.launches,1);
 assert.equal(fs.readFileSync(f.file,'utf8').includes('できました'),true);assert.equal(f.gate.decorate(p,task,all).resultsPending.auto,'failed');
});
test('正しいなし・明示ファイル・本体保存済みは従来どおり、ファイル消失は再検査で拒否',t=>{
 const f=fixture(t),body=f.dir;const sh=(...a)=>execFileSync('git',['-C',body,...a],{encoding:'utf8'}).trim();sh('init','-q');sh('config','user.email','test@localhost');sh('config','user.name','Test');sh('add','.');sh('commit','-qm','base');
 const artifact=path.join(f.dir,'report.txt');fs.writeFileSync(artifact,'report');
 for(const row of ['- なし：確認のみ','- ファイル：report.txt（結果）','- 本体保存済み：.@'+sh('rev-parse','HEAD')+'（保存済み）']){
  f.declare(row);const {all,p,t:task}=f.current();assert.equal(f.gate.decorate(p,task,all).completionPending,true);assert.equal(f.transfer.resultIssue(p,task).ok,true);
 }
 f.declare('- 本体保存済み：.@1234567（未保存）');let c=f.current();assert.equal(f.transfer.resultIssue(c.p,c.t).code,'verify');
 f.declare('- ファイル：report.txt（結果）');c=f.current();assert.equal(f.gate.approvalIssue(c.p,c.t,c.all).ok,true);fs.unlinkSync(artifact);assert.equal(f.gate.approvalIssue(c.p,c.t,c.all).ok,false);
});
test('copyのコードは行なしでも通すが書式不正を隠さず、統合と完了ゲートが一致',t=>{
 const f=fixture(t),sh=(...a)=>execFileSync('git',['-C',f.dir,...a],{encoding:'utf8'});sh('init','-q');sh('config','user.email','test@localhost');sh('config','user.name','Test');sh('add','.');sh('commit','-qm','base');
 const w=git.prepare({base:f.dir,workRoot:f.removal.workRoot({id:'P'}),taskId:f.child.id});f.store.updateTask('P',f.child.id,{workdir:w.dir});fs.writeFileSync(path.join(w.dir,'code.txt'),'new');git.save(w.dir,'code');
 const integrate=new TaskIntegrate({store:f.store,transfer:f.transfer,removal:f.removal});
 for(const declaration of ['', '自由書式', '- なし：ファイル成果は無し']) {
  f.declare(declaration);const {all,p,t:task}=f.current(),issue=f.transfer.resultIssue(p,task),d=integrate.details({all,p,t:f.parent,target:f.dir},p,task);
  assert.equal(d.needsResults,!issue.ok);assert.equal(Boolean(f.gate.decorate(p,task,all).resultsPending),!issue.ok);assert.equal(issue.ok,declaration!=='自由書式');
 }
});
for(const reason of ['質問待ち','AIが作業中です','順番待ち','ターミナル稼働','統合中'])test('抑止と後続番終了の再判定：'+reason,async t=>{
 const f=fixture(t);f.block=reason;await f.gate.trigger('P',f.child.id);assert.equal(f.launches,0);f.block='';await f.gate.trigger('P',f.child.id);assert.equal(f.launches,1);
});
for(const error of ['止めました','CLI失敗'])test('エラー・停止の自動再試行禁止：'+error,async t=>{
 const f=fixture(t);await f.gate.trigger('P',f.child.id,{row:{error}});await f.gate.trigger('P',f.child.id);assert.equal(f.launches,0);
 const c=f.current();assert.equal(f.gate.decorate(c.p,c.t,c.all).resultsPending.auto,'blocked');
 await f.gate.trigger('P',f.child.id,{manual:true,expectedHash:c.t.completionHash});assert.equal(f.launches,1);
});
test('整理がtask hashを書き換えてもループせず、古い手動依頼は拒否・人は再依頼可',async t=>{
 const f=fixture(t);await f.gate.trigger('P',f.child.id);const old=f.current().t.completionHash;
 fs.appendFileSync(f.file,'\n変更したが不正のまま\n');await f.gate.trigger('P',f.child.id,{organized:true,row:{}});await f.gate.trigger('P',f.child.id);assert.equal(f.launches,1);
 await assert.rejects(f.gate.trigger('P',f.child.id,{manual:true,expectedHash:old}),/確認中/);
 await f.gate.trigger('P',f.child.id,{manual:true,expectedHash:f.current().t.completionHash});assert.equal(f.launches,2);
});
test('整理起動失敗は保存して再試行せず、手順再開時に記録を解除',async t=>{
 const f=fixture(t),g=f.make(async()=>{throw Error('起動失敗');});await assert.rejects(g.trigger('P',f.child.id),/起動失敗/);
 await g.trigger('P',f.child.id);f.store.addStep('P',f.child.id,'追加');await g.trigger('P',f.child.id);assert.deepEqual(g.records,{});
});
test('最上位・承認済み・freetalk・未完了は表示も記録も従来どおり',async t=>{
 const f=fixture(t);const c=f.current();for(const task of [{...c.t,parent:''},{...c.t,state:'完了',completionPending:false},{...c.t,freetalk:true},{...c.t,completionPending:false}])assert.deepEqual(f.gate.decorate(c.p,task,c.all),task);
 f.store.decideTask('P',f.child.id,'approve',c.t.completionHash);await f.gate.trigger('P',f.child.id);assert.equal(f.launches,0);
});

test('上限交代の待ち順があるエラー終了は後続番に判定を渡し、同hashの成功後は整理する',async t=>{
 const f=fixture(t);f.block='順番待ちがあります';await f.gate.trigger('P',f.child.id,{row:{error:'利用上限'}});assert.equal(f.launches,0);assert.deepEqual(f.gate.records,{});
 f.block='';await f.gate.trigger('P',f.child.id,{row:{}});assert.equal(f.launches,1);
});
