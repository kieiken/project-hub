'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),crypto=require('node:crypto'),vm=require('node:vm');
const compiler=require('../release-app/compile.cjs'),repo=path.resolve(__dirname,'../..');
test('all packaged Mac shells retain the reviewed owner screenshot receiver and temporary-file boundary',()=>{
  const owner=fs.readFileSync(path.join(repo,'hub/app/window.swift'),'utf8');
  const receiver=owner.slice(owner.indexOf('// BEGIN PROMISED DROP BATCH'),owner.indexOf('\nclass AppDelegate:')).trim();
  assert.ok(receiver.includes('let temporary = !receivers.isEmpty || bitmapType != nil'));
  assert.ok(receiver.includes('temporary: temporary, cleanup: cleanup'));
  const staging=fs.readFileSync(path.join(repo,'hub/staging-app/Window.swift'),'utf8');
  const purchase=require('../purchase-test-app/build.cjs').windowSource(staging);
  const release=purchase.replaceAll('4588','4545').replaceAll('購入試験版','Project Hub').replaceAll('purchase-test-app/','release-app/');
  for(const source of [staging,purchase,release]){
    assert.ok(source.includes(receiver),'exact reviewed aggregation, URL/promise selection, ticket, timeout and cleanup');
    assert.match(source,/web = DropWebView\(frame: \.zero, configuration: config\)/);
    assert.match(source,/web\.registerForDraggedTypes\(NSFilePromiseReceiver\.readableDraggedTypes/);
    assert.match(source,/web\.navigationDelegate = self; web\.uiDelegate = self/);
    assert.equal((source.match(/class DropWebView:/g)||[]).length,1);
  }
});
test('packaged screenshot receiver compiles in staging and transformed purchase shells',{skip:process.platform!=='darwin'},t=>{
  const folder=temp(t),staging=fs.readFileSync(path.join(repo,'hub/staging-app/Window.swift'),'utf8');
  const shutdown=fs.readFileSync(path.join(repo,'hub/staging-app/Shutdown.swift'),'utf8');
  for(const [name,window,stop] of [
    ['staging',staging,shutdown],
    ['purchase',require('../purchase-test-app/build.cjs').windowSource(staging),shutdown.replaceAll('4587','4588')]
  ]){
    const source=path.join(folder,name+'.swift'),helper=path.join(folder,name+'-shutdown.swift');
    fs.writeFileSync(source,window);fs.writeFileSync(helper,stop);
    require('node:child_process').execFileSync('/usr/bin/swiftc',['-typecheck',helper,source,'-framework','Cocoa','-framework','WebKit'],{timeout:120000});
  }
});
function generated(name,cache={}){
  if(cache[name])return cache[name];
  const file=path.join(repo,'hub/release-app',name+'.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  const requireOriginal=m.require.bind(m);m.require=id=>id==='./protocol.cjs'?generated('protocol',cache):id==='./core.cjs'?generated('core',cache):id==='./update-trust.cjs'?require('../release-app/update-trust.cjs'):requireOriginal(id);
  const s=name==='protocol'?compiler.protocol('4.125.2'):name==='core'?compiler.core(fs.readFileSync(path.join(repo,'hub/staging-app/runtime.cjs'),'utf8')):(compiler[name]||compiler.common)(fs.readFileSync(path.join(repo,'hub/purchase-test-app',name+'.cjs'),'utf8'));
  m._compile(s,file);cache[name]=m.exports;return m.exports;
}
const temp=t=>{const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-release-app-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test('production derivation fixes root, OS/build and trust without a staging profile or environment switch',t=>{
  const protocol=generated('protocol'),runtime=generated('runtime'),policy=require('../lib/license/policy');
  protocol.supported('darwin','arm64','22.13.0');protocol.supported('win32','x64','24.0.0');
  for(const args of [['darwin','x64','22.13.0'],['win32','arm64','22.13.0'],['darwin','arm64','22.12.0']])assert.throws(()=>protocol.supported(...args));
  assert.equal(protocol.configFor('darwin').build.buildId,'project-hub-4.125.2-mac-arm64');assert.equal(protocol.configFor('win32').build.buildId,'project-hub-4.125.2-windows-x64');
  for(const platform of ['darwin','win32']){assert.equal(protocol.configFor(platform).endpoint,policy.endpoint);assert.equal(protocol.configFor(platform).purchaseUrl,policy.purchaseUrl);assert.equal(protocol.configFor(platform).trustedKeys,policy.trustedKeys);}
  assert.equal(protocol.configFor('darwin').trustedKeys,policy.trustedKeys);assert.equal(protocol.configFor('darwin').build.product,'project-hub-4.123');
  const home=temp(t);assert.equal(runtime.workspaceFor(home,'darwin'),path.join(home,'Library/Application Support/ProjectHub'));assert.equal(runtime.workspaceFor(home,'win32'),path.join(home,'ProjectHub'));
  assert.notEqual(runtime.workspaceFor(home,'darwin'),path.join(home,'Documents/AI-Workspace'));assert.equal(runtime.port,4545);
  const code=compiler.runtime(fs.readFileSync(path.join(repo,'hub/purchase-test-app/runtime.cjs'),'utf8'));assert.doesNotMatch(code,/require\([^\n]*(?:staging-app\/|purchase-test-app\/)|core\.profileSha/);
});
test('new empty general directory requires confirmation, preserves cancellation and survives leases/reopen',t=>{
  const root=temp(t),control=path.join(root,'protected'),data=path.join(root,'新規'),app=path.join(root,'app');for(const p of [control,data,app])fs.mkdirSync(p);
  const {Workspace}=generated('workspace');let guard=0;const opts={root:control,home:root,app,guard:()=>guard++};
  let w=new Workspace(opts);w.open();const before=fs.readdirSync(data);const p=w.preview({workspace:data});assert.equal(p.projects.length,0);assert.deepEqual(fs.readdirSync(data),before);w.cancel();assert.equal(w.status().pending,null);
  const q=w.preview({workspace:data});w.apply(q.token);assert.equal(w.data.workspace,control);assert.ok(w.status().pending);w.close();
  w=new Workspace(opts);assert.equal(w.open().workspace,data);fs.mkdirSync(path.join(data,'Product'));w.ready();w.close();
  w=new Workspace(opts);assert.equal(w.open().workspace,data);assert.equal(w.status().pending,null);w.close();assert.ok(guard>=3);
  fs.writeFileSync(path.join(data,'unknown.txt'),'retain');assert.throws(()=>w.preview({workspace:data}));assert.equal(fs.readFileSync(path.join(data,'unknown.txt'),'utf8'),'retain');
});
test('normal licence and actual purchase HTML preserve expiry, held and purchased differences in release configuration',async t=>{
 for(const platform of ['darwin','win32'])await t.test(platform,async t=>{
  const root=temp(t),{LicenseDB}=require('./fixtures/license-db.cjs'),db=new LicenseDB();t.after(()=>db.close());
  const config=generated('protocol').configFor(platform),key=crypto.generateKeyPairSync('ed25519');db.raw.prepare('INSERT INTO builds(id,os,scope,betaExpiresAt,globalEndAt) VALUES(?,?,?,?,?)').run(config.build.buildId,platform==='win32'?'windows':'mac',JSON.stringify({channel:'release',product:'project-hub-4.123',bugfixOf:[]}),null,null);
  const {handle}=await import('../license-issuer/worker.mjs'),mem=new Map(),secret={get:k=>mem.get(k),put:(k,v)=>mem.set(k,v)};
  let now=1800000000,elapsed=0;
  const env={DB:db,TRIAL_DAYS:'30',DEFAULT_DEVICE_LIMITS:{mac:2,windows:2},ISSUER_KID:'fixture',ISSUER_PRIVATE_KEY_PKCS8_B64:key.privateKey.export({type:'pkcs8',format:'der'}).toString('base64')};
  const store=new(require('../lib/license/storage').LicenseStore)(root,platform==='win32'?{name:'win32',licenseDirectory:()=> 'fixture-ntfs-identity'}:require('../lib/platform').forPlatform('darwin'));
  const licence=new(require('../lib/license').License)({root,store,owner:false,platform,config:{...config,trustedKeys:{fixture:{publicKey:key.publicKey,purposes:['proof','time']}}},secret,machineHint:()=> 'A'.repeat(43),elapsed:()=>elapsed,wall:()=>now,fetcher:(url,init)=>{assert.equal(new URL(url).origin,config.endpoint);return handle(new Request('http://127.0.0.1'+new URL(url).pathname,init),env,now);}});
  const ui=fs.readFileSync(path.join(repo,'hub/public/app-settings.js'),'utf8'),fn=ui.slice(ui.indexOf('function licensePurchaseHtml()'),ui.indexOf('\nfunction rolesSaveStatus()'));
  const render=license=>vm.runInNewContext(fn+'\nlicensePurchaseHtml()',{state:{license},URL,UI:{html:x=>x,template:(s,...v)=>s.reduce((out,x,i)=>out+x+(v[i]??''),'')}});
  assert.match(render(licence.status()),/4,900/);await licence.prepare();const first=licence.status();assert.equal(first.trial.days,30);assert.equal(first.introAvailable,true);
  const normalTick=licence.clock.tick.bind(licence.clock),expiry=first.trial.expiry;let tick={t:expiry-1,wall:expiry-1,mode:'T',valid:true};licence.clock.tick=()=>tick;
  for(const [time,state,price] of [[expiry-1,'active',/1,100/],[expiry,'expired',/4,900/],[expiry+1,'expired',/4,900/]]){tick={...tick,t:time,wall:time};const s=licence.status();assert.equal(s.trial.state,state);assert.match(render(s),price);if(state==='active')licence.require(['delegate']);else assert.throws(()=>licence.require(['delegate']));licence.require(['chat_basic']);}
  tick={...tick,t:expiry-1,wall:expiry-1,mode:'U',valid:false};assert.equal(licence.status().trial.state,'held');assert.match(render(licence.status()),/4,900/);
  const {createPurchase}=await import('../license-issuer/purchase.mjs');const purchase=await createPurchase(db,{provider:'synthetic',orderId:'release-html-fixture',paid:true,scope:{channel:'release',product:'project-hub-4.123',bugfixOf:[]},at:now,deviceLimits:{mac:2,windows:2}});
  now=expiry+2;elapsed=now-first.trial.startsAt;licence.clock.tick=normalTick;await licence.activate(purchase.code);const paid=licence.status();assert.equal(paid.purchased,true);assert.equal(paid.introAvailable,false);assert.doesNotMatch(render(paid),/購入する（/);assert.equal(render(paid),'');assert.match(paid.reason,/期限なし/);licence.require(['delegate']);
 });
});
module.exports={generated};

test('release waits for a confirmed general workspace before preparing or offering activation',async t=>{
  const root=temp(t),control=path.join(root,'control'),data=path.join(root,'data');let selected=false,pending=false,prepared=0,adopted=0;
  const file=path.join(repo,'hub/release-app/runtime.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);
  m.require=id=>id==='./core.cjs'?generated('core'):id==='./protocol.cjs'?generated('protocol'):id==='./license.cjs'?{createLicense:()=>({client:{prepare:async()=>{prepared++;},status:()=>({activationAvailable:true,purchaseUrl:'https://issuer.invalid/buy',introAvailable:true})}})}:id==='./legacy-license.cjs'?{adopt:()=>{adopted++;}}:original(id);
  m._compile(compiler.runtime(fs.readFileSync(path.join(repo,'hub/purchase-test-app/runtime.cjs'),'utf8'))+'\nmodule.exports.fixture=x=>configured=x;',file);
  const runtime=m.exports,workspace={data:{workspace:control},external:()=>selected,get pending(){return pending;}};runtime.fixture({root:control,workspace});
  let l=runtime.createLicense(control);await l.client.prepare();assert.equal(prepared,0);assert.equal(adopted,0);assert.equal(l.client.status().activationAvailable,false);assert.equal(l.client.status().purchaseUrl,'');
  selected=true;workspace.data.workspace=data;l=runtime.createLicense(data);assert.equal(adopted,1);await l.client.prepare();assert.equal(prepared,1);assert.equal(l.client.status().activationAvailable,true);
  pending=true;await l.client.prepare();assert.equal(prepared,1);
});

// Target OS names exercise the generated updater, not Windows ACLs or a GUI.
function updateModeFixture(t,platform='win32') {
  const root=temp(t),folder=path.join(root,'runtime');fs.mkdirSync(folder);
  const native=['ProjectHub.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'];
  const names=['hub/package.json','hub/server.js','hub/release-app/core.cjs','hub/release-app/protocol.cjs','hub/release-app/runtime.cjs','hub/release-app/license.cjs','hub/release-app/launch.cjs','hub/paid-bundle.json',...native.map(n=>'window/'+n),...Array.from({length:100},(_,i)=>'docs/fixture-'+i+'.txt')];
  const files=names.map(name=>{
    const file=path.join(folder,name),bytes=name==='hub/package.json'?JSON.stringify({version:'4.125.2'}):'synthetic '+name;
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);fs.chmodSync(file,0o600);
    return {path:name,bytes:Buffer.byteLength(bytes),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mode:name.startsWith('window/')&&platform==='win32'?0o666:name==='hub/server.js'?0o755:0o644};
  });
  const record={version:1,kind:'public-release',source:'a'.repeat(40),platform,arch:platform==='win32'?'x64':'arm64',releaseVersion:'4.125.2',shellProtocol:1,port:4545,files};
  const zip=require('../lib/update-zip');
  const save=()=>{fs.writeFileSync(path.join(folder,'release-manifest.json'),JSON.stringify(record));const tree=zip.treeHash(folder);return {version:record.releaseVersion,requires:{os:record.platform,arch:record.arch},app:{treeSha256:tree.treeSha256,entries:tree.entries}};};
  return {folder,record,save,inspect:generated('update').inspect,verify:generated('runtime').verifyPackage};
}
test('release update inspection accepts Windows native DOS modes and retains exact bytes and package checks',t=>{
  const f=updateModeFixture(t),m=f.save();let verified=0;
  const tree=f.inspect(f.folder,m,(...args)=>{verified++;return f.verify(...args);});
  assert.equal(verified,1);assert.equal(tree.treeSha256,m.app.treeSha256);
  for(const row of f.record.files)if(process.platform!=='win32')assert.equal(fs.statSync(path.join(f.folder,row.path)).mode&0o777,row.mode);
  // A mode exception never substitutes for the signed tree or package bytes.
  fs.appendFileSync(path.join(f.folder,'window/ProjectHub.exe'),'tampered');
  assert.throws(()=>f.inspect(f.folder,m,f.verify),/tree-hash/);
  assert.throws(()=>f.inspect(f.folder,f.save(),f.verify));
});
test('release update native mode exception excludes Mac, other paths and other permission values',t=>{
  for(const [platform,name,mode] of [
    ['darwin','window/ProjectHub.exe',0o666],['win32','hub/server.js',0o666],
    ['win32','window/other.dll',0o666],['win32','window/ProjectHub.exe',0o777],
    ['win32','window/ProjectHub.exe',0o4666],['win32','window/ProjectHub.exe','438']
  ]) {
    const f=updateModeFixture(t,platform),row=f.record.files.find(r=>r.path==='window/ProjectHub.exe');
    if(name==='window/other.dll'){fs.renameSync(path.join(f.folder,row.path),path.join(f.folder,name));row.path=name;}
    else if(name==='hub/server.js')f.record.files.find(r=>r.path===name).mode=mode;
    if(name!=='hub/server.js')row.mode=mode;
    let verified=0;assert.throws(()=>f.inspect(f.folder,f.save(),()=>verified++),/runtime-path/);assert.equal(verified,0);
  }
  const f=updateModeFixture(t,'darwin');assert.doesNotThrow(()=>f.inspect(f.folder,f.save(),f.verify));
});
