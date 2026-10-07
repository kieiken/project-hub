'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// 全画面共通の利用枠表示。作業画面の再描画や入力には触れない。
let usageData = null, usageLoading = false, usageError = '', usageClearing = false, usageClearError = '', usageVersion = 0, usageContextKey = '';
function usageContext() {
  if (typeof view === 'undefined' || view.kind !== 'work') return {};
  const t = typeof taskOf === 'function' ? taskOf(proj(view.project), view.task) : null;
  return { project: view.project, task: view.task, claudeAccount: t?.accounts?.claude || 'default', codexAccount: t?.accounts?.codex || 'default' };
}
function usageContextChanged() {
  const context = usageContext();
  const t = typeof taskOf === 'function' && context.project ? taskOf(proj(context.project), context.task) : null;
  const key = JSON.stringify([context, t?.accounts || {}]);
  if (key === usageContextKey) return;
  usageContextKey = key; usageVersion++; usageData = null; usageError = ''; usageClearError = ''; drawUsage();
  if (!usageLoading) loadUsage();
}
const usageCompactMedia = typeof matchMedia === 'function' ? matchMedia('(max-width: 900px)') : null;
function usageDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return UI.text('未提供');
  return new Date(value).toLocaleString(UI.dateLocale, { month:'numeric', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
}
function usageRemaining(value, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return UI.text('リセット日時は未提供');
  const mins = Math.ceil((Date.parse(value) - now) / 60000);
  if (mins <= 0) return UI.text('予定時刻を過ぎました（再確認待ち）');
  const d = Math.floor(mins / 1440), h = Math.floor(mins % 1440 / 60), m = mins % 60;
  return UI.template`あと${d ? d + '日' : ''}${h ? h + '時間' : ''}${m || !d && !h ? m + '分' : ''}`;
}
function usagePercentClass(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value >= 100 ? ' usage-limit' : value >= 90 ? ' usage-warning' : '';
}
// short は上の欄の1行表示用。週間の文字を省き、時間枠は「5hr」に縮める（読み上げ用は省かない）。
function usageSummary(ai, provider, now = Date.now(), compact = false, html = false, short = false) {
  const text = value => html ? esc(value) : value;
  const name = ai === 'codex' ? (compact ? 'CX' : 'Codex') : (compact ? 'CC' : 'Claude');
  if (!provider || provider.status !== 'ok') return text(UI.template`${name} 未取得`);
  if (Date.parse(provider.fetchedAt) + 6 * 60000 < now) return text(UI.template`${name} 前回の情報`);
  const windows = provider.windows.filter(w => !w.id.startsWith('model:')).slice(0,2);
  if (!compact && ai === 'claude') windows.push(...provider.windows.filter(w => w.id.startsWith('model:')));
  return name + ' ' + windows.map(w => {
    let label = w.id.startsWith('model:') ? w.label.replace(/・週間枠$/, '') : w.label.replace(/枠$/, '');
    if (compact) label = label.replace(/^週間$/, 'W').replace(/^(\d+)時間$/, '$1hr');
    else if (short && !w.id.startsWith('model:')) label = label.replace(/^週間$/, '').replace(/^(\d+)時間$/, '$1hr');
    if (compact && ai === 'codex' && windows.length === 1 && label === 'W') label = '';
    if (!compact && w.resetsAt && Date.parse(w.resetsAt) <= now) return text(UI.template`${short ? label : w.label} 再確認待ち`.trim());
    const value = w.resetsAt && Date.parse(w.resetsAt) <= now ? UI.text('再確認待ち') : w.usedPercent === null ? UI.text('未提供') : Math.round(w.usedPercent) + '%';
    const rendered = html && value.endsWith('%') ? UI.template`<span class="usage-value${usagePercentClass(w.usedPercent)}">${esc(value)}</span>` : text(value);
    return `${label ? text(label) + ' ' : ''}${rendered}`;
  }).join(compact ? ' ' : UI.text('・'));
}
// 名前は文字で残し、識別用の図形は読み上げ・フォーカスの対象外にする。
function usageIcon(ai) {
  return ai === 'codex'
    ? '<svg class="usage-icon usage-icon-codex" viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>'
    : '<svg class="usage-icon usage-icon-claude" viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M8 8L15.2 8.0M8 8L12.8 11.6M8 8L11.0 13.2M8 8L7.1 15.1M8 8L5.0 13.2M8 8L2.5 10.3M8 8L0.8 8.0M8 8L3.2 4.4M8 8L5.0 2.8M8 8L8.9 0.9M8 8L11.0 2.8M8 8L13.5 5.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
}
function usageExtras(ai, provider) {
  if (ai !== 'codex') return '';
  const lines = [], reset = provider.resetCredits, credits = provider.credits;
  if (reset?.count > 0) {
    const details = (reset.items || []).map(item => UI.template`${item.title}・期限 ${usageDate(item.expiresAt)}`).join('／');
    lines.push(UI.template`リセットチケット：${reset.count}枚${details ? `（${details}）` : ''}`);
  }
  if (credits) {
    if (credits.unlimited === true) lines.push(UI.text('クレジット残高：無制限'));
    else if (typeof credits.balance === 'string' && credits.balance.trim() === credits.balance && /^\d+(?:\.\d+)?$/.test(credits.balance)) {
      const [whole, fraction] = credits.balance.split('.');
      lines.push(UI.template`クレジット残高：${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : '.' + fraction}`);
    }
  }
  return lines.length ? UI.template`<div class="usage-extras">${lines.map(line => UI.template`<p>${esc(line)}</p>`).join('')}</div>` : '';
}
function usageHtml(data, now = Date.now()) {
  const state = data?.fableLimit;
  const held = state?.hold && (state.until === null || Date.parse(state.until) > now);
  const limitNote = held ? UI.template`<p class="note">Fable 5.1 上限中・${state.until === null ? UI.text('解除日時不明・手動で解除するまで Astra') : esc(usageDate(state.until)) + 'まで（自動で Astra へ）'} <button id="usage-fable-clear" type="button"${usageClearing ? ' disabled' : ''}>Fableに戻す</button></p>` : '';
  const providers = Array.isArray(data?.accountProviders) ? data.accountProviders : Object.entries(data?.providers || {}).map(([ai,p]) => ({ ai, ...p }));
  if (!providers.length) return limitNote + UI.template`<p class="note">${data ? UI.text('表示できるログイン中のアカウントはありません。') : UI.text('確認中…')}</p>`;
  return limitNote + providers.map(p => {
    const ai = p.ai;
    const name = (ai === 'codex' ? 'Codex' : 'Claude') + (p?.accountName ? '・' + esc(p.accountName) : '');
    const heading = UI.template`<h3>${usageIcon(ai)}${name}${p.inUse ? UI.html('<span class="usage-current">使用中</span>') : ''}${p?.plan ? UI.template`<span class="usage-plan">${esc(p.plan)}</span>` : ''}</h3>`;
    if (!p || p.status !== 'ok') return UI.template`<section class="card usage-card">${heading}<p>未取得</p><p class="note">${esc(p?.message || UI.text('確認中…'))}</p>${p?.attemptedAt ? UI.template`<p class="small">確認を試みた時刻：${esc(usageDate(p.attemptedAt))}</p>` : ''}</section>`;
    const old = Date.parse(p.fetchedAt) + 6 * 60000 < now;
    return UI.template`<section class="card usage-card">${heading}${old ? UI.html('<p class="note">前回取得した情報です。現在の状況を確認してください。</p>') : ''}${p.windows.map(w => {
      const expired = w.resetsAt && Date.parse(w.resetsAt) <= now;
      const pct = w.usedPercent === null ? UI.text('未提供') : `${Math.round(w.usedPercent)}%`;
      const bar = w.usedPercent === null ? '' : UI.template`<progress class="usage-progress" max="100" value="${Math.min(100,Math.max(0,w.usedPercent))}" aria-label="${esc(name + ' ' + w.label + ' 使用率')}" aria-valuetext="${esc(pct)}"></progress>`;
      return UI.template`<div class="usage-window${expired ? ' usage-expired' : ''}"><div class="row"><b>${esc(UI.label(w.label))}</b><span class="usage-pct">${expired ? UI.text('前回の使用') : UI.text('使用')} <span class="usage-value${usagePercentClass(w.usedPercent)}">${esc(pct)}</span></span></div>${bar}<div class="small">リセット：${esc(usageDate(w.resetsAt))}<br>${esc(usageRemaining(w.resetsAt,now))}</div></div>`;
    }).join('')}${usageExtras(ai,p)}<p class="small">取得：${esc(usageDate(p.fetchedAt))}</p></section>`;
  }).join('');
}
function usageRefreshWait(now = Date.now()) {
  return Math.max(0,Math.ceil((Date.parse(usageData?.refreshAfter) - now) / 1000)) || 0;
}
function drawUsageControls() {
  const wait = usageRefreshWait();
  $('#usage-refresh').disabled = usageLoading || wait > 0;
  $('#usage-status').setAttribute('aria-live',wait > 0 && !usageLoading && !usageError && !usageClearError ? 'off' : 'polite');
  $('#usage-status').textContent = usageClearError || (usageLoading ? UI.text('確認中…') : usageError || (wait > 0 ? UI.template`${wait}秒後に再確認できます` : ''));
}
function drawUsage() {
  const drawer = $('#usage-drawer'), savedTop = drawer.scrollTop;
  const b = $('#usage-toggle'); if (!b) return;
  const now = Date.now();
  const summary = (compact, html = false, short = false) => usageError ? UI.text('利用状況 未取得') : usageData ? ['codex','claude'].filter(ai => usageData.providers?.[ai]).map(ai => usageSummary(ai,usageData.providers[ai],now,compact,html,short)).join(' / ') || UI.text('利用状況') : UI.text('利用状況');
  const full = summary(false);
  b.innerHTML = UI.template`<span>${summary(usageCompactMedia?.matches,true,true)}</span>`;
  b.setAttribute('aria-label', full + UI.text('。利用枠の使用率とリセット時期を見る'));
  b.setAttribute('title', full + UI.text('。利用枠の使用率とリセット時期を見る'));
  drawUsageControls();
  $('#usage-body').innerHTML = usageError ? UI.html('<p class="note">Hubに接続できませんでした。現在の利用状況は未取得です。</p>') : usageHtml(usageData);
  $('#usage-fable-clear')?.addEventListener('click',clearFableLimit);
  drawer.scrollTop = savedTop;
}
async function loadUsage(force = false) {
  if (usageLoading || document.hidden) return;
  if (force && usageRefreshWait() > 0) { drawUsageControls(); return; }
  const version = usageVersion;
  usageLoading = true; drawUsage();
  try {
    const loaded = await api(force ? '/api/usage/refresh' : '/api/usage' + (Object.keys(usageContext()).length ? '?' + new URLSearchParams(usageContext()) : ''), force ? usageContext() : undefined, {'X-Hub':'1'});
    if (version === usageVersion) usageData = loaded;
    if (version === usageVersion) usageError = '';
  } catch { if (version === usageVersion) usageError = UI.text('利用状況を取得できませんでした'); }
  finally { usageLoading = false; drawUsage(); if (version !== usageVersion) loadUsage(); }
}
async function clearFableLimit() {
  if (usageClearing || !confirm(UI.text('上限の保持を解除してFableに戻しますか？ 次の依頼で正式上限なら再びAstraへ切り替わります。'))) return;
  usageClearing = true; usageClearError = ''; drawUsage();
  const context = usageContext(), version = usageVersion;
  try {
    const cleared = await api('/api/limits/fable/clear', context, {'X-Hub':'1'});
    if (version === usageVersion) { usageVersion++; usageData = cleared; usageError = ''; }
  } catch { if (version === usageVersion) usageClearError = UI.text('解除を保存できませんでした'); }
  finally { usageClearing = false; drawUsage(); }
}
function closeUsage(restoreFocus = true) {
  $('#usage-drawer').hidden = true;
  $('#usage-toggle').setAttribute('aria-expanded','false');
  if (restoreFocus) $('#usage-toggle').focus({ preventScroll: true });
}
$('#usage-toggle').addEventListener('click', () => {
  if (!$('#usage-drawer').hidden) return closeUsage();
  $('#usage-drawer').hidden = false;
  $('#usage-toggle').setAttribute('aria-expanded','true');
  drawUsage(); $('#usage-close').focus({ preventScroll: true }); loadUsage();
});
$('#usage-close').addEventListener('click',closeUsage);
$('#usage-refresh').addEventListener('click',() => loadUsage(true));
document.addEventListener('click',e => {
  if (!$('#usage-drawer').hidden && !e.target.closest('#usage-drawer, #usage-toggle')) closeUsage(false);
},true);
document.addEventListener('keydown',e => { if (e.key === 'Escape' && !$('#usage-drawer').hidden) { e.preventDefault(); closeUsage(); } });
document.addEventListener('visibilitychange',() => { if (!document.hidden) loadUsage(); });
usageCompactMedia?.addEventListener('change',drawUsage);
setInterval(() => { if (!document.hidden) { drawUsage(); if (!usageError) loadUsage(); } },60000);
setInterval(() => { if (!document.hidden && !$('#usage-drawer').hidden) drawUsageControls(); },1000);
loadUsage();
