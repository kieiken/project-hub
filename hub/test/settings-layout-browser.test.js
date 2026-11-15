'use strict';
// Offline rendering fixture. Real controls/events, no running Hub or AI calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { snapshot } = require('./fixtures/app-ui-harness.cjs');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || [path.join(os.homedir(), '.local/bin/chrome-headless-arm64'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
async function fixture(t, saved = null, locale = 'ja', blocked = false) {
  const publicDir = path.resolve(__dirname, '../public'), data = snapshot(), requests = [], errors = [];
  const extensions = require('../lib/extensions').loadExtensions({ hub: path.resolve(__dirname, '..') });
  const generated = {
    '/extensions-ui.js': extensions.uiSource(),
    '/extensions-ui.css': extensions.uiSource('style'),
    // addInitScript below supplies this fixture's locale before scripts run.
    '/locale-config.js': '/* Fixture locale. */',
  };
  Object.assign(data, { efforts: ['中', '高'], unread: [], hiddenModels: {}, modelOrder: [], museSupported: true });
  data.roles.models = { codex: ['GPT-6.1-Sol'], 'claude-code': ['Opus 5.5'], agy: [] };
  let browser;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      requests.push(req.method + ' ' + url.pathname);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(url.pathname === '/api/state' ? data : {}));
    }
    if (Object.hasOwn(generated, url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css');
      return res.end(generated[url.pathname]);
    }
    const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(6000);
  await page.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => {
    if (response.status() >= 400) errors.push('HTTP ' + response.status() + ' ' + new URL(response.url()).pathname);
  });
  await page.addInitScript(({ saved, locale, messages, blocked }) => {
    if (saved !== null) localStorage.setItem('hub-settings-v2', saved);
    window.layoutStorageCalls = [];
    for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        layoutStorageCalls.push({ method, key: args[0] });
        if (blocked) throw Error('fixture storage blocked');
        return original.apply(this, args);
      };
    }
    window.HUB_LOCALE = { locale, messages };
    window.EventSource = class { close() {} };
  }, { saved, locale, blocked, messages: locale === 'ja' ? {} : require('../../langpacks/zh-TW/ui.json') });
  await page.goto(base);
  await page.waitForFunction(() => typeof renderSettings === 'function' && state?.projects?.length);
  await page.evaluate(() => {
    // Keep actual renderers and delegated event handlers; replace loaders only.
    for (const name of ['loadAiTools', 'loadSkills', 'loadAppUpdate', 'loadCliModels', 'loadRemote', 'loadGithub', 'loadLanguageSettings', 'loadMoveSettings', 'loadMuseSettings', 'loadJevSettings', 'loadChatgpt', 'refreshEmergencyStatus', 'autoCheckRoleAccounts', 'loadTokenUsage']) window[name] = () => {};
    window.layoutCalls = [];
    api = async (route, body) => { window.layoutCalls.push({ route, body }); return {}; };
    aiTools = {};
    const build = buildSettingsLayout;
    buildSettingsLayout = c => {
      window.originalSettingsNodes = [...c.root.querySelectorAll('input,select,button,textarea')];
      window.originalSettingsSections = [...c.root.querySelectorAll(':scope > section[data-tab]')];
      build(c);
    };
    view = { kind: 'settings', project: 'p', task: null };
    renderSettings();
  });
  return { page, errors, requests };
}
const options = { skip: !chromium || !chrome };
for (const saved of [null, '0', '1']) {
  test('settings always opens the fixed layout with legacy flag ' + String(saved), options, async t => {
    const { page, errors } = await fixture(t, saved);
    assert.equal(await page.locator('#settings-layout-trial,.settings-layout-trial').count(), 0);
    assert.equal(await page.locator('.settings-layout-panel').count(), 5);
    assert.deepEqual(await page.locator('[data-settings-tab]').evaluateAll(nodes => nodes.map(n => n.dataset.settingsTab)), ['basic', 'ai', 'recovery', 'connect', 'manage']);
    assert.deepEqual(await page.locator('[data-settings-tab]').allTextContents(), ['見た目', 'AI', '安全', 'つなぐ', '更新と記録']);
    assert.equal(await page.evaluate(() => originalSettingsNodes.every(n => n.isConnected)), true);
    assert.equal(await page.evaluate(() => originalSettingsSections.every(n => n.isConnected)), true);
    for (const tab of ['ai', 'recovery', 'connect', 'manage', 'basic']) {
      await page.locator('[data-settings-tab="' + tab + '"]').click();
      assert.equal(await page.locator('[data-layout-tab="' + tab + '"]').isVisible(), true);
      assert.equal(await page.locator('.settings-layout-panel:visible').count(), 1);
    }
    await page.locator('[data-settings-tab="basic"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-settings-tab="ai"]').getAttribute('aria-selected'), 'true');
    await page.evaluate(() => { rolesDraft = [{ name: 'draft', main: { ai: '人' }, backup: { ai: '人' } }]; selectSettingsTab('basic', true); });
    await page.locator('[data-theme-choice="light"]').click();
    assert.equal(await page.evaluate(() => window.HubTheme.current()), 'light');
    assert.equal(await page.evaluate(() => rolesDraft[0].name), 'draft');
    assert.equal(await page.evaluate(() => originalSettingsNodes.every(n => n.isConnected)), true);
    // Neither reads nor writes/removals of the obsolete flag may affect this layout.
    assert.deepEqual(await page.evaluate(() => layoutStorageCalls.filter(c => c.key === 'hub-settings-v2' || c.method === 'clear')), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('hub-settings-v2')), saved);
    await page.evaluate(() => { view = { kind: 'settings' }; renderSettings(); });
    assert.equal(await page.locator('.settings-layout-panel').count(), 5);
    assert.equal(await page.locator('#settings-layout-trial').count(), 0);
    assert.deepEqual(errors, []);
  });
}

test('fixed layout search and source redraw keep original controls, events and details state', options, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => {
    document.querySelector('#ai-accounts').innerHTML = '<details class="ai-mcp-detail"><summary>MCP fixture</summary><button id="fixture-mcp">MCP action</button></details>';
    document.querySelector('#language-box').innerHTML = '<details><summary>language fixture</summary><input id="fixture-language" value="draft"></details>';
    document.querySelector('#muse-settings-box').innerHTML = '<h3>Permits fixture</h3><label><select id="muse-workspace-context"><option>fixture</option></select></label><div id="muse-workspace-permits"><button id="fixture-permit">Permit action</button></div>';
    window.fixtureClicks = 0;
    document.querySelector('#fixture-mcp').onclick = () => fixtureClicks++;
    settingsLayoutSync();
  });
  assert.equal(await page.locator('.settings-layout-panel #fixture-mcp').count(), 1);
  assert.equal(await page.locator('[data-layout-tab="recovery"] #fixture-permit').count(), 1);
  const search = page.locator('#settings-layout-query');
  await search.fill('MCP fixture');
  await page.locator('#fixture-mcp').click();
  assert.equal(await page.evaluate(() => fixtureClicks), 1);
  await search.fill('missing-fixture-123');
  assert.match(await page.locator('.settings-layout-search [role="status"]').textContent(), /見つかりません/);
  await page.locator('.settings-layout-search button').click();
  assert.equal(await page.locator('#fixture-mcp').evaluate(n => n.closest('details').open), false);
  const restored = await page.evaluate(() => {
    window.portalNodes = ['#fixture-mcp', '#fixture-language', '#fixture-permit'].map(s => document.querySelector(s));
    for (const source of ['accounts', 'language', 'muse']) settingsLayoutRestoreSource(source);
    // Inspect synchronously: the observer correctly moves these again next tick.
    return {
      accounts: !!document.querySelector('#ai-accounts #fixture-mcp'),
      language: document.querySelector('#language-box #fixture-language')?.value,
      muse: !!document.querySelector('#muse-settings-box #fixture-permit'),
    };
  });
  assert.deepEqual(restored, { accounts: true, language: 'draft', muse: true });
  await page.evaluate(() => settingsLayoutSync());
  assert.equal(await page.evaluate(() => portalNodes.every(n => n.isConnected && n.closest('.settings-layout-panel'))), true);
  await search.fill('MCP fixture');
  await page.evaluate(() => {
    settingsLayoutRestoreSource('accounts');
    document.querySelector('#ai-accounts').innerHTML = '<details class="ai-mcp-detail"><summary>new MCP fixture</summary><button id="new-mcp">new</button></details>';
    settingsLayoutSync();
  });
  assert.equal(await page.locator('#fixture-mcp').count(), 0);
  assert.equal(await page.locator('.settings-layout-panel #new-mcp').count(), 1);
  assert.equal(await page.locator('#new-mcp').evaluate(n => n.closest('details').open), true);
  await page.locator('.settings-layout-search button').click();
  assert.equal(await page.locator('#new-mcp').evaluate(n => n.closest('details').open), false);
  assert.deepEqual(await page.evaluate(() => layoutCalls), []);
  assert.deepEqual(errors, []);
});

test('fixed layout works with browser storage reads and writes blocked from startup', options, async t => {
  const { page, errors } = await fixture(t, '0', 'ja', true);
  assert.equal(await page.locator('.settings-layout-panel').count(), 5);
  assert.equal(await page.locator('#settings-layout-trial').count(), 0);
  await page.locator('[data-settings-tab="ai"]').click();
  assert.equal(await page.locator('[data-layout-tab="ai"]').isVisible(), true);
  await page.locator('#settings-layout-query').fill('緊急停止');
  assert.equal(await page.locator('[data-layout-tab="recovery"]').isVisible(), true);
  await page.locator('.settings-layout-search button').click();
  await page.evaluate(() => renderSettings());
  assert.equal(await page.locator('.settings-layout-panel').count(), 5);
  assert.deepEqual(await page.evaluate(() => layoutStorageCalls.filter(c => c.key === 'hub-settings-v2' || c.method === 'clear')), []);
  assert.deepEqual(errors, []);
});

test('account redraw preserves drafts, focus, scroll and search; observer settles without extra requests', options, async t => {
  const { page, errors } = await fixture(t);
  await page.locator('[data-settings-tab="ai"]').click();
  await page.locator('#account-new-name').evaluate(n => { n.closest('details').open = true; });
  await page.locator('#account-new-name').fill('unsaved fixture');
  await page.locator('#account-new-name').focus();
  const scroll = await page.evaluate(() => {
    const scroller = document.querySelector('#main .settings').parentElement;
    scroller.scrollTop = 250;
    return scroller.scrollTop;
  });
  await page.evaluate(() => drawAccountSettings());
  assert.equal(await page.locator('#account-new-name').inputValue(), 'unsaved fixture');
  assert.equal(await page.locator('#account-new-name').evaluate(n => n === document.activeElement), true);
  assert.equal(await page.locator('#account-new-name').evaluate(n => n.closest('details').open), true);
  assert.equal(await page.evaluate(() => document.querySelector('#main .settings').parentElement.scrollTop), scroll);
  await page.locator('#settings-layout-query').fill('MCP');
  await page.evaluate(() => drawAccountSettings());
  assert.equal(await page.locator('#settings-layout-query').inputValue(), 'MCP');
  assert.equal(await page.locator('.settings-layout-panel .ai-mcp-detail').count(), 1);
  assert.equal(await page.locator('.ai-mcp-detail').evaluate(n => n.open), true);
  await page.locator('.settings-layout-search button').click();
  assert.equal(await page.locator('.ai-mcp-detail').evaluate(n => n.open), false);
  await page.locator('[data-settings-tab="ai"]').click();
  await page.locator('[data-check-credits="codex"]').check();
  assert.equal(await page.locator('[data-check-credits="codex"]').isChecked(), true);
  assert.equal(await page.evaluate(() => rolesDirty()), true);
  assert.equal(await page.locator('.settings-layout-panel').count(), 5);
  const stable = await page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sync = settingsLayoutSync; let calls = 0;
    settingsLayoutSync = () => { calls++; return sync(); };
    await new Promise(r => setTimeout(r, 80));
    settingsLayoutSync = sync;
    return calls;
  });
  assert.equal(stable, 0);
  assert.deepEqual(await page.evaluate(() => layoutCalls), []);
  assert.deepEqual(errors, []);
});

test('AI update stays first through asynchronous redraw; search, folds and narrow themes remain usable', options, async t => {
  const { page, errors } = await fixture(t);
  const order = () => page.evaluate(() => [...document.querySelector('[data-layout-tab="ai"]').children].map(n =>
    n.querySelector('#ai-tools') ? 'update' : n.querySelector('#roles-save') ? 'roles' : n.querySelector('#ai-accounts') ? 'accounts' :
    n.querySelector('#token-usage-box') ? 'tokens' : n.matches('[data-layout-status]') ? 'status' : n.matches('.settings-layout-start') ? 'start' : n.matches('details') ? 'more' : 'other'));
  const expected = ['update', 'roles', 'accounts', 'tokens', 'status', 'start', 'more'];
  assert.deepEqual(await order(), expected);
  assert.equal(await page.locator('#ai-tools').evaluate(n => !!n.closest('details')), false);
  await page.locator('[data-settings-tab="ai"]').click();
  await page.evaluate(() => { settingsLayoutCurrent().folds.ai.open = true; });
  const updateControls = await page.locator('#ai-tools button').evaluateAll(nodes => nodes.map(n => n.outerHTML));
  await page.locator('#settings-layout-query').fill('AI の更新');
  await page.evaluate(async () => { await Promise.resolve(); drawAiTools(); });
  assert.deepEqual(await order(), expected);
  assert.deepEqual(await page.locator('#ai-tools button').evaluateAll(nodes => nodes.map(n => n.outerHTML)), updateControls);
  assert.equal(await page.locator('#ai-tools [data-ai-update-all]').count(), 1);
  // These controls are inspected only; no AI update or Hub restart is executed.
  assert.equal(await page.locator('#settings-layout-query').inputValue(), 'AI の更新');
  assert.equal(await page.locator('#ai-tools').isVisible(), true);
  await page.locator('.settings-layout-search button').click();
  assert.equal(await page.evaluate(() => settingsLayoutCurrent().folds.ai.open), true);
  for (const [query, tab] of [['言語', 'basic'], ['iPhone', 'connect'], ['緊急停止', 'recovery']]) {
    await page.locator('#settings-layout-query').fill(query);
    assert.equal(await page.locator('[data-layout-tab="' + tab + '"]').isVisible(), true);
    await page.locator('.settings-layout-search button').click();
  }
  // A complete settings redraw also retains the search and the original fold state.
  await page.locator('#settings-layout-query').fill('MCP');
  await page.evaluate(() => renderSettings());
  assert.equal(await page.locator('#settings-layout-query').inputValue(), 'MCP');
  await page.locator('.settings-layout-search button').click();
  assert.equal(await page.evaluate(() => settingsLayoutCurrent().folds.ai.open), true);
  assert.deepEqual(await order(), expected);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.HubTheme.set(theme), theme);
    for (const width of [520, 390]) {
      await page.setViewportSize({ width, height: 850 });
      for (const tab of ['basic', 'ai', 'recovery', 'connect', 'manage']) {
        await page.locator('[data-settings-tab="' + tab + '"]').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('[data-layout-tab="' + tab + '"]').isVisible(), true);
      }
      assert.equal(await page.locator('.settings-tabs').evaluate(n => getComputedStyle(n).overflowX), 'auto');
    }
  }
  assert.deepEqual(await page.evaluate(() => layoutCalls), []);
  assert.deepEqual(errors, []);
});

test('fixed labels and default-permission summary translate in zh-TW with all controls retained', options, async t => {
  const { page, errors } = await fixture(t, '0', 'zh-TW');
  assert.equal(await page.locator('#settings-layout-trial').count(), 0);
  assert.equal(await page.locator('[data-settings-tab="basic"]').textContent(), '外觀');
  assert.equal(await page.locator('label[for="settings-layout-query"]').textContent(), '尋找設定');
  assert.match(await page.locator('[data-layout-status="recovery"]').textContent(), /設定空白，因此使用預設值/);
  assert.equal(await page.locator('#set-work-progress').count(), 1);
  assert.equal(await page.evaluate(() => originalSettingsNodes.every(n => n.isConnected)), true);
  assert.equal(await page.locator('.settings-layout-panel').count(), 5);
  assert.deepEqual(errors, []);
});
