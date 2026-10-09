'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {Skills}=require('../lib/skills');
test('skills scan, selection persistence, prompts, changed source and missing file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-skills-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);const file=path.join(source,'SKILL.md');fs.writeFileSync(file,'---\nname: 測試技能\ndescription: 唯讀檢查\n---\n內容');
 const manager=new Skills(root);manager.saveRoots([source]);let catalog=manager.status();assert.equal(catalog.items[0].name,'測試技能');assert.equal(manager.prompt('p'),'');
 manager.select('p',[catalog.items[0].id]);assert.match(new Skills(root).prompt('p'),/SKILL.md/);assert.equal(manager.prompt('other'),'');
 assert.throws(()=>manager.select('p',['bad']));assert.throws(()=>manager.saveRoots(['relative']));
 fs.writeFileSync(file,'---\nname: 新名稱\n---\n內容');assert.match(manager.prompt('p'),/新名稱/);
 fs.unlinkSync(file);assert.throws(()=>manager.prompt('p'),/遺失/);manager.select('p',[]);assert.equal(manager.prompt('p'),'');
});
test('junction skill sources are scanned once without following loops forever',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-skills-link-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),shared=path.join(root,'shared');fs.mkdirSync(source);fs.mkdirSync(shared);fs.writeFileSync(path.join(shared,'SKILL.md'),'---\nname: shared\n---\n');
 fs.symlinkSync(shared,path.join(source,'linked'),'junction');fs.symlinkSync(source,path.join(shared,'loop'),'junction');
 const manager=new Skills(root);assert.equal(manager.scan([source]).items.length,1);
});
