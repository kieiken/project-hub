'use strict';
// A full Mac app supplies the new native owner handshake. A runtime-only
// download cannot supply it. Retain the old journal for diagnosis, but do not
// select its old runtime or pending confirmation beneath the new native shell.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const generation = 3;
function selectLaunch(api, store, origin, options) {
  if ((options.platform || process.platform) === 'darwin') {
    const base = path.dirname(origin), manifest = options.verifyPackage(base, 'darwin');
    assert.equal(manifest.macShellGeneration, generation, 'mac_shell_generation');
    assert.equal(manifest.platform, 'darwin');
    assert.equal(manifest.arch, 'arm64');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(base, 'release-manifest.json'))).digest('hex'), options.originSha, 'mac_bootstrap_changed');
    store.access(data => {
      if (data.macShellGeneration === generation) return;
      assert.ok(data.macShellGeneration === undefined || data.macShellGeneration === 1 || data.macShellGeneration === 2, 'mac_shell_generation');
      // Only the update-selection journal changes. License, selected workspace,
      // user data, downloaded versions and old full apps remain in place.
      const next = {
        origin, originSha: options.originSha, macShellGeneration: generation,
        enabled: data.enabled === true, phase: 'idle',
        ...(Number.isSafeInteger(data.maxSeq) && data.maxSeq >= 0 ? {maxSeq: data.maxSeq} : {}),
        legacyRuntimeMigration: { version: manifest.releaseVersion, previous: data }
      };
      assert.ok(Buffer.byteLength(JSON.stringify({value: next, revision: 0})) <= 250 * 1024, 'mac_migration_journal_size');
      return next;
    });
  }
  return api.selectLaunch(store, origin, options);
}
module.exports = {selectLaunch, generation};
