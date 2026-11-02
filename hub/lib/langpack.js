'use strict';
// Optional data only: a pack never supplies executable code or module paths.
const fs = require('./platform/file-io');
const path = require('node:path');
const crypto = require('node:crypto');
const cache = new Map(), warned = new Set();
const validId = id => typeof id === 'string' && /^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/.test(id) && id !== 'ja';
const headingKeys = ['手順', 'やったこと', '次にやること', '注意', 'メモ'];
const headingNames = {
  '手順': ['手順', '步驟'], 'やったこと': ['やったこと', '已完成的工作', '已完成的事'],
  '次にやること': ['次にやること', '下一步', '接下來要做的事'],
  '注意': ['注意', '注意事項'], 'メモ': ['メモ', '備註'],
};
const reservedHeadings = Object.entries(headingNames).flatMap(([key, names]) => names.map(name => [key, name]))
  .concat(['成果', '確認結果', '残件申告', '最新の再開要約'].map(name => [name, name]));
// Readers also accept heading suffixes and substrings. A different section must
// never inherit an existing name, including a prefix/suffix of that name.
const overlaps = (left, right) => left.includes(right) || right.includes(left);
const conflicts = ([key, text], entries) => entries.some(([other, name]) => key !== other && overlaps(text, name));
function validHeadings(value) {
  return value === undefined || (dictionary(value) && Object.entries(value).every(([key, text]) =>
    headingKeys.includes(key) && text.trim() === text && text.length > 0 && !/[#\r\n\u2028\u2029]/.test(text))
    && Object.entries(value).every(entry => !conflicts(entry, [...reservedHeadings, ...Object.entries(value)])));
}
function safeHeadings(packs) {
  const entries = [...reservedHeadings, ...packs.flatMap(Object.entries)];
  // Manually added folders may conflict. Keep their dictionaries usable, but
  // suppress ambiguous names for both reading and writing, independently of order.
  return packs.map(headings => Object.fromEntries(Object.entries(headings).filter(entry => !conflicts(entry, entries))));
}
function dateLocale(manifest) {
  const value = manifest.dateLocale ?? manifest.id;
  if (typeof value !== 'string' || !Intl.DateTimeFormat.supportedLocalesOf([value]).length) throw Error('Invalid date locale');
  return Intl.getCanonicalLocales(value)[0];
}
let runtime = null;
const packDir = (root = path.resolve(__dirname, '../..'), override = process.env.HUB_LANGPACK_DIR) =>
  path.resolve(override || path.join(root, 'langpacks', validId(process.env.HUB_LANG) ? process.env.HUB_LANG : 'ja'));
const dictionary = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(text => typeof text === 'string');
function dataMessages(messages) {
  const tags = text => (text.match(/<[^>]*>/g) || []).map(tag =>
    // Literal URL/document examples such as <Macの名前> are not active markup.
    /[^\x00-\x7f]/.test(tag) && !/[\s='"/]/.test(tag) ? '<literal>'
      : tag.replace(/\b(title|aria-label|aria-valuetext|placeholder)\s*=\s*(["'])[\s\S]*?\2/g, '$1=""'));
  return Object.fromEntries(Object.entries(messages).map(([source, value]) => {
    // A placeholder is application-owned markup in some templates. A pack must
    // not invent one, or turn a fragment followed by one into a new HTML tag.
    const slots = text => (text.match(/\$\{\d+\}/g) || []).sort();
    if (/[\uE000\uE001]/.test(value) || /<\s*\/?\s*\$\{/.test(value)
      || JSON.stringify(slots(source)) !== JSON.stringify(slots(value))) throw Error('言語パックの差し込み位置が不正です');
    if (value.includes('<')) {
      if (JSON.stringify(tags(source)) !== JSON.stringify(tags(value))
        || (value.replace(/<[^>]*>/g, '').match(/</g) || []).length
          !== (source.replace(/<[^>]*>/g, '').match(/</g) || []).length) throw Error('言語パックには実行可能なHTMLを追加できません');
      // Whole-page legacy phrases retain only application-owned scripts.
      const scripts = source.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
      let index = 0;
      value = value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => scripts[index++]);
    }
    return [source, value];
  }));
}
function loadPack({ root, dir, warn = true, needs = [] } = {}) {
  const directory = packDir(root, dir);
  const cached = cache.get(directory);
  if (cached && !needs.length) return cached;
  try {
    const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const pack = cached || { directory, manifest: read('pack.json'), messages: read('ui.json'), backend: read('backend.json') };
    if (!cached && (!validId(pack.manifest.id) || !dictionary(pack.messages) || !dictionary(pack.backend.messages) || !dictionary(pack.backend.labels)
      || !validHeadings(pack.backend.headings))) throw Error('Invalid language pack');
    if (!cached) {
      pack.dateLocale = dateLocale(pack.manifest);
      pack.messages = dataMessages(pack.messages);
      pack.backend = { messages: dataMessages(pack.backend.messages), labels: dataMessages(pack.backend.labels), headings: pack.backend.headings || {} };
    }
    // Web-only packs remain valid. Each consumer checks its additional inputs.
    const readable = (file, folder = false) => {
      const location = path.join(directory, file), stat = fs.statSync(location);
      if (!(folder ? stat.isDirectory() : stat.isFile())) throw Error('Invalid language pack asset');
      fs.accessSync(location, fs.constants.R_OK);
    };
    for (const need of needs) {
      if (need === 'native') {
        const native = read('native.json');
        if (!dictionary(native) || !Object.keys(native).length) throw Error('Invalid native language pack');
        dataMessages(native);
      } else if (need === 'templates') {
        readable('templates/project', true);
        for (const file of ['_hub/roles.yaml', 'project/PROJECT.md', 'project/.ai/rules.md', 'project/.ai/tasks/_template.md']) readable('templates/' + file);
      } else if (need === 'seed') {
        readable('seed', true);
        const seeds = fs.readdirSync(path.join(directory, 'seed'), { withFileTypes: true }).filter(entry => entry.isDirectory());
        if (!seeds.length) throw Error('Empty language pack seed');
        for (const seed of seeds) readable(path.join('seed', seed.name, 'PROJECT.md'));
      } else if (need === 'docs') {
        readable('docs/README.md'); readable('docs/CHANGELOG.md');
      } else throw Error('Unknown language pack input');
    }
    cache.set(directory, pack);
    return pack;
  } catch {
    // Do not cache absence: a pack may be installed before the next restart.
    if (warn && !warned.has(directory)) {
      warned.add(directory);
      console.warn('言語パックを読み込めないため、日本語で動作します。');
    }
    return null;
  }
}
function clearCache(dir) { cache.delete(path.resolve(dir)); }
function savedLanguage(root) {
  try {
    const file = path.join(root, '_hub/language.json');
    if (fs.statSync(file).size > 10000) return 'ja';
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).language;
    return value === 'ja' || validId(value) ? value : 'ja';
  } catch (error) { return error.code === 'ENOENT' ? null : 'ja'; }
}
function candidates(root, id, repo = path.resolve(__dirname, '../..')) {
  return [
    { directory: path.join(root, '_hub/langpacks', id), source: 'installed' },
    ...(process.env.HUB_LANGPACK_DIR ? [{ directory: path.resolve(process.env.HUB_LANGPACK_DIR), source: 'external' }] : []),
    { directory: path.join(repo, 'langpacks', id), source: 'bundled' },
  ];
}
function findPack(root, id, repo) {
  if (!validId(id)) return null;
  for (const candidate of candidates(root, id, repo)) {
    const pack = loadPack({ dir: candidate.directory, warn: false });
    if (pack?.manifest.id === id) return pack;
  }
  return null;
}
function setRoot(root) {
  const requested = savedLanguage(root) ?? (process.env.HUB_LANG || 'ja');
  const pack = requested === 'ja' ? null : findPack(root, requested);
  runtime = { root, requested, pack, dirty: false };
  runtime.headings = safeHeadings(discoverPacks(root).filter(row => row.pack && row.pack.manifest.id === row.id)
    .map(row => ({ ...row.pack.backend.headings })));
  if (requested !== 'ja' && !pack) {
    const key = 'selection:' + root;
    if (!warned.has(key)) { warned.add(key); console.warn('選んだ言語パックが読めないため、日本語で表示しています。'); }
  }
}
function activePack(needs = []) {
  if (!runtime) {
    const id = process.env.HUB_LANG;
    if (!validId(id)) return null;
    const pack = loadPack({ needs });
    return pack?.manifest.id === id ? pack : null;
  }
  // Keep the running dictionaries fixed, even when an installed pack is replaced.
  if (!runtime.pack) return null;
  if (needs.length && !loadPack({ dir: runtime.pack.directory, needs })) return null;
  return runtime.pack;
}
function ensureDirectory(directory) {
  try { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('保存先のフォルダが不正です'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(directory, { mode: 0o755 }); fs.chmodSync(directory, 0o755); }
}
function managedDirectory(root) {
  ensureDirectory(path.join(root, '_hub'));
  const directory = path.join(root, '_hub/langpacks'); ensureDirectory(directory); return directory;
}
function saveLanguage(root, language) {
  ensureDirectory(path.join(root, '_hub'));
  const file = path.join(root, '_hub/language.json'), temp = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify({ language, savedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o644 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
const rootFiles = new Set(['pack.json', 'ui.json', 'backend.json', 'native.json', 'README.md']);
const assetDirs = new Set(['docs', 'templates', 'seed']);
function importPack(root, directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('言語パックのフォルダを絶対パスで選んでください');
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('言語パックのフォルダが不正です');
  const source = fs.realpathSync(directory), managed = managedDirectory(root);
  const relative = path.relative(fs.realpathSync(managed), source);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('導入済みの言語パックは追加元にできません');
  const stage = path.join(managed, '.tmp-' + crypto.randomUUID());
  fs.mkdirSync(stage, { mode: 0o755 }); fs.chmodSync(stage, 0o755);
  let count = 0, entries = 0, bytes = 0;
  try {
    const walk = (folder, parts = []) => {
      if (parts.length > 40) throw Error('言語パックのフォルダが深すぎます');
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (++entries > 5000 || entry.name.includes('..')) throw Error('言語パックのファイル名または件数が不正です');
        const file = path.join(folder, entry.name), next = [...parts, entry.name], stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw Error('言語パックにはシンボリックリンクを使えません');
        if (stat.isDirectory()) { walk(file, next); continue; }
        if (!stat.isFile()) throw Error('言語パックには通常のファイルだけを使えます');
        if (++count > 2000 || stat.size > 5 * 1024 * 1024 || (bytes += stat.size) > 20 * 1024 * 1024) throw Error('言語パックの容量または件数が大きすぎます');
        const allowed = next.length === 1 ? rootFiles.has(entry.name)
          : assetDirs.has(next[0]) && /(?:\.(?:json|md|yaml|yml|txt)|^\.gitkeep)$/.test(entry.name);
        if (!allowed) continue;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let data;
        try {
          const before = fs.fstatSync(fd);
          if (!before.isFile() || before.size !== stat.size || before.ino !== stat.ino) throw Error('言語パックが確認中に変わりました');
          const buffer = Buffer.alloc(before.size + 1);
          const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
          data = buffer.subarray(0, length); const after = fs.fstatSync(fd);
          if (data.length !== before.size || after.mtimeMs !== before.mtimeMs) throw Error('言語パックが確認中に変わりました');
        } finally { fs.closeSync(fd); }
        const dest = path.join(stage, ...next);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
        for (let parent = path.dirname(dest); parent !== stage; parent = path.dirname(parent)) fs.chmodSync(parent, 0o755);
        fs.writeFileSync(dest, data, { flag: 'wx', mode: 0o644 }); fs.chmodSync(dest, 0o644);
      }
    };
    walk(source);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'pack.json'), 'utf8'));
    if (!validId(manifest.id) || typeof manifest.name !== 'string' || !manifest.name.trim() || [...manifest.name].length > 50
      || typeof manifest.verifiedWith !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.verifiedWith)) throw Error('言語パックの名前・識別子・版が不正です');
    const needs = ['native', 'templates', 'seed', 'docs'].filter(need => fs.existsSync(path.join(stage, need === 'native' ? 'native.json' : need)));
    const pack = loadPack({ dir: stage, needs, warn: false });
    if (!pack) throw Error('言語パックのデータが欠けているか、形式が不正です');
    const others = discoverPacks(root).filter(row => row.pack && row.pack.manifest.id === row.id && row.id !== manifest.id)
      .flatMap(row => Object.entries(row.pack.backend.headings));
    if (Object.entries(pack.backend.headings).some(entry => conflicts(entry, others))) throw Error('言語パックの見出しが別の言語の項目と重なっています');
    const dest = path.join(managed, manifest.id), backup = path.join(managed, '.old-' + crypto.randomUUID());
    const previous = fs.existsSync(dest);
    if (previous) { ensureDirectory(dest); fs.renameSync(dest, backup); }
    try { fs.renameSync(stage, dest); }
    catch (error) { if (previous) fs.renameSync(backup, dest); throw error; }
    if (runtime?.pack?.directory === dest) runtime.dirty = true;
    clearCache(dest);
    if (previous) fs.rmSync(backup, { recursive: true, force: true });
    return manifest.id;
  } finally { clearCache(stage); fs.rmSync(stage, { recursive: true, force: true }); }
}
function removePack(root, id) {
  if (!validId(id)) throw Error('言語パックの指定が不正です');
  const directory = path.join(managedDirectory(root), id);
  ensureExistingDirectory(directory);
  if ((savedLanguage(root) ?? runtime?.requested ?? process.env.HUB_LANG) === id) saveLanguage(root, 'ja');
  fs.rmSync(directory, { recursive: true }); clearCache(directory);
}
function ensureExistingDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('導入済みの言語パックが不正です');
}
function discoverPacks(root, repo = path.resolve(__dirname, '../..')) {
  const rows = directory => { try { return fs.readdirSync(directory).filter(validId); } catch { return []; } };
  const installed = path.join(root, '_hub/langpacks'), bundled = path.join(repo, 'langpacks');
  return [...rows(installed).map(id => ({ directory: path.join(installed, id), id, source: 'installed' })),
    ...(process.env.HUB_LANGPACK_DIR ? [{ directory: path.resolve(process.env.HUB_LANGPACK_DIR), source: 'external' }] : []),
    ...rows(bundled).map(id => ({ directory: path.join(bundled, id), id, source: 'bundled' }))]
    .map(row => { const pack = loadPack({ dir: row.directory, warn: false }); return { ...row, id: row.id || pack?.manifest.id, pack }; });
}
let standaloneHeadings;
function packHeadings() {
  if (runtime) return runtime.headings;
  return standaloneHeadings ||= safeHeadings(discoverPacks(process.env.HUB_ROOT || path.resolve(__dirname, '../..'))
    .filter(row => row.pack && row.pack.manifest.id === row.id).map(row => ({ ...row.pack.backend.headings })));
}
function packSettings(root, version) {
  const list = [], seen = new Set();
  for (const candidate of discoverPacks(root)) {
    const { pack, id } = candidate;
    if (!validId(id)) continue;
    // Show an invalid installed pack too; a usable fallback can still be selected.
    const usable = Boolean(pack && pack.manifest.id === id);
    const assets = Object.fromEntries(['native', 'templates', 'seed', 'docs'].map(need => [need, Boolean(pack && loadPack({ dir: candidate.directory, needs: [need], warn: false }))]));
    list.push({ id, name: pack?.manifest.name || id, source: candidate.source, verifiedWith: pack?.manifest.verifiedWith || '', usable,
      reason: !pack ? '言語パックが読めません' : !usable ? '言語パックの識別子が一致しません' : '', assets });
    if (usable) seen.add(id);
  }
  const saved = savedLanguage(root), selected = saved ?? (process.env.HUB_LANG || 'ja'), active = runtime?.pack?.manifest.id || 'ja';
  const wanted = selected !== 'ja' && seen.has(selected) ? selected : 'ja';
  const nextPack = wanted === 'ja' ? null : findPack(root, wanted);
  return { active, saved: selected, packs: list, available: [...seen], version,
    fallback: selected !== 'ja' && !seen.has(selected), restartNeeded: wanted !== active || Boolean(runtime?.dirty)
      || Boolean(nextPack && runtime?.pack && nextPack.directory !== runtime.pack.directory) };
}
function selectLanguage(root, language) {
  if (language !== 'ja' && (!validId(language) || !findPack(root, language))) throw Error('この言語パックは選べません');
  saveLanguage(root, language);
}
module.exports = { packDir, loadPack, setRoot, activePack, clearCache, importPack, removePack, selectLanguage, packSettings, packHeadings, headingNames, validId };
