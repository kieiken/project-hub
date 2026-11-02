'use strict';
// Companion to start.cmd; no shell command strings, installs or elevation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
function preflight({ platform, root, nodeVersion = process.versions.node, arch = process.arch, host = process.platform, io = fs, guard = process.env.HUB_STORAGE_GUARD, run = cp.execFileSync }) {
  if (host !== 'win32' || arch !== 'x64' || Number(nodeVersion.split('.')[0]) < 22) throw Error('Windows x64 と Node.js 22 以上が必要です');
  if (guard) run(guard, [], { stdio: 'inherit', shell: false });
  require('./lib/owned-processes').assertLaunchOwnership(platform);
  const shell = platform.shellCandidates().find(file => io.existsSync(file));
  if (!shell) throw Error('Git for Windows の標準の場所に Git Bash が必要です');
  // Do not create trial data before the existing ancestor can be confirmed.
  let ancestor = root;
  while (!io.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw Error('試用データの保存先を確認できません');
    ancestor = parent;
  }
  platform.persistence.syncDirectory(ancestor);
  if (!io.existsSync(root)) {
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    platform.persistence.syncDirectory(ancestor);
  }
  platform.persistence.syncDirectory(root);
}
function freePort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
async function serverReady(url, pid, runtimePath, request = fetch, verify = require('./app/open-browser.cjs').verify) {
  const owner = await verify(Number(require('node:url').parse(url).port));
  if (owner.pid !== pid) return false;
  const options = { signal: AbortSignal.timeout(1500), headers: { connection: 'close', 'X-Hub-Token': require('./lib/local-auth').capability(owner.token) } };
  const ping = await request(url + '/api/ping', options);
  if (!ping.ok) return false;
  const body = await ping.json();
  if (body.pid !== pid || typeof body.runtimePath !== 'string' || path.resolve(body.runtimePath) !== path.resolve(runtimePath)) return false;
  return (await request(url + '/api/state', options)).ok;
}
async function main() {
  const platform = require('./lib/platform');
  const root = path.resolve(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'ProjectHub-Windows-Trial'));
  const port = Number(process.env.HUB_PORT || 4545);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('起動する番号は1024〜65535で指定してください');
  // An occupied port is ambiguous; do not open or stop an unrelated server.
  await freePort(port);
  preflight({ platform, root });
  try { require('node-pty'); } catch { throw Error('Windows用の node-pty が必要です。Windows上で依存部品を準備してください'); }
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, env: { ...process.env, HUB_ROOT: root, HUB_PORT: String(port) }, stdio: 'inherit', shell: false,
  });
  let exited = false;
  child.once('error', error => { exited = true; console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { exited = true; process.exitCode = code ?? 1; console.log('Project Hub が止まりました。'); });
  // The child shares this console and receives Ctrl+C itself. On Windows,
  // child.kill('SIGINT') forcibly terminates it, bypassing server shutdown.
  process.on('SIGINT', () => { if (!exited) console.log('Project Hub の終了処理を待っています。'); });
  process.on('SIGTERM', () => { if (!exited) child.kill('SIGTERM'); });
  const url = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 60000;
  while (!exited && Date.now() < deadline) {
    let ready = false;
    try {
      ready = await serverReady(url, child.pid, __dirname);
    } catch { /* readiness only; no user operation is replayed */ }
    if (ready) {
      try {
        const launched = await require('./app/open-browser.cjs').launch(port, file => platform.openUrl(require('node:url').pathToFileURL(file).href));
        setTimeout(launched.cleanup, 65000).unref();
      }
      catch (error) { if (!exited) child.kill(); throw error; }
      console.log('保存先：' + root); return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!exited) {
    console.error('準備を確認できません。起動したサーバーを終了します。');
    child.kill(); process.exitCode = 1;
  }
}
if (require.main === module) main().catch(error => {
  console.error('起動を止めました：' + error.message);
  console.error('権限の変更や管理者としての再実行は自動で行いません。この表示をそのまま返してください。');
  process.exitCode = 1;
});
module.exports = { preflight, freePort, serverReady };
