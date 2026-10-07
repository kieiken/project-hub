'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict');
const {family,sourceOf,validateTask}=require('../lib/work-context');
const main={id:'root',name:'Root',tasks:[{id:'a',kind:'main',parent:''}]};
const child={id:'sub',name:'Sub',parent:'root',tasks:[{id:'b',kind:'derived',derivedFrom:'root/a'}]};
const external={id:'other',name:'Other',tasks:[{id:'c'}]};const all=[main,child,external];
test('main and derived work are independent of tree parent, sources stay within one large project',()=>{
 assert.deepEqual(family(child,all).map(p=>p.id),['root','sub']);assert.equal(sourceOf(child,'root/a',all).task.id,'a');
 assert.equal(validateTask(child,null,{kind:'derived',derivedFrom:'root/a',workspaceMode:'direct'},all).workspaceMode,'direct');
 assert.equal(validateTask(child,null,{parent:'b'},all).kind,'main');
 assert.throws(()=>validateTask(child,null,{kind:'derived',derivedFrom:'other/c'},all),/同じ/);
 assert.throws(()=>validateTask(main,main.tasks[0],{kind:'derived',derivedFrom:'sub/b'},all),/循環/);
 assert.throws(()=>validateTask(main,main.tasks[0],{parent:'a'},all),/循環/);
});

test('unchanged legacy parent does not block kind edits, but a changed missing parent does',()=>{
 const t={id:'old',parent:'removed',kind:'main'};
 assert.equal(validateTask(main,t,{kind:'main'},all).kind,'main');
 assert.throws(()=>validateTask(main,t,{parent:'removed'},all),/親作業/);
});
