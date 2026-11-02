'use strict';
const platform = require('./platform');
// Portable data only. Never load a module, hook, account or device credential from a bundle.
const fs = require('./platform/file-io');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseDoc, parseValue, scalar } = require('./frontmatter');
const FORMAT = 'project-hub-move-v1';
const CONFIRM = '今のデータを別名に移して読み込む';
const MAX_ENTRIES = 500000, MAX_MANIFEST = 128 * 1024 * 1024;
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } };
const inside = (base, p) => p === base || p.startsWith(base + path.sep);
// Transfer bundles may land on a case-insensitive disk. Compare credential
// locations that way even if this machine's source volume is case-sensitive.
// Repeat casing so capital sharp S (ẞ -> ß -> SS -> ss) also converges.
const foldedPath = p => path.resolve(p).normalize('NFD').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize('NFD');
const foldedInside = (base, p) => inside(foldedPath(base), foldedPath(p));
const browserData = (root, file) => inside(foldedPath(path.join(root, '_hub/webchat')), foldedPath(file));
// Runtime owner capabilities are local to this account, never portable data.
const ownerData = file => foldedInside(require('./local-auth').directory(), file);
const sameDirectory = (a, b) => a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
// realpath can preserve an APFS Unicode alias. Compare identities on the source
// disk, so aliases are caught without conflating distinct case-sensitive roots.
function directoryInside(base, dir) {
  if (!exists(base) || !exists(dir)) return foldedInside(base, dir);
  const root = fs.lstatSync(base);
  for (let p = dir;; p = path.dirname(p)) {
    if (sameDirectory(root, fs.lstatSync(p))) return true;
    if (p === path.dirname(p)) return false;
  }
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
function check(ok, message) { if (!ok) throw Object.assign(Error(message), { status: 409 }); }
function json(file) { check(fs.lstatSync(file).isFile(), '記録が通常のファイルではありません'); check(fs.statSync(file).size <= MAX_MANIFEST, '記録が大きすぎます'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeParents(p, stop) {
  check(inside(stop, p), '保存先がホームの外です');
  for (let q = p; inside(stop, q); q = path.dirname(q)) {
    if (exists(q)) check(!fs.lstatSync(q).isSymbolicLink() && fs.lstatSync(q).isDirectory(), '保存先に別の場所へのリンクがあります');
    if (q === stop) break;
  }
}
function relName(rel) { return typeof rel === 'string' && rel.length > 0 && !rel.includes('\0') && !rel.includes('\\') && !path.posix.isAbsolute(rel) && rel.split('/').every(s => s && s !== '.' && s !== '..'); }
function portableRoot(home, p) {
  return typeof p === 'string' && path.isAbsolute(p) && path.normalize(p) === p && p !== home && inside(home, p) &&
    !path.relative(home, p).split(path.sep).some(s => ['.claude', '.codex', '.gemini', '.grok', '.hub-accounts', '.ssh', '.Trash', 'Library', 'ProjectHub-Move'].includes(s));
}
function excluded(rel, backups) {
  const a = rel.split('/');
  return a.some(s => ['node_modules', '.DS_Store', '.Trash', '.project-hub-use', '.hub-accounts', '.claude', '.codex', '.gemini', '.grok', 'owner-edition.js'].includes(s)) ||
    a[0] === 'Work' || (!backups && a[0] === 'Backups') ||
    /(^|\/)ProjectHub-Move(\/|$)/.test(rel) ||
    /^_hub\/(?:license|updates|cli-runs|move|account-processes)(?:\/|$)/.test(rel) ||
    /^_hub\/webchat(?:\/|$)/.test(foldedPath('/' + rel).slice(1)) ||
    /^_hub\/(?:accounts|remote)\.json$/.test(rel) ||
    /(?:^|\/)(?:[^/]+\.lock|[^/]+\.sock|Singleton[^/]*)$/.test(rel);
}
function regular(file) { return exists(file) && fs.lstatSync(file).isFile(); }
function linkSafe(rel, link) {
  if (typeof link !== 'string' || path.isAbsolute(link) || link.includes('\0') || link.includes('\\')) return false;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), link));
  return target !== '..' && !target.startsWith('../');
}
function lookup(base, rel) {
  // A transfer to a normalization-insensitive filesystem may change every component.
  let cur = base;
  for (const part of rel.split('/')) {
    check(fs.lstatSync(cur).isDirectory() && !fs.lstatSync(cur).isSymbolicLink(), 'データの途中にリンクがあります');
    const names = fs.readdirSync(cur).filter(n => n.normalize('NFC') === part.normalize('NFC'));
    check(names.length === 1, '名前を一意に照合できません');
    cur = path.join(cur, names[0]);
  }
  return cur;
}
async function atomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  const h = await fsp.open(tmp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
  await fsp.rename(tmp, file);
  if (process.platform === 'win32') platform.persistence.syncDirectory(path.dirname(file));
  else { const d = await fsp.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); } }
}
async function copyFile(from, to, expected) {
  const input = await fsp.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat(); check(before.isFile(), '通常のファイルではありません');
    output = await fsp.open(to, 'wx', 0o600);
    const h = createHash('sha256'), block = Buffer.alloc(1024 * 1024);
    let size = 0, tail = '';
    for (;;) {
      const { bytesRead } = await input.read(block, 0, block.length, null); if (!bytesRead) break;
      const b = block.subarray(0, bytesRead); h.update(b); size += bytesRead;
      const text = tail + b.toString('latin1'); check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), '秘密鍵を含むため書き出しを止めました'); tail = text.slice(-100);
      if (expected) check(size <= expected.size, 'データの大きさが変わっています');
      await output.writeFile(b);
    }
    const after = await input.stat(), sha256 = h.digest('hex');
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && size === before.size, 'コピー中にデータが変わりました');
    if (expected) check(size === expected.size && sha256 === expected.sha256, 'データの照合が一致しません');
    await output.sync(); return { size, sha256 };
  } finally { await input.close(); await output?.close(); }
}
async function fileHash(file) {
  const h = createHash('sha256'), input = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  for await (const b of input) h.update(b); return h.digest('hex');
}
function gitConfig(dir) {
  const file = path.join(dir, '.git', 'config');
  if (!exists(file)) return '';
  if (!regular(file)) return '[include]'; // A linked configuration cannot be audited in isolation.
  return fs.readFileSync(file, 'utf8');
}
function riskyGit(config) {
  return /\[(?:include|includeIf|filter|credential|alias|extensions)\b|^\s*(?:fsmonitor|hooksPath|sshCommand|worktree)\s*=/im.test(config);
}
function git(dir, args) {
  // Callers reject configurations capable of running commands/includes before this call.
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  return execFileSync('git', ['--no-optional-locks', '-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=false', '-c', 'gc.auto=0', ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
class Move {
  constructor({ root, home = os.homedir(), version = '', edition = 'public', busy = () => false, barrier = () => {}, freeBytes, fault = async () => {} } = {}) {
    this.home = path.resolve(home); this.root = path.resolve(root || path.join(home, 'Documents/AI-Workspace'));
    this.freetalk = path.join(this.home, 'Documents/freetalk'); this.inbox = path.join(this.home, 'Documents/ProjectHub-Move');
    this.journal = path.join(this.home, 'Library/Application Support/ProjectHub/move-journal.json');
    this.freeBytes = freeBytes || (p => { const s = fs.statfsSync(p); return s.bavail * s.bsize; });
    Object.assign(this, { version, edition, busy, barrier, fault }); this.state = { mode: 'none', progress: 0, notIncluded: [], attention: [] }; this.running = false;
  }
  status() {
    if (this.state.mode === 'none') {
      const record = path.join(this.root, '_hub/move/import.json');
      if (regular(record)) { try { const data = json(record); if (!data.bundle || !regular(path.join(this.inbox, data.bundle, 'imported.json'))) delete data.bundle; return { ...data, mode: 'imported', notice: '引っ越しを読み込みました。AIのログインはこのMacでやり直してください', bundles: [] }; } catch {} }
    }
    return { ...this.state, bundles: this.bundles || [] };
  }
  discovery() {
    safeParents(this.inbox, this.home);
    const bundles = [];
    if (exists(this.inbox)) for (const name of fs.readdirSync(this.inbox)) {
      if (!/^[^/\\]+\.hubmove$/.test(name)) continue;
      const dir = path.join(this.inbox, name);
      try {
        if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory() || exists(path.join(dir, 'imported.json')) || exists(path.join(dir, 'skipped.json'))) continue;
        const m = json(path.join(dir, 'manifest.json'));
        if (m.format === FORMAT && m.complete === true) bundles.push(name);
      } catch { /* Incomplete exports are not candidates. */ }
    }
    this.bundles = bundles.sort(); return this.bundles;
  }
  needsStartup() {
    safeParents(path.dirname(this.journal), this.home);
    if (exists(this.journal)) { const j = json(this.journal); if (j.phase !== 'done' && j.phase !== 'rolled-back') return true; }
    const names = this.discovery(); if (!names.length) return false;
    // A copy left on its source Mac is not an instruction to replace that Mac's data.
    if (names.length === 1) {
      const m = json(path.join(this.inbox, names[0], 'manifest.json'));
      if (m.source?.home === this.home && m.source?.workspace === this.root && exists(this.root)) return false;
    }
    this.state = { ...this.state, mode: names.length === 1 ? 'found' : 'conflict', bundle: names.length === 1 ? names[0] : null }; return true;
  }
  async inventory(includeBackups) {
    check(portableRoot(this.home, this.root), 'ホーム内の作業データだけを移せます');
    const roots = [{ id: 'workspace', orig: this.root }, { id: 'freetalk', orig: this.freetalk }].filter(r => exists(r.orig));
    const browser = path.join(this.root, '_hub/webchat'), browserStat = exists(browser) ? fs.lstatSync(browser) : null;
    const notIncluded = [], worktrees = [], entries = [];
    const product = path.join(this.root, 'Product');
    if (exists(product)) for (const project of fs.readdirSync(product)) {
      const file = path.join(product, project, 'PROJECT.md'); if (!regular(file)) continue;
      safeParents(path.dirname(file), this.home);
      const folders = parseDoc(fs.readFileSync(file, 'utf8')).data.folders;
      for (const [label, value] of Object.entries(folders && typeof folders === 'object' ? folders : {})) {
        if (typeof value !== 'string' || !value) continue;
        const orig = path.resolve(value.startsWith('~') ? path.join(this.home, value.slice(1)) : value);
        if (ownerData(orig)) { notIncluded.push({ path: orig, reason: 'local-owner-capability' }); continue; }
        if (browserData(this.root, orig)) { notIncluded.push({ path: orig, reason: 'このMac専用のブラウザのログイン情報' }); continue; }
        if (!inside(this.home, orig) || orig === this.home) { notIncluded.push({ path: orig, reason: 'home-outside' }); continue; }
        if (!portableRoot(this.home, orig)) { notIncluded.push({ path: orig, reason: 'private-location' }); continue; }
        // Resolve case aliases before de-duplicating external roots, without
        // following a symlink that safeParents would otherwise refuse.
        if (exists(orig)) {
          safeParents(orig, this.home);
          if (browserStat && directoryInside(browser, orig)) { notIncluded.push({ path: orig, reason: 'このMac専用のブラウザのログイン情報' }); continue; }
          if (roots.some(r => directoryInside(r.orig, orig))) continue;
        }
        // Ancestors of the workspace/other roots would duplicate data and authentication homes.
        check(!roots.some(r => directoryInside(orig, r.orig)), 'プロジェクトの場所が保存場所全体を含んでいます');
        if (!exists(orig)) { notIncluded.push({ path: orig, reason: 'missing' }); continue; }
        safeParents(orig, this.home); roots.push({ id: `ext-${roots.filter(r => r.id.startsWith('ext-')).length + 1}`, orig, project, label });
      }
    }
    for (const root of roots) {
      safeParents(root.orig, this.home);
      const walk = async (dir, prefix = '') => {
        for (const name of (await fsp.readdir(dir)).sort()) {
          const rel = prefix + name, file = path.join(dir, name);
          if (browserData(this.root, file) || ownerData(file)) continue;
          if (excluded(rel, includeBackups)) {
            if (/^_hub\/(?:accounts|remote)\.json$/.test(rel)) notIncluded.push({ path: file, reason: 'このMac専用のアカウント・遠隔操作設定。新しいMacで設定してください' });
            continue;
          }
          check(relName(rel), '移せないファイル名があります');
          const st = await fsp.lstat(file), mode = (st.mode & 0o777).toString(8).padStart(3, '0');
          if (browserStat && sameDirectory(browserStat, st)) continue;
          // Only the workspace's control directory has this meaning. External
          // project folders may legitimately have an unrelated _hub link.
          if (root.id === 'workspace' && foldedPath('/' + rel) === '/_hub' && st.isSymbolicLink()) {
            notIncluded.push({ path: file, reason: 'ブラウザ設定へのリンクは移しません' }); continue;
          }
          const e = { root: root.id, rel, nameB64: Buffer.from(rel, 'utf8').toString('base64'), mode, size: 0, sha256: null, link: null };
          if (st.isSymbolicLink()) {
            const link = await fsp.readlink(file);
            if (!linkSafe(rel, link)) { notIncluded.push({ path: file, reason: 'link-outside' }); continue; }
            e.type = 'link'; e.link = link;
          } else if (st.isDirectory()) e.type = 'dir';
          else if (st.isFile()) { e.type = 'file'; e.size = st.size; }
          else { notIncluded.push({ path: file, reason: 'special-file' }); continue; }
          entries.push(e); check(entries.length <= MAX_ENTRIES, 'ファイル数が上限を超えました');
          check(name !== '.git' || e.type === 'dir', '外部のGitを参照する作業用コピーは移せません。本体のリポジトリを指定してください');
          if (name === '.git' && e.type === 'dir') {
            const repo = path.dirname(file), config = gitConfig(repo);
            if (riskyGit(config)) {
              notIncluded.push({ path: repo, reason: 'git-config-attention' });
              check(!exists(path.join(file, 'worktrees')) || !fs.readdirSync(path.join(file, 'worktrees')).length, 'Git設定の確認が必要な本体に作業用コピーがあります。先に設定を確認してください');
            }
            const rows = riskyGit(config) ? [] : git(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
            for (const row of rows) {
              const loc = row.match(/^worktree (.+)$/m)?.[1];
              if (!loc || !inside(path.join(this.root, 'Work'), loc) || !exists(loc)) continue;
              check(!git(loc, ['status', '--porcelain', '--untracked-files=all']), `保存していない作業があります：${path.basename(loc)}`);
              worktrees.push({ repo: `${root.id}:${path.relative(root.orig, repo)}`, task: path.basename(loc), branch: row.match(/^branch refs\/heads\/(.+)$/m)?.[1] || '', head: row.match(/^HEAD (.+)$/m)?.[1] || '' });
            }
          }
          if (e.type === 'dir') await walk(file, rel + '/');
        }
      }; await walk(root.orig);
    }
    return { roots, entries, notIncluded, worktrees, totals: { files: entries.filter(e => e.type === 'file').length, bytes: entries.reduce((n, e) => n + e.size, 0) } };
  }
  capacity(bytes) { safeParents(path.join(this.home, 'Documents'), this.home); check(this.freeBytes(path.join(this.home, 'Documents')) >= Math.ceil(bytes * 1.1), '空き容量が足りません。データの1.1倍の空きが必要です'); }
  async export({ includeBackups = false } = {}) {
    check(!this.running, 'AI・順番待ち・保存・更新が終わってから引っ越してください'); this.running = true;
    try {
      check(!(this.strictBusy ? await this.strictBusy() : this.busy()), 'AI・順番待ち・保存・更新が終わってから引っ越してください');
      this.barrier(true); this.state = { mode: 'exporting', progress: 0 };
      const inv = await this.inventory(includeBackups === true); this.capacity(inv.totals.bytes);
      safeParents(this.inbox, this.home); await fsp.mkdir(this.inbox, { recursive: true, mode: 0o700 });
      const bundle = path.join(this.inbox, `ProjectHub-${stamp()}.hubmove`);
      await fsp.mkdir(bundle, { mode: 0o700 }); this.state.bundle = path.basename(bundle);
      const manifest = { format: FORMAT, createdAt: new Date().toISOString(), complete: true, source: { hubVersion: this.version, edition: this.edition, home: this.home, workspace: this.root, freetalk: this.freetalk }, ...inv };
      for (const r of inv.roots) await fsp.mkdir(path.join(bundle, 'data', r.id), { recursive: true });
      for (let i = 0; i < inv.entries.length; i++) {
        const e = inv.entries[i], r = inv.roots.find(r => r.id === e.root), dest = path.join(bundle, 'data', e.root, e.rel);
        if (e.type === 'dir') await fsp.mkdir(dest);
        else if (e.type === 'link') await fsp.symlink(e.link, dest);
        else { const result = await copyFile(path.join(r.orig, e.rel), dest); check(result.size === e.size, '書き出し前後で大きさが変わりました'); Object.assign(e, result); }
        this.state.progress = i + 1;
      }
      for (const e of inv.entries) {
        const file = path.join(bundle, 'data', e.root, e.rel);
        if (e.type === 'file') check(await fileHash(file) === e.sha256, '書き出したデータの照合が一致しません');
        if (e.type !== 'link') await fsp.chmod(file, parseInt(e.mode, 8));
      }
      // Catch changes to files that had already been copied; incomplete folders are ignored on startup.
      for (const e of inv.entries.filter(e => e.type === 'file')) {
        const root = inv.roots.find(r => r.id === e.root); check(await fileHash(path.join(root.orig, e.rel)) === e.sha256, '書き出し中に元のデータが更新されました');
      }
      const after = await this.inventory(includeBackups === true);
      check(JSON.stringify(after.roots) === JSON.stringify(inv.roots) && JSON.stringify(after.entries.map(({sha256, ...e}) => e)) === JSON.stringify(inv.entries.map(({sha256, ...e}) => e)), '書き出し中にファイルの一覧が変わりました');
      await atomic(path.join(bundle, 'manifest.json'), manifest);
      this.state = { mode: 'exported', bundle: path.basename(bundle), path: bundle, totals: inv.totals, notIncluded: inv.notIncluded, attention: [] };
      return this.status();
    } catch (e) { this.state = { ...this.state, mode: 'failed', error: e.message }; throw e; }
    finally { this.running = false; this.barrier(false); }
  }
  manifest(name) {
    check(this.discovery().includes(name), '引っ越しデータを選び直してください');
    const bundle = path.join(this.inbox, name), m = json(path.join(bundle, 'manifest.json'));
    check(m.format === FORMAT && m.complete === true && m.source && Array.isArray(m.roots) && m.roots.length <= 1000 && Array.isArray(m.entries) && m.entries.length <= MAX_ENTRIES, '目録の形式が違います');
    check(typeof m.source.home === 'string' && path.isAbsolute(m.source.home) && path.normalize(m.source.home) === m.source.home && portableRoot(m.source.home, m.source.workspace), '元の保存場所が不正です');
    const ids = new Set(), origins = [];
    for (const r of m.roots) {
      check(/^(workspace|freetalk|ext-[1-9][0-9]*)$/.test(r.id) && !ids.has(r.id) && portableRoot(m.source.home, r.orig)
        && !browserData(m.source.workspace, r.orig)
        && !origins.some(p => inside(p.normalize('NFC'), r.orig.normalize('NFC')) || inside(r.orig.normalize('NFC'), p.normalize('NFC'))), 'データの範囲が不正です');
      check(r.id !== 'workspace' || r.orig === m.source.workspace, '台帳の場所が一致しません');
      check(r.id !== 'freetalk' || r.orig === path.join(m.source.home, 'Documents/freetalk'), 'freetalkの場所が一致しません');
      safeParents(path.join(bundle, 'data', r.id), this.home);
      ids.add(r.id); origins.push(r.orig);
    }
    check(ids.has('workspace'), '台帳がありません');
    const seen = new Map(); let bytes = 0, files = 0;
    for (const e of m.entries) {
      check(ids.has(e.root) && relName(e.rel) && Buffer.from(e.rel).toString('base64') === e.nameB64 && ['file', 'dir', 'link'].includes(e.type) && /^[0-7]{3}$/.test(e.mode) && !excluded(e.rel, true), '目録に移せない項目があります');
      check(!(e.root === 'workspace' && foldedPath('/' + e.rel) === '/_hub' && e.type === 'link'), 'ブラウザ設定へのリンクは読み込めません');
      const key = e.root + '/' + e.rel.normalize('NFC'); check(!seen.has(key), '同じ名前のデータがあります');
      const parent = path.posix.dirname(e.rel); check(parent === '.' || seen.get(e.root + '/' + parent.normalize('NFC')) === 'dir', '親フォルダがありません'); seen.set(key, e.type);
      check(Number.isSafeInteger(e.size) && e.size >= 0, '大きさが不正です');
      if (e.type === 'file') { check(/^[a-f0-9]{64}$/.test(e.sha256), '照合値が不正です'); bytes += e.size; files++; }
      else check(e.size === 0 && e.sha256 === null, '目録の大きさが不正です');
      if (e.type === 'link') check(linkSafe(e.rel, e.link), '外へのリンクは読み込めません');
    }
    check(Number.isSafeInteger(bytes) && bytes === m.totals?.bytes && files === m.totals?.files, '合計が一致しません');
    return { bundle, m };
  }
  async seedOnly() {
    // Only a receipt written by the initial seed installer can establish this condition.
    const file = path.join(this.root, '_hub/seed-receipt.json');
    if (!regular(file) || exists(this.freetalk)) return false;
    try {
      const receipt = json(file); if (receipt.format !== 'project-hub-seed-v1' || !Array.isArray(receipt.files)) return false;
      const names = [];
      const walk = async (d, pre = '') => { for (const n of await fsp.readdir(d)) { const rel = pre + n, f = path.join(d, n), s = await fsp.lstat(f); if (s.isDirectory()) await walk(f, rel + '/'); else { if (!s.isFile()) throw Error(); names.push(rel); } } };
      await walk(this.root);
      if (names.length !== receipt.files.length + 1) return false;
      for (const e of receipt.files) if (!relName(e.rel) || !names.includes(e.rel) || await fileHash(path.join(this.root, e.rel)) !== e.sha256) return false;
      return true;
    } catch { return false; }
  }
  async import({ action = 'start', bundle: name, confirm } = {}) {
    check(!this.running, '引っ越しの処理中です'); this.running = true;
    try {
      check(!(this.strictBusy ? await this.strictBusy() : this.busy()), '別の処理が終わってから引っ越してください');
      this.barrier(true); return await this.importReserved({ action, bundle: name, confirm });
    }
    catch (e) { this.state = { ...this.state, mode: 'failed', error: e.message }; throw e; }
    finally { this.running = false; this.barrier(false); }
  }
  async importReserved({ action, bundle: name, confirm }) {
    if (action === 'skip') { const { bundle } = this.manifest(name); await atomic(path.join(bundle, 'skipped.json'), { at: new Date().toISOString() }); this.state = { mode: 'none' }; return this.status(); }
    check(['start', 'rename-current-and-import'].includes(action), '読み込み方法が違います');
    const { bundle, m } = this.manifest(name);
    safeParents(this.root, this.home); safeParents(this.freetalk, this.home);
    const seed = await this.seedOnly();
    if ((exists(this.root) || exists(this.freetalk)) && !seed && !(action === 'rename-current-and-import' && confirm === CONFIRM)) {
      this.state = { mode: 'conflict', bundle: name, totals: m.totals, error: '今のデータは上書きしません。別名に移して読み込むか選んでください' }; return this.status();
    }
    this.capacity(m.totals.bytes); this.state = { mode: 'importing', bundle: name, progress: 0, totals: m.totals };
    let j;
    try {
      const id = randomUUID(), stage = path.join(this.home, 'Documents/.ProjectHub-move-' + id);
      safeParents(stage, this.home); await fsp.mkdir(stage, { mode: 0o700 });
      const maps = [], reserved = new Set(), entriesByRoot = new Map(m.roots.map(r => [r.id, []]));
      for (const e of m.entries) entriesByRoot.get(e.root).push(e);
      for (const r of m.roots) {
        const rootEntries = entriesByRoot.get(r.id);
        let dest = r.id === 'workspace' ? this.root : r.id === 'freetalk' ? this.freetalk : path.join(this.home, path.relative(m.source.home, r.orig));
        // Reject credential destinations before collision relocation as well:
        // relocation must not launder a profile from a differently named workspace.
        check(!ownerData(dest) && !rootEntries.some(e => ownerData(path.join(dest, e.rel))), 'この端末の内部認証は移せません');
        check(!browserData(this.root, dest)
          && !rootEntries.some(e => browserData(this.root, path.join(dest, e.rel))), 'ブラウザのログイン情報は読み込めません');
        if (r.id.startsWith('ext-') && (exists(dest) || foldedInside(this.root, dest) || foldedInside(dest, this.root) || foldedInside(this.freetalk, dest) || foldedInside(dest, this.freetalk))) {
          const label = (String(r.project || 'project') + '-' + String(r.label || 'files')).replace(/[/\\\0]/g, '_');
          dest = path.join(this.home, 'Documents/Project Hub 引っ越し', label);
        }
        const base = dest; for (let n = 2; (r.id.startsWith('ext-') && exists(dest)) || reserved.has(foldedPath(dest)); n++) dest = base + '-' + n;
        check(portableRoot(this.home, dest) && !browserData(this.root, dest), '移す先が安全なデータの場所ではありません');
        // The source workspace name need not match this Mac's workspace. Check
        // every mapped entry before moving or staging any existing user data.
        check(!ownerData(dest) && !rootEntries.some(e => ownerData(path.join(dest, e.rel))), 'この端末の内部認証は移せません');
        check(!rootEntries.some(e => browserData(this.root, path.join(dest, e.rel))), 'ブラウザのログイン情報は読み込めません');
        check(!rootEntries.some(e => e.type === 'link'
          && foldedPath(path.join(dest, e.rel)) === foldedPath(path.join(this.root, '_hub'))), 'ブラウザ設定へのリンクは読み込めません');
        safeParents(path.dirname(dest), this.home); reserved.add(foldedPath(dest)); maps.push({ id: r.id, from: r.orig, to: dest });
        await fsp.mkdir(path.join(stage, r.id));
      }
      for (let i = 0; i < m.entries.length; i++) {
        const e = m.entries[i], src = lookup(path.join(bundle, 'data', e.root), e.rel), dest = path.join(stage, e.root, e.rel), s = await fsp.lstat(src);
        if (e.type === 'dir') { check(s.isDirectory() && !s.isSymbolicLink(), 'フォルダの種類が違います'); await fsp.mkdir(dest); }
        else if (e.type === 'link') { check(s.isSymbolicLink() && await fsp.readlink(src) === e.link, 'リンクが変わっています'); await fsp.symlink(e.link, dest); }
        else { check(s.isFile(), 'ファイルの種類が違います'); await copyFile(src, dest, e); }
        this.state.progress = i + 1;
      }
      for (const e of m.entries) {
        const file = path.join(stage, e.root, e.rel), s = await fsp.lstat(file);
        if (e.type === 'file') check(s.isFile() && await fileHash(file) === e.sha256, '読み込んだデータの照合が一致しません');
        else if (e.type === 'dir') check(s.isDirectory() && !s.isSymbolicLink(), '読み込んだフォルダの種類が違います');
        else check(s.isSymbolicLink() && await fsp.readlink(file) === e.link, '読み込んだリンクが違います');
      }
      const { attention, pruned } = await this.rewrite(stage, m, maps);
      // Apply restrictive directory modes last, after verification and metadata relocation.
      for (const e of [...m.entries].reverse()) if (e.type !== 'link') {
        const file = path.join(stage, e.root, e.rel);
        if (!exists(file) && pruned.has(file)) continue;
        await fsp.chmod(file, parseInt(e.mode, 8));
        check(((await fsp.lstat(file)).mode & 0o777) === parseInt(e.mode, 8), '権限の照合が一致しません');
      }
      const ops = [];
      // This Mac's device state never enters the transfer folder and must survive replacement.
      const localLicense = path.join(this.root, '_hub/license');
      if (exists(localLicense)) {
        safeParents(localLicense, this.home);
        ops.push({ from: localLicense, to: path.join(stage, 'workspace/_hub/license'), kind: 'local-license', done: false });
      }
      for (const map of maps) {
        let parent = path.dirname(map.to); while (!exists(parent)) parent = path.dirname(parent);
        check(fs.statSync(parent).dev === fs.statSync(stage).dev, '移す先が別のディスクです。場所を確認してください');
        if (exists(map.to)) {
          check(['workspace', 'freetalk'].includes(map.id), '読み込み先にデータが増えました');
          const backup = seed ? path.join(platform.trashDir(this.home), path.basename(map.to) + '-' + id) : map.to + '-退避-' + id;
          safeParents(path.dirname(backup), this.home); ops.push({ from: map.to, to: backup, kind: 'backup', done: false });
        }
        ops.push({ from: path.join(stage, map.id), to: map.to, kind: 'install', done: false });
      }
      j = { format: FORMAT, id, phase: 'prepared', bundle: name, stage, ops, maps, attention, notIncluded: m.notIncluded || [] };
      await atomic(this.journal, j); await this.fault('prepared');
      await this.commit(j); return this.status();
    } catch (e) { this.state = { ...this.state, mode: 'failed', error: e.message }; throw e; }
  }
  async rewrite(stage, m, maps) {
    const changes = [], attention = [], pruned = new Set(), sorted = [...maps].sort((a, b) => b.from.length - a.from.length);
    const relocate = value => {
      if (typeof value !== 'string' || !value) return value;
      const expanded = value.startsWith('~') ? path.join(m.source.home, value.slice(1)) : value;
      const map = sorted.find(r => inside(r.from, expanded));
      if (map) return path.join(map.to, path.relative(map.from, expanded));
      return inside(m.source.home, expanded) ? path.join(this.home, path.relative(m.source.home, expanded)) : value;
    };
    for (const e of m.entries.filter(e => e.type === 'file')) {
      const file = path.join(stage, e.root, e.rel);
      if (e.rel.endsWith('.ai/freetalk.json')) {
        const data = json(file), before = data.ledger; data.ledger = relocate(data.ledger);
        if (before !== data.ledger) { changes.push({ file: `${e.root}:${e.rel}`, field: 'ledger', before }); await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n'); }
      } else if (path.basename(e.rel) === 'PROJECT.md' || /(?:^|\/)\.ai\/tasks\/[^/]+\.md$/.test(e.rel)) {
        const text = await fsp.readFile(file, 'utf8'), match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (!match) continue;
        let folders = false;
        const header = match[1].split(/\r?\n/).map(line => {
          if (/^\S/.test(line)) folders = /^folders:/.test(line);
          if (!(path.basename(e.rel) === 'PROJECT.md' && folders && /^\s+[^:]+:/.test(line)) && !/^workdir:/.test(line)) return line;
          const hit = line.match(/^(\s*[^:]+:\s*)(.*)$/); if (!hit) return line;
          const value = parseValue(hit[2]), next = relocate(value);
          if (typeof value !== 'string' || next === value) return line;
          changes.push({ file: `${e.root}:${e.rel}`, field: hit[1].trim(), before: value }); return hit[1] + scalar(next);
        }).join(match[0].includes('\r\n') ? '\r\n' : '\n');
        if (header !== match[1]) await fsp.writeFile(file, text.replace(match[1], () => header));
      }
    }
    for (const e of m.entries.filter(e => e.type === 'dir' && path.basename(e.rel) === '.git')) {
      const repo = path.dirname(path.join(stage, e.root, e.rel));
      if (riskyGit(gitConfig(repo))) { attention.push({ path: repo.replace(stage, ''), reason: 'Git設定を確認してください。自動では実行しません' }); continue; }
      // Missing old Work registrations only; branches and all objects stay in the common repository.
      const registrations = path.join(repo, '.git/worktrees'), detached = [], protectedLocks = [];
      if (exists(registrations)) for (const name of fs.readdirSync(registrations)) {
        const registration = path.join(registrations, name), pointer = path.join(registration, 'gitdir');
        safeParents(registration, stage);
        if (!regular(pointer)) continue;
        const old = fs.readFileSync(pointer, 'utf8').trim();
        if (inside(path.join(m.source.workspace, 'Work'), old)) {
          // The source Mac may still be mounted in an isolated acceptance test.
          // Only registrations explicitly belonging to the omitted Work tree are detached.
          await fsp.writeFile(pointer, path.join(this.root, 'Work', '.not-restored-' + name, '.git') + '\n');
          // An explicitly locked worktree remains registered; never silently unlock it.
          if (!exists(path.join(registration, 'locked'))) detached.push(registration);
          else attention.push({ path: registration.replace(stage, ''), reason: '作業用コピーのロックを確認してください' });
        } else if (!exists(path.join(registration, 'locked'))) {
          // prune must not remove unrelated stale registrations from outside Work.
          const lock = path.join(registration, 'locked'); await fsp.writeFile(lock, 'migration: preserve registration\n', { flag: 'wx' }); protectedLocks.push(lock);
        }
      }
      try { git(repo, ['worktree', 'prune', '--expire', 'now']); }
      finally { for (const lock of protectedLocks) await fsp.unlink(lock); }
      for (const item of m.entries.filter(item => item.root === e.root)) {
        const file = path.join(stage, item.root, item.rel);
        if (!exists(file) && (file === registrations || detached.some(dir => inside(dir, file)))) pruned.add(file);
      }
    }
    await atomic(path.join(stage, 'workspace/_hub/move/path-map.json'), { format: FORMAT, maps: [...maps.map(({ from, to }) => ({ from, to })), { from: path.join(m.source.workspace, 'Work'), to: path.join(this.root, 'Work') }] });
    await atomic(path.join(stage, 'workspace/_hub/move/rewrites.json'), changes);
    await atomic(path.join(stage, 'workspace/_hub/move/import.json'), { at: new Date().toISOString(), source: m.source, bundle: this.state.bundle, attention, notIncluded: m.notIncluded || [] });
    return { attention, pruned };
  }
  validateJournal(j) {
    check(j.format === FORMAT && /^[a-f0-9-]{36}$/.test(j.id) && j.stage === path.join(this.home, 'Documents/.ProjectHub-move-' + j.id) && /^[^/\\]+\.hubmove$/.test(j.bundle) && Array.isArray(j.maps) && Array.isArray(j.ops), '復旧記録が不正です');
    for (const m of j.maps) check(/^(workspace|freetalk|ext-[1-9][0-9]*)$/.test(m.id) && portableRoot(this.home, m.to) && (m.id !== 'workspace' || m.to === this.root) && (m.id !== 'freetalk' || m.to === this.freetalk), '復旧先が不正です');
    for (const op of j.ops) {
      check(op.kind === 'local-license' ? op.from === path.join(this.root, '_hub/license') && op.to === path.join(j.stage, 'workspace/_hub/license') : j.maps.some(m => op.kind === 'install' ? op.from === path.join(j.stage, m.id) && op.to === m.to : op.kind === 'backup' && ['workspace', 'freetalk'].includes(m.id) && op.from === m.to && (op.to === m.to + '-退避-' + j.id || op.to === path.join(platform.trashDir(this.home), path.basename(m.to) + '-' + j.id))), '復旧の操作が不正です');
      safeParents(path.dirname(op.from), this.home); safeParents(path.dirname(op.to), this.home);
    }
  }
  async commit(j) {
    this.validateJournal(j);
    for (let i = 0; i < j.ops.length; i++) {
      const op = j.ops[i]; if (op.done) continue;
      if (j.intent === i && !exists(op.from) && exists(op.to)) { op.done = true; await atomic(this.journal, j); continue; }
      check(exists(op.from) && !exists(op.to), '復旧先に別のデータがあります。上書きせず止めました');
      j.intent = i; j.phase = 'committing'; await atomic(this.journal, j);
      await fsp.mkdir(path.dirname(op.to), { recursive: true, mode: 0o700 });
      await fsp.rename(op.from, op.to); await this.fault('rename-' + i);
      op.done = true; await atomic(this.journal, j);
    }
    const bundle = path.join(this.inbox, j.bundle); safeParents(bundle, this.home);
    await atomic(path.join(bundle, 'imported.json'), { at: new Date().toISOString(), paths: j.maps });
    j.phase = 'done'; await atomic(this.journal, j);
    this.state = { mode: 'imported', bundle: j.bundle, attention: j.attention, notIncluded: j.notIncluded, notice: '引っ越しが終わりました。AIは新しいMacでログインしてください' };
  }
  async recover() {
    if (!exists(this.journal)) return false;
    const j = json(this.journal); if (['done', 'rolled-back'].includes(j.phase)) return false;
    this.state = { mode: 'importing', bundle: j.bundle }; this.running = true;
    try { await this.commit(j); return true; } catch (e) { this.state = { mode: 'failed', error: e.message }; throw e; } finally { this.running = false; }
  }
  async trash({ bundle, confirm } = {}) {
    check(!(this.strictBusy ? await this.strictBusy() : this.busy()) && !this.running && confirm === true && /^[^/\\]+\.hubmove$/.test(bundle), '読み込み済みのデータを確認してください');
    const from = path.join(this.inbox, bundle);
    safeParents(from, this.home); check(regular(path.join(from, 'imported.json')), '読み込み済みのデータではありません');
    const to = path.join(platform.trashDir(this.home), bundle + '-' + randomUUID()); safeParents(path.dirname(to), this.home);
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 }); await fsp.rename(from, to);
    this.state = { mode: 'none', notice: '引っ越し用フォルダをゴミ箱へ移しました' }; return this.status();
  }
  async autoImport() {
    if (await this.recover()) return this.status();
    const names = this.discovery(); if (names.length === 1) return this.import({ bundle: names[0] });
    this.state = { mode: names.length ? 'conflict' : 'none' }; return this.status();
  }
}
async function writeSeedReceipt(root) {
  const files = [];
  async function walk(dir, pre = '') {
    for (const n of (await fsp.readdir(dir)).sort()) {
      const rel = pre + n, file = path.join(dir, n), s = await fsp.lstat(file);
      check(!s.isSymbolicLink(), '見本にリンクがあります');
      if (s.isDirectory()) await walk(file, rel + '/');
      else { check(s.isFile(), '見本に通常でないファイルがあります'); files.push({ rel, sha256: await fileHash(file) }); }
    }
  }
  await walk(root); await atomic(path.join(root, '_hub/seed-receipt.json'), { format: 'project-hub-seed-v1', files });
}
module.exports = { Move, FORMAT, CONFIRM, excluded, fileHash, atomic, inside, riskyGit, writeSeedReceipt };
