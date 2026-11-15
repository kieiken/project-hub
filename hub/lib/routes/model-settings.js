'use strict';

module.exports = function model_settingsRoutes(ctx) {
  const { send, saveCliModels, record, launch, modelView, rolesData, modelError, roles, ROLES_FILE, lt, accounts, aiTools } = ctx;
  return {
    cli: {
      matches: (req, url) => url.pathname === '/api/cli-models',
      handle(req, res, url, b) {
        if (url.pathname === '/api/cli-models') {
          const clean = x => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length < 40 && /^[\w.:\-/\[\]]*$/.test(v.trim())).map(([k, v]) => [k, v.trim()])) : {});
          saveCliModels({ claude: clean(b.claude), codex: clean(b.codex) });
          record('climodels', {});
          return send(res, 200, { ok: true, overrides: launch.getOverrides() });
        }
      },
    },
    write: {
      matches: (req, url) => ['/api/models/hidden', '/api/special-mode', '/api/models/initial', '/api/models/phone', '/api/models/order', '/api/models/tidy'].includes(url.pathname),
      handle(req, res, url, b) {
        if (url.pathname === '/api/models/hidden') {
          if (!['claude-code', 'codex', 'agy', 'grok'].includes(b.ai) || typeof b.model !== 'string' || !b.model) return send(res, 400, { error: lt('形式が違います') });
          if (b.account !== undefined) {
            try {
              if (b.ai !== 'codex' || typeof b.account !== 'string') throw Error(lt('アカウントの指定が正しくありません'));
              accounts.get('codex', b.account);
              if (!aiTools.accountCatalog('codex', b.account).models.some(row => row.label === b.model)) throw Error(lt('このアカウントのモデルを一覧から選んでください'));
            } catch (e) { return send(res, e.status || 400, { error: e.message }); }
          }
          return send(res, 200, { ok: true, ...modelView.setHidden(b.ai, b.model, Boolean(b.hidden), b.account) });
        }
        if (url.pathname === '/api/special-mode') {
          const r = modelView.setSpecial(b);
          if (r.error) return send(res, r.status, { error: r.error });
          record('specialmode', {}, r.specialMode);
          return send(res, 200, { ok: true, ...r });
        }
        if (url.pathname === '/api/models/initial') {
          const r = modelView.setInitial(b, rolesData().models, modelError);
          if (r.error) return send(res, r.status, { error: r.error });
          record('initialai', {}, r.initialPick);
          return send(res, 200, { ok: true, ...r });
        }
        if (url.pathname === '/api/models/phone') {
          const r = modelView.setPhone(b, rolesData().models);
          return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
        }
        if (url.pathname === '/api/models/order') {
          const r = modelView.setOrder(b.order, b.before, rolesData().models);
          return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
        }
        // 最新のモデルに整理：役割の古いモデル名を、同じ系統の一番新しいモデルに。roles.yaml の一覧も今のものに
        if (url.pathname === '/api/models/tidy') {
          const r = roles.tidy(ROLES_FILE, { expectedRevision: b.expectedRevision });
          if (!r.ok) return send(res, r.delivery ? 409 : 400, { error: r.error,...(r.delivery?{delivery:r.delivery}:{}) });
          record('modeltidy', {}, { changes: r.changes.length });
          return send(res, 200, { ok: true, changes: r.changes, roles: rolesData() });
        }
      },
    },
  };
};
