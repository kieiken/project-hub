'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch {
  try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); }
  catch { /* The browser fixture also runs in environments without Chrome. */ }
}
const chrome = process.env.HUB_TEST_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), '.local/bin/chrome-headless-arm64')].find(file => fs.existsSync(file));
const script = file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');

test('HTML preview through the file link: opaque frame, selected assets and native controls', { skip: !chromium || !chrome }, async t => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const fixture = '<link rel="stylesheet" href="./sample.css"><h1>Mockup</h1>'
    + '<script>console.log("source script ran")</script><script src="/api/state"></script>'
    + '<img alt="Sample" src="photo.png" onload="console.log(\'source event ran\')">'
    + '<img alt="External" src="https://preview-fixture.invalid/remote.png"><img alt="Other file" src="../photo.png">'
    + '<a href="javascript:void(0)">Source link</a><form action="/api/state"><button>Source button</button></form>'
    + '<details><summary>Expand</summary><p>Expanded content</p></details>'
    + '<div role="tablist"><button role="tab" aria-selected="true" aria-controls="first">First</button>'
    + '<button role="tab" aria-controls="second">Second</button></div>'
    + '<div role="tabpanel" id="first">First content</div><div role="tabpanel" id="second" hidden>Second content</div>'
    + '<div style="height:1800px"></div><p>Bottom of mockup</p>';
  const base = 'http://preview-fixture.invalid', requests = [], sourceMessages = [];
  const ticket = '1'.repeat(48);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6_000);
  page.on('console', message => { if (message.text().startsWith('source ')) sourceMessages.push(message.text()); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.href === base + '/') return route.fulfill({ contentType: 'text/html', body: '<a href="#" data-path="sample.html">Sample file</a>' });
    if (url.pathname === '/api/reveal') return route.fulfill({ json: { path: 'sample.html', view: true, viewKind: 'mockup', remote: true } });
    if (url.pathname === '/api/file/view' && url.searchParams.get('path') === 'sample.html') {
      assert.equal(url.searchParams.has('hubResource'), false);
      return route.fulfill({ json: { html: fixture, mockup: ticket } });
    }
    if (url.pathname === '/api/file/view' && url.searchParams.get('mockup') === ticket) {
      const asset = url.searchParams.get('asset');
      if (asset === 'sample.css') return route.fulfill({ json: { css: 'h1{color:rgb(12,34,56)}' } });
      if (asset === 'photo.png') return route.fulfill({ json: { type: 'image/png', base64: fs.readFileSync(path.join(__dirname, '../public/icon.png')).toString('base64') } });
    }
    return route.abort();
  });
  await page.goto(base);
  await page.addStyleTag({ content: script('app.css') });
  for (const file of ['locale.js', 'app-mockup-preview.js', 'app-files.js']) {
    await page.addScriptTag({ content: script(file) });
  }
  await page.addScriptTag({ content: `
    const UI = HubI18n, $ = s => document.querySelector(s), IN_APP = false;
    const view = { project: 'fixture', task: 'preview' };
    let fileViewer = null;
    const esc = value => String(value);
    const api = async url => (await fetch(url, { method: 'POST' })).json();
    const fileViewUrl = p => '/api/file/view?hubResource=fixture&path=' + encodeURIComponent(p);
    document.addEventListener('click', appFilesCallback1658());
    document.addEventListener('click', appFilesCallback1845());
  ` });
  await page.getByText('Sample file').click();
  await page.getByRole('button', { name: '見本をプレビュー' }).click();
  const iframe = page.locator('.fv-preview-viewport iframe'), frame = page.frameLocator('.fv-preview-viewport iframe');
  await frame.getByText('Mockup', { exact: true }).waitFor();
  assert.equal(await iframe.getAttribute('sandbox'), '');
  assert.equal(await iframe.evaluate(el => el.contentDocument), null);
  assert.equal(await frame.locator('h1').evaluate(node => getComputedStyle(node).color), 'rgb(12, 34, 56)');
  assert.ok(await frame.getByAltText('Sample').evaluate(node => node.complete && node.naturalWidth > 0));
  assert.equal(await frame.getByAltText('External').getAttribute('src'), null);
  assert.equal(await frame.getByAltText('Other file').getAttribute('src'), null);
  assert.equal(await frame.locator('script, [onload], form, a[href]').count(), 0);
  assert.ok(await frame.getByRole('button', { name: 'Source button' }).isDisabled());
  assert.ok(await frame.getByText('Expanded content').isHidden());
  await frame.getByText('Expand', { exact: true }).click();
  assert.ok(await frame.getByText('Expanded content').isVisible());
  assert.ok(await frame.getByText('First content').isVisible());
  assert.ok(await frame.getByText('Second content').isHidden());
  await frame.getByText('Second', { exact: true }).click();
  assert.ok(await frame.getByText('First content').isHidden());
  assert.ok(await frame.getByText('Second content').isVisible());
  await page.getByLabel('拡大率').selectOption('150%');
  assert.equal(await iframe.evaluate(el => el.style.transform), 'scale(1.5)');
  await frame.getByText('Bottom of mockup').scrollIntoViewIfNeeded();
  assert.ok(await frame.getByText('Bottom of mockup').evaluate(el => el.ownerDocument.scrollingElement.scrollTop > 0));
  assert.deepEqual(sourceMessages, []);
  assert.deepEqual(requests, ['/', '/api/reveal', '/api/file/view', '/api/file/view', '/api/file/view']);
  await page.locator('.fv-mobile-controls button').click();
  await iframe.waitFor({ state: 'detached' });
});
