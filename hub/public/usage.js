'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// 全画面共通の利用枠表示。作業画面の再描画や入力には触れない。
let usageData = null, usageLoading = false, usageError = '', usageClearing = false, usageClearError = '', usageVersion = 0, usageContextKey = '';
const usageResetBusy = new Set(), usageResetMessages = new Map(), usageResetUncertain = new Set();
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
  return UI.template`あと${d ? d + UI.text('日') : ''}${h ? h + UI.text('時間') : ''}${m || !d && !h ? m + UI.text('分') : ''}`;
}
function usagePercentClass(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value >= 100 ? ' usage-limit' : value >= 90 ? ' usage-warning' : '';
}
// short は上の欄用。AIは既存アイコン、期間は7d/5hに縮める（読み上げ用は省かない）。
function usageSummary(ai, provider, now = Date.now(), compact = false, html = false, short = false) {
  const text = value => html ? esc(value) : value;
  const name = ai === 'codex' ? (compact ? 'CX' : 'Codex') : (compact ? 'CC' : 'Claude');
  const render = value => html && short ? UI.template`<span class="usage-provider">${usageIcon(ai)}<span class="usage-brief">${value}</span></span>` : text(name) + ' ' + value;
  if (!provider || provider.status !== 'ok') return render(text(UI.text('未取得')));
  if (Date.parse(provider.fetchedAt) + 6 * 60000 < now) return render(text(UI.text('前回の情報')));
  const windows = provider.windows.filter(w => !w.id.startsWith('model:')).slice(0,2);
  if ((!compact || short) && ai === 'claude') windows.push(...provider.windows.filter(w => w.id.startsWith('model:')));
  return render(windows.map(w => {
    let label = w.id.startsWith('model:') ? w.label.replace(/・週間枠$/, '') : w.label.replace(/枠$/, '');
    if (short && !w.id.startsWith('model:')) label = label.replace(/^週間$/, '7d').replace(/^(\d+)時間$/, '$1h');
    else if (compact) label = label.replace(/^週間$/, 'W').replace(/^(\d+)時間$/, '$1hr');
    if (compact && !short && ai === 'codex' && windows.length === 1 && label === 'W') label = '';
    if (!compact && w.resetsAt && Date.parse(w.resetsAt) <= now) return text(UI.template`${short ? label : w.label} 再確認待ち`.trim());
    const value = w.resetsAt && Date.parse(w.resetsAt) <= now ? UI.text('再確認待ち') : w.usedPercent === null ? UI.text('未提供') : Math.round(w.usedPercent) + '%';
    const rendered = html && value.endsWith('%') ? UI.template`<span class="usage-value${usagePercentClass(w.usedPercent)}">${esc(value)}</span>` : text(value);
    const part = `${label ? text(label) + ' ' : ''}${rendered}`;
    return html && short ? UI.template`<span class="usage-window-brief">${part}</span>` : part;
  }).join(compact || short ? ' ' : UI.text('・')));
}
// 図形は読み上げ・フォーカスの対象外。AI名は詳細と上部ボタンの読み上げ用ラベルに残す。
function usageIcon(ai) {
  return ai === 'codex'
    ? '<svg class="usage-icon usage-icon-codex" viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>'
    : '<svg class="usage-icon usage-icon-claude" viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M8 8L15.2 8.0M8 8L12.8 11.6M8 8L11.0 13.2M8 8L7.1 15.1M8 8L5.0 13.2M8 8L2.5 10.3M8 8L0.8 8.0M8 8L3.2 4.4M8 8L5.0 2.8M8 8L8.9 0.9M8 8L11.0 2.8M8 8L13.5 5.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
}
// Round only the label. Keep decimal strings exact, including balances above Number's integer range.
function usageCreditBalance(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || value.trim() !== value) return '';
  const [whole, fraction = ''] = value.split('.');
  const tenths = BigInt(whole) * 10n + BigInt(fraction[0] || '0') + (fraction[1] >= '5' ? 1n : 0n);
  return (tenths / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (tenths % 10n).toString();
}
function usageExtras(ai, provider, now = Date.now()) {
  if (ai === 'claude') return UI.html('<div class="usage-extras"><p>リセットチケットはClaudeの設定画面で確認・使用できます。</p><p><a class="btn plain usage-reset-link" href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">利用状況を開く</a></p><p class="small">ブラウザーのアカウントを確認してください。使用後はHubで再確認し、必要なら上限の保持を解除してください。</p></div>');
  if (ai !== 'codex') return '';
  const lines = [], reset = provider.resetCredits, credits = provider.credits;
  const account = provider.account || 'default', busy = usageResetBusy.has(account);
  const controls = [];
  const button = (action, title, expiresAt) => {
    if (!action?.token) return '';
    const expired = expiresAt && Date.parse(expiresAt) <= now;
    const stale = Date.parse(provider.fetchedAt) + 6 * 60000 < now;
    return UI.template`<p class="usage-reset-row"><span>${esc(title)}</span> <button class="btn plain" type="button" data-reset-account="${esc(account)}" data-reset-token="${esc(action.token)}" data-reset-retry="${action.retry === true}"${usageResetBusy.size || usageClearing || usageLoading || stale || expired || usageResetUncertain.has(action.token) ? ' disabled' : ''}>${UI.text(action.retry ? 'もう一度確認して使う' : '使う')}</button></p>`;
  };
  if (reset?.count > 0) {
    const details = (reset.items || []).map(item => UI.template`${item.title}・期限 ${usageDate(item.expiresAt)}`).join('／');
    lines.push(UI.template`リセットチケット：${reset.count}枚${details ? `（${details}）` : ''}`);
    for (const item of reset.items || []) {
      if (item.action) controls.push(button(item.action, item.title, item.expiresAt));
      else if (item.expiresAt && Date.parse(item.expiresAt) <= now) controls.push(UI.html('<p class="small">期限切れのチケットは使えません。</p>'));
    }
    if (reset.action) controls.push(button(reset.action, UI.text('無料チケットを1枚使う'), null));
  }
  if (credits) {
    if (credits.unlimited === true) lines.push(UI.text('クレジット残高：無制限'));
    else if (typeof credits.balance === 'string' && credits.balance.trim() === credits.balance && /^\d+(?:\.\d+)?$/.test(credits.balance)) {
      lines.push(UI.template`クレジット残高：${usageCreditBalance(credits.balance)}`);
    }
  }
  const message = busy ? UI.text('チケットの使用を確認中…') : usageResetMessages.get(account);
  return lines.length || message ? UI.template`<div class="usage-extras">${lines.map(line => UI.template`<p>${esc(line)}</p>`).join('')}${controls.join('')}${message ? UI.template`<p role="status">${esc(message)}</p>` : ''}</div>` : '';
}
function creditExceptionHtml(p,e){
  if(p.ai!=='codex'||(p.account||'default')!=='default')return '';
  const number=s=>typeof s==='string'&&/^\d+(?:\.\d{1,10})?$/.test(s)?usageCreditBalance(s):'';
  if(e?.state==='active')return UI.template`<p class="note">既存クレジットで継続中：残り ${esc(number(e.lastBalance))} ／ 開始 ${esc(number(e.startBalance))}（今回限り） <button type="button" data-credit-action="end"${usageClearing||usageResetBusy.size?' disabled':''}>例外を終える</button></p>`;
  if(e?.state==='ended'){
    const reason={exhausted:'残高を使い切りました','allowance-used':'許可した量を使い切りました',reset:'週間枠がリセットされました','cli-limit':'Codexから上限の応答がありました',manual:'手動で終了しました'};
    return UI.template`<p class="note">今回限りのクレジット例外は終了：${UI.text(reason[e.endReason]||'終了済み')}</p>`;
  }
  if(p.status==='ok'&&p.credits?.hasCredits!==false&&p.credits?.unlimited===false&&typeof p.credits.balance==='string'&&p.credits.balance.length<=80&&/^\d+(?:\.\d{1,10})?$/.test(p.credits.balance)){
    const [whole,fraction='']=p.credits.balance.split('.'),balance=BigInt(whole)*10n**10n+BigInt(fraction.padEnd(10,'0'));
    if(balance>0n&&balance<=62500n*10n**10n)return UI.template`<p class="note"><button type="button" data-credit-action="start" data-credit-balance="${esc(p.credits.balance)}"${usageClearing||usageResetBusy.size?' disabled':''}>既存クレジットで今回だけ続ける</button></p>`;
  }
  return '';
}
function usageHtml(data, now = Date.now()) {
  const state = data?.fableLimit;
  const held = state?.hold && (state.until === null || Date.parse(state.until) > now);
  const legacyNote = held ? UI.template`<p class="note">Fable 5.1 上限中・${state.until === null ? UI.text('解除日時不明・手動で解除するまで Astra') : esc(usageDate(state.until)) + UI.text('まで（自動で Astra へ）')} <button id="usage-fable-clear" type="button"${usageClearing ? ' disabled' : ''}>Fableに戻す</button></p>` : '';
  const limitNote = Array.isArray(data?.limits) ? data.limits.filter(e => e.hold && (e.until === null || Date.parse(e.until) > now)).map(e => UI.template`<p class="note">${esc(e.model)}・${esc(e.account)} ${UI.text('上限保持中')}${e.creditPriority === true ? '・' + UI.text('既存クレジットを優先中') : ''}・${e.until === null ? UI.text('解除日時不明') : esc(usageDate(e.until))} <button type="button" data-limit-ai="${esc(e.ai)}" data-limit-model="${esc(e.model)}" data-limit-account="${esc(e.account)}"${usageClearing ? ' disabled' : ''}>${UI.text('保持を解除')}</button></p>`).join('') + (data.limits.length ? UI.template`<p class="small">${data.limits.some(e => e.creditPriority === true) ? UI.text('クレジット優先中の担当は継続します。残高を確認できなくなったら保存した交代先へ、両側上限なら待機します。') : UI.text('保存した役割分担に従って交代します。両方が上限中なら待機します。')}</p>` : '') : legacyNote;
  const providers = Array.isArray(data?.accountProviders) ? data.accountProviders : Object.entries(data?.providers || {}).map(([ai,p]) => ({ ai, ...p }));
  if (!providers.length) return limitNote + UI.template`<p class="note">${data ? UI.text('表示できるログイン中のアカウントはありません。') : UI.text('確認中…')}</p>`;
  return limitNote + providers.map(p => {
    const ai = p.ai;
    const name = (ai === 'codex' ? 'Codex' : 'Claude') + (p?.accountName ? '・' + esc(p.accountName) : '');
    const heading = UI.template`<h3>${usageIcon(ai)}${name}${p.inUse ? UI.html('<span class="usage-current">使用中</span>') : ''}${p?.plan ? UI.template`<span class="usage-plan">${esc(p.plan)}</span>` : ''}</h3>`;
    const creditNote=creditExceptionHtml(p,data?.creditException);
    if (!p || p.status !== 'ok') return UI.template`<section class="card usage-card">${heading}<p>未取得</p><p class="note">${esc(p?.message || UI.text('確認中…'))}</p>${creditNote}${p?.attemptedAt ? UI.template`<p class="small">確認を試みた時刻：${esc(usageDate(p.attemptedAt))}</p>` : ''}${ai === 'claude' ? usageExtras(ai,p,now) : usageResetMessages.has(p.account || 'default') ? UI.template`<p role="status">${esc(usageResetMessages.get(p.account || 'default'))}</p>` : ''}</section>`;
    const old = Date.parse(p.fetchedAt) + 6 * 60000 < now;
    return UI.template`<section class="card usage-card">${heading}${old ? UI.html('<p class="note">前回取得した情報です。現在の状況を確認してください。</p>') : ''}${p.windows.map(w => {
      const expired = w.resetsAt && Date.parse(w.resetsAt) <= now;
      const pct = w.usedPercent === null ? UI.text('未提供') : `${Math.round(w.usedPercent)}%`;
      const bar = w.usedPercent === null ? '' : UI.template`<progress class="usage-progress" max="100" value="${Math.min(100,Math.max(0,w.usedPercent))}" aria-label="${esc(name + ' ' + w.label + UI.text(' 使用率'))}" aria-valuetext="${esc(pct)}"></progress>`;
      return UI.template`<div class="usage-window${expired ? ' usage-expired' : ''}"><div class="row"><b>${esc(UI.label(w.label))}</b><span class="usage-pct">${expired ? UI.text('前回の使用') : UI.text('使用')} <span class="usage-value${usagePercentClass(w.usedPercent)}">${esc(pct)}</span></span></div>${bar}<div class="small">リセット：${esc(usageDate(w.resetsAt))}<br>${esc(usageRemaining(w.resetsAt,now))}</div></div>`;
    }).join('')}${usageExtras(ai,p,now)}${creditNote}<p class="small">取得：${esc(usageDate(p.fetchedAt))}</p></section>`;
  }).join('');
}
function usageRefreshWait(now = Date.now()) {
  return Math.max(0,Math.ceil((Date.parse(usageData?.refreshAfter) - now) / 1000)) || 0;
}
function drawUsageControls() {
  const wait = usageRefreshWait();
  $('#usage-refresh').disabled = usageLoading || usageResetBusy.size > 0 || wait > 0;
  $('#usage-status').setAttribute('aria-live',wait > 0 && !usageLoading && !usageError && !usageClearError ? 'off' : 'polite');
  $('#usage-status').textContent = usageClearError || (usageLoading ? UI.text('確認中…') : usageError || (wait > 0 ? UI.template`${wait}秒後に再確認できます` : ''));
}
function drawUsage() {
  const drawer = $('#usage-drawer'), savedTop = drawer.scrollTop;
  const b = $('#usage-toggle'); if (!b) return;
  const now = Date.now();
  const summary = (compact, html = false, short = false) => usageError ? UI.text('利用状況 未取得') : usageData ? ['codex','claude'].filter(ai => usageData.providers?.[ai]).map(ai => usageSummary(ai,usageData.providers[ai],now,compact,html,short)).join(' / ') || UI.text('利用状況') : UI.text('利用状況');
  const full = summary(false);
  b.innerHTML = UI.template`<span class="usage-summary">${summary(usageCompactMedia?.matches,true,true)}</span>`;
  b.setAttribute('aria-label', full + UI.text('。利用枠の使用率とリセット時期を見る'));
  b.setAttribute('title', full + UI.text('。利用枠の使用率とリセット時期を見る'));
  drawUsageControls();
  $('#usage-body').innerHTML = usageError ? UI.html('<p class="note">Hubに接続できませんでした。現在の利用状況は未取得です。</p>') : usageHtml(usageData);
  $('#usage-fable-clear')?.addEventListener('click',clearFableLimit);
  document.querySelectorAll?.('[data-limit-model]').forEach(button => button.addEventListener('click', () => clearModelLimit(button.dataset)));
  document.querySelectorAll?.('[data-credit-action]').forEach(button=>button.addEventListener('click',()=>changeCreditException(button.dataset)));
  document.querySelectorAll?.('[data-reset-token]').forEach(button => button.addEventListener('click', () => useResetTicket(button.dataset)));
  drawer.scrollTop = savedTop;
}
async function changeCreditException(data){
  if(usageClearing||usageResetBusy.size)return;
  const ending=data.creditAction==='end';
  if(!confirm(UI.text(ending?'今回限りのクレジット例外を終了しますか？':'既存クレジットを今回だけ使用しますか？ 追加購入や自動課金は行いません。')))return;
  const version=usageVersion;usageClearing=true;usageClearError='';drawUsage();
  try{
    const loaded=await api('/api/limits/credit-exception'+(ending?'/end':''),{...usageContext(),ai:'codex',account:'default',confirm:true,expectedBalance:data.creditBalance},{'X-Hub':'1'});
    if(version===usageVersion){usageVersion++;usageData=loaded;usageError='';}
  }catch(e){if(version===usageVersion)usageClearError=e.message;}
  finally{usageClearing=false;drawUsage();}
}
async function loadUsage(force = false) {
  if (usageLoading || usageResetBusy.size || document.hidden) return;
  if (!force && typeof chatHistoryPending === 'function' && chatHistoryPending()) return;
  if (force && usageRefreshWait() > 0) { drawUsageControls(); return; }
  const version = usageVersion;
  usageLoading = true; drawUsage();
  try {
    const loaded = await api(force ? '/api/usage/refresh' : '/api/usage' + (Object.keys(usageContext()).length ? '?' + new URLSearchParams(usageContext()) : ''), force ? usageContext() : undefined, {'X-Hub':'1'});
    if (version === usageVersion) { usageData = loaded; usageResetUncertain.clear(); }
    if (version === usageVersion) usageError = '';
  } catch { if (version === usageVersion) usageError = UI.text('利用状況を取得できませんでした'); }
  finally { usageLoading = false; drawUsage(); if (version !== usageVersion) loadUsage(); }
}
async function useResetTicket(data) {
  const account = data.resetAccount, token = data.resetToken, retry = data.resetRetry === 'true';
  if (usageLoading || usageClearing || usageResetBusy.size || usageResetUncertain.has(token)) return;
  const providers = usageData?.accountProviders || Object.entries(usageData?.providers || {}).map(([ai,p]) => ({ ai,...p }));
  const provider = providers.find(p => p.ai === 'codex' && (p.account || 'default') === account);
  const name = provider?.accountName || account;
  const prompt = retry ? UI.template`Codex・${name}：前の使用結果が不明です。同じ受付番号でもう一度確認しますか？ 二重には使用しません。`
    : UI.template`Codex・${name}：無料のリセットチケットを1枚使いますか？ 使用すると元に戻せません。`;
  if (!provider || !confirm(prompt)) return;
  const version = ++usageVersion, context = usageContext();
  usageResetBusy.add(account); usageResetMessages.delete(account); drawUsage();
  try {
    const result = await api('/api/usage/reset', { ...context, ai:'codex', account, token, confirmed:true, retry }, {'X-Hub':'1'});
    if (version !== usageVersion) return;
    usageVersion++; usageData = result.usage; usageError = '';
    const messages = { reset:UI.text('リセットしました。利用状況を再確認しました。'), nothingToReset:UI.text('今はリセット不要です。チケットは使用していません。'),
      noCredit:UI.text('使用できるチケットがありません。'), alreadyRedeemed:UI.text('このチケットはすでに使用されています。') };
    usageResetMessages.set(account, result.message || messages[result.outcome] || UI.text('使用結果が不明です。利用状況を再確認してください'));
  } catch {
    usageResetUncertain.add(token);
    if (version === usageVersion) usageResetMessages.set(account, UI.text('使用結果を確認できませんでした。自動では送り直しません。利用状況を再確認してください。'));
  } finally { usageResetBusy.delete(account); drawUsage(); }
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
async function clearModelLimit(data) {
  if (usageClearing || !confirm(UI.text('このモデルの上限保持を解除しますか？ 新しい100%情報または正式上限を確認すると再び保持します。'))) return;
  usageClearing = true; usageClearError = ''; drawUsage();
  const version = usageVersion;
  try {
    const cleared = await api('/api/limits/clear', { ...usageContext(), ai: data.limitAi, model: data.limitModel, account: data.limitAccount }, {'X-Hub':'1'});
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
