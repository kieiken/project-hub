'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Ideas}=require('../lib/ideas'),U=require('../lib/idea-utils'),safe=require('../lib/safe-file');

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idea-erase-recovery-')));
  fs.mkdirSync(path.join(root,'P'));fs.mkdirSync(path.join(root,'Q'));
  const store={root,readProject:id=>({dir:path.join(root,id)})};let ideas=new Ideas({store});
  const add=(project,text)=>ideas.add(project,{opId:U.uuid(),text},{human:true});
  const victim=add('P','RECOVERY-PRIVATE-CANARY'),kept=add('P','keep independent'),other=add('Q','other project');
  const snapshot=ideas.read('P').items[kept.id],q=fs.readFileSync(ideas.resolve('Q').file),s=ideas.resolve('P');
  const op={opId:U.uuid(),id:victim.id,baseContentRev:1,baseControlRev:1,confirm:true};
  t.after(()=>{ideas.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,s,op,victim,kept,other,snapshot,q,get ideas(){return ideas;},restart(){ideas.close();ideas=new Ideas({store});return ideas;}};
}
// Enter safe-file's real fd write / rename, then leave the bytes a stopped writer leaves.
function interrupt(f,match,boundary='partial',length=37) {
  let fired=false,target,expected;
  f.ideas.atomic={...safe,recoverAtomic(file,bytes,mode){
    if(fired||!match(file))return safe.recoverAtomic(file,bytes,mode);
    fired=true;target=file;expected=Buffer.from(bytes);
    const write=fs.writeFileSync,rename=fs.renameSync;
    fs.writeFileSync=function(fd,data,...args){
      if(boundary!=='partial')return write.call(this,fd,data,...args);
      write.call(this,fd,Buffer.from(data).subarray(0,length),...args);throw Error('interrupted fd write');
    };
    fs.renameSync=function(from,to){
      if(boundary==='before-rename')throw Error('interrupted before rename');
      const out=rename.call(this,from,to);if(boundary==='after-rename')throw Error('interrupted after rename');return out;
    };
    try{return safe.recoverAtomic(file,bytes,mode);}finally{fs.writeFileSync=write;fs.renameSync=rename;}
  }};
  return {get fired(){return fired;},get target(){return target;},get expected(){return expected;}};
}
function files(dir) {return fs.readdirSync(dir).flatMap(n=>{const f=path.join(dir,n);return fs.statSync(f).isDirectory()?files(f):[f];});}
function assertComplete(f) {
  const receipt=f.ideas.receipt('P',f.op.opId);assert.equal(receipt.deleted,true,JSON.stringify(receipt));
  const d=f.ideas.read('P');assert.equal(d.items[f.victim.id],undefined);assert.deepEqual(d.items[f.kept.id],f.snapshot);
  assert.deepEqual(fs.readFileSync(f.ideas.resolve('Q').file),f.q);
  function absent(bytes,depth=0){assert.equal(bytes.includes(Buffer.from('RECOVERY-PRIVATE-CANARY')),false);if(depth>8)return;try{const v=JSON.parse(bytes);if(v.base64)absent(Buffer.from(v.base64,'base64'),depth+1);}catch(e){if(e.code==='ERR_ASSERTION')throw e;}}
  for(const file of files(f.root))absent(fs.readFileSync(file));
  assert.equal(fs.existsSync(path.join(f.s.controlDir,'erase-intent.json')),false);
  assert.equal(fs.readdirSync(f.s.controlDir).some(n=>n.startsWith('erase-intent.')),false);
  assert.equal(f.ideas.add('P',{opId:U.uuid(),text:'usable after recovery'},{human:true}).saved,true);
}
test('R1 partial canonical fd write resumes after restart and preserves other records',t=>{
  const f=fixture(t),cut=interrupt(f,file=>file===f.s.file);
  assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);
  assert.equal(fs.readFileSync(f.s.file+'.tmp').length,37);f.restart();assertComplete(f);
});
for(const boundary of ['before-rename','after-rename'])for(const target of ['canonical','archive','backup','projection'])test(`R1 ${target} ${boundary} resumes without replaying completed writes`,t=>{
  const f=fixture(t);let match;
  if(target==='canonical')match=file=>file===f.s.file;
  if(target==='archive')match=file=>file.startsWith(path.join(f.ideas.control,'transactions',U.hash(f.s.file))+path.sep)&&path.basename(file)==='previous.json';
  if(target==='backup'){f.ideas.backup('P',{opId:U.uuid()});match=file=>file.includes(path.sep+'backups'+path.sep)&&path.basename(file)==='ledger';}
  if(target==='projection')match=file=>file===f.s.md;
  const cut=interrupt(f,match,boundary);assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);
  f.restart();let replayed=false;f.ideas.atomic={...safe,recoverAtomic(file,...args){if(file===cut.target&&fs.existsSync(path.join(f.s.controlDir,'erase-intent.json')))replayed=true;return safe.recoverAtomic(file,...args);}};
  assertComplete(f);assert.equal(replayed,boundary==='before-rename');
});
for(const target of ['empty-canonical','archive','backup','backup-index','projection','listed-temp'])test(`R1 partial ${target} scratch is reconstructed only from bound output`,t=>{
  const f=fixture(t);let match=file=>file===f.s.file,length=37;
  if(target==='empty-canonical')length=0;
  if(target==='archive')match=file=>file.startsWith(path.join(f.ideas.control,'transactions',U.hash(f.s.file))+path.sep)&&path.basename(file)==='candidate.json';
  if(target==='backup'||target==='backup-index'){f.ideas.backup('P',{opId:U.uuid()});match=file=>file.includes(path.sep+'backups'+path.sep)&&path.basename(file)===(target==='backup'?'ledger':'backup.json');}
  if(target==='projection')match=file=>file===f.s.md;
  if(target==='listed-temp'){
    const archive=files(path.join(f.ideas.control,'transactions',U.hash(f.s.file))).find(file=>path.basename(file)==='previous.json');
    fs.writeFileSync(archive+'.tmp','pre-existing interrupted temp');match=file=>file===archive;
  }
  const cut=interrupt(f,match,'partial',length);assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);
  assert.equal(fs.readFileSync(cut.target+'.tmp').length,length);f.restart();assertComplete(f);
});
test('R1 repeated partial reconstruction can restart twice without retaining prior payload',t=>{
  const f=fixture(t);interrupt(f,file=>file===f.s.file);assert.throws(()=>f.ideas.erase('P',f.op));
  f.restart();interrupt(f,file=>file===f.s.file,'partial',101);assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');
  assert.equal(fs.readFileSync(f.s.file+'.tmp').length,101);f.restart();assertComplete(f);
});
for(const boundary of ['partial','empty','missing-LF','before-rename','after-rename'])test(`R1 journal ${boundary} resolves precommit vs committed state`,t=>{
  const f=fixture(t),jf=path.join(f.s.controlDir,'erase-intent.json');
  if(boundary==='missing-LF'){
    f.ideas.atomic={...safe,recoverAtomic(file,bytes,mode){if(file!==jf)return safe.recoverAtomic(file,bytes,mode);fs.writeFileSync(file+'.tmp',Buffer.from(bytes).subarray(0,Buffer.byteLength(bytes)-1),{flag:'wx',mode:0o600});throw Error('final LF not written');}};
  } else {const cut=interrupt(f,file=>file===jf,boundary==='empty'?'partial':boundary,boundary==='empty'?0:37);assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);}
  if(boundary==='missing-LF')assert.throws(()=>f.ideas.erase('P',f.op));
  assert.equal(fs.readdirSync(f.s.controlDir).filter(n=>n.endsWith('.preparing')).length,1);
  f.restart();
  if(['partial','empty'].includes(boundary)){
    assert.deepEqual(f.ideas.receipt('P',f.op.opId),{saved:false,state:'absent'});assert.ok(f.ideas.read('P').items[f.victim.id]);
    assert.equal(fs.existsSync(jf+'.tmp'),false);assert.equal(f.ideas.add('P',{opId:U.uuid(),text:'usable after precommit abort'},{human:true}).saved,true);assert.equal(f.ideas.erase('P',f.op).deleted,true);
  }
  assertComplete(f);
});
test('R1 journal preparation marker interrupted before first write safely abandons only preparation',t=>{
  const f=fixture(t),sync=f.ideas.atomicDirectory.bind(f.ideas);let fired=false;
  f.ideas.atomicDirectory=file=>{sync(file);if(!fired&&file.endsWith('.preparing')){fired=true;throw Error('marker durable, no journal write');}};
  assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(fired,true);f.restart();
  assert.deepEqual(f.ideas.receipt('P',f.op.opId),{saved:false,state:'absent'});assert.ok(f.ideas.read('P').items[f.victim.id]);
  f.ideas.erase('P',f.op);assertComplete(f);
});
for(const damage of ['non-prefix','symlink','hardlink','changed-source','changed-later-source','linked-source','hardlinked-source','out-of-scope'])test(`R1 ${damage} is rejected before touching a partial scratch or another record`,t=>{
  const f=fixture(t),cut=interrupt(f,file=>file===f.s.file);assert.throws(()=>f.ideas.erase('P',f.op));
  const tmp=f.s.file+'.tmp',jf=path.join(f.s.controlDir,'erase-intent.json'),external=path.join(f.root,'unowned.txt');fs.writeFileSync(external,'unowned contents');
  if(damage==='non-prefix')fs.writeFileSync(tmp,'another operation');
  if(damage==='symlink'||damage==='hardlink'){fs.unlinkSync(tmp);if(damage==='symlink')fs.symlinkSync(external,tmp);else fs.linkSync(external,tmp);}
  if(damage==='changed-source')fs.appendFileSync(f.s.file,' ');
  if(damage==='changed-later-source')fs.appendFileSync(f.s.md,'changed after intent');
  if(damage==='linked-source'||damage==='hardlinked-source'){
    const saved=path.join(f.root,'saved-original');fs.renameSync(f.s.file,saved);
    if(damage==='linked-source')fs.symlinkSync(saved,f.s.file);else fs.linkSync(saved,f.s.file);
  }
  if(damage==='out-of-scope'){const intent=JSON.parse(fs.readFileSync(jf));intent.files.push({file:external,kind:'temporary',before:U.hash(fs.readFileSync(external)),after:null});fs.writeFileSync(jf,U.bytes(intent));}
  const before=fs.readFileSync(f.s.file),partial=fs.readFileSync(tmp),q=fs.readFileSync(f.ideas.resolve('Q').file);
  f.restart();assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');assert.deepEqual(fs.readFileSync(f.s.file),before);assert.deepEqual(fs.readFileSync(tmp),partial);
  assert.deepEqual(fs.readFileSync(f.ideas.resolve('Q').file),q);assert.equal(fs.readFileSync(external,'utf8'),'unowned contents');assert.equal(cut.fired,true);
});
test('R1 completed canonical hash cannot authorize an unrelated generated scratch',t=>{
  const f=fixture(t),cut=interrupt(f,file=>file===f.s.file,'after-rename');assert.throws(()=>f.ideas.erase('P',f.op));
  fs.writeFileSync(f.s.file+'.tmp','unknown operation');f.restart();assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');
  assert.equal(fs.readFileSync(f.s.file+'.tmp','utf8'),'unknown operation');assert.equal(cut.fired,true);
});
test('R1 unsealed legacy journal fragment and shared safe-file ambiguity stay protected',t=>{
  const f=fixture(t),jf=path.join(f.s.controlDir,'erase-intent.json');fs.writeFileSync(jf+'.tmp','{"incomplete":');f.restart();
  assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');assert.equal(fs.readFileSync(jf+'.tmp','utf8'),'{"incomplete":');
  const file=path.join(f.root,'ordinary-file');fs.writeFileSync(file,'before');fs.writeFileSync(file+'.tmp','aft');
  assert.throws(()=>safe.recoverAtomic(file,Buffer.from('after')),/一時原文の照合/);assert.equal(fs.readFileSync(file,'utf8'),'before');assert.equal(fs.readFileSync(file+'.tmp','utf8'),'aft');
});
test('R1 journal seal hash mismatch and linked scratch never discard unknown contents',t=>{
  const f=fixture(t),jf=path.join(f.s.controlDir,'erase-intent.json');interrupt(f,file=>file===jf,'before-rename');assert.throws(()=>f.ideas.erase('P',f.op));
  const tmp=fs.readFileSync(jf+'.tmp');fs.writeFileSync(jf+'.tmp',U.bytes({...JSON.parse(tmp),opId:U.uuid()}));f.restart();
  assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');assert.ok(fs.existsSync(jf+'.tmp'));
  fs.unlinkSync(jf+'.tmp');fs.symlinkSync(f.s.file,jf+'.tmp');f.restart();assert.equal(f.ideas.receipt('P',f.op.opId).saved,'unknown');assert.equal(fs.lstatSync(jf+'.tmp').isSymbolicLink(),true);
});
for(const target of ['canonical','journal'])test(`R1 actual process exit during ${target} fd write recovers under a new writer owner`,t=>{
  const f=fixture(t);f.ideas.close();
  const code=`const fs=require('node:fs'),path=require('node:path'),{Ideas}=require('./lib/ideas'),safe=require('./lib/safe-file');
    const root=process.argv[1],op=JSON.parse(process.argv[2]),ideas=new Ideas({store:{root,readProject:id=>({dir:path.join(root,id)})}}),s=ideas.resolve('P');
    const target=process.argv[3]==='journal'?path.join(s.controlDir,'erase-intent.json'):s.file;
    ideas.atomic={...safe,recoverAtomic(file,bytes,mode){if(file!==target)return safe.recoverAtomic(file,bytes,mode);
      fs.writeFileSync=(fd,data)=>{fs.writeSync(fd,Buffer.from(data).subarray(0,37));fs.fsyncSync(fd);process.exit(73);};return safe.recoverAtomic(file,bytes,mode);}};ideas.erase('P',op);process.exit(1);`;
  const out=require('node:child_process').spawnSync(process.execPath,['-e',code,f.root,JSON.stringify(f.op),target],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:15000});
  const file=target==='journal'?path.join(f.s.controlDir,'erase-intent.json'):f.s.file;
  assert.equal(out.status,73,out.stderr);assert.equal(fs.readFileSync(file+'.tmp').length,37);f.restart();
  if(target==='journal'){assert.equal(f.ideas.receipt('P',f.op.opId).saved,false);f.ideas.erase('P',f.op);}
  assertComplete(f);
});
test('R1 journal marker retirement sync failure resumes committed intent',t=>{
  const f=fixture(t),sync=f.ideas.atomicDirectory.bind(f.ideas);let markers=0;
  f.ideas.atomicDirectory=file=>{sync(file);if(file.endsWith('.preparing')&&++markers===2)throw Error('marker removed, parent sync interrupted');};
  assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(markers,2);f.restart();assertComplete(f);
});
test('R1 complete legacy journal temp still promotes by exact bytes',t=>{
  const f=fixture(t),jf=path.join(f.s.controlDir,'erase-intent.json');interrupt(f,file=>file===jf,'before-rename');assert.throws(()=>f.ideas.erase('P',f.op));
  const marker=fs.readdirSync(f.s.controlDir).find(n=>n.endsWith('.preparing'));fs.rmdirSync(path.join(f.s.controlDir,marker));
  f.restart();assertComplete(f);
});

for(const target of ['canonical','raw','wrapped'])for(const boundary of ['partial','after-rename'])test(`reviewed markdown ${target} ${boundary} resumes exact line erasure without raw payload in intent`,t=>{
 const f=fixture(t),original=Buffer.from('# unknown original\r\nRECOVERY-PRIVATE-CANARY\r\nkeep independent\r\n末尾を保持');fs.writeFileSync(f.s.md,original);
 f.ideas.backup('P',{opId:U.uuid()});const review=f.ideas.eraseAvailability('P',f.victim.id).markdownReview;
 f.op.markdownReview={token:review.token,confirmed:true,documents:review.documents.map(d=>({hash:d.hash,removeLines:d.targetLines}))};
 const match=target==='canonical'?file=>file===f.s.file:target==='raw'?file=>file===f.s.md:file=>file.includes(path.sep+'backups'+path.sep)&&path.basename(file)==='markdown';
 const cut=interrupt(f,match,boundary);assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);
 const journal=fs.readFileSync(path.join(f.s.controlDir,'erase-intent.json'),'utf8');assert.equal(journal.includes('RECOVERY-PRIVATE-CANARY'),false);assert.equal(journal.includes('unknown original'),false);
 f.restart();assertComplete(f);assert.deepEqual(fs.readFileSync(f.s.md),Buffer.from('# unknown original\r\nkeep independent\r\n末尾を保持'));assert.equal(f.ideas.erase('P',f.op).deleted,true);
});

test('review decisions stay bound to their own files when one result equals another original, including restart',t=>{
 const f=fixture(t),first='Shared unknown heading\nRECOVERY-PRIVATE-CANARY\nOld target wording\n',second='Shared unknown heading\nOld target wording\n';fs.writeFileSync(f.s.md,first);f.ideas.backup('P',{opId:U.uuid()});fs.writeFileSync(f.s.md,second);
 const review=f.ideas.eraseAvailability('P',f.victim.id).markdownReview;assert.equal(review.documents.length,2);
 f.op.markdownReview={token:review.token,confirmed:true,documents:review.documents.map(d=>({hash:d.hash,removeLines:[2]}))};
 const cut=interrupt(f,file=>file===f.s.md,'after-rename');assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);f.restart();assertComplete(f);
 assert.equal(fs.readFileSync(f.s.md,'utf8'),'Shared unknown heading\n');const wrappers=files(path.join(f.ideas.control,'backups')).filter(file=>path.basename(file)==='markdown');for(const file of wrappers)assert.equal(Buffer.from(JSON.parse(fs.readFileSync(file)).base64,'base64').toString(),second);
});

for(const target of ['canonical','import','wrapped-import'])for(const boundary of ['partial','after-rename'])test(`import line review ${target} ${boundary} resumes then deletes a later legacy row after live edit`,t=>{
 const f=fixture(t),eol='\r\n';fs.writeFileSync(f.s.md,['# 未着手','RECOVERY-PRIVATE-CANARY','- LATER-IMPORT-CANARY','KEEP-IMPORT-TAIL'].join(eol));
 f.ideas.initialize('P',U.uuid(),{importLegacy:true});const legacy=Object.values(f.ideas.read('P').items).find(i=>i.text==='LATER-IMPORT-CANARY'),importFile=path.join(f.s.controlDir,'imports',legacy.source.hash+'.md');f.ideas.backup('P',{opId:U.uuid()});
 const confirm=id=>{const r=f.ideas.eraseAvailability('P',id).markdownReview;assert.ok(r);return {token:r.token,confirmed:true,documents:r.documents.map(d=>({hash:d.hash,removeLines:d.targetLines}))};};
 f.op.markdownReview=confirm(f.victim.id);
 const match=target==='canonical'?file=>file===f.s.file:target==='import'?file=>file===importFile:file=>file.includes('/backups/')&&file.endsWith('/control/imports/'+legacy.source.hash+'.md');
 const cut=interrupt(f,match,boundary);assert.throws(()=>f.ideas.erase('P',f.op));assert.equal(cut.fired,true);f.restart();assertComplete(f);
 assert.equal(fs.readFileSync(importFile,'utf8'),['# 未着手','','- LATER-IMPORT-CANARY','KEEP-IMPORT-TAIL'].join(eol));assert.deepEqual(f.ideas.read('P').items[legacy.id].source,legacy.source);
 fs.appendFileSync(f.s.md,eol+'LIVE-EDIT-ONLY');const item=f.ideas.read('P').items[legacy.id],op={opId:U.uuid(),id:item.id,baseContentRev:item.contentRev,baseControlRev:item.controlRev,confirm:true,markdownReview:confirm(item.id)};assert.equal(f.ideas.erase('P',op).deleted,true);
 assert.equal(fs.readFileSync(importFile,'utf8'),['# 未着手','','','KEEP-IMPORT-TAIL'].join(eol));assert.deepEqual(f.ideas.read('P').imports[legacy.source.hash].unknown,[{line:4,text:'KEEP-IMPORT-TAIL'}]);
 for(const file of files(f.root)){
   let bytes=fs.readFileSync(file);assert.equal(bytes.includes(Buffer.from('LATER-IMPORT-CANARY')),false,file);try{const v=JSON.parse(bytes);if(v.base64){bytes=Buffer.from(v.base64,'base64');assert.equal(bytes.includes(Buffer.from('LATER-IMPORT-CANARY')),false,file);}}catch(e){if(e.code==='ERR_ASSERTION')throw e;}
 }
 assert.equal(f.restart().erase('P',op).deleted,true);
});

test('import line review retains recovery compatibility with a previously prepared compact-import journal',t=>{
 const f=fixture(t);fs.writeFileSync(f.s.md,'# 未着手\nRECOVERY-PRIVATE-CANARY\n- legacy retained\nunknown retained\n');f.ideas.initialize('P',U.uuid(),{importLegacy:true});
 const r=f.ideas.eraseAvailability('P',f.victim.id).markdownReview;f.op.markdownReview={token:r.token,confirmed:true,documents:r.documents.map(d=>({hash:d.hash,removeLines:d.targetLines}))};
 f.ideas.fault=stage=>{if(stage==='erase-intent')throw Error('committed old journal');};assert.throws(()=>f.ideas.erase('P',f.op));
 const file=path.join(f.s.controlDir,'erase-intent.json'),intent=JSON.parse(fs.readFileSync(file));delete intent.context.importResolutions;
 // Model the already sealed output of bcc8aab5; recovery must not substitute
 // the new blank-line output halfway through an older committed operation.
 for(const e of intent.files)if(e.reviewedImport){const r=e.reviewedImport,bytes=fs.readFileSync(e.file);e.reviewedMarkdown=r.before;e.after=U.hash(Buffer.from(bytes.toString().split('\n').filter((_,n)=>!r.removeLines.includes(n+1)).join('\n')));delete e.reviewedImport;}
 fs.writeFileSync(file,U.bytes(intent));f.restart();assertComplete(f);
 const imported=Object.values(f.ideas.read('P').imports)[0];assert.deepEqual(imported.unknown,[{line:4,text:'unknown retained'}]);assert.equal(fs.readFileSync(imported.backup,'utf8'),'# 未着手\n- legacy retained\nunknown retained\n');
});
