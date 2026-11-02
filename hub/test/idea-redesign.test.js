'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const U = require('../lib/idea-utils');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-redesign-')));
fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.writeFileSync(path.join(root, '_hub/onboarding.json'), JSON.stringify({ version: 1, status: 'done', step: 'first', ais: ['codex'] }));
process.env.HUB_ROOT = root; process.env.HUB_DRY_RUN = '1'; process.env.HUB_PORT = String(48000 + process.pid % 1000);
const runtime = require('../server'), { server, ideas } = runtime;
let base;
test.before(async () => { await new Promise(r => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => new Promise(r => server.close(r)));
function project(name) {
 const dir = path.join(root, 'Product', name), main = path.join(root, 'System', name), work = path.join(root, 'Work', name, 'main');
 fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true }); fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(path.dirname(work), { recursive: true });
 U.git(main, ['init', '-q']); U.git(main, ['config', 'user.name', 'Fixture']); U.git(main, ['config', 'user.email', 'fixture@localhost']); fs.writeFileSync(path.join(main, 'base'), 'base'); U.git(main, ['add', '.']); U.git(main, ['commit', '-qm', 'base']); U.git(main, ['worktree', 'add', '-qb', 'design', work]);
 fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: ${name}\nstatus: 進行中\nphases: []\nfolders:\n  本体: ${main}\n---\n`);
 fs.writeFileSync(path.join(dir, '.ai/tasks/main.md'), `---\nid: main\ntitle: 本作業\nkind: main\nworkspaceMode: isolated\nworkdir: ${work}\nstate: 進行中\n---\n## 手順\n- [ ] 元の手順\n`);
 return { dir, main, work };
}
async function post(project, route, body) { const response = await fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'X-Hub-UI': 'ideas', Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, ...body }) }); return { status: response.status, body: await response.json() }; }
test('redesign API: category絞込・件数・旧項目・build解除と型検査', async () => {
 project('API'); const a = await post('API', '/api/ideas/add', { opId: U.uuid(), text: '修正', category: 'bug', intent: 'build' }); assert.equal(a.status, 201);
 await post('API', '/api/ideas/add', { opId: U.uuid(), text: '従来形式', intent: 'record' });
 const get = category => fetch(base + '/api/ideas?' + new URLSearchParams({ project: 'API', category }), { headers: { 'X-Hub': '1' } });
 const view = await (await get('bug')).json(); assert.equal(view.items.length, 1); assert.equal(view.counts.all, 2); assert.equal(view.counts.categories.note, 1); assert.equal((await get('invalid')).status, 400);
 const b = { opId: U.uuid(), id: a.body.id, baseContentRev: 1, baseControlRev: 1, change: { build: false } }; assert.equal((await post('API', '/api/ideas/update', b)).status, 200); assert.equal((await post('API', '/api/ideas/update', b)).status, 200); assert.equal(ideas.read('API').items[a.body.id].intent, 'record');
 assert.equal((await post('API', '/api/ideas/add', { opId: U.uuid(), text: 'x', category: 'invalid' })).status, 400);
});
let chromium; try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || [path.join(os.homedir(), '.local/bin/chrome-headless-arm64'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
// Automatic settings are absent from the public core; exercise the same free layout in both bundles.
async function collapseAutomationSettings(page) { const button=page.locator('[data-idea-settings]').first(); if(await button.count())await button.click(); else assert.equal(await page.locator('#idea-settings').isHidden(),true); }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
test('list APIs: human-only reorder/delete, revisions, withdrawal retired and no replay resurrection',async()=>{
 project('ListAPI');const a=await post('ListAPI','/api/ideas/add',{opId:U.uuid(),text:'delete API canary'}),b=await post('ListAPI','/api/ideas/add',{opId:U.uuid(),text:'keep'}),d=ideas.read('ListAPI');
 const move={opId:U.uuid(),id:b.body.id,direction:'up',baseOrderRev:d.orderRev};assert.equal((await post('ListAPI','/api/ideas/reorder',move)).status,200);assert.equal((await post('ListAPI','/api/ideas/reorder',{...move,opId:U.uuid()})).status,409);
 const del={project:'ListAPI',opId:U.uuid(),id:a.body.id,baseContentRev:1,baseControlRev:1,confirm:true};
 for(const route of ['/api/ideas/delete','/api/ideas/reorder']){const response=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(del)});assert.equal(response.status,403);}
 assert.equal((await post('ListAPI','/api/ideas/update',{opId:U.uuid(),id:a.body.id,baseContentRev:1,baseControlRev:1,change:{withdraw:true}})).status,400);
 assert.equal((await post('ListAPI','/api/ideas/delete',{...del,baseContentRev:0})).status,409);const erased=await post('ListAPI','/api/ideas/delete',del);assert.equal(erased.body.deleted,true);assert.equal((await post('ListAPI','/api/ideas/delete',del)).body.deleted,true);
 const retry=await fetch(base+'/api/ideas/receipt?'+new URLSearchParams({project:'ListAPI',opId:a.body.receipt.opId}),{headers:{'X-Hub':'1'}});assert.equal((await retry.json()).removed,true);assert.equal(ideas.view('ListAPI').total,1);
});
test('list recovery Chrome: deleted uncertain composer clears without reload; waiting jumps across pages and filters',{skip:!chromium||!chrome},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try {
  const name='ListRecovery';project(name);const page=await browser.newPage({viewport:{width:390,height:900}});page.setDefaultTimeout(10000);
  await page.goto(base);await page.evaluate(name=>HubIdeas.open(name,'main'),name);
  await page.fill('#idea-text','deleted uncertain draft');
  await page.locator('[data-idea-files]').setInputFiles([{name:'uncertain-draft.png',mimeType:'image/png',buffer:PNG}]);await page.waitForSelector('[data-image-remove]');
  await page.route('**/api/ideas/add',async route=>{await route.fetch();await route.abort();});await page.click('[data-idea-add]');await page.waitForSelector('[data-idea-status].error');
  const victim=ideas.view(name).items[0];ideas.erase(name,{opId:U.uuid(),id:victim.id,baseContentRev:1,baseControlRev:1,confirm:true});
  await page.waitForFunction(()=>document.querySelector('#idea-text').value===''&&!document.querySelector('[data-image-remove]'));
  assert.equal(await page.evaluate(name=>localStorage.getItem('hub-idea-draft:'+name).includes('deleted uncertain draft'),name),false);
  ideas.internal(name,U.uuid(),{fixture:'waiting-pages'},d=>{for(let n=0;n<101;n++)ideas.newItem(d,'page row '+n,'record',null,U.uuid());const last=d.items[d.itemOrder.at(-1)];last.status='waiting';last.questions=[{id:U.uuid(),rev:1,contentRev:1,text:'Choose',choices:['Yes','No']}];});
  const waiting=ideas.view(name).waitingId;assert.equal(waiting,ideas.read(name).itemOrder.at(-1));
  await page.waitForSelector('[data-idea-action=waiting]');await page.click('[data-idea-action=filter][data-category=bug]');await page.waitForSelector('.idea-empty');await page.click('[data-idea-action=waiting]');
  await page.waitForSelector(`[data-item="${waiting}"][open] [data-idea-answer]`);assert.equal(await page.locator('.idea-item').count(),1);
 }finally{await browser.close();}
});
test('compact list Chrome: themes/sizes, label/order/page, cancel, dropped deletion, tabs and selective browser erasure',{skip:!chromium||!chrome},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true}),artifacts=process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname,'../../.ai/work/idea-list');fs.mkdirSync(artifacts,{recursive:true});const report=[];let activePage;
 try{for(const theme of ['dark','light'])for(const width of [1280,390]){
  const name='List-'+theme+'-'+width;project(name);
  const a=ideas.add(name,{opId:U.uuid(),text:'最初の長い項目 '.repeat(30),category:'note'},{human:true}),b=ideas.add(name,{opId:U.uuid(),text:'次の項目',category:'bug'},{human:true});
  const context=await browser.newContext({viewport:{width,height:900}});await context.addInitScript(()=>{window.__ideaURLs=new Set();const make=URL.createObjectURL.bind(URL),drop=URL.revokeObjectURL.bind(URL);URL.createObjectURL=b=>{const u=make(b);window.__ideaURLs.add(u);return u;};URL.revokeObjectURL=u=>{window.__ideaURLs.delete(u);return drop(u);};});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));const open=async p=>{await p.goto(base);await p.evaluate(([name,theme])=>{HubTheme.set(theme);return HubIdeas.open(name,'main');},[name,theme]);await p.waitForSelector('.idea-item');};await open(page);
  assert.deepEqual(await page.locator('.idea-item').evaluateAll(es=>es.map(e=>e.dataset.item)),[a.id,b.id]);
  const line=await page.locator('.idea-item>summary').first().evaluate(e=>{const r=e.getBoundingClientRect();return {first:e.firstElementChild.className,height:r.height,oneLine:[...e.children].every(c=>Math.abs(c.getBoundingClientRect().top-r.top)<r.height),overflow:document.querySelector('.ideas-dialog').scrollWidth>document.querySelector('.ideas-dialog').clientWidth};});assert.equal(line.first,'idea-category');assert.equal(line.height,44);assert.equal(line.oneLine,true);assert.equal(line.overflow,false);
  await page.screenshot({path:path.join(artifacts,theme+'-'+width+'-normal.png')});await page.click('[data-idea-action=list-edit]');
  let drop=true;await page.route('**/api/ideas/update',async route=>{if(drop){drop=false;await route.fetch();await route.abort();}else await route.continue();});
  await page.selectOption(`[data-row-category="${a.id}"]`,'research');await page.waitForSelector('[data-idea-action=row-retry]');await page.reload();await page.evaluate(name=>HubIdeas.open(name,'main'),name);await page.click('[data-idea-action=list-edit]');await page.unroute('**/api/ideas/update');await page.click('[data-idea-action=row-retry]');await page.waitForFunction(()=>!document.querySelector('[data-idea-action=list-edit]').disabled);assert.equal(ideas.read(name).items[a.id].category,'research');
  await page.locator(`[data-idea-drag="${a.id}"]`).press('Enter');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.waitForFunction(id=>document.querySelector('.idea-edit-row').dataset.item===id,b.id);assert.equal(await page.locator('[data-idea-action=down]').count(),0);
  await page.click(`[data-item="${a.id}"] [data-idea-action=delete]`);await page.waitForFunction(()=>document.activeElement.dataset.ideaAction==='delete-cancel');assert.equal(await page.evaluate(()=>document.activeElement.dataset.ideaAction),'delete-cancel');await page.keyboard.press('Escape');assert.equal(await page.locator('.idea-delete-confirm').count(),0);assert.equal(await page.locator('.ideas-dialog').isVisible(),true);
  // Add an image via the actual browser, and keep an unrelated unsaved draft alongside it.
  await page.click('[data-idea-action=list-edit]');await page.locator('[data-idea-files]').setInputFiles([{name:'erase-browser.png',mimeType:'image/png',buffer:PNG}]);await page.waitForSelector('[data-image-remove]');await page.click('[data-idea-add]');await page.waitForFunction(()=>!document.querySelector('[data-image-remove]'));
  const victim=Object.values(ideas.read(name).items).find(i=>i.images?.length),imageId=victim.images[0].id;await page.locator(`[data-item="${victim.id}"] summary`).click();await page.waitForFunction(id=>document.querySelector(`[data-item="${id}"] img`)?.naturalWidth>0,victim.id);
  const popupEvent=page.waitForEvent('popup');await page.click(`[data-item="${victim.id}"] [data-image-view]`);const popup=await popupEvent;popup.on('pageerror',e=>errors.push(e.message));await popup.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);
  await page.fill('#idea-text','無関係な未保存メモ');await page.locator('[data-idea-files]').setInputFiles([{name:'keep-draft.png',mimeType:'image/png',buffer:PNG}]);await page.waitForSelector('[data-image-remove]');const keepImage=await page.locator('[data-image-remove]').getAttribute('data-image-remove');
  const second=await context.newPage();second.setDefaultTimeout(10000);await open(second);await second.locator(`[data-item="${victim.id}"] summary`).click();await second.waitForFunction(id=>document.querySelector(`[data-item="${id}"] img`)?.naturalWidth>0,victim.id);const secondURL=await second.locator(`[data-item="${victim.id}"] img`).getAttribute('src');
  await page.evaluate(async([p,id,item])=>{const db=await new Promise(resolve=>{const r=indexedDB.open('hub-idea-images',1);r.onsuccess=()=>resolve(r.result);});await new Promise(resolve=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').put(new File(['legacy remnant'],'erase-browser.png'),p+':'+id);tx.oncomplete=resolve;});const d=JSON.parse(localStorage.getItem('hub-idea-draft:'+p));d.itemSettings={[item]:{category:'note'}};localStorage.setItem('hub-idea-draft:'+p,JSON.stringify(d));},[name,imageId,victim.id]);
  await page.click('[data-idea-action=list-edit]');await page.click(`[data-item="${victim.id}"] [data-idea-action=delete]`);assert.equal(await page.evaluate(()=>HubTheme.current()),theme);await page.screenshot({path:path.join(artifacts,theme+'-'+width+'-edit-confirm.png')});
  await page.route('**/api/ideas/delete',async route=>{await route.fetch();await route.abort();});await page.click(`[data-item="${victim.id}"] [data-idea-action=delete-confirm]`);await page.waitForSelector('[data-idea-status].error');await page.unroute('**/api/ideas/delete');await page.reload();await page.evaluate(name=>HubIdeas.open(name,'main'),name);await page.waitForFunction(id=>!document.querySelector(`[data-item="${id}"]`),victim.id);await second.waitForFunction(id=>!document.querySelector(`[data-item="${id}"]`),victim.id);await popup.waitForFunction(()=>!document.querySelector('img')&&document.body.textContent.includes('削除されました'));
  assert.equal(await page.inputValue('#idea-text'),'無関係な未保存メモ');assert.equal(await page.locator('[data-image-remove]').getAttribute('data-image-remove'),keepImage);assert.equal(await second.evaluate(url=>window.__ideaURLs.has(url),secondURL),false);
  const storage=await page.evaluate(async p=>{const db=await new Promise(resolve=>{const r=indexedDB.open('hub-idea-images',1);r.onsuccess=()=>resolve(r.result);});const keys=await new Promise(resolve=>{const r=db.transaction('files').objectStore('files').getAllKeys();r.onsuccess=()=>resolve(r.result);});return {draft:localStorage.getItem('hub-idea-draft:'+p),keys};},name);assert.equal(storage.draft.includes(victim.id),false);assert.equal(storage.draft.includes(imageId),false);assert.ok(storage.keys.includes(name+':'+keepImage));assert.ok(!storage.keys.includes(name+':'+imageId));
  // Successful deletion notifies the open second tab, and the final row leaves an empty list.
  await second.evaluate(()=>{window.__eraseNotice=false;window.addEventListener('storage',e=>{if(e.key==='hub-idea-erased')window.__eraseNotice=true;});});await page.click('[data-idea-action=list-edit]');
  for(const target of [b.id,a.id]){await page.click(`[data-item="${target}"] [data-idea-action=delete]`);await page.click(`[data-item="${target}"] [data-idea-action=delete-confirm]`);await page.waitForFunction(id=>!document.querySelector(`[data-item="${id}"]`),target);await second.waitForFunction(id=>!document.querySelector(`[data-item="${id}"]`),target);}
  assert.equal(await second.evaluate(()=>window.__eraseNotice),true);assert.equal(ideas.view(name).total,0);await page.waitForSelector('.idea-empty');assert.equal(await page.inputValue('#idea-text'),'無関係な未保存メモ');
  // Cross the 100-row page boundary using one global adjacent move.
  ideas.internal(name,U.uuid(),{fixture:'pages'},d=>{for(let n=0;n<101;n++)ideas.newItem(d,'page row '+n,'record',null,U.uuid());});await page.evaluate(name=>HubIdeas.open(name,'main'),name);await page.waitForSelector('.idea-item');await page.click('[data-idea-action=list-edit]');const edge=ideas.read(name).itemOrder[99];await page.locator(`[data-idea-drag="${edge}"]`).press('Enter');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.waitForFunction(id=>document.querySelector('.idea-edit-row')?.dataset.item===id,edge);await page.waitForFunction(id=>document.activeElement.dataset.ideaDrag===id,edge);await page.locator(`[data-idea-drag="${edge}"]`).press('Enter');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');await page.waitForFunction(id=>document.querySelectorAll('.idea-edit-row')[99]?.dataset.item===id,edge);
  assert.equal(await page.locator('.ideas-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);assert.ok(await page.locator('.idea-edit-line button,.idea-edit-line select').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height>=44)));assert.deepEqual(errors,[]);report.push({theme,width,line,selectiveStorage:true,pageBoundary:true,errors});await context.close();
 }fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));}catch(e){if(activePage){const stamp=Date.now();await activePage.screenshot({path:path.join(artifacts,'failure-'+stamp+'.png')});fs.writeFileSync(path.join(artifacts,'failure-'+stamp+'.json'),JSON.stringify(await activePage.evaluate(()=>({html:document.querySelector('.ideas-dialog')?.outerHTML,draft:Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('hub-idea')))})),null,2));}throw e;}finally{await browser.close();}
});
test('detail Chrome: category autosave, receipt recovery, delete cancel/busy/double-submit in four layouts', { skip: !chromium || !chrome }, async () => {
 const browser = await chromium.launch({ executablePath: chrome, headless: true }), artifacts = process.env.HUB_IDEA_TEST_ARTIFACTS || path.resolve(__dirname, '../../.ai/work/idea-redesign');
 fs.mkdirSync(artifacts, { recursive: true });
 try { for (const theme of ['dark', 'light']) for (const width of [1280, 390]) {
  const name = 'Detail-' + theme + '-' + width; project(name);
  const item = ideas.add(name, { opId: U.uuid(), text: '詳細のまま分類変更と削除', category: 'note' }, { human: true });
  const kept = ideas.add(name, { opId: U.uuid(), text: '残す項目' }, { human: true }), beforeKept = ideas.read(name).items[kept.id];
  const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), posts = [], errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/ideas\/(update|delete)$/.test(new URL(r.url()).pathname)) posts.push({ route: new URL(r.url()).pathname, ...r.postDataJSON() }); });
  const open = async () => { await page.evaluate(([name, theme]) => { HubTheme.set(theme); return HubIdeas.open(name, 'main'); }, [name, theme]); };
  await page.goto(base); await open();
  const row = page.locator(`.idea-item[data-item="${item.id}"]`), category = row.locator('[data-row-category]');
  await row.locator('summary').first().click();
  assert.deepEqual(await category.locator('option').allTextContents(), ['メモ', 'バグ', '改善', 'アイデア', '相談']);
  for (const value of ['bug', 'improve', 'feature', 'research', 'note']) {
   await category.selectOption(value);
   await page.waitForFunction(([id, value]) => { const row = document.querySelector(`.idea-item[data-item="${id}"]`); return row?.open && row.querySelector('.idea-category').dataset.category === value && !row.querySelector('[data-row-category]').disabled; }, [item.id, value]);
   assert.equal(ideas.read(name).items[item.id].category, value);
  }
  await page.screenshot({ path: path.join(artifacts, `${theme}-${width}-detail.png`) });
  assert.equal(await page.locator('.ideas-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.ok(await category.evaluate(el => el.getBoundingClientRect().height >= 44));
  // A lost successful update is reconciled by receipt without posting it again.
  await page.route('**/api/ideas/update', async route => { await route.fetch(); await route.abort(); });
  await category.selectOption('bug'); await row.locator('[data-idea-action=row-retry]').waitFor();
  assert.equal(await category.isDisabled(), true); const updates = posts.length;
  await page.reload(); await open(); await row.locator('summary').first().click();
  await page.unroute('**/api/ideas/update'); await row.locator('[data-idea-action=row-retry]').click();
  await page.waitForFunction(id => !document.querySelector(`[data-row-category="${id}"]`).disabled, item.id);
  assert.equal(posts.length, updates); assert.equal(ideas.read(name).items[item.id].category, 'bug');
  // Cancel and Escape leave the detail open and never send a deletion.
  await row.locator('[data-idea-action=delete]').click();
  await page.waitForFunction(() => document.activeElement.dataset.ideaAction === 'delete-cancel');
  await row.locator('[data-idea-action=delete-cancel]').click();
  assert.equal(await row.getAttribute('open'), ''); assert.equal(await row.locator('.idea-delete-confirm').count(), 0);
  await row.locator('[data-idea-action=delete]').click(); await page.keyboard.press('Escape');
  assert.equal(await row.locator('.idea-delete-confirm').count(), 0);
  // The same server preflight blocks deletion while a verification is unfinished.
  ideas.internal(name, U.uuid(), { fixture: 'detail busy' }, d => { d.evidence.detailCheck = { id: 'detailCheck', type: 'verification', finished: false }; });
  await row.locator('[data-idea-action=delete]').click();
  await page.waitForFunction(() => document.querySelector('[data-idea-action=delete-confirm]')?.textContent === '削除できません');
  assert.equal(await row.locator('[data-idea-action=delete-confirm]').isDisabled(), true);
  assert.match(await row.locator('.idea-delete-confirm').innerText(), /検証/);
  await row.locator('[data-idea-action=delete-cancel]').click();
  ideas.internal(name, U.uuid(), { fixture: 'detail ready' }, d => { delete d.evidence.detailCheck; });
  assert.equal(posts.filter(p => p.route === '/api/ideas/delete').length, 0);
  // Unknown delivery retains the original operation and cannot post during unknown receipt.
  await row.locator('[data-idea-action=delete]').click(); await page.waitForFunction(() => !document.querySelector('[data-idea-action=delete-confirm]').disabled);
  await page.route('**/api/ideas/delete', route => route.abort());
  await row.locator('[data-idea-action=delete-confirm]').evaluate(el => { el.click(); el.click(); });
  await row.locator('[data-idea-action=delete-confirm]').filter({ hasText: '削除の結果を確認' }).waitFor();
  assert.equal(posts.filter(p => p.route === '/api/ideas/delete').length, 1);
  await page.route('**/api/ideas/receipt?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: 'unknown' }) }));
  await row.locator('[data-idea-action=delete-confirm]').click(); await page.waitForSelector('[data-idea-status].error');
  assert.equal(posts.filter(p => p.route === '/api/ideas/delete').length, 1);
  await page.unroute('**/api/ideas/receipt?*'); await page.unroute('**/api/ideas/delete');
  await row.locator('[data-idea-action=delete-confirm]').click(); await row.waitFor({ state: 'detached' });
  const deletions = posts.filter(p => p.route === '/api/ideas/delete');
  assert.equal(deletions.length, 2); assert.equal(deletions[0].opId, deletions[1].opId);
  assert.equal(ideas.read(name).items[item.id], undefined); assert.deepEqual(ideas.read(name).items[kept.id], beforeKept);
  assert.deepEqual(errors, []); await context.close();
 } } finally { await browser.close(); }
});
test('unmatched markdown Chrome: detail/list review, no-op cancel, selective erasure, stale confirmation, busy and uncertain receipt', {skip:!chromium||!chrome}, async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true}),artifacts=process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname,'../../.ai/work/idea-redesign');fs.mkdirSync(artifacts,{recursive:true});
 try{for(const theme of ['dark','light'])for(const width of [1280,390]){
  const name='Markdown-'+theme+'-'+width;project(name);const victim=ideas.add(name,{opId:U.uuid(),text:'UI-PRIVATE-CANARY'},{human:true}),kept=ideas.add(name,{opId:U.uuid(),text:'別の項目を保持'},{human:true}),s=ideas.resolve(name);
  const original=Buffer.from('# 古い手書き帳\r\nUI-PRIVATE-CANARY\r\n別の項目を保持\r\n<script>window.bad=1</script>');fs.writeFileSync(s.md,original);
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),posts=[],errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/ideas/delete')posts.push(r.postDataJSON());});
  const row=page.locator(`[data-item="${victim.id}"]`).filter({has:page.locator('[data-idea-action=delete]')}),open=async()=>{await page.evaluate(([name,theme])=>{HubTheme.set(theme);return HubIdeas.open(name,'main');},[name,theme]);if(width===1280)await page.click('[data-idea-action=list-edit]');else await row.locator('summary').first().click();};
  await page.goto(base);await open();
  const review=async()=>{await row.locator('[data-idea-action=delete]').click();await row.locator('[data-idea-action=delete-review]').click();await row.locator('[data-markdown-confirm]').waitFor();};
  await review();assert.equal(await row.locator('[data-idea-action=delete-confirm]').isDisabled(),true);assert.equal(await page.evaluate(()=>window.bad),undefined);assert.equal(await row.locator('[data-markdown-line="3"]').isDisabled(),true);
  await row.locator('[data-idea-action=delete-cancel]').click();assert.deepEqual(fs.readFileSync(s.md),original);assert.equal(posts.length,0);
  await review();await page.keyboard.press('Escape');assert.equal(await row.locator('[data-markdown-confirm]').count(),0);assert.equal(posts.length,0);
  await review();await row.locator('[data-markdown-confirm]').check();assert.equal(await row.locator('[data-idea-action=delete-confirm]').isDisabled(),true);await row.locator('[data-markdown-line="2"]').check();assert.equal(await row.locator('[data-markdown-confirm]').isChecked(),false);await row.locator('[data-markdown-confirm]').check();
  await page.screenshot({path:path.join(artifacts,`${theme}-${width}-markdown-review.png`)});assert.equal(await page.locator('.ideas-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  // The server fences a stale confirmation even before the polling view catches up.
  fs.appendFileSync(s.md,'\r\n同時に追加された原文');await row.locator('[data-idea-action=delete-confirm]').click();await row.locator('[data-idea-action=delete-review]').waitFor();assert.equal(posts.length,1);assert.ok(ideas.read(name).items[victim.id]);assert.equal(await row.locator('[data-markdown-confirm]').count(),0);
  await row.locator('[data-idea-action=delete-review]').click();await row.locator('[data-markdown-line="2"]').check();await row.locator('[data-markdown-confirm]').check();
  // Busy evidence is still enforced after a human has confirmed the raw source.
  ideas.internal(name,U.uuid(),{fixture:'markdown busy'},d=>{d.evidence.markdownBusy={type:'verification',finished:false};});await row.locator('[data-idea-action=delete-confirm]').click();await page.waitForFunction(()=>document.querySelector('.idea-delete-confirm')?.textContent.includes('検証'));assert.ok(ideas.read(name).items[victim.id]);
  ideas.internal(name,U.uuid(),{fixture:'markdown ready'},d=>{delete d.evidence.markdownBusy;});await row.locator('[data-idea-action=delete-review]').waitFor();await row.locator('[data-idea-action=delete-review]').click();await row.locator('[data-markdown-line="2"]').check();await row.locator('[data-markdown-confirm]').check();
  // Failed delivery retains exactly the same reviewed operation across reload.
  await page.route('**/api/ideas/delete',route=>route.abort());await row.locator('[data-idea-action=delete-confirm]').evaluate(el=>{el.click();el.click();});await row.locator('[data-idea-action=delete-confirm]').filter({hasText:'削除の結果を確認'}).waitFor();const attempts=posts.length;
  await page.route('**/api/ideas/receipt?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({saved:'unknown'})}));await row.locator('[data-idea-action=delete-confirm]').click();await page.waitForSelector('[data-idea-status].error');assert.equal(posts.length,attempts);
  await page.reload();await open();await page.unroute('**/api/ideas/receipt?*');await page.unroute('**/api/ideas/delete');await row.locator('[data-idea-action=delete-confirm]').click();await row.waitFor({state:'detached'});
  assert.equal(posts.length,attempts+1);assert.deepEqual(posts.at(-1),posts.at(-2));assert.equal(ideas.read(name).items[victim.id],undefined);assert.ok(ideas.read(name).items[kept.id]);assert.deepEqual(fs.readFileSync(s.md),Buffer.from('# 古い手書き帳\r\n別の項目を保持\r\n<script>window.bad=1</script>\r\n同時に追加された原文'));assert.deepEqual(errors,[]);
  // The screenshot's actual case needs only preserve-original confirmation, with no selected lines.
  const unrelated=ideas.add(name,{opId:U.uuid(),text:'原文に登場しない後発のメモ'},{human:true});await page.evaluate(name=>HubIdeas.open(name,'main'),name);const next=page.locator(`.idea-item[data-item="${unrelated.id}"]`);await next.locator('summary').click();await next.locator('[data-idea-action=delete]').click();await next.locator('[data-idea-action=delete-review]').click();await next.locator('[data-markdown-confirm]').check();const rawBefore=fs.readFileSync(s.md),countBefore=posts.length;await page.route('**/api/ideas/delete',async route=>{await route.fetch();await route.abort();});await next.locator('[data-idea-action=delete-confirm]').click();await page.waitForSelector('[data-idea-status].error');await page.reload();await page.evaluate(name=>HubIdeas.open(name,'main'),name);await page.waitForFunction(id=>!document.querySelector(`[data-item="${id}"]`),unrelated.id);assert.equal(posts.length,countBefore+1);assert.deepEqual(fs.readFileSync(s.md),rawBefore);assert.ok(ideas.read(name).items[kept.id]);await context.close();
 }}finally{await browser.close();}
});
test('divergent import review Chrome: every original requires its own selected lines in detail and list', {skip:!chromium||!chrome}, async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true});
 try{for(const width of [1280,390]){
  const name='ImportReview-'+width,{dir}=project(name);fs.writeFileSync(path.join(dir,'アイデア帳.md'),'# 未着手\r\nKEEP-UNKNOWN-ORIGINAL\r\n- IMPORT-UI-VICTIM\r\nKEEP-IMPORT-TAIL');ideas.initialize(name,U.uuid(),{importLegacy:true});
  const victim=Object.values(ideas.read(name).items).find(i=>i.text==='IMPORT-UI-VICTIM'),s=ideas.resolve(name),importFile=path.join(s.controlDir,'imports',victim.source.hash+'.md');fs.writeFileSync(s.md,'# 現行の原文\r\n- IMPORT-UI-VICTIM\r\nKEEP-IMPORT-TAIL\r\nLIVE-ONLY');
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),posts=[],errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/ideas/delete')posts.push(r.postDataJSON());});
  await page.goto(base);await page.evaluate(name=>HubIdeas.open(name,'main'),name);const row=page.locator(`[data-item="${victim.id}"]`).filter({has:page.locator('[data-idea-action=delete]')});if(width===390)await page.click('[data-idea-action=list-edit]');else await row.locator('summary').click();
  await row.locator('[data-idea-action=delete]').click();await row.locator('[data-idea-action=delete-review]').click();const review=ideas.eraseAvailability(name,victim.id).markdownReview;assert.equal(review.documents.length,2);assert.equal(await row.locator('.idea-markdown-review fieldset').count(),2);
  const ack=row.locator('[data-markdown-confirm]'),button=row.locator('[data-idea-action=delete-confirm]');
  for(let n=0;n<review.documents.length;n++){const doc=review.documents[n];for(const line of doc.targetLines)await row.locator(`[data-markdown-hash="${doc.hash}"][data-markdown-line="${line}"]`).check();await ack.check();assert.equal(await button.isDisabled(),n!==review.documents.length-1);}
  assert.equal(await page.locator('.ideas-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await button.click();await row.waitFor({state:'detached'});
  assert.equal(posts.length,1);assert.equal(posts[0].markdownReview.documents.length,2);assert.equal(fs.readFileSync(s.md,'utf8'),'# 現行の原文\r\nKEEP-IMPORT-TAIL\r\nLIVE-ONLY');assert.equal(fs.readFileSync(importFile,'utf8'),'# 未着手\r\nKEEP-UNKNOWN-ORIGINAL\r\n\r\nKEEP-IMPORT-TAIL');assert.deepEqual(ideas.read(name).imports[victim.source.hash].unknown,[{line:2,text:'KEEP-UNKNOWN-ORIGINAL'},{line:4,text:'KEEP-IMPORT-TAIL'}]);assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
});
test('free redesign Chrome: 4条件・7状態・保存/許可/失敗/下書き/Tab/絞込/画像', { skip: !chromium || !fs.existsSync(chrome) }, async () => {
 const browser = await chromium.launch({ executablePath: chrome, headless: true }), artifacts = process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname, '../../.ai/work/idea-redesign'); fs.mkdirSync(artifacts, { recursive: true }); const report = [];
 try { for (const theme of ['dark', 'light']) for (const width of [1280, 390]) {
  const name = 'Design-' + theme + '-' + width; project(name);
  const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), errors = [], posts = []; page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
  const open = async () => { await page.evaluate(([p,t]) => { document.documentElement.dataset.theme = t; return window.HubIdeas.open(p, 'main'); }, [name, theme]); await page.waitForFunction(() => document.querySelector('[data-idea-status]').textContent !== '読み込み中'); };
  const shot = async state => { await page.locator('#idea-text').scrollIntoViewIfNeeded(); assert.ok(await page.locator('.ideas-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), state + ' overflow'); await page.screenshot({ path: path.join(artifacts, `${theme}-${width}-${state}.png`) }); };
  await page.goto(base); await open(); assert.equal(await page.locator('#idea-settings').isVisible(), Boolean(runtime.ideaLane)); if(!runtime.ideaLane){assert.equal(await page.evaluate(()=>typeof window.HubIdeaAutomation),'undefined');assert.equal(await page.locator('[data-idea-action=auto],[data-idea-lane],[data-idea-runtime],[data-idea-action=prepare]').count(),0);} assert.equal(await page.locator('[data-idea-add]').innerText(), '保存'); await shot('empty-unconfigured');
  // Follow DOM/visual order: microphone sits beside Save, before header settings.
  await page.locator('#idea-text').focus(); const tab = [];
  const voiceEnabled = await page.locator('.ideas-dialog .voice-button').isEnabled(), steps = 7 + Number(voiceEnabled);
  for (let n = 0; n < steps; n++) { tab.push(await page.evaluate(() => { const e = document.activeElement; return e.id || e.getAttribute('aria-label') || e.getAttribute('data-idea-action') || e.textContent.trim(); })); await page.keyboard.press('Tab'); }
  const composerOrder = ['idea-text', '📎 画像', '種類', '扱い', '保存', ...(voiceEnabled ? ['日本語で音声入力を始める'] : [])];
  assert.deepEqual(tab.slice(0, composerOrder.length), composerOrder); if(runtime.ideaLane){assert.equal(tab[composerOrder.length], '台帳の設定');assert.equal(await page.locator('[data-idea-settings]').count(),1);assert.match(await page.locator('#idea-settings').innerText(),/1[\s\S]*実行先[\s\S]*2[\s\S]*自動で作る[\s\S]*3[\s\S]*本体へ反映/);} for (let n=0;n<steps;n++) await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(()=>document.activeElement.id), 'idea-text');
  await page.fill('#idea-text', '操作を分かりやすくする'); await page.selectOption('[data-idea-category]', 'improve'); await page.selectOption('[data-idea-intent]', 'build'); if(runtime.ideaLane)assert.match(await page.locator('[data-idea-intent-hint]').innerText(), /実行先/);
  await page.reload(); await open(); assert.equal(await page.inputValue('[data-idea-category]'), 'improve'); assert.equal(await page.inputValue('[data-idea-intent]'), 'build');
  await page.route('**/api/ideas/add', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ saved: false, message: '表示確認：保存先に書き込めません' }) }));
  await page.click('[data-idea-add]'); await page.waitForSelector('[data-idea-status].error'); await shot('save-failure'); assert.equal(await page.inputValue('#idea-text'), '操作を分かりやすくする'); assert.equal(await page.inputValue('[data-idea-category]'), 'improve'); assert.equal(await page.inputValue('[data-idea-intent]'), 'build');
  await page.unroute('**/api/ideas/add'); await page.click('[data-idea-add]'); await page.waitForFunction(() => !document.querySelector('#idea-text').value); assert.equal(await page.inputValue('[data-idea-category]'), 'note'); assert.equal(await page.inputValue('[data-idea-intent]'), 'record');
  const item = Object.values(ideas.read(name).items)[0]; assert.equal(item.category, 'improve'); assert.equal(item.intent, 'build'); assert.equal(ideas.read(name).settings.auto.enabled, false);
  if(runtime.ideaLane){
  await page.selectOption('[data-idea-lane]', 'main'); await page.selectOption('[data-idea-profile]', 'project-hub'); await page.click('[data-idea-action=lane]'); await page.waitForFunction(() => document.querySelector('#idea-settings').hidden); await shot('records-configured');
  await page.click('[aria-label="台帳の設定"]'); assert.equal(await page.locator('[data-idea-lane]').count(), 0); assert.match(await page.locator('.idea-lane-summary').innerText(), /本作業/); await shot('settings-summary');
  await page.click('[data-idea-action=change-lane]'); assert.equal(await page.inputValue('[data-idea-lane]'), 'main'); await page.click('[data-idea-action=lane]'); await page.waitForFunction(() => document.querySelector('#idea-settings').hidden);
  }
  const row = page.locator(`.idea-item[data-item="${item.id}"]`); await row.locator('summary').first().click(); const form = row.locator('[data-idea-item-settings]');
  await page.click('[data-idea-action=list-edit]'); await page.selectOption('[data-row-category]', 'bug'); await page.waitForFunction(id => document.querySelector(`[data-row-category="${id}"]`)?.value === 'bug' && !document.querySelector('[data-idea-action=list-edit]').disabled, item.id); await page.click('[data-idea-action=list-edit]'); await row.locator('summary').first().click();
  await form.locator('[name=intent]').selectOption('record');
  let lostControlResponse = true; await page.route('**/api/ideas/update', async route => { if (lostControlResponse) { lostControlResponse = false; await route.fetch(); await route.abort(); } else await route.continue(); }); await form.locator('button').click(); await page.waitForSelector('[data-idea-status].error'); await page.reload(); await open(); await row.locator('summary').first().click(); assert.equal(await form.locator('[name=intent]').isDisabled(), true); await page.unroute('**/api/ideas/update'); await form.locator('button').click(); await page.waitForFunction(() => !document.querySelector('[data-idea-item-settings] button').disabled); assert.equal(ideas.read(name).items[item.id].intent, 'record'); assert.equal(ideas.read(name).items[item.id].controlRev, 3);
  await page.click('[data-idea-action=filter][data-category=bug]'); await page.waitForFunction(() => document.querySelectorAll('.idea-item').length === 1); await page.click('[data-idea-action=filter][data-category=feature]'); await page.waitForSelector('.idea-empty'); await page.click('[data-idea-action=filter][data-category=""]');
  await page.locator('[data-idea-files]').setInputFiles([{ name: 'スクショ.png', mimeType: 'image/png', buffer: PNG }]); await page.waitForSelector('[data-image-remove]'); await page.waitForFunction(() => document.querySelector('[data-idea-images] img').naturalWidth > 0); const preview = await page.locator('[data-idea-images] img').boundingBox(); assert.equal(preview.width, 64); await shot('image-draft');
  await page.locator('#idea-text').press('Control+Enter'); await page.waitForFunction(() => !document.querySelector('[data-image-remove]')); const imageItem = Object.values(ideas.read(name).items).find(i => i.images?.length); assert.equal(imageItem.intent, 'record');
  await page.reload(); await open(); await page.locator(`[data-item="${imageItem.id}"] summary`).click(); await page.waitForFunction(id => document.querySelector(`[data-item="${id}"] img`).naturalWidth > 0, imageItem.id); await shot('image-saved');
  const qid = U.uuid(); ideas.internal(name, U.uuid(), { fixture: 'waiting' }, d => { d.items[item.id].status = 'waiting'; d.items[item.id].questions = [{ id: qid, rev: 1, contentRev: 1, text: 'どの表示にしますか？', choices: ['一覧', '詳細'] }]; });
  await page.waitForSelector('[data-idea-action=waiting]'); await page.click('[data-idea-action=waiting]'); await page.waitForSelector(`[data-idea-answer="${qid}"]`); assert.match(await page.locator('.idea-waiting').innerText(), /1/); await shot('waiting');
  const measured = await page.evaluate(() => {
   const ratio = (a,b) => { const lum = c => { const v = c.match(/[\d.]+/g).slice(0,3).map(Number).map(x => { x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4; });return .2126*v[0]+.7152*v[1]+.0722*v[2]; }; const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
   const panel = getComputedStyle(document.querySelector('.idea-composer')).backgroundColor, input = document.querySelector('#idea-text'), muted = getComputedStyle(input,'::placeholder').color;
   return { placeholderContrast: ratio(muted,panel), touch: [...document.querySelectorAll('.ideas-dialog button,.ideas-dialog select')].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=44), mobileHeight: document.querySelector('.ideas-dialog').getBoundingClientRect().height, noOverflow: document.querySelector('.ideas-dialog').scrollWidth<=document.querySelector('.ideas-dialog').clientWidth };
  }); assert.ok(measured.placeholderContrast >= 4.5); assert.ok(measured.touch); if (width === 390) assert.equal(measured.mobileHeight, 900); assert.deepEqual(errors, []); assert.equal(posts.some(p=>['/api/task/upload','/api/chat/send','/api/term/start'].includes(p)), false);
  report.push({ theme, width, states: 7, tab, measured, errors, posts }); await context.close();
 } fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); } finally { await browser.close(); }
});

test('drag API: arbitrary position, one revision, conflict, receipt and legacy category compatibility',async()=>{
 const name='DragAPI';project(name);
 const add = async (text,extra={}) => (await post(name,'/api/ideas/add',{opId:U.uuid(),text,...extra})).body;
 const a=await add('default note'),legacyBody={opId:U.uuid(),text:'old other',category:'uncategorized'}, b=(await post(name,'/api/ideas/add',legacyBody)).body,c=await add('explicit bug',{category:'bug'});
 assert.equal(ideas.read(name).items[a.id].category,'note');assert.equal(ideas.read(name).items[b.id].category,'note');
 assert.equal((await post(name,'/api/ideas/add',legacyBody)).body.id,b.id);
 ideas.internal(name,U.uuid(),{fixture:'legacy'},d=>{delete d.items[a.id].category;d.items[b.id].category='uncategorized';});
 const old=ideas.read(name),move={opId:U.uuid(),id:c.id,toIndex:0,baseOrderRev:old.orderRev};
 assert.equal((await post(name,'/api/ideas/reorder',move)).status,200);
 assert.deepEqual(ideas.read(name).itemOrder,[c.id,a.id,b.id]);assert.equal(ideas.read(name).orderRev,old.orderRev+1);
 assert.deepEqual(ideas.read(name).items,old.items);
 assert.equal((await post(name,'/api/ideas/reorder',move)).status,200);assert.equal(ideas.read(name).orderRev,old.orderRev+1);
 const receipt=await fetch(base+'/api/ideas/receipt?'+new URLSearchParams({project:name,opId:move.opId}),{headers:{'X-Hub':'1'}});assert.equal((await receipt.json()).index,0);
 assert.equal((await post(name,'/api/ideas/reorder',{...move,opId:U.uuid()})).status,409);
 for(const extra of [{toIndex:-1},{toIndex:3},{toIndex:1.5},{toIndex:'1'},{toIndex:0,direction:'up'}])assert.ok((await post(name,'/api/ideas/reorder',{...move,opId:U.uuid(),baseOrderRev:old.orderRev+1,...extra})).status>=400);
 for(const label of ['note','uncategorized']){const view=ideas.view(name,0,100,label);assert.equal(view.total,2);assert.ok(view.items.every(i=>i.category==='note'));assert.equal(view.counts.categories.note,2);assert.ok(!Object.hasOwn(view.counts.categories,'uncategorized'));}
 const reopened=new (require('../lib/ideas').Ideas)({store:ideas.store});try{assert.deepEqual(reopened.read(name).itemOrder,[c.id,a.id,b.id]);assert.equal(reopened.view(name).items[0].category,'bug');}finally{reopened.close();}
});

test('drag Chrome: mouse/touch, keyboard, cancel, conflict, uncertain receipt, image drop and 100-row boundary',{skip:!chromium||!chrome},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true}),artifacts=process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname,'../../.ai/work/idea-list/drag-default');fs.mkdirSync(artifacts,{recursive:true});const report=[];let activePage;
 try{for(const [theme,width,touch] of [['dark',1280,false],['light',390,true]]){
  const name='Drag-'+theme;project(name);
  ideas.initialize(name,U.uuid());ideas.internal(name,U.uuid(),{fixture:'drag rows'},d=>{for(let n=0;n<5;n++)ideas.newItem(d,'drag row '+n,'record',null,U.uuid());d.items[d.itemOrder[0]].category='uncategorized';d.items[d.itemOrder[1]].category='bug';});
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors=[],moves=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/ideas/reorder'))moves.push(r.postDataJSON());});
  activePage=page;const open=async()=>{await page.evaluate(([name,theme])=>{document.documentElement.dataset.theme=theme;return HubIdeas.open(name,'main');},[name,theme]);await page.waitForSelector('.idea-item');await collapseAutomationSettings(page);};
  const edit=async()=>{await page.click('[data-idea-action=list-edit]');await page.waitForSelector('[data-idea-drag]');};
  const settled=async()=>{await page.waitForFunction(()=>!document.querySelector('[data-idea-action=list-edit]').disabled||document.querySelector('[data-idea-action=row-retry]:not([disabled])'));};
  const keyMove=async(id,key)=>{await page.locator(`[data-idea-drag="${id}"]`).press('Enter');await page.keyboard.press(key);await page.waitForFunction(()=>document.querySelector('[data-idea-drag][aria-pressed=true]')||document.activeElement.tagName==='DIALOG');const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/ideas/reorder'));await page.keyboard.press('Enter');await sent;await settled();};
  const pointer=async(id,target,{cancel=false,viaOutside=false}={})=>{
   const handle=page.locator(`[data-idea-drag="${id}"]`);await handle.scrollIntoViewIfNeeded();const h=await handle.boundingBox(),row=await page.locator(`.idea-edit-row[data-item="${target}"]`).boundingBox();const x=h.x+h.width/2,y=h.y+h.height/2,endY=row.y+row.height-3;
   if(touch){const session=await context.newCDPSession(page);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:endY}]});if(cancel)await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});else await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();}
   else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,endY,{steps:6});if(cancel)await page.keyboard.press('Escape');if(viaOutside)await page.mouse.move(1,1);await page.mouse.up();}
  };
  await page.goto(base);await open();assert.equal(await page.inputValue('[data-idea-category]'),'note');assert.equal(await page.getByText('ほか',{exact:true}).count(),0);assert.equal(await page.locator('option[value=uncategorized]').count(),0);
  await page.fill('#idea-text','saved default');await page.click('[data-idea-add]');await page.waitForFunction(()=>!document.querySelector('#idea-text').value);assert.equal(await page.inputValue('[data-idea-category]'),'note');const added=ideas.read(name).itemOrder.at(-1);assert.equal(ideas.read(name).items[added].category,'note');
  await edit();assert.equal(await page.locator('[data-idea-action=up],[data-idea-action=down]').count(),0);let ids=ideas.read(name).itemOrder;const first=ids[0],third=ids[2],rev=ideas.read(name).orderRev;
  await pointer(first,third);await settled();await page.waitForFunction(id=>document.querySelectorAll('.idea-edit-row')[2]?.dataset.item===id,first);assert.equal(moves.length,1);assert.equal(moves[0].toIndex,2);assert.equal(ideas.read(name).orderRev,rev+1);assert.equal(await page.locator('.idea-composer').evaluate(e=>e.classList.contains('dropping')),false);
  const before=ideas.read(name).itemOrder, count=moves.length;await pointer(before[0],before[2],{cancel:true});assert.deepEqual(ideas.read(name).itemOrder,before);assert.equal(moves.length,count);if(!touch){await pointer(before[0],before[2],{viaOutside:true});assert.equal(moves.length,count);}
  await keyMove(first,'Home');assert.equal(ideas.read(name).itemOrder[0],first);await page.reload();await open();assert.equal(await page.locator('.idea-item').first().getAttribute('data-item'),first);await edit();
  // An independently saved order makes a stale drop fail without overwriting it.
  const conflictRev=ideas.read(name).orderRev;ids=ideas.read(name).itemOrder;ideas.reorder(name,{opId:U.uuid(),id:ids.at(-1),toIndex:0,baseOrderRev:conflictRev});const concurrent=ideas.read(name).itemOrder;
  await pointer(first,ids[2]);await page.waitForSelector('[data-idea-status].error');assert.deepEqual(ideas.read(name).itemOrder,concurrent);await settled();
  // Lost response is resolved using the same operation, including across reload.
  let lose=true;await page.route('**/api/ideas/reorder',async route=>{if(lose){lose=false;await route.fetch();await route.abort();}else await route.continue();});ids=ideas.read(name).itemOrder;const moving=ids[0];await keyMove(moving,'End');await page.waitForSelector('[data-idea-action=row-retry]');const sent=moves.at(-1).opId;await page.reload();await open();await edit();await page.unroute('**/api/ideas/reorder');await page.click('[data-idea-action=row-retry]');await settled();assert.equal(moves.filter(m=>m.opId===sent).length,1);assert.equal(ideas.read(name).itemOrder.at(-1),moving);
  // File drops still attach images; row moves never create an attachment.
  const transfer=await page.evaluateHandle(bytes=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'drop.png',{type:'image/png'}));return dt;},[...PNG]);await page.dispatchEvent('.ideas-dialog','dragover',{dataTransfer:transfer});assert.equal(await page.locator('.idea-composer.dropping').count(),1);await page.dispatchEvent('.ideas-dialog','drop',{dataTransfer:transfer});await page.waitForSelector('[data-image-remove]');assert.equal(await page.locator('[data-image-remove]').count(),1);await page.locator('[data-idea-files]').setInputFiles([{name:'valid.png',mimeType:'image/png',buffer:PNG}]);await page.waitForFunction(()=>document.querySelectorAll('[data-image-remove]').length===2);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-idea-images] img')].every(i=>i.naturalWidth>0));await page.screenshot({path:path.join(artifacts,`${theme}-${width}-editing.png`)});
  // Populate pages locally without AI, then drag over the page control and drop there.
  ideas.internal(name,U.uuid(),{fixture:'page boundary'},d=>{for(let n=0;n<96;n++)ideas.newItem(d,'page row '+n,'record',null,U.uuid());});await page.evaluate(name=>HubIdeas.open(name,'main'),name);await collapseAutomationSettings(page);await edit();
  ids=ideas.read(name).itemOrder;const edge=ids[99];await keyMove(edge,'ArrowDown');assert.equal(ideas.read(name).itemOrder[100],edge);assert.equal(await page.locator('.idea-edit-row').first().getAttribute('data-item'),edge);await keyMove(edge,'ArrowUp');assert.equal(ideas.read(name).itemOrder[99],edge);
  // Reaching the bottom while held scrolls. Hovering Next loads the adjacent page.
  const grip=page.locator(`[data-idea-drag="${edge}"]`);await grip.scrollIntoViewIfNeeded();const h=await grip.boundingBox();await page.mouse.move(h.x+20,h.y+20);await page.mouse.down();await page.mouse.move(h.x+20,h.y+10);const next=await page.locator('[data-idea-action=next]').boundingBox();await page.mouse.move(next.x+20,next.y+20);await page.waitForFunction(()=>document.querySelectorAll('.idea-edit-row').length===2);const target=await page.locator('.idea-edit-row').last().boundingBox();await page.mouse.move(target.x+100,target.y+target.height-4);await page.mouse.up();await settled();assert.equal(ideas.read(name).itemOrder.at(-1),edge);
  // Keyboard cancellation after crossing pages, then closing, never persists a move.
  const n=moves.length;await page.locator(`[data-idea-drag="${edge}"]`).press('Enter');await page.keyboard.press('Home');await page.keyboard.press('Escape');assert.equal(moves.length,n);await page.locator('[data-idea-close]').click();assert.equal(moves.length,n);
  await page.evaluate(name=>HubIdeas.open(name,'main'),name);await collapseAutomationSettings(page);await edit();assert.ok(await page.locator('.ideas-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));assert.ok(await page.locator('.idea-edit-line button,.idea-edit-line select').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height>=44)));assert.deepEqual(errors,[]);
  report.push({theme,width,touch,moves: moves.length,oneSave:true,cancel:true,conflict:true,receipt:true,imageDrop:true,pageBoundary:true,errors});await context.close();
 }fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));}catch(e){if(activePage){const stamp=Date.now();await activePage.screenshot({path:path.join(artifacts,'failure-'+stamp+'.png')});fs.writeFileSync(path.join(artifacts,'failure-'+stamp+'.json'),JSON.stringify(await activePage.evaluate(()=>({html:document.querySelector('.ideas-dialog')?.outerHTML,draft:Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('hub-idea')))})),null,2));}throw e;}finally{await browser.close();}
});

test('drag boundary Chrome: legacy pending payload, saved image, cross-page lost response and scroll/cancellation',{skip:!chromium||!chrome},async()=>{
 const name='DragBoundary';project(name);ideas.initialize(name,U.uuid());
 const browser=await chromium.launch({executablePath:chrome,headless:true}),page=await browser.newPage({viewport:{width:390,height:900}}),posts=[],errors=[],artifacts=process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname,'../../.ai/work/idea-list/drag-default');fs.mkdirSync(artifacts,{recursive:true});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/ideas/'))posts.push({route:new URL(r.url()).pathname,body:r.postDataJSON?.()});});
 try{
  await page.goto(base);const legacy={project:name,opId:U.uuid(),text:'legacy uncertain draft',category:'uncategorized',intent:'record'};
  await page.evaluate(([name,legacy])=>localStorage.setItem('hub-idea-draft:'+name,JSON.stringify({text:legacy.text,category:'uncategorized',attempt:{route:'/api/ideas/add',body:legacy,uncertain:true}})),[name,legacy]);
  await page.evaluate(name=>HubIdeas.open(name,'main'),name);assert.equal(await page.inputValue('[data-idea-category]'),'note');await page.click('[data-idea-add]');await page.waitForFunction(()=>!document.querySelector('#idea-text').value);assert.deepEqual(posts.find(p=>p.route==='/api/ideas/add').body,legacy);assert.equal(ideas.view(name).items[0].category,'note');
  await page.locator('[data-idea-files]').setInputFiles([{name:'after-drag.png',mimeType:'image/png',buffer:PNG}]);await page.waitForSelector('[data-image-remove]');await page.click('[data-idea-add]');await page.waitForFunction(()=>!document.querySelector('[data-image-remove]'));const image=ideas.view(name).items.find(i=>i.images?.length);assert.equal(image.category,'note');
  ideas.internal(name,U.uuid(),{fixture:'cross-page uncertain'},d=>{for(let n=0;n<100;n++)ideas.newItem(d,'boundary '+n,'record',null,U.uuid());});await page.evaluate(name=>HubIdeas.open(name,'main'),name);await collapseAutomationSettings(page);await page.click('[data-idea-action=list-edit]');
  const moving=ideas.read(name).itemOrder[0];let lose=true;await page.route('**/api/ideas/reorder',async route=>{if(lose){lose=false;await route.fetch();await route.abort();}else await route.continue();});await page.locator(`[data-idea-drag="${moving}"]`).press('Enter');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.waitForSelector('[data-idea-action=row-retry]');assert.equal(await page.locator('[data-idea-action=row-retry]').getAttribute('data-item'),moving);assert.equal(ideas.read(name).itemOrder.at(-1),moving);
  await page.reload();await page.evaluate(name=>HubIdeas.open(name,'main'),name);await collapseAutomationSettings(page);await page.click('[data-idea-action=list-edit]');await page.waitForSelector('[data-idea-action=row-retry]');await page.unroute('**/api/ideas/reorder');const n=posts.filter(p=>p.route==='/api/ideas/reorder').length;await page.click('[data-idea-action=row-retry]');await page.waitForFunction(()=>!document.querySelector('[data-idea-action=list-edit]').disabled);assert.equal(posts.filter(p=>p.route==='/api/ideas/reorder').length,n);
  await page.click('[data-idea-action=prev]');await page.waitForFunction(()=>document.querySelectorAll('.idea-edit-row').length===100);const grip=page.locator('[data-idea-drag]').first();await grip.scrollIntoViewIfNeeded();const h=await grip.boundingBox(),beforeScroll=await page.locator('.ideas-dialog').evaluate(e=>e.scrollTop);await page.mouse.move(h.x+20,h.y+20);await page.mouse.down();await page.mouse.move(h.x+20,880);await page.waitForFunction(before=>document.querySelector('.ideas-dialog').scrollTop>before+40,beforeScroll);await page.screenshot({path:path.join(artifacts,'mobile-autoscroll-drag.png')});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(posts.filter(p=>p.route==='/api/ideas/reorder').length,n);
  // A refresh cancels a held move if another writer changes the ledger.
  await page.locator('[data-idea-drag]').first().press('Enter');const d=ideas.read(name);ideas.reorder(name,{opId:U.uuid(),id:d.itemOrder[0],toIndex:1,baseOrderRev:d.orderRev});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForFunction(()=>![...document.querySelectorAll('[data-idea-drag]')].some(e=>e.getAttribute('aria-pressed')==='true'));assert.match(await page.locator('[data-drag-status]').innerText(),/更新/);assert.equal(posts.filter(p=>p.route==='/api/ideas/reorder').length,n);
  const kept=ideas.read(name).items[image.id];assert.equal(kept.images.length,1);assert.equal(kept.category,'note');assert.deepEqual(errors,[]);fs.writeFileSync(path.join(artifacts,'boundary-report.json'),JSON.stringify({legacyPayloadUnchanged:true,imageSaved:true,crossPageReceipt:true,scroll:true,refreshCancel:true,errors},null,2));
 }finally{await browser.close();}
});

test('drag R1 Chrome: unresolved reorder keeps filtered normal view stable and normal pagination free',{skip:!chromium||!chrome},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true}),artifacts=process.env.HUB_IDEA_TEST_ARTIFACTS||path.resolve(__dirname,'../../.ai/work/idea-list/drag-default-fix-ui'),report=[];fs.mkdirSync(artifacts,{recursive:true});
 try{for(const scenario of ['filter-bug','no-filter']){
  const name='DragR1-'+scenario;project(name);ideas.initialize(name,U.uuid());
  ideas.internal(name,U.uuid(),{fixture:'R1 150 rows'},d=>{for(let n=0;n<150;n++)ideas.newItem(d,'row '+n,'record',null,U.uuid());for(let n=0;n<5;n++)d.items[d.itemOrder[n]].category='bug';});
  const d=ideas.read(name),before=JSON.stringify(d),pendingId=d.itemOrder[120],operation={route:'/api/ideas/reorder',body:{project:name,opId:U.uuid(),id:pendingId,baseOrderRev:d.orderRev,toIndex:149},uncertain:true};
  const page=await browser.newPage({viewport:{width:1280,height:900}}),gets=[],posts=[],errors=[];page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/ideas?'))gets.push(new URL(r.url()).searchParams.toString());if(r.method()==='POST'&&r.url().includes('/api/ideas/'))posts.push(r.url());});
  try{
   await page.goto(base);await page.evaluate(([name,pendingId,operation])=>localStorage.setItem('hub-idea-draft:'+name,JSON.stringify({text:'',operations:{['reorder:'+pendingId]:operation}})),[name,pendingId,operation]);
   await page.evaluate(name=>HubIdeas.open(name,'main'),name);await page.waitForFunction(()=>document.querySelectorAll('.idea-item').length===100);
   const afterOpen=gets.length;if(scenario==='filter-bug')await page.click('[data-idea-action=filter][data-category=bug]');
   await page.waitForTimeout(3000);
   const window3s=gets.slice(afterOpen),rendered=await page.evaluate(()=>({rows:document.querySelectorAll('.idea-item').length,pressed:document.querySelector('.idea-filter[aria-pressed=true]')?.textContent.trim(),status:document.querySelector('[data-idea-status]')?.textContent}));
   assert.ok(window3s.length<=3,JSON.stringify({scenario,getsIn3s:window3s.length}));assert.ok(window3s.every(q=>new URLSearchParams(q).get('offset')==='0'));
   assert.equal(rendered.rows,scenario==='filter-bug'?5:100);if(scenario==='filter-bug')assert.match(rendered.pressed,/バグ/);
   await page.screenshot({path:path.join(artifacts,'r1-'+scenario+'.png')});
   if(scenario==='filter-bug'){await page.click('[data-idea-action=filter][data-category=""]');await page.waitForFunction(()=>document.querySelectorAll('.idea-item').length===100);}
   await page.click('[data-idea-action=next]');await page.waitForFunction(()=>document.querySelectorAll('.idea-item').length===50);assert.equal(await page.locator('.idea-item').first().getAttribute('data-item'),d.itemOrder[100]);
   await page.click('[data-idea-action=prev]');await page.waitForFunction(()=>document.querySelectorAll('.idea-item').length===100);assert.equal(await page.locator('.idea-item').first().getAttribute('data-item'),d.itemOrder[0]);
   assert.equal(JSON.stringify(ideas.read(name)),before);assert.deepEqual(await page.evaluate(name=>Object.values(JSON.parse(localStorage.getItem('hub-idea-draft:'+name)).operations),name),[operation]);assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
   report.push({scenario,total:150,pendingIndex:120,getsDuringOpen:afterOpen,getsIn3s:window3s.length,queriesIn3s:window3s,rendered,normalNextPrev:true,ledgerAndPendingUnchanged:true,posts,errors});
  }finally{await page.close();}
 }fs.writeFileSync(path.join(artifacts,'r1-report.json'),JSON.stringify({at:new Date().toISOString(),hubRoot:root,scenarios:report},null,2));}finally{await browser.close();}
});
