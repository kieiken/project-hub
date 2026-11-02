'use strict';

module.exports = function chatReadRoutes(ctx) {
  const { send, lt, store, record, setUnread, taskHistory, ideaRows, chat, chats, getWebchat, getMuseDirect, freetalkHistory } = ctx;
  return {
    stream: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/chat/stream',
      handle(req, res, url) {
        if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
          const project = url.searchParams.get('project'), task = url.searchParams.get('task');
          const p = store.readProject(project);
          if (!p || !store.taskFile(project, task)) return send(res, 404, { error: lt('作業が見つかりません') });
          setUnread(project, task, false); // 開いたので読んだことにする
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          const emit = ev => {
            if(p.kind!=='freetalk') {
              const generation=taskHistory.state(project,task).generation;
              if(ev.type==='rows')ev={...ev,rows:ideaRows(ev.rows,generation)};
              else if(ev.type==='row' && ['user','assistant'].includes(ev.row.role)) {
                const rows=ideaRows(chat.read(p.dir,task),generation),found=rows.findLast(r=>r.role===ev.row.role&&r.text===ev.row.text&&r.at===ev.row.at);
                ev={...ev,row:found||ev.row};
              }
            }
            if(p.kind!=='freetalk'&&taskHistory.pendingQuestion&&['rows','row'].includes(ev.type)){
              try{
                const pendingQuestion=taskHistory.pendingQuestion(project,task);
                ev={...ev,pendingQuestion};
                if(ev.type==='rows')ev.rows=ev.rows.map(r=>r.asks?.length?{...r,questionsManaged:true}:r);
                else if(ev.row.asks?.length)ev.row={...ev.row,questionsManaged:true};
              }catch(e){record('question-display-read-error',{project,task},{phase:'stream',error:e.message});}
            }
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          };
          const run = chats.busy(project, task);
          const muse = getMuseDirect?.()?.busy().find(j=>j.project===project&&j.task===task);
          const wc = getWebchat().busy().find(j=>j.project===project&&j.task===task);
          emit({ type: 'rows', generation:p.kind==='freetalk'?freetalkHistory.state(task).generation:taskHistory.state(project,task).generation, rows: chat.read(p.dir, task), busy: run ? { ai: run.ai, model: run.model, text: run.texts.join(['agy', 'grok'].includes(run.ai) ? '' : '\n\n'), started: run.started, last: run.last } : muse || (wc ? {ai:'chatgpt',model:wc.model,started:Date.parse(wc.at),text:'',webchat:true} : null), queue: chats.queue(project, task) });
          const off = chats.watch(project, task, emit);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => { off(); clearInterval(ping); });
          return undefined;
        }
      },
    },
  };
};
