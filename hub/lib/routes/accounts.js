'use strict';

module.exports = function accountsRoutes(ctx) {
  const { send, accounts, launch, usage, aiTools, applyModelCatalog, lt, sessions, store, chat, DRY, limitEvidence, record } = ctx;
  return {
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/accounts',
      async handle(req, res, url) {
        if (url.searchParams.get('status') === '1' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
        const filterAi = url.searchParams.get('ai');
        if (filterAi && !launch.AIS.includes(filterAi)) return send(res, 400, { error: 'invalid ai' });
        const rows = accounts.list().filter(row => !filterAi || row.ai === filterAi);
        const checked = url.searchParams.get('status') === '1' ? await Promise.all(rows.map(async r => {
          const status = await accounts.status(r.ai, r.id); usage.loginChecked(r.ai, r.id, status.status);
          if (r.ai === 'agy') {
            try {
              if (status.modelObservation) aiTools.saveCatalog('agy', status.modelObservation);
              else if (status.modelsState === 'failed') aiTools.modelFailure('agy', status.message);
              applyModelCatalog();
            } catch { return { ...r, ...status, message: lt('モデル一覧を保存できませんでした。再取得してください') }; }
          }
          return { ...r, ...status };
        })) : rows;
        return send(res, 200, { accounts: checked, ...(url.searchParams.get('status') === '1' ? {
          agyCatalog: { ...aiTools.catalog().agy, available: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.length && !['failed','auth-required'].includes(aiTools.catalog().agy.state) && !launch.agyAccountError()) },
        } : {}) });
      },
    },
    write: {
      matches: (req, url) => url.pathname === '/api/accounts' || url.pathname.startsWith('/api/accounts/'),
      async handle(req, res, url, b) {
        try {
          let result = { ok: true };
          const ai = b.ai, id = b.id || 'default';
          if (['/api/accounts/login','/api/accounts/logout','/api/accounts/delete'].includes(url.pathname) && aiTools.isOperating(ai)) return send(res,409,{error:lt('AI の更新・モデル再取得が進行中です')});
          if (url.pathname === '/api/accounts') { result.account = accounts.add(ai, b.name); usage.invalidate(ai, result.account.id); }
          else if (url.pathname === '/api/accounts/terminal') {
            if (!['login', 'logout'].includes(b.action)) return send(res, 400, { error: 'invalid action' });
            if (process.platform === 'win32' && !DRY) return send(res, 409, { error: lt('Windows では認証用の窓を前に出せません。開いている bash の窓で操作してください') });
            const pid = accounts.authTerminalPid(ai, id);
            if (!pid) return send(res, 409, { error: lt('認証用Terminalが見つかりません。起動途中で止まった窓を閉じ、［状態を確認］を押してから［ログイン］をやり直してください。') });
            result = await launch.focusAuthTerminal(pid, DRY);
            result.warning = ai === 'agy' ? (b.action === 'logout' ? lt('開いている認証用Terminalで /logout と入力し、終わったら［状態を確認］を押してください。') : lt('開いている認証用Terminalで /login と入力し、終わったら［状態を確認］を押してください。')) : lt('開いている認証用Terminalで操作を続け、終わったら［状態を確認］を押してください。');
          }
          else if (url.pathname === '/api/accounts/rename') accounts.rename(ai, id, b.name);
          else if (url.pathname === '/api/accounts/select') {
            const p = store.readProject(b.project);
            if (!p || !store.taskFile(p.id, b.task)) throw Error(lt('作業が見つかりません'));
            accounts.available(ai, id);
            const live = sessions.get(p.id, b.task, ai);
            if (live && !live.exited && (live.account || 'default') !== id) return send(res, 409, { error: lt('このAIのターミナルが作業中です。終了してから切り替えてください') });
            const meta = chat.readMeta(p.dir, b.task); meta.accounts = { ...meta.accounts, [ai]: id }; chat.writeMeta(p.dir, b.task, meta);
            result.accounts = meta.accounts;
          } else if (url.pathname === '/api/accounts/login' || ai === 'agy' && url.pathname === '/api/accounts/logout') {
            if (url.pathname.endsWith('/logout') && (b.confirm !== true || b.confirmDefault !== true)) return send(res, 400, { error: lt('既定のログアウトをもう一度確認してください') });
            accounts.assertIdle(ai, id);
            const c = accounts.command(ai, id, 'login');
            const command = (ai === 'agy' ? launch.agyAccountShell() : launch.accountShell(ai, id)) + [c.command, ...c.args].map(launch.sq).join(' ');
            const terminal = accounts.terminalCommand(ai, id, command, launch.sq, 'auth', url.pathname.endsWith('/logout') ? 'logout' : 'login');
            try { result = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
            usage.invalidate(ai, id);
            if (DRY) result = { dry: true, command };
            if (ai === 'agy') result.warning = url.pathname.endsWith('/logout') ? lt('Macで開いたTerminalで /logout と入力し、終わったら［状態を確認］を押してください。') : lt('Macで開いたTerminalで /login と入力し、終わったら［状態を確認］を押してください。');
          } else if (url.pathname === '/api/accounts/logout' || url.pathname === '/api/accounts/delete') {
            if (b.confirm !== true) return send(res, 400, { error: lt('確認してから操作してください') });
            if (url.pathname.endsWith('/logout')) result = await accounts.logout(ai, id, b.confirmDefault);
            else { result = accounts.remove(ai, id); if (ai === 'claude') { try { limitEvidence.clear(id); } catch { result.warning = lt('削除は完了しましたが、上限記録の片付けを保存できませんでした'); } } }
            usage.invalidate(ai, id);
          } else return send(res, 404, { error: lt('操作が見つかりません') });
          record('account' + url.pathname.split('/').pop(), { ai }, { account: id });
          return send(res, 200, result);
        } catch (e) { return send(res, e.status || 400, { error: e.message }); }
      },
    },
  };
};
