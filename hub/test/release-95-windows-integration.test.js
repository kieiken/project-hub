'use strict';
// Local fixtures only. These do not represent Windows/Mac acceptance runs.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const compile=require('../release-app/compile.cjs');
function load(name,overrides={},append='') {
 const file=path.resolve(__dirname,'../release-app/'+name+'.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const real=m.require.bind(m);
 m.require=id=>Object.hasOwn(overrides,id)?overrides[id]:real(id);
 m._compile(compile[name](fs.readFileSync(path.resolve(__dirname,'../purchase-test-app/'+name+'.cjs'),'utf8'))+append,file);return m.exports;
}
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub95-documents-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'control'),documents=path.join(dir,'relocated-documents'),workspace=path.join(documents,'AI-Workspace');fs.mkdirSync(root);fs.mkdirSync(documents);
 const {Workspace}=load('workspace');let scans=0;const make=(extra={})=>new Workspace({root,home:dir,app:path.join(dir,'app'),guard:()=>{scans++;},documentsDirectory:()=>documents,...extra});
 return {dir,root,documents,workspace,make,scans:()=>scans};
}
test('OS Documents selection creates empty workspace, leases it and commits only when ready',t=>{
 const f=fixture(t),w=f.make();w.open();t.after(()=>w.close());a.equal(w.data.workspace,f.workspace);a.equal(w.external(),true);a.equal(w.read().active,null);a.equal(w.read().attempted,true);
 a.equal(w.status().standard.workspace,f.workspace);a.equal(w.status().standard.freetalk,path.join(f.documents,'freetalk'));a.equal(w.status().standard.exists,true);
 a.throws(()=>require('../lib/workspace-use').acquire([f.workspace]),/workspace_in_use/);w.ready();a.equal(w.read().active.workspace,f.workspace);a.equal(w.read().pending,null);
 w.close();const next=f.make({documentsDirectory:()=>{throw Error('OS lookup failed');}});next.open();a.equal(next.data.workspace,f.workspace);a.equal(next.status().standard.workspace,'');a.equal(next.read().active.workspace,f.workspace);next.close();
});
test('automatic failed startup, cancellation and existing unset records do not trigger automatic retry',async t=>{
 for(const state of ['failed-startup','cancelled','unset'])await t.test(state,t=>{
  const f=fixture(t);let w=f.make();if(state==='unset')w.save({version:1,revision:1,active:null,pending:null});w.open();
  if(state==='cancelled')w.cancel();w.close();let lookups=0;w=f.make({documentsDirectory:()=>{lookups++;return f.documents;}});w.open();t.after(()=>w.close());a.equal(w.data.workspace,f.root);a.equal(w.read().active,null);a.equal(w.read().pending,null);a.equal(lookups,0);
  if(state==='failed-startup')a.match(w.notice,/起動が完了しません/);
 });
});
test('existing manually selected alternate workspace overrides Documents including lookup failure',t=>{
 const f=fixture(t),alternate=path.join(f.dir,'alternate');fs.mkdirSync(alternate);const w=f.make();w.save({version:1,revision:1,active:{workspace:alternate,freetalk:null},pending:null});w.open();w.ready();w.close();
 const prior=fs.readFileSync(w.file);const next=f.make({documentsDirectory:()=>{throw Error('unavailable');}});next.open();a.equal(next.data.workspace,alternate);a.equal(next.status().standard.exists,false);next.close();a.deepEqual(fs.readFileSync(w.file),prior);
});
test('lookup failure, missing documents, lease conflict, legacy process and nonempty data retain evidence and fall back once',async t=>{
 for(const fault of ['lookup','missing','lease','legacy','nonempty','link','management'])await t.test(fault,t=>{
  const f=fixture(t);let options={},release=()=>{};
  if(fault==='lookup')options.documentsDirectory=()=>{throw Error('lookup');};
  if(fault==='missing')options.documentsDirectory=()=>path.join(f.dir,'missing');
  if(fault==='lease'){fs.mkdirSync(f.workspace);const lease=require('../lib/workspace-use').acquire([f.workspace]);release=()=>lease.release();}
  if(fault==='legacy')options.guard=()=>{throw Error('workspace_legacy_running');};
  if(fault==='nonempty'){fs.mkdirSync(f.workspace);fs.writeFileSync(path.join(f.workspace,'keep'),'original');}
  if(fault==='link')fs.symlinkSync(f.root,f.workspace);
  if(fault==='management')options.documentsDirectory=()=>f.root;
  const w=f.make(options);w.open();a.equal(w.data.workspace,f.root);a.equal(w.read().pending,null);a.equal(w.read().active,null);a.match(w.notice,/自動設定できません/);w.close();release();
  const next=f.make({documentsDirectory:()=>a.fail('no automatic retry')});next.open();a.equal(next.data.workspace,f.root);next.close();
  if(fault==='nonempty')a.equal(fs.readFileSync(path.join(f.workspace,'keep'),'utf8'),'original');
  const lease=require('../lib/workspace-use').acquire([f.root]);lease.release();
 });
});
test('failed record save releases automatic data/control leases without committing selection',t=>{
 const f=fixture(t),w=f.make();w.save=()=>{throw Error('write-failed');};a.throws(()=>w.open(),/write-failed/);a.equal(fs.existsSync(w.file),false);
 const lease=require('../lib/workspace-use').acquire([f.root,f.workspace]);lease.release();
});
test('preexisting project and protected rights are retained when automatic selection is made',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.workspace,'Product/既存'),{recursive:true});const file=path.join(f.workspace,'Product/既存/PROJECT.md');fs.writeFileSync(file,'---\nname: 既存\n---\n');
 const rights=path.join(f.root,'registration-result.json');fs.writeFileSync(rights,'fixture unchanged rights');const w=f.make();w.open();a.equal(w.data.workspace,f.workspace);w.ready();w.close();a.equal(fs.readFileSync(rights,'utf8'),'fixture unchanged rights');a.equal(fs.existsSync(path.join(f.workspace,'registration-result.json')),false);a.equal(fs.readFileSync(file,'utf8'),'---\nname: 既存\n---\n');
});
test('Windows OS Documents resolver uses native special-folder location on relocated drive and refuses invalid output',()=>{
 const {create}=require('../lib/platform/win32');let calls=0;
 const p=create({native:{call(action){a.equal(action,'documents');calls++;return 'D:\\document\\利用者\\';}}});a.equal(p.documentsDirectory(),'D:\\document\\利用者\\');a.equal(calls,1);
 for(const output of ['',null,'relative','C:relative','\\root-only','C:\\bad\nname'])a.throws(()=>create({native:{call:()=>output}}).documentsDirectory(),/documents_directory_unavailable/);
 a.throws(()=>create({native:{call(){throw Error('native lookup failed');}}}).documentsDirectory(),/documents_directory_unavailable/);
 const source=fs.readFileSync(path.resolve(__dirname,'../lib/platform/win32-native.js'),'utf8');a.match(source,/case "documents": value=Environment.GetFolderPath\(Environment.SpecialFolder.MyDocuments,Environment.SpecialFolderOption.DoNotVerify\)/);
});
test('Mac OS Documents resolver reads Foundation location only, without HOME fallback or creation',()=>{
 const create=require('../lib/platform/darwin').create;let calls=0;
 const p=create({execFileSync(file,args,opts){calls++;a.equal(file,'/usr/bin/osascript');a.deepEqual(args.slice(0,3),['-l','JavaScript','-e']);a.match(args[3],/NSDocumentDirectory/);a.equal(opts.shell,false);return JSON.stringify('/Volumes/Account/書類');}});a.equal(p.documentsDirectory(),'/Volumes/Account/書類');a.equal(calls,1);
 for(const output of ['invalid json','null','"relative"','"//server/docs"','"/bad\\npath"'])a.throws(()=>create({execFileSync:()=>output}).documentsDirectory(),/documents_directory_unavailable/);
 a.throws(()=>create({execFileSync(){throw Error('OS denied');}}).documentsDirectory(),/documents_directory_unavailable/);
});
test('only the release runtime wires OS Documents into first-start selection',()=>{
 let options;const data={workspace:'/fixture/data',freetalk:null},before=process.env.HUB_ROOT;
 const runtime=load('runtime',{'./core.cjs':{},'./protocol.cjs':{},'./workspace.cjs':{Workspace:class {constructor(x){options=x;}open(){return data;}close(){}}},'../lib/platform':{documentsDirectory:()=>'/fixture/relocated-documents'}},'\nmodule.exports.setFixture=x=>configured=x;');
 const listeners=new Set(process.listeners('exit'));runtime.setFixture({root:'/fixture/control',home:'/fixture/home',base:'/fixture/app'});
 try {a.deepEqual(runtime.openWorkspace(),data);a.equal(options.documentsDirectory(),'/fixture/relocated-documents');a.equal(options.root,'/fixture/control');}
 finally {for(const fn of process.listeners('exit'))if(!listeners.has(fn))process.removeListener('exit',fn);if(before===undefined)delete process.env.HUB_ROOT;else process.env.HUB_ROOT=before;}
 a.doesNotMatch(fs.readFileSync(path.resolve(__dirname,'../purchase-test-app/runtime.cjs'),'utf8'),/documentsDirectory:/);
});
test('Windows reserved locations are case insensitive for equality, descendants and ancestors',()=>{
 // Run the actual inspect method with Windows path semantics and injected IO.
 const disk={lstatSync:()=>({isDirectory:()=>true})},storage={noLinks(){}};
 const source=compile.workspace(fs.readFileSync(path.resolve(__dirname,'../purchase-test-app/workspace.cjs'),'utf8')).replace("process.platform === 'win32'","true");
 const file=path.resolve(__dirname,'../release-app/workspace.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const real=m.require.bind(m);
 m.require=id=>id==='node:path'?path.win32:id==='../lib/platform/file-io'?disk:id==='../lib/license/storage'?storage:real(id);m._compile(source,file);
 const w=new m.exports.Workspace({root:'C:\\Users\\One\\ProjectHub',home:'C:\\Users\\One',app:'D:\\Apps\\ProjectHub'});
 for(const workspace of ['c:\\users\\ONE\\projecthub','C:\\USERS\\one\\PROJECTHUB\\data','c:\\users\\one','d:\\APPS\\projecthub\\data','D:\\apps'])a.throws(()=>w.inspect({workspace}),/workspace_management/);
});
test('runtime identity GET pings skip slow scans; all other data API guards and caller checks remain',async()=>{
 const runtime=load('runtime',{'./core.cjs':{},'./protocol.cjs':{},'./workspace.cjs':load('workspace')},'\nmodule.exports.setFixture=x=>configured=x;');let scans=0,deny=false;
 runtime.setFixture({workspace:{external:()=>true,guard(){scans++;if(deny)throw Error('workspace_legacy_running');}}});
 async function request(method,pathname,allowed=true){const req={method,headers:{},resume(){}};let response;const handled=await runtime.gate(req,{},new URL('http://127.0.0.1'+pathname),{allowed:()=>allowed,send:(_r,status,body)=>response={status,body},updater:{status:()=>({})}});return {handled,response};}
 for(const route of ['/api/ping','/api/ping?challenge=fixture']){a.equal((await request('GET',route)).handled,false);a.equal(scans,0);}
 deny=true;for(const [method,route] of [['HEAD','/api/ping'],['POST','/api/ping'],['GET','/api/state'],['GET','/api/usage'],['GET','/api/accounts'],['POST','/api/ai-tools/check'],['POST','/api/ai-tools/update'],['GET','/api/app-update']])a.equal((await request(method,route)).response.status,409);
 a.equal(scans,8);a.equal((await request('GET','/api/ping',false)).response.status,403);a.equal(scans,8);
});
