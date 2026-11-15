'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),cp=require('node:child_process');
const {ModelLimits,MODELS}=require('../lib/model-limits');
const NOW=Date.parse('2026-11-15T00:00:00Z'),sonnet='claude-sonnet-5-5',retired='gpt-retired';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-held-models-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'limits.json'),state=new ModelLimits(file,{now:()=>NOW});return {file,state};}
function hold(state,ai,model,account='default'){const at='2026-10-10T19:54:38.799Z';state.save({...state.data,[state.key(model,account)]:{version:2,ai,model,account,source:'cli-limit',hold:true,at,lastLimitAt:at,project:'test',task:'test',request:'test',validUntil:null,untilSource:'unknown',checkedAt:null}});}
function previous(file){const filename=path.resolve(__dirname,'../lib/model-limits.js'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(cp.execFileSync('git',['show','1cf98aff:hub/lib/model-limits.js'],{encoding:'utf8'}),filename);return new m.exports.ModelLimits(file,{now:()=>NOW});}
test('saved off-role holds appear and can clear; listing leaves the hold and detection models unchanged',t=>{
 const {file,state}=fixture(t);hold(state,'claude',sonnet);hold(state,'codex',retired,'backup');
 const before=fs.readFileSync(file,'utf8'),old=previous(file);
 assert.ok(old.active('default',sonnet));assert.equal(old.list().some(e=>e.model===sonnet),false);assert.throws(()=>old.clear('default',sonnet),/unknown limit model/);
 assert.deepEqual(state.models(),MODELS);assert.deepEqual(state.models(),old.models());
 assert.equal(state.list().find(e=>e.model===sonnet).until,null);assert.equal(state.list().some(e=>e.model===retired),false);
 assert.equal(state.list({codex:'backup'}).find(e=>e.model===retired).account,'backup');
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(state.forRequest({ai:'claude',model:sonnet}),old.forRequest({ai:'claude',model:sonnet}));
 state.clear('default',sonnet);assert.equal(state.active('default',sonnet),null);assert.ok(state.active('backup',retired));assert.throws(()=>state.clear('default','gpt-never-saved'),/unknown limit model/);
});
test('legacy provider-less holds are included while expired or malformed saved values stay out',t=>{
 const {file,state}=fixture(t);hold(state,'claude',sonnet);const data=JSON.parse(fs.readFileSync(file));
 data['gpt-legacy:backup']={source:'cli-limit',at:new Date(NOW-1000).toISOString(),checkedAt:new Date(NOW-500).toISOString(),validUntil:new Date(NOW+1000).toISOString()};
 data['claude-expired']={...data[sonnet],validUntil:new Date(NOW-1).toISOString(),untilSource:'usage',checkedAt:new Date(NOW).toISOString()};
 data['claude-invalid']={...data[sonnet],hold:false};data._cleared={};fs.writeFileSync(file,JSON.stringify(data));
 const restored=new ModelLimits(file,{now:()=>NOW}),choices=restored.clearableModels();
 assert.ok(choices.codex.includes('gpt-legacy'));assert.ok(!choices.claude.includes('claude-expired'));assert.ok(!choices.claude.includes('claude-invalid'));
 assert.equal(restored.list({codex:'backup'}).find(e=>e.model==='gpt-legacy').ai,'codex');
 restored.clearAccount('codex','backup');assert.equal(restored.active('backup','gpt-legacy'),null);assert.ok(restored.active('default',sonnet));
});
test('existing manual-clear route accepts a saved off-role hold and clears only the selected account',t=>{
 const {state}=fixture(t);hold(state,'claude',sonnet);hold(state,'claude',sonnet,'backup');hold(state,'claude','claude-opus-5-5');
 let response,checked;const routes=require('../lib/routes/limits')({send:(_res,status,body)=>response={status,body},usageSelection:()=>({claude:'default'}),accounts:{get:(ai,account)=>{checked={ai,account};}},usage:{snapshot:()=>({selection:{claude:'default'}})},limitEvidence:state,record(){},usageWithLimit:s=>({...s,limits:state.list(s.selection)}),lt:s=>s,limitModels:()=>MODELS,getDiscussion:()=>({limitModels:()=>({})})});
 routes.clear.handle({method:'POST'},{},new URL('http://localhost/api/limits/clear'),{ai:'claude',model:sonnet,account:'default'});
 assert.equal(response.status,200);assert.deepEqual(checked,{ai:'claude',account:'default'});assert.equal(state.active('default',sonnet),null);assert.ok(state.active('backup',sonnet));assert.ok(state.active('default','claude-opus-5-5'));assert.equal(response.body.limits.some(e=>e.model===sonnet),false);
});
