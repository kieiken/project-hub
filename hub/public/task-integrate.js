'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
let integratePreview=null,integrateBusy=false,integrateEpoch=0;
const integrateKey=x=>x.project+'\0'+x.task;
function integrateChoices(){
  const d=integratePreview;if(!d||d.resume)return;
  document.querySelectorAll('[data-integrate-item]').forEach(el=>{
    const i=d.items[Number(el.dataset.integrateItem)];if(!i)return;
    i.checked=Boolean(el.querySelector('[data-integrate-check]')?.checked);

  });
}
function integrationConflictHint(preview){
  if(!preview?.conflict)return '';
  return preview.conflictKind==='bookkeeping'?UI.html('<p>版・履歴だけぶつかる（自動で合わせます）</p>'):UI.template`<p class="danger">コードがぶつかる：${(preview.conflictPaths||[]).map(esc).join('、')}（AIで解消が必要）</p>`;
}
function integrationProgress(i,n,d){
  const label=i.retained?UI.text('片付け済み（保持します）'):i.state==='片付け済み'?UI.text('済'):i.state==='衝突'?UI.text('後回し（衝突）'):i.waitingFor?.length?UI.text('待ち（子孫の衝突待ち）'):i.receiving?UI.text('受領中'):i.state;
  return UI.template`<section><p>${esc(i.title)}：${esc(label)}${i.autoResolved?UI.template` ／ 自動で合わせた版 ${esc(i.autoResolved.from)}→${esc(i.autoResolved.to)}`:''}${!i.retained?` ／ ${i.receiving?UI.text('受領・片付けの保存済み段階から続けます'):UI.template`${i.codeAlready?UI.text('コード取り込み済み（確認）'):UI.text('コード取り込み・成果確認はこれから')} ／ 受領・片付けはこれから`}`:''}${i.recordChanged?UI.text(' ／ 記録の更新あり'):''}${i.sourceChanged?UI.text(' ／ 変更の更新あり'):''}</p>${i.state==='衝突'?UI.template`<p>コードがぶつかる：${(i.conflictPaths||[]).map(esc).join('、')}</p><button class="btn plain sm" data-integrate-action="resolve" data-index="${n}" type="button" ${d.blockers?.length||d.recover?'disabled':''}>AIでぶつかりを解消</button>`:''}</section>`;
}
function drawTaskIntegration(){
  const d=integratePreview,sheet=$('#integrate-sheet');
  sheet.innerHTML=UI.template`<div class="remove-box"><h2>${d.resume?UI.text('統合の続きを行う'):UI.text('子作業の成果を統合する')}</h2><p>統合先：${esc(d.target)}</p>${d.recover?UI.template`<section><h3>復旧内容を確認してください</h3><p>保存された統合先：${esc(d.recover.savedTarget)}<br>現在の統合先：${esc(d.recover.currentTarget)}</p>${d.recover.reasons.map(x=>UI.template`<p>${esc(x)}</p>`).join('')}</section>`:''}${(d.blockers||[]).map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}<p>1件ずつ統合し、成果を保存した後に、その子のコピー・管理記録・専用一時フォルダをゴミ箱へ移します。版・履歴だけは自動で合わせ、コードがぶつかった子は後回しにして残りを進めます。済んだ子の成果は保持します。</p><p>予測は今の統合先との比較です。前の子を取り込むと結果が変わる場合があります。</p>
    ${d.items.map((i,n)=>d.resume?integrationProgress(i,n,d):UI.template`<section class="integration-item" data-integrate-item="${n}"><label class="maintenance-choice"><input type="checkbox" data-integrate-check ${i.checked?'checked':''} ${i.blockers.length?'disabled':''}><b>${esc(i.route || i.title)}</b></label><p>${i.handedUp?UI.text('渡し済み'):i.needsResults?UI.text('AIによる成果整理が必要'):UI.text('成果の記録・専用成果を確認')} ／ 変更 ${i.preview?.files || i.integrated?.files?.length || 0} ファイル</p>
    ${integrationConflictHint(i.preview)}${i.preview?.mainDirty?UI.html('<p>統合先に未保存の変更があります。統合前に保存します。</p>'):''}${i.overlaps?.length?UI.template`<p>変更ファイルが重なる子：${i.overlaps.map(esc).join('、')}</p>`:''}
    ${transferSkippedHint(i.skipped, true)}
    ${i.blockers.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}
    <div class="acts"><button class="btn plain sm" data-integrate-action="up" data-index="${n}" type="button" ${n===0?'disabled':''}>↑</button><button class="btn plain sm" data-integrate-action="down" data-index="${n}" type="button" ${n===d.items.length-1?'disabled':''}>↓</button></div>
    <p><b>本作業に入るもの：</b>${i.copy?UI.text('作業用コピーの変更')+(i.files.length?'、':''):''}${i.files.length?i.files.map(f=>esc(f.description || f.relative || f.id)+( /\.(zip|tgz|gz|tar|7z)$/i.test(f.relative || f.id)?UI.text('（配布用の圧縮物）'):'')).join('、'):i.copy?'':i.resultReady||i.integrated?UI.text('入れる物なし（記録を受領）'):UI.text('成果の記録をAIが確認します')}</p>
    <p><b>すでに反映済み：</b>${(i.results||[]).filter(r=>r.kind==='本体保存済み').map(r=>esc(r.description || r.value)).join('、') || (i.integrated?UI.text('取り込み済みのコード'):UI.text('なし'))}</p>
    <p><b>片付けるもの：</b>${i.copy?UI.text('作業用コピー、'):''}子の管理記録・会話・照合できた専用一時フォルダ${i.optional.length?UI.text('、受領後の専用作業・添付フォルダ'):''}（ゴミ箱へ。正本や参照中の物は残します）</p>
    ${i.needsResults?UI.template`<button class="btn plain" data-integrate-action="results" data-index="${n}" type="button">この子のAIに成果の整理を頼む</button>`:''}
    ${i.retainedFolders?.length?UI.html('<p>未受領の内容がある専用フォルダは、そのまま残します。</p>'):''}
    <details><summary>詳細（確認用）</summary>${i.files.map(f=>UI.template`<p>${esc(f.id)} <small>${f.bytes} bytes</small></p>`).join('')}${(i.results||[]).map(r=>UI.template`<p>${esc(r.kind)}：${esc(r.value)}</p>`).join('')}${i.copy?UI.html('<p>ゴミ箱：作業用コピー全体（中の一時ファイルも含む）</p>'):''}${[...i.move,...i.optional].map(f=>UI.template`<p>ゴミ箱：${esc(f.path)}</p>`).join('')}${i.keep.map(f=>UI.template`<p>残す：${esc(f.path)}<br>${esc(f.why)}</p>`).join('')}<p>残す：受け取った成果、共有ファイル、資料原本、操作・受領・統合・復元の記録。既存の正本は重ねてコピーせず保持します。</p></details></section>`).join('')}
    ${d.items.length?'':UI.html('<p>今、統合できる完了子作業はありません。</p>')}<p id="integrate-status" role="status"></p><div class="acts"><button class="btn plain" data-integrate-action="close" type="button">やめる</button><button class="btn" data-integrate-action="apply" type="button" ${d.blockers?.length||(!d.resume&&!d.items.some(i=>i.checked))?'disabled':''}>${d.recover?(d.recover.savedTarget===d.recover.currentTarget?UI.text('子の更新を確認して続ける'):UI.text('統合先を現在の場所に切り替えて続ける')):d.resume?UI.text('統合の続きを行う'):UI.text('統合して片付ける')}</button></div></div>`;
}
async function showTaskIntegration(project,task,only){
  if(integrateBusy)return;const epoch=++integrateEpoch;integratePreview=null;
  if(!$('#integrate-sheet'))document.body.insertAdjacentHTML('beforeend',UI.html('<div id="integrate-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="子作業の統合確認"></div>'));
  const sheet=$('#integrate-sheet');sheet.hidden=false;sheet.innerHTML=UI.html('<div class="remove-box"><p>子作業の成果と統合先を確認しています…</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>');
  try{const d=await api('/api/task/integrate/preview',{project,task,only});if(epoch!==integrateEpoch)return;integratePreview={...d,project,task,only};if(!d.resume)for(const i of d.items){i.checked=!i.blockers.length;}drawTaskIntegration();}
  catch(e){if(epoch===integrateEpoch)sheet.innerHTML=UI.template`<div class="remove-box"><p>${esc(transferError(e))}</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>`;}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-integrate-action]');if(!b||b.disabled||integrateBusy)return;
  const action=b.dataset.integrateAction;
  if(action==='close'){integrateEpoch++;$('#integrate-sheet').hidden=true;return;}
  const d=integratePreview;if(!d)return;
  integrateChoices();
  if(action==='up'||action==='down'){const n=Number(b.dataset.index),to=n+(action==='up'?-1:1);if(to>=0&&to<d.items.length){[d.items[n],d.items[to]]=[d.items[to],d.items[n]];drawTaskIntegration();}return;}
  if(action==='refresh'){await showTaskIntegration(d.project,d.task,d.only);return;}
  if(action==='resolve'||action==='results'){
    const i=d.items[Number(b.dataset.index)];if(!i)return;
    integrateBusy=true;b.disabled=true;
    try{await api(action==='results'?'/api/task/integrate/results':'/api/task/integrate/resolve',{project:d.project,task:d.task,childProject:i.project,childTask:i.task,token:d.token});$('#integrate-sheet').hidden=true;await load();render();toast(action==='results'?UI.text('子の会話で成果の整理を依頼しました。AI終了後に統合を確認してください'):UI.text('親の会話でぶつかりの解消を依頼しました。AI終了後に統合の続きを確認してください'));}
    catch(e){$('#integrate-status').textContent=transferError(e);}
    finally{integrateBusy=false;}
    return;
  }
  if(action!=='apply')return;
  integrateBusy=true;b.disabled=true;$('#integrate-status').textContent=UI.text('成果を統合し、保存と片付けを進めています…');
  try{
    const selected=d.resume?undefined:d.items.filter(i=>i.checked).map(i=>({project:i.project,task:i.task}));
    const out=await api('/api/task/integrate',{project:d.project,task:d.task,token:d.token,selected,confirm:true,recover:Boolean(d.recover)});
    if(out.partial){integrateBusy=false;await load();render();await showTaskIntegration(d.project,d.task,d.only);return;}
    await load();render();$('#integrate-sheet').hidden=true;toast(UI.text('成果を統合し、成功した子をゴミ箱へ移しました'));
  }catch(e){$('#integrate-status').textContent=transferError(e);$('#integrate-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-integrate-action="refresh" type="button">続きを確認する</button>'));await load();}
  finally{integrateBusy=false;}
});
document.addEventListener('change',e=>{
  if(!e.target.closest?.('[data-integrate-item]')||integrateBusy)return;
  integrateChoices();const d=integratePreview;if(!d||d.resume)return;
  if(e.target.matches?.('[data-integrate-check]')){
    const i=d.items[Number(e.target.closest('[data-integrate-item]').dataset.integrateItem)];
    if(i.checked)for(const child of i.descendants){const x=d.items.find(x=>integrateKey(x)===integrateKey(child));if(x&&!x.blockers.length)x.checked=true;}
    else for(const parent of d.items)if(parent.descendants.some(x=>integrateKey(x)===integrateKey(i)))parent.checked=false;
    drawTaskIntegration();
  }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!integrateBusy&&$('#integrate-sheet')){integrateEpoch++;$('#integrate-sheet').hidden=true;}});
