'use strict';

module.exports = function remoteRoutes(ctx) {
  const { send, remote, tailscaleUrl, record } = ctx;
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/remote',
      handle(req, res, url) {
        const st = remote.status(); return (st.url ? Promise.resolve(st.url) : tailscaleUrl()).then(u => send(res, 200, { ...st, url: u }));
      },
    },
    write: {
      matches: (req, url) => url.pathname === '/api/remote',
      handle(req, res, url, b) {
        const r = remote.update({ enabled: b.enabled, passcode: b.passcode });
        if (r.error) return send(res, 400, { error: r.error });
        record('remote', {}, { enabled: remote.enabled(), passcode: b.passcode !== undefined });
        return send(res, 200, remote.status());
      },
    },
    enrollment: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/remote/enrollment',
      handle(req, res) { if(require('../remote').isRemote(req))return send(res,403,{error:'local owner only'});return send(res, 200, remote.enrollment()); },
    },
    forget: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/remote/forget-devices',
      handle(req, res) { if(require('../remote').isRemote(req))return send(res,403,{error:'local owner only'});remote.forgetDevices(); return send(res, 200, { ok: true }); },
    },
    logout: {
      matches: (req, url) => url.pathname === '/api/remote/logout-all',
      handle(req, res, url, b) {
        if(require('../remote').isRemote(req))return send(res,403,{error:'local owner only'});
        const n = remote.logoutAll();
        record('remotelogoutall', {}, { sessions: n });
        return send(res, 200, remote.status());
      },
    },
  };
};
