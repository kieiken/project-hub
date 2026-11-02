'use strict';
// Offline UI fixture only: the Muse endpoint is deferred in memory, never contacted.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');

function composer(project) {
  const f=app();f.context.data=snapshot();f.context.crypto=crypto;
  const p=f.context.data.projects[0],t=p.tasks[0];p.id=project;
  if(project==='freetalk'){p.kind='freetalk';t.freetalk=true;}
  f.context.projectId=project;
  vm.runInContext("state=data;state.museSupported=true;view={kind:'work',project:projectId,task:'t'};globalThis.HubChatGenerations=new Map([[projectId+'\\0t',3]]);",f.context);
  const calls=[],notices=[];let finish,fail,send;
  f.context.api=(route,body)=>{
    if(route==='/api/muse/chat'&&body){calls.push(body);return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});}
    return new Promise(()=>{});
  };
  f.context.toast=text=>notices.push(text);
  f.context.bindAskAnswers=(_box,cb)=>{send=cb;};
  const mount=()=>{f.context.openChat(p,t);f.element('#chat-ai').value='muse|direct';};mount();
  const type=text=>{f.element('#chat-in').value=text;f.element('#chat-in').handlers.input();};
  const draft=()=>vm.runInContext('chatDraft[chatAttachmentKey(projectId,"t")]',f.context);
  return {...f,p,t,calls,notices,type,draft,mount,send:()=>send(),finish:r=>finish(r),fail:e=>fail(e)};
}

for(const project of ['p','freetalk']) {
  for(const state of ['received','sent','unknown','rejected']) for(const next of ['','New draft','Original question']) {
    test(`Muse clears immediately and preserves later draft: ${project}/${state}/${next||'empty'}`,async()=>{
      const f=composer(project);f.type('Original question');
      f.context.chatImages(project,'t').push({id:'selected',kind:'file',path:'/fixture/note.md',name:'note.md'});
      const pending=f.send();
      assert.equal(f.element('#chat-in').value,'');assert.equal(f.draft(),'');
      assert.equal(f.element('#chat-send').disabled,true);
      assert.equal(await f.send(),false);assert.equal(f.calls.length,1);
      assert.equal(f.calls[0].question,'Original question');assert.equal(f.calls[0].project,project);assert.equal(f.calls[0].generation,3);
      assert.equal(f.calls[0].materials[0].path,'/fixture/note.md');
      if(next)f.type(next);
      f.finish({ok:state==='received',state,notice:'Synthetic '+state});await pending;
      assert.equal(f.element('#chat-in').value,next);assert.equal(f.draft(),next);
      assert.equal(f.element('#chat-send').disabled,false);assert.equal(f.calls.length,1);
      assert.equal(f.context.chatImages(project,'t').length,0);
    });
  }
  for(const next of ['', 'Later draft']) test(`Muse exchange limit restores unsent draft and attachments: ${project}/${next||'empty'}`,async()=>{
    const f=composer(project);f.type('Original question');
    f.context.chatImages(project,'t').push({id:'selected',kind:'file',path:'/fixture/note.md'});
    const pending=f.send();if(next)f.type(next);
    f.finish({ok:false,state:'not-sent',notice:'この相談は往復の上限に達したため、今回の質問は送っていません。新しい話題から送ってください。'});
    assert.equal(await pending,false);assert.equal(f.draft(),'Original question'+(next?'\n\n'+next:''));
    assert.equal(f.context.chatImages(project,'t').length,1);assert.equal(f.calls.length,1);
    assert.match(f.notices.at(-1),/新しい話題/);
  });
  for(const delivery of ['not-sent',undefined]) for(const next of ['','New draft','Original question']) {
    test(`Muse failed request preserves exact drafts and attachments: ${project}/${delivery||'unknown'}/${next||'empty'}`,async()=>{
      const f=composer(project);f.type('  Original question\n');
      f.context.chatImages(project,'t').push({id:'selected',kind:'file',path:'/fixture/note.md'});
      const pending=f.send();assert.equal(f.draft(),'');if(next)f.type(next);
      f.fail(Object.assign(Error('Synthetic failure'),delivery?{delivery}:{}));assert.equal(await pending,false);
      const expected=delivery==='not-sent'?'  Original question\n'+(next?'\n\n'+next:''):next;
      assert.equal(f.draft(),expected);assert.equal(f.element('#chat-in').value,expected);
      assert.equal(f.context.chatImages(project,'t').length,1);assert.equal(f.calls.length,1);
      assert.equal(f.element('#chat-send').disabled,false);
      if(!delivery)assert.match(f.notices.at(-1),/送り直さず/);
    });
  }
  for(const target of ['other-task','other-project','other-mode','redraw']) for(const delivery of ['received','not-sent','unknown']) {
    test(`late Muse completion targets only its draft: ${project}/${target}/${delivery}`,async()=>{
      const f=composer(project);f.type('Original');const old=f.element('#chat-in'),pending=f.send();f.type('Later');
      if(target==='other-task')vm.runInContext("view.task='other'",f.context);
      if(target==='other-project')vm.runInContext("view.project='other'",f.context);
      if(target==='other-mode')f.context.workMode=()=>'details';
      if(target==='redraw'){f.elements.delete('#chat-in');f.mount();f.type('Redrawn draft');}
      else f.element('#chat-in').value='Other visible text';
      if(delivery==='received')f.finish({ok:true,state:'received'});
      else f.fail(Object.assign(Error('Synthetic failure'),delivery==='not-sent'?{delivery}:{}));
      await pending;
      const next=target==='redraw'?'Redrawn draft':'Later';
      const expected=delivery==='not-sent'?'Original\n\n'+next:next;
      assert.equal(f.draft(),expected);
      assert.equal(f.element('#chat-in').value,target==='redraw'?expected:'Other visible text');
      if(target==='redraw')assert.equal(old.value,'Later');
      assert.equal(f.calls.length,1);
    });
  }
  test(`Muse validation keeps unsent text and unsupported attachments: ${project}`,async()=>{
    const f=composer(project);f.type('  ');assert.equal(await f.send(),false);assert.equal(f.draft(),'  ');
    f.type('Keep me');f.context.chatImages(project,'t').push({id:'image',kind:'image',path:'/fixture/image.png'});
    assert.equal(await f.send(),false);assert.equal(f.element('#chat-in').value,'Keep me');assert.equal(f.draft(),'Keep me');
    assert.equal(f.context.chatImages(project,'t').length,1);assert.equal(f.calls.length,0);
  });
}
