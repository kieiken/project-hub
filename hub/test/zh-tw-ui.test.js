'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');
const source = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
const kana = /[\u3041-\u3096\u30a1-\u30fa]/u;
const { config, styles } = require('../lib/locale');
function locale(language) {
  const context = vm.createContext({ HUB_LOCALE: language ? config(language) : undefined });
  vm.runInContext(source('locale.js'), context);
  return context.HubI18n;
}
function app() {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false,
      addEventListener() {}, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { contains() { return false; }, toggle() {} } });
    return elements.get(key);
  };
  const document = { documentElement: {}, hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ HUB_LOCALE: config('zh-TW'), document, window: {}, navigator: { userAgent: '' },
    localStorage: { getItem() { return null; }, setItem() {} }, fetch: () => new Promise(() => {}),
    EventSource: class { close() {} }, URLSearchParams, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame: fn => fn(), console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order') });
  vm.runInContext(source('locale.js'), context);
  vm.runInContext(source('app.js'), context);
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

test('Every explicitly marked UI string literal resolves to Traditional Chinese', () => {
  const zh = locale('zh-TW');
  let checked = 0;
  for (const name of fs.readdirSync(publicDir).filter(name => name.endsWith('.js') && name !== 'locale.js')) {
    const text = source(name);
    const literal = /UI\.(text|html)\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/g;
    for (const match of text.matchAll(literal)) {
      const value = vm.runInNewContext(match[2]);
      const translated = zh[match[1]](value);
      assert.ok(!kana.test(translated), name + ': missing UI translation: ' + value);
      checked++;
    }
  }
  assert.ok(checked > 400);
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

test('CSS drag hints come from the active locale pack while core CSS keeps Japanese', () => {
  const core = source('app.css');
  assert.match(core, /content:"ここに落とすと渡します"/);
  assert.doesNotMatch(core, /lang="zh-TW"|拖到這裡/);
  assert.match(source('index.html'), /href="app\.css">\n<link rel="stylesheet" href="locale\.css">/);
  const previous = process.env.HUB_LANG;
  try {
    process.env.HUB_LANG = 'zh-TW';
    const css = styles();
    for (const selector of ['pane', 'chat', 'view']) assert.match(css, new RegExp('\\.' + selector + '\\.dropping::after\\{content:"[^"\\u3041-\\u3096\\u30a1-\\u30fa]+"\\}'));
    process.env.HUB_LANG = 'ja';
    assert.equal(styles(), '');
  } finally {
    if (previous === undefined) delete process.env.HUB_LANG; else process.env.HUB_LANG = previous;
  }
});

test('Catalog templates interpolate opaque values without a second translation', () => {
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
  const appSource=source('app.js');assert.match(appSource,/xterm\.write\("\\r\\n" \+ UI\.template`/);
});
