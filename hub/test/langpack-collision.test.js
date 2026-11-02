'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const hub = path.resolve(__dirname, '..');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-heading-collision-')), root = path.join(temp, 'workspace');
  fs.mkdirSync(root); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const run = code => spawnSync(process.execPath, ['-e', code], { cwd: hub, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HUB_ROOT: root, HUB_LANG: 'ja', HUB_LANGPACK_DIR: '' } });
  return { temp, root, run };
}
function pack(directory, id = 'en', headings = {}, dateLocale = 'en-US') {
  write(path.join(directory, 'pack.json'), { id, name: 'Test fixture', verifiedWith: '4.109.1', dateLocale });
  write(path.join(directory, 'ui.json'), { 'あなたの番': 'Test text' });
  write(path.join(directory, 'backend.json'), { messages: {}, labels: {}, headings });
  write(path.join(directory, 'native.json'), { 'あなたの番': 'Test text' });
}
const storeProbe = `
  const {Store,readSteps}=require('./lib/store'),dir=path.join(root,'Product/example');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\\nid: example\\ntitle: example\\nstate: 進行中\\n---\\n');
  const store=new Store(root),task=store.createTask('example',{title:'Collision probe',steps:[]}),file=path.join(dir,'.ai/tasks',task.id+'.md');
  const text=fs.readFileSync(file,'utf8').split('## ')[0]+'## 注意\\n- [ ] Keep note\\n\\n## Notes\\n- [ ] Keep ambiguous note\\n\\n## 手順\\n- [ ] Real step\\n';
  fs.writeFileSync(file,text);const before=readSteps(text);store.setStep('example',task.id,0,true);
  const after=fs.readFileSync(file,'utf8');
`;
test('Reserved Japanese/Chinese names and section suffixes cannot redirect real Store checkboxes', t => {
  const f = fixture(t), sources = [];
  for (const [i, headings] of [
    { '手順': '注意' }, { '手順': '注意事項' }, { 'メモ': '接下來要做的事' },
    { '手順': '注意（説明）' }, { 'メモ': '成果' }, { '手順': 'Steps', 'メモ': 'Steps notes' },
  ].entries()) {
    const directory = path.join(f.temp, 'bad-' + i); pack(directory, 'en', headings); sources.push(directory);
  }
  fs.cpSync(sources[0], path.join(f.root, '_hub/langpacks/en'), { recursive: true });
  const result = f.run(`const fs=require('node:fs'),path=require('node:path'),p=require('./lib/langpack'),l=require('./lib/locale'),root=process.env.HUB_ROOT;
    const rejected=${JSON.stringify(sources)}.map(dir=>{try{p.importPack(root,dir);return false}catch{return true}});
    p.setRoot(root);${storeProbe}
    console.log(JSON.stringify({rejected,before,after,notice:l.sectionNames('注意'),legacy:readSteps('## 步驟\\n- [x] Legacy\\n'),packs:p.packSettings(root,'4.109.1').packs}));`);
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.ok(data.rejected.every(Boolean)); assert.equal(data.packs.find(p=>p.id==='en'&&p.source==='installed').usable,false); // Bundled English remains a valid fallback.
  assert.deepEqual(data.before, [{ text: 'Real step', done: false }]);
  assert.match(data.after, /## 注意\n- \[ \] Keep note/); assert.match(data.after, /## Notes\n- \[ \] Keep ambiguous note/);
  assert.match(data.after, /## 手順\n- \[x\] Real step/); assert.deepEqual(data.notice, ['注意', '注意事項']);
  assert.deepEqual(data.legacy, [{ text: 'Legacy', done: true }]);
});
test('Cross-pack import rejects a different meaning, preserves the previous pack, and allows a shared meaning', t => {
  const f = fixture(t), en = path.join(f.temp, 'en'), fr = path.join(f.temp, 'fr'), replacement = path.join(f.temp, 'replacement');
  pack(en, 'en', { '注意': 'Notes', '手順': 'Steps' }); pack(fr, 'fr', { '手順': 'Étapes' });
  pack(replacement, 'fr', { '手順': 'Notes' });
  const result = f.run(`const fs=require('node:fs'),path=require('node:path'),p=require('./lib/langpack'),root=process.env.HUB_ROOT;
    p.importPack(root,${JSON.stringify(en)});p.importPack(root,${JSON.stringify(fr)});
    const file=path.join(root,'_hub/langpacks/fr/backend.json'),before=fs.readFileSync(file,'utf8');let refused=false;
    try{p.importPack(root,${JSON.stringify(replacement)})}catch{refused=true}
    const preserved=fs.readFileSync(file,'utf8')===before;
    fs.writeFileSync(${JSON.stringify(path.join(replacement, 'backend.json'))},JSON.stringify({messages:{},labels:{},headings:{'手順':'Steps'}}));
    p.importPack(root,${JSON.stringify(replacement)});p.setRoot(root);
    console.log(JSON.stringify({refused,preserved,steps:require('./lib/store').readSteps('## Steps\\n- [x] Shared\\n')}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { refused: true, preserved: true, steps: [{ text: 'Shared', done: true }] });
});
test('Manually added conflicting folders cannot read/write ambiguous headings, and stay fixed until restart', t => {
  const f = fixture(t);
  pack(path.join(f.root, '_hub/langpacks/en'), 'en', { '注意': 'Notes', 'メモ': 'Memo' });
  pack(path.join(f.root, '_hub/langpacks/fr'), 'fr', { '手順': 'Notes' });
  write(path.join(f.root, '_hub/language.json'), { language: 'en' });
  const result = f.run(`const fs=require('node:fs'),path=require('node:path'),p=require('./lib/langpack'),l=require('./lib/locale'),root=process.env.HUB_ROOT;
    p.setRoot(root);${storeProbe}
    const safe={notice:l.sectionName('注意'),memo:l.sectionName('メモ'),steps:l.sectionNames('手順'),locale:l.locale()};
    fs.rmSync(path.join(root,'_hub/langpacks/fr'),{recursive:true});p.clearCache(path.join(root,'_hub/langpacks/fr'));
    const fixed=l.sectionName('注意');p.setRoot(root);console.log(JSON.stringify({before,after,safe,fixed,restarted:l.sectionName('注意')}));`);
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  assert.deepEqual(data.before, [{ text: 'Real step', done: false }]);
  assert.match(data.after, /## Notes\n- \[ \] Keep ambiguous note/); assert.match(data.after, /## 手順\n- \[x\] Real step/);
  assert.equal(data.safe.notice, '注意'); assert.equal(data.safe.memo, 'Memo'); assert.equal(data.safe.locale, 'en');
  assert.ok(!data.safe.steps.includes('Notes')); assert.equal(data.fixed, '注意'); assert.equal(data.restarted, 'Notes');
});
test('Cross-pack substring aliases are suppressed regardless of discovery order', t => {
  const f = fixture(t);
  for (const ids of [['en', 'fr'], ['fr', 'en']]) {
    pack(path.join(f.root, '_hub/langpacks', ids[0]), ids[0], { '手順': 'Notes' });
    pack(path.join(f.root, '_hub/langpacks', ids[1]), ids[1], { 'メモ': 'FootNotes' });
    const result = f.run(`const p=require('./lib/langpack'),l=require('./lib/locale');p.setRoot(process.env.HUB_ROOT);
      console.log(JSON.stringify({steps:l.sectionNames('手順'),memo:l.sectionNames('メモ')}));`);
    assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
    assert.ok(!data.steps.includes('Notes')); assert.ok(!data.memo.includes('FootNotes'));
  }
});
test('Native and Node agree on date aliases and reserved headings through every fallback candidate', async t => {
  if (spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('Swift is unavailable'); return; }
  const f = fixture(t), repo = path.join(f.temp, 'repository'), libs = path.join(repo, 'hub/lib'); fs.mkdirSync(libs, { recursive: true });
  for (const file of ['langpack.js', 'locale.js']) fs.copyFileSync(path.join(hub, 'lib', file), path.join(libs, file));
  fs.cpSync(path.join(hub, 'lib/platform'), path.join(libs, 'platform'), { recursive: true });
  const swift = fs.readFileSync(path.join(hub, 'app/window.swift'), 'utf8');
  const globals = swift.slice(swift.indexOf('let home ='), swift.indexOf('\nlet port ='))
    .replace(/^let hubLocation = .*$/m, 'let hubLocation = ' + JSON.stringify(path.join(repo, 'hub')))
    .replaceAll('Data(contentsOf:', 'recordData(contentsOf:');
  const executable = path.join(f.temp, 'native'), source = executable + '.swift';
  write(source, 'import Foundation\nvar reads=0\nfunc recordData(contentsOf url:URL)throws->Data{reads+=1;return try Data(contentsOf:url)}\n' + globals
    + '\nif storageReady(){loadNativeMessages()};print(String(data:try! JSONSerialization.data(withJSONObject:["language":hubLanguage,"directory":hubPackDir,"reads":reads]),encoding:.utf8)!)\n');
  const built = spawnSync('swiftc', [source, '-o', executable], { encoding: 'utf8', timeout: 30000 }); assert.equal(built.status, 0, built.stderr);
  const dates = ['sh', 'mo', 'sh-BA', 'mo-MD', 'adp', 'ars', 'bih', 'cls', 'cnr', 'drh', 'drw', 'gom', 'mao', 'mol', 'npi', 'ory', 'prp', 'prs', 'quz', 'swc', 'tnf', 'eng', 'iw', 'en-US-u-ca-gregory'];
  const cases = [
    ...dates.map(date => ({ name: 'date ' + date, date, expected: 'installed' })),
    ...[{ '手順': '注意' }, { '手順': '注意事項' }, { 'メモ': '接下來要做的事' }, { 'メモ': '成果' }, { '手順': 'Steps', 'メモ': 'Steps extra' }]
      .map((headings, i) => ({ name: 'reserved heading ' + i, headings, expected: 'external' })),
    { name: 'two bad headings', headings: { '手順': '注意' }, badExternal: true, expected: 'bundled' },
    { name: 'all bad headings', headings: { '手順': '注意' }, badExternal: true, badBundled: true, expected: 'ja' },
    ...['en_US', 'zz-ZZ', 'en-abcde-abcde', 42].map(date => ({ name: 'bad date ' + date, date, expected: 'external' })),
    { name: 'all bad dates', date: 'zz-ZZ', badExternal: true, badBundled: true, expected: 'ja' },
    { name: 'Web-only alias', date: 'sh', webOnly: true, expected: 'installed' },
    { name: 'failed storage guard', guard: false, expected: 'ja' },
  ];
  for (const item of cases) await t.test(item.name, t => {
    const root = path.join(f.temp, item.name), dirs = { installed: path.join(root, '_hub/langpacks/en'), external: path.join(root, 'external'), bundled: path.join(repo, 'langpacks/en') };
    for (const dir of Object.values(dirs)) pack(dir);
    pack(dirs.installed, 'en', item.headings || {}, item.date ?? 'en-US');
    for (const key of ['external', 'bundled']) if (item['bad' + key[0].toUpperCase() + key.slice(1)]) pack(dirs[key], 'en', item.headings || {}, item.date ?? 'en-US');
    if (item.webOnly) fs.unlinkSync(path.join(dirs.installed, 'native.json'));
    write(path.join(root, '_hub/language.json'), { language: 'en' });
    const env = { ...process.env, HUB_ROOT: root, HUB_LANG: 'ja', HUB_LANGPACK_DIR: dirs.external, HUB_STORAGE_GUARD: item.guard === false ? '/usr/bin/false' : '/usr/bin/true' };
    const native = spawnSync(executable, [], { env, encoding: 'utf8', timeout: 10000 }); assert.equal(native.status, 0, native.stderr);
    const actualNative = JSON.parse(native.stdout);
    if (item.guard === false) { assert.equal(actualNative.reads, 0); assert.equal(actualNative.language, 'ja'); return; }
    const node = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(path.join(libs, 'langpack'))});p.setRoot(process.env.HUB_ROOT);console.log(JSON.stringify({language:p.activePack()?.manifest.id||'ja',directory:p.activePack()?.directory,date:p.activePack()?.dateLocale}));`], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(node.status, 0, node.stderr); const actualNode = JSON.parse(node.stdout);
    assert.equal(actualNode.language, item.expected === 'ja' ? 'ja' : 'en'); assert.equal(actualNative.language, actualNode.language);
    if (item.expected !== 'ja') {
      assert.equal(actualNode.directory, dirs[item.expected]); assert.equal(actualNative.directory, actualNode.directory); assert.ok(actualNative.reads > 0);
      assert.equal(actualNode.date, Intl.getCanonicalLocales(item.expected === 'installed' ? item.date ?? 'en-US' : 'en-US')[0]);
    }
  });
});
