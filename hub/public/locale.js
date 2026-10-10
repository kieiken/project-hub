'use strict';
// Only explicitly marked UI source text is translated. Project data, AI replies,
// filenames and terminal output are never scanned or rewritten. Japanese is
// built in; other languages come from a locale extension's catalogs, served by
// the server as HUB_LOCALE (see hub/lib/locale.js).
(() => {
  const config = globalThis.HUB_LOCALE || globalThis.window?.HUB_LOCALE || {};
  const locale = config.locale || 'ja';
  const messages = Object.assign(Object.create(null), config.messages || {});
  const marker = /\uE000(\d+)\uE001/g;
  const has = key => Object.prototype.hasOwnProperty.call(messages, key);
  function text(value) {
    const source = String(value ?? '');
    if (locale === 'ja') return source;
    if (has(source)) return messages[source];
    return source.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before, key, after) => before + (has(key) ? messages[key] : key) + after);
  }
  const labels = new Set(['未着手', '実行中', '返事待ち', '停止', '上限で停止', '完了', '進行中', '待ち', '衝突', '取り込み済み', '片付け済み', '解決済み', '履歴', '未解決', '確認待ち', '判断待ち', '人', '低', '中', '高', '極高', '本体', '資料', '作業', '成果物', '参考', '台帳（PROJECT.md・指示ファイル）', '作業の場所', '週間枠', '5時間枠', '週間', '5時間', '司令塔', '調査', 'デザイン', '画像生成', 'コーディング', 'チェック', '文章', '最終確認', '計画・割り振り・進み具合', '情報集め・要約', '画面・構成・見た目', '画像を作る', 'プログラムを書く', '独立レビュー（本人のテストは必須）', '説明文・マニュアル', '完成の判断']);
  function label(value) {
    const source = String(value ?? '');
    if (/^参考\d+$/.test(source)) return text('参考') + source.slice(2);
    return labels.has(source) ? text(source) : source;
  }
  function pieces(value) {
    const key = value.replace(marker, (_, i) => '${' + i + '}');
    if (has(key)) return messages[key].replace(/\$\{(\d+)\}/g, (_, i) => '\uE000' + i + '\uE001');
    const trimmed = key.trim();
    if (has(trimmed)) return value.match(/^\s*/)[0] + messages[trimmed].replace(/\$\{(\d+)\}/g, (_, i) => '\uE000' + i + '\uE001') + value.match(/\s*$/)[0];
    return value.split(/(\uE000\d+\uE001)/).map(part => /^\uE000\d+\uE001$/.test(part) ? part : text(part)).join(''); }
  function html(value) {
    const source = String(value ?? '');
    if (locale === 'ja') return source;
    // Translate text nodes and presentation attributes; never values, data-*,
    // classes, URLs, paths, IDs or handlers. Interpolations remain opaque.
    return source.split(/(<[^>]*>)/g).map(part => part.startsWith('<')
      ? part.replace(/\b(title|aria-label|aria-valuetext|placeholder)\s*=\s*(["'])([\s\S]*?)\2/g,
        (_, name, quote, value) => name + '=' + quote + pieces(value).replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;') + quote)
      : pieces(part)).join('');
  }
  function template(strings, ...values) {
    if (locale === 'ja') return strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');
    const source = strings.reduce((out, part, i) => out + part + (i < values.length ? '\uE000' + i + '\uE001' : ''), '');
    const translated = /<\/?[a-z][a-z0-9-]*[\s>]/i.test(source) ? html(source) : pieces(source);
    return translated.replace(marker, (_, index) => String(values[Number(index)]));
  }
  function valueAttribute(value) {
    if (locale === 'ja') return '';
    return ' value="' + String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])) + '"';
  }
  function mount(document) {
    document.documentElement.lang = locale;
    document.querySelectorAll('[data-ui]').forEach(element => {
      for (const name of ['title', 'aria-label', 'aria-valuetext', 'placeholder']) {
        if (element.hasAttribute(name)) element.setAttribute(name, text(element.getAttribute(name)));
      }
      for (const node of element.childNodes) if (node.nodeType === 3) node.textContent = text(node.textContent);
    });
  }
  const api = { locale, dateLocale: config.dateLocale || 'ja-JP', text, label, message: text, valueAttribute, html, template, mount, messages };
  globalThis.HubI18n = api;
  if (globalThis.window) globalThis.window.HubI18n = api;
  if (typeof document !== 'undefined') mount(document);
})();
