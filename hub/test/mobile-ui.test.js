'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 class Element {
  constructor(){this.children=[];this.handlers={};this.attrs={};this.className='';this.hidden=false;this.value='';this.dataset={};this.textContent='';this.classList={toggle:(name,on)=>{this.attrs[name]=on;}};}
  get firstChild(){return this.children[0];}
  get nextElementSibling(){const a=this.parent?.children;return a?.[a.indexOf(this)+1];}
  appendChild(e){this.insertBefore(e,null);}
  insertBefore(e,before){if(e.parent)e.parent.children.splice(e.parent.children.indexOf(e),1);e.parent=this;const i=before?this.children.indexOf(before):this.children.length;this.children.splice(i,0,e);}
  before(e){this.parent.insertBefore(e,this);}
  addEventListener(n,cb){this.handlers[n]=cb;}
  setAttribute(n,v){this.attrs[n]=v;}
  contains(e){return this===e||this.children.some(c=>c.contains(e));}
  focus(){doc.activeElement=this;}
  blur(){doc.activeElement=null;}
 }
 const elements=new Map();const el=s=>{if(!elements.has(s))elements.set(s,new Element());return elements.get(s);};
 const work=el('.work'),chat=el('.chat'),composer=el('#composer');work.appendChild(el('.whead'));work.appendChild(chat);work.appendChild(el('.wfoot'));chat.appendChild(composer);composer.appendChild(el('#chat-in'));el('#chat-images').hidden=true;
 const values=new Map(),media={matches:true,addEventListener(n,cb){this[n]=cb;}},vv={scale:1,height:700,offsetTop:0,addEventListener(n,cb){this[n]=cb;}};
 const properties={},doc={querySelector(s){if(s==='#mobile-work-info'||s==='#mobile-compose')return [...elements.values()].flatMap(e=>e.children).find(e=>e.id===s.slice(1))||null;if(s==='.working'||s==='.whead .s-実行中')return null;return el(s);},createElement(){return new Element();},body:new Element(),documentElement:{style:{setProperty(n,v){properties[n]=v;}}}};
 const scrollCalls=[],frames=[];
 const c={window:{visualViewport:vv,innerHeight:700,scrollY:0,scrollTo(x,y){scrollCalls.push({x,y,height:properties['--hub-visible-height']});this.scrollY=y;vv.offsetTop=0;}},requestAnimationFrame(cb){frames.push(cb);},document:doc,matchMedia:()=>media,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/mobile.js'),'utf8'),c);
 return {api:c.window.HubMobile,window:c.window,doc,el,values,media,vv,properties,work,composer,scrollCalls,frames};
}
test('Mobile folds retain draft, attachments, model and effort and collapse only after successful send',()=>{
 const a=fixture();a.api.mount('p/t');const button=a.doc.querySelector('#mobile-compose');
 assert.equal(a.doc.body.attrs['mobile-compose-open'],false);
 a.el('#chat-in').value='書きかけ';a.el('#chat-images').hidden=false;a.el('#chat-ai').value='codex|GPT-6.1-Sol';a.el('#chat-effort').value='極高';
 button.handlers.click();button.handlers.click();assert.match(button.textContent,/下書きあり/);
 assert.equal(a.el('#chat-in').value,'書きかけ');assert.equal(a.el('#chat-images').hidden,false);assert.equal(a.el('#chat-ai').value,'codex|GPT-6.1-Sol');assert.equal(a.el('#chat-effort').value,'極高');
 button.handlers.click();a.doc.activeElement=a.el('#chat-in');button.handlers.click();assert.equal(a.doc.activeElement,button);assert.equal(a.doc.body.attrs['mobile-compose-open'],false);assert.equal(a.el('#chat-in').value,'書きかけ');assert.equal(a.el('#chat-images').hidden,false);
 button.handlers.click();a.doc.activeElement=a.el('#chat-in');a.api.sent();assert.equal(a.doc.activeElement,null);assert.equal(a.doc.body.attrs['mobile-compose-open'],false);
});
test('Keyboard resize resets viewport offset only after applying the visible height',()=>{
 const a=fixture();a.api.mount('p/t');a.vv.height=340;a.vv.offsetTop=360;a.vv.resize();
 assert.deepEqual(a.scrollCalls,[{x:0,y:0,height:'340px'}]);assert.equal(a.properties['--hub-visible-height'],'340px');assert.equal(a.doc.body.attrs['mobile-keyboard'],true);
 a.vv.height=700;a.vv.resize();assert.equal(a.properties['--hub-visible-height'],'700px');assert.equal(a.doc.body.attrs['mobile-keyboard'],false);assert.equal(a.scrollCalls.length,1);
});
test('Viewport scroll resets a later page shift even when offsetTop is zero',()=>{
 const a=fixture();a.api.mount('p/t');a.vv.height=340;a.vv.resize();a.window.scrollY=360;a.vv.scroll();
 assert.deepEqual(a.scrollCalls,[{x:0,y:0,height:'340px'}]);assert.equal(a.window.scrollY,0);
 a.vv.scroll();assert.equal(a.scrollCalls.length,1);
});
test('Unshifted keyboard resize, viewport scroll and focus do not reset the page',()=>{
 const a=fixture();a.api.mount('p/t');a.vv.height=340;a.vv.resize();a.vv.scroll();a.composer.handlers.focusin();a.frames.shift()();
 assert.equal(a.scrollCalls.length,0);assert.equal(a.properties['--hub-visible-height'],'340px');
});
test('Pinch zoom and desktop keep their page position on resize, scroll and focus',()=>{
 for(const mode of ['pinch','desktop']){
  const a=fixture();a.api.mount('p/t');a.vv.height=340;a.vv.offsetTop=360;a.window.scrollY=360;
  if(mode==='pinch')a.vv.scale=2;else a.media.matches=false;
  a.vv.resize();a.vv.scroll();a.composer.handlers.focusin();a.frames.shift()();
  assert.equal(a.scrollCalls.length,0);assert.equal(a.properties['--hub-visible-height'],'100dvh');assert.equal(a.doc.body.attrs['mobile-keyboard'],false);assert.equal(a.window.scrollY,360);assert.equal(a.vv.offsetTop,360);
 }
});
test('Composer focus rechecks the layout on the next animation frame and preserves the input',()=>{
 const a=fixture();a.api.mount('p/t');const input=a.el('#chat-in');input.value='書きかけ';a.doc.activeElement=input;
 a.composer.handlers.focusin();assert.equal(a.frames.length,1);assert.equal(a.scrollCalls.length,0);
 a.vv.height=340;a.vv.offsetTop=360;a.frames.shift()();
 assert.deepEqual(a.scrollCalls,[{x:0,y:0,height:'340px'}]);assert.equal(a.el('#chat-in'),input);assert.equal(input.value,'書きかけ');assert.equal(a.doc.activeElement,input);
});
test('Information preference and current name remain discoverable; keyboard size restores and desktop keeps footer position',()=>{
 const a=fixture();a.api.mount('p/t');a.el('#mobile-info').handlers.click();assert.equal(a.values.get('hub-mobile-info'),'open');assert.equal(a.el('#mobile-info').textContent,'▲');assert.equal(a.el('#mobile-info').attrs['aria-label'],'情報と操作を閉じる');
 a.el('.whead h2').textContent='固定機能';a.el('#turn-n').textContent='返事待ち 2';a.el('#turn-done-n').textContent='完了確認 5';a.api.badges();assert.equal(a.el('#mobile-badges').textContent,'固定機能');
 a.el('#mobile-info').handlers.click();assert.equal(a.el('#mobile-info').textContent,'▼');assert.equal(a.el('#mobile-info').attrs['aria-label'],'情報と操作を開く');assert.equal(a.el('#mobile-badges').textContent,'固定機能');
 a.vv.height=340;a.vv.resize();assert.equal(a.properties['--hub-visible-height'],'340px');assert.equal(a.doc.body.attrs['mobile-keyboard'],true);a.vv.height=700;a.vv.resize();assert.equal(a.properties['--hub-visible-height'],'700px');assert.equal(a.doc.body.attrs['mobile-keyboard'],false);
 a.vv.scale=2;a.vv.resize();assert.equal(a.properties['--hub-visible-height'],'100dvh');
 a.media.matches=false;a.media.change();assert.equal(a.work.children.at(-1),a.el('.wfoot'));
});
test('Information name follows the current work or project and clears when leaving both',()=>{
 const a=fixture();a.el('.whead h2').textContent='固定機能';a.api.mount('p/t');
 assert.equal(a.el('#mobile-badges').textContent,'固定機能');
 a.el('.whead h2').textContent='別の作業 <>&';a.api.badges();
 assert.equal(a.el('#mobile-badges').textContent,'別の作業 <>&');assert.equal(a.el('#mobile-badges').title,'別の作業 <>&');
 a.el('.whead h2').textContent='';a.el('.ph h2').textContent='Project Hub';a.api.badges();assert.equal(a.el('#mobile-badges').textContent,'Project Hub');
 a.el('.ph h2').textContent='';a.api.badges();assert.equal(a.el('#mobile-badges').textContent,'');assert.equal(a.el('#mobile-badges').title,'');
});

test('Width change replaces only model option text, retaining select/input/attachments/effort', () => {
 const a=fixture();a.api.mount('p/t');const select=a.el('#chat-ai'),input=a.el('#chat-in');
 const option={value:'codex|GPT-6.1-Sol',dataset:{short:'6.1-Sol',full:'Codex・GPT-6.1-Sol'},textContent:'6.1-Sol'};
 select.options=[option];select.value=option.value;input.value='書きかけ';a.el('#chat-images').hidden=false;a.el('#chat-effort').value='極高';
 a.media.matches=false;a.media.change();assert.equal(option.textContent,'Codex・GPT-6.1-Sol');
 a.media.matches=true;a.media.change();assert.equal(option.textContent,'6.1-Sol');
 assert.equal(a.el('#chat-ai'),select);assert.equal(select.value,option.value);assert.equal(a.el('#chat-in'),input);assert.equal(input.value,'書きかけ');assert.equal(a.el('#chat-images').hidden,false);assert.equal(a.el('#chat-effort').value,'極高');
 option.dataset.short='Codex・GPT-6.1-Sol';a.api.labels();assert.equal(option.textContent,'Codex・GPT-6.1-Sol');
});
