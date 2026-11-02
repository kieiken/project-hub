'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Freetalk}=require('../lib/freetalk'),{FreetalkHistory}=require('../lib/freetalk-history'),{FreetalkLifecycle}=require('../lib/freetalk-lifecycle');
const {FreetalkAttachments,PACKAGE_LIMIT,xmlText}=require('../lib/freetalk-attachments'),chat=require('../lib/chat');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ft-attachments-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const ft=new Freetalk(new Store(path.join(tmp,'root')),path.join(tmp,'home'));assert.equal(ft.ensure().ready,true);
 const a=ft.createTopic({ai:'codex',model:'GPT-6.1-Sol'}),b=ft.createTopic({ai:'codex',model:'GPT-6.1-Sol'});
 const h=new FreetalkHistory(ft),l=new FreetalkLifecycle(h),attachments=new FreetalkAttachments(ft);
 return {tmp,ft,a,b,h,l,attachments};
}
function zip(tmp,name,entries){
 const dir=path.join(tmp,name+'-source');fs.mkdirSync(dir);
 for(const [n,data]of Object.entries(entries)){const f=path.join(dir,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);}
 const file=path.join(tmp,name);execFileSync('/usr/bin/zip',['-q','-r',file,'.'],{cwd:dir});return fs.readFileSync(file);
}
function pdf(text='') {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const stream=text ? 'BT /F1 12 Tf 10 100 Td ('+text+') Tj ET' : '';
 objects.push('<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream');
 let out='%PDF-1.4\n',offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(out));out+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';}
 const xref=Buffer.byteLength(out);out+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(out);
}
test('文字・画像・ネイティブ原本は話題コピーだけを参照し、別話題やリンクを配信しない',async t=>{
 const {tmp,ft,a,b,attachments:x}=fixture(t),source=path.join(tmp,'原本.txt');fs.writeFileSync(source,'元資料');
 const file=await x.fromPath(a.id,source,1);assert.equal(file.status,'ok');assert.notEqual(file.path,source);assert.equal(fs.readFileSync(file.path,'utf8'),'元資料');assert.ok(!JSON.stringify(file).includes(source));
 const image=await x.upload(a.id,'../写真.png',png,1);assert.deepEqual(x.preview(a.id,image.id).data,png);assert.throws(()=>x.preview(b.id,image.id));
 assert.throws(()=>x.preview(a.id,'../outside'));assert.equal(x.images(a.id,[file.id,image.id])[0],image.path);
 fs.unlinkSync(image.path);fs.symlinkSync(source,image.path);assert.throws(()=>x.preview(a.id,image.id),/リンク/);assert.equal(fs.readFileSync(source,'utf8'),'元資料');
 assert.ok(file.path.startsWith(path.join(ft.dir,'topics',a.id)+path.sep));
});
test('PDFKitは本文を抽出、空・破損PDFは参照成功にせず、原本コピーを保持',{skip:process.env.HUB_TEST_OS_ISOLATION==='macos-v1'?'試験の認証/UI遮断はPDFKitのosascriptも拒否するため、実PDF読取は未確認':false},async t=>{
 const {a,attachments:x}=fixture(t);
 const good=await x.upload(a.id,'本文.pdf',pdf('Local PDF sentinel'),1);assert.equal(good.status,'ok');assert.match(fs.readFileSync(good.referencePaths[1],'utf8'),/Local PDF sentinel/);
 const empty=await x.upload(a.id,'空.pdf',pdf(),1);assert.equal(empty.status,'unsupported');assert.match(empty.message,/画像のみ/);assert.equal(empty.referencePaths.length,1);
 const broken=await x.upload(a.id,'壊れた.pdf',Buffer.from('not a pdf'),1);assert.equal(broken.status,'unsupported');assert.match(broken.message,/抽出できません/);assert.ok(fs.existsSync(broken.path));
});
test('PPTXは数値順のスライド文字とノートを抽出、画像だけ・破損は未対応',async t=>{
 const {tmp,a,attachments:x}=fixture(t);
 const data=zip(tmp,'slides.pptx',{'ppt/slides/slide10.xml':'<a:t>ten</a:t>','ppt/slides/slide2.xml':'<a:t>two &amp; &#x65E5;</a:t>','ppt/notesSlides/notesSlide2.xml':'<a:t>speaker note</a:t>','docProps/thumbnail.png':png});
 const result=await x.upload(a.id,'slides.pptx',data,1);assert.equal(result.status,'partial');const text=fs.readFileSync(result.referencePaths[1],'utf8');assert.match(text,/speaker note/);assert.ok(text.indexOf('two & 日')<text.indexOf('ten'));assert.deepEqual(x.preview(a.id,result.id).data,png);
 const blank=await x.upload(a.id,'blank.pptx',zip(tmp,'blank.pptx',{'ppt/slides/slide1.xml':'<p:pic />'}),1);assert.equal(blank.status,'unsupported');
 const broken=await x.upload(a.id,'broken.pptx',Buffer.from('invalid'),1);assert.equal(broken.status,'unsupported');
 assert.equal(xmlText('<a:t>A &lt; B &quot;Q&quot; &#65;</a:t>'),'A < B "Q" A');
});
test('PPTXの文字抽出は閉じのない開始タグが大量でも入力長に比例する時間で終わる',()=>{
 assert.equal(xmlText('<a:tab/><a:t xml:space="preserve">A<![CDATA[<b>]]></a:t><a:t>B</a:t><a:t>open'),'A<b>\nB');
 const n=200000,started=Date.now();
 assert.equal(xmlText('<a:t>'.repeat(n)),'');assert.equal(xmlText('<a:t '.repeat(n)),'');
 assert.equal(xmlText('<a:t>'+'<![CDATA['.repeat(n)+'</a:t>'),'<![CDATA['.repeat(n));
 assert.ok(Date.now()-started<5000);
});
test('Keynoteのzip/パッケージはプレビューのみ、本文非対応を表示、リンク・特殊・容量超過拒否',async t=>{
 const {tmp,ft,a,attachments:x}=fixture(t);
 const archive=await x.upload(a.id,'deck.key',zip(tmp,'deck.key',{'preview.png':png,'Index/Document.iwa':'opaque'}),1);assert.equal(archive.status,'unsupported');assert.match(archive.message,/PDFかPPTX/);assert.deepEqual(x.preview(a.id,archive.id).data,png);
 const pkg=path.join(tmp,'package.key');fs.mkdirSync(pkg);fs.writeFileSync(path.join(pkg,'preview.png'),png);fs.mkdirSync(path.join(pkg,'Index'));fs.writeFileSync(path.join(pkg,'Index/Document.iwa'),'original');
 const copied=await x.fromPath(a.id,pkg,1);assert.equal(copied.status,'unsupported');assert.deepEqual(x.preview(a.id,copied.id).data,png);assert.equal(fs.readFileSync(path.join(copied.path,'Index/Document.iwa'),'utf8'),'original');
 fs.symlinkSync(path.join(pkg,'preview.png'),path.join(pkg,'link'));await assert.rejects(x.fromPath(a.id,pkg,1),/リンク/);fs.unlinkSync(path.join(pkg,'link'));
 const large=path.join(pkg,'large');fs.closeSync(fs.openSync(large,'w'));fs.truncateSync(large,PACKAGE_LIMIT+1);await assert.rejects(x.fromPath(a.id,pkg,1),/256MB/);fs.unlinkSync(large);
 execFileSync('/usr/bin/mkfifo',[path.join(pkg,'pipe')]);await assert.rejects(x.fromPath(a.id,pkg,1),/特殊/);
 assert.equal(fs.readFileSync(path.join(pkg,'Index/Document.iwa'),'utf8'),'original');assert.equal(fs.readdirSync(path.join(ft.dir,'topics',a.id)).filter(n=>!n.startsWith('.')).length,2);
});
test('変換成功はPNG参照、失敗は自分のコピーと派生のみ片付ける',async t=>{
 const {tmp,ft,a,attachments:x}=fixture(t),source=path.join(tmp,'input.png'),gif=path.join(tmp,'input.gif');fs.writeFileSync(source,png);execFileSync('/usr/bin/sips',['-s','format','gif',source,'--out',gif],{stdio:'pipe'});
 const good=await x.fromPath(a.id,gif,1);assert.match(good.imagePath,/\.derived.*image\.png$/);assert.equal(good.path,good.imagePath);assert.match(x.preview(a.id,good.id).type,/png/);
 const before=fs.readdirSync(path.join(ft.dir,'topics',a.id)).sort(),derived=fs.readdirSync(path.join(ft.dir,'topics',a.id,'.derived')).sort();await assert.rejects(x.upload(a.id,'bad.heic',Buffer.from('invalid'),1),/PNG/);
 assert.deepEqual(fs.readdirSync(path.join(ft.dir,'topics',a.id)).sort(),before);assert.deepEqual(fs.readdirSync(path.join(ft.dir,'topics',a.id,'.derived')).sort(),derived);assert.ok(fs.existsSync(gif));
});
test('長いファイル名でも画像の拡張子を維持し、派生保存先のリンクはコピーを残さず拒否',async t=>{
 const {tmp,ft,a,attachments:x}=fixture(t);
 const image=await x.upload(a.id,'長'.repeat(100)+'.png',png,1);assert.equal(image.status,'ok');assert.equal(image.kind,'image');assert.match(image.path,/\.png$/);
 const derived=path.join(ft.dir,'topics',a.id,'.derived');fs.renameSync(derived,derived+'-kept');const outside=path.join(tmp,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,derived);
 const before=fs.readdirSync(path.join(ft.dir,'topics',a.id)).sort();await assert.rejects(x.upload(a.id,'rejected.txt',Buffer.from('copy'),1),/リンク/);assert.deepEqual(fs.readdirSync(path.join(ft.dir,'topics',a.id)).sort(),before);assert.deepEqual(fs.readdirSync(outside),[]);
});
test('アップロード保持中はクリア・削除・手動/自動掃除を拒否し、別話題のクリアは可能',t=>{
 const {ft,a,b,h,l}=fixture(t),release=ft.holdUpload(a.id,1);l.save({lastClean:'2000-01-01',due:'2000-02-01'});
 assert.throws(()=>h.rotate(a.id,{confirm:true,revision:h.revision(a.id)}),/追加中/);assert.throws(()=>l.remove(a.id,{confirm:true}),/追加中/);assert.throws(()=>l.clean({confirm:true}),/追加中/);assert.equal(l.tick(),null);
 assert.equal(h.rotate(b.id,{confirm:true,revision:h.revision(b.id)}).generation,2);release();release();assert.equal(ft.uploadReason(),'');assert.equal(l.tick().ok,true);
});
test('世代必須・移行済み拒否、要約継続は添付保持、クリア/削除/掃除は派生も退避',async t=>{
 const f=fixture(t),{ft,a,b,h,l,attachments:x}=f,own=await x.upload(a.id,'image.png',png,1),other=await x.upload(b.id,'note.txt',Buffer.from('other'),1);
 await assert.rejects(x.upload(a.id,'late.txt',Buffer.from('late'),undefined),/切り替わり/);
 chat.append(ft.ledger,a.id,{role:'assistant',ai:'codex',model:'GPT-6.1-Sol',text:'reply'});const request=h.prepareSummary(a.id);chat.append(ft.ledger,a.id,{role:'user',text:request.text});chat.append(ft.ledger,a.id,{role:'assistant',text:'summary'});
 const state=h.status(a.id);h.rotate(a.id,{confirm:true,revision:state.revision,summaryId:state.summaryId,summary:'approved'});assert.ok(fs.existsSync(own.path));assert.deepEqual(x.preview(a.id,own.id).data,png);
 await assert.rejects(x.upload(a.id,'late.txt',Buffer.from('late'),1),/切り替わり/);
 const settings=fs.readFileSync(path.join(ft.dir,'AGENTS.md')),r=h.rotate(a.id,{confirm:true,revision:h.revision(a.id)});assert.equal(fs.existsSync(own.path),false);assert.ok(fs.existsSync(other.path));
 const moved=JSON.parse(fs.readFileSync(path.join(r.trash,'manifest.json'))).moved.find(x=>x.target===path.join(ft.dir,'topics',a.id));assert.ok(fs.existsSync(path.join(moved.dest,'.derived',own.id,'attachment.json')));
 h.save(b.id,{generation:1,migrated:{project:'protected'}});await assert.rejects(x.upload(b.id,'bad.txt',Buffer.from('bad'),1),/移行済み/);
 l.remove(b.id,{confirm:true});assert.equal(fs.existsSync(other.path),false);assert.deepEqual(fs.readFileSync(path.join(ft.dir,'AGENTS.md')),settings);
});
test('移動後の新世代保存が失敗すると添付と派生を含め元へ復元する',async t=>{
 const {a,h,attachments:x}=fixture(t),file=await x.upload(a.id,'image.png',png,1);h.save=()=>{throw Error('injected save');};assert.throws(()=>h.rotate(a.id,{confirm:true,revision:h.revision(a.id)}),/元の会話を保持/);assert.deepEqual(x.preview(a.id,file.id).data,png);assert.equal(h.state(a.id).generation,1);
});
test('プロジェクト化の候補は原本だけで派生を含めない、掃除で全コピーを退避する',async t=>{
 const {ft,a,b,l,attachments:x}=fixture(t),file=await x.upload(a.id,'slides.pptx',Buffer.from('invalid'),1),other=await x.upload(b.id,'note.txt',Buffer.from('other'),1);
 assert.deepEqual(l.files(a.id).map(f=>path.join(ft.dir,f.path)),[file.path]);const r=l.clean({confirm:true});assert.equal(fs.existsSync(file.path),false);assert.equal(fs.existsSync(other.path),false);
 const moved=JSON.parse(fs.readFileSync(path.join(r.trash,'manifest.json'))).planned.find(x=>x.from===path.join(ft.dir,'topics'));assert.ok(fs.existsSync(path.join(moved.to,a.id,'.derived',file.id,'attachment.json')));
});
