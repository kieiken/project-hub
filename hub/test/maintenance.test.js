'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Store}=require('../lib/store');
const {Maintenance,scriptsAt}=require('../lib/maintenance');
const DAY=86400000;
function fixture(t,opts={}) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-maint-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product','P');fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: P\nstatus: 進行中\nfolders: {}\nrelated: []\nphases: []\n---\n');
 const store=new Store(root),trash=path.join(root,'Trash');let busy=false;
 const m=new Maintenance({store,baseOf:p=>p.dir,trash,busy:()=>busy,timeout:5000,...opts});
 function old(rel,data='fixture') {const f=path.join(dir,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);const when=new Date(Date.now()-40*DAY);fs.utimesSync(f,when,when);return f;}
 return {root,dir,store,trash,m,old,busy:v=>busy=v};
}
test('preview protects recent, referenced, tracked, symlink and original material files',t=>{
 const f=fixture(t),keep=f.old('.ai/work/referenced.dat'),safe=f.old('.ai/work/unused.dat');
 f.old('作業/versions/old-version.dat');f.old('資料/original.dat');f.old('成果物/result.dat');
 f.old('.ai/memory/memory.md');const tracked=f.old('.ai/work/tracked.dat');
 fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\nReference '+keep+'\n');
 const recent=path.join(f.dir,'.ai/work/recent.dat');fs.writeFileSync(recent,'recent');
 fs.symlinkSync(safe,path.join(f.dir,'.ai/work/link.dat'));
 execFileSync('git',['init','-q',f.dir]);execFileSync('git',['-C',f.dir,'add',tracked]);
 const d=f.m.preview('P');assert.equal(d.candidates.length,2);assert.ok(d.candidates.some(c=>c.paths.includes(safe)));
 assert.equal(d.excluded.length,4);assert.ok(d.excluded.some(e=>e.reason.includes('Git')));assert.ok(d.excluded.some(e=>e.reason.includes('参照')));
});
test('cleanup requires explicit choices, rechecks content/reference/busy and restores exact content',t=>{
 const f=fixture(t),file=f.old('.ai/work/unused.dat','original');let d=f.m.preview('P');
 assert.throws(()=>f.m.apply('P',d.token,[],true),/選び直/);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],false),/選び直/);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id,d.candidates[0].id],true),/選び直/);
 f.busy(true);assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/動いて/);f.busy(false);
 fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\nReference unused.dat');
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/参照が変わ/);
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),'---\nname: P\nstatus: 進行中\nfolders: {}\n---\n');
 d=f.m.preview('P');const r=f.m.apply('P',d.token,[d.candidates[0].id],true);assert.equal(r.ok,true);assert.equal(fs.existsSync(file),false);
 assert.equal(f.m.history('P')[0].count,1);
 assert.equal(f.m.restore('P',r.id,true).restored,1);assert.equal(fs.readFileSync(file,'utf8'),'original');
 assert.equal(f.m.history('P')[0].restored,true);
});
test('restore refuses overwrite, tampered trash, missing trash and path traversal',t=>{
 const f=fixture(t),file=f.old('.ai/work/old.dat');const d=f.m.preview('P'),r=f.m.apply('P',d.token,[d.candidates[0].id],true);
 const rf=path.join(f.m.records,r.id+'.json'),record=JSON.parse(fs.readFileSync(rf));
 fs.writeFileSync(file,'new');assert.throws(()=>f.m.restore('P',r.id,true),/上書き/);fs.unlinkSync(file);
 const original=record.entries[0].src;record.entries[0].src=path.join(f.dir,'.ai/work')+'/../../PROJECT.md';fs.writeFileSync(rf,JSON.stringify(record));
 assert.throws(()=>f.m.restore('P',r.id,true),/パスが不正/);record.entries[0].src=original;fs.writeFileSync(rf,JSON.stringify(record));
 fs.appendFileSync(record.entries[0].dest,'tamper');assert.throws(()=>f.m.restore('P',r.id,true),/中身が変わ/);
 fs.unlinkSync(record.entries[0].dest);assert.throws(()=>f.m.restore('P',r.id,true),/復元用/);
});
test('only approved completed chat history is eligible, queued and referenced histories are protected',t=>{
 const f=fixture(t),task=f.store.createTask('P',{title:'Done'});let t1=f.store.decideTask('P',task.id,'approve',task.completionHash);
 const chat=f.old('.ai/chat/'+task.id+'.jsonl','history');f.old('.ai/chat/'+task.id+'.queue.json','[]');
 assert.equal(f.m.preview('P').candidates.length,1);
 f.old('.ai/chat/'+task.id+'.queue.json','[{"text":"next"}]');assert.equal(f.m.preview('P').candidates.length,0);
 f.old('.ai/chat/'+task.id+'.queue.json','[]');fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\n'+chat);assert.equal(f.m.preview('P').candidates.length,0);
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),'---\nname: P\n---\n');
 f.store.decideTask('P',t1.id,'continue',t1.completionHash);assert.equal(f.m.preview('P').candidates.length,0);
});
test('changed eligible content rejects a stale cleanup token',t=>{
 const f=fixture(t);const file=f.old('.ai/work/stale.dat'),d=f.m.preview('P');
 fs.writeFileSync(file,'changed');const when=new Date(Date.now()-40*DAY);fs.utimesSync(file,when,when);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/変わりました/);assert.equal(fs.readFileSync(file,'utf8'),'changed');
});
test('partial move retains a transaction and allows recovery of successful moves',t=>{
 const f=fixture(t);f.old('.ai/work/a.dat');f.old('.ai/work/b.dat');const d=f.m.preview('P'),original=fs.renameSync;
 fs.renameSync=(src,dst)=>{if(src.endsWith('/b.dat')){const e=Error('fixture');e.code='EXDEV';throw e;}return original(src,dst);};
 let r;try {r=f.m.apply('P',d.token,d.candidates.map(c=>c.id),true);}finally{fs.renameSync=original;}
 assert.equal(r.ok,false);assert.equal(r.moved,1);assert.equal(f.m.restore('P',r.id,true).restored,1);assert.equal(f.m.history('P')[0].restored,true);
});
test('verification runs only confirmed existing scripts, skips npm hooks and locks AI launch until finished',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'test.cjs'),'setTimeout(()=>console.log("fixture passed"),50)');
 fs.writeFileSync(path.join(f.dir,'hook.cjs'),'require("fs").writeFileSync("hook-ran","bad")');
 const pkg=path.join(f.dir,'package.json');fs.writeFileSync(pkg,JSON.stringify({scripts:{test:'node test.cjs',pretest:'node hook.cjs',posttest:'node hook.cjs',build:'curl example.invalid'}}));
 const s=scriptsAt(f.dir);assert.equal(s.find(x=>x.name==='build').allowed,false);
 assert.equal((await f.m.verify('P','','',false)).ok,true);
 await assert.rejects(()=>f.m.verify('P','test','stale',true),/選び直/);
 await assert.rejects(()=>f.m.verify('P','test',s[0].hash,false),/選び直/);
 const pending=f.m.verify('P','test',s[0].hash,true);assert.equal(f.m.locked('P'),true);assert.throws(()=>f.m.apply('P','bad',[],true),/検証が動いて/);
 const r=await pending;assert.equal(r.ok,true);assert.match(r.result.output,/fixture passed/);assert.equal(fs.existsSync(path.join(f.dir,'hook-ran')),false);assert.equal(f.m.locked('P'),false);
});
test('verification reports broken structure and terminates an overlong local script',async t=>{
 const f=fixture(t,{timeout:350});fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'');
 const task=f.store.createTask('P',{title:'Broken'});f.store.updateTask('P',task.id,{parent:'missing'});
 assert.equal((await f.m.verify('P')).ok,false);
 fs.writeFileSync(path.join(f.dir,'wait.cjs'),'setInterval(()=>{},1000)');fs.writeFileSync(path.join(f.dir,'package.json'),JSON.stringify({scripts:{test:'node wait.cjs'}}));
 const r=await f.m.verify('P','test',scriptsAt(f.dir)[0].hash,true);assert.equal(r.ok,false);assert.match(r.result.note,/時間内/);assert.equal(f.m.locked('P'),false);
});

test('shared body ledgers and Unicode-equivalent references protect old versions; nested Git is excluded',t=>{
 const f=fixture(t),body=path.join(f.root,'body');fs.mkdirSync(body);f.m.baseOf=()=>body;
 const oldDir=path.join(body,'作業/過去版');fs.mkdirSync(oldDir,{recursive:true});
 const nfd='データ.dat'.normalize('NFD'),file=path.join(oldDir,nfd);fs.writeFileSync(file,'version');const when=new Date(Date.now()-40*DAY);fs.utimesSync(file,when,when);
 const other=path.join(f.root,'Product/Q');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'PROJECT.md'),'---\nname: Q\n---\n参照：'+file.normalize('NFC'));
 assert.equal(f.m.preview('P').candidates.length,0);
 const nested=f.old('.ai/work/nested/.git/HEAD','git');fs.utimesSync(path.dirname(nested),when,when);fs.utimesSync(path.dirname(path.dirname(nested)),when,when);
 assert.ok(f.m.preview('P').excluded.some(e=>e.reason.includes('Git履歴')));
 fs.writeFileSync(path.join(body,'package.json'),JSON.stringify({scripts:{test:'jest',build:'tsc',check:'curl'}}));
 const scripts=scriptsAt(body);assert.equal(scripts.find(x=>x.name==='test').allowed,true);assert.equal(scripts.find(x=>x.name==='build').allowed,true);assert.equal(scripts.find(x=>x.name==='check').allowed,false);
});

test('構造確認は資料の相対パスをプロジェクト基準に解決し、絶対・ホーム指定と欠落も正しく判定する',async t=>{
 const f=fixture(t),relative='資料/確認 用/原文.md',file=f.old(relative,'keep this source');
 const cwdOnly=path.relative(process.cwd(),__filename);
 assert.equal(fs.existsSync(cwdOnly),true);
 assert.equal(fs.existsSync(path.resolve(f.dir,cwdOnly)),false);
 const folders={相対資料:relative,絶対資料:file,ホーム:'~',欠落:'資料/missing',実行場所だけ:cwdOnly};
 const doc='---\nname: P\nfolders:\n'+Object.entries(folders).map(([label,file])=>'  '+label+': '+file).join('\n')+'\n---\n';
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),doc);
 const r=await f.m.verify('P');
 const check=label=>r.checks.find(c=>c.name==='フォルダ：'+label);
 for(const label of ['相対資料','絶対資料','ホーム'])assert.equal(check(label).ok,true,label);
 for(const label of ['欠落','実行場所だけ'])assert.equal(check(label).ok,false,label);
 assert.equal(r.ok,false);assert.equal(check('相対資料').detail,relative);
 assert.equal(fs.readFileSync(file,'utf8'),'keep this source');assert.equal(fs.readFileSync(path.join(f.dir,'PROJECT.md'),'utf8'),doc);
});

test('total reference budget stop retains protected path, size and busy state',t=>{
 const f=fixture(t,{referenceLimits:{bytes:1024*1024}}),large=f.old('large.json','x'.repeat(1024*1024+1));f.busy(true);
 const d=f.m.preview('P');assert.equal(d.token,'');assert.equal(d.candidates.length,0);assert.equal(d.stopped.path,large);assert.equal(d.stopped.size,1024*1024+1);assert.equal(d.busy,true);assert.equal(fs.statSync(large).size,1024*1024+1);
});


test('deep references at depths 7 through 13 protect candidates; excessive depth fails closed',t=>{
 const f=fixture(t);const file=f.old('.ai/work/deep.dat');
 for(let depth=7;depth<=13;depth++) {
  const ref=f.old(Array(depth).fill('level').join('/')+'/ref.md',file);
  const d=f.m.preview('P');assert.ok(d.token);assert.equal(d.candidates.length,0);fs.unlinkSync(ref);
 }
 f.m.referenceLimits.depth=12;f.old(Array(13).fill('other').join('/')+'/ref.md',file);
 const d=f.m.preview('P');assert.equal(d.token,'');assert.equal(d.candidates.length,0);assert.match(d.stopped.reason,/深さ/);
});
test('large reference tail and UTF-8/NFC/Hangul chunk boundaries protect every reference form',t=>{
 const f=fixture(t,{referenceLimits:{chunk:4096}});
 const cases=[['café.dat','cafe\u0301.dat'],['データ.dat','テ\u3099ータ.dat'],['각.dat','\u1100\u1161\u11a8.dat'],['😀.dat','😀.dat'],['ḉ.dat','c\u0301\u0327.dat']];
 for(const [name,ref] of cases) {
  const file=f.old('.ai/work/'+name);
  for(const form of [ref,path.relative(f.dir,file).replace(name,ref),file.replace(name,ref)]) {
   // Put every byte of the spelling on a read boundary, after more than 1 MiB.
   for(let offset=1;offset<=Buffer.byteLength(ref);offset++) {
    const padding=4096*257-offset;f.old('large.txt','x'.repeat(padding)+form);
    const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0,form+' offset '+offset);
   }
  }
  fs.unlinkSync(file);
 }
});
for(const chunk of [65536,9])test(`supplementary NFC before Hangul V/T protects all reference forms at chunk ${chunk}`,t=>{
 // The default size uses the independent R1 reproduction, beyond 1 MiB.
 const f=fixture(t,chunk===65536?{}:{referenceLimits:{chunk}}),unsafe=[];
 assert.equal(f.m.referenceLimits.chunk,chunk);
 for(const jamo of ['\u1161','\u11a8']) {
  const raw='\u{1D15E}'+jamo+'ab.dat',name=raw.normalize('NFC'),file=f.old('.ai/work/'+name);
  assert.notEqual(raw,name);
  for(const prefix of ['', '.ai/work/',path.dirname(file)+path.sep])for(const offset of [0,-1,1]) {
   const text='x'.repeat(chunk*17-Buffer.byteLength(prefix+'\u{1D15E}'+jamo+'ab')+offset)+prefix+raw;
   const context=`jamo=${jamo.codePointAt(0).toString(16)} prefix=${prefix} offset=${offset}`;
   if(chunk===65536)assert.ok(Buffer.byteLength(text)>1024*1024,context);
   assert.ok(text.normalize('NFC').includes((prefix+name).normalize('NFC')),context);
   f.old('boundary.txt',text);
   const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);
   if(d.candidates.length)unsafe.push(context);
   else assert.ok(d.excluded.some(e=>e.path===file && /参照/.test(e.reason)),context);
   assert.equal(fs.readFileSync(file,'utf8'),'fixture');
   assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
  }
  fs.unlinkSync(file);
 }
 assert.deepEqual(unsafe,[],'NFC-equivalent references must never be eligible');
});
test('minimal supplementary NFC and Hangul boundary retains whole-code-point normalization',t=>{
 const f=fixture(t,{referenceLimits:{chunk:9}});
 for(const jamo of ['\u1161','\u11a8']) {
  const raw='\u{1D15E}'+jamo+'ab.dat',name=raw.normalize('NFC'),file=f.old('.ai/work/'+name);
  assert.equal(name,'\u{1D157}\u{1D165}'+jamo+'ab.dat');
  for(const offset of [0,1,2]) {
   const text='x'.repeat(offset)+raw;assert.ok(text.normalize('NFC').includes(name));
   f.old('boundary.txt',text);const d=f.m.preview('P');
   assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0,`jamo=${jamo} offset=${offset}`);
   assert.ok(d.excluded.some(e=>e.path===file && /参照/.test(e.reason)));
  }
  assert.equal(fs.readFileSync(file,'utf8'),'fixture');fs.unlinkSync(file);
 }
 assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
});
// R2: run the product's actual consume closure against a whole-string NFC oracle.
function streamedReferenceNFC(text,chunk) {
 const source=fs.readFileSync(require.resolve('../lib/maintenance'),'utf8');
 const start=source.indexOf('const consume=(text,last=false)=>{'),end=source.indexOf('let n;while((n=fs.readSync',start);
 assert.ok(start>=0 && end>start,'extract the actual streaming normalizer');
 let normalized='';
 const consume=new Function('limits','match',"let carry='';"+source.slice(start,end)+'return consume;')({carry:1024*1024},text=>normalized+=text);
 const decoder=new (require('node:string_decoder').StringDecoder)('utf8'),bytes=Buffer.from(text);
 for(let pos=0;pos<bytes.length;pos+=chunk)consume(decoder.write(bytes.subarray(pos,pos+chunk)));
 consume(decoder.end(),true);return normalized;
}
for(const mode of ['default','short'])test(`combining sequence before Hangul V/T protects all reference forms at ${mode} chunks`,t=>{
 const f=fixture(t),unsafe=[],nonEquivalent=[];
 for(const base of ['c','\u{1D15E}']) {
  const chunk=mode==='default'?65536:base==='c'?10:13;
  f.m.referenceLimits.chunk=chunk;
  for(const jamo of ['\u1161','\u11a8']) {
   const head=base+'\u0301\u0327'+jamo+'ab',raw=head+'.dat',name=raw.normalize('NFC'),file=f.old('.ai/work/'+name);
   assert.notEqual(raw,name);
   for(const prefix of ['', '.ai/work/',path.dirname(file)+path.sep])for(const offset of [0,-1,1]) {
    const text='x'.repeat(chunk*17-Buffer.byteLength(prefix+head)+offset)+prefix+raw;
    const context=`base=${base.codePointAt(0).toString(16)} jamo=${jamo.codePointAt(0).toString(16)} prefix=${prefix} offset=${offset}`;
    if(mode==='default')assert.ok(Buffer.byteLength(text)>1024*1024,context);
    assert.ok(text.normalize('NFC').includes((prefix+name).normalize('NFC')),context);
    if(streamedReferenceNFC(text,chunk)!==text.normalize('NFC'))nonEquivalent.push(context);
    f.old('boundary.txt',text);const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);
    if(d.candidates.length)unsafe.push(context);
    else assert.ok(d.excluded.some(e=>e.path===file && /参照/.test(e.reason)),context);
    assert.equal(fs.readFileSync(file,'utf8'),'fixture');
    assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
   }
   fs.unlinkSync(file);
  }
 }
 assert.deepEqual({unsafe,nonEquivalent},{unsafe:[],nonEquivalent:[]},'whole-string NFC and reference protection must agree');
});
test('streamed combining and Hangul normalization equals whole-string NFC across byte boundaries',()=>{
 for(const base of ['c','\u{1D15E}'])for(const join of ['\u1161','\u11a8','\u1100\u1161\u11a8'])for(const marks of ['\u0301\u0327','\u{1D165}\u0301\u0327']) {
  const raw=base+marks+join+'ab.dat '+base+join+'end';
  for(const chunk of [1,2,3,4,7,9,10,13,64])for(let offset=0;offset<chunk;offset++) {
   const text='x'.repeat(offset)+raw;
   assert.equal(streamedReferenceNFC(text,chunk),text.normalize('NFC'),`base=${base} join=${join} chunk=${chunk} offset=${offset}`);
  }
 }
});
test('combining and Hangul carry overflow fails closed and preserves the candidate',t=>{
 const f=fixture(t,{referenceLimits:{chunk:10,carry:16}}),raw='c'+'\u0301\u0327'.repeat(16)+'\u1161ab.dat';
 const file=f.old('.ai/work/safe.dat');f.old('boundary.txt',raw+file);
 const d=f.m.preview('P');assert.equal(d.token,'');assert.deepEqual(d.candidates,[]);assert.match(d.stopped.reason,/Unicode/);
 assert.equal(fs.readFileSync(file,'utf8'),'fixture');assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
});
// End R2 regressions.

// R3 regressions: non-Mark canonical composition in Unicode 17 (Tulu-Tigalari).
for(const mode of ['default','short','partial-default','partial-short'])test(`non-Mark NFC composition protects all reference forms at ${mode} chunks`,t=>{
 const f=fixture(t),unsafe=[],nonEquivalent=[];let count=0;
 const bases=mode.startsWith('partial')?['\u{16D63}\u{16D68}','\u{16D67}\u{16D68}','\u{16D63}\u{16D67}\u{16D68}']:['\u{16D68}','\u{16D69}','\u{16D6A}'].map(c=>c.normalize('NFD'));
 for(const base of bases)for(const tail of ['ab','\u0301\u0327\u1161ab','\u0301\u0327\u11a8ab']) {
  const head=base+tail,raw=head+'.dat',name=raw.normalize('NFC'),file=f.old('.ai/work/'+name);
  const chunk=mode.endsWith('default')?65536:Buffer.byteLength(head);f.m.referenceLimits.chunk=chunk;
  assert.notEqual(raw,name);
  for(const prefix of ['', '.ai/work/',path.dirname(file)+path.sep])for(const offset of [-1,0,1]) {
   const text='x'.repeat(chunk*17-Buffer.byteLength(prefix+head)+offset)+prefix+raw;
   const context=`base=${[...base].map(c=>c.codePointAt(0).toString(16)).join(",")} tail=${JSON.stringify(tail)} prefix=${prefix} offset=${offset}`;
   if(mode.endsWith('default'))assert.ok(Buffer.byteLength(text)>1024*1024,context);
   assert.ok(text.normalize('NFC').includes((prefix+name).normalize('NFC')),context);
   if(streamedReferenceNFC(text,chunk)!==text.normalize('NFC'))nonEquivalent.push(context);
   f.old('boundary.txt',text);const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);
   if(d.candidates.length)unsafe.push(context);
   else assert.ok(d.excluded.some(e=>e.path===file && /参照/.test(e.reason)),context);
   assert.equal(fs.readFileSync(file,'utf8'),'fixture');
   assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);count++;
  }
  fs.unlinkSync(file);
 }
 assert.equal(count,81);
 console.log(`R3 ${mode}: ${count} conditions, unsafe=${unsafe.length}, nonEquivalent=${nonEquivalent.length}`);
 assert.deepEqual({unsafe,nonEquivalent},{unsafe:[],nonEquivalent:[]},'whole-string NFC and reference protection must agree');
});
test('all Unicode scalars and canonical decompositions stream as whole-string NFC',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../lib/maintenance.js'),'utf8');
 const start=source.indexOf('const consume=(text,last=false)=>{'),end=source.indexOf('let n;while((n=fs.readSync',start);
 assert.ok(start>=0 && end>start);
 const makeConsume=new Function('limits','match',"let carry='';"+source.slice(start,end)+'return consume;');
 const {StringDecoder}=require('node:string_decoder');let scalars=0,decomposed=0,comparisons=0;
 const failures=[],continuations=new Set();
 function compare(text,chunk,context) {
  let normalized='';const consume=makeConsume({carry:1024*1024},text=>normalized+=text),decoder=new StringDecoder('utf8'),bytes=Buffer.from(text);
  for(let pos=0;pos<bytes.length;pos+=chunk)consume(decoder.write(bytes.subarray(pos,pos+chunk)));
  consume(decoder.end(),true);comparisons++;
  if(normalized!==text.normalize('NFC') && failures.length<20)failures.push(context);
 }
 for(let cp=0;cp<=0x10ffff;cp++) {
  if(cp>=0xd800 && cp<=0xdfff)continue;
  const scalar=String.fromCodePoint(cp),nfd=scalar.normalize('NFD');scalars++;
  compare('x'+scalar+'ab.dat',1,`scalar=${cp.toString(16)}`);
  if(/^[\p{M}\u1161-\u1175\u11a8-\u11c2\u{16D67}]/u.test(nfd)) {
   for(const prefix of ['c\u0301','\u{16D63}','\u{16D67}','\u1100','\uac00'])for(const chunk of [1,3,7,13]) {
    compare(prefix+scalar+'ab.dat',chunk,`contextual scalar=${cp.toString(16)} prefix=${prefix} chunk=${chunk}`);
   }
  }
  if(nfd===scalar)continue;decomposed++;
  // This also detects a runtime Unicode update that needs new non-Mark boundaries.
  for(const char of [...nfd].slice(1))if(!/\p{M}/u.test(char))continuations.add(char.codePointAt(0));
  for(const tail of ['ab','\u0301\u0327\u1161ab','\u0301\u0327\u11a8ab'])for(const chunk of [1,3,7,13]) {
   compare('x'+nfd+tail+'.dat',chunk,`NFD=${cp.toString(16)} tail=${JSON.stringify(tail)} chunk=${chunk}`);
  }
 }
 console.log(`R3 scalar oracle: scalars=${scalars}, decomposed=${decomposed}, comparisons=${comparisons}, failures=${failures.length}; Node=${process.version} Unicode=${process.versions.unicode}`);
 assert.equal(scalars,0x110000-0x800,'visit every Unicode scalar, including after a mismatch');
 assert.deepEqual(failures,[]);
 assert.deepEqual([...continuations].filter(cp=>!(cp>=0x1161&&cp<=0x1175 || cp>=0x11a8&&cp<=0x11c2 || cp===0x16d67)),[],'all non-Mark canonical continuation characters are protected');
});
test('non-Mark NFC composition carry overflow fails closed and preserves the candidate',t=>{
 const f=fixture(t,{referenceLimits:{chunk:10,carry:16}}),file=f.old('.ai/work/safe.dat');
 f.old('boundary.txt','\u{16D67}'.repeat(32)+file);
 const d=f.m.preview('P');assert.equal(d.token,'');assert.deepEqual(d.candidates,[]);assert.match(d.stopped.reason,/Unicode/);
 assert.equal(fs.readFileSync(file,'utf8'),'fixture');assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
});
// End R3 regressions.
test('item, total byte, elapsed time and normalization budgets fail closed with reasons',t=>{
 const f=fixture(t);f.old('.ai/work/safe.dat');f.old('one.txt','abc');f.old('two.txt','def');
 for(const [limits,reason] of [[{items:1},/多すぎ/],[{bytes:5},/総読量/],[{ms:-1},/時間/],[{chunk:8,carry:16},/Unicode/]]) {
  f.m.referenceLimits={...f.m.referenceLimits,items:50000,bytes:128*1024*1024,ms:15000,chunk:65536,carry:1024*1024,...limits};
  if(limits.carry)f.old('marks.txt','\u0301'.repeat(32));
  const d=f.m.preview('P');assert.equal(d.token,'');assert.deepEqual(d.candidates,[]);assert.match(d.stopped.reason,reason);assert.ok(d.stopped.path);
 }
});
test('overlapping roots and symlink loops do not reread references or consume duplicate budgets',t=>{
 const f=fixture(t),file=f.old('.ai/work/safe.dat'),ref=f.old('nested/ref.txt',file);
 f.m.baseOf=()=>path.dirname(ref);fs.symlinkSync(f.dir,path.join(path.dirname(ref),'loop'));
 const bytes=fs.statSync(ref).size+fs.statSync(path.join(f.dir,'PROJECT.md')).size;
 f.m.referenceLimits.bytes=bytes;const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0);
});
test('unreadable references and mid-scan file or directory changes stop without a token',t=>{
 for(const mode of ['unreadable','file','directory','symlink']) {
  const f=fixture(t),file=f.old('.ai/work/safe.dat'),ref=f.old('ref.txt','no reference');
  const read=fs.readSync,open=fs.openSync;let changed=false;
  fs.openSync=(name,...args)=>{if(name===ref && mode==='unreadable')throw Error('read denied');if(name===ref && mode==='symlink'){fs.unlinkSync(ref);fs.symlinkSync(file,ref);}return open(name,...args);};
  fs.readSync=(...args)=>{const n=read(...args);if(!changed && n && (mode==='file'||mode==='directory')) {changed=true;if(mode==='file')fs.appendFileSync(ref,file);else f.old('new-reference.txt',file);}return n;};
  let d;try {d=f.m.preview('P');}finally{fs.readSync=read;fs.openSync=open;}
  assert.equal(d.token,'',mode);assert.equal(d.candidates.length,0,mode);assert.ok(d.stopped.path);assert.equal(fs.readFileSync(file,'utf8'),'fixture');
 }
});
test('apply recheck exposes its stop reason and path before trash or transaction creation',t=>{
 const f=fixture(t),file=f.old('.ai/work/safe.dat'),d=f.m.preview('P');
 const ref=f.old('large.txt','x'.repeat(2048));f.m.referenceLimits.bytes=1024;
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),e=>/移動前.*総読量/.test(e.message)&&e.message.includes(ref));
 assert.equal(fs.existsSync(file),true);assert.equal(fs.existsSync(f.trash),false);assert.deepEqual(f.m.history('P'),[]);
});
test('more than 5000 reference entries are scanned without relaxing candidate inventory',t=>{
 const f=fixture(t);const file=f.old('.ai/work/safe.dat');
 fs.mkdirSync(path.join(f.dir,'many'));for(let i=0;i<5010;i++)fs.writeFileSync(path.join(f.dir,'many',i+'.txt'),i===5009?file:'');
 const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0);
 f.old('.ai/work/nested/'+Array(7).fill('level').join('/')+'/leaf.dat');
 const limited=f.m.preview('P');assert.ok(limited.excluded.some(x=>/多すぎ/.test(x.reason)));
});
test('Git tracking lists above 2 MiB protect candidates; Git list budget failure stops',t=>{
 const f=fixture(t),file=f.old('.ai/work/tracked.dat');execFileSync('git',['init','-q',f.dir]);
 const blob=execFileSync('git',['-C',f.dir,'hash-object','-w','--stdin'],{input:'tracked',encoding:'utf8'}).trim();
 const names=[path.relative(f.dir,file),...Array.from({length:9000},(_,i)=>'long/'+String(i).padStart(5,'0')+'x'.repeat(230))];
 execFileSync('git',['-C',f.dir,'update-index','--index-info'],{input:names.map(n=>'100644 '+blob+'\t'+n+'\n').join(''),maxBuffer:16*1024*1024});
 const d=f.m.preview('P');assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0);assert.ok(d.excluded.some(x=>/Gitで追跡/.test(x.reason)));
 f.m.referenceLimits.gitBytes=1024;const stopped=f.m.preview('P');assert.equal(stopped.token,'');assert.equal(stopped.candidates.length,0);assert.ok(stopped.stopped.reason);
});


test('Git tracking changes during reference reading stop the preview',t=>{
 const f=fixture(t),file=f.old('.ai/work/safe.dat');execFileSync('git',['init','-q',f.dir]);
 const read=fs.readSync;let changed=false;
 fs.readSync=(...args)=>{const n=read(...args);if(n&&!changed){changed=true;execFileSync('git',['-C',f.dir,'add',file]);}return n;};
 let d;try {d=f.m.preview('P');}finally{fs.readSync=read;}
 assert.equal(d.token,'');assert.equal(d.candidates.length,0);assert.match(d.stopped.reason,/参照が変わりました/);assert.match(d.stopped.path,/index$/);
});


test('large references are read in bounded chunks without whole-file reads',t=>{
 const f=fixture(t),file=f.old('.ai/work/safe.dat'),ref=f.old('large.txt','x'.repeat(3*1024*1024)+file);
 const whole=fs.readFileSync,read=fs.readSync;let largest=0;
 fs.readFileSync=(name,...args)=>{assert.notEqual(name,ref,'reference must not be read as a whole');return whole(name,...args);};
 fs.readSync=(fd,buffer,offset,length,...args)=>{largest=Math.max(largest,length);return read(fd,buffer,offset,length,...args);};
 let d;try {d=f.m.preview('P');}finally{fs.readFileSync=whole;fs.readSync=read;}
 assert.ok(d.token,d.stopped?.reason);assert.equal(d.candidates.length,0);assert.equal(largest,65536);
});
