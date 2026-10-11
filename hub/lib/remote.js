'use strict';
const { lt, locale } = require('./locale');
// 外から使う（iPhone）：Tailscale serve 越しの通信を見分け、合言葉でログインさせる
// 設定は <ROOT>/_hub/remote.json：{ enabled, passcodeHash, salt, host, sessions: [{ id, createdAt, lastSeen, ua }], failures: [{ at, who }] }
// 札（Cookie）はそのまま保存せず、SHA-256 にした物を id として残す（ファイルが読まれても札にはならない）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'hub_session';
const DAYS30 = 30 * 86400000;
const LOCK_MS = 15 * 60000;
const LOCK_COUNT = 5; // 同じ相手から15分に5回まちがえたら止める
const LOCK_ALL = 20; // 相手を偽って試され続けないよう、全体でも15分に20回で止める
const MAX_SESSIONS = 20;
const MIN_PASS = 8;

// 中継された通信（tailscale serve など）なら外から。Mac の中の画面・アプリはこの印を付けない
const isRemote = req => ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via'].some(h => req.headers[h] !== undefined);
// 誰からか：Tailscale のアカウント、無ければ中継元の場所
const whoOf = req => String(req.headers['tailscale-user-login'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (String(req.headers['forwarded'] || '').match(/for=\s*"?([^;,"]+)/i) || [])[1]?.trim() || String(req.headers['x-real-ip'] || '').split(',')[0].trim() || 'unknown').slice(0, 200);
function cookieOf(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const sessionCookie = token => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS30 / 1000}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const hashOf = (pass, salt) => crypto.scryptSync(String(pass), Buffer.from(salt, 'hex'), 32).toString('hex');
const idOf = token => crypto.createHash('sha256').update(String(token)).digest('hex');

class Remote {
  constructor({ file, now = () => Date.now() }) { this.file = file; this.now = now; this.data = null; }
  load() {
    if (this.data) return this.data;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { d = {}; }
    this.data = { enabled: d.enabled === true, passcodeHash: typeof d.passcodeHash === 'string' ? d.passcodeHash : '', salt: typeof d.salt === 'string' ? d.salt : '', host: typeof d.host === 'string' ? d.host : '',
      sessions: Array.isArray(d.sessions) ? d.sessions.filter(s => s && typeof s.id === 'string') : [], failures: Array.isArray(d.failures) ? d.failures.filter(f => f && typeof f.at === 'number') : [] };
    return this.data;
  }
  save() { // 書きかけを読まないよう、別の名前に書いてから置き換える。合言葉の元が入るので本人だけ読める
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  prune() {
    const d = this.load(), t = this.now();
    d.sessions = d.sessions.filter(s => t - Date.parse(s.createdAt) < DAYS30);
    d.failures = d.failures.filter(f => t - f.at < LOCK_MS);
    return d;
  }
  // 画面に出す物（合言葉の元は出さない）
  status() {
    const d = this.prune();
    return { enabled: d.enabled, hasPasscode: Boolean(d.passcodeHash), sessions: d.sessions.map(({ id, createdAt, lastSeen, ua }) => ({ id: id.slice(0, 12), createdAt, lastSeen, ua })),
      url: d.host ? `https://${d.host}` : '', hint: lt('https://<Macの名前>.<tailnet>.ts.net') };
  }
  enabled() { return this.load().enabled; }
  // 設定を変える。合言葉を変えたら、前の合言葉で入った端末はすべて出す
  update({ enabled, passcode }) {
    const d = this.load();
    if (passcode !== undefined) {
      if (typeof passcode !== 'string' || [...passcode].length < MIN_PASS || passcode.length > 200) return { error: lt`合言葉は${MIN_PASS}文字以上にしてください` };
      d.salt = crypto.randomBytes(16).toString('hex');
      d.passcodeHash = hashOf(passcode, d.salt);
      d.sessions = []; d.failures = [];
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return { error: lt('形式が違います') };
      if (enabled && !d.passcodeHash) return { error: lt('先に合言葉を決めてください') };
      d.enabled = enabled;
    }
    this.prune(); this.save();
    return { ok: true };
  }
  locked(who) {
    const f = this.prune().failures;
    return f.filter(x => x.who === who).length >= LOCK_COUNT || f.length >= LOCK_ALL;
  }
  // ログイン：成功したら札（token）を返す
  login(passcode, who, ua) {
    const d = this.prune();
    if (!d.enabled) return { status: 403, error: lt('外からの利用はオフです') };
    if (this.locked(who)) return { status: 423, error: lt('15分待ってください') };
    let ok = false;
    if (d.passcodeHash && typeof passcode === 'string' && passcode.length <= 200) {
      const a = Buffer.from(hashOf(passcode, d.salt), 'hex'), b = Buffer.from(d.passcodeHash, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ok) {
      d.failures.push({ at: this.now(), who });
      this.save();
      return this.locked(who) ? { status: 423, error: lt('15分待ってください') } : { status: 401, error: lt('合言葉が違います') };
    }
    const token = crypto.randomBytes(32).toString('base64url'), at = new Date(this.now()).toISOString();
    d.failures = d.failures.filter(f => f.who !== who);
    d.sessions.push({ id: idOf(token), createdAt: at, lastSeen: at, ua: String(ua || '').slice(0, 200) });
    d.sessions = d.sessions.slice(-MAX_SESSIONS);
    this.save();
    return { ok: true, token };
  }
  // 札が生きているか。最後に使った時刻は1分に1回だけ書く
  check(token) {
    if (!token) return null;
    const d = this.load(), id = idOf(token), s = d.sessions.find(x => x.id === id);
    if (!s || this.now() - Date.parse(s.createdAt) >= DAYS30) return null;
    if (this.now() - Date.parse(s.lastSeen || 0) > 60000) { s.lastSeen = new Date(this.now()).toISOString(); try { this.save(); } catch (e) { /* 書けなくても続ける */ } }
    return s;
  }
  logout(token) { const d = this.load(), id = idOf(token), n = d.sessions.length; d.sessions = d.sessions.filter(x => x.id !== id); if (d.sessions.length !== n) this.save(); }
  logoutAll() { const d = this.load(), n = d.sessions.length; d.sessions = []; this.save(); return n; }
  noteHost(host) { const d = this.load(), h = String(host || '').slice(0, 200); if (h && /^[\w.-]+(:\d+)?$/.test(h) && d.host !== h) { d.host = h; try { this.save(); } catch (e) { /* 続ける */ } } }
}

// 外から見る小さな画面（ログイン・オフの知らせ）。本体の画面とは別に、これだけで動く
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="${locale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><title>${esc(title)}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:40px 20px;background:#f6f6f4;color:#222}main{max-width:360px;margin:0 auto}
h1{font-size:20px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #bbb;margin-top:10px}
button{background:#222;color:#fff;border:0}#msg{color:#b00;min-height:1.5em}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#eee}input{background:#2c2c2e;color:#eee;border-color:#555}button{background:#eee;color:#111}}</style></head>
<body><main>${body}</main></body></html>`;
const offPage = () => page('Project Hub', lt('<h1>Project Hub</h1><p>外からの利用はオフです。Mac の Project Hub の設定で「外から使う（iPhone）」をオンにしてください。</p>'));
const loginPage = () => page(lt('Project Hub ログイン'), lt`<h1>Project Hub</h1><p>Mac の設定で決めた合言葉を入れてください。</p>
<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="合言葉" required autofocus><button type="submit">ログイン</button></form><p id="msg" role="alert"></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const m=document.getElementById('msg');m.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1'},body:JSON.stringify({passcode:document.getElementById('p').value})});
if(r.ok){location.href='/';return;}const j=await r.json().catch(()=>({}));m.textContent=j.error||'ログインできませんでした';}catch(err){m.textContent='つながりませんでした';}};</script>`);

module.exports = { Remote, isRemote, whoOf, cookieOf, sessionCookie, clearCookie, offPage, loginPage, COOKIE, MIN_PASS, LOCK_COUNT };
