'use strict';
// Runtime payload preparation only. No keys, network or publication.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const zip=require('../lib/update-zip'),TRUST=require('./update-trust.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function signingKey(requested){
  const candidates=Object.entries(TRUST.keys).filter(([,key])=>key.purposes?.includes('app-update'));
  if(requested===undefined&&candidates.length!==1)throw Error('release_update_signing_key_required');
  const kid=requested===undefined?candidates[0][0]:requested;
  if(typeof kid!=='string'||!Object.hasOwn(TRUST.keys,kid)||!TRUST.keys[kid].purposes?.includes('app-update')||TRUST.revokedKids.includes(kid))throw Error('release_update_signing_key_invalid');
  return [kid,TRUST.keys[kid]];
}
function prepare(base,destination,{seq,now=Date.now(),kid:requestedKid}={}){
  const [kid,key]=signingKey(requestedKid);
  const raw=JSON.parse(fs.readFileSync(path.join(base,'release-manifest.json'))),runtime=require(path.join(base,'hub/release-app/runtime.cjs'));
  const manifest=runtime.verifyPackage(base,raw.platform);
  if(!/^\d+\.\d+\.\d+$/.test(manifest.releaseVersion)||manifest.shellProtocol!==1||!Number.isSafeInteger(seq)||seq<1||!Number.isSafeInteger(now)||now<0||fs.existsSync(destination)||manifest.platform==='win32'&&manifest.windowsNativePrepared!==true)throw Error('release_update_input');
  if(manifest.platform==='darwin' && manifest.macShellGeneration!==3)throw Error('release_mac_shell_generation');
  const version=manifest.releaseVersion,platform=manifest.platform,name=`Project-Hub-${version}-Runtime-${platform==='darwin'?'Apple-Silicon':'Windows-x64'}.zip`;
  const archive=zip.pack(base),tree=zip.treeHash(base),payload={v:1,typ:'hub-app-update',product:'project-hub',edition:'public',lang:'ja',version,seq,kind:'bugfix',product_line:'project-hub-4.123',bugfixOf:['project-hub-4.123'],issuedAt:Math.floor(now/1000),expiresAt:Math.floor(now/1000)+30*86400,
    requires:{os:platform,arch:manifest.arch,node:'>=22',...(platform==='darwin'?{minMacOS:'13.0'}:{minWindows:'10.0.22000'})},asset:{name,size:archive.length,sha256:sha(archive),url:TRUST.assetPrefix+'v'+version+'/'+name},app:{format:'release-runtime-v1',shellProtocol:1,runtime:'hub',bundleId:'local.projecthub',shortVersion:version,treeSha256:tree.treeSha256,entries:tree.entries},notes:{ja:'保存先の選択、保存と利用権の保持、更新確認の修正。正式配布前の確認候補です。'}};
  const bytes=Buffer.from(JSON.stringify(payload));fs.mkdirSync(destination,{recursive:true,mode:0o700});fs.writeFileSync(path.join(destination,name),archive,{flag:'wx',mode:0o600});fs.writeFileSync(path.join(destination,'payload-UNSIGNED.json'),bytes,{flag:'wx',mode:0o600});
  const output=platform==='darwin'?'project-hub-runtime-update-mac-shell3.json':'project-hub-runtime-update-windows.json';
  const plan={format:'project-hub-existing-key-sign-plan-v1',runtimeProtocol:1,kid,spkiB64:key.spkiB64,payload:'payload-UNSIGNED.json',payloadSha256:sha(bytes),asset:name,assetSha256:sha(archive),output};
  fs.writeFileSync(path.join(destination,'sign-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  const result={source:manifest.source,platform,version,seq,kid,issuedAt:payload.issuedAt,expiresAt:payload.expiresAt,signed:false,publishReady:false,publisherSigned:manifest.publisherSigned===true,notarized:manifest.notarized===true,distribution:manifest.distribution||'unspecified',needsRebuildAfterPublisherSigning:manifest.distribution!=='publisher-free',feedUrl:platform==='win32'?TRUST.windowsFeedUrl:TRUST.feedUrl,asset:name,sha256:sha(archive),payloadSha256:sha(bytes),signPlanSha256:sha(fs.readFileSync(path.join(destination,'sign-plan.json'))),tree};
  fs.writeFileSync(path.join(destination,'preparation.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
module.exports={prepare};
