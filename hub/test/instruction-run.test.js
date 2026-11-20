'use strict';
const AGY_FIXTURE = { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' };
// Existing behavior and message assertions use the Japanese default contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const chat = require('../lib/chat'), instructions = require('../lib/instructions');
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-rules-run-'));
const fake = path.join(dir, 'fake.cjs');
const missingSid = '10000000-0000-4000-8000-000000000001';
const otherSid = '10000000-0000-4000-8000-000000000002';
const missingResult = session_id => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id,
  errors: [`No conversation found with session ID: ${session_id}`],
});
fs.writeFileSync(fake, `#!${process.execPath}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const claude=process.argv.includes('claude'), current=input.slice(input.lastIndexOf('# 今回の依頼')), out=x=>console.log(JSON.stringify(x)), compact=current.includes('compact-now'), fail=current.includes('fail-now');
if(claude&&current.includes('missing-session')){
  out(current.includes('mismatch')?${JSON.stringify(missingResult(otherSid))}:${JSON.stringify(missingResult(missingSid))});
  process.exitCode=1;return;
}
if(claude){out({type:'system',session_id:'sid'});if(compact)out({type:'system',subtype:'compact_boundary'});out({type:'assistant',message:{content:[{type:'text',text:JSON.stringify({input:input.replaceAll('[[質問]]','template').replaceAll('[[/質問]]','end')})}]}});out({type:'result',is_error:fail,result:fail?'authentication failed':'',usage:{input_tokens:11,cache_read_input_tokens:22,cache_creation_input_tokens:33}});}
else{out({type:'thread.started',thread_id:'sid-codex'});out({type:'item.completed',item:{type:'agent_message',text:'ok'}});out({type:'turn.completed',usage:{input_tokens:44,cached_input_tokens:12}});}});`, { mode: 0o755 });
const policy = '【モデルの決まり】fixture\n【利用上限の時】現在は自動交代がオフ\n【別の AI に作業を渡す時】fixture\n【人への操作案内の決まり】fixed\n【操作情報】dynamic';
const packet = issues => instructions.packet({ pdir: dir, task: 'task', policy, issues, common: 'cwd=fixture', contextRule: 'context', askRule: chat.ASK_RULE, port: 1 });
const runner = new chat.ChatRunner({ dirOf: () => dir });
const wait = async () => { for (let i = 0; i < 100 && runner.busy('p', 'task'); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(runner.busy('p', 'task'), null); };
const send = async (text, issues = 'issue') => { runner.send({ ai: 'claude', model: 'Fable 5.2', project: 'p', task: 'task', pdir: dir, dir, text, perm: `${fake} claude`, basePrompt: packet(issues) }); await wait(); const input = JSON.parse(chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1).text).input; assert.ok(input.includes(instructions.SEND_TEXT_RULE), text); assert.equal(input.split(instructions.PATH_RULE).length - 1, 1, text); return input; };
test('実行からmetaを保存し5番ごと・圧縮後・失敗後・全文変更時に復元、usageも保存', async () => {
  assert.match(await send('one'), /【モデルの決まり】/);
  for (const text of ['two', 'three', 'four']) assert.match(await send(text), /【決まり】前回と同じ/);
  assert.match(await send('five'), /【モデルの決まり】/);
  assert.match(await send('compact-now'), /【決まり】前回と同じ/);
  assert.equal(chat.readMeta(dir, 'task').rulesSent.claude.restore, true);
  assert.match(await send('after-compact'), /【モデルの決まり】/);
  await send('fail-now'); assert.equal(chat.readMeta(dir, 'task').rulesSent.claude.restore, true);
  assert.match(await send('after-fail'), /【モデルの決まり】/);
  assert.match(await send('changed', 'changed issue'), /【モデルの決まり】/);
  const row = chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1); assert.deepEqual(row.usage, { input_tokens: 11, cache_read_input_tokens: 22, cache_creation_input_tokens: 33 });
  runner.send({ ai: 'codex', model: 'GPT-6.1-Sol', project: 'p', task: 'task', pdir: dir, dir, text: 'codex', perm: fake, basePrompt: packet('issue') }); await wait();
  assert.deepEqual(chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1).usage, { input_tokens: 44, cached_input_tokens: 12 });
});
test('会話整理は既存セッションを再開せず、重複履歴・作業指示を渡さず、再開情報を保持する',async()=>{
 const original={sessions:{claude:'long-session'},models:{claude:'Opus 5.5'},sessionAccounts:{claude:'default'},rulesSent:{claude:{sid:'long-session',hash:'old',turns:3}},accounts:{},compacted:'before'};
 chat.writeMeta(dir,'selection',original);chat.append(dir,'selection',{role:'user',text:'UNIQUE_OLD_HISTORY'});
 const options={ai:'claude',model:'Opus 5.5',effort:'高',project:'p',task:'selection',pdir:dir,dir,text:'[task-auto:fixture] compact-now fail-now',selectionOnly:true,basePrompt:'台帳='+dir,perm:`${fake} claude`};
 const turn=chat.buildTurn({...options,meta:original,rows:chat.read(dir,'selection')});
 assert.equal(turn.resume,false);assert.ok(!turn.args.includes('--resume'));assert.ok(turn.args.includes('claude-opus-5-5'));assert.ok(turn.args.includes('high'));
 assert.doesNotMatch(turn.stdin,/<previous_conversation>|UNIQUE_OLD_HISTORY|\[\[質問\]\]/);
 const sent=runner.send(options);await sent.started;
 for(let i=0;i<100&&runner.busy('p','selection');i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(runner.busy('p','selection'),null);assert.deepEqual(chat.readMeta(dir,'selection'),original);
 assert.match(chat.read(dir,'selection').at(-1).error,/authentication failed/);
 const codex=chat.buildTurn({...options,ai:'codex',model:'GPT-6.1-Sol',readOnly:true,meta:{sessions:{codex:'long'},models:{codex:'GPT-6.1-Sol'}},rows:[]});
 assert.equal(codex.resume,false);assert.ok(codex.args.includes('gpt-6.1-sol'));assert.ok(codex.args.includes('read-only'));
 const launch=require('../lib/launch');launch.setDiscoveredModels({agy:{models:[AGY_FIXTURE]}});
 try{const agy=chat.buildTurn({...options,ai:'agy',model:'Gemini 3.1 Pro (High)',meta:{},rows:[]});assert.equal(agy.command,fake);assert.equal(agy.resume,false);}
 finally{launch.setDiscoveredModels({});}
});

const sessionOptions = (task, text) => ({ ai: 'claude', model: 'Opus 5.5', project: 'p', task, pdir: dir, dir, text, perm: `${fake} claude`, basePrompt: 'fixture' });
const unfinished = require('../lib/chat-continuation');
const seedSessions = task => {
  const meta = {
    sessions: { codex: 'keep-codex', claude: missingSid },
    sessionAccounts: { claude: 'default' },
    rulesSent: { codex: { sid: 'keep-codex' }, claude: { sid: missingSid } },
  };
  chat.writeMeta(dir, task, meta);
  chat.append(dir, task, { role: 'assistant', ai: 'codex', text: '既存会話の記録' });
  return meta;
};

test('Claudeが再開前に会話を見つけられなければ、その再開情報だけを片付けて未完を保持する', async () => {
  const task = 'missing';
  seedSessions(task);
  const failed = runner.send(sessionOptions(task, 'missing-session'));
  assert.equal(failed.resume, true);
  await runner.busy('p', task).finishedP;
  const rows = chat.read(dir, task);
  assert.equal(rows.filter(r => r.role === 'user').length, 1);
  assert.equal(rows.filter(r => r.role === 'assistant' && r.ai === 'claude').length, 1);
  assert.match(rows.find(r => r.ai === 'claude' && r.role === 'assistant').error, /以前の会話を見つけられませんでした/);
  assert.deepEqual(chat.readMeta(dir, task).sessions, { codex: 'keep-codex' });
  assert.deepEqual(chat.readMeta(dir, task).rulesSent, { codex: { sid: 'keep-codex' } });
  assert.equal(unfinished.read(dir, task).entries[failed.userRow.turn].status, 'open');

  const next = runner.send({ ...sessionOptions(task, '続けてください'), unfinishedId: failed.userRow.turn });
  assert.equal(next.resume, false);
  await runner.busy('p', task).finishedP;
  const answer = chat.read(dir, task).findLast(r => r.role === 'assistant');
  assert.match(JSON.parse(answer.text).input, /既存会話の記録/);
  assert.equal(chat.readMeta(dir, task).sessions.claude, 'sid');
  assert.equal(unfinished.read(dir, task).entries[failed.userRow.turn].status, 'continued');
});

test('拒否された番号が別の会話なら保存済みのClaude会話を保持する', async () => {
  const task = 'missing-other';
  seedSessions(task);
  const sent = runner.send(sessionOptions(task, 'missing-session mismatch'));
  assert.equal(sent.resume, true);
  await runner.busy('p', task).finishedP;
  assert.equal(chat.readMeta(dir, task).sessions.claude, missingSid);
  assert.equal(chat.read(dir, task).findLast(r => r.role === 'assistant').error, 'エラー');
});

test('旧版の失敗記録から、最初の再送時に新しいClaude会話を開始できる', async () => {
  const task = 'missing-legacy';
  seedSessions(task);
  const spoolRoot = path.join(dir, 'legacy-spool');
  const runId = '10000000-0000-4000-8000-000000000003';
  const runDir = path.join(spoolRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'exit.json'), JSON.stringify({ code: 1, signal: null }));
  fs.writeFileSync(path.join(runDir, 'out.jsonl'), JSON.stringify({ n: 1, line: JSON.stringify(missingResult(missingSid)) }) + '\n');
  fs.writeFileSync(path.join(runDir, 'finished.json'), '{}');
  chat.append(dir, task, { role: 'assistant', ai: 'claude', account: 'default', text: '', error: 'エラー', spoolId: `${runId}:final` });

  const supervised = new chat.ChatRunner({ dirOf: () => dir, spoolRoot });
  const next = await supervised.send(sessionOptions(task, '旧版の依頼の続き'));
  assert.equal(next.resume, false);
  await supervised.busy('p', task).finishedP;
  const answer = chat.read(dir, task).findLast(r => r.role === 'assistant');
  assert.match(JSON.parse(answer.text).input, /既存会話の記録/);
  assert.deepEqual(chat.readMeta(dir, task).sessions, { codex: 'keep-codex', claude: 'sid' });
});
