/* Browser dictation adapted from Hermes Web Community startSpeech (MIT).
 * Copyright (c) 2026 Hermes Web contributors. Full notice: THIRD_PARTY_NOTICES.md.
 * Source: arumwu/Hermes-Web-Community@6079b133b244212fb972b69c8099c68939d2cae2/web/app.js:1567-1591
 * No native/server transcription fallback; audio is handled by the browser.
 */
(() => {
  'use strict';
  const UI = window.HubI18n || { text: value => value };
  let active = null;
  let generation = 0;
  const epoch = Math.random().toString(36).slice(2);
  const bindings = new WeakMap();
  const maxListeningMs = 5 * 60 * 1000;
  const unsupported = UI.text('この環境では音声入力を使えません。キーボードで入力してください。');
  const errors = {
    'not-allowed': UI.text('音声入力の許可を確認できませんでした。マイクと音声認識の両方の許可、ブラウザやアプリの対応を確認してください。手入力を続けられます。'),
    'service-not-allowed': UI.text('このアプリやブラウザでは音声認識が許可されていません。手入力を続けられます。'),
    'audio-capture': UI.text('マイクを使えません。接続や使用許可を確認してください。'),
    'network': UI.text('音声認識に接続できませんでした。この環境の音声入力は未確認です。手入力を続けられます。'),
    'no-speech': UI.text('声を聞き取れませんでした。元の文章は残っています。'),
    'language-not-supported': UI.text('日本語の音声認識を使えません。手入力を続けられます。'),
  };
  function valid(s) {
    return active === s && s.input.isConnected && !s.input.disabled && !s.input.readOnly
      && s.input.getClientRects().length > 0 && !document.hidden && s.current();
  }
  function finish(s, message) {
    clearTimeout(s.timer);
    if (active !== s) return;
    active = null;
    s.observer.disconnect();
    s.button.textContent = '🎙';
    s.button.setAttribute('aria-pressed', 'false');
    s.button.setAttribute('aria-label', UI.text('日本語で音声入力を始める'));
    s.status.textContent = message;
  }
  function cancel(input, message = UI.text('音声入力を止めました。元の文章は残っています。')) {
    const s = active;
    if (!s || (input && s.input !== input)) return;
    // Invalidate before abort: even synchronous or delayed callbacks lose ownership.
    finish(s, message);
    try { s.recognition.abort(); } catch { /* Already ended. */ }
  }
  function commit(s) {
    if (!valid(s)) { if (active === s) cancel(s.input); return; }
    const input = s.input;
    if (input.value !== s.base) { cancel(input, UI.text('文章が変更されたため、音声の追加を止めました。入力した文章は残っています。')); return; }
    const text = [...s.results].sort((a,b) => a[0]-b[0]).map(x => x[1]).join('').trim();
    const ended = s.stopReason === 'limit' ? UI.text('5分になったため聞き取りを終了しました。') : !s.stopping ? UI.text('ブラウザが聞き取りを終了しました。続けるにはマイクを押してください。') : '';
    const prefix = ended + (ended && UI.locale && UI.locale !== 'ja' ? ' ' : '');
    if (!text) { finish(s, prefix + errors['no-speech']); return; }
    if (input.maxLength >= 0 && input.value.length + text.length > input.maxLength) { finish(s, UI.text('入力できる文字数を超えるため追加しませんでした。元の文章は残っています。')); return; }
    finish(s, prefix + UI.text('文字を追加しました。内容を確認・修正してから送ってください。'));
    // Insert only once, at the original caret, after releasing session ownership.
    input.setRangeText(text, s.anchor, s.anchor, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  }
  function stop(s, reason = 'button') {
    if (active !== s || s.stopping) return;
    if (!valid(s)) { cancel(s.input); return; }
    s.stopping = true; s.stopReason = reason;
    s.status.textContent = UI.text('聞き取りを終了しています…');
    clearTimeout(s.timer);
    // Some engines never send end after stop. Preserve confirmed phrases, then
    // abort the old engine; late callbacks cannot affect this or a later draft.
    s.timer = setTimeout(() => {
      if (active !== s) return;
      commit(s);
      try { s.recognition.abort(); } catch { /* Already ended. */ }
    }, 3000);
    try { s.recognition.stop(); } catch {
      commit(s);
      try { s.recognition.abort(); } catch { /* Already ended. */ }
    }
  }
  function mount(input, { current = () => true, buttonHost = null } = {}) {
    if (!input) return;
    if (bindings.has(input)) { bindings.get(input).current = current; return; }
    const binding = { current }; bindings.set(input, binding);
    const ownsView = () => binding.current();
    input.dataset.voiceBound = '1';
    const tools = document.createElement('div'); tools.className = 'voice-tools';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn plain voice-button';
    button.textContent = '🎙'; button.setAttribute('aria-label', UI.text('日本語で音声入力を始める')); button.setAttribute('aria-pressed', 'false');
    button.title = UI.text('日本語で続けて話せます（最長5分）。停止マークで文字を確定します。音声はブラウザ提供元などで処理される場合があります。自動送信はしません。');
    const status = document.createElement('span'); status.className = 'small voice-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    tools.append(status);
    if (buttonHost) { buttonHost.append(button); tools.classList.add('voice-inline-status'); }
    else tools.append(button);
    input.after(tools);
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    // A page update cannot add usage descriptions to an already running Mac app.
    // Older shells expose SpeechRecognition but the OS rejects its permission.
    const oldMacApp = /Macintosh/.test(navigator.userAgent) && /ProjectHubApp\//.test(navigator.userAgent) && !/HubVoice\/1\b/.test(navigator.userAgent);
    if (oldMacApp) {
      button.disabled = true;
      status.textContent = UI.text('音声入力にはMacアプリ本体の更新が必要です。画面だけの更新ではマイクの許可設定が入りません。更新後にアプリを開き直してください。手入力は続けられます。');
      return;
    }
    if (!Speech || window.isSecureContext === false) { button.disabled = true; status.textContent = unsupported; return; }
    button.addEventListener('pointerdown', e => { e.preventDefault(); }); // Preserve caret and selection.
    button.addEventListener('click', e => {
      if (!e.isTrusted || !ownsView() || input.disabled || input.readOnly || !input.isConnected || !input.getClientRects().length || document.hidden) return;
      if (active?.input === input) {
        stop(active);
        return;
      }
      cancel();
      let recognition;
      try { recognition = new Speech(); } catch { status.textContent = unsupported; return; }
      const s = { input, button, status, current: ownsView, recognition, ticket: epoch + ':' + (++generation), base: input.value,
        anchor: input.selectionStart ?? input.value.length, results: new Map(), stopping: false };
      active = s;
      s.observer = new MutationObserver(() => { if (!valid(s)) cancel(input); });
      s.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'readonly', 'open'] });
      recognition.lang = 'ja-JP'; recognition.interimResults = false; recognition.continuous = true;
      recognition.onstart = () => { if (valid(s) && !s.stopping) status.textContent = UI.text('聞き取り中です（最長5分）。続けて話し、停止マークで文字を確定してください。'); };
      recognition.onresult = event => {
        if (!valid(s)) { if (active === s) cancel(input); return; }
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          if (event.results[i].isFinal) s.results.set(i, event.results[i][0]?.transcript || '');
        }
      };
      recognition.onerror = event => {
        if (active !== s) return;
        cancel(input, errors[event.error] || UI.text('音声入力に失敗しました。元の文章は残っています。手入力を続けられます。'));
      };
      recognition.onend = () => commit(s);
      button.textContent = '■'; button.setAttribute('aria-label', UI.text('音声入力を終了して文字を確定する')); button.setAttribute('aria-pressed', 'true');
      status.textContent = UI.text('音声入力を開始します。音声はブラウザ提供元などで処理される場合があります。');
      s.timer = setTimeout(() => stop(s, 'limit'), maxListeningMs);
      try { recognition.start(); } catch { cancel(input, UI.text('音声入力を開始できませんでした。手入力を続けられます。')); }
    });
    input.addEventListener('input', () => cancel(input, UI.text('文章の編集を優先して音声入力を止めました。')));
    input.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(input); });
    const pageBlur = e => {
      if (e.relatedTarget === input || e.relatedTarget === button) return;
      const s = active;
      if (!s || s.input !== input) return;
      if (e.relatedTarget) { cancel(input); return; } // Known destination inside the page.
      // Native permission dialogs also blur the focused element. Let focus settle;
      // only leaving this input/button within a still-focused page cancels dictation.
      setTimeout(() => {
        if (active === s && document.hasFocus() && document.activeElement !== input && document.activeElement !== button) cancel(input);
      }, 0);
    };
    input.addEventListener('blur', pageBlur);
    button.addEventListener('blur', pageBlur);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', () => cancel());
  const permissionPending = () => !!active && !active.stopping && valid(active);
  window.HubVoice = { mount, cancel, permissionPending, permissionTicket: () => permissionPending() ? active.ticket : '' };
})();
