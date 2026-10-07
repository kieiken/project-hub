'use strict';
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hub-github-api-'));
const root = path.join(tmp, 'root'), projectDir = path.join(root, 'Product/P'); fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'PROJECT.md'), '---\nname: P\nfolders: {}\n---\n');
Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: '0', HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'home') });
let server, sessions, base, githubHandle, githubOptions;
const githubModule = require('../lib/github'), makeGithub = githubModule.createGithub;
const {execFileSync,execFile} = require('node:child_process');
const realExec = require('node:util').promisify(execFile);
const git = (...args) => execFileSync('git',['-C',projectDir,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'test@local',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'test@local'}}).trim();
test.before(async () => {
  const probe = require('node:http').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  process.env.HUB_PORT = String(port);
  githubModule.createGithub = options => { githubOptions = options; githubHandle = makeGithub(options); return githubHandle; };
  try { ({ server, sessions } = require('../server')); } finally { githubModule.createGithub = makeGithub; } await new Promise(r => server.listen(port, '127.0.0.1', r)); base = 'http://127.0.0.1:' + port;
});
test.after(async () => { sessions.stopAll(); await new Promise(r => server.close(r)); });
const post = (url, body, headers = { 'X-Hub': '1' }) => fetch(base + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('GitHub HTTP routes obey Origin/X-Hub, expose no token and do not mutate without confirmation', async () => {
  const r = await fetch(base + '/api/github'); assert.equal(r.status, 200); const data = await r.json(); assert.equal(data.settings.account, 'kieiken'); assert.equal(data.ready, false);
  assert.equal((await post('/api/github', { account: 'kieiken' }, {})).status, 403);
  assert.equal((await post('/api/github/create', { project: 'P', confirm: true }, { 'X-Hub': '1', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/github/create', { project: 'P' })).status, 400);
  assert.equal((await post('/api/github/create', { project: 'missing' })).status, 404);
  const preview = await post('/api/github/preview', { project: 'P' }); assert.equal(preview.status, 200); assert.equal((await preview.json()).canPush, false);
  assert.equal((await post('/api/github/owners', { account: 'kieiken' })).status, 400);
  assert.equal((await post('/api/github', { account: 'kieiken' })).status, 400);
  const create = await post('/api/github/create', { project: 'P', confirm: true, name: 'x', account: 'kieiken', owner: 'kieiken', push: false }); assert.equal(create.status, 409);
  assert.equal(fs.existsSync(path.join(projectDir, '.git')), false); assert.equal(fs.existsSync(path.join(root, '_hub/github.json')), false);
  const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.github.ready, false); assert.equal(typeof state.projects[0].githubHasOrigin, 'boolean');
});

for (const failed of [false, true]) test(`HTTP start/verify share GitHub lock across ledgers and release after ${failed ? 'failure' : 'success'}`, async () => {
  // Isolated local fixtures; DRY keeps all AI and terminal starts from launching a CLI.
  if (!fs.existsSync(path.join(projectDir,'.git'))) {
    git('init','-q'); fs.writeFileSync(path.join(projectDir,'saved.txt'),'saved'); git('add','.'); git('commit','-qm','local fixture');
  } else git('remote','remove','origin');
  const copy = path.join(tmp,'copy'); fs.mkdirSync(copy,{recursive:true});
  const other = path.join(root,'Product/Alias'); fs.mkdirSync(path.join(other,'.ai/tasks'),{recursive:true});
  fs.writeFileSync(path.join(other,'PROJECT.md'),`---\nname: Alias\nfolders:\n  本体: ${projectDir}\n---\n`);
  for (const dir of [projectDir,other]) {
    fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
    for (const [id,mode,workdir] of [['direct','direct',projectDir],['copy','isolated',copy],['unprepared','isolated','']]) {
      fs.writeFileSync(path.join(dir,'.ai/tasks',id+'.md'),`---\nid: ${id}\ntitle: ${id}\nstate: 実行中\nworkspaceMode: ${mode}\nworkdir: ${workdir}\n---\n`);
    }
  }
  let release,entered;
  const hold = new Promise(r=>{release=r;}), waiting = new Promise(r=>{entered=r;});
  const mocked = makeGithub({...githubOptions,dry:false,exec:async (file,args,opts)=>{
    if (file==='git') return realExec(file,args,opts);
    assert.equal(file,'gh');
    if (args[0]==='--version') return {stdout:'gh mock',stderr:''};
    if (args[0]==='auth' && args[1]==='status') return {stdout:'Logged in to github.com account kieiken\nActive account: true',stderr:''};
    if (args[0]==='auth' && args[1]==='token') {entered();await hold;if(failed)throw Error('mock auth failure');return {stdout:'ghp_MOCK_ONLY',stderr:''};}
    if (args[0]==='repo') return {stdout:'',stderr:''};
    throw Error('Unexpected gh operation');
  }});
  Object.assign(githubHandle,mocked);
  const creating = post('/api/github/create',{project:'P',confirm:true,name:'local-mock',account:'kieiken',push:false});
  await waiting;
  try {
    for (const project of ['P','Alias']) {
      for (const task of ['direct','unprepared']) {
        for (const route of ['/api/term/start','/api/continue','/api/chat/send']) {
          const r = await post(route,{project,task,ai:'codex',text:'fixture',model:'gpt-6.1-sol'});
          assert.equal(r.status,409,project+' '+task+' '+route); assert.match((await r.json()).error,/GitHubの作成中/);
        }
      }
      const copied = await post('/api/term/start',{project,task:'copy',ai:'codex'});
      assert.equal(copied.status,200); assert.equal((await copied.json()).dir,copy);
      const verify = await post('/api/maintenance/verify',{project});
      assert.equal(verify.status,409); assert.match((await verify.json()).error,/AIまたは検証/);
    }
  } finally {release();}
  const result = await creating; assert.equal(result.status,failed?400:200);
  assert.equal(mocked.locked(projectDir),false);
  assert.equal((await post('/api/term/start',{project:'P',task:'direct',ai:'codex'})).status,200);
  assert.equal((await post('/api/maintenance/verify',{project:'Alias'})).status,200);
});
