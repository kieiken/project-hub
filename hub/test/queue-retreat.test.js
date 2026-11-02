'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const U=require('../lib/idea-utils'),{Ideas}=require('../lib/ideas'),{ChatRunner}=require('../lib/chat'),{QueueRetreat,version}=require('../lib/queue-retreat'),start=require('../lib/start');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=','base64');
function largePNG(){
 const chunk=(type,bytes)=>{const name=Buffer.from(type),data=Buffer.concat([name,bytes]);let crc=0xffffffff;for(const b of data){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);data.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const width=6400,h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(width,4);h[8]=8;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',require('node:zlib').deflateSync(Buffer.alloc((width+1)*width))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'queue-retreat-'))),p={id:'P',dir:path.join(root,'Product/P'),tasks:[{id:'main'},{id:'other'}]},free={id:'freetalk',kind:'freetalk',dir:path.join(root,'free'),tasks:[{id:'main'}]};fs.mkdirSync(path.join(p.dir,'.ai/chat'),{recursive:true});
 const store={root,readProject:id=>id==='P'?p:id==='freetalk'?free:null,listProjects:()=>[p,free]};let ideas,chats,transfer;const actions=new Set();
 const reopen=()=>{ideas?.close();ideas=new Ideas({store});chats=new ChatRunner({dirOf:id=>store.readProject(id)?.dir,spoolRoot:path.join(root,'spool'),queueGuard:o=>transfer.guard(o)});transfer=new QueueRetreat({ideas,chats,actions});};reopen();
 const q=(text='元の指示',more={})=>({id:U.uuid(),text,ai:'codex',model:'gpt-6.1-sol',images:[],...more});
 const seed=(rows,task='main')=>chats.setQueue('P',task,rows,true);
 const body=item=>({project:'P',task:'main',id:item.id,opId:U.uuid(),expected:version(item)});
 const image=(bytes=PNG,ext='png')=>{const id=U.uuid()+'.'+ext,file=start.imageFile(p,id);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);if(ext!=='png')fs.writeFileSync(start.imageFile(p,id,true),PNG);return {id,file,block:'\n\n参照画像（絶対パス）：\n'+start.imageFile(p,id,true)};};
 t.after(()=>ideas.close());return {root,p,store,get ideas(){return ideas;},get chats(){return chats;},get transfer(){return transfer;},actions,reopen,q,seed,body,image};
}
test('normal/delegate: server snapshot, record-only receipt, exact selected removal and same-op retry',t=>{
 const f=fixture(t),a=f.q('第一\n全文'),b=f.q('実行全文\n追加の約束',{origin:'delegate',shown:'表示全文',account:'reference',effort:'high'});f.seed([a,b]);const active={request:'unrelated',options:{project:'P',task:'main'}};f.chats.running.set(f.chats.key('P','main'),active);
 const before=U.hash(f.ideas.read('P').settings),x=f.body(b),r=f.transfer.transfer(x);assert.equal(r.complete,true);assert.equal(r.saved,true);assert.deepEqual(f.chats.queue('P','main'),[a]);assert.equal(f.chats.busy('P','main'),active);
 const i=f.ideas.read('P').items[r.id];assert.equal(i.text,b.text);assert.deepEqual(i.source.queue,b);assert.equal(i.source.kind,'queue');assert.equal(i.intent,'record');assert.equal(i.grant,null);assert.equal(i.category,'note');assert.equal(i.organizationRequested,false);assert.equal(U.hash(f.ideas.read('P').settings),before);
 assert.equal(f.transfer.transfer(x).id,r.id);assert.equal(f.transfer.receipt(x).complete,true);assert.equal(Object.keys(f.ideas.read('P').items).length,1);assert.throws(()=>f.transfer.transfer({...x,opId:U.uuid()}),e=>e.code==='op-conflict');
 f.transfer.transfer(f.body(a));assert.equal(Object.keys(f.ideas.read('P').items).length,2);assert.equal(f.chats.queue('P','main').length,0);assert.throws(()=>f.seed([b]),e=>e.code==='queue-retreat');
});
test('images: multiple and image-only canonical references copy ORIGINAL bytes, metadata/old-block compatibility, originals retained',t=>{
 const f=fixture(t),a=f.image(),gif=Buffer.from('R0lGODdhAgACAIEAAFpujAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7','base64'),b=f.image(gif,'gif');
 for(const modern of [false,true]){const q=f.q(a.block+'\n'+start.imageFile(f.p,b.id,true),modern?{projectImages:[a.id,b.id]}:{});f.seed([q]);const r=f.transfer.transfer(f.body(q)),i=f.ideas.read('P').items[r.id];assert.equal(i.images.length,2);assert.deepEqual(f.ideas.image('P',i.images[0].id).bytes,PNG);assert.deepEqual(f.ideas.image('P',i.images[1].id).bytes,gif);assert.deepEqual(fs.readFileSync(b.file),gif);}
});
for(const [label,bytes,code] of [['oversized',largePNG(),'image-dimensions'],['corrupt',PNG.subarray(0,8),'image-decode']])for(const later of [false,true])test('image rejection '+label+(later?' after valid image':' first')+': no fence, original remains editable/cancellable/startable after restart',t=>{
 const f=fixture(t),good=f.image(),bad=start.saveImage(f.p,'rejected.png',bytes),ids=[...(later?[good.id]:[]),bad.id],q=f.q('原文を保全\n\n参照画像（絶対パス）：\n'+ids.map(id=>start.imageFile(f.p,id,true)).join('\n'),{projectImages:ids}),other=f.q('他の待ち指示'),b=f.body(q);
 f.seed([q,other]);f.seed([other],'other');const settings=U.hash(f.ideas.read('P').settings);
 const retained=()=>{assert.deepEqual(f.chats.queue('P','main'),[q,other]);assert.deepEqual(f.chats.queue('P','other'),[other]);assert.equal(f.ideas.view('P').total,0);assert.equal(f.transfer.record('P','main',q.id),undefined);assert.equal(f.ideas.receipt('P',b.opId).saved,false);assert.equal(f.transfer.receipt(b).state,'absent');assert.deepEqual(fs.readFileSync(bad.path),bytes);assert.deepEqual(fs.readFileSync(good.file),PNG);assert.doesNotThrow(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}));assert.equal(U.hash(f.ideas.read('P').settings),settings);};
 assert.throws(()=>f.transfer.transfer(b),e=>e.code===code);retained();f.reopen();assert.deepEqual(f.transfer.restore(),[]);retained();assert.throws(()=>f.transfer.transfer(b),e=>e.code===code);retained();
 // Cancellation and editing are actual queue operations, never model execution.
 f.chats.unqueue('P','main',q.id);assert.deepEqual(f.chats.queue('P','main'),[other]);f.seed([q,other]);
 const edited={...q,text:'画像を直した原文'+good.block,projectImages:[good.id]};f.seed([edited,other]);const corrected={...b,expected:version(edited)},r=f.transfer.transfer(corrected);assert.equal(r.complete,true);assert.equal(f.transfer.transfer(corrected).id,r.id);assert.equal(f.ideas.view('P').total,1);assert.deepEqual(f.chats.queue('P','main'),[other]);assert.deepEqual(fs.readFileSync(bad.path),bytes);assert.deepEqual(f.ideas.image('P',f.ideas.read('P').items[r.id].images[0].id).bytes,PNG);
});
for(const stage of ['image-original','image-preview','intent','rename'])test('image acceptance '+stage+' failure before prepared leaves queue usable and no item receipt',t=>{
 const f=fixture(t),a=f.image(),q=f.q(a.block),other=f.q('other'),b=f.body(q);f.seed([q,other]);f.ideas.initialize('P',U.uuid());let fired=false;
 f.ideas.fault=(at,{file})=>{if(!fired&&at===stage&&(stage.startsWith('image-')||file.endsWith('ideas.json'))){fired=true;throw Error('image acceptance '+stage);}};
 assert.throws(()=>f.transfer.transfer(b));f.ideas.fault=()=>{};assert.equal(fired,true);f.reopen();assert.deepEqual(f.transfer.restore(),[]);assert.equal(f.transfer.receipt(b).state,'absent');assert.doesNotThrow(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}));assert.equal(f.ideas.view('P').total,0);assert.deepEqual(f.chats.queue('P','main'),[q,other]);assert.deepEqual(fs.readFileSync(a.file),PNG);
 assert.equal(f.transfer.transfer(b).complete,true);assert.equal(f.ideas.view('P').total,1);assert.deepEqual(f.chats.queue('P','main'),[other]);
});
for(const stage of ['prepared','before-save','saved'])test('accepted image '+stage+' failure retains durable fence and reuses image operation on restart',t=>{
 const f=fixture(t),a=f.image(),q=f.q(a.block),other=f.q('other'),b=f.body(q);f.seed([q,other]);f.transfer.fault=at=>{if(at===stage)throw Error('image boundary '+stage);};assert.throws(()=>f.transfer.transfer(b));
 const d=f.ideas.read('P'),ids=Object.keys(d.images);assert.equal(ids.length,1);assert.equal(f.transfer.receipt(b).saved,stage==='saved');assert.throws(()=>f.chats.unqueue('P','main',q.id),e=>e.code==='queue-retreat');assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');
 f.reopen();assert.deepEqual(f.transfer.restore(),[]);const r=f.transfer.transfer(b);assert.equal(r.complete,true);assert.deepEqual(Object.keys(f.ideas.read('P').images),ids);assert.equal(f.ideas.view('P').total,1);assert.deepEqual(f.chats.queue('P','main'),[other]);assert.deepEqual(fs.readFileSync(a.file),PNG);
});
test('reject management/freetalk/stale/started/preparing evidence without modifying queue or ledger',t=>{
 const f=fixture(t),flags=[{automation:{kind:'idea'}},{readOnly:true},{selectionOnly:true},{limitSwitch:{}},{resultsOrganize:{}},{isolatedReview:true},{integrationAssignment:{}},{id:'limit-test'},{id:'discussion-test'},{origin:'internal'}];
 for(const flag of flags){const q=f.q('保護',flag);f.seed([q]);assert.throws(()=>f.transfer.transfer(f.body(q)),e=>e.code==='queue-managed');assert.deepEqual(f.chats.queue('P','main'),[q]);}
 const q=f.q();f.seed([q]);const b=f.body(q);assert.throws(()=>f.transfer.transfer({...b,project:'freetalk'}),e=>e.code==='project');assert.throws(()=>f.transfer.transfer({...b,expected:version({...q,text:'old'})}),e=>e.code==='queue-changed');
 f.actions.add(f.chats.key('P','main'));assert.throws(()=>f.transfer.transfer(b),e=>e.code==='queue-starting');f.actions.clear();
 for(const key of ['request','options']){f.chats.running.set(f.chats.key('P','main'),key==='request'?{request:q.id}:{options:{request:q.id},pending:true});assert.throws(()=>f.transfer.transfer(b),e=>e.code==='queue-starting');f.chats.running.clear();}
 const spool=path.join(f.chats.spoolRoot,'run');fs.mkdirSync(spool,{recursive:true});fs.writeFileSync(path.join(spool,'request.json'),JSON.stringify({options:{project:'P',task:'main',request:q.id}}));assert.throws(()=>f.transfer.transfer(b),e=>e.code==='queue-started');fs.unlinkSync(path.join(spool,'request.json'));
 require('../lib/chat').append(f.p.dir,'main',{role:'user',request:q.id,text:q.text});assert.throws(()=>f.transfer.transfer(b),e=>e.code==='queue-started');assert.equal(f.ideas.view('P').total,0);
});
test('attachments: missing/foreign/mismatched/symlink/hardlink/unsupported do not remove source; prose paths never opened',t=>{
 const f=fixture(t),a=f.image(),outside=path.join(f.root,'private.png');fs.writeFileSync(outside,PNG);
 const variants=[f.q('\n\n参照画像（絶対パス）：\n'+outside),f.q(a.block,{projectImages:[]}),f.q('\n\n参照画像（絶対パス）：\n'),f.q('file\n\n参照ファイル・画像（絶対パス）：\n'+outside),f.q(a.block,{images:['old-unowned']}),f.q('\n\n参照画像（絶対パス）：\n'+start.imageFile(f.p,U.uuid()+'.png',true))];
 for(const q of variants){f.seed([q]);assert.throws(()=>f.transfer.transfer(f.body(q)));assert.deepEqual(f.chats.queue('P','main'),[q]);}
 fs.unlinkSync(a.file);fs.symlinkSync(outside,a.file);const q=f.q(a.block);f.seed([q]);assert.throws(()=>f.transfer.transfer(f.body(q)),/リンク/);fs.unlinkSync(a.file);fs.linkSync(outside,a.file);assert.throws(()=>f.transfer.transfer(f.body(q)));fs.unlinkSync(a.file);fs.writeFileSync(a.file,'not image');assert.throws(()=>f.transfer.transfer(f.body(q)));
 const prose=f.q('このパスは文字だけ '+outside);f.seed([prose]);assert.equal(f.ideas.read('P').images,undefined);f.transfer.transfer(f.body(prose));assert.equal(f.ideas.read('P').images,undefined);
});
for(const boundary of ['prepared','before-save','saved','removed'])test('durable boundary '+boundary+': failure preserves source, blocks edit/cancel/manual/auto, cold boot completes once',async t=>{
 const f=fixture(t),q=f.q(),other=f.q('別の指示');f.seed([q,other]);const b=f.body(q);f.transfer.fault=stage=>{if(stage===boundary)throw Error('fixture '+stage);};assert.throws(()=>f.transfer.transfer(b),/fixture/);
 const before=f.chats.queue('P','main');if(boundary!=='removed')assert.ok(before.some(x=>x.id===q.id));
 assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');await assert.rejects(f.chats.send({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');
 if(boundary!=='removed'){assert.throws(()=>f.chats.unqueue('P','main',q.id),e=>e.code==='queue-retreat');assert.throws(()=>f.seed([{...q,text:'edit'},other]),e=>e.code==='queue-retreat');}
 assert.doesNotThrow(()=>f.chats.assertQueueStart({project:'P',task:'other',request:'unrelated'}));f.reopen();assert.deepEqual(f.transfer.restore(),[]);const r=f.transfer.transfer(b);assert.equal(r.complete,true);assert.equal(Object.keys(f.ideas.read('P').items).length,1);assert.deepEqual(f.chats.queue('P','main'),[other]);assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');
});
test('queue disk failure: receipt durable but entry remains fenced; recovery does not touch other queues or stop version',t=>{
 const f=fixture(t),q=f.q(),other=f.q('other');f.seed([q]);f.seed([other],'other');const b=f.body(q),old=fs.openSync,queueFile=path.join(f.p.dir,'.ai/chat/main.queue.json.intent.json.tmp');fs.openSync=function(file,...args){if(String(file)===queueFile)throw Error('fixture queue disk');return old.call(this,file,...args);};
 try{assert.throws(()=>f.transfer.transfer(b),/fixture queue disk/);}finally{fs.openSync=old;}
 assert.equal(f.transfer.receipt(b).saved,true);assert.equal(f.transfer.receipt(b).complete,false);assert.deepEqual(f.chats.queue('P','main'),[q]);assert.equal(f.chats.stops.size,0);f.reopen();assert.deepEqual(f.transfer.restore(),[]);assert.deepEqual(f.chats.queue('P','other'),[other]);assert.equal(f.chats.stops.size,0);
});
for(const stage of ['staging','intent','rename','directory-sync'])test('ledger '+stage+' failure: before acknowledgement retain queue; intent fence recovered before launch',t=>{
 const f=fixture(t),q=f.q();f.seed([q]);f.ideas.initialize('P',U.uuid());const b=f.body(q);let fired=false;f.ideas.fault=(at,{file})=>{if(at===stage&&file.endsWith('ideas.json')&&!fired){fired=true;throw Error('fixture '+stage);}};assert.throws(()=>f.transfer.transfer(b),/fixture/);f.ideas.fault=()=>{};assert.deepEqual(f.chats.queue('P','main'),[q]);
 if(stage!=='staging')assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');
 f.reopen();assert.deepEqual(f.transfer.restore(),[]);assert.equal(f.transfer.transfer(b).complete,true);assert.equal(f.ideas.view('P').total,1);
});
test('preflight race: pending launch wins, retreat rejected; retreat fence rechecked after preflight',async t=>{
 const f=fixture(t),q=f.q();f.seed([q]);let release,entered=false;f.chats.beforeQueued=()=>{entered=true;return new Promise(r=>release=r);};const launch=f.chats.sendQueued({project:'P',task:'main',request:q.id});await Promise.resolve();assert.equal(entered,true);assert.throws(()=>f.transfer.transfer(f.body(q)),e=>e.code==='queue-starting');
 // A fence appearing during asynchronous preflight is still checked by send().
 const b=f.body(q);f.chats.running.clear();f.transfer.fault=s=>{if(s==='prepared')throw Error('pause');};assert.throws(()=>f.transfer.transfer(b));release();await assert.rejects(launch);assert.equal(require('../lib/chat').read(f.p.dir,'main').length,0);
});
test('failed recovery closes only its directive; receipts/images missing are never treated as unsent or success',t=>{
 const f=fixture(t),a=f.image(),q=f.q(a.block);f.seed([q]);const b=f.body(q);f.transfer.fault=s=>{if(s==='prepared')throw Error('pause');};assert.throws(()=>f.transfer.transfer(b));fs.unlinkSync(a.file);f.reopen();assert.equal(f.transfer.restore().length,1);assert.deepEqual(f.chats.queue('P','main'),[q]);assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}));assert.doesNotThrow(()=>f.chats.assertQueueStart({project:'P',task:'other',request:'else'}));assert.equal(f.ideas.view('P').total,0);
});
test('completed retreat can be erased without exposing retained source snapshots or resurrecting receipt',t=>{
 const f=fixture(t),a=f.image(),q=f.q('erase-canary'+a.block);f.seed([q]);const b=f.body(q),r=f.transfer.transfer(b),i=f.ideas.read('P').items[r.id];f.ideas.erase('P',{opId:U.uuid(),id:i.id,baseContentRev:i.contentRev,baseControlRev:i.controlRev,confirm:true});assert.equal(f.transfer.transfer(b).removed,true);assert.equal(f.ideas.view('P').total,0);assert.throws(()=>f.seed([q]),e=>e.code==='queue-retreat');assert.deepEqual(fs.readFileSync(a.file),PNG);
});
test('automatic dispatch after an active local fixture ends never starts a saved-but-unremoved directive',async t=>{
 const f=fixture(t),q=f.q(),gate=path.join(f.root,'finish'),trace=path.join(f.root,'starts'),script=path.join(f.root,'local-fixture.cjs');f.seed([q]);
 fs.writeFileSync(script,`require('node:fs').appendFileSync(${JSON.stringify(trace)},'1');process.stdin.resume();const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(gate)})){clearInterval(t);console.log(JSON.stringify({type:'turn.completed'}));}},10);`);
 const o={project:'P',task:'main',request:U.uuid(),pdir:f.p.dir,dir:f.root,ai:'codex',model:'gpt-6.1-sol',text:'local fixture',userRow:{turn:U.uuid()}};
 const run=f.chats.run(o,{command:process.execPath,args:[script],stdin:'fixture'},{sessions:{},models:{}},[]);t.after(()=>{if(run.child?.pid)try{process.kill(run.child.pid,'SIGTERM');}catch{}});await run.startedP;
 f.transfer.fault=s=>{if(s==='saved')throw Error('queue removal not reached');};assert.throws(()=>f.transfer.transfer(f.body(q)),/not reached/);fs.writeFileSync(gate,'finish');
 await Promise.race([run.finishedP,new Promise((_,reject)=>setTimeout(()=>reject(Error('local fixture timeout')),5000))]);await new Promise(r=>setTimeout(r,30));
 assert.equal(fs.readFileSync(trace,'utf8'),'1');assert.deepEqual(f.chats.queue('P','main'),[q]);assert.equal(f.chats.busy('P','main'),null);
});
for(const stage of ['staging','intent','rename','directory-sync'])test('item receipt '+stage+' failure resumes same operation without removing or duplicating text',t=>{
 const f=fixture(t),q=f.q('receipt boundary');f.seed([q]);f.ideas.initialize('P',U.uuid());const b=f.body(q);let count=0;
 f.ideas.fault=(at,{file})=>{if(at===stage&&file.endsWith('ideas.json')&&++count===2)throw Error('item '+stage);};assert.throws(()=>f.transfer.transfer(b),/item/);f.ideas.fault=()=>{};
 assert.deepEqual(f.chats.queue('P','main'),[q]);assert.throws(()=>f.chats.assertQueueStart({project:'P',task:'main',request:q.id}),e=>e.code==='queue-retreat');
 f.reopen();assert.deepEqual(f.transfer.restore(),[]);assert.equal(f.transfer.transfer(b).complete,true);assert.equal(f.ideas.view('P').total,1);assert.equal(f.ideas.view('P').items[0].text,q.text);
});
test('server cold boot completes durable retreat before releasing startup barrier and preserves other directives',t=>{
 const f=fixture(t),q=f.q(),other=f.q('keep other task');f.seed([q]);f.seed([other],'other');const b=f.body(q);f.transfer.fault=s=>{if(s==='saved')throw Error('power loss');};assert.throws(()=>f.transfer.transfer(b));f.ideas.close();
 fs.mkdirSync(path.join(f.p.dir,'.ai/tasks'),{recursive:true});fs.writeFileSync(path.join(f.p.dir,'PROJECT.md'),'---\nname: P\nstatus: 進行中\nphases: []\nfolders: {}\n---\n');
 for(const id of ['main','other'])fs.writeFileSync(path.join(f.p.dir,'.ai/tasks',id+'.md'),`---\nid: ${id}\ntitle: ${id}\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] local fixture\n`);
 const script=`const assert=require('node:assert/strict'),r=require(${JSON.stringify(require.resolve('../server'))});r.restoreReady.then(()=>{assert.equal(r.executionGate.barrier,false);assert.equal(r.queueRetreat.receipt(${JSON.stringify(b)}).complete,true);assert.deepEqual(r.chats.queue('P','main'),[]);assert.deepEqual(r.chats.queue('P','other').map(x=>x.id),[${JSON.stringify(other.id)}]);assert.throws(()=>r.chats.assertQueueStart({project:'P',task:'main',request:${JSON.stringify(q.id)}}));assert.equal(r.chats.running.size,0);r.stopControl.cleanExit();r.server.emit('close');console.log('cold boot verified');process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});`;
 const out=require('node:child_process').execFileSync(process.execPath,['-e',script],{encoding:'utf8',timeout:15000,env:{...process.env,HUB_ROOT:f.root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(f.root,'home'),HUB_FREETALK_HOME:path.join(f.root,'free-home')}});
 assert.match(out,/cold boot verified/);
});
test('backup/relocate retain retreat fence, ledger image and hand-edited markdown byte for byte',t=>{
 const f=fixture(t),a=f.image(),q=f.q('保全する原文'+a.block),md=Buffer.from('手で書いた旧帳\n');fs.writeFileSync(path.join(f.p.dir,'アイデア帳.md'),md);f.seed([q]);const b=f.body(q),r=f.transfer.transfer(b),saved=f.ideas.backup('P',{opId:U.uuid()});
 assert.deepEqual(fs.readFileSync(path.join(f.p.dir,'アイデア帳.md')),md);const moved=path.join(f.root,'Product/moved');fs.renameSync(f.p.dir,moved);f.p.dir=moved;
 f.ideas.relocate('P',{opId:U.uuid(),confirm:true,projectUid:saved.projectUid,backupFile:saved.backupFile,backupHash:saved.backupHash});f.reopen();assert.deepEqual(f.transfer.restore(),[]);
 assert.equal(f.transfer.transfer(b).id,r.id);assert.equal(f.ideas.view('P').total,1);assert.deepEqual(f.ideas.image('P',f.ideas.read('P').items[r.id].images[0].id).bytes,PNG);assert.deepEqual(fs.readFileSync(path.join(moved,'アイデア帳.md')),md);
 const preserved=JSON.parse(fs.readFileSync(path.join(f.ideas.resolve('P').dir,'preserved-markdown.json'),'utf8'));assert.deepEqual(Buffer.from(preserved.base64,'base64'),md);assert.throws(()=>f.seed([q]),e=>e.code==='queue-retreat');
});
