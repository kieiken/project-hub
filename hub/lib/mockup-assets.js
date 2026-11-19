'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const assetTypes = new Map(Object.entries({
  '.css': 'text/css', '.png': 'image/png', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}));
const minute = 60_000;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function readMockupFile(fd, expected, limit) {
  const before = fs.fstatSync(fd);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit || !sameVersion(before, expected)) throw Error('mockup changed');
  const data = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < data.length) {
    const count = fs.readSync(fd, data, offset, data.length - offset, offset);
    if (!count) throw Error('mockup changed');
    offset += count;
  }
  const after = fs.fstatSync(fd);
  if (after.nlink !== 1 || !sameVersion(before, after)) throw Error('mockup changed');
  return data;
}

function createMockupAssets({ protect, now = Date.now }) {
  const grants = new Map();
  function sameDirectory(dir, before) {
    const current = fs.lstatSync(dir);
    return current.isDirectory() && sameFile(current, before) && fs.realpathSync(dir) === dir && !protect(dir);
  }
  return {
    issue(file, audience, expected) {
      const dir = path.dirname(file), stat = fs.lstatSync(dir), entry = fs.lstatSync(file);
      if (!audience || !sameDirectory(dir, stat) || !entry.isFile() || entry.nlink !== 1
        || !sameVersion(entry, expected) || protect(file)) throw Error('mockup changed');
      const time = now();
      for (const [id, grant] of grants) if (grant.expires <= time) grants.delete(id);
      if (grants.size >= 64) grants.delete(grants.keys().next().value);
      const id = crypto.randomBytes(24).toString('hex');
      grants.set(id, { dir, stat, audience, expires: time + minute, remaining: 48, bytes: 6 * 1024 * 1024 });
      return id;
    },
    read(id, name, audience) {
      const grant = grants.get(id);
      if (!audience || !grant || grant.audience !== audience) return null;
      if (grant.expires <= now()) { grants.delete(id); return null; }
      if (grant.remaining <= 0) return null;
      // No subdirectories, dotfiles, device paths, or NTFS alternate streams.
      if (!name || name.length > 255 || /^[.]|[ .]$|[\x00-\x1f\x7f<>:"/\\|?*]/.test(name)) return null;
      const type = assetTypes.get(path.extname(name).toLowerCase());
      if (!type) return null;
      grant.remaining -= 1;
      const file = path.join(grant.dir, name);
      const limit = Math.min(grant.bytes, type === 'text/css' ? 256 * 1024 : 2 * 1024 * 1024);
      let fd;
      try {
        if (!sameDirectory(grant.dir, grant.stat)) return null;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || protect(file) || fs.realpathSync(file) !== file) return null;
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const data = readMockupFile(fd, stat, limit);
        if (!sameDirectory(grant.dir, grant.stat) || !sameVersion(fs.lstatSync(file), stat)) return null;
        grant.bytes -= data.length;
        return type === 'text/css' ? { css: data.toString('utf8') } : { type, base64: data.toString('base64') };
      } catch { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}

module.exports = { createMockupAssets, readMockupFile };
