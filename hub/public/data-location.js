'use strict';
// Loaded only by the purchase-test package. All paths and titles are escaped.
function openDataLocation() {
  view = { ...view, kind:'settings' }; settingsTab='manage'; render();
}
function renderDataLocationEmpty() {
  $('#main').innerHTML=UI.template`<div class="view"><div class="empty"><h2>以前のデータを使う</h2><p>今の保存先：<code>${esc(state.root)}</code></p><p>以前の会話・プロジェクトがあるフォルダを選べます。内容を確認して確定するまで、保存先は変わりません。</p><button class="btn" type="button" id="empty-data-location">データの保存先を選ぶ</button></div></div>`;
  $('#empty-data-location').onclick=openDataLocation;
}
async function loadDataLocation() {
  let box=$('#data-location');
  if(!box) {
    const anchor=document.querySelector('[data-tab="manage"] .pref-list'); if(!anchor)return;
    box=document.createElement('div');box.id='data-location';box.className='pref-row pref-stack';anchor.prepend(box);
  }
  try {
    const s=await api('/api/data-location'); if($('#data-location')!==box)return;
    box.innerHTML=UI.template`<h3>データの保存先</h3><p>使用中：<code>${esc(s.current.workspace)}</code></p>${s.current.freetalk?UI.template`<p>自由対話：<code>${esc(s.current.freetalk)}</code></p>`:''}<p class="small">会話・プロジェクト・担当などの非秘密設定は、選んだ場所で読み書きします。元へ戻すコピーは不要です。試験中に別の場所へ保存した内容は残りますが、自動では合流しません。</p><p class="small">試験用の購入情報・鍵・登録結果・更新管理は <code>${esc(s.management)}</code> に分けて保持します。</p><p class="note" role="status">${esc(s.notice||UI.text('以前の Project Hub は処理を終えて終了してください。選択だけで以前の実行待ちや自動AI・自動整理は始めません。'))}</p>${s.pending?UI.template`<p>次に開く保存先：<code>${esc(s.pending.workspace)}</code></p><p>作業を再開せず、普通に終了して同じアプリを開き直してください。</p><button type="button" class="btn plain" id="data-location-cancel">この変更を取り消す</button>`:UI.template`<p><label>プロジェクトの保存先（AI-Workspace）<input id="data-location-workspace" type="text" style="width:100%" value="${esc(s.current.workspace===s.management?s.standard.workspace:s.current.workspace)}"></label><button type="button" class="btn plain" data-location-pick="workspace">フォルダを選ぶ</button></p><p><label>自由対話のフォルダ（台帳に登録されていれば空欄でも検出）<input id="data-location-freetalk" type="text" style="width:100%" value="${esc(s.current.freetalk||'')}"></label><button type="button" class="btn plain" data-location-pick="freetalk">フォルダを選ぶ</button></p><div class="acts">${s.standard.exists?UI.html('<button type="button" class="btn plain" id="data-location-standard">書類の標準の場所を候補にする</button>'):''}<button type="button" class="btn" id="data-location-preview">内容を確認</button></div><div id="data-location-plan"></div>`}`;
    const feedback=message=>{const el=box.querySelector('[role="status"]');el.textContent=message;};
    $('#data-location-cancel')?.addEventListener('click',async()=>{try{await api('/api/data-location/cancel',{});await loadDataLocation();}catch(e){feedback(e.message);}});
    const clear=()=>{const el=$('#data-location-plan');if(el)el.replaceChildren();};
    for(const field of ['workspace','freetalk'])$('#data-location-'+field)?.addEventListener('input',clear);
    box.querySelectorAll('[data-location-pick]').forEach(button=>button.onclick=async()=>{
      const label=button.textContent;button.disabled=true;button.textContent=UI.text('選択画面を開いています…');feedback(UI.text('フォルダー選択画面で選んでください。保存先はまだ変更しません。'));
      try{const result=await api('/api/data-location/pick',{});if(!result.cancelled){$('#data-location-'+button.dataset.locationPick).value=result.folder;clear();feedback(UI.text('候補を入力しました。「内容を確認」で確認してください。'));}else feedback(UI.text('選択を取り消しました。保存先は変更していません。'));}catch(e){feedback(e.message);}finally{button.disabled=false;button.textContent=label;}
    });
    $('#data-location-standard')?.addEventListener('click',()=>{$('#data-location-workspace').value=s.standard.workspace;$('#data-location-freetalk').value='';clear();});
    $('#data-location-preview')?.addEventListener('click',async()=>{
      clear();const button=$('#data-location-preview');button.disabled=true;
      try {
        const plan=await api('/api/data-location/preview',{workspace:$('#data-location-workspace').value.trim(),freetalk:$('#data-location-freetalk').value.trim()});
        const out=$('#data-location-plan');out.innerHTML=UI.template`<p>${esc(plan.notice)}</p><p>読み書きする場所：<code>${esc(plan.workspace)}</code></p>${plan.freetalk?UI.template`<p>自由対話：<code>${esc(plan.freetalk)}</code></p>`:''}<p>プロジェクト ${plan.projects.length} 件</p><ul>${plan.projects.map(p=>`<li>${esc(p.name)}</li>`).join('')}</ul><p class="small">引き続き使う設定：${plan.settings.map(esc).join('、')}</p><button type="button" class="btn" id="data-location-apply">この場所を使う（終了・再開後）</button>`;
        $('#data-location-apply').onclick=async()=>{const go=$('#data-location-apply');go.disabled=true;try{await api('/api/data-location/apply',{token:plan.token,confirm:true});await loadDataLocation();}catch(e){feedback(e.message);clear();}};
      }catch(e){feedback(e.message);}finally{button.disabled=false;}
    });
  }catch(e){box.textContent=UI.text('データの保存先を確認できません。')+e.message;}
}
