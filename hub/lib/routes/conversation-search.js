'use strict';
module.exports = function ({ send, search, PORT, fromRemote }) {
  const allowed = req => !fromRemote() && req.headers['x-hub'] === '1' && (!req.headers.origin || [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin));
  const idOK = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
  return { access: {
    matches: (req, url) => ['GET', 'POST'].includes(req.method) && ['/api/conversation-search', '/api/conversation-search/context', '/api/conversation-search/cancel'].includes(url.pathname),
    async handle(req, res, url, body) {
      if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
      try {
        if (req.method === 'POST') {
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('検索の形式が違います。');
          if (url.pathname === '/api/conversation-search' && Object.keys(body).every(k => ['query', 'mode'].includes(k)) && typeof body.query === 'string' && (body.mode === undefined || ['simple', 'detailed'].includes(body.mode))) return send(res, 200, search.start(body.query, body.mode));
          if (url.pathname.endsWith('/cancel') && Object.keys(body).length === 1 && idOK(body.id)) return send(res, 200, search.cancel(body.id));
        } else if (idOK(url.searchParams.get('id'))) {
          const id = url.searchParams.get('id');
          if (url.pathname.endsWith('/context') && /^\d+$/.test(url.searchParams.get('hit') || '')) return send(res, 200, await search.context(id, Number(url.searchParams.get('hit'))));
          if (url.pathname === '/api/conversation-search') return send(res, 200, search.get(id, Number(url.searchParams.get('offset') || 0)));
        }
        return send(res, 400, { error: '検索の形式が違います。' });
      } catch (e) { return send(res, 409, { error: e.message }); }
    },
  } };
};
