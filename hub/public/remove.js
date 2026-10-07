'use strict';
var UI = globalThis.HubI18n || {text: x=>x, html:x=>x, label:x=>x, message:x=>x, valueAttribute:()=>'', dateLocale:'ja-JP', template:(strings,...values)=>strings.reduce((s,x,i)=>s+x+(i<values.length?values[i]:''),'')};
let removePreview=null,removePending=false,removeEpoch=0,removeSelections=new Set(),removeReviewed='',removeApplied=false,removeResult=null;
const removalChecking=()=>removePreview?.review?.status==='running';
function syncRemoval(){
 const d=removePreview;if(!d)return;const busy=removePending||removalChecking()||removeApplied;
 for(const x of document.querySelectorAll('[data-remove-option]')){const candidate=[...d.optional,...d.keep].find(c=>c.id===x.dataset.removeOption);x.disabled=busy||candidate?.selectable===false;}
 const choices=d.keep.filter(x=>x.external&&x.selectable),all=$('#remove-select-all');
 if(all){const n=choices.filter(x=>removeSelections.has(x.id)).length;all.disabled=busy||!choices.length;all.checked=!!choices.length&&n===choices.length;all.indeterminate=n>0&&n<choices.length;}
 const apply=$('#remove-apply');if(apply)apply.disabled=busy||d.blockers.length>0||(d.typed&&$('#remove-typed')?.value!==d.title);
 const review=$('#remove-review');if(review)review.disabled=busy||d.blockers.length>0;
 const refresh=$('#remove-refresh');if(refresh)refresh.disabled=removePending||removalChecking();
}
function drawRemoval(d,typed='') {
 if(d.review?.status==='done'&&removeReviewed!==d.review.id){
  for(const x of d.keep.filter(x=>x.external)){removeSelections.delete(x.id);if(x.selectable&&d.review.results.some(r=>r.id===x.id&&r.sharing==='なし'))removeSelections.add(x.id);}
  removeReviewed=d.review.id;
 }
 const el=$('#remove-sheet');el.innerHTML=UI.template`<div class="remove-box"><h2>「${esc(d.title)}」を削除しますか</h2><h3>ゴミ箱へ移すもの（${d.move.length}）</h3>${d.move.map(x=>UI.template`<p>${esc(x.what)}<br><small>${esc(x.path)}</small></p>`).join('')}
 ${d.optional.length?UI.template`<h3>選べば一緒に移すもの</h3>${d.optional.map(x=>UI.template`<label class="maintenance-choice"><input type="checkbox" data-remove-option="${esc(x.id)}" ${removeSelections.has(x.id)?'checked':''}><span>${esc(x.path)}<small>${esc(x.why)}</small></span></label>`).join('')}`:''}
 <h3>残すもの（選んだ場所は一緒に移します）</h3>${d.keep.some(x=>x.external)&&!d.task?UI.template`<p>外の場所は最初は選びません。他で使っていないか確認してから選んでください。</p><label class="maintenance-choice"><input id="remove-select-all" type="checkbox"><span>すべて選ぶ（選べる外の場所だけ）</span></label><button class="btn plain" id="remove-review" data-remove-action="review" type="button">AIに共有を確認してもらう</button><p id="remove-review-status" role="status">${esc(d.review?.status==='running'?UI.text('AIが読み取りだけで共有を確認中です。終わるまで移せません。'):d.review?.status==='done'?UI.text('共有確認が終わりました。「なし」を選択しました。最後に移す場所を確認してください。'):d.review?.error||UI.text('共有の確認を頼んでから、残すかどうかを決めることもできます。'))}</p>`:''}
 ${d.keep.length?d.keep.map(x=>{const r=d.review?.results?.find(r=>r.id===x.id);return x.external?UI.template`<label class="maintenance-choice"><input type="checkbox" data-remove-option="${esc(x.id)}" ${removeSelections.has(x.id)?'checked':''} ${!x.selectable?'disabled':''}><span>これも一緒にゴミ箱へ移す<br>${esc(x.path)}<small>${esc(x.why)}${!x.selectable?UI.template`<br>選べない理由：${esc(x.unavailableWhy)}`:''}${r?UI.template`<br>AIの確認：共有${esc(r.sharing)} — ${esc(r.reason)}`:''}</small></span></label>`:UI.template`<p>${esc(x.path)}<br><small>${esc(x.why)}</small></p>`;}).join(''):UI.html('<p>確認した範囲に共有先はありません。</p>')}
 ${d.blockers.length?UI.template`<h3 class="danger">削除できない理由</h3>${d.blockers.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}`:''}${d.warnings.map(x=>UI.template`<p>${esc(x)}</p>`).join('')}
 ${d.typed?UI.template`<label>資料・成果物を含みます。確認のため「${esc(d.title)}」を入力してください<input id="remove-typed" autocomplete="off"></label>`:''}
 <p>あとで［整理と確認］の記録から元に戻せます。</p><p id="remove-status" role="status"></p><div class="acts"><button class="btn plain" data-remove-action="close" type="button">やめる</button><button class="btn plain" id="remove-refresh" data-remove-action="refresh" type="button">削除内容を確認し直す</button><button class="btn danger" id="remove-apply" data-remove-action="apply" type="button">ゴミ箱へ移す</button></div></div>`;
 if($('#remove-typed'))$('#remove-typed').value=typed;syncRemoval();
}
async function pollRemoval(epoch){
 if(epoch!==removeEpoch||!removalChecking())return;
 try{
  const r=await api('/api/hierarchy/remove/review/status',{project:removePreview.project});if(epoch!==removeEpoch)return;
  if(r.preview){const typed=$('#remove-typed')?.value||'';removePreview=r.preview;drawRemoval(removePreview,typed);return;}
  if(!r.review||r.review.status!=='running')throw Error(UI.text('共有確認の記録を取得できませんでした'));
  setTimeout(()=>pollRemoval(epoch),1500);
 }catch(e){if(epoch===removeEpoch){$('#remove-review-status').textContent=UI.text('確認結果を取得できませんでした：')+e.message;$('#remove-review-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain" data-remove-action="review-status" type="button">確認結果を更新</button>'));}}
}
async function showRemoval(project,task) {
 if(removePending)return;const epoch=++removeEpoch;removePreview=null;removeSelections=new Set();removeReviewed='';removeApplied=false;removeResult=null;
 if(!$('#remove-sheet'))document.body.insertAdjacentHTML('beforeend',UI.html('<div id="remove-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="削除内容の確認"></div>'));
 $('#remove-sheet').hidden=false;$('#remove-sheet').innerHTML=UI.html('<div class="remove-box"><p>削除できる範囲を確認しています…</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>');
 try {const d=await api('/api/hierarchy/remove/preview',{project,task});if(epoch!==removeEpoch)return;removePreview=d;drawRemoval(d);if(removalChecking())pollRemoval(epoch);}catch(e){if(epoch===removeEpoch)$('#remove-sheet').innerHTML=UI.template`<div class="remove-box"><p>${esc(e.message)}</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>`;}
}
function removalResult(r, retry = true) {
 const status=$('#remove-status');
 status.textContent=r.failed.length?(r.moved.length?UI.template`途中で止まりました。移した${r.moved.length}件は元に戻せます。${r.failed.map(x=>x.why).join(' / ')}`:UI.text('移動できませんでした。')+' '+r.failed.map(x=>x.why).join(' / ')):UI.template`${r.moved.length}件をゴミ箱へ移しました。`;
 if(r.moved.length)status.insertAdjacentHTML('beforeend',UI.template` <button class="btn plain sm" data-remove-restore="${esc(r.record)}" type="button">元に戻す</button>`);
 if(retry&&r.failed.length)status.insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-remove-action="refresh" type="button">もう一度削除内容を確認</button>'));
}
async function refreshRemoval() {
 if(removePending||!removePreview||removalChecking())return;
 const target=removePreview, prior=removeResult, epoch=++removeEpoch, status=$('#remove-status'),typed=$('#remove-typed')?.value||'';
 const controls=[...$('#remove-sheet').querySelectorAll('button,input')], disabled=controls.map(control=>control.disabled);
 removePending=true;controls.forEach(control=>{control.disabled=true;});
 try {
  const next=await api('/api/hierarchy/remove/preview',{project:target.project,task:target.task});
  if(epoch!==removeEpoch)return;
  if(next.project!==target.project||(next.task||'')!==(target.task||''))throw Error(UI.text('削除する対象が変わりました。もう一度開いてください。'));
  removePreview=next;removeApplied=false;removeSelections=new Set();removeReviewed='';drawRemoval(next,typed);
  if(prior?.moved.length)removalResult(prior,false);
  $('#remove-status').insertAdjacentHTML('beforeend',UI.html('<span> 削除内容を更新しました。内容を確認してから、もう一度移してください。</span>'));
 }catch(error){
  if(epoch===removeEpoch){
   if(prior)removalResult(prior);
   status.insertAdjacentHTML('beforeend',UI.template`<span class="danger"> ${esc(error.message)}</span>`);
  }
 }finally{removePending=false;controls.forEach((control,index)=>{control.disabled=disabled[index];});syncRemoval();}
}
async function restoreRemoval(record) {
 if(!confirm(UI.text('ゴミ箱へ移したものを元に戻しますか？同名のファイルは上書きしません。')))return null;
 const r=await api('/api/hierarchy/remove/restore',{record,confirm:true});await load();return r;
}
document.addEventListener('input',e=>{if(e.target.id==='remove-typed')syncRemoval();});
document.addEventListener('change',e=>{
 if(!removePreview||removePending||removalChecking()||removeApplied)return;
 if(e.target.id==='remove-select-all'){for(const x of removePreview.keep.filter(x=>x.external&&x.selectable)){if(e.target.checked)removeSelections.add(x.id);else removeSelections.delete(x.id);}for(const x of document.querySelectorAll('[data-remove-option]'))x.checked=removeSelections.has(x.dataset.removeOption);}
 else if(e.target.dataset.removeOption){if(e.target.disabled)return;if(e.target.checked)removeSelections.add(e.target.dataset.removeOption);else removeSelections.delete(e.target.dataset.removeOption);}
 else return;syncRemoval();
});
document.addEventListener('click',async e=>{
 const b=e.target.closest?.('[data-remove-action]');if(!b||removePending||b.disabled)return;const action=b.dataset.removeAction;
 if(action==='refresh'){await refreshRemoval();return;}
 if(action==='close'){removeEpoch++;$('#remove-sheet').hidden=true;return;}
 if(action==='review-status'){b.disabled=true;await pollRemoval(removeEpoch);return;}
 if(!removePreview||removalChecking())return;
 if(action==='review'){
  const d=removePreview,epoch=removeEpoch,typed=$('#remove-typed')?.value||'';removePending=true;syncRemoval();
  try{for(const x of d.keep.filter(x=>x.external))removeSelections.delete(x.id);removeReviewed='';const r=await api('/api/hierarchy/remove/review/start',{token:d.token});if(epoch!==removeEpoch)return;d.review={...r,results:[],error:''};drawRemoval(d,typed);}
  catch(err){$('#remove-status').textContent=err.message;}
  finally{removePending=false;syncRemoval();if(removalChecking())pollRemoval(epoch);}return;
 }
 if(action!=='apply'||removeApplied||removePreview.blockers.length||(removePreview.typed&&$('#remove-typed')?.value!==removePreview.title))return;
 const d=removePreview;removeApplied=true;removePending=true;syncRemoval();$('#remove-status').textContent=UI.text('ゴミ箱へ移しています…');
 try {
  const r=await api('/api/hierarchy/remove/apply',{token:d.token,optional:[...removeSelections],typed:$('#remove-typed')?.value,confirm:true});
  removeResult=r;removalResult(r);
  if(r.moved.length){if(view.project===d.project&&(!d.task||view.task===d.task)){const p=proj(d.project);view={kind:'project',project:d.task?d.project:displayParent(p,state.projects)||'Project Hub',task:null};save();}await load();}
 }catch(err){$('#remove-status').textContent=err.message;$('#remove-status').insertAdjacentHTML('beforeend',UI.html(' <button class="btn plain sm" data-remove-action="refresh" type="button">もう一度削除内容を確認</button>'));}
 finally{removePending=false;removeApplied=true;syncRemoval();/* 古いプレビューで再送しない */}
});
document.addEventListener('click',async e=>{const b=e.target.closest?.('[data-remove-restore]');if(!b||b.disabled)return;b.disabled=true;try{const r=await restoreRemoval(b.dataset.removeRestore);if(r){b.parentElement.textContent=r.skipped.length?UI.template`戻した${r.restored}件。残した理由：${r.skipped.map(x=>x.why).join(' / ')}`:UI.template`${r.restored}件を元に戻しました`;}}catch(err){toast(err.message);}finally{b.disabled=false;}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!removePending&&$('#remove-sheet')){removeEpoch++;$('#remove-sheet').hidden=true;}});
