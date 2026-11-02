'use strict';

module.exports = function taskHistoryReadRoutes(ctx) {
  const { send, taskHistory, autoView, textBudget } = ctx;
  return {
    continuation: {
      matches: (req, url) => req.method==='GET'&&url.pathname==='/api/task/continue/status',
      handle(req, res, url) {
        if(req.method==='GET'&&url.pathname==='/api/task/continue/status'){
          if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
          try{return send(res,200,taskHistory.continueStatus(url.searchParams.get('project'),url.searchParams.get('task'),url.searchParams.get('requestId')));}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    history: {
      matches: (req, url) => req.method==='GET'&&url.pathname.startsWith('/api/task/history/'),
      async handle(req, res, url) {
        if(req.method==='GET'&&url.pathname.startsWith('/api/task/history/')){
          if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
          const project=url.searchParams.get('project'),task=url.searchParams.get('task');
          try{if(url.pathname.endsWith('/status'))return send(res,200,{...taskHistory.status(project,task,{bodyPreview:await textBudget.previewPending(project)}),...(url.searchParams.get('selection')==='0'?{}:{selection:taskHistory.selectionPreview(project,task)})});
            if(url.pathname.endsWith('/auto'))return send(res,200,autoView(project,task));
            if(url.pathname.endsWith('/archives'))return send(res,200,{archives:taskHistory.archives(project,task)});
            if(url.pathname.endsWith('/archive'))return send(res,200,taskHistory.archive(project,task,url.searchParams.get('archiveId'),url.searchParams.get('offset')));
          }catch(e){return send(res,409,{error:e.message});}
          return send(res,404,{error:'not found'});
        }
      },
    },
  };
};
