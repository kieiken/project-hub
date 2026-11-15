'use strict';
// Synthetic local files and injected subprocesses only; no Windows execution.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),c=require('node:crypto'),{EventEmitter}=require('node:events');
const W=require('../release-app/windows-window.cjs'),P=require('../release-app/prepare-windows.cjs');
const sha=b=>c.createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'final-release-windows-window-空 白-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'package');fs.mkdirSync(base);const manifest={kind:'public-release',platform:'win32',arch:'x64',files:[]};
 const put=(rel,bytes)=>{const file=path.join(base,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);fs.chmodSync(file,0o644);manifest.files.push({path:rel,sha256:sha(bytes),bytes:Buffer.byteLength(bytes),mode:0o644});};
 for(const name of W.names)put('window/'+name,'synthetic-'+name);
 const save=()=>fs.writeFileSync(path.join(base,'release-manifest.json'),JSON.stringify(manifest));save();return {root,base,manifest,put,save};}
const configuration=()=>W.configuration({root:'C:\\Data',runtime:'C:\\Hub\\hub',node:'C:\\Hub\\node.exe',port:4545,localAppData:'C:\\Users\\test\\AppData\\Local'});
test('fixed inventory launches bundled window once and never compiles or deletes it',t=>{
 const f=fixture(t);let runs=0,starts=0,child;
 const w=W.create({base:f.base,execFileSync(){runs++;assert.fail('unsigned launch must not run PowerShell');},spawn(file,args,opts){starts++;assert.equal(file,path.join(f.base,'window/ProjectHub.exe'));assert.deepEqual(args,[]);assert.equal(opts.shell,false);child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.stdin=new EventEmitter();child.stdin.end=value=>{child.value=value;};return child;}});
 assert.equal(w.prepare(),path.join(f.base,'window/ProjectHub.exe'));const config=configuration();w.launch(config);assert.deepEqual(JSON.parse(child.value),config);assert.throws(()=>w.launch(config));assert.throws(()=>w.close());child.exitCode=0;w.close();assert.equal(fs.existsSync(path.join(f.base,'window/ProjectHub.exe')),true);assert.equal(runs,0);assert.equal(starts,1);
});
for(const fault of ['missing','tamper','link','duplicate','unexpected'])test('refuses '+fault+' with no dynamic fallback',t=>{
 const f=fixture(t),file=path.join(f.base,'window/ProjectHub.exe');if(fault==='missing')fs.unlinkSync(file);if(fault==='tamper')fs.appendFileSync(file,'bad');if(fault==='link'){fs.unlinkSync(file);fs.symlinkSync('../release-manifest.json',file);}if(fault==='duplicate'){f.manifest.files.push(f.manifest.files[0]);f.save();}if(fault==='unexpected')fs.writeFileSync(path.join(f.base,'window/extra.dll'),'bad');
 let calls=0;const w=W.create({base:f.base,execFileSync(){calls++;},spawn(){calls++;}});assert.throws(()=>w.prepare(),{code:'release_windows_window_unavailable'});assert.throws(()=>w.prepare());assert.equal(calls,0);
});
test('publisher mode verifies valid exact thumbprint and rechecks bytes before spawn',t=>{
 const f=fixture(t),thumb='A'.repeat(40);let calls=0;
 const w=W.create({base:f.base,publisherThumbprint:thumb,execFileSync(file,args,opts){calls++;assert.match(args.at(-1),/Get-AuthenticodeSignature/);assert.match(args.at(-1),/Status -ne 'Valid'/);assert.equal(opts.shell,false);assert.equal(JSON.parse(opts.input).thumbprint,thumb);return JSON.stringify({valid:true,thumbprint:thumb});}});assert.ok(w.prepare());assert.equal(calls,1);
 for(const result of [{valid:false,thumbprint:thumb},{valid:true,thumbprint:'B'.repeat(40)}])assert.throws(()=>W.create({base:f.base,publisherThumbprint:thumb,execFileSync:()=>JSON.stringify(result)}).prepare());
 assert.throws(()=>W.create({base:f.base,publisherThumbprint:thumb,execFileSync(){fs.appendFileSync(path.join(f.base,'window/ProjectHub.exe'),'changed');return JSON.stringify({valid:true,thumbprint:thumb});}}).prepare());
});
test('preparation compiles saved inventoried source locally into separate unsigned output',t=>{
 const f=fixture(t);Object.assign(f.manifest,{version:1,port:4545,shellProtocol:1,source:'a'.repeat(40)});for(const name of ['server.js','release-app/core.cjs','release-app/protocol.cjs','release-app/runtime.cjs','release-app/license.cjs','release-app/launch.cjs','paid-bundle.json'])f.put('hub/'+name,name==='release-app/launch.cjs'?"window.create({base,publisherThumbprint:''});":'synthetic');for(let i=0;i<101;i++)f.put('hub/file-'+i+'.js','synthetic');f.put('hub/app/windows/HubWindow.cs','class HubWindow {}');f.put('hub/app/windows/ProjectHub.ico','synthetic icon');for(const name of W.names.slice(1))f.put('hub/app/windows/vendor/webview2/1.0.4258.31/'+name,'dep-'+name);f.save();const output=path.join(f.root,'unsigned');let calls=0;
 const result=P.prepare({base:f.base,output,platform:'win32',execFileSync(file,args,opts){calls++;assert.match(args.at(-1),/CSharpCodeProvider/);assert.doesNotMatch(args.at(-1),/Set-AuthenticodeSignature|Keychain|SignTool/i);assert.equal(opts.shell,false);const r=JSON.parse(opts.input);assert.equal(r.icon,path.join(f.base,'hub/app/windows/ProjectHub.ico'));assert.equal(r.inputs.at(-1).file,r.icon);assert.equal(r.dependencies.length,3);assert.ok(r.dependencies.every(d=>d.file.endsWith('.dll')));assert.ok(args.at(-1).includes(`/win32icon:"'+$r.icon+'"`));fs.mkdirSync(r.directory);fs.writeFileSync(r.file,'synthetic compiled EXE');fs.chmodSync(r.file,0o644);for(const dep of r.dependencies)fs.copyFileSync(dep.file,path.join(r.directory,path.basename(dep.file)));return JSON.stringify({ok:true,file:r.file});}});
 assert.equal(result.publisherSigned,false);assert.equal(result.requiresManifestRebuildAfterSigning,true);assert.equal(result.files.length,4);assert.equal(calls,1);assert.equal(fs.readFileSync(path.join(f.base,'window/ProjectHub.exe'),'utf8'),'synthetic-ProjectHub.exe');
 const final=path.join(f.root,'final'),r=require('../release-app/finalize-windows.cjs').finalize({base:f.base,prepared:output,output:final,unsigned:true,platform:'win32',arch:'x64',execFileSync:()=>assert.fail('no signature call')});assert.equal(r.publisherSigned,false);assert.equal(r.windowsNativePrepared,true);
 assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync:()=>assert.fail('retry')}));
});
test('changed preparation source refuses before subprocess or output creation',t=>{
 const f=fixture(t);f.put('hub/app/windows/HubWindow.cs','source');f.save();fs.appendFileSync(path.join(f.base,'hub/app/windows/HubWindow.cs'),'bad');let calls=0;const output=path.join(f.root,'unsigned');assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync(){calls++;}}));assert.equal(calls,0);assert.equal(fs.existsSync(output),false);
});

function preparationFixture(t){
 const f=fixture(t);Object.assign(f.manifest,{version:1,port:4545,shellProtocol:1,source:'a'.repeat(40)});
 for(const name of ['server.js','release-app/core.cjs','release-app/protocol.cjs','release-app/runtime.cjs','release-app/license.cjs','release-app/launch.cjs','paid-bundle.json'])f.put('hub/'+name,name==='release-app/launch.cjs'?"window.create({base,publisherThumbprint:''});":'synthetic');
 for(let i=0;i<101;i++)f.put('hub/file-'+i+'.js','synthetic');
 f.put('hub/app/windows/HubWindow.cs','class HubWindow {}');f.put('hub/app/windows/ProjectHub.ico','synthetic icon');for(const name of W.names.slice(1))f.put('hub/app/windows/vendor/webview2/1.0.4258.31/'+name,'dep-'+name);f.save();return f;
}
test('preparation isolates OS module resolution and reports input-hash failure once without changing parent or input',t=>{
 for(const systemRoot of ['C:\\Windows','D:\\Windows']){
  const f=preparationFixture(t),output=path.join(f.root,'prepared'),before=fs.readFileSync(path.join(f.base,'release-manifest.json'));
  const env=Object.freeze({PSModulePath:'C:\\Codex\\PS7\\Modules',PsModulePath:'C:\\other',PATH:'keep-path',TEMP:'keep-temp',PSExecutionPolicyPreference:'Restricted'});let calls=0,caught;
  try{P.prepare({base:f.base,output,platform:'win32',systemRoot,env,execFileSync(exe,args,opts){
   calls++;assert.equal(exe,path.win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'));
   assert.deepEqual(Object.keys(opts.env).filter(k=>k.toLowerCase()==='psmodulepath'),['PSModulePath']);
   assert.deepEqual(opts.env,{PATH:'keep-path',TEMP:'keep-temp',PSExecutionPolicyPreference:'Restricted',PSModulePath:path.win32.join(path.win32.dirname(exe),'Modules')});
   assert.deepEqual(args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-Command']);assert.equal(opts.shell,false);assert.deepEqual(opts.stdio,['pipe','pipe','pipe']);
   assert.doesNotMatch(args.at(-1),/ExecutionPolicy|Bypass|Unblock-File|Set-Acl/);
   throw Object.assign(Error('SECRET diagnostic command with private path'),{stderr:'PRIVATE PATH\nHUB_PREPARE_DIAGNOSTIC:'+JSON.stringify({stage:'input_hash',type:'CommandNotFoundException',line:9,message:'SECRET',position:'PRIVATE PATH'})+'\n'});
  }});}catch(e){caught=e;}
  assert.equal(calls,1);assert.equal(caught.code,'release_windows_preparation_failed');assert.deepEqual(caught.diagnostic,{stage:'input_hash',type:'CommandNotFoundException',line:9});
  assert.doesNotMatch(JSON.stringify(caught)+caught.message,/SECRET|PRIVATE|Codex/);assert.equal(caught.cause,undefined);
  assert.equal(env.PSModulePath,'C:\\Codex\\PS7\\Modules');assert.equal(env.PsModulePath,'C:\\other');assert.deepEqual(fs.readFileSync(path.join(f.base,'release-manifest.json')),before);assert.deepEqual(fs.readdirSync(output),[]);
  assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync:()=>assert.fail('no retry of retained output')}));
 }
});
test('preparation keeps compiler error codes but drops unstructured or unapproved diagnostics',t=>{
 for(const [stderr,expected] of [
  ['HUB_PREPARE_DIAGNOSTIC:'+JSON.stringify({stage:'compile',type:'RuntimeException',reason:'compile_failed',line:28,compilerCode:'CS0006',message:'SECRET'}),{stage:'compile',type:'RuntimeException',reason:'compile_failed',line:28,compilerCode:'CS0006'}],
  ['SECRET raw stderr',{stage:'powershell'}],
  ['HUB_PREPARE_DIAGNOSTIC:'+JSON.stringify({stage:'SECRET',type:'SECRET',reason:'SECRET',line:-1,compilerCode:'SECRET'}),{stage:'powershell'}]
 ]){
  const f=preparationFixture(t);let calls=0;
  assert.throws(()=>P.prepare({base:f.base,output:path.join(f.root,'prepared'),platform:'win32',execFileSync(){calls++;throw Object.assign(Error('SECRET'),{stderr});}}),e=>{assert.deepEqual(e.diagnostic,expected);assert.doesNotMatch(JSON.stringify(e),/SECRET/);return true;});assert.equal(calls,1);
 }
});
test('completion CLI prints sanitized preparation diagnostics and exits without finalization',t=>{
 const f=preparationFixture(t),logs=[],vm=require('node:vm'),{createRequire}=require('node:module');
 const filename=path.resolve(__dirname,'../release-app/finish-unsigned-windows.cjs'),actualRequire=createRequire(filename),module={exports:{}};let calls=0;
 const process={platform:'win32',arch:'x64',argv:['node',filename,'--base',f.base]};
 const req=id=>id==='./prepare-windows.cjs'?{prepare(){calls++;throw Object.assign(Error('release_windows_preparation_failed'),{code:'release_windows_preparation_failed',diagnostic:{stage:'input_hash',type:'CommandNotFoundException',line:9}});}}:id==='./finalize-windows.cjs'?{verify:actualRequire(id).verify,finalize:()=>assert.fail('must not finalize failed preparation')}:actualRequire(id);req.main=module;
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:req,module,exports:module.exports,process,console:{log:()=>assert.fail('no success output'),error:v=>logs.push(v)}},{filename});
 assert.equal(calls,1);assert.equal(process.exitCode,1);assert.ok(logs.includes('release_windows_preparation_failed'));assert.deepEqual(JSON.parse(logs.at(-1).slice(23)),{stage:'input_hash',type:'CommandNotFoundException',line:9});assert.equal(fs.existsSync(f.base+'-completion.json'),false);
});

for(const fault of ['missing','changed','unlisted'])test('preparation refuses '+fault+' icon before compiler or output creation',t=>{
 const f=preparationFixture(t),icon=path.join(f.base,'hub/app/windows/ProjectHub.ico'),output=path.join(f.root,'unsigned');
 if(fault==='missing')fs.unlinkSync(icon);
 if(fault==='changed')fs.appendFileSync(icon,'modified');
 if(fault==='unlisted'){f.manifest.files=f.manifest.files.filter(r=>r.path!=='hub/app/windows/ProjectHub.ico');f.save();}
 let calls=0;assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync(){calls++;}}),{code:'release_windows_preparation_failed'});
 assert.equal(calls,0);assert.equal(fs.existsSync(output),false);
});
test('icon modification during compilation refuses receipt and retains output without retry',t=>{
 const f=preparationFixture(t),output=path.join(f.root,'unsigned');let calls=0;
 assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync(_file,_args,opts){
  calls++;const r=JSON.parse(opts.input);fs.mkdirSync(r.directory);fs.writeFileSync(r.file,'synthetic output');
  for(const dep of r.dependencies)fs.copyFileSync(dep.file,path.join(r.directory,path.basename(dep.file)));
  fs.appendFileSync(r.icon,'modified');return JSON.stringify({ok:true,file:r.file});
 }}),{code:'release_windows_preparation_failed'});
 assert.equal(calls,1);assert.equal(fs.existsSync(path.join(output,'window/ProjectHub.exe')),true);assert.equal(fs.existsSync(path.join(output,'preparation.json')),false);
 assert.throws(()=>P.prepare({base:f.base,output,platform:'win32',execFileSync(){assert.fail('must not retry');}}));
});
