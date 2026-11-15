'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),qe=require('../lib/queue-edit');
test('freetalk draft uses trusted descriptors, preserves extracted references, and never treats merged or arbitrary text as removable attachments',()=>{
 const id='12d90541-48a7-48df-9b50-47a3213b55cb',root='/fixture/topics/t/',a={id,kind:'image',path:root+id+'-image.png',name:'image.png',url:'/api/freetalk/attachment?id='+id,imagePath:root+'.derived/'+id+'/preview.png',referencePaths:[root+id+'-image.png'],generation:1};
 const ft={descriptor(task,key){assert.equal(task,'t');assert.equal(key,id);return a;}},p={id:'freetalk',kind:'freetalk'};
 const text=qe.format('image',[a]),source=qe.accept(p,'t',{text:'image',attachments:[{...a,url:'https://invalid.example/'}]},text,ft);assert.equal(source.attachments[0].url,a.url);
 assert.deepEqual(qe.draft(p,'t',{text,attachmentDraft:source},ft),source);assert.equal(qe.draft(p,'t',{text},ft).attachments.length,1);
 const combined='merged instruction';assert.deepEqual(qe.draft(p,'t',{text:combined,attachmentDraft:source},ft),{text:combined,attachments:[]});
 const unknown={text:'manual\n\n参照画像（絶対パス）：\n/private/tmp/manual.png'};assert.equal(qe.draft(p,'t',unknown,ft).attachments.length,0);
 assert.throws(()=>qe.accept(p,'t',{text:'image',attachments:[a]},'mismatched',ft));
});

test('a pending amend preserves full references while invalidating the old editable attachment boundary',()=>{
 const {ChatRunner}=require('../lib/chat'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-attachment-pending-'));
 try{
  const runner=new ChatRunner({dirOf:()=>dir}),a={id:'first',path:'/fixture/first.png'},text=qe.format('original',[a]),item=runner.enqueue('p','t',{ai:'codex',model:'GPT-6.1-Sol',text,attachmentDraft:{text:'original',attachments:[a]}});
  runner.running.set(runner.key('p','t'),{pending:true,request:item.id,options:{ai:'codex',model:'GPT-6.1-Sol',text}});runner.stop=()=>Promise.resolve({state:'exited'});
  runner.replacePending('p','t','extra explanation','amend',[]);const saved=runner.queue('p','t')[0];assert.equal(saved.attachmentDraft,undefined);assert.match(saved.text,/original/);assert.match(saved.text,/first.png/);assert.match(saved.text,/extra explanation/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('project pending amendment retains eight frames, redo replaces them, and combined images respect the limit',t=>{
 const {ChatRunner}=require('../lib/chat'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-project-pending-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const mode of ['amend','redo']) {
  const runner=new ChatRunner({dirOf:()=>dir}),frames=Array.from({length:8},(_,i)=>'/fixture/frame-'+i+'.jpg'),o={ai:'codex',model:'GPT-6.1-Sol',text:'video',images:frames};
  const item=runner.enqueue('p',mode,o);runner.running.set(runner.key('p',mode),{pending:true,request:item.id,options:o});runner.stop=()=>Promise.resolve({state:'exited'});
  const replacement=runner.replacePending('p',mode,'extra',mode,['/fixture/still.png']);assert.deepEqual(replacement.options.images,mode==='amend'?[...frames,'/fixture/still.png']:['/fixture/still.png']);assert.deepEqual(runner.queue('p',mode)[0].images,replacement.options.images);
 }
 const runner=new ChatRunner({dirOf:()=>dir}),o={ai:'codex',model:'GPT-6.1-Sol',text:'video',images:Array.from({length:16},(_,i)=>String(i))},item=runner.enqueue('p','cap',o);runner.running.set(runner.key('p','cap'),{pending:true,request:item.id,options:o});runner.stop=()=>{throw Error('must not stop');};
 assert.throws(()=>runner.replacePending('p','cap','extra','amend',Array.from({length:8},(_,i)=>'extra-'+i)),/20枚/);assert.equal(runner.queue('p','cap')[0].id,item.id);
});
