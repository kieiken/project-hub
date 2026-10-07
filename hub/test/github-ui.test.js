'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/github.js'), 'utf8');
function ui(api) {
  const elements = new Map(), handlers = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false, dataset: {}, querySelectorAll: () => [], focus() {} }); return elements.get(id); };
  const context = vm.createContext({ $: el, esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), api, load: async () => {}, document: { body: { insertAdjacentHTML() {} }, addEventListener: (n, fn) => { const list = handlers.get(n) || []; list.push(fn); handlers.set(n, list); } } });
  vm.runInContext(source, context);
  const event = async (name, target, selector) => { target.closest = s => s === selector ? target : null; for (const cb of handlers.get(name) || []) await cb({ target }); };
  return { context, el, event };
}
const preview = { project: 'p', folder: '/local/folder', ledger: true, accounts: [{ login: 'kieiken' }], defaultAccount: 'kieiken', defaultOwner: 'kieiken', suggestedName: 'sample', blockers: [], canPush: true, branch: 'main', head: 'saved-head', commits: 2, dirty: true, risky: [{ file: '.env', reason: 'secret' }], git: 'repo', remotes: [] };
function fields(a) { a.el('#github-name').value = 'sample'; a.el('#github-create-account').value = 'kieiken'; a.el('#github-create-owner').value = 'kieiken'; }

test('sheet starts with push unchecked, shows private fixed and disclosures; names disable create', async () => {
  const a = ui(async () => preview); fields(a); await a.context.openGithubCreate('p');
  const html = a.el('#github-sheet').innerHTML; assert.match(html, /非公開（自分と招待した人だけ）/); assert.match(html, /id="github-push" type="checkbox" >作った後|id="github-push" type="checkbox" > 作った後/);
  assert.match(html, /未保存の変更は送られません/); assert.match(html, /\.env：secret/); assert.match(html, /id="github-push-notice" hidden/);
  a.el('#github-name').value = '..'; a.context.githubValidate(); assert.equal(a.el('#github-create').disabled, true);
  a.el('#github-name').value = 'okay'; a.el('#github-push').checked = true; a.context.githubValidate(); assert.equal(a.el('#github-create').disabled, false); assert.equal(a.el('#github-push-notice').hidden, false);
});
test('creation sends explicit choices and pinned head; failure keeps inputs; success cannot submit again', async () => {
  let createBody, result = 'error'; const a = ui(async (url, body) => {
    if (url.endsWith('/preview')) return preview;
    if (url.endsWith('/create')) { createBody = body; if (result === 'error') throw Error('temporary'); return { ok: true, pushed: false, url: 'https://github.com/u/r', message: '作りました' }; }
  }); fields(a); await a.context.openGithubCreate('p');
  const button = a.el('#github-create'); button.dataset = { githubAction: 'create' };
  await a.event('click', button, '[data-github-action]'); assert.equal(createBody.push, false); assert.equal(createBody.expectedHead, 'saved-head'); assert.equal(createBody.confirm, true);
  assert.equal(a.el('#github-name').value, 'sample'); assert.equal(a.el('#github-result').textContent, 'temporary'); assert.equal(button.disabled, false);
  result = 'success'; await a.event('click', button, '[data-github-action]'); assert.match(a.el('#github-result').innerHTML, /保存は送っていません/); assert.equal(button.disabled, true);
});
test('partial creation shows completed stage and link and does not allow repeating create', async () => {
  const a = ui(async url => url.endsWith('/preview') ? preview : { partial: true, message: '送信に失敗しました', url: 'https://github.com/u/r' }); fields(a); await a.context.openGithubCreate('p');
  const button = a.el('#github-create'); button.dataset = { githubAction: 'create' }; await a.event('click', button, '[data-github-action]');
  assert.match(a.el('#github-result').innerHTML, /送信に失敗しました/); assert.match(a.el('#github-result').innerHTML, /data-url="https:\/\/github.com\/u\/r"/); assert.equal(button.disabled, true);
});
test('dismissed preview cannot reopen; pending operation cannot be dismissed', async () => {
  let resolve; const a = ui(() => new Promise(r => { resolve = r; })); fields(a);
  const pending = a.context.openGithubCreate('p'); a.context.githubSheetClose(); resolve(preview); await pending; assert.equal(a.el('#github-sheet').hidden, true);
  vm.runInContext('githubPending = true', a.context); a.el('#github-sheet').hidden = false; a.context.githubSheetClose(); assert.equal(a.el('#github-sheet').hidden, false);
});
