'use strict';
const fs = require('node:fs'), cp = require('node:child_process');
// st_dev is a mount-time number on macOS, not a persistent volume identity.
function create({ platform = process.platform, stat = dir => fs.statSync(dir), run = cp.execFileSync } = {}) {
  const volumes = new Map();
  function identity(dir) {
    const s = stat(dir), legacy = [s.dev, s.ino];
    if (platform !== 'darwin') return legacy;
    let volume = volumes.get(s.dev);
    if (!volume) {
      try {
        const options = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] };
        const device = run('/bin/df', ['-P', dir], options).trim().split('\n').at(-1).trim().split(/\s+/)[0];
        if (!/^\/dev\/disk[0-9]+s[0-9]+(?:s[0-9]+)?$/.test(device)) return legacy;
        const plist = run('/usr/sbin/diskutil', ['info', '-plist', device], options);
        volume = plist.match(/<key>VolumeUUID<\/key>\s*<string>([a-fA-F0-9-]{36})<\/string>/)?.[1]?.toLowerCase();
        if (!volume) return legacy;
        volumes.set(s.dev, volume);
      } catch { return legacy; }
    }
    return [...legacy, { volume, birth: s.birthtimeMs }];
  }
  return identity;
}
function sameIdentity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a[1] !== b[1]) return false;
  if (a[2] && b[2]) return typeof a[2].volume === 'string' && a[2].volume === b[2].volume
    && Number.isFinite(a[2].birth) && a[2].birth > 0 && a[2].birth === b[2].birth;
  // Old records have no volume proof: never infer a move/reboot from inode alone.
  return a[0] === b[0];
}
module.exports = { create, identity: create(), sameIdentity };
