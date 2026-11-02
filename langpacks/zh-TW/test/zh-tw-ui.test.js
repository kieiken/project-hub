'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.resolve(__dirname, '../../../hub/public');
const source = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
const kana = /[\u3041-\u3096\u30a1-\u30fa]/u;
function locale(language) {
  const context = vm.createContext({ HUB_LOCALE: language ? { locale: language, messages: require('../ui.json') } : undefined });
  vm.runInContext(source('locale.js'), context);
  return context.HubI18n;
}
function uiStringLiterals(text) {
  return [...text.matchAll(/UI\.(text|html)\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/g)];
}
function missingUiTranslations(files) {
  const zh = locale('zh-TW'), missing = [];
  for (const { file, text } of files) {
    for (const match of uiStringLiterals(text)) {
      const value = vm.runInNewContext(match[2]);
      if (kana.test(zh[match[1]](value))) missing.push({ file, text: value });
    }
  }
  return missing;
}
function app() {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false,
      addEventListener() {}, setAttribute() {}, contains() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { contains() { return false; }, toggle() {} } });
    return elements.get(key);
  };
  const document = { documentElement: {}, hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ HUB_LOCALE: { locale: 'zh-TW', messages: require('../ui.json') }, document, window: {}, navigator: { userAgent: '' },
    localStorage: { getItem() { return null; }, setItem() {} }, fetch: () => new Promise(() => {}),
    EventSource: class { close() {} }, URLSearchParams, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame: fn => fn(), console, ModelOrder: require('../../../hub/public/model-order'), ProjectOrder: require('../../../hub/public/project-order') });
  vm.runInContext(source('locale.js'), context);
  context.window.HubChatHistory = require('../../../hub/public/chat-history');
  // Load the same optional feature as the app; a missing mock hid its UI.
  if (fs.existsSync(path.join(publicDir, 'paid/webchat.js'))) vm.runInContext(source('paid/webchat.js'), context);
  require('./ui-locale-fixture').loadApp(context);
  const snapshot = {
    root: '/資料/プロジェクト', projects: [{ id: 'p', name: 'プロジェクトの原名', status: '進行中', parent: '',
      description: 'そのまま残す説明', updated: '', phases: [], folders: [], related: [], issues: [], chats: [],
      tasks: [{ id: 't', title: 'ユーザーの作業名', state: '返事待ち', owner: 'codex', role: 'コーディング', model: 'GPT-6.1-Sol',
        effort: '極高', phase: '', steps: [], skills: [], question: 'どちらにしますか？', next: '', copy: false }] }],
    roles: { models: { codex: ['GPT-6.1-Sol'], 'claude-code': ['Opus 5.5'] }, roles: [
      { name: 'コーディング', job: 'プログラムを書く', main: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' }, backup: { ai: '人' } }
    ], permissions: {}, agents: [] }, sessions: [], chatting: [], terminal: true, efforts: ['中', '高', '極高'], cliFlags: {}, version: '1', latest: '1'
  };
  vm.runInContext('state = ' + JSON.stringify(snapshot) + '; view = {kind:"work",project:"p",task:"t"}', context);
  return { context, element, snapshot, run: code => vm.runInContext(code, context) };
}

test('通知3区分の件数とタブを繁体字で示し、完了承認の操作を保持する', () => {
  const a=app();
  a.run('state.projects[0].tasks[0].question="";state.projects[0].tasks[0].state="未着手";state.projects[0].tasks[0].chatQueueCount=1;state.projects[0].tasks.push({...state.projects[0].tasks[0],id:"done",chatQueueCount:0,completionPending:true});view={kind:"turn",project:"p"};render()');
  assert.equal(a.element('#turn-n').textContent,'等待回覆 0');
  assert.equal(a.element('#turn-work-n').textContent,'作業中 1');
  assert.equal(a.element('#turn-done-n').textContent,'完成 1');
  assert.match(a.element('#main').innerHTML,/等待回覆（0）.*作業中（1）.*完成（1）/s);
  a.run('turnTab="work";render()');
  assert.doesNotMatch(a.element('#main').innerHTML,/data-act="taskcomplete"/);
  assert.match(a.element('#main').innerHTML,/task-status busy">作業中/);
  a.run('turnTab="done";render()');
  assert.match(a.element('#main').innerHTML,/task-status confirm">完成/);
  assert.match(a.element('#main').innerHTML,/標記為完成/);
});

test('簡素化した完了の確認と任意の片付けを繁体字で表示する',()=>{
 const a=app(),zh=locale('zh-TW');
 assert.equal(zh.text('この作業を完了に移します。成果・会話・作業用コピーはそのまま残ります。あとで再開できます。'),'將此作業標記為完成。成果、對話與工作副本會保留。之後可以重新開始。');
 assert.equal(zh.text('最終要約と会話の原文を保管しました。'),'已保存最終摘要與對話原文。');
 a.run('state.projects[0].tasks[0].question="";state.projects[0].tasks[0].state="完了"');
 const html=a.run('completionButtons(state.projects[0],state.projects[0].tasks[0])');assert.match(html,/data-act="tasktidy"[^>]*>清理…/);assert.doesNotMatch(html,kana);
 a.run('state.projects[0].tasks[0].state="実行中"');assert.doesNotMatch(a.run('completionButtons(state.projects[0],state.projects[0].tasks[0])'),/data-act="tasktidy"/);
});

test('Japanese is the default; Traditional Chinese catalog covers UI and contains no untranslated prose', () => {
  const ja = locale(), zh = locale('zh-TW');
  assert.equal(ja.locale, 'ja'); assert.equal(ja.text('あなたの番'), 'あなたの番');
  assert.equal(zh.text('あなたの番'), '輪到您'); assert.equal(zh.dateLocale, 'zh-TW');
  assert.ok(Object.keys(zh.messages).length >= 950);
  for (const [original, translated] of Object.entries(zh.messages)) {
    // The example is a real relative path: filenames retain their original spelling.
    if (original === '資料/調査.txt&#10;body:src/app.js' || original.startsWith('貼り付け画像-') || original.startsWith('\u001b') || original.includes('サンプルアプリ')) continue;
    assert.ok(!kana.test(translated.replace(/未解決|確認待ち|判断待ち|解決済み|履歴|返事待ち|やったこと|成果と保管|ファイル|本体保存済み|なし|あり/g, '')), 'untranslated catalog prose: ' + original);
  }
});

test('途中受領の保存数と再開表示は繁体字で、子を片付ける案内にしない',()=>{
 const a=app();a.run('state.taskOffers=[{project:"p",task:"t",received:{head:"abcdef123",at:"2026-10-09",pendingCommits:2}}]');
 const bar=a.run('partialReceiptBar(state.projects[0],state.projects[0].tasks[0])');
 assert.match(bar,/尚未交付的存檔.*2/);assert.doesNotMatch(bar,kana);
 vm.runInContext(source('task-integrate.js'),a.context);
 const progress=a.run('integrationProgress({title:"Child",partial:true,receiving:true,state:"取り込み済み"},0,{})');
 assert.match(progress,/從途中接收的已儲存階段繼續/);assert.doesNotMatch(progress,/片付|整理|ゴミ|垃圾/);
});

test('未統合のGit保存済み成果は反映済みと案内せず日繁で表示する',()=>{
 for(const language of ['ja','zh-TW']) {
  const a=app();a.run('HUB_LOCALE.locale='+JSON.stringify(language));
  // Locale configuration is captured on load.
  vm.runInContext(source('locale.js'),a.context);
  vm.runInContext(source('task-transfer.js'),a.context);vm.runInContext(source('task-integrate.js'),a.context);
  a.run(`drawTaskTransfer({title:'Child',target:'Parent',files:[],results:[{kind:'本体保存済み',description:'Feature'}],resultReady:true,hasCode:true,offer:true,blockers:[],move:[],keep:[]})`);
  a.run(`integratePreview={target:'Parent',items:[{title:'Child',checked:true,copy:'copy',results:[{kind:'本体保存済み',description:'Feature'}],files:[],blockers:[],move:[],optional:[],keep:[]}]};drawTaskIntegration()`);
  for(const selector of ['#transfer-sheet','#integrate-sheet']) {
   const html=a.element(selector).innerHTML;
   assert.match(html,language==='ja'?/Gitに保存済み/:/已提交至 Git/);
   assert.doesNotMatch(html,/すでに反映済み|已套用/);assert.match(html,/Feature/);
  }
 }
});

test('Retired Dot requests are translated read-only history without a resend trigger', async () => {
  const a = app();
  const row = a.run('msgHtml({role:"user",to:"dot",request:"req",text:"ユーザーの原文"})');
  assert.match(row, /給 Dot 的委託（已停用・僅供參考）/);
  assert.match(row, /委託 ID：req/);
  assert.doesNotMatch(row, /data-copy=|hub_dot_inbox/);
  assert.match(row, /ユーザーの原文/);
  a.context.api = async () => ({work:false});
  await a.context.loadChatgpt();
  const setupHtml = a.element('#chatgpt-box').innerHTML;
  assert.match(setupHtml, /id="chatgpt-work"/);
  assert.doesNotMatch(setupHtml, /hub_dot_inbox|data-copy=|讓 Dot 記住的指示/);
  assert.equal(a.run('ACTION.dot'), '已儲存給 Dot 的委託');
});

test('GPT子とDotへ渡すコピー形式と引用ボタンは繁体字で本文を変えない', () => {
  const a=app(), rule=a.run('SEND_TEXT_RULE');
  assert.match(rule,/只將本文放入獨立的 ```text 區塊/); assert.doesNotMatch(rule,kana);
  assert.equal(a.run('typeof DOT_SETUP'), 'undefined');
  const html=a.run('richText("> ユーザーの原文 **bold**\\n> [リンク](https://example.com)")');
  assert.match(html,/⧉ 複製引用/);assert.match(html,/aria-label="複製引用本文"/);
  assert.match(html,/<code>ユーザーの原文 \*\*bold\*\*\n\[リンク\]\(https:\/\/example.com\)<\/code>/);
});

test('Missing explicitly marked UI translations warn by default and fail in strict mode', t => {
  const files = fs.readdirSync(publicDir).filter(name => name.endsWith('.js') && name !== 'locale.js')
    .map(file => ({ file, text: source(file) }));
  const checked = files.reduce((total, entry) => total + uiStringLiterals(entry.text).length, 0);
  assert.ok(checked > 400);
  const missing = missingUiTranslations(files);
  if (process.env.HUB_I18N_STRICT === '1') {
    assert.equal(missing.length, 0, 'missing UI translation: ' + missing.map(entry => entry.file + ': ' + entry.text).join('\n'));
  } else if (missing.length) {
    t.diagnostic('未翻訳（UI）' + missing.length + '件 — 翻訳は公開前にまとめて行う');
    for (const entry of missing.slice(0, 50)) t.diagnostic(entry.file + ': ' + entry.text.replace(/[\r\n]/g, '\\n'));
    if (missing.length > 50) t.diagnostic('…ほか' + (missing.length - 50) + '件');
  }
});

test('UI translation scanning reports the file and text of an untranslated literal', () => {
  assert.deepEqual(missingUiTranslations([{ file: 'fixture.js', text: "UI.text('あなたの番'); UI.text('存在しない文');" }]),
    [{ file: 'fixture.js', text: '存在しない文' }]);
});

test('GPT子の旧会話は移動だけを表示し、手動送信の案内を出さない',()=>{
 const a=app(),html=a.run('gptChildLink("專案","gpt")');assert.match(html,/開啟 GPT 子作業/);assert.doesNotMatch(html,/data-copy|複製提示|複製初次指示/);
});

test('Template interpolation and machine attributes stay opaque while UI text and accessible labels translate', () => {
  const zh = locale('zh-TW'), original = '作業中 &lt;ユーザー原文&gt;';
  const html = zh.template`<button data-state="進行中" value="完了" class="s-返事待ち" title="作業中">あなたへの質問：${original}</button>`;
  assert.match(html, /title="作業中"/); // Same spelling in both languages.
  assert.match(html, />給您的問題：作業中 &lt;ユーザー原文&gt;<\/button>/);
  assert.match(html, /data-state="進行中" value="完了" class="s-返事待ち"/);
  const dynamic = zh.template`<p>子作業「${'まだ続ける'}」の成果と統合内容を確認します</p>`;
  assert.match(dynamic, /まだ続ける/);
  assert.doesNotMatch(dynamic, /繼續作業/);
  assert.equal(zh.label('まだ続ける'), 'まだ続ける'); // A custom role or folder name is user content.
  assert.equal(zh.valueAttribute('返事待ち'), ' value="返事待ち"');
  assert.equal(zh.valueAttribute('"<&'), ' value="&quot;&lt;&amp;"');
  assert.equal(locale().valueAttribute('返事待ち'), '');
});

test('Work, project and settings views localize labels without changing saved state, roles, effort or user content', () => {
  const a = app(), before = a.run('JSON.stringify(state)');
  a.run('renderWork()');
  const work = a.element('#main').innerHTML;
  assert.match(work, /給您的問題/); assert.match(work, /等待回覆/); assert.match(work, /程式設計/);
  assert.match(work, /value="返事待ち"[^>]*>等待回覆<\/option>/);
  assert.match(work, /value="極高"[^>]*>極高<\/option>/);
  assert.match(work, /ユーザーの作業名/); assert.match(work, /どちらにしますか？/);
  assert.match(work, /s-返事待ち/);
  a.run('renderOverview(proj("p"))');
  assert.match(a.element('#main').innerHTML, /プロジェクトの原名/);
  assert.match(a.element('#main').innerHTML, /そのまま残す説明/);
  assert.match(a.element('#main').innerHTML, /新增作業/);
  assert.match(a.element('#main').innerHTML, /value="コーディング">程式設計<\/option>/);
  a.run('renderSettings()');
  assert.match(a.element('#main').innerHTML, /角色分工/);
  assert.match(a.element('#main').innerHTML, /撰寫程式/);
  assert.match(a.element('#main').innerHTML, /value="人"[^>]*>您<\/option>/);
  assert.equal(a.run('JSON.stringify(state)'), before);
  const ai = a.run('msgHtml({role:"assistant",ai:"codex",text:"まだ続ける <script>原文</script>",at:"2026-10-07T00:00:00Z"})');
  assert.match(ai, /まだ続ける/); assert.match(ai, /&lt;script&gt;原文&lt;\/script&gt;/);
  assert.doesNotMatch(ai, /<script>/);
  const table = a.run('richText('+JSON.stringify('| 欄 | 値 |\n| --- | --- |\n| まだ続ける | 利用者の値 |')+')');
  assert.match(table, /aria-label="表格（可水平捲動）"/);
  assert.match(table, /まだ続ける/);
  assert.match(table, /利用者の値/);
});

test('Initial markup loads locale synchronously and marks only its own UI for translation', () => {
  const index = source('index.html');
  assert.ok(index.indexOf('src="locale-config.js"') < index.indexOf('src="locale.js"'));
  assert.ok(index.indexOf('src="locale.js"') < index.indexOf('src="mobile.js"'));
  assert.ok(index.indexOf('src="locale.js"') < index.indexOf('src="app.js"'));
  assert.match(index, /id="turn"[^>]*data-ui/);
  assert.match(index, /id="usage-title"[^>]*data-ui/);
  assert.doesNotMatch(source('locale.js'), /MutationObserver|prototype\.(?:innerHTML|textContent)/);
});

test('CSS drag hints follow the document language and retain Japanese defaults', () => {
  const css = source('app.css');
  for (const selector of ['pane', 'chat', 'view']) assert.ok(css.includes('content:var(--hub-drop-'+selector));
  const ui=locale('zh-TW'); assert.equal(ui.text('ここに落とすと渡します'),'拖到這裡即可交付');
  assert.match(css, /--hub-drop-pane,"ここに落とすと渡します"/);
});

test('Catalog templates preserve every placeholder and interpolate opaque values without a second translation', () => {
  const catalog = require('../ui.json');
  for (const [key, value] of Object.entries(catalog)) {
    const markers = text => [...text.matchAll(/\$\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(markers(value), markers(key), key);
  }
  const zh = locale('zh-TW'), user = '${9} $& 作業が見つかりません';
  assert.equal(zh.template`見つかりません：${user}`, '找不到：' + user);
  assert.equal(locale().template`見つかりません：${user}`, '見つかりません：' + user);
});

test('Terminal exit notice keeps escape codes and exit status while translating only the owned notice', () => {
  for(const language of [undefined,'zh-TW']) {
    const ui=locale(language), code=7;
    const rendered=ui.template`\x1b[90m— 終了しました（code ${code}）—\x1b[0m`;
    assert.equal(rendered, language ? '\x1b[90m— 已結束（code 7）—\x1b[0m' : '\x1b[90m— 終了しました（code 7）—\x1b[0m');
    if(language) {assert.equal(ui.text('作る'),'建立');assert.equal(ui.text('を作る'),'建立');}
  }
  const appSource=source('app-terminal.js');assert.match(appSource,/xterm\.write\("\\r\\n" \+ UI\.template`/);
});

test('ChatGPT設定の契約枠撤去後もMCPとChat／Proの日繁表示が一致する',()=>{
 const a=app(),html=a.context.accountSettingsHtml();assert.match(html,/<summary>MCP /);assert.doesNotMatch(html,/MCP（Dot）/);assert.match(html,/id="chatgpt-box"/);
 assert.doesNotMatch(html,/使用 ChatGPT 訂閱|Continue with ChatGPT|網頁版登入|data-plan-action/);
 const ui=a.context.UI;assert.match(ui.text('ChatGPTの契約枠は廃止しました。ChatGPT（Chat／Pro）を選んでください。'),/連線已停用/);
 const chat=a.run('chatHtml(state.projects[0],state.projects[0].tasks[0])');
 assert.match(chat,/<option[^>]*value="chatgpt\|auto"[^>]*disabled[^>]*>ChatGPT（Chat／Pro）/);
 assert.doesNotMatch(chat,/<option[^>]*value="chatgpt\|chat"/);
 assert.equal(ui.text('廃止された経路'),'已停用的路徑');
});
test('自動Chatだけを日繁で表示し、未設定と旧経路の選び直しを訳す',()=>{
 const a=app();a.run('state.projects[0].tasks[0].owner="chatgpt";state.projects[0].tasks[0].question="";');
 const html=a.run('chatHtml(state.projects[0],state.projects[0].tasks[0])');
 assert.match(html,/尚未設定/);assert.match(html,/data-go="settings"/);assert.doesNotMatch(html,/value="chatgpt\|(?:chat|app)"/);assert.doesNotMatch(html,kana);
 const zh=locale('zh-TW');assert.equal(zh.text('廃止された経路'),'已停用的路徑');
});

test('Native pack strings retain interpolation markers and are data-only strings', () => {
  const native = require('../native.json');
  // 1c7aad34 added five Mac update notices and two microphone usage strings.
  assert.equal(Object.keys(native).length, 53);
  for (const [key, value] of Object.entries(native)) {
    assert.equal(typeof value, 'string');
    const markers = text => [...text.matchAll(/\$\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(markers(value), markers(key), key);
  }
});
