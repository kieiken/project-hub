'use strict';
// Browser credentials are origin/port scoped sessionStorage, never cookies.
(() => {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  function session() {
    if (!local) return null; // Remote/iPhone authentication stays with remoteGate.
    try {
      const value = JSON.parse(sessionStorage.getItem('hub-local-session') || 'null');
      return value && value.expires > Date.now() && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
    } catch { return null; }
  }
  function resourceURL(input) {
    const url = new URL(input, location.href), value = session();
    if (url.origin !== location.origin || !value?.resources?.[url.pathname]) return input;
    url.searchParams.set('hubResource', value.resources[url.pathname]);
    return url.href;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const value = session();
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || !value) return originalFetch(input, options);
    const headers = new Headers(options?.headers || input?.headers);
    headers.set('X-Hub-Token', value.token);
    // Never forward a credential to a redirected endpoint, including another port.
    return originalFetch(input, { ...options, headers, redirect: 'error' });
  };
  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) { super(resourceURL(url), options); }
    };
  }
  window.HubLocalAuth = { url: resourceURL };
})();
