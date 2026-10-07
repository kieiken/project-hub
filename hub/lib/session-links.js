'use strict';
// Only references are persisted. Source discovery and history are always read only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const MAX_LINKS = 2000, MAX_SELECTED = 200, MAX_MANIFEST = 2 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9-]{36}$/i;
const WORDS = {
  selection: ['リンクする会話を選び直してください', '請重新選取要連結的會話'],
  stale: ['元の記録またはリンク一覧が変わりました。もう一度確認してください', '原始記錄或連結清單已變更，請重新預覽'],
  confirm: ['確認したリンクだけを保存するには confirm=true が必要です', '必須 confirm=true 才能保存已預覽的連結'],
  guard: ['Storage Guard がリンクの保存を止めました。元の記録は変更していません', 'Storage Guard 已停止保存連結，原始記錄保持不變'],
  busy: ['別のリンク操作が進行中です', '另一個連結操作正在執行'],
  unsafe: ['リンクの保存先または一覧を安全に読めません', '無法安全讀取連結儲存位置或清單'],
  limit: ['記録の量が読み取り上限を超えています。選ぶ会話を減らしてください', '記錄超過讀取上限，請減少選取的會話'],
  format: ['元の会話記録を安全に読めません', '無法安全讀取原始會話記錄'],
  missing: ['元の会話を読めません。リンクは削除していません', '無法讀取原始會話；連結仍會保留'],
  history: ['元の会話履歴が見つかりません。リンクだけを保持します', '找不到來源會話的歷史記錄；只保留連結'],
};
const KNOWN = {
  'Codex history root is unavailable': ['Codex の履歴保存先を読めません', '無法讀取 Codex 歷史儲存位置'],
  'Codex SQLite metadata root is unavailable; using session index/headers': ['Codex の索引保存先を読めないため、会話の一覧・先頭情報を使います', '無法讀取 Codex 索引儲存位置，改用會話清單及檔案開頭資訊'],
  'SQLite has pending journal data; using bounded session index/header metadata instead': ['Codex の索引に書き込み待ちの記録があるため、会話の一覧・先頭情報を使います', 'Codex 索引尚有待寫入記錄，改用會話清單及檔案開頭資訊'],
  'Some Codex transcript paths are missing or outside permitted history roots': ['一部の Codex 履歴は見つからないか、許可された保存先の外にあります', '部分 Codex 歷史記錄缺失或位於允許儲存位置之外'],
  'Codex SQLite metadata could not be read safely; using session index/headers': ['Codex の索引を安全に読めないため、会話の一覧・先頭情報を使います', '無法安全讀取 Codex 索引，改用會話清單及檔案開頭資訊'],
  'Some Codex index metadata is invalid': ['一部の Codex 索引情報の形式が違います', '部分 Codex 索引資訊格式不正確'],
  'Linked Codex history entries were skipped': ['リンクされた Codex 履歴は読み取り対象から外しました', '已略過使用符號連結的 Codex 歷史項目'],
  'Some Codex session headers could not be read safely': ['一部の Codex 会話の先頭情報を安全に読めませんでした', '無法安全讀取部分 Codex 會話的檔案開頭資訊'],
  'Codex source changed during discovery; discover again': ['一覧の読み取り中に Codex の記録が変わりました。もう一度確認してください', '讀取清單期間 Codex 記錄已變更，請重新整理'],
  'Codex metadata discovery reached its reading limit; the list is incomplete': ['Codex の一覧が読み取り上限に達しました。表示は一部だけです', 'Codex 清單已達讀取上限，目前只顯示部分項目'],
  'Some Codex metadata could not be read safely': ['一部の Codex 会話情報を安全に読めませんでした', '無法安全讀取部分 Codex 會話資訊'],
  'Only legacy events were found; this adapter retains canonical response messages only': ['古い形式の記録だけが見つかりました。この表示は通常の会話メッセージだけを読みます', '只找到舊格式事件，此畫面僅讀取標準會話訊息'],
  'The native provider CLI is not installed or is not on PATH.': ['AI の CLI が未インストールか PATH にありません', 'AI CLI 尚未安裝或不在 PATH 中'],
  'The native provider could not start.': ['AI の CLI を開始できませんでした', '無法啟動 AI CLI'],
  'The native provider ended before completing the turn.': ['返事が終わる前に AI の CLI が終了しました', 'AI CLI 在回覆完成前已結束'],
  'The provider rejected the turn.': ['AI がこの送信を受け付けませんでした', 'AI 未接受這次送出'],
  'The native turn did not complete.': ['AI の返事が完了しませんでした', 'AI 回覆未完成'],
};
const RUNNER = {
  input: ['リンクした会話を選び、メッセージを入力してください', '請選取已連結的會話並輸入訊息'],
  busy: ['この会話または同じ場所で AI が作業中です。終わってから送ってください', '這份會話或同一位置的 AI 正在作業，請等待完成後再送出'],
  source: ['元の会話が変わったか読めません。更新してから続けてください', '原始會話已變更或無法讀取，請重新整理後再繼續'],
  guard: ['Storage Guard が送信を止めました。メッセージは送っていません', 'Storage Guard 已停止操作，尚未送出訊息'],
  unsupported: ['この会話は元の AI の正式な継続機能で再開できません', '無法透過原 AI 的正式續接功能繼續這份會話'],
  mismatch: ['AI が別の会話 ID を返したため、この送信を止めました', 'AI 回傳另一個會話 ID，已停止這次送出'],
  unknown: ['前回の送信結果を確認できません。再送前に元の会話を確認してください', '無法確認上次送出結果，請先查看原始會話再決定是否重新送出'],
  protocol: ['AI の応答形式を確認できないため、この送信を止めました', '無法確認 AI 回應格式，已停止這次送出'],
  limit: ['AI の出力が上限を超えたため、この送信を止めました', 'AI 輸出超過上限，已停止這次送出'],
  stopped: ['この送信を止めました', '已停止這次送出'],
  unverified: ['AI は終了しましたが、元の履歴が更新されたか確認できません', 'AI 已結束，但無法確認原始歷史記錄是否已更新'],
};
class SessionLinks {
  constructor(options) {
    this.root = path.resolve(options.root); this.env = { ...process.env, ...(options.env || {}) };
    this.language = options.language || (this.env.HUB_LANG === 'zh-TW' ? 'zh-TW' : 'ja');
    this.sources = options.sources; this.now = options.now || Date.now; this.rename = options.rename || fs.renameSync;
    this.sourceLocks = new Map(); this.tokens = new Map(); this.running = false; this.salt = crypto.randomBytes(24).toString('hex');
    try { const stat = fs.statSync(this.root); this.rootIdentity = [fs.realpathSync(this.root), stat.dev, stat.ino].join(':'); } catch { this.rootIdentity = ''; }
    this.guard = options.guard || (() => new Promise(resolve => {
      if (!this.env.HUB_STORAGE_GUARD) return resolve(true);
      execFile(this.env.HUB_STORAGE_GUARD, [], { env: this.env, timeout: 10000 }, (error, stdout) => resolve(!error && String(stdout).includes('STATUS=OK')));
    }));
  }
  known(value) { return KNOWN[value] ? KNOWN[value][this.language === 'zh-TW' ? 1 : 0] : value; }
  runnerMessage(code, fallback) { return RUNNER[code] ? RUNNER[code][this.language === 'zh-TW' ? 1 : 0] : this.known(fallback); }
  text(code) { return (WORDS[code] || WORDS.format)[this.language === 'zh-TW' ? 1 : 0]; }
  fail(code, status = 400) { return Object.assign(Error(this.text(code)), { code, status }); }
  error(error) { const code = WORDS[error.code] ? error.code : 'format'; return { code, error: this.text(code) }; }
  destination() {
    try {
      const stat = fs.statSync(this.root), canonical = fs.realpathSync(this.root);
      if (!this.rootIdentity || [canonical, stat.dev, stat.ino].join(':') !== this.rootIdentity) throw this.fail('guard', 409);
      const home = path.join(canonical, '_hub');
      if (fs.existsSync(home) && (fs.lstatSync(home).isSymbolicLink() || !fs.statSync(home).isDirectory())) throw this.fail('unsafe');
      const file = path.join(home, 'session-links.json');
      if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw this.fail('unsafe');
      return { home, file };
    } catch (error) { if (error.status) throw error; throw this.fail('guard', 409); }
  }
  manifest() {
    const { file } = this.destination();
    if (!fs.existsSync(file)) return { schema: 1, links: [], signature: hash('') };
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd); if (stat.size > MAX_MANIFEST) throw this.fail('limit');
      const buffer = Buffer.alloc(stat.size + 1); let bytes = 0, read;
      while (bytes < buffer.length && (read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += read;
      const after = fs.fstatSync(fd); if (bytes > stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw this.fail('stale', 409);
      const raw = buffer.subarray(0, bytes).toString('utf8');
      const value = JSON.parse(raw);
      if (value.schema !== 1 || !Array.isArray(value.links) || value.links.length > MAX_LINKS || new Set(value.links.map(x => x.id)).size !== value.links.length) throw this.fail('unsafe');
      for (const link of value.links) if (!idPattern.test(link.id) || !Object.hasOwn(this.sources, link.provider) || typeof link.sourceId !== 'string' || link.sourceId.length > 200 || typeof link.title !== 'string' || typeof link.groupName !== 'string' || typeof link.identity !== 'string' || link.identity.length > 64) throw this.fail('unsafe');
      return { ...value, signature: hash(raw) };
    } catch (error) { if (error.status) throw error; throw this.fail('unsafe'); } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  async withSource(provider, action) {
    const previous = this.sourceLocks.get(provider) || Promise.resolve();
    let release; const next = new Promise(resolve => { release = resolve; }); this.sourceLocks.set(provider, next);
    await previous;
    try { return await action(this.sources[provider]); }
    finally { release(); if (this.sourceLocks.get(provider) === next) this.sourceLocks.delete(provider); }
  }
  async scan() {
    const lookup = new Map(), groups = new Map(), warnings = []; let supported = false;
    for (const [provider, source] of Object.entries(this.sources)) {
      try {
        const found = await this.withSource(provider, current => current.discover()); supported ||= found.supported === undefined ? source.root !== null : found.supported;
        warnings.push(...(found.warnings || []).map(value => this.known(value)));
        for (const entry of found.sessions || []) {
          if (typeof entry.id !== 'string' || typeof entry.title !== 'string') continue;
          const groupKey = provider + ':' + (entry.projectId || entry.cwd || 'ungrouped');
          if (!groups.has(groupKey)) groups.set(groupKey, { id: hash(groupKey), provider, name: entry.projectName || (entry.cwd ? path.basename(entry.cwd) : provider), sessions: [] });
          const group = groups.get(groupKey), id = hash(this.salt + ':' + provider + ':' + entry.id);
          const publicEntry = { id, provider, title: entry.title, updatedAt: entry.updatedAt || '', hasTranscript: Boolean(entry.hasTranscript), source: entry.source || provider,
            sourceKind: entry.sourceKind || '', originator: entry.originator || '', isSubagent: Boolean(entry.isSubagent), archived: Boolean(entry.archived),
            parentId: entry.parentId ? hash(this.salt + ':' + provider + ':' + entry.parentId) : '' };
          group.sessions.push(publicEntry); lookup.set(id, { ...publicEntry, sourceId: entry.id, identity: entry.identity || '', groupName: group.name, groupId: group.id });
          if (lookup.size > 10000) throw this.fail('limit');
        }
      } catch (error) { warnings.push(this.text(error.code || 'format')); }
    }
    return { projects: [...groups.values()], supported, warnings: [...new Set(warnings)], lookup };
  }
  pair(entry) { return entry.provider + ':' + entry.sourceId; }
  publicLinks(manifest, scanned) {
    const available = new Map([...scanned.lookup.values()].map(entry => [this.pair(entry), entry]));
    return manifest.links.map(link => {
      const current = available.get(this.pair(link)), broken = !current || Boolean(link.identity && link.identity !== current.identity);
      return { id: link.id, provider: link.provider, title: current?.title || link.title, groupName: current?.groupName || link.groupName,
        updatedAt: current?.updatedAt || '', createdAt: link.createdAt, source: current?.source || link.provider, sourceKind: current?.sourceKind || '', originator: current?.originator || '', isSubagent: Boolean(current?.isSubagent), parentId: current?.parentId || '', archived: Boolean(current?.archived), hasTranscript: Boolean(!broken && current?.hasTranscript), broken };
    });
  }
  async inventory() {
    const manifest = this.manifest(), scanned = await this.scan(), linked = new Set(manifest.links.map(link => this.pair(link)));
    for (const [id, entry] of scanned.lookup) entry.linked = linked.has(this.pair(entry));
    for (const group of scanned.projects) for (const session of group.sessions) session.linked = scanned.lookup.get(session.id).linked;
    return { projects: scanned.projects, supported: scanned.supported, warnings: scanned.warnings, links: this.publicLinks(manifest, scanned) };
  }
  async list() { const manifest = this.manifest(); return this.publicLinks(manifest, await this.scan()); }
  async snapshot(entry, budget) {
    if (!entry.hasTranscript) return { fingerprint: hash(JSON.stringify([entry.provider, entry.sourceId, entry.title, entry.identity, entry.updatedAt, entry.groupName])), historySignature: '', messageCount: 0, warnings: [this.text('history')] };
    return this.withSource(entry.provider, async source => {
    const signature = await source.fingerprint(entry.sourceId);
    const fingerprint = typeof signature === 'string' ? signature : signature?.signature;
    if (typeof fingerprint !== 'string') throw this.fail('format');
    const history = await source.read(entry.sourceId, { budget });
    const after = await source.fingerprint(entry.sourceId); if ((typeof after === 'string' ? after : after?.signature) !== fingerprint) throw this.fail('stale', 409);
    return { fingerprint, historySignature: history.signature, messageCount: (history.rows || []).length, warnings: (history.warnings || []).map(value => this.known(value)) };
    });
  }
  async preview(selected) {
    const manifest = this.manifest(), scanned = await this.scan();
    if (!Array.isArray(selected) || !selected.length || selected.length > MAX_SELECTED || new Set(selected).size !== selected.length || selected.some(id => !scanned.lookup.has(id))) throw this.fail('selection');
    const known = new Set(manifest.links.map(entry => this.pair(entry))), entries = [], groups = new Map(), blockers = [], warnings = [...scanned.warnings], budget = { input: 0, text: 0, rows: 0 };
    for (const id of selected) {
      const entry = scanned.lookup.get(id), linked = known.has(this.pair(entry));
      if (!groups.has(entry.groupId)) groups.set(entry.groupId, { name: entry.groupName, provider: entry.provider, sessionCount: 0, messageCount: 0, alreadyLinkedCount: 0, missingHistoryCount: 0 });
      const group = groups.get(entry.groupId); group.sessionCount++; group.alreadyLinkedCount += linked ? 1 : 0; group.missingHistoryCount += entry.hasTranscript ? 0 : 1;
      try { const snapshot = await this.snapshot(entry, budget); entries.push({ ...entry, ...snapshot, linked }); group.messageCount += snapshot.messageCount; warnings.push(...snapshot.warnings); }
      catch (error) { blockers.push(this.text(error.code || 'format')); }
    }
    const token = crypto.randomUUID();
    for (const [id, value] of this.tokens) if (this.now() - value.at > 600000) this.tokens.delete(id);
    if (this.tokens.size >= 8) this.tokens.delete(this.tokens.keys().next().value);
    this.tokens.set(token, { at: this.now(), entries, signature: manifest.signature, blocked: blockers.length > 0 });
    return { token, groups: [...groups.values()], warnings: [...new Set(warnings)], blockers: [...new Set(blockers)] };
  }
  async save(links, expectedSignature, validate) {
    if (!(await this.guard())) throw this.fail('guard', 409);
    if (validate) await validate();
    const current = this.manifest(); if (current.signature !== expectedSignature) throw this.fail('stale', 409);
    if (links.length > MAX_LINKS) throw this.fail('limit');
    const raw = JSON.stringify({ schema: 1, links }, null, 2) + '\n'; if (Buffer.byteLength(raw) > MAX_MANIFEST) throw this.fail('limit');
    const { home, file } = this.destination(); fs.mkdirSync(home, { recursive: true });
    const temporary = path.join(home, '.session-links-' + crypto.randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, raw); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.destination(); if (this.manifest().signature !== expectedSignature) throw this.fail('stale', 409);
      this.rename(temporary, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  async apply(body) {
    if (this.running) throw this.fail('busy', 409);
    if (body?.confirm !== true) throw this.fail('confirm');
    const plan = this.tokens.get(body.token); this.tokens.delete(body.token);
    if (!plan || plan.blocked || this.now() - plan.at > 600000) throw this.fail('stale', 409);
    this.running = true;
    try {
      if (!(await this.guard())) throw this.fail('guard', 409);
      const manifest = this.manifest(); if (manifest.signature !== plan.signature) throw this.fail('stale', 409);
      const scanned = await this.scan(), available = new Map([...scanned.lookup.values()].map(entry => [this.pair(entry), entry])), links = [...manifest.links];
      const budget = { input: 0, text: 0, rows: 0 }; let linkedCount = 0, skippedCount = 0;
      for (const entry of plan.entries) {
        const current = available.get(this.pair(entry)); if (!current || current.identity !== entry.identity) throw this.fail('stale', 409);
        const snapshot = await this.snapshot(current, budget);
        if (snapshot.fingerprint !== entry.fingerprint || snapshot.historySignature !== entry.historySignature) throw this.fail('stale', 409);
        if (links.some(link => this.pair(link) === this.pair(entry))) { skippedCount++; continue; }
        links.push({ id: crypto.randomUUID(), provider: entry.provider, sourceId: entry.sourceId, identity: entry.identity, title: entry.title, groupName: entry.groupName, createdAt: new Date(this.now()).toISOString() }); linkedCount++;
      }
      // Recheck the external volume after potentially long source streams, before any write.
      if (linkedCount) await this.save(links, manifest.signature, async () => {
        const latest = await this.scan(), currentEntries = new Map([...latest.lookup.values()].map(entry => [this.pair(entry), entry]));
        for (const entry of plan.entries) {
          const current = currentEntries.get(this.pair(entry)); if (!current || current.identity !== entry.identity) throw this.fail('stale', 409);
          const fingerprint = current.hasTranscript ? await this.withSource(current.provider, source => source.fingerprint(current.sourceId))
            : hash(JSON.stringify([current.provider, current.sourceId, current.title, current.identity, current.updatedAt, current.groupName]));
          if ((typeof fingerprint === 'string' ? fingerprint : fingerprint?.signature) !== entry.fingerprint) throw this.fail('stale', 409);
        }
      });
      return { links: this.publicLinks({ links }, scanned), linkedCount, skippedCount, warnings: [] };
    } finally { this.running = false; }
  }
  async remove(body) {
    if (body?.confirm !== true) throw this.fail('confirm');
    if (!idPattern.test(String(body.id))) throw this.fail('selection');
    if (this.running) throw this.fail('busy', 409); this.running = true;
    try {
      const manifest = this.manifest(), links = manifest.links.filter(link => link.id !== body.id), removed = links.length !== manifest.links.length;
      if (removed) await this.save(links, manifest.signature);
      return { removed, links: this.publicLinks({ links }, await this.scan()) };
    } finally { this.running = false; }
  }
  find(id) { const link = this.manifest().links.find(entry => entry.id === id); if (!link) throw this.fail('selection', 404); return link; }
  async referenceFor(id) {
    const link = this.find(id), source = this.sources[link.provider];
    await source.discover();
    const scanned = await this.scan(), entry = [...scanned.lookup.values()].find(entry => this.pair(entry) === this.pair(link));
    if (!entry || (link.identity && link.identity !== entry.identity)) throw this.fail('missing', 404);
    return this.withSource(link.provider, async current => {
      await current.discover(); const reference = await current.referenceFor(link.sourceId);
      if (link.identity && reference.identity && reference.identity !== link.identity) throw this.fail('missing', 404);
      return reference;
    });
  }
  async snapshotFor(id) {
    const reference = await this.referenceFor(id), history = await this.history(id);
    if (history.broken) throw this.fail('missing', 404);
    return { reference, signature: reference.signature || reference.fingerprint || '', historySignature: history.signature || '' };
  }
  async history(id) {
    const link = this.find(id), source = this.sources[link.provider];
    try {
      await source.discover();
      const scanned = await this.scan(), entry = [...scanned.lookup.values()].find(entry => this.pair(entry) === this.pair(link));
      if (!entry || (link.identity && link.identity !== entry.identity)) throw this.fail('missing', 404);
      if (!entry.hasTranscript) return { id, provider: link.provider, title: entry.title, messages: [], broken: false, warnings: [this.text('history')] };
      const result = await this.withSource(link.provider, async current => { await current.discover(); return current.read(link.sourceId); });
      return { id, provider: link.provider, title: entry.title, messages: result.rows || [], signature: result.signature, active: result.active ?? null, lifecycle: result.lifecycle, broken: false, warnings: (result.warnings || []).map(value => this.known(value)) };
    } catch (error) { if (['limit', 'stale', 'unsafe'].includes(error.code)) throw error; return { id, provider: link.provider, title: link.title, messages: [], broken: true, warnings: [this.text('missing')] }; }
  }
}
module.exports = { SessionLinks };
