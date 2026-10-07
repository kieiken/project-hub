'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '..');
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
    HUB_SKIP_NPM:'1', HUB_SKIP_APP:'1', HUB_NO_DESKTOP_LINK:'1', HUB_STORAGE_GUARD:''};
  delete env.HUB_LANG;
  return {root, apps, env, run:(file, extra={}) => spawnSync('/bin/bash',[path.join(hub,file)],{env:{...env,...extra},encoding:'utf8',timeout:15000})};
}
test('Mock App builds keep the Japanese default and store Chinese language without changing terminal output', t => {
  const f=fixture(t);
  for(const language of ['ja','zh-TW']) {
    const result=f.run('app/build-app.sh',language==='ja'?{}:{HUB_LANG:language});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/アプリを組み立てています/);
    const plist=fs.readFileSync(path.join(f.apps,'Project Hub.app/Contents/Info.plist'),'utf8');
    assert.ok(plist.includes('<key>HubLanguage</key><string>'+language+'</string>'));
    assert.match(plist,/<string>ja<\/string><string>zh-TW<\/string>/);
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
    const context={fs,path,ROOT:'/mock/workspace',process:{env:{HUB_UPDATE_SOURCE:sourceRoot,HUB_AUTO_TRANSLATE:optIn,HUB_TRANSLATION_FORK:'mock/fork'}},require:name=>{
      assert.equal(name,'./lib/app-update-workflow');return {createAutomation:()=>{calls++;return {mock:true}}};
    }};
    vm.runInNewContext(code,context);
    assert.equal(context.ready,sourceRoot===path.dirname(hub));
    assert.equal(calls,expected?1:0);
    assert.equal(Boolean(context.workflow.mock),expected);
  }
});
test('Portable App bundles the runtime and templates with relocatable location and no creator workspace', t => {
  const f=fixture(t), result=f.run('app/build-app.sh',{HUB_LANG:'zh-TW',HUB_BUNDLE_RUNTIME:'1'});
  assert.equal(result.status,0,result.stderr);
  assert.match(fs.readFileSync(path.join(f.apps,'swift-args'),'utf8'),/-target\n(?:arm64|x86_64)-apple-macosx12\.0/);
  const app=path.join(f.apps,'Project Hub.app'), runtime=path.join(app,'Contents/Resources/runtime');
  const plist=fs.readFileSync(path.join(app,'Contents/Info.plist'),'utf8');
  assert.ok(plist.includes('<key>HubDir</key><string>@bundle/runtime/hub</string>'));
  assert.ok(plist.includes('<key>HubRoot</key><string></string>'));
  assert.ok(plist.includes('<key>HubStorageGuard</key><string></string>'));
  for(const file of ['hub/server.js','hub/locales/zh-TW.json','hub/node_modules/node-pty/package.json',
    'docs/project-hub/templates/zh-TW/project/.ai/rules.md','hub/seed-zh-TW/Project Hub/PROJECT.md','LICENSE']) assert.ok(fs.existsSync(path.join(runtime,file)),file);
  for(const file of ['.git','.ai','hub/test','hub/app','hub/pr-c-ja-full.log']) assert.equal(fs.existsSync(path.join(runtime,file)),false,file);
  const swift=fs.readFileSync(path.join(hub,'app/window.swift'),'utf8');assert.match(swift,/hubLocation\.hasPrefix\("@bundle\/"\)[\s\S]*Bundle\.main\.resourceURL/);
});
