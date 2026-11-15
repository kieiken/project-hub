'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const special = require('../public/special-mode'), { ModelView } = require('../lib/model-view');
const data = { models: { 'claude-code': ['Opus 5.5', 'Fable 5.2', 'Sonnet'], codex: ['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Luna'] }, roles: [
  { name: 'コーディング', main: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' }, backup: { ai: 'claude-code', model: 'Opus 5.5', effort: '中' } },
  { name: 'チェック', main: { ai: 'claude-code', model: 'Fable 5.2', effort: '極高' }, backup: { ai: 'codex', model: 'GPT-6-Astra', effort: '高' } }
] };
test('AIだけを固定しモデルは役割の同AI候補、未知役割は一覧。無効・破損で通常へ戻る', () => {
  const original = JSON.stringify(data);
  assert.deepEqual(special.pick({ enabled: true, ai: 'claude' }, data, 'コーディング'), { ai: 'claude', model: 'Opus 5.5', effort: '中' });
  assert.equal(special.pick({ enabled: true, ai: 'codex' }, data, 'チェック').model, 'GPT-6-Astra');
  assert.equal(special.pick({ enabled: true, ai: 'claude' }, data, 'その他').model, 'Opus 5.5');
  for (const value of [null, {}, { enabled: true, ai: 'agy' }, { enabled: 'true', ai: 'codex' }, { enabled: false, ai: 'claude' }]) assert.equal(special.pick(value, data, 'チェック'), null);
  assert.equal(JSON.stringify(data), original);
});
test('保存失敗は既存設定を保持し、破損ファイルを上書きしない', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-mode-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model-view.json'), view = new ModelView(file);
  view.setSpecial({ enabled: true, ai: 'codex' }); const before = fs.readFileSync(file), rename = fs.renameSync;
  try { fs.renameSync = () => { throw Error('保存失敗'); }; assert.throws(() => view.setSpecial({ enabled: false, ai: 'codex' }), /保存失敗/); } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(dir), ['model-view.json']);
  fs.writeFileSync(file, '{broken'); assert.equal(view.special().enabled, false); assert.throws(() => view.setSpecial({ enabled: true, ai: 'claude' })); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
function ui() {
  const elements = new Map(), events = {}, calls = [], saved = new Map();
  const el = s => { if(s==='.work-compact .work-attention')return null; if (!elements.has(s)) elements.set(s, { innerHTML: '', value: '', hidden: false, dataset: {}, setAttribute() {}, listeners: {}, addEventListener(n, fn) { (this.listeners[n] ||= []).push(fn); }, querySelectorAll: () => [] }); return elements.get(s); };
  const document = { querySelector: el, querySelectorAll: () => [], addEventListener: (n, fn) => (events[n] ||= []).push(fn) };
  const context = vm.createContext({ document, window: { matchMedia: () => ({ matches: false }), HubSpecialMode: special, HubChatHistory: require('../public/chat-history') }, navigator: { userAgent: '' }, localStorage: { getItem: k => saved.get(k) || null, setItem: (k,v) => saved.set(k,v) }, fetch: () => new Promise(() => {}), setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, console, URLSearchParams, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order') });
  const run = source => vm.runInContext(source, context); require('./fixtures/app-source.cjs').loadApp(context);
  context.data = data; context.stub = async (route, body) => { calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); if (context.fail) throw Error('保存失敗'); return { specialMode: body }; };
  run(`state={projects:[],roles:data, specialMode:{enabled:true,ai:'claude'}, efforts:['中','高','極高'],initialPick:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}};view={kind:'settings'};api=stub;toast=()=>{};`);
  return { run, context, el, saved, calls, events };
}
// Model select replacement as well as the browser's absent-value rule.
function chatSelect(f, html) {
  const select = f.el('#chat-ai'); let value = '', markup = '';
  select.options = [];
  select.insertAdjacentHTML = (_, markup) => {
    for (const m of markup.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g)) {
      const option = { value: m[1], disabled: /disabled/.test(m[2]), textContent: m[3], dataset: {} };
      for (const attr of m[2].matchAll(/data-(full|short|phone-suffix)="([^"]*)"/g)) option.dataset[attr[1].replace(/-s/, 'S')] = attr[2];
      select.options.push(option); if (/selected/.test(m[2])) value = option.value;
    }
  };
  Object.defineProperty(select, 'innerHTML', { configurable: true, get: () => markup, set: next => {
    markup = String(next); select.options = []; value = '';
    select.insertAdjacentHTML('beforeend', markup);
  } });
  Object.defineProperty(select, 'value', { configurable: true, get: () => value, set: next => { value = select.options.some(o => o.value === next) ? next : ''; } });
  select.innerHTML = html;
  return select;
}
function draftFixture() {
  const f = ui();
  f.run(`state.projects=[{id:'p',tasks:[{id:'t',role:'チェック',owner:'codex',model:'GPT-6.1-Sol'}]}];state.sessions=[];state.chatting=[];state.unread=[];
    view={kind:'project',project:'p'};drawShellAlerts=()=>{};drawChatAccount=()=>{};
    p=proj('p');t=p.tasks[0];`);
  return f;
}
test('R1: load・refreshTree・pollの設定採用で入力済みquickDraftを更新し、本文・添付・受付済みキュー・rolesを保持', async () => {
  for (const route of ['load({preserveMain:true})', 'refreshTree()', 'pollState()']) {
    const f = draftFixture();
    f.run(`Object.assign(quickDraft(p),{text:'入力途中',images:[{id:'img',name:'画像',url:'/img'}]});
      state.queue=[{ai:'claude',model:'Opus 5.5',text:'受付済み'}];
      fetchState=async()=>({...state,specialMode:{enabled:true,ai:'codex'}});
      render=renderTree=showInTree=showVersion=updateTurnCounts=syncAccountPickers=syncMaintenanceControls=()=>{};
      document.activeElement={tagName:'TEXTAREA'};`);
    const before = f.run('JSON.stringify([state.roles,state.queue,quickDraft(p).images])');
    await f.run(route);
    assert.equal(f.run('quickDraft(p).ai'), 'codex', route);
    assert.equal(f.run('quickDraft(p).model'), 'GPT-6.1-Sol', route);
    assert.equal(f.run('quickDraft(p).text'), '入力途中');
    assert.equal(f.run('JSON.stringify([state.roles,state.queue,quickDraft(p).images])'), before);
    assert.match(f.el('#quick-controls').innerHTML, /value="codex" selected/);
  }
});
test('R1: quickの手動選択と開始中・再送待ちは保持し、次依頼から特殊モードへ戻る', async () => {
  const f = draftFixture();
  const change = f.events.change.find(fn => fn.toString().includes("'quick-ai'"));
  await change({ target: { id:'quick-ai',value:'claude',closest:()=>({dataset:{p:'p'}}) } });
  await change({ target: { id:'quick-model',value:'Sonnet',closest:()=>({dataset:{p:'p'}}) } });
  f.run(`adoptState({...state,specialMode:{enabled:true,ai:'codex'}})`);
  assert.equal(f.run('quickDraft(p).model'), 'Sonnet');
  const submit = f.events.submit.find(fn => fn.toString().includes("'quickform'"));
  f.run(`warnChildren=()=>true;load=async()=>{};quickDraft(p).text='明示の依頼'`);
  await submit({ target: { id:'quickform',classList:{contains:()=>false},dataset:{p:'p'},elements:{namedItem:()=>({value:'明示の依頼'})} },preventDefault(){} });
  assert.equal(f.calls.at(-1).body.model, 'Sonnet');
  assert.equal(f.run('quickDraft(p).model'), 'GPT-6.1-Sol');
  for (const guard of ['quickStarting.add("p")', 'quickDraft(p).request="retry"', 'quickDraft(p).task="accepted"']) {
    const g = draftFixture(); g.run(`quickDraft(p);${guard};adoptState({...state,specialMode:{enabled:true,ai:'codex'}})`);
    assert.equal(g.run('quickDraft(p).ai'), 'claude', guard);
  }
});
test('R1: ON/OFFと同画面の保存でも下書きの既定を更新し、手動指定は保持', async () => {
  const f = draftFixture();
  f.run('quickDraft(p);adoptState({...state,specialMode:{enabled:false,ai:"claude"}})');
  assert.equal(f.run('quickDraft(p).ai'), 'codex');
  f.run('adoptState({...state,specialMode:{enabled:true,ai:"claude"}})');
  assert.equal(f.run('quickDraft(p).ai'), 'claude');
  await f.run('saveSpecialMode({enabled:true,ai:"codex"})');
  assert.equal(f.run('quickDraft(p).ai'), 'codex');
});
test('R1/R2: 入力中の会話を再描画せず最新既定へ同期し、明示選択は次の送信まで保持', () => {
  const f = draftFixture(); f.run(`view={kind:'work',project:'p',task:'t'};chatDraft['["p","t"]']='本文';chatImages('p','t').push({id:'img'});`);
  const select = chatSelect(f, f.run('chatHtml(p,t)'));
  f.el('#chat-in').value = '入力途中';
  f.run(`adoptState({...state,specialMode:{enabled:true,ai:'codex'}})`);
  assert.equal(select.value, 'codex|GPT-6-Astra');
  assert.equal(f.el('#chat-in').value, '入力途中'); assert.equal(f.run('chatImages("p","t")[0].id'), 'img');
  f.run(`specialOverrides.set('p/t',{ai:'claude',model:'Sonnet',effort:'中'});adoptState({...state,specialMode:{enabled:true,ai:'claude'}})`);
  assert.equal(select.value, 'claude|Sonnet');
  f.run(`specialOverrides.delete('p/t');syncSpecialPick(p,t)`);
  assert.equal(select.value, 'claude|Fable 5.2');
});
// Bind the actual composer listeners/send closure, stopping before unrelated queue/history loading.
function chatComposer(f) {
  const source = require('./fixtures/app-source.cjs').readApp();
  const start = source.indexOf('function openChat(p, t, savedScroll) {');
  const end = source.indexOf('  updateWorkAnswerControls();\n  bindAskAnswers', start);
  assert.ok(start >= 0 && end > start);
  f.run(`updateWorkAnswerControls=()=>{};scroll=()=>{};warnChildren=()=>true;workMode=()=> 'chat';
    ${source.slice(start, end).replace('function openChat', 'function bindComposer')}\n}\nbindComposer(p,t);`);
  return {
    change: (selector, value) => { const el = f.el(selector); el.value = value; for (const fn of el.listeners.change || []) fn({ target: el }); },
    send: () => f.run('sendWorkAnswer.send(undefined)')
  };
}
for (const route of ['load({preserveMain:true})', 'refreshTree()', 'pollState()']) {
  test(`R1残件: OFF時の会話手動指定と思考を${route}のON採用・送信失敗まで保持し受付後に復帰`, async () => {
    const f = draftFixture();
    f.run(`state.specialMode={enabled:false,ai:'claude'};view={kind:'work',project:'p',task:'t'};
      render=renderTree=showInTree=showVersion=updateTurnCounts=syncAccountPickers=syncMaintenanceControls=()=>{};
      document.activeElement={tagName:'TEXTAREA'};
      fetchState=async()=>({...state,specialMode:{enabled:true,ai:'codex'}});`);
    const select = chatSelect(f, f.run('chatHtml(p,t)'));
    const composer = chatComposer(f);
    composer.change('#chat-ai', 'claude|Sonnet'); composer.change('#chat-effort', '中');
    f.el('#chat-in').value = '入力中';
    f.run(`chatImages('p','t').push({id:'img',path:'/fixture.png'});state.queue=[{text:'受付済み',ai:'claude',model:'Fable 5.2'}];`);
    const before = f.run('JSON.stringify([state.roles,state.queue,chatImages("p","t")])');
    await f.run(route);
    assert.equal(select.value, 'claude|Sonnet'); assert.equal(f.el('#chat-effort').value, '中');
    assert.equal(f.el('#chat-in').value, '入力中');
    assert.equal(f.run('JSON.stringify([state.roles,state.queue,chatImages("p","t")])'), before);
    f.context.fail = true;
    assert.equal(await composer.send(), false);
    assert.equal(f.calls.at(-1).body.ai, 'claude'); assert.equal(f.calls.at(-1).body.model, 'Sonnet'); assert.equal(f.calls.at(-1).body.effort, '中');
    f.run(`adoptState({...state,specialMode:{enabled:true,ai:'claude'}})`);
    await f.run(route);
    assert.equal(select.value, 'claude|Sonnet'); assert.equal(f.el('#chat-effort').value, '中');
    assert.equal(f.el('#chat-in').value, '入力中'); assert.equal(f.run('chatImages("p","t").length'), 1);
    assert.equal(f.run('specialOverrides.has("p/t")'), true);
    f.context.fail = false;
    f.run(`api=async(route,body)=>{await stub(route,body);return {queued:true,queue:1};}`);
    assert.equal(await composer.send(), true);
    assert.equal(f.calls.at(-1).body.model, 'Sonnet'); assert.equal(f.calls.at(-1).body.effort, '中');
    assert.equal(f.run('specialOverrides.has("p/t")'), false);
    assert.equal(select.value, 'codex|GPT-6-Astra'); assert.equal(f.el('#chat-effort').value, '高');
    assert.equal(f.el('#chat-in').value, ''); assert.equal(f.run('chatImages("p","t").length'), 0);
    f.el('#chat-in').value = '次の依頼';
    assert.equal(await composer.send(), true);
    assert.equal(f.calls.at(-1).body.ai, 'codex'); assert.equal(f.calls.at(-1).body.model, 'GPT-6-Astra'); assert.equal(f.calls.at(-1).body.effort, '高');
  });
}
test('R1残件: 過去の保存選択とOFF時の受付済み選択を現在の手動指定にしない', async () => {
  for (const accepted of [false, true]) {
    const f = draftFixture(); f.run(`state.specialMode={enabled:false,ai:'claude'};view={kind:'work',project:'p',task:'t'};`);
    f.saved.set('hub-chat-p/t', JSON.stringify({ai:'claude',model:'Sonnet',effort:'中'}));
    const select = chatSelect(f, f.run('chatHtml(p,t)')); const composer = chatComposer(f);
    if (accepted) {
      composer.change('#chat-ai', 'claude|Sonnet'); composer.change('#chat-effort', '中');
      f.el('#chat-in').value = 'OFFで受付';
      f.run(`api=async(route,body)=>{await stub(route,body);return {queued:true,queue:1};}`);
      assert.equal(await composer.send(), true);
    }
    assert.equal(f.run('specialOverrides.has("p/t")'), false);
    f.run(`adoptState({...state,specialMode:{enabled:true,ai:'codex'}})`);
    assert.equal(select.value, 'codex|GPT-6-Astra'); assert.equal(f.el('#chat-effort').value, '高');
  }
});
test('R2: 再描画で隠れた復帰先をoptionへ戻して選択し、表示名・正式ID・非表示設定を保持', async () => {
  for (const model of ['Fable 5.2', 'claude-fable-5-2']) {
    const f = draftFixture();
    f.run(`state=JSON.parse(JSON.stringify(state));state.roles.roles[1].main.model=${JSON.stringify(model)};
      state.cliFlags={claude:{'Fable 5.2':'claude-fable-5-2'}};state.hiddenModels={'claude-code':['Fable 5.2']};
      view={kind:'work',project:'p',task:'t'};specialOverrides.set('p/t',{ai:'codex',model:'GPT-6.1-Sol',effort:'高'});`);
    const html = f.run('chatHtml(p,t)');
    assert.doesNotMatch(html, /value="claude\|Fable 5.2"/);
    const select = chatSelect(f, html);
    const composer = chatComposer(f); f.el('#chat-in').value = '一時指定';
    f.run(`api=async(route,body)=>{await stub(route,body);return {queued:true,queue:1};}`);
    assert.equal(await composer.send(), true);
    assert.equal(f.calls.at(-1).body.model, 'GPT-6.1-Sol');
    assert.equal(select.value, 'claude|Fable 5.2');
    const option = select.options.find(o => o.value === select.value);
    assert.equal(option.dataset.full, 'Claude Code・Fable 5.2'); assert.equal(option.disabled, false);
    assert.equal(f.el('#chat-effort').value, '極高');
    assert.equal(f.run('JSON.stringify(state.hiddenModels)'), '{"claude-code":["Fable 5.2"]}');
    f.run('syncSpecialPick(p,t)'); assert.equal(select.options.filter(o => o.value === 'claude|Fable 5.2').length, 1);
    f.el('#chat-in').value = '復帰後'; assert.equal(await composer.send(), true);
    assert.equal(f.calls.at(-1).body.ai, 'claude'); assert.equal(f.calls.at(-1).body.model, 'Fable 5.2'); assert.equal(f.calls.at(-1).body.effort, '極高');
  }
});
test('画面：過去の選択よりモード優先、手動指定は一度だけ、同AIの別モデルも可能、OFFで従来選択', () => {
  const f = ui(); f.context.p = { id: 'p' }; f.context.t = { id: 't', role: 'チェック', owner: 'codex', model: 'GPT-6.1-Sol' };
  f.saved.set('hub-chat-p/t', JSON.stringify({ ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' }));
  assert.equal(f.run('chatPick(p,t).ai'), 'claude'); assert.equal(f.run('chatPick(p,t).model'), 'Fable 5.2');
  f.run(`specialOverrides.set('p/t',{ai:'codex',model:'GPT-6-Luna',effort:'中'})`); assert.equal(f.run('chatPick(p,t).model'), 'GPT-6-Luna');
  f.run(`specialOverrides.delete('p/t')`); assert.equal(f.run('chatPick(p,t).ai'), 'claude');
  f.run(`specialOverrides.set('p/t',{ai:'claude',model:'Sonnet',effort:'高'})`); assert.equal(f.run('chatPick(p,t).model'), 'Sonnet');
  f.run(`state.specialMode.enabled=false`); assert.equal(f.run('chatPick(p,t).ai'), 'codex');
});
test('画面：ON/OFF・AI選択・即時保存、失敗時の復元、他の設定を保持', async () => {
  const f = ui(), roles = f.run('JSON.stringify(state.roles)');
  assert.match(f.run('specialModeHtml()'), /special-mode-on[^>]+checked/); assert.match(f.run('specialModeHtml()'), /value="claude" selected/);
  await f.run(`saveSpecialMode({enabled:true,ai:'codex'})`); assert.deepEqual(f.calls[0], { route: '/api/special-mode', body: { enabled: true, ai: 'codex' } });
  assert.equal(f.run('state.specialMode.ai'), 'codex'); assert.equal(f.run('JSON.stringify(state.roles)'), roles);
  f.context.fail = true; await f.run(`saveSpecialMode({enabled:false,ai:'claude'})`); assert.equal(f.run('state.specialMode.enabled'), true); assert.equal(f.run('state.specialMode.ai'), 'codex');
});
