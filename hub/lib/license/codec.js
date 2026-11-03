'use strict';
const c = require('node:crypto');
const DAY = 86400, MAX_TERM = 30 * DAY;
const PAID = Object.freeze(['delegate', 'queue_auto', 'limit_switch', 'webchat', 'parallel']);
const FEATURES = Object.freeze({ chat_basic: false, ...Object.fromEntries(PAID.map(f => [f, true])) });
const int = n => Number.isSafeInteger(n) && n >= 0;
function decode(s, length) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length > 16384) throw Error('format');
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s || length && b.length !== length) throw Error('format');
  return b;
}
function fingerprint(key) {
  const k = (key?.type === 'public' ? key : c.createPublicKey(key)).export({ format: 'jwk' });
  if (k.crv !== 'Ed25519') throw Error('device_key');
  return c.createHash('sha256').update(Buffer.from(k.x, 'base64url')).digest('base64url');
}
function verifyEnvelope(envelope, keys, purpose) {
  if (!envelope || typeof envelope.kid !== 'string' || !Object.hasOwn(keys, envelope.kid)) throw Error('unknown_key');
  const key = keys[envelope.kid];
  if (!key.purposes?.includes(purpose)) throw Error('key_purpose');
  const bytes = decode(envelope.payload), sig = decode(envelope.sig, 64);
  if (!c.verify(null, bytes, key.publicKey, sig)) throw Error('signature');
  return JSON.parse(bytes.toString('utf8'));
}
function signEnvelope(payload, privateKey, kid) {
  const b = Buffer.from(JSON.stringify(payload));
  return { kid, payload: b.toString('base64url'), sig: c.sign(null, b, privateKey).toString('base64url') };
}
function validateProof(p) {
  if (p?.trialCampaign !== undefined && (p.kind !== 'trial' || !/^[a-z0-9-]{1,80}$/.test(p.trialCampaign))) throw Error('format');
  if (!p || p.v !== 1 || p.typ === 'time' || typeof p.ent !== 'string' || !p.ent || !/^[A-Za-z0-9_-]{43}$/.test(p.dev) ||
      !['trial', 'course_trial', 'course_benefit', 'beta', 'purchase'].includes(p.kind) ||
      !Array.isArray(p.features) || !p.features.length || p.features.some(f => !PAID.includes(f)) || new Set(p.features).size !== p.features.length ||
      ![p.iat, p.nbf, p.entStartsAt, p.seq].every(int) || p.seq < 1 ||
      p.entStartsAt > p.nbf || p.nbf < p.iat - 300 || p.nbf > p.iat + 300 || !p.scope) throw Error('format');
  if (p.kind === 'purchase') {
    if (p.exp !== null || p.scope.channel !== 'release' || typeof p.scope.product !== 'string' || !p.scope.product ||
        !Array.isArray(p.scope.bugfixOf) || p.scope.bugfixOf.some(x => typeof x !== 'string')) throw Error('format');
  } else {
    const beta = p.scope.channel === 'beta';
    if ((!beta && (p.kind !== 'trial' || p.scope.channel !== 'release' || typeof p.scope.product !== 'string' || !p.scope.product ||
          !Array.isArray(p.scope.bugfixOf) || p.scope.bugfixOf.some(x => typeof x !== 'string'))) ||
        (beta && (typeof p.scope.buildId !== 'string' || !p.scope.buildId || !int(p.betaExpiresAt) || p.exp > p.betaExpiresAt)) ||
        ![p.exp, p.entEndsAt].every(int) || p.exp <= p.nbf || p.exp - p.iat > MAX_TERM ||
        p.exp > p.entEndsAt ||
        p.globalEndAt != null && (!int(p.globalEndAt) || p.exp > p.globalEndAt)) throw Error('format');
  }
  return p;
}
function scopeMatches(scope, build) {
  if (scope.channel !== build.channel) return false;
  if (scope.channel === 'beta') return scope.buildId === build.buildId;
  return scope.product === build.product || (build.bugfixOf || []).includes(scope.product);
}
function evaluate({ proofs = [], keys, device, build, clock }) {
  const grants = [], invalid = [];
  for (const envelope of proofs) {
    try {
      const p = validateProof(verifyEnvelope(envelope, keys, 'proof'));
      if (!device?.ok || p.dev !== device.dev) throw Error('device');
      if (!scopeMatches(p.scope, build)) throw Error('scope');
      if (p.kind === 'purchase') grants.push({ p, state: 'purchased', expiry: null });
      else {
        const expiry = Math.min(p.exp, p.entEndsAt, p.betaExpiresAt ?? Infinity, p.globalEndAt ?? Infinity);
        if (clock.t < p.nbf || clock.t >= expiry) continue; // Expiry precedes held.
        const held = clock.mode !== 'T' && (!clock.valid || clock.wall < clock.lastSeenAt - 300 ||
          clock.lastSeenAt < p.iat || clock.uptimeSinceAnchor > MAX_TERM);
        grants.push({ p, state: held ? 'held' : p.kind, expiry });
      }
    } catch (e) { invalid.push(e.message); }
  }
  const features = { chat_basic: { allowed: true, state: 'free', expiry: null } };
  for (const f of PAID) {
    const matching = grants.filter(g => g.p.features.includes(f));
    const purchase = matching.find(g => g.state === 'purchased');
    const short = matching.filter(g => g.state !== 'held' && g.state !== 'purchased').sort((a, b) => b.expiry - a.expiry)[0];
    const g = purchase || short || matching.find(g => g.state === 'held');
    features[f] = { allowed: Boolean(g && g.state !== 'held'), state: g?.state || 'free', expiry: g?.expiry ?? null };
  }
  return { features, invalid, updateScope: { purchaseProducts: [...new Set(grants.filter(g => g.state === 'purchased').map(g => g.p.scope.product))], hasShortTerm: grants.some(g => !['purchased', 'held'].includes(g.state)) } };
}
module.exports = { PAID, FEATURES, DAY, MAX_TERM, int, decode, fingerprint, verifyEnvelope, signEnvelope, validateProof, scopeMatches, evaluate };
