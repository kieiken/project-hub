'use strict';
// Only explicitly marked UI source text is translated. Project data, AI replies,
// filenames and terminal output are never scanned or rewritten.
(() => {
  const config = globalThis.HUB_LOCALE || globalThis.window?.HUB_LOCALE || {};
  const locale = typeof config.locale === 'string' && /^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/.test(config.locale) ? config.locale : 'ja';
  let dateLocale = 'ja-JP';
  if (locale !== 'ja') try {
    const requested = config.dateLocale ?? locale;
    if (typeof requested === 'string' && Intl.DateTimeFormat.supportedLocalesOf([requested]).length) dateLocale = Intl.getCanonicalLocales(requested)[0];
  } catch { /* Invalid data keeps the Japanese date format. */ }
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
    if (locale !== 'ja' && /^参考\d+$/.test(source)) return source.replace(/^参考/, text('参考'));
    return labels.has(source) ? text(source) : source;
  }
  const escapeHTML = value => String(value).replace(/&(?!(?:#[0-9]+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);)|[<>"']/gi, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function pieces(value, encode = value => value) {
    // Translate only the markers present in this text/attribute. Never let a
    // translation borrow a raw interpolation from a different HTML context.
    const slots = value.match(marker) || [];
    const translated = key => {
      let result = text(key);
      const found = (result.match(/\$\{\d+\}/g) || []).map(slot => '\uE000' + slot.slice(2, -1) + '\uE001');
      if (found.some(slot => !slots.includes(slot)) || /[\uE000\uE001]/.test(result) || /<\s*\/?\s*\$\{/.test(result)) result = key;
      return encode(result).replace(/\$\{(\d+)\}/g, (_, i) => '\uE000' + i + '\uE001');
    };
    const key = value.replace(marker, (_, i) => '${' + i + '}');
    if (has(key)) return translated(key);
    const trimmed = key.trim();
    if (has(trimmed)) return value.match(/^\s*/)[0] + translated(trimmed) + value.match(/\s*$/)[0];
    return value.split(/(\uE000\d+\uE001)/).map(part => /^\uE000\d+\uE001$/.test(part) ? part : has(part) || has(part.trim()) ? translated(part) : part).join(''); }
  function html(value) {
    const source = String(value ?? '');
    if (locale === 'ja') return source;
    // Translate text nodes and presentation attributes; never values, data-*,
    // classes, URLs, paths, IDs or handlers. Interpolations remain opaque.
    return source.split(/(<(?:"[^"]*"|'[^']*'|[^'">])*>)/g).map(part => part.startsWith('<')
      ? part.replace(/\b(title|aria-label|aria-valuetext|placeholder)\s*=\s*(["'])([\s\S]*?)\2/g,
        (_, name, quote, value) => name + '=' + quote + pieces(value, escapeHTML) + quote)
      : pieces(part, escapeHTML)).join('');
  }
  function template(strings, ...values) {
    if (locale === 'ja') return strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');
    const source = strings.reduce((out, part, i) => out + part + (i < values.length ? '\uE000' + i + '\uE001' : ''), '');
    const markup = /<\/?[a-z][a-z0-9-]*[\s>]/i.test(source);
    // Attribute-only templates (option values, disabled/title fragments) are
    // application syntax too; never translate them as a whole plain sentence.
    const attributes = !markup && source.includes('=') && /^\s*(?:[a-zA-Z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))?\s*)+$/.test(source);
    const translated = markup ? html(source) : attributes ? html('<span ' + source + '></span>') : pieces(source);
    // Attribute values may include UI.text(), which deliberately returns text.
    // Keep existing entities intact (most callers already use esc()).
    const output = translated.split(/(<(?:"[^"]*"|'[^']*'|[^'">])*>)/g).map(part => part.replace(marker, (_, index, offset) => {
      let quote = '';
      if ((markup || attributes) && part.startsWith('<')) for (const c of part.slice(0, offset)) {
        if (quote ? c === quote : c === '"' || c === "'") quote = quote ? '' : c;
      }
      const value = String(values[Number(index)]);
      return quote ? value.replace(/[<>"']/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) : value;
    })).join('');
    return attributes ? output.slice(6, -8) : output;
  }
  function valueAttribute(value) {
    if (locale === 'ja') return '';
    return ' value="' + String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])) + '"';
  }
  function mount(document) {
    document.documentElement.lang = locale;
    if (locale !== 'ja') {
      document.documentElement.style?.setProperty('--hub-drop-pane', JSON.stringify(text("ここに落とすと渡します")));
      document.documentElement.style?.setProperty('--hub-drop-chat', JSON.stringify(text("ここに落とすと依頼の欄に入れます")));
      document.documentElement.style?.setProperty('--hub-drop-view', JSON.stringify(text("ここに落とすと参考フォルダに足します（AI は読むだけ）")));
    }
    document.querySelectorAll('[data-ui]').forEach(element => {
      for (const name of ['title', 'aria-label', 'aria-valuetext', 'placeholder']) {
        if (element.hasAttribute(name)) element.setAttribute(name, text(element.getAttribute(name)));
      }
      for (const node of element.childNodes) if (node.nodeType === 3) node.textContent = text(node.textContent);
    });
  }
  const api = { locale, dateLocale, text, label, message: text, valueAttribute, html, template, mount, messages };
  globalThis.HubI18n = api;
  if (globalThis.window) globalThis.window.HubI18n = api;
  if (typeof document !== 'undefined') mount(document);
})();
