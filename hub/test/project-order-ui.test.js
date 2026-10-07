'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
function app() {
  const events={},elements=new Map(),messages=[],calls=[];
  function el(s) {if(!elements.has(s))elements.set(s,{innerHTML:'',hidden:true,style:{},dataset:{},scrollTop:100,addEventListener(){},setAttribute(){},querySelector:()=>({focus(){}}),querySelectorAll:()=>[],getBoundingClientRect:()=>({top:0,bottom:500})});return elements.get(s);}
  const document={querySelector:el,querySelectorAll:()=>nodes,body:{classList:{contains:()=>false,remove(){}}},addEventListener:(type,fn,capture)=>{(events[type]||=[]).push({fn,capture});}};
  const context=vm.createContext({document,window:{},navigator:{userAgent:''},console,innerWidth:1024,innerHeight:700,URLSearchParams,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},requestAnimationFrame(){},matchMedia:()=>({matches:false}),ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
  const nodes=[];
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/hierarchy.js'),'utf8'),context);
  context.stubApi=async(route,body)=>{calls.push({route,body:JSON.parse(JSON.stringify(body))});if(context.fail)throw Error('fixture save failed');return{};};
  context.stubToast=text=>messages.push(text);
  vm.runInContext(`api=stubApi;toast=stubToast;load=async()=>{};state={projects:['a','b','c','d'].map((id,i)=>({id,name:id,parent:i>1?'a':'',phases:[],tasks:[],status:'進行中'})),sessions:[],chatting:[],unread:[],projectOrder:{'':['b','a'],a:['d','c']}};view={kind:'project',project:'a'};`,context);
  function node(id,task=false) {
    const own=new Set();const n={dataset:{p:id,...(task?{t:'task'}:{})},classList:{add:x=>own.add(x),remove:(...xs)=>xs.forEach(x=>own.delete(x)),contains:x=>own.has(x)},getBoundingClientRect:()=>({top:100,height:40}),contains:()=>false,closest:selector=>selector==='#list' || (!task&&selector.includes('.node.p')) ? n : null};nodes.push(n);return n;
  }
  const event=(target,y=110)=>({target,clientY:y,dataTransfer:{dropEffect:'none',setData(){}},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}});
  const dispatch=(type,e)=>{for(const {fn,capture} of events[type]||[]) if(capture){fn(e);if(e.stopped)break;}return e;};
  return{context,events,el,node,event,dispatch,messages,calls,run:s=>vm.runInContext(s,context)};
}
test('production tree/child card use saved sibling order; task rows and narrow have no drag; remote desktop and phone menu allow ordering',()=>{
  const a=app();a.run('open.add("a");renderTree()');const html=a.el('#list').innerHTML;
  assert.ok(html.indexOf('data-p="b"')<html.indexOf('data-p="a"'));assert.ok(html.indexOf('data-p="d"')<html.indexOf('data-p="c"'));
  assert.equal((html.match(/draggable="true"/g)||[]).length,4);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(orderedChildren(proj("a")).map(p=>p.id))')),['d','c']);
  a.run('matchMedia=()=>({matches:true});renderTree()');assert.doesNotMatch(a.el('#list').innerHTML,/draggable|project-grip/);
  a.run('matchMedia=()=>({matches:false});location.hostname="example.test";renderTree()');assert.match(a.el('#list').innerHTML,/draggable|project-grip/);
  a.run('matchMedia=()=>({matches:true});showTreeMenu("a",null,10,10)');assert.match(a.el('#menu').innerHTML,/上へ移動|下へ移動/);
});
test('drag valid siblings shows correct line; descendant/task invalid; cancel leaves order; success posts snapshot; click suppressed',async()=>{
  const a=app(),b=a.node('b'),alpha=a.node('a'),child=a.node('c'),task=a.node('a',true);
  a.dispatch('dragstart',a.event(b));let e=a.dispatch('dragover',a.event(alpha,135));assert.equal(e.dataTransfer.dropEffect,'move');assert.ok(alpha.classList.contains('project-drop-after'));
  e=a.dispatch('dragover',a.event(child));assert.equal(e.dataTransfer.dropEffect,'none');assert.ok(!alpha.classList.contains('project-drop-after'));
  e=a.dispatch('dragover',a.event(task));assert.equal(e.dataTransfer.dropEffect,'none');
  a.dispatch('drop',a.event(task));assert.equal(a.calls.length,0);
  a.dispatch('dragstart',a.event(b));a.dispatch('drop',a.event(alpha,135));await new Promise(r=>setImmediate(r));
  assert.deepEqual(a.calls,[{route:'/api/hierarchy/order',body:{parent:'',before:['b','a'],order:['a','b']}}]);
  assert.ok(a.messages.includes('並び順を保存しました'));
  const click=a.dispatch('click',a.event(alpha));assert.ok(click.prevented&&click.stopped);
});
test('failed save keeps local order; menus share endpoint, boundary disabled; pending rejects double send',async()=>{
  const a=app();a.context.fail=true;await a.run('saveProjectOrder("",["b","a"],["a","b"])');
  assert.equal(a.run('state.projectOrder[""][0]'),'b');assert.ok(a.messages.includes('fixture save failed'));
  a.run('showTreeMenu("b",null,10,10)');assert.match(a.el('#menu').innerHTML,/data-tree-action="up"[^>]*disabled/);assert.match(a.el('#menu').innerHTML,/下へ移動/);
  a.context.fail=false;await a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'down'}})}});
  assert.deepEqual(a.calls.at(-1).body,{parent:'',before:['b','a'],order:['a','b']});
  const before=a.calls.length;a.run('projectOrderBusy=true');await a.run('saveProjectOrder("",["b","a"],["a","b"])');assert.equal(a.calls.length,before);
  a.run('projectOrderBusy=false;showTreeMenu("a","missing",10,10)');
});

test('phone uses saved terminal mode and renders file/completion/mode controls without mobile hiding',()=>{
  const a=app();
  a.run(`matchMedia=()=>({matches:true});location.hostname='mac.fixture.ts.net';localStorage.getItem=k=>k==='hub-mode'?'term':null;`);
  assert.equal(a.run('workMode()'),'term');
  a.run(`state.projects[0].tasks=[{id:'t',title:'Fixture work',owner:'codex',state:'未着手',steps:[],skills:[],copy:true,kind:'main',workspaceMode:'isolated'}];view={kind:'work',project:'a',task:'t'};state.roles={models:{codex:['GPT-6.1-Sol']},roles:[]};state.efforts=[];renderWork();`);
  const html=a.el('#main').innerHTML;
  for (const text of ['data-m="chat"','data-m="term"','ファイルを見る','完了に移す','本体に取り込む']) assert.ok(html.includes(text),text);
  assert.match(html,/data-act="start"[^>]*data-ai="codex"/);
  const css=fs.readFileSync(path.join(__dirname,'../public/app.css'),'utf8');
  assert.doesNotMatch(css,/\.work[^{}]*(?:\.seg|\.wfiles|\.wdone|\.task-context|\.done-note)[^{}]*\{[^}]*display\s*:\s*none/);
});

test('一覧で子だけ下階層、分岐の元名を文字表示、子/派生に共通の引渡しを出す',()=>{
 const a=app();a.context.EventSource=class{close(){}};a.run(`state.projects=[{id:'p',name:'親',phases:[],status:'進行中',tasks:[{id:'base',title:'本作業',kind:'main',steps:[],skills:[]},{id:'kid',title:'小作業',parent:'base',kind:'main',steps:[],skills:[]},{id:'fork',title:'別案',parent:'base',kind:'derived',derivedFrom:'p/base',steps:[],skills:[]}]},{id:'child',name:'子',parent:'p',phases:[],tasks:[]},{id:'branch',name:'分岐案',parent:'p',derivedFrom:'p',phases:[],tasks:[]}];state.projectOrder={};open.add('p');open.add('t:p/base');renderTree();`);
 const html=a.el('#list').innerHTML;assert.match(html,/⑂ 分岐：親から/);assert.match(html,/⑂ 分岐：本作業から/);assert.ok(html.indexOf('data-t="base"')<html.indexOf('data-t="fork"'));assert.equal(a.run('displayParent(proj("branch"),state.projects)'),'');assert.equal(a.run('treeTasks(proj("p")).find(x=>x.id==="fork").parent'),'');
 a.run(`state.roles={models:{codex:[]},roles:[]};state.efforts=[];view={kind:'work',project:'p',task:'kid'};renderWork();`);assert.doesNotMatch(a.el('#main').innerHTML,/data-act="handup"/);
 a.run(`proj('p').tasks[1].state='完了';proj('p').tasks[1].copy=true;renderWork();`);assert.match(a.el('#main').innerHTML,/成果を渡す/);assert.doesNotMatch(a.el('#main').innerHTML,/data-act="merge"/);
 a.run(`view.task='fork';proj('p').tasks[2].state='完了';renderWork();`);assert.match(a.el('#main').innerHTML,/成果を渡す/);
});

test('過去の受領通知でも実際の子の所属を照合し、他プロジェクトの同じIDを片付けない',()=>{
 const a=app();a.run(`state.projects=[{id:'p',name:'親',tasks:[{id:'base',title:'本作業'},{id:'same',title:'無関係'}]},{id:'q',name:'別',tasks:[{id:'same',title:'派生',state:'完了',kind:'derived',derivedFrom:'p/base'}]}];view={kind:'work',project:'p',task:'base'};`);
 const row=`{role:'user',from:'subtask',child:'same',childProject:'q',text:'過去の結果'}`;
 const html=a.run(`msgHtml(${row})`);assert.match(html,/data-p="q" data-t="same"/);assert.match(html,/成果を受け取る/);assert.doesNotMatch(a.run('msgHtml({role:"user",from:"subtask",child:"same",text:"旧結果"})'),/data-act="absorb"/);
});

test('片付け後に作業が消えていても本作業に引渡し再開ボタンを出す',()=>{
 const a=app();a.run(`state.projects=[{id:'p',tasks:[{id:'parent',title:'本作業',steps:[]}]}];state.taskHandoffs=[{project:'q',task:'gone',title:'片付け中の子',targetProject:'p',targetTask:'parent'}];`);
 assert.match(a.run('kidsDoneBar(proj("p"),proj("p").tasks[0])'),/data-p="q" data-t="gone"[^>]*>引渡しの残りを続ける/);
});

test('保存順のある画面でも新分岐は元の隣、子の分岐も同じ段で並べ替えbeforeと一致',async()=>{
 const a=app();a.run(`state.projects.push({id:'new-root',name:'新分岐',derivedFrom:'a',phases:[],tasks:[]},{id:'new-kid',name:'子の新分岐',derivedFrom:'c',parent:'c',phases:[],tasks:[]});open.add('a');renderTree();`);
 const html=a.el('#list').innerHTML;
 for(const [left,right] of [['b','a'],['a','new-root'],['d','c'],['c','new-kid']])assert.ok(html.indexOf('data-p="'+left+'"')<html.indexOf('data-p="'+right+'"'));
 assert.deepEqual(JSON.parse(a.run('JSON.stringify(projectSiblings("a").map(p=>p.id))')),['d','c','new-kid']);
 for(const id of ['new-root','new-kid']) {
  a.run(`showTreeMenu('${id}',null,10,10)`);
  await a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'up'}})}});
 }
 assert.deepEqual(a.calls.map(x=>x.body),[
  {parent:'',before:['b','a','new-root'],order:['b','new-root','a']},
  {parent:'a',before:['d','c','new-kid'],order:['d','new-kid','c']}
 ]);
});


test('pin menu works on desktop/phone; boundary moves and drag blocked; errors and busy preserve pins',async()=>{
  const a=app();a.run('state.projectPins=["a"];open.add("a");renderTree()');
  let html=a.el('#list').innerHTML;
  assert.ok(html.indexOf('data-p="a"')<html.indexOf('data-p="b"'));assert.match(html,/上部に固定中/);
  a.run('showTreeMenu("a",null,10,10)');html=a.el('#menu').innerHTML;
  assert.match(html,/固定を解除/);assert.match(html,/data-tree-action="down"[^>]*disabled/);
  await a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'pin'}})}});
  assert.deepEqual(a.calls.at(-1),{route:'/api/hierarchy/pin',body:{project:'a',before:true,pinned:false}});
  a.run('matchMedia=()=>({matches:true});showTreeMenu("b",null,10,10)');
  assert.match(a.el('#menu').innerHTML,/上部に固定/);assert.match(a.el('#menu').innerHTML,/data-tree-action="up"[^>]*disabled/);
  a.run('showTreeMenu("a","missing",10,10)');
  a.run('matchMedia=()=>({matches:false})');const alpha=a.node('a'),b=a.node('b');
  a.dispatch('dragstart',a.event(alpha));const e=a.dispatch('dragover',a.event(b));assert.equal(e.dataTransfer.dropEffect,'none');
  a.dispatch('drop',a.event(b));const count=a.calls.length;
  a.context.fail=true;await a.run('saveProjectPin("a",true)');assert.equal(a.run('isProjectPinned("a")'),true);assert.ok(a.messages.includes('fixture save failed'));
  a.run('projectOrderBusy=true');await a.run('saveProjectPin("a",true)');assert.equal(a.calls.length,count+1);
  const key=a.run('treeKey()');a.run('state.projectPins=[]');assert.notEqual(a.run('treeKey()'),key);
});


for (const before of [false, true]) test(`pin menu keeps displayed intent after poll changes target (${before ? 'unpin' : 'pin'})`, async () => {
  const a=app();
  a.run(`state.projectPins=${JSON.stringify(before ? ['a'] : [])};showTreeMenu("a",null,10,10)`);
  const label=before ? '固定を解除' : '上部に固定';
  assert.ok(a.el('#menu').innerHTML.includes(label));
  a.context.nextState=JSON.parse(a.run('JSON.stringify(state)'));
  a.context.nextState.projectPins=before ? [] : ['a'];
  a.run('fetchState=async()=>nextState');await a.run('pollState()');
  assert.equal(a.run('isProjectPinned("a")'),!before);
  assert.ok(a.el('#menu').innerHTML.includes(label));
  // The server rejects the stale before; neither browser state nor saved pins may flip.
  a.context.stubApi=async(route,body)=>{
    a.calls.push({route,body:JSON.parse(JSON.stringify(body))});
    if(body.before!==a.run('isProjectPinned("a")')) throw Error('固定の状態が変わりました。読み直してから操作してください');
    throw Error('stale menu unexpectedly accepted');
  };
  a.run('api=stubApi');
  await a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'pin'}})}});
  assert.deepEqual(a.calls,[{route:'/api/hierarchy/pin',body:{project:'a',before,pinned:!before}}]);
  assert.equal(a.run('isProjectPinned("a")'),!before);
  assert.ok(a.messages.includes('固定の状態が変わりました。読み直してから操作してください'));
  assert.equal(a.run('projectOrderBusy'),false);
});

test('unrelated pin changes leave displayed pin and unpin requests valid', async()=>{
  const a=app();
  for(const before of [false,true]) {
    a.run(`state.projectPins=${JSON.stringify(before ? ['a'] : [])};showTreeMenu("a",null,10,10)`);
    a.context.nextState=JSON.parse(a.run('JSON.stringify(state)'));
    a.context.nextState.projectPins.push('b');
    a.run('fetchState=async()=>nextState');await a.run('pollState()');
    await a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'pin'}})}});
    assert.deepEqual(a.calls.at(-1),{route:'/api/hierarchy/pin',body:{project:'a',before,pinned:!before}});
    assert.equal(a.messages.at(-1),before?'固定を解除しました':'上部に固定しました');
  }
});

test('pin menus reject double click while pending and preserve pins on failure, then allow retry',async()=>{
  const a=app();a.run('state.projectPins=["a"];showTreeMenu("a",null,10,10)');
  let rejectSave;
  a.context.stubApi=(route,body)=>{
    a.calls.push({route,body:JSON.parse(JSON.stringify(body))});
    return new Promise((resolve,reject)=>{rejectSave=reject;});
  };
  a.run('api=stubApi');
  const click=()=>a.el('#menu').onclick({target:{closest:()=>({dataset:{treeAction:'pin'}})}});
  const pending=click();
  a.run('showTreeMenu("a",null,10,10)');assert.match(a.el('#menu').innerHTML,/data-tree-action="pin"[^>]*disabled/);
  await click();assert.equal(a.calls.length,1);
  rejectSave(Error('fixture save failed'));await pending;
  assert.equal(a.run('isProjectPinned("a")'),true);assert.equal(a.run('projectOrderBusy'),false);
  assert.ok(a.messages.includes('fixture save failed'));
  a.context.stubApi=async(route,body)=>{a.calls.push({route,body:JSON.parse(JSON.stringify(body))});return {};};
  a.run('api=stubApi;showTreeMenu("a",null,10,10)');await click();
  assert.equal(a.calls.length,2);assert.equal(a.messages.at(-1),'固定を解除しました');
});

test('R4 祖先が統合する対象外の子には戻す操作だけを残し直接取り込みは禁止',async()=>{
 const a=app();a.context.EventSource=class{close(){}};a.run(`state.projects=[{id:'p',name:'親',phases:[],tasks:[{id:'base',title:'親作業',steps:[],skills:[],state:'実行中'},{id:'kid',title:'旧対象外',parent:'base',steps:[],skills:[],state:'完了',copy:true,mergeExcluded:true}]}];state.roles={models:{codex:[]},roles:[]};state.efforts=[];view={kind:'work',project:'p',task:'kid'};renderWork();`);
 let html=a.el('#main').innerHTML;assert.match(html,/data-act="mergeinclude"/);assert.doesNotMatch(html,/data-act="merge"|data-act="mergeexclude"/);
 await a.context.act({dataset:{act:'mergeinclude',p:'p',t:'kid'}});assert.deepEqual(a.calls.at(-1),{route:'/api/task/merge-exclusion',body:{project:'p',task:'kid',excluded:false}});
 a.run(`proj('p').tasks[1].mergeExcluded=false;renderWork();`);html=a.el('#main').innerHTML;assert.doesNotMatch(html,/data-act="merge"|data-act="mergeinclude"|data-act="mergeexclude"/);assert.match(html,/成果を渡す/);
});
