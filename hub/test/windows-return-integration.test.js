'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const compiler=require('../release-app/compile.cjs');
const repo=path.resolve(__dirname,'../..');
function source(name){return fs.readFileSync(path.join(repo,'hub/purchase-test-app',name+'.cjs'),'utf8');}
function evaluate(name,code,overrides={},globals={}){
 const filename=path.join(repo,'hub/release-app',name+'.cjs'),fallback=createRequire(filename),module={exports:{}};
 const ctx=vm.createContext({module,exports:module.exports,__dirname:path.dirname(filename),Buffer,URL,console,
  process:{platform:'win32',arch:'x64',versions:{node:'22.23.1'},env:{},execPath:'C:\\node.exe'},
  require:id=>Object.hasOwn(overrides,id)?overrides[id]:fallback(id),...globals});
 vm.runInContext(code,ctx,{filename});return {api:module.exports,ctx};
}
test('generated launch configures exactly once through selection and uses its management root',async()=>{
 for(const name of ['purchase','release']) {
  let configured=0,launched=0,windowConfig;
  const runtime={configure:()=>{configured++;return '/synthetic/protected';},verifyPackage(){},port:4545};
  const selected=evaluate('select',compiler.common(source('select')),{'./runtime.cjs':runtime,'node:os':{release:()=> '10.0.22631'},
   './core.cjs':{sha:()=> 'a'.repeat(64)},'node:fs':{readFileSync:()=>Buffer.from('manifest')},
   './update.cjs':{updateStore:root=>{assert.equal(root,'/synthetic/protected');return {};},selectLaunch:()=>({runtime:'/synthetic/runtime',token:'synthetic-confirm'})}}).api;
  const window={create:()=>({launch:config=>{launched++;windowConfig=config;}}),configuration:x=>x};
  const code=name==='release'?compiler.launch(source('launch')):source('launch');
  evaluate('launch',code,{'./runtime.cjs':runtime,'./select.cjs':selected,'./windows-window.cjs':window,'../lib/platform/win32-window':window});
  await new Promise(setImmediate);assert.equal(configured,1);assert.equal(launched,1);
  assert.equal(windowConfig.root,'/synthetic/protected');assert.equal(windowConfig.runtime,'/synthetic/runtime');
 }
});
test('generated configure sets Windows auth location after workspace protection and leaves Mac defaults',()=>{
 for(const platform of ['win32','darwin']) {
  let protectedRoot,verified=0;
  const env={HUB_AUTH_DIR:'/discard/inherited',HUB_WINDOW_LAUNCH:'synthetic-launch',OTHER:'retain'},home='/synthetic-home';
  const fileSystem={existsSync:()=>true,mkdirSync(){},statSync:()=>({uid:7,mode:0o700}),readFileSync:()=>JSON.stringify({version:1,product:'project-hub',kind:'public-release'})};
  const code=compiler.runtime(source('runtime'))+'\nverifyPackage=()=>{fixtureVerify();return {arch:"x64"};};prepareWindowsWorkspace=root=>fixtureProtect(root);';
  const {api}=evaluate('runtime',code,{'node:fs':fileSystem,'node:os':{userInfo:()=>({homedir:home})},'./core.cjs':{},'./protocol.cjs':{supported(){}},'../lib/license/storage':{noLinks(){}}},
   {process:{platform,arch:'x64',env,getuid:()=>7},fixtureVerify:()=>verified++,fixtureProtect:root=>{assert.equal(env.HUB_AUTH_DIR,'/discard/inherited');protectedRoot=root;}});
  const root=api.configure('/synthetic-package');assert.equal(verified,1);assert.equal(env.OTHER,'retain');assert.equal(env.HUB_WINDOW_LAUNCH,'synthetic-launch');
  if(platform==='win32'){assert.equal(protectedRoot,root);assert.equal(env.HUB_AUTH_DIR,path.join(root,'_hub/run'));}
  else {assert.equal(protectedRoot,undefined);assert.equal(env.HUB_AUTH_DIR,undefined);}
 }
});
test('license construction shares the platform adapter and retains explicit fixture injection',()=>{
 for(const variant of ['purchase','release'])for(const platform of ['win32','darwin'])for(const injected of [false,true]){
  const calls=[],adapter={machineHint(){}},stop=Error('fixture construction reached');
  const license=evaluate('license',variant==='release'?compiler.license(source('license')):source('license'),{
   [variant==='release'?'./protocol.cjs':'../staging-app/protocol.cjs']:{configFor:()=>({}),endpoint:'https://fixture.invalid'},
   [variant==='release'?'./core.cjs':'../staging-app/runtime.cjs']:{},
   '../lib/license/storage':{LicenseStore:class{},noLinks(){}},'../lib/license/codec':{PAID:[]},
   '../lib/platform':{forPlatform:os=>{calls.push(os);return adapter;}},
   '../lib/license':{License:class{constructor(options){assert.equal(options.machineHint,adapter.machineHint);throw stop;}}}
  }).api;
  assert.throws(()=>license.createLicense('/synthetic-root',{platform,store:{},secret:{},fetcher:()=>{},...(injected?{adapter}:{})}),e=>e===stop);
  assert.deepEqual(calls,injected?[]:[platform]);
 }
});
test('generated picker error response releases the selection lease and does not expose native diagnostics',async()=>{
 let release=0,resumed=0,result;
 const runtime=evaluate('runtime',compiler.runtime(source('runtime'))+'\nmodule.exports.setWorkspace=w=>configured={workspace:w};',
  {'./core.cjs':{},'./protocol.cjs':{},'../lib/license/storage':{noLinks(){}},'./workspace.cjs':{errorMessage:()=> 'generic'}}).api;
 runtime.setWorkspace({});
 const req={method:'POST',headers:{},resume:()=>resumed++},res={};
 await runtime.gate(req,res,new URL('http://localhost/api/data-location/pick'),{
  allowed:()=>true,send:(res,status,data)=>{result={status,...data};},readBody:async()=>({}),
  lifecycle:{waitForPreparation:async()=>{},begin:()=>()=>release++},pickFolder:async()=>{throw Object.assign(Error('private path'),{code:'folder_picker_unavailable'});}
 });
 assert.equal(result.status,409);assert.match(result.error,/フォルダー選択画面を開けませんでした/);assert.doesNotMatch(result.error,/private path/);assert.equal(release,1);assert.equal(resumed,1);
});
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');
function ui(){const a=app();a.context.fixture=snapshot();vm.runInContext('state=fixture;aiTools={codex:{eligible:true,installed:true,version:"1",updateCheck:{ok:true,available:true,applicable:true,latestVersion:"2"}}};',a.context);return a;}
test('unconfigured release data location disables CLI actions and blocks direct calls without requests',async()=>{
 const a=ui();vm.runInContext('state.dataManagementRoot=state.root;drawAiTools()',a.context);
 const html=a.element('#ai-tools').innerHTML;
 for(const selector of ['data-ai-update-all','data-ai-check="codex"','data-ai-update="codex"'])assert.match(html,new RegExp(selector+' disabled'));
 assert.match(html,/data-ai-data-location/);assert.match(html,/先にデータの保存先を選択/);
 a.context.api=()=>assert.fail('no API before workspace selection');
 for(const action of ['check','update','models'])await a.context.runAiTool('codex',action);
 await a.context.runAiUpdateAll();
 let opened=0;a.context.openDataLocation=()=>opened++;a.context.toast=()=>{};
 vm.runInContext('state.aiCliUpdate={available:true}',a.context);await a.context.openUpdate();assert.equal(opened,1);
 a.context.appSettingsAiCallback2703()({target:{closest:s=>s==='[data-ai-data-location]'?{}:null}});assert.equal(opened,2);
});
test('configured release and ordinary Hub retain CLI check path and eligible controls',async()=>{
 for(const release of [false,true]){
  const a=ui();if(release)vm.runInContext('state.dataManagementRoot="/protected-management"',a.context);
  vm.runInContext('drawAiTools()',a.context);assert.doesNotMatch(a.element('#ai-tools').innerHTML,/data-ai-data-location|data-ai-update-all disabled|data-ai-update="codex" disabled/);
  let requests=0;a.context.api=async route=>{requests++;assert.equal(route,'/api/ai-tools/check');return {};};a.context.loadAiTools=async()=>{};
  await a.context.runAiTool('codex','check');assert.equal(requests,1);
 }
});
test('data location picker shows waiting, success, cancellation and failure without applying a workspace',async()=>{
 for(const outcome of ['success','cancel','failure']){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,value:'keep',textContent:'',addEventListener(){},replaceChildren(){}});return nodes.get(id);};
  const button={dataset:{locationPick:'workspace'},textContent:'選ぶ',disabled:false};node('#data-location').querySelectorAll=()=>[button];node('#data-location').querySelector=()=>node('#data-location-feedback');let finish;
  const api=async route=>{if(route==='/api/data-location')return {current:{workspace:'/control'},standard:{workspace:'/standard'},pending:null};assert.equal(route,'/api/data-location/pick');return new Promise((resolve,reject)=>{finish=()=>outcome==='failure'?reject(Error('選択画面を開けません')):resolve(outcome==='cancel'?{cancelled:true}:{folder:'/chosen'});});};
  const context=vm.createContext({UI:require('./ui-locale-fixture')(),$:node,api,esc:x=>x,document:{}});
  vm.runInContext(fs.readFileSync(path.join(repo,'hub/public/data-location.js'),'utf8'),context);await context.loadDataLocation();
  const pending=button.onclick();assert.equal(button.disabled,true);assert.match(button.textContent,/選択画面を開いて/);
  finish();await pending;assert.equal(button.disabled,false);assert.equal(button.textContent,'選ぶ');
  assert.match(node('#data-location-feedback').textContent,outcome==='success'?/候補を入力/:outcome==='cancel'?/取り消しました/:/開けません/);
  assert.equal(node('#data-location-workspace').value,outcome==='success'?'/chosen':'keep');
 }
});
