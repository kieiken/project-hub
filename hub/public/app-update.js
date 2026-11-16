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
  downloading: UI.text('新版を取得しています'), confirming: UI.text('新版の起動を確認しています'), 'rolled-back': UI.text('前の版へ戻しました'),
  failed: UI.text('更新に失敗しました'), error: UI.text('更新に失敗しました')
};
function appUpdateDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ja-JP') : UI.text('まだ確認していません');
}
function appUpdateSummary(d = {}) {
  if (d.error || d.publishError || ['failed', 'error', 'conflict', 'rolled-back'].includes(d.phase)) return { tone: 'bad', text: '更新の確認で問題がありました。下の表示を確かめてください。' };
  if (['checking', 'downloading', 'confirming', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(d.phase)) return { tone: 'run', text: '更新を確認・準備しています。' };
  const current = d.currentVersion || d.sourceVersion, latest = d.latestVersion;
  if (d.supported === false || !/^\d+\.\d+\.\d+$/.test(current || '') || !/^\d+\.\d+\.\d+$/.test(latest || '')) return { tone: 'hold', text: '更新状態は未確認です。' };
  const a = latest.split('.').map(Number), b = current.split('.').map(Number), i = a.findIndex((v, n) => v !== b[n]);
  return i >= 0 && a[i] > b[i] ? { tone: 'hold', text: '新しい版があります。' } : { tone: 'ok', text: '新しい版のお知らせはありません。' };
}
function appUpdateCheckFeedback(d) {
  if (d.checkPerformed === false) return UI.text(d.checkSkippedReason || '配信元への再確認はしていません。') + (d.manualCheckBlockedReason && d.nextManualCheck ? UI.text(' 次に手動確認できる時刻：') + appUpdateDate(d.nextManualCheck) : '');
  if (d.checkPerformed === true) return UI.text(d.error ? '更新を確認できませんでした。下の表示を確かめてください。' : '配信元に更新を確認しました。');
  return UI.text('更新の状態を表示しました');
}
function appUpdateHtml(data) {
  const d = data || {}, disabled = appUpdatePending || d.supported === false ? 'disabled' : '';
  const checking = ['checking', 'downloading', 'confirming', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(d.phase);
  return UI.template`<label class="chk"><input id="app-auto-update" type="checkbox" ${d.enabled ? 'checked' : ''} ${disabled}> Project Hub を自動で更新する</label>
    <p class="small">毎日1回確認します。取得元は ${esc(d.channel === 'purchase-test' ? '署名付きの購入試験版専用配信' : d.mode === 'packaged' ? (d.packageOS === 'win32' ? 'GitHub Releases（Windows ZIP）' : 'GitHub Releases（完成アプリ）') : 'kieiken/project-hub')} です。AI の作業・順番待ちが終わるまで適用を待ちます。この画面を勝手に読み直すことはありません。</p>
    <p class="small">稼働版：<b>${esc(d.currentVersion || d.sourceVersion || '—')}</b> ／ 最新版：<b>${esc(d.latestVersion || '—')}</b><br>前回の確認：${esc(appUpdateDate(d.lastCheck))}<br>次回の確認：${esc(d.nextCheck ? appUpdateDate(d.nextCheck) : UI.text('未定'))}</p>
    <p class="small">${esc(UI.text(appUpdateSummary(d).text))}</p>
    ${d.manualCheckBlockedReason || d.nextManualCheck ? UI.template`<p class="small">${d.manualCheckBlockedReason ? esc(UI.text(d.manualCheckBlockedReason)) : ''}${d.manualCheckBlockedReason && d.nextManualCheck ? '<br>' : ''}${d.nextManualCheck ? UI.text('次に手動確認できる時刻：') + esc(appUpdateDate(d.nextManualCheck)) : ''}</p>` : ''}
    <p class="note" role="status">${esc(d.supported === false ? UI.text('未対応') : APP_UPDATE_PHASES[d.phase] || UI.text('待機中'))}${d.reason ? '：' + esc(d.reason) : ''}</p>
    ${d.notes ? UI.template`<p class="small">${esc(d.notes)}</p>` : ''}
    ${d.previousVersion ? UI.template`<p class="small">保持している前の版：${esc(d.previousVersion)}</p>` : ''}
    ${d.restartNeeded ? UI.html(d.manualReopen ? '<p class="small">新しい版を準備しました。入力中の文を保存し、処理が終わったらアプリを閉じて同じアプリを開き直してください。起動を確認できなければ前の版へ戻します。</p>' : '<p class="small">新しい版を準備しました。入力中の文とAIの作業が終わるとアプリを開き直します。</p>') : d.pending ? UI.html('<p class="small">まだ適用していない更新があります。</p>') : ''}
    ${d.autoTranslate ? UI.html('<p class="small">新版を繁体字中国語に翻訳し、テストを通してからアプリを更新します。</p>') : ''}
    ${d.publishEnabled ? UI.html('<p class="small">テストを通した翻訳のPRを、元のプロジェクトへ送ります。</p>') : ''}
    ${d.prUrl ? UI.template`<button class="btn plain sm" data-url="${esc(d.prUrl)}" type="button">翻訳のPRを見る</button>` : ''}
    ${d.supported === false ? (d.unsupportedReason === 'windows' ? UI.html('<p class="small">Windowsでは未対応：アプリの自動更新はまだ使えません。</p>') : UI.html('<p class="small">このインストールではアプリの自動更新を使えません。</p>')) : ''}
    ${d.error ? UI.template`<p class="danger" role="status">${esc(d.error)}</p>` : ''}
    ${d.publishError && d.publishError !== d.error ? UI.template`<p class="danger" role="status">翻訳PRの送信：${esc(d.publishError)}</p>` : ''}
    <div class="acts"><button class="btn plain" id="app-update-check" data-app-update="check" type="button" ${disabled || (checking ? 'disabled' : '')}>今すぐ更新を確認</button>${d.mode === 'packaged' && ['ready','deferred'].includes(d.phase) && d.pending ? UI.template`<button class="btn plain" data-app-update="apply" type="button" ${disabled || (checking ? 'disabled' : '')}>新版を適用</button>` : ''}<span class="small" id="app-update-status" role="status">${appUpdatePending ? UI.text('確認中…') : ''}</span></div>`;
}
function appUpdateRender(box, data) {
  const draw = () => { box.innerHTML = appUpdateHtml(data); };
  if (typeof preserveSettingsScroll === 'function') preserveSettingsScroll(draw); else draw();
  const layout = typeof settingsLayoutCurrent === 'function' ? settingsLayoutCurrent() : null;
  if (layout) settingsLayoutStatus(layout);
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
  if (['checking', 'downloading', 'confirming', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(appUpdateData?.phase)) return;
  const epoch = ++appUpdateEpoch;
  appUpdatePending = true; appUpdateRender(box, appUpdateData);
  try {
    const data = await api('/api/app-update/check', {});
    appUpdateData = data;
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, data);
      $('#app-update-status').textContent = appUpdateCheckFeedback(data);
    }
  } catch (error) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, appUpdateData);
      $('#app-update-status').textContent = error.message;
    }
  } finally { appUpdatePending = false; }
}
// Native restart asks this immediately before closing the old App. Never discard
// drafts in a newly created window (sessionStorage does not survive that window).
function appUpdateHasDrafts() {
  const maps = typeof restartDraftMaps === 'function' ? restartDraftMaps() : {};
  return (typeof chatDraft !== 'undefined' && Object.values(chatDraft).some(Boolean)) ||
    (typeof rolesDirty === 'function' && rolesDirty()) || Object.values(maps).some(map => map.size > 0);
}
function appUpdateMayRestart() { return !appUpdateHasDrafts(); }
async function applyAppUpdate() {
  const box = $('#app-update-box');
  if (!box || appUpdatePending || appUpdateData?.supported === false || appUpdateData?.mode !== 'packaged' || !['ready', 'deferred'].includes(appUpdateData?.phase)) return;
  if (appUpdateHasDrafts() && !confirm('入力中の文があります。送信または削除が終わるまでアプリの開き直しを待ちます。更新の準備を進めますか？')) return;
  const epoch = ++appUpdateEpoch;
  appUpdatePending = true; appUpdateRender(box, appUpdateData);
  try {
    appUpdateData = await api('/api/app-update', { action: 'apply' });
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, appUpdateData);
    }
  } catch (e) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; appUpdateRender(box, appUpdateData);
      $('#app-update-status').textContent = e.message;
    }
  }
  finally { appUpdatePending = false; }
}
document.addEventListener('change', event => {
  if (event.target.id === 'app-auto-update' && !event.target.disabled) void changeAppUpdate(event.target.checked);
});
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-app-update]');
  if (button && !button.disabled) { if (button.dataset?.appUpdate === 'apply') void applyAppUpdate(); else void checkAppUpdate(); }
});
// Reading status is not another update check. Only the backend schedules the
// once-a-day upstream check, preserving the last-check record across restarts.
setInterval(() => { if (!document.hidden && typeof view !== 'undefined' && view.kind === 'settings' && !appUpdatePending) void loadAppUpdate(); }, 5000);
