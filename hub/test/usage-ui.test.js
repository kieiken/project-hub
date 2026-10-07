'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/usage.js'),'utf8');
const NOW=Date.parse('2026-10-03T00:00:00Z');
const snapshot={providers:{codex:{status:'ok',fetchedAt:new Date(NOW).toISOString(),windows:[{id:'codex:primary',label:'週間枠',usedPercent:0,resetsAt:'2026-10-04T00:00:00Z'}]},claude:{status:'unavailable',message:'CLIが見つかりません',attemptedAt:new Date(NOW).toISOString()}}};
function app(){
  const elements=new Map(),events=new Map();
  const media={matches:false,addEventListener(n,cb){events.set('media:'+n,cb);}};
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:id==='#usage-drawer',get textContent(){return this.innerHTML.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&quot;/g,'"').replace(/&amp;/g,'&');},set textContent(v){this.innerHTML=String(v);},innerHTML:'',addEventListener(n,cb){events.set(id+':'+n,cb);},setAttribute(n,v){this[n]=v;},focus(){this.focused=true;}});return elements.get(id);};
  const c=vm.createContext({$:el,esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),api:()=>new Promise(()=>{}),document:{hidden:false,addEventListener(n,cb,capture){events.set(n+(capture?':capture':''),cb);}},matchMedia(query){assert.equal(query,'(max-width: 900px)');return media;},setInterval(){},console});
  vm.runInContext(source,c);return{c,el,events,media};
}
test('Both provider headings keep their names after a decorative icon in available and unavailable cards',()=>{
  const a=app();
  for(const status of ['ok','unavailable']){
    const providers=Object.fromEntries(['codex','claude'].map(ai=>[ai,{status,fetchedAt:new Date(NOW).toISOString(),windows:[],message:'確認中…'}]));
    const html=a.c.usageHtml({providers},NOW);
    const headings=html.match(/<h3>.*?<\/h3>/g);
    assert.equal(headings.length,2);
    for(const [i,ai] of ['codex','claude'].entries()){
      assert.match(headings[i],new RegExp(`^<h3><svg class="usage-icon usage-icon-${ai}"`));
      assert.match(headings[i],/aria-hidden="true" focusable="false"/);
      assert.match(headings[i],/width="16" height="16"/);
      assert.ok(headings[i].endsWith(`</svg>${ai==='codex'?'Codex':'Claude'}</h3>`));
      assert.doesNotMatch(headings[i],/<image|<title|tabindex|(?:href|src)=/);
    }
  }
  assert.doesNotMatch(a.c.usageHtml(null,NOW),/class="usage-icon usage-icon-/);
});
test('account names in usage headings are escaped',()=>{
  const a=app(),html=a.c.usageHtml({providers:{codex:{...snapshot.providers.codex,accountName:'<img src=x onerror=alert(1)>'}}},NOW);
  assert.match(html,/Codex・&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('Codex-only display adds tickets and exact grouped balances after windows; top bar stays unchanged',()=>{
  const a=app(),extras={resetCredits:{count:1,items:[{title:'Full reset',expiresAt:'2026-11-12T00:00:00Z'}]},credits:{balance:'62500',unlimited:false}};
  const p={...snapshot.providers.codex,...extras},html=a.c.usageHtml({providers:{codex:p,claude:p}},NOW);
  assert.equal((html.match(/リセットチケット：1枚/g)||[]).length,1);assert.equal((html.match(/クレジット残高：62,500/g)||[]).length,1);
  assert.ok(html.includes('Full reset・期限 '+a.c.usageDate(extras.resetCredits.items[0].expiresAt)));
  assert.ok(html.indexOf('usage-extras')>html.indexOf('usage-window'));assert.ok(html.indexOf('クレジット残高')<html.indexOf('取得：'));
  for(const compact of [false,true])assert.equal(a.c.usageSummary('codex',p,NOW,compact,true),a.c.usageSummary('codex',snapshot.providers.codex,NOW,compact,true));
  for(const [balance,text] of [['0','0'],['9007199254740993123456789.50','9,007,199,254,740,993,123,456,789.50']]) assert.match(a.c.usageExtras('codex',{credits:{balance}}),new RegExp('クレジット残高：'+text.replace(/\./g,'\\.')));
  assert.match(a.c.usageExtras('codex',{credits:{unlimited:true,balance:'123'}}),/クレジット残高：無制限/);
});
test('Extras escape all ticket text, omit missing or invalid data and do not add consuming controls',()=>{
  const a=app(),extra=a.c.usageExtras('codex',{resetCredits:{count:2,items:[{title:'<img src=x onerror=alert(1)>',expiresAt:'bad'},{title:'Second',expiresAt:null}]}});
  assert.match(extra,/&lt;img/);assert.match(extra,/期限 未提供／Second・期限 未提供/);assert.doesNotMatch(extra,/<img|<button|<a |input|onclick/);
  assert.equal(a.c.usageExtras('codex',{}),'');assert.equal(a.c.usageExtras('codex',{resetCredits:{count:0,items:[]}}),'');
  for(const balance of ['SECRET','1e5','5\n',12,null])assert.equal(a.c.usageExtras('codex',{credits:{balance}}),'');
  const html=a.c.usageHtml({providers:{codex:{status:'unavailable',credits:{balance:'62500'},resetCredits:{count:1}}}},NOW);
  assert.doesNotMatch(html,/usage-extras|クレジット残高|リセットチケット/);
});
test('Drawer displays every supplied account with escaped names and usage marker while the bar shows only selected providers',()=>{
  const a=app(),p=snapshot.providers.codex;
  const data={providers:{codex:p},accountProviders:[{ai:'codex',...p,account:'default',accountName:'既定',inUse:false,credits:{balance:'62500'}},{ai:'codex',...p,account:'work',accountName:'<img src=x>',inUse:true},{ai:'claude',account:'other',accountName:'仕事用',status:'unavailable',message:'一時失敗',inUse:false}]};
  const html=a.c.usageHtml(data,NOW);assert.equal((html.match(/usage-card/g)||[]).length,3);assert.equal((html.match(/使用中/g)||[]).length,1);
  assert.match(html,/Codex・既定/);assert.match(html,/Codex・&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/Claude・仕事用/);assert.match(html,/未取得.*一時失敗/);assert.match(html,/クレジット残高：62,500/);
  a.c.current=data;vm.runInContext('usageData=current',a.c);a.c.drawUsage();assert.doesNotMatch(a.el('#usage-toggle').textContent,/Claude|仕事用|img|クレジット/);
  a.c.current={providers:{},accountProviders:[]};vm.runInContext('usageData=current',a.c);a.c.drawUsage();assert.equal(a.el('#usage-toggle').textContent,'利用状況');assert.match(a.el('#usage-body').innerHTML,/ログイン中のアカウントはありません/);assert.doesNotMatch(a.el('#usage-body').innerHTML,/usage-card|Codex|Claude/);
});
test('OpenAI mark is a monochrome decorative knot and plan badges keep escaped provider names',()=>{
  const a=app(),icon=a.c.usageIcon('codex');
  assert.match(icon,/viewBox="0 0 24 24"/);assert.match(icon,/<path fill="currentColor"/);
  assert.doesNotMatch(icon,/<rect|stroke=|<title/);
  const html=a.c.usageHtml({providers:{codex:{...snapshot.providers.codex,plan:'Pro'},claude:{status:'ok',plan:'Max',windows:[],fetchedAt:new Date(NOW).toISOString()}}},NOW);
  assert.match(html,/<\/svg>Codex<span class="usage-plan">Pro<\/span>/);
  assert.match(html,/<\/svg>Claude<span class="usage-plan">Max<\/span>/);
  assert.doesNotMatch(a.c.usageHtml(snapshot,NOW),/usage-plan/);
  const escaped=a.c.usageHtml({providers:{codex:{...snapshot.providers.codex,plan:'<img src=x>'}}},NOW);
  assert.match(escaped,/usage-plan">&lt;img/);assert.doesNotMatch(escaped,/<img/);
});
test('Desktop includes all Claude model scopes; compact text stays short while labels remain complete',()=>{
  const a=app(),claude={status:'ok',fetchedAt:new Date().toISOString(),windows:[
    {id:'five_hour',label:'5時間枠',usedPercent:7,resetsAt:null},
    {id:'seven_day',label:'週間枠',usedPercent:78,resetsAt:null},
    {id:'seven_day_oauth_apps',label:'週間枠（OAuthアプリ）',usedPercent:3,resetsAt:null},
    {id:'model:0',label:'Fable・週間枠',usedPercent:100,resetsAt:null},
    {id:'model:1',label:'<img src=x>・週間枠',usedPercent:90,resetsAt:null}
  ]};
  a.c.current={providers:{claude}};vm.runInContext('usageData=current',a.c);a.c.drawUsage();
  assert.equal(a.c.usageSummary('claude',claude),'Claude 5時間 7%・週間 78%・Fable 100%・<img src=x> 90%');
  assert.equal(a.c.usageSummary('claude',claude,Date.now(),false,false,true),'Claude 5hr 7%・78%・Fable 100%・<img src=x> 90%');
  const button=a.el('#usage-toggle');
  assert.match(button.innerHTML,/Fable <span class="usage-value usage-limit">100%/);
  assert.match(button.innerHTML,/&lt;img/);assert.doesNotMatch(button.innerHTML,/<img|OAuth/);
  assert.doesNotMatch(button['aria-label'],/<span/);assert.match(button['aria-label'],/Fable 100%/);
  a.media.matches=true;a.events.get('media:change')();
  assert.equal(button.textContent,'CC 5hr 7% W 78%');
  assert.match(button.title,/Fable 100%/);
  const expired={...claude,windows:[{...claude.windows[3],resetsAt:new Date(Date.now()-1000).toISOString()}]};
  assert.match(a.c.usageSummary('claude',expired),/再確認待ち/);
  assert.doesNotMatch(a.c.usageSummary('claude',expired,Date.now(),false,true),/usage-limit|100%/);
});
test('Raw numeric boundaries color only percentages in summaries and details and preserve accessible values',()=>{
  const a=app();
  for(const [value,severity] of [[0,''],[89.9,''],[90,' usage-warning'],[99.9,' usage-warning'],[100,' usage-limit'],[120,' usage-limit'],[null,'']]){
    const p={status:'ok',fetchedAt:new Date(NOW).toISOString(),windows:[{id:'primary',label:'5時間枠',usedPercent:value,resetsAt:null}]};
    const full=a.c.usageSummary('codex',p,NOW,false,true),compact=a.c.usageSummary('codex',p,NOW,true,true),detail=a.c.usageHtml({providers:{codex:p}},NOW);
    for(const html of [full,compact,detail]){
      assert.equal(html.includes('usage-warning'),severity===' usage-warning');
      assert.equal(html.includes('usage-limit'),severity===' usage-limit');
    }
    const pct=value===null?'未提供':Math.round(value)+'%';
    assert.ok(detail.includes(`<span class="usage-pct">使用 <span class="usage-value${severity}">${pct}</span>`));
    if(value!==null)assert.ok(detail.includes(`aria-valuetext="${pct}"`));
    assert.equal(a.c.usageSummary('codex',p,NOW+7*60000,false,true),'Codex 前回の情報');
  }
  for(const value of [undefined,'100',NaN,Infinity])assert.equal(a.c.usagePercentClass(value),'');
});
test('late manual clear from an old task cannot replace the current account usage',async()=>{
  const a=app();let resolve;
  a.c.confirm=()=>true;a.c.api=()=>new Promise(r=>{resolve=r;});
  const p=a.c.clearFableLimit();
  a.c.current=snapshot;vm.runInContext('usageVersion++;usageData=current',a.c);
  resolve({providers:{},fableLimit:null});await p;
  assert.equal(vm.runInContext('usageData',a.c),snapshot);
});
test('Narrow top bar switches dynamically and keeps full accessible labels',()=>{
  const a=app();
  a.c.current={providers:{codex:{status:'ok',fetchedAt:new Date().toISOString(),windows:[{id:'codex:primary',label:'週間枠',usedPercent:8,resetsAt:null}]},claude:{status:'ok',fetchedAt:new Date().toISOString(),windows:[{id:'claude:session',label:'5時間枠',usedPercent:23,resetsAt:null},{id:'claude:weekly',label:'週間枠',usedPercent:63,resetsAt:null}]}}};
  vm.runInContext('usageData=current',a.c);
  a.c.drawUsage();
  const full='Codex 週間 8% / Claude 5時間 23%・週間 63%',line='Codex 8% / Claude 5hr 23%・63%';
  assert.equal(a.el('#usage-toggle').textContent,line);
  a.media.matches=true;a.events.get('media:change')();
  assert.equal(a.el('#usage-toggle').textContent,'CX 8% / CC 5hr 23% W 63%');
  assert.ok(a.el('#usage-toggle')['aria-label'].startsWith(full));
  assert.ok(a.el('#usage-toggle').title.startsWith(full));
  a.c.current.providers.claude.windows[1].usedPercent=64;a.c.drawUsage();
  assert.match(a.el('#usage-toggle').textContent,/W 64%$/);
  a.media.matches=false;a.events.get('media:change')();
  assert.equal(a.el('#usage-toggle').textContent,line.replace('63%','64%'));
});
test('Compact summary preserves unavailable, stale, expired and multiple-window distinctions',()=>{
  const a=app(),p=snapshot.providers.codex;
  assert.equal(a.c.usageSummary('codex',p,NOW,true),'CX 0%');
  assert.equal(a.c.usageSummary('claude',null,NOW,true),'CC 未取得');
  assert.equal(a.c.usageSummary('codex',p,NOW+7*60000,true),'CX 前回の情報');
  assert.equal(a.c.usageSummary('codex',{...p,windows:[{...p.windows[0],resetsAt:'2026-10-02T00:00:00Z'}]},NOW,true),'CX 再確認待ち');
  assert.equal(a.c.usageSummary('codex',{...p,windows:[{id:'first',label:'5時間枠',usedPercent:null,resetsAt:null},{id:'second',label:'週間枠',usedPercent:50,resetsAt:null}]},NOW,true),'CX 5hr 未提供 W 50%');
});
test('Usage details distinguish zero, unavailable, missing reset and passed reset without inventing data',()=>{
  const a=app(),html=a.c.usageHtml(snapshot,NOW);
  assert.match(html,/使用 <span class="usage-value[^"]*">0%/); assert.match(html,/週間枠/);assert.match(html,/CLIが見つかりません/);assert.match(html,/あと1日/);
  assert.equal(a.c.usageRemaining(null,NOW),'リセット日時は未提供');
  assert.match(a.c.usageRemaining('2026-10-02T00:00:00Z',NOW),/再確認待ち/);
  const p={...snapshot.providers.codex,windows:[{id:'codex:primary',label:'<script>',usedPercent:120,resetsAt:null}]};
  const h=a.c.usageHtml({providers:{codex:p}},NOW);
  assert.match(h,/&lt;script>/); assert.match(h,/value="100"/); assert.match(h,/使用 <span class="usage-value[^"]*">120%/);
  const past={...p,windows:[{id:'codex:primary',label:'週間枠',usedPercent:65,resetsAt:'2026-10-02T00:00:00Z'}]};
  const expired=a.c.usageHtml({providers:{codex:past}},NOW);
  assert.match(expired,/usage-expired/);assert.match(expired,/前回の使用 <span class="usage-value[^"]*">65%/);
});
test('Top bar shows real supplied windows and stale or expired data is identified',()=>{
  const a=app(),p=snapshot.providers.codex;
  assert.equal(a.c.usageSummary('codex',p,NOW),'Codex 週間 0%');
  assert.equal(a.c.usageSummary('codex',p,NOW,false,false,true),'Codex 0%');
  assert.equal(a.c.usageSummary('codex',{...p,windows:[{...p.windows[0],resetsAt:'2026-10-02T00:00:00Z'}]},NOW,false,false,true),'Codex 再確認待ち');
  assert.match(a.c.usageSummary('codex',p,NOW+7*60000),/前回の情報/);
  assert.match(a.c.usageSummary('codex',{...p,fetchedAt:new Date(NOW+86400000).toISOString()},NOW+86400000),/再確認待ち/);
  assert.match(a.c.usageSummary('claude',snapshot.providers.claude,NOW),/未取得/);
});
test('Refresh is coalesced in UI and connection failure hides old values',async()=>{
  const a=app();let count=0,resolve;
  vm.runInContext('usageLoading=false',a.c);
  a.c.api=()=>{count++;return new Promise(r=>{resolve=r;});};
  const p=a.c.loadUsage(true);await a.c.loadUsage(true);assert.equal(count,1);
  resolve(snapshot);await p;assert.match(a.el('#usage-body').innerHTML,/使用 <span class="usage-value[^"]*">0%/);
  a.c.api=()=>Promise.reject(new Error('SECRET'));await a.c.loadUsage(true);
  assert.doesNotMatch(a.el('#usage-body').innerHTML,/使用 <span class="usage-value[^"]*">0%|SECRET/);
  assert.match(a.el('#usage-toggle').textContent,/未取得/);
});
test('Usage drawer closes with Escape, restores focus and updates expanded state',()=>{
  const a=app();a.events.get('#usage-toggle:click')();assert.equal(a.el('#usage-drawer').hidden,false);
  assert.equal(a.el('#usage-toggle')['aria-expanded'],'true');
  let prevented=false;a.events.get('keydown')({key:'Escape',preventDefault(){prevented=true;}});
  assert.ok(prevented);assert.equal(a.el('#usage-drawer').hidden,true);assert.ok(a.el('#usage-toggle').focused);
});

test('外側のクリックは利用状況だけ閉じ、押した先の操作とフォーカスを妨げない',()=>{
  const a=app();a.events.get('#usage-toggle:click')();let operated=false,focused=false;
  a.el('#usage-toggle').focus=()=>{assert.fail('outside click must not restore focus');};
  const target={closest:()=>null,focus(){focused=true;},click(){operated=true;}};
  target.focus();
  a.events.get('click:capture')({target,preventDefault(){assert.fail('clicked action must continue');},stopPropagation(){assert.fail('clicked action must continue');}});
  target.click();
  assert.equal(a.el('#usage-drawer').hidden,true);assert.equal(a.el('#usage-toggle')['aria-expanded'],'false');
  assert.equal(operated,true);assert.equal(focused,true);
});

test('スマホ幅でも利用状況内を押して閉じず、ボタン再押しと×は従来どおりフォーカスを戻す',()=>{
  for(const compact of [false,true]) {
    const a=app();a.media.matches=compact;a.events.get('#usage-toggle:click')();
    const capture=target=>a.events.get('click:capture')({target:{closest:s=>{
      assert.equal(s,'#usage-drawer, #usage-toggle');return target;
    }}});
    for(const target of [a.el('#usage-body'),a.el('#usage-refresh'),a.el('#usage-toggle')]) {
      capture(target);assert.equal(a.el('#usage-drawer').hidden,false);
    }
    a.events.get('#usage-toggle:click')();assert.equal(a.el('#usage-drawer').hidden,true);
    assert.equal(a.el('#usage-toggle').focused,true);
    a.events.get('#usage-toggle:click')();capture(a.el('#usage-close'));
    a.el('#usage-toggle').focused=false;a.events.get('#usage-close:click')({type:'click'});
    assert.equal(a.el('#usage-drawer').hidden,true);assert.equal(a.el('#usage-toggle').focused,true);
  }
});
test('Cooldown visibly disables manual refresh and does not silently send a request',async()=>{
  const a=app();let calls=0;
  a.c.api=()=>{calls++;return Promise.resolve(snapshot);};
  vm.runInContext('usageLoading=false; usageData={providers:{},refreshAfter:new Date(Date.now()+15000).toISOString()};',a.c);
  await a.c.loadUsage(true);
  assert.equal(calls,0); assert.equal(a.el('#usage-refresh').disabled,true);
  assert.match(a.el('#usage-status').textContent,/秒後に再確認/);
  assert.equal(a.el('#usage-status')['aria-live'],'off');
  vm.runInContext('usageData.refreshAfter=new Date(Date.now()-1000).toISOString()',a.c);
  a.c.drawUsageControls();assert.equal(a.el('#usage-refresh').disabled,false);
});
test('Usage redraw and load preserve drawer position; focus never scrolls it',async()=>{
 const a=app(),drawer=a.el('#usage-drawer');drawer.scrollTop=350;
 let actual='';Object.defineProperty(a.el('#usage-body'),'innerHTML',{get(){return actual;},set(v){actual=v;drawer.scrollTop=0;}});
 a.c.drawUsage();assert.equal(drawer.scrollTop,350);
 let focused;a.el('#usage-close').focus=options=>{focused=options;};a.events.get('#usage-toggle:click')();
 assert.equal(focused.preventScroll,true);assert.equal(drawer.scrollTop,350);
 vm.runInContext('usageLoading=false',a.c);a.c.api=()=>Promise.resolve(snapshot);await a.c.loadUsage();assert.equal(drawer.scrollTop,350);
});

test('Fable上限中のAstra直行を詳細に1行で表示、期限後/オフでは表示しない', () => {
  const a = app(), state = { hold: true, model: 'claude-fable-5-1', until: new Date(NOW + 3600000).toISOString(), untilSource: 'usage' };
  const html = a.c.usageHtml({ ...snapshot, fableLimit: state }, NOW);
  assert.match(html, /Fable 5.1 上限中.*自動で Astra へ/);
  // 統合後も上限案内と、取得済み/未取得の両方の識別アイコンを同時に残す。
  for (const ai of ['codex', 'claude']) assert.match(html, new RegExp(`usage-icon-${ai}`));
  assert.equal((html.match(/Fable 5.1 上限中/g) || []).length, 1);
  assert.doesNotMatch(a.c.usageHtml({ ...snapshot, fableLimit: state }, NOW + 3600000), /Fable 5.1 上限中/);
  assert.doesNotMatch(a.c.usageHtml(snapshot, NOW), /Fable 5.1 上限中/);
  assert.match(html, /Fableに戻す/);
  assert.match(a.c.usageHtml({ ...snapshot, fableLimit: { ...state, until: null, untilSource: 'unknown' } }, NOW), /解除日時不明・手動で解除するまで Astra/);
});

test('手動解除は確認後だけ送信し、重複を防ぎ、成功は帯を消し失敗は保持を残す', async () => {
  const a = app(), held = { ...snapshot, fableLimit: { hold: true, until: null, untilSource: 'unknown' } };
  a.c.held = held; vm.runInContext('usageData=held; usageLoading=false;', a.c);
  let calls = 0, resolve;
  a.c.confirm = () => false;
  a.c.api = (route, body, headers) => { calls++; assert.equal(route, '/api/limits/fable/clear'); assert.equal(headers['X-Hub'], '1'); return new Promise(r => { resolve = r; }); };
  await a.c.clearFableLimit(); assert.equal(calls, 0);
  a.c.confirm = () => true;
  const pending = a.c.clearFableLimit(); await a.c.clearFableLimit(); assert.equal(calls, 1);
  assert.match(a.el('#usage-body').innerHTML, /id="usage-fable-clear" type="button" disabled/);
  resolve({ ...snapshot, fableLimit: null }); await pending;
  assert.doesNotMatch(a.el('#usage-body').innerHTML, /Fableに戻す/);
  vm.runInContext('usageData=held', a.c);
  a.c.api = () => Promise.reject(Error('fixture denied')); await a.c.clearFableLimit();
  assert.match(a.el('#usage-body').innerHTML, /手動で解除するまで Astra/);
  assert.match(a.el('#usage-status').textContent, /解除を保存できませんでした/);
  vm.runInContext('usageData.refreshAfter=new Date(Date.now()+15000).toISOString()', a.c);
  a.c.drawUsageControls(); assert.equal(a.el('#usage-status')['aria-live'], 'polite');
});
test('解除前の利用状況取得が遅れても解除済みの帯を戻さない', async () => {
  const a = app(); vm.runInContext('usageLoading=false', a.c); a.c.confirm = () => true;
  let resolve;
  a.c.api = route => route === '/api/limits/fable/clear' ? Promise.resolve({ ...snapshot, fableLimit: null }) : new Promise(r => { resolve = r; });
  const pending = a.c.loadUsage(); await a.c.clearFableLimit();
  resolve({ ...snapshot, fableLimit: { hold: true, until: null, untilSource: 'unknown' } }); await pending;
  assert.doesNotMatch(a.el('#usage-body').innerHTML, /Fableに戻す/);
});

test('解除前の利用状況取得が遅れて失敗しても、成功した解除表示を隠さない', async () => {
  const a = app(); vm.runInContext('usageLoading=false', a.c); a.c.confirm = () => true;
  let reject;
  a.c.api = route => route === '/api/limits/fable/clear' ? Promise.resolve({ ...snapshot, fableLimit: null }) : new Promise((_, r) => { reject = r; });
  const pending = a.c.loadUsage(); await a.c.clearFableLimit(); reject(Error('fixture old load denied')); await pending;
  assert.match(a.el('#usage-body').innerHTML, /使用 <span class="usage-value[^"]*">0%/); assert.doesNotMatch(a.el('#usage-toggle').textContent, /利用状況 未取得/);
});
