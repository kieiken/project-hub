'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// App updates have their own setting; this never changes AI CLI updates or
// refreshes the page while a task or draft is active.
let appUpdateData = null, appUpdatePending = false, appUpdateEpoch = 0;
const APP_UPDATE_PHASES = {
  idle: UI.text('待機中'), checking: UI.text('更新を確認しています'), deferred: UI.text('作業が終わるまで待っています'),
  preparing: UI.text('新版の準備中'), translating: UI.text('繁体字中国語に翻訳しています'), testing: UI.text('テストを実行しています'),
  building: UI.text('アプリを作成しています'), verifying: UI.text('インストールを確認しています'), ready: UI.text('適用待ち'), installing: UI.text('新版を適用しています'), installed: UI.text('更新済み'),
  publishing: UI.text('翻訳のPRを送っています'), published: UI.text('翻訳のPRを送りました'), conflict: UI.text('手元の変更があるため停止しています'),
  failed: UI.text('更新に失敗しました'), error: UI.text('更新に失敗しました')
};
function appUpdateDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ja-JP') : UI.text('まだ確認していません');
}
function appUpdateHtml(data) {
  const d = data || {}, disabled = appUpdatePending || d.supported === false ? 'disabled' : '';
  const checking = ['checking', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(d.phase);
  return UI.template`<label class="chk"><input id="app-auto-update" type="checkbox" ${d.enabled ? 'checked' : ''} ${disabled}> Project Hub を自動で更新する</label>
    <p class="small">毎日1回確認します。取得元は kieiken/project-hub です。AI の作業・順番待ちが終わるまで適用を待ちます。この画面を勝手に読み直すことはありません。</p>
    <p class="small">稼働版：<b>${esc(d.sourceVersion || '—')}</b> ／ 最新版：<b>${esc(d.latestVersion || '—')}</b><br>前回の確認：${esc(appUpdateDate(d.lastCheck))}<br>次回の確認：${esc(d.nextCheck ? appUpdateDate(d.nextCheck) : UI.text('未定'))}</p>
    <p class="note" role="status">${esc(d.supported === false ? UI.text('未対応') : APP_UPDATE_PHASES[d.phase] || UI.text('待機中'))}${d.reason ? '：' + esc(d.reason) : ''}</p>
    ${d.pending ? UI.html('<p class="small">まだ適用していない更新があります。</p>') : ''}
    ${d.autoTranslate ? UI.html('<p class="small">新版を繁体字中国語に翻訳し、テストを通してからアプリを更新します。</p>') : ''}
    ${d.publishEnabled ? UI.html('<p class="small">テストを通した翻訳のPRを、元のプロジェクトへ送ります。</p>') : ''}
    ${d.prUrl ? UI.template`<button class="btn plain sm" data-url="${esc(d.prUrl)}" type="button">翻訳のPRを見る</button>` : ''}
    ${d.supported === false ? UI.html('<p class="small">このインストールではアプリの自動更新を使えません。</p>') : ''}
    ${d.error ? UI.template`<p class="danger" role="status">${esc(d.error)}</p>` : ''}
    ${d.publishError && d.publishError !== d.error ? UI.template`<p class="danger" role="status">翻訳PRの送信：${esc(d.publishError)}</p>` : ''}
    <div class="acts"><button class="btn plain" id="app-update-check" data-app-update="check" type="button" ${disabled || (checking ? 'disabled' : '')}>今すぐ更新を確認</button><span class="small" id="app-update-status" role="status">${appUpdatePending ? UI.text('確認中…') : ''}</span></div>`;
}
function appUpdateRender(box, data) {
  const draw = () => { box.innerHTML = appUpdateHtml(data); };
  if (typeof preserveSettingsScroll === 'function') preserveSettingsScroll(draw); else draw();
}
function appUpdateError(box, text) {
  const draw = () => { box.textContent = text; };
  if (typeof preserveSettingsScroll === 'function') preserveSettingsScroll(draw); else draw();
}
async function loadAppUpdate() {
  const box = $('#app-update-box'); if (!box || appUpdatePending) return;
  const epoch = ++appUpdateEpoch;
  try {
    const data = await api('/api/app-update');
    if ($('#app-update-box') !== box || epoch !== appUpdateEpoch || appUpdatePending) return;
    appUpdateData = data; appUpdateRender(box, data);
  } catch (error) { if ($('#app-update-box') === box && epoch === appUpdateEpoch) appUpdateError(box, error.message); }
}
async function changeAppUpdate(enabled) {
  const box = $('#app-update-box'); if (!box || appUpdatePending || appUpdateData?.supported === false) return;
  const epoch = ++appUpdateEpoch, before = appUpdateData;
  appUpdatePending = true; appUpdateRender(box, before);
  try {
    const data = await api('/api/app-update', { enabled });
    appUpdateData = data;
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, data);
      $('#app-update-status').textContent = UI.text('自動更新の設定を保存しました');
    }
  } catch (error) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, before);
      $('#app-update-status').textContent = error.message;
    }
  } finally { appUpdatePending = false; }
}
async function checkAppUpdate() {
  const box = $('#app-update-box'); if (!box || appUpdatePending || appUpdateData?.supported === false) return;
  if (['checking', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(appUpdateData?.phase)) return;
  const epoch = ++appUpdateEpoch;
  appUpdatePending = true; appUpdateRender(box, appUpdateData);
  try {
    const data = await api('/api/app-update/check', {});
    appUpdateData = data;
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, data);
      $('#app-update-status').textContent = UI.text('更新の状態を表示しました');
    }
  } catch (error) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, appUpdateData);
      $('#app-update-status').textContent = error.message;
    }
  } finally { appUpdatePending = false; }
}
document.addEventListener('change', event => {
  if (event.target.id === 'app-auto-update' && !event.target.disabled) void changeAppUpdate(event.target.checked);
});
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-app-update]');
  if (button && !button.disabled) void checkAppUpdate();
});
// Reading status is not another update check. Only the backend schedules the
// once-a-day upstream check, preserving the last-check record across restarts.
setInterval(() => { if (!document.hidden && typeof view !== 'undefined' && view.kind === 'settings' && !appUpdatePending) void loadAppUpdate(); }, 5000);
