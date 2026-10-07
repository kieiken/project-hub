'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { excluded, selected, inspect } = require('../../scripts/export-public');
const entry = (name, text) => ({ name, content: Buffer.from(text) });
const publicNames = ['README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', 'THIRD_PARTY_NOTICES.zh-TW.md',
  '.github/PULL_REQUEST_TEMPLATE/zh-TW.md', '.github/workflows/macos-app.yml'];
const sourceNames = ['hub/locales/zh-TW.json', 'hub/lib/locale.js',
  'docs/project-hub/templates/zh-TW/project/.ai/rules.md',
  'docs/project-hub/templates/zh-TW/_hub/roles.yaml', 'hub/seed-zh-TW/範例文件/.ai/tasks/example.md'];
test('Public overlay selects Chinese documents, PR templates and only the intended workflow', () => {
  for (const name of publicNames) assert.equal(selected(name, true), true, name);
  for (const name of ['.github/workflows/private.yml', '.github/secrets.txt', 'private.md']) assert.equal(selected(name, true), false, name);
});
test('Both template languages and fictional seeds remain selected and inspected', () => {
  for (const name of [...sourceNames, 'docs/project-hub/templates/project/.ai/rules.md', 'docs/project-hub/templates/_hub/roles.yaml', 'hub/seed/example/.ai/tasks/one.md']) {
    assert.equal(selected(name, false), true, name);
    assert.equal(excluded(name), false, name);
    assert.throws(() => inspect([entry(name, '-----BEGIN '+'PRIVATE KEY-----')]), /private key/);
  }
});
test('Chinese allowlists never expose personal ledger or runtime management metadata', () => {
  for (const name of ['hub/personal/.ai/tasks/private.md', 'hub/personal/_hub/config.json',
    'docs/project-hub/templates/zh-TW/project/.ai/chat/private.md',
    'hub/seed-zh-TW/example/.ai/work/private.md', 'hub/seed-zh-TW/example/.ai/handoff/private.md',
    'docs/project-hub/templates/zh-TW/_hub/state.log', 'hub/seed-zh-TW/example/_hub/accounts.json',
    'hub/seed-zh-TW/example/.codex/config.toml', 'hub/seed-zh-TW/example/.claude/settings.json']) assert.equal(excluded(name), true, name);
});
test('Secret files and generated outputs remain excluded inside all public allowlists', () => {
  for (const prefix of ['hub/seed-zh-TW/example/', 'docs/project-hub/templates/zh-TW/project/']) {
    for (const tail of ['.env', '.env.local', '.npmrc', 'secret.key', 'private.pem', 'state.log', 'node_modules/file', 'public-release/file', '.git/config']) assert.equal(excluded(prefix+tail), true, prefix+tail);
  }
});
test('Chinese documents and workflows still reject every privacy rule', () => {
  const privateTexts = ['k'+'kminim4', 'person'+'@invalid.example', 'gh'+'p_PRIVATE_TEST', 'sk-'+'0123456789abcdefgh',
    '-----BEGIN '+'PRIVATE KEY-----', 'h'+'dsl', 'https://discord.com/api/'+'webhooks/123/private', '192.'+'168.1.2', '/Users/'+'private'];
  for (const name of publicNames) for (const text of privateTexts) assert.throws(() => inspect([entry(name,text)]), /Public inspection failed/, name);
  assert.doesNotThrow(() => inspect([...publicNames,...sourceNames].map(name => entry(name,'Public documentation'))));
});
test('Reviewed literals are exact and file-specific; unknown binaries require review', () => {
  assert.doesNotThrow(() => inspect([entry('hub/lib/git.js','git'+'@github.com')]));
  assert.throws(() => inspect([entry('README.zh-TW.md','git'+'@github.com')]), /email/);
  assert.doesNotThrow(() => inspect([entry('hub/test/accounts.test.js','a'+'@example.test')]));
  assert.throws(() => inspect([entry('README.zh-TW.md','a'+'@example.test')]), /email/);
  assert.throws(() => inspect([entry('hub/test/accounts.test.js','other'+'@example.test')]), /email/);
  assert.throws(() => inspect([entry('hub/seed-zh-TW/example/secret.png','not reviewed')]), /binary file needs review/);
});
test('CI keeps read-only permissions, both language tests, guard-preserving bundle build and signature verification', () => {
  const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/macos-app.yml'),'utf8');
  assert.match(workflow,/contents: read/);assert.ok(!workflow.includes('contents: write'));
  assert.match(workflow,/TMPDIR: \/private\/tmp/);assert.match(workflow,/HUB_SKIP_APP: "1"/);
  assert.match(workflow,/env -u HUB_LANG npm --prefix hub test/);assert.match(workflow,/HUB_LANG=zh-TW npm --prefix hub test/);
  assert.match(workflow,/HUB_BUNDLE_RUNTIME: "1"/);assert.match(workflow,/codesign --verify --deep --strict/);
  assert.ok(!/gh release|git push/.test(workflow));
});

test('Committed dry export includes all A-D runtime inputs and Chinese metadata without Git history or local outputs', () => {
  const {execFileSync}=require('node:child_process'),root=path.resolve(__dirname,'../..');
  const stdout=execFileSync(process.execPath,['scripts/export-public.js'],{cwd:root,encoding:'utf8',timeout:30000});
  assert.match(stdout,/inspection: 0 findings/);
  const output=path.join(root,'public-release/ProjectHub');
  for(const name of [...publicNames,'hub/lib/trash.js','hub/lib/app-update.js','hub/lib/app-update-workflow.js',
    'hub/public/locale.js','hub/locales/zh-TW.json','hub/lib/locale.js',
    'docs/project-hub/templates/zh-TW/project/.ai/rules.md','docs/project-hub/templates/zh-TW/project/.ai/tasks/_template.md',
    'docs/project-hub/templates/zh-TW/_hub/roles.yaml','hub/seed-zh-TW/Project Hub/.ai/tasks/sample-hub-01.md']) assert.ok(fs.existsSync(path.join(output,name)),name);
  for(const name of ['.git','.ai','hub/node_modules','hub/pr-c-ja-full.log','table-preview-dark.png']) assert.equal(fs.existsSync(path.join(output,name)),false,name);
  assert.match(execFileSync('git',['check-ignore','public-release/ProjectHub/README.md'],{cwd:root,encoding:'utf8'}),/public-release/);
});
