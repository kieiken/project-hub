// The sidebar layout changes without replacing project or conversation DOM.
(() => {
  const app = document.querySelector('.app'), separator = document.querySelector('#sidebar-resize');
  if (!app || !separator) return;
  const media = matchMedia('(max-width:720px)'), storageKey = 'hub-sidebar-width';
  const minimum = 180, maximum = 480, contentMinimum = 360, handleWidth = 6;
  let preferred = 240, width = 240, drag = null;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null && saved.trim() && Number.isFinite(Number(saved))) preferred = Math.max(minimum, Math.min(maximum, Number(saved)));
  } catch (_) {}
  const limit = () => Math.max(minimum, Math.min(maximum, app.clientWidth - contentMinimum - handleWidth));
  function apply(value) {
    if (media.matches) return;
    width = Math.round(Math.max(minimum, Math.min(limit(), value)));
    app.style.setProperty('--hub-sidebar-width', width + 'px');
    separator.setAttribute('aria-valuemin', String(minimum));
    separator.setAttribute('aria-valuemax', String(limit()));
    separator.setAttribute('aria-valuenow', String(width));
  }
  function save() {
    preferred = width;
    try { localStorage.setItem(storageKey, String(preferred)); } catch (_) {}
  }
  function finish(cancel = false) {
    if (!drag) return;
    const pointer = drag.pointer; drag = null;
    document.body.classList.remove('resizing-sidebar');
    if (cancel) apply(preferred); else save();
    if (separator.hasPointerCapture(pointer)) separator.releasePointerCapture(pointer);
  }
  separator.addEventListener('pointerdown', event => {
    if (media.matches || drag || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, x: event.clientX, width };
    separator.setPointerCapture(event.pointerId);
    separator.focus({ preventScroll: true });
    document.body.classList.add('resizing-sidebar');
  });
  separator.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.pointer) apply(drag.width + event.clientX - drag.x);
  });
  separator.addEventListener('pointerup', event => { if (drag && event.pointerId === drag.pointer) finish(); });
  separator.addEventListener('pointercancel', event => { if (drag && event.pointerId === drag.pointer) finish(true); });
  separator.addEventListener('lostpointercapture', () => finish(true));
  separator.addEventListener('keydown', event => {
    if (media.matches) return;
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); finish(true);
    const step = event.shiftKey ? 50 : 10;
    apply(event.key === 'Home' ? minimum : event.key === 'End' ? limit() : width + (event.key === 'ArrowLeft' ? -step : step));
    save();
  });
  function layout() {
    finish(true);
    separator.hidden = media.matches;
    apply(preferred);
  }
  window.addEventListener('resize', layout);
  media.addEventListener('change', layout);
  layout();
})();
