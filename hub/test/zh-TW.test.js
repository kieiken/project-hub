'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function translator() {
  const window = { alert() {}, confirm() {}, prompt() {} };
  const context = vm.createContext({ window, document: { documentElement: {}, body: { nodeType: 1, matches: () => true } }, MutationObserver: class { observe() {} } });
  for (const file of ['zh-TW-data.js', 'zh-TW.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
  return window;
}
test('translated text reaches a stable result instead of repeatedly expanding time units', () => {
  const { hubTranslations, hubTranslate } = translator();
  for (const key of Object.keys(hubTranslations)) {
    let text = key.replace(/ZXQ\d+QXZ/g, '範例');
    let stable = false;
    for (let i = 0; i < 5; i++) {
      const next = hubTranslate(text);
      if (next === text) { stable = true; break; }
      text = next;
    }
    assert.ok(stable, key);
  }
});
test('Chinese branch and group names remain unchanged; durations require numbers', () => {
  const { hubTranslate: tr } = translator();
  for (const text of ['在同一層建立分支', '專案分組', '每 5 分鐘更新', '原始碼與使用者資料']) assert.equal(tr(text), text);
  assert.equal(tr('12分3秒'), '12 分鐘 3 秒');
  assert.equal(tr('設定'), '設定');
  assert.equal(tr('新しいプロジェクト'), '新增專案');
});

test('reviewed UI labels have natural Traditional Chinese without neighboring text', () => {
  const { hubTranslate: tr } = translator();
  const pairs = {
    '更新を確認': '檢查更新', '子作業（小作業）': '子工作（較小的工作項目）',
    '完了に移す': '確認完成', 'フェーズ 1': '階段 1',
    '処理が終わりました': 'AI 本輪執行結束', 'スマホの表示': '手機顯示設定',
    '思考：役割どおり': '思考強度：依角色設定'
  };
  for (const [original, expected] of Object.entries(pairs)) assert.equal(tr(original), expected);
});
test('the twelve displayed release entries are translated', () => {
  const { hubTranslate: tr } = translator();
  const source = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8');
  const entries = source.split(/^## /m).slice(1, 13).flatMap(section => section.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()));
  for (const entry of entries) assert.doesNotMatch(tr(entry), /[\u3041-\u309f\u30a1-\u30fa]/, entry);
});
