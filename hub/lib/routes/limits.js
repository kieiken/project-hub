'use strict';

module.exports = function limitsRoutes(ctx) {
  const { send, usageSelection, accounts, usage, limitEvidence, record, usageWithLimit, lt, limitModels, getDiscussion } = ctx;
  return {
    clear: {
      matches: (req, url) => req.method === 'POST' && url.pathname === '/api/limits/clear',
      handle(req, res, url, b) {
        if (req.method === 'POST' && url.pathname === '/api/limits/clear') {
          const models = limitEvidence.clearableModels(limitModels());
          for(const [ai,ids] of Object.entries(getDiscussion().limitModels()))models[ai]=[...new Set([...(models[ai]||[]),...ids])];
          if (!models[b.ai]?.includes(b.model)) return send(res, 400, { error: lt('上限の指定が正しくありません') });
          try { const selection = usageSelection(url, b); const account = b.account || selection[b.ai] || 'default'; accounts.get(b.ai, account); limitEvidence.clear(account, b.model,models); }
          catch { return send(res, 500, { error: lt('解除を保存できませんでした') }); }
          record('limit-clear', { ai: b.ai });
          return send(res, 200, usageWithLimit(usage.snapshot(usageSelection(url, b))));
        }
      },
    },
    write: {
      matches: (req, url) => req.method === 'POST' && ['/api/limits/credit-exception', '/api/limits/credit-exception/end', '/api/limits/fable/clear'].includes(url.pathname),
      async handle(req, res, url, b) {
        if(req.method==='POST'&&['/api/limits/credit-exception','/api/limits/credit-exception/end'].includes(url.pathname)){
          try{
            if(b.ai!=='codex'||b.account!=='default')throw Error(lt('Codexの既定アカウントだけを指定してください'));
            accounts.get('codex','default');
            const selection=usageSelection(url,b);
            const snapshot=url.pathname.endsWith('/end')?usage.snapshot({...selection,codex:'default'}):await usage.status(false,{...selection,codex:'default'});
            if(url.pathname.endsWith('/end'))limitEvidence.endCreditException(b,snapshot);else limitEvidence.startCreditException(b,snapshot);
            record('credit-exception',{ai:'codex'},{ended:url.pathname.endsWith('/end')});
            return send(res,200,usageWithLimit(snapshot));
          }catch(e){return send(res,409,{error:e.message});}
        }
        if (req.method === 'POST' && url.pathname === '/api/limits/fable/clear') {
          try { const selection = usageSelection(url, b); limitEvidence.clear(selection.claude || 'default'); }
          catch { return send(res, 500, { error: lt('解除を保存できませんでした') }); }
          record('limit-clear', {});
          // 解除に利用枠の取得を待たせない。遅れて届く応答もフラグを作らない。
          return send(res, 200, usageWithLimit(usage.snapshot(usageSelection(url, b))));
        }
      },
    },
  };
};
