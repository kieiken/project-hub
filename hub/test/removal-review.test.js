'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{RemovalReview}=require('../lib/removal-review'),{buildTurn}=require('../lib/chat');
function fixture(t,start){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-remove-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product/P'),outside=path.join(root,'Outside');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'x'),'x');fs.writeFileSync(path.join(dir,'PROJECT.md'),`---\nname: P\nfolders:\n  本体: ${outside}\nrelated: []\n---\n`);
 const store=new Store(root),rows=[],state={busy:false,queued:false},r=new Removal({store,trash:path.join(root,'Trash'),reviewBusy:p=>review.active(p)});let sent;
 const review=new RemovalReview({store,removal:r,busy:()=>state.busy,queued:()=>state.queued,rows:()=>rows,start:async o=>{sent=o;state.busy=true;return start?start(o):{started:Promise.resolve(true)};}});
 return {root,dir,outside,store,r,review,rows,state,get sent(){return sent;}};
}
test('review creates one local task, blocks deletion until finished, saves validated JSON and refreshes preview',async t=>{
 const f=fixture(t),old=f.r.preview('P'),result=await f.review.begin(old.token);assert.equal(f.sent.readOnly,true);assert.ok(f.sent.readDirs.includes(f.outside));assert.ok(f.sent.readDirs.includes(f.store.product));assert.match(f.sent.text,/JSONはHub/);assert.equal(f.sent.dir,f.dir);assert.equal(f.store.readProject('P').tasks.length,1);
 assert.equal(f.review.status('P').status,'running');await assert.rejects(()=>f.review.begin(old.token),/すでに/);assert.throws(()=>f.r.apply({token:old.token,confirm:true}),/確認中/);
 f.rows.push({role:'assistant',request:result.id,text:JSON.stringify({results:[{id:old.keep[0].id,sharing:'なし',reason:'用途を資料と照合し確認'}]})});f.state.busy=false;
 const status=f.review.status('P');assert.equal(status.status,'done');assert.equal(status.results[0].sharing,'なし');assert.equal(JSON.parse(fs.readFileSync(f.review.file('P'))).status,'done');assert.equal(f.store.readProject('P').tasks[0].steps[0].done,true);
 assert.throws(()=>f.r.apply({token:old.token,confirm:true}),/変わりました/);assert.equal(f.r.preview('P').blockers.length,0);
 fs.appendFileSync(path.join(f.outside,'x'),'changed');assert.equal(f.review.status('P').status,'stale');assert.equal(f.review.status('P').results.length,0);
});
test('malformed, incomplete, duplicate, unknown, blank and errored replies never produce choices',async t=>{
 for(const kind of ['malformed','incomplete','unknown','blank','invalid-sharing','duplicate','error','stopped']){
  const f=fixture(t),d=f.r.preview('P'),r=await f.review.begin(d.token);f.state.busy=false;
  if(kind!=='stopped')f.rows.push({role:'assistant',request:r.id,error:kind==='error'?'CLI failed':'',text:kind==='malformed'?'broken':JSON.stringify({results:kind==='incomplete'?[]:[{id:kind==='unknown'?'other':d.keep[0].id,reason:kind==='blank'?' ':'reason',sharing:kind==='invalid-sharing'?'safe':'なし'},...(kind==='duplicate'?[{id:d.keep[0].id,sharing:'なし',reason:'duplicate'}]:[])]})});
  assert.equal(f.review.status('P').status,'failed',kind);assert.equal(f.review.status('P').results.length,0,kind);assert.equal(f.r.preview('P').blockers.length,0,kind);
 }
});
test('launch failure, restart, stale token and task preview do not retry or accept old results',async t=>{
 let calls=0;const f=fixture(t,()=>{calls++;throw Error('CLI missing');});await assert.rejects(()=>f.review.begin(f.r.preview('P').token),/CLI missing/);assert.equal(calls,1);assert.equal(f.review.status('P').status,'failed');assert.equal(calls,1);
 const g=fixture(t),d=g.r.preview('P');fs.appendFileSync(path.join(g.outside,'x'),'changed');await assert.rejects(()=>g.review.begin(d.token),/変わりました/);assert.equal(g.store.readProject('P').tasks.length,0);
 const task=g.store.createTask('P',{title:'Existing'});await assert.rejects(()=>g.review.begin(g.r.preview('P',task.id).token),/プロジェクト/);
 const h=fixture(t),r=await h.review.begin(h.r.preview('P').token);h.state.busy=false;h.state.queued=true;h.rows.push({role:'assistant',request:r.id,error:'Fable limit'});assert.equal(h.review.status('P').status,'running');h.state.queued=false;assert.equal(h.review.status('P').status,'failed');
});
test('read-only launch removes unrestricted permissions and blocks write/exec/MCP tools',()=>{
 const opts={model:'claude-fable-5-1',meta:{},rows:[],text:'JSON only',readOnly:true,perm:'claude --dangerously-skip-permissions'};
 const c=buildTurn({...opts,ai:'claude'});assert.ok(!c.args.includes('--dangerously-skip-permissions'));assert.equal(c.args[c.args.indexOf('--tools')+1],'Read,Glob,Grep');assert.ok(c.args.includes('--strict-mcp-config'));assert.equal(c.args[c.args.indexOf('--permission-mode')+1],'dontAsk');
 const d=buildTurn({...opts,ai:'codex',model:'gpt-6-astra',perm:'codex --dangerously-bypass-approvals-and-sandbox'});assert.ok(!d.args.includes('--dangerously-bypass-approvals-and-sandbox'));assert.equal(d.args[d.args.indexOf('--sandbox')+1],'read-only');
});
test('new raw sharing or a changed symlink invalidates completed AI choices',async t=>{
 for(const kind of ['absolute','relative','exit','retarget','loop']){
  const f=fixture(t),refs=path.join(f.root,'refs'),link=refs+'/link';fs.mkdirSync(refs);fs.mkdirSync(f.outside+'/nested');fs.mkdirSync(f.root+'/Sibling');fs.writeFileSync(f.root+'/Sibling/file.txt','sibling');
  fs.symlinkSync(kind==='retarget'?f.root+'/Sibling':f.outside+'/nested',link);
  const shared=kind==='relative'?'../../refs/link/../x':link+(kind==='exit'?'/../../Sibling/file.txt':'/../x');
  const project=ref=>{const dir=path.join(f.root,'Product/Q');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/PROJECT.md',`---\nname: Q\nfolders:\n  使用: ${ref}\nrelated: []\n---\n`);};
  if(kind==='retarget')project(shared);
  const d=f.r.preview('P'),r=await f.review.begin(d.token);f.rows.push({role:'assistant',request:r.id,text:JSON.stringify({results:[{id:d.keep[0].id,sharing:'なし',reason:'模擬判定'}]})});f.state.busy=false;
  assert.equal(f.review.status('P').status,'done',kind);
  if(kind==='retarget'){fs.unlinkSync(link);fs.symlinkSync(f.outside+'/nested',link);}
  else if(kind==='loop'){fs.symlinkSync('loop',refs+'/loop');project(refs+'/loop/../x');}
  else project(shared);
  const status=f.review.status('P');assert.equal(status.status,'stale',kind);assert.deepEqual(status.results,[],kind);assert.equal(f.r.preview('P').keep[0].selectable,false,kind);
 }
});

test('completed AI choices become stale after raw tilde sharing is added',async t=>{
 const f=fixture(t),home=f.root+'/Home',homedir=os.homedir;fs.mkdirSync(home);fs.mkdirSync(f.outside+'/nested');fs.symlinkSync(f.outside+'/nested',home+'/link');
 os.homedir=()=>home;
 try{
  const d=f.r.preview('P'),r=await f.review.begin(d.token);f.rows.push({role:'assistant',request:r.id,text:JSON.stringify({results:[{id:d.keep[0].id,sharing:'なし',reason:'mock'}]})});f.state.busy=false;assert.equal(f.review.status('P').status,'done');
  fs.mkdirSync(f.root+'/Product/Q');fs.writeFileSync(f.root+'/Product/Q/PROJECT.md','---\nname: Q\nfolders:\n  使用: ~/link/../x\n---\n');
  const status=f.review.status('P');assert.equal(status.status,'stale');assert.deepEqual(status.results,[]);assert.equal(f.r.preview('P').keep[0].selectable,false);
 }finally{os.homedir=homedir;}
});
