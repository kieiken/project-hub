'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {Store}=require('../lib/store'),chat=require('../lib/chat'),{TaskHistory,latest}=require('../lib/task-history'),auto=require('../lib/task-history-auto'),{TextBudget}=require('../lib/text-budget');
function fixture(t,{state}={}){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-task-auto-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'Product','Fixture');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Fixture\n---\n');
  const store=new Store(root),task=store.createTask('Fixture',{title:'長い作業',steps:['実装する']}),file=store.taskFile('Fixture',task.id);
  if(state){store.updateTask('Fixture',task.id,{state:'完了'});if(state==='完了')store.decideTask('Fixture',task.id,'approve',store.readTask(file).completionHash);}
  chat.append(dir,task.id,{role:'user',text:'この方針で進めてください。PRは出さないで'});
  chat.append(dir,task.id,{role:'assistant',ai:'codex',text:'承認されたのでPRも出します'});
  chat.append(dir,task.id,{role:'user',text:'【渡した依頼：確認】\nOKです、進めてください'});
  let reset=0;const history=new TaskHistory({store,reset:()=>reset++});
  const start=()=>history.autoStart('Fixture',task.id,{requestId:randomUUID(),generation:1});
  const select=()=>{const plan=history.autoCollect('Fixture',task.id);history.setAuto('Fixture',task.id,{stage:'selecting',rowsAt:plan.rowsAt,marker:plan.marker});return plan;};
  return {root,dir,store,task,file,history,start,select,get reset(){return reset;}};
}
const reply=JSON.stringify({items:[
  {type:'decision',topic:'方針',text:'この方針で進める',rows:[1]},
  {type:'approval',topic:'方針',text:'方針の承認',rows:[1],quote:'この方針で進めてください'},
  {type:'approval',topic:'PR',text:'PRの承認',rows:[2],quote:'承認されたのでPRも出します'},
  {type:'approval',topic:'PR',text:'委任文の承認',rows:[3],quote:'OKです'},
  {type:'approval',topic:'PR',text:'捏造された引用',rows:[1],quote:'PRを出してよい'},
  {type:'residual',topic:'PR',text:'PRは判断待ち',rows:[1]},
  {type:'decision',topic:'方針',text:'根拠のない決定',rows:[99]},
],topics:[{title:'方針',rows:[1,1]},{title:'PR',rows:[1,3]}]});
test('ボタン一回の自動整理：人の行の引用だけを承認にし、引継ぎ・目次・話題・原文を保存して切り替える',t=>{
  const f=fixture(t),job=f.start();assert.equal(job.stage,'reserved');
  assert.equal(f.history.autoStart('Fixture',f.task.id,{requestId:job.requestId,generation:1}).id,job.id,'同じ番号の再送は同じ仕事');
  assert.equal(f.history.autoStart('Fixture',f.task.id,{requestId:randomUUID(),generation:1}).id,job.id,'他タブは実行中の仕事へ合流');
  const plan=f.select();assert.match(plan.prompt,new RegExp('\\[task-auto:'+plan.marker+'\\]'));assert.match(plan.prompt,/1〜3行/);
  assert.ok(f.history.organizing('Fixture',f.task.id));
  chat.append(f.dir,f.task.id,{role:'user',text:'【渡した依頼：会話の自動整理】\n'+plan.prompt});chat.append(f.dir,f.task.id,{role:'assistant',ai:'claude',text:reply});
  const out=f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai',model:'claude-opus-5-5'});
  assert.equal(out.generation,2);assert.equal(f.reset,1);
  const rows=chat.read(f.dir,f.task.id);assert.equal(rows.length,1);assert.equal(rows[0].role,'event');assert.equal(rows[0].summaryAuto,true);assert.equal(rows[0].summaryApproved,undefined);
  const text=rows[0].text;assert.match(text,/人の確認なし/);assert.match(text,/「この方針で進めてください」（人・行1）/);
  assert.doesNotMatch(text,/「承認されたのでPRも出します」/);assert.doesNotMatch(text,/「OKです」/);assert.doesNotMatch(text,/「PRを出してよい」/);
  assert.match(text,/承認未確認（AI推定）：PRの承認/);assert.match(text,/承認未確認（AI推定）：捏造された引用/);assert.match(text,/根拠行なし・未確認/);assert.match(text,/1\. 実装する/);
  assert.match(latest(fs.readFileSync(f.file,'utf8')),/この方針で進める/);
  const m=f.history.manifest('Fixture',f.task.id,out.archiveId),d=m.archive;assert.equal(m.auto.source,'ai');assert.deepEqual(m.topics,['方針','PR','手順']);
  for(const n of ['handoff.md','INDEX.md','topics/01.md','topics/02.md'])assert.ok(fs.existsSync(path.join(d,n)),n);
  assert.match(fs.readFileSync(path.join(d,'INDEX.md'),'utf8'),/PR（4件・行1〜3）/);
  assert.match(fs.readFileSync(path.join(d,'topics/02.md'),'utf8'),/原文：\.ai\/chat\/history\/.+\.original 行1〜3/);
  assert.match(f.history.archive('Fixture',f.task.id,out.archiveId).rows[0].text,/この方針で進めてください/);
  const total=f.history.indexFile('Fixture',f.task.id);assert.match(fs.readFileSync(total,'utf8'),new RegExp(out.archiveId+'/INDEX.md：方針、PR、手順'));
  const state=f.history.autoJob('Fixture',f.task.id);assert.equal(state.stage,'done');assert.equal(state.reply,undefined);assert.equal(f.history.organizing('Fixture',f.task.id),null);
  assert.equal(f.history.autoStart('Fixture',f.task.id,{requestId:job.requestId,generation:1}).stage,'done','切替後の同じ番号は完了を返す');
  assert.throws(()=>f.history.autoStart('Fixture',f.task.id,{requestId:randomUUID(),generation:1}),/切り替わりました/);
  const budget=new TextBudget({store:f.store});assert.match(budget.search('Fixture',f.task.id,'PRは判断待ち'),/topics\/02\.md/);
});
test('整理中に人の発言が増えたら一度だけ選び直し、二度目は止める。返事が無ければ代替要約で再委任しない',t=>{
  const f=fixture(t);f.start();f.select();chat.append(f.dir,f.task.id,{role:'user',text:'割り込みの新しい指示'});
  let a=f.history.autoFinish('Fixture',f.task.id,{});assert.equal(a.stage,'reserved');assert.equal(a.attempt,1);
  f.select();chat.append(f.dir,f.task.id,{role:'user',text:'もう一つ'});a=f.history.autoFinish('Fixture',f.task.id,{});assert.equal(a.stage,'failed');
  assert.equal(f.history.state('Fixture',f.task.id).generation,1);assert.equal(chat.read(f.dir,f.task.id).length,5);
  f.start();f.select();const out=f.history.autoFinish('Fixture',f.task.id,{reply:'壊れた返事',source:'ai'});
  const text=chat.read(f.dir,f.task.id)[0].text;assert.equal(out.generation,2);assert.match(text,/AI選別なし/);assert.match(text,/人の依頼（行5）：もう一つ/);assert.match(text,/承認（人の発言のみ）：\n- 記録なし（未確認）/);
  assert.equal(f.history.manifest('Fixture',f.task.id,out.archiveId).auto.source,'fallback');
});
test('引継ぎは2000字以内で、入りきらない項目は話題ファイルに残す。完了作業は本文を変えない',t=>{
  const p=fixture(t,{state:'完了確認待ち'}),pb=fs.readFileSync(p.file);p.start();p.select();p.history.autoFinish('Fixture',p.task.id,{});assert.deepEqual(fs.readFileSync(p.file),pb,'確認待ちの指紋も保つ');
  const f=fixture(t,{state:'完了'}),before=fs.readFileSync(f.file);f.start();f.select();
  const items=Array.from({length:40},(_,i)=>({type:'decision',topic:'大量',text:'決定'+i+'：'+'あ'.repeat(150),rows:[1]}));
  const out=f.history.autoFinish('Fixture',f.task.id,{reply:JSON.stringify({items}),source:'ai'});
  const m=f.history.manifest('Fixture',f.task.id,out.archiveId),handoff=fs.readFileSync(path.join(m.archive,'handoff.md'),'utf8');
  assert.ok(Array.from(chat.read(f.dir,f.task.id)[0].text).length<2100);assert.match(handoff,/件は話題ファイルにあります/);
  const topics=fs.readdirSync(path.join(m.archive,'topics')).map(n=>fs.readFileSync(path.join(m.archive,'topics',n),'utf8')).join('');
  for(let i=0;i<40;i++)assert.match(topics,new RegExp('決定'+i+'：'));
  for(const n of fs.readdirSync(path.join(m.archive,'topics')))assert.ok(Array.from(fs.readFileSync(path.join(m.archive,'topics',n),'utf8')).length<=4000);
  assert.deepEqual(fs.readFileSync(f.file),before);
});
test('切替途中の復旧は保存済みの返事と保管を使い、再委任・再保管をしない。取消は予約・選別中だけ',t=>{
  const f=fixture(t);f.start();f.select();const rename=fs.renameSync;let failed=false;
  fs.renameSync=(a,b)=>{if(b===chat.files(f.dir,f.task.id).meta&&!failed){failed=true;throw Error('fixture crash');}return rename(a,b);};
  try{assert.throws(()=>f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'}),/fixture crash/);}finally{fs.renameSync=rename;}
  const job=f.history.autoJob('Fixture',f.task.id);assert.equal(job.stage,'done');assert.equal(f.history.state('Fixture',f.task.id).generation,2);
  const restarted=new TaskHistory({store:f.store});assert.equal(restarted.failure,'');assert.deepEqual(restarted.activeAutos(),[]);
  assert.equal(restarted.continueStatus('Fixture',f.task.id).result.generation,2);assert.equal(restarted.archives('Fixture',f.task.id).length,1);assert.match(chat.read(f.dir,f.task.id)[0].text,/「この方針で進めてください」/);
  const g=fixture(t);g.start();assert.equal(g.history.autoCancel('Fixture',g.task.id).stage,'cancelled');assert.equal(g.history.organizing('Fixture',g.task.id),null);
  assert.equal(g.history.activeAutos().length,0);
});
test('選別結果の検証：範囲外の行・不正な種類を捨て、委任文や結果通知を人の発言にしない',()=>{
  assert.equal(auto.human({role:'user',text:'はい'}),true);
  for(const r of [{role:'user',text:'【渡した依頼：x】\nはい'},{role:'user',from:'delegate',text:'はい'},{role:'user',limitSwitch:{},text:'はい'},{role:'event',summaryAuto:true,text:'はい'},{role:'assistant',text:'はい'}])assert.equal(auto.human(r),false);
  const sel=auto.build({rows:[{role:'user',text:'はい'}],reply:JSON.stringify({items:[{type:'bad',text:'x'},{type:'next',text:'次',rows:[0,1,2]}]}),task:{steps:[]},source:'ai'});
  assert.deepEqual(sel.items.map(i=>[i.type,i.rows]),[['next',[1]]]);
});
test('automatic context reservation shares the manual job and cancellation stops retries for this generation',t=>{
 const f=fixture(t);assert.equal(f.history.autoReserveLong('Fixture',f.task.id,{chars:120000}),null);
 const a=f.history.autoReserveLong('Fixture',f.task.id,{chars:120001});assert.equal(a.trigger,'context');
 assert.equal(f.start().id,a.id);assert.equal(f.history.autoReserveLong('Fixture',f.task.id,{compacted:true}).id,a.id);
 f.history.autoCancel('Fixture',f.task.id);assert.equal(f.history.autoReserveLong('Fixture',f.task.id,{chars:200000}).stage,'cancelled');
 const g=fixture(t);assert.equal(g.history.autoReserveLong('Fixture',g.task.id,{compacted:true}).trigger,'context');
});
test('edited source rows and changed task instructions force selection again before clearing',t=>{
 const f=fixture(t);f.start();const plan=f.history.autoCollect('Fixture',f.task.id);f.history.setAuto('Fixture',f.task.id,{stage:'selecting',...plan,prompt:undefined});
 const log=chat.files(f.dir,f.task.id).log;fs.writeFileSync(log,fs.readFileSync(log,'utf8').replace('PRは出さないで','PRは禁止です'));
 assert.equal(f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'}).stage,'reserved');assert.equal(f.history.state('Fixture',f.task.id).generation,1);
 const again=f.history.autoCollect('Fixture',f.task.id);f.history.setAuto('Fixture',f.task.id,{stage:'selecting',...again,prompt:undefined});f.store.appendSection('Fixture',f.task.id,'次にやること','追加の指示');
 assert.equal(f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'}).stage,'failed');assert.equal(f.history.state('Fixture',f.task.id).generation,1);
});
test('all old index rows remain in small linked pages; raw archived lines are searchable',t=>{
 const list=Array.from({length:200},(_,i)=>({id:String(i),at:'2026-10-10',generation:i,index:'INDEX.md',topics:['題'.repeat(40)]}));
 const pages=auto.totalIndexes('fixture',list);assert.ok(pages.length>1);for(const p of pages)assert.ok(Array.from(p.text).length<=8000);
 for(const m of list)assert.ok(pages.some(p=>p.text.includes(' → '+m.id+'/INDEX.md')));
 const f=fixture(t);chat.append(f.dir,f.task.id,{role:'user',text:'原文専用_UNIQUE_RAW_EVIDENCE'});f.start();f.select();f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'});
 const hit=new TextBudget({store:f.store}).search('Fixture',f.task.id,'原文専用_UNIQUE_RAW_EVIDENCE');assert.match(hit,/\.original:[0-9]+/);assert.ok(Array.from(hit).length<=8000);
});
for(const lang of ['ja','zh-TW'])test('approval provenance is independent of current language: '+lang,()=>{
 const old=process.env.HUB_LANG;process.env.HUB_LANG=lang;
 try{
  const rows=[{role:'user',request:'old-ja',text:'【渡した依頼：確認】\n可以發布'},
   {role:'user',request:'old-zh',text:'【已交接的要求：review】\n可以發布'},
   {role:'user',request:'old-en',text:'[Delegated request: review]\n可以發布'},
   {role:'user',origin:'delegate',text:'Untranslated Hub request: 可以發布'},
   {role:'user',text:'可以發布'}, {role:'user',text:'公開してよい'}];
  const items=rows.map((r,i)=>({type:'approval',text:'承認'+i,quote:i===5?'公開してよい':'可以發布',rows:[i+1]}));
  const sel=auto.build({rows,reply:JSON.stringify({items}),task:{steps:[]},source:'ai'});
  assert.deepEqual(sel.items.filter(i=>i.type==='approval').map(i=>i.rows),[[5],[6]]);
  assert.equal(sel.items.filter(i=>i.type==='residual').length,4);
 }finally{process.env.HUB_LANG=old;}
});
function selection(f){
 const job=f.start(),plan=f.history.autoCollect('Fixture',f.task.id);
 f.history.setAuto('Fixture',f.task.id,{stage:'selecting',...plan,prompt:undefined,selectionRequest:job.id});
 const original='【渡した依頼：選別】\n'+plan.prompt;
 chat.append(f.dir,f.task.id,{role:'user',from:'delegate',to:'claude',model:'Opus 5.5',request:job.id,text:original});
 chat.append(f.dir,f.task.id,{role:'assistant',ai:'claude',model:'Opus 5.5',request:job.id,text:'',error:"You've reached your Opus limit"});
 const sw={request:job.id,sourceRequest:job.id,original,sourceAI:'claude',sourceModel:'Opus 5.5',from:'Opus 5.5',to:'Codex・GPT-6.1-Sol'};
 chat.append(f.dir,f.task.id,{role:'event',limitSwitch:sw,text:'Hubの正式交代'});
 chat.append(f.dir,f.task.id,{role:'user',from:'delegate',to:'codex',model:'GPT-6.1-Sol',request:'limit-'+job.id,limitSwitch:sw,text:'交代カード'});
 chat.append(f.dir,f.task.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',request:'limit-'+job.id,text:reply});
 return job;
}
test('saved formal limit handoff reply belongs to one selection after restart and a failed commit',t=>{
 const f=fixture(t);selection(f);const restarted=new TaskHistory({store:f.store});
 const selected=restarted.selectionReply('Fixture',f.task.id);assert.equal(selected.text,reply);assert.equal(selected.ai,'codex');
 const rename=fs.renameSync;let failed=false;
 fs.renameSync=(a,b)=>{if(b===chat.files(f.dir,f.task.id).meta&&!failed){failed=true;throw Error('limit fixture crash');}return rename(a,b);};
 try{assert.throws(()=>restarted.autoFinish('Fixture',f.task.id,{reply:selected.text,source:'ai',model:selected.model}),/limit fixture crash/);}finally{fs.renameSync=rename;}
 const again=new TaskHistory({store:f.store});assert.equal(again.autoJob('Fixture',f.task.id).attempt,0);
 assert.equal(again.continueStatus('Fixture',f.task.id).result.generation,2);assert.equal(again.activeAutos().length,0);
 assert.equal(again.archives('Fixture',f.task.id).length,1);assert.match(chat.read(f.dir,f.task.id)[0].text,/「この方針で進めてください」/);
});
test('only an unstarted formal selection handoff can resume its saved queue',t=>{
 const f=fixture(t),job=selection(f),log=chat.files(f.dir,f.task.id).log,rows=f.history.logRows('Fixture',f.task.id);
 const user=rows.find(r=>r.role==='user'&&r.request==='limit-'+job.id),item={id:user.request,limitSwitch:user.limitSwitch};
 assert.equal(f.history.selectionQueued('Fixture',f.task.id,item),false,'started turns are never replayed');
 fs.writeFileSync(log,rows.filter(r=>r.request!==user.request).map(r=>JSON.stringify(r)).join('\n')+'\n');
 assert.equal(f.history.selectionQueued('Fixture',f.task.id,item),true);
 for(const wrong of [{...item,id:'other'},{...item,limitSwitch:{...item.limitSwitch,original:'other'}},{...item,limitSwitch:{...item.limitSwitch,sourceAI:'other'}}])assert.equal(f.history.selectionQueued('Fixture',f.task.id,wrong),false);
});
for(const invalid of ['request-only','wrong-original','wrong-source','missing-event','human-interruption','ai-interruption'])test('limit reply does not hide unrelated turns: '+invalid,t=>{
 const f=fixture(t),job=selection(f),log=chat.files(f.dir,f.task.id).log,rows=f.history.logRows('Fixture',f.task.id);
 if(invalid==='human-interruption')rows.push({role:'user',text:'新しい指示'});
 else if(invalid==='ai-interruption')rows.push({role:'assistant',request:'other',ai:'codex',text:'別の返答'});
 else if(invalid==='missing-event')rows.splice(rows.findIndex(r=>r.role==='event'&&r.limitSwitch),1);
 else if(invalid==='request-only')delete rows.find(r=>r.role==='user'&&r.request==='limit-'+job.id).limitSwitch;
 else for(const r of rows.filter(r=>r.limitSwitch))r.limitSwitch[invalid==='wrong-original'?'original':'sourceRequest']='other selection';
 fs.writeFileSync(log,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 if(!invalid.endsWith('interruption'))assert.equal(f.history.selectionReply('Fixture',f.task.id)?.request,undefined);
 assert.equal(f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'}).stage,'reserved');
 assert.equal(f.history.state('Fixture',f.task.id).generation,1);assert.equal(f.history.archives('Fixture',f.task.id).length,0);
});
for(const neighbours of [false,true])test('raw JSONL search keeps late Unicode matches and original line number, long neighbours='+neighbours,t=>{
 const f=fixture(t),query='RAW_SEARCH_TARGET_20261010😀';
 if(neighbours)for(let i=0;i<2;i++)chat.append(f.dir,f.task.id,{role:'user',text:'前の長い行'+ '😀'.repeat(9000)});
 const line=f.history.logRows('Fixture',f.task.id).length+1;
 chat.append(f.dir,f.task.id,{role:'user',text:'前半'+ '😀'.repeat(16000)+'直前_'+query+'_直後'+ '終'.repeat(1000)});
 f.start();f.select();const out=f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'}),m=f.history.manifest('Fixture',f.task.id,out.archiveId),log=m.entries.find(e=>e.kind==='log');
 const budget=new TextBudget({store:f.store}),hit=budget.search('Fixture',f.task.id,query);
 assert.ok(Array.from(hit).length<=8000);assert.ok(hit.includes(log.saved+':'+line+'\n'));assert.ok(hit.includes('直前_'+query+'_直後'));
 assert.match(hit,/結果は一部/);assert.ok(!/[\uD800-\uDBFF]$/.test(hit));
 const small=budget.search('Fixture',f.task.id,query,500);assert.ok(Array.from(small).length<=500);assert.ok(small.includes(query));
});

test('次にする作業は最新記録を先にし、済み・重複を除き5件まで番号付きで残す',()=>{
 const task={next:'- [ ] 最新の検証\n- [x] 完了した修正\n2. 次の反映',steps:[{text:'完了した修正',done:true},{text:'未実施の確認',done:false}]};
 const reply=JSON.stringify({items:[{type:'next',text:'最新の検証',rows:[1]},{type:'next',text:'完了した修正',rows:[1]},...Array.from({length:8},(_,i)=>({type:'next',text:'AIの残件'+i,rows:[1]})),{type:'residual',text:'人が承認を決める',rows:[1]},{type:'approval',text:'よい',quote:'よい',rows:[1]}]});
 const sel=auto.build({task,rows:[{role:'user',text:'よい'}],reply,source:'ai'}),text=auto.handoff(sel,'archive');
 assert.deepEqual(sel.items.filter(i=>i.type==='next').slice(0,2).map(i=>i.text),['最新の検証','次の反映']);
 assert.equal(sel.items.filter(i=>i.text==='最新の検証').length,1);assert.ok(!sel.items.some(i=>i.type==='next'&&i.text==='完了した修正'));
 assert.ok(text.indexOf('次にする作業：')<text.indexOf('人の判断待ち：'));assert.ok(text.indexOf('人の判断待ち：')<text.indexOf('承認（人の発言のみ）：'));
 assert.match(text,/1\. 最新の検証\n2\. 次の反映/);assert.match(text,/5\. AIの残件2/);assert.doesNotMatch(text,/6\./);assert.match(text,/件は話題ファイル/);
});
test('長い承認一覧でも次の作業は2000字の要約先頭に残り、判断待ち・残作業なし・不明を区別する',()=>{
 const rows=[{role:'user',text:'承認しました'}],items=Array.from({length:50},()=>({type:'approval',text:'承認',quote:'承認しました',rows:[1]}));
 items.push(...Array.from({length:50},(_,i)=>({type:'decision',text:'過去'+i+'あ'.repeat(250),rows:[1]})));
 const sel=auto.build({task:{next:'現在の残作業'},rows,reply:JSON.stringify({items}),source:'ai'}),text=auto.handoff(sel,'archive');assert.ok(Array.from(text).length<=2000);assert.match(text,/次にする作業：\n1\. 現在の残作業/);
 for(const [task,expected] of [[{question:'どちらにするか'},/人の判断待ち・残件を下記/],[{steps:[{text:'完了',done:true}]},/残作業なし（記録上）/],[{},/記録からは特定できません/]])assert.match(auto.handoff(auto.build({task,rows:[]}), 'archive'),expected);
});

test('summary input keeps complete Unicode messages and original provenance while dropping only tool events',()=>{
 const long='本文開始'+ '😀'.repeat(17000)+'後半の承認：公開してよい\n次の段落';
 const rows=[{role:'event',tool:true,text:'OMIT_TOOL_'+ 'x'.repeat(50000)},
  {role:'user',text:long},{role:'assistant',ai:'codex',text:'AI_BODY'},
  {role:'user',origin:'delegate',text:'DELEGATED_APPROVAL'},
  {role:'event',limitSwitch:{from:'Opus 5.5',to:'GPT-6.1-Sol'},text:'LIMIT_SWITCH'},
  {role:'event',summaryAuto:true,text:'前の要約'+ 'あ'.repeat(4000)+'HANDOFF_TAIL'}];
 const input=auto.selectionInput(rows);
 assert.equal(input.tools,1);assert.equal(input.messages,3);assert.equal(input.rowsAt,6);
 assert.doesNotMatch(input.text,/OMIT_TOOL/);assert.match(input.text,/元の行2 — 人の発言/);
 assert.match(input.text,/元の行4 — 依頼・通知（承認不可）/);assert.match(input.text,/Opus 5.5 → GPT-6.1-Sol/);
 assert.match(input.text,/HANDOFF_TAIL/);assert.ok(input.text.includes('後半の承認：公開してよい\n次の段落'));
 const body=input.text.split('元の行2 — 人の発言\n')[1].split('\n\n元の行3')[0];
 assert.equal(body.replaceAll('\n',''),long.replaceAll('\n',''));
 for(const line of body.split('\n')){assert.ok(Array.from(line).length<=auto.INPUT_WIDTH);assert.ok(!/[\uD800-\uDBFF]$/.test(line));}
 const sel=auto.build({rows,task:{},source:'ai',reply:JSON.stringify({items:[{type:'approval',text:'後半',quote:'公開してよい',rows:[2]},{type:'approval',text:'委任',quote:'DELEGATED_APPROVAL',rows:[4]}]})});
 assert.deepEqual(sel.items.filter(x=>x.type==='approval').map(x=>x.rows),[[2]]);
});
test('small summary input is inline once; large input persists privately outside the ledger across restart',t=>{
 const f=fixture(t);f.start();let plan=f.history.autoCollect('Fixture',f.task.id);
 assert.equal(plan.inputFile,'');assert.equal(plan.prompt.split('PRは出さないで').length-1,1);
 assert.doesNotMatch(plan.prompt,/台帳\/\.ai\/chat\/.*jsonl/);assert.match(plan.prompt,/台帳\/\.ai\/tasks\//);
 const before=fs.readFileSync(f.file),long='SPOOL_HEAD'+ '😀'.repeat(18000)+'SPOOL_TAIL';
 chat.append(f.dir,f.task.id,{role:'assistant',text:long});chat.append(f.dir,f.task.id,{role:'event',tool:true,text:'TOOL_BODY'});
 plan=f.history.autoCollect('Fixture',f.task.id);
 assert.ok(plan.inputFile.startsWith(path.join(f.root,'_hub','task-history','inputs')));
 assert.equal(fs.statSync(plan.inputFile).mode&0o777,0o600);assert.ok(plan.prompt.includes(plan.inputFile));assert.doesNotMatch(plan.prompt,/SPOOL_HEAD|TOOL_BODY/);
 const bytes=fs.readFileSync(plan.inputFile);assert.match(bytes.toString(),/SPOOL_TAIL/);assert.equal(plan.inputStats.excludedTools,1);
 const restarted=new TaskHistory({store:f.store}),again=restarted.autoCollect('Fixture',f.task.id);
 assert.equal(again.inputFile,plan.inputFile);assert.deepEqual(fs.readFileSync(again.inputFile),bytes);
 assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(restarted.autoJob('Fixture',f.task.id).id,f.history.autoJob('Fixture',f.task.id).id);
});
test('stage clocks persist, unchanged-stage updates keep their start, and reselection preserves attempt history',t=>{
 const f=fixture(t);f.start();f.select();const initial=f.history.autoJob('Fixture',f.task.id);
 const updated=f.history.setAuto('Fixture',f.task.id,{reason:'表示だけ'});assert.equal(updated.stageStarted,initial.stageStarted);assert.deepEqual(updated.stageHistory,initial.stageHistory);
 chat.append(f.dir,f.task.id,{role:'user',text:'追加'});assert.equal(f.history.autoFinish('Fixture',f.task.id).stage,'reserved');
 f.select();const final=f.history.autoJob('Fixture',f.task.id);assert.deepEqual(final.stageHistory.map(x=>[x.stage,x.attempt]),[['reserved',0],['collecting',0],['selecting',0],['reserved',1],['collecting',1],['selecting',1]]);
 f.history.autoFinish('Fixture',f.task.id,{reply,source:'ai'});const done=new TaskHistory({store:f.store}).autoJob('Fixture',f.task.id);
 const times=['collectingAt','selectingAt','replyReceivedAt','writingAt','doneAt'].map(k=>Date.parse(done.timings[k]));
 assert.ok(times.every(Number.isFinite));assert.deepEqual([...times].sort((a,b)=>a-b),times);assert.equal(done.stageHistory.at(-1).stage,'done');
});
