'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const locales = path.join(__dirname, '../locales');
const packs = fs.readdirSync(locales).filter(name => fs.statSync(path.join(locales, name)).isDirectory());
const readJson = (pack, file) => {
  const target = path.join(locales, pack, file);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
};
function withLanguage(language, fn) {
  const previous = process.env.HUB_LANG;
  try {
    if (language === undefined) delete process.env.HUB_LANG; else process.env.HUB_LANG = language;
    return fn(require('../lib/locale'));
  } finally {
    if (previous === undefined) delete process.env.HUB_LANG; else process.env.HUB_LANG = previous;
  }
}

test('Every locale pack declares its own folder locale and is loaded', () => {
  assert.ok(packs.length >= 1);
  const loaded = withLanguage(undefined, L => L.installed().map(pack => pack.locale));
  for (const pack of packs) {
    const manifest = readJson(pack, 'pack.json');
    assert.equal(manifest?.locale, pack, pack + '/pack.json locale');
    assert.ok(typeof manifest.name === 'string' && manifest.name.trim(), pack + '/pack.json name');
    assert.ok(loaded.includes(pack), pack);
  }
});

test('Every pack catalog keeps exactly the placeholders of its Japanese source', () => {
  const markers = text => [...text.matchAll(/\$\{\d+\}/g)].map(match => match[0]).sort();
  for (const pack of packs) for (const file of ['messages.json', 'ui-messages.json', 'native.json']) {
    for (const [key, value] of Object.entries(readJson(pack, file) || {})) {
      assert.equal(typeof value, 'string', `${pack}/${file}: ${key}`);
      assert.deepEqual(markers(value), markers(key), `${pack}/${file}: ${key}`);
    }
  }
});

test('Japanese is the default and a language without an installed pack falls back to it', () => {
  for (const language of [undefined, 'ja', 'xx', 'xx-YY', '../zh-TW', 'zh-TW/../zh-TW']) withLanguage(language, L => {
    assert.equal(L.locale(), 'ja', String(language));
    assert.equal(L.lt('作業が見つかりません'), '作業が見つかりません');
    assert.equal(L.label('完了'), '完了');
    assert.equal(L.sectionName('手順'), '手順');
    assert.deepEqual(L.config(), { locale: 'ja', language: 'ja', dateLocale: 'ja-JP', messages: {} });
    assert.equal(L.styles(), '');
    assert.equal(L.templates(), path.join(__dirname, '../../docs/project-hub/templates'));
  });
});

test('Ledger headings written in any installed language stay readable in every language', () => {
  for (const language of [undefined, ...packs]) withLanguage(language, L => {
    for (const pack of packs) {
      const { headings = {}, headingAliases = {} } = readJson(pack, 'terms.json') || {};
      for (const [japanese, translated] of Object.entries(headings)) {
        const aliases = headingAliases[japanese] || [];
        for (const written of [japanese, translated]) {
          const names = L.sectionNames(written);
          assert.equal(names[0], japanese, written);
          for (const name of [translated, ...aliases]) assert.ok(names.includes(name), `${written} → ${name}`);
        }
      }
    }
  });
});

test('An active pack supplies browser catalogs, with the server catalog winning on overlap', () => {
  for (const pack of packs) withLanguage(pack, L => {
    const server = readJson(pack, 'messages.json') || {}, ui = readJson(pack, 'ui-messages.json') || {};
    const config = L.config();
    assert.equal(config.locale, pack);
    assert.deepEqual(config.messages, { ...ui, ...server });
  });
});
