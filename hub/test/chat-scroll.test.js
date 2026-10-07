'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(saved){
 const c={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/chat-scroll.js'),'utf8'),c);
 const events={},box={dataset:{scrollKey:'p/t'},scrollTop:200,clientHeight:300,scrollHeight:1000,addEventListener(n,cb){events[n]=cb;}};
 const latest={hidden:true,addEventListener(n,cb){events['latest:'+n]=cb;}};
 return {api:c.window.HubChatScroll,box,latest,events,scroll:c.window.HubChatScroll.create(box,latest,saved)};
}
test('Reading position survives rows, long growth and queue changes; latest is explicit',()=>{
 const a=fixture(),before=a.scroll.capture();a.box.scrollHeight=3000;a.scroll.restore(before);
 assert.equal(a.box.scrollTop,200);assert.equal(a.latest.hidden,false);
 a.scroll.rows(before);assert.equal(a.box.scrollTop,3000);
 a.box.scrollTop=420;const reading=a.scroll.capture();a.box.scrollHeight=4500;a.scroll.rows(reading);
 assert.equal(a.box.scrollTop,420);a.events['latest:click']();assert.equal(a.box.scrollTop,4500);assert.equal(a.latest.hidden,true);
});
test('Bottom follows large append; same-work redraw restores saved reading',()=>{
 const a=fixture({top:170,follow:false});a.scroll.rows(a.scroll.capture());assert.equal(a.box.scrollTop,170);
 a.box.scrollTop=700;const before=a.scroll.capture();a.box.scrollHeight=9000;a.scroll.restore(before);assert.equal(a.box.scrollTop,9000);
 a.box.scrollTop=250;assert.equal(a.api.capture(a.box,'other'),null);assert.equal(a.api.capture(a.box,'p/t').top,250);
});
