'use strict';
// Windows command isolation through the Codex CLI sandbox (`codex sandbox`).
// Hub supplies the workspace root, extra read grants and the POSIX command;
// Codex supplies the OS boundary: a dedicated sandbox account, writes limited
// to the workspace root, a read-only .git and no network. This adapter never
// decides permission policy, never runs a command outside the sandbox and
// never executes Codex to learn its version. A missing or unsupported Codex
// fails closed: no spawn, or a non-zero exit from Codex itself.
const path = require('node:path').win32;
const PROFILE = 'project-hub-command';
const TARGET = 'x86_64-pc-windows-msvc';
// Windows system locations plus the Codex home selection. Hub settings,
// account variables and AI credentials never reach the sandboxed shell.
const PASSTHROUGH = Object.freeze(['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'CODEX_HOME']);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function create({ fs, env, findExecutable, shellCandidates, spawn = require('node:child_process').spawn, execPath = process.execPath }) {
  const fail = (message, code) => Object.assign(Error(message), { code, platform: 'win32' });
  const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  // Local drive paths only: no NUL, newline or quote, no stream suffix, no ".." segment.
  function local(value, label) {
    if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || /[\0\r\n"]/.test(value) || value.slice(2).includes(':') || value.split(/[\\/]/).includes('..')) throw fail(`Windowsの隔離実行の${label}を確認できません`, 'command_sandbox_path');
    return path.resolve(value);
  }
  // npm's codex.cmd is a cmd.exe shim around bin/codex.js, which starts the
  // vendored native binary. Start that binary directly so the command never
  // passes through cmd.exe. A codex.exe found on PATH is used as found.
  function codexExecutable() {
    const found = findExecutable('codex');
    if (!found) return null;
    if (/\.exe$/i.test(found)) return found;
    if (!/\.cmd$/i.test(found)) return null;
    const prefix = path.dirname(found), pkg = path.join(prefix, 'node_modules', '@openai', 'codex');
    let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')); } catch { return null; }
    if (manifest?.name !== '@openai/codex') return null;
    return [pkg, prefix].map(dir => path.join(dir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TARGET, 'bin', 'codex.exe')).find(isFile) || null;
  }
  const shell = () => shellCandidates().find(isFile) || null;
  const available = () => Boolean(codexExecutable() && shell());
  // The kernel image path is what killTree compares; spawn the canonical file.
  const realpath = file => { try { return typeof fs.realpathSync?.native === 'function' ? fs.realpathSync.native(file) : file; } catch { return file; } };
  function profile(root, readFiles = []) {
    const workspace = local(root, '対象フォルダ');
    if (!Array.isArray(readFiles)) throw fail('Windowsの隔離実行の読み取り許可を確認できません', 'command_sandbox_path');
    // A grant inside the writable root would become a read-only carve-out.
    const reads = [...new Set(readFiles.map(file => local(file, '読み取り許可')))].filter(file => !inside(workspace, file));
    const quote = JSON.stringify; // JSON escapes are valid TOML basic-string escapes
    const filesystem = ['":minimal"="read"', quote(workspace) + '="write"', quote(path.join(workspace, '.git')) + '="read"', ...reads.map(file => quote(file) + '="read"')];
    return Object.freeze({ root: workspace, readFiles: Object.freeze(reads), args: Object.freeze(['sandbox', '-C', workspace, '-P', PROFILE, '--include-managed-config',
      '-c', `permissions.${PROFILE}.filesystem={${filesystem.join(',')}}`, '-c', `permissions.${PROFILE}.network.enabled=false`, '-c', 'windows.sandbox="elevated"']) });
  }
  function spawnSandboxed(command, root, profile, spawnProcess = spawn) {
    const workspace = local(root, '対象フォルダ');
    if (typeof command !== 'string' || !command || command.includes('\0')) throw fail('Windowsの隔離実行のコマンドを確認できません', 'command_sandbox_command');
    if (!profile || !Array.isArray(profile.args) || profile.root !== workspace) throw fail('Windowsの隔離実行の設定が対象フォルダと一致しません', 'command_sandbox_profile');
    const codex = codexExecutable(), bash = shell();
    if (!codex || !bash) throw fail('WindowsではCodex CLIの隔離実行（codex sandbox）とGit for Windowsが必要です。見つからないため、コマンドを実行しません', 'command_sandbox_unavailable');
    const passthrough = Object.fromEntries(PASSTHROUGH.filter(key => typeof env[key] === 'string' && env[key]).map(key => [key, env[key]]));
    // Git Bash adds its own /usr/bin and /mingw64/bin; the workspace is HOME and TEMP, as on Mac.
    const runtime = { PATH: [path.join(env.SystemRoot || 'C:\\Windows', 'System32'), path.dirname(bash), path.dirname(execPath)].join(';'), HOME: workspace, TEMP: workspace, TMP: workspace, LANG: 'en_US.UTF-8' };
    return spawnProcess(realpath(codex), [...profile.args, '--', bash, '-c', command], { cwd: workspace, env: { ...passthrough, ...runtime }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return Object.freeze({ available, profile, spawn: spawnSandboxed, codexExecutable, shell });
}
module.exports = { create, PROFILE, PASSTHROUGH };
