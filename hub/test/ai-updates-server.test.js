'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-ai-updates-api-'));
Object.assign(process.env,{HUB_ROOT:root,HUB_AUTH_DIR:path.join(root,'auth'),HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(root,'home'),HUB_STORAGE_GUARD:'',HUB_AUTO_TRANSLATE:'0',HUB_AUTO_UPDATE:'0'});
let server,updates,sessions,base,auth='logged-in',current='0.1.0',gate=null,calls=0,models=0;
test.before(async()=>{
  const probe=require('node:http').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.HUB_PORT=String(port);
  const loaded=require('../server');server=loaded.server;updates=loaded.aiUpdates;sessions=loaded.sessions;
  updates.tools.dry=false;updates.tools.find=ai=>ai==='codex'?'/fixture/codex':'';updates.tools.methods.codex='standalone';
  updates.tools.latest=async()=>{if(gate)await gate;return{version:'0.2.0',source:'fixture'}};
  updates.tools.run=async(file,args)=>{calls++;if(args[0]==='--version')return current;if(args[0]==='update'){current='0.2.0';return'';}models++;return JSON.stringify({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list'}]});};
  updates.accounts.dry=false;updates.accounts.execute=async()=>({stdout:auth==='logged-in'?'Logged in using ChatGPT':auth==='api'?'Logged in using API key':'Not logged in',stderr:''});
  await new Promise(r=>server.listen(port,'127.0.0.1',r));base='http://127.0.0.1:'+port;
});
test.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})});
const headers=()=>Object.fromEntries(fs.readFileSync(process.env.HUB_HEADERS,'utf8').trim().split('\n').map(line=>{const i=line.indexOf(':');return[line.slice(0,i),line.slice(i+1).trim()];}));
const get=route=>fetch(base+route,{headers:{...headers(),Connection:'close'}});
const post=(route,body={},allow=true)=>fetch(base+route,{method:'POST',headers:{...(allow?headers():{}),'Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)});
test('一括APIは認可と固定入力を検証、GETは状態だけを読み、旧APIの対象制限を迂回できない',async()=>{
  assert.equal((await post('/api/ai-tools/update-all',{},false)).status,403);
  assert.equal((await post('/api/ai-tools/update-all',{ai:'codex',command:'evil'})).status,400);
  for(const status of ['logged-out','api']){auth=status;for(const route of ['check','update','models/refresh'])assert.equal((await post('/api/ai-tools/'+route,{ai:'codex'})).status,409);}
  assert.equal(calls,0);const before=calls;await get('/api/ai-tools');assert.equal(calls,before);
  auth='logged-in';const reply=await post('/api/ai-tools/update-all');assert.equal(reply.status,200);const data=await reply.json();assert.equal(data.results.find(r=>r.ai==='codex').state,'updated');assert.equal(models,1);
  const status=await(await get('/api/ai-tools')).json();assert.equal(status.tools.codex.version,'0.2.0');assert.equal(status.tools.codex.updateCheck.available,false);
});
test('HTTP一括の途中は別要求とAI起動を拒否し、終了後は解除する',async()=>{
  let release;gate=new Promise(r=>release=r);const pending=post('/api/ai-tools/update-all');
  const until=Date.now()+2000;while(!updates.tools.isOperating()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  assert.equal(updates.tools.isOperating(),true);assert.equal((await post('/api/ai-tools/update-all')).status,409);
  assert.equal((await post('/api/ai-tools/check',{ai:'codex'})).status,409);
  assert.equal((await post('/api/term/start',{project:'missing',task:'missing',ai:'codex'})).status,409);
  release();gate=null;assert.equal((await pending).status,200);assert.equal(updates.tools.isOperating(),false);
});

test('全画面の更新サマリーは保持結果だけで判定し取得CLIを増やさない', async () => {
  const before = calls;
  const row = updates.data.rows.codex;
  for (const [eligible, ok, available, applicable, expected] of [[true,true,true,true,true], [true,true,true,false,false], [true,true,true,undefined,false], [false,true,true,true,false], [true,false,true,true,false], [true,true,null,true,false], [true,true,false,true,false]]) {
    Object.assign(row, { eligible, check: { ok, available, applicable }, modelsStatus: 'changed' });
    const state = await (await get('/api/state')).json();
    assert.equal(state.aiCliUpdate.available, expected);
  }
  assert.equal(calls, before);
});
test('画面読取の後にAIが開始してもrestart/一括を同じ案内で拒否する', async () => {
  const original = sessions.list;
  const before = calls;
  sessions.list = () => [{ running: true, ai: 'codex', project: 'fixture', task: 'fixture' }];
  try {
    const state = await (await get('/api/state')).json(); assert.equal(state.updateBlocked, true);
    for (const route of ['/api/restart']) {
      const reply = await post(route); assert.equal(reply.status, 409);
      assert.equal((await reply.json()).error, 'AIの作業が終わるまで更新できません。');
    }
    const bulk=await post('/api/ai-tools/update-all');assert.equal(bulk.status,200);assert.equal((await bulk.json()).results.find(r=>r.ai==='codex').state,'busy');
    assert.equal(calls, before); assert.equal(updates.tools.isOperating(), false);
  } finally { sessions.list = original; }
});

test('更新確認HTTPは一覧も返し、順番待ちは延期し、一覧取得までAI開始を排他する', async () => {
  const {chats} = require('../server'); const n = models;
  const reply = await post('/api/ai-tools/check', {ai:'codex'});
  assert.equal(reply.status,200); assert.equal((await reply.json()).models.ok,true); assert.equal(models,n+1);
  chats.queues.set('fixture:fixture',[{ai:'codex',text:'fixture'}]);
  try {
    const busy = await post('/api/ai-tools/check',{ai:'codex'}); assert.equal(busy.status,200);
    const result=await busy.json(); assert.equal(result.models.deferred,true); assert.match(result.models.warning,/順番待ち/); assert.equal(models,n+1);
  } finally { chats.queues.delete('fixture:fixture'); }
  let release; gate=new Promise(r=>release=r); const pending=post('/api/ai-tools/check',{ai:'codex'});
  const until=Date.now()+2000;while(!updates.tools.isOperating()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  try { assert.equal((await post('/api/term/start',{project:'missing',task:'missing',ai:'codex'})).status,409); }
  finally {release();gate=null;}
  assert.equal((await pending).status,200); assert.equal(models,n+2);
});
