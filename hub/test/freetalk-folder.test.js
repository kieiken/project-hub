'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {Store}=require('../lib/store'),{Freetalk}=require('../lib/freetalk'),{FreetalkHistory}=require('../lib/freetalk-history'),{FreetalkLifecycle}=require('../lib/freetalk-lifecycle');
const {FreetalkAttachments}=require('../lib/freetalk-attachments'),chat=require('../lib/chat'),qe=require('../lib/queue-edit');
function fixture(t){
 const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-ft-folder-')));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const store=new Store(path.join(tmp,'root')),ft=new Freetalk(store,path.join(tmp,'home'));assert.equal(ft.ensure().ready,true);
 const a=ft.createTopic({ai:'codex',model:'GPT-6.1-Sol'}),h=new FreetalkHistory(ft),l=new FreetalkLifecycle(h),x=new FreetalkAttachments(ft);
 const source=path.join(ft.home,'Gate database'),file=path.join(source,'original.txt');fs.mkdirSync(source);fs.writeFileSync(file,'original folder sentinel');
 const before=fs.statSync(file),dirBefore=fs.statSync(source);
 const preserved=()=>{
  assert.equal(fs.readFileSync(file,'utf8'),'original folder sentinel');
  const st=fs.statSync(file),dir=fs.statSync(source);assert.equal(st.ino,before.ino);assert.equal(st.mtimeMs,before.mtimeMs);assert.equal(dir.ino,dirBefore.ino);assert.equal(dir.mtimeMs,dirBefore.mtimeMs);
 };
 return {tmp,store,ft,a,h,l,x,source,file,preserved};
}
function summary(f,options){
 chat.append(f.ft.ledger,f.a.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'synthetic reply'});
 const r=f.h.prepareSummary(f.a.id,options);chat.append(f.ft.ledger,f.a.id,{role:'user',text:r.text});chat.append(f.ft.ledger,f.a.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'synthetic summary'});
 return f.h.status(f.a.id);
}
function ui(){
 const context=vm.createContext({UI:{text:x=>x,template:(s,...v)=>s.reduce((r,x,i)=>r+x+(v[i]??''),'')},esc:x=>String(x),view:{kind:'work',project:'freetalk',task:'t'},nativeDropTickets:new Map(),document:{querySelector:()=>null},chatAttachments:new Map(),chatAttachmentKey:(p,t)=>p+'|'+t});
 for(const name of ['app-composer.js','app-files.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',name),'utf8'),context);
 context.drawChatImages=()=>{};return context;
}
test('folder reference stores only its descriptor, never extracts contents, counts toward 20 and preserves the source on discard',async t=>{
 const f=fixture(t),{x,a,source}=f;
 x.video=()=>{throw Error('must not extract');};x.platform={readArchive(){throw Error('must not extract');}};
 const r=await x.fromPath(a.id,source,1);assert.equal(r.storage,'reference');assert.equal(r.media,'folder');assert.equal(r.kind,'file');assert.equal(r.path,source);assert.equal(r.name,'Gate database');assert.match(r.message,/コピーではなく元のフォルダ/);
 assert.deepEqual(x.descriptor(a.id,r.id),r);assert.deepEqual(x.images(a.id,[r.id]),[]);assert.throws(()=>x.preview(a.id,r.id));
 assert.deepEqual(fs.readdirSync(x.derived(a.id,r.id)),['attachment.json']);assert.deepEqual(fs.readdirSync(x.base(a.id)),['.derived']);
 assert.deepEqual(x.images(a.id,Array(20).fill(r.id)),[]);assert.throws(()=>x.images(a.id,Array(21).fill(r.id)),/正しくありません/);
 x.discard(a.id,r);assert.equal(fs.existsSync(x.derived(a.id,r.id)),false);f.preserved();
});
test('folder accepts temp paths without traversing contents or applying copy limits; refuses invalid paths, links and special files',async t=>{
 const f=fixture(t),{x,a,tmp,source}=f;await x.fromPath(a.id,source,1);
 const dir=path.join(tmp,'large.mov');fs.mkdirSync(dir);const huge=path.join(dir,'huge');fs.writeFileSync(huge,'');fs.truncateSync(huge,300*1024*1024);
 fs.symlinkSync(source,path.join(dir,'inside-link'));assert.equal((await x.fromPath(a.id,dir,1)).media,'folder');
 for(const raw of [path.join(tmp,'absent'),'relative','/usr'])await assert.rejects(x.fromPath(a.id,raw,1));
 const link=path.join(tmp,'link');fs.symlinkSync(source,link);await assert.rejects(x.fromPath(a.id,link,1),/リンク/);await assert.rejects(x.fromPath(a.id,path.join(link,'original.txt'),1),/リンク/);
 const pipe=path.join(tmp,'pipe');require('node:child_process').execFileSync('/usr/bin/mkfifo',[pipe]);await assert.rejects(x.fromPath(a.id,pipe,1),/特殊/);
 const r=await x.fromPath(a.id,source,1);fs.renameSync(source,source+'-kept');fs.symlinkSync(source+'-kept',source);assert.throws(()=>x.descriptor(a.id,r.id),/リンク/);
 x.discard(a.id,r);assert.equal(fs.readFileSync(path.join(source+'-kept','original.txt'),'utf8'),'original folder sentinel');
});
test('folder descriptor rejects forged external/image paths and a directory replaced by a file',async t=>{
 const f=fixture(t),r=await f.x.fromPath(f.a.id,f.source,1),meta=path.join(f.x.derived(f.a.id,r.id),'attachment.json');
 for(const patch of [{referencePaths:['/usr']},{imagePath:f.file},{path:'/usr',referencePaths:['/usr'],name:'usr'}]){
  fs.writeFileSync(meta,JSON.stringify({...r,...patch}));assert.throws(()=>f.x.descriptor(f.a.id,r.id));
 }
 fs.writeFileSync(meta,JSON.stringify(r));fs.renameSync(f.source,f.source+'-kept');fs.writeFileSync(f.source,'not a folder');assert.throws(()=>f.x.descriptor(f.a.id,r.id));
 assert.equal(fs.readFileSync(path.join(f.source+'-kept','original.txt'),'utf8'),'original folder sentinel');
});
test('descriptor write failure removes only metadata and preserves the original folder',async t=>{
 const f=fixture(t),write=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(file,...args)=>{if(String(file).endsWith('/attachment.json'))throw Error('injected descriptor failure');return write(file,...args);});
 await assert.rejects(f.x.fromPath(f.a.id,f.source,1),/injected/);f.preserved();assert.deepEqual(fs.readdirSync(path.join(f.x.base(f.a.id),'.derived')),[]);
});
for(const action of ['clear','summary-continue','remove','manual-clean','automatic-clean','promote','automatic-promote'])test('folder source survives '+action,async t=>{
 const f=fixture(t),r=await f.x.fromPath(f.a.id,f.source,1),{a,h,l}=f;
 if(action==='clear')h.rotate(a.id,{confirm:true,revision:h.revision(a.id)});
 if(action==='summary-continue'){const s=summary(f);h.rotate(a.id,{confirm:true,revision:s.revision,summaryId:s.summaryId,summary:s.draft});assert.equal(f.x.descriptor(a.id,r.id).path,f.source);}
 if(action==='remove')l.remove(a.id,{confirm:true});
 if(action==='manual-clean')l.clean({confirm:true});
 if(action==='automatic-clean'){l.save({lastClean:'2000-01-01',due:'2000-02-01'});assert.equal(l.tick().ok,true);}
 if(action==='promote'){
  summary(f);const p=l.preview(a.id);assert.deepEqual(p.files,[]);
  const result=l.promote(a.id,{...p,name:'Synthetic project',summary:p.summary,files:[],confirm:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.store.readProject(result.project).dir,'資料/ファイル移行.json'))),[]);
  l.remove(a.id,{confirm:true});
 }
 if(action==='automatic-promote'){
  summary(f,{intent:'promote',automatic:true});const result=l.completeAutomatic(a.id);assert.ok(result?.sourceTrash);assert.equal(f.store.taskFile('freetalk',a.id),null);
 }
 f.preserved();if(action!=='summary-continue')assert.equal(fs.existsSync(path.join(f.ft.dir,'topics',a.id,'.derived',r.id)),false);
});
test('folder chip, cancellation and trusted queued draft carry the original location and reference explanation',async t=>{
 const f=fixture(t),r=await f.x.fromPath(f.a.id,f.source,1),c=ui();
 const html=c.attachmentImagesHtml([r]);assert.match(html,/📁/);assert.ok(html.includes('Gate database'));assert.ok(html.includes('data-chat-remove="'+r.id+'"'));assert.doesNotMatch(html,/<img/);
 const text=c.chatSendText('check folder',[r]);assert.equal(text,qe.format('check folder',[r]));assert.ok(text.includes(f.source));assert.match(text,/コピーではなく元のフォルダ/);
 const draft=qe.accept({id:'freetalk',kind:'freetalk'},f.a.id,{text:'check folder',attachments:[{...r,path:'/forged'}]},text,f.x);assert.equal(draft.attachments[0].path,f.source);
 c.chatImages('freetalk','t').push(r);c.removeChatImage('freetalk','t',r.id);assert.equal(c.chatImages('freetalk','t').length,0);f.preserved();
});
test('browser folder drop gives an actionable refusal without uploading or retaining a folder chip',()=>{
 const c=ui(),messages=[];c.toast=m=>messages.push(m);c.sendFiles=()=>assert.fail('must not upload pathless folder');
 c.appFilesCallback4430()({preventDefault(){},dataTransfer:{files:[{name:'Gate database',size:0,type:''}],items:[{webkitGetAsEntry:()=>({isDirectory:true})}]}});
 assert.equal(messages.length,1);assert.match(messages[0],/ブラウザではフォルダの場所を渡せません/);assert.match(messages[0],/アプリの窓/);
});
test('folder reference and browser refusal are translated in English and Traditional Chinese with placeholders intact',()=>{
 const sources=['フォルダの参照です。コピーではなく元のフォルダを読みます。','フォルダを渡した（参照・コピーなし）: ${0}'];
 for(const lang of ['en','zh-TW']){
  const base=path.join(__dirname,'../../langpacks',lang),backend=JSON.parse(fs.readFileSync(path.join(base,'backend.json'))).messages,dict=JSON.parse(fs.readFileSync(path.join(base,'ui.json')));
  for(const key of sources){assert.equal(typeof backend[key],'string');assert.notEqual(backend[key],key);assert.deepEqual(backend[key].match(/\$\{\d+\}/g),key.match(/\$\{\d+\}/g));}
  const c=ui(),messages=[];c.UI.text=key=>{assert.ok(dict[key]);return dict[key];};c.toast=m=>messages.push(m);
  c.appFilesCallback4430()({preventDefault(){},dataTransfer:{items:[{webkitGetAsEntry:()=>({isDirectory:true})}]}});assert.equal(messages.length,1);assert.doesNotMatch(messages[0],/[\u3041-\u3096\u30a1-\u30fa]/);
 }
});
