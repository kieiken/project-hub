'use strict';
// Build-time derivation from the tested shell. No profile, setting, environment
// variable or downloaded message can select production trust at run time.
const assert=require('node:assert/strict');
function once(s,a,b){assert.equal(s.split(a).length,2,'release_source_boundary_changed');return s.replace(a,b);}
function common(s){return s.replaceAll('../staging-app/runtime.cjs','./core.cjs').replaceAll('../staging-app/protocol.cjs','./protocol.cjs').replaceAll('purchase-test-app/','release-app/').replaceAll('purchase-test-manifest.json','release-manifest.json').replaceAll('public-purchase-test','public-release').replaceAll('TrialUpdate','ReleaseUpdate').replaceAll('purchase-runtime-v1','release-runtime-v1').replaceAll('試験登録','利用コードの登録').replaceAll('試験用の発行先','利用権の発行先').replaceAll('購入試験版は作業','Project Hubは作業').replaceAll('購入試験版を起動','Project Hubを起動');}
function runtime(s){
  s=common(s);
  s=once(s,"  Object.assign(process.env, launch);",`  // Keep owner capabilities beneath the already verified management root.
  // AppData ancestors may grant replacement rights to other Windows accounts.
  if (process.platform === 'win32') process.env.HUB_AUTH_DIR = path.join(root, '_hub', 'run');
  Object.assign(process.env, launch);`);
  s=once(s,"} catch(e) {req.resume();send(res,409,{error:require('./workspace.cjs').errorMessage(e)});}","} catch(e) {req.resume();send(res,409,{error:e.code==='folder_picker_unavailable'?'フォルダー選択画面を開けませんでした。保存先は変更していません。フォルダーの場所を入力して内容を確認することもできます。':require('./workspace.cjs').errorMessage(e)});}");
  const start=s.indexOf('function workspaceFor('),end=s.indexOf('function prepareWindowsWorkspace(');
  assert.ok(start>0&&end>start);
  s=s.slice(0,start)+`function workspaceFor(home,platform=process.platform) {
  assert.equal(home,path.resolve(home));
  return platform==='win32'?path.join(home,'ProjectHub'):path.join(home,'Library/Application Support/ProjectHub');
}
`+s.slice(end);
  s=s.replaceAll('.purchase-test-workspace','.release-workspace').replaceAll('.ProjectHub-Purchase-Test-init-','.ProjectHub-release-init-');
  s=once(s,'docs\\/|issuer-public','docs\\/|window\\/|issuer-public');
  s=once(s,'|START-WINDOWS\\.cmd$','|MAKE-WINDOWS-APP\\.cmd$|START-WINDOWS\\.cmd$');
  s=once(s,"'hub/server.js', 'hub/staging-app/runtime.cjs', 'hub/staging-app/protocol.cjs',","'hub/server.js', 'hub/release-app/core.cjs', 'hub/release-app/protocol.cjs',");
  s=once(s,", 'issuer-public.json', 'hub/paid-bundle.json'",", 'hub/paid-bundle.json'");
  s=once(s,"  assert.equal(core.sha(fs.readFileSync(path.join(base, 'issuer-public.json'))), core.profileSha);\n  protocol.profile(JSON.parse(fs.readFileSync(path.join(base, 'issuer-public.json'))));", "  assert.equal(names.has('issuer-public.json'),false);\n  for(const name of names)assert.ok(!/staging-app|purchase-test-app/.test(name),'release_test_component');");
  s=once(s,'profileSha: core.profileSha',"product: 'project-hub'");
  s=once(s,"  const profile = JSON.parse(fs.readFileSync(path.join(configured.base, 'issuer-public.json')));\n  const license = require('./license.cjs').createLicense(configured.root, { profile });",`  const selected=configured.workspace?.data.workspace;
  let adoptionUnavailable=false;
  if(selected && selected!==configured.root) {
    try {require('./legacy-license.cjs').adopt({sourceRoot:selected,targetRoot:configured.root,platform:process.platform,config:protocol.configFor(process.platform)});}
    catch {adoptionUnavailable=true;}
  }
  // General data remains usable when entitlement adoption is unavailable.
  // Never repair, overwrite, retry registration or start a new trial here.
  const license = adoptionUnavailable
    ? require('./license-hold.cjs').createHeldLicense(protocol.configFor(process.platform),process.platform)
    : require('./license.cjs').createLicense(configured.root);
  if(adoptionUnavailable)configured.workspace.notice=license.client.status().reason;`);
  s=once(s,'  license.client.prepare=()=>configured.workspace?.pending ? Promise.resolve() : prepare();',`  license.client.prepare=()=>!configured.workspace?.external() || configured.workspace.pending ? Promise.resolve() : prepare();
  const status=license.client.status;
  license.client.status=()=>{const s=status();return configured.workspace?.external()?s:{...s,activationAvailable:false,purchaseUrl:'',introAvailable:false,reason:'先に設定の「データの保存先」で一般データの場所を選択し、同じアプリを開き直してください。'};};`);
  s=once(s,'  // Some GET routes persist observations/settings too.',`  if(workspace && !workspace.external() && req.method==='POST' && !['/api/quit','/api/onboarding'].includes(url.pathname) && !url.pathname.startsWith('/api/app-update')) {
    req.resume();send(res,409,{error:'先に設定の「データの保存先」で一般データの場所を確認・選択し、同じアプリを開き直してください。'});return true;
  }
  // Some GET routes persist observations/settings too.`);
  return once(s,'const port = 4588;','const port = 4545;');
}
function license(s){
  s=common(s);
  s=once(s,"const config = { ...protocol.configFor(os, options.profile), purchaseUrl: protocol.endpoint + '/buy' };","const config = protocol.configFor(os);");
  // Keep the bounded response reader and request accounting, but let the shared
  // client classify HTTP refusal separately from transport/JSON failures.
  s=once(s,'      const reader = response.body.getReader(), chunks = []; let size = 0;',`      let value;
      try {
      const reader = response.body.getReader(), chunks = []; let size = 0;`);
  s=once(s,"      const value = JSON.parse(Buffer.concat(chunks).toString());",`      value = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        noteFailure(response.status === 200 ? 'connection' : 'issuer');
        return new Response('', { status: response.status === 200 ? 200 : 400 });
      }`);
  s=once(s,"const safe = ['trial_used', 'device_limit_mac', 'device_limit_windows', 'unregistered', 'unsupported_os'].includes(value.code) ? value.code : 'issuer_unavailable';","const safe = value?.code; // The shared post() applies the fixed HTTP-code allowlist.");
  s=once(s,"throw Error('利用コードを入力してください');","throw Error('invalid_code');");
  s=once(s,"throw Error('利用コードの登録は受付済みです。再送・再購入せず結果を確認してください。');","throw Object.assign(Error('利用コードの登録は受付済みです。再送・再購入せず結果を確認してください。'), { code: 'license_registration_pending' });");
  s=once(s,"    } catch { throw Error('利用コードの登録を確認できません。再送・再購入せず結果をお知らせください。'); }",`    } catch (error) {
      const safe = require('../lib/license').activationError(error);
      throw Object.assign(Error(safe.error), { code: safe.code });
    }`);
  return s.replaceAll('target.origin, protocol.endpoint','target.origin, config.endpoint').replaceAll("protocol.endpoint + route","config.endpoint + route");
}
function workspace(s){
  s=common(s).replaceAll('試験用の購入情報','購入情報').replaceAll('元の試験専用の場所','専用の保護場所').replaceAll('previousTrial:{workspace:this.root,retained:true}','protectedManagement:{workspace:this.root,retained:true}');
  s=once(s,"const product=directory(path.join(workspace,'Product')), projects=[], evidence=[]; let talkLedger;",`const product=path.join(workspace,'Product'), projects=[], evidence=[]; let talkLedger;
    if(fs.existsSync(product))directory(product);
    else assert.ok(fs.readdirSync(workspace).every(n=>['_hub','.project-hub-use'].includes(n)),'workspace_projects');`);
  s=once(s,'fs.readdirSync(product).sort()',"(fs.existsSync(product)?fs.readdirSync(product):[]).sort()");
  s=once(s,"    assert.ok(projects.length,'workspace_projects');",`    if(!projects.length) {
      assert.ok(fs.readdirSync(workspace).every(n=>['Product','_hub','.project-hub-use'].includes(n)),'workspace_projects');
      if(fs.existsSync(product))assert.equal(fs.readdirSync(product).length,0,'workspace_projects');
      evidence.push(['empty',true]);
    }`);
  return s;
}
function update(s){s=common(s).replaceAll('_hub/updates/purchase-test','_hub/updates/release-runtime');s=once(s,"this.trust.channel !== 'purchase-test'","this.trust.runtimeProtocol !== 1");s=once(s,"channel: 'purchase-test'","channel: 'stable'");return s.replaceAll('購入試験版専用の署名付き配信先が未設定です。更新の実装はありますが、配信による実更新はまだ試せません。','正式版の署名付き配信先を取得できません。現在の版と保存内容を保持します。');}
function core(s){const a=s.indexOf('function fingerprints('),b=s.indexOf('function createLifecycle(');assert.ok(a>0&&b>a);return `'use strict';\nconst assert=require('node:assert/strict'),c=require('node:crypto');\nconst {PAID}=require('../lib/license/codec'),{validState}=require('../lib/license/clock');\nconst sha=b=>c.createHash('sha256').update(b).digest('hex');\n`+s.slice(a,b)+'\nmodule.exports={sha,fingerprints};\n';}
function protocol(version){assert.match(version,/^\d+\.\d+\.\d+$/);return `'use strict';
const assert=require('node:assert/strict'),policy=require('../lib/license/policy');
function supported(platform=process.platform,arch=process.arch,node=process.versions.node){const [a,b]=node.split('.').map(Number);assert.ok((platform==='darwin'&&arch==='arm64'||platform==='win32'&&arch==='x64')&&(a>22||a===22&&b>=13),'release_platform');}
function configFor(platform){assert.ok(['darwin','win32'].includes(platform));const config=policy.forPlatform(platform);return {...config,build:{...config.build,buildId:'project-hub-${version}-'+(platform==='darwin'?'mac-arm64':'windows-x64')}};}
module.exports={supported,configFor};\n`;}
function trust(){return require('node:fs').readFileSync(require('node:path').join(__dirname,'update-trust.cjs'),'utf8');}
function select(s){return once(common(s),'...api.selectLaunch(',"...require('./mac-bootstrap.cjs').selectLaunch(api,");}
function launch(s){s=common(s);s=once(s,"const window = require('../lib/platform/win32-window');","const window = require('./windows-window.cjs');");return once(s,'const handle = window.create();',"const handle = window.create({base,publisherThumbprint:''});");}
module.exports={once,common,runtime,license,workspace,update,core,protocol,trust,select,launch};
