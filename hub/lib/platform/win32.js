'use strict';
const fs = require('node:fs');
const path = require('node:path').win32;
const os = require('node:os');
const { create: createNative } = require('./win32-native');
function create(options = {}) {
  const io = options.fs || fs, env = options.env || process.env;
  const native = options.native || createNative(options);
  // Reuse only guarded unsupported Mac operations and platform-neutral helpers.
  // All process, storage and desktop operations below are Windows implementations.
  const base = require('./darwin').create({ ...options, name: 'win32' });
  const unavailable = () => { throw Object.assign(Error('Windowsでは未対応：この機能は実行しません'), { code: 'platform_unsupported', platform: 'win32' }); };
  const valid = r => Number.isSafeInteger(r?.pid) && r.pid > 1 && Number.isSafeInteger(r.ppid) && r.ppid >= 0 &&
    /^S-1-(?:\d+-)*\d+$/.test(r.sid || '') && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(r.since || '') &&
    /^[a-z]:\\/i.test(r.command || '');
  function processSnapshot() {
    const result = native.call('snapshot');
    if (!Array.isArray(result) || !result.length || result.some(r => !valid(r)) || new Set(result.map(r => r.pid)).size !== result.length) throw Error('Windowsのプロセスの所有確認に失敗しました');
    return result;
  }
  const processOwner = row => valid(row) ? row.sid : undefined;
  function currentProcessOwner() {
    const self = processSnapshot().find(r => r.pid === process.pid);
    if (!self) throw Error('WindowsのHubの所有者を確認できません');
    return self.sid;
  }
  function processBirth(pid) { try { return processSnapshot().find(r => r.pid === pid)?.since || ''; } catch { return ''; } }
  function findExecutable(command, envPath = env.PATH || env.Path) {
    if (typeof command !== 'string' || !command || /[\0\r\n"]/.test(command)) return null;
    const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(e => /^\.[a-z0-9]+$/i.test(e));
    const names = path.extname(command) ? [command] : extensions.map(e => command + e.toLowerCase());
    const dirs = /[\\/]|^[a-z]:/i.test(command) ? [''] : String(envPath || '').split(';').map(d => d.replace(/^"(.*)"$/, '$1')).filter(d => path.isAbsolute(d));
    for (const dir of dirs) for (const name of names) {
      const file = dir ? path.join(dir, name) : path.resolve(name);
      try { if (io.statSync(file).isFile()) return file; } catch { /* next candidate */ }
    }
    return null;
  }
  function desktop(action, value, dry) {
    if (typeof value !== 'string' || !value || /[\0\r\n"]/.test(value)) return Promise.reject(Error('Windowsの開く場所を確認できません'));
    if (action === 'url') { if (!/^https?:\/\//i.test(value)) return Promise.reject(Error('WindowsのURLを確認できません')); }
    else if (!/^[a-z]:\\/i.test(value)) return Promise.reject(Error('Windowsの絶対パスが必要です'));
    const request = { path: value };
    if (dry) return Promise.resolve({ dry: true, action: action === 'url' ? 'open' : action, ...request });
    return new Promise((resolve, reject) => native.asyncCall(action === 'url' ? 'open' : action, request, (error) => error ? reject(error) : resolve({ ok: true })));
  }
  function pickFolder(prompt, callback) {
    const select = done => {
      try { return native.asyncCall('pick', { prompt: String(prompt || 'フォルダを選んでください') }, done); }
      catch (error) { done(error); }
    };
    // Keep the legacy callback contract; Promise callers must distinguish a
    // native failure from the user cancelling the dialog.
    return callback ? select((error, value) => callback(error ? '' : String(value))) : new Promise((resolve, reject) =>
      select((error, value) => error ? reject(Object.assign(Error('folder_picker_unavailable'), { code: 'folder_picker_unavailable' })) : resolve(String(value))));
  }
  function killTree(child, signal = 'SIGKILL') {
    if (![0, 'SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal)) throw Error('Windowsの停止信号に対応していません');
    if (!child || child.exitCode !== null || child.signalCode !== null || !Number.isSafeInteger(child.pid)) throw Error('Windowsの起動した子プロセスを確認できません');
    const rows = processSnapshot(), self = rows.find(r => r.pid === process.pid), root = rows.find(r => r.pid === child.pid);
    if (!self || !root || root.ppid !== self.pid || root.sid !== self.sid || root.since < self.since) throw Error('Windowsの停止対象の所有確認に失敗しました');
    const spawnFile = findExecutable(child.spawnfile);
    if (!spawnFile || spawnFile.toLowerCase() !== root.command.toLowerCase()) throw Error('Windowsの停止対象の実行ファイルを確認できません');
    const owned = new Map([[root.pid, root]]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (!owned.has(row.pid) && row.pid !== self.pid && row.sid === self.sid && owned.has(row.ppid) && row.since >= owned.get(row.ppid).since) { owned.set(row.pid, row); changed = true; }
    }
    // Never use /T or a process-group fallback. Native Stop rechecks owner,
    // FILETIME and executable on the same handle it terminates, for each row.
    for (const row of [...owned.values()].reverse()) if (native.call('stop', { row, caller: process.pid, probe: signal === 0 }) !== true) throw Error('Windowsの停止を確認できません');
    return true; // request delivered; callers still wait for the actual exit
  }
  const persistence = Object.freeze({
    // General storage uses ordinary-rights file flush + write-through rename.
    durability: 'file-flush-write-through-rename',
    renameSync(from, to) { if (native.call('rename', { from, to }) !== true) throw Error('Windowsの名前変更を確認できません'); },
    syncDirectory(dir) { const binding = native.call('directory', { path: dir }); if (typeof binding !== 'string' || !binding) throw Error('Windowsの保存確定を確認できません'); },
    syncFile(file) { if (native.call('file', { path: file }) !== true) throw Error('Windowsのファイル同期を確認できません'); },
    withDirectorySync(dir, operation) {
      const binding = native.call('directory', { path: dir });
      if (typeof binding !== 'string' || !binding) throw Error('Windowsの保存確定を確認できません');
      const value = operation();
      if (native.call('directory', { path: dir, expected: binding }) !== binding) throw Error('Windowsの保存先が変わりました');
      return value;
    },
  });
  const secretStore = () => {
    const call = (action, data) => { try { return native.call(action, data); } catch (error) { throw Object.assign(Error('secret_store_unavailable'), { stage: error.stage, reasonCode: error.reasonCode }); } };
    return {
      get(account) { const value = call('secret-get', { account }); if (value !== null && typeof value !== 'string') throw Error('secret_store_unavailable'); return value; },
      put(account, value) { if (call('secret-put', { account, value }) !== true) throw Error('secret_store_unavailable'); },
      elapsed() { const value = call('clock'); if (!Number.isFinite(value) || value < 0) throw Error('elapsed_clock_unavailable'); return value; },
      watchResume(onResume, onError, onSuspend) {
        try { return native.watch(event => { if (event === 'suspend') onSuspend?.(); else onResume(); }, onError); }
        catch (error) { onError?.(error); return null; }
      },
    };
  };
  function machineHint() {
    let value; try { value = native.call('machine-hint'); } catch (error) { throw Object.assign(Error('machine_hint_unavailable'), { stage: error.stage, reasonCode: error.reasonCode }); }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('machine_hint_unavailable');
    return value;
  }
  const trashDir = (home = os.homedir()) => path.join(home, '.ProjectHubTrash');
  return { ...base, name: 'win32', supervisorFiles: Object.freeze(['darwin.js', 'persistence.js', 'win32.js', 'win32-native.js', 'cache-guard.js', 'cache-guard-worker.js', 'file-io.js']),
    openTerminal: async () => unavailable(), focusTerminal: async () => unavailable(),
    openPath: (p, dry) => desktop('open', p, dry), revealPath: (p, dry) => desktop('reveal', p, dry), openUrl: (url, dry) => desktop('url', url, dry), pickFolder,
    processSnapshot, processOwner, currentProcessOwner, processBirth, listProcesses: async () => processSnapshot(), processCwd: async () => new Map(), killTree,
    isExternalTerminal: () => false, findExecutable, fixPtyHelper() {}, persistence,
    // Existing command callers use POSIX -lc. Use Git Bash, never WSL or cmd
    // with incompatible switches. Git for Windows is an explicit prerequisite.
    shellCandidates: () => [path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')],
    trashDir, trashRootFor: (source, configured) => path.resolve(configured || env.HUB_TRASH || trashDir()),
    commandSandbox: { available: () => false, profile: unavailable, spawn: unavailable },
    secretStore, machineHint,
    // Read-only path/NTFS identity validation, NOT a directory durability API.
    // LicenseStore obtains durability from SQLite WAL + synchronous FULL.
    licenseDirectory: (dir, expected) => native.call('license-directory', { path: dir, expected }),
    privateDirectory: (dir, create) => native.call('private-directory', { path: dir, create: Boolean(create) }),
    readPdfText: async () => unavailable(), imageInfo: unavailable, convertImage: unavailable, convertDocument: async () => unavailable(), readArchive: async () => unavailable(),
    tailscaleCandidates: () => ['tailscale.exe', path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')],
  };
}
module.exports = { create };
