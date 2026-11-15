'use strict';
module.exports = function jevSettingsRoutes({ send, PORT, fromRemote, jev }) {
  const origins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
  const allowed = req => !fromRemote() && req.headers['x-hub'] === '1' &&
    (!req.headers.origin || origins.includes(req.headers.origin));
  return {
    search: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/jev/search',
      handle(req, res, url, body) {
        if (!allowed(req) || !origins.includes(req.headers.origin)) return send(res, 403, { error: 'forbidden' });
        try { return send(res, 200, jev.configureSearch(body)); }
        catch { return send(res, 409, { error: '検索の利用設定を保存できません。自動で再送せず、設定を開き直して確認してください。' }); }
      },
    },
    read: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/jev',
      handle(req, res) {
        if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
        try { return send(res, 200, jev.status()); }
        catch { return send(res, 409, { error: 'Jevの登録状態を確認できません。キーを再登録せず、保存先を確認してください。' }); }
      },
    },
    verify: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/jev/verify',
      async handle(req, res, url, body) {
        if (!allowed(req) || !origins.includes(req.headers.origin)) return send(res, 403, { error: 'forbidden' });
        try { return send(res, 200, await jev.verify(body)); }
        catch (error) {
          return send(res, error.message === 'jev_confirm_required' ? 400 : 409, {
            error: error.message === 'jev_busy' ? '確認または登録が進行中です。完了を待ってください。' : '確認できません。操作内容を確認してください。',
          });
        }
      },
    },
    write: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/jev/key',
      handle(req, res, url, body) {
        if (!allowed(req) || !origins.includes(req.headers.origin)) return send(res, 403, { error: 'forbidden' });
        try { return send(res, 200, jev.save(body)); }
        catch (error) {
          return send(res, error.message === 'jev_key_invalid' ? 400 : 409, { error: error.message === 'jev_key_invalid'
            ? '接続用キーの形式を確認してください。空白や改行は含められません。'
            : '登録の完了を確認できません。自動で再送せず、設定画面を開き直して登録状態を確認してください。' });
        }
      },
    },
  };
};
