'use strict';
// 設定・各選択欄・サーバーが同じ表示順を使う。入力は変更しない。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModelOrder = factory();
})(globalThis, function () {
  const ais = ['claude-code', 'codex', 'agy', 'grok'];
  const validKey = key => typeof key === 'string' && key.length <= 180 && !/[\u0000-\u001f]/.test(key)
    && ais.includes(key.split('|')[0]) && key.split('|').length === 2 && Boolean(key.split('|')[1].trim());
  const valid = list => Array.isArray(list) && list.length <= 500 && list.every(validKey) && new Set(list).size === list.length;
  const clean = list => [...new Set((Array.isArray(list) ? list : []).filter(validKey))].slice(0, 500);
  function ordered(models, saved) {
    const all = ais.flatMap(ai => (models[ai] || []).map(model => `${ai}|${model}`));
    const result = clean(saved).filter(key => all.includes(key));
    for (const ai of ais) {
      const extra = all.filter(key => key.startsWith(ai + '|') && !result.includes(key));
      const last = result.findLastIndex(key => key.startsWith(ai + '|'));
      result.splice(last < 0 ? result.length : last + 1, 0, ...extra);
    }
    return result;
  }
  // 一時的に候補から消えた物も、保存の位置を残して復帰に備える。
  function retainMissing(saved, visible) {
    const current = new Set(visible), pending = visible.slice();
    return clean(saved).map(key => current.has(key) ? pending.shift() : key).concat(pending);
  }
  return { ais, valid, clean, ordered, retainMissing };
});
