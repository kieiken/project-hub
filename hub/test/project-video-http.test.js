'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{Store}=require('../lib/store'),chat=require('../lib/chat'),qe=require('../lib/queue-edit');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-project-video-')),root=path.join(tmp,'root'),dir=path.join(root,'Product','Video'),bin=path.join(tmp,'bin'),key={project:'Video',task:'t'};
fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: Video\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
for(const id of ['t','other'])fs.writeFileSync(path.join(dir,'.ai/tasks',id+'.md'),`---\nid: ${id}\ntitle: Video\nowner: codex\nworkspaceMode: direct\nstate: 実行中\n---\n`);
fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
if(process.argv.includes('--version')){console.log('fake codex');process.exit(0)}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:'video-'+process.pid}));
const finish=()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({input,args:process.argv.slice(2)})}}));console.log(JSON.stringify({type:'turn.completed'}));};
if(input.slice(input.lastIndexOf('# 今回の依頼')).includes('HOLD-VIDEO')){require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp,'started'))},'ok');const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(path.join(tmp,'release'))})){clearInterval(timer);finish();}},20);}else finish();
});`,{mode:0o755});
Object.assign(process.env,{HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_AUTH_DIR:path.join(tmp,'auth'),PATH:bin+path.delimiter+process.env.PATH});
let server,base,video,source;
const store=new Store(root),post=(route,body)=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({...key,...body})});
const wait=async fn=>{const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end,'fixture timeout');await new Promise(r=>setTimeout(r,20));}};
const images=r=>r.args.flatMap((x,i)=>x==='-i'?[r.args[i+1]]:[]);
const send=(attachments,text='動画を確認',extra={})=>post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:qe.format(text,attachments),projectImages:attachments.filter(a=>a.kind!=='file').map(a=>a.id),attachmentDraft:{text,attachments},...extra});
const upload=(data,name='phone.mov',task='t',generation=1)=>fetch(base+'/api/task/upload?'+new URLSearchParams({...key,task,name,generation,chat:1}),{method:'POST',headers:{'X-Hub':'1'},body:data});
test.before(async()=>{
 ({server}=require('../server'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;require('../server').stopControl.cleanExit();await new Promise(r=>server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];({server}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
});
test.after(async()=>{await require('../server').chats.stop(key.project,key.task);server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('project video: real upload, task-scoped storage, adaptive frames to fake CLI, existing image and general files',async t=>{
 const platform=require('../lib/platform'),search=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].join(path.delimiter),ffmpeg=platform.findExecutable('ffmpeg',search);
 if(!ffmpeg||!platform.findExecutable('ffprobe',search))return t.skip('local ffmpeg unavailable');
 source=path.join(tmp,'phone.mov');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=72x128:rate=8:duration=2','-c:v','libx264','-threads','1',source],{stdio:'pipe',timeout:15000});
 const bytes=fs.readFileSync(source),r=await upload(bytes);assert.equal(r.status,200,await r.clone().text());video=await r.json();assert.equal(video.media,'video');assert.equal(video.frames.length,4);assert.equal(video.subtitleSheet.status,'done');assert.equal(video.imagePaths.length,5);assert.ok(video.imagePaths.includes(video.subtitleSheet.path));assert.equal(video.status,'partial');assert.ok(video.path.startsWith(path.join(dir,'.ai/work/t/chat-attachments')+path.sep));assert.deepEqual(fs.readFileSync(video.path),bytes);assert.match(fs.readFileSync(video.referencePaths[1],'utf8'),/1.500s/);
 const descriptor=JSON.parse(fs.readFileSync(path.join(path.dirname(video.imagePath),'attachment.json'),'utf8'));assert.deepEqual(descriptor.imagePaths,video.imagePaths);
 const preview=await fetch(base+video.url);assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/jpeg');
 const png=fs.readFileSync(path.join(__dirname,'../public/icon.png'));const ir=await fetch(base+'/api/start/image?'+new URLSearchParams({project:key.project,name:'still.png'}),{method:'POST',headers:{'X-Hub':'1'},body:png});assert.equal(ir.status,200);const image=await ir.json();
 const fr=await upload(Buffer.from('ordinary file'),'notes.txt');assert.equal(fr.status,200);const f=await fr.json(),file={id:'file:1:'+f.path,kind:'file',path:f.path,name:'notes.txt'};
 const sent=await send([video,image,file]);assert.equal(sent.status,200,await sent.clone().text());await wait(()=>chat.read(dir,'t').some(x=>x.role==='assistant')&&!require('../server').chats.busy(key.project,key.task));
 const response=JSON.parse(chat.read(dir,'t').find(x=>x.role==='assistant').text);assert.deepEqual(images(response),[...video.imagePaths,image.path]);assert.ok(response.input.includes(video.referencePaths[1]));assert.ok(response.input.includes(file.path));assert.match(response.input,/音声/);
 assert.equal((await send([video],'wrong task',{task:'other'})).status,400);
 const forged={...video,imagePaths:['/outside.png'],referencePaths:['/outside.mov']};assert.equal((await send([forged])).status,400);
 const before=fs.readdirSync(path.dirname(video.path)).sort();assert.equal((await upload(Buffer.from('broken'))).status,409);assert.deepEqual(fs.readdirSync(path.dirname(video.path)).sort(),before);
 assert.equal((await upload(bytes,'phone.mov','t',99)).status,409);
 const native=await post('/api/task/attach',{paths:[source],generation:1,chat:true});assert.equal(native.status,200);const attached=await native.json();assert.equal(attached.attachments[0].imagePaths.length,5);assert.deepEqual(fs.readFileSync(source),bytes);assert.deepEqual(attached.paths,[]);
 // Original project image limit and combined video/image limit remain explicit.
 assert.throws(()=>qe.imagePaths(Array.from({length:11},(_,i)=>({path:String(i)}))),/10枚/);
 assert.throws(()=>qe.imagePaths([{...video,imagePaths:Array.from({length:21},(_,i)=>'/frame-'+i+'.jpg')}]), /20枚/);
 const chatgpt=await send([video],'unsupported',{ai:'chatgpt',model:'auto'});assert.ok(chatgpt.status>=400);
});
test('project queued video: editing keeps all frames, removal drops them, reload and automatic/manual dispatch preserve them',async t=>{
 if(!video)return t.skip('video fixture unavailable');
 const hub=require('../server');
 const held=await post('/api/chat/send',{ai:'codex',model:'gpt-6.1-sol',text:'HOLD-VIDEO'});assert.equal(held.status,200,await held.clone().text());await wait(()=>fs.existsSync(path.join(tmp,'started')));
 const r=await send([video],'queued video',{mode:'queue'});assert.equal(r.status,200,await r.clone().text());const id=(await r.json()).id;
 let item=hub.chats.queue(key.project,key.task).find(x=>x.id===id);assert.deepEqual(item.images,video.imagePaths);
 const revise=(q,ids)=>post('/api/chat/queue/edit',{id:q.id,text:'edited video',expectedText:q.text,expectedItem:JSON.stringify(q),attachmentIds:ids});
 assert.equal((await revise(item,[video.id])).status,200);item=hub.chats.queue(key.project,key.task).find(x=>x.id===id);assert.deepEqual(item.images,video.imagePaths);assert.match(item.text,/frame-04/);
 assert.deepEqual(new chat.ChatRunner({dirOf:()=>dir}).queue(key.project,key.task).find(x=>x.id===id).images,video.imagePaths);
 assert.deepEqual(hub.chats.queuedOptions({project:key.project},item).images,video.imagePaths);
 fs.writeFileSync(path.join(tmp,'release'),'ok');await wait(()=>chat.read(dir,'t').some(x=>x.role==='assistant'&&x.request===id)&&!hub.chats.busy(key.project,key.task));
 assert.deepEqual(images(JSON.parse(chat.read(dir,'t').find(x=>x.role==='assistant'&&x.request===id).text)),video.imagePaths);
 const waiting=hub.chats.enqueue(key.project,key.task,{ai:'codex',model:'GPT-6.1-Sol',text:qe.format('manual video',[video]),attachmentDraft:{text:'manual video',attachments:[video]},images:video.imagePaths}).id;
 const manual=await post('/api/chat/send',{fromQueue:waiting});assert.equal(manual.status,200,await manual.clone().text());await wait(()=>chat.read(dir,'t').some(x=>x.role==='assistant'&&x.request===waiting)&&!hub.chats.busy(key.project,key.task));assert.deepEqual(images(JSON.parse(chat.read(dir,'t').find(x=>x.role==='assistant'&&x.request===waiting).text)),video.imagePaths);
 // Remove an attachment in the queue without removing its original files.
 const enqueue=hub.chats.enqueue(key.project,key.task,{ai:'codex',model:'GPT-6.1-Sol',text:qe.format('remove video',[video]),attachmentDraft:{text:'remove video',attachments:[video]},images:video.imagePaths});
 assert.equal((await revise(enqueue,[])).status,200);const removed=hub.chats.queue(key.project,key.task).find(x=>x.id===enqueue.id);assert.deepEqual(removed.images,[]);assert.doesNotMatch(removed.text,/frame-01/);assert.ok(fs.existsSync(video.path));hub.chats.unqueue(key.project,key.task,enqueue.id);
});

test('legacy video paths and terminal uploads bypass extraction and preserve mixed files',async t=>{
 const large=path.join(tmp,'large.mov'),note=path.join(tmp,'mixed.txt');fs.writeFileSync(large,'');fs.truncateSync(large,51*1024*1024);fs.writeFileSync(note,'mixed note');
 const outside=fs.mkdtempSync('/private/var/tmp/hub-video-external-');t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));const external=path.join(outside,'external.mov');fs.writeFileSync(external,'unreadable external fixture');
 const typed=[],hub=require('../server'),write=hub.sessions.write;hub.sessions.write=(...args)=>{typed.push(args);return true;};t.after(()=>{hub.sessions.write=write;});
 for(const ai of [undefined,'codex']) {
  const r=await post('/api/task/attach',{paths:[large,external,note],ai});assert.equal(r.status,200,await r.clone().text());const j=await r.json();assert.deepEqual(j.paths,[large,external,note]);assert.deepEqual(j.attachments,[]);assert.equal(j.typed,!!ai);
 }
 assert.ok(typed[0][3].includes(large));assert.ok(typed[0][3].includes(external));assert.ok(typed[0][3].includes(note));
 // Explicit chat requests remain strict; the native composer can fall back to the legacy path route.
 for(const file of [large,external]) {const r=await post('/api/task/attach',{paths:[file],generation:1,chat:true});assert.equal(r.status,409);}
 const fallback={id:'file:legacy:'+large,kind:'file',path:large,name:'large.mov',status:'unreadable',message:'動画の場所だけを渡します。内容は確認できません。'};
 const p=store.readProject(key.project),draft={text:'legacy video',attachments:[fallback]};assert.deepEqual(qe.accept(p,key.task,draft,qe.format(draft.text,draft.attachments)),draft);assert.deepEqual(qe.imagePaths([fallback]),[]);
 const r=await fetch(base+'/api/task/upload?'+new URLSearchParams({...key,name:'broken.mov',ai:'codex'}),{method:'POST',headers:{'X-Hub':'1'},body:Buffer.from('raw terminal upload')});assert.equal(r.status,200,await r.clone().text());const uploaded=await r.json();assert.equal(uploaded.typed,true);assert.deepEqual(fs.readFileSync(uploaded.path),Buffer.from('raw terminal upload'));assert.equal(uploaded.imagePaths,undefined);
});
