 'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
let maintenanceProject='', maintenanceData=null, maintenanceEpoch=0, maintenancePending=false;
const maintenanceSize=n=>n<1024*1024?`${Math.ceil(n/1024)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
function drawMaintenance() {
  const p=proj(maintenanceProject),d=maintenanceData;if(!p || !d)return;
  const disabled=d.busy||maintenancePending?'disabled':'';
  const stopped=d.stopped||d.excluded[0];
  const records=[...d.history.map(r=>({...r,kind:'cleanup'})),...(d.removed||[]).map(r=>({...r,kind:'remove'}))].sort((a,b)=>b.at.localeCompare(a.at));
  $('#maintenance-title').textContent=p.name+UI.text('：整理と確認');
  $('#maintenance-body').innerHTML=UI.template`<p class="maintenance-status" role="status">${d.busy?UI.text('AIが作業中のため使えません。終わってから押してください。'):UI.text('片付けるものを選び、必要に応じて確認・復元できます。')}</p>
    <h3>① 片付け</h3><p class="small">古い一時ファイルと過去版を探します。資料・成果物・作業台帳・Gitは対象外です。</p>
    <button class="btn plain" data-maint-action="refresh" type="button" ${maintenancePending?'disabled':''}>候補を探す</button>
    <p id="maintenance-preview-status" class="note" role="status">${d.token?d.candidates.length?UI.template`${d.candidates.length}件見つかりました（合計${maintenanceSize(d.candidates.reduce((n,x)=>n+x.bytes,0))}）。移すものを選んでください。`:UI.template`片付けるものはありませんでした。${esc(new Date().toLocaleTimeString('ja-JP'))}`:UI.template`確認しきれず止めました：${esc(stopped?.reason||UI.text('参照を確認できません'))}`}</p>
    ${!d.token&&stopped?.path?UI.template`<p class="small">${esc(stopped.path)} ${stopped.size?`（${maintenanceSize(stopped.size)}）`:''}</p>`:''}
    ${!d.token?UI.html('<p class="small">参照を確認しきれないため移動はできません。下の台帳とリンクの確認は利用できます。資料ファイルの置き場所は人が確認してから変更してください。</p>'):''}
    ${d.candidates.length?UI.template`<label class="maintenance-choice"><input type="checkbox" id="maintenance-select-all" ${disabled}><span><b>すべて選ぶ（${d.candidates.length}件）</b></span></label>`:''}
    ${d.candidates.map(c=>UI.template`<label class="maintenance-choice"><input type="checkbox" data-maint-candidate="${esc(c.id)}" ${disabled}><span><b>${esc(c.label)}</b><small>${c.paths.map(esc).join('<br>')} (${maintenanceSize(c.bytes)})</small></span></label>`).join('')}
    <button class="btn" id="maintenance-apply" data-maint-action="apply" type="button" aria-describedby="maintenance-selection-note" disabled>選んだものをゴミ箱へ移す</button>
    <p id="maintenance-selection-note" class="small">${d.candidates.length?UI.text('移す候補を選んでください。'):UI.text('移せる候補がないため、このボタンは使えません。')}</p>
    <details class="more"><summary>候補の条件・除外した理由（${d.excluded.length}）</summary><p class="small">一時物は7日、過去版・完了作業の会話は30日以上更新がないもの。参照・Git追跡・リンクがあるものは残します。</p>${d.excluded.map(x=>UI.template`<p class="small">${esc(x.path||'')}：${esc(x.reason)}</p>`).join('')}</details>
    <h3 id="maintenance-verify-title">② 確認</h3><p class="small">台帳に書かれた場所とつながりを確認します。アプリが動くかは見ません。</p>
    <button class="btn plain" data-maint-action="verify" type="button" ${disabled}>台帳とリンクを確認</button>
    ${d.scripts.some(s=>s.allowed)?UI.template`<label class="maintenance-choice">アプリのテスト<select id="maintenance-script">${d.scripts.filter(s=>s.allowed).map(s=>UI.template`<option value="${esc(s.name)}">npm run ${esc(s.name)}：${esc(s.command)}</option>`).join('')}</select></label><button class="btn" data-maint-action="test" type="button" ${disabled}>アプリのテストを実行（1分まで）</button>`:UI.html('<p class="small">このプロジェクトには実行できるテストのコマンドがありません。</p>')}
    <div id="maintenance-result" role="status"></div>
    <h3>③ 記録</h3>${d.historyError?UI.template`<p class="note">削除の記録を取得できませんでした：${esc(d.historyError)}</p>`:''}${records.length?records.map(r=>UI.template`<p>${esc(new Date(r.at).toLocaleString('ja-JP'))}・${r.kind==='remove'?UI.text('削除 ')+esc(r.title):UI.text('片付け')}・${r.count}件${r.external?.length?UI.template`（外の場所${r.external.length}件を含む）`:""} ${r.kind==='remove'&&!r.count?UI.text('移したものはありません'):r.restored?UI.text('元に戻しました'):UI.template`<button class="btn plain sm" data-maint-action="${r.kind==='remove'?'unremove':'restore'}" data-transaction="${esc(r.id)}" type="button" ${disabled}>元に戻す</button>`}${r.error?UI.template`<small>${esc(r.error)}</small>`:''}</p>`).join(''):UI.html('<p class="note">記録はまだありません。</p>')}`;
  updateMaintenanceSelection();
}
function maintenanceBusy() {
  if(maintenanceData?.busy)return true;
  if(typeof state==='undefined' || !state)return false;
  const p=proj(maintenanceProject),ids=new Set(p && typeof projectFamily==='function'?projectFamily(p).map(q=>q.id):[maintenanceProject]);
  return [...(state.sessions||[]).filter(s=>s.running),...(state.chatting||[]),...(state.background||[])].some(s=>ids.has(s.project));
}
function syncMaintenanceControls() {
  const blocked=Boolean(maintenancePending || maintenanceBusy());
  document.querySelectorAll('[data-maint-candidate]').forEach(x=>{x.disabled=blocked;});
  const all=$('#maintenance-select-all');if(all)all.disabled=blocked;
  document.querySelectorAll('[data-maint-action]').forEach(x=>{
    x.disabled=x.dataset.maintAction==='refresh'?maintenancePending:blocked || (x.dataset.maintAction==='apply' && !document.querySelectorAll('[data-maint-candidate]:checked').length);
  });
}
function updateMaintenanceSelection() {
  const total=document.querySelectorAll('[data-maint-candidate]').length,selected=document.querySelectorAll('[data-maint-candidate]:checked').length;
  const all=$('#maintenance-select-all');if(all){all.checked=total>0 && selected===total;all.indeterminate=selected>0 && selected<total;}
  syncMaintenanceControls();
  $('#maintenance-selection-note').textContent=selected?UI.template`${selected}件を選択しています。`:maintenanceData?.candidates.length?UI.text('移す候補を選んでください。'):UI.text('移せる候補がないため、このボタンは使えません。');
}
async function refreshMaintenance() {
  const epoch=++maintenanceEpoch, id=maintenanceProject;
  const status=$('#maintenance-preview-status');if(status)status.textContent=UI.text('探しています…');
  try {
    const data=await api('/api/maintenance/preview',{project:id});
    try {data.removed=(await api('/api/hierarchy/remove/history',{})).history||[];} catch(err){data.removed=[];data.historyError=err.message;}
    if(epoch!==maintenanceEpoch || id!==maintenanceProject)return;
    maintenanceData=data;drawMaintenance();
  } catch(err) {
    if(epoch===maintenanceEpoch && id===maintenanceProject) {
      const box=$('#maintenance-preview-status');if(box)box.textContent=UI.text('候補の取得に失敗しました：')+err.message;
    }
    throw err;
  }
}
document.addEventListener('click',async e=>{
  const openBtn=e.target.closest('[data-maintenance]');
  if(openBtn) {if(maintenancePending){toast(UI.text('操作が終わるまでお待ちください'));return;} maintenanceProject=openBtn.dataset.p;$('#maintenance-drawer').hidden=false;$('#maintenance-body').textContent=UI.text('取得しています…');
    try {await refreshMaintenance();if(openBtn.dataset.maintenance==='verify')$('#maintenance-verify-title')?.scrollIntoView({block:'center'});}catch(err){$('#maintenance-body').textContent=err.message;}return;}
  if(e.target.id==='maintenance-close'){$('#maintenance-drawer').hidden=true;return;}
  const btn=e.target.closest('[data-maint-action]');if(!btn || btn.disabled || maintenancePending)return;
  if(maintenanceBusy() && btn.dataset.maintAction!=='refresh'){toast(UI.text('AIが作業中です。終わってから操作してください'));return;}
  const action=btn.dataset.maintAction, project=maintenanceProject;
  let request,result;
  if(action==='apply') {
    const selected=[...document.querySelectorAll('[data-maint-candidate]:checked')].map(x=>x.dataset.maintCandidate);if(!selected.length)return;
    if(!confirm(UI.template`${selected.length}件の候補をゴミ箱へ移しますか？整理の記録から復元できます。会話履歴を選んだ場合、再開は新しい会話になります。`))return;
    request={project,token:maintenanceData.token,selected,confirm:true};
  } else if(action==='unremove') {if(!confirm(UI.text('削除したものを元に戻しますか？同名のファイルは上書きしません。')))return;request={record:btn.dataset.transaction,confirm:true};}
  else if(action==='restore') {if(!confirm(UI.text('この整理でゴミ箱へ移したものを復元しますか？同名のファイルは上書きしません。')))return;request={project,transaction:btn.dataset.transaction,confirm:true};}
  else if(action==='solve') request={project};
  else if(action==='verify'||action==='test') {
    const script=action==='test'?$('#maintenance-script').value:'', choice=maintenanceData.scripts.find(s=>s.name===script);
    if(script && !confirm(UI.template`この検証コマンドを実行しますか？
${script}: ${choice.command}`))return;
    request={project,script,expectedHash:choice?.hash,confirm:true};
  }
  maintenancePending=true;syncMaintenanceControls();
  try {
    if(action==='refresh')await refreshMaintenance();
    else {if(action==='verify'||action==='test')$('#maintenance-result').textContent=UI.text('確認しています…');
      result=await api(action==='unremove'?'/api/hierarchy/remove/restore':'/api/maintenance/'+(action==='test'?'verify':action),request);
      if(action==='verify'||action==='test') {
        const box=$('#maintenance-result');box.innerHTML=UI.template`<p><b>${result.ok?UI.text('選んだ範囲に問題は見つかりませんでした'):UI.template`${result.checks.filter(c=>!c.ok).length}件の問題が見つかりました`}</b></p>${result.checks.map(c=>UI.template`<p class="small">${c.ok?'✓':'×'} ${esc(c.name)}${c.detail?'：'+esc(c.detail):''}</p>`).join('')}<p>${esc(result.note)}</p>${result.result?UI.template`<p>${esc(result.result.command)}：${result.result.ok?UI.text('成功'):UI.text('失敗')} ${esc(result.result.note||'')}</p><pre>${esc(result.result.output.split(/\r?\n/).slice(-12).join("\n"))}</pre>`:''}${result.checks.some(c=>c.ok===false)?UI.html('<button class="btn" data-maint-action="solve" type="button" disabled>問題解決</button>'):''}`;
      } else if(action==='solve') {
        if(result.clear) {$('#maintenance-result').textContent=result.note;toast(result.note);}
        else {
          try {localStorage.setItem('hub-mode','chat');} catch(err) { /* 無視 */ }
          $('#maintenance-drawer').hidden=true;view={kind:'work',project,task:result.task};save();await load();
          toast(result.active?UI.text('進行中の問題解決を開きました'):result.reused?UI.text('問題解決の続きをAIに頼みました'):UI.text('問題解決を作ってAIに頼みました'));
        }
      } else {await refreshMaintenance();const note=result.error || (action==='apply'?UI.template`${result.moved}件をゴミ箱へ移しました`:UI.template`${result.restored}件を元に戻しました${result.skipped?.length?UI.text('。残した理由：')+result.skipped.map(x=>x.why).join(' / '):''}`);$('#maintenance-result').textContent=note;toast(note);await load();}
    }
  } catch(err){toast(err.message);const box=$('#maintenance-result');if(box) {if(action==='solve')box.innerHTML=UI.template`<p>${esc(err.message)}</p><button class="btn" data-maint-action="solve" type="button" disabled>問題解決</button>`;else box.textContent=err.message;}}
  finally {maintenancePending=false;updateMaintenanceSelection();}
});
document.addEventListener('change',e=>{
  if(e.target.id==='maintenance-select-all'){
    document.querySelectorAll('[data-maint-candidate]').forEach(x=>{x.checked=e.target.checked;});
    updateMaintenanceSelection();
  } else if(e.target.dataset.maintCandidate!==undefined)updateMaintenanceSelection();
});
// 一覧が描き直される前に、押した項目の所属を確認する。
document.addEventListener('click',e=>{
  const go=e.target.closest('#list [data-go][data-p]');
  if(go && go.dataset.p!==maintenanceProject)$('#maintenance-drawer').hidden=true;
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#maintenance-drawer').hidden=true;});
