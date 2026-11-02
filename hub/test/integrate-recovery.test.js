'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{IntegrateAuto}=require('../lib/integrate-auto');
const fixtureDirs=[];test.after(()=>{for(const dir of fixtureDirs)fs.rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-integration-recovery-'));fixtureDirs.push(dir);
  let head='reviewed',r={project:'p',task:'parent',target:'copy',complete:false,items:[{project:'p',task:'child',source:{head:'source'},state:'検証中'}],auto:{targetHead:'base',thenMain:true,attempts:{old:{project:'p',task:'child',sourceHead:'source',targetHead:'base',reviewHead:'reviewed',phase:'review'}},scope:[]}},runs=0,main=0,issues=[];
  const heads=['source','base','reviewed','next','next2'];
  const integrate={read:()=>structuredClone(r),save:x=>{r=structuredClone(x);},pending:()=>r.auto.main?.state==='done'?[]:[r],store:{readProject:()=>({id:'p',dir:'fixture'})},ancestor:()=>({t:{},target:'copy',p:{id:'p',dir:'fixture'}}),resumePreview:()=>({blockers:[]}),gitw:{inspect:()=>({head,status:''}),merging:()=>false,isAncestor:(d,h)=>heads.indexOf(h)>=0&&heads.indexOf(h)<=heads.indexOf(head)},run:x=>{runs++;x.items[0].state='保持受領済み';x.complete=true;integrate.save(x);}};
  integrate.store.listProjects=()=>[];integrate.dir=path.join(dir,'task-integrations');integrate.file=(p,t)=>path.join(integrate.dir,p+'-'+t+'.json');integrate.records=()=>[integrate.read()];
  r.auto.scope=structuredClone(r.items.map(({project,task,source})=>({project,task,source})));
  // Marker keys in persisted records are full hashes.
  const k='a'.repeat(64);r.auto.attempts[k]=r.auto.attempts.old;delete r.auto.attempts.old;
  const auto=new IntegrateAuto({integrate,busy:()=>false,dispatch:async x=>issues.push(x),mergeMain:async()=>{main++;return {ok:true,retained:true};}});auto.pendingRequest=()=>true;
  return {auto,integrate,k,issues,get r(){return r;},get runs(){return runs;},get main(){return main;},move:x=>{head=x;}};
}
test('旧HEADの合格を採用せず新HEADで1回確認、旧終了の再通知でも再委任せず正式受領',async()=>{
  const f=fixture();f.move('next');f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${f.k}:review]`},{text:`[integration-review:${f.k}:pass]`});
  assert.equal(f.r.auto.attempts[f.k].phase,'superseded');const k=f.r.auto.attempts[f.k].supersededBy;assert.equal(f.r.auto.attempts[k].reviewHead,'next');assert.equal(f.runs,0);
  await f.auto.tick();assert.equal(f.issues.length,1);assert.match(f.issues[0].text,/base\.\.next/);
  f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${f.k}:review]`},{text:`[integration-review:${f.k}:pass]`});await f.auto.tick();assert.equal(f.issues.length,1);
  f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${k}:review]`},{text:`[integration-review:${f.k}:pass]`});assert.ok(f.r.auto.stopped);assert.equal(f.runs,0);
});
test('新HEADの合格で1回受領、thenMain:falseでは本体へ反映しない',async()=>{
  const f=fixture(),r=f.r;r.auto.thenMain=false;f.integrate.save(r);f.move('next');f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${f.k}:review]`},{text:'旧結果'});
  const k=f.r.auto.attempts[f.k].supersededBy;await f.auto.tick();f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${k}:review]`},{text:`[integration-review:${k}:pass]`,integrationAuto:{key:k,phase:'review',closed:true,isolation:{version:1,request:f.r.auto.attempts[k].delivery.request,resumed:false}}});await f.auto.tick();await f.auto.tick();assert.equal(f.runs,1);assert.equal(f.main,0);assert.equal(f.r.auto.main.skipped,true);
});
test('確認中の2回目HEAD移動は停止し、tick・終了通知で再送しない',async()=>{
  const f=fixture();f.move('next');f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${f.k}:review]`},{text:'旧結果'});const k=f.r.auto.attempts[f.k].supersededBy;await f.auto.tick();f.move('next2');f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${k}:review]`},{text:`[integration-review:${k}:pass]`});assert.match(f.r.auto.stopped.reason,/再び/);await f.auto.tick();assert.equal(f.issues.length,1);assert.equal(f.runs,0);
});
test('書き換えた履歴・error・質問は新HEADでの自動確認へ流さない',()=>{
  for(const row of [{error:'起動失敗'},{asks:['判断']},{text:'合格'}]){
    const f=fixture();f.move('unknown');f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${f.k}:review]`},row);assert.ok(f.r.auto.stopped);assert.equal(Object.keys(f.r.auto.attempts).length,1);
  }
});
