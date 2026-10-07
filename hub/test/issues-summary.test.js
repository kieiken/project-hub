'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Store } = require('../lib/store');
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-issues-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Product', '見本');
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const ledger = path.join(dir, 'PROJECT.md'), summary = path.join(dir, '.ai/issues-summary.json');
  const texts = ['【確認】場所を確認する 原文の空白  と記号', '未解決の原文'];
  const saveLedger = () => fs.writeFileSync(ledger, `---\nname: 見本\nissues:\n  - ${JSON.stringify(texts[0])}\n  - { text: ${JSON.stringify(texts[1])}, level: 高 }\n---\n# メモ\n残す原文\n`);
  saveLedger();
  const store = new Store(root);
  let summaryTime = Date.now();
  const write = items => { fs.writeFileSync(summary, JSON.stringify({ items })); const stamp = new Date(summaryTime += 1000); fs.utimesSync(summary, stamp, stamp); };
  const item = (i, change = {}) => ({ hash: digest(texts[i]), title: '場所の確認', state: '確認待ち', next: '場所を確かめる', who: '人', ...change });
  return { root, ledger, summary, texts, store, write, item, saveLedger };
}

test('問題点の文字列・オブジェクトを保ち、一致した要約だけ付ける。読み込みでは元ファイルを変えない', t => {
  const f = fixture(t), before = fs.readFileSync(f.ledger);
  assert.deepEqual(f.store.readProject('見本').issues, [f.texts[0], { text: f.texts[1], level: '高' }]);
  const items = [f.item(0), f.item(1, { state: '履歴', next: '', who: '' })];
  f.write(items); const summaryBefore = fs.readFileSync(f.summary);
  const p = f.store.readProject('見本');
  assert.equal(p.issues[0].text, f.texts[0]);
  assert.equal(p.issues[0].summary.title, '場所の確認');
  assert.equal(p.issues[1].level, '高'); assert.equal(p.issues[1].summary.state, '履歴');
  p.issues[0].summary.title = '呼び出し側の変更'; p.issues[1].text = '変更';
  assert.equal(f.store.readProject('見本').issues[0].summary.title, '場所の確認');
  assert.equal(f.store.readProject('見本').issues[1].text, f.texts[1]);
  assert.deepEqual(fs.readFileSync(f.ledger), before);
  assert.deepEqual(fs.readFileSync(f.summary), summaryBefore);
});

test('台帳が同じでも要約更新を読む。原文の変更・要約ファイル削除で古い要約を使わない', t => {
  const f = fixture(t); f.write([f.item(0)]);
  assert.equal(f.store.readProject('見本').issues[0].summary.state, '確認待ち');
  f.write([f.item(0, { state: '解決済み' })]);
  assert.equal(f.store.readProject('見本').issues[0].summary.state, '解決済み');
  f.texts[0] += ' '; f.saveLedger();
  assert.equal(f.store.readProject('見本').issues[0], f.texts[0]);
  f.write([f.item(0)]); assert.ok(f.store.readProject('見本').issues[0].summary);
  fs.unlinkSync(f.summary); assert.equal(f.store.readProject('見本').issues[0], f.texts[0]);
});

test('壊れたJSON・不正な形式/状態/長さ/担当/重複は要約として使わず、他の有効な項目は残す', t => {
  const f = fixture(t);
  for (const change of [
    { state: '完了' }, { title: '' }, { title: ' '.repeat(2) }, { title: 'あ'.repeat(31) },
    { title: '名前\n改行' }, { next: 'あ'.repeat(51) }, { next: null }, { next: '次\nの行' },
    { who: '他人' }, { hash: '../別の場所' },
  ]) {
    f.write([f.item(0, change), f.item(1)]);
    const issues = f.store.readProject('見本').issues;
    assert.equal(issues[0], f.texts[0], JSON.stringify(change)); assert.ok(issues[1].summary);
  }
  f.write([f.item(0), f.item(0, { state: '解決済み' })]);
  assert.equal(f.store.readProject('見本').issues[0], f.texts[0]);
  for (const doc of ['{ broken', 'null', '{"items":{}}', '[]']) {
    fs.writeFileSync(f.summary, doc);
    assert.equal(f.store.readProject('見本').issues[0], f.texts[0]);
  }
  f.write([f.item(0, { title: '📝'.repeat(30), next: '📝'.repeat(50) })]);
  assert.ok(f.store.readProject('見本').issues[0].summary); // 字数はUnicodeの文字数
});
