'use strict';
// Only pinned, byte-identical code with an approved publisher and notarization
// can lose quarantine. No recursive xattr, Homebrew bypass, or CLI execution.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { lt } = require('./locale');
const PUBLISHERS = Object.freeze({ claude: Object.freeze({ team: 'Q6L2SF6YDW', identifier: 'com.anthropic.claude-code' }) });
const ATTRIBUTE = 'com.apple.quarantine';
// QTN_FLAG_USER_APPROVED in Apple's WebKit QuarantineSPI.h. This metadata
// permits ordinary OS-controlled launch, never automatic quarantine removal.
const USER_APPROVED = 0x0040;
function confirmation(reason) {
  const message = lt`Mac の確認が必要：${lt(reason)}` + ' ' + lt`Mac で Claude Code を開いて内容を確認し、許可したあとにもう一度操作してください。`;
  return Object.assign(new Error(message), { status: 409, stage: 'mac-confirmation', reason: message });
}
function allowed(file, home) {
  const brew = ['/opt/homebrew', '/usr/local'].some(prefix => {
    const base = prefix + '/Caskroom/claude-code@latest/';
    return file.startsWith(base) && /^[^/]+\/claude$/.test(file.slice(base.length));
  });
  const native = path.join(home, '.local/share/claude/versions') + path.sep;
  const legacy = path.join(home, '.claude/local') + path.sep;
  return brew || file.startsWith(native) && /^[^/]+$/.test(file.slice(native.length)) || file.startsWith(legacy);
}
function stamp(st, ctime = true) {
  return ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', ...(ctime ? ['ctimeNs'] : [])].map(k => String(st[k])).join(':');
}
function hashFd(fd) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  for (let pos = 0, n; (n = fs.readSync(fd, buffer, 0, buffer.length, pos)); pos += n) hash.update(buffer.subarray(0, n));
  return hash.digest('hex');
}
function createCliTrust({ platform = process.platform, home = os.homedir(), run = spawnSync, temporary = os.tmpdir() } = {}) {
  return function ensure(ai, file) {
    // No other publisher is currently established. Leave every other tool alone.
    const publisher = PUBLISHERS[ai];
    if (platform !== 'darwin' || !publisher || !file) return file;
    let real, fd, dir, staged;
    const call = (tool, args, reason) => {
      const r = run(tool, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', fd] });
      if (r.error || r.status !== 0) throw confirmation(reason);
      return String(r.stdout || '') + String(r.stderr || '');
    };
    try {
      real = fs.realpathSync(file);
      fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const initial = fs.fstatSync(fd, { bigint: true });
      if (!initial.isFile()) throw confirmation('実行ファイルの実体を確認できません');
      const attrs = () => call('/usr/bin/xattr', ['/dev/fd/3'], 'Mac の確認情報を読めません').trim().split(/\r?\n/);
      if (!attrs().includes(ATTRIBUTE)) return file;
      if (!allowed(real, home)) throw confirmation('想定した導入先ではありません');
      const unchanged = (ctime = true) => {
        if (fs.realpathSync(file) !== real || fs.realpathSync(real) !== real ||
            stamp(fs.statSync(real, { bigint: true }), ctime) !== stamp(initial, ctime) ||
            stamp(fs.fstatSync(fd, { bigint: true }), ctime) !== stamp(initial, ctime)) throw confirmation('確認中に実行ファイルが変わりました');
      };
      unchanged();
      const quarantine = call('/usr/bin/xattr', ['-p', ATTRIBUTE, '/dev/fd/3'], 'Mac の確認情報を読めません');
      const flags = quarantine.trim().split(';')[0];
      if (/^[0-9a-f]{4}$/i.test(flags) && (parseInt(flags, 16) & USER_APPROVED)) {
        unchanged();
        // Respect the existing approval without modifying any attributes.
        // macOS still controls execution; this is not publisher verification.
        return real;
      }
      // codesign/spctl do not accept /dev/fd paths on macOS. Verify a private
      // snapshot copied FROM the pinned descriptor, then bind its bytes back
      // to that descriptor. xattr deletion itself uses only the inherited FD.
      dir = fs.mkdtempSync(path.join(temporary, 'hub-cli-trust-'));
      fs.chmodSync(dir, 0o700);
      staged = path.join(dir, 'claude');
      const out = fs.openSync(staged, 'wx', 0o700);
      try {
        const buf = Buffer.alloc(1024 * 1024);
        for (let pos = 0, n; (n = fs.readSync(fd, buf, 0, buf.length, pos)); pos += n) {
          for (let offset = 0; offset < n;) offset += fs.writeSync(out, buf, offset, n - offset);
        }
        fs.fsyncSync(out);
      } finally { fs.closeSync(out); }
      const snapshotHash = () => { const check = fs.openSync(staged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { return hashFd(check); } finally { fs.closeSync(check); } };
      const digest = snapshotHash();
      unchanged();
      const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${publisher.team}" and identifier "${publisher.identifier}"`;
      call('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', requirement, staged], '署名の厳密な検証に合格しませんでした');
      const identity = call('/usr/bin/codesign', ['--display', '--verbose=4', staged], '署名の発行元を確認できません');
      if (!identity.split(/\r?\n/).includes('TeamIdentifier=' + publisher.team) ||
          !identity.split(/\r?\n/).includes('Identifier=' + publisher.identifier)) throw confirmation('署名のチームまたは識別子が一致しません');
      const assessment = call('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--ignore-cache', '--no-cache', '--verbose=2', staged], 'Apple の公証を確認できません');
      if (!assessment.split(/\r?\n/).includes('source=Notarized Developer ID') ||
          !assessment.split(/\r?\n/).some(line => line === staged + ': accepted')) throw confirmation('Apple の公証を確認できません');
      unchanged();
      if (hashFd(fd) !== digest || snapshotHash() !== digest) throw confirmation('確認中に実行ファイルが変わりました');
      unchanged();
      call('/usr/bin/xattr', ['-d', ATTRIBUTE, '/dev/fd/3'], 'Mac の確認情報を更新できません');
      if (attrs().includes(ATTRIBUTE)) throw confirmation('Mac の確認情報を更新できません');
      unchanged(false); // removing an xattr legitimately changes ctime
      if (hashFd(fd) !== digest) throw confirmation('確認中に実行ファイルが変わりました');
      return real;
    } catch (e) {
      if (e.stage === 'mac-confirmation') throw e;
      throw confirmation('実行ファイルの実体を確認できません');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (staged) try { fs.unlinkSync(staged); } catch { /* only our snapshot */ }
      if (dir) try { fs.rmdirSync(dir); } catch { /* never recurse into an unexpected entry */ }
    }
  };
}
const ensureCliReady = createCliTrust();
module.exports = { createCliTrust, ensureCliReady, PUBLISHERS };
