'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Freetalk}=require('../lib/freetalk'),{FreetalkHistory}=require('../lib/freetalk-history'),{FreetalkLifecycle,nextMonth,SETTINGS}=require('../lib/freetalk-lifecycle'),chat=require('../lib/chat');
const pick={ai:'codex',model:'GPT-6.1-Sol',effort:'高'};
function fixture(t){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-freetalk-lifecycle-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const store=new Store(path.join(tmp,'root')),ft=new Freetalk(store,path.join(tmp,'home'));assert.equal(ft.ensure().ready,true);
 const a=ft.createTopic(pick),b=ft.createTopic(pick);let busy='',date=new Date('2026-01-31T12:30:00');
 const history=new FreetalkHistory(ft,()=>busy),lifecycle=new FreetalkLifecycle(history,()=>busy,()=>date,path.join(__dirname,'../../docs/project-hub/templates/project'));
 lifecycle.save({lastClean:date.toISOString(),due:nextMonth(date)});
 return {tmp,store,ft,a,b,history,lifecycle,busy:v=>busy=v,date:v=>date=new Date(v)};
}
function approved(f){const {ft,a,history:h,lifecycle:l}=f;chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'会話の原文'});const r=h.prepareSummary(a.id);chat.append(ft.ledger,a.id,{role:'user',text:r.text});chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:pick.model,text:'AIの要約'});const p=l.preview(a.id);return {...p,name:'独立した旅行',summary:'人が編集した計画',files:p.files.map(f=>f.path),confirm:true};}
function write(file,text='内容'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function tree(dir){const rows=[];const walk=p=>{for(const n of fs.readdirSync(p).sort()){const f=path.join(p,n);if(fs.lstatSync(f).isDirectory())walk(f);else rows.push([path.relative(dir,f),fs.readFileSync(f).toString('base64')]);}};walk(dir);return rows;}
test('1暦月は月末補正、閏年、年越し、時刻を維持',()=>{for(const [from,to] of [['2026-01-31','2026-02-28'],['2028-01-31','2028-02-29'],['2026-03-31','2026-04-30'],['2026-12-31','2027-01-31']]){const d=new Date(nextMonth(from+'T12:30:00'));assert.equal(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,to);assert.equal(d.getHours(),12);assert.equal(d.getMinutes(),30);}});
test('プロジェクト化：編集要約、新セッション、原文と選択ファイル、元読取専用、二重作成なし',t=>{
 const f=fixture(t),{ft,a,b,lifecycle:l,history:h,store}=f;
 const selected=ft.upload(a.id,'写真.txt',Buffer.from('写真原文')),omitted=ft.upload(a.id,'残す.txt',Buffer.from('残す'));
 const other=ft.upload(b.id,'他話題.txt',Buffer.from('別話題'));write(path.join(ft.dir,'相談.txt'),'共通相談');
 write(path.join(ft.dir,'topics',a.id,'.ai/memory.md'),'話題メモリ');chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old',claude:'old'}});
 const body=approved(f);body.files=body.files.filter(v=>path.join(ft.dir,v)!==omitted);const original=fs.readFileSync(chat.files(ft.ledger,a.id).log);
 const r=l.promote(a.id,body),p=store.readProject(r.project);assert.ok(p);assert.equal(p.parent,'');assert.deepEqual(p.related,[]);
 assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),original);assert.deepEqual(chat.readMeta(p.dir,r.task).sessions,{});
 assert.match(chat.read(p.dir,r.task)[0].text,/人が編集した計画/);assert.doesNotMatch(chat.read(p.dir,r.task)[0].text,/AIの要約/);
 assert.equal(fs.readFileSync(path.join(p.dir,'資料/相談ファイル',path.relative(ft.dir,selected)),'utf8'),'写真原文');assert.equal(fs.existsSync(selected),false);
 for(const file of [omitted,other,path.join(ft.dir,'topics',a.id,'.ai/memory.md'),path.join(ft.dir,'AGENTS.md')])assert.ok(fs.existsSync(file));
 assert.equal(h.status(a.id).migrated.project,r.project);assert.throws(()=>h.rotate(a.id,{confirm:true}),/移行済み/);assert.throws(()=>h.prepareSummary(a.id),/移行済み/);
 assert.equal(l.promote(a.id,body).repeated,true);assert.equal(store.listProjects().filter(p=>p.kind!=='freetalk').length,1);
 l.clean({confirm:true});assert.ok(store.readProject(r.project));assert.deepEqual(chat.readMeta(p.dir,r.task).sessions,{});assert.deepEqual(fs.readFileSync(path.join(p.dir,'資料/自由対話原文.jsonl')),original);
 assert.equal(store.readProject('freetalk').tasks.length,0);const next=ft.createTopic(pick);assert.notEqual(next.id,a.id);assert.notEqual(next.id,b.id);
});
test('GEMINI.mdは移す候補から除外し掃除後も保持、未配置なら作成しない',t=>{
 const f=fixture(t),file=path.join(f.ft.dir,'GEMINI.md'),settings=Buffer.from('Geminiの人の設定\n');
 assert.equal(fs.existsSync(file),false);write(file,settings);write(path.join(f.ft.dir,'相談.txt'),'相談');
 const body=approved(f);assert.deepEqual(body.files,['相談.txt']);
 const r=f.lifecycle.promote(f.a.id,body),dest=f.store.readProject(r.project).dir;
 assert.deepEqual(fs.readFileSync(file),settings);assert.equal(fs.existsSync(path.join(dest,'資料/相談ファイル/GEMINI.md')),false);
 f.lifecycle.clean({confirm:true});assert.deepEqual(fs.readFileSync(file),settings);
 assert.equal(fs.readFileSync(path.join(dest,'資料/相談ファイル/相談.txt'),'utf8'),'相談');
 const absent=fixture(t),missing=path.join(absent.ft.dir,'GEMINI.md');
 absent.lifecycle.promote(absent.a.id,approved(absent));assert.equal(fs.existsSync(missing),false);
 absent.lifecycle.clean({confirm:true});assert.equal(fs.existsSync(missing),false);
});
test('古い確認/ファイル改変/選択外パス/同名/別操作IDを拒否し元保持',t=>{
 for(const kind of ['confirm','revision','files','name','changed','operationId']){
  const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f);
  if(kind==='confirm')body.confirm=false;if(kind==='revision')body.revision='old';if(kind==='files')body.files=['../outside'];if(kind==='name')body.name='FreeTalk';if(kind==='changed')write(path.join(f.ft.dir,'test.txt'),'更新');if(kind==='operationId')body.operationId='fake';
  const before=tree(f.ft.ledger);assert.throws(()=>f.lifecycle.promote(f.a.id,body));assert.deepEqual(tree(f.ft.ledger),before);assert.ok(fs.existsSync(path.join(f.ft.dir,'test.txt')));assert.equal(f.store.listProjects().length,1);
 }
 const f=fixture(t),body=approved(f);f.store.createProject({name:body.name});assert.throws(()=>f.lifecycle.promote(f.a.id,body),/同じ名前/);
});
test('AI/順番待ち/移行中はプロジェクト化・全体掃除を拒否し期限後も延期',t=>{
 const f=fixture(t),body=approved(f);f.date('2026-03-01T12:30:00');
 for(const reason of ['AIが作業中','順番待ち']){f.busy(reason);assert.equal(f.lifecycle.status().delayed,true);assert.throws(()=>f.lifecycle.promote(f.a.id,body),new RegExp(reason));assert.throws(()=>f.lifecycle.clean({confirm:true}),new RegExp(reason));assert.equal(f.lifecycle.tick(),null);assert.ok(f.store.readProject('freetalk').tasks.length);}
 f.busy('');f.lifecycle.operating=true;assert.throws(()=>f.lifecycle.clean({confirm:true}),/途中/);assert.equal(f.lifecycle.tick(),null);f.lifecycle.operating=false;assert.equal(f.lifecycle.tick().ok,true);assert.equal(f.store.readProject('freetalk').tasks.length,0);
});
test('7日前/前日案内、期限前自動掃除なし、手動成功から期限更新',t=>{
 const f=fixture(t);for(const [day,notice,days] of [['2026-02-20T12:30:00',false,8],['2026-02-21T12:30:00',true,7],['2026-02-27T12:30:00',true,1]]){f.date(day);const s=f.lifecycle.status();assert.equal(s.notice,notice);assert.equal(s.days,days);assert.equal(f.lifecycle.tick(),null);}
 f.date('2026-02-27T12:30:00');assert.throws(()=>f.lifecycle.clean({}),/確認/);f.lifecycle.clean({confirm:true});assert.equal(new Date(f.lifecycle.status().due).getDate(),27);assert.equal(new Date(f.lifecycle.status().due).getMonth(),2);
});
test('掃除は許可設定と最小管理だけ保持、隠し物/共通物/メモリも退避し外側を保護',t=>{
 const f=fixture(t),{ft,lifecycle:l}=f;for(const rel of SETTINGS)fs.appendFileSync(path.join(ft.dir,rel),rel.endsWith('.json')?'':'\n人の設定');
 // marker JSONは改変しない。
 write(path.join(ft.dir,'.hidden'),'隠し物');write(path.join(ft.dir,'.ai/private.json'),'秘密以外の一時物');write(path.join(ft.ledger,'.ai/memory/old.txt'),'古い記録');write(path.join(ft.ledger,'成果物/old.txt'),'一時成果');
 const external=path.join(f.tmp,'external');write(external,'外側');fs.symlinkSync(external,path.join(ft.dir,'外のリンク'));
 const before=SETTINGS.map(rel=>[rel,fs.readFileSync(path.join(ft.dir,rel))]);l.clean({confirm:true});
 for(const [rel,data]of before)assert.deepEqual(fs.readFileSync(path.join(ft.dir,rel)),data);
 assert.deepEqual(tree(ft.dir).map(r=>r[0]).sort(),SETTINGS.slice().sort());assert.deepEqual(tree(ft.ledger).map(r=>r[0]).sort(),['.ai/freetalk-maintenance.json','PROJECT.md']);assert.equal(fs.readFileSync(external,'utf8'),'外側');
 assert.equal(ft.verify().kind,'freetalk');
});
test('プロジェクト化の各書込/移動失敗は元台帳・資料を完全保持',t=>{
 // 非注入成功で経路を数え、その全書込/rename箇所で1回だけ失敗させる。
 const methods=['writeFileSync','renameSync','copyFileSync'];let count=0;
 {const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));for(const m of methods)fs[m]=(...args)=>{count++;return orig[m](...args);};try{f.lifecycle.promote(f.a.id,body);}finally{for(const m of methods)fs[m]=orig[m];}}
 for(let at=1;at<=count;at++){
  const f=fixture(t);write(path.join(f.ft.dir,'test.txt'),'元');const body=approved(f),before=tree(f.ft.ledger),docs=tree(f.ft.dir),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));let n=0;
  for(const m of methods)fs[m]=(...args)=>{if(++n===at)throw Error('injected EIO '+at);return orig[m](...args);};
  try{assert.throws(()=>f.lifecycle.promote(f.a.id,body));}finally{for(const m of methods)fs[m]=orig[m];}
  assert.deepEqual(tree(f.ft.ledger),before,'台帳 '+at);assert.deepEqual(tree(f.ft.dir),docs,'資料 '+at);assert.equal(f.store.listProjects().length,1,'別プロジェクト未作成 '+at);assert.equal(f.lifecycle.operating,false);
 }
});
test('掃除の各書込/移動失敗は設定と全話題を完全保持し期限不変',t=>{
 const methods=['writeFileSync','renameSync'];let count=0;
 {const f=fixture(t);const orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));for(const m of methods)fs[m]=(...args)=>{count++;return orig[m](...args);};try{f.lifecycle.clean({confirm:true});}finally{for(const m of methods)fs[m]=orig[m];}}
 for(let at=1;at<=count;at++){
  const f=fixture(t),before=tree(f.ft.ledger),docs=tree(f.ft.dir),orig=Object.fromEntries(methods.map(m=>[m,fs[m]]));let n=0;
  for(const m of methods)fs[m]=(...args)=>{if(++n===at)throw Error('injected EIO '+at);return orig[m](...args);};
  try{assert.throws(()=>f.lifecycle.clean({confirm:true}));}finally{for(const m of methods)fs[m]=orig[m];}
  assert.deepEqual(tree(f.ft.ledger),before,'台帳 '+at);assert.deepEqual(tree(f.ft.dir),docs,'資料 '+at);assert.equal(f.lifecycle.operating,false);
 }
});
test('話題削除：その話題の記録・添付・メモリだけをゴミ箱へ、他の話題・設定・共通相談は残す',t=>{
 const f=fixture(t),{ft,a,b,history:h,lifecycle:l,store}=f;
 const own=ft.upload(a.id,'写真.txt',Buffer.from('写真')),other=ft.upload(b.id,'他.txt',Buffer.from('他'));write(path.join(ft.dir,'相談.txt'),'共通');
 write(path.join(ft.dir,'topics',a.id,'.ai/memory.md'),'話題メモリ');chat.append(ft.ledger,a.id,{role:'user',text:'消す会話'});chat.writeMeta(ft.ledger,a.id,{sessions:{codex:'old'}});
 chat.append(ft.ledger,b.id,{role:'user',text:'残す会話'});h.save(a.id,{generation:2});
 for(const dir of ['handoff','memory','work'])write(path.join(ft.ledger,'.ai',dir,a.id+'.md'),dir);write(path.join(ft.ledger,'.ai/memory',b.id+'.md'),'残す');
 assert.throws(()=>l.remove(a.id),/確認/);f.busy('AIが作業中です');assert.throws(()=>l.remove(a.id,{confirm:true}),/作業中/);f.busy('');
 const r=l.remove(a.id,{confirm:true});assert.equal(r.ok,true);assert.ok(r.trash.startsWith(path.join(ft.home,'.Trash')));
 assert.deepEqual(store.readProject('freetalk').tasks.map(t=>t.id),[b.id]);
 for(const file of [own,path.join(ft.dir,'topics',a.id),h.file(a.id),...Object.values(chat.files(ft.ledger,a.id)),...['handoff','memory','work'].map(d=>path.join(ft.ledger,'.ai',d,a.id+'.md'))])assert.equal(fs.existsSync(file),false,file);
 for(const file of [other,path.join(ft.dir,'相談.txt'),path.join(ft.ledger,'.ai/memory',b.id+'.md'),chat.files(ft.ledger,b.id).log,...SETTINGS.map(s=>path.join(ft.dir,s)).filter(s=>!s.endsWith('GEMINI.md'))])assert.ok(fs.existsSync(file),file);
 assert.equal(JSON.parse(fs.readFileSync(path.join(r.trash,'manifest.json'),'utf8')).task,a.id);
 assert.throws(()=>l.remove(a.id,{confirm:true}),/見つかりません/);
});
test('話題削除：移動に失敗したら移した分を元へ戻す',t=>{
 const f=fixture(t),{ft,a,lifecycle:l,store}=f;chat.append(ft.ledger,a.id,{role:'user',text:'残る会話'});const own=ft.upload(a.id,'写真.txt',Buffer.from('写真'));
 const rename=fs.renameSync;let n=0;fs.renameSync=(from,to)=>{if(++n===3)throw Error('移動できない');return rename(from,to);};
 try{assert.throws(()=>l.remove(a.id,{confirm:true}),/削除に失敗し、元の話題を保持/);}finally{fs.renameSync=rename;}
 assert.ok(store.readProject('freetalk').tasks.some(t=>t.id===a.id));assert.equal(chat.read(ft.ledger,a.id)[0].text,'残る会話');assert.ok(fs.existsSync(own));
});
