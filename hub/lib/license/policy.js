'use strict';
const { createPublicKey } = require('node:crypto');
// 4系列の固定名。版を上げても変えない（公開済み4.123.11との互換性）。
const SERIES_PRODUCT = 'project-hub-4.123';
// Build constants, never loaded from user settings or environment variables.
const policy = Object.freeze({
  SERIES_PRODUCT,
  licenseEnforcement: true,
  endpoint: 'https://project-hub-license.kieiyellow.workers.dev',
  trialCampaign: 'returning-users-20261103',
  trialDays: 30, // Owner selected 30 days. Set the issuer's TRIAL_DAYS to 30 before distribution.
  // Release candidate only: enable the live issuer separately before publishing this build.
  // The stable issuer entry keeps changeable Stripe Links outside the distributed App.
  purchaseUrl: 'https://project-hub-license.kieiyellow.workers.dev/buy',
  trustedKeys: Object.freeze({
    'hub-ed25519--esZsIozabMh900UWuzuk3BpFihKVTuUWHMNhgVFw3s': Object.freeze({
      publicKey: createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAy+P+rfdhiWHpbYDgKhyAdVpwQk7v6fqI9o/NefIbBfw=', 'base64'), format: 'der', type: 'spki' }),
      purposes: Object.freeze(['proof', 'time']),
    }),
  }),
  build: Object.freeze({ channel: 'release', buildId: 'project-hub-4.125.0-mac-arm64', product: SERIES_PRODUCT, bugfixOf: Object.freeze([]) }),
});
// The Windows release candidate uses the same issuer as Mac. Live deployment
// and build registration still require separate production acceptance.
const WINDOWS_ISSUER_ENABLED = true; // Approved candidate setting, not proof of live acceptance.
const windowsPolicy = Object.freeze({ ...policy, endpoint: WINDOWS_ISSUER_ENABLED ? policy.endpoint : '', purchaseUrl: WINDOWS_ISSUER_ENABLED ? policy.purchaseUrl : '',
  build: Object.freeze({ ...policy.build, buildId: 'project-hub-4.125.0-windows-x64' }) });
module.exports = Object.freeze({ ...policy, forPlatform: name => name === 'win32' ? windowsPolicy : policy });
