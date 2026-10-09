'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const platform = require('../lib/platform');
const { safeUrl } = require('../public/safe-url');

test('stored chat URLs reject active schemes and preserve HTTPS', () => {
  for (const value of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,test', 'file:///C:/Windows', '//evil.example', 'vbscript:msgbox(1)']) assert.equal(safeUrl(value), '');
  assert.equal(safeUrl('https://example.com/chat?a=1&b=2'), 'https://example.com/chat?a=1&b=2');
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.ok(source.includes('esc(hubSafeUrl(c.url))'));
});
test('Windows npm launch preserves shell metacharacters literally', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'echo.js');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['繁體中文 空白', '" & echo hacked & "', "$(Get-Date); 'quotes'", '%PATH%', 'a\nb'];
  const child = platform.spawn(script, args);
  let out = ''; child.stdout.on('data', chunk => out += chunk);
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.deepEqual(JSON.parse(out), args);
});
test('Windows PATH resolves native binaries and npm JavaScript bins', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'node_modules/@openai/codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.js' } }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), '');
  assert.equal(platform.executable('codex', 'C:\\not-existing;' + root), path.join(pkg, 'cli.js'));
  assert.ok(platform.executable('powershell', process.env.PATH));
});
test('Windows PTY can launch and return terminal output', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const pty = require('node-pty');
  await new Promise((resolve, reject) => {
    let out = '';
    const proc = pty.spawn('cmd.exe', ['/d', '/c', 'echo HUB_PTY_OK'], { cwd: os.tmpdir(), env: process.env });
    const timer = setTimeout(() => { proc.kill(); reject(Error('PTY timed out')); }, 10000);
    proc.onData(data => out += data);
    proc.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.match(out, /HUB_PTY_OK/); resolve(); } catch (e) { reject(e); } });
  });
});
test('Windows file names reject traversal aliases, device names and alternate streams', { skip: process.platform !== 'win32' }, () => {
  const { safeName } = require('../lib/safe-name');
  for (const value of ['.. ', 'CON', 'nul.txt', 'COM1', 'a:stream', 'name.', 'foo\\bar', '../outside']) assert.equal(safeName(value), false, value);
  assert.equal(safeName('繁體中文專案'), true);
});
test('CRLF task files append steps in order and allow checking existing steps', t => {
  const { Store } = require('../lib/store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crlf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Product/demo/.ai/tasks'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'Product/demo/PROJECT.md'), '---\nname: Demo\nstatus: 進行中\n---\n');
  const file = path.join(dir, 'task.md');
  fs.writeFileSync(file, ['---', 'id: task', 'state: 未着手', '---', '## 手順', '- [ ] First', '- [ ] Second', '', '## 注意', 'Keep this note'].join('\r\n'));
  const store = new Store(root);
  const added = store.addStep('demo', 'task', 'Third');
  assert.deepEqual(added.steps.map(s => s.text), ['First', 'Second', 'Third']);
  assert.equal(store.setStep('demo', 'task', 1, true).steps[1].done, true);
  assert.match(fs.readFileSync(file, 'utf8'), /Keep this note/);
  assert.ok(!/(?<!\r)\n/.test(fs.readFileSync(file, 'utf8')));
});
test('Windows image conversion and image-from-path do not require macOS directories', { skip: process.platform !== 'win32' }, async t => {
  const sharp = require('sharp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'image.webp');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp().toFile(file);
  const image = require('../lib/start').imageFromPath({ id: 'test', dir: root }, file);
  assert.equal((await sharp(image.path).metadata()).format, 'png');
});
test('Windows stop terminates a CLI wrapper and its subprocess', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-stop-'));
  const script = path.join(root, 'wrapper.js');
  fs.writeFileSync(script, "const cp=require('child_process'); const sub=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(sub.pid); setInterval(()=>{},1000);");
  const child = platform.spawn(process.execPath, [script]);
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const [data] = await once(child.stdout, 'data');
  const grandchild = Number(String(data).trim());
  assert.ok(grandchild > 0);
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  let gone = false;
  for (let i = 0; i < 30; i++) {
    try { process.kill(grandchild, 0); } catch { gone = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(gone, 'CLI subprocess must not continue after Stop');
});
test('HTTP blocks cross-site reads, framing and wrong Host; local read stays available', async t => {
  const http = require('node:http');
  const request = (url, options) => new Promise((resolve, reject) => { const req = http.get(url, options, res => { res.resume(); resolve({ status: res.statusCode, headers: { get: key => res.headers[key] } }); }); req.on('error', reject); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-http-'));
  process.env.HUB_ROOT = root; process.env.HUB_PORT = '0'; process.env.HUB_DRY_RUN = '1';
  const { server } = require('../server');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { Host: '127.0.0.1:0' };
  const local = await request(url + '/api/state', { headers });
  assert.equal(local.status, 200); assert.equal(local.headers.get('x-frame-options'), 'DENY');
  assert.match(local.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request(url + '/api/state', { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await request(url + '/api/state', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(url + '/api/state', { headers: { Host: 'attacker.invalid' } })).status, 403);
});
