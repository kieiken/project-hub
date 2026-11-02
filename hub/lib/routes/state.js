'use strict';

module.exports = function stateRoutes(ctx) {
  const platform = ctx.platform || process.platform;
  const { gitw, __dirname, pruneUnread, getDiscussion, rolesData, modelView, stepSummary, chats, restartBlockers, extensions, stopControl, ROOT, HUB_INSTANCE, VERSION, readVersion, BOOT_HEAD, license, appUpdate, appShell, freetalkStatus, onboarding, aiUpdates, aiTools, updateBusy, getRestartControl, bodyNoticeState, github, accounts, store, projectOrder, taskTransfer, stateOffers, taskIntegrate, launch, handoff, baseOf, githubProject, start, workRoot, copyMissing, chat, path, expandHome, fs, resultsGate, freetalkHistory, inWork, getWebchat, getMuseDirect, sessions, modelError, roles, unread, procwatch, acceleration, remote, gpt, crypto, fromRemote, getUpdateRestoreReady, record, sendEncoded, lt } = ctx;
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/state',
      async handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const t0 = Date.now();
          res.on('finish', () => { const ms = Date.now() - t0; if (ms > 2000) console.log(lt`[遅い] 一覧を作るのに ${ms}ms かかりました（台帳のファイルの読み込みが遅い可能性）`); });
          const savedHead = gitw.savedHeadAsync(__dirname);
          pruneUnread(); // Keep notification writes outside the display read scope.
          const handoffErrors = chats.handoffErrorsAsync ? await chats.handoffErrorsAsync() : chats.handoffErrors({display:true});
          const state = require('../state-read').run(() => {
          const discussionSessions = getDiscussion()?.read().sessions || {};
          const roleData = rolesData(), modelSettings = modelView.read(), initialPick = modelView.initial(modelSettings);
          // 画面で使う物だけ送る：作業の「やったこと」「注意」「メモ」の本文は送らず、「次にやること」は1行目だけ（1MB → 数百KB）
          const slim = t => { const { done, note, memo, next, steps, ...rest } = t; return { ...rest, stepSummary: stepSummary(steps), next: String(next || '').split('\n')[0] }; };
          // Share this display snapshot only. Action paths omit these arguments
          // and validate current receipts before sending, starting or restarting.
          const restartWaiting = restartBlockers(handoffErrors);
          return {
            museSupported: platform === 'darwin', extensions:extensions.state(), stopControl:stopControl.view(), root: ROOT, hubInstance: HUB_INSTANCE, roles: roleData, version: VERSION, latest: readVersion(), runtime:{version:VERSION,bootHead:BOOT_HEAD}, saved:{version:readVersion(),mainHead:null}, license: license.status(), appUpdate: appUpdate.status(), appShell: appShell.status(req.headers['user-agent']), freetalk: freetalkStatus(),
            ...(process.platform === 'win32' ? { windowsStorage: 'Windowsではファイル単位の書き込み確定と名前変更の完了待ちを使います。保存直後の停電では、ファイル名の変更や削除が残らない可能性があります。管理者として起動する必要はありません。' } : {}),
            onboarding: onboarding.state(),
            aiCliUpdate: { available: Object.values(aiUpdates.status().tools).some(t => t.eligible && t.installed && t.updateCheck?.ok && t.updateCheck.available === true && t.updateCheck.applicable === true), busyCount: aiTools.busy() },
            updateBlocked: Boolean(updateBusy(handoffErrors)), restart: getRestartControl().status(restartWaiting), restartBusy:restartWaiting.length>0, restartWaiting, chatHandoffErrors:handoffErrors,
            bodyNotices:bodyNoticeState(),
            github: github.summary(), accounts: accounts.list(),
            completionWarning: store.completion.warning, projectOrder: projectOrder.read(), projectPins: projectOrder.readPins(),
            taskHandoffs: taskTransfer.pending(),
            taskOffers: stateOffers.view(store.listProjects()), taskIntegrations: taskIntegrate.pending(),
            cliFlags: Object.fromEntries(launch.AIS.map(ai => [ai, Object.fromEntries((roleData.models[launch.AI_KEY[ai]] || []).map(m => [m, launch.flagFor(ai, m)]))])),
            // github：origin の場所と今のブランチ（120秒覚えておく）。作業は作業用コピーがある物だけ（ブランチが別のため）
            projects: (all => { const kids = handoff.childCounts(all); return all.map(p => {
              const base = baseOf(p);
              const {notes,...summary}=p;
              const githubRemote = github.projectRemote(githubProject(p));
              return { ...summary, children: kids[p.id], startSpec: start.lastSpec(p), copies: gitw.countCopies(workRoot(p)), githubHasOrigin: githubRemote.hasOrigin, github: githubRemote.value, githubTargetError: githubRemote.error || '', tasks: p.tasks.map(t => {
                const missing = copyMissing(p, t);
                const meta = chat.readMeta(p.dir, t.id);
                const queue = chats.queue(p.id, t.id);
                const githubFolder = t.workdir && !missing ? path.join(expandHome(t.workdir), githubRemote.target || '.') : '';
                const taskGithub = githubFolder && (githubRemote.target === '.' || fs.existsSync(path.join(githubFolder, '.git'))) ? gitw.remoteSummary(githubFolder).value : null;
                return { ...slim(resultsGate.decorate(p,t,all,{issue:stateOffers.issue(p,t)})), discussion: (()=>{const d=discussionSessions[JSON.stringify([p.id,t.id])];return d?{id:d.id,status:d.status}:null;})(), chatQueueCount: queue.length, chatQueueHeld: queue.some(q => Boolean(q?.stopHeld)), chatQueueBlocked: queue.some(q => !q || typeof q !== 'object' || Array.isArray(q) || Boolean(q.stopHeld || q.error || q.limitWaiting)), ...(p.kind === 'freetalk' ? { freetalkHistory: (()=>{try{return freetalkHistory.status(t.id);}catch(e){return {reason:e.message};}})() } : {}), accounts: meta.accounts || {}, codexFast: meta.codexFast === true, copy: inWork(p, t) && !missing, copyMissing: missing, webchatReason: (()=>{try{getWebchat().availability(p,t,undefined,handoffErrors);return '';}catch(e){return /^(?:webchat_[a-z_]+|feature_not_included)$/.test(e.message)?e.message:'webchat_task_busy';}})(), ...(t.workdir && !missing ? { github: taskGithub } : {}) };
              }) };
            }); })(store.listProjects()),
            sessions: sessions.list(), terminal: sessions.available(),
            chatting: [...(getMuseDirect?.()?.busy()||[]).map(({project,task,ai,model})=>({project,task,ai,model})), ...[...chats.running.entries()].map(([k, r]) => { const [project, task] = k.split('\u0000'); return { project, task, ai: r.ai, model: r.model }; })],
            specialMode: modelView.special(modelSettings),
            initialPick, initialPickError: modelError(initialPick.ai, initialPick.model),
            efforts: roles.EFFORTS, hiddenModels: modelView.hidden(modelSettings), modelOrder: modelView.saved(modelSettings), phoneLabels: modelView.phone(modelSettings),
            unread: [...unread].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }),
            background: procwatch.list().filter(x => x.project),
            acceleration: acceleration.settings(), remote: { enabled: remote.enabled() }, chatgpt: gpt.settings(), webchat: getWebchat().view(), hubDir: __dirname,
            grokAvailable: Boolean(aiTools.find('grok') && aiTools.catalog().grok.models.length),
            agyAvailable: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.length && !['failed','auth-required'].includes(aiTools.catalog().agy.state) && !launch.agyAccountError()),
            agyModels: aiTools.catalog().agy.models, agyModelsState: aiTools.catalog().agy.state || 'unconfirmed',
            agyModelError: aiTools.catalog().agy.error || '',
          };
          });
          state.saved.mainHead = await savedHead || null;
          // 変わっていなければ中身を送らない（304）。画面は15秒ごとに聞いてくるので、何も変わらない時はほぼ空の返事で済む
          // 止まっている秒数（quiet）は毎秒変わるので印には入れない（画面は別に /api/sessions で取る）
          const body = JSON.stringify(state);
          const tagBody = state.sessions.length ? JSON.stringify({ ...state, sessions: state.sessions.map(({ quiet, ...x }) => x) }) : body;
          // Identity/gzip (and quiet-only updates) share a semantic, weak validator.
          const tag = `W/"${crypto.createHash('sha1').update(tagBody).digest('hex').slice(0, 20)}"`;
          if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' }); return res.end(); }
          // Only a complete, successful local state response proves the new backend
          // is healthy. Error/304 responses and a closed stream leave recovery pending.
          if (!fromRemote() && appUpdate.healthy) res.once('finish', () => {
            if (res.statusCode !== 200 || !res.writableFinished || req.aborted) return;
            void appUpdate.healthy({ version: VERSION, hubPath: __dirname, token: process.env.HUB_UPDATE_CONFIRM, restored: getUpdateRestoreReady(), instance: HUB_INSTANCE }).catch(e => record('app-update-confirm-error', {}, { error: e.message }));
          });
          return sendEncoded(req, res, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: tag });
        }
      },
    },
  };
};
