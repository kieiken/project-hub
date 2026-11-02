'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '../../../hub');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-locale-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), home = path.join(root, 'home'), apps = path.join(root, 'apps');
  for (const dir of [bin, home, apps]) fs.mkdirSync(dir);
  const fake = (name, text) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + text, {mode: 0o755});
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fake('swiftc', "printf '%s\\n' \"$@\" > \"$HUB_APP_DIR/swift-args\"\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then shift; echo executable > \"$1\"; exit 0; fi; shift; done\n");
  for (const name of ['codesign','sips','iconutil','open']) fake(name, 'exit 0\n');
  const env = {...process.env, HOME:home, PATH:bin+':/usr/bin:/bin', HUB_ROOT:path.join(root,'workspace'), HUB_APP_DIR:apps,
    HUB_SKIP_NPM:'1', HUB_SKIP_APP:'1', HUB_NO_DESKTOP_LINK:'1', HUB_STORAGE_GUARD:'', HUB_LANGPACK_DIR:path.resolve(__dirname,'..')};
  delete env.HUB_LANG;
  let sourceHub = hub;
  const publicSource = () => {
    // A portable build must use exported sources, never bypass the owner guard.
    // Prepare only a disposable fixture using the real export exclusions.
    const repository = path.dirname(hub), target = path.join(root, 'public-source');
    const { excluded } = require('../../../scripts/export-public');
    const copy = name => {
      const file=path.join(repository,name), stat=fs.lstatSync(file);
      if (stat.isDirectory()) {
        if (['node_modules','.git'].includes(path.basename(name))) return;
        for (const child of fs.readdirSync(file)) copy(path.join(name,child));
      } else if (stat.isFile() && !excluded(name.split(path.sep).join('/'))) {
        fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});
        fs.copyFileSync(file,path.join(target,name));
      }
    };
    for (const name of ['hub', 'docs/project-hub/templates', 'langpacks/zh-TW', 'README.md', 'README.zh-TW.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-TW.md']) {
      copy(name);
    }
    // Existing offline dependencies are fixture inputs, not fetched or installed.
    fs.cpSync(path.join(hub, 'node_modules'), path.join(target, 'hub/node_modules'), { recursive: true });
    sourceHub = path.join(target, 'hub');
    assert.equal(fs.existsSync(path.join(sourceHub, 'lib/license/owner-edition.js')), false);
  };
  return {root, apps, env, publicSource, run:(file, extra={}) => spawnSync('/bin/bash',[path.join(sourceHub,file)],{env:{...env,...extra},encoding:'utf8',timeout:15000})};
}
test('Mock App builds keep the Japanese default and store Chinese language without changing terminal output', t => {
  const f=fixture(t);
  for(const language of ['ja','zh-TW']) {
    const result=f.run('app/build-app.sh',language==='ja'?{}:{HUB_LANG:language});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/アプリを組み立てています/);
    const plist=fs.readFileSync(path.join(f.apps,'Project Hub.app/Contents/Info.plist'),'utf8');
    assert.ok(plist.includes('<key>HubLanguage</key><string>'+language+'</string>'));
    assert.ok(plist.includes('<string>ja</string>')); if(language==='zh-TW') assert.ok(plist.includes('<string>zh-TW</string>'));
    assert.ok(plist.includes(language==='ja'?'書類フォルダにある':'用於讀寫文件資料夾'));
  }
  const swift=fs.readFileSync(path.join(hub,'app/window.swift'),'utf8');
  assert.match(swift,/ProcessInfo\.processInfo\.environment\["HUB_LANG"\][\s\S]*HubLanguage[\s\S]*\?\? "ja"/);
  assert.match(swift,/env\["HUB_LANG"\] = hubLanguage/);
});
test('Chinese setup uses Chinese example data and templates and leaves an existing project untouched', t => {
  const f=fixture(t), existing=path.join(f.env.HUB_ROOT,'Product','範例應用程式');
  fs.mkdirSync(existing,{recursive:true});fs.writeFileSync(path.join(existing,'keep'),'使用者原文');
  const result=f.run('setup.sh',{HUB_LANG:'zh-TW'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(path.join(existing,'keep'),'utf8'),'使用者原文');
  assert.ok(fs.existsSync(path.join(f.env.HUB_ROOT,'Product','範例網站','PROJECT.md')));
  assert.match(fs.readFileSync(path.join(f.env.HUB_ROOT,'_hub/roles.yaml'),'utf8'),/司令塔:/);
});
test('Installed C catalogs enable the translation workflow only with explicit opt-in; preparation is mocked', () => {
  const source=fs.readFileSync(path.join(hub,'server.js'),'utf8');
  const code=source.slice(source.indexOf('const updateSource ='),source.indexOf('const appUpdate ='))+'\nglobalThis.ready=translationReady;globalThis.workflow=automation;';
  for(const [sourceRoot,optIn,expected] of [[path.dirname(hub),'1',true],[path.dirname(hub),'0',false],[path.join(hub,'does-not-exist'),'1',false]]) {
    let calls=0;
    const context={fs,path,loadPack:require('../../../hub/lib/langpack').loadPack,ROOT:'/mock/workspace',process:{env:{HUB_UPDATE_SOURCE:sourceRoot,HUB_AUTO_TRANSLATE:optIn,HUB_TRANSLATION_FORK:'mock/fork'}},require:name=>{
      assert.equal(name,'./lib/app-update-workflow');return {createAutomation:()=>{calls++;return {mock:true}}};
    }};
    vm.runInNewContext(code,context);
    assert.equal(context.ready,sourceRoot===path.dirname(hub));
    assert.equal(calls,expected?1:0);
    assert.equal(Boolean(context.workflow.mock),expected);
  }
});
test('Portable App bundles the runtime and templates with relocatable location and no creator workspace', t => {
  const f=fixture(t), marker=path.join(hub,'lib/license/owner-edition.js');
  const owner=fs.existsSync(marker) ? fs.readFileSync(marker) : null;
  if (owner) {
    const rejected=f.run('app/build-app.sh',{HUB_LANG:'zh-TW',HUB_BUNDLE_RUNTIME:'1'});
    assert.equal(rejected.status,1);assert.match(rejected.stdout,/製作者版の印/);
    assert.equal(fs.existsSync(path.join(f.apps,'Project Hub.app')),false);
  }
  f.publicSource();
  const result=f.run('app/build-app.sh',{HUB_LANG:'zh-TW',HUB_BUNDLE_RUNTIME:'1'});
  assert.equal(result.status,0,result.stderr);
  if (owner) assert.deepEqual(fs.readFileSync(marker),owner);
  assert.match(fs.readFileSync(path.join(f.apps,'swift-args'),'utf8'),/-target\n(?:arm64|x86_64)-apple-macosx12\.0/);
  const app=path.join(f.apps,'Project Hub.app'), runtime=path.join(app,'Contents/Resources/runtime');
  const plist=fs.readFileSync(path.join(app,'Contents/Info.plist'),'utf8');
  assert.ok(plist.includes('<key>HubDir</key><string>@bundle/runtime/hub</string>'));
  assert.ok(plist.includes('<key>HubRoot</key><string></string>'));
  assert.ok(plist.includes('<key>HubStorageGuard</key><string></string>'));
  for(const file of ['hub/app/window.swift','hub/app/build-app.sh','hub/server.js','langpacks/zh-TW/ui.json','hub/node_modules/node-pty/package.json',
    'langpacks/zh-TW/templates/project/.ai/rules.md','langpacks/zh-TW/seed/Project Hub/PROJECT.md','LICENSE']) assert.ok(fs.existsSync(path.join(runtime,file)),file);
  for(const file of ['.git','.ai','hub/test','hub/pr-c-ja-full.log']) assert.equal(fs.existsSync(path.join(runtime,file)),false,file);
  const swift=fs.readFileSync(path.join(hub,'app/window.swift'),'utf8');assert.match(swift,/hubLocation\.hasPrefix\("@bundle\/"\)[\s\S]*Bundle\.main\.resourceURL/);
});

test('Portable Chinese build finds the default pack without an explicit override', t => {
  const f = fixture(t); delete f.env.HUB_LANGPACK_DIR;
  f.publicSource();
  const result = f.run('app/build-app.sh', { HUB_LANG: 'zh-TW', HUB_BUNDLE_RUNTIME: '1' });
  assert.equal(result.status, 0, result.stderr);
  const app = path.join(f.apps, 'Project Hub.app');
  const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>HubLangpackDir<\/key><string>@bundle\/runtime\/langpacks\/zh-TW<\/string>/);
  assert.match(plist, /用於讀寫文件資料夾/);
  assert.equal(fs.readFileSync(path.join(app, 'Contents/Resources/runtime/langpacks/zh-TW/native.json'), 'utf8'), fs.readFileSync(path.join(__dirname, '../native.json'), 'utf8'));
});
