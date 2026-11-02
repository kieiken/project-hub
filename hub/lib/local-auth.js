'use strict';
// Owner capabilities are private to this OS account. They do not protect against
// code already running with that account's full privileges.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const COOKIE = 'hub_owner';
const directory = () => path.resolve(process.env.HUB_AUTH_DIR || path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Local/ProjectHub/run' : 'Library/Application Support/ProjectHub/run'));
function noLinks(file) {
  for (let p = file;; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw Error('owner_path_symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
}
function privateDir(dir, create = false) {
  noLinks(dir);
  const existed = fs.existsSync(dir);
  if (!existed && create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory()) throw Error('owner_directory');
  if (process.platform === 'win32') require('./platform/win32-update-store').privateDirectory(dir, !existed);
  else if (s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('owner_directory_permissions');
}
function readPrivate(file) {
  privateDir(path.dirname(file)); noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 8192 || process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077))) throw Error('owner_file_permissions');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
const recordPath = (port, dir = directory()) => path.join(dir, `owner-${Number(port)}.json`);
function readOwner(port, dir) {
  const d = JSON.parse(readPrivate(recordPath(port, dir)));
  if (!d || typeof d !== 'object' || !/^[a-f0-9]{64}$/.test(d.token) || !Number.isInteger(d.pid) || d.port !== Number(port)) throw Error('owner_file_format');
  return d;
}
const mac = (token, challenge, instance, port) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(`${challenge}\n${instance}\n${port}`).digest('hex');
const capability = token => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update('local-api').digest('hex');
const cookieValue = (token, instance, port) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(`local-cookie\n${instance}\n${port}`).digest('hex');
const RESTART_MS = 30000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const SESSION_KEY = 'hub-local-session';
// Only these read-only, headerless consumers accept a separate URL grant.
// A resource grant is never a general API/header capability.
const RESOURCE_PATHS = ['/api/chat/stream', '/api/term/stream', '/api/file/view', '/api/start/image', '/api/freetalk/attachment', '/api/ideas'];
function writePrivate(file, text) {
  noLinks(file);
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookieOf(req, name) {
  return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
class LocalAuth {
  constructor({ instance = crypto.randomUUID(), dir = directory(), root = '', now = Date.now } = {}) {
    this.instance = instance; this.dir = dir; this.root = path.resolve(root || '.'); this.now = now; this.tickets = new Map(); this.sessions = new Map(); this.token = crypto.randomBytes(32).toString('hex'); this.preserve = false;
  }
  activate(port) {
    privateDir(this.dir, true); this.port = port; this.file = recordPath(port, this.dir);
    let old;
    try { old = readOwner(port, this.dir); } catch (e) {
      // A truncated/obsolete record must not brick startup. Unsafe permissions
      // and paths still fail closed; the listening socket establishes ownership.
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && e.message !== 'owner_file_format') throw e;
    }
    if (old) {
      if (old.restart === true && old.restartUntil > this.now() && old.restartUntil <= this.now() + RESTART_MS && old.root === this.root) this.token = old.token;
    }
    writePrivate(this.file, JSON.stringify({ token: this.token, pid: process.pid, port, root: this.root, instance: this.instance }));
    this.headersFile = path.join(this.dir, `headers-${port}.txt`);
    noLinks(this.headersFile);
    if (fs.existsSync(this.headersFile)) readPrivate(this.headersFile);
    writePrivate(this.headersFile, `X-Hub: 1\nX-Hub-Token: ${capability(this.token)}\n`);
    delete process.env.HUB_AUTH_RESTART;
    process.env.HUB_HEADERS = this.headersFile;
    process.env.HUB_AUTH_DIR = this.dir;
  }
  authenticated(req) {
    if (!this.file) return false;
    const header = req.headers['x-hub-token'];
    if (equal(header, capability(this.token))) return true;
    const url = new URL(req.url || '/', 'http://localhost');
    for (const [token, session] of this.sessions) {
      if (session.expires <= this.now()) { this.sessions.delete(token); continue; }
      if (equal(header, token)) return true;
      if (req.method === 'GET' && RESOURCE_PATHS.includes(url.pathname)
          && equal(url.searchParams.get('hubResource'), session.resources[url.pathname])) return true;
    }
    return false;
  }
  browserSession() {
    for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(token);
    while (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex'), expires = this.now() + SESSION_MS;
    const resources = Object.fromEntries(RESOURCE_PATHS.map(route => [route, crypto.randomBytes(32).toString('hex')]));
    this.sessions.set(token, { expires, resources });
    return { token, expires, resources };
  }
  bootstrap() {
    return `<script>sessionStorage.setItem(${JSON.stringify(SESSION_KEY)},${JSON.stringify(JSON.stringify(this.browserSession()))})</script>`;
  }
  ping(challenge) {
    return /^[a-f0-9]{32,128}$/.test(challenge || '') ? { instance: this.instance, proof: mac(this.token, challenge, this.instance, this.port) } : { instance: this.instance };
  }
  issue() {
    for (const [k, until] of this.tickets) if (until < this.now()) this.tickets.delete(k);
    if (this.tickets.size >= 32) throw Error('owner_launch_busy');
    const ticket = crypto.randomBytes(32).toString('hex'); this.tickets.set(ticket, this.now() + 60000); return ticket;
  }
  consume(ticket) { const until = this.tickets.get(ticket); this.tickets.delete(ticket); return until !== undefined && until > this.now(); }
  // Compatibility marker only: never accepted as owner authentication.
  cookie() { return `${COOKIE}_${this.port}=${crypto.randomBytes(32).toString('hex')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`; }
  protect(file) {
    try { const real = fs.realpathSync(file), dir = fs.realpathSync(this.dir); return real === dir || real.startsWith(dir + path.sep); } catch { return false; }
  }
  restartEnv() {
    const old = readOwner(this.port, this.dir);
    if (!equal(old.token, this.token) || old.pid !== process.pid) throw Error('owner_restart_changed');
    writePrivate(this.file, JSON.stringify({ ...old, restart: true, restartUntil: this.now() + RESTART_MS }));
    this.preserve = true;
    return { HUB_AUTH_DIR: this.dir };
  }
  cancelRestart() {
    const old = readOwner(this.port, this.dir);
    if (!equal(old.token, this.token) || old.pid !== process.pid) throw Error('owner_restart_changed');
    delete old.restart; delete old.restartUntil;
    writePrivate(this.file, JSON.stringify(old)); this.preserve = false;
  }
  close() {
    if (this.preserve || !this.file) return;
    try { if (readOwner(this.port, this.dir).token === this.token) { fs.unlinkSync(this.file); fs.unlinkSync(this.headersFile); } } catch { /* No unrelated files are removed. */ }
  }
}
const lockedPage = '<!doctype html><meta charset="utf-8"><p>Project Hub のアプリか起動ファイルから開いてください。</p>';
// The launch exchange is a capability POST, not a general unauthenticated API.
async function launchGate(auth, req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/local-auth') return false;
  if (![`127.0.0.1:${auth.port}`, `localhost:${auth.port}`].includes(req.headers.host)) { res.writeHead(403); res.end(); return true; }
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 256) break; }
  if (body.length > 256 || !auth.consume(new URLSearchParams(body).get('ticket'))) { res.writeHead(403); res.end('Launch expired'); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': auth.cookie(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  res.end('<!doctype html><meta charset="utf-8">' + auth.bootstrap() + '<script>location.replace("/")</script>'); return true;
}
function activateServer(auth, server) {
  try { auth.activate(server.address().port); }
  catch (e) {
    server.authError = e;
    console.error('Project Hub: owner authentication startup failed');
    server.close(); // Never throw out of EventEmitter's listening callback.
  }
}
module.exports = { LocalAuth, readOwner, readPrivate, directory, recordPath, mac, equal, capability, cookieValue, COOKIE, SESSION_MS, SESSION_KEY, RESOURCE_PATHS, lockedPage, launchGate, activateServer };
