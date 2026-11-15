'use strict';

module.exports = function chatrecoveryRoutes(ctx) {
  const { send, chats, store } = ctx;
  return {
    handoff: {
      matches: (req, url) => url.pathname === '/api/chat/handoff/recover',
      handle(req, res, url, b) {
        try{return send(res,200,chats.recoverHandoff(b));}
        catch(e){return send(res,409,{error:e.message,delivery:'not-sent'});}
      },
    },
    unfinishedList: {
      matches: (req,url)=>req.method==='GET'&&url.pathname==='/api/chat/unfinished',
      handle(req,res,url){
        const project=url.searchParams.get('project'),task=url.searchParams.get('task'),p=store.readProject(project);
        if(!p||!store.taskFile(project,task))return send(res,400,{error:'作業が見つかりません'});
        try{return send(res,200,{entries:require('../chat-continuation').pending(p.dir,task).map(e=>({id:e.id,status:e.status,original:e.original,reason:e.reason,at:e.source?.at||e.updated,updated:e.updated}))});}
        catch(e){return send(res,409,{error:e.message});}
      },
    },
    unfinished: {
      matches: (req, url) => req.method==='POST'&&['/api/chat/unfinished/resolve','/api/chat/unfinished/dismiss'].includes(url.pathname),
      handle(req, res, url, b) {
        const p=typeof b.project==='string'?store.readProject(b.project):null;
        if(!p||typeof b.task!=='string'||!/^[^/\\\0]+$/.test(b.task)||/^[_.]/.test(b.task))return send(res,400,{error:'作業が見つかりません'});
        const taskMissing=!store.taskFile(b.project,b.task);
        // Missing ordinary tasks may retain receipts. Freetalk still requires a real topic.
        if(taskMissing&&(p.id==='freetalk'||p.kind==='freetalk'))return send(res,400,{error:'作業が見つかりません'});
        try{return send(res,200,{ok:true,entry:require('../chat-continuation')[url.pathname.endsWith('/dismiss')?'dismiss':'resolve'](p.dir,b.task,b,{taskMissing,project:p.id})});}
        catch(e){return send(res,409,{error:e.message});}
      },
    },
  };
};
