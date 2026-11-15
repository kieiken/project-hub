'use strict';
// Queue -> ledger is a durable two-phase transfer. The ledger owns both the
// receipt and the launch fence; no process-local lock is an acknowledgement.
const fs = require('node:fs'), path = require('node:path');
const U = require('./idea-utils'), IM = require('./idea-images'), start = require('./start');
const { noLinks } = require('./remove');
const keyOf = (task, id) => U.hash([task, id]);
const content = q => Object.fromEntries(Object.entries(q).filter(([k]) => !['error', 'stopHeld', 'limitWaiting'].includes(k)));
const version = q => U.hash(content(q));
function eligible(q) {
  return q && typeof q.text === 'string' && !['automation', 'readOnly', 'selectionOnly', 'limitSwitch', 'resultsOrganize', 'isolatedReview', 'integrationReviewRequest', 'integrationAssignment', 'resultsRecoveryHash', 'discussionTurn', 'reviewKind', 'limitPolicy'].some(k => q[k]) &&
    !/^(?:limit-|idea-|discussion-|role-review-|integration-)/.test(q.id) && !/\[(?:integration-auto|idea-run):/.test(q.text) && (!q.origin || q.origin === 'delegate');
}
function records(d) {
  const entries = d.queueRetreats || {};
  U.check(entries && typeof entries === 'object' && !Array.isArray(entries), 'queue-retreat', '退避記録の照合が必要です', 503);
  for (const [key, r] of Object.entries(entries)) U.check(r && key === keyOf(r.task, r.queueId) && ['prepared', 'saved', 'complete'].includes(r.state) && typeof r.version === 'string' && r.opId && r.itemId, 'queue-retreat', '退避記録の照合が必要です', 503);
  return entries;
}
class QueueRetreat {
  constructor({ ideas, chats, actions = new Set(), related = () => false, fault = () => {} }) { Object.assign(this, { ideas, chats, actions, related, fault }); }
  record(project, task, id, recover = false) { return records(this.ideas.read(project, { recover }))[keyOf(task, id)]; }
  guard({ project, task, id, action, before, after, authorization }) {
    if (!id || project === 'freetalk') return;
    const r = this.record(project, task, id, true);
    if (!r) return;
    if (action === 'change' && before && after && version(before) === version(after)) return; // stop/error decoration only
    if (action === 'change' && !after && authorization === r.opId && ['saved', 'complete'].includes(r.state)) return;
    throw U.fail('queue-retreat', 'この指示は台帳への退避中、または退避済みです。［退避を確認］で保存結果を確認してください');
  }
  scope(b) {
    const p = this.ideas.project(b.project);
    U.check(typeof b.task === 'string' && /^[\w-]+$/.test(b.task) && p.tasks.some(t => t.id === b.task) && typeof b.id === 'string' && b.id.length > 0, 'queue-task', '元の作業を確認してください', 404);
    U.opId(b.opId); return p;
  }
  assertIdle(p, task, q) {
    const refs = new Set([q.id, q.request].filter(Boolean)), run = this.chats.busy(p.id, task);
    U.check(!this.actions.has(this.chats.key(p.id, task)) && !(run && [run.request, run.options?.request, run.userRow?.request, run.userRow?.turn].some(x => refs.has(x))), 'queue-starting', 'この指示は起動中です。退避せず待ち列に残します');
    const rows = require('./chat').read(p.dir, task);
    U.check(!rows.some(r => r.role === 'user' && [r.request, r.turn].some(x => refs.has(x))), 'queue-started', 'すでに開始した指示は退避できません');
    const root = this.chats.spoolRoot;
    if (root && fs.existsSync(root)) for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, 'request.json');
      if (!fs.existsSync(file)) continue;
      const o = JSON.parse(fs.readFileSync(file, 'utf8')).options;
      U.check(!(o?.project === p.id && o.task === task && refs.has(o.request)), 'queue-started', 'この指示には実行記録があります。待ち列に残します');
    }
  }
  attachments(p, q) {
    const ids = new Set(), views = new Set();
    // Only canonical reference blocks are interpreted. Arbitrary prose paths
    // are retained as text and are never opened.
    for (const text of [q.text, q.shown].filter(x => typeof x === 'string')) {
      U.check(!text.includes('\n\n参照ファイル・画像（絶対パス）：\n'), 'queue-images', '画像以外の添付はまだ退避できません。待ち列に残します');
      const parts = text.split('\n\n参照画像（絶対パス）：\n');
      for (const block of parts.slice(1)) {
        const lines = block.split('\n'), paths = [];
        while (lines.length && lines[0].startsWith('/')) paths.push(lines.shift());
        U.check(paths.length > 0, 'queue-images', '添付画像の参照を照合できません');
        for (const raw of paths) {
          const name = path.basename(raw), id = name.replace(/\.(?:gif|webp|heic)\.png$/i, m => m.slice(0, -4));
          const original = start.imageFile(p, id), view = start.imageFile(p, id, true);
          U.check(raw === view, 'queue-images', '別の場所の画像は退避できません。待ち列に残します');
          ids.add(id); views.add(raw);
        }
      }
    }
    U.check(!q.images || Array.isArray(q.images) && q.images.every(file => views.has(file)), 'queue-images', '旧添付情報の所属を照合できません。待ち列に残します');
    if (q.projectImages !== undefined) {
      U.check(Array.isArray(q.projectImages), 'queue-images', '添付画像の情報を確認してください');
      const declared = new Set(q.projectImages);
      for (const id of declared) { U.check(typeof id === 'string', 'queue-images', '添付画像の情報を確認してください'); start.imageFile(p, id); }
      U.check(views.size === declared.size && [...declared].every(id => views.has(start.imageFile(p, id, true))), 'queue-images', '画像情報と本文の参照が一致しません。待ち列に残します');
    }
    U.check(ids.size <= IM.COUNT, 'image-count', '画像は10枚までです。待ち列に残します', 413);
    const out = [...ids].map(id => {
      const file = start.imageFile(p, id), view = start.imageFile(p, id, true);
      noLinks(view); U.check(fs.existsSync(view), 'queue-images', '添付画像が見つかりません。待ち列に残します');
      const bytes = IM.safeRead(file); IM.format(bytes, id);
      return { id, name: id, hash: U.hash(bytes), bytes: bytes.length, opId: U.uuid() };
    });
    U.check(out.reduce((n, i) => n + i.bytes, 0) <= IM.TOTAL, 'image-total', '画像は合計50MBまでです。待ち列に残します', 413);
    return out;
  }
  uploadImages(p, images) {
    return images.map(i => {
      const bytes = IM.safeRead(start.imageFile(p, i.id)); U.check(U.hash(bytes) === i.hash, 'queue-images', '元画像が変わっています。待ち列に残します');
      return this.ideas.uploadImage(p.id, { opId: i.opId, name: i.name }, bytes).image.id;
    });
  }
  transfer(b) {
    const p = this.scope(b), key = keyOf(b.task, b.id), inputHash = U.hash({ project: b.project, task: b.task, id: b.id, expected: b.expected });
    let r = this.record(p.id, b.task, b.id, true);
    if (r) U.check(r.opId === b.opId && r.inputHash === inputHash, 'op-conflict', '退避操作の内容が変わっています。元の操作で結果を確認してください');
    else {
      const q = this.chats.queue(p.id, b.task).find(x => x.id === b.id);
      U.check(q, 'queue-missing', 'その指示はもう待っていません', 404);
      U.check(eligible(q) && !this.related(p.id, b.task, q), 'queue-managed', '管理用の待ち指示は台帳へ退避できません');
      U.check(b.expected && version(q) === (typeof b.expected === 'string' ? b.expected : version(b.expected)), 'queue-changed', '待ち指示が変更されています。最新の内容を確認してください');
      this.assertIdle(p, b.task, q);
      U.check(Buffer.byteLength(q.text) <= 8 * 1024 * 1024 && (q.shown === undefined || typeof q.shown === 'string' && Buffer.byteLength(q.shown) <= 8 * 1024 * 1024), 'text-size', '原文全体を保存できる容量を超えています', 413);
      const images = this.attachments(p, q);
      // Decode and durably accept EVERY image before fencing the directive.
      // A rejected image leaves no retreat/item receipt; the original stays editable.
      // Resume reuses these image opIds, so accepted images are not decoded twice.
      this.uploadImages(p, images);
      r = { state: 'prepared', opId: b.opId, inputHash, task: b.task, queueId: b.id, version: version(q), snapshot: U.clone(q), images, itemId: U.uuid(), finishOp: U.uuid(), at: new Date().toISOString() };
      this.ideas.internal(p.id, U.uuid(), { kind: 'queue-retreat-prepare', id: r.itemId }, d => { (d.queueRetreats ||= {})[key] = r; return { id: r.itemId }; });
      this.fault('prepared', r);
    }
    return this.resume(p, key, r);
  }
  resume(p, key, r) {
    if (r.state === 'complete') return this.result(p.id, r);
    let current = this.chats.queue(p.id, r.task).find(q => q.id === r.queueId);
    U.check(!current || version(current) === r.version, 'queue-changed', '待ち指示が変わっています。元の指示は外していません');
    this.assertIdle(p, r.task, r.snapshot);
    if (r.state === 'prepared') {
      U.check(current, 'queue-missing', '退避前の待ち指示を照合できません');
      const images = this.uploadImages(p, r.images);
      this.fault('before-save', r);
      this.ideas.mutate(p.id, r.opId, { kind: 'queue-retreat', inputHash: r.inputHash }, d => {
        const record = records(d)[key]; U.check(record?.state === 'prepared', 'queue-retreat', '退避記録が変わっています');
        const source = { capture: 'verified', kind: 'queue', task: r.task, project: p.id, queueId: r.queueId, hash: r.version, at: r.at, snapshots: [], queue: r.snapshot, boundary: '未実行の待ち指示。担当・モデル等は参照情報であり実行許可ではない' };
        const item = this.ideas.newItem(d, r.snapshot.text, 'record', source, r.opId, IM.select(this.ideas, p.id, d, images), r.itemId);
        item.organizationRequested = false; // Parking never schedules an AI request.
        record.state = 'saved'; return { id: item.id, queueId: r.queueId, intent: 'record' };
      });
      r = this.record(p.id, r.task, r.queueId, true);
    }
    const receipt = this.ideas.receipt(p.id, r.opId);
    U.check(receipt.saved === true && receipt.id === r.itemId && !receipt.removed, 'queue-receipt', '保存結果を照合中です。待ち指示は実行しません', 503);
    this.fault('saved', r);
    current = this.chats.queue(p.id, r.task).find(q => q.id === r.queueId);
    U.check(!current || version(current) === r.version, 'queue-changed', '待ち指示が変わっています。元の指示は外していません');
    if (current) this.chats.setQueue(p.id, r.task, this.chats.queue(p.id, r.task).filter(q => q.id !== r.queueId), true, r.opId);
    this.fault('removed', r);
    this.ideas.internal(p.id, r.finishOp, { kind: 'queue-retreat-complete', id: r.itemId }, d => {
      const record = records(d)[key]; record.state = 'complete'; delete record.snapshot; delete record.images; return { id: r.itemId };
    });
    return this.result(p.id, this.record(p.id, r.task, r.queueId));
  }
  result(project, r) { const receipt = this.ideas.receipt(project, r.opId); return { ok: true, saved: receipt.saved, complete: r.state === 'complete', id: r.itemId, removed: Boolean(receipt.removed), opId: r.opId, receipt: receipt.receipt }; }
  receipt(b) { this.scope(b); const r = this.record(b.project, b.task, b.id, true); if (!r) return { saved: false, complete: false, state: 'absent' }; U.check(r.opId === b.opId, 'op-conflict', '元の退避操作で照合してください'); return this.result(b.project, r); }
  restore() {
    const errors = [];
    for (const p of this.ideas.store.listProjects().filter(p => p.kind !== 'freetalk' && p.id !== 'freetalk')) {
      try { for (const [key, r] of Object.entries(records(this.ideas.read(p.id, { recover: true })))) if (r.state !== 'complete') {
        try { this.resume(p, key, r); } catch (e) { errors.push({ project: p.id, task: r.task, id: r.queueId, error: e.message }); }
      } } catch (e) { errors.push({ project: p.id, error: e.message }); }
    }
    return errors; // A failed scope keeps its fence; unrelated startup proceeds.
  }
}
module.exports = { QueueRetreat, eligible, version, records };
