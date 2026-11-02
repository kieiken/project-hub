'use strict';

module.exports = function createLimitEngine(ctx) {
  const { getTerminalLimits, accountFor, getAccounts, getAiTools, getAppUpdate, assertWorkspaceIdle, getBuildHandoffCard, getCaptureTerminalLimit, getChat, getChats, codexFastFor, crypto, getDiscussion, discussionRuntime, expandHome, extensions, fs, getGitSnapshot, integrationPolicyRequest, launch, license, getLimitEvidence, lt, modelError, getModelView, path, permCmd, record, getRestartControl, roleReviewRuntime, rolesData, getSessions, setUnread, getStopControl, getStore, taskPrompt, getTranscript, getUsage, verifyIntegrationAssignmentSend } = ctx;

  const limitSwitchPolicy=extensions.create('limit_switch',{license:Object.freeze({require:features=>license.require(features)}),rolesData,modelView:Object.freeze({special:()=>(getModelView()).special()}),discussionRuntime,integrationPolicyRequest,store:Object.freeze({readProject:project=>(getStore()).readProject(project)}),accountFor,permCmd,capacityOptions});

  function limitModels() {
    const out = { claude: [...require('../model-limits').MODELS.claude], codex: [...require('../model-limits').MODELS.codex] };
    for (const r of rolesData().roles) for (const slot of [r.main, r.backup]) {
      const ai = slot.ai === 'claude-code' ? 'claude' : slot.ai, flag = launch.flagFor(ai, slot.model);
      if (out[ai] && flag && !out[ai].includes(flag)) out[ai].push(flag);
    }
    return out;
  }

  function roleReviewLimit(request) {
    return roleReviewRuntime.heldLimit ? roleReviewRuntime.heldLimit(request, (getLimitEvidence())) : (getLimitEvidence()).forRequest(request);
  }

  // Opaque, request-scoped receipt: an early read is never a new routing decision.
  const earlyCreditChecks = new WeakMap();
  function startCreditCheck(request) {
    const policy = rolesData(), control = getStopControl?.();
    if (request.ai !== 'codex' || policy.preferCredits !== true || !policy.checkCredits.codex ||
        integrationPolicyRequest(request) || roleReviewRuntime.isRequest?.(request.request) ||
        discussionRuntime.isRequest(request.request) || control?.held(request)) return;
    if (getLimitEvidence().active(request.account || 'default', launch.flagFor(request.ai, request.model))?.source !== 'usage-100') return;
    const receipt = {}, account = request.account || 'default';
    // Attach both handlers immediately: a rejected handoff/validation can abandon
    // the receipt while the read finishes, without an unhandled rejection.
    const result = Promise.resolve().then(() => getUsage().checkCredits(request.ai, account, { fresh: true }))
      .then(result => ({ result }), error => ({ error }));
    earlyCreditChecks.set(receipt, { project: request.project, task: request.task, ai: request.ai, account, result });
    return receipt;
  }

  async function refreshLimitEvidence(request, earlyCreditCheck) {
    verifyIntegrationAssignmentSend(request);
    if (discussionRuntime.isRequest(request.request)) { (getDiscussion()).verify(request); return; }
    if (!['claude', 'codex'].includes(request.ai)) return;
    const checks = new Map(), usage = getUsage(), control = getStopControl?.(), ticket = control?.ticket(request);
    const check = async o => {
      if (!rolesData().checkCredits[o.ai]) return;
      const account = o.account || 'default', key = o.ai + ':' + account;
      if (!checks.has(key)) {
        const early = earlyCreditCheck && earlyCreditChecks.get(earlyCreditCheck);
        if (early && early.project === o.project && early.task === o.task && early.ai === o.ai && early.account === account) {
          const settled = await early.result;
          if (settled.error) throw settled.error;
          checks.set(key, { request: o, result: settled.result, early: true,
            rechecked: settled.result?.acquisition !== 'cached' && getLimitEvidence().creditDecision(o).reason === 'available' });
        } else checks.set(key, { request: o, result: await usage.checkCredits(o.ai, account) });
      }
    };
    const refreshReused = async () => {
      if (integrationPolicyRequest(request) || roleReviewRuntime.isRequest?.(request.request)) return;
      for (const entry of checks.values()) {
        const o = entry.request;
        if (rolesData().preferCredits !== true || control?.held(request) || control?.changed(request, ticket)) continue;
        const limits = getLimitEvidence(), decision = limits.creditDecision(o);
        // Refresh even an available reused proof: adoption/admission awaits
        // after this preflight must not consume the old proof's remaining time.
        // An early result that is already stale or only shared a cache gets
        // the same one replacement as a reused proof. Failed/slow reads do not.
        if (!entry.rechecked && (entry.early || entry.result?.acquisition === 'cached') && ['available','not-fresh','not-checked','before-limit','checking'].includes(decision.reason)) {
          entry.rechecked = true;
          entry.replaced = true;
          entry.result = await usage.checkCredits(o.ai, o.account || 'default', { fresh: true });
        }
      }
    };
    if (rolesData().checkCredits[request.ai]) await check(request);
    if (checks.size) await refreshReused();
    if (integrationPolicyRequest(request)) {
      if (!(getLimitEvidence()).active(request.account || 'default',launch.flagFor(request.ai,request.model))) await usage.status(false,{[request.ai]:request.account || 'default'}, { only: { ai: request.ai, account: request.account || 'default' } });
      return;
    }
    if (!limitRoutingEnabled()) return;
    const target = roleReviewLimit(request) ? limitBackup(request) : request;
    if (target && ['claude', 'codex'].includes(target.ai)) {
      if (target !== request && rolesData().checkCredits[target.ai]) await check(target);
      if (checks.size) await refreshReused();
      if (!roleReviewLimit({ ...request, ...target })) {
        await usage.status(false, { [target.ai]: target.account || 'default' }, { only: { ai: target.ai, account: target.account || 'default' } });
      }
    }
    // The last authentication/status await can age a reused proof past 30s.
    if (checks.size) await refreshReused();
    for (const { request: o, result } of checks.values()) {
      if (rolesData().preferCredits === true) record('credit-priority-check', o, { ...(getLimitEvidence()).creditDecision(o),
        acquisition: result.acquisition, model: launch.flagFor(o.ai, o.model), account: o.account || 'default' });
    }
    const entry = checks.get(request.ai + ':' + (request.account || 'default'));
    if (!entry?.early) return;
    // The callback only starts a replacement read. Its caller must discard the
    // old synchronous scan permit and acquire a NEW one after awaiting it.
    const identity = o => JSON.stringify([o.project, o.task, o.ai, o.account || 'default', launch.flagFor(o.ai, o.model)]);
    const original = identity(request);
    return o => {
      if (identity(o) !== original || entry.replaced || entry.result?.acquisition === 'cached' ||
          rolesData().preferCredits !== true || !rolesData().checkCredits[o.ai] ||
          control?.held(request) || control?.changed(request, ticket) ||
          getLimitEvidence().creditDecision(o).reason !== 'not-fresh') return;
      entry.replaced = true; // Reserve before await; never a third lookup.
      return usage.checkCredits(o.ai, o.account || 'default', { fresh: true }).then(result => {
        entry.result = result;
        record('credit-priority-check', o, { ...getLimitEvidence().creditDecision(o),
          acquisition: result.acquisition, model: launch.flagFor(o.ai, o.model), account: o.account || 'default' });
      });
    };
  }

  function limitRoutingEnabled() { return limitSwitchPolicy.enabled(); }

function capacityOptions() {
  return { models: (getAiTools()).catalog().codex?.models || [], available: (models, account) =>
    (getUsage()).subscriptionAvailable(models, account) && !models.some(model => (getLimitEvidence()).active(account, model, true)) };
}
async function capacityBackup(o) {
  const account = o.account || 'default';
  if (accountFor(o.project, o.task, 'codex') !== account ||
      !limitSwitchPolicy.backup(o, 'capacity', { ...capacityOptions(), available: () => true })) return null;
  // Fixed contract-status request only, after the failed CLI has exited. A long
  // turn's old cache must not be mistaken for remaining subscription quota.
  await (getUsage()).status(true, { codex: account }, { only: { ai: 'codex', account } });
  return limitBackup(o, 'capacity');
}
function assertCapacityHandoff(o) {
  const link = o.limitSwitch;
  if (link?.reason !== 'capacity') return;
  const account = o.account || 'default';
  const source = { ...o, ai: link.sourceAI, model: link.sourceModel, effort: link.sourceEffort, limitSwitch: null };
  const options = capacityOptions(), target = limitSwitchPolicy.backup(source, 'capacity', options);
  const current = launch.flagFor(o.ai, o.model), row = options.models.find(m => m.id === current);
  if (o.ai !== 'codex' || account !== (link.sourceAccount || 'default') ||
      accountFor(o.project, o.task, 'codex') !== account || target?.requiredModel !== current ||
      o.requiredModel !== current || Array.isArray(row?.efforts) && !row.efforts.includes(o.effort)) {
    throw Error('モデル混雑の自動再開条件（契約枠の残量・同じアカウント・最新のSol／Astra候補）を確認できないため、待機します');
  }
}

  function limitBackup(o, reason) { return limitSwitchPolicy.backup(o, reason); }

  function terminalLimitNotice(o, text) {
    const p = (getStore()).readProject(o.project); if (!p) return;
    const row = (getChat()).append(p.dir, o.task, { role: 'event', ai: o.ai, text });
    (getChats()).emit(o.project, o.task, { type: 'row', row }); setUnread(o.project, o.task, true);
    record('terminal-limit', o, { text });
  }

  function terminalPendingFile(p, t) { return path.join(p.dir, '.ai', 'handoff', `${t.id}-limit.json`); }

  function terminalPending(p, t) {
    try { const data = JSON.parse(fs.readFileSync(terminalPendingFile(p, t), 'utf8')); return data.pending && data.task === t.id ? data : null; } catch { return null; }
  }

  function saveTerminalPending(p, t, data) {
    const file = terminalPendingFile(p, t); fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file);
  }

  function terminalBusy(p, t, exceptAI) {
    return (getSessions()).list().some(r => r.running && r.project === p.id && r.task === t.id && r.ai !== exceptAI) || (getChats()).busy(p.id, t.id);
  }

  async function terminalLimitHandoff(o, src) {
    const stopTicket=(getStopControl()).ticket(o);if((getStopControl()).held(o))return;
    const p = (getStore()).readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
    if (!p || !t || t.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
    if (!src.exited || src.stopped) return;
    let backup = limitBackup(o); if (!backup) return;
    const file = (getStore()).taskFile(p.id, t.id), board = path.join(p.dir, '.ai', 'board.md');
    const from = `${launch.AI_LABEL[o.ai]}・${launch.modelLabel(o.ai, o.model)}`;
    const original = src.original || src.prompt || '';
    const packetFile = path.join(p.dir, '.ai', 'handoff', `${t.id}-limit-${src.started}.md`);
    const convo = (getTranscript()).collect({ ai: o.ai, dir: src.dir, since: src.started, buf: src.buf, accountDir: (getAccounts()).location(o.ai, src.account), source: src.limitWatch?.file });
    const pending = { pending: true, task: t.id, packet: packetFile, dir: src.dir, original, sourceAI: o.ai, sourceModel: o.model, role: o.role, from };
    const savePacket = () => {
      pending.to = `${launch.AI_LABEL[backup.ai]}・${backup.model}`;
      const card = (getBuildHandoffCard())({ original, user: { head: src.head, status: src.status }, rows: [], dir: src.dir, pdir: p.dir, task: t.id, from, to: pending.to });
      fs.mkdirSync(path.dirname(packetFile), { recursive: true });
      fs.writeFileSync(packetFile, card + '\n\n' + (getTranscript()).packet({ fromLabel: from, toLabel: pending.to, taskFile: file, board, convo, extra: lt('済んだ手順・変更・送信済み委任を繰り返さず、残りを続ける。操作記録も確認する。') }));
      saveTerminalPending(p, t, pending); // 起動失敗/両方上限でも資料と続きを残す。
    };
    savePacket();
    await refreshLimitEvidence({...o,...backup});
    if (src.stopped || (getStopControl()).held(o) || (getStopControl()).changed(o,stopTicket)) return;
    const latest = limitBackup(o); if (!latest) return;
    if (JSON.stringify(latest) !== JSON.stringify(backup)) { backup = latest; savePacket(); await refreshLimitEvidence({...o,...backup}); }
    if (JSON.stringify(limitBackup(o)) !== JSON.stringify(backup)) throw Error(lt('交代先の設定が変更されたため、資料を保存して待機します'));
    if (src.stopped || (getStopControl()).held(o) || (getStopControl()).changed(o,stopTicket)) return;
    if ((getAppUpdate()).applying()) throw Error((getAppUpdate()).busyMessage());
    if ((getAiTools()).isOperating(backup.ai)) throw Error(lt('AI の更新・モデル再取得が進行中です'));
    const current = (getStore()).readProject(p.id)?.tasks.find(t => t.id === o.task);
    if (!current || current.state === '完了') throw Error(lt('作業が見つからないか完了したため、交代先を開始していません'));
    if ((getLimitEvidence()).forRequest(backup)) throw Error(lt('引き継ぎ先も上限中のため待機します。資料を保存しました。解除後にターミナルで再開してください'));
    if (terminalBusy(p, t)) throw Error(lt('同じ作業で別のAIが動いているため、資料を保存して待機します'));
    assertWorkspaceIdle(p, t, false);
    if (!fs.existsSync(src.dir) || expandHome(current.workdir) && !(getTranscript()).same(expandHome(current.workdir), src.dir)) throw Error(lt('作業場所が変わったため、交代先を開始していません'));
    const invalid = modelError(backup.ai, backup.model); if (invalid) throw Error(invalid);
    (getAccounts()).available(backup.ai, backup.account, { forWork: true });
    const limitMarker = crypto.randomUUID();
    const prompt = lt`利用上限による交代です。引き継ぎ資料 ${packetFile} を読み、実物を確かめて残りを続けてください。` + '\n' + taskPrompt(p, t, file, src.dir, 'terminal', backup) + `\n[Hub terminal: ${limitMarker}]`;
    const argv = launch.buildArgv({ ...backup, prompt, cmd: permCmd(backup.ai), fast: codexFastFor(p.id, t.id) });
    const next = (getSessions()).start({ project: p.id, task: t.id, dir: src.dir, ...backup, ...(getGitSnapshot())(src.dir), prompt, limitMarker, command: argv.command, args: argv.args });
    next.original = original;
    saveTerminalPending(p, t, { ...pending, pending: false });
    terminalLimitNotice(o, lt`${from} の終了を確認し、同じターミナル作業を ${pending.to} で続けます`);
  }

  function installTerminal() {
  (getSessions()).prepare = o => ['claude', 'codex'].includes(o.ai) ? (getCaptureTerminalLimit())(o.ai, (getAccounts()).location(o.ai, o.account), o.limitMarker) : null;
  const terminalLimits = new (getTerminalLimits())({ sessions: (getSessions()), limits: (getLimitEvidence()), enabled: () => limitRoutingEnabled(),
    backup: limitBackup, handoff: terminalLimitHandoff, refresh: refreshLimitEvidence, notify: terminalLimitNotice });
  (getSessions()).onExit = (project, task, ai, s) => {
    if (!s?.stopped && !(s?.watchers.size > 0)) setUnread(project, task, true);
    void terminalLimits.check(project, task, ai, s, true).catch(e => terminalLimitNotice({ project, task, ai }, e.message));
  };
  const terminalLimitTimer = setInterval(() => { if((getRestartControl())?.committed)return; void terminalLimits.tick().catch(e => record('terminal-limit-error', {}, { error: e.message })); }, 2000);
  terminalLimitTimer.unref();
  return { terminalLimits, terminalLimitTimer };
  }

  return { startCreditCheck, capacityBackup, assertCapacityHandoff, limitModels, roleReviewLimit, refreshLimitEvidence, limitRoutingEnabled, limitBackup, terminalLimitNotice, terminalPendingFile, terminalPending, saveTerminalPending, terminalBusy, terminalLimitHandoff, installTerminal };
};
