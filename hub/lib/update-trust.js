'use strict';
// Release-time constants. Never load these from settings, feeds or environment.
// The owner may explicitly reuse an existing Ed25519 identity. Unconfigured fails closed.
module.exports = Object.freeze({
  feedUrl: 'https://github.com/kieiken/project-hub/releases/latest/download/project-hub-update.json',
  windowsFeedUrl: 'https://github.com/kieiken/project-hub/releases/latest/download/project-hub-update-windows.json',
  assetPrefix: 'https://github.com/kieiken/project-hub/releases/download/',
  // Measured on GitHub's official cli/cli release. Verify our first asset before activation.
  redirectHosts: Object.freeze(['release-assets.githubusercontent.com']),
  keys: Object.freeze({
    'hub-ed25519--esZsIozabMh900UWuzuk3BpFihKVTuUWHMNhgVFw3s': Object.freeze({
      alg: 'ed25519',
      spkiB64: 'MCowBQYDK2VwAyEAy+P+rfdhiWHpbYDgKhyAdVpwQk7v6fqI9o/NefIbBfw=',
      purposes: Object.freeze(['app-update']),
    }),
  }),
  // Future Secure Enclave keys register alg: 'p256-sha256' with their SPKI.
  // No placeholder kid is trusted. Creation/registration requires owner approval.
  revokedKids: Object.freeze([]),
});
