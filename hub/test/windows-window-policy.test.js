'use strict';
// Portable version of the five policy checks returned by the Windows trial.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { applyWindowPolicy } = require('../lib/platform/win32-window-policy');
async function response(options) {
  const server = http.createServer((req, res) => { applyWindowPolicy(res, options); res.end('fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port }, res => {
      res.resume(); res.once('end', () => resolve(res.headers));
    }).on('error', reject));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('Windows window sends restrictive CSP on actual HTTP response', async () => {
  const headers = await response({ platform: 'win32', launch: 'fixture', port: 4545 });
  const policy = headers['content-security-policy'];
  assert(policy.includes("default-src 'self'"));
  assert.equal(policy.split("; ").find(s=>s.startsWith("connect-src ")),"connect-src http://127.0.0.1:4545");
  assert(policy.includes("form-action 'self'"));
  assert(policy.includes("object-src 'none'"));
  assert(!policy.includes('*'));
});
test('ordinary Windows browser receives no new CSP', async () => {
  assert.equal((await response({ platform: 'win32', launch: '', port: 4545 }))['content-security-policy'], undefined);
});
test('Mac receives no new CSP even with window launch environment', async () => {
  assert.equal((await response({ platform: 'darwin', launch: 'fixture', port: 4545 }))['content-security-policy'], undefined);
});
test('invalid port rejects before header construction', () => {
  for (const port of [0, 80, 65536, 4545.5, '4545; *']) {
    assert.throws(() => applyWindowPolicy({ setHeader() { assert.fail('must not set header'); } }, {
      platform: 'win32', launch: 'fixture', port,
    }), /window_policy_port_invalid/);
  }
});
test('non-Windows does not touch an existing response policy', () => {
  applyWindowPolicy({ setHeader() { assert.fail('response must remain unchanged'); } }, {
    platform: 'darwin', launch: 'fixture', port: 4545,
  });
});

// Chromium enforcement test, not a Windows/WebView2 runtime test; loopback only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
let chromium;
try { ({chromium}=require('playwright-core')); }
catch { try { ({chromium}=require(path.join(os.homedir(),'.local/lib/node_modules/openclaw/node_modules/playwright-core'))); } catch {} }
const chrome=process.env.HUB_TEST_CHROME||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'.local/bin/chrome-headless-arm64')].find(p=>fs.existsSync(p));
test('window CSP blocks WebSocket handshakes before a different port receives cookies while own HTTP and SSE work',{skip:!chromium||!chrome},async()=>{
 let upgrades=0,ownPort,otherPort,browser;
 const app=http.createServer((req,res)=>{
  applyWindowPolicy(res,{platform:'win32',launch:'fixture',port:ownPort});
  if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: fixture-event\n\n');}
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');return res.end('{"ok":true}');}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>isolated CSP fixture</title>');
 });
 const other=http.createServer((req,res)=>res.end('must not connect'));
 for(const server of [app,other])server.on('upgrade',(req,socket)=>{upgrades++;socket.destroy();});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));ownPort=app.address().port;
 await new Promise(r=>other.listen(0,'127.0.0.1',r));otherPort=other.address().port;
 try {
  browser=await chromium.launch({executablePath:chrome,headless:true});
  const context=await browser.newContext();await context.addCookies([{name:'hub_owner_fixture',value:'not-a-real-secret',domain:'127.0.0.1',path:'/',httpOnly:true}]);
  const page=await context.newPage();await page.goto('http://127.0.0.1:'+ownPort+'/');
  const urls=[`ws://127.0.0.1:${otherPort}/`,`wss://127.0.0.1:${otherPort}/`,`ws://127.0.0.1:${ownPort}/`,`ws://localhost:${otherPort}/`,`ws://[::1]:${otherPort}/`];
  const result=await page.evaluate(async({urls})=>{
   const blocked=[];document.addEventListener('securitypolicyviolation',e=>{if(e.effectiveDirective==='connect-src')blocked.push(e.blockedURI);});
   const http=await (await fetch('/state')).json();
   const event=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{stream.close();reject(Error('SSE timeout'));},3000),stream=new EventSource('/events');stream.onmessage=e=>{clearTimeout(timeout);stream.close();resolve(e.data);};});
   for(const url of urls){try{new WebSocket(url);}catch{}}
   const deadline=Date.now()+3000;while(blocked.length<urls.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
   return {http,event,blocked};
  },{urls});
  assert.equal(result.http.ok,true);assert.equal(result.event,'fixture-event');assert.deepEqual(result.blocked.sort(),urls.sort());assert.equal(upgrades,0);
 } finally {if(browser)await browser.close();await Promise.all([app,other].map(server=>new Promise(r=>server.close(r))));}
});

test('native Windows launches require the same backend document policy before navigation',()=>{
 const native=fs.readFileSync(path.join(__dirname,'../app/windows/HubWindow.cs'),'utf8'),server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert.match(native,/start\.EnvironmentVariables\["HUB_WINDOW_LAUNCH"\]=Value\("nonce"\)/);
 const handler=server.slice(server.indexOf('const server = http.createServer'));
 assert.ok(handler.indexOf('.applyWindowPolicy(res,')<handler.indexOf('serveStatic('));
 const publicDir=path.join(__dirname,'../public');
 for(const name of fs.readdirSync(publicDir).filter(name=>name.endsWith('.js'))){
  assert.doesNotMatch(fs.readFileSync(path.join(publicDir,name),'utf8'),/new\s+(?:window\.)?WebSocket\s*\(/,name+' unexpectedly needs WebSocket');
 }
});
