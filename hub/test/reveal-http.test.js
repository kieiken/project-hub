'use strict';
// These fixtures keep the existing Japanese error-message contract.
process.env.HUB_LANG = 'ja';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-http-'));
const home = path.join(root, 'home');
const originalHomedir = os.homedir;
os.homedir = () => home;
process.env.HUB_ROOT = root;
process.env.HUB_DRY_RUN = '1';
process.env.HUB_AI_HOME = home;
const project = '子育て支援センター探しプロジェクト', task = '20261008-01';
const product = path.join(root, 'Product'), ledger = path.join(product, project);
const body = path.join(root, 'System', project), work = path.join(root, 'Work', project, task);
function write(file, text = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
for (const dir of [home, body, work]) fs.mkdirSync(dir, { recursive: true });
write(path.join(ledger, 'PROJECT.md'), `---\nname: ${project}\nfolders:\n  本体: ${body}\n---\n`);
write(path.join(ledger, '.ai/tasks', task + '.md'), `---\nid: ${task}\nworkdir: ${work}\n---\n`);
let server, base;
test.before(async () => {
  const probe = require('node:net').createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  process.env.HUB_PORT = String(port);
  ({ server } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + port;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  os.homedir = originalHomedir;
  fs.rmSync(root, { recursive: true, force: true });
});
async function reveal(file, extra = {}) {
  const response = await fetch(base + '/api/reveal', {
    method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, task, path: file, how: 'info', ...extra })
  });
  return { status: response.status, body: await response.json() };
}
async function resolves(raw, expected, extra) {
  const result = await reveal(raw, extra);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.path, expected);
  return result.body;
}

test('プロジェクト名から始まる再現例をProduct基準で解決し、開き方を保持する', async () => {
  const raw = `${project}/作業/${task}/説明資料.pdf`, file = write(path.join(product, raw));
  const info = await resolves(raw, file);
  assert.equal(info.dir, false); assert.equal(info.r, undefined);
  for (const how of ['finder', 'open']) {
    const result = await resolves(raw, file, { how });
    assert.deepEqual(result.r.args, how === 'finder' ? ['-R', file] : [file]);
  }
  const app = await resolves(raw, file, { how: 'open', app: true });
  assert.equal(app.byApp, true); assert.equal(app.how, 'open');
  await resolves(raw, file, { project: '', task: '' });
});

for (const [name, dir] of [['作業用コピー', work], ['本体', body], ['台帳', ledger], ['ワークスペース', root]]) {
  test(`${name}基準の相対パスを従来どおり解決する`, async () => {
    const raw = `${name}/固有資料.pdf`;
    await resolves(raw, write(path.join(dir, raw)));
  });
}
test('ホーム記号と絶対パスを従来どおり解決する', async () => {
  const file = write(path.join(home, '資料/絶対.pdf'));
  await resolves('~/資料/絶対.pdf', file);
  await resolves(file, file);
});
test('同名ファイルは作業用コピー→本体→台帳→ROOT→Productの順で選ぶ', async () => {
  const raw = '同名.pdf', files = [work, body, ledger, root, product].map(dir => write(path.join(dir, raw)));
  for (const file of files) {
    await resolves(raw, file);
    fs.unlinkSync(file);
  }
  assert.equal((await reveal(raw)).status, 404);
});
test('ホーム外・ROOT外とその隣接名への絶対/相対参照は拒否する', async () => {
  const outside = root + '-outside', file = write(path.join(outside, '秘密.pdf'));
  try {
    for (const raw of [file, path.relative(product, file), path.relative(ledger, file)]) {
      assert.equal((await reveal(raw)).status, 404, raw);
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
test('新旧候補の読み取り拒否は403のまま、後順位の同名ファイルへ迂回しない', async () => {
  const originalReaddir = fs.readdirSync;
  for (const dir of [work, product]) {
    const blocked = path.join(dir, '拒否フォルダ'), file = write(path.join(blocked, '秘密.pdf'));
    write(path.join(product, '拒否フォルダ/秘密.pdf'));
    fs.readdirSync = function (candidate, ...args) {
      if (path.resolve(candidate) === blocked) throw Object.assign(Error('denied fixture'), { code: 'EACCES' });
      return originalReaddir.call(this, candidate, ...args);
    };
    try {
      for (const how of ['info', 'list', 'open', 'finder']) {
        const result = await reveal('拒否フォルダ/秘密.pdf', { how, app: true });
        assert.equal(result.status, 403); assert.match(result.body.error, /Mac の許可/);
        assert.equal(result.body.byApp, undefined);
      }
    } finally { fs.readdirSync = originalReaddir; fs.unlinkSync(file); }
  }
});
