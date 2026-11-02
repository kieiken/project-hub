'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const spool=require('../lib/cli-spool');
test('local fixture supervisor timestamps complete output rows; live reader accepts new and historical rows unchanged',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-output-time-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const begin=Date.now(),child=spool.start(path.join(root,'runs'),'fixture',{dir:root},{command:process.execPath,args:['-e',"process.stdout.write('first\\n');setTimeout(()=>process.stdout.write('partial'),80)"],stdin:''},{},[],process.env);
 t.after(()=>child.pause());
 for(let n=0;n<300&&!spool.read(child.dir,'exit.json');n++)await new Promise(r=>setTimeout(r,10));assert.ok(spool.read(child.dir,'exit.json'));
 const rows=fs.readFileSync(path.join(child.dir,'out.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(x=>[x.n,x.line]),[[1,'first'],[2,'partial']]);for(const r of rows)assert.ok(Number.isSafeInteger(r.at)&&r.at>=begin&&r.at<=Date.now());assert.ok(rows[1].at>=rows[0].at);
 child.pause();const owner=spool.read(child.dir,'owner.json'),read=new spool.SpoolChild(child.dir,owner),out=[];read.on('line',(line,n,replay)=>out.push([line,n,replay]));read.checkpoint=()=>{};read.poll();read.poll();assert.deepEqual(out.map(x=>x[0]),['first','partial']);
 const dir=path.join(root,'legacy');fs.mkdirSync(dir);spool.atomic(dir,'owner.json',owner);fs.writeFileSync(path.join(dir,'out.jsonl'),JSON.stringify({n:1,line:'old'})+'\n'+JSON.stringify({n:2,line:'new',at:Date.now()})+'\n');const old=new spool.SpoolChild(dir,owner),seen=[];old.on('line',line=>seen.push(line));old.poll();assert.deepEqual(seen,['old','new']);assert.equal(old.failure,undefined);
});
