'use strict';
// Restricted, deterministic ZIP adapter. No archive commands or downloaded code.
const fs = require('node:fs'), path = require('node:path'), c = require('node:crypto'), z = require('node:zlib');
const LIMIT = 256 * 1024 * 1024, TOTAL = 1024 * 1024 * 1024, COUNT = 10000;
const fail = code => { throw Object.assign(Error(code), { code }); };
const sha = b => c.createHash('sha256').update(b).digest('hex');
const table = Array.from({ length: 256 }, (_, i) => { let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(b) { let n = 0xffffffff; for (const v of b) n = table[(n ^ v) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
function safeName(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 240 || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.endsWith('/')) fail('zip-path');
  const parts = name.split('/');
  if (parts.length > 32 || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) fail('zip-path');
  if (parts.some(p => ['.git', 'license-issuer', 'owner-edition.js', 'license.sqlite', 'device.json', 'state.json'].includes(p.toLowerCase()))) fail('private-content');
  return name;
}
function entries(dir) {
  const list = []; let bytes = 0; const seen = new Set();
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const rel = safeName(prefix + name), full = path.join(folder, name), s = fs.lstatSync(full);
      const key = rel.normalize('NFC').toLowerCase(); if (seen.has(key)) fail('zip-duplicate'); seen.add(key);
      if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1)) fail('zip-type');
      if (s.isFile()) { bytes += s.size; if (s.size > LIMIT || bytes > TOTAL) fail('zip-size'); }
      list.push({ rel, full, dir: s.isDirectory(), size: s.size }); if (list.length > COUNT) fail('zip-entries');
      if (s.isDirectory()) walk(full, rel + '/');
    }
  }
  const root = fs.lstatSync(dir); if (!root.isDirectory() || root.isSymbolicLink()) fail('zip-root'); walk(dir);
  return { list: list.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel))), bytes };
}
function treeHash(dir) {
  const { list, bytes } = entries(dir), h = c.createHash('sha256');
  for (const e of list) {
    let digest = '';
    if (!e.dir) {
      const fd = fs.openSync(e.full, 'r'), hash = c.createHash('sha256'), buf = Buffer.alloc(65536);
      try { let n; while ((n = fs.readSync(fd, buf))) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
      digest = hash.digest('hex');
    }
    // Permissions have no portable meaning on NTFS. File/directory kind + exact
    // UTF-8 path + content digest are signed instead; ACLs are checked separately.
    h.update(`${e.dir ? 'dir' : 'file'}\0${e.rel}\0${digest}\n`);
  }
  return { treeSha256: h.digest('hex'), entries: list.length, bytes };
}
function pack(dir) {
  const { list } = entries(dir), chunks = [], central = []; let offset = 0;
  for (const e of list) {
    const name = Buffer.from(e.rel + (e.dir ? '/' : '')), raw = e.dir ? Buffer.alloc(0) : fs.readFileSync(e.full);
    const data = z.deflateRawSync(raw), crc = crc32(raw), head = Buffer.alloc(30), record = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(((e.dir ? 0x41c0 : 0x8180) * 65536 + (e.dir ? 16 : 0)) >>> 0, 38); record.writeUInt32LE(offset, 42);
    chunks.push(head, name, data); central.push(record, name); offset += head.length + name.length + data.length;
    if (offset > LIMIT) fail('zip-size');
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...chunks, cd, end]); if (zip.length > LIMIT) fail('zip-size'); return zip;
}
function unpack(zip, destination, {
  allowAscii = false, maxEntryBytes = LIMIT, maxBytes = TOTAL, maxEntries = COUNT, acceptEntry,
} = {}) {
  // Only our bounded profile is accepted: no ZIP64, encryption, descriptors,
  // extras, comments, symlinks, device files, alternate streams or ambiguous names.
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > LIMIT) fail('zip-size');
  const end = zip.length - 22; if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 20)) fail('zip-format');
  const count = zip.readUInt16LE(end + 10), cdSize = zip.readUInt32LE(end + 12), cdStart = zip.readUInt32LE(end + 16);
  if (!count || count > Math.min(COUNT, maxEntries) || count !== zip.readUInt16LE(end + 8) || cdStart + cdSize !== end) fail('zip-format');
  const records = [], seen = new Set(); let at = cdStart, total = 0, next = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) fail('zip-format');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16), size = zip.readUInt32LE(at + 20), plain = zip.readUInt32LE(at + 24), len = zip.readUInt16LE(at + 28), start = zip.readUInt32LE(at + 42), attrs = zip.readUInt32LE(at + 38), kind = attrs >>> 28;
    if ((flags !== 0x800 && !(allowAscii && flags === 0)) || ![0, 8].includes(method) || !len || zip.readUInt16LE(at + 30) || zip.readUInt16LE(at + 32) || zip.readUInt16LE(at + 34) || start !== next || ![0, 4, 8].includes(kind) || (attrs & 0x400)) fail('zip-format');
    if (at + 46 + len > end) fail('zip-format');
    const nameBytes = zip.subarray(at + 46, at + 46 + len); let name;
    if (flags === 0 && nameBytes.some(byte => byte > 127)) fail('zip-path');
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { fail('zip-path'); }
    const directory = name.endsWith('/'); name = safeName(directory ? name.slice(0, -1) : name);
    if (acceptEntry && !acceptEntry(name, directory)) fail('zip-path');
    if (kind === 4 && !directory || kind === 8 && directory || Boolean(attrs & 16) !== directory) fail('zip-type');
    const key = name.normalize('NFC').toLowerCase(); if (seen.has(key)) fail('zip-duplicate'); seen.add(key);
    if (plain > Math.min(LIMIT, maxEntryBytes) || (total += plain) > Math.min(TOTAL, maxBytes) || directory && plain) fail('zip-size');
    if (start + 30 + len + size > cdStart || zip.readUInt32LE(start) !== 0x04034b50 || zip.readUInt16LE(start + 6) !== flags || zip.readUInt16LE(start + 8) !== method || zip.readUInt32LE(start + 14) !== crc || zip.readUInt32LE(start + 18) !== size || zip.readUInt32LE(start + 22) !== plain || zip.readUInt16LE(start + 26) !== len || zip.readUInt16LE(start + 28) || !zip.subarray(start + 30, start + 30 + len).equals(nameBytes)) fail('zip-format');
    next = start + 30 + len + size; records.push({ name, directory, crc, plain, method, start: start + 30 + len, size }); at += 46 + len;
  }
  if (at !== end || next !== cdStart) fail('zip-format');
  // All metadata must be valid before the first write. Destination is exclusively
  // created and private; parents must appear explicitly, prior to their children.
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const e of records) {
    const file = path.join(destination, e.name), parent = path.dirname(file);
    if (parent !== destination && !fs.lstatSync(parent).isDirectory()) fail('zip-parent');
    const compressed = zip.subarray(e.start, e.start + e.size);
    const raw = e.method === 0 ? compressed : z.inflateRawSync(compressed, { maxOutputLength: Math.max(1, e.plain) });
    if (raw.length !== e.plain || crc32(raw) !== e.crc) fail('zip-crc');
    if (e.directory) fs.mkdirSync(file, { mode: 0o700 });
    else { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  return treeHash(destination);
}
module.exports = { treeHash, pack, unpack, safeName, crc32, sha };
