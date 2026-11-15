'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { JevSettings } = require('../lib/jev-settings');
const routes = require('../lib/routes/jev-settings');
const fakeKey = 'fictional-jev-key-for-offline-test';

test('Windows C# dispatch rejects the Jev account before either generic secret operation, preserving dedicated dispatch', () => {
  const source = require('node:fs').readFileSync(require.resolve('../lib/platform/win32-native'), 'utf8');
  for (const [action, method] of [['secret-get', 'Get'], ['secret-put', 'Put']]) {
    const line = source.split('\n').find(line => line.includes(`case "${action}":`));
    assert.ok(line, action);
    const guard = 'if((string)r["account"]=="jev-api-key-v1") throw new Exception("secret_account_invalid");';
    assert.ok(line.indexOf(guard) > 0 && line.indexOf(guard) < line.indexOf(`value=HubWindowsLicense.${method}(`), action);
  }
  assert.match(source, /case "jev-status": value=HubWindowsLicense\.JevStatus\(\); break;/);
  assert.match(source, /case "jev-put": value=HubWindowsLicense\.PutJev\(\(string\)r\["value"\]\); break;/);
});

function fixture() {
  let value = null, writes = 0, reads = 0;
  const store = { get() { assert.fail('secret reader must not be used'); },
    jevStatus() { reads++; return value !== null; }, putJev(key) { writes++; value = key; } };
  const jev = new JevSettings({store});
  return {store, jev, counts: () => ({writes,reads})};
}
test('registration uses the protected store, only reads existence and never enables transport', () => {
  const f = fixture(); assert.equal(f.jev.status().registered, false);
  const saved = f.jev.save({key:fakeKey,confirm:true});
  assert.deepEqual(saved,{supported:true,registered:true,connection:'unverified',checkedAt:null,integration:'disconnected',enabled:false});
  assert.ok(!JSON.stringify(saved).includes(fakeKey));
  assert.deepEqual(f.counts(),{writes:1,reads:2});
  assert.deepEqual(new JevSettings({store:f.store}).status(),saved);
  f.jev.save({key:fakeKey+'-replacement',confirm:true}); assert.equal(f.counts().writes,2);
});
test('invalid input and confirmation cannot write; unavailable or ambiguous storage never reports success', () => {
  const f = fixture();
  for (const body of [null,[],{}, {key:fakeKey}, {key:fakeKey,confirm:false}, {key:fakeKey,confirm:true,enabled:true},
    ...['short', fakeKey+'\n', ' '+fakeKey, 'x'.repeat(1025), '秘密'.repeat(16)].map(key=>({key,confirm:true}))]) {
    assert.throws(()=>f.jev.save(body),/jev_key_invalid/);
  }
  assert.equal(f.counts().writes,0);
  assert.equal(new JevSettings({store:{}}).status().supported,false);
  assert.equal(new JevSettings({store:f.store,dry:true}).status().supported,false);
  assert.throws(()=>new JevSettings({store:{putJev(){},jevStatus:()=>false}}).save({key:fakeKey,confirm:true}),/unavailable/);
  assert.throws(()=>new JevSettings({store:{putJev(){},jevStatus:()=>null}}).status(),/unavailable/);
});
test('local authenticated routes require same-origin browser writes and return fixed failure messages', () => {
  const f = fixture(); let result, remote = false;
  const r = routes({PORT:4545,fromRemote:()=>remote,jev:f.jev,send:(res,status,body)=>{result={status,body};}});
  const url = new URL('http://127.0.0.1:4545/api/jev/key');
  const req = {method:'POST',headers:{'x-hub':'1',origin:url.origin}};
  for(const headers of [{},{'x-hub':'1'},{'x-hub':'1',origin:'https://outside.invalid'}]) {
    r.write.handle({...req,headers},null,url,{key:fakeKey,confirm:true}); assert.equal(result.status,403);
  }
  remote = true; r.write.handle(req,null,url,{key:fakeKey,confirm:true}); assert.equal(result.status,403); remote=false;
  assert.equal(f.counts().writes,0);
  r.write.handle(req,null,url,{key:fakeKey,confirm:true}); assert.equal(result.status,200);
  r.read.handle({headers:{'x-hub':'1'}},null); assert.equal(result.body.registered,true);
  f.store.putJev=()=>{throw Error(fakeKey);};
  r.write.handle(req,null,url,{key:fakeKey,confirm:true}); assert.equal(result.status,409);
  assert.ok(!JSON.stringify(result).includes(fakeKey)); assert.equal(f.counts().writes,1);
  f.store.jevStatus=()=>{throw Error(fakeKey);};
  r.read.handle({headers:{'x-hub':'1'}},null); assert.equal(result.status,409); assert.ok(!JSON.stringify(result).includes(fakeKey));
});
test('platform adapters send secrets only through stdin/native payload, and status never returns key bytes', () => {
  const {MacSecretStore} = require('../lib/platform/darwin');
  const calls=[];
  const mac=new MacSecretStore({platform:'darwin',run:(file,args,options)=>{
    calls.push({file,args,options}); return options.input.includes('jev-status') ? '{"registered":true}' : options.input.includes('jev-get') ? JSON.stringify({value:fakeKey}) : '{}';
  }});
  mac.putJev(fakeKey); assert.equal(mac.jevStatus(),true);
  assert.equal(calls[0].file,'/usr/bin/swift'); assert.ok(!JSON.stringify(calls[0].args).includes(fakeKey));
  assert.equal(JSON.parse(calls[0].options.input).value,fakeKey);
  assert.deepEqual(JSON.parse(calls[1].options.input),{action:'jev-status'});
  assert.equal(mac.getJev(),fakeKey); assert.deepEqual(JSON.parse(calls[2].options.input),{action:'jev-get'});
  const winCalls=[], win=require('../lib/platform/win32').create({native:{call(action,data){winCalls.push({action,data});return action==='jev-get' ? fakeKey : true;}}}).secretStore();
  win.putJev(fakeKey); assert.equal(win.jevStatus(),true);
  assert.deepEqual(winCalls,[{action:'jev-put',data:{value:fakeKey}},{action:'jev-status',data:undefined}]);
  assert.equal(win.getJev(),fakeKey); assert.deepEqual(winCalls[2],{action:'jev-get',data:undefined});
  assert.match(require('node:fs').readFileSync(require.resolve('../lib/platform/win32-native'),'utf8'), /case "jev-get": value=HubWindowsLicense\.JevGet\(\); break;/);
  const broken=require('../lib/platform/win32').create({native:{call(){throw Error(fakeKey);}}}).secretStore();
  assert.throws(()=>broken.putJev(fakeKey),e=>e.message==='secret_store_unavailable');
});
