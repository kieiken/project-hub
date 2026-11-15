'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chat=require('../lib/chat'),{IntegrateAuto}=require('../lib/integrate-auto');
const key='a'.repeat(64),marker=phase=>`[integration-auto:${key}:${phase}]`;
async function wait(fn){const end=Date.now()+6000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'fixture timed out');}
function fixture(mode='ok'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-integration-limit-'));
 fs.writeFileSync(path.join(dir,'source.cjs'),`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',is_error:true,result:"You've reached your Fable limit. Switch to another model."}));process.exitCode=1;});`);
 fs.writeFileSync(path.join(dir,'backup.cjs'),`#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input.includes('${marker('review')}')?'[integration-review:${key}:pass]':'saved'}}));console.log(JSON.stringify({type:'turn.completed'}));},150));`,{mode:0o755});
 const oldPath=process.env.PATH;process.env.PATH=dir+path.delimiter+oldPath;
 fs.writeFileSync(path.join(dir,'claude'),'#!'+process.execPath+'\n'+fs.readFileSync(path.join(dir,'source.cjs'),'utf8'),{mode:0o755});fs.copyFileSync(path.join(dir,'backup.cjs'),path.join(dir,'codex'));
 let head='before',record={project:'p',task:'t',target:'fixture',complete:false,items:[{project:'p',task:'child',source:{head:'source'},state:'解消中'}],auto:{targetHead:'before',thenMain:true,attempts:{[key]:{phase:'code',project:'p',task:'child',targetHead:'before'}}}};
 record.auto.scope=structuredClone(record.items.map(({project,task,source})=>({project,task,source})));
 const events=[],issues=[];let receipts=0,mains=0,held=false;
 const integrate={read:()=>structuredClone(record),save:r=>record=structuredClone(r),pending:()=>record.auto.main?.state==='done'?[]:[{project:'p',task:'t'}],store:{readProject:()=>({id:'p',dir:'fixture'})},ancestor:()=>({t:{},target:'copy',p:{id:'p',dir:'fixture'}}),resumePreview:()=>({blockers:[],recover:null}),gitw:{inspect:()=>({head,status:''}),merging:()=>false,isAncestor:()=>head==='resolved'},run:r=>{receipts++;r.complete=true;r.items[0].state='保持受領済み';integrate.save(r);}};
 integrate.store.listProjects=()=>[];integrate.dir=path.join(dir,'task-integrations');integrate.file=(p,t)=>path.join(integrate.dir,p+'-'+t+'.json');integrate.records=()=>[integrate.read()];
 let runner;
 const auto=new IntegrateAuto({integrate,busy:()=>!!runner.busy('p','t')||runner.queue('p','t').some(q=>!q.error),dispatch:async request=>{issues.push(request);const out=runner.send({...options('review',request.text),request:request.requestKey,isolatedReview:request.isolatedReview,integrationReviewRequest:request.requestKey});await out.started;return {delivery:{state:'accepted'}};},mergeMain:async()=>{mains++;return{ok:true,retained:true};}});
 const backup={ai:'codex',model:'gpt-6.1-sol',requireModel:true,requiredModel:'gpt-6.1-sol',perm:mode==='spawn-fail'?'./missing.cjs':'./backup.cjs'};
 runner=new chat.ChatRunner({dirOf:()=>dir,limitBackup:()=>backup,
  ...(mode==='both-limits'?{onLimit:()=>{held=true;},limitPreflight:()=>held?{hold:true}:null,limitTarget:()=>held?{hold:true}:null}:{}),
  onSettled:(o,row)=>{
   if(row.ai==='codex'&&!row.error)head='resolved';
   const observed={phase:row.integrationAuto.phase,limit:row.integrationAuto.limit,ai:row.ai,error:row.error,busy:!!runner.busy('p','t'),queue:runner.queue('p','t').length};
   auto.settled(o,row);events.push({...observed,stopped:record.auto.stopped,after:record.auto.attempts[key].phase});
  }});
 auto.pendingRequest=(r,k,phase,request)=>runner.pendingIntegration(r.project,r.task,k,phase,request);
 auto.savedCompletion=(r,k,phase)=>chat.read(dir,'t').findLast(row=>row.role==='assistant'&&row.integrationAuto?.key===k&&row.integrationAuto.phase===phase&&row.integrationAuto.closed);
 function options(phase,text=marker(phase)){return{project:'p',task:'t',pdir:dir,dir,ai:'claude',model:'claude-fable-5-2',text,request:phase,perm:process.execPath+' source.cjs'};}
 async function clean(){const run=runner.busy('p','t');if(run){runner.stop('p','t');await run.finishedP;}process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true});}
 return{runner,auto,events,issues,options,clean,get r(){return record;},get receipts(){return receipts;},get mains(){return mains;},setHeld:x=>{held=x;}};
}
test('実ChatRunner：codeとreviewの正式上限→起動済み交代先→独立合格→正式受領と本体取込各1回',async()=>{
 const f=fixture();try{
  await f.runner.send(f.options('code')).started;await wait(()=>f.events.length===2);
  assert.deepEqual(f.events.map(e=>[e.phase,e.ai,e.busy,e.queue,e.after]),[['code','claude',true,0,'code'],['code','codex',false,0,'needs-review']]);
  assert.equal(f.r.auto.stopped,undefined);assert.equal(f.events[0].limit,true);
  await f.auto.tick();await wait(()=>f.events.length===4);
  assert.deepEqual(f.events.slice(2).map(e=>[e.phase,e.ai,e.busy,e.queue,e.after]),[['review','claude',true,0,'review'],['review','codex',false,0,'verified']]);
  assert.equal(f.r.auto.stopped,undefined);await f.auto.tick();await f.auto.tick();
  assert.equal(f.receipts,1);assert.equal(f.mains,1);assert.equal(f.issues.length,1);assert.equal(f.r.auto.main.state,'done');
 }finally{await f.clean();}
});
test('実ChatRunner：正式交代先の起動失敗を保存して停止、再委任・受領なし',async()=>{
 const f=fixture('spawn-fail');try{await f.runner.send(f.options('code')).started;await wait(()=>f.events.some(e=>e.ai==='codex'));
  await f.auto.tick();assert.ok(f.r.auto.stopped);assert.equal(f.receipts,0);assert.equal(f.mains,0);assert.equal(f.issues.length,0);
 }finally{await f.clean();}
});
test('実ChatRunner：交代先を人が停止したら自動統合停止、受領なし',async()=>{
 const f=fixture();try{await f.runner.send(f.options('code')).started;await wait(()=>f.events.length===1);f.runner.stop('p','t');await wait(()=>f.events.length===2);
  assert.ok(f.r.auto.stopped);await f.auto.tick();assert.equal(f.receipts,0);assert.equal(f.mains,0);
 }finally{await f.clean();}
});
test('実ChatRunner：両側の正式上限は保存キューで待機、解除後だけ同じ依頼を継続',async()=>{
 const f=fixture('both-limits');try{await f.runner.send(f.options('code')).started;
  await wait(()=>f.runner.queue('p','t')[0]?.limitWaiting&&f.events.length===1);assert.equal(f.r.auto.stopped,undefined);
  const restored=new chat.ChatRunner({dirOf:()=>f.runner.dirOf()});
  f.auto.pendingRequest=(r,k,phase,request)=>restored.pendingIntegration(r.project,r.task,k,phase,request);
  await f.auto.tick();assert.equal(f.r.auto.stopped,undefined);assert.equal(f.receipts,0);assert.equal(f.issues.length,0);
  f.auto.pendingRequest=(r,k,phase,request)=>f.runner.pendingIntegration(r.project,r.task,k,phase,request);
  f.setHeld(false);const q=f.runner.queue('p','t')[0];const out=await f.runner.sendQueued({...f.options('code'),...q,request:q.id});if(await out.started)f.runner.unqueue('p','t',q.id);
  await wait(()=>f.events.length===2);assert.equal(f.r.auto.attempts[key].phase,'needs-review');assert.equal(f.r.auto.stopped,undefined);
 }finally{await f.clean();}
});
test('交代追跡：別attempt・別phase・別元依頼・停止・起動失敗は継続先にしない、再起動中の確認待ちは追跡',()=>{
 const runner=new chat.ChatRunner(),sw={sourceRequest:'code',original:marker('code')},q={id:'limit-code',text:marker('code'),limitSwitch:sw};
 runner.setQueue('p','t',[q]);assert.equal(runner.pendingIntegration('p','t',key,'code','code'),true);
 for(const args of [['b'.repeat(64),'code','code'],[key,'review','code'],[key,'code','other']])assert.equal(runner.pendingIntegration('p','t',...args),false);
 runner.setQueue('p','t',[{...q,error:'ENOENT'}]);assert.equal(runner.pendingIntegration('p','t',key,'code','code'),false);
 runner.setQueue('p','t',[]);const pending={pending:true,options:q,stopped:false};runner.running.set(runner.key('p','t'),pending);
 assert.equal(runner.pendingIntegration('p','t',key,'code','code'),true);pending.stopped=true;assert.equal(runner.pendingIntegration('p','t',key,'code','code'),false);
 runner.running.clear();assert.equal(runner.pendingIntegration('p','t',key,'code'),false);
});
