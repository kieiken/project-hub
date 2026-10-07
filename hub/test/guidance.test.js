'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const { guidance } = require('../lib/guidance');
const p = { name: '人物の分析', status: '進行中', phases: [], tasks: [] };
const t = { title: '出生候補を比較する', state: '実行中', steps: [{ done: false }], question: '' };
const info = (task = {}, options = {}, project = {}) => guidance({ ...p, ...project }, { ...t, ...task }, options);
const operation = (text, label) => text.split('\n').find(line => line.startsWith(label + '：'));

test('完了確認は同じ画面の黄色い帯で行い、コピーなしでは取り込ませない', () => {
  const text = info({ completionPending: true });
  assert.match(text, /黄色い帯.*［完了に移す］［まだ続ける］/);
  assert.match(text, /［あなたの番］の［完了確認］/);
  assert.match(text, /取り込みは不要/);
  assert.doesNotMatch(text, /［本体に取り込む］がある/);
  assert.match(text, /この返事が終わってから/);
  assert.match(text, /この作業1つだけ（フェーズ・全体は完了にしない）/);
});
test('手順途中・まだ続けるの後は帯なしの作業操作だけを示す', () => {
  for (const steps of [[{ done: false }], [{ done: true }]]) {
    const line = operation(info({ steps, completionPending: false }), '作業の完了');
    assert.match(line, /［完了に移す］がある/);
    assert.doesNotMatch(line, /黄色い帯「/);
  }
});
test('質問がある時は完了確認より回答を優先する', () => {
  const text = info({ question: '比較方法を選んでください', completionPending: true });
  assert.match(text, /質問への返事が先/);
  assert.doesNotMatch(text, /［完了に移す］/);
});
test('完了済みは再開を示す', () => {
  const line = operation(info({ state: '完了', question: '古い質問' }), '作業の完了');
  assert.match(line, /［再開する］がある/);
  assert.doesNotMatch(line, /［完了に移す］/);
});
test('コピーあり・対象外・欠落の操作を分ける', () => {
  assert.match(info({}, { copy: true }), /［本体に取り込む］がある/);
  const excluded = info({ mergeExcluded: true }, { copy: true });
  assert.match(excluded, /［取り込み対象に戻す］がある/);
  assert.doesNotMatch(excluded, /［本体に取り込む］がある/);
  const missing = info({}, { copyMissing: true });
  assert.match(missing, /［記録を片付ける］がある/);
  assert.match(missing, /取り込みではない/);
});
test('フェーズの途中・最終・継続・全体完了を区別する', () => {
  const project = { phases: [{ name: '調査', state: '進行中' }, { name: '執筆', state: '未着手' }], tasks: [{ phase: '調査', state: '完了' }] };
  const text = info({}, {}, project);
  assert.match(operation(text, 'フェーズ'), /［次のフェーズ「執筆」へ進む］/);
  assert.doesNotMatch(operation(text, '作業の完了'), /プロジェクトを完了にする/);
  assert.match(operation(text, 'プロジェクト全体'), /［プロジェクトを完了にする］/);
  assert.match(operation(info({}, {}, { ...project, phases: project.phases.slice(0, 1) }), 'フェーズ'), /最終フェーズなので全体も完了/);
  assert.match(operation(info({}, {}, { ...project, phaseContinueKey: 'same', phaseOfferKey: 'same' }), 'フェーズ'), /確認帯はまだ無い/);
  assert.match(operation(info({}, {}, { status: '完了' }), 'プロジェクト全体'), /［完了を取り消す］/);
  assert.match(operation(info(), 'フェーズ'), /設定されていない/);
  assert.match(operation(info({}, {}, { phases: [{ name: '調査', state: '完了' }] }), 'フェーズ'), /すべて完了済み/);
});
test('長い同名の作業・引用符・改行は内部IDを探させず名前で伝える', () => {
  const title = '「引用」を含む長い名前'.repeat(10) + '\n次の行';
  const a = info({ id: 'a', title }), b = info({ id: 'b', title });
  assert.equal(a, b);
  assert.ok(a.includes(title.replace('\n', ' ')));
  assert.ok(!a.includes('\n次の行'));
  assert.match(a, /プロジェクト「人物の分析」/);
});
test('会話とターミナルで画面を断定せず、送信時点の情報として渡す', () => {
  assert.match(info(), /この作業の会話画面なら/);
  assert.match(info({}, { where: 'terminal' }), /ターミナルか別の画面/);
  assert.match(info(), /順番待ち・作業中に変わる/);
  assert.match(info(), /あなたは人の画面を見ていない/);
});
test('単独のHub誘導なし・通常の案内は1200字以内', () => {
  const text = info({ completionPending: true }, { copy: true });
  assert.doesNotMatch(text, /Hub ?で/);
  assert.ok(text.length <= 1200);
});

test('停止が必要な時の場所とボタンは実画面の切替とAI欄に一致する', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ui = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const text = info();
  assert.match(text, /ボタン名の無い停止や終了の操作を頼まない/);
  assert.match(text, /理由・場所（作業画面の［ターミナル］の、その AI の欄）・ボタン（［停止］）/);
  assert.match(text, /画面を切り替えただけでは止まらない/);
  assert.doesNotMatch(text, /ターミナルのAIを終了/);
  assert.match(ui, /data-act="mode"[^>]*data-m="term"[^>]*>ターミナル\$\{running.length/);
  assert.match(ui, /data-act="mode"[^>]*data-m="chat"[^>]*>会話<\/button>/);
  assert.match(ui, /data-act="stop" data-ai="\$\{a\}"[^>]*>停止<\/button>/);
});

test('子作業とプロジェクト間の派生にも成果引渡しと条件付きの本番確認を案内する',()=>{
  const p={name:'親プロジェクト',id:'p',tasks:[{id:'main',title:'本作業'}],phases:[]};
  const child={id:'small',title:'小作業',parent:'main',steps:[],state:'完了'};
  assert.match(guidance(p,child),/［成果を渡す］.*渡す先は「本作業」/);
  assert.match(guidance(p,child,{copy:true}),/祖先作業「本作業」.*［統合…］/);
  assert.doesNotMatch(guidance(p,child,{copy:true}),/［本体に取り込む］がある/);
  const q={...p,id:'q',tasks:[]},derived={...child,kind:'derived',derivedFrom:'p/main'};
  assert.match(guidance(q,derived,{projects:[p,q]}),/渡す先は「本作業」/);
  assert.match(guidance(p,child),/必要に応じGitHubへの更新/);
});

test('対象外の子を戻す案内も表示し、直接取り込みは案内しない',()=>{
 const parent={id:'parent',title:'親作業',steps:[],state:'実行中'},child={id:'child',parent:'parent',title:'対象外',steps:[],state:'完了',mergeExcluded:true};
 const p={id:'p',name:'親',tasks:[parent,child],phases:[]};const text=guidance(p,child,{copy:true});
 assert.match(text,/［取り込み対象に戻す］がある/);assert.match(text,/戻してから祖先で統合/);assert.doesNotMatch(text,/［本体に取り込む］がある/);
});

test('成果整理中・不備ありは完了確認や引渡しを案内しない',()=>{
 for(const auto of ['running','failed']) {
  const text=info({completionPending:false,resultsPending:{auto,reason:'書式不正'}});
  assert.doesNotMatch(operation(text,'作業の完了'),/［完了に移す］|黄色い帯/);
  assert.match(operation(text,'作業の完了'),auto==='running'?/成果の記録を整えています/:/［成果の整理を頼む］/);
 }
});
