'use strict';

module.exports = function taskintegrationRoutes(ctx) {
  const { send, lt, store, inWork, copyMissing, expandHome, gitw, mainMergeDelivery, getMainMergeFlow, workRoot, mainMergeTokens, crypto, integrationBlockers, integrationBlockersAsync, HUB_INSTANCE, lastMerge, record, taskIntegrate, launch, sessions, taskTransfer, setUnread, integrationFailure, integrationAbandon, integrateAuto, pruneUnread, resultsGate, executionRoles, delegateRequest } = ctx;
  return {
    consultationClose: {
      matches: (req,url) => req.method==='POST'&&/^\/api\/task\/integrate\/consultation-close\/(preview|apply|status|finish)$/.test(url.pathname),
      handle(req,res,url,b) {
        try {
          const close=require('../integration-consultation-close'),op=url.pathname.split('/').pop();
          return send(res,200,op==='preview'?close.preview(taskIntegrate,b):op==='apply'?close.apply(taskIntegrate,b):op==='finish'?close.finish(taskIntegrate,b):close.status(taskIntegrate,b));
        }catch(e){return send(res,409,{error:e.message});}
      },
    },
    wait: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/task/integrate/wait',
      async handle(req, res, url, b) {
        return send(res,200,{waiting:await integrateAuto.waitingAsync(Object.fromEntries(url.searchParams))});
      },
    },
    mergeStatus: {
      matches: (req, url) => url.pathname === '/api/task/merge/status',
      async handle(req, res, url, b) {
        try {
          const p=store.readProject(b.project),t=p?.tasks.find(t=>t.id===b.task);
          if(!t||!inWork(p,t)||copyMissing(p,t))return send(res,200,{state:'unknown'});
          const sourceDir=expandHome(t.workdir),targetDir=await gitw.mainOfAsync(sourceDir),scope={project:b.project,task:b.task,sourceDir,targetDir};
          if(b.flow===true)return send(res,200,await getMainMergeFlow().statusAsync(scope,b.requestId));
          return send(res,200,b.requestId!==undefined?await mainMergeDelivery.statusAsync({...scope,id:b.requestId,mainMergeTokens}):b.legacy===true?await mainMergeDelivery.legacyAsync({...scope,abortAt:b.abortAt,confirm:b.confirm,sourceHead:b.sourceHead,targetHead:b.targetHead}):{state:'unknown'});
        }catch{return send(res,200,{state:'unknown'});}
      },
    },
    mergePreview: {
      matches: (req, url) => url.pathname === '/api/task/merge/preview',
      async handle(req, res, url, b) {
        const check=require('../main-merge-check');
        try {
          const p=store.readProject(b.project),file=p&&store.taskFile(b.project,b.task);
          if(!p||!file)return send(res,409,{error:lt('作業が見つかりません'),delivery:{state:'not-sent'}});
          const t=store.readTask(file);
          if(!inWork(p,t)||copyMissing(p,t))return send(res,409,{error:lt('作業用コピーが見つかりません'),delivery:{state:'not-sent'}});
          const sourceDir=expandHome(t.workdir),mergeTarget=await gitw.mainOfAsync(sourceDir);
          if(await mainMergeDelivery.unresolvedAsync({project:b.project,task:b.task,sourceDir,targetDir:mergeTarget}))return send(res,409,{error:lt('取り込みの結果が未確認です。再送せず、送信番号の結果を照合してください'),delivery:{state:'unknown'}});
          const sc=await check.checkAsync(gitw,sourceDir,'source'),tc=await check.checkAsync(gitw,mergeTarget,'target');
          if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
          const source=sc.snapshot,main=tc.snapshot;
          const preview=await gitw.previewAsync({root:store.root,dir:sourceDir,workRoot:workRoot(p),target:mergeTarget});
          if(!preview)return send(res,409,check.refusal({side:'target',kind:'unreadable',paths:[],reason:lt('取り込む範囲を読み取れません'),next:lt('本体と作業用コピーのGit履歴を確認してから、最新の記録を確認してください')}));
          const token=crypto.randomUUID();
          for(const [id,v]of mainMergeTokens)if(Date.now()-v.at>600000)mainMergeTokens.delete(id);
          const switchPlan=await getMainMergeFlow().approvalAsync({sourceDir,targetDir:mergeTarget,source,target:main});
          const waiting=await integrationBlockersAsync(b,{op:'main-merge'});
          mainMergeTokens.set(token,{at:Date.now(),project:b.project,task:b.task,source,target:main,targetDir:mergeTarget,...switchPlan});
          return send(res,200,{waiting,token,sourceHead:source.head,targetHead:main.head,target:mergeTarget,files:preview.files,noChanges:preview.noChanges,...switchPlan,residual:t.steps.filter(s=>!s.done).map(s=>s.text).concat(t.question||[]).join('\n'),cleanupBlocked:Boolean(t.continuation||t.question||t.steps.some(s=>!s.done)||store.listProjects().some(q=>q.tasks.some(x=>require('../../public/project-order').ancestorsOf(q,x,store.listProjects()).some(a=>a.project.id===p.id&&a.task.id===t.id))))});
        } catch {return send(res,409,check.refusal({side:'target',kind:'unreadable',paths:[],reason:lt('本体と作業用コピーの保存状態を読み取れません'),next:lt('Gitと読取権限を確認してから、最新の記録を確認してください')}));}
      },
    },
    merge: {
      matches: (req, url) => url.pathname === '/api/task/merge',
      handle(req, res, url, b) {
        let deliveryScope;
        if(b.oneclick===true&&b.token===undefined)return send(res,409,{error:lt('表示した取り込み範囲を確認できません'),delivery:{state:'not-sent'}});
        if(b.token!==undefined){
          try{if(mainMergeDelivery.read(b.token))return send(res,409,{error:lt('この取り込みは送信済みです。結果を照合してください'),delivery:{state:'unknown'}});}catch{return send(res,409,{error:lt('取り込みの送信記録を読み取れません'),delivery:{state:'unknown'}});}
          const v=mainMergeTokens.get(b.token);mainMergeTokens.delete(b.token);
          const p=store.readProject(b.project),t=p?.tasks.find(t=>t.id===b.task);
          const changed=()=>send(res,409,{error:lt('本体または保存済みHEADが変わりました。最新の記録を確認してください'),delivery:{state:'not-sent'}});
          if(!v||Date.now()-v.at>600000||v.project!==b.project||v.task!==b.task||!t||gitw.mainOf(expandHome(t.workdir))!==v.targetDir)return changed();
          const check=require('../main-merge-check'),sc=check.check(gitw,expandHome(t.workdir),'source'),tc=check.check(gitw,v.targetDir,'target');
          if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
          if(JSON.stringify(sc.snapshot)!==JSON.stringify(v.source)||JSON.stringify(tc.snapshot)!==JSON.stringify(v.target))return changed();
          b.disposition='continue';b.confirm=true;b.sourceHead=v.source.head;b.targetHead=v.target.head;
          deliveryScope={project:b.project,task:b.task,sourceDir:expandHome(t.workdir),targetDir:v.targetDir,source:v.source,target:v.target};
          if(b.oneclick===true){
            const prior=mainMergeDelivery.flows(deliveryScope).find(r=>JSON.stringify(r.source)===JSON.stringify(v.source)&&JSON.stringify(r.target)===JSON.stringify(v.target));
            if(prior){
              try{mainMergeDelivery.link(b.token,deliveryScope,prior.id);}catch{return send(res,409,{error:lt('取り込みの送信番号を保存できません。結果を照合してください'),delivery:{state:'unknown'}});}
              return send(res,200,{ok:true,main:v.targetDir,retained:true,requestId:b.token,flow:getMainMergeFlow().status(deliveryScope,b.token)});
            }
            deliveryScope.flow={keep:true,restart:v.switchHub,version:v.switchVersion,instance:HUB_INSTANCE,stage:'approved'};
          }
        }
        const p = store.readProject(b.project);
        const file = store.taskFile(b.project, b.task);
        if (!p || !file) return send(res, 400, { error: lt('作業が見つかりません') });
        const t = store.readTask(file);
        if(require('../../public/project-order').integrators(p,t,store.listProjects()).length) return send(res,409,{error:lt('親作業の［統合…］で取り込みます。子作業では［成果を渡す］を行ってください')});
        if (!inWork(p, t)) return send(res, 400, { error: lt('この作業には作業用コピーがありません') });
        if (copyMissing(p, t)) {
          if(res.integrationMain)return send(res,409,{error:lt('本体取り込みの対象が変わりました')});
          const m = lastMerge(p.id, t.id);
          const when = m ? new Date(m.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          const note = m ? lt`この作業は ${when} に本体へ取り込み済みです（作業用コピーはゴミ箱へ移してあります）。` : lt('作業用コピーの場所が見つかりません（消えたか、別の場所に移っています）。');
          store.updateTask(p.id, t.id, { workdir: '', memo: lt`${note} 作業ファイルの古い記録を片付けました` });
          record('mergeskip', b, { merged: Boolean(m) });
          return send(res, 409, { error: lt`${note} 変更は本体に入っています。作業ファイルの古い記録を片付けたので、続きは本体でそのまま始められます` });
        }
        if (t.mergeExcluded) return send(res, 409, { error: lt('取り込み対象から外されています。先に［取り込み対象に戻す］を選んでください') });
        const waiting=integrationBlockers(b,{op:'main-merge'});
        if(waiting.length)return send(res,409,{error:waiting.map(x=>x.message).join('、'),waiting,delivery:{state:'not-sent'}});
        const mergeTarget = gitw.mainOf(expandHome(t.workdir));
        if(mainMergeDelivery.unresolved({project:b.project,task:b.task,sourceDir:expandHome(t.workdir),targetDir:mergeTarget}))return send(res,409,{error:lt('取り込みの結果が未確認です。再送せず、送信番号の結果を照合してください'),delivery:{state:'unknown'}});
        let r;
        try {
          const disposition=b.disposition===undefined?'cleanup':b.disposition;
          if(!['continue','cleanup'].includes(disposition))throw Error(lt('取り込み後の扱いを確認してください'));
          if(disposition==='cleanup'&&(t.continuation||t.question||t.steps.some(s=>!s.done)||store.listProjects().some(q=>q.tasks.some(x=>require('../../public/project-order').ancestorsOf(q,x,store.listProjects()).some(a=>a.project.id===p.id&&a.task.id===t.id)))))throw Error(lt('残件または継続中の作業です。取り込んで続けてください'));
          if(b.disposition!==undefined){
            const check=require('../main-merge-check'),sc=check.check(gitw,expandHome(t.workdir),'source'),tc=check.check(gitw,mergeTarget,'target');
            if(sc.blocker||tc.blocker)return send(res,409,check.refusal(sc.blocker||tc.blocker));
          }
          if(b.disposition!==undefined&&(b.confirm!==true||b.targetHead!==(gitw.inspect(mergeTarget)?.head||null)))throw Error(lt('本体が変わりました。取り込む範囲を確認し直してください'));
          if(b.disposition!==undefined){const source=gitw.inspect(expandHome(t.workdir));if(!source||source.status||gitw.merging(expandHome(t.workdir))||b.sourceHead!==source.head||b.confirm!==true)throw Error(lt('保存済みHEADと取り込む範囲を確認してください'));}
          const preview=gitw.preview({targetGuard:dir=>require('../integration-writes').inspect(gitw,dir),dir:expandHome(t.workdir),workRoot:workRoot(p),target:mergeTarget});
          const lock=preview?.noChanges?[]:gitw.mergeLocks(mergeTarget);if(lock.length)return send(res,409,{error:'Gitの保存処理が進行中です：'+lock.join('、'),delivery:{state:'not-sent'},paths:lock});
          if(deliveryScope)try{mainMergeDelivery.start(b.token,deliveryScope);}catch{return send(res,409,{error:lt('取り込みの送信記録を保存できません'),delivery:{state:'not-sent'}});}
          if(!preview?.noChanges)res.integrationMain?.begin();
          r = preview?.noChanges?{ok:true,noChanges:true,main:mergeTarget,commit:gitw.savedHead(mergeTarget),files:[]}:gitw.merge({ targetGuard:dir=>require('../integration-safety').assertTarget(taskIntegrate,{target:dir,p}),dir: expandHome(t.workdir), workRoot: workRoot(p), title: `${t.id} ${t.title}`, cleanup:disposition==='cleanup' });
        }
        catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
        if(deliveryScope)try{mainMergeDelivery.finish(b.token,{state:r.ok?'applied':['aborted','not-sent'].includes(r.delivery?.state)?r.delivery.state:'unknown',...(r.ok?{commit:r.commit}:{})});}catch{r.delivery={state:'unknown'};}
        // A no-op receipt preserves the task and operation log exactly.
        if(r.ok&&r.noChanges)return send(res,200,{ok:true,noChanges:true,main:r.main,retained:true,task:t,...(deliveryScope?.flow?{requestId:b.token,flow:getMainMergeFlow().status(deliveryScope,b.token)}:{})});
        record('merge', b, { ok: Boolean(r.ok), conflict: Boolean(r.conflict), ...(b.token?{requestId:b.token,sourceHead:b.sourceHead,targetHead:b.targetHead}:{}), ...(r.delivery?{delivery:r.delivery}:{}), ...(r.ok ? {main:r.main,commit:r.commit,files:r.files} : {}) });
        if (r.conflict) {
          store.updateTask(p.id, t.id, { state: '返事待ち', question: lt('本体に取り込む時にぶつかりました。AI を始めて「本体の最新を取り込み、ぶつかった所を直して」と頼んでから、もう一度［本体に取り込む］を押してください') });
          return send(res, 409, { error: r.error, conflict: true,...(r.delivery?{delivery:r.delivery}:{}) });
        }
        if (!r.ok) return send(res, r.delivery ? 409 : 400, { error: r.error,...(r.delivery?{delivery:r.delivery}:{}) });
        if(b.disposition==='continue'||r.noChanges){
          const kept=store.updateTask(p.id,t.id,{continuation:true,memo:lt`本体に取り込み、同じ作業とコピーを保持しました（${r.main}）`});
          return send(res,200,{ok:true,main:r.main,retained:true,task:kept,...(r.noChanges?{noChanges:true}:{}),...(deliveryScope?.flow?{requestId:b.token,flow:getMainMergeFlow().status(deliveryScope,b.token)}:{})});
        }
        for (const a of launch.AIS) sessions.stop(b.project, b.task, a);
        const done = store.updateTask(p.id, t.id, { workdir: '', state: '完了', question: '', memo: lt`本体に取り込み、作業用コピーをゴミ箱へ移しました（${r.main}）` });
        try { store.appendSection(p.id, t.id, 'やったこと', lt`- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 本体に取り込み済み（${r.main}）。作業用コピーはゴミ箱へ。workdir は空のままにすること`); } catch (e) { /* 無くてもよい */ }
        return send(res, 200, { ok: true, main: r.main, trashed: r.trashed, task: done });
      },
    },
    handupPreview: {
      matches: (req, url) => url.pathname === '/api/task/handup/preview',
      handle(req, res, url, b) {
        try { return send(res, 200, taskTransfer.offerPreview(b.project, b.task, b.paths || [], b.expectTitle)); }
        catch (e) { return send(res, 409, {error:e.message}); }
      },
    },
    handup: {
      matches: (req, url, b) => url.pathname === '/api/task/handup' || url.pathname === '/api/task/absorb' && taskTransfer.read(b.project,b.task)?.destination && !taskTransfer.read(b.project,b.task)?.integrating,
      handle(req, res, url, b) {
        try {
          const r = url.pathname === '/api/task/handup' ? taskTransfer.offer(b) : taskTransfer.apply(b); if(!r.handedUp)setUnread(b.project,b.task,false);
          record('absorb', {project:r.parentProject,task:r.parent}, {child:b.task,childProject:b.project,files:r.files,receipt:r.record});
          return send(res,200,r);
        } catch(e) { return send(res,409,{error:e.message}); }
      },
    },
    records: {
      matches: (req, url) => url.pathname === '/api/task/integrate/records/save',
      handle(req, res, url, b) {
        try {const waiting=integrationBlockers(b,{op:'receipt'});if(waiting.length)throw Object.assign(Error(lt('保存先の処理が終了してからHub記録を保存してください')),{delivery:{state:'not-sent'}});const r=require('../integration-record-save').save(taskIntegrate,b);record('integration-record-save',{project:b.project,task:b.task},{commit:r.commit,paths:r.paths});return send(res,200,r);} catch(e){integrationFailure(b,e,'records-save');return send(res,409,{error:e.message,delivery:e.delivery});}
      },
    },
    abandon: {
      matches: (req, url) => url.pathname === '/api/task/integrate/abandon',
      handle(req, res, url, b) {
        try{const out=b.preview===true?integrationAbandon.preview(b):integrationAbandon.apply(b);if(out.abandoned||out.recovered)record(out.recovered?'integrate-abandon-'+out.recovered:'integrate-abandon',b,{id:out.id,received:0,cleaned:0});return send(res,200,out);}catch(e){return send(res,e.delivery?500:409,{error:e.message,waiting:e.waiting,delivery:e.delivery||{state:'not-sent'}});}
      },
    },
    futureHold: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/task/future-hold',
      handle(req, res, url, b) {
        try {
          const waiting=integrationBlockers(b,{op:'receipt'});if(waiting.length)throw Error(waiting.map(x=>x.message).join('、'));
          const out=require('../task-future-hold').save(taskIntegrate,b);
          record('task-future-hold',b,{held:out.held,revision:out.revision});return send(res,200,out);
        }catch(e){return send(res,409,{error:e.message});}
      },
    },
    keep: {
      matches: (req, url) => url.pathname === '/api/task/integrate/keep',
      handle(req, res, url, b) {
        try{return send(res,200,taskIntegrate.simple.saveKeep(b));}catch(e){integrationFailure(b,e,'keep');return send(res,409,{error:e.message});}
      },
    },
    preview: {
      matches: (req, url) => url.pathname === '/api/task/integrate/preview',
      async handle(req, res, url, b) {
        try{return send(res,200,await integrateAuto.previewAsync(b));}catch(e){integrationFailure(b,e,'preview');return send(res,409,{error:e.message});}
      },
    },
    resume: {
      matches: (req, url) => url.pathname === '/api/task/integrate/resume',
      handle(req, res, url, b) {
        try{const r=integrateAuto.resume(b);setImmediate(()=>{void integrateAuto.tick();});record('integrate-resume',b,{id:r.id,thenMain:false});return send(res,200,r);}catch(e){integrationFailure(b,e,url.pathname.endsWith('/resume')?'resume':'start');return send(res,409,{error:e.message,code:e.code,stage:e.stage||'refresh',waiting:e.waiting});}
      },
    },
    apply: {
      matches: (req, url) => ['/api/task/integrate','/api/task/absorb'].includes(url.pathname),
      handle(req, res, url, b) {
        try { const r=integrateAuto.apply(b);if(b.auto) setImmediate(()=>{void integrateAuto.tick();}); record('integrate',b,{ok:r.ok,complete:r.complete,conflict:r.conflict});pruneUnread();return send(res,r.partial?200:r.conflict?409:200,r); }
        catch(e){integrationFailure(b,e,url.pathname.endsWith('/resume')?'resume':'start');return send(res,409,{error:e.message,code:e.code,stage:e.stage||'refresh',waiting:e.waiting});}
      },
    },
    organize: {
      matches: (req, url) => url.pathname === '/api/task/results/organize',
      async handle(req, res, url, b) {
        try { await resultsGate.trigger(b.project,b.task,{manual:true,expectedHash:b.expectedHash}); return send(res,200,{ok:true}); }
        catch(e) {return send(res,409,{error:e.message});}
      },
    },
    results: {
      matches: (req, url) => url.pathname === '/api/task/integrate/results',
      async handle(req, res, url, b) {
        try {
          const request=taskIntegrate.resultsRequest(b),role=executionRoles().roles.find(r=>r.name==='調査');
          if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定の調査担当を確かめてください'));
          // この画面の明示操作だけ、完了した子へ成果整理を依頼できる。起動失敗時は完了状態を保持。
          return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{allowCompleted:true,resultsOrganize:true,resultsRecovery:b,beforeStart:()=>taskIntegrate.resultsRequest(b)});
        }catch(e){integrationFailure(b,e,'results');return send(res,409,{error:e.message});}
      },
    },
    resolve: {
      matches: (req, url) => url.pathname === '/api/task/integrate/resolve',
      async handle(req, res, url, b) {
        try {
          const request=taskIntegrate.conflictRequest(b);
          const role=executionRoles().roles.find(r=>r.name==='コーディング');
          if(!role?.main.model || !['codex','claude-code','agy','grok'].includes(role.main.ai))throw Error(lt('設定のコーディング担当を確かめてください'));
          return await delegateRequest({...request,role:role.name,ai:role.main.ai==='claude-code'?'claude':role.main.ai,model:role.main.model,effort:role.main.effort},res,{beforeStart:()=>taskIntegrate.conflictRequest(b)});
        }catch(e){integrationFailure(b,e,'resolve');return send(res,409,{error:e.message});}
      },
    },
  };
};
