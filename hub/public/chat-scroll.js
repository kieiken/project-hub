/* DOMを書き換える前の位置で追従を判断し、同じ作業の再描画でも読んでいる位置を保つ。 */
(() => {
  const instances = new WeakMap();
  window.HubChatScroll = {
    change(box, update) {
      const api = instances.get(box);
      if (api) api.change(update); else update();
    },
    capture(box, key) {
      return box && box.dataset.scrollKey === key ? (instances.get(box)?.capture() || { top: box.scrollTop, follow: box.scrollHeight - box.scrollTop - box.clientHeight < 80 }) : null;
    },
    create(box, latest, saved) {
      instances.get(box)?.dispose();
      let first = true, disposed = false, frame = null, touchY = null;
      const size = () => [box.clientWidth, box.clientHeight, box.scrollHeight];
      let dimensions = size(), position;
      const changed = () => size().some((n, i) => n !== dimensions[i]);
      const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      const anchor = () => {
        const top = box.getBoundingClientRect?.().top;
        if (top === undefined) return null;
        // Chat rows are ordered blocks. While the same row still crosses the
        // viewport top, it remains the first visible row after appends/reflow.
        const current = position?.anchor?.node;
        if (current?.parentElement === box) {
          const rect = current.getBoundingClientRect();
          if (rect.top <= top && rect.bottom > top && rect.height) return { node: current, offset: rect.top - top, height: rect.height };
        }
        for (const node of box.children) {
          const rect = node.getBoundingClientRect();
          if (rect.bottom > top && rect.height) return { node, offset: rect.top - top, height: rect.height };
        }
        return null;
      };
      const indicator = () => { if (latest) latest.hidden = position.follow; };
      const remember = (follow = nearBottom()) => {
        position = { top: box.scrollTop, follow, anchor: follow ? null : anchor() };
        dimensions = size(); indicator();
      };
      remember();
      // resize由来のscrollでは、変更前の追従意図と読んでいたメッセージを失わない。
      const capture = () => {
        if (!changed() && box.scrollTop !== position.top) remember();
        return { ...position };
      };
      const restore = (position, force = false) => {
        if (disposed) return;
        const follow = force || position.follow, a = position.anchor;
        if (follow) box.scrollTop = box.scrollHeight;
        else if (a && box.contains(a.node)) {
          const rect = a.node.getBoundingClientRect();
          const offset = a.offset < 0 ? a.offset * rect.height / a.height : a.offset;
          box.scrollTop += rect.top - box.getBoundingClientRect().top - offset;
        } else box.scrollTop = position.top;
        remember(follow);
      };
      const resize = () => {
        if (disposed || frame !== null || !changed()) return;
        frame = requestAnimationFrame(() => { frame = null; if (!disposed) restore(position); });
      };
      const onScroll = () => { if (changed()) resize(); else capture(); };
      // 上向きの操作は補正待ちの間でも優先する。下向きの操作では従来通り下端で追従を再開。
      const past = () => { if (box.scrollTop > 0) remember(false); };
      const wheel = e => { if (!e.ctrlKey && e.deltaY < 0) past(); };
      const key = e => { if (['ArrowUp','PageUp','Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) past(); };
      const touchStart = e => { touchY = e.touches.length === 1 ? e.touches[0].clientY : null; };
      const touchMove = e => { const y = e.touches.length === 1 ? e.touches[0].clientY : null; if (y !== null && touchY !== null && y > touchY) past(); touchY = y; };
      const pointer = e => {
        const rect = box.getBoundingClientRect?.();
        if (rect && e.target === box && (e.clientX >= rect.left + box.clientLeft + box.clientWidth || e.clientX < rect.left + box.clientLeft)) past();
      };
      const toLatest = () => restore(capture(),true);
      const listeners = { scroll:onScroll, wheel, keydown:key, touchstart:touchStart, touchmove:touchMove, pointerdown:pointer };
      for (const [event, listener] of Object.entries(listeners)) box.addEventListener(event,listener,{passive:true});
      latest?.addEventListener('click',toLatest);
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
      observer?.observe(box);
      if (!observer) window.addEventListener?.('resize',resize);
      const api = { capture, restore, rows(position) { restore(first ? (saved || {follow:true}) : position); first = false; },
        // An explicit disclosure action keeps its button in view and pauses
        // bottom following. Subsequent appends preserve this reading position.
        change(update) {
          const top = box.scrollTop;
          update();
          box.scrollTop = top;
          remember(false);
        },
        dispose() {
          if (disposed) return;
          disposed = true; observer?.disconnect();
          if (frame !== null) cancelAnimationFrame(frame);
          for (const [event, listener] of Object.entries(listeners)) box.removeEventListener(event,listener);
          latest?.removeEventListener('click',toLatest);
          if (!observer) window.removeEventListener?.('resize',resize);
          instances.delete(box);
        }
      };
      instances.set(box,api);
      return api;
    }
  };
})();
