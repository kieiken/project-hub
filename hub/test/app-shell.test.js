'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { AppShell } = require('../lib/app-shell');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = path.join(root, 'hub'), app = path.join(root, 'apps', 'Project Hub.app');
  fs.mkdirSync(path.join(hub, 'app'), { recursive: true }); fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'app/window.swift'), 'test shell source');
  const file = path.join(app, 'Contents/Info.plist'); fs.writeFileSync(file, 'fixture');
  let plist = { CFBundleShortVersionString: '4.53.3' }, calls = 0;
  const shell = new AppShell({ hub, env: { HUB_UPDATE_APP: app, HUB_STORAGE_GUARD: '/fixture/guard' }, readPlist: () => { calls++; return plist; }, ...options });
  return { root, hub, app, shell, file, reads: () => calls, plist: value => { plist = value; shell.plistKey = null; } };
}
test('shell hash compares installed and running apps, independent of app version', t => {
  const f = fixture(t), s = f.shell;
  assert.match(s.hash, /^[a-f0-9]{64}$/); assert.equal(s.status().stale, true); assert.equal(s.status().appVersion, '4.53.3');
  f.plist({ HubShellHash: s.hash, CFBundleShortVersionString: '4.53.3' });
  assert.equal(s.status().stale, false); assert.equal(s.status('ProjectHubApp/' + s.hash.slice(0, 12)).stale, false);
  assert.equal(s.status('ProjectHubApp/1').stale, true); assert.equal(s.status('ProjectHubApp/abcdef123456').stale, true);
  const reads = f.reads(); s.status(); assert.equal(f.reads(), reads);
});
test('missing and unreadable plist fail closed with an empty version', t => {
  const f = fixture(t); fs.unlinkSync(f.file); assert.deepEqual(f.shell.status(), { hash: f.shell.hash, stale: true, appVersion: '', rebuilding: false });
  fs.writeFileSync(f.file, 'bad'); f.shell.readPlist = () => { throw Error('invalid plist'); }; assert.equal(f.shell.status().stale, true); assert.equal(f.shell.status().appVersion, '');
});
test('actual plist reader handles build metadata without exposing paths', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '<?xml version="1.0"?><plist version="1.0"><dict><key>HubShellHash</key><string>'+f.shell.hash+'</string><key>CFBundleShortVersionString</key><string>4.91.5</string></dict></plist>');
  const s = new AppShell({ hub: f.hub, env: { HUB_UPDATE_APP: f.app } }); assert.equal(s.status().stale, false); assert.equal(s.status().appVersion, '4.91.5'); assert.doesNotMatch(JSON.stringify(s.status()), /hub-shell-|apps/);
});
test('dry rebuild performs no commands', async t => {
  let calls = 0; const f = fixture(t, { dry: true, run: async () => calls++ });
  await assert.rejects(f.shell.rebuild(), e => e.status === 409); assert.equal(calls, 0); assert.equal(f.shell.rebuilding, false);
});
test('rebuild targets the configured app, locks duplicates and verifies the resulting hash', async t => {
  const f = fixture(t); let finish, captured;
  f.shell.run = (file, args, opts) => { captured = { file, args, opts }; return new Promise(r => { finish = r; }); };
  const pending = f.shell.rebuild(); assert.equal(f.shell.rebuilding, true);
  await assert.rejects(f.shell.rebuild(), e => e.status === 409);
  assert.equal(captured.file, '/bin/bash'); assert.deepEqual(captured.args, [path.join(f.hub, 'app/build-app.sh')]);
  assert.equal(captured.opts.env.HUB_APP_DIR, path.dirname(f.app)); assert.equal(captured.opts.env.HUB_STORAGE_GUARD, '/fixture/guard'); assert.equal(captured.opts.timeout, 600000);
  f.plist({ HubShellHash: f.shell.hash, CFBundleShortVersionString: '4.91.5' }); finish();
  assert.deepEqual(await pending, { ok: true, message: 'アプリを終了して開き直してください' }); assert.equal(f.shell.rebuilding, false);
});
test('failed or unverifiable builds release the lock without reporting success', async t => {
  const f = fixture(t); f.shell.run = async () => { throw Error('mock build failed'); };
  await assert.rejects(f.shell.rebuild(), /mock build failed/); assert.equal(f.shell.rebuilding, false);
  f.shell.run = async () => {}; await assert.rejects(f.shell.rebuild(), /確認できません/); assert.equal(f.shell.rebuilding, false);
});

test('native shell removes ChatGPT panel and clipboard polling while keeping Hub paste, dialogs and rebuild hash', () => {
  const source=fs.readFileSync(path.join(__dirname,'../app/window.swift'),'utf8');
  assert.doesNotMatch(source,/GptPanel|toggleGpt|showGpt|checkClip|clipTimer|hubGptClip|chatgpt\.com|u\.host == "gpt"/);
  assert.match(source,/window\.contentView = web/);
  for(const feature of ['HubShellHash','hubNativePaste','hubNativeDrop','isFieldEditor','runJavaScriptConfirmPanel','runOpenPanel','u.host == "access"','u.host == "reveal"']) assert.ok(source.includes(feature),feature);
});

test('スクショのfile promiseは全件成功時だけ一度渡し、失敗・重複・時間切れを部分添付しない', {skip:process.platform!=='darwin'}, t => {
  const source=fs.readFileSync(path.join(__dirname,'../app/window.swift'),'utf8');
  const aggregation=source.split('// BEGIN PROMISED DROP BATCH')[1].split('// END PROMISED DROP BATCH')[0];
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-drop-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'main.swift'),binary=path.join(root,'drop-test');
  fs.writeFileSync(file,`import Foundation\n${aggregation}\n
var completed = 0
let good = PromisedDropBatch(count: 2) { paths in
    precondition(paths == ["one.png", "two.png"]); completed += 1
}
good.receive("one.png"); precondition(completed == 0)
good.receive("two.png"); good.receive("late.png"); good.cancel()
precondition(completed == 1)
for failure in 0...2 {
    var calls = 0
    let batch = PromisedDropBatch(count: 2) { paths in precondition(paths == nil); calls += 1 }
    batch.receive("one.png")
    if failure == 0 { batch.receive(nil) }
    if failure == 1 { batch.receive("one.png") }
    if failure == 2 { batch.cancel(); batch.receive("two.png") }
    batch.receive("late.png"); precondition(calls == 1)
}
print("promise aggregation passed")
`);
  execFileSync('swiftc',[file,'-o',binary],{timeout:60000});
  assert.match(execFileSync(binary,{encoding:'utf8',timeout:10000}),/promise aggregation passed/);
});
