'use strict';
// Offline release compiler: saved Git blobs and inventoried existing dependencies.
// This produces a review candidate, never enables an issuer or publishes it.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shared=require('../purchase-test-app/build.cjs'),compile=require('./compile.cjs');
const repo=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function build(source,destination,platform,version='4.125.2'){
  assert.match(source,/^[a-f0-9]{40}$/);assert.match(version,/^\d+\.\d+\.\d+$/);assert.equal(destination,path.resolve(destination));assert.ok(!fs.existsSync(destination));assert.ok(['darwin','win32'].includes(platform));
  const git=args=>cp.execFileSync('git',args,{cwd:repo,maxBuffer:32*1024*1024}),blob=name=>git(['show',source+':'+name]);
  // Shared builder/transformers must themselves be the saved input, not an
  // uncommitted build-host variation of the source recorded in the manifest.
  for(const file of ['hub/release-app/build.cjs','hub/release-app/compile.cjs','hub/release-app/update-trust.cjs','hub/purchase-test-app/build.cjs'])assert.equal(sha(blob(file)),sha(fs.readFileSync(path.join(repo,file))),'release_builder_changed');
  const app=platform==='darwin'?path.join(destination,'Project Hub.app'):null,base=app?path.join(app,'Contents/Resources/runtime'):path.join(destination,'ProjectHub-Windows');
  const manifest={version:1,kind:'public-release',source,platform,arch:platform==='darwin'?'arm64':'x64',port:4545,releaseVersion:version,shellProtocol:1,files:[],trialDays:30,publisherSigned:false,notarized:false,distribution:'publisher-free',liveAcceptance:false,windowsIssuerEnabled:false,readiness:'INDEPENDENT_REVIEW_AND_EXTERNAL_ACCEPTANCE_REQUIRED'};
  if(platform==='darwin')manifest.macShellGeneration=2;
  function put(name,bytes,mode=0o644){assert.ok(!manifest.files.some(r=>r.path===name));const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o755});fs.writeFileSync(file,bytes,{flag:'wx',mode});fs.chmodSync(file,mode);manifest.files.push({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes),mode});}
  const rows=git(['ls-tree','-rz',source]).toString().split('\0').filter(Boolean).map(line=>{const [meta,name]=line.split('\t');return {name,mode:meta.split(' ')[0]};});
  for(const row of rows.filter(r=>shared.include(r.name,platform)&&!/^hub\/(staging-app|purchase-test-app)\//.test(r.name))){
    assert.ok(['100644','100755'].includes(row.mode));let bytes=blob(row.name),s=bytes.toString();
    if(row.name==='hub/server.js')s=shared.overlayServer(s).replaceAll('stagingApp','releaseApp').replaceAll('stagingLicense','releaseLicense').replaceAll('./purchase-test-app/','./release-app/');
    else if(row.name==='hub/package.json')s=JSON.stringify({...JSON.parse(s),version},null,2)+'\n';
    else if(row.name==='hub/lib/license/policy.js')s=s.replaceAll('project-hub-4.125.0-',`project-hub-${version}-`);
    else if(row.name==='hub/lib/routes/state.js')s=compile.once(s,'root: ROOT, hubInstance:',"root: ROOT, dataManagementRoot: require('../../release-app/runtime.cjs').managementRoot(), hubInstance:");
    else if(row.name==='hub/public/app-settings.js')s=compile.once(s,'    loadMoveSettings();',"    loadMoveSettings(); if(typeof loadDataLocation === 'function') loadDataLocation();");
    else if(row.name==='hub/public/app-project.js'){
      s=compile.once(s,'function renderEmpty() {',"function renderEmpty() { if(typeof renderDataLocationEmpty === 'function' && state.root===state.dataManagementRoot) {renderDataLocationEmpty();return;}");
      s=compile.once(s,'ターミナルで <code>bash setup.sh</code> を実行すると、今の作業の台帳が作られます。','左の［＋ 新しいプロジェクト］から最初のプロジェクトを作れます。保存先を変える場合は［設定］→［管理］→［データの保存先］を開いてください。');
    }
    else if(row.name==='hub/public/index.html')s=compile.once(s,'<script src="app-update.js"></script>','<script src="app-update.js"></script><script src="data-location.js"></script>');
    else if(row.name==='hub/public/data-location.js')s=s.replaceAll('試験用の購入情報','購入情報').replaceAll('試験中に別の場所へ保存した内容は残りますが、自動では合流しません。','別の場所にある内容は残りますが、自動では合流しません。');
    else if(row.name==='THIRD_PARTY_NOTICES.md')s=shared.distributionNotices(s).replaceAll('購入試験版','配布アプリ');
    else {put(row.name,bytes,row.mode==='100755'?0o755:0o644);continue;}
    put(row.name,s,row.mode==='100755'?0o755:0o644);
  }
  for(const [name,transform] of [['runtime',compile.runtime],['license',compile.license],['workspace',compile.workspace],['update',compile.update],['select',compile.select],['launch',compile.launch]])put(`hub/release-app/${name}.cjs`,transform(blob(`hub/purchase-test-app/${name}.cjs`).toString()));
  put('hub/release-app/core.cjs',compile.core(blob('hub/staging-app/runtime.cjs').toString()));put('hub/release-app/protocol.cjs',compile.protocol(version));put('hub/release-app/update-trust.cjs',compile.trust());
  put('hub/release-app/legacy-license.cjs',blob('hub/release-app/legacy-license.cjs'));
  put('hub/release-app/license-hold.cjs',blob('hub/release-app/license-hold.cjs'));
  put('hub/release-app/mac-bootstrap.cjs',blob('hub/release-app/mac-bootstrap.cjs'));
  if(platform==='win32') {for(const name of ['windows-window','prepare-windows','finalize-windows','finish-unsigned-windows','verify-windows-return'])put('hub/release-app/'+name+'.cjs',blob('hub/release-app/'+name+'.cjs'));manifest.windowsNativePrepared=false;}
  for(const row of shared.dependencyFiles(platform))put(row.path,row.bytes,/(?:spawn-helper|winpty-agent\.exe|OpenConsole\.exe)$/.test(row.path)?0o755:0o644);
  put('README.md',blob('hub/release-app/README.md').toString().replace(/^# Project Hub 正式配布候補 \d+\.\d+\.\d+/, '# Project Hub 正式配布候補 '+version));
  put('docs/project-hub/RELEASE-OPERATIONS.md',blob('hub/release-app/OPERATIONS.md'));
  if(platform==='win32')put('MAKE-WINDOWS-APP.cmd','@echo off\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\ncd /d "%~dp0"\r\nnode hub\\release-app\\finish-unsigned-windows.cjs --base "%CD%"\r\npause\r\n');
  if(platform==='win32')put('START-WINDOWS.cmd','@echo off\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\ncd /d "%~dp0"\r\nnode hub\\release-app\\launch.cjs\r\nif errorlevel 1 pause\r\n');
  if(app){
    shared.macIcon(app,path.join(base,'hub/public/icon.png'));
    const window=shared.windowSource(blob('hub/staging-app/Window.swift').toString()).replaceAll('4588','4545').replaceAll('購入試験版','Project Hub').replaceAll('purchase-test-app/','release-app/');
    put('hub/release-app/Window.swift',window);put('hub/release-app/Shutdown.swift',blob('hub/staging-app/Shutdown.swift').toString().replaceAll('4587','4545'));
    const native=path.join(base,'hub/lib/license/mac-native');cp.execFileSync('/usr/bin/swiftc',['-O','-target','arm64-apple-macosx13.0',path.join(base,'hub/lib/license/mac-native.swift'),'-o',native],{timeout:120000});fs.chmodSync(native,0o755);manifest.files.push({path:'hub/lib/license/mac-native',bytes:fs.statSync(native).size,sha256:sha(fs.readFileSync(native)),mode:0o755});
    const mac=path.join(app,'Contents/MacOS');fs.mkdirSync(mac,{recursive:true,mode:0o755});cp.execFileSync('/usr/bin/swiftc',['-O','-target','arm64-apple-macosx13.0',path.join(base,'hub/release-app/Shutdown.swift'),path.join(base,'hub/release-app/Window.swift'),'-o',path.join(mac,'ProjectHub'),'-framework','Cocoa','-framework','WebKit'],{timeout:120000});fs.chmodSync(path.join(mac,'ProjectHub'),0o755);
    fs.writeFileSync(path.join(app,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ProjectHub</string><key>CFBundleIdentifier</key><string>local.projecthub</string><key>CFBundleName</key><string>Project Hub</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSMicrophoneUsageDescription</key><string>音声入力ボタンを押した時に、話した内容を入力欄へ入れるためにマイクを使います。</string><key>NSSpeechRecognitionUsageDescription</key><string>話した内容を文字にします。音声はAppleなどの音声認識サービスで処理される場合があります。</string></dict></plist>`,{mode:0o644});
  }
  // Record the saved package's local switch, independently of live acceptance.
  const windowsPolicy=require(path.join(base,'hub/lib/license/policy.js')).forPlatform('win32');
  manifest.windowsIssuerEnabled=Boolean(windowsPolicy.endpoint&&windowsPolicy.purchaseUrl);
  manifest.files.sort((a,b)=>a.path.localeCompare(b.path));fs.writeFileSync(path.join(base,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
  require(path.join(base,'hub/release-app/runtime.cjs')).verifyPackage(base,platform);
  if(app){cp.execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',app],{timeout:30000});cp.execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:30000});}
  return {source,version,platform,app,base,files:manifest.files.length,manifestSha256:sha(fs.readFileSync(path.join(base,'release-manifest.json')))};
}
if(require.main===module)console.log(JSON.stringify(build(process.argv[2],path.resolve(process.argv[3]),process.argv[4],process.argv[5])));
module.exports={build};
