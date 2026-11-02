'use strict';
// One target rule for the browser and the formal API. No authorization here.
(function(root){
 const key=i=>i?.project+'\0'+i?.task;
 function select(items,mode,requested,text=x=>x,template=(s,...v)=>s.reduce((out,x,i)=>out+x+(v[i]??''),'')){
  const eligible=i=>i.startable&&!i.noop;
  let chosen;
  if(mode==='batch')chosen=items.filter(eligible);
  else {
   if(!Array.isArray(requested)||!requested.length||requested.some(i=>!i||typeof i.project!=='string'||typeof i.task!=='string')||new Set(requested.map(key)).size!==requested.length)return {items:[],reason:text('統合する子作業を選んでください')};
   chosen=requested.map(s=>items.find(i=>key(i)===key(s)));
   if(chosen.some(i=>!i||!eligible(i)))return {items:[],reason:text('統合対象が不正です')};
   if(mode==='single'){
    if(chosen.length!==1)return {items:[],reason:text('個別統合の対象が不正です')};
    const parent=chosen[0];
    if(!parent.keep)chosen=[parent,...items.filter(i=>(parent.descendants||[]).some(c=>key(c)===key(i)))];
   }else if(mode!=='selected')return {items:[],reason:text('統合対象が不正です')};
  }
  if(!chosen.length)return {items:[],reason:text('新しい成果はありません')};
  if(chosen.some(i=>!eligible(i)))return {items:chosen,reason:text('子孫の統合内容を確認してください')};
  // These are received history, exposed only to authorize an ancestor cleanup.
  // They cannot become independent integration roots or silently join a plan
  // which keeps the ancestor. Their own keep value remains an explicit choice.
  if(chosen.some(i=>i.cleanupOnly&&!chosen.some(p=>!p.cleanupOnly&&!p.keep&&(p.descendants||[]).some(c=>key(c)===key(i)))))return {items:chosen,reason:text('完了・受領済みの子は、上の作業の片付けと一緒に選んでください')};
  for(const i of chosen.filter(i=>!i.keep))for(const c of i.descendants||[]){
   const child=chosen.find(j=>key(j)===key(c));
   if(!child)return {items:chosen,reason:template`「${i.title}」を残さないには、下の「${c.title}」も選ぶか、「${i.title}」を［残す］にしてください`};
   if(child.keep)return {items:chosen,reason:template`「${i.title}」の下に残す子があります：${c.title}`};
  }
  const waiting=chosen.flatMap(i=>i.waiting||[]);if(waiting.length)return {items:chosen,reason:text('稼働中の処理の終了待ち')+'：'+[...new Set(waiting.map(w=>w.message))].join(' / ')};
  return {items:chosen.slice().sort((a,b)=>b.depth-a.depth),reason:''};
 }
 const api={key,select};if(typeof module==='object'&&module.exports)module.exports=api;else root.HubIntegrationSelection=api;
})(globalThis);
