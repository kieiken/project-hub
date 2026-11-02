"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {app}=require('./fixtures/app-ui-harness.cjs');
test('message clocks preserve native labels across locale, date, DST and timezone changes',()=>{
 const c=app().context,previous=process.env.TZ;
 try {
 for(const zone of ['Asia/Tokyo','America/New_York','Europe/London']) {
  process.env.TZ=zone;
  for(const locale of ['ja-JP','en-US','en-GB','ar-EG']) {
   c.locale=locale;vm.runInContext('UI={...UI,dateLocale:locale}',c);
   for(const at of ['2026-01-01T00:00:00Z','2026-07-01T12:59:59Z','2026-03-08T06:59:00Z','2026-03-08T07:00:00Z','invalid']) {
    const label=new Date(at).toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'});
    assert.ok(c.baseMsgHtml({role:'user',text:'exact body',at}).includes(label),zone+' '+locale+' '+at);
   }
  }
 }
 assert.match(c.baseMsgHtml({role:'user',text:'exact body'}),/class="small">・/);
 } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
