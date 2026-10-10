'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-zh-tw-'));
const root = path.join(tmp, 'workspace');
const port = 59100 + Math.floor(Math.random() * 300);
Object.assign(process.env, { HUB_LANG: 'zh-TW', HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'ai-home') });
fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
fs.writeFileSync(path.join(root, '_hub', 'roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nroles:\n  司令塔: { main: [codex, GPT-6.1-Sol, 高], backup: [人], job: 協調 }\nswitch: { auto: false }\n');
const { lt, locale, configScript, sectionNames, label, templates } = require('../lib/locale');
const { Store, readSteps } = require('../lib/store');
const { parseAsk } = require('../lib/chat');
const { TOOLS } = require('../lib/chatgpt');
const instructions = require('../lib/instructions');
const { buildHandoffCard } = require('../lib/handoff-card');
const { loginPage, offPage } = require('../lib/remote');
const { Removal } = require('../lib/remove');
const { TaskTransfer } = require('../lib/task-transfer');
const { TaskIntegrate } = require('../lib/task-integrate');
const { server, sessions, taskPrompt } = require('../server');
const store = new Store(root);
let base;
const post = async (route, body) => {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
test.before(async () => {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  sessions.stopAll();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('locale selection keeps Japanese default and only translates owned literal parts', () => {
  assert.equal(locale(), 'zh-TW');
  assert.equal(lt('作業が見つかりません'), '找不到作業');
  const user = '作業が見つかりません / 日本語';
  assert.equal(lt`見つかりません：${user}`, '找不到：' + user);
  assert.equal(lt`${user}`, user);
  assert.equal(lt('custom user content'), 'custom user content');
  assert.equal(label('司令塔'), '指揮');
  assert.equal(label('デザイン'), '設計');
  assert.equal(label('画像生成'), '圖片生成');
  assert.equal(label('コーディング'), '程式設計');
  process.env.HUB_LANG = 'ja';
  assert.equal(lt('作業が見つかりません'), '作業が見つかりません');
  delete process.env.HUB_LANG;
  assert.equal(locale(), 'ja');
  process.env.HUB_LANG = 'zh-TW';
});

test('browser bootstrap is synchronous and escapes script endings', () => {
  const script = configScript();
  assert.ok(!script.includes('<'));
  const context = { window: {} };
  vm.runInNewContext(script, context);
  assert.equal(context.window.HUB_LOCALE.locale, 'zh-TW');
  assert.equal(context.window.HUB_LOCALE.language, 'zh-TW');
  assert.equal(context.window.HUB_LOCALE.messages['作業が見つかりません'], '找不到作業');
});

test('Chinese and Japanese task sections share steps, completion and append logic', () => {
  const template = path.join(templates(), 'project');
  assert.equal(template, path.join(__dirname, '../locales/zh-TW/templates/project'));
  const result = store.createProject({ name: '日本語名稱', description: '作業が見つかりません' }, template);
  assert.ok(!result.error);
  assert.equal(result.project.name, '日本語名稱');
  assert.equal(result.project.description, '作業が見つかりません');
  assert.equal(result.project.status, '進行中');
  assert.deepEqual(result.project.phases.map(p => p.name), ['規劃', '建立', '檢查', '收尾']);
  assert.match(fs.readFileSync(path.join(result.project.dir, '.ai/rules.md'), 'utf8'), /繁體中文|專案|作業/);
  const task = store.createTask(result.project.id, { title: '作業が見つかりません', role: '司令塔', owner: 'codex', steps: ['日本語步驟'], next: '下一步內容' });
  assert.equal(task.title, '作業が見つかりません');
  assert.equal(task.role, '司令塔');
  assert.equal(task.state, '未着手');
  assert.equal(task.next, '下一步內容');
  const file = store.taskFile(result.project.id, task.id);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /state: 未着手\n/);
  assert.match(text, /## 步驟\n- \[ \] 日本語步驟/);
  assert.match(text, /## 已完成的工作\n/);
  assert.match(text, /## 下一步\n/);
  assert.match(text, /## 注意事項\n/);
  fs.writeFileSync(file, text.replace('## 已完成的工作', '## 已完成的工作（含變更檔案與測試結果）'));
  assert.equal(store.setStep(result.project.id, task.id, 0, true).steps[0].done, true);
  store.addStep(result.project.id, task.id, '第二步');
  store.appendSection(result.project.id, task.id, 'やったこと', '- 既有日文報告');
  store.updateTask(result.project.id, task.id, { memo: '備註內容' });
  const updated = store.readTask(file);
  assert.match(updated.done, /既有日文報告/);
  assert.match(updated.memo, /備註內容/);
  assert.equal(updated.steps.length, 2);
  assert.equal(fs.readFileSync(file, 'utf8').split('## 已完成的工作').length, 2);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 步驟', '## 手順').replace('## 已完成的工作', '## やったこと').replace('## 下一步', '## 次にやること').replace('## 注意事項', '## 注意').replace('## 備註', '## メモ'));
  const legacy = store.readTask(file);
  assert.equal(legacy.steps.length, 2);
  assert.equal(legacy.next, '下一步內容');
  assert.match(legacy.done, /既有日文報告/);
  assert.match(legacy.memo, /備註內容/);
  assert.deepEqual(readSteps('## 步驟\n- [x] 中文\n## 手順\n- [ ] 日本語'), [{ text: '中文', done: true }, { text: '日本語', done: false }]);
  assert.ok(sectionNames('やったこと').includes('已完成的工作'));
});

test('MCP descriptions are Chinese while names, arguments and question markers stay compatible', () => {
  const report = TOOLS.find(tool => tool.name === 'hub_report');
  assert.match(report.description, /寫入作業檔案/);
  assert.match(report.inputSchema.properties.text.description, /繁體中文/);
  assert.deepEqual(report.inputSchema.required, ['project', 'task', 'text']);
  const parsed = parseAsk('說明\n[[質問]]\n選擇（可複選）\n1. 第一項（推薦）\n2. 第二項\n[[/質問]]');
  assert.equal(parsed.text, '說明');
  assert.equal(parsed.asks[0].multi, true);
  assert.deepEqual(parsed.asks[0].options, ['第一項（推薦）', '第二項']);
});

test('Chinese prompts keep the model rules, compressed rule file and path references', () => {
  const project = store.readProject('日本語名稱');
  const task = project.tasks[0];
  const prompt = taskPrompt(project, task, store.taskFile(project.id, task.id), project.dir);
  assert.match(prompt, /不要(?:自行)?在背景啟動 codex/);
  assert.match(prompt, /目前自動切換已關閉/);
  assert.match(prompt, /指揮＝Codex/);
  assert.ok(!prompt.includes('undefined＝'));
  assert.ok(prompt.includes('作業が見つかりません'));
  const part = instructions.split(prompt);
  assert.equal(part.file, `台帳/.ai/chat/${task.id}.rules.md`);
  assert.ok(!part.fixed.includes('由 Hub 依 CLI 錯誤結構與正式訊息判定'));
  const full = fs.readFileSync(path.join(project.dir, '.ai/chat', task.id + '.rules.md'), 'utf8');
  assert.match(full, /## 委派範本/);
  assert.match(full, /未解決\/確認待ち\/判断待ち\/解決済み\/履歴/);
  assert.match(full, /\[\[質問\]\]/);
  const resumed = instructions.select(prompt, { ai: 'codex', sid: 'test', resume: true, meta: { rulesSent: { codex: { sid: 'test', hash: part.hash, turns: 1 } } } });
  assert.equal(resumed.short, true);
  assert.match(resumed.prefix, /完整內容：台帳/);
});

test('handoff card reads Chinese steps and remote login pages have the right language', () => {
  const project = store.readProject('日本語名稱');
  const task = project.tasks[0];
  const file = store.taskFile(project.id, task.id);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## 手順', '## 步驟').replace('## メモ', '## 備註'));
  const card = buildHandoffCard({ original: '原始要求 日本語', rows: [], user: {}, pdir: project.dir, task: task.id, dir: project.dir });
  assert.match(card, /步驟：[\s\S]*日本語步驟/);
  assert.match(card, /最新備註：/);
  assert.match(card, /原始要求 日本語$/);
  assert.match(loginPage(), /lang="zh-TW"/);
  assert.match(loginPage(), /通行密碼/);
  assert.match(offPage(), /遠端使用已關閉/);
});

test('HTTP locale and Chinese generated projects work without translating user fields', async () => {
  const response = await fetch(base + '/api/locale');
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.locale, 'zh-TW');
  const script = await (await fetch(base + '/locale-config.js')).text();
  assert.match(script, /^window.HUB_LOCALE = /);
  const css = await fetch(base + '/locale.css');
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(await css.text(), fs.readFileSync(path.join(__dirname, '../locales/zh-TW/ui.css'), 'utf8'));
  const changelog = await (await fetch(base + '/api/changelog')).json();
  assert.equal(changelog[0].version, require('../package.json').version);
  assert.ok(changelog.flatMap(release => release.items).some(item => item.includes('繁體中文')));
  for (const item of changelog[0].items) assert.doesNotMatch(item, /[ぁ-んァ-ヶ]/);
  const project = await post('/api/project/new', { name: 'HTTP 日本語', description: '作業が見つかりません' });
  assert.equal(project.status, 200);
  assert.equal(project.body.description, '作業が見つかりません');
  const task = await post('/api/task/new', { project: project.body.id, title: '作業が見つかりません' });
  assert.equal(task.status, 200);
  assert.equal(task.body.title, '作業が見つかりません');
  assert.equal(task.body.state, '未着手');
  const document = path.join(store.product, project.body.id, '繁中資料.md');
  fs.writeFileSync(document, '使用者原文 日本語');
  const reveal = await post('/api/reveal', { project: project.body.id, task: task.body.id, path: project.body.id + '/繁中資料.md', how: 'info' });
  assert.equal(reveal.status, 200);
  assert.equal(reveal.body.path, document);
  assert.match(fs.readFileSync(store.taskFile(project.body.id, task.body.id), 'utf8'), /## 已完成的工作/);
  const bad = await post('/api/task/new', { project: 'missing', title: 'test' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, '請確認作業名稱、上層作業與來源');
});

test('Chinese child-result integration keeps canonical states, writes one receipt and cleans the task', () => {
  const p = store.createProject({ name: '整合驗證' }).project;
  const parent = store.createTask(p.id, { title: '主要作業' });
  const child = store.createTask(p.id, { title: '日本語成果', parent: parent.id, steps: ['完成步驟'] });
  store.setStep(p.id, child.id, 0, true);
  const source = path.join(p.dir, '作業', child.id, '日本語-result.txt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '作業が見つかりません（使用者內容）');
  const removal = new Removal({ store, trash: path.join(tmp, 'Trash') });
  const transfer = new TaskTransfer({ store, removal, baseOf: project => project.dir });
  const integrate = new TaskIntegrate({ store, transfer, removal, baseOf: project => project.dir });
  const preview = integrate.preview(p.id, parent.id);
  assert.equal(preview.items.length, 1);
  assert.deepEqual(preview.items[0].blockers, []);
  const body = { project: p.id, task: parent.id, token: preview.token, confirm: true, selected: preview.items.map(item => ({ project: item.project, task: item.task, files: item.selected, optional: [] })) };
  const result = integrate.apply(body);
  assert.equal(result.complete, true);
  assert.equal(integrate.read(p.id, parent.id).items[0].state, '片付け済み');
  assert.equal(store.taskFile(p.id, child.id), null);
  const receipt = transfer.read(p.id, child.id);
  assert.equal(fs.readFileSync(receipt.files[0].to, 'utf8'), '作業が見つかりません（使用者內容）');
  const parentText = fs.readFileSync(store.taskFile(p.id, parent.id), 'utf8');
  assert.match(parentText, /## 已完成的工作/);
  assert.equal(parentText.split('接收記錄：' + receipt.id).length, 2);
  assert.match(parentText, /日本語成果/);
});

test('HTTP update status and restart preserve queued AI instructions', async () => {
  const status = await (await fetch(base + '/api/app-update')).json();
  assert.equal(status.upstream, 'https://github.com/kieiken/project-hub');
  assert.equal(status.phase, 'idle');
  assert.equal(status.lastCheck, null);
  const checked = await post('/api/app-update/check', {});
  assert.equal(checked.status, 200);
  assert.equal(checked.body.lastCheck, null); // DRY tests cannot make remote requests or updater writes.
  assert.equal(fs.existsSync(path.join(root, '_hub/updates')), false);
  const bad = await post('/api/app-update', { enabled: 'true' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, '格式不符');
  for (const malformed of [null, [], 'true']) {
    const rejected = await post('/api/app-update', malformed);
    assert.equal(rejected.status, 400); assert.equal(rejected.body.error, '格式不符');
  }
  const project = store.createProject({ name: '更新排隊保護' }).project;
  const task = store.createTask(project.id, { title: '稍後繼續' });
  const queue = path.join(project.dir, '.ai/chat', task.id + '.queue.json');
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  const requests = [{ id: 'update-fixture', text: '不要遺失的指示' }];
  fs.writeFileSync(queue, JSON.stringify(requests));
  for (const route of ['/api/quit', '/api/restart']) {
    const result = await post(route, {});
    assert.equal(result.status, 409);
    assert.equal(result.body.error, '等待 AI、排隊指示及整理結束後更新');
    assert.deepEqual(JSON.parse(fs.readFileSync(queue, 'utf8')), requests);
  }
  await post('/api/chat/unqueue', { project: project.id, task: task.id, id: requests[0].id });
  assert.equal((await post('/api/restart', {})).status, 200);
  assert.equal((await post('/api/quit', {})).status, 200);
});

test('Chinese account errors keep API classification and cached messages change with locale only', async () => {
  const home = path.join(tmp, 'account-language');
  const settings = path.join(home, '.gemini/antigravity-cli/settings.json');
  fs.mkdirSync(path.dirname(settings), {recursive:true});
  fs.writeFileSync(settings, JSON.stringify({modelProvider:'api'}));
  const {Accounts} = require('../lib/accounts'), launch = require('../lib/launch');
  const account = new Accounts({file:path.join(home,'registry.json'), home, dry:true});
  const status = await account.status('agy','default');
  assert.equal(status.status,'api');
  assert.ok(!/[\u3041-\u3096\u30a1-\u30fa]/.test(status.message));
  process.env.HUB_LANG='ja';
  assert.match(launch.agyAccountError(home),/API の利用設定/);
  process.env.HUB_LANG='zh-TW';
  assert.equal(launch.agyAccountError(home),status.message);
  assert.match(launch.agyAccountError(home,false),/API の利用設定/);
});
test('Chinese unknown MCP tool errors retain the machine-readable unknown flag', async () => {
  const result = await post('/api/mcp/call',{name:'not-a-real-tool',arguments:{}});
  assert.equal(result.status,404);
  assert.equal(result.body.unknown,true);
  assert.match(result.body.error,/not-a-real-tool/);
  assert.ok(!/[\u3041-\u3096\u30a1-\u30fa]/.test(result.body.error));
});
