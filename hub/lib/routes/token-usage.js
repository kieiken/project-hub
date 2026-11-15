'use strict';
module.exports=({send,tokenUsage,PORT})=>{
 const allowed=req=>{const origin=req.headers.origin;return req.headers['x-hub']==='1'&&(!origin||[`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin));};
 return {
 read:{matches:(req,url)=>req.method==='GET'&&['/api/token-usage','/api/token-usage/alerts'].includes(url.pathname),handle(req,res,url){if(!allowed(req))return send(res,403,{error:'forbidden'});return send(res,200,url?.pathname.endsWith('/alerts')?tokenUsage.badge():tokenUsage.status());}},
 write:{matches:(req,url)=>req.method==='POST'&&['/api/token-usage/limits','/api/token-usage/acknowledge','/api/token-usage/acknowledge-all'].includes(url.pathname),handle(req,res,url,b){if(!allowed(req))return send(res,403,{error:'forbidden'});try{const out=url.pathname.endsWith('/limits')?tokenUsage.setLimits(b?.limits,b?.revision):url.pathname.endsWith('/acknowledge-all')?tokenUsage.acknowledgeAll(b?.token):tokenUsage.acknowledge(b?.id,b?.total);return send(res,200,out);}catch{return send(res,409,{error:'token_usage_settings_conflict'});}}}
 };
};
