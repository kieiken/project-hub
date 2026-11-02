'use strict';
// Test-only preload. This is not imported by any product entry point.
const Module = require('node:module'), net = require('node:net'), dgram = require('node:dgram');
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
if (process.env.HUB_TEST_OS_ISOLATION !== 'macos-v1') throw Error('test_isolation_os_required');
const marker = Symbol.for('hub.test.offline');
const log = name => { if (process.env.HUB_TEST_ISOLATION_LOG) fs.appendFileSync(process.env.HUB_TEST_ISOLATION_LOG, JSON.stringify({ pid: process.pid, event: name }) + '\n'); };
const reject = name => { log(name); throw Object.assign(Error('test_offline_' + name), { code: 'TEST_OFFLINE' }); };
const local = host => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(String(host).toLowerCase());
const connect = net.Socket.prototype.connect;
function guardedConnect(...args) {
  const options = net._normalizeArgs(args)[0];
  if (!options.path && !local(options.host || 'localhost')) reject('external_socket');
  return connect.apply(this, args);
}
net.Socket.prototype.connect = guardedConnect;
require('./local-auth-client.cjs');
const originalFetch = global.fetch;
function guardedFetch(input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['http:', 'https:'].includes(url.protocol) || !local(url.hostname)) reject('external_fetch');
  return originalFetch(input, { ...options, headers: require('./local-auth-client.cjs').headers(url.port || 80, options?.headers || input?.headers) });
}
global.fetch = guardedFetch;
const udp = {};
for (const method of ['send', 'connect']) { udp[method] = function () { reject('udp'); }; dgram.Socket.prototype[method] = udp[method]; }
// Preserve test-specific preloads, but never allow a child env to drop this one.
const option = '--require=' + JSON.stringify(__filename);
function childEnv(env = process.env) {
  const previous = env.NODE_OPTIONS || '';
  return { ...env, HUB_TEST_PROCESS_SOCKET: process.env.HUB_TEST_PROCESS_SOCKET, HUB_TEST_OS_ISOLATION: 'macos-v1', NODE_OPTIONS: previous.includes(option) ? previous : (previous + ' ' + option).trim(),
    ...(process.env.HUB_TEST_ISOLATION_LOG ? { HUB_TEST_ISOLATION_LOG: process.env.HUB_TEST_ISOLATION_LOG } : {}) };
}
process.env.NODE_OPTIONS = childEnv().NODE_OPTIONS;
const originals = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].map(name => [name, cp[name]]));
const wrapped = {};
for (const name of Object.keys(originals)) {
  wrapped[name] = function (file, ...args) {
    if (['open', 'osascript', 'security'].includes(path.basename(String(file)))) reject('native_auth_or_ui');
    const index = args.findIndex(value => value && typeof value === 'object' && !Array.isArray(value));
    if (index >= 0) args[index] = { ...args[index], env: childEnv(args[index].env) };
    else { const beforeCallback = typeof args.at(-1) === 'function' ? args.length - 1 : args.length; args.splice(beforeCallback, 0, { env: childEnv() }); }
    if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(name) && ['ps', '/bin/ps'].includes(file)) {
      args[0] = [path.join(__dirname, 'process-list.cjs'), ...(Array.isArray(args[0]) ? args[0] : [])];
      return originals[name].call(this, process.execPath, ...args);
    }
    return originals[name].call(this, file, ...args);
  };
  cp[name] = wrapped[name];
}
// exec/execFile have Node-specific promisification: callers receive both
// stdout and stderr, plus the child handle. Keep that contract after wrapping.
for (const name of ['exec', 'execFile']) {
  Object.defineProperty(wrapped[name], require('node:util').promisify.custom, { value: (...args) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.child = wrapped[name](...args, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    return promise;
  } });
}
const nativeStores = [], patched = new WeakSet(), load = Module._load;
function nativeSecret(secret) { return nativeStores.some(Type => secret instanceof Type && [originals.execFileSync, wrapped.execFileSync].includes(secret.run)); }
function guardedLoad(request, parent, isMain) {
  const result = load.apply(this, arguments);
  // Resolve local copies too: free-core tests intentionally boot exported trees.
  if (result && typeof result === 'object') {
    const Store = result.MacSecretStore;
    if (typeof Store === 'function' && !patched.has(Store)) {
      patched.add(Store); nativeStores.push(Store);
      const call = Store.prototype.call;
      Store.prototype.call = function (value) {
        if (nativeSecret(this) && value.action !== 'clock') reject('native_secret');
        return call.call(this, value);
      };
    }
    const Type = result.License;
    if (typeof Type === 'function' && !patched.has(Type)) {
      patched.add(Type);
      const prepare = Type.prototype.prepare, identity = Type.prototype.ensureIdentity;
      Type.prototype.prepare = async function (...args) {
        if (nativeSecret(this.secret) || this.fetcher === guardedFetch || this.fetcher === originalFetch) { log('prepare_suppressed'); return; }
        // Explicit memory secrets + fake/loopback issuer fixtures retain the
        // real trial/purchase rules. Real OS secrets and external sockets fail.
        return prepare.apply(this, args);
      };
      Type.prototype.ensureIdentity = function (...args) {
        if (nativeSecret(this.secret)) reject('native_identity');
        return identity.apply(this, args);
      };
    }
  }
  return result;
}
Module._load = guardedLoad;
function assertInstalled() {
  if (!process.env.HUB_TEST_PROCESS_SOCKET || process.env.HUB_TEST_OS_ISOLATION !== 'macos-v1' || global.fetch !== guardedFetch || net.Socket.prototype.connect !== guardedConnect || Module._load !== guardedLoad
    || Object.keys(wrapped).some(name => cp[name] !== wrapped[name]) || Object.keys(udp).some(name => dgram.Socket.prototype[name] !== udp[name])
    || !process.env.NODE_OPTIONS.includes(option)) throw Error('test_isolation_incomplete');
  return true;
}
process[marker] = Object.freeze({ assertInstalled });
assertInstalled(); log('offline_installed');
module.exports = { assertInstalled };
