'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {gitStamp}=require('../lib/state-offers');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'offers-text-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const make=(name,head='ref: refs/heads/main\n')=>{const base=path.join(root,name),git=path.join(base,'.git');fs.mkdirSync(path.join(git,'refs/heads'),{recursive:true});fs.writeFileSync(path.join(git,'HEAD'),head);fs.writeFileSync(path.join(git,'refs/heads/main'),'a'.repeat(40)+'\n');return {base,git};};
 return {root,make,...make('base')};
}
function reads(t){
 const read=fs.readFileSync,files=[];
 t.mock.method(fs,'readFileSync',function(file,...args){files.push(String(file));return read.call(this,file,...args);});
 return files;
}
test('unchanged Git bodies are reused while index, merge state and packed refs stay fresh',t=>{
 const f=fixture(t),files=reads(t),initial=gitStamp(f.base);files.length=0;
 assert.equal(gitStamp(f.base),initial);assert.equal(files.length,0);
 fs.writeFileSync(f.git+'/index','index');const index=gitStamp(f.base);assert.notEqual(index,initial);
 fs.writeFileSync(f.git+'/MERGE_HEAD','b'.repeat(40)+'\n');assert.notEqual(gitStamp(f.base),index);
 fs.unlinkSync(f.git+'/MERGE_HEAD');assert.equal(gitStamp(f.base),index);
 fs.writeFileSync(f.git+'/packed-refs','packed');const packed=gitStamp(f.base);assert.notEqual(packed,index);
 fs.writeFileSync(f.git+'/refs/heads/main','longer-ref\n');assert.notEqual(gitStamp(f.base),packed);
 assert.equal(files.length,0,'these changes must not reread any of the three bodies');
});
test('worktree pointer and commondir changes resolve new own and common paths',t=>{
 const f=fixture(t),other=f.make('other','b'.repeat(40)+'\n'),work=f.root+'/work';fs.mkdirSync(work);
 fs.writeFileSync(work+'/.git','gitdir: '+f.git+'\n');const first=gitStamp(work);
 fs.writeFileSync(work+'/.git','gitdir: '+other.git+'\n');const second=gitStamp(work);assert.notEqual(second,first);
 fs.writeFileSync(other.git+'/HEAD','ref: refs/heads/main\n');const local=gitStamp(work);
 fs.writeFileSync(f.git+'/refs/heads/main','different ref\n');fs.writeFileSync(other.git+'/commondir',path.relative(other.git,f.git)+'\n');
 const common=gitStamp(work);assert.notEqual(common,local);
 fs.unlinkSync(other.git+'/commondir');assert.equal(gitStamp(work),local);
 fs.writeFileSync(work+'/.git','gitdir: '+f.root+'/missing\n');assert.equal(gitStamp(work),'');
 fs.writeFileSync(work+'/.git','gitdir: '+f.git+'\n');assert.notEqual(gitStamp(work),'');
});
test('same-size HEAD rewrite with restored mtime and inode replacement invalidate immediately',t=>{
 const f=fixture(t),h=f.git+'/HEAD';fs.writeFileSync(h,'a'.repeat(40)+'\n');const first=gitStamp(f.base),s=fs.statSync(h);
 fs.writeFileSync(h,'b'.repeat(40)+'\n');fs.utimesSync(h,s.atime,s.mtime);const second=gitStamp(f.base);assert.notEqual(second,first);
 fs.writeFileSync(h+'.next','c'.repeat(40)+'\n');fs.utimesSync(h+'.next',s.atime,s.mtime);fs.renameSync(h+'.next',h);
 assert.notEqual(gitStamp(f.base),second);
});
test('stat or body failure discards a previous success and the next call recovers',t=>{
 const f=fixture(t),h=f.git+'/HEAD',first=gitStamp(f.base),stat=fs.statSync,read=fs.readFileSync;let failStat=true,failRead=false,heads=0;
 t.mock.method(fs,'statSync',function(file,...args){if(file===h&&failStat)throw Object.assign(Error('denied'),{code:'EACCES'});return stat.call(this,file,...args);});
 t.mock.method(fs,'readFileSync',function(file,...args){if(file===h){heads++;if(failRead)throw Error('read failed');}return read.call(this,file,...args);});
 assert.equal(gitStamp(f.base),'');failStat=false;assert.equal(gitStamp(f.base),first);assert.equal(heads,1);
 fs.writeFileSync(h,'d'.repeat(40)+'\n');failRead=true;assert.equal(gitStamp(f.base),'');failRead=false;
 assert.notEqual(gitStamp(f.base),first);assert.equal(heads,3);
 fs.unlinkSync(h);assert.equal(gitStamp(f.base),'');fs.writeFileSync(h,'e'.repeat(40)+'\n');assert.notEqual(gitStamp(f.base),'');
});
test('Git body symlinks and hard links retain the existing follow behavior and freshness',t=>{
 const f=fixture(t),target=f.root+'/head',h=f.git+'/HEAD';fs.writeFileSync(target,'f'.repeat(40)+'\n');fs.unlinkSync(h);fs.symlinkSync(target,h);
 const first=gitStamp(f.base);assert.ok(first.startsWith('f'.repeat(40)+'|'));fs.writeFileSync(target,'g'.repeat(40)+'\n');assert.notEqual(gitStamp(f.base),first);
 fs.unlinkSync(h);fs.linkSync(target,h);const linked=gitStamp(f.base);fs.writeFileSync(target,'h'.repeat(40)+'\n');assert.notEqual(gitStamp(f.base),linked);
 const alias=f.root+'/alias';fs.mkdirSync(alias);fs.symlinkSync(f.git,alias+'/.git');assert.equal(gitStamp(alias),gitStamp(f.base));
});
test('Git body storage is bounded to 256 directories and 64 KiB per directory',t=>{
 const f=fixture(t),repos=Array.from({length:257},(_,i)=>f.make('r'+i,'a'.repeat(40)+'\n'));
 for(const r of repos)gitStamp(r.base);const files=reads(t);
 gitStamp(repos.at(-1).base);assert.equal(files.length,0);
 gitStamp(repos[0].base);assert.deepEqual(files,[repos[0].git+'/HEAD']);
 fs.writeFileSync(f.git+'/HEAD','x'.repeat(64*1024+1));const large=gitStamp(f.base);files.length=0;
 assert.equal(gitStamp(f.base),large);assert.deepEqual(files,[f.git+'/HEAD']);
});
test('a body that grows after stat is not stored beyond the byte limit',t=>{
 const f=fixture(t),h=f.git+'/HEAD',read=fs.readFileSync;let heads=0;
 t.mock.method(fs,'readFileSync',function(file,...args){if(file===h){heads++;return 'x'.repeat(64*1024+1);}return read.call(this,file,...args);});
 const large=gitStamp(f.base);assert.equal(gitStamp(f.base),large);assert.equal(heads,2);
});
