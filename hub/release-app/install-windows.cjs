'use strict';
// Explicit, per-user setup of a finished distribution. Never launches Hub,
// installs prerequisites, elevates, or touches its data/identity stores.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), cp = require('node:child_process');
const { verify } = require('./finalize-windows.cjs');
const { noLinks } = require('../lib/license/storage');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const messages = {
  platform: 'Windows 11 x64 と Node.js 22.13 以降が必要です。追加ソフトは導入していません。',
  environment: '通常ユーザー用の配置先を確認できませんでした。管理者として実行せず、Windows PowerShell 5.1 が使えることを確認してください。',
  elevated: '管理者としてのセットアップは行いません。通常ユーザーで開き直してください。',
  git: 'Git for Windows を確認できませんでした。通常の環境で Git for Windows が使えるか確認してください。追加ソフトは導入していません。',
  webview: 'WebView2 Runtime を確認できませんでした。Windows の必要環境を確認してください。追加ソフトは導入していません。',
  package: '完成品のファイル照合に失敗しました。作成用一式や変更されたフォルダではセットアップできません。',
  destination: '同じ版の配置先に異なる内容があります。既存の内容は上書きしていません。',
  shortcut: 'スタートメニューに別の項目があるか、登録を確認できませんでした。既存の項目は無条件に上書きしません。',
  cancelled: '起動項目の切り替えを取り消しました。以前の起動項目は変更していません。',
  failed: 'セットアップを完了できませんでした。既存の保存先・会話・認証・利用権は変更していません。途中の配置は調査用に保持します。'
};
function fail(code) { throw Object.assign(new Error(messages[code] || messages.failed), { code }); }

// All variable values travel as JSON on stdin, never as PowerShell source.
// EncodedCommand specifies Unicode, not an ExecutionPolicy bypass.
const powershell = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
function PlainPath([string]$p) {
  for($d=$p;$d;$d=[IO.Path]::GetDirectoryName($d)) {
    if((Test-Path -LiteralPath $d) -and (([IO.File]::GetAttributes($d) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {throw 'reparse_point'}
  }
}
function LinkData([string]$p) {
  PlainPath $p
  if(-not [IO.File]::Exists($p)) { if(Test-Path -LiteralPath $p){throw 'not_file'};return $null }
  $l=$shell.CreateShortcut($p)
  return @{target=$l.TargetPath;workingDirectory=$l.WorkingDirectory;icon=$l.IconLocation;arguments=$l.Arguments;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
}
if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {throw 'powershell_5_1_required'}
switch($r.action) {
  'environment' {
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    @{local=[Environment]::GetFolderPath('LocalApplicationData');programs=[Environment]::GetFolderPath('Programs');elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress
  }
  'prerequisites' {
    [void][Reflection.Assembly]::LoadFrom($r.dll)
    $version=[Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString($null)
    if([string]::IsNullOrWhiteSpace($version)){throw 'webview2_missing'}
    @{webview2=$version} | ConvertTo-Json -Compress
  }
  'read' {
    $shell=New-Object -ComObject WScript.Shell
    @{link=(LinkData $r.file)} | ConvertTo-Json -Compress
  }
  'confirm' {
    Add-Type -AssemblyName System.Windows.Forms
    $answer=[Windows.Forms.MessageBox]::Show($r.text,'Project Hub',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question,[Windows.Forms.MessageBoxDefaultButton]::Button2)
    @{accepted=($answer -eq [Windows.Forms.DialogResult]::Yes)} | ConvertTo-Json -Compress
  }
  'write' {
    $shell=New-Object -ComObject WScript.Shell
    PlainPath ([IO.Path]::GetDirectoryName($r.file))
    $before=LinkData $r.file
    if(($null -eq $before -and $null -ne $r.before) -or ($null -ne $before -and $before.sha256 -cne $r.before.sha256)){throw 'shortcut_changed'}
    $temp=Join-Path ([IO.Path]::GetDirectoryName($r.file)) ('.ProjectHub-setup-'+[Guid]::NewGuid().ToString()+'.lnk')
    try {
      $l=$shell.CreateShortcut($temp)
      $l.TargetPath=$r.target;$l.WorkingDirectory=$r.workingDirectory;$l.IconLocation=$r.icon
      $l.Arguments='';$l.Description='Project Hub';$l.WindowStyle=1;$l.Save()
      $check=LinkData $temp
      if($check.target -ine $r.target -or $check.workingDirectory -ine $r.workingDirectory -or $check.icon -ine $r.icon -or $check.arguments -ne ''){throw 'shortcut_not_verified'}
      $current=LinkData $r.file
      if(($null -eq $before -and $null -ne $current) -or ($null -ne $before -and ($null -eq $current -or $current.sha256 -cne $before.sha256))){throw 'shortcut_changed'}
      if($null -eq $before){[IO.File]::Move($temp,$r.file)}
      else {
        PlainPath $r.backup
        [IO.File]::Copy($r.file,$r.backup,$false)
        if((Get-FileHash -LiteralPath $r.backup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before.sha256){throw 'backup_changed'}
        [IO.File]::Replace($temp,$r.file,$null)
      }
      @{link=(LinkData $r.file)} | ConvertTo-Json -Compress
    } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
  }
  'message' {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($r.text,'Project Hub',[Windows.Forms.MessageBoxButtons]::OK)
    @{shown=$true} | ConvertTo-Json -Compress
  }
  default {throw 'unknown_setup_action'}
}`;
function bridge(env = process.env, execFileSync = cp.execFileSync) {
  const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return request => JSON.parse(String(execFileSync(exe,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')],
    { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, shell: false, timeout: request.action === 'confirm' || request.action === 'message' ? 0 : 60000, maxBuffer: 65536 }
  )).replace(/^\uFEFF/, ''));
}
function finished(base) {
  try {
    const result = verify(base), m = result.manifest;
    if (m.windowsNativePrepared !== true || !/^\d+\.\d+\.\d+$/.test(m.releaseVersion)) fail('package');
    const seen = new Set();
    for (const row of result.actual) {
      if (/[\\:<>"|?*\x00-\x1f]/.test(row.path) || row.path.split('/').some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) || seen.has(row.path.toLowerCase())) fail('package');
      seen.add(row.path.toLowerCase());
    }
    for (const name of ['START-WINDOWS.cmd', 'SETUP-WINDOWS.cmd', 'hub/app/windows/ProjectHub.ico', ...require('./windows-window.cjs').names.map(n => 'window/' + n)]) {
      if (!m.files.some(row => row.path === name)) fail('package');
    }
    return { ...result, digest: sha(fs.readFileSync(path.join(base, 'release-manifest.json'))) };
  } catch { fail('package'); }
}
function sameLink(actual, expected) {
  return actual && ['target', 'workingDirectory', 'icon'].every(k => typeof actual[k] === 'string' && actual[k].toLowerCase() === expected[k].toLowerCase()) && actual.arguments === '';
}
function olderOrSame(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i]; }
  return true;
}
function install({ base, platform = process.platform, arch = process.arch, nodeVersion = process.versions.node,
  release = os.release(), call = bridge(), git = () => cp.execFileSync('git.exe', ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 }),
  copy = fs.copyFileSync } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  const build = Number(release.split('.')[2]);
  if (platform !== 'win32' || arch !== 'x64' || !(major > 22 || major === 22 && minor >= 13) || !Number.isInteger(build) || build < 22000) fail('platform');
  let environment;
  try { environment = call({ action: 'environment' }); } catch { fail('environment'); }
  if (environment.elevated !== false) fail('elevated');
  for (const key of ['local', 'programs']) {
    const p = environment[key];
    if (typeof p !== 'string' || !path.isAbsolute(p) || p !== path.resolve(p)) fail('environment');
    noLinks(p);
  }
  const original = finished(base), version = original.manifest.releaseVersion;
  try {
    if (!/^git version \d+.*\.windows\./i.test(String(git()).trim())) fail('git');
  } catch { fail('git'); }
  try {
    if (!call({ action: 'prerequisites', dll: path.join(base, 'window/Microsoft.Web.WebView2.Core.dll') }).webview2) fail('webview');
  } catch { fail('webview'); }
  const root = path.join(environment.local, 'Programs/Project Hub'), destination = path.join(root, version);
  const shortcut = path.join(environment.programs, 'Project Hub.lnk');
  noLinks(root); noLinks(destination); noLinks(shortcut);
  let before;
  try { before = call({ action: 'read', file: shortcut }).link; } catch { fail('shortcut'); }
  const expected = { target: path.join(destination, 'START-WINDOWS.cmd'), workingDirectory: destination, icon: path.join(destination, 'hub/app/windows/ProjectHub.ico') + ',0' };
  let replace = false;
  if (before && !sameLink(before, expected)) {
    // Only offer to switch a verified prior per-user installation. Arbitrary
    // similarly named Start menu items are preserved, without an overwrite UI.
    const prior = typeof before.target === 'string' ? path.dirname(before.target) : '';
    if (path.dirname(prior).toLowerCase() !== root.toLowerCase() || path.basename(before.target).toLowerCase() !== 'start-windows.cmd' || before.arguments !== '' || typeof before.workingDirectory !== 'string' || before.workingDirectory.toLowerCase() !== prior.toLowerCase()) fail('shortcut');
    let old;
    try { old = verify(prior).manifest; } catch { fail('shortcut'); }
    if (old.windowsNativePrepared !== true || !/^\d+\.\d+\.\d+$/.test(old.releaseVersion) || path.basename(prior) !== old.releaseVersion || !olderOrSame(old.releaseVersion, version)) fail('shortcut');
    if (!call({ action: 'confirm', text: 'スタートメニューの Project Hub を ' + old.releaseVersion + ' から ' + version + ' に切り替えますか？\n以前のアプリと保存データは残します。' }).accepted) fail('cancelled');
    replace = true;
  }
  if (fs.existsSync(destination)) {
    try { if (finished(destination).digest !== original.digest) fail('destination'); } catch { fail('destination'); }
  } else {
    fs.mkdirSync(root, { recursive: true }); noLinks(root);
    const stage = path.join(root, '.setup-' + crypto.randomUUID());
    fs.mkdirSync(stage);
    // Exact inventory only; no globbing and no source-only receipt/side files.
    // A failed new stage is kept for diagnosis, never deleted or retried here.
    for (const row of original.actual) {
      const from = path.join(base, row.path), to = path.join(stage, row.path);
      noLinks(from); noLinks(to); fs.mkdirSync(path.dirname(to), { recursive: true });
      copy(from, to, fs.constants.COPYFILE_EXCL);
    }
    if (finished(stage).digest !== original.digest || finished(base).digest !== original.digest) fail('package');
    noLinks(destination);
    if (fs.existsSync(destination)) fail('destination');
    fs.renameSync(stage, destination); // Windows refuses an existing directory.
  }
  if (finished(destination).digest !== original.digest) fail('destination');
  if (!before || replace) {
    fs.mkdirSync(environment.programs, { recursive: true }); noLinks(environment.programs);
    const state = path.join(root, '.setup'); noLinks(state); fs.mkdirSync(state, { recursive: true });
    try {
      const result = call({ action: 'write', file: shortcut, before: before || null, ...expected, backup: path.join(state, 'shortcut-' + crypto.randomUUID() + '.lnk') });
      if (!sameLink(result.link, expected)) fail('shortcut');
    } catch { fail('shortcut'); }
  }
  if (!sameLink(call({ action: 'read', file: shortcut }).link, expected)) fail('shortcut');
  const receipt = { version, destination, shortcut, manifestSha256: original.digest, files: original.actual.length,
    target: expected.target, workingDirectory: expected.workingDirectory, icon: expected.icon,
    applicationLaunched: false, startMenuLaunchVerified: false };
  const state = path.join(root, '.setup'); noLinks(state); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'install-' + crypto.randomUUID() + '.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  call({ action: 'message', text: 'セットアップが完了しました。\n次回からスタートメニューのProject Hubで起動できます。\n「すべてのアプリ」または検索で「Project Hub」を選んでください。\n\n配置先：' + destination });
  return receipt;
}
if (require.main === module) {
  const call = bridge();
  try { install({ base: path.resolve(__dirname, '../..'), call }); }
  catch (error) {
    const text = messages[error.code] || messages.failed;
    console.error(text);
    try { call({ action: 'message', text }); } catch { /* CMD keeps the error visible if PowerShell is unavailable. */ }
    process.exitCode = 1;
  }
}
module.exports = { install, bridge, powershell, sameLink };
