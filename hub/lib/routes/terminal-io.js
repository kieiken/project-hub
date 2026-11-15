'use strict';

module.exports = function terminalioRoutes(ctx) {
  const { send, lt, sessions, setUnread, launch, modelError, store, pickSpec, limitIdentity, rolesData, record, accountFor } = ctx;
  return {
    stream: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/term/stream',
      handle(req, res, url) {
        const project = url.searchParams.get('project'), task = url.searchParams.get('task'), ai = url.searchParams.get('ai');
        const s = sessions.get(project, task, ai);
        if (!s) return send(res, 404, { error: lt('作業画面がありません') });
        setUnread(project, task, false); // 開いたので読んだことにする
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        emit({ type: 'data', data: s.buf, replay: true });
        if (s.exited) emit({ type: 'exit', code: s.code });
        const off = sessions.watch(project, task, ai, emit);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { off(); clearInterval(ping); });
        return undefined;
      },
    },
    switch: {
      matches: (req, url) => url.pathname === '/api/term/switch',
      handle(req, res, url, b) {
        if (b.ai === 'agy' && (b.field === 'effort' || sessions.get(b.project, b.task, b.ai) && !sessions.get(b.project, b.task, b.ai).exited)) return send(res, 409, { error: lt('Agy のモデル変更は次の起動から使います。動いているAgyの終了後に選んでください') });
        if (!launch.AIS.includes(b.ai) || !['model', 'effort'].includes(b.field)) return send(res, 400, { error: lt('指定が正しくありません') });
        if (b.ai === 'grok' && b.field === 'effort' && b.value && !launch.EFFORT_FLAG.grok[b.value]) return send(res, 400, { error: lt('Grok の思考は 中・高・極高・MAX です') });
        if (b.field === 'effort' && b.value && !launch.effortsFor(b.ai, pickSpec(store.readProject(b.project)?.tasks.find(t => t.id === b.task) || {}, b.ai).model).includes(b.value)) return send(res, 400, { error: lt('指定が正しくありません') });
        if (b.field === 'model') {
          const current = sessions.get(b.project,b.task,b.ai);
          const account = current && !current.exited ? current.account || 'default' : accountFor(b.project,b.task,b.ai);
          const invalidModel = modelError(b.ai, String(b.value || ''), account);
          if (invalidModel) return send(res, 409, { error: invalidModel });
        }
        const t = store.updateTask(b.project, b.task, { [b.field]: typeof b.value === 'string' ? b.value : '' });
        if (!t) return send(res, 400, { error: lt('作業が見つかりません') });
        const spec = pickSpec(t, b.ai);
        const cmd = launch.switchCommand(b.ai, b.field, spec[b.field], spec.model);
        const sent = Boolean(cmd) && sessions.type(b.project, b.task, b.ai, cmd);
        const session = sessions.get(b.project, b.task, b.ai); if (sent && session) { session[b.field] = spec[b.field]; if (b.field === 'model') session.limitSlot = limitIdentity(rolesData(), { ai: b.ai, model: session.model, role: session.role })?.limitSlot; }
        record('switch', b, { [b.field]: spec[b.field], sent });
        return send(res, 200, { ok: true, sent, command: cmd, ...spec });
      },
    },
    input: {
      matches: (req, url) => url.pathname === '/api/term/input',
      handle(req, res, url, b) {
        return send(res, sessions.write(b.project, b.task, b.ai, String(b.data || '')) ? 200 : 404, { ok: true });
      },
    },
    resize: {
      matches: (req, url) => url.pathname === '/api/term/resize',
      handle(req, res, url, b) {
        return send(res, sessions.resize(b.project, b.task, b.ai, b.cols, b.rows) ? 200 : 404, { ok: true });
      },
    },
  };
};
