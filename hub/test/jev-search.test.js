'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const path = require('node:path'), os = require('node:os'), { EventEmitter } = require('node:events');
const { JevSearchBudget, POLICY } = require('../lib/jev-search-budget');
const { JevSearch, post } = require('../lib/jev-search');
const { JevSettings } = require('../lib/jev-settings');
const { ConversationSearch } = require('../lib/conversation-search');
const { search, rerankCandidates } = require('../lib/conversation-search-worker');
const { sanitize, queryAllowed } = require('../lib/jev-search-privacy');
const key = 'fictional-offline-jev-key-only';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-jev-search-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  let now = new Date('2026-11-05T01:00:00Z'), reads = 0;
  const file = path.join(root, '_hub/jev-search.json'), budget = new JevSearchBudget(file, {now:()=>now});
  const store = { jevStatus:()=>true, putJev(){}, getJev(){ reads++; return key; } };
  return {root, file, budget, store, reads:()=>reads, now:d=>{now=new Date(d);},
    set:s=>fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file)),...s})),
    service:transport=>new JevSearch({budget,store:()=>store,transport})};
}
const candidates = [{index:0,text:'First relevant candidate with enough explanatory text.'},{index:2,text:'Another candidate with detailed relevant explanatory text.'}];
const hits = [{row:11},{row:12},{row:13},{row:14}];
const answer = (scores=[0,2]) => ({data:{answers:Object.fromEntries(scores.map((score,i)=>['Q'+i,{score}])),usage:{input_tokens:333}}});
test('default off, key missing, excluded queries and insufficient candidates never read keys, reserve or send', async t=>{
  const f=fixture(t); let calls=0;const s=f.service(async()=>{calls++;return answer();});
  assert.equal((await s.rerank('search',hits,candidates)).rerank.reason,'off');
  assert.equal(fs.existsSync(f.file),false); f.budget.configure(true);
  f.store.jevStatus=()=>false;assert.equal((await s.rerank('search',hits,candidates)).rerank.reason,'no-key');
  f.store.jevStatus=()=>true;
  assert.equal((await s.rerank('token=super-secret-value',hits,candidates)).rerank.reason,'excluded');
  assert.equal((await s.rerank('search',hits,[])).rerank.reason,'excluded');
  assert.equal(calls,0);assert.equal(f.reads(),0);assert.equal(f.budget.status().requests,0);
});
test('one request ranks eligible positions only, preserves objects/sets, sends no hit metadata, saves no payload/key',async t=>{
  const f=fixture(t);f.budget.configure(true);let calls=0;
  const s=f.service(async(body,k)=>{calls++;assert.equal(k,key);assert.equal(f.budget.status().requests,1);
    assert.equal(body.model,'jev-1.14.0');assert.deepEqual(Object.keys(body),['model','state','questions']);
    assert.deepEqual(body.state,{query:'search',candidates:candidates.map((c,i)=>({id:'C'+i,text:c.text}))});
    return answer(); });
  const r=await s.rerank('search',hits,candidates);
  assert.equal(calls,1);assert.deepEqual(r.hits,[hits[2],hits[1],hits[0],hits[3]]);
  assert.equal(r.hits[0],hits[2]);assert.equal(r.rerank.used,true);assert.deepEqual(hits.map(h=>h.row),[11,12,13,14]);
  const raw=fs.readFileSync(f.file,'utf8');for(const secret of [key,'search"','candidate','answers','Bearer'])assert.ok(!raw.includes(secret));
  assert.equal(f.budget.status().reservedUSD,0.002688);
});
test('ten full Japanese excerpts fit a single bounded batch; other candidates stay in their original positions',async t=>{
  const f=fixture(t);f.budget.configure(true);let calls=0;
  const manyHits=Array.from({length:20},(_,row)=>({row})),many=manyHits.map((h,index)=>({index,text:'検索の説明です。'.repeat(100).slice(0,600)}));
  const s=f.service(async body=>{calls++;assert.equal(body.state.candidates.length,10);assert.ok(Buffer.byteLength(JSON.stringify(body))<24000);return answer(Array(10).fill(1));});
  const r=await s.rerank('検索',manyHits,many);assert.equal(r.rerank.used,true);assert.equal(calls,1);assert.deepEqual(r.hits,manyHits);
});
for(const reason of ['rejected','unavailable','timeout','invalid-response']) test('fallback '+reason+' retains reservation and never resends',async t=>{
  const f=fixture(t);f.budget.configure(true);let calls=0;
  const r=await f.service(async()=>{calls++;return {reason};}).rerank('search',hits,candidates);
  assert.equal(r.hits,hits);assert.equal(r.rerank.reason,reason);assert.equal(calls,1);assert.equal(f.budget.status().requests,1);
  const restart=new JevSearchBudget(f.file,{now:()=>new Date('2026-11-05')});assert.equal(restart.status().requests,1);
});
test('invalid answer / throwing transport cannot change local ranking or release reservation',async t=>{
  const f=fixture(t);f.budget.configure(true);
  for(const transport of [async()=>answer([0]),async()=>answer([0,99]),async()=>({data:{answers:{}}}),async()=>{throw Error(key); }]){
    assert.equal((await f.service(transport).rerank('search',hits,candidates)).hits,hits);
  }
  assert.equal(f.budget.status().requests,4);
});
test('999 / 1000 / 1001 and exact dollar boundaries, with durable restart',t=>{
  const f=fixture(t);f.budget.configure(true);f.set({requests:999,micros:999*POLICY.attemptMicros});
  assert.equal(f.budget.reserve().ok,true);assert.equal(f.budget.status().requests,1000);
  assert.equal(f.budget.reserve().reason,'limit');assert.equal(f.budget.status().requests,1000);
  f.set({requests:0,micros:POLICY.maxMicros-POLICY.attemptMicros});
  assert.equal(f.budget.reserve().ok,true);assert.equal(f.budget.status().reservedUSD,3);
  assert.equal(f.budget.reserve().reason,'limit');
  f.set({requests:0,micros:POLICY.maxMicros-POLICY.attemptMicros+1});assert.equal(f.budget.reserve().reason,'limit');
});
test('UTC month rollover preserves opt-in, rolls once, refuses clock rollback and corrupt records',t=>{
  const f=fixture(t);f.budget.configure(true);f.budget.reserve();f.now('2026-12-01T00:00:00Z');
  assert.equal(f.budget.status().requests,0);assert.equal(f.budget.status().enabled,true);
  assert.equal(f.budget.reserve().ok,true);assert.equal(f.budget.status().requests,1);
  f.now('2026-11-30T23:59:59Z');assert.equal(f.budget.status().available,false);assert.equal(f.budget.reserve().ok,false);
  f.now('2026-12-01');f.set({requests:5,micros:0});assert.equal(f.budget.reserve().ok,false);
  fs.writeFileSync(f.file,'{broken');assert.equal(f.budget.status().enabled,false);assert.throws(()=>f.budget.configure(true));
});
test('parallel searches cannot exceed final slot; results unknown remain reserved; switching off survives restart',async t=>{
  const f=fixture(t);f.budget.configure(true);f.set({requests:999,micros:999*POLICY.attemptMicros});let calls=0,finish;
  const s=f.service(()=>{calls++;return new Promise(r=>{finish=r;});});
  const a=s.rerank('search',hits,candidates),b=s.rerank('search',hits,candidates);
  assert.equal((await b).rerank.reason,'limit');assert.equal(calls,1);assert.equal(f.budget.status().requests,1000);
  f.budget.configure(false);finish({reason:'timeout'});await a;
  assert.equal(new JevSearchBudget(f.file,{now:()=>new Date('2026-11-05')}).status().enabled,false);
});
test('cross-process lock collision, abandoned lock, links and failed durability all fail closed',t=>{
  const f=fixture(t);f.budget.configure(true);fs.mkdirSync(f.file+'.lock');
  assert.equal(new JevSearchBudget(f.file).reserve().ok,false);assert.equal(f.budget.status().requests,0);
  fs.rmdirSync(f.file+'.lock');
  const bad=new JevSearchBudget(f.file,{now:()=>new Date('2026-11-05'),persistence:{syncDirectory(){throw Error('flush');}}});
  assert.equal(bad.reserve().ok,false);assert.equal(f.budget.status().requests,0);
  const elsewhere=path.join(f.root,'elsewhere');fs.renameSync(f.file,elsewhere);fs.symlinkSync(elsewhere,f.file);
  assert.equal(f.budget.reserve().ok,false);assert.equal(f.budget.status().enabled,false);
});
test('ambiguous flush after rename retains the durable reservation and sends nothing',async t=>{
  const f=fixture(t);f.budget.configure(true);
  const b=new JevSearchBudget(f.file,{now:()=>new Date('2026-11-05'),persistence:{syncDirectory(){},withDirectorySync(dir,operation){operation();throw Error('unknown-flush');}}});
  let calls=0;const s=new JevSearch({budget:b,store:()=>f.store,transport:async()=>{calls++;return answer();}});
  assert.equal((await s.rerank('search',hits,candidates)).rerank.reason,'budget-unavailable');
  assert.equal(calls,0);assert.equal(f.budget.status().requests,1);
});
test('independent workers sharing one on-disk ledger never claim the same last monthly slot',async t=>{
  const f=fixture(t);f.budget.configure(true);f.set({requests:999,micros:999*POLICY.attemptMicros});
  const {Worker}=require('node:worker_threads'),workers=[];
  const results=await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
    const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      const {JevSearchBudget}=require(workerData.module);
      const b=new JevSearchBudget(workerData.file,{now:()=>new Date('2026-11-05')});
      parentPort.on('message',()=>parentPort.postMessage(b.reserve()));parentPort.postMessage('ready');`,
      {eval:true,workerData:{module:require.resolve('../lib/jev-search-budget'),file:f.file}});
    workers.push(w);w.on('error',reject);w.on('message',m=>{if(m==='ready'){
      w.ready=true;if(workers.length===4&&workers.every(x=>x.ready))workers.forEach(x=>x.postMessage('go'));
    }else {resolve(m);w.terminate();}});
  })));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(f.budget.status().requests,1000);
});
function fakeRequest(behavior, calls) {
  return (url,opt,callback)=>{
    calls.push({url,opt});const req=new EventEmitter();req.destroy=()=>{};
    req.end=body=>{calls.at(-1).body=body;queueMicrotask(()=>behavior(req,callback));};return req;
  };
}
for(const status of [200,401,403,429,500,302]) test('fixed HTTPS transport status '+status+' has one attempt, no response/header exposure',async()=>{
  const calls=[],r=await post({},key,{request:fakeRequest((req,callback)=>{
    const res=new EventEmitter();res.statusCode=status;res.headers={Location:'https://evil.invalid',secret:key};res.destroy=()=>{};callback(res);
    if(status===200){res.emit('data',Buffer.from(JSON.stringify(answer().data)));res.emit('end');}
  },calls)});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.typesafe.ai/v1/systemone');assert.equal(calls[0].opt.method,'POST');
  assert.ok(!Object.keys(calls[0].opt.headers).some(h=>/Danger|Context/i.test(h)));
  assert.ok(!JSON.stringify(r).includes(key));if(status===401)assert.equal(r.reason,'rejected');else if(status!==200)assert.equal(r.reason,'unavailable');else assert.deepEqual(r.data,answer().data);
});
test('transport timeout, duplicate errors, invalid JSON, oversized response, abort: no retries',async()=>{
  for(const behavior of [()=>{},(req)=>{req.emit('error',Error(key));req.emit('error',Error(key));},(req,cb)=>{
    const r=new EventEmitter();r.statusCode=200;r.destroy=()=>{};cb(r);r.emit('data',Buffer.from('not json'));r.emit('end');
  },(req,cb)=>{const r=new EventEmitter();r.statusCode=200;r.destroy=()=>{};cb(r);r.emit('data',Buffer.alloc(65537));}]){
    const calls=[],r=await post({},key,{request:fakeRequest(behavior,calls),timeoutMs:10});assert.ok(r.reason);assert.equal(calls.length,1);assert.ok(!JSON.stringify(r).includes(key));
  }
  const abort=new AbortController(),calls=[];abort.abort();assert.ok((await post({},key,{signal:abort.signal,request:fakeRequest(()=>{},calls)})).reason);assert.equal(calls.length,0);
});
test('privacy excludes secrets and human quote overlaps, code/images/paths/addresses before truncation',()=>{
  const clean='検索を使うと、保存されている返事の中から必要な項目を見つけることができます。';
  assert.ok(sanitize(clean));
  for(const secret of ['sk-'+'abcdefghijklmnopqrstuvwxyz','password: something','Bearer fake-token','A'.repeat(40)])assert.equal(sanitize(clean+'\n'+secret),'');
  const text=sanitize(clean+'\n「人の発言をそのまま引用します」\n> block quote\n```\ncode data\n```\n![photo](image.png)\nSee https://example.com/a or /Users/example/private');
  for(const absent of ['そのまま','block quote','code data','image.png','example.com','/Users/'])assert.ok(!text.includes(absent));
  assert.equal(queryAllowed('token=hidden'),false);assert.equal(queryAllowed('検索 保存'),true);
});
test('long AI rows are bounded without materializing ngram arrays; secrets beyond snippet end still exclude the row',()=>{
  const long='検索に必要な説明を確認してください。'.repeat(30000);
  assert.equal(Array.from(sanitize(long)).length,600);
  assert.equal(sanitize(long+'\nsecret=not-for-sharing'),'');
});
function sources(f) {
  const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  const rows=[{role:'user',text:'この部分は人が書いたそのままの発言で除外する必要があります。'},
    {role:'assistant',text:'検索を使うと必要な過去の返事を見つけられます。候補を比べて内容を確認する方法を案内します。',at:'2026-11-05T00:00:00Z'},
    {role:'assistant',text:'検索の結果を確認して、必要な作業の記録を探すことができます。別の候補とも比較してください。',at:'2026-11-05T00:01:00Z'},
    {role:'assistant',text:'検索\nこの部分は人が書いたそのままの発言で除外する必要があります。',at:'2026-11-05T00:02:00Z'},
    {role:'assistant',text:'検索の安全な説明で、必要な情報を長い文章で案内しているとします。\ntoken=abcdefghi',at:'2026-11-05T00:03:00Z'}];
  for(const project of ['Project','freetalk']){
    const p=path.join(f.root,'Product',project);
    write(path.join(p,'PROJECT.md'),'---\nname: '+project+'\n'+(project==='freetalk'?'kind: freetalk\n':'')+'---\n');
    write(path.join(p,'.ai/tasks/t.md'),'---\ntitle: Work\n---\n');
    write(path.join(p,'.ai/chat/t.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  return rows;
}
test('fresh selected sources only; human/freetalk/token/changed rows never become external candidates',t=>{
  const f=fixture(t);sources(f);
  const result=search({root:f.root,query:'検索',prepareJev:true});
  assert.equal(result.jevCandidates.length,2);
  for(const c of result.jevCandidates){const hit=result.hits[c.index];assert.equal(hit.project,'Project');assert.equal(hit.role,'assistant');assert.ok(!c.text.includes('人が書いた'));}
  assert.ok(!search({root:f.root,query:'検索'}).jevCandidates);
  fs.appendFileSync(path.join(f.root,'Product/Project/.ai/chat/t.jsonl'),'\n');
  assert.deepEqual(rerankCandidates(f.root,result.hits,'simple'),[]);
});
test('human overlap exclusion spans selected files and malformed evidence stays local',t=>{
  const f=fixture(t);sources(f);
  const folder=path.join(f.root,'Product/Another');fs.mkdirSync(path.join(folder,'.ai/tasks'),{recursive:true});fs.mkdirSync(path.join(folder,'.ai/chat'));
  fs.writeFileSync(path.join(folder,'PROJECT.md'),'---\nname: Another\n---\n');fs.writeFileSync(path.join(folder,'.ai/tasks/t.md'),'---\ntitle: Work\n---\n');
  fs.writeFileSync(path.join(folder,'.ai/chat/t.jsonl'),[
    {role:'user',text:'検索を使うと必要な過去の返事を見つけられます。候補を比べて内容を確認する方法を案内します。'},
    {role:'assistant',text:'検索では、候補の内容を確認してから必要な項目を選びます。過去の説明と現在の状態を比べてください。'}
  ].map(JSON.stringify).join('\n')+'\n');
  const r=search({root:f.root,query:'検索',prepareJev:true});
  assert.ok(!r.jevCandidates.some(c=>c.text.includes('過去の返事を見つけられます')));
  fs.appendFileSync(path.join(folder,'.ai/chat/t.jsonl'),'not-json\n');
  assert.deepEqual(search({root:f.root,query:'検索',prepareJev:true}).jevCandidates,[]);
});
test('only freshly verified archives in detailed mode can supply a snippet; ordinary archive caches are not disclosure proof',t=>{
  const f=fixture(t);sources(f);
  const {randomUUID,createHash}=require('node:crypto'),id=randomUUID(),folder=path.join(f.root,'Product/Project/.ai/chat/history/t',id);
  fs.mkdirSync(folder,{recursive:true});
  const bytes=Buffer.from(JSON.stringify({role:'assistant',at:'2026-10-20',text:'検索の過去の結果を確認すると、その時点の判断と今の状況を比べることができます。必要な部分だけ読んでください。'})+'\n');
  const file=path.join(folder,'1.original');fs.writeFileSync(file,bytes);fs.chmodSync(file,0o600);
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({id,project:'Project',task:'t',stage:'committed',entries:[{kind:'log',existed:true,saved:'1.original',bytes:bytes.length,mode:0o600,digest:createHash('sha256').update(bytes).digest('hex')}]}));
  assert.ok(!search({root:f.root,query:'検索',prepareJev:true}).hits.some(h=>h.archiveId));
  for(let i=0;i<2;i++){
    const r=search({root:f.root,query:'検索',mode:'detailed',prepareJev:true});
    assert.ok(r.jevCandidates.some(c=>r.hits[c.index].archiveId===id));
  }
  fs.appendFileSync(file,'\n');
  const r=search({root:f.root,query:'検索',mode:'detailed',prepareJev:true});assert.ok(!r.hits.some(h=>h.archiveId===id));
});
async function done(s,id) {for(let i=0;i<500;i++){const r=s.get(id);if(r.status!=='running'){assert.equal(r.status,'done');return r;}await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
test('search integration uses one asynchronous rerank, hides private excerpts, preserves context identity',async t=>{
  const f=fixture(t);sources(f);f.budget.configure(true);let calls=0;
  const jev=f.service(async body=>{calls++;return answer(Object.keys(body.questions).map((k,i)=>i*2));});
  const s=new ConversationSearch(f.root,{jev});t.after(()=>s.close());
  const {id}=s.start('検索'),r=await done(s,id);assert.equal(calls,1);assert.equal(r.rerank.used,true);
  assert.ok(!JSON.stringify(r).includes('jevCandidates'));
  const target=r.hits.find(h=>h.project==='Project'&&h.row===1);
  assert.ok((await s.context(id,target.id)).rows.some(row=>row.target&&row.text.includes('過去の返事')));
});
test('cancel before local search finishes cannot send; service cancellation before reservation never reads key',async t=>{
  const f=fixture(t);sources(f);f.budget.configure(true);let calls=0;
  const jev=f.service(async()=>{calls++;return answer();});const s=new ConversationSearch(f.root,{jev});t.after(()=>s.close());
  const {id}=s.start('検索');s.cancel(id);await new Promise(r=>setTimeout(r,80));assert.equal(calls,0);
  const abort=new AbortController();abort.abort();assert.equal((await jev.rerank('search',hits,candidates,{signal:abort.signal})).rerank.reason,'cancelled');assert.equal(f.reads(),0);
});
test('settings switch is explicit, registered-only, strict origin/X-Hub/local, does not send or read key',t=>{
  const f=fixture(t),jev=new JevSettings({store:f.store});jev.search=f.service(async()=>{throw Error('must not send');});
  assert.equal(jev.status().search.enabled,false);assert.throws(()=>jev.configureSearch({enabled:true}));
  const create=require('../lib/routes/jev-settings');let remote=false;
  const routes=create({jev,PORT:1234,fromRemote:()=>remote,send:(res,status,body)=>({status,body})});
  const req={headers:{'x-hub':'1',origin:'http://localhost:1234'}};
  for(const headers of [{origin:'http://localhost:1234'},{'x-hub':'1'},{'x-hub':'1',origin:'https://evil.invalid'}])assert.equal(routes.search.handle({headers},{},null,{enabled:true,confirm:true}).status,403);
  remote=true;assert.equal(routes.search.handle(req,{},null,{enabled:true,confirm:true}).status,403);remote=false;
  assert.equal(routes.search.handle(req,{},null,{enabled:true,confirm:true}).status,200);assert.equal(f.reads(),0);
  f.store.jevStatus=()=>false;assert.throws(()=>jev.configureSearch({enabled:true,confirm:true}));
  assert.equal(jev.configureSearch({enabled:false,confirm:true}).search.enabled,false);
});
