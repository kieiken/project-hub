'use strict';
// CSSより先に適用し、保存済みのライトでも初回描画がちらつかないようにする。
(() => {
  const key = 'hub-theme';
  const normalize = value => value === 'light' ? 'light' : 'dark';
  let theme = 'dark';
  try { theme = normalize(localStorage.getItem(key)); } catch (_) { /* 初期値 */ }
  function apply(value) {
    theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#eef2f7' : '#121520';
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    });
    document.dispatchEvent(new Event('hub-theme-change'));
  }
  window.HubTheme = {
    current: () => theme,
    set(value) {
      apply(value);
      try { localStorage.setItem(key, theme); return true; } catch (_) { return false; }
    },
    terminalTheme() {
      return theme === 'light'
        ? { background: '#f9fbfd', foreground: '#1e2533', cursor: '#1e2533', cursorAccent: '#f9fbfd', selectionBackground: '#cfd9ee',
            black: '#1e2533', red: '#b42318', green: '#267344', yellow: '#7a5600', blue: '#2c4bd6', magenta: '#8036a6', cyan: '#176f78', white: '#5b6578',
            brightBlack: '#5b6578', brightRed: '#b42318', brightGreen: '#267344', brightYellow: '#7a5600', brightBlue: '#2c4bd6', brightMagenta: '#8036a6', brightCyan: '#176f78', brightWhite: '#1e2533' }
        : { background: '#10131a', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#ffffff4d' };
    }
  };
  // 他のタブでの変更・設定の削除も反映。保存不可でも現在画面の切り替えは使える。
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
  apply(theme);
})();
