'use strict';
// English pack: format, load, UI literal coverage and backend coverage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const pack = path.resolve(__dirname, '..');
const hub = path.resolve(__dirname, '../../../hub');
const kana = /[\u3041-\u3096\u30a1-\u30fa]/u;
// Task-file section names and stored states stay Japanese because the program reads them.
// The delegation API role value コーディング and tier value 軽い also stays exact (all tier values stay exact).
// Also the stored values the app parses from AI output (results lines, issue states, sharing checks).
const kept = /コーディング|軽い|難しい|成果|確認結果|残件申告|最新の再開要約|手順|やったこと|次にやること|注意|メモ|本文保管|未着手|実行中|返事待ち|停止|完了確認待ち|完了|未解決|確認待ち|判断待ち|解決済み|履歴|ファイル移行|ファイル|本体保存済み|なし|あり|不明|おすすめ|複数可|\[\[\/?質問\]\]/g;
const read = name => JSON.parse(fs.readFileSync(path.join(pack, name), 'utf8'));

test('manifest, dictionaries and optional assets load through the product loader', () => {
  const manifest = read('pack.json');
  assert.equal(manifest.id, 'en');
  assert.match(manifest.verifiedWith, /^\d+\.\d+\.\d+$/);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-en-pack-'));
  try {
    const { loadPack } = require(path.join(hub, 'lib/langpack'));
    const loaded = loadPack({ dir: pack, warn: false, needs: ['native', 'docs'] });
    assert.ok(loaded, 'pack must load');
    assert.ok(Object.keys(loaded.messages).length > 3000);
    assert.ok(Object.keys(loaded.backend.messages).length > 3000);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('translations keep placeholders and contain no Japanese kana outside kept tokens', () => {
  const backend = read('backend.json');
  for (const [name, dict] of [['ui', read('ui.json')], ['backend', backend.messages], ['labels', backend.labels], ['native', read('native.json')]]) {
    for (const [source, value] of Object.entries(dict)) {
      const ph = s => (s.match(/\$\{\d+\}/g) || []).sort().join();
      assert.equal(ph(value), ph(source), name + ': placeholders differ: ' + source.slice(0, 60));
      assert.ok(!kana.test(value.replace(kept, '')), name + ': untranslated: ' + source.slice(0, 60));
    }
  }
});

test('every explicitly marked UI literal is translated (strict mode fails, default warns)', t => {
  const publicDir = path.join(hub, 'public');
  const context = vm.createContext({ HUB_LOCALE: { locale: 'en', messages: read('ui.json') } });
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'locale.js'), 'utf8'), context);
  const en = context.HubI18n, missing = [];
  for (const file of fs.readdirSync(publicDir).filter(name => name.endsWith('.js') && name !== 'locale.js')) {
    const text = fs.readFileSync(path.join(publicDir, file), 'utf8');
    for (const match of text.matchAll(/UI\.(text|html)\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/g)) {
      const value = vm.runInNewContext(match[2]);
      if (kana.test(en[match[1]](value).replace(kept, ''))) missing.push(file + ': ' + value);
    }
  }
  if (process.env.HUB_I18N_STRICT === '1') assert.deepEqual(missing, []);
  else if (missing.length) t.diagnostic('untranslated UI: ' + missing.length);
});
