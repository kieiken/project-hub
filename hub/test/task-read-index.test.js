'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const { taskReadIndex, MAX_BYTES, MAX_SOURCE_BYTES } = require('../lib/task-read-index');
const source = [
  '---', 'id: fixture', '---', '## 最新の再開要約', 'summary',
  '## やったこと', 'done', '## 次にやること', 'next', '## 手順',
  'preamble', '### 最新', 'step1', '### 次', 'step2', '### 三番目', 'step3',
  '### 古い節', 'step4', '## 成果', 'result', '## メモ', 'memo',
].join('\n');

test('indexes whole sections and the latest three subsection ranges without narrowing procedures', () => {
  const line = taskReadIndex(source, { summaryIncluded: true });
  for (const part of ['やったこと L6-7', '次にやること L8-9', '手順 L10-19', '成果 L20-21', 'L12-13「最新」', 'L14-15「次」', 'L16-17「三番目」', "sed -n '6,7p' '.ai/tasks/<id>.md'", '更新でずれる', '再開要約は上記に含むため再読不要']) assert.ok(line.includes(part), part);
  assert.doesNotMatch(line, /古い節/);
  assert.equal(line.trim().split('\n').length, 1);
  assert.equal(taskReadIndex(source.replaceAll('\n', '\r\n') + '\r\n', { summaryIncluded: true }), line);
  assert.doesNotMatch(taskReadIndex(source), /再読不要/);
  assert.ok(taskReadIndex(source, { task: "has space'quote" }).includes("'.ai/tasks/has space'\\''quote.md'"));
});

test('missing or ambiguous sections, incomplete fences and oversized sources omit the advisory', () => {
  for (const name of ['やったこと', '次にやること', '手順', '成果']) {
    assert.equal(taskReadIndex(source.replace('## ' + name, '## absent')), '');
    assert.equal(taskReadIndex(source + '\n## ' + name), '');
  }
  assert.equal(taskReadIndex(source.replace('### 次', '### 最新')), '');
  assert.equal(taskReadIndex(source + '\n```'), '');
  assert.equal(taskReadIndex('x'.repeat(MAX_SOURCE_BYTES + 1)), '');
  assert.equal(taskReadIndex('あ'.repeat(MAX_SOURCE_BYTES / 3 + 1)), '');
  assert.equal(taskReadIndex(null), '');
  assert.equal(taskReadIndex(source, { task: 'x'.repeat(MAX_BYTES) }), '');
});

test('fenced examples are ignored and EOF/small procedure sections have valid inclusive ranges', () => {
  const raw = '```md\n## 成果\n### example\n```\n## やったこと\nd\n## 次にやること\nn\n## 手順\ns\n## 成果';
  assert.match(taskReadIndex(raw), /成果 L11-11/);
  assert.match(taskReadIndex(raw), /手順 L9-10/);
  assert.doesNotMatch(taskReadIndex(raw), /最新の節/);
});

test('large heading labels stay on one bounded line with visible title excerpts', () => {
  const raw = source.replace('### 最新', '### ' + '見出し😀'.repeat(1000));
  const line = taskReadIndex(raw, { summaryIncluded: true });
  assert.ok(line.includes('…」'));
  assert.ok(Buffer.byteLength(line) <= MAX_BYTES);
  assert.equal(line.trim().split('\n').length, 1);
});
