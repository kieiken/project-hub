'use strict';
// No CLI, credentials or network: the real Usage scope/cache with controlled reads.
const { Usage } = require('../../lib/usage');
const launch = require('../../lib/launch');
const createEngine = require('../../lib/engines/limit-switch');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture({ factory = createEngine, credits = {}, held = () => false, backup = null,
  integration = false, routing = true, requestedDelay = 0, otherDelay = 0, authDelay = 0,
  failRequested = false, accounts = true } = {}) {
  const request = { ai: 'codex', account: 'work', model: 'GPT-6.1-Sol', project: 'p', task: 't' };
  const reads = [], auth = [], checks = [], scopes = [];
  const selected = backup || request;
  const wanted = r => r.ai === selected.ai && r.account === (selected.account || 'default');
  const rows = ['codex', 'claude'].flatMap(ai => ['default', 'work'].map(id => ({ ai, id })));
  const usage = new Usage({ find: ai => ai,
    ...(accounts ? { accounts: { list: () => rows, status: async (ai, account) => {
      auth.push({ ai, account });
      if (!wanted({ ai, account })) await wait(authDelay);
      return { status: 'logged-in' };
    } } } : {}),
    read: async (ai, file, { account }) => {
      const r = { ai, account }; reads.push(r);
      await wait(wanted(r) ? requestedDelay : otherDelay);
      if (failRequested && wanted(r)) throw Error('fixture unavailable');
      return ai === 'codex'
        ? { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, credits: { hasCredits: true, balance: '5' } } }
        : { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } };
    } });
  const status = usage.status.bind(usage), checkCredits = usage.checkCredits.bind(usage);
  usage.status = (...args) => { scopes.push(args); return status(...args); };
  usage.checkCredits = (ai, account) => { checks.push({ ai, account }); return checkCredits(ai, account); };
  const engine = factory({
    extensions: { create: () => ({ enabled: () => routing, backup: () => backup }) },
    launch, rolesData: () => ({ checkCredits: credits }),
    verifyIntegrationAssignmentSend() {}, discussionRuntime: { isRequest: () => false },
    roleReviewRuntime: { heldLimit: held }, integrationPolicyRequest: () => integration,
    getLimitEvidence: () => ({ active: (_account, _model) => held(request) }),
    getUsage: () => usage,
  });
  return { engine, usage, request, reads, auth, checks, scopes };
}
module.exports = { fixture, wait };
