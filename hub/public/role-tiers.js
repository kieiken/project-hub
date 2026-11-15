'use strict';
// A draft is separate from the saved settings until the existing Save button is used.
let tierDraft = null, tierDraftRevision = null, tierResume = [];
const tiersDirty = () => tierDraft !== null && JSON.stringify(tierDraft) !== JSON.stringify(state.roleTiers?.data.roles || {});
function clearTierDraft() { tierDraft=null; tierDraftRevision=null; tierResume=[]; }
function editTiers() { if(tierDraft===null){tierDraft=structuredClone(state.roleTiers.data.roles);tierDraftRevision=state.roleTiers.revision;}return tierDraft; }
function tierSlotHtml(name,key,slot) {
  const c=state.roleTiers.catalogs, ai=slot?.ai||'codex', models=(c[ai]?.models||[]).filter(m=>! /^(gpt-[1-5][.-]|claude-(opus|sonnet|haiku)-[1-4][.-])/.test(m.id)), m=models.find(m=>m.id===slot?.model);
  const efforts=(m?.efforts?.length?m.efforts:state.efforts).filter(e=>e!=='Ultra');
  const attr=UI.template`data-tier-role="${esc(name)}" data-tier-key="${key}"`;
  return UI.template`<label class="tier-slot"><span>${key==='light'?UI.text('軽い'):UI.text('標準')}</span> <select ${attr} data-tier-field="ai">${Object.keys(c).filter(a=>a!=='agy'||[rolesDraft.find(r=>r.name===name)?.main,rolesDraft.find(r=>r.name===name)?.backup].some(s=>s?.ai==='agy')).map(a=>UI.template`<option value="${esc(a)}" ${a===ai?'selected':''}>${esc(AI_LABEL[a]||a)}</option>`).join('')}</select><select ${attr} data-tier-field="model"><option value="">使わない</option>${models.map(m=>UI.template`<option value="${esc(m.id)}" ${m.id===slot?.model?'selected':''}>${esc(m.label||m.id)}</option>`).join('')}</select><select ${attr} data-tier-field="effort">${efforts.map(e=>UI.template`<option ${e===(slot?.effort||'極高')?'selected':''}>${esc(e)}</option>`).join('')}</select></label>${slot?.model&&!m?UI.template`<p class="dirty">${esc(slot.model)}は今の一覧にありません。この段は使わず上の段へ回します。</p>`:''}${tierAccountWarnings(slot)}`;
}
function tierAccountWarnings(slot) {
  if(slot?.ai!=='codex')return '';
  return Object.entries(state.codexModelCatalogs||{}).filter(([,c])=>!c.models?.some(m=>m.id===slot.model)).map(([id])=>UI.template`<p class="small dirty">${esc(state.accounts?.find(a=>a.id===id&&a.ai==='codex')?.name||id)}では使えません。上の段、それも無ければ「上限の時」の担当へ回します。</p>`).join('');
}
function roleTiersHtml() {
  const v=state.roleTiers;if(!v)return '';
  if(v.error)return UI.template`<div class="pref-row pref-stack" id="role-tiers" data-tier-view="${esc(tierViewKey())}"><h3>仕事の難しさで分ける</h3><p class="dirty" role="status">${esc(v.error)}</p></div>`;
  const saved=tierDraft||v.data.roles;
  const rows=(rolesDraft||state.roles.roles).map(r=>{
    const row=saved[r.name],example=v.draft[r.name],display=row||example;
    const stops=v.data.stops.filter(s=>s.role===r.name&&!s.resumedAt);
    return UI.template`<details class="more"><summary>${esc(r.name)}：${row?row.routing==='on'?UI.text('振り分ける'):UI.text('停止中'):example?UI.text('下書き・未保存'):UI.text('固定')}</summary><p>難しい：${esc(AI_LABEL[r.main.ai]||r.main.ai)}・${esc(r.main.model)}・${esc(r.main.effort)}</p><label>動き <select data-tier-role="${esc(r.name)}" data-tier-routing><option value="fixed" ${!row?'selected':''}>固定</option><option value="on" ${row?.routing==='on'?'selected':''}>振り分ける</option><option value="stopped" ${row?.routing==='stopped'?'selected':''}>停止中</option></select></label>${stops.map(s=>UI.template`<p class="dirty">停止の理由：${esc(s.reason)}</p>`).join('')}${display?UI.template`<div class="pref-stack">${tierSlotHtml(r.name,'light',display.light)}${tierSlotHtml(r.name,'standard',display.standard)}</div>`:''}</details>`;
  }).join('');
  const p=v.data.proposal, review=v.data.review;
  return UI.template`<div class="pref-row pref-stack" id="role-tiers" data-tier-view="${esc(tierViewKey())}"><h3>仕事の難しさで分ける</h3><p class="pref-desc">下書きのままでは動きません。「振り分ける」を選び、下の保存ボタンで保存すると次の委任から使います。難しい段と上限時の担当は上の表で設定します。停止は全ての話題で続き、再開はここで確認します。</p>${rows}${v.changes.length?UI.template`<p class="dirty">モデル一覧に変化があります。［更新］で段を見直してください。</p><ul>${v.changes.map(c=>UI.template`<li>${esc(c.model)}：${esc(c.change)}</li>`).join('')}</ul><button type="button" class="btn plain sm" data-tier-action="catalog">このままにする</button>`:''}<div class="acts"><button type="button" class="btn plain" data-tier-action="review" ${['running','creating'].includes(review?.status)?'disabled':''}>更新</button><span class="small">司令塔のモデル・思考「高」で、自由対話の新しい話題に見直しを頼みます。</span></div>${review?UI.template`<p role="status">${esc(({creating:UI.text('準備中'),running:UI.text('見直し中'),proposed:UI.text('提案ができました'),failed:UI.text('見直しを完了できませんでした'),interrupted:UI.text('見直しを中断しました')})[review.status]||review.status)}${review.error?'：'+esc(review.error):''}</p>`:''}${p?UI.template`<div class="note"><h4>見直しの提案（まだ設定は変わっていません）</h4><p>${esc(p.decision.reason)}</p>${Object.entries(p.decision.tiers).map(([name,row])=>UI.template`<p><b>${esc(name)}</b><br>${Object.entries(row).map(([k,s])=>UI.template`${({light:UI.text('軽い'),standard:UI.text('標準'),hard:UI.text('難しい')})[k]}：${esc(k==='hard'?p.baseRoles.find(r=>r.name===name)?.main.model:p.baseTiers[name]?.[k]?.model||UI.text('未設定'))} → ${esc(s.model)}・${esc(s.effort)}`).join('<br>')}</p>`).join('')}<p>出どころ：${esc(p.decision.evidence.map(e=>e.sources.join(' / ')).join(' / '))}</p><p>未確認：${esc(p.decision.unverified.join(' / '))}</p><div class="acts"><button type="button" class="btn" data-tier-action="apply" data-proposal="${esc(p.id)}">反映する</button><button type="button" class="btn plain" data-tier-action="dismiss" data-proposal="${esc(p.id)}">見送る</button></div></div>`:''}</div>`;
}
document.addEventListener('change',e=>{
  const el=e.target;if(!el.matches('[data-tier-role]'))return;
  const name=el.dataset.tierRole,rows=editTiers(),before=rows[name];
  if(el.hasAttribute('data-tier-routing')){
    if(state.roleTiers.data.roles[name]?.routing==='stopped'&&el.value!=='stopped'&&!tierResume.includes(name)){
      if(!confirm(UI.template`${name}の停止を解除しますか？ 保存した時から反映します。`)){render();return;}tierResume.push(name);
    }
    if(el.value==='fixed')delete rows[name];else rows[name]={...(before||structuredClone(state.roleTiers.draft[name])||{}),routing:el.value};
  }else{
    const key=el.dataset.tierKey,field=el.dataset.tierField;
    rows[name] ||= {...structuredClone(state.roleTiers.draft[name]||{}),routing:'stopped'};
    const slot=rows[name][key] ||= structuredClone(state.roleTiers.draft[name]?.[key]||{ai:'codex',model:'',effort:'極高'});slot[field]=el.value;
    if(field==='ai'){slot.model=state.roleTiers.catalogs[slot.ai]?.models.find(m=>! /^(gpt-[1-5][.-]|claude-(opus|sonnet|haiku)-[1-4][.-])/.test(m.id))?.id||'';const es=state.roleTiers.catalogs[slot.ai]?.models.find(m=>m.id===slot.model)?.efforts||state.efforts;slot.effort=es.includes('極高')?'極高':es.filter(x=>x!=='Ultra').at(-1)||'高';}
    if(field==='model'&&el.value){const es=state.roleTiers.catalogs[slot.ai]?.models.find(m=>m.id===el.value)?.efforts||state.efforts;slot.effort=es.includes('極高')?'極高':es.filter(x=>x!=='Ultra').at(-1)||'高';}
    if(!slot.model)delete rows[name][key];
  }
  render();
});
document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-tier-action]');if(!el)return;const action=el.dataset.tierAction;
  if(rolesDirty()){toast(UI.text('保存していない設定があります。先に保存するか元に戻してください。'));return;}
  if(action==='apply'&&!confirm(UI.text('この提案を役割分担と段の設定に反映しますか？')))return;
  el.disabled=true;
  try{state.roleTiers=await api('/api/roles/tiers/'+(action==='review'?'review':action==='catalog'?'catalog':'proposal'),['review','catalog'].includes(action)?{}:{id:el.dataset.proposal,apply:action==='apply'},{'X-Hub-UI':'role-tiers'});if(action==='apply'){const s=await api('/api/state');state.roles=s.roles;clearRolesDraft();}render();}catch(error){toast(error.message);el.disabled=false;}
});

function tierViewKey(){return JSON.stringify([state.roleTiers?.revision,state.roleTiers?.changes,state.roleTiers?.error]);}
function syncRoleTiers(){const box=document.querySelector('#role-tiers');if(!box||tierDraft!==null||box.contains(document.activeElement)||box.dataset.tierView===tierViewKey())return;const opened=[...box.querySelectorAll('details')].map(d=>d.open);box.outerHTML=roleTiersHtml();document.querySelectorAll('#role-tiers details').forEach((d,i)=>{d.open=opened[i]||false;});}
