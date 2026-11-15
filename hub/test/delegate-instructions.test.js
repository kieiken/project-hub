'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const instructions=require('../lib/instructions'),roles=require('../lib/roles'),{lt}=require('../lib/locale');
const baseline=require('./fixtures/instruction-baseline.json');
for(const lang of ['ja','en','zh-TW'])test('role/effort guidance and Ultra rules, both permission states: '+lang,t=>{
 const previous=process.env.HUB_LANG;process.env.HUB_LANG=lang;t.after(()=>{if(previous===undefined)delete process.env.HUB_LANG;else process.env.HUB_LANG=previous;});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-delegate-instructions-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const data={roles:[{name:'コーディング',main:{ai:'codex',model:'GPT-6.1-Sol',effort:'MAX'}}]};
 const delegate=require('../paid/delegate/policy')({lt,roles,executionRoles:()=>data,PORT:4545});
 const guide=delegate({id:'P'},{id:'T'});
 const curlExample=JSON.parse(guide.match(/-d '(\{[^\n]+?\})'/)[1]);
 assert.equal(curlExample.role,'コーディング');assert.equal(Object.hasOwn(curlExample,'effort'),false);
 const powershellExample=guide.match(/\$body = @\{([^}]+)\}/)[1];
 assert.match(powershellExample,/role = 'コーディング'/);assert.doesNotMatch(powershellExample,/\beffort\s*=/);
 assert.match(guide,/"effort":"極高"/);
 if(lang!=='ja'){assert.doesNotMatch(guide,/その1件だけ|主担当の機種|既存作業/);assert.doesNotMatch(guide,/秘密は書かない/);}
 let priorHash;
 for(const allowed of [false,true]){
  data.allowDelegateUltra=allowed;const rule=instructions.delegateUltraRule(data);
  assert.equal(rule.length,baseline.delegateUltraRuleChars[lang][allowed?'on':'off']);
  if(allowed){assert.match(rule,/Codex/);assert.match(rule,/Claude Code/);assert.doesNotMatch(rule,/ultracode/i);if(lang==='en')assert.match(rule,/multiplying cost and time/);else if(lang==='zh-TW')assert.match(rule,/費用與時間/);else assert.match(rule,/費用と時間が数倍/);}else assert.doesNotMatch(rule,/Codex|Claude Code|3つ|three|三項/);
  const prompt=instructions.packet({pdir:dir,project:'P',task:'T',policy:rule+'\n'+guide,port:4545,roleData:data}),part=instructions.split(prompt);
  const full=fs.readFileSync(path.join(dir,'.ai/chat/T.rules.md'),'utf8');
  assert.equal(part.fixed.split(rule).length-1,1);assert.equal(full.split(rule).length-1,1);
  const example=JSON.parse(part.fixed.match(/(\{"project":"P"[^\n]+?\})/)[1]);assert.equal(example.role,'コーディング');assert.equal(Object.hasOwn(example,'effort'),false);
  assert.match(part.fixed,/"effort":"極高"/);
  if(priorHash)assert.notEqual(part.hash,priorHash);priorHash=part.hash;
 }
});
