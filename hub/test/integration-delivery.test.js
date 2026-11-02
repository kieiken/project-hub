'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {assignment,evidence,legacyRefusal,completedRefusal}=require('../lib/integration-delivery'),{IntegrateAuto}=require('../lib/integrate-auto');
const hash=s=>createHash('sha256').update(s).digest('hex');
const data={roles:[{name:'コーディング',main:{ai:'codex',model:'gpt-6.1-sol',effort:'中'}},{name:'調査',main:{ai:'claude-code',model:'claude-opus-5-5'}},{name:'チェック',main:{ai:'claude-code',model:'claude-fable-5-1'}}]};
for(const owner of ['codex','claude-code','agy'])test('子owner/modelを役割の明示担当へ混ぜない：'+owner,()=>{
 const req=assignment({role:'コーディング',organize:true,owner,model:'obsolete'},data);assert.equal(req.ai,'codex');assert.equal(req.model,'gpt-6.1-sol');assert.equal(req.effort,'中');
 const review=assignment({role:'チェック',owner,model:'obsolete'},data);assert.equal(review.ai,'claude');assert.equal(review.model,'claude-fable-5-1');
});
test('設定不明は代替モデルへ落とさず拒否',()=>{assert.throws(()=>assignment({role:'unknown'},data));assert.throws(()=>assignment({role:'コーディング'},{roles:[{name:'コーディング',main:{ai:'人',model:'x'}}]}));});
const integrationDir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-resume-fixture-'));
test.after(()=>fs.rmSync(integrationDir,{recursive:true,force:true}));
function fixture(){
 const r={id:'integration',project:'p',task:'parent',target:'copy',auto:{stopped:{reason:'停止'},attempts:{}},items:[{project:'p',task:'child'}]},k=hash(r.id+'\0p\0child\0organize');
 r.auto.attempts[k]={phase:'organize',project:'p',task:'child',at:'2026-10-11T03:37:01.979Z',request:{project:'p',task:'child',organize:true,role:'コーディング',text:`[integration-auto:${k}:organize]`}};
 r.auto.stopHistory=[{at:'2026-10-11T03:37:01.982Z',reason:'role は指定した AI が主担当の役割を選んでください'}];
 const proof={complete:true,sent:false,auditStart:'2026-10-11T02:00:00Z',auditEnd:'2026-10-11T04:00:00Z',sources:[]};
 let record=structuredClone(r),saves=0;
 const integrate={dir:integrationDir,store:{readProject:()=>({id:'p',dir:'fixture'})},ancestor:()=>({t:{},target:'copy',p:{id:'p',dir:'fixture'}}),read:()=>structuredClone(record),save:r=>{record=structuredClone(r);saves++;},tokens:new Map(),gitw:{inspect:()=>({head:'head',status:''}),merging:()=>false},resumeRecord:()=>{const r=structuredClone(record);r.auto.stopHistory=[...(r.auto.stopHistory||[]),r.auto.stopped];delete r.auto.stopped;return r;}};
 integrate.file=(p,t)=>path.join(integrationDir,p+'-'+t+'.json');integrate.records=()=>[integrate.read()];integrate.store.listProjects=()=>[];
 r.auto.scope=structuredClone(r.items.map(({project,task})=>({project,task})));record=structuredClone(r);
 const auto=new IntegrateAuto({integrate,dispatch:async()=>({ok:true,delivery:{state:'accepted'}})});auto.deliveryEvidence=()=>proof;auto.probeRequest=r=>assignment(r,data);
 return {r,k,proof,auto,integrate,get record(){return record;},get saves(){return saves;}};
}
test('旧role拒否＋時刻とkey＋全証拠なしでのみ人の正式再開を許す・旧attempt保持',async()=>{
 const f=fixture();assert.equal(legacyRefusal(f.r,f.k,f.r.auto.attempts[f.k],f.proof),true);const before=JSON.stringify(f.record);assert.equal(f.auto.resumeStatus(f.record).allowed,true);assert.equal(JSON.stringify(f.record),before);
 f.auto.resume({project:'p',task:'parent',token:'fixture'});const a=f.record.auto.attempts[f.k];assert.equal(a.phase,'organize');assert.equal(a.retryReady,true);assert.equal(a.deliveryHistory[0].legacy,true);assert.equal(a.deliveryHistory[0].delivery,null);
 f.auto.pendingRequest=()=>false;await f.auto.dispatchAttempt(f.record,a,f.k,a.request);assert.equal(f.record.auto.attempts[f.k].delivery.state,'accepted');assert.equal(f.record.auto.attempts[f.k].retryReady,undefined);assert.equal(f.record.auto.attempts[f.k].deliveryHistory.length,1);
 assert.equal(f.auto.resumeStatus(f.record).allowed,false);
});
for(const mutation of ['missing-proof','sent','audit-gap','wrong-key','late-refusal','different-error','unknown','accepted','intent','failed-end'])test('旧/不明の無再送・再開不可：'+mutation,()=>{
 const f=fixture(),a=f.r.auto.attempts[f.k];
 if(mutation==='missing-proof')f.proof.complete=false;if(mutation==='sent')f.proof.sent=true;if(mutation==='audit-gap')f.proof.auditStart='2026-10-11T04:00:00Z';if(mutation==='wrong-key'){delete f.r.auto.attempts[f.k];f.r.auto.attempts['f'.repeat(64)]=a;}if(mutation==='late-refusal')f.r.auto.stopHistory[0].at='2026-10-11T03:48:00Z';if(mutation==='different-error')f.r.auto.stopHistory[0].reason='no completion';if(['unknown','accepted','intent'].includes(mutation))a.delivery={state:mutation};if(mutation==='failed-end')f.auto.savedCompletion=()=>({error:'起動エラー'});
 f.integrate.save(f.r);const before=JSON.stringify(f.record),saves=f.saves;assert.equal(f.auto.resumeStatus(f.record).allowed,false);assert.throws(()=>f.auto.resume({project:'p',task:'parent'}));assert.equal(JSON.stringify(f.record),before);assert.equal(f.saves,saves);
});
for(const mode of ['queued','running','ended','limit-successor','limit-no-successor'])test('受付/終了/上限交代は再送せず元記録を使う：'+mode,()=>{
 const f=fixture();f.r.auto.attempts[f.k].delivery={state:'accepted'};f.integrate.save(f.r);
 f.auto.pendingRequest=()=>['queued','running','limit-successor'].includes(mode);f.auto.savedCompletion=()=>mode==='ended'?{text:'完了'}:mode.startsWith('limit-')?{error:'正式上限',integrationAuto:{limit:true}}:undefined;
 const s=f.auto.resumeStatus(f.record);assert.equal(s.allowed,mode!=='limit-no-successor');assert.equal(s.retry.length,0);
});
test('修正前の設定のままなら人の再開も拒否',()=>{const f=fixture();f.auto.probeRequest=()=>{throw Error('設定未修正');};assert.equal(f.auto.resumeStatus(f.record).allowed,false);});
test('送信前拒否/受付/切断を永続化し、早い終了による保存を上書きしない',async()=>{
 for(const state of ['not-sent','accepted','unknown']){
  const f=fixture(),r=f.record,a=r.auto.attempts[f.k];f.auto.dispatch=async()=>{if(state!=='accepted')throw Object.assign(Error('拒否/切断'),{delivery:{state}});return {ok:true,delivery:{state}};};
  try{await f.auto.dispatchAttempt(r,a,f.k,a.request);}catch{}
  assert.equal(f.record.auto.attempts[f.k].delivery.state,state);assert.ok(f.record.auto.attempts[f.k].delivery.request);
 }
 const f=fixture(),r=f.record,a=r.auto.attempts[f.k];f.auto.dispatch=async()=>{const fresh=f.record;fresh.auto.attempts[f.k].phase='verified';fresh.items[0].taskHash='new';fresh.auto.stopped={reason:'other stop'};f.integrate.save(fresh);return {ok:true,delivery:{state:'accepted'}};};await f.auto.dispatchAttempt(r,a,f.k,a.request);assert.equal(f.record.items[0].taskHash,'new');assert.equal(f.record.auto.attempts[f.k].phase,'verified');assert.equal(f.record.auto.stopped.reason,'other stop');
});
for(const mode of ['clean','request','queue','delegate','corrupt','missing','archive'])test('厳密な原文証拠：'+mode,t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-delivery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const f=fixture(),pdir=path.join(dir,'p'),logFile=path.join(dir,'log.jsonl'),chatDir=path.join(pdir,'.ai/chat');fs.mkdirSync(chatDir,{recursive:true});
 const marker=`[integration-auto:${f.k}:organize]`;fs.writeFileSync(path.join(chatDir,'child.jsonl'),JSON.stringify({at:'2026-10-11T02:00:00Z',role:'user',text:mode==='request'?marker:'old'})+'\n');fs.writeFileSync(path.join(chatDir,'child.queue.json'),JSON.stringify(mode==='queue'?[{text:marker}]:[]));fs.writeFileSync(logFile,[{at:'2026-10-11T02:00:00Z',action:'old'}, {at:'2026-10-11T04:00:00Z',action:mode==='delegate'?'delegate':'later',task:'child',title:'統合する成果の整理'}].map(JSON.stringify).join('\n'));
 if(mode==='corrupt')fs.appendFileSync(logFile,'\n{bad');if(mode==='missing')fs.unlinkSync(logFile);if(mode==='archive'){fs.mkdirSync(path.join(chatDir,'history/child'),{recursive:true});fs.writeFileSync(path.join(chatDir,'history/child/manifest.json'),'{}');}
 const proof=evidence({pdir,task:'child',logFile,k:f.k,phase:'organize',attempt:f.r.auto.attempts[f.k]});assert.equal(legacyRefusal(f.r,f.k,f.r.auto.attempts[f.k],proof),mode==='clean');assert.ok(proof.sources.length);
});

test('日本語へ切替後も旧繁体字の送信前role拒否を診断する',()=>{const f=fixture();f.r.auto.stopHistory[0].reason='role 請選擇以指定 AI 為主要負責者的角色';assert.equal(legacyRefusal(f.r,f.k,f.r.auto.attempts[f.k],f.proof),true);});

const completedReason='この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません';
function completedFixture(){const f=fixture(),a=f.r.auto.attempts[f.k];a.delivery={state:'unknown',request:'refused-request',status:409,at:'2026-10-11T03:37:02.010Z',reason:completedReason};f.r.auto.stopped={at:'2026-10-11T03:37:02.011Z',reason:completedReason};delete f.r.auto.stopHistory;f.integrate.save(f.r);return f;}
test('起動前完了拒否：全証拠照合→正式再開→直前再照合で一度だけ送信、旧unknown原文保持',async()=>{
 const f=completedFixture(),before=JSON.stringify(f.record);assert.equal(f.auto.resumeStatus(f.record).allowed,true);assert.equal(JSON.stringify(f.record),before);
 f.auto.resume({project:'p',task:'parent',token:'fixture'});const r=f.record,a=r.auto.attempts[f.k];assert.equal(a.delivery.state,'unknown');assert.equal(a.deliveryHistory[0].completedRefusal,true);assert.equal(a.deliveryHistory[0].delivery.reason,completedReason);await f.auto.dispatchAttempt(r,a,f.k,a.request);assert.equal(f.record.auto.attempts[f.k].delivery.state,'accepted');assert.equal(f.auto.resumeStatus(f.record).allowed,false);
});
for(const mode of ['sent','incomplete','audit-gap','status','reason','stopped','request','key','late','previous-accepted'])test('起動前完了拒否：不確かな証拠は解除も再送もしない/'+mode,()=>{
 const f=completedFixture(),a=f.r.auto.attempts[f.k];if(mode==='sent')f.proof.sent=true;if(mode==='incomplete')f.proof.complete=false;if(mode==='audit-gap')f.proof.auditEnd=a.at;if(mode==='status')a.delivery.status=500;if(mode==='reason')a.delivery.reason='CLI exit';if(mode==='stopped')f.r.auto.stopped.reason='different';if(mode==='request')delete a.delivery.request;if(mode==='key'){delete f.r.auto.attempts[f.k];f.r.auto.attempts['f'.repeat(64)]=a;}if(mode==='late')f.r.auto.stopped.at='2026-10-11T04:00:00Z';if(mode==='previous-accepted')a.deliveryHistory=[{delivery:{state:'accepted'}}];f.integrate.save(f.r);const before=JSON.stringify(f.record);assert.equal(f.auto.resumeStatus(f.record).allowed,false);assert.throws(()=>f.auto.resume({project:'p',task:'parent'}));assert.equal(JSON.stringify(f.record),before);
});
test('起動前完了拒否：正式許可後の新受付証拠も直前に再検出して再送しない',async()=>{
 const f=completedFixture();f.auto.resume({project:'p',task:'parent'});let calls=0;f.auto.dispatch=async()=>{calls++;};f.proof.sent=true;await assert.rejects(()=>f.auto.dispatchAttempt(f.record,f.record.auto.attempts[f.k],f.k,f.record.auto.attempts[f.k].request));assert.equal(calls,0);assert.equal(f.record.auto.attempts[f.k].delivery.state,'unknown');
});
