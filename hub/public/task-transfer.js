'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
let transferPreview = null, transferPending = false, transferEpoch = 0;
function transferSkippedHint(skipped) {
  return skipped?.count ? UI.template`<p>候補に含められなかった成果があります。子のAIに内容と成果記録の整理を頼んでください。</p>` : '';
}
function drawTaskTransfer(d, paths = '') {
  const sheet = $('#transfer-sheet');
  sheet.innerHTML = UI.template`<div class="remove-box"><h2>「${esc(d.title)}」を本作業へ渡す</h2><p>渡す先：<b>${esc(d.target)}</b></p>
    <p>${d.offer?UI.text('渡し済みを記録して親へ通知します。作業用コピー・会話は残し、取り込みと片付けは親の［統合…］で行います。'):UI.text('成果を保存して本作業へ通知した後、この作業の管理記録・会話をゴミ箱へ移します。成果の元ファイル・共有ファイルは残します。')}</p>
    ${d.resume ? UI.html('<p>前回保存した成果を使って、通知・片付けの残りを続けます。</p>') : UI.template`<p><b>本作業に入るもの：</b>${d.files.map(f=>esc(f.description || f.relative || f.id)).join('、') || (d.resultReady||d.hasCode||d.integrated?UI.text('入れる物なし（記録を渡します）'):UI.text('成果の記録をAIが確認します'))}</p>
    <p><b>すでに反映済み：</b>${(d.results||[]).filter(r=>r.kind==='本体保存済み').map(r=>esc(r.description || r.value)).join('、') || (d.integrated?UI.text('取り込み済みのコード'):UI.text('なし'))}</p>
    ${d.blockers.length?UI.html('<p>子のAIが内容を調べて成果記録を整えます。人がファイルを選ぶ必要はありません。</p><button class="btn plain" data-transfer-action="results" type="button">この子のAIに成果の整理を頼む</button>'):''}
    <details><summary>詳細（確認用）</summary>${d.files.map(f=>UI.template`<p>${esc(f.id)} <small>${f.bytes} bytes</small></p>`).join('')}${d.candidateError?UI.template`<p>候補を確認できませんでした：${esc(d.candidateError)}</p>`:''}${(d.move||[]).map(f=>UI.template`<p>ゴミ箱：${esc(f.path)}</p>`).join('')}${(d.keep||[]).map(f=>UI.template`<p>残す：${esc(f.path)}<br>${esc(f.why)}</p>`).join('')}</details>`}
    <p>${esc(d.guidance)}</p>${d.blockers.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}
    <p id="transfer-status" role="status"></p><div class="acts"><button class="btn plain" data-transfer-action="close" type="button">やめる</button><button class="btn" data-transfer-action="apply" type="button" ${d.blockers.length || !d.resume && !d.integrated?.files?.length && !d.hasCode && !d.resultReady && !d.files?.length?'disabled':''}>${d.resume?UI.text('引渡しの残りを続ける'):d.offer?UI.text('成果を渡す'):UI.text('本作業へ渡して片付ける')}</button></div></div>`;

}
const transferError = e => e.status === 404 && e.message === 'not found' ? transferUpdateMessage() : e.message;
async function showTaskTransfer(project,task,paths = [],expectTitle) {
  if(transferPending)return; const epoch=++transferEpoch;transferPreview=null;
  if(!$('#transfer-sheet'))document.body.insertAdjacentHTML('beforeend',UI.html('<div id="transfer-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="本作業への引渡し確認"></div>'));
  $('#transfer-sheet').hidden=false;$('#transfer-sheet').innerHTML=UI.html('<div class="remove-box"><p>成果と渡す先を確認しています…</p><button class="btn plain" data-transfer-action="close" type="button">閉じる</button></div>');
  try {if(transferNeedsUpdate())throw Error(transferUpdateMessage());const d=await api('/api/task/handup/preview',{project,task,paths,expectTitle}); if(epoch!==transferEpoch)return;transferPreview={...d,project,task,expectTitle};drawTaskTransfer(d,paths.join('\n'));}
  catch(e){if(epoch===transferEpoch)$('#transfer-sheet').innerHTML=UI.template`<div class="remove-box"><p>${esc(transferError(e))}</p><button class="btn plain" data-transfer-action="close" type="button">閉じる</button></div>`;}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-transfer-action]');if(!b||transferPending||b.disabled)return;
  const action=b.dataset.transferAction;
  if(action==='close'){transferEpoch++;$('#transfer-sheet').hidden=true;return;}
  const d=transferPreview;if(!d)return;
  if(action==='refresh'){await showTaskTransfer(d.project,d.task,[],d.expectTitle);return;}
  if(action==='results'){await showTaskIntegration(d.targetProject,d.targetTask,[{project:d.project,task:d.task,expectTitle:d.expectTitle}]);$('#transfer-sheet').hidden=true;return;}
  if(action!=='apply')return;
  transferPending=true;$('#transfer-status').textContent=d.offer?UI.text('渡し済みを記録し、親へ通知しています…'):UI.text('成果を保存し、通知・片付けを進めています…');b.disabled=true;
  try {
    if(transferNeedsUpdate())throw Error(transferUpdateMessage());
    const r=await api('/api/task/handup',{project:d.project,task:d.task,token:d.token,selected:d.files.map(f=>f.id),confirm:true,expectTitle:d.expectTitle});
    view={kind:'work',project:r.parentProject,task:r.parent};save();await load();render();$('#transfer-sheet').hidden=true;toast(r.handedUp?UI.text('成果を渡しました。統合と片付けは親の［統合…］で行います'):UI.text('成果を本作業へ渡し、管理記録をゴミ箱へ移しました'));
  }catch(err){$('#transfer-status').textContent=transferError(err);$('#transfer-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-transfer-action="refresh" type="button">内容を読み直す</button>'));}
  finally{transferPending=false;}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!transferPending&&$('#transfer-sheet')){transferEpoch++;$('#transfer-sheet').hidden=true;}});
