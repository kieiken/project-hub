'use strict';
// 全画面共通の利用枠表示。作業画面の再描画や入力には触れない。
let usageData = null, usageLoading = false, usageError = '', usageClearing = false, usageClearError = '', usageVersion = 0;
const usageCompactMedia = typeof matchMedia === 'function' ? matchMedia('(max-width: 900px)') : null;
function usageDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供';
  return new Date(value).toLocaleString('zh-TW', { month:'numeric', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
}
function usageRemaining(value, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'リセット日時は未提供';
  const mins = Math.ceil((Date.parse(value) - now) / 60000);
  if (mins <= 0) return '予定時刻を過ぎました（再確認待ち）';
  const d = Math.floor(mins / 1440), h = Math.floor(mins % 1440 / 60), m = mins % 60;
  return `あと${d ? d + '日' : ''}${h ? h + '時間' : ''}${m || !d && !h ? m + '分' : ''}`;
}
function usageSummary(ai, provider, now = Date.now(), compact = false) {
  const name = ai === 'codex' ? (compact ? 'CX' : 'Codex') : (compact ? 'CC' : 'Claude');
  if (!provider || provider.status !== 'ok') return `${name} 未取得`;
  if (Date.parse(provider.fetchedAt) + 6 * 60000 < now) return `${name} 前回の情報`;
  const windows = provider.windows.filter(w => !w.id.startsWith('model:')).slice(0,2);
  return name + ' ' + windows.map(w => {
    if (!compact && w.resetsAt && Date.parse(w.resetsAt) <= now) return `${w.label.replace('週間', '每週').replace('時間', ' 小時')} 等待重新確認`;
    let label = w.label.replace(/枠$/, '');
    if (compact) label = label.replace(/^週間$/, 'W').replace(/^(\d+)時間$/, '$1hr');
    if (!compact) label = label.replace(/^週間$/, '每週').replace(/^(\d+)時間$/, '$1 小時');
    if (compact && ai === 'codex' && windows.length === 1 && label === 'W') label = '';
    const value = w.resetsAt && Date.parse(w.resetsAt) <= now ? '再確認待ち' : w.usedPercent === null ? '未提供' : Math.round(w.usedPercent) + '%';
    return `${label ? label + ' ' : ''}${value}`;
  }).join(compact ? ' ' : '・');
}
// 名前は文字で残し、識別用の図形は読み上げ・フォーカスの対象外にする。
function usageIcon(ai) {
  return ai === 'codex'
    ? '<svg class="usage-icon usage-icon-codex" viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect x="1.25" y="2.25" width="13.5" height="11.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.6 6.2 6.9 8 4.6 9.8M8.4 10.1h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg class="usage-icon usage-icon-claude" viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M8 8L15.2 8.0M8 8L12.8 11.6M8 8L11.0 13.2M8 8L7.1 15.1M8 8L5.0 13.2M8 8L2.5 10.3M8 8L0.8 8.0M8 8L3.2 4.4M8 8L5.0 2.8M8 8L8.9 0.9M8 8L11.0 2.8M8 8L13.5 5.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
}
function usageHtml(data, now = Date.now()) {
  const state = data?.fableLimit;
  const held = state?.hold && (state.until === null || Date.parse(state.until) > now);
  const limitNote = held ? `<p class="note">Fable 5.1 上限中・${state.until === null ? '解除日時不明・手動で解除するまで Astra' : esc(usageDate(state.until)) + 'まで（自動で Astra へ）'} <button id="usage-fable-clear" type="button"${usageClearing ? ' disabled' : ''}>Fableに戻す</button></p>` : '';
  return limitNote + ['codex','claude'].map(ai => {
    const p = data?.providers?.[ai];
    const name = ai === 'codex' ? 'Codex' : 'Claude';
    if (!p || p.status !== 'ok') return `<section class="card usage-card"><h3>${usageIcon(ai)}${name}</h3><p>未取得</p><p class="note">${esc(p?.message || '確認中…')}</p>${p?.attemptedAt ? `<p class="small">確認を試みた時刻：${esc(usageDate(p.attemptedAt))}</p>` : ''}</section>`;
    const old = Date.parse(p.fetchedAt) + 6 * 60000 < now;
    return `<section class="card usage-card"><h3>${usageIcon(ai)}${name}</h3>${old ? '<p class="note">前回取得した情報です。現在の状況を確認してください。</p>' : ''}${p.windows.map(w => {
      const expired = w.resetsAt && Date.parse(w.resetsAt) <= now;
      const pct = w.usedPercent === null ? '未提供' : `${Math.round(w.usedPercent)}%`;
      const bar = w.usedPercent === null ? '' : `<progress class="usage-progress" max="100" value="${Math.min(100,Math.max(0,w.usedPercent))}" aria-label="${esc(name + ' ' + w.label + ' 使用率')}" aria-valuetext="${esc(pct)}"></progress>`;
      return `<div class="usage-window${expired ? ' usage-expired' : ''}"><div class="row"><b>${esc(w.label)}</b><span class="usage-pct">${expired ? '前回の使用' : '使用'} ${esc(pct)}</span></div>${bar}<div class="small">リセット：${esc(usageDate(w.resetsAt))}<br>${esc(usageRemaining(w.resetsAt,now))}</div></div>`;
    }).join('')}<p class="small">取得：${esc(usageDate(p.fetchedAt))}</p></section>`;
  }).join('');
}
function usageRefreshWait(now = Date.now()) {
  return Math.max(0,Math.ceil((Date.parse(usageData?.refreshAfter) - now) / 1000)) || 0;
}
function drawUsageControls() {
  const wait = usageRefreshWait();
  $('#usage-refresh').disabled = usageLoading || wait > 0;
  $('#usage-status').setAttribute('aria-live',wait > 0 && !usageLoading && !usageError && !usageClearError ? 'off' : 'polite');
  $('#usage-status').textContent = usageClearError || (usageLoading ? '確認中…' : usageError || (wait > 0 ? `${wait}秒後に再確認できます` : ''));
}
function drawUsage() {
  const drawer = $('#usage-drawer'), savedTop = drawer.scrollTop;
  const b = $('#usage-toggle'); if (!b) return;
  const now = Date.now();
  const summary = compact => usageError ? '利用状況 未取得' : usageData ? ['codex','claude'].map(ai => usageSummary(ai,usageData.providers[ai],now,compact)).join(' / ') : '利用状況';
  const full = summary(false);
  b.textContent = summary(usageCompactMedia?.matches);
  b.setAttribute('aria-label', full + '。查看額度使用比例與重設時間');
  b.setAttribute('title', full + '。查看額度使用比例與重設時間');
  drawUsageControls();
  $('#usage-body').innerHTML = usageError ? '<p class="note">Hubに接続できませんでした。現在の利用状況は未取得です。</p>' : usageHtml(usageData);
  $('#usage-fable-clear')?.addEventListener('click',clearFableLimit);
  drawer.scrollTop = savedTop;
}
async function loadUsage(force = false) {
  if (usageLoading || document.hidden) return;
  if (force && usageRefreshWait() > 0) { drawUsageControls(); return; }
  const version = usageVersion;
  usageLoading = true; drawUsage();
  try {
    const loaded = await api(force ? '/api/usage/refresh' : '/api/usage', force ? {} : undefined, {'X-Hub':'1'});
    if (version === usageVersion) usageData = loaded;
    if (version === usageVersion) usageError = '';
  } catch { if (version === usageVersion) usageError = '利用状況を取得できませんでした'; }
  finally { usageLoading = false; drawUsage(); }
}
async function clearFableLimit() {
  if (usageClearing || !confirm('上限の保持を解除してFableに戻しますか？ 次の依頼で正式上限なら再びAstraへ切り替わります。')) return;
  usageClearing = true; usageClearError = ''; drawUsage();
  try {
    const cleared = await api('/api/limits/fable/clear', {}, {'X-Hub':'1'});
    usageVersion++; usageData = cleared;
    usageError = '';
  } catch { usageClearError = '解除を保存できませんでした'; }
  finally { usageClearing = false; drawUsage(); }
}
function closeUsage() {
  $('#usage-drawer').hidden = true;
  $('#usage-toggle').setAttribute('aria-expanded','false');
  $('#usage-toggle').focus({ preventScroll: true });
}
$('#usage-toggle').addEventListener('click', () => {
  if (!$('#usage-drawer').hidden) return closeUsage();
  $('#usage-drawer').hidden = false;
  $('#usage-toggle').setAttribute('aria-expanded','true');
  drawUsage(); $('#usage-close').focus({ preventScroll: true }); loadUsage();
});
$('#usage-close').addEventListener('click',closeUsage);
$('#usage-refresh').addEventListener('click',() => loadUsage(true));
document.addEventListener('keydown',e => { if (e.key === 'Escape' && !$('#usage-drawer').hidden) { e.preventDefault(); closeUsage(); } });
document.addEventListener('visibilitychange',() => { if (!document.hidden) loadUsage(); });
usageCompactMedia?.addEventListener('change',drawUsage);
setInterval(() => { if (!document.hidden) { drawUsage(); if (!usageError) loadUsage(); } },60000);
setInterval(() => { if (!document.hidden && !$('#usage-drawer').hidden) drawUsageControls(); },1000);
loadUsage();
