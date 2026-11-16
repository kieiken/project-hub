'use strict';
// A full Mac app supplies the new native owner handshake. A runtime-only
// download cannot supply it. Retain the old journal for diagnosis, but do not
// select its old runtime or pending confirmation beneath the new native shell.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {newer} = require('../lib/app-update-packaged');
const generation = 3;
function selectLaunch(api, store, origin, options) {
  if ((options.platform || process.platform) === 'darwin') {
    const base = path.dirname(origin), manifest = options.verifyPackage(base, 'darwin');
    assert.equal(manifest.macShellGeneration, generation, 'mac_shell_generation');
    assert.equal(manifest.platform, 'darwin');
    assert.equal(manifest.arch, 'arm64');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(base, 'release-manifest.json'))).digest('hex'), options.originSha, 'mac_bootstrap_changed');
    let fullApp = false;
    try { store.access(data => {
      if (data.macShellGeneration === generation) {
        // A verified full app can supersede an unapplied runtime. Retain its
        // signed evidence instead of trying to apply an equal/older version
        // forever. Never take over a selected or unconfirmed downloaded runtime.
        if (!data.current && !data.pendingConfirm && data.prepared &&
            /^\d+\.\d+\.\d+$/.test(data.prepared.version) &&
            /^\d+\.\d+\.\d+$/.test(manifest.releaseVersion) &&
            !newer(data.prepared.version, manifest.releaseVersion)) {
          // This runtime will never be selected. Failed revalidation is evidence
          // to retain, not a reason to prevent the verified full app from opening.
          fullApp = true;
          let verified = true, reason = '';
          try {
            assert.equal(data.prepared.envelope?.payload, data.envelope?.payload, 'mac_prepared_envelope');
            assert.equal(data.prepared.envelope?.sig, data.envelope?.sig, 'mac_prepared_envelope');
            api.validate(store, data.prepared, options.trust || require('./update-trust.cjs'),
              {now: options.now, pending: true, verifyPackage: options.verifyPackage});
          } catch (e) { verified = false; reason = String(e.code === 'ERR_ASSERTION' ? e.message.split('\n')[0] : e.code || e.message).slice(0, 300); }
          if (data.supersededPrepared !== undefined && !Array.isArray(data.supersededPrepared)) {
            // Preserve malformed history too, including any earlier quarantine.
            data.invalidSupersededPrepared = {history: data.supersededPrepared,
              ...(data.invalidSupersededPrepared === undefined ? {} : {previous: data.invalidSupersededPrepared})};
            data.supersededPrepared = [];
            verified = false; reason = [reason, 'mac_prepared_history'].filter(Boolean).join('; ');
          }
          data.supersededPrepared = [...(data.supersededPrepared || []),
            {bootstrap: origin, version: manifest.releaseVersion, prepared: data.prepared, verified, ...(reason ? {reason} : {})}];
          delete data.prepared;
          if (['ready', 'deferred'].includes(data.phase)) { data.phase = 'idle'; data.reason = ''; }
          // No selected/pending runtime exists here. Adopt the full app in this
          // same atomic write, rather than requiring a second selector write.
          if (data.previous?.runtime === data.origin && !data.previous.envelope) data.previous.runtime = origin;
          data.origin = origin; data.originSha = options.originSha;
          // Do not reset failure deadlines, rejected assets, sequence or trust.
          assert.ok(Buffer.byteLength(JSON.stringify({value: data, revision: 0})) <= 250 * 1024, 'mac_migration_journal_size');
          return data;
        }
        return;
      }
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
    }); } catch (e) {
      // A storage failure in this archive-only branch must not strand the full
      // app. The old journal remains as-is if the atomic write failed. Never use
      // this fallback for selected/pending runtimes or unverified bootstraps.
      if (!fullApp) throw e;
    }
    if (fullApp) return {runtime: origin, token: ''};
  }
  return api.selectLaunch(store, origin, options);
}
module.exports = {selectLaunch, generation};
