'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const launch = require('../lib/launch'), chat = require('../lib/chat');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-launch-scope-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dirs={};for(const name of ['main','copy','ledger','reference']){dirs[name]=path.join(root,name);fs.mkdirSync(dirs[name]);}return dirs; }
const roots = args => args.flatMap((x,i)=>x==='--add-dir'?[args[i+1]]:[]);
test('plain existing role commands explicitly enable only bounded Codex writes and Claude file edits',t=>{
  const f=fixture(t);
  for(const [ai,flag,value]of [['codex','--sandbox','workspace-write'],['claude','--permission-mode','acceptEdits']]){
    const args=launch.buildArgv({ai,cmd:ai,dir:f.main,writableDirs:[f.ledger],prompt:'owned task'}).args;
    assert.equal(args[args.indexOf(flag)+1],value);assert.deepEqual(roots(args),[fs.realpathSync(f.ledger)]);assert.equal(args.some(x=>/dangerously|danger-full-access|bypassPermissions/.test(x)),false);
    if(ai==='codex')assert.ok(args.includes('sandbox_workspace_write.writable_roots=[]'));
  }
});
test('legacy full access or extra-volume switches cannot expand a Hub-managed task',t=>{
  const f=fixture(t),args=launch.scopedArgs('codex',['--dangerously-bypass-approvals-and-sandbox','--add-dir','/Volumes/AI-WORK','-c','sandbox_workspace_write.writable_roots=["/"]','--sandbox','danger-full-access','--model','approved-model'],{dir:f.main,writableDirs:[f.ledger]});
  assert.deepEqual(roots(args),[fs.realpathSync(f.ledger)]);assert.equal(args.includes('/Volumes/AI-WORK'),false);assert.equal(args.some(x=>/danger-full-access|dangerously|writable_roots=\["\/"\]/.test(x)),false);assert.equal(args[args.indexOf('--model')+1],'approved-model');
  const claude=launch.scopedArgs('claude',['--dangerously-skip-permissions','--permission-mode','bypassPermissions','--add-dir=/'],{dir:f.main,writableDirs:[f.ledger]});assert.equal(claude.includes('bypassPermissions'),false);assert.deepEqual(roots(claude),[fs.realpathSync(f.ledger)]);
});
test('fresh and resumed Hub chats keep the task cwd and ledger writable while original-main/reference remain outside an isolated copy scope',t=>{
  const f=fixture(t);
  for(const ai of ['codex','claude'])for(const resume of [false,true]){
    const model=ai==='codex'?'GPT-6.1-Sol':'Fable 5.1',turn=chat.buildTurn({ai,model,effort:'高',perm:ai,dir:f.copy,pdir:f.ledger,meta:resume?{sessions:{[ai]:'owned-id'},models:{[ai]:model}}:{},rows:[],text:'write current task',basePrompt:'Read only reference: '+f.reference});
    assert.deepEqual(roots(turn.args),[fs.realpathSync(f.ledger)]);assert.equal(turn.args.includes(f.main),false);assert.equal(turn.args.includes(f.reference),false);assert.equal(turn.resume,resume);assert.ok(turn.args.includes(ai==='codex'?'workspace-write':'acceptEdits'));
    if(resume)assert.ok(turn.args.includes('owned-id'));
  }
});
test('shell terminal launches quote project paths and prompts; extra writable roots reject home/volume/filesystem roots',t=>{
  const f=fixture(t),prompt="do not execute `touch /tmp/x` $(touch /tmp/y)";
  const command=launch.buildCommand({ai:'codex',cmd:'codex',dir:f.main,writableDirs:[f.ledger],prompt});assert.ok(command.includes("'--sandbox' 'workspace-write'"));assert.ok(command.includes(launch.sq(prompt)));assert.ok(command.includes(launch.sq(fs.realpathSync(f.ledger))));
  for(const directory of ['/',os.homedir(),'/Volumes/AI-WORK'])assert.throws(()=>launch.scopedArgs('codex',[],{dir:f.main,writableDirs:[directory]}));
});
test('Hub-owned cwd rejects filesystem, home and volume roots, including symlink aliases',t=>{
  const f=fixture(t);
  for(const ai of ['codex','claude'])for(const [i,directory]of ['/',os.homedir(),'/Volumes','/Volumes/AI-WORK'].entries()){
    assert.throws(()=>launch.buildArgv({ai,dir:directory,prompt:'owned task'}));
    if(fs.existsSync(directory)){
      const alias=path.join(f.main,ai+'-broad-'+i);fs.symlinkSync(directory,alias,'dir');
      assert.throws(()=>launch.buildArgv({ai,dir:alias,prompt:'owned task'}));
      assert.throws(()=>launch.buildCommand({ai,dir:alias,prompt:'owned task'}));
    }
  }
});
test('project and work-copy cwd aliases use the canonical directory without adding duplicate writable roots',t=>{
  const f=fixture(t);
  for(const directory of [f.main,f.copy]){
    const alias=directory+'-alias';fs.symlinkSync(directory,alias,'dir');
    for(const ai of ['codex','claude']){
      const args=launch.scopedArgs(ai,[],{dir:alias,writableDirs:[directory,f.ledger]});
      assert.deepEqual(roots(args),[fs.realpathSync(f.ledger)]);
      assert.ok(args.includes(ai==='codex'?'workspace-write':'acceptEdits'));
    }
  }
  assert.ok(launch.buildCommand({ai:'codex',dir:path.join(f.main,'planned-project'),prompt:'owned task'}).includes(launch.sq(path.join(f.main,'planned-project'))));
});
