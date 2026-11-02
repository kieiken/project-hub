'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const results=require('../lib/integration-review-results'),review=require('../lib/integration-review');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-saved-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));require('../lib/integration-writes').register(dir);
 const g=(...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:'pipe'}).trim();g('init','-q');g('config','user.name','Fixture');g('config','user.email','fixture@localhost');fs.writeFileSync(path.join(dir,'.gitignore'),'.ai/chat/\n');
 const task='20261013-01',parent='20261013-02',taskFile=path.join(dir,'.ai/tasks/'+task+'.md'),product=path.join(dir,'saved.txt'),log=path.join(dir,'.ai/work/'+task+'-core.log');fs.mkdirSync(path.dirname(taskFile),{recursive:true});fs.mkdirSync(path.dirname(log),{recursive:true});fs.writeFileSync(product,'actual saved behavior\n');fs.writeFileSync(taskFile,'## 成果\n申告原文\n## 残件申告\n実機未確認\n');fs.writeFileSync(log,'test saved behavior\n# pass 1\n# fail 0\n');g('add','.');g('commit','-qm','saved implementation');const head=g('rev-parse','HEAD');
 const i={project:'Fixture',task,results:[{kind:'本体保存済み',value:'body:.@'+head,dir,commit:head}],files:[{path:product}],source:null},h={store:{readProject:()=>({dir}),taskFile:()=>taskFile}},r={project:i.project,task:parent,target:dir},k='a'.repeat(64),a={project:i.project,task,targetHead:head,reviewHead:head,isolatedReview:true,delivery:{state:'accepted',request:'original-request'}};
 const row={text:'判定：要修正（確認資料不足）。\n指定Git範囲も同一HEAD間で差分ゼロ',integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,resumed:false,request:a.delivery.request,session:'old-independent-session'}}};
 const old=review.prepare({dir,pdir:dir,task:parent,key:k,targetHead:head,reviewHead:head});return {dir,g,taskFile,product,log,head,i,h,r,k,a,row,old};
}
test('保存済み・同一HEADでも申告原文/commit/manifest/関連試験原物を固定する',t=>{
 const f=fixture(t),e=results.collect(f.h,f.r,f.i);assert.equal(e.commits.length,1);assert.ok(e.manifest.some(x=>x.path===f.product));assert.equal(e.testFiles[0],f.log);assert.match(results.render(e),/actual saved behavior/);assert.match(results.render(e),/lines 1-4/);assert.match(results.render(e),/実機未確認/);assert.match(results.render(e),/# pass 1/);
 const p=review.prepare({dir:f.dir,pdir:f.dir,task:f.r.task,key:'b'.repeat(64),targetHead:f.head,reviewHead:f.head,savedResults:e});assert.match(fs.readFileSync(p.file,'utf8'),/## saved-results/);assert.notEqual(p.sha256,f.old.sha256);results.verify(e,f.h,f.r,f.i);
});
for(const mode of ['product','task','test','mode','new-test','missing-test','symlink'])test('保存済み確認資料の変更/不足を拒否：'+mode,t=>{
 const f=fixture(t),e=results.collect(f.h,f.r,f.i);
 if(mode==='mode')fs.chmodSync(f.product,(fs.statSync(f.product).mode&0o777)===0o600?0o644:0o600);else if(mode==='new-test')fs.writeFileSync(path.join(f.dir,'.ai/work/'+f.i.task+'-more.log'),'new');else if(mode==='missing-test')fs.unlinkSync(f.log);else if(mode==='symlink'){fs.unlinkSync(f.log);fs.symlinkSync(f.product,f.log);}else fs.appendFileSync(mode==='product'?f.product:mode==='task'?f.taskFile:f.log,'changed');
 assert.throws(()=>results.verify(e,f.h,f.r,f.i));
});
test('旧空資料とclosed独立資料不足のみ正式補足の根拠にでき、原物を変えない',t=>{
 const f=fixture(t),before=fs.readFileSync(f.old.file),proof=results.recovery(f.h,f.r,f.i,f.a,f.k,f.row);assert.equal(proof.oldEvidence.sha256,f.old.sha256);assert.ok(proof.savedResults.sha256);assert.deepEqual(fs.readFileSync(f.old.file),before);
 for(const change of [{row:{error:'failure'}},{row:{asks:['判断']}},{row:{text:'判定：不合格。'}},{row:{text:'判定：要修正（製品不良）。\n確認資料不足'}},{a:{delivery:{state:'unknown',request:'original-request'}}},{a:{savedResults:proof.savedResults}},{a:{sourceHead:f.head}},{a:{evidenceRecovery:{old:true}}}])assert.equal(results.recovery(f.h,f.r,f.i,{...f.a,...change.a},f.k,{...f.row,...change.row}),null);
 const open=structuredClone(f.row);open.integrationAuto.closed=false;assert.equal(results.recovery(f.h,f.r,f.i,f.a,f.k,open),null);const resumed=structuredClone(f.row);resumed.integrationAuto.isolation.resumed=true;assert.equal(results.recovery(f.h,f.r,f.i,f.a,f.k,resumed),null);
 fs.appendFileSync(f.old.file,'changed');assert.equal(results.recovery(f.h,f.r,f.i,f.a,f.k,f.row),null);
});
test('長い試験原物は全体SHAと正確な原文範囲を渡す、無関係な試験は収集しない',t=>{
 const f=fixture(t),data=Array.from({length:500},(_,i)=>'line '+(i+1)).join('\n');fs.writeFileSync(f.log,data);fs.writeFileSync(path.join(f.dir,'.ai/work/another-task.log'),'DO-NOT-COLLECT');const e=results.collect(f.h,f.r,f.i),log=e.originals.find(x=>x.path===f.log);assert.equal(log.sha256,crypto.createHash('sha256').update(data).digest('hex'));assert.deepEqual(log.ranges.map(x=>[x.start,x.end]),[[1,128],[373,500]]);assert.doesNotMatch(results.render(e),/DO-NOT-COLLECT/);
});
