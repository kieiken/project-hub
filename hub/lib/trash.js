'use strict';
const { lt } = require('./locale');
// Finder aggregates each volume's own Trash. Keep trash moves atomic on that
// volume so inode fingerprints and interruption/restore receipts remain valid.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const homeTrash = () => path.join(os.homedir(), '.Trash');
function existingParent(file, stat = fs.statSync) {
  let current = path.resolve(file);
  for (;;) {
    try { return { path: current, stat: stat(current) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
function volumeRoot(file, stat = fs.statSync) {
  const start = existingParent(file, stat);
  const device = start.stat.dev;
  let current = start.stat.isDirectory() ? start.path : path.dirname(start.path);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current || stat(parent).dev !== device) return current;
    current = parent;
  }
}
function trashRootFor(source, configured, options = {}) {
  const stat = options.stat || fs.statSync;
  const original = path.resolve(configured || process.env.HUB_TRASH || homeTrash());
  // Explicit custom trash roots retain their meaning, including test fixtures.
  if ((options.platform || process.platform) !== 'darwin' || original !== path.resolve(options.homeTrash || homeTrash())) return original;
  const sourceStat = existingParent(source, stat).stat;
  if (sourceStat.dev === existingParent(original, stat).stat.dev) return original;
  const root = volumeRoot(source, stat);
  const parent = path.join(root, '.Trashes');
  const directory = path.join(parent, String(options.uid ?? os.userInfo().uid));
  // Do not create or chmod the root-owned macOS Trash container. Finder manages it.
  const inspect = options.lstat || fs.lstatSync;
  const container = inspect(parent);
  if (!container.isDirectory() || container.isSymbolicLink()) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  try {
    const entry = inspect(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat(parent).dev !== sourceStat.dev) throw Error(lt('このディスクのゴミ箱の場所を確認できません'));
  return directory;
}
function isTrashDestination(source, destination, configured) {
  const inside = root => destination === root || destination.startsWith(root + path.sep);
  const original = path.resolve(configured || process.env.HUB_TRASH || homeTrash());
  // Existing home-trash receipts remain restorable; new moves use source-volume Trash.
  if (inside(original)) return true;
  return inside(trashRootFor(source, configured));
}
module.exports = { trashRootFor, isTrashDestination, volumeRoot, existingParent };
