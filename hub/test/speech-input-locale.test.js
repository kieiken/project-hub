'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { try { ({ chromium } = require(path.join(os.homedir(), '.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome = process.env.HUB_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const locale = fs.readFileSync(path.join(__dirname, '../public/locale.js'), 'utf8');
const speech = fs.readFileSync(path.join(__dirname, '../public/speech-input.js'), 'utf8');
const keys = [...new Set([...speech.matchAll(/UI\.text\(('(?:\\.|[^'\\])*')\)/g)].map(m => vm.runInNewContext(m[1])))];
// All recognition is replaced before loading the product: no microphone access.
const mock = `window.sessions=[];window.SpeechRecognition=class {
 constructor(){sessions.push(this);} start(){if(window.throwStart)throw Error('fixture');}
 stop(){this.stopped=true;} abort(){this.aborted=true;}
 result(text){const r=[{transcript:text}];r.isFinal=true;this.onresult({resultIndex:0,results:[r]});}
};window.voiceTimers=new Map();const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{
 if(ms>=3000){voiceTimers.set(ms,fn);return timer(()=>{},1000000000);}return timer(fn,ms,...args);
};`;

for (const language of ['en', 'zh-TW']) test(`voice presentation uses the real ${language} catalog`, { skip: !chromium || !fs.existsSync(chrome) }, async t => {
  const dictionary = JSON.parse(fs.readFileSync(path.join(__dirname, '../../langpacks', language, 'ui.json'), 'utf8'));
  const covered = new Set();
  const tr = key => { assert.ok(Object.hasOwn(dictionary, key), key); covered.add(key); return dictionary[key]; };
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://127.0.0.1:17772/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><form><textarea id="draft">原文</textarea></form>' }));
    const setup = async ({ supported = true, oldMac = false } = {}) => {
      await page.goto('http://127.0.0.1:17772/');
      await page.evaluate(({ language, dictionary, oldMac }) => {
        window.HUB_LOCALE = { locale: language, messages: dictionary };
        if (oldMac) Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh ProjectHubApp/4.123.0' });
        document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.sent = true; });
      }, { language, dictionary, oldMac });
      await page.addScriptTag({ content: locale });
      if (supported) await page.addScriptTag({ content: mock });
      else await page.evaluate(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
      await page.addScriptTag({ content: speech });
      await page.evaluate(() => HubVoice.mount(document.querySelector('#draft')));
    };
    const status = () => page.locator('.voice-status').innerText();
    const start = async () => { await page.focus('#draft'); await page.evaluate(() => document.querySelector('#draft').setSelectionRange(1, 1)); await page.click('.voice-button'); };
    await t.test('labels, title, start, listening, stop and success are translated; Japanese dictation stays literal', async () => {
      await setup();
      const startLabel = tr('日本語で音声入力を始める');
      assert.equal(await page.getAttribute('.voice-button', 'aria-label'), startLabel);
      assert.equal(await page.getAttribute('.voice-button', 'title'), tr('日本語で続けて話せます（最長5分）。停止マークで文字を確定します。音声はブラウザ提供元などで処理される場合があります。自動送信はしません。'));
      await start();
      assert.equal(await status(), tr('音声入力を開始します。音声はブラウザ提供元などで処理される場合があります。'));
      assert.equal(await page.getAttribute('.voice-button', 'aria-label'), tr('音声入力を終了して文字を確定する'));
      assert.deepEqual(await page.evaluate(() => [sessions[0].lang, sessions[0].continuous, sessions[0].interimResults]), ['ja-JP', true, false]);
      await page.evaluate(() => { sessions[0].onstart(); sessions[0].result('日本語の原文'); });
      assert.equal(await status(), tr('聞き取り中です（最長5分）。続けて話し、停止マークで文字を確定してください。'));
      assert.equal(await page.inputValue('#draft'), '原文');
      await page.click('.voice-button');
      assert.equal(await status(), tr('聞き取りを終了しています…'));
      await page.evaluate(() => sessions[0].onend());
      assert.equal(await status(), tr('文字を追加しました。内容を確認・修正してから送ってください。'));
      assert.equal(await page.inputValue('#draft'), '原日本語の原文文');
      assert.equal(await page.getAttribute('.voice-button', 'aria-label'), startLabel);
      assert.equal(await page.evaluate(() => Boolean(window.sent)), false);
    });
    await t.test('natural end and time limit translate each composed fragment', async () => {
      await setup(); await start(); await page.evaluate(() => sessions[0].onend());
      assert.equal(await status(), tr('ブラウザが聞き取りを終了しました。続けるにはマイクを押してください。') + ' ' + tr('声を聞き取れませんでした。元の文章は残っています。'));
      await setup(); await start(); await page.evaluate(() => { sessions[0].result('五分の文'); voiceTimers.get(300000)(); sessions[0].onend(); });
      assert.equal(await status(), tr('5分になったため聞き取りを終了しました。') + ' ' + tr('文字を追加しました。内容を確認・修正してから送ってください。'));
    });
    await t.test('errors are localized without inserting or sending the transcript', async () => {
      const messages = {
        'not-allowed': '音声入力の許可を確認できませんでした。マイクと音声認識の両方の許可、ブラウザやアプリの対応を確認してください。手入力を続けられます。',
        'service-not-allowed': 'このアプリやブラウザでは音声認識が許可されていません。手入力を続けられます。',
        'audio-capture': 'マイクを使えません。接続や使用許可を確認してください。',
        network: '音声認識に接続できませんでした。この環境の音声入力は未確認です。手入力を続けられます。',
        'no-speech': '声を聞き取れませんでした。元の文章は残っています。',
        'language-not-supported': '日本語の音声認識を使えません。手入力を続けられます。',
        unknown: '音声入力に失敗しました。元の文章は残っています。手入力を続けられます。',
      };
      for (const [error, message] of Object.entries(messages)) {
        await setup(); await start(); await page.evaluate(error => { sessions[0].result('追加しない'); sessions[0].onerror({ error }); sessions[0].onend(); }, error);
        assert.equal(await status(), tr(message), error); assert.equal(await page.inputValue('#draft'), '原文');
        assert.equal(await page.evaluate(() => [HubVoice.permissionPending(), Boolean(window.sent)].some(Boolean)), false);
      }
    });
    await t.test('cancellation, edits and length rejection translate only the notice', async () => {
      await setup(); await start(); await page.evaluate(() => HubVoice.cancel());
      assert.equal(await status(), tr('音声入力を止めました。元の文章は残っています。'));
      await setup(); await start(); await page.fill('#draft', '人が直した原文');
      assert.equal(await status(), tr('文章の編集を優先して音声入力を止めました。')); assert.equal(await page.inputValue('#draft'), '人が直した原文');
      await setup(); await start(); await page.evaluate(() => { document.querySelector('#draft').value = '別の原文'; sessions[0].onend(); });
      assert.equal(await status(), tr('文章が変更されたため、音声の追加を止めました。入力した文章は残っています。'));
      await setup(); await start(); await page.evaluate(() => { document.querySelector('#draft').maxLength = 3; sessions[0].result('長すぎる'); sessions[0].onend(); });
      assert.equal(await status(), tr('入力できる文字数を超えるため追加しませんでした。元の文章は残っています。')); assert.equal(await page.inputValue('#draft'), '原文');
    });
    await t.test('unsupported, old app and failed start translate their notices', async () => {
      await setup({ supported: false });
      assert.equal(await status(), tr('この環境では音声入力を使えません。キーボードで入力してください。')); assert.equal(await page.isDisabled('.voice-button'), true);
      await setup({ oldMac: true });
      assert.equal(await status(), tr('音声入力にはMacアプリ本体の更新が必要です。画面だけの更新ではマイクの許可設定が入りません。更新後にアプリを開き直してください。手入力は続けられます。')); assert.equal(await page.isDisabled('.voice-button'), true);
      await setup(); await page.evaluate(() => { window.throwStart = true; }); await start();
      assert.equal(await status(), tr('音声入力を開始できませんでした。手入力を続けられます。'));
    });
    assert.deepEqual([...covered].sort(), keys.sort(), 'every distinct speech presentation key is exercised');
    assert.equal(covered.size, 23);
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
});
