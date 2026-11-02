'use strict';

module.exports = function tasksettingsRoutes(ctx) {
  const { send, lt, store, fromRemote, record, chats, sessions, setUnread, taskHistory, chat } = ctx;
  return {
    update: {
      matches: (req, url) => url.pathname === '/api/task',
      handle(req, res, url, b) {
        if (url.pathname === '/api/task') {
          if (fromRemote()) record('task', b, { state: b.state, question: b.question !== undefined, memo: b.memo !== undefined });
          if (b.state === '完了') return send(res, 409, { error: lt('［完了に移す］で内容を確認してから完了にしてください') });
          const str = k => (typeof b[k] === 'string' ? b[k] : undefined);
          let context = {};
          if (['kind','derivedFrom','parent','workspaceMode'].some(k => b[k] !== undefined)) {
            try {
              const p=store.readProject(b.project), file=store.taskFile(b.project,b.task), t=file && store.readTask(file);
              if (!p || !t) throw Error(lt('作業がありません'));
              context=require('../work-context').validateTask(p,t,b,store.listProjects());
              if (b.workspaceMode !== undefined && b.workspaceMode !== t.workspaceMode && (t.workspaceStarted || t.state !== '未着手' || t.workdir || chats.busy(p.id,t.id) || sessions.list().some(s=>s.project===p.id && s.task===t.id && s.running))) throw Error(lt('場所は作業開始前に選んでください。既存コピーは自動で移しません'));
            } catch(e) { return send(res,409,{error:e.message}); }
          }
          const project=b.dismissQuestion===true&&b.question===''?store.readProject(b.project):null;
          let dismissed=null;
          if(project&&project.kind!=='freetalk')try{dismissed=taskHistory.pendingQuestion(b.project,b.task);}
          catch(e){record('question-display-read-error',b,{phase:'dismiss',error:e.message});}
          const t = store.updateTask(b.project, b.task, {
            state: str('state'), question: str('question'), owner: str('owner'), role: str('role'),
            ...context, model: str('model'), effort: str('effort'), parent: str('parent'), phase: str('phase'), via: str('via'), memo: b.memo,
          });
          if(t&&dismissed){
            const row=chat.append(project.dir,b.task,{role:'event',answeredQuestionSource:dismissed.source,text:''});
            chats.emit(b.project,b.task,{type:'row',row});
          }
          return t ? send(res, 200, t) : send(res, 400, { error: lt('作業が見つかりません') });
        }
      },
    },
    read: {
      matches: (req, url) => url.pathname === '/api/task/read',
      handle(req, res, url, b) {
        if (url.pathname === '/api/task/read') {
          if (typeof b.project !== 'string' || typeof b.task !== 'string') return send(res, 400, { error: lt('作業が見つかりません') });
          setUnread(b.project, b.task, false);
          return send(res, 200, { ok: true });
        }
      },
    },
  };
};
