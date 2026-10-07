'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
// 設定と非公開リポジトリ作成。送信は確認画面の明示選択のみ。
let githubDraft = null, githubPending = false, githubEpoch = 0, githubSettingsEpoch = 0;
const githubOptions = (list, selected) => list.map(v => UI.template`<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
async function loadGithub(fresh = false) {
  const box = $('#github-box'); if (!box) return;
  const epoch = ++githubSettingsEpoch;
  try {
    const r = await api('/api/github' + (fresh ? '?fresh=1' : ''));
    if ($('#github-box') !== box || epoch !== githubSettingsEpoch) return;
    const account = r.accounts.some(a => a.login === r.settings.account) ? r.settings.account : r.accounts.find(a => a.active)?.login || r.accounts[0]?.login || '';
    const command = r.gh ? 'gh auth login --hostname github.com --web --git-protocol https' : 'brew install gh';
    box.innerHTML = UI.template`${r.error ? UI.template`<p>${esc(r.error)}</p>` : ''}${r.accounts.length ? UI.template`<label>ふだん使うアカウント<select id="github-account">${githubOptions(r.accounts.map(a => a.login), account)}</select></label>
      <label>作る場所（既定）<select id="github-owner">${githubOptions([...new Set([account, ...(account === r.settings.account && r.settings.owner ? [r.settings.owner] : [])])], account === r.settings.account ? r.settings.owner || account : account)}</select></label>
      <div class="acts"><button class="btn plain" data-github-setting="owners" type="button">組織を読み込む</button><button class="btn" data-github-setting="save" type="button">GitHubの設定を保存</button></div>` : ''}
      <p>${r.gh ? UI.text('新しくログインする時は、Macのターミナルで次を実行してください。') : UI.text('MacのターミナルでGitHubの道具を入れてください。')}</p>
      <code>${esc(command)}</code><button class="cp" data-copy="${esc(command)}" type="button" aria-label="コマンドをコピー">⧉ コピー</button>
      <p class="small">Hub は合言葉（トークン）を保存しません。操作のたびに gh のログインを使います。HubからMac全体の既定アカウントは変えません。</p>
      <button class="btn plain" data-github-setting="refresh" type="button">もう一度確かめる</button><p id="github-settings-status" role="status"></p>`;
  } catch (e) { if ($('#github-box') === box && epoch === githubSettingsEpoch) box.textContent = e.message; }
}
function githubSheetClose() {
  if (githubPending) return;
  githubEpoch++; githubDraft = null;
  if ($('#github-sheet')) $('#github-sheet').hidden = true;
}
function githubValidate() {
  if (!githubDraft || !$('#github-create')) return;
  const n = $('#github-name').value;
  const valid = /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..';
  $('#github-name-error').textContent = valid ? '' : UI.text('名前は英数字・ハイフン・アンダースコア・ピリオドで1〜100文字にしてください');
  $('#github-create').disabled = githubPending || !valid || githubDraft.blockers.length > 0 || !$('#github-create-account').value;
  $('#github-push-notice').hidden = !$('#github-push').checked;
}
function drawGithubCreate(d) {
  $('#github-sheet').innerHTML = UI.template`<div class="remove-box github-box"><h2 id="github-title">GitHub に非公開のリポジトリを作る</h2>
    <p>送る元：<span class="path">${esc(d.folder)}</span></p>${d.ledger ? UI.html('<p>台帳のフォルダです。.ai などAIの記録も含まれます。</p>') : ''}
    ${d.blockers.map(b => UI.template`<p class="danger">${esc(b)}</p>`).join('')}
    <label>アカウント<select id="github-create-account">${githubOptions(d.accounts.map(a => a.login), d.defaultAccount)}</select></label>
    <label>作る場所<select id="github-create-owner">${githubOptions([...new Set([d.defaultAccount, d.defaultOwner].filter(Boolean))], d.defaultOwner)}</select></label>
    <button class="btn plain" data-github-action="owners" type="button">組織を読み込む</button>
    <label>名前<input id="github-name" value="${esc(d.suggestedName)}" maxlength="100" autocomplete="off"></label><p id="github-name-error" class="danger"></p>
    <label>説明（任意）<input id="github-description" maxlength="1000"></label>
    <p>公開範囲：<b>非公開（自分と招待した人だけ）</b></p><p class="small">公開にする時は別途相談してください。</p>
    <label class="chk"><input id="github-push" type="checkbox" ${d.canPush ? '' : 'disabled'}> 作った後、今の保存（${esc(d.branch || UI.text('まだ送れる保存がありません'))}・${d.commits}件）を送る</label>
    <div id="github-push-notice" hidden>${d.dirty ? UI.html('<p>未保存の変更は送られません（保存済みの分だけ送ります）。</p>') : ''}${d.risky.map(r => UI.template`<p class="danger">${esc(r.file)}：${esc(r.reason)}</p>`).join('')}</div>
    ${d.git === 'none' ? UI.html('<p>このフォルダで Git の保存を始めます。初回送信は行いません。</p>') : ''}
    ${d.remotes.length ? UI.template`<p class="small">登録済みの送り先：${d.remotes.map(esc).join('、')}</p>` : ''}
    <p id="github-result" role="status"></p><div class="acts"><button class="btn plain" data-github-action="close" type="button">やめる</button><button class="btn" id="github-create" data-github-action="create" type="button">作る</button></div></div>`;
  githubValidate(); $('#github-name').focus?.();
}
async function openGithubCreate(projectId) {
  if (githubPending) return;
  const epoch = ++githubEpoch;
  if (!$('#github-sheet')) document.body.insertAdjacentHTML('beforeend', '<div id="github-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-labelledby="github-title"></div>');
  const sheet = $('#github-sheet'); sheet.hidden = false;
  sheet.innerHTML = UI.html('<div class="remove-box"><h2 id="github-title">GitHub に非公開のリポジトリを作る</h2><p>確認しています…</p><button class="btn plain" data-github-action="close" type="button">閉じる</button></div>');
  try { const d = await api('/api/github/preview', { project: projectId }); if (epoch !== githubEpoch) return; githubDraft = d; drawGithubCreate(d); }
  catch (e) { if (epoch === githubEpoch) sheet.innerHTML = UI.template`<div class="remove-box"><h2 id="github-title">GitHub の確認</h2><p class="danger">${esc(e.message)}</p><button class="btn plain" data-github-action="close" type="button">閉じる</button></div>`; }
}
document.addEventListener('input', e => { if (e.target.id === 'github-name') githubValidate(); });
document.addEventListener('change', e => {
  if (e.target.id === 'github-push') githubValidate();
  if (e.target.id === 'github-create-account' || e.target.id === 'github-account') {
    const target = e.target.id === 'github-account' ? '#github-owner' : '#github-create-owner';
    $(target).innerHTML = githubOptions([e.target.value], e.target.value);
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') githubSheetClose(); });
document.addEventListener('click', async e => {
  const open = e.target.closest?.('[data-github-create]');
  if (open && !open.disabled) return openGithubCreate(open.dataset.githubCreate);
  if (e.target.id === 'github-sheet') return githubSheetClose();
  const setting = e.target.closest?.('[data-github-setting]');
  if (setting && !setting.disabled) {
    const box = $('#github-box'), account = $('#github-account')?.value;
    setting.disabled = true;
    try {
      if (setting.dataset.githubSetting === 'refresh') { await loadGithub(true); await load(); }
      else if (setting.dataset.githubSetting === 'owners') { const r = await api('/api/github/owners', { account }); if ($('#github-box') === box && $('#github-account').value === account) $('#github-owner').innerHTML = githubOptions(r.owners, $('#github-owner').value); }
      else { await api('/api/github', { account, owner: $('#github-owner').value }); if ($('#github-box') === box) $('#github-settings-status').textContent = UI.text('GitHubの設定を保存しました'); }
    } catch (err) { if ($('#github-box') === box) $('#github-settings-status').textContent = err.message; }
    finally { setting.disabled = false; }
    return;
  }
  const b = e.target.closest?.('[data-github-action]'); if (!b || b.disabled || githubPending) return;
  if (b.dataset.githubAction === 'close') return githubSheetClose();
  if (!githubDraft) return;
  if (b.dataset.githubAction === 'owners') {
    const epoch = githubEpoch, account = $('#github-create-account').value; b.disabled = true;
    try { const r = await api('/api/github/owners', { account }); if (epoch === githubEpoch && $('#github-create-account').value === account) $('#github-create-owner').innerHTML = githubOptions(r.owners, $('#github-create-owner').value); }
    catch (err) { if (epoch === githubEpoch) $('#github-result').textContent = err.message; }
    finally { b.disabled = false; } return;
  }
  if (b.dataset.githubAction !== 'create') return;
  const d = githubDraft;
  const input = { project: d.project, account: $('#github-create-account').value, owner: $('#github-create-owner').value, name: $('#github-name').value, description: $('#github-description').value, push: $('#github-push').checked, expectedHead: d.head, expectedBranch: d.branch, confirm: true };
  githubPending = true; b.disabled = true; b.textContent = UI.text('作成中…');
  // 作成中は入力も閉じる操作も無効にする。
  const controls = [...$('#github-sheet').querySelectorAll('input,select,button')]; const wasDisabled = controls.map(c => c.disabled); controls.forEach(c => { c.disabled = true; });
  try {
    const r = await api('/api/github/create', input);
    if (r.ok || r.partial) {
      $('#github-result').innerHTML = UI.template`<p class="${r.partial ? 'dirty' : 'saved'}">${esc(r.message)}${r.ok ? `：${esc(r.url)}${r.pushed ? UI.text('（保存を送りました）') : UI.text('（保存は送っていません）')}` : ''}</p>${r.url ? UI.template`<button class="btn plain" data-url="${esc(r.url)}" type="button">GitHub で開く</button>` : ''}<button class="btn plain" data-github-action="close" type="button">閉じる</button>`;
      githubDraft = null; await load();
    } else $('#github-result').textContent = r.message;
  } catch (err) { $('#github-result').textContent = err.message; }
  finally {
    githubPending = false;
    if (githubDraft) { controls.forEach((c, i) => { c.disabled = wasDisabled[i]; }); b.textContent = UI.text('作る'); githubValidate(); }
    else { $('#github-sheet').querySelectorAll('[data-github-action="close"]').forEach(c => { c.disabled = false; }); }
  }
});
