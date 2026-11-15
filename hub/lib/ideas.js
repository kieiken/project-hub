'use strict';
const platform = require('./platform');
const fs = require('./platform/file-io'), path = require('node:path'), os = require('node:os');
const safe = require('./safe-file'), scope = require('./resource-scope');
const U = require('./idea-utils'), projection = require('./idea-projection'), images = require('./idea-images');
const order = require('./idea-order');
const nowISO = clock => new Date(clock()).toISOString();
const CATEGORIES = ['note', 'bug', 'improve', 'feature', 'research'];
function canUnbuild(d, i) { return ['queued', 'blocked'].includes(i.status) && !i.implementation && !Object.values(d.runs).some(r => !r.closed && !['not-sent', 'cancelled'].includes(r.delivery) && r.targets?.some(t => t.itemId === i.id)); }
function category(value) { if (value === 'uncategorized') return 'note'; U.check(CATEGORIES.includes(value), 'category', '種類を選び直してください', 400); return value; }
const itemCategory = i => category(i.category || 'note');
const birth = pid => platform.processBirth(pid);
function initial(uid) {
  return { schema: 2, projectUid: uid, rev: 0, settings: { rev: 1, lane: null, auto: { enabled: false, generation: 1 }, manualPaused: false, stopGeneration: 1, grant: { develop: true, localVerify: true, merge: false, restart: false, network: false }, retryPolicy: { maxRepairRuns: 3, sameFailureNoProgress: 2 }, reviewPolicy: { maxUnreviewedItems: 5 }, testProfile: null }, items: {}, runs: {}, reviews: {}, releases: {}, receipts: {}, evidence: {}, observed: { state: 'idle' } };
}
function validate(d) {
  U.check(d && d.schema === 2 && typeof d.projectUid === 'string' && Number.isSafeInteger(d.rev) && d.rev >= 0, 'schema', '台帳の形式を照合する必要があります', 503);
  for (const k of ['items', 'runs', 'reviews', 'releases', 'receipts', 'evidence']) U.check(d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]), 'schema', '台帳を空の記録へ置換できません', 503);
  U.check(d.settings?.auto && typeof d.settings.manualPaused === 'boolean' && Number.isSafeInteger(d.settings.stopGeneration), 'schema', '台帳の設定を確認してください', 503);
  if (d.images !== undefined) U.check(d.images && typeof d.images === 'object' && !Array.isArray(d.images), 'schema', '画像の台帳を照合してください', 503);
  for (const i of Object.values(d.items)) if (i.images !== undefined) U.check(Array.isArray(i.images) && i.images.length <= images.COUNT && i.images.every(x => x.projectUid === d.projectUid && U.hash(x) === U.hash(d.images?.[x.id])), 'schema', '項目と画像の所属を照合してください', 503);
  return d;
}
class Ideas {
  constructor({ store, root = store.root, controlRoot, clock = Date.now, fault = () => {}, io = fs, atomic = safe, baseOf } = {}) {
    root = scope.canonical(root);
    Object.assign(this, { store, root, clock, fault, io, atomic, baseOf });
    this.owner = { pid: process.pid, birth: birth(process.pid), generation: U.uuid() }; this.locks = new Map();
    const proposed = path.join(root, '_hub');
    this.control = scope.canonical(controlRoot || (scope.commonGit(proposed) ? path.join(os.homedir(), 'Library/Application Support/Project Hub/ideas', U.hash(scope.canonical(root)).slice(0, 24)) : path.join(proposed, 'ideas')));
    this.registryFile = path.join(this.control, 'idea-registry.json');
  }
  outside(dir) { U.check(!scope.commonGit(dir), 'storage-git', 'Gitの外に安全な台帳の保存先が必要です', 503); }
  project(id) { const p = this.store.readProject(id); U.check(p && p.kind !== 'freetalk' && id.toLowerCase() !== 'freetalk', 'project', 'このプロジェクトでは台帳を使えません', 404); return p; }
  lock(file) {
    if (this.locks.has(file)) return;
    this.outside(path.dirname(file)); this.io.mkdirSync(path.dirname(file), { recursive: true });
    let old;
    try { const fd = this.io.openSync(file, 'wx', 0o600); try { this.io.writeFileSync(fd, U.bytes(this.owner)); this.io.fsyncSync(fd); } finally { this.io.closeSync(fd); } this.atomicDirectory(file); this.locks.set(file, true); return; }
    catch (e) { if (e.code !== 'EEXIST') throw e; old = U.json(file, this.io); }
    U.check(old && Number.isSafeInteger(old.pid) && old.birth && old.generation, 'writer', '台帳の保存者の照合を待っています', 503);
    let dead = false;
    try { process.kill(old.pid, 0); const actual = birth(old.pid); dead = Boolean(actual && actual !== old.birth); }
    catch (e) { if (e.code === 'ESRCH') dead = true; }
    U.check(dead, 'writer', '別のHubがこの台帳を保存中です', 503);
    // Preserve the old owner; elapsed time alone is never proof of death.
    this.io.renameSync(file, file + '.retired-' + U.uuid()); this.lock(file);
  }
  unlock(file) { if (!this.locks.has(file)) return; const o = U.json(file, this.io); if (o?.generation === this.owner.generation) { this.io.unlinkSync(file); this.atomicDirectory(file); } this.locks.delete(file); }
  close() { for (const f of [...this.locks.keys()]) this.unlock(f); }
  atomicDirectory(file) { platform.persistence.syncDirectory(path.dirname(file), this.io); }
  readRegistry() {
    try { const r = U.json(this.registryFile, this.io); if (!r) return { schema: 1, projects: {} }; U.check(r.schema === 1 && r.projects && !Array.isArray(r.projects), 'registry', '台帳の保存先を照合中です', 503); return r; }
    catch (e) { throw U.fail('registry', '台帳の保存先を復旧する必要があります：' + e.message, 503, 'unknown'); }
  }
  resolve(id, create = false) {
    const p = this.project(id), real = this.io.realpathSync(p.dir), ident = U.identity(real);
    this.outside(this.control);
    let r = this.readRegistry(), entry = r.projects[id];
    if (!entry && !create) return null;
    if (!entry) {
      const lock = path.join(this.control, 'registry.owner'); this.lock(lock);
      try {
        this.recoverFile(this.registryFile); r = this.readRegistry(); entry = r.projects[id];
        if (!entry) {
          U.check(!Object.values(r.projects).some(e => e.realpath === real), 'registry-alias', '同じ台帳の別名登録を確認してください');
          const uid = U.uuid(), colocated = Boolean(scope.commonGit(real));
          const dir = colocated ? path.join(this.control, 'ledgers', uid) : path.join(real, '.ai');
          this.outside(dir); entry = { projectUid: uid, name: id, realpath: real, identity: ident, dir, colocated };
          r.projects[id] = entry; this.writeFile(this.registryFile, r, U.uuid());
        }
      } finally { this.unlock(lock); }
    }
    U.check(entry.realpath === real && U.sameIdentity(entry.identity, ident), 'project-binding', '台帳の移動を照合してから続けてください');
    this.outside(entry.dir);
    return { ...entry, file: path.join(entry.dir, 'ideas.json'), md: path.join(entry.colocated ? entry.dir : real, 'アイデア帳.md'), controlDir: path.join(this.control, 'projects', entry.projectUid) };
  }
  pending(file) { return path.join(this.control, 'transactions', U.hash(file), 'pending-write.json'); }
  recoverFile(file) {
    const pending = U.json(this.pending(file), this.io); if (!pending) return;
    const current = U.strictRead(file, this.io), candidate = U.strictRead(pending.candidate, this.io), old = U.strictRead(pending.snapshot, this.io);
    U.check(candidate !== null && U.hash(candidate) === pending.newHash && (pending.oldHash === null || old !== null && U.hash(old) === pending.oldHash), 'save-recovery', '保存途中の原文を照合する必要があります', 503);
    if (current !== null && U.hash(current) === pending.newHash) { this.syncFile(file); this.atomicDirectory(file); return; }
    U.check((current === null && pending.oldHash === null) || current !== null && U.hash(current) === pending.oldHash, 'save-recovery', '保存結果が不明です。別の版へ戻しません', 503);
    this.atomic.recoverAtomic(file, candidate); this.syncFile(file); this.atomicDirectory(file);
    U.check(U.hash(this.io.readFileSync(file)) === pending.newHash, 'save-recovery', '保存結果の再照合が必要です', 503);
  }
  syncFile(file) { platform.persistence.syncFile(file, this.io); }
  writeFile(file, value, op) {
    this.outside(path.dirname(file)); this.io.mkdirSync(path.dirname(file), { recursive: true });
    this.recoverFile(file);
    const old = U.strictRead(file, this.io), candidate = U.bytes(value), txdir = path.join(this.control, 'transactions', U.hash(file), op);
    this.io.mkdirSync(txdir, { recursive: true });
    const candidateFile = path.join(txdir, 'candidate.json'), snapshotFile = path.join(txdir, 'previous.json');
    this.atomic.recoverAtomic(candidateFile, candidate); if (old !== null) this.atomic.recoverAtomic(snapshotFile, old);
    this.fault('staging', { file, op });
    const intent = { opId: op, file, oldHash: old === null ? null : U.hash(old), newHash: U.hash(candidate), oldRev: old === null ? null : JSON.parse(old).rev ?? null, newRev: value.rev ?? null, candidate: candidateFile, snapshot: snapshotFile };
    const pf = this.pending(file); this.io.mkdirSync(path.dirname(pf), { recursive: true }); this.atomic.recoverAtomic(pf, U.bytes(intent));
    this.fault('intent', { file, op });
    try {
      this.atomic.recoverAtomic(file, candidate); this.fault('rename', { file, op });
      this.syncFile(file); this.atomicDirectory(file); this.fault('directory-sync', { file, op });
      U.check(U.hash(this.io.readFileSync(file)) === intent.newHash, 'save-unknown', '保存結果を確認中です', 503);
    } catch (e) { throw U.fail('save-unknown', '保存結果を確認してください：' + e.message, 503, 'unknown'); }
    // Cleanup is not part of the acknowledgement boundary. Keep immutable snapshots.
    try { this.fault('cleanup', { file, op }); this.io.unlinkSync(pf); this.atomicDirectory(pf); } catch { /* receipt in the durable canonical file is authoritative */ }
  }
  read(id, { recover = false } = {}) {
    const s = this.resolve(id); if (!s) return initial('uninitialized');
    require('./idea-erase').recover(this, id, s);
    if (recover) { this.lock(path.join(s.controlDir, 'writer.owner')); this.recoverFile(s.file); }
    try {
      const d = U.json(s.file, this.io);
      U.check(d || !U.json(this.pending(s.file), this.io), 'save-unknown', '台帳を復旧中です', 503);
      const value = d ? validate(d) : initial(s.projectUid); order.normalize(value); return value;
    } catch (e) { throw U.fail(e.code || 'storage', '台帳の保存を照合中です：' + e.message, 503, 'unknown'); }
  }
  receipt(id, op) {
    U.opId(op);
    try { const d = this.read(id, { recover: true }); return d.receipts[op] ? { saved: true, receipt: d.receipts[op], ...d.receipts[op].result } : { saved: false, state: 'absent' }; }
    catch (e) { return { saved: 'unknown', state: 'unknown', code: e.code, message: e.message }; }
  }
  mutate(id, op, payload, apply) {
    U.opId(op); const s = this.resolve(id, true); this.lock(path.join(s.controlDir, 'writer.owner'));
    require('./idea-erase').recover(this,id,s);
    this.recoverFile(s.file); const d = this.read(id), bodyHash = U.hash(payload), existing = d.receipts[op];
    if (existing) { U.check(existing.bodyHash === bodyHash, 'op-conflict', '同じ送信識別の内容が変わっています'); return { ...existing.result, receipt: existing, saved: true }; }
    const result = apply(d, s) || {}; d.rev++; validate(d);
    const receipt = { opId: op, bodyHash, ledgerRev: d.rev, at: nowISO(this.clock), result: { ...result, rev: d.rev } };
    d.receipts[op] = receipt;
    const md = U.strictRead(s.md, this.io), canRender = md === null || d.projection?.hash === U.hash(md);
    if (canRender) { const rendered = projection.render(d); d.projection = { hash: U.hash(rendered), rev: d.rev }; }
    else d.projection = { ...d.projection, preserved: true, existingHash: U.hash(md) };
    this.writeFile(s.file, d, op);
    if (canRender) try { this.fault('markdown', { file: s.md }); this.atomic.recoverAtomic(s.md, projection.render(d)); } catch { /* JSON receipt remains saved; UI uses JSON */ }
    return { ...receipt.result, receipt, saved: true };
  }
  initialize(id, op, { importLegacy = false } = {}) {
    return this.mutate(id, op, { kind: 'initialize', importLegacy }, (d, s) => {
      const text = U.strictRead(s.md, this.io); if (!importLegacy || text === null || d.projection?.hash === U.hash(text)) return {};
      const h = U.hash(text); if (d.imports?.[h]) return { imported: 0 };
      const backup = path.join(s.controlDir, 'imports', h + '.md'); this.io.mkdirSync(path.dirname(backup), { recursive: true }); this.atomic.recoverAtomic(backup, text);
      U.check(U.hash(this.io.readFileSync(backup)) === h, 'import-backup', '元のアイデア帳を保全できませんでした', 503);
      const parsed = projection.legacy(text); for (const row of parsed.entries) this.newItem(d, row.text, 'record', { capture: 'legacy', hash: h, line: row.line, historicalDone: row.historicalDone }, op);
      (d.imports ||= {})[h] = { backup, unknown: parsed.unknown, count: parsed.entries.length };
      return { imported: parsed.entries.length };
    });
  }
  newItem(d, text, intent, source, op, attachments = [], itemId = U.uuid()) {
    order.normalize(d);
    const id = itemId, item = { id, rev: 1, contentRev: 1, planRev: 1, controlRev: 1, category: 'note', text, ...(attachments.length ? { images: attachments } : {}), textHash: U.hash(text), intent, status: intent === 'build' ? 'queued' : 'note', grant: null, source: source || { capture: 'none', snapshots: [] }, priority: 'normal', dependencies: [], organized: null, organizationRequested: true, questions: [], acceptance: [], revisionHistory: [], implementation: null, evidence: [], createdAt: nowISO(this.clock) };
    if (intent === 'build') item.grant = this.grant(item, op); d.items[id] = item; d.itemOrder.push(id); d.orderRev++; return item;
  }
  grant(i, op) { return { contentRev: i.contentRev, scopeHash: U.hash(images.grantScope(i)), by: 'human-ui', opId: op, at: nowISO(this.clock) }; }
  add(id, b, { human = false, source } = {}) {
    U.check(['record', 'build'].includes(b.intent || 'record'), 'intent', '保存する方法を確認してください', 400);
    U.check(human || (b.intent || 'record') === 'record', 'permission', 'AIからは記録だけを受け付けます', 403);
    const selectedCategory = category(b.category ?? 'note');
    const text = b.text; U.check(typeof text === 'string' && (text.trim() || b.images?.length), 'text', '残す内容を入力してください', 400);
    U.check(Buffer.byteLength(text) <= (source?.capture === 'verified' ? 8 * 1024 * 1024 : 64 * 1024), 'text-size', '原文が保存できる容量を超えています', 413);
    return this.mutate(id, b.opId, b.operationPayload || { kind: 'add', ...b, project: id }, (d, s) => {
      if (Buffer.byteLength(text) > 64 * 1024) { const h = U.hash(text), file = path.join(s.controlDir, 'blobs', h + '.txt'); this.io.mkdirSync(path.dirname(file), { recursive: true }); this.atomic.recoverAtomic(file, text); source = { ...source, blob: { file, hash: h, bytes: Buffer.byteLength(text) } }; }
      const attachments = images.select(this, id, d, b.images);
      const i = this.newItem(d, text, b.intent || 'record', source, b.opId, attachments); i.category = selectedCategory; if(i.intent==='build')this.stale(d,'作る項目が追加されました'); return { id: i.id, organization: 'pending' };
    });
  }
  update(id, b) {
    return this.mutate(id, b.opId, { kind: 'update', ...b }, d => {
      const i = d.items[b.id]; U.check(i, 'item', '項目が見つかりません', 404);
      U.check(i.contentRev === b.baseContentRev && i.controlRev === b.baseControlRev, 'item-revision', '項目が更新されました。表示を読み直してください');
      const c = b.change; U.check(c && typeof c === 'object' && !Array.isArray(c), 'change', '変更する内容を確認してください', 400);
      const keys = Object.keys(c); U.check(keys.length === 1 && ['category', 'text', 'build', 'priority', 'answer', 'dependencies', 'manualEvidence'].includes(keys[0]), 'change', 'この変更は受け付けられません。画面を更新してください', 400);
      const old = U.clone(i);
      if ('category' in c) i.category = category(c.category);
      if ('text' in c) { const v = typeof c.text === 'string' ? { value: c.text } : c.text; U.check(typeof v?.value === 'string' && (v.value.trim() || i.images?.length) && Buffer.byteLength(v.value) <= 65536, 'text', '原文を確認してください', 400); i.text = v.value; i.textHash = U.hash(i.text); i.contentRev++; i.organized = null; i.organizationRequested = true; i.grant = v.build === true ? this.grant(i, b.opId) : null; i.intent = v.build === true ? 'build' : 'record'; i.status = v.build === true ? 'queued' : 'note'; }
      if ('build' in c) {
        U.check(typeof c.build === 'boolean', 'grant', '作る範囲を確認してください', 400);
        if (c.build) { i.intent = 'build'; i.grant = this.grant(i, b.opId); if (i.status !== 'implemented') i.status = 'queued'; }
        else {
          U.check(canUnbuild(d, i), 'already-started', '実行終了後に削除できます');
          i.intent = 'record'; i.grant = null; i.status = 'note';
        }
      }
      if ('priority' in c) { U.check(['normal', 'urgent'].includes(c.priority), 'priority', '優先度を確認してください', 400); i.priority = c.priority; }
      if ('dependencies' in c) { i.dependencies = this.dependencies(d, i.id, c.dependencies, 'human'); i.contentRev++; i.grant = null; if (i.intent === 'build') i.status = 'blocked'; }
      if('manualEvidence' in c){const e=c.manualEvidence;U.check(e&&/^[a-f0-9]{40}$/.test(e.head)&&typeof e.answer==='string'&&e.answer.trim()&&Array.isArray(e.checks)&&e.checks.length&&i.acceptance.some(a=>a.id===e.acceptanceId&&a.verification==='manual'),'manual-evidence','確認する条件・対象・結果を入力してください');i.manualEvidence||=[];i.manualEvidence.push({...e,id:U.uuid(),contentRev:i.contentRev,by:'human-ui',opId:b.opId});if(i.failure?.cause?.includes('人による確認')){i.checkpoint={nextPurpose:'reconcile',runId:i.failure.runId};i.failure=null;i.status='queued';}}
      if ('answer' in c) {
        const a = c.answer, q = i.questions.find(q => q.id === a?.id);
        U.check(q && q.rev === a.rev && q.contentRev === i.contentRev && q.answer === undefined, 'question-revision', 'この質問は更新されています');
        U.check(typeof a.value === 'string' && a.value.trim() && Buffer.byteLength(a.value) <= 65536, 'answer', '回答を入力してください', 400);
        const granted = i.intent === 'build' && i.grant?.contentRev === i.contentRev; q.answer = a.value; q.resolvedByOp = b.opId; i.contentRev++; for (const x of i.questions) if (x.answer === undefined) x.contentRev = i.contentRev;
        i.grant = granted ? this.grant(i, b.opId) : null; i.status = granted ? 'queued' : 'note'; i.planRev++; i.implementation = null;
      }
      if(['text','dependencies','answer'].some(k=>k in c)){i.acceptance=[];i.failure=null;i.checkpoint=null;i.implementation=null;i.organizationRequested=true;if('text' in c){i.questions=[];i.dependencies=i.dependencies.filter(x=>x.origin==='human');if(i.grant)i.grant=this.grant(i,b.opId);}}
      i.revisionHistory.push({ at: nowISO(this.clock), opId: b.opId, previous: { ...old, revisionHistory: undefined } }); i.controlRev++; i.rev++;
      if (!('category' in c)) this.stale(d, 'item changed'); return { id: i.id, item: U.clone(i) };
    });
  }
  dependencies(d, itemId, proposed, origin = 'derived') {
    U.check(Array.isArray(proposed), 'dependencies', '依存する項目を確認してください', 400);
    const deps = proposed.map(x => { U.check(x && d.items[x.ideaId] && x.ideaId !== itemId && x.contentRev === d.items[x.ideaId].contentRev && x.requires === 'implemented', 'dependency', '依存する項目や版を確認してください'); if (origin === 'derived') U.check(Array.isArray(x.refs) && x.refs.length, 'dependency-proof', '技術上の依存には根拠が必要です'); return { ideaId: x.ideaId, contentRev: x.contentRev, requires: 'implemented', origin, refs: x.refs || [] }; });
    const visit = (id, seen) => { U.check(!seen.has(id), 'dependency-cycle', '依存が循環しています'); const n = new Set(seen).add(id); for (const dep of id === itemId ? deps : d.items[id].dependencies) visit(dep.ideaId, n); }; visit(itemId, new Set()); return deps;
  }
  stale(d, reason) { for (const r of Object.values(d.releases)) if (['ready', 'preparing', 'reviewing'].includes(r.state)) { r.state = 'stale'; r.rev++; r.staleReason = reason; } }
  settings(id, b, apply) { return this.mutate(id, b.opId, b, d => { U.check(d.settings.rev === b.settingsRev, 'settings-revision', '設定が更新されました。表示を読み直してください'); apply(d); d.settings.rev++; return { settings: U.clone(d.settings) }; }); }
  // Stopping must work in the free core too; enabling automation stays paid.
  pauseAuto(id, b) { return this.settings(id, b, d => {
    d.settings.auto.enabled = false; d.settings.manualPaused = true;
    d.settings.auto.generation++; d.settings.stopGeneration++;
  }); }
  internal(id, op, payload, apply) { return this.mutate(id, op, { internal: true, ...payload }, apply); }
  uploadImage(id,b,bytes) { return images.upload(this,id,b,bytes); }
  image(id,key,preview=false) { U.opId(key); const d=this.read(id), image=d.images?.[key]; U.check(image && image.projectUid===d.projectUid,'image-owner','この台帳の画像が見つかりません',404); return images.verify(this.resolve(id),image,preview); }
  imageReferences(id,item) { return images.references(this,id,item); }
  backup(id,b){return require('./idea-lifecycle').backup(this,id,b);}
  relocate(id,b){return require('./idea-lifecycle').relocate(this,id,b);}
  erase(id,b){return require('./idea-erase').erase(this,id,b);}
  eraseAvailability(id,itemId){return require('./idea-erase').availability(this,id,itemId);}
  reorder(id,b) {
    const positioned = Object.hasOwn(b, 'toIndex');
    U.check(positioned ? Number.isSafeInteger(b.toIndex) && b.direction === undefined : ['up','down'].includes(b.direction), 'order-direction', '移動する位置を確認してください', 400);
    return this.mutate(id,b.opId,{kind:'reorder',...b},d=>{
      const ids=order.normalize(d); U.check(d.orderRev===b.baseOrderRev,'order-revision','並び順が更新されました。表示を読み直してください');
      const from=ids.indexOf(b.id),to=positioned?b.toIndex:from+(b.direction==='up'?-1:1); U.check(from>=0,'item','項目が見つかりません',404); U.check(to>=0&&to<ids.length,'order-edge','一覧の端です');
      if(from!==to){ids.splice(from,1);ids.splice(to,0,b.id);d.orderRev++;} return {id:b.id,index:to,orderRev:d.orderRev};
    });
  }
  view(id, offset = 0, limit = 100, selectedCategory = '') {
    if (selectedCategory) selectedCategory = category(selectedCategory);
    const d = this.read(id), s = this.resolve(id);
    const all = order.normalize(d).map(key=>d.items[key]);
    const filtered = selectedCategory ? all.filter(i => itemCategory(i) === selectedCategory) : all;
    const categories = Object.fromEntries(CATEGORIES.map(c => [c, all.filter(i => itemCategory(i) === c).length]));
    return { schema: d.schema, project: id, projectUid: d.projectUid, rev: d.rev, orderRev: d.orderRev, itemOrder: d.itemOrder, waitingId: all.find(i => i.status === 'waiting')?.id || null, erased: d.erased || {}, imageIds: Object.keys(d.images || {}), settings: d.settings, observed: d.observed, counts: { all: all.length, waiting: all.filter(i => i.status === 'waiting').length, categories }, items: filtered.slice(offset, offset + limit).map(i => ({ ...i, category: itemCategory(i), canUnbuild: canUnbuild(d, i) })), total: filtered.length, offset, releases: Object.values(d.releases), projection: { ...d.projection, needsImport: Boolean(s && U.strictRead(s.md, this.io) !== null && !d.projection?.hash) } };
  }
}
module.exports = { Ideas, initial, validate };
