'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{execFileSync}=require('node:child_process');
const git=require('../lib/git'),read=require('../lib/git-read'),writes=require('../lib/integration-writes');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-git-async-')),body=path.join(root,'Body');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};write(path.join(body,'base.txt'),'base\n');write(path.join(root,'Product/Fixture/PROJECT.md'),'---\nname: Fixture\n---\n');
 const sh=(...a)=>execFileSync('git',['-C',body,...a],{encoding:'utf8',stdio:'pipe'}).trim();for(const a of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@localhost'],['add','.'],['commit','-qm','base']])sh(...a);
 const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),{IntegrateAuto}=require('../lib/integrate-auto');
 const store=new Store(root),parent=store.createTask('Fixture',{title:'parent'}),removal=new Removal({store,trash:path.join(root,'Trash')}),transfer=new TaskTransfer({store,removal,baseOf:()=>body}),h=new TaskIntegrate({store,transfer,removal,baseOf:()=>body}),auto=new IntegrateAuto({integrate:h});
 const child=store.createTask('Fixture',{title:'child',parent:parent.id,steps:['done']});store.setStep('Fixture',child.id,0,true);
 const w=git.prepare({base:body,workRoot:removal.workRoot({id:'Fixture'}),taskId:child.id});store.updateTask('Fixture',child.id,{workdir:w.dir});write(path.join(w.dir,'child.txt'),'child\n');git.save(w.dir,'child');
 return {root,body,sh,write,store,parent,child,removal,transfer,h,auto,copy:w.dir};
}
const withoutToken=d=>{const x=structuredClone(d);delete x.token;return x;};
test('read-only async primitives match synchronous snapshots without touching index',async t=>{
 const f=fixture(t);for(const dirty of [false,true]){
  if(dirty){f.write(path.join(f.copy,'child.txt'),'changed\n');f.write(path.join(f.copy,'new.txt'),'new\n');}
  const index=f.sh('rev-parse','--git-path','index'),before=fs.readFileSync(path.resolve(f.body,index));
  assert.deepEqual(await git.inspectAsync(f.copy),git.inspect(f.copy,{readOnly:true}));
  assert.equal(await git.mainOfAsync(f.copy),git.mainOf(f.copy));assert.equal(await git.mergingAsync(f.copy),git.merging(f.copy));assert.equal(await git.dirtyAsync(f.copy),git.dirty(f.copy));
  assert.equal(await git.isAncestorAsync(f.copy,f.sh('rev-parse','HEAD')),true);
  assert.deepEqual(await writes.inspectAsync(git,f.body),writes.inspect(git,f.body));
  assert.deepEqual(fs.readFileSync(path.resolve(f.body,index)),before);
 }
});
test('async merge preview matches sync and async integration preview retains the real token owner',async t=>{
 const f=fixture(t),options={dir:f.copy,workRoot:f.removal.workRoot({id:'Fixture'}),root:f.root};
 assert.deepEqual(await git.previewAsync(options),git.preview({...options,targetGuard:d=>writes.inspect(git,d)}));
 const b={project:'Fixture',task:f.parent.id,simple:true},expected=f.auto.preview(b),actual=await f.auto.previewAsync(b);
 assert.deepEqual(withoutToken(actual),withoutToken(expected));assert.ok(f.h.tokens.has(actual.token));
 const check=require('../lib/main-merge-check');assert.deepEqual(await check.checkAsync(git,f.body,'target'),check.check(git,f.body,'target'));
});
test('one retry after HEAD/index change; second change fails closed',async t=>{
 const f=fixture(t);let count=0;const once=await read.consistent([f.body],async()=>{count++;if(count===1)f.sh('commit','--allow-empty','-qm','new head');return count;});assert.equal(once,2);assert.equal(count,2);
 count=0;await assert.rejects(read.consistent([f.body],async()=>{f.sh('commit','--allow-empty','-qm','change '+(++count));}),{code:'GIT_READ_CHANGED'});assert.equal(count,2);
});
test('identical overlapping Git reads share one child and a later request reads again',async t=>{
 const f=fixture(t),a=read.command(f.body,['rev-parse','HEAD']),b=read.command(f.body,['rev-parse','HEAD']);assert.equal(a,b);await a;assert.notEqual(read.command(f.body,['rev-parse','HEAD']),a);
 const request={project:'Fixture',task:f.parent.id,simple:true},first=f.auto.previewAsync(request);assert.equal(f.auto.previewAsync(request),first);await first;
});
test('index-only changes trigger one reread; display workers reject action methods',async t=>{
 const f=fixture(t);let count=0;await read.consistent([f.copy],async()=>{if(++count===1){f.write(path.join(f.copy,'staged'),'new');execFileSync('git',['-C',f.copy,'add','staged']);}});assert.equal(count,2);
 await assert.rejects(require('../lib/integration-read-worker').run('flow.write',{},{dirs:[f.body]}),/unknown display operation/);
});
test('index refresh timestamps on both reads return the second display result',async t=>{
 const f=fixture(t),index=path.join(f.sh('rev-parse','--absolute-git-dir'),'index'),original=fs.readFileSync(index),initial=read.stamp(f.body);let count=0;
 const refresh=()=>{const time=new Date(Date.now()+(++count)*10000);fs.utimesSync(index,time,time);return count;};
 assert.equal(await read.consistent([f.body],async()=>refresh()),2);assert.equal(count,2);
 assert.deepEqual(fs.readFileSync(index),original);assert.equal(read.stamp(f.body).strong,initial.strong);assert.notEqual(read.stamp(f.body).weak,initial.weak);
 count=0;const failure=Object.assign(Error('read failed'),{code:'EIO'});
 await assert.rejects(read.consistent([f.body],async()=>{refresh();throw failure;}),error=>error===failure);assert.equal(count,2);
});
test('ordinary external git status refreshes do not reject a display read',async t=>{
 const f=fixture(t),tracked=path.join(f.body,'base.txt'),initial=read.stamp(f.body),externalEnv={...process.env};delete externalEnv.GIT_OPTIONAL_LOCKS;let count=0;
 const result=await read.consistent([f.body],async()=>{
  const time=new Date(Date.now()+(++count)*10000);fs.utimesSync(tracked,time,time);
  execFileSync('git',['-C',f.body,'status','--porcelain'],{env:externalEnv,stdio:'pipe'});return count;
 });
 assert.equal(result,2);assert.equal(count,2);assert.equal(read.stamp(f.body).strong,initial.strong);assert.notEqual(read.stamp(f.body).weak,initial.weak);
});
test('repeated saved-state changes have a dedicated preflight reason',async()=>{
 const check=require('../lib/main-merge-check'),failure=Object.assign(Error('changed'),{code:'GIT_READ_CHANGED'});
 for(const side of ['source','target']){
  const {blocker}=await check.checkAsync({mergingAsync:async()=>{throw failure;}},'/fixture',side);
  assert.equal(blocker.kind,'changed');assert.equal(blocker.reason,'確認中に保存状態が変わりました。少し待ってから開き直してください');
  assert.equal(check.refusal(blocker).delivery.state,'not-sent');
 }
 const {blocker}=await check.checkAsync({mergingAsync:async()=>{throw Error('unreadable');}},'/fixture','source');assert.equal(blocker.kind,'unreadable');
});

test('historical shared-task integration validates Git inside the display worker, never the parent hook',async t=>{
 const f=fixture(t);f.store.updateTask('Fixture',f.child.id,{workdir:f.body});
 const record={main:f.body,commit:f.sh('rev-parse','HEAD'),files:['base.txt']};
 f.transfer.integration=(p,task)=>git.integrationReceipt(f.body,record,task);
 const expected=f.h.preview('Fixture',f.parent.id);let reads=0;
 f.transfer.integrationRead=(p,task)=>{reads++;return {dir:f.body,record,task};};
 f.transfer.integration=()=>{throw Error('parent must not validate Git');};
 const actual=await f.h.previewAsync('Fixture',f.parent.id);
 assert.ok(reads>0);assert.deepEqual(withoutToken(actual),withoutToken(expected));
});

test('git display cache skips repeated graph preview, invalidates both HEADs and dirty contents, and returns isolated values',async t=>{
 const f=fixture(t),options={dir:f.copy,workRoot:f.removal.workRoot({id:'Fixture'}),root:f.root},worker=require('../lib/integration-read-worker'),run=worker.run;let calls=0;
 worker.run=(...a)=>{if(a[0]==='git.preview')calls++;return run(...a);};t.after(()=>{worker.run=run;});
 const first=await git.previewAsync(options);assert.equal(calls,1);first.paths.push('caller mutation');const second=await git.previewAsync(options);assert.equal(calls,1);assert.ok(!second.paths.includes('caller mutation'));
 f.write(path.join(f.copy,'child.txt'),'changed\n');await git.previewAsync(options);assert.equal(calls,2);await git.previewAsync(options);assert.equal(calls,2);
 f.write(path.join(f.copy,'child.txt'),'different\nmore\n');const dirty=await git.previewAsync(options);assert.equal(calls,3);assert.equal(dirty.added,2);
 f.write(path.join(f.body,'base.txt'),'target changed\n');assert.equal((await git.previewAsync(options)).mainDirty,true);assert.equal(calls,4);
 f.sh('add','.');f.sh('commit','-qm','target head');await git.previewAsync(options);assert.equal(calls,5);
 f.write(path.join(f.copy,'new.txt'),'new');await git.previewAsync(options);assert.equal(calls,6);f.write(path.join(f.copy,'new.txt'),'changed');await git.previewAsync(options);assert.equal(calls,7);
});
test('unusual Git discovery disables completed-result reuse while preserving the original display read',async t=>{
 const f=fixture(t),options={dir:f.copy,workRoot:f.removal.workRoot({id:'Fixture'}),root:f.root},old=process.env.GIT_NAMESPACE;
 process.env.GIT_NAMESPACE='fixture';t.after(()=>{if(old===undefined)delete process.env.GIT_NAMESPACE;else process.env.GIT_NAMESPACE=old;});
 assert.equal(read.stamp(f.copy),null);
 const a=await git.previewAsync(options),b=await git.previewAsync(options);assert.deepEqual(a,b);assert.deepEqual(a,git.preview({...options,targetGuard:d=>writes.inspect(git,d)}));
});
