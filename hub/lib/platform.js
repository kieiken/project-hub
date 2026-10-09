'use strict';
// Resolve npm-installed CLIs without passing prompts through cmd.exe.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', npm: 'npm' };
function executable(name, envPath = process.env.PATH || process.env.Path || '') {
  if (path.isAbsolute(name) || /[/\\]/.test(name)) return fs.existsSync(name) ? name : '';
  for (const dir of String(envPath).split(path.delimiter).filter(Boolean)) {
    const names = process.platform === 'win32' ? [name + '.exe', name + '.com'] : [name];
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
    }
    if (process.platform === 'win32' && packages[name]) {
      const root = path.join(dir, 'node_modules', packages[name]);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
        const file = bin && path.resolve(root, bin);
        if (file && fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return '';
}
function resolveCommand(file, args = [], env = process.env) {
  if (process.platform !== 'win32') return { file, args };
  const found = executable(file, env.PATH || env.Path) || file;
  if (/\.[cm]?js$/i.test(found)) return { file: process.execPath, args: [found, ...args] };
  return { file: found, args };
}
function spawn(file, args, options = {}) {
  const cmd = resolveCommand(file, args, options.env);
  const child = cp.spawn(cmd.file, cmd.args, { windowsHide: true, ...options });
  if (process.platform === 'win32') {
    const kill = child.kill.bind(child);
    child.kill = signal => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
      cp.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, err => {
        if (err && child.exitCode === null && child.signalCode === null) kill(signal);
      });
      return true;
    };
  }
  return child;
}
function execFile(file, args, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const cmd = resolveCommand(file, args, options?.env);
  return cp.execFile(cmd.file, cmd.args, { windowsHide: true, ...options }, callback);
}
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
function powershell(script, dry = false) {
  const args = ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  if (dry) return Promise.resolve({ dry: true, file: 'powershell.exe', args });
  return new Promise((resolve, reject) => cp.execFile('powershell.exe', args, { windowsHide: true, encoding: 'utf8' }, (err, out) => err ? reject(err) : resolve({ ok: true, output: out.trim() })));
}
module.exports = { executable, resolveCommand, spawn, execFile, psQuote, powershell };
