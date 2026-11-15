'use strict';
// Browser credentials are origin/port scoped sessionStorage, never cookies.
(() => {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  function storedSession() {
    if (!local) return null; // Remote/iPhone authentication stays with remoteGate.
    try {
      return JSON.parse(sessionStorage.getItem('hub-local-session') || 'null');
    } catch { return null; }
  }
  function session() {
    const value = storedSession();
    return value && value.expires > Date.now() && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
  }
  function resourceURL(input) {
    const url = new URL(input, location.href), value = session();
    if (url.origin !== location.origin || !value?.resources?.[url.pathname]) return input;
    url.searchParams.set('hubResource', value.resources[url.pathname]);
    return url.href;
  }
  const originalFetch = window.fetch.bind(window);
  let pendingWrites = 0;
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const value = session();
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, options);
    const write = !['GET', 'HEAD'].includes(String(options?.method || input?.method || 'GET').toUpperCase());
    if (write) pendingWrites++;
    try {
      if (!value) return await originalFetch(input, options);
      const headers = new Headers(options?.headers || input?.headers);
      headers.set('X-Hub-Token', value.token);
      // Never forward a credential to a redirected endpoint, including another port.
      return await originalFetch(input, { ...options, headers, redirect: 'error' });
    } finally { if (write) pendingWrites--; }
  };
  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) { super(resourceURL(url), options); }
    };
  }
  window.HubLocalAuth = { url: resourceURL, get canReconnect() { return storedSession()?.reconnect === true; }, get pendingWrites() { return pendingWrites; } };
})();
