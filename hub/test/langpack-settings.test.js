'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const packs = require('../lib/langpack');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function pack(directory, text = 'Translated', id = 'zh-TW') {
  write(path.join(directory, 'pack.json'), { id, name: 'Language ' + id, verifiedWith: '4.108.0' });
  write(path.join(directory, 'ui.json'), { 'あなたの番': text });
  write(path.join(directory, 'backend.json'), { messages: { 'あなたの番': text }, labels: {} });
  return directory;
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-language-settings-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace'); fs.mkdirSync(root);
  return { temp, root, source: pack(path.join(temp, 'source')), installed: path.join(root, '_hub/langpacks/zh-TW') };
}
test('import copies only approved data, normalizes modes, and accepts the existing whole pack unchanged', t => {
  const f = fixture(t);
  write(path.join(f.source, 'test/evil.js'), 'throw Error("must never execute");');
  write(path.join(f.source, 'install.js'), 'throw Error("must never execute");');
  write(path.join(f.source, 'seed/example/PROJECT.md'), '# Example');
  write(path.join(f.source, 'seed/example/script.js'), 'throw Error("must never execute");');
  fs.chmodSync(path.join(f.source, 'ui.json'), 0o777);
  assert.equal(packs.importPack(f.root, f.source), 'zh-TW');
  assert.equal(fs.existsSync(path.join(f.installed, 'test')), false);
  assert.equal(fs.existsSync(path.join(f.installed, 'install.js')), false);
  assert.equal(fs.existsSync(path.join(f.installed, 'seed/example/script.js')), false);
  assert.equal(fs.statSync(path.join(f.installed, 'ui.json')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(f.installed, 'seed/example')).mode & 0o777, 0o755);
  const existing = path.resolve(__dirname, '../../langpacks/zh-TW');
  packs.importPack(f.root, existing);
  for (const file of ['pack.json', 'ui.json', 'backend.json', 'native.json', 'docs/README.md', 'docs/CHANGELOG.md']) {
    assert.deepEqual(fs.readFileSync(path.join(f.installed, file)), fs.readFileSync(path.join(existing, file)));
  }
});
test('invalid data, IDs, assets, links and names preserve the previous installed pack', async t => {
  const invalid = {
    missing: dir => fs.unlinkSync(path.join(dir, 'ui.json')),
    json: dir => write(path.join(dir, 'ui.json'), '{'),
    strings: dir => write(path.join(dir, 'backend.json'), { messages: { bad: 42 }, labels: {} }),
    id: dir => write(path.join(dir, 'pack.json'), { id: '../../outside', name: 'Bad', verifiedWith: '4.108.0' }),
    version: dir => write(path.join(dir, 'pack.json'), { id: 'zh-TW', name: 'Bad', verifiedWith: 'latest' }),
    symlink: dir => fs.symlinkSync(path.join(dir, 'ui.json'), path.join(dir, 'ignored.js')),
    name: dir => write(path.join(dir, 'bad..name.txt'), 'Bad'),
    native: dir => write(path.join(dir, 'native.json'), { bad: [] }),
    templates: dir => write(path.join(dir, 'templates/project/PROJECT.md'), 'Missing other required templates'),
    docs: dir => write(path.join(dir, 'docs/README.md'), 'Missing changelog'),
    html: dir => write(path.join(dir, 'ui.json'), { 'あなたの番': '<img src=x onerror="alert(1)">' }),
    incompleteHtml: dir => write(path.join(dir, 'ui.json'), { 'あなたの番': '<img src=x onerror="alert(1)"' }),
    borrowedSlot: dir => write(path.join(dir, 'ui.json'), { 'あなたの番': '${2}' }),
    composedTag: dir => write(path.join(dir, 'ui.json'), { '件数：${0}': '<${0}' }),
    internalMarker: dir => write(path.join(dir, 'ui.json'), { 'あなたの番': '\uE0002\uE001' }),
    graphemeMarkup: dir => write(path.join(dir, 'native.json'), { '原文': '<\u0338img src=x onerror=alert(1)>' }),
    nativeMarkup: dir => write(path.join(dir, 'native.json'), { 'あなたの番': '<img src=x onerror="alert(1)">' }),
    nativeComposedTag: dir => write(path.join(dir, 'native.json'), { '<p>${0}</p>': '<p><${0}</p>' }),
  };
  for (const [name, corrupt] of Object.entries(invalid)) await t.test(name, t => {
    const f = fixture(t); packs.importPack(f.root, f.source);
    const previous = fs.readFileSync(path.join(f.installed, 'ui.json'));
    corrupt(f.source); assert.throws(() => packs.importPack(f.root, f.source));
    assert.deepEqual(fs.readFileSync(path.join(f.installed, 'ui.json')), previous);
    assert.deepEqual(fs.readdirSync(path.dirname(f.installed)), ['zh-TW']);
  });
});
test('file size, total size and file count limits reject without an installed replacement', async t => {
  for (const kind of ['file', 'total', 'count']) await t.test(kind, t => {
    const f = fixture(t);
    if (kind === 'file') write(path.join(f.source, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1).toString());
    if (kind === 'total') for (let i = 0; i < 5; i++) write(path.join(f.source, i + '.txt'), Buffer.alloc(4 * 1024 * 1024 + 1).toString());
    if (kind === 'count') for (let i = 0; i < 2000; i++) write(path.join(f.source, i + '.txt'), 'x');
    assert.throws(() => packs.importPack(f.root, f.source), /容量|件数/);
    assert.equal(fs.existsSync(f.installed), false);
  });
});
test('replacement clears cache; selection and running dictionaries wait for a restart', t => {
  const f = fixture(t); packs.importPack(f.root, f.source);
  packs.selectLanguage(f.root, 'zh-TW'); packs.setRoot(f.root);
  assert.equal(packs.activePack().messages['あなたの番'], 'Translated');
  pack(f.source, 'New text'); packs.importPack(f.root, f.source);
  assert.equal(packs.loadPack({ dir: f.installed }).messages['あなたの番'], 'New text');
  assert.equal(packs.activePack().messages['あなたの番'], 'Translated');
  assert.equal(packs.packSettings(f.root, '4.108.0').restartNeeded, true);
  packs.setRoot(f.root); assert.equal(packs.activePack().messages['あなたの番'], 'New text');
  packs.selectLanguage(f.root, 'ja'); assert.equal(packs.activePack().manifest.id, 'zh-TW');
  packs.setRoot(f.root); assert.equal(packs.activePack(), null);
  assert.equal(packs.packSettings(f.root, '4.108.0').restartNeeded, false);
});
test('valid new languages are selectable; installed-only removal resets selection', t => {
  const f = fixture(t); pack(f.source, 'Bonjour', 'fr-FR'); packs.importPack(f.root, f.source);
  const row = packs.packSettings(f.root, '4.108.0').packs.find(row => row.id === 'fr-FR');
  assert.equal(row.usable, true); assert.equal(row.reason, '');
  packs.selectLanguage(f.root, 'fr-FR'); packs.setRoot(f.root);
  assert.equal(packs.activePack().manifest.id, 'fr-FR');
  assert.throws(() => packs.selectLanguage(f.root, 'unknown'));
  pack(f.source); packs.importPack(f.root, f.source); packs.selectLanguage(f.root, 'zh-TW');
  assert.throws(() => packs.importPack(f.root, f.installed), /追加元/);
  packs.removePack(f.root, 'zh-TW');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '_hub/language.json'))).language, 'ja');
  packs.setRoot(f.root); assert.equal(packs.activePack(), null);
  assert.throws(() => packs.removePack(f.root, 'zh-TW'));
  assert.throws(() => packs.removePack(f.root, '../bad'));
});
test('a symlinked managed directory cannot redirect imports', t => {
  const f = fixture(t), outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.root, '_hub')); fs.symlinkSync(outside, path.join(f.root, '_hub/langpacks'));
  assert.throws(() => packs.importPack(f.root, f.source), /保存先/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('installing a higher-priority pack requires restart even when the language ID is unchanged', t => {
  const f = fixture(t), previous = process.env.HUB_LANGPACK_DIR, language = process.env.HUB_LANG;
  process.env.HUB_LANGPACK_DIR = f.source; process.env.HUB_LANG = 'zh-TW';
  try {
    packs.setRoot(f.root); assert.equal(packs.packSettings(f.root, '4.108.0').restartNeeded, false);
    packs.importPack(f.root, f.source);
    assert.equal(packs.packSettings(f.root, '4.108.0').restartNeeded, true);
    assert.equal(packs.activePack().directory, f.source);
    packs.setRoot(f.root); assert.equal(packs.activePack().directory, f.installed);
  } finally {
    if (previous === undefined) delete process.env.HUB_LANGPACK_DIR; else process.env.HUB_LANGPACK_DIR = previous;
    if (language === undefined) delete process.env.HUB_LANG; else process.env.HUB_LANG = language;
  }
});
test('startup selection and installed/external/bundled precedence, with fallback and one warning', async t => {
  const cases = [
    { name: 'saved beats environment', saved: 'zh-TW', env: 'ja', installed: true, external: true, bundled: true, expected: 'installed' },
    { name: 'saved ja beats environment', saved: 'ja', env: 'zh-TW', external: true, expected: 'ja' },
    { name: 'environment without saved selection', env: 'zh-TW', external: true, expected: 'external' },
    { name: 'invalid installed falls back to external', saved: 'zh-TW', broken: true, external: true, bundled: true, expected: 'external' },
    { name: 'bundled last', saved: 'zh-TW', bundled: true, expected: 'bundled' },
    { name: 'missing', saved: 'zh-TW', expected: 'ja', warnings: 1 },
    { name: 'broken', saved: 'zh-TW', broken: true, expected: 'ja', warnings: 1 },
    { name: 'Japanese default', expected: 'ja' },
  ];
  for (const item of cases) await t.test(item.name, t => {
    const f = fixture(t), repo = path.join(f.temp, 'repository'), libs = path.join(repo, 'hub/lib'); fs.mkdirSync(libs, { recursive: true });
    for (const file of ['langpack.js', 'locale.js']) fs.copyFileSync(path.join(__dirname, '../lib', file), path.join(libs, file));
    fs.cpSync(path.join(__dirname, '../lib/platform'), path.join(libs, 'platform'), { recursive: true });
    if (item.saved) write(path.join(f.root, '_hub/language.json'), { language: item.saved });
    if (item.installed) pack(f.installed, 'installed');
    if (item.broken) { pack(f.installed); fs.unlinkSync(path.join(f.installed, 'ui.json')); }
    if (item.external) pack(f.source, 'external');
    if (item.bundled) pack(path.join(repo, 'langpacks/zh-TW'), 'bundled');
    const script = `const p=require(${JSON.stringify(path.join(libs, 'langpack'))});p.setRoot(${JSON.stringify(f.root)});const l=require(${JSON.stringify(path.join(libs, 'locale'))});console.log(JSON.stringify([l.locale(),l.lt('あなたの番'),l.config(),l.config()]));`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, HUB_LANG: item.env || '', HUB_LANGPACK_DIR: item.external ? f.source : '' } });
    assert.equal(result.status, 0, result.stderr); const [locale, text] = JSON.parse(result.stdout);
    assert.equal(locale, item.expected === 'ja' ? 'ja' : 'zh-TW'); assert.equal(text, item.expected === 'ja' ? 'あなたの番' : item.expected);
    assert.equal((result.stderr.match(/日本語で表示/g) || []).length, item.warnings || 0);
  });
});
test('pack loading has no code evaluation or pack-supplied module execution', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/langpack.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:eval|spawn|execFile|runInContext)\s*\(/);
  assert.deepEqual([...source.matchAll(/require\(([^)]+)\)/g)].map(match => match[1]), ["'./platform/file-io'", "'node:path'", "'node:crypto'"]);
  // The only added import is application-owned IO, never a path from a pack.
  const io = fs.readFileSync(path.join(__dirname, '../lib/platform/file-io.js'), 'utf8');
  assert.doesNotMatch(io, /\b(?:eval|spawn|execFile|runInContext)\s*\(/);
  assert.deepEqual([...io.matchAll(/require\(([^)]+)\)/g)].map(match => match[1]), ["'node:fs'", "'./index'"]);
});
test('server startup fixes saved language before translating fixed messages and AI instructions', async t => {
  const vm = require('node:vm'), server = path.resolve(__dirname, '../server.js');
  const source = fs.readFileSync(server, 'utf8'), end = source.indexOf('let conversationHistory;');
  assert.ok(end > 0);
  // Execute the real import/initialization order, stopping before runtime services.
  const bootstrap = source.slice(0, end);
  const constants = [
    ['CHATGPT_RETIRED', 'chat'], ['CONTEXT_RULE', 'launch'],
    ['SEND_TEXT_RULE', 'instructions'], ['DIFFERENCE', 'instructions'],
    ['TEMPLATES', 'instructions'], ['TEXT_RULE', 'instructions'], ['ARTIFACT_POLICY', 'artifact-policy'],
  ].map(([name, file]) => {
    const code = fs.readFileSync(path.join(__dirname, '../lib', file + '.js'), 'utf8');
    const match = code.match(new RegExp('const ' + name + ' = lt(\\([\\s\\S]*?\\)|`[\\s\\S]*?`);'));
    assert.ok(match, name); return { name, file, key: vm.runInNewContext(match[1]) };
  });
  for (const language of ['ja', 'zh-TW']) await t.test('saved ' + language + ' overrides the opposite environment', t => {
    const f = fixture(t);
    write(path.join(f.source, 'backend.json'), { messages: Object.fromEntries(constants.map(({ key, name }) => [key, 'Translated ' + name])), labels: {} });
    write(path.join(f.root, '_hub/language.json'), { language });
    const inspect = '\nconst prefix=instructions.packet({pdir:ROOT,task:"startup",policy:"policy",issues:"",common:"",contextRule:launch.CONTEXT_RULE,askRule:"",port:PORT});console.log(JSON.stringify({ language:locale(), fixed:{CHATGPT_RETIRED:chat.CHATGPT_RETIRED, CONTEXT_RULE:launch.CONTEXT_RULE, SEND_TEXT_RULE:instructions.SEND_TEXT_RULE, DIFFERENCE:instructions.DIFFERENCE, TEMPLATES:instructions.templates()}, prefix, rules:fs.readFileSync(path.join(ROOT,".ai/chat/startup.rules.md"),"utf8") }));';
    // CommonJS の関数内で実行し、正式な起動分岐の top-level return も構文として許容する。
    // Runtime functions are declared below the extracted prefix. Supply inert
    // references, and fail if initialization unexpectedly invokes any of them.
    const script = `const runtimeOnly=()=>{throw Error('language bootstrap must not invoke runtime services');};require('node:vm').runInNewContext(${JSON.stringify('(function(){\n' + bootstrap + inspect + '\n})()')}, {require:require('node:module').createRequire(${JSON.stringify(server)}), module:{exports:{}}, process, console, rolesData:runtimeOnly, integrationPolicyRequest:runtimeOnly, accountFor:runtimeOnly, permCmd:runtimeOnly, assertWorkspaceIdle:runtimeOnly, codexFastFor:runtimeOnly, modelError:runtimeOnly, record:runtimeOnly, setUnread:runtimeOnly, taskPrompt:runtimeOnly, verifyIntegrationAssignmentSend:runtimeOnly, __filename:${JSON.stringify(server)}, __dirname:${JSON.stringify(path.dirname(server))}});`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HUB_ROOT: f.root, HUB_LANG: language === 'ja' ? 'zh-TW' : 'ja', HUB_LANGPACK_DIR: f.source }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout); assert.equal(actual.language, language);
    for (const { name, key } of constants) {
      const expected = language === 'ja' ? key : 'Translated ' + name;
      if (Object.hasOwn(actual.fixed, name)) assert.equal(actual.fixed[name], expected, name);
      if (name !== 'CHATGPT_RETIRED') assert.ok(actual.rules.includes(expected), 'AI rules: ' + name);
      if (['SEND_TEXT_RULE', 'DIFFERENCE'].includes(name)) assert.ok(actual.prefix.includes(expected), 'AI prefix: ' + name);
    }
  });
});
test('a stand-alone import accepts legacy data without bundled dictionaries and uses source-owned script code', t => {
  const f = fixture(t), repo = path.join(f.temp, 'standalone'), libs = path.join(repo, 'hub/lib'); fs.mkdirSync(libs, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../lib/langpack.js'), path.join(libs, 'langpack.js'));
  fs.cpSync(path.join(__dirname, '../lib/platform'), path.join(libs, 'platform'), { recursive: true });
  const source = '<p>日本語</p><script>const text="application";</script>';
  const translated = '<p>Translated</p><script>globalThis.injected=true;</script>';
  write(path.join(f.source, 'backend.json'), { messages: { [source]: translated }, labels: {} });
  const script = `const p=require(${JSON.stringify(path.join(libs, 'langpack'))});p.importPack(${JSON.stringify(f.root)},${JSON.stringify(f.source)}); console.log(JSON.stringify(p.loadPack({dir:${JSON.stringify(f.installed)}}).backend.messages));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[source], '<p>Translated</p><script>const text="application";</script>');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.installed, 'backend.json'))).messages[source], translated);
  // The current complete pack must also be importable when no pack is bundled.
  const existing = path.resolve(__dirname, '../../langpacks/zh-TW');
  const real = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(libs, 'langpack'))}).importPack(${JSON.stringify(f.root)},${JSON.stringify(existing)});`], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
});
