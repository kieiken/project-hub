'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),c=require('node:crypto');
const {adopt}=require('../release-app/legacy-license.cjs');
const {LicenseStore}=require('../lib/license/storage');
const {PAID,fingerprint,signEnvelope}=require('../lib/license/codec');
function fixture(t,kind='purchase') {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-adoption-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'old'),targetRoot=path.join(root,'new');
  const issuer=c.generateKeyPairSync('ed25519'),device=c.generateKeyPairSync('ed25519');
  const now=1800000000, adapter={name:'darwin',persistence:{syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}};
  const config={licenseEnforcement:true,trustedKeys:{production:{publicKey:issuer.publicKey,purposes:['proof','time']}},build:{channel:'release',buildId:'project-hub-4.125.2-mac-arm64',product:'project-hub-4.123',bugfixOf:[]},trialDays:30};
  const data={device:{id:'fixture-account',dev:fingerprint(device.publicKey)},state:{lastSeenAt:now,uptimeSinceAnchor:0,maxSeq:1,anchor:{serverTime:now,seq:1},proofs:[]}};
  const proof={v:1,ent:'fixture-ent',kind,features:PAID,dev:data.device.dev,scope:{channel:'release',product:config.build.product,bugfixOf:[]},iat:now,nbf:now,entStartsAt:now,seq:1,exp:kind==='purchase'?null:now+86400,...(kind==='trial'?{entEndsAt:now+86400}:{})};
  data.state.proofs=[signEnvelope(proof,issuer.privateKey,'production')];
  const raw=JSON.stringify({privateKeyPkcs8B64:device.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')});
  const secret={get:id=>id===data.device.id?raw:null,put(){assert.fail('secret write');}};
  const args={sourceRoot,targetRoot,platform:'darwin',adapter,config,secret,machineHint:()=>'',elapsed:()=>0,wall:()=>now};
  const save=()=>{const store=new LicenseStore(sourceRoot,adapter);store.write('device',data.device);store.write('state',data.state);};
  const receipt=(identity=c.createHash('sha256').update(data.device.dev).digest('hex'))=>{
    fs.mkdirSync(targetRoot,{recursive:true});
    const value={version:2,registered:true,os:args.platform,buildId:config.build.buildId,product:config.build.product,fingerprints:{identity}};
    fs.writeFileSync(path.join(targetRoot,'registration-result.json'),JSON.stringify(value));return value;
  };
  return {args,data,proof,issuer,save,sourceRoot,targetRoot,receipt};
}
test('absent legacy source returns none without creating directories',t=>{const f=fixture(t);assert.deepEqual(adopt(f.args),{status:'none'});assert.equal(fs.existsSync(f.targetRoot),false);assert.equal(fs.existsSync(f.sourceRoot),false);});
for(const kind of ['purchase','trial']) test('verified production '+kind+' preserves source and account; repeat is existing',t=>{
  const f=fixture(t,kind);f.save();const before=fs.readFileSync(path.join(f.sourceRoot,'_hub/license/state.json'),'utf8');
  assert.deepEqual(adopt(f.args),{status:'adopted'});assert.deepEqual(adopt(f.args),{status:'existing'});
  assert.equal(fs.readFileSync(path.join(f.sourceRoot,'_hub/license/state.json'),'utf8'),before);
  assert.deepEqual(new LicenseStore(f.targetRoot,f.args.adapter).read('device'),f.data.device);
});
for(const fault of ['staging-key','staging-scope','corrupt','wrong-os','clock','missing-key']) test('refuses '+fault+' without target identity',t=>{
  const f=fixture(t,'trial');
  if(fault==='staging-key')f.data.state.proofs[0]=signEnvelope(f.proof,c.generateKeyPairSync('ed25519').privateKey,'production');
  if(fault==='staging-scope'){f.proof.scope.product='project-hub-staging-only';f.data.state.proofs[0]=signEnvelope(f.proof,f.issuer.privateKey,'production');}
  if(fault==='corrupt')f.data.state.proofs=[{}];
  if(fault==='clock')f.data.state.lastSeenAt+=10000;
  if(fault==='missing-key')f.args.secret={get:()=>null};
  f.save();if(fault==='wrong-os')f.args.platform='win32';
  assert.throws(()=>adopt(f.args),{code:'legacy_license_unavailable'});assert.equal(fs.existsSync(path.join(f.targetRoot,'_hub/license')),false);
});
test('partial commit refuses retry and never overwrites or creates identity',t=>{
  const f=fixture(t);f.save();const original=LicenseStore.prototype.write;
  LicenseStore.prototype.write=function(name,value){if(this.home.startsWith(f.targetRoot)&&name==='state')throw Error('injected');return original.call(this,name,value);};
  try{assert.throws(()=>adopt(f.args),{code:'legacy_license_unavailable'});}finally{LicenseStore.prototype.write=original;}
  const devicePath=path.join(f.targetRoot,'_hub/license/device.json'),before=fs.readFileSync(devicePath,'utf8');
  assert.throws(()=>adopt(f.args),{code:'legacy_license_unavailable'});assert.equal(fs.readFileSync(devicePath,'utf8'),before);
});
test('existing valid target wins without touching source; corrupt target never overwritten',t=>{
 const f=fixture(t);f.save();const store=new LicenseStore(f.targetRoot,f.args.adapter);store.write('device',f.data.device);store.write('state',f.data.state);
 fs.writeFileSync(path.join(f.sourceRoot,'_hub/license/state.json'),'broken');assert.deepEqual(adopt(f.args),{status:'existing'});
 store.write('state',{});assert.throws(()=>adopt(f.args),{code:'legacy_license_unavailable'});assert.deepEqual(store.read('state'),{});
});
test('complete journal permits normal clock progression but refuses another identity',t=>{
  const f=fixture(t);f.save();adopt(f.args);const store=new LicenseStore(f.targetRoot,f.args.adapter);
  const state=store.read('state');state.lastSeenAt+=10;store.write('state',state);assert.deepEqual(adopt(f.args),{status:'existing'});
  const meta=store.read('device');meta.id='different-account';store.write('device',meta);
  assert.throws(()=>adopt(f.args),{code:'legacy_license_unavailable'});
});
test('absent source and target never initialize default native secret',t=>{
  const f=fixture(t);delete f.args.secret;f.args.adapter.secretStore=()=>assert.fail('native secret initialized');
  assert.deepEqual(adopt(f.args),{status:'none'});
});
test('existing source lazily obtains its default secret once',t=>{
 const f=fixture(t);f.save();let calls=0;const secret=f.args.secret;delete f.args.secret;
 f.args.adapter.secretStore=()=>{calls++;return secret;};assert.deepEqual(adopt(f.args),{status:'adopted'});assert.equal(calls,1);
});
test('expired authentic trial preserves signed expiry and never becomes fresh trial',t=>{
 const f=fixture(t,'trial');f.save();f.args.wall=()=>f.proof.exp+1;
 assert.deepEqual(adopt(f.args),{status:'adopted'});
 const stored=new LicenseStore(f.targetRoot,f.args.adapter).read('state');assert.deepEqual(stored,f.data.state);
 assert.deepEqual(adopt(f.args),{status:'existing'});
});
test('completed target adoption permits a different selected source workspace',t=>{
 const f=fixture(t);f.save();adopt(f.args);f.args.sourceRoot=path.join(f.sourceRoot,'another-workspace');
 assert.deepEqual(adopt(f.args),{status:'existing'});assert.equal(fs.existsSync(f.args.sourceRoot),false);
});
for(const platform of ['darwin','win32'])for(const match of [true,false])test(platform+': formal receipt identity must match before adoption ('+match+')',t=>{
 const f=fixture(t,'trial');f.args.platform=platform;f.args.adapter.name=platform;
 if(platform==='win32')f.args.adapter.licenseDirectory=()=> 'synthetic-ntfs-binding';
 f.save();f.receipt(match?undefined:'0'.repeat(64));
 const before=fs.readFileSync(path.join(f.targetRoot,'registration-result.json'),'utf8');
 if(match){assert.deepEqual(adopt(f.args),{status:'adopted'});assert.deepEqual(new LicenseStore(f.targetRoot,f.args.adapter).read('state'),f.data.state);}
 else {assert.throws(()=>adopt(f.args),{code:'legacy_registration_mismatch'});assert.equal(fs.existsSync(path.join(f.targetRoot,'_hub/license')),false);assert.equal(fs.existsSync(path.join(f.targetRoot,'_hub/license-adoption.json')),false);}
 assert.equal(fs.readFileSync(path.join(f.targetRoot,'registration-result.json'),'utf8'),before);
});
for(const platform of ['darwin','win32'])test(platform+': staging receipt does not block signed release adoption or renew the expired trial',t=>{
 const f=fixture(t,'trial');f.args.platform=platform;f.args.adapter.name=platform;
 if(platform==='win32')f.args.adapter.licenseDirectory=()=> 'synthetic-ntfs-binding';
 f.save();f.args.wall=()=>f.proof.exp+1;
 const r=f.receipt('0'.repeat(64));r.buildId='project-hub-staging-20261017-01';delete r.product;r.at='2026-10-20T00:00:01Z';
 fs.writeFileSync(path.join(f.targetRoot,'registration-result.json'),JSON.stringify(r));
 const claim=JSON.stringify({version:2,os:platform,status:'claimed-do-not-retry',at:'2026-10-20T00:00:00Z'});fs.writeFileSync(path.join(f.targetRoot,'registration-claimed.json'),claim);
 assert.deepEqual(adopt(f.args),{status:'adopted'});assert.deepEqual(new LicenseStore(f.targetRoot,f.args.adapter).read('state'),f.data.state);
 assert.equal(fs.readFileSync(path.join(f.targetRoot,'registration-result.json'),'utf8'),JSON.stringify(r));assert.equal(fs.readFileSync(path.join(f.targetRoot,'registration-claimed.json'),'utf8'),claim);
});
test('formal orphan claim and malformed receipt block adoption without target writes',t=>{
 for(const name of ['registration-claimed.json','registration-result.json']){
  const f=fixture(t);f.save();fs.mkdirSync(f.targetRoot);fs.writeFileSync(path.join(f.targetRoot,name),'{}');
  assert.throws(()=>adopt(f.args),{code:'legacy_registration_mismatch'});assert.equal(fs.existsSync(path.join(f.targetRoot,'_hub/license')),false);
 }
});
