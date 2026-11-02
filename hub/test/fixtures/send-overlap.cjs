'use strict';
// Real route, Usage, ModelLimits and ChatRunner; disk scans and CLI are isolated fakes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRequire } = require('node:module'), vm = require('node:vm');
const { Usage } = require('../../lib/usage'), { ModelLimits } = require('../../lib/model-limits');
const { ChatRunner, append } = require('../../lib/chat');
const launch = require('../../lib/launch'), createEngine = require('../../lib/engines/limit-switch');
const routePath = path.resolve(__dirname, '../../lib/routes/chat-send.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, { scanDelay = 0, queryDelay = 0, routeSource } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-send-overlap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 0, epoch = 0, held = false;
  const now = () => Date.parse('2026-11-02T00:00:00Z') + clock, reads = [], scans = [], launches = [], logs = [], checks = [];
  const task = { id: 't', role: 'code', state: '実行中', question: '' }, p = { id: 'p', dir };
  const policy = { preferCredits: true, checkCredits: { codex: true }, roles: [] };
  const options = { project: 'p', task: 't', ai: 'codex', account: 'work', model: 'GPT-6.1-Sol' };
  const control = { data: { errors: [] }, ticket: () => ({ epoch, task: 0 }), held: () => held, changed: (_r, ticket) => ticket.epoch !== epoch,
    assert: (_r, ticket) => { if (held || ticket?.epoch !== epoch) throw Error('stopped'); } };
  const state = { mode: 'ok', scanError: false, onRead: null, onScan: null };
  const usage = new Usage({ now, find: ai => ai, read: async (ai, _file, { account }) => {
    reads.push({ ai, account, at: performance.now() });
    await state.onRead?.(ai, account); await wait(queryDelay);
    if (state.mode === 'error') throw Error('fixture read failed');
    return ai === 'codex' ? { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 },
      credits: { hasCredits: true, balance: state.mode === 'empty' ? '0' : '7' } } }
      : { subscription_type: 'max', rate_limits: { five_hour: { utilization: 20 } } };
  } });
  const checkCredits = usage.checkCredits.bind(usage);
  usage.checkCredits = (...args) => { checks.push(args); return checkCredits(...args); };
  const limits = new ModelLimits(path.join(dir, 'limits.json'), { now, creditPolicy: () => policy,
    creditState: (ai, account) => usage.creditState(ai, account) });
  usage.observe = snapshot => limits.observe(snapshot);
  limits.observe({ accountProviders: [{ ai: 'codex', account: 'work', status: 'ok', windows: [{ id: 'codex:primary', usedPercent: 100, resetsAt: null }],
    fetchedAt: new Date(now()).toISOString(), attemptedAt: new Date(now()).toISOString() }] });
  const backup = () => ({ ai: 'claude', account: 'default', model: 'Opus 5.5', requiredModel: 'claude-opus-5-5' });
  const engine = createEngine({ extensions: { create: () => ({ enabled: () => true, backup }) }, launch,
    rolesData: () => policy, verifyIntegrationAssignmentSend() {}, discussionRuntime: { isRequest: () => false },
    roleReviewRuntime: { heldLimit: r => limits.forRequest(r), isRequest: () => false }, integrationPolicyRequest: () => false,
    getLimitEvidence: () => limits, getUsage: () => usage, getStopControl: () => control,
    record: (action, _o, fields) => logs.push({ action, ...fields }) });
  const runner = new ChatRunner({ limitPreflight: r => limits.forRequest(r), limitTarget: r => limits.forRequest(r), limitBackup: backup, stopControl: control });
  runner.spoolRoot = dir;
  runner.handoffAdmission = { async scan() { scans.push(performance.now()); await state.onScan?.(scans.length); await wait(scanDelay);
    if (state.scanError) throw Error('fixture handoff failed'); return { dirs: [], errors: state.saveErrors || [] }; } };
  runner.run = r => { launches.push({ ...r, at: performance.now() }); append(dir, 't', { role: 'assistant', ai: r.ai, model: r.model, text: 'done' }); return { startedP: Promise.resolve(true) }; };
  const context = { ...engine, chats: runner, stopControl: control, launch, fs, queueActions: new Set(),
    reqCtx: { getStore: () => ({ stopSnapshot: { epoch, tasks: {} } }) },
    getDiscussion: () => ({ active: () => false }), extensions: { state: () => ({ included: [] }) },
    license: { prepare() {} }, licenseGuard() {}, removalReview: { read: () => null },
    store: { readProject: () => p, taskFile: () => 'fixture', readTask: () => ({ ...task }), updateTask: (_p, _t, fields) => Object.assign(task, fields) },
    pickSpec: () => ({ model: 'GPT-6.1-Sol', effort: '高' }), requestAccount: (_p, _t, _ai, account) => account || 'work',
    modelError: () => null, startDir: () => ({ dir }), roles: { EFFORTS: ['高'] }, rolesData: () => policy,
    queueEdit: { accept: () => undefined }, taskPrompt: () => '', modelPolicy: () => '', permCmd: () => '',
    specialMode: { pick: () => null }, modelView: { special: () => null }, record() {}, chatEnded() {},
    lt: (value, ...args) => Array.isArray(value) ? String.raw({ raw: value }, ...args) : value,
    send: (_res, status, body) => ({ status, ...body }) };
  let createRoute;
  if (routeSource) {
    const module = { exports: {} };
    vm.runInNewContext(routeSource, { module, exports: module.exports, require: createRequire(routePath) }, { filename: routePath });
    createRoute = module.exports;
  } else createRoute = require(routePath);
  const route = createRoute(context).send;
  return { engine, usage, limits, runner, state, options, policy, reads, scans, launches, logs, checks,
    advance(ms) { clock += ms; }, stop() { held = true; epoch++; },
    send: body => route.handle({}, {}, new URL('http://fixture/api/chat/send'), { ...options, text: 'fixture request', ...body }) };
}
module.exports = { fixture, wait };
