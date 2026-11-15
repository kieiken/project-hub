'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),c=require('node:crypto');
const {finalize}=require('../release-app/finalize-windows.cjs'),{names}=require('../release-app/windows-window.cjs');
const sha=b=>c.createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'final-release-finalize-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'base'),prepared=path.join(root,'prepared'),output=path.join(root,'final');fs.mkdirSync(base);fs.mkdirSync(prepared);const manifest={version:1,kind:'public-release',platform:'win32',arch:'x64',port:4545,shellProtocol:1,source:'a'.repeat(40),publisherSigned:false,files:[]};
 const put=(rel,text)=>{const file=path.join(base,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);fs.chmodSync(file,0o644);manifest.files.push({path:rel,bytes:Buffer.byteLength(text),sha256:sha(text),mode:0o644});};
 for(const n of ['server.js','release-app/core.cjs','release-app/protocol.cjs','release-app/runtime.cjs','release-app/license.cjs','paid-bundle.json'])put('hub/'+n,'fixture');put('hub/release-app/launch.cjs',"window.create({base,publisherThumbprint:''});");for(let i=0;i<101;i++)put('hub/file-'+i+'.js','fixture');
 fs.mkdirSync(path.join(prepared,'window'));for(const n of names){const bytes='fixture-'+n;fs.writeFileSync(path.join(prepared,'window',n),bytes);if(n!=='ProjectHub.exe')put('hub/app/windows/vendor/webview2/1.0.4258.31/'+n,bytes);}
 const save=()=>fs.writeFileSync(path.join(base,'release-manifest.json'),JSON.stringify(manifest));save();let calls=0;const args={base,prepared,output,platform:'win32',arch:'x64',thumbprint:'A'.repeat(40),execFileSync(file,args,opts){calls++;assert.equal(opts.shell,false);assert.match(args.at(-1),/Get-AuthenticodeSignature/);assert.doesNotMatch(args.at(-1),/Set-AuthenticodeSignature|signtool/i);return JSON.stringify({valid:true,thumbprint:JSON.parse(opts.input).thumbprint});}};return {args,base,prepared,output,manifest,save,calls:()=>calls};}
function image(dir){const out={};function walk(d,p=''){for(const n of fs.readdirSync(d)){const file=path.join(d,n);if(fs.lstatSync(file).isDirectory())walk(file,p+n+'/');else out[p+n]=sha(fs.readFileSync(file));}}walk(dir);return out;}
test('signed preparation creates new inventory and fixed publisher without changing either input',t=>{const f=fixture(t),a=image(f.base),b=image(f.prepared),r=finalize(f.args);assert.equal(r.publisherSigned,true);assert.equal(r.windowsNativePrepared,true);assert.equal(f.calls(),2);assert.deepEqual(image(f.base),a);assert.deepEqual(image(f.prepared),b);const m=JSON.parse(fs.readFileSync(path.join(f.output,'release-manifest.json')));assert.equal(m.publisherThumbprint,f.args.thumbprint);for(const row of m.files)assert.equal(sha(fs.readFileSync(path.join(f.output,row.path))),row.sha256);assert.match(fs.readFileSync(path.join(f.output,'hub/release-app/launch.cjs'),'utf8'),new RegExp(f.args.thumbprint));assert.throws(()=>finalize(f.args));});
for(const fault of ['unsigned','wrong-cert','unknown','missing','link','hardlink','bad-vendor','bad-base','multiple-fields','unknown-base','platform'])test('refuses '+fault+' without partial output',t=>{const f=fixture(t),exe=path.join(f.prepared,'window/ProjectHub.exe');
 if(fault==='unsigned')f.args.execFileSync=()=>JSON.stringify({valid:false,thumbprint:f.args.thumbprint});if(fault==='wrong-cert')f.args.execFileSync=()=>JSON.stringify({valid:true,thumbprint:'B'.repeat(40)});if(fault==='unknown')fs.writeFileSync(path.join(f.prepared,'window/extra.dll'),'x');if(fault==='missing')fs.unlinkSync(exe);if(fault==='link'){fs.renameSync(exe,exe+'.saved');fs.symlinkSync(exe+'.saved',exe);}if(fault==='hardlink')fs.linkSync(exe,path.join(f.prepared,'alias'));if(fault==='bad-vendor')fs.appendFileSync(path.join(f.prepared,'window',names[1]),'bad');if(fault==='bad-base')fs.appendFileSync(path.join(f.base,'hub/server.js'),'bad');if(fault==='multiple-fields'){const file=path.join(f.base,'hub/release-app/launch.cjs'),s="publisherThumbprint:'';publisherThumbprint:''";fs.writeFileSync(file,s);const row=f.manifest.files.find(r=>r.path==='hub/release-app/launch.cjs');row.sha256=sha(s);row.bytes=Buffer.byteLength(s);f.save();}if(fault==='unknown-base')fs.writeFileSync(path.join(f.base,'other'),'x');if(fault==='platform')f.args.arch='arm64';
 assert.throws(()=>finalize(f.args),{code:'release_windows_finalize_failed'});assert.equal(fs.existsSync(f.output),false);
});
test('signature mutation refuses before cloning',t=>{const f=fixture(t);f.args.execFileSync=()=>{fs.appendFileSync(path.join(f.prepared,'window/ProjectHub.exe'),'race');return JSON.stringify({valid:true,thumbprint:f.args.thumbprint});};assert.throws(()=>finalize(f.args));assert.equal(fs.existsSync(f.output),false);});
test('output-stage failure is retained and cannot be retried',t=>{const f=fixture(t);let calls=0;f.args.execFileSync=()=>{if(++calls===2)throw Error('injected output signature failure');return JSON.stringify({valid:true,thumbprint:f.args.thumbprint});};assert.throws(()=>finalize(f.args));assert.equal(fs.existsSync(f.output),true);const snapshot=image(f.output);assert.throws(()=>finalize(f.args));assert.deepEqual(image(f.output),snapshot);assert.equal(calls,2);});

// Synthetic filesystem fixtures only: these bytes are not PE executables and no
// Authenticode, compiler, Windows application, or external service is invoked.
function unsignedFixture(t){
 const f=fixture(t);delete f.args.thumbprint;f.args.unsigned=true;
 const icon='hub/app/windows/ProjectHub.ico',iconFile=path.join(f.base,icon);fs.mkdirSync(path.dirname(iconFile),{recursive:true});fs.writeFileSync(iconFile,'synthetic icon');fs.chmodSync(iconFile,0o644);f.manifest.files.push({path:icon,bytes:fs.statSync(iconFile).size,sha256:sha(fs.readFileSync(iconFile)),mode:0o644});
 const source='hub/app/windows/HubWindow.cs',file=path.join(f.base,source);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic C# input');fs.chmodSync(file,0o640);
 f.manifest.files.push({path:source,bytes:fs.statSync(file).size,sha256:sha(fs.readFileSync(file)),mode:0o640});
 // Exercise preservation of non-default file permissions in both input trees.
 const baseRow=f.manifest.files.find(r=>r.path==='hub/server.js');fs.chmodSync(path.join(f.base,baseRow.path),0o600);baseRow.mode=0o600;
 fs.chmodSync(path.join(f.prepared,'window/ProjectHub.exe'),0o750);f.save();
 const row=(root,relative)=>{const p=path.join(root,relative),s=fs.statSync(p);return {path:relative,bytes:s.size,sha256:sha(fs.readFileSync(p)),mode:s.mode&0o777};};
 const receipt={version:1,kind:'release-windows-preparation',source:f.manifest.source,baseManifestSha256:sha(fs.readFileSync(path.join(f.base,'release-manifest.json'))),inputs:[source,...names.slice(1).map(n=>'hub/app/windows/vendor/webview2/1.0.4258.31/'+n),icon].map(p=>row(f.base,p)),files:names.map(n=>row(f.prepared,'window/'+n))};
 const saveReceipt=()=>fs.writeFileSync(path.join(f.prepared,'preparation.json'),JSON.stringify(receipt));saveReceipt();
 return {...f,receipt,saveReceipt};
}
function detailedImage(dir){const result={};for(const [p,digest] of Object.entries(image(dir)))result[p]={sha256:digest,mode:fs.statSync(path.join(dir,p)).mode&0o777};return result;}
test('explicit unsigned finalization preserves synthetic inputs and all payload bytes and modes without signature calls',t=>{
 const f=unsignedFixture(t),base=detailedImage(f.base),prepared=detailedImage(f.prepared),result=finalize(f.args);
 assert.equal(f.calls(),0);assert.equal(result.publisherSigned,false);assert.equal(result.windowsNativePrepared,true);
 assert.deepEqual(detailedImage(f.base),base);assert.deepEqual(detailedImage(f.prepared),prepared);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.output,'release-manifest.json')));
 assert.equal(manifest.publisherSigned,false);assert.equal(manifest.distribution,'publisher-free');assert.equal(manifest.windowsNativePrepared,true);assert.ok(!manifest.publisherThumbprint);
 assert.match(fs.readFileSync(path.join(f.output,'hub/release-app/launch.cjs'),'utf8'),/publisherThumbprint:''/);
 assert.equal(fs.existsSync(path.join(f.output,'preparation.json')),false);
 for(const [relative,expected] of Object.entries(base)){if(relative==='release-manifest.json')continue;const p=path.join(f.output,relative);assert.equal(sha(fs.readFileSync(p)),expected.sha256,relative);assert.equal(fs.statSync(p).mode&0o777,expected.mode,relative);}
 for(const expected of f.receipt.files){const p=path.join(f.output,expected.path);assert.equal(sha(fs.readFileSync(p)),expected.sha256);assert.equal(fs.statSync(p).mode&0o777,expected.mode);}
 for(const row of manifest.files){const p=path.join(f.output,row.path);assert.equal(sha(fs.readFileSync(p)),row.sha256);assert.equal(fs.statSync(p).mode&0o777,row.mode);}
 const snapshot=detailedImage(f.output);assert.throws(()=>finalize(f.args));assert.deepEqual(detailedImage(f.output),snapshot);
});
for(const fault of ['implicit','empty-thumbprint','false','conflicting-thumbprint','missing-receipt','input-sha','icon-sha','input-missing','receipt-source','receipt-base','receipt-kind','receipt-version','receipt-extra-file','receipt-duplicate-input','sdk','exe','prepared-mode','base-mode','prepared-link','base-link','prepared-hardlink','base-hardlink','prepared-extra','base-extra','base-modified'])test('unsigned refuses '+fault+' before output or signature calls',t=>{
 const f=unsignedFixture(t),exe=path.join(f.prepared,'window/ProjectHub.exe'),server=path.join(f.base,'hub/server.js');
 if(fault==='implicit')delete f.args.unsigned;
 if(fault==='empty-thumbprint'){delete f.args.unsigned;f.args.thumbprint='';}
 if(fault==='false')f.args.unsigned=false;
 if(fault==='conflicting-thumbprint')f.args.thumbprint='A'.repeat(40);
 if(fault==='missing-receipt')fs.unlinkSync(path.join(f.prepared,'preparation.json'));
 if(fault==='input-sha'){f.receipt.inputs[0].sha256='0'.repeat(64);f.saveReceipt();}
 if(fault==='icon-sha'){f.receipt.inputs.find(r=>r.path==='hub/app/windows/ProjectHub.ico').sha256='0'.repeat(64);f.saveReceipt();}
 if(fault==='input-missing'){f.receipt.inputs.pop();f.saveReceipt();}
 if(fault==='receipt-source'){f.receipt.source='b'.repeat(40);f.saveReceipt();}
 if(fault==='receipt-base'){f.receipt.baseManifestSha256='0'.repeat(64);f.saveReceipt();}
 if(fault==='receipt-kind'){f.receipt.kind='other';f.saveReceipt();}
 if(fault==='receipt-version'){f.receipt.version=2;f.saveReceipt();}
 if(fault==='receipt-extra-file'){f.receipt.files.push({...f.receipt.files[0],path:'window/extra.dll'});f.saveReceipt();}
 if(fault==='receipt-duplicate-input'){f.receipt.inputs[1]={...f.receipt.inputs[0]};f.saveReceipt();}
 if(fault==='sdk'){const p=path.join(f.prepared,'window',names[1]);fs.appendFileSync(p,'changed SDK');const r=f.receipt.files.find(r=>r.path==='window/'+names[1]);r.bytes=fs.statSync(p).size;r.sha256=sha(fs.readFileSync(p));f.saveReceipt();}
 if(fault==='exe')fs.appendFileSync(exe,'changed EXE');
 if(fault==='prepared-mode')fs.chmodSync(exe,0o700);
 if(fault==='base-mode')fs.chmodSync(server,0o640);
 if(fault==='prepared-link'){fs.unlinkSync(exe);fs.symlinkSync(server,exe);}
 if(fault==='base-link'){fs.unlinkSync(server);fs.symlinkSync(exe,server);}
 if(fault==='prepared-hardlink')fs.linkSync(exe,path.join(path.dirname(f.prepared),'exe-alias'));
 if(fault==='base-hardlink')fs.linkSync(server,path.join(path.dirname(f.base),'server-alias'));
 if(fault==='prepared-extra')fs.writeFileSync(path.join(f.prepared,'extra'),'extra');
 if(fault==='base-extra')fs.writeFileSync(path.join(f.base,'extra'),'extra');
 if(fault==='base-modified')fs.appendFileSync(server,'changed base');
 assert.throws(()=>finalize(f.args),{code:'release_windows_finalize_failed'});assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.output),false);
});
test('a signature failure never falls back to unsigned finalization',t=>{
 const f=unsignedFixture(t);delete f.args.unsigned;f.args.thumbprint='A'.repeat(40);let calls=0;
 f.args.execFileSync=()=>{calls++;return JSON.stringify({valid:false,thumbprint:f.args.thumbprint});};
 assert.throws(()=>finalize(f.args),{code:'release_windows_finalize_failed'});assert.equal(calls,1);assert.equal(fs.existsSync(f.output),false);
});
test('signed finalization with preparation receipt permits owner-signed EXE byte changes only after signature verification',t=>{
 const f=unsignedFixture(t);delete f.args.unsigned;f.args.thumbprint='A'.repeat(40);
 fs.appendFileSync(path.join(f.prepared,'window/ProjectHub.exe'),'synthetic owner signature');
 const before=detailedImage(f.prepared),result=finalize(f.args);
 assert.equal(result.publisherSigned,true);assert.equal(f.calls(),2);assert.deepEqual(detailedImage(f.prepared),before);
 assert.equal(sha(fs.readFileSync(path.join(f.output,'window/ProjectHub.exe'))),before['window/ProjectHub.exe'].sha256);
});

for(const signed of [false,true])for(const stage of ['base','prepared'])test('R1 finalization rejects empty directory in '+stage+' with '+(signed?'signed':'unsigned')+' mode before output',t=>{
 const f=unsignedFixture(t);if(signed){delete f.args.unsigned;f.args.thumbprint='A'.repeat(40);}
 const extra=path.join(f[stage],stage==='base'?'hub':'window','unlisted','empty');fs.mkdirSync(extra,{recursive:true});
 const before=[f.base,f.prepared].map(detailedImage);
 assert.throws(()=>finalize(f.args),{code:'release_windows_finalize_failed'});
 assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.output),false);assert.equal(fs.statSync(extra).isDirectory(),true);
 assert.deepEqual([f.base,f.prepared].map(detailedImage),before);
});
test('R1 finalization detects an empty output directory introduced during signed output inspection and retains it',t=>{
 const f=unsignedFixture(t);delete f.args.unsigned;f.args.thumbprint='A'.repeat(40);let calls=0;
 const extra=path.join(f.output,'window','unlisted-empty');
 f.args.execFileSync=()=>{if(++calls===2)fs.mkdirSync(extra);return JSON.stringify({valid:true,thumbprint:f.args.thumbprint});};
 const before=[f.base,f.prepared].map(detailedImage);
 assert.throws(()=>finalize(f.args),{code:'release_windows_finalize_failed'});assert.equal(calls,2);assert.equal(fs.statSync(extra).isDirectory(),true);
 assert.deepEqual([f.base,f.prepared].map(detailedImage),before);assert.throws(()=>finalize(f.args));assert.equal(calls,2);
});
