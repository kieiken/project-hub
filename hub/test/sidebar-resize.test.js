'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');
const source = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
function fixture({ saved = null, size = 1200, mobile = false, locale, storageError = false } = {}) {
  const values = new Map(saved === null ? [] : [['hub-sidebar-width', saved]]), writes = [], properties = {}, classes = new Set(), captures = new Set();
  const handlers = {}, windowHandlers = {}, media = { matches: mobile, addEventListener(name, fn) { this[name] = fn; } };
  const markup = source('index.html').match(/<div[^>]*id="sidebar-resize"[^>]*>/)[0], attrs = {};
  for (const match of markup.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  const separator = {
    hidden: false, childNodes: [], attrs, addEventListener(name, fn) { handlers[name] = fn; },
    hasAttribute: name => Object.hasOwn(attrs, name), getAttribute: name => attrs[name], setAttribute(name, value) { attrs[name] = value; },
    setPointerCapture(id) { captures.add(id); }, hasPointerCapture: id => captures.has(id), releasePointerCapture(id) { captures.delete(id); },
    focus(options) { this.focusOptions = options; }
  };
  const app = { clientWidth: size, style: { setProperty(name, value) { properties[name] = value; } } };
  const draft = { value: 'unfinished user text', attachments: ['photo.png'] }, project = { name: 'User project', tasks: ['running work'] };
  // Any attempt to redraw either pane would destroy these existing objects.
  const panes = [draft, project];
  Object.defineProperty(app, 'innerHTML', { set() { throw Error('splitter must not redraw the app'); } });
  const document = { documentElement: {}, querySelector: selector => selector === '.app' ? app : selector === '#sidebar-resize' ? separator : null,
    querySelectorAll: () => [separator], body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } };
  const context = vm.createContext({ document, HUB_LOCALE: locale ? { locale } : undefined,
    matchMedia: query => { assert.equal(query, '(max-width:720px)'); return media; },
    window: { addEventListener(name, fn) { windowHandlers[name] = fn; } },
    localStorage: { getItem(key) { if (storageError) throw Error('storage disabled'); return values.get(key) ?? null; },
      setItem(key, value) { if (storageError) throw Error('storage disabled'); values.set(key, value); writes.push({ key, value }); } } });
  vm.runInContext(source('locale.js'), context);
  vm.runInContext(source('sidebar-resize.js'), context);
  function event(name, data = {}) {
    const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 240, shiftKey: false, prevented: false,
      preventDefault() { this.prevented = true; }, ...data };
    handlers[name](event); return event;
  }
  return { values, writes, properties, classes, captures, separator, app, media, event, panes, draft, project,
    width: () => Number(separator.attrs['aria-valuenow']), resize(size) { app.clientWidth = size; windowHandlers.resize(); } };
}

test('The separator is discoverable in Japanese and Traditional Chinese and starts at the existing sidebar width', () => {
  const ja = fixture(), zh = fixture({ locale: 'zh-TW' });
  assert.equal(ja.width(), 240); assert.equal(ja.properties['--hub-sidebar-width'], '240px'); assert.equal(ja.writes.length, 0);
  assert.equal(ja.separator.attrs.role, 'separator'); assert.equal(ja.separator.attrs['aria-orientation'], 'vertical');
  assert.equal(ja.separator.attrs.tabindex, '0'); assert.equal(ja.separator.attrs['aria-controls'], 'list');
  assert.equal(ja.separator.attrs['aria-label'], 'プロジェクト一覧の幅を調整');
  assert.equal(zh.separator.attrs['aria-label'], '調整專案欄寬度'); assert.match(zh.separator.attrs.title, /拖曳.*左右方向鍵/);
});

test('Dragging captures the pointer, updates the layout without redrawing work and persists only the completed width', () => {
  const f = fixture(), draft = f.draft, project = f.project;
  assert.equal(f.event('pointerdown', { clientX: 242 }).prevented, true); assert.ok(f.captures.has(1)); assert.ok(f.classes.has('resizing-sidebar'));
  assert.equal(f.separator.focusOptions.preventScroll, true);
  f.event('pointermove', { clientX: 800, pointerId: 2 }); assert.equal(f.width(), 240);
  f.event('pointermove', { clientX: 342 }); assert.equal(f.width(), 340); assert.equal(f.properties['--hub-sidebar-width'], '340px'); assert.equal(f.writes.length, 0);
  f.event('pointerup', { pointerId: 2 }); assert.ok(f.captures.has(1)); assert.equal(f.writes.length, 0);
  f.event('pointerup', { clientX: 342 }); assert.equal(f.values.get('hub-sidebar-width'), '340'); assert.equal(f.writes.length, 1);
  assert.equal(f.captures.size, 0); assert.equal(f.classes.size, 0); assert.equal(f.panes[0], draft); assert.equal(f.panes[1], project);
  assert.equal(draft.value, 'unfinished user text'); assert.deepEqual(project.tasks, ['running work']);
  assert.equal(fixture({ saved: f.values.get('hub-sidebar-width') }).width(), 340);
});

test('Drag bounds leave room for the content and a narrower window does not overwrite the preferred saved width', () => {
  const f = fixture({ size: 800, saved: '480' }); assert.equal(f.width(), 434); assert.equal(f.separator.attrs['aria-valuemax'], '434');
  f.resize(1500); assert.equal(f.width(), 480); assert.equal(f.values.get('hub-sidebar-width'), '480'); assert.equal(f.writes.length, 0);
  f.event('pointerdown'); f.event('pointermove', { clientX: -2000 }); assert.equal(f.width(), 180);
  f.event('pointermove', { clientX: 2000 }); assert.equal(f.width(), 480); f.event('pointerup');
  f.resize(721); assert.equal(f.width(), 355); assert.ok(f.app.clientWidth - f.width() - 6 >= 360);
  f.resize(1500); assert.equal(f.width(), 480);
});

test('Arrow keys, Shift and Home/End adjust and save width with the same bounds; other keys keep their normal behavior', () => {
  const f = fixture({ size: 800 });
  assert.equal(f.event('keydown', { key: 'ArrowRight' }).prevented, true); assert.equal(f.width(), 250);
  f.event('keydown', { key: 'ArrowLeft', shiftKey: true }); assert.equal(f.width(), 200);
  f.event('keydown', { key: 'Home' }); assert.equal(f.width(), 180);
  f.event('keydown', { key: 'ArrowLeft' }); assert.equal(f.width(), 180);
  f.event('keydown', { key: 'End' }); assert.equal(f.width(), 434); assert.equal(f.values.get('hub-sidebar-width'), '434');
  f.event('keydown', { key: 'ArrowRight' }); assert.equal(f.width(), 434);
  const writes = f.writes.length; assert.equal(f.event('keydown', { key: 'Tab' }).prevented, false); assert.equal(f.writes.length, writes);
});

test('Cancellation, Escape and unexpected capture loss restore the last preference instead of saving an unfinished drag', () => {
  for (const action of ['pointercancel', 'lostpointercapture', 'Escape']) {
    const f = fixture({ saved: '300' }); f.event('pointerdown'); f.event('pointermove', { clientX: 340 }); assert.equal(f.width(), 400);
    if (action === 'Escape') f.event('keydown', { key: action }); else f.event(action);
    assert.equal(f.width(), 300, action); assert.equal(f.values.get('hub-sidebar-width'), '300'); assert.equal(f.writes.length, 0);
    assert.equal(f.captures.size, 0); assert.equal(f.classes.size, 0);
    f.event('pointermove', { clientX: 540 }); assert.equal(f.width(), 300);
  }
});

test('Mobile keeps its existing layout and disables the separator; switching layouts cancels a drag safely', () => {
  const f = fixture({ mobile: true, size: 390, saved: '320' }); assert.equal(f.separator.hidden, true); assert.deepEqual(f.properties, {});
  assert.equal(f.event('pointerdown').prevented, false); f.event('pointermove', { clientX: 800 }); f.event('pointerup');
  assert.equal(f.event('keydown', { key: 'ArrowRight' }).prevented, false); assert.equal(f.writes.length, 0); assert.deepEqual(f.properties, {});
  f.app.clientWidth = 1200; f.media.matches = false; f.media.change(); assert.equal(f.separator.hidden, false); assert.equal(f.width(), 320);
  f.event('pointerdown'); f.event('pointermove', { clientX: 300 }); assert.equal(f.width(), 380);
  f.media.matches = true; f.media.change(); assert.equal(f.separator.hidden, true); assert.equal(f.captures.size, 0); assert.equal(f.classes.size, 0); assert.equal(f.writes.length, 0);
  f.media.matches = false; f.media.change(); assert.equal(f.width(), 320); assert.equal(f.values.get('hub-sidebar-width'), '320');
});

test('Invalid or unavailable storage remains usable, and nonprimary or secondary-button pointers do not resize', () => {
  for (const saved of ['', 'oops', 'Infinity', 'NaN']) assert.equal(fixture({ saved }).width(), 240);
  assert.equal(fixture({ saved: '10' }).width(), 180); assert.equal(fixture({ saved: '9999' }).width(), 480);
  const f = fixture({ storageError: true }); assert.equal(f.width(), 240);
  f.event('pointerdown', { button: 2 }); f.event('pointermove', { clientX: 500 }); assert.equal(f.width(), 240);
  f.event('pointerdown', { isPrimary: false }); f.event('pointermove', { clientX: 500 }); assert.equal(f.width(), 240);
  assert.doesNotThrow(() => { f.event('keydown', { key: 'ArrowRight' }); }); assert.equal(f.width(), 250);
});

test('The desktop divider occupies its own grid column while mobile retains the overlay project menu', () => {
  const css = source('app.css'), index = source('index.html');
  assert.match(css, /grid-template-columns:var\(--hub-sidebar-width,240px\) 6px minmax\(0,1fr\)/);
  assert.match(css, /@media \(max-width:720px\)\{\s*\.app\{grid-template-columns:1fr;position:relative\}\s*\.sidebar-resize\{display:none\}/);
  assert.match(css, /\.sidebar-resize\{[^}]*cursor:col-resize;touch-action:none/);
  assert.match(css, /\.list\{border-right:1px solid var\(--line\);position:absolute;inset:0 auto 0 0;width:min\(86vw,320px\)/);
  assert.ok(index.indexOf('id="list"') < index.indexOf('id="sidebar-resize"')); assert.ok(index.indexOf('id="sidebar-resize"') < index.indexOf('id="main"'));
  assert.ok(index.indexOf('src="locale.js"') < index.indexOf('src="sidebar-resize.js"')); assert.ok(index.indexOf('src="sidebar-resize.js"') < index.indexOf('src="app.js"'));
});
