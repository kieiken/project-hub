'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), { randomUUID, createHash } = require('node:crypto');
const { snapshot, project } = require('./fixtures/app-ui-harness.cjs');
let chromium; try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || [path.join(os.homedir(), '.local/bin/chrome-headless-arm64'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));

test('sidebar search and modes: stable IME, right-hand results, destination navigation/return, stale mode/view replies and narrow layout', { skip: !chromium || !chrome }, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-search-browser-'));
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const row = text => ({ role: 'user', text, at: '2026-10-24T10:00:00Z' });
  const data = snapshot(), ft = { ...project(), id: 'freetalk', name: 'freetalk', kind: 'freetalk' }, child = { ...project('完了'), id: 'child', name: 'Child', parent: 'p' };
  ft.tasks[0].title = 'Free topic'; ft.tasks.push({ ...ft.tasks[0], id: 'migrated', title: 'Moved topic', freetalkHistory: { migrated: { project: 'p', task: 't' } } });
  data.projects.push(ft, child); data.freetalk = { ready: true }; data.unread = [{ project: 'freetalk', task: 't' }, { project: 'child', task: 't' }];
  for (const p of data.projects) {
    write(path.join(root, 'Product', p.id, 'PROJECT.md'), `---\nname: ${p.name}\n${p.kind ? 'kind: freetalk\n' : ''}---\n`);
    for (const task of p.tasks) write(path.join(root, 'Product', p.id, '.ai/tasks', task.id + '.md'), `---\ntitle: ${task.title}\nstate: ${task.state}\n---\n`);
  }
  const pdir = path.join(root, 'Product/p');
  write(path.join(pdir, '.ai/chat/t.jsonl'), [row('<img src=x onerror="window.searchXSS=1"> needle Ｍｕｓｅ ｶﾞ カ\u3099 ガ e\u0301'), row('unique-new'), row('mode-slow current'), ...Array.from({ length: 115 }, (_, i) => row('needle current ' + i))].map(r => JSON.stringify(r)).join('\n') + '\n');
  write(path.join(root, 'Product/freetalk/.ai/chat/t.jsonl'), JSON.stringify(row('needle free-topic')) + '\n');
  write(path.join(root, 'Product/freetalk/.ai/chat/migrated.jsonl'), JSON.stringify(row('needle migrated')) + '\n');
  write(path.join(root, 'Product/child/.ai/chat/t.jsonl'), JSON.stringify(row('needle child-completed')) + '\n');
  const aid = randomUUID(), adir = path.join(pdir, '.ai/chat/history/t', aid), original = Buffer.from([row('archive before'), row('needle archived'), row('archive after'), row('mode-slow archived')].map(r => JSON.stringify(r)).join('\n') + '\n');
  write(path.join(adir, '0.original'), original); fs.chmodSync(path.join(adir, '0.original'), 0o600);
  write(path.join(adir, 'manifest.json'), JSON.stringify({ id: aid, project: 'p', task: 't', stage: 'committed', entries: [{ kind: 'log', saved: '0.original', existed: true, mode: 0o600, bytes: original.length, digest: createHash('sha256').update(original).digest('hex') }] }));
  const requests = [], errors = [], publicDir = path.resolve(__dirname, '../public'), search = new (require('../lib/conversation-search').ConversationSearch)(root);
  let browser, sse, routes, delayContext = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(req.method + ' ' + url.pathname);
    if (url.pathname.startsWith('/api/conversation-search')) {
      if (url.pathname.endsWith('/context') && delayContext) await new Promise(r => setTimeout(r, 650));
      let body; if (req.method === 'POST') { const parts = []; for await (const chunk of req) parts.push(chunk); body = JSON.parse(Buffer.concat(parts)); }
      if (body?.query === 'slow-old' || body?.query === 'mode-slow' && body.mode === 'simple') await new Promise(r => setTimeout(r, 650));
      return routes.access.handle(req, res, url, body);
    }
    if (url.pathname === '/api/chat/stream') {
      const log = path.join(root, 'Product', url.searchParams.get('project'), '.ai/chat', url.searchParams.get('task') + '.jsonl');
      const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [row('visible conversation')];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ type: 'rows', rows, generation: 1, queue: [], busy: null }) + '\n\n'); sse = res; return;
    }
    if (url.pathname === '/api/task/history/archive') { const all = original.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), offset = Number(url.searchParams.get('offset')) || 0; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ rows: all.slice(offset, offset + 100), total: all.length, offset })); }
    if (url.pathname === '/api/freetalk/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(ft.tasks.find(t => t.id === url.searchParams.get('task'))?.freetalkHistory || {})); }
    if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(url.pathname === '/api/state' ? data : {})); }
    const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file));
  });
  t.after(async () => { await browser?.close(); search.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  routes = require('../lib/routes/conversation-search')({ search, PORT: port, fromRemote: () => false, send(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } });
  browser = await chromium.launch({ executablePath: chrome, headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(8000);
  const base = 'http://127.0.0.1:' + port; await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort()); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('hub-view', JSON.stringify({ kind: 'work', project: 'p', task: 't' })); localStorage.setItem('hub-mode', 'chat'); });
  await page.goto(base); await page.locator('#chat-in').fill('下書きを保持');
  await page.evaluate(() => { chatImages('p', 't').push({ id: 'retained', path: 'retained.png', name: 'retained.png', kind: 'image' }); }); requests.length = 0;
  const waitDone = () => page.waitForFunction(() => /ファイルを確認/.test(document.querySelector('#conversation-search-status')?.textContent || '') && !document.querySelector('#conversation-search-status').textContent.includes('未完了'));
  const run = async (q, mode = 'simple') => { await page.locator('#conversation-search-query').fill(q); await page.locator('#conversation-search-mode').evaluate((el, value) => { el.value = value; }, mode); await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit()); await waitDone(); };
  const card = q => page.locator('.conversation-search-card').filter({ hasText: q });
  const back = async () => { if (await page.locator('#task-history-sheet').isVisible()) await page.keyboard.press('Escape'); const button = page.locator('[data-search-return]'); if (await button.isVisible()) await button.click(); else { await page.locator('#menu-toggle').click(); await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit()); } await page.waitForSelector('#main #conversation-search'); if (page.viewportSize().width <= 720) await page.waitForFunction(() => document.querySelector('#list').getBoundingClientRect().right <= 0); };
  const openProject = async () => { const toggle = page.locator('#sidebar-projects-toggle'); if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); await page.locator('#list [data-go="project"][data-p="p"]').first().click(); };
  // A slow backend must stay bounded, show no premature hits and stop polling
  // when cancelled; a subsequent search must still complete normally.
  const heldPolls = []; let reached;
  const sixPolls = new Promise(resolve => { reached = resolve; });
  const holdPoll = async route => {
    heldPolls.push(Date.now());
    await route.fulfill({ json: { mode: 'simple', status: 'running', stats: {}, total: 0, hits: [], next: null } });
    if (heldPolls.length === 6) reached();
  };
  await page.route('**/api/conversation-search?*', holdPoll);
  await page.locator('#conversation-search-query').fill('needle');
  await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit());
  await Promise.race([sixPolls, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('polling stalled')), 5000); timer.unref(); })]);
  assert.ok(heldPolls[5] - heldPolls[0] >= 800, 'long searches must back off instead of polling rapidly throughout');
  assert.equal(await page.locator('.conversation-search-hit').count(), 0);
  await page.locator('#conversation-search-stop').click();
  const stoppedCount = heldPolls.length;
  await page.waitForTimeout(400); assert.equal(heldPolls.length, stoppedCount);
  assert.match(await page.locator('#conversation-search-status').innerText(), /中断/);
  await page.unroute('**/api/conversation-search?*', holdPoll);
  await run('needle'); assert.equal(await page.locator('#main #conversation-search').count(), 1); assert.equal(await page.locator('.conversation-search-hit').count(), 50);
  assert.equal(await page.locator('#conversation-search-list img').count(), 0); assert.equal(await page.evaluate(() => window.searchXSS), undefined);
  assert.match(await page.locator('#conversation-search-scope').innerText(), /簡易検索/); assert.equal(await card('needle archived').count(), 0);
  const sidebarOrder = await page.evaluate(() => [...document.querySelector('#list').children].map(e => e.id || e.querySelector('section')?.querySelector('button')?.id));
  assert.deepEqual(sidebarOrder, ['conversation-search-form', 'sidebar-freetalk-toggle', 'sidebar-projects-toggle']);
  for (const id of ['freetalk', 'projects']) await page.locator('#sidebar-' + id + '-toggle').click();
  assert.equal(await page.locator('#conversation-search-query').isVisible(), true);
  // Poll/full render changes the surrounding groups but never remounts the IME input or results.
  await page.locator('#conversation-search-query').focus();
  await page.evaluate(() => { window.retainedInput = document.querySelector('#conversation-search-query'); retainedInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); state.projects[0].name = 'Updated Project'; render(); retainedInput.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
  assert.equal(await page.evaluate(() => document.activeElement === retainedInput && retainedInput === document.querySelector('#conversation-search-query')), true);
  assert.equal(await page.locator('.conversation-search-hit').count(), 50);
  await page.evaluate(() => retainedInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await run('needle', 'detailed'); assert.match(await page.locator('#conversation-search-scope').innerText(), /詳細検索/);
  await page.locator('#conversation-search-more').click(); await page.waitForFunction(() => document.querySelectorAll('.conversation-search-hit').length === 100);
  const archived = card('needle archived'); await archived.scrollIntoViewIfNeeded(); const before = await page.locator('#conversation-search-results').evaluate(e => e.scrollTop);
  await archived.getByRole('button', { name: '発言と前後を読む' }).click(); await page.waitForSelector('.conversation-search-target');
  assert.match(await page.locator('#conversation-search-rows').innerText(), /archive before[\s\S]*needle archived[\s\S]*archive after/);
  await page.locator('#conversation-search-back').click(); assert.equal(await page.locator('#conversation-search-results').evaluate(e => e.scrollTop), before);
  assert.equal(requests.filter(x => /\/api\/task\/read/.test(x)).length, 0);
  delayContext = true; await archived.getByRole('button', { name: '発言と前後を読む' }).click(); await openProject(); await back(); await new Promise(r => setTimeout(r, 750)); delayContext = false;
  assert.equal(await page.locator('#conversation-search-context').isHidden(), true); assert.equal(await page.locator('#conversation-search-results').evaluate(e => e.scrollTop), before);
  await archived.locator('.conversation-search-hit').click(); await page.waitForFunction(() => view.kind === 'work' && view.project === 'p' && view.task === 't');
  await page.waitForSelector('#task-history-sheet .history-content > article.search-focus'); assert.match(await page.locator('#task-history-sheet article.search-focus').innerText(), /needle archived/);
  assert.match(await page.locator('#task-history-sheet .history-content').innerText(), /archive before[\s\S]*needle archived[\s\S]*archive after/);
  await back(); assert.match(await page.locator('#conversation-search-status').innerText(), /ファイルを確認/); assert.equal(await page.locator('#conversation-search-query').inputValue(), 'needle'); assert.equal(await page.locator('#conversation-search-mode').inputValue(), 'detailed'); assert.equal(await page.locator('#conversation-search-results').evaluate(e => e.scrollTop), before);
  await card('needle free-topic').locator('.conversation-search-hit').click(); await page.waitForSelector('#main .freetalk-work'); assert.equal(await page.evaluate(() => view.task), 't'); await back();
  assert.equal(requests.filter(x => /\/api\/task\/read/.test(x)).length, 1);
  await card('needle migrated').locator('.conversation-search-hit').click(); await page.waitForSelector('.freetalk-work[data-readonly="true"]'); await back();
  await card('needle child-completed').locator('.conversation-search-hit').click(); await page.waitForFunction(() => view.kind === 'work' && view.project === 'child' && view.task === 't'); await page.waitForSelector('#msgs .m.search-focus'); assert.match(await page.locator('#msgs .m.search-focus').innerText(), /child-completed/); await back();
  await archived.getByRole('button', { name: '該当作業・話題を開く' }).click(); await page.waitForSelector('#chat-in'); assert.equal(await page.locator('#chat-in').inputValue(), '下書きを保持'); assert.equal(await page.evaluate(() => chatImages('p', 't')[0].id), 'retained');
  sse.write('data: ' + JSON.stringify({ type: 'row', row: row('new live row') }) + '\n\n'); await page.waitForFunction(() => document.querySelector('#msgs').textContent.includes('new live row')); await back();
  await run('unique-new'); await card('unique-new').locator('.conversation-search-hit').click(); await page.waitForSelector('#msgs .m.search-focus');
  assert.match(await page.locator('#msgs .m.search-focus').innerText(), /unique-new/); assert.equal(await page.locator('#msgs .m.search-focus').count(), 1);
  const inView = () => page.evaluate(() => { const f = document.querySelector('.m.search-focus').getBoundingClientRect(), b = document.querySelector('#msgs').getBoundingClientRect(); return f.bottom > b.top && f.top < b.bottom && f.right <= innerWidth + 1 && f.left >= -1; });
  assert.equal(await inView(), true); assert.equal(await page.locator('#chat-in').inputValue(), '下書きを保持'); await back();
  await run('needle absent'); assert.ok(await page.getByText('関連候補：一部の語が一致', { exact: false }).count());
  await run('Ｍｕｓｅ'); assert.equal(await page.locator('.conversation-search-hit mark').innerText(), 'Ｍｕｓｅ');
  for (const [q, expected] of [['ガ', ['ｶﾞ', 'カ\u3099', 'ガ']], ['é', ['e\u0301']]]) { await run(q); assert.deepEqual(await page.locator('.conversation-search-hit mark').allTextContents(), expected); }
  await run('missing'); assert.match(await page.locator('#conversation-search-status').innerText(), /候補はありません/);
  // Changing mode rejects the delayed old mode response, without changing the word.
  await page.locator('#conversation-search-query').fill('mode-slow'); await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit());
  await page.locator('#conversation-search-mode').selectOption('detailed'); await waitDone(); await new Promise(r => setTimeout(r, 750));
  assert.equal(await page.locator('#conversation-search-query').inputValue(), 'mode-slow'); assert.equal(await page.locator('.conversation-search-hit').count(), 2); assert.match(await page.locator('#conversation-search-scope').innerText(), /詳細検索/);
  await page.locator('#conversation-search-query').fill('slow-old'); await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit());
  await openProject(); await new Promise(r => setTimeout(r, 750)); assert.equal(await page.evaluate(() => view.kind), 'project'); assert.equal(await page.locator('#main #conversation-search').count(), 0);
  await page.locator('#conversation-search-form').evaluate(f => f.requestSubmit()); await run('unique-new');
  data.projects = data.projects.filter(p => p.id !== 'p'); await page.locator('.conversation-search-hit').click(); await page.waitForFunction(() => document.querySelector('#conversation-search-status').textContent.includes('移動先が見つからない')); assert.equal(await page.evaluate(() => view.kind), 'search');
  data.projects.unshift({ ...project(), name: 'Project' });
  await run('needle', 'detailed');
  if (process.env.HUB_SEARCH_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.HUB_SEARCH_EVIDENCE_DIR, 'search-layout-desktop.png') });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 }); const rect = await page.locator('#conversation-search').boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
    assert.equal(await page.locator('#conversation-search').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
    await page.locator('#menu-toggle').click(); assert.equal(await page.locator('#conversation-search-query').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('#list').getBoundingClientRect().left >= 0);
    if (width === 390 && process.env.HUB_SEARCH_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.HUB_SEARCH_EVIDENCE_DIR, 'search-layout-narrow-sidebar.png') });
    await run('free-topic', 'detailed');
    await card('needle free-topic').locator('.conversation-search-hit').click(); await page.waitForSelector('.freetalk-work'); await page.waitForSelector('#msgs .m.search-focus');
    await page.waitForFunction(() => document.querySelector('#list').getBoundingClientRect().right <= 0); assert.equal(await inView(), true); await back();
    if (width === 390 && process.env.HUB_SEARCH_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.HUB_SEARCH_EVIDENCE_DIR, 'search-layout-narrow.png') });
  }
  assert.equal(requests.filter(x => /\/api\/chat\/send/.test(x)).length, 0);
  assert.deepEqual(errors, []); console.log('SEARCH_LAYOUT_UI ' + JSON.stringify({ checks: 44, viewportWidths: [1280, 390, 320], pageErrors: errors.length, fixtureOnly: true }));
});
