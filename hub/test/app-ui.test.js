'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function app(userAgent = '') {
  const elements = new Map();
  const events = new Map();
  const documentListeners = [];
  const timers = new Map();
  const timeouts = new Map();
  const details = [];
  let nextTimer = 0;
  let stream;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      dataset: {}, handlers: {}, attributes: {}, addEventListener(name, cb) { this.handlers[name] = cb; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, focus() { document.activeElement = this; },
    });
    return elements.get(key);
  }
  class EventSource {
    constructor() { stream = this; }
    close() {}
  }
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb, capture = false) { events.set(name, cb); documentListeners.push({ name, cb, capture }); },
  };
  const context = vm.createContext({
    document, window: {}, navigator: { userAgent }, location: { href: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}), // 起動時の load() は試験用の状態を上書きしない
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, { cb, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return { context, document, elements, element, events, documentListeners, timers, timeouts, details, stream: () => stream };
}

const project = (state = '実行中') => ({
  id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '',
  phases: [], tasks: [{ id: 't', title: 'Task', state, owner: 'codex', role: '', model: '', effort: '',
    phase: '', steps: [], skills: [], question: '', next: '', copy: false }],
  folders: [], related: [], issues: [], chats: [],
});
const snapshot = (taskState = '実行中', sessions = []) => ({
  root: '/tmp', projects: [project(taskState)], roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  sessions, chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});

test('一覧の描き直し前に整理の所属を判定し、利用状況を閉じても実際の画面移動を続ける', () => {
  for (const [go, pid, shouldClose] of [['project', 'other', true], ['work', 'other', true], ['work', 'p', false]]) {
    const a = app(); a.context.api = () => new Promise(() => {});
    const navigation = a.documentListeners.find(x => x.name === 'click' && x.cb.toString().includes('view = { kind: go.dataset.go'));
    const before = a.documentListeners.length;
    for (const file of ['maintenance.js', 'usage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), a.context);
    const captures = a.documentListeners.slice(before).filter(x => x.name === 'click' && x.capture);
    vm.runInContext('maintenanceProject="p";view={kind:"project",project:"p"};', a.context);
    a.element('#maintenance-drawer').hidden = false; a.element('#usage-drawer').hidden = false;
    a.element('#usage-toggle').focus = () => assert.fail('outside navigation must retain focus');
    let attached = true, rendered = false;
    const button = { dataset: { go, p: pid, t: go === 'work' ? 't' : undefined }, closest: s => s === '#list' && attached ? a.element('#list') : null };
    const event = { target: { id: '', dataset: {}, closest: s => s === '[data-go]' || s === '#list [data-go][data-p]' && attached ? button : null },
      preventDefault: () => assert.fail('navigation must continue'), stopPropagation: () => assert.fail('navigation must continue') };
    a.context.closeDrawer = () => {}; a.context.markRead = () => {}; a.context.showInTree = () => {}; a.context.save = () => {};
    a.context.render = () => {
      assert.equal(a.element('#maintenance-drawer').hidden, shouldClose);
      assert.equal(a.element('#usage-drawer').hidden, true);
      attached = false; rendered = true;
    };
    for (const listener of captures) listener.cb(event);
    navigation.cb(event);
    assert.equal(rendered, true);
    assert.equal(vm.runInContext('view.kind', a.context), go); assert.equal(vm.runInContext('view.project', a.context), pid);
    assert.equal(a.element('#usage-toggle').attributes['aria-expanded'], 'false');
  }
});

const notesToggle = (id, open, isConnected = true) => ({
  target: { id: '', dataset: { p: id }, open, isConnected,
    classList: { contains: c => c === 'project-notes' } },
});
const notesTag = a => a.element('#main').innerHTML.match(/<details class="more project-notes"[^>]*>/)?.[0];

test('account picker hides the single default, escapes names and preserves deleted selection', () => {
  const a = app(), data = snapshot();
  data.accounts = [{ ai: 'codex', id: 'default', name: '既定' }];
  vm.runInContext('state=' + JSON.stringify(data), a.context);
  assert.match(a.context.taskAccountSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), /hidden/);
  data.accounts.push({ ai: 'codex', id: 'one', name: '<secret>' });
  vm.runInContext('state=' + JSON.stringify(data), a.context);
  const html = a.context.taskAccountSelect(data.projects[0], { ...data.projects[0].tasks[0], accounts: { codex: 'removed' } }, 'codex');
  assert.match(html, /value="removed" selected disabled/); assert.match(html, /&lt;secret&gt;/); assert.doesNotMatch(html, /<secret>/);
});
test('account saving updates the latest task, retains drafts, and restores selection on failure', async () => {
  const a = app(), data = snapshot(), select = { dataset: { p: 'p', t: 't', ai: 'codex' }, value: 'one', disabled: false };
  vm.runInContext('state=' + JSON.stringify(data) + ';chatDraft.keep="入力中"', a.context);
  let resolve; a.context.api = () => new Promise(r => { resolve = r; });
  const pending = a.context.saveTaskAccount(select); assert.equal(select.disabled, true);
  vm.runInContext('state.projects[0].tasks[0]={...state.projects[0].tasks[0]}', a.context);
  resolve({ accounts: { codex: 'one' } }); await pending;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].accounts.codex', a.context), 'one');
  assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
  a.context.api = async () => { throw Error('failed'); }; select.value = 'two'; await a.context.saveTaskAccount(select);
  assert.equal(select.value, 'one'); assert.equal(select.disabled, false);
});

function accountApp(terminal = true) {
  const a = app(), data = snapshot('未着手'); data.terminal = terminal;
  data.projects[0].tasks[0].accounts = { claude: 'old-c', codex: 'old-x' };
  data.accounts = ['claude', 'codex'].flatMap(ai => ['default', 'old-' + (ai === 'claude' ? 'c' : 'x'), 'new-' + (ai === 'claude' ? 'c' : 'x')].map(id => ({ ai, id, name: id })));
  vm.runInContext('state=' + JSON.stringify(data) + ';view={kind:"work",project:"p",task:"t"};chatDraft.keep="入力中"', a.context);
  const select = a.element('#chat-account');
  select.dataset = { p: 'p', t: 't', ai: 'codex' }; select.value = 'new-x'; select.tagName = 'SELECT';
  a.document.querySelectorAll = q => q === '[data-task-account]' ? [select] : [];
  a.document.activeElement = select;
  a.context.toast = () => {};
  return { ...a, data, select };
}
const selectedAccount = (a, ai = 'codex') => vm.runInContext(`state.projects[0].tasks[0].accounts.${ai}`, a.context);

for (const method of ['refreshTree', 'pollState', 'load', 'refreshAiToolCatalog']) {
  for (const arrival of ['during-save', 'after-save']) test(`account selection rejects old ${method} response ${arrival} and sends the shown account`, async () => {
    const a = accountApp(); let saved, fetched;
    a.context.api = route => new Promise(resolve => { if (route === '/api/accounts/select') saved = resolve; else { assert.equal(route, '/api/state'); fetched = resolve; } });
    const saving = a.context.saveTaskAccount(a.select), fetching = a.context[method]();
    if (arrival === 'during-save') { fetched(a.data); await fetching; }
    saved({ accounts: { claude: 'old-c', codex: 'new-x' } }); await saving;
    if (arrival === 'after-save') { fetched(a.data); await fetching; }
    assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
    assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    a.element('#chat-ai').value = 'codex|GPT-6.1-Sol'; a.element('#chat-in').value = 'send shown account';
    let sent;
    a.context.api = async (route, body) => {
      if (route === '/api/chat/send') { sent = body.account; throw Error('request captured without CLI'); }
      return [];
    };
    a.context.openChat(a.data.projects[0], a.data.projects[0].tasks[0]);
    await a.element('#composer').handlers.submit({ preventDefault() {} });
    assert.equal(sent, a.select.value);
  });
}
// Keep the real api/fetchState: only HTTP is simulated, including conditional 304s.
function accountHttp(a) {
  let server = JSON.parse(JSON.stringify(a.data)), tag = '"initial"', held, saved;
  const requests = [];
  a.context.fetch = (route, opt = {}) => {
    if (route === '/api/accounts/select') return new Promise(resolve => {
      saved = () => resolve({ status: 200, ok: true, json: async () => ({ accounts: { codex: 'new-x' } }) });
    });
    assert.equal(route, '/api/state');
    const sentTag = opt.headers?.['If-None-Match'];
    const status = sentTag === tag ? 304 : 200;
    const data = JSON.parse(JSON.stringify(server)), responseTag = tag;
    requests.push({ sentTag, status });
    const response = { status, ok: status === 200, headers: { get: key => key === 'etag' ? responseTag : null }, json: async () => data };
    if (held === true) return new Promise(resolve => { held = () => resolve(response); });
    return Promise.resolve(response);
  };
  return {
    requests,
    update(title, nextTag) {
      server.projects[0].tasks[0].title = title;
      server.projects[0].tasks[0].accounts = { claude: 'new-c', codex: 'new-x' };
      tag = nextTag;
    },
    hold() { held = true; },
    release() { const resolve = held; held = null; resolve(); },
    save() { saved(); },
  };
}

for (const method of ['load', 'refreshTree', 'pollState', 'refreshAiToolCatalog']) {
  for (const start of ['before-save', 'during-save']) for (const arrival of ['during-save', 'after-save']) {
    test(`discarded HTTP ${method} (${start}/${arrival}) leaves its ETag unacknowledged and retries the state`, async () => {
      const a = accountApp(), http = accountHttp(a);
      await a.context.refreshTree();
      assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
      a.select.value = 'new-x';
      http.update('shared updated title', '"shared"'); http.hold();
      let saving, fetching;
      if (start === 'before-save') { fetching = a.context[method](); saving = a.context.saveTaskAccount(a.select); }
      else { saving = a.context.saveTaskAccount(a.select); fetching = a.context[method](); }
      if (arrival === 'during-save') { http.release(); await fetching; }
      http.save(); await saving;
      if (arrival === 'after-save') { http.release(); await fetching; }
      assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'Task');
      assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
      assert.equal(selectedAccount(a, 'claude'), 'old-c');
      await a.context.refreshTree();
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'shared updated title');
      assert.equal(selectedAccount(a, 'claude'), 'new-c');
      assert.equal(vm.runInContext('stateTag', a.context), '"shared"');
      await a.context.refreshTree();
      assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 304]);
      assert.equal(http.requests[2].sentTag, '"initial"');
      assert.equal(http.requests[3].sentTag, '"shared"');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    });
  }
  for (const arrival of ['before-new-state', 'after-new-state']) {
    test(`parallel HTTP ${method} discarded ${arrival} cannot replace the adopted state ETag`, async () => {
      const a = accountApp(), http = accountHttp(a);
      await a.context.refreshTree(); a.select.value = 'new-x';
      const saving = a.context.saveTaskAccount(a.select);
      http.update('discarded title', '"discarded"'); http.hold();
      const fetching = a.context[method]();
      http.save(); await saving;
      if (arrival === 'before-new-state') { http.release(); await fetching; }
      http.update('latest title', '"latest"');
      await a.context.refreshTree();
      if (arrival === 'after-new-state') { http.release(); await fetching; }
      assert.equal(vm.runInContext('stateTag', a.context), '"latest"');
      assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'latest title');
      assert.equal(selectedAccount(a, 'claude'), 'new-c');
      assert.equal(selectedAccount(a), 'new-x'); assert.equal(a.select.value, 'new-x');
      await a.context.refreshTree();
      assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 304]);
      assert.equal(http.requests[3].sentTag, '"latest"');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
    });
  }
}

for (const method of ['load', 'refreshTree', 'pollState', 'refreshAiToolCatalog']) {
  test(`accepted HTTP ${method} acknowledges exactly its state, then conditional retrieval returns 304`, async () => {
    const a = accountApp(), http = accountHttp(a);
    a.context.render = () => {}; // Only rendering is stubbed; HTTP and adoption stay real.
    http.update('accepted title', '"accepted"');
    await a.context[method]();
    assert.equal(vm.runInContext('stateTag', a.context), '"accepted"');
    assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'accepted title');
    await a.context.refreshTree();
    assert.deepEqual(http.requests.map(r => r.status), [200, 304]);
    assert.equal(http.requests[1].sentTag, '"accepted"');
  });
}

test('parallel HTTP bodies retain their own ETags even when JSON decoding finishes out of order', async () => {
  const a = accountApp(), http = accountHttp(a);
  await a.context.refreshTree();
  const normalFetch = a.context.fetch;
  let finishBody;
  http.update('older title', '"older"');
  a.context.fetch = async (...args) => {
    const r = await normalFetch(...args), data = await r.json();
    return { ...r, json: () => new Promise(resolve => { finishBody = () => resolve(data); }) };
  };
  const older = a.context.refreshTree();
  // Let the headers arrive while the older response body is still pending.
  for (let n = 0; n < 10 && !finishBody; n++) await Promise.resolve();
  assert.equal(typeof finishBody, 'function');
  a.context.fetch = normalFetch;
  http.update('latest title', '"latest"');
  await a.context.refreshTree();
  assert.equal(vm.runInContext('stateTag', a.context), '"latest"');
  finishBody(); await older;
  // Both notifications share an epoch: if the older body is adopted, its own tag
  // must travel with it, so the next request can retrieve the latest state again.
  assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'older title');
  assert.equal(vm.runInContext('stateTag', a.context), '"older"');
  await a.context.refreshTree(); await a.context.refreshTree();
  assert.equal(vm.runInContext('state.projects[0].tasks[0].title', a.context), 'latest title');
  assert.deepEqual(http.requests.map(r => r.status), [200, 200, 200, 200, 304]);
});

test('failed HTTP state requests preserve the accepted ETag and untagged adoption clears it', async () => {
  const a = accountApp(), http = accountHttp(a);
  await a.context.refreshTree();
  a.context.fetch = async () => ({ status: 500, ok: false, headers: { get: () => '"error"' }, json: async () => ({ error: 'state unavailable' }) });
  await assert.rejects(a.context.fetchState(), /state unavailable/);
  assert.equal(vm.runInContext('stateTag', a.context), '"initial"');
  const untagged = a.data;
  a.context.fetch = async () => ({ status: 200, ok: true, json: async () => untagged });
  await a.context.refreshTree();
  assert.equal(vm.runInContext('stateTag', a.context), '');
});

for (const order of [['claude', 'codex'], ['codex', 'claude']]) test(`account save responses in ${order.join('/')} order retain both selections`, async () => {
  const a = accountApp(), pending = {}, selects = {}, jobs = {};
  a.context.api = (_route, b) => new Promise(resolve => { pending[b.ai] = resolve; });
  for (const ai of ['claude', 'codex']) {
    selects[ai] = { dataset: { p: 'p', t: 't', ai }, value: ai === 'claude' ? 'new-c' : 'new-x' };
    jobs[ai] = a.context.saveTaskAccount(selects[ai]);
  }
  // Each response is allowed to contain the other AI's stale snapshot.
  for (const ai of order) { pending[ai]({ accounts: { claude: ai === 'claude' ? 'new-c' : 'old-c', codex: ai === 'codex' ? 'new-x' : 'old-x' } }); await jobs[ai]; }
  assert.equal(selectedAccount(a, 'claude'), 'new-c'); assert.equal(selectedAccount(a), 'new-x');
});
test('the same task/AI cannot save through a second picker until the first selection settles', async () => {
  const a = accountApp(); let saved, calls = 0;
  a.context.api = () => { calls++; return new Promise(resolve => { saved = resolve; }); };
  const saving = a.context.saveTaskAccount(a.select);
  const second = { dataset: { ...a.select.dataset }, value: 'default' };
  await a.context.saveTaskAccount(second); assert.equal(calls, 1); assert.equal(second.value, 'old-x');
  saved({ accounts: { codex: 'new-x' } }); await saving;
  assert.equal(selectedAccount(a), 'new-x');
});
test('focused account picker follows a later authoritative state instead of displaying an unsent account', async () => {
  const a = accountApp(); a.context.api = async () => a.data;
  await a.context.refreshTree();
  assert.equal(a.select.value, 'old-x'); assert.equal(selectedAccount(a), a.select.value);
});
for (const terminal of [true, false]) for (const outcome of ['success', 'failure']) test(`${terminal ? 'embedded' : 'external'} terminal waits for account save ${outcome} and pins the settled selection`, async () => {
  const a = accountApp(terminal), calls = []; let resolve, reject, fetched;
  a.context.api = (route, body) => {
    if (route === '/api/accounts/select') return new Promise((yes, no) => { resolve = yes; reject = no; });
    if (route === '/api/state') return new Promise(yes => { fetched = yes; });
    calls.push({ route, body }); return Promise.resolve({ dir: '/fixture' });
  };
  const saving = a.context.saveTaskAccount(a.select), oldFetch = a.context.refreshTree();
  await a.context.startAI('p', 't', 'codex'); assert.equal(calls.length, 0);
  if (outcome === 'success') resolve({ accounts: { codex: 'new-x' } }); else reject(Error('save failed'));
  await saving; fetched(a.data); await oldFetch;
  a.context.load = async () => {};
  const starting = a.context.startAI('p', 't', 'codex');
  // A later selection cannot alter the already constructed request.
  vm.runInContext('state.projects[0].tasks[0].accounts.codex="default"', a.context);
  await starting;
  assert.equal(calls.length, 1); assert.equal(calls[0].route, terminal ? '/api/term/start' : '/api/continue');
  assert.equal(calls[0].body.account, outcome === 'success' ? 'new-x' : 'old-x');
  assert.equal(a.select.value, calls[0].body.account);
  assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
});

for (const action of ['child', 'branch']) test(`ツリーの${action === 'child' ? '子作業は共通の初期AIで作成' : '分岐も共通の初期AIで作成'}する`, async () => {
  const a = app(), data = snapshot(), calls = [];
  const parent = data.projects[0].tasks[0];
  Object.assign(parent, { owner: 'claude-code', role: '司令塔', phase: '設計', parent: 'grandparent', model: 'Opus 5.5', effort: 'MAX' });
  data.roles.models = { codex: ['Astra', 'GPT-6.1-Sol'], 'claude-code': ['Fable 5.1', 'Opus 5.5'] };
  data.roles.roles = [{ name: '司令塔', main: { ai: 'claude-code', model: 'Fable 5.1', effort: '極高' }, backup: { ai: 'codex', model: 'Astra', effort: '極高' } }];
  data.efforts = ['中', '高', '極高', 'MAX'];
  data.initialPick = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/hierarchy.js'), 'utf8'), a.context);
  a.context.innerWidth = 1000; a.context.innerHeight = 700;
  a.context.prompt = () => '新しい作業';
  a.context.api = async (route, body) => { calls.push({ route, body }); return { ...body, id: 'created', steps: [], state: '未着手' }; };
  a.context.load = async () => {};
  const menu = a.element('#menu'); menu.style = {}; menu.offsetWidth = 200; menu.offsetHeight = 160;
  menu.querySelector = () => ({ focus() {} });
  a.context.showTreeMenu('p', 't', 20, 20);
  await menu.onclick({ target: { closest: () => ({ dataset: { treeAction: action } }) } });
  assert.equal(calls.length, 1); assert.equal(calls[0].route, '/api/task/new');
  const body = JSON.parse(JSON.stringify(calls[0].body));
  assert.deepEqual(body, {
    project: 'p', title: '新しい作業', parent: action === 'child' ? 't' : 'grandparent',
    kind: action === 'child' ? 'main' : 'derived', derivedFrom: action === 'child' ? '' : 'p/t',
    owner: 'claude-code', model: 'Opus 5.5', effort: '中', phase: '設計', role: '司令塔',
  });
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(view)', a.context)), { kind: 'work', project: 'p', task: 'created' });
  assert.equal(parent.owner, 'claude-code'); assert.equal(parent.model, 'Opus 5.5'); assert.equal(parent.effort, 'MAX');
  if (action === 'child') {
    const child = { ...body, id: 'created', steps: [] }, html = a.context.chatHtml(data.projects[0], child);
    assert.match(a.context.chip(data.projects[0], child), /Claude Code.*Opus 5\.5・中/);
    assert.match(html, /value="claude\|Opus 5.5"[^>]*\bselected\b/);
    assert.match(html, /<option selected>中<\/option>/);
  }
});

test('問題点は今の問題・未整理・閉じた履歴に分かれ、原文は詳しくの中だけに残る', () => {
  const a = app(), p = project();
  p.issues = [
    { text: '内部ID・commitと経緯\n次の行', level: '高', summary: { title: '場所の確認', state: '確認待ち', next: '場所を確認する', who: '人' } },
    '【作者の見出し】長い経緯', '見出しのない経緯',
    { text: '古い原文', summary: { title: '貼り付けの修正', state: '解決済み', next: '', who: '' } },
    { text: '判断の原文', summary: { title: '対応を決める', state: '判断待ち', next: '選択肢を整理する', who: 'AI' } },
    { text: '未解決の原文', summary: { title: '保存できない', state: '未解決', next: '', who: '' } },
    { text: '過去の原文', summary: { title: '過去の判断', state: '履歴', next: '', who: '' } },
  ];
  a.context.renderOverview(p);
  const html = a.element('#main').innerHTML;
  assert.ok(html.indexOf('今の問題') < html.indexOf('まだまとめていない（2件）'));
  assert.ok(html.indexOf('まだまとめていない（2件）') < html.indexOf('解決済み・履歴（2件）'));
  assert.match(html, /次：あなた：場所を確認する/); assert.match(html, /次：AI：選択肢を整理する/);
  assert.match(html, /<span class="pill">高<\/span>/);
  assert.match(html, /<details class="issue-history issue-group"><summary>解決済み・履歴（2件）/);
  assert.match(html, /<b class="issue-title issue-unprepared">【作者の見出し】<\/b>/);
  assert.match(html, /<b class="issue-title issue-unprepared">見出しなし<\/b>/);
  assert.match(html, /<p class="issue-original">内部ID・commitと経緯\n次の行<\/p>/);
  const collapsed = html.replace(/<details class="issue-detail">[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(collapsed, /長い経緯|見出しのない経緯|内部ID・commitと経緯|古い原文/);
  assert.match(html, /このプロジェクトの作業の会話で「問題点を短くまとめて」/);
});

test('問題点の要約・原文・作者見出しをエスケープし、長文を要約として切り出さない', () => {
  const a = app(), text = '<script>evil</script>\n' + '長文'.repeat(1000);
  const html = a.context.issuesHtml([
    { text, summary: { title: '<img src=x onerror="evil">', state: '確認待ち', next: '<script>next</script>', who: '人' } },
    '【<script>見出し</script>】原文',
  ]);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;evil&quot;&gt;/);
  assert.match(html, /次：あなた：&lt;script&gt;next&lt;\/script&gt;/);
  assert.match(html, /【&lt;script&gt;見出し&lt;\/script&gt;】/);
  assert.ok(html.includes('&lt;script&gt;evil&lt;/script&gt;\n' + '長文'.repeat(1000)));
  assert.doesNotMatch(html.replace(/<details class="issue-detail">[\s\S]*?<\/details>/g, ''), /長文/);
  assert.equal(a.context.issuesHtml([]), '<p class="note">なし</p>');
  assert.match(a.context.issuesHtml(['未整理']), /今の問題はありません/);
  assert.match(a.context.issuesHtml([{ text: '済', summary: { title: '済', state: '解決済み', next: '', who: '' } }]), /今の問題はありません/);
});

test('Agy is manually selectable with High fixed, without changing the default Codex selection', () => {
  const a = app(), s = snapshot();
  s.roles.models.codex = ['GPT-6.1-Sol'];
  s.roles.models.agy = ['Gemini 3.1 Pro (High)'];
  s.efforts = ['中', '高', '極高']; s.agyAvailable = true;
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  assert.equal(a.context.chatPick(s.projects[0], s.projects[0].tasks[0]).ai, 'codex');
  const html = a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  assert.match(html, /value="agy\|Gemini 3.1 Pro \(High\)"/);
  assert.doesNotMatch(html, /value="agy\|[^\"]+"[^>]*selected/);
  s.projects[0].tasks[0].owner = 'agy';
  const selected = a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  assert.match(selected, /id="chat-effort"[^>]*disabled/);
  assert.equal(a.context.ownerOf('agy').ic, 'G');
  vm.runInContext('state.agyAvailable = false', a.context);
  assert.match(a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]), /value="agy\|Gemini 3.1 Pro \(High\)"[^>]*disabled/);
});

test('説明・メモは初期状態で閉じ、原文の改行とエスケープを保つ', () => {
  const a = app();
  const p = project(); p.description = '説明1行目\n<b>説明2行目</b>'; p.notes = '代わりのメモ';
  a.context.renderOverview(p);
  assert.ok(notesTag(a));
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  assert.match(a.element('#main').innerHTML, /<summary>説明・メモ<\/summary><p class="desc">説明1行目\n&lt;b&gt;説明2行目&lt;\/b&gt;<\/p>/);
  p.description = '';
  a.context.renderOverview(p);
  assert.match(a.element('#main').innerHTML, /<p class="desc">代わりのメモ<\/p>/);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  p.notes = '';
  a.context.renderOverview(p);
  assert.equal(notesTag(a), undefined);
});

test('説明・メモの開閉を再描画後もプロジェクト別に保持し、開き直すと閉じる', () => {
  const a = app();
  const p = project(); p.notes = 'メモ';
  const q = { ...p, id: 'q' };
  const toggle = a.events.get('toggle');
  toggle(notesToggle('p', true));
  a.context.renderOverview(p);
  assert.match(notesTag(a), /\bopen\b/);
  a.context.renderOverview(q);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', false, false)); // 古いDOMの遅れたイベントは無視
  a.context.renderOverview(p);
  assert.match(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', false));
  a.context.renderOverview(p);
  assert.doesNotMatch(notesTag(a), /\bopen\b/);
  toggle(notesToggle('p', true));
  const fresh = app();
  fresh.context.renderOverview(p);
  assert.doesNotMatch(notesTag(fresh), /\bopen\b/);
});

test('説明・メモを開いても作業の定期更新を続け、入力用の折りたたみは保護する', async () => {
  const a = app();
  const first = snapshot(); first.projects[0].notes = '長いメモ';
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  const opened = notesToggle('p', true);
  a.events.get('toggle')(opened);
  a.details.push(opened.target);
  const next = snapshot('完了'); next.projects[0].notes = '長いメモ';
  a.context.api = async () => next;
  await a.context.pollState();
  assert.match(a.element('#main').innerHTML, /完了した作業（1）/);
  assert.match(notesTag(a), /\bopen\b/);
  const priorHTML = a.element('#main').innerHTML;
  a.details.push({ open: true, classList: { contains: () => false } });
  a.context.api = async () => first;
  await a.context.pollState();
  assert.equal(a.element('#main').innerHTML, priorHTML);
});

test('非表示中の定期取得を止め、復帰時に1回更新する', async () => {
  const a = app();
  let calls = 0;
  a.context.api = async () => { calls++; return snapshot(); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.document.hidden = true;
  await a.context.pollState();
  await a.context.pollSessions();
  assert.equal(calls, 0);
  a.document.hidden = false;
  a.events.get('visibilitychange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('同じ状態は再描画せず、取得中に始めた入力は次回まで保持する', async () => {
  const a = app();
  let resolveFetch;
  let renders = 0;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const same = a.context.pollState();
  resolveFetch(snapshot());
  await same;
  assert.equal(renders, 0);

  const started = a.context.pollState();
  a.document.activeElement = { tagName: 'TEXTAREA', value: 'draft' };
  resolveFetch(snapshot('完了'));
  await started;
  assert.equal(renders, 0);
  assert.equal(a.document.activeElement.value, 'draft');

  a.document.activeElement = null;
  const later = a.context.pollState();
  resolveFetch(snapshot('完了'));
  await later;
  assert.equal(renders, 1);
});

test('重複する定期取得を抑え、明示 load の結果を古い取得で上書きしない', async () => {
  const a = app();
  const pending = [];
  a.context.api = () => new Promise(resolve => pending.push(resolve));
  a.context.render = () => {};
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "project", project: "p", task: null }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  const automatic = a.context.pollState();
  await a.context.pollState();
  assert.equal(pending.length, 1);
  const explicit = a.context.load();
  assert.equal(pending.length, 2);
  pending[1](snapshot('完了'));
  await explicit;
  pending[0](snapshot('未着手'));
  await automatic;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].state', a.context), '完了');
});

test('会話の sessions だけ変わっても composer と stream を作り直さない', async () => {
  const a = app();
  let renders = 0;
  a.context.api = async () => snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  a.context.render = () => { renders++; };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  await a.context.pollState();
  assert.equal(renders, 0);
});

test('端末 pane の起動と選択中作業の外部変更は描画する', async () => {
  const a = app();
  let next = snapshot();
  let renders = 0;
  a.context.api = async () => next;
  a.context.render = () => { renders++; vm.runInContext('renderedMainKey = mainKey()', a.context); };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }; renderedMainKey = mainKey(); renderedTreeKey = treeKey()', a.context);
  a.context.localStorage.getItem = key => key === 'hub-mode' ? 'term' : null;
  vm.runInContext('renderedMainKey = mainKey()', a.context);
  next = snapshot('実行中', [{ project: 'p', task: 't', ai: 'codex', running: true, quiet: 0 }]);
  await a.context.pollState();
  assert.equal(renders, 1);
  next = snapshot('完了', next.sessions);
  await a.context.pollState();
  assert.equal(renders, 2);
});

test('部分応答を連続受信しても作業中タイマーは1本、本文は最新になる', () => {
  const a = app();
  const box = a.element('#msgs');
  const partial = {
    mb: { hidden: true, textContent: '' }, time: { textContent: '' }, last: { textContent: '' },
    querySelector(s) { return s === '.mb' ? this.mb : s === '.wk-time' ? this.time : this.last; },
    remove() { a.elements.delete('#msg-partial'); },
  };
  box.insertAdjacentHTML = () => a.elements.set('#msg-partial', partial);
  const stateEl = a.element('#chat-state');
  Object.defineProperty(stateEl, 'innerHTML', {
    get() { return this.html || ''; },
    set(v) { this.html = v; this.writes = (this.writes || 0) + 1; if (v.includes('chat-elapsed')) a.element('#chat-elapsed'); },
  });
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = { kind: "work", project: "p", task: "t" }', a.context);
  a.context.openChat(project(), project().tasks[0]);
  for (let i = 0; i < 12; i++) a.stream().onmessage({ data: JSON.stringify({ type: 'partial', ai: 'codex', text: `answer ${i}` }) });
  assert.equal(partial.mb.innerHTML, 'answer 11');
  a.stream().onmessage({ data: JSON.stringify({ type:'partial', ai:'codex', text:'<script>bad</script>' }) });
  assert.equal(partial.mb.innerHTML, '&lt;script&gt;bad&lt;/script&gt;');
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 1);
  assert.equal(stateEl.writes, 1);
  a.context.closePanes();
  assert.equal([...a.timers.values()].filter(t => t.ms === 1000).length, 0);
});

test('AI更新カードに現在版・導入方法・2つの操作を表示する', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = { codex: {installed:true,version:"0.159.0",method:"standalone",models:[{id:"gpt-6.1-sol",label:"GPT-6.1-Sol"}]}, claude: {installed:true,version:"2.1.284",method:"homebrew-cask",updating:true,modelRefreshAvailable:false,models:[]} }; renderSettings()', a.context);
  assert.match(a.element('#main').innerHTML, /AI の更新/);
  const html = a.element('#ai-tools').innerHTML;
  assert.match(html, /Codex/);
  assert.match(html, /0\.159\.0/);
  assert.match(html, /単独インストール/);
  assert.match(html, /2\.1\.284/);
  assert.match(html, /Homebrew/);
  assert.match(html, /更新を確認/);
  assert.doesNotMatch(html, /data-ai-update/);
  assert.match(html, /モデル一覧を再取得/);
  assert.match(html, /GPT-6\.1-Sol/);
  assert.match(html, /gpt-6\.1-sol/);
  assert.match(html, /更新中です/);
  assert.match(html, /再取得にはまだ対応していません/);
});

test('稼働中は確認ボタンを使え、適用だけ理由付きで止める', () => {
  const a = app(), s = snapshot(); s.chatting = [{project:'p',task:'t',ai:'codex'}];
  vm.runInContext('state = '+JSON.stringify(s)+'; aiTools = {codex:{installed:true,updateCheck:{ok:true,available:true,applicable:true,latestVersion:"0.160.0",checkedAt:"2026-10-05T00:00:00Z"}}}; drawAiTools()',a.context);
  const html = a.element('#ai-tools').innerHTML;
  assert.match(html,/data-ai-check="codex" >更新を確認/);
  assert.match(html,/data-ai-update="codex" disabled/);
  assert.match(html,/適用は動いている AI 1 件/);
});

test('CLI 更新だけ成功した時はモデル一覧の失敗理由を残す', () => {
  const a = app();
  const message = a.context.aiToolResultText('update', { beforeVersion: '2.1.283', afterVersion: '2.1.284', changed: true, models: { ok: false, error: '一覧の取得方法がありません' } });
  assert.match(message, /2\.1\.283 → 2\.1\.284/);
  assert.match(message, /一覧の取得方法がありません/);
  assert.doesNotMatch(a.context.aiToolResultText('update', { changed: false, beforeVersion: '', afterVersion: '', verified: false, verifyError: '版コマンドが失敗' }), /最新/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 0, source: 'claude-cache', unchanged: true, warning: '前回と同じ内容です' }), /前回の内容/);
  assert.match(a.context.aiToolResultText('models', { ok: true, added: 1, source: 'claude-cache', unchanged: false }), /再取得しました（追加 1 件）/);
});

test('別画面で始まった更新の終了を確認し、モデルを読み直して監視を止める', async () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  let checks = 0, stateReads = 0;
  a.context.api = async route => {
    if (route === '/api/ai-tools') return { tools: { codex: { installed: true }, claude: { installed: true } }, operation: ++checks === 1 ? { ai: 'codex', kind: 'update' } : null };
    if (route === '/api/state') { stateReads++; return fresh; }
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}', a.context);
  await a.context.loadAiTools();
  const [watchId, watch] = [...a.timeouts.entries()].find(([, t]) => t.ms === 3000) || [];
  assert.ok(watch);
  a.timeouts.delete(watchId);
  watch.cb();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(stateReads, 1);
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.equal([...a.timeouts.values()].filter(t => t.ms === 3000).length, 0);
});

test('AI更新後は新しいモデルを取り込み、保存前の役割編集を維持する', async () => {
  const a = app();
  const calls = [];
  const fresh = snapshot();
  fresh.roles.models.codex = ['6sol', 'GPT-6.1-Sol'];
  a.context.api = async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/ai-tools/update') return { ok: true, ai: 'codex', beforeVersion: '0.157.1', afterVersion: '0.159.0', changed: true, models: { ok: true, added: ['GPT-6.1-Sol'] } };
    if (route === '/api/state') return fresh;
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: { version: '0.159.0', method: 'standalone', models: [{ id: 'gpt-6.1-sol' }] }, claude: {} } };
    throw Error(route);
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; rolesDraft = [{name:"Coding",main:{ai:"codex",model:"6sol",effort:"高"},backup:{ai:"人",model:"",effort:""}}]; aiTools = {codex:{version:"0.157.1"},claude:{}}', a.context);
  vm.runInContext('aiTools.codex.updateCheck = {available:true,ok:true}', a.context);
  await a.context.runAiTool('codex', 'update');
  assert.equal(calls[0][0], '/api/ai-tools/update');
  assert.equal(calls[0][1].ai, 'codex');
  assert.equal(vm.runInContext('rolesDraft[0].main.model', a.context), '6sol');
  assert.equal(vm.runInContext('state.roles.models.codex.includes("GPT-6.1-Sol")', a.context), true);
  assert.match(a.element('#model-catalog').textContent, /GPT-6\.1-Sol/);
  assert.match(a.element('#ai-tools').innerHTML, /0\.157\.1 → 0\.159\.0/);
});

test('設定にAIアカウントとCodex加速の操作・注意を同時に表示する', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p"}', a.context);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /<h2>AIアカウント<\/h2><div id="ai-accounts"/);
  assert.match(html, /<h2>Codex の加速（Fast）<\/h2>/);
  assert.match(html, /class="danger"><strong>速度約1\.5倍・利用枠の消耗2\.5倍/);
  assert.match(a.element('#ai-accounts').innerHTML, /data-account-action="add"/);
});

test('加速の初期OFFと保存済ONを表示し、保存中は無効・二重送信しない', async () => {
  const a = app(), input = a.element('#codex-fast');
  vm.runInContext('state = ' + JSON.stringify(snapshot()), a.context);
  a.context.renderAcceleration({ codexAllowed: false });
  assert.match(a.element('#acceleration').innerHTML, />OFF</);
  a.context.renderAcceleration({ codexAllowed: true });
  assert.match(a.element('#acceleration').innerHTML, /checked/);
  assert.match(a.element('#acceleration').innerHTML, />ON</);
  input.dataset.saved = 'false'; input.checked = true;
  let resolve, count = 0;
  a.context.api = async (route, body) => {
    assert.equal(route, '/api/acceleration'); assert.equal(body.codexAllowed, true); count++;
    return new Promise(r => { resolve = r; });
  };
  const saving = a.context.saveCodexFast(input);
  assert.equal(input.disabled, true);
  await a.context.saveCodexFast(input);
  assert.equal(count, 1);
  resolve({ codexAllowed: true }); await saving;
  assert.equal(input.disabled, false); assert.equal(input.dataset.saved, 'true');
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
});

test('加速OFFへの保存失敗はONへ戻し、古い読込応答で切替を上書きしない', async () => {
  const a = app(), input = a.element('#codex-fast');
  vm.runInContext('state = ' + JSON.stringify(snapshot()), a.context);
  input.dataset.saved = 'true'; input.checked = false;
  a.context.api = async () => { throw Error('fixture failure'); };
  await a.context.saveCodexFast(input);
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
  assert.match(a.element('#toast').textContent, /保存できませんでした/);
  let resolveLoad;
  a.context.api = route => route === '/api/cli-models' ? new Promise(r => { resolveLoad = r; }) : Promise.resolve({ codexAllowed: true });
  const loading = a.context.loadCliModels();
  input.checked = true; await a.context.saveCodexFast(input);
  const before = a.element('#acceleration').innerHTML;
  resolveLoad({ claude: [], codex: [], hints: { claude: [], codex: [] }, acceleration: { codexAllowed: false } });
  await loading;
  assert.equal(a.element('#acceleration').innerHTML, before);
  assert.equal(a.element('#codex-fast-state').textContent, 'ON');
});

test('加速設定の読込失敗ではOFFに見せず、読み込めない理由を表示する', async () => {
  const a = app();
  a.context.api = async () => { throw Error('fixture failure'); };
  await a.context.loadCliModels();
  assert.match(a.element('#acceleration').textContent, /読み込めませんでした/);
});

for (const mode of ['chat', 'term']) for (const wanted of [true, false]) {
  for (const failure of [false, true]) for (const taskOn of [true, false]) {
    test(`permission save after navigating to ${mode} synchronizes Fast (${wanted}, failure=${failure}, task=${taskOn}) without losing drafts or ETags`, async () => {
      const a = app(), data = snapshot('未着手'), input = a.element('#codex-fast');
      data.acceleration = { codexAllowed: !wanted };
      data.projects[0].tasks[0].codexFast = taskOn;
      vm.runInContext('state=' + JSON.stringify(data) + ';view={kind:"settings",project:"p"};stateTag="initial";chatDraft.keep="入力中"', a.context);
      input.dataset.saved = String(!wanted); input.checked = wanted;
      const box = a.element(mode === 'chat' ? '#chat-fast-box' : '#term-fast-box');
      box.dataset = { p: 'p', t: 't' };
      let picker = null;
      Object.defineProperty(box, 'innerHTML', {
        get() { return this.html || ''; },
        set(html) {
          this.html = html; picker = null;
          if (!html) return;
          const classes = new Set(html.match(/class="([^"]+)"/)[1].split(' '));
          const span = { textContent: taskOn ? '加速ON（Fast）' : '加速（Fast）' };
          const label = { hidden: false, classList: {
            toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
            contains(name) { return classes.has(name); },
          }, querySelector: () => span };
          picker = { dataset: { p: 'p', t: 't' }, checked: /\bchecked\b/.test(html),
            disabled: /\bdisabled\b/.test(html), closest: () => label };
        },
      });
      box.querySelector = () => picker;
      const query = a.document.querySelector;
      let navigated = false;
      a.document.querySelector = sel => sel === '#codex-fast' && navigated ? null
        : sel === '#chat-fast-box' ? (mode === 'chat' && navigated ? box : null) : query(sel);
      a.document.querySelectorAll = sel => sel === '[data-task-fast]' ? (picker ? [picker] : [])
        : sel === '[data-term-fast-box]' && mode === 'term' && navigated ? [box] : [];
      a.element('#chat-ai').value = 'codex|GPT-6.1-Sol';
      let finishSave;
      const held = [], tags = [];
      const response = (body, tag = 'discarded', ok = true) => ({ status: ok ? 200 : 500, ok,
        json: async () => JSON.parse(JSON.stringify(body)), headers: { get: () => tag } });
      a.context.fetch = (route, opt = {}) => {
        if (route === '/api/acceleration') {
          assert.equal(JSON.parse(opt.body).codexAllowed, wanted);
          return new Promise(resolve => { finishSave = () => resolve(response(
            failure ? { error: 'fixture failure' } : { codexAllowed: wanted }, '', !failure)); });
        }
        assert.equal(route, '/api/state'); tags.push(opt.headers?.['If-None-Match']);
        return new Promise(resolve => held.push(() => resolve(response(data))));
      };
      a.context.render = () => { throw Error('must not redraw the work screen'); };
      const saving = a.context.saveCodexFast(input);
      navigated = true;
      vm.runInContext('view={kind:"work",project:"p",task:"t"}', a.context);
      box.innerHTML = a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex');
      const main = a.element('#main'), draft = a.element('#chat-in');
      main.innerHTML = 'work DOM'; draft.value = 'まだ送っていない文章';
      const during = a.context.refreshTree(); held.shift()(); await during;
      const after = a.context.refreshTree();
      await a.context.startAI('p', 't', 'codex'); // 保存中は起動要求を出さない
      assert.equal(vm.runInContext('accelerationSaving', a.context), true);
      finishSave(); await saving;
      held.shift()(); await after;
      const confirmed = failure ? !wanted : wanted;
      assert.equal(vm.runInContext('state.acceleration.codexAllowed', a.context), confirmed);
      assert.equal(!!picker && !picker.closest().hidden, confirmed);
      if (picker) {
        assert.equal(picker.checked, taskOn); assert.equal(picker.disabled, false);
        assert.equal(picker.closest().classList.contains('danger'), taskOn);
        assert.equal(picker.closest().querySelector().textContent, taskOn ? '加速ON（Fast）' : '加速（Fast）');
      }
      assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), taskOn);
      assert.equal(vm.runInContext('accelerationSaving', a.context), false);
      assert.equal(input.disabled, false); assert.equal(input.checked, confirmed);
      assert.equal(vm.runInContext('stateTag', a.context), 'initial');
      assert.deepEqual(tags, ['initial', 'initial']);
      assert.equal(a.element('#main'), main); assert.equal(main.innerHTML, 'work DOM');
      assert.equal(a.element('#chat-in'), draft); assert.equal(draft.value, 'まだ送っていない文章');
      assert.equal(vm.runInContext('chatDraft.keep', a.context), '入力中');
      if (failure) assert.match(a.element('#toast').textContent, /fixture failure/);
    });
  }
}

test('設定タブは表示だけ切り替え、役割とCLI下書きを保持して選択を保存する', () => {
  const a = app(), data = snapshot(), storage = new Map();
  data.roles.roles = [{ name: 'test', main: { ai: 'codex', model: 'draft', effort: '高' }, backup: { ai: '人' } }];
  vm.runInContext('state = ' + JSON.stringify(data) + '; rolesDraft = JSON.parse(JSON.stringify(state.roles.roles)); rolesDraft[0].main.model = "changed"', a.context);
  a.context.localStorage.setItem = (k, v) => storage.set(k, v);
  const tabs = ['basic', 'ai', 'connect', 'manage'].map(key => ({ ...a.element('#tab-' + key), dataset: { settingsTab: key } }));
  const cards = ['basic', 'ai', 'connect', 'manage'].map(key => ({ dataset: { tab: key }, hidden: false }));
  a.document.querySelectorAll = selector => selector === '[data-settings-tab]' ? tabs : selector === '.settings > [data-tab]' ? cards : [];
  a.element('#main').innerHTML = 'same DOM'; a.element('#cli-draft').value = 'unfinished';
  a.context.selectSettingsTab('ai');
  assert.deepEqual(cards.map(c => c.hidden), [true, false, true, true]);
  assert.equal(tabs[1].attributes['aria-label'], 'AI 未保存あり');
  assert.equal(tabs[1].attributes['aria-selected'], 'true');
  assert.equal(storage.get('hub.settingsTab'), 'ai');
  a.context.selectSettingsTab('connect'); a.context.selectSettingsTab('ai');
  assert.equal(a.element('#main').innerHTML, 'same DOM'); assert.equal(a.element('#cli-draft').value, 'unfinished');
  assert.equal(vm.runInContext('rolesDraft[0].main.model', a.context), 'changed');
  a.context.selectSettingsTab('invalid'); assert.equal(storage.get('hub.settingsTab'), 'basic');
});
test('作業別Fastは許可とCodex選択で表示し、保存の連打・古い一覧を防ぐ', async () => {
  const a = app(), data = snapshot(); data.acceleration = { codexAllowed: true };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  assert.match(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), /data-task-fast/);
  assert.equal(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'claude'), '');
  vm.runInContext('state.acceleration.codexAllowed = false', a.context);
  assert.equal(a.context.taskFastSelect(data.projects[0], data.projects[0].tasks[0], 'codex'), '');
  vm.runInContext('state.acceleration.codexAllowed = true', a.context);
  const input = a.element('#task-fast'); input.dataset = { p: 'p', t: 't' }; input.checked = true;
  let resolve, count = 0; a.context.api = (url, body) => {
    assert.equal(url, '/api/acceleration/task'); assert.equal(body.on, true); count++;
    return new Promise(r => { resolve = r; });
  };
  const saving = a.context.saveTaskFast(input);
  assert.equal(input.disabled, true); await a.context.saveTaskFast(input); assert.equal(count, 1);
  await a.context.startAI('p', 't', 'codex');
  await a.context.act({ dataset: { act: 'handoff', p: 'p', t: 't', from: 'claude', to: 'codex' } });
  assert.equal(count, 1, 'launches wait for the saved Fast choice');
  let slowState; a.context.fetchState = () => new Promise(r => { slowState = r; });
  const refreshing = a.context.refreshTree();
  resolve({ codexFast: true }); await saving;
  slowState(data); await refreshing;
  assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), true);
  assert.equal(input.disabled, false);
  input.checked = false; a.context.api = async () => { throw Error('fixture save failure'); };
  await a.context.saveTaskFast(input);
  assert.equal(input.checked, true); assert.equal(vm.runInContext('state.projects[0].tasks[0].codexFast', a.context), true);
});

test('CLI名の再読込中に書き足した下書きを保持する', async () => {
  const a = app();
  const box = a.element('#climodels');
  let current = [{ dataset: { ai: 'codex', name: '6sol' }, value: '元の値' }];
  a.document.querySelectorAll = selector => selector === 'input.cm' ? current : [];
  Object.defineProperty(box, 'innerHTML', {
    get() { return this.html || ''; },
    set(value) { this.html = value; current = [{ dataset: { ai: 'codex', name: '6sol' }, value: 'サーバーの値' }]; },
  });
  let resolveFetch;
  a.context.api = () => new Promise(resolve => { resolveFetch = resolve; });
  const loading = a.context.loadCliModels(true);
  current[0].value = '取得中に入力した値';
  resolveFetch({ claude: [], codex: [{ name: '6sol', flag: 'サーバーの値' }], hints: { claude: [], codex: [] } });
  await loading;
  assert.equal(current[0].value, '取得中に入力した値');
});

test('利用できなくなった既存モデルを明示し、新しい候補へ選び直せる', () => {
  const a = app();
  const fresh = snapshot(); fresh.roles.models.codex = ['GPT-6.1-Sol'];
  fresh.projects[0].tasks[0].model = '旧モデル';
  a.context.localStorage.getItem = key => key.startsWith('hub-chat-') ? JSON.stringify({ ai: 'codex', model: '旧モデル', effort: '高' }) : null;
  vm.runInContext('state = ' + JSON.stringify(fresh), a.context);
  const p = fresh.projects[0], t = p.tasks[0];
  const work = a.context.specSelect(p, t, 'codex', false);
  const chat = a.context.chatHtml(p, t);
  assert.match(work, /旧モデル（現在の指定・利用不可）/);
  assert.match(work, /GPT-6\.1-Sol/);
  assert.match(chat, /旧モデル（利用できません。選び直してください）/);
  assert.match(chat, /GPT-6\.1-Sol/);
});

test('モデルだけの再取得と、段階・理由を含む失敗を表示する', async () => {
  const a = app();
  const calls = [];
  a.context.api = async route => {
    calls.push(route);
    if (route === '/api/ai-tools/models/refresh') return { ok: true, ai: 'codex', added: 1 };
    if (route === '/api/state') return snapshot();
    if (route === '/api/cli-models') return { claude: [], codex: [], hints: { claude: [], codex: [] } };
    if (route === '/api/ai-tools') return { tools: { codex: {}, claude: {} } };
    const error = new Error('更新できません'); error.stage = 'install'; error.reason = 'CLI が実行中'; throw error;
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p",task:null}; aiTools = {codex:{},claude:{}}', a.context);
  await a.context.runAiTool('codex', 'models');
  assert.equal(calls[0], '/api/ai-tools/models/refresh');
  assert.match(a.element('#ai-tools').innerHTML, /追加 1 件/);
  vm.runInContext('aiTools.claude.updateCheck = {available:true,ok:true}', a.context);
  await a.context.runAiTool('claude', 'update');
  assert.match(a.element('#ai-tools').innerHTML, /CLI が実行中/);
  assert.match(a.element('#ai-tools').innerHTML, /段階：install/);
});


test('除外中は取り込みと予告を隠し、戻す操作と保管中表示を出す', () => {
  const a = app();
  let previews = 0;
  a.context.loadPreview = () => { previews++; };
  const render = excluded => {
    const data = snapshot('完了');
    Object.assign(data.projects[0].tasks[0], { copy: true, mergeExcluded: excluded });
    vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    return a.element('#main').innerHTML;
  };
  const included = render(false);
  assert.match(included, /data-act="merge"/);
  assert.match(included, /取り込み対象から外す/);
  assert.equal(previews, 1);
  const excluded = render(true);
  assert.doesNotMatch(excluded, /data-act="merge"|data-act="mergeexclude"/);
  assert.match(excluded, /取り込み対象外（コピー保管中）/);
  assert.match(excluded, /data-act="mergeinclude"/);
  assert.equal(previews, 1);
  render(false);
  assert.equal(previews, 2);
});

test('除外確認のキャンセルは変更せず、確定と再登録は明示booleanを送る', async () => {
  const a = app();
  const calls = [], messages = [];
  a.context.api = async (route, body) => { calls.push([route, body]); return { ok: true }; };
  a.context.load = async () => {};
  a.context.toast = message => messages.push(message);
  let confirmText = '';
  a.context.confirm = text => { confirmText = text; return false; };
  const el = { dataset: { act: 'mergeexclude', p: 'p', t: 't' }, disabled: false };
  await a.context.act(el);
  assert.equal(calls.length, 0);
  assert.match(confirmText, /本体に取り込まず/);
  assert.match(confirmText, /作業用コピーとファイルは残り/);
  assert.match(confirmText, /取り込み対象に戻す/);
  assert.equal(el.disabled, false);
  a.context.confirm = () => true;
  await a.context.act(el);
  assert.equal(calls[0][0], '/api/task/merge-exclusion');
  assert.equal(calls[0][1].excluded, true);
  assert.match(messages[0], /作業用コピーは残して/);
  a.context.confirm = () => { throw Error('再登録では確認不要'); };
  await a.context.act({ dataset: { act: 'mergeinclude', p: 'p', t: 't' } });
  assert.equal(calls[1][1].excluded, false);
  assert.match(messages[1], /取り込み対象に戻しました/);
});

test('保存のない始める欄はSol・高、前回選択とローカル下書きは初期値より優先する', () => {
  const a = app(), data = snapshot(), saved = { ai: 'claude', model: 'Fable 5.1', effort: '極高' };
  data.roles.models = { codex: ['Astra', 'GPT-6.1-Sol'], 'claude-code': ['Fable 5.1'] };
  data.efforts = ['中', '高', '極高'];
  data.hiddenModels = { codex: ['GPT-6.1-Sol'] };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  const fresh = a.context.quickDraft({ id: 'fresh' });
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), { text: '', images: [], ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  const html = a.context.quickControls({ id: 'fresh' });
  assert.match(html, /value="codex" selected/);
  assert.match(html, /<option selected>GPT-6.1-Sol<\/option>/);
  assert.match(html, /<option selected>高<\/option>/);
  const prior = a.context.quickDraft({ id: 'prior', startSpec: saved });
  assert.equal(prior.ai, 'claude'); assert.equal(prior.model, 'Fable 5.1'); assert.equal(prior.effort, '極高');
  a.context.localStorage.getItem = key => key === 'hub-start-local' ? JSON.stringify({ text: '保存した依頼', ai: 'agy', model: 'Gemini 3.1 Pro (High)', effort: '高', images: [] }) : null;
  const local = a.context.quickDraft({ id: 'local', startSpec: saved });
  assert.equal(local.ai, 'agy'); assert.equal(local.text, '保存した依頼');
  const roleTask = { ...data.projects[0].tasks[0], owner: 'claude-code', role: '司令塔' };
  vm.runInContext('state.roles.roles = [{name:"司令塔",main:{ai:"claude-code",model:"Fable 5.1",effort:"極高"},backup:{ai:"codex",model:"Astra",effort:"極高"}}]', a.context);
  assert.deepEqual(JSON.parse(JSON.stringify(a.context.chatPick(data.projects[0], roleTask))), saved);
  a.context.localStorage.getItem = key => key === 'hub-chat-p/t' ? JSON.stringify({ ai: 'codex', model: 'Astra', effort: '中' }) : null;
  assert.equal(a.context.chatPick(data.projects[0], roleTask).model, 'Astra');
});

test('新規プロジェクトの最初の依頼も設定したAIで送り、作業の選択を会話欄へ引き継ぐ', async () => {
  const a = app(), calls = [], fields = new Map([['name', '見本'], ['firstTask', '最初の依頼']]);
  const configured = snapshot(); configured.initialPick = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(configured), a.context);
  a.context.FormData = class { get(k) { return fields.get(k); } getAll() { return []; } entries() { return fields.entries(); } };
  a.context.api = async (route, body) => { calls.push({ route, body }); return route === '/api/project/new' ? { id: 'p', name: '見本' } : { task: 't' }; };
  a.context.load = async () => {};
  await a.events.get('submit')({ target: { id: 'projform', classList: { contains: () => false } }, preventDefault() {} });
  assert.equal(calls[1].route, '/api/start');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { project: 'p', text: '最初の依頼', ai: 'claude', model: 'Opus 5.5', effort: '中', images: [] });
  const data = snapshot(); data.roles.models.codex = ['Astra', 'GPT-6.1-Sol']; data.efforts = ['中', '高', '極高'];
  data.roles.models['claude-code'] = ['Opus 5.5'];
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  const task = { ...data.projects[0].tasks[0], owner: 'claude-code', model: calls[1].body.model, effort: calls[1].body.effort };
  const html = a.context.chatHtml(data.projects[0], task);
  assert.match(html, /value="claude\|Opus 5.5"[^>]*\bselected\b/);
  assert.match(html, /<option selected>中<\/option>/);
});

test('始める下書きは再描画・切替・再起動で復元し、登録済み担当だけを選べる', () => {
  const a = app(), storage = new Map();
  a.context.localStorage.getItem = k => storage.get(k) || null;
  a.context.localStorage.setItem = (k, v) => storage.set(k, v);
  const data = snapshot(); data.projects[0].tasks.push({ ...data.projects[0].tasks[0], owner: 'discord:しおり' });
  data.roles.agents = ['つむぎ', 'りつ'];
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"project",project:"p"}', a.context);
  assert.equal(vm.runInContext('quickDraft(proj("p")).ai', a.context), 'codex');
  vm.runInContext('Object.assign(quickDraft(proj("p")), {text:"入力した指示",ai:"codex",images:[{id:"image",name:"画像.png",url:"/image"}]}); keepQuick("p"); renderOverview(proj("p"))', a.context);
  assert.match(a.element('#main').innerHTML, /入力した指示/);
  assert.match(a.element('#quick-images').innerHTML, /画像.png/);
  assert.match(a.element('#quick-controls').innerHTML, /Codex|しおり|つむぎ|りつ/);
  vm.runInContext('quickDrafts.clear(); renderOverview(proj("p"))', a.context);
  assert.match(a.element('#main').innerHTML, /入力した指示/);
  assert.equal(vm.runInContext('quickDraft(proj("p")).ai', a.context), 'codex');
  assert.equal(vm.runInContext('quickDraft({id:"other"}).text', a.context), '');
});

test('入力欄へのドロップ・画像貼り付けで本文を保持し、Nativeの非画像は参考資料へ渡す', async () => {
  const a = app(), data = snapshot(), got = [], refs = [];
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"project",project:"p"}; quickDraft(proj("p")).text = "消えない指示"', a.context);
  a.context.addQuickImages = async (p, images, native) => { got.push([p.id, images, native]); };
  a.context.api = async (route, body) => { refs.push([route, body]); return { added: 1 }; };
  a.context.load = async () => {};
  let prevented = 0, stopped = 0;
  const event = { target: { closest: () => ({}) }, preventDefault: () => prevented++, stopPropagation: () => stopped++, dataTransfer: { files: [{name:'drop.png',type:'image/png'}] }, clipboardData: { files: [{name:'paste.png',type:'image/png'}] } };
  a.events.get('drop')(event); a.events.get('paste')(event);
  await a.context.window.hubNativeDrop(['/tmp/native.heic', '/tmp/reference']);
  assert.equal(prevented, 2); assert.equal(stopped, 2); assert.equal(got.length, 3);
  assert.equal(got[2][2], true); assert.deepEqual([...refs[0][1].paths], ['/tmp/reference']);
  assert.equal(vm.runInContext('quickDraft(proj("p")).text', a.context), '消えない指示');
});

function conversationApp() {
  const a = app(), data = snapshot();
  vm.runInContext('state = ' + JSON.stringify(data) + '; view = {kind:"work",project:"p",task:"t"}', a.context);
  a.element('#chat-ai').value = 'codex|GPT-6.1-Sol';
  a.element('#chat-effort').value = '高';
  a.context.openChat(data.projects[0], data.projects[0].tasks[0]);
  return a;
}
const attached = (id = 'first') => ({ id, name: id + '.png', url: '/api/start/image?id=' + id, path: '/local/' + id + '.png' });

test('会話の画像ドロップとMac貼り付けは本文を保ち、サムネイルと×を表示する', async () => {
  const a = conversationApp();
  a.element('#chat-in').value = '消さない本文';
  a.context.fetch = async () => ({ ok: true, json: async () => attached() });
  a.context.api = async route => { assert.equal(route, '/api/start/image-path'); return attached('native'); };
  await a.context.sendFiles([{name:'first.png',type:'image/png'}], 'codex');
  await a.context.window.hubNativeDrop(['/local/native.png']);
  assert.equal(a.element('#chat-in').value, '消さない本文');
  assert.match(a.element('#chat-images').innerHTML, /<img src=.*first/);
  assert.match(a.element('#chat-images').innerHTML, /data-chat-remove="native"/);
  a.element('#chat-images').handlers.click({ target: { closest: () => ({ dataset: { chatRemove: 'first' } }) } });
  assert.doesNotMatch(a.element('#chat-images').innerHTML, /first/);
  assert.equal(a.context.chatSendText('指示', a.context.chatImages('p','t')), '指示\n\n参照画像（絶対パス）：\n/local/native.png');
});

test('会話の添付は同名の作業でもプロジェクト別に分かれ、切替と再描画で保持する', () => {
  const a = conversationApp();
  a.context.chatImages('p','t').push(attached());
  a.context.chatImages('q','t').push(attached('other'));
  const p = project(), q = {...p, id:'q'};
  assert.match(a.context.chatHtml(p,p.tasks[0]), /first.png/);
  assert.doesNotMatch(a.context.chatHtml(p,p.tasks[0]), /other.png/);
  assert.match(a.context.chatHtml(q,q.tasks[0]), /other.png/);
  assert.match(a.context.chatHtml(p,p.tasks[0]), /first.png/);
});

test('画像の一部失敗・画面切替中でも成功分を元の会話へ残し、非画像は本文へ入れる', async () => {
  const a = conversationApp(), targets = [];
  a.element('#chat-in').value = '本文';
  a.context.fetch = async url => {
    targets.push(String(url));
    if (String(url).includes('bad.png')) return {ok:false,json:async()=>({error:'保存失敗'})};
    if (String(url).includes('note.txt')) return {ok:true,json:async()=>({path:'/local/note.txt'})};
    vm.runInContext('view = {kind:"work",project:"q",task:"t"}', a.context);
    return {ok:true,json:async()=>attached()};
  };
  vm.runInContext('chatDraft[chatAttachmentKey("p","t")] = "本文"', a.context);
  await a.context.sendFiles([{name:'bad.png',type:'image/png'},{name:'first.png',type:'image/png'},{name:'note.txt',type:'text/plain'}], '');
  assert.equal(a.context.chatImages('p','t').length, 1);
  assert.equal(a.context.chatImages('q','t').length, 0);
  assert.equal(vm.runInContext('chatDraft[chatAttachmentKey("p","t")]',a.context), '本文\n/local/note.txt\n');
  assert.equal(a.element('#chat-in').value, '本文', '切替先の入力を変えない');
  assert.ok(targets.every(x=> x.includes('project=p')));
});

test('送信失敗なら本文と画像を保持し、画像だけでも送信、成功した分だけを消す', async () => {
  const a = conversationApp();
  a.context.chatImages('p','t').push(attached());
  a.element('#chat-in').value = '依頼';
  a.context.api = async () => { throw Error('送信失敗'); };
  const submit = () => a.element('#composer').handlers.submit({preventDefault(){}});
  submit(); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '依頼');
  assert.equal(a.context.chatImages('p','t').length, 1);
  let finish, request;
  a.context.api = async (route, body) => { request = body; return new Promise(resolve=>finish=resolve); };
  a.element('#chat-in').value = '';
  submit();
  assert.match(request.text, /添付画像を確認してください/);
  assert.match(request.text, /first.png/);
  a.context.chatImages('p','t').push(attached('later'));
  a.element('#chat-in').value = '次の依頼';
  a.element('#chat-in').handlers.input();
  finish({queued:true,queue:1}); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '次の依頼');
  assert.deepEqual(Array.from(a.context.chatImages('p','t'),x=>x.id), ['later']);
});

test('画像追加中の送信を待ち、完了後に画像付きで送れる', async () => {
  const a = conversationApp(); let finish, calls = 0;
  a.element('#chat-in').value = '依頼';
  a.context.fetch = () => new Promise(resolve=>finish=resolve);
  const pending = a.context.addChatImage('p','t',{name:'first.png'});
  a.context.api = async () => { calls++; return {queued:true,queue:1}; };
  a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(calls, 0); assert.equal(a.element('#chat-image-state').hidden, false);
  finish({ok:true,json:async()=>attached()}); await pending;
  a.element('#composer').handlers.submit({preventDefault(){}}); await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(a.context.chatImages('p','t').length, 0);
});

test('送信待ちで会話を描き直しても二重送信せず、成功後に表示中の本文と画像を消す', async () => {
  const a = conversationApp(); let finish, calls = 0;
  a.element('#chat-in').value = '送る本文';
  a.context.chatImages('p','t').push(attached());
  a.context.api = async () => { calls++; return new Promise(resolve=>finish=resolve); };
  a.element('#composer').handlers.submit({preventDefault(){}});
  a.context.closePanes();
  a.elements.delete('#chat-in'); a.element('#chat-in').value = '送る本文';
  a.context.openChat(project(),project().tasks[0]);
  a.element('#composer').handlers.submit({preventDefault(){}});
  assert.equal(calls, 1);
  finish({queued:true,queue:1}); await new Promise(setImmediate);
  assert.equal(a.element('#chat-in').value, '');
  assert.equal(a.context.chatImages('p','t').length, 0);
});

test('Macの画像以外はサーバーが受理した場所を本文に追加し、本文を保持する', async () => {
  const a = conversationApp();
  a.element('#chat-in').value = '確認して';
  a.context.api = async (route, body) => {
    assert.equal(route, '/api/task/attach');
    assert.deepEqual(Array.from(body.paths), ['/local/note.txt']);
    return {paths:['/local/note.txt']};
  };
  await a.context.window.hubNativeDrop(['/local/note.txt']);
  assert.equal(a.element('#chat-in').value, '確認して\n/local/note.txt\n');
  assert.equal(a.context.chatImages('p','t').length, 0);
});

test('ターミナルの添付が全件失敗したら成功表示でエラーを消さない', async () => {
  const a = conversationApp(), query = a.document.querySelector;
  a.document.querySelector = s => s === '#chat-in' ? null : query(s);
  a.context.fetch = async () => ({ok:false,json:async()=>({error:'保存失敗'})});
  await a.context.sendFiles([{name:'note.txt',type:'text/plain'}], 'codex');
  assert.match(a.element('#toast').textContent, /保存失敗/);
  assert.doesNotMatch(a.element('#toast').textContent, /0件/);
});

test('作業一覧は4点だけを表示し、AI情報・手順数・種別・作業場所を作業画面に残す', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0], t = p.tasks[0];
  Object.assign(t, { title: '<本作業>', parent: 'parent', kind: 'derived', copy: true, via: 'Discord経由',
    model: 'GPT-6.1-Sol', effort: '高', done: '検証の詳細', steps: [{ text: '確認済み', done: true }, { text: '<次の手順>', done: false }], next: '残りの整理' });
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  const html = a.context.taskRow(p, t, true);
  assert.match(html, /class="trow child /);
  assert.match(html, /<b>&lt;本作業&gt;<\/b>/);
  assert.match(html, /Project・次：&lt;次の手順&gt;/);
  assert.match(html, /data-act="taskcomplete"[^>]*>完了に移す<\/button>/);
  assert.match(html, /data-go="work" data-p="p" data-t="t"[^>]*>作業画面へ<\/button>/);
  assert.equal((html.match(/<button\b/g) || []).length, 2);
  assert.doesNotMatch(html, /class="(?:tw|chip|via|prog|task-context|pend|wq)|task-status|Discord経由|GPT-6\.1-Sol|検証の詳細|作業用コピー|派生元|1 \/ 2/);
  t.steps = []; assert.match(a.context.taskRow(p, t), /次：残りの整理/);
  t.next = ''; assert.match(a.context.taskRow(p, t), /<span>未着手<\/span>/);
  for (const phone of [false, true]) {
    a.context.matchMedia = () => ({ matches: phone });
    t.completionPending = true;
    vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    const work = a.element('#main').innerHTML;
    assert.match(work, /class="task-context small"/);
    assert.match(work, />派生<\/span>/);
    assert.match(work, /作業用コピー/);
    assert.match(work, /class="wq"><span>AI が手順をすべて済にしました/);
    assert.match(work, /やったこと：/);
    assert.match(work, /検証の詳細/);
  }
  assert.match(a.context.chip(p, t), /GPT-6\.1-Sol/);
  assert.match(a.context.progressBar(t), /class="prog /);
});

test('状態札は質問・入力待ち・保存状態・完了確認・稼働の優先順で最大1つ出す', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0];
  const cases = [
    { extra: { question: '<質問>', state: '上限で停止', completionPending: true }, quiet: 61, expected: '返事待ち' },
    { extra: { state: '上限で停止', completionPending: true }, quiet: 61, expected: '入力待ち' },
    { extra: { state: '返事待ち', completionPending: true }, quiet: 0, expected: '返事待ち' },
    { extra: { state: '上限で停止', completionPending: true }, quiet: 0, expected: '上限で停止' },
    { extra: { completionPending: true }, quiet: 0, expected: '完了確認' },
    { extra: {}, quiet: 59, expected: '作業中' },
    { extra: {}, chat: true, expected: '作業中' },
    { extra: { state: '実行中' }, expected: '' },
    { extra: {}, quiet: 61, running: false, expected: '' },
    { extra: {}, quiet: 61, task: 'other', expected: '' },
  ];
  for (const c of cases) {
    const t = { ...p.tasks[0], ...c.extra };
    s.sessions = c.quiet === undefined ? [] : [{ project: 'p', task: c.task || 't', ai: 'codex', running: c.running !== false, quiet: c.quiet }];
    s.chatting = c.chat ? [{ project: 'p', task: 't', ai: 'claude' }] : [];
    vm.runInContext('state = ' + JSON.stringify(s), a.context);
    const html = a.context.taskRow(p, t);
    const badges = [...html.matchAll(/class="pill task-status [^"]+">([^<]+)<\/span>/g)].map(x => x[1]);
    assert.deepEqual(badges, c.expected ? [c.expected] : [], JSON.stringify(c));
    if (t.question) assert.match(html, /あなたへの質問：&lt;質問&gt;/);
    else if (c.expected === '入力待ち') assert.match(html, /Codex が入力を待っています（1分）/);
  }
});

test('一覧の完了確認は行内操作だけで、質問とreplyタブの保護を維持する', () => {
  const a = app(), s = snapshot(), p = s.projects[0], t = p.tasks[0];
  t.completionPending = true; t.done = '一覧には出さない詳細';
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  for (const tab of [undefined, 'done']) {
    const html = a.context.taskRow(p, t, false, tab);
    assert.match(html, /<div class="tact"><button[^>]*data-act="taskcomplete"/);
    assert.match(html, /data-act="taskcontinue"[^>]*>まだ続ける<\/button>/);
    assert.match(html, /task-status needs">完了確認<\/span>/);
    assert.equal((html.match(/<button\b/g) || []).length, 3);
    assert.doesNotMatch(html, /class="pend|class="wq|やったこと|一覧には出さない詳細/);
  }
  for (const pending of [false, true]) {
    t.question = '答えてください'; t.completionPending = pending;
    const html = a.context.taskRow(p, t);
    assert.doesNotMatch(html, /data-act="taskcomplete"|data-act="taskcontinue"/);
    assert.match(html, /task-status needs">返事待ち<\/span>/);
    const reply = a.context.taskRow(p, t, true, 'reply');
    assert.match(reply, /data-act="answered"[^>]*>送らずに消す<\/button>/);
    assert.equal((reply.match(/<button\b/g) || []).length, 2);
    assert.doesNotMatch(reply, /data-act="taskcomplete"|data-act="taskcontinue"/);
  }
  t.question = ''; t.state = '完了'; t.completionPending = false;
  const finished = a.context.taskRow(p, t);
  assert.match(finished, /class="trow  fin"/);
  assert.match(finished, /<span>完了<\/span>/);
  assert.match(finished, /data-act="taskcontinue"[^>]*>再開する<\/button>/);
  assert.doesNotMatch(finished, /data-act="taskcomplete"|task-status/);
});

test('子プロジェクトも名前と操作の2列に載せ、状態・件数・質問を保持する', () => {
  const a = app(), s = snapshot('未着手'), p = s.projects[0];
  const child = project('完了'); child.id = 'child'; child.parent = 'p'; child.name = '<子プロジェクト>';
  child.tasks.push({ ...child.tasks[0], id: 'ask', state: '返事待ち', question: '<選択する>' });
  s.projects.push(child);
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  a.context.renderOverview(p);
  const html = a.element('#main').innerHTML.split('子プロジェクト（1）')[1];
  assert.match(html, /class="task-title"><span class="sdot [^"]+"><\/span><b><button[^>]*>&lt;子プロジェクト&gt;/);
  assert.match(html, /進行中・作業 1 \/ 2/);
  assert.match(html, /質問あり：&lt;選択する&gt;/);
  assert.match(html, /class="tact"><button[^>]*data-go="project" data-p="child"[^>]*>開く<\/button>/);
  assert.doesNotMatch(html, /class="tw"|class="prog"/);
});

test('pending completion remains visible and a completed task does not stamp its phase automatically', () => {
  const a = app(), s = snapshot('完了確認待ち'), p = s.projects[0];
  p.tasks[0].completionPending = true; p.phases = [{name:'Build',state:'進行中'}];
  vm.runInContext('state = ' + JSON.stringify(s), a.context);
  a.context.renderOverview(p);
  assert.match(a.element('#main').innerHTML, /task-status needs">完了確認<\/span>/);
  assert.match(a.element('#main').innerHTML, /まだ続ける/);
  assert.doesNotMatch(a.element('#main').innerHTML, /完了した作業（1）/);
  p.tasks[0].state = '完了'; p.tasks[0].completionPending = false;
  assert.doesNotMatch(a.context.phaseRoad(p, a.context.phaseInfo(p)), /class="stamp"/);
});

test('cancel completion never calls API and approval sends the shown content hash',async()=>{
 const a=app(),s=snapshot('完了確認待ち');s.projects[0].tasks[0].completionHash='shown';
 vm.runInContext('state = '+JSON.stringify(s),a.context);
 let calls=[];a.context.api=async(route,body)=>{calls.push({route,body});return {};};a.context.load=async()=>{};
 a.context.confirm=()=>false;await a.context.act({dataset:{act:'taskcomplete',p:'p',t:'t'}});assert.equal(calls.length,0);
 a.context.confirm=()=>true;await a.context.act({dataset:{act:'taskcomplete',p:'p',t:'t'}});
 assert.equal(calls[0].route,'/api/task/completion');assert.equal(calls[0].body.expectedHash,'shown');assert.equal(calls[0].body.confirm,true);
});


test('通知：返事待ちと完了確認の名前・数を左と上でそろえる', () => {
  const a = app(), s = snapshot(), p = s.projects[0];
  p.tasks[0].completionPending = true; p.tasks[0].parent = '';
  s.unread = [{ project:'p', task:'gone' }];
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  vm.runInContext('open.add("p")',a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent, '返事待ち 0');
  assert.equal(a.element('#turn-done-n').textContent, '完了確認 1');
  const tree = a.element('#list').innerHTML;
  assert.match(tree, />完了確認 1</);
  assert.match(tree, />完了確認</);
  assert.doesNotMatch(tree, />未読/);
  assert.doesNotMatch(tree, />返事待ち/);
  assert.equal(a.context.taskLight(p,p.tasks[0],false,false).tip.includes('返事'),false);
  a.context.renderTurn([{p,t:p.tasks[0]}]);
  assert.match(a.element('#main').innerHTML, /返事待ち（0）/);
  assert.match(a.element('#main').innerHTML, /完了確認（1）/);
});

test('通知：質問と完了報告が重なったら返事待ちに一度だけ数える', () => {
  const a = app(), s = snapshot(), p = s.projects[0];
  p.tasks[0].completionPending = true; p.tasks[0].question = 'どちらにしますか？';
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 1');
  assert.equal(a.element('#turn-done-n').textContent,'完了確認 0');
  assert.match(a.element('#list').innerHTML, />返事待ち 1</);
  assert.doesNotMatch(a.element('#list').innerHTML, />完了確認/);
});

test('通知：未読だけの更新で木も再描画し、完了済みでも読む対象を残す', () => {
  const a = app(), s = snapshot('完了'), p = s.projects[0];
  p.tasks[0].parent = '';
  s.unread = [{project:'p',task:'t'}, {project:'p',task:'gone'}];
  vm.runInContext('state = ' + JSON.stringify(s) + '; open.add("p")', a.context);
  const before = a.context.treeKey();
  const html = a.context.projectNode(p,0);
  assert.match(html, />未読 1</);
  assert.match(a.context.projectNode(p,0), /data-t="t"[^>]*type="button"/);
  a.context.markRead('p','t');
  assert.notEqual(a.context.treeKey(),before);
  assert.doesNotMatch(a.context.projectNode(p,0), />未読/);
  assert.doesNotMatch(a.context.projectNode(p,0), /data-t="t"[^>]*type="button"/);
});

test('通知：上限停止とターミナル入力待ちも返事待ちとして一致する', () => {
  const a = app(), s = snapshot('上限で停止');
  s.projects[0].tasks.push({...s.projects[0].tasks[0],id:'terminal',state:'実行中'});
  s.sessions = [{project:'p',task:'terminal',ai:'claude',running:true,quiet:61}];
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  assert.equal(a.element('#turn-n').textContent,'返事待ち 2');
  assert.equal(a.element('#turn-done-n').textContent,'完了確認 0');
  assert.match(a.element('#list').innerHTML, />返事待ち 2</);
});


test('通知：変化なしの定期取得でも返事待ち・完了確認の文字を保持する', async () => {
  const a = app(), s = snapshot();
  s.projects[0].tasks[0].completionPending = true;
  vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"project",project:"p",task:null}', a.context);
  a.context.render();
  let renders = 0;
  a.context.render = () => { renders++; };
  vm.runInContext('fetchState = async () => null', a.context);
  await a.context.pollState();
  assert.equal(renders, 0);
  assert.equal(a.element('#turn-n').textContent, '返事待ち 0');
  assert.equal(a.element('#turn-done-n').textContent, '完了確認 1');
  assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 0件、完了確認 1件');
});

test('通知：設定・入力・詳しくを開いたまま定期取得しても両方の件数と説明を更新する', async () => {
  for (const held of ['settings', 'input', 'details']) {
    const a = app(), first = snapshot();
    first.projects[0].tasks[0].completionPending = true;
    vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}', a.context);
    a.context.render();
    if (held === 'settings') vm.runInContext('view.kind = "settings"', a.context);
    if (held === 'input') a.document.activeElement = {tagName:'TEXTAREA'};
    if (held === 'details') a.details.push({open:true, classList:{contains:()=>false}});
    const main = a.element('#main').innerHTML;
    let renders = 0;
    a.context.render = () => { renders++; };
    const changed = snapshot();
    // 質問と完了報告が重なっても返事待ちにだけ数える。
    changed.projects[0].tasks[0].completionPending = true;
    changed.projects[0].tasks[0].question = 'どちらにしますか？';
    vm.runInContext('fetchState = async () => (' + JSON.stringify(changed) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#turn-n').textContent, '返事待ち 1', held);
    assert.equal(a.element('#turn-done-n').textContent, '完了確認 0', held);
    assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 1件、完了確認 0件', held);
    vm.runInContext('fetchState = async () => (' + JSON.stringify(snapshot()) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#turn-n').textContent, '返事待ち 0', held);
    assert.equal(a.element('#turn-done-n').textContent, '完了確認 0', held);
    assert.equal(a.element('#turn').attributes['aria-label'], 'あなたの番：返事待ち 0件、完了確認 0件', held);
    assert.equal(renders, 0, held);
    assert.equal(a.element('#main').innerHTML, main, held);
  }
});

test('long task steps have an explicit close control without changing steps or task state',()=>{
 const a=app(),p=project(),s=snapshot();p.tasks[0].steps=Array.from({length:80},(_,i)=>({text:'手順 '+i,done:false}));s.projects=[p];
 vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};stepsOpen=true',a.context);
 a.context.render();assert.match(a.element('#main').innerHTML,/data-steps-close/);
 const details={open:true};a.events.get('click')({target:{closest:selector=>selector==='[data-steps-close]'?{closest:()=>details}:null}});
 assert.equal(details.open,false);assert.equal(vm.runInContext('stepsOpen',a.context),false);
 assert.equal(vm.runInContext('state.projects[0].tasks[0].state',a.context),'実行中');assert.equal(vm.runInContext('state.projects[0].tasks[0].steps.filter(s=>s.done).length',a.context),0);
});

test('質問の一括回答は選択モデルへ1回送信し、会話欄の別の下書きと画像を保つ', async () => {
  const a=app(),s=snapshot();s.roles.models.codex=['GPT-6.1-Sol'];let answerSend,request;
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};chatBusy=null',a.context);
  a.context.bindAskAnswers=(_box,send)=>{answerSend=send;};
  a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='高';a.element('#chat-in').value='別の依頼';
  a.context.chatImages('p','t').push(attached());a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  a.context.api=async (route,body)=>{request={route,body};return {queued:true,queue:1};};
  assert.equal(await answerSend('価格：400円\n\n返金：条件付き'),true);
  assert.equal(request.route,'/api/chat/send');assert.equal(request.body.text,'価格：400円\n\n返金：条件付き');assert.equal(request.body.model,'GPT-6.1-Sol');
  assert.equal(a.element('#chat-in').value,'別の依頼');assert.equal(a.context.chatImages('p','t').length,1);
  a.context.api=async()=>{throw Error('通信失敗');};assert.equal(await answerSend('もう一度'),false);assert.equal(a.element('#chat-in').value,'別の依頼');
});

test('稼働中の質問回答は同じ作業の順番待ちへ送り、使えないモデルなら送らない',async()=>{
  const a=app(),s=snapshot();let send,calls=0,body;
  vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"};chatBusy={ai:"codex"}',a.context);
  a.context.bindAskAnswers=(_box,cb)=>{send=cb;};a.element('#chat-ai').value='claude-code|Fable 5.1';a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  a.context.api=async(_r,b)=>{calls++;body=b;return {queued:true,queue:1};};
  assert.equal(await send('自由回答'),true);assert.equal(body.mode,'queue');assert.equal(body.project,'p');assert.equal(body.task,'t');
  a.element('#chat-ai').selectedOptions=[{disabled:true}];assert.equal(await send('自由回答'),false);assert.equal(calls,1);
});

test('操作案内で存在すると伝える作業ボタンは実際の作業画面にあり、質問中は完了操作を出さない', () => {
  const { guidance } = require('../lib/guidance');
  for (const extra of [
    { completionPending: true }, {}, { question: '判断を待つ', completionPending: true },
    { state: '完了' }, { copy: true }, { copy: true, mergeExcluded: true }, { copyMissing: true },
  ]) {
    const a = app(), s = snapshot(), p = s.projects[0], t = Object.assign(p.tasks[0], extra);
    vm.runInContext('state = ' + JSON.stringify(s) + '; view = {kind:"work",project:"p",task:"t"}; renderWork()', a.context);
    const html = a.element('#main').innerHTML;
    const buttons = [...html.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(x => x[1]);
    const text = guidance(p, t, t);
    for (const line of text.split('\n').filter(line => /^(作業の完了|取り込み)：/.test(line) && line.includes('がある'))) {
      for (const [, label] of line.split('作業一覧')[0].matchAll(/［([^］]+)］/g)) assert.ok(buttons.includes(label), `${JSON.stringify(extra)}: ${label}`);
    }
    const completion = a.context.completionButtons(p, t);
    const line = text.split('\n').find(x => x.startsWith('作業の完了：'));
    for (const label of ['完了に移す', 'まだ続ける', '再開する']) {
      assert.equal(line.includes(`［${label}］`), completion.includes(`>${label}</button>`), `${JSON.stringify(extra)}: ${label}`);
    }
  }
});

test('フェーズ案内のボタンは途中・最終・継続・報告ありの画面条件と一致する', () => {
  const { guidance } = require('../lib/guidance');
  for (const variant of ['途中', '最終', '継続', '未完', '報告', '全フェーズ完了']) {
    const a = app(), p = project(), t = p.tasks[0];
    p.phases = [{ name: '調査', state: '進行中' }, { name: '執筆', state: '未着手' }];
    t.state = '完了'; t.phase = '調査';
    if (variant === '最終') p.phases.pop();
    if (variant === '継続') p.phaseContinueKey = p.phaseOfferKey = 'same';
    if (variant === '未完' || variant === '報告') t.state = '実行中';
    if (variant === '報告') p.phases[0].completionPending = true;
    if (variant === '全フェーズ完了') p.phases.forEach(ph => ph.state = '完了');
    const html = a.context.phaseRoad(p, a.context.phaseInfo(p));
    const line = guidance(p, t).split('\n').find(x => x.startsWith('フェーズ：'));
    assert.equal(line.includes('がある'), html.includes('data-act="nextphase"'), variant);
    for (const [, label] of line.matchAll(/［([^］]+)］/g)) assert.ok(html.includes(`>${label}</button>`), variant + ': ' + label);
  }
});

test('上下の回答は同じ送信枠を使い、受付までの連打を1回にする',async()=>{
 const a=app(),s=snapshot('返事待ち');s.projects[0].tasks[0].question='選んでください';let lower,finish,calls=0;
 vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);a.context.bindAskAnswers=(_box,send)=>{lower=send;};a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='高';a.element('#chat-in').value='別の下書き';a.context.load=async()=>{};a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
 a.context.api=async(route,body)=>{calls++;assert.equal(route,'/api/chat/send');assert.equal(body.answerQuestion,'選んでください');return new Promise(resolve=>{finish=resolve;});};
 const notices=[];a.context.toast=x=>notices.push(x);a.elements.set('#msg-partial',{querySelector:s=>a.element('partial'+s),remove(){a.elements.delete('#msg-partial');}});
 const upper=vm.runInContext('sendWorkAnswer.send("上からの回答")',a.context);assert.equal(await lower('下からも押した'),false);assert.equal(calls,1);finish({answeredQuestion:'選んでください'});assert.equal(await upper,true,notices.join(" / "));assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(vm.runInContext('state.projects[0].tasks[0].question',a.context),'');
});

// 実サーバーが起動失敗時に配信する SSE と 409 を画面処理へ通す。
test('実spawn失敗のSSE後も上下から再操作でき、fake CLI修復後の再送は1回だけ受け付ける',async()=>{
 const os=require('node:os');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-answer-r1-')),root=path.join(tmp,'root'),dir=path.join(root,'Product','p'),bin=path.join(tmp,'bin');
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.mkdirSync(bin);
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: p\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 const question='選んでください',taskFile=path.join(dir,'.ai/tasks/t.md');fs.writeFileSync(taskFile,`---\nid: t\ntitle: R1\nowner: codex\nmodel: GPT-6.1-Sol\nworkspaceMode: direct\nstate: 返事待ち\nquestion: ${question}\n---\n`);
 require('../lib/chat').append(dir,'t',{role:'assistant',ai:'codex',text:'回答を選んでください',asks:[{question,options:['A','B'],multi:false}]});
 const command=path.join(bin,'codex');fs.writeFileSync(command,'#!/nonexistent/r1-fixture-interpreter\n',{mode:0o755});
 const env={PATH:bin+':/usr/bin:/bin',HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'home'),HUB_TRASH:path.join(tmp,'trash')},previous={};for(const k of Object.keys(env)){previous[k]=process.env[k];process.env[k]=env[k];}
 const serverModule=require.resolve('../server');let server,reader,abort;const events=[];
 try{
  delete require.cache[serverModule];({server}=require('../server'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));process.env.HUB_PORT=String(port);delete require.cache[serverModule];({server}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`;
  const a=app(),s=snapshot('返事待ち');s.projects[0].tasks[0].question=question;vm.runInContext('state='+JSON.stringify(s)+';view={kind:"work",project:"p",task:"t"}',a.context);
  const asks=[{question,options:['A','B'],multi:false}],askKey=JSON.stringify(['p','t',asks]);const set=new Set(['ask']),status={textContent:''},option={disabled:false,value:'A'},free={disabled:false,value:'残す補足'},button={disabled:false,textContent:''};
  const ask={dataset:{askKey},classList:{contains:x=>set.has(x),add:(...xs)=>xs.forEach(x=>set.add(x)),toggle:(x,on)=>on?set.add(x):set.delete(x)},querySelector:s=>s==='.ask-status'?status:button,querySelectorAll:()=>[option,free,button]};
  const rows=[{id:'',contains:x=>x===ask}],box=a.element('#msgs');let historyVisible=true;
  box.querySelectorAll=sel=>sel==='.m'?rows:sel==='.ask'&&historyVisible?[ask]:[];
  Object.defineProperty(box,'innerHTML',{set(html){rows.length=0;historyVisible=html.includes('data-ask-key');if(historyVisible)rows.push({id:'',contains:x=>x===ask},{id:'',contains:()=>false});},get(){return '';}});
  box.insertAdjacentHTML=(_pos,html)=>{if(html.includes('class="m '))rows.push({id:html.includes('id="msg-partial"')?'msg-partial':'',contains:()=>false});};
  a.document.querySelectorAll=sel=>sel==='.ask'?[ask]:[];a.element('#chat-ai').value='codex|GPT-6.1-Sol';a.element('#chat-effort').value='極高';a.element('#chat-in').value='別の下書き';
  a.context.chatImages('p','t').push(attached('r1-retained'));a.context.load=async()=>{};a.context.refreshTree=async()=>{};a.context.toast=()=>{};let lower;a.context.bindAskAnswers=(_box,send)=>{lower=send;};a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
  const installPartial=()=>a.elements.set('#msg-partial',{querySelector:s=>a.element('partial'+s),insertAdjacentHTML:box.insertAdjacentHTML,remove(){a.elements.delete('#msg-partial');}});
  let calls=0,holdResponse;a.context.api=async(route,body)=>{calls++;const res=await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(body)});const result=await res.json();if(holdResponse)await holdResponse;if(!res.ok)throw Error(result.error);return result;};
  abort=new AbortController();const response=await fetch(base+'/api/chat/stream?project=p&task=t',{signal:abort.signal});reader=response.body.getReader();
  let buffer='',idleResolve;const pump=(async()=>{while(true){const part=await reader.read();if(part.done)break;buffer+=Buffer.from(part.value).toString();let end;while((end=buffer.indexOf('\n\n'))!==-1){const chunk=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=chunk.split('\n').find(l=>l.startsWith('data:'));if(!data)continue;const ev=JSON.parse(data.slice(5));events.push(ev);if(ev.type==='rows')continue;if(ev.type==='busy')installPartial();a.stream().onmessage({data:JSON.stringify(ev)});if(ev.type==='idle')idleResolve?.();}}})();pump.catch(()=>{});
  const reenter=async()=>{
   // 実openChatの再入場：空DOMでcontrolsを更新してから、実serverの履歴rowsを受け取る。
   vm.runInContext('view.kind="project"',a.context);rows.length=0;historyVisible=false;
   vm.runInContext('view.kind="work"',a.context);a.context.openChat(s.projects[0],s.projects[0].tasks[0]);
   const attempts=vm.runInContext('askAttempts',a.context);assert.equal(attempts.size,1,'初期rows待ちでは再送対象を消さない');
   const historyAbort=new AbortController(),historyResponse=await fetch(base+'/api/chat/stream?project=p&task=t',{signal:historyAbort.signal}),historyReader=historyResponse.body.getReader();
   try{let data='';while(!data.includes('\n\n')){const part=await historyReader.read();assert.equal(part.done,false);data+=Buffer.from(part.value).toString();}const line=data.split('\n').find(l=>l.startsWith('data:'));const history=JSON.parse(line.slice(5));assert.equal(history.type,'rows');a.stream().onmessage({data:JSON.stringify(history)});}finally{historyAbort.abort();await historyReader.cancel().catch(()=>{});}
  };
  for(const path of ['lower','upper']){
   installPartial();let release;holdResponse=new Promise(r=>release=r);const idle=new Promise(r=>idleResolve=r);const failed=path==='lower'?lower('A\n自由入力：残す補足'):vm.runInContext('sendWorkAnswer.send("上部回答")',a.context);
   await idle;await reenter();assert.equal(button.disabled,true,'再入場しても送信中のlockを保つ');release();assert.equal(await failed,false);holdResponse=null;assert.equal(set.has('done'),false);assert.equal(option.disabled,false);assert.equal(free.disabled,false);assert.equal(button.disabled,false);assert.equal(free.value,'残す補足');assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(a.element('#chat-effort').value,'極高');assert.equal(a.context.chatImages('p','t')[0].id,'r1-retained');
   // 409より後の遅いerror行と、同じ会話の再描画でも復活対象を保つ。
   a.stream().onmessage({data:JSON.stringify({type:'row',row:{role:'assistant',ai:'codex',error:'遅い起動失敗'}})});a.context.refreshAsks(box);assert.equal(button.disabled,false);
   await reenter();
   assert.equal(button.disabled,false);assert.equal(set.has('done'),false);assert.equal(free.value,'残す補足');assert.equal(a.element('#chat-in').value,'別の下書き');assert.equal(a.element('#chat-ai').value,'codex|GPT-6.1-Sol');assert.equal(a.element('#chat-effort').value,'極高');assert.equal(a.context.chatImages('p','t')[0].id,'r1-retained');
  }
  assert.ok(events.some(e=>e.type==='row'&&e.row.role==='user'));assert.ok(events.some(e=>e.type==='busy'));assert.ok(events.some(e=>e.type==='row'&&e.row.error));assert.ok(events.some(e=>e.type==='idle'));assert.match(fs.readFileSync(taskFile,'utf8'),/state: 返事待ち/);
  // fixtureの起動原因を直してから再送。上下の同時操作は1受付。
  fs.writeFileSync(command,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed'}));},2000));\n`,{mode:0o755});installPartial();const before=calls,pending=lower('A\n自由入力：残す補足');assert.equal(await vm.runInContext('sendWorkAnswer.send("二重回答")',a.context),false);assert.equal(await pending,true);assert.equal(calls,before+1);assert.match(fs.readFileSync(taskFile,'utf8'),/question: *\n/);
  // 成功済みは遅い失敗通知で戻らない。
  a.context.refreshAsks(box);assert.equal(button.disabled,true);
  await fetch(base+'/api/chat/stop',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'p',task:'t'})});
 }finally{abort?.abort();await reader?.cancel().catch(()=>{});if(server)await new Promise(r=>server.close(r));for(const k of Object.keys(env)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}}
});

test('GitHub creation appears only without any origin, and unavailable gh has a disabled button and reason', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify({ ...snapshot(), github: { ready: true } }), a.context);
  a.context.renderOverview(project()); assert.match(a.element('#main').innerHTML, /data-github-create="p"/);
  const linked = { ...project(), github: { url: 'https://github.com/u/r', branch: 'main' }, githubHasOrigin: true };
  a.context.renderOverview(linked); assert.match(a.element('#main').innerHTML, />GitHub<\/button>/); assert.doesNotMatch(a.element('#main').innerHTML, /data-github-create/);
  a.context.renderOverview({ ...project(), githubHasOrigin: true }); assert.doesNotMatch(a.element('#main').innerHTML, /data-github-create/);
  vm.runInContext('state.github = {ready:false,error:"ログインしてください"}', a.context);
  a.context.renderOverview(project()); assert.match(a.element('#main').innerHTML, /data-github-create="p"[^>]*disabled[^>]*title="ログインしてください"/);
});
test('settings contains GitHub card after remote and before ChatGPT', () => {
  const a = app(); vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings",project:"p"}', a.context);
  a.context.renderSettings(); const html = a.element('#main').innerHTML;
  assert.ok(html.indexOf('id="remote-box"') < html.indexOf('id="github-box"')); assert.ok(html.indexOf('id="github-box"') < html.indexOf('<h2>ChatGPT</h2>'));
});

test('ChatGPT login settings use the native app and update only status without replacing drafts', () => {
  const a = app('ProjectHubApp/1');
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings"}; rolesDraft = []', a.context);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /href="hubapp:\/\/gpt\?login=1">ChatGPT にログイン/);
  assert.equal(a.context.location.href, 'hubapp://gpt?status=1');
  const status = a.element('#gpt-login-status');
  a.context.window.hubGptLogin(true); assert.equal(status.textContent, 'ログイン済み');
  a.context.window.hubGptLogin(false); assert.equal(status.textContent, 'まだ');
  a.context.window.hubGptLogin('private-data'); assert.equal(status.textContent, 'まだ');
  assert.equal(a.element('#main').innerHTML, html);
  assert.equal(vm.runInContext('rolesDraft.length', a.context), 0);
  a.document.querySelector = () => null;
  assert.doesNotThrow(() => a.context.window.hubGptLogin(true));
});

test('ChatGPT login settings outside the app explain availability without native navigation', () => {
  const a = app();
  vm.runInContext('state = ' + JSON.stringify(snapshot()) + '; view = {kind:"settings"}', a.context);
  a.context.renderSettings();
  assert.match(a.element('#main').innerHTML, /事前ログインはアプリで使えます/);
  assert.doesNotMatch(a.element('#main').innerHTML, /hubapp:\/\/gpt\?login=1|id="gpt-login-status"/);
  assert.equal(a.context.location.href, '');
  a.context.window.hubGptLogin(true);
  assert.equal(a.element('#gpt-login-status').textContent, '');
});

for (const [before, after] of [
  [{ready:false,error:'GitHubのログインを確認中です'}, {ready:true,error:''}],
  [{ready:true,error:''}, {ready:false,error:'ログインしてください'}],
  [{ready:false,error:'確認中'}, {ready:false,error:'ghがありません'}],
]) test(`GitHub readiness/error poll updates the rendered creation button: ${before.error || 'ready'} -> ${after.error || 'ready'}`, async () => {
  const a = app(), first = {...snapshot(),github:before}, next = {...snapshot(),github:after};
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  const beforeHtml = a.element('#main').innerHTML;
  vm.runInContext('fetchState = async () => (' + JSON.stringify(next) + ')', a.context);
  await a.context.pollState();
  const html = a.element('#main').innerHTML;
  assert.notEqual(html, beforeHtml);
  const button = html.match(/<button[^>]*data-github-create="p"[^>]*>/)[0];
  assert.equal(button.includes('disabled'), !after.ready);
  assert.ok(button.includes(after.ready ? '非公開リポジトリを作る' : after.error));
});

test('GitHub polling updates only the status during input and preserves confirmation/settings drafts', async () => {
  const a = app(), first = {...snapshot(),github:{ready:false,error:'確認中'}};
  vm.runInContext('state = ' + JSON.stringify(first) + '; view = {kind:"project",project:"p",task:null}; render()', a.context);
  a.document.activeElement = {tagName:'INPUT'};
  a.element('#github-name').value = 'typed-name'; a.element('#github-description').value = 'typed-description';
  a.element('#github-push').checked = true;
  const main = a.element('#main').innerHTML;
  for (const github of [{ready:true,error:''}, {ready:false,error:'ログイン切れ'}]) {
    vm.runInContext('fetchState = async () => (' + JSON.stringify({...snapshot(),github}) + ')', a.context);
    await a.context.pollState();
    assert.equal(a.element('#main').innerHTML, main);
    assert.equal(a.element('#github-create-status').innerHTML.includes('disabled'), !github.ready);
    assert.equal(a.element('#github-name').value, 'typed-name'); assert.equal(a.element('#github-description').value, 'typed-description');
    assert.equal(a.element('#github-push').checked, true);
  }
  vm.runInContext('view.kind = "settings"; renderSettings()', a.context);
  a.element('#github-account').value = 'second'; a.element('#github-owner').value = 'our-org';
  const settings = a.element('#main').innerHTML;
  vm.runInContext('fetchState = async () => (' + JSON.stringify({...snapshot(),github:{ready:true}}) + ')', a.context);
  await a.context.pollState();
  assert.equal(a.element('#main').innerHTML, settings);
  assert.equal(a.element('#github-account').value, 'second'); assert.equal(a.element('#github-owner').value, 'our-org');
});

test('初期AI設定カードの即保存・失敗戻し・入力優先・利用不可表示', async () => {
  const a = app(), data = snapshot(), calls = [], notices = [], storage = new Map();
  data.roles.models = { codex: ['GPT-6.1-Sol'], 'claude-code': ['Fable 5.1', 'Opus 5.5'] };
  data.efforts = ['中', '高', '極高'];
  data.hiddenModels = { 'claude-code': ['Fable 5.1'] };
  vm.runInContext('state = ' + JSON.stringify(data) + '; view.kind = "settings"', a.context);
  a.context.localStorage.getItem = key => storage.get(key) || null;
  a.context.localStorage.setItem = (key, value) => storage.set(key, value);
  a.context.toast = text => notices.push(text);
  a.context.api = async (route, body) => { calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { initialPick: body }; };
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html, /data-tab="basic"><h2>新しく始めるときのAI/);
  assert.match(html, /data-tab="ai"><h2>選ぶ欄に出すモデル/);
  const card = a.context.initialPickHtml();
  assert.doesNotMatch(card, /Agy|ChatGPT|discord/);
  const fresh = a.context.quickDraft(data.projects[0]); assert.equal(fresh.ai, 'codex');
  a.context.quickDraft({ id: 'typing' }).text = 'まだ保存していない指示';
  const explicit = a.context.quickDraft({ id: 'explicit' }); explicit.effort = '極高';
  storage.set('hub-start-saved', JSON.stringify({ ai: 'agy', model: 'Gemini 3.1 Pro (High)', effort: '高', text: '下書き', images: [] }));
  const saved = a.context.quickDraft({ id: 'saved' });
  const prior = a.context.quickDraft({ id: 'prior', startSpec: { ai: 'codex', model: 'Astra', effort: '極高' } });
  vm.runInContext('state.projects.push({id: "prior", startSpec: {ai: "codex", model: "Astra", effort: "極高"}})', a.context);
  await a.events.get('change')({ target: { dataset: { initial: 'ai' }, value: 'claude' } });
  assert.deepEqual(calls[0], { route: '/api/models/initial', body: { ai: 'claude', model: 'Opus 5.5', effort: '高' } });
  assert.equal(a.context.quickDraft(data.projects[0]).ai, 'claude');
  assert.equal(a.context.quickDraft({ id: 'typing' }).text, 'まだ保存していない指示');
  assert.equal(a.context.quickDraft({ id: 'saved' }), saved);
  assert.equal(a.context.quickDraft({ id: 'explicit' }), explicit);
  // startSpecのある実プロジェクトはキャッシュを保持する。
  data.projects.push({ id: 'prior', startSpec: { ai: 'codex', model: 'Astra', effort: '極高' } });
  vm.runInContext('state.projects.push(' + JSON.stringify(data.projects.at(-1)) + ')', a.context);
  await a.events.get('change')({ target: { dataset: { initial: 'effort' }, value: '中' } });
  assert.equal(a.context.quickDraft(data.projects.at(-1)), prior);
  assert.equal(vm.runInContext("initialPick()", a.context).effort, '中');
  const before = JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context)));
  let release; a.context.api = () => new Promise((resolve, reject) => { release = () => reject(Error('見本の保存失敗')); });
  const saving = a.context.saveInitialPick({ ...before, effort: '極高' });
  assert.match(a.element('#initial-pick').innerHTML, /data-initial="ai"[^>]*disabled/);
  await a.context.saveInitialPick({ ...before, effort: '高' }); // 多重保存なし
  release(); await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context))), before);
  assert.match(notices.at(-1), /見本の保存失敗/);
  vm.runInContext('state.initialPick.model = "<lost>"', a.context);
  assert.match(a.context.initialPickHtml(), /&lt;lost&gt;（利用不可）/);
  assert.match(a.context.initialPickHtml(), /selected disabled/);
  vm.runInContext('state.initialPick.model = "Opus 5.5"; state.initialPickError = "現在の候補から外れています"', a.context);
  assert.match(a.context.initialPickHtml(), /Opus 5.5（利用不可）/);
  a.context.api = async (route, body) => ({ initialPick: body });
  await a.context.saveInitialPick({ ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("initialPick()", a.context))), { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
});

test('子プロジェクトに分けて始める入口も共通の初期AIを使う', async () => {
  const a = app(), data = snapshot(), calls = [];
  data.initialPick = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '中' };
  vm.runInContext('state = ' + JSON.stringify(data), a.context);
  a.element('#split-lines').value = '子の名前｜最初の依頼';
  a.element('#split-lines').focus = () => {};
  a.context.api = async (route, body) => { calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { id: 'child-project' }; };
  a.context.load = async () => {};
  a.context.splitProject(data.projects[0]);
  await a.element('#split-go').onclick();
  assert.equal(calls[0].body.parent, 'p');
  assert.deepEqual(calls[1], { route: '/api/start', body: { project: 'child-project', text: '最初の依頼', ...data.initialPick, images: [] } });
});

test('スマホAI一覧は指定の短い名前、PCは従来名、表示名変更は選択/役割を保持', () => {
  const a = app(), s = snapshot();
  s.roles.models = { 'claude-code': ['Opus 5.5', 'Fable 5.1'], codex: ['GPT-6.1-Sol', 'GPT-6-Astra'], agy: ['Gemini 3.1 Pro (High)'] };
  s.projects[0].tasks[0].model = 'GPT-6.1-Sol'; s.agyAvailable = true;
  vm.runInContext('state=' + JSON.stringify(s), a.context);
  a.context.matchMedia = () => ({ matches: true });
  const html = () => a.context.chatHtml(s.projects[0], s.projects[0].tasks[0]);
  const option = (markup, value) => markup.match(new RegExp('<option value="' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([^<]*)</option>'))[1];
  let h = html();
  for (const [key, text] of [['claude|Opus 5.5', 'Opus 5.5'], ['codex|GPT-6.1-Sol', '6.1-Sol'], ['agy|Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro'], ['chatgpt|app', 'ChatGPT']]) assert.equal(option(h, key), text);
  assert.match(h, /value="codex\|GPT-6.1-Sol"[^>]*selected/);
  const before = vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(state.projects[0],state.projects[0].tasks[0])])', a.context);
  vm.runInContext('state.phoneLabels={labels:"short",names:{"codex|GPT-6.1-Sol":"私のソル","chatgpt|app":"貼る <文>"}}', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), '私のソル'); assert.equal(option(html(), 'chatgpt|app'), '貼る &lt;文&gt;');
  a.context.matchMedia = () => ({ matches: false });
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), 'Codex・GPT-6.1-Sol');
  assert.equal(option(html(), 'chatgpt|app'), 'ChatGPT（アプリで作業。送ると貼る文をコピー）');
  a.context.matchMedia = () => ({ matches: true }); vm.runInContext('state.phoneLabels.labels="full"', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), 'Codex・GPT-6.1-Sol');
  assert.equal(vm.runInContext('JSON.stringify([state.roles,state.cliFlags,state.projects,chatPick(state.projects[0],state.projects[0].tasks[0])])', a.context), before);
  vm.runInContext('state.phoneLabels.labels="short";state.cliFlags.codex={"GPT-6.1-Sol":""}', a.context);
  assert.equal(option(html(), 'codex|GPT-6.1-Sol'), '私のソル（既定）');
  s.projects[0].tasks[0].model = 'GPT-lost'; vm.runInContext('state.projects[0].tasks[0].model="GPT-lost"', a.context);
  assert.equal(option(html(), 'codex|GPT-lost'), 'lost（利用できません。選び直してください）');
});

test('スマホ設定カードの保存/失敗と遅いpoll、他端末更新も入力を作り直さない', async () => {
  const a = app(), s = snapshot(), calls = [];
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  let release; const hold = new Promise(r => { release = r; });
  a.context.api = async (route, spec) => { calls.push({ route, spec: JSON.parse(JSON.stringify(spec)) }); await hold; return { phoneLabels: { labels: 'full', names: {} } }; };
  const saving = a.context.savePhoneLabels({ labels: 'full' });
  assert.match(a.element('#phone-labels').innerHTML, /保存中/);
  assert.equal(calls.length, 1);
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: {} } });
  await a.context.refreshTree(); await a.context.pollState();
  assert.equal(vm.runInContext('phoneLabelsSaving', a.context), true);
  release(); await saving;
  assert.equal(vm.runInContext('state.phoneLabels.labels', a.context), 'full');
  assert.match(a.element('#phone-labels').innerHTML, /data-phone-name="codex\|GPT-6.1-Sol"[^>]*disabled/);
  a.context.api = async () => { throw Error('見本の保存失敗'); };
  await a.context.savePhoneLabels({ labels: 'short' });
  assert.equal(vm.runInContext('state.phoneLabels.labels', a.context), 'full'); assert.match(a.element('#phone-labels').innerHTML, /見本の保存失敗/);
  // 設定を入力中に別の端末から更新されても、編集中のカードを描き直さない。
  const input = {}; a.document.activeElement = input; a.element('#phone-labels').contains = el => el === input;
  const previousHtml = a.element('#phone-labels').innerHTML;
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': 'ソル' } } });
  await a.context.pollState(); assert.equal(a.element('#phone-labels').innerHTML, previousHtml);
  a.document.activeElement = null; await a.context.pollState(); assert.match(a.element('#phone-labels').innerHTML, /value="ソル"/);
  // 会話の定期更新ではoptionの文字だけを変え、入力・選択・思考を維持。
  const option = { value: 'codex|GPT-6.1-Sol', dataset: { full: 'Codex・GPT-6.1-Sol', short: '6.1-Sol', phoneSuffix: '' }, textContent: '6.1-Sol' };
  a.element('#chat-ai').options = [option]; a.element('#chat-ai').value = option.value;
  a.element('#chat-in').value = '書きかけ'; a.element('#chat-effort').value = '極高'; a.context.matchMedia = () => ({ matches: true });
  vm.runInContext('view={kind:"work",project:"p",task:"t"};renderedMainKey=mainKey()', a.context);
  let renders = 0; a.context.render = () => { renders++; }; a.context.renderTree = () => {};
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '速いソル' } } });
  await a.context.pollState(); assert.equal(option.textContent, '速いソル'); assert.equal(renders, 0);
  assert.equal(a.element('#chat-ai').value, option.value); assert.equal(a.element('#chat-in').value, '書きかけ'); assert.equal(a.element('#chat-effort').value, '極高');
});

// 保存のたびにカードを置換していないことと、移動先のフォーカスを検証するDOM。
function phoneCard(a, s) {
  const box = a.element('#phone-labels'), keys = [...a.context.orderedModels(), 'chatgpt|app'];
  const inputs = keys.map(key => ({ dataset: { phoneName: key }, value: s.phoneLabels.names[key] || '', disabled: false }));
  const radios = ['short', 'full'].map(mode => ({ dataset: { phoneMode: mode }, checked: mode === s.phoneLabels.labels, disabled: false }));
  const status = { textContent: '' }; let replacements = 0;
  Object.defineProperty(box, 'innerHTML', { get: () => '', set() { replacements++; } });
  box.querySelectorAll = selector => selector === '[data-phone-name]' ? inputs : radios;
  box.querySelector = () => status;
  box.contains = el => [...inputs, ...radios].includes(el);
  return { inputs, radios, status, replacements: () => replacements };
}

test('名前保存中の欄移動・追加入力・連続保存でDOMと移動先フォーカスを保つ', async () => {
  const a = app(), s = snapshot(), calls = [], waits = [];
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [first, second] = card.inputs;
  let stored = JSON.parse(JSON.stringify(s.phoneLabels));
  a.context.api = (route, spec) => new Promise(resolve => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    waits.push(() => { stored.names[spec.key] = spec.name; resolve({ phoneLabels: JSON.parse(JSON.stringify(stored)) }); });
  });
  first.value = '保存する名前';
  const saving = a.context.savePhoneLabels({ key: first.dataset.phoneName, name: first.value });
  a.document.activeElement = second; second.value = '次の欄の入力';
  a.events.get('input')({ target: second });
  await a.context.savePhoneLabels({ key: second.dataset.phoneName, name: second.value });
  // 保存途中で編集元にも追加入力した場合、古い応答で消してはいけない。
  a.document.activeElement = first; first.value = 'まだ未確定の追加入力'; a.events.get('input')({ target: first });
  waits.shift()(); await new Promise(setImmediate);
  assert.equal(calls.length, 2); assert.equal(first.value, 'まだ未確定の追加入力');
  a.document.activeElement = second; waits.shift()(); await saving;
  assert.equal(a.document.activeElement, second); assert.equal(second.value, '次の欄の入力');
  assert.equal(first.value, 'まだ未確定の追加入力'); assert.equal(card.replacements(), 0);
  assert.ok(card.inputs.every(el => !el.disabled));
  assert.equal(vm.runInContext('state.phoneLabels.names["chatgpt|app"]', a.context), '次の欄の入力');
});

test('名前保存中のradioを順に保存し、失敗しても入力を残して自動再試行しない', async () => {
  const a = app(), s = snapshot(), calls = [];
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), first = card.inputs[0];
  let release; const hold = new Promise(resolve => { release = resolve; });
  a.context.api = async (_route, spec) => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    if (spec.key) { await hold; throw Error('保存不可'); }
    return { phoneLabels: { labels: spec.labels, names: {} } };
  };
  first.value = '失敗した名前'; const saving = a.context.savePhoneLabels({ key: first.dataset.phoneName, name: first.value });
  a.document.activeElement = card.radios[1]; await a.context.savePhoneLabels({ labels: 'full' });
  assert.equal(card.radios[1].checked, true); assert.ok(card.radios.every(el => !el.disabled));
  release(); await saving;
  assert.deepEqual(calls, [{ key: 'codex|GPT-6.1-Sol', name: '失敗した名前' }, { labels: 'full' }]);
  assert.equal(a.document.activeElement, card.radios[1]); assert.equal(first.value, '失敗した名前');
  assert.equal(card.replacements(), 0); assert.ok(card.inputs.every(el => el.disabled));
  a.context.api = async () => { throw Error('mode保存不可'); };
  await a.context.savePhoneLabels({ labels: 'short' });
  assert.match(card.status.textContent, /mode保存不可/); assert.equal(card.radios[1].checked, true);
  assert.equal(first.value, '失敗した名前');
  // 外部から別名が届いても保存失敗した入力は保持する。
  a.document.activeElement = null;
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '外部名' } } });
  await a.context.pollState(); assert.equal(first.value, '失敗した名前'); assert.equal(calls.length, 2);
});

for (const next of ['name', 'mode']) test(`名前の保存失敗を後続の${next === 'name' ? '別名' : 'mode'}成功で消さず、該当名の修正成功で解除する`, async () => {
  const a = app(), s = snapshot(), calls = [], notices = [];
  s.roles.models = { 'claude-code': ['Opus 5.5'], codex: ['GPT-6.1-Sol'] };
  s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [opus, sol] = card.inputs;
  let release, fail = true; const hold = new Promise(resolve => { release = resolve; });
  const stored = JSON.parse(JSON.stringify(s.phoneLabels));
  a.context.toast = message => notices.push(message);
  a.context.api = async (_route, spec) => {
    calls.push(JSON.parse(JSON.stringify(spec)));
    if (spec.key === opus.dataset.phoneName && fail) { await hold; throw Error('名前を書き込めません'); }
    if (spec.key) stored.names[spec.key] = spec.name;
    else stored.labels = spec.labels;
    return { phoneLabels: JSON.parse(JSON.stringify(stored)) };
  };
  opus.value = '未保存のOpus名';
  const saving = a.context.savePhoneLabels({ key: opus.dataset.phoneName, name: opus.value });
  const target = next === 'name' ? sol : card.radios[1];
  a.document.activeElement = target;
  sol.value = next === 'name' ? '保存したSol名' : '';
  await a.context.savePhoneLabels(next === 'name' ? { key: sol.dataset.phoneName, name: sol.value } : { labels: 'full' });
  release(); await saving;
  for (const message of [card.status.textContent, notices.at(-1)]) {
    assert.match(message, /Opus 5\.5 の名前は未保存/);
    assert.match(message, /名前を書き込めません/);
    assert.doesNotMatch(message, /保存しました/);
  }
  assert.equal(calls.length, 2); assert.equal(stored.names[opus.dataset.phoneName], undefined);
  assert.equal(opus.value, '未保存のOpus名'); assert.equal(a.document.activeElement, target);
  assert.equal(card.replacements(), 0);
  if (next === 'name') assert.equal(stored.names[sol.dataset.phoneName], '保存したSol名');
  else {
    assert.equal(stored.labels, 'full');
    await a.context.savePhoneLabels({ labels: 'short' });
    assert.match(card.status.textContent, /名前を書き込めません/);
  }
  // 入力・pollだけでは再送/解除しない。利用者が該当項目を直して確定した時だけ保存する。
  fail = false; opus.value = '修正したOpus名'; a.document.activeElement = opus;
  a.events.get('input')({ target: opus });
  a.context.drawPhoneLabels();
  assert.match(card.status.textContent, /名前を書き込めません/);
  const beforeRetry = calls.length;
  await a.context.savePhoneLabels({ key: opus.dataset.phoneName, name: opus.value });
  assert.equal(calls.length, beforeRetry + 1); assert.equal(stored.names[opus.dataset.phoneName], opus.value);
  assert.equal(card.status.textContent, 'スマホの表示を保存しました');
  assert.equal(notices.at(-1), 'スマホの表示を保存しました');
  assert.equal(vm.runInContext('phoneLabelDrafts.size', a.context), 0);
  assert.equal(a.document.activeElement, opus); assert.equal(card.replacements(), 0);
});

test('複数項目の失敗は個別に解除し、mode失敗も無関係な名前成功で消さない', async () => {
  const a = app(), s = snapshot();
  s.roles.models = { codex: ['GPT-6.1-Sol'] }; s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"settings",project:"p"}', a.context);
  const card = phoneCard(a, s), [sol, chatgpt] = card.inputs;
  a.context.api = async () => { throw Error('ディスクエラー'); };
  await a.context.savePhoneLabels({ key: sol.dataset.phoneName, name: 'ソル' });
  await a.context.savePhoneLabels({ key: chatgpt.dataset.phoneName, name: 'チャット' });
  await a.context.savePhoneLabels({ labels: 'full' });
  assert.match(card.status.textContent, /6\.1-Sol の名前は未保存/);
  assert.match(card.status.textContent, /ChatGPT の名前は未保存/);
  assert.match(card.status.textContent, /表示方法は未保存/);
  const stored = JSON.parse(JSON.stringify(s.phoneLabels));
  let release; const hold = new Promise(resolve => { release = resolve; });
  a.context.api = async (_route, spec) => {
    await hold;
    if (spec.key) stored.names[spec.key] = spec.name; else stored.labels = spec.labels;
    return { phoneLabels: JSON.parse(JSON.stringify(stored)) };
  };
  const saving = a.context.savePhoneLabels({ key: sol.dataset.phoneName, name: '修正ソル' });
  assert.match(card.status.textContent, /保存中.*6\.1-Sol の名前は未保存/);
  release(); await saving;
  assert.doesNotMatch(card.status.textContent, /6\.1-Sol の名前は未保存/);
  assert.match(card.status.textContent, /ChatGPT の名前は未保存/);
  assert.match(card.status.textContent, /表示方法は未保存/);
  await a.context.savePhoneLabels({ labels: 'full' });
  assert.doesNotMatch(card.status.textContent, /表示方法は未保存/);
  assert.match(card.status.textContent, /ChatGPT の名前は未保存/);
  await a.context.savePhoneLabels({ labels: 'short' });
  await a.context.savePhoneLabels({ key: chatgpt.dataset.phoneName, name: '修正チャット' });
  assert.equal(card.status.textContent, 'スマホの表示を保存しました');
});

test('通知refreshTree先行と304/null後も表示名を同期し、blur後も会話DOMを保つ', async () => {
  const a = app(), s = snapshot();
  s.phoneLabels = { labels: 'short', names: {} };
  vm.runInContext('state=' + JSON.stringify(s) + ';view={kind:"work",project:"p",task:"t"};renderedMainKey=mainKey()', a.context);
  const option = { value: 'codex|GPT-6.1-Sol', dataset: { full: 'Codex・GPT-6.1-Sol', short: '6.1-Sol' }, textContent: '6.1-Sol' };
  const select = a.element('#chat-ai'), input = a.element('#chat-in');
  select.options = [option]; select.value = option.value; input.value = '通知中も下書き'; input.tagName = 'TEXTAREA';
  a.document.activeElement = input; a.context.matchMedia = () => ({ matches: true });
  let renders = 0; a.context.render = () => { renders++; }; a.context.renderTree = () => {};
  a.context.fetchState = async () => ({ ...s, phoneLabels: { labels: 'short', names: { 'codex|GPT-6.1-Sol': '通知で届いた名' } } });
  await a.context.refreshTree(); assert.equal(option.textContent, '通知で届いた名');
  // DOMの古い表示もstateの前後差に依存せず修復できる。
  option.textContent = '古い表示'; a.context.fetchState = async () => null;
  await a.context.pollState(); assert.equal(option.textContent, '通知で届いた名');
  a.document.activeElement = null; await a.context.pollState();
  assert.equal(renders, 0); assert.equal(a.element('#chat-ai'), select); assert.equal(a.element('#chat-in'), input);
  assert.equal(input.value, '通知中も下書き'); assert.equal(select.value, option.value);
  a.context.matchMedia = () => ({ matches: false }); await a.context.pollState(); assert.equal(option.textContent, 'Codex・GPT-6.1-Sol');
});

test('役割AIは追加アカウントを含むログイン状態で制限し、Gemini固定とChatGPT行を表示する', () => {
  const a = app(), data = snapshot(); data.agyAvailable = true;
  data.roles.models = {codex:['GPT-6.1-Sol'], 'claude-code':['Opus 5.5'], agy:['Gemini 3.1 Pro (High)']};
  data.roles.roles = [{name:'調査',main:{ai:'agy',model:'Gemini 3.1 Pro (High)',effort:'高'},backup:{ai:'codex',model:'GPT-6.1-Sol',effort:'MAX'}}];
  data.accounts = [{ai:'claude',id:'default',status:'logged-out',name:'既定'}, {ai:'claude',id:'named',status:'logged-in',name:'追加'}, {ai:'codex',id:'default',status:'api',name:'既定'}, {ai:'agy',id:'default',status:'logged-in',name:'既定'}];
  vm.runInContext('state='+JSON.stringify(data)+'; view={kind:"settings"}; accountAutoChecked=true',a.context);
  const options = a.context.roleAiOptions('codex');
  assert.match(options, /value="claude-code"\s+>Claude Code/);
  assert.match(options, /value="agy"\s+>Gemini/);
  assert.match(options, /value="codex" selected disabled/); assert.doesNotMatch(options, /ChatGPT/);
  a.context.renderSettings();
  const html = a.element('#main').innerHTML;
  assert.match(html,/data-f="model" aria-label="モデル" disabled/); assert.match(html,/data-f="effort" aria-label="思考" disabled/);
  const accounts = a.element('#ai-accounts').innerHTML; assert.match(accounts,/ChatGPT を開く/); assert.match(accounts,/キーチェーン/); assert.match(accounts,/value="agy" disabled/);
  vm.runInContext('state.agyAvailable=false; state.accounts[3].status="not-installed"',a.context);
  assert.match(a.context.roleAiOptions('agy'),/value="agy" selected disabled>Gemini（Agy CLI）（未導入）/);
});
test('役割状態の自動確認は1回・再確認は共通結果を使い、編集中の値とDOMを保持する', async () => {
  const a = app(), data = snapshot(); data.agyAvailable = true;
  data.roles.roles = [{name:'調査',main:{ai:'codex',model:'draft',effort:'MAX'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+'; view={kind:"settings"}; rolesDraft=JSON.parse(JSON.stringify(state.roles.roles)); rolesDraft[0].main.model="unsaved"',a.context);
  const select = a.element('#role-test'); select.dataset={r:'0',k:'main',f:'ai'};select.value='codex';
  a.document.querySelectorAll = q => q === 'select[data-r][data-f="ai"]' ? [select] : [];
  let finish, calls=0;
  a.context.api = route => { assert.equal(route,'/api/accounts?status=1'); calls++; return new Promise(r=>finish=r); };
  const draft = vm.runInContext('JSON.stringify(rolesDraft)',a.context), main=a.element('#main'); main.innerHTML='kept DOM';
  a.context.selectSettingsTab('ai'); a.context.selectSettingsTab('basic'); a.context.selectSettingsTab('ai');
  assert.equal(calls,1); assert.match(a.element('#role-account-status').textContent,/確認中/);
  const pending = a.context.checkRoleAccounts(); assert.equal(calls,1);
  finish({accounts:[{ai:'agy',id:'default',name:'既定',status:'logged-in'}]}); await pending;
  assert.equal(vm.runInContext('JSON.stringify(rolesDraft)',a.context),draft); assert.equal(main.innerHTML,'kept DOM'); assert.equal(select.value,'codex');
  assert.match(select.innerHTML,/value="agy"\s+>Gemini/); assert.match(select.innerHTML,/value="codex" selected disabled/);
  assert.match(a.element('#role-account-status').textContent,/\d\d:\d\d に確認/);
  a.context.selectSettingsTab('basic'); a.context.selectSettingsTab('ai'); assert.equal(calls,1);
  a.context.api = async()=>{calls++;throw Error('fixture failure');};
  await assert.rejects(a.context.checkRoleAccounts(), /fixture failure/); assert.equal(calls,2);
  a.context.selectSettingsTab('ai'); assert.equal(calls,2); assert.match(a.element('#role-account-status').textContent,/fixture failure/);
});
test('Geminiへ役割を切り替えるとモデルと高を固定する', async () => {
  const a=app(), data=snapshot();data.roles.models.agy=['Gemini 3.1 Pro (High)'];
  data.roles.roles=[{name:'調査',main:{ai:'codex',model:'old',effort:'Ultra'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+';rolesDraft=JSON.parse(JSON.stringify(state.roles.roles));render=()=>{}',a.context);
  await a.events.get('change')({target:{dataset:{r:'0',k:'main',f:'ai'},value:'agy'}});
  assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),'Gemini 3.1 Pro (High)'); assert.equal(vm.runInContext('rolesDraft[0].main.effort',a.context),'高');
});

for (const failure of ['HTTP 503', '通信拒否']) test(`アカウント確認の${failure}後も現DOMで再試行でき、busyと役割下書きを保持する`, async () => {
  const a=app(), data=snapshot();
  data.accounts=[{ai:'codex',id:'default',name:'既定',busy:true}];
  data.roles.roles=[{name:'調査',main:{ai:'codex',model:'unsaved',effort:'高'},backup:{ai:'人'}}];
  vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"};rolesDraft=JSON.parse(JSON.stringify(state.roles.roles))',a.context);
  a.element('#account-new-ai').value='codex';
  const button={disabled:false,dataset:{accountAction:'status'},closest:()=>null};
  let reject; a.context.api=()=>new Promise((_,r)=>reject=r);
  const pending=a.context.operateAccount(button);
  a.context.drawAccountSettings(); // 操作中の画面交換
  assert.match(a.element('#ai-accounts').innerHTML,/data-account-action="status" disabled/);
  reject(Error(failure)); await pending;
  assert.doesNotMatch(a.element('#ai-accounts').innerHTML,/data-account-action="status" disabled/);
  assert.match(a.element('#ai-accounts').innerHTML,/data-account-action="login" disabled/); // busyは保持
  assert.equal(a.element('#account-message').textContent,failure);
  a.context.api=async()=>({accounts:data.accounts});
  await a.context.operateAccount(button);
  assert.equal(a.element('#account-message').textContent,'完了しました');
  assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),'unsaved');
});

test('Grok availability requires installed catalogue and a logged-in account; selections stay intact', () => {
 const a=app(), data=snapshot();data.grokAvailable=true;data.efforts=['中','高','極高','MAX','Ultra'];
 data.roles.models.grok=['grok-code-1'];data.accounts=[{ai:'grok',id:'default',name:'既定',status:'logged-out'},{ai:'grok',id:'one',name:'仕事',status:'logged-in'}];
 vm.runInContext('state='+JSON.stringify(data)+';view={kind:"settings"};accountAutoChecked=true',a.context);
 assert.match(a.context.roleAiOptions('grok'),/value="grok" selected\s+>Grok/);assert.doesNotMatch(a.context.roleAiOptions('grok'),/ChatGPT/);
 assert.deepEqual(Array.from(vm.runInContext("effortsFor('grok')",a.context)),['中','高','極高','MAX']);
 vm.runInContext('state.grokAvailable=false',a.context);assert.match(a.context.roleAiOptions('grok'),/value="grok" selected disabled/);
 vm.runInContext('state.accounts.forEach(r=>r.status="not-installed")',a.context);
 const html=a.context.accountSettingsHtml();assert.match(html,/value="grok">Grok/);assert.match(html,/curl -fsSL https:\/\/x.ai\/cli\/install.sh/);
 assert.equal(a.context.ownerOf('grok').kind,'grok');
});

test('Grok role switch replaces unsupported Ultra and preserves other roles',async()=>{
 const a=app(),data=snapshot();data.efforts=['中','高','極高','MAX','Ultra'];data.roles.models.grok=['grok-code-1'];
 data.roles.roles=[{name:'調査',main:{ai:'codex',model:'old',effort:'Ultra'},backup:{ai:'人'}}];
 vm.runInContext('state='+JSON.stringify(data)+';rolesDraft=JSON.parse(JSON.stringify(state.roles.roles));render=()=>{}',a.context);
 await a.events.get('change')({target:{dataset:{r:'0',k:'main',f:'ai'},value:'grok'}});
 assert.equal(vm.runInContext('rolesDraft[0].main.model',a.context),'grok-code-1');assert.equal(vm.runInContext('rolesDraft[0].main.effort',a.context),'高');
 assert.equal(vm.runInContext('rolesDraft[0].backup.ai',a.context),'人');
});

test('Grok task chat/terminal account choices and buttons use Grok without changing initial AI',()=>{
 const a=app(),data=snapshot();data.grokAvailable=true;data.efforts=['高','Ultra'];data.roles.models.grok=['grok-code-1'];data.cliFlags.grok={'grok-code-1':'grok-code-1'};
 const p=data.projects[0],t=p.tasks[0];t.owner='grok';t.model='grok-code-1';t.effort='高';t.accounts={grok:'one'};
 data.accounts=[{ai:'grok',id:'default',name:'既定'},{ai:'grok',id:'one',name:'仕事'}];
 vm.runInContext('state='+JSON.stringify(data)+';view={kind:"work",project:"p",task:"t"}',a.context);
 const html=a.context.chatHtml(p,t);assert.match(html,/value="grok\|grok-code-1"/);assert.match(html,/data-task-account[^>]*data-ai="grok"/);
 assert.doesNotMatch(html.match(/id="chat-effort"[\s\S]*?<\/select>/)[0],/Ultra/);
 a.element('#chat-ai').value='grok|grok-code-1';a.context.drawChatAccount(p,t);assert.match(a.element('#chat-account-box').innerHTML,/selected[^>]*>仕事/);
 assert.doesNotMatch(a.context.initialPickHtml(),/Grok/);
});

test('成果整理は完了確認・完了ボタンを出さず、稼働中はあなたの番に数えない',()=>{
 const a=app();vm.runInContext(`state={projects:[],sessions:[],chatting:[],waiting:[]};`,a.context);
 for(const auto of ['running','failed','blocked','none']) {
  const t={id:'kid',title:'子',state:'実行中',steps:[{done:true,text:'完成'}],question:'',completionPending:false,resultsPending:{auto,reason:'書式を確認してください',detail:'理由'}};
  a.context.gateTask=t;a.context.gateProject={id:'P',name:'親',tasks:[t]};
  const html=vm.runInContext('completionButtons(gateProject,gateTask)',a.context);
  assert.doesNotMatch(html,/data-act="taskcomplete"|完了に移しますか/);
  if(auto==='running')assert.doesNotMatch(html,/成果の整理を頼む/);else assert.match(html,/成果の整理を頼む/);
  assert.equal(vm.runInContext('Boolean(NEEDS(gateTask))',a.context),auto!=='running');
  assert.equal(vm.runInContext('Boolean(REPLY(gateProject,gateTask))',a.context),auto!=='running');
  const row=vm.runInContext('taskRow(gateProject,gateTask,false,"reply")',a.context);assert.match(row,/成果整理/);assert.doesNotMatch(row,/完了確認|送らずに消す/);
 }
});
