'use strict';
// This server runs before Store, Freetalk, License or any user configuration is opened.
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const authClient = require('node:fs').readFileSync(path.join(__dirname, '../public/local-auth.js'), 'utf8');
function page() {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Project Hub 引っ越し</title><style>body{font:18px system-ui;max-width:720px;margin:60px auto;padding:20px}button,select{font:inherit;padding:12px;margin:8px}p{white-space:pre-wrap}</style><h1>Project Hub 引っ越し</h1><p id="status" role="status">確認中…</p><div id="choices"></div><script>
${authClient}
const status=document.querySelector('#status'),choices=document.querySelector('#choices');let waiting=false;
async function poll(){try{const r=await fetch('/api/move/status'),s=await r.json();status.textContent=s.error||s.notice||({importing:'読み込み中… '+(s.progress||0)+' 件',found:'引っ越しデータを確認しています',conflict:'今のデータは上書きしません。読み込むデータと方法を選んでください',failed:'読み込みを止めました',imported:'引っ越しが終わりました。開き直しています'})[s.mode]||'準備中…';
if(!s.error&&(s.mode==='imported'||s.mode==='none')){location.reload();return;}
if(waiting)return;choices.replaceChildren();if(s.mode!=='conflict')return;
const select=document.createElement('select');for(const name of s.bundles||[]){const o=document.createElement('option');o.textContent=name;o.value=name;select.append(o);}choices.append(select);
for(const [action,label] of [['start','選んだデータを読み込む'],['rename-current-and-import','今のデータを別名に移して読み込む'],['skip','読み込まない']]){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{if(action==='rename-current-and-import'&&!confirm('今のデータは別名で残し、引っ越しデータを読み込みます。進めますか？'))return;waiting=true;try{const r=await fetch('/api/move/import',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({action,bundle:select.value,confirm:action==='rename-current-and-import'?label:undefined})});const s=await r.json();if(!r.ok)status.textContent=s.error;}catch(e){status.textContent=e.message;}finally{waiting=false;}};choices.append(b);}
}catch{} }poll();setInterval(poll,1000);
</script></html>`;
}
function serve(move, { port, version, entry, restart, auth = new (require('./local-auth').LocalAuth)({ root: move.root }) } = {}) {
  let restarting = false, restartEnvironment;
  const again = restart || (() => {
    const env = { ...process.env, ...restartEnvironment, HUB_RESTART_WAIT: '1' };
    delete env.HUB_AUTH_RESTART;
    const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); child.unref(); process.exit(0);
  });
  const resume = () => { if (['imported', 'none'].includes(move.status().mode) && !restarting) { restarting = true; setTimeout(() => {
    try { restartEnvironment = auth.restartEnv(); }
    catch (e) { restarting = false; server.restartError = e; return; }
    server.close(again); server.closeIdleConnections();
  }, 300); } };
  const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    if (!hosts.includes(req.headers.host) || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return send(res, 403, { error: 'forbidden' });
    try {
      const navigation = auth.ping(req.headers['x-hub-navigation']);
      if (navigation.proof) { res.setHeader('X-Hub-Instance', navigation.instance); res.setHeader('X-Hub-Proof', navigation.proof); }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await require('./local-auth').launchGate(auth, req, res, url)) return;
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(page().replace('<meta charset="utf-8">', '<meta charset="utf-8">' + (auth.authenticated(req) ? auth.bootstrap() : '')));
      }
      if (req.method === 'POST' && (req.headers['x-hub'] !== '1' || req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin))) return send(res, 403, { error: 'forbidden' });
      if (req.method === 'GET' && url.pathname === '/api/ping' && !auth.authenticated(req)) return send(res, 200, { ok: true, ...auth.ping(url.searchParams.get('challenge')) });
      if (!auth.authenticated(req)) return send(res, 401, { error: 'Open Project Hub from its app or launcher' });
      if (req.method === 'POST' && url.pathname === '/api/local-auth/launch') return send(res, 200, { ticket: auth.issue() });
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version, pid: process.pid, runtimePath: path.dirname(entry), migration: true, restored: false, ...auth.ping(url.searchParams.get('challenge')) });
      if (req.method === 'GET' && req.url === '/api/move/status') return send(res, 200, { ...move.status(), ...(server.restartError ? { error: '開き直す準備に失敗しました。引っ越しデータは保持されています。' } : {}) });
      if (req.method === 'POST' && req.url === '/api/move/import') {
        let body = ''; for await (const b of req) { body += b; if (body.length > 8192) return send(res, 400, { error: 'too large' }); }
        const data = JSON.parse(body); if (data.action === 'skip') { await move.import(data); resume(); } else { setImmediate(() => move.import(data).then(resume).catch(() => {})); }
        return send(res, 202, move.status());
      }
      if (req.method === 'GET' && !req.url.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" }); return res.end(page()); }
      return send(res, 409, { error: '引っ越しが終わるまでお待ちください', migration: true });
    } catch (e) { send(res, e.status || 400, { error: e.message }); }
  });
  server.on('listening', () => require('./local-auth').activateServer(auth, server));
  server.on('close', () => auth.close());
  process.once('exit', () => auth.close());
  if (port !== undefined) server.listen(port, '127.0.0.1', () => setImmediate(() => move.autoImport().then(resume).catch(() => {})));
  return server;
}
module.exports = { serve, page };
