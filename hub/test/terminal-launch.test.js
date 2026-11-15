'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {createDarwin}=require('../lib/platform');
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-launch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function launcher(t,execFile,extra={}){const root=fixture(t),dir=path.join(root,'launch');return{root,dir,p:createDarwin({terminalDir:dir,execFile,...extra})};}
for(const kind of ['authentication','work'])test('long '+kind+' command uses a short single line and executes intact',async t=>{
 let captured;
 const f=launcher(t,(_file,args,cb)=>{captured=args[1];cb(null);});
 const result=path.join(f.root,'completed');
 const original="printf '%s' "+"'"+('x'.repeat(kind==='work'?30000:4014))+"' > '"+result+"'; exit 7";
 await f.p.openTerminal(original);
 const files=fs.readdirSync(f.dir);assert.equal(files.length,1);
 const file=path.join(f.dir,files[0]),typed='/bin/bash '+"'"+file+"'";
 assert.equal(fs.statSync(f.dir).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.ok(!file.startsWith(path.join(os.homedir(),'Documents')+path.sep));assert.ok(Buffer.byteLength(typed)<=300);assert.doesNotMatch(typed,/[\r\n]/);
 assert.equal(captured,'tell application "Terminal" to do script "'+typed+'"');
 assert.equal(fs.readFileSync(file,'utf8'),'#!/bin/bash\n/bin/rm -f -- "$0" || exit $?\n'+original+'\n');
 const executed=cp.spawnSync('/bin/bash',[file]);assert.equal(executed.status,7);assert.equal(fs.readFileSync(result,'utf8'),'x'.repeat(kind==='work'?30000:4014));assert.deepEqual(fs.readdirSync(f.dir),[]);
});
for(const reason of ['denied','cancelled'])test('failed/cancelled Apple event removes launch script: '+reason,async t=>{
 const f=launcher(t,(_file,_args,cb)=>cb(Error(reason)));
 await assert.rejects(f.p.openTerminal('true'),new RegExp(reason));assert.deepEqual(fs.readdirSync(f.dir),[]);
});
test('abandoned launches expire after a day; fresh files and link targets are preserved',async t=>{
 const f=launcher(t,(_file,_args,cb)=>cb(null));fs.mkdirSync(f.dir,{mode:0o700});
 const old=path.join(f.dir,'00000000-0000-0000-0000-000000000000.sh'),fresh=path.join(f.dir,'11111111-1111-1111-1111-111111111111.sh'),link=path.join(f.dir,'22222222-2222-2222-2222-222222222222.sh');
 fs.writeFileSync(old,'old');fs.writeFileSync(fresh,'fresh');fs.symlinkSync(fresh,link);fs.utimesSync(old,new Date(0),new Date(0));
 await f.p.openTerminal('true');assert.equal(fs.existsSync(old),false);assert.equal(fs.readFileSync(fresh,'utf8'),'fresh');assert.equal(fs.lstatSync(link).isSymbolicLink(),true);
});
test('launch directories reject links, non-private permissions and oversized paths',async t=>{
 const root=fixture(t),actual=path.join(root,'actual'),link=path.join(root,'link');fs.mkdirSync(actual,{mode:0o700});fs.symlinkSync(actual,link);
 const unexpected=()=>{throw Error('must not call AppleScript');};
 await assert.rejects(createDarwin({terminalDir:link,execFile:unexpected}).openTerminal('true'),/terminal_launch_link/);
 fs.chmodSync(actual,0o755);await assert.rejects(createDarwin({terminalDir:actual,execFile:unexpected}).openTerminal('true'),/terminal_launch_permissions/);
 const long=path.join(root,'a'.repeat(170),'b'.repeat(170));fs.mkdirSync(path.dirname(long));
 await assert.rejects(createDarwin({terminalDir:long,execFile:unexpected}).openTerminal('true'),/terminal_launch_path_too_long/);
});
test('exclusive no-follow script creation never overwrites an injected link target',async t=>{
 const root=fixture(t),target=path.join(root,'target'),dir=path.join(root,'launch');fs.writeFileSync(target,'keep');
 const adapter={...fs,openSync(file,flags,mode){fs.symlinkSync(target,file);return fs.openSync(file,flags,mode);}};
 await assert.rejects(createDarwin({terminalDir:dir,fs:adapter,execFile:()=>{throw Error('must not launch');}}).openTerminal('true'));
 assert.equal(fs.readFileSync(target,'utf8'),'keep');
});
test('missing auth Terminal provides recovery instructions and keeps permission failures visible',async()=>{
 const p=createDarwin({execFile:(_file,_args,cb)=>cb(null,'??\n')});
 await assert.rejects(p.focusTerminal(123),/20秒.*状態を確認.*ログイン/);
 const missing=createDarwin({execFile:(file,_args,cb)=>file==='/bin/ps'?cb(null,'ttys123\n'):cb(Error('Authentication Terminal not found'))});
 await assert.rejects(missing.focusTerminal(123),/止まった窓は閉じ/);
 const exited=createDarwin({execFile:(_file,_args,cb)=>cb(Object.assign(Error('ps: gone'),{code:1}), '')});
 await assert.rejects(exited.focusTerminal(123),/20秒.*ログイン/);
 const denied=createDarwin({execFile:(_file,_args,cb)=>cb(Object.assign(Error('permission denied'),{code:'EACCES'}))});
 await assert.rejects(denied.focusTerminal(123),{code:'EACCES'});
});
