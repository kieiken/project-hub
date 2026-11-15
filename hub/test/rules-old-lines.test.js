'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { REPLACEMENTS, replaceLines, migrate } = require('../lib/rules-migration');
const cases = [
  ['ja', '../../docs/project-hub/templates/project/.ai/rules.md', [
    ['## 権限（最大・確認なし）', ['## 権限']],
    ['- 人に確認せず、最後まで進めてよい', ['- 既に許可された', '- 本体反映・']],
    ['- board.md … AI 同士の依頼（第2段階から使う）', ['- board.md']],
    ['- 大きい作業は、司令塔が小さな作業に分けてから始める（作業IDも分ける）', ['- 大きい作業を']],
    ['- 上限になったら、すぐ作業ファイルを更新して止まる', ['- 上限の判定', '- 番を終える']],
    ['- 交代した AI は rules.md → PROJECT.md → 作業ファイルの順に読んで続ける', ['- 交代した AI は']],
    ['- 元の担当には作業の区切り（作業ファイル更新後）で戻す', ['- 元の担当へ']],
  ]],
  ['zh-TW', '../../langpacks/zh-TW/templates/project/.ai/rules.md', [
    ['## 權限（最大權限，略過確認）', ['## 權限']],
    ['- 在已授權範圍內完成工作，不反覆詢問一般操作。', ['- 在已授權範圍內', '- 合併到主專案']],
    ['- `board.md`：AI 之間的需求，從第二階段開始使用。', ['- `board.md`']],
    ['- 較大的任務先由統籌拆成小任務，各有自己的任務ID。', ['- 想拆分較大的任務時']],
    ['- 立即更新任務檔並停止。', ['- 使用上限的判定', '- 每次回合結束時']],
    ['- 接手 AI 依序閱讀 `rules.md`、`PROJECT.md`、任務檔，再繼續工作。', ['- 接手 AI 從']],
    ['- 工作告一段落並更新任務檔後，交回原負責人。', ['- 交回原負責人的時機']],
  ]],
];
const expectedPairs = cases.flatMap(([, file, rows]) => {
  const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n');
  return rows.map(([old, prefixes]) => [old, prefixes.map(prefix => {
    const matches = lines.filter(line => line.startsWith(prefix));
    assert.equal(matches.length, 1, prefix); return matches[0];
  }).join('\n')]);
});

for (const [language, , rows] of cases) test(`${language}: all seven historical lines migrate to current template wording`, () => {
  for (const [old] of rows) {
    const [, next] = expectedPairs.find(([line]) => line === old);
    assert.deepEqual(REPLACEMENTS.find(([line]) => line === old), [old, next]);
    assert.equal(replaceLines(Buffer.from(old)).toString(), next);
  }
});

test('multi-line replacements retain each target newline, untouched bytes and final newline state', () => {
  for (const [old, next] of expectedPairs) for (const ending of ['\n', '\r\n']) for (const final of ['', ending]) {
    const prefix = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('\ncustom\r\n ' + old + '\n')]);
    const suffix = Buffer.concat([Buffer.from('custom suffix\r\n' + old + ' changed\n'), Buffer.from([0x80])]);
    const before = Buffer.concat([prefix, Buffer.from(old + ending), suffix, Buffer.from(final)]);
    const expected = Buffer.concat([prefix, Buffer.from(next.replaceAll('\n', ending) + ending), suffix, Buffer.from(final)]);
    const after = replaceLines(before);
    assert.deepEqual(after, expected); assert.deepEqual(replaceLines(after), after);
    // An unterminated last line inherits the preceding newline, without adding a trailing one.
    const last = replaceLines(Buffer.from('custom' + ending + old));
    assert.deepEqual(last, Buffer.from('custom' + ending + next.replaceAll('\n', ending)));
  }
});

test('mixed newlines use the replaced line, not the first newline in the file', () => {
  const [[old, next], [other, otherNext]] = expectedPairs.filter(([, value]) => value.includes('\n'));
  const after = replaceLines(Buffer.from('prefix\n' + old + '\r\nkeep\n' + other + '\nlast'));
  assert.equal(after.toString(), 'prefix\n' + next.replaceAll('\n', '\r\n') + '\r\nkeep\n' + otherNext + '\nlast');
  assert.deepEqual(replaceLines(after), after);
});

test('partially migrated files retain existing new lines and do not duplicate them', () => {
  for (const [old, next] of expectedPairs) {
    const lines = next.split('\n');
    const before = Buffer.from(old + '\r\ncustom\n' + lines.at(-1) + '\r\n');
    const missing = lines.slice(0, -1).map(line => line + '\r\n').join('');
    const expected = Buffer.from(missing + 'custom\n' + lines.at(-1) + '\r\n');
    assert.deepEqual(replaceLines(before), expected);
    assert.deepEqual(replaceLines(expected), expected);
    assert.equal(replaceLines(Buffer.from(next + '\n' + old)).toString(), next + '\n');
    assert.equal(replaceLines(Buffer.from(old + '\n' + old + '\n')).toString(), next + '\n');
  }
});

test('old permission heading migrates while custom body and custom rules stay byte-identical', () => {
  const rest = '\r\n- 通常操作は進めてよい。ただし公開は人に確認する\n' +
    '- 人の判断がどうしても必要な時だけ、作業ファイルの question に書き、state を「返事待ち」にする（独自の追記）\r\n' +
    '- コードの作業用コピー（Git worktree）は AI-Workspace/Work/<プロジェクト>/<作業ID>/ にだけ作る（Documents 直下・/tmp・~/.codex/worktrees には作らない）（独自の追記）\n' +
    '## 会話が 200k トークンを超えたら（圧縮）';
  assert.equal(replaceLines(Buffer.from('## 権限（最大・確認なし）' + rest)).toString(), '## 権限' + rest);
});

test('unwritable migration leaves the file intact and continues with the next project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-lines-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = expectedPairs.map(([line]) => line).join('\r\n');
  for (const name of ['blocked', 'valid']) {
    fs.mkdirSync(path.join(root, name, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(root, name, '.ai/rules.md'), old);
  }
  const store = { product: root, projectDir: id => path.join(root, id) }, io = Object.create(fs);
  io.accessSync = file => { if (file.includes('/blocked/')) throw Error('permission denied'); };
  const result = migrate(store, io);
  assert.deepEqual(result, { changed: ['valid'], skipped: ['blocked'] });
  assert.equal(fs.readFileSync(path.join(root, 'blocked/.ai/rules.md'), 'utf8'), old);
  const after = fs.readFileSync(path.join(root, 'valid/.ai/rules.md'));
  assert.deepEqual(after, Buffer.from(expectedPairs.map(([, next]) => next.replaceAll('\n', '\r\n')).join('\r\n')));
  assert.deepEqual(migrate(store, io), { changed: [], skipped: ['blocked'] });
  for (const name of ['blocked', 'valid']) assert.deepEqual(fs.readdirSync(path.join(root, name, '.ai')), ['rules.md']);
});
