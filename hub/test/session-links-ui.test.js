'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const locale=require('./ui-locale-fixture'),source=fs.readFileSync(path.join(__dirname,'../public/session-links.js'),'utf8');
const inventory={links:[],supported:true,warnings:['Only local text is available'],projects:[
 {id:'g<one>',name:'Group A <img src=x>',sessions:[{id:'one"<x>',title:'Alpha <script>bad()</script>',hasTranscript:true,linked:false},{id:'two',title:'Missing history',hasTranscript:false,linked:false},{id:'old',title:'Already linked',hasTranscript:true,linked:true}]},
 {id:'g-two',name:'Group B',sessions:[{id:'three',title:'Delta',hasTranscript:true,linked:false},{id:'four',title:'Epsilon',hasTranscript:true,linked:false}]}
]};
const plan={token:'first-preview',groups:[{name:'Actual project (2) <b>safe</b>',sessionCount:2,messageCount:7,alreadyLinkedCount:0,missingHistoryCount:1}],warnings:['One conversation has no local history'],blockers:[]};
const result={links:[{id:'new',title:'New <script>session</script>',provider:'codex',hasTranscript:true,broken:false}],linkedCount:2,skippedCount:1,warnings:['Warning <img src=x>']};
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(language='ja'){
 const ids=new Map(),handlers={},calls=[],doc={activeElement:null};
 const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
 class Element{
  constructor(tag='div',attrs={}){this.tag=tag;this.attrs=attrs;this.children=[];this.dataset={};this.disabled=Object.hasOwn(attrs,'disabled');this.hidden=Object.hasOwn(attrs,'hidden');this.checked=Object.hasOwn(attrs,'checked');this.open=Object.hasOwn(attrs,'open');this.id=attrs.id;this.value='';this.scrollTop=0;this.textContent='';for(const[key,value]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  hasAttribute(name){return Object.hasOwn(this.attrs,name);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  get innerHTML(){return this.html||'';}
  set innerHTML(value){for(const node of this.querySelectorAll('[id]'))ids.delete(node.id);this.children=[];this.html=value;this.parse(value);for(const match of value.matchAll(/<textarea[^>]*id="([^"]*)"[^>]*>([^<]*)<\/textarea>/g)){const node=ids.get(match[1]);if(node)node.value=decode(match[2]);}}
  parse(value){const stack=[this];for(const match of value.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>/gi)){if(match[1]){const index=stack.map(node=>node.tag).lastIndexOf(match[2]);if(index>0)stack.length=index;continue;}const attrs={};for(const item of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[item[1]]=decode(item[2]??'');const node=new Element(match[2],attrs);node.parent=stack.at(-1);node.parent.children.push(node);if(node.id)ids.set(node.id,node);if(!['input','br','hr','img'].includes(node.tag))stack.push(node);}}
  insertAdjacentHTML(_where,value){this.parse(value);}
  matches(selector){return selector.split(',').some(part=>{const match=part.trim().match(/^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);return Boolean(match&&(!match[1]||this.tag===match[1])&&(!match[2]||this.hasAttribute(match[2]))&&(!match[3]||this.attrs[match[2]]===match[3]));});}
  querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
  closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null;}
  contains(node){for(;node;node=node.parent)if(node===this)return true;return false;}
  focus(options){this.focusOptions=options;doc.activeElement=this;}
  getClientRects(){for(let node=this;node;node=node.parent)if(node.hidden||node.tag==='details'&&!node.open&&this.tag!=='summary')return[];return[{}];}
 }
 doc.body=new Element('body');doc.querySelector=selector=>ids.get(selector.slice(1))||null;doc.addEventListener=(name,fn)=>{(handlers[name]||=[]).push(fn);};
 const settings={scrollTop:1320,draft:'unsaved role model'},counters={state:0,tree:0,turn:0};
 const context=vm.createContext({HubI18n:locale(language),document:doc,$:doc.querySelector,esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
  api:async(route,body)=>{calls.push({route,body:body?clone(body):undefined});if(route==='/api/session-links')return clone(inventory);if(route.endsWith('/preview'))return clone(plan);if(route.endsWith('/apply'))return clone(result);throw Error('unexpected API');},
  stateLoadEpoch:0,state:{projects:[]},fetchState:async()=>{counters.state++;return{projects:[{id:'new'}]};},renderTree:()=>{counters.tree++;},updateTurnCounts:()=>{counters.turn++;},
  view:{kind:'settings'},localStorage:{getItem:()=>null,setItem(){}},setInterval(){},crypto:require('node:crypto'),save(){},closeDrawer(){},render(){},confirm:()=>true,renderSettings:()=>{throw Error('settings must not redraw');},load:()=>{throw Error('must not reload view');}});
 vm.runInContext(source,context);calls.length=0;
 const node=id=>ids.get(id),controls=selector=>node('session-links-sheet').querySelectorAll(selector);
 async function dispatch(name,target,extra={}){const event={target,prevented:false,preventDefault(){this.prevented=true;},...extra};for(const fn of handlers[name]||[])await fn(event);return event;}
 const change=(selector,key,checked=true)=>{const input=controls(selector).find(input=>Object.values(input.dataset).includes(key));assert.ok(input,'missing input '+key);input.checked=checked;return dispatch('change',input);};
 return{context,calls,counters,settings,doc,node,controls,dispatch,change,Element,click:action=>dispatch('click',controls('[data-session-links]').find(button=>button.dataset.sessionLinks===action)),run:code=>vm.runInContext(code,context),selected:()=>clone(vm.runInContext('[...sessionLinkSelected]',context))};
}
test('Default unselected dialog never links without preview; linked sessions are disabled and user names are escaped',async()=>{
 const f=fixture('zh-TW');await f.context.showSessionLink();assert.deepEqual(f.selected(),[]);assert.equal(f.node('session-links-check').disabled,true);assert.equal(f.node('session-links-apply').hidden,true);
 assert.ok(f.controls('[data-session-choice]').find(node=>node.dataset.sessionChoice==='old').disabled);await f.context.previewSessionLink();await f.context.applySessionLink();assert.equal(f.calls.length,1);
 assert.match(f.node('session-links-sheet').innerHTML,/連結 Codex／Claude 會話/);assert.match(f.node('session-links-sheet').innerHTML,/只建立連結不會啟動 AI/);
 assert.match(f.node('session-links-groups').innerHTML,/Alpha &lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.match(f.node('session-links-groups').innerHTML,/已連結/);assert.doesNotMatch(f.node('session-links-groups').innerHTML,/<script>|<img|[ぁ-んァ-ヶ]/);
});
test('Group and session selection preserve list scroll and expansion; search does not discard hidden selections',async()=>{
 const f=fixture();await f.context.showSessionLink();f.node('session-links-groups').scrollTop=250;await f.change('[data-session-select-group]','g<one>');assert.deepEqual(f.selected(),['one"<x>','two']);assert.equal(f.node('session-links-groups').scrollTop,250);
 const detail=f.controls('[data-session-group]').find(node=>node.dataset.sessionGroup==='g<one>');detail.open=true;await f.dispatch('toggle',detail);await f.change('[data-session-choice]','two',false);
 assert.ok(f.controls('[data-session-group]').find(node=>node.dataset.sessionGroup==='g<one>').open);assert.ok(f.controls('[data-session-select-group]').find(node=>node.dataset.sessionSelectGroup==='g<one>').indeterminate);
 f.node('session-links-search').value='Delta';await f.dispatch('input',f.node('session-links-search'));assert.equal(f.controls('[data-session-choice]').length,1);assert.deepEqual(f.selected(),['one"<x>']);
 await f.change('[data-session-select-group]','g-two');assert.deepEqual(f.selected(),['one"<x>','three','four']);assert.match(f.node('session-links-selection').textContent,/2グループ・3件の会話/);
});
test('Preview sends only selected IDs and displays actual destination counts before explicit apply; success preserves settings',async()=>{
 const f=fixture('zh-TW');await f.context.showSessionLink();await f.change('[data-session-select-group]','g<one>');await f.click('preview');
 assert.deepEqual(f.calls.at(-1),{route:'/api/session-links/preview',body:{selected:['one"<x>','two']}});const html=f.node('session-links-preview').innerHTML;
 assert.match(html,/Actual project \(2\) &lt;b&gt;safe&lt;\/b&gt;/);assert.match(html,/群組：1 ／ 會話：2/);assert.match(html,/訊息：7/);assert.match(html,/缺少歷史的會話：1/);assert.match(html,/One conversation has no local history/);
 assert.equal(f.calls.filter(call=>call.route.endsWith('/apply')).length,0);assert.equal(f.node('session-links-apply').disabled,false);await f.click('apply');
 assert.deepEqual(f.calls.at(-1),{route:'/api/session-links/apply',body:{token:'first-preview',confirm:true}});assert.match(f.node('session-links-preview').innerHTML,/已連結會話：2 ／ 已連結而略過的會話：1/);assert.doesNotMatch(f.node('session-links-preview').innerHTML,/<script>|<img/);
 assert.equal(f.counters.state,0);assert.equal(f.counters.turn,0);assert.equal(f.settings.scrollTop,1320);assert.equal(f.settings.draft,'unsaved role model');await f.context.applySessionLink();assert.equal(f.calls.filter(call=>call.route.endsWith('/apply')).length,1);
});
test('Blockers, missing groups and changed selections cannot apply a plan; unsupported inventory keeps all controls inactive',async()=>{
 const f=fixture();await f.context.showSessionLink();await f.change('[data-session-choice]','two');f.context.api=async route=>{f.calls.push({route});return{...clone(plan),blockers:['blocked <script>reason</script>']};};await f.context.previewSessionLink();
 assert.equal(f.node('session-links-apply').disabled,true);assert.match(f.node('session-links-preview').innerHTML,/blocked &lt;script&gt;/);await f.context.applySessionLink();assert.equal(f.calls.length,2);
 await f.change('[data-session-choice]','one"<x>');assert.equal(f.run('sessionLinkPreview'),null);assert.equal(f.node('session-links-apply').hidden,true);
 f.context.api=async()=>({...clone(plan),groups:[]});await f.context.previewSessionLink();await f.context.applySessionLink();assert.equal(f.run('sessionLinkResult'),null);
 const u=fixture();u.context.api=async()=>({...clone(inventory),supported:false});await u.context.showSessionLink();await u.change('[data-session-choice]','two');await u.context.previewSessionLink();assert.deepEqual(u.selected(),[]);assert.equal(u.node('session-links-check').disabled,true);
});
test('Pending preview/apply lock repeated clicks, duplicate inventory IDs send once, and apply cannot close mid-link',async()=>{
 const f=fixture();f.context.api=async()=>{const data=clone(inventory);data.projects[0].sessions.push(data.projects[0].sessions[0]);return data;};await f.context.showSessionLink();await f.change('[data-session-select-group]','g<one>');
 let release;f.context.api=(route,body)=>{f.calls.push({route,body:clone(body)});return new Promise(resolve=>{release=resolve;});};const preview=f.context.previewSessionLink();await f.context.previewSessionLink();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.selected,['one"<x>','two']);assert.equal(f.node('session-links-check').disabled,true);release(clone(plan));await preview;
 const apply=f.context.applySessionLink();await f.context.applySessionLink();assert.equal(f.calls.length,2);assert.equal(f.node('session-links-close').disabled,true);await f.dispatch('keydown',f.node('session-links-apply'),{key:'Escape'});assert.equal(f.node('session-links-sheet').hidden,false);release(clone(result));await apply;
});
test('Preview errors and stale apply retain selection and require a fresh preview plus a new explicit confirmation',async()=>{
 const f=fixture('zh-TW');await f.context.showSessionLink();await f.change('[data-session-select-group]','g<one>');f.context.api=async()=>{throw Error('preview <script>failed</script>');};await f.context.previewSessionLink();assert.deepEqual(f.selected(),['one"<x>','two']);assert.equal(f.run('sessionLinkPreview'),null);assert.match(f.node('session-links-status').textContent,/preview <script>failed/);
 f.context.api=async()=>clone(plan);await f.context.previewSessionLink();let applies=0;f.context.api=async()=>{applies++;throw Object.assign(Error('source changed'),{status:409,code:'stale'});};await f.context.applySessionLink();await f.context.applySessionLink();assert.equal(applies,1);assert.deepEqual(f.selected(),['one"<x>','two']);assert.equal(f.run('sessionLinkPreview'),null);assert.match(f.node('session-links-status').textContent,/請重新預覽選取內容/);
 f.context.api=async route=>route.endsWith('/preview')?{...clone(plan),token:'fresh-preview'}:clone(result);await f.context.previewSessionLink();assert.equal(f.run('sessionLinkResult'),null);assert.equal(f.run('sessionLinkPreview.token'),'fresh-preview');await f.context.applySessionLink();assert.equal(f.run('sessionLinkResult.linkedCount'),2);
});
test('Late inventory cannot overwrite a newer dialog and refresh keeps selected sessions that still exist',async()=>{
 const f=fixture(),releases=[];f.context.api=()=>new Promise(resolve=>releases.push(resolve));const old=f.context.showSessionLink();f.context.closeSessionLink();const current=f.context.showSessionLink();
 releases[0]({supported:true,projects:[{id:'old',name:'Stale dialog',sessions:[]}],warnings:[]});await old;assert.equal(f.run('sessionLinkData'),null);releases[1](clone(inventory));await current;assert.doesNotMatch(f.node('session-links-groups').innerHTML,/Stale dialog/);
 await f.change('[data-session-choice]','two');f.context.api=async()=>clone(inventory);await f.context.loadSessionLink();assert.deepEqual(f.selected(),['two']);
});
test('Modal traps keyboard focus and returns to its opener without refreshing the native Hub state',async()=>{
 const f=fixture(),opener=new f.Element('button');await f.context.showSessionLink(opener);const first=f.controls('button,input,summary').filter(node=>!node.disabled&&!node.hidden&&node.getClientRects().length)[0];
 const tab=await f.dispatch('keydown',f.node('session-links-title'),{key:'Tab',shiftKey:false});assert.equal(tab.prevented,true);assert.equal(f.doc.activeElement,first);f.context.closeSessionLink();assert.equal(f.doc.activeElement,opener);assert.equal(opener.focusOptions.preventScroll,true);assert.equal(f.counters.state,0);
});
test('Settings card loads the dialog after app and beside the sidebar without any AI or view restart calls',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert.match(app,/<h2>Codex・Claude の会話をリンク<\/h2>/);assert.match(app,/data-session-links="show"/);assert.ok(index.indexOf('src="sidebar-resize.js"')<index.indexOf('src="app.js"'));assert.ok(index.indexOf('src="app.js"')<index.indexOf('src="session-links.js"'));assert.doesNotMatch(source,/location\.reload|window\.open|\/api\/ai-tools|\/api\/chat\/send|renderSettings\(|\/api\/claude-import/);
});

module.exports={fixture,inventory,plan,result,clone};

async function externalFixture(t){
 const f=fixture('zh-TW');await Promise.resolve();f.doc.body.parse('<main id="main"></main>');
 const id='11111111-1111-4111-8111-111111111111',link={id,provider:'codex',title:'Original <script>title</script>',source:'Desktop',hasTranscript:true,broken:false};
 let status={id,busy:false,phase:'idle',approvals:[],verifiedSession:false},history={id,provider:'codex',title:link.title,messages:[{role:'user',text:'原文そのまま <img src=x>',at:'2026-10-07T00:00:00Z'}],signature:'initial',broken:false,active:false,warnings:[]};
 const storage=new Map();f.context.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
 f.context.api=async(route,body)=>{f.calls.push({route,body:body?clone(body):undefined});if(route.includes('/status?'))return clone(status);if(route.includes('/history?'))return clone(history);if(route.endsWith('/send'))return{...clone(status),requestId:body.requestId,busy:true,phase:'preparing'};if(route.endsWith('/remove'))return{removed:true,links:[]};if(route.endsWith('/answer')||route.endsWith('/stop'))return clone(status);throw Error('unexpected API '+route);};
 f.context.linkFixture=link;f.run('externalSessionLinks=[linkFixture];view={kind:"external",link:linkFixture.id,project:"native",task:null};renderSessionLink()');await new Promise(setImmediate);f.calls.length=0;
 return{...f,id,link,storage,status:value=>{status={...status,...value};},history:value=>{history={...history,...value};},input:async text=>{f.node('external-compose').value=text;await f.dispatch('input',f.node('external-compose'));},refresh:()=>f.context.refreshExternalSession(id,true)};
}
test('External history is read from its provider, escaped without translating user text, and renderer preserves the composer across refresh',async t=>{
 const f=await externalFixture(t);assert.match(f.node('external-history').innerHTML,/原文そのまま &lt;img src=x&gt;/);assert.doesNotMatch(f.node('external-history').innerHTML,/<img/);assert.match(f.node('main').innerHTML,/Codex/);assert.doesNotMatch(f.node('main').innerHTML,/<select/);
 await f.input('Unsent draft');const compose=f.node('external-compose'),main=f.node('main').innerHTML;f.run('renderSessionLink()');await f.refresh();assert.equal(f.node('external-compose'),compose);assert.equal(compose.value,'Unsent draft');assert.equal(f.node('main').innerHTML,main);
 assert.ok(f.calls.every(call=>call.route.includes('/history?')||call.route.includes('/status?')));assert.equal(f.counters.state,0);
});
test('Send keeps its draft until same-session verification and never duplicates a busy request or destroys typing during acceptance',async t=>{
 const f=await externalFixture(t);await f.input('First instruction');let release;const normal=f.context.api;f.context.api=(route,body)=>route.endsWith('/send')?(f.calls.push({route,body:clone(body)}),new Promise(resolve=>{release=resolve;})):normal(route,body);
 const pending=f.context.sendExternalSession();await f.context.sendExternalSession();assert.equal(f.calls.length,1);const request=f.calls[0].body;assert.match(request.requestId,/^[a-f0-9-]{36}$/);assert.deepEqual(Object.keys(request).sort(),['id','requestId','text']);assert.equal(request.id,f.id);assert.equal(f.node('external-compose').value,'First instruction');
 await f.input('Next draft');release({id:f.id,requestId:request.requestId,busy:true,phase:'running',verifiedSession:true,approvals:[]});await pending;assert.equal(f.node('external-compose').value,'Next draft');assert.equal(f.node('external-send').disabled,true);
 f.status({requestId:request.requestId,busy:false,phase:'completed',verifiedSession:true,historyUpdated:true});f.history({signature:'completed',messages:[{role:'assistant',text:'Provider answer'}]});await f.refresh();assert.equal(f.node('external-compose').value,'Next draft');assert.match(f.node('external-history').innerHTML,/Provider answer/);
 await f.input('First instruction');assert.equal(f.node('external-compose').value,'First instruction');assert.equal(f.node('external-send').disabled,false);
});
test('A lost send response preserves the instruction and retries only manually with the exact same request ID',async t=>{
 const f=await externalFixture(t);await f.input('Selected instruction');let requests=[];f.context.api=async(route,body)=>{requests.push({route,body:clone(body)});throw Error('connection lost');};await f.context.sendExternalSession();const first=requests[0].body;assert.equal(f.node('external-compose').value,'Selected instruction');assert.match(f.node('external-status').textContent,/無法確認送出結果/);assert.equal(requests.length,1);
 await f.input('Changed text');await f.context.sendExternalSession();assert.equal(requests.length,1);await f.input('Selected instruction');await f.context.sendExternalSession();assert.equal(requests.length,2);assert.equal(requests[1].body.requestId,first.requestId);assert.equal(requests[1].body.text,first.text);
 assert.equal(JSON.parse(f.storage.get('hub-external-'+f.id)).request.requestId,first.requestId);
});
test('Broken, missing and native-busy histories disable sending while unknown native activity remains explicit',async t=>{
 const f=await externalFixture(t);await f.input('Do work');f.history({active:true});await f.refresh();assert.equal(f.node('external-send').disabled,true);await f.context.sendExternalSession();assert.ok(f.calls.every(call=>!call.route.endsWith('/send')));assert.match(f.node('external-status').textContent,/原 App 正在執行/);
 f.history({active:false,broken:true});await f.refresh();assert.equal(f.node('external-send').disabled,true);f.history({broken:false,signature:''});await f.refresh();assert.equal(f.node('external-send').disabled,true);
 f.history({signature:'readable',active:null});await f.refresh();assert.match(f.node('external-status').textContent,/執行狀態不明/);
});
test('Native permission requests are escaped and never approved until a separate human allow or deny action',async t=>{
 const f=await externalFixture(t);f.status({busy:true,phase:'approval',approvals:[{id:'approval-one',kind:'command',detail:{command:'echo <script>unsafe</script>',diff:'- old\n+ new'}}]});await f.refresh();assert.match(f.node('external-approvals').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(f.node('external-approvals').innerHTML,/<script>/);assert.equal(f.calls.filter(call=>call.route.endsWith('/answer')).length,0);
 await f.context.externalSessionAction('answer','unknown',true);assert.equal(f.calls.filter(call=>call.route.endsWith('/answer')).length,0);await f.context.externalSessionAction('answer','approval-one',false);
 assert.deepEqual(f.calls.at(-1),{route:'/api/session-links/answer',body:{id:f.id,approvalId:'approval-one',allow:false}});await f.context.externalSessionAction('answer','approval-one',true);assert.equal(f.calls.at(-1).body.allow,true);assert.doesNotMatch(JSON.stringify(f.calls),/permanent/);
});
test('Only this tool’s own busy turn offers Stop; removing a link calls only the reference endpoint',async t=>{
 const f=await externalFixture(t);f.history({active:true});await f.refresh();assert.equal(f.node('external-stop').hidden,true);await f.context.externalSessionAction('stop');assert.equal(f.calls.filter(call=>call.route.endsWith('/stop')).length,0);
 f.status({busy:true,phase:'running'});await f.refresh();assert.equal(f.node('external-stop').hidden,false);await f.context.externalSessionAction('stop');assert.deepEqual(f.calls.at(-1),{route:'/api/session-links/stop',body:{id:f.id}});
 f.status({busy:false,phase:'completed'});await f.refresh();f.calls.length=0;await f.context.removeExternalSession();assert.deepEqual(f.calls,[{route:'/api/session-links/remove',body:{id:f.id,confirm:true}}]);assert.equal(f.context.view.kind,'settings');assert.equal(f.run('externalSessionLinks.length'),0);
});
test('Returning to a linked conversation restores its history and persisted draft without starting an AI',async t=>{
 const f=await externalFixture(t);await f.input('Preserved draft');const first=f.node('external-compose');f.context.view={kind:'settings'};f.node('main').innerHTML='<div>settings</div>';f.context.view={kind:'external',link:f.id,project:'native'};f.context.renderSessionLink();await new Promise(setImmediate);
 assert.notEqual(f.node('external-compose'),first);assert.equal(f.node('external-compose').value,'Preserved draft');assert.match(f.node('external-history').innerHTML,/原文そのまま/);assert.ok(f.calls.every(call=>!call.route.endsWith('/send')));
});

test('Thousands of source sessions render only the latest 200, with searchable older choices and explicit helper provenance',async()=>{
 const f=fixture('zh-TW'),sessions=Array.from({length:3000},(_,i)=>({id:'source-'+i,title:'Session '+String(i).padStart(4,'0'),provider:'codex',hasTranscript:true,linked:false,updatedAt:new Date(1700000000000+i*1000).toISOString(),source:'Desktop',sourceKind:i===2999?'guardian':'cli',isSubagent:i===2999}));
 f.context.api=async()=>({supported:true,links:[],warnings:[],projects:[{id:'large',name:'Large group',provider:'codex',sessions}]});await f.context.showSessionLink();
 let choices=f.controls('[data-session-choice]');assert.equal(choices.length,200);assert.ok(choices.every(input=>!input.checked));assert.ok(choices.some(input=>input.dataset.sessionChoice==='source-2999'));assert.ok(choices.every(input=>Number(input.dataset.sessionChoice.slice(7))>=2800));
 assert.match(f.node('session-links-groups').innerHTML,/只顯示最近或符合搜尋的 200 段會話/);assert.match(f.node('session-links-groups').innerHTML,/輔助會話/);assert.equal(f.controls('[data-session-select-group]')[0].disabled,true);await f.change('[data-session-choice]','source-2999');
 const search=f.node('session-links-search');search.value='Session 0000';await f.dispatch('input',search);assert.equal(f.controls('[data-session-choice]').length,1);await f.change('[data-session-choice]','source-0');assert.deepEqual(f.selected(),['source-2999','source-0']);
 search.value='';await f.dispatch('input',search);assert.equal(f.controls('[data-session-choice]').length,200);assert.deepEqual(f.selected(),['source-2999','source-0']);
});
test('Explicit group choices remain across searches and reject a selection beyond 200 without changing existing choices',async()=>{
 const f=fixture('zh-TW'),projects=['A','B','C'].map((name,g)=>({id:'group-'+name,name:'Group '+name,provider:'codex',sessions:Array.from({length:100},(_,i)=>({id:name+'-'+i,title:name+' session '+i,provider:'codex',hasTranscript:true,linked:false,updatedAt:new Date(1700000000000+(g*100+i)*1000).toISOString()}))}));
 f.context.api=async()=>({supported:true,links:[],warnings:[],projects});await f.context.showSessionLink();const search=f.node('session-links-search');
 for(const name of ['A','B']){search.value='Group '+name;await f.dispatch('input',search);await f.change('[data-session-select-group]','group-'+name);}
 assert.equal(f.selected().length,200);const before=f.selected();search.value='Group C';await f.dispatch('input',search);await f.change('[data-session-select-group]','group-C');assert.deepEqual(f.selected(),before);assert.match(f.node('session-links-status').textContent,/一次最多選取 200 段會話/);
 await f.change('[data-session-choice]','C-0');assert.deepEqual(f.selected(),before);assert.equal(f.controls('[data-session-choice]')[0].checked,false);
});
