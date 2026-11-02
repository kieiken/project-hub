'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '..');
function distributionHub(f) {
  if (f.distributionHub) return f.distributionHub;
  const repository = path.join(f.root, 'distribution'), copy = path.join(repository, 'hub');
  const marker = path.join(hub, 'lib/license/owner-edition.js');
  // Build a disposable distribution input. Never remove the private marker in
  // the working copy or bypass the production builder's rejection of it.
  for (const item of ['app', 'lib', 'public', 'node_modules', 'server.js', 'mcp.js',
    'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'seed', 'setup.sh', 'start.command']) {
    fs.cpSync(path.join(hub, item), path.join(copy, item), {
      recursive: true, filter: source => source !== marker,
    });
  }
  fs.cpSync(path.resolve(hub, '../docs/project-hub/templates'), path.join(repository, 'docs/project-hub/templates'), { recursive: true });
  for (const item of ['README.md', 'README.zh-TW.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-TW.md']) {
    fs.copyFileSync(path.resolve(hub, '..', item), path.join(repository, item));
  }
  assert.equal(fs.existsSync(path.join(copy, 'lib/license/owner-edition.js')), false);
  assert.deepEqual(fs.readFileSync(path.join(copy, 'app/build-app.sh')), fs.readFileSync(path.join(hub, 'app/build-app.sh')));
  f.distributionHub = copy;
  return copy;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-langpack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, 'optional pack'); fs.mkdirSync(pack);
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ id: 'zh-TW', verifiedWith: '0.0.1' }));
  fs.writeFileSync(path.join(pack, 'ui.json'), JSON.stringify({ '見つかりません：${0}': 'Missing: ${0}', 'あなたの番': 'Your turn' }));
  fs.writeFileSync(path.join(pack, 'backend.json'), JSON.stringify({ messages: { '見つかりません：${0}': 'Missing: ${0}' }, labels: { '完了': 'Done' } }));
  const run = (code, dir = pack, language = 'zh-TW') => spawnSync(process.execPath, ['-e', code], {
    cwd: hub, env: { ...process.env, HUB_LANG: language, HUB_LANGPACK_DIR: dir }, encoding: 'utf8', timeout: 10000,
  });
  return { root, pack, run };
}
const read = "const l=require('./lib/locale');console.log(JSON.stringify({locale:l.locale(),config:l.config(),text:l.lt`見つかりません：${'利用者原文 ${0}'}`,missing:l.lt('訳のない文'),label:l.label('完了')}));";
test('An external data pack overrides the location, tolerates version differences and preserves opaque values', t => {
  const f = fixture(t), result = f.run(read); assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout); assert.equal(data.locale, 'zh-TW'); assert.equal(data.text, 'Missing: 利用者原文 ${0}');
  assert.equal(data.missing, '訳のない文'); assert.equal(data.label, 'Done');
  const inherited = f.run("const l=require('./lib/locale');console.log(JSON.stringify([l.lt('toString'),l.label('constructor')]));");
  assert.deepEqual(JSON.parse(inherited.stdout), ['toString', 'constructor']);
});
test('No pack falls back to Japanese with one diagnostic, even across repeated lookups', t => {
  const f = fixture(t), result = f.run(read, path.join(f.root, 'absent')); assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout); assert.equal(data.locale, 'ja'); assert.equal(data.text, '見つかりません：利用者原文 ${0}');
  assert.equal(data.label, '完了'); assert.deepEqual(data.config.messages, {});
  assert.equal(result.stderr.trim().split('\n').length, 1); assert.match(result.stderr, /日本語で動作/);
});
test('Japanese startup does not read an optional pack or emit missing-pack warnings', t => {
  const f = fixture(t), result = f.run(read, path.join(f.root, 'absent'), 'ja'); assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).locale, 'ja'); assert.equal(result.stderr, '');
});
test('Malformed or executable-looking pack data is refused without evaluating it', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.pack, 'ui.json'), '{"bad":{"code":"process.exit(9)"}}');
  const result = f.run(read); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).locale, 'ja');
});
test('The generic browser engine translates supplied data and keeps stored attributes and interpolations unchanged', () => {
  const context = vm.createContext({ HUB_LOCALE: { locale: 'zh-TW', messages: { 'あなたの番': 'Your turn', '質問：${0}': 'Question: ${0}' } } });
  vm.runInContext(fs.readFileSync(path.join(hub, 'public/locale.js'), 'utf8'), context);
  const ui = context.HubI18n;
  assert.equal(ui.text('あなたの番'), 'Your turn'); assert.equal(ui.text('訳のない文'), '訳のない文');
  assert.equal(ui.template`質問：${'あなたの番 ${0}'}`, 'Question: あなたの番 ${0}');
  assert.equal(ui.html('<button data-state="完了" value="完了">あなたの番</button>'), '<button data-state="完了" value="完了">Your turn</button>');
});
test('Language text cannot become an attribute or borrow opaque HTML from a different template slot', () => {
  const context = vm.createContext({ HUB_LOCALE: { locale: 'zh-TW', messages: {
    'あなたの番': '" onmouseover="bad()" x="', '件数：${0}': '<${0}', '通知': '${2}',
    '通常：${0}': 'Normal: ${0}', '保存': 'Save & close',
    'disabled title="${0}"': 'disabled onmouseover="bad()" title="${0}"',
    'value="${0}" ': 'value="${0}" onfocus="bad()" ',
  } } });
  vm.runInContext(fs.readFileSync(path.join(hub, 'public/locale.js'), 'utf8'), context);
  const ui = context.HubI18n;
  assert.equal(ui.html('<button title="あなたの番">保存</button>'), '<button title="&quot; onmouseover=&quot;bad()&quot; x=&quot;">Save &amp; close</button>');
  assert.equal(ui.template`<button title="${ui.text('あなたの番')}">保存</button>`, '<button title="&quot; onmouseover=&quot;bad()&quot; x=&quot;">Save &amp; close</button>');
  assert.equal(ui.template`<b>通知</b>${'<i>trusted</i>'}`, '<b>通知</b><i>trusted</i>');
  assert.equal(ui.template`件数：${'img src=x onerror=bad()>'}`, '件数：img src=x onerror=bad()>');
  assert.equal(ui.template`<p>通常：${'opaque \uE0000\uE001 &lt;text&gt;'}</p>`, '<p>Normal: opaque \uE0000\uE001 &lt;text&gt;</p>');
  assert.equal(ui.template`disabled title="${ui.text('あなたの番')}"`, 'disabled title="&quot; onmouseover=&quot;bad()&quot; x=&quot;"');
  assert.equal(ui.template`value="${'model'}" `, 'value="model" ');
});
test('Native HTML rejects composed tags and escapes interpolated logs while plain alerts retain original text', t => {
  const f = fixture(t), source = fs.readFileSync(path.join(hub, 'app/window.swift'), 'utf8');
  const globals = source.slice(source.indexOf('let home ='), source.indexOf('\nlet port ='));
  const harness = 'import Foundation\n' + globals + '\n' + String.raw`
    assert(!validPackMessages(["<p>$PLACEHOLDER{0}</p>": "<p><$PLACEHOLDER{0}</p>"]))
    assert(!validPackMessages(["あなたの番": "<img src=x onerror=bad()>"]))
    assert(!validPackMessages(["あなたの番": "$PLACEHOLDER{1}"]))
    assert(validPackMessages(["<p>$PLACEHOLDER{0}</p>": "<p>$PLACEHOLDER{0}</p>"]))
    let input = "<img src=x onerror=bad()> & \"quoted\""
    print(tr("<p>$PLACEHOLDER{0}</p>", input))
    assert(tr("場所：$PLACEHOLDER{0}", input) == "場所：" + input)
  `.replaceAll('$PLACEHOLDER{', '${');
  const file = path.join(f.root, 'native-escaping.swift'); fs.writeFileSync(file, harness);
  const result = spawnSync('swift', [file], { env: { ...process.env, HUB_ROOT: f.root, HUB_LANG: 'ja' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '<p>&lt;img src=x onerror=bad()&gt; &amp; &quot;quoted&quot;</p>');
});
test('Without a pack, Chinese heading compatibility still reads existing steps and sections', t => {
  const f = fixture(t), result = f.run("const l=require('./lib/locale'),s=require('./lib/store');console.log(JSON.stringify({steps:s.readSteps('## 步驟\\n- [x] 原文\\n'),names:l.sectionNames('やったこと'),heading:l.sectionName('手順')}));", path.join(f.root, 'absent'));
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.equal(data.steps[0].done, true); assert.equal(data.steps[0].text, '原文'); assert.ok(data.names.includes('已完成的事')); assert.equal(data.heading, '手順');
});
test('Japanese setup and mocked portable builds work with a missing pack even when zh-TW was requested', t => {
  const f = fixture(t), bin = path.join(f.root, 'bin'), home = path.join(f.root, 'home'), apps = path.join(f.root, 'apps');
  for (const dir of [bin, home, apps]) fs.mkdirSync(dir);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const fake = (name, text) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + text, { mode: 0o755 });
  fake('swiftc', 'while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; echo executable > "$1"; exit 0; fi; shift; done\n');
  for (const name of ['codesign', 'sips', 'iconutil']) fake(name, 'exit 0\n');
  const env = { ...process.env, HOME: home, PATH: bin + ':/usr/bin:/bin', HUB_ROOT: path.join(f.root, 'workspace'), HUB_LANG: 'zh-TW', HUB_LANGPACK_DIR: path.join(f.root, 'absent'), HUB_SKIP_NPM: '1', HUB_SKIP_APP: '1', HUB_STORAGE_GUARD: '', HUB_APP_DIR: apps, HUB_NO_DESKTOP_LINK: '1', HUB_BUNDLE_RUNTIME: '1' };
  for (const file of ['setup.sh', 'app/build-app.sh']) {
    const result = spawnSync('/bin/bash', [path.join(distributionHub(f), file)], { env, encoding: 'utf8', timeout: 20000 }); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.ok(fs.existsSync(path.join(env.HUB_ROOT, 'Product', 'サンプルアプリ', 'PROJECT.md')));
  const app = path.join(apps, 'Project Hub.app'), plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>HubLanguage<\/key><string>ja<\/string>/);
  assert.equal(fs.existsSync(path.join(app, 'Contents/Resources/runtime/langpacks')), false);
});
test('Japanese setup of an existing workspace does not invoke Node just to inspect an optional pack', t => {
  const f = fixture(t), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nexit 77\n', { mode: 0o755 });
  const root = path.join(f.root, 'japanese workspace');
  // 新規作成時の移行用受領証はNodeで生成する。ここでは既存台帳の任意パック検査だけを確認。
  fs.mkdirSync(root);
  const result = spawnSync('/bin/bash', [path.join(hub, 'setup.sh')], {
    env: { ...process.env, PATH: bin + ':/usr/bin:/bin', HUB_ROOT: root, HUB_LANG: 'ja', HUB_LANGPACK_DIR: path.join(f.root, 'absent'), HUB_SKIP_NPM: '1', HUB_SKIP_APP: '1', HUB_STORAGE_GUARD: '' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, 'Product', 'サンプルアプリ', 'PROJECT.md')));
});

function mockedBuild(f) {
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const fake = (name, text) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + text, { mode: 0o755 });
  fake('swiftc', 'while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; echo executable > "$1"; exit 0; fi; shift; done\n');
  for (const name of ['codesign', 'sips', 'iconutil']) fake(name, 'exit 0\n');
  const env = { ...process.env, HOME: path.join(f.root, 'home'), PATH: bin + ':/usr/bin:/bin', HUB_ROOT: path.join(f.root, 'workspace'),
    HUB_LANG: 'zh-TW', HUB_LANGPACK_DIR: f.pack, HUB_SKIP_NPM: '1', HUB_SKIP_APP: '1', HUB_STORAGE_GUARD: '',
    HUB_APP_DIR: path.join(f.root, 'apps'), HUB_NO_DESKTOP_LINK: '1' };
  return (file, extra = {}) => spawnSync('/bin/bash', [path.join(distributionHub(f), file)], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
}
test('Japanese portable distribution builds preserve the private source and exclude its owner marker', t => {
  const marker = path.join(hub, 'lib/license/owner-edition.js');
  const owner = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
  const f = fixture(t), run = mockedBuild(f);
  const result = run('app/build-app.sh', { HUB_LANG: 'ja', HUB_BUNDLE_RUNTIME: '1', HUB_LANGPACK_DIR: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const app = path.join(f.root, 'apps/Project Hub.app');
  const runtime = path.join(app, 'Contents/Resources/runtime/hub');
  assert.equal(fs.existsSync(path.join(runtime, 'lib/license/owner-edition.js')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'lib/license/mac-native')), true);
  assert.equal(fs.existsSync(path.join(app, 'Contents/Resources/runtime/langpacks')), false);
  assert.match(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'), /<key>HubLanguage<\/key><string>ja<\/string>/);
  assert.deepEqual(fs.readFileSync(path.join(runtime, 'lib/license/index.js')), fs.readFileSync(path.join(hub, 'lib/license/index.js')));
  assert.deepEqual(fs.existsSync(marker) ? fs.readFileSync(marker) : null, owner);
});
function completeAssets(f) {
  const original = path.resolve(hub, '../langpacks/zh-TW');
  for (const name of ['native.json', 'templates', 'seed', 'docs']) fs.cpSync(path.join(original, name), path.join(f.pack, name), { recursive: true });
}
function assertJapaneseBuild(f, result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /日本語で動作/);
  const app = path.join(f.root, 'apps/Project Hub.app');
  assert.match(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'), /<key>HubLanguage<\/key><string>ja<\/string>/);
  assert.equal(fs.existsSync(path.join(app, 'Contents/Resources/runtime/langpacks')), false);
}
test('A web-only external pack falls back for setup and App builds without losing Web translation', t => {
  const f = fixture(t), run = mockedBuild(f);
  const setup = run('setup.sh'); assert.equal(setup.status, 0, setup.stderr); assert.match(setup.stderr, /日本語で動作/);
  assert.ok(fs.existsSync(path.join(f.root, 'workspace/Product/サンプルアプリ/PROJECT.md')));
  assertJapaneseBuild(f, run('app/build-app.sh'));
  const web = f.run(read); assert.equal(JSON.parse(web.stdout).locale, 'zh-TW');
});
test('Malformed native strings fall back to Japanese App builds', t => {
  const f = fixture(t), run = mockedBuild(f); completeAssets(f);
  for (const data of ['{bad JSON', '{"label":{"code":"exit"}}', '[]', '{}']) {
    fs.writeFileSync(path.join(f.pack, 'native.json'), data);
    assertJapaneseBuild(f, run('app/build-app.sh'));
  }
});
test('Missing template, seed or documentation inputs fall back during portable builds', t => {
  const f = fixture(t), run = mockedBuild(f);
  for (const missing of ['templates/_hub/roles.yaml', 'templates/project/.ai/rules.md', 'seed/Project Hub/PROJECT.md', 'docs/README.md']) {
    completeAssets(f); fs.rmSync(path.join(f.pack, missing));
    assertJapaneseBuild(f, run('app/build-app.sh', { HUB_BUNDLE_RUNTIME: '1' }));
    if (!missing.startsWith('docs/')) {
      const workspace = path.join(f.root, 'workspace-' + missing.replaceAll('/', '-'));
      const result = run('setup.sh', { HUB_ROOT: workspace }); assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(workspace, 'Product/サンプルアプリ/PROJECT.md')));
    }
  }
});
test('Project creation selects Japanese templates when an external pack has incomplete templates', t => {
  const f = fixture(t);
  const select = `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const {activePack}=require('./lib/locale');
    let selected;
    const route=require('./lib/routes/project')({
      fs,path,activePack,__dirname:process.cwd(),expandHome:value=>value,record:()=>{},
      store:{createProject:(data,template)=>{selected=template;return {project:{id:'test-project'}};}},
      send:(res,status)=>assert.equal(status,200),
    }).create;
    const req={method:'POST'},url={pathname:'/api/project/new'};
    assert.equal(route.matches(req,url),true);
    route.handle(req,{},url,{});
    console.log(selected);
  `;
  const absent = f.run(select); assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout.trim(), path.resolve(hub, '../docs/project-hub/templates/project'));
  completeAssets(f);
  const present = f.run(select); assert.equal(present.status, 0, present.stderr);
  assert.equal(present.stdout.trim(), path.join(f.pack, 'templates/project'));
});
test('Native startup guard failure displays Japanese without reading a pack; success still translates', t => {
  const swift = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (swift.status !== 0) { t.skip('Swift is unavailable'); return; }
  const f = fixture(t); fs.writeFileSync(path.join(f.pack, 'native.json'), JSON.stringify({ 'データ用ディスクを使えません': 'Native translated' }));
  const source = fs.readFileSync(path.join(hub, 'app/window.swift'), 'utf8');
  const globals = source.slice(source.indexOf('let home ='), source.indexOf('\nlet port =')).replaceAll('Data(contentsOf:', 'trackedData(contentsOf:');
  const startupBody = (name, endMarker) => {
    const start = source.indexOf('func ' + name), body = source.indexOf('{', start) + 1, end = source.indexOf(endMarker, body);
    assert.ok(start >= 0 && end > body); return source.slice(body, end);
  };
  const harness = 'import Foundation\nvar packReads = 0\nfunc trackedData(contentsOf url: URL) throws -> Data { packReads += 1; return try Data(contentsOf: url) }\n'
    + globals + '\nclass NSAlert { var messageText=""; var informativeText=""; func runModal() { print(messageText) } }\n'
    + 'class FakeApp { func terminate(_ sender: Any?) {} }; let NSApp=FakeApp()\nfunc showError(_ title: String,_ body: String) { print(title) }\n'
    + 'func startup() { ' + startupBody('applicationDidFinishLaunching', '        if requestedLanguage') + '\nprint(tr("データ用ディスクを使えません")) }\n'
    + 'func startAndLoad() { ' + startupBody('startAndLoad', '        if (try? packagedRecovery.read()') + '\nprint(tr("データ用ディスクを使えません")) }\n'
    + 'startup(); startAndLoad(); print("PACK_READS",packReads)\n';
  const file = path.join(f.root, 'native-guard.swift'); fs.writeFileSync(file, harness);
  for (const [guard, reads, text] of [['/usr/bin/false', 0, 'データ用ディスクを使えません'], ['/usr/bin/true', 4, 'Native translated']]) {
    const result = spawnSync('swift', [file], { env: { ...process.env, HUB_ROOT: f.root, HUB_LANG: 'zh-TW', HUB_LANGPACK_DIR: f.pack, HUB_STORAGE_GUARD: guard }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp('PACK_READS ' + reads));
    assert.ok(result.stdout.includes(text));
  }
  const installed = path.join(f.root, '_hub/langpacks/zh-TW'); fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.cpSync(f.pack, installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'native.json'), JSON.stringify({ 'データ用ディスクを使えません': 'Installed translated' }));
  fs.writeFileSync(path.join(f.root, '_hub/language.json'), JSON.stringify({ language: 'zh-TW' }));
  for (const [guard, reads, text] of [['/usr/bin/false', 0, 'データ用ディスクを使えません'], ['/usr/bin/true', 5, 'Installed translated']]) {
    const result = spawnSync('swift', [file], { env: { ...process.env, HUB_ROOT: f.root, HUB_LANG: 'ja', HUB_LANGPACK_DIR: f.pack, HUB_STORAGE_GUARD: guard }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp('PACK_READS ' + reads)); assert.ok(result.stdout.includes(text));
  }
  fs.writeFileSync(path.join(f.root, '_hub/language.json'), JSON.stringify({ language: 'zh-TW', extra: 'x'.repeat(10000) }));
  const oversized = spawnSync('swift', [file], { env: { ...process.env, HUB_ROOT: f.root, HUB_LANG: 'zh-TW', HUB_LANGPACK_DIR: f.pack, HUB_STORAGE_GUARD: '/usr/bin/true' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(oversized.status, 0, oversized.stderr); assert.match(oversized.stdout, /PACK_READS 0/); assert.ok(oversized.stdout.includes('データ用ディスクを使えません'));
});
test('Native and Node select the same pack after rejecting invalid core dictionaries', async t => {
  if (spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('Swift is unavailable'); return; }
  const f = fixture(t), repo = path.join(f.root, 'repository'), libs = path.join(repo, 'hub/lib');
  fs.mkdirSync(libs, { recursive: true });
  for (const file of ['langpack.js', 'locale.js']) fs.copyFileSync(path.join(hub, 'lib', file), path.join(libs, file));
  fs.cpSync(path.join(hub, 'lib/platform'), path.join(libs, 'platform'), { recursive: true });
  const source = fs.readFileSync(path.join(hub, 'app/window.swift'), 'utf8');
  // Isolate only the default installation path; the consumer functions are unchanged.
  const globals = source.slice(source.indexOf('let home ='), source.indexOf('\nlet port ='))
    .replace(/^let hubLocation = .*$/m, 'let hubLocation = ' + JSON.stringify(path.join(repo, 'hub')));
  const file = path.join(f.root, 'native-selection.swift'), executable = path.join(f.root, 'native-selection');
  fs.writeFileSync(file, 'import Foundation\n' + globals + '\nif storageReady() { loadNativeMessages() }; print(String(data:try! JSONSerialization.data(withJSONObject:["language":hubLanguage,"directory":hubPackDir,"native":nativeMessages]),encoding:.utf8)!)\n');
  const built = spawnSync('swiftc', [file, '-o', executable], { encoding: 'utf8', timeout: 30000 });
  assert.equal(built.status, 0, built.stderr);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const make = (dir, name, id = 'zh-TW') => {
    write(path.join(dir, 'pack.json'), { id, name, verifiedWith: '4.108.0' });
    write(path.join(dir, 'ui.json'), { 'あなたの番': name });
    write(path.join(dir, 'backend.json'), { messages: { 'あなたの番': name }, labels: {} });
    write(path.join(dir, 'native.json'), { 'あなたの番': name });
  };
  const badUi = dir => write(path.join(dir, 'ui.json'), { 'あなたの番': '<img src=x onerror="alert(1)">' });
  const cases = [
    { name: 'new UI markup', corrupt: badUi, expected: 'external' },
    { name: 'new UI attributes', corrupt: dir => write(path.join(dir, 'ui.json'), { '<b>原文</b>': '<b onclick="alert(1)">Translated</b>' }), expected: 'external' },
    { name: 'immutable attributes with different Unicode encoding', corrupt: dir => write(path.join(dir, 'ui.json'), { '<a href="/caf\u00e9">原文</a>': '<a href="/cafe\u0301">Translated</a>' }), expected: 'external' },
    { name: 'unfinished UI markup', corrupt: dir => write(path.join(dir, 'ui.json'), { '原文': 'Translated <img src=x' }), expected: 'external' },
    { name: 'combining mark after opening bracket', corrupt: dir => write(path.join(dir, 'ui.json'), { '原文': '<\u0338img src=x onerror=alert(1)>' }), expected: 'external' },
    { name: 'combining mark after unfinished bracket', corrupt: dir => write(path.join(dir, 'ui.json'), { '原文': '<\u0338img src=x' }), expected: 'external' },
    { name: 'combining mark after internal marker', corrupt: dir => write(path.join(dir, 'ui.json'), { '原文': '\uE000\u0338' }), expected: 'external' },
    { name: 'backend markup', corrupt: dir => write(path.join(dir, 'backend.json'), { messages: { '原文': '<script>alert(1)</script>' }, labels: {} }), expected: 'external' },
    { name: 'label markup', corrupt: dir => write(path.join(dir, 'backend.json'), { messages: {}, labels: { '完了': '<img src=x>' } }), expected: 'external' },
    { name: 'two invalid candidates', corrupt: badUi, badExternal: true, expected: 'bundled' },
    { name: 'all invalid candidates', corrupt: badUi, badExternal: true, badBundled: true, expected: 'ja' },
    { name: 'existing complete pack', complete: true, expected: 'installed' },
    { name: 'English with date and headings', id: 'en', corrupt: dir => {
      write(path.join(dir,'pack.json'), {id:'en',dateLocale:'en-US'});
      write(path.join(dir,'backend.json'), {messages:{'あなたの番':'Your turn'},labels:{},headings:{'手順':'Steps'}});
    }, expected:'installed' },
    ...['en_US', 'zz-ZZ', 'en-abcde-abcde', 42].map(dateLocale => ({name:'invalid date '+dateLocale,id:'en',corrupt:dir=>write(path.join(dir,'pack.json'),{id:'en',dateLocale}),expected:'external'})),
    ...[{unknown:'Bad'},{'手順':'# Steps'},{'手順':'Steps\nMore'},{'手順':'Same','メモ':'Same'}].map((headings,i)=>({name:'invalid headings '+i,id:'en',corrupt:dir=>write(path.join(dir,'backend.json'),{messages:{},labels:{},headings}),expected:'external'})),
    { name: 'Web-only small pack', webOnly: true, expected: 'installed' },
    { name: 'allowed literal and translated presentation attributes', corrupt: dir => write(path.join(dir, 'ui.json'), { '<Macの名前>': '<Mac名稱>', '<input title="原文" placeholder="入力">': '<input title="Translated" placeholder="Input">' }), expected: 'installed' },
  ];
  for (const item of cases) await t.test(item.name, t => {
    const id = item.id || 'zh-TW', workspace = path.join(f.root, item.name), directories = {
      installed: path.join(workspace, '_hub/langpacks',id), external: path.join(workspace, 'external'), bundled: path.join(repo, 'langpacks',id),
    };
    for (const [name, dir] of Object.entries(directories)) make(dir, name, id);
    write(path.join(workspace, '_hub/language.json'), { language: id });
    if (item.complete) fs.cpSync(path.resolve(hub, '../langpacks/zh-TW'), directories.installed, { recursive: true });
    if (item.webOnly) fs.unlinkSync(path.join(directories.installed, 'native.json'));
    if (item.corrupt) item.corrupt(directories.installed);
    if (item.badExternal) badUi(directories.external);
    if (item.badBundled) badUi(directories.bundled);
    const env = { ...process.env, HUB_ROOT: workspace, HUB_LANG: 'ja', HUB_LANGPACK_DIR: directories.external, HUB_STORAGE_GUARD: '/usr/bin/true' };
    const node = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(path.join(libs, 'langpack'))});p.setRoot(process.env.HUB_ROOT);console.log(JSON.stringify({language:require(${JSON.stringify(path.join(libs, 'locale'))}).locale(),directory:p.activePack()?.directory}));`], { env, encoding: 'utf8', timeout: 10000 });
    const native = spawnSync(executable, [], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(node.status, 0, node.stderr); assert.equal(native.status, 0, native.stderr);
    const actualNode = JSON.parse(node.stdout), actualNative = JSON.parse(native.stdout);
    assert.equal(actualNode.language, item.expected === 'ja' ? 'ja' : id);
    assert.equal(actualNative.language, actualNode.language);
    if (item.expected === 'ja') assert.deepEqual(actualNative.native, {});
    else {
      assert.equal(actualNode.directory, directories[item.expected]); assert.equal(actualNative.directory, actualNode.directory);
      assert.deepEqual(actualNative.native, item.webOnly ? {} : JSON.parse(fs.readFileSync(path.join(actualNode.directory, 'native.json'))));
    }
  });
});

test('English assets work in setup and both App builds; incomplete or invalid packs fall back', t => {
  const f = fixture(t), run = mockedBuild(f);
  const write = (name,value) => { const file=path.join(f.pack,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value)); };
  write('pack.json',{id:'en',name:'English test fixture',verifiedWith:'4.109.1',dateLocale:'en-US'});
  write('native.json',{'保存':'Save','書類フォルダにあるプロジェクトの台帳と本体を読み書きするために使います。':'Document permission test'});
  write('templates/_hub/roles.yaml','roles: []\n');
  for(const name of ['PROJECT.md','.ai/rules.md','.ai/tasks/_template.md'])write('templates/project/'+name,'English test template');
  write('seed/Example/PROJECT.md','English test seed');write('docs/README.md','English test documentation');write('docs/CHANGELOG.md','English test changes');
  write('docs/ui.css','must not bundle');write('templates/execute.js','must not bundle');
  const setup=run('setup.sh',{HUB_LANG:'en'});assert.equal(setup.status,0,setup.stderr);
  assert.equal(fs.readFileSync(path.join(f.root,'workspace/Product/Example/PROJECT.md'),'utf8'),'English test seed');
  for (const bundled of ['0','1']) {
    const result=run('app/build-app.sh',{HUB_LANG:'en',HUB_BUNDLE_RUNTIME:bundled});assert.equal(result.status,0,result.stderr);
    const app=path.join(f.root,'apps/Project Hub.app'),plist=fs.readFileSync(path.join(app,'Contents/Info.plist'),'utf8');
    assert.match(plist,/<key>HubLanguage<\/key><string>en<\/string>/);assert.match(plist,/<key>CFBundleLocalizations<\/key><array><string>ja<\/string><string>en<\/string>/);
    assert.match(plist,/Document permission test/);
    if(bundled==='1'){assert.equal(fs.readFileSync(path.join(app,'Contents/Resources/runtime/langpacks/en/pack.json'),'utf8'),fs.readFileSync(path.join(f.pack,'pack.json'),'utf8'));
      assert.equal(fs.existsSync(path.join(app,'Contents/Resources/runtime/langpacks/en/docs/ui.css')),false);assert.equal(fs.existsSync(path.join(app,'Contents/Resources/runtime/langpacks/en/templates/execute.js')),false);}
  }
  fs.rmSync(path.join(f.pack,'native.json'));
  assertJapaneseBuild(f,run('app/build-app.sh',{HUB_LANG:'en',HUB_BUNDLE_RUNTIME:'1'}));
  fs.rmSync(path.join(f.pack,'templates/_hub/roles.yaml'));
  const missingRoot=path.join(f.root,'missing workspace');const missing=run('setup.sh',{HUB_LANG:'en',HUB_ROOT:missingRoot});assert.equal(missing.status,0,missing.stderr);
  assert.ok(fs.existsSync(path.join(missingRoot,'Product/サンプルアプリ/PROJECT.md')));
  write('pack.json',{id:'../bad'});
  const invalidRoot=path.join(f.root,'invalid workspace');const invalid=run('setup.sh',{HUB_LANG:'../bad',HUB_ROOT:invalidRoot});assert.equal(invalid.status,0,invalid.stderr);
  assert.ok(fs.existsSync(path.join(invalidRoot,'Product/サンプルアプリ/PROJECT.md')));
  const invalidBuild=run('app/build-app.sh',{HUB_LANG:'../bad',HUB_BUNDLE_RUNTIME:'1'});assert.equal(invalidBuild.status,0,invalidBuild.stderr);
  assert.match(fs.readFileSync(path.join(f.root,'apps/Project Hub.app/Contents/Info.plist'),'utf8'),/<key>HubLanguage<\/key><string>ja<\/string>/);
});

// Run the actual native validators and interpolation without launching the App.
test('native installed dictionaries reject grapheme-hidden syntax and preserve plain and HTML interpolation', t => {
  const source=fs.readFileSync(path.join(hub,'app/window.swift'),'utf8'),f=fixture(t);
  const validator=source.slice(source.indexOf('func validPackMessages('),source.indexOf('func loadNativeMessages('));
  const translate=source.slice(source.indexOf('func tr('),source.indexOf('\nlet port ='));
  const file=path.join(f.root,'native-validation.swift');
  fs.writeFileSync(file,'import Foundation\nvar nativeMessages: [String:String] = [:]\n'+validator+translate+String.raw`
let invalid = ["<\u{0338}img src=x onerror=alert(1)>", "<\u{0338}img src=x", "\u{E000}\u{0338}", "\u{E001}\u{0338}"]
for value in invalid { precondition(!validPackMessages(["原文":value])) }
precondition(validPackMessages(["原文":"Translated\nText", "<p>原文：${'${0}'}</p>":"<p>Text: ${'${0}'}</p>"]))
nativeMessages=["原文：${'${0}'}":"Text: ${'${0}'}","<p>原文：${'${0}'}</p>":"<p>Text: ${'${0}'}</p>"]
precondition(tr("原文：${'${0}'}", "A\nB") == "Text: A\nB")
precondition(tr("<p>原文：${'${0}'}</p>", "<img>&") == "<p>Text: &lt;img&gt;&amp;</p>")
print("native validation OK")
`);
  const result=spawnSync('swift',[file],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/native validation OK/);
});
