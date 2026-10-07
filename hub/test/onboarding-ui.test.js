'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/onboarding.js'), 'utf8');
function fixture(auto = false, projects = []) {
  const events = {}, calls = [], toasts = [], elements = new Map(); let sheet;
  const element = () => ({ disabled: false, focus() {}, innerHTML: '', open: false, selected: [],
    setAttribute() {}, addEventListener(name, f) { this[name] = f; }, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, { disabled: false, focus() {} }); return elements.get(selector); },
    querySelectorAll(selector) { return selector.includes(':checked') ? this.selected : []; } });
  const ctx = vm.createContext({ document: { activeElement: { focus() {} }, body: { appendChild(el) { sheet = el; } }, createElement: element, addEventListener: (name, f) => { events[name] = f; } }, window: {},
    state: { projects, onboarding: { status: 'new', step: 'ai', auto, ais: ['claude'] } }, stateLoadEpoch: 0,
    esc: v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    api: async (route, body) => { calls.push({ route, body }); return route.endsWith('/check') ? { tools: Object.fromEntries(body.ais.map(ai => [ai, { installed: false, login: 'unknown', version: '' }])), terminal: false } : { onboarding: { ...body, auto: body.status === 'in-progress' } }; },
    toast: m => toasts.push(m), copyText: async text => calls.push({ copy: text }), view: {}, open: new Set(), save() {}, render() {},
  });
  vm.runInContext(source, ctx);
  const click = action => events.click({ target: { closest: selector => selector === '[data-onboarding-action]' ? { dataset: { onboardingAction: action }, disabled: false } : null } });
  return { ctx, calls, events, toasts, click, get sheet() { return sheet; }, elements };
}
test('fresh auto-open saves progress; existing users stay closed; finished users stay closed', async () => {
  const a = fixture(true); await new Promise(r => setImmediate(r));
  assert.equal(a.sheet.open, true); assert.equal(a.calls[0].body.status, 'in-progress'); assert.match(a.sheet.innerHTML, /デスクトップアプリは要りません/);
  a.ctx.window.HubOnboarding.sync(); assert.equal(a.calls.length, 1);
  const b = fixture(false); assert.equal(b.sheet, undefined); assert.equal(b.calls.length, 0);
  await a.click('later'); assert.equal(a.sheet.open, false); assert.equal(a.ctx.state.onboarding.status, 'skipped');
  a.ctx.window.HubOnboarding.sync(); assert.equal(a.sheet.open, false); assert.match(a.toasts[0], /設定/);
});
test('manual reopen starts at AI retaining choices, copy only; check is explicit; all four steps complete', async () => {
  const a = fixture(false); a.ctx.state.onboarding = { status: 'skipped', step: 'first', ais: ['codex'] };
  await a.ctx.window.HubOnboarding.open(); assert.match(a.sheet.innerHTML, /1\. AIを選ぶ/);
  assert.deepEqual(Array.from(a.calls[0].body.ais), ['codex']);
  await a.click('next'); assert.match(a.sheet.innerHTML, /2\. 入れる・ログイン/); assert.match(a.sheet.innerHTML, /公式の手引き/);
  await a.events.click({ target: { closest: s => s === '[data-onboarding-copy]' ? { dataset: { onboardingCopy: 'codex', command: 'install' } } : null } });
  assert.match(a.calls.at(-1).copy, /^curl /);
  await a.click('next'); assert.equal(a.calls.filter(c => c.route?.endsWith('/check')).length, 0);
  await a.click('check'); assert.match(a.sheet.innerHTML, /確認できません/); assert.match(a.sheet.innerHTML, /見つかりません/);
  await a.click('next'); assert.match(a.sheet.innerHTML, /4\. 始める/); assert.match(a.sheet.innerHTML, /今の設定のまま/);
  await a.click('done'); assert.equal(a.sheet.open, false); assert.equal(a.ctx.state.onboarding.status, 'done');
  assert.ok(a.calls.every(c => !c.route || c.route.startsWith('/api/onboarding')));
});
test('selection requires one AI and editing does not change actual roles; failure keeps old step and dialog', async () => {
  const a = fixture(false); await a.ctx.window.HubOnboarding.open();
  a.sheet.selected = []; a.events.change({ target: { dataset: { onboardingAi: 'claude' } } });
  assert.equal(a.elements.get('[data-onboarding-action="next"]').disabled, true);
  a.sheet.selected = [{ dataset: { onboardingAi: 'codex' } }]; a.events.change({ target: { dataset: { onboardingAi: 'codex' } } });
  assert.equal(a.elements.get('[data-onboarding-action="next"]').disabled, false);
  a.ctx.api = async () => { throw Error('保存失敗'); };
  await a.click('next'); assert.match(a.sheet.innerHTML, /1\. AIを選ぶ/); assert.match(a.sheet.innerHTML, /保存失敗/); assert.equal(a.sheet.open, true);
  await a.click('later'); assert.equal(a.sheet.open, true);
  assert.match(a.sheet.innerHTML, /進捗を保存できていません/);
  const saved = a.ctx.state.onboarding, count = a.calls.length;
  await a.click('dismiss'); assert.equal(a.sheet.open, false);
  assert.equal(a.ctx.state.onboarding, saved); assert.equal(a.calls.length, count);
});
for (const reason of ['EACCES', 'ENOSPC', '通信障害']) {
  for (const exit of ['dismiss', 'escape']) {
    test(`failed postpone (${reason}) exits via ${exit} without pretending persistence, and resumes normally`, async () => {
      const a = fixture(false); await a.ctx.window.HubOnboarding.open();
      const saved = a.ctx.state.onboarding, epoch = a.ctx.stateLoadEpoch, workingAPI = a.ctx.api;
      let failedCalls = 0;
      a.ctx.api = async () => { failedCalls++; throw Error(reason); };
      await a.click('later'); assert.equal(a.sheet.open, true);
      assert.match(a.sheet.innerHTML, /保存しないで閉じる/); assert.match(a.sheet.innerHTML, /次の起動時/);
      assert.match(a.sheet.innerHTML, new RegExp(reason));
      if (exit === 'escape') {
        let prevented = false; a.sheet.cancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
      } else await a.click('dismiss');
      assert.equal(a.sheet.open, false); assert.equal(failedCalls, 1);
      assert.equal(a.ctx.state.onboarding, saved); assert.equal(a.ctx.stateLoadEpoch, epoch);
      assert.match(a.toasts.at(-1), /保存できていません/);
      a.ctx.window.HubOnboarding.sync(); assert.equal(a.sheet.open, false);
      a.ctx.api = workingAPI; await a.ctx.window.HubOnboarding.open();
      assert.doesNotMatch(a.sheet.innerHTML, /保存しないで閉じる/);
      for (let i = 0; i < 3; i++) await a.click('next');
      await a.click('done'); assert.equal(a.sheet.open, false); assert.equal(a.ctx.state.onboarding.status, 'done');
    });
  }
}
test('opening and completing save failures offer escape without marking new or unfinished progress complete', async () => {
  const a = fixture(false), workingAPI = a.ctx.api;
  a.ctx.api = async () => { throw Error('EACCES'); };
  await a.ctx.window.HubOnboarding.open(); assert.match(a.sheet.innerHTML, /進捗を保存できていません/);
  a.sheet.cancel({ preventDefault() {} }); assert.equal(a.sheet.open, false); assert.equal(a.ctx.state.onboarding.status, 'new');
  a.ctx.api = workingAPI; await a.ctx.window.HubOnboarding.open();
  for (let i = 0; i < 3; i++) await a.click('next');
  const saved = a.ctx.state.onboarding;
  a.ctx.api = async () => { throw Error('ENOSPC'); };
  await a.click('done'); assert.equal(a.sheet.open, true); assert.match(a.sheet.innerHTML, /進捗を保存できていません/);
  await a.click('dismiss'); assert.equal(a.sheet.open, false); assert.equal(a.ctx.state.onboarding, saved);
  assert.equal(a.ctx.state.onboarding.status, 'in-progress');
});
test('Agy unknown settings and API path render fixed guidance without claiming login required or exposing values', async () => {
  for (const notice of ['settings-unreadable', 'api-provider']) {
    const a = fixture(false); a.ctx.state.onboarding.ais = ['agy']; await a.ctx.window.HubOnboarding.open();
    await a.click('next'); await a.click('next');
    a.ctx.api = async () => ({ tools: { agy: { installed: true, version: '', login: 'unknown', notice, token: 'PRIVATE' } }, terminal: true });
    await a.click('check'); assert.match(a.sheet.innerHTML, /ログイン：確認できません/);
    assert.match(a.sheet.innerHTML, notice === 'api-provider' ? /APIの利用設定/ : /設定ファイルを確認/);
    assert.doesNotMatch(a.sheet.innerHTML, /ログインが必要|PRIVATE|保存しないで閉じる/);
  }
});
test('start buttons save done and navigate without creating projects or starting AI', async () => {
  const a = fixture(false, [{ id: 'サンプルアプリ', tasks: [{ id: 'demo', state: '未着手' }] }]);
  await a.ctx.window.HubOnboarding.open(); for (let i = 0; i < 3; i++) await a.click('next');
  assert.match(a.sheet.innerHTML, /サンプル「サンプルアプリ」の作業を開く/);
  await a.click('sample'); assert.equal(a.ctx.view.task, 'demo'); assert.equal(a.ctx.state.onboarding.status, 'done');
  await a.ctx.window.HubOnboarding.open(); for (let i = 0; i < 3; i++) await a.click('next');
  await a.click('newproject'); assert.equal(a.ctx.view.kind, 'newproject');
  assert.ok(a.calls.every(c => c.route === '/api/onboarding'));
});
test('escaping while idle postpones; busy check blocks duplicate operations and cancel', async () => {
  const a = fixture(false); await a.ctx.window.HubOnboarding.open(); await a.click('next'); await a.click('next');
  let release; a.ctx.api = (route, body) => { a.calls.push({ route, body }); return new Promise(r => { release = r; }); };
  const pending = a.click('check'); const count = a.calls.length;
  await a.click('check'); await a.click('later'); assert.equal(a.calls.length, count);
  let prevented = false; a.sheet.cancel({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(a.calls.length, count);
  release({ tools: { claude: { installed: true, login: 'ready', version: '<unsafe>' } }, terminal: true }); await pending;
  assert.match(a.sheet.innerHTML, /&lt;unsafe&gt;/);
});
