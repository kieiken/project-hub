'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { replaceLines, migrate } = require('../lib/rules-migration');
const ja = fs.readFileSync(path.join(__dirname, '../../docs/project-hub/templates/project/.ai/rules.md'), 'utf8');
const zh = fs.readFileSync(path.join(__dirname, '../../langpacks/zh-TW/templates/project/.ai/rules.md'), 'utf8');
const line = (text, prefix) => { const rows = text.split('\n').filter(s => s.startsWith(prefix)); assert.equal(rows.length, 1); return rows[0]; };
const section = (text, heading) => { const at = text.indexOf(heading + '\n'); assert.ok(at >= 0); const end = text.indexOf('\n## ', at + heading.length); return text.slice(at, end < 0 ? text.length : end).trimEnd(); };
// Historical sources: 1ed6fcab (compression), 7cf761c1 (copy pair),
// 24f22a1f (copy triple), f5416ced (Traditional Chinese).
const oldSection = "## 会話が 200k トークンを超えたら（圧縮）\n1. 本筋と関係ない内容（試して捨てた案・雑談・長いログ・エラーの全文）は捨てる\n2. 残すもの：決まったこと／その理由／今の状態／次にやること／大事なファイルの場所\n3. .ai/memory/日付_作業ID.md に保存（2000 文字以内）\n4. .ai/memory/INDEX.md に1行追加（ファイル名：何が書いてあるか）\n5. 作業ファイルを更新し、新しい会話で作業ファイルから再開する\n6. 昔の経緯が必要な時だけ INDEX.md を見て、該当ファイルを読む";
const oldCopies = "- コードの作業用コピー（Git worktree）は AI-Workspace/Work/<プロジェクト>/<作業ID>/ にだけ作る（Documents 直下・/tmp・~/.codex/worktrees には作らない）\n- 本体に取り込んだら、その作業用コピーはすぐ片付ける（古い控えを残さない）";
const oldTriple = "- 作業用コピー（Git worktree）は、Hub が作業を始める時に AI-Workspace/Work/<プロジェクト>/<作業ID>/ に作る。AI は自分で作らない\n- 作業用コピーの中だけで作業し、本体は触らない。取り込みと片付けは人が Hub の［本体に取り込む］で行う\n- Git の無いプロジェクトは、Hub が保存を始めて本体で作業する（始める前に自動で保存される）";
const newSection = section(ja, "## 会話が長くなったら（圧縮）");
const newCopies = [line(ja, "- 作業用コピー（Git worktree）"), line(ja, "- 作業用コピーの中だけ")].join("\n");
const newTriple = newCopies + "\n" + line(ja, "- Git の無い");
const pairs = [
  ["- 人の判断がどうしても必要な時だけ、作業ファイルの question に書き、state を「返事待ち」にする", line(ja, "- 人の判断がどうしても")],
  ["- コードの作業用コピー（Git worktree）は AI-Workspace/Work/<プロジェクト>/<作業ID>/ にだけ作る（Documents 直下・/tmp・~/.codex/worktrees には作らない）", line(ja, "- 作業用コピー（Git worktree）")],
  ["- 作業用コピーの中だけで作業し、本体は触らない。取り込みと片付けは人が Hub の［本体に取り込む］で行う", line(ja, "- 作業用コピーの中だけ")],
  ["1行1件。パスは台帳または本体から見た相対パス（本体は body:、台帳は project:）。本体保存済みのリポジトリは既定で本体基準、本体自体は . 。括弧内には人に見せる短い説明を書く。「なし」は他の成果と併記しない。", line(ja, "1行1件。")],
  ["- 確實需要人的判斷時，在任務檔 `question` 寫問題，並將 `state` 設為內部值 `返事待ち`（等待回覆）。", line(zh, "- 確實需要人的判斷時")],
  ["- 在工作副本內工作，不修改主專案；合併與整理由人透過 Hub 的「合併到主專案」操作。", line(zh, "- 在工作副本內工作")],
  ["每行一項，路徑以台帳或主專案為基準（主專案為 body:，台帳為 project:）。已儲存在主專案的儲存庫預設以主專案為基準，主專案本身寫 . 。括號內寫給人看的簡短說明。「なし」不可與其他成果並列。下列記錄標記與路徑保留內部格式。", line(zh, "每行一項，路徑")]
];

for (const [index, [old, next]] of pairs.entries()) test(`remaining historical line ${index + 1} uses current template wording`, () => {
  for (const eol of ['\n', '\r\n']) for (const tail of ['', eol]) {
    const before = Buffer.from('custom' + eol + old + tail);
    const after = replaceLines(before);
    assert.deepEqual(after, Buffer.from('custom' + eol + next + tail));
    assert.deepEqual(replaceLines(after), after);
    assert.equal(replaceLines(Buffer.from(next + eol + old)).toString(), next + eol);
    assert.equal(replaceLines(Buffer.from(' ' + old + eol + old + ' custom')).toString(), ' ' + old + eol + old + ' custom');
  }
});

for (const [name, old, next] of [['compression', oldSection, newSection], ['copy pair', oldCopies, newCopies], ['copy triple', oldTriple, newTriple]]) {
  test(`${name}: complete historical text migrates, preserving outside bytes, newline and EOF`, () => {
    for (const eol of ['\n', '\r\n']) for (const tail of ['', eol]) {
      const prefix = Buffer.concat([Buffer.from([0xff, 0x80]), Buffer.from(' custom\r\n')]);
      const input = Buffer.concat([prefix, Buffer.from(old.replaceAll('\n', eol) + tail)]);
      const after = replaceLines(input);
      assert.deepEqual(after, Buffer.concat([prefix, Buffer.from(next.replaceAll('\n', eol) + tail)]));
      assert.deepEqual(replaceLines(after), after);
      const suffix = Buffer.concat([Buffer.from(eol + '## Custom' + eol), Buffer.from([0xfe, 13])]);
      assert.deepEqual(replaceLines(Buffer.concat([input, suffix])), Buffer.concat([prefix, Buffer.from(next.replaceAll('\n', eol) + tail), suffix]));
    }
  });
}

test('compression is atomic with modified, missing, inserted or appended custom lines', () => {
  assert.equal(replaceLines(Buffer.from(oldSection)).toString(), newSection);
  assert.equal(replaceLines(Buffer.from('- custom\n' + oldSection)).toString(), '- custom\n' + newSection);
  const rows = oldSection.split('\n');
  for (let at = 0; at < rows.length; at++) {
    for (const altered of [rows.toSpliced(at, 1, rows[at] + ' custom'), rows.toSpliced(at, 1), ...(at ? [rows.toSpliced(at, 0, '- custom')] : [])]) {
      const input = Buffer.from(altered.join('\r\n') + '\r\n');
      assert.deepEqual(replaceLines(input), input);
    }
  }
  for (const extra of ['\n- custom', '\n\n- custom', '\n### Custom subsection\n- custom']) {
    const input = Buffer.from(oldSection + extra);
    assert.deepEqual(replaceLines(input), input);
  }
});

test('custom copy blocks retain custom bytes and only migrate independent complete lines', () => {
  assert.equal(replaceLines(Buffer.from(oldCopies)).toString(), newCopies);
  const [placement, cleanup] = oldCopies.split('\n');
  const input = Buffer.from(placement + '\r\n- custom\n' + cleanup);
  assert.equal(replaceLines(input).toString(), newCopies.split('\n')[0] + '\r\n- custom\n' + cleanup);
  const custom = oldTriple.replace(oldTriple.split('\n')[0], '- custom placement');
  assert.equal(replaceLines(Buffer.from(custom)).toString(), custom.replace(pairs[2][0], pairs[2][1]));
});

test('complete new blocks and repeated old blocks never duplicate sections or empty headings', () => {
  for (const [old, next] of [[oldSection, newSection], [oldCopies, newCopies]]) {
    assert.equal(replaceLines(Buffer.from(old)).toString(), next);
    for (const input of [old + '\n\n' + next, next + '\n\n' + old, old + '\n\n' + old]) {
      const after = replaceLines(Buffer.from(input));
      assert.equal(after.toString().split(next).length - 1, 1);
      assert.ok(!after.toString().includes(old));
      assert.deepEqual(replaceLines(after), after);
    }
  }
});

test('partial new section is left intact instead of producing empty or duplicate headings', () => {
  assert.equal(replaceLines(Buffer.from(oldSection)).toString(), newSection);
  for (const existing of [newSection.split('\n')[0], newSection.split('\n')[1], newSection.split('\n').slice(0, 3).join('\n')]) {
    const input = Buffer.from(existing + '\n\n' + oldSection);
    assert.deepEqual(replaceLines(input), input);
  }
  const existing = newCopies.split('\n')[0];
  const input = existing + '\n' + oldCopies;
  assert.equal(replaceLines(Buffer.from(input)).toString(), newCopies);
});

test('mixed line endings in copy rules and final bytes survive migration', () => {
  const old = oldTriple.split('\n'), next = newTriple.split('\n');
  const before = old[0] + '\r\n' + old[1] + '\n' + old[2];
  assert.equal(replaceLines(Buffer.from(before)).toString(), next[0] + '\r\n' + next[1] + '\n' + next[2]);
  const pair = oldCopies.split('\n'), updated = newCopies.split('\n');
  assert.equal(replaceLines(Buffer.from(pair[0] + '\n' + pair[1] + '\r\n')).toString(), updated[0] + '\n' + updated[1] + '\r\n');
  const permission = '- 人に確認せず、最後まで進めてよい';
  const newPermission = [line(ja, '- 既に許可された'), line(ja, '- 本体反映・')].join('\r\n');
  assert.equal(replaceLines(Buffer.from(pair[0] + '\n' + pair[1] + '\r\n' + permission)).toString(), updated[0] + '\n' + updated[1] + '\r\n' + newPermission);
});

test('unwritable remaining-rule file stays untouched while the next project migrates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-more-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = oldCopies + '\n\n' + pairs[0][0] + '\n\n' + oldSection;
  for (const id of ['blocked', 'valid']) {
    fs.mkdirSync(path.join(root, id, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(root, id, '.ai/rules.md'), old);
  }
  const store = { product: root, projectDir: id => path.join(root, id) }, io = Object.create(fs);
  io.accessSync = file => { if (file.includes('/blocked/')) throw Error('fixture permission denied'); };
  assert.deepEqual(migrate(store, io), { changed: ['valid'], skipped: ['blocked'] });
  assert.equal(fs.readFileSync(path.join(root, 'blocked/.ai/rules.md'), 'utf8'), old);
  assert.equal(fs.readFileSync(path.join(root, 'valid/.ai/rules.md'), 'utf8'), newCopies + '\n\n' + pairs[0][1] + '\n\n' + newSection);
  assert.deepEqual(migrate(store, io), { changed: [], skipped: ['blocked'] });
});
