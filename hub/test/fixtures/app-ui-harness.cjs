'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const { loadApp } = require('./app-source.cjs');

function app(userAgent = '', sessionStorage) {
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
      contains(target) { return target === this; },
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
    querySelector: s => s === '.ideas-dialog[open]' ? null : s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb, capture = false) { events.set(name, cb); documentListeners.push({ name, cb, capture }); },
  };
  const context = vm.createContext({
    document, window: {}, navigator: { userAgent }, location: { href: '' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage,
    fetch: () => new Promise(() => {}), // 起動時の load() は試験用の状態を上書きしない
    EventSource, URL, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, { cb, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../../public/model-order'), ProjectOrder: require('../../public/project-order'),
    confirm: () => true,
  });
  context.window.HubChatHistory = require('../../public/chat-history');
  const reviewUI=path.join(__dirname, '../..', 'public', 'paid', 'role-review.js');
  if(fs.existsSync(reviewUI)) vm.runInContext(fs.readFileSync(reviewUI,'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', 'public', 'role-settings.js'), 'utf8'), context);
  const paidUI=path.join(__dirname,'../../public/paid/discussion.js');
  if(fs.existsSync(paidUI))vm.runInContext(fs.readFileSync(paidUI,'utf8'),context);
  const webUI=path.join(__dirname,'../../public/paid/webchat.js');
  if(fs.existsSync(webUI))vm.runInContext(fs.readFileSync(webUI,'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', 'public', 'role-tiers.js'), 'utf8'), context);
  loadApp(context);
  vm.runInContext('webchatUI()',context);
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

module.exports={app,project,snapshot};
