'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {app,snapshot}=require('./fixtures/app-ui-harness.cjs');
function fixture(project='p'){const f=app();f.context.data=snapshot();f.context.data.projects[0].id=project;if(project==='freetalk'){f.context.data.projects[0].kind='freetalk';f.context.data.projects[0].tasks[0].freetalk=true;}vm.runInContext("state=data;view={kind:'work',project:state.projects[0].id,task:'t'};",f.context);return f;}
for(const project of ['p','freetalk']) {
test('reminder UI '+project+': zero has no badge; title and sidebar show the active count, including completed tasks',()=>{
 const f=fixture(project),c=f.context;assert.equal(typeof c.unfinishedBadge,'function');assert.equal(vm.runInContext('unfinishedBadge(state.projects[0],state.projects[0].tasks[0])',c),'');
 vm.runInContext("state.projects[0].tasks[0].unfinishedCount=3;state.projects[0].tasks[0].state='完了';",c);
 assert.match(vm.runInContext('taskTree(state.projects[0],undefined)',c),/未完 3件/);
 // Same heading path is used on preserveMain refreshes so typing is not discarded.
 c.syncWorkQuestion();assert.match(f.element('[data-work-unfinished]').innerHTML,/未完 3件/);
 vm.runInContext('state.projects[0].tasks[0].unfinishedCount=0',c);c.syncWorkQuestion();assert.equal(f.element('[data-work-unfinished]').innerHTML,'');
 const css=fs.readFileSync(path.join(__dirname,'../public/app.css'),'utf8');assert.match(css,/\.unfinished-badge\{[^}]*flex:none;white-space:nowrap/);assert.match(css,/@media\(max-width:600px\)\{\.unfinished-badge/);
});
test('reminder UI '+project+': list escapes original request/reason/date and includes both actions',()=>{
 const {context:c}=fixture(project);assert.equal(typeof c.unfinishedListHtml,'function');const html=c.unfinishedListHtml([{original:'request <script>bad</script>',reason:'failure <b>x</b>',at:'2026-11-14'}]);assert.match(html,/request &lt;script&gt;/);assert.match(html,/failure &lt;b&gt;/);assert.match(html,/<time[^>]*>2026-11-14/);assert.match(html,/data-unfinished-draft="0"/);assert.match(html,/data-unfinished-dismiss="0"/);assert.doesNotMatch(html,/<script>/);
});
test('reminder UI '+project+': continue appends a draft and focuses input without HTTP, queue mutation or send',()=>{
 const f=fixture(project),c=f.context;assert.equal(typeof c.draftUnfinished,'function');let calls=0;c.fetch=()=>{calls++;throw Error('must not send');};c.api=()=>{calls++;throw Error('must not send');};f.element('#chat-in').value='existing draft';
 c.draftUnfinished(project,'t',{id:'receipt',original:'original request\nsecond line'});assert.equal(calls,0);assert.match(f.element('#chat-in').value,/existing draft[\s\S]*original request\nsecond line/);assert.match(f.element('#chat-in').value,/未完の記録：receipt/);assert.equal(f.document.activeElement,f.element('#chat-in'));
});
test('reminder UI '+project+': dismiss posts only the selected id/revision, refreshes the list/count and leaves other entries',async()=>{
 const f=fixture(project),c=f.context;assert.equal(typeof c.showUnfinished,'function');let dialog;const fields=new Map();const field=s=>{if(!fields.has(s))fields.set(s,{innerHTML:'',textContent:'',addEventListener(){}});return fields.get(s);};
 const query=f.document.querySelector;f.document.querySelector=s=>s==='#unfinished-dialog'?dialog||null:query(s);
 f.document.createElement=()=>({handlers:{},isConnected:true,querySelector:field,addEventListener(n,fn){this.handlers[n]=fn;},showModal(){},close(){},remove(){}});f.document.body={appendChild(el){dialog=el;}};
 const entries=[{id:'one',updated:'r1',original:'first',reason:'stopped',at:'date'},{id:'two',updated:'r2',original:'second'}],calls=[];let refreshed=0;
 c.api=async(url,body)=>{calls.push({url,body});if(body){assert.equal(body.project,project);assert.equal(body.task,'t');assert.equal(body.id,'one');assert.equal(body.expectedUpdated,'r1');entries.shift();return {ok:true};}else{const query=new URL(url,'http://localhost').searchParams;assert.equal(query.get('project'),project);assert.equal(query.get('task'),'t');}return {entries:entries.slice()};};c.load=async opts=>{assert.equal(opts.preserveMain,true);refreshed++;};
 await c.showUnfinished(project,'t');assert.match(field('[data-unfinished-list]').innerHTML,/first/);const button={dataset:{unfinishedDismiss:'0'},disabled:false};await dialog.handlers.click({target:{closest:()=>button}});assert.equal(calls.length,3);assert.match(calls[1].url,/\/dismiss$/);assert.equal(refreshed,1);assert.doesNotMatch(field('[data-unfinished-list]').innerHTML,/first/);assert.match(field('[data-unfinished-list]').innerHTML,/second/);
});
}
