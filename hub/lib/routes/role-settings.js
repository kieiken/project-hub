'use strict';

module.exports = function rolesettingsRoutes(ctx) {
  const { send, lt, roleHistory, ROLES_FILE, roles, tiers, getReview, extensions, license } = ctx;
  const available=()=>{if(!extensions?.state().included.includes('delegate'))throw Object.assign(Error(lt('この版では段分けを使えません')),{status:404});license.require(['delegate']);};
  const human=req=>require('../idea-api').humanRequest({...req,headers:{...req.headers,'x-hub-ui':req.headers['x-hub-ui']==='role-tiers'?'ideas':''}});
  const guardUI=req=>{if(!human(req))throw Object.assign(Error(lt('この操作は設定画面から行ってください')),{status:403});};
  return {
    tiers: { matches:(req,url)=>req.method==='GET'&&url.pathname==='/api/roles/tiers',handle(req,res){try{available();return send(res,200,tiers.view());}catch(e){return send(res,e.status||409,{error:e.message});}} },
    tierAction: { matches:(req,url)=>req.method==='POST'&&url.pathname.startsWith('/api/roles/tiers/'), async handle(req,res,url,b){try{
      available();
      if(url.pathname==='/api/roles/tiers/stop')return send(res,200,tiers.stop(b,human(req)?'人':'ai'));
      guardUI(req);
      if(url.pathname==='/api/roles/tiers/review')return send(res,200,await getReview().start());
      if(url.pathname==='/api/roles/tiers/proposal')return send(res,200,getReview().decide(b));
      if(url.pathname==='/api/roles/tiers/catalog'){const r=tiers.read();r.data.catalogSeen=require('../role-tiers').snapshot(tiers.tools);require('../role-tiers').write(tiers.file,r.data,r.revision);return send(res,200,tiers.view());}
      return send(res,404,{error:'not found'});
    }catch(e){return send(res,e.status||409,{error:e.message});}} },
    history: {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/api/roles/history',
      handle(req, res, url, b) {
        const current = roleHistory.load(ROLES_FILE);
        return send(res,200,{...roleHistory.summary(current),history:current.journal.history,defaults:current.journal.defaults});
      },
    },
    write: {
      matches: (req, url) => url.pathname === '/api/roles',
      handle(req, res, url, b) {
        if (!Array.isArray(b.roles)) return send(res, 400, { error: lt('形式が違います') });
        if(b.tiers!==undefined){try{
          available();guardUI(req);
          if(tiers.read().revision!==b.tiersRevision)throw Error(lt('段の設定が変わりました。読み直してください'));
          require('../role-tiers').validate(b.tiers,b.roles,tiers.tools.catalog());
          const before=tiers.read().data.roles;
          for(const [name,row]of Object.entries(before))if(row.routing==='stopped'&&(!b.tiers[name]||b.tiers[name].routing==='on')&&!b.resumeTiers?.includes(name))throw Error(lt('停止した振り分けの再開を確認してください'));
        }catch(e){return send(res,e.status||409,{error:e.message});}}
        const r = roles.write(ROLES_FILE, b.roles, b.checkCredits, false, b.preferCredits, { expectedRevision: b.expectedRevision, allowDelegateUltra: b.allowDelegateUltra });
        if(r.ok&&b.tiers!==undefined){try{tiers.save(b.tiers,b.tiersRevision,{ui:true,resume:b.resumeTiers||[]});}catch(e){return send(res,e.status||409,{error:e.message});}}
        return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
      },
    },
    defaults: {
      matches: (req, url) => url.pathname === '/api/roles/default',
      handle(req, res, url, b) {
        const r = roles.saveDefault(ROLES_FILE, b.roles, b.expectedRevision);
        return r.ok ? send(res, 200, r.data) : send(res, r.status || 400, { error: r.errors.join(' / ') });
      },
    },
    restore: {
      matches: (req, url) => url.pathname === '/api/roles/restore',
      handle(req, res, url, b) {
        const current = roleHistory.load(ROLES_FILE);
        if (!b.expectedRevision || b.expectedRevision !== current.revision) return send(res,409,{error:lt('役割設定が変わりました。読み直してください')});
        const row = b.defaults === true ? current.journal.defaults : roleHistory.select(current.journal,b);
        if (!row) return send(res,409,{error:lt('デフォルトはまだ保存されていません')});
        const r = roles.write(ROLES_FILE, row.roles, undefined, true, undefined, {
          expectedRevision:b.expectedRevision, restore:true, kind:b.defaults === true ? 'default' : 'restore',
          reason:b.defaults === true ? lt('固定したデフォルトに戻した') : lt('履歴の設定に戻した') + `（${row.at}）`
        });
        return r.ok ? send(res,200,r.data) : send(res,r.status || 400,{error:r.errors.join(' / ')});
      },
    },
  };
};
