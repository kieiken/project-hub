'use strict';
// Source/SDK contracts only, not Windows runtime or actual microphone verification.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('voice Mac purpose strings are generated and public microphone permission stays scoped and prompted',()=>{
 const plist=read('app/build-app.sh'),shell=read('app/window.swift');
 for(const key of ['NSMicrophoneUsageDescription','NSSpeechRecognitionUsageDescription'])assert.ok(plist.includes(key));
 const permission=shell.slice(shell.indexOf('func webView(_ webView: WKWebView, requestMediaCapturePermissionFor'),shell.indexOf('func webView(_ webView: WKWebView, runJavaScriptTextInputPanel'));
 for(const required of ['type == .microphone','frame.isMainFrame','origin.protocol == baseURL.scheme','origin.host == baseURL.host','origin.port == baseURL.port','window.HubVoice?.permissionPending() === true','stillLocal ? .prompt : .deny'])assert.ok(permission.includes(required),required);
 assert.doesNotMatch(permission,/\.grant|requestAccess|requestAuthorization|requestSpeechRecognitionPermissionForOrigin/);
});
test('voice Windows microphone allow is transient, initiated, scoped and rechecks the same speech session',()=>{
 const shell=read('app/windows/HubWindow.cs'),permission=shell.slice(shell.indexOf('core.PermissionRequested+='),shell.indexOf('core.AddWebResourceRequestedFilter'));
 for(const required of ['e.State=CoreWebView2PermissionState.Deny','e.SavesInProfile=false','e.PermissionKind!=CoreWebView2PermissionKind.Microphone','!e.IsUserInitiated','!Internal(e.Uri)','!Internal(core.Source)','e.GetDeferral()','MessageBoxButtons.OKCancel','pending==ticket','permission.Complete()'])assert.ok(permission.includes(required),required);
 assert.equal((permission.match(/CoreWebView2PermissionState.Allow/g)||[]).length,1);
 assert.equal((permission.match(/window.HubVoice\?\.permissionTicket/g)||[]).length,2);
 const sdk=read('app/windows/vendor/webview2/1.0.4258.31/Microsoft.Web.WebView2.Core.dll');
 for(const member of ['get_SavesInProfile','set_SavesInProfile','get_IsUserInitiated','GetDeferral'])assert.ok(sdk.includes(member),member);
 assert.ok(shell.includes('core.Settings.IsWebMessageEnabled=false'));
 assert.ok(shell.includes('403,"Blocked"'));assert.ok(shell.includes('core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All)'));
});
test('Hermes browser derivation ships full MIT terms and excludes custom audio endpoints/fallbacks',()=>{
 const source=read('public/speech-input.js'),notice=fs.readFileSync(path.join(__dirname,'../../THIRD_PARTY_NOTICES.md'),'utf8');
 assert.ok(notice.includes('Copyright (c) 2026 Hermes Web contributors'));assert.ok(notice.includes('6079b133b244212fb972b69c8099c68939d2cae2'));assert.ok(notice.includes('Permission is hereby granted'));assert.ok(notice.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
 assert.doesNotMatch(source,/fetch\(|WebSocket|MediaRecorder|getUserMedia|HermesNative|\/audio\/transcribe|processLocally\s*=/);
 assert.match(source,/recognition.lang = 'ja-JP'/);
});

test('packaged Mac shell and generated purpose strings share the scoped browser voice capability',()=>{
 const shell=read('staging-app/Window.swift'),builder=read('release-app/build.cjs');
 assert.ok(shell.includes('ProjectHubApp/packaged HubVoice/1'));
 for(const key of ['NSMicrophoneUsageDescription','NSSpeechRecognitionUsageDescription'])assert.ok(builder.includes(key));
 const permission=shell.slice(shell.indexOf('func webView(_ webView: WKWebView, requestMediaCapturePermissionFor'),shell.indexOf('// WKWebView otherwise'));
 for(const required of ['type == .microphone','frame.isMainFrame','origin.protocol == base.scheme','origin.host == base.host','origin.port == base.port','window.HubVoice?.permissionPending() === true','stillLocal ? .prompt : .deny'])assert.ok(permission.includes(required),required);
 assert.doesNotMatch(permission,/\.grant|requestAccess|requestAuthorization|requestSpeechRecognitionPermissionForOrigin/);
});


test('all four voice-capable Mac app routes pair HubVoice/1 with both purpose descriptions',()=>{
 const routes=[
  {name:'owner',builder:'app/build-app.sh',shell:'app/window.swift'},
  {name:'release',builder:'release-app/build.cjs',shell:'staging-app/Window.swift'},
  {name:'staging',builder:'staging-app/build.cjs',shell:'staging-app/Window.swift'},
  {name:'purchase',builder:'purchase-test-app/build.cjs',shell:'staging-app/Window.swift'}
 ];
 for(const route of routes){
  const builder=read(route.builder),shell=read(route.shell);
  assert.match(shell,/applicationNameForUserAgent\s*=\s*"ProjectHubApp\/[^"\n]*\bHubVoice\/1\b/,route.name+' voice capability');
  if(route.name==='owner')assert.ok(builder.includes('"$HERE/app/window.swift"'),route.name+' shell source');
  else assert.ok(builder.includes("'hub/staging-app/Window.swift'"),route.name+' shared shell source');
  const plist=route.name==='owner'?builder.slice(builder.indexOf('const values = {'),builder.indexOf('HubShellHash:')):builder.slice(builder.indexOf("fs.writeFileSync(path.join(app"),builder.indexOf('</dict></plist>',builder.indexOf("fs.writeFileSync(path.join(app")));
  for(const key of ['NSMicrophoneUsageDescription','NSSpeechRecognitionUsageDescription']){
   const value=route.name==='owner'?plist.match(new RegExp(key+":tr\\('([^']+)'\\)")):plist.match(new RegExp('<key>'+key+'</key><string>([^<]+)</string>'));
   assert.ok(value&&value[1].trim(),route.name+' '+key+' has a nonempty generated purpose');
  }
 }
});
