'use strict';
// Enforce the window's resource boundary before WebView2 sends subrequests.
// Keep ordinary browser launches and other platforms unchanged.
function applyWindowPolicy(res, { platform, launch, port }) {
  if (platform !== 'win32' || !launch) return;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('window_policy_port_invalid');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src http://127.0.0.1:" + port,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
}
module.exports = { applyWindowPolicy };
