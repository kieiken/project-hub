'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const git=require('../lib/git'),check=require('../lib/main-merge-check'),custody=require('../../scripts/preserve-nested-git');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-nested-'));let serial=0;
const g=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function repo(dir){fs.mkdirSync(dir,{recursive:true});g(dir,'init','-q');g(dir,'config','user.name','Fixture');g(dir,'config','user.email','fixture@localhost');fs.writeFileSync(path.join(dir,'base'),'base');g(dir,'add','.');g(dir,'commit','-qm','base');return dir;}
function fixture(){
 const id=++serial,main=repo(path.join(root,'main-'+id)),workRoot=path.join(root,'Work-'+id),source=git.prepare({base:main,workRoot,taskId:'copy'}).dir;
 const dir=repo(path.join(source,'.ai/work/site')),dir2=repo(path.join(source,'.ai/work/deploy'));
 for(const d of [dir,dir2]){g(d,'branch','unreceived');fs.writeFileSync(path.join(d,'change'),'UNRECEIVED');g(d,'add','.');g(d,'commit','-qm','unreceived');fs.writeFileSync(path.join(d,'unstaged'),'unsaved');fs.writeFileSync(path.join(d,'.gitignore'),'ignored/\n');fs.mkdirSync(path.join(d,'ignored'));fs.writeFileSync(path.join(d,'ignored','asset'),'ignored original');fs.symlinkSync('base',path.join(d,'link'));fs.chmodSync(path.join(d,'base'),0o755);}
 return {main,source,workRoot,dir,dir2,dest:path.join(root,'custody-'+id)};
}
const state=dir=>({head:g(dir,'rev-parse','HEAD'),index:fs.readFileSync(g(dir,'rev-parse','--path-format=absolute','--git-path','index')).toString('hex')});
test('read-only refusal identifies nested Git and never leaks contents or secret paths',()=>{
 const f=fixture(),before=state(f.source),proof=custody.manifest(f.dir);
 const out=check.check(git,f.source,'source');assert.equal(out.blocker.kind,'nested-git');assert.match(out.blocker.reason,/別のGit/);assert.match(out.blocker.next,/履歴/);assert.doesNotMatch(JSON.stringify(out),/UNRECEIVED/);
 assert.deepEqual(state(f.source),before);assert.deepEqual(custody.manifest(f.dir),proof);
 fs.renameSync(f.dir,path.join(path.dirname(f.dir),'secret-token-site'));const hidden=check.check(git,f.source,'source');assert.ok(hidden.blocker.hiddenPaths);assert.doesNotMatch(JSON.stringify(hidden),/secret-token/);
});
test('save and legacy merge refuse before creating a gitlink, committing or touching main',()=>{
 const f=fixture(),before=state(f.source),main=state(f.main);fs.writeFileSync(path.join(f.source,'new'),'new');
 assert.throws(()=>git.save(f.source,'must not save'),e=>e.code==='NESTED_GIT_UNRECEIVED');assert.deepEqual(state(f.source),before);
 const out=git.merge({dir:f.source,workRoot:f.workRoot,title:'refuse',cleanup:false});assert.equal(out.ok,false);assert.equal(out.delivery.state,'not-sent');assert.match(out.error,/別Git/);assert.deepEqual(state(f.main),main);assert.deepEqual(state(f.source),before);assert.ok(fs.existsSync(f.dir));
});
test('typed size and unsupported-type errors stay distinct while unknown errors hide raw stderr',()=>{
 for(const [code,kind]of [['INSPECT_FILE_LIMIT','file-limit'],['INSPECT_BYTE_LIMIT','byte-limit'],['INSPECT_FILE_TYPE','file-type'],['OTHER','unreadable']]){
  const out=check.check({merging:()=>false,inspect:()=>{throw Object.assign(Error('secret raw stderr'),{code});}},root,'source');assert.equal(out.blocker.kind,kind);assert.doesNotMatch(JSON.stringify(out),/secret raw/);
 }
});
test('custody preserves BOTH complete Git trees, untracked/ignored data, refs, links and permissions; ordinary merge then works',()=>{
 const f=fixture(),before=[custody.manifest(f.dir),custody.manifest(f.dir2)],mainBefore=state(f.main),p=custody.plan(f.source,f.dest);
 assert.equal(fs.existsSync(f.dest),false);assert.ok(fs.existsSync(f.dir));assert.deepEqual(state(f.main),mainBefore);
 const heads=p.trees.map(t=>t.head),out=custody.apply(p);assert.equal(out.complete,true);assert.equal(out.received,false);assert.equal(out.merged,false);
 assert.deepEqual(state(f.main),mainBefore);assert.equal(fs.existsSync(f.dir),false);assert.equal(fs.existsSync(f.dir2),false);
 for(let i=0;i<p.trees.length;i++){const d=path.join(f.dest,'repo-'+i);assert.equal(custody.manifest(d).hash,p.trees[i].hash);assert.equal(g(d,'rev-parse','HEAD'),heads[i]);assert.ok(g(d,'show-ref','refs/heads/unreceived'));assert.equal(fs.readFileSync(path.join(d,'ignored/asset'),'utf8'),'ignored original');assert.equal(fs.readlinkSync(path.join(d,'link')),'base');assert.equal(fs.statSync(path.join(d,'base')).mode&0o777,0o755);g(d,'fsck','--connectivity-only');}
 assert.deepEqual(before.map(x=>x.hash).sort(),p.trees.map(x=>x.hash).sort());
 git.save(f.source,'custody proof and ordinary work');assert.ok(check.check(git,f.source,'source').snapshot);
 assert.doesNotMatch(g(f.source,'ls-files','--stage'),/^160000/m);
 const merged=git.merge({dir:f.source,workRoot:f.workRoot,title:'preserved',cleanup:false});assert.equal(merged.ok,true,merged.error);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.main,path.relative(f.source,out.proof)))),JSON.parse(fs.readFileSync(out.proof)));assert.ok(fs.existsSync(f.source));assert.throws(()=>custody.apply(p),/完了済み/);
});
test('changed tree, unplanned repo, external link or existing destination never moves a source',()=>{
 for(const mode of ['changed','new','symlink','destination','parent']){
  const f=fixture(),p=custody.plan(f.source,f.dest);
  if(mode==='changed')fs.writeFileSync(path.join(f.dir,'unstaged'),'later');
  if(mode==='new')repo(path.join(f.source,'.ai/work/other'));
  if(mode==='symlink')fs.symlinkSync(root,path.join(f.dir,'external'));
  if(mode==='destination'){fs.mkdirSync(f.dest);fs.writeFileSync(path.join(f.dest,'other'),'keep');}
  if(mode==='parent'){fs.writeFileSync(path.join(f.source,'base'),'other');g(f.source,'add','base');}
  assert.throws(()=>custody.apply(p));assert.ok(fs.existsSync(f.dir),mode);assert.ok(fs.existsSync(f.dir2),mode);assert.equal(fs.existsSync(path.join(f.dest,'repo-0')),false,mode);
 }
});
test('external Git dependencies and linked Git directories are refused while planning',()=>{
 for(const mode of ['alternates','worktrees','shallow','promisor','core','gitfile']){
  const f=fixture();
  if(mode==='alternates')fs.writeFileSync(path.join(f.dir,'.git/objects/info/alternates'),root);
  if(mode==='worktrees')fs.mkdirSync(path.join(f.dir,'.git/worktrees'));
  if(mode==='shallow')fs.writeFileSync(path.join(f.dir,'.git/shallow'),g(f.dir,'rev-parse','HEAD')+'\n');
  if(mode==='promisor')fs.writeFileSync(path.join(f.dir,'.git/objects/pack/fake.promisor'),'');
  if(mode==='core')g(f.dir,'config','core.worktree',f.dir);
  if(mode==='gitfile'){const gd=path.join(root,'outside-git-'+serial);fs.renameSync(path.join(f.dir,'.git'),gd);fs.writeFileSync(path.join(f.dir,'.git'),'gitdir: '+gd+'\n');}
  assert.throws(()=>custody.plan(f.source,f.dest),undefined,mode);assert.ok(fs.existsSync(f.dir));assert.equal(fs.existsSync(f.dest),false);
 }
});
test('interrupted move has durable intent, retains every tree and resumes only the exact plan',()=>{
 const f=fixture(),p=custody.plan(f.source,f.dest),rename=fs.renameSync;
 fs.renameSync=(a,b)=>{if(a===path.join(f.source,p.trees[1].path))throw Error('injected move failure');return rename(a,b);};
 try{assert.throws(()=>custody.apply(p),/injected/);}finally{fs.renameSync=rename;}
 const journal=JSON.parse(fs.readFileSync(path.join(f.dest,'custody.json')));assert.equal(journal.complete,false);assert.equal(journal.steps[0],'verified');assert.equal(journal.steps[1],'moving');
 assert.ok(fs.existsSync(path.join(f.dest,'repo-0')));assert.ok(fs.existsSync(path.join(f.source,p.trees[1].path)));assert.equal(fs.existsSync(path.join(f.source,'.ai/nested-git-preservation',p.id+'.json')),false);
 assert.throws(()=>custody.apply({...p,id:'a'.repeat(36)}));assert.equal(custody.apply(p).complete,true);
});
test('an interrupted lock, symlinked destination, overlapping plan and changed custody cannot be bypassed',()=>{
 const f=fixture(),p=custody.plan(f.source,f.dest),rename=fs.renameSync;
 fs.renameSync=(a,b)=>{if(a===path.join(f.source,p.trees[1].path))throw Error('stop');return rename(a,b);};try{assert.throws(()=>custody.apply(p));}finally{fs.renameSync=rename;}
 fs.mkdirSync(path.join(f.dest,'apply.lock'));assert.throws(()=>custody.apply(p));fs.rmdirSync(path.join(f.dest,'apply.lock'));
 fs.writeFileSync(path.join(f.dest,'repo-0/unstaged'),'changed after move');assert.throws(()=>custody.apply(p),/計画と一致/);assert.ok(fs.existsSync(path.join(f.source,p.trees[1].path)));
 assert.throws(()=>custody.plan(f.source,path.join(f.source,'inside')),/コピーの外/);
 const link=path.join(root,'link-'+serial);fs.symlinkSync(root,link);assert.throws(()=>custody.plan(f.source,path.join(link,'dest')),/リンク/);
});
test('hardlinked clone objects and ordinary files become independent without altering peers',()=>{
 const f=fixture(),external=path.join(root,'shared-'+serial);fs.writeFileSync(external,'shared object');fs.linkSync(external,path.join(f.dir,'shared'));const p=custody.plan(f.source,f.dest);custody.apply(p);
 const i=p.trees.findIndex(t=>t.path.endsWith('/site')),saved=path.join(f.dest,'repo-'+i,'shared');assert.equal(fs.statSync(saved).nlink,1);fs.writeFileSync(external,'peer changed');assert.equal(fs.readFileSync(saved,'utf8'),'shared object');assert.equal(custody.manifest(path.join(f.dest,'repo-'+i)).hash,p.trees[i].hash);
});
test('configuration includes, deeper Git dependencies and ignored custody proof require separate handling',()=>{
 for(const mode of ['include','inner-dir','inner-file','ignored-proof']){
  const f=fixture();
  if(mode==='include')g(f.dir,'config','include.path',path.join(root,'not-present-config'));
  if(mode==='inner-dir'){const other=repo(path.join(f.dir,'ignored/another'));fs.writeFileSync(path.join(other,'.git/objects/info/alternates'),root);}
  if(mode==='inner-file'){fs.mkdirSync(path.join(f.dir,'ignored/linked'));fs.writeFileSync(path.join(f.dir,'ignored/linked/.git'),'gitdir: /outside');}
  if(mode==='ignored-proof')fs.writeFileSync(path.join(f.source,'.gitignore'),'.ai/nested-git-preservation/\n');
  assert.throws(()=>custody.plan(f.source,f.dest),undefined,mode);assert.ok(fs.existsSync(f.dir));assert.equal(fs.existsSync(f.dest),false);
 }
});

test('a self-contained clone inside another clone retains its own complete Git history',()=>{
 const f=fixture(),inner=repo(path.join(f.dir,'site')),head=g(inner,'rev-parse','HEAD');fs.writeFileSync(path.join(inner,'local'),'nested unsaved');const p=custody.plan(f.source,f.dest);custody.apply(p);const i=p.trees.findIndex(t=>t.path.endsWith('/site')),saved=path.join(f.dest,'repo-'+i,'site');assert.equal(g(saved,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(saved,'local'),'utf8'),'nested unsaved');g(saved,'fsck','--connectivity-only');
});
test('dangling symbolic remote HEAD is preserved and declared; missing history is still refused',()=>{
 const f=fixture(),inner=repo(path.join(f.dir,'site'));g(inner,'symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/missing');
 const p=custody.plan(f.source,f.dest),i=p.trees.findIndex(t=>t.path.endsWith('/site'));assert.deepEqual(p.trees[i].gitWarnings,[{path:'site',kind:'dangling-origin-head',target:'refs/remotes/origin/missing',preserved:true}]);custody.apply(p);assert.equal(g(path.join(f.dest,'repo-'+i,'site'),'symbolic-ref','refs/remotes/origin/HEAD'),'refs/remotes/origin/missing');
 const bad=fixture();fs.writeFileSync(path.join(bad.dir,'.git/refs/heads/missing'),'a'.repeat(40)+'\n');assert.throws(()=>custody.plan(bad.source,bad.dest));assert.ok(fs.existsSync(bad.dir));
});
