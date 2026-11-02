'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

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
      contains() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, focus() { document.activeElement = this; },
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
    console, ModelOrder: require('../../../hub/public/model-order'), ProjectOrder: require('../../../hub/public/project-order'),
    confirm: () => true,
  });
  context.window.HubChatHistory = require('../../../hub/public/chat-history');
  require('./ui-locale-fixture').loadApp(context);
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

test('繁體中文更新入口保留英文短標籤並翻譯工作中案內，Agy消失警告可見', async () => {
  const a = app(); a.context.UI = require('./ui-locale-fixture')('zh-TW'); a.context.fixture = snapshot();
  const notices = []; a.context.toast = x => notices.push(x);
  vm.runInContext('state=fixture;state.latest="2";state.aiCliUpdate={available:true};state.updateBlocked=true;showVersion("1","2")', a.context);
  assert.equal(a.element('#upd').textContent, 'Update v2 / AI CLI');
  await a.context.openUpdate(); assert.equal(notices[0], 'CLI 請按［全部更新］；只切換 Hub，請按［將 Hub 切換為 v版本］。');
  vm.runInContext('aiTools={agy:{eligible:false,installed:true,status:"unknown",notice:"已停用 Agy 選項"}};drawAiTools()', a.context);
  assert.match(a.element('#ai-tools').innerHTML, /已停用 Agy 選項/);
});

test('Hub単独ボタンは繁體中文でも版と操作対象を示し、同版なら表示しない', () => {
  const a=app();a.context.UI=require('./ui-locale-fixture')('zh-TW');a.context.fixture=snapshot();
  vm.runInContext('state=fixture;state.latest="2"',a.context);
  assert.match(a.context.hubUpdateButton(),/將 Hub 切換為 v2/);
  vm.runInContext('state.latest="1"',a.context); assert.equal(a.context.hubUpdateButton(),'');
});
