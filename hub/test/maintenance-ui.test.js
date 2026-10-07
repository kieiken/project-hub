'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(overrides={}) {
 const elements=new Map(),events=new Map(),calls=[];
 let candidates=[],actions=[];
 const el=k=>{if(!elements.has(k))elements.set(k,{innerHTML:'',textContent:'',hidden:true,value:'',disabled:false,checked:false,indeterminate:false,dataset:{},scrollIntoView(){}});return elements.get(k);};
 const body=el('#maintenance-body');let html='';
 Object.defineProperty(body,'innerHTML',{get:()=>html,set:value=>{
  html=value;candidates=[];actions=[];elements.delete('#maintenance-select-all');
  for(const match of value.matchAll(/<(input|button)\b([^>]*)>/g)) {
   const attrs=match[2],id=attrs.match(/\bid="([^"]*)"/)?.[1];
   const item=id?el('#'+id):{dataset:{}};item.id=id||'';item.disabled=/\sdisabled\b/.test(attrs);item.checked=/\schecked\b/.test(attrs);item.indeterminate=false;
   const candidate=attrs.match(/data-maint-candidate="([^"]*)"/)?.[1],action=attrs.match(/data-maint-action="([^"]*)"/)?.[1],transaction=attrs.match(/data-transaction="([^"]*)"/)?.[1];
   if(candidate!==undefined){item.dataset.maintCandidate=candidate;candidates.push(item);}
   if(action!==undefined){item.dataset.maintAction=action;item.dataset.transaction=transaction;actions.push(item);}
  }
 }});
 const result=el('#maintenance-result');let resultHTML='';
 Object.defineProperty(result,'innerHTML',{get:()=>resultHTML,set:value=>{
  resultHTML=value;actions=actions.filter(x=>x.dataset.maintAction!=='solve');
  if(value.includes('data-maint-action="solve"'))actions.push({dataset:{maintAction:'solve'},disabled:value.includes('type="button" disabled')});
 }});
 const queryAll=s=>s==='[data-maint-candidate]'?candidates:s==='[data-maint-candidate]:checked'?candidates.filter(x=>x.checked):s==='[data-maint-action]'?actions:[];
 const ctx=vm.createContext({document:{querySelector:s=>s.startsWith('[data-')?queryAll(s)[0]||null:elements.get(s)||null,querySelectorAll:queryAll,addEventListener:(key,f,capture)=>events.set(key+(capture?':capture':''),f)},$:s=>s==='#maintenance-select-all'?elements.get(s)||null:el(s),
  proj:()=>({id:'p',name:'Project <test>'}),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),toast(){},view:{},save(){},localStorage:{setItem(){}},load:async()=>{},confirm:()=>false,api:async(route,body)=>{calls.push({route,body});return {token:'token',candidates:[],excluded:[],history:[],scripts:[]};}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/maintenance.js'),'utf8'),ctx);
 const data={token:'token',candidates:[{id:'choice',label:'old <file>',paths:['/old.dat'],bytes:20}],excluded:[],history:[],scripts:[{name:'test',command:'node test.cjs',hash:'hash',allowed:true}],...overrides};
 vm.runInContext('maintenanceProject="p";maintenanceData='+JSON.stringify(data),ctx);ctx.drawMaintenance();
 const click=dataset=>events.get('click')({target:{closest:selector=>selector==='[data-maint-action]'?actions.find(x=>x.dataset.maintAction===dataset.maintAction)||{dataset,disabled:false}:null}});
 const change=item=>events.get('change')({target:item});
 const select=(index,checked=true)=>{candidates[index].checked=checked;change(candidates[index]);};
 const selectAll=checked=>{const all=el('#maintenance-select-all');all.checked=checked;change(all);};
 return {ctx,el,events,calls,click,change,select,selectAll,get candidates(){return candidates;},get actions(){return actions;},data};
}
test('cleanup candidates start unchecked, apply starts disabled and dangerous text is escaped',()=>{
 const a=fixture(),html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/type="checkbox" data-maint-candidate="choice"/);assert.doesNotMatch(html,/type="checkbox"[^>]*\bchecked\b/);
 assert.match(html,/id="maintenance-apply"[^>]*disabled/);assert.match(html,/old &lt;file&gt;/);
});
test('cancel cleanup, restore or script verification never invokes their API',async()=>{
 const a=fixture();a.select(0);a.el('#maintenance-script').value='test';
 for(const action of ['apply','restore','test'])await a.click({maintAction:action,transaction:'record'});
 assert.equal(a.calls.length,0);
});
test('apply sends only explicit choices and script verification shows escaped output',async()=>{
 const a=fixture();a.ctx.confirm=()=>true;a.select(0);
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return route.endsWith('/preview')?{token:'new',candidates:[],excluded:[],history:[],scripts:[]}:{moved:1};};
 await a.click({maintAction:'apply'});assert.equal(a.calls[0].route,'/api/maintenance/apply');assert.deepEqual(Array.from(a.calls[0].body.selected),['choice']);assert.equal(a.calls[0].body.confirm,true);
 a.el('#maintenance-script').value='';a.ctx.api=async()=>({ok:true,checks:[],note:'structure',result:{command:'node test.cjs',ok:true,output:'<script>bad</script>'}});
 await a.click({maintAction:'verify'});assert.match(a.el('#maintenance-result').innerHTML,/&lt;script&gt;/);
});

test('候補ゼロは無効理由を表示し、ゴミ箱移動のAPIを呼ばない', async()=>{
 const a=fixture({candidates:[]}),html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/片付けるものはありませんでした/);
 assert.match(html,/id="maintenance-apply"[^>]*disabled/);
 assert.match(html,/aria-describedby="maintenance-selection-note"/);
 assert.match(html,/移せる候補がないため、このボタンは使えません/);
 a.ctx.confirm=()=>true;await a.click({maintAction:'apply'});assert.equal(a.calls.length,0);
});
test('候補の選択数と無効理由を更新し、選択を外すと移動を無効にする',()=>{
 const a=fixture();
 a.select(0);
 assert.equal(a.el('#maintenance-apply').disabled,false);assert.match(a.el('#maintenance-selection-note').textContent,/1件を選択/);
 a.select(0,false);
 assert.equal(a.el('#maintenance-apply').disabled,true);assert.match(a.el('#maintenance-selection-note').textContent,/候補を選んで/);
});
test('候補再取得の処理中・完了を表示し、同じ結果でも完了が分かる',async()=>{
 const a=fixture();let resolve;
 a.ctx.api=async(route,body)=>{if(route.endsWith('/history'))return {history:[]};a.calls.push({route,body});return new Promise(r=>resolve=r);};
 const pending=a.click({maintAction:'refresh'});
 assert.equal(a.el('#maintenance-preview-status').textContent,'探しています…');
 assert.equal(a.el('#maintenance-apply').disabled,true);
 await a.click({maintAction:'refresh'});assert.equal(a.calls.length,1);
 resolve({token:'new',candidates:[],excluded:[],history:[],scripts:[]});await pending;
 assert.match(a.el('#maintenance-body').innerHTML,/片付けるものはありませんでした/);
 const again=a.click({maintAction:'refresh'});assert.equal(a.calls.length,2);
 resolve({token:'newer',candidates:[],excluded:[],history:[],scripts:[]});await again;
});
test('取得失敗を表示し、完了と誤表示しない',async()=>{
 const a=fixture();a.ctx.api=async()=>{throw Error('接続できません');};
 await a.click({maintAction:'refresh'});
 assert.equal(a.el('#maintenance-preview-status').textContent,'候補の取得に失敗しました：接続できません');
 assert.equal(a.el('#maintenance-result').textContent,'接続できません');
});
test('走査中止の理由を上部へ出し、候補なしの正常終了と区別する',()=>{
 const a=fixture({token:'',candidates:[],excluded:[{reason:'大きい参照<file>を確認できません'}]});
 const html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/id="maintenance-preview-status"[^>]*>確認しきれず止めました：大きい参照&lt;file&gt;を確認できません/);
 assert.doesNotMatch(html,/安全に整理できる候補はありません/);
 assert.match(html,/参照を確認しきれないため/);
});

test('unified entry and stopped path are clear; no test command means no execution button',()=>{
 const a=fixture({token:'',candidates:[],scripts:[],stopped:{reason:'large',path:'/資料/<raw>.json',size:2097152}}),h=a.el('#maintenance-body').innerHTML;
 assert.match(h,/資料\/&lt;raw&gt;.json/);assert.match(h,/2.0 MB/);assert.match(h,/アプリが動くかは見ません/);
 assert.doesNotMatch(h,/data-maint-action="test"/);
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert.equal((source.match(/data-maintenance="1"/g)||[]).length,1);assert.doesNotMatch(source,/data-maintenance="verify"/);
});
test('busy state blocks apply, verification and restore before calling API',async()=>{
 const a=fixture({busy:true}),h=a.el('#maintenance-body').innerHTML;
 assert.match(h,/AIが作業中/);assert.match(h,/data-maint-action="verify"[^>]*disabled/);
 for(const action of ['apply','verify','test','restore','unremove'])await a.click({maintAction:action});assert.equal(a.calls.length,0);
});
test('structural verification never sends a selected app script, test does',async()=>{
 const a=fixture();a.el('#maintenance-script').value='test';a.ctx.confirm=()=>true;
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return {ok:true,checks:[],note:'fixture'};};
 await a.click({maintAction:'verify'});assert.equal(a.calls[0].body.script,'');
 await a.click({maintAction:'test'});assert.equal(a.calls[1].body.script,'test');assert.equal(a.calls[1].body.expectedHash,'hash');
});
test('history retrieval failure does not hide usable cleanup preview',async()=>{
 const a=fixture();a.ctx.api=async route=>{if(route.endsWith('/history'))throw Error('<failed>');return {token:'new',candidates:[],excluded:[],history:[],scripts:[]};};
 await a.click({maintAction:'refresh'});assert.match(a.el('#maintenance-body').innerHTML,/片付けるものはありませんでした/);assert.match(a.el('#maintenance-body').innerHTML,/削除の記録を取得できませんでした：&lt;failed&gt;/);
});
test('stale project responses do not overwrite a later preview',async()=>{
 const a=fixture();let resolve;a.ctx.api=route=>route.endsWith('/history')?Promise.resolve({history:[]}):new Promise(r=>resolve=r);
 const pending=a.ctx.refreshMaintenance();vm.runInContext('maintenanceProject="other";maintenanceData={marker:"newer"}',a.ctx);
 resolve({token:'old',candidates:[],excluded:[],history:[],scripts:[]});await pending;
 assert.equal(vm.runInContext('maintenanceData.marker',a.ctx),'newer');
});

test('別プロジェクトとその作業を一覧で押すと閉じ、同じ所属や一覧外では開いたまま',()=>{
 const a=fixture(),drawer=a.el('#maintenance-drawer');
 for(const [dataset,inList,closed] of [
  [{go:'project',p:'other'},true,true], [{go:'work',p:'other',t:'t'},true,true],
  [{go:'project',p:'p'},true,false], [{go:'work',p:'p',t:'same'},true,false],
  [{go:'work',p:'other',t:'t'},false,false], [{go:'newproject'},true,false],
  [{p:'other',treeMenu:'1'},true,false],
 ]) {
  drawer.hidden=false;
  a.events.get('click:capture')({target:{closest:s=>{
   assert.equal(s,'#list [data-go][data-p]');
   return inList && dataset.go && dataset.p ? {dataset} : null;
  }},preventDefault(){assert.fail('navigation must continue');},stopPropagation(){assert.fail('navigation must continue');}});
  assert.equal(drawer.hidden,closed);
 }
 assert.equal(a.calls.length,0);
});

test('別プロジェクトを押して閉じても、実行中の片付けと完了通知は続く',async()=>{
 const a=fixture();a.ctx.confirm=()=>true;a.select(0);let finish;const notices=[];
 a.ctx.toast=message=>notices.push(message);
 a.ctx.api=async(route,body)=>{
  a.calls.push({route,body});
  if(route.endsWith('/apply'))return new Promise(r=>finish=r);
  return route.endsWith('/history')?{history:[]}:{...a.data,candidates:[]};
 };
 a.el('#maintenance-drawer').hidden=false;
 const pending=a.click({maintAction:'apply'});
 a.events.get('click:capture')({target:{closest:()=>({dataset:{go:'work',p:'other',t:'t'}})}});
 assert.equal(a.el('#maintenance-drawer').hidden,true);
 assert.equal(vm.runInContext('maintenancePending',a.ctx),true);
 assert.equal(vm.runInContext('maintenanceProject',a.ctx),'p');
 finish({moved:1});await pending;
 assert.equal(vm.runInContext('maintenancePending',a.ctx),false);
 assert.equal(a.calls[0].body.project,'p');assert.deepEqual(notices,['1件をゴミ箱へ移しました']);
 assert.equal(a.el('#maintenance-drawer').hidden,true);
});

const twoCandidates=[{id:'one',label:'first',paths:['/first.tmp'],bytes:20},{id:'two',label:'second',paths:['/second.tmp'],bytes:30}];
for(const action of ['refresh','apply','restore','unremove']) {
 test(`${action} disables every control while pending and restores candidate selection after redraw`,async()=>{
  const a=fixture({candidates:twoCandidates,history:[{id:'record',at:'2026-09-01T00:00:00Z',count:1}]}),old=a.candidates;
  a.ctx.confirm=()=>true;a.select(0);let finish;
  a.ctx.api=async(route,body)=>{
   a.calls.push({route,body});
   if(route.endsWith('/history'))return {history:[]};
   if(route.endsWith('/preview'))return action==='refresh'?new Promise(r=>finish=r):{...a.data,token:'new'};
   return new Promise(r=>finish=r);
  };
  const pending=a.click({maintAction:action,transaction:'record'});
  assert.ok(old.every(x=>x.disabled));assert.equal(a.el('#maintenance-select-all').disabled,true);assert.ok(a.actions.every(x=>x.disabled));
  await a.click({maintAction:'refresh'});assert.equal(a.calls.length,1);
  finish(action==='refresh'?{...a.data,token:'new'}:{moved:1,restored:1});await pending;
  assert.notEqual(a.candidates,old);assert.ok(a.candidates.every(x=>!x.disabled && !x.checked));
  assert.equal(a.el('#maintenance-select-all').disabled,false);assert.equal(a.el('#maintenance-select-all').checked,false);
  assert.equal(a.el('#maintenance-apply').disabled,true);
  a.select(1);assert.equal(a.el('#maintenance-apply').disabled,false);assert.match(a.el('#maintenance-selection-note').textContent,/1件を選択/);
 });
}
test('all selection tracks individual choices, mixed state and deselection',()=>{
 const a=fixture({candidates:twoCandidates}),all=a.el('#maintenance-select-all');
 assert.match(a.el('#maintenance-body').innerHTML,/すべて選ぶ（2件）/);assert.equal(all.dataset.maintCandidate,undefined);
 assert.equal(all.checked,false);assert.equal(all.indeterminate,false);
 a.select(0);assert.equal(all.checked,false);assert.equal(all.indeterminate,true);
 a.select(1);assert.equal(all.checked,true);assert.equal(all.indeterminate,false);
 a.select(0,false);assert.equal(all.checked,false);assert.equal(all.indeterminate,true);
 a.selectAll(true);assert.ok(a.candidates.every(x=>x.checked));assert.equal(all.checked,true);assert.equal(all.indeterminate,false);assert.match(a.el('#maintenance-selection-note').textContent,/2件を選択/);
 a.selectAll(false);assert.ok(a.candidates.every(x=>!x.checked));assert.equal(all.checked,false);assert.equal(all.indeterminate,false);assert.equal(a.el('#maintenance-apply').disabled,true);
});
test('all selection applies only candidate IDs with the existing confirmation and token',async()=>{
 const a=fixture({candidates:twoCandidates});let confirmation;
 a.ctx.confirm=text=>{confirmation=text;return true;};a.selectAll(true);
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return route.endsWith('/preview')?{...a.data,candidates:[]}:{moved:2,history:[]};};
 await a.click({maintAction:'apply'});
 assert.deepEqual(Array.from(a.calls[0].body.selected),['one','two']);assert.equal(a.calls[0].body.token,'token');assert.equal(a.calls[0].body.confirm,true);
 assert.match(confirmation,/2件の候補をゴミ箱へ移しますか/);assert.match(confirmation,/再開は新しい会話になります/);
 assert.equal(a.ctx.$('#maintenance-select-all'),null);
});
test('busy preview keeps candidates and all selection disabled but permits another refresh',async()=>{
 const a=fixture({candidates:twoCandidates});a.ctx.api=async route=>route.endsWith('/history')?{history:[]}:{...a.data,busy:true};
 await a.click({maintAction:'refresh'});
 assert.ok(a.candidates.every(x=>x.disabled));assert.equal(a.el('#maintenance-select-all').disabled,true);
 assert.equal(a.actions.find(x=>x.dataset.maintAction==='refresh').disabled,false);
 assert.ok(a.actions.filter(x=>x.dataset.maintAction!=='refresh').every(x=>x.disabled));
 a.ctx.api=async route=>route.endsWith('/history')?{history:[]}:{...a.data,busy:false};await a.click({maintAction:'refresh'});
 assert.ok(a.candidates.every(x=>!x.disabled));assert.equal(a.el('#maintenance-select-all').disabled,false);
});
test('failed operation restores selectable candidates and preserves selected IDs',async()=>{
 const a=fixture({candidates:twoCandidates});a.ctx.confirm=()=>true;a.selectAll(true);a.ctx.api=async()=>{throw Error('failed');};
 await a.click({maintAction:'apply'});
 assert.ok(a.candidates.every(x=>!x.disabled && x.checked));assert.equal(a.el('#maintenance-select-all').disabled,false);assert.equal(a.el('#maintenance-select-all').checked,true);assert.equal(a.el('#maintenance-apply').disabled,false);
});
test('zero candidates and stopped scans have no all-selection control',()=>{
 for(const overrides of [{candidates:[]},{token:'',candidates:[],stopped:{reason:'stopped'}}]) {
  const a=fixture(overrides);assert.doesNotMatch(a.el('#maintenance-body').innerHTML,/maintenance-select-all/);assert.equal(a.ctx.$('#maintenance-select-all'),null);assert.equal(a.el('#maintenance-apply').disabled,true);
 }
});


test('apply recheck stop displays the server reason and path without reporting a move',async()=>{
 const a=fixture();a.ctx.confirm=()=>true;a.select(0);
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});throw Error('移動前の参照確認を止めました：参照の総読量上限（/ref/<large>.txt）');};
 await a.click({maintAction:'apply'});
 assert.equal(a.calls.length,1);assert.equal(a.calls[0].route,'/api/maintenance/apply');
 assert.deepEqual(Array.from(a.calls[0].body.selected),['choice']);
 assert.match(a.el('#maintenance-result').textContent,/移動前.*総読量.*<large>/);assert.doesNotMatch(a.el('#maintenance-result').textContent,/移しました/);
 assert.equal(a.el('#maintenance-apply').disabled,false);assert.ok(a.candidates.every(x=>!x.disabled && x.checked));
});

for(const action of ['verify','test'])test(`${action}で構造の×がある時だけ問題解決を出し、テスト失敗だけでは出さない`,async()=>{
 const a=fixture();a.ctx.confirm=()=>true;a.el('#maintenance-script').value='test';
 for(const broken of [false,true]) {
  a.ctx.api=async()=>({ok:false,checks:[{name:'場所 <old>',ok:!broken,detail:'<missing>'}],note:'最新',result:action==='test'?{command:'node test',ok:false,output:'failed'}:undefined});
  await a.click({maintAction:action});
  assert.equal(a.actions.some(x=>x.dataset.maintAction==='solve'),broken);
  if(broken) {assert.equal(a.actions.find(x=>x.dataset.maintAction==='solve').disabled,false);assert.match(a.el('#maintenance-result').innerHTML,/&lt;missing&gt;/);}
 }
});
test('問題解決はプロジェクトだけ送り、二重押しを防ぎ、会話画面を開く',async()=>{
 const a=fixture();a.ctx.api=async()=>({ok:false,checks:[{ok:false,name:'×'}],note:''});await a.click({maintAction:'verify'});
 let finish,loaded=0,savedMode;
 a.ctx.load=async()=>{loaded++;};a.ctx.localStorage.setItem=(key,value)=>{assert.equal(key,'hub-mode');savedMode=value;};
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return new Promise(r=>finish=r);};
 const waiting=a.click({maintAction:'solve'});assert.ok(a.actions.every(x=>x.disabled));await a.click({maintAction:'solve'});
 assert.equal(a.calls.length,1);assert.equal(a.calls[0].route,'/api/maintenance/solve');assert.deepEqual(Object.keys(a.calls[0].body),['project']);
 finish({ok:true,task:'resolution'});await waiting;
 assert.equal(a.ctx.view.kind,'work');assert.equal(a.ctx.view.task,'resolution');assert.equal(a.ctx.view.project,'p');assert.equal(savedMode,'chat');assert.equal(loaded,1);assert.equal(a.el('#maintenance-drawer').hidden,true);
});
test('最新確認が正常なら作業へ移らず、開始失敗後にもう一度操作できる',async()=>{
 const a=fixture();a.ctx.api=async()=>({clear:true,note:'問題はありません'});await a.click({maintAction:'solve'});
 assert.equal(a.el('#maintenance-result').textContent,'問題はありません');assert.equal(a.ctx.view.kind,undefined);
 a.ctx.api=async()=>{throw Error('開始に失敗');};await a.click({maintAction:'solve'});assert.match(a.el('#maintenance-result').innerHTML,/開始に失敗/);assert.equal(a.actions.find(x=>x.dataset.maintAction==='solve').disabled,false);
 assert.ok(a.actions.filter(x=>x.dataset.maintAction!=='apply').every(x=>!x.disabled));
});

test('確認後にAIが始まった時も問題解決を無効にし、APIを送らない',async()=>{
 const a=fixture();a.ctx.api=async()=>({checks:[{ok:false,name:'問題'}],note:''});await a.click({maintAction:'verify'});
 a.ctx.state={sessions:[],chatting:[{project:'p',task:'other'}]};a.ctx.syncMaintenanceControls();
 assert.equal(a.actions.find(x=>x.dataset.maintAction==='solve').disabled,true);await a.click({maintAction:'solve'});assert.equal(a.calls.length,0);
 a.ctx.state.chatting=[];a.ctx.syncMaintenanceControls();assert.equal(a.actions.find(x=>x.dataset.maintAction==='solve').disabled,false);
});
