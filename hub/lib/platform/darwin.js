'use strict';
// Mac primitives moved from their existing callers. Policy, ownership checks,
// HTTP responses and update workflows remain in those callers.
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const c = require('node:crypto');
// Detached supervisors copy this adapter with their ownership code. Process
// primitives need only built-ins; load translations when a UI operation uses them.
const lt = (...args) => require('../locale').lt(...args);

function create(options = {}) {
const name = options.name || 'darwin';
const fs = options.fs || require('node:fs');
const os = options.os || require('node:os');
const path = require('node:path');
const execFile = options.execFile || childProcess.execFile;
const execFileSync = options.execFileSync || childProcess.execFileSync;
const spawn = options.spawn || childProcess.spawn;
const kill = options.kill || ((pid, signal) => process.kill(pid, signal));
const asyncRun = promisify(execFile);
const TIMEOUT = 5000;
function unsupported() { return Object.assign(Error('platform_unsupported'), { code: 'platform_unsupported', platform: name }); }
function macOnly() { if (name !== 'darwin') throw unsupported(); }
function as(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function run(file, args, dry) {
  if (name !== 'darwin') return Promise.reject(unsupported());
  if (dry) return Promise.resolve({ dry: true, file, args });
  return new Promise((resolve, reject) => {
    execFile(file, args, err => (err ? reject(err) : resolve({ ok: true })));
  });
}

function openTerminal(command, dry) {
  return run('osascript', [
    '-e', `tell application "Terminal" to do script "${as(command)}"`,
    '-e', 'tell application "Terminal" to activate',
  ], dry);
}

async function focusTerminal(pid, dry) {
  if (!Number.isInteger(pid) || pid < 1) throw Error(lt('認証用Terminalの記録を確認できません'));
  macOnly();
  if (dry) return { dry: true, existingTerminal: true };
  const tty = await new Promise((resolve, reject) => execFile('/bin/ps', ['-p', String(pid), '-o', 'tty='], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  if (!/^ttys[0-9]+$/.test(tty)) throw Error(lt('認証用Terminalの画面を見つけられませんでした'));
  await run('osascript', ['-e', `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "/dev/${tty}" then
set selected tab of w to t
set index of w to 1
activate
return
end if
end repeat
end repeat
error "Authentication Terminal not found"
end tell`], false);
  return { ok: true, existingTerminal: true };
}

function openPath(p, dry) { return run('open', [p], dry); }
// ファイルは Finder でその場所を開いて選ぶ。URL は Mac の既定のブラウザで開く
function revealPath(p, dry, { absolute = false } = {}) { return run(absolute ? '/usr/bin/open' : 'open', ['-R', p], dry); }
function openUrl(u, dry) { return run('open', [u], dry); }

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// 外のコマンドを動かして出力を返す。終わり方が 0 以外でも出力があれば使う（lsof は一部の番号が無いと 1 で終わる）
function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (e, stdout) => {
      if (e && !(typeof e.code === 'number' && stdout)) return reject(e);
      resolve(String(stdout || ''));
    });
  });
}

function psArgs(platform) {
  return platform === 'darwin' ? ['-axo', 'pid=,ppid=,lstart=,command='] : ['-eo', 'pid=,ppid=,lstart=,args='];
}

// lstart（例 "Sun Oct  4 12:34:56 2026"）→ ISO。読めなければ ''
function parseLstart(s) {
  const m = String(s).trim().match(/^\S+\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m || !(m[1] in MONTHS)) return '';
  const d = new Date(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  return isNaN(d) ? '' : d.toISOString();
}

// ps の出力 → [{ pid, ppid, since, command }]。日付は曜日・月・日・時刻・年の5つ
function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], since: parseLstart(m[3]), command: m[4] });
  }
  return rows;
}

function parseLsof(text) {
  const out = new Map(); let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1) || 0;
    else if (line[0] === 'n' && pid && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}


function processSnapshot(run = execFileSync){
  if(!['darwin','linux'].includes(name))throw Error('このOSではプロセスの所有確認に対応していません');
  const out=run('ps',['-axo','pid=,ppid=,pgid=,uid=,lstart=,stat=,comm='],{encoding:'utf8',timeout:2000,maxBuffer:8*1024*1024,env:{...process.env,LC_ALL:'C',LANG:'C'}});
  const rows=[];
  for(const l of out.split('\n')){const m=l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/);if(m&&!m[6].startsWith('Z'))rows.push({pid:+m[1],ppid:+m[2],pgid:+m[3],uid:+m[4],since:m[5].replace(/\s+/g,' '),command:m[7]});}
  if(!rows.length)throw Error('プロセスの所有確認に失敗しました');return rows;
}
function processOwner(row) {
  if (!['darwin', 'linux'].includes(name)) throw unsupported();
  return row?.uid;
}
function currentProcessOwner() {
  if (!['darwin', 'linux'].includes(name)) throw unsupported();
  return process.getuid?.();
}

function fixPtyHelper(base) {
  for (const sub of ['prebuilds', 'build/Release', 'build/Debug']) {
    const dir = path.join(base, sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      const f = n === 'spawn-helper' ? path.join(dir, n) : path.join(dir, n, 'spawn-helper');
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o755); } catch (e) { /* 無視 */ }
    }
  }
}
function findExecutable(cmd, envPath) {
  if (!['darwin', 'linux'].includes(name)) throw unsupported();
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const d of String(envPath || '').split(':')) {
    if (!d) continue;
    const f = path.join(d, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (e) { /* 次へ */ }
  }
  return null;
}


function processBirth(pid, run = execFileSync) {
  try { if (!['darwin', 'linux'].includes(name)) throw unsupported(); return run('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
async function listProcesses(exec = defaultExec) {
  if (!['darwin', 'linux'].includes(name)) throw unsupported();
  return parsePs(await exec('ps', psArgs(name)));
}
async function processCwd(pids, { exec = defaultExec, readlink = p => fs.readlinkSync(p) } = {}) {
  if (name === 'darwin') return parseLsof(await exec('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']));
  if (name !== 'linux') throw unsupported();
  const result = new Map();
  for (const pid of pids) { try { result.set(pid, readlink(`/proc/${pid}/cwd`)); } catch { /* other owner or exited */ } }
  return result;
}
function killTree(child, signal = 'SIGKILL', { fallback = true } = {}) {
  if (!['darwin', 'linux'].includes(name)) throw unsupported();
  try { return kill(-child.pid, signal); } catch (e) { if (!fallback) throw e; return child.kill(signal); }
}
const shellCandidates = () => { if (!['darwin', 'linux'].includes(name)) throw unsupported(); return ['/bin/zsh', '/bin/bash', '/bin/sh']; };
const trashDir = (home = os.homedir()) => { if (!['darwin', 'linux'].includes(name)) throw unsupported(); return path.join(home, '.Trash'); };
const isExternalTerminal = command => /\/(?:Terminal\.app\/Contents\/MacOS\/Terminal|iTerm\.app\/Contents\/MacOS\/iTerm2|kitty\.app\/Contents\/MacOS\/kitty)$/.test(command);
function existingParent(file, stat = fs.statSync) {
  let current = path.resolve(file);
  for (;;) {
    try { return { path: current, stat: stat(current) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
function volumeRoot(file, stat = fs.statSync) {
  const start = existingParent(file, stat);
  const device = start.stat.dev;
  let current = start.stat.isDirectory() ? start.path : path.dirname(start.path);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current || stat(parent).dev !== device) return current;
    current = parent;
  }
}
function trashRootFor(source, configured, options = {}) {
  const stat = options.stat || fs.statSync;
  const original = path.resolve(configured || process.env.HUB_TRASH || trashDir());
  // Explicit custom trash roots retain their meaning, including test fixtures.
  if (name !== 'darwin' || original !== path.resolve(options.homeTrash || trashDir())) return original;
  const sourceStat = existingParent(source, stat).stat;
  if (sourceStat.dev === existingParent(original, stat).stat.dev) return original;
  const root = volumeRoot(source, stat);
  const parent = path.join(root, '.Trashes');
  const directory = path.join(parent, String(options.uid ?? os.userInfo().uid));
  // Do not create or chmod the root-owned macOS Trash container. Finder manages it.
  const inspect = options.lstat || fs.lstatSync;
  const container = inspect(parent);
  if (!container.isDirectory() || container.isSymbolicLink()) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  try {
    const entry = inspect(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat(parent).dev !== sourceStat.dev) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  return directory;
}

// Private keys travel only through pipes. No command arguments or environment.
class MacSecretStore {
  constructor({ run = execFileSync, platform = name } = {}) { this.run = run; this.platform = platform; }
  call(request) {
    if (this.platform !== 'darwin') throw Error('secret_store_unavailable');
    try {
      const binary = path.join(__dirname, '../license/mac-native');
      const compiled = fs.existsSync(binary);
      const out = this.run(compiled ? binary : '/usr/bin/swift', compiled ? [] : [path.join(__dirname, '../license/mac-native.swift')], {
        input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 8192,
        stdio: ['pipe', 'pipe', 'pipe'] });
      return JSON.parse(out);
    } catch { throw Error('secret_store_unavailable'); }
  }
  get(account) { return this.call({ action: 'get', account }).value; }
  put(account, value) { this.call({ action: 'put', account, value }); }
  elapsed() { const n = this.call({ action: 'clock' }).seconds; if (!Number.isFinite(n)) throw Error('elapsed_clock_unavailable'); return n; }
  watchResume(onResume, onError) {
    if (this.platform !== 'darwin') return null;
    const binary = path.join(__dirname, '../license/mac-native'), compiled = fs.existsSync(binary);
    const child = spawn(compiled ? binary : '/usr/bin/swift', compiled ? [] : [path.join(__dirname, '../license/mac-native.swift')], { stdio: ['pipe','pipe','ignore'] });
    let rest = '', stopping = false;
    child.stdout.on('data', data => {
      rest += data.toString('utf8');
      const lines = rest.split('\n'); rest = lines.pop();
      for (const line of lines) { try { if (JSON.parse(line).event === 'resume') onResume(); } catch { onError?.(); } }
    });
    child.on('error', () => onError?.());
    child.on('exit', () => { if (!stopping) onError?.(); });
    child.stdin.on('error', () => onError?.());
    child.stdin.end(JSON.stringify({ action: 'watch' }));
    return () => { stopping = true; child.kill(); };
  }
}

function machineHint(run = execFileSync) {
  if (name !== 'darwin') throw Error('machine_hint_unavailable');
  const out = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['pipe','pipe','pipe'] });
  const uuid = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(out)?.[1];
  if (!uuid) throw Error('machine_hint_unavailable');
  return c.createHash('sha256').update('ProjectHub.PersonalTrial.v1\0' + uuid.toLowerCase()).digest('base64url');
}

const TEXT_LIMIT = 500000;
const PDF_SCRIPT = `function run(argv) {
  ObjC.import('PDFKit');
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  var count = Number(doc.pageCount);
  if (!doc || !Number.isFinite(count) || count < 1 || doc.isEncrypted) throw Error('PDF unavailable');
  var out = '';
  for (var i = 0; i < count && out.length <= ${TEXT_LIMIT}; i++) {
    var s = doc.pageAtIndex(i).string;
    var text = s ? ObjC.unwrap(s) : '';
    if (typeof text === 'string' && text.trim()) out += text + '\\n';
  }
  return out.slice(0, ${TEXT_LIMIT + 1});
}`;

async function readPdfText(file, run = asyncRun) {
  macOnly();
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, file], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
function imageInfo(file) { macOnly(); return execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }); }
function convertImage(file, output, options = { timeout: 15000, stdio: 'pipe' }) { macOnly(); return execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', output], options); }
function convertDocument(input, extension) {
  macOnly();
  return new Promise((resolve, reject) => {
    const child = (options.execFile || childProcess.execFile)('/usr/bin/textutil',
      ['-convert', 'html', '-noload', '-nostore', '-stdout', '-encoding', 'UTF-8', '-format', extension, '-stdin'],
      { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, html) => {
        // textutilは壊れた入力でも終了0で空出力になる場合がある。
        if (error) reject(error);
        else if (!/<html(?:\s|>)/i.test(html)) reject(Error('invalid document output'));
        else resolve(html);
      });
    child.stdin.on('error', () => {}); // 終了/時間切れ時のEPIPEは上のcallbackで扱う。
    child.stdin.end(input);
  });
}
function readArchive(args, options, run = asyncRun) { macOnly(); return run('/usr/bin/unzip', args, options); }
function pickFolder(prompt, onSelect) {
  if (name !== 'darwin') { if (onSelect) throw unsupported(); return Promise.reject(unsupported()); }
  const select = resolve => execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(prompt || lt('フォルダを選んでください')).replace(/["\\]/g, '')}")`], (err, out) => resolve(err ? '' : String(out).trim().replace(/\/$/, '')));
  // Legacy HTTP selection returns before the dialog closes.
  return onSelect ? select(onSelect) : new Promise(select);
}
// Resolve the user-domain location through the OS, including relocated homes.
// Looking up the URL does not create Documents or request access to its contents.
const DOCUMENTS_SCRIPT = `ObjC.import('Foundation');
var urls = $.NSFileManager.defaultManager.URLsForDirectoryInDomains($.NSDocumentDirectory, $.NSUserDomainMask);
if (Number(urls.count) !== 1) throw new Error('documents_directory_unavailable');
JSON.stringify(ObjC.unwrap(urls.objectAtIndex(0).path));`;
function documentsDirectory() {
  macOnly();
  let value;
  try {
    value = JSON.parse(String(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DOCUMENTS_SCRIPT], {
      encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 65536, windowsHide: true, shell: false,
    })).trim());
  } catch { throw Error('documents_directory_unavailable'); }
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.startsWith('//') || /[\0\r\n]/.test(value)) throw Error('documents_directory_unavailable');
  return path.posix.normalize(value);
}
const tailscaleCandidates = () => ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
const commandSandbox = {
  available: () => name === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'),
  profile(root, readFiles) {
    const quote = x => JSON.stringify(x);
    return `(version 1) (deny default)
      (allow process-exec process-fork signal sysctl-read mach-lookup)
      (allow file-read-metadata)
      (allow file-read* (literal "/") (subpath ${quote(root)}) ${['/System', '/usr', '/bin', '/sbin', '/Library'].map(x => '(subpath ' + quote(x) + ')').join(' ')} (literal ${quote(fs.realpathSync(process.execPath))}) (literal "/dev/null") (literal "/dev/urandom") ${readFiles.map(x => '(literal ' + quote(x) + ')').join(' ')})
      (allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))
      (deny file-read* file-write* (subpath ${quote(path.join(root, '.git'))})
        (regex #"(^|/)[.][gG][iI][tT](/|$)")
        (regex #"(^|/)([.][eE][nN][vV][^/]*|[.][nN][eE][tT][rR][cC]|[.][nN][pP][mM][rR][cC]|[.][pP][yY][pP][iI][rR][cC]|[iI][dD]_([rR][sS][aA]|[eE][dD]25519|[eE][cC][dD][sS][aA]|[dD][sS][aA])[^/]*|[^/]*[.]([pP][eE][mM]|[kK][eE][yY]|[pP]12|[pP][fF][xX]))$"))`;
  },
  spawn(command, root, profile, spawnProcess = spawn) {
    macOnly();
    return spawnProcess('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], { cwd: root, detached: true, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  }
};

const appUpdater = {
  sourceSupported: () => name === 'darwin',
  packagedSupported: arch => name === 'darwin' && arch === 'arm64',
  buildShell(hub, options, run) { macOnly(); return run('/bin/bash', [path.join(hub, 'app/build-app.sh')], options); },
  verify(app, options, run, absolute = false) { macOnly(); const file = absolute ? '/usr/bin/codesign' : 'codesign', args = ['--verify', '--deep', '--strict', app]; return options === undefined ? run(file, args) : run(file, args, options); },
  macOS(run) { macOnly(); return run('/usr/bin/sw_vers', ['-productVersion']); },
  readPlist(file) { macOnly(); return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })); },
  async bundlePlist(app, run) { macOnly(); return JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')])); },
  quarantine(app, run) { macOnly(); return run('/usr/bin/xattr', [app]); },
  hasQuarantine(app) {
    macOnly();
    return execFileSync('/usr/bin/xattr', [app], { encoding: 'utf8', timeout: 5000 }).split('\n').includes('com.apple.quarantine');
  },
  quarantineApproved(app) {
    macOnly();
    const flags = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app], { encoding: 'utf8', timeout: 5000 }).trim().split(';', 1)[0];
    const mask = /^[0-9a-f]+$/i.test(flags) ? Number.parseInt(flags, 16) : NaN;
    return Number.isSafeInteger(mask) && Boolean(mask & 0x40);
  },
  architecture(executable, run) { macOnly(); return run('/usr/bin/lipo', ['-archs', executable]); },
  verifyDmg(dmg, run) { macOnly(); return run('/usr/bin/hdiutil', ['verify', dmg]); },
  attachDmg(dmg, mount, run) { macOnly(); return run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount]); },
  copyApp(from, to, run) { macOnly(); return run('/usr/bin/ditto', [from, to]); },
  detachDmg(mount, extra, run) { macOnly(); return run('/usr/bin/hdiutil', ['detach', mount, ...extra]); },
};
return { name, openTerminal, focusTerminal, openPath, revealPath, openUrl, pickFolder, documentsDirectory,
  listProcesses, processCwd, processSnapshot, processOwner, currentProcessOwner, processBirth, killTree, isExternalTerminal,
  supervisorFiles: Object.freeze(['darwin.js', 'persistence.js']),
  persistence: require('./persistence').create(name, fs),
  shellCandidates, findExecutable, fixPtyHelper, trashDir, trashRootFor, volumeRoot, existingParent,
  commandSandbox, secretStore: options => new MacSecretStore(options), MacSecretStore, machineHint,
  readPdfText, PDF_SCRIPT, imageInfo, convertImage, convertDocument, readArchive, tailscaleCandidates, appUpdater,
  parsePs, parseLstart, parseLsof, psArgs };
}
module.exports = { ...create(), create };
