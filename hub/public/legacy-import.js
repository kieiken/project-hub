'use strict';
// Only the dedicated distribution loads this panel. Preview is read-only;
// importing data and applying former roles each require a visible user action.
async function loadLegacyImport() {
  const anchor=document.querySelector('#app-update-box')?.closest('.pref-section');
  if(!anchor) return;
  document.querySelector('#legacy-import-section')?.remove();
  const section=document.createElement('section'); section.id='legacy-import-section';section.className='pref-section';section.dataset.tab='manage';
  section.innerHTML=UI.template`<h2 class="pref-caption">以前のデータを引き継ぐ</h2><div class="pref-list"><div class="pref-row pref-stack">
    <p>この端末に残っている以前の会話・プロジェクトを、今のデータを残して追加します。同名のものは別名になります。</p>
    <label>以前の AI-Workspace <input id="legacy-workspace" type="text" style="width:100%"></label>
    <label>以前の freetalk <input id="legacy-freetalk" type="text" style="width:100%"></label>
    <p class="small">購入情報・AIのログイン情報・権限・作業用コピー・Git管理は移しません。ブラウザ内の配色は選び直してください。</p>
    <div><button class="btn plain" id="legacy-preview" type="button">引き継ぐ内容を確認</button></div><div id="legacy-preview-result" role="status"></div>
    </div></div>`;
  anchor.before(section);
  section.hidden=typeof settingsTab==='string' && settingsTab!=='manage';
  const workspace=section.querySelector('#legacy-workspace'), talk=section.querySelector('#legacy-freetalk'), result=section.querySelector('#legacy-preview-result'), button=section.querySelector('#legacy-preview');
  const showError=e=>{result.textContent=e.message;button.disabled=false;};
  try {const data=await api('/api/legacy-import');workspace.value=data.defaults.workspace;talk.value=data.defaults.freetalk;}catch(e){showError(e);return;}
  button.onclick=async()=>{
    button.disabled=true;result.textContent=UI.text('内容を確認しています…');
    try {
      const plan=await api('/api/legacy-import/preview',{workspace:workspace.value,freetalk:talk.value});
      result.innerHTML=UI.template`<p>${plan.mode==='complete'?UI.text('この保存先からの引き継ぎは完了しています。'):plan.mode==='interrupted'?UI.text('途中の引き継ぎがあります。同じ保存内容から再開します。'):UI.text('元のデータを変更せず、次の内容を追加します。')}</p>
        <ul>${(plan.projects||[]).map(p=>`<li>${esc(p.name)} → ${esc(p.target)}</li>`).join('')}</ul>
        <p>${esc(plan.files)} ファイル${plan.topics!==undefined?UI.template`・自由対話 ${esc(plan.topics)} 話題`:''}</p>
        <p>${esc(plan.settings?.preserved||'')}</p><p class="small">${esc(plan.notice||'')}</p>`;
      if(plan.mode!=='complete') {
        const apply=document.createElement('button');apply.className='btn';apply.textContent=plan.mode==='interrupted'?UI.text('引き継ぎを再開する'):UI.text('この内容を追加する');
        apply.onclick=async()=>{
          if(!confirm(UI.text('元と今のデータを残して、表示した内容を追加します。進めますか？')))return;
          apply.disabled=true;
          try{await api('/api/legacy-import/apply',{token:plan.token,confirm:true});result.textContent=UI.text('引き継ぎが完了しました。プロジェクト一覧を開き直すと表示されます。');await settings(plan.token);}catch(e){showError(e);}finally{button.disabled=false;}
        };result.append(apply);
      } else await settings(plan.token);
      button.disabled=false;
    }catch(e){showError(e);}
  };
  async function settings(token) {
    const data=await api('/api/legacy-import/settings',{token});
    if(data.view){
      const box=document.createElement('details');box.innerHTML=UI.html('<summary>以前のモデル表示設定を確認する</summary><p class="small">モデルの順番・非表示・スマホの名前だけを適用します。初期担当と自動実行の設定は変えません。</p>');
      const description=document.createElement('pre');description.textContent=JSON.stringify(data.view,null,2);box.append(description);
      const apply=document.createElement('button');apply.className='btn plain';apply.textContent=UI.text('以前のモデル表示設定を適用する');
      apply.onclick=async()=>{if(!confirm(UI.text('表示したモデルの順番・非表示・スマホの名前を適用しますか？')))return;apply.disabled=true;try{await api('/api/legacy-import/settings',{token,confirm:true,action:'view',expectedRevision:data.viewRevision});toast(UI.text('表示設定を適用しました。設定画面を開き直してください。'));}catch(e){toast(e.message);apply.disabled=false;}};
      box.append(apply);result.append(box);
    }
    if(!data.roles.length)return;
    const box=document.createElement('details');box.innerHTML=UI.template`<summary>以前の担当・モデル設定を確認する</summary><ul>${data.roles.map(r=>UI.template`<li>${esc(UI.label(r.name))}：${esc(r.main.ai)} / ${esc(r.main.model)} ／ 上限時 ${esc(r.backup.ai)} / ${esc(r.backup.model)}</li>`).join('')}</ul><p class="small">今選べるモデルだけ適用できます。現在の設定は変更履歴に残り、ログイン情報と実行権限は引き継ぎません。</p>`;
    const apply=document.createElement('button');apply.className='btn plain';apply.textContent=UI.text('以前の担当設定を適用する');
    apply.onclick=async()=>{
      if(typeof rolesDirty==='function' && rolesDirty()){toast(UI.text('編集中の担当設定を先に保存してください。'));return;}
      if(!confirm(UI.text('表示した以前の担当・モデルを現在の設定へ適用しますか？')))return;
      apply.disabled=true;
      try{await api('/api/legacy-import/settings',{token,confirm:true,expectedRevision:state.roles.management.revision});toast(UI.text('担当設定を適用しました。設定画面を開き直してください。'));}catch(e){toast(e.message);apply.disabled=false;}
    };box.append(apply);result.append(box);
  }
}
