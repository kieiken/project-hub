'use strict';
// Classic-script declarations only. Shared state and startup stay in app.js.
// See README.md for the loading and state contract.

function preserveSettingsScroll(update) {
  const before = view.kind === 'settings' ? $('#main .settings')?.parentElement : null;
  const position = before ? { top: before.scrollTop, left: before.scrollLeft } : null;
  const result = update();
  const after = view.kind === 'settings' ? $('#main .settings')?.parentElement : null;
  if (position && after) { after.scrollTop = position.top; after.scrollLeft = position.left; }
  return result;
}

function aiSettingsInputKey(input) {
  const row = input.closest('[data-account-row]');
  return input.matches('[data-account-name]') ? `account:${row.dataset.ai}:${row.dataset.id}` : input.id;
}

function preserveAiSettings(update) {
  if (aiSettingsDrawing) return update();
  const before = $('#ai-use-settings'), focused = before?.contains(document.activeElement) ? document.activeElement : null;
  if (before) {
    aiSettingsOpen.clear();
    before.querySelectorAll('details[data-ai-fold][open]').forEach(el => aiSettingsOpen.add(el.dataset.aiFold));
    before.querySelectorAll('#account-new-ai,#account-new-name,[data-account-name]').forEach(el => aiSettingsInputs.set(aiSettingsInputKey(el), el.value));
  }
  const focus = focused ? { id: focused.id, key: focused.matches('[data-account-name]') ? aiSettingsInputKey(focused) : '', start: focused.selectionStart, end: focused.selectionEnd } : null;
  return preserveSettingsScroll(() => {
    aiSettingsDrawing = true;
    try { return update(); }
    finally {
      aiSettingsDrawing = false;
      const after = $('#ai-use-settings');
      after?.querySelectorAll('details[data-ai-fold]').forEach(el => { el.open = aiSettingsOpen.has(el.dataset.aiFold); });
      after?.querySelectorAll('#account-new-ai,#account-new-name,[data-account-name]').forEach(el => { const value = aiSettingsInputs.get(aiSettingsInputKey(el)); if (value !== undefined) el.value = value; });
      const target = focus && (focus.id ? document.getElementById(focus.id) : [...(after?.querySelectorAll('[data-account-name]') || [])].find(el => aiSettingsInputKey(el) === focus.key));
      if (target && !target.disabled) { target.focus({ preventScroll: true }); if (focus.start !== null && typeof target.setSelectionRange === 'function') target.setSelectionRange(focus.start, focus.end); }
    }
  });
}

function stopResultText(r){
  const states={exited:'終了を確認',alive:'停止できていません', 'ownership-unknown':'所有を確認できず停止未確認','not-started':'開始前に保留','external-unconfirmed':'外部サービスの終了は未確認',failed:'停止に失敗'};
  return `${r.project?`${r.project}／${r.task||'作業未確認'}・`:''}${r.label||'AI'}：${states[r.state]||'未確認'}／${r.save==='saved'?'結果を保存済み':'結果の保存は未確認'}${r.errors?.length?'\n'+r.errors.join('\n'):''}`;
}

function drawEmergencyStatus(s){const box=$('#emergency-status');if(!box)return;
  box.textContent=[s.stopping?'停止処理中です。':s.paused?'AIの開始を保留しています。':'AIの開始は許可されています。',s.persistence==='unconfirmed'?`停止状態の保存は未確認です：${s.error}`:'',s.restart?.reason||'',...(s.tasks||[]).map(t=>`${t.project}／${t.task}：${t.autoHeld&&!t.held?'待ち指示と自動開始は保留中。新しい送信は可能':'保留中'}`),...(s.results||[]).map(stopResultText),...(s.errors||[])].filter(Boolean).join('\n');
  const stop=$('[data-ai-emergency]');if(stop)stop.disabled=Boolean(s.stopping||['stopping','waiting','committed'].includes(s.restart?.phase));
  const resume=$('[data-ai-resume]');if(resume)resume.disabled=Boolean(!s.paused||s.stopping||['stopping','waiting','committed'].includes(s.restart?.phase)||(s.results||[]).some(r=>['alive','ownership-unknown','failed'].includes(r.state)));
}

async function refreshEmergencyStatus(){if(!$('#emergency-status'))return;try{drawEmergencyStatus(await api('/api/ai/stop/status'));}catch(e){$('#emergency-status').textContent=`停止状態を確認できません：${e.message}`;}}

function selectSettingsTab(tab) {
  settingsTab = Object.hasOwn(SETTINGS_TABS, tab) ? tab : 'basic';
  localStorage.setItem('hub.settingsTab', settingsTab);
  const dirty = rolesDirty();
  document.querySelectorAll('[data-settings-tab]').forEach(button => {
    const selected = button.dataset.settingsTab === settingsTab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    const label = SETTINGS_TABS[button.dataset.settingsTab];
    button.textContent = label + (button.dataset.settingsTab === 'ai' && dirty ? ' •' : '');
    button.setAttribute('aria-label', label + (button.dataset.settingsTab === 'ai' && dirty ? UI.text(' 未保存あり') : ''));
  });
  document.querySelectorAll('.settings > [data-tab]').forEach(card => { card.hidden = card.dataset.tab !== settingsTab; });
  autoCheckRoleAccounts();
}

function languageRestartMessage(saved = false) {
  if (state.windowsStorage) return UI.text(saved ? '保存しました。Hub を終了して開き直すと切り替わります。' : 'Hub を終了して開き直すと切り替わります。');
  return UI.text(saved ? '保存しました。Hub を再起動すると切り替わります。Mac アプリのメニューは、アプリを開き直した時に切り替わります。' : 'Hub を再起動すると切り替わります。Mac アプリのメニューは、アプリを開き直した時に切り替わります。');
}

function licensePurchaseHtml() {
  if ((state.license?.supported === false || state.license?.activationAvailable === false) || state.license?.edition !== 'public' || state.license.purchased || !state.license?.purchaseUrl) return '';
  try {
    const url = new URL(state.license.purchaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return UI.template`<div class="license-purchase" data-license-purchase-guide>
      <p>買い切りで、購入した版の全機能を期限なしで使えます。</p>
      ${state.license.introAvailable
        ? UI.html('<button type="button" class="btn" data-license-intro>体験中の特別価格で購入（1,100円・税込）</button>')
        : UI.template`<button type="button" class="btn" data-license-purchase data-url="${url.href}">購入する（4,900円・税込）</button>`}
      <p class="small">支払い画面はブラウザで開きます。支払い後に表示される利用コードをコピーし、この画面の［お持ちの利用コード］に貼り付けて［登録する］を押してください。すでに支払い済みの場合は、再購入せずコードを登録してください。</p>
    </div>`;
  } catch { return ''; }
}

function rolesSaveStatus() {
  return roleAssignmentsDirty() && creditsDirty() ? UI.text('役割分担とクレジットに変更があります（まだ保存していません）') : rolesDirty() ? UI.text('変更があります（まだ保存していません）') : UI.text('保存済み');
}

function creditSettingsHtml() {
  const dirty = rolesDirty();
  return UI.template`<section class="ai-use-section ai-credit-settings"><div class="ai-option-line"><h3>クレジット</h3><span class="small">確認する：</span>
    <label class="chk"><input type="checkbox" data-check-credits="claude" ${checkCreditsDraft.claude ? 'checked' : ''}> Claude</label>
    <label class="chk"><input type="checkbox" data-check-credits="codex" ${checkCreditsDraft.codex ? 'checked' : ''}> Codex</label>${creditsDirty() ? UI.html('<span class="dirty" role="status">未保存</span>') : ''}</div>
    <label class="chk"><input type="checkbox" data-prefer-credits ${preferCreditsDraft ? 'checked' : ''}> 上限後も既存クレジットで続ける（確認ONのAIだけ）</label>
    <div class="ai-option-line"><span class="small">購入・自動チャージはしません。</span><details class="more" data-ai-fold="credits-help"><summary>詳しく</summary><div class="ai-detail-body">
      <p class="small">初期設定は両方OFFです。ONのAIだけ送信前にクレジット情報を確認します。OFFでも通常の利用枠の確認と利用状況の表示は続けます。</p>
      <p class="small">確認だけでは有料の継続利用を許可しません。Claudeの月間追加利用枠は、実際の残高とは異なります。</p>
      <p class="small">継続の許可は初期設定OFFです。ONにすると、確認ONのAIだけ、利用枠の上限後も利用可能と確認できた既存クレジットで元の担当を継続します。OFFにするまで許可が続きます。</p>
      <p class="small">自動チャージがない、またはOFFであることを確認してから保存してください。購入・自動チャージ・APIキー課金は行いません。残高が不明・古い・取得失敗なら設定された交代先へ切り替えます。正式な実行拒否は維持します。Claudeの実残高を取得できない場合も交代します。</p>
    </div></details></div>
    <div class="acts ai-save-actions"><button class="btn" type="button" data-roles-save ${dirty ? '' : 'disabled'}>役割分担・クレジットを保存</button>
      <span class="${dirty ? 'dirty' : 'saved'}" role="status">${rolesSaveStatus()}</span></div></section>`;
}

function renderSettings() {
  return preserveAiSettings(() => {
    if (!rolesDraft) { rolesDraft = JSON.parse(JSON.stringify(state.roles.roles)); rolesDraftRevision = state.roles.management?.revision; }
    if (!checkCreditsDraft) checkCreditsDraft = creditCheckSettings();
    if (preferCreditsDraft === null) preferCreditsDraft = state.roles.preferCredits === true;
    const models = state.roles.models;
    const opt = (list, v) => list.map(x => UI.template`<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const cell = (i, k, s) => UI.template`<div class="cfg">
        <select data-r="${i}" data-k="${k}" data-f="ai" aria-label="AI">${roleAiOptions(s.ai)}</select>
        ${s.ai === '人' ? '' : UI.template`<select data-r="${i}" data-k="${k}" data-f="model" aria-label="モデル">${roleModelOptions(s.ai,s.model)}</select>
        <select data-r="${i}" data-k="${k}" data-f="effort" aria-label="思考" ${effortHidden(s.ai) ? 'hidden' : ''} ${s.ai === 'agy' ? 'disabled' : ''}>${opt(effortsFor(s.ai), s.effort)}</select>`}</div>`;
    const dirty = rolesDirty(), purchase = licensePurchaseHtml();
    $('#main').innerHTML = UI.template`<div class="view settings-view"><div class="settings">
      <div class="settings-tabs" role="tablist" aria-label="設定">${Object.entries(SETTINGS_TABS).map(([key, label]) => UI.template`<button type="button" role="tab" data-settings-tab="${key}">${label}</button>`).join('')}</div>
      <section class="pref-section" data-tab="recovery"><h2 class="pref-caption">AIの緊急停止</h2><div class="pref-list recovery-card">
        <div data-handoff-status>${chatHandoffHtml()}</div>
        <div class="pref-row pref-stack"><div class="pref-text"><p>停止が効かない時は、Hubが起動したAIをすべて停止します。待ち指示と自動開始も保留します。会話と保存済み成果は残ります。停止・保存を確認できたらHubを一度再起動し、AIは保留したまま画面へ戻ります。</p></div>
          <button type="button" class="btn emergency-stop" data-ai-emergency><span aria-hidden="true">■</span> すべてのAIを緊急停止</button></div>
        <div class="pref-row pref-stack"><p id="emergency-status" role="status" aria-live="polite">停止状態を確認中…</p>
          <div class="buttons"><button class="btn plain" type="button" data-ai-stop-refresh>状態を確認</button><button class="btn" type="button" data-ai-resume disabled>AIの開始を再び許可</button></div>
          <p class="small">強制終了まで数秒かかる場合があります。所有を確認できないAIへは信号を送りません。外部サービスの生成終了は別に確認が必要です。Hub自体が応答しない場合、このボタンも動きません。</p></div>
      </div></section>
      ${state.windowsStorage ? UI.template`<section class="pref-section" data-tab="basic"><h2 class="pref-caption">Windowsの保存</h2><p class="small">${esc(state.windowsStorage)}</p></section>` : ''}
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">表示</h2><div class="pref-list">
        <label class="pref-row"><span class="pref-text"><span class="pref-name">作業のフェーズと進捗を表示する</span><span class="pref-desc">オフにすると、すべての作業画面で隠します。このブラウザに保存されます。オンにすると再び表示します。</span></span>
          <input type="checkbox" class="pref-switch" id="set-work-progress" ${showWorkProgress() ? 'checked' : ''}></label>
        <div class="pref-row"><div class="pref-text"><h3>配色</h3><p>初期設定はダークです。選んだ配色はこのブラウザに保存されます。</p></div>
          <div class="pref-control"><div class="theme-choices pref-seg" role="group" aria-label="配色">
            <button type="button" class="theme-choice" data-theme-choice="dark" aria-pressed="${(window.HubTheme?.current() || 'dark') === 'dark'}">ダーク</button>
            <button type="button" class="theme-choice" data-theme-choice="light" aria-pressed="${window.HubTheme?.current() === 'light'}">ライト</button>
          </div></div></div>
        <div class="pref-row"><div class="pref-text"><h3>言語</h3><p>${languageRestartMessage()}</p></div>
          <div id="language-box" class="pref-contents" aria-live="polite">${languageSettings ? languageSettingsHtml(languageSettings) : UI.text('確認中…')}</div></div>
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">会話</h2><div class="pref-list">
        <label class="pref-row"><span class="pref-text"><span class="pref-name">コマンドなど、AI の細かい作業も会話に出す</span><span class="pref-desc">作業中の印と返事、大事な知らせはいつも出ます。</span></span>
          <input type="checkbox" class="pref-switch" id="set-detail" ${showDetail() ? 'checked' : ''}></label>
        <label class="pref-row"><span class="pref-text"><span class="pref-name">Enter だけで送る</span><span class="pref-desc">改行は Shift + Enter。オフにすると ⌘ + Enter で送ります。</span></span>
          <input type="checkbox" class="pref-switch" id="set-enter" ${enterSends() ? 'checked' : ''}></label>
        <div class="pref-row pref-stack"><div class="pref-text"><h3>新しく始めるときのAI</h3><p>新しい作業の初期値です。既存の作業は変わりません。</p></div>
          <div id="initial-pick">${initialPickHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">利用コード</h2><div class="pref-list">
        ${state.license?.edition === 'owner' || (state.license?.supported === false || state.license?.activationAvailable === false) ? '' : UI.html('<form id="license-form" class="pref-row">')}${state.license?.edition === 'owner' || (state.license?.supported === false || state.license?.activationAvailable === false) ? UI.html('<div class="pref-row">') : ''}
          <div class="pref-text"><span class="pref-name" role="status">${esc(state.license?.edition === 'owner' ? '製作者版：鍵不要・全機能・期限なし' : state.license?.reason || '利用権を確認中です')}</span>
          ${state.license?.edition !== 'owner' && state.license?.trial?.expiry ? UI.template`<p data-trial-dates>無料体験：${new Date(state.license.trial.startsAt * 1000).toLocaleString('ja-JP')} 〜 ${new Date(state.license.trial.expiry * 1000).toLocaleString('ja-JP')}（残り ${state.license.trial.remainingDays} 日）</p>` : ''}</div>
        ${state.license?.edition === 'owner' || (state.license?.supported === false || state.license?.activationAvailable === false) ? UI.html('</div>') : UI.html('<div class="pref-control"><label class="pref-sr" for="license-code">お持ちの利用コード</label><input id="license-code" type="password" autocomplete="off" maxlength="256" required placeholder="お持ちの利用コード"><button class="btn" type="submit">登録する</button></div><p id="license-notice" role="status"></p></form>')}
        ${purchase ? `<div class="pref-row pref-stack">${purchase}</div>` : ''}
      </div></section>
      <section class="pref-section" data-tab="basic"><h2 class="pref-caption">はじめに・引っ越し</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><h3>はじめの設定</h3><p>AIの導入・ログイン・確認を順に案内します。</p></div>
          <div class="pref-control"><button class="btn plain" type="button" data-onboarding-open>開く</button></div></div>
        <div class="pref-row"><div class="pref-text"><h3>会話とターミナルの使い分け</h3><p>普段は［会話］、AIの画面を直接操作したいときは［ターミナル］。</p>
          <details class="pref-more"><summary>どちらを使う？</summary>
            <h4>会話が向いているとき</h4>
            <ul><li>相談する、質問する、作業をお願いする</li><li>前に決めたことを踏まえて続けたい</li><li>別のAIへ引き継ぎたい</li></ul>
            <p>やり取りがHubに残り、別のAIにも背景を渡しやすい窓口です。自由対話（freetalk）もこちらです。添付や確認結果などは、引き継いだAIが必要に応じて改めて確認します。</p>
            <h4>ターミナルが向いているとき</h4>
            <ul><li>AIの画面を見ながら直接操作したい</li><li>同じAIと細かい指示を何度もやり取りしたい</li></ul>
            <p>起動しているAIに直接指示する窓口です。その場で続けるのに向いていますが、やり取りはHubの会話履歴には入りません。</p>
            <p><strong>画面を切り替えても、もう片方のAIは止まりません。</strong>会話とターミナルは別々に動きます。同じ作業への指示は、どちらか一方にまとめると混乱を防げます。</p>
          </details></div></div>
        <div class="pref-row"><div class="pref-text"><h3>引っ越し</h3><p>別のMacへ移す時に使います。同じMacなら、データを残してアプリを入れ直すだけで使えます。</p>
          <label class="chk pref-check"><input type="checkbox" id="move-backups"> 過去のバックアップも含める</label>
          <details class="pref-more"><summary>詳しく</summary>
            <p>別のMacへは、作ったフォルダを「書類」の「ProjectHub-Move」に置き、対応するアプリを起動してください。会話・添付・プロジェクトを読み込みます。</p>
            <p>AIのログイン情報と利用コードは移しません。新しいMacで登録してください。作業中・順番待ち・未保存の変更がある場合は作成できません。</p>
          </details></div>
          <div class="pref-control"><button type="button" class="btn plain" id="move-export">引っ越し用データを作る</button></div>
          <div id="move-status" aria-live="polite"></div></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">役割分担</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="role-settings-controls">${roleSettingsHtml()}</div></div>
        <div class="pref-row pref-stack"><div class="role-head"><p class="pref-desc">役割ごとの担当と、上限の時の担当です。</p><div class="acts"><span id="role-account-status" class="small" role="status"></span><button id="role-account-check" class="btn plain sm" type="button">もう一度確認</button></div></div>
        <div class="tbl role-table"><table><tr><th>役割</th><th>いつもの担当</th><th>上限の時</th><th>内容</th></tr>
        ${rolesDraft.map((r, i) => UI.template`<tr><td class="now">${esc(UI.label(r.name))}</td><td class="role-main" data-label="いつもの担当">${cell(i, 'main', r.main)}</td><td class="role-backup" data-label="上限の時">${cell(i, 'backup', r.backup)}</td><td class="job" title="${esc(UI.label(r.job))}">${esc(UI.label(r.job))}</td></tr>`).join('')}</table></div></div>
        <div class="pref-row pref-stack"><div class="acts ai-save-actions"><button class="btn" id="roles-save" type="button" ${dirty ? '' : 'disabled'}>役割分担・クレジットを保存</button>
          <button class="btn plain" id="roles-reset" type="button" ${dirty ? '' : 'disabled'}>元に戻す</button>
          <span class="${dirty ? 'dirty' : 'saved'}" role="status">${rolesSaveStatus()}</span></div>
        <details class="more"><summary>詳しく</summary><p class="small">保存した設定は次の起動・上限時の交代に反映します。交代先も上限ならいつもの担当へ、両方が上限なら待機します。</p><p class="small"><span id="model-catalog">選べるモデル：Claude Code は ${esc((models['claude-code'] || []).join(' / '))}、Codex は ${esc((models.codex || []).join(' / '))}、Grok は ${esc((models.grok || []).join(' / '))}（思考は中・高・極高・MAX）、Gemini（Agy CLI）は取得したモデル一覧から選択・思考「高」。思考は ${esc(state.efforts.join(' → '))}。</span>保存先 <span class="path">${esc(state.root)}/_hub/roles.yaml</span></p></details></div>
      </div></section>
      <section class="pref-section ai-use-settings" data-tab="ai" id="ai-use-settings"><h2 class="pref-caption">AIの利用設定</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="ai-accounts"></div></div>
        <div class="pref-row pref-stack"><section class="ai-use-section"><div class="ai-option-line"><h3>特殊モード</h3><div id="special-mode" class="ai-option-line">${specialModeHtml()}</div><details class="more" data-ai-fold="special-help"><summary>詳しく</summary><div class="ai-detail-body"><p class="small">リセット前やリセットチケットを使うとき、選んだAIに作業を集中します。</p><p class="small">今回の依頼にAI・モデルの直接指定がなければ、選んだAIを使い続けます。同じAI内のモデルはAIに任せます。人が指定・選択した依頼の後は特殊モードへ戻ります。通常の役割分担は保存したままです。</p><p class="small">次の依頼から反映します。作業中のAIや受付済みの待ち指示は変わりません。上限時は別のAIへ自動交代せず待機します。</p></div></details></div></section></div>
        <div class="pref-row pref-stack">${creditSettingsHtml()}</div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">選ぶ欄に出すモデル</h2><div class="pref-list">
        <div class="pref-row pref-stack"><p class="pref-desc">選ぶ欄に出すモデルと順番です。</p>
        <div id="model-order-list">${modelOrderHtml()}</div>
        <details class="more"><summary>並べ方・整理</summary>      <p>上から順に、会話などのモデルを選ぶ欄に並びます。［↑］［↓］で順番を変えられます。パソコンでは左の印をドラッグしても動かせます。役割の担当と今の選択は変わりません。</p>
        <div class="acts" style="margin-top:10px"><button class="btn plain" id="models-tidy" type="button">最新のモデルに整理する</button>
          <span class="small">役割で使っている古いモデル名（6sol など）を、同じ系統の一番新しいモデルに置き換え、roles.yaml の一覧も今のものにします。</span></div>
        <div id="tidy-result" class="small"></div></details></div>
        <div class="pref-row pref-stack"><details class="more"><summary>上級：CLIに渡すモデル名</summary>
        <p>画面のモデルの呼び名を、Claude Code・Codex が受け付ける名前に直します。<b>空にすると、モデルを指定せず CLI の既定のモデルを使います。</b>モデル名が拒否された場合は理由を表示し、設定を勝手に変えません。</p>
        <div id="climodels" class="small">読み込み中…</div></details></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">AI の更新</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="ai-tools" aria-live="polite">確認中…</div></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">スキル</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><p>このパソコンで各AIの既定の置き場所に見つかったスキルです。有効・無効は判定しません。</p></div><div class="pref-control"><button class="btn plain sm" id="skills-check" type="button">もう一度確認</button></div></div>
        <div class="pref-row pref-stack"><div id="skills-box" aria-live="polite">${skillsHtml()}</div>
        <details class="more"><summary>詳しく</summary><p class="small">CLI内蔵・プラグイン・同期分・作業フォルダ内・追加アカウントのスキルは含みません。Codexの付属スキルは「付属」と表示します。</p>
        <p class="small">作業で実際に使ったスキルは、各作業画面の「使ったスキル」に記録されます。</p></details></div>
      </div></section>
      <section class="pref-section" data-tab="ai"><h2 class="pref-caption">Codex の加速（Fast）</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><p>ONにしても自動では加速しません。作業画面のCodex欄で作業ごとに選びます。</p><p class="danger"><strong>速度約1.5倍・利用枠の消耗2.5倍</strong></p></div>
        <div id="acceleration" aria-live="polite">確認中…</div>
        <details class="more"><summary>詳しく</summary><p class="small">速度は一部モデルの目安で、モデルや状況で変わります。Claude Codeは対象外です。次の会話・ターミナル起動から反映します。OFFにすると全作業で加速しません。作業ごとの選択は残り、再びONにすると戻ります。</p></details></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">iPhone から使う</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>外から使う（iPhone）</h3><p>iPhoneからMacと同じ操作ができます。</p></div>
        <div id="remote-box" aria-live="polite">確認中…</div>
        <details class="more"><summary>使い始める手順</summary><ol class="small">
          <li>Mac と iPhone に Tailscale を入れ、同じアカウントでログインします。</li>
          <li><div>Mac のターミナルで <code>tailscale serve --bg 4545</code><button type="button" class="cp" data-copy="tailscale serve --bg 4545" title="コピー" aria-label="コピー">⧉ コピー</button> を1回だけ実行します。</div></li>
          <li>ここで合言葉（8文字以上）を保存し、「外から使う」をオンにします。</li>
          <li><div>iPhone の Safari で、上の「iPhone で開くアドレス」を開き、合言葉を入れます。<br>アドレスが出ていない時は、Mac のターミナルで <code>tailscale serve status</code><button type="button" class="cp" data-copy="tailscale serve status" title="コピー" aria-label="コピー">⧉ コピー</button> を実行します。1行目の <code>https://〜.ts.net</code> が開くアドレスです。</div></li>
          <li>共有メニューの「ホーム画面に追加」で、アプリのように開けます。</li></ol></details></div>
        <div class="pref-row pref-stack"><div class="pref-text"><h3>スマホの表示</h3><p>スマホの会話で出すAIの名前です。</p></div>
        <div id="phone-labels">${phoneLabelsHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">Muse連携</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="muse-settings-box" aria-live="polite">状態を確認中…</div></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">GitHub</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div id="github-box" aria-live="polite">確認中…</div></div>
      </div></section>
      <section class="pref-section" data-tab="connect"><h2 class="pref-caption">Mac</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>Mac のファイルの許可</h3><p>Hubが書類などのフォルダを読めるか確かめます。</p></div>
        <details class="more"><summary>詳しく</summary><p class="small">書類・デスクトップ・ダウンロードのフォルダを、Project Hub が読めるか確かめます。「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」に Project Hub が無い時は、［確認をもう一度出す］を押し、Mac の確認で「許可」を選んでください。</p></details>
        ${/ProjectHubApp/.test(navigator.userAgent) ? UI.template`<div class="acts"><a class="btn plain" href="hubapp://access">許可を確かめる</a><a class="btn" href="hubapp://access?reset=1">確認をもう一度出す</a></div>
        <details class="more"><summary>許可が出ない時</summary><p class="small">それでも出ない時は、確かめた後の画面の［フルディスクアクセスを開く］から、Project Hub をリストに入れてオンにしてください（アプリのメニューからも同じことができます）。</p></details>`
          : UI.html('<p class="small">アプリ（Project Hub.app）で開いた時に使えます。アプリが古い時は、ターミナルで <code>bash hub/app/build-app.sh</code> を実行して作り直してください。</p>')}</div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">更新とバージョン</h2><div class="pref-list">
        <div class="pref-row pref-stack"><div class="pref-text"><h3>Project Hub の自動更新</h3></div><div id="app-update-box" aria-live="polite">確認中…</div></div>
        <div class="pref-row"><div class="pref-text"><h3>バージョン</h3><p>稼働：<b>v${esc(state.version || '')}</b> ／ 本体保存済み：<b>v${esc(state.saved?.version || state.latest || '')}</b>${state.latest && state.latest !== state.version ? UI.template`（新しい版 v${esc(state.latest)} を取り込み済み。上の［Update］で切り替わります）` : ''}</p></div><div class="pref-control">${hubUpdateButton()}</div>
        <details class="more" id="verd" ${verOpen ? 'open' : ''}><summary>変更の記録</summary><div id="verbox" class="small">読み込み中…</div></details></div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">作業</h2><div class="pref-list">
        <div class="pref-row"><div class="pref-text"><h3>作業画面</h3><p><span class="badge ${state.terminal ? '' : 'off'}"><i></i>${state.terminal ? UI.text('画面の中で Claude Code / Codex / Agy CLI を動かせます') : UI.text('部品（node-pty）が未設定です。ターミナルで setup.sh を実行してください。それまでは別の窓で開きます')}</span></p></div>
        <details class="more"><summary>詳しく</summary><p class="small">権限：Claude Code は <code>${esc(state.roles.permissions['claude-code'] || '')}</code>、Codex は <code>${esc(state.roles.permissions.codex || '')}</code></p></details></div>
        <div class="pref-row"><div class="pref-text"><h3>空の作業を片付ける</h3><p>会話が空の作業を探して、まとめてゴミ箱へ移します。</p></div><div class="pref-control"><button class="btn plain" data-act="emptyscan" type="button">探す</button></div>
        <details class="more"><summary>詳しく</summary><p class="small">最初から選ばれるのは、派生・子プロジェクトで「やったこと」も空の作業だけです。</p></details>
        <div id="empty-box">${emptyHtml()}</div></div>
      </div></section>
      <section class="pref-section" data-tab="manage"><h2 class="pref-caption">記録</h2><div class="pref-list">
        <div class="pref-row pref-stack"><details class="more" id="logd"><summary>最近の操作（記録）</summary><div id="logbox" class="small">読み込み中…</div></details></div>
      </div></section>
    </div></div>`;
    selectSettingsTab(settingsTab);void refreshEmergencyStatus();
    renderedPhoneKey = phoneSettingsKey();
    drawAccountSettings(); syncRoleAccountChoices();
    $('#role-account-check')?.addEventListener('click', () => checkRoleAccounts().catch(() => {}));
    drawAiTools(); loadAiTools(); loadSkills(); $('#skills-check').addEventListener('click', () => loadSkills(true)); if (typeof loadAppUpdate === 'function') loadAppUpdate();
    loadCliModels(); loadRemote(); if (typeof loadGithub === 'function') loadGithub();
    loadLanguageSettings();
    loadMoveSettings();
    void loadMuseSettings();
  });
}

function museUsageHtml(result = {}) {
  const errors = { auth: 'ログイン期限切れ', site_changed: 'Museのサイトが変わりました', network: '通信できませんでした', format: '応答の形式が違います', unconfigured: 'ログイン情報が未設定です', busy: '確認中です' };
  const u = result.usage;
  const date = value => value ? new Date(value).toLocaleString('ja-JP') : '未取得';
  if (!u) return UI.template`<p>利用枠：未取得${result.error ? '（' + (errors[result.error] || '確認できませんでした') + '）' : ''}</p>`;
  return UI.template`<p><strong>${esc(u.plan || 'プラン未取得')}</strong> · 今週の使用率 ${esc(u.usedPercent)}%</p>
    <p class="small">リセット：${esc(date(u.resetsAt))}${u.tokensLeftLabel ? ' · 残り ' + esc(u.tokensLeftLabel) : ''}</p>
    ${u.topup ? UI.template`<p class="small">追加分（週の枠とは別）：${esc(u.topup.label)} · ${esc(u.topup.value)}</p>` : ''}
    <p class="small">確認：${esc(date(u.checkedAt))}${u.renewsAt ? ' · 契約更新：' + esc(date(u.renewsAt)) : ''}</p>`;
}

function museSettingsHtml(s) {
  if (!s.supported) return UI.text('Museのログイン情報の登録は、Macで開いたHubから利用できます。');
  const registration = !s.toolReady ? '状態を確認できません' : s.configured ? '接続済み（ログインの有効性は未確認）' : '未設定';
  const contexts = typeof state !== 'undefined' && Array.isArray(state.projects) ? state.projects.flatMap(p =>
    (p.tasks || []).map(t => ({ project: p.id, task: t.id, label: (p.name || p.id) + ' / ' + (t.title || t.id) }))) : [];
  return UI.template`<div class="muse-summary"><h3>${esc(registration)}</h3>
    <div id="muse-usage-box" role="status">${museUsageHtml(s)}</div>
    <button class="btn" type="button" data-muse-unavailable="${!s.configured || s.busy ? '1' : '0'}" data-muse-action="usage" ${!s.configured || s.busy || museUsageBusy ? 'disabled' : ''}>${museUsageBusy ? '利用枠を確認中…' : '利用枠を確認'}</button>
    <p class="small">登録済みのMuseに利用状況だけを問い合わせます。質問は送りません。</p>
    <p>会話の送り先一覧で［Muse］を選び、質問を書いて送ります。</p>
    <p>10分以降の回答の自動確認：${s.replySettings?.extendedAutoRead?'オン':'オフ'}。オンにすると送信から15分・30分・60分ごろにも最大3回、同じ回答だけを確認します。</p>
    <button class="btn plain" type="button" data-muse-action="reply-auto" data-enabled="${s.replySettings?.extendedAutoRead?'1':'0'}">${s.replySettings?.extendedAutoRead?'10分以降の自動確認をオフにする':'10分以降の自動確認をオンにする'}</button>
    ${s.toolReady && !s.configured ? UI.template`<button class="btn" type="button" data-muse-action="register" ${s.busy ? 'disabled' : ''}>ログイン情報を登録</button>` : ''}
    ${!s.toolReady ? UI.html('<div class="buttons"><button class="btn plain" type="button" data-muse-action="refresh">状態を確認</button><button class="btn plain" type="button" data-muse-action="tool">接続ツールを選ぶ</button></div>') : ''}
    ${s.busy ? UI.html('<p role="status">前回の操作が進行中、または終了を確認できません。登録情報は変更せず停止しています。</p>') : ''}</div>
    <details class="muse-details"><summary>詳細設定</summary>
    <p class="small">非公式CLIを使います。Cookieは会話や設定画面に貼らず、本人用ターミナルの非表示欄だけに入力してください。登録情報はこのMacの私用領域に平文で保存します。</p>
    <div class="buttons"><a class="btn plain" href="https://muse.ai" target="_blank" rel="noopener noreferrer">Muse公式サイトを開く</a>
      ${s.existingAvailable ? UI.html('<button class="btn" type="button" data-muse-action="existing">導入済みツールを使う</button>') : ''}
      <button class="btn plain" type="button" data-muse-action="tool">接続ツールを選ぶ</button>
      <button class="btn plain" type="button" data-muse-action="refresh">状態を確認</button>
      ${s.toolReady && s.configured ? UI.template`<button class="btn plain" type="button" data-muse-action="update" ${s.busy ? 'disabled' : ''}>ログイン情報を更新</button><button class="btn plain" type="button" data-muse-action="disconnect" ${s.busy ? 'disabled' : ''}>このMacの登録を解除</button>` : ''}</div>
    ${s.toolReady && contexts.length ? UI.template`<h3>作業ごとの許可・導入・復旧</h3>
      <label>対象の作業 <select id="muse-workspace-context">${contexts.map(c => UI.template`<option value="${esc(JSON.stringify({ project: c.project, task: c.task }))}"${c.project === 'Project Hub' && c.task === '20260926-hub-v2' ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <div class="buttons"><button class="btn plain" type="button" data-muse-action="permits">この作業の許可一覧</button><button class="btn plain" type="button" data-muse-action="manage">承認・許可・追加認証を管理</button></div>
      <p>AIが相談を準備した時は、同じ作業の会話に出る確認カードで承認します。本人用ターミナルは許可の取消・追加認証・導入や復旧に使います。Facebook収集・投稿は準備中です。</p><div id="muse-workspace-permits" role="status"></div>` : ''}
    <p class="small">会話の［返答を確認］と［送信前の状態を照合］は必要な時に表示されます。結果不明の質問は送り直しません。利用枠はサイトの内部機能で取得するため、サイト更新で取得できなくなることがあります。自動取得・課金・プラン変更は行いません。</p></details>
    <p id="muse-settings-notice" role="status"></p>`;
}

async function loadMuseSettings() {
  const box = $('#muse-settings-box'); if (!box) return;
  const epoch = ++museSettingsEpoch;
  try {
    const s = await api('/api/muse', null, { 'X-Hub': '1' });
    if (epoch === museSettingsEpoch && $('#muse-settings-box') === box) box.innerHTML = museSettingsHtml(s);
  } catch {
    if (epoch === museSettingsEpoch && $('#muse-settings-box') === box) box.innerHTML = UI.html('<p>状態を安全に確認できませんでした。再登録せず、接続ツールを確認してください。</p><button class="btn plain" type="button" data-muse-action="tool">接続ツールを選ぶ</button><button class="btn plain" type="button" data-muse-action="refresh">状態を確認</button><p id="muse-settings-notice" role="status"></p>');
  }
}

async function handleMuseSettingsClick(event) {
  const button = event.target.closest('[data-muse-action]'); if (!button || button.disabled) return;
  const action = button.dataset.museAction;
  if(action==='reply-auto') {
    const enabled=button.dataset.enabled!=='1';
    if(!confirm(UI.text(enabled?'送信済みの質問について、15分・30分・60分ごろに最大3回、回答だけを自動で確認します。追加の読み取り許可を発行します。オンにしますか？':'10分以降の回答の自動確認をオフにしますか？')))return;
    button.disabled=true;
    try{await api('/api/muse/reply-settings',{extendedAutoRead:enabled,confirm:true});await loadMuseSettings();}
    catch{toast(UI.text('回答の自動確認設定を保存できませんでした。'));button.disabled=false;}
    return;
  }
  if (action === 'usage') {
    if (museUsageBusy) return;
    museUsageBusy = true;
    const owner = $('#muse-settings-box'), box = $('#muse-usage-box');
    const epoch = museSettingsEpoch;
    button.disabled = true; button.textContent = UI.text('利用枠を確認中…');
    if (box) box.textContent = UI.text('利用枠を確認中…');
    let result;
    try { result = await api('/api/muse/usage', { confirm: true }); }
    catch (e) { result = { error: ['auth','site_changed','network','format','unconfigured','busy'].includes(e.message) ? e.message : 'network' }; }
    finally { museUsageBusy = false; }
    if ($('#muse-settings-box') === owner && museSettingsEpoch === epoch && $('#muse-usage-box') === box) {
      if (box) box.innerHTML = museUsageHtml(result);
    }
    const current = $('#muse-settings-box')?.querySelector?.('[data-muse-action="usage"]');
    button.disabled = false; button.textContent = UI.text('利用枠を確認');
    if (current) { current.disabled = current.dataset.museUnavailable === '1'; current.textContent = UI.text('利用枠を確認'); }
    return;
  }
  if (action === 'refresh') { await loadMuseSettings(); return; }
  const messages = {
    register: '本人用ターミナルを開き、ログイン情報を通信なしで保存します。非公式CLIの規約リスクと平文保存を了承して進めますか？',
    update: '本人用ターミナルで新しいログイン情報に置き換えます。相談の送信は行いません。ターミナルを開きますか？',
    disconnect: 'このMacに保存したMuseのログイン情報を削除します。過去の送信記録は残し、Muse側ではログアウトしません。本人確認用ターミナルを開きますか？',
  };
  button.disabled = true;
  try {
    if (action === 'permits' || action === 'manage') {
      const selected = $('#muse-workspace-context'); if (!selected) return;
      const contextValue = selected.value;
      const owner = $('#muse-settings-box');
      const context = JSON.parse(contextValue);
      if (action === 'manage' && !confirm(UI.text('選んだ作業の本人用ターミナルを開きます。ここでは承認・送信・認証の変更は行いません。進めますか？'))) return;
      const result = await api('/api/muse/workspace', { project: context.project, task: context.task, action, confirm: true });
      if ($('#muse-settings-box') !== owner || $('#muse-workspace-context') !== selected || selected.value !== contextValue) return;
      if (action === 'permits') {
        const box = $('#muse-workspace-permits');
        if (box && $('#muse-workspace-context')?.value === selected.value) box.textContent = result.permits.length ? result.permits.map(p =>
          `${p.target}${p.account ? ' / ' + p.account : ''}・${p.kind}・期限 ${p.expiresAt}・残り ${p.remaining} 回${p.revoked ? '・取消済み' : ''}`).join('\n') : UI.text('この作業の許可はありません。');
      } else {
        const notice = $('#muse-settings-notice'); if (notice) notice.textContent = UI.text(result.notice);
      }
    } else if (action === 'existing') {
      if (!confirm(UI.text('導入済みの固定版ツールを使い、保存済みの登録状態を確認します。再登録や通信は行いません。進めますか？'))) return;
      await api('/api/muse/tool', { useExisting: true, confirm: true });
      await loadMuseSettings();
    } else if (action === 'tool') {
      const picked = await api('/api/pick-folder', { prompt: UI.text('導入済みの metamuse-local-20261024 フォルダを選んでください') });
      if (!picked.path || !confirm(UI.text('選んだフォルダの固定版を確認し、Museの接続ツールとして使います。ログイン情報は移動せず、通信しません。進めますか？'))) return;
      await api('/api/muse/tool', { folder: picked.path, confirm: true });
      await loadMuseSettings();
    } else if (messages[action] && confirm(UI.text(messages[action]))) {
      const result = await api('/api/muse/terminal', { action, confirm: true });
      const notice = $('#muse-settings-notice'); if (notice) notice.textContent = UI.text(result.notice);
    }
  } catch {
    const notice = $('#muse-settings-notice'); if (notice) notice.textContent = UI.text('操作を開始できませんでした。自動でやり直さず、状態と接続ツールを確認してください。');
  } finally { button.disabled = false; }
}

function appSettingsMuseCallback() { return handleMuseSettingsClick; }

function moveSettingsHtml(s) {
  const messages = { none: '', exporting: '引っ越し用データを作成中…', exported: '引っ越し用データを作りました', importing: '引っ越しデータを読み込み中…', failed: '引っ越しを止めました', imported: '引っ越しデータを読み込みました', conflict: '読み込み先に既にデータがあります。アプリを開き直して読み込み方法を選んでください' };
  return UI.template`<p role="status">${esc(s.error || s.notice || messages[s.mode] || '')}${s.mode === 'exporting' ? esc(' ' + (s.progress || 0) + ' 件') : ''}</p>
    ${s.path ? `<p class="small">${esc(s.path)}</p><button class="btn plain" type="button" id="move-reveal">Finderで表示</button>` : ''}
    ${s.mode === 'imported' && s.bundle ? '<button class="btn plain" type="button" id="move-trash">読み込み済みの引っ越しデータをゴミ箱へ</button>' : ''}
    ${s.totals ? `<p class="small">${esc(s.totals.files)} ファイル・${esc(Math.ceil(s.totals.bytes / 1024 / 1024))} MB</p>` : ''}
    ${(s.notIncluded || []).length ? `<details><summary>含めなかったもの</summary><ul>${s.notIncluded.map(e => `<li>${esc(e.path)}：${esc(e.reason)}</li>`).join('')}</ul></details>` : ''}
    ${(s.attention || []).length ? `<p>確認が必要なリポジトリがあります。設定を確認してから作業を再開してください。</p><ul>${s.attention.map(e => `<li>${esc(e.path)}：${esc(e.reason)}</li>`).join('')}</ul>` : ''}`;
}

async function loadMoveSettings() {
  clearTimeout(moveSettingsTimer);
  const box = $('#move-status'), button = $('#move-export'); if (!box || !button) return;
  try {
    const s = await api('/api/move/status', null, { 'X-Hub': '1' });
    if ($('#move-status') !== box) return;
    box.innerHTML = moveSettingsHtml(s); button.disabled = s.mode === 'exporting';
    button.onclick = async () => {
      button.disabled = true;
      try { await api('/api/move/export', { includeBackups: $('#move-backups')?.checked === true }); await loadMoveSettings(); }
      catch (e) { box.textContent = e.message; button.disabled = false; }
    };
    $('#move-reveal')?.addEventListener('click', () => api('/api/move/reveal', {}).catch(e => toast(e.message)));
    $('#move-trash')?.addEventListener('click', async () => {
      if (!confirm(UI.text('読み込みが済んだ引っ越し用フォルダをゴミ箱へ移します。今使っているデータは残ります。進めますか？'))) return;
      try { await api('/api/move/trash', { bundle: s.bundle, confirm: true }); await loadMoveSettings(); } catch (e) { toast(e.message); }
    });
    if (s.mode === 'exporting') moveSettingsTimer = setTimeout(loadMoveSettings, 1000);
  } catch (e) { box.textContent = e.message; }
}

function languageSettingsHtml(settings) {
  const choices = settings.packs.filter(pack => pack.usable).filter((pack, index, rows) => rows.findIndex(row => row.id === pack.id) === index);
  const chosen = languageDraft ?? settings.saved;
  const selected = chosen === 'ja' || choices.some(pack => pack.id === chosen) ? chosen : 'ja';
  return UI.template`<div class="pref-control"><select id="language-choice" aria-label="表示言語" ${languageBusy ? 'disabled' : ''}>
    <option value="ja" ${selected === 'ja' ? 'selected' : ''}>日本語（標準）</option>
    ${choices.map(pack => `<option value="${esc(pack.id)}" ${selected === pack.id ? 'selected' : ''}>${esc(pack.name)}</option>`).join('')}</select>
    <button type="button" class="btn plain" data-language="save" ${languageBusy ? 'disabled' : ''}>保存する</button></div>
    ${settings.fallback ? UI.html('<p class="note">選んだ言語パックが読めないため、日本語で表示しています。</p>') : ''}
    <details class="pref-more"><summary>言語パック</summary>
    <ul class="pref-packs">${settings.packs.map(pack => UI.template`<li><span class="pref-pack-name"><b>${esc(pack.name)}</b> <span class="small">${esc(pack.id)}・${pack.source === 'installed' ? UI.text('追加済み') : pack.source === 'external' ? UI.text('起動時に指定') : UI.text('本体同梱')}</span></span>
      ${pack.source === 'installed' ? UI.template`<button class="btn plain sm" type="button" data-language="remove" data-pack-id="${esc(pack.id)}" ${languageBusy ? 'disabled' : ''}>削除</button>` : ''}
      ${pack.reason ? `<p class="small">${esc(UI.text(pack.reason))}</p>` : ''}
      ${pack.verifiedWith && pack.verifiedWith !== settings.version ? UI.template`<p class="small">v${esc(pack.verifiedWith)} で確認されたパックです。今の版と違うため、一部が日本語で表示されることがあります。</p>` : ''}</li>`).join('')}</ul>
    <div class="pref-packs-add"><button type="button" class="btn plain sm" data-language="import" ${languageBusy ? 'disabled' : ''}>言語パックを追加…</button><span class="small">展開した言語パックのフォルダを選んで追加できます。</span></div>
    </details>
    <p id="language-notice" role="status" class="small">${esc(languageNotice)}</p>
    ${settings.restartNeeded ? UI.template`<div class="pref-actions"><button type="button" class="btn" data-language="restart" ${languageBusy ? 'disabled' : ''}>今すぐ再起動</button></div>` : ''}`;
}

function drawLanguageSettings() {
  const box = $('#language-box');
  if (box && languageSettings) {
    const open = box.querySelector('details')?.open === true;
    box.innerHTML = languageSettingsHtml(languageSettings);
    const details = box.querySelector('details');
    if (details) details.open = open;
  }
}

async function loadLanguageSettings() {
  const box = $('#language-box'); if (!box || languageBusy) return;
  const epoch = ++languageLoadEpoch;
  try {
    const result = await api('/api/langpacks');
    if ($('#language-box') !== box || languageBusy || epoch !== languageLoadEpoch) return;
    languageSettings = result; drawLanguageSettings();
  } catch (error) { if ($('#language-box') === box && epoch === languageLoadEpoch) box.textContent = error.status === 403 ? UI.text('言語の設定はこのパソコンから操作してください。') : error.message; }
}

async function applyLanguageRestart() {
  await api('/api/restart', {});
  languageNotice = UI.text('再起動しています…'); drawLanguageSettings();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const result = await api('/api/langpacks');
      if (!result.restartNeeded) { location.reload(); return; }
    } catch { /* 本体の再起動を待つ */ }
  }
  throw Error(UI.text('切り替わりませんでした。アプリを開き直してください'));
}

function chatgptConnectionHelpHtml() {
  const command = (label, text) => UI.template`<div class="codeblock"><div class="cb-head"><span>${esc(UI.text(label))}</span><button type="button" class="cb-copy">⧉ コピー</button></div><pre><code>${esc(text)}</code></pre></div>`;
  return UI.template`<details class="more chatgpt-connection-help" id="chatgpt-connection-help" data-ai-fold="mcp-help">
    <summary>つなぎ方・動作確認</summary>
    <p class="small">この許可はHubのMCPに接続したAIに適用されます。Hub内のChatGPT（Chat／Pro）は、この会話に文字で返答します。普段のChatGPTアプリからのMac・Hub操作は、下の中継の案内を確認してください。</p>
    <p class="small">普段のChatGPTアプリ → OpenAIの中継 → このMacの中継プログラム → Hub、という経路でつながります。Mac・Hub・中継プログラムが動いている間だけ使えます。</p>
    <p class="small"><b>「登録済み」や「実作業もできる」がオンでも、中継が今動いているとは限りません。</b>CodexのMac内の接続で成功しても、普段のChatGPT画面から使えるかは別に確かめます。</p>
    <h3>いま動いているか確かめる</h3>
    <ol class="small">
      <li>下の確認用コマンドをコピーし、Macのターミナルに貼り付けて実行します。鍵の入力は不要で、このMac内の状態だけを読み取ります。</li>
      <li>「中継は準備完了（ready）」なら中継の準備はできています。「停止中」なら下の起動方法へ進みます。動作中でも準備完了にならない場合は、起動したターミナルのエラーを確かめてください。</li>
      <li>普段のChatGPTで新しいチャットを開き、「Project Hub」を使う接続に選び、下の確認文を送ります。実際の道具の呼び出しが成功して一覧が返るところまで確かめてください。</li>
    </ol>
    ${command('Macの中継を確認（起動や設定変更はしません）', CHATGPT_TUNNEL_CHECK)}
    ${command('普段のChatGPTへ送る確認文', UI.text('Project Hubの道具を使って、プロジェクト一覧を取得してください。実際の呼び出しが成功したか、エラーが出たかも教えてください。'))}
    <p class="small">readyは中継の準備状況です。ChatGPTからの成功は、その画面での実際の呼び出しで判断します。書き込みも使う場合は、公開された道具に「hub_write_file」「hub_run_command」があることと、上の実作業許可がオンであることを確かめます。読み取り成功だけでは書き込み成功までは確認できません。</p>
    <h3>中継が止まっている時の起動方法</h3>
    <ol class="small">
      <li>Hubを起動したままにします。中継がすでに動作中なら、重ねて起動しないでください。</li>
      <li>中継用の鍵を用意します。鍵が必要な場合は、<a href="#" data-url="https://platform.openai.com/settings/organization/tunnels">OpenAIの中継設定</a>で既存のProject Hub用の接続を確認し、<a href="#" data-url="https://platform.openai.com/settings/organization/api-keys">鍵の設定</a>で本人が用意します。権限を選べる場合は「Tunnels」の「Read」「Use」に限定します。</li>
      <li>下の起動用コマンドをターミナルに貼り付けます。「中継用の鍵を貼り付けて Enter:」と出てから鍵を入力します。入力文字は表示されず、コマンド履歴や設定ファイルにも保存しません。</li>
      <li>診断が成功すると中継が動き続けます。このターミナルの窓は開いたままにしてください。終了・Macの再起動で中継が止まったら、次に使う時に起動し直します。</li>
      <li>上の稼働確認を行います。ChatGPTの道具一覧が古い場合は、ChatGPT側の既存の「Project Hub」の接続で、更新・再接続の項目を確認してから新しいチャットで試します。</li>
    </ol>
    ${command('停止中の中継を起動（鍵は表示後に本人が入力）', CHATGPT_TUNNEL_START)}
    <p class="small">鍵をこの会話・Hubの入力欄・起動コマンドの中に貼らないでください。料金条件は確認できていません。支払い登録・購入・入金を求められたら進めず、追加課金・API従量課金は使いません。失敗した時はエラーの文章を控え、原因を直してから確認します。</p>
    <p class="small"><a href="#" data-url="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels">OpenAI公式の中継ガイド</a></p>
  </details>`;
}

function gptChildLink(project, task) {
  return UI.template`<p><button type="button" class="btn plain sm" data-go="work" data-p="${esc(project)}" data-t="${esc(task)}">GPT子を開く</button></p>`;
}

async function loadChatgpt() {
  const box = $('#chatgpt-box'); if (!box) return;
  const epoch = ++chatgptLoadEpoch;
  try {
    const r = await api('/api/chatgpt');
    if ($('#chatgpt-box') !== box || epoch !== chatgptLoadEpoch) return;
    const work = chatgptWorkPending === null ? r.work : chatgptWorkPending;
    preserveSettingsScroll(() => {
      box.innerHTML = UI.template`<label class="chk"><input type="checkbox" id="chatgpt-work" ${work ? 'checked' : ''} ${chatgptWorkPending === null ? '' : 'disabled'}> 実作業も許可（ファイル変更・コマンド）</label>`;
      $('#chatgpt-mcp-status').textContent = work ? UI.text('実作業可') : UI.text('読み取りのみ');
    });
  } catch (e) { if ($('#chatgpt-box') === box && epoch === chatgptLoadEpoch) { box.textContent = UI.text('読み込めませんでした'); $('#chatgpt-mcp-status').textContent = UI.text('取得失敗'); } }
}

async function loadRemote() {
  const box = $('#remote-box'); if (!box) return;
  try {
    const r = await api('/api/remote');
    if ($('#remote-box') !== box) return;
    box.innerHTML = UI.template`<label class="chk"><input type="checkbox" id="remote-on" ${r.enabled ? 'checked' : ''} ${r.hasPasscode ? '' : 'disabled'}> 外から使う${r.hasPasscode ? '' : UI.text('（先に合言葉を保存してください）')}</label>
      <div class="acts" style="margin-top:8px"><input type="password" id="remote-pass" autocomplete="new-password" minlength="8" maxlength="200" placeholder="${r.hasPasscode ? UI.text('新しい合言葉（8文字以上）') : UI.text('合言葉（8文字以上）')}">
        <button class="btn plain" id="remote-pass-save" type="button">合言葉を保存</button></div>
      <p class="small">${r.hasPasscode ? UI.text('合言葉は保存済みです。変えると、入っている端末はすべて出ます。') : UI.text('まだ合言葉がありません。')}</p>
      <p>iPhone で開くアドレス：${r.url ? UI.template`<b>${esc(r.url)}</b><button type="button" class="cp" data-copy="${esc(r.url)}" title="コピー" aria-label="コピー">⧉ コピー</button>` : UI.html('<span class="small">見つかりません（Tailscale が動いていないか、Mac に入っていません。下の「使い始める手順」を見てください）</span>')}</p>
      <div class="acts"><button class="btn plain" id="remote-enrollment" type="button">新しい端末用コードを発行</button><button class="btn plain" id="remote-forget-devices" type="button">信頼済み端末の印を取り消す</button></div><p id="remote-enrollment-code" class="small" role="status"></p>
      <div class="acts"><span>ログイン中の端末：${r.sessions.length} 台</span>
        <button class="btn plain" id="remote-logout-all" type="button" ${r.sessions.length ? '' : 'disabled'}>すべての端末から出る</button></div>
`;
  } catch (e) { if ($('#remote-box') === box) box.textContent = UI.text('読み込めませんでした'); toast(e.message); }
}

function renderAcceleration(settings) {
  return preserveSettingsScroll(() => {
    const box = $('#acceleration'); if (!box || accelerationSaving) return;
    const on = settings?.codexAllowed === true;
    box.innerHTML = UI.template`<label><input type="checkbox" id="codex-fast" data-saved="${on}" ${on ? 'checked' : ''}> 作業ごとに選べるようにする（<span id="codex-fast-state">${on ? 'ON' : 'OFF'}</span>）</label>`;
  });
}

async function saveCodexFast(input) {
  if (accelerationSaving || $('#codex-fast') !== input) return;
  const before = input.dataset.saved === 'true', wanted = input.checked;
  accelerationSaving = true; accelerationRevision++; ++stateLoadEpoch;
  input.disabled = true;
  try {
    const saved = await api('/api/acceleration', { codexAllowed: wanted });
    state.acceleration = saved;
    input.checked = saved.codexAllowed === true;
    input.dataset.saved = String(input.checked);
    toast(input.checked ? UI.text('作業ごとに加速を選べるようにしました') : UI.text('全作業の加速を無効にしました'));
  } catch (err) { input.checked = before; toast(UI.text('加速設定を保存できませんでした：') + err.message); }
  finally {
    accelerationSaving = false; accelerationRevision++; ++stateLoadEpoch;
    input.disabled = false;
    if ($('#codex-fast') === input) $('#codex-fast-state').textContent = input.checked ? 'ON' : 'OFF';
    else if (view.kind === 'settings') loadCliModels(true);
    syncTaskFastPickers(); // 保存中に移動した作業画面も、確定した利用許可へ同期する。
  }
}

async function loadCliModels(keepDraft = false) {
  const box = $('#climodels'); if (!box) return;
  const seq = ++cliModelsLoadSeq;
  const speedRevision = accelerationRevision;
  try {
    const r = await api('/api/cli-models');
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    if (speedRevision === accelerationRevision) renderAcceleration(r.acceleration);
    const draft = new Map();
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => draft.set(`${el.dataset.ai}/${el.dataset.name}`, el.value));
    const table = ai => UI.template`<div class="tbl"><table><tr><th>${AI_LABEL[ai]}</th><th>CLI に渡す名前</th></tr>${(r[ai] || []).map(x => UI.template`<tr><td class="now">${esc(x.name)}</td><td><input class="cm" data-ai="${ai}" data-name="${esc(x.name)}" value="${esc(x.flag)}" list="hint-${ai}" placeholder="（空＝${AI_LABEL[ai]} の既定のモデル）" maxlength="60"></td></tr>`).join('')}</table></div>
      <datalist id="hint-${ai}">${(r.hints[ai] || []).map(h => UI.template`<option value="${esc(h)}">`).join('')}</datalist>`;
    preserveSettingsScroll(() => { box.innerHTML = UI.template`${table('claude')}${table('codex')}<p>Grok：モデル一覧のIDをそのまま使います。</p><p>Agy CLI：${esc((state.agyModels || []).map(m => m.label + '（' + m.id + '）').join(' / ') || UI.text('利用可能なモデルなし'))}（Hubが確認した最新の一覧）</p>
      ${(r.hints.codex || []).length ? UI.template`<p class="small">Codex の設定で見つかった名前：${r.hints.codex.map(esc).join('、')}</p>` : ''}
      <div class="acts" style="margin-top:10px"><button class="btn" id="cm-save" type="button">保存する</button></div>`; });
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => { const key = `${el.dataset.ai}/${el.dataset.name}`; if (draft.has(key)) el.value = draft.get(key); });
  } catch (e) {
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    preserveSettingsScroll(() => { box.textContent = UI.text('読み込めませんでした'); });
    const speedBox = $('#acceleration');
    if (speedBox && speedRevision === accelerationRevision && !accelerationSaving) speedBox.textContent = UI.text('読み込めませんでした。設定を開き直してください');
  }
}

function updateLabel(version, latest) {
  const hub = latest && version && latest !== version;
  const cli = state.aiCliUpdate?.available === true;
  if(state.restart?.reserved)return UI.text('再起動を予約中');
  return hub ? `Update v${latest}${cli ? ' / AI CLI' : ''}` : cli ? 'Update AI CLI' : '';
}

function showVersion(version, latest) {
  $('#master-badge').hidden = state.license?.edition !== 'owner';
  $('#ver').textContent = version ? UI.text('稼働')+' v' + version : '';
  $('#ver').title=UI.text('本体保存済み')+' v'+(latest||version||'')+' / '+(state.restart?.waiting||[]).map(x=>x.message).join(' / ');
  if ($('#upd').disabled) return;
  const label = updateLabel(version, latest);
  $('#upd').hidden = !label;
  if (label) $('#upd').textContent = label;
}

function restartControls() {
  const r=state.restart || {};
  if(r.committed)return UI.template`<span class="small">再起動を開始しています</span>`;
  if(r.reserved)return UI.template`<span class="small">再起動を予約中</span><button type="button" class="btn plain" data-restart-cancel>再起動予約を取消</button><span class="small">${esc(r.error || (r.waiting || []).map(x=>x.message).join(' / '))}</span>`;
  return UI.template`<button type="button" class="btn plain" data-restart-reserve>${state.restartBusy ? UI.text('終了後に再起動を予約') : UI.text('Hubを再起動')}</button>`;
}

function hubUpdateButton() {
  return state.latest && state.version && state.latest !== state.version
    ? UI.template`<button class="btn plain" type="button" data-hub-update>Hub を v${esc(state.latest)} に切り替える</button>` : '';
}

function updateBlocked() {
  return state.updateBlocked || state.aiCliUpdate?.busyCount || (state.chatting || []).length || (state.sessions || []).some(s => s.running);
}

async function switchHubUpdate() {
  if ($('#upd').disabled) return;
  if (state.latest && state.version && state.latest !== state.version) await restartHub();
}

async function openUpdate() {
  if ($('#upd').disabled) return;
  if(state.restart?.reserved){view={...view,kind:'settings'};settingsTab='ai';render();return;}
  if (state.aiCliUpdate?.available) {
    if (aiToolsNeedDataLocation()) { openDataLocation(); toast(aiToolsDataLocationMessage()); return; }
    const both = state.latest && state.version && state.latest !== state.version;
    view = { ...view, kind: 'settings' }; settingsTab = 'ai'; render();
    toast(UI.text(both ? 'CLIは［一括更新］、Hubだけなら［Hub を v版 に切り替える］を押してください。' : 'AI CLIは設定の［一括更新］から更新できます。'));
    return;
  }
  await switchHubUpdate();
}

async function loadChangelog() {
  const box = $('#verbox'); if (!box) return;
  try {
    const rows = await api('/api/changelog');
    box.innerHTML = UI.template`<ul class="log">${rows.map(r => UI.template`<li><b>v${esc(r.version)}</b> <span class="small">${esc(r.date)}</span><ul>${r.items.map(x => UI.template`<li>${esc(x)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  } catch (e) { box.textContent = UI.text('読み込めませんでした'); }
}

async function restartHub() {
  const b = $('#upd'); b.disabled = true; b.textContent = UI.text('切り替えています…');
  try { const r=await api('/api/restart', {reserve:true}); stateLoadEpoch++;state.restart=r.restart;observeRestart(state); if(r.restart?.reserved){toast(UI.text('再起動を予約しました。処理が終わると一度だけ再起動します。'));b.disabled=false;render();return;} }
  catch (e) { toast(e.message); b.disabled = false; render(); return; }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { observeRestart(await api('/api/state')); if (restartReloaded) return; } catch (e) { /* まだ */ }
  }
  toast(UI.text('切り替わりませんでした。アプリを開き直してください'));
}

async function loadLog() {
  const box = $('#logbox'); if (!box) return;
  try {
    const rows = await api('/api/log?n=30');
    box.innerHTML = rows.length ? UI.template`<ul class="log">${rows.map(r => UI.template`<li><span class="small">${esc(new Date(r.at).toLocaleString(UI.dateLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span> ${esc(r.project || '')}${r.task ? '・' + esc(r.task) : ''}：${esc(ACTION[r.action] || r.action)}${r.ai ? `（${esc(AI_LABEL[r.ai] || r.ai)}）` : ''}${r.action === 'merge' && r.conflict ? UI.text('・ぶつかったので中止') : ''}</li>`).join('')}</ul>` : UI.html('<p class="note">まだありません。</p>');
  } catch (e) { box.textContent = UI.text('読み込めませんでした'); }
}

async function saveRoles() {
  try { state.roles = await api('/api/roles', { roles: rolesDraft, checkCredits: checkCreditsDraft, preferCredits: preferCreditsDraft, expectedRevision: rolesDraftRevision || 'reload-required' }); clearRolesDraft(); toast(UI.text('役割分担とクレジット設定を保存しました')); render(); }
  catch (e) { toast(e.message); }
}

function emptyHtml() {
  if (!emptyFound) return '';
  if (!emptyFound.length) return UI.html('<p class="small">片付ける物はありません。</p>');
  const row = (x, key, label, sub) => UI.template`<label class="chk"><input type="checkbox" data-key="${esc(key)}" ${x.pick ? 'checked' : ''}> ${label}${sub ? UI.template`<span class="small">　${sub}</span>` : ''}</label>`;
  return emptyFound.map(x => x.whole
    ? row(x, x.project + '/', UI.template`<b>子プロジェクトごと</b>：${esc(x.projectName)}`, UI.template`作業 ${x.tasks.length} 件・すべて会話が空`)
    : row(x, x.project + '/' + x.task, `${esc(x.projectName)} / ${esc(x.title)}`, `${esc(x.state)}${x.done ? UI.text('・やったこと：') + esc(x.done.replace(/\s+/g, ' ').slice(0, 80)) : ''}`)).join('')
    + UI.html('<div class="acts"><button class="btn plain sm" data-act="emptyall" data-on="1" type="button">すべて選ぶ</button><button class="btn plain sm" data-act="emptyall" data-on="0" type="button">すべて外す</button><button class="btn" data-act="emptytrash" type="button">選んだ物をゴミ箱へ</button></div>');
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3230() {
  return (async e=>{
  const button=e.target.closest?.('[data-ai-emergency],[data-ai-resume],[data-ai-stop-refresh]');if(!button)return;
  if(button.hasAttribute('data-ai-stop-refresh'))return refreshEmergencyStatus();
  button.disabled=true;
  try{
    if(button.hasAttribute('data-ai-resume')){
      if(!confirm(UI.text('AIの開始を再び許可します。保留中の自動処理も再開できます。会話の待ち指示は内容を確認してから［始める］を押してください。')))return;
      drawEmergencyStatus(await api('/api/ai/resume',{confirm:true}));
    }else{
      const s=await api('/api/ai/stop/status');
      const targets=(s.targets||[]).map(t=>`${t.project}／${t.task||'作業未確認'}：${AI_LABEL[t.ai]||t.ai}${t.kind==='unmanaged'?'（Hub所有未確認・停止対象外）':''}`).join('\n')||'現在、稼働中として確認できるAIはありません。';
      if(!confirm(UI.template`Hubが起動したすべてのAIを停止し、待ち指示と自動開始を保留します。通常停止に応じない場合は強制終了します。会話と保存済み成果は残りますが、保存前の出力は失われる場合があります。\n\n${targets}\n\n停止・保存を確認した後、Hubを一度再起動します。再起動後もAIと待ち指示は保留し、人が再開するまで始めません。確認できない場合は再起動せず理由を表示します。\n\n停止してHubを再起動しますか？`))return;
      $('#emergency-status').textContent='停止処理中です。終了と保存を確認しています…';
      const opId=crypto.randomUUID();try{sessionStorage.setItem('hub-emergency-stop-id',opId);}catch{/* Storage failure must never prevent a stop. */}
      drawEmergencyStatus(await api('/api/ai/stop',{confirm:true,opId}));
    }
  }catch(error){$('#emergency-status').textContent=`停止・再開の結果を確認できません：${error.message}。［状態を確認］で照合してください。`;}finally{button.disabled=false;void refreshEmergencyStatus();}
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3248() {
  return (()=>{if(view.kind==='settings'&&settingsTab==='recovery')void refreshEmergencyStatus();});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3264() {
  return (e => {
  const button = e.target.closest?.('[data-settings-tab]');
  if (button) selectSettingsTab(button.dataset.settingsTab);
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3268() {
  return (e => {
  const button = e.target.closest?.('[data-settings-tab]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = Object.keys(SETTINGS_TABS), index = tabs.indexOf(button.dataset.settingsTab);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault(); selectSettingsTab(tabs[next]); document.querySelector(`[data-settings-tab="${tabs[next]}"]`)?.focus();
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3289() {
  return (async e => {
  const button = e.target.closest?.('[data-license-intro]');
  if (!button) return;
  e.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  try { await api('/api/license/intro-checkout', {}); }
  catch { toast(UI.text('体験価格の購入画面を開けません。支払い状況を確認してください')); }
  finally { button.disabled = false; }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3299() {
  return (async e => {
  if (e.target.id !== 'license-form') return;
  e.preventDefault();
  const form = e.target, input = form.querySelector('#license-code'), notice = form.querySelector('#license-notice');
  if (form.querySelector('button').disabled) return;
  const code = input.value; input.value = '';
  const button = form.querySelector('button'); button.disabled = true;
  notice.textContent = '利用コードを確認しています…';
  try { const result = await api('/api/license/activate', { code }); state.license = result.status || state.license; renderSettings(); toast(UI.text('利用コードを登録しました')); }
  catch (error) { notice.textContent = error.message; }
  finally { button.disabled = false; }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3550() {
  return (event => { if (event.target.id === 'language-choice') languageDraft = event.target.value; });
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3563() {
  return (async event => {
  const button = event.target.closest?.('[data-language]');
  if (!button || languageBusy) return;
  const action = button.dataset.language, language = $('#language-choice')?.value, id = button.dataset.packId;
  if (action === 'remove' && !confirm(UI.text('この言語パックを削除しますか？ 使用中なら日本語に戻ります。'))) return;
  languageBusy = true; languageNotice = ''; ++languageLoadEpoch; drawLanguageSettings();
  try {
    if (action === 'import') {
      const picked = await api('/api/pick-folder', { prompt: UI.text('展開した言語パックのフォルダを選んでください') });
      if (!picked.path) return;
      languageSettings = await api('/api/langpacks/import', { dir: picked.path });
      languageNotice = UI.text('言語パックを追加しました。表示言語を選んで保存してください。');
    } else if (action === 'remove') {
      languageSettings = await api('/api/langpacks/remove', { id });
      if (languageDraft === id) languageDraft = null;
      languageNotice = UI.text('言語パックを削除しました。');
    } else if (action === 'save') {
      languageSettings = await api('/api/language', { language });
      languageDraft = null;
      languageNotice = languageRestartMessage(true);
    } else if (action === 'restart') await applyLanguageRestart();
  } catch (error) { languageNotice = error.message; }
  finally { languageBusy = false; drawLanguageSettings(); }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3655() {
  return (async e => {
  if (e.target.id !== 'chatgpt-work' || chatgptWorkPending !== null) return;
  const work = e.target.checked;
  chatgptWorkPending = work; ++chatgptLoadEpoch; e.target.disabled = true;
  try { await api('/api/chatgpt', { work }); toast(work ? UI.text('MCPにファイル変更・コマンド実行を許しました') : UI.text('MCPのファイル変更・コマンド実行を無効にしました')); }
  catch (err) { toast(err.message); }
  finally { chatgptWorkPending = null; loadChatgpt(); }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3679() {
  return (async e => {
  const id = e.target.id;
  if (!['remote-pass-save','remote-logout-all','remote-enrollment','remote-forget-devices'].includes(id)) return;
  try {
    if (id === 'remote-enrollment') {
      const r = await api('/api/remote/enrollment', {});
      $('#remote-enrollment-code').textContent = '10分以内に、新しい端末で合言葉と一緒に入力してください：' + r.code;
      return;
    } else if (id === 'remote-forget-devices') {
      await api('/api/remote/forget-devices', {}); toast('信頼済み端末の印を取り消しました');
    } else if (id === 'remote-pass-save') {
      const v = $('#remote-pass').value;
      if ([...v].length < 8) return toast(UI.text('合言葉は8文字以上にしてください'));
      await api('/api/remote', { passcode: v }); toast(UI.text('合言葉を保存しました'));
    } else { await api('/api/remote/logout-all', {}); toast(UI.text('すべての端末から出ました')); }
  } catch (err) { toast(err.message); }
  loadRemote();
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3691() {
  return (async e => {
  if (e.target.id !== 'remote-on') return;
  try { await api('/api/remote', { enabled: e.target.checked }); toast(e.target.checked ? UI.text('外から使えるようにしました') : UI.text('外からの利用をオフにしました')); }
  catch (err) { toast(err.message); }
  loadRemote();
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3727() {
  return (e => {
  if (e.target.hasAttribute?.('data-task-fast')) void saveTaskFast(e.target);
  if (e.target.id === 'codex-fast') void saveCodexFast(e.target);
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3754() {
  return (async e => {
  if (e.target.id !== 'cm-save') return;
  const o = { claude: {}, codex: {} };
  document.querySelectorAll('input.cm').forEach(i => { o[i.dataset.ai][i.dataset.name] = i.value.trim(); });
  try { await api('/api/cli-models', o); toast(UI.text('モデル名を保存しました（次に送る時から使います）')); loadCliModels(); } catch (err) { toast(err.message); }
});
}

// Create the original callback at its original registration point in app.js.
function appSettingsCallback3782() {
  return (async e=>{
  if(!e.target.closest?.('[data-restart-reserve],[data-restart-cancel]'))return;
  try {
    const cancel=Boolean(e.target.closest('[data-restart-cancel]'));
    const r=await api(cancel?'/api/restart/cancel':'/api/restart',{reserve:true});
    stateLoadEpoch++;state.restart=r.restart;observeRestart(state);drawAiTools();
    toast(UI.text(cancel?'再起動予約を取り消しました。':r.restart.reserved?'再起動を予約しました。処理の終了を待ちます。':'再起動を開始しています'));
    if(r.restart.committed){for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,500));try{observeRestart(await api('/api/state'));if(restartReloaded)return;}catch{}}}
  }catch(e){toast(e.message);}
});
}
