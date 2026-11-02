'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const q=require('../lib/integration-question'),{IntegrateAuto}=require('../lib/integrate-auto');
const {execFileSync}=require('node:child_process');
const k='a'.repeat(64),before='1'.repeat(40),source='2'.repeat(40),saved='3'.repeat(40);
const integrationDir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-resume-fixture-'));
test.after(()=>fs.rmSync(integrationDir,{recursive:true,force:true}));
function fixture(modern=false){
  const row={role:'assistant',at:'question',request:'code-request',error:'',integrationAuto:{key:k,phase:'code',closed:true},asks:[{question:'範囲を追加しますか',options:['補正して保存（おすすめ）','停止する'],multi:false}]};
  const answer={role:'user',turn:'answer-turn',text:'補正して保存',head:before},completion={role:'assistant',error:'',text:'保存した'},boundary={role:'user',turn:'next-turn',text:'次へ',head:saved,status:''};
  if(modern)completion.answerCompletion={turn:answer.turn,closed:true,head:saved,status:''};
  const rows=[row,{role:'event',text:'停止'},answer,{role:'event',tool:true},completion,...(modern?[]:[boundary])];
  let record={id:'record',project:'p',task:'parent',target:'copy',complete:false,items:[{project:'p',task:'child',state:'解消中',source:{head:source},files:[],results:[],taskHash:'hash',review:{},disposition:'continue'}],auto:{stopped:{reason:'統合の判断待ちがあります'},thenMain:false,targetHead:before,attempts:{[k]:{phase:'code',project:'p',task:'child',sourceHead:source,targetHead:before,delivery:{state:'accepted',request:row.request}}},pendingMain:{id:'old',main:{state:'intent'}}}};
  record.auto.scope=record.items.map(({project,task,source,files,results,taskHash,review,disposition})=>({project,task,source,files,results,taskHash,review,disposition}));
  let dirty=false,merged=true,pending=false,sends=0,receipts=0;
  const integrate={dir:integrationDir,tokens:new Map(),read:()=>structuredClone(record),save:r=>{record=structuredClone(r);},pending:()=>[{project:'p',task:'parent'}],store:{readProject:()=>({id:'p',dir:'fixture'})},ancestor:()=>({t:{},target:'copy',p:{id:'p',dir:'fixture'}}),resumePreview:()=>({blockers:[]}),resumeRecord:b=>{assert.equal(b.token,'fresh');const r=structuredClone(record);r.auto.stopHistory=[r.auto.stopped];delete r.auto.stopped;return r;},gitw:{inspect:()=>({head:saved,status:dirty?'dirty':''}),merging:()=>false,isAncestor:(dir,h,descendant)=>[before,source,saved].includes(h)&&!(h===source&&!merged)},run:r=>{receipts++;r.items[0].state='保持受領済み';r.complete=true;integrate.save(r);}};
  integrate.file=(p,t)=>path.join(integrationDir,p+'-'+t+'.json');integrate.records=()=>[integrate.read()];integrate.store.listProjects=()=>[];
  const auto=new IntegrateAuto({integrate,dispatch:async()=>{sends++;return{delivery:{state:'accepted'}};},mergeMain:()=>assert.fail('旧本体intentを再送しない')});
  auto.savedCompletion=(r,key,phase)=>phase==='code'?row:undefined;auto.pendingRequest=()=>pending;
  auto.questionResolution=(r,key,a,old)=>q.resolution(rows,{k:key,a,row:old});
  return {rows,row,answer,completion,boundary,auto,integrate,get record(){return record;},get sends(){return sends;},get receipts(){return receipts;},setDirty:x=>dirty=x,setMerged:x=>merged=x,setPending:x=>pending=x};
}
for(const modern of [false,true])test('旧質問と回答・正常終了・保存HEADを別証拠として再開し、新規隔離確認の後だけ保持受領：'+modern,async()=>{
  const f=fixture(modern),raw=JSON.stringify(f.record),oldRows=JSON.stringify(f.rows),pending=JSON.stringify(f.record.auto.pendingMain);
  const status=f.auto.resumeStatus(f.record);assert.equal(status.allowed,true);assert.equal(status.retry.length,0);assert.equal(status.questionRecovery.length,1);assert.equal(JSON.stringify(f.record),raw);
  f.auto.resume({project:'p',task:'parent',token:'fresh'});assert.equal(f.record.auto.attempts[k].phase,'needs-review');assert.equal(f.record.auto.attempts[k].codeQuestionResolution.savedHead,saved);assert.equal(f.record.auto.attempts[k].codeQuestionResolution.legacy,!modern);assert.equal(f.record.auto.stopHistory.length,1);assert.equal(f.receipts,0);
  await f.auto.tick();f.setPending(true);assert.equal(f.sends,1);assert.equal(f.record.auto.attempts[k].isolatedReview,true);await f.auto.tick();assert.equal(f.sends,1);assert.equal(f.receipts,0);
  const a=f.record.auto.attempts[k];f.auto.settled({project:'p',task:'parent',text:`[integration-auto:${k}:review]`},{text:`[integration-review:${k}:pass]`,integrationAuto:{closed:true,isolation:{version:1,resumed:false,request:a.delivery.request}}});
  await f.auto.tick();assert.equal(f.receipts,1);assert.equal(f.record.items[0].state,'保持受領済み');assert.equal(JSON.stringify(f.rows),oldRows);assert.equal(JSON.stringify(f.record.auto.pendingMain),pending);
});
for(const modern of [false,true]){
  test('明示許可は2番目でも復旧可、停止が先頭/おすすめでも許可にしない：'+modern,()=>{
    const f=fixture(modern),allow='`hub/test/integration-simple.test.js` の補正を許可し、コミットまで進める';
    f.row.asks[0].options=['停止する（おすすめ）',allow];f.answer.text=allow;
    const proof=q.resolution(f.rows,{k,a:f.record.auto.attempts[k],row:f.row});
    assert.equal(proof.choice,1);assert.deepEqual(proof.permission,{version:1,action:'save-correction'});assert.equal(f.auto.resumeStatus(f.record).allowed,true);
    f.answer.text='停止する';assert.ok(q.selectedQuestion([f.row],f.answer));assert.equal(q.resolution(f.rows,{k,a:f.record.auto.attempts[k],row:f.row}),null);assert.equal(f.auto.resumeStatus(f.record).allowed,false);
  });
  for(const selected of ['補正を許可せず停止する','補正を拒否する','取消する','補正を許可し、保存せず停止する','補正を許可し、コミットまで進める。ただし停止する','今回は判断を保留する','はい','補正を許可しないで保存する'])test('選択回答と継続許可を分離、後続別保存でも無再送：'+modern+' '+selected,()=>{
    const f=fixture(modern);f.row.asks[0].options=[selected+'（おすすめ）','補正して保存'];f.answer.text=selected;f.completion.text='停止しました。別の保存は完了しています';
    const original=JSON.stringify(f.record);assert.equal(q.selectedQuestion([f.row],f.answer).choice,0);
    assert.equal(q.resolution(f.rows,{k,a:f.record.auto.attempts[k],row:f.row}),null);assert.equal(f.auto.resumeStatus(f.record).allowed,false);assert.throws(()=>f.auto.resume({project:'p',task:'parent',token:'fresh'}));
    assert.equal(JSON.stringify(f.record),original);assert.equal(f.sends,0);assert.equal(f.receipts,0);
  });
}
const mutations={
  '未回答':f=>{f.answer.text='これからどうする';},
  '引用や説明から許可を推測しない':f=>{f.answer.text='前の「補正して保存」の意味は？';},
  '委任は人の回答でない':f=>{f.answer.request='delegated';},
  '上限交代の本文は回答でない':f=>{f.answer.limitSwitch={};},
  'origin付き自動発言':f=>{f.answer.origin='integration';},
  '異なる旧受付':f=>{f.row.request='another';},
  '終了未確認':f=>{f.row.integrationAuto.closed=false;},
  '旧codeエラー':f=>{f.row.error='failed';},
  '回答後エラー':f=>{f.completion.error='failed';},
  '回答後も質問':f=>{f.completion.asks=[{}];},
  '回答後に別委任':f=>{f.completion.request='other';},
  '次の人の番なし':f=>{f.rows.splice(f.rows.indexOf(f.boundary),1);},
  '保存HEADが無い':f=>{f.boundary.head=null;},
  '補正前と同じHEAD':f=>{f.boundary.head=before;},
  '未保存のまま':f=>{f.boundary.status='dirty';},
  '現copyが未保存':f=>{f.setDirty(true);},
  '子未merge':f=>{f.setMerged(false);},
  '合格なしreviewは質問回答で解除しない':f=>{const r=f.record;r.auto.attempts[k].phase='review';f.integrate.save(r);},
  '本体結果不明':f=>{const r=f.record;r.auto.main={state:'intent'};f.integrate.save(r);},
};
for(const [name,mutate]of Object.entries(mutations))test('不足/別根拠では停止・無再送：'+name,()=>{
  const f=fixture();mutate(f);const raw=JSON.stringify(f.record);assert.equal(f.auto.resumeStatus(f.record).allowed,false);assert.throws(()=>f.auto.resume({project:'p',task:'parent',token:'fresh'}));assert.equal(JSON.stringify(f.record),raw);assert.equal(f.sends,0);assert.equal(f.receipts,0);
});
for(const mutation of ['wrong-turn','not-closed','dirty'])test('新しい回答終了の内部境界を検証：'+mutation,()=>{
  const f=fixture(true),s=f.completion.answerCompletion;if(mutation==='wrong-turn')s.turn='another';if(mutation==='not-closed')s.closed=false;if(mutation==='dirty')s.status='dirty';assert.equal(f.auto.resumeStatus(f.record).allowed,false);
});
test('旧codeがまだ順番待ち/実行中なら回答で新依頼を作らない',()=>{const f=fixture();f.setPending(true);const s=f.auto.resumeStatus(f.record);assert.equal(s.questionRecovery.length,0);assert.equal(s.retry.length,0);});
test('質問記録の破損を読み飛ばして回答を結合しない',t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-question-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'.ai/chat'),{recursive:true});const file=path.join(dir,'.ai/chat/t.jsonl'),f=fixture();fs.writeFileSync(file,f.rows.map(JSON.stringify).join('\n'));assert.equal(q.read(dir,'t').length,f.rows.length);fs.appendFileSync(file,'\n{broken');assert.deepEqual(q.read(dir,'t'),[]);
});
test('候補重複・複数質問・複数選択・自由回答は選択を推定しない',()=>{
  for(const mode of ['duplicate','multi','questions','object']){const f=fixture();if(mode==='duplicate')f.row.asks[0].options.push('補正して保存');if(mode==='multi')f.row.asks[0].multi=true;if(mode==='questions')f.row.asks.push({});if(mode==='object')f.row.asks[0].options=[{label:'補正して保存'}];assert.equal(q.selectedQuestion([f.row],f.answer),null);}
});
test('実ChatRunnerは回答した番の終了・保存HEADをログへ保存、次の質問なしで確認へ接続',async t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-question-run-')),oldPath=process.env.PATH;
  t.after(()=>{process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true});});
  const g=(...args)=>execFileSync('/usr/bin/git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  g('init','-q');g('config','user.name','Fixture');g('config','user.email','fixture@localhost');fs.writeFileSync(path.join(dir,'value'),'before');fs.writeFileSync(path.join(dir,'.gitignore'),'.ai/\nbin/\n');g('add','value','.gitignore');g('commit','-qm','before');const first=g('rev-parse','HEAD');
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+`\nprocess.stdin.resume();process.stdin.on('end',()=>{const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('value','after');cp.execFileSync('/usr/bin/git',['add','value']);cp.execFileSync('/usr/bin/git',['commit','-qm','saved-answer']);for(const o of [{type:'thread.started',thread_id:'answer-fixture'},{type:'item.completed',item:{type:'agent_message',text:'saved'}},{type:'turn.completed'}])console.log(JSON.stringify(o));});`,{mode:0o755});process.env.PATH=bin+path.delimiter+oldPath;
  const chat=require('../lib/chat'),f=fixture(),question={...f.row,at:undefined};delete question.at;const old=chat.append(dir,'task',question);
  let end;const runner=new chat.ChatRunner({onSettled:(o,row)=>{end=row;}});t.after(()=>runner.stopAll());
  const out=runner.send({project:'p',task:'task',pdir:dir,dir,ai:'codex',model:'gpt-6.1-sol',text:'補正して保存',basePrompt:'FIXTURE'});assert.equal(await out.started,true);await runner.busy('p','task').finishedP;await new Promise(setImmediate);
  const rows=q.read(dir,'task'),persisted=rows.findLast(r=>r.role==='assistant');assert.deepEqual(persisted.answerCompletion,end.answerCompletion);assert.equal(persisted.answerCompletion.closed,true);assert.equal(persisted.answerCompletion.head,g('rev-parse','HEAD'));assert.equal(persisted.answerCompletion.status,'');
  const proof=q.resolution(rows,{k,a:f.record.auto.attempts[k],row:old});assert.ok(proof);assert.equal(proof.legacy,false);assert.equal(proof.answerHead,first);assert.equal(proof.savedHead,g('rev-parse','HEAD'));
  const git=require('../lib/git');assert.equal(git.isAncestor(dir,first,proof.savedHead),true);assert.equal(git.isAncestor(dir,proof.savedHead,first),false);assert.equal(git.isAncestor(dir,first,'--all'),false);
});
