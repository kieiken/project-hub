'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
let integratePreview=null,integrateBusy=false,integrateEpoch=0,integrateWaitTimer=null,integrateWaitRequest=null,integratePreviewRequest=null;
const integrateKey=x=>x.project+'\0'+x.task;
// Keep unknown sends independently of the visible sheet. A later stop in the
// same integration is a new generation; a running integration has no stop key.
const integrateResumeUncertain=new Set();
// Each fingerprint remembers its own send. Only that send's explicit
// not-sent reply can retire it, even after the visible sheet has changed.
const integrateRecordUncertain=new Map();
const integrateStartUncertain=new Set(),integrateKeepUncertain=new Set();
const integrationStartKey=d=>JSON.stringify([d.project,d.task,d.sibling===true,d.stoppedSibling||null,d.ancestorHash,d.targetSnapshot?.head,d.items.map(i=>[i.project,i.task,i.taskHash,i.source?.head,i.keep])]);
const integrationKeepKey=(d,i)=>JSON.stringify([d.project,d.task,i.project,i.task,i.taskHash]);
function integrationSimpleUncertainty(d){
  if(d.auto||!d.simple)return;
  if(integrateStartUncertain.has(integrationStartKey(d))||d.items.some(i=>integrateKeepUncertain.has(integrationKeepKey(d,i)))){
    d.requiresRefresh=true;d.refreshMessage=UI.text('通信結果が不明です。同じ範囲への再送はしません。最新の記録を確認してください');
  }
}
function integrationStopKey(d){
  if(!d?.id||!d.auto?.stopped)return null;
  return JSON.stringify([d.project,d.task,d.id,d.auto.stopped.at??null,d.auto.resumed?.length||0]);
}
function integrationRememberUncertain(d){
  const key=integrationStopKey(d);if(key)integrateResumeUncertain.add(key);
  d.resumeUncertain=true;
}
function integrateChoices(){
  const d=integratePreview;if(!d||d.resume||d.simple)return;
  document.querySelectorAll('[data-integrate-item]').forEach(el=>{
    const i=d.items[Number(el.dataset.integrateItem)];if(!i)return;
    i.checked=Boolean(el.querySelector('[data-integrate-check]')?.checked);
    i.disposition=el.querySelector('[data-integrate-mode]')?.value||(i.partial?'partial':i.disposition||'continue');
    for(const input of el.querySelectorAll('[data-integrate-review]'))i.review[input.dataset.integrateReview]=input.value;
    for(const input of el.querySelectorAll('[data-cleanup-audit]')){i.cleanupAudit ||= {};i.cleanupAudit[input.dataset.cleanupAudit]=input.value;}
    if(el.querySelector('[data-integrate-confirm]'))i.review.confirmed=Boolean(el.querySelector('[data-integrate-confirm]')?.checked);

  });
}
function integrationAssignmentPanel(d){
  const p=d.assignmentPolicy||d.auto?.assignmentPolicy;if(!p)return '';
  return '<section data-integration-assignment><b>今回の統合担当</b>'+['organize','code','review'].map(k=>'<p>'+esc(({organize:'整理',code:'解消・順番',review:'独立確認'})[k]+'：'+p.slots[k].ai+' / '+p.slots[k].model)+'</p>').join('')+'<p>上限時は担当を替えず解除まで待機します</p></section>';
}
const integrationReviewFields=['scope','planned','undecided','residual','evidence'];
const integrationReviewLabels=['今回取り込む範囲','今後の予定','判断待ち','残件','確認資料・レビュー結果'];
function integrationApplyState(){
  if(integratePreview?.simple){integrationSimpleState();return;}
  const d=integratePreview,b=$('#integrate-sheet [data-integrate-action="apply"]');if(!d||!b)return;
  b.disabled=integrateBusy||Boolean(d.waiting?.length)||Boolean(d.auto?.stopped)||Boolean(d.auto)||Boolean(d.requiresRefresh)||Boolean(d.blockers?.length)||(!d.resume&&!d.items.some(i=>i.checked));
  b.textContent=UI.text(d.waiting?.length?'稼働中の処理の終了待ち':'統合を始める');
  const resume=$('#integrate-sheet [data-integrate-action="resume"]');if(resume)resume.disabled=integrateBusy||Boolean(d.waiting?.length)||Boolean(d.resumeUncertain)||d.resumeAllowed===false||Boolean(d.requiresRefresh)||Boolean(d.blockers?.length)||Boolean(d.recover);
  for(const button of document.querySelectorAll('#integrate-sheet [data-integrate-action="resolve"], #integrate-sheet [data-integrate-action="results"]'))button.disabled=integrateBusy||Boolean(d.requiresRefresh)||Boolean(d.blockers?.length)||Boolean(d.recover);
}
function integrationLock(){
  const controls=[...document.querySelectorAll('#integrate-sheet button, #integrate-sheet input, #integrate-sheet select, #integrate-sheet textarea')].map(el=>[el,el.disabled]);
  for(const [el]of controls)el.disabled=true;
  return ()=>{for(const [el,disabled]of controls)el.disabled=disabled;integrationApplyState();};
}
function integrationInputIssue(d){
  if(d.resume){if(d.legacy&&!$('#integrate-legacy')?.checked)return {selector:'#integrate-legacy',message:UI.text('旧確認：片付けを含む元の範囲を確認しました')};return null;}
  for(let n=0;n<d.items.length;n++){
    const i=d.items[n];if(!i.checked)continue;
    const issue=(field,message)=>({selector:`[data-integrate-item="${n}"] ${field}`,message:i.title+'：'+message});
    for(let k=0;k<integrationReviewFields.length;k++){
      const field=integrationReviewFields[k],value=i.review[field];
      if(typeof value!=='string'||!value.trim()||value.length>10000)return issue(`[data-integrate-review="${field}"]`,UI.text(integrationReviewLabels[k])+' — '+UI.text('空欄を埋め、10000文字以内で記入してください'));
    }
    if(i.disposition==='cleanup'&&![i.review.residual,i.review.undecided].every(v=>['なし',UI.text('なし')].includes(v.trim())))return issue('[data-integrate-mode]',UI.text('残件・判断待ち・子孫があるため作業を続けてください'));
    if(!i.review.confirmed||i.review.sourceHead!==(i.source?.head||null))return issue('[data-integrate-confirm]',UI.text('このHEAD全体・成果一式と残件を確認しました'));
  }
  return null;
}
function integrationShowIssue(issue){
  $('#integrate-status').textContent=issue.message;
  const input=$('#integrate-sheet '+issue.selector);input?.focus();input?.scrollIntoView?.({block:'center'});
}
function integrationRequireRefresh(message){
  clearTimeout(integrateWaitTimer);
  integratePreview.requiresRefresh=true;integratePreview.refreshMessage=message;
  $('#integrate-status').textContent=[integratePreview.selectionNotice,message].filter(Boolean).join('\n');
  $('#integrate-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-integrate-action="refresh" type="button">最新の記録を確認する</button>'));
  integrationApplyState();
}
function integrationWaitState(waiting,phase='waiting'){
  const d=integratePreview;if(!d)return;
  d.waiting=waiting;delete d.token;delete d.requiresRefresh;
  const status=$('#integrate-status');status.dataset.waitPhase=phase;
  const automatic=Boolean(d.auto&&!d.auto.stopped);
  status.textContent=UI.text(phase==='checking'?'待機状況を自動確認しています…':phase==='busy'?'操作中です。完了後に待機状況を自動確認します':phase==='hidden'?'画面に戻ると待機状況を自動確認します':'待機が続いています。15秒ごとに自動確認します')+' '+UI.text(automatic?'開始済みの統合は待機中です':d.resume?'統合の再開は待機中です':'統合の開始は待機中です')+'：'+waiting.map(x=>x.message).join(' / ')+' '+UI.text(automatic?'稼働中のAI・処理が終わると、開始済みの統合を自動で続けます。追加操作は不要です':'稼働中のAI・処理があるため押せません。自動では開始・再開しません');
  if(d.selectionNotice)status.textContent=d.selectionNotice+'\n'+status.textContent;
  integrationApplyState();integrationScheduleWait();
}
function integrationScheduleWait(){
  clearTimeout(integrateWaitTimer);
  if(!integratePreview||integratePreview.requiresRefresh||$('#integrate-sheet')?.hidden)return;
  const epoch=integrateEpoch;
  integrateWaitTimer=setTimeout(()=>{void (integratePreview?.waiting?.length?integrationCheckWait(epoch):integrationCheckLatest(epoch));},15000);
}
async function integrationCheckLatest(epoch=integrateEpoch){
  const d=integratePreview;if(epoch!==integrateEpoch||!d||$('#integrate-sheet')?.hidden)return;
  if(integrateBusy||document.hidden){integrationScheduleWait();return;}
  const request={epoch};integrateWaitRequest=request;
  try{
    const out=await api('/api/task/integrate/preview',{project:d.project,task:d.task,only:d.only,simple:true,sibling:d.sibling===true});
    if(epoch!==integrateEpoch||integrateWaitRequest!==request||integratePreview!==d||integrateBusy||d.requiresRefresh||d.resumeUncertain||$('#integrate-sheet')?.hidden)return;
    if(out.waiting?.length){integratePreview={...out,project:d.project,task:d.task,only:d.only};integrationRestoreSelection(integratePreview,d);drawTaskIntegration();}
    else if(out.confirmationHash!==d.confirmationHash){integratePreview={...out,project:d.project,task:d.task,only:d.only};integrationRestoreSelection(integratePreview,d);drawTaskIntegration();integrationRequireRefresh(UI.text('統合対象・成果・保存先が変わりました。最新の記録を確認してください'));}
    else {integratePreview={...out,project:d.project,task:d.task,only:d.only};integrationRestoreSelection(integratePreview,d);if(JSON.stringify(out.items.map(i=>i.waiting))!==JSON.stringify(d.items.map(i=>i.waiting)))drawTaskIntegration();else integrationApplyState();}
  }catch(e){if(epoch===integrateEpoch&&integrateWaitRequest===request&&integratePreview===d&&!integrateBusy)integrationRequireRefresh(transferError(e));}
  finally{if(integrateWaitRequest===request){integrateWaitRequest=null;integrationScheduleWait();}}
}
async function integrationCheckWait(epoch=integrateEpoch){
  const d=integratePreview;if(epoch!==integrateEpoch||!d?.waiting?.length||$('#integrate-sheet')?.hidden)return;
  if(integrateBusy||document.hidden){integrationWaitState(d.waiting,document.hidden?'hidden':'busy');return;}
  const request={epoch};integrateWaitRequest=request;
  integrateBusy=true;integrationWaitState(d.waiting,'checking');
  try{
    const out=await api('/api/task/integrate/wait?project='+encodeURIComponent(d.project)+'&task='+encodeURIComponent(d.task)+(d.id?'&id='+encodeURIComponent(d.id):'')+(d.sibling?'&sibling=true':''));
    if(epoch!==integrateEpoch||integrateWaitRequest!==request||$('#integrate-sheet')?.hidden)return;
    if(!Array.isArray(out?.waiting))throw Error(UI.text('待機状況を確認できません'));
    if(out.waiting.length)integrationWaitState(out.waiting);
    else {integrateWaitRequest=null;integrateBusy=false;await showTaskIntegration(d.project,d.task,d.only,true,d.sibling===true);}
  }catch(e){if(epoch===integrateEpoch&&integrateWaitRequest===request&&!$('#integrate-sheet')?.hidden){const status=$('#integrate-status');status.dataset.waitPhase='failed';status.textContent=UI.text('待機状況の確認に失敗しました。開始・再開せず、15秒後に再確認します')+'：'+transferError(e);integrationScheduleWait();}}
  finally{if(integrateWaitRequest===request){integrateWaitRequest=null;integrateBusy=false;integrationApplyState();}}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&integratePreview?.waiting?.length&&!$('#integrate-sheet')?.hidden){clearTimeout(integrateWaitTimer);void integrationCheckWait();}});
// Text is only a draft after a new preview. Never carry approval to a new token.
function integrationRestoreDraft(d,previous){
  if(!previous||previous.resume||d.resume||previous.project!==d.project||previous.task!==d.task)return;
  const rank=new Map(previous.items.map((i,n)=>[integrateKey(i),n]));
  d.items.sort((a,b)=>(rank.get(integrateKey(a))??Infinity)-(rank.get(integrateKey(b))??Infinity));
  for(const i of d.items){
    const old=previous.items.find(x=>integrateKey(x)===integrateKey(i));if(!old)continue;
    i.checked=old.checked&&!i.blockers.length;
    i.disposition=i.partial?'partial':old.disposition==='cleanup'&&!i.cleanupBlockers?.length?'cleanup':'continue';
    i.review={...i.review,...Object.fromEntries(integrationReviewFields.map(k=>[k,old.review?.[k]??i.review?.[k]??''])),sourceHead:i.source?.head||null,confirmed:false};
  }
}
function integrationRestoreSelection(d,previous){
  if(!d.simple)return;
  for(const i of d.items)i.selected=false;
  if(previous?.sibling!==d.sibling||!previous?.simple||previous.auto||d.auto||previous.resume||d.resume||previous.project!==d.project||previous.task!==d.task)return;
  const removed=[];
  for(const old of previous.items.filter(i=>i.selected)){
    const i=d.items.find(i=>integrateKey(i)===integrateKey(old));
    if(i?.startable&&!i.noop)i.selected=true;else removed.push(old.title);
  }
  if(removed.length)d.selectionNotice=UI.template`選べなくなった作業を外しました：${removed.join('、')}`;
}
function integrationConflictHint(preview){
  if(!preview?.conflict)return '';
  return preview.conflictKind==='bookkeeping'?UI.html('<p>版・履歴だけぶつかる（自動で合わせます）</p>'):UI.template`<p class="danger">コードがぶつかる：${(preview.conflictPaths||[]).map(esc).join('、')}（AIで解消が必要）</p>`;
}
function integrationProgress(i,n,d){
  const label=i.retained?UI.text(i.state==='受領済み'?UI.text('途中受領済み（子は継続中）'):i.state==='保持受領済み'?'受領済み（作業を保持）':'片付け済み'):i.state==='片付け済み'?UI.text('済'):i.codeAlready?UI.text('取り込み済み（受領待ち）'):i.state==='衝突'?UI.text('解消待ち'):i.waitingFor?.length?UI.text('待ち（子孫の衝突待ち）'):i.receiving?UI.text('受領中'):i.state;
  return UI.template`<section><p>${esc(i.title)}：${esc(label)}${i.autoResolved?UI.template` ／ 自動で合わせた版 ${esc(i.autoResolved.from)}→${esc(i.autoResolved.to)}`:''}${!i.retained?` ／ ${i.receiving?UI.text(i.partial?'途中受領の保存済み段階から続けます':'受領・片付けの保存済み段階から続けます'):UI.template`${i.codeAlready?UI.text('コード取り込み済み（確認）'):UI.text('コード取り込み・成果確認はこれから')} ／ 受領・片付けはこれから`}`:''}${i.recordChanged?UI.text(' ／ 記録の更新あり'):''}${i.sourceChanged?UI.text(' ／ 変更の更新あり'):''}</p>${i.state==='衝突'&&!i.codeAlready?UI.template`<p>コードがぶつかる：${(i.conflictPaths||[]).map(esc).join('、')}</p>`:''}</section>`;
}
function integrationApplyLabel(d){const modes=new Set(d.items.filter(i=>i.checked).map(i=>i.disposition||'continue'));return UI.text(modes.size>1?'選んだ内容で取り込む':modes.has('cleanup')?'取り込んで片付ける':modes.has('partial')?'途中の成果を受け取る（子は残す）':'成果を取り込んで続ける');}
function drawTaskIntegration(){
  if(integratePreview?.simple){drawSimpleIntegration();return;}
  const d=integratePreview,sheet=$('#integrate-sheet');for(const i of d.items)i.review ||= {};
  const running=Boolean(d.auto),stopped=d.auto?.stopped;
  sheet.innerHTML=UI.template`<div class="remove-box history-box"><header><h2>${UI.text('子作業の成果を統合する')}</h2><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></header><div class="history-content"><p>統合先：${esc(d.target)}</p>${(stopped||d.auto?.thenMain===false)?UI.html('<p>ぶつかりの解消・検証・正式受領を続けます。本体への反映は別に確認してください。</p>'):UI.html('<p>開始後は、ぶつかりの解消・検証・正式受領・本体への取り込みまで自動で続けます。新しい版の起動は人が行います。</p>')}${stopped?UI.template`<p class="danger">${UI.text('停止')}: ${esc(UI.text(stopped.reason))}</p>`:''}${(d.blockers||[]).map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}${d.recover?UI.template`<p>保存された統合先：${esc(d.recover.savedTarget)}<br>現在の統合先：${esc(d.recover.currentTarget)}</p>`+d.recover.reasons.map(x=>UI.template`<p>${esc(x)}</p>`).join(''):''}${d.legacy?UI.html('<label><input type="checkbox" id="integrate-legacy">旧確認：片付けを含む元の範囲を確認しました</label>'):''}
  ${d.items.map((i,n)=>d.resume?integrationProgress(i,n,d):UI.template`<section class="integration-item" data-integrate-item="${n}"><label class="maintenance-choice"><input type="checkbox" data-integrate-check ${i.checked?'checked':''} ${i.blockers.length?'disabled':''}><b>${esc(i.route||i.title)}</b></label><p>${UI.text('残件')}: ${esc(UI.text(i.remaining?.status||'不明'))}<br>${esc(i.remaining?.items||UI.text('未確認'))}<br>${UI.text('判断待ち')}: ${esc(i.remaining?.undecided||UI.text('未確認'))}</p>${i.blockers.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}${integrationConflictHint(i.preview)}${i.alreadyReceived?UI.html('<p>受領済み（追加成果なし）</p>'):''}<p>${UI.text('受領後の扱い')}: ${UI.text(i.disposition==='cleanup'?'取り込んで片付ける':'成果を取り込んで続ける')}</p>${!i.partial?UI.template`<details><summary>扱いを変更する</summary><select data-integrate-mode><option value="continue" ${i.disposition==='continue'?'selected':''}>成果を取り込んで続ける</option><option value="cleanup" ${i.disposition==='cleanup'?'selected':''} ${i.cleanupBlockers?.length||i.remaining?.status==='あり'?'disabled':''}>取り込んで片付ける</option></select></details>`:''}<details><summary>本作業に入るもの・確認資料</summary>${i.copy?UI.html('<p>作業用コピーの変更</p>'):''}${(i.results||[]).map(r=>UI.template`<p>${UI.text(r.kind==='本体保存済み'?'Gitに保存済み':r.kind)}：${esc(r.description||r.value)}</p>`).join('')}<p>${esc(i.source?.head||UI.text('コード変更なし'))}</p>${i.files.map(f=>UI.template`<p>${esc(f.description||f.id)}</p>`).join('')}<p>${esc(i.remaining?.evidence||UI.text('未確認'))}</p><p>${esc((i.remainingSteps||[]).join('\n'))}</p></details>${i.retainedFolders?.length?UI.html('<p>未受領の内容がある専用フォルダは、そのまま残します</p>'):''}${i.partial?UI.html('<p>渡し済みの途中成果は固定範囲で受領し、子は残します</p>'):''}${i.needsRemaining&&!i.partial?UI.template`<details><summary>残件を確認して片付ける</summary><p>作業本文・未採用案・未確認項目を確認し、残件と判断待ちがない場合だけ片付けます。</p><label class="continuation-field">残件<textarea data-cleanup-audit="items">${esc(i.cleanupAudit?.items||'')}</textarea></label><label class="continuation-field">判断待ち<textarea data-cleanup-audit="undecided">${esc(i.cleanupAudit?.undecided||'')}</textarea></label><label class="continuation-field">完了を確認した根拠<textarea data-cleanup-audit="evidence">${esc(i.cleanupAudit?.evidence||'')}</textarea></label></details>`:''}${i.needsResults||i.needsRemaining?UI.template`<button class="btn plain" data-integrate-action="results" data-index="${n}" type="button">この子のAIに成果の整理を頼む</button>`:''}</section>`).join('')}<p id="integrate-status" role="status">${d.auto?.main?.state==='done'?UI.text(d.auto.main.skipped?'子作業の受領が完了しました。本体への反映は別に確認してください':'本体に取り込み済み・新しい版を待っています'):''}</p></div><footer class="acts">${stopped?UI.html('<button class="btn" data-integrate-action="resume" type="button">統合を再開</button>'):''}${running&&!stopped?UI.html('<button class="btn warn" data-integrate-action="stop" type="button">停止</button>'):''}<button class="btn plain" data-integrate-action="close" type="button">閉じる</button><button class="btn" data-integrate-action="apply" type="button" ${running||stopped||d.blockers?.length||(!d.resume&&!d.items.some(i=>i.checked))?'disabled':''}>統合を始める</button></footer></div>`;
  if(d.waiting?.length)integrationWaitState(d.waiting);
  else if(d.resumeUncertain)integrationRequireRefresh(UI.text('再開の通信結果が不明です。同じ停止記録への再送はしません。最新の記録を確認してください'));
  else if(d.requiresRefresh)integrationRequireRefresh(d.refreshMessage);
  integrationApplyState();
}
async function showTaskIntegration(project,task,only,waitEnded=false,sibling=false){
  if(integrateBusy)return;clearTimeout(integrateWaitTimer);integrateWaitRequest=null;const epoch=++integrateEpoch;integratePreviewRequest={epoch};const previous=integratePreview?.project===project&&integratePreview?.task===task&&(!integratePreview.simple||!$('#integrate-sheet')?.hidden)?integratePreview:null;integrateBusy=true;
  if(!$('#integrate-sheet'))document.body.insertAdjacentHTML('beforeend',UI.html('<div id="integrate-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="子作業の統合確認"></div>'));
  const sheet=$('#integrate-sheet');sheet.hidden=false;sheet.innerHTML=UI.html('<div class="remove-box"><p>子作業の成果と統合先を確認しています…</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>');
  try{const d=await api('/api/task/integrate/preview',{project,task,only,simple:true,sibling});if(epoch!==integrateEpoch)return;if(!d.resume&&!d.simple){d.items=[...d.items,...(d.retainedItems||[])];}integratePreview={...d,project,task,only};if(integrateResumeUncertain.has(integrationStopKey(integratePreview)))integratePreview.resumeUncertain=true;if(!d.resume&&!d.simple)for(const i of d.items){i.checked=!i.alreadyReceived&&!i.blockers.length;i.disposition=i.partial?'partial':i.remaining?.status==='なし'&&!i.cleanupBlockers?.length?'cleanup':'continue';}if(d.simple)integrationRestoreSelection(integratePreview,previous);else integrationRestoreDraft(integratePreview,previous);drawTaskIntegration();if(previous&&!d.simple&&!d.resume&&!d.waiting?.length)$('#integrate-status').textContent=UI.text('最新の範囲と残件申告を表示しました。開始後は自動で続けます');if(waitEnded&&!d.waiting?.length){const status=$('#integrate-status');status.dataset.waitPhase='finished';status.insertAdjacentHTML('afterbegin',UI.html(esc(UI.text(d.auto&&!d.auto.stopped?'待機は終了しました。開始済みの統合を自動で続けます。追加操作は不要です':'待機は終了しました。最新の内容とボタンを確認してください。自動では開始・再開しません'))+' '));}}
  catch(e){if(epoch===integrateEpoch){if(previous){integratePreview=previous;drawTaskIntegration();integrationRequireRefresh(transferError(e));}else{integratePreview=null;sheet.innerHTML=UI.template`<div class="remove-box"><p>${esc(transferError(e))}</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>`;}}}
  finally{if(epoch===integrateEpoch){integratePreviewRequest=null;integrateBusy=false;integrationApplyState();integrationScheduleWait();}}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-integrate-action]');if(!b||b.disabled)return;
  const action=b.dataset.integrateAction;
  if(action==='close'&&(!integrateBusy||integrateWaitRequest||integratePreviewRequest)){clearTimeout(integrateWaitTimer);integrateEpoch++;if(integrateWaitRequest||integratePreviewRequest){integrateWaitRequest=null;integratePreviewRequest=null;integrateBusy=false;}$('#integrate-sheet').hidden=true;return;}
  if(integrateBusy)return;
  const d=integratePreview;if(!d)return;
  if(['abandon-preview','abandon-confirm'].includes(action)){await abandonTaskIntegration(action);return;}
  if(action==='sibling'){await showTaskIntegration(d.project,d.task,undefined,false,true);return;}
  if(action==='primary'){await showTaskIntegration(d.project,d.task,undefined,false,false);return;}
  if(action==='records-save'){await saveIntegrationRecords();return;}
  if(d.simple&&['single','batch','selected'].includes(action)){await startSimpleIntegration(action,Number(b.dataset.index));return;}
  integrateChoices();
  if(action==='resume'){
    if(!d.auto?.stopped||d.waiting?.length||d.requiresRefresh||d.resumeUncertain||d.resumeAllowed===false)return;
    integrateBusy=true;const unlock=integrationLock();
    try{const out=await api('/api/task/integrate/resume',{project:d.project,task:d.task,token:d.token});if(out?.resumed!==true||out.thenMain!==false)throw Error(UI.text('通信結果を確認できません。再送せず、最新の記録を確認してください'));await load();render();$('#integrate-sheet').hidden=true;toast(UI.text('再開を受け付けました。統合の進行は最新の記録で確認してください'));}
    catch(e){if(e.status===409&&e.code==='INTEGRATION_BUSY'&&e.stage==='waiting'&&e.waiting?.length)integrationWaitState(e.waiting);else {if(e.status!==409)integrationRememberUncertain(d);integrationRequireRefresh(transferError(e));}}
    finally{integrateBusy=false;unlock();}return;
  }
  if(action==='stop'){integrateBusy=true;const unlock=integrationLock();try{await api('/api/chat/stop',{project:d.project,task:d.task});await load();render();$('#integrate-sheet').hidden=true;}catch(e){integrationRequireRefresh(transferError(e));}finally{integrateBusy=false;unlock();}return;}
  if(action==='up'||action==='down'){const n=Number(b.dataset.index),to=n+(action==='up'?-1:1);if(to>=0&&to<d.items.length){[d.items[n],d.items[to]]=[d.items[to],d.items[n]];drawTaskIntegration();}return;}
  if(action==='refresh'){await showTaskIntegration(d.project,d.task,d.only,false,d.sibling===true);return;}
  if(action==='resolve'||action==='results'){
    const i=d.items[Number(b.dataset.index)];if(!i)return;
    integrateBusy=true;const unlock=integrationLock();
    try{await api(action==='results'?'/api/task/integrate/results':'/api/task/integrate/resolve',{project:d.project,task:d.task,childProject:i.project,childTask:i.task,token:d.token});await load();render();$('#integrate-sheet').hidden=true;toast(action==='results'?UI.text('子の会話で成果の整理を依頼しました。AI終了後に統合を確認してください'):UI.text('親の会話でぶつかりの解消を依頼しました。AI終了後に統合の続きを確認してください'));}
    catch(e){integrationRequireRefresh(transferError(e));}
    finally{integrateBusy=false;unlock();}
    return;
  }
  if(action!=='apply'||d.requiresRefresh||d.waiting?.length)return;
  const audited=d.items.find(i=>i.checked&&i.disposition==='cleanup'&&i.needsRemaining&&(!i.cleanupAudit||![i.cleanupAudit.items,i.cleanupAudit.undecided].every(v=>['なし',UI.text('なし')].includes(v?.trim()))||!i.cleanupAudit.evidence?.trim()||i.cleanupAudit.evidence.length<10));
  if(audited){$('#integrate-status').textContent=audited.title+'：'+UI.text('完了を確認した根拠を記入してください');return;}
  const issue=d.legacy&&!$('#integrate-legacy')?.checked?{selector:'#integrate-legacy',message:UI.text('旧確認：片付けを含む元の範囲を確認しました')}:null;if(issue){integrationShowIssue(issue);integrationApplyState();return;}
  integrateBusy=true;const unlock=integrationLock();let accepted=false;$('#integrate-status').textContent=UI.text('確認した成果の取り込みと保存を進めています…');
  try{
    const selected=d.resume?undefined:d.items.filter(i=>i.checked).map(i=>({project:i.project,task:i.task,disposition:i.disposition,...(i.disposition==='cleanup'&&i.needsRemaining?{cleanupAudit:i.cleanupAudit}:{})}));
    const out=await api('/api/task/integrate',{project:d.project,task:d.task,token:d.token,selected,auto:true,thenMain:true,confirm:true,recover:Boolean(d.recover),legacyConfirmed:Boolean($('#integrate-legacy')?.checked)});
    if(!out||(out.complete!==true&&out.partial!==true))throw Error(UI.text('通信結果を確認できません。再送せず、最新の記録を確認してください'));
    accepted=true;
    if(out.partial){await load();render();$('#integrate-sheet').hidden=true;toast(UI.text('統合を自動で続けています'));return;}
    await load();render();$('#integrate-sheet').hidden=true;toast(UI.text(out.noChanges?'新しい成果はありません':d.items.filter(i=>i.checked).every(i=>i.alreadyReceived)?'受領済みの子を片付けました':'受領済み。本体への取り込みを自動で続けます'));
  }catch(e){if(!accepted&&e.status===409&&e.code==='INTEGRATION_BUSY'&&e.stage==='waiting'&&e.waiting?.length)integrationWaitState(e.waiting);else integrationRequireRefresh(transferError(e)+' '+UI.text(accepted?'受領の応答はありました。最新の記録を確認してください':e.status===409?'内容の変更・期限切れ・途中の統合を確認してください':'通信結果を確認できません。再送せず、最新の記録を確認してください'));}
  finally{integrateBusy=false;unlock();}
});
document.addEventListener('change',e=>{
  if(integrateBusy)return;
  if(integratePreview?.simple){
    const d=integratePreview;
    if(e.target.matches?.('#integration-abandon-confirm')){integrationSimpleState();return;}
    if(d.requiresRefresh||d.auto||d.waiting?.length)return;
    if(e.target.matches?.('[data-integrate-select]')){const i=d.items[Number(e.target.dataset.index)];if(i?.startable&&!i.noop){i.selected=Boolean(e.target.checked);integrationSimpleState();}return;}
    void saveIntegrationKeep(e.target);return;
  }
  if(!e.target.closest?.('[data-integrate-item]'))return;
  integrateChoices();const d=integratePreview;if(!d||d.resume)return;
  if(e.target.matches?.('[data-integrate-mode]')){const i=d.items[Number(e.target.closest('[data-integrate-item]').dataset.integrateItem)];i.review.confirmed=false;const check=e.target.closest('[data-integrate-item]').querySelector('[data-integrate-confirm]');if(check)check.checked=false;}
  integrationApplyState();
  if(e.target.matches?.('[data-integrate-check]')){
    const i=d.items[Number(e.target.closest('[data-integrate-item]').dataset.integrateItem)];
    if(i.checked&&i.disposition==='cleanup')for(const child of i.descendants){const x=d.items.find(x=>integrateKey(x)===integrateKey(child));if(x&&!x.blockers.length)x.checked=true;}
    else if(!i.checked)for(const parent of d.items)if(parent.descendants.some(x=>integrateKey(x)===integrateKey(i)))parent.checked=false;
    drawTaskIntegration();
  }
});
document.addEventListener('input',e=>{
  if(integrateBusy||!e.target.matches?.('[data-integrate-review]'))return;
  const section=e.target.closest('[data-integrate-item]'),check=section?.querySelector('[data-integrate-confirm]');if(check)check.checked=false;
  integrateChoices();integrationApplyState();
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(!integrateBusy||integrateWaitRequest||integratePreviewRequest)&&$('#integrate-sheet')){clearTimeout(integrateWaitTimer);integrateEpoch++;if(integrateWaitRequest||integratePreviewRequest){integrateWaitRequest=null;integratePreviewRequest=null;integrateBusy=false;}$('#integrate-sheet').hidden=true;}});

// Minimal sheet; technical evidence remains in the durable integration record.
function integrationSimpleState(){
  const recordButton=$('#integrate-sheet [data-integrate-action="records-save"]');if(recordButton)recordButton.disabled=integrateBusy||!integratePreview?.token||Boolean(integratePreview.requiresRefresh)||!integratePreview?.recordSave?.allowed||integrateRecordUncertain.has(integratePreview.recordSave.fingerprint);
  const d=integratePreview,disabled=integrateBusy||Boolean(d.auto)||Boolean(d.waiting?.length)||Boolean(d.requiresRefresh);
  const siblingButton=$('#integrate-sheet [data-integrate-action="sibling"]');if(siblingButton)siblingButton.disabled=integrateBusy||Boolean(d.waiting?.length)||!d.siblingOption?.allowed;
  const abandonDisabled=integrateBusy||Boolean(d.requiresRefresh)||!d.abandon?.allowed||integrateAbandonUncertain.has(integrationAbandonKey(d));
  const abandonPreview=$('#integrate-sheet [data-integrate-action="abandon-preview"]');if(abandonPreview)abandonPreview.disabled=abandonDisabled;
  const abandonConfirm=$('#integrate-sheet [data-integrate-action="abandon-confirm"]');if(abandonConfirm)abandonConfirm.disabled=abandonDisabled||!d.abandonConfirmation?.token||!$('#integration-abandon-confirm')?.checked;
  for(const b of document.querySelectorAll('#integrate-sheet [data-integrate-action="single"]')){const i=d.items[Number(b.dataset.index)];b.disabled=disabled||Boolean(globalThis.HubIntegrationSelection.select(d.items,'single',i?[i]:[],UI.text,UI.template).reason);}
  const batch=$('#integrate-sheet [data-integrate-action="batch"]');if(batch)batch.disabled=disabled||Boolean(globalThis.HubIntegrationSelection.select(d.items,'batch',undefined,UI.text,UI.template).reason);
  const selected=$('#integrate-sheet [data-integrate-action="selected"]'),count=d.items.filter(i=>i.selected&&i.startable&&!i.noop).length;
  if(selected){selected.disabled=disabled||Boolean(globalThis.HubIntegrationSelection.select(d.items,'selected',d.items.filter(i=>i.selected),UI.text,UI.template).reason);selected.textContent=UI.template`選別統合（${count}件）`;}
  for(const input of document.querySelectorAll('#integrate-sheet [data-integrate-select]')){const i=d.items[Number(input.dataset.index)];input.disabled=disabled||!i?.startable||i.noop;}
  const resume=$('#integrate-sheet [data-integrate-action="resume"]');if(resume)resume.disabled=integrateBusy||Boolean(d.waiting?.length)||Boolean(d.resumeUncertain)||d.resumeAllowed===false||Boolean(d.requiresRefresh)||Boolean(d.blockers?.length)||Boolean(d.recover)||Boolean(d.legacy);
  for(const input of document.querySelectorAll('#integrate-sheet [data-integrate-keep]'))input.disabled=disabled||Boolean(d.items[Number(input.dataset.index)]?.keepLocked);
}
function integrationSimpleRowStatus(i,d){
  if(['受領済み','保持受領済み','片付け済み'].includes(i.state))return UI.text(i.state);
  if(d.auto?.stopped)return UI.text('停止')+'：'+UI.text(d.auto.stopped.reason||'状態未確認');
  if(i.waiting?.length)return UI.text('稼働中の処理の終了待ち')+'：'+[...new Set(i.waiting.map(w=>w.message))].join(' / ');
  if(i.reason)return UI.text('確認が必要')+'：'+UI.text(i.reason);
  if(d.auto)return UI.text(i.state==='待ち'?'順番待ち':i.state||'状態未確認');
  return i.noop?UI.text('済'):'';
}
function integrationSimpleStatus(d){
  const stopped=d.auto?.stopped;
  if(stopped)return UI.text('停止')+'：'+UI.text(stopped.reason||'状態未確認')+(d.resumeMessage?'\n'+d.resumeMessage:'');
  const main=d.auto?.main;
  if(main?.state==='done')return UI.text(main.skipped?'子作業の受領が完了しました。本体への反映は別に確認してください':'本体に取り込み済み・新しい版を待っています');
  if(main?.state==='intent')return UI.text('本体取り込みの結果が不明です。再送はしません');
  return d.auto?UI.text('開始済みです。現在の状態は各行に表示しています。追加操作は不要です'):d.selectionNotice||'';
}
function integrationPendingMainStatus(d){
  const pending=d.mainPending||d.auto?.pendingMain;if(!pending)return '';
  if(d.mainDisplay?.reflected===true&&d.mainDisplay.key===JSON.stringify(pending))return UI.text('過去の本体取り込み記録（現在の本体に反映済み）')+'\n'+UI.text('以前の記録を保持しています。この記録から再送はしません')+(d.mainDisplay.mainUncommitted?'\n'+UI.text('本体には別の未保存変更があります。この取り込み結果とは別です')+`（${d.mainDisplay.mainUncommitted}）`:'');
  return UI.text('本体への反映が未確認です')+(pending.stopped?'\n'+UI.text('過去の停止理由')+'：'+UI.text(pending.stopped.reason||'状態未確認'):'')+(pending.main?.state==='intent'?'\n'+UI.text('本体取り込みの結果が不明です。再送はしません'):'');
}
function integrationSiblingPanel(d){
 if(d.sibling)return UI.template`<section class="note" data-integration-sibling><h3>停止記録を残した別の子の受領</h3><p>以前の統合は未完了のまま残します。そのコードの合格や本体反映を、今回の報告の確認で認めることはありません。</p><p>${esc(d.stoppedWarning?.items?.map(i=>i.title).join('、')||'')}：${esc(d.stoppedWarning?.reason||'状態未確認')}</p><button class="btn plain" data-integrate-action="primary" type="button">以前の停止記録を見る</button></section>`;
 if(!d.siblingOption)return '';
 return UI.template`<section class="note" data-integration-sibling><p>${esc(d.siblingOption.message)}</p>${d.siblingOption.allowed?'<button class="btn" data-integrate-action="sibling" type="button">別の子の報告を受け取る</button>':''}</section>`;
}
function drawSimpleIntegration(){
  const d=integratePreview,stopped=d.auto?.stopped;integrationSimpleUncertainty(d);
  const operation=d.sibling?'別の子の保存済み報告を一つ受け取ります。子作業・会話・コピーは残します。製品コードの取り込みや片付けは行いません':stopped?'停止しています。最新の記録を確認し、［統合を再開］が使える場合に押してください。自動では再開しません':d.auto?'開始済みです。追加で統合ボタンを押す必要はありません':'各行の［統合］はその子を対象にし、［残さない］では子孫も含めます。［一括統合］は表示された統合可能な子すべてを対象にします。［選別統合］は選んだ子だけを対象にし、子孫を自動では加えません';
  const scope=d.sibling||stopped||d.mainPending||d.auto?.pendingMain||d.auto?.thenMain===false?'今回は本作業への受領まで。本体反映と新版起動は別に行います':'新しい成果は統合・確認・受領から本体反映まで進めます。受領済みの子だけの片付けでは本体を再反映しません。新版の起動は人が行います';
  $('#integrate-sheet').innerHTML=UI.template`<div class="remove-box history-box integration-simple"><header><h2>${UI.text('子作業を統合する')}</h2><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></header><div class="history-content"><div class="integration-guide"><p>${UI.text(operation)}</p><p>${UI.text('［残す］は子作業・会話・コピーを保持します。［残さない］は残件を本作業へ引き継ぎ、成果・会話を保全して子作業・コピーをゴミ箱へ移します。未受領の内容は残します')}</p><p>${UI.text(scope)}</p></div>${integrationSiblingPanel(d)}${integrationAssignmentPanel(d)}${integrationRecordsPanel(d)}${integrationAbandonPanel(d)}${d.items.map((i,n)=>i.futureHold?UI.template`<p class="note">${esc(i.route||i.title)}：将来検討として保留中です。以前の停止記録は残しています。この記録の統合は保留解除まで再開できません。</p>`:UI.template`<section class="integration-row"><label class="integration-select" ${d.sibling?'hidden':''}><input type="checkbox" data-integrate-select data-index="${n}" aria-label="${esc(UI.template`選ぶ：${i.title}`)}" ${i.selected?'checked':''}>${UI.text('選ぶ')}</label><b>${esc(i.route||i.title)}</b>${i.cleanupOnly?UI.template`<p class="note">${UI.text('完了・受領済みです。上の作業を片付けるため、残すか確認してください。追加の成果ではありません')}</p>`:''}<fieldset aria-label="${esc(UI.text('統合後の子作業'))}"><label><input type="radio" name="integration-keep-${n}" data-integrate-keep data-index="${n}" value="true" ${i.keep?'checked':''}>${UI.text('残す')}</label><label><input type="radio" name="integration-keep-${n}" data-integrate-keep data-index="${n}" value="false" ${!i.keep?'checked':''}>${UI.text('残さない')}</label></fieldset>${i.cleanupOnly?'':UI.template`<button class="btn" data-integrate-action="single" data-index="${n}" type="button">${UI.text(d.sibling?'報告を受け取る':'統合')}</button>`}${i.reportScope?UI.template`<p class="note">${esc(i.reportScope)}</p>`:''}${integrationSimpleRowStatus(i,d)?UI.template`<p class="integration-row-status" role="status">${esc(integrationSimpleRowStatus(i,d))}</p>`:''}</section>`).join('')}${!d.items.length?UI.template`<p>${UI.text('新しい成果はありません')}</p>`:''}</div><footer class="acts">${integrationPendingMainStatus(d)?(d.mainDisplay?.reflected===true&&d.mainDisplay.key===JSON.stringify(d.mainPending||d.auto?.pendingMain)?UI.template`<details class="note" data-integration-history><summary>${esc(integrationPendingMainStatus(d).split("\n")[0])}</summary><p>${esc(integrationPendingMainStatus(d))}</p></details>`:UI.template`<p data-integration-main role="status">${esc(integrationPendingMainStatus(d))}</p>`):''}<p id="integrate-status" role="status" aria-live="polite">${esc(integrationSimpleStatus(d))}</p>${stopped?UI.html('<button class="btn" data-integrate-action="resume" type="button">統合を再開</button>'):d.sibling?'':UI.html('<button class="btn" data-integrate-action="selected" type="button">選別統合</button><button class="btn" data-integrate-action="batch" type="button">一括統合</button>')}</footer></div>`;
  if(d.waiting?.length)integrationWaitState(d.waiting);
  else if(d.resumeUncertain)integrationRequireRefresh(UI.text('再開の通信結果が不明です。同じ停止記録への再送はしません。最新の記録を確認してください'));
  else if(d.requiresRefresh)integrationRequireRefresh(d.refreshMessage);
  integrationSimpleState();
}
async function saveIntegrationKeep(input){
  if(!input.matches?.('[data-integrate-keep]'))return;
  const d=integratePreview,i=d?.items[Number(input.dataset.index)];if(!i||d.auto||integrateBusy)return;
  const keep=input.value==='true';if(keep===i.keep)return;
  integrateBusy=true;const unlock=integrationLock();
  try{const out=await api('/api/task/integrate/keep',{project:d.project,task:d.task,childProject:i.project,childTask:i.task,keep});if(out?.ok!==true||out.keep!==keep)throw Error(UI.text('通信結果を確認できません。再送せず、最新の記録を確認してください'));integrateBusy=false;await showTaskIntegration(d.project,d.task,d.only,false,d.sibling===true);}
  catch(e){if(e.status!==409)integrateKeepUncertain.add(integrationKeepKey(d,i));drawSimpleIntegration();integrationRequireRefresh(transferError(e));}
  finally{integrateBusy=false;unlock();}
}
async function startSimpleIntegration(mode,n){
  const d=integratePreview;if(d?.sibling&&mode!=='single')return;if(integrateBusy||!d?.token||d.auto||d.requiresRefresh||d.waiting?.length||!['single','batch','selected'].includes(mode))return;
  const requested=mode==='single'?[d.items[n]]:d.items.filter(i=>i.selected);
  const plan=globalThis.HubIntegrationSelection.select(d.items,mode,requested,UI.text,UI.template);
  if(plan.reason){$('#integrate-status').textContent=UI.text(plan.reason);return;}
  const items=plan.items;
  integrateBusy=true;const unlock=integrationLock();
  try{const out=await api('/api/task/integrate',{project:d.project,task:d.task,token:d.token,...(d.assignmentPolicy?{assignments:d.assignmentPolicy.slots}:{}),auto:true,thenMain:!d.sibling&&!d.mainPending,confirm:true,mode,selected:items.map(i=>({project:i.project,task:i.task,keep:i.keep}))});if(out?.partial!==true&&out?.complete!==true)throw Error(UI.text('通信結果を確認できません。再送せず、最新の記録を確認してください'));await load();render();$('#integrate-sheet').hidden=true;toast(UI.text('統合を自動で続けています'));}
  catch(e){if(e.status===409&&e.code==='INTEGRATION_BUSY'&&e.stage==='waiting'&&e.waiting?.length)integrationWaitState(e.waiting);else {if(e.status!==409)integrateStartUncertain.add(integrationStartKey(d));integrationRequireRefresh(transferError(e));}}
  finally{integrateBusy=false;unlock();}
}

function integrationRecordsPanel(d){
 const r=d.recordSave;if(!r?.records?.length&&!r?.products?.length&&!r?.hiddenPaths&&!r?.unresolved)return '';
 return UI.template`<section class="integration-records"><h3>${UI.text('未保存の変更')}</h3><p>${UI.text('統合はまだ開始していません')}</p><h4>${UI.text('Hubの記録（証拠なし）')}</h4>${r.records.map(x=>UI.template`<p>${esc(x.path)}${x.interrupted?'<br>'+esc(UI.text('Hubの書込みが途中で終わりました')):''}${x.headPrefix!==null?'<br>'+esc(UI.text(x.headPrefix?'HEADの原文と先頭一致（追記のみ）':'会話原文に外部変更の可能性があります。内容を確認してください')):''}${x.jsonLines===false?'<br>'+esc(UI.text('会話のJSON形式を確認してください')):''}</p>`).join('')}<h4>${UI.text('製品ファイル')}</h4>${r.products.length?r.products.map(p=>'<p>'+esc(p)+'</p>').join(''):UI.template`<p>${UI.text('なし')}</p>`}${r.hiddenPaths?UI.template`<p>${UI.text('非表示の対象があります。保存状態を確認してください')}</p>`:''}<p>${esc(r.reason)}</p><p>${esc(r.warning||'')}</p>${r.allowed?UI.template`<label><input type="checkbox" id="integration-record-confirm">${UI.text('表示されたHub記録の内容を確認し、Gitに保存します')}</label><button class="btn" data-integrate-action="records-save" type="button" ${integrateBusy||!d.token||d.requiresRefresh||integrateRecordUncertain.has(r.fingerprint)?'disabled':''}>${UI.text('Hubの記録を保存して続ける')}</button>`:''}</section>`;
}
async function saveIntegrationRecords(){
 const d=integratePreview,r=d?.recordSave,epoch=integrateEpoch;if(integrateBusy||!d?.token||d.requiresRefresh||!r?.allowed||integrateRecordUncertain.has(r.fingerprint)||!$('#integration-record-confirm')?.checked)return;
 integrateBusy=true;const unlock=integrationLock(),attempt={};integrateRecordUncertain.set(r.fingerprint,attempt);
 try{const out=await api('/api/task/integrate/records/save',{project:d.project,task:d.task,token:d.token,confirm:true});if(!out?.saved||!out?.commit)throw Error(UI.text('Hub記録の保存結果が不明です。再送せず保存記録を確認してください'));if(epoch!==integrateEpoch||integratePreview!==d)return;integrateBusy=false;await showTaskIntegration(d.project,d.task,d.only,false,d.sibling===true);}
 catch(e){if(e.delivery?.state==='not-sent'&&integrateRecordUncertain.get(r.fingerprint)===attempt)integrateRecordUncertain.delete(r.fingerprint);delete d.token;if(epoch===integrateEpoch&&integratePreview===d)integrationRequireRefresh(transferError(e));}
 finally{if(epoch===integrateEpoch){integrateBusy=false;unlock();}}
}

// Separate one-use confirmation. Closing or switching sheets discards late UI.
const integrateAbandonUncertain=new Set();
const integrationAbandonKey=d=>d.abandon?.recovery?.action?d.id+':'+d.abandon.recovery.action+':'+d.abandon.recovery.sha256:d.id;
function integrationAbandonPanel(d){
  const a=d.abandon;if(!a)return '';
  return UI.template`<section class="integration-records"><h3>${UI.text(a.stopKind==='human'?'人が止めた統合':'停止した統合')}</h3>${d.auto?.stopped?.reason?UI.template`<p>${UI.text('停止理由')}: ${esc(d.auto.stopped.reason)}</p>`:''}<p>${esc(a.message)}</p>${a.recovery?.differences?.length?UI.template`<p>${UI.text('前の記録から変更があります。安全を確認できるまで操作しません')}</p>`:''}<p>${UI.text(a.allowed?'受領・片付けは行いません。対象の子は選び直せる候補として残ります':'安全を確認できないため中止・選び直しは行いません。子と原文は保持されています')}</p>${a.allowed?UI.template`<button class="btn plain" data-integrate-action="abandon-preview" type="button" ${integrateBusy||integrateAbandonUncertain.has(integrationAbandonKey(d))?'disabled':''}>${UI.text(a.recovery?.action==='quarantine'?'壊れた履歴を残してやり直す':a.recovery?.action==='finalize'?'中止記録の保存を完了する':'中止して選び直す')}</button>`:''}${d.abandonConfirmation?UI.template`<p>${UI.text('中止する未受領の対象')}</p>${d.abandonConfirmation.items.map(i=>UI.template`<p>${esc(i.title)}</p>`).join('')}<label><input type="checkbox" id="integration-abandon-confirm">${UI.text(a.recovery?'元の履歴を残し、依頼を再送せず回復することを確認しました':'受領せずに中止し、子と原文を残すことを確認しました')}</label><button class="btn warn" data-integrate-action="abandon-confirm" type="button" ${integrateBusy?'disabled':''}>${UI.text(a.recovery?.action==='quarantine'?'元の履歴を退避する':a.recovery?.action==='finalize'?'保存を完了する':'中止を確定する')}</button>`:''}</section>`;
}
async function abandonTaskIntegration(action){
  const d=integratePreview,epoch=integrateEpoch;if(integrateBusy||!d?.abandon?.allowed||integrateAbandonUncertain.has(integrationAbandonKey(d))||d.requiresRefresh)return;
  if(action==='abandon-confirm'&&(!d.abandonConfirmation||!$('#integration-abandon-confirm')?.checked))return;
  integrateBusy=true;const unlock=integrationLock();
  try{
    const c=d.abandonConfirmation,out=await api('/api/task/integrate/abandon',action==='abandon-preview'?{project:d.project,task:d.task,preview:true,...(d.abandon.recovery?.action?{recover:d.abandon.recovery.action}:{})}:{project:d.project,task:d.task,id:c.id,token:c.token,confirm:true});
    if(action==='abandon-confirm'&&out.abandoned!==true&&out.recovered!=='quarantine')throw Error(UI.text('通信結果を確認できません。再送せず、最新の記録を確認してください'));
    if(epoch!==integrateEpoch||integratePreview!==d)return;
    integrateBusy=false;
    if(action==='abandon-preview'){d.abandonConfirmation=out;drawSimpleIntegration();}
    else await showTaskIntegration(d.project,d.task,d.only,false,d.sibling===true);
  }catch(e){if(action==='abandon-confirm'&&e.delivery?.state!=='not-sent')integrateAbandonUncertain.add(integrationAbandonKey(d));if(epoch===integrateEpoch&&integratePreview===d)integrationRequireRefresh(transferError(e));}
  finally{if(epoch===integrateEpoch&&integratePreview===d){integrateBusy=false;unlock();}}
}
