'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../public/local-auth.js'), 'utf8');
function browser(origin = 'http://127.0.0.1:4545', stored = {token:'a'.repeat(64),expires:Date.now()+60000,resources:{'/api/chat/stream':'b'.repeat(64),'/api/file/view':'c'.repeat(64)}}) {
  const calls=[],streams=[];
  const context={URL,Headers,Date,location:new URL(origin+'/'),sessionStorage:{getItem:()=>JSON.stringify(stored)},fetch:async(input,options)=>{calls.push({input,options});return {ok:true};},EventSource:class {constructor(url,options){streams.push({url,options});}}};
  context.window=context;vm.runInNewContext(script,context);
  return {context,calls,streams};
}
test('local API fetch supplies the origin-bound header and prevents forwarding on redirects',async()=>{
 const {context,calls}=browser();
 await context.fetch('/api/state',{headers:{Range:'bytes=0-0'}});
 assert.equal(calls[0].options.headers.get('X-Hub-Token'),'a'.repeat(64));assert.equal(calls[0].options.headers.get('Range'),'bytes=0-0');assert.equal(calls[0].options.redirect,'error');
 await context.fetch('/api/chat/send',{method:'POST',body:'{}',headers:{'X-Hub':'1'}});
 assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.body,'{}');
 const request={url:'http://127.0.0.1:4545/api/task/upload',headers:new Headers({'Content-Type':'application/octet-stream'})};
 await context.fetch(request);assert.equal(calls[2].input,request);assert.equal(calls[2].options.headers.get('Content-Type'),'application/octet-stream');
 for(const url of ['http://127.0.0.1:8080/api/state','https://example.invalid/api/state','/app.js']) {await context.fetch(url);assert.equal(calls.at(-1).options,undefined);}
});
test('SSE and file consumers use separate resource grants, with no API token in URLs',()=>{
 const {context,streams}=browser();new context.EventSource('/api/chat/stream?project=p&task=t');
 const stream=new URL(streams[0].url);assert.equal(stream.searchParams.get('hubResource'),'b'.repeat(64));assert.equal(stream.searchParams.get('project'),'p');assert.ok(!stream.href.includes('a'.repeat(64)));
 const file=context.HubLocalAuth.url('/api/file/view?path=x.pdf');assert.equal(new URL(file).searchParams.get('hubResource'),'c'.repeat(64));
 for(const url of ['/api/state','http://127.0.0.1:8080/api/file/view','blob:http://127.0.0.1:4545/fixture']) assert.equal(context.HubLocalAuth.url(url),url);
});
test('remote iPhone login, absent and expired local sessions receive no local capabilities',async()=>{
 for(const b of [browser('https://hub.tailnet.ts.net'),browser('http://127.0.0.1:4545',null),browser('http://127.0.0.1:4545',{token:'a'.repeat(64),expires:Date.now()-1})]) {
  await b.context.fetch('/api/state');assert.equal(b.calls[0].options,undefined);
  assert.equal(b.context.HubLocalAuth.url('/api/chat/stream'),'/api/chat/stream');
 }
});
test('native reconnect hint survives expiry without extending credentials or enabling browser/remote recovery',async()=>{
 const expired={token:'a'.repeat(64),expires:Date.now()-1,reconnect:true};
 const a=browser('http://127.0.0.1:4545',expired);
 assert.equal(a.context.HubLocalAuth.canReconnect,true);
 await a.context.fetch('/api/state');assert.equal(a.calls[0].options,undefined);
 for(const b of [browser(),browser('https://hub.tailnet.ts.net',expired),browser('http://127.0.0.1:4545',null)]) assert.equal(b.context.HubLocalAuth.canReconnect,false);
});
test('local mutation count protects uploads and drops back to zero after response or rejection without retrying',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/local-auth.js'),'utf8');
 let finish,fail,calls=0;
 const context={URL,Headers,Date,location:new URL('http://127.0.0.1:4545/'),sessionStorage:{getItem:()=>null},fetch:()=>{calls++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});}};
 context.window=context;vm.runInNewContext(source,context);
 const p=context.fetch('/api/upload',{method:'POST',body:'file'});
 assert.equal(context.HubLocalAuth.pendingWrites,1);finish({status:401});await p;
 assert.equal(context.HubLocalAuth.pendingWrites,0);assert.equal(calls,1);
 const q=context.fetch({url:'http://127.0.0.1:4545/api/upload',method:'POST'});
 assert.equal(context.HubLocalAuth.pendingWrites,1);fail(Error('network'));await assert.rejects(q,/network/);
 assert.equal(context.HubLocalAuth.pendingWrites,0);assert.equal(calls,2);
});
