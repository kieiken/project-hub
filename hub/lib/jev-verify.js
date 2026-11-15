'use strict';
const https = require('node:https');

// Metadata only. No redirects, retry, body consumption, or caller-selected URL.
function verifyKey(key, { request = https.request, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let req, timer, settled = false;
    const finish = state => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(state);
    };
    timer = setTimeout(() => { finish('unavailable'); req?.destroy(); }, timeoutMs);
    try {
      req = request('https://api.typesafe.ai/v1/models', {
        method: 'GET', headers: { Authorization: `Bearer ${key}` }, agent: false,
      }, res => {
        res.on('error', () => finish('unavailable'));
        finish(res.statusCode === 200 ? 'verified' : res.statusCode === 401 ? 'rejected' : 'unavailable');
        res.destroy(); // Discard the response without reading or retaining its content.
      });
      req.on('error', () => finish('unavailable'));
      req.end();
    } catch { finish('unavailable'); req?.destroy(); }
  });
}
module.exports = { verifyKey };
