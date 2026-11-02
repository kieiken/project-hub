'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(saved){
 const frames=new Map(),observers=[];let frameId=0;
 const c={window:{},requestAnimationFrame(cb){frames.set(++frameId,cb);return frameId;},cancelAnimationFrame(id){frames.delete(id);},ResizeObserver:class{constructor(cb){this.cb=cb;observers.push(this);}observe(box){this.box=box;}disconnect(){this.closed=true;}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/chat-scroll.js'),'utf8'),c);
 const events={},box={dataset:{scrollKey:'p/t'},scrollTop:200,clientWidth:800,clientHeight:300,scrollHeight:1000,addEventListener(n,cb){events[n]=cb;},removeEventListener(n){delete events[n];}};
 const latest={hidden:true,addEventListener(n,cb){events['latest:'+n]=cb;},removeEventListener(n){delete events['latest:'+n];}};
 return {api:c.window.HubChatScroll,box,latest,events,frames,observers,flush(){const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb());},scroll:c.window.HubChatScroll.create(box,latest,saved)};
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
test('Layout scroll before resize callback keeps prior follow across capture, updates and repeated resizing',()=>{
 const a=fixture();a.scroll.rows(a.scroll.capture());a.box.scrollTop=700;a.events.scroll();
 a.box.clientWidth=600;a.box.scrollHeight=1400;a.events.scroll();
 assert.equal(a.scroll.capture().follow,true);assert.equal(a.api.capture(a.box,'p/t').follow,true);
 a.observers[0].cb();assert.equal(a.frames.size,1);a.flush();assert.equal(a.box.scrollTop,1400);assert.equal(a.latest.hidden,true);
 a.box.clientWidth=390;a.box.clientHeight=240;a.box.scrollHeight=2600;a.observers[0].cb();
 const before=a.scroll.capture();a.box.scrollHeight=2900;a.scroll.restore(before);a.flush();assert.equal(a.box.scrollTop,2900);
});
test('Reading anchor follows reflow; upward user input wins over pending resize and latest resumes follow',()=>{
 const a=fixture();a.scroll.rows(a.scroll.capture());
 let nodeTop=180,nodeHeight=200;const node={getBoundingClientRect:()=>({top:nodeTop-a.box.scrollTop,bottom:nodeTop+nodeHeight-a.box.scrollTop,height:nodeHeight})};
 a.box.getBoundingClientRect=()=>({top:0});a.box.children=[node];a.box.contains=n=>n===node;
 a.box.scrollTop=200;a.events.scroll();assert.equal(a.scroll.capture().follow,false);
 a.box.clientWidth=500;a.box.scrollHeight=1600;nodeTop=400;nodeHeight=400;a.observers[0].cb();a.flush();
 assert.equal(a.box.scrollTop,440);assert.equal(a.latest.hidden,false);
 a.events['latest:click']();a.box.scrollTop=1300;
 a.box.clientWidth=400;a.box.scrollHeight=2200;a.observers[0].cb();a.events.wheel({deltaY:-100});a.box.scrollTop=1200;a.events.scroll();a.flush();
 assert.equal(a.box.scrollTop,1200);assert.equal(a.scroll.capture().follow,false);
 a.events['latest:click']();assert.equal(a.scroll.capture().follow,true);
});
test('Native scroll, touch and keyboard past-reading intent survive layout; disposal cancels old callbacks',()=>{
 const a=fixture();a.scroll.rows(a.scroll.capture());a.box.scrollTop=200;a.events.scroll();assert.equal(a.scroll.capture().follow,false);
 a.events['latest:click']();a.box.clientWidth=700;a.box.scrollHeight=1800;a.observers[0].cb();a.events.keydown({key:'PageUp'});a.box.scrollTop=300;a.events.scroll();a.flush();assert.equal(a.scroll.capture().follow,false);
 a.events['latest:click']();a.events.touchstart({touches:[{clientY:100}]});a.events.touchmove({touches:[{clientY:150}]});assert.equal(a.scroll.capture().follow,false);
 a.box.clientWidth=500;a.observers[0].cb();assert.equal(a.frames.size,1);a.scroll.dispose();assert.equal(a.frames.size,0);assert.equal(a.observers[0].closed,true);assert.deepEqual(Object.keys(a.events),[]);
 a.scroll.dispose();
 const top=a.box.scrollTop;a.scroll.restore({follow:true});a.observers[0].cb();a.flush();assert.equal(a.box.scrollTop,top);assert.equal(a.frames.size,0);
});
test('Pinch gestures do not become past-reading intent',()=>{
 const a=fixture();a.scroll.rows(a.scroll.capture());
 a.events.wheel({deltaY:-100,ctrlKey:true});assert.equal(a.scroll.capture().follow,true);
 a.events.touchstart({touches:[{clientY:100},{clientY:200}]});a.events.touchmove({touches:[{clientY:150},{clientY:250}]});assert.equal(a.scroll.capture().follow,true);
 a.events.touchmove({touches:[{clientY:170}]});assert.equal(a.scroll.capture().follow,true);
});
test('A short conversation with no older scrollable rows keeps following after an upward gesture',()=>{
 const a=fixture();a.box.scrollHeight=a.box.clientHeight;a.scroll.rows(a.scroll.capture());a.box.scrollTop=0;a.events.scroll();
 a.events.wheel({deltaY:-100});a.events.keydown({key:'Home'});a.events.touchstart({touches:[{clientY:100}]});a.events.touchmove({touches:[{clientY:150}]});assert.equal(a.scroll.capture().follow,true);
 a.box.scrollHeight=2000;a.scroll.restore(a.scroll.capture());assert.equal(a.box.scrollTop,2000);
});

test('long-history reading reuses its visible anchor, then rescans after movement or removal',()=>{
 const a=fixture();let rectCalls=0;
 a.box.getBoundingClientRect=()=>({top:0});
 const rows=Array.from({length:500},(_,i)=>({parentElement:a.box,getBoundingClientRect(){rectCalls++;return {top:i*100-a.box.scrollTop,bottom:(i+1)*100-a.box.scrollTop,height:100};}}));
 a.box.children=rows;a.box.contains=n=>rows.includes(n);a.box.scrollHeight=50000;
 a.scroll.restore({top:40050,follow:false});
 const before=a.scroll.capture();assert.equal(before.anchor.node,rows[400]);
 rectCalls=0;
 for(let i=0;i<20;i++){a.box.scrollHeight+=100;a.scroll.restore(before);}
 assert.equal(a.scroll.capture().anchor.node,rows[400]);assert.equal(a.box.scrollTop,40050);assert.ok(rectCalls<100,'stable reading should not rescan 400 older rows');
 a.box.scrollTop=2010;a.events.scroll();assert.equal(a.scroll.capture().anchor.node,rows[20]);
 rows[20].parentElement=null;rows[20].getBoundingClientRect=()=>({top:0,bottom:0,height:0});
 a.scroll.restore(a.scroll.capture());assert.equal(a.scroll.capture().anchor.node,rows[21]);
});

test('explicit request disclosure holds its position, pauses follow and preserves subsequent appends',()=>{
 const a=fixture();a.scroll.rows(a.scroll.capture());a.box.scrollTop=700;a.events.scroll();
 a.api.change(a.box,()=>{a.box.scrollHeight=5000;});
 assert.equal(a.box.scrollTop,700);assert.equal(a.scroll.capture().follow,false);
 const before=a.scroll.capture();a.box.scrollHeight=6000;a.scroll.restore(before);assert.equal(a.box.scrollTop,700);
 a.api.change(a.box,()=>{a.box.scrollHeight=2000;});assert.equal(a.box.scrollTop,700);
 a.events['latest:click']();assert.equal(a.scroll.capture().follow,true);
 let changed=false;a.api.change({},()=>{changed=true;});assert.equal(changed,true);
});
