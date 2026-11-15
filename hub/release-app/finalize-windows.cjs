'use strict';
// Finalize an owner-signed EXE, or an explicitly selected publisher-free build.
// No signing tool, key access or network. A failed signature never downgrades.
// Input directories remain unchanged. Failed new outputs are retained for review.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {noLinks}=require('../lib/license/storage');
const {names}=require('./windows-window.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(Error('release_windows_finalize_failed'),{code:'release_windows_finalize_failed'});};
// Windows exposes DOS read-only through chmod/stat, not POSIX execute bits.
const modeMatches=(actual,expected)=>process.platform==='win32'?(actual&0o200)===(expected&0o200):actual===expected;
const sameRows=(a,b)=>Array.isArray(a)&&JSON.stringify(a.map(r=>({path:r.path,bytes:r.bytes,sha256:r.sha256,mode:r.mode})).sort((x,y)=>String(x.path).localeCompare(String(y.path))))===JSON.stringify(b.map(r=>({path:r.path,bytes:r.bytes,sha256:r.sha256,mode:r.mode})).sort((x,y)=>x.path.localeCompare(y.path)));
// A valid tree has only directories implied by its inventoried file paths.
// Reject empty subtrees as well as extra files, without changing receipt rows.
function files(root){noLinks(root);const result=[];function walk(dir,prefix=''){for(const item of fs.readdirSync(dir)){const file=path.join(dir,item),rel=prefix+item;noLinks(file);const s=fs.lstatSync(file);if(s.isDirectory()){const before=result.length;walk(file,rel+'/');if(result.length===before)fail();}else{if(!s.isFile()||s.nlink!==1)fail();result.push({path:rel,bytes:s.size,sha256:sha(fs.readFileSync(file)),mode:s.mode&0o777});}}}walk(root);return result.sort((a,b)=>a.path.localeCompare(b.path));}
function verify(base){const actual=files(base),raw=actual.find(r=>r.path==='release-manifest.json');if(!raw)fail();const m=JSON.parse(fs.readFileSync(path.join(base,raw.path),'utf8'));
 if(m.version!==1||m.kind!=='public-release'||m.platform!=='win32'||m.arch!=='x64'||m.port!==4545||m.shellProtocol!==1||!/^[a-f0-9]{40}$/.test(m.source)||!Array.isArray(m.files)||m.files.length<=100)fail();
 const seen=new Set();for(const row of m.files){if(typeof row.path!=='string'||! /^(?:hub\/|docs\/|window\/|START-WINDOWS\.cmd$|SETUP-WINDOWS\.cmd$|MAKE-WINDOWS-APP\.cmd$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(row.path)||row.path.split('/').some(s=>['.','..',''].includes(s))||seen.has(row.path)||!Number.isInteger(row.mode)||row.mode<0||row.mode>0o777)fail();seen.add(row.path);const a=actual.find(r=>r.path===row.path);if(!a||a.sha256!==row.sha256||a.bytes!==row.bytes||!modeMatches(a.mode,row.mode))fail();}
 if(actual.length!==seen.size+1)fail();
 for(const name of ['hub/server.js','hub/release-app/core.cjs','hub/release-app/protocol.cjs','hub/release-app/runtime.cjs','hub/release-app/license.cjs','hub/release-app/launch.cjs','hub/paid-bundle.json'])if(!seen.has(name))fail();
 if(seen.has('hub/lib/license/owner-edition.js')||[...seen].some(n=>/staging-app|purchase-test-app/.test(n)))fail();
 return {manifest:m,actual};
}
const signature=String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$s=Get-AuthenticodeSignature -LiteralPath $r.file -ErrorAction Stop
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $s.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $r.thumbprint){throw 'signature_unconfirmed'}
@{valid=$true;thumbprint=$s.SignerCertificate.Thumbprint.ToUpperInvariant()} | ConvertTo-Json -Compress`;
function finalize({base,prepared,output,thumbprint,unsigned=false,execFileSync=cp.execFileSync,platform=process.platform,arch=process.arch,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
 try{
 if(platform!=='win32'||arch!=='x64'||typeof unsigned!=='boolean'||(unsigned?thumbprint!==undefined:!/^[A-F0-9]{40}$/.test(thumbprint||''))||![base,prepared,output].every(p=>typeof p==='string'&&path.isAbsolute(p)&&p===path.resolve(p))||fs.existsSync(output))fail();
 const roots=[base,prepared,output].map(p=>p.toLowerCase());
 if(new Set(roots).size!==3)fail();
 for(let i=0;i<roots.length;i++){noLinks([base,prepared,output][i]);for(let j=0;j<roots.length;j++)if(i!==j&&roots[i].startsWith(roots[j]+path.sep))fail();}
 const original=verify(base),preparedBefore=files(prepared),candidate=preparedBefore.filter(r=>r.path!=='preparation.json'),expected=names.map(n=>'window/'+n).sort();
 if(JSON.stringify(candidate.map(r=>r.path).sort())!==JSON.stringify(expected))fail();
 const receiptRow=preparedBefore.find(r=>r.path==='preparation.json');
 if(unsigned&&!receiptRow)fail();
 if(receiptRow){
  const receipt=JSON.parse(fs.readFileSync(path.join(prepared,'preparation.json'),'utf8'));
  const inputPaths=['hub/app/windows/HubWindow.cs',...names.slice(1).map(n=>'hub/app/windows/vendor/webview2/1.0.4258.31/'+n),'hub/app/windows/ProjectHub.ico'];
  const inputs=inputPaths.map(p=>original.actual.find(r=>r.path===p));
  if(inputs.some(r=>!r)||receipt.version!==1||receipt.kind!=='release-windows-preparation'||receipt.source!==original.manifest.source||receipt.baseManifestSha256!==original.actual.find(r=>r.path==='release-manifest.json').sha256||!sameRows(receipt.inputs,inputs))fail();
  // Authenticode legitimately changes the prepared EXE after its receipt.
  // Signed mode verifies the resulting EXE separately; SDK bytes stay fixed.
  if(!Array.isArray(receipt.files)||receipt.files.length!==4||!sameRows(unsigned?receipt.files:receipt.files.filter(r=>r.path!=='window/ProjectHub.exe'),unsigned?candidate:candidate.filter(r=>r.path!=='window/ProjectHub.exe')))fail();
 }
 for(const n of names.slice(1)){const originalDll=original.actual.find(r=>r.path==='hub/app/windows/vendor/webview2/1.0.4258.31/'+n),dll=candidate.find(r=>r.path==='window/'+n);if(!originalDll||originalDll.sha256!==dll.sha256)fail();}
 const launchPath='hub/release-app/launch.cjs',launch=fs.readFileSync(path.join(base,launchPath),'utf8'),needle="publisherThumbprint:''";
 if(launch.split(needle).length!==2||launch.match(/publisherThumbprint\s*:/g)?.length!==1)fail();
 const check=file=>{const ps=path.win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');const r=JSON.parse(String(execFileSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',signature],{input:JSON.stringify({file,thumbprint}),encoding:'utf8',timeout:30000,maxBuffer:65536,windowsHide:true,shell:false})).replace(/^\uFEFF/,''));if(r.valid!==true||r.thumbprint!==thumbprint)fail();};
 if(!unsigned)check(path.join(prepared,'window/ProjectHub.exe'));
 if(JSON.stringify(files(prepared))!==JSON.stringify(preparedBefore)||JSON.stringify(files(base))!==JSON.stringify(original.actual))fail();
 fs.mkdirSync(output,{mode:0o700});
 const copy=(from,row)=>{const dest=path.join(output,row.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o755});fs.copyFileSync(path.join(from,row.path),dest,fs.constants.COPYFILE_EXCL);fs.chmodSync(dest,row.mode);if(sha(fs.readFileSync(dest))!==row.sha256||!modeMatches(fs.statSync(dest).mode&0o777,row.mode))fail();};
 for(const row of original.actual.filter(r=>r.path!=='release-manifest.json'&&!r.path.startsWith('window/')))copy(base,row);
 for(const row of candidate)copy(prepared,row);
 if(!unsigned){fs.writeFileSync(path.join(output,launchPath),launch.replace(needle,"publisherThumbprint:'"+thumbprint+"'"));check(path.join(output,'window/ProjectHub.exe'));}
 if(JSON.stringify(files(prepared))!==JSON.stringify(preparedBefore)||JSON.stringify(files(base))!==JSON.stringify(original.actual))fail();
 for(const row of candidate)if(sha(fs.readFileSync(path.join(output,row.path)))!==row.sha256)fail();
 const inventory=files(output).map(row=>({...row,mode:original.manifest.files.find(r=>r.path===row.path)?.mode??row.mode})),manifest={...original.manifest,files:inventory,publisherSigned:!unsigned,windowsNativePrepared:true,publisherThumbprint:unsigned?'':thumbprint,distribution:unsigned?'publisher-free':'publisher-signed'};
 fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});verify(output);
 return {output,publisherSigned:!unsigned,windowsNativePrepared:true,distribution:manifest.distribution,...(unsigned?{}:{thumbprint}),manifestSha256:sha(fs.readFileSync(path.join(output,'release-manifest.json')))};
 }catch{fail();}
}
if(require.main===module){const a=process.argv.slice(2);if(a[0]!=='--base'||a[2]!=='--prepared'||a[4]!=='--output'||!(a.length===7&&a[6]==='--unsigned'||a.length===8&&a[6]==='--thumbprint'))fail();console.log(JSON.stringify(finalize({base:a[1],prepared:a[3],output:a[5],...(a[6]==='--unsigned'?{unsigned:true}:{thumbprint:a[7]})})));}
module.exports={finalize,verify,files};
