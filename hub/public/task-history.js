'use strict';
let historyDialog=null,historySaving=false,historyOpening=false,mainSent=false;
// 対象別の送信IDを画面の外に保持し、閉じる・移動・再読込でも失わない。
const continueRequests=new Map();
function continueRequest(project,task,value){
  const key=JSON.stringify([project,task]),storage='hub-continue-'+key;
  if(value!==undefined){if(value)continueRequests.set(key,value);else continueRequests.delete(key);try{value?localStorage.setItem(storage,JSON.stringify(value)):localStorage.removeItem(storage);}catch{}}
  if(continueRequests.has(key))return continueRequests.get(key);
  try{const saved=JSON.parse(localStorage.getItem(storage)||'null');if(saved){continueRequests.set(key,saved);return saved;}}catch{}return null;
}
const continueNotices=new Map(),continueChecking=new Set(),continueStarting=new Set(),autoCompleted=new Map(),autoNeedsCompletion=new Set();
const continueKey=(project,task)=>JSON.stringify([project,task]);
function continueNotice(project,task,message){
  const key=continueKey(project,task);message?continueNotices.set(key,message):continueNotices.delete(key);
  const box=$('#history-progress');if(!box||box.dataset.p!==project||box.dataset.t!==task)return;
  box.textContent=message||'';box.hidden=!message;
}
function continued(project,task,out,notify=false){
  const key=continueKey(project,task),previous=autoCompleted.get(key);if(previous?.generation>=out.generation)return previous.promise;
  const promise=(async()=>{
    globalThis.HubChatGenerations ||=new Map();globalThis.HubChatGenerations.set(project+'\0'+task,out.generation);renderedMainKey='';
    await load();render();autoNeedsCompletion.delete(key);continueRequest(project,task,null);continueNotice(project,task,'');
    if(notify)toast(UI.text('前の会話を整理し、新しい会話へ切り替えました'));
  })().catch(err=>{if(autoCompleted.get(key)?.promise===promise)autoCompleted.delete(key);throw err;});
  autoCompleted.set(key,{generation:out.generation,promise});return promise;
}
// 保存されたIDだけを照合する。応答が失われても新しい要約は送らない。
async function resolveContinuation(project,task,check,{startAfterFailed=false}={}){
  const saved=continueRequest(project,task);
  if(saved&&!saved.finish&&check.status==='unknown'){
    const latest=await api('/api/task/continue/status?'+new URLSearchParams({project,task}),null,historyHeaders);
    if(['pending','uncertain'].includes(latest.status)||latest.status==='done'&&Number.isSafeInteger(saved.generation)&&latest.result?.generation>saved.generation)check=latest;
  }
  if(!saved&&!['pending','uncertain'].includes(check.status))return false;
  if(saved?.finish){historySaving=false;await showContinue(project,task,'',null,saved.finish);return true;}
  const requestId=check.requestId||saved?.requestId;
  if(check.status==='done'){await continued(project,task,check.result,true);return true;}
  if(check.status==='failed'&&!check.recovery&&!check.result?.pending){
    continueRequest(project,task,null);
    // 新しいクリックだけは、確定した失敗の照合後に現在の開始条件へ進む。
    // 定期照合や今回送信した処理の失敗からは、自動で再送しない。
    if(startAfterFailed)return false;
    continueNotice(project,task,UI.message(check.result?.error||'整理できませんでした'));return true;
  }
  if(!requestId){continueNotice(project,task,UI.text('会話整理の結果が未確認です。再送せず記録を確認してください'));return true;}
  continueRequest(project,task,{...saved,requestId,status:check.status});
  if(check.status==='pending'){
    const state=await api('/api/task/history/auto?'+new URLSearchParams({project,task}),null,historyHeaders);
    if(autoActive(state.auto)){drawAuto(project,task,state);clearTimeout(autoPoll);autoPoll=setTimeout(()=>refreshAuto(project,task),1500);return true;}
  }
  if(check.recovery||check.status==='uncertain'){
    const body=await api('/api/task/body/preview?'+new URLSearchParams({project,task}),null,historyHeaders);
    if(body.pending?.length)await api('/api/task/body/recover',{project,task,confirm:true});
    await api('/api/task/continue/recover',{project,task,requestId,confirm:true});
    const recovered=await api('/api/task/continue/status?'+new URLSearchParams({project,task,requestId}),null,historyHeaders);
    if(recovered.status==='done'){await continued(project,task,recovered.result);return true;}
    if(recovered.status==='pending'){await refreshAuto(project,task);return true;}
    if(recovered.status==='failed'){continueRequest(project,task,null);continueNotice(project,task,UI.message(recovered.result?.error||'整理できませんでした'));return true;}
  }
  continueNotice(project,task,UI.message(check.result?.error||'会話整理の結果が未確認です。再送せず記録を確認してください'));return true;
}
async function continueDirect(project,task){
  const key=continueKey(project,task);if(historySaving||historyOpening||continueChecking.has(key))return;
  cancelMainPreview();historySaving=true;continueChecking.add(key);continueStarting.add(key);continueNotice(project,task,'');
  drawAuto(project,task,autoLast?.project===project&&autoLast?.task===task?autoLast.view:{});let submitted=false,received=false;
  try{
    const saved=continueRequest(project,task),q=new URLSearchParams({project,task,...(saved?{requestId:saved.requestId}:{})});
    // 照合・現在版・本文プレビューは独立した読取り。同じ往復で確認し、復旧を先に扱う。
    const [checked,statusResult,preview]=await Promise.allSettled([api('/api/task/continue/status?'+q,null,historyHeaders),api('/api/task/history/status?'+new URLSearchParams({project,task,selection:'0'}),null,historyHeaders),api('/api/task/body/preview?'+new URLSearchParams({project,task}),null,historyHeaders)]);
    if(checked.status==='rejected')throw checked.reason;
    if(await resolveContinuation(project,task,checked.value,{startAfterFailed:true}))return;
    if(statusResult.status==='rejected')throw statusResult.reason;
    const status=statusResult.value,body=preview.status==='fulfilled'?preview.value:null;
    if(status.reason){continueNotice(project,task,UI.message(status.reason));return;}
    // 別タブがこの間に受け付けたIDを捨てない。
    const requestId=continueRequest(project,task)?.requestId||crypto.randomUUID();
    continueRequest(project,task,{requestId,generation:status.generation,status:'pending'});
    const useBody=body?.token&&!body.reason&&!body.warnings?.length&&!body.pending?.length;
    submitted=true;const out=await api('/api/task/continue',{project,task,confirm:true,automatic:true,generation:status.generation,revision:status.revision,requestId,...(useBody?{body:{token:body.token,confirm:true}}:{})});
    received=true;
    if(out.requestId&&out.requestId!==requestId)continueRequest(project,task,{requestId:out.requestId,generation:status.generation,status:'pending'});
    if(out.ok&&out.rotate==='ok'){await continued(project,task,out);return;}
    const current=continueRequest(project,task);
    await resolveContinuation(project,task,await api('/api/task/continue/status?'+new URLSearchParams({project,task,requestId:current.requestId}),null,historyHeaders));
  }catch(err){
    if(err.stage==='not-started')continueRequest(project,task,null);
    else if(submitted&&!received&&continueRequest(project,task)){
      const saved=continueRequest(project,task);continueRequest(project,task,{...saved,status:'uncertain'});
      try{if(await resolveContinuation(project,task,await api('/api/task/continue/status?'+new URLSearchParams({project,task,requestId:saved.requestId}),null,historyHeaders)))return;}catch(recovery){err=recovery;}
    }
    continueNotice(project,task,UI.message(err.message));
  }finally{continueChecking.delete(key);continueStarting.delete(key);historySaving=false;if(autoLast?.project===project&&autoLast?.task===task)drawAuto(project,task,autoLast.view);}
}
function historySheet(title,body,actions=''){
  let sheet=$('#task-history-sheet');if(!sheet){document.body.insertAdjacentHTML('beforeend','<div id="task-history-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true"></div>');sheet=$('#task-history-sheet');}
  sheet.innerHTML=UI.template`<div class="remove-box history-box"><header><h2>${esc(title)}</h2><button class="btn plain sm" data-history-action="close" type="button">閉じる</button></header><div class="history-content">${body}<p id="history-status" role="status"></p></div><footer>${actions}</footer></div>`;sheet.hidden=false;return sheet;
}
const historyHeaders={'X-Hub':'1'};
function historyBodySection(body){
  if(body.error)return UI.template`<p class="danger">${UI.text('本文整理：')}${esc(body.error)}</p>`;
  if(body.pending.length)return UI.template`<p class="danger">${UI.text('本文整理の結果が不明です。保管済み原文を照合して復旧してから続けてください。')}</p><button class="btn plain" data-history-action="bodyrecover" type="button">保管済み原文を照合して復旧する</button>`;
  const reason=body.reason?UI.template`<p class="danger">${esc(body.reason)}</p>`:'';
  if(!body.moves.length)return UI.template`<p>${UI.text('整理する本文はありません。')}</p>${reason}`;
  return UI.template`<fieldset class="history-body"><legend>作業本文</legend><label><input type="checkbox" id="continue-body" ${body.token?'':'disabled'}>作業本文も整理する</label>${reason}${body.warnings.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}${body.enabled?'':UI.template`<p>${UI.text('はじめての本文整理です。移す量と保管先を確認してください。成果欄はそのまま残します。')}</p>`}<p>${UI.text('保管する量')}：${body.moves.reduce((n,x)=>n+x.characters,0)} ${UI.text('字')} / ${body.moves.reduce((n,x)=>n+x.lines,0)} ${UI.text('行')}</p><ul>${body.moves.map(x=>UI.template`<li>${esc(x.source)} / ${esc(x.section)}：${x.characters} ${UI.text('字')} → ${esc(x.archive)}</li>`).join('')}</ul><label><input type="checkbox" id="continue-body-confirm">移す量と保管先を確認しました</label></fieldset>`;
}
async function showContinue(project,task,notice='',keep=null,finish=null){
  // 旧入口・復旧後の呼出しも、通常作業では確認画面を作らない。finishだけ旧方式を保つ。
  if(!finish&&!continueRequest(project,task)?.finish){
    if(historyDialog?.project===project&&historyDialog?.task===task&&!historyDialog.finish){const sheet=$('#task-history-sheet');if(sheet)sheet.hidden=true;historyDialog=null;}
    return continueDirect(project,task);
  }
  cancelMainPreview();
  if(historyOpening||historySaving)return;
  historyOpening=true;let status,body,archives,bodyArchives,check;const saved=continueRequest(project,task),q=new URLSearchParams({project,task});
  try{[status,body,archives,bodyArchives,check]=await Promise.all([api('/api/task/history/status?'+q,null,historyHeaders),api('/api/task/body/preview?'+q,null,historyHeaders).catch(e=>({error:UI.message(e.message)})),api('/api/task/history/archives?'+q,null,historyHeaders).then(d=>d.archives).catch(()=>[]),api('/api/task/body/archives?'+q,null,historyHeaders).then(d=>d.archives).catch(()=>[]),api('/api/task/continue/status?'+new URLSearchParams({project,task,...(saved?{requestId:saved.requestId}:{})}),null,historyHeaders)]);}finally{historyOpening=false;}
  finish=finish||saved?.finish;
  let unresolved=false,resolved=false;
  if(saved||['pending','uncertain'].includes(check.status)){
    if(check.status==='done'){
      continueRequest(project,task,null);resolved=true;notice=UI.text('原文保管と会話の切り替えは済んでいます。再実行していません。');
      globalThis.HubChatGenerations ||=new Map();globalThis.HubChatGenerations.set(project+'\0'+task,check.result.generation);renderedMainKey='';
      if(finish)return showCompletion(project,task,check.result.completionHash,{tidy:finish.tidy,prepared:true});
    }else if(check.status==='failed'){continueRequest(project,task,null);notice=UI.message(check.result?.error||'');}
    else{unresolved=true;continueRequest(project,task,{...saved,requestId:check.requestId||saved?.requestId,status:'uncertain',finish});notice=UI.text('会話整理の結果が未確認です。再送せず記録を確認してください');}
  }
  historyDialog={project,task,status,body,finish,unresolved,resolved,check,requestId:unresolved?(check.requestId||saved?.requestId):crypto.randomUUID()};
  const selection=status.selection||{topics:0,residual:0,unconfirmed:0};
  historySheet(UI.text(finish?'最終要約を保管する':'要約して続ける'),UI.template`<p>長くなった会話と作業本文を軽くして、同じ作業を続けます。旧会話の原文は保存し、手順・成果・作業用コピーは残します。次の会話は自動で選んだ要約から始まり、原文は必要な時だけ読みます。</p>${notice?UI.template`<p class="danger">${esc(notice)}</p>`:''}${status.reason?UI.template`<p class="danger">${esc(status.reason)}</p>`:''}<section class="history-selection" aria-label="${UI.text('自動選別')}"><p>要約の入力は不要です。Hubが必要な情報を自動で選び、話題ごとに保存します。承認は人の発言から引用できるものだけを残します。</p><p>${UI.text('整理前の確認')}：${UI.text('話題')} ${selection.topics} / ${UI.text('残件')} ${selection.residual} / ${UI.text('承認未確認（AI推定）')} ${selection.unconfirmed}</p></section>${historyBodySection(body)}<p class="small"><button class="btn plain sm" type="button" data-task-history="archives" data-p="${esc(project)}" data-t="${esc(task)}">${UI.text('過去の会話')}（${archives.length}）</button> <button class="btn plain sm" type="button" data-history-action="bodyarchives">${UI.text('保管した本文の原文')}（${bodyArchives.length}）</button></p>`,UI.template`<button class="btn plain" data-history-action="refresh" type="button">最新の記録を確認する</button>${unresolved&&check.recovery?UI.html('<button class="btn plain" data-history-action="continuerecover" type="button">保存済みの会話を照合して復旧する</button>'):''}<button class="btn" data-history-action="continue" type="button" ${status.reason||body.pending?.length||unresolved||resolved?'disabled':''}>${UI.text(finish?'最終要約を保管する':'要約して続ける')}</button>`);
}
async function showBodyArchives(project,task,file){
  cancelMainPreview();
  const q=new URLSearchParams({project,task});
  if(file){const d=await api('/api/task/body/archive?'+new URLSearchParams({project,task,path:file}),null,historyHeaders);historySheet(UI.text('保管した本文の原文'),UI.template`<p>${esc(d.path)}</p><pre>${esc(d.text)}</pre>`);return;}
  const d=await api('/api/task/body/archives?'+q,null,historyHeaders);historyDialog={project,task};
  historySheet(UI.text('保管した本文の原文'),d.archives.length?d.archives.map(a=>UI.template`<p><button class="btn plain" type="button" data-body-archive="${esc(a.path)}">${esc(a.path)}（${a.characters} ${UI.text('字')}）</button></p>`).join(''):UI.html('<p>保管した本文はありません。</p>'));
}
async function showCompletion(project,task,expectedHash,options={}){
  cancelMainPreview();
  historyDialog={project,task,expectedHash,prepared:options.prepared,tidy:Boolean(options.tidy)};
  historySheet(UI.text('完了に移す'),project==='freetalk'?UI.html('<p>この作業を完了に移します。あとで再開できます。</p>'):UI.template`<p>この作業を完了に移します。成果・会話・作業用コピーはそのまま残ります。あとで再開できます。</p>${options.prepared?UI.html('<p>最終要約と会話の原文を保管しました。</p>'):''}`,UI.html('<button class="btn" data-history-action="complete" type="button">完了に移す</button>'));
}
async function showTidy(project,task){
  cancelMainPreview();
  const d=await api('/api/task/tidy/preview',{project,task});historyDialog={project,task,tidy:d};
  const keep=d.keep.length?UI.template`<p>${UI.text('残すもの')}</p><ul>${d.keep.map(x=>UI.template`<li>${esc(x.path)}：${esc(x.why)}</li>`).join('')}</ul>`:'';
  const body=d.blockers.length?UI.template`${d.blockers.map(x=>UI.template`<p class="danger">${esc(x)}</p>`).join('')}${keep}`:!d.move.length?UI.template`<p>${UI.text('ゴミ箱へ移せる物はありません。')}</p>${keep}`:UI.template`<fieldset><legend>ゴミ箱へ移す物</legend>${d.move.map(x=>UI.template`<label><input type="checkbox" data-tidy-id="${esc(x.id)}" checked>${esc(x.id)}（${esc(x.what)}）</label>`).join('')}</fieldset>${keep}<p><label><input type="checkbox" id="tidy-confirm">移す物と残す物を確認しました</label></p>`;
  historySheet(UI.text('終了の片付け'),body,UI.template`<button class="btn plain" data-history-action="tidyskip" type="button">片付けない</button>${d.token?UI.html('<button class="btn" data-history-action="tidy" type="button">ゴミ箱へ移す</button>'):''}`);
}
async function historyAfter(d){$('#task-history-sheet').hidden=true;await load();render();}
async function showArchives(project,task){
  cancelMainPreview();
  historyDialog={project,task};const d=await api('/api/task/history/archives?'+new URLSearchParams({project,task}),null,{'X-Hub':'1'});
  historySheet(UI.text('過去の会話'),d.archives.length?d.archives.map(a=>UI.template`<p><button class="btn plain" type="button" data-history-archive="${esc(a.id)}">${esc(a.at)} ／ ${UI.text('会話')} ${a.generation}</button></p>`).join(''):UI.html('<p>保存された過去の会話はありません。</p>'),UI.html('<button class="btn plain sm" type="button" data-history-action="bodyarchives">保管した本文の原文</button>'));
}
async function showArchivePage(project,task,id,offset){
  const d=await api('/api/task/history/archive?'+new URLSearchParams({project,task,archiveId:id,offset}),null,{'X-Hub':'1'});
  const start=Number(d.offset??offset)||0,prev=start>0?UI.template`<button class="btn plain" data-history-next="${Math.max(0,start-100)}" data-archive-id="${esc(id)}">前の原文</button>`:'';
  historySheet(UI.text('過去の会話（原文）'),d.rows.map(r=>UI.template`<article><b>${esc(r.role==='user'?UI.text('人'):r.ai||r.role)}</b><pre>${esc(r.text||'')}${r.asks?.length?'\n'+esc(JSON.stringify(r.asks)):''}</pre></article>`).join(''),prev+(Number(offset)+d.rows.length<d.total?UI.template`<button class="btn plain" data-history-next="${Number(offset)+d.rows.length}" data-archive-id="${esc(id)}">続きの原文</button>`:''));
  return {sheet:$('#task-history-sheet'),start,rows:d.rows};
}
// Search destination: open the archived page holding the matched row and mark it.
async function openArchiveAt(project,task,id,row,matches,mark){
  cancelMainPreview();historyDialog={project,task};
  const page=await showArchivePage(project,task,id,Math.floor(Math.max(0,Number(row)||0)/100)*100);
  const index=Number(row)-page.start,articles=page.sheet.querySelectorAll('.history-content > article');
  if(!matches(page.rows[index])||!articles[index])return false;
  mark(articles[index]);return true;
}

let mainPreviewSerial=0;
const mainDeliveries=new Map();
const oneclickPlans=new Map(),oneclickSending=new Set(),oneclickWatching=new Set(),oneclickReads=new Map();
const oneclickKey=(project,task)=>JSON.stringify([project,task]);
const sameOneclick=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function oneclickCurrent(project,task){return view.kind==='work'&&view.project===project&&view.task===task;}
function oneclickComplete(plan){
 const m=plan?.main,f=plan?.flow;
 if(plan?.loading||plan?.error||plan?.recovery)return false;
 if(f?.stage==='complete')return Boolean(m&&f.sourceHead===m.sourceHead);
 return Boolean((!f||f.stage==='ready')&&m?.alreadyIncluded===true&&(!m.switchHub||m.switchNeeded===false)&&!(m.waiting||[]).length);
}
function oneclickText(flow){
 if(flow?.stage==='complete')return flow.restart?'本体への取り込みと新版の起動確認が完了しました。作業・会話・コピーは残っています。':'本体への取り込みが完了しました。作業・会話・コピーは残っています。';
 if(flow?.stage==='waiting')return '本体への取り込みは完了しています。ほかの保存が終わるまで新版への切替を待っています。';
 if(flow?.stage==='switching')return '本体への取り込みは完了しています。新版の起動を確認しています。';
 if(flow?.stage==='approved')return '送信記録を照合しています。取り込みは送り直しません。';
 if(flow?.stage==='stopped')return '前回の取り込みは中止しました。衝突箇所を直して保存してから進めてください。';
 return flow?.error||'取り込みの結果が未確認です。結果照合を続け、取り込みは送り直しません。';
}
function drawOneclickMain(project,task,plan){
 if(!oneclickCurrent(project,task))return;
 const button=document.querySelector('[data-act="merge"]');if(!button)return;
 let region=document.querySelector('[data-main-preview]');
 if(!region){button.insertAdjacentHTML('afterend','<section data-main-preview class="main-merge-inline" role="status"></section>');region=document.querySelector('[data-main-preview]');}
 if(!region)return;
 const m=plan.main,flow=plan.flow,progress=flow&&flow.stage!=='ready';
 const waiting=(m?.waiting||[]).map(x=>x.message).join(' / ');
 const message=plan.error|| (progress?oneclickText(flow):oneclickComplete(plan)?'本体への反映と必要な起動確認は完了しています。新しい変更があれば取り込めます。':waiting||(plan.loading&&!m?'本体と作業用コピーの最新の記録を確認しています。':'このボタン1回で、表示した範囲の取り込みと必要な新版の起動確認まで進みます。'));
 const scope=m?UI.template`<p>対象：${esc(m.target)}<br>変更：${m.alreadyIncluded?'本体へ反映済み（追加の変更なし）':UI.template`${m.files}ファイル`}${m.switchHub?UI.template` ／ Hub v${esc(m.switchVersion)}${m.switchNeeded===false?'の起動確認（起動済み・切替不要）':'への切替と起動確認'}`:''}<br>作業・会話・コピー・下書き・残っている手順を保持します。</p><details class="main-merge-residual" data-work-fold="residual"><summary>取り込む保存と残っている手順</summary><p>作業の保存：${esc(m.sourceHead)}<br>本体の保存：${esc(m.targetHead)}</p><pre>${esc(m.residual||'手順の残りなし')}</pre></details>`:'';
 const recovery=plan.recovery?UI.template`<p>前回の衝突中止（${esc(plan.recovery.at)}）を復帰記録と照合してから、表示した最新の保存を取り込みます。この日時の中止を解消した作業が対象です。</p>`:'';
 const complete=oneclickComplete(plan);
 button.hidden=false;button.disabled=Boolean(complete||plan.loading||plan.error||progress||!m?.token||waiting||oneclickSending.has(oneclickKey(project,task)));
 const checking=!complete&&flow?.stage==='unknown';
 const stopped=!complete&&(plan.error||['stopped','blocked'].includes(flow?.stage));
 const busy=!complete&&!checking&&!stopped&&(['approved','waiting','switching'].includes(flow?.stage)||oneclickSending.has(oneclickKey(project,task)));
 button.classList.toggle('main-merge-busy',Boolean(busy||checking));
 button.textContent=UI.text(complete?'本体へ反映済み':checking?'結果確認中':stopped?flow?.stage==='blocked'?'取り込み要確認':'取り込み停止':busy?'取り込み中':'本体に取り込む');
 button.title=UI.text(complete?'本体への反映と必要な起動確認は完了しています。新しい変更があれば取り込めます。':checking?'取り込みの結果を照合しています。送り直しません。':stopped?plan.error||oneclickText(flow):busy?'取り込みと必要な新版の起動確認を進めています。完了まで押せません。':'表示した範囲を取り込み、作業とコピーを残して必要な新版の起動確認まで進めます');
 const targetName=typeof proj==='function'?(proj(project)?.name||project):project;
 const status=plan.error?'停止：'+plan.error:progress?oneclickText(flow):waiting?'待機：'+(m.waiting[0]?.message||waiting).split('\n')[0]+(m.waiting.length>1?UI.template`（ほか${m.waiting.length-1}件）`:''):!m?message:'';
 const brief=m?UI.template`取り込み：${targetName}本体・${m.alreadyIncluded?'反映済み':m.files+'ファイル'}${m.switchHub?UI.template`・Hub v${m.switchVersion}${m.switchNeeded===false?'起動済み':'へ切替'}`:''}・作業とコピーは残します`:'';
 const compactBrief=m?UI.template`${targetName}本体${m.alreadyIncluded?'反映済み':m.files+'ファイル'}${m.switchHub?UI.template`${m.switchNeeded===false?'・':'→'}v${m.switchVersion}`:''}・作業/コピー保持`:'';
 const opened=typeof workFoldAttr==='function'?workFoldAttr({id:project},{id:task},'merge'):'';
 const html=UI.template`<div class="main-merge-summary"><span class="main-merge-brief ${plan.error?'danger':waiting?'merge-wait':''}" title="${esc(status||brief)}"><span class="merge-full">${esc(UI.message(status||brief))}</span><span class="merge-compact">${esc(UI.message(status||compactBrief))}</span></span><details class="main-merge-details" data-work-fold="merge" ><summary>詳細</summary><div class="main-merge-detail-body"><p>${esc(brief)}</p><p>${esc(UI.message(message))}</p>${recovery}${scope}</div></details></div>`;
 // A token refresh must not replace the visible scope, expanded details or selection.
 if(region.mainPreviewHtml!==html){
  const details=region.querySelector?.('details'),pre=region.querySelector?.('pre');
  const open=details?.open,scroll=pre?.scrollTop,folds=[...(region.querySelectorAll?.('details[data-work-fold]')||[])].map(d=>[d.dataset.workFold,d.open]);
  region.innerHTML=html;region.mainPreviewHtml=html;
  const next=region.querySelector?.('details');if(next)next.open=open===undefined?Boolean(opened):open;
  for(const d of region.querySelectorAll?.('details[data-work-fold]')||[]){const kept=folds.find(([name])=>name===d.dataset.workFold);if(kept)d.open=kept[1];else if(typeof workFoldAttr==='function')d.open=Boolean(workFoldAttr({id:project},{id:task},d.dataset.workFold));}
  const nextPre=region.querySelector?.('pre');if(nextPre&&scroll!==undefined)nextPre.scrollTop=scroll;
 }
 region.hidden=false;
}
async function prepareOneclickMain(project,task,button){
 const key=oneclickKey(project,task),previous=oneclickPlans.get(key);
 // An approved flow owns its identity until it settles; periodic reads never replace it.
 if(previous&&(oneclickSending.has(key)||(previous.flow?.requestId&&!['ready','complete','stopped','blocked'].includes(previous.flow.stage)))){
  drawOneclickMain(project,task,previous);watchOneclickMain(project,task,previous.flow?.requestId);return;
 }
 const plan={loading:true,main:previous?.main},read={button};oneclickReads.set(key,read);oneclickPlans.set(key,plan);
 drawOneclickMain(project,task,{...previous,loading:true});
 const current=()=>oneclickReads.get(key)===read&&oneclickPlans.get(key)===plan&&oneclickCurrent(project,task)&&button===document.querySelector('[data-act="merge"]');
 try{
  const old=mainDelivery(project,task);plan.old=old;
  if(old){
   if(typeof old==='object'&&old.requestId){
    const d=await api('/api/task/merge/status',{project,task,requestId:old.requestId});
    if(!current())return;
    if(!sameOneclick(old,mainDelivery(project,task)))throw Error('別の画面で送信記録が変わりました。再送しません。');
    if(['applied','aborted','not-sent'].includes(d.state)&&sameOneclick(old,mainDelivery(project,task)))mainDelivery(project,task,null);
    else if(d.state==='unknown'){
     plan.flow=await api('/api/task/merge/status',{project,task,flow:true,requestId:old.requestId});
     if(!current())return;
     if(plan.flow.stage==='ready')plan.flow={stage:'unknown',requestId:old.requestId};
    }
   }else if(old==='uncertain'){
    const d=await api('/api/task/merge/status',{project,task,legacy:true});if(!current())return;
    if(!sameOneclick(old,mainDelivery(project,task)))throw Error('別の画面で送信記録が変わりました。再送しません。');
    if(d.state==='applied'&&sameOneclick(old,mainDelivery(project,task)))mainDelivery(project,task,null);
    else if(d.recovery)plan.recovery=d.recovery;else plan.error='前回の取り込みを特定できません。再送せず、記録の確認が必要です。';
   }else plan.error='取り込みの送信記録を確認できません。再送しません。';
  }
  if(!plan.flow)plan.flow=await api('/api/task/merge/status',{project,task,flow:true});
  if(!current())return;
  if(plan.flow.stage!=='ready'&&plan.flow.stage!=='complete'&&plan.flow.stage!=='stopped'){plan.loading=false;drawOneclickMain(project,task,plan);watchOneclickMain(project,task,plan.flow.requestId);return;}
  plan.main=await api('/api/task/merge/preview',{project,task});if(!current())return;
  if(plan.flow?.stage==='complete'&&(plan.main.sourceHead!==plan.flow.sourceHead||!plan.main.alreadyIncluded||plan.main.switchNeeded))plan.flow=null;
  if(plan.flow?.stage==='stopped'&&plan.main.sourceHead!==plan.flow.sourceHead&&['aborted','not-sent'].includes(plan.flow.delivery?.state))plan.flow=null;
  if(plan.recovery&&(plan.main.sourceHead!==plan.recovery.sourceHead||plan.main.targetHead!==plan.recovery.targetHead))throw Error('中止記録の確認後に保存が変わりました。送信しません。');
 }catch(e){if(current())plan.error=e.message;}
 if(current()){plan.loading=false;drawOneclickMain(project,task,plan);}
}
function watchOneclickMain(project,task,requestId){
 if(!requestId)return;const key=oneclickKey(project,task);if(oneclickWatching.has(key))return;oneclickWatching.add(key);
 const poll=async()=>{
  let terminal=false;
  try{
   const owner=oneclickPlans.get(key);
   let flow=await api('/api/task/merge/status',{project,task,flow:true,requestId});
   if(['ready','unknown'].includes(flow.stage)){
    const delivery=await api('/api/task/merge/status',{project,task,requestId});
    if(oneclickPlans.get(key)===owner&&oneclickCurrent(project,task)&&(!owner?.flow?.requestId||owner.flow.requestId===requestId)&&['not-sent','aborted'].includes(delivery.state)&&sameOneclick(mainDelivery(project,task),{state:'uncertain',requestId})){
     mainDelivery(project,task,null);owner.flow={stage:'stopped'};
     oneclickWatching.delete(key);await prepareOneclickMain(project,task,document.querySelector('[data-act="merge"]'));return;
    }
    if(flow.stage==='ready')flow={stage:'unknown',requestId};
   }
   const plan=oneclickPlans.get(key);if(plan&&plan===owner&&(!plan.flow?.requestId||plan.flow.requestId===requestId)){plan.flow=flow;drawOneclickMain(project,task,plan);}
   terminal=['complete','blocked','stopped'].includes(flow.stage);
   if(flow.stage==='complete'&&sameOneclick(mainDelivery(project,task),{state:'uncertain',requestId}))mainDelivery(project,task,null);
   if(!terminal&&flow.restart){const next=await api('/api/state');if(typeof observeRestart==='function')observeRestart(next);}
  }catch{try{const next=await api('/api/state');if(typeof observeRestart==='function')observeRestart(next);}catch{/* lost responses only cause another read */}}
  if(terminal||!oneclickCurrent(project,task)){oneclickWatching.delete(key);return;}
  setTimeout(poll,800);
 };setTimeout(poll,0);
}
async function runOneclickMain(project,task){
 const key=oneclickKey(project,task),plan=oneclickPlans.get(key);
 if(oneclickSending.has(key)||oneclickComplete(plan)||plan?.loading||!plan?.main?.token||plan.error||(plan.flow&&plan.flow.stage!=='ready'))return;
 oneclickReads.delete(key);oneclickSending.add(key);const token=plan.main.token;plan.main.token='';
 drawOneclickMain(project,task,plan);
 try{
  if(!plan.recovery&&mainDelivery(project,task))throw Error('別の画面から取り込みを送信しています。再送しません。');
  if(plan.recovery){
   if(!sameOneclick(plan.old,mainDelivery(project,task)))throw Error('前回の送信記録が変わりました。送信しません。');
   const d=await api('/api/task/merge/status',{project,task,legacy:true,confirm:true,abortAt:plan.recovery.at,sourceHead:plan.recovery.sourceHead,targetHead:plan.recovery.targetHead});
   if(d.state!=='aborted'||!sameOneclick(plan.old,mainDelivery(project,task)))throw Error('前回の中止を照合できません。送信しません。');
   mainDelivery(project,task,null);
  }
  const marker={state:'uncertain',requestId:token},storageKey='hub-main-delivery-'+key;
  localStorage.setItem(storageKey,JSON.stringify(marker));if(localStorage.getItem(storageKey)!==JSON.stringify(marker))throw Error('送信番号を保存できません。送信しません。');mainDeliveries.set(key,marker);
  plan.flow={stage:'approved',requestId:token};drawOneclickMain(project,task,plan);
  const out=await api('/api/task/merge',{project,task,token,oneclick:true});
  if(out.requestId&&out.requestId!==token&&sameOneclick(marker,mainDelivery(project,task)))mainDelivery(project,task,{state:'uncertain',requestId:out.requestId});
  plan.flow=out.flow||{stage:'approved',requestId:out.requestId||token};drawOneclickMain(project,task,plan);watchOneclickMain(project,task,plan.flow.requestId);
 }catch(e){
  if(['not-sent','aborted'].includes(typeof e.delivery==='string'?e.delivery:e.delivery?.state)){
   if(sameOneclick(mainDelivery(project,task),{state:'uncertain',requestId:token}))mainDelivery(project,task,null);
   plan.error=e.message;plan.flow={stage:'stopped'};
  }else if(plan.flow?.requestId){plan.flow={stage:'unknown',requestId:token,error:e.message};watchOneclickMain(project,task,token);}
  else plan.error=e.message;
  drawOneclickMain(project,task,plan);
 }finally{oneclickSending.delete(key);drawOneclickMain(project,task,plan);}
}
const mainViewKey=()=>typeof view==='undefined'?null:JSON.stringify([view.kind,view.project,view.task]);
function mainDelivery(project,task,value){
  const key=JSON.stringify([project,task]),storage='hub-main-delivery-'+key;
  if(value!==undefined){value?mainDeliveries.set(key,value):mainDeliveries.delete(key);try{value?localStorage.setItem(storage,typeof value==='string'?value:JSON.stringify(value)):localStorage.removeItem(storage);}catch{}}
  try{if(typeof localStorage.setItem==='function'&&typeof localStorage.removeItem==='function'){const v=localStorage.getItem(storage);if(!v)return null;try{return JSON.parse(v);}catch{return v;}}}catch{}
  return mainDeliveries.get(key)||null;
}
const sameMainDelivery=(project,task,saved)=>JSON.stringify(mainDelivery(project,task))===JSON.stringify(saved);
function cancelMainPreview(){mainPreviewSerial++;if(historyDialog?.mainView){historyDialog.main=null;historyDialog=null;}}
function invalidateMainNavigation(){
  if(historyDialog?.mainView&&historyDialog.viewKey!==mainViewKey()){cancelMainPreview();const sheet=$('#task-history-sheet');if(sheet)sheet.hidden=true;}
}
function drawMainContinuation(d){
  const m=d.main,blocked=d.blocker;
  const reason=blocked?UI.template`<section role="alert"><p class="danger">${esc(UI.message(blocked.reason))}</p>${blocked.paths?.length?UI.template`<p>対象パス</p><ul>${blocked.paths.map(p=>UI.template`<li><code>${esc(p)}</code></li>`).join('')}</ul>`:''}${blocked.hiddenPaths?UI.html('<p>秘密設定などのパスは表示していません。</p>'):''}${blocked.morePaths?UI.html('<p>対象が多いため、一部のパスだけ表示しています。</p>'):''}<p>${esc(UI.message(blocked.next))}</p><p>取り込みは開始していません。</p></section>`:d.error?UI.template`<p class="danger">${esc(UI.message(d.error))}</p>`:'';
  const unknown=mainDelivery(d.project,d.task);
  if(unknown&&m)m.token='';
  historySheet(UI.text('本体に取り込む'),UI.template`<section class="main-merge-status" role="status">${reason}${d.loading?UI.html('<p>本体と作業用コピーの最新の記録を確認しています。</p>'):''}${d.notice?UI.template`<p>${esc(UI.message(d.notice))}</p>`:''}${unknown?UI.html('<p class="danger">取り込みの結果が未確認です。再送せず、本体の保存履歴と取り込み記録を確認してください。</p>'):''}${d.recovery?UI.template`<p>前回の衝突中止記録：${esc(d.recovery.at)}。この記録が止まった取り込みと一致する場合だけ、［前回の中止記録を照合する］を押してください。</p>`:''}${m?UI.template`<p>${esc((m.waiting||[]).map(x=>x.message).join(' / '))}</p>`:''}</section>${m?UI.template`<p>対象：${esc(m.target)}<br>保存済みHEAD：${esc(m.sourceHead)}<br>本体HEAD：${esc(m.targetHead)}<br>変更：${m.files} ${UI.text('ファイル')}</p><p>本体への取り込み後も、同じ作業・会話・コピーを残して続けます。新版の起動や公開は別の確認です。</p><details class="main-merge-residual"><summary>残っている手順を確認する（取り込み後も残ります）</summary><pre>${esc(m.residual||UI.text('手順の残りなし'))}</pre></details>`:''}`,UI.template`<button class="btn plain" data-history-action="main-refresh" type="button" ${d.loading||historySaving?'disabled':''}>最新の記録を確認する</button>${d.recovery?UI.template`<button class="btn plain" data-history-action="main-recover" type="button" ${d.loading||historySaving?'disabled':''}>前回の中止記録を照合する</button>`:''}<button class="btn" data-history-action="merge" type="button" ${!m?.token||d.loading||blocked||d.error||unknown||(m.waiting||[]).length?'disabled':''}>本体に取り込む（作業は残す）</button>`);
}
async function showMainContinuation(project,task){
  if(historySaving)return;
  const request=++mainPreviewSerial,d={project,task,mainView:true,viewKey:mainViewKey(),loading:true,main:null};
  historyDialog=d;mainSent=Boolean(mainDelivery(project,task));drawMainContinuation(d);
  try{
    const saved=mainDelivery(project,task);
    if(saved){
      const result=await api('/api/task/merge/status',{project,task,...(saved==='uncertain'?{legacy:true}:{requestId:saved.requestId||'invalid'})});
      if(request!==mainPreviewSerial||historyDialog!==d||d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
      if(sameMainDelivery(project,task,saved)&&['aborted','applied','not-sent'].includes(result.state)){mainDelivery(project,task,null);mainSent=false;d.notice=result.state==='applied'?'前回の保存は本体に反映済みです。追加の変更があれば、今回の範囲を確認してください。':result.state==='aborted'?'前回の取り込みは中止し、元の状態に戻ったことを確認しました。新しい保存範囲を確認してください。':'前回の取り込みは開始していません。新しい保存範囲を確認してください。';}
      else if(sameMainDelivery(project,task,saved))d.recovery=result.recovery;
    }
    const m=await api('/api/task/merge/preview',{project,task});
    if(request!==mainPreviewSerial||historyDialog!==d||d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
    d.main=m;
  }catch(e){
    if(request!==mainPreviewSerial||historyDialog!==d||d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
    d.blocker=e.blocker;d.error=e.blocker?'':e.message;
  }
  d.loading=false;drawMainContinuation(d);
}
document.addEventListener('click',async e=>{
  const open=e.target.closest?.('[data-task-history]');
  if(open){if(historySaving)return;try{await (open.dataset.taskHistory==='archives'?showArchives:continueDirect)(open.dataset.p,open.dataset.t);}catch(err){toast(UI.message(err.message));}return;}
  const bodyArchive=e.target.closest?.('[data-body-archive]');
  if(bodyArchive&&historyDialog){try{await showBodyArchives(historyDialog.project,historyDialog.task,bodyArchive.dataset.bodyArchive);}catch(err){toast(UI.message(err.message));}return;}
  const archive=e.target.closest?.('[data-history-archive]'),next=e.target.closest?.('[data-history-next]');
  if(archive||next){try{const {project,task}=historyDialog,id=archive?.dataset.historyArchive||next.dataset.archiveId,offset=next?.dataset.historyNext||0;await showArchivePage(project,task,id,offset);}catch(err){toast(UI.message(err.message));}return;}
  const b=e.target.closest?.('[data-history-action]');if(!b||historySaving)return;
  if(b.dataset.historyAction==='close'){cancelMainPreview();$('#task-history-sheet').hidden=true;return;}
  if(b.dataset.historyAction==='auto-cancel'){const box=$('#history-progress');if(!box)return;b.disabled=true;try{drawAuto(box.dataset.p,box.dataset.t,await api('/api/task/history/auto/cancel',{project:box.dataset.p,task:box.dataset.t}));refreshAuto(box.dataset.p,box.dataset.t);}catch(err){toast(UI.message(err.message));b.disabled=false;}return;}
  const d=historyDialog;if(!d)return;
  if(d.status&&!d.finish&&!d.mainView&&['continue','refresh','continuerecover','bodyrecover'].includes(b.dataset.historyAction)){
    const sheet=$('#task-history-sheet');if(sheet)sheet.hidden=true;historyDialog=null;await continueDirect(d.project,d.task);return;
  }
  if(d.mainView&&d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
  if(b.dataset.historyAction==='main-refresh'){if(d.mainView)await showMainContinuation(d.project,d.task);return;}
  if(b.dataset.historyAction==='main-recover'){
    if(!d.mainView||!d.recovery||d.loading)return;
    if(!confirm(UI.text('表示した時刻の衝突で止まった取り込みと一致しますか？別の取り込みや通信切れの場合はキャンセルしてください。取り込み自体はまだ実行しません。')))return;
    const saved=mainDelivery(d.project,d.task),proof=d.recovery;if(saved!=='uncertain')return;historySaving=true;b.disabled=true;
    try{
      const result=await api('/api/task/merge/status',{project:d.project,task:d.task,legacy:true,confirm:true,abortAt:proof.at,sourceHead:proof.sourceHead,targetHead:proof.targetHead});
      if(historyDialog!==d||d.viewKey!==mainViewKey()||!sameMainDelivery(d.project,d.task,saved)){invalidateMainNavigation();return;}
      if(result.state!=='aborted'){d.error='中止記録の照合ができません。再送せず、記録を確認してください。';d.recovery=null;drawMainContinuation(d);return;}
      mainDelivery(d.project,d.task,null);mainSent=false;historySaving=false;await showMainContinuation(d.project,d.task);
    }catch{if(historyDialog===d){d.error='中止記録の照合ができません。再送せず、記録を確認してください。';drawMainContinuation(d);}}
    finally{historySaving=false;}return;
  }
  const typed=()=>null;
  if(b.dataset.historyAction==='refresh'){try{await showContinue(d.project,d.task,'',typed(),d.finish);}catch(err){$('#history-status').textContent=UI.message(err.message);}return;}
  if(b.dataset.historyAction==='bodyarchives'){try{await showBodyArchives(d.project,d.task);}catch(err){$('#history-status').textContent=UI.message(err.message);}return;}
  if(b.dataset.historyAction==='tidyskip'){try{await historyAfter(d);}catch(err){toast(UI.message(err.message));}return;}
  historySaving=true;b.disabled=true;
  try{
    if(b.dataset.historyAction==='continuerecover'){
      const out=await api('/api/task/continue/recover',{project:d.project,task:d.task,requestId:d.requestId,confirm:true});
      historySaving=false;await showContinue(d.project,d.task,'',typed(),d.finish);return;
    }
    if(b.dataset.historyAction==='bodyrecover'){
      if(!confirm(UI.text('保管済み原文を照合して、本文整理を最後まで済ませますか？')))return;
      await api('/api/task/body/recover',{project:d.project,task:d.task,confirm:true});toast(UI.text('保管済み原文を照合して復旧しました'));if(d.unresolved)await api('/api/task/continue/recover',{project:d.project,task:d.task,requestId:d.requestId,confirm:true});historySaving=false;await showContinue(d.project,d.task,'',typed(),d.finish);return;
    }
    if(b.dataset.historyAction==='complete'){
      await api('/api/task/completion',{project:d.project,task:d.task,action:'approve',confirm:true,expectedHash:d.expectedHash});toast(UI.text('完了に移しました'));await load();render();
      if(d.tidy)await showTidy(d.project,d.task);else await historyAfter(d);return;
    }
    if(b.dataset.historyAction==='tidy'){
      if(!$('#tidy-confirm').checked)throw Error(UI.text('移す物と残す物を確認してください'));
      const ids=[...document.querySelectorAll('[data-tidy-id]')].filter(x=>x.checked).map(x=>x.dataset.tidyId);if(!ids.length)throw Error(UI.text('移す物を選んでください'));
      const r=await api('/api/task/tidy/apply',{project:d.project,task:d.task,token:d.tidy.token,ids,confirm:true});d.tidy.token='';
      const message=r.failed.length?UI.template`${r.moved.length}件を移し、${r.failed.map(x=>x.why).join(' / ')}のため止めました。`:UI.template`${r.moved.length}件をゴミ箱へ移しました。`;
      $('#history-status').innerHTML=UI.template`${esc(message)}${r.moved.length?UI.template` <button class="btn plain sm" data-remove-restore="${esc(r.record)}" type="button">元に戻す</button>`:''}`;$('#task-history-sheet footer').innerHTML='';await load();render();return;
    }
    if(b.dataset.historyAction==='continue'){
      if(d.unresolved||d.resolved||continueRequest(d.project,d.task))throw Error(UI.text('会話整理の結果が未確認です。再送せず記録を確認してください'));
      const useBody=Boolean($('#continue-body')?.checked);
      if(useBody&&!$('#continue-body-confirm').checked)throw Error(UI.text('移す量と保管先を確認してください'));
      continueRequest(d.project,d.task,{requestId:d.requestId,generation:d.status.generation,status:'pending',finish:d.finish});
      const out=await api('/api/task/continue',{project:d.project,task:d.task,confirm:true,generation:d.status.generation,revision:d.status.revision,requestId:d.requestId,...(useBody?{body:{token:d.body.token,confirm:true}}:{})});
      if(out.pending){historySaving=false;await showContinue(d.project,d.task,UI.text('Hubが自動で選別・保管し、新しい会話へ切り替えます。'),null,d.finish);refreshAuto(d.project,d.task);return;}
      if(out.body==='failed'&&!out.pending){continueRequest(d.project,d.task,null);historySaving=false;await showContinue(d.project,d.task,UI.text('本文整理ができなかったため、会話は切り替えていません：')+UI.message(out.error),null,d.finish);return;}
      if(out.rotate==='failed'){continueRequest(d.project,d.task,null);historySaving=false;await showContinue(d.project,d.task,(out.body==='ok'?UI.text('本文整理は済みました。会話の切り替えは未実行です：'):UI.text('会話の切り替えは未実行です：'))+UI.message(out.error),null,d.finish);return;}
      if(out.rotate!=='ok'||!out.ok){continueRequest(d.project,d.task,{requestId:d.requestId,status:'uncertain',finish:d.finish});historySaving=false;await showContinue(d.project,d.task,UI.message(out.error),null,d.finish);return;}
      continueRequest(d.project,d.task,null);
      globalThis.HubChatGenerations ||=new Map();globalThis.HubChatGenerations.set(d.project+'\0'+d.task,out.generation);renderedMainKey='';
      if(d.finish){await showCompletion(d.project,d.task,out.completionHash,{tidy:d.finish.tidy,prepared:true});return;}
      toast(out.body==='ok'?UI.text('本文を整理し、原文を保存して新しい会話へ切り替えました'):UI.text('原文を保存し、新しい会話へ切り替えました'));
    }else if(b.dataset.historyAction==='merge'){
      if(!d.mainView||d.loading||d.blocker||d.error||!d.main?.token||(d.main.waiting||[]).length)return;
      if(mainSent||mainDelivery(d.project,d.task))return;mainSent=true;
      const token=d.main.token,pending={state:'uncertain',requestId:token};d.sent=pending;mainDelivery(d.project,d.task,pending);
      d.main.token='';const r=await api('/api/task/merge',{project:d.project,task:d.task,token});if(sameMainDelivery(d.project,d.task,pending))mainDelivery(d.project,d.task,null);
      if(historyDialog!==d||d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
      toast(r.retained?UI.text('本体に取り込み、作業とコピーを残しました'):UI.text('本体に取り込み、片付けました'));
    }
    $('#task-history-sheet').hidden=true;await load();render();
  }catch(err){if(b.dataset.historyAction==='merge'){
    if(['not-sent','aborted'].includes(err.delivery?.state)&&sameMainDelivery(d.project,d.task,d.sent)){mainDelivery(d.project,d.task,null);mainSent=false;d.blocker=err.blocker;d.error=err.blocker?'':err.message;}else{d.error='';}
    if(historyDialog!==d||d.viewKey!==mainViewKey()){invalidateMainNavigation();return;}
    d.main=null;drawMainContinuation(d);
  }else if(b.dataset.historyAction==='continue'&&err.stage==='not-started'){
    continueRequest(d.project,d.task,null);historySaving=false;await showContinue(d.project,d.task,UI.message(err.message),typed(),d.finish);
  }else if(b.dataset.historyAction==='continue'&&continueRequest(d.project,d.task)){d.unresolved=true;continueRequest(d.project,d.task,{...continueRequest(d.project,d.task),status:'uncertain'});$('#history-status').textContent=UI.message(err.message)+' '+UI.text('会話整理の結果が未確認です。再送せず記録を確認してください');}else $('#history-status').textContent=UI.message(err.message);}
  finally{historySaving=false;if(b.dataset.historyAction==='merge'&&historyDialog===d&&!$('#task-history-sheet').hidden)drawMainContinuation(d);b.disabled=b.dataset.historyAction==='merge'||b.dataset.historyAction==='continue'&&Boolean(d.unresolved||d.resolved||continueRequest(d.project,d.task));}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!historySaving&&$('#task-history-sheet')){cancelMainPreview();$('#task-history-sheet').hidden=true;}});

const AUTO_STAGE={reserved:'予約中',collecting:'会話の準備中',selecting:'要約を作成中',writing:'保存・切替中',switching:'切替中'};
const autoActive=a=>a&&Object.hasOwn(AUTO_STAGE,a.stage);
let autoPoll=null,autoSeen='',autoLast=null;
const autoRefreshing=new Map(),autoRefreshAgain=new Set();
function autoElapsed(a){
  const at=Date.parse(a.stageStarted||a.timings?.[a.stage+'At']||a.started||'');if(!Number.isFinite(at))return '';
  const seconds=Math.max(0,Math.floor((Date.now()-at)/1000));return UI.template`経過 ${Math.floor(seconds/60)}分${seconds%60}秒`;
}
function autoStageText(a){
  if(a.waiting==='limit')return UI.text('担当の利用上限の解除を待っています');
  if(a.waiting==='start')return UI.text('文章担当の開始を待っています');
  if(a.stage==='selecting'&&a.model)return UI.template`文章担当（${esc(a.model)}）が会話を整理しています`;
  return UI.text(AUTO_STAGE[a.stage]);
}
function drawAuto(project,task,view){
  const box=$('#history-progress');if(!box||box.dataset.p!==project||box.dataset.t!==task)return;autoLast={project,task,view};
  const a=view?.auto,button=document.querySelector(`[data-task-history="continue"][data-p="${CSS.escape(project)}"][data-t="${CSS.escape(task)}"]`);
  const starting=continueStarting.has(continueKey(project,task)),busy=starting||autoActive(a);
  if(button){button.disabled=Boolean(busy);button.textContent=busy?UI.text('整理中…'):UI.text('要約して続ける');}
  const notice=continueNotices.get(continueKey(project,task));
  if(notice){box.textContent=notice;box.hidden=false;return;}
  if(starting&&!autoActive(a))box.innerHTML=UI.template`<span>会話を整理中：${UI.text(AUTO_STAGE.collecting)}${''}</span>`;
  else if(autoActive(a))box.innerHTML=UI.template`<span>会話を整理中：${autoStageText(a)+(autoElapsed(a)?'・'+autoElapsed(a):'')}${a.reason?'（'+esc(UI.message(a.reason))+'）':''}</span>${['reserved','selecting','writing'].includes(a.stage)?UI.html(' <button class="btn plain sm" type="button" data-history-action="auto-cancel">予約を取り消す</button>'):''}`;
  else if(a?.stage==='failed'&&a.generation===view.generation)box.innerHTML=UI.template`<span class="danger">整理できませんでした：${esc(UI.message(a.error||''))}</span>`;
  else if(a?.stage==='done'&&a.generation===view.generation-1&&Date.now()-Date.parse(a.updated||a.started||0)<600000)box.innerHTML=UI.html('<span>前の会話を整理し、新しい会話で続けられます。</span>');
  else if(view?.long)box.innerHTML=UI.html('<span>会話が長くなりました。［要約して続ける］で整理できます。</span>');
  else box.textContent='';
  box.hidden=!box.textContent.trim();
}
function refreshAuto(project,task){
  const key=continueKey(project,task);if(autoRefreshing.has(key)){autoRefreshAgain.add(key);return autoRefreshing.get(key);}
  const pending=(async()=>{do{autoRefreshAgain.delete(key);await refreshAutoView(project,task);}while(autoRefreshAgain.delete(key));})().finally(()=>autoRefreshing.delete(key));autoRefreshing.set(key,pending);return pending;
}
async function refreshAutoView(project,task){
  const key=continueKey(project,task);
  const before=autoLast?.project===project&&autoLast?.task===task?autoLast.view:null;
  if(autoActive(before?.auto))autoNeedsCompletion.add(key);
  clearTimeout(autoPoll);autoPoll=null;
  let view;try{view=await api('/api/task/history/auto?'+new URLSearchParams({project,task}),null,{'X-Hub':'1'});}catch(e){autoPoll=setTimeout(()=>refreshAuto(project,task),3000);return;}
  drawAuto(project,task,view);
  if(autoActive(view.auto))autoPoll=setTimeout(()=>refreshAuto(project,task),1500);
  const saved=continueRequest(project,task);
  if(!saved?.finish&&(saved||autoActive(view.auto))){
    if(continueChecking.has(key)){autoPoll=setTimeout(()=>refreshAuto(project,task),50);return;}continueChecking.add(key);
    try{await resolveContinuation(project,task,await api('/api/task/continue/status?'+new URLSearchParams({project,task,...(saved?.requestId?{requestId:saved.requestId}:{})}),null,historyHeaders));}catch(e){continueNotice(project,task,UI.message(e.message));autoPoll=setTimeout(()=>refreshAuto(project,task),3000);}finally{continueChecking.delete(key);}return;
  }
  if(autoActive(view.auto))return;
  if(['failed','cancelled'].includes(view.auto?.stage))autoNeedsCompletion.delete(key);
  if(view.auto?.stage==='done'&&autoNeedsCompletion.has(key)){const saved=continueRequest(project,task);if(saved?.finish&&historyDialog?.project===project&&historyDialog?.task===task){await showContinue(project,task,'',null,saved.finish);return;}try{await continued(project,task,{generation:view.generation},true);}catch(e){continueNotice(project,task,UI.message(e.message));autoPoll=setTimeout(()=>refreshAuto(project,task),3000);}}
}
// 作業画面を開いた時・切り替えた時に、整理中・長い会話の表示を合わせる。
setInterval(()=>{const box=$('#history-progress');if(!box||document.hidden)return;const key=box.dataset.p+'\0'+box.dataset.t;if(key!==autoSeen){autoSeen=key;refreshAuto(box.dataset.p,box.dataset.t);}else if(autoLast&&autoLast.project===box.dataset.p&&autoLast.task===box.dataset.t)drawAuto(autoLast.project,autoLast.task,autoLast.view);},1000);
function receiveAuto(project,task,view){
  // Start reconciliation before painting terminal state so the previous active state remains available.
  if(view.auto&&['done','failed','cancelled'].includes(view.auto.stage))void refreshAuto(project,task).catch(err=>continueNotice(project,task,UI.message(err.message)));
  drawAuto(project,task,view);
}
function resetAuto(project,task){
  if(continueRequest(project,task)||autoLast?.project===project&&autoLast?.task===task&&autoActive(autoLast.view.auto)){void refreshAuto(project,task).catch(err=>continueNotice(project,task,UI.message(err.message)));return true;}return false;
}
globalThis.HubTaskHistory={drawAuto,refreshAuto,receiveAuto,resetAuto,openArchiveAt};
