/* 本人が本文欄から送った指示だけを保存する。会話行・委任・待ち指示は取り込まない。 */
(function (root) {
  // 選択中はネイティブ操作。改行と画面上の折り返しの両方を行として扱う。
  function atBoundary(ta, direction) {
    const text = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
    if (start !== end || !Number.isInteger(start)) return false;
    if (direction === -1 ? text.slice(0, start).includes('\n') : text.slice(start).includes('\n')) return false;
    const doc = ta.ownerDocument, win = doc?.defaultView;
    if (!win) return true;
    const css = win.getComputedStyle(ta), mirror = doc.createElement('div');
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'direction']) mirror.style[name] = css[name];
    Object.assign(mirror.style, { position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden', pointerEvents: 'none', boxSizing: 'border-box', width: ta.clientWidth + 'px', whiteSpace: ta.wrap === 'off' ? 'pre' : 'pre-wrap', overflowWrap: 'break-word' });
    // 末尾の改行後も空行を測れるようにする。HTMLとしては解釈しない。
    const node = doc.createTextNode(text + '\u200b');
    mirror.appendChild(node); doc.body.appendChild(mirror);
    try {
      const range = doc.createRange();
      const rectAt = index => { range.setStart(node, index); range.collapse(true); return range.getBoundingClientRect(); };
      const caret = rectAt(start), edge = rectAt(direction === -1 ? 0 : text.length);
      const onEdge = rect => rect.height > 0 && edge.height > 0 && Math.abs(rect.top - edge.top) < 1;
      if (!onEdge(caret)) return false;
      // 折り返し位置は前行末と次行頭が同じ文字位置になる。collapsed Rangeだけでは
      // 実カーソルの表示側を特定できないので、両隣が境界行にある時だけ履歴へ移る。
      // 明示改行は上の判定で扱う。サロゲートペアは1文字として測る。
      const before = [...text.slice(Math.max(0, start - 2), start)].pop();
      const after = String.fromCodePoint(text.codePointAt(start) ?? 0);
      for (const [from, to, char] of [[start - (before?.length || 0), start, before], [start, start + after.length, start < text.length ? after : null]]) {
        if (!char || char === '\n') continue;
        range.setStart(node, from); range.setEnd(node, to);
        if (!onEdge(range.getBoundingClientRect())) return false;
      }
      return true;
    } finally { mirror.remove(); }
  }
  function create(storage) {
    const entries = new Map(), sessions = new Map();
    const storageKey = key => 'hub-instruction-history-' + key;
    const read = key => {
      if (!entries.has(key)) {
        let saved;
        try { saved = JSON.parse(storage?.getItem(storageKey(key)) || '[]'); } catch (_) { /* メモリ内で続ける */ }
        entries.set(key, Array.isArray(saved) ? saved.filter(x => typeof x === 'string' && x.trim() && x.length <= 100000).slice(0, 3) : []);
      }
      return entries.get(key);
    };
    return {
      canMove(key, direction) {
        const session = sessions.get(key);
        if (!session) return direction === -1 && read(key).length > 0;
        const next = session.index - direction;
        return next >= 0 && next < session.values.length;
      },
      record(key, text) {
        if (typeof text !== 'string' || !text.trim() || text.length > 100000) return;
        const history = [text, ...read(key)].slice(0, 3);
        entries.set(key, history);
        try { storage?.setItem(storageKey(key), JSON.stringify(history)); } catch (_) { /* 保存不可でもこの画面では使える */ }
      },
      move(key, direction, text, start = text.length, end = start) {
        let session = sessions.get(key);
        if (!session) {
          const history = read(key);
          if (direction !== -1 || !history.length) return null;
          session = { index: 0, values: [{ text, start, end }, ...history.map(text => ({ text, start: text.length, end: text.length }))] };
          sessions.set(key, session);
        }
        // 呼び出す直前の変換済み本文と選択範囲を保持。履歴本文を編集しても原本は変えない。
        session.values[session.index] = { text, start, end };
        session.index = Math.max(0, Math.min(session.values.length - 1, session.index - direction));
        const value = session.values[session.index];
        if (!session.index) sessions.delete(key);
        return value;
      },
      reset(key) { sessions.delete(key); }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create, atBoundary };
  else root.HubChatHistory = { create, atBoundary };
})(typeof window === 'undefined' ? globalThis : window);
