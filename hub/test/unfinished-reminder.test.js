'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const journal=require('../lib/chat-continuation'),chat=require('../lib/chat');
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-unfinished-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const entries={};for(const status of ['open','waiting','resuming','continued','cancelled','resolved'])entries[status]={id:status,status,original:'original\n'+status,partial:'retained partial '+status,reason:'reason '+status,source:{at:'2026-11-14T00:00:00Z'},updated:'revision',...(status==='resolved'?{resolution:{at:'revision',evidence:'verified result'}}:{})};journal.update(dir,'t',d=>{d.entries=entries;d.advances={source:{mode:'amend',id:'queued',phase:'waiting',source:{turn:'source'}}};});return {dir,entries};}
test('reminder: counts only open/waiting/resuming and cleanup prompt appears only for active records',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.summary,'function');assert.equal(journal.summary(dir,'t').unfinishedCount,3);
 const p=journal.prompt(dir,'t');assert.match(p,/返事の最後に未完の件数/);assert.match(p,/大掃除や整理/);assert.match(p,/確認した成果を根拠/);assert.match(p,/続けるか不要かを人に聞く/);assert.match(p,/再開は人の指示後だけ/);assert.ok(p.includes(path.join(dir,'.ai/chat/*.unfinished.json')));
 for(const e of journal.pending(dir,'t'))journal.dismiss(dir,'t',{id:e.id,expectedUpdated:e.updated});assert.equal(journal.summary(dir,'t').unfinishedCount,0);assert.equal(journal.prompt(dir,'t'),'');
});
test('reminder: dismissal preserves original/partial/advances, records owner/reason/date and differs from completion',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.dismiss,'function');const before=journal.read(dir,'t'),e=journal.dismiss(dir,'t',{id:'open',expectedUpdated:'revision'}),after=journal.read(dir,'t');
 assert.equal(e.status,'dismissed');assert.equal(e.dismissal.by,'owner');assert.equal(e.dismissal.reason,'人が不要と判断');assert.ok(Number.isFinite(Date.parse(e.dismissal.at)));assert.equal(e.updated,e.dismissal.at);assert.equal(e.resolution,undefined);
 assert.equal(e.original,before.entries.open.original);assert.equal(e.partial,before.entries.open.partial);assert.deepEqual(e.source,before.entries.open.source);assert.deepEqual(after.advances,before.advances);assert.equal(after.version,1);assert.deepEqual(after.entries.resolved,before.entries.resolved);
 assert.throws(()=>journal.resolve(dir,'t',{id:e.id,expectedUpdated:e.updated,evidence:'result'}),/取り消し/);
});
test('reminder: stale dismissal is rejected without changing a byte; closed requests cannot be dismissed again',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.dismiss,'function');const file=journal.file(dir,'t'),before=fs.readFileSync(file);assert.throws(()=>journal.dismiss(dir,'t',{id:'open',expectedUpdated:'stale'}),/変わりました/);assert.deepEqual(fs.readFileSync(file),before);
 assert.throws(()=>journal.dismiss(dir,'t',{id:'resolved',expectedUpdated:'revision'}),/閉じています/);assert.deepEqual(fs.readFileSync(file),before);
});
test('reminder: invalid dismissal metadata fails closed and summary exposes a warning',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.summary,'function');journal.update(dir,'t',d=>{d.entries.open.status='dismissed';});assert.throws(()=>journal.read(dir,'t'),/照合/);assert.match(journal.summary(dir,'t').unfinishedError,/照合/);assert.match(journal.prompt(dir,'t'),/確認せず再送・自動開始しない/);
});
test('reminder: owner dismissal during an active resumed turn survives its success and error saves',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.dismiss,'function');const dismissed=journal.dismiss(dir,'t',{id:'open',expectedUpdated:'revision'});
 const o={pdir:dir,task:'t',project:'P',text:'resumed',unfinishedId:'open'},run={userRow:{turn:'later',text:'resumed'},child:{},spawned:true};
 const runner=new chat.ChatRunner({dirOf:()=>dir});for(const [row,closed] of [[{text:'partial',error:'failed'},false],[{text:'done'},true]]){runner.saveUnfinished(o,run,row,closed,false);const saved=journal.read(dir,'t').entries.open;for(const k of ['status','original','partial','dismissal','updated'])assert.deepEqual(saved[k],dismissed[k]);}
});
test('reminder: manual cutover keeps stop verification but does not reinsert a dismissed original',t=>{
 const {dir}=fixture(t);assert.equal(typeof journal.dismiss,'function');journal.dismiss(dir,'t',{id:'open',expectedUpdated:'revision'});
 journal.update(dir,'t',d=>{d.advances={original:{id:'queued',mode:'amend',phase:'blocked',source:{turn:'original',entryId:'open',text:'DO NOT RESURRECT',spool:'/missing'}}};});
 const runner=new chat.ChatRunner({dirOf:()=>dir}),options={pdir:dir,task:'t',request:'queued',text:'new owner request'};
 assert.throws(()=>runner.continuationOptions(options),/終了保存が未確認/);

});
