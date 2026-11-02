'use strict';
// Update metadata uses SQLite FULL commits, not Windows rename as a durability
// substitute. No keys/license data are opened. Native NTFS identity is rechecked.
const fs = require('node:fs'), path = require('node:path');
const { noLinks } = require('../app-update-packaged');
// The guarded native helper performs the same parent/target ACL checks on
// every call, without starting a separate PowerShell process for each check.
function privateDirectory(home, create) {
  if (require('./index').privateDirectory(home, create) !== true) throw Error('update_acl');
}
class UpdateStore {
  constructor(root, { guard = privateDirectory } = {}) { this.home = path.join(root, '_hub', 'updates', 'windows'); this.guard = guard; }
  access(change) {
    noLinks(this.home); const exists = fs.existsSync(this.home);
    if (!exists) fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.guard(this.home, !exists);
    const native = process.platform === 'win32' ? require('./index') : null;
    const identity = native?.licenseDirectory(this.home);
    const file = path.join(this.home, 'update.sqlite');
    for (const name of ['update.sqlite', 'update.sqlite-wal', 'update.sqlite-shm', 'update.sqlite-journal']) {
      const p = path.join(this.home, name); noLinks(p);
      if (fs.existsSync(p)) { const s = fs.lstatSync(p); if (!s.isFile() || s.nlink !== 1) throw Error('update_store_path'); }
    }
    const existed = fs.existsSync(file);
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file); let result;
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      if (existed && (db.prepare('PRAGMA application_id').get().application_id !== 1213551189 || db.prepare('PRAGMA user_version').get().user_version !== 1)) throw Error('update_store_format');
      if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw Error('update_store_wal');
      db.exec('PRAGMA synchronous=FULL;'); if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw Error('update_store_sync');
      db.exec('BEGIN IMMEDIATE;');
      if (!existed) db.exec('PRAGMA application_id=1213551189; PRAGMA user_version=1; CREATE TABLE update_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL) STRICT;');
      const row = db.prepare('SELECT revision,value FROM update_state WHERE id=1').get();
      if (row && Buffer.byteLength(row.value) > 256 * 1024) throw Error('update_store_size');
      const value = row ? JSON.parse(row.value) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('update_store_format');
      const next = change?.(value, row?.revision || 0);
      if (next !== undefined) {
        const text = JSON.stringify(next); if (Buffer.byteLength(text) > 256 * 1024) throw Error('update_store_size');
        native?.licenseDirectory(this.home, identity);
        db.prepare('INSERT INTO update_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value').run((row?.revision || 0) + 1, text);
      }
      db.exec('COMMIT;'); result = { value: next ?? value, revision: (row?.revision || 0) + (next === undefined ? 0 : 1) };
    } finally { db.close(); }
    return result;
  }
  read() { return this.access(); }
  write(value, revision) {
    return this.access((old, actual) => { if (actual !== revision) throw Error('update_store_changed'); return value; });
  }
}
module.exports = { UpdateStore, privateDirectory };
