'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{lt}=require('../lib/locale'),{ChatRunner}=require('../lib/chat');
for(const lang of ['ja','en','zh-TW'])test('external-folder refusals keep the Finder hint without reading translated keywords: '+lang,t=>{
 process.env.HUB_LANG=lang;
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-remove-locale-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root),p=store.createProject({name:'Fixture'}).project,r=new Removal({store,trash:path.join(root,'Trash')}),dir=path.join(root,'Outside');fs.mkdirSync(dir);
 const link=path.join(root,'linked');fs.symlinkSync(dir,link);
 const hint=lt('。Finderで手動でゴミ箱へ移してください');
 let c=r.externalCandidate(link,p,[p]);assert.equal(c.selectable,false);assert.ok(c.unavailableWhy.endsWith(hint));
 const huge=path.join(dir,'huge');fs.writeFileSync(huge,'');fs.truncateSync(huge,257*1024*1024);
 c=r.externalCandidate(dir,p,[p]);assert.equal(c.selectable,false);assert.ok(c.unavailableWhy.endsWith(hint));
 fs.unlinkSync(huge);c=r.externalCandidate(dir,p,[p]);assert.equal(c.selectable,true);assert.equal(c.unavailableWhy,'');
 c=r.externalCandidate(dir+'/missing',p,[p]);assert.equal(c.selectable,false);assert.ok(!c.unavailableWhy.includes('Finder'));
});
test('runner retains typed availability errors while keeping legacy string messages',()=>{
 const typed=Object.assign(Error('Maintenance'),{code:'HUB_AI_MAINTENANCE'});
 const runner=new ChatRunner({canStart:()=>typed});
 assert.throws(()=>runner.send({project:'P',task:'T',dir:'/unused',ai:'codex',model:'gpt-6.1-sol',text:'test'}),e=>e===typed);
 runner.canStart=()=> 'Legacy availability message';assert.throws(()=>runner.send({project:'P',task:'T',dir:'/unused',ai:'codex',model:'gpt-6.1-sol',text:'test'}),{message:'Legacy availability message'});
});
