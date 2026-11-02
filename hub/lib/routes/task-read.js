'use strict';

module.exports = function taskreadRoutes(ctx) {
  const { send, lt, store, stepSummary, inWork, gitw, expandHome, workRoot, taskIntegrate } = ctx;
  return {
    steps: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/task/steps',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/task/steps') {
          const p=store.readProject(url.searchParams.get('project')),t=p?.tasks.find(t=>t.id===url.searchParams.get('task'));
          return t ? send(res,200,{steps:t.steps,version:stepSummary(t.steps).version}) : send(res,404,{error:lt('作業が見つかりません')});
        }
      },
    },
    preview: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/task/preview',
      async handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/task/preview') {
          const p = store.readProject(url.searchParams.get('project'));
          const file = p && store.taskFile(p.id, url.searchParams.get('task'));
          if (!file) return send(res, 400, { error: lt('作業が見つかりません') });
          const t = store.readTask(file);
          if (!inWork(p, t)) return send(res, 200, null);
          let r = null;
          try { r = await gitw.previewAsync({ dir: expandHome(t.workdir), workRoot: workRoot(p), root: store.root }); } catch (e) { r = null; }
          if(r)r.mainDisplay=taskIntegrate.mainDisplay(p.id,t.id);
          return send(res, 200, r);
        }
      },
    },
  };
};
