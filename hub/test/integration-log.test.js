'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { lastMerge } = require('../lib/integration-log');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-integration-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'log.jsonl'), old = path.join(root, 'log.old.jsonl');
  const row = extra => ({ action: 'merge', project: 'project', task: 'task', ok: true, ...extra });
  const write = (f, rows) => fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { file, old, row, write };
}
test('現行の最新成功を優先し、失敗・同番号の別プロジェクト・破損行を採用しない', t => {
  const { file, old, row, write } = fixture(t), expected = row({ commit: 'current' });
  write(old, [row({ commit: 'archived' })]);
  write(file, [row({ commit: 'earlier' }), expected, row({ ok: false }), row({ project: 'other' }), null]);
  fs.appendFileSync(file, 'incomplete JSON\n');
  const before = fs.readFileSync(file);
  assert.deepEqual(lastMerge(file, 'project', 'task'), expected);
  assert.equal(lastMerge(file, 'project', 'missing'), null);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('現行ログ不存在なら退避ログを使い、現行ログを読めない時は古い証跡で成功扱いしない', t => {
  const { file, old, row, write } = fixture(t), expected = row({ commit: 'archived' });
  assert.equal(lastMerge(file, 'project', 'task'), null);
  write(old, [expected]);
  assert.deepEqual(lastMerge(file, 'project', 'task'), expected);
  fs.mkdirSync(file); // EISDIR：最新の記録を読めない状況。
  assert.equal(lastMerge(file, 'project', 'task'), null);
});
