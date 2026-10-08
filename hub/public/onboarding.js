// はじめの設定：導入コマンドは表示・コピーだけ。AIを自動で起動しない。
(() => {
  'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
  const steps = ['ai', 'cli', 'check', 'first'];
  const titles = [UI.text('AIを選ぶ'), UI.text('入れる・ログイン'), UI.text('確かめる'), UI.text('始める')];
  const guides = {
    claude: { name: 'Claude Code', install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'claude', url: 'https://code.claude.com/docs/en/quickstart' },
    codex: { name: 'Codex', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', login: 'codex', url: 'https://learn.chatgpt.com/docs/codex/cli' },
    agy: { name: 'Gemini（Agy CLI）', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', login: 'agy', url: 'https://antigravity.google/docs/getting-started?tab=cli' },
    grok: { name: 'Grok', install: 'curl -fsSL https://x.ai/cli/install.sh | bash', login: 'grok login', url: 'https://docs.x.ai/build/cli' },
  };
  let sheet, draft, results, busy = false, autoSeen = false, saveFailed = false, message = '', returnFocus;
  function sample() {
    const p = state.projects.find(p => p.id === UI.text('サンプルアプリ'));
    const t = p?.tasks.find(t => t.state !== '完了');
    return t ? { p, t } : null;
  }
  function checkSummary() {
    if (!results) return UI.html('<p>まだ確認していません。下の［確かめる］を押してください。AIへの依頼は行いません。</p>');
    return draft.ais.map(ai => {
      const r = results.tools[ai];
      const installed = r.installed ? UI.template`入っています${r.version ? UI.template`（版 ${esc(r.version)}）` : UI.text('（版は確認できません）')}` : UI.text('見つかりません。［戻る］で入れ方を確認してください。');
      const login = { ready: UI.text('ログインしています'), required: UI.text('ログインが必要です。入れ方の画面に戻り、ログインしてください。'), unknown: UI.text('確認できません。作業を始めた時にAIが案内する場合があります。') }[r.login];
      const notice = { 'settings-unreadable': UI.text('Agyの設定を確認できません。設定ファイルを確認してください。'), 'api-provider': UI.text('AgyがAPIの利用設定になっています。契約・無料枠のログイン経路を確認してください。Hubは認証を変更しません。') }[r.notice];
      return UI.template`<div class="card"><h3>${esc(guides[ai].name)}</h3><p>${installed}</p><p>ログイン：${login}</p>${notice ? UI.template`<p>${notice}</p>` : ''}</div>`;
    }).join('') + UI.template`<p>${results.terminal ? UI.text('画面の中でAIを動かす部品：使えます') : UI.text('画面の中の作業部分が使えません。Project Hubのフォルダで、ターミナルから bash hub/setup.sh をもう一度実行してください。')}</p>`;
  }
  function draw() {
    const n = steps.indexOf(draft.step);
    let body;
    if (n === 0) body = UI.template`<p>Project Hubは、パソコンに入れたAIの道具（CLI）を画面の中で動かします。CLIは、ターミナルから使うアプリのことです。使うものを選んでください。</p>
      <div class="onboarding-choices">${Object.entries(guides).map(([ai, g]) => UI.template`<label><input type="checkbox" data-onboarding-ai="${ai}" ${draft.ais.includes(ai) ? 'checked' : ''}> <b>${g.name}</b>${ai === 'claude' ? UI.text('（おすすめ）') : ai === 'agy' ? UI.text('（手動で選んだ時だけ使います）') : ''}</label>`).join('')}</div>
      <p>ChatGPTやClaudeのデスクトップアプリは要りません。選択は案内に使うだけで、役割・モデルや、新しく始める時のAIは変えません。</p>`;
    else if (n === 1) body = UI.template`<p>Macの［アプリケーション］→［ユーティリティ］にある［ターミナル］を開きます。必要なAIだけ、次の順番で準備してください。すでに入っている場合はログインの確認へ進めます。</p>
      ${draft.ais.map(ai => { const g = guides[ai]; return UI.template`<div class="card"><h3>${g.name}</h3><p>1. 入れる：次の1行をターミナルに貼り、Returnキーを押します。</p><div class="onboarding-command"><code>${esc(g.install)}</code><button class="btn plain sm" type="button" data-onboarding-copy="${ai}" data-command="install" aria-label="${g.name}のインストールコマンドをコピー">コピー</button></div>
      <p>2. ログインする：入れたあと、次の1行を実行して画面の案内に従います。必要に応じてブラウザが開きます。</p><div class="onboarding-command"><code>${g.login}</code><button class="btn plain sm" type="button" data-onboarding-copy="${ai}" data-command="login" aria-label="${g.name}の起動コマンドをコピー">コピー</button></div>
      <p>${ai === 'grok' ? UI.text('xAIのアカウントでログインしてください。APIキーは使いません。') : ai === 'agy' ? UI.text('Googleアカウントでの案内に従ってください。') : UI.template`契約している${ai === 'codex' ? 'ChatGPT' : 'Claude'}のアカウントでログインしてください。APIキーの入力はこの案内では使いません。`}</p><a href="${g.url}" target="_blank" rel="noopener noreferrer">${g.name}の公式の手引き ↗</a></div>`; }).join('')}
      <p>AIの利用料金は各社との契約によります。この設定案内では、Project Hubから請求することはありません。コマンドはコピーするだけで、自動では実行しません。</p>`;
    else if (n === 2) body = UI.template`${checkSummary()}<button class="btn" type="button" data-onboarding-action="check">${results ? UI.text('もう一度確かめる') : UI.text('確かめる')}</button><p class="small">インストールとログイン状態だけを調べます。AIへの依頼やログイン操作は行いません。未確認の項目があっても、次へ進めます。</p>`;
    else body = UI.template`<p>準備の案内はここまでです。選んだAI：${draft.ais.map(ai => guides[ai].name).join('、')}。</p><p>新しく始める時のAIは、今の設定のままです。変更する場合は［設定］の［新しく始めるときのAI］で選んでください。</p>
      ${results ? UI.template`<details><summary>準備の確認結果</summary>${checkSummary()}</details>` : UI.html('<p>まだ準備を確認していません。［戻る］から確認できます。</p>')}
      <div class="onboarding-start">${sample() ? UI.template`<button class="btn" type="button" data-onboarding-action="sample">サンプル「${UI.text('サンプルアプリ')}」の作業を開く</button>` : ''}<button class="btn plain" type="button" data-onboarding-action="newproject">新しいプロジェクトを作る</button></div><p class="small">このボタンでは、AIはまだ動きません。</p>`;
    sheet.innerHTML = UI.template`<div class="onboarding-box"><h2 id="onboarding-title">はじめの設定</h2><ol class="onboarding-progress">${titles.map((t, i) => UI.template`<li ${i === n ? 'aria-current="step"' : ''}>${i + 1} ${t}</li>`).join('')}</ol>
      <div class="onboarding-body"><h3 tabindex="-1" id="onboarding-step">${n + 1}. ${titles[n]}</h3>${body}</div><p class="onboarding-message" role="status">${esc(message)}</p>
      ${saveFailed ? UI.html('<p role="status">進捗を保存できていません。保存しないで閉じることもできます。次の起動時に案内が再び開く場合があります。</p>') : ''}
      <div class="onboarding-footer"><button class="btn plain" type="button" data-onboarding-action="back" ${n === 0 ? 'disabled' : ''}>戻る</button><button class="btn plain" type="button" data-onboarding-action="later">あとで</button>${saveFailed ? UI.html('<button class="btn plain" type="button" data-onboarding-action="dismiss">保存しないで閉じる</button>') : ''}<span class="sp"></span><button class="btn" type="button" data-onboarding-action="${n === 3 ? 'done' : 'next'}" ${!draft.ais.length ? 'disabled' : ''}>${n === 3 ? '完了' : UI.text('次へ')}</button></div></div>`;
    sheet.querySelectorAll('button,input').forEach(el => { if (busy) el.disabled = true; });
  }
  async function persist(status = 'in-progress') {
    const ais = draft.ais.length ? draft.ais : (state.onboarding?.ais || ['claude']);
    let r;
    try { r = await api('/api/onboarding', { status, step: draft.step, ais }); }
    catch (e) { saveFailed = true; throw e; }
    saveFailed = false;
    stateLoadEpoch++;
    state.onboarding = r.onboarding;
  }
  function close() { sheet.close(); returnFocus?.focus(); }
  async function perform(action) {
    if (busy) return;
    if (action === 'dismiss') {
      if (saveFailed) { close(); toast(UI.text('進捗は保存できていません。［設定］の［はじめの設定］から開き直せます')); }
      return;
    }
    busy = true; message = action === 'check' ? UI.text('確認しています…') : UI.text('保存しています…'); draw();
    const previous = draft.step;
    try {
      if (action === 'check') results = await api('/api/onboarding/check', { ais: [...draft.ais] });
      else if (action === 'next' || action === 'back') {
        draft.step = steps[steps.indexOf(draft.step) + (action === 'next' ? 1 : -1)];
        await persist();
      } else {
        await persist(action === 'later' ? 'skipped' : 'done'); close();
        if (action === 'newproject') { view = { kind: 'newproject' }; save(); render(); }
        else if (action === 'sample') { const s = sample(); if (s) { view = { kind: 'work', project: s.p.id, task: s.t.id }; open.add(s.p.id); save(); render(); } }
        else if (action === 'later') toast(UI.text('［設定］の［はじめの設定］から再開できます'));
      }
      message = action === 'check' ? UI.text('確認が終わりました。未確認の項目も表示しています。') : '';
    } catch (e) { draft.step = previous; message = UI.text('続けられませんでした：') + e.message; }
    finally { busy = false; if (sheet.open) { draw(); sheet.querySelector('#onboarding-step')?.focus(); } }
  }
  async function show(manual = false) {
    if (sheet?.open) return;
    autoSeen = true; returnFocus = document.activeElement;
    draft = { step: manual ? 'ai' : (state.onboarding?.step || 'ai'), ais: [...(state.onboarding?.ais || ['claude'])] };
    results = null; message = ''; saveFailed = false; busy = true;
    if (!sheet) {
      sheet = document.createElement('dialog'); sheet.className = 'onboarding-sheet'; sheet.setAttribute('aria-labelledby', 'onboarding-title');
      sheet.addEventListener('cancel', e => { e.preventDefault(); void perform(saveFailed ? 'dismiss' : 'later'); }); document.body.appendChild(sheet);
    }
    draw(); sheet.showModal();
    try { await persist(); }
    catch (e) { message = UI.text('案内の記録を保存できませんでした：') + e.message; }
    finally { busy = false; draw(); sheet.querySelector('#onboarding-step')?.focus(); }
  }
  document.addEventListener('click', async e => {
    if (e.target.closest('[data-onboarding-open]')) { await show(true); return; }
    const copy = e.target.closest('[data-onboarding-copy]');
    if (copy && !copy.disabled) { await copyText(guides[copy.dataset.onboardingCopy][copy.dataset.command]); return; }
    const b = e.target.closest('[data-onboarding-action]');
    if (b && !b.disabled) await perform(b.dataset.onboardingAction);
  });
  document.addEventListener('change', e => {
    const ai = e.target.dataset.onboardingAi;
    if (!ai || !sheet?.open || busy) return;
    const checked = [...sheet.querySelectorAll('[data-onboarding-ai]:checked')].map(el => el.dataset.onboardingAi);
    draft.ais = checked; results = null;
    sheet.querySelector('[data-onboarding-action="next"]').disabled = !checked.length;
  });
  window.HubOnboarding = { open: () => show(true), sync: () => { if (!autoSeen && state.onboarding?.auto) void show(); } };
  if (typeof state !== 'undefined' && state) window.HubOnboarding.sync();
})();
