'use strict';
process.env.HUB_LANG='ja';
const test=require('node:test'),assert=require('node:assert/strict');
const {License}=require('../lib/license');
// Execute the actual shared execution guard with real entitlement decisions. Substitute
// only the active-process inventory and stop store; no issuer, keys or AI.
function guardFixture(included=[]){
 const license=new License({owner:false,platform:'darwin',root:'/unused',store:{read:()=>null,write:()=>{throw Error('unexpected write');}},secret:{},fetcher:()=>{throw Error('unexpected network');}});
 license.prepare=async()=>{};
 const active=[];
 const {licenseGuard:guard}=require('../lib/engines/parallel')({getReqCtx:()=>({getStore:()=>null}),stopControl:{assert(){}},getSessions:()=>({list:()=>active}),getChats:()=>({running:new Map(),supervisedPid:()=>false}),getWebchat:()=>({busy:()=>[]}),getProcwatch:()=>({list:()=>[]}),license,extensions:{state:()=>({included})},lt:s=>s});
 return {guard,active,license};
}
test('free internal delivery keeps its exemption through queue/continuation, not other paid features',()=>{
 const {guard,active}=guardFixture(['idea_automation']),o={project:'P',task:'T',ai:'codex',origin:'hub-internal'};
 for(const stage of ['accept','start'])for(const queued of [{},{mode:'queued',licenseFeatures:['queue_auto']},{mode:'amend',request:'internal'}])assert.doesNotThrow(()=>guard({...o,...queued},stage));
 for(const extra of [{ai:'chatgpt'},{limitSwitch:{}},{automation:{kind:'idea'}},{licenseFeatures:['delegate']},{licenseFeatures:['parallel']}])assert.throws(()=>guard({...o,...extra}),{code:'license_held'});
 active.push({project:'P',task:'other',ai:'codex',running:true});assert.throws(()=>guard(o),{code:'license_held'});
});
test('user delegation needs its private part and entitlement; core internal acceptance does not',async()=>{
 const {guard,license}=guardFixture();
 assert.throws(()=>guard({origin:'delegate'}),{code:'feature_not_included'});
 assert.throws(()=>guard({origin:'hub-internal',automation:{kind:'idea'}}),{code:'feature_not_included'});
 assert.throws(()=>guardFixture(['delegate']).guard({origin:'delegate'}),{code:'license_held'});
 const {createDelivery}=require('../lib/request-delivery');
 const invoke=createDelivery({license,licenseGuard:guard,send:(_r,status,body)=>({status,...body}),store:{readProject:()=>null},launch:{AIS:['codex']},lt:s=>s});
 const response=await invoke({ai:'codex'},{});assert.equal(response.status,400);assert.equal(response.code,undefined);
 const paid=await invoke({ai:'codex'},{},{origin:'delegate'});assert.equal(paid.status,404);
});

test('maintenance refusal carries a stable type alongside the translated message',async()=>{
 const deliver=require('../lib/request-delivery').createDelivery({license:{prepare(){}},licenseGuard(){},send:(_r,status,body)=>({status,...body}),store:{readProject:()=>({id:'P'}),taskFile:()=>'/fixture'},launch:{AIS:['codex']},discussion:{active:()=>false},aiTools:{isOperating:()=>true},lt:()=> 'Maintenance in any language'});
 assert.deepEqual(await deliver({project:'P',task:'T',ai:'codex',text:'selection'},{}),{status:409,error:'Maintenance in any language',code:'HUB_AI_MAINTENANCE'});
});
