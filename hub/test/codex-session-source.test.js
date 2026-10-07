'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{CodexSessionSource}=require('../lib/codex-session-source');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const item=(role,text,extra={})=>({timestamp:'2026-10-07T08:00:00Z',type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}],...extra}});
function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'codex-source-fixture-')),root=path.join(base,'codex'),cwd=path.join(base,'project');fs.mkdirSync(root);fs.mkdirSync(cwd);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
 const history=(id,rows=[],extra={},archive=false)=>write(path.join(root,archive?'archived_sessions':'sessions/2026/10/07',`rollout-${id}.jsonl`),[{type:'session_meta',timestamp:'2026-10-01T00:00:00Z',payload:{id,cwd,originator:'codex_cli_rs',source:'cli',...extra}},...rows].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const source=options=>new CodexSessionSource({root,env:{},...options});
 const snapshot=()=>{const values=[];function walk(directory){for(const name of fs.readdirSync(directory).sort()){const file=path.join(directory,name),s=fs.lstatSync(file,{bigint:true});if(s.isSymbolicLink()){values.push([path.relative(base,file),'link',fs.readlinkSync(file)]);continue;}if(s.isDirectory())walk(file);else values.push([path.relative(base,file),s.size.toString(),s.mtimeNs.toString(),digest(file)]);}}walk(base);return values;};
 function database(dir=root,version=5){fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`state_${version}.sqlite`),db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,name TEXT,cwd TEXT,created_at INTEGER,updated_at_ms INTEGER,source TEXT,originator TEXT,project_id TEXT,archived INTEGER); CREATE TABLE auth_secrets(token TEXT); INSERT INTO auth_secrets VALUES (\'NEVER RETAIN THIS\');');return{file,db,add:row=>db.prepare('INSERT INTO threads (id,rollout_path,title,name,cwd,created_at,updated_at_ms,source,originator,project_id,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.file||'',row.title||'',row.name||'',row.cwd||cwd,1759276800,row.updated||1791360000000,row.source||'cli',row.originator||'',row.projectId||'',row.archived||0)};}
 return{base,root,cwd,write,history,source,snapshot,database};
}
test('SQLite/index/header metadata merge preserves recent App title, provenance, stable opaque IDs and local archive location without writes',async t=>{
 const f=fixture(t),file=f.history('thread-one',[item('user','Original text')],{source:'vscode',originator:'codex_desktop'}),archived=f.history('thread-two',[],{},true),db=f.database();
 db.add({id:'thread-one',file,title:'Old automatic title',source:'vscode',updated:1791360000000});db.add({id:'thread-two',file:archived,title:'Archive',archived:0});db.db.close();
 f.write(path.join(f.root,'session_index.jsonl'),JSON.stringify({id:'thread-one',thread_name:'Latest App title',updated_at:'2026-10-08T00:00:00Z'})+'\n');
 const before=f.snapshot(),source=f.source(),result=await source.discover();assert.equal(result.sessions.length,2);const one=result.sessions.find(session=>session.title==='Latest App title');assert.ok(one);assert.equal(one.source,'Desktop');assert.equal(one.originator,'codex_desktop');assert.match(one.id,/^codex_[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),/rollout_path|NEVER RETAIN THIS|thread-one/);assert.equal(result.sessions.find(session=>session.title==='Archive').archived,true);
 assert.equal((await f.source().discover()).sessions.find(session=>session.title==='Latest App title').id,one.id);assert.deepEqual(f.snapshot(),before);
});
test('WAL metadata with and without shm remains byte/mtime/name read-only and uses explicit bounded header fallback',async t=>{
 for(const removeShm of [false,true]){
  const f=fixture(t),file=f.history('wal-thread',[item('user','Text')]),db=f.database();let closed=false;
  try{
   db.db.exec('PRAGMA journal_mode=WAL');db.add({id:'wal-thread',file,title:'Uncheckpointed SQLite name'});
   if(removeShm){
    // Windows cannot unlink a live SQLite mapping. Reconstruct the same pending WAL
    // state after closing the writer instead of deleting its open shared-memory file.
    const main=fs.readFileSync(db.file),wal=fs.readFileSync(db.file+'-wal');db.db.close();closed=true;
    fs.writeFileSync(db.file,main);fs.writeFileSync(db.file+'-wal',wal);if(fs.existsSync(db.file+'-shm'))fs.unlinkSync(db.file+'-shm');
    assert.ok(wal.length>0);assert.equal(fs.existsSync(db.file+'-shm'),false);
   }
   const before=f.snapshot(),result=await f.source().discover();assert.equal(result.sessions.length,1);assert.match(result.warnings.join(' '),/pending journal/);assert.notEqual(result.sessions[0].title,'Uncheckpointed SQLite name');assert.deepEqual(f.snapshot(),before);
  }finally{if(!closed)db.db.close();}
 }
});
test('Separate SQLite roots/env work, old index names do not override newer DB title, and App Server is not guessed to be Desktop',async t=>{
 const f=fixture(t),file=f.history('thread-one',[],{source:'appServer',originator:'custom-client'}),sqlite=path.join(f.base,'sqlite'),db=f.database(sqlite);db.add({id:'thread-one',file,title:'Newer SQLite title',source:'appServer',originator:'custom-client',updated:1791446400000});db.db.close();
 f.write(path.join(f.root,'session_index.jsonl'),JSON.stringify({id:'thread-one',thread_name:'Old index title',updated_at:'2026-10-01T00:00:00Z'})+'\n');
 const source=new CodexSessionSource({env:{CODEX_HOME:f.root,CODEX_SQLITE_HOME:sqlite}}),result=await source.discover();assert.equal(result.sessions[0].title,'Newer SQLite title');assert.equal(result.sessions[0].source,'unknown');assert.equal(result.sessions[0].sourceKind,'appServer');
 assert.equal((await f.source({sqliteRoot:sqlite}).discover()).sessions[0].id,result.sessions[0].id);
});
test('Canonical text excludes analysis, tools, images, system/developer and duplicate events but preserves repeated text in distinct turns',async t=>{
 const f=fixture(t),rows=[item('user','Repeat'),{type:'event_msg',payload:{type:'user_message',message:'Repeat'}},item('assistant','Reply',{id:'message-one'}),{type:'event_msg',payload:{type:'agent_message',message:'Reply'}},item('assistant','Reply',{id:'message-one'}),item('user','Repeat'),item('assistant','Reply',{id:'message-two'}),item('assistant','PRIVATE ANALYSIS',{channel:'analysis'}),item('developer','PRIVATE RULE'),item('system','PRIVATE SYSTEM'),{type:'response_item',payload:{type:'function_call_output',output:'PRIVATE TOOL'}},item('assistant','Public',{content:[{type:'output_text',text:'Public'},{type:'image',image_url:'PRIVATE IMAGE'},{type:'tool_result',text:'PRIVATE TOOL'}]})];
 const file=f.history('messages',rows,{instructions:'PRIVATE HEADER PROMPT'}),before=f.snapshot(),source=f.source(),session=(await source.discover()).sessions[0],read=await source.read(session);
 assert.deepEqual(read.rows.map(row=>[row.role,row.text]),[['user','Repeat'],['assistant','Reply'],['user','Repeat'],['assistant','Reply'],['assistant','Public']]);assert.doesNotMatch(JSON.stringify(read),/PRIVATE/);assert.equal(read.signature,digest(file));assert.match(source.fingerprint(session),/^[a-f0-9]{64}$/);
 assert.deepEqual(await source.read(session,{expectedSignature:read.signature}),read);await assert.rejects(source.read(session,{expectedSignature:'wrong'}),{code:'stale'});assert.deepEqual(f.snapshot(),before);
});
test('Subagent metadata keeps an opaque parent relation rather than treating child CLI originator as an ordinary CLI session',async t=>{
 const f=fixture(t);f.history('parent');f.history('child',[],{source:{subagent:{thread_spawn:{parent_thread_id:'parent',depth:1}}},originator:'codex_cli_rs'});
 const sessions=(await f.source().discover()).sessions,parent=sessions.find(session=>!session.isSubagent),child=sessions.find(session=>session.isSubagent);assert.equal(child.source,'unknown');assert.equal(child.sourceKind,'subAgent');assert.equal(child.parentId,parent.id);assert.doesNotMatch(JSON.stringify(sessions),/parent_thread_id|depth/);
});
test('Inventory reads only bounded headers/index and never auth/config or code-folder contents; huge history bodies are not read',async t=>{
 const f=fixture(t),file=f.history('large');fs.appendFileSync(file,'x'.repeat(256*1024));f.write(path.join(f.root,'auth.json'),'SECRET AUTH');f.write(path.join(f.root,'config.toml'),'SECRET CONFIG');f.write(path.join(f.cwd,'secret.jsonl'),'SECRET CODE');
 const readSync=fs.readSync;let bytes=0;fs.readSync=function(fd,buffer,offset,length,position){const count=readSync.call(this,fd,buffer,offset,length,position);bytes+=count;return count;};t.after(()=>{fs.readSync=readSync;});
 const source=f.source({limits:{headerBytes:1024,fileBytes:2048}}),inventory=await source.discover();assert.equal(inventory.sessions.length,1);assert.ok(bytes<=1024);await assert.rejects(source.read(inventory.sessions[0]),{code:'limit'});
});
test('Opaque lookup rejects arbitrary paths, escaping symlinks and switched roots/files before reading or resuming',async t=>{
 const f=fixture(t),file=f.history('safe',[item('user','Allowed')]),outside=f.write(path.join(f.base,'outside.jsonl'),'PRIVATE OUTSIDE');fs.symlinkSync(outside,path.join(f.root,'sessions/escaped.jsonl'));
 const alias=path.join(f.base,'alias');fs.symlinkSync(f.root,alias);const source=f.source({root:alias}),inventory=await source.discover(),session=inventory.sessions[0];assert.equal(inventory.sessions.length,1);assert.match(inventory.warnings.join(' '),/Linked/);
 await assert.rejects(source.read(outside),{code:'selection'});assert.equal((await source.read({id:session.id,file:outside})).rows[0].text,'Allowed');
 fs.unlinkSync(file);fs.symlinkSync(outside,file);await assert.rejects(source.read(session),{code:'unsafe'});assert.throws(()=>source.referenceFor(session),{code:'unsafe'});
 fs.unlinkSync(alias);fs.symlinkSync(f.cwd,alias);await assert.rejects(source.read(session),{code:'stale'});
});
test('Source stamps, header identity and cwd must still match before trusted same-session resume; reference includes no history',async t=>{
 const f=fixture(t),file=f.history('actual-id',[item('user','Selected')]),source=f.source(),session=(await source.discover()).sessions[0],before=f.snapshot();
 const reference=source.referenceFor(session);assert.equal(reference.sourceSessionId,'actual-id');assert.equal(reference.cwd,f.cwd);assert.equal(reference.roots.codexHome,f.root);assert.equal(reference.file,file);assert.equal(reference.identity,session.identity);assert.doesNotMatch(JSON.stringify(reference),/Selected/);assert.deepEqual(f.snapshot(),before);
 fs.appendFileSync(file,JSON.stringify(item('assistant','New response'))+'\n');await assert.rejects(source.read(session),{code:'stale'});assert.throws(()=>source.fingerprint(session),{code:'stale'});
 const db=f.database();db.add({id:'different-id',file,title:'Wrong metadata mapping'});db.db.close();const next=f.source(),sessions=(await next.discover()).sessions,wrong=sessions.find(session=>session.title==='Wrong metadata mapping');assert.throws(()=>next.referenceFor(wrong),{code:'stale'});
 const valid=sessions.find(session=>session.id!==wrong.id);fs.rmdirSync(f.cwd);assert.throws(()=>next.referenceFor(valid),{code:'missing'});
});
test('Row, line, retained-text and shared total budgets fail without silently truncating human messages',async t=>{
 const f=fixture(t);f.history('limits',[item('user','First'),item('assistant','Second')]);
 for(const limits of [{rows:1},{textBytes:5},{lineBytes:40}]){const source=f.source({limits}),session=(await source.discover()).sessions[0];await assert.rejects(source.read(session),{code:'limit'});}
 const source=f.source(),session=(await source.discover()).sessions[0];await assert.rejects(source.read(session,{budget:{input:256*1024*1024-1,text:0,rows:0}}),{code:'limit'});
 assert.throws(()=>f.source({limits:{rows:10001}}),{code:'limit'});
});
test('A growing selected file is bounded during streaming and otherwise reports stale rather than returning a partial history',async t=>{
 const f=fixture(t),file=f.history('growing',[item('user','Before')]),source=f.source({limits:{fileBytes:1024}}),session=(await source.discover()).sessions[0],create=fs.createReadStream;
 fs.createReadStream=function(...args){const stream=create.apply(this,args);stream.once('data',()=>fs.appendFileSync(file,'x'.repeat(2048)));return stream;};t.after(()=>{fs.createReadStream=create;});await assert.rejects(source.read(session),error=>['limit','stale'].includes(error.code));
});
test('Malformed JSONL is explicit, and legacy-only events are marked unsupported instead of being described as complete empty history',async t=>{
 const f=fixture(t);f.history('legacy',[{type:'event_msg',payload:{type:'user_message',message:'Legacy'}}]);const source=f.source(),session=(await source.discover()).sessions[0],result=await source.read(session);assert.deepEqual(result.rows,[]);assert.match(result.warnings.join(' '),/canonical response/);
 const bad=f.history('bad',[item('user','Good')]);fs.appendFileSync(bad,'{invalid JSON}\n');const next=f.source(),chosen=(await next.discover()).sessions.find(candidate=>candidate.id!==session.id);await assert.rejects(next.read(chosen),{code:'format'});
});
test('Metadata row/header traversal caps are explicit and absent sources create nothing',async t=>{
 const f=fixture(t);f.history('one');f.history('two');const inventory=await f.source({limits:{metadataRows:1}}).discover();assert.equal(inventory.sessions.length,1);assert.match(inventory.warnings.join(' '),/list is incomplete/);
 const missing=path.join(f.base,'missing'),result=await f.source({root:missing}).discover();assert.deepEqual(result.sessions,[]);assert.equal(fs.existsSync(missing),false);
});
test('Native activity follows the last selected lifecycle event; unknown formats stay unknown and repeated text stays intact',async t=>{
 for(const [events,state]of [[['task_started'],'busy'],[['task_started','task_complete'],'idle'],[['task_started','turn_aborted'],'idle'],[[],'unknown']]){
  const f=fixture(t);f.history('native',[...events.map(type=>({timestamp:'2026-10-07T08:00:00Z',type:'event_msg',payload:{type,private_command:'NEVER RETAIN'}})),item('user','Text')]);const source=f.source(),session=(await source.discover()).sessions[0],fp=source.fingerprint(session),read=await source.read(session,{expectedFingerprint:fp});assert.equal(read.lifecycle.state,state);assert.equal(read.active,state==='busy'?true:state==='idle'?false:null);assert.doesNotMatch(JSON.stringify(read),/NEVER RETAIN/);await assert.rejects(source.read(session,{expectedFingerprint:'wrong'}),{code:'stale'});
 }
});
test('Known native originators classify independently of vscode/exec transport and guardian records remain marked auxiliary',async t=>{
 const f=fixture(t);for(const [id,originator,source]of [['desktop','Codex Desktop','exec'],['work','codex_work_desktop','vscode'],['tui','codex-tui','vscode'],['acp','@agentclientprotocol/codex-acp','vscode']])f.history(id,[],{originator,source,title:id});f.history('guardian',[],{title:'guardian',source:{guardian_other:{reason:'PRIVATE GUARDIAN'}},originator:'codex_cli_rs'});
 const sessions=(await f.source().discover()).sessions,map=Object.fromEntries(sessions.map(session=>[session.title,session]));assert.equal(map.desktop.source,'Desktop');assert.equal(map.work.source,'Desktop');assert.equal(map.tui.source,'CLI');assert.equal(map.acp.source,'unknown');assert.equal(map.guardian.isSubagent,true);assert.equal(map.guardian.source,'unknown');assert.doesNotMatch(JSON.stringify(sessions),/PRIVATE GUARDIAN/);
});
test('Out-of-order index rename records cannot overwrite the newest title',async t=>{
 const f=fixture(t);f.history('rename');f.write(path.join(f.root,'session_index.jsonl'),[{id:'rename',thread_name:'Newest',updated_at:'2026-10-09T00:00:00Z'},{id:'rename',thread_name:'Older',updated_at:'2026-10-08T00:00:00Z'}].map(row=>JSON.stringify(row)).join('\n')+'\n');assert.equal((await f.source().discover()).sessions[0].title,'Newest');
});
test('Metadata limits prioritize an explicit Desktop session over large automation rows rather than returning an empty list',async t=>{
 const f=fixture(t),file=f.history('desktop',[],{originator:'Codex Desktop'}),db=f.database();for(let i=0;i<10;i++)db.add({id:'auto-'+i,title:'Automation',originator:'codex_exec',updated:1791446400000});db.add({id:'desktop',file,title:'Desktop visible',originator:'Codex Desktop',updated:1791360000000});db.db.close();
 const result=await f.source({limits:{metadataRows:2}}).discover();assert.ok(result.sessions.some(session=>session.title==='Desktop visible'));assert.match(result.warnings.join(' '),/prioritizes Desktop/);
});

test('SQLite-only compound source enums retain child/guardian identity without retaining nested payloads or guessing malformed descriptors',async t=>{
 const f=fixture(t),db=f.database();db.db.exec('ALTER TABLE threads ADD COLUMN thread_source TEXT');
 db.add({id:'parent',title:'Parent',source:'cli'});
 db.add({id:'child',title:'Child',source:JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'parent',depth:1,reason:'PRIVATE NESTED REASON'}}}),originator:'codex_cli_rs'});
 db.add({id:'guardian',title:'Guardian',source:JSON.stringify({guardian_other:{reason:'PRIVATE GUARDIAN REASON'}}),originator:'codex_cli_rs'});
 db.add({id:'thread-source',title:'Alternate column',originator:'codex_cli_rs'});db.db.prepare('UPDATE threads SET source=NULL,thread_source=? WHERE id=?').run(JSON.stringify({subAgent:{thread_spawn:{parent_thread_id:'parent'}}}),'thread-source');
 db.add({id:'invalid',title:'Malformed descriptor',source:'{invalid json}',originator:'Codex Desktop'});db.db.close();const before=f.snapshot(),result=await f.source().discover(),map=Object.fromEntries(result.sessions.map(session=>[session.title,session]));
 assert.equal(map.Child.isSubagent,true);assert.equal(map.Child.source,'unknown');assert.equal(map.Child.sourceKind,'subAgent');assert.equal(map.Child.parentId,map.Parent.id);assert.equal(map.Guardian.isSubagent,true);assert.equal(map.Guardian.sourceKind,'guardian');assert.equal(map.Guardian.source,'unknown');assert.equal(map['Alternate column'].parentId,map.Parent.id);assert.equal(map['Alternate column'].isSubagent,true);assert.equal(map['Malformed descriptor'].source,'unknown');assert.equal(map['Malformed descriptor'].sourceKind,'');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|parent_thread_id|depth|reason|invalid json/);assert.deepEqual(f.snapshot(),before);
});
