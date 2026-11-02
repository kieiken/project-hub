'use strict';
const http = require('node:http'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { readOwner, mac, equal, capability } = require('../lib/local-auth');
function request(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET', headers: { ...(token ? { 'X-Hub': '1', 'X-Hub-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = ''; res.on('data', b => { text += b; if (text.length > 16384) req.destroy(Error('owner_response_size')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw Error('owner_response'); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.setTimeout(3000, () => req.destroy(Error('owner_timeout'))); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function verify(port) {
  const owner = readOwner(port), nonce = crypto.randomBytes(24).toString('hex');
  const ping = await request(port, '/api/ping?challenge=' + nonce);
  if (!equal(ping.proof, mac(owner.token, nonce, ping.instance, port))) throw Error('unverified_hub');
  return owner;
}
async function launch(port, open) {
  const owner = await verify(port), { ticket } = await request(port, '/api/local-auth/launch', {}, capability(owner.token));
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw Error('owner_launch_response');
  const dir = require('../lib/local-auth').directory(), file = path.join(dir, `launch-${crypto.randomUUID()}.html`);
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action http://127.0.0.1:${port}"><form method="post" action="http://127.0.0.1:${port}/local-auth"><input type="hidden" name="ticket" value="${ticket}"></form><script>document.forms[0].submit()</script>`;
  fs.writeFileSync(file, html, { flag: 'wx', mode: 0o600 });
  try { await open(file); } catch (e) { fs.unlinkSync(file); throw e; }
  return { file, cleanup: () => { try { fs.unlinkSync(file); } catch {} } };
}
async function waitForOwner(port, { check = verify, pause = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeout = 20000 } = {}) {
  const until = now() + timeout;
  while (now() < until) {
    try { return await check(port); } catch { /* Startup readiness only; never replay a launch exchange. */ }
    await pause(500);
  }
  throw Error('owner_startup_timeout');
}
if (require.main === module) {
  const port = Number(process.env.HUB_PORT || 4545);
  (async () => {
    if (process.argv.includes('--wait')) await waitForOwner(port);
    return process.argv.includes('--probe') ? verify(port) : launch(port, file => require('../lib/platform').openUrl(require('node:url').pathToFileURL(file).href, false));
  })().then(r => {
    if (r.cleanup) setTimeout(r.cleanup, 65000);
  }).catch(() => { process.stderr.write('Project Hub の本体を確認できません。アプリまたは起動ファイルから開き直してください。\n'); process.exitCode = 1; });
}
module.exports = { verify, launch, waitForOwner };
