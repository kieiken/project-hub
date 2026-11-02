'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StateOffers}=require('../lib/state-offers');

function fixture(t){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'state-offers-snapshot-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base=path.join(root,'base'),git=path.join(base,'.git');fs.mkdirSync(path.join(git,'refs/heads'),{recursive:true});
  fs.writeFileSync(path.join(git,'HEAD'),'ref: refs/heads/main\n');fs.writeFileSync(path.join(git,'refs/heads/main'),'a'.repeat(40)+'\n');
  const tasks=Array.from({length:20},(_,i)=>({id:'t'+i,completionHash:'h'+i,parent:'',workdir:''}));
  const all=[{id:'P',tasks,folders:{}}],rows=[{project:'P',task:'t1',targetProject:'P',targetTask:'t0',received:{id:'r'}}];
  const view=new StateOffers({transfer:{store:{root},offers:()=>rows,file:()=>path.join(root,'receipt')},removal:{locked:()=>false,reviewBusy:()=>false,busy:()=>false},baseOf:()=>base});
  const builds=[];view.refresh=data=>builds.push(data);
  return {root,base,git,tasks,all,rows,view,builds};
}

test('display shares each repository stamp once and refreshes HEAD and index on later views',t=>{
  const f=fixture(t),read=fs.readFileSync;let heads=0;
  fs.readFileSync=function(file,...args){if(file===path.join(f.git,'HEAD'))heads++;return read.call(this,file,...args);};
  try{
    const first=f.view.view(f.all);assert.deepEqual(first,f.rows.map(r=>({...r,receiptChecked:false})));assert.equal(heads,1);
    const initial=f.builds.at(-1).signature;
    f.view.view(f.all);assert.equal(heads,1);assert.equal(f.builds.at(-1).signature,initial);
    fs.writeFileSync(path.join(f.git,'HEAD'),'b'.repeat(40)+'\n');f.view.view(f.all);assert.equal(heads,2);
    const detached=f.builds.at(-1).signature;assert.notEqual(detached,initial);
    fs.writeFileSync(path.join(f.git,'index'),'index changed');f.view.view(f.all);assert.equal(heads,2);assert.notEqual(f.builds.at(-1).signature,detached);
  }finally{fs.readFileSync=read;}
});

test('different bases and worktree common refs remain separate and fresh',t=>{
  const f=fixture(t),work=path.join(f.root,'work'),own=path.join(f.git,'worktrees/w');fs.mkdirSync(work);fs.mkdirSync(own,{recursive:true});
  fs.writeFileSync(path.join(work,'.git'),'gitdir: '+own+'\n');fs.writeFileSync(path.join(own,'commondir'),'../..\n');fs.writeFileSync(path.join(own,'HEAD'),'ref: refs/heads/main\n');
  f.tasks[0].workdir=work;f.tasks[2].workdir=work;f.view.view(f.all);const first=f.builds.at(-1).signature;
  fs.writeFileSync(path.join(f.git,'refs/heads/main'),'longer-ref\n');f.view.view(f.all);assert.notEqual(f.builds.at(-1).signature,first);
  const shared=f.builds.at(-1).signature;fs.writeFileSync(path.join(own,'HEAD'),'c'.repeat(40)+'\n');f.view.view(f.all);assert.notEqual(f.builds.at(-1).signature,shared);
});

test('a missing repository is retried on the next display build',t=>{
  const f=fixture(t),base=path.join(f.root,'later');f.view.baseOf=()=>base;
  f.view.view(f.all);const absent=f.builds.at(-1).signature;
  fs.mkdirSync(path.join(base,'.git'),{recursive:true});fs.writeFileSync(path.join(base,'.git/HEAD'),'d'.repeat(40)+'\n');
  f.view.view(f.all);assert.notEqual(f.builds.at(-1).signature,absent);
});
