'use strict';
const platforms = require('./platform');
const owned = require('./owned-processes');
const fs = require('node:fs'), path = require('node:path');
const unrelated = Symbol('unrelated-codex-home');
const within = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// Paths only: no contents or observed paths are persisted. A signature identifies
// a home, not an identity by itself; all open storage paths must agree with it.
function openFileAccount(p, homes, files, now, platform) {
  if (!owned.same(p, now, platform) || !files || files.uid !== platform.currentProcessOwner()) return null;
  const matches = new Set(), codexHomes = new Set();
  for (const file of files.paths) {
    if (/[\x00-\x1f\x7f]/.test(file)) return null;
    if (!path.isAbsolute(file)) continue;
    let real;
    try { real = fs.realpathSync(file); }
    catch (error) {
      // Preserve the reviewed exception for absent/inaccessible system images.
      const inHome = homes.some(home => [home.dir, home.original].some(dir => within(file, dir)));
      if (files.mapped?.includes(file) && !inHome) continue;
      throw error;
    }
    for (const home of homes) if (within(real, home.dir)) matches.add(home.id);
    if (files.mapped?.includes(file)) continue;
    if (/^(?:(?:logs|queue|state)_[0-9]+\.sqlite|\.sqlite-maintenance\.lock)$/.test(path.basename(real))) codexHomes.add(path.dirname(real));
    // Include every possible sessions ancestor; ambiguity must never release a
    // known home (e.g. nested directories also named sessions).
    for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (path.basename(dir) === 'sessions') codexHomes.add(path.dirname(dir));
    }
  }
  // Known-home attribution does not require a signature (exec-server can hold
  // only a tmp lock). Signatures are required to exclude an unrelated home.
  if (!codexHomes.size) return matches.size === 1 ? [...matches][0] : null;
  const identified = new Set();
  let foreign = false;
  for (const dir of codexHomes) {
    const exact = homes.filter(home => dir === home.dir);
    if (exact.length) for (const home of exact) identified.add(home.id);
    else {
      if (homes.some(home => within(dir, home.dir) || within(home.dir, dir))) return null;
      foreign = true;
    }
  }
  if (foreign) return identified.size === 0 && matches.size === 0 ? unrelated : null;
  return identified.size === 1 && matches.size === 1 && matches.has([...identified][0]) ? [...identified][0] : null;
}
function observeExternal(ai, external, roots, rows, platform = platforms, locations, probe = pid => process.kill(pid, 0)) {
  const by = new Map(rows.map(r => [r.pid, r])), pending = new Map();
  const busy = new Map();
  for (const item of external) {
    const p = by.get(item.pid), stamp = Date.parse(item.since);
    if (!Number.isSafeInteger(item.pid) || item.pid <= 1 || !Number.isFinite(stamp)) return 'unknown-process';
    if (!p || Date.parse(p.since) !== stamp) {
      // Only discard a stale Mac Codex entry with positive evidence of exit.
      // Absence from ps alone (or EPERM) cannot release an account.
      if (ai !== 'codex' || platform.name !== 'darwin') return 'unknown-process';
      if (p) {
        if (Number.isFinite(Date.parse(p.since)) && owned.same(p, p, platform)) continue; // valid new identity: PID reused
      } else {
        try { probe(item.pid); }
        catch (error) { if (error.code === 'ESRCH') continue; }
      }
      return 'unknown-process';
    }
    const seen = new Set(), matches = [];
    for (let r = p; r && r.pid > 1; r = by.get(r.ppid)) {
      if (seen.has(r.pid)) return 'unknown-process';
      if (!owned.sameOwner(p, r, platform)) { if (matches.length) break; return 'unknown-process'; }
      seen.add(r.pid);
      for (const root of roots.filter(root => root.identity?.pid === r.pid)) {
        if (root.ai !== ai || !root.account || !owned.same(r, root.identity, platform) || platform.processOwner(r) !== platform.currentProcessOwner()) return 'unknown-process';
        matches.push(root.account);
      }
    }
    if (!matches.length) pending.set(p.pid, p);
    else {
      if (new Set(matches).size !== 1) return 'unknown-process';
      busy.set(matches[0], true);
    }
  }
  if (!pending.size) return busy;
  if (ai !== 'codex' || platform.name !== 'darwin' || typeof locations !== 'function') return 'unknown-process';
  try {
    if ([...pending.values()].some(p => !owned.same(p, p, platform) || platform.processOwner(p) !== platform.currentProcessOwner())) return 'unknown-process';
    const homes = locations().map(row => {
      if (typeof row.id !== 'string' || !row.id || typeof row.dir !== 'string' || !path.isAbsolute(row.dir)) throw Error('invalid_account_home');
      try { return { id: row.id, original: row.dir, dir: fs.realpathSync(row.dir) }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }).filter(Boolean);
    if (!homes.length) return 'unknown-process';
    // procwatch keeps the wrapper and folds its native same-AI children. Follow
    // the snapshot's parent chains (also through non-AI helpers) to inspect them.
    const children = new Map(), families = new Map(), inspect = new Map(pending);
    for (const row of rows) {
      if (!children.has(row.ppid)) children.set(row.ppid, []);
      children.get(row.ppid).push(row);
    }
    const { aiOf } = require('./procwatch');
    for (const p of pending.values()) {
      const family = [p], stack = [p.pid], seen = new Set(stack);
      while (stack.length) for (const row of children.get(stack.pop()) || []) {
        if (seen.has(row.pid)) return 'unknown-process';
        seen.add(row.pid); stack.push(row.pid);
        if (aiOf(row.command) !== ai) continue;
        if (!owned.same(row, row, platform) || !owned.sameOwner(p, row, platform)) return 'unknown-process';
        family.push(row); inspect.set(row.pid, row);
      }
      families.set(p.pid, family);
    }
    // One bounded lsof for all unresolved families, then a fresh identity
    // snapshot. The caller may share this observation only within one display list.
    const files = platform.processOpenFiles([...inspect.keys()]);
    const fresh = new Map(platform.processSnapshot().map(row => [row.pid, row]));
    for (const p of pending.values()) {
      const merged = { uid: platform.currentProcessOwner(), paths: [], mapped: [] }, dataPaths = new Set();
      for (const member of families.get(p.pid)) {
        const file = files.get(member.pid);
        if (!owned.same(member, fresh.get(member.pid), platform) || !file || file.uid !== merged.uid) return 'unknown-process';
        merged.paths.push(...file.paths); merged.mapped.push(...(file.mapped || []));
        for (const name of file.paths) if (!file.mapped?.includes(name)) dataPaths.add(name);
      }
      // A mapped image in one process must not hide another's data descriptor.
      merged.mapped = merged.mapped.filter(name => !dataPaths.has(name));
      const found = openFileAccount(p, homes, merged, fresh.get(p.pid), platform);
      if (!found) return 'unknown-process';
      if (found !== unrelated && !busy.has(found)) busy.set(found, 'external-codex');
    }
  } catch { return 'unknown-process'; }
  return busy;
}

// Actions call this without any display observation: every call observes anew.
function externalBusy(ai, account, ...args) {
  return busyFor(observeExternal(ai, ...args), account);
}
function busyFor(observation, account) {
  return typeof observation === 'string' ? observation : observation.get(account) || false;
}

function managedRoots(chats, sessions) {
  const roots = [], spool = require('./cli-spool');
  for (const c of chats.spoolRuns) {
    if (!c.safe()) continue;
    const o = c.run?.options, started = spool.strictRead(c.dir, 'started.json'), launch = spool.strictRead(c.dir, 'launch.json');
    if (!o?.ai || fs.existsSync(path.join(c.dir, 'exit.json'))) continue;
    for (const [identity, pid] of [[started?.identity, c.pid], [launch?.identity, c.supervisorPid]]) if (identity?.pid === pid && Number.isSafeInteger(pid)) roots.push({ ai: o.ai, account: o.account || 'default', identity });
  }
  for (const r of chats.running.values()) if (!r.supervised && r.spawned && !r.finished && !r.ownershipError && r.identity) roots.push({ ai: r.ai, account: r.account || 'default', identity: r.identity });
  for (const s of sessions.map.values()) if (!s.exited && !s.ownershipError && s.identity) roots.push({ ai: s.ai, account: s.account || 'default', identity: s.identity });
  return roots;
}

module.exports = { externalBusy, observeExternal, busyFor, managedRoots };
