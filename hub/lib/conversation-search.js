'use strict';
const path = require('node:path'), { Worker } = require('node:worker_threads'), { randomUUID } = require('node:crypto');
class ConversationSearch {
  constructor(root) { this.root = root; this.jobs = new Map(); this.contexts = new Set(); this.idleWorkers = new Set(); this.closed = false; }
  clean() { for (const [id, j] of this.jobs) if (Date.now() - j.at > 10 * 60000) { j.worker?.terminate(); this.jobs.delete(id); } }
  start(query, mode = 'simple') {
    if(this.closed)throw Error('検索は終了しています。');
    this.clean();
    if (!['simple', 'detailed'].includes(mode)) throw Error('検索範囲を選び直してください。');
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || query.trim().split(/\s+/).length > 8) throw Error('200字・8語以内の検索語を入力してください。');
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 2) throw Error('ほかの検索が実行中です。終了後に検索してください。');
    while (this.jobs.size >= 8) { const id = this.jobs.keys().next().value; this.cancel(id); }
    const id = randomUUID(), j = { at: Date.now(), mode, status: 'running', hits: [], stats: {}, found: 0 };
    const worker = this.idleWorkers.values().next().value || new Worker(path.join(__dirname, 'conversation-search-worker.js'), { workerData: { persistent: true }, resourceLimits: { maxOldGenerationSizeMb: 128 } }); this.idleWorkers.delete(worker); if(worker.idleExit){worker.off('exit',worker.idleExit);worker.off('error',worker.idleError);} worker.ref(); j.worker = worker; this.jobs.set(id, j);
    const timer = setTimeout(() => { j.status = 'failed'; worker.terminate(); }, 120000); timer.unref(); worker.unref();
    const release=()=>{clearTimeout(timer);worker.off('message',message);worker.off('error',error);worker.off('exit',exit);j.worker=null;};
    const message=m=>{
      if(this.closed||!this.jobs.has(id)){release();worker.terminate();return;}
      if(m.type==='progress'){Object.assign(j,{stats:m.stats,found:m.found});return;}
      if(m.type==='done')Object.assign(j,m.result,{status:'done'});else j.status='failed';
      release();
      // At most two workers exist per owner (the unchanged concurrency limit).
      if(m.type==='done'){this.idleWorkers.add(worker);worker.unref();worker.idleExit=()=>this.idleWorkers.delete(worker);worker.idleError=()=>{this.idleWorkers.delete(worker);worker.terminate();};worker.once('exit',worker.idleExit);worker.once('error',worker.idleError);}else worker.terminate();
    };
    const error=()=>{j.status='failed';};
    const exit=()=>{release();if(j.status==='running')j.status='failed';};
    worker.on('message',message);worker.on('error',error);worker.once('exit',exit);
    worker.postMessage({root:this.root,query,mode});
    return { id, mode };
  }
  get(id, offset = 0) {
    this.clean(); const j = this.jobs.get(id); if (!j) throw Error('検索の保存期限が切れました。もう一度検索してください。');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000 || offset % 50) throw Error('検索の続きの位置が不正です。');
    const hits = j.status === 'done' ? j.hits.slice(offset, offset + 50).map((h, n) => { const { rowHash, signature, key, ...shown } = h; return { ...shown, id: offset + n }; }) : [];
    return { mode: j.mode, status: j.status, stats: j.stats, total: j.status === 'done' ? j.hits.length : j.found, hits, next: offset + hits.length < j.hits.length ? offset + hits.length : null };
  }
  cancel(id) { const j = this.jobs.get(id); if (j) { j.worker?.terminate(); this.jobs.delete(id); } return { ok: true }; }
  async context(id, index) {
    this.clean(); const j = this.jobs.get(id), hit = j?.status === 'done' && j.hits[index]; if (!Number.isSafeInteger(index) || !hit) throw Error('検索結果を選び直してください。');
    if (j.contextBusy || this.contexts.size >= 2) throw Error('発言を読み込み中です。'); j.contextBusy = true;
    try { return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'conversation-search-worker.js'), { workerData: { root: this.root, hit, mode: j.mode, action: 'context' }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      this.contexts.add(worker);
      const fail = () => reject(Error('会話が変更されたか、安全に読み出せません。もう一度検索してください。'));
      const timer = setTimeout(() => { worker.terminate(); fail(); }, 30000); timer.unref();
      worker.once('message', m => { clearTimeout(timer); if (m.type === 'done') resolve(m.result); else fail(); });
      worker.once('error', () => { clearTimeout(timer); fail(); }); worker.once('exit', () => { this.contexts.delete(worker); clearTimeout(timer); fail(); });
    }); } finally { j.contextBusy = false; }
  }
  close() { this.closed=true;for (const id of this.jobs.keys()) this.cancel(id); for (const worker of this.contexts) worker.terminate(); for(const worker of this.idleWorkers)worker.terminate();this.idleWorkers.clear(); }
}
module.exports = { ConversationSearch };
