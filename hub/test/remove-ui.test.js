'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
{
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
const source=fs.readFileSync(path.join(__dirname,'../public/remove.js'),'utf8');
function fixture(t, failAt=1) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-remove-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
 for(const name of ['Alpha','Beta'])write(path.join(root,'Product',name,'PROJECT.md'),`---\nname: ${name}\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n`);
 const task=path.join(root,'Product/Alpha/.ai/tasks/work.md'),chat=path.join(root,'Product/Alpha/.ai/chat/work.jsonl'),other=path.join(root,'Product/Beta/PROJECT.md');
 write(task,'---\nid: work\ntitle: 作業の原名\nowner: 人\nstate: 未着手\n---\n## 手順\n- [ ] 作業\n');write(chat,'original chat\n');
 const before={task:fs.readFileSync(task),chat:fs.readFileSync(chat),other:fs.readFileSync(other)};
 const store=new Store(root);let moves=0, failing=true;
 const removal=new Removal({store,trash:path.join(root,'trash'),rename:(from,to)=>{if(failing&&++moves===failAt)throw Object.assign(Error('fixture move failure'),{code:'EIO'});fs.renameSync(from,to);}});
 const elements=new Map(),handlers=[],inputHandlers=[],calls=[];
 function runTitle(){return vm.runInContext('removePreview.title',context);}
 function element(key) {
  if(!elements.has(key))elements.set(key,{textContent:'',innerHTML:'',value:'',disabled:false,hidden:false,dataset:{},insertAdjacentHTML(where,html){this.innerHTML+=html;},querySelectorAll(){return [element('#remove-apply'),element('#remove-typed')];}});
  return elements.get(key);
 }
 const sheet=element('#remove-sheet');let html='';
 Object.defineProperty(sheet,'innerHTML',{get:()=>html,set:value=>{html=value;for(const key of ['#remove-status','#remove-apply','#remove-typed'])elements.delete(key);const button=value.match(/<button[^>]*id="remove-apply"[^>]*>/);if(button)element('#remove-apply').disabled=/\bdisabled\b/.test(button[0]);}});
 const api=async(route,body)=>{calls.push({route,body:JSON.parse(JSON.stringify(body))});if(route.endsWith('/preview'))return removal.preview(body.project,body.task);if(route.endsWith('/apply'))return removal.apply(body);if(route.endsWith('/restore'))return removal.restore(body.record,body.confirm);throw Error('unexpected API '+route);};
 const context=vm.createContext({$:element,esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),api,
  document:{body:{insertAdjacentHTML(){}},addEventListener(name,cb){if(name==='click')handlers.push(cb);if(name==='input')inputHandlers.push(cb);},querySelectorAll:()=>[]},
  view:{kind:'project',project:'Beta',task:null},proj:id=>store.readProject(id),displayParent:()=>'',state:{projects:[]},load:async()=>{},save(){},toast(){},confirm:()=>true});
 vm.runInContext(source,context);
 async function click(action){const button=action==='apply'?element('#remove-apply'):{disabled:false};button.dataset={removeAction:action};for(const handler of handlers)await handler({target:{closest:selector=>selector==='[data-remove-action]'?button:null}});}
 return{root,store,removal,context,calls,element,task,chat,other,before,click,input(){for(const handler of inputHandlers)handler({target:{id:'remove-typed',value:runTitle()}});},setFixed(){failing=false;},run:code=>vm.runInContext(code,context)};
}
test('A zero-move failure requires a fresh same-target preview before retrying and never changes another project',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');const first=f.run('removePreview.token');assert.equal(f.element('#remove-apply').disabled,false,f.element('#remove-sheet').innerHTML);
 await f.click('apply');assert.equal(f.element('#remove-apply').disabled,true);assert.match(f.element('#remove-status').textContent,/移動できませんでした/);assert.doesNotMatch(f.element('#remove-status').textContent,/移した0件/);
 assert.match(f.element('#remove-status').innerHTML,/data-remove-action="refresh"/);assert.doesNotMatch(f.element('#remove-status').innerHTML,/data-remove-restore/);
 assert.equal(f.removal.tokens.has(first),false);assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);
 await f.click('apply');assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).length,1);
 f.setFixed();await f.click('refresh');const next=f.run('removePreview.token');assert.notEqual(next,first);assert.equal(f.element('#remove-apply').disabled,false);
 assert.deepEqual(f.calls.at(-1),{route:'/api/hierarchy/remove/preview',body:{project:'Alpha',task:'work'}});
 await f.click('apply');assert.equal(fs.existsSync(f.task),false);assert.equal(fs.existsSync(f.chat),false);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
 assert.equal(f.context.view.project,'Beta');assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).at(-1).body.token,next);
});
test('A partial failure retains the real journal restore record even if refreshed task preview no longer exists',async t=>{
 const f=fixture(t,2);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const result=f.run('removeResult');assert.equal(result.moved.length,1);assert.equal(fs.existsSync(f.task),false);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);
 assert.match(f.element('#remove-status').innerHTML,new RegExp('data-remove-restore="'+result.record+'"'));
 await f.click('refresh');assert.match(f.element('#remove-status').innerHTML,new RegExp('data-remove-restore="'+result.record+'"'));assert.match(f.element('#remove-status').innerHTML,/作業不存在|沒有作業|作業がありません/);
 assert.equal(f.element('#remove-apply').disabled,true);assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).length,1);
 f.setFixed();await f.context.restoreRemoval(result.record);assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.chat),f.before.chat);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
});
test('Refreshing confirmation rejects a different target without enabling an old consumed token',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const token=f.run('removePreview.token');f.context.api=async()=>({...f.removal.preview('Beta'),task:''});
 await f.click('refresh');assert.equal(f.run('removePreview.token'),token);assert.equal(f.element('#remove-apply').disabled,true);assert.match(f.element('#remove-status').innerHTML,/削除する対象が変わりました/);
 assert.deepEqual(fs.readFileSync(f.task),f.before.task);assert.deepEqual(fs.readFileSync(f.other),f.before.other);
});

test('Maintenance history does not call a zero-move journal restored or offer a meaningless restore',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');await f.click('apply');
 const removed=f.removal.history();assert.equal(removed.length,1);assert.equal(removed[0].count,0);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/maintenance.js'),'utf8'),f.context);
 f.context.historyFixture={token:'preview',candidates:[],excluded:[],history:[],scripts:[],removed};
 f.run('maintenanceProject="Alpha";maintenanceData=historyFixture;drawMaintenance()');
 const html=f.element('#maintenance-body').innerHTML;assert.match(html,/移したものはありません/);assert.doesNotMatch(html,/元に戻しました|data-maint-action="unremove"/);
});

test('editing typed confirmation after a failed move cannot enable a consumed preview',async t=>{
 const f=fixture(t);await f.context.showRemoval('Alpha','work');await f.click('apply');
 f.input();assert.equal(f.element('#remove-apply').disabled,true);await f.click('apply');
 assert.equal(f.calls.filter(c=>c.route.endsWith('/apply')).length,1);
 f.setFixed();await f.click('refresh');assert.equal(f.element('#remove-apply').disabled,false);
});

}
{
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(extra={}){
 const elements=new Map(),events=new Map(),options=[],buttons=[],calls=[];
 const el=k=>{if(!elements.has(k))elements.set(k,{id:k.slice(1),value:'',disabled:false,checked:false,indeterminate:false,dataset:{},hidden:false,textContent:'',insertAdjacentHTML(where,html){this.innerHTML=(this.innerHTML||'')+html;}});return elements.get(k);};
 const sheet=el('#remove-sheet');sheet.querySelectorAll=()=>[...options,...buttons];let html='';Object.defineProperty(sheet,'innerHTML',{get:()=>html,set:value=>{
  html=value;options.length=0;buttons.length=0;for(const m of value.matchAll(/\bid="([^"]+)"/g))el('#'+m[1]);
  for(const m of value.matchAll(/<(input|button)\b([^>]*)>/g)){
   const a=m[2],id=a.match(/\bid="([^"]+)"/)?.[1],item=id?el('#'+id):{dataset:{}};item.disabled=/\sdisabled\b/.test(a);item.checked=/\schecked\b/.test(a);item.value='';
   const choice=a.match(/data-remove-option="([^"]+)"/)?.[1],action=a.match(/data-remove-action="([^"]+)"/)?.[1];if(choice){item.dataset.removeOption=choice;options.push(item);}if(action){item.dataset.removeAction=action;buttons.push(item);}
  }
 }});
 const ctx=vm.createContext({document:{addEventListener:(e,f)=>{if(!events.has(e))events.set(e,[]);events.get(e).push(f);},querySelectorAll:s=>s==='[data-remove-option]'?options:s==='[data-remove-option]:checked'?options.filter(x=>x.checked):[]},$:s=>elements.get(s)||null,esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),setTimeout(){},confirm:()=>false,load:async()=>{},api:async(route,body)=>{calls.push({route,body});return {failed:[],moved:[]};}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/remove.js'),'utf8'),ctx);
 const d={project:'P',task:'',title:'<P>',token:'token',move:[{path:'/P',what:'project'}],optional:[],keep:[{id:'free',path:'/outside/<file>',why:'outside',external:true,selectable:true},{id:'shared',path:'/shared',why:'outside',external:true,selectable:true},{id:'protected',path:'/Documents',why:'outside',external:true,selectable:false,unavailableWhy:'important root'}],blockers:[],warnings:[],typed:false,review:null,...extra};
 vm.runInContext('removePreview='+JSON.stringify(d),ctx);ctx.drawRemoval(d);
 const fire=async(event,target)=>{for(const f of events.get(event)||[])await f({target});};
 const change=(id,checked)=>{const x=id==='all'?el('#remove-select-all'):options.find(x=>x.dataset.removeOption===id);x.checked=checked;return fire('change',x);};
 const click=action=>fire('click',{closest:s=>s==='[data-remove-action]'?buttons.find(x=>x.dataset.removeAction===action):null});
 return {ctx,el,options,buttons,calls,change,click,d,fire};
}
test('external rows begin unchecked; all selects only selectable paths; individual choices sync mixed state and ids',async()=>{
 const f=fixture();assert.ok(f.options.every(x=>!x.checked));assert.equal(f.options[2].disabled,true);assert.match(f.el('#remove-sheet').innerHTML,/&lt;file&gt;/);
 await f.change('all',true);assert.equal(f.options[0].checked,true);assert.equal(f.options[1].checked,true);assert.equal(f.options[2].checked,false);
 await f.change('shared',false);assert.equal(f.el('#remove-select-all').checked,false);assert.equal(f.el('#remove-select-all').indeterminate,true);
 await f.click('apply');assert.deepEqual(Array.from(f.calls[0].body.optional),['free']);assert.equal(f.el('#remove-apply').disabled,true);
});
test('completed AI selects only none, deselects shared/unknown and never enables protected paths; manual decision survives redraw',async()=>{
 const d={id:'review',status:'done',results:[{id:'free',sharing:'なし',reason:'evidence'},{id:'shared',sharing:'不明',reason:'unknown'},{id:'protected',sharing:'なし',reason:'ignored'}]},f=fixture({review:d});
 assert.equal(f.options[0].checked,true);assert.equal(f.options[1].checked,false);assert.equal(f.options[2].checked,false);
 await f.change('free',false);await f.change('shared',true);f.ctx.drawRemoval(f.d);assert.equal(f.options[0].checked,false);assert.equal(f.options[1].checked,true);
});
test('running review and pending request block selection and deletion, including typing correct name',async()=>{
 const f=fixture({typed:true,review:{status:'running',results:[]}});assert.ok(f.options.every(x=>x.disabled));assert.equal(f.el('#remove-apply').disabled,true);
 f.el('#remove-typed').value=f.d.title;await f.fire('input',f.el('#remove-typed'));await f.click('apply');assert.equal(f.calls.length,0);assert.equal(f.el('#remove-apply').disabled,true);
});
test('review response refreshes token, auto choices and typed protection; failed status poll retains deletion block',async()=>{
 const f=fixture({review:{status:'running',results:[]},typed:true});f.el('#remove-typed').value=f.d.title;
 const next={...f.d,token:'fresh',review:{id:'r',status:'done',results:[{id:'free',sharing:'なし',reason:'evidence'},{id:'shared',sharing:'あり',reason:'evidence'}]}};
 f.ctx.api=async()=>({review:next.review,preview:next});await f.ctx.pollRemoval(0);assert.equal(f.el('#remove-typed').value,f.d.title);assert.equal(f.el('#remove-apply').disabled,false);assert.equal(f.options[0].checked,true);
 const g=fixture({review:{status:'running',results:[]}});g.ctx.api=async()=>{throw Error('network failed');};await g.ctx.pollRemoval(0);assert.equal(g.el('#remove-apply').disabled,true);assert.match(g.el('#remove-review-status').textContent,/network failed/);
});
test('refresh drops old automatic choices if results are stale, and a delayed poll cannot reopen a closed sheet',async()=>{
 const f=fixture({review:{id:'r',status:'done',results:[{id:'free',sharing:'なし',reason:'evidence'}]}});assert.equal(f.options[0].checked,true);
 f.ctx.api=async()=>({...f.d,token:'new',review:{id:'r',status:'stale',results:[],error:'changed'}});await f.click('refresh');assert.ok(f.options.every(x=>!x.checked));
 const g=fixture({review:{status:'running',results:[]}});let resolve;g.ctx.api=()=>new Promise(r=>resolve=r);const p=g.ctx.pollRemoval(0);await g.click('close');resolve({preview:{...g.d,review:{status:'done',results:[]}}});await p;assert.equal(g.el('#remove-sheet').hidden,true);
});

}
