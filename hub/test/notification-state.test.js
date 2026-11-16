'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
// This fixture closes/restarts its server on the same port. Keep client sockets
// out of the pool so a cold-state assertion cannot reuse the old server's socket.
const fetch = (url, options = {}) => globalThis.fetch(url, {
  ...options, headers: { ...options.headers, connection: 'close' }
});

test('正式HTTP：待ち順は件数と停止フラグだけを一覧へ出し、解除でETagも変わる', async () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-notification-'));
  const root = path.join(tmp, 'root');
  const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env = { HUB_ROOT:root, HUB_DRY_RUN:'1', HUB_PORT:String(port), HUB_AI_HOME:path.join(tmp,'home'), HUB_FREETALK_HOME:path.join(tmp,'freetalk') };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k,process.env[k]]));
  Object.assign(process.env,env);
  fs.mkdirSync(path.join(root,'_hub'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  const store = new (require('../lib/store').Store)(root);
  const p = store.createProject({name:'Fixture'}).project;
  const waiting = store.createTask(p.id,{title:'順番待ち'}), blocked = store.createTask(p.id,{title:'停止した待ち'}), held = store.createTask(p.id,{title:'停止保留'});
  const explicitWait=store.createTask(p.id,{title:'External wait'});
  require('../lib/task-wait').ended(store,{project:p.id,task:explicitWait.id},{waitReason:'External job at 22:00'});
  const chatDir = path.join(p.dir,'.ai/chat');fs.mkdirSync(chatDir,{recursive:true});
  fs.writeFileSync(path.join(chatDir,waiting.id+'.queue.json'),JSON.stringify([{id:'one',text:'private queued instruction'},{id:'two',text:'another private instruction'}]));
  fs.writeFileSync(path.join(chatDir,blocked.id+'.queue.json'),JSON.stringify([{id:'held',error:'fixture error',limitWaiting:true,text:'private held instruction'}]));
  const heldFile=path.join(chatDir,held.id+'.queue.json');
  const heldBytes=JSON.stringify([{id:'stop-held',stopHeld:true,ai:'codex',model:'GPT-6.1-Sol',text:'private stopped instruction',attachmentDraft:{text:'private draft',attachments:[{id:'retained-image'}]}}]);
  fs.writeFileSync(heldFile,heldBytes);
  let hub = require('../server'), {server} = hub;
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  // Startup now validates existing queues. Create this corrupt display fixture
  // afterward, so the HTTP projection still has to reject uncached invalid data.
  const malformed = store.createTask(p.id,{title:'不正な待ち記録'});
  fs.writeFileSync(path.join(chatDir,malformed.id+'.queue.json'),JSON.stringify([null,'invalid',[]]));
  // 同じポートの停止・再起動を試すため、停止前の接続をクライアントが再利用しない。
  const request = fetch;
  try {
    // Queue loading rejects malformed identities before the state projection.
    // Preserve that protection, then use an empty fixture for the display checks.
    const malformedFile=path.join(chatDir,malformed.id+'.queue.json'), malformedBytes=fs.readFileSync(malformedFile,'utf8');
    const invalid=await request(base+'/api/state');assert.equal(invalid.status,500);assert.match((await invalid.json()).error,/順番待ちの識別/);
    assert.equal(fs.readFileSync(malformedFile,'utf8'),malformedBytes);
    fs.writeFileSync(malformedFile,'[]');
    const response = await request(base+'/api/state'), tag=response.headers.get('etag'), raw=await response.text(), state=JSON.parse(raw);
    assert.equal(response.status,200,raw);
    const tasks=state.projects.find(x=>x.id===p.id).tasks;
    assert.equal(tasks.find(t=>t.id===waiting.id).chatQueueCount,2);
    assert.equal(tasks.find(t=>t.id===waiting.id).chatQueueBlocked,false);
    assert.equal(tasks.find(t=>t.id===blocked.id).chatQueueCount,1);
    assert.equal(tasks.find(t=>t.id===blocked.id).chatQueueBlocked,true);
    assert.equal(tasks.find(t=>t.id===malformed.id).chatQueueBlocked,false);
    assert.equal(tasks.find(t=>t.id===waiting.id).chatQueueHeld,false);
    assert.equal(tasks.find(t=>t.id===blocked.id).chatQueueHeld,false);
    const assertHeld=state=>{
      const t=state.projects.find(x=>x.id===p.id).tasks.find(t=>t.id===held.id);
      assert.equal(t.chatQueueCount,1);assert.equal(t.chatQueueHeld,true);assert.equal(t.chatQueueBlocked,true);
      assert.equal(t.state,'未着手');assert.equal(state.chatting.some(x=>x.project===p.id&&x.task===held.id),false);
      assert.equal(fs.readFileSync(heldFile,'utf8'),heldBytes);
    };
    assertHeld(state);
    assert.doesNotMatch(raw,/private queued instruction|private held instruction|fixture error|private stopped instruction|private draft|retained-image/);
    const wt=tasks.find(t=>t.id===explicitWait.id);assert.equal(wt.state,'処理待ち');assert.equal(wt.waitReason,'External job at 22:00');
    assert.deepEqual(state.chatting,[]);
    // Releasing the global barrier does not release or execute a stopped queue.
    hub.stopControl.pause();
    const resume=await request(base+'/api/ai/resume',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({confirm:true})});
    assert.equal(resume.status,200);assertHeld(await (await request(base+'/api/state')).json());
    // A cold runner reloads the same durable queue and reports it as held.
    hub.stopControl.cleanExit();server.closeAllConnections();await new Promise(r=>server.close(r));
    delete require.cache[require.resolve('../server')];hub=require('../server');server=hub.server;await hub.restoreReady;
    await new Promise(r=>server.listen(port,'127.0.0.1',r));
    assertHeld(await (await request(base+'/api/state')).json());
    // 正式な待ち順APIで1件ずつ外す。本文を一覧へ載せずに件数だけが変わる。
    for(const id of ['one','two']) {
      const r=await request(base+'/api/chat/unqueue',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:p.id,task:waiting.id,id})});
      assert.equal(r.status,200);
    }
    const changed=await request(base+'/api/state',{headers:{'If-None-Match':tag}});
    assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);
    const next=await changed.json();assert.equal(next.projects.find(x=>x.id===p.id).tasks.find(t=>t.id===waiting.id).chatQueueCount,0);
    assert.equal(store.readTask(store.taskFile(p.id,waiting.id)).state,'未着手');
  } finally {
    server.closeAllConnections();await new Promise(r=>server.close(r));
    for(const k of Object.keys(env))if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
