'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Freetalk,guard}=require('../lib/freetalk'),{FreetalkHistory,estimate}=require('../lib/freetalk-history'),chat=require('../lib/chat');
const pick={ai:'codex',model:'GPT-6.1-Sol',effort:'高'};
function fixture(t){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ft-history-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));const store=new Store(path.join(tmp,'root')),ft=new Freetalk(store,path.join(tmp,'home'));ft.ensure();const a=ft.createTopic(pick),b=ft.createTopic(pick);let reason='';const history=new FreetalkHistory(ft,()=>reason);return {tmp,store,ft,a,b,history,busy:r=>reason=r};}
function options(h,id){return {confirm:true,revision:h.status(id).revision};}
test('文字種別の目安・239k/240k境界は話題単位',t=>{const {ft,a,b,history:h}=fixture(t);assert.equal(estimate('日本語abcd'),4);chat.append(ft.ledger,a.id,{role:'user',text:'あ'.repeat(239000)});assert.equal(h.status(a.id).tokens,239000);assert.equal(h.status(a.id).warning,false);chat.append(ft.ledger,a.id,{role:'assistant',text:'a'.repeat(3999)});assert.equal(h.status(a.id).tokens,240000);assert.equal(h.status(a.id).warning,true);assert.equal(h.status(b.id).tokens,0);});
test('クリアは全AI再開・規則・引継ぎ・メモリ・一時物を世代更新、他話題と設定保持・添付も退避',t=>{const {ft,store,a,b,history:h}=fixture(t);ft.nameTopic(a.id,'相談');store.appendSection('freetalk',a.id,'メモ','古い話題のメモ');chat.append(ft.ledger,a.id,{role:'user',text:'古い会話'});chat.append(ft.ledger,b.id,{role:'user',text:'別の話題'});chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old-c',claude:'old-o',agy:'old-a',grok:'old-g'},models:{codex:pick.model},rulesSent:{codex:{sid:'old-c'}},accounts:{codex:'account'},codexFast:true});const old=[];for(const rel of ['chat/'+a.id+'.rules.md','handoff/'+a.id+'-20261007-180000-codex.md','memory/'+a.id+'/INDEX.md','work/'+a.id+'/context.md']){const f=path.join(ft.ledger,'.ai',rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'古い情報');old.push(f);}const attachment=ft.upload(a.id,'file.txt',Buffer.from('添付'));const other=fs.readFileSync(chat.files(ft.ledger,b.id).log);const settings=fs.readFileSync(path.join(ft.dir,'AGENTS.md'));const r=h.rotate(a.id,options(h,a.id));assert.equal(r.generation,2);assert.deepEqual(chat.read(ft.ledger,a.id),[]);assert.deepEqual(chat.readMeta(ft.ledger,a.id),{sessions:{},models:{},accounts:{codex:'account'},codexFast:true});for(const f of old)assert.equal(fs.existsSync(f),false,f);assert.equal(fs.existsSync(attachment),false);const manifest=JSON.parse(fs.readFileSync(path.join(r.trash,'manifest.json')));const moved=manifest.moved.find(x=>x.target===path.join(ft.dir,'topics',a.id));assert.equal(fs.readFileSync(path.join(moved.dest,path.basename(attachment)),'utf8'),'添付');assert.deepEqual(fs.readFileSync(chat.files(ft.ledger,b.id).log),other);assert.deepEqual(fs.readFileSync(path.join(ft.dir,'AGENTS.md')),settings);assert.doesNotMatch(fs.readFileSync(store.taskFile('freetalk',a.id),'utf8'),/古い話題/);assert.ok(fs.existsSync(path.join(r.trash,'manifest.json')));const turn=chat.buildTurn({ai:'codex',model:pick.model,effort:'高',meta:chat.readMeta(ft.ledger,a.id),rows:[],text:'続き',basePrompt:'自由対話',policy:'',perm:'codex'});assert.equal(turn.resume,false);assert.ok(!turn.args.includes('old-c'));});
test('AI要約は人の確認・編集を経て新世代の先頭へ、未確認/古い要約拒否',t=>{const {ft,a,history:h}=fixture(t);assert.throws(()=>h.prepareSummary(a.id),/一度相談/);chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'最初の回答'});const request=h.prepareSummary(a.id);assert.equal(request.ai,'codex');chat.append(ft.ledger,a.id,{role:'user',text:request.text});chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'AIの要約'});const status=h.status(a.id);assert.equal(status.draft,'AIの要約');assert.throws(()=>h.rotate(a.id,{...options(h,a.id),summaryId:'fake',summary:'人の文'}),/確認/);assert.throws(()=>h.rotate(a.id,{...options(h,a.id),summary:'人の文'}),/確認済/);const r=h.rotate(a.id,{...options(h,a.id),summaryId:status.summaryId,summary:' 人が直した決定事項 '});assert.equal(r.generation,2);const rows=chat.read(ft.ledger,a.id);assert.equal(rows.length,1);assert.equal(rows[0].summaryApproved,true);assert.match(rows[0].text,/人が直した決定事項/);assert.doesNotMatch(rows[0].text,/AIの要約/);assert.equal(h.status(a.id).draft,'');});
test('要約後に別の会話/失敗/質問が来た場合は要約として使わない',t=>{const {ft,a,history:h}=fixture(t);chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'回答'});const r=h.prepareSummary(a.id);chat.append(ft.ledger,a.id,{role:'user',text:r.text});chat.append(ft.ledger,a.id,{role:'assistant',text:'要約',error:'中断'});assert.equal(h.status(a.id).draft,'');chat.append(ft.ledger,a.id,{role:'assistant',text:'新しい回答'});assert.equal(h.status(a.id).draft,'');});
test('確認なし/更新された会話/AI稼働/待機は拒否し元保持',t=>{const {ft,a,history:h,busy}=fixture(t);chat.append(ft.ledger,a.id,{role:'user',text:'元'});const opts=options(h,a.id);assert.throws(()=>h.rotate(a.id,{...opts,confirm:false}),/確認/);for(const r of ['AIが作業中','順番待ち']){busy(r);assert.throws(()=>h.rotate(a.id,opts),new RegExp(r));assert.throws(()=>h.prepareSummary(a.id),new RegExp(r));}busy('');chat.append(ft.ledger,a.id,{role:'user',text:'新規'});assert.throws(()=>h.rotate(a.id,opts),/更新/);assert.equal(chat.read(ft.ledger,a.id).length,2);});
test('退避途中の失敗は全元ファイルを復元、世代を進めない',t=>{const {ft,store,a,history:h}=fixture(t);chat.append(ft.ledger,a.id,{role:'user',text:'元'});chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old'}});const file=store.taskFile('freetalk',a.id),before=fs.readFileSync(file),orig=fs.renameSync;let count=0;fs.renameSync=(...args)=>{if(++count===3)throw Error('試験の移動失敗');return orig(...args);};try{assert.throws(()=>h.rotate(a.id,options(h,a.id)),/元の会話を保持/);}finally{fs.renameSync=orig;}assert.deepEqual(fs.readFileSync(file),before);assert.equal(chat.read(ft.ledger,a.id)[0].text,'元');assert.equal(chat.readMeta(ft.ledger,a.id).sessions.codex,'old');assert.equal(h.state(a.id).generation,1);});
test('新世代の保存失敗も旧会話・task・meta・メモリを復元',t=>{const {ft,store,a,history:h}=fixture(t);chat.append(ft.ledger,a.id,{role:'user',text:'元'});chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old'}});const file=store.taskFile('freetalk',a.id),before=fs.readFileSync(file);h.save=()=>{throw Error('保存失敗');};assert.throws(()=>h.rotate(a.id,options(h,a.id)),/元の会話を保持/);assert.deepEqual(fs.readFileSync(file),before);assert.equal(chat.read(ft.ledger,a.id)[0].text,'元');assert.equal(chat.readMeta(ft.ledger,a.id).sessions.codex,'old');});
test('壊れたログ/リンク対象は切り替えずfail closed',t=>{const {ft,a,history:h,tmp}=fixture(t);chat.append(ft.ledger,a.id,{role:'user',text:'元'});fs.appendFileSync(chat.files(ft.ledger,a.id).log,'not-json\n');assert.throws(()=>h.status(a.id));fs.writeFileSync(chat.files(ft.ledger,a.id).log,'');const external=path.join(tmp,'outside');fs.writeFileSync(external,'元');fs.symlinkSync(external,chat.files(ft.ledger,a.id).meta);assert.throws(()=>h.rotate(a.id,{confirm:true}),/リンク/);assert.equal(fs.readFileSync(external,'utf8'),'元');});
test('関連freetalkは表記違いでもHTTP guardとStoreで拒否・通常関連維持',t=>{const {store}=fixture(t);for(const id of ['freetalk','FreeTalk','FREETALK']){assert.match(guard('/api/project/new',{name:'通常',related:[id]}),/常設/);assert.match(store.createProject({name:'通常',related:[id]}).error,/常設/);}assert.equal(guard('/api/project/new',{name:'通常',related:['FreeTalk Notes']}),'');});

test('クリアの同じ確認を再送しても世代を二度進めない',t=>{const {a,history:h}=fixture(t);const opts=options(h,a.id);h.rotate(a.id,opts);assert.throws(()=>h.rotate(a.id,opts),/更新/);assert.equal(h.status(a.id).generation,2);});

test('プロジェクト化の意図は保存から復元、依頼IDで引用を区別し追加会話の要約を保持してstaleにする',t=>{
 const {ft,a,history:h}=fixture(t);chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'元の返事'});
 const r=h.prepareSummary(a.id,{intent:'promote'}),id=h.state(a.id).summary.id;
 chat.append(ft.ledger,a.id,{role:'user',request:id,text:'【渡した依頼：話題の整理用の要約】\n'+r.text});
 chat.append(ft.ledger,a.id,{role:'event',text:'完了待ち'});chat.append(ft.ledger,a.id,{role:'assistant',request:id,text:'保存される要約'});
 const restored=new FreetalkHistory(ft);assert.equal(restored.status(a.id).promotionRequested,true);assert.equal(restored.status(a.id).draft,'保存される要約');
 chat.append(ft.ledger,a.id,{role:'user',text:'引用：\n'+r.text});chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'追加の回答'});
 const stale=restored.status(a.id);assert.equal(stale.stale,true);assert.equal(stale.draft,'保存される要約');assert.match(stale.staleReason,/会話が追加/);
 assert.throws(()=>h.rotate(a.id,{confirm:true,revision:stale.revision,summaryId:id,summary:stale.draft}),/要約/);
 restored.promotionIntent(a.id,false);assert.equal(restored.status(a.id).promotionRequested,false);assert.equal(restored.status(a.id).draft,'');
 const redo=restored.prepareSummary(a.id,{intent:'promote'});chat.append(ft.ledger,a.id,{role:'user',text:redo.text});chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'新鮮な要約'});
 assert.equal(restored.status(a.id).stale,false);assert.equal(restored.status(a.id).draft,'新鮮な要約');
 restored.prepareSummary(a.id);assert.equal(restored.status(a.id).promotionRequested,false);
});
test('旧要約記録は見出し直後のmarkerで復元、後の引用・末尾eventで取り違えない',t=>{
 const {ft,a,history:h}=fixture(t);h.save(a.id,{generation:1,summary:{id:'legacy',marker:'[freetalk-summary:legacy]',intent:'promote'}});
 chat.append(ft.ledger,a.id,{role:'user',text:'【渡した依頼：話題の整理用の要約】\n[freetalk-summary:legacy]\n依頼'});
 chat.append(ft.ledger,a.id,{role:'assistant',text:'旧要約'});chat.append(ft.ledger,a.id,{role:'event',text:'終了'});
 assert.equal(h.status(a.id).draft,'旧要約');chat.append(ft.ledger,a.id,{role:'user',text:'引用 [freetalk-summary:legacy]'});
 assert.equal(h.status(a.id).stale,true);assert.equal(h.status(a.id).draft,'旧要約');
});
test('要約開始・応答失敗は待機と区別、取消・再要約・通常整理で意図を消せる',t=>{
 const {ft,a,history:h}=fixture(t);assert.equal(h.promotionIntent(a.id,false).promotionRequested,false);
 chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'返事'});const r=h.prepareSummary(a.id,{intent:'promote'});
 assert.match(h.status(a.id).summaryError,/開始できません/);chat.append(ft.ledger,a.id,{role:'user',text:r.text});chat.append(ft.ledger,a.id,{role:'assistant',text:'',error:'試験の要約失敗'});
 assert.equal(h.status(a.id).summaryError,'試験の要約失敗');assert.equal(h.status(a.id).promotionRequested,true);
 const retry=h.prepareSummary(a.id,{intent:'promote'});assert.equal(retry.ai,'codex');assert.equal(retry.model,pick.model);
 assert.equal(h.promotionIntent(a.id,false).promotionRequested,false);assert.equal(h.state(a.id).summary.intent,undefined);
});

test('順番待ちの依頼IDが変わっても保存した正式依頼文で識別、後の引用で置換しない',t=>{
 const {ft,a,history:h}=fixture(t);chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'回答'});h.prepareSummary(a.id,{intent:'promote'});
 const s=h.state(a.id).summary;chat.append(ft.ledger,a.id,{role:'user',request:'queue-id',text:s.requestShown});chat.append(ft.ledger,a.id,{role:'assistant',request:'queue-id',text:'待機からの要約'});
 assert.equal(h.status(a.id).draft,'待機からの要約');chat.append(ft.ledger,a.id,{role:'user',text:s.requestShown});chat.append(ft.ledger,a.id,{role:'assistant',text:'引用への回答'});
 assert.equal(h.status(a.id).draft,'待機からの要約');assert.equal(h.status(a.id).stale,true);
});

test('English legacy summary envelopes recover only the marker immediately below the heading',t=>{
 const {ft,a,history:h}=fixture(t);h.save(a.id,{generation:1,summary:{id:'legacy-en',marker:'[freetalk-summary:legacy-en]',intent:'promote'}});
 chat.append(ft.ledger,a.id,{role:'user',text:'[Delegated request: Summarize topic]\n[freetalk-summary:legacy-en]\nrequest'});
 chat.append(ft.ledger,a.id,{role:'assistant',text:'Recovered summary'});assert.equal(h.status(a.id).draft,'Recovered summary');
 chat.append(ft.ledger,a.id,{role:'user',text:'A quoted marker:\n[Delegated request: Summarize topic]\n[freetalk-summary:legacy-en]'});
 assert.equal(h.status(a.id).stale,true);assert.equal(h.status(a.id).draft,'Recovered summary');
});
