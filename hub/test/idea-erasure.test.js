'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Ideas}=require('../lib/ideas'),U=require('../lib/idea-utils');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idea-erasure-'))),dir=path.join(root,'P');fs.mkdirSync(dir);
  const store={root,readProject:id=>({dir:path.join(root,id)})};let ideas=new Ideas({store});
  t.after(()=>{ideas.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,dir,store,get ideas(){return ideas;},restart(){ideas.close();ideas=new Ideas({store});return ideas;},add(text,extra={}){const b={opId:U.uuid(),text,intent:'record',...extra};return {...ideas.add('P',b,{human:true}),body:b};}};
}
function request(f,id) {const i=f.ideas.read('P').items[id];return {opId:U.uuid(),id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,confirm:true};}
function files(dir) {if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).flatMap(n=>{const f=path.join(dir,n);return fs.statSync(f).isDirectory()?files(f):[f];});}
function decoded(bytes,visit,depth=0) {visit(bytes);if(depth>8)return;try{const d=JSON.parse(bytes);if(d?.base64)decoded(Buffer.from(d.base64,'base64'),visit,depth+1);}catch{}}
function absent(root,canary) {for(const file of files(root))decoded(fs.readFileSync(file),bytes=>assert.equal(bytes.includes(Buffer.from(canary)),false,file));}
test('append order survives states, legacy UUID sorting, categories, page boundaries and conflicts without grants changing',t=>{
 const f=fixture(t),a=f.add('first',{intent:'build'}),b=f.add('second'),c=f.add('third');const before=f.ideas.read('P').items[a.id];
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[a.id].status='implemented';d.items[b.id].status='waiting';});assert.deepEqual(f.ideas.view('P').items.map(i=>i.id),[a.id,b.id,c.id]);
 const rev=f.ideas.read('P').orderRev,move={opId:U.uuid(),id:c.id,direction:'up',baseOrderRev:rev};f.ideas.reorder('P',move);f.ideas.reorder('P',move);assert.throws(()=>f.ideas.reorder('P',{...move,opId:U.uuid()}),{code:'order-revision'});
 assert.deepEqual(f.restart().view('P').items.map(i=>i.id),[a.id,c.id,b.id]);
 let i=f.ideas.read('P').items[a.id];f.ideas.update('P',{opId:U.uuid(),id:a.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{category:'bug'}});i=f.ideas.read('P').items[a.id];for(const k of ['contentRev','planRev','grant','priority','implementation'])assert.deepEqual(i[k],before[k]);
 const s=f.ideas.resolve('P'),d=f.ideas.read('P');delete d.itemOrder;delete d.orderRev;for(const i of Object.values(d.items))i.createdAt='2026-01-01';fs.writeFileSync(s.file,U.bytes(d));assert.deepEqual(f.ideas.read('P').itemOrder,Object.keys(d.items).sort());
 f.ideas.internal('P',U.uuid(),{},d=>{for(let n=0;n<101;n++)f.ideas.newItem(d,'row'+n,'record',null,U.uuid());});const last=f.ideas.read('P').itemOrder.at(-1);let r=f.ideas.read('P').orderRev;const result=f.ideas.reorder('P',{opId:U.uuid(),id:last,direction:'up',baseOrderRev:r});assert.equal(result.index,102);assert.equal(f.ideas.view('P',100).items[2].id,last);
});
test('hard deletion scrubs histories, immutable transactions and nested base64 backup while preserving other items',t=>{
 const f=fixture(t),a=f.add('CANARY-body-old'),b=f.add('keep me');
 f.ideas.update('P',{opId:U.uuid(),id:a.id,baseContentRev:1,baseControlRev:1,change:{text:'CANARY-body-new'}});
 const keep=f.ideas.read('P').items[b.id];f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);const out=f.ideas.erase('P',op);assert.equal(out.deleted,true);assert.deepEqual(f.ideas.read('P').items[b.id],keep);assert.equal(f.ideas.receipt('P',a.body.opId).removed,true);assert.equal(f.ideas.add('P',a.body,{human:true}).removed,true);
 absent(f.root,'CANARY-body');assert.equal(f.restart().erase('P',op).deleted,true);absent(f.root,'CANARY-body');
});
for(const boundary of ['erase-staging','erase-intent','erase-file','erase-projection','erase-final'])test('fault and restart at '+boundary,t=>{
 const f=fixture(t),a=f.add('CANARY-'+boundary);f.add('other');f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);let fired=false;f.ideas.fault=stage=>{if(stage===boundary&&!fired){fired=true;throw Error('injected');}};
 assert.throws(()=>f.ideas.erase('P',op));assert.equal(fired,true);
 const i=f.restart();if(boundary==='erase-staging'){assert.ok(i.read('P').items[a.id]);i.erase('P',op);}else assert.equal(i.receipt('P',op.opId).deleted,true);
 absent(f.root,'CANARY-'+boundary);assert.equal(i.view('P').total,1);
});
test('preflight rejects running, unresolved, dependencies, links, unknown files and hand-edited markdown before erasing',t=>{
 const f=fixture(t),a=f.add('preserve'),b=f.add('dependent'),s=f.ideas.resolve('P');let op=request(f,a.id);
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[b.id].dependencies=[{ideaId:a.id}];});assert.throws(()=>f.ideas.erase('P',op),{code:'erase-dependency'});
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[b.id].dependencies=[];d.runs.x={closed:false,delivery:'unknown',targets:[]};});assert.throws(()=>f.ideas.erase('P',op),{code:'erase-busy'});
 f.ideas.internal('P',U.uuid(),{},d=>{delete d.runs.x;});const unknown=path.join(s.controlDir,'unowned.txt');fs.writeFileSync(unknown,'not owned');assert.throws(()=>f.ideas.erase('P',op),{code:'erase-format'});fs.unlinkSync(unknown);
 fs.symlinkSync(s.file,path.join(s.controlDir,'link'));assert.throws(()=>f.ideas.erase('P',op));fs.unlinkSync(path.join(s.controlDir,'link'));
 fs.appendFileSync(s.md,'hand edited');assert.throws(()=>f.ideas.erase('P',op),{code:'erase-markdown'});assert.ok(f.ideas.read('P').items[a.id]);assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false);
});
test('legacy import and relocation originals are scrubbed; old approvals cannot restore deleted contents',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),'# アイデア\n- CANARY-import\n- keep import\n');f.ideas.initialize('P',U.uuid(),{importLegacy:true});const a=f.ideas.view('P').items.find(i=>i.text==='CANARY-import'),saved=f.ideas.backup('P',{opId:U.uuid()});
 f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...saved});const op=request(f,a.id);assert.equal(f.ideas.erase('P',op).deleted,true);absent(f.root,'CANARY-import');
 assert.throws(()=>f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...saved}),{code:'registry-backup'});assert.equal(f.restart().view('P').total,1);
});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=','base64');
test('image-only: all original/preview/staging/receipt/backup copies gone; stale upload cannot recreate them',t=>{
 const f=fixture(t),upload={opId:U.uuid(),name:'CANARY-name.png'},im=f.ideas.uploadImage('P',upload,PNG).image,a=f.add('',{images:[im.id]}),s=f.ideas.resolve('P');
 const preview=f.ideas.image('P',im.id,true).bytes,stage=path.join(s.controlDir,'image-staging',im.id,U.uuid()+'.png');fs.writeFileSync(stage,preview);f.add('keep');f.ideas.backup('P',{opId:U.uuid()});
 assert.equal(f.ideas.erase('P',request(f,a.id)).deleted,true);assert.equal(f.ideas.uploadImage('P',upload,PNG).removed,true);assert.throws(()=>f.ideas.image('P',im.id),{code:'image-owner'});
 absent(f.root,'CANARY-name');for(const file of files(f.root))decoded(fs.readFileSync(file),b=>{assert.equal(b.includes(PNG),false,file);assert.equal(b.includes(preview),false,file);});
});
test('shared image stays available until last actual item reference; other projects remain unchanged',t=>{
 const f=fixture(t),u1=f.ideas.uploadImage('P',{opId:U.uuid(),name:'CANARY-unique-name.png'},PNG),u2=f.ideas.uploadImage('P',{opId:U.uuid(),name:'independent.png'},PNG),a=f.add('victim',{images:[u1.image.id]}),b=f.add('keep',{images:[u2.image.id]});
 fs.mkdirSync(path.join(f.root,'Q'));f.ideas.add('Q',{opId:U.uuid(),text:'other project'});const q=fs.readFileSync(f.ideas.resolve('Q').file);
 f.ideas.erase('P',request(f,a.id));assert.deepEqual(f.ideas.image('P',u2.image.id).bytes,PNG);absent(f.root,'CANARY-unique-name');assert.deepEqual(fs.readFileSync(f.ideas.resolve('Q').file),q);
 f.ideas.erase('P',request(f,b.id));for(const file of files(path.join(f.root,'_hub')))decoded(fs.readFileSync(file),bytes=>assert.equal(bytes.includes(PNG),false,file));
});
test('every cleanup boundary resumes forward; shared fixed material is invalidated and late results cannot restore an item',t=>{
 const f=fixture(t),a=f.add('CANARY-artifact',{intent:'build'}),b=f.add('keep',{intent:'build'}),s=f.ideas.resolve('P'),run=U.uuid(),review=U.uuid(),evidence=U.uuid();
 for(const [relative,bytes] of Object.entries({['runs/'+run+'.json']:U.bytes({schema:1,runId:run,targets:[{itemId:a.id}],items:[{id:a.id,text:'CANARY-artifact'}]}),['reviews/'+review+'/bundle.json']:U.bytes({schema:1,id:review,items:[{id:a.id,text:'CANARY-artifact'},{id:b.id,text:'keep'}]}),['reviews/'+review+'/diff.patch']:'CANARY-artifact',['reviews/'+review+'/history.txt']:'CANARY-artifact',['verification/'+evidence+'/stdout']:'CANARY-artifact',['verification/'+evidence+'/stderr']:''})) {const file=path.join(s.controlDir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
 f.ideas.internal('P',U.uuid(),{},d=>{d.runs[run]={id:run,closed:true,targets:[{itemId:a.id}],result:{text:'CANARY-artifact'}};d.reviews[review]={id:review,itemContentRevs:[{itemId:a.id},{itemId:b.id}],findings:['CANARY-artifact']};d.evidence[evidence]={id:evidence,type:'verification',finished:true};d.items[a.id].status='implemented';d.items[a.id].implementation={verificationId:evidence};d.items[b.id].evidence=[{id:review,type:'review'}];d.releases.x={id:'x',state:'ready',rev:1,items:[{itemId:a.id}],manifest:{text:'CANARY-artifact'}};});
 f.ideas.backup('P',{opId:U.uuid()});const op=request(f,a.id);let writes=0,i=f.ideas;
 for(let n=0;n<200;n++) {
   i.fault=stage=>{if(stage==='erase-file'||stage==='erase-projection'){writes++;throw Error('boundary');}};
   const r=n===0?(()=>{try{return i.erase('P',op);}catch(e){assert.equal(e.saved,'unknown');return {saved:'unknown'};}})():i.receipt('P',op.opId);
   if(r.saved===true)break;
   assert.equal(r.saved,'unknown');i=f.restart();
   if(n===199)assert.fail('recovery did not finish');
 }
 assert.ok(writes>10);assert.equal(i.receipt('P',op.opId).deleted,true);absent(f.root,'CANARY-artifact');assert.deepEqual(i.read('P').items[b.id].evidence,[]);assert.equal(i.read('P').releases.x.state,'stale');
});
for(const point of ['ledger','control','index'])test('unfinished backup '+point+' cannot retain or restore erased content',t=>{
 const f=fixture(t),a=f.add('CANARY-partial-'+point),s=f.ideas.resolve('P'),run=U.uuid(),file=path.join(s.controlDir,'runs',run+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,U.bytes({schema:1,runId:run,targets:[{itemId:a.id}],items:[{id:a.id,text:'CANARY-partial-'+point}]}));
 let fired=false;f.ideas.fault=(stage,detail)=>{if(stage==='staging'&&detail.file.includes('/backups/')&&(point==='ledger'&&path.basename(detail.file)==='ledger'||point==='control'&&detail.file.includes('/control/runs/')||point==='index'&&path.basename(detail.file)==='backup.json')){fired=true;throw Error('backup interruption');}};
 assert.throws(()=>f.ideas.backup('P',{opId:U.uuid()}));assert.equal(fired,true);f.ideas.fault=()=>{};
 assert.equal(f.ideas.erase('P',request(f,a.id)).deleted,true);absent(f.root,'CANARY-partial-'+point);assert.equal(f.restart().view('P').total,0);
});
test('captured long source, snapshots, old withdrawn item and blob disappear without changing the source conversation',t=>{
 const f=fixture(t),source={capture:'verified',task:'main',snapshots:[{role:'user',text:'CANARY-context'}]},text='CANARY-long-source'.repeat(5000),a=f.ideas.add('P',{opId:U.uuid(),text},{human:true,source}),s=f.ideas.resolve('P');
 f.ideas.internal('P',U.uuid(),{},d=>{d.items[a.id].source={...d.items[a.id].source,...source};d.items[a.id].status='withdrawn';d.items[a.id].grant=null;});
 const conversation=path.join(f.root,'conversation.jsonl');fs.writeFileSync(conversation,'original source conversation');assert.ok(files(s.controlDir).some(f=>f.includes('/blobs/')));
 f.ideas.backup('P',{opId:U.uuid()});f.ideas.erase('P',request(f,a.id));absent(f.root,'CANARY-');assert.equal(fs.readFileSync(conversation,'utf8'),'original source conversation');
});
test('unbound legacy and failed verification logs are shared; a separately bound check remains intact',t=>{
 const f=fixture(t),a=f.add('CANARY-failed-check'),b=f.add('keep'),s=f.ideas.resolve('P'),shared=U.uuid(),independent=U.uuid();
 for(const [id,text] of [[shared,'CANARY-failed-check'],[independent,'independent output']]){const dir=path.join(s.controlDir,'verification',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'stdout'),text);fs.writeFileSync(path.join(dir,'stderr'),'');}
 f.ideas.internal('P',U.uuid(),{},d=>{d.evidence[shared]={id:shared,type:'verification',finished:true,success:false};d.evidence[independent]={id:independent,type:'verification',finished:true,success:true,itemIds:[b.id]};d.items[b.id].implementation={verificationId:shared};d.items[b.id].evidence=[{type:'verification',id:shared}];});
 f.ideas.erase('P',request(f,a.id));absent(f.root,'CANARY-failed-check');const d=f.ideas.read('P');assert.equal(d.items[b.id].implementation.verificationInvalidated,true);assert.equal(d.evidence[independent].success,true);assert.equal(fs.readFileSync(path.join(s.controlDir,'verification',independent,'stdout'),'utf8'),'independent output');
});

function preserved(t,text='# 古い手書き帳\n\n- unrelated original\n') {
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),text);
 const add=text=>f.ideas.add('P',{opId:U.uuid(),text,intent:'record'},{human:true,source:{capture:'verified',task:'main'}});
 const a=add('PRESERVED-DELETE-ONE\nbody'),b=add('PRESERVED-DELETE-TWO'),keep=add('kept new item');
 return {...f,a,b,keep,text,add};
}
test('initial preserved unrelated markdown survives two erasures, backups, relocation, restart and all later projections byte-for-byte',t=>{
 const f=preserved(t),s=f.ideas.resolve('P'),old=Buffer.from(f.text),keep=f.ideas.read('P').items[f.keep.id];
 assert.equal(f.ideas.read('P').projection.existingHash,U.hash(old));assert.equal(f.ideas.eraseAvailability('P',f.a.id).allowed,true);
 const backup=f.ideas.backup('P',{opId:U.uuid()});f.ideas.relocate('P',{opId:U.uuid(),confirm:true,...backup});
 f.ideas.erase('P',request(f,f.a.id));assert.deepEqual(fs.readFileSync(s.md),old);
 let ideas=f.restart();assert.equal(ideas.eraseAvailability('P',f.b.id).allowed,true);ideas.erase('P',request(f,f.b.id));
 assert.deepEqual(ideas.read('P').items[f.keep.id],keep);assert.equal(ideas.read('P').projection.hash,undefined);
 // Relocation and erasure carry preservation provenance, never generated ownership.
 assert.equal(ideas.read('P').projection.preservedOrigin.hash,U.hash(old));
 for(const file of files(f.root))if(path.basename(file)==='アイデア帳.md')assert.deepEqual(fs.readFileSync(file),old);
 ideas.add('P',{opId:U.uuid(),text:'later note',intent:'record'},{human:true});
 assert.deepEqual(fs.readFileSync(s.md),old);for(const file of files(f.root))if(path.basename(file)==='preserved-markdown.json')assert.deepEqual(Buffer.from(JSON.parse(fs.readFileSync(file)).base64,'base64'),old);
 absent(f.root,'PRESERVED-DELETE-');
});
test('preserved original is retained through an interrupted erasure and subsequent ordinary mutation at the same binding',t=>{
 const f=preserved(t),s=f.ideas.resolve('P'),op=request(f,f.a.id);let once=false;
 f.ideas.fault=stage=>{if(stage==='erase-file'&&!once){once=true;throw Error('interrupt');}};
 assert.throws(()=>f.ideas.erase('P',op),e=>e.saved==='unknown');const ideas=f.restart();assert.equal(ideas.receipt('P',op.opId).deleted,true);
 const i=ideas.read('P').items[f.keep.id];ideas.update('P',{opId:U.uuid(),id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,change:{category:'bug'}});
 assert.deepEqual(fs.readFileSync(s.md),Buffer.from(f.text));assert.equal(ideas.view('P').projection.hash,undefined);assert.equal(ideas.erase('P',op).deleted,true);
});
test('later hand edits and target-bearing or unproven preserved markdown remain protected without an erasure journal',t=>{
 for(const mode of ['hand-edit','full','heading','id','unverified','lost-origin']) {
   const raw=mode==='full'?'PRESERVED-DELETE-ONE\nbody':mode==='heading'?'# PRESERVED-DELETE-ONE':undefined;
   const f=preserved(t,raw),s=f.ideas.resolve('P');
   if(mode==='hand-edit')fs.appendFileSync(s.md,'\nlater unrelated edit');
   if(mode==='id')fs.writeFileSync(s.md,f.text+f.a.id);
   if(mode==='unverified')f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.a.id].source.capture='none';});
   if(mode==='lost-origin') { // retained current existingHash alone is insufficient
     const dir=path.join(f.ideas.control,'transactions',U.hash(s.file));fs.rmSync(dir,{recursive:true});
   }
   const bytes=fs.readFileSync(s.md),before=fs.readFileSync(s.file);assert.equal(f.ideas.eraseAvailability('P',f.a.id).allowed,false,mode);
   assert.throws(()=>f.ideas.erase('P',request(f,f.a.id)),{code:'erase-markdown'});assert.deepEqual(fs.readFileSync(s.md),bytes);assert.deepEqual(fs.readFileSync(s.file),before);assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false);
 }
});

function confirmation(f,id,choose=()=>[]) {
 const availability=f.ideas.eraseAvailability('P',id),review=availability.markdownReview;
 assert.equal(availability.code,'erase-markdown');assert.ok(review.documents.length);
 return {token:review.token,confirmed:true,documents:review.documents.map(d=>({hash:d.hash,removeLines:choose(d)}))};
}
test('manual markdown reconciliation preserves unrelated original for direct typed and unverified sources without touching preview data',t=>{
 for(const capture of ['none','unverified']){
  const f=preserved(t),s=f.ideas.resolve('P');f.ideas.internal('P',U.uuid(),{},d=>{d.items[f.a.id].source={capture};});
  const old=fs.readFileSync(s.md),ledger=fs.readFileSync(s.file),review=confirmation(f,f.a.id);
  assert.deepEqual(fs.readFileSync(s.md),old);assert.deepEqual(fs.readFileSync(s.file),ledger);
  assert.equal(f.ideas.erase('P',{...request(f,f.a.id),markdownReview:review}).deleted,true);
  assert.deepEqual(fs.readFileSync(s.md),old);assert.equal(f.ideas.read('P').items[f.a.id],undefined);
  f.ideas.add('P',{opId:U.uuid(),text:'later save'},{human:true});assert.deepEqual(fs.readFileSync(s.md),old);
 }
});
test('manual reconciliation deletes only confirmed target lines in all raw/wrapped copies and preserves CRLF, other records and later writes',t=>{
 const f=fixture(t),a=f.add('REVIEW-PRIVATE-CANARY'),b=f.add('KEEP-RAW-EXACT'),s=f.ideas.resolve('P'),kept=f.ideas.read('P').items[b.id];
 const original=Buffer.from('# 手書き帳\r\n別の原文を保持\r\nREVIEW-PRIVATE-CANARY\r\nKEEP-RAW-EXACT\r\n末尾の未登録原文');fs.writeFileSync(s.md,original);
 f.ideas.backup('P',{opId:U.uuid()});const review=confirmation(f,a.id,d=>d.targetLines),op={...request(f,a.id),markdownReview:review};
 assert.equal(f.ideas.erase('P',op).deleted,true);const expected=Buffer.from('# 手書き帳\r\n別の原文を保持\r\nKEEP-RAW-EXACT\r\n末尾の未登録原文');
 assert.deepEqual(fs.readFileSync(s.md),expected);assert.deepEqual(f.ideas.read('P').items[b.id],kept);absent(f.root,'REVIEW-PRIVATE-CANARY');
 assert.equal(f.restart().erase('P',op).deleted,true);f.add('later');assert.deepEqual(fs.readFileSync(s.md),expected);
});
test('manual reconciliation refuses mixed target and kept lines in live originals and retained backups before intent',t=>{
 for(const mode of ['live-lf','live-crlf','backup-only','overlapping-text']){
  const f=fixture(t),a=f.add('DELETE-PRIVATE'),b=f.add(mode==='overlapping-text'?'DELETE-PRIVATE-KEEP':'KEEP-OTHER'),s=f.ideas.resolve('P');
  const eol=mode==='live-crlf'?'\r\n':'\n';
  fs.writeFileSync(s.md,['original header',`DELETE-PRIVATE ${f.ideas.read('P').items[b.id].text}`,'unregistered original'].join(eol));
  if(mode==='backup-only'){
   f.ideas.backup('P',{opId:U.uuid()});
   fs.writeFileSync(s.md,'original header\nDELETE-PRIVATE\nKEEP-OTHER\n');
  }
  const before=new Map(files(f.root).map(file=>[file,fs.readFileSync(file)]));
  const availability=f.ideas.eraseAvailability('P',a.id);
  assert.equal(availability.allowed,false,mode);assert.equal(availability.code,'erase-markdown-mixed',mode);
  assert.equal(availability.markdownReview,undefined,mode);
  assert.throws(()=>f.ideas.erase('P',{...request(f,a.id),markdownReview:{confirmed:true,token:'old-or-forged',documents:[]}}),{code:'erase-markdown-mixed'},mode);
  assert.deepEqual(files(f.root).sort(),[...before.keys()].sort(),mode);
  for(const [file,bytes] of before)assert.deepEqual(fs.readFileSync(file),bytes,mode+': '+file);
  assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false,mode);
 }
});
test('manual reconciliation rejects stale inventories, unconfirmed/partial decisions, protected lines and whole unknown deletion before intent',t=>{
 for(const mode of ['no-confirm','stale-raw','stale-ledger','missing-doc','duplicate','target-left','protected','whole','bad-line','busy']){
  const f=fixture(t),a=f.add('TARGET-ONLY'),b=f.add('KEEP-OTHER'),s=f.ideas.resolve('P');
  fs.writeFileSync(s.md,mode==='whole'?'unknown one\nunknown two\n':'original header\nTARGET-ONLY\nKEEP-OTHER\n');
  const review=confirmation(f,a.id,d=>d.targetLines),doc=review.documents[0];
  if(mode==='no-confirm')review.confirmed=false;
  if(mode==='stale-raw')fs.appendFileSync(s.md,'concurrent original');
  if(mode==='stale-ledger')f.add('concurrent note');
  if(mode==='missing-doc')review.documents=[];
  if(mode==='duplicate')doc.removeLines=[2,2];
  if(mode==='target-left')doc.removeLines=[];
  if(mode==='protected')doc.removeLines.push(3);
  if(mode==='whole')doc.removeLines=[1,2];
  if(mode==='bad-line')doc.removeLines.push(1000);
  if(mode==='busy')f.ideas.internal('P',U.uuid(),{},d=>{d.evidence.busy={type:'verification',finished:false};});
  const before=fs.readFileSync(s.file),raw=fs.readFileSync(s.md);assert.throws(()=>f.ideas.erase('P',{...request(f,a.id),markdownReview:review}));
  assert.deepEqual(fs.readFileSync(s.file),before,mode);assert.deepEqual(fs.readFileSync(s.md),raw,mode);assert.equal(fs.existsSync(path.join(s.controlDir,'erase-intent.json')),false,mode);
 }
});
test('exact single target body may be erased after review, while ambiguous full originals stay protected',t=>{
 const f=fixture(t),a=f.add('ONLY-TARGET'),s=f.ideas.resolve('P');fs.writeFileSync(s.md,'ONLY-TARGET');
 const review=confirmation(f,a.id,d=>d.targetLines);assert.equal(f.ideas.erase('P',{...request(f,a.id),markdownReview:review}).deleted,true);assert.equal(fs.readFileSync(s.md).length,0);absent(f.root,'ONLY-TARGET');
});

test('reviewed legacy unknown lines are scrubbed from preserved imports and ledger unknown indexes without changing other legacy entries',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),'# 未着手\r\n- KEEP-LEGACY\r\nIMPORT-PRIVATE-CANARY\r\n未登録の原文を保持');
 f.ideas.initialize('P',U.uuid(),{importLegacy:true});const a=f.add('IMPORT-PRIVATE-CANARY'),s=f.ideas.resolve('P'),kept=Object.values(f.ideas.read('P').items).find(i=>i.text==='KEEP-LEGACY'),before=f.ideas.read('P').items[kept.id];
 f.ideas.backup('P',{opId:U.uuid()});const review=confirmation(f,a.id,d=>d.targetLines),op={...request(f,a.id),markdownReview:review};
 assert.equal(f.ideas.erase('P',op).deleted,true);assert.deepEqual(f.ideas.read('P').items[kept.id],before);absent(f.root,'IMPORT-PRIVATE-CANARY');assert.equal(f.restart().erase('P',op).deleted,true);assert.equal(fs.readFileSync(s.md,'utf8'),'# 未着手\r\n- KEEP-LEGACY\r\n未登録の原文を保持');
});
test('different unknown originals in backup and current source each require confirmation and preserve their own unmatched bytes',t=>{
 const f=fixture(t),a=f.add('MULTI-TARGET'),s=f.ideas.resolve('P');f.add('KEPT-MULTI');fs.writeFileSync(s.md,'first original\nMULTI-TARGET\n');f.ideas.backup('P',{opId:U.uuid()});fs.writeFileSync(s.md,'second original\r\nMULTI-TARGET\r\n');
 const review=confirmation(f,a.id,d=>d.targetLines);assert.equal(review.documents.length,2);assert.equal(f.ideas.erase('P',{...request(f,a.id),markdownReview:review}).deleted,true);assert.equal(fs.readFileSync(s.md,'utf8'),'second original\r\n');
 const wrapped=files(path.join(f.ideas.control,'backups')).filter(file=>path.basename(file)==='markdown');assert.ok(wrapped.length);for(const file of wrapped)assert.equal(Buffer.from(JSON.parse(fs.readFileSync(file)).base64,'base64').toString(),'first original\n');absent(f.root,'MULTI-TARGET');
});

for(const eol of ['\n','\r\n'])test(`import line identities survive repeated reviewed deletion and divergent live edits (${JSON.stringify(eol)})`,t=>{
 const f=fixture(t),original=['# 未着手','FIRST-INDEX-CANARY','- LATER-INDEX-CANARY','THIRD-INDEX-CANARY','KEEP-INDEX-TAIL'].join(eol);fs.writeFileSync(path.join(f.dir,'アイデア帳.md'),original);
 f.ideas.initialize('P',U.uuid(),{importLegacy:true});const first=f.add('FIRST-INDEX-CANARY'),third=f.add('THIRD-INDEX-CANARY'),kept=f.add('KEEP-INDEPENDENT'),snapshot=f.ideas.read('P').items[kept.id];
 const s=f.ideas.resolve('P'),later=Object.values(f.ideas.read('P').items).find(i=>i.text==='LATER-INDEX-CANARY'),source=U.clone(later.source),importFile=path.join(s.controlDir,'imports',source.hash+'.md');f.ideas.backup('P',{opId:U.uuid()});
 const erase=id=>{const op={...request(f,id),markdownReview:confirmation(f,id,d=>d.targetLines)};assert.equal(f.ideas.erase('P',op).deleted,true);return op;};
 erase(first.id);assert.deepEqual(f.ideas.read('P').items[later.id].source,source);assert.equal(fs.readFileSync(importFile,'utf8'),['# 未着手','','- LATER-INDEX-CANARY','THIRD-INDEX-CANARY','KEEP-INDEX-TAIL'].join(eol));
 f.ideas.backup('P',{opId:U.uuid()});fs.appendFileSync(s.md,eol+'ADDED-LIVE-ONLY');
 erase(later.id);const op=erase(third.id),expected=['# 未着手','','','','KEEP-INDEX-TAIL'].join(eol);
 assert.equal(fs.readFileSync(importFile,'utf8'),expected);assert.deepEqual(f.ideas.read('P').imports[source.hash].unknown,[{line:5,text:'KEEP-INDEX-TAIL'}]);assert.deepEqual(f.ideas.read('P').items[kept.id],snapshot);
 for(const file of files(path.join(f.ideas.control,'backups')).filter(file=>file.endsWith('/control/imports/'+source.hash+'.md')))assert.equal(Buffer.from(JSON.parse(fs.readFileSync(file)).base64,'base64').toString(),expected);
 for(const canary of ['FIRST-INDEX-CANARY','LATER-INDEX-CANARY','THIRD-INDEX-CANARY'])absent(f.root,canary);
 const live=fs.readFileSync(s.md);assert.equal(live.includes(Buffer.from('ADDED-LIVE-ONLY')),true);assert.equal(f.restart().erase('P',op).deleted,true);f.add('later normal save');assert.deepEqual(fs.readFileSync(s.md),live);
});
