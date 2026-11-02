'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const headings = { '手順': 'Steps', 'やったこと': 'Work completed', '次にやること': 'Next steps', '注意': 'Notes', 'メモ': 'Memo' };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-new-language-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace'), source = path.join(temp, 'en'); fs.mkdirSync(root);
  write(path.join(source, 'pack.json'), { id: 'en', name: 'English test fixture', verifiedWith: '4.109.1', dateLocale: 'en-US' });
  write(path.join(source, 'ui.json'), { 'あなたの番': 'Your turn', '参考': 'Reference ' });
  write(path.join(source, 'backend.json'), { messages: { 'あなたの番': 'Your turn' }, labels: { '完了': 'Done' }, headings });
  const run = code => spawnSync(process.execPath, ['-e', code], { cwd: hub,
    env: { ...process.env, HUB_ROOT: root, HUB_LANG: 'ja', HUB_LANGPACK_DIR: '' }, encoding: 'utf8', timeout: 10000 });
  return { temp, root, source, run };
}
test('A new language imports, selects after restart, translates UI/date/labels, and writes readable headings', t => {
  const f = fixture(t);
  const result = f.run(`
    const fs=require('node:fs'),path=require('node:path'),p=require('./lib/langpack'),l=require('./lib/locale'),{Store,readSteps}=require('./lib/store');
    const root=process.env.HUB_ROOT; p.importPack(root,${JSON.stringify(f.source)});p.setRoot(root);
    if(!p.packSettings(root,'4.109.1').available.includes('en'))throw Error('not listed');
    p.selectLanguage(root,'en');if(l.locale()!=='ja')throw Error('changed before restart');p.setRoot(root);
    const dir=path.join(root,'Product/example');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\\nid: example\\ntitle: example\\nstate: 進行中\\n---\\n');
    const store=new Store(root),task=store.createTask('example',{title:'User original あなたの番',steps:['User original'],next:'User next'});
    store.setStep('example',task.id,0,true);store.addStep('example',task.id,'Added original');
    const text=fs.readFileSync(path.join(dir,'.ai/tasks',task.id+'.md'),'utf8');
    const vm=require('node:vm'),document={documentElement:{lang:'ja'},querySelectorAll:()=>[]};
    const context=vm.createContext({HUB_LOCALE:l.config(),document});vm.runInContext(fs.readFileSync('./public/locale.js','utf8'),context);
    const ui=context.HubI18n;
    console.log(JSON.stringify({locale:l.locale(),text:l.lt('あなたの番'),missing:l.lt('訳のない文'),label:l.label('完了'),config:l.config(),
      ui:ui.text('あなたの番'),reference:ui.label('参考2'),lang:document.documentElement.lang,date:new Date('2026-10-11T12:00:00Z').toLocaleDateString(ui.dateLocale,{timeZone:'UTC'}),
      textFile:text,steps:readSteps(text),section:l.sectionName('手順')}));
  `);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.locale, 'en'); assert.equal(data.text, 'Your turn'); assert.equal(data.label, 'Done');
  assert.equal(data.missing, '訳のない文'); assert.equal(data.ui, 'Your turn'); assert.equal(data.reference, 'Reference 2');
  assert.equal(data.lang, 'en'); assert.equal(data.config.dateLocale, 'en-US'); assert.equal(data.date, '10/11/2026');
  for (const key of ['手順', 'やったこと', '次にやること', '注意']) assert.ok(data.textFile.includes('## ' + headings[key]));
  assert.equal(data.steps[0].text, 'User original'); assert.equal(data.steps[0].done, true); assert.equal(data.steps[1].text, 'Added original'); assert.ok(data.textFile.includes('User original あなたの番'));
  assert.ok(data.textFile.includes('state: 未着手')); assert.equal(data.section, 'Steps');
});
test('Japanese startup reads all discovered language headings, and keeps its snapshot until restart', t => {
  const f = fixture(t);
  const result = f.run(`const fs=require('node:fs'),path=require('node:path'),p=require('./lib/langpack'),l=require('./lib/locale'),s=require('./lib/store');
    const root=process.env.HUB_ROOT;p.importPack(root,${JSON.stringify(f.source)});p.setRoot(root);
    const before=s.readSteps('## Steps\\n- [x] Original\\n');
    const file=path.join(root,'_hub/langpacks/en/backend.json'),data=JSON.parse(fs.readFileSync(file));data.headings['手順']='New Steps';fs.writeFileSync(file,JSON.stringify(data));p.clearCache(path.dirname(file));
    console.log(JSON.stringify({before,fixed:l.sectionNames('手順'),ja:l.sectionName('手順'),old:s.readSteps('## 步驟\\n- [ ] Old\\n')}));`);
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.equal(data.before[0].done, true); assert.ok(data.fixed.includes('Steps')); assert.ok(!data.fixed.includes('New Steps'));
  assert.equal(data.ja, '手順'); assert.equal(data.old[0].text, 'Old');
});
test('Installed languages switch with existing zh-TW, retaining legacy Chinese heading output', t => {
  const f = fixture(t);
  const result = f.run(`const p=require('./lib/langpack'),l=require('./lib/locale'),root=process.env.HUB_ROOT;
    p.importPack(root,${JSON.stringify(f.source)});p.importPack(root,${JSON.stringify(path.resolve(hub, '../langpacks/zh-TW'))});
    p.selectLanguage(root,'en');p.setRoot(root);const en=l.locale();p.selectLanguage(root,'zh-TW');const fixed=l.locale();p.setRoot(root);
    console.log(JSON.stringify({en,fixed,zh:l.locale(),heading:l.sectionName('手順'),date:l.config().dateLocale}));`);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { en: 'en', fixed: 'en', zh: 'zh-TW', heading: '步驟', date: 'zh-TW' });
});
test('Invalid date/headings/IDs are rejected, while an ID-folder mismatch is not selectable', async t => {
  const corruptions = {
    japanese: f => write(path.join(f.source, 'pack.json'), { id: 'ja', name: 'Bad', verifiedWith: '4.109.1' }),
    date: f => write(path.join(f.source, 'pack.json'), { id: 'en', name: 'Bad', verifiedWith: '4.109.1', dateLocale: 'en_US' }),
    unsupportedDate: f => write(path.join(f.source, 'pack.json'), { id: 'en', name: 'Bad', verifiedWith: '4.109.1', dateLocale: 'zz-ZZ' }),
    duplicateVariant: f => write(path.join(f.source, 'pack.json'), { id: 'en', name: 'Bad', verifiedWith: '4.109.1', dateLocale: 'en-abcde-abcde' }),
    unknownHeading: f => write(path.join(f.source, 'backend.json'), { messages: {}, labels: {}, headings: { unknown: 'Unknown' } }),
    hash: f => write(path.join(f.source, 'backend.json'), { messages: {}, labels: {}, headings: { '手順': '# Steps' } }),
    newline: f => write(path.join(f.source, 'backend.json'), { messages: {}, labels: {}, headings: { '手順': 'Steps\nMore' } }),
    duplicateHeading: f => write(path.join(f.source, 'backend.json'), { messages: {}, labels: {}, headings: { '手順': 'Same', 'メモ': 'Same' } }),
  };
  for (const [name, corrupt] of Object.entries(corruptions)) await t.test(name, t => {
    const f = fixture(t); corrupt(f);
    const result = f.run(`const p=require('./lib/langpack');try{p.importPack(process.env.HUB_ROOT,${JSON.stringify(f.source)});process.exit(9)}catch{}p.setRoot(process.env.HUB_ROOT);console.log(require('./lib/locale').locale());`);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ja');
    assert.equal(fs.existsSync(path.join(f.root, '_hub/langpacks/en')), false);
  });
  await t.test('folder mismatch', t => {
    const f = fixture(t); fs.cpSync(f.source, path.join(f.root, '_hub/langpacks/fr'), { recursive: true });
    const result = f.run(`const p=require('./lib/langpack');p.setRoot(process.env.HUB_ROOT);console.log(JSON.stringify(p.packSettings(process.env.HUB_ROOT,'4.109.1')));`);
    assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
    assert.ok(data.available.includes('en')); /* Valid bundled English is selectable. */ assert.ok(!data.available.includes('fr')); assert.equal(data.packs.find(row => row.id === 'fr').usable, false);
  });
});
test('CSS and executable files are ignored on import and excluded from exported data', t => {
  const f = fixture(t);
  for (const name of ['ui.css', 'docs/style.css', 'templates/theme.js', 'test/execute.js']) write(path.join(f.source, name), 'must not load');
  const result = f.run(`const p=require('./lib/langpack');console.log(p.importPack(process.env.HUB_ROOT,${JSON.stringify(f.source)}));`);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['ui.css', 'docs/style.css', 'templates/theme.js', 'test/execute.js']) assert.equal(fs.existsSync(path.join(f.root, '_hub/langpacks/en', name)), false);
  const { selected, excluded } = require('../../scripts/export-public');
  for (const name of ['pack.json', 'ui.json', 'backend.json', 'templates/project/.ai/rules.md', 'seed/example/PROJECT.md', 'test/fixture.test.js']) {
    assert.equal(selected('langpacks/en/' + name, false), true); assert.equal(excluded('langpacks/en/' + name), false);
  }
  for (const name of ['ui.css', 'execute.js', 'docs/style.css', 'templates/theme.js']) assert.equal(selected('langpacks/en/' + name, false), false);
  assert.equal(selected('langpacks/ja/ui.json', false), false);
  assert.ok(!fs.readFileSync(path.join(hub, 'server.js'), 'utf8').includes("'/langpacks/"));
});
