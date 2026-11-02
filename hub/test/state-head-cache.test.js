'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const exec=cp.execFile;let calls=0;cp.execFile=function(bin,args,...rest){if(bin==='git'&&args.includes('rev-parse'))calls++;return exec.call(this,bin,args,...rest);};
const git=require('../lib/git');
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'head-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const g=(...a)=>cp.execFileSync('git',['-C',dir,'-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...a],{encoding:'utf8',stdio:'pipe'}).trim();g('init','-q','-b','main');g('config','user.name','Fixture');g('config','user.email','fixture@localhost');g('commit','-q','--allow-empty','-m','one');return {dir,g};}
test('display reuses an unchanged HEAD without Git, but follows external refs and repacking',async t=>{
 const {dir,g}=fixture(t),nested=path.join(dir,'hub');fs.mkdirSync(nested);const one=await git.savedHeadAsync(nested),n=calls;assert.equal(await git.savedHeadAsync(nested),one);assert.equal(calls,n);
 g('commit','-q','--allow-empty','-m','two');const two=await git.savedHeadAsync(nested);assert.notEqual(two,one);assert.equal(calls,n+1);assert.equal(await git.savedHeadAsync(nested),two);assert.equal(calls,n+1);
 g('pack-refs','--all');assert.equal(await git.savedHeadAsync(nested),two);assert.equal(calls,n+2);
 g('update-ref','refs/heads/main',one);assert.equal(await git.savedHeadAsync(nested),one);assert.equal(calls,n+3);
 g('checkout','-q','--detach',two);assert.equal(await git.savedHeadAsync(nested),two);assert.equal(calls,n+4);
});
test('display ref failures discard the cache and recover; linked worktree common refs remain fresh',async t=>{
 const {dir,g}=fixture(t),one=await git.savedHeadAsync(dir),head=path.join(dir,'.git','HEAD'),bytes=fs.readFileSync(head);fs.writeFileSync(head,'ref: refs/heads/missing\n');assert.equal(await git.savedHeadAsync(dir),null);fs.writeFileSync(head,bytes);assert.equal(await git.savedHeadAsync(dir),one);
 const wd=path.join(dir,'copy');g('worktree','add','-q','-b','work',wd);assert.equal(await git.savedHeadAsync(wd),one);g('commit','-q','--allow-empty','-m','two');const two=g('rev-parse','HEAD');g('update-ref','refs/heads/work',two);assert.equal(await git.savedHeadAsync(wd),two);
});
