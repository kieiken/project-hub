'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app-update.js'), 'utf8');
const snapshot = { enabled: false, sourceVersion: '4.68.2', latestVersion: '4.68.3', lastCheck: '2026-10-07T00:00:00Z', nextCheck: '2026-10-08T00:00:00Z', phase: 'idle', pending: false, error: '', supported: true, autoTranslate: true, publishEnabled: true };
function fixture(locale = 'ja') {
  const elements = new Map(), handlers = new Map(), calls = [], timers = [];
  const element = key => { if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', disabled: false }); return elements.get(key); };
  const context = vm.createContext({ $: element, esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])),
    api: async (route, body) => { calls.push({ route, body }); return { ...snapshot }; },
    view: { kind: 'settings' }, document: { hidden: false, addEventListener(name, fn) { handlers.set(name, fn); } },
    setInterval(fn) { timers.push(fn); }, location: { reload() { throw Error('must not reload'); } } });
  vm.runInContext(source, context);
  return { context, calls, timers, handlers, element, elements, run: code => vm.runInContext(code, context) };
}
test('App update card distinguishes daily checking, translation, test, install and PR state and escapes errors', () => {
  const f = fixture(), data = { ...snapshot, enabled: true, pending: true, phase: 'deferred', prUrl: 'https://github.com/kieiken/project-hub/pull/5' };
  const html = f.context.appUpdateHtml(data);
  assert.match(html, /Project Hub を自動で更新する/); assert.match(html, /4\.68\.2/); assert.match(html, /4\.68\.3/);
  assert.match(html, /kieiken\/project-hub/); assert.match(html, /data-url="https:\/\/github.com\/kieiken\/project-hub\/pull\/5"/);
  for (const phase of ['translating', 'testing', 'building', 'verifying', 'publishing']) assert.match(f.context.appUpdateHtml({ ...snapshot, phase }), /id="app-update-check"[^>]*disabled/);
  const error = f.context.appUpdateHtml({ ...snapshot, error: '<script>error</script>', publishError: '<b>publish failed</b>' });
  assert.match(error, /&lt;script&gt;/); assert.match(error, /&lt;b&gt;/); assert.doesNotMatch(error, /<script>|<b>publish failed/);
});
test('Toggle saves one explicit boolean, prevents duplicate writes and restores the previous setting on failure', async () => {
  const f = fixture(); await f.context.loadAppUpdate(); f.calls.length = 0;
  let release; f.context.api = (route, body) => { f.calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return new Promise(resolve => { release = resolve; }); };
  const pending = f.context.changeAppUpdate(true); await f.context.changeAppUpdate(false);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { route: '/api/app-update', body: { enabled: true } });
  release({ ...snapshot, enabled: true }); await pending;
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*checked/);
  f.context.api = async () => { throw Error('save failed'); }; await f.context.changeAppUpdate(false);
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*checked/);
  assert.equal(f.element('#app-update-status').textContent, 'save failed');
});
test('Manual checking displays returned status and status polling never triggers another upstream check or reload', async () => {
  const f = fixture(); await f.context.loadAppUpdate(); f.calls.length = 0;
  f.context.api = async (route, body) => { f.calls.push({ route, body }); return { ...snapshot, phase: route.endsWith('/check') ? 'checking' : 'deferred', pending: true }; };
  await f.context.checkAppUpdate(); await f.context.checkAppUpdate();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].route, '/api/app-update/check');
  assert.equal(f.element('#app-update-status').textContent, '更新の状態を表示しました');
  f.timers[0](); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].route, '/api/app-update'); assert.equal(f.calls[1].body, undefined);
  assert.match(f.element('#app-update-box').innerHTML, /作業が終わるまで待っています/);
  f.context.document.hidden = true; f.timers[0](); assert.equal(f.calls.length, 2);
  f.context.document.hidden = false; f.context.view.kind = 'work'; f.timers[0](); assert.equal(f.calls.length, 2);
});
test('Unavailable update adapters disable mutation while stale status responses cannot replace a newer settings card', async () => {
  const f = fixture(); f.context.api = async () => ({ ...snapshot, supported: false }); await f.context.loadAppUpdate();
  assert.match(f.element('#app-update-box').innerHTML, /id="app-auto-update"[^>]*disabled/);
  assert.match(f.element('#app-update-box').innerHTML, /id="app-update-check"[^>]*disabled/);
  let writes = 0; f.context.api = async () => { writes++; return snapshot; };
  await f.context.changeAppUpdate(true); await f.context.checkAppUpdate(); assert.equal(writes, 0);
  let release; f.context.api = () => new Promise(resolve => { release = resolve; });
  const old = f.context.loadAppUpdate(), current = { innerHTML: 'new settings', textContent: '' }; f.elements.set('#app-update-box', current);
  release(snapshot); await old; assert.equal(current.innerHTML, 'new settings');
});
test('App update settings and module loading are distinct from AI CLI update controls', () => {
  const app = require('./fixtures/app-source.cjs').readApp();
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(app, /id="app-update-box"/); assert.match(app, /loadAppUpdate/); assert.match(index, /src="app-update.js"/);
  assert.match(app, /id="ai-tools"/); assert.doesNotMatch(source, /location\.reload|window\.open|\/api\/ai-tools/);
});

test('A cached daily check displays stored status without claiming a new check started', async () => {
  const f=fixture(); await f.context.loadAppUpdate();
  f.context.api=async()=>({...snapshot,phase:'idle'}); await f.context.checkAppUpdate();
  assert.equal(f.element('#app-update-status').textContent,'更新の状態を表示しました');
  assert.doesNotMatch(f.element('#app-update-status').textContent,/開始しました/);
  assert.equal(f.run('appUpdateData.lastCheck'),snapshot.lastCheck);
});

test('Manual wait feedback explains no request, gives its deadline and survives in the polling card', async () => {
  const f = fixture(), d = { ...snapshot, mode: 'packaged', checkPerformed: false, checkSkippedReason: '連続した確認を防ぐため、前回の手動確認から60秒は再確認できません。', manualCheckBlockedReason: '連続した確認を防ぐため、前回の手動確認から60秒は再確認できません。', nextManualCheck: '2026-11-17T11:00:00Z' };
  f.context.api = async () => d; await f.context.checkAppUpdate();
  assert.match(f.element('#app-update-status').textContent, /手動確認から60秒/);
  assert.match(f.element('#app-update-status').textContent, /次に手動確認できる時刻/);
  assert.doesNotMatch(f.element('#app-update-status').textContent, /配信元に更新を確認しました/);
  await f.context.loadAppUpdate(); assert.match(f.element('#app-update-box').innerHTML, /60秒.*<br>.*次に手動確認できる時刻/);
  f.context.api = async () => ({ ...snapshot, checkPerformed: true }); await f.context.checkAppUpdate();
  assert.equal(f.element('#app-update-status').textContent, '配信元に更新を確認しました。');
  f.context.api = async () => ({ ...snapshot, checkPerformed: true, error: 'failed' }); await f.context.checkAppUpdate();
  assert.match(f.element('#app-update-status').textContent, /確認できませんでした/);
});

test('Shared update summary compares numeric versions and agrees with detailed unconfirmed/current/new states', () => {
  const f = fixture();
  for (const [latest, expected] of [['', '更新状態は未確認です。'], ['4.126.98', '新しい版のお知らせはありません。'], ['4.126.9', '新しい版のお知らせはありません。'], ['4.126.99', '新しい版があります。'], ['4.127.0', '新しい版があります。']]) {
    const d = { ...snapshot, currentVersion: '4.126.98', latestVersion: latest };
    assert.equal(f.context.appUpdateSummary(d).text, expected); assert.ok(f.context.appUpdateHtml(d).includes(expected));
  }
});

test('Processing card shows an in-progress reason without a misleading next-day manual deadline', async () => {
  const f = fixture(), reason = '更新の処理中です。終わるまで手動確認はできません。';
  for (const phase of ['checking', 'downloading', 'verifying', 'installing']) {
    f.context.api = async () => ({ ...snapshot, mode: 'packaged', phase, manualCheckBlockedReason: reason, nextManualCheck: null });
    await f.context.loadAppUpdate();
    const html = f.element('#app-update-box').innerHTML;
    assert.match(html, /更新の処理中です。終わるまで手動確認はできません。/);
    assert.doesNotMatch(html, /前回の更新を確認できなかった|24時間の再確認待ち|次に手動確認できる時刻/);
  }
  const failed = f.context.appUpdateHtml({ ...snapshot, phase: 'failed', error: 'fixture failure', manualCheckBlockedReason: '前回の更新を確認できなかったため、24時間の再確認待ちです。', nextManualCheck: '2026-11-17T11:00:00Z' });
  assert.match(failed, /確認できなかった.*24時間.*<br>.*次に手動確認できる時刻/);
  assert.doesNotMatch(failed, /更新の処理中です/);
});

test('U20 completed App card shows verified release details, disabled reasons and existing gray button style', () => {
  const f = fixture();
  const html = f.context.appUpdateHtml({ ...snapshot, mode: 'packaged', currentVersion: '1.2.3', sourceVersion: '0.0.0', phase: 'ready', pending: true, notes: '<script>notes</script>', previousVersion: '1.2.2' });
  assert.match(html, /GitHub Releases（完成アプリ）/); assert.match(html, /1\.2\.3/); assert.doesNotMatch(html, /0\.0\.0/);
  assert.match(html, /保持している前の版：1\.2\.2/); assert.match(html, /&lt;script&gt;notes/); assert.match(html, /data-app-update="apply"/);
  for (const reason of ['準備中：配布元の設定がまだありません', '製作者版は自動更新の対象外です', 'ディスクイメージの中から開いています']) {
    const disabled = f.context.appUpdateHtml({ ...snapshot, mode: 'unsupported', supported: false, reason });
    assert.match(disabled, new RegExp(reason)); assert.match(disabled, /id="app-auto-update"[^>]*disabled/); assert.match(disabled, /id="app-update-check"[^>]*disabled/);
  }
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  assert.match(css, /#app-update-box \.acts \.btn:disabled\{background:var\(--hover\);border-color:var\(--line\);color:var\(--muted\);cursor:not-allowed\}/);
});

test('U20 completed App apply asks about drafts, serializes writes, preserves errors and never reloads', async () => {
  const f = fixture(); f.context.api = async () => ({ ...snapshot, mode: 'packaged', phase: 'ready', pending: true }); await f.context.loadAppUpdate();
  f.run('var chatDraft={task:"unsent"}; var rolesDirty=()=>false; var restartDraftMaps=()=>({drafts:new Map()});');
  let prompts = 0; f.context.confirm = () => { prompts++; return false; };
  assert.equal(f.context.appUpdateMayRestart(), false); await f.context.applyAppUpdate(); assert.equal(prompts, 1); assert.equal(f.calls.length, 0);
  let finish; f.context.confirm = () => true;
  f.context.api = (route, body) => { f.calls.push({ route, body: JSON.parse(JSON.stringify(body)) }); return new Promise(resolve => { finish = resolve; }); };
  const applying = f.context.applyAppUpdate(); await f.context.applyAppUpdate(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { route: '/api/app-update', body: { action: 'apply' } });
  finish({ ...snapshot, mode: 'packaged', phase: 'deferred', pending: true }); await applying;
  assert.doesNotMatch(f.element('#app-update-box').innerHTML, /data-app-update="apply"[^>]*disabled/);
  f.context.api = async () => { throw Error('apply failed'); }; await f.context.applyAppUpdate(); assert.equal(f.element('#app-update-status').textContent, 'apply failed');
  f.run('chatDraft={};'); assert.equal(f.context.appUpdateMayRestart(), true);
  f.run('rolesDirty=()=>true;'); assert.equal(f.context.appUpdateMayRestart(), false);
  f.run('rolesDirty=()=>false; restartDraftMaps=()=>({drafts:new Map([["task","draft"]])});'); assert.equal(f.context.appUpdateMayRestart(), false);
});

test('Windows update refusal is visible and disables both settings and manual checking', async () => {
  const f = fixture(); f.context.api = async () => ({ ...snapshot, supported: false, unsupportedReason: 'windows', reason: 'Windowsでは未対応：アプリの自動更新はまだ使えません' });
  await f.context.loadAppUpdate();
  const html = f.element('#app-update-box').innerHTML;
  assert.match(html, /Windowsでは未対応/); assert.match(html, /id="app-auto-update"[^>]*disabled/); assert.match(html, /id="app-update-check"[^>]*disabled/);
  f.context.api = () => assert.fail('disabled update must not send'); await f.context.changeAppUpdate(true); await f.context.checkAppUpdate(); await f.context.applyAppUpdate();
});


test('Windows ZIP card reports the actual update lifecycle and preserves draft-based restart deferral', () => {
  const f=fixture(),data={...snapshot,mode:'packaged',packageOS:'win32',phase:'ready',pending:true,restartNeeded:true};
  const html=f.context.appUpdateHtml(data);
  assert.match(html,/GitHub Releases（Windows ZIP）/);assert.doesNotMatch(html,/Windowsでは未対応|GitHub Releases（完成アプリ）/);
  assert.match(html,/入力中の文とAIの作業が終わると/);assert.match(html,/data-app-update="apply"/);
  f.run('var chatDraft={work:"unsent"};var rolesDirty=()=>false;var restartDraftMaps=()=>({drafts:new Map()});');
  assert.equal(f.context.appUpdateMayRestart(),false);f.run('chatDraft={};');assert.equal(f.context.appUpdateMayRestart(),true);
  assert.match(f.context.appUpdateHtml({...data,phase:'confirming'}),/新版の起動を確認しています/);
  assert.match(f.context.appUpdateHtml({...data,phase:'rolled-back'}),/前の版へ戻しました/);
});
