'use strict';
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const launch = require('../lib/launch'), chat = require('../lib/chat'), roles = require('../lib/roles');
let migration; try { migration = require('../lib/rules-migration'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const instructions = require('../lib/instructions');
const catalog = { codex: { models: [{id:'verified-low',label:'Verified',efforts:['低','高','Ultra']}, {id:'unknown-low',label:'Unknown'}] } };
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hub-fable52-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; };
const turn = (effort, extra={}) => chat.buildTurn({ai:'claude',model:'claude-opus-5-5',effort,meta:{},rows:[],text:'依頼',basePrompt:'自由対話の会話画面',...extra});

test('normal, resumed, and freetalk replies receive the reporting rule beside the question rule', t => {
  for (const extra of [{},{meta:{sessions:{claude:'saved'}}},{basePrompt:'自由対話の会話画面'}]) {
    const input = turn('高',extra).stdin;
    assert.equal(input.split(chat.REPORT_RULE).length-1,1); assert.equal(input.split(chat.ASK_RULE).length-1,1);
    assert.ok(input.indexOf(chat.REPORT_RULE)>input.indexOf(chat.ASK_RULE));
  }
  for(const extra of [{selectionOnly:true},{discussionTurn:true}]) {
    const input=turn('高',extra).stdin; assert.ok(!input.includes(chat.REPORT_RULE)); assert.ok(!input.includes(chat.ASK_RULE));
  }
  const pdir=temp(t);instructions.packet({pdir,task:'existing',policy:'モデルの決まり',issues:'',common:'',contextRule:'',askRule:chat.ASK_RULE,reportRule:chat.REPORT_RULE});
  const full=fs.readFileSync(path.join(pdir,'.ai/chat/existing.rules.md'),'utf8');assert.ok(full.includes(chat.REPORT_RULE));
  assert.ok(!instructions.WORKFLOW_RULE.includes('古い検証・委任の定型より優先'));
});

test('migration changes whole exact lines only, preserving line endings, final bytes and custom text', () => {
  assert.ok(migration, 'startup migration must exist');
  for (const [old,next] of migration.REPLACEMENTS) for (const end of ['\n','\r\n','']) {
    const before=Buffer.concat([Buffer.from('custom\r\n'+old+end),Buffer.from(end?'other\n'+old+' suffix\r\n '+old+'\n':''),Buffer.from([0xff])]);
    // An unterminated target with a trailing byte is deliberately not a whole matching line.
    const expected=end?Buffer.concat([Buffer.from('custom\r\n'+next.replaceAll('\n',end)+end+'other\n'+old+' suffix\r\n '+old+'\n'),Buffer.from([0xff])]):before;
    const after=migration.replaceLines(before);assert.deepEqual(after,expected);assert.deepEqual(migration.replaceLines(after),after);
    assert.deepEqual(migration.replaceLines(Buffer.from(old)),Buffer.from(next));
  }
  assert.deepEqual(migration.replaceLines(Buffer.alloc(0)),Buffer.alloc(0));
});

test('startup migration selects registered projects, is idempotent, and continues after read/write failures', t => {
 assert.ok(migration, 'startup migration must exist');
 const root=temp(t), {Store}=require('../lib/store');
 for(const name of ['valid','read-fails','write-fails','unregistered']){
   const dir=path.join(root,'Product',name);fs.mkdirSync(path.join(dir,'.ai'),{recursive:true});fs.writeFileSync(path.join(dir,'.ai/rules.md'),migration.REPLACEMENTS[0][0]+'\r\n');
   if(name!=='unregistered') fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: fixture\n---\n');
 }
 const store=new Store(root), io=Object.create(fs);
 io.readFileSync=(file,...args)=>{if(String(file).includes('read-fails'))throw Error('read denied');return fs.readFileSync(file,...args);};
 io.writeFileSync=(file,...args)=>{if(String(file).includes('write-fails'))throw Error('write denied');return fs.writeFileSync(file,...args);};
 const result=migration.migrate(store,io);assert.deepEqual(result.changed,['valid']);assert.equal(result.skipped.length,2);
 assert.equal(fs.readFileSync(path.join(root,'Product/unregistered/.ai/rules.md'),'utf8'),migration.REPLACEMENTS[0][0]+'\r\n');
 assert.deepEqual(migration.migrate(store,io).changed,[]);
});

test('Claude legacy Ultra becomes high and low reaches chat, terminal argv, shell and mid-session switch', () => {
 for(const [effort,flag] of [['Ultra','high'],['低','low']]){
  const args=turn(effort).args;assert.equal(args[args.indexOf('--effort')+1],flag);assert.ok(!args.includes('ultra'));
  const argv=launch.buildArgv({ai:'claude',effort,model:'claude-opus-5-5'}).args;assert.equal(argv[argv.indexOf('--effort')+1],flag);
  const shell=launch.buildCommand({ai:'claude',dir:'/private/tmp',prompt:'fixture',effort});assert.match(shell,new RegExp("'--effort' '"+flag+"'"));assert.doesNotMatch(shell,/ultra/);
  assert.equal(launch.switchCommand('claude','effort',effort),'/effort '+flag);
 }
 assert.equal(launch.buildArgv({ai:'codex',effort:'Ultra'}).args.includes('model_reasoning_effort=ultra'),true);
});

test('roles normalize old Claude Ultra without rewriting the file, reject new Ultra, and restrict low by verified model', t=>{
 launch.setDiscoveredModels(catalog);roles.setModelCatalog(catalog);
 const file=path.join(temp(t),'roles.yaml');const saved='models:\n  claude-code: [Opus 5.5]\n  codex: [Verified, Unknown]\nroles:\n  検査: { main: [claude-code, Opus 5.5, Ultra], backup: [codex, Verified, Ultra] }\n';fs.writeFileSync(file,saved);
 require('../lib/role-history').load(file); const bytes=fs.readFileSync(file,'utf8');
 const data=roles.read(file).data;assert.equal(data.roles[0].main.effort,'高');assert.equal(data.roles[0].backup.effort,'Ultra');assert.equal(fs.readFileSync(file,'utf8'),bytes);
 const check=(ai,model,effort)=>roles.validate(data.models,[{name:'new',main:{ai,model,effort},backup:{ai:'人'}}]);
 assert.ok(check('claude-code','Opus 5.5','Ultra').length);assert.deepEqual(check('claude-code','Opus 5.5','低'),[]);
 assert.deepEqual(check('codex','Verified','低'),[]);assert.ok(check('codex','Unknown','低').length);
 assert.deepEqual(launch.effortsFor('grok').includes('低'),false);assert.ok(!launch.effortsFor('claude').includes('Ultra'));
 assert.equal(launch.effortFlag('codex','低','Verified'),'low');assert.equal(launch.effortFlag('codex','低','Unknown'),'');
});

test('queued legacy Claude settings normalize before start', t=>{
 const pdir=temp(t), runner=new chat.ChatRunner({dirOf:()=>pdir,beforeSend:o=>{assert.equal(o.effort,'高');throw Error('fixture intercepted before spawning');}});
 const request={project:'p',task:'t',pdir,dir:pdir,ai:'claude',model:'claude-opus-5-5',effort:'Ultra',text:'queued fixture',basePrompt:''};
 runner.enqueue('p','t',request);const queued=runner.queue('p','t')[0];assert.equal(queued.effort,'Ultra');
 assert.throws(()=>runner.send({...request,...queued}),/fixture intercepted/);
});

test('all effort selectors use model-aware options; Claude hides Ultra and account catalogs gate Codex low',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
 const helpers=source.slice(source.indexOf('const normalizeEffort ='),source.indexOf('const effortHidden ='));
 const ctx=vm.createContext({state:{efforts:roles.EFFORTS,cliFlags:{codex:{Verified:'verified-low'}},codexModelCatalogs:{default:{models:catalog.codex.models},spare:{models:[]}}}});vm.runInContext(helpers,ctx);
 assert.equal(vm.runInContext("effortsFor('claude').includes('Ultra')",ctx),false);assert.equal(vm.runInContext("effortsFor('claude').includes('低')",ctx),true);
 assert.equal(vm.runInContext("effortsFor('codex','Verified').includes('低')",ctx),true);assert.equal(vm.runInContext("effortsFor('codex','Verified','spare').includes('低')",ctx),false);
 assert.equal(vm.runInContext("effortsFor('codex','Unknown').includes('Ultra')",ctx),true);assert.equal(vm.runInContext("effortsFor('grok').includes('低')",ctx),false);
});

test('Codex official reasoning list retains low only when reported by that model',()=>{
 const {codexModels}=require('../lib/ai-tools');
 const rows=codexModels(JSON.stringify({models:[{slug:'low-model',display_name:'Low model',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{slug:'high-model',display_name:'High model',visibility:'list',supported_reasoning_levels:[{effort:'high'}]}]}));
 assert.deepEqual(rows.find(r=>r.id==='low-model').efforts,['低','高']);assert.deepEqual(rows.find(r=>r.id==='high-model').efforts,['高']);
});

test('report and workflow translations match the active keys and unused old delegation entries are separate',()=>{
 for(const lang of ['en','zh-TW']){
  const pack=JSON.parse(fs.readFileSync(path.join(__dirname,'../../langpacks',lang,'backend.json'),'utf8')).messages;
  assert.ok(pack[chat.REPORT_RULE]);assert.ok(pack[instructions.WORKFLOW_RULE]);
  assert.doesNotMatch(pack[instructions.WORKFLOW_RULE],/takes priority over older verification|此確認方針優先於舊/);
  assert.ok(Object.keys(pack).some(k=>k.startsWith('## 委任の定型\n実装→チェック：最新HEAD')));
 }
});

test('terminal switch validates saves and sends low while legacy task Ultra reads as high',()=>{
 const commands=[],task={id:'t',model:'claude-opus-5-5',effort:'Ultra'};
 const ctx={lt:s=>s,launch,send:(_res,status,body)=>({status,body}),store:{readProject:()=>({tasks:[task]}),updateTask:(_p,_t,patch)=>Object.assign(task,patch)},pickSpec:t=>({model:t.model,effort:launch.normalizeEffort('claude',t.effort)}),sessions:{get:()=>null,type:(_p,_t,_ai,cmd)=>{commands.push(cmd);return true;}},modelError:()=>'',record:()=>{},accountFor:()=> 'default'};
 const handler=require('../lib/routes/terminal-io')(ctx).switch.handle;
 const call=(field,value)=>handler({},null,null,{project:'p',task:'t',ai:'claude',field,value});
 assert.equal(call('model','claude-opus-5-5').body.effort,'高');
 assert.equal(call('effort','Ultra').status,400);assert.equal(task.effort,'Ultra');
 assert.equal(call('effort','低').status,200);assert.equal(task.effort,'低');assert.equal(commands.at(-1),'/effort low');assert.ok(!commands.some(c=>c.includes('ultra')));
});
