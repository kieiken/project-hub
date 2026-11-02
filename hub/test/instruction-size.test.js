'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chat = require('../lib/chat');
const launch = require('../lib/launch');
const instructions = require('../lib/instructions');
const { buildHandoffCard, snapshot } = require('../lib/handoff-card');
const { LimitEvidence } = require('../lib/limit-evidence');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-instructions-'));
const root = path.join(tmp, 'workspace'), dir = path.join(root, 'Product', 'Size fixture');
fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true });
fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: Size fixture\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
fs.writeFileSync(path.join(dir, '.ai/tasks', 'existing.md'), '---\nid: existing\ntitle: 指示の効率化\nrole: 司令塔\nstate: 実行中\n---\n## 手順\n- [x] before\n- [ ] after\n\n## メモ\n- latest progress\n');
fs.writeFileSync(path.join(root, '_hub/roles.yaml'), `models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6-Astra, GPT-6.1-Sol]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 極高], backup: [codex, GPT-6-Astra, 極高] }\n  調査: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\n  デザイン: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\n  画像生成: { main: [codex, GPT-6.1-Sol, 高], backup: [claude-code, Opus 5.5, 高] }\n  コーディング: { main: [codex, GPT-6.1-Sol, 高], backup: [claude-code, Opus 5.5, 高] }\n  チェック: { main: [claude-code, Fable 5.1, 極高], backup: [codex, GPT-6-Astra, 極高] }\n  文章: { main: [claude-code, Opus 5.5, 高], backup: [codex, GPT-6.1-Sol, 高] }\nswitch:\n  auto: true\n`);
fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ claude:{models:[{id:'claude-fable-5-1',label:'Fable 5.1'},{id:'claude-opus-5-5',label:'Opus 5.5'}]}, agy:{models:[{id:'gemini-current',label:'Current Gemini'}]}, codex: { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] } }));
Object.assign(process.env, { HUB_ROOT: root, HUB_DRY_RUN: '1', HUB_PORT: '4545', HUB_AI_HOME: path.join(tmp, 'home') });
const { Store } = require('../lib/store');
const store = new Store(root), { taskPrompt, server } = require('../server');
const p = store.readProject('Size fixture'), t = p.tasks[0];
const prompt = () => taskPrompt(p, t, store.taskFile(p.id, t.id), dir);
const options = { ai: 'claude', model: 'Fable 5.1', rows: [], text: 'unique-current', basePrompt: prompt(), meta: {} };
const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const stateFile = path.join(root, '_hub/limits.json');

test('節の索引だけが会話依頼文に増え、固定規則・その他の依頼文・端末用は不変', () => {
  const file = store.taskFile(p.id, t.id), original = fs.readFileSync(file, 'utf8');
  const { taskReadIndex, MAX_BYTES } = require('../lib/task-read-index');
  const raw = original.split('## 手順')[0] + '## 最新の再開要約\nsummary fixture\n## やったこと\ndone\n## 次にやること\nnext\n## 手順\n### latest\n- [ ] pending\n## 成果\nresult\n';
  try {
    fs.writeFileSync(file, raw + '## 成果\n'); // Duplicate: no advisory, same existing prompt inputs.
    const before = prompt(), terminal = taskPrompt(p, t, file, dir, 'terminal');
    const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
    fs.writeFileSync(file, raw);
    const after = prompt(), index = taskReadIndex(raw, { task: t.id, summaryIncluded: true });
    assert.ok(index);
    assert.equal(after.replace('\n' + index, ''), before);
    assert.ok(Buffer.byteLength(after) - Buffer.byteLength(before) <= MAX_BYTES + 1);
    assert.equal(instructions.split(after).fixed, instructions.split(before).fixed);
    assert.ok(instructions.split(after).dynamic.endsWith(index));
    assert.equal(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), full);
    assert.equal(taskPrompt(p, t, file, dir, 'terminal'), terminal);
    assert.doesNotMatch(terminal, /節の行範囲/);
    // Incomplete summaries retain their existing warning; never claim rereading is unnecessary.
    fs.writeFileSync(file, raw.replace('summary fixture', '承認'.repeat(2100)));
    const incomplete = prompt();
    assert.match(incomplete, /重要情報だけで要約上限/);
    assert.match(incomplete, /節の行範囲/);
    assert.doesNotMatch(incomplete, /再開要約は上記に含むため再読不要/);
  } finally { fs.writeFileSync(file, original); }
});

test('1回の案内省略はdynamicだけを除き、既定の依頼文と端末・固定規則・短縮送信を保つ', () => {
  const file = store.taskFile(p.id, t.id), original = fs.readFileSync(file, 'utf8');
  const raw = original.split('## 手順')[0] + '## 最新の再開要約\nsummary\n## やったこと\ndone\n## 次にやること\nnext\n## 手順\n### latest\n- [ ] pending\n## 成果\nresult\n';
  const controlled = value => taskPrompt(p, t, file, dir, 'chat', undefined, { readIndex: value });
  try {
    fs.writeFileSync(file, raw);
    const normal = prompt(), terminal = taskPrompt(p, t, file, dir, 'terminal');
    const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
    const omitted = controlled(false), a = instructions.split(normal), b = instructions.split(omitted);
    const index = require('../lib/task-read-index').taskReadIndex(raw, { task: t.id, summaryIncluded: true });
    assert.ok(index);
    assert.equal(omitted, normal.replace('\n' + index, ''));
    assert.equal(controlled(true), normal);
    assert.equal(controlled(undefined), normal);
    assert.equal(prompt(), normal); // Never saved to task/meta or the next request.
    assert.equal(a.fixed, b.fixed); assert.equal(a.hash, b.hash);
    assert.doesNotMatch(b.dynamic, /節の行範囲/);
    assert.equal(taskPrompt(p, t, file, dir, 'terminal', undefined, { readIndex: false }), terminal);
    assert.equal(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), full);
    const first = instructions.select(normal, { meta: {}, ai: 'codex', sid: 'index-control', resume: false });
    const without = instructions.select(omitted, { meta: { rulesSent: { codex: first.rules } }, ai: 'codex', sid: 'index-control', resume: true });
    assert.equal(without.short, true); assert.match(without.fixed, /【決まり】前回と同じ/);
    const restored = instructions.select(normal, { meta: { rulesSent: { codex: without.rules } }, ai: 'codex', sid: 'index-control', resume: true });
    assert.equal(restored.short, true); assert.match(restored.prefix, /節の行範囲/);
  } finally { fs.writeFileSync(file, original); }
});

test('作業記録が1行増えても固定hashは同じで、再開時は短い規則と更新済み索引を送る', () => {
  const file = store.taskFile(p.id, t.id), original = fs.readFileSync(file, 'utf8');
  const raw = original.split('## 手順')[0] + '## 最新の再開要約\nsummary fixture\n## やったこと\ndone\n## 次にやること\nnext\n## 手順\n### latest\n- [ ] pending\n## 成果\nresult\n';
  try {
    fs.writeFileSync(file, raw);
    const first = prompt(), a = instructions.split(first);
    const terminal = taskPrompt(p, t, file, dir, 'terminal');
    const sent = instructions.select(first, { meta: {}, ai: 'codex', sid: 'index-session', resume: false });
    fs.writeFileSync(file, raw.replace('done\n', 'done\n\n'));
    const second = prompt(), b = instructions.split(second);
    assert.equal(a.hash, b.hash);
    assert.equal(a.fixed, b.fixed);
    assert.doesNotMatch(b.fixed, /節の行範囲/);
    assert.match(b.dynamic, /節の行範囲/);
    assert.match(b.dynamic, /sed -n '[\d,]+p' '\.ai\/tasks\/existing\.md'/);
    assert.notEqual(a.dynamic, b.dynamic);
    const resumed = instructions.select(second, { meta: { rulesSent: { codex: sent.rules } }, ai: 'codex', sid: 'index-session', resume: true });
    assert.equal(resumed.short, true);
    assert.match(resumed.fixed, /【決まり】前回と同じ/);
    assert.ok(resumed.prefix.endsWith(b.dynamic));
    assert.equal(taskPrompt(p, t, file, dir, 'terminal'), terminal);
  } finally { fs.writeFileSync(file, original); }
});

test('確認方針は通常・自由対話の会話/ターミナルと全文へ一回届き、旧版の再開時は更新される', () => {
  const roleFile = path.join(root, '_hub/roles.yaml'), beforeRoles = fs.readFileSync(roleFile);
  const beforeLimits = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  assert.match(prompt(),/Current Gemini（gemini-current）/);assert.doesNotMatch(prompt(),/Gemini 3\.1 Pro|gemini-3\.1-pro-high/);
  const base = prompt(), first = chat.buildTurn({ ...options, basePrompt: base });
  const topic = { ...t, freetalk: true }, fp = { id: 'freetalk', kind: 'freetalk', dir };
  const texts = [
    first.fixed,
    fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'),
    taskPrompt(p, t, store.taskFile(p.id, t.id), dir, 'terminal'),
    ...['chat', 'terminal'].map(where => taskPrompt(fp, topic, '', dir, where)),
  ];
  for (const text of texts) {
    assert.equal(text.split(instructions.WORKFLOW_RULE).length - 1, 1);
    for (const required of [
      '全役割を毎回呼ぶ指定ではない', '現在の担当が必要箇所を確認',
      'チェック担当を呼ぶのは、軽微でない変更を含む時・影響の大きい操作の前・人が求めた時だけ',
      'チェック後の修正が軽微なら、修正担当の自己確認で終え、チェック担当を再び呼ばない',
      '影響の大きい操作の個別確認や人が求めた再確認は行う',
      '行数ではなく', '権限・データ構造・外部連携', '一連の変更が揃い',
      '指示一通・返信一回を自動の区切りにしない', '再確認は変更箇所と影響範囲だけ',
      '根拠がある時だけ範囲を広げる', '最終確認も兼ねる', '影響の大きい操作の個別確認は維持',
      'チェック後に変更がなければ、本体反映・公開の前に再チェックしない',
      '人の承認が要る操作の承認は残す',
      '読み取り・診断だけの手順や確認済み操作のやり直しにはチェックを挟まず',
      '書き込む中身・公開する中身・対象が変わる時だけチェックする',
      '既定の役割は変更しない', 'mainの上限ではbackupへ',
    ]) assert.ok(text.includes(required) || required === 'mainの上限ではbackupへ' && text.includes('設定main⇔backup'), required);
    assert.doesNotMatch(text, /関連・全体試験→commit/);
  }
  assert.match(instructions.templates(), /全体試験は共通部への影響など根拠がある時だけ/);
  assert.match(instructions.templates(), /関連変更が揃い、軽微でない変更を含む時・影響の大きい操作の前・人が求めた時だけ使う/);
  assert.match(instructions.templates(), /軽微な変更だけなら現在の担当の自己確認で終える/);
  assert.match(instructions.templates(), /チェック後の軽微な修正も自己確認で終え/);
  assert.match(instructions.templates(), /軽微な修正は修正担当の自己確認で終える/);
  for (const template of instructions.templates().split('\n').slice(1)) {
    assert.match(template, /チェック済みの内容・対象が同じ本体反映・公開や、読み取り・診断・確認済み操作のやり直しでは再委任しない/);
    assert.match(template, /人の承認が要る操作の承認は残す/);
  }
  const previousRule = instructions.WORKFLOW_RULE.replace('チェック後に変更がなければ、本体反映・公開の前に再チェックしない。人の承認が要る操作の承認は残す。読み取り・診断だけの手順や確認済み操作のやり直しにはチェックを挟まず、書き込む中身・公開する中身・対象が変わる時だけチェックする。', '');
  assert.notEqual(previousRule, instructions.WORKFLOW_RULE);
  const previous = chat.buildTurn({ ...options, basePrompt: base.replace(instructions.WORKFLOW_RULE, previousRule) });
  const meta = { sessions: { claude: 'sid' }, rulesSent: { claude: { ...previous.rules, sid: 'sid' } } };
  const updated = chat.buildTurn({ ...options, basePrompt: base, meta });
  assert.equal(updated.shortRules, false);
  assert.ok(updated.fixed.includes(instructions.WORKFLOW_RULE));
  assert.notEqual(updated.rules.hash, previous.rules.hash);
  assert.deepEqual(fs.readFileSync(roleFile), beforeRoles);
  assert.deepEqual(fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null, beforeLimits);
});

test('Approved credit scope stays consistent in full and compact rules and updates the session version', () => {
  const roles = require('../lib/roles'), file = path.join(root, '_hub/roles.yaml'), before = fs.readFileSync(file);
  const oldPrompt = prompt(), first = chat.buildTurn({ ...options, basePrompt: oldPrompt });
  try {
    const original = roles.read(file).data;
    assert.equal(roles.write(file, original.roles, { claude: false, codex: true }, false, true).ok, true);
    const nextPrompt = prompt(), turn = chat.buildTurn({ ...options, basePrompt: nextPrompt });
    const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
    for (const text of [turn.fixed, full]) {
      assert.match(text, /対象はCodexの確認ON側だけ/);assert.match(text, /購入・自動チャージ・APIキー課金/);
      assert.doesNotMatch(text, /従量課金禁止。|追加課金・API従量課金は使わない。/);
    }
    const resumed = chat.buildTurn({ ...options, basePrompt: nextPrompt, meta: { sessions: { claude: 'sid' }, rulesSent: { claude: { ...first.rules, sid: 'sid' } } } });
    assert.equal(resumed.shortRules, false);
    roles.write(file, original.roles, { codex: false }, false, true);
    assert.doesNotMatch(chat.buildTurn({ ...options, basePrompt: prompt() }).fixed, /既存クレジット優先の承認/);
  } finally { fs.writeFileSync(file, before);prompt(); }
});

test('前置きは基点1回・既存指示を40%以上削減、新しい必須規則は各1回分だけ', () => {
  const turn = chat.buildTurn(options), text = turn.stdin.split('# 今回の依頼')[0];
  const baseline = require('./fixtures/instruction-baseline.json');
  const normalized = value => value.replaceAll(root, '/fixture/AI-Workspace');
  const after = normalized(text).length, before = baseline.prompt.length;
  const copy = path.join(root, 'Work', p.id, 'existing'); fs.mkdirSync(copy, { recursive: true });
  const originalTask = fs.readFileSync(store.taskFile(p.id, t.id), 'utf8');
  fs.writeFileSync(store.taskFile(p.id, t.id), originalTask.replace('state: 実行中', `state: 実行中\nworkdir: ${copy}`));
  const copyText = normalized(chat.buildTurn({ ...options, basePrompt: taskPrompt(p, t, store.taskFile(p.id, t.id), copy) }).stdin.split('# 今回の依頼')[0]);
  fs.writeFileSync(store.taskFile(p.id, t.id), originalTask);
  assert.match(copyText, /［本体に取り込む］がある/);
  console.log(JSON.stringify({ beforeChars: before, afterChars: after, reduction: 1 - after / before, copyBeforeChars: baseline.copyPrompt.length, copyAfterChars: copyText.length, fixedChars: turn.fixed.length }));
  // 比較元にない必須規則だけを各一回追加し、既存指示の上限と重複禁止を保つ。
  const ownerRule = '（ローカル認証は curl -H @"$HUB_HEADERS" を使用。秘密を本文に書かない）';
  assert.equal(text.split(ownerRule).length - 1, 1);
  const addedRule = instructions.SEND_TEXT_RULE.length + instructions.WORKFLOW_RULE.length + chat.PLAIN_CHOICE_RULE.length + ownerRule.length + 3;
  assert.equal(text.split(chat.PLAIN_CHOICE_RULE).length - 1, 1);
  assert.equal(text.split(instructions.SEND_TEXT_RULE).length - 1, 1);
  assert.equal(copyText.split(instructions.SEND_TEXT_RULE).length - 1, 1);
  assert.equal(text.split(instructions.WORKFLOW_RULE).length - 1, 1);
  assert.equal(copyText.split(instructions.WORKFLOW_RULE).length - 1, 1);
  assert.match(instructions.WORKFLOW_RULE, /説明だけで番を終えず/);
  assert.ok(after <= before * .6 + addedRule, `${after}/${before} + ${addedRule}`);
  assert.ok(copyText.length <= baseline.copyPrompt.length * .6 + addedRule, `${copyText.length}/${baseline.copyPrompt.length} + ${addedRule}`);
  assert.match(copyText, /作業用コピー.*本体には触らない/);
  for (const word of ['司令塔＝Claude Code・Fable 5.1', '調査＝', 'デザイン＝', '画像生成＝', 'コーディング＝', 'チェック＝', '文章＝', 'claude-opus-4-6 などの古いモデルは使わない', '裏で起動しない', 'model欄は必須', '新しいプロジェクト', 'やっていない手順に [x]', 'workdir・state・question', '書き換えない', '自分で担当を変えない', '台帳/.ai/chat/existing.rules.md']) assert.ok(text.includes(word), word);
  assert.equal(text.split('台帳=').length - 1, 1);
  assert.equal(text.split(dir).length - 1, 1); // 台帳の絶対パスは1回、cwdは台帳から参照
  const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
  for (const word of ['## 委任', '## 委任の定型', '## 問題点', '## 操作案内', 'curl -s -X POST', 'createHash(\'sha256\').update(text, \'utf8\').digest(\'hex\').slice(0, 16)', '30字まで', '50字まで', '確認待ち', '原文は消さない', 'ボタン名の無い停止', '実装→チェック', 'チェック→報告']) {
    assert.ok(full.includes(word), word);
  }
  const mtime = fs.statSync(path.join(dir, '.ai/chat/existing.rules.md')).mtimeMs;
  prompt(); assert.equal(fs.statSync(path.join(dir, '.ai/chat/existing.rules.md')).mtimeMs, mtime);
});

test('固定指示の委任例は実際のproject・taskと必須ai・model・textを含む', () => {
  const fixed = instructions.split(prompt()).fixed;
  const line = fixed.split('\n').find(line => line.startsWith('【委任】'));
  const example = JSON.parse(line.match(/例(\{[^\n]+\})）/)[1]);
  assert.deepEqual(example, { project: p.id, task: t.id, ai: 'codex', model: 'gpt-6.1-sol', text: '差分' });
  // The fallback uses the ledger folder name; JSON serialization must escape IDs.
  const unusual = instructions.packet({ pdir: dir, task: 'task"quote', policy: '', port: 4545 });
  const fallback = JSON.parse(instructions.split(unusual).fixed.match(/例(\{[^\n]+\})）/)[1]);
  assert.deepEqual(fallback, { ...example, project: path.basename(dir), task: 'task"quote' });
});

test('同じセッションは短文とコピー規則、版・session・5番目・圧縮・失敗後に復元', () => {
  const first = chat.buildTurn(options);
  const meta = { sessions: { claude: 'sid' }, rulesSent: { claude: { ...first.rules, sid: 'sid' } } };
  let turn = chat.buildTurn({ ...options, meta });
  assert.ok(turn.shortRules); assert.ok(turn.fixed.length < 200);
  assert.match(turn.stdin, /操作情報/); assert.match(turn.stdin, /この番の起動/); assert.match(turn.stdin, /長い会話/); assert.match(turn.stdin, /\[\[質問\]\]/);
  for (const sent of [{ ...meta.rulesSent.claude, hash: 'changed' }, { ...meta.rulesSent.claude, sid: 'other' }, { ...meta.rulesSent.claude, turns: 4 }, { ...meta.rulesSent.claude, restore: true }]) {
    assert.equal(chat.buildTurn({ ...options, meta: { ...meta, rulesSent: { claude: sent } } }).shortRules, false);
  }
  assert.equal(chat.buildTurn({ ...options, meta, rows: [{ role: 'assistant', ai: 'codex', error: 'failed', text: 'failed' }] }).shortRules, false);
  assert.equal(chat.parse('claude', { type: 'system', subtype: 'compact_boundary' })[0].kind, 'compact');
  assert.equal(chat.buildTurn({ ...options, meta: { ...meta, sessions: {} } }).shortRules, false);
  assert.notEqual(instructions.split(options.basePrompt.replace('全文版：', '別版：')).hash, first.rules.hash);
});

test('送信用本文の決まりは全文・初回・再開・担当交代で省略されない', () => {
  assert.match(prompt(),/Current Gemini（gemini-current）/);assert.doesNotMatch(prompt(),/Gemini 3\.1 Pro|gemini-3\.1-pro-high/);
  const base = prompt(), first = chat.buildTurn({ ...options, basePrompt: base });
  const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
  assert.match(full, /## 人がコピーして送る文/);
  assert.ok(full.includes(instructions.SEND_TEXT_RULE));
  assert.ok(first.fixed.includes(instructions.SEND_TEXT_RULE));
  const meta = { sessions: { claude: 'sid' }, rulesSent: { claude: { ...first.rules, sid: 'sid' } } };
  const resumed = chat.buildTurn({ ...options, basePrompt: base, meta });
  assert.ok(resumed.shortRules); assert.ok(resumed.fixed.includes(instructions.SEND_TEXT_RULE));
  const handoff = chat.buildTurn({ ...options, basePrompt: base, ai: 'codex', model: 'GPT-6.1-Sol', meta,
    text: buildHandoffCard({ original: 'continue', direct: true }), limitSwitch: { original: 'continue' } });
  assert.ok(handoff.fixed.includes(instructions.SEND_TEXT_RULE));
});

test('カードはHub記録のみ、途中commit/dirty/委任/手順を保持し繰り返さない', () => {
  git(['init', '-q']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@invalid']);
  fs.writeFileSync(path.join(dir, 'file'), 'before'); git(['add', 'file']); git(['commit', '-qm', 'before']);
  const user = { role: 'user', text: 'unique-original', at: '2026-10-06T00:00:00Z', ...snapshot(dir) };
  // .ai/PROJECTも初期から追跡して、何もしなかった時の条件を確認する。
  git(['add', '.']); git(['commit', '-qm', 'fixture']); Object.assign(user, snapshot(dir));
  let card = buildHandoffCard({ original: user.text, user, rows: [user], dir, pdir: dir, task: 'existing' });
  assert.match(card, /操作なし/); assert.match(card, /最初から始めてよい/);
  fs.writeFileSync(path.join(dir, 'file'), 'after'); git(['add', 'file']); git(['commit', '-qm', 'changed']); fs.writeFileSync(path.join(dir, 'dirty'), 'dirty');
  card = buildHandoffCard({ original: user.text, user, rows: [user, ...Array.from({ length: 50 }, (_, i) => ({ tool: true, text: `tool${i} ` + 'x'.repeat(200) }))], dir, pdir: dir, task: 'existing', queue: [{ at: user.at, title: 'already-sent', ai: 'codex', model: 'gpt-6.1-sol' }] });
  assert.match(card, /changed/); assert.match(card, /dirty/); assert.match(card, /already-sent/); assert.match(card, /同じ委任を送り直さない/); assert.match(card, /\[x\] before/); assert.match(card, /最新メモ：- latest progress/); assert.match(card, /道具：50件/); assert.ok(card.split('元の依頼：')[0].length <= 2500);
  const unknown = buildHandoffCard({ original: user.text, user: { ...user, head: null }, rows: [user], dir, pdir: dir, task: 'existing' });
  assert.match(unknown, /確認できない/); assert.doesNotMatch(unknown, /最初から始めてよい/);
});

test('交代時は元依頼1回・直近会話は12000字以下、通常交代は60000字', () => {
  const original = 'unique-original';
  const card = buildHandoffCard({ original, direct: true });
  const rows = [{ role: 'user', text: original, request: 'source' }, ...Array.from({ length: 10 }, () => ({ role: 'assistant', ai: 'claude', text: 'x'.repeat(8000) }))];
  const turn = chat.buildTurn({ ...options, rows, text: card, limitSwitch: { sourceRequest: 'source', original }, task: 'existing' });
  assert.equal(turn.stdin.split(original).length - 1, 1);
  const ctx = chat.contextPacket(rows, { limit: chat.HANDOFF_LIMIT, exclude: { original, request: 'source' }, archive: 'existing' });
  assert.ok(ctx.length <= 12000); assert.match(ctx, /全文を読まない/);
  assert.ok(chat.contextPacket(rows).length > 50000);
});

test('統合した保持は期限不明でも即有効、正式証拠後に開始した取得だけ期限を補完', () => {
  let now = Date.parse('2026-10-06T03:00:00Z'); const state = new LimitEvidence(stateFile, { now: () => now });
  const usage = (pct, fetchedAt = now + 1, reset = now + 7200000) => ({ providers: { claude: { status: 'ok', fetchedAt: new Date(fetchedAt).toISOString(), attemptedAt: new Date(fetchedAt).toISOString(), windows: [{ id: 'five_hour', usedPercent: pct, resetsAt: reset ? new Date(reset).toISOString() : null }] } } });
  state.observe(usage(100)); assert.equal(state.active(), null);
  state.record({}); assert.equal(state.active().validUntil, null);
  state.observe(usage(100, now - 1)); assert.equal(state.active().validUntil, null);
  state.observe(usage(100, now + 1, null)); assert.equal(state.active().validUntil, null);
  state.observe(usage(100, now + 2)); assert.ok(state.active());
  now += 7200000; assert.equal(state.active(), null);
});

test('入力量はCLIのusageだけ記録し、未提供時に文字数から推計しない', () => {
  assert.deepEqual(chat.parse('claude', { type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } }).find(e => e.kind === 'done').usage, { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 });
  assert.deepEqual(chat.parse('codex', { type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 10 } })[0].usage, { input_tokens: 40, cached_input_tokens: 10 });
  assert.equal(chat.parse('codex', { type: 'turn.completed' })[0].usage, undefined);
});


test('長いGitパス/commit件名/複数委任でもカードの判断・委任・残り参照を保持', () => {
  const cwd = path.join(tmp, 'long-card'); fs.mkdirSync(cwd);
  const runGit = args => execFileSync('git', args, { cwd, encoding: 'utf8' });
  runGit(['init', '-q']); runGit(['config', 'user.name', 'fixture']); runGit(['config', 'user.email', 'fixture@invalid']);
  fs.writeFileSync(path.join(cwd, 'file'), 'before'); runGit(['add', '.']); runGit(['commit', '-qm', 'fixture']);
  const user = { role: 'user', text: 'long-card-original', at: '2026-10-06T00:00:00Z', turn: 'source-turn', ...snapshot(cwd) };
  fs.writeFileSync(path.join(cwd, 'file'), 'after'); runGit(['add', '.']); runGit(['commit', '-qm', 'LONG_COMMIT_' + 'x'.repeat(10000)]);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(cwd, `change-${i}-${'a'.repeat(150)}`), 'dirty');
  const queue = Array.from({ length: 10 }, (_, i) => ({ id: 'sent-' + i, sourceTurn: user.turn, title: 'PENDING_' + i + 'x'.repeat(1000), ai: 'codex', model: 'gpt-6.1-sol' }));
  const card = buildHandoffCard({ original: user.text, user, rows: [user, ...Array.from({ length: 50 }, () => ({ tool: true, text: 'tool ' + 'x'.repeat(500) }))], dir: cwd, pdir: dir, task: 'existing', queue });
  const body = card.split('\n\n元の依頼：')[0];
  assert.ok(body.length <= 2500, body.length); assert.match(body, /HEAD変化：あり/); assert.match(body, /未保存：20行/);
  assert.match(body, /送った委任：10件/); assert.match(body, /PENDING_0/); assert.match(body, /同じ委任を送り直さない/);
  assert.match(body, /全件は順番待ちと台帳の操作記録/); assert.match(body, /手順：/); assert.match(body, /\[ \] after/);
  assert.match(body, /台帳\/\.ai\/tasks\/existing.md/); assert.match(body, /実物を確かめてから残りを続ける/);
  assert.equal(card.split(user.text).length - 1, 1);
});

test('統合した保持は未知値や低い値で解除しない', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  const state = new LimitEvidence(path.join(tmp, 'recovery.json'), { now: () => now });
  const general = pct => ({ id: 'five_hour', usedPercent: pct, resetsAt: new Date(now + 7200000).toISOString() });
  const fable = pct => ({ id: 'model:0', label: 'Fable・週間枠', usedPercent: pct, resetsAt: new Date(now + 10800000).toISOString() });
  const usage = (windows, fetchedAt) => ({ providers: { claude: { status: 'ok', fetchedAt: new Date(fetchedAt).toISOString(), attemptedAt: new Date(fetchedAt).toISOString(), windows } } });
  state.record({}); state.observe(usage([general(100), fable(100)], now + 1)); assert.equal(state.active().validUntil, new Date(now + 10800000).toISOString());
  state.observe(usage([general(50), fable(null)], now + 2)); assert.equal(state.active().validUntil, new Date(now + 10800000).toISOString()); assert.ok(state.evidence);
  state.observe(usage([general(100), fable(100)], now + 3)); assert.ok(state.active());
  state.observe(usage([general(50), fable(50)], now + 1)); assert.ok(state.active());
  state.observe(usage([general(50), { ...fable(50), id: 'model:2' }], now + 4)); assert.ok(state.active()); state.clear(); assert.equal(state.active(), null);
});

test('成果と保管ルールは全PJの全文・固定1行と新規ひな形・設計に同文で届く',()=>{
 const { ARTIFACT_POLICY }=require('../lib/artifact-policy');
 const text=prompt(),full=fs.readFileSync(path.join(dir,'.ai/chat/existing.rules.md'),'utf8');
 assert.ok(full.includes(ARTIFACT_POLICY));assert.match(full,/内部で必要な同内容ファイルは間引かない/);assert.match(full,/未受領の内容があるフォルダは残す/);assert.match(text,/成果は作業ファイルの ## 成果 に書く。ZIPは配布時だけ/);
 for(const file of ['../../docs/project-hub/templates/project/.ai/rules.md','../../docs/project-hub/DESIGN.md'])assert.ok(fs.readFileSync(path.join(__dirname,file),'utf8').includes(ARTIFACT_POLICY));
});
