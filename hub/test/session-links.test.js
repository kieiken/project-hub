'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { ClaudeSessionSource, LIMITS } = require('../lib/claude-session-source');
const { CodexSessionSource } = require('../lib/codex-session-source');
const { SessionLinks } = require('../lib/session-links');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-links-')), root = path.join(dir, 'hub'), desktop = path.join(dir, 'desktop'), cli = path.join(dir, 'claude/projects'), cwd = path.join(dir, 'original-project'), codexRoot = path.join(dir, 'codex');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  fs.mkdirSync(root); fs.mkdirSync(cwd); fs.mkdirSync(codexRoot);
  const files = [];
  files.push(write(path.join(desktop, 'claude_desktop_config.json'), { auth: 'never-copy-auth', preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'account/org': { groups: [{ id: 'g1', name: 'ERP + 行銷' }, { id: 'g2', name: '影片剪輯' }], assignments: { 'code:local_one': 'g1', 'code:local_two': 'g1', 'code:local_missing': 'g2' }, order: { g1: ['code:local_two', 'code:local_one'] } } } } } }));
  const metadata = [], histories = [];
  for (const [id, title] of [['one', '保留原始標題'], ['two', '未選取會話'], ['missing', '缺少歷史']]) {
    metadata.push(write(path.join(desktop, 'claude-code-sessions/account/org/local_' + id + '.json'), { title, cwd, cliSessionId: 'cli_' + id, sessionId: 'desktop_' + id, lastActivityAt: 1710000000000, permissions: 'never-copy-permissions' }));
    if (id !== 'missing') histories.push(write(path.join(cli, '-original', 'cli_' + id + '.jsonl'), [
      { type: 'user', uuid: 'u1', timestamp: '2024-03-09T16:00:00.000Z', sessionId: 'never-copy-resume', message: { role: 'user', content: [{ type: 'text', text: '原文 <script>保持</script>' }, { type: 'tool_result', content: 'never-copy-tool' }] } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'never-copy-thinking' }, { type: 'text', text: '回答原文' }] } },
      { type: 'user', message: { role: 'user', content: '<local-command-stdout>never-copy-command</local-command-stdout>' } },
      { type: 'user', message: { role: 'user', content: ' <system-reminder>never-copy-instruction</system-reminder>' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'never-copy-meta' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'));
  }
  const codexFile = write(path.join(codexRoot, 'sessions/2024/03/09/rollout-one.jsonl'), [
    { type: 'session_meta', timestamp: '2024-03-09T16:00:00Z', payload: { id: '11111111-1111-1111-1111-111111111111', title: 'Codex 原會話', cwd, source: 'desktop', permissions: 'never-copy-permissions' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 要求' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex 回答' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'never-copy-analysis' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  files.push(...metadata, ...histories, codexFile); let baseline = files.map(hash), clock = 1700000000000;
  t.after(() => { try { assert.deepEqual(files.map(hash), baseline); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const make = extra => new SessionLinks({ root, sources: { claude: new ClaudeSessionSource({ desktopRoot: desktop, cliRoot: cli }), codex: new CodexSessionSource({ root: codexRoot }) }, now: () => clock, guard: async () => true, ...options, ...extra });
  return { dir, root, desktop, cli, cwd, codexRoot, write, metadata, histories, codexFile, make, links: make(), advance: () => { clock += 600001; }, rebaseline: () => { baseline = files.map(hash); } };
}
async function ids(manager) { const found = await manager.inventory(); return Object.fromEntries(found.projects.flatMap(p => p.sessions).map(s => [s.title, s.id])); }
const manifestFile = f => path.join(f.root, '_hub/session-links.json');
function noCopies(f) { assert.equal(fs.existsSync(path.join(f.root, 'Product')), false); assert.equal(fs.existsSync(path.join(f.root, 'Work')), false); assert.equal(fs.existsSync(path.join(f.root, '.ai')), false); if (fs.existsSync(path.join(f.root, '_hub'))) assert.deepEqual(fs.readdirSync(path.join(f.root, '_hub')), ['session-links.json']); }

test('pure source discovery preserves Desktop groups/title/order and combined inventory exposes no paths or provider resume IDs', async t => {
  const f = fixture(t), source = f.links.sources.claude, raw = source.discover();
  assert.equal(raw.sessions.length, 3); assert.equal(raw.sessions[0].projectName, 'ERP + 行銷');
  const inventory = await f.links.inventory(); assert.equal(inventory.projects.length, 3);
  assert.deepEqual(inventory.projects[0].sessions.map(s => s.title), ['未選取會話', '保留原始標題']);
  const publicJSON = JSON.stringify(inventory);
  for (const secret of [f.desktop, f.cli, f.cwd, 'cli_one', '11111111-1111-1111-1111-111111111111', 'never-copy']) assert.equal(publicJSON.includes(secret), false);
  assert.deepEqual(inventory.links, []); assert.equal(fs.existsSync(manifestFile(f)), false); noCopies(f);
});

test('only selected references are atomically saved; no project/task/history copies and original human/AI text remains read only', async t => {
  const f = fixture(t), selected = await ids(f.links), preview = await f.links.preview([selected['保留原始標題'], selected['Codex 原會話'], selected['缺少歷史']]);
  assert.deepEqual(preview.blockers, []); assert.equal(preview.groups.reduce((n,g)=>n+g.messageCount,0), 4); assert.equal(preview.groups.reduce((n,g)=>n+g.missingHistoryCount,0), 1);
  assert.equal(fs.existsSync(manifestFile(f)), false);
  const applied = await f.links.apply({ token: preview.token, confirm: true }); assert.equal(applied.linkedCount, 3); noCopies(f);
  const persisted = fs.readFileSync(manifestFile(f), 'utf8');
  for (const secret of ['原文 <script>', '回答原文', 'Codex 要求', 'never-copy', f.cwd, f.desktop, 'cli_one']) assert.equal(persisted.includes(secret), false);
  assert.equal(applied.links.some(link => link.title === '未選取會話'), false);
  const claude = applied.links.find(link=>link.provider==='claude'&&link.hasTranscript), history = await f.links.history(claude.id);
  assert.deepEqual(history.messages.map(row=>[row.role,row.text]), [['user','原文 <script>保持</script>'],['assistant','回答原文']]);
  const codex = applied.links.find(link=>link.provider==='codex'); assert.equal((await f.links.history(codex.id)).messages.length,2);
  assert.equal((await f.links.history(applied.links.find(link=>!link.hasTranscript).id)).broken,false);
});

test('unknown/duplicate/empty selections, arbitrary client paths and missing confirmation cannot save a link', async t => {
  const f = fixture(t), selected = await ids(f.links);
  for (const selection of [[], ['../../original-project'], [selected['保留原始標題'],selected['保留原始標題']]]) await assert.rejects(f.links.preview(selection), e=>e.code==='selection');
  const preview = await f.links.preview([selected['保留原始標題']]); await assert.rejects(f.links.apply({token:preview.token,confirm:false}),e=>e.code==='confirm');
  assert.equal(fs.existsSync(manifestFile(f)), false); noCopies(f);
});

test('restarts deduplicate the same source; removing a reference never removes its source', async t => {
  const f = fixture(t), selected = await ids(f.links), preview = await f.links.preview([selected['保留原始標題']]);
  const first = await f.links.apply({token:preview.token,confirm:true}), restarted = f.make(), againIDs = await ids(restarted), again = await restarted.preview([againIDs['保留原始標題']]);
  assert.equal(again.groups[0].alreadyLinkedCount,1); const second = await restarted.apply({token:again.token,confirm:true}); assert.equal(second.linkedCount,0); assert.equal(second.skippedCount,1);
  assert.equal((await restarted.remove({id:first.links[0].id,confirm:true})).removed,true); assert.deepEqual(await restarted.list(),[]);
  assert.equal((await restarted.remove({id:first.links[0].id,confirm:true})).removed,false); noCopies(f);
});

test('source content, metadata, destination changes and token expiry reject old confirmation', async t => {
  for (const kind of ['history','metadata','manifest','expiry']) {
    const f=fixture(t), selected=await ids(f.links), preview=await f.links.preview([selected['保留原始標題']]);
    if(kind==='history') {fs.appendFileSync(f.histories[0],JSON.stringify({type:'user',message:{role:'user',content:'later'}})+'\n');f.rebaseline();}
    if(kind==='metadata'){const value=JSON.parse(fs.readFileSync(f.metadata[0]));value.title='changed';fs.writeFileSync(f.metadata[0],JSON.stringify(value));f.rebaseline();}
    if(kind==='manifest')f.write(manifestFile(f),{schema:1,links:[]});
    if(kind==='expiry')f.advance();
    await assert.rejects(f.links.apply({token:preview.token,confirm:true}),e=>e.code==='stale',kind); assert.deepEqual(await f.links.list(),[]);noCopies(f);
  }
});

test('source deletion leaves a visible broken reference and never silently starts a new session', async t => {
  const f=fixture(t), selected=await ids(f.links), preview=await f.links.preview([selected['保留原始標題']]), applied=await f.links.apply({token:preview.token,confirm:true}), original=f.metadata[0]+'.saved';
  fs.renameSync(f.metadata[0],original);
  try {const links=await f.links.list();assert.equal(links.length,1);assert.equal(links[0].broken,true);assert.equal((await f.links.history(links[0].id)).broken,true);await assert.rejects(f.links.referenceFor(links[0].id),e=>e.code==='missing');assert.equal(JSON.parse(fs.readFileSync(manifestFile(f))).links.length,1);}
  finally{fs.renameSync(original,f.metadata[0]);} noCopies(f);
});

test('trusted referenceFor validates original provider ID and existing cwd without exposing it through inventory/history', async t => {
  const f=fixture(t), selected=await ids(f.links), preview=await f.links.preview([selected['保留原始標題'],selected['Codex 原會話']]), applied=await f.links.apply({token:preview.token,confirm:true});
  const claude=await f.links.referenceFor(applied.links.find(x=>x.provider==='claude').id);assert.equal(claude.sourceSessionId,'cli_one');assert.equal(claude.cwd,fs.realpathSync(f.cwd));assert.equal(claude.roots.CLAUDE_CONFIG_DIR,path.dirname(fs.realpathSync(f.cli)));
  const codex=await f.links.referenceFor(applied.links.find(x=>x.provider==='codex').id);assert.equal(codex.sourceSessionId,'11111111-1111-1111-1111-111111111111');assert.equal(fs.realpathSync(codex.cwd),fs.realpathSync(f.cwd));
  const value=JSON.parse(fs.readFileSync(f.metadata[0]));value.cliSessionId='cli_two';fs.writeFileSync(f.metadata[0],JSON.stringify(value));f.rebaseline();
  await assert.rejects(f.links.referenceFor(applied.links.find(x=>x.provider==='claude').id),e=>e.code==='missing'); noCopies(f);
});

test('configured source-root symlink works while escaped candidate links are excluded',async t=>{
  const f=fixture(t), linked=path.join(f.dir,'desktop-link');fs.symlinkSync(f.desktop,linked);
  assert.equal(new ClaudeSessionSource({desktopRoot:linked,cliRoot:f.cli}).discover().sessions.length,3);
  const transcript=f.histories[0],saved=transcript+'.saved';fs.renameSync(transcript,saved);const outside=f.write(path.join(f.dir,'outside.jsonl'),'never-read');fs.symlinkSync(outside,transcript);
  try {const found=f.links.sources.claude.discover().sessions.find(x=>x.title==='保留原始標題');assert.equal(found.hasTranscript,false);} finally{fs.unlinkSync(transcript);fs.renameSync(saved,transcript);}noCopies(f);
});

test('actual stream bytes and text limits reject growing histories rather than copying or truncating',async t=>{
  const f=fixture(t), source=f.links.sources.claude, id=source.discover().sessions.find(x=>x.title==='保留原始標題').id, original=fs.createReadStream, old=LIMITS.fileBytes,size=fs.statSync(f.histories[0]).size;
  try{LIMITS.fileBytes=size+1;let closed=false;fs.createReadStream=(_file,options)=>({async *[Symbol.asyncIterator](){yield Buffer.alloc(size+2,32);},destroy(){if(!closed){fs.closeSync(options.fd);closed=true;}}});await assert.rejects(source.read(id),e=>e.code==='limit');assert.equal(closed,true);}finally{fs.createReadStream=original;LIMITS.fileBytes=old;}noCopies(f);
});

test('external volume loss/second guard rejection prevents all registry writes; active applies cannot race',async t=>{
  let calls=0;const f=fixture(t,{guard:async()=>++calls===1}), selected=await ids(f.links),preview=await f.links.preview([selected['保留原始標題']]);await assert.rejects(f.links.apply({token:preview.token,confirm:true}),e=>e.code==='guard');assert.equal(calls,2);assert.equal(fs.existsSync(manifestFile(f)),false);noCopies(f);
  const g=fixture(t),idsG=await ids(g.links),plan=await g.links.preview([idsG['保留原始標題']]);fs.rmSync(g.root,{recursive:true});await assert.rejects(g.links.apply({token:plan.token,confirm:true}),e=>e.code==='guard');assert.equal(fs.existsSync(g.root),false);
  const h=fixture(t);let entered,release;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);h.links.guard=async()=>{entered();await gate;return true;};const idH=await ids(h.links),planH=await h.links.preview([idH['保留原始標題']]),first=h.links.apply({token:planH.token,confirm:true});await reached;await assert.rejects(h.links.apply({token:planH.token,confirm:true}),e=>e.code==='busy');release();assert.equal((await first).linkedCount,1);noCopies(h);
});

test('failed atomic rename retains old manifest and cleans temporary reference data',async t=>{
  const f=fixture(t),selected=await ids(f.links),plan=await f.links.preview([selected['保留原始標題']]);await f.links.apply({token:plan.token,confirm:true});const before=hash(manifestFile(f));
  f.links.rename=()=>{throw Error('fixture atomic rename failure');};const next=await f.links.preview([selected['未選取會話']]);await assert.rejects(f.links.apply({token:next.token,confirm:true}),/fixture atomic/);assert.equal(hash(manifestFile(f)),before);noCopies(f);
});

test('local HTTP link flow is CSRF protected, old copy API absent and apply blocks quit/restart without creating Hub tasks',async t=>{
  const f=fixture(t),before={...process.env},port=61700+Math.floor(Math.random()*400);Object.assign(process.env,{HUB_LANG:'zh-TW',HUB_ROOT:f.root,HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(f.dir,'ai-home'),HUB_CLAUDE_DESKTOP_DIR:f.desktop,CLAUDE_CONFIG_DIR:path.dirname(f.cli),CODEX_HOME:f.codexRoot,HUB_AUTO_UPDATE:'0',HUB_AUTO_TRANSLATE:'0'});
  const entered=path.join(f.dir,'guard-entered'),release=path.join(f.dir,'guard-release'),guard=f.write(path.join(f.dir,'fake-guard'),'#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync('+JSON.stringify(entered)+',"entered");const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(release)+')){console.log("STATUS=OK");clearInterval(timer);}},10);\n');fs.chmodSync(guard,0o700);process.env.HUB_STORAGE_GUARD=guard;
  const {server,sessions,sessionLinkRunner}=require('../server');await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(async()=>{sessions.stopAll();await new Promise(r=>server.close(r));for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);});const base='http://127.0.0.1:'+port;
  const post=async(route,body,headers={})=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1',...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  assert.ok([404,405].includes((await fetch(base+'/api/claude-import')).status));const inventory=await(await fetch(base+'/api/session-links')).json(),id=inventory.projects.flatMap(x=>x.sessions).find(x=>x.title==='保留原始標題').id;
  assert.equal((await post('/api/session-links/preview',{selected:[id]},{Origin:'https://untrusted.invalid'})).status,403);const preview=await post('/api/session-links/preview',{selected:[id]});assert.equal(preview.status,200);
  const applying=post('/api/session-links/apply',{token:preview.body.token,confirm:true}),until=Date.now()+3000;while(!fs.existsSync(entered)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(fs.existsSync(entered),true);assert.equal((await post('/api/quit',{})).status,409);assert.equal((await post('/api/restart',{})).status,409);fs.writeFileSync(release,'release');const applied=await applying;assert.equal(applied.status,200);assert.equal(applied.body.linkedCount,1);
  const state=await(await fetch(base+'/api/state')).json();assert.deepEqual(state.projects,[]);assert.deepEqual(state.sessions,[]);assert.deepEqual(state.chatting,[]);assert.equal(fs.existsSync(path.join(f.root,'Product')),false);
  const linkId=applied.body.links[0].id;
  assert.equal((await(await fetch(base+'/api/session-links/status?id='+linkId)).json()).phase,'idle');
  assert.equal((await post('/api/session-links/send',{id:linkId,text:'explicit native turn',requestId:'http-fixture-send'})).status,409);
  assert.equal(sessionLinkRunner.status(linkId).code,'unsupported');
  let releaseSend,enteredSend;const sendGate=new Promise(r=>releaseSend=r),sendReached=new Promise(r=>enteredSend=r),send=sessionLinkRunner.send;
  sessionLinkRunner.send=async body=>{sessionLinkRunner.runs.set(body.id,{id:body.id,requestId:body.requestId,cwd:f.cwd,busy:true,phase:'running',texts:new Map(),approvals:new Map()});enteredSend();await sendGate;sessionLinkRunner.runs.get(body.id).busy=false;return sessionLinkRunner.status(body.id);};
  const sending=post('/api/session-links/send',{id:linkId,text:'synthetic only',requestId:'fixture-native-mock'});await sendReached;
  assert.equal((await post('/api/quit',{})).status,409);assert.equal((await post('/api/restart',{})).status,409);
  assert.equal((await post('/api/session-links/remove',{id:linkId,confirm:true})).status,409);
  assert.equal((await(await fetch(base+'/api/session-links/status?id='+linkId)).json()).busy,true);
  releaseSend();assert.equal((await sending).status,200);sessionLinkRunner.send=send;
  const history=await(await fetch(base+'/api/session-links/history?id='+applied.body.links[0].id)).json();assert.equal(history.messages.length,2);assert.equal(JSON.stringify(history).includes('cli_one'),false);assert.equal((await post('/api/session-links/apply',{token:preview.body.token,confirm:true})).status,409);
});

test('CLI-only Claude sessions remain in their original history root when Desktop metadata is unavailable',async t=>{
  const f=fixture(t),sid='22222222-2222-2222-2222-222222222222',file=f.write(path.join(f.cli,'-original',sid+'.jsonl'),[
    {type:'user',sessionId:sid,cwd:f.cwd,timestamp:'2024-03-09T16:00:00Z',message:{role:'user',content:'CLI要求'}},
    {type:'assistant',sessionId:sid,cwd:f.cwd,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'CLI回答'}]}},
    {type:'system',subtype:'turn_duration',sessionId:sid,cwd:f.cwd,timestamp:'2024-03-09T16:01:00Z'},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n'),before=hash(file),source=new ClaudeSessionSource({desktopRoot:path.join(f.dir,'missing-desktop'),cliRoot:f.cli});
  const inventory=source.discover();assert.equal(inventory.supported,true);assert.equal(inventory.sessions.length,1);assert.equal(inventory.sessions[0].source,'Claude CLI');assert.equal(inventory.sessions[0].projectName,path.basename(f.cwd));
  const manager=f.make({sources:{claude:source}}),selection=await ids(manager),preview=await manager.preview(Object.values(selection)),applied=await manager.apply({token:preview.token,confirm:true});
  assert.equal(applied.linkedCount,1);const history=await manager.history(applied.links[0].id);assert.deepEqual(history.messages.map(x=>x.text),['CLI要求','CLI回答']);assert.equal(history.active,false);
  const ref=await manager.referenceFor(applied.links[0].id);assert.equal(ref.sourceSessionId,sid);assert.equal(ref.file,fs.realpathSync(file));assert.equal(hash(file),before);noCopies(f);
});

test('known source warnings and native-runner owned errors use Japanese or Traditional Chinese while provider/user text stays unchanged',async t=>{
  const f=fixture(t),zh=f.make({language:'zh-TW'}),ja=f.make({language:'ja'});
  assert.match(zh.known('Codex history root is unavailable'),/無法讀取/);assert.match(ja.known('Codex history root is unavailable'),/読めません/);
  assert.match(zh.runnerMessage('mismatch','ignored'),/會話 ID/);assert.match(ja.runnerMessage('mismatch','ignored'),/会話 ID/);
  assert.equal(zh.runnerMessage('provider','User-owned error 日本語'), 'User-owned error 日本語');noCopies(f);
});

test('source changes while the final guard is pending reject confirmation before the manifest is written',async t=>{
  const f=fixture(t);let calls=0;f.links.guard=async()=>{if(++calls===2){fs.appendFileSync(f.histories[0],JSON.stringify({type:'user',message:{role:'user',content:'source changed during final guard'}})+'\n');f.rebaseline();}return true;};
  const selected=await ids(f.links),preview=await f.links.preview([selected['保留原始標題']]);await assert.rejects(f.links.apply({token:preview.token,confirm:true}),e=>e.code==='stale');assert.equal(fs.existsSync(manifestFile(f)),false);noCopies(f);
});

test('CLI discovery keeps Desktop first, prioritizes newest metadata and reports partial bounded lists instead of aborting',async t=>{
  const f=fixture(t),old=LIMITS.metadata,sidNew='33333333-3333-3333-3333-333333333333',sidOld='44444444-4444-4444-4444-444444444444';
  const newer=f.write(path.join(f.cli,'-original',sidNew+'.jsonl'),JSON.stringify({type:'queue-operation',sessionId:sidNew})+'\n'+JSON.stringify({type:'user',sessionId:sidNew,cwd:f.cwd,title:'最近CLI'})+'\n');
  const older=f.write(path.join(f.cli,'-original',sidOld+'.jsonl'),JSON.stringify({type:'user',sessionId:sidOld,cwd:f.cwd,title:'舊CLI'})+'\n');fs.utimesSync(older,new Date(1),new Date(1));
  const huge=f.write(path.join(f.cli,'-original','55555555-5555-5555-5555-555555555555.jsonl'),'x'.repeat(65537));
  try{LIMITS.metadata=4;const found=f.links.sources.claude.discover();assert.equal(found.sessions.length,4);assert.ok(found.sessions.some(x=>x.title==='最近CLI'));assert.equal(found.sessions.some(x=>x.title==='舊CLI'),false);assert.ok(found.sessions.some(x=>x.title==='保留原始標題'));assert.ok(found.warnings.length);assert.ok(fs.existsSync(huge));}finally{LIMITS.metadata=old;}noCopies(f);
});
