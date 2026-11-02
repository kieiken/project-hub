'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http'), crypto=require('node:crypto');
const {LocalAuth,readOwner,capability,mac}=require('../lib/local-auth'), {rawRequest}=require('./local-auth-client.cjs');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-owner-spec-')), root=path.join(tmp,'workspace');
let server,sessions,localAuth,port=51000+Math.floor(Math.random()*1000);
function call(route,{method='GET',headers={},body}={}) {return new Promise((resolve,reject)=>{const req=rawRequest({hostname:'127.0.0.1',port,path:route,method,headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));});req.on('error',reject);req.end(body);});}
function browserSession(html) { const encoded=html.match(/sessionStorage\.setItem\("hub-local-session",("(?:\\.|[^"\\])*")\)/);assert.ok(encoded,'launch bootstrap');return JSON.parse(JSON.parse(encoded[1])); }
const owned=(headers={})=>({'X-Hub':'1','X-Hub-Token':capability(localAuth.token),...headers});
test.before(async()=>{fs.mkdirSync(root,{recursive:true});Object.assign(process.env,{HUB_ROOT:root,HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(tmp,'ai'),HUB_PORT:String(port)});({server,sessions,localAuth}=require('../server'));await new Promise(r=>server.listen(port,'127.0.0.1',r));port=server.address().port;});
test.after(async()=>{sessions.stopAll();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
test('all read/write API entry points require owner; minimal ping has no configuration',async()=>{
 assert.deepEqual(Object.keys((await call('/api/ping')).json()).sort(),['instance','ok']);
 for(const route of ['/api/state','/api/mcp/tools','/api/file/view?path=x.txt','/api/term/stream','/api/chat/stream','/api/move/status','/api/remote/enrollment','/api/not-a-route']) {
  assert.equal((await call(route)).status,401,route);assert.equal((await call(route,{method:'POST',headers:{'X-Hub':'1'},body:'{}'})).status,401,route);
 }
 assert.equal((await call('/')).status,200);assert.ok(!(await call('/')).text.includes('sessionStorage.setItem'));assert.equal((await call('/api/ping',{headers:owned()})).json().pid,process.pid);
 assert.equal((await call('/api/state',{headers:owned()})).status,200);
 assert.equal((await call('/api/state',{headers:owned({'X-Hub-Token':'forged'})})).status,401);
 assert.equal((await call('/api/state',{headers:owned({Host:'evil.test'})})).status,403);
 assert.equal((await call('/api/state',{method:'POST',headers:owned({Origin:'https://evil.test'}),body:'{}'})).status,403);
});
test('cookie, nonce-bound identity, one-use launch POST and document proof',async()=>{
 const challenge=crypto.randomBytes(24).toString('hex'),ping=(await call('/api/ping?challenge='+challenge)).json();
 assert.equal(ping.proof,mac(localAuth.token,challenge,ping.instance,port));
 const ticket=(await call('/api/local-auth/launch',{method:'POST',headers:owned(),body:'{}'})).json().ticket;
 const result=await call('/local-auth',{method:'POST',headers:{Origin:'null','Content-Type':'application/x-www-form-urlencoded'},body:'ticket='+ticket});
 assert.equal(result.status,200);const browser=browserSession(result.text);assert.ok(!result.text.includes(capability(localAuth.token)));assert.ok(!result.text.includes(localAuth.token));const cookie=result.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
 assert.match(cookie,/Max-Age=28800/);assert.equal((await call('/api/state',{headers:{Cookie:cookie.split(';')[0]}})).status,401);assert.equal((await call('/api/state',{headers:{'X-Hub-Token':browser.token}})).status,200);
 assert.equal((await call('/api/state',{headers:{Cookie:cookie.split(';')[0].replace(`hub_owner_${port}=`,`hub_owner_${port+1}=`)}})).status,401);
 assert.equal((await call('/local-auth',{method:'POST',body:'ticket='+ticket})).status,403);
 const page=await call('/',{headers:owned({'X-Hub-Navigation':challenge})});assert.equal(page.status,200);assert.equal(page.headers['x-hub-proof'],ping.proof);assert.equal(page.headers['cache-control'],'no-store');
});
test('private run files and symlink aliases are denied by authenticated file viewer',async()=>{
 for(const file of [localAuth.headersFile,localAuth.file]) assert.ok([403,404].includes((await call('/api/file/view?path='+encodeURIComponent(file),{headers:owned()})).status));
 const alias=path.join(root,'owner.txt');fs.symlinkSync(localAuth.headersFile,alias);assert.equal((await call('/api/file/view?path='+encodeURIComponent(alias),{headers:owned()})).status,403);
});
test('cookie captured on another loopback port cannot read or write owner APIs',async()=>{
 const launch=await call('/local-auth',{method:'POST',body:'ticket='+localAuth.issue()});
 const cookie=launch.headers['set-cookie'][0].split(';')[0];let captured;
 const other=http.createServer((req,res)=>{captured=req.headers.cookie;res.end('fixture');});
 await new Promise(r=>other.listen(0,'127.0.0.1',r));
 try {
  await new Promise((resolve,reject)=>{const req=rawRequest({hostname:'127.0.0.1',port:other.address().port,path:'/',headers:{Cookie:cookie}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.end();});
  assert.equal(captured,cookie);
  for(const route of ['/api/state','/api/local-auth/launch','/api/chat/send']) {
   const result=await call(route,{method:route==='/api/state'?'GET':'POST',headers:{Cookie:captured,'X-Hub':'1'},body:route==='/api/state'?undefined:'{}'});
   assert.equal(result.status,401,route);
  }
  const page=await call('/',{headers:{Cookie:captured}});assert.ok(!page.text.includes('sessionStorage.setItem'));
  const second=await call('/local-auth',{method:'POST',body:'ticket='+localAuth.issue()});
  assert.notEqual(second.headers['set-cookie'][0],launch.headers['set-cookie'][0]);
  assert.notEqual(browserSession(second.text).token,browserSession(launch.text).token);
 } finally {await new Promise(r=>other.close(r));}
});
test('headerless resource grants are GET-only, route-limited, expiring and distinct from API credentials',async()=>{
 const session=localAuth.browserSession(),grant=session.resources['/api/file/view'];
 const url='/api/file/view?path=absent.txt&hubResource='+grant;
 assert.ok([400,403,404].includes((await call(url)).status));
 assert.equal((await call('/api/state?hubResource='+grant)).status,401);
 assert.equal((await call('/api/chat/stream?hubResource='+grant)).status,401);
 assert.equal((await call(url,{method:'POST',headers:{'X-Hub':'1'},body:'{}'})).status,401);
 assert.equal((await call('/api/state',{headers:{'X-Hub-Token':grant}})).status,401);
 assert.equal((await call('/api/state?hubResource='+session.token)).status,401);
 for(const route of require('../lib/local-auth').RESOURCE_PATHS) {
  const grant=session.resources[route];assert.equal(localAuth.authenticated({method:'GET',url:route+'?hubResource='+grant,headers:{}}),true,route);
  assert.equal(localAuth.authenticated({method:'POST',url:route+'?hubResource='+grant,headers:{}}),false,route);
 }
 let now=1000;const auth=new LocalAuth({now:()=>now,dir:path.join(tmp,'expiry')});auth.activate(45689);
 try {const value=auth.browserSession();assert.equal(auth.authenticated({headers:{'x-hub-token':value.token}}),true);now=value.expires;assert.equal(auth.authenticated({headers:{'x-hub-token':value.token}}),false);assert.equal(auth.authenticated({method:'GET',url:'/api/file/view?hubResource='+value.resources['/api/file/view'],headers:{}}),false);}finally{auth.close();process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('launch bootstrap plus the actual browser transport can read and write without a cookie',async()=>{
 const vm=require('node:vm'),values=new Map(),origin=`http://127.0.0.1:${port}`;
 const context={URL,Headers,Date,location:{href:origin+'/',hostname:'127.0.0.1',origin,replace:value=>{context.destination=value;}},sessionStorage:{setItem:(key,value)=>values.set(key,value),getItem:key=>values.get(key)},fetch:async(input,options={})=>call(new URL(input,origin).pathname,{method:options.method,headers:Object.fromEntries(new Headers(options.headers)),body:options.body})};context.window=context;
 const launch=await call('/local-auth',{method:'POST',body:'ticket='+localAuth.issue()});
 for(const match of launch.text.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInNewContext(match[1],context);
 assert.equal(context.destination,'/');
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/local-auth.js'),'utf8'),context);
 assert.equal((await context.fetch('/api/state')).status,200);
 assert.equal((await context.fetch('/api/local-auth/launch',{method:'POST',headers:{'X-Hub':'1'},body:'{}'})).status,200);
 const native=await call('/',{headers:owned()});assert.ok(native.text.indexOf('sessionStorage.setItem')<native.text.indexOf('src="local-auth.js"'));
 assert.notEqual(browserSession(native.text).token,JSON.parse(values.get('hub-local-session')).token);
});
test('strict permissions, cold rotation, controlled restart inheritance, normal cleanup',()=>{
 const dir=path.join(tmp,'lifecycle'),a=new LocalAuth({dir,root});a.activate(45678);assert.equal(fs.statSync(a.file).mode&0o777,0o600);assert.equal(fs.statSync(dir).mode&0o777,0o700);
 const env=a.restartEnv();assert.deepEqual(env,{HUB_AUTH_DIR:dir});assert.ok(!JSON.stringify(env).includes(a.token));a.close();assert.ok(fs.existsSync(a.file));const b=new LocalAuth({dir,root});process.env.HUB_AUTH_RESTART="obsolete-env-must-be-discarded";b.activate(45678);assert.equal(b.token,a.token);assert.equal(process.env.HUB_AUTH_RESTART,undefined);
 b.restartEnv();b.close();delete process.env.HUB_AUTH_RESTART;const relaunched=new LocalAuth({dir,root});relaunched.activate(45678);assert.equal(relaunched.token,b.token);assert.equal(readOwner(45678,dir).restart,undefined);
 const c=new LocalAuth({dir,root});c.activate(45678);assert.notEqual(c.token,b.token);fs.chmodSync(c.file,0o644);assert.throws(()=>readOwner(45678,dir),/permissions/);fs.chmodSync(c.file,0o600);c.close();assert.equal(fs.existsSync(c.file),false);
 const linked=path.join(tmp,'linked');fs.symlinkSync(dir,linked);assert.throws(()=>new LocalAuth({dir:linked}).activate(45679),/symlink/);
 process.env.HUB_AUTH_DIR=localAuth.dir;process.env.HUB_HEADERS=localAuth.headersFile;
});
test('expired launch rejected; browser helper rejects fake Hub before sharing capability',async()=>{
 let now=1000;const a=new LocalAuth({now:()=>now}),ticket=a.issue();now+=60001;assert.equal(a.consume(ticket),false);
 const fake=http.createServer((req,res)=>{assert.equal(req.headers['x-hub-token'],undefined);res.end(JSON.stringify({instance:'fake',proof:'00'}));});await new Promise(r=>fake.listen(0,'127.0.0.1',r));const p=fake.address().port, auth=new LocalAuth({dir:localAuth.dir,root});auth.activate(p);
 try{await assert.rejects(require('../app/open-browser.cjs').verify(p),/unverified_hub/);}finally{auth.close();await new Promise(r=>fake.close(r));process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('browser launch writes private one-time POST document without owner secret',async()=>{
 let opened;const launch=await require('../app/open-browser.cjs').launch(port,file=>{opened=file;});try{const html=fs.readFileSync(opened,'utf8');assert.match(html,/method="post"/);assert.ok(!html.includes(localAuth.token));assert.ok(!html.includes(capability(localAuth.token)));assert.equal(fs.statSync(opened).mode&0o777,0o600);const ticket=html.match(/name="ticket" value="([a-f0-9]+)"/)[1];assert.ok(localAuth.consume(ticket));assert.equal(localAuth.consume(ticket),false);}finally{launch.cleanup();}
});
test('migration boot protects reads and supports file-origin one-time launch',async()=>{
 const auth=new LocalAuth({dir:localAuth.dir,root}),migration=require('../lib/move-boot').serve({root,status:()=>({mode:'conflict'})},{auth});await new Promise(r=>migration.listen(0,'127.0.0.1',r));const savedPort=port;port=migration.address().port;
 try{assert.equal((await call('/api/move/status')).status,401);assert.equal((await call('/api/ping')).json().pid,undefined);const ticket=auth.issue();const launch=await call('/local-auth',{method:'POST',headers:{Origin:'null'},body:'ticket='+ticket});assert.equal(launch.status,200);const browser=browserSession(launch.text);assert.equal((await call('/api/move/status',{headers:{Cookie:auth.cookie().split(';')[0]}})).status,401);assert.equal((await call('/api/move/status',{headers:{'X-Hub-Token':browser.token}})).status,200);const page=await call('/',{headers:{'X-Hub-Token':capability(auth.token)}});assert.ok(page.text.includes('hub-local-session'));assert.ok(page.text.includes('window.fetch'));}finally{port=savedPort;await new Promise(r=>migration.close(r));process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('migration restart preserves owner capability before close, with no actual process or app launch',async()=>{
 const auth=new LocalAuth({dir:localAuth.dir,root});let mode='conflict',done;
 const restarted=new Promise(resolve=>done=resolve),move={root,status:()=>({mode}),import:async()=>{mode='none';}};
 const migration=require('../lib/move-boot').serve(move,{auth,restart:done});await new Promise(r=>migration.listen(0,'127.0.0.1',r));const savedPort=port;port=migration.address().port;
 try {
  const result=await call('/api/move/import',{method:'POST',headers:{'X-Hub':'1','X-Hub-Token':capability(auth.token)},body:'{"action":"skip"}'});assert.equal(result.status,202);
  await restarted;assert.equal(readOwner(port,auth.dir).restart,true);
  const next=new LocalAuth({dir:auth.dir,root});next.activate(port);assert.equal(next.token,auth.token);next.close();
 }finally{if(migration.listening)await new Promise(r=>migration.close(r));port=savedPort;process.env.HUB_AUTH_DIR=localAuth.dir;process.env.HUB_HEADERS=localAuth.headersFile;}
});

test('instance-bound cookies expire on controlled restart while internal API capabilities survive',()=>{
 const dir=path.join(tmp,'cookie-generations'),a=new LocalAuth({dir,root});a.activate(45680);
 const cookie=a.cookie().split(';')[0],request={headers:{cookie}};
 assert.equal(a.authenticated(request),false);const browser=a.browserSession();assert.equal(a.authenticated({headers:{'x-hub-token':browser.token}}),true);a.restartEnv();a.close();
 const b=new LocalAuth({dir,root});b.activate(45680);
 try{
  assert.equal(b.token,a.token);assert.notEqual(b.cookie(),a.cookie());
  assert.equal(b.authenticated(request),false);
  assert.equal(b.authenticated({headers:{cookie:b.cookie().split(';')[0]}}),false);assert.equal(b.authenticated({headers:{'x-hub-token':browser.token}}),false);
  assert.equal(b.authenticated({headers:{'x-hub-token':capability(a.token)}}),true);
  const other=new LocalAuth({dir,root});other.activate(45681);
  try{assert.equal(other.authenticated(request),false);}finally{other.close();}
 }finally{b.close();process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('expired restart markers rotate secrets and corrupt private records recover with atomic publication',()=>{
 let now=1000;const dir=path.join(tmp,'stale-record'),a=new LocalAuth({dir,root,now:()=>now});a.activate(45682);a.restartEnv();a.close();now+=30001;
 const b=new LocalAuth({dir,root,now:()=>now});b.activate(45682);assert.notEqual(b.token,a.token);b.close();
 fs.writeFileSync(b.file,'{broken',{mode:0o600});const c=new LocalAuth({dir,root});c.activate(45682);
 assert.equal(readOwner(45682,dir).instance,c.instance);c.close();
 fs.writeFileSync(c.file,'null',{mode:0o600});c.activate(45682);assert.equal(readOwner(45682,dir).instance,c.instance);c.close();
 const oldRename=fs.renameSync;let publications=0;
 fs.renameSync=(from,to)=>{if(to===c.file){assert.match(from,/\.tmp$/);assert.equal(fs.existsSync(to),false);assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(from,'utf8')));publications++;}return oldRename(from,to);};
 try{c.activate(45682);assert.equal(publications,1);}finally{fs.renameSync=oldRename;c.close();process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('auth startup failure closes only its test server without an unhandled listening exception',async()=>{
 const fake=http.createServer((req,res)=>res.end());
 fake.on('listening',()=>require('../lib/local-auth').activateServer({activate(){throw Error('fixture_auth_error');}},fake));
 await new Promise(resolve=>{fake.once('close',resolve);fake.listen(0,'127.0.0.1');});
 assert.equal(fake.listening,false);assert.match(fake.authError.message,/fixture_auth_error/);
});
test('migration restart record failure keeps the server alive and does not launch a process',async()=>{
 const auth=new LocalAuth({dir:localAuth.dir,root});let restarted=false;
 const migration=require('../lib/move-boot').serve({root,status:()=>({mode:'none'}),import:async()=>{}},{auth,restart:()=>{restarted=true;}});
 await new Promise(r=>migration.listen(0,'127.0.0.1',r));const savedPort=port;port=migration.address().port;
 try {
  auth.restartEnv=()=>{throw Error('owner_restart_changed');};
  assert.equal((await call('/api/move/import',{method:'POST',headers:{'X-Hub':'1','X-Hub-Token':capability(auth.token)},body:'{"action":"skip"}'})).status,202);
  const deadline=Date.now()+1500;while(!migration.restartError&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.match(migration.restartError?.message||'',/owner_restart_changed/);assert.equal(migration.listening,true);assert.equal(restarted,false);
  const status=await call('/api/move/status',{headers:{'X-Hub-Token':capability(auth.token)}});assert.equal(status.status,200);assert.equal(status.json().mode,'none');assert.match(status.json().error,/開き直す準備に失敗/);
  assert.ok(require('../lib/move-boot').page().includes("if(!s.error&&(s.mode==='imported'||s.mode==='none'))"));
 }finally{port=savedPort;await new Promise(r=>migration.close(r));process.env.HUB_HEADERS=localAuth.headersFile;}
});
test('main restart owner-record failure is handled before detaching chats or closing the backend',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const start=source.indexOf('    setTimeout(async()=>{',source.indexOf('restartControl = new'));
 const end=source.indexOf('\n    },200);',start);assert.ok(start>0&&end>start);
 let closed=false,detached=false,cleaned=false,scheduled,records=[];
 const ctx={setTimeout:fn=>{scheduled=fn;},localAuth:{restartEnv(){throw Error('owner_restart_changed');}},
 chats:{withStrictHandoff:fn=>fn(),detachChecked:()=>{detached=true;}},stopControl:{cleanExit:()=>{cleaned=true;}},
 emergencyRestart:{verifyCommitted(){},fail(){}},mainMergeFlow:{verifyRestart(){}},restartBlockers:()=>[],restartControl:{committed:true},
 record:(...args)=>records.push(args),server:{close:()=>{closed=true;}}};
 vm.runInNewContext(source.slice(start,end)+'\n    },200);',ctx);await scheduled();
 assert.equal(closed,false);assert.equal(detached,false);assert.equal(cleaned,false);assert.equal(ctx.restartControl.committed,false);assert.equal(ctx.restartControl.error,'owner_restart_changed');assert.equal(records[0][0],'restart-handoff-error');
});
test('production delegation and all browser launchers use header files or private launch tickets',()=>{
 // Deliberately inspect generated instructions, without the automatic HTTP test helper.
 const policy=require('../paid/delegate/policy')({lt:(first,...values)=>Array.isArray(first)?String.raw({raw:first},...values):first,roles:{delegateSlot:()=>({ai:'codex',model:'gpt-6.1-sol'})},executionRoles:()=>({}),PORT:port})({id:'sample'},{id:'sample-01'});
 assert.ok(policy.includes('-H @"$HUB_HEADERS"'));assert.ok(policy.includes('curl.exe'));assert.ok(policy.includes('-H "@$env:HUB_HEADERS"'));assert.ok(!policy.includes("-H 'X-Hub: 1'"));
 assert.ok(policy.includes('--data-binary \"@$bodyFile\"'));assert.ok(policy.includes('ConvertTo-Json -Compress'));
 assert.ok(policy.includes('[System.IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))'));
 assert.ok(policy.includes('finally { Remove-Item -LiteralPath $bodyFile -Force }'));
 const windows=policy.slice(policy.indexOf('$body ='),policy.indexOf('finally { Remove-Item -LiteralPath $bodyFile -Force }')+65);assert.ok(!windows.includes(" -d '"));
 for(const file of ['start.bat','start.cmd']){
  const text=fs.readFileSync(path.join(__dirname,'..',file),'utf8');if(file==='start.cmd')assert.match(text,/start-windows\.js/);else {assert.match(text,/open-browser\.cjs --wait/);assert.match(text,/node server\.js/);assert.doesNotMatch(text,/start-windows\.js|HUB_ROOT=/);}assert.doesNotMatch(text,/start "" "%URL%"|FileProtocolHandler|\/api\/ping/);
 }
 for(const file of ['start.command','app/run.sh','start-windows.js']){
  const text=fs.readFileSync(path.join(__dirname,'..',file),'utf8');assert.match(text,/open-browser\.cjs/);
 }
});

test('native cookie attributes and loopback rule expressions work without opening a window',()=>{
 const cp=require('node:child_process'),source=fs.readFileSync(path.join(__dirname,'../app/window.swift'),'utf8');
 const ownerSource=source.slice(source.indexOf('struct LocalOwner {'),source.indexOf('// BEGIN PACKAGED RECOVERY'));
 const start=source.indexOf('        var rules: [[String: Any]] = []',source.indexOf('func installLoopbackRules'));
 const end=source.indexOf('        guard let data =',start);assert.ok(start>0&&end>start);
 const dir=path.join(tmp,'native-fixture');fs.mkdirSync(dir,{mode:0o700});
 const token=crypto.randomBytes(32).toString('hex'),instance='fixture-instance',port=45683;
 fs.writeFileSync(path.join(dir,`owner-${port}.json`),JSON.stringify({token,port}),{mode:0o600});

 const fragmentFunctions=['app/window.swift','staging-app/Window.swift'].map((file,index)=>{
  const text=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const start=text.indexOf(index===0?'        if let u = a.request.url, a.targetFrame?.isMainFrame == true, let current = w.url,':'        if let current = webView.url, pageInstance != nil,');
  const end=text.indexOf(index===0?'        if let u = a.request.url, let host':'        DispatchQueue.global().async {',start);assert.ok(start>0&&end>start);
  return `func fragmentAllowed${index}(_ method:String, _ destination:String, _ origin:String, _ verified:Bool = true, _ navigationType:FixtureNavigation = .linkActivated)->Bool {
 var allowed=false
 let pageInstance:String? = verified ? "fixture" : nil
 var request=URLRequest(url:URL(string:destination)!);request.httpMethod=method
 let a=FixtureAction(request:request,targetFrame:FixtureFrame(isMainFrame:true),navigationType:navigationType), action=a
 let w=FixtureView(url:URL(string:origin)), webView=w
 let u=request.url!
 let decisionHandler:(FixturePolicy)->Void = {_ in allowed=true}
 func decide() {
 ${text.slice(start,end)}
 }
 decide();return allowed
}
precondition(fragmentAllowed${index}("GET","http://127.0.0.1:${port}/#b","http://127.0.0.1:${port}/#a"))
precondition(fragmentAllowed${index}("GET","http://127.0.0.1:${port}/#a","http://127.0.0.1:${port}/#a"))
precondition(!fragmentAllowed${index}("GET","http://127.0.0.1:${port}/#a","http://127.0.0.1:${port}/#a",true,.reload))
precondition(!fragmentAllowed${index}("POST","http://127.0.0.1:${port}/#a","http://127.0.0.1:${port}/#a"))
precondition(!fragmentAllowed${index}("GET","http://127.0.0.1:${port}/","http://127.0.0.1:${port}/#a"))
precondition(!fragmentAllowed${index}("POST","http://127.0.0.1:${port}/#b","http://127.0.0.1:${port}/#a"))
precondition(!fragmentAllowed${index}("POST","http://127.0.0.1:${port}/","http://127.0.0.1:${port}/"))
precondition(!fragmentAllowed${index}("GET","http://127.0.0.1:${port}/?changed#b","http://127.0.0.1:${port}/#a"))
precondition(!fragmentAllowed${index}("GET","http://127.0.0.1:${port}/#b","http://127.0.0.1:${port}/#a",false))`;
 }).join('\n');
 const body=`import Foundation\nimport CryptoKit\n${ownerSource}\nlet baseURL=URL(string:"http://127.0.0.1:${port}/")!\n${source.slice(start,end)}\n
let owner=LocalOwner(port:${port})
guard let cookie=owner.cookie(instance:"${instance}") else { fatalError("cookie absent") }
precondition(cookie.isHTTPOnly && cookie.sameSitePolicy == .sameSiteLax)
precondition(cookie.value != owner.cookie(instance:"${instance}")!.value)
precondition(cookie.expiresDate != nil)
func blocked(_ url:String)->Bool {
 var blocked=false
 for rule in rules {
  let trigger=rule["trigger"] as! [String:String], action=rule["action"] as! [String:String]
  if url.range(of:trigger["url-filter"]!,options:.regularExpression) != nil { blocked = action["type"] == "block" }
 }
 return blocked
}
precondition(!blocked("http://127.0.0.1:${port}/api/state"))
for url in ["http://127.0.0.1:${port+1}/", "http://127.0.0.1:${port+1}/app.js", "http://localhost:${port+1}/x", "http://[::1]:${port+1}/x", "http://127.0.0.1:${port}0/"] { precondition(blocked(url)) }
enum FixturePolicy { case allow }
struct FixtureFrame { var isMainFrame:Bool }
enum FixtureNavigation { case linkActivated, reload }
struct FixtureAction { var request:URLRequest; var targetFrame:FixtureFrame?; var navigationType:FixtureNavigation }
struct FixtureView { var url:URL? }
${fragmentFunctions}
print("native auth fixture passed")`;
 const swift=path.join(dir,'fixture.swift'),binary=path.join(dir,'fixture');fs.writeFileSync(swift,body);
 cp.execFileSync('swiftc',[swift,'-o',binary],{timeout:60000});
 assert.match(cp.execFileSync(binary,{encoding:'utf8',timeout:10000,env:{...process.env,HUB_AUTH_DIR:dir}}),/native auth fixture passed/);
});


test('legacy Windows launcher waits only for verified readiness and never changes the workspace',async()=>{
 let now=0,attempts=0;const {waitForOwner}=require('../app/open-browser.cjs');
 const result=await waitForOwner(4545,{now:()=>now,pause:async ms=>{now+=ms;},check:async()=>{if(++attempts<3)throw Error('not yet verified');return {pid:123};}});
 assert.equal(result.pid,123);assert.equal(attempts,3);
 await assert.rejects(waitForOwner(4545,{now:()=>now,pause:async ms=>{now+=ms;},timeout:1000,check:async()=>{throw Error('fake');}}),/owner_startup_timeout/);
});

test('both Mac shells compile their actual loopback rules using WebKit without a web view',()=>{
 const cp=require('node:child_process');
 for(const [file,baseName,port] of [['app/window.swift','baseURL',45684],['staging-app/Window.swift','base',4587]]) {
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const start=source.indexOf('        var rules: [[String: Any]] = []',source.indexOf('func installLoopbackRules'));
  const end=source.indexOf('        guard let data =',start);assert.ok(start>0&&end>start);
  const dir=fs.mkdtempSync(path.join(tmp,'webkit-compile-'));
  const swift=path.join(dir,'rules.swift'),binary=path.join(dir,'rules');
  fs.writeFileSync(swift,`import Foundation
import WebKit
let ${baseName}=URL(string:"http://127.0.0.1:${port}/")!
${source.slice(start,end)}
precondition(rules.count == 26)
func blocked(_ url:String)->Bool {
 var result=false
 for rule in rules {
  let trigger=rule["trigger"] as! [String:String], action=rule["action"] as! [String:String]
  if url.range(of:trigger["url-filter"]!,options:.regularExpression) != nil { result = action["type"] == "block" }
 }
 return result
}
precondition(!blocked("http://127.0.0.1:${port}/api/state"))
precondition(!blocked("https://example.invalid/image.png"))
for scheme in ["http","https","ws","wss"] {
 for host in ["127.0.0.1","localhost.","a.localhost","a.b.localhost.","[::1]","[::ffff:127.0.0.1]","[::ffff:7f00:1]"] {
  precondition(blocked("\\(scheme)://\\(host):${port+1}/image.png"))
  precondition(blocked("\\(scheme)://name:password@\\(host):${port+1}/image.png"))
 }
}
precondition(blocked("http://name@127.0.0.1:${port}/image.png"))
precondition(blocked("http://name@127.0.0.1:${port+1}/image.png"))
let json=String(data:try JSONSerialization.data(withJSONObject:rules),encoding:.utf8)!
let store=WKContentRuleListStore(url:URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true))!
var finished=false
var failure:String?
store.compileContentRuleList(forIdentifier:"HubLoopbackFixture",encodedContentRuleList:json) { list,error in
 if list == nil || error != nil { failure=String(describing:error) }
 finished=true
}
let deadline=Date(timeIntervalSinceNow:15)
while !finished && Date() < deadline { RunLoop.main.run(until:Date(timeIntervalSinceNow:0.02)) }
precondition(finished,"WebKit compilation timeout")
precondition(failure == nil,"WebKit rejected actual shell rules: \\(failure ?? "")")
print("WebKit compiled shell rules")`);
  cp.execFileSync('swiftc',[swift,'-o',binary],{timeout:60000});
  const store=path.join(dir,'store');fs.mkdirSync(store);
  assert.match(cp.execFileSync(binary,[store],{encoding:'utf8',timeout:25000}),/WebKit compiled shell rules/);
 }
});

test('offscreen WebKit blocks credential-bearing loopback resources with both shell rule lists',async t=>{
 const cp=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(tmp,'webkit-resources-'));
 let ownHits=0,sinkHits=[];
 const sink=http.createServer((req,res)=>{sinkHits.push({url:req.url,cookie:req.headers.cookie});res.end('fixture');});
 sink.on('upgrade',(req,socket)=>{sinkHits.push({url:req.url,cookie:req.headers.cookie});socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 await new Promise(r=>sink.listen(0,'127.0.0.1',r));const sinkPort=sink.address().port;
 const origin=http.createServer((req,res)=>{
  if(req.url==='/ok'){ownHits++;res.end('fixture');return;}
  const targets=[`http://name@127.0.0.1:${sinkPort}/credentials`,`http://127.0.0.1:${sinkPort}/plain`,`http://localhost.:${sinkPort}/dot`,`http://a.localhost:${sinkPort}/subdomain`,`http://[::ffff:127.0.0.1]:${sinkPort}/mapped`];
  const sockets=[`ws://name@127.0.0.1:${sinkPort}/credentials-ws`,`ws://127.0.0.1:${sinkPort}/plain-ws`];
  res.setHeader('Content-Type','text/html');res.end(`<script>
  function image(url){return new Promise(resolve=>{const i=new Image();i.onload=i.onerror=resolve;i.src=url;setTimeout(resolve,2500);});}
  function socket(url){return new Promise(resolve=>{try{const w=new WebSocket(url);w.onopen=()=>{w.close();resolve();};w.onerror=w.onclose=resolve;setTimeout(()=>{w.close();resolve();},1200);}catch{resolve();}});}
  Promise.all([image('/ok'),...${JSON.stringify(targets)}.map(image),...${JSON.stringify(sockets)}.map(socket)]).then(()=>window.webkit.messageHandlers.done.postMessage('done'));
  </script>`);
 });
 await new Promise(r=>origin.listen(0,'127.0.0.1',r));const originPort=origin.address().port;
 try {
  const blocks=['app/window.swift','staging-app/Window.swift'].map((file,index)=>{
   const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),start=source.indexOf('        var rules: [[String: Any]] = []',source.indexOf('func installLoopbackRules')),end=source.indexOf('        guard let data =',start);
   assert.ok(start>0&&end>start);
   const name=index===0?'baseURL':'base';
   return `func shellRules${index}()->[[String:Any]] { let ${name}=URL(string:"http://127.0.0.1:${originPort}/")!\n${source.slice(start,end)}\nreturn rules }`;
  }).join('\n');
  const swift=path.join(dir,'resources.swift'),binary=path.join(dir,'resources');
  fs.writeFileSync(swift,`import AppKit
import WebKit
${blocks}
class Done:NSObject,WKScriptMessageHandler,WKNavigationDelegate {
 var finished=false
 var networkDenied=false
 func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) {
  let outer=error as NSError
  let underlying=outer.userInfo[NSUnderlyingErrorKey] as? NSError
  if underlying?.domain == NSPOSIXErrorDomain && underlying?.code == 1 { networkDenied=true;return }
  fatalError("fixture navigation failed: \\(error)")
 }
 func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) { finished=true }
}
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)
let mode=CommandLine.arguments[1]
let config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let done=Done()
config.userContentController.add(done,name:"done")
var ready = mode == "control"
if !ready {
 let rules = mode == "0" ? shellRules0() : shellRules1()
 let store=WKContentRuleListStore(url:URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true))!
 let json=String(data:try JSONSerialization.data(withJSONObject:rules),encoding:.utf8)!
 store.compileContentRuleList(forIdentifier:"Fixture",encodedContentRuleList:json) { list,error in
  precondition(error == nil && list != nil,"rule compilation failed")
  config.userContentController.add(list!);ready=true
 }
}
let deadline=Date(timeIntervalSinceNow:15)
while !ready && Date()<deadline { RunLoop.main.run(until:Date(timeIntervalSinceNow:0.02)) }
precondition(ready,"compile timeout")
let web=WKWebView(frame:NSRect(x:0,y:0,width:640,height:480),configuration:config)
web.navigationDelegate=done
let cookie=HTTPCookie(properties:[.domain:"127.0.0.1",.path:"/",.name:"fixture_owner",.value:"dummy-only",.init("HttpOnly"):"TRUE",.sameSitePolicy:HTTPCookieStringPolicy.sameSiteLax.rawValue])!
config.websiteDataStore.httpCookieStore.setCookie(cookie) { web.load(URLRequest(url:URL(string:"http://127.0.0.1:${originPort}/")!)) }
while !done.finished && !done.networkDenied && Date()<deadline { RunLoop.main.run(until:Date(timeIntervalSinceNow:0.02)) }
if done.networkDenied { print("WEBKIT_LOCAL_NETWORK_UNAVAILABLE");exit(0) }
precondition(done.finished,"resource checks timeout")
web.stopLoading()
config.userContentController.removeScriptMessageHandler(forName:"done")
print("offscreen resources finished")`);
  cp.execFileSync('swiftc',[swift,'-o',binary],{timeout:60000});
  for(const mode of ['control','0','1']) {
   ownHits=0;sinkHits=[];const store=path.join(dir,'store-'+mode);fs.mkdirSync(store);
   const stdout=await new Promise((resolve,reject)=>cp.execFile(binary,[mode,store],{encoding:'utf8',timeout:25000},(error,out,err)=>error?reject(Object.assign(error,{nativeStderr:err,message:error.message+'; ownHits='+ownHits+'; sinkHits='+JSON.stringify(sinkHits)})):resolve(out)));
   if(mode==='control'&&stdout.includes('WEBKIT_LOCAL_NETWORK_UNAVAILABLE')){t.skip('OS isolation denies native WebKit local networking (EPERM); actual resource matching remains unverified');return;}
   assert.match(stdout,/offscreen resources finished/);assert.equal(ownHits,1,'own origin must still load');
   if(mode==='control')assert.ok(sinkHits.some(hit=>hit.url==='/credentials'&&hit.cookie?.includes('fixture_owner=dummy-only')),'baseline must reproduce cookie delivery');
   else assert.deepEqual(sinkHits,[],'no blocked image or WebSocket may reach the other port');
  }
 }finally{origin.closeAllConnections();sink.closeAllConnections();await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>sink.close(r))]);}
});

test('Tailscale lookups share in-flight work, cache absence, and recover renamed remote hosts',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const start=source.indexOf('let tsCache ='),end=source.indexOf('// User delegation guidance',start);assert.ok(start>0&&end>start);
 let now=100000,lookups=0,callbacks=[];
 const ctx={Date:{now:()=>now},platform:{tailscaleCandidates:()=>['fixture-tailscale']},require:()=>({execFile:(bin,args,options,cb)=>{lookups++;callbacks.push(cb);}})};
 vm.runInNewContext(source.slice(start,end),ctx);
 const a=ctx.tailscaleUrl(),b=ctx.tailscaleUrl();assert.equal(a,b);assert.equal(lookups,1);
 callbacks.shift()(null,JSON.stringify({Self:{DNSName:'new.tail1234.ts.net.'}}));
 assert.equal(await a,'https://new.tail1234.ts.net');assert.equal(await b,await ctx.tailscaleUrl());assert.equal(lookups,1);
 const gateStart=source.indexOf('    if (remoteLib.isRemote(req)) {',source.indexOf('const server = http.createServer'));
 const gateEnd=source.indexOf('    const navigation =',gateStart);assert.ok(gateStart>0&&gateEnd>gateStart);
 const lib=require('../lib/remote');let queried=0,resumed=0;
 const check=async(saved,host,extra={})=>{
  const gate={URL,remoteLib:lib,remote:{load:()=>({host:saved})},req:{headers:{host,'x-forwarded-host':host,'x-forwarded-proto':'https','tailscale-user-login':'fixture-owner',...extra},resume:()=>{resumed++;}},res:{},tailscaleUrl:async()=>{queried++;return 'https://new.tail1234.ts.net';},send:()=>403};
  return vm.runInNewContext('(async()=>{'+source.slice(gateStart,gateEnd)+'return 200;})()',gate);
 };
 for(const stale of ['old.tail1234.ts.net','new.tail1234.ts.net:443',''])assert.equal(await check(stale,'new.tail1234.ts.net'),200);
 assert.equal(queried,3);
 assert.equal(await check('old.tail1234.ts.net','old.tail1234.ts.net'),200);assert.equal(queried,3);
 assert.equal(await check('old.tail1234.ts.net','other.tail1234.ts.net'),403);
 assert.equal(await check('old.tail1234.ts.net','new.tail1234.ts.net',{'tailscale-user-login':''}),403);assert.equal(queried,4);assert.equal(resumed,2);
 now+=60001;const empty=ctx.tailscaleUrl(),parallel=ctx.tailscaleUrl();assert.equal(empty,parallel);assert.equal(lookups,2);callbacks.shift()(null,'{}');assert.equal(await empty,'');assert.equal(await ctx.tailscaleUrl(),'');assert.equal(lookups,2);
 now+=60001;const recovered=ctx.tailscaleUrl();callbacks.shift()(null,JSON.stringify({Self:{DNSName:'new.tail1234.ts.net.'}}));assert.equal(await recovered,'https://new.tail1234.ts.net');
});

test('restart child environments drop even obsolete raw-secret variables without launching processes',async()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const start=source.indexOf('    setTimeout(async()=>{',source.indexOf('restartControl = new'));
 const end=source.indexOf('\n    },200);',start);let scheduled,env;
 const ctx={setTimeout:fn=>{scheduled=fn;},localAuth:{restartEnv:()=>({HUB_AUTH_DIR:'/fixture/private'})},
 chats:{withStrictHandoff:fn=>fn(),detachChecked(){}},stopControl:{cleanExit(){}},emergencyRestart:{verifyCommitted(){}},mainMergeFlow:{verifyRestart(){}},restartBlockers:()=>[],server:{close(){}},
 process:{platform:'darwin',env:{HUB_AUTH_RESTART:'discard-me',NORMAL:'retained'},execPath:'/fixture/node',exit(){}},__dirname:'/fixture/runtime',path,appUpdate:{restartNeeded:false,data:{}},
 require:()=>({spawn:(exe,args,options)=>{env=options.env;return {unref(){}};}})};
 vm.runInNewContext(source.slice(start,end)+'\n    },200);',ctx);await scheduled();
 assert.equal(env.HUB_AUTH_RESTART,undefined);assert.equal(env.HUB_AUTH_DIR,'/fixture/private');assert.equal(env.NORMAL,'retained');
 const migration=fs.readFileSync(path.join(__dirname,'../lib/move-boot.js'),'utf8');
 const from=migration.indexOf('  const again = restart || (() => {'),to=migration.indexOf('\n  const resume =',from);assert.ok(from>0&&to>from);
 let moved;
 vm.runInNewContext(migration.slice(from,to)+'\nagain();',{restart:null,restartEnvironment:{HUB_AUTH_DIR:'/fixture/private'},entry:'/fixture/runtime/server.js',path,process:ctx.process,spawn:(exe,args,options)=>{moved=options.env;return {unref(){}};}});
 assert.equal(moved.HUB_AUTH_RESTART,undefined);assert.equal(moved.NORMAL,'retained');assert.equal(moved.HUB_AUTH_DIR,'/fixture/private');
});
