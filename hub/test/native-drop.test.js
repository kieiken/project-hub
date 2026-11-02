'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {execFileSync,spawn}=require('node:child_process');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');

test('native drop: actual Foundation/AppKit data through production receive, async ticket and save acknowledgement',{skip:process.platform!=='darwin'},async t=>{
  // Foundation uses the Darwin user temp directory even when the launcher sets
  // TMPDIR=/private/tmp. Keep Node's real image-path allowlist on the same OS temp.
  const previousTmp=process.env.TMPDIR;
  process.env.TMPDIR=execFileSync('/usr/bin/getconf',['DARWIN_USER_TEMP_DIR'],{encoding:'utf8'}).trim();
  t.after(()=>{if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;});
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-drop-input-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original=process.env.HUB_DROP_BASELINE
    ? execFileSync('git',['show',process.env.HUB_DROP_BASELINE+':hub/app/window.swift'],{cwd:path.join(__dirname,'../..'),encoding:'utf8'})
    : fs.readFileSync(path.join(__dirname,'../app/window.swift'),'utf8');
  let receiver=original.slice(original.indexOf('// BEGIN PROMISED DROP BATCH'),original.indexOf('\nclass AppDelegate:'));
  // Only replace platform adapters: the entire production receive/control flow
  // runs unchanged. AppKit requires a genuine drag session for promise fulfilment.
  receiver=receiver.replace('class DropWebView: WKWebView','class DropWebView: DropTestWebView')
    .replace(/return sender\.draggingPasteboard\.readObjects\(forClasses: \[NSFilePromiseReceiver\.self\], options: nil\) as\? \[NSFilePromiseReceiver\] \?\? \[\]/,'return (sender as! TestDrag).receivers')
    .replace('DispatchQueue.main.asyncAfter(deadline: .now() + 60)','testAfter');
  if(process.env.HUB_DROP_BASELINE && !receiver.includes('func promisedDropPath')) {
    const current=fs.readFileSync(path.join(__dirname,'../app/window.swift'),'utf8');
    receiver+='\n'+current.slice(current.indexOf('func promisedDropPath('),current.indexOf('// END PROMISED DROP BATCH'));
  }
  const fixture=fs.readFileSync(path.join(__dirname,'fixtures/native-drop.swift'),'utf8').replace('// INSERT PRODUCTION RECEIVER',
    'var testTimeouts: [() -> Void] = []\nfunc testAfter(_ block: @escaping () -> Void) { testTimeouts.append(block) }\n'+receiver);
  const file=path.join(root,'main.swift'),binary=path.join(root,'receiver');fs.writeFileSync(file,fixture);
  execFileSync('/usr/bin/swiftc',[file,'-o',binary],{timeout:60000});
  const data=snapshot(),a=app();data.projects[0].dir=root;
  a.context.data=data;vm.runInContext('state=data;view={kind:"work",project:"p",task:"t"}',a.context);
  a.element('#main').firstElementChild={isConnected:true};a.element('#chat-in').value='kept draft';
  a.context.drawChatImages=()=>{};
  const start=require('../lib/start'),routes=require('../lib/routes/start')({
    store:{readProject:id=>id==='p'?{id:'p',dir:root}:null},start,fs,lt:x=>x,
    send:(res,status,body)=>{if(status!==200)throw Error(body.error);res.body=body;}
  });
  const uploadErrors=[];
  a.context.toast=message=>uploadErrors.push(message);
  let calls=0;
  a.context.api=async(route,body)=>{assert.equal(route,'/api/start/image-path');calls++;const res={};await routes.write.handle({},res,new URL('http://fixture'+route),body);return res.body;};
  const native=a.context.window.hubNativeDrop;
  let output='',errors='',checked=false;
  await new Promise((resolve,reject)=>{
    const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
    const timeout=setTimeout(()=>{child.kill();reject(Error('native adapter timed out'));},15000);
    child.stderr.on('data',d=>{errors+=d;});
    child.stdout.on('data',async chunk=>{
      output+=chunk;
      const line=output.split('\n').find(x=>x.startsWith('BRIDGE ') && x.endsWith('}'));
      if(!line || checked)return;checked=true;
      try {
        const delivery=JSON.parse(line.slice(7)),ticket=native.begin();
        await native(delivery.paths,ticket,{temporary:true});await native(delivery.paths,ticket,{temporary:true});
        assert.equal(calls,1);assert.equal(a.element('#chat-in').value,'kept draft');
        const images=a.context.chatImages('p','t');assert.equal(images.length,1,uploadErrors.join('\n'));
        assert.deepEqual(fs.readFileSync(start.imageFile({id:'p',dir:root},images[0].id)),Buffer.from(delivery.base64,'base64'));
        assert.ok(fs.existsSync(delivery.paths[0]),'native temp exists until save completes');
        child.stdin.end('saved\n');
      } catch(error){child.kill();reject(error);}
    });
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(Error(output+'\n'+errors));});
  });
  assert.equal(checked,true);assert.equal((output.match(/^PASS /gm)||[]).length,12,output);
  t.diagnostic(output.replace(/^BRIDGE .*$/gm,'BRIDGE native paths saved by real image handler').trim());
});
