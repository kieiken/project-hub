'use strict';
(function (root) {
  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  if (typeof module !== 'undefined') module.exports = { safeUrl };
  else root.hubSafeUrl = safeUrl;
})(typeof window !== 'undefined' ? window : globalThis);
