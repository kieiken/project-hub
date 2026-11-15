'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
const bytes = value => JSON.stringify(canonical(value), null, 2) + '\n';
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : bytes(value)).digest('hex');
const clone = value => structuredClone(value);
const uuid = () => crypto.randomUUID();
function fail(code, message, status = 409, saved = false) { const e = Error(message); Object.assign(e, { code, status, saved }); return e; }
function check(ok, code, message, status) { if (!ok) throw fail(code, message, status); }
function opId(id) { check(typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id), 'op-id', '送信識別を確認してください', 400); return id; }
function strictRead(file, io = fs) { try { return io.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function json(file, io = fs) { const s = strictRead(file, io); return s === null ? null : JSON.parse(s); }
function gitRaw(dir,args){return execFileSync('git',['--no-optional-locks','-C',dir,...args],{maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});}
function git(dir, args) { return execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }).trimEnd(); }
function snapshot(dir) { return { head: git(dir, ['rev-parse', 'HEAD']), tree: git(dir, ['rev-parse', 'HEAD^{tree}']), dirty: git(dir, ['status', '--porcelain=v1', '--untracked-files=all']), merging: fs.existsSync(git(dir, ['rev-parse', '--absolute-git-dir']) + '/MERGE_HEAD') }; }
function ancestor(dir, a, b) { try { git(dir, ['merge-base', '--is-ancestor', a, b]); return true; } catch (e) { if (e.status === 1) return false; throw e; } }
const { identity, sameIdentity } = require('./idea-directory-identity');
function inside(base, file) { const r = path.relative(base, file); return !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); }
module.exports = { canonical, bytes, hash, clone, uuid, fail, check, opId, strictRead, json, git, gitRaw, snapshot, ancestor, identity, sameIdentity, inside };
