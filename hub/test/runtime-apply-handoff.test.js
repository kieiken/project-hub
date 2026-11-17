'use strict';
// No live app, release build, publisher key or network. Compile only the two
// emitted JS modules; real signatures/packages and save admission use temp data.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module');
const compiler=require('../release-app/compile.cjs'),builder=require('../purchase-test-app/build.cjs');
const {ChatRunner}=require('../lib/chat'),zip=require('../lib/update-zip'),bootstrap=require('../release-app/mac-bootstrap.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const put=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
const source=fs.readFileSync(path.resolve(__dirname,'../purchase-test-app/update.cjs'),'utf8');
function compiled(text,file){const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(text,file);return m.exports;}
const api=compiled(compiler.update(source),path.resolve(__dirname,'../release-app/update.cjs'));
const server=builder.overlayServer(fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8'))
 .replaceAll('stagingApp','releaseApp').replaceAll('stagingLicense','releaseLicense').replaceAll('./purchase-test-app/','./release-app/');
// Execute the actual emitted updater wiring, including its complete busy callback.
const begin=server.indexOf('const appUpdate = releaseApp.createUpdater('),end=server.indexOf('\n',server.indexOf('appUpdate.strictBusy=',begin));
assert.ok(begin>0&&end>begin);
const wire=new Function('releaseApp','releaseLicense','legacyImport','VERSION','license','updateBusy','chats',server.slice(begin,end)+'\nreturn appUpdate;');
function fixture(t,platform,{version='4.126.98',target='4.126.101'}={}){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-runtime-apply-'));
 const origin=path.join(root,'original/hub'),app=path.join(root,'package'),arch=platform==='darwin'?'arm64':'x64',now=1800000000000;
 put(path.join(origin,'package.json'),JSON.stringify({version}));
 put(path.join(app,'hub/package.json'),JSON.stringify({version:target}));put(path.join(app,'hub/server.js'),'signed fixture, never executed');
 const files=['hub/package.json','hub/server.js'].map(p=>({path:p,mode:0o644,sha256:sha(fs.readFileSync(path.join(app,p)))}));
 put(path.join(app,'release-manifest.json'),JSON.stringify({platform,arch,releaseVersion:target,macShellGeneration:3,shellProtocol:1,files}));
 const key=crypto.generateKeyPairSync('ed25519'),trust={runtimeProtocol:1,feedUrl:'https://github.com/fixture/hub/releases/latest/download/feed.json',windowsFeedUrl:'https://github.com/fixture/hub/releases/latest/download/feed.json',assetPrefix:'https://github.com/fixture/hub/releases/download/',redirectHosts:[],revokedKids:[],keys:{fixture:{spkiB64:key.publicKey.export({type:'spki',format:'der'}).toString('base64'),purposes:['app-update']}}};
 const bytes=zip.pack(app),tree=zip.treeHash(app),name=`Project-Hub-${target}-Runtime-${platform==='darwin'?'Apple-Silicon':'Windows-x64'}.zip`;
 const manifest={v:1,typ:'hub-app-update',product:'project-hub',edition:'public',lang:'ja',version:target,seq:2026111702,kind:'bugfix',product_line:'project-hub-4.123',bugfixOf:['project-hub-4.123'],issuedAt:now/1000,expiresAt:now/1000+86400,requires:{os:platform,arch,node:'>=22',...(platform==='darwin'?{minMacOS:'13.0'}:{minWindows:'10.0.22000'})},asset:{name,size:bytes.length,sha256:sha(bytes),url:trust.assetPrefix+'v'+target+'/'+name},app:{format:'release-runtime-v1',shellProtocol:1,runtime:'hub',bundleId:'local.projecthub',shortVersion:target,treeSha256:tree.treeSha256,entries:tree.entries},notes:{ja:'isolated apply fixture'}};
 const sign=m=>{const b=Buffer.from(JSON.stringify(m));return {kid:'fixture',payload:b.toString('base64url'),sig:crypto.sign(null,b,key.privateKey).toString('base64url')};};
 const verifyPackage=(base,p)=>{const m=JSON.parse(fs.readFileSync(path.join(base,'release-manifest.json')));assert.equal(m.platform,p);for(const row of m.files){assert.equal(sha(fs.readFileSync(path.join(base,row.path))),row.sha256);assert.equal(fs.statSync(path.join(base,row.path)).mode&0o777,row.mode);}return m;};
 // JSON journal for both simulated platforms. Native Windows ACL/SQLite not claimed.
 const store=api.updateStore(root,'darwin'),options={trust,now,platform,arch,osVersion:platform==='darwin'?'15.0':'10.0.22631',node:'22.19.0',verifyPackage,originSha:'a'.repeat(64)};
 api.selectLaunch(store,origin,options);store.access(d=>({...d,macShellGeneration:3}));
 const spoolRoot=path.join(root,'_hub/cli-runs');fs.mkdirSync(spoolRoot,{recursive:true});const chats=new ChatRunner({spoolRoot});
 const f={root,origin,app,store,options,trust,manifest,sign,chats,ai:false,runtime:false,importer:{running:false},lifecycle:'idle',calls:[],now,bytes,envelope:sign(manifest)};
 for(const [name,value] of [['Product/P/chat.txt','synthetic retained conversation'],['_hub/settings.json','synthetic settings'],['_hub/license-proof','synthetic rights'],['_hub/workspace.json','synthetic workspace']])put(path.join(root,name),value);
 f.opts={root,version,hubPath:origin,bootstrap:origin,windowLaunch:'fixture',platform,arch,osVersion:()=>options.osVersion,node:'22.19.0',updateStore:store,trust,now:()=>f.now,verifyPackage,license:{status:()=>({enforcement:false})},fetch:async url=>{f.calls.push(url);return url===trust.feedUrl?Response.json(f.envelope):new Response(f.bytes);}};
 f.make=(extra={})=>wire({createUpdater:(v,o)=>new api.ReleaseUpdate({...f.opts,...o,...extra,version:extra.version||v})},{lifecycle:{state:()=>f.lifecycle,begin:()=>()=>{}}},f.importer,version,f.opts.license,()=>f.runtime||f.ai||chats.running.size>0||[...chats.queues.values()].some(q=>q.length)||chats.guardErrors().length>0,chats);
 f.publish=target=>{
  put(path.join(app,'hub/package.json'),JSON.stringify({version:target}));
  const record=JSON.parse(fs.readFileSync(path.join(app,'release-manifest.json')));record.releaseVersion=target;
  record.files.find(r=>r.path==='hub/package.json').sha256=sha(fs.readFileSync(path.join(app,'hub/package.json')));
  put(path.join(app,'release-manifest.json'),JSON.stringify(record));f.bytes=zip.pack(app);const tree=zip.treeHash(app);
  const name=`Project-Hub-${target}-Runtime-${platform==='darwin'?'Apple-Silicon':'Windows-x64'}.zip`;
  f.manifest={...f.manifest,version:target,seq:f.manifest.seq+1,asset:{name,size:f.bytes.length,sha256:sha(f.bytes),url:trust.assetPrefix+'v'+target+'/'+name},app:{...f.manifest.app,shortVersion:target,treeSha256:tree.treeSha256,entries:tree.entries}};f.envelope=sign(f.manifest);
 };
 f.u=f.make();f.ready=async()=>{await f.u.check();assert.equal(f.u.data.phase,'ready',JSON.stringify(f.u.status()));assert.ok(f.u.data.prepared);};
 f.preserved=()=>{for(const [name,value] of [['Product/P/chat.txt','synthetic retained conversation'],['_hub/settings.json','synthetic settings'],['_hub/license-proof','synthetic rights'],['_hub/workspace.json','synthetic workspace']])assert.equal(fs.readFileSync(path.join(root,name),'utf8'),value);};
 t.after(()=>{chats.handoffAdmission?.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}
for(const platform of ['darwin','win32']){
 test(platform+': emitted ReleaseUpdate admits an empty real save spool; legacy guard reproduces perpetual deferral',async t=>{
  const f=fixture(t,platform);await f.ready();assert.equal(f.u.busy(),true);assert.equal(await f.u.strictBusy(),false);
  const strict=f.u.strictBusy;delete f.u.strictBusy;await f.u.apply();assert.equal(f.u.data.phase,'deferred');assert.equal(f.u.data.current,undefined);
  f.u.strictBusy=strict;await f.u.apply();assert.equal(f.u.data.phase,'installed');assert.equal(f.u.restartNeeded,true);assert.ok(f.u.data.pendingConfirm);f.preserved();
 });
 for(const blocker of ['AI','queue','import','lifecycle','save-error','runtime'])test(platform+': full emitted busy retains '+blocker+' protection',async t=>{
  const f=fixture(t,platform);await f.ready();
  if(blocker==='AI')f.chats.running.set('P/t',{options:{request:'fixture'}});
  if(blocker==='queue')f.chats.queues.set('P/t',[{request:'queued-fixture'}]);
  if(blocker==='import')f.importer.running=true;
  if(blocker==='lifecycle')f.lifecycle='moving';
  if(blocker==='save-error')f.chats.adoptErrors=[{run:'fixture',stage:'save',error:'fixture failure'}];
  if(blocker==='runtime')f.runtime=true;
  await f.u.apply();assert.equal(f.u.data.phase,'deferred');assert.equal(f.u.data.current,undefined);assert.ok(f.u.data.prepared);f.preserved();
 });
 test(platform+': final strict check rechecks work started while validating the package',async t=>{
  const f=fixture(t,platform);await f.ready();let checks=0;const strict=f.u.strictBusy;f.u.strictBusy=()=>{checks++;return strict();};
  f.u.macOS=async()=>{f.importer.running=true;return f.options.osVersion;};await f.u.apply();assert.equal(checks,2);assert.equal(f.u.data.phase,'deferred');assert.equal(f.u.data.current,undefined);
 });
 test(platform+': changed admission state and failed save scan defer without rejecting; retry can install',async t=>{
  const f=fixture(t,platform);await f.ready();let scan=0;
  f.chats.handoffAdmission={scan:async()=>{f.chats.stops.set('P/t',++scan);return {errors:[],dirs:[]};},close(){}};
  const before=structuredClone(f.u.data);await f.u.apply();assert.equal(scan,2);assert.equal(f.u.data.current,undefined);assert.equal(f.u.data.phase,'deferred');assert.match(f.u.data.reason,/あとで更新/);
  for(const key of ['rejected','retryAfter','retryAfterKind','error'])assert.deepEqual(f.u.data[key],before[key]);
  f.chats.stops.clear();f.chats.handoffAdmission={scan:async()=>({errors:[],dirs:[]}),close(){}};await f.u.apply();assert.equal(f.u.data.phase,'installed');
  const g=fixture(t,platform);await g.ready();g.chats.handoffAdmission={scan:async()=>{throw Error('fixture scan unavailable');},close(){}};
  const previous=structuredClone(g.u.data);await g.u.apply();assert.equal(g.u.data.current,undefined);assert.equal(g.u.data.phase,'deferred');assert.match(g.u.data.reason,/あとで更新/);
  for(const key of ['rejected','retryAfter','retryAfterKind','error'])assert.deepEqual(g.u.data[key],previous[key]);
  g.chats.handoffAdmission={scan:async()=>({errors:[],dirs:[]}),close(){}};await g.u.apply();assert.equal(g.u.data.phase,'installed');
 });
 test(platform+': final strict check exception defers without a failure cooldown, then applies',async t=>{
  const f=fixture(t,platform);await f.ready();let checks=0;const strict=f.u.strictBusy;
  f.u.strictBusy=()=>{if(++checks===2)throw Error('fixture final state change');return strict();};
  const before=structuredClone(f.u.data);await f.u.apply();assert.equal(checks,2);assert.equal(f.u.data.phase,'deferred');assert.ok(f.u.data.prepared);assert.equal(f.u.data.current,undefined);
  for(const key of ['rejected','retryAfter','retryAfterKind','error'])assert.deepEqual(f.u.data[key],before[key]);
  f.u.strictBusy=strict;await f.u.apply();assert.equal(f.u.data.phase,'installed');f.preserved();
 });
 test(platform+': inherited check and tick both use strict install checks',async t=>{
  const f=fixture(t,platform);f.u.enabled=true;f.lifecycle='updating';await f.u.check(false);assert.equal(f.u.data.phase,'installed');
  const g=fixture(t,platform);await g.ready();g.u.enabled=true;g.u.tick();assert.ok(g.u.running);await g.u.running;assert.equal(g.u.data.phase,'installed');
 });
 test(platform+': compatibility without strictBusy and signed package rejection stay fail closed',async t=>{
  const f=fixture(t,platform);await f.ready();delete f.u.strictBusy;f.u.busy=()=>false;await f.u.apply();assert.equal(f.u.data.phase,'installed');
  const g=fixture(t,platform);await g.ready();g.u.data.prepared.envelope={...g.u.data.prepared.envelope,sig:Buffer.alloc(64).toString('base64url')};await g.u.apply();assert.equal(g.u.data.current,undefined);assert.equal(g.u.data.phase,'failed');assert.match(g.u.data.error,/signature/);
  const h=fixture(t,platform);await h.ready();put(path.join(h.u.data.prepared.runtime,'server.js'),'tampered');await h.u.apply();assert.equal(h.u.data.current,undefined);assert.equal(h.u.data.phase,'failed');assert.match(h.u.data.error,/tree-hash/);
 });
}
// Compile/fixture-only replacement. No actual app replacement is authorized here.
function fullShell(f,version,same=false){
 const full=same?path.dirname(f.origin):path.join(f.root,'replacement'),origin=path.join(full,'hub');
 put(path.join(origin,'package.json'),JSON.stringify({version}));
 const m={platform:'darwin',arch:'arm64',macShellGeneration:3,releaseVersion:version,files:[{path:'hub/package.json',mode:0o644,sha256:sha(fs.readFileSync(path.join(origin,'package.json')))}]};
 put(path.join(full,'release-manifest.json'),JSON.stringify(m));return {origin,options:{...f.options,originSha:sha(fs.readFileSync(path.join(full,'release-manifest.json')))}};
}
for(const old of ['4.126.98','4.126.99','4.126.100'])test('Mac '+old+': full-shell replacement archives obsolete prepared evidence, preserves data and can complete its next signed update',async t=>{
 const target=old==='4.126.100'?'4.126.101':'4.126.100',replacement=old==='4.126.100'?'4.126.102':'4.126.101';
 const f=fixture(t,'darwin',{version:old,target});await f.ready();
 f.store.access(d=>({...d,rejected:{seq:1,sha256:'c'.repeat(64)},retryAfter:f.now+86400000,retryAfterKind:'interval'}));const before=f.store.read().value;
 const {origin,options}=fullShell(f,replacement);
 assert.deepEqual(bootstrap.selectLaunch(api,f.store,origin,options),{runtime:origin,token:''});
 const retained=f.store.read().value;assert.equal(retained.origin,origin);assert.equal(retained.originSha,options.originSha);assert.equal(retained.prepared,undefined);
 assert.deepEqual(retained.supersededPrepared,[{bootstrap:origin,version:replacement,prepared:before.prepared,verified:true}]);
 for(const key of ['envelope','manifest','maxSeq','rejected','retryAfter','retryAfterKind'])assert.deepEqual(retained[key],before[key]);
 bootstrap.selectLaunch(api,f.store,origin,options);assert.equal(f.store.read().value.supersededPrepared.length,1);
 const u=f.make({version:replacement,hubPath:origin,bootstrap:origin});assert.equal(u.status().supported,true);
 f.publish('4.126.103');f.now+=60000;await u.check();assert.equal(u.data.phase,'ready');assert.ok(u.data.prepared);await u.apply();assert.equal(u.data.phase,'installed');
 const selected=bootstrap.selectLaunch(api,f.store,origin,options);assert.ok(selected.token);
 const next=f.make({version:'4.126.103',hubPath:selected.runtime,bootstrap:origin,env:{HUB_UPDATE_CONFIRM:selected.token}});await next.recover();
 assert.equal(await next.healthy({version:'4.126.103',hubPath:selected.runtime,token:selected.token,restored:true,instance:'fixture'}),true);f.preserved();
});
test('Mac: equal prepared version at the same full-app path is archived; failure cooldown is retained',async t=>{
 const f=fixture(t,'darwin',{target:'4.126.101'});await f.ready();f.store.access(d=>({...d,error:'existing failure',phase:'failed',retryAfterKind:'failure',retryAfter:f.now+86400000}));const before=f.store.read().value;
 const {origin,options}=fullShell(f,'4.126.101',true);bootstrap.selectLaunch(api,f.store,origin,options);const d=f.store.read().value;
 assert.deepEqual(d.supersededPrepared[0].prepared,before.prepared);for(const key of ['error','phase','retryAfterKind','retryAfter'])assert.equal(d[key],before[key]);
 const u=f.make({version:'4.126.101',hubPath:origin,bootstrap:origin});const calls=f.calls.length;await u.check();assert.equal(f.calls.length,calls);f.preserved();
});
test('Mac: newer prepared runtime remains active; changed full-app SHA still blocks launch',async t=>{
 const f=fixture(t,'darwin',{target:'4.126.102'});await f.ready();const before=f.store.read().value,{origin,options}=fullShell(f,'4.126.101');
 bootstrap.selectLaunch(api,f.store,origin,options);assert.deepEqual(f.store.read().value.prepared,before.prepared);assert.equal(f.store.read().value.supersededPrepared,undefined);
 const g=fixture(t,'darwin',{target:'4.126.100'});await g.ready();const full=fullShell(g,'4.126.101');full.options.originSha='b'.repeat(64);
 const snapshot=g.store.read();assert.throws(()=>bootstrap.selectLaunch(api,g.store,full.origin,full.options),/mac_bootstrap_changed/);assert.deepEqual(g.store.read(),snapshot);
});
for(const kind of ['expiry','missing-folder','signature','tree','package','path','envelope','history'])test('Mac: obsolete prepared '+kind+' is quarantined without blocking the full app',async t=>{
 const f=fixture(t,'darwin',{target:'4.126.100'});await f.ready();const full=fullShell(f,'4.126.101');
 f.store.access(d=>({...d,rejected:{seq:1,sha256:'c'.repeat(64)},retryAfter:f.now+86400000,retryAfterKind:'failure',error:'retained failure'}));
 if(kind==='expiry')full.options.now=f.manifest.expiresAt*1000+1;
 if(kind==='missing-folder')fs.rmSync(path.dirname(f.u.data.prepared.runtime),{recursive:true});
 if(kind==='signature')f.store.access(d=>{d.prepared.envelope.sig=Buffer.alloc(64).toString('base64url');d.envelope.sig=d.prepared.envelope.sig;return d;});
 if(kind==='tree')put(path.join(f.u.data.prepared.runtime,'server.js'),'tampered');
 if(kind==='package'){
  const verify=full.options.verifyPackage;full.options.verifyPackage=(folder,platform)=>{if(folder!==path.dirname(full.origin))throw Error('fixture invalid package');return verify(folder,platform);};
 }
 if(kind==='path')f.store.access(d=>{d.prepared.runtime=path.join(f.root,'outside/hub');return d;});
 if(kind==='envelope')f.store.access(d=>{d.envelope={...d.envelope,payload:'mismatch'};return d;});
 if(kind==='history')f.store.access(d=>({...d,supersededPrepared:{invalid:true},invalidSupersededPrepared:{older:true}}));
 const before=f.store.read().value;
 assert.deepEqual(bootstrap.selectLaunch(api,f.store,full.origin,full.options),{runtime:full.origin,token:''});
 const d=f.store.read().value;assert.equal(d.prepared,undefined);assert.equal(d.origin,full.origin);assert.equal(d.originSha,full.options.originSha);
 const archived=d.supersededPrepared.at(-1);assert.equal(archived.verified,false);assert.ok(archived.reason);assert.deepEqual(archived.prepared,before.prepared);
 if(kind==='history')assert.deepEqual(d.invalidSupersededPrepared,{history:before.supersededPrepared,previous:before.invalidSupersededPrepared});
 for(const key of ['maxSeq','rejected','retryAfter','retryAfterKind','error','manifest','envelope'])assert.deepEqual(d[key],before[key]);
 // The invalid prepared runtime is neither selected nor executed on later starts.
 assert.deepEqual(bootstrap.selectLaunch(api,f.store,full.origin,full.options),{runtime:full.origin,token:''});f.preserved();
});
test('Mac: archive storage failure still launches only the verified full app and retains the original journal',async t=>{
 const f=fixture(t,'darwin',{target:'4.126.100'});await f.ready();const full=fullShell(f,'4.126.101'),before=f.store.read();let writes=0;
 const broken={...f.store,access(change){if(!change)return f.store.read();const next=change(structuredClone(before.value));if(next!==undefined){writes++;throw Error('fixture disk full');}return before;}};
 assert.deepEqual(bootstrap.selectLaunch(api,broken,full.origin,full.options),{runtime:full.origin,token:''});assert.equal(writes,1);assert.deepEqual(f.store.read(),before);f.preserved();
 full.options.originSha='b'.repeat(64);assert.throws(()=>bootstrap.selectLaunch(api,broken,full.origin,full.options),/mac_bootstrap_changed/);assert.equal(writes,1);
});
test('Mac: new full-shell paths cannot take over selected/pending runtimes; same-path replacement retains them',async t=>{
 const f=fixture(t,'darwin');await f.ready();await f.u.apply();const selected=f.store.read().value;
 const moved=fullShell(f,'4.126.103'),snapshot=f.store.read();
 assert.throws(()=>bootstrap.selectLaunch(api,f.store,moved.origin,moved.options),/bootstrap/);assert.deepEqual(f.store.read(),snapshot);
 const same=fullShell(f,'4.126.102',true),launch=bootstrap.selectLaunch(api,f.store,same.origin,same.options);
 assert.equal(launch.runtime,selected.current.runtime);assert.equal(launch.token,selected.pendingConfirm.token);assert.equal(f.store.read().value.supersededPrepared,undefined);
 const u=f.make({version:f.manifest.version,hubPath:launch.runtime,env:{HUB_UPDATE_CONFIRM:launch.token}});assert.equal(await u.healthy({version:f.manifest.version,hubPath:launch.runtime,token:launch.token,restored:true,instance:'fixture'}),true);
 assert.throws(()=>bootstrap.selectLaunch(api,f.store,moved.origin,moved.options),/bootstrap/);f.preserved();
});

test('Mac: verified full-shell replacement without a prepared/selected runtime can launch, update and confirm while preserving data',async t=>{
 const f=fixture(t,'darwin',{target:'4.126.102'}),full=path.join(f.root,'replacement'),origin=path.join(full,'hub');
 put(path.join(origin,'package.json'),JSON.stringify({version:'4.126.101'}));
 const m={platform:'darwin',arch:'arm64',macShellGeneration:3,releaseVersion:'4.126.101',files:[{path:'hub/package.json',mode:0o644,sha256:sha(fs.readFileSync(path.join(origin,'package.json')))}]};
 put(path.join(full,'release-manifest.json'),JSON.stringify(m));const options={...f.options,originSha:sha(fs.readFileSync(path.join(full,'release-manifest.json')))};
 assert.deepEqual(bootstrap.selectLaunch(api,f.store,origin,options),{runtime:origin,token:''});
 const u=f.make({version:'4.126.101',hubPath:origin,bootstrap:origin});await u.check();assert.equal(u.data.phase,'ready');assert.ok(u.data.prepared);await u.apply();assert.equal(u.data.phase,'installed');
 const selected=bootstrap.selectLaunch(api,f.store,origin,options);assert.ok(selected.token);
 const next=f.make({version:'4.126.102',hubPath:selected.runtime,bootstrap:origin,env:{HUB_UPDATE_CONFIRM:selected.token}});await next.recover();
 assert.equal(await next.healthy({version:'4.126.102',hubPath:selected.runtime,token:selected.token,restored:true,instance:'fixture'}),true);f.preserved();
});

// The real emitted updater owns installation and confirmation; only the native
// OS launch is replaced with an event receiver in these offline tests.
for(const result of ['healthy','two failed launches'])test('Mac auto reopen: signed apply, normal handoff and '+result,async t=>{
 const f=fixture(t,'darwin',{version:'4.126.103',target:'4.126.104'});await f.ready();
 let launches=0,approved=0;const reopen=require('../release-app/auto-reopen.cjs');
 reopen.attach(f.u,{now:()=>f.now,launch:()=>{launches++;return {ready:Promise.resolve(),go(){},stop(){},approve(){approved++;}};}});
 f.u.reopener.request();await f.u.apply();assert.equal(f.u.data.phase,'installed');
 const before=structuredClone(f.u.data.pendingConfirm);f.now+=2000;
 f.u.reopener.pulse({client:'native-window-0001',ticket:f.u.reopener.ticket,ready:true});
 await f.u.reopener.advance(async()=>!await f.u.strictBusy());assert.equal(launches,1);
 f.u.reopener.beforeQuit(f.u.reopener.ticket);f.u.reopener.approved();assert.equal(approved,1);
 assert.deepEqual(f.u.data.pendingConfirm,before);
 const selected=api.selectLaunch(f.store,f.origin,{...f.options,now:f.now});assert.equal(selected.token,before.token);
 if(result==='healthy'){
  const next=f.make({version:f.manifest.version,hubPath:selected.runtime,env:{HUB_UPDATE_CONFIRM:selected.token}});await next.recover();
  assert.equal(await next.healthy({version:f.manifest.version,hubPath:selected.runtime,token:selected.token,restored:true,instance:'fixture'}),true);
  assert.equal(next.data.pendingConfirm,undefined);assert.equal(next.restartNeeded,false);assert.equal(next.data.lastInstalled.version,'4.126.104');
 }else{
  assert.equal(f.store.read().value.pendingConfirm.attempts,1);
  assert.equal(api.selectLaunch(f.store,f.origin,{...f.options,now:f.now}).token,before.token);
  const previous=api.selectLaunch(f.store,f.origin,{...f.options,now:f.now});
  assert.deepEqual(previous,{runtime:f.origin,token:''});assert.equal(f.store.read().value.phase,'rolled-back');assert.equal(f.store.read().value.pendingConfirm,undefined);
 }
 f.preserved();
});

test('Mac auto reopen: emitted ordinary quit checks real save handoff, import and history writes; Windows admission unchanged',async t=>{
 const f=fixture(t,'darwin');const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
 const build=require('../release-app/build.cjs'),mac=build.serverSource(source,'darwin');
 assert.equal(build.serverSource(source,'win32'),server);
 const start=mac.indexOf('canQuit:b=>'),end=mac.indexOf(')})) return;',start);assert.ok(start>0&&end>start);
 const make=new Function('chats','updateBusy','legacyImport','taskHistory','freetalkHistory','aiTools','sessions','process','HUB_INSTANCE','return '+mac.slice(start+8,end+1));
 const taskHistory={activeWrites:new Set()},freetalkHistory={activeWrites:new Set()},aiTools={isOperating:()=>false},sessions={list:()=>[]};
 const guard=make(f.chats,()=>f.ai||f.chats.guardErrors().length>0,f.importer,taskHistory,freetalkHistory,aiTools,sessions,process,'fixture');
 assert.equal(await guard({}),true);
 for(const block of [()=>{f.importer.running=true;},()=>taskHistory.activeWrites.add('fixture'),()=>freetalkHistory.activeWrites.add('fixture'),()=>{f.ai=true;}]){
  block();assert.equal(await guard({}),false);f.importer.running=false;f.ai=false;taskHistory.activeWrites.clear();freetalkHistory.activeWrites.clear();
 }
 f.chats.adoptErrors=[{stage:'save',error:'synthetic failed save'}];assert.equal(await guard({}),false);f.preserved();
});
