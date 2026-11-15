'use strict';
const { performance } = require('node:perf_hooks');
const PHASES = new Set(['validated', 'handoffReady', 'prepared', 'quotaReady', 'admitted', 'spawned']);
// One bounded, content-free aggregate. Offsets may overlap with an early quota
// check; quotaReady is the end of the remaining wait, not quota CLI duration.
function sendTiming(record, request, now = () => performance.now()) {
  const start = now(), points = {}; let finished = false, status = 500;
  const elapsed = () => Math.round(Math.min(86400000, Math.max(0, now() - start)) * 1000) / 1000;
  const ids = Object.fromEntries(['project', 'task', 'ai'].filter(k => typeof request[k] === 'string' && request[k].length <= 128).map(k => [k, request[k]]));
  return {
    mark(phase) { if (PHASES.has(phase) && points[phase] === undefined) points[phase] = elapsed(); },
    response(code) { status = code; },
    finish() {
      if (finished) return; finished = true;
      try { record('chat-send-timing', ids, { version: 1, status, totalMs: elapsed(), checkpointsMs: points }); } catch { /* Observability cannot change delivery. */ }
    },
  };
}
module.exports = { sendTiming };
