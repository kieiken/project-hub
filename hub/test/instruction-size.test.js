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
fs.writeFileSync(path.join(root, '_hub/ai-tools-models.json'), JSON.stringify({ codex: { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] } }));
Object.assign(process.env, { HUB_ROOT: root, HUB_DRY_RUN: '1', HUB_PORT: '4545', HUB_AI_HOME: path.join(tmp, 'home') });
const { Store } = require('../lib/store');
const store = new Store(root), { taskPrompt, server } = require('../server');
const p = store.readProject('Size fixture'), t = p.tasks[0];
const prompt = () => taskPrompt(p, t, store.taskFile(p.id, t.id), dir);
const options = { ai: 'claude', model: 'Fable 5.1', rows: [], text: 'unique-current', basePrompt: prompt(), meta: {} };
const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const stateFile = path.join(root, '_hub/limits.json');

test('前置きは基点1回・全文を必要時参照、意味を保持して40%以上削減', () => {
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
  assert.ok(after <= before * .6, `${after}/${before}`);
  assert.ok(copyText.length <= baseline.copyPrompt.length * .6, `${copyText.length}/${baseline.copyPrompt.length}`);
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

test('同じセッションは短い1行、版・session・5番目・圧縮・失敗後に復元', () => {
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
