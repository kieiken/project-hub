'use strict';

module.exports = function createParallelEngine(ctx) {
  const { getAiTools, getAppUpdate, baseOf, getChats, getConversationHistory, executionGate, expandHome, extensions, getFreetalkHistory, fs, getGithub, getGithubProject, getGpt, historyBusy, getIdeaRunner, license, lt, getMaintenance, path, getProcwatch, getRemoval, getRemovalReview, getReqCtx, getRestartControl, getSessions, stopControl, store, getTaskIntegrate, getWebchat, webchatActive } = ctx;

  function licenseGuard(options, stage = 'start') {
    if(options.project&&options.task){const ctx=(getReqCtx()).getStore(),snapshot=ctx?.stopSnapshot,manual=ctx?.manualResume;
      if(stage==='accept'&&options.origin==='delegate'&&stopControl.held(options)){
        const ticket=stopControl.delegateTicket(options,(getChats()).busy(options.project,options.task),ctx?.delegateTurn);
        ctx.delegateResume={project:options.project,task:options.task,ticket};
      }
      else if(manual&&options.project===manual.project&&options.task===manual.task)stopControl.checkManual(options,manual.ticket);
      else stopControl.assert(options,options.stopTicket || (snapshot?{epoch:snapshot.epoch,task:snapshot.tasks[JSON.stringify([options.project,options.task])]?.epoch||0}:undefined));}
    const active = [...(getSessions()).list(), ...[...(getChats()).running].map(([key, run]) => {
      const [project, task] = key.split('\0'); return { project, task, ai: run.ai, running: true };
    }), ...((getWebchat())?.busy() || []).map(j => ({ project: j.project, task: j.task, ai: 'chatgpt', running: true })),
      ...(getProcwatch()).list().filter(p => !(getChats()).supervisedPid(p.pid)).map(p => ({ ...p, running: true }))];
    if(options.origin==='hub-internal'&&!options.automation)options={...options,mode:undefined,licenseFeatures:(options.licenseFeatures||[]).filter(f=>f!=='queue_auto')};
    if(options.origin==='delegate'&&!options.automation&&!extensions.state().included.includes('delegate'))throw Object.assign(Error(lt('この版には含まれていません')),{code:'feature_not_included',status:404});
    if(options.automation&&!extensions.state().included.includes('idea_automation'))throw Object.assign(Error(lt('この版には含まれていません')),{code:'feature_not_included',status:404});
    return license.guard(options, { active, stage });
  }

  function assertConversationIdle(p, t, owner, handoffErrors) {
    const fail = code => { const e = Error(code); e.status = 409; throw e; };
    if ((getRestartControl())?.committed || (getAppUpdate()).applying()) fail('webchat_restarting');
    (getChats()).assertHandoffReady(p.id, t.id, handoffErrors);
    if (historyBusy(p.id, t.id) || (getRemoval()).locked(p.id) || (getRemovalReview()).active(p.id) ||
        (getChats()).busy(p.id, t.id) || !owner && (getChats()).queue(p.id, t.id).some(q=>!q.stopHeld) ||
        (getSessions()).list().some(s => s.running && s.project === p.id && s.task === t.id) ||
        (getProcwatch()).list().some(s => s.project === p.id && (!s.task || s.task === t.id) &&
          !(getChats()).supervisedPid(s.pid) && !(getProcwatch()).hasAncestor(s.pid,pid=>(getChats()).supervisedPid(pid,{activeOnly:true})))) fail('webchat_task_busy');
    if (p.kind === 'freetalk') {
      const state = (getFreetalkHistory()).state(t.id);
      if (state.migrated || state.summary?.intent === 'promote' && state.summary.automatic && !state.summary.automatic.error) fail('webchat_topic_readonly');
    }
  }

  function assertWorkspaceIdle(p, t, permitChat, githubOperation = false, gptOwner, gptOperation = false) {
    executionGate.assert({dir:expandHome(t.workdir)||baseOf(p),owner:permitChat?'chat:'+p.id+':'+t.id:undefined});
    if ((getRestartControl())?.committed) { const e=Error(lt('再起動を開始しています'));e.status=409;throw e; }
    const own = gptOwner && ((getGpt()).gptChildren.owners.get(p.id + '/' + t.id) === gptOwner || (getWebchat())?.current?.lease === gptOwner && (getWebchat()).current.project === p.id && (getWebchat()).current.task === t.id);
    if ((!own && webchatActive(p.id, t.id)) || gptOperation && (getConversationHistory())?.organizing(p.id, t.id)) { const e = Error(lt('AI・整理・確認が動いています')); e.status = 409; throw e; }
    if ((getAppUpdate()).applying()) { const error = Error((getAppUpdate()).busyMessage()); error.status = 409; throw error; }
    if ((getMaintenance()).locked(p.id)) {const e=Error(lt('同じ本体で検証中です。終わってからAIを始めてください'));e.status=409;throw e;}
    const canonical = dir => { try { return fs.realpathSync(dir); } catch(e) { return path.resolve(dir); } };
    const base = canonical(baseOf(p));
    const chosenDir = (p,t) => {
      const wd=expandHome(t.workdir);if(wd&&fs.existsSync(wd))return wd;
      const r=(getTaskIntegrate()).read(p.id,t.id);return r&&!r.complete?r.target:wd;
    };
    const onBase = (p,t) => {
      if(t.workspaceMode==='direct')return true;
      const r=t.id&&(getTaskIntegrate()).read(p.id,t.id),dir=chosenDir(p,t);
      return Boolean(r&&!r.complete&&dir&&canonical(dir)===canonical(baseOf(p)));
    };
    const targetDirect = onBase(p,t);
    if (!githubOperation) (getGithub()).assertStart((getGithubProject())(p), { ...t, workdir: chosenDir(p,t) });
    const active = [...(getSessions()).list().filter(s=>s.running), ...[...(getChats()).running.keys()].map(k=>{const [project,task]=k.split('\u0000');return {project,task,chat:true};})];
    if (!active.length) return;
    const all = store.listProjects();
    for (const a of active) {
      if (p.kind==='freetalk' && t.id && a.project===p.id && a.task!==t.id) continue;
      if (permitChat && a.chat && a.project===p.id && a.task===t.id) continue;
      const q=all.find(x=>x.id===a.project), at=q?.tasks.find(x=>x.id===a.task); if(!q || !at)continue;
      if(gptOperation && (a.project===p.id && a.task===t.id || chosenDir(q,at) && chosenDir(p,t) && canonical(chosenDir(q,at))===canonical(chosenDir(p,t))) || canonical(baseOf(q))===base && (targetDirect || onBase(q,at))) {
        const e=Error(lt('同じ本体でAIが作業中です。本体での同時作業はできません'));e.status=409;throw e;
      }
    }
  }

  function installTerminal() {
  (getSessions()).startGate=o=>executionGate.acquire({dir:o.dir,owner:'terminal:'+o.project+':'+o.task+':'+o.ai});
  (getSessions()).endGate=o=>{executionGate.release('terminal:'+o.project+':'+o.task+':'+o.ai);(getIdeaRunner())?.wake(o.project);};
  (getSessions()).canStart = (ai,o) => {try{executionGate.assert({dir:o.dir,owner:'terminal:'+o.project+':'+o.task+':'+ai});}catch(e){return e.message;}return  (getRestartControl())?.committed ? lt('再起動を開始しています') : (getAiTools()).isOperating(ai) ? lt('AI の更新・モデル再取得が進行中です') : '';};
  }

  return { licenseGuard, assertConversationIdle, assertWorkspaceIdle, installTerminal };
};
