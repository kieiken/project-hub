'use strict';

module.exports = function terminalstartRoutes(ctx) {
  const { DRY, accountFor, accounts, aiTools, codexFastFor, crypto, fs, gitSnapshot, launch, license, licenseGuard, limitBackup, limitEvidence, limitIdentity, lt, modelError, modelView, path, permCmd, pickSpec, record, refreshLimitEvidence, requestAccount, getRestartControl, rolesData, saveTerminalPending, send, sessions, startDir, store, taskPrompt, terminalBusy, terminalPending, transcript } = ctx;

  async function handleStart(req, res, url, b) {
      try { void license.prepare(); licenseGuard(b, 'accept'); }
      catch (e) { return send(res, e.status || 403, { error: e.message, code: e.code }); }
      const p = store.readProject(b.project);
      const file = store.taskFile(b.project, b.task);
      if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
      const t = store.readTask(file);
      let ai = b.ai, spec = pickSpec(t, ai), account = requestAccount(p, t.id, ai, b.account);
      if (ai === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(ai, b.model);
      let o = { project: p.id, task: t.id, ai, ...spec, role: t.role, account };
      o = { ...o, ...limitIdentity(rolesData(), o) };
      await refreshLimitEvidence(o);
      const held = limitEvidence.forRequest(o), backup = held && limitBackup(o);
      if (held && modelView.special().enabled) return send(res, 409, { error: lt('特殊モードのAIが上限中です。解除後に再開してください') });
      let switchNote = '';
      if (backup) {
        await refreshLimitEvidence({...o,...backup});
        if (limitEvidence.forRequest(backup)) return send(res, 409, { error: lt('両方の担当が上限中です。解除後に再開してください') });
        switchNote = lt`上限保持中のため ${launch.AI_LABEL[backup.ai]}・${backup.model} で開始`;
        o = { ...o, ...backup }; ai = o.ai; spec = o; account = o.account;
      }
      if (aiTools.isOperating(ai) || (getRestartControl())?.committed) return send(res,409,{error:lt('AI の更新・モデル再取得が進行中です')});
      const invalidModel = modelError(ai, spec.model, account);
      if (invalidModel) return send(res, 409, { error: invalidModel });
      if (sessions.list().some(r => r.project === p.id && r.task === t.id && sessions.get(r.project, r.task, r.ai)?.limitTransition && !sessions.get(r.project, r.task, r.ai)?.limitTransitionDone)) return send(res, 409, { error: lt('上限による交代の準備中です') });
      const cur = sessions.get(p.id, t.id, ai);
      if (backup && terminalBusy(p, t, ai)) return send(res, 409, { error: lt('元AIまたは別のAIが作業中です。終了を待ってください') });
      const pending = terminalPending(p, t);
      const { dir, note } = cur && !cur.exited ? { dir: cur.dir } : startDir(p, t);
      if (pending && !transcript.same(pending.dir, dir)) return send(res, 409, { error: lt('引き継ぎ資料の作業場所が変わっています') });
      const limitMarker = crypto.randomUUID();
      const prompt = (pending ? lt`上限で中断した続きです。引き継ぎ資料 ${pending.packet} を読み、済んだ部分を繰り返さず残りを続けてください。\n` : '') + taskPrompt(p, t, file, dir, 'terminal', { ai, model: spec.model }) + `\n[Hub terminal: ${limitMarker}]`;
      const argv = launch.buildArgv({ ai, prompt, cmd: permCmd(ai), model: spec.model, effort: spec.effort, account, fast: codexFastFor(p.id, t.id) });
      if (DRY) return send(res, 200, { ok: true, dry: true, ai, dir, model: spec.model, effort: spec.effort, account, ...argv, accountEnv: account === 'default' ? {} : { [ai === 'grok' ? 'GROK_HOME' : ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: accounts.get(ai, account).dir } });
      try {
        const started = !(cur && !cur.exited);
        const session = sessions.start({ project: p.id, task: t.id, ai, ...gitSnapshot(dir), dir, account, model: spec.model, effort: spec.effort, role: t.role, limitSlot: o.limitSlot, prompt, limitMarker, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows });
        if (pending && started) { session.original = pending.original; saveTerminalPending(p, t, { ...pending, pending: false }); }
        record('start', { ...b, ai }, { model: spec.model, effort: spec.effort, dir });
        return send(res, 200, { ok: true, ai, dir, note: [switchNote, note].filter(Boolean).join('。'), model: session.model, effort: session.effort, running: !session.exited });
      } catch (e) {
        return send(res, e.status || 500, { error: String(e.message || e) });
      }
    }

  async function handleHandoff(req, res, url, b) {
      const p = store.readProject(b.project);
      const file = store.taskFile(b.project, b.task);
      if (!p || !file || !launch.AIS.includes(b.to)) return send(res, 400, { error: lt('作業が見つかりません') });
      const t = store.readTask(file);
      const from = b.from || (b.to === 'claude' ? 'codex' : b.to === 'codex' ? 'claude' : '');
      if (!launch.AIS.includes(from) || from === b.to) return send(res, 400, { error: lt('交代元を指定してください') });
      const LABEL = launch.AI_LABEL;
      let spec = pickSpec(t, b.to), account = requestAccount(p, t.id, b.to, b.account);
      if (b.to === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(b.to, b.model);
      let target = { project: p.id, task: t.id, ai: b.to, ...spec, role: t.role, account };
      target = { ...target, ...limitIdentity(rolesData(), target) };
      await refreshLimitEvidence(target);
      const alternate = limitEvidence.forRequest(target) && limitBackup(target);
      if (limitEvidence.forRequest(target) && modelView.special().enabled) return send(res, 409, { error: lt('特殊モードのAIが上限中です。解除後に再開してください') });
      if (alternate) {
        await refreshLimitEvidence(alternate);
        if (limitEvidence.forRequest(alternate)) return send(res, 409, { error: lt('両方の担当が上限中です。解除後に再開してください') });
        // 元AIに戻すことで稼働中の同じ作業へ割り込まない。
        if (alternate.ai === from) return send(res, 409, { error: lt('交代先が上限中です。元AIからの交代は行いません') });
        b.to = alternate.ai; target = { ...target, ...alternate }; spec = target; account = target.account;
      }
      const tgt = sessions.get(b.project, b.task, b.to);
      const tgtLive = tgt && !tgt.exited;
      if (tgtLive && (tgt.account || 'default') !== account) return send(res, 409, { error: lt('交代先は別のアカウントで作業中です') });
      if (!tgtLive) {
        const invalidModel = modelError(b.to, spec.model, account);
        if (invalidModel) return send(res, 409, { error: invalidModel });
      }
      if (tgtLive && Date.now() - tgt.lastOut < 20000) return send(res, 409, { error: lt`${LABEL[b.to]} が作業中です。止まってから（入力待ちになってから）交代してください` });
      const src = sessions.get(b.project, b.task, from);
      const { dir } = tgtLive ? { dir: tgt.dir } : startDir(p, t);
      const convo = transcript.collect({ ai: from, dir: (src && src.dir) || dir, since: src ? src.started : Date.now() - 3 * 86400000, buf: src && src.buf, accountDir: accounts.location(from, src?.account || accountFor(p.id, t.id, from)) });
      const board = path.join(p.dir, '.ai', 'board.md');
      const note = b.note ? String(b.note).replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
      const hdir = path.join(p.dir, '.ai', 'handoff');
      fs.mkdirSync(hdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const packetFile = path.join(hdir, `${t.id}-${stamp}-${from}.md`);
      fs.writeFileSync(packetFile, transcript.packet({ fromLabel: LABEL[from], toLabel: LABEL[b.to], taskFile: file, board, convo, extra: note }));
      const msg = lt`${LABEL[from]} から交代です。引き継ぎ資料 ${packetFile} を読み、${file} と ${board} も確かめてから、あなたの役割で続けてください。`;
      let started = false;
      if (tgtLive) {
        sessions.type(b.project, b.task, b.to, msg);
      } else {
        const limitMarker = crypto.randomUUID(), prompt = msg + ' ' + taskPrompt(p, t, file, dir, 'terminal', { ai: b.to, model: spec.model }) + `\n[Hub terminal: ${limitMarker}]`;
        const argv = launch.buildArgv({ ai: b.to, prompt, cmd: permCmd(b.to), model: spec.model, effort: spec.effort, account, fast: codexFastFor(p.id, t.id) });
        if (DRY) return send(res, 200, { ok: true, dry: true, ai: b.to, packet: packetFile, kind: convo.kind, ...argv });
        try { sessions.start({ project: b.project, task: b.task, ai: b.to, dir, account, model: spec.model, effort: spec.effort, role: t.role, limitSlot: target.limitSlot, prompt, limitMarker, ...gitSnapshot(dir), command: argv.command, args: argv.args, cols: b.cols, rows: b.rows }); started = true; }
        catch (e) { return send(res, 500, { error: String(e.message || e), packet: packetFile }); }
      }
      store.updateTask(p.id, t.id, { owner: launch.AI_KEY[b.to], memo: lt`${LABEL[from]} から ${LABEL[b.to]} へ交代（引き継ぎ資料: ${packetFile}）` });
      record('handoff', b, { packet: packetFile, kind: convo.kind, started });
      return send(res, 200, { ok: true, ai: b.to, packet: packetFile, kind: convo.kind, started, ...(tgtLive ? {} : { model: spec.model, effort: spec.effort }) });
    }

  async function handleContinue(req, res, url, b) {
      licenseGuard(b,'start');
      const p = store.readProject(b.project);
      const file = store.taskFile(b.project, b.task);
      if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: lt('作業が見つかりません') });
      const t = store.readTask(file);
      const spec = pickSpec(t, b.ai);
      if (b.ai === 'agy' && typeof b.model === 'string') spec.model = launch.modelLabel(b.ai, b.model);
      const account = requestAccount(p, t.id, b.ai, b.account);
      const invalidModel = modelError(b.ai, spec.model, account);
      if (invalidModel) return send(res, 409, { error: invalidModel });
      if (!DRY && b.ai === 'claude') {
        const argv = launch.buildArgv({ ai: b.ai, cmd: permCmd(b.ai) });
        launch.resolveCli(argv.command, argv.args, process.env, b.ai);
      }
      const { dir } = startDir(p, t);
      const command = launch.buildCommand({ ai: b.ai, dir, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model: spec.model }), cmd: permCmd(b.ai), ...spec, account, fast: codexFastFor(p.id, t.id) });
      const terminal = accounts.terminalCommand(b.ai, account, command, launch.sq);
      let r; try { r = await launch.openTerminal(terminal.command, DRY); } catch (e) { terminal.cancel(); throw e; }
      return send(res, 200, { ok: true, dir, ...(DRY ? { command, r } : {}) });
    }

  return {
    start: { matches: (req, url) => url.pathname === '/api/term/start', handle: handleStart },
    handoff: { matches: (req, url) => url.pathname === '/api/term/handoff', handle: handleHandoff },
    continue: { matches: (req, url) => url.pathname === '/api/continue', handle: handleContinue },
  };
};
