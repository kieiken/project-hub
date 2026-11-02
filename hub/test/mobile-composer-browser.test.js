'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { snapshot, project } = require('./fixtures/app-ui-harness.cjs');
let chromium; try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), '.local/bin/chrome-headless-arm64')].find(p => fs.existsSync(p));

// Real app DOM/CSS, isolated in-memory API, simulated visualViewport only.
// This does not claim to exercise an iPhone keyboard or send an AI request.
test('mobile composer: attachments and reduced visual viewport keep input and send reachable', { skip: !chromium || !chrome }, async t => {
  const data = snapshot(), ft = { ...project(), id: 'freetalk', kind: 'freetalk' };
  data.projects.push(ft); data.freetalk = { ready: true };
  data.roles.models.codex = ['GPT-6.1-Sol']; data.cliFlags = { codex: { 'GPT-6.1-Sol': 'gpt-6.1-sol' } };
  const publicDir = path.resolve(__dirname, '../public'), errors = [], posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'GET') { posts.push(url.pathname); res.writeHead(409); return res.end('{"error":"read-only fixture"}'); }
      if (url.pathname === '/api/chat/stream') { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"type":"rows","rows":[]}\n\n'); return; }
      return res.end(JSON.stringify(url.pathname === '/api/state' ? data : {}));
    }
    const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file));
  });
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(8000);
  const base = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', r => r.request().url().startsWith(base + '/') ? r.continue() : r.abort());
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const vv = new EventTarget(); Object.assign(vv, { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: vv });
    window.resizeVisible = (height, offsetTop = 0, scale = 1) => { Object.assign(vv, { height, offsetTop, scale }); vv.dispatchEvent(new Event('resize')); };
    localStorage.setItem('hub-mode', 'chat');
  });
  await page.goto(base); await page.waitForFunction(() => typeof renderWork === 'function' && state.projects.length);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const seed = async (id, count) => {
    await page.evaluate(({ id, count }) => {
      const p = state.projects.find(p => p.id === id); view = { kind: 'work', project: id, task: 't' };
      const images = chatImages(id, 't'); images.splice(0, images.length, ...Array.from({ length: count }, (_, i) => ({ id: 'img-' + i, name: 'IMG_' + i + '.png', path: 'fixture-' + i, kind: 'image', status: 'ok', url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' })));
      setChatDraft(chatAttachmentKey(id, 't'), '未送信の下書き\nカーソルのある行'); render();
    }, { id, count });
    if (await page.locator('#chat-in').isHidden()) await page.locator('#mobile-compose').click();
    await settle();
  };
  const reachable = async selector => {
    const result = await page.locator(selector).evaluate(el => {
      const box = el.closest('#composer');
      for (const scroll of [box, box.parentElement]) {
        if (getComputedStyle(scroll).overflowY !== 'auto') continue;
        const b = scroll.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (r.bottom > b.bottom) scroll.scrollTop += r.bottom - b.bottom + 2;
        else if (r.top < b.top) scroll.scrollTop -= b.top - r.top + 2;
      }
      const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
      return { top: r.top, bottom: r.bottom, boxTop: b.top, boxBottom: b.bottom, visible: visualViewport.height, hit: hit === el || el.contains(hit), scrollTop: box.scrollTop, client: box.clientHeight, scroll: box.scrollHeight,
        layout: [...document.querySelectorAll('body>.bar,body>.mobile-information,.work,.work>*:not(#mobile-work-info),.chat>*')].filter(e => e.getBoundingClientRect().height).map(e => [e.id || e.className, Math.round(e.getBoundingClientRect().top), Math.round(e.getBoundingClientRect().height)]) };
    });
    assert.ok(result.top >= result.boxTop - 1 && result.bottom <= result.boxBottom + 1 && result.bottom <= result.visible + 1 && result.hit, selector + ' must be reachable: ' + JSON.stringify(result));
  };
  const shot = async name => {
    if (process.env.HUB_MOBILE_COMPOSER_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.HUB_MOBILE_COMPOSER_SCREENSHOTS, 'mobile-composer-' + name + '.png') });
  };
  for (const width of [390, 320]) for (const id of ['p', 'freetalk']) for (const height of [340, 240]) for (const count of [0, 1, 4, 12]) {
    await t.test(`${id} ${width}px visible=${height}px images=${count}`, async () => {
      await page.setViewportSize({ width, height: 844 }); await page.evaluate(() => resizeVisible(844));
      await seed(id, count); await page.locator('#chat-in').focus();
      await page.evaluate(height => { window.keptInput = document.querySelector('#chat-in'); keptInput.setSelectionRange(keptInput.value.length, keptInput.value.length); resizeVisible(height); }, height); await settle();
      assert.equal(await page.locator('#chat-in').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= visualViewport.height + 1; }), true, 'focused input is brought above the keyboard');
      await reachable('#chat-in'); await reachable('#chat-send');
      if (id === 'p' && count === 4) await shot(width + '-' + height);
      assert.equal(await page.locator('#composer').evaluate(el => getComputedStyle(el).overflowY), 'auto');
      assert.equal(await page.locator('#chat-images .quick-image').count(), count);
      assert.equal(await page.locator('#chat-in').inputValue(), '未送信の下書き\nカーソルのある行');
      assert.equal(await page.evaluate(() => keptInput === document.querySelector('#chat-in') && document.activeElement === keptInput && keptInput.selectionStart === keptInput.value.length), true);
      await page.locator('#chat-in').evaluate(el => el.blur());
      await page.evaluate(() => resizeVisible(844)); await settle();
      assert.equal(await page.locator('.chat').evaluate(el => el.scrollTop), 0, 'keyboard close restores outer chat position');
      await page.locator('#mobile-compose').click(); await page.locator('#mobile-compose').click();
      assert.equal(await page.locator('#chat-in').inputValue(), '未送信の下書き\nカーソルのある行');
      assert.equal(await page.locator('#chat-images .quick-image').count(), count);
    });
  }
  await t.test('attachment addition/removal and focus reflow retain DOM and draft', async () => {
    await page.setViewportSize({ width: 320, height: 844 }); await seed('p', 4);
    await page.locator('#chat-in').focus(); await page.evaluate(() => { window.keptInput = document.querySelector('#chat-in'); resizeVisible(300, 200); }); await settle();
    await page.evaluate(() => { const images = chatImages('p', 't'); images.push(...Array.from({ length: 8 }, (_, i) => ({ ...images[0], id: 'extra-' + i }))); drawChatImages('p', 't'); });
    await reachable('#chat-in'); await reachable('#chat-send');
    await page.locator('[data-chat-remove="extra-7"]').evaluate(el => el.click());
    assert.equal(await page.locator('#chat-images .quick-image').count(), 11);
    await reachable('#chat-in'); await reachable('#chat-send');
    assert.equal(await page.evaluate(() => keptInput === document.querySelector('#chat-in')), true);
    assert.match(await page.locator('#chat-in').inputValue(), /未送信の下書き/);
  });
  await t.test('long chat notice remains scrollable above the focused composer', async () => {
    await page.evaluate(() => resizeVisible(844)); await seed('p', 4);
    await page.evaluate(() => { const notice = document.createElement('p'); notice.textContent = '実行状態が変わりました。'.repeat(40); document.querySelector('.chat').prepend(notice); });
    await page.locator('#chat-in').focus(); await page.evaluate(() => resizeVisible(300)); await settle();
    await reachable('#chat-in'); await reachable('#chat-send');
    const scrolled = await page.locator('.chat').evaluate(el => { el.scrollTop = 0; return { top: el.scrollTop, overflow: getComputedStyle(el).overflowY, extra: el.scrollHeight - el.clientHeight }; });
    assert.equal(scrolled.top, 0); assert.equal(scrolled.overflow, 'auto'); assert.ok(scrolled.extra > 200);
    await reachable('#chat-in'); await reachable('#chat-send');
  });
  await t.test('desktop and pinch layout do not acquire the mobile scroll constraint', async () => {
    await page.evaluate(() => resizeVisible(844)); await page.setViewportSize({ width: 1280, height: 900 }); await seed('p', 4);
    await page.evaluate(() => resizeVisible(340, 0)); await settle();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('mobile-keyboard')), false);
    assert.equal(await page.locator('#composer').evaluate(el => getComputedStyle(el).overflowY), 'visible');
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => resizeVisible(340, 120, 2)); await settle();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('mobile-keyboard')), false);
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--hub-visible-height')), '100dvh');
  });
  assert.deepEqual(errors, []); assert.deepEqual(posts, ['/api/freetalk/ensure'], 'only the app startup request reaches the isolated fixture; no chat is sent');
});
