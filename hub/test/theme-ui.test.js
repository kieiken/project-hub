'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8');
function fixture(value, blocked = false) {
  const storage = new Map(value == null ? [] : [['hub-theme', value]]), listeners = {}, events = [];
  const root = { dataset: {} }, meta = {};
  const buttons = Object.fromEntries(['dark', 'light'].map(value => [value, { dataset: { themeChoice: value }, setAttribute(name, value) { this[name] = value; } }]));
  const document = { documentElement: root, querySelector: () => meta, querySelectorAll: () => Object.values(buttons), dispatchEvent: e => events.push(e.type) };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  const localStorage = { getItem: key => { if (blocked) throw Error('unavailable'); return storage.get(key); }, setItem: (key, value) => { if (blocked) throw Error('unavailable'); storage.set(key, value); } };
  vm.runInNewContext(source, { document, window, localStorage, Event: class { constructor(type) { this.type = type; } } });
  return { theme: window.HubTheme, root, meta, buttons, storage, listeners, events };
}
test('First visit and invalid preferences are dark regardless of OS; saved light restores before styles load', () => {
  for (const value of [null, 'system', 'invalid', 'dark']) assert.equal(fixture(value).root.dataset.theme, 'dark');
  const f = fixture('light'); assert.equal(f.root.dataset.theme, 'light'); assert.equal(f.meta.content, '#eef2f7'); assert.equal(f.buttons.light['aria-pressed'], 'true');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('src="theme.js"') < html.indexOf('href="app.css"'));
});
test('Switch saves and restores both modes while updating controls, chrome and live terminal notification', () => {
  const f = fixture();
  for (const value of ['light', 'dark']) {
    assert.equal(f.theme.set(value), true); assert.equal(f.root.dataset.theme, value);
    assert.equal(f.buttons[value]['aria-pressed'], 'true'); assert.equal(f.buttons[value === 'light' ? 'dark' : 'light']['aria-pressed'], 'false'); assert.equal(f.storage.get('hub-theme'), value);
    assert.equal(fixture(f.storage.get('hub-theme')).theme.current(), value);
    assert.equal(f.theme.terminalTheme().background, value === 'light' ? '#f9fbfd' : '#10131a');
    assert.equal(f.events.at(-1), 'hub-theme-change');
  }
});
test('Blocked storage still permits switching and truthfully reports it was not saved', () => {
  const f = fixture('light', true); assert.equal(f.theme.current(), 'dark');
  assert.equal(f.theme.set('light'), false); assert.equal(f.root.dataset.theme, 'light');
  assert.equal(f.theme.terminalTheme().foreground, '#1e2533');
  assert.equal(fixture(null, true).theme.current(), 'dark');
});
test('Other tabs update the current selection; removing/clearing storage returns to dark without writing back', () => {
  const f = fixture('dark');
  f.listeners.storage({ key: 'other', newValue: 'light' }); assert.equal(f.theme.current(), 'dark');
  f.listeners.storage({ key: 'hub-theme', newValue: 'light' }); assert.equal(f.buttons.light['aria-pressed'], 'true'); assert.equal(f.buttons.dark['aria-pressed'], 'false');
  assert.equal(f.storage.get('hub-theme'), 'dark');
  f.listeners.storage({ key: 'hub-theme', newValue: null }); assert.equal(f.theme.current(), 'dark'); assert.equal(f.buttons.dark['aria-pressed'], 'true');
  f.theme.set('light'); f.listeners.storage({ key: null, newValue: null }); assert.equal(f.theme.current(), 'dark');
});
