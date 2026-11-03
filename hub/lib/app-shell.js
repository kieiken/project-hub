'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const platforms = require('./platform');
const { lt } = require('./locale');

class AppShell {
  constructor({ hub, env = process.env, dry = false, readPlist, run, platform = platforms } = {}) {
    this.platform = platform;
    this.hub = hub; this.env = env; this.dry = dry; this.rebuilding = false;
    const bundled = hub.endsWith('.app/Contents/Resources/runtime/hub') ? path.resolve(hub, '../../../..') : '';
    this.app = env.HUB_UPDATE_APP || bundled || path.join(os.homedir(), 'Applications', 'Project Hub.app');
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(hub, '../release-manifest.json')));
      if (manifest.kind === 'public-release' && manifest.platform === 'darwin') {
        this.packaged = true;
        const row = manifest.files.find(r => r.path === 'hub/release-app/Window.swift');
        if (manifest.macShellGeneration !== 3 || manifest.shellProtocol !== 1 || !row || row.sha256 !== manifest.macShellHash) throw Error('shell_manifest');
        const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(hub, 'release-app/Window.swift'))).digest('hex');
        if (hash !== row.sha256) throw Error('shell_hash');
        this.packageHash = hash;
      }
    } catch {}
    try { this.hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(hub, 'app/window.swift'))).digest('hex'); } catch { this.hash = ''; }
    if (this.packaged) this.hash = this.packageHash || '';
    this.readPlist = readPlist || (file => this.platform.appUpdater.readPlist(file));
    this.run = run || ((file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, error => error ? reject(Error(lt('アプリを作り直せませんでした。今のアプリは保持しています'))) : resolve())));
  }
  status(userAgent = '') {
    let plist = {};
    try {
      const file = path.join(this.app, 'Contents/Info.plist'), stat = fs.statSync(file), key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (this.plistKey !== key) { this.plist = this.readPlist(file); this.plistKey = key; }
      plist = this.plist;
    } catch { this.plistKey = null; }
    const running = /ProjectHubApp\/([^\s]+)/.exec(userAgent)?.[1];
    return { hash: this.hash, appVersion: String(plist.CFBundleShortVersionString || ''),
      stale: !this.hash || Boolean(this.packaged && (plist.HubShellProtocol !== 1 || plist.HubShellGeneration !== 3)) || plist.HubShellHash !== this.hash || Boolean(running && running !== this.hash.slice(0, 12)), rebuilding: this.rebuilding };
  }
  async rebuild() {
    if (this.packaged) throw Object.assign(Error('配布アプリは最新版の完全版アプリへ入れ替えてください。保存したデータは保持されます。'), { status: 409 });
    if (this.dry) throw Object.assign(Error(lt('試験中はアプリを作り直しません')), { status: 409 });
    if (!path.isAbsolute(this.app) || path.basename(this.app) !== 'Project Hub.app' || !this.hash) throw Error(lt('アプリの場所またはソースを確認できません'));
    if (this.rebuilding) throw Object.assign(Error(lt('アプリを作り直しています')), { status: 409 });
    this.rebuilding = true;
    try {
      const bundled = this.hub === path.join(this.app, 'Contents/Resources/runtime/hub');
      await this.platform.appUpdater.buildShell(this.hub, { cwd: this.hub, env: { ...this.env, HUB_APP_DIR: path.dirname(this.app), HUB_NO_DESKTOP_LINK: '1', ...(bundled ? { HUB_BUNDLE_RUNTIME: '1' } : {}) }, timeout: 600000, maxBuffer: 1024 * 1024 }, this.run.bind(this));
      this.plistKey = null;
      if (this.status().stale) throw Error(lt('作り直したアプリを確認できませんでした'));
      return { ok: true, message: lt('アプリを終了して開き直してください') };
    } finally { this.rebuilding = false; }
  }
}
module.exports = { AppShell };
