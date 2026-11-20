'use strict';

const { OFFICIAL_PACKS, installOfficialPack } = require('../langpack-download');
const packPaths = ['/api/langpacks', '/api/langpacks/download', '/api/langpacks/import', '/api/langpacks/remove', '/api/language'];

module.exports = function languageRoutes(ctx) {
  const { send, localeConfig, fromRemote, allowed, langpacks, ROOT, VERSION, readBody, fetcher } = ctx;
  const settings = () => ({ ...langpacks.packSettings(ROOT, VERSION), officialPacks: OFFICIAL_PACKS });
  const downloads = new Map();
  return {
    locale: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/locale',
      handle: (req, res) => send(res, 200, localeConfig()),
    },
    packs: {
      matches: (req, url) => packPaths.includes(url.pathname),
      async handle(req, res, url) {
        if (fromRemote() || !allowed(req)) return send(res, 403, { error: 'forbidden' });
        if (req.method === 'GET' && url.pathname === '/api/langpacks') return send(res, 200, settings());
        if (req.method !== 'POST' || url.pathname === '/api/langpacks') return send(res, 405, { error: 'method' });
        try {
          const body = await readBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('形式が違います');
          if (url.pathname === '/api/langpacks/download') {
            const { id } = body;
            if (!downloads.has(id)) downloads.set(id, installOfficialPack(ROOT, VERSION, id, langpacks, fetcher).finally(() => downloads.delete(id)));
            await downloads.get(id);
            return send(res, 200, settings());
          }
          if (url.pathname === '/api/langpacks/import') langpacks.importPack(ROOT, body.dir);
          else if (url.pathname === '/api/langpacks/remove') langpacks.removePack(ROOT, body.id);
          else langpacks.selectLanguage(ROOT, body.language);
          return send(res, 200, settings());
        } catch (error) {
          const status = url.pathname === '/api/langpacks/download' ? error.status || 400 : 400;
          return send(res, status, { error: error.message });
        }
      },
    },
  };
};
