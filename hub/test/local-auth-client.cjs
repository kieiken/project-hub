'use strict';
// Test-only capability forwarding. Production has no bypass or test switch.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
if (!process.env.HUB_AUTH_DIR) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-test-owner-'));
  process.env.HUB_AUTH_DIR = dir;
  process.once('exit', () => fs.rmSync(dir, {recursive:true,force:true}));
}
const rawRequest = http.request;
function headers(port, supplied = {}) {
  const out = Object.fromEntries(new Headers(supplied).entries());
  if (['x-hub-token','tailscale-user-login','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','x-real-ip','via'].some(h => h in out)) return supplied;
  try { const d = JSON.parse(fs.readFileSync(path.join(process.env.HUB_AUTH_DIR, `owner-${Number(port)}.json`))); return { ...Object.fromEntries(new Headers(supplied).entries()), 'x-hub-token': require('../lib/local-auth').capability(d.token) }; } catch { return supplied; }
}
http.request = function (input, options, cb) {
  if (typeof input === 'string' || input instanceof URL) {
    const u = new URL(input); if (typeof options === 'function') { cb = options; options = {}; }
    if (!u.pathname.startsWith('/api/ping') || !u.searchParams.has('challenge')) if (['127.0.0.1','localhost','[::1]'].includes(u.hostname)) options = { ...options, headers: headers(u.port || 80, options?.headers) };
    return rawRequest.call(this, input, options, cb);
  }
  const o = { ...input };
  if (!String(o.path || '').startsWith('/api/ping?challenge=')) if (['127.0.0.1','localhost','::1'].includes(o.hostname || o.host || 'localhost')) o.headers = headers(o.port || 80, o.headers);
  return rawRequest.call(this, o, options);
};
http.get = function (...args) { const req = http.request(...args); req.end(); return req; };
module.exports = { headers, rawRequest };
