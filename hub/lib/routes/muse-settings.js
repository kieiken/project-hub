'use strict';

module.exports = function museSettingsRoutes({ send, PORT, fromRemote, muse, launch, DRY, record, approvalDispatch, approvalProbe, direct, platform = process.platform }) {
  function allowed(req) {
    return !fromRemote() && req.headers['x-hub'] === '1' && (!req.headers.origin ||
      [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin));
  }
  const approvals = new (require('../muse-approvals').MuseApprovals)({ muse, dispatch: approvalDispatch, probe: approvalProbe });
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && ['/api/muse','/api/muse/approvals','/api/muse/chat'].includes(url.pathname),
      async handle(req, res, url) {
        if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
        try {
          if (platform !== 'darwin') {
            if (url?.pathname === '/api/muse/chat') return send(res, 200, { pending: null });
            if (url?.pathname === '/api/muse/approvals') return send(res, 200, { approvals: [] });
          }
          if (url?.pathname === '/api/muse/chat') {
            const project=url.searchParams.get('project'),task=url.searchParams.get('task');
            return send(res,200,direct.status?direct.status(project,task):{pending:direct.pending(project,task)});
          }
          if (url?.pathname === '/api/muse/approvals') return send(res, 200, await approvals.list(url.searchParams.get('project'), url.searchParams.get('task')));
          return send(res, 200, {...await muse.status(),replySettings:direct?.scheduler?.settings()||{extendedAutoRead:false}});
        }
        catch { return send(res, 409, { error: url?.pathname === '/api/muse/chat' ? 'Museの状態を確認できません。質問を送り直さず、この会話で確認を依頼してください。' : url?.pathname === '/api/muse/approvals' ? 'Museの承認内容を安全に確認できませんでした。再送せず、この会話で確認を依頼してください。' : 'Museの設定を安全に確認できませんでした。再登録せず、設定を確認してください。' }); }
      },
    },
    write: {
      matches: (req, url) => req.method === 'POST' && ['/api/muse/reply-settings','/api/muse/usage', '/api/muse/tool', '/api/muse/terminal', '/api/muse/workspace', '/api/muse/approvals/decide', '/api/muse/chat', '/api/muse/read', '/api/muse/reconcile'].includes(url.pathname),
      async handle(req, res, url, body) {
        if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
        if(url.pathname==='/api/muse/reply-settings') {
          if(![`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`].includes(req.headers.origin))return send(res,403,{error:'forbidden'});
          try{return send(res,200,{ok:true,replySettings:direct.scheduler.configure(body)});}
          catch{return send(res,400,{error:'回答の自動確認設定を確認してください。'});}
        }
        if (url.pathname === '/api/muse/usage') {
          if (![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin)) return send(res,403,{error:'forbidden'});
          if (!body || body.confirm !== true || Object.keys(body).length !== 1) return send(res,400,{error:'利用枠の確認内容を確かめてください。'});
          const result = await muse.usageRead();
          return send(res,result.error ? 409 : 200,result);
        }
        if (['/api/muse/chat','/api/muse/read','/api/muse/reconcile'].includes(url.pathname)) {
          if (![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin)) return send(res,403,{error:'forbidden',delivery:'not-sent'});
          try { const r=await (url.pathname==='/api/muse/reconcile'?direct.reconcile(body):url.pathname==='/api/muse/read'?direct.readReply(body):direct.send(body));return send(res,200,r); }
          catch(e) { return send(res,409,{error:e.message,delivery:'not-sent'}); }
        }
        if (url.pathname === '/api/muse/approvals/decide') {
          // Browser-only by policy; Origin is mandatory, not an optional CLI header.
          if (![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin)) return send(res, 403, { error:'forbidden' });
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true ||
              Object.keys(body).some(k => !['project','task','id','ticket','decision','confirm','generation'].includes(k)) ||
              !['project','task','id','ticket'].every(k => typeof body[k] === 'string') ||
              !['approve','decline'].includes(body.decision) ||
              Object.hasOwn(body,'generation') && !Number.isSafeInteger(body.generation)) return send(res,400,{error:'承認内容を確認してください。'});
          try { const result = await approvals.decide(body); return send(res,result.ok ? 200 : 409,result); }
          catch { return send(res,409,{ error:'承認内容または受付状態が変わりました。再送せず、作業画面で状態を確認してください。' }); }
        }
        if (url.pathname === '/api/muse/workspace') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true ||
              Object.keys(body).some(k => !['project', 'task', 'action', 'confirm', 'generation'].includes(k)) ||
              (Object.hasOwn(body, 'generation') && !Number.isSafeInteger(body.generation)) ||
              typeof body.project !== 'string' || typeof body.task !== 'string' || !['permits', 'manage'].includes(body.action)) {
            return send(res, 400, { error: '対象の作業と操作を確認してください。秘密はここへ送らないでください。' });
          }
          try {
            if (body.action === 'permits') return send(res, 200, await muse.workspacePermits(body.project, body.task));
            const command = muse.workspaceCommand(body.project, body.task, launch.sq);
            await launch.openTerminal(command, DRY);
            record('museWorkspaceTerminal', {}, { operation: 'manage' });
            return send(res, 200, { ok: true, notice: '本人用ターミナルで資料・対象・期限・回数を確認してください。開くだけでは承認も送信も行いません。' });
          } catch { return send(res, 409, { error: '作業の許可を安全に確認できませんでした。自動再送せず、対象と接続ツールを確認してください。' }); }
        }
        const tool = url.pathname.endsWith('/tool');
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(k => !(tool ? ['folder', 'useExisting', 'confirm'] : ['action', 'confirm']).includes(k)) ||
            body.confirm !== true || (tool ? !((typeof body.folder === 'string' && !Object.hasOwn(body, 'useExisting')) || (body.useExisting === true && !Object.hasOwn(body, 'folder'))) : !['register', 'update', 'disconnect'].includes(body.action))) {
          return send(res, 400, { error: '操作内容を確認してください。ログイン情報はここへ送らないでください。' });
        }
        try {
          if (tool) { if (body.useExisting === true) muse.selectExisting(); else muse.select(body.folder); return send(res, 200, await muse.status()); }
          const command = await muse.command(body.action, launch.sq);
          await launch.openTerminal(command, DRY);
          record('museTerminal', {}, { operation: body.action });
          return send(res, 200, { ok: true, notice: 'Macのターミナルで本人確認を続けてください。終わったら［状態を確認］を押してください。相談は送信しません。' });
        } catch { return send(res, 409, { error: 'Museの操作を開始できませんでした。自動でやり直さず、状態と接続ツールを確認してください。' }); }
      },
    },
  };
};
