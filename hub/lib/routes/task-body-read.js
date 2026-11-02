'use strict';

module.exports = function taskBodyReadRoutes(ctx) {
  const { send, lt, textBudget, path, store, fs } = ctx;
  return {
    preview: {
      matches: (req, url) => req.method==='GET'&&url.pathname==='/api/task/body/preview',
      async handle(req, res, url) {
        if(req.method==='GET'&&url.pathname==='/api/task/body/preview'){
          if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
          try{return send(res,200,await textBudget.previewAsync(url.searchParams.get('project'),url.searchParams.get('task'),url.searchParams.get('request')));}catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
    archives: {
      matches: (req, url) => req.method==='GET'&&(url.pathname==='/api/task/body/archives'||url.pathname==='/api/task/body/archive'),
      handle(req, res, url) {
        if(req.method==='GET'&&(url.pathname==='/api/task/body/archives'||url.pathname==='/api/task/body/archive')){
          if(req.headers['x-hub']!=='1')return send(res,403,{error:'forbidden'});
          try{const project=url.searchParams.get('project'),task=url.searchParams.get('task'),archives=textBudget.archives(project,task);
            if(url.pathname.endsWith('/archives'))return send(res,200,{archives});
            const want=url.searchParams.get('path'),hit=archives.find(a=>a.path===want);if(!hit)return send(res,404,{error:lt('この場所は見つかりません')});
            const file=path.join(store.readProject(project).dir,hit.path);require('../remove').noLinks(file);return send(res,200,{path:hit.path,text:fs.readFileSync(file,'utf8')});
          }catch(e){return send(res,409,{error:e.message});}
        }
      },
    },
  };
};
