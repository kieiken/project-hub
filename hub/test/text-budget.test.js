'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{TextBudget,count,hash,taskView,summaryView,sections,LIMITS}=require('../lib/text-budget');
for(const n of [11999,12000,12001,50000])test('成果は両端のUnicodeを見せ、省略表示込み12000字 '+n,()=>{
 const first='先頭の最新成果😀',last='末尾の最新成果🧵',body=first+'😀'.repeat(n-count(first)-count(last))+last;
 const raw='## 最新の再開要約\n未済：原文を保持\n## 手順\n- [ ] 実機で確認\n## 成果\n'+body;
 const view=taskView(raw,''),shown=view.split('\n## 成果\n')[1].split('\n## メモ\n')[0];
 assert.ok(shown.startsWith(first));assert.ok(shown.endsWith(last));assert.equal(count(shown),Math.min(n,12000));
 assert.equal(shown.includes('（中略。全文は原文検索で確認）'),n>12000);
 assert.equal(Buffer.from(shown,'utf8').toString('utf8'),shown);assert.ok(count(view)<=LIMITS.total);
 if(n<=12000)assert.equal(shown,body);else assert.match(view,/表示不足：成果/);
 assert.equal(sections(raw).find(s=>s.name==='成果').body,body);
});
for(const order of ['先頭','末尾'])test('新しい成果を'+order+'へ足す並びでも取得できる',()=>{
 const latest='- ファイル：new.txt（今回の成果）',history='- ファイル：old.txt（以前の成果）\n'.repeat(1000);
 const body=order==='先頭'?latest+'\n'+history:history+latest;
 const view=taskView('## 成果\n'+body,'');assert.ok(view.includes(latest));assert.match(view,/hub_search_archive/);
});
test('表示のUnicode境界は孤立サロゲートも原文どおりに数え、次の更新を取り違えない',()=>{
 const marker='\n（中略。全文は原文検索で確認）\n',room=12000-count(marker),head=Math.ceil(room/2);
 for(const unit of ['a\uD800b','a\uDC00b','a😀b\uD800\uD800\uDC00']){
   const body=unit.repeat(9000),points=Array.from(body);
   const shown=taskView('## 成果\n'+body,'').split('\n## 成果\n')[1].split('\n## メモ\n')[0];
   assert.equal(shown,points.slice(0,head).join('')+marker+points.slice(-(room-head)).join(''));
 }
 assert.ok(taskView('## 成果\n古い成果','').includes('古い成果'));
 const updated=taskView('## 成果\n更新後の成果','');assert.ok(updated.includes('更新後の成果'));assert.ok(!updated.includes('古い成果'));
});
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'text-budget-')),store=new Store(root),p=store.createProject({name:'Fixture'}).project,task=store.createTask(p.id,{title:'本作業',steps:['未済の実機確認']}),file=store.taskFile(p.id,task.id),other=store.createTask(p.id,{title:'他作業'});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const budget=new TextBudget({store});return {root,store,p,task,file,other,budget,index:path.join(p.dir,'.ai/memory/INDEX.md'),project:path.join(p.dir,'PROJECT.md')};}
function raw(f,body){fs.writeFileSync(f.file,'---\r\nid: '+f.task.id+'\r\nstate: 実行中\r\nquestion: 保持\r\nworkdir: 保持\r\n---\r\n'+body);}
function apply(f){const v=f.budget.preview(f.p.id,f.task.id);return f.budget.apply({...v,confirm:true});}
for(const n of [19999,20000,24000,24001])test('Unicodeメモ境界 '+n,t=>{const f=fixture(t);raw(f,'## メモ\n'+'😀'.repeat(n-1)+'\n## 成果\n- 保持\n');const before=fs.readFileSync(f.file);const v=f.budget.preview(f.p.id,f.task.id);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(v.moves.length,n>24000?1:0);apply(f);const body=sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='メモ').body;assert.ok(count(body)<= (n>24000?20000:n));if(n>24000)assert.ok(f.budget.search(f.p.id,f.task.id,'😀').includes('notes-'));});
test('初回未承認は読取/maintain/再起動で無変更、確認なし拒否',t=>{const f=fixture(t);raw(f,'## メモ\n'+('- x\n'.repeat(7000)));const before=fs.readFileSync(f.file);f.budget.maintain(f.p.id,f.task.id);new TextBudget({store:f.store}).maintain(f.p.id,f.task.id);assert.deepEqual(fs.readFileSync(f.file),before);const v=f.budget.preview(f.p.id,f.task.id);assert.throws(()=>f.budget.apply(v));assert.ok(!fs.existsSync(f.budget.stateFile(f.p.id)));});
test('成果原文・管理欄・他taskを保持、節順とCRLF/末尾改行/重複/リンク保持',t=>{const f=fixture(t),other=fs.readFileSync(f.store.taskFile(f.p.id,f.other.id));const result='- body:.@abcdef0（成果）\r\n<!-- untouched -->\r\n';raw(f,'## 最新の再開要約\r\n承認：本体反映なし\r\n## 成果\r\n'+result+'## 古い詳細\r\nold\r\n## メモ\r\n'+('- 同じ原文😀\r\n'.repeat(3000))+'## 注意\r\n最後（改行なし）');const original=fs.readFileSync(f.file,'utf8'),before=f.store.readTask(f.file);apply(f);const after=fs.readFileSync(f.file,'utf8'),s=sections(after);assert.equal(s.find(x=>x.name==='成果').body,result);assert.equal(after.slice(0,after.indexOf('## ')),original.slice(0,original.indexOf('## ')));assert.equal(s.find(x=>x.name==='注意').body,'最後（改行なし）');assert.deepEqual(fs.readFileSync(f.store.taskFile(f.p.id,f.other.id)),other);assert.equal(f.store.readTask(f.file).artifacts?.length,before.artifacts?.length);const j=f.budget.pending(f.p.id);assert.equal(j.length,0);const archive=f.budget.archives(f.p.id,f.task.id);assert.ok(archive.some(x=>x.path.includes('sections-')));for(const a of archive)assert.equal(fs.statSync(path.join(f.p.dir,a.path)).mode&0o777,0o600);});
for(const umask of [0o022,0o077])test('POSIX権限維持 umask '+umask.toString(8),t=>{const f=fixture(t);raw(f,'## メモ\n'+('- x\n'.repeat(7000)));fs.chmodSync(f.file,0o664);fs.chmodSync(f.project,0o660);const old=process.umask(umask);try{apply(f);}finally{process.umask(old);}assert.equal(fs.statSync(f.file).mode&0o777,0o664);assert.equal(fs.statSync(f.project).mode&0o777,0o660);const a=path.join(f.p.dir,f.budget.archives(f.p.id,f.task.id)[0].path);fs.chmodSync(a,0o660);f.store.updateTask(f.p.id,f.task.id,{memo:'x'.repeat(25000)});const old2=process.umask(umask);try{f.budget.maintain(f.p.id,f.task.id);}finally{process.umask(old2);}assert.equal(fs.statSync(a).mode&0o777,0o660);});
test('要約は先頭だけ、重要情報超過は原文を残し表示不足を明示',t=>{const f=fixture(t);raw(f,'## 最新の再開要約\n'+'承認未済'.repeat(800)+'\n## 最新の再開要約（旧）\nOLD\n## 成果\nRESULT\n');const v=f.budget.preview(f.p.id,f.task.id);assert.equal(v.warnings.length,1);apply(f);const r=fs.readFileSync(f.file,'utf8');assert.ok(r.includes('承認未済'.repeat(800)));assert.equal(sections(r).filter(x=>x.name.startsWith('最新の再開要約')).length,1);const sv=summaryView(r);assert.equal(count(sv.text),2000);assert.ok(sv.incomplete);assert.match(sv.warning,/書き直し/);});
test('要約2000字境界・重要行優先、旧要約は置換前に全原文保管',t=>{const f=fixture(t);raw(f,'## 最新の再開要約\n'+'ordinary\n'.repeat(300)+'承認：KEEP\n未済：KEEP\n## 成果\nRESULT\n');apply(f);const r=fs.readFileSync(f.file,'utf8');assert.ok(count(summaryView(r).text)<=2000);assert.ok(r.includes('承認：KEEP'));const old=sections(r).find(s=>s.name==='最新の再開要約').body;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'決定事項：新要約😀'});assert.ok(f.budget.archives(f.p.id,f.task.id).some(a=>fs.readFileSync(path.join(f.p.dir,a.path),'utf8').includes(old)));assert.throws(()=>f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'😀'.repeat(2001)}));});
test('PROJECT最新側・INDEX末尾側を保持、連続保管の欠落重複なし',t=>{const f=fixture(t);fs.appendFileSync(f.project,'- newest\n'+'- old\n'.repeat(5000));fs.mkdirSync(path.dirname(f.index),{recursive:true});fs.writeFileSync(f.index,'# INDEX\n'+'- old-index\n'.repeat(1000)+'- newest-index');apply(f);assert.ok(fs.readFileSync(f.project,'utf8').includes('newest'));assert.ok(fs.readFileSync(f.index,'utf8').includes('newest-index'));assert.ok(count(fs.readFileSync(f.index,'utf8'))<=8000);const archives=f.budget.archives(f.p.id,f.task.id).map(a=>[a.path,fs.readFileSync(path.join(f.p.dir,a.path),'utf8')]);f.budget.maintain(f.p.id,f.task.id);assert.deepEqual(f.budget.archives(f.p.id,f.task.id).map(a=>[a.path,fs.readFileSync(path.join(f.p.dir,a.path),'utf8')]),archives);});
test('AI/別作業/統合/受領/保存中busyは読み取りだけ、解除後に新preview',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- x\n'.repeat(7000));let busy='他の作業でAIが動いています';f.budget.busy=()=>busy;const before=fs.readFileSync(f.file);const v=f.budget.preview(f.p.id,f.task.id);assert.equal(v.token,'');assert.equal(v.reason,busy);assert.deepEqual(fs.readFileSync(f.file),before);busy='';const v2=f.budget.preview(f.p.id,f.task.id);busy='統合中';assert.throws(()=>f.budget.apply({...v2,confirm:true}),/統合中/);assert.deepEqual(fs.readFileSync(f.file),before);busy='';apply(f);});
test('preview後のPROJECT/INDEX/保管先/権限変更を拒否、旧token再送拒否',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- x\n'.repeat(7000));const v=f.budget.preview(f.p.id,f.task.id);fs.appendFileSync(f.project,'new');assert.throws(()=>f.budget.apply({...v,confirm:true}),/変わりました/);assert.throws(()=>f.budget.apply({...v,confirm:true}));});
for(const stage of ['intent','archive','task','policy'])test('中断 '+stage+' →新instance明示復旧は二重移動なし',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- x\n'.repeat(7000));const before=fs.readFileSync(f.file,'utf8');let once=false;f.budget.checkpoint=(name,x)=>{if(!once&&(stage==='intent'&&name==='intent'||stage==='archive'&&name==='write'&&x.file.includes('notes-')||stage==='task'&&name==='write'&&x.file===f.file||stage==='policy'&&name==='write'&&x.file===f.budget.stateFile(f.p.id))){once=true;throw Error('injected crash');}};assert.throws(()=>apply(f),/injected crash/);assert.equal(f.budget.pending(f.p.id).length,1);if(['intent','archive'].includes(stage))assert.equal(fs.readFileSync(f.file,'utf8'),before);const fresh=new TextBudget({store:f.store});assert.equal(fresh.preview(f.p.id,f.task.id).token,'');fresh.recover({project:f.p.id,task:f.task.id,confirm:true});const a=fresh.archives(f.p.id,f.task.id)[0],ar=fs.readFileSync(path.join(f.p.dir,a.path),'utf8');assert.equal(ar.match(/<!-- /g).length,1);assert.equal(fresh.pending(f.p.id).length,0);assert.throws(()=>fresh.recover({project:f.p.id,task:f.task.id,confirm:true}));});
test('不明結果＋原文変更は復旧拒否、symlink拒否',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- x\n'.repeat(7000));f.budget.checkpoint=()=>{throw Error('stop');};assert.throws(()=>apply(f));fs.appendFileSync(f.file,'different');assert.throws(()=>f.budget.recover({project:f.p.id,task:f.task.id,confirm:true}),/変わっています/);const g=fixture(t);fs.symlinkSync(g.file,g.index);assert.throws(()=>g.budget.preview(g.p.id,g.task.id),/リンク/);});
test('総取得Unicode上限、巨大未済/成果/管理情報も不足と検索経路を明示',t=>{const f=fixture(t);for(const n of [0,100,10000,50000]){const text='---\n'+('😀'.repeat(n))+'\n---\n## 最新の再開要約\n承認：'+('😀'.repeat(n))+'\n## 手順\n'+('- [ ] 未済😀\n'.repeat(n))+'## 成果\n'+('r😀'.repeat(n))+'\n## メモ\n'+('m😀'.repeat(n));const view=taskView(text,'p😀'.repeat(n));assert.ok(count(view)<=24000,count(view));assert.ok(!/[\uD800-\uDBFF]$/.test(view));if(n>=10000){assert.match(view,/表示不足/);assert.match(view,/hub_search_archive/);}}});
test('局所検索は前後2行・8000字、元ファイル/重複/空行も検索',t=>{const f=fixture(t);raw(f,'## メモ\n0\n1\nMATCH\n3\n4\n5\n'+'MATCH\n'.repeat(5000));apply(f);const q=f.budget.search(f.p.id,f.task.id,'MATCH');assert.ok(count(q)<=8000);assert.match(q,/原文|結果は一部/);assert.throws(()=>f.budget.search(f.p.id,f.task.id,' '));});

test('やったことは末尾が最新、原文順を保って古い先頭を保管',t=>{const f=fixture(t);raw(f,'## やったこと\n'+'- OLD\n'.repeat(5000)+'- NEWEST（末尾改行なし）');apply(f);const body=sections(fs.readFileSync(f.file,'utf8')).find(x=>x.name==='やったこと').body;assert.ok(body.endsWith('NEWEST（末尾改行なし）'));assert.ok(count(body)<=20000);assert.ok(f.budget.archives(f.p.id,f.task.id).some(a=>a.path.includes('completed-')));});

test('残件申告と受領用成果解析を原文のまま保持',t=>{const f=fixture(t),result='- なし：配布ファイルなし\n',declaration='```json\n{"status":"あり","items":"未済の実機","undecided":"なし","evidence":"保存証拠"}\n```\n';raw(f,'## 成果\n'+result+'## 残件申告\n'+declaration+'## メモ\n'+'- OLD\n'.repeat(5000));const {readResults}=require('../lib/task-results'),{declaration:readDeclaration}=require('../lib/task-continuation');const before=[readResults(f.file),readDeclaration(f.file)];apply(f);assert.deepEqual([readResults(f.file),readDeclaration(f.file)],before);assert.equal(sections(fs.readFileSync(f.file,'utf8')).find(s=>s.name==='残件申告').body,declaration);});
test('完了済みの本文は全体指紋と正式承認を保持',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- OLD\n'.repeat(5000));let r=fs.readFileSync(f.file,'utf8').replace('state: 実行中','state: 完了');fs.writeFileSync(f.file,r);f.store.completion.approveTask(f.p.id+'/'+f.task.id,r);assert.equal(f.store.readTask(f.file).state,'完了');const before=fs.readFileSync(f.file),control=fs.readFileSync(f.store.completion.file);const v=f.budget.preview(f.p.id,f.task.id);assert.ok(v.warnings.length);f.budget.apply({...v,confirm:true});assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readFileSync(f.store.completion.file),control);assert.equal(f.store.readTask(f.file).state,'完了');});
for(const target of ['archive','source'])for(const operation of ['writeFileSync','fchmodSync','fsyncSync','renameSync'])test('書込み段階失敗 '+target+'/'+operation+' 原文保持と明示復旧',t=>{const f=fixture(t);raw(f,'## メモ\n'+'- OLD\n'.repeat(5000));fs.chmodSync(f.file,0o664);const original=fs.readFileSync(f.file),v=f.budget.preview(f.p.id,f.task.id),destination=target==='source'?f.file:path.join(f.p.dir,v.moves[0].archive),saved={},fds=new Map();let injected=false;
 for(const name of ['openSync','closeSync',operation])saved[name]=fs[name];fs.openSync=(file,...args)=>{const fd=saved.openSync(file,...args);fds.set(fd,String(file));return fd;};fs.closeSync=fd=>{fds.delete(fd);return saved.closeSync(fd);};fs[operation]=(...args)=>{const file=operation==='renameSync'?args[1]:fds.get(args[0]);if(!injected&&(operation==='renameSync'?file===destination:file===destination+'.tmp')){injected=true;throw Error('injected IO');}return saved[operation](...args);};try{assert.throws(()=>f.budget.apply({...v,confirm:true}),/injected IO/);}finally{for(const [name,fn] of Object.entries(saved))fs[name]=fn;}
 assert.equal(injected,true);assert.deepEqual(fs.readFileSync(f.file),original);assert.equal(fs.statSync(f.file).mode&0o777,0o664);assert.throws(()=>f.budget.apply({...v,confirm:true}));const fresh=new TextBudget({store:f.store});assert.equal(fresh.preview(f.p.id,f.task.id).token,'');if(operation==='writeFileSync'){assert.throws(()=>fresh.recover({project:f.p.id,task:f.task.id,confirm:true}),/一時原文/);assert.deepEqual(fs.readFileSync(f.file),original);}else{fresh.recover({project:f.p.id,task:f.task.id,confirm:true});const ar=fs.readFileSync(path.join(f.p.dir,v.moves[0].archive),'utf8');assert.equal(ar.match(/<!-- /g).length,1);assert.equal(fs.statSync(f.file).mode&0o777,0o664);assert.equal(fresh.preview(f.p.id,f.task.id,v.token).requestStatus,'done');}});
test('極端に長い節名でも不足通知込み合計24000字',()=>{const view=taskView('## '+ '😀'.repeat(30000)+'\nOLD\n## 手順\n- [ ] KEEP\n','');assert.ok(count(view)<=24000);assert.match(view,/hub_search_archive/);});
test('六欄要約もラベルと改行を含むUnicode2000字',()=>{const {summaryFields,summaryText}=require('../lib/task-history'),fields={decision:'😀',reason:'😀',current:'😀',approved:'😀',residual:'😀',evidence:'😀'},space=2000-count(summaryText(fields));fields.evidence+='😀'.repeat(space);assert.equal(count(summaryText(summaryFields(fields))),2000);assert.throws(()=>summaryFields({...fields,evidence:fields.evidence+'😀'}),/2000/);});
test('重要行を優先しても要約原文の行順とCRLFを変えない',t=>{const f=fixture(t);const head='ordinary-first\r\n承認：KEEP-A\r\nordinary-middle\r\n未済：KEEP-B\r\n';raw(f,'## 最新の再開要約\r\n'+head+'overflow\r\n'.repeat(400)+'## 成果\r\nRESULT\r\n');apply(f);const body=sections(fs.readFileSync(f.file,'utf8')).find(s=>s.name==='最新の再開要約').body;assert.ok(body.startsWith(head));assert.ok(count(body.trim())<=2000);});
test('AI稼働中の要約更新は依頼だけ保存、終了後に原文保管と置換を一度だけ行う',t=>{const f=fixture(t);raw(f,'## 最新の再開要約\n承認：OLD\n## 成果\n- なし：保持\n');apply(f);const before=fs.readFileSync(f.file),archives=f.budget.archives(f.p.id,f.task.id);let busy='AI running';f.budget.busy=()=>busy;const q=f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'未済：NEW'});assert.equal(q.queued,true);assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(f.budget.archives(f.p.id,f.task.id),archives);assert.equal(fs.statSync(f.budget.summaryRequestFile(f.p.id,f.task.id)).mode&0o777,0o600);assert.equal(f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'未済：NEW'}).id,q.id);assert.throws(()=>f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'other'}),/更新依頼/);assert.throws(()=>f.budget.maintain(f.p.id,f.task.id),/AI running/);busy='';const fresh=new TextBudget({store:f.store});fresh.maintain(f.p.id,f.task.id);assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'未済：NEW');const ar=fs.readFileSync(path.join(f.p.dir,fresh.archives(f.p.id,f.task.id)[0].path),'utf8');assert.ok(ar.includes('承認：OLD\n'));fresh.maintain(f.p.id,f.task.id);assert.equal(fs.readFileSync(path.join(f.p.dir,fresh.archives(f.p.id,f.task.id)[0].path),'utf8'),ar);});
test('終了待ち要約は旧原文変更を拒否し、原文を上書きしない',t=>{const f=fixture(t);raw(f,'## 最新の再開要約\nOLD\n');apply(f);f.budget.busy=()=>true;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'NEW'});fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('OLD','OTHER'));const now=fs.readFileSync(f.file);const fresh=new TextBudget({store:f.store});assert.match(fresh.maintain(f.p.id,f.task.id).warnings[0],/原文が変わっています/);assert.deepEqual(fs.readFileSync(f.file),now);const request=fresh.summaryRequestFile(f.p.id,f.task.id);assert.equal(JSON.parse(fs.readFileSync(request)).stage,'conflict');fresh.busy=()=>true;fresh.replaceSummary({project:f.p.id,task:f.task.id,summary:'CONFIRMED'});assert.equal(JSON.parse(fs.readFileSync(request)).history[0].summary,'NEW');fresh.busy=()=>false;fresh.maintain(f.p.id,f.task.id);assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'CONFIRMED');});
test('終了待ち要約の中断と明示復旧後も同じ依頼を再実行しない',t=>{const f=fixture(t);raw(f,'## 最新の再開要約\n承認：OLD\n');apply(f);f.budget.busy=()=>true;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'NEW'});f.budget.busy=()=>false;f.budget.checkpoint=name=>{if(name==='write')throw Error('stop');};assert.throws(()=>f.budget.maintain(f.p.id,f.task.id),/stop/);const fresh=new TextBudget({store:f.store});assert.throws(()=>fresh.maintain(f.p.id,f.task.id),/復旧/);fresh.recover({project:f.p.id,task:f.task.id,confirm:true});const a=fresh.archives(f.p.id,f.task.id)[0],ar=fs.readFileSync(path.join(f.p.dir,a.path),'utf8');fresh.maintain(f.p.id,f.task.id);assert.equal(fs.readFileSync(path.join(f.p.dir,a.path),'utf8'),ar);assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'NEW');});

function conflict(t){const f=fixture(t);raw(f,'## 最新の再開要約\r\n承認：OLD\r\n## 成果\r\n- なし：保持\r\n');fs.chmodSync(f.file,0o664);apply(f);f.budget.busy=()=>true;const q=f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'未済：OLD-CANDIDATE'});fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('承認：OLD','承認：EXTERNAL'));f.budget.busy=()=>false;assert.match(f.budget.maintain(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);return {...f,q,request:f.budget.summaryRequestFile(f.p.id,f.task.id)};}
test('未解決の要約競合は定期確認反復・新instance・previewでも警告と原文を保持',t=>{const f=conflict(t),source=fs.readFileSync(f.file),request=fs.readFileSync(f.request),other=fs.readFileSync(f.store.taskFile(f.p.id,f.other.id));for(let i=0;i<3;i++){const b=new TextBudget({store:f.store});assert.match(b.maintain(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);assert.match(b.preview(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);assert.deepEqual(fs.readFileSync(f.file),source);assert.deepEqual(fs.readFileSync(f.request),request);assert.equal(b.archives(f.p.id,f.task.id).length,0);}assert.deepEqual(fs.readFileSync(f.store.taskFile(f.p.id,f.other.id)),other);assert.equal(fs.statSync(f.file).mode&0o777,0o664);});
for(const busy of [true,false])test('競合後の確認済み新候補 '+(busy?'busy受付':'idle直接反映')+' は適用後だけ警告解除し旧履歴を保持',t=>{const f=conflict(t),prior=JSON.parse(fs.readFileSync(f.request)),source=fs.readFileSync(f.file);f.budget.busy=()=>busy;const r=f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'承認：CONFIRMED'});if(busy){assert.equal(r.queued,true);assert.deepEqual(fs.readFileSync(f.file),source);assert.match(f.budget.preview(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);f.budget.busy=()=>false;f.budget.maintain(f.p.id,f.task.id);}else assert.equal(r.ok,true);const q=JSON.parse(fs.readFileSync(f.request));assert.equal(q.stage,'done');assert.deepEqual(q.history,[Object.fromEntries(Object.entries(prior).filter(([k])=>k!=='history'))]);assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'承認：CONFIRMED');assert.deepEqual(f.budget.summaryWarnings(f.p.id,f.task.id),[]);assert.deepEqual(f.budget.preview(f.p.id,f.task.id).warnings,[]);const ar=path.join(f.p.dir,f.budget.archives(f.p.id,f.task.id)[0].path),bytes=fs.readFileSync(ar);assert.ok(bytes.toString().endsWith('承認：EXTERNAL\r\n'));new TextBudget({store:f.store}).maintain(f.p.id,f.task.id);assert.deepEqual(fs.readFileSync(ar),bytes);assert.equal(fs.statSync(f.file).mode&0o777,0o664);assert.equal(fs.statSync(f.request).mode&0o777,0o600);
 // Historical conflicts must not warn on a later ordinary queued update.
 f.budget.busy=()=>true;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'未済：NEXT'});assert.deepEqual(f.budget.preview(f.p.id,f.task.id).warnings,[]);f.budget.busy=()=>false;f.budget.maintain(f.p.id,f.task.id);assert.deepEqual(f.budget.summaryWarnings(f.p.id,f.task.id),[]);assert.equal(JSON.parse(fs.readFileSync(f.request)).history[0].summary,'未済：OLD-CANDIDATE');});
for(const stage of ['intent','archive'])test('競合後のidle新候補が'+stage+'で中断しても警告・履歴保持、明示復旧後非重複',t=>{const f=conflict(t),source=fs.readFileSync(f.file);let injected=false;f.budget.checkpoint=(name,x)=>{if(!injected&&(stage==='intent'&&name==='intent'||stage==='archive'&&name==='write'&&x.file.includes('summary-'))){injected=true;throw Error('conflict replacement interrupted');}};assert.throws(()=>f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'承認：RECOVERED'}),/interrupted/);assert.equal(injected,true);assert.deepEqual(fs.readFileSync(f.file),source);const fresh=new TextBudget({store:f.store});assert.match(fresh.preview(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);const request=fs.readFileSync(f.request);assert.throws(()=>fresh.replaceSummary({project:f.p.id,task:f.task.id,summary:'承認：OTHER'}),/復旧/);assert.deepEqual(fs.readFileSync(f.request),request);fresh.recover({project:f.p.id,task:f.task.id,confirm:true});fresh.maintain(f.p.id,f.task.id);assert.deepEqual(fresh.preview(f.p.id,f.task.id).warnings,[]);assert.equal(JSON.parse(fs.readFileSync(f.request)).history[0].stage,'conflict');const ar=path.join(f.p.dir,fresh.archives(f.p.id,f.task.id)[0].path),bytes=fs.readFileSync(ar);fresh.maintain(f.p.id,f.task.id);assert.deepEqual(fs.readFileSync(ar),bytes);assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'承認：RECOVERED');});
test('競合後のidle新候補がintent前に拒否されても自動待機へ移さず旧候補を保持',t=>{const f=conflict(t),source=fs.readFileSync(f.file),request=fs.readFileSync(f.request);let calls=0;f.budget.busy=()=>++calls>=2?'activity resumed':'';assert.throws(()=>f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'承認：REJECTED'}),/activity resumed/);assert.deepEqual(fs.readFileSync(f.request),request);assert.deepEqual(fs.readFileSync(f.file),source);assert.equal(f.budget.pending(f.p.id).length,0);const fresh=new TextBudget({store:f.store});for(let i=0;i<3;i++)assert.match(fresh.maintain(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);assert.deepEqual(fs.readFileSync(f.file),source);assert.deepEqual(fs.readFileSync(f.request),request);assert.equal(fresh.archives(f.p.id,f.task.id).length,0);});
test('確認済み新候補も再競合したら旧2候補・原文を保持し警告を継続',t=>{const f=conflict(t);f.budget.busy=()=>true;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'承認：CONFIRMED'});fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('EXTERNAL','EXTERNAL-AGAIN'));const source=fs.readFileSync(f.file);f.budget.busy=()=>false;for(let i=0;i<3;i++)assert.match(f.budget.maintain(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);const q=JSON.parse(fs.readFileSync(f.request));assert.equal(q.stage,'conflict');assert.equal(q.summary,'承認：CONFIRMED');assert.equal(q.history[0].summary,'未済：OLD-CANDIDATE');assert.deepEqual(fs.readFileSync(f.file),source);assert.equal(f.budget.archives(f.p.id,f.task.id).length,0);});

test('定期整理は対象なし/変更なしなら完全busy検査もmaintainも呼ばない',t=>{
 const f=fixture(t);let checks=0;const notices=[];f.budget.maintainEnabled(()=>{checks++;return false;},(...x)=>notices.push(x));assert.equal(checks,0);
 raw(f,'## 最新の再開要約\n未済：保持\n## 成果\n- 保持\n');apply(f);const before=fs.readFileSync(f.file);f.budget.busy=()=>{throw Error('idle check must not run');};f.budget.maintainEnabled(()=>{checks++;return false;},(...x)=>notices.push(x));assert.equal(checks,0);assert.deepEqual(notices.at(-1),[f.p.id+' / '+f.task.id,[]]);assert.deepEqual(fs.readFileSync(f.file),before);
});
test('定期整理はqueued/新しい超過を検出し、直前の完全検査と現在policyを維持',t=>{
 const f=fixture(t);raw(f,'## 最新の再開要約\nOLD\n## 成果\n保持\n');apply(f);f.budget.busy=()=>true;f.budget.replaceSummary({project:f.p.id,task:f.task.id,summary:'NEW'});f.budget.busy=()=>false;
 let checks=0;const before=fs.readFileSync(f.file);f.budget.maintainEnabled(()=>{checks++;return true;},()=>{});assert.equal(checks,1);assert.deepEqual(fs.readFileSync(f.file),before);
 f.budget.maintainEnabled(()=>{checks++;f.budget.busy=()=> 'activity resumed';return false;},(k,w)=>assert.match(w.join(' '),/activity resumed/));assert.deepEqual(fs.readFileSync(f.file),before);
 f.budget.busy=()=>false;f.budget.maintainEnabled(()=>false,()=>{});assert.equal(summaryView(fs.readFileSync(f.file,'utf8')).text,'NEW');
 fs.appendFileSync(f.file,'## メモ\n'+'over\n'.repeat(6000));assert.equal(f.budget.needsMaintenance(f.p.id,f.task.id),true);f.budget.maintainEnabled(()=>false,()=>{});assert.ok(count(sections(fs.readFileSync(f.file,'utf8')).find(s=>s.name==='メモ').body)<=20000);
});
test('定期整理の読取判定は不明journalと競合原文を保持して通知する',t=>{
 const f=conflict(t),source=fs.readFileSync(f.file),request=fs.readFileSync(f.request);let checks=0;f.budget.maintainEnabled(()=>{checks++;return false;},()=>{});assert.equal(checks,0);assert.deepEqual(fs.readFileSync(f.file),source);assert.deepEqual(fs.readFileSync(f.request),request);assert.ok(f.budget.summaryWarnings(f.p.id,f.task.id).length);
 fs.writeFileSync(path.join(f.budget.dir,'00000000-0000-0000-0000-000000000000.json'),JSON.stringify({project:f.p.id,stage:'intent'}));const notices=[];f.budget.maintainEnabled(()=>{checks++;return false;},(k,w)=>notices.push(w));assert.match(notices.flat().join(' '),/復旧/);assert.equal(checks,0);assert.deepEqual(fs.readFileSync(f.file),source);
});
test('定期整理は変更を作れない長い重要要約の警告も読取りだけで維持',t=>{
 const f=fixture(t);raw(f,'## 最新の再開要約\n承認：'+'KEEP'.repeat(700)+'\n');apply(f);let checks=0;const before=fs.readFileSync(f.file),notices=[];
 f.budget.maintainEnabled(()=>{checks++;return false;},(k,w)=>notices.push(w));assert.equal(checks,0);assert.match(notices.flat().join(' '),/重要情報/);assert.deepEqual(fs.readFileSync(f.file),before);
});

test('定期確認は完了journalの本文を再読せず、新規・変更・削除を検出する',t=>{
 const f=fixture(t);fs.mkdirSync(f.budget.dir,{recursive:true});
 const file=path.join(f.budget.dir,'00000000-0000-0000-0000-000000000000.json');
 const done=JSON.stringify({project:f.p.id,stage:'done',original:'x'.repeat(2*1024*1024)});
 fs.writeFileSync(file,done);const read=fs.readFileSync;let reads=0;
 fs.readFileSync=(name,...args)=>{if(String(name)===file)reads++;return read(name,...args);};
 try{
  assert.deepEqual(f.budget.pending(f.p.id,{preflight:true}),[]);
  for(let i=0;i<6;i++)assert.deepEqual(f.budget.pending(f.p.id,{preflight:true}),[]);
  assert.equal(reads,1);
  // Safety gates deliberately bypass the periodic cache.
  f.budget.pending(f.p.id);assert.equal(reads,2);
  f.budget.pending(f.p.id,{preflight:true});assert.equal(reads,3);
  const previous=fs.statSync(file);
  fs.writeFileSync(file,done.replace('"done"','"oops"'));
  fs.utimesSync(file,previous.atime,previous.mtime);
  assert.equal(f.budget.pending(f.p.id,{preflight:true})[0].j.stage,'oops');
  const before=reads;f.budget.pending(f.p.id,{preflight:true});assert.equal(reads,before+1);
  fs.writeFileSync(file+'.new',done);fs.renameSync(file+'.new',file);
  assert.deepEqual(f.budget.pending(f.p.id,{preflight:true}),[]);
  fs.unlinkSync(file);assert.deepEqual(f.budget.pending(f.p.id,{preflight:true}),[]);
  assert.equal(f.budget.completedJournals.size,0);
  fs.writeFileSync(file,JSON.stringify({project:f.p.id,stage:'intent'}));
  assert.throws(()=>f.budget.maintenanceCheck(f.p.id,f.task.id),/復旧/);
  fs.writeFileSync(file,'{broken');assert.throws(()=>f.budget.pending(f.p.id,{preflight:true}),SyntaxError);
 }finally{fs.readFileSync=read;}
});
for(const link of ['symlink','hardlink'])test('定期確認の完了cacheも'+link+'への置換を拒否',t=>{
 const f=fixture(t);fs.mkdirSync(f.budget.dir,{recursive:true});
 const file=path.join(f.budget.dir,'00000000-0000-0000-0000-000000000000.json'),other=path.join(f.budget.dir,'original');
 fs.writeFileSync(file,JSON.stringify({project:f.p.id,stage:'done'}));f.budget.pending(f.p.id,{preflight:true});
 fs.renameSync(file,other);if(link==='symlink')fs.symlinkSync(other,file);else fs.linkSync(other,file);
 assert.throws(()=>f.budget.pending(f.p.id,{preflight:true}));
});
test('36MBの完了記録と3作業でも次の見回りは本文読取り0回',t=>{
 const f=fixture(t),third=f.store.createTask(f.p.id,{title:'third'}),tasks=[f.task.id,f.other.id,third.id];
 for(const task of tasks)fs.writeFileSync(f.store.taskFile(f.p.id,task),'---\nid: '+task+'\nstate: 実行中\n---\n## 成果\n保持\n');
 fs.mkdirSync(f.budget.dir,{recursive:true});fs.writeFileSync(f.budget.stateFile(f.p.id),JSON.stringify({tasks}));
 const journals=new Set();for(let i=0;i<27;i++){
  const file=path.join(f.budget.dir,'00000000-0000-0000-0000-'+String(i).padStart(12,'0')+'.json');
  fs.writeFileSync(file,JSON.stringify({project:f.p.id,stage:'done',original:'x'.repeat(1400000)}));journals.add(file);
 }
 const read=fs.readFileSync;let reads=0;const notices=[];
 fs.readFileSync=(name,...args)=>{if(journals.has(String(name)))reads++;return read(name,...args);};
 try{
  const cold=performance.now();f.budget.maintainEnabled(()=>{throw Error('unexpected write');},(...x)=>notices.push(x));const coldMs=performance.now()-cold;
  assert.equal(reads,27);reads=0;const warm=performance.now();
  for(let i=0;i<3;i++)f.budget.maintainEnabled(()=>{throw Error('unexpected write');},(...x)=>notices.push(x));
  const warmMs=(performance.now()-warm)/3;assert.equal(reads,0);assert.equal(notices.length,12);assert.ok(notices.every(x=>x[1].length===0));
  t.diagnostic('27 completed journals / 3 tasks: cold '+coldMs.toFixed(1)+'ms, warm average '+warmMs.toFixed(1)+'ms, repeated journal reads '+reads);
 }finally{fs.readFileSync=read;}
});

test('read plans reuse unchanged inputs, invalidate archives/summary/mode and retain fresh transact checks',async t=>{
 const f=fixture(t);raw(f,'## 最新の再開要約\n未済：KEEP\n## メモ\n'+'- old\n'.repeat(6000));
 let builds=0;const build=f.budget.buildPlan.bind(f.budget);f.budget.buildPlan=(...a)=>{builds++;return build(...a);};
 const a=f.budget.plan(f.p.id,f.task.id);assert.ok(a.changes.length);assert.deepEqual(f.budget.plan(f.p.id,f.task.id),a);assert.equal(builds,1);
 a.changes[0].next='mutated caller';assert.notEqual(f.budget.plan(f.p.id,f.task.id).changes[0].next,a.changes[0].next);
 const archive=f.budget.plan(f.p.id,f.task.id).changes.find(x=>x.file.includes('notes-')).file;fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'destination changed');
 f.budget.plan(f.p.id,f.task.id);assert.equal(builds,2);
 const stamp=fs.statSync(f.file);const text=fs.readFileSync(f.file,'utf8');fs.writeFileSync(f.file,text.replace('KEEP','NEXT'));fs.utimesSync(f.file,stamp.atime,stamp.mtime);f.budget.plan(f.p.id,f.task.id);assert.equal(builds,3);
 fs.chmodSync(f.file,0o640);f.budget.plan(f.p.id,f.task.id);assert.equal(builds,4);
 fs.mkdirSync(f.budget.dir,{recursive:true});fs.writeFileSync(f.budget.summaryRequestFile(f.p.id,f.task.id),JSON.stringify({stage:'conflict'}));assert.match(f.budget.plan(f.p.id,f.task.id).warnings.join(' '),/原文が変わっています/);assert.equal(builds,5);
 const pv=await f.budget.previewAsync(f.p.id,f.task.id);fs.appendFileSync(archive,'later');assert.throws(()=>f.budget.apply({...pv,confirm:true}),/変わりました/);
});
test('cold async body plan stays off the event loop; concurrent reads share work and live busy/token gates remain',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old😀\n'.repeat(100000));let ticks=0;const timer=setInterval(()=>ticks++,2);t.after(()=>clearInterval(timer));
 const [a,b]=await Promise.all([f.budget.previewAsync(f.p.id,f.task.id),f.budget.previewAsync(f.p.id,f.task.id)]);
 assert.ok(ticks>3);assert.deepEqual(a.moves,b.moves);assert.notEqual(a.token,b.token);assert.equal(f.budget.planCache.size,1);
 assert.deepEqual(f.budget.plan(f.p.id,f.task.id),new TextBudget({store:f.store}).plan(f.p.id,f.task.id));
 f.budget.busy=()=> 'AI moving';assert.equal((await f.budget.previewAsync(f.p.id,f.task.id)).token,'');
 const key=f.budget.planKey(f.p.id,f.task.id);fs.appendFileSync(f.project,'\n## new\n');assert.equal(f.budget.cachedPlan(key),null);
});
test('async periodic maintenance warms plans without writing while busy, then uses unchanged transaction checks',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old\n'.repeat(6000));apply(f);raw(f,'## メモ\n'+'- new\n'.repeat(6000));const before=fs.readFileSync(f.file);
 const notices=[];await f.budget.prepareMaintenance((...x)=>notices.push(x));f.budget.maintainEnabled(()=>true,(...x)=>notices.push(x));assert.deepEqual(fs.readFileSync(f.file),before);
 await f.budget.prepareMaintenance();f.budget.maintainEnabled(()=>false,()=>{});assert.ok(fs.readFileSync(f.file).length<before.length);assert.equal(f.budget.pending(f.p.id).length,0);
});
test('oversized plans remain usable by async preflight without retaining unbounded cache entries',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old\n'.repeat(6000));
 const archive=f.budget.plan(f.p.id,f.task.id).changes.find(c=>c.file.includes('notes-')).file;fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'x'.repeat(5*1024*1024));
 assert.equal((await f.budget.maintenanceCheckAsync(f.p.id,f.task.id)).needed,true);assert.equal(f.budget.planCache.size,0);assert.equal(f.budget.tokens.size,0);
});
test('async preview reads large completed journals off-loop, reuses only unchanged metadata, and never caches write permission',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old\n'.repeat(6000));fs.mkdirSync(f.budget.dir,{recursive:true});
 const files=[];for(let i=0;i<12;i++){const file=path.join(f.budget.dir,'00000000-0000-0000-0000-'+String(i).padStart(12,'0')+'.json');fs.writeFileSync(file,JSON.stringify({id:'done-'+i,project:f.p.id,task:f.task.id,stage:'done',request:'request-'+i,original:'x'.repeat(1000000)}));files.push(file);}
 const before=files.map(f=>fs.readFileSync(f)),syncRead=fs.readFileSync;let mainReads=0,ticks=0;fs.readFileSync=(file,...args)=>{if(files.includes(String(file)))mainReads++;return syncRead(file,...args);};const timer=setInterval(()=>ticks++,2);
 try{
  const first=await f.budget.previewAsync(f.p.id,f.task.id,'request-0');assert.equal(first.requestStatus,'done');assert.ok(first.token);assert.ok(ticks>3);assert.equal(mainReads,0);
  assert.equal((await f.budget.previewAsync(f.p.id,f.task.id,'request-0')).requestStatus,'done');assert.equal(mainReads,0);
  // A newly added unresolved record must block the next displayed token, and
  // a token from before that record still cannot authorize apply().
  const pending=path.join(f.budget.dir,'00000000-0000-0000-0000-999999999999.json');fs.writeFileSync(pending,JSON.stringify({id:'pending',project:f.p.id,task:f.task.id,stage:'intent'}));const blocked=await f.budget.previewAsync(f.p.id,f.task.id);assert.equal(blocked.token,'');assert.deepEqual(blocked.pending,['pending']);assert.throws(()=>f.budget.apply({...first,confirm:true}),/復旧/);assert.ok(mainReads>=12);
  fs.unlinkSync(pending);const st=fs.statSync(files[0]);fs.writeFileSync(files[0],before[0].toString().replace('"done"','"oops"'));fs.utimesSync(files[0],st.atime,st.mtime);assert.equal((await f.budget.previewAsync(f.p.id,f.task.id,'request-0')).token,'');
  fs.writeFileSync(files[0],'{malformed');await assert.rejects(f.budget.previewAsync(f.p.id,f.task.id));
 }finally{clearInterval(timer);fs.readFileSync=syncRead;}
});


test('periodic preparation is read-only; actual maintenance completes synchronously in a fresh handoff permit',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old\n'.repeat(6000));apply(f);raw(f,'## メモ\n'+'- new\n'.repeat(6000));
 const before=fs.readFileSync(f.file),{ChatRunner}=require('../lib/chat'),spool=path.join(f.root,'spool');fs.mkdirSync(spool);
 const runner=new ChatRunner({spoolRoot:spool});let scans=0;runner.handoffAdmission={async scan(){scans++;return {errors:[],dirs:[]};},close(){}};
 f.budget.busy=()=>runner.guardErrors().length?'no current handoff permit':'';
 await f.budget.prepareMaintenance();assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(scans,0);
 assert.throws(()=>f.budget.idle(f.p.id,f.task.id),/no current handoff permit/);
 let writeInside=false;f.budget.checkpoint=()=>{assert.deepEqual(runner.guardErrors(),[]);writeInside=true;};
 await runner.withStrictHandoff(()=>{
  assert.equal(f.budget.maintainEnabled(()=>false,(scope,w)=>assert.deepEqual(w,[])),undefined);
  assert.equal(writeInside,true);assert.ok(fs.readFileSync(f.file).length<before.length);
 });
 assert.equal(scans,1);assert.throws(()=>f.budget.idle(f.p.id,f.task.id),/no current handoff permit/);
});
test('maintenance discards a prepared plan after changed originals, and a new journal blocks writing',async t=>{
 const f=fixture(t);raw(f,'## メモ\n'+'- old\n'.repeat(6000));apply(f);raw(f,'## メモ\n'+'- warm\n'.repeat(6000));
 await f.budget.prepareMaintenance();const key=f.budget.planKey(f.p.id,f.task.id);assert.ok(f.budget.cachedPlan(key));
 raw(f,'## メモ\n'+'- LIVE\n'.repeat(6000));assert.equal(f.budget.cachedPlan(key),null);
 let builds=0;const build=f.budget.buildPlan.bind(f.budget);f.budget.buildPlan=(...args)=>{builds++;return build(...args);};
 f.budget.maintainEnabled(()=>false,(scope,w)=>assert.deepEqual(w,[]));assert.equal(builds,1);
 const archive=f.budget.archives(f.p.id,f.task.id).find(x=>x.path.includes('notes-'));assert.match(fs.readFileSync(path.join(f.p.dir,archive.path),'utf8'),/LIVE/);
 raw(f,'## メモ\n'+'- last\n'.repeat(6000));await f.budget.prepareMaintenance();const before=fs.readFileSync(f.file);
 fs.writeFileSync(path.join(f.budget.dir,'00000000-0000-0000-0000-999999999998.json'),JSON.stringify({project:f.p.id,task:f.task.id,stage:'intent'}));
 const notices=[];f.budget.maintainEnabled(()=>{throw Error('must not reach write admission');},(scope,w)=>notices.push(...w));assert.match(notices.join(' '),/復旧/);assert.deepEqual(fs.readFileSync(f.file),before);
});
