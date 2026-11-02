'use strict';
// Actual DOM parsing, with every network request blocked and no Hub/AI process.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
let chromium;
try { ({chromium}=require('playwright-core')); }
catch { try { ({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
test('F1: translated titles and attribute fragments cannot add handlers, elements or opaque template slots',{skip:!chromium||!chrome},async t=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());
  await page.setContent('<main></main>');
  await page.evaluate(()=>{globalThis.HUB_LOCALE={locale:'zh-TW',messages:{
    'あなたの番':'" onmouseover="globalThis.attacked=1" x="',
    '題材を決める&#10;下書き':'Topic&#10;Draft',
    '原文':'&lt;img src=x onerror=alert(1)&gt;',
    '保存':'Save & close', '通知':'${2}',
    'disabled title="${0}"':'onmouseover="globalThis.attacked=1" title="${0}"',
    'value="${0}" ':'value="${0}" onfocus="globalThis.attacked=1" ',
  }};});
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../public/locale.js'),'utf8')});
  const actual=await page.evaluate(()=>{
    const ui=HubI18n;
    document.querySelector('main').innerHTML=ui.template`<button title="${ui.text('あなたの番')}">保存</button>`
      +ui.html('<button title="あなたの番">保存</button>')
      +ui.template`<button ${ui.template`disabled title="${ui.text('あなたの番')}"`}>保存</button>`
      +ui.template`<select><option ${ui.template`value="${'model'}" `}>保存</option></select>`
      +ui.template`<b>通知</b>${'<i>trusted</i>'}`
      +ui.html('<textarea placeholder="題材を決める&#10;下書き"></textarea><p>原文</p>');
    for(const el of document.querySelectorAll('*'))el.dispatchEvent(new MouseEvent('mouseover'));
    return {attacked:!!globalThis.attacked,handlers:document.querySelectorAll('[onmouseover],[onfocus]').length,
      titles:[...document.querySelectorAll('button')].map(e=>e.title),labels:[...document.querySelectorAll('button')].map(e=>e.textContent),
      value:document.querySelector('option').value,disabled:document.querySelectorAll('button')[2].disabled,
      newline:document.querySelector('textarea').placeholder,encoded:document.querySelector('p').textContent,images:document.querySelectorAll('img').length,
      bold:document.querySelector('b').textContent,italic:document.querySelectorAll('i').length};
  });
  assert.deepEqual(actual,{attacked:false,handlers:0,titles:Array(3).fill('" onmouseover="globalThis.attacked=1" x="'),labels:Array(3).fill('Save & close'),value:'model',disabled:true,bold:'通知',italic:1,newline:'Topic\nDraft',encoded:'<img src=x onerror=alert(1)>',images:0});
});

test('real English and Traditional Chinese placeholders keep entity newlines as line breaks',{skip:!chromium||!chrome},async t=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  for(const locale of ['en','zh-TW']) {
    const messages=JSON.parse(fs.readFileSync(path.join(__dirname,'../../langpacks',locale,'ui.json'),'utf8'));
    const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<main></main>');
    await page.evaluate(config=>{globalThis.HUB_LOCALE=config;},{locale,messages});
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../public/locale.js'),'utf8')});
    const value=await page.evaluate(()=>{
      document.querySelector('main').innerHTML=HubI18n.html('<textarea placeholder="題材を決める&#10;下書き&#10;チェック&#10;投稿"></textarea>');
      return document.querySelector('textarea').placeholder;
    });
    assert.equal(value,messages['題材を決める&#10;下書き&#10;チェック&#10;投稿'].replaceAll('&#10;','\n'));await page.close();
  }
});
