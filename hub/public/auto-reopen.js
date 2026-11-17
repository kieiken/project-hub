'use strict';
// Only the release Mac index includes this file. Every open page participates;
// a stale/disconnected page is never assumed to have no unsent input.
(() => {
  const client=crypto.randomUUID();let pending=false, frozen=null, leaving=false;
  function thaw(){if(!frozen)return;for(const [el,inert] of frozen.nodes)el.inert=inert;frozen.panel.remove();frozen=null;}
  function blocked(){return typeof appUpdateMayRestart!=='function'||!appUpdateMayRestart()||typeof localRecoveryBlocker!=='function'||Boolean(localRecoveryBlocker());}
  function freeze(ticket){
    if(frozen?.ticket===ticket)return;
    thaw();const panel=document.createElement('div');panel.setAttribute('role','status');
    Object.assign(panel.style,{position:'fixed',inset:'0',zIndex:'2147483647',background:'Canvas',color:'CanvasText',display:'grid',placeContent:'center',gap:'20px',padding:'32px'});
    const label=document.createElement('p');label.textContent='作業が終わったら自動で開き直します。';panel.append(label);
    const cancel=document.createElement('button');cancel.textContent='自動で開き直すのを取り消す';cancel.type='button';
    cancel.onclick=async()=>{try{const d=await api('/api/app-update/reopen',{action:'reopen-cancel'});if(d.autoReopen?.phase==='committed'){label.textContent='終了を始めたため、取り消せません。開き直しを待っています。';cancel.disabled=true;}else thaw();}catch{label.textContent='取り消しの結果を確認できません。画面の接続が戻るまで待っています。';}};panel.append(cancel);
    const nodes=[...document.body.children].map(el=>[el,el.inert]);for(const [el] of nodes)el.inert=true;
    document.activeElement?.blur();document.body.append(panel);frozen={ticket,nodes,panel};
  }
  async function poll(){
    if(pending||leaving)return;pending=true;
    try {
      const d=await api('/api/app-update'), a=d.autoReopen;
      if(!a)return;
      if(!['waiting','starting','committed'].includes(a.phase))thaw();
      if(a.phase==='committed')return;
      // The native helper must see a fresh acknowledgement from every page.
      // Freeze synchronously, before the request yields to another input event.
      if(a.phase==='waiting'&&d.restartNeeded&&!blocked())freeze(a.ticket);
      const ready=Boolean(frozen&&frozen.ticket===a.ticket&&!blocked());
      await api('/api/app-update/reopen',{action:'reopen-pulse',client,ticket:a.ticket,ready});
      if(a.phase==='waiting')await api('/api/app-update/reopen',{action:'reopen-advance'});
      if(typeof appUpdateData!=='undefined')appUpdateData=d;
    }catch{/* Connection uncertainty keeps the input shield in place. No quit/retry here. */}
    finally{pending=false;}
  }
  // Leaving is explicit. If this request is lost, the server safely falls back
  // to manual reopen instead of dropping a possibly dirty window.
  window.addEventListener('pagehide',()=>{leaving=true;void api('/api/app-update/reopen',{action:'reopen-leave',client}).catch(()=>{});});
  setInterval(()=>void poll(),2000);void poll();
})();
