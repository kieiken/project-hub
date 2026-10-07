'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const order = require('../public/model-order'), { ModelView } = require('../lib/model-view');
const models = { 'claude-code': ['Opus', 'Fable'], codex: ['Sol', 'Astra'], agy: ['Gemini'] };
const defaults = ['claude-code|Opus','claude-code|Fable','codex|Sol','codex|Astra','agy|Gemini'];
const mixed = ['codex|Astra','claude-code|Fable','codex|Sol','agy|Gemini','claude-code|Opus'];
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-order-test-')),file=path.join(root,'model-view.json');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return {file,view:new ModelView(file)};
}
test('保存なしはAIと候補の元の順、混在順を適用し入力を変えない',()=>{
  assert.deepEqual(order.ordered(models),defaults);const saved=mixed.slice();assert.deepEqual(order.ordered(models,saved),mixed);assert.deepEqual(saved,mixed);
  assert.deepEqual(order.ordered(models,['bad',null,'codex|Astra','codex|Astra']),['codex|Astra','codex|Sol','claude-code|Opus','claude-code|Fable','agy|Gemini']);
});
test('新候補は同AIの最後へ、消失・非表示・復帰で既存の位置を保持',()=>{
  const missing={...models,codex:['Sol']};assert.deepEqual(order.ordered(missing,mixed),mixed.filter(x=>x!=='codex|Astra'));
  const next=['claude-code|Opus','codex|Sol','claude-code|Fable','agy|Gemini'];
  const retained=order.retainMissing(mixed,next);assert.equal(retained[0],'codex|Astra');assert.deepEqual(order.ordered(missing,retained),next);
  assert.deepEqual(order.ordered(models,retained),['codex|Astra',...next]);
  const more={...models,codex:['Sol','Astra','Luna'],'claude-code':['Opus','Fable','Sonnet']};
  assert.deepEqual(order.ordered(more,mixed),['codex|Astra','claude-code|Fable','codex|Sol','codex|Luna','agy|Gemini','claude-code|Opus','claude-code|Sonnet']);
});
test('並びと非表示を相互保持、未知の設定も保持、再生成後も同じ。リセットは非表示を保持',t=>{
  const {file,view}=fixture(t);fs.writeFileSync(file,JSON.stringify({hidden:{codex:['Sol']},future:{keep:true}}));
  assert.equal(view.setOrder(mixed,defaults,models).error,undefined);view.setHidden('claude-code','Fable',true);
  const again=new ModelView(file);assert.deepEqual(again.saved(),mixed);assert.deepEqual(again.hidden(),{'claude-code':['Fable'],codex:['Sol'],agy:[],grok:[]});assert.deepEqual(JSON.parse(fs.readFileSync(file)).future,{keep:true});
  again.setHidden('codex','Sol',false);assert.deepEqual(again.saved(),mixed);
  assert.equal(again.setOrder([],mixed,models).error,undefined);assert.deepEqual(again.hidden()['claude-code'],['Fable']);assert.deepEqual(order.ordered(models,again.saved()),defaults);
});
test('形式・重複・上限と同時更新は400/409でファイルを変えない',t=>{
  const {file,view}=fixture(t);view.setOrder(mixed,defaults,models);const before=fs.readFileSync(file);
  for(const bad of [null,{},['x|a'],['codex|'],['codex|a|b'],['codex|x','codex|x'],['codex|a\n'],Array.from({length:501},(_,i)=>'codex|'+i)])assert.equal(view.setOrder(bad,mixed,models).status,400);
  assert.equal(view.setOrder(defaults,defaults,models).status,409);assert.equal(view.setOrder([],null,models).status,400);assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(view.setOrder([...mixed,'codex|候補未取得'],mixed,models).error,undefined);
});
test('保存失敗は元ファイルと非表示を保持し、一時ファイルを残さない',t=>{
  const {file,view}=fixture(t);view.setOrder(mixed,defaults,models);const before=fs.readFileSync(file),rename=fs.renameSync;
  try{fs.renameSync=()=>{throw Error('見本の保存失敗');};assert.throws(()=>view.setOrder(defaults,mixed,models),/見本/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(path.dirname(file)),['model-view.json']);
  fs.writeFileSync(file,'{broken');assert.deepEqual(view.saved(),[]);assert.throws(()=>view.setHidden('codex','Sol',true));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('並べ替え前後でfake CLIが受け取る --model と思考は同一',t=>{
  const {file,view}=fixture(t), fake=path.join(path.dirname(file),'fake-codex');
  fs.writeFileSync(fake,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(process.argv.slice(2))));\n`,{mode:0o700});
  const {buildTurn}=require('../lib/chat'),{spawnSync}=require('node:child_process');
  const pick={ai:'codex',model:'GPT-6.1-Sol',effort:'極高',meta:{},rows:[],text:'隔離見本',perm:'./fake-codex'};
  const receive=()=>{const turn=buildTurn(pick),r=spawnSync(turn.command,turn.args,{cwd:path.dirname(file),input:turn.stdin,encoding:'utf8'});assert.equal(r.status,0,r.error?.message||r.stderr);return JSON.parse(r.stdout);};
  const before=receive();view.setOrder(mixed,defaults,models);const after=receive();
  assert.deepEqual(after,before);assert.equal(after[after.indexOf('--model')+1],'gpt-6.1-sol');assert.ok(after.includes('model_reasoning_effort=xhigh'));
});

test('初期AIは未設定・形式不正でSol高、保存/再読込と表示・順の相互保持', t => {
  const { file, view } = fixture(t), catalog = { 'claude-code': ['Opus 5.5'], codex: ['GPT-6.1-Sol'] };
  assert.deepEqual(view.initial(), { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  fs.writeFileSync(file, JSON.stringify({ initial: { ai: 'agy', model: 'Gemini', effort: '高' }, future: true }));
  assert.equal(view.initial().ai, 'codex');
  view.setHidden('codex', 'Sol', true); view.setOrder(mixed, defaults, models);
  const spec = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
  assert.deepEqual(view.setInitial({ ...spec, model: 'claude-opus-5-5' }, catalog).initialPick, spec);
  const fresh = new ModelView(file); assert.deepEqual(fresh.initial(), spec);
  assert.deepEqual(fresh.saved(), mixed); assert.ok(fresh.hidden().codex.includes('Sol'));
  fresh.setOrder([], mixed, models); fresh.setHidden('codex', 'Sol', false);
  assert.deepEqual(fresh.initial(), spec); assert.equal(JSON.parse(fs.readFileSync(file)).future, true);
  const before = fs.readFileSync(file);
  for (const bad of [null, {}, { ...spec, ai: 'agy' }, { ...spec, ai: '人' }, { ...spec, model: 'unknown' }, { ...spec, effort: 'low' }]) {
    assert.equal(fresh.setInitial(bad, catalog).status, 400); assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.equal(fresh.setInitial(spec, catalog, () => '利用不可').status, 400);
  assert.deepEqual(fs.readFileSync(file), before);
  const rename = fs.renameSync;
  try { fs.renameSync = () => { throw Error('保存失敗'); }; assert.throws(() => fresh.setInitial({ ...spec, effort: '高' }, catalog), /保存失敗/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-view.json']);
});

test('スマホ表示は未設定・壊れた設定で短い名前、保存と他設定の相互保持', t => {
  const { file, view } = fixture(t), catalog = { 'claude-code': ['Opus 5.5'], codex: ['GPT-6.1-Sol'] };
  const empty = { labels: 'short', names: {} };
  assert.deepEqual(view.phone(), empty);
  fs.writeFileSync(file, '{broken'); assert.deepEqual(view.phone(), empty);
  for (const phone of [null, [], { labels: 'bad', names: {} }, { labels: 'full', names: [] }]) {
    fs.writeFileSync(file, JSON.stringify({ phone })); assert.deepEqual(view.phone(), empty);
  }
  const initial = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
  fs.writeFileSync(file, JSON.stringify({ hidden: { codex: ['Sol'] }, order: mixed, initial, future: true }));
  const key = 'codex|GPT-6.1-Sol';
  assert.deepEqual(view.setPhone({ key, name: ' ソル ' }, catalog).phoneLabels, { labels: 'short', names: { [key]: 'ソル' } });
  assert.equal(view.setPhone({ labels: 'full' }, catalog).phoneLabels.labels, 'full');
  view.setOrder([], mixed, models); view.setHidden('claude-code', 'Fable', true); view.setInitial(initial, catalog);
  assert.deepEqual(new ModelView(file).phone(), { labels: 'full', names: { [key]: 'ソル' } });
  assert.ok(view.hidden().codex.includes('Sol')); assert.deepEqual(view.initial(), initial);
  assert.equal(JSON.parse(fs.readFileSync(file)).future, true);
  view.setPhone({ key: 'chatgpt|app', name: '貼り付け' }, catalog);
  assert.equal(view.phone().names['chatgpt|app'], '貼り付け');
  view.setPhone({ key, name: '' }, catalog); assert.equal(view.phone().names[key], undefined);
  view.setPhone({ key: 'chatgpt|app', name: ' ' }, catalog); assert.deepEqual(view.phone().names, {});
});

test('スマホ表示の不正入力・保存失敗は記録を保護、壊れた名前は読み取りから除く', t => {
  const { file, view } = fixture(t), catalog = { codex: ['GPT-6.1-Sol'] }, key = 'codex|GPT-6.1-Sol';
  view.setPhone({ key, name: 'あ'.repeat(24) }, catalog); const before = fs.readFileSync(file);
  for (const bad of [null, [], {}, { labels: 'tiny' }, { labels: 'short', extra: true }, { key: 'codex|unknown', name: 'x' }, { key: 'claude|Opus', name: 'x' }, { key, name: 'あ'.repeat(25) }, { key, name: 'x\ny' }, { key, name: 'x\ry' }, { key, name: '\t' }, { key, name: 123 }, { key, name: 'x', labels: 'short' }]) {
    assert.equal(view.setPhone(bad, catalog).status, 400); assert.deepEqual(fs.readFileSync(file), before);
  }
  const rename = fs.renameSync;
  try { fs.renameSync = () => { throw Error('保存失敗'); }; assert.throws(() => view.setPhone({ labels: 'full' }, catalog), /保存失敗/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-view.json']);
  fs.writeFileSync(file, JSON.stringify({ phone: { labels: 'short', names: { [key]: 'ソル', 'bad|key': 'bad', 'chatgpt|app': 'bad\nname', 'codex|old': 'あ'.repeat(25) } } }));
  assert.deepEqual(view.phone(), { labels: 'short', names: { [key]: 'ソル' } });
  fs.writeFileSync(file, '{broken'); assert.throws(() => view.setPhone({ labels: 'full' }, catalog)); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
