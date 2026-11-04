'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const platforms = require('./platform');
const SECRET = /^(\.git|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|\.netrc|\.npmrc|\.pypirc)$/i;
const MAX = 64 * 1024;
const inside = (f, root) => f === root || f.startsWith(root + path.sep);
class WorkspaceError extends Error { constructor(code) { super(code); this.code = code; this.status = 403; } }
function resolveWorkspace(root, raw) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new WorkspaceError('invalid_path');
  const f = path.resolve(root, raw);
  if (!inside(f, root) || f.split(path.sep).some(p => SECRET.test(p))) throw new WorkspaceError('path_not_allowed');
  let probe = f;
  while (!fs.existsSync(probe)) {
    try { if (fs.lstatSync(probe).isSymbolicLink()) throw new WorkspaceError('path_not_allowed'); } catch (e) { if (e instanceof WorkspaceError) throw e; }
    probe = path.dirname(probe);
  }
  if (fs.realpathSync(probe) !== probe) throw new WorkspaceError('path_not_allowed');
  const st = fs.existsSync(f) && fs.lstatSync(f);
  if (st && (st.isSymbolicLink() || st.isFile() && st.nlink > 1)) throw new WorkspaceError('path_not_allowed');
  return f;
}
class WorkspaceSandbox {
  constructor(scope, opts = {}) { this.scope = scope; this.workspace = opts.workspace; this.platform = opts.platformApi || platforms.forPlatform(opts.platform); this.spawn = opts.spawn || spawn; this.children = opts.children || new Set(); this.Error = opts.Error || WorkspaceError; this.timeoutMs = opts.timeoutMs || 120000; }
  profile() { return this.platform.commandSandbox.profile(this.workspace(), this.scope.readFiles); }
  run(command) {
    if (!this.platform.commandSandbox.available()) {
      const error = new this.Error('command_sandbox_unavailable');
      if (this.platform.name === 'win32') error.message = 'WindowsではCodex CLIの隔離実行（codex sandbox）とGit for Windowsが必要です。見つからないため、コマンドを実行しません';
      throw error;
    }
    const root = this.workspace();
    // Reject linked/hardlinked workspace contents before granting recursive writes.
    const check = dir => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { if (d.name.toLowerCase() === '.git') continue; const f = path.join(dir, d.name), st = fs.lstatSync(f); if (st.isSymbolicLink()) { if (!inside(fs.realpathSync(f), root)) throw new this.Error('command_link_not_allowed'); continue; } if (st.isFile() && st.nlink > 1) throw new this.Error('command_link_not_allowed'); if (st.isDirectory()) check(f); } }; check(root);
    return new Promise((resolve, reject) => {
      // The time limit travels with the spawn so a platform can enforce it inside the sandbox too.
      const child = this.platform.commandSandbox.spawn(command, root, this.profile(), this.spawn, { timeoutMs: this.timeoutMs });
      this.children.add(child); const out = { stdout: '', stderr: '' }; let bytes = 0, truncated = false;
      const kill = () => this.kill(child);
      const timer = setTimeout(kill, this.timeoutMs);
      for (const key of ['stdout', 'stderr']) child[key].on('data', buf => { const remaining = MAX - bytes; out[key] += buf.subarray(0, remaining).toString('utf8'); bytes += Math.min(remaining, buf.length); if (buf.length > remaining) truncated = true; });
      child.on('error', () => { clearTimeout(timer); this.children.delete(child); reject(new this.Error('command_failed')); });
      child.on('close', (code, signal) => { clearTimeout(timer); kill(); this.children.delete(child); resolve({ code, signal, ...out, truncated }); });
    });
  }
  // Windows killTree re-verifies ownership and refuses an exited child; the
  // direct child is still signalled so a timeout never leaves it running.
  kill(child) { try { this.platform.killTree(child, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  stop() { for (const c of this.children) this.kill(c); }
}
module.exports = { WorkspaceSandbox, WorkspaceError, resolveWorkspace, inside };
