'use strict';
const launch = require('./launch');
const { lt } = require('./locale');
const CLAUDE_ULTRA_MAX_PERCENT = 70;
const USAGE_FRESH_MS = 60_000;
const cli = ai => ai === 'claude-code' ? 'claude' : ai;

// Only an explicit per-request override is gated. Human-saved role values are
// deliberately outside this policy, including saved Ultra values.
function resolve(o, { data, catalog, limits, usage, now = Date.now(), accountFor = () => o.account || 'default' }) {
  const explicit = o.delegationEffort ? o.delegationEffort.requested : o.effort;
  if (o.delegationEffort?.source === 'fallback') return o;
  const role = data.roles.find(r => r.name === o.role) || data.roles.find(r =>
    cli(r.main.ai) === o.ai && launch.flagFor(o.ai, r.main.model) === launch.flagFor(o.ai, o.model));
  const saved = role?.main.effort || '';
  const overridden = typeof explicit === 'string' && explicit !== '';
  let effort = overridden ? explicit : o.effort;
  let workflow = false;
  let source = overridden && !(o.role && explicit === saved) ? 'override' : 'role', note = '';
  if (explicit === 'Ultra') {
    const entry = catalog?.codex?.models?.find(m => m.id === launch.flagFor(o.ai, o.model));
    // An existing-credit exception can permit a start while the limit hold
    // remains recorded. It must not also permit an automatic Ultra upgrade.
    const heldFor = request => {
      const model = launch.flagFor(request.ai, request.model);
      return !!model && (limits?.active?.(request.account || 'default', model) || limits?.forRequest?.(request));
    };
    const held = o.limitSwitch || heldFor(o) || role && [role.main, role.backup].filter(Boolean).some(s =>
      heldFor({ ...o, ai: cli(s.ai), model: s.model, account: accountFor(cli(s.ai)) }));
    const commander = data.roles.find(r => r.name === '司令塔')?.main;
    const orchestrator = o.role === '司令塔' || commander && cli(commander.ai) === o.ai &&
      launch.flagFor(o.ai, commander.model) === launch.flagFor(o.ai, o.model);
    const reason = data.allowDelegateUltra !== true ? lt('自動Ultraが許可されていません')
      : !['codex', 'claude'].includes(o.ai) || o.ai === 'codex' && !entry?.efforts?.includes('Ultra') ? lt('指定機種は自動Ultraの対象外です')
      : o.ai === 'claude' && orchestrator ? lt('司令塔宛てには自動Ultraを付けません')
      : held ? lt('利用上限の交代を保持しています')
      : o.ai === 'claude' ? usageReason(o, usage, now) : '';
    if (reason) {
      // A limit handoff already selected the saved backup effort. Preserve it.
      effort = o.limitSwitch ? o.effort : saved;
      source = 'fallback';
      note = lt`Ultraの指定を適用せず、保存値（${effort || lt('CLIの既定')}）で受け付けました：${reason}。`;
    } else if (o.ai === 'claude') {
      effort = '極高';
      workflow = true;
    }
  }
  effort = launch.normalizeEffort(o.ai, o.ai === 'agy' ? '高' : effort);
  return { ...o, effort, delegationEffort: { requested: explicit || '', source, note, ...(o.ai === 'claude' ? { workflow } : {}) } };
}
// Only fresh formal windows for the selected account can grant a workflow.
function usageReason(o, snapshot, now) {
  const p = snapshot?.providers?.claude, at = Date.parse(p?.fetchedAt);
  const windows = ['five_hour', 'seven_day'].map(id => p?.windows?.find(w => w.id === id));
  if (o.delegationUsageFailed || p?.account !== (o.account || 'default') || p?.status !== 'ok' || !Number.isFinite(at) ||
      now < at || now - at > USAGE_FRESH_MS || windows.some(w => !Number.isFinite(w?.usedPercent) || w.usedPercent < 0))
    return lt('Claude Codeの利用状況が不明・古い・取得失敗です');
  return windows.some(w => w.usedPercent >= CLAUDE_ULTRA_MAX_PERCENT)
    ? lt('Claude Codeの5時間枠または7日枠の使用率が安全基準以上です') : '';
}
async function refreshUsage(o, usage) {
  if (o.origin !== 'delegate' || o.ai !== 'claude' || o.automation ||
      o.delegationEffort?.requested !== 'Ultra' || o.delegationEffort.source === 'fallback') return;
  const account = o.account || 'default';
  o.delegationUsageFailed = !usage?.status;
  try { await usage?.status(true, { claude: account }, { only: { ai: 'claude', account } }); }
  catch { o.delegationUsageFailed = true; }
}
function readUsage(usage, account) {
  try { return usage?.snapshot({claude:account || 'default'}); } catch { return undefined; }
}
module.exports = { resolve, refreshUsage, readUsage, CLAUDE_ULTRA_MAX_PERCENT, USAGE_FRESH_MS };
