'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {createRequire}=require('node:module');
const compiler=require('../release-app/compile.cjs');
const repo=path.resolve(__dirname,'../..');
const reasons=['PRIVATE_DIRECTORY_ACL','PRIVATE_DIRECTORY_PARENT_OWNER','PRIVATE_DIRECTORY_PARENT_ACL'];
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-feedback-96-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function bridge(t,respond){
 const dir=directory(t),file=path.join(dir,'helper.exe');fs.writeFileSync(file,'fixture helper');
 const native=require('../lib/platform/win32-native').create({paths:path,localAppData:dir,
  guardFactory:()=>({file,digest:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),verify(){},close(){}}),
  execFileSync(_file,_args,options){return respond(JSON.parse(options.input));}
 });
 t.after(()=>native.close());return native;
}
function response(request,overrides={}){return JSON.stringify({id:request.id,ok:false,error:reasons[0],win32:0,...overrides});}
function evaluate(name,code,overrides={},globals={}){
 const filename=path.join(repo,'hub/release-app',name+'.cjs'),fallback=createRequire(filename),module={exports:{}};
 const context={module,exports:module.exports,__dirname:path.dirname(filename),Buffer,URL,console,
  process:{platform:'win32',arch:'x64',env:{},execPath:'C:\\node.exe'},
  require:id=>Object.hasOwn(overrides,id)?overrides[id]:fallback(id),...globals};
 vm.runInNewContext(code,context,{filename});return {api:module.exports,context};
}
function runtime(guard){
 const code=compiler.runtime(fs.readFileSync(path.join(repo,'hub/purchase-test-app/runtime.cjs'),'utf8'))+
  '\nmodule.exports.prepareFixture=(root,expected)=>prepareWindowsWorkspace(root,JSON.parse(JSON.stringify(expected)));';
 return evaluate('runtime',code,{'./core.cjs':{},'./protocol.cjs':{},'../lib/license/storage':{noLinks(){}},
  '../lib/platform/win32-update-store':{privateDirectory:guard}}).api;
}
const ticket={version:1,product:'project-hub',kind:'public-release'};
async function launchError(error){
 let launches=0;const logs=[],process={platform:'win32',env:{},execPath:'C:\\node.exe'};
 const code=compiler.launch(fs.readFileSync(path.join(repo,'hub/purchase-test-app/launch.cjs'),'utf8'));
 evaluate('launch',code,{'./runtime.cjs':{port:4545},'./select.cjs':{select:async()=>{throw error;}},
  './windows-window.cjs':{create(){launches++;throw Error('unexpected launch');}}},
  {process,console:{error:message=>logs.push(message)}});
 await new Promise(setImmediate);assert.equal(launches,0);assert.equal(process.exitCode,1);assert.equal(logs.length,1);
 assert.doesNotMatch(logs[0],/PRIVATE|S-1-5|C:\\|stack|購入試験版/);return logs[0];
}
test('private-directory fixed ACL codes survive both native failure return and nonzero exit',async t=>{
 for(const reason of reasons)for(const mode of ['return','exit'])await t.test(reason+' '+mode,t=>{
  const native=bridge(t,request=>{const out=response(request,{error:reason});if(mode==='exit')throw Object.assign(Error('PRIVATE'),{stdout:out,code:1});return out;});
  assert.throws(()=>native.call('private-directory',{path:'fixture',create:false}),{code:'windows_native_failed',stage:'native-call',reasonCode:reason});
 });
});
test('other native actions, unknown codes and OS access errors never become a workspace ACL refusal',async t=>{
 for(const [name,action,fields,expected] of [
  ['clock','clock',{},'NATIVE_OPERATION_FAILED'],['rename','rename',{},'NATIVE_OPERATION_FAILED'],
  ['unknown','private-directory',{error:'PRIVATE_PATH_OR_MESSAGE'},'NATIVE_OPERATION_FAILED'],
  ['denied','private-directory',{win32:5},'WIN32_5'],['invalid-number','private-directory',{win32:'0'},'NATIVE_OPERATION_FAILED']
 ])await t.test(name,t=>{
  const native=bridge(t,request=>response(request,fields));
  assert.throws(()=>native.call(action),{code:'windows_native_failed',reasonCode:expected});
 });
});
test('malformed, mismatched and ambiguous native failures retain generic failure handling',async t=>{
 for(const fault of ['json','id','timeout','signal','failed-success'])await t.test(fault,t=>{
  const native=bridge(t,request=>{
   if(fault==='json')return 'PRIVATE malformed';
   if(fault==='id')return response(request,{id:'other-request'});
   throw Object.assign(Error('PRIVATE'),{stdout:response(request,{...(fault==='failed-success'?{ok:true,value:true}:{})}),
    ...(fault==='timeout'?{code:'ETIMEDOUT'}:fault==='signal'?{signal:'SIGTERM'}:{code:1})});
  });
  assert.throws(()=>native.call('private-directory'),error=>error.code==='windows_bridge_failed'&&!reasons.includes(error.reasonCode));
 });
});
test('existing management-folder ACL rejection reaches generated release startup without touching its contents',async t=>{
 for(const reason of reasons)await t.test(reason,async t=>{
  const root=directory(t);fs.writeFileSync(path.join(root,'.release-workspace'),JSON.stringify(ticket));
  fs.writeFileSync(path.join(root,'registration-result.json'),'PRIVATE unchanged rights');
  const image=()=>fs.readdirSync(root).sort().map(name=>({name,bytes:fs.readFileSync(path.join(root,name)).toString('hex'),mode:fs.statSync(path.join(root,name)).mode}));
  const before=image();let calls=0;
  const native=bridge(t,request=>{calls++;assert.equal(request.create,false);assert.equal(request.path,root);throw Object.assign(Error('PRIVATE'),{stdout:response(request,{error:reason}),code:1});});
  const api=runtime((dir,create)=>native.call('private-directory',{path:dir,create}));let caught;
  try{api.prepareFixture(root,ticket);}catch(error){caught=error;}
  assert.equal(caught.code,'windows_workspace_acl');assert.equal(calls,1);assert.deepEqual(image(),before);
  const message=await launchError(caught);assert.match(message,/アクセス権が必要な状態と異なる/);assert.match(message,/既存のアクセス権・保存データ・利用権は変更していません/);assert.match(message,/管理者に相談/);
 });
});
test('unknown guard failures preserve identity and generic startup guidance',async t=>{
 for(const fault of [Error('PRIVATE filesystem failure'),Object.assign(Error('PRIVATE'),{code:'windows_native_failed',stage:'native-call',reasonCode:'WIN32_5'}),
  Object.assign(Error('PRIVATE'),{code:'windows_bridge_failed',stage:'native-call',reasonCode:reasons[0]}),
  Object.assign(Error('PRIVATE'),{code:'windows_native_failed',stage:'guard-start',reasonCode:reasons[0]})]){
  const root=directory(t);fs.writeFileSync(path.join(root,'keep'),'unchanged');
  assert.throws(()=>runtime(()=>{throw fault;}).prepareFixture(root,ticket),error=>error===fault);
  assert.equal(fs.readFileSync(path.join(root,'keep'),'utf8'),'unchanged');
  assert.equal(await launchError(fault),'Project Hubを起動できません。再実行せず同じ会話へお知らせください。');
 }
});
test('new workspace retains staging-first initialization and existing valid workspace is verified without ACL repair',t=>{
 const parent=directory(t),root=path.join(parent,'ProjectHub'),calls=[];
 const api=runtime((dir,create)=>{calls.push({dir,create});});api.prepareFixture(root,ticket);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.release-workspace'))),ticket);
 assert.deepEqual(calls.map(call=>call.create),[true,false,false]);assert.equal(calls[0].dir,calls[1].dir);assert.notEqual(calls[0].dir,root);assert.equal(calls[2].dir,root);
 calls.length=0;fs.writeFileSync(path.join(root,'keep'),'existing data');api.prepareFixture(root,ticket);
 assert.deepEqual(calls,[{dir:root,create:false}]);assert.equal(fs.readFileSync(path.join(root,'keep'),'utf8'),'existing data');
});
test('incomplete existing workspace never receives an initialization ticket',t=>{
 const root=directory(t);fs.writeFileSync(path.join(root,'keep'),'existing data');let calls=0;
 assert.throws(()=>runtime((_dir,create)=>{calls++;assert.equal(create,false);}).prepareFixture(root,ticket),/purchase_workspace_incomplete/);
 assert.equal(calls,1);assert.equal(fs.existsSync(path.join(root,'.release-workspace')),false);assert.equal(fs.readFileSync(path.join(root,'keep'),'utf8'),'existing data');
});
test('new-workspace refusal retains its staged files and never publishes a partial root',t=>{
 for(const rejectedCall of [1,2]){
  const parent=directory(t),root=path.join(parent,'ProjectHub');let calls=0;
  const api=runtime(()=>{if(++calls===rejectedCall)throw Object.assign(Error('PRIVATE'),{code:'windows_native_failed',stage:'native-call',reasonCode:reasons[0]});});
  assert.throws(()=>api.prepareFixture(root,ticket),{code:'windows_workspace_acl'});
  assert.equal(fs.existsSync(root),false);const stages=fs.readdirSync(parent);assert.equal(stages.length,1);assert.match(stages[0],/^\.ProjectHub-release-init-/);
  const staged=path.join(parent,stages[0]);assert.equal(fs.existsSync(path.join(staged,'.release-workspace')),rejectedCall===2);assert.equal(calls,rejectedCall);
 }
});
