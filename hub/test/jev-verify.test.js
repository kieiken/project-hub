'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {verifyKey}=require('../lib/jev-verify'),{JevSettings}=require('../lib/jev-settings'),routes=require('../lib/routes/jev-settings');
const fakeKey='fictional-jev-verification-key',time='2026-11-05T01:00:00.000Z';
test('duplicate request errors are consumed without throwing or retrying (review N1)',async()=>{
  let attempts=0;
  const result=await verifyKey(fakeKey,{request:()=>{const req=new EventEmitter();req.destroy=()=>{};
    req.end=()=>{attempts++;queueMicrotask(()=>{req.emit('error',Error(fakeKey));req.emit('error',Error(fakeKey));});};return req;}});
  assert.equal(result,'unavailable');assert.equal(attempts,1);
});
function transport(mode) {
  const calls=[];
  function request(url,options,callback) {
    const req=new EventEmitter();req.destroy=()=>{req.destroyed=true;};
    req.end=()=>{calls.push({url,options});queueMicrotask(()=>{
      if(mode==='timeout')return;
      if(mode==='error'){req.emit('error',Error(fakeKey));return;}
      const res=new EventEmitter();res.statusCode=mode;
      res.headers={location:'https://outside.invalid',secret:fakeKey};
      res.destroy=()=>{res.destroyed=true;};res.read=()=>assert.fail('upstream content must not be read');
      callback(res);assert.equal(res.destroyed,true);
    });};return req;
  }
  return {request,calls};
}
for(const [mode,expected] of [[200,'verified'],[401,'rejected'],[403,'unavailable'],[429,'unavailable'],[500,'unavailable'],[302,'unavailable'],['error','unavailable'],['timeout','unavailable']]) {
  test(`metadata transport ${mode}: fixed TLS GET, no body, no redirects/retries, sanitized result`,async()=>{
    const t=transport(mode), result=await verifyKey(fakeKey,{request:t.request,timeoutMs:10});
    assert.equal(result,expected);assert.equal(t.calls.length,1);
    assert.equal(t.calls[0].url,'https://api.typesafe.ai/v1/models');
    assert.deepEqual(t.calls[0].options,{method:'GET',headers:{Authorization:`Bearer ${fakeKey}`},agent:false});
    assert.ok(!JSON.stringify(result).includes(fakeKey));
  });
}
function fixture(verify=async()=> 'verified') {
  let value=fakeKey,reads=0,writes=0,transportCalls=0;
  const store={jevStatus:()=>value!==null,putJev:key=>{writes++;value=key;},getJev:()=>{reads++;return value;},get(){assert.fail('generic secret reader');}};
  const jev=new JevSettings({store,verify:async key=>{transportCalls++;assert.equal(key,value);return verify();},now:()=>time});
  return {store,jev,counts:()=>({reads,writes,transportCalls})};
}
test('GET/registration never read keys or send; verification returns only state/time; replacement invalidates result even on failed save',async()=>{
  const f=fixture();assert.equal(f.jev.status().connection,'unverified');
  f.jev.save({key:fakeKey,confirm:true});assert.deepEqual(f.counts(),{reads:0,writes:1,transportCalls:0});
  assert.deepEqual(await f.jev.verify({confirm:true}),{connection:'verified',checkedAt:time});
  assert.equal(f.jev.status().connection,'verified');assert.deepEqual(f.counts(),{reads:1,writes:1,transportCalls:1});
  f.jev.save({key:fakeKey+'-new',confirm:true});assert.equal(f.jev.status().checkedAt,null);
  await f.jev.verify({confirm:true});f.store.putJev=()=>{throw Error(fakeKey);};
  assert.throws(()=>f.jev.save({key:fakeKey,confirm:true}));assert.equal(f.jev.status().connection,'unverified');
});
test('concurrency blocks repeat verification and registration, then releases latch after failure',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));
  const first=f.jev.verify({confirm:true});
  await assert.rejects(f.jev.verify({confirm:true}),/jev_busy/);
  assert.throws(()=>f.jev.save({key:fakeKey,confirm:true}),/jev_busy/);
  resolve('unavailable');assert.deepEqual(await first,{connection:'unavailable',checkedAt:time});
  assert.equal(f.jev.busy,false);assert.equal(f.counts().transportCalls,1);
});
test('invalid confirmation, unavailable/dry store and native exceptions cannot send or leak',async()=>{
  const f=fixture();for(const body of [null,[],{}, {confirm:true,key:fakeKey}])await assert.rejects(f.jev.verify(body),/confirm_required/);
  f.store.getJev=()=>{throw Error(fakeKey);};assert.deepEqual(await f.jev.verify({confirm:true}),{connection:'unavailable',checkedAt:time});
  assert.equal(f.counts().transportCalls,0);
  const dry=new JevSettings({store:f.store,dry:true,verify:()=>assert.fail('dry transport'),now:()=>time});
  assert.equal((await dry.verify({confirm:true})).connection,'unavailable');
});
test('POST check enforces local origin, X-Hub, explicit confirmation; response has no key or upstream errors',async()=>{
  const f=fixture();let result,remote=false;
  const r=routes({PORT:4545,jev:f.jev,fromRemote:()=>remote,send:(res,status,body)=>{result={status,body};}});
  const req={method:'POST',headers:{origin:'http://localhost:4545','x-hub':'1'}},url=new URL('http://localhost:4545/api/jev/verify');
  assert.ok(r.verify.matches(req,url));assert.equal(r.verify.matches({...req,method:'GET'},url),false);
  for(const headers of [{},{'x-hub':'1'},{origin:req.headers.origin},{...req.headers,origin:'https://outside.invalid'}]){
    await r.verify.handle({...req,headers},null,url,{confirm:true});assert.equal(result.status,403);
  }
  remote=true;await r.verify.handle(req,null,url,{confirm:true});assert.equal(result.status,403);remote=false;
  assert.equal(f.counts().reads,0);
  await r.verify.handle(req,null,url,{});assert.equal(result.status,400);
  await r.verify.handle(req,null,url,{confirm:true});assert.deepEqual(result,{status:200,body:{connection:'verified',checkedAt:time}});
  assert.ok(!JSON.stringify(result).includes(fakeKey));
  const source=require('node:fs').readFileSync(require.resolve('../server'),'utf8');
  assert.match(source,/routes\.jevsettings\.verify\.matches\(req, url\).*routes\.jevsettings\.verify\.handle\(req, res, url, b\)/);
});
