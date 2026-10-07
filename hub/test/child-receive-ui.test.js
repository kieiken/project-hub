'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture() {
 const elements=new Map(),events={},calls=[];
 const el=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',hidden:false,textContent:'',value:'',dataset:{},addEventListener(){},setAttribute(){},querySelectorAll:()=>[],insertAdjacentHTML(){}});return elements.get(s);};
 const document={querySelector:el,querySelectorAll:()=>[],body:{insertAdjacentHTML(){},classList:{contains:()=>false}},addEventListener:(n,f)=>(events[n]||=[]).push(f)};
 const ctx=vm.createContext({document,window:{},navigator:{userAgent:''},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),setInterval(){},setTimeout(){},clearInterval(){},clearTimeout(){},requestAnimationFrame(){},console,URLSearchParams,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order')});
 const run=s=>vm.runInContext(s,ctx);
 run(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));
 run(fs.readFileSync(path.join(__dirname,'../public/task-transfer.js'),'utf8'));
 ctx.stubApi=async(route,body)=>{calls.push({route,body});if(ctx.failure){const e=Error(ctx.failure);e.status=ctx.status;throw e;}if(route.endsWith('/preview'))return{token:'fixture',title:'小作業',target:'本作業',files:[{id:'report',bytes:1}],blockers:[],guidance:''};return{parentProject:'p',parent:'parent'};};
 run(`api=stubApi;save=()=>{};load=async()=>{};render=()=>{};toast=()=>{};state={version:'4.63.2',latest:'4.63.3',projects:[{id:'p',name:'見本',tasks:[{id:'parent',title:'本作業',steps:[]},{id:'kid',title:'小作業',parent:'parent',state:'完了',steps:[]}]}],sessions:[],chatting:[]};view={kind:'work',project:'p',task:'parent'};`);
 return{ctx,run,el,calls,events,click:async action=>{for(const f of events.click||[])await f({target:{dataset:{},closest:s=>s==='[data-transfer-action]'?{dataset:{transferAction:action},disabled:false}:null}});}};
}
test('古い稼働版では帯とカードの受領を無効にし正式な版切替案内を表示する',async()=>{
 const f=fixture();f.run(`state.version='4.59.0'`);
 for(const html of [f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',text:'結果'})`)]){assert.match(html,/disabled/);assert.match(html,/新しい版 v4\.63\.3 にする/);assert.match(html,/AI と順番待ちが終わってから/);}
 await f.run('showTaskTransfer("p","kid")');assert.equal(f.calls.length,0);assert.match(f.el('#transfer-sheet').innerHTML,/新しい版/);
 // 数字で比較し、窓口追加版から有効。
 f.run(`state.version='4.61.0'`);assert.doesNotMatch(f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))'),/disabled/);
});
test('古い結果名と現在の子が違えば別の子を指さない。旧本文・新childTitle・別プロジェクトを照合',()=>{
 const f=fixture();
 for(const row of [`{childTitle:'昔の子',text:'結果'}`,`{text:'（子作業「昔の子」の結果）\\n本文'}`]){
  const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',...${row}})`);assert.doesNotMatch(html,/data-act="absorb"/);assert.match(html,/同じ番号の別の作業/);
 }
 const html=f.run(`msgHtml({role:'user',from:'subtask',child:'kid',text:'（子作業「小作業」の結果）\\n本文'})`);assert.match(html,/data-expect-title="小作業"/);
 f.run(`state.projects.push({id:'q',name:'別',tasks:[{id:'kid',title:'別の子',state:'完了',kind:'derived',derivedFrom:'p/parent'}]})`);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childProject:'q',childTitle:'別の子',text:'結果'})`),/data-p="q"/);
 assert.match(f.run(`msgHtml({role:'user',from:'subtask',child:'kid',childTitle:'小作業',handoff:'receipt',text:'受領'})`),/もう受け取って/);
});
test('古い通知の統合ボタンを現在の祖先・承認・子の完了状態で判定し理由を表示する',()=>{
 const f=fixture(),row=`{role:'user',from:'subtask',child:'kid',childTitle:'小作業',offer:'old-offer',text:'統合できます'}`;
 const html=()=>f.run(`msgHtml(${row})`),bar=()=>f.run('kidsDoneBar(proj("p"),taskOf(proj("p"),"parent"))');
 for(const parent of [{state:'実行中',steps:[{done:true}]},{state:'完了確認待ち',completionPending:true},{state:'実行中',completionPending:false,steps:[{done:true}]}]){
  f.run(`Object.assign(proj('p').tasks[0],${JSON.stringify(parent)})`);
  assert.match(html(),/data-act="absorb"[^>]*>統合…/);assert.match(bar(),/data-act="integrate"/);
 }
 f.run(`Object.assign(proj('p').tasks[0],{state:'完了',completionPending:false})`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/transfer-hint.*親は完了済み/);assert.doesNotMatch(bar(),/data-act="integrate"/);
 f.run(`proj('p').tasks[0].state='実行中';proj('p').tasks[1].state='実行中'`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/手順・質問が残って/);
 f.run(`proj('p').tasks[1].state='完了';proj('p').tasks[1].question='返事待ち'`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/手順・質問が残って/);
 f.run(`proj('p').tasks[1].question='';proj('p').tasks.push({id:'mid',title:'途中<&',parent:'parent',state:'実行中',steps:[{done:true}]});proj('p').tasks[1].parent='mid'`);
 assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/未完の中間親「途中&lt;&amp;」/);
 f.run(`proj('p').tasks[2].state='完了'`);assert.match(html(),/data-act="absorb"/);
 f.run(`proj('p').tasks[1].parent='other'`);assert.doesNotMatch(html(),/data-act="absorb"/);assert.match(html(),/祖先ではありません/);
 f.run(`proj('p').tasks[1].parent='parent'`);
 assert.doesNotMatch(f.run(`msgHtml({...${row},handoff:'received',integrating:'done'})`),/data-act="absorb"/);
 assert.match(f.run(`msgHtml({...${row},handoff:'received',integrating:'done'})`),/もう受け取って/);
});
test('previewと適用の404 not foundは版切替案内へ、業務エラーと通信失敗はその理由を保持',async()=>{
 const f=fixture();f.ctx.failure='not found';f.ctx.status=404;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.match(f.el('#transfer-sheet').innerHTML,/新しい版/);assert.match(f.el('#transfer-sheet').innerHTML,/窓口を確認できません/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/not found|まだ v/);
 f.ctx.failure='片付け済み';f.ctx.status=409;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/片付け済み/);assert.doesNotMatch(f.el('#transfer-sheet').innerHTML,/新しい版/);
 f.ctx.failure='network failure';f.ctx.status=undefined;await f.run('showTaskTransfer("p","kid")');assert.match(f.el('#transfer-sheet').innerHTML,/network failure/);
 f.ctx.failure=null;await f.run('showTaskTransfer("p","kid",[],"小作業")');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 await f.click('refresh');assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
 f.ctx.failure='not found';f.ctx.status=404;await f.click('apply');assert.match(f.el('#transfer-status').textContent,/新しい版/);assert.equal(f.calls.at(-1).body.expectTitle,'小作業');
});

test('ファイル選択を出さず内容説明と閉じた詳細、成果記録不足のAI回復を出す',()=>{
 const f=fixture();f.ctx.data={title:'子',target:'親',files:[{id:'report',bytes:1,description:'確認結果'}],blockers:[],guidance:''};f.run('drawTaskTransfer(data)');
 let html=f.el('#transfer-sheet').innerHTML;assert.match(html,/本作業に入るもの.*確認結果/);assert.doesNotMatch(html,/data-transfer-file|transfer-paths|<details open>/);
 f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.ctx.item={title:'子',files:[],move:[],optional:[],keep:[],blockers:['成果の記録がありません'],needsResults:true};f.run("integratePreview={target:'copy',items:[item]};drawTaskIntegration()");
 html=f.el('#integrate-sheet').innerHTML;assert.match(html,/この子のAIに成果の整理を頼む/);assert.match(html,/統合して片付ける/);assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional|<details open>|ファイルを指定/);
 f.ctx.item={title:'子',checked:true,copy:'child-copy',files:[{id:'report',description:'調査結果',bytes:1}],results:[{kind:'本体保存済み',value:'repo@abcdef0',description:'人数追加'}],move:[],optional:[],keep:[],blockers:[]};f.run("integratePreview={target:'copy',items:[item]};drawTaskIntegration()");
 html=f.el('#integrate-sheet').innerHTML;for(const text of ['本作業に入るもの','作業用コピーの変更','調査結果','すでに反映済み','人数追加','片付けるもの','統合して片付ける'])assert.ok(html.includes(text));assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional/);
 f.ctx.item.retainedFolders=['original-folder'];f.run('drawTaskIntegration()');html=f.el('#integrate-sheet').innerHTML;
 assert.match(html,/未受領の内容がある専用フォルダは、そのまま残します/);assert.doesNotMatch(html,/data-integrate-file|data-integrate-optional/);
});

 test('復旧画面は保存先・現在地・保持・受領前・更新を表示し、blockerなら承認できない',()=>{
 const f=fixture();f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.run(`integratePreview={resume:true,target:'new<&',recover:{savedTarget:'old<&',currentTarget:'new<&',reasons:['変更<&']},items:[{title:'済んだ子',state:'片付け済み',retained:true},{title:'残る子',state:'衝突',codeAlready:true,recordChanged:true,sourceChanged:true}],blockers:[]};drawTaskIntegration()`);
 let html=f.el('#integrate-sheet').innerHTML;assert.match(html,/保存された統合先：old&lt;&amp;/);assert.match(html,/現在の統合先：new&lt;&amp;/);assert.match(html,/片付け済み（保持します）/);assert.match(html,/コード取り込み済み（確認）/);assert.match(html,/受領・片付けはこれから/);assert.match(html,/記録の更新あり/);assert.match(html,/統合先を現在の場所に切り替えて続ける/);
 f.run(`integratePreview.blockers=['予約<&'];drawTaskIntegration()`);html=f.el('#integrate-sheet').innerHTML;assert.match(html,/予約&lt;&amp;/);assert.match(html,/data-integrate-action="apply"[^>]*disabled/);
 f.run(`integratePreview.blockers=[];integratePreview.recover.currentTarget=integratePreview.recover.savedTarget;drawTaskIntegration()`);assert.match(f.el('#integrate-sheet').innerHTML,/子の更新を確認して続ける/);
 });

test('am 一括統合は分類・進行・衝突解消を表示し、後回し結果から再開画面へ進む',async()=>{
 const f=fixture();f.run(fs.readFileSync(path.join(__dirname,'../public/task-integrate.js'),'utf8'));
 f.run(`integratePreview={target:'copy',items:[{title:'版',files:[],move:[],optional:[],keep:[],blockers:[],preview:{conflict:true,conflictKind:'bookkeeping'}},{title:'コード',files:[],move:[],optional:[],keep:[],blockers:[],preview:{conflict:true,conflictKind:'content',conflictPaths:['code<&.js']}}]};drawTaskIntegration()`);
 let html=f.el('#integrate-sheet').innerHTML;assert.match(html,/版・履歴だけぶつかる（自動で合わせます）/);assert.match(html,/コードがぶつかる：code&lt;&amp;\.js/);assert.doesNotMatch(html,/ぶつかる可能性|ぶつかったらそこで止め/);assert.match(html,/前の子を取り込むと結果が変わる/);
 f.run(`integratePreview={project:'p',task:'parent',token:'t',resume:true,target:'copy',items:[{title:'版',state:'片付け済み',retained:true,autoResolved:{from:'1.0.0',to:'1.0.1'}},{title:'コード',project:'p',task:'kid',state:'衝突',conflictPaths:['code<&.js']},{title:'親',state:'待ち',waitingFor:['コード']},{title:'受領',state:'取り込み済み',receiving:true}],blockers:[]};drawTaskIntegration()`);
 html=f.el('#integrate-sheet').innerHTML;for(const text of ['自動で合わせた版 1.0.0→1.0.1','後回し（衝突）','待ち（子孫の衝突待ち）','受領中','AIでぶつかりを解消','統合の続きを行う'])assert.ok(html.includes(text));
 assert.equal((html.match(/data-integrate-action="resolve"/g)||[]).length,1);
 f.run(`integratePreview.blockers=['busy'];drawTaskIntegration()`);assert.match(f.el('#integrate-sheet').innerHTML,/data-integrate-action="resolve"[^>]*disabled/);
 f.run(`integratePreview.blockers=[];drawTaskIntegration()`);
 // 委任に親・衝突子・確認tokenを渡し、終了後の再開を案内する。
 for(const listener of f.events.click||[])await listener({target:{dataset:{},closest:s=>s==='[data-integrate-action]'?{dataset:{integrateAction:'resolve',index:'1'},disabled:false}:null}});
 assert.equal(f.calls.at(-1).route,'/api/task/integrate/resolve');assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).body)),{project:'p',task:'parent',childProject:'p',childTask:'kid',token:'t'});assert.equal(f.el('#integrate-sheet').hidden,true);
 // 部分成功を通常の完了として閉じず、最新の再開previewを取得する。
 f.ctx.stubApi=async(route,body)=>{f.calls.push({route,body});return route.endsWith('/preview')?{resume:true,target:'copy',items:[{state:'衝突',title:'残る子'}]}:{partial:true};};
 f.run(`api=stubApi;integratePreview={project:'p',task:'parent',token:'new',resume:true,items:[]};`);
 for(const listener of f.events.click||[])await listener({target:{dataset:{},closest:s=>s==='[data-integrate-action]'?{dataset:{integrateAction:'apply'},disabled:false}:null}});
 assert.equal(f.calls.at(-1).route,'/api/task/integrate/preview');assert.equal(f.el('#integrate-sheet').hidden,false);assert.match(f.el('#integrate-sheet').innerHTML,/後回し（衝突）/);
});
