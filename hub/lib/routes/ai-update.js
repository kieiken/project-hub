'use strict';

module.exports = function ai_updateRoutes(ctx) {
  const { send, aiUpdates, applyModelCatalog, record, lt } = ctx;
  return {
    write: {
      matches: (req, url) => ['/api/ai-tools/update-all', '/api/ai-tools/check', '/api/ai-tools/update', '/api/ai-tools/models/refresh'].includes(url.pathname),
      async handle(req, res, url, b) {
        if (url.pathname === '/api/ai-tools/update-all') {
          if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length) return send(res, 400, { error: lt('一括更新の指定が正しくありません') });
          try { const result = await aiUpdates.updateAll(); record('aiupdate-all', {}, { results: result.results }); return send(res, 200, result); }
          catch (e) { return send(res, e.status || 502, { error: e.reason || lt('CLI の操作に失敗しました。状態を確認してください。'), stage: e.stage }); }
        }
        if (url.pathname === '/api/ai-tools/check') {
          try { return send(res, 200, await aiUpdates.single(b.ai, 'check', b.account)); }
          catch (e) { return send(res, e.status || 502, { error: e.reason || lt('更新情報の確認に失敗しました'), stage: e.stage }); }
        }
        if (url.pathname === '/api/ai-tools/update' || url.pathname === '/api/ai-tools/models/refresh') {
          try {
            const result = await aiUpdates.single(b.ai, url.pathname.endsWith('/update') ? 'update' : 'models', b.account);
            applyModelCatalog();
            record(url.pathname.endsWith('/update') ? 'aiupdate' : 'aimodels', { ai: b.ai }, { added: result.models?.added ?? result.added ?? 0 });
            return send(res, 200, result);
          } catch (e) {
            return send(res, e.status || 502, { error: e.reason || e.message || lt('CLI の操作に失敗しました'), stage: e.stage || 'operation', reason: e.reason || e.message || '' });
          }
        }
      },
    },
  };
};
